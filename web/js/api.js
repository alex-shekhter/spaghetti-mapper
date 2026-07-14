// Thin fetch wrapper over the SpaghettiMapper REST API.

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

const crud = (base) => ({
  list: (proj) => req("GET", `${base(proj)}`),
  create: (proj, item) => req("POST", `${base(proj)}`, item),
  update: (proj, id, item) => req("PUT", `${base(proj)}/${id}`, item),
  del: (proj, id) => req("DELETE", `${base(proj)}/${id}`),
});

export const api = {
  projects: {
    list: () => req("GET", "/api/projects"),
    create: (p) => req("POST", "/api/projects", p),
    update: (name, p) => req("PUT", `/api/projects/${encodeURIComponent(name)}`, p),
    del: (name) => req("DELETE", `/api/projects/${encodeURIComponent(name)}`),
  },
  graph: (proj) => req("GET", `/api/projects/${encodeURIComponent(proj)}/graph`),
  saveLayout: (proj, layout) => req("PUT", `/api/projects/${encodeURIComponent(proj)}/layout`, layout),
  exportURL: (proj) => `/api/projects/${encodeURIComponent(proj)}/export`,
  importProject: (bundle, name) => req("POST", `/api/projects/import?name=${encodeURIComponent(name)}`, bundle),
  systems: crud((p) => `/api/projects/${encodeURIComponent(p)}/systems`),
  streams: crud((p) => `/api/projects/${encodeURIComponent(p)}/streams`),
  needs: crud((p) => `/api/projects/${encodeURIComponent(p)}/needs`),
  flows: crud((p) => `/api/projects/${encodeURIComponent(p)}/flows`),
};
