package report

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"

	"spaghettimapper/internal/store"
)

// fixtureGraph is a small landscape exercising:
// - fields_mode list + all (coverage walk)
// - unjustified + justified moved fields
// - bare payload stream
// - Commerce → Billing cell count 2
// - zero clusters (Clusters sheet still present)
func fixtureGraph() store.Graph {
	return store.Graph{
		Project: store.Project{Name: "Fixture"},
		Needs: []store.BizNeed{
			{ID: "n1", Name: "Order Fulfillment", Description: "Ship orders"},
		},
		Systems: []store.System{
			{
				ID: "sys-billing", Name: "Billing", Type: "internal",
				Description: "Invoices",
				Entities: []store.Entity{{
					ID: "ent-inv", Name: "Invoice",
					Fields: []store.Field{
						{ID: "fld-inv-id", Name: "id", Type: "uuid"},
					},
				}},
			},
			{
				ID: "sys-commerce", Name: "Commerce", Type: "internal",
				Description: "Storefront",
				Entities: []store.Entity{{
					ID: "ent-so", Name: "SalesOrder",
					Fields: []store.Field{
						{ID: "fld-so-id", Name: "id", Type: "uuid", BizNeedIDs: []string{"n1"}},
						{ID: "fld-so-total", Name: "total", Type: "decimal", BizNeedIDs: []string{"n1"}},
						{ID: "fld-so-status", Name: "status", Type: "string"}, // unjustified
						{ID: "fld-so-lines", Name: "line_items"},             // untyped + unjustified
					},
				}},
			},
			{
				ID: "sys-crm", Name: "CRM", Type: "external", Entities: nil,
			},
		},
		Streams: []store.Stream{
			{
				ID: "s1", Name: "Sales Orders", BizNeedIDs: []string{"n1"},
				Timing: "real-time", APIType: "REST", DataFormat: "JSON",
				Direction: "uni", Status: "planned",
				Source: store.Endpoint{
					SystemID: "sys-commerce", EntityIDs: []string{"ent-so"},
					FieldsMode: "list", FieldIDs: []string{"fld-so-id", "fld-so-total", "fld-so-status", "fld-so-lines"},
				},
				Destination: store.Endpoint{
					SystemID: "sys-billing", EntityIDs: []string{"ent-inv"},
					FieldsMode: "all",
				},
			},
			{
				ID: "s2", Name: "Order Acknowledgement",
				Timing: "real-time", APIType: "REST", DataFormat: "JSON",
				Direction: "uni", Status: "implemented",
				Source:      store.Endpoint{SystemID: "sys-commerce", FieldsMode: "unknown"},
				Destination: store.Endpoint{SystemID: "sys-billing", FieldsMode: "unknown"},
			},
			{
				ID: "s3", Name: "Customer Sync",
				Timing: "scheduled", Direction: "bi", Status: "implemented",
				Source:      store.Endpoint{SystemID: "sys-commerce", FieldsMode: "unknown"},
				Destination: store.Endpoint{SystemID: "sys-crm", FieldsMode: "unknown"},
			},
		},
		Flows: []store.Flow{
			{ID: "f1", Name: "Order path", Steps: []store.FlowStep{{StreamID: "s1", Stage: 1}}},
		},
		Clusters: nil,
	}
}

func fixtureWithCluster() store.Graph {
	g := fixtureGraph()
	g.Clusters = []store.Cluster{{
		ID: "c1", Name: "Core", SystemIDs: []string{"sys-commerce", "sys-billing", "sys-gone"},
		BizNeedIDs: []string{"n1"}, Description: "Main estate",
	}}
	return g
}

func openWB(t *testing.T, g store.Graph, mapPNG MapPNG) *excelize.File {
	t.Helper()
	f, err := Workbook(g, Meta{Project: g.Project.Name, View: "Main", When: "2026-07-19"}, mapPNG)
	if err != nil {
		t.Fatalf("Workbook: %v", err)
	}
	return f
}

