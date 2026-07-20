package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"spaghettimapper/internal/volume"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// testVol is a disk-backed volume for tests (no VCS dependency, to avoid an
// import cycle with package vcs). Commit is a no-op; CanTrash mirrors the
// real disk volume so deletion-trash tests still pass.
type testVol struct{ dir string }

func (v testVol) Read(name string) ([]byte, error) { return os.ReadFile(filepath.Join(v.dir, name)) }
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
func (v testVol) CanTrash() bool                      { return true }
func (v testVol) IsBranch() bool                      { return false }
func (v testVol) Release()                            {}

// tvol builds a testVol for a project in s.root.
func (s *Store) tvol(proj string) volume.Volume { return testVol{dir: filepath.Join(s.root, proj)} }

func TestProjectLifecycle(t *testing.T) {
	s := newTestStore(t)

	if _, err := s.CreateProject("Alpha", "first"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateProject("Alpha", ""); err != ErrExists {
		t.Fatalf("want ErrExists, got %v", err)
	}
	if _, err := s.CreateProject("../evil", ""); err != ErrInvalidName {
		t.Fatalf("want ErrInvalidName, got %v", err)
	}

	p, err := s.UpdateProject("Alpha", s.tvol("Alpha"), "updated")
	if err != nil || p.Description != "updated" {
		t.Fatalf("update: %v %+v", err, p)
	}

	list, err := s.ListProjects()
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %+v", err, list)
	}

	if err := s.DeleteProject("Alpha"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetProject("Alpha", s.tvol("Alpha")); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestEntityCRUD(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}

	sys, err := s.CreateSystem("P", s.tvol("P"), System{Name: "ERP", Type: "internal"})
	if err != nil || sys.ID == "" {
		t.Fatalf("create system: %v %+v", err, sys)
	}

	sys.Name = "ERP2"
	if _, err := s.UpdateSystem("P", s.tvol("P"), sys.ID, sys); err != nil {
		t.Fatal(err)
	}
	got, _ := s.ListSystems("P", s.tvol("P"))
	if len(got) != 1 || got[0].Name != "ERP2" {
		t.Fatalf("update not persisted: %+v", got)
	}

	if _, err := s.UpdateSystem("P", s.tvol("P"), "nope", sys); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if err := s.DeleteSystem("P", s.tvol("P"), sys.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteSystem("P", s.tvol("P"), sys.ID); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}

	// entities on a project that doesn't exist
	if _, err := s.ListStreams("nope", s.tvol("nope")); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestCatalogAndCascades(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}

	sysA, _ := s.CreateSystem("P", s.tvol("P"), System{Name: "A", Type: "internal", Entities: []Entity{
		{Name: "Order", Fields: []Field{{Name: "id"}, {Name: "total"}}},
	}})
	sysB, _ := s.CreateSystem("P", s.tvol("P"), System{Name: "B", Type: "external"})
	if sysA.Entities[0].ID == "" || sysA.Entities[0].Fields[0].ID == "" {
		t.Fatalf("catalog ids not assigned: %+v", sysA)
	}

	need, _ := s.CreateNeed("P", s.tvol("P"), BizNeed{Name: "N"})
	st, err := s.CreateStream("P", s.tvol("P"), Stream{
		Name: "flow", BizNeedIDs: []string{need.ID},
		Source: Endpoint{SystemID: sysA.ID, EntityIDs: []string{sysA.Entities[0].ID},
			FieldsMode: "list", FieldIDs: []string{sysA.Entities[0].Fields[0].ID}},
		Destination: Endpoint{SystemID: sysB.ID, FieldsMode: "all"},
	})
	if err != nil {
		t.Fatal(err)
	}

	// removing a field from the catalog scrubs it from streams
	sysA.Entities[0].Fields = sysA.Entities[0].Fields[1:] // drop "id"
	if _, err := s.UpdateSystem("P", s.tvol("P"), sysA.ID, sysA); err != nil {
		t.Fatal(err)
	}
	streams, _ := s.ListStreams("P", s.tvol("P"))
	if len(streams[0].Source.FieldIDs) != 0 {
		t.Fatalf("removed field not scrubbed: %+v", streams[0].Source)
	}

	// deleting a need scrubs it from streams
	if err := s.DeleteNeed("P", s.tvol("P"), need.ID); err != nil {
		t.Fatal(err)
	}
	streams, _ = s.ListStreams("P", s.tvol("P"))
	if len(streams[0].BizNeedIDs) != 0 {
		t.Fatalf("deleted need not scrubbed: %+v", streams[0].BizNeedIDs)
	}

	// deleting a system cascades to its streams
	if err := s.DeleteSystem("P", s.tvol("P"), sysB.ID); err != nil {
		t.Fatal(err)
	}
	streams, _ = s.ListStreams("P", s.tvol("P"))
	if len(streams) != 0 {
		t.Fatalf("cascade delete failed: %+v", streams)
	}
	_ = st

	// deleted stream landed in trash
	dir, _ := s.projectDir("P")
	trash, err := os.ReadDir(filepath.Join(dir, ".trash"))
	if err != nil || len(trash) == 0 {
		t.Fatalf("trash empty: %v", err)
	}
}

func TestExportImportRoundtrip(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("Src", "original"); err != nil {
		t.Fatal(err)
	}
	yes := true
	sys, _ := s.CreateSystem("Src", s.tvol("Src"), System{Name: "A", Type: "internal", Entities: []Entity{
		{Name: "Order", BizNeedIDs: []string{"n1"}, Fields: []Field{{Name: "id", Type: "uuid", Unique: &yes, BizNeedIDs: []string{"n1"}}}},
	}})
	need, _ := s.CreateNeed("Src", s.tvol("Src"), BizNeed{Name: "N"})
	if _, err := s.CreateStream("Src", s.tvol("Src"), Stream{Name: "flow", BizNeedIDs: []string{need.ID},
		Source:      Endpoint{SystemID: sys.ID, FieldsMode: "all"},
		Destination: Endpoint{SystemID: sys.ID, FieldsMode: "all"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveLayout("Src", s.tvol("Src"), map[string]NodePos{sys.ID: {X: 1, Y: 2, Pinned: true}}); err != nil {
		t.Fatal(err)
	}

	b, err := s.ExportProject("Src", s.tvol("Src"))
	if err != nil || b.FormatVersion != 1 {
		t.Fatalf("export: %v %+v", err, b.FormatVersion)
	}

	if _, err := s.ImportProject("Src", b); err != ErrExists {
		t.Fatalf("want ErrExists on name clash, got %v", err)
	}
	if _, err := s.ImportProject("Copy", b); err != nil {
		t.Fatal(err)
	}
	g, err := s.GetGraph("Copy", s.tvol("Copy"))
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Systems) != 1 || len(g.Streams) != 1 || len(g.Needs) != 1 {
		t.Fatalf("roundtrip lost data: %+v", g)
	}
	if g.Systems[0].ID != sys.ID || g.Systems[0].Entities[0].Fields[0].Unique == nil {
		t.Fatalf("ids/fields not preserved: %+v", g.Systems[0])
	}
	if g.Layout[sys.ID].X != 1 || !g.Layout[sys.ID].Pinned {
		t.Fatalf("layout not preserved: %+v", g.Layout)
	}
	if g.Systems[0].Entities[0].Fields[0].BizNeedIDs[0] != "n1" {
		t.Fatalf("field justification not preserved")
	}
}

func TestDeleteNeedScrubsCatalog(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}
	need, _ := s.CreateNeed("P", s.tvol("P"), BizNeed{Name: "N"})
	sys, _ := s.CreateSystem("P", s.tvol("P"), System{Name: "A", Type: "internal", Entities: []Entity{
		{Name: "E", BizNeedIDs: []string{need.ID}, Fields: []Field{{Name: "f", BizNeedIDs: []string{need.ID, "other"}}}},
	}})
	if err := s.DeleteNeed("P", s.tvol("P"), need.ID); err != nil {
		t.Fatal(err)
	}
	systems, _ := s.ListSystems("P", s.tvol("P"))
	e := systems[0].Entities[0]
	if len(e.BizNeedIDs) != 0 || len(e.Fields[0].BizNeedIDs) != 1 || e.Fields[0].BizNeedIDs[0] != "other" {
		t.Fatalf("catalog justifications not scrubbed: %+v", e)
	}
	_ = sys
}

func TestFlowsAndCascades(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}
	sysA, _ := s.CreateSystem("P", s.tvol("P"), System{Name: "A", Type: "internal"})
	sysB, _ := s.CreateSystem("P", s.tvol("P"), System{Name: "B", Type: "internal"})
	need, _ := s.CreateNeed("P", s.tvol("P"), BizNeed{Name: "N"})
	st1, _ := s.CreateStream("P", s.tvol("P"), Stream{Name: "s1",
		Source: Endpoint{SystemID: sysA.ID, FieldsMode: "all"}, Destination: Endpoint{SystemID: sysB.ID, FieldsMode: "all"}})
	st2, _ := s.CreateStream("P", s.tvol("P"), Stream{Name: "s2",
		Source: Endpoint{SystemID: sysB.ID, FieldsMode: "all"}, Destination: Endpoint{SystemID: sysA.ID, FieldsMode: "all"}})

	fl, err := s.CreateFlow("P", s.tvol("P"), Flow{Name: "roundtrip", BizNeedIDs: []string{need.ID},
		Steps: []FlowStep{{StreamID: st1.ID, Stage: 1}, {StreamID: st2.ID, Stage: 2}}})
	if err != nil || fl.ID == "" {
		t.Fatalf("create flow: %v %+v", err, fl)
	}

	fl.Description = "updated"
	if _, err := s.UpdateFlow("P", s.tvol("P"), fl.ID, fl); err != nil {
		t.Fatal(err)
	}

	// deleting a stream scrubs its step from flows
	if err := s.DeleteStream("P", s.tvol("P"), st2.ID); err != nil {
		t.Fatal(err)
	}
	flows, _ := s.ListFlows("P", s.tvol("P"))
	if len(flows[0].Steps) != 1 || flows[0].Steps[0].StreamID != st1.ID {
		t.Fatalf("stream not scrubbed from flow: %+v", flows[0])
	}

	// deleting a need scrubs it from flows
	if err := s.DeleteNeed("P", s.tvol("P"), need.ID); err != nil {
		t.Fatal(err)
	}
	flows, _ = s.ListFlows("P", s.tvol("P"))
	if len(flows[0].BizNeedIDs) != 0 {
		t.Fatalf("need not scrubbed from flow: %+v", flows[0])
	}

	// deleting a system cascades streams, which scrub from flows
	if err := s.DeleteSystem("P", s.tvol("P"), sysB.ID); err != nil {
		t.Fatal(err)
	}
	flows, _ = s.ListFlows("P", s.tvol("P"))
	if len(flows[0].Steps) != 0 {
		t.Fatalf("cascaded stream not scrubbed from flow: %+v", flows[0])
	}

	if err := s.DeleteFlow("P", s.tvol("P"), fl.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteFlow("P", s.tvol("P"), fl.ID); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestLayout(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}
	want := map[string]NodePos{"abc": {X: 10, Y: 20, Pinned: true}}
	if err := s.SaveLayout("P", s.tvol("P"), want); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetLayout("P", s.tvol("P"))
	if err != nil || got["abc"] != want["abc"] {
		t.Fatalf("layout roundtrip: %v %+v", err, got)
	}
}

// GS-3: clusters CRUD, validation, DeleteSystem membership strip, export/import.
func TestClustersCRUD(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}
	a, err := s.CreateSystem("P", s.tvol("P"), System{Name: "A", Type: "internal"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateSystem("P", s.tvol("P"), System{Name: "B", Type: "internal"})
	if err != nil {
		t.Fatal(err)
	}

	// Empty list when file missing
	list, err := s.ListClusters("P", s.tvol("P"))
	if err != nil || len(list) != 0 {
		t.Fatalf("empty clusters: %v %+v", err, list)
	}

	// Create
	cl, err := s.CreateCluster("P", s.tvol("P"), Cluster{
		Name: "  Payments  ", SystemIDs: []string{a.ID, b.ID, a.ID}, Color: "verdigris",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cl.ID == "" || cl.Name != "Payments" {
		t.Fatalf("create normalize: %+v", cl)
	}
	if len(cl.SystemIDs) != 2 {
		t.Fatalf("system_ids not deduped: %+v", cl.SystemIDs)
	}

	// Round-trip list
	list, err = s.ListClusters("P", s.tvol("P"))
	if err != nil || len(list) != 1 || list[0].ID != cl.ID {
		t.Fatalf("list: %v %+v", err, list)
	}

	// Update
	cl.Description = "money"
	cl.Color = "iris"
	upd, err := s.UpdateCluster("P", s.tvol("P"), cl.ID, cl)
	if err != nil || upd.Description != "money" || upd.Color != "iris" {
		t.Fatalf("update: %v %+v", err, upd)
	}

	// Unknown member id rejected
	_, err = s.CreateCluster("P", s.tvol("P"), Cluster{Name: "Bad", SystemIDs: []string{"nope"}})
	if err == nil || !errors.Is(err, ErrValidation) {
		t.Fatalf("want ErrValidation for unknown member, got %v", err)
	}

	// Bad color key rejected
	_, err = s.CreateCluster("P", s.tvol("P"), Cluster{Name: "Bad", Color: "amber"})
	if err == nil || !errors.Is(err, ErrValidation) {
		t.Fatalf("want ErrValidation for bad color, got %v", err)
	}

	// Empty name rejected
	_, err = s.CreateCluster("P", s.tvol("P"), Cluster{Name: "   "})
	if err == nil || !errors.Is(err, ErrValidation) {
		t.Fatalf("want ErrValidation for empty name, got %v", err)
	}

	// Graph carries clusters
	g, err := s.GetGraph("P", s.tvol("P"))
	if err != nil || len(g.Clusters) != 1 || g.Clusters[0].ID != cl.ID {
		t.Fatalf("graph clusters: %v %+v", err, g.Clusters)
	}

	// DeleteSystem strips membership
	if err := s.DeleteSystem("P", s.tvol("P"), a.ID); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListClusters("P", s.tvol("P"))
	if len(list) != 1 {
		t.Fatalf("cluster should survive system delete, got %d", len(list))
	}
	if len(list[0].SystemIDs) != 1 || list[0].SystemIDs[0] != b.ID {
		t.Fatalf("membership not stripped: %+v", list[0].SystemIDs)
	}

	// Delete cluster does not delete systems
	if err := s.DeleteCluster("P", s.tvol("P"), cl.ID); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListClusters("P", s.tvol("P"))
	if len(list) != 0 {
		t.Fatalf("cluster not deleted: %+v", list)
	}
	systems, _ := s.ListSystems("P", s.tvol("P"))
	if len(systems) != 1 || systems[0].ID != b.ID {
		t.Fatalf("systems affected by cluster delete: %+v", systems)
	}

	// Export → import round-trips clusters
	if _, err := s.CreateProject("Src", ""); err != nil {
		t.Fatal(err)
	}
	sa, _ := s.CreateSystem("Src", s.tvol("Src"), System{Name: "S", Type: "internal"})
	srcCl, err := s.CreateCluster("Src", s.tvol("Src"), Cluster{
		Name: "Estate", SystemIDs: []string{sa.ID}, Color: "moss",
	})
	if err != nil {
		t.Fatal(err)
	}
	bdl, err := s.ExportProject("Src", s.tvol("Src"))
	if err != nil || len(bdl.Clusters) != 1 {
		t.Fatalf("export clusters: %v %+v", err, bdl.Clusters)
	}
	if _, err := s.ImportProject("Copy", bdl); err != nil {
		t.Fatal(err)
	}
	g2, err := s.GetGraph("Copy", s.tvol("Copy"))
	if err != nil || len(g2.Clusters) != 1 {
		t.Fatalf("import clusters: %v %+v", err, g2.Clusters)
	}
	if g2.Clusters[0].ID != srcCl.ID || g2.Clusters[0].Name != "Estate" || g2.Clusters[0].Color != "moss" {
		t.Fatalf("cluster not preserved: %+v", g2.Clusters[0])
	}
	if len(g2.Clusters[0].SystemIDs) != 1 || g2.Clusters[0].SystemIDs[0] != sa.ID {
		t.Fatalf("membership not preserved: %+v", g2.Clusters[0].SystemIDs)
	}

	// Nil clusters in bundle → empty file, not error
	bdl.Clusters = nil
	if _, err := s.ImportProject("Copy2", bdl); err != nil {
		t.Fatal(err)
	}
	g3, _ := s.GetGraph("Copy2", s.tvol("Copy2"))
	if g3.Clusters == nil || len(g3.Clusters) != 0 {
		t.Fatalf("nil clusters import: %+v", g3.Clusters)
	}
}

// HP-1: ThumbGraph carries present-member clusters only; empty file omits field.
func TestThumbGraphClusters(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}
	vol := s.tvol("P")

	// Project without clusters.json → empty clusters, JSON field omitted.
	thumb, err := s.ThumbGraph("P", vol)
	if err != nil {
		t.Fatal(err)
	}
	if len(thumb.Clusters) != 0 {
		t.Fatalf("want no clusters, got %+v", thumb.Clusters)
	}
	raw, err := json.Marshal(thumb)
	if err != nil {
		t.Fatal(err)
	}
	if json.Valid(raw) && containsJSONKey(raw, "clusters") {
		t.Fatalf("clusters field should be omitted when empty: %s", raw)
	}

	// Three systems for a 3-member cluster; one solo; one that will be deleted.
	a, err := s.CreateSystem("P", vol, System{Name: "A", Type: "internal"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateSystem("P", vol, System{Name: "B", Type: "internal"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.CreateSystem("P", vol, System{Name: "C", Type: "internal"})
	if err != nil {
		t.Fatal(err)
	}
	solo, err := s.CreateSystem("P", vol, System{Name: "Solo", Type: "internal"})
	if err != nil {
		t.Fatal(err)
	}
	doomed, err := s.CreateSystem("P", vol, System{Name: "Doomed", Type: "internal"})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.CreateCluster("P", vol, Cluster{
		Name: "Trio", SystemIDs: []string{a.ID, b.ID, c.ID}, Color: "verdigris",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateCluster("P", vol, Cluster{
		Name: "One", SystemIDs: []string{solo.ID}, Color: "iris",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateCluster("P", vol, Cluster{
		Name: "Ghost", SystemIDs: []string{doomed.ID}, Color: "moss",
	}); err != nil {
		t.Fatal(err)
	}
	// Delete only member → membership stripped upstream → zero present → omitted.
	if err := s.DeleteSystem("P", vol, doomed.ID); err != nil {
		t.Fatal(err)
	}

	thumb, err = s.ThumbGraph("P", vol)
	if err != nil {
		t.Fatal(err)
	}
	if len(thumb.Clusters) != 2 {
		t.Fatalf("want 2 clusters (ghost omitted), got %d %+v", len(thumb.Clusters), thumb.Clusters)
	}
	// Stored order: Trio then One; Ghost skipped.
	if thumb.Clusters[0].Color != "verdigris" || len(thumb.Clusters[0].SystemIDs) != 3 {
		t.Fatalf("trio: %+v", thumb.Clusters[0])
	}
	for _, id := range []string{a.ID, b.ID, c.ID} {
		if !containsStr(thumb.Clusters[0].SystemIDs, id) {
			t.Fatalf("trio missing %s: %+v", id, thumb.Clusters[0].SystemIDs)
		}
	}
	if thumb.Clusters[1].Color != "iris" || len(thumb.Clusters[1].SystemIDs) != 1 || thumb.Clusters[1].SystemIDs[0] != solo.ID {
		t.Fatalf("one: %+v", thumb.Clusters[1])
	}
	// Only present members — doomed must not appear anywhere.
	for _, cl := range thumb.Clusters {
		if containsStr(cl.SystemIDs, doomed.ID) {
			t.Fatalf("dangling member in thumb: %+v", cl)
		}
	}
}

func containsJSONKey(raw []byte, key string) bool {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	_, ok := m[key]
	return ok
}

func containsStr(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

// GS-2: batch is all-or-nothing — an invalid op leaves the project untouched.
func TestBatchSystemsAllOrNothing(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}
	a, err := s.CreateSystem("P", s.tvol("P"), System{Name: "A", Type: "internal"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateSystem("P", s.tvol("P"), System{Name: "B", Type: "internal"})
	if err != nil {
		t.Fatal(err)
	}
	// Mix a valid set_type with a bad op — nothing should apply.
	err = s.BatchSystems("P", s.tvol("P"), []SystemOp{
		{Op: "set_type", ID: a.ID, Type: "external"},
		{Op: "set_type", ID: b.ID, Type: "not-a-type"},
	})
	if err == nil || !errors.Is(err, ErrValidation) {
		t.Fatalf("want ErrValidation, got %v", err)
	}
	systems, err := s.ListSystems("P", s.tvol("P"))
	if err != nil {
		t.Fatal(err)
	}
	for _, sys := range systems {
		if sys.Type != "internal" {
			t.Fatalf("system %s type changed to %q despite invalid batch", sys.Name, sys.Type)
		}
	}
	// Unknown id must not apply either.
	err = s.BatchSystems("P", s.tvol("P"), []SystemOp{
		{Op: "delete", ID: a.ID},
		{Op: "delete", ID: "no-such-id"},
	})
	if err == nil || !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	systems, err = s.ListSystems("P", s.tvol("P"))
	if err != nil || len(systems) != 2 {
		t.Fatalf("partial delete applied: len=%d err=%v", len(systems), err)
	}
	// Happy path: set_type + delete of a different set still works when valid.
	if err := s.BatchSystems("P", s.tvol("P"), []SystemOp{
		{Op: "set_type", ID: a.ID, Type: "external"},
		{Op: "set_type", ID: b.ID, Type: "unknown"},
	}); err != nil {
		t.Fatal(err)
	}
	systems, _ = s.ListSystems("P", s.tvol("P"))
	byID := map[string]string{}
	for _, sys := range systems {
		byID[sys.ID] = sys.Type
	}
	if byID[a.ID] != "external" || byID[b.ID] != "unknown" {
		t.Fatalf("set_type not applied: %+v", byID)
	}
	if err := s.BatchSystems("P", s.tvol("P"), []SystemOp{
		{Op: "delete", ID: a.ID},
		{Op: "delete", ID: b.ID},
	}); err != nil {
		t.Fatal(err)
	}
	systems, _ = s.ListSystems("P", s.tvol("P"))
	if len(systems) != 0 {
		t.Fatalf("batch delete left %d systems", len(systems))
	}
}

func TestMigrateV1(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Old")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// hand-write a v1 project (no schema_version, string entities/fields)
	mustWrite := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite("project.json", `{"name":"Old","description":"v1"}`)
	mustWrite("systems.json", `[{"id":"s1","name":"ERP","type":"internal"},{"id":"s2","name":"Shop","type":"external"}]`)
	mustWrite("needs.json", `[{"id":"n1","name":"Fulfillment"}]`)
	mustWrite("streams.json", `[{"id":"t1","name":"Orders","biz_need_id":"n1","timing":"scheduled","direction":"uni","status":"implemented",
		"source":{"system_id":"s2","entities":["Order"],"fields_mode":"list","fields":["id","total"]},
		"destination":{"system_id":"s1","entities":["SalesOrder"],"fields_mode":"all"}}]`)

	s, err := New(root) // migration runs at startup
	if err != nil {
		t.Fatal(err)
	}

	p, err := s.GetProject("Old", s.tvol("Old"))
	if err != nil || p.SchemaVersion != CurrentSchema {
		t.Fatalf("schema not bumped: %v %+v", err, p)
	}

	systems, _ := s.ListSystems("Old", s.tvol("Old"))
	shop := systems[1]
	if len(shop.Entities) != 1 || shop.Entities[0].Name != "Order" {
		t.Fatalf("entity not promoted: %+v", shop)
	}
	if len(shop.Entities[0].Fields) != 2 {
		t.Fatalf("fields not promoted: %+v", shop.Entities[0])
	}
	if shop.Entities[0].Provenance == nil || shop.Entities[0].Provenance.Source != "imported" {
		t.Fatalf("provenance missing: %+v", shop.Entities[0])
	}

	streams, _ := s.ListStreams("Old", s.tvol("Old"))
	st := streams[0]
	if len(st.BizNeedIDs) != 1 || st.BizNeedIDs[0] != "n1" {
		t.Fatalf("need not migrated: %+v", st)
	}
	if len(st.Source.EntityIDs) != 1 || st.Source.EntityIDs[0] != shop.Entities[0].ID {
		t.Fatalf("entity refs not linked: %+v", st.Source)
	}
	if len(st.Source.FieldIDs) != 2 {
		t.Fatalf("field refs not linked: %+v", st.Source)
	}

	// migration is idempotent: reopening must not duplicate anything
	s2, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	systems2, _ := s2.ListSystems("Old", s2.tvol("Old"))
	if len(systems2[1].Entities) != 1 {
		t.Fatalf("migration not idempotent: %+v", systems2[1])
	}
}

func TestConcurrentWrites(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.CreateSystem("P", s.tvol("P"), System{Name: "S", Type: "internal"}); err != nil {
				t.Error(err)
			}
			if _, err := s.ListSystems("P", s.tvol("P")); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()

	got, err := s.ListSystems("P", s.tvol("P"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 50 {
		t.Fatalf("want 50 systems after concurrent writes, got %d", len(got))
	}
}
