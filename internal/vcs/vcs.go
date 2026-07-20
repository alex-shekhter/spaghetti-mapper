// Package vcs wraps go-git to give each SpaghettiMapper project a local git
// repo. Phase 1 recorded every mutation of the main line as an attributable
// commit. Phase 2 adds architect branches: each architect works on their own
// branch ref (refs/heads/architects/<id>) via git plumbing — no working-tree
// checkout, so the on-disk tree keeps reflecting main — and a visibility API
// lists the active architects and how far their branch is from main.
package vcs

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"

	"spaghettimapper/internal/store"
	"spaghettimapper/internal/volume"
)

const (
	gitignoreBody = ".trash/\n*.tmp\n"

	// mainRef is the canonical line (what the on-disk working tree tracks).
	mainRef = plumbing.ReferenceName("refs/heads/main")
	// architectPrefix namespaces per-architect branches.
	architectPrefix = "refs/heads/architects/"
)

// Repo is a per-project git repository. The mutex serializes operations that
// touch the index/refs (commits, branch creation) so concurrent requests on
// the same project don't race.
type Repo struct {
	mu  sync.Mutex
	r   *git.Repository
	dir string
}

// Open returns a Repo for dir, initialising an empty repo (with a .gitignore
// that keeps .trash and temp files out of history) if one doesn't already
// exist. It is idempotent. The default branch is `main`; Phase-1 repos that
// defaulted to `master` are migrated on open.
func Open(dir string) (*Repo, error) {
	// Ensure we only open if .git exists in this specific directory.
	// PlainOpen climbs up the directory tree by default, which can open the parent workspace repo.
	_, statErr := os.Stat(filepath.Join(dir, ".git"))
	if statErr == nil {
		r, err := git.PlainOpenWithOptions(dir, &git.PlainOpenOptions{DetectDotGit: false})
		if err == nil {
			if err := renameMasterToMain(r); err != nil {
				return nil, fmt.Errorf("migrate main branch: %w", err)
			}
			return &Repo{r: r, dir: dir}, nil
		}
	}
	r, err := git.PlainInitWithOptions(dir, &git.PlainInitOptions{
		InitOptions: git.InitOptions{DefaultBranch: mainRef},
	})
	if err != nil {
		return nil, fmt.Errorf("init repo: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(gitignoreBody), 0o644); err != nil {
		return nil, fmt.Errorf("write .gitignore: %w", err)
	}
	return &Repo{r: r, dir: dir}, nil
}

// renameMasterToMain moves a Phase-1 `master` branch (go-git's old default)
// to `main` and repoints HEAD. A no-op when `main` already exists or there
// are no commits yet.
func renameMasterToMain(r *git.Repository) error {
	head, err := r.Head()
	if err != nil {
		if errors.Is(err, plumbing.ErrReferenceNotFound) {
			// Unborn HEAD: just repoint it to main.
			return r.Storer.SetReference(plumbing.NewSymbolicReference(plumbing.HEAD, mainRef))
		}
		return err
	}
	if head.Name() == mainRef {
		return nil
	}
	if head.Name() != plumbing.Master {
		// HEAD points at something unexpected; leave it.
		return nil
	}
	master, err := r.Reference(plumbing.Master, true)
	if err != nil {
		return err
	}
	if err := r.Storer.SetReference(plumbing.NewHashReference(mainRef, master.Hash())); err != nil {
		return err
	}
	if err := r.Storer.SetReference(plumbing.NewSymbolicReference(plumbing.HEAD, mainRef)); err != nil {
		return err
	}
	return r.Storer.RemoveReference(plumbing.Master)
}

// Commit stages all tracked + new project files and commits them on the
// main line (the working tree) with the given architect as author. A no-op
// when the tree is clean. Used by the disk volume (Phase 1 path).
func (repo *Repo) Commit(architectID, architectName, msg string) error {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	wt, err := repo.r.Worktree()
	if err != nil {
		return err
	}
	if err := wt.AddWithOptions(&git.AddOptions{All: true}); err != nil {
		return fmt.Errorf("stage: %w", err)
	}
	sig := &object.Signature{
		Name:  architectName,
		Email: architectID + "@spaghettimapper.local",
		When:  time.Now().UTC(),
	}
	if _, err := wt.Commit(msg, &git.CommitOptions{Author: sig, Committer: sig}); err != nil {
		if errors.Is(err, git.ErrEmptyCommit) {
			return nil
		}
		return fmt.Errorf("commit: %w", err)
	}
	// A new main-line edit after an undo discards the redo future for main.
	repo.clearRedoLocked("")
	return nil
}

// HeadHash returns the short hash of HEAD, or "" if there are no commits yet.
func (repo *Repo) HeadHash() string {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	h, err := repo.r.Head()
	if err != nil {
		return ""
	}
	return h.Hash().String()[:7]
}

// ArchitectBranchRef returns the branch ref name for an architect id.
func ArchitectBranchRef(architectID string) plumbing.ReferenceName {
	return plumbing.ReferenceName(architectPrefix + architectID)
}

// ---- disk volume (the main line / working tree) ----

// DiskVolume is a volume backed by the project's on-disk working tree. Reads
// and writes go to the filesystem; Commit commits the working tree to main.
type DiskVolume struct {
	dir  string
	mgr  *Manager
	proj string
}

// NewDiskVolume builds a disk volume for a project. mgr commits main on
// Commit; nil makes Commit a no-op (used in tests).
func NewDiskVolume(dir string, mgr *Manager, proj string) *DiskVolume {
	return &DiskVolume{dir: dir, mgr: mgr, proj: proj}
}

func (d *DiskVolume) Read(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(d.dir, name))
}

