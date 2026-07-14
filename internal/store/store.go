package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"sync"
	"time"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrExists      = errors.New("already exists")
	ErrInvalidName = errors.New("invalid project name")
)

var projectNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$`)

const (
	projectFile = "project.json"
	systemsFile = "systems.json"
	streamsFile = "streams.json"
	needsFile   = "needs.json"
	flowsFile   = "flows.json"
	layoutFile  = "layout.json"
	trashDir    = ".trash"
)

// Store persists projects as JSON files under root (~/.spaghettimapper).
// A single RWMutex guards all file access; last write wins.
type Store struct {
	mu   sync.RWMutex
	root string
}

func New(root string) (*Store, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create store root: %w", err)
	}
	s := &Store{root: root}
	if err := s.migrateAll(); err != nil {
		return nil, fmt.Errorf("migrate projects: %w", err)
	}
	return s, nil
}

func (s *Store) projectDir(name string) (string, error) {
	if !projectNameRe.MatchString(name) || name != filepath.Base(name) {
		return "", ErrInvalidName
	}
	return filepath.Join(s.root, name), nil
}

// readJSON loads a JSON file into v; a missing file yields the zero value.
func readJSON[T any](path string) (T, error) {
	var v T
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	return v, json.Unmarshal(data, &v)
}

// writeJSON writes v atomically (temp file + rename).
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func newID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// trashItem preserves a deleted item under <project>/.trash so deletion is
// recoverable by hand. Best effort: failure to trash never blocks deletion.
func trashItem(dir, kind, id string, v any) {
	td := filepath.Join(dir, trashDir)
	if err := os.MkdirAll(td, 0o755); err != nil {
		return
	}
	name := fmt.Sprintf("%s-%s-%d.json", kind, id, time.Now().UnixNano())
	_ = writeJSON(filepath.Join(td, name), v)
}

// ---- Projects ----

func (s *Store) ListProjects() ([]Project, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	projects := []Project{}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == trashDir {
			continue
		}
		p, err := readJSON[Project](filepath.Join(s.root, e.Name(), projectFile))
		if err != nil || p.Name == "" {
			continue // skip dirs that aren't valid projects
		}
		projects = append(projects, p)
	}
	sort.Slice(projects, func(i, j int) bool { return projects[i].Name < projects[j].Name })
	return projects, nil
}

func (s *Store) CreateProject(name, description string) (Project, error) {
	dir, err := s.projectDir(name)
	if err != nil {
		return Project{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Stat(dir); err == nil {
		return Project{}, ErrExists
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Project{}, err
	}
	now := time.Now().UTC()
	p := Project{Name: name, Description: description, SchemaVersion: CurrentSchema, CreatedAt: now, UpdatedAt: now}
	if err := writeJSON(filepath.Join(dir, projectFile), p); err != nil {
		return Project{}, err
	}
	return p, nil
}

func (s *Store) GetProject(name string) (Project, error) {
	dir, err := s.projectDir(name)
	if err != nil {
		return Project{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, err := readJSON[Project](filepath.Join(dir, projectFile))
	if err != nil {
		return Project{}, err
	}
	if p.Name == "" {
		return Project{}, ErrNotFound
	}
	return p, nil
}

func (s *Store) UpdateProject(name, description string) (Project, error) {
	dir, err := s.projectDir(name)
	if err != nil {
		return Project{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	path := filepath.Join(dir, projectFile)
	p, err := readJSON[Project](path)
	if err != nil {
		return Project{}, err
	}
	if p.Name == "" {
		return Project{}, ErrNotFound
	}
	p.Description = description
	p.UpdatedAt = time.Now().UTC()
	return p, writeJSON(path, p)
}

// DeleteProject moves the project directory into the store-level trash
// instead of destroying it.
func (s *Store) DeleteProject(name string) error {
	dir, err := s.projectDir(name)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Stat(filepath.Join(dir, projectFile)); err != nil {
		return ErrNotFound
	}
	td := filepath.Join(s.root, trashDir)
	if err := os.MkdirAll(td, 0o755); err != nil {
		return err
	}
	dest := filepath.Join(td, fmt.Sprintf("%s-%d", name, time.Now().UnixNano()))
	return os.Rename(dir, dest)
}

// ---- Generic entity CRUD over a per-project JSON file ----

type entity interface{ getID() string }

func (s System) getID() string  { return s.ID }
func (s Stream) getID() string  { return s.ID }
func (b BizNeed) getID() string { return b.ID }
func (f Flow) getID() string    { return f.ID }

func listEntities[T entity](s *Store, proj, file string) ([]T, error) {
	dir, err := s.projectDir(proj)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, err := os.Stat(filepath.Join(dir, projectFile)); err != nil {
		return nil, ErrNotFound
	}
	items, err := readJSON[[]T](filepath.Join(dir, file))
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []T{}
	}
	return items, nil
}

// mutateFiles runs fn with the project dir while holding the write lock.
func (s *Store) mutateProject(proj string, fn func(dir string) error) error {
	dir, err := s.projectDir(proj)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Stat(filepath.Join(dir, projectFile)); err != nil {
		return ErrNotFound
	}
	return fn(dir)
}

func mutateEntities[T entity](s *Store, proj, file string, fn func([]T) ([]T, error)) error {
	return s.mutateProject(proj, func(dir string) error {
		path := filepath.Join(dir, file)
		items, err := readJSON[[]T](path)
		if err != nil {
			return err
		}
		items, err = fn(items)
		if err != nil {
			return err
		}
		return writeJSON(path, items)
	})
}

// ---- Systems (with catalog handling & cascades) ----

// normalizeSystem assigns IDs to new entities/fields and defaults nil slices.
func normalizeSystem(sys *System) {
	if sys.Entities == nil {
		sys.Entities = []Entity{}
	}
	for i := range sys.Entities {
		e := &sys.Entities[i]
		if e.ID == "" {
			e.ID = newID()
		}
		if e.Fields == nil {
			e.Fields = []Field{}
		}
		for j := range e.Fields {
			if e.Fields[j].ID == "" {
				e.Fields[j].ID = newID()
			}
		}
	}
}

func normalizeStream(st *Stream) {
	if st.BizNeedIDs == nil {
		st.BizNeedIDs = []string{}
	}
	for _, ep := range []*Endpoint{&st.Source, &st.Destination} {
		if ep.EntityIDs == nil {
			ep.EntityIDs = []string{}
		}
		if ep.FieldIDs == nil {
			ep.FieldIDs = []string{}
		}
	}
}

func catalogIDs(sys System) (entIDs, fldIDs map[string]bool) {
	entIDs, fldIDs = map[string]bool{}, map[string]bool{}
	for _, e := range sys.Entities {
		entIDs[e.ID] = true
		for _, f := range e.Fields {
			fldIDs[f.ID] = true
		}
	}
	return
}

func (s *Store) ListSystems(proj string) ([]System, error) {
	return listEntities[System](s, proj, systemsFile)
}

func (s *Store) CreateSystem(proj string, sys System) (System, error) {
	sys.ID = newID()
	normalizeSystem(&sys)
	err := mutateEntities(s, proj, systemsFile, func(items []System) ([]System, error) {
		return append(items, sys), nil
	})
	return sys, err
}

// UpdateSystem replaces the system and scrubs references to any catalog
// entities/fields that were removed from every stream that used them.
func (s *Store) UpdateSystem(proj, id string, sys System) (System, error) {
	sys.ID = id
	normalizeSystem(&sys)
	err := s.mutateProject(proj, func(dir string) error {
		sysPath := filepath.Join(dir, systemsFile)
		items, err := readJSON[[]System](sysPath)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e System) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		old := items[idx]
		items[idx] = sys
		if err := writeJSON(sysPath, items); err != nil {
			return err
		}

		// scrub removed entity/field ids from streams
		oldE, oldF := catalogIDs(old)
		newE, newF := catalogIDs(sys)
		removed := func(m, still map[string]bool) map[string]bool {
			r := map[string]bool{}
			for k := range m {
				if !still[k] {
					r[k] = true
				}
			}
			return r
		}
		remE, remF := removed(oldE, newE), removed(oldF, newF)
		if len(remE) == 0 && len(remF) == 0 {
			return nil
		}
		stPath := filepath.Join(dir, streamsFile)
		streams, err := readJSON[[]Stream](stPath)
		if err != nil {
			return err
		}
		changed := false
		for i := range streams {
			for _, ep := range []*Endpoint{&streams[i].Source, &streams[i].Destination} {
				n1 := slices.DeleteFunc(ep.EntityIDs, func(x string) bool { return remE[x] })
				n2 := slices.DeleteFunc(ep.FieldIDs, func(x string) bool { return remF[x] })
				if len(n1) != len(ep.EntityIDs) || len(n2) != len(ep.FieldIDs) {
					changed = true
				}
				ep.EntityIDs, ep.FieldIDs = n1, n2
			}
		}
		if changed {
			return writeJSON(stPath, streams)
		}
		return nil
	})
	return sys, err
}

// DeleteSystem removes the system and cascades: every stream that references
// it goes to the trash too.
func (s *Store) DeleteSystem(proj, id string) error {
	return s.mutateProject(proj, func(dir string) error {
		sysPath := filepath.Join(dir, systemsFile)
		items, err := readJSON[[]System](sysPath)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e System) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		trashItem(dir, "system", id, items[idx])
		items = slices.Delete(items, idx, idx+1)
		if err := writeJSON(sysPath, items); err != nil {
			return err
		}

		stPath := filepath.Join(dir, streamsFile)
		streams, err := readJSON[[]Stream](stPath)
		if err != nil {
			return err
		}
		kept := streams[:0]
		removedIDs := map[string]bool{}
		for _, st := range streams {
			if st.Source.SystemID == id || st.Destination.SystemID == id {
				trashItem(dir, "stream", st.ID, st)
				removedIDs[st.ID] = true
				continue
			}
			kept = append(kept, st)
		}
		if len(removedIDs) > 0 {
			if err := writeJSON(stPath, slices.Clone(kept)); err != nil {
				return err
			}
			return scrubFlows(dir, removedIDs)
		}
		return nil
	})
}

// ---- Streams ----

func (s *Store) ListStreams(proj string) ([]Stream, error) {
	return listEntities[Stream](s, proj, streamsFile)
}

func (s *Store) CreateStream(proj string, st Stream) (Stream, error) {
	st.ID = newID()
	normalizeStream(&st)
	err := mutateEntities(s, proj, streamsFile, func(items []Stream) ([]Stream, error) {
		return append(items, st), nil
	})
	return st, err
}

func (s *Store) UpdateStream(proj, id string, st Stream) (Stream, error) {
	st.ID = id
	normalizeStream(&st)
	err := mutateEntities(s, proj, streamsFile, func(items []Stream) ([]Stream, error) {
		idx := slices.IndexFunc(items, func(e Stream) bool { return e.ID == id })
		if idx < 0 {
			return nil, ErrNotFound
		}
		items[idx] = st
		return items, nil
	})
	return st, err
}

func (s *Store) DeleteStream(proj, id string) error {
	return s.mutateProject(proj, func(dir string) error {
		path := filepath.Join(dir, streamsFile)
		items, err := readJSON[[]Stream](path)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e Stream) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		trashItem(dir, "stream", id, items[idx])
		if err := writeJSON(path, slices.Delete(items, idx, idx+1)); err != nil {
			return err
		}
		return scrubFlows(dir, map[string]bool{id: true})
	})
}

// scrubFlows removes references to the given stream ids from every flow.
func scrubFlows(dir string, streamIDs map[string]bool) error {
	if len(streamIDs) == 0 {
		return nil
	}
	path := filepath.Join(dir, flowsFile)
	flows, err := readJSON[[]Flow](path)
	if err != nil {
		return err
	}
	changed := false
	for i := range flows {
		n := slices.DeleteFunc(flows[i].Steps, func(s FlowStep) bool { return streamIDs[s.StreamID] })
		if len(n) != len(flows[i].Steps) {
			changed = true
		}
		flows[i].Steps = n
	}
	if changed {
		return writeJSON(path, flows)
	}
	return nil
}

// ---- Flows ----

func normalizeFlow(f *Flow) {
	if f.BizNeedIDs == nil {
		f.BizNeedIDs = []string{}
	}
	if f.Steps == nil {
		f.Steps = []FlowStep{}
	}
	for i := range f.Steps {
		if f.Steps[i].Stage < 1 {
			f.Steps[i].Stage = 1
		}
	}
}

func (s *Store) ListFlows(proj string) ([]Flow, error) {
	return listEntities[Flow](s, proj, flowsFile)
}

func (s *Store) CreateFlow(proj string, f Flow) (Flow, error) {
	f.ID = newID()
	normalizeFlow(&f)
	err := mutateEntities(s, proj, flowsFile, func(items []Flow) ([]Flow, error) {
		return append(items, f), nil
	})
	return f, err
}

func (s *Store) UpdateFlow(proj, id string, f Flow) (Flow, error) {
	f.ID = id
	normalizeFlow(&f)
	err := mutateEntities(s, proj, flowsFile, func(items []Flow) ([]Flow, error) {
		idx := slices.IndexFunc(items, func(e Flow) bool { return e.ID == id })
		if idx < 0 {
			return nil, ErrNotFound
		}
		items[idx] = f
		return items, nil
	})
	return f, err
}

func (s *Store) DeleteFlow(proj, id string) error {
	return s.mutateProject(proj, func(dir string) error {
		path := filepath.Join(dir, flowsFile)
		items, err := readJSON[[]Flow](path)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e Flow) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		trashItem(dir, "flow", id, items[idx])
		return writeJSON(path, slices.Delete(items, idx, idx+1))
	})
}

// ---- Business needs ----

func (s *Store) ListNeeds(proj string) ([]BizNeed, error) {
	return listEntities[BizNeed](s, proj, needsFile)
}

func (s *Store) CreateNeed(proj string, n BizNeed) (BizNeed, error) {
	n.ID = newID()
	err := mutateEntities(s, proj, needsFile, func(items []BizNeed) ([]BizNeed, error) {
		return append(items, n), nil
	})
	return n, err
}

func (s *Store) UpdateNeed(proj, id string, n BizNeed) (BizNeed, error) {
	n.ID = id
	err := mutateEntities(s, proj, needsFile, func(items []BizNeed) ([]BizNeed, error) {
		idx := slices.IndexFunc(items, func(e BizNeed) bool { return e.ID == id })
		if idx < 0 {
			return nil, ErrNotFound
		}
		items[idx] = n
		return items, nil
	})
	return n, err
}

// DeleteNeed removes the need and scrubs its id from every stream and from
// every catalog entity/field justification.
func (s *Store) DeleteNeed(proj, id string) error {
	return s.mutateProject(proj, func(dir string) error {
		path := filepath.Join(dir, needsFile)
		items, err := readJSON[[]BizNeed](path)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e BizNeed) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		trashItem(dir, "need", id, items[idx])
		if err := writeJSON(path, slices.Delete(items, idx, idx+1)); err != nil {
			return err
		}

		drop := func(ids []string) ([]string, bool) {
			n := slices.DeleteFunc(ids, func(x string) bool { return x == id })
			return n, len(n) != len(ids)
		}

		stPath := filepath.Join(dir, streamsFile)
		streams, err := readJSON[[]Stream](stPath)
		if err != nil {
			return err
		}
		changed := false
		for i := range streams {
			var c bool
			streams[i].BizNeedIDs, c = drop(streams[i].BizNeedIDs)
			changed = changed || c
		}
		if changed {
			if err := writeJSON(stPath, streams); err != nil {
				return err
			}
		}

		sysPath := filepath.Join(dir, systemsFile)
		systems, err := readJSON[[]System](sysPath)
		if err != nil {
			return err
		}
		changed = false
		for i := range systems {
			for j := range systems[i].Entities {
				e := &systems[i].Entities[j]
				var c bool
				e.BizNeedIDs, c = drop(e.BizNeedIDs)
				changed = changed || c
				for k := range e.Fields {
					e.Fields[k].BizNeedIDs, c = drop(e.Fields[k].BizNeedIDs)
					changed = changed || c
				}
			}
		}
		if changed {
			if err := writeJSON(sysPath, systems); err != nil {
				return err
			}
		}

		flPath := filepath.Join(dir, flowsFile)
		flows, err := readJSON[[]Flow](flPath)
		if err != nil {
			return err
		}
		changed = false
		for i := range flows {
			var c bool
			flows[i].BizNeedIDs, c = drop(flows[i].BizNeedIDs)
			changed = changed || c
		}
		if changed {
			return writeJSON(flPath, flows)
		}
		return nil
	})
}

// ---- Import / export ----

// Bundle is a whole project in one shareable JSON document.
type Bundle struct {
	FormatVersion int                `json:"format_version"`
	ExportedAt    time.Time          `json:"exported_at"`
	Project       Project            `json:"project"`
	Systems       []System           `json:"systems"`
	Streams       []Stream           `json:"streams"`
	Needs         []BizNeed          `json:"needs"`
	Flows         []Flow             `json:"flows"`
	Layout        map[string]NodePos `json:"layout"`
}

func (s *Store) ExportProject(name string) (Bundle, error) {
	g, err := s.GetGraph(name)
	if err != nil {
		return Bundle{}, err
	}
	return Bundle{
		FormatVersion: 1,
		ExportedAt:    time.Now().UTC(),
		Project:       g.Project,
		Systems:       g.Systems,
		Streams:       g.Streams,
		Needs:         g.Needs,
		Flows:         g.Flows,
		Layout:        g.Layout,
	}, nil
}

// ImportProject creates a new project from a bundle. IDs are kept as-is so
// re-imports and shared bundles stay stable.
func (s *Store) ImportProject(name string, b Bundle) (Project, error) {
	dir, err := s.projectDir(name)
	if err != nil {
		return Project{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Stat(dir); err == nil {
		return Project{}, ErrExists
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Project{}, err
	}
	now := time.Now().UTC()
	p := Project{Name: name, Description: b.Project.Description, SchemaVersion: CurrentSchema, CreatedAt: now, UpdatedAt: now}
	if b.Systems == nil {
		b.Systems = []System{}
	}
	if b.Streams == nil {
		b.Streams = []Stream{}
	}
	for i := range b.Systems {
		normalizeSystem(&b.Systems[i])
	}
	for i := range b.Streams {
		normalizeStream(&b.Streams[i])
	}
	if b.Needs == nil {
		b.Needs = []BizNeed{}
	}
	if b.Flows == nil {
		b.Flows = []Flow{}
	}
	for i := range b.Flows {
		normalizeFlow(&b.Flows[i])
	}
	if b.Layout == nil {
		b.Layout = map[string]NodePos{}
	}
	files := map[string]any{
		projectFile: p,
		systemsFile: b.Systems,
		streamsFile: b.Streams,
		needsFile:   b.Needs,
		flowsFile:   b.Flows,
		layoutFile:  b.Layout,
	}
	for f, v := range files {
		if err := writeJSON(filepath.Join(dir, f), v); err != nil {
			return Project{}, err
		}
	}
	return p, nil
}

// ---- Layout ----

func (s *Store) GetLayout(proj string) (map[string]NodePos, error) {
	dir, err := s.projectDir(proj)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	layout, err := readJSON[map[string]NodePos](filepath.Join(dir, layoutFile))
	if err != nil {
		return nil, err
	}
	if layout == nil {
		layout = map[string]NodePos{}
	}
	return layout, nil
}

func (s *Store) SaveLayout(proj string, layout map[string]NodePos) error {
	return s.mutateProject(proj, func(dir string) error {
		return writeJSON(filepath.Join(dir, layoutFile), layout)
	})
}

// ---- Graph ----

// Graph returns everything the visualization needs in one payload.
type Graph struct {
	Project Project            `json:"project"`
	Systems []System           `json:"systems"`
	Streams []Stream           `json:"streams"`
	Needs   []BizNeed          `json:"needs"`
	Flows   []Flow             `json:"flows"`
	Layout  map[string]NodePos `json:"layout"`
}

func (s *Store) GetGraph(proj string) (Graph, error) {
	p, err := s.GetProject(proj)
	if err != nil {
		return Graph{}, err
	}
	systems, err := s.ListSystems(proj)
	if err != nil {
		return Graph{}, err
	}
	streams, err := s.ListStreams(proj)
	if err != nil {
		return Graph{}, err
	}
	needs, err := s.ListNeeds(proj)
	if err != nil {
		return Graph{}, err
	}
	flows, err := s.ListFlows(proj)
	if err != nil {
		return Graph{}, err
	}
	layout, err := s.GetLayout(proj)
	if err != nil {
		return Graph{}, err
	}
	return Graph{Project: p, Systems: systems, Streams: streams, Needs: needs, Flows: flows, Layout: layout}, nil
}
