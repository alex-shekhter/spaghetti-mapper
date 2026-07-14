package store

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// v1 stream shape: entities and fields were free-text names embedded in each
// endpoint, and a stream had a single business need.
type v1Endpoint struct {
	SystemID   string   `json:"system_id"`
	Entities   []string `json:"entities"`
	FieldsMode string   `json:"fields_mode"`
	Fields     []string `json:"fields"`
}

type v1Stream struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	BizNeedID   string     `json:"biz_need_id"`
	Timing      string     `json:"timing"`
	APIType     string     `json:"api_type"`
	DataFormat  string     `json:"data_format"`
	Direction   string     `json:"direction"`
	Status      string     `json:"status"`
	Source      v1Endpoint `json:"source"`
	Destination v1Endpoint `json:"destination"`
}

// migrateAll upgrades every project below CurrentSchema. Runs once at startup
// before the server accepts requests, so no locking subtleties.
func (s *Store) migrateAll() error {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == trashDir {
			continue
		}
		dir := filepath.Join(s.root, e.Name())
		p, err := readJSON[Project](filepath.Join(dir, projectFile))
		if err != nil || p.Name == "" || p.SchemaVersion >= CurrentSchema {
			continue
		}
		if err := migrateV1(dir, &p); err != nil {
			return err
		}
	}
	return nil
}

// migrateV1 promotes embedded entity/field name strings into per-system
// catalogs and converts biz_need_id to the multi-valued biz_need_ids.
// Everything auto-created gets provenance "imported".
func migrateV1(dir string, p *Project) error {
	imported := &Provenance{Source: "imported"}

	systems, err := readJSON[[]System](filepath.Join(dir, systemsFile))
	if err != nil {
		return err
	}
	old, err := readJSON[[]v1Stream](filepath.Join(dir, streamsFile))
	if err != nil {
		return err
	}

	sysByID := map[string]*System{}
	for i := range systems {
		normalizeSystem(&systems[i])
		sysByID[systems[i].ID] = &systems[i]
	}

	// find-or-create an entity by name within a system's catalog
	entFor := func(sys *System, name string) *Entity {
		for i := range sys.Entities {
			if strings.EqualFold(sys.Entities[i].Name, name) {
				return &sys.Entities[i]
			}
		}
		sys.Entities = append(sys.Entities, Entity{ID: newID(), Name: name, Fields: []Field{}, Provenance: imported})
		return &sys.Entities[len(sys.Entities)-1]
	}
	fldFor := func(ent *Entity, name string) *Field {
		for i := range ent.Fields {
			if strings.EqualFold(ent.Fields[i].Name, name) {
				return &ent.Fields[i]
			}
		}
		ent.Fields = append(ent.Fields, Field{ID: newID(), Name: name, Provenance: imported})
		return &ent.Fields[len(ent.Fields)-1]
	}

	convertEP := func(ep v1Endpoint) Endpoint {
		out := Endpoint{SystemID: ep.SystemID, FieldsMode: ep.FieldsMode, EntityIDs: []string{}, FieldIDs: []string{}}
		sys := sysByID[ep.SystemID]
		if sys == nil {
			return out // dangling reference; keep ids empty
		}
		var first *Entity
		for _, name := range ep.Entities {
			ent := entFor(sys, name)
			if first == nil {
				first = ent
			}
			out.EntityIDs = append(out.EntityIDs, ent.ID)
		}
		// v1 fields were flat per endpoint with no entity association;
		// attach them to the first listed entity (or an explicit bucket).
		if len(ep.Fields) > 0 {
			if first == nil {
				first = entFor(sys, "(uncategorized)")
				out.EntityIDs = append(out.EntityIDs, first.ID)
			}
			for _, name := range ep.Fields {
				out.FieldIDs = append(out.FieldIDs, fldFor(first, name).ID)
			}
		}
		return out
	}

	streams := make([]Stream, 0, len(old))
	for _, v := range old {
		needIDs := []string{}
		if v.BizNeedID != "" {
			needIDs = append(needIDs, v.BizNeedID)
		}
		streams = append(streams, Stream{
			ID: v.ID, Name: v.Name, BizNeedIDs: needIDs,
			Timing: v.Timing, APIType: v.APIType, DataFormat: v.DataFormat,
			Direction: v.Direction, Status: v.Status,
			Source: convertEP(v.Source), Destination: convertEP(v.Destination),
		})
	}

	if err := writeJSON(filepath.Join(dir, systemsFile), systems); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(dir, streamsFile), streams); err != nil {
		return err
	}
	p.SchemaVersion = CurrentSchema
	p.UpdatedAt = time.Now().UTC()
	return writeJSON(filepath.Join(dir, projectFile), p)
}
