package vcs

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"

	"spaghettimapper/internal/volume"
)

// Version history (undo / redo / restore + read-only preview).
//
// The "line" an undo/redo acts on is the line the caller *writes* to:
//   - solo / anonymous (-no-auth, no signed-in user) → refs/heads/main
//   - a signed-in architect → refs/heads/architects/<id>
// Main is append-only in multi-user mode (it only advances via combines), so
// undo never rewrites shared history; it only walks the caller's own line.
//
// A rewound commit is kept reachable via a redo ref (refs/sm/redo/<line>) so
// redo survives a restart and the timeline can show the "redo future". The
// redo invariant (valid because the undoable lines are linear — branches have
// no merge commits, solo main has no merges): the redo ref tip is the HEAD as
// it was before the *first* undo, and its first-parent chain walks the undone
// commits newest→oldest down to the current line HEAD.

const redoPrefix = "refs/sm/redo/"

// lineRefFor returns the ref of the line a caller writes to.
func lineRefFor(archID string) plumbing.ReferenceName {
	if archID == "" {
		return mainRef
	}
	return ArchitectBranchRef(archID)
}

// redoRefFor returns the redo ref for a line (archID "" = main).
func redoRefFor(archID string) plumbing.ReferenceName {
	if archID == "" {
		return plumbing.ReferenceName(redoPrefix + "main")
	}
	return plumbing.ReferenceName(redoPrefix + "architects/" + archID)
}

// archIDFromRef derives the architect id from a branch ref ("" for main).
func archIDFromRef(ref plumbing.ReferenceName) string {
	s := ref.String()
	if len(s) > len(architectPrefix) && s[:len(architectPrefix)] == architectPrefix {
		return s[len(architectPrefix):]
	}
	return ""
}

// HistoryEntry is one step in the timeline.
type HistoryEntry struct {
	Hash    string    `json:"sha"`
	Short   string    `json:"short"`
	Message string    `json:"message"`
	Author  string    `json:"author"`
	When    time.Time `json:"when"`
	Future  bool      `json:"future"`  // in the redo chain (above current)
	Current bool      `json:"current"` // the line HEAD
}

// HistoryResult is the timeline + undo/redo availability for a line.
type HistoryResult struct {
	Entries []HistoryEntry `json:"entries"`
	CanUndo bool            `json:"can_undo"`
	CanRedo bool            `json:"can_redo"`
	Head    string          `json:"head"`
}

