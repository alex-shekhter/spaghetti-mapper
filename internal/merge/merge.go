// Package merge implements SpaghettiMapper's domain-aware 3-way merge of a
// branch into main. Because the data is ID-keyed JSON, we merge per entity
// instead of per text line: disjoint edits never conflict, and a real
// disagreement (both sides changed the same entity) becomes a structured
// conflict the UI can render as "keep main / keep architect".
//
// Hard conflicts (entity edits, project metadata) block the merge until the
// caller supplies resolutions. Soft conflicts (canvas layout, display prefs)
// never block — main wins and a note is returned for a non-disruptive toast.
package merge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"spaghettimapper/internal/store"
)

// Conflict is a hard conflict: both sides changed the same thing. Ours/Theirs
// are the JSON of each side's version (nil when that side deleted it). The
// caller resolves by setting Resolutions["file:id"] = "ours" | "theirs".
type Conflict struct {
	File   string          `json:"file"`
	ID     string          `json:"id"`
	Kind   string          `json:"kind"` // "edit" | "add" | "delete"
	Ours   json.RawMessage `json:"ours,omitempty"`
	Theirs json.RawMessage `json:"theirs,omitempty"`
}

// SoftNote is a non-blocking clash (e.g. both architects dragged the same
// node); main wins and the UI shows this as a dismissable hint.
type SoftNote struct {
	File   string `json:"file"`
	ID     string `json:"id"`
	Detail string `json:"detail"`
}

// Outcome is the result of merging all files.
type Outcome struct {
	Files     map[string][]byte // merged file contents to write to main
	Conflicts []Conflict        // hard conflicts (block if unresolved)
	Soft      []SoftNote        // non-blocking notes
}

// ResolutionKey is the per-conflict key: "file:id".
func ResolutionKey(file, id string) string { return file + ":" + id }

// Merge combines base (merge-base), ours (main), and theirs (the branch) file
// contents. Resolutions maps "file:id" → "ours"|"theirs" for conflicts the
// caller already chose. The seven project files are merged with type-aware
// rules; any other file is merged last-write-wins by theirs (none expected).
func Merge(base, ours, theirs map[string][]byte, resolutions map[string]string) (Outcome, error) {
	if resolutions == nil {
		resolutions = map[string]string{}
	}
	out := Outcome{Files: map[string][]byte{}}

	// Entity collections: union by ID.
	type ent struct {
		file  string
		empty []byte
		idOf  func(any) string
	}
	// We handle each entity type explicitly to get typed IDs without reflection.
	entityFiles := []struct {
		name  string
		merge func() ([]byte, []Conflict, error)
	}{
		{store.SystemsFile, func() ([]byte, []Conflict, error) {
			return entities[store.System](store.SystemsFile, base, ours, theirs, resolutions, func(s store.System) string { return s.ID })
		}},
		{store.StreamsFile, func() ([]byte, []Conflict, error) {
			return entities[store.Stream](store.StreamsFile, base, ours, theirs, resolutions, func(s store.Stream) string { return s.ID })
		}},
		{store.NeedsFile, func() ([]byte, []Conflict, error) {
			return entities[store.BizNeed](store.NeedsFile, base, ours, theirs, resolutions, func(s store.BizNeed) string { return s.ID })
		}},
		{store.FlowsFile, func() ([]byte, []Conflict, error) {
			return entities[store.Flow](store.FlowsFile, base, ours, theirs, resolutions, func(s store.Flow) string { return s.ID })
		}},
		{store.ClustersFile, func() ([]byte, []Conflict, error) {
			return entities[store.Cluster](store.ClustersFile, base, ours, theirs, resolutions, func(c store.Cluster) string { return c.ID })
		}},
	}
	for _, ef := range entityFiles {
		merged, conf, err := ef.merge()
		if err != nil {
			return Outcome{}, fmt.Errorf("%s: %w", ef.name, err)
		}
		out.Files[ef.name] = merged
		out.Conflicts = append(out.Conflicts, conf...)
	}

	// project.json: single object, only Description is user-editable.
	pj, pconf, err := mergeProject(base, ours, theirs, resolutions)
	if err != nil {
		return Outcome{}, err
	}
	out.Files[store.ProjectFile] = pj
	out.Conflicts = append(out.Conflicts, pconf...)

	// layout.json: union by node id, soft on clash (main wins).
	lj, lsoft, err := mergeLayout(base, ours, theirs)
	if err != nil {
		return Outcome{}, err
	}
	out.Files[store.LayoutFile] = lj
	out.Soft = append(out.Soft, lsoft...)

	// display.json: scalar prefs, soft on clash (main wins).
	dj, dsoft, err := mergeDisplay(base, ours, theirs)
	if err != nil {
		return Outcome{}, err
	}
	out.Files[store.DisplayFile] = dj
	out.Soft = append(out.Soft, dsoft...)

	return out, nil
}

