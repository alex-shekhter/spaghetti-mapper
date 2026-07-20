package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-git/go-git/v5/plumbing"

	"spaghettimapper/internal/auth"
	"spaghettimapper/internal/report"
	"spaghettimapper/internal/store"
	"spaghettimapper/internal/vcs"
	"spaghettimapper/internal/volume"
)

type API struct {
	store        *store.Store
	auth         *auth.Store
	vcs          *vcs.Manager
	hub          *hub
	log          *slog.Logger
	authEnabled  bool
	secureCookie bool // true when serving over TLS
}

func New(s *store.Store, a *auth.Store, v *vcs.Manager, log *slog.Logger, authEnabled, secure bool) *API {
	return &API{store: s, auth: a, vcs: v, hub: newHub(), log: log, authEnabled: authEnabled, secureCookie: secure}
}

// Register mounts all API routes on mux.
func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/status", a.authStatus)
	mux.HandleFunc("POST /api/auth/setup", a.authSetup)
	mux.HandleFunc("POST /api/auth/login", a.authLogin)
	mux.HandleFunc("POST /api/auth/logout", a.authLogout)
	mux.HandleFunc("GET /api/auth/me", a.authMe)
	mux.HandleFunc("GET /api/auth/tokens", a.listTokens)
	mux.HandleFunc("POST /api/auth/tokens", a.createToken)
	mux.HandleFunc("DELETE /api/auth/tokens/{id}", a.deleteToken)
	mux.HandleFunc("POST /api/auth/users", a.createUser)

	mux.HandleFunc("GET /api/projects", a.listProjects)
	mux.HandleFunc("POST /api/projects", a.createProject)
	mux.HandleFunc("GET /api/projects/{proj}", a.getProject)
	mux.HandleFunc("PUT /api/projects/{proj}", a.updateProject)
	mux.HandleFunc("DELETE /api/projects/{proj}", a.deleteProject)

	mux.HandleFunc("GET /api/projects/{proj}/graph", a.getGraph)
	mux.HandleFunc("PUT /api/projects/{proj}/layout", a.saveLayout)
	mux.HandleFunc("GET /api/projects/{proj}/display", a.getDisplay)
	mux.HandleFunc("PUT /api/projects/{proj}/display", a.saveDisplay)
	mux.HandleFunc("GET /api/projects/{proj}/userstate", a.getUserState)
	mux.HandleFunc("PUT /api/projects/{proj}/userstate", a.saveUserState)
	mux.HandleFunc("GET /api/projects/{proj}/export", a.exportProject)
	mux.HandleFunc("GET /api/projects/{proj}/report", a.reportProject)
	mux.HandleFunc("POST /api/projects/{proj}/report", a.reportProject)
	mux.HandleFunc("POST /api/projects/import", a.importProject)

	mux.HandleFunc("GET /api/projects/{proj}/systems", a.listSystems)
	mux.HandleFunc("POST /api/projects/{proj}/systems", a.createSystem)
	mux.HandleFunc("POST /api/projects/{proj}/systems/batch", a.batchSystems)
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

	mux.HandleFunc("GET /api/projects/{proj}/clusters", a.listClusters)
	mux.HandleFunc("POST /api/projects/{proj}/clusters", a.createCluster)
	mux.HandleFunc("PUT /api/projects/{proj}/clusters/{id}", a.updateCluster)
	mux.HandleFunc("DELETE /api/projects/{proj}/clusters/{id}", a.deleteCluster)

	mux.HandleFunc("GET /api/projects/{proj}/flows", a.listFlows)
	mux.HandleFunc("POST /api/projects/{proj}/flows", a.createFlow)
	mux.HandleFunc("PUT /api/projects/{proj}/flows/{id}", a.updateFlow)
	mux.HandleFunc("DELETE /api/projects/{proj}/flows/{id}", a.deleteFlow)

	mux.HandleFunc("GET /api/projects/{proj}/architects", a.listArchitects)
	mux.HandleFunc("DELETE /api/projects/{proj}/architects/{id}", a.deleteArchitect)
	mux.HandleFunc("POST /api/projects/{proj}/architects/{id}/merge", a.mergeArchitect)
	mux.HandleFunc("GET /api/projects/{proj}/events", a.events)

	// Version history (undo/redo/restore + read-only preview). The line is the
	// caller's write target: their branch when signed in, main when solo.
	mux.HandleFunc("GET /api/projects/{proj}/history", a.getHistory)
	mux.HandleFunc("GET /api/projects/{proj}/history/thumb", a.historyThumb)
	mux.HandleFunc("POST /api/projects/{proj}/undo", a.undo)
	mux.HandleFunc("POST /api/projects/{proj}/redo", a.redo)
	mux.HandleFunc("POST /api/projects/{proj}/history/restore", a.restoreVersion)
}

