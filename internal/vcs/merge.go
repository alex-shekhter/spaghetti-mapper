package vcs

import (
	"errors"
	"fmt"
	"io"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"

	"spaghettimapper/internal/merge"
	"spaghettimapper/internal/store"
)

// MergeOutcome is the result of MergeArchitect.
type MergeOutcome struct {
	FastForwarded bool             `json:"fast_forwarded"`
	Nothing       bool             `json:"nothing"`        // branch already contained in main
	Merged        bool             `json:"merged"`         // main now has the branch's work
	Conflicts     []merge.Conflict `json:"conflicts"`      // present when Merged is false (409)
	Soft          []merge.SoftNote `json:"soft,omitempty"` // non-blocking notes
}

// MergeArchitect merges an architect's branch into main.
//
//   - If main hasn't moved since the branch split off, fast-forward main to
//     the branch (no merge commit) and update the working tree.
//   - If the branch is already contained in main, just drop the branch.
//   - Otherwise run the domain 3-way merge. Unresolved hard conflicts are
//     returned (Merged=false) so the caller can surface them; once the caller
//     passes resolutions, the merged files are written to main, reconciled,
//     committed as a two-parent merge commit, and the branch is deleted.
//
// whoID/whoName is the architect performing the merge (the commit author).
func (m *Manager) MergeArchitect(proj, architectID, whoID, whoName string, resolutions map[string]string) (MergeOutcome, error) {
	repo, err := m.repoForProject(proj)
	if err != nil {
		return MergeOutcome{}, err
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()

	mainHash, err := repo.r.Head()
	if err != nil {
		return MergeOutcome{}, fmt.Errorf("main head: %w", err)
	}
	mainCommit := mainHash.Hash()
	branchRef, err := repo.r.Reference(ArchitectBranchRef(architectID), true)
	if err != nil {
		return MergeOutcome{}, fmt.Errorf("architect branch: %w", err)
	}
	branchCommit := branchRef.Hash()

	base, err := mergeBase(repo.r, mainCommit, branchCommit)
	if err != nil {
		return MergeOutcome{}, err
	}
	switch {
	case base == mainCommit:
		// main is the ancestor of the branch → fast-forward main to the branch.
		if err := repo.ffMainTo(branchCommit); err != nil {
			return MergeOutcome{}, err
		}
		_ = repo.r.Storer.RemoveReference(ArchitectBranchRef(architectID))
		repo.clearRedoLocked("")             // main advanced → drop main's redo future
		repo.clearRedoLocked(architectID)    // branch is gone
		return MergeOutcome{FastForwarded: true, Merged: true}, nil
	case base == branchCommit:
		// branch fully contained in main → nothing to merge; drop the branch.
		_ = repo.r.Storer.RemoveReference(ArchitectBranchRef(architectID))
		repo.clearRedoLocked(architectID) // branch is gone
		return MergeOutcome{Nothing: true, Merged: true}, nil
	}

	// True 3-way merge.
	names := []string{
		store.ProjectFile, store.SystemsFile, store.StreamsFile,
		store.NeedsFile, store.FlowsFile, store.LayoutFile, store.DisplayFile,
	}
	baseFiles, err := repo.readFilesAt(base, names)
	if err != nil {
		return MergeOutcome{}, err
	}
	oursFiles, err := repo.readFilesAt(mainCommit, names)
	if err != nil {
		return MergeOutcome{}, err
	}
	theirsFiles, err := repo.readFilesAt(branchCommit, names)
	if err != nil {
		return MergeOutcome{}, err
	}
	out, err := merge.Merge(baseFiles, oursFiles, theirsFiles, resolutions)
	if err != nil {
		return MergeOutcome{}, err
	}
	if len(out.Conflicts) > 0 {
		return MergeOutcome{Conflicts: out.Conflicts}, nil // 409 path
	}

	if err := repo.applyMergeToMain(proj, out.Files, mainCommit, branchCommit, whoID, whoName); err != nil {
		return MergeOutcome{}, err
	}
	_ = repo.r.Storer.RemoveReference(ArchitectBranchRef(architectID))
	repo.clearRedoLocked("")          // main advanced → drop main's redo future
	repo.clearRedoLocked(architectID) // branch is gone
	return MergeOutcome{Merged: true, Soft: out.Soft}, nil
}

// ffMainTo fast-forwards main to target and updates the on-disk working tree
// to match.
func (repo *Repo) ffMainTo(target plumbing.Hash) error {
	if err := repo.r.Storer.SetReference(plumbing.NewHashReference(mainRef, target)); err != nil {
		return err
	}
	wt, err := repo.r.Worktree()
	if err != nil {
		return err
	}
	return wt.Reset(&git.ResetOptions{Mode: git.HardReset, Commit: target})
}

// applyMergeToMain writes merged files to the working tree, reconciles
// cross-file references, and commits a two-parent merge commit on main.
func (repo *Repo) applyMergeToMain(proj string, files map[string][]byte, mainCommit, branchCommit plumbing.Hash, whoID, whoName string) error {
	// Write merged files to the working tree via a disk volume rooted at the
	// project dir (repo.dir).
	dv := NewDiskVolume(repo.dir, nil, proj)
	for name, data := range files {
		if err := dv.Write(name, data); err != nil {
			return fmt.Errorf("write %s: %w", name, err)
		}
	}
	// Repair references across the freshly-merged files.
	if err := store.Reconcile(dv); err != nil {
		return fmt.Errorf("reconcile: %w", err)
	}
	// Stage everything and commit a merge commit with both parents.
	wt, err := repo.r.Worktree()
	if err != nil {
		return err
	}
	if err := wt.AddWithOptions(&git.AddOptions{All: true}); err != nil {
		return fmt.Errorf("stage: %w", err)
	}
	sig := &object.Signature{Name: whoName, Email: whoID + "@spaghettimapper.local"}
	if _, err := wt.Commit("merge architect "+whoID, &git.CommitOptions{
		Parents: []plumbing.Hash{mainCommit, branchCommit},
		Author:  sig, Committer: sig,
	}); err != nil {
		return fmt.Errorf("merge commit: %w", err)
	}
	return nil
}

// readFilesAt returns the named files' bytes at a commit (missing files are
// omitted from the map).
func (repo *Repo) readFilesAt(commit plumbing.Hash, names []string) (map[string][]byte, error) {
	out := map[string][]byte{}
	if commit.IsZero() {
		return out, nil
	}
	c, err := repo.r.CommitObject(commit)
	if err != nil {
		return nil, err
	}
	tree, err := c.Tree()
	if err != nil {
		return nil, err
	}
	for _, n := range names {
		e, err := tree.FindEntry(n)
		if err != nil {
			continue
		}
		blob, err := repo.r.BlobObject(e.Hash)
		if err != nil {
			return nil, err
		}
		r, err := blob.Reader()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			return nil, err
		}
		out[n] = data
	}
	return out, nil
}

// mergeBase returns a common ancestor of a and b by walking the full ancestor
// graph. Good enough for our near-linear histories; not the tightest base.
func mergeBase(r *git.Repository, a, b plumbing.Hash) (plumbing.Hash, error) {
	aset := map[plumbing.Hash]bool{}
	stack := []plumbing.Hash{a}
	for len(stack) > 0 {
		h := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if aset[h] {
			continue
		}
		aset[h] = true
		c, err := r.CommitObject(h)
		if err != nil {
			continue
		}
		stack = append(stack, c.ParentHashes...)
	}
	stack = []plumbing.Hash{b}
	seen := map[plumbing.Hash]bool{}
	for len(stack) > 0 {
		h := stack[0]
		stack = stack[1:]
		if aset[h] {
			return h, nil
		}
		if seen[h] {
			continue
		}
		seen[h] = true
		c, err := r.CommitObject(h)
		if err != nil {
			continue
		}
		stack = append(stack, c.ParentHashes...)
	}
	return plumbing.ZeroHash, errors.New("no common ancestor")
}