// ---- entity collection merge ----

func entities[T any](file string, base, ours, theirs map[string][]byte, res map[string]string, idOf func(T) string) ([]byte, []Conflict, error) {
	b, err := parseList[T](base[file])
	if err != nil {
		return nil, nil, err
	}
	o, err := parseList[T](ours[file])
	if err != nil {
		return nil, nil, err
	}
	t, err := parseList[T](theirs[file])
	if err != nil {
		return nil, nil, err
	}
	type side struct {
		items map[string]T
		set   map[string]bool
	}
	idx := func(xs []T) side {
		s := side{items: map[string]T{}, set: map[string]bool{}}
		for _, x := range xs {
			id := idOf(x)
			s.items[id] = x
			s.set[id] = true
		}
		return s
	}
	bs, os_, ts := idx(b), idx(o), idx(t)

	all := map[string]bool{}
	for m := range []map[string]bool{bs.set, os_.set, ts.set} {
		_ = m
	}
	for _, m := range []map[string]bool{bs.set, os_.set, ts.set} {
		for id := range m {
			all[id] = true
		}
	}

	var out []T
	var conflicts []Conflict
	ids := make([]string, 0, len(all))
	for id := range all {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, id := range ids {
		ob, oo, ot := bs.set[id], os_.set[id], ts.set[id]
		var bT, oT, tT T
		if ob {
			bT = bs.items[id]
		}
		if oo {
			oT = os_.items[id]
		}
		if ot {
			tT = ts.items[id]
		}
		oBytes, tBytes, bBytes := marshal(oT), marshal(tT), marshal(bT)
		_ = bBytes

		// Explicit resolution wins.
		switch res[ResolutionKey(file, id)] {
		case "ours":
			if oo {
				out = append(out, oT)
			}
			continue
		case "theirs":
			if ot {
				out = append(out, tT)
			}
			continue
		}

		switch {
		case !ob && !oo && !ot:
			// nothing
		case !ob && oo && !ot:
			out = append(out, oT) // ours added
		case !ob && !oo && ot:
			out = append(out, tT) // theirs added
		case !ob && oo && ot:
			if bytes.Equal(oBytes, tBytes) {
				out = append(out, oT)
			} else {
				conflicts = append(conflicts, Conflict{file, id, "add", oBytes, tBytes})
				out = append(out, oT) // default: ours
			}
		case ob && !oo && !ot:
			// both deleted → omit
		case ob && oo && !ot:
			// theirs deleted
			if bytes.Equal(oBytes, bBytes) {
				// ours unchanged → deletion wins
			} else {
				conflicts = append(conflicts, Conflict{file, id, "delete", oBytes, nil})
				out = append(out, oT) // default: keep ours
			}
		case ob && !oo && ot:
			// ours deleted
			if bytes.Equal(tBytes, bBytes) {
				// theirs unchanged → deletion wins
			} else {
				conflicts = append(conflicts, Conflict{file, id, "delete", nil, tBytes})
				out = append(out, tT) // default: keep theirs (preserve work)
			}
		case ob && oo && ot:
			switch {
			case bytes.Equal(oBytes, tBytes):
				out = append(out, oT)
			case bytes.Equal(oBytes, bBytes):
				out = append(out, tT) // ours unchanged → take theirs
			case bytes.Equal(tBytes, bBytes):
				out = append(out, oT) // theirs unchanged → take ours
			default:
				conflicts = append(conflicts, Conflict{file, id, "edit", oBytes, tBytes})
				out = append(out, oT) // default: ours
			}
		}
	}

	if out == nil {
		out = []T{}
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return data, conflicts, nil
}

func parseList[T any](raw []byte) ([]T, error) {
	if len(raw) == 0 {
		return []T{}, nil
	}
	var xs []T
	if err := json.Unmarshal(raw, &xs); err != nil {
		return nil, err
	}
	if xs == nil {
		xs = []T{}
	}
	return xs, nil
}

// unmarshalInto decodes raw into v if non-empty; a missing file leaves v at
// its zero value (each side may legitimately lack a file, e.g. a brand-new
// branch that hasn't touched layout.json).
func unmarshalInto(raw []byte, v any) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, v)
}

func marshal[T any](v T) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

// ---- project.json ----

