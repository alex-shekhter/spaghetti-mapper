package vcs

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/go-git/go-git/v5/plumbing"
)

// commitMain writes systems.json to the project dir (simulating the store)
// and commits main with the given message. Returns the new HEAD hash.
func commitMain(t *testing.T, mgr *Manager, projDir string, systems []string, msg string) plumbing.Hash {
	t.Helper()
	data, _ := json.Marshal(systems)
	os.WriteFile(projDir+"/systems.json", data, 0o644)
	if err := mgr.CommitProject("Demo", "local", "Local", msg); err != nil {
		t.Fatal(err)
	}
	repo, err := mgr.repoForProject("Demo")
	if err != nil {
		t.Fatal(err)
	}
	h, err := repo.r.Head()
	if err != nil {
		t.Fatal(err)
	}
	return h.Hash()
}

func readSystemsFromMain(t *testing.T, projDir string) []string {
	t.Helper()
	b, err := os.ReadFile(projDir + "/systems.json")
	if err != nil || len(b) == 0 {
		return []string{}
	}
	var ss []string
	json.Unmarshal(b, &ss)
	return ss
}

func readSystemsAt(t *testing.T, mgr *Manager, sha plumbing.Hash) []string {
	t.Helper()
	cv, err := mgr.NewCommitVolume("Demo", sha)
	if err != nil {
		t.Fatal(err)
	}
	b, err := cv.Read("systems.json")
	if err != nil {
		return []string{}
	}
	var ss []string
	json.Unmarshal(b, &ss)
	return ss
}

func TestUndoRedoMainLinear(t *testing.T) {
	root, projDir := setupDemo(t)
	mgr := NewManager(root)
	commitMain(t, mgr, projDir, []string{"A"}, "add A")
	commitMain(t, mgr, projDir, []string{"A", "B"}, "add B")
	c3 := commitMain(t, mgr, projDir, []string{"A", "B", "C"}, "add C")

	// History: can undo, can't redo, 3 past entries, current = C commit.
	h, err := mgr.History("Demo", "")
	if err != nil {
		t.Fatal(err)
	}
	if !h.CanUndo || h.CanRedo || len(h.Entries) != 3 || !h.Entries[0].Current {
		t.Fatalf("initial history: canUndo=%v canRedo=%v n=%d entries[0].current=%v", h.CanUndo, h.CanRedo, len(h.Entries), h.Entries[0].Current)
	}

	// Undo once → working tree reflects [A B].
	h, err = mgr.Undo("Demo", "")
	if err != nil {
		t.Fatal(err)
	}
	if got := readSystemsFromMain(t, projDir); len(got) != 2 || got[1] != "B" {
		t.Fatalf("after undo, main should be [A B], got %v", got)
	}
	if !h.CanUndo || !h.CanRedo {
		t.Fatalf("after 1 undo: canUndo=%v canRedo=%v (want true,true)", h.CanUndo, h.CanRedo)
	}

	// Undo again → [A].
	h, _ = mgr.Undo("Demo", "")
	if got := readSystemsFromMain(t, projDir); len(got) != 1 || got[0] != "A" {
		t.Fatalf("after 2 undos, main should be [A], got %v", got)
	}

	// Redo → [A B].
	h, _ = mgr.Redo("Demo", "")
	if got := readSystemsFromMain(t, projDir); len(got) != 2 {
		t.Fatalf("after redo, main should be [A B], got %v", got)
	}
	if !h.CanRedo {
		t.Fatalf("after 1 redo, canRedo should be true (C still in future)")
	}

	// Redo again → [A B C] (full restore), redo future empty.
	h, _ = mgr.Redo("Demo", "")
	if got := readSystemsFromMain(t, projDir); len(got) != 3 || got[2] != "C" {
		t.Fatalf("after 2 redos, main should be [A B C], got %v", got)
	}
	if h.CanRedo {
		t.Fatalf("after redoing everything, canRedo should be false")
	}
	// HEAD restored to the original C commit.
	repo, _ := mgr.repoForProject("Demo")
	head, _ := repo.r.Head()
	if head.Hash() != c3 {
		t.Fatalf("after full redo, HEAD should be %s, got %s", c3, head.Hash())
	}
}