// CommitMiddleware records every successful mutating request as a git commit
// on the project's repo, authored by the architect from the request context
// (or "local" when identity is off / setup mode). The commit target is the
// volume the handler resolved and stashed (disk → main, branch → the
// architect's branch). Create and import commit themselves (the project name
// isn't in the URL there). Best-effort: never blocks a response.
func (a *API) CommitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		if a.vcs == nil || !mutationMethod(r.Method) || !strings.HasPrefix(r.URL.Path, "/api/projects/") {
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
		proj := parts[0]
		if proj == "" || proj == "import" {
			return // handled in-handler
		}
		// systems/batch commits in-handler with a real message ("delete 4 systems"
		// / "set type on 3 systems"); auto-stamp would lie as "create systems".
		if len(parts) >= 3 && parts[1] == "systems" && parts[2] == "batch" {
			if vol := volFromCtx(r); vol != nil {
				vol.Release()
			}
			return
		}
		// report is read-only (GET/POST only differ by optional map PNG body).
		if len(parts) >= 2 && parts[1] == "report" {
			if vol := volFromCtx(r); vol != nil {
				vol.Release()
			}
			return
		}
		vol := volFromCtx(r)
		if vol == nil {
			return // read-only or unresolvable; nothing to commit
		}
		a.commitVol(r, vol, commitMsg(r.Method, parts))
		vol.Release() // free any per-branch write lock held for this request
	})
}

func mutationMethod(m string) bool {
	switch m {
	case http.MethodPost, http.MethodPut, http.MethodDelete:
		return true
	}
	return false
}

func commitMsg(method string, parts []string) string {
	verb := "update"
	switch method {
	case "POST":
		verb = "create"
	case "DELETE":
		verb = "delete"
	}
	res := "project"
	if len(parts) > 1 && parts[1] != "" {
		res = parts[1]
	}
	return verb + " " + res
}

// ---- volume resolution (disk = main, branch = architect workspace) ----

type volCtxKey int

const volKey volCtxKey = 1

// withVol stashes the request's volume on the request context in a way the
// CommitMiddleware (which shares this *http.Request) can read back after the
// handler returns.
func withVol(r *http.Request, vol volume.Volume) {
	*r = *r.WithContext(context.WithValue(r.Context(), volKey, vol))
}

func volFromCtx(r *http.Request) volume.Volume {
	if v, ok := r.Context().Value(volKey).(volume.Volume); ok {
		return v
	}
	return nil
}

// architect returns the commit author for the request: the authenticated user
// (username + display name), or "local" when identity is off / setup mode.
func (a *API) architect(r *http.Request) (id, name string) {
	uid, _ := auth.UserFromContext(r.Context())
	if uid == "" {
		return "local", "Local"
	}
	if u := a.auth.User(uid); u != nil && u.Name != "" {
		return uid, u.Name
	}
	return uid, uid
}

// resolveArch picks whose line the request targets. Writes go to the caller's
// own branch (or main when anonymous). Reads honour ?arch= (main → main,
// <id> → that architect's branch) and otherwise default to the caller's own
// branch so an architect sees their own edits.
func (a *API) resolveArch(r *http.Request, forWrite bool) string {
	uid, _ := auth.UserFromContext(r.Context())
	if forWrite {
		return uid
	}
	q := r.URL.Query().Get("arch")
	if q == "main" {
		return ""
	}
	if q != "" {
		return q
	}
	return uid
}

// vol builds (and stashes) the volume for a request: a disk volume for the
// main line, or a branch volume for an architect's workspace. Returns an
// error if the project doesn't exist (caller surfaces 404).
func (a *API) vol(r *http.Request, proj string, forWrite bool) (volume.Volume, error) {
	arch := a.resolveArch(r, forWrite)
	var v volume.Volume
	var err error
	if arch == "" {
		v, err = a.vcs.NewDiskVolume(proj)
	} else {
		v, err = a.vcs.NewBranchVolume(proj, arch, forWrite)
	}
	if err == nil {
		withVol(r, v)
	}
	return v, err
}

