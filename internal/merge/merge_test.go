package merge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"spaghettimapper/internal/store"
)

func sys(name string) store.System { return store.System{ID: name, Name: name, Type: "internal", Entities: []store.Entity{}} }

func fileJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func systemsFile(t *testing.T, ss ...store.System) []byte {
	t.Helper()
	if ss == nil {
		ss = []store.System{}
	}
	return fileJSON(t, ss)
}

func readSystems(t *testing.T, b []byte) []store.System {
	t.Helper()
	var ss []store.System
	if err := json.Unmarshal(b, &ss); err != nil {
		t.Fatal(err)
	}
	return ss
}

func TestMergeDisjointAdds(t *testing.T) {
	base := map[string][]byte{store.SystemsFile: systemsFile(t)}
	ours := map[string][]byte{store.SystemsFile: systemsFile(t, sys("a"))}
	theirs := map[string][]byte{store.SystemsFile: systemsFile(t, sys("b"))}
	out, err := Merge(base, ours, theirs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Conflicts) != 0 {
		t.Fatalf("expected no conflicts, got %+v", out.Conflicts)
	}
	ss := readSystems(t, out.Files[store.SystemsFile])
	if len(ss) != 2 {
		t.Fatalf("expected 2 systems, got %d", len(ss))
	}
}

func TestMergeEditEditConflict(t *testing.T) {
	base := map[string][]byte{store.SystemsFile: systemsFile(t, store.System{ID: "a", Name: "A", Type: "internal", Entities: []store.Entity{}})}
	ours := map[string][]byte{store.SystemsFile: systemsFile(t, store.System{ID: "a", Name: "A-ours", Type: "internal", Entities: []store.Entity{}})}
	theirs := map[string][]byte{store.SystemsFile: systemsFile(t, store.System{ID: "a", Name: "A-theirs", Type: "internal", Entities: []store.Entity{}})}
	out, err := Merge(base, ours, theirs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Conflicts) != 1 || out.Conflicts[0].Kind != "edit" {
		t.Fatalf("expected one edit conflict, got %+v", out.Conflicts)
	}
	// Default (unresolved) takes ours.
	ss := readSystems(t, out.Files[store.SystemsFile])
	if ss[0].Name != "A-ours" {
		t.Fatalf("default should be ours, got %q", ss[0].Name)
	}

	// With a resolution to theirs, theirs wins.
	out, _ = Merge(base, ours, theirs, map[string]string{ResolutionKey(store.SystemsFile, "a"): "theirs"})
	ss = readSystems(t, out.Files[store.SystemsFile])
	if ss[0].Name != "A-theirs" {
		t.Fatalf("resolution theirs should win, got %q", ss[0].Name)
	}
}

func TestMergeOneSidedEditNoConflict(t *testing.T) {
	base := map[string][]byte{store.SystemsFile: systemsFile(t, store.System{ID: "a", Name: "A", Type: "internal", Entities: []store.Entity{}})}
	ours := map[string][]byte{store.SystemsFile: systemsFile(t, store.System{ID: "a", Name: "A", Type: "internal", Entities: []store.Entity{}})} // main unchanged
	theirs := map[string][]byte{store.SystemsFile: systemsFile(t, store.System{ID: "a", Name: "A-theirs", Type: "internal", Entities: []store.Entity{}})}
	out, _ := Merge(base, ours, theirs, nil)
	if len(out.Conflicts) != 0 {
		t.Fatalf("one-sided edit must not conflict, got %+v", out.Conflicts)
	}
	ss := readSystems(t, out.Files[store.SystemsFile])
	if ss[0].Name != "A-theirs" {
		t.Fatalf("should take theirs, got %q", ss[0].Name)
	}
}

func TestMergeDeleteVsEditConflict(t *testing.T) {
	base := map[string][]byte{store.SystemsFile: systemsFile(t, sys("a"))}
	ours := map[string][]byte{store.SystemsFile: systemsFile(t)} // main deleted a
	theirs := map[string][]byte{store.SystemsFile: systemsFile(t, store.System{ID: "a", Name: "A-edited", Type: "internal", Entities: []store.Entity{}})}
	out, _ := Merge(base, ours, theirs, nil)
	if len(out.Conflicts) != 1 || out.Conflicts[0].Kind != "delete" {
		t.Fatalf("expected a delete conflict, got %+v", out.Conflicts)
	}
}

func TestMergeDeleteUncontested(t *testing.T) {
	base := map[string][]byte{store.SystemsFile: systemsFile(t, sys("a"))}
	ours := map[string][]byte{store.SystemsFile: systemsFile(t)} // main deleted a
	theirs := map[string][]byte{store.SystemsFile: systemsFile(t, sys("a"))} // branch unchanged
	out, _ := Merge(base, ours, theirs, nil)
	if len(out.Conflicts) != 0 {
		t.Fatalf("uncontested delete must not conflict, got %+v", out.Conflicts)
	}
	if readSystems(t, out.Files[store.SystemsFile]) != nil && len(readSystems(t, out.Files[store.SystemsFile])) != 0 {
		t.Fatalf("expected empty systems after delete")
	}
}

