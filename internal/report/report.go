// Package report builds the integration-register .xlsx workbook from a
// project graph. Vocabulary and coverage numbers match the product's Analysis
// panel and inspector (DR-6 / AGENTS.md one-language rule).
package report

import (
	"bytes"
	"encoding/base64"
	"fmt"
	_ "image/png" // register PNG decoder for AddPictureFromBytes
	"sort"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"

	"spaghettimapper/internal/store"
)

// Meta is the project-level context written on Overview / Map.
// View is "My workspace" or "Main" (same signal as the history header).
type Meta struct {
	Project string
	View    string // "My workspace" | "Main"
	When    string // YYYY-MM-DD (server date, string — no date cell type)
}

// MapPNG is an optional base64-encoded PNG of the canvas (RG-4). Empty means
// the Map sheet gets the GET fallback note.
type MapPNG string

// Workbook builds the full integration register for g. mapPNG may be empty
// (GET / curl) or a base64 PNG (POST from the app).
func Workbook(g store.Graph, meta Meta, mapPNG MapPNG) (*excelize.File, error) {
	if meta.When == "" {
		meta.When = time.Now().UTC().Format("2006-01-02")
	}
	if meta.Project == "" {
		meta.Project = g.Project.Name
	}

	f := excelize.NewFile()
	// Build sheets in frozen tab order; remove default Sheet1 last.
	idx := buildIndex(g)
	cov := analyze(g)

	if err := writeOverview(f, g, meta, cov); err != nil {
		return nil, err
	}
	if err := writeMap(f, meta, mapPNG); err != nil {
		return nil, err
	}
	if err := writeStreams(f, g, idx); err != nil {
		return nil, err
	}
	if err := writeSystems(f, g, idx, cov); err != nil {
		return nil, err
	}
	if err := writeFieldsInMotion(f, g, idx, cov); err != nil {
		return nil, err
	}
	if err := writeNeeds(f, g, idx, cov); err != nil {
		return nil, err
	}
	if err := writeClusters(f, g, idx); err != nil {
		return nil, err
	}
	if err := writeMatrix(f, g); err != nil {
		return nil, err
	}

	// Active sheet = Overview; drop the default blank sheet.
	f.SetActiveSheet(0)
	_ = f.DeleteSheet("Sheet1")
	return f, nil
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const (
	fillHeader   = "EFEFEF"
	fillFinding  = "FDF3E3" // unjustified fields-in-motion row
	fillHeat1    = "FDF3E3"
	fillHeat2    = "FBE7C6"
	fillHeat3    = "F8DBA9"
	fillHeat4    = "F5CF8C"
)

func styleHeader(f *excelize.File) (int, error) {
	return f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{fillHeader}, Pattern: 1},
		Alignment: &excelize.Alignment{Vertical: "center"},
	})
}

func styleBold(f *excelize.File) (int, error) {
	return f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true},
	})
}

func styleFinding(f *excelize.File) (int, error) {
	return f.NewStyle(&excelize.Style{
		Fill: excelize.Fill{Type: "pattern", Color: []string{fillFinding}, Pattern: 1},
	})
}

func styleHeat(f *excelize.File, fill string) (int, error) {
	return f.NewStyle(&excelize.Style{
		Fill:      excelize.Fill{Type: "pattern", Color: []string{fill}, Pattern: 1},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center"},
	})
}

// ---------------------------------------------------------------------------
// name index / helpers
// ---------------------------------------------------------------------------

type nameIndex struct {
	sys  map[string]string
	need map[string]string
	flow map[string]string
	cl   map[string]string
	// field → {sys, ent, fld} for coverage walks
	field map[string]fieldRef
}

type fieldRef struct {
	sys store.System
	ent store.Entity
	fld store.Field
}

func buildIndex(g store.Graph) nameIndex {
	idx := nameIndex{
		sys:   map[string]string{},
		need:  map[string]string{},
		flow:  map[string]string{},
		cl:    map[string]string{},
		field: map[string]fieldRef{},
	}
	for _, s := range g.Systems {
		idx.sys[s.ID] = s.Name
		for _, e := range s.Entities {
			for _, f := range e.Fields {
				idx.field[f.ID] = fieldRef{sys: s, ent: e, fld: f}
			}
		}
	}
	for _, n := range g.Needs {
		idx.need[n.ID] = n.Name
	}
	for _, fl := range g.Flows {
		idx.flow[fl.ID] = fl.Name
	}
	for _, c := range g.Clusters {
		idx.cl[c.ID] = c.Name
	}
	return idx
}

