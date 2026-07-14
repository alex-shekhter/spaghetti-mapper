package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"

	"spaghettimapper/internal/store"
)

type API struct {
	store *store.Store
	log   *slog.Logger
}

func New(s *store.Store, log *slog.Logger) *API {
	return &API{store: s, log: log}
}

// Register mounts all API routes on mux.
func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects", a.listProjects)
	mux.HandleFunc("POST /api/projects", a.createProject)
	mux.HandleFunc("GET /api/projects/{proj}", a.getProject)
	mux.HandleFunc("PUT /api/projects/{proj}", a.updateProject)
	mux.HandleFunc("DELETE /api/projects/{proj}", a.deleteProject)

	mux.HandleFunc("GET /api/projects/{proj}/graph", a.getGraph)
	mux.HandleFunc("PUT /api/projects/{proj}/layout", a.saveLayout)
	mux.HandleFunc("GET /api/projects/{proj}/export", a.exportProject)
	mux.HandleFunc("POST /api/projects/import", a.importProject)

	mux.HandleFunc("GET /api/projects/{proj}/systems", a.listSystems)
	mux.HandleFunc("POST /api/projects/{proj}/systems", a.createSystem)
	mux.HandleFunc("PUT /api/projects/{proj}/systems/{id}", a.updateSystem)
	mux.HandleFunc("DELETE /api/projects/{proj}/systems/{id}", a.deleteSystem)

	mux.HandleFunc("GET /api/projects/{proj}/streams", a.listStreams)
	mux.HandleFunc("POST /api/projects/{proj}/streams", a.createStream)
	mux.HandleFunc("PUT /api/projects/{proj}/streams/{id}", a.updateStream)
	mux.HandleFunc("DELETE /api/projects/{proj}/streams/{id}", a.deleteStream)

	mux.HandleFunc("GET /api/projects/{proj}/needs", a.listNeeds)
	mux.HandleFunc("POST /api/projects/{proj}/needs", a.createNeed)
	mux.HandleFunc("PUT /api/projects/{proj}/needs/{id}", a.updateNeed)
	mux.HandleFunc("DELETE /api/projects/{proj}/needs/{id}", a.deleteNeed)

	mux.HandleFunc("GET /api/projects/{proj}/flows", a.listFlows)
	mux.HandleFunc("POST /api/projects/{proj}/flows", a.createFlow)
	mux.HandleFunc("PUT /api/projects/{proj}/flows/{id}", a.updateFlow)
	mux.HandleFunc("DELETE /api/projects/{proj}/flows/{id}", a.deleteFlow)
}

// ---- helpers ----

func (a *API) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		a.log.Error("encode response", "err", err)
	}
}

func (a *API) writeErr(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, store.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, store.ErrExists):
		status = http.StatusConflict
	case errors.Is(err, store.ErrInvalidName), errors.Is(err, errValidation):
		status = http.StatusBadRequest
	}
	if status == http.StatusInternalServerError {
		a.log.Error("api error", "err", err)
	}
	a.writeJSON(w, status, map[string]string{"error": err.Error()})
}

func decode[T any](r *http.Request) (T, error) {
	var v T
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		return v, fmt.Errorf("%w: %s", errValidation, err)
	}
	return v, nil
}

var errValidation = errors.New("validation")

func requireEnum(field, val string, allowed []string) error {
	if val == "" || slices.Contains(allowed, val) {
		return nil
	}
	return fmt.Errorf("%w: %s must be one of %v (got %q)", errValidation, field, allowed, val)
}

// ---- projects ----

type projectReq struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (a *API) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := a.store.ListProjects()
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, projects)
}

func (a *API) createProject(w http.ResponseWriter, r *http.Request) {
	req, err := decode[projectReq](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	p, err := a.store.CreateProject(req.Name, req.Description)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, p)
}

func (a *API) getProject(w http.ResponseWriter, r *http.Request) {
	p, err := a.store.GetProject(r.PathValue("proj"))
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, p)
}

func (a *API) updateProject(w http.ResponseWriter, r *http.Request) {
	req, err := decode[projectReq](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	p, err := a.store.UpdateProject(r.PathValue("proj"), req.Description)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, p)
}

func (a *API) deleteProject(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteProject(r.PathValue("proj")); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) getGraph(w http.ResponseWriter, r *http.Request) {
	g, err := a.store.GetGraph(r.PathValue("proj"))
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, g)
}

