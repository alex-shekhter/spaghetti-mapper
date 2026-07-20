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
	"strings"
	"sync"
	"time"

	"spaghettimapper/internal/volume"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrExists      = errors.New("already exists")
	ErrInvalidName = errors.New("invalid project name")
	ErrValidation  = errors.New("validation")
)

var projectNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$`)

const (
	projectFile  = "project.json"
	systemsFile  = "systems.json"
	streamsFile  = "streams.json"
	needsFile    = "needs.json"
	flowsFile    = "flows.json"
	clustersFile = "clusters.json"
	layoutFile   = "layout.json"
	displayFile  = "display.json"
	trashDir     = ".trash"
	// userStateDir holds per-architect viewer state (root/.userstate/<proj>/
	// <arch>.json). Deliberately OUTSIDE every project's git repo: this is
	// what a person is looking at, not part of the map, so undo/restore/
	// merge/export must never carry it.
	userStateDir = ".userstate"
)

// Exported file-name constants (the on-disk schema), for use by the merge
// engine and other internal packages.
const (
	ProjectFile  = projectFile
	SystemsFile  = systemsFile
	StreamsFile  = streamsFile
	NeedsFile    = needsFile
	FlowsFile    = flowsFile
	ClustersFile = clustersFile
	LayoutFile   = layoutFile
	DisplayFile  = displayFile
)

// Store persists projects as JSON files under root (~/.spaghettimapper).
// Reads and writes go through a volume.Volume: a disk volume targets the
// project's main line (the on-disk working tree, committed by the VCS layer),
// an architect's branch volume targets their own git branch. Project-level
// directory operations (create / delete / import / list) are always on disk.
// A single RWMutex guards the on-disk working tree; branch volumes are
// per-request snapshots that don't touch the working tree, so an architect's
// writes don't clobber another's.
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

// ProjectDir returns the on-disk directory for a project named name under
// root, validating the name the same way the store does. Exported so the VCS
// layer can locate a project repo without a Store instance.
func ProjectDir(root, name string) (string, error) {
	if !projectNameRe.MatchString(name) || name != filepath.Base(name) {
		return "", ErrInvalidName
	}
	return filepath.Join(root, name), nil
}

// projectExists reports whether the project dir on disk has a project.json.
// Branches only exist for real projects (created on main first), so this disk
// check gates both disk and branch volumes.
func (s *Store) projectExists(proj string) (string, error) {
	dir, err := s.projectDir(proj)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(dir, projectFile)); err != nil {
		return "", ErrNotFound
	}
	return dir, nil
}

// lockWrite acquires the right lock for a mutation: the global working-tree
// mutex for the main line (disk), or nothing for a branch (a branch write
// already holds the per-branch lock via its BranchVolume, and branches never
// touch the working tree). Returns an unlock func.
func (s *Store) lockWrite(vol volume.Volume) func() {
	if vol.IsBranch() {
		return func() {}
	}
	s.mu.Lock()
	return s.mu.Unlock
}

// lockRead acquires a read lock for the main line; branch reads are lock-free
// (they read an immutable in-memory snapshot of the branch tree).
func (s *Store) lockRead(vol volume.Volume) func() {
	if vol.IsBranch() {
		return func() {}
	}
	s.mu.RLock()
	return s.mu.RUnlock
}

// readJSON loads a JSON file from a filesystem path into v; a missing file
// yields the zero value. Used by the disk-only project-level operations.
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

// writeJSON writes v atomically to a filesystem path (temp file + rename).
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

// readVol loads a JSON file from a volume into v; a missing file yields the
// zero value (a branch with no file yet reads as empty, falling back to main
// semantics where appropriate).
func readVol[T any](vol volume.Volume, name string) (T, error) {
	var v T
	data, err := vol.Read(name)
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	return v, json.Unmarshal(data, &v)
}

// writeVol marshals v and stages it on the volume.
func writeVol(vol volume.Volume, name string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return vol.Write(name, data)
}

func newID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// trashItem preserves a deleted item under <project>/.trash on disk so
// deletion is recoverable by hand. Only meaningful for the disk (main) line —
// branches recover via git history, and .trash is gitignored — so callers
// gate this on the volume's CanTrash. Best effort: failure never blocks.
func trashItem(dir, kind, id string, v any) {
	td := filepath.Join(dir, trashDir)
	if err := os.MkdirAll(td, 0o755); err != nil {
		return
	}
	name := fmt.Sprintf("%s-%s-%d.json", kind, id, time.Now().UnixNano())
	_ = writeJSON(filepath.Join(td, name), v)
}

// ---- Projects (disk-only) ----

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
		dir := filepath.Join(s.root, e.Name())
		p, err := readJSON[Project](filepath.Join(dir, projectFile))
		if err != nil || p.Name == "" {
			continue // skip dirs that aren't valid projects
		}
		// DR-2 home cards: quiet size meta without a second round-trip.
		// Counts reflect the main line on disk, not any architect "me" branch.
		if systems, err := readJSON[[]System](filepath.Join(dir, systemsFile)); err == nil {
			p.SystemCount = len(systems)
		}
		if streams, err := readJSON[[]Stream](filepath.Join(dir, streamsFile)); err == nil {
			p.StreamCount = len(streams)
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

func (s *Store) GetProject(proj string, vol volume.Volume) (Project, error) {
	if _, err := s.projectExists(proj); err != nil {
		return Project{}, err
	}
	unlock := s.lockRead(vol)
	defer unlock()
	p, err := readVol[Project](vol, projectFile)
	if err != nil {
		return Project{}, err
	}
	if p.Name == "" {
		return Project{}, ErrNotFound
	}
	return p, nil
}

func (s *Store) UpdateProject(proj string, vol volume.Volume, description string) (Project, error) {
	dir, err := s.projectExists(proj)
	if err != nil {
		return Project{}, err
	}
	unlock := s.lockWrite(vol)
	defer unlock()
	p, err := readVol[Project](vol, projectFile)
	if err != nil {
		return Project{}, err
	}
	if p.Name == "" {
		return Project{}, ErrNotFound
	}
	p.Description = description
	p.UpdatedAt = time.Now().UTC()
	if err := writeVol(vol, projectFile, p); err != nil {
		return Project{}, err
	}
	_ = dir // dir retained for symmetry; main commits via the volume
	return p, nil
}

// DeleteProject moves the project directory into the store-level trash
// instead of destroying it. Always on disk (branches live under a project).
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
func (c Cluster) getID() string { return c.ID }

func listEntities[T entity](s *Store, proj string, vol volume.Volume, file string) ([]T, error) {
	if _, err := s.projectExists(proj); err != nil {
		return nil, err
	}
	unlock := s.lockRead(vol)
	defer unlock()
	items, err := readVol[[]T](vol, file)
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []T{}
	}
	return items, nil
}

// mutateProject runs fn with the volume while holding the write lock. The
// project must exist on disk (branches are of real projects).
func (s *Store) mutateProject(proj string, vol volume.Volume, fn func(volume.Volume) error) error {
	if _, err := s.projectExists(proj); err != nil {
		return err
	}
	unlock := s.lockWrite(vol)
	defer unlock()
	return fn(vol)
}

// trashIfDisk preserves a deleted item on disk only for the main line.
func trashIfDisk(vol volume.Volume, dir, kind, id string, v any) {
	if !vol.CanTrash() {
		return
	}
	trashItem(dir, kind, id, v)
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

func (s *Store) ListSystems(proj string, vol volume.Volume) ([]System, error) {
	return listEntities[System](s, proj, vol, systemsFile)
}

func (s *Store) CreateSystem(proj string, vol volume.Volume, sys System) (System, error) {
	sys.ID = newID()
	normalizeSystem(&sys)
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		return mutateEntitiesOnVol[System](v, systemsFile, func(items []System) ([]System, error) {
			return append(items, sys), nil
		})
	})
	return sys, err
}

// UpdateSystem replaces the system and scrubs references to any catalog
// entities/fields that were removed from every stream that used them.
func (s *Store) UpdateSystem(proj string, vol volume.Volume, id string, sys System) (System, error) {
	sys.ID = id
	normalizeSystem(&sys)
	dir, _ := s.projectDir(proj)
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		items, err := readVol[[]System](v, systemsFile)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e System) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		old := items[idx]
		items[idx] = sys
		if err := writeVol(v, systemsFile, items); err != nil {
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
		streams, err := readVol[[]Stream](v, streamsFile)
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
			return writeVol(v, streamsFile, streams)
		}
		return nil
	})
	_ = dir
	return sys, err
}

// DeleteSystem removes the system and cascades: every stream that references
// it is removed too.
func (s *Store) DeleteSystem(proj string, vol volume.Volume, id string) error {
	return s.BatchSystems(proj, vol, []SystemOp{{Op: "delete", ID: id}})
}

// SystemOp is one step in a systems batch: delete a system or set its type.
// Validate all ops first; apply inside one mutateProject (all-or-nothing).
type SystemOp struct {
	Op   string `json:"op"`             // "delete" | "set_type"
	ID   string `json:"id"`             // system id
	Type string `json:"type,omitempty"` // required for set_type
}

// BatchSystems applies a list of system ops in one write lock / one caller's
// commit. Any invalid op → ErrValidation (or ErrNotFound), nothing applied.
func (s *Store) BatchSystems(proj string, vol volume.Volume, ops []SystemOp) error {
	if len(ops) == 0 {
		return fmt.Errorf("%w: ops required", ErrValidation)
	}
	dir, _ := s.projectDir(proj)
	return s.mutateProject(proj, vol, func(v volume.Volume) error {
		items, err := readVol[[]System](v, systemsFile)
		if err != nil {
			return err
		}
		byID := make(map[string]int, len(items))
		for i, sys := range items {
			byID[sys.ID] = i
		}

		// Validate ALL ops before mutating anything.
		seen := map[string]bool{}
		for i, op := range ops {
			if op.ID == "" {
				return fmt.Errorf("%w: op %d: id is required", ErrValidation, i)
			}
			if seen[op.ID] {
				return fmt.Errorf("%w: op %d: duplicate id %q", ErrValidation, i, op.ID)
			}
			seen[op.ID] = true
			if _, ok := byID[op.ID]; !ok {
				return ErrNotFound
			}
			switch op.Op {
			case "delete":
				// ok
			case "set_type":
				if !slices.Contains(SystemTypes, op.Type) {
					return fmt.Errorf("%w: type must be one of %v (got %q)", ErrValidation, SystemTypes, op.Type)
				}
			default:
				return fmt.Errorf("%w: op must be delete or set_type (got %q)", ErrValidation, op.Op)
			}
		}

		// Apply set_type first (so a mixed batch that deletes the same id is
		// rejected above as duplicate). Then deletes.
		changed := false
		for _, op := range ops {
			if op.Op != "set_type" {
				continue
			}
			idx := byID[op.ID]
			if items[idx].Type != op.Type {
				items[idx].Type = op.Type
				changed = true
			}
		}
		if changed {
			if err := writeVol(v, systemsFile, items); err != nil {
				return err
			}
		}

		deleteIDs := map[string]bool{}
		for _, op := range ops {
			if op.Op == "delete" {
				deleteIDs[op.ID] = true
			}
		}
		if len(deleteIDs) == 0 {
			return nil
		}

		// Re-read after set_type write so trash gets the latest system body.
		items, err = readVol[[]System](v, systemsFile)
		if err != nil {
			return err
		}
		keptSys := items[:0]
		for _, sys := range items {
			if deleteIDs[sys.ID] {
				trashIfDisk(v, dir, "system", sys.ID, sys)
				continue
			}
			keptSys = append(keptSys, sys)
		}
		if err := writeVol(v, systemsFile, slices.Clone(keptSys)); err != nil {
			return err
		}

		streams, err := readVol[[]Stream](v, streamsFile)
		if err != nil {
			return err
		}
		keptSt := streams[:0]
		removedStreamIDs := map[string]bool{}
		for _, st := range streams {
			if deleteIDs[st.Source.SystemID] || deleteIDs[st.Destination.SystemID] {
				trashIfDisk(v, dir, "stream", st.ID, st)
				removedStreamIDs[st.ID] = true
				continue
			}
			keptSt = append(keptSt, st)
		}
		if len(removedStreamIDs) > 0 {
			if err := writeVol(v, streamsFile, slices.Clone(keptSt)); err != nil {
				return err
			}
			if err := scrubFlows(v, removedStreamIDs); err != nil {
				return err
			}
		}
		// Strip deleted system ids from every cluster (membership only — never
		// delete the cluster itself).
		return stripClusterMembers(v, deleteIDs)
	})
}

// stripClusterMembers removes any of the given system ids from every cluster's
// membership list. Missing clusters file is a no-op (empty list).
func stripClusterMembers(v volume.Volume, deleteIDs map[string]bool) error {
	if len(deleteIDs) == 0 {
		return nil
	}
	clusters, err := readVol[[]Cluster](v, clustersFile)
	if err != nil {
		return err
	}
	if len(clusters) == 0 {
		return nil
	}
	changed := false
	for i := range clusters {
		n := slices.DeleteFunc(clusters[i].SystemIDs, func(id string) bool { return deleteIDs[id] })
		if len(n) != len(clusters[i].SystemIDs) {
			clusters[i].SystemIDs = n
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return writeVol(v, clustersFile, clusters)
}

// ---- Streams ----

func (s *Store) ListStreams(proj string, vol volume.Volume) ([]Stream, error) {
	return listEntities[Stream](s, proj, vol, streamsFile)
}

func (s *Store) CreateStream(proj string, vol volume.Volume, st Stream) (Stream, error) {
	st.ID = newID()
	normalizeStream(&st)
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		return mutateEntitiesOnVol[Stream](v, streamsFile, func(items []Stream) ([]Stream, error) {
			return append(items, st), nil
		})
	})
	return st, err
}

func (s *Store) UpdateStream(proj string, vol volume.Volume, id string, st Stream) (Stream, error) {
	st.ID = id
	normalizeStream(&st)
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		return mutateEntitiesOnVol[Stream](v, streamsFile, func(items []Stream) ([]Stream, error) {
			idx := slices.IndexFunc(items, func(e Stream) bool { return e.ID == id })
			if idx < 0 {
				return nil, ErrNotFound
			}
			items[idx] = st
			return items, nil
		})
	})
	return st, err
}

func (s *Store) DeleteStream(proj string, vol volume.Volume, id string) error {
	dir, _ := s.projectDir(proj)
	return s.mutateProject(proj, vol, func(v volume.Volume) error {
		items, err := readVol[[]Stream](v, streamsFile)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e Stream) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		trashIfDisk(v, dir, "stream", id, items[idx])
		if err := writeVol(v, streamsFile, slices.Delete(items, idx, idx+1)); err != nil {
			return err
		}
		return scrubFlows(v, map[string]bool{id: true})
	})
}

// scrubFlows removes references to the given stream ids from every flow.
func scrubFlows(v volume.Volume, streamIDs map[string]bool) error {
	if len(streamIDs) == 0 {
		return nil
	}
	flows, err := readVol[[]Flow](v, flowsFile)
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
		return writeVol(v, flowsFile, flows)
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

func (s *Store) ListFlows(proj string, vol volume.Volume) ([]Flow, error) {
	return listEntities[Flow](s, proj, vol, flowsFile)
}

func (s *Store) CreateFlow(proj string, vol volume.Volume, f Flow) (Flow, error) {
	f.ID = newID()
	normalizeFlow(&f)
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		return mutateEntitiesOnVol[Flow](v, flowsFile, func(items []Flow) ([]Flow, error) {
			return append(items, f), nil
		})
	})
	return f, err
}

func (s *Store) UpdateFlow(proj string, vol volume.Volume, id string, f Flow) (Flow, error) {
	f.ID = id
	normalizeFlow(&f)
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		return mutateEntitiesOnVol[Flow](v, flowsFile, func(items []Flow) ([]Flow, error) {
			idx := slices.IndexFunc(items, func(e Flow) bool { return e.ID == id })
			if idx < 0 {
				return nil, ErrNotFound
			}
			items[idx] = f
			return items, nil
		})
	})
	return f, err
}

func (s *Store) DeleteFlow(proj string, vol volume.Volume, id string) error {
	dir, _ := s.projectDir(proj)
	return s.mutateProject(proj, vol, func(v volume.Volume) error {
		items, err := readVol[[]Flow](v, flowsFile)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e Flow) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		trashIfDisk(v, dir, "flow", id, items[idx])
		return writeVol(v, flowsFile, slices.Delete(items, idx, idx+1))
	})
}

// ---- Business needs ----

func (s *Store) ListNeeds(proj string, vol volume.Volume) ([]BizNeed, error) {
	return listEntities[BizNeed](s, proj, vol, needsFile)
}

func (s *Store) CreateNeed(proj string, vol volume.Volume, n BizNeed) (BizNeed, error) {
	n.ID = newID()
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		return mutateEntitiesOnVol[BizNeed](v, needsFile, func(items []BizNeed) ([]BizNeed, error) {
			return append(items, n), nil
		})
	})
	return n, err
}

func (s *Store) UpdateNeed(proj string, vol volume.Volume, id string, n BizNeed) (BizNeed, error) {
	n.ID = id
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		return mutateEntitiesOnVol[BizNeed](v, needsFile, func(items []BizNeed) ([]BizNeed, error) {
			idx := slices.IndexFunc(items, func(e BizNeed) bool { return e.ID == id })
			if idx < 0 {
				return nil, ErrNotFound
			}
			items[idx] = n
			return items, nil
		})
	})
	return n, err
}

// ---- Clusters ----

func normalizeCluster(c *Cluster) {
	c.Name = strings.TrimSpace(c.Name)
	if c.SystemIDs == nil {
		c.SystemIDs = []string{}
	} else {
		// Dedup membership while preserving first-seen order.
		seen := map[string]bool{}
		out := c.SystemIDs[:0]
		for _, id := range c.SystemIDs {
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, id)
		}
		c.SystemIDs = out
	}
	if c.BizNeedIDs == nil {
		c.BizNeedIDs = []string{}
	}
}

// validateCluster checks name, color palette key, and that every member id
// exists among systems. Call with the current systems list under the write lock.
func validateCluster(c Cluster, systems []System) error {
	if strings.TrimSpace(c.Name) == "" {
		return fmt.Errorf("%w: name is required", ErrValidation)
	}
	if c.Color != "" && !slices.Contains(ClusterColors, c.Color) {
		return fmt.Errorf("%w: color must be one of %v (got %q)", ErrValidation, ClusterColors, c.Color)
	}
	present := map[string]bool{}
	for _, sys := range systems {
		present[sys.ID] = true
	}
	for _, id := range c.SystemIDs {
		if !present[id] {
			return fmt.Errorf("%w: unknown system %q", ErrValidation, id)
		}
	}
	return nil
}

func (s *Store) ListClusters(proj string, vol volume.Volume) ([]Cluster, error) {
	return listEntities[Cluster](s, proj, vol, clustersFile)
}

func (s *Store) CreateCluster(proj string, vol volume.Volume, c Cluster) (Cluster, error) {
	c.ID = newID()
	normalizeCluster(&c)
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		systems, err := readVol[[]System](v, systemsFile)
		if err != nil {
			return err
		}
		if err := validateCluster(c, systems); err != nil {
			return err
		}
		return mutateEntitiesOnVol[Cluster](v, clustersFile, func(items []Cluster) ([]Cluster, error) {
			return append(items, c), nil
		})
	})
	return c, err
}

func (s *Store) UpdateCluster(proj string, vol volume.Volume, id string, c Cluster) (Cluster, error) {
	c.ID = id
	normalizeCluster(&c)
	err := s.mutateProject(proj, vol, func(v volume.Volume) error {
		systems, err := readVol[[]System](v, systemsFile)
		if err != nil {
			return err
		}
		if err := validateCluster(c, systems); err != nil {
			return err
		}
		return mutateEntitiesOnVol[Cluster](v, clustersFile, func(items []Cluster) ([]Cluster, error) {
			idx := slices.IndexFunc(items, func(e Cluster) bool { return e.ID == id })
			if idx < 0 {
				return nil, ErrNotFound
			}
			items[idx] = c
			return items, nil
		})
	})
	return c, err
}

// DeleteCluster removes the cluster only — its systems stay on the map.
func (s *Store) DeleteCluster(proj string, vol volume.Volume, id string) error {
	dir, _ := s.projectDir(proj)
	return s.mutateProject(proj, vol, func(v volume.Volume) error {
		items, err := readVol[[]Cluster](v, clustersFile)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e Cluster) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		trashIfDisk(v, dir, "cluster", id, items[idx])
		return writeVol(v, clustersFile, slices.Delete(items, idx, idx+1))
	})
}

// DeleteNeed removes the need and scrubs its id from every stream and from
// every catalog entity/field justification.
func (s *Store) DeleteNeed(proj string, vol volume.Volume, id string) error {
	dir, _ := s.projectDir(proj)
	return s.mutateProject(proj, vol, func(v volume.Volume) error {
		items, err := readVol[[]BizNeed](v, needsFile)
		if err != nil {
			return err
		}
		idx := slices.IndexFunc(items, func(e BizNeed) bool { return e.ID == id })
		if idx < 0 {
			return ErrNotFound
		}
		trashIfDisk(v, dir, "need", id, items[idx])
		if err := writeVol(v, needsFile, slices.Delete(items, idx, idx+1)); err != nil {
			return err
		}

		drop := func(ids []string) ([]string, bool) {
			n := slices.DeleteFunc(ids, func(x string) bool { return x == id })
			return n, len(n) != len(ids)
		}

		streams, err := readVol[[]Stream](v, streamsFile)
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
			if err := writeVol(v, streamsFile, streams); err != nil {
				return err
			}
		}

		systems, err := readVol[[]System](v, systemsFile)
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
			if err := writeVol(v, systemsFile, systems); err != nil {
				return err
			}
		}

		flows, err := readVol[[]Flow](v, flowsFile)
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
			return writeVol(v, flowsFile, flows)
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
	Clusters      []Cluster          `json:"clusters"`
	Layout        map[string]NodePos `json:"layout"`
	Display       Display            `json:"display"`
}

func (s *Store) ExportProject(name string, vol volume.Volume) (Bundle, error) {
	g, err := s.GetGraph(name, vol)
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
		Clusters:      g.Clusters,
		Layout:        g.Layout,
		Display:       g.Display,
	}, nil
}

// ImportProject creates a new project from a bundle. IDs are kept as-is so
// re-imports and shared bundles stay stable. Always on disk (main).
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
	if b.Clusters == nil {
		b.Clusters = []Cluster{}
	}
	for i := range b.Clusters {
		normalizeCluster(&b.Clusters[i])
	}
	if b.Layout == nil {
		b.Layout = map[string]NodePos{}
	}
	files := map[string]any{
		projectFile:  p,
		systemsFile:  b.Systems,
		streamsFile:  b.Streams,
		needsFile:    b.Needs,
		flowsFile:    b.Flows,
		clustersFile: b.Clusters,
		layoutFile:   b.Layout,
		displayFile:  b.Display,
	}
	for f, v := range files {
		if err := writeJSON(filepath.Join(dir, f), v); err != nil {
			return Project{}, err
		}
	}
	return p, nil
}

// ---- Layout ----

func (s *Store) GetLayout(proj string, vol volume.Volume) (map[string]NodePos, error) {
	if _, err := s.projectExists(proj); err != nil {
		return nil, err
	}
	unlock := s.lockRead(vol)
	defer unlock()
	layout, err := readVol[map[string]NodePos](vol, layoutFile)
	if err != nil {
		return nil, err
	}
	if layout == nil {
		layout = map[string]NodePos{}
	}
	return layout, nil
}

func (s *Store) SaveLayout(proj string, vol volume.Volume, layout map[string]NodePos) error {
	return s.mutateProject(proj, vol, func(v volume.Volume) error {
		return writeVol(v, layoutFile, layout)
	})
}

// ThumbGraph builds the compact thumbnail payload (nodes with saved positions
// + types, and one unordered edge per system pair sharing a stream) from a
// volume — typically a CommitVolume over a past commit. Edges use the same
// unordered a<b keying as the live aggregate() so thumbnails match the real
// rendering. A node with no saved position still appears (zero coords) so the
// row count is stable; the mini renderer scales-to-fit regardless.
// HP-1: also carries clusters (present members only) so history thumbs can
// paint plates; canvas minimap still has no hulls.
func (s *Store) ThumbGraph(proj string, vol volume.Volume) (Thumb, error) {
	systems, err := s.ListSystems(proj, vol)
	if err != nil {
		return Thumb{}, err
	}
	layout, err := s.GetLayout(proj, vol)
	if err != nil {
		return Thumb{}, err
	}
	sysIDs := make(map[string]bool, len(systems))
	nodes := make([]ThumbNode, 0, len(systems))
	for _, sys := range systems {
		sysIDs[sys.ID] = true
		p := layout[sys.ID]
		nodes = append(nodes, ThumbNode{ID: sys.ID, X: p.X, Y: p.Y, Type: sys.Type})
	}
	streams, err := s.ListStreams(proj, vol)
	if err != nil {
		return Thumb{}, err
	}
	seen := make(map[string]bool)
	var edges []ThumbEdge
	for _, st := range streams {
		sa, sb := st.Source.SystemID, st.Destination.SystemID
		if !sysIDs[sa] || !sysIDs[sb] {
			continue // dangling ref
		}
		var a, b string
		if sa < sb {
			a, b = sa, sb
		} else {
			a, b = sb, sa
		}
		key := a + "~" + b
		if seen[key] {
			continue
		}
		seen[key] = true
		edges = append(edges, ThumbEdge{A: a, B: b})
	}
	// HP-1: clusters for history plates — only members present in this volume;
	// zero-member (deleted-only) clusters omitted; stored order = paint order.
	clusters, err := s.ListClusters(proj, vol)
	if err != nil {
		return Thumb{}, err
	}
	var thumbClusters []ThumbCluster
	for _, c := range clusters {
		ids := make([]string, 0, len(c.SystemIDs))
		for _, id := range c.SystemIDs {
			if sysIDs[id] {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			continue
		}
		thumbClusters = append(thumbClusters, ThumbCluster{
			Color:     c.Color,
			SystemIDs: ids,
		})
	}
	return Thumb{Nodes: nodes, Edges: edges, Clusters: thumbClusters}, nil
}

// ---- Display (per-project canvas preferences) ----

func (s *Store) GetDisplay(proj string, vol volume.Volume) (Display, error) {
	if _, err := s.projectExists(proj); err != nil {
		return Display{}, err
	}
	unlock := s.lockRead(vol)
	defer unlock()
	d, err := readVol[Display](vol, displayFile)
	if err != nil {
		return Display{}, err
	}
	return d, nil
}

func (s *Store) SaveDisplay(proj string, vol volume.Volume, d Display) error {
	return s.mutateProject(proj, vol, func(v volume.Volume) error {
		return writeVol(v, displayFile, d)
	})
}

// ---- UserState (per-architect viewer prefs; disk-only, never versioned) ----

var archFileRe = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

// userStatePath maps (project, architect) to the on-disk state file. The
// architect id is sanitized into a safe filename component; anonymous
// callers land on "local".
func (s *Store) userStatePath(proj, arch string) (string, error) {
	if _, err := s.projectExists(proj); err != nil {
		return "", err
	}
	safe := archFileRe.ReplaceAllString(arch, "_")
	if safe == "" || safe == "." || safe == ".." {
		safe = "local"
	}
	return filepath.Join(s.root, userStateDir, proj, safe+".json"), nil
}

// GetUserState reads an architect's viewer state for a project (committed
// filter chips + whether filtering is enabled). A missing file reads as the
// zero value. Unlike display.json this never creates history commits — see
// the userStateDir comment for why it lives outside the git volume.
func (s *Store) GetUserState(proj, arch string) (UserState, error) {
	p, err := s.userStatePath(proj, arch)
	if err != nil {
		return UserState{}, err
	}
	return readJSON[UserState](p)
}

func (s *Store) SaveUserState(proj, arch string, st UserState) error {
	p, err := s.userStatePath(proj, arch)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return writeJSON(p, st)
}

// ---- Graph ----

// Graph returns everything the visualization needs in one payload.
type Graph struct {
	Project  Project            `json:"project"`
	Systems  []System           `json:"systems"`
	Streams  []Stream           `json:"streams"`
	Needs    []BizNeed          `json:"needs"`
	Flows    []Flow             `json:"flows"`
	Clusters []Cluster          `json:"clusters"`
	Layout   map[string]NodePos `json:"layout"`
	Display  Display            `json:"display"`
}

func (s *Store) GetGraph(proj string, vol volume.Volume) (Graph, error) {
	p, err := s.GetProject(proj, vol)
	if err != nil {
		return Graph{}, err
	}
	systems, err := s.ListSystems(proj, vol)
	if err != nil {
		return Graph{}, err
	}
	streams, err := s.ListStreams(proj, vol)
	if err != nil {
		return Graph{}, err
	}
	needs, err := s.ListNeeds(proj, vol)
	if err != nil {
		return Graph{}, err
	}
	flows, err := s.ListFlows(proj, vol)
	if err != nil {
		return Graph{}, err
	}
	clusters, err := s.ListClusters(proj, vol)
	if err != nil {
		return Graph{}, err
	}
	layout, err := s.GetLayout(proj, vol)
	if err != nil {
		return Graph{}, err
	}
	display, err := s.GetDisplay(proj, vol)
	if err != nil {
		return Graph{}, err
	}
	return Graph{
		Project: p, Systems: systems, Streams: streams, Needs: needs,
		Flows: flows, Clusters: clusters, Layout: layout, Display: display,
	}, nil
}

// Reconcile repairs cross-file referential integrity after a merge writes
// independent files to a volume: drop flow steps whose stream was removed,
// and drop stream endpoint entity/field refs that no longer exist in any
// system catalog. Idempotent; safe to call on an already-consistent volume.
func Reconcile(v volume.Volume) error {
	streams, err := readVol[[]Stream](v, StreamsFile)
	if err != nil {
		return err
	}
	present := map[string]bool{}
	for _, st := range streams {
		present[st.ID] = true
	}
	flows, err := readVol[[]Flow](v, FlowsFile)
	if err != nil {
		return err
	}
	flowChanged := false
	for i := range flows {
		n := slices.DeleteFunc(flows[i].Steps, func(s FlowStep) bool { return !present[s.StreamID] })
		if len(n) != len(flows[i].Steps) {
			flowChanged = true
			flows[i].Steps = n
		}
	}
	if flowChanged {
		if err := writeVol(v, FlowsFile, flows); err != nil {
			return err
		}
	}

	systems, err := readVol[[]System](v, SystemsFile)
	if err != nil {
		return err
	}
	entIDs, fldIDs := map[string]bool{}, map[string]bool{}
	for _, sys := range systems {
		for _, e := range sys.Entities {
			entIDs[e.ID] = true
			for _, f := range e.Fields {
				fldIDs[f.ID] = true
			}
		}
	}
	streamChanged := false
	for i := range streams {
		for _, ep := range []*Endpoint{&streams[i].Source, &streams[i].Destination} {
			n1 := slices.DeleteFunc(ep.EntityIDs, func(x string) bool { return !entIDs[x] })
			n2 := slices.DeleteFunc(ep.FieldIDs, func(x string) bool { return !fldIDs[x] })
			if len(n1) != len(ep.EntityIDs) || len(n2) != len(ep.FieldIDs) {
				streamChanged = true
			}
			ep.EntityIDs, ep.FieldIDs = n1, n2
		}
	}
	if streamChanged {
		if err := writeVol(v, StreamsFile, streams); err != nil {
			return err
		}
	}

	// Drop cluster member ids whose system did not survive the merge.
	sysPresent := map[string]bool{}
	for _, sys := range systems {
		sysPresent[sys.ID] = true
	}
	return stripClusterMembersAbsent(v, sysPresent)
}

// stripClusterMembersAbsent keeps only member ids that exist in sysPresent.
func stripClusterMembersAbsent(v volume.Volume, sysPresent map[string]bool) error {
	clusters, err := readVol[[]Cluster](v, ClustersFile)
	if err != nil {
		return err
	}
	if len(clusters) == 0 {
		return nil
	}
	changed := false
	for i := range clusters {
		n := slices.DeleteFunc(clusters[i].SystemIDs, func(id string) bool { return !sysPresent[id] })
		if len(n) != len(clusters[i].SystemIDs) {
			clusters[i].SystemIDs = n
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return writeVol(v, ClustersFile, clusters)
}

// WithLock runs fn while holding the store's write lock, so a merge (which
// writes main's working tree outside the normal request path) can't race a
// concurrent main write.
func (s *Store) WithLock(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn()
}

// mutateEntitiesOnVol is the per-file read-modify-write used by the create/
// update handlers that already hold the project lock via mutateProject.
func mutateEntitiesOnVol[T entity](v volume.Volume, file string, fn func([]T) ([]T, error)) error {
	items, err := readVol[[]T](v, file)
	if err != nil {
		return err
	}
	items, err = fn(items)
	if err != nil {
		return err
	}
	return writeVol(v, file, items)
}