// History returns the timeline for the caller's line. The line HEAD sits in
// the middle: redo-future entries (newest first) above it, past entries
// (newest first) below it. The HEAD entry is marked Current.
func (m *Manager) History(proj, archID string) (HistoryResult, error) {
	repo, err := m.repoForProject(proj)
	if err != nil {
		return HistoryResult{}, err
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	return repo.historyLocked(archID)
}

func (repo *Repo) historyLocked(archID string) (HistoryResult, error) {
	res := HistoryResult{}
	head, err := repo.lineHashLocked(archID)
	if err != nil || head.IsZero() {
		return res, nil // no commits yet
	}
	// Past: first-parent walk from HEAD (newest first). past[0] is current.
	past := []HistoryEntry{}
	h := head
	for !h.IsZero() {
		c, err := repo.r.CommitObject(h)
		if err != nil {
			break
		}
		past = append(past, historyEntry(c, false))
		if len(c.ParentHashes) == 0 {
			break
		}
		h = c.ParentHashes[0]
	}
	if len(past) > 0 {
		past[0].Current = true
	}
	// Future: the redo chain, newest (redo tip) first, down to (excluding) HEAD.
	future := []HistoryEntry{}
	if rr, err := repo.r.Reference(redoRefFor(archID), true); err == nil {
		h = rr.Hash()
		for !h.IsZero() {
			c, err := repo.r.CommitObject(h)
			if err != nil {
				break
			}
			if h == head {
				break // reached the current line
			}
			future = append(future, historyEntry(c, true))
			if len(c.ParentHashes) == 0 {
				break
			}
			h = c.ParentHashes[0]
		}
	}
	res.Entries = append(future, past...)
	res.CanUndo = len(past) > 1        // current has a parent
	res.CanRedo = len(future) > 0
	res.Head = head.String()[:7]
	return res, nil
}

func historyEntry(c *object.Commit, future bool) HistoryEntry {
	return HistoryEntry{
		Hash:    c.Hash.String(),
		Short:   c.Hash.String()[:7],
		Message: firstLine(c.Message),
		Author:  c.Author.Name,
		When:   c.Committer.When,
		Future:  future,
	}
}

// lineHashLocked resolves the line's current commit hash (ZeroHash if the line
// has no commits). The caller holds repo.mu.
func (repo *Repo) lineHashLocked(archID string) (plumbing.Hash, error) {
	r, err := repo.r.Reference(lineRefFor(archID), true)
	if err != nil {
		return plumbing.ZeroHash, err
	}
	return r.Hash(), nil
}

// moveLineLocked advances/rewinds the line ref to target. For main it also
// hard-resets the working tree so disk reads reflect the new state. The
// caller holds repo.mu.
func (repo *Repo) moveLineLocked(archID string, target plumbing.Hash) error {
	if err := repo.r.Storer.SetReference(plumbing.NewHashReference(lineRefFor(archID), target)); err != nil {
		return err
	}
	if archID == "" {
		wt, err := repo.r.Worktree()
		if err != nil {
			return err
		}
		return wt.Reset(&git.ResetOptions{Mode: git.HardReset, Commit: target})
	}
	return nil
}

// clearRedoLocked drops the redo future for a line. A new edit after an undo
// must discard the redo future (classic undo semantics). The caller holds
// repo.mu. Missing redo refs are a no-op.
func (repo *Repo) clearRedoLocked(archID string) {
	_ = repo.r.Storer.RemoveReference(redoRefFor(archID))
}

// Undo rewinds the line by one commit, pushing the old HEAD onto the redo
// future. No-op (returns the current state) if the line is at its initial
// commit.
func (m *Manager) Undo(proj, archID string) (HistoryResult, error) {
	if archID != "" {
		lk := m.branchLock(proj, archID)
		lk.Lock()
		defer lk.Unlock()
	}
	repo, err := m.repoForProject(proj)
	if err != nil {
		return HistoryResult{}, err
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()

	head, err := repo.lineHashLocked(archID)
	if err != nil || head.IsZero() {
		return repo.historyLocked(archID)
	}
	c, err := repo.r.CommitObject(head)
	if err != nil || len(c.ParentHashes) == 0 {
		return repo.historyLocked(archID) // nothing to undo
	}
	parent := c.ParentHashes[0]
	redoRef := redoRefFor(archID)
	if _, err := repo.r.Reference(redoRef, true); err != nil {
		// Redo future empty: seed it with the old HEAD. On subsequent undos the
		// tip stays (the chain naturally extends toward the new HEAD).
		if err := repo.r.Storer.SetReference(plumbing.NewHashReference(redoRef, head)); err != nil {
			return HistoryResult{}, err
		}
	}
	if err := repo.moveLineLocked(archID, parent); err != nil {
		return HistoryResult{}, err
	}
	return repo.historyLocked(archID)
}

// Redo re-applies the newest undone commit (the bottom of the redo chain).
// No-op if there is no redo future. When the last undone commit is redone the
// redo ref is deleted.
func (m *Manager) Redo(proj, archID string) (HistoryResult, error) {
	if archID != "" {
		lk := m.branchLock(proj, archID)
		lk.Lock()
		defer lk.Unlock()
	}
	repo, err := m.repoForProject(proj)
	if err != nil {
		return HistoryResult{}, err
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()

	head, err := repo.lineHashLocked(archID)
	if err != nil || head.IsZero() {
		return repo.historyLocked(archID)
	}
	rr, err := repo.r.Reference(redoRefFor(archID), true)
	if err != nil {
		return repo.historyLocked(archID) // no redo future
	}
	// Find the commit in the redo chain whose parent is the current HEAD —
	// that is the next thing to redo (the bottom of the undone stack).
	var x plumbing.Hash
	h := rr.Hash()
	for !h.IsZero() {
		c, err := repo.r.CommitObject(h)
		if err != nil {
			break
		}
		if h == head {
			break
		}
		if len(c.ParentHashes) > 0 && c.ParentHashes[0] == head {
			x = h
			break
		}
		if len(c.ParentHashes) == 0 {
			break
		}
		h = c.ParentHashes[0]
	}
	if x.IsZero() {
		return repo.historyLocked(archID) // redo chain doesn't connect to HEAD
	}
	if err := repo.moveLineLocked(archID, x); err != nil {
		return HistoryResult{}, err
	}
	if x == rr.Hash() {
		_ = repo.r.Storer.RemoveReference(redoRefFor(archID))
	}
	return repo.historyLocked(archID)
}

// RestoreTo jumps the line to sha. Commits skipped into the past become the
// redo future; commits skipped out of the redo future shrink it. Used by the
// History drawer's "Restore this version".
func (m *Manager) RestoreTo(proj, archID string, sha plumbing.Hash) (HistoryResult, error) {
	if archID != "" {
		lk := m.branchLock(proj, archID)
		lk.Lock()
		defer lk.Unlock()
	}
	repo, err := m.repoForProject(proj)
	if err != nil {
		return HistoryResult{}, err
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()

	head, _ := repo.lineHashLocked(archID)
	if sha == head {
		return repo.historyLocked(archID)
	}
	if _, err := repo.r.CommitObject(sha); err != nil {
		return HistoryResult{}, fmt.Errorf("version not found: %w", err)
	}
	redoRef := redoRefFor(archID)
	switch {
	case !head.IsZero() && isAncestor(repo.r, sha, head):
		// sha is in the past: the skipped commits (head..sha] become the redo
		// future, with the old HEAD as the redo tip.
		if err := repo.r.Storer.SetReference(plumbing.NewHashReference(redoRef, head)); err != nil {
			return HistoryResult{}, err
		}
	default:
		rr, rerr := repo.r.Reference(redoRef, true)
		if rerr != nil || !isAncestor(repo.r, head, sha) || !isAncestor(repo.r, sha, rr.Hash()) {
			return HistoryResult{}, fmt.Errorf("version is not on the current line")
		}
		// sha is in the redo future: drop the redone commits from the future.
		if sha == rr.Hash() {
			_ = repo.r.Storer.RemoveReference(redoRef)
		} else {
			var x plumbing.Hash
			h := rr.Hash()
			for !h.IsZero() {
				c, err := repo.r.CommitObject(h)
				if err != nil {
					break
				}
				if len(c.ParentHashes) > 0 && c.ParentHashes[0] == sha {
					x = h
					break
				}
				if len(c.ParentHashes) == 0 {
					break
				}
				h = c.ParentHashes[0]
			}
			if x.IsZero() {
				_ = repo.r.Storer.RemoveReference(redoRef)
			} else {
				_ = repo.r.Storer.SetReference(plumbing.NewHashReference(redoRef, x))
			}
		}
	}
	if err := repo.moveLineLocked(archID, sha); err != nil {
		return HistoryResult{}, err
	}
	return repo.historyLocked(archID)
}

// isAncestor reports whether a is reachable from b (a is an ancestor of b).
func isAncestor(r *git.Repository, a, b plumbing.Hash) bool {
	return reachable(r, b)[a]
}

// ---- read-only preview volume ----

// CommitVolume is a read-only volume over a specific commit's tree, used to
// preview a past (or redo-future) version on the canvas without touching the
// live line. store.GetGraph works with it unchanged.
type CommitVolume struct {
	repo *Repo
	tree *object.Tree
}

// NewCommitVolume opens a read-only volume over the commit sha. Returns an
// error if the project or commit doesn't exist.
func (m *Manager) NewCommitVolume(proj string, sha plumbing.Hash) (*CommitVolume, error) {
	repo, err := m.repoForProject(proj)
	if err != nil {
		return nil, err
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	c, err := repo.r.CommitObject(sha)
	if err != nil {
		return nil, fmt.Errorf("version not found: %w", err)
	}
	t, err := c.Tree()
	if err != nil {
		return nil, err
	}
	return &CommitVolume{repo: repo, tree: t}, nil
}

func (v *CommitVolume) Read(name string) ([]byte, error) {
	f, err := v.tree.File(name)
	if err != nil {
		// Missing files read as zero-value, matching the other volumes.
		return nil, os.ErrNotExist
	}
	s, err := f.Contents()
	return []byte(s), err
}

func (v *CommitVolume) Exists(name string) bool {
	_, err := v.tree.File(name)
	return err == nil
}

func (v *CommitVolume) Write(name string, data []byte) error { return errors.New("preview is read-only") }

func (v *CommitVolume) Commit(architectID, architectName, msg string) error { return nil }

func (v *CommitVolume) CanTrash() bool { return false }

// IsBranch is true so store reads/writes skip the global mu (the preview is
// immutable and holds no shared on-disk state).
func (v *CommitVolume) IsBranch() bool { return true }

func (v *CommitVolume) Release() {}

var _ volume.Volume = (*CommitVolume)(nil)