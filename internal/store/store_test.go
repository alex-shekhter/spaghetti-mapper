package store

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

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

	p, err := s.UpdateProject("Alpha", "updated")
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
	if _, err := s.GetProject("Alpha"); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestEntityCRUD(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}

	sys, err := s.CreateSystem("P", System{Name: "ERP", Type: "internal"})
	if err != nil || sys.ID == "" {
		t.Fatalf("create system: %v %+v", err, sys)
	}

	sys.Name = "ERP2"
	if _, err := s.UpdateSystem("P", sys.ID, sys); err != nil {
		t.Fatal(err)
	}
	got, _ := s.ListSystems("P")
	if len(got) != 1 || got[0].Name != "ERP2" {
		t.Fatalf("update not persisted: %+v", got)
	}

	if _, err := s.UpdateSystem("P", "nope", sys); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if err := s.DeleteSystem("P", sys.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteSystem("P", sys.ID); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}

	// entities on a project that doesn't exist
	if _, err := s.ListStreams("nope"); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestCatalogAndCascades(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}

	sysA, _ := s.CreateSystem("P", System{Name: "A", Type: "internal", Entities: []Entity{
		{Name: "Order", Fields: []Field{{Name: "id"}, {Name: "total"}}},
	}})
	sysB, _ := s.CreateSystem("P", System{Name: "B", Type: "external"})
	if sysA.Entities[0].ID == "" || sysA.Entities[0].Fields[0].ID == "" {
		t.Fatalf("catalog ids not assigned: %+v", sysA)
	}

	need, _ := s.CreateNeed("P", BizNeed{Name: "N"})
	st, err := s.CreateStream("P", Stream{
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
	if _, err := s.UpdateSystem("P", sysA.ID, sysA); err != nil {
		t.Fatal(err)
	}
	streams, _ := s.ListStreams("P")
	if len(streams[0].Source.FieldIDs) != 0 {
		t.Fatalf("removed field not scrubbed: %+v", streams[0].Source)
	}

	// deleting a need scrubs it from streams
	if err := s.DeleteNeed("P", need.ID); err != nil {
		t.Fatal(err)
	}
	streams, _ = s.ListStreams("P")
	if len(streams[0].BizNeedIDs) != 0 {
		t.Fatalf("deleted need not scrubbed: %+v", streams[0].BizNeedIDs)
	}

	// deleting a system cascades to its streams
	if err := s.DeleteSystem("P", sysB.ID); err != nil {
		t.Fatal(err)
	}
	streams, _ = s.ListStreams("P")
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
	sys, _ := s.CreateSystem("Src", System{Name: "A", Type: "internal", Entities: []Entity{
		{Name: "Order", BizNeedIDs: []string{"n1"}, Fields: []Field{{Name: "id", Type: "uuid", Unique: &yes, BizNeedIDs: []string{"n1"}}}},
	}})
	need, _ := s.CreateNeed("Src", BizNeed{Name: "N"})
	if _, err := s.CreateStream("Src", Stream{Name: "flow", BizNeedIDs: []string{need.ID},
		Source:      Endpoint{SystemID: sys.ID, FieldsMode: "all"},
		Destination: Endpoint{SystemID: sys.ID, FieldsMode: "all"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveLayout("Src", map[string]NodePos{sys.ID: {X: 1, Y: 2, Pinned: true}}); err != nil {
		t.Fatal(err)
	}

	b, err := s.ExportProject("Src")
	if err != nil || b.FormatVersion != 1 {
		t.Fatalf("export: %v %+v", err, b.FormatVersion)
	}

	if _, err := s.ImportProject("Src", b); err != ErrExists {
		t.Fatalf("want ErrExists on name clash, got %v", err)
	}
	if _, err := s.ImportProject("Copy", b); err != nil {
		t.Fatal(err)
	}
	g, err := s.GetGraph("Copy")
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
	need, _ := s.CreateNeed("P", BizNeed{Name: "N"})
	sys, _ := s.CreateSystem("P", System{Name: "A", Type: "internal", Entities: []Entity{
		{Name: "E", BizNeedIDs: []string{need.ID}, Fields: []Field{{Name: "f", BizNeedIDs: []string{need.ID, "other"}}}},
	}})
	if err := s.DeleteNeed("P", need.ID); err != nil {
		t.Fatal(err)
	}
	systems, _ := s.ListSystems("P")
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
	sysA, _ := s.CreateSystem("P", System{Name: "A", Type: "internal"})
	sysB, _ := s.CreateSystem("P", System{Name: "B", Type: "internal"})
	need, _ := s.CreateNeed("P", BizNeed{Name: "N"})
	st1, _ := s.CreateStream("P", Stream{Name: "s1",
		Source: Endpoint{SystemID: sysA.ID, FieldsMode: "all"}, Destination: Endpoint{SystemID: sysB.ID, FieldsMode: "all"}})
	st2, _ := s.CreateStream("P", Stream{Name: "s2",
		Source: Endpoint{SystemID: sysB.ID, FieldsMode: "all"}, Destination: Endpoint{SystemID: sysA.ID, FieldsMode: "all"}})

	fl, err := s.CreateFlow("P", Flow{Name: "roundtrip", BizNeedIDs: []string{need.ID},
		Steps: []FlowStep{{StreamID: st1.ID, Stage: 1}, {StreamID: st2.ID, Stage: 2}}})
	if err != nil || fl.ID == "" {
		t.Fatalf("create flow: %v %+v", err, fl)
	}

	fl.Description = "updated"
	if _, err := s.UpdateFlow("P", fl.ID, fl); err != nil {
		t.Fatal(err)
	}

	// deleting a stream scrubs its step from flows
	if err := s.DeleteStream("P", st2.ID); err != nil {
		t.Fatal(err)
	}
	flows, _ := s.ListFlows("P")
	if len(flows[0].Steps) != 1 || flows[0].Steps[0].StreamID != st1.ID {
		t.Fatalf("stream not scrubbed from flow: %+v", flows[0])
	}

	// deleting a need scrubs it from flows
	if err := s.DeleteNeed("P", need.ID); err != nil {
		t.Fatal(err)
	}
	flows, _ = s.ListFlows("P")
	if len(flows[0].BizNeedIDs) != 0 {
		t.Fatalf("need not scrubbed from flow: %+v", flows[0])
	}

	// deleting a system cascades streams, which scrub from flows
	if err := s.DeleteSystem("P", sysB.ID); err != nil {
		t.Fatal(err)
	}
	flows, _ = s.ListFlows("P")
	if len(flows[0].Steps) != 0 {
		t.Fatalf("cascaded stream not scrubbed from flow: %+v", flows[0])
	}

	if err := s.DeleteFlow("P", fl.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteFlow("P", fl.ID); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestLayout(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateProject("P", ""); err != nil {
		t.Fatal(err)
	}
	want := map[string]NodePos{"abc": {X: 10, Y: 20, Pinned: true}}
	if err := s.SaveLayout("P", want); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetLayout("P")
	if err != nil || got["abc"] != want["abc"] {
		t.Fatalf("layout roundtrip: %v %+v", err, got)
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

	p, err := s.GetProject("Old")
	if err != nil || p.SchemaVersion != CurrentSchema {
		t.Fatalf("schema not bumped: %v %+v", err, p)
	}

	systems, _ := s.ListSystems("Old")
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

	streams, _ := s.ListStreams("Old")
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
	systems2, _ := s2.ListSystems("Old")
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
			if _, err := s.CreateSystem("P", System{Name: "S", Type: "internal"}); err != nil {
				t.Error(err)
			}
			if _, err := s.ListSystems("P"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()

	got, err := s.ListSystems("P")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 50 {
		t.Fatalf("want 50 systems after concurrent writes, got %d", len(got))
	}
}