func TestSheetOrderAndHeaders(t *testing.T) {
	f := openWB(t, fixtureGraph(), "")
	defer f.Close()

	want := []string{
		"Overview", "Map", "Streams", "Systems",
		"Fields in motion", "Needs", "Clusters", "Matrix",
	}
	got := f.GetSheetList()
	if len(got) != len(want) {
		t.Fatalf("sheets: got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sheet[%d]=%q want %q (full %v)", i, got[i], want[i], got)
		}
	}
	if f.GetSheetName(f.GetActiveSheetIndex()) != "Overview" {
		t.Fatalf("active sheet = %q", f.GetSheetName(f.GetActiveSheetIndex()))
	}

	// exact headers
	checks := map[string][]string{
		"Streams": {
			"Stream", "Source system", "Destination system", "Direction",
			"Timing", "API type", "Data format", "Status", "Business needs",
			"Source payload", "Destination payload", "Description",
		},
		"Systems": {
			"System", "Type", "Entities (count)", "Fields (count)",
			"Fields typed (count)", "Fields justified (count)",
			"Streams out (count, source endpoint)", "Streams in (count, destination endpoint)",
			"Clusters", "Description",
		},
		"Fields in motion": {
			"System", "Entity", "Field", "Type", "Carried by", "Business needs", "Justified",
		},
		"Needs": {
			"Business need", "Streams serving it", "Flows serving it",
			"Clusters serving it", "Fields justified (count)", "Description",
		},
		"Clusters": {"Cluster", "Systems", "Business needs", "Description"},
	}
	for sheet, headers := range checks {
		for i, h := range headers {
			cell, _ := excelize.CoordinatesToCellName(i+1, 1)
			v, err := f.GetCellValue(sheet, cell)
			if err != nil || v != h {
				t.Errorf("%s %s: got %q want %q (%v)", sheet, cell, v, h, err)
			}
		}
	}
}

func TestStreamRowDirectionAndPayloads(t *testing.T) {
	f := openWB(t, fixtureGraph(), "")
	defer f.Close()

	// Streams ordered by source system A–Z, then stream name.
	// Billing is first source alphabetically? Sources: Commerce (s1,s2,s3) — all from Commerce.
	// Order: Customer Sync, Order Acknowledgement, Sales Orders.
	rows := map[string]int{}
	for r := 2; r <= 10; r++ {
		name, _ := f.GetCellValue("Streams", cell(1, r))
		if name == "" {
			break
		}
		rows[name] = r
	}
	if rows["Sales Orders"] == 0 || rows["Order Acknowledgement"] == 0 {
		t.Fatalf("missing stream rows: %v", rows)
	}

	// Sales Orders: one-way, source payload list, dest all
	r := rows["Sales Orders"]
	dir, _ := f.GetCellValue("Streams", cell(4, r))
	if dir != "one-way" {
		t.Errorf("Sales Orders direction = %q", dir)
	}
	srcP, _ := f.GetCellValue("Streams", cell(10, r))
	dstP, _ := f.GetCellValue("Streams", cell(11, r))
	if srcP != "1 entity · 4 fields" {
		t.Errorf("Sales Orders source payload = %q", srcP)
	}
	if dstP != "1 entity · all fields" {
		t.Errorf("Sales Orders dest payload = %q", dstP)
	}

	// Order Acknowledgement: both bare → payload not documented
	r = rows["Order Acknowledgement"]
	srcP, _ = f.GetCellValue("Streams", cell(10, r))
	dstP, _ = f.GetCellValue("Streams", cell(11, r))
	if srcP != "payload not documented" || dstP != "payload not documented" {
		t.Errorf("Ack payloads = %q / %q", srcP, dstP)
	}

	// Customer Sync: two-way
	r = rows["Customer Sync"]
	dir, _ = f.GetCellValue("Streams", cell(4, r))
	if dir != "two-way" {
		t.Errorf("Customer Sync direction = %q", dir)
	}
}