func TestUndoThenEditClearsRedo(t *testing.T) {
	root, projDir := setupDemo(t)
	mgr := NewManager(root)
	commitMain(t, mgr, projDir, []string{"A"}, "add A")
	commitMain(t, mgr, projDir, []string{"A", "B"}, "add B")
	commitMain(t, mgr, projDir, []string{"A", "B", "C"}, "add C")

	// Undo twice → [A], redo future = [C, B].
	mgr.Undo("Demo", "")
	h, _ := mgr.Undo("Demo", "")
	if !h.CanRedo {
		t.Fatal("expected redo future after 2 undos")
	}

	// A new edit commits on top of [A], discarding the redo future.
	commitMain(t, mgr, projDir, []string{"A", "X"}, "add X")
	h, _ = mgr.History("Demo", "")
	if h.CanRedo {
		t.Fatalf("new edit should clear redo future; canRedo=%v", h.CanRedo)
	}
	if got := readSystemsFromMain(t, projDir); len(got) != 2 || got[1] != "X" {
		t.Fatalf("after edit, main should be [A X], got %v", got)
	}
	// Undo should now go to [A] (not the old [A B]).
	mgr.Undo("Demo", "")
	if got := readSystemsFromMain(t, projDir); len(got) != 1 || got[0] != "A" {
		t.Fatalf("undo after edit should go to [A], got %v", got)
	}
}

func TestRestoreToPastPopulatesRedo(t *testing.T) {
	root, projDir := setupDemo(t)
	mgr := NewManager(root)
	c1 := commitMain(t, mgr, projDir, []string{"A"}, "add A")
	commitMain(t, mgr, projDir, []string{"A", "B"}, "add B")
	commitMain(t, mgr, projDir, []string{"A", "B", "C"}, "add C")

	// Restore to the first commit → [A], with B and C in the redo future.
	h, err := mgr.RestoreTo("Demo", "", c1)
	if err != nil {
		t.Fatal(err)
	}
	if got := readSystemsFromMain(t, projDir); len(got) != 1 || got[0] != "A" {
		t.Fatalf("restore to A: main should be [A], got %v", got)
	}
	if !h.CanRedo {
		t.Fatal("restore-to-past should populate redo future")
	}
	// Redo should walk forward: A → B → C.
	mgr.Redo("Demo", "")
	if got := readSystemsFromMain(t, projDir); len(got) != 2 || got[1] != "B" {
		t.Fatalf("redo after restore should give [A B], got %v", got)
	}
	mgr.Redo("Demo", "")
	if got := readSystemsFromMain(t, projDir); len(got) != 3 || got[2] != "C" {
		t.Fatalf("second redo should give [A B C], got %v", got)
	}
}

func TestRestoreToFutureShrinksRedo(t *testing.T) {
	root, projDir := setupDemo(t)
	mgr := NewManager(root)
	commitMain(t, mgr, projDir, []string{"A"}, "add A")
	commitMain(t, mgr, projDir, []string{"A", "B"}, "add B")
	c3 := commitMain(t, mgr, projDir, []string{"A", "B", "C"}, "add C")
	// Undo twice → [A], redo future = [C, B] (C newest).
	mgr.Undo("Demo", "")
	mgr.Undo("Demo", "")

	// Restore forward to C (the redo tip) → [A B C], redo future empty.
	h, err := mgr.RestoreTo("Demo", "", c3)
	if err != nil {
		t.Fatal(err)
	}
	if got := readSystemsFromMain(t, projDir); len(got) != 3 || got[2] != "C" {
		t.Fatalf("restore to C: main should be [A B C], got %v", got)
	}
	if h.CanRedo {
		t.Fatalf("restore to redo tip should clear redo future")
	}
}

func TestUndoAtInitialCommitNoOp(t *testing.T) {
	root, projDir := setupDemo(t)
	mgr := NewManager(root)
	commitMain(t, mgr, projDir, []string{"A"}, "initial")
	h, err := mgr.Undo("Demo", "")
	if err != nil {
		t.Fatal(err)
	}
	if h.CanUndo {
		t.Fatal("canUndo should be false at the initial commit")
	}
	if got := readSystemsFromMain(t, projDir); len(got) != 1 {
		t.Fatalf("undo at initial should be a no-op, got %v", got)
	}
}