func resolveNames(ids []string, m map[string]string) string {
	if len(ids) == 0 {
		return ""
	}
	names := make([]string, 0, len(ids))
	for _, id := range ids {
		if n, ok := m[id]; ok {
			names = append(names, n)
		} else {
			names = append(names, "(deleted)")
		}
	}
	return strings.Join(names, ", ")
}

func directionWord(d string) string {
	switch d {
	case "bi":
		return "two-way"
	case "uni":
		return "one-way"
	default:
		return d
	}
}

// plural matches web/js/ui.js plural() — DR-6 vocabulary.
func plural(n int, word, pluralWord string) string {
	if pluralWord == "" {
		pluralWord = word + "s"
	}
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %s", n, pluralWord)
}

// epBare is true when an endpoint has no documented payload (entity_ids empty
// and fields_mode neither "all" nor "list").
func epBare(ep store.Endpoint) bool {
	return len(ep.EntityIDs) == 0 && ep.FieldsMode != "all" && ep.FieldsMode != "list"
}

// epSummary is the DR-6 endpoint payload phrase (same as tooltip/inspector).
// Bare endpoints use the composed-sentence phrase "payload not documented".
func epSummary(ep store.Endpoint) string {
	if epBare(ep) {
		return "payload not documented"
	}
	entN := len(ep.EntityIDs)
	ent := plural(entN, "entity", "entities")
	switch ep.FieldsMode {
	case "all":
		return ent + " · all fields"
	case "list":
		return ent + " · " + plural(len(ep.FieldIDs), "field", "")
	default:
		return ent + " · fields not documented"
	}
}

func setHeaderRow(f *excelize.File, sheet string, headers []string, widths map[string]float64) error {
	hs, err := styleHeader(f)
	if err != nil {
		return err
	}
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		if err := f.SetCellValue(sheet, cell, h); err != nil {
			return err
		}
		if err := f.SetCellStyle(sheet, cell, cell, hs); err != nil {
			return err
		}
	}
	for col, w := range widths {
		if err := f.SetColWidth(sheet, col, col, w); err != nil {
			return err
		}
	}
	if err := f.SetPanes(sheet, &excelize.Panes{
		Freeze:      true,
		Split:       false,
		XSplit:      0,
		YSplit:      1,
		TopLeftCell: "A2",
		ActivePane:  "bottomLeft",
	}); err != nil {
		return err
	}
	return nil
}

func setAutoFilter(f *excelize.File, sheet string, lastCol, lastRow int) error {
	if lastRow < 1 {
		lastRow = 1
	}
	start, _ := excelize.CoordinatesToCellName(1, 1)
	end, _ := excelize.CoordinatesToCellName(lastCol, lastRow)
	return f.AutoFilter(sheet, start+":"+end, nil)
}

// renameDefault turns the current active sheet (Sheet1 on first call) into name,
// or creates a new sheet named name when Sheet1 is already taken.
func ensureSheet(f *excelize.File, name string, first bool) (string, error) {
	if first {
		if err := f.SetSheetName("Sheet1", name); err != nil {
			return "", err
		}
		return name, nil
	}
	if _, err := f.NewSheet(name); err != nil {
		return "", err
	}
	return name, nil
}

// ---------------------------------------------------------------------------
// analysis walk (mirrors web/js/analysis.js analyze())
// ---------------------------------------------------------------------------

// Coverage holds §3.1 overview numbers and §3.4 fields-in-motion rows.
type Coverage struct {
	TotalFields        int
	TypedFields        int
	JustifiedFields    int
	SystemsWithCatalog int
	StreamsWithNeeds   int
	ClustersWithNeeds  int
	TotalClusters      int
	Moved              []MovedField
}