func (d *DiskVolume) Write(name string, data []byte) error {
	path := filepath.Join(d.dir, name)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (d *DiskVolume) Exists(name string) bool {
	_, err := os.Stat(filepath.Join(d.dir, name))
	return err == nil
}

func (d *DiskVolume) CanTrash() bool { return true }

func (d *DiskVolume) IsBranch() bool { return false }
func (d *DiskVolume) Release()       {}

func (d *DiskVolume) Commit(architectID, architectName, msg string) error {
	if d.mgr == nil {
		return nil
	}
	return d.mgr.CommitProject(d.proj, architectID, architectName, msg)
}

// ---- branch volume (an architect's workspace, via git plumbing) ----

// BranchVolume is a volume over an architect's branch. Reads are served from
// the branch's tree (falling back to main when the branch doesn't exist
// yet); writes buffer in memory and flush as a single commit to the branch
// ref on Commit. The on-disk working tree is never touched.
type BranchVolume struct {
	repo       *Repo
	ref        plumbing.ReferenceName
	baseCommit plumbing.Hash // commit the branch was at (or main HEAD if new)
	baseTree   *object.Tree
	buf        map[string][]byte
	release    func() // unlocks the per-branch write lock; nil for read volumes
}

// NewBranchVolume opens a branch volume for architectID. If the branch
// doesn't exist yet, it is rooted at main's HEAD so the architect sees the
// current map; the branch ref is created on first Commit. When forWrite is
// true it holds the per-branch write lock (released via Release) so concurrent
// writes to the same branch serialize — the snapshot is taken under the lock,
// preventing lost updates. Read volumes take no lock.
func (m *Manager) NewBranchVolume(proj, architectID string, forWrite bool) (*BranchVolume, error) {
	var release func()
	if forWrite {
		lk := m.branchLock(proj, architectID)
		lk.Lock()
		release = lk.Unlock
	}
	repo, err := m.repoForProject(proj)
	if err != nil {
		if release != nil {
			release()
		}
		return nil, err
	}
	ref := ArchitectBranchRef(architectID)
	bv := &BranchVolume{repo: repo, ref: ref, buf: map[string][]byte{}, release: release}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	// Prefer the existing branch; else main HEAD.
	if refHash, err := repo.r.Reference(ref, true); err == nil {
		bv.baseCommit = refHash.Hash()
	} else if head, err := repo.r.Head(); err == nil {
		bv.baseCommit = head.Hash()
	} else if !errors.Is(err, plumbing.ErrReferenceNotFound) {
		return nil, fmt.Errorf("resolve base: %w", err)
	}
	if !bv.baseCommit.IsZero() {
		c, err := repo.r.CommitObject(bv.baseCommit)
		if err != nil {
			return nil, fmt.Errorf("load base commit: %w", err)
		}
		t, err := c.Tree()
		if err != nil {
			return nil, fmt.Errorf("load base tree: %w", err)
		}
		bv.baseTree = t
	}
	return bv, nil
}

func (v *BranchVolume) Read(name string) ([]byte, error) {
	if data, ok := v.buf[name]; ok {
		return data, nil
	}
	if v.baseTree == nil {
		return nil, os.ErrNotExist
	}
	e, err := v.baseTree.FindEntry(name)
	if err != nil {
		return nil, os.ErrNotExist
	}
	blob, err := v.repo.r.BlobObject(e.Hash)
	if err != nil {
		return nil, err
	}
	r, err := blob.Reader()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}

func (v *BranchVolume) Write(name string, data []byte) error {
	v.buf[name] = data
	return nil
}

func (v *BranchVolume) Exists(name string) bool {
	if _, ok := v.buf[name]; ok {
		return true
	}
	if v.baseTree == nil {
		return false
	}
	_, err := v.baseTree.FindEntry(name)
	return err == nil
}

func (v *BranchVolume) CanTrash() bool { return false }

func (v *BranchVolume) IsBranch() bool { return true }
func (v *BranchVolume) Release() {
	if v.release != nil {
		v.release()
		v.release = nil
	}
}

func (v *BranchVolume) Commit(architectID, architectName, msg string) error {
	if len(v.buf) == 0 {
		return nil
	}
	sig := &object.Signature{
		Name:  architectName,
		Email: architectID + "@spaghettimapper.local",
		When:  time.Now().UTC(),
	}
	repo := v.repo
	repo.mu.Lock()
	defer repo.mu.Unlock()
	// Re-read the branch HEAD: if it advanced past the snapshot (a prior commit
	// in this volume, or a concurrent commit), rebase the buffer onto the
	// latest tree so commits chain instead of orphaning one another. Files in
	// the buffer win (last-write-wins); files outside it keep the latest version.
	parent := v.baseCommit
	baseTree := v.baseTree
	if cur, err := repo.r.Reference(v.ref, true); err == nil && cur.Hash() != v.baseCommit {
		parent = cur.Hash()
		if c, err := repo.r.CommitObject(parent); err == nil {
			if t, err := c.Tree(); err == nil {
				baseTree = t
			}
		}
	}
	if err := repo.applyToBranchLocked(v.ref, parent, baseTree, v.buf, sig, msg); err != nil {
		return err
	}
	// A new edit after an undo discards the redo future for this line.
	repo.clearRedoLocked(archIDFromRef(v.ref))
	return nil
}

// applyToBranchLocked builds a tree from base + buf, writes a commit (parent =
// baseCommit, or none for the first commit) and advances the branch ref.
// The caller must hold repo.mu.
func (repo *Repo) applyToBranchLocked(ref plumbing.ReferenceName, baseCommit plumbing.Hash, baseTree *object.Tree, buf map[string][]byte, sig *object.Signature, msg string) error {
	// Start from the base tree's entries.
	entries := []object.TreeEntry{}
	if baseTree != nil {
		entries = append(entries, baseTree.Entries...)
	}
	// Apply buffered writes: replace existing entry hashes, append new ones.
	idx := map[string]int{}
	for i, e := range entries {
		idx[e.Name] = i
	}
	for name, data := range buf {
		blob := repo.r.Storer.NewEncodedObject()
		blob.SetType(plumbing.BlobObject)
		w, err := blob.Writer()
		if err != nil {
			return err
		}
		if _, err := w.Write(data); err != nil {
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
		hash, err := repo.r.Storer.SetEncodedObject(blob)
		if err != nil {
			return err
		}
		entry := object.TreeEntry{Name: name, Mode: filemode.Regular, Hash: hash}
		if i, ok := idx[name]; ok {
			entries[i] = entry
		} else {
			entries = append(entries, entry)
			idx[name] = len(entries) - 1
		}
	}
	// git requires tree entries sorted by name.
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })

	tree := &object.Tree{Entries: entries}
	tobj := repo.r.Storer.NewEncodedObject()
	tobj.SetType(plumbing.TreeObject)
	if err := tree.Encode(tobj); err != nil {
		return fmt.Errorf("encode tree: %w", err)
	}
	treeHash, err := repo.r.Storer.SetEncodedObject(tobj)
	if err != nil {
		return fmt.Errorf("store tree: %w", err)
	}

	commit := &object.Commit{
		TreeHash:  treeHash,
		Author:    *sig,
		Committer: *sig,
		Message:   msg,
	}
	if !baseCommit.IsZero() {
		commit.ParentHashes = []plumbing.Hash{baseCommit}
	}
	cobj := repo.r.Storer.NewEncodedObject()
	cobj.SetType(plumbing.CommitObject)
	if err := commit.Encode(cobj); err != nil {
		return fmt.Errorf("encode commit: %w", err)
	}
	commitHash, err := repo.r.Storer.SetEncodedObject(cobj)
	if err != nil {
		return fmt.Errorf("store commit: %w", err)
	}
	if err := repo.r.Storer.SetReference(plumbing.NewHashReference(ref, commitHash)); err != nil {
		return fmt.Errorf("set ref: %w", err)
	}
	return nil
}