// commitVol flushes a volume with the request's architect as author, then
// notifies subscribers that the project's branches/main changed.
func (a *API) commitVol(r *http.Request, vol volume.Volume, msg string) {
	id, name := a.architect(r)
	if err := vol.Commit(id, name, msg); err != nil {
		a.log.Error("vcs commit", "err", err)
		return
	}
	if proj := projectFromRequest(r); proj != "" {
		a.hub.publish(proj, Event{Type: "commit", Arch: id, Msg: msg})
	}
}

// projectFromRequest extracts the {proj} path value when present.
func projectFromRequest(r *http.Request) string { return r.PathValue("proj") }

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
	case errors.Is(err, store.ErrNotFound), errors.Is(err, auth.ErrUserNotFound), errors.Is(err, auth.ErrTokenNotFound):
		status = http.StatusNotFound
	case errors.Is(err, store.ErrExists), errors.Is(err, auth.ErrUserExists):
		status = http.StatusConflict
	case errors.Is(err, auth.ErrBadPassword):
		status = http.StatusUnauthorized
	case errors.Is(err, auth.ErrPasswordShort), errors.Is(err, store.ErrInvalidName),
		errors.Is(err, store.ErrValidation), errors.Is(err, errValidation):
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
	if dv, err := a.vcs.NewDiskVolume(req.Name); err == nil {
		a.commitVol(r, dv, "create project")
	}
}

func (a *API) getProject(w http.ResponseWriter, r *http.Request) {
	vol, err := a.vol(r, r.PathValue("proj"), false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	p, err := a.store.GetProject(r.PathValue("proj"), vol)
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
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	p, err := a.store.UpdateProject(r.PathValue("proj"), vol, req.Description)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, p)
}

func (a *API) deleteProject(w http.ResponseWriter, r *http.Request) {
	proj := r.PathValue("proj")
	if err := a.store.DeleteProject(proj); err != nil {
		a.writeErr(w, err)
		return
	}
	a.vcs.Evict(proj)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) getGraph(w http.ResponseWriter, r *http.Request) {
	proj := r.PathValue("proj")
	// Read-only preview of a specific version (?at=<sha>): serve that
	// commit's tree via a CommitVolume so the canvas can show a past (or
	// redo-future) version without touching the live line.
	if at := r.URL.Query().Get("at"); at != "" {
		hash := plumbing.NewHash(at)
		vol, err := a.vcs.NewCommitVolume(proj, hash)
		if err != nil {
			a.writeErr(w, err)
			return
		}
		g, err := a.store.GetGraph(proj, vol)
		if err != nil {
			a.writeErr(w, err)
			return
		}
		a.writeJSON(w, http.StatusOK, g)
		return
	}
	vol, err := a.vol(r, proj, false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	g, err := a.store.GetGraph(proj, vol)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, g)
}

