package vcs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// helperCommit simulates the store writing a project file, so we can test the
// repo lifecycle without importing the store.
func writeFile(dir, name, body string) {
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		panic(err)
	}
}

func TestOpenInitsAndCommits(t *testing.T) {
	dir := t.TempDir()
	writeFile(dir, "project.json", `{"name":"Demo"}`)

	repo, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Commit("alice", "Alice", "create project"); err != nil {
		t.Fatal(err)
	}
	if repo.HeadHash() == "" {
		t.Fatal("expected a commit on HEAD after Commit")
	}

	// A second commit with no changes is a no-op, not an error.
	if err := repo.Commit("alice", "Alice", "nothing changed"); err != nil {
		t.Fatalf("empty commit should be a no-op, got %v", err)
	}

	// Mutate, commit again, assert history grew (different hash).
	h1 := repo.HeadHash()
	writeFile(dir, "systems.json", `[]`)
	if err := repo.Commit("bob", "Bob", "update systems"); err != nil {
		t.Fatal(err)
	}
	h2 := repo.HeadHash()
	if h1 == "" || h2 == "" || h1 == h2 {
		t.Fatalf("expected a new commit, h1=%s h2=%s", h1, h2)
	}
}

func TestGitignoreKeepsTrashOut(t *testing.T) {
	dir := t.TempDir()
	writeFile(dir, "project.json", `{"name":"Demo"}`)
	repo, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// .trash/ contents must not be tracked.
	os.MkdirAll(filepath.Join(dir, ".trash"), 0o755)
	writeFile(dir, ".trash/stream-abc.json", `{"trashed":true}`)
	if err := repo.Commit("alice", "Alice", "create project"); err != nil {
		t.Fatal(err)
	}
	// The .gitignore and the project.json are committed; the trash file is
	// not. Verify by reading the .gitignore on disk (it was added by Open).
	gi, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if !contains(string(gi), ".trash/") {
		t.Fatalf(".gitignore missing .trash/: %s", gi)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
func setupDemo(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	projDir := filepath.Join(root, "Demo")
	os.MkdirAll(projDir, 0o755)
	writeFile(projDir, "project.json", `{"name":"Demo"}`)
	writeFile(projDir, "systems.json", `[]`)
	return root, projDir
}

func TestBranchVolumeRoundTrip(t *testing.T) {
	root, projDir := setupDemo(t)
	mgr := NewManager(root)
	if err := mgr.CommitProject("Demo", "alice", "Alice", "create project"); err != nil {
		t.Fatal(err)
	}

	// A fresh branch volume for "bob" should see main's files (fallback).
	bv, err := mgr.NewBranchVolume("Demo", "bob", false)
	if err != nil {
		t.Fatal(err)
	}
	got, err := bv.Read("project.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"name":"Demo"}` {
		t.Fatalf("branch read should fall back to main: %q", got)
	}

	// Buffer a write and commit to the branch.
	if err := bv.Write("systems.json", []byte(`[{"id":"s1"}]`)); err != nil {
		t.Fatal(err)
	}
	if err := bv.Commit("bob", "Bob", "add system s1"); err != nil {
		t.Fatal(err)
	}

	// Main's working tree is untouched.
	if b, _ := os.ReadFile(filepath.Join(projDir, "systems.json")); string(b) != `[]` {
		t.Fatalf("main working tree should be unchanged, got %q", b)
	}

	// A fresh volume now reflects the committed branch.
	bv2, err := mgr.NewBranchVolume("Demo", "bob", false)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := bv2.Read("systems.json"); string(got) != `[{"id":"s1"}]` {
		t.Fatalf("branch should persist committed write, got %q", got)
	}
	if got, _ := bv2.Read("project.json"); string(got) != `{"name":"Demo"}` {
		t.Fatalf("project.json should resolve from branch tree, got %q", got)
	}
}

func TestListArchitects(t *testing.T) {
	root, _ := setupDemo(t)
	mgr := NewManager(root)
	mgr.CommitProject("Demo", "alice", "Alice", "create project")

	for _, a := range []struct{ id, name, msg string }{
		{"alice", "Alice", "alice: add stream"},
		{"bob", "Bob", "bob: add system"},
	} {
		bv, err := mgr.NewBranchVolume("Demo", a.id, false)
		if err != nil {
			t.Fatal(err)
		}
		bv.Write("systems.json", []byte(`["`+a.id+`"]`))
		if err := bv.Commit(a.id, a.name, a.msg); err != nil {
			t.Fatal(err)
		}
	}

	list, err := mgr.ListArchitects("Demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 architects, got %d: %+v", len(list), list)
	}
	byID := map[string]ArchitectInfo{}
	for _, a := range list {
		byID[a.ID] = a
	}
	if byID["alice"].Author != "Alice" || byID["alice"].Message != "alice: add stream" {
		t.Fatalf("unexpected alice info: %+v", byID["alice"])
	}
	if byID["bob"].Ahead != 1 {
		t.Fatalf("bob should be 1 ahead of main, got %d", byID["bob"].Ahead)
	}
}

func TestSameBranchConcurrentWritesNoLostUpdate(t *testing.T) {
	root, _ := setupDemo(t)
	mgr := NewManager(root)
	mgr.CommitProject("Demo", "alice", "Alice", "create project")

	// 12 goroutines each append a distinct system to bob's branch. With the
	// per-branch write lock they serialize; all 12 must survive.
	const n = 12
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			bv, err := mgr.NewBranchVolume("Demo", "bob", true)
			if err != nil {
				t.Error(err)
				return
			}
			cur, _ := readSystemsFromBranch(bv)
			cur = append(cur, fmt.Sprintf("s%d", i))
			data, _ := json.Marshal(cur)
			bv.Write("systems.json", data)
			if err := bv.Commit("bob", "Bob", "add system"); err != nil {
				t.Error(err)
			}
			bv.Release()
		}(i)
	}
	wg.Wait()

	bv, _ := mgr.NewBranchVolume("Demo", "bob", false)
	got, _ := readSystemsFromBranch(bv)
	if len(got) != n {
		t.Fatalf("expected %d systems (no lost updates), got %d: %v", n, len(got), got)
	}
}