// ArchitectInfo is a branch's visibility summary for the Architects panel.
type ArchitectInfo struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	LastCommit string    `json:"last_commit"` // short hash
	Message    string    `json:"message"`
	When       time.Time `json:"when"`
	Author     string    `json:"author"`
	Ahead      int       `json:"ahead"`  // commits ahead of main
	Behind     int       `json:"behind"` // commits behind main
}

// ListArchitects returns one ArchitectInfo per architect branch, sorted by
// most-recent first. Main-only repos return an empty list.
func (m *Manager) ListArchitects(proj string) ([]ArchitectInfo, error) {
	repo, err := m.repoForProject(proj)
	if err != nil {
		return nil, err
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()

	mainHash := plumbing.ZeroHash
	if head, err := repo.r.Head(); err == nil {
		mainHash = head.Hash()
	}
	out := []ArchitectInfo{}
	iter, err := repo.r.Storer.IterReferences()
	if err != nil {
		return nil, err
	}
	if err := iter.ForEach(func(ref *plumbing.Reference) error {
		if !ref.Name().IsBranch() || !isArchitectBranch(ref.Name()) {
			return nil
		}
		id := ref.Name().String()[len(architectPrefix):]
		info := ArchitectInfo{ID: id}
		if c, err := repo.r.CommitObject(ref.Hash()); err == nil {
			info.LastCommit = ref.Hash().String()[:7]
			info.Message = firstLine(c.Message)
			info.When = c.Committer.When
			info.Name = c.Author.Name
			info.Author = c.Author.Name
			info.Ahead, info.Behind = aheadBehind(repo.r, mainHash, ref.Hash())
		}
		out = append(out, info)
		return nil
	}); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].When.After(out[j].When) })
	return out, nil
}