func TestCoverageNumbers(t *testing.T) {
	g := fixtureGraph()
	cov := analyze(g)
	// 4 Commerce fields + 1 Billing field = 5
	if cov.TotalFields != 5 {
		t.Fatalf("TotalFields=%d", cov.TotalFields)
	}
	// typed: so-id, so-total, so-status, inv-id = 4 (line_items untyped)
	if cov.TypedFields != 4 {
		t.Fatalf("TypedFields=%d", cov.TypedFields)
	}
	// justified: so-id, so-total = 2
	if cov.JustifiedFields != 2 {
		t.Fatalf("JustifiedFields=%d", cov.JustifiedFields)
	}
	// moved via list (4 commerce) + all on billing invoice id = 5 moved
	if len(cov.Moved) != 5 {
		t.Fatalf("Moved=%d %#v", len(cov.Moved), names(cov.Moved))
	}
	// systems with catalog: Commerce + Billing = 2 of 3
	if cov.SystemsWithCatalog != 2 {
		t.Fatalf("SystemsWithCatalog=%d", cov.SystemsWithCatalog)
	}
	// streams with needs: Sales Orders only
	if cov.StreamsWithNeeds != 1 {
		t.Fatalf("StreamsWithNeeds=%d", cov.StreamsWithNeeds)
	}

	f := openWB(t, g, "")
	defer f.Close()
	// Overview B values — scan labels
	want := map[string]string{
		"Systems":                       "3",
		"Streams":                       "3",
		"Business needs":                "1",
		"Flows":                         "1",
		"Clusters":                      "0",
		"Systems with a catalog":        "2 of 3",
		"Fields typed":                  "4 of 5",
		"Fields justified by a need":    "2 of 5",
		"Streams with a business need":  "1 of 3",
	}
	for r := 1; r <= 20; r++ {
		lab, _ := f.GetCellValue("Overview", cell(1, r))
		if lab == "" {
			continue
		}
		if w, ok := want[lab]; ok {
			v, _ := f.GetCellValue("Overview", cell(2, r))
			if v != w {
				t.Errorf("Overview %q = %q want %q", lab, v, w)
			}
			delete(want, lab)
		}
		// clusters-with-need row must be omitted when 0 clusters
		if lab == "Clusters with a business need" {
			t.Errorf("unexpected Clusters with a business need row")
		}
	}
	for lab := range want {
		t.Errorf("missing Overview row %q", lab)
	}
	// honesty line present
	found := false
	for r := 1; r <= 20; r++ {
		v, _ := f.GetCellValue("Overview", cell(1, r))
		if strings.Contains(v, "absent facts are gaps") {
			found = true
		}
	}
	if !found {
		t.Error("honesty line missing")
	}
}

func names(m []MovedField) []string {
	out := make([]string, len(m))
	for i, x := range m {
		out[i] = x.Fld.Name
	}
	return out
}

func TestFieldsInMotionOrderAndFill(t *testing.T) {
	f := openWB(t, fixtureGraph(), "")
	defer f.Close()

	// unjustified first: line_items, status (Commerce) then justified id, total; plus billing id
	var justCol []string
	var names []string
	for r := 2; r <= 20; r++ {
		nm, _ := f.GetCellValue("Fields in motion", cell(3, r))
		if nm == "" {
			break
		}
		j, _ := f.GetCellValue("Fields in motion", cell(7, r))
		names = append(names, nm)
		justCol = append(justCol, j)
	}
	if len(names) != 5 {
		t.Fatalf("rows=%v", names)
	}
	// first unjustified group, then justified
	seenYes := false
	for i, j := range justCol {
		if j == "yes" {
			seenYes = true
		}
		if j == "no" && seenYes {
			t.Fatalf("unjustified after justified at row %d: %v %v", i, names, justCol)
		}
	}

	// unjustified row has FDF3E3 fill; justified does not
	// find a "no" and a "yes" data row
	var noRow, yesRow int
	for r := 2; r <= 10; r++ {
		j, _ := f.GetCellValue("Fields in motion", cell(7, r))
		if j == "no" && noRow == 0 {
			noRow = r
		}
		if j == "yes" && yesRow == 0 {
			yesRow = r
		}
	}
	if noRow == 0 || yesRow == 0 {
		t.Fatalf("no=%d yes=%d", noRow, yesRow)
	}
	// Check fill via style — excelize GetCellStyle + GetStyle
	noStyle, _ := f.GetCellStyle("Fields in motion", cell(1, noRow))
	yesStyle, _ := f.GetCellStyle("Fields in motion", cell(1, yesRow))
	noSt, _ := f.GetStyle(noStyle)
	yesSt, _ := f.GetStyle(yesStyle)
	if noSt == nil || len(noSt.Fill.Color) == 0 || !strings.EqualFold(noSt.Fill.Color[0], fillFinding) {
		t.Errorf("unjustified fill: style=%+v", noSt)
	}
	if yesSt != nil && len(yesSt.Fill.Color) > 0 && strings.EqualFold(yesSt.Fill.Color[0], fillFinding) {
		t.Errorf("justified should not have finding fill: %+v", yesSt)
	}
}

func TestClustersSheetAlwaysPresent(t *testing.T) {
	f := openWB(t, fixtureGraph(), "")
	defer f.Close()
	// headers only, no data rows
	v, _ := f.GetCellValue("Clusters", "A1")
	if v != "Cluster" {
		t.Fatalf("A1=%q", v)
	}
	v2, _ := f.GetCellValue("Clusters", "A2")
	if v2 != "" {
		t.Fatalf("unexpected data row %q", v2)
	}

	// with cluster + deleted system id
	f2 := openWB(t, fixtureWithCluster(), "")
	defer f2.Close()
	sys, _ := f2.GetCellValue("Clusters", "B2")
	if !strings.Contains(sys, "(deleted)") {
		t.Errorf("systems=%q want (deleted)", sys)
	}
	if !strings.Contains(sys, "Commerce") || !strings.Contains(sys, "Billing") {
		t.Errorf("systems=%q", sys)
	}
}