func TestDifferentBranchesParallel(t *testing.T) {
	root, _ := setupDemo(t)
	mgr := NewManager(root)
	mgr.CommitProject("Demo", "alice", "Alice", "create project")

	// Two architects add a system each, concurrently, on different branches.
	var wg sync.WaitGroup
	for _, a := range []string{"alice", "bob"} {
		wg.Add(1)
		go func(arch string) {
			defer wg.Done()
			bv, err := mgr.NewBranchVolume("Demo", arch, true)
			if err != nil {
				t.Error(err)
				return
			}
			data, _ := json.Marshal([]string{arch + "-sys"})
			bv.Write("systems.json", data)
			if err := bv.Commit(arch, arch, "add system"); err != nil {
				t.Error(err)
			}
			bv.Release()
		}(a)
	}
	wg.Wait()

	// Both branches should have their own system.
	for _, arch := range []string{"alice", "bob"} {
		bv, _ := mgr.NewBranchVolume("Demo", arch, false)
		got, _ := readSystemsFromBranch(bv)
		if len(got) != 1 || got[0] != arch+"-sys" {
			t.Fatalf("%s branch: expected [ %s-sys ], got %v", arch, arch, got)
		}
	}
}

func readSystemsFromBranch(bv *BranchVolume) ([]string, error) {
	data, err := bv.Read("systems.json")
	if err != nil || len(data) == 0 {
		return []string{}, nil
	}
	var ss []string
	err = json.Unmarshal(data, &ss)
	return ss, err
}

func TestAheadBehindDivergedAfterMerge(t *testing.T) {
	root, _ := setupDemo(t)
	mgr := NewManager(root)
	mgr.CommitProject("Demo", "alice", "Alice", "create project")

	// bob: 2 commits on his branch.
	bv, _ := mgr.NewBranchVolume("Demo", "bob", true)
	data, _ := json.Marshal([]string{"BobA"})
	bv.Write("systems.json", data)
	bv.Commit("bob", "Bob", "add BobA")
	data, _ = json.Marshal([]string{"BobA", "BobB"})
	bv.Write("systems.json", data)
	bv.Commit("bob", "Bob", "add BobB")
	bv.Release()

	// carol: 1 commit, then merge into main (advances main past bob's base).
	cv, _ := mgr.NewBranchVolume("Demo", "carol", true)
	data, _ = json.Marshal([]string{"CarolM"})
	cv.Write("systems.json", data)
	cv.Commit("carol", "Carol", "add one")
	cv.Release()
	if out, err := mgr.MergeArchitect("Demo", "carol", "carol", "Carol", nil); err != nil || !out.Merged {
		t.Fatalf("carol merge: err=%v merged=%v", err, out.Merged)
	}

	archs, err := mgr.ListArchitects("Demo")
	if err != nil {
		t.Fatal(err)
	}
	var bob *ArchitectInfo
	for i := range archs {
		if archs[i].ID == "bob" {
			bob = &archs[i]
		}
	}
	if bob == nil {
		t.Fatal("bob branch missing after carol merge")
	}
	if bob.Ahead != 2 || bob.Behind != 1 {
		t.Fatalf("expected bob diverged (ahead 2, behind 1), got ahead %d behind %d", bob.Ahead, bob.Behind)
	}
}