func isArchitectBranch(name plumbing.ReferenceName) bool {
	return len(name.String()) > len(architectPrefix) &&
		name.String()[:len(architectPrefix)] == architectPrefix
}

func firstLine(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			return s[:i]
		}
	}
	return s
}

// aheadBehind reports how many commits `to` has that `from` doesn't (ahead)
// and vice versa (behind), walking the *full* commit DAG (all parents, not
// just first-parent). This matters once merges land on main: a first-parent
// walk can't see that a branch has fallen behind a merge commit, so the
// Architects panel's "Diverged" pill would never fire. Project histories are
// small, so the ancestor-set computation is cheap.
func aheadBehind(r *git.Repository, from, to plumbing.Hash) (ahead, behind int) {
	if from.IsZero() && to.IsZero() {
		return
	}
	if from.IsZero() {
		return reachableCount(r, to), 0
	}
	if to.IsZero() {
		return 0, reachableCount(r, from)
	}
	reachFrom := reachable(r, from)
	reachTo := reachable(r, to)
	for h := range reachTo {
		if !reachFrom[h] {
			ahead++
		}
	}
	for h := range reachFrom {
		if !reachTo[h] {
			behind++
		}
	}
	return
}

// reachable returns the set of commit hashes reachable from start (inclusive),
// following every parent. Missing commits are skipped.
func reachable(r *git.Repository, start plumbing.Hash) map[plumbing.Hash]bool {
	seen := map[plumbing.Hash]bool{}
	stack := []plumbing.Hash{start}
	for len(stack) > 0 {
		h := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[h] {
			continue
		}
		seen[h] = true
		c, err := r.CommitObject(h)
		if err != nil {
			continue
		}
		for _, p := range c.ParentHashes {
			if !seen[p] {
				stack = append(stack, p)
			}
		}
	}
	return seen
}