func TestBranchUndoRedo(t *testing.T) {
	root, _ := setupDemo(t)
	mgr := NewManager(root)
	mgr.CommitProject("Demo", "alice", "Alice", "create project")

	// bob makes 3 commits on his branch.
	bv, _ := mgr.NewBranchVolume("Demo", "bob", true)
	writeBranch(bv, []string{"B1"})
	bv.Commit("bob", "Bob", "add B1")
	writeBranch(bv, []string{"B1", "B2"})
	bv.Commit("bob", "Bob", "add B2")
	writeBranch(bv, []string{"B1", "B2", "B3"})
	bv.Commit("bob", "Bob", "add B3")
	bv.Release()

	// Undo twice on the branch → branch reads [B1].
	h, _ := mgr.Undo("Demo", "bob")
	h, _ = mgr.Undo("Demo", "bob")
	if !h.CanRedo {
		t.Fatal("expected redo future on branch after 2 undos")
	}
	bv2, _ := mgr.NewBranchVolume("Demo", "bob", false)
	if got, _ := readSystemsFromBranch(bv2); len(got) != 1 || got[0] != "B1" {
		t.Fatalf("branch after 2 undos should be [B1], got %v", got)
	}

	// Redo → [B1 B2].
	mgr.Redo("Demo", "bob")
	bv3, _ := mgr.NewBranchVolume("Demo", "bob", false)
	if got, _ := readSystemsFromBranch(bv3); len(got) != 2 || got[1] != "B2" {
		t.Fatalf("branch after redo should be [B1 B2], got %v", got)
	}
}

func TestCommitVolumePreview(t *testing.T) {
	root, projDir := setupDemo(t)
	mgr := NewManager(root)
	c1 := commitMain(t, mgr, projDir, []string{"A"}, "add A")
	commitMain(t, mgr, projDir, []string{"A", "B"}, "add B")
	commitMain(t, mgr, projDir, []string{"A", "B", "C"}, "add C")

	// Preview the first commit → [A], read-only.
	cv, err := mgr.NewCommitVolume("Demo", c1)
	if err != nil {
		t.Fatal(err)
	}
	if got := readSystemsAt(t, mgr, c1); len(got) != 1 || got[0] != "A" {
		t.Fatalf("preview of c1 should be [A], got %v", got)
	}
	if err := cv.Write("systems.json", []byte("[]")); err == nil {
		t.Fatal("preview write should fail (read-only)")
	}
}

func TestClearRedoOnMerge(t *testing.T) {
	root, projDir := setupDemo(t)
	mgr := NewManager(root)
	mgr.CommitProject("Demo", "alice", "Alice", "create project")
	commitMain(t, mgr, projDir, []string{"A"}, "main add A")

	// bob commits on his branch, then we set a redo future on main by undoing.
	// (Use a main undo to seed redo/main.)
	mgr.Undo("Demo", "") // main back to initial "create project"
	h, _ := mgr.History("Demo", "")
	if !h.CanRedo {
		t.Fatal("expected redo future on main after undo")
	}

	// bob: one commit + fast-forward merge into main. FF advances main → clears redo/main.
	bv, _ := mgr.NewBranchVolume("Demo", "bob", true)
	writeBranch(bv, []string{"A", "Bob"})
	bv.Commit("bob", "Bob", "bob add")
	bv.Release()
	if out, err := mgr.MergeArchitect("Demo", "bob", "bob", "Bob", nil); err != nil || !out.FastForwarded {
		t.Fatalf("expected FF merge, got err=%v out=%+v", err, out)
	}
	h, _ = mgr.History("Demo", "")
	if h.CanRedo {
		t.Fatalf("FF merge should clear main's redo future; canRedo=%v", h.CanRedo)
	}
}

func TestHistoryTimelineOrder(t *testing.T) {
	root, projDir := setupDemo(t)
	mgr := NewManager(root)
	c1 := commitMain(t, mgr, projDir, []string{"A"}, "add A")
	commitMain(t, mgr, projDir, []string{"A", "B"}, "add B")
	c3 := commitMain(t, mgr, projDir, []string{"A", "B", "C"}, "add C")
	// Undo once → [A B], redo future = [C].
	mgr.Undo("Demo", "")
	h, _ := mgr.History("Demo", "")
	// Expect: [future: C (current's child)] then [current: B-commit] then [past: A-commit].
	if len(h.Entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(h.Entries))
	}
	if !h.Entries[0].Future {
		t.Fatalf("entries[0] should be the redo future, got future=%v msg=%q", h.Entries[0].Future, h.Entries[0].Message)
	}
	if h.Entries[0].Hash != c3.String() {
		t.Fatalf("future entry should be the C commit, got %s", h.Entries[0].Hash)
	}
	if !h.Entries[1].Current {
		t.Fatalf("entries[1] should be current, got current at %d", indexOfCurrent(h.Entries))
	}
	if h.Entries[2].Hash != c1.String() {
		t.Fatalf("entries[2] should be the A commit (oldest past), got %s", h.Entries[2].Hash)
	}
}

func writeBranch(bv *BranchVolume, systems []string) {
	data, _ := json.Marshal(systems)
	bv.Write("systems.json", data)
}

func indexOfCurrent(es []HistoryEntry) int {
	for i, e := range es {
		if e.Current {
			return i
		}
	}
	return -1
}