// MovedField is one fields-in-motion row.
type MovedField struct {
	Sys      store.System
	Ent      store.Entity
	Fld      store.Field
	MovedBy  []store.Stream // deduped streams that carry this field
	Justified bool
}

func analyze(g store.Graph) Coverage {
	type row struct {
		sys     store.System
		ent     store.Entity
		fld     store.Field
		movedBy []store.Stream
	}
	rows := make([]*row, 0)
	byField := map[string]*row{}
	typed, justified := 0, 0

	for _, sys := range g.Systems {
		for _, ent := range sys.Entities {
			for _, fld := range ent.Fields {
				if fld.Type != "" {
					typed++
				}
				if len(fld.BizNeedIDs) > 0 {
					justified++
				}
				r := &row{sys: sys, ent: ent, fld: fld}
				rows = append(rows, r)
				byField[fld.ID] = r
			}
		}
	}

	sysByID := map[string]store.System{}
	for _, s := range g.Systems {
		sysByID[s.ID] = s
	}

	for _, st := range g.Streams {
		for _, ep := range []store.Endpoint{st.Source, st.Destination} {
			var ids []string
			switch ep.FieldsMode {
			case "list":
				ids = ep.FieldIDs
			case "all":
				sys, ok := sysByID[ep.SystemID]
				if !ok {
					break
				}
				entSet := map[string]bool{}
				for _, eid := range ep.EntityIDs {
					entSet[eid] = true
				}
				for _, e := range sys.Entities {
					if !entSet[e.ID] {
						continue
					}
					for _, f := range e.Fields {
						ids = append(ids, f.ID)
					}
				}
			}
			for _, id := range ids {
				r := byField[id]
				if r == nil {
					continue
				}
				// dedupe streams (same as JS !row.movedBy.includes(st))
				seen := false
				for _, s := range r.movedBy {
					if s.ID == st.ID {
						seen = true
						break
					}
				}
				if !seen {
					r.movedBy = append(r.movedBy, st)
				}
			}
		}
	}

	var moved []MovedField
	for _, r := range rows {
		if len(r.movedBy) == 0 {
			continue
		}
		moved = append(moved, MovedField{
			Sys:       r.sys,
			Ent:       r.ent,
			Fld:       r.fld,
			MovedBy:   r.movedBy,
			Justified: len(r.fld.BizNeedIDs) > 0,
		})
	}

	clustersWithNeeds := 0
	for _, c := range g.Clusters {
		if len(c.BizNeedIDs) > 0 {
			clustersWithNeeds++
		}
	}
	streamsWithNeeds := 0
	for _, st := range g.Streams {
		if len(st.BizNeedIDs) > 0 {
			streamsWithNeeds++
		}
	}
	systemsWithCatalog := 0
	for _, s := range g.Systems {
		if len(s.Entities) > 0 {
			systemsWithCatalog++
		}
	}

	return Coverage{
		TotalFields:        len(rows),
		TypedFields:        typed,
		JustifiedFields:    justified,
		SystemsWithCatalog: systemsWithCatalog,
		StreamsWithNeeds:   streamsWithNeeds,
		ClustersWithNeeds:  clustersWithNeeds,
		TotalClusters:      len(g.Clusters),
		Moved:              moved,
	}
}

// ---------------------------------------------------------------------------
// 3.1 Overview
// ---------------------------------------------------------------------------