func TestMergeLayoutSoft(t *testing.T) {
	base := map[string][]byte{store.LayoutFile: fileJSON(t, map[string]store.NodePos{"a": {X: 0, Y: 0}})}
	ours := map[string][]byte{store.LayoutFile: fileJSON(t, map[string]store.NodePos{"a": {X: 1, Y: 1}})}
	theirs := map[string][]byte{store.LayoutFile: fileJSON(t, map[string]store.NodePos{"a": {X: 2, Y: 2}})}
	out, _ := Merge(base, ours, theirs, nil)
	if len(out.Conflicts) != 0 {
		t.Fatalf("layout must not hard-conflict, got %+v", out.Conflicts)
	}
	if len(out.Soft) != 1 {
		t.Fatalf("expected one soft note, got %+v", out.Soft)
	}
	var lay map[string]store.NodePos
	json.Unmarshal(out.Files[store.LayoutFile], &lay)
	if lay["a"].X != 1 {
		t.Fatalf("layout soft clash should keep main (X=1), got %v", lay["a"].X)
	}
}

// GS-3: both sides edit the same cluster → hard conflict.
func TestMergeClusterEditConflict(t *testing.T) {
	baseCl := []store.Cluster{{ID: "c1", Name: "Base", SystemIDs: []string{"s1"}}}
	oursCl := []store.Cluster{{ID: "c1", Name: "Ours", SystemIDs: []string{"s1"}}}
	theirsCl := []store.Cluster{{ID: "c1", Name: "Theirs", SystemIDs: []string{"s1"}}}
	base := map[string][]byte{store.ClustersFile: fileJSON(t, baseCl)}
	ours := map[string][]byte{store.ClustersFile: fileJSON(t, oursCl)}
	theirs := map[string][]byte{store.ClustersFile: fileJSON(t, theirsCl)}
	out, err := Merge(base, ours, theirs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Conflicts) != 1 || out.Conflicts[0].File != store.ClustersFile || out.Conflicts[0].Kind != "edit" {
		t.Fatalf("expected one cluster edit conflict, got %+v", out.Conflicts)
	}
	var cl []store.Cluster
	if err := json.Unmarshal(out.Files[store.ClustersFile], &cl); err != nil {
		t.Fatal(err)
	}
	if len(cl) != 1 || cl[0].Name != "Ours" {
		t.Fatalf("default should keep ours, got %+v", cl)
	}
}

// GS-3: after merge, Reconcile drops cluster members whose system is gone.
func TestReconcileStripsDeadClusterMembers(t *testing.T) {
	// Simulate post-merge volume: systems has only s1; cluster still lists s1+s2.
	dir := t.TempDir()
	v := testVol{dir: dir}
	// write via store helpers through a real volume-like interface
	sys := []store.System{{ID: "s1", Name: "A", Type: "internal", Entities: []store.Entity{}}}
	cl := []store.Cluster{{ID: "c1", Name: "Estate", SystemIDs: []string{"s1", "s2", "s3"}}}
	if err := writeTestJSON(t, dir, store.SystemsFile, sys); err != nil {
		t.Fatal(err)
	}
	if err := writeTestJSON(t, dir, store.StreamsFile, []store.Stream{}); err != nil {
		t.Fatal(err)
	}
	if err := writeTestJSON(t, dir, store.FlowsFile, []store.Flow{}); err != nil {
		t.Fatal(err)
	}
	if err := writeTestJSON(t, dir, store.ClustersFile, cl); err != nil {
		t.Fatal(err)
	}
	if err := store.Reconcile(v); err != nil {
		t.Fatal(err)
	}
	var got []store.Cluster
	data, err := v.Read(store.ClustersFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].SystemIDs) != 1 || got[0].SystemIDs[0] != "s1" {
		t.Fatalf("expected only s1 retained, got %+v", got)
	}
}

// testVol is defined in store_test — for merge package we use a local disk vol.
type testVol struct{ dir string }

func (v testVol) Read(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(v.dir, name))
}
func (v testVol) Write(name string, data []byte) error {
	path := filepath.Join(v.dir, name)
	if err := os.WriteFile(path+".tmp", data, 0o644); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
func (v testVol) Exists(name string) bool {
	_, err := os.Stat(filepath.Join(v.dir, name))
	return err == nil
}
func (v testVol) Commit(string, string, string) error { return nil }
func (v testVol) CanTrash() bool                      { return false }
func (v testVol) IsBranch() bool                      { return false }
func (v testVol) Release()                            {}

func writeTestJSON(t *testing.T, dir, name string, v any) error {
	t.Helper()
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name), b, 0o644)
}