func (a *API) exportProject(w http.ResponseWriter, r *http.Request) {
	proj := r.PathValue("proj")
	vol, err := a.vol(r, proj, false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	b, err := a.store.ExportProject(proj, vol)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", proj+".spaghetti.json"))
	a.writeJSON(w, http.StatusOK, b)
}

// reportBody is the optional POST body for embedding a canvas PNG (RG-4).
type reportBody struct {
	MapPNG string `json:"map_png"`
}

// reportProject serves the integration-register .xlsx (GET or POST).
// Volume resolution matches exportProject (?arch= selects Mine/Main).
// POST may include map_png (base64); above 4 MB decoded → 400.
func (a *API) reportProject(w http.ResponseWriter, r *http.Request) {
	proj := r.PathValue("proj")
	vol, err := a.vol(r, proj, false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	g, err := a.store.GetGraph(proj, vol)
	if err != nil {
		a.writeErr(w, err)
		return
	}

	var mapPNG report.MapPNG
	if r.Method == http.MethodPost {
		body, err := decode[reportBody](r)
		if err != nil {
			a.writeErr(w, err)
			return
		}
		raw := strings.TrimSpace(body.MapPNG)
		if raw != "" {
			if i := strings.Index(raw, ","); i >= 0 && strings.HasPrefix(raw, "data:") {
				raw = raw[i+1:]
			}
			decoded, err := base64.StdEncoding.DecodeString(raw)
			if err != nil {
				a.writeErr(w, fmt.Errorf("%w: map_png is not valid base64", errValidation))
				return
			}
			if len(decoded) > report.MaxMapPNGBytes {
				a.writeErr(w, fmt.Errorf("%w: map_png exceeds 4 MB", errValidation))
				return
			}
			// RF-1: client-supplied map must be a plausible PNG (signature + header).
			// Bad picture input is always 400, never excelize 500.
			pngSig := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
			if len(decoded) < 8 || !bytes.Equal(decoded[:8], pngSig) {
				a.writeErr(w, fmt.Errorf("%w: map_png is not a valid PNG", errValidation))
				return
			}
			if _, err := png.DecodeConfig(bytes.NewReader(decoded)); err != nil {
				a.writeErr(w, fmt.Errorf("%w: map_png is not a valid PNG", errValidation))
				return
			}
			mapPNG = report.MapPNG(body.MapPNG)
		}
	}

	view := "My workspace"
	if a.resolveArch(r, false) == "" {
		view = "Main"
	}
	when := time.Now().Format("2006-01-02")
	f, err := report.Workbook(g, report.Meta{Project: proj, View: view, When: when}, mapPNG)
	if err != nil {
		// RF-1 belt-and-braces: embed-path picture failures stay client errors.
		if mapPNG != "" {
			a.writeErr(w, fmt.Errorf("%w: map_png is not a valid PNG", errValidation))
			return
		}
		a.writeErr(w, err)
		return
	}
	defer f.Close()

	filename := fmt.Sprintf("%s-integration-register-%s.xlsx", proj, when)
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	if err := f.Write(w); err != nil {
		a.log.Error("report write", "err", err)
	}
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
	if dv, err := a.vcs.NewDiskVolume(name); err == nil {
		a.commitVol(r, dv, "import project")
	}
}

func (a *API) saveLayout(w http.ResponseWriter, r *http.Request) {
	layout, err := decode[map[string]store.NodePos](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if err := a.store.SaveLayout(r.PathValue("proj"), vol, layout); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) getDisplay(w http.ResponseWriter, r *http.Request) {
	vol, err := a.vol(r, r.PathValue("proj"), false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	d, err := a.store.GetDisplay(r.PathValue("proj"), vol)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, d)
}

func (a *API) saveDisplay(w http.ResponseWriter, r *http.Request) {
	d, err := decode[store.Display](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if err := a.store.SaveDisplay(r.PathValue("proj"), vol, d); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- userstate (the caller's own per-project viewer state) ----
// Keyed by architect identity, never by ?arch= — you can't read or write
// someone else's view. No volume, no commit: filter changes must not create
// history entries or travel with merges/exports.

func (a *API) getUserState(w http.ResponseWriter, r *http.Request) {
	arch, _ := a.architect(r)
	st, err := a.store.GetUserState(r.PathValue("proj"), arch)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, st)
}

func (a *API) saveUserState(w http.ResponseWriter, r *http.Request) {
	st, err := decode[store.UserState](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	arch, _ := a.architect(r)
	if err := a.store.SaveUserState(r.PathValue("proj"), arch, st); err != nil {
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
	vol, err := a.vol(r, r.PathValue("proj"), false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	items, err := a.store.ListSystems(r.PathValue("proj"), vol)
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
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	created, err := a.store.CreateSystem(r.PathValue("proj"), vol, item)
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
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	updated, err := a.store.UpdateSystem(r.PathValue("proj"), vol, r.PathValue("id"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteSystem(w http.ResponseWriter, r *http.Request) {
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if err := a.store.DeleteSystem(r.PathValue("proj"), vol, r.PathValue("id")); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// batchSystems applies delete / set_type ops in one commit. Message is
// user-visible history copy: "delete 4 systems" / "set type on 3 systems".
type batchSystemsReq struct {
	Ops []store.SystemOp `json:"ops"`
}

func batchSystemsCommitMsg(ops []store.SystemOp) string {
	nDel, nType := 0, 0
	for _, op := range ops {
		switch op.Op {
		case "delete":
			nDel++
		case "set_type":
			nType++
		}
	}
	// Homogeneous batches from the UI; mixed falls back to a neutral stamp.
	if nDel > 0 && nType == 0 {
		return "delete " + pluralCount(nDel, "system")
	}
	if nType > 0 && nDel == 0 {
		return "set type on " + pluralCount(nType, "system")
	}
	return "update systems"
}

func pluralCount(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func (a *API) batchSystems(w http.ResponseWriter, r *http.Request) {
	req, err := decode[batchSystemsReq](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if err := a.store.BatchSystems(r.PathValue("proj"), vol, req.Ops); err != nil {
		a.writeErr(w, err)
		return
	}
	// Commit here (middleware skips this path) so the history row tells the truth.
	a.commitVol(r, vol, batchSystemsCommitMsg(req.Ops))
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
	vol, err := a.vol(r, r.PathValue("proj"), false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	items, err := a.store.ListStreams(r.PathValue("proj"), vol)
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
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	created, err := a.store.CreateStream(r.PathValue("proj"), vol, item)
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
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	updated, err := a.store.UpdateStream(r.PathValue("proj"), vol, r.PathValue("id"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteStream(w http.ResponseWriter, r *http.Request) {
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if err := a.store.DeleteStream(r.PathValue("proj"), vol, r.PathValue("id")); err != nil {
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
	vol, err := a.vol(r, r.PathValue("proj"), false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	items, err := a.store.ListNeeds(r.PathValue("proj"), vol)
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
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	created, err := a.store.CreateNeed(r.PathValue("proj"), vol, item)
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
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	updated, err := a.store.UpdateNeed(r.PathValue("proj"), vol, r.PathValue("id"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteNeed(w http.ResponseWriter, r *http.Request) {
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if err := a.store.DeleteNeed(r.PathValue("proj"), vol, r.PathValue("id")); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- clusters ----
// Commit middleware auto-stamps create/update/delete clusters (no custom message).

func validateClusterAPI(c store.Cluster) error {
	if strings.TrimSpace(c.Name) == "" {
		return fmt.Errorf("%w: name is required", errValidation)
	}
	if c.Color != "" && !slices.Contains(store.ClusterColors, c.Color) {
		return fmt.Errorf("%w: color must be one of %v (got %q)", errValidation, store.ClusterColors, c.Color)
	}
	return nil
}

func (a *API) listClusters(w http.ResponseWriter, r *http.Request) {
	vol, err := a.vol(r, r.PathValue("proj"), false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	items, err := a.store.ListClusters(r.PathValue("proj"), vol)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, items)
}

func (a *API) createCluster(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.Cluster](r)
	if err == nil {
		err = validateClusterAPI(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	created, err := a.store.CreateCluster(r.PathValue("proj"), vol, item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, created)
}

func (a *API) updateCluster(w http.ResponseWriter, r *http.Request) {
	item, err := decode[store.Cluster](r)
	if err == nil {
		err = validateClusterAPI(item)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	updated, err := a.store.UpdateCluster(r.PathValue("proj"), vol, r.PathValue("id"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteCluster(w http.ResponseWriter, r *http.Request) {
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if err := a.store.DeleteCluster(r.PathValue("proj"), vol, r.PathValue("id")); err != nil {
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
	vol, err := a.vol(r, r.PathValue("proj"), false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	items, err := a.store.ListFlows(r.PathValue("proj"), vol)
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
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	created, err := a.store.CreateFlow(r.PathValue("proj"), vol, item)
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
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	updated, err := a.store.UpdateFlow(r.PathValue("proj"), vol, r.PathValue("id"), item)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteFlow(w http.ResponseWriter, r *http.Request) {
	vol, err := a.vol(r, r.PathValue("proj"), true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	if err := a.store.DeleteFlow(r.PathValue("proj"), vol, r.PathValue("id")); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- auth ----

type authReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

// authStatus tells the SPA which gate to show: needs-setup, login, or app.
// Always public.
func (a *API) authStatus(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserFromContext(r.Context())
	resp := map[string]any{
		"auth_enabled": a.authEnabled,
		"needs_setup":  a.authEnabled && !a.auth.HasUsers(),
	}
	if uid != "" {
		if u := a.auth.User(uid); u != nil {
			resp["user"] = u
		}
	}
	a.writeJSON(w, http.StatusOK, resp)
}

// authSetup creates the first user (admin). Only allowed while no users
// exist; logs the new user in by setting a session cookie.
func (a *API) authSetup(w http.ResponseWriter, r *http.Request) {
	if a.auth.HasUsers() {
		a.writeErr(w, fmt.Errorf("%w: setup already complete", errValidation))
		return
	}
	req, err := decode[authReq](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	name := req.Name
	if name == "" {
		name = req.Username
	}
	u, err := a.auth.CreateUser(req.Username, name, req.Password, true)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.issueSession(w, u.ID)
	a.writeJSON(w, http.StatusCreated, u)
}

func (a *API) authLogin(w http.ResponseWriter, r *http.Request) {
	req, err := decode[authReq](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	u, err := a.auth.Verify(req.Username, req.Password)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.issueSession(w, u.ID)
	a.writeJSON(w, http.StatusOK, u)
}

func (a *API) authLogout(w http.ResponseWriter, r *http.Request) {
	a.auth.ClearSessionCookie(w, a.secureCookie)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) authMe(w http.ResponseWriter, r *http.Request) {
	uid, ok := auth.UserFromContext(r.Context())
	if !ok || uid == "" {
		a.writeJSON(w, http.StatusOK, map[string]any{"user": nil})
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{"user": a.auth.User(uid)})
}

func (a *API) issueSession(w http.ResponseWriter, uid string) {
	token, _ := a.auth.IssueSession(uid)
	a.auth.SetSessionCookie(w, token, a.secureCookie)
}

// ---- API tokens (machine identity for AI agents) ----

type tokenReq struct {
	Name string `json:"name"`
}

func (a *API) listTokens(w http.ResponseWriter, r *http.Request) {
	uid, ok := auth.UserFromContext(r.Context())
	if !ok {
		a.writeErr(w, fmt.Errorf("%w: unauthorized", errValidation))
		return
	}
	a.writeJSON(w, http.StatusOK, a.auth.ListTokens(uid))
}

func (a *API) createToken(w http.ResponseWriter, r *http.Request) {
	uid, ok := auth.UserFromContext(r.Context())
	if !ok {
		a.writeErr(w, fmt.Errorf("%w: unauthorized", errValidation))
		return
	}
	req, err := decode[tokenReq](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	id, secret, err := a.auth.CreateToken(uid, req.Name)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, map[string]string{"id": id, "secret": secret})
}

func (a *API) deleteToken(w http.ResponseWriter, r *http.Request) {
	uid, ok := auth.UserFromContext(r.Context())
	if !ok {
		a.writeErr(w, fmt.Errorf("%w: unauthorized", errValidation))
		return
	}
	if err := a.auth.DeleteToken(uid, r.PathValue("id")); err != nil {
		a.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// createUser lets an admin add an architect (so a deployment can invite
// collaborators / register AI-agent owners without re-running setup).
func (a *API) createUser(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserFromContext(r.Context())
	u := a.auth.User(uid)
	if u == nil || !u.IsAdmin {
		a.writeErr(w, fmt.Errorf("%w: admin only", errValidation))
		return
	}
	req, err := decode[authReq](r)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	name := req.Name
	if name == "" {
		name = req.Username
	}
	created, err := a.auth.CreateUser(req.Username, name, req.Password, false)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, created)
}

// ---- architects (visibility) ----

func (a *API) listArchitects(w http.ResponseWriter, r *http.Request) {
	list, err := a.vcs.ListArchitects(r.PathValue("proj"))
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, list)
}

func (a *API) deleteArchitect(w http.ResponseWriter, r *http.Request) {
	if err := a.vcs.DeleteArchitect(r.PathValue("proj"), r.PathValue("id")); err != nil {
		a.writeErr(w, err)
		return
	}
	a.hub.publish(r.PathValue("proj"), Event{Type: "abort", Arch: r.PathValue("id")})
	w.WriteHeader(http.StatusNoContent)
}

// mergeArchitect combines an architect's branch into main. The body may carry
// resolutions: {"resolutions": {"<file>:<id>": "ours"|"theirs"}}. On clean
// merge (or after all conflicts are resolved) main advances and the branch is
// dropped; on unresolved hard conflicts it returns 409 with the conflict list.
type mergeReq struct {
	Resolutions map[string]string `json:"resolutions"`
}

func (a *API) mergeArchitect(w http.ResponseWriter, r *http.Request) {
	proj := r.PathValue("proj")
	archID := r.PathValue("id")
	req, _ := decode[mergeReq](r) // body optional on first attempt
	whoID, whoName := a.architect(r)

	var out vcs.MergeOutcome
	var merr error
	a.store.WithLock(func() {
		out, merr = a.vcs.MergeArchitect(proj, archID, whoID, whoName, req.Resolutions)
	})
	if merr != nil {
		a.log.Error("merge", "proj", proj, "arch", archID, "err", merr)
		a.writeErr(w, merr)
		return
	}
	if len(out.Conflicts) > 0 {
		a.writeJSON(w, http.StatusConflict, out)
		return
	}
	if !out.Merged {
		a.writeErr(w, store.ErrNotFound)
		return
	}
	a.hub.publish(proj, Event{Type: "merge", Arch: archID})
	a.writeJSON(w, http.StatusOK, out)
}

// ---- version history ----

// historyLine returns the line an undo/redo acts on: the caller's write
// target (their branch when signed in, main when solo).
func (a *API) historyLine(r *http.Request) string { return a.resolveArch(r, true) }

// runHistory runs a vcs history op, holding the store lock for main-line ops
// (which reset the shared working tree) but not for branch ops (serialized by
// the per-branch lock inside vcs). It then publishes a commit event so live
// viewers (the Workspace graph + Architects panel) refresh.
func (a *API) runHistory(w http.ResponseWriter, r *http.Request, proj, msg string, op func(arch string) (vcs.HistoryResult, error)) {
	arch := a.historyLine(r)
	var res vcs.HistoryResult
	var err error
	if arch == "" {
		a.store.WithLock(func() { res, err = op(arch) })
	} else {
		res, err = op(arch)
	}
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.hub.publish(proj, Event{Type: "commit", Arch: arch, Msg: msg})
	a.writeJSON(w, http.StatusOK, res)
}

func (a *API) getHistory(w http.ResponseWriter, r *http.Request) {
	arch := a.resolveArch(r, false)
	res, err := a.vcs.History(r.PathValue("proj"), arch)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, res)
}

// historyThumb returns a compact {nodes,edges} thumbnail payload for a past
// (or redo-future) version addressed by ?at=<sha>, via a read-only
// CommitVolume over that commit's tree. One tiny request per visible history
// row; the client caches by sha. Runs read-only (no store lock beyond the
// CommitVolume's repo.mu).
func (a *API) historyThumb(w http.ResponseWriter, r *http.Request) {
	proj := r.PathValue("proj")
	at := r.URL.Query().Get("at")
	if at == "" {
		a.writeErr(w, fmt.Errorf("%w: missing 'at'", errValidation))
		return
	}
	vol, err := a.vcs.NewCommitVolume(proj, plumbing.NewHash(at))
	if err != nil {
		a.writeErr(w, err)
		return
	}
	thumb, err := a.store.ThumbGraph(proj, vol)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	a.writeJSON(w, http.StatusOK, thumb)
}

func (a *API) undo(w http.ResponseWriter, r *http.Request) {
	a.runHistory(w, r, r.PathValue("proj"), "undo", func(arch string) (vcs.HistoryResult, error) {
		return a.vcs.Undo(r.PathValue("proj"), arch)
	})
}

func (a *API) redo(w http.ResponseWriter, r *http.Request) {
	a.runHistory(w, r, r.PathValue("proj"), "redo", func(arch string) (vcs.HistoryResult, error) {
		return a.vcs.Redo(r.PathValue("proj"), arch)
	})
}

type restoreReq struct {
	To string `json:"to"`
}

func (a *API) restoreVersion(w http.ResponseWriter, r *http.Request) {
	req, err := decode[restoreReq](r)
	if err != nil || req.To == "" {
		a.writeErr(w, fmt.Errorf("%w: missing 'to'", errValidation))
		return
	}
	sha := plumbing.NewHash(req.To)
	a.runHistory(w, r, r.PathValue("proj"), "restore", func(arch string) (vcs.HistoryResult, error) {
		return a.vcs.RestoreTo(r.PathValue("proj"), arch, sha)
	})
}