func mergeProject(base, ours, theirs map[string][]byte, res map[string]string) ([]byte, []Conflict, error) {
	var b, o, t store.Project
	_ = unmarshalInto(base[store.ProjectFile], &b)
	if err := unmarshalInto(ours[store.ProjectFile], &o); err != nil {
		return nil, nil, err
	}
	if err := unmarshalInto(theirs[store.ProjectFile], &t); err != nil {
		return nil, nil, err
	}

	var conflicts []Conflict
	merged := o // main is the authority on name/schema/created; description merges
	merged.UpdatedAt = time.Now().UTC()
	switch {
	case o.Description == t.Description:
		// no clash
	case o.Description == b.Description:
		merged.Description = t.Description // main unchanged → take branch
	case t.Description == b.Description:
		// branch unchanged → keep main
	default:
		key := ResolutionKey(store.ProjectFile, "project")
		if res[key] == "theirs" {
			merged.Description = t.Description
		} else {
			if res[key] != "ours" {
				conflicts = append(conflicts, Conflict{store.ProjectFile, "project", "edit", jsonRaw(o.Description), jsonRaw(t.Description)})
			}
			// default ours (already merged.Description = o.Description)
		}
	}
	data, err := json.MarshalIndent(merged, "", "  ")
	return data, conflicts, err
}

// ---- layout.json (soft) ----

func mergeLayout(base, ours, theirs map[string][]byte) ([]byte, []SoftNote, error) {
	var b, o, t map[string]store.NodePos
	_ = unmarshalInto(base[store.LayoutFile], &b)
	if err := unmarshalInto(ours[store.LayoutFile], &o); err != nil {
		return nil, nil, err
	}
	if err := unmarshalInto(theirs[store.LayoutFile], &t); err != nil {
		return nil, nil, err
	}
	if b == nil {
		b = map[string]store.NodePos{}
	}
	if o == nil {
		o = map[string]store.NodePos{}
	}
	if t == nil {
		t = map[string]store.NodePos{}
	}
	all := map[string]bool{}
	for _, m := range []map[string]store.NodePos{b, o, t} {
		for k := range m {
			all[k] = true
		}
	}
	out := map[string]store.NodePos{}
	var soft []SoftNote
	for k := range all {
		ob, oo, ot := hasKey(b, k), hasKey(o, k), hasKey(t, k)
		switch {
		case oo && !ot:
			out[k] = o[k]
		case !oo && ot:
			out[k] = t[k]
		case oo && ot:
			if equalNode(o[k], t[k]) {
				out[k] = o[k]
			} else if equalNode(o[k], b[k]) { // main unchanged
				out[k] = t[k]
			} else if equalNode(t[k], b[k]) { // branch unchanged
				out[k] = o[k]
			} else {
				out[k] = o[k] // main wins; soft note
				soft = append(soft, SoftNote{store.LayoutFile, k, "both moved this node — kept main's position"})
			}
		case !oo && !ot && ob:
			// both deleted → omit
		}
	}
	data, err := json.MarshalIndent(out, "", "  ")
	return data, soft, err
}

func hasKey(m map[string]store.NodePos, k string) bool { _, ok := m[k]; return ok }
func equalNode(a, b store.NodePos) bool                { return a == b }

// ---- display.json (soft) ----

func mergeDisplay(base, ours, theirs map[string][]byte) ([]byte, []SoftNote, error) {
	var b, o, t store.Display
	_ = unmarshalInto(base[store.DisplayFile], &b)
	if err := unmarshalInto(ours[store.DisplayFile], &o); err != nil {
		return nil, nil, err
	}
	if err := unmarshalInto(theirs[store.DisplayFile], &t); err != nil {
		return nil, nil, err
	}
	merged := o
	var soft []SoftNote
	// Field-by-field: if both changed and differ, main wins + soft note.
	if o.Expand != t.Expand {
		if o.Expand == b.Expand {
			merged.Expand = t.Expand
		} else if t.Expand != b.Expand {
			soft = append(soft, SoftNote{store.DisplayFile, "expand", "both changed edge mode — kept main's"})
		}
	}
	if o.FanSpacing != t.FanSpacing {
		if o.FanSpacing == b.FanSpacing {
			merged.FanSpacing = t.FanSpacing
		} else if t.FanSpacing != b.FanSpacing {
			soft = append(soft, SoftNote{store.DisplayFile, "fan_spacing", "both changed arc spacing — kept main's"})
		}
	}
	if o.HideEdgeLabels != t.HideEdgeLabels {
		if o.HideEdgeLabels == b.HideEdgeLabels {
			merged.HideEdgeLabels = t.HideEdgeLabels
		} else if t.HideEdgeLabels != b.HideEdgeLabels {
			soft = append(soft, SoftNote{store.DisplayFile, "hide_edge_labels", "both changed edge-label visibility — kept main's"})
		}
	}
	data, err := json.MarshalIndent(merged, "", "  ")
	return data, soft, err
}

func jsonRaw(s string) json.RawMessage {
	if s == "" {
		return nil
	}
	b, _ := json.Marshal(s)
	return b
}