func writeOverview(f *excelize.File, g store.Graph, meta Meta, cov Coverage) error {
	sheet, err := ensureSheet(f, "Overview", true)
	if err != nil {
		return err
	}
	hs, err := styleHeader(f)
	if err != nil {
		return err
	}
	// Overview has no header-row chrome; label column is regular, values plain.
	// Plan: freeze A2 still applies? "Freeze panes: top row on every sheet (A2);
	// Overview has no autofilter". Yes freeze top row even without a header bar.
	_ = hs

	rows := [][2]any{
		{"Project", meta.Project},
		{"Exported", meta.When},
		{"View", meta.View},
		{"Systems", len(g.Systems)},
		{"Streams", len(g.Streams)},
		{"Business needs", len(g.Needs)},
		{"Flows", len(g.Flows)},
		{"Clusters", len(g.Clusters)},
		{"Systems with a catalog", fmt.Sprintf("%d of %d", cov.SystemsWithCatalog, len(g.Systems))},
		{"Fields typed", fmt.Sprintf("%d of %d", cov.TypedFields, cov.TotalFields)},
		{"Fields justified by a need", fmt.Sprintf("%d of %d", cov.JustifiedFields, cov.TotalFields)},
		{"Streams with a business need", fmt.Sprintf("%d of %d", cov.StreamsWithNeeds, len(g.Streams))},
	}
	if cov.TotalClusters > 0 {
		rows = append(rows, [2]any{
			"Clusters with a business need",
			fmt.Sprintf("%d of %d", cov.ClustersWithNeeds, cov.TotalClusters),
		})
	}

	for i, r := range rows {
		row := i + 1
		if err := f.SetCellValue(sheet, fmt.Sprintf("A%d", row), r[0]); err != nil {
			return err
		}
		// counts as numeric; "a of b" and names as strings
		switch v := r[1].(type) {
		case int:
			if err := f.SetCellValue(sheet, fmt.Sprintf("B%d", row), v); err != nil {
				return err
			}
		default:
			if err := f.SetCellValue(sheet, fmt.Sprintf("B%d", row), v); err != nil {
				return err
			}
		}
	}
	// blank row + honesty line
	honestRow := len(rows) + 2
	const honesty = "Conclusions in this workbook only cover what's documented — absent facts are gaps, not truths."
	if err := f.SetCellValue(sheet, fmt.Sprintf("A%d", honestRow), honesty); err != nil {
		return err
	}
	if err := f.SetColWidth(sheet, "A", "A", 32); err != nil {
		return err
	}
	if err := f.SetColWidth(sheet, "B", "B", 40); err != nil {
		return err
	}
	return f.SetPanes(sheet, &excelize.Panes{
		Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft",
	})
}

// ---------------------------------------------------------------------------
// 3.8 Map
// ---------------------------------------------------------------------------

func writeMap(f *excelize.File, meta Meta, mapPNG MapPNG) error {
	sheet, err := ensureSheet(f, "Map", false)
	if err != nil {
		return err
	}
	bs, err := styleBold(f)
	if err != nil {
		return err
	}
	a1 := fmt.Sprintf("Map — %s, %s", meta.Project, meta.When)
	if err := f.SetCellValue(sheet, "A1", a1); err != nil {
		return err
	}
	if err := f.SetCellStyle(sheet, "A1", "A1", bs); err != nil {
		return err
	}
	a2 := "Full project layout at export time (filters not applied). The Streams sheet is the authoritative register."
	if err := f.SetCellValue(sheet, "A2", a2); err != nil {
		return err
	}
	if err := f.SetColWidth(sheet, "A", "A", 48); err != nil {
		return err
	}

	raw := strings.TrimSpace(string(mapPNG))
	if raw == "" {
		return f.SetCellValue(sheet, "A4",
			"Exported without a map image — export from the app to include one.")
	}
	// Accept raw base64 or data URL.
	if i := strings.Index(raw, ","); i >= 0 && strings.HasPrefix(raw, "data:") {
		raw = raw[i+1:]
	}
	png, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		// malformed — fall back to note rather than failing the whole workbook
		return f.SetCellValue(sheet, "A4",
			"Exported without a map image — export from the app to include one.")
	}
	// Probe natural width via image config if possible; excelize scales from
	// picture options. Default assume 1920 if unknown so Scale ≈ 0.5.
	scale := 0.5
	if cfg, nerr := imageConfig(png); nerr == nil && cfg.Width > 0 {
		scale = 960.0 / float64(cfg.Width)
	}
	// Write to a temp buffer path via AddPictureFromBytes.
	return f.AddPictureFromBytes(sheet, "A4", &excelize.Picture{
		Extension: ".png",
		File:      png,
		Format: &excelize.GraphicOptions{
			ScaleX: scale,
			ScaleY: scale,
		},
	})
}