func reachableCount(r *git.Repository, start plumbing.Hash) int {
	return len(reachable(r, start))
}

// DeleteArchitect removes an architect's branch ref (abort their workspace).
// The commits remain in the object store; only the lightweight label is dropped.
func (m *Manager) DeleteArchitect(proj, architectID string) error {
	repo, err := m.repoForProject(proj)
	if err != nil {
		return err
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	return repo.r.Storer.RemoveReference(ArchitectBranchRef(architectID))
}

// ---- manager ----

// Manager caches open repos by project dir so we don't re-open on every
// request.
type Manager struct {
	mu       sync.Mutex
	repos    map[string]*Repo
	root     string
	bmu      sync.Mutex
	branches map[string]*sync.Mutex // per-branch write locks, keyed "proj:arch"
}

func NewManager(root string) *Manager {
	return &Manager{repos: map[string]*Repo{}, root: root, branches: map[string]*sync.Mutex{}}
}

func (m *Manager) Evict(proj string) {
	dir, err := store.ProjectDir(m.root, proj)
	if err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.repos, dir)
}

// branchLock returns the mutex for a branch, creating it on demand. Holding it
// across a branch's snapshot→read-modify→commit makes concurrent writes to the
// same branch serialize (no lost updates), while different branches run in
// parallel and none of them touch the main working tree.
func (m *Manager) branchLock(proj, arch string) *sync.Mutex {
	key := proj + ":" + arch
	m.bmu.Lock()
	defer m.bmu.Unlock()
	lk, ok := m.branches[key]
	if !ok {
		lk = &sync.Mutex{}
		m.branches[key] = lk
	}
	return lk
}

func (m *Manager) repoForProject(name string) (*Repo, error) {
	dir, err := store.ProjectDir(m.root, name)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(dir, "project.json")); err != nil {
		return nil, store.ErrNotFound
	}
	return m.get(dir)
}

// NewDiskVolume builds a disk volume for a project's main line. Returns an
// error if the project does not exist on disk (branches are of real projects).
func (m *Manager) NewDiskVolume(proj string) (*DiskVolume, error) {
	dir, err := store.ProjectDir(m.root, proj)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(dir, "project.json")); err != nil {
		return nil, store.ErrNotFound
	}
	if _, err := m.get(dir); err != nil { // ensure repo is open/inited
		return nil, err
	}
	return NewDiskVolume(dir, m, proj), nil
}

// CommitProject commits the named project's main line, opening/initing it on
// demand. A missing project is a no-op (e.g. after delete).
func (m *Manager) CommitProject(name, architectID, architectName, msg string) error {
	dir, err := store.ProjectDir(m.root, name)
	if err != nil {
		return nil
	}
	if _, err := os.Stat(filepath.Join(dir, "project.json")); err != nil {
		return nil
	}
	r, err := m.get(dir)
	if err != nil {
		return err
	}
	return r.Commit(architectID, architectName, msg)
}

func (m *Manager) get(dir string) (*Repo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.repos[dir]; ok {
		return r, nil
	}
	r, err := Open(dir)
	if err != nil {
		return nil, err
	}
	m.repos[dir] = r
	return r, nil
}

// Compile-time assertions that the volumes satisfy the interface.
var (
	_ volume.Volume = (*DiskVolume)(nil)
	_ volume.Volume = (*BranchVolume)(nil)
)

// silence unused import in some build configs
var _ storer.Storer
