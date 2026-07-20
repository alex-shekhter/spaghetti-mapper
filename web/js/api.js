// Thin fetch wrapper over the SpaghettiMapper REST API.

// On 401 the caller gets an UnauthError so the app can route to login.
export class UnauthError extends Error {
  constructor() { super("unauthorized"); this.name = "UnauthError"; }
}

// Global hook: app.js registers a handler so any 401 flips the UI to the
// auth gate without each call site having to catch it.
let onUnauth = null;
export function setOnUnauth(fn) { onUnauth = fn; }

// viewMode selects which line reads target: "me" (the signed-in architect's
// own workspace — the server default when no ?arch is sent) or "main" (the
// canonical map). Writes always go to the caller's own workspace. Anonymous
// users (no auth) always read main, so this has no effect there.
// DR-3: persist Mine · Main across reloads (per-browser localStorage). Only
// "me" | "main" are stored; anything else falls back to "me".
const van = window.van;
const VIEW_MODE_KEY = "sm.viewMode";
const loadViewMode = () => {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "main" ? "main" : "me";
  } catch {
    return "me";
  }
};
export const viewMode = van.state(loadViewMode());
van.derive(() => {
  const v = viewMode.val === "main" ? "main" : "me";
  try { localStorage.setItem(VIEW_MODE_KEY, v); } catch { /* private mode */ }
});

function archQuery() {
  return viewMode.val === "main" ? "?arch=main" : "";
}

async function req(method, path, body) {
  let targetPath = path;
  if (method === "GET") {
    const cb = Date.now() + "_" + Math.random().toString(36).substring(2, 9);
    targetPath = path + (path.includes("?") ? "&" : "?") + "cb=" + cb;
  }
  const res = await fetch(targetPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    if (onUnauth) onUnauth();
    throw new UnauthError();
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

const enc = (s) => encodeURIComponent(s);
const crud = (base) => ({
  list: (proj) => req("GET", `${base(proj)}${archQuery()}`),
  create: (proj, item) => req("POST", `${base(proj)}`, item),
  update: (proj, id, item) => req("PUT", `${base(proj)}/${id}`, item),
  del: (proj, id) => req("DELETE", `${base(proj)}/${id}`),
});

export const api = {
  auth: {
    status: () => req("GET", "/api/auth/status"),
    setup: (username, password, name) => req("POST", "/api/auth/setup", { username, password, name }),
    login: (username, password) => req("POST", "/api/auth/login", { username, password }),
    logout: () => req("POST", "/api/auth/logout"),
    me: () => req("GET", "/api/auth/me"),
    createUser: (username, password, name) => req("POST", "/api/auth/users", { username, password, name }),
    tokens: {
      list: () => req("GET", "/api/auth/tokens"),
      create: (name) => req("POST", "/api/auth/tokens", { name }),
      del: (id) => req("DELETE", `/api/auth/tokens/${id}`),
    },
  },
  architects: {
    list: (proj) => req("GET", `/api/projects/${enc(proj)}/architects`),
    abort: (proj, id) => req("DELETE", `/api/projects/${enc(proj)}/architects/${id}`),
    // merge returns {status, data} so the caller can read 409 conflict bodies
    // (the generic req() would throw on non-2xx and lose the structured result).
    merge: async (proj, id, resolutions) => {
      const res = await fetch(`/api/projects/${enc(proj)}/architects/${id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutions: resolutions || {} }),
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    },
  },
  history: {
    get: (proj) => req("GET", `/api/projects/${enc(proj)}/history${archQuery()}`),
    undo: (proj) => req("POST", `/api/projects/${enc(proj)}/undo`),
    redo: (proj) => req("POST", `/api/projects/${enc(proj)}/redo`),
    restore: (proj, sha) => req("POST", `/api/projects/${enc(proj)}/history/restore`, { to: sha }),
    // Preview a specific version read-only (no archQuery: the version is
    // addressed by its commit sha, not by the live line).
    previewGraph: (proj, sha) => req("GET", `/api/projects/${enc(proj)}/graph?at=${enc(sha)}`),
    // Compact thumbnail payload {nodes:[{id,x,y,type}], edges:[{a,b}]} for a
    // past version, one tiny request per visible history row (cached by sha).
    thumb: (proj, sha) => req("GET", `/api/projects/${enc(proj)}/history/thumb?at=${enc(sha)}`),
  },
  projects: {
    list: () => req("GET", "/api/projects"),
    create: (p) => req("POST", "/api/projects", p),
    update: (name, p) => req("PUT", `/api/projects/${enc(name)}`, p),
    del: (name) => req("DELETE", `/api/projects/${enc(name)}`),
  },
  graph: (proj) => req("GET", `/api/projects/${enc(proj)}/graph${archQuery()}`),
  saveLayout: (proj, layout) => req("PUT", `/api/projects/${enc(proj)}/layout`, layout),
  getDisplay: (proj) => req("GET", `/api/projects/${enc(proj)}/display${archQuery()}`),
  saveDisplay: (proj, display) => req("PUT", `/api/projects/${enc(proj)}/display`, display),
  // The caller's own per-project viewer state (committed filters +
  // filter-enabled). Never takes archQuery: it's always yours, on any view.
  getUserState: (proj) => req("GET", `/api/projects/${enc(proj)}/userstate`),
  saveUserState: (proj, st) => req("PUT", `/api/projects/${enc(proj)}/userstate`, st),
  exportURL: (proj) => `/api/projects/${enc(proj)}/export${archQuery()}`,
  reportURL: (proj) => `/api/projects/${enc(proj)}/report${archQuery()}`,
  importProject: (bundle, name) => req("POST", `/api/projects/import?name=${enc(name)}`, bundle),
  systems: crud((p) => `/api/projects/${enc(p)}/systems`),
  // One POST = one git commit for group actions (delete / set_type).
  systemsBatch: (proj, ops) => req("POST", `/api/projects/${enc(proj)}/systems/batch`, { ops }),
  streams: crud((p) => `/api/projects/${enc(p)}/streams`),
  needs: crud((p) => `/api/projects/${enc(p)}/needs`),
  flows: crud((p) => `/api/projects/${enc(p)}/flows`),
  clusters: crud((p) => `/api/projects/${enc(p)}/clusters`),
};