// imageConfig reads PNG IHDR for width (no full decode dependency beyond stdlib).
func imageConfig(png []byte) (struct{ Width, Height int }, error) {
	var out struct{ Width, Height int }
	// PNG signature + IHDR: width at bytes 16-19, height 20-23 big-endian
	if len(png) < 24 || !bytes.Equal(png[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		return out, fmt.Errorf("not a png")
	}
	out.Width = int(png[16])<<24 | int(png[17])<<16 | int(png[18])<<8 | int(png[19])
	out.Height = int(png[20])<<24 | int(png[21])<<16 | int(png[22])<<8 | int(png[23])
	return out, nil
}

// ---------------------------------------------------------------------------
// 3.2 Streams
// ---------------------------------------------------------------------------

func writeStreams(f *excelize.File, g store.Graph, idx nameIndex) error {
	sheet, err := ensureSheet(f, "Streams", false)
	if err != nil {
		return err
	}
	headers := []string{
		"Stream", "Source system", "Destination system", "Direction",
		"Timing", "API type", "Data format", "Status", "Business needs",
		"Source payload", "Destination payload", "Description",
	}
	widths := map[string]float64{
		"A": 24, "B": 24, "C": 24, "D": 12, "E": 12, "F": 12, "G": 12, "H": 12,
		"I": 24, "J": 28, "K": 28, "L": 48,
	}
	if err := setHeaderRow(f, sheet, headers, widths); err != nil {
		return err
	}

	streams := append([]store.Stream(nil), g.Streams...)
	sort.Slice(streams, func(i, j int) bool {
		si := idx.sys[streams[i].Source.SystemID]
		sj := idx.sys[streams[j].Source.SystemID]
		if si != sj {
			return si < sj
		}
		return streams[i].Name < streams[j].Name
	})

	for i, st := range streams {
		row := i + 2
		srcName := idx.sys[st.Source.SystemID]
		if srcName == "" {
			srcName = "(deleted)"
		}
		dstName := idx.sys[st.Destination.SystemID]
		if dstName == "" {
			dstName = "(deleted)"
		}
		vals := []any{
			st.Name,
			srcName,
			dstName,
			directionWord(st.Direction),
			st.Timing,
			st.APIType,
			st.DataFormat,
			st.Status,
			resolveNames(st.BizNeedIDs, idx.need),
			epSummary(st.Source),
			epSummary(st.Destination),
			"", // Stream has no Description field in store — always empty
		}
		for c, v := range vals {
			cell, _ := excelize.CoordinatesToCellName(c+1, row)
			if err := f.SetCellValue(sheet, cell, v); err != nil {
				return err
			}
		}
	}
	return setAutoFilter(f, sheet, len(headers), len(streams)+1)
}

// ---------------------------------------------------------------------------
// 3.3 Systems
// ---------------------------------------------------------------------------

func writeSystems(f *excelize.File, g store.Graph, idx nameIndex, cov Coverage) error {
	sheet, err := ensureSheet(f, "Systems", false)
	if err != nil {
		return err
	}
	headers := []string{
		"System", "Type", "Entities (count)", "Fields (count)",
		"Fields typed (count)", "Fields justified (count)",
		"Streams out (count, source endpoint)", "Streams in (count, destination endpoint)",
		"Clusters", "Description",
	}
	widths := map[string]float64{
		"A": 24, "B": 12, "C": 12, "D": 12, "E": 12, "F": 12, "G": 12, "H": 12,
		"I": 24, "J": 48,
	}
	if err := setHeaderRow(f, sheet, headers, widths); err != nil {
		return err
	}

	// Precompute stream in/out and cluster membership.
	outN := map[string]int{}
	inN := map[string]int{}
	for _, st := range g.Streams {
		outN[st.Source.SystemID]++
		inN[st.Destination.SystemID]++
	}
	clusterOf := map[string][]string{} // sysID → cluster names
	for _, c := range g.Clusters {
		for _, sid := range c.SystemIDs {
			clusterOf[sid] = append(clusterOf[sid], c.Name)
		}
	}
	for sid := range clusterOf {
		sort.Strings(clusterOf[sid])
	}

	// Per-system field stats from the full walk (all fields, not only moved).
	type stats struct{ fields, typed, justified int }
	stBySys := map[string]*stats{}
	for _, sys := range g.Systems {
		stBySys[sys.ID] = &stats{}
		for _, ent := range sys.Entities {
			for _, fld := range ent.Fields {
				s := stBySys[sys.ID]
				s.fields++
				if fld.Type != "" {
					s.typed++
				}
				if len(fld.BizNeedIDs) > 0 {
					s.justified++
				}
			}
		}
	}

	systems := append([]store.System(nil), g.Systems...)
	sort.Slice(systems, func(i, j int) bool { return systems[i].Name < systems[j].Name })

	for i, sys := range systems {
		row := i + 2
		s := stBySys[sys.ID]
		if s == nil {
			s = &stats{}
		}
		typ := sys.Type
		if typ == "" {
			typ = "unknown"
		}
		vals := []any{
			sys.Name,
			typ,
			len(sys.Entities),
			s.fields,
			s.typed,
			s.justified,
			outN[sys.ID],
			inN[sys.ID],
			strings.Join(clusterOf[sys.ID], ", "),
			sys.Description,
		}
		for c, v := range vals {
			cell, _ := excelize.CoordinatesToCellName(c+1, row)
			if err := f.SetCellValue(sheet, cell, v); err != nil {
				return err
			}
		}
	}
	return setAutoFilter(f, sheet, len(headers), len(systems)+1)
}

// ---------------------------------------------------------------------------
// 3.4 Fields in motion
// ---------------------------------------------------------------------------

func writeFieldsInMotion(f *excelize.File, g store.Graph, idx nameIndex, cov Coverage) error {
	sheet, err := ensureSheet(f, "Fields in motion", false)
	if err != nil {
		return err
	}
	headers := []string{
		"System", "Entity", "Field", "Type", "Carried by", "Business needs", "Justified",
	}
	widths := map[string]float64{
		"A": 24, "B": 24, "C": 24, "D": 12, "E": 24, "F": 24, "G": 12,
	}
	if err := setHeaderRow(f, sheet, headers, widths); err != nil {
		return err
	}
	fs, err := styleFinding(f)
	if err != nil {
		return err
	}

	// unjustified first, then justified; each group by system, entity, field name
	moved := append([]MovedField(nil), cov.Moved...)
	sort.SliceStable(moved, func(i, j int) bool {
		if moved[i].Justified != moved[j].Justified {
			return !moved[i].Justified && moved[j].Justified // unjustified first
		}
		if moved[i].Sys.Name != moved[j].Sys.Name {
			return moved[i].Sys.Name < moved[j].Sys.Name
		}
		if moved[i].Ent.Name != moved[j].Ent.Name {
			return moved[i].Ent.Name < moved[j].Ent.Name
		}
		return moved[i].Fld.Name < moved[j].Fld.Name
	})

	for i, m := range moved {
		row := i + 2
		streamNames := make([]string, 0, len(m.MovedBy))
		for _, st := range m.MovedBy {
			streamNames = append(streamNames, st.Name)
		}
		sort.Strings(streamNames)
		just := "no"
		if m.Justified {
			just = "yes"
		}
		vals := []any{
			m.Sys.Name,
			m.Ent.Name,
			m.Fld.Name,
			m.Fld.Type,
			strings.Join(streamNames, ", "),
			resolveNames(m.Fld.BizNeedIDs, idx.need),
			just,
		}
		for c, v := range vals {
			cell, _ := excelize.CoordinatesToCellName(c+1, row)
			if err := f.SetCellValue(sheet, cell, v); err != nil {
				return err
			}
			if !m.Justified {
				if err := f.SetCellStyle(sheet, cell, cell, fs); err != nil {
					return err
				}
			}
		}
	}
	return setAutoFilter(f, sheet, len(headers), len(moved)+1)
}

// ---------------------------------------------------------------------------
// 3.5 Needs
// ---------------------------------------------------------------------------

func writeNeeds(f *excelize.File, g store.Graph, idx nameIndex, cov Coverage) error {
	sheet, err := ensureSheet(f, "Needs", false)
	if err != nil {
		return err
	}
	headers := []string{
		"Business need", "Streams serving it", "Flows serving it",
		"Clusters serving it", "Fields justified (count)", "Description",
	}
	widths := map[string]float64{
		"A": 24, "B": 24, "C": 24, "D": 24, "E": 12, "F": 48,
	}
	if err := setHeaderRow(f, sheet, headers, widths); err != nil {
		return err
	}

	// reverse indexes
	streamsByNeed := map[string][]string{}
	for _, st := range g.Streams {
		for _, nid := range st.BizNeedIDs {
			streamsByNeed[nid] = append(streamsByNeed[nid], st.Name)
		}
	}
	flowsByNeed := map[string][]string{}
	for _, fl := range g.Flows {
		for _, nid := range fl.BizNeedIDs {
			flowsByNeed[nid] = append(flowsByNeed[nid], fl.Name)
		}
	}
	clustersByNeed := map[string][]string{}
	for _, c := range g.Clusters {
		for _, nid := range c.BizNeedIDs {
			clustersByNeed[nid] = append(clustersByNeed[nid], c.Name)
		}
	}
	fieldsByNeed := map[string]int{}
	for _, sys := range g.Systems {
		for _, ent := range sys.Entities {
			for _, fld := range ent.Fields {
				for _, nid := range fld.BizNeedIDs {
					fieldsByNeed[nid]++
				}
			}
		}
	}
	for k := range streamsByNeed {
		sort.Strings(streamsByNeed[k])
	}
	for k := range flowsByNeed {
		sort.Strings(flowsByNeed[k])
	}
	for k := range clustersByNeed {
		sort.Strings(clustersByNeed[k])
	}

	needs := append([]store.BizNeed(nil), g.Needs...)
	sort.Slice(needs, func(i, j int) bool { return needs[i].Name < needs[j].Name })

	for i, n := range needs {
		row := i + 2
		vals := []any{
			n.Name,
			strings.Join(streamsByNeed[n.ID], ", "),
			strings.Join(flowsByNeed[n.ID], ", "),
			strings.Join(clustersByNeed[n.ID], ", "),
			fieldsByNeed[n.ID],
			n.Description,
		}
		for c, v := range vals {
			cell, _ := excelize.CoordinatesToCellName(c+1, row)
			if err := f.SetCellValue(sheet, cell, v); err != nil {
				return err
			}
		}
	}
	return setAutoFilter(f, sheet, len(headers), len(needs)+1)
}

// ---------------------------------------------------------------------------
// 3.6 Clusters
// ---------------------------------------------------------------------------

func writeClusters(f *excelize.File, g store.Graph, idx nameIndex) error {
	sheet, err := ensureSheet(f, "Clusters", false)
	if err != nil {
		return err
	}
	headers := []string{"Cluster", "Systems", "Business needs", "Description"}
	widths := map[string]float64{"A": 24, "B": 24, "C": 24, "D": 48}
	if err := setHeaderRow(f, sheet, headers, widths); err != nil {
		return err
	}

	clusters := append([]store.Cluster(nil), g.Clusters...)
	sort.Slice(clusters, func(i, j int) bool { return clusters[i].Name < clusters[j].Name })

	for i, c := range clusters {
		row := i + 2
		vals := []any{
			c.Name,
			resolveNames(c.SystemIDs, idx.sys),
			resolveNames(c.BizNeedIDs, idx.need),
			c.Description,
		}
		for col, v := range vals {
			cell, _ := excelize.CoordinatesToCellName(col+1, row)
			if err := f.SetCellValue(sheet, cell, v); err != nil {
				return err
			}
		}
	}
	return setAutoFilter(f, sheet, len(headers), max(1, len(clusters))+1)
}

// ---------------------------------------------------------------------------
// 3.7 Matrix
// ---------------------------------------------------------------------------

func writeMatrix(f *excelize.File, g store.Graph) error {
	sheet, err := ensureSheet(f, "Matrix", false)
	if err != nil {
		return err
	}
	hs, err := styleHeader(f)
	if err != nil {
		return err
	}
	// Pre-build heat styles
	heatStyles := map[int]int{}
	for n, fill := range map[int]string{1: fillHeat1, 2: fillHeat2, 3: fillHeat3, 4: fillHeat4} {
		sid, err := styleHeat(f, fill)
		if err != nil {
			return err
		}
		heatStyles[n] = sid
	}

	systems := append([]store.System(nil), g.Systems...)
	sort.Slice(systems, func(i, j int) bool { return systems[i].Name < systems[j].Name })
	n := len(systems)

	// cell counts: srcID>dstID → count
	counts := map[string]int{}
	totalStreams := 0
	for _, st := range g.Streams {
		k := st.Source.SystemID + ">" + st.Destination.SystemID
		counts[k]++
		totalStreams++
	}

	// A1 corner
	if err := f.SetCellValue(sheet, "A1", `src \ dst`); err != nil {
		return err
	}
	if err := f.SetCellStyle(sheet, "A1", "A1", hs); err != nil {
		return err
	}

	// head row + head column
	for i, s := range systems {
		// column head (row 1)
		cell, _ := excelize.CoordinatesToCellName(i+2, 1)
		if err := f.SetCellValue(sheet, cell, s.Name); err != nil {
			return err
		}
		if err := f.SetCellStyle(sheet, cell, cell, hs); err != nil {
			return err
		}
		// row head (col A)
		rCell, _ := excelize.CoordinatesToCellName(1, i+2)
		if err := f.SetCellValue(sheet, rCell, s.Name); err != nil {
			return err
		}
		if err := f.SetCellStyle(sheet, rCell, rCell, hs); err != nil {
			return err
		}
	}

	// data cells + pair tracking for caption
	type pairFlags struct{ ab, ba bool }
	pairs := map[string]*pairFlags{} // a~b (a<=b lexicographically by id)

	for ri, src := range systems {
		for ci, dst := range systems {
			c := counts[src.ID+">"+dst.ID]
			cell, _ := excelize.CoordinatesToCellName(ci+2, ri+2)
			if c > 0 {
				if err := f.SetCellValue(sheet, cell, c); err != nil {
					return err
				}
				heatN := c
				if heatN > 4 {
					heatN = 4
				}
				if err := f.SetCellStyle(sheet, cell, cell, heatStyles[heatN]); err != nil {
					return err
				}
				// undirected pair key
				a, b := src.ID, dst.ID
				k := a + "~" + b
				if a > b {
					k = b + "~" + a
				}
				p := pairs[k]
				if p == nil {
					p = &pairFlags{}
					pairs[k] = p
				}
				if a != b {
					if a < b {
						p.ab = true
					} else {
						p.ba = true
					}
				}
			}
		}
	}

	oneWay := 0
	for k, p := range pairs {
		parts := strings.SplitN(k, "~", 2)
		if len(parts) != 2 || parts[0] == parts[1] {
			continue
		}
		if (p.ab && !p.ba) || (!p.ab && p.ba) {
			oneWay++
		}
	}

	// caption below grid: blank row then A
	capRow := n + 3 // header is 1, data 2..n+1, blank n+2, caption n+3
	// "7 streams · 5 connections · 4 one-way" — one-way never takes an s
	cap := fmt.Sprintf("%s · %s · %d one-way",
		plural(totalStreams, "stream", ""),
		plural(len(pairs), "connection", ""),
		oneWay)
	if err := f.SetCellValue(sheet, fmt.Sprintf("A%d", capRow), cap); err != nil {
		return err
	}

	if err := f.SetColWidth(sheet, "A", "A", 24); err != nil {
		return err
	}
	if n > 0 {
		first, _ := excelize.CoordinatesToCellName(2, 1)
		last, _ := excelize.CoordinatesToCellName(n+1, 1)
		// first/last are cell names; SetColWidth wants col letters
		fc, _, _ := excelize.CellNameToCoordinates(first)
		lc, _, _ := excelize.CellNameToCoordinates(last)
		start, _ := excelize.ColumnNumberToName(fc)
		end, _ := excelize.ColumnNumberToName(lc)
		if err := f.SetColWidth(sheet, start, end, 6); err != nil {
			return err
		}
	}

	// Freeze panes at B2
	return f.SetPanes(sheet, &excelize.Panes{
		Freeze: true, XSplit: 1, YSplit: 1, TopLeftCell: "B2", ActivePane: "bottomRight",
	})
}

// MaxMapPNGBytes is the POST body size guard (decoded base64 of map_png).
const MaxMapPNGBytes = 4 * 1024 * 1024