func (a *API) exportProject(w http.ResponseWriter, r *http.Request) {
	proj := r.PathValue("proj")
	b, err := a.store.ExportProject(proj)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", proj+".spaghetti.json"))
	a.writeJSON(w, http.StatusOK, b)
}

func (a *API) importProject(w http.ResponseWriter, r *http.Request) {
	b, err := decode[store.Bundle](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		name = b.Project.Name
	}
	p, err := a.store.ImportProject(name, b)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, p)
}

func (a *API) saveLayout(w http.ResponseWriter, r *http.Request) {
	layout, err := decode[map[string]store.NodePos](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if err := a.store.SaveLayout(r.PathValue("proj"), layout); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- systems ----

func validateSystem(s store.System) error {
	if s.Name == "" {
		return fmt.Errorf("%w: name is required", errValidation)
	}
	for _, e := range s.Entities {
		if e.Name == "" {
			return fmt.Errorf("%w: entity name is required", errValidation)
		}
		for _, f := range e.Fields {
			if f.Name == "" {
				return fmt.Errorf("%w: field name is required (entity %q)", errValidation, e.Name)
			}
		}
	}
	return requireEnum("type", s.Type, store.SystemTypes)
}

func (a *API) listSystems(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListSystems(r.PathValue("proj"))
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, items)
}

func (a *API) createSystem(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.System](r)
	if err == nil {
		err = validateSystem(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	created, err := a.store.CreateSystem(r.PathValue("proj"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, created)
}

func (a *API) updateSystem(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.System](r)
	if err == nil {
		err = validateSystem(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	updated, err := a.store.UpdateSystem(r.PathValue("proj"), r.PathValue("id"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteSystem(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteSystem(r.PathValue("proj"), r.PathValue("id")); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- streams ----

func validateStream(s store.Stream) error {
	if s.Name == "" {
		return fmt.Errorf("%w: name is required", errValidation)
	}
	if s.Source.SystemID == "" || s.Destination.SystemID == "" {
		return fmt.Errorf("%w: source.system_id and destination.system_id are required", errValidation)
	}
	checks := []error{
		requireEnum("timing", s.Timing, store.Timings),
		requireEnum("direction", s.Direction, store.Directions),
		requireEnum("status", s.Status, store.Statuses),
		requireEnum("source.fields_mode", s.Source.FieldsMode, store.FieldsModes),
		requireEnum("destination.fields_mode", s.Destination.FieldsMode, store.FieldsModes),
	}
	return errors.Join(checks...)
}

func (a *API) listStreams(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListStreams(r.PathValue("proj"))
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, items)
}

func (a *API) createStream(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.Stream](r)
	if err == nil {
		err = validateStream(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	created, err := a.store.CreateStream(r.PathValue("proj"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, created)
}

func (a *API) updateStream(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.Stream](r)
	if err == nil {
		err = validateStream(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	updated, err := a.store.UpdateStream(r.PathValue("proj"), r.PathValue("id"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteStream(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteStream(r.PathValue("proj"), r.PathValue("id")); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- business needs ----

func validateNeed(n store.BizNeed) error {
	if n.Name == "" {
		return fmt.Errorf("%w: name is required", errValidation)
	}
	return nil
}

func (a *API) listNeeds(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListNeeds(r.PathValue("proj"))
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, items)
}

func (a *API) createNeed(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.BizNeed](r)
	if err == nil {
		err = validateNeed(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	created, err := a.store.CreateNeed(r.PathValue("proj"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, created)
}

func (a *API) updateNeed(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.BizNeed](r)
	if err == nil {
		err = validateNeed(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	updated, err := a.store.UpdateNeed(r.PathValue("proj"), r.PathValue("id"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteNeed(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteNeed(r.PathValue("proj"), r.PathValue("id")); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- flows ----

func validateFlow(f store.Flow) error {
	if f.Name == "" {
		return fmt.Errorf("%w: name is required", errValidation)
	}
	return nil
}

func (a *API) listFlows(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.ListFlows(r.PathValue("proj"))
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, items)
}

func (a *API) createFlow(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.Flow](r)
	if err == nil {
		err = validateFlow(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	created, err := a.store.CreateFlow(r.PathValue("proj"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, created)
}

func (a *API) updateFlow(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.Flow](r)
	if err == nil {
		err = validateFlow(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	updated, err := a.store.UpdateFlow(r.PathValue("proj"), r.PathValue("id"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteFlow(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteFlow(r.PathValue("proj"), r.PathValue("id")); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