func TestMatrixCellAndCaption(t *testing.T) {
	f := openWB(t, fixtureGraph(), "")
	defer f.Close()

	// systems A–Z: Billing, CRM, Commerce
	// head row B1=Billing C1=CRM D1=Commerce
	b1, _ := f.GetCellValue("Matrix", "B1")
	c1, _ := f.GetCellValue("Matrix", "C1")
	d1, _ := f.GetCellValue("Matrix", "D1")
	if b1 != "Billing" || c1 != "CRM" || d1 != "Commerce" {
		t.Fatalf("heads=%q %q %q", b1, c1, d1)
	}
	a1, _ := f.GetCellValue("Matrix", "A1")
	if a1 != `src \ dst` {
		t.Fatalf("A1=%q", a1)
	}

	// Commerce → Billing: Sales Orders + Order Ack = 2
	// Commerce is row 4 (A: Billing=2, CRM=3, Commerce=4), Billing col B
	val, _ := f.GetCellValue("Matrix", "B4")
	if val != "2" {
		t.Errorf("Commerce→Billing = %q want 2", val)
	}
	// heat fill for count 2 = FBE7C6
	stID, _ := f.GetCellStyle("Matrix", "B4")
	st, _ := f.GetStyle(stID)
	if st == nil || len(st.Fill.Color) == 0 || !strings.EqualFold(st.Fill.Color[0], fillHeat2) {
		t.Errorf("Commerce→Billing fill: %+v", st)
	}

	// caption: 3 streams · 2 connections · 2 one-way
	// pairs: commerce~billing (ab only if commerce<billing? ids: sys-billing, sys-commerce
	// s1,s2: commerce→billing; s3: commerce→crm
	// pairs: billing~commerce (one direction), commerce~crm (one direction) = 2 connections, both one-way
	// Find caption row
	var cap string
	for r := 1; r <= 20; r++ {
		v, _ := f.GetCellValue("Matrix", cell(1, r))
		if strings.Contains(v, "stream") && strings.Contains(v, "one-way") {
			cap = v
			break
		}
	}
	if cap != "3 streams · 2 connections · 2 one-way" {
		t.Errorf("caption=%q", cap)
	}
	if strings.Contains(cap, "one-ways") {
		t.Errorf("caption used one-ways: %q", cap)
	}
}

func TestMapGETFallbackAndPOSTPicture(t *testing.T) {
	// GET fallback
	f := openWB(t, fixtureGraph(), "")
	defer f.Close()
	a1, _ := f.GetCellValue("Map", "A1")
	if !strings.HasPrefix(a1, "Map — Fixture, 2026-07-19") {
		t.Errorf("A1=%q", a1)
	}
	a2, _ := f.GetCellValue("Map", "A2")
	if !strings.Contains(a2, "filters not applied") {
		t.Errorf("A2=%q", a2)
	}
	a4, _ := f.GetCellValue("Map", "A4")
	if !strings.Contains(a4, "Exported without a map image") {
		t.Errorf("A4=%q", a4)
	}

	// tiny 1×1 PNG
	// PNG 1x1 red pixel
	png := mustDecodePNG()
	b64 := base64.StdEncoding.EncodeToString(png)
	f2 := openWB(t, fixtureGraph(), MapPNG(b64))
	defer f2.Close()
	// picture present: GetPictures
	pics, err := f2.GetPictures("Map", "A4")
	if err != nil {
		t.Fatalf("GetPictures: %v", err)
	}
	if len(pics) == 0 {
		t.Fatal("expected picture at A4")
	}
	// no fallback note
	a4b, _ := f2.GetCellValue("Map", "A4")
	if strings.Contains(a4b, "Exported without") {
		t.Errorf("unexpected fallback with image: %q", a4b)
	}
}

// 1×1 transparent PNG (68 bytes).
func mustDecodePNG() []byte {
	const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		panic(err)
	}
	return b
}

func TestWorkbookBytesAreZip(t *testing.T) {
	f := openWB(t, fixtureGraph(), "")
	defer f.Close()
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	if buf.Len() < 2 || buf.Bytes()[0] != 'P' || buf.Bytes()[1] != 'K' {
		t.Fatalf("not a zip: %v", buf.Bytes()[:min(4, buf.Len())])
	}
}

func cell(col, row int) string {
	c, _ := excelize.CoordinatesToCellName(col, row)
	return c
}
