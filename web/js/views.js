import { api, UnauthError, viewMode } from "./api.js";
import { authEnabled } from "./session.js";
import { createGraph } from "./graph.js";
import { FilteredView } from "./view.js";
import {
  analyze, flowShape, flowImpliedNeeds, deriveStages,
  suggestNeeds, groupFindings, groupJustifiedFindings,
} from "./analysis.js";
import { Dropdown, MultiDropdown, placePanel, afterPaint, plural } from "./ui.js";
import { AccountControl, sessionUser } from "./session.js";

const van = window.van;
const {
  a, button, div, form, h1, h3, h4, h5,
  input, label, p, span,
} = van.tags;

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

export function toast(msg, isError = false, action = null) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-action";
    b.textContent = action.label;
    b.onclick = () => { el.className = ""; action.onclick(); };
    el.appendChild(b);
  }
  el.className = "show" + (isError ? " error" : "") + (action ? " actionable" : "");
  clearTimeout(el._t);
  // action toasts linger longer — the user needs time to reach for Undo
  el._t = setTimeout(() => (el.className = ""), action ? 6000 : 3200);
}

const busy = async (fn) => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof UnauthError) return; // routed to the auth gate by onUnauth
    toast(e.message, true);
  }
};

const field = (name, el) => label({ class: "field" }, span(name), el);

const logoSVG = (size) => {
  const d = document.createElement("div");
  d.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M4 22 C10 8, 16 30, 22 12 S 30 20, 28 8" fill="none" stroke="#e6a23c" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="4" cy="22" r="2.6" fill="#3987e5"/>
    <circle cx="28" cy="8" r="2.6" fill="#d95926"/>
  </svg>`;
  return d.firstChild;
};

const provChip = (owner) =>
  owner?.provenance && owner.provenance.source !== "manual"
    ? span({ class: "prov-chip", title: "This fact was not entered by hand — review it" }, owner.provenance.source)
    : null;

// tri-state dropdown for Field.unique / Field.indexed (nil = not documented)
const triSelect = (value, onchange) =>
  Dropdown({
    value: value == null ? "" : value ? "yes" : "no",
    options: [["", "—"], ["yes", "yes"], ["no", "no"]],
    onchange: (v) => onchange(v === "" ? null : v === "yes"),
  });

const FIELD_TYPES = ["string", "uuid", "int", "float", "bool", "date", "datetime", "json", "blob"];

// ---------------------------------------------------------------
// landing page
// ---------------------------------------------------------------

// Relative age for project cards ("updated 2d ago"). Quiet mono meta, not a clock.
function relativeUpdated(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return "updated just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `updated ${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `updated ${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 60) return `updated ${day}d ago`;
  const mo = Math.round(day / 30);
  return `updated ${mo}mo ago`;
}

function cardMetaLine(proj) {
  const nSys = proj.system_count ?? 0;
  const nStr = proj.stream_count ?? 0;
  const sys = `${nSys} system${nSys === 1 ? "" : "s"}`;
  const str = `${nStr} stream${nStr === 1 ? "" : "s"}`;
  const when = relativeUpdated(proj.updated_at);
  return [sys, str, when].filter(Boolean).join(" · ");
}

export function Home({ go }) {
  const projects = van.state(null); // null = loading
  const creating = van.state(false);

  const reload = () => busy(async () => (projects.val = await api.projects.list()));
  reload();

  const NewProjectForm = () => {
    const st = { name: "", description: "" };
    return form(
      {
        onsubmit: (e) => {
          e.preventDefault();
          busy(async () => {
            await api.projects.create({ name: st.name.trim(), description: st.description.trim() });
            creating.val = false;
            toast(`Project "${st.name.trim()}" created`);
            reload();
          });
        },
      },
      field("Name", input({ type: "text", required: true, placeholder: "e.g. Retail Platform", oninput: (e) => (st.name = e.target.value) })),
      field("Description", input({ type: "text", placeholder: "What map is this?", oninput: (e) => (st.description = e.target.value) })),
      div({ class: "form-actions", style: "display:flex;gap:8px;justify-content:flex-end" },
        button({ type: "button", class: "btn ghost", onclick: () => (creating.val = false) }, "Cancel"),
        button({ type: "submit", class: "btn primary" }, "Create project"),
      ),
    );
  };

  const pendingDel = van.state(null); // project name awaiting inline delete confirmation

  const ProjectCard = (proj) =>
    div(
      { class: "project-card", onclick: () => go(`/p/${encodeURIComponent(proj.name)}`) },
      h3(proj.name),
      p(proj.description || "No description yet."),
      span({ class: "card-meta" }, cardMetaLine(proj)),
      pendingDel.val === proj.name
        ? div({ class: "warn-note", onclick: (e) => e.stopPropagation() },
            `Move "${proj.name}" to the trash folder? Recoverable by hand.`,
            div({ class: "confirm-actions" },
              button({
                class: "btn small danger",
                onclick: () => busy(async () => {
                  pendingDel.val = null;
                  await api.projects.del(proj.name);
                  toast(`Project "${proj.name}" moved to trash`);
                  reload();
                }),
              }, "Move to trash"),
              button({ class: "btn ghost small", onclick: () => (pendingDel.val = null) }, "Cancel"),
            ))
        : div({ class: "card-actions" },
            button({
              class: "btn ghost small danger",
              onclick: (e) => { e.stopPropagation(); pendingDel.val = proj.name; },
            }, "Delete"),
          ),
    );

  const importProject = () => {
    const picker = input({ type: "file", accept: ".json,application/json", style: "display:none" });
    picker.onchange = () => {
      const file = picker.files[0];
      if (!file) return;
      busy(async () => {
        const bundle = JSON.parse(await file.text());
        let name = bundle.project?.name || file.name.replace(/\.(spaghetti\.)?json$/i, "");
        try {
          await api.importProject(bundle, name);
        } catch (e) {
          if (!/exists/.test(e.message)) throw e;
          const renamed = prompt(`A project named "${name}" already exists. Import as:`, `${name} (imported)`);
          if (!renamed) return;
          await api.importProject(bundle, renamed);
          name = renamed;
        }
        toast(`Imported "${name}"`);
        reload();
      });
    };
    document.body.appendChild(picker);
    picker.click();
    picker.remove();
  };

  // DR-2: topbar frame (brand left, account right) shared with Workspace;
  // content column carries wordmark + tagline + projects (not the chip).
  return div({ class: "home-page" },
    div({ class: "topbar" },
      a({ class: "brand-mini", href: "#/" }, logoSVG(22), "SpaghettiMapper"),
      span({ class: "spacer" }),
      AccountControl(),
    ),
    div({ class: "home" },
      div({ class: "brand" }, logoSVG(40), h1("Spaghetti", van.tags.b("Mapper"))),
      p({ class: "tagline" },
        "Document the integrations you have, see the tangle you built, and decide which strands to cut."),
      div({ class: "home-projects-head" },
        van.tags.h2("Projects"),
        button({ class: "btn small", onclick: importProject }, "Import project file…"),
      ),
      () => {
        const list = projects.val;
        if (list === null) return div({ class: "empty-note" }, "Loading…");
        const empty = list.length === 0;
        return div(
          div({ class: "project-grid" },
            list.map(ProjectCard),
            creating.val
              ? div({ class: "new-project" }, h3("New project"), NewProjectForm())
              : div({ class: "new-project", style: "display:flex;align-items:center;justify-content:center;cursor:pointer;min-height:120px", onclick: () => (creating.val = true) },
                  span({ style: "color:var(--ink-2)" }, "+ New project")),
          ),
          // First-run invitation — Home's empty state should teach, like the canvas.
          empty
            ? p({ class: "home-invite" },
                "A project is one architecture map — a folder of readable JSON on this machine.")
            : null,
          // REV-5 peer model will populate trash here; keep the slot quiet until then.
          van.tags.details({ class: "home-recently-deleted", hidden: true },
            van.tags.summary("Recently deleted"),
          ),
        );
      },
    ),
  );
}

// ---------------------------------------------------------------
// system form with entity/field catalog editor
// ---------------------------------------------------------------

function SystemForm({ item, needs = [], onSave, onCancel }) {
  const s = { name: item?.name ?? "", description: item?.description ?? "", type: item?.type ?? "internal" };
  const ents = structuredClone(item?.entities ?? []);
  const rev = van.state(0); // bumped on structural changes only, so inputs keep focus
  const bump = () => rev.val++;

  const typedCount = (e) => e.fields.filter((f) => f.type).length;

  const entityNeeds = (e) => {
    if (!needs.length) return null;
    return van.tags.details({ class: "ent-needs" },
      van.tags.summary(`business needs (${(e.biz_need_ids ?? []).length})`),
      div({ class: "checklist" },
        needs.map((n) => label(
          input({
            type: "checkbox", checked: (e.biz_need_ids ?? []).includes(n.id),
            oninput: (ev) => {
              const set = new Set(e.biz_need_ids ?? []);
              ev.target.checked ? set.add(n.id) : set.delete(n.id);
              e.biz_need_ids = [...set];
            },
          }),
          span(n.name)))),
    );
  };

  const entityCard = (e, ei) =>
    div({ class: "ent-card" },
      div({ class: "ent-head" },
        input({ type: "text", placeholder: "Entity name", value: e.name, required: true, oninput: (ev) => (e.name = ev.target.value) }),
        provChip(e),
        button({ type: "button", class: "btn ghost small danger", title: "Remove entity (stream references are cleaned up)", onclick: () => { ents.splice(ei, 1); bump(); } }, "✕"),
      ),
      input({ type: "text", placeholder: "Description (optional)", value: e.description ?? "", style: "margin-bottom:6px", oninput: (ev) => (e.description = ev.target.value) }),
      entityNeeds(e),
      e.fields.length
        ? [div({ class: "fld-grid-head" }, span("field"), span("type"), span("unique"), span("indexed"), span()),
           e.fields.map((f, fi) =>
             div({ class: "fld-row" },
               input({ type: "text", placeholder: "name", value: f.name, required: true, oninput: (ev) => (f.name = ev.target.value) }),
               Dropdown({ editable: true, value: f.type ?? "", placeholder: "type", options: FIELD_TYPES.map((t) => [t, t]), onchange: (v) => (f.type = v) }),
               triSelect(f.unique, (v) => (f.unique = v)),
               triSelect(f.indexed, (v) => (f.indexed = v)),
               button({ type: "button", class: "btn ghost small danger", onclick: () => { e.fields.splice(fi, 1); bump(); } }, "✕"),
             ))]
        : null,
      div({ style: "display:flex;justify-content:space-between;align-items:center;margin-top:4px" },
        span({ class: "coverage" }, van.tags.b(`${typedCount(e)}/${e.fields.length}`), " fields typed"),
        button({ type: "button", class: "btn ghost small", onclick: () => { e.fields.push({ name: "", type: "" }); bump(); } }, "+ field"),
      ),
    );

  return form(
    {
      onsubmit: (e) => {
        e.preventDefault();
        onSave({ ...s, entities: ents });
      },
    },
    h4(item ? "Edit system" : "New system"),
    field("Name", input({ type: "text", required: true, value: s.name, oninput: (e) => (s.name = e.target.value) })),
    field("Description", input({ type: "text", value: s.description, oninput: (e) => (s.description = e.target.value) })),
    field("Type", Dropdown({ value: s.type, options: ["internal", "external", "unknown"].map((t) => [t, t]), onchange: (v) => (s.type = v) })),
    div({ class: "form-section" },
      h5("Data catalog — entities & fields (optional, powers analysis)"),
      () => {
        rev.val;
        return div(
          ents.map(entityCard),
          button({ type: "button", class: "btn small", style: "width:100%;justify-content:center", onclick: () => { ents.push({ name: "", fields: [] }); bump(); } }, "+ Add entity"),
        );
      },
    ),
    div({ class: "form-actions" },
      button({ type: "button", class: "btn ghost small", onclick: onCancel }, "Cancel"),
      button({ type: "submit", class: "btn primary small" }, "Save"),
    ),
  );
}

function NeedForm({ item, onSave, onCancel }) {
  const n = { name: item?.name ?? "", description: item?.description ?? "" };
  return form(
    { onsubmit: (e) => { e.preventDefault(); onSave(n); } },
    h4(item ? "Edit business need" : "New business need"),
    field("Name", input({ type: "text", required: true, value: n.name, oninput: (e) => (n.name = e.target.value) })),
    field("Description", input({ type: "text", value: n.description, oninput: (e) => (n.description = e.target.value) })),
    div({ class: "form-actions" },
      button({ type: "button", class: "btn ghost small", onclick: onCancel }, "Cancel"),
      button({ type: "submit", class: "btn primary small" }, "Save"),
    ),
  );
}

// Cluster rail form — NeedForm + color swatches + member checklist (plan §5.3).
// colorKeys / colorHex come from the graph renderer (palette ownership).
function ClusterForm({ item, systems = [], needs = [], colorKeys = [], colorHex = (k) => k, defaultColor = "verdigris", onSave, onCancel }) {
  const c = {
    name: item?.name ?? "",
    description: item?.description ?? "",
    color: item?.color || defaultColor,
    system_ids: new Set(item?.system_ids ?? []),
    biz_need_ids: new Set(item?.biz_need_ids ?? []),
  };
  const rev = van.state(0);
  const bump = () => rev.val++;
  return form(
    {
      onsubmit: (e) => {
        e.preventDefault();
        onSave({
          name: c.name,
          description: c.description,
          color: c.color,
          system_ids: [...c.system_ids],
          biz_need_ids: [...c.biz_need_ids],
        });
      },
    },
    h4(item ? "Edit cluster" : "New cluster"),
    field("Name", input({ type: "text", required: true, value: c.name, oninput: (e) => (c.name = e.target.value) })),
    field("Description", input({ type: "text", value: c.description, oninput: (e) => (c.description = e.target.value) })),
    () => {
      rev.val;
      return div({ class: "field" },
        span("Color"),
        div({ class: "cluster-swatches" },
          colorKeys.map((k) =>
            button({
              type: "button",
              class: "cluster-swatch" + (c.color === k ? " selected" : ""),
              style: `background:${colorHex(k)}`,
              title: k,
              "aria-label": k,
              onclick: () => { c.color = k; bump(); },
            }))),
      );
    },
    needs.length
      ? field("Business needs", div({ class: "checklist" },
          needs.map((n) => label(
            input({
              type: "checkbox", checked: c.biz_need_ids.has(n.id),
              oninput: (ev) => { ev.target.checked ? c.biz_need_ids.add(n.id) : c.biz_need_ids.delete(n.id); },
            }),
            span(n.name)))))
      : null,
    systems.length
      ? field("Systems", div({ class: "checklist" },
          systems.map((s) => label(
            input({
              type: "checkbox", checked: c.system_ids.has(s.id),
              oninput: (ev) => { ev.target.checked ? c.system_ids.add(s.id) : c.system_ids.delete(s.id); },
            }),
            span(s.name)))))
      : null,
    div({ class: "form-actions" },
      button({ type: "button", class: "btn ghost small", onclick: onCancel }, "Cancel"),
      button({ type: "submit", class: "btn primary small" }, "Save"),
    ),
  );
}

// ---------------------------------------------------------------
// stream form with catalog-backed entity/field pickers
// ---------------------------------------------------------------

function StreamForm({ proj, item, systems, needs, onSave, onCancel }) {
  const st = {
    name: item?.name ?? "",
    biz_need_ids: new Set(item?.biz_need_ids ?? []),
    timing: item?.timing ?? "scheduled",
    api_type: item?.api_type ?? "",
    data_format: item?.data_format ?? "",
    direction: item?.direction ?? "uni",
    status: item?.status ?? "planned",
  };
  const mkEP = (ep) => ({
    system_id: ep?.system_id ?? "",
    entity_ids: new Set(ep?.entity_ids ?? []),
    fields_mode: ep?.fields_mode ?? "all",
    field_ids: new Set(ep?.field_ids ?? []),
  });
  const src = mkEP(item?.source);
  const dst = mkEP(item?.destination);
  const rev = van.state(0);
  const bump = () => rev.val++;

  const sysOf = (id) => systems.find((s) => s.id === id);

  // Quick-add writes to the catalog immediately (the fact is valid on its
  // own), updates the local copy, and auto-selects the new item.
  const quickAddEntity = (ep, name) => busy(async () => {
    const sys = sysOf(ep.system_id);
    if (!sys || !name.trim()) return;
    sys.entities = [...(sys.entities ?? []), { name: name.trim(), fields: [] }];
    const saved = await api.systems.update(proj, sys.id, sys);
    sys.entities = saved.entities;
    const added = saved.entities.find((e) => e.name === name.trim());
    if (added) ep.entity_ids.add(added.id);
    toast(`Entity "${name.trim()}" added to ${sys.name}`);
    bump();
  });

  const quickAddField = (ep, entityId, name) => busy(async () => {
    const sys = sysOf(ep.system_id);
    const ent = sys?.entities?.find((e) => e.id === entityId);
    if (!ent || !name.trim()) return;
    ent.fields = [...(ent.fields ?? []), { name: name.trim() }];
    const saved = await api.systems.update(proj, sys.id, sys);
    sys.entities = saved.entities;
    const savedEnt = saved.entities.find((e) => e.id === entityId);
    const added = savedEnt?.fields.find((f) => f.name === name.trim());
    if (added) ep.field_ids.add(added.id);
    toast(`Field "${name.trim()}" added to ${ent.name}`);
    bump();
  });

  const quickAdd = (placeholder, onAdd) => {
    const inp = input({ type: "text", placeholder });
    return div({ class: "quick-add" },
      inp,
      button({ type: "button", class: "btn small", onclick: () => { onAdd(inp.value); inp.value = ""; } }, "Add"),
    );
  };

  const entityChecklist = (ep) => {
    const sys = sysOf(ep.system_id);
    if (!sys) return div({ class: "checklist" }, div({ class: "cl-empty" }, "Pick a system first."));
    const ents = sys.entities ?? [];
    return div(
      div({ class: "checklist" },
        ents.length ? null : div({ class: "cl-empty" }, "No entities in this system's catalog yet — add one below."),
        ents.map((e) =>
          label(
            input({
              type: "checkbox", checked: ep.entity_ids.has(e.id),
              oninput: (ev) => {
                if (ev.target.checked) ep.entity_ids.add(e.id);
                else {
                  ep.entity_ids.delete(e.id);
                  for (const f of e.fields ?? []) ep.field_ids.delete(f.id);
                }
                bump();
              },
            }),
            span(e.name), provChip(e),
            span({ class: "cl-meta" }, plural((e.fields ?? []).length, "field")),
          )),
      ),
      quickAdd("New entity name…", (v) => quickAddEntity(ep, v)),
    );
  };

  const fieldChecklist = (ep) => {
    const sys = sysOf(ep.system_id);
    const chosen = (sys?.entities ?? []).filter((e) => ep.entity_ids.has(e.id));
    if (!chosen.length) return div({ class: "checklist" }, div({ class: "cl-empty" }, "Select entities above to pick their fields."));
    return div(
      div({ class: "checklist" },
        chosen.map((e) => {
          const sel = (e.fields ?? []).filter((f) => ep.field_ids.has(f.id)).length;
          return [
            div({ class: "cl-group" }, span(e.name), span(`${sel} of ${(e.fields ?? []).length}`)),
            (e.fields ?? []).length ? null : div({ class: "cl-empty" }, "no fields catalogued"),
            (e.fields ?? []).map((f) =>
              label(
                input({
                  type: "checkbox", checked: ep.field_ids.has(f.id),
                  oninput: (ev) => { ev.target.checked ? ep.field_ids.add(f.id) : ep.field_ids.delete(f.id); bump(); },
                }),
                span(f.name),
                f.type ? span({ class: "cl-meta" }, f.type) : null,
              )),
            quickAdd(`New field on ${e.name}…`, (v) => quickAddField(ep, e.id, v)),
          ];
        }),
      ),
    );
  };

  const endpointSection = (title, ep) =>
    div({ class: "form-section" },
      h5(title),
      field("System", Dropdown({
        value: ep.system_id, placeholder: "— select system —",
        options: [["", "— select system —"], ...systems.map((s) => [s.id, s.name])],
        onchange: (v) => { ep.system_id = v; ep.entity_ids.clear(); ep.field_ids.clear(); bump(); },
      })),
      field("Entities", entityChecklist(ep)),
      field("Fields", Dropdown({
        value: ep.fields_mode,
        options: [["all", "all"], ["list", "list"], ["unknown", "unknown"]],
        onchange: (v) => { ep.fields_mode = v; bump(); },
      })),
      ep.fields_mode === "list" ? field("Field selection", fieldChecklist(ep)) : null,
    );

  return form(
    {
      onsubmit: (e) => {
        e.preventDefault();
        if (!src.system_id || !dst.system_id) {
          toast("Pick a system for both source and destination.", true);
          return;
        }
        const pack = (ep) => ({
          system_id: ep.system_id,
          entity_ids: [...ep.entity_ids],
          fields_mode: ep.fields_mode,
          field_ids: ep.fields_mode === "list" ? [...ep.field_ids] : [],
        });
        onSave({
          name: st.name, biz_need_ids: [...st.biz_need_ids], timing: st.timing,
          api_type: st.api_type, data_format: st.data_format,
          direction: st.direction, status: st.status,
          source: pack(src), destination: pack(dst),
        });
      },
    },
    h4(item ? "Edit stream" : "New stream"),
    field("Name", input({ type: "text", required: true, placeholder: "Orders sync", value: st.name, oninput: (e) => (st.name = e.target.value) })),
    field("Business needs", div({ class: "checklist" },
      needs.length ? null : div({ class: "cl-empty" }, "No business needs defined yet."),
      needs.map((n) =>
        label(
          input({
            type: "checkbox", checked: st.biz_need_ids.has(n.id),
            oninput: (ev) => (ev.target.checked ? st.biz_need_ids.add(n.id) : st.biz_need_ids.delete(n.id)),
          }),
          span(n.name),
        )),
    )),
    div({ class: "field-row" },
      field("Timing", Dropdown({ value: st.timing, options: [["real-time", "real-time"], ["scheduled", "scheduled"]], onchange: (v) => (st.timing = v) })),
      field("Status", Dropdown({ value: st.status, options: [["planned", "planned"], ["implemented", "implemented"], ["unknown", "unknown"]], onchange: (v) => (st.status = v) })),
    ),
    div({ class: "field-row" },
      field("API type", Dropdown({
        editable: true, value: st.api_type, placeholder: "REST",
        options: ["REST", "SOAP", "GraphQL", "Streaming", "DB-link", "File transfer", "Message queue"].map((v) => [v, v]),
        onchange: (v) => (st.api_type = v),
      })),
      field("Data format", Dropdown({
        editable: true, value: st.data_format, placeholder: "JSON",
        options: ["JSON", "XML", "CSV", "Parquet", "Fixed-width", "Binary"].map((v) => [v, v]),
        onchange: (v) => (st.data_format = v),
      })),
    ),
    field("Direction", Dropdown({
      value: st.direction,
      options: [["uni", "unidirectional (source → destination)"], ["bi", "bidirectional"]],
      onchange: (v) => (st.direction = v),
    })),
    () => { rev.val; return div(endpointSection("Source", src), endpointSection("Destination", dst)); },
    div({ class: "form-actions" },
      button({ type: "button", class: "btn ghost small", onclick: onCancel }, "Cancel"),
      button({ type: "submit", class: "btn primary small" }, "Save"),
    ),
  );
}

// ---------------------------------------------------------------
// flow form — a flow is a named set of streams; shape is derived
// ---------------------------------------------------------------

function FlowForm({ item, streams, needs, systems, onSave, onCancel }) {
  const fl = {
    name: item?.name ?? "",
    description: item?.description ?? "",
    biz_need_ids: new Set(item?.biz_need_ids ?? []),
    steps: new Map((item?.steps ?? []).map((s) => [s.stream_id, Math.max(1, s.stage || 1)])),
  };
  const rev = van.state(0);
  const bump = () => rev.val++;
  const stById = new Map(streams.map((s) => [s.id, s]));
  const sysName = (id) => systems.find((s) => s.id === id)?.name ?? "?";
  const hop = (st) => `${sysName(st.source.system_id)} → ${sysName(st.destination.system_id)}`;
  const selectedStreams = () => [...fl.steps.keys()].map((id) => stById.get(id)).filter(Boolean);

  const add = (st) => {
    // prefill from topology; the number stays fully editable
    const derived = deriveStages([...selectedStreams(), st]);
    fl.steps.set(st.id, derived.get(st.id) ?? Math.max(1, ...fl.steps.values(), 0) + 1);
    bump();
  };
  const removeHop = (id) => { fl.steps.delete(id); bump(); };
  const autoNumber = () => {
    const derived = deriveStages(selectedStreams());
    for (const id of fl.steps.keys()) fl.steps.set(id, derived.get(id) ?? 1);
    bump();
  };

  // The filter box lives outside the reactive re-render and filters rows
  // imperatively, so typing never loses focus.
  let listEl = null;
  let q = "";
  const applyRowFilter = () => {
    if (!listEl) return;
    for (const row of listEl.querySelectorAll("label")) {
      row.style.display = !q || row.dataset.txt.includes(q) ? "" : "none";
    }
  };
  const filterBox = input({
    type: "search", placeholder: "Filter streams…", style: "margin-bottom:6px",
    oninput: (e) => { q = e.target.value.trim().toLowerCase(); applyRowFilter(); },
  });

  // systems already touched by the selection — used to suggest next hops
  const touched = () => {
    const t = new Set();
    for (const st of selectedStreams()) {
      t.add(st.source.system_id);
      t.add(st.destination.system_id);
    }
    return t;
  };

  const hopsPanel = () => {
    const rows = [...fl.steps.entries()]
      .map(([id, stage]) => ({ st: stById.get(id), stage }))
      .filter((r) => r.st)
      .sort((x, y) => x.stage - y.stage || x.st.name.localeCompare(y.st.name));
    if (!rows.length) return div({ class: "cl-empty", style: "margin-bottom:6px" }, "No hops yet — pick streams below. Same stage number = fan-out/fan-in.");
    return div({ style: "margin-bottom:8px" },
      rows.map(({ st, stage }) =>
        div({ class: "hopedit-row" },
          input({
            type: "number", min: "1", class: "stage-num", value: stage,
            title: "Stage number — hops sharing a number run in parallel",
            onchange: (e) => { fl.steps.set(st.id, Math.max(1, +e.target.value || 1)); bump(); },
          }),
          span({ class: "ei-name" }, st.name),
          span({ class: "cl-meta" }, hop(st)),
          button({ type: "button", class: "btn ghost small danger", onclick: () => removeHop(st.id) }, "✕"),
        )),
      rows.length > 1
        ? button({ type: "button", class: "btn ghost small", style: "margin-top:4px", title: "Renumber all stages from the streams' wiring", onclick: autoNumber }, "Auto-number by topology")
        : null,
    );
  };

  const streamPicker = () => {
    const t = touched();
    const suggestions = fl.steps.size
      ? streams.filter((st) => !fl.steps.has(st.id) &&
          (t.has(st.source.system_id) || t.has(st.destination.system_id))).slice(0, 5)
      : [];
    listEl = div({ class: "checklist", style: "max-height:180px" },
      streams.length ? null : div({ class: "cl-empty" }, "No streams yet — a flow strings existing streams together."),
      streams.map((st) =>
        label({ "data-txt": (st.name + " " + hop(st)).toLowerCase() },
          input({ type: "checkbox", checked: fl.steps.has(st.id), oninput: (ev) => (ev.target.checked ? add(st) : removeHop(st.id)) }),
          span(st.name),
          span({ class: "cl-meta" }, hop(st)),
        )),
    );
    applyRowFilter();
    return div(
      streams.length > 6 ? filterBox : null,
      listEl,
      suggestions.length
        ? div({ class: "suggest" },
            div({ class: "cl-group", style: "margin-top:8px" }, span("Connected — likely next hops")),
            suggestions.map((st) =>
              div({ class: "suggest-row" },
                button({ type: "button", class: "btn ghost small", onclick: () => add(st) }, "+ add"),
                span(st.name), span({ class: "cl-meta" }, hop(st)))))
        : null,
    );
  };

  return form(
    {
      onsubmit: (e) => {
        e.preventDefault();
        onSave({
          name: fl.name, description: fl.description,
          biz_need_ids: [...fl.biz_need_ids],
          steps: [...fl.steps.entries()]
            .map(([stream_id, stage]) => ({ stream_id, stage }))
            .sort((x, y) => x.stage - y.stage),
        });
      },
    },
    h4(item ? "Edit flow" : "New flow"),
    field("Name", input({ type: "text", required: true, placeholder: "Order round trip", value: fl.name, oninput: (e) => (fl.name = e.target.value) })),
    field("Description", input({ type: "text", value: fl.description, oninput: (e) => (fl.description = e.target.value) })),
    field("Business needs (this flow's own purpose — needs implied by its streams are shown automatically)",
      div({ class: "checklist" },
        needs.length ? null : div({ class: "cl-empty" }, "No business needs defined yet."),
        needs.map((n) =>
          label(
            input({
              type: "checkbox", checked: fl.biz_need_ids.has(n.id),
              oninput: (ev) => (ev.target.checked ? fl.biz_need_ids.add(n.id) : fl.biz_need_ids.delete(n.id)),
            }),
            span(n.name))))),
    field("Hops in order (stage number is editable)", () => { rev.val; return hopsPanel(); }),
    field("Add / remove streams", () => { rev.val; return streamPicker(); }),
    div({ class: "form-actions" },
      button({ type: "button", class: "btn ghost small", onclick: onCancel }, "Cancel"),
      button({ type: "submit", class: "btn primary small" }, "Save"),
    ),
  );
}

// ---------------------------------------------------------------
// project workspace
// ---------------------------------------------------------------

// ViewToggle (DR-3): switches reads between the signed-in architect's own
// workspace and the canonical main line. Lives in the topbar next to the
// project name — "whose line am I on" is not a display preference. Text
// segments (Mine · Main) with aria-pressed; anonymous has no toggle (always
// reads main).
function ViewToggle({ reload }) {
  return () => {
    if (!sessionUser.val) return null;
    const btn = (label, val, title) =>
      button({
        type: "button",
        class: () => "view-btn" + (viewMode.val === val ? " active" : ""),
        title,
        "aria-label": title,
        "aria-pressed": () => (viewMode.val === val ? "true" : "false"),
        onclick: () => { if (viewMode.val === val) return; viewMode.val = val; reload(); },
      }, label);
    return div({
      class: "view-toggle",
      role: "group",
      "aria-label": "Whose work you are viewing",
      title: "Whose work you are viewing",
    },
      btn("Mine", "me", "My workspace — your branch"),
      btn("Main", "main", "Main — the shared map"),
    );
  };
}

export function Workspace(proj, { go }) {
  const data = van.state(null);
  const tab = van.state("systems");
  const editing = van.state(null); // {kind} | {kind, item}
  const selection = van.state(null); // {type:'edge'|'node'|'analysis', ...}

  // ---- resizable drawers ----
  // widths live in state so van re-renders the pane reactively; the canvas
  // is the flexible middle pane (flex:1; min-width:0) and absorbs the gap,
  // so widening either drawer automatically shrinks it.
  const RAIL_MIN = 220, RAIL_MAX = 520, RAIL_DEFAULT = 320;
  const INSP_MIN = 260, INSP_MAX = 620, INSP_DEFAULT = 340;
  const MIN_CANVAS = 240;
  const loadInt = (k, d) => { const v = +localStorage.getItem(k); return Number.isFinite(v) && v ? v : d; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const railWidth = van.state(loadInt("sm.railW", RAIL_DEFAULT));
  // While a rail form is open the rail borrows width (never persisted) so the
  // field grid inside the system form stays readable — at 320px its TYPE /
  // UNIQUE / INDEXED columns collapse into unreadable slivers. Capped by the
  // viewport so a small window still keeps some canvas.
  const FORM_RAIL_MIN = 430;
  const effRailWidth = () =>
    editing.val ? Math.max(railWidth.val, Math.min(FORM_RAIL_MIN, window.innerWidth - 560)) : railWidth.val;
  const inspWidth = van.state(loadInt("sm.inspW", INSP_DEFAULT));
  // clamp loaded widths to the current viewport so a saved 520px rail
  // can't overflow a small window on reload.
  const vw0 = window.innerWidth;
  railWidth.val = clamp(railWidth.val, RAIL_MIN, Math.min(RAIL_MAX, vw0 - MIN_CANVAS - inspWidth.val));
  inspWidth.val = clamp(inspWidth.val, INSP_MIN, Math.min(INSP_MAX, vw0 - MIN_CANVAS - railWidth.val));

  // reusable horizontal drag resizer. `side` is 'resizer--rail' (left) or
  // 'resizer--insp' (right); for the left rail dx adds, for the right
  // inspector dx subtracts. Double-click resets to the default width.
  const otherWidth = (side) => (side === "resizer--rail" ? inspWidth : railWidth);
  const limits = (side) => (side === "resizer--rail" ? [RAIL_MIN, RAIL_MAX] : [INSP_MIN, INSP_MAX]);
  const makeResizer = (state, side, key) =>
    div({
      class: "resizer resizer--h " + side,
      onmousedown: (e) => {
        e.preventDefault();
        const startX = e.clientX, startW = state.val;
        document.body.classList.add("resizing");
        const move = (ev) => {
          const dx = ev.clientX - startX;
          const [lo, hi] = limits(side);
          const raw = side === "resizer--rail" ? startW + dx : startW - dx;
          state.val = clamp(raw, lo, Math.min(hi, window.innerWidth - MIN_CANVAS - otherWidth(side).val));
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.classList.remove("resizing");
          localStorage.setItem(key, state.val);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      },
      ondblclick: () => { state.val = side === "resizer--rail" ? RAIL_DEFAULT : INSP_DEFAULT; localStorage.setItem(key, state.val); },
    });
  // Legacy per-browser filter state — read only as a one-time migration
  // source for the server-side per-architect userstate (see loadUserState).
  let savedFilters = {};
  if (new URLSearchParams(location.search).has("e2e")) {
    localStorage.clear();
  } else {
    try {
      const saved = localStorage.getItem(`sm.filterState.${proj}`);
      if (saved) savedFilters = JSON.parse(saved);
    } catch (e) {}
  }

  const filters = {
    // q/scope are the *draft* being composed in the HUD input — session-
    // ephemeral by design: never persisted, cleared when the HUD collapses.
    // Only committed chips (queries + facets below, including flow) survive.
    // Flow is a regular single-valued filter condition (variant A).
    // clusters: GS-5 A1 live references into project clusters (not macro-expanded).
    q: van.state(""),
    scope: van.state("all"),
    queries: van.state(savedFilters.queries || []),
    statuses: van.state(new Set(savedFilters.statuses || [])),
    timings: van.state(new Set(savedFilters.timings || [])),
    needs: van.state(new Set(savedFilters.needs || [])),
    systems: van.state(new Set(savedFilters.systems || [])),
    clusters: van.state(new Set(savedFilters.clusters || [])),
    flow: van.state(savedFilters.flow || ""),
  };
  // Soft cache of cluster id → name so deleted/absent chips still render
  // "Payments (deleted)" after the cluster is gone from the graph.
  // sessionStorage survives reload within the tab (userstate only stores ids).
  const clusterNameCache = new Map();
  const CLUSTER_NAMES_KEY = `sm.clusterNames.${proj}`;
  try {
    const o = JSON.parse(sessionStorage.getItem(CLUSTER_NAMES_KEY) || "{}");
    for (const [k, v] of Object.entries(o)) if (v) clusterNameCache.set(k, v);
  } catch { /* private mode */ }
  const persistClusterNames = () => {
    try {
      sessionStorage.setItem(CLUSTER_NAMES_KEY, JSON.stringify(Object.fromEntries(clusterNameCache)));
    } catch { /* private mode */ }
  };

  const showFilterHud = van.state(true);

  // ---- per-architect viewer state (committed filters + filter-enabled) ----
  // Persisted server-side per (project, architect) — NOT in localStorage
  // (filters are user intent, not device ergonomics: they follow you across
  // browsers and are readable by AI agents) and NOT in display.json (they
  // are viewer state, not map state: they must never ride along on history
  // commits, merges, or exports).
  let userStateLoaded = false; // gate saves until the server state seeded us
  let userStateTimer = null;
  const saveUserState = () => {
    if (!userStateLoaded) return;
    clearTimeout(userStateTimer);
    userStateTimer = setTimeout(() =>
      api.saveUserState(proj, {
        filter_enabled: showFilterHud.val,
        filters: {
          queries: filters.queries.val,
          statuses: Array.from(filters.statuses.val),
          timings: Array.from(filters.timings.val),
          needs: Array.from(filters.needs.val),
          systems: Array.from(filters.systems.val),
          clusters: Array.from(filters.clusters.val),
          flow: filters.flow.val || "",
        },
      }).catch(() => {}), 400);
  };
  const hasFilters = (f) => !!f && !!((f.queries?.length) || (f.statuses?.length) ||
    (f.timings?.length) || (f.needs?.length) || (f.systems?.length) ||
    (f.clusters?.length) || f.flow);
  const loadUserState = async (legacyDisplay) => {
    let st = null;
    try { st = await api.getUserState(proj); } catch {}
    let f = st?.filters ?? null;
    let enabled = st?.filter_enabled;
    // One-time migration for pre-userstate installs: this browser's old
    // localStorage state first, then the legacy project-level display.filters.
    if (!f && hasFilters(savedFilters)) f = savedFilters;
    if (!f && hasFilters(legacyDisplay?.filters)) f = legacyDisplay.filters;
    if (enabled == null) {
      enabled = legacyDisplay && Object.hasOwn(legacyDisplay, "filter_enabled")
        ? !!legacyDisplay.filter_enabled : true;
    }
    if (f) {
      filters.queries.val = f.queries || [];
      filters.statuses.val = new Set(f.statuses || []);
      filters.timings.val = new Set(f.timings || []);
      filters.needs.val = new Set(f.needs || []);
      filters.systems.val = new Set(f.systems || []);
      filters.clusters.val = new Set(f.clusters || []);
      filters.flow.val = f.flow || "";
    }
    // Migrate top-level focused_flow (thin-C era) into filters.flow.
    if (!filters.flow.val && st?.focused_flow) filters.flow.val = st.focused_flow;
    showFilterHud.val = !!enabled;
    userStateLoaded = true;
    if ((!st?.filters && f) || (st?.focused_flow && !f?.flow)) saveUserState();
    try {
      localStorage.removeItem(`sm.filterState.${proj}`);
      localStorage.removeItem(`sm.filterHudOpen.${proj}`);
    } catch {}
  };

  let initialPos = { top: 60, left: 300 };
  try {
    const saved = localStorage.getItem(`sm.filterHudPos.${proj}`);
    if (saved) initialPos = JSON.parse(saved);
  } catch (e) {}
  const hudPos = van.state(initialPos);
  van.derive(() => localStorage.setItem(`sm.filterHudPos.${proj}`, JSON.stringify(hudPos.val)));
  const mode = van.state("dim");
  const view = van.state("graph"); // graph | matrix
  const expand = van.state(false); // Bundle (aggregated strands) vs Expand (one curve per stream)
  const fanSpacing = van.state(34); // px between parallel strands in Expand mode (per-project pref)
  const showEdgeLabels = van.state(true); // show stream name labels on edges (per-project pref)
  const showProject = van.state(false); // Project panel drawer open?
  let architectsPanel = null; // memoized ArchitectsSection (see projectPanel)

  // ---- version history (undo / redo / restore + read-only preview) ----
  // The history controls operate on the caller's own line (their branch when
  // signed in, main when solo). Undo/redo are disabled while viewing main in
  // authed mode (your branch isn't on screen); the History drawer and
  // preview work regardless of the current view.
  const showHistory = van.state(false); // History popover open?
  const historyState = van.state({ entries: [], can_undo: false, can_redo: false, head: "" });
  let displayPrefsLoaded = false;

  // After every reload / graph data change: keep group/cluster selections honest.
  // group: intersect ids with systems present; 2+ → group, 1 → node, 0 → null.
  // cluster: if the cluster id no longer exists → null (§3.3).
  // Filters (dim) do not eject members; hide mode drops them from the canvas separately.
  const reconcileSelection = (g) => {
    const sel = selection.val;
    if (!sel) return;
    if (sel.type === "cluster") {
      if (!(g.clusters ?? []).some((c) => c.id === sel.id)) selection.val = null;
      return;
    }
    if (sel.type !== "group") return;
    const present = new Set((g.systems ?? []).map((s) => s.id));
    const ids = sel.ids.filter((id) => present.has(id));
    if (ids.length === sel.ids.length && ids.every((id, i) => id === sel.ids[i])) return;
    if (ids.length >= 2) selection.val = { type: "group", ids };
    else if (ids.length === 1) selection.val = { type: "node", id: ids[0] };
    else selection.val = null;
  };

  let reload = () => busy(async () => {
    const g = await api.graph(proj);
    // seed per-project display prefs once, from the saved display.json (via
    // the graph payload). Don't clobber the user's in-session choice on later
    // reloads (e.g. after editing a system).
    if (!data.val) {
      expand.val = !!g.display?.expand;
      fanSpacing.val = g.display?.fan_spacing ? Math.max(12, Math.min(80, g.display.fan_spacing)) : 34;
      showEdgeLabels.val = !g.display?.hide_edge_labels;
      displayPrefsLoaded = true;
      // Filters + filter-enabled live in the per-architect userstate now;
      // legacy display values are passed along only as a migration source.
      await loadUserState(g.display);
      data.val = g;
      // Restore journey context: if a flow filter was saved, open that flow's
      // inspector and the Flows rail so the session starts oriented.
      // (HUD starts collapsed by default — pill shows the Flow chip.)
      if (filters.flow.val && (g.flows ?? []).some((f) => f.id === filters.flow.val)) {
        selection.val = { type: "flow", id: filters.flow.val };
        tab.val = "flows";
      }
    } else {
      data.val = g;
      reconcileSelection(g);
    }
  });
  reload();

  // Subscribe to project events at the workspace level (not the drawer) so
  // the architects list and — when viewing main — the graph stay live from
  // the moment a project is opened, regardless of the Project drawer.
  architectsProj = proj;
  loadArchitects(proj);
  subscribeProjectEvents(proj, () => loadArchitects(proj), () => reload());

  // ---- version history helpers (need reload defined above) ----
  const loadHistory = () =>
    api.history.get(proj)
      .then((h) => (historyState.val = h))
      .catch(() => {});
  loadHistory();
  // After any edit the timeline changes too: wrap reload so it also refreshes
  // history (and the undo/redo disabled states on the pill).
  const _reloadBase = reload;
  reload = () => busy(async () => { await _reloadBase(); loadHistory(); });
  const undoBlocked = () => !!sessionUser.val && viewMode.val === "main";
  const doUndo = () => busy(async () => {
    if (undoBlocked() || !historyState.val.can_undo) return;
    const h = await api.history.undo(proj);
    historyState.val = h;
    graph.resetLayout();
    data.val = null;
    await _reloadBase();
    const cur = h.entries.find((e) => e.current);
    toast(cur ? `Undid to "${cur.message}"` : "Undid");
  });
  const doRedo = () => busy(async () => {
    if (undoBlocked() || !historyState.val.can_redo) return;
    const h = await api.history.redo(proj);
    historyState.val = h;
    graph.resetLayout();
    data.val = null;
    await _reloadBase();
    const cur = h.entries.find((e) => e.current);
    toast(cur ? `Redid to "${cur.message}"` : "Redid");
  });
  // ---- history detail (P2 inline detail, replaces the lightbox) ----
  // Clicking a history row swaps the History popover from the list to a
  // detail pane: a larger mini-SVG (with labels) of that version + metadata
  // + [Restore this version] + [← Back]. The workspace is never covered.
  // `historyDetail` = { entry, graph? } when a row is open; null = list view.
  const historyDetail = van.state(null);
  const historyCap = van.state(10); // max past entries rendered in the History list ("Show older" grows it)
  const thumbCache = new Map(); // sha -> { nodes, edges } (the thumb API payload)
  const thumbSvgCache = new Map(); // sha -> SVG node (rendered, for reuse)
  let thumbObserver = null;

  const MINI_COLORS = { internal: "#3987e5", external: "#d95926", unknown: "#898781" };
  // Commits that predate any saved layout carry zero-filled positions (the
  // server's Go zero value) — rendered as-is they collapse into one centered
  // dot that tells the user nothing. Resolve each unplaced node to its
  // *current* on-canvas position (same id ⇒ the shape stays comparable
  // across rows), and ring-place ids the current layout doesn't know either,
  // so at least the structure (node count + edges) is visible.
  const resolveMiniNodes = (nodes) => {
    const cur = data.val?.layout ?? {};
    const placed = (x, y) => Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0);
    const out = nodes.map((n) => {
      if (placed(n.x, n.y)) return n;
      const p = cur[n.id];
      return p && placed(p.x, p.y) ? { ...n, x: p.x, y: p.y } : { ...n, x: NaN, y: NaN };
    });
    const un = out.filter((n) => !Number.isFinite(n.x));
    if (un.length) {
      const ok = out.filter((n) => Number.isFinite(n.x));
      const cx = ok.length ? ok.reduce((s, n) => s + n.x, 0) / ok.length : 0;
      const cy = ok.length ? ok.reduce((s, n) => s + n.y, 0) / ok.length : 0;
      un.forEach((n, i) => {
        const a = (2 * Math.PI * i) / un.length - Math.PI / 2;
        n.x = cx + 80 * Math.cos(a);
        n.y = cy + 80 * Math.sin(a);
      });
    }
    return out;
  };
  // HP-2: Andrew's monotone chain for mini plates (no d3 in this file).
  // 1–2 points: the "hull" is just those points (fat stroke makes the pad).
  const miniConvexHull = (pts) => {
    if (pts.length <= 2) return pts.slice();
    const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  };

  // Mini renderer: a pure {nodes,edges,clusters} -> SVG DOM function. No d3, no
  // forces — just scale-to-fit dots + edge lines + HP-2 cluster plates.
  // `labels` (detail view only) draws node names; the list thumbnails draw dots only.
  const miniGraphSVG = (data, { w, h, labels = false, names = null }) => {
    const SVG = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", w); svg.setAttribute("height", h);
    const nodes = resolveMiniNodes(data?.nodes ?? []).filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
    if (!nodes.length) return svg;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
    const pad = labels ? 52 : 12;
    const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
    const scale = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh, 1.4);
    const ox = (w - bw * scale) / 2 - minX * scale;
    const oy = (h - bh * scale) / 2 - minY * scale;
    const px = (n) => [n.x * scale + ox, n.y * scale + oy];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // HP-2: plates first (under edges + nodes). No labels; one group opacity.
    const padc = labels ? 14 : 8;
    for (const cl of (data?.clusters ?? [])) {
      const memberPts = [];
      for (const id of (cl.system_ids ?? [])) {
        const n = byId.get(id);
        if (n) memberPts.push(px(n));
      }
      if (!memberPts.length) continue;
      const hull = miniConvexHull(memberPts);
      let d;
      if (hull.length === 1) {
        d = `M${hull[0][0]},${hull[0][1]} L${hull[0][0]},${hull[0][1]}`;
      } else {
        d = hull.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ") + " Z";
      }
      if (!d || d.includes("NaN")) continue; // HP-?: unexpected; skip bad plate
      const hex = graph.clusterColorHex?.(cl.color) ?? "#3fae94";
      const gEl = document.createElementNS(SVG, "g");
      gEl.setAttribute("opacity", "0.14");
      gEl.setAttribute("fill", hex);
      gEl.setAttribute("stroke", hex);
      gEl.setAttribute("stroke-width", String(2 * padc));
      gEl.setAttribute("stroke-linejoin", "round");
      gEl.setAttribute("stroke-linecap", "round");
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      gEl.appendChild(path);
      svg.appendChild(gEl);
    }
    for (const e of (data?.edges ?? [])) {
      const a = byId.get(e.a), b = byId.get(e.b);
      if (!a || !b) continue;
      const [ax, ay] = px(a), [bx, by] = px(b);
      if (a === b) { // self-loop: a small arc
        const [x, y] = px(a); const p = document.createElementNS(SVG, "path");
        p.setAttribute("d", `M${x - 6},${y} a8,8 0 1,1 12,0`);
        p.setAttribute("fill", "none"); p.setAttribute("stroke", "#5f7186"); p.setAttribute("stroke-width", 1.4);
        svg.appendChild(p); continue;
      }
      const line = document.createElementNS(SVG, "line");
      line.setAttribute("x1", ax); line.setAttribute("y1", ay);
      line.setAttribute("x2", bx); line.setAttribute("y2", by);
      line.setAttribute("stroke", "#5f7186"); line.setAttribute("stroke-width", 1.4);
      svg.appendChild(line);
    }
    for (const n of nodes) {
      const [x, y] = px(n);
      const c = document.createElementNS(SVG, "circle");
      c.setAttribute("cx", x); c.setAttribute("cy", y);
      c.setAttribute("r", labels ? 5 : 3.6);
      c.setAttribute("fill", "#1c2532");
      c.setAttribute("stroke", MINI_COLORS[n.type] || MINI_COLORS.unknown);
      c.setAttribute("stroke-width", labels ? 2 : 1.5);
      svg.appendChild(c);
      if (labels) {
        const t = document.createElementNS(SVG, "text");
        t.setAttribute("x", x); t.setAttribute("y", y - 9);
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("font-size", 9); t.setAttribute("fill", "#98a2b3");
        t.textContent = (names && names.get(n.id)) || n.id;
        svg.appendChild(t);
      }
    }
    return svg;
  };

  // Build a {nodes,edges,clusters} payload from a full graph (the detail view
  // uses the previewGraph payload, which carries names + layout, so labels can
  // show system names rather than ids). HP-2: clusters for mini plates.
  const graphToMini = (g) => ({
    nodes: (g?.systems ?? []).map((s) => {
      const p = (g?.layout ?? {})[s.id] || {};
      return { id: s.id, x: p.x || 0, y: p.y || 0, type: s.type };
    }),
    edges: (() => {
      const ids = new Set((g?.systems ?? []).map((s) => s.id));
      const seen = new Set(); const out = [];
      for (const st of (g?.streams ?? [])) {
        const sa = st.source.system_id, sb = st.destination.system_id;
        if (!ids.has(sa) || !ids.has(sb)) continue;
        const [a, b] = sa < sb ? [sa, sb] : [sb, sa];
        const k = a + "~" + b; if (seen.has(k)) continue; seen.add(k);
        out.push({ a, b });
      }
      return out;
    })(),
    clusters: (g?.clusters ?? []).map((c) => ({
      color: c.color,
      system_ids: c.system_ids ?? [],
    })),
  });

  // Lazy thumbnail: fetch the thumb payload (cached by sha) and render the
  // mini-SVG into the row's container when it scrolls into view.
  const ensureThumb = (sha, container) => {
    if (!sha || !container) return;
    if (thumbSvgCache.has(sha)) { container.innerHTML = ""; container.appendChild(thumbSvgCache.get(sha).cloneNode(true)); return; }
    if (thumbCache.has(sha)) { const svg = miniGraphSVG(thumbCache.get(sha), { w: 240, h: 96 }); thumbSvgCache.set(sha, svg); container.innerHTML = ""; container.appendChild(svg.cloneNode(true)); return; }
    api.history.thumb(proj, sha).then((data) => {
      thumbCache.set(sha, data);
      const svg = miniGraphSVG(data, { w: 240, h: 96 });
      thumbSvgCache.set(sha, svg);
      if (container.isConnected) { container.innerHTML = ""; container.appendChild(svg.cloneNode(true)); }
    }).catch(() => {});
  };

  const openHistoryDetail = async (entry) => {
    if (!entry || entry.current) return;
    historyDetail.val = { entry, graph: null };
    try {
      const g = await api.history.previewGraph(proj, entry.sha);
      if (!historyDetail.val || historyDetail.val.entry.sha !== entry.sha) return; // cancelled
      historyDetail.val = { entry, graph: g };
    } catch (e) {
      toast(e.message || "Preview failed", true);
      historyDetail.val = null;
    }
  };
  const backToHistoryList = () => (historyDetail.val = null);
  const restoreVersion = (entry) => busy(async () => {
    if (!entry) return;
    const h = await api.history.restore(proj, entry.sha);
    historyState.val = h;
    historyDetail.val = null;
    showHistory.val = false;   // close the popover so the restored canvas is visible
    graph.resetLayout();
    if (sessionUser.val) {
      viewMode.val = "me";
    }
    data.val = null;
    await reload();
    toast("Restored this version");
  });

  // Persist display prefs (debounced) — mirrors layout save. Map state only
  // (edges/spacing/labels): filters are per-architect userstate and must not
  // create "update display" history commits.
  let displayTimer = null;
  const saveDisplay = () => {
    if (!displayPrefsLoaded) return;
    clearTimeout(displayTimer);
    displayTimer = setTimeout(() =>
      api.saveDisplay(proj, {
        expand: expand.val,
        fan_spacing: fanSpacing.val,
        hide_edge_labels: !showEdgeLabels.val,
      }).catch(() => {}),
      500);
  };

  // All filter conditions (including flow) are gated by Filter On/Off.
  const filterVals = () => {
    if (!showFilterHud.val) {
      return {
        q: "",
        scope: "all",
        queries: [],
        statuses: new Set(),
        timings: new Set(),
        needs: new Set(),
        systems: new Set(),
        clusters: new Set(),
        flow: "",
      };
    }
    return {
      q: filters.q.val,
      scope: filters.scope.val,
      queries: filters.queries.val,
      statuses: filters.statuses.val,
      timings: filters.timings.val,
      needs: filters.needs.val,
      systems: filters.systems.val,
      clusters: filters.clusters.val,
      flow: filters.flow.val,
    };
  };
  // THE filtering entry point: every surface builds its view here and asks
  // it what is visible — filter semantics live in FilteredView alone.
  const filteredView = () => new FilteredView(data.val, filterVals(), mode.val);

  const sysName = (id) => data.val?.systems.find((s) => s.id === id)?.name ?? "(deleted system)";
  const needNames = (ids) => (ids ?? []).map((id) => data.val?.needs.find((n) => n.id === id)?.name).filter(Boolean);

  // ---- graph canvas ----
  const canvasEl = div({ class: "canvas-wrap" });
  const zoomLevel = van.state(1);
  const graph = createGraph(canvasEl, {
    onSelect: (sel) => (selection.val = sel),
    onLayoutChange: (layout) => api.saveLayout(proj, layout).then(() => loadHistory()).catch(() => {}),
    onZoom: (k) => (zoomLevel.val = k),
  });
  // e2e / Playwright hooks for integration-register Map export (RG).
  // Only when ?e2e is present so production builds never expose internals.
  if (new URLSearchParams(location.search).has("e2e")) {
    window.__smGraph = {
      buildExportSVG: (mode) => graph.buildExportSVG(mode),
      exportMapPNG: () => graph.exportMapPNG(),
      fitToView: () => graph.fitToView(),
    };
  }

  van.derive(() => {
    if (data.val) graph.setData(data.val);
  });
  van.derive(() => {
    graph.setFilter(filterVals(), mode.val);
  });
  van.derive(() => graph.setSelection(selection.val));
  van.derive(() => graph.setExpand(expand.val));
  van.derive(() => graph.setFanSpacing(fanSpacing.val));
  van.derive(() => graph.setShowEdgeLabels(showEdgeLabels.val));
  // Persist display prefs / viewer state whenever they change (debounced).
  van.derive(() => {
    expand.val;
    fanSpacing.val;
    showEdgeLabels.val;
    saveDisplay();
  });
  van.derive(() => {
    showFilterHud.val;
    filters.queries.val;
    filters.statuses.val;
    filters.timings.val;
    filters.needs.val;
    filters.systems.val;
    filters.clusters.val;
    filters.flow.val;
    saveUserState();
  });
  // Keep cluster name cache warm so deleted chips still show a real name.
  van.derive(() => {
    let dirty = false;
    for (const c of data.val?.clusters ?? []) {
      if (clusterNameCache.get(c.id) !== c.name) {
        clusterNameCache.set(c.id, c.name);
        dirty = true;
      }
    }
    if (dirty) persistClusterNames();
  });

  // ---- matrix view (same data, same FilteredView, different lens) ----
  // DR-9: centered table with presence-sized cells + structure caption.
  // FU-4: caption from the same filtered cell data the table renders;
  // "one-way" is invariant (never "one-ways").
  const matrixView = () => {
    const d = data.val;
    if (view.val !== "matrix" || !d) return span({ style: "display:none" });
    const V = filteredView();
    const systems = [...d.systems].sort((x, y) => x.name.localeCompare(y.name));
    // Matched streams per cell — compute once; cells + caption both reuse.
    const cellMap = new Map(); // `${srcId}>${dstId}` → matched streams
    let matchedTotal = 0;
    for (const src of systems) {
      for (const dst of systems) {
        const streams = V.partition(
          d.streams.filter((st) => st.source.system_id === src.id && st.destination.system_id === dst.id)).matched;
        cellMap.set(`${src.id}>${dst.id}`, streams);
        matchedTotal += streams.length;
      }
    }
    // Caption from filtered cells: undirected connections · one-way pairs.
    // one-way = only one matrix direction has matched streams; stream.direction
    // "bi" is irrelevant here (a lone bi A→B cell still counts as one-way).
    const pairs = new Map(); // a~b → { ab, ba } (has matched streams in that dir)
    for (const src of systems) {
      for (const dst of systems) {
        const streams = cellMap.get(`${src.id}>${dst.id}`);
        if (!streams?.length) continue;
        const a = src.id, b = dst.id;
        const k = a < b ? `${a}~${b}` : `${b}~${a}`;
        let p = pairs.get(k);
        if (!p) { p = { ab: false, ba: false }; pairs.set(k, p); }
        if (a === b) continue; // self-loop still counts as a connection via pairs.size
        if (a < b) p.ab = true;
        else p.ba = true;
      }
    }
    let oneWay = 0;
    for (const [k, p] of pairs) {
      const [a, b] = k.split("~");
      if (a === b) continue;
      if ((p.ab && !p.ba) || (!p.ab && p.ba)) oneWay++;
    }
    // Cell size: 44–64px, grows for small landscapes so 5 systems fill the space.
    const cell = Math.min(64, Math.max(44, Math.round(52 + (15 - Math.min(systems.length, 15)) * 1.2)));
    const { table, thead, tbody, tr, th, td } = van.tags;
    return div({ class: "matrix-wrap" },
      div({ class: "matrix-center" },
        p({ class: "matrix-note" }, "Rows send, columns receive. Cell = matching streams; click to dig in."),
        table({ class: "matrix", style: `--mx-cell:${cell}px;--mx-cell-h:${Math.round(cell * 0.82)}px` },
          thead(tr(th({ class: "corner" }, "src \\ dst"), systems.map((s) => th({ class: "col-head" }, span(s.name))))),
          tbody(systems.map((src) =>
            tr(
              th({ class: "row-head" }, src.name),
              systems.map((dst) => {
                const streams = cellMap.get(`${src.id}>${dst.id}`) ?? [];
                const n = streams.length;
                const heat = n ? Math.min(n / 4, 1) * 0.55 + 0.12 : 0;
                return td(
                  n
                    ? button({
                        class: "cell",
                        style: `background:rgba(230,162,60,${heat.toFixed(2)})`,
                        title: streams.map((st) => st.name).join("\n"),
                        onclick: () => (selection.val = {
                          type: "edge",
                          a: src.id < dst.id ? src.id : dst.id,
                          b: src.id < dst.id ? dst.id : src.id,
                        }),
                      }, String(n))
                    : span({ class: "cell-empty" }, "·"),
                );
              }),
            ))),
        ),
        p({ class: "matrix-caption" },
          `${plural(matchedTotal, "stream")} · ${plural(pairs.size, "connection")} · ${oneWay} one-way`),
      ),
    );
  };

  van.add(canvasEl, matrixView);
  van.derive(() => canvasEl.classList.toggle("matrix-mode", view.val === "matrix"));

  // Esc closes the inspector (one live handler across route changes)
  let lastFitKey = 0; // double-press of "0" centers the selection
  if (window._smKeyHandler) document.removeEventListener("keydown", window._smKeyHandler);
  window._smKeyHandler = (e) => {
    if (e.key === "Escape") {
      // Priority (first match wins) — see group-selection plan §3.2:
      // 1) marquee in progress → cancel marquee, keep selection
      // 2) inline Make-cluster input (GS-4) handles Esc locally via stopPropagation
      // 3) history detail  4) history popover  5) clear selection + project popover
      if (graph.isMarqueeActive?.() && graph.cancelMarquee()) return;
      if (historyDetail.val) { historyDetail.val = null; return; }
      if (showHistory.val) { showHistory.val = false; return; }
      selection.val = null; showProject.val = false;
      return;
    }
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    // Bare-key zoom: + / − step, 0 fits (0 again within 500ms centers the
    // selection). Graph lens only; never while typing or in a form, and
    // never with modifiers (Ctrl/Cmd+± stays browser zoom).
    if (!e.ctrlKey && !e.metaKey && !e.altKey && view.val === "graph") {
      if (!typing && !editing.val) {
        if (e.key === "+" || e.key === "=") { e.preventDefault(); graph.zoomBy(1.25); return; }
        if (e.key === "-" || e.key === "_") { e.preventDefault(); graph.zoomBy(0.8); return; }
        if (e.key === "0") {
          e.preventDefault();
          const now = Date.now();
          if (now - lastFitKey < 500 && selection.val) graph.focusSelection();
          else graph.fitToView();
          lastFitKey = now;
          return;
        }
      }
    }
    // Cmd/Ctrl+A: select all visible nodes → group (graph lens only).
    const meta = e.ctrlKey || e.metaKey;
    if (meta && !e.altKey && !e.shiftKey && (e.key === "a" || e.key === "A")
        && view.val === "graph" && !typing && !editing.val) {
      e.preventDefault();
      const ids = graph.visibleNodeIds?.() ?? [];
      if (ids.length >= 2) selection.val = { type: "group", ids: [...ids] };
      else if (ids.length === 1) selection.val = { type: "node", id: ids[0] };
      else selection.val = null;
      return;
    }
    // Delete / Backspace: arm the confirm strip for group/cluster — never delete
    // directly from the keyboard (§3.2).
    if (!meta && !e.altKey && !typing && !editing.val
        && (e.key === "Delete" || e.key === "Backspace")
        && (selection.val?.type === "group" || selection.val?.type === "cluster")) {
      e.preventDefault();
      if (selection.val.type === "group") pendingDel.val = "group";
      else if (selection.val.type === "cluster") {
        pendingDel.val = `clusters:${selection.val.id}`;
        clusterUI.val = null;
      }
      return;
    }
    // Undo / redo: Ctrl+Z undo, Ctrl+Shift+Z or Ctrl+Y redo. Skipped while
    // typing, while a form is open, or while a history detail is open.
    if (!meta || e.altKey) return;
    if (e.key !== "z" && e.key !== "Z" && e.key !== "y" && e.key !== "Y") return;
    if (typing || editing.val || historyDetail.val) return;
    if (e.shiftKey || e.key === "y" || e.key === "Y") { e.preventDefault(); doRedo(); }
    else { e.preventDefault(); doUndo(); }
  };
  document.addEventListener("keydown", window._smKeyHandler);

  // ---- CRUD plumbing ----
  const save = (kind, payload) =>
    busy(async () => {
      const ep = api[kind];
      const item = editing.val?.item;
      if (item) await ep.update(proj, item.id, payload);
      else await ep.create(proj, payload);
      editing.val = null;
      toast("Saved");
      reload();
    });

  // Inline two-step delete: the card's Del button arms `pendingDel`, the card
  // then renders a confirm strip (guard message + Delete/Cancel) in place of
  // its actions — no native confirm() dialogs. A successful delete offers
  // Undo in the toast (deletes are just history commits).
  const pendingDel = van.state(null); // "kind:id" | "group" awaiting confirmation
  // Group inspector inline expand: null | "make_cluster" | "add_to_cluster" | "set_type".
  const groupUI = van.state(null);
  // Non-reactive draft so typing doesn't remount the input (Van footgun).
  let makeClusterDraft = "";
  // Cluster inspector inline expand: null | "add_systems" | "needs".
  const clusterUI = van.state(null);
  van.derive(() => {
    if (selection.val?.type !== "group") {
      groupUI.val = null;
      makeClusterDraft = "";
      if (pendingDel.val === "group") pendingDel.val = null;
    }
    if (selection.val?.type !== "cluster") {
      clusterUI.val = null;
    }
  });
  const remove = (kind, item) =>
    busy(async () => {
      pendingDel.val = null;
      await api[kind].del(proj, item.id);
      // Clear selection when the deleted object was selected (or any selection —
      // existing behavior for systems/streams; cluster ids are checked below).
      if (selection.val) {
        if (kind === "clusters" && selection.val.type === "cluster" && selection.val.id === item.id) {
          selection.val = null;
        } else if (kind !== "clusters") {
          selection.val = null;
        }
      }
      const msg = kind === "clusters"
        ? `Deleted cluster "${item.name}"`
        : `Deleted "${item.name}"`;
      toast(msg, false,
        undoBlocked() ? null : { label: "Undo", onclick: doUndo });
      reload();
    });
  const confirmStrip = (kind, item, msg) =>
    div({ class: "warn-note" },
      msg ?? `Delete "${item.name}"? Recoverable from the project trash.`,
      div({ class: "confirm-actions" },
        button({ class: "btn small danger", onclick: () => remove(kind, item) }, "Delete"),
        button({ class: "btn ghost small", onclick: () => (pendingDel.val = null) }, "Cancel"),
      ));
  const delButton = (kind, item) =>
    button({ class: "btn ghost small danger", onclick: () => (pendingDel.val = `${kind}:${item.id}`) }, "Del");
  const delPending = (kind, item) => pendingDel.val === `${kind}:${item.id}`;

  // GS-2: bulk delete / set type via one batch request = one history entry.
  const batchDeleteGroup = () =>
    busy(async () => {
      const sel = selection.val;
      if (sel?.type !== "group" || !sel.ids?.length) return;
      const ids = [...sel.ids];
      pendingDel.val = null;
      await api.systemsBatch(proj, ids.map((id) => ({ op: "delete", id })));
      selection.val = null;
      toast(`Deleted ${plural(ids.length, "system")}`, false,
        undoBlocked() ? null : { label: "Undo", onclick: doUndo });
      reload();
    });
  const batchSetType = (type) =>
    busy(async () => {
      const sel = selection.val;
      if (sel?.type !== "group" || !sel.ids?.length) return;
      const ids = [...sel.ids];
      groupUI.val = null;
      await api.systemsBatch(proj, ids.map((id) => ({ op: "set_type", id, type })));
      toast(`Type set on ${plural(ids.length, "system")}`, false,
        undoBlocked() ? null : { label: "Undo", onclick: doUndo });
      reload();
    });
  const groupDeleteConfirmMsg = (memberIds) => {
    const n = memberIds.length;
    const streamCount = (data.val?.streams ?? []).filter((st) =>
      memberIds.includes(st.source.system_id) || memberIds.includes(st.destination.system_id)).length;
    if (streamCount === 0) {
      return `Delete ${plural(n, "system")}? Recoverable from the project trash.`;
    }
    if (streamCount === 1) {
      return `Delete ${plural(n, "system")}? 1 stream touching them is deleted too. Recoverable from the project trash.`;
    }
    return `Delete ${plural(n, "system")}? ${streamCount} streams touching them are deleted too. Recoverable from the project trash.`;
  };
  // FU-2: cluster delete confirm — n = members that still exist as systems.
  const clusterDeleteConfirmMsg = (name, n) => {
    if (n === 0) return `Delete cluster "${name}"?`;
    if (n === 1) return `Delete cluster "${name}"? Its 1 system stays on the map.`;
    return `Delete cluster "${name}"? Its ${n} systems stay on the map.`;
  };

  // Lowest unused "Cluster N" default name (§4).
  const nextClusterDefaultName = () => {
    const used = new Set((data.val?.clusters ?? []).map((c) => c.name));
    let n = 1;
    while (used.has(`Cluster ${n}`)) n++;
    return `Cluster ${n}`;
  };

  // POST a new cluster from the current group selection; select it; animate hull.
  const makeClusterFromGroup = (name) =>
    busy(async () => {
      const sel = selection.val;
      if (sel?.type !== "group" || !sel.ids?.length) return;
      const trimmed = (name || "").trim();
      if (!trimmed) return;
      const color = graph.leastUsedClusterColor?.() ?? "verdigris";
      const created = await api.clusters.create(proj, {
        name: trimmed,
        system_ids: [...sel.ids],
        color,
      });
      groupUI.val = null;
      toast(`Created cluster "${created.name}"`, false,
        undoBlocked() ? null : { label: "Undo", onclick: doUndo });
      await reload();
      selection.val = { type: "cluster", id: created.id };
      graph.animateClusterCreate?.(created.id);
    });

  // Union current group ids into an existing cluster.
  const addGroupToCluster = (cluster) =>
    busy(async () => {
      const sel = selection.val;
      if (sel?.type !== "group" || !sel.ids?.length) return;
      const union = [...new Set([...(cluster.system_ids ?? []), ...sel.ids])];
      await api.clusters.update(proj, cluster.id, { ...cluster, system_ids: union });
      groupUI.val = null;
      toast("Saved");
      await reload();
      selection.val = { type: "cluster", id: cluster.id };
    });

  const saveCluster = (cluster, patch) =>
    busy(async () => {
      await api.clusters.update(proj, cluster.id, { ...cluster, ...patch });
      toast("Saved");
      reload();
    });

  // ---- rail lists ----
  const SystemItem = (s) => {
    const ents = (s.entities ?? []).length;
    const flds = (s.entities ?? []).reduce((n, e) => n + (e.fields ?? []).length, 0);
    const used = data.val.streams.filter((st) => st.source.system_id === s.id || st.destination.system_id === s.id).length;
    return div({ class: "entity-item" },
      div({ class: "ei-head" },
        span({ class: `type-dot ${s.type || "unknown"}` }),
        span({ class: "ei-name" }, s.name, " ", provChip(s)),
        div({ class: "ei-actions" },
          button({ class: "btn ghost small", onclick: () => (editing.val = { kind: "systems", item: s }) }, "Edit"),
          delButton("systems", s),
        ),
      ),
      delPending("systems", s) ? confirmStrip("systems", s, used
        ? `"${s.name}" is used by ${plural(used, "stream")} — deleting it also deletes those streams (all recoverable from trash).`
        : null) : null,
      s.description ? div({ class: "ei-sub" }, s.description) : null,
      ents ? div({ class: "ei-sub" }, `${plural(ents, "entity", "entities")} · ${plural(flds, "field")}`) : null,
    );
  };

  const StreamItem = (st) =>
    div({ class: "entity-item" },
      div({ class: "ei-head" },
        span({ class: "ei-name" }, st.name, " ", provChip(st)),
        div({ class: "ei-actions" },
          button({ class: "btn ghost small", onclick: () => (editing.val = { kind: "streams", item: st }) }, "Edit"),
          delButton("streams", st),
        ),
      ),
      delPending("streams", st) ? confirmStrip("streams", st) : null,
      div({ class: "ei-sub" },
        `${sysName(st.source.system_id)} ${st.direction === "bi" ? "⇄" : "→"} ${sysName(st.destination.system_id)}`),
      div({ style: "margin-top:5px" },
        span({ class: `chip ${st.status}` }, st.status),
        span({ class: "chip" }, st.timing),
        st.api_type ? span({ class: "chip" }, st.api_type) : null,
        needNames(st.biz_need_ids).map((n) => span({ class: "chip" }, n)),
      ),
    );

  const NeedItem = (n) =>
    div({ class: "entity-item" },
      div({ class: "ei-head" },
        span({ class: "ei-name" }, n.name, " ", provChip(n)),
        div({ class: "ei-actions" },
          button({
            class: "btn ghost small",
            title: "Filter the map by streams that carry this need",
            onclick: () => {
              const next = new Set(filters.needs.val);
              next.add(n.id);
              filters.needs.val = next;
              showFilterHud.val = true;
              hudCollapsed.val = false;
              showSuggestions.val = true;
            },
          }, "Filter"),
          button({ class: "btn ghost small", onclick: () => (editing.val = { kind: "needs", item: n }) }, "Edit"),
          delButton("needs", n),
        ),
      ),
      delPending("needs", n) ? confirmStrip("needs", n, (() => {
        const used = data.val.streams.filter((st) => (st.biz_need_ids ?? []).includes(n.id)).length;
        return used ? `"${n.name}" groups ${plural(used, "stream")} — they will simply lose this need.` : null;
      })()) : null,
      n.description ? div({ class: "ei-sub" }, n.description) : null,
      div({ class: "ei-sub" }, plural(
        data.val.streams.filter((st) => (st.biz_need_ids ?? []).includes(n.id)).length,
        "stream",
      )),
    );

  // VanJS silently keeps the old DOM if a binding function throws, which
  // reads as a frozen UI — surface render errors instead.
  const FlowItem = (fl) => {
    const implied = flowImpliedNeeds(fl, data.val);
    const direct = new Set(fl.biz_need_ids ?? []);
    const shape = flowShape(fl, data.val);
    return div({ class: "entity-item" },
      div({ class: "ei-head" },
        span({ class: "ei-name" }, fl.name, " ", provChip(fl)),
        div({ class: "ei-actions" },
          button({ class: "btn ghost small", title: "Open the flow inspector and focus it on the map", onclick: () => {
            selection.val = { type: "flow", id: fl.id };
            filters.flow.val = fl.id;
            showFilterHud.val = true; // flow is a regular filter condition
            hudCollapsed.val = true;
          } }, "Show"),
          button({ class: "btn ghost small", onclick: () => (editing.val = { kind: "flows", item: fl }) }, "Edit"),
          delButton("flows", fl),
        ),
      ),
      delPending("flows", fl) ? confirmStrip("flows", fl) : null,
      fl.description ? div({ class: "ei-sub" }, fl.description) : null,
      // hops = streams in the flow; stages can hold parallel hops, so both counts stay.
      div({ class: "ei-sub" },
        `${plural((fl.steps ?? []).length, "hop")} · ${plural(shape.stages.length, "stage")}`,
        shape.components > 1 ? span({ style: "color:var(--accent)" }, ` · ${shape.components} disconnected pieces`) : null,
        shape.orderWarnings.length ? span({ style: "color:var(--accent)" }, " · order ≠ wiring") : null),
      div({ style: "margin-top:5px" },
        needNames(fl.biz_need_ids).map((n) => span({ class: "chip" }, n)),
        [...implied].filter((id) => !direct.has(id)).map((id) => {
          const nm = data.val.needs.find((n) => n.id === id)?.name;
          return nm ? span({ class: "chip ghost", title: "Implied by this flow's streams, not declared on the flow" }, nm) : null;
        }),
      ),
    );
  };

  // Cluster rail card — SystemItem structure with color dot + meta line (§5.3).
  const ClusterItem = (c) => {
    const present = new Set((data.val?.systems ?? []).map((s) => s.id));
    const nSys = (c.system_ids ?? []).filter((id) => present.has(id)).length;
    const nNeeds = (c.biz_need_ids ?? []).length;
    const hex = graph.clusterColorHex?.(c.color) ?? "#3fae94";
    const allGone = (c.system_ids ?? []).length > 0 && nSys === 0;
    const meta = allGone
      ? "0 systems — members were deleted"
      : nNeeds > 0
        ? `${plural(nSys, "system")} · ${plural(nNeeds, "need")}`
        : plural(nSys, "system");
    return div({ class: "entity-item" },
      div({ class: "ei-head" },
        span({ class: "cluster-dot", style: `background:${hex}` }),
        span({
          class: "ei-name",
          style: "cursor:pointer",
          onclick: () => (selection.val = { type: "cluster", id: c.id }),
        }, c.name, " ", provChip(c)),
        div({ class: "ei-actions" },
          button({ class: "btn ghost small", onclick: () => (editing.val = { kind: "clusters", item: c }) }, "Edit"),
          delButton("clusters", c),
        ),
      ),
      delPending("clusters", c)
        ? confirmStrip("clusters", c, clusterDeleteConfirmMsg(c.name, nSys))
        : null,
      c.description ? div({ class: "ei-sub" }, c.description) : null,
      div({ class: "ei-sub" }, meta),
    );
  };

  const railBody = () => {
    try {
      return railBodyInner();
    } catch (err) {
      console.error("rail render failed:", err);
      return div({ class: "empty-note" }, "Couldn't render this list — see the browser console.");
    }
  };
  const railBodyInner = () => {
    const d = data.val;
    if (!d) return div({ class: "empty-note" }, "Loading…");
    const kind = tab.val;
    const ed = editing.val;
    const V = filteredView();

    const formEl = ed && ed.kind === kind
      ? div({ class: "rail-form" },
          kind === "systems" ? SystemForm({ item: ed.item, needs: d.needs, onSave: (v) => save("systems", v), onCancel: () => (editing.val = null) })
          : kind === "needs" ? NeedForm({ item: ed.item, onSave: (v) => save("needs", v), onCancel: () => (editing.val = null) })
          : kind === "flows" ? FlowForm({ item: ed.item, streams: d.streams, needs: d.needs, systems: d.systems, onSave: (v) => save("flows", v), onCancel: () => (editing.val = null) })
          : kind === "clusters" ? ClusterForm({
              item: ed.item,
              systems: d.systems,
              needs: d.needs,
              colorKeys: graph.clusterColorKeys?.() ?? [],
              colorHex: (k) => graph.clusterColorHex?.(k) ?? k,
              defaultColor: graph.leastUsedClusterColor?.() ?? "verdigris",
              onSave: (v) => save("clusters", v),
              onCancel: () => (editing.val = null),
            })
          : StreamForm({ proj, item: ed.item, systems: d.systems, needs: d.needs, onSave: (v) => save("streams", v), onCancel: () => (editing.val = null) }))
      : null;

    const addLabel = {
      systems: "+ Add system", streams: "+ Add stream", needs: "+ Add business need",
      flows: "+ Add flow", clusters: "+ Add cluster",
    }[kind];
    const addBtn = formEl ? null
      : kind === "streams" && d.systems.length < 1
        ? div({ class: "empty-note" }, "Add a system first — a stream connects systems.")
      : kind === "flows" && d.streams.length < 1
        ? div({ class: "empty-note" }, "Add streams first — a flow strings existing streams together.")
      : kind === "clusters"
        ? null // clusters are created from a map group selection, not the rail Add
        : button({ class: "btn rail-add", onclick: () => (editing.val = { kind }) }, addLabel);

    // rail lists come straight from the shared view — same logic as canvas
    // clusters are unfiltered in GS-4 (filter integration is GS-5)
    const all = {
      systems: d.systems, streams: d.streams, needs: d.needs, flows: d.flows,
      clusters: d.clusters ?? [],
    }[kind];
    const filtered = {
      systems: () => V.systems(), streams: () => V.streams(), needs: () => V.needs(),
      flows: () => V.flows(), clusters: () => d.clusters ?? [],
    }[kind]();

    const items = filtered.map({
      systems: SystemItem, streams: StreamItem, needs: NeedItem,
      flows: FlowItem, clusters: ClusterItem,
    }[kind]);
    const shownNote = filtered.length !== all.length
      ? div({ class: "shown-note" }, `${filtered.length} of ${all.length} match the filter`)
      : null;
    const empty = all.length ? null : div({ class: "empty-note" },
      { systems: "No systems yet. Systems are the boxes on your map.",
        streams: "No streams yet. Streams are the data flows between systems.",
        needs: "No business needs yet. Use them to group streams by why they exist.",
        flows: "No flows yet. A flow is an end-to-end journey: pick the streams a piece of data travels through.",
        clusters: "No clusters yet. Shift-drag on the map to gather systems, then Make cluster." }[kind]);

    return div(formEl, addBtn, shownNote, empty, items);
  };

  // ---- inspector ----
  // A stream card is partitioned into regions instead of one flat kv list:
  // a clickable header (with a collapse toggle), a one-line summary, then a
  // two-column Source → Destination endpoint block where each entity groups
  // its own fields (so entity→field ownership is unambiguous), a responsive
  // contract grid (timing/api/format) that reflows as the drawer widens, and
  // business-need chips. Density is controlled at three levels so big streams
  // stay scannable: whole-card collapse, per-entity collapse, and a field-list
  // cap with a "+N more" reveal. All three state sets are closure-level and
  // keyed by stable ids, so they survive the reactive re-renders the inspector
  // does when the drawer is resized or filters change; `cardBump` drives those
  // re-renders. The header + summary sit in a sticky bar so the stream's
  // identity stays visible while you scroll a long field list.
  const collapsedCards = new Set();
  const collapsedEntities = new Set();
  const expandedFields = new Set();
  const cardBump = van.state(0);
  const FLD_CAP = 6;
  const toggleSet = (set, key) => { if (set.has(key)) set.delete(key); else set.add(key); };
  // Enter / Space on a role=button header toggles it via click().
  const onActivate = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } };

  const sysOf = (id) => (data.val?.systems ?? []).find((s) => s.id === id);
  // Resolve an endpoint's entities from the catalog, splitting known from
  // deleted (ids referenced by the stream but no longer in any system).
  const entGroups = (ep) => {
    const sys = sysOf(ep.system_id);
    const ids = ep.entity_ids ?? [];
    const ents = (sys?.entities ?? []).filter((e) => ids.includes(e.id));
    const known = new Set((sys?.entities ?? []).map((e) => e.id));
    const missing = ids.filter((id) => !known.has(id));
    return { sys, ents, missing };
  };
  // Fields an endpoint carries for a given entity, per fields_mode. Returns
  // null when the mode is "unknown" (fields not documented).
  const epFields = (ep, ent) => {
    if (ep.fields_mode === "list") return (ent.fields ?? []).filter((f) => (ep.field_ids ?? []).includes(f.id));
    if (ep.fields_mode === "all") return ent.fields ?? [];
    return null;
  };
  const epCounts = (ep) => {
    const { ents } = entGroups(ep);
    const entN = (ep.entity_ids ?? []).length;
    let fldN = 0;
    if (ep.fields_mode === "list") fldN = (ep.field_ids ?? []).length;
    else if (ep.fields_mode === "all") fldN = ents.reduce((n, e) => n + (e.fields ?? []).length, 0);
    return { entN, fldN, mode: ep.fields_mode };
  };
  // Endpoint payload summary — same vocabulary as the canvas tooltip (DR-6).
  // Spell out entity/field; "all fields" for fields_mode=all.
  const epSummary = (ep) => {
    const { entN, fldN, mode } = epCounts(ep);
    const ent = plural(entN, "entity", "entities");
    if (mode === "all") return `${ent} · all fields`;
    if (mode === "list") return `${ent} · ${plural(fldN, "field")}`;
    return `${ent} · fields not documented`;
  };
  // Both endpoints empty and neither is a documented mode → one phrase, no arrow.
  const payloadBothUndocumented = (st) => {
    const bare = (ep) =>
      (ep.entity_ids ?? []).length === 0
      && ep.fields_mode !== "all"
      && ep.fields_mode !== "list";
    return bare(st.source) && bare(st.destination);
  };

  const streamCard = (st, V, stage = null) => {
    cardBump.val; // re-run on collapse toggles
    const collapsed = collapsedCards.has(st.id);
    const arrow = st.direction === "bi" ? "⇄" : "→";
    const needs = needNames(st.biz_need_ids);
    const toggle = (ev) => { ev.stopPropagation(); toggleSet(collapsedCards, st.id); cardBump.val++; };
    const entToggle = (key) => (ev) => { ev.stopPropagation(); toggleSet(collapsedEntities, key); cardBump.val++; };
    const fldToggle = (key) => (ev) => { ev.stopPropagation(); toggleSet(expandedFields, key); cardBump.val++; };

    const fieldRow = (f) =>
      div({ class: "sc-field" },
        span({ class: "sc-fname" }, f.name),
        f.type ? span({ class: "sc-ftype" }, f.type) : null);

    // `side` is "src" / "dst" so entity-collapse keys are stable and distinct
    // per endpoint of the same stream.
    const entRow = (ep, e, side) => {
      const fields = epFields(ep, e);
      const total = (e.fields ?? []).length;
      const badge = ep.fields_mode === "list" ? `${fields ? fields.length : 0}/${total}`
        : ep.fields_mode === "all" ? `all ${total}` : "unknown";
      const key = `${st.id}:${side}:${e.id}`;
      const entCollapsed = collapsedEntities.has(key);
      const body = fields == null
        ? div({ class: "sc-empty" }, "fields not documented")
        : total === 0
          ? div({ class: "sc-empty" }, "no fields catalogued")
          : (() => {
              const all = fields;
              const expanded = expandedFields.has(key);
              const shown = expanded ? all : all.slice(0, FLD_CAP);
              const hidden = all.length - FLD_CAP;
              return [
                div({ class: "sc-fields" }, shown.map(fieldRow)),
                all.length > FLD_CAP
                  ? button({ class: "sc-more", onclick: fldToggle(key) },
                      expanded ? "show less" : `+${hidden} more`)
                  : null,
              ];
            })();
      return div({ class: "sc-ent" },
        div({ class: "sc-ent-head", onclick: entToggle(key), role: "button", tabindex: "0", onkeydown: onActivate },
          span({ class: "sc-chev" + (entCollapsed ? "" : " open") }, "▸"),
          span({ class: "sc-ent-name" }, e.name),
          provChip(e),
          span({ class: `sc-ent-badge${ep.fields_mode === "all" ? " all" : ""}` }, badge),
        ),
        entCollapsed ? null : body,
      );
    };

    const epColumn = (ep, label, side) => {
      const { sys, ents, missing } = entGroups(ep);
      const sysNm = sys?.name ?? "(deleted system)";
      // no visible source/destination caption — the arrow between the columns
      // carries direction; the caption only stole width from the system name
      return div({ class: "sc-ep", "aria-label": label, title: label },
        div({ class: "sc-ep-head" },
          span({ class: "sc-ep-sys", title: sysNm }, sysNm),
        ),
        div({ class: "sc-ep-body" },
          (ents.length || missing.length)
            ? [
                ents.map((e) => entRow(ep, e, side)),
                missing.length
                  ? missing.map((id) => div({ class: "sc-ent" },
                      div({ class: "sc-ent-head" },
                        span({ class: "sc-ent-name" }, V.entName(id)),
                        span({ class: "sc-ent-badge" }, "deleted"))))
                  : null,
              ]
            : div({ class: "sc-empty" },
                ep.fields_mode === "unknown" ? "no entities documented" : "no entities selected")),
      );
    };

    return div({ class: "strand-card" },
      div({ class: "sc-sticky" },
        div({ class: "sc-head", onclick: toggle, role: "button", tabindex: "0", onkeydown: onActivate },
          span({ class: "sc-chev" + (collapsed ? "" : " open") }, "▸"),
          h4(stage != null ? span({ class: "stage-chip", title: "Stage in the focused flow" }, String(stage)) : null,
            st.name, " ", provChip(st)),
          span({ class: `chip ${st.status}` }, st.status || "—"),
        ),
        // Two lines by design (DR-6): route, then spelled-out payload — no ent/fld.
        // Fully undocumented streams collapse to one phrase (no doubled "0 entities").
        div({ class: "sc-summary" },
          div({ class: "sc-route" },
            span(sysName(st.source.system_id)), " ", span({ class: "arrow" }, arrow), " ",
            span(sysName(st.destination.system_id))),
          div({ class: "sc-payload" },
            payloadBothUndocumented(st)
              ? "payload not documented"
              : [
                  span(epSummary(st.source)), " ", span({ class: "arrow" }, arrow), " ",
                  span(epSummary(st.destination)),
                ])),
      ),
      collapsed ? null : div({ class: "sc-body" },
        div({ class: "sc-eps" },
          epColumn(st.source, "source", "src"),
          div({ class: "sc-arrow" }, arrow),
          epColumn(st.destination, "destination", "dst"),
        ),
        // DR-14: facts as prose meta (not TIMING/API TYPE/FORMAT/NEEDS eyebrows).
        (() => {
          const bits = [st.timing, st.api_type, st.data_format].filter(Boolean);
          const needPart = needs.length
            ? (needs.length === 1 ? `serves ${needs[0]}` : `serves ${needs.join(", ")}`)
            : null;
          const line = [bits.join(" · "), needPart].filter(Boolean).join(" — ");
          return line
            ? div({ class: "sc-meta" }, line)
            : null;
        })(),
        div({ class: "sc-actions" },
          button({ class: "btn ghost small", onclick: (ev) => { ev.stopPropagation(); tab.val = "streams"; editing.val = { kind: "streams", item: st }; } }, "Edit stream"),
        ),
      ),
    );
  };

  // ---- analysis panel (AJ-1…AJ-6: suggestion-first justify UX) ----
  // Panel-scoped UI state — cleared when Analysis is closed or reopened.
  const analysisSettled = van.state(new Map()); // key -> { needId, needName, rows }
  const analysisPicker = van.state(null);      // open picker card key (one at a time)
  const analysisSplit = van.state(new Set());  // group keys expanded to per-field
  let analysisOpen = false;
  van.derive(() => {
    const open = selection.val?.type === "analysis";
    if (open && !analysisOpen) {
      analysisSettled.val = new Map();
      analysisPicker.val = null;
      analysisSplit.val = new Set();
    }
    if (!open && analysisOpen) {
      analysisSettled.val = new Map();
      analysisPicker.val = null;
      analysisSplit.val = new Set();
      graph.highlightStreams?.(null);
    }
    analysisOpen = open;
  });

  // Write need on/off for one or more finding rows. One PUT per system (AJ-2).
  // settleKey: when set and on=true, pin the card in place (AJ-3).
  const justifyFields = (rows, needId, on, opts = {}) => busy(async () => {
    if (!rows?.length) return;
    const d0 = data.val;
    const needNm = d0.needs.find((n) => n.id === needId)?.name ?? "need";
    // Group rows by live system object for one update each.
    const bySys = new Map(); // sysId -> { sys, fieldOps: [{entId, fldId}] }
    for (const row of rows) {
      let bucket = bySys.get(row.sys.id);
      if (!bucket) {
        const sys = d0.systems.find((s) => s.id === row.sys.id);
        if (!sys) continue;
        bucket = { sys, ops: [] };
        bySys.set(row.sys.id, bucket);
      }
      bucket.ops.push({ entId: row.ent.id, fldId: row.fld.id, row });
    }
    const touchedNames = [];
    for (const { sys, ops } of bySys.values()) {
      for (const op of ops) {
        const fld = sys.entities.find((e) => e.id === op.entId)?.fields.find((f) => f.id === op.fldId);
        if (!fld) continue;
        const set = new Set(fld.biz_need_ids ?? []);
        on ? set.add(needId) : set.delete(needId);
        fld.biz_need_ids = [...set];
        touchedNames.push(fld.name);
      }
      await api.systems.update(proj, sys.id, sys);
    }
    if (!touchedNames.length) return;
    if (on) {
      if (opts.settleKey) {
        const next = new Map(analysisSettled.val);
        next.set(opts.settleKey, {
          needId,
          needName: needNm,
          rows: rows.map((r) => ({
            sys: r.sys, ent: r.ent, fld: r.fld, movedBy: r.movedBy,
          })),
        });
        analysisSettled.val = next;
      }
      if (rows.length === 1) {
        toast(`Justified ${touchedNames[0]} with ${needNm} — moved to Justified`);
      } else {
        toast(`Justified ${plural(rows.length, "field")} with ${needNm} — moved to Justified`);
      }
    } else if (opts.removeToast) {
      toast(`Removed justification for ${touchedNames[0]}`);
    } else if (rows.length === 1) {
      toast(`Removed justification for ${touchedNames[0]}`);
    } else {
      toast(`Removed justification for ${plural(rows.length, "field")}`);
    }
    // // AJ-?: multi-field remove toast is not frozen in the plan for group undo;
    // single-field remove copy is the plan's only explicit remove string.
    reload();
  });

  const analysisBody = (d) => {
    const A = analyze(d);
    const stat = (label, val) => div({ class: "stat-line" }, span(label), van.tags.b(val));
    const e2e = new URLSearchParams(location.search).has("e2e");

    // AJ-4: via-line with stream names as cut-path links.
    const viaLine = (movedBy) => {
      const parts = [];
      movedBy.forEach((st, i) => {
        if (i) parts.push(", ");
        parts.push(button({
          type: "button",
          class: "linklike arow-stream",
          title: "Open this stream — remove the field there if nothing justifies it",
          onclick: (ev) => {
            ev.stopPropagation();
            tab.val = "streams";
            editing.val = { kind: "streams", item: st };
          },
        }, st.name));
      });
      return div({ class: "arow-moved" }, "via ", ...parts);
    };

    // AJ-1 controls: suggestion chips + Other need / Justify with picker.
    const needsControls = (rows, cardKey, { settle = false } = {}) => {
      if (!d.needs.length) return null; // section-level empty handles zero needs
      const suggestions = suggestNeeds(rows, d);
      const chips = suggestions.slice(0, 3);
      const pickerOpen = analysisPicker.val === cardKey;
      const pickerLabel = chips.length ? "Other need ▾" : "Justify with ▾";
      const allNeeds = [...d.needs].sort((a, b) => a.name.localeCompare(b.name));
      const fieldHas = (nid) => (rows[0].fld.biz_need_ids ?? []).includes(nid);

      return div({ class: "arow-needs" },
        chips.map((s) => button({
          type: "button",
          class: "btn ghost small arow-suggest",
          title: s.title,
          onclick: (ev) => {
            ev.stopPropagation();
            analysisPicker.val = null;
            justifyFields(rows, s.id, true, settle ? { settleKey: cardKey } : {});
          },
        }, `+ ${s.name}`)),
        button({
          type: "button",
          class: "btn ghost small arow-picker",
          onclick: (ev) => {
            ev.stopPropagation();
            analysisPicker.val = pickerOpen ? null : cardKey;
          },
        }, pickerLabel),
        pickerOpen
          ? div({
              class: "checklist arow-picker-list",
              onkeydown: (ev) => {
                if (ev.key === "Escape") {
                  ev.stopPropagation();
                  analysisPicker.val = null;
                }
              },
            },
            allNeeds.map((n) => label(
              input({
                type: "checkbox",
                checked: fieldHas(n.id),
                oninput: (ev) => {
                  justifyFields(rows, n.id, ev.target.checked, settle && ev.target.checked
                    ? { settleKey: cardKey }
                    : {});
                },
              }),
              span(n.name),
            )))
          : null,
      );
    };

    // AJ-3 settled line
    const settledLine = (cardKey, entry) =>
      div({ class: "arow-settled" },
        span("✓ Justified with "),
        span(entry.needName),
        span(" · "),
        button({
          type: "button",
          class: "linklike",
          onclick: (ev) => {
            ev.stopPropagation();
            const next = new Map(analysisSettled.val);
            next.delete(cardKey);
            analysisSettled.val = next;
            justifyFields(entry.rows, entry.needId, false);
          },
        }, "Undo"),
      );

    // Single-field card (ungrouped / split / justified member)
    const fieldCard = (row, { settle = false, justified = false } = {}) => {
      const key = row.fld.id;
      const settled = settle ? analysisSettled.val.get(key) : null;
      const hoverIds = () => row.movedBy.map((s) => s.id);
      return div({
        class: "arow",
        onmouseenter: e2e ? undefined : () => graph.highlightStreams?.(hoverIds()),
        onmouseleave: e2e ? undefined : () => graph.highlightStreams?.(null),
      },
        div({ class: "arow-head" },
          span({ class: "mono", style: "color:var(--ink-3)" }, `${row.sys.name} · ${row.ent.name} · `),
          van.tags.b(row.fld.name),
          row.fld.type ? span({ class: "cl-meta" }, row.fld.type) : null,
        ),
        viaLine(row.movedBy),
        settled
          ? settledLine(key, settled)
          : justified
            ? justifiedControls([row], key)
            : needsControls([row], key, { settle }),
      );
    };

    // AJ-5 justified chips + picker
    const justifiedControls = (rows, cardKey) => {
      if (!d.needs.length) return null;
      const needIds = rows[0].fld.biz_need_ids ?? [];
      const needObjs = needIds
        .map((id) => d.needs.find((n) => n.id === id))
        .filter(Boolean);
      const pickerOpen = analysisPicker.val === cardKey;
      const allNeeds = [...d.needs].sort((a, b) => a.name.localeCompare(b.name));
      return div({ class: "arow-needs" },
        needObjs.map((n) => span({ class: "chip arow-need-chip" },
          n.name,
          button({
            type: "button",
            class: "btn-x",
            "aria-label": "Remove justification",
            onclick: (ev) => {
              ev.stopPropagation();
              justifyFields(rows, n.id, false, { removeToast: true });
            },
          }, "✕"),
        )),
        button({
          type: "button",
          class: "btn ghost small arow-picker",
          onclick: (ev) => {
            ev.stopPropagation();
            analysisPicker.val = pickerOpen ? null : cardKey;
          },
        }, "Other need ▾"),
        pickerOpen
          ? div({
              class: "checklist arow-picker-list",
              onkeydown: (ev) => {
                if (ev.key === "Escape") {
                  ev.stopPropagation();
                  analysisPicker.val = null;
                }
              },
            },
            allNeeds.map((n) => label(
              input({
                type: "checkbox",
                checked: needIds.includes(n.id),
                oninput: (ev) => justifyFields(rows, n.id, ev.target.checked),
              }),
              span(n.name),
            )))
          : null,
      );
    };

    // AJ-2 group card (2+ fields)
    const groupCard = (g, { settle = false, justified = false } = {}) => {
      const split = analysisSplit.val.has(g.key);
      const toggleSplit = (ev) => {
        ev.stopPropagation();
        const next = new Set(analysisSplit.val);
        if (next.has(g.key)) next.delete(g.key);
        else next.add(g.key);
        analysisSplit.val = next;
      };
      if (split) {
        return [
          ...g.rows.map((row) => fieldCard(row, { settle, justified })),
          button({
            type: "button",
            class: "btn ghost arow-split",
            onclick: toggleSplit,
          }, "group fields ▴"),
        ];
      }
      const settled = settle ? analysisSettled.val.get(g.key) : null;
      const n = g.rows.length;
      const hoverIds = () => g.movedBy.map((s) => s.id);
      const fieldLine = g.rows.map((r) => {
        const t = r.fld.type ? ` ${r.fld.type}` : "";
        return `${r.fld.name}${t}`;
      }).join(" · ");

      return div({
        class: "arow arow-group",
        onmouseenter: e2e ? undefined : () => graph.highlightStreams?.(hoverIds()),
        onmouseleave: e2e ? undefined : () => graph.highlightStreams?.(null),
      },
        div({ class: "arow-head arow-head-row" },
          span(
            van.tags.b(g.ent.name),
            span({ style: "color:var(--ink-3)" }, ` · ${plural(n, "field")}`),
          ),
          span({ class: "cl-meta" }, g.sys.name),
        ),
        div({ class: "arow-fields mono" }, fieldLine),
        viaLine(g.movedBy),
        settled
          ? settledLine(g.key, settled)
          : justified
            ? justifiedControls(g.rows, g.key)
            : needsControls(g.rows, g.key, { settle }),
        // Keep split-row height when settled so the next card does not jump (AJ-3).
        settled
          ? span({ class: "arow-split arow-split-spacer", "aria-hidden": "true" }, "each field separately ▾")
          : button({
              type: "button",
              class: "btn ghost arow-split",
              onclick: toggleSplit,
            }, "each field separately ▾"),
      );
    };

    // Unjustified section cards: live groups + settled pins (AJ-3).
    const renderUnjustified = () => {
      if (!A.movedUnjustified.length && !analysisSettled.val.size) {
        return p({ class: "cl-empty" }, A.moved.length
          ? "Every field in motion serves a documented need."
          : "No field-level movement documented yet — pick entities/fields on your streams to enable this analysis.");
      }
      if (!A.movedUnjustified.length && analysisSettled.val.size) {
        // All live rows settled this session — still show settled cards + done is wrong
        // Header count is 0; cards stay via settled map.
      }

      const liveGroups = groupFindings(A.movedUnjustified);
      const liveByKey = new Map(liveGroups.map((g) => [g.key, g]));
      const liveField = new Map(A.movedUnjustified.map((r) => [r.fld.id, r]));

      // Display order: live groups in analyze order; settled keys that left the
      // live list keep their relative slot by interleaving with a key order list.
      const seenKeys = new Set();
      const cards = [];

      // Walk live groups; after each, emit any settled that were "before" next?
      // Simpler: maintain order as [...live group keys in order] union settled keys
      // not in live, appended in Map insertion order (settle order ≈ click order).
      // Plan wants original positions — use field/group key order from first paint.
      // On settle, the key was a live key; we re-walk: for each key in
      // (live keys in order + settled-only keys at their last known index).
      // Store settleIndex on settle? For e2e, DOM index stability of the *next*
      // card matters. Keeping settled card in place: walk original live list
      // from before write — we don't have that after reload. Approach:
      // merge: iterate live groups; for settled-only keys, insert by comparing
      // to field id order in analyze().moved (stable).

      const settledOnly = [];
      for (const [key, entry] of analysisSettled.val) {
        if (liveByKey.has(key) || liveField.has(key)) continue;
        // Still show if any settled field is no longer unjustified (expected)
        settledOnly.push({ key, entry });
      }

      // Build combined list: live groups first (analyze order), then settled-only
      // in Map order. To keep position: interleave settled-only by the first
      // field's position in A.moved.
      const movedIndex = new Map(A.moved.map((r, i) => [r.fld.id, i]));
      const sortIdx = (key, entry, g) => {
        if (g) return movedIndex.get(g.rows[0].fld.id) ?? 0;
        const r0 = entry?.rows?.[0];
        return r0 ? (movedIndex.get(r0.fld.id) ?? 9999) : 9999;
      };

      const items = [
        ...liveGroups.map((g) => ({ kind: "live", g, key: g.key, idx: sortIdx(g.key, null, g) })),
        ...settledOnly.map(({ key, entry }) => ({
          kind: "settled", key, entry, idx: sortIdx(key, entry, null),
        })),
      ].sort((a, b) => a.idx - b.idx || a.key.localeCompare(b.key));

      for (const it of items) {
        if (seenKeys.has(it.key)) continue;
        seenKeys.add(it.key);
        if (it.kind === "settled") {
          const entry = it.entry;
          const rows = entry.rows;
          if (rows.length >= 2) {
            cards.push(groupCard({
              key: it.key,
              rows,
              sys: rows[0].sys,
              ent: rows[0].ent,
              movedBy: rows[0].movedBy,
            }, { settle: true }));
          } else {
            cards.push(fieldCard(rows[0], { settle: true }));
          }
          continue;
        }
        const g = it.g;
        // If this group key is settled (justify then still "live" shouldn't happen)
        if (analysisSettled.val.has(g.key)) {
          cards.push(groupCard(g, { settle: true }));
        } else if (g.rows.length === 1) {
          const row = g.rows[0];
          if (analysisSettled.val.has(row.fld.id)) cards.push(fieldCard(row, { settle: true }));
          else cards.push(fieldCard(row, { settle: true }));
        } else {
          cards.push(groupCard(g, { settle: true }));
        }
      }

      const zeroNeedsBanner = !d.needs.length
        ? [
            p({ class: "cl-empty" }, "Define business needs to justify fields."),
            button({
              type: "button",
              class: "btn ghost small",
              onclick: () => {
                tab.val = "needs";
                editing.val = { kind: "needs" };
              },
            }, "+ Add business need"),
          ]
        : null;

      return [
        p({ class: "cl-empty" }, "These fields move between systems, but no business need justifies them — candidates to cut or to document."),
        zeroNeedsBanner,
        cards,
      ];
    };

    const renderJustified = () => {
      const groups = groupJustifiedFindings(A.movedJustified);
      return groups.map((g) => {
        if (g.rows.length === 1) return fieldCard(g.rows[0], { justified: true });
        return groupCard(g, { justified: true });
      });
    };

    return [
      div({ class: "analysis-section" },
        h5("Documentation coverage"),
        stat("Systems with a catalog", `${A.systemsWithCatalog} / ${d.systems.length}`),
        stat("Fields typed", `${A.typedFields} / ${A.totalFields}`),
        stat("Fields justified by a need", `${A.justifiedFields} / ${A.totalFields}`),
        stat("Streams with a business need", `${A.streamsWithNeeds} / ${d.streams.length}`),
        A.totalClusters
          ? stat("Clusters with a business need", `${A.clustersWithNeeds} / ${A.totalClusters}`)
          : null,
        p({ class: "cl-empty", style: "margin-top:6px" },
          "Conclusions below only cover what's documented — absent facts are gaps, not truths."),
      ),
      div({ class: "analysis-section" },
        h5(`Unjustified data in motion (${A.movedUnjustified.length})`),
        // When everything is settled this session, still show cards; when truly
        // empty with no settled, show done/empty copy.
        (A.movedUnjustified.length || analysisSettled.val.size)
          ? renderUnjustified()
          : p({ class: "cl-empty" }, A.moved.length
              ? "Every field in motion serves a documented need."
              : "No field-level movement documented yet — pick entities/fields on your streams to enable this analysis."),
      ),
      A.movedJustified.length
        ? van.tags.details({ class: "analysis-section" },
            van.tags.summary(`Justified data in motion (${A.movedJustified.length})`),
            renderJustified())
        : null,
    ];
  };

  const inspector = () => {
    const sel = selection.val;
    const d = data.val;
    // A binding function must never return null — VanJS would drop the
    // binding for good. Render an invisible placeholder instead.
    const hidden = () => span({ style: "display:none" });
    if (!sel || !d) return hidden();
    const V = filteredView();

    let title, sub, body;
    if (sel.type === "group") {
      // Member list, Make/Add cluster, Pin/Unpin, Set type, Delete….
      // ✕ removes from the selection, not data.
      const members = sel.ids
        .map((id) => d.systems.find((s) => s.id === id))
        .filter(Boolean);
      if (members.length < 2) return hidden();
      const memberIds = members.map((s) => s.id);
      const existingClusters = d.clusters ?? [];
      const removeFromGroup = (id) => {
        const ids = sel.ids.filter((x) => x !== id);
        if (ids.length >= 2) selection.val = { type: "group", ids };
        else if (ids.length === 1) selection.val = { type: "node", id: ids[0] };
        else selection.val = null;
      };
      title = `${plural(members.length, "system")} selected`;
      sub = "";
      body = [
        div({ class: "group-member-list" },
          members.map((s) =>
            div({ class: "entity-item" },
              div({ class: "ei-head" },
                span({ class: `type-dot ${s.type || "unknown"}` }),
                span({ class: "ei-name" }, s.name),
                div({ class: "ei-actions" },
                  button({
                    class: "btn ghost small",
                    title: "Remove from selection",
                    onclick: () => removeFromGroup(s.id),
                  }, "✕"),
                ),
              ),
            ))),
        // Make cluster / Add to cluster — first action row (§5.1)
        div({ class: "group-actions", style: "display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px" },
          () => groupUI.val === "make_cluster"
            ? span({ style: "display:none" })
            : button({
                class: "btn small",
                onclick: () => {
                  makeClusterDraft = nextClusterDefaultName();
                  groupUI.val = "make_cluster";
                  pendingDel.val = null;
                },
              }, "Make cluster"),
          existingClusters.length
            ? button({
                class: "btn small",
                onclick: () => {
                  groupUI.val = groupUI.val === "add_to_cluster" ? null : "add_to_cluster";
                  pendingDel.val = null;
                },
              }, "Add to cluster")
            : null,
        ),
        // Inline make-cluster name input (Enter = Create, Esc = cancel locally)
        () => {
          if (groupUI.val !== "make_cluster") return span({ style: "display:none" });
          const nameInput = input({
            type: "text",
            class: "group-cluster-name",
            placeholder: "Cluster name",
            value: makeClusterDraft,
            autofocus: true,
            oninput: (e) => { makeClusterDraft = e.target.value; },
            onkeydown: (e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                groupUI.val = null;
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                makeClusterFromGroup(makeClusterDraft || nameInput.value);
              }
            },
          });
          // Autofocus after mount (Van may not honor the attribute on re-render).
          queueMicrotask(() => nameInput.focus?.());
          return div({ class: "group-make-cluster", style: "display:flex;gap:8px;margin-bottom:8px;align-items:center" },
            nameInput,
            button({
              class: "btn small",
              onclick: () => makeClusterFromGroup(makeClusterDraft || nameInput.value),
            }, "Create"),
          );
        },
        // Inline list of existing clusters for "Add to cluster"
        () => groupUI.val === "add_to_cluster"
          ? div({ class: "group-add-cluster", style: "display:flex;flex-direction:column;gap:6px;margin-bottom:8px" },
              existingClusters.map((c) =>
                button({
                  class: "btn ghost small",
                  style: "justify-content:flex-start;gap:8px",
                  onclick: () => addGroupToCluster(c),
                },
                  span({ class: "cluster-dot", style: `background:${graph.clusterColorHex?.(c.color) ?? "#3fae94"}` }),
                  span(c.name))))
          : span({ style: "display:none" }),
        div({ class: "group-actions", style: "display:flex;flex-wrap:wrap;gap:8px" },
          button({
            class: "btn ghost small",
            onclick: () => graph.pinNodes(sel.ids),
          }, "Pin all"),
          button({
            class: "btn ghost small",
            onclick: () => graph.unpinNodes(sel.ids),
          }, "Unpin all"),
          button({
            class: "btn ghost small",
            onclick: () => { groupUI.val = groupUI.val === "set_type" ? null : "set_type"; pendingDel.val = null; },
          }, "Set type"),
        ),
        // Inline type options (not a custom dropdown) — §5.1
        () => groupUI.val === "set_type"
          ? div({ class: "group-type-options", style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px" },
              ["internal", "external", "unknown"].map((t) =>
                button({ class: "btn ghost small", onclick: () => batchSetType(t) }, t)))
          : span({ style: "display:none" }),
        // Delete… last, alone on its row — never next to Make cluster / Pin.
        div({ style: "margin-top:12px" },
          () => pendingDel.val === "group"
            ? div({ class: "warn-note" },
                groupDeleteConfirmMsg(memberIds),
                div({ class: "confirm-actions" },
                  button({ class: "btn small danger", onclick: () => batchDeleteGroup() }, "Delete"),
                  button({ class: "btn ghost small", onclick: () => (pendingDel.val = null) }, "Cancel"),
                ))
            : button({
                class: "btn ghost small danger",
                onclick: () => { pendingDel.val = "group"; groupUI.val = null; },
              }, "Delete…"),
        ),
      ];
    } else if (sel.type === "cluster") {
      // Cluster inspector — plan §5.2
      const cl = (d.clusters ?? []).find((c) => c.id === sel.id);
      if (!cl) return hidden();
      const members = (cl.system_ids ?? [])
        .map((id) => d.systems.find((s) => s.id === id))
        .filter(Boolean);
      const nSys = members.length;
      const nNeeds = (cl.biz_need_ids ?? []).length;
      const hex = graph.clusterColorHex?.(cl.color) ?? "#3fae94";
      const colorKeys = graph.clusterColorKeys?.() ?? [];
      // Other clusters each member also belongs to (overlap note).
      const alsoIn = (sysId) => (d.clusters ?? [])
        .filter((c) => c.id !== cl.id && (c.system_ids ?? []).includes(sysId))
        .map((c) => c.name);
      const nonMembers = d.systems.filter((s) => !(cl.system_ids ?? []).includes(s.id));

      title = cl.name;
      sub = nNeeds > 0
        ? `${plural(nSys, "system")} · ${plural(nNeeds, "need")}`
        : plural(nSys, "system");
      body = [
        // Color dot + inline-editable name/description
        div({ class: "cluster-insp-head", style: "display:flex;align-items:center;gap:8px;margin-bottom:8px" },
          span({ class: "cluster-dot cluster-dot-lg", style: `background:${hex}` }),
          input({
            type: "text",
            class: "cluster-name-input",
            value: cl.name,
            style: "flex:1;font-weight:600",
            onkeydown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const v = e.target.value.trim();
                if (v && v !== cl.name) saveCluster(cl, { name: v });
              }
            },
            onblur: (e) => {
              const v = e.target.value.trim();
              if (v && v !== cl.name) saveCluster(cl, { name: v });
              else if (!v) e.target.value = cl.name;
            },
          }),
        ),
        input({
          type: "text",
          class: "cluster-desc-input",
          placeholder: "Description (optional)",
          value: cl.description || "",
          style: "width:100%;margin-bottom:10px",
          onkeydown: (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const v = e.target.value;
              if (v !== (cl.description || "")) saveCluster(cl, { description: v });
            }
          },
          onblur: (e) => {
            const v = e.target.value;
            if (v !== (cl.description || "")) saveCluster(cl, { description: v });
          },
        }),
        // 8 color swatches — selected ringed with #f2f4f7
        div({ class: "cluster-swatches", style: "margin-bottom:12px" },
          colorKeys.map((k) =>
            button({
              type: "button",
              class: "cluster-swatch" + ((cl.color || "verdigris") === k ? " selected" : ""),
              style: `background:${graph.clusterColorHex?.(k) ?? k}`,
              title: k,
              "aria-label": k,
              onclick: () => {
                if (cl.color !== k) saveCluster(cl, { color: k });
              },
            }))),
        // Needs chip editor (same checklist pattern as stream/flow forms)
        div({ style: "margin-bottom:12px" },
          h5({ class: "insp-h" }, "Needs"),
          div({ class: "cluster-needs", style: "display:flex;flex-wrap:wrap;gap:4px;align-items:center" },
            needNames(cl.biz_need_ids).map((n) => span({ class: "chip" }, n)),
            button({
              class: "btn ghost small",
              onclick: () => {
                clusterUI.val = clusterUI.val === "needs" ? null : "needs";
              },
            }, "+"),
          ),
          () => clusterUI.val === "needs"
            ? div({ class: "checklist", style: "margin-top:8px" },
                (d.needs ?? []).map((n) => label(
                  input({
                    type: "checkbox",
                    checked: (cl.biz_need_ids ?? []).includes(n.id),
                    oninput: (ev) => {
                      const set = new Set(cl.biz_need_ids ?? []);
                      ev.target.checked ? set.add(n.id) : set.delete(n.id);
                      saveCluster(cl, { biz_need_ids: [...set] });
                    },
                  }),
                  span(n.name))))
            : span({ style: "display:none" }),
        ),
        // Systems list
        h5({ class: "insp-h" }, "Systems"),
        div({ class: "group-member-list" },
          members.map((s) => {
            const extra = alsoIn(s.id);
            return div({ class: "entity-item" },
              div({ class: "ei-head" },
                span({ class: `type-dot ${s.type || "unknown"}` }),
                span({ class: "ei-name" }, s.name,
                  extra.length
                    ? span({ class: "ei-sub", style: "margin-left:6px" },
                        extra.map((nm) => `also in ${nm}`).join(", "))
                    : null),
                div({ class: "ei-actions" },
                  button({
                    class: "btn ghost small",
                    title: "Remove from cluster",
                    onclick: () => {
                      const next = (cl.system_ids ?? []).filter((id) => id !== s.id);
                      saveCluster(cl, { system_ids: next });
                    },
                  }, "✕"),
                ),
              ),
            );
          }),
          // + Add systems — inline checklist of non-members
          button({
            class: "btn ghost small",
            style: "margin-top:4px",
            onclick: () => {
              clusterUI.val = clusterUI.val === "add_systems" ? null : "add_systems";
            },
          }, "+ Add systems"),
          () => clusterUI.val === "add_systems"
            ? div({ class: "checklist", style: "margin-top:8px" },
                nonMembers.length
                  ? nonMembers.map((s) => label(
                      input({
                        type: "checkbox",
                        checked: false,
                        oninput: (ev) => {
                          if (!ev.target.checked) return;
                          const next = [...new Set([...(cl.system_ids ?? []), s.id])];
                          saveCluster(cl, { system_ids: next });
                        },
                      }),
                      span(s.name)))
                  : div({ class: "cl-empty" }, "Every system is already in this cluster."))
            : span({ style: "display:none" }),
        ),
        // Focus — one-shot fit to members (not a pressed toggle)
        div({ style: "margin-top:12px;display:flex;flex-direction:column;gap:8px" },
          button({
            class: "btn ghost small",
            onclick: () => graph.fitToCluster?.(cl.id),
          }, "Focus"),
          () => pendingDel.val === `clusters:${cl.id}`
            ? div({ class: "warn-note" },
                clusterDeleteConfirmMsg(cl.name, nSys),
                div({ class: "confirm-actions" },
                  button({
                    class: "btn small danger",
                    onclick: () => remove("clusters", cl),
                  }, "Delete"),
                  button({ class: "btn ghost small", onclick: () => (pendingDel.val = null) }, "Cancel"),
                ))
            : button({
                class: "btn ghost small danger",
                onclick: () => { pendingDel.val = `clusters:${cl.id}`; clusterUI.val = null; },
              }, "Delete cluster"),
        ),
      ];
    } else if (sel.type === "analysis") {
      title = "Analysis";
      sub = "justification & coverage";
      body = analysisBody(d);
    } else if (sel.type === "flow") {
      const fl = d.flows.find((f) => f.id === sel.id);
      if (!fl) return hidden();
      const shape = flowShape(fl, d);
      const implied = flowImpliedNeeds(fl, d);
      const direct = new Set(fl.biz_need_ids ?? []);
      const undeclared = [...direct].filter((id) => !implied.has(id));
      const needName = (id) => d.needs.find((n) => n.id === id)?.name;

      const hopRow = (st) =>
        div({
          class: "hop-row",
          "data-txt": `${st.name} ${sysName(st.source.system_id)} ${sysName(st.destination.system_id)} ${st.status}`.toLowerCase(),
        },
          div({ class: "hop-head" },
            span({ class: "ei-name" }, st.name),
            span({ class: `chip ${st.status}` }, st.status),
          ),
          div({ class: "ei-sub" }, `${sysName(st.source.system_id)} ${st.direction === "bi" ? "⇄" : "→"} ${sysName(st.destination.system_id)}`),
        );

      // imperative hop filter: no reactive re-render, so typing keeps focus
      const hopFilter = input({
        type: "search", placeholder: "Filter hops (name, system, status)…",
        style: "margin-bottom:10px",
        oninput: (e) => {
          const hq = e.target.value.trim().toLowerCase();
          const body = hopFilter.closest(".inspector-body");
          for (const grp of body.querySelectorAll(".stage-group")) {
            let visible = 0;
            for (const row of grp.querySelectorAll(".hop-row")) {
              const show = !hq || row.dataset.txt.includes(hq);
              row.style.display = show ? "" : "none";
              if (show) visible++;
            }
            grp.style.display = visible ? "" : "none";
          }
        },
      });

      title = fl.name;
      sub = `${plural(shape.streams.length, "hop")} · ${plural(shape.stages.length, "stage")}`;
      body = [
        fl.description ? p({ style: "color:var(--ink-2);margin-bottom:10px" }, fl.description) : null,
        div({ style: "display:flex;gap:8px;margin-bottom:12px" },
          // DR-13: pressed outline toggle (not primary fill); hover → Unfocus.
          // Both labels always mounted so Van bindings stay stable; CSS swaps.
          button({
            type: "button",
            class: () => "btn small focus-toggle" + (filters.flow.val === fl.id ? " is-pressed" : " ghost"),
            "aria-pressed": () => (filters.flow.val === fl.id ? "true" : "false"),
            title: () => (filters.flow.val === fl.id ? "Unfocus on the map" : "Focus this flow on the map"),
            onclick: () => {
              filters.flow.val = filters.flow.val === fl.id ? "" : fl.id;
              if (filters.flow.val) showFilterHud.val = true;
            },
          },
            span({ class: "focus-label-on" }, () => (filters.flow.val === fl.id ? "Focused on map ✓" : "Focus on map")),
            span({ class: "focus-label-off" }, "Unfocus")),
          button({ class: "btn ghost small", onclick: () => { tab.val = "flows"; editing.val = { kind: "flows", item: fl }; } }, "Edit flow"),
        ),
        shape.components > 1
          ? div({ class: "warn-note" },
              `This flow is in ${shape.components} disconnected pieces — a hop between them may be missing or undocumented.`)
          : null,
        (fl.steps ?? []).length > shape.streams.length
          ? div({ class: "warn-note" }, "Some referenced streams no longer exist.")
          : null,
        shape.orderWarnings.length
          ? div({ class: "warn-note" },
              "Stage order contradicts the wiring for: " +
              shape.orderWarnings.map((st) => st.name).join(", ") +
              " — no earlier hop reaches their source system. A hop may be missing, or the numbers need adjusting.")
          : null,
        div({ style: "margin-bottom:12px" },
          h5({ class: "insp-h" }, "Business needs"),
          [...direct].map((id) => needName(id) ? span({ class: "chip" }, needName(id)) : null),
          [...implied].filter((id) => !direct.has(id)).map((id) =>
            needName(id) ? span({ class: "chip ghost", title: "Implied by this flow's streams" }, needName(id)) : null),
          !direct.size && !implied.size ? div({ class: "cl-empty" }, "No needs declared or implied yet.") : null,
          undeclared.length
            ? div({ class: "warn-note", style: "margin-top:6px" },
                `Declared need${undeclared.length === 1 ? "" : "s"} ${undeclared.map(needName).filter(Boolean).join(", ")} ` +
                "is not carried by any hop — documentation mismatch worth checking.")
            : null,
        ),
        shape.streams.length > 4 ? hopFilter : null,
        shape.stages.map((sg) =>
          div({ class: "stage-group", style: "margin-bottom:10px" },
            h5({ class: "insp-h" }, `Stage ${sg.n}`),
            sg.streams.map(hopRow))),
      ];
    } else if (sel.type === "edge") {
      const streams = V.streamsBetween(sel.a, sel.b);
      const { matched, rest } = V.partition(streams);
      const labels = V.scopeLabels();
      title = sel.a === sel.b ? "Internal flow" : "Connection";
      sub = V.active
        ? `${matched.length} matching · ${streams.length} total`
        : `${streams.length} stream${streams.length === 1 ? "" : "s"}`;
      body = [
        div({ class: "flow-line" }, span(sysName(sel.a)), span({ class: "arrow" }, "~~~"), sel.a === sel.b ? null : span(sysName(sel.b))),
        V.active && matched.length ? h5({ class: "insp-h" }, labels.matched) : null,
        matched.map((st) => streamCard(st, V, V.stageOf(st.id))),
        rest.length
          ? van.tags.details({ class: "others-fold", open: matched.length ? null : true },
              van.tags.summary(labels.rest(rest.length)),
              rest.map((st) => streamCard(st, V)))
          : null,
      ];
    } else if (sel.type === "node") {
      const sys = d.systems.find((s) => s.id === sel.id);
      if (!sys) return hidden();
      const streams = V.streamsOf(sys.id);
      const { matched, rest } = V.partition(streams);
      const labels = V.scopeLabels();
      const ents = sys.entities ?? [];
      const flds = ents.reduce((n, e) => n + (e.fields ?? []).length, 0);
      const typed = ents.reduce((n, e) => n + (e.fields ?? []).filter((x) => x.type).length, 0);
      title = sys.name;
      sub = sys.type;
      body = [
        sys.description ? p({ style: "color:var(--ink-2);margin-bottom:10px" }, sys.description) : null,
        ents.length
          ? div({ style: "margin-bottom:12px" },
              div({ class: "coverage", style: "margin-bottom:4px" },
                van.tags.b(`${ents.length}`), ` ${ents.length === 1 ? "entity" : "entities"} · `,
                van.tags.b(`${typed}/${flds}`), " fields typed"),
              ents.map((e) => div({ class: "ei-sub" }, `${e.name} (${plural((e.fields ?? []).length, "field")})`, " ", provChip(e))))
          : null,
        h5({ style: "font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px" },
          V.active
            ? `${matched.length} of ${streams.length} connected streams match the filter`
            : `${streams.length} connected stream${streams.length === 1 ? "" : "s"}`),
        matched.map((st) => streamCard(st, V, V.stageOf(st.id))),
        rest.length
          ? van.tags.details({ class: "others-fold", open: matched.length ? null : true },
              van.tags.summary(labels.rest(rest.length)),
              rest.map((st) => streamCard(st, V)))
          : null,
      ];
    } else {
      // Unknown selection type (e.g. future "cluster") — keep the binding alive.
      return hidden();
    }

    return div({
      class: "inspector",
      style: () => `width:${inspWidth.val}px;flex:none`,
    },
      div({ class: "inspector-head" },
        h3(title), span({ class: "sub" }, sub),
        (sel.type === "node" || sel.type === "edge" || sel.type === "group" || sel.type === "cluster")
          ? button({
              class: "btn ghost small", title: "Center this on the map (press 0 twice)",
              "aria-label": "Center on map", onclick: () => graph.focusSelection(),
            }, iconSVG(IC.target))
          : null,
        button({ class: "btn ghost small", onclick: () => (selection.val = null) }, "✕"),
      ),
      div({ class: "inspector-body" }, body),
    );
  };

  // right resize handle — its own binding so it lives as a separate flex
  // child of .body-split (between canvas and inspector). It appears only
  // when the inspector is open and disappears exactly when it closes,
  // preserving the existing open/close/Esc behavior unchanged.
  const inspectorHandle = () => {
    const sel = selection.val;
    const d = data.val;
    if (!sel || !d) return span({ style: "display:none" });
    return makeResizer(inspWidth, "resizer--insp", "sm.inspW");
  };

  // ---- topbar ----
  let qTimer = null;
  const searchBox = input({
    type: "search", class: "search", placeholder: "Search…",
    value: () => filters.q.val,
    oninput: (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => (filters.q.val = e.target.value), 200);
    },
  });
  const scopeSelect = Dropdown({
    state: filters.scope, title: "Scope",
    options: [["all", "in: everything"], ["systems", "in: systems"], ["streams", "in: streams"],
              ["entities", "in: entities"], ["fields", "in: fields"]],
  });

  const filterSelect = (state, labelTxt, opts) =>
    Dropdown({
      state, title: labelTxt,
      options: () => [["", `${labelTxt}: all`], ...opts()],
    });

  // Multi-select facet: bound to a Set-valued state. Empty set reads "all",
  // a non-empty set turns the chip amber. `searchable` adds a row filter for
  // long lists (systems, possibly needs).
  const multiFilterSelect = (state, labelTxt, opts, searchable = false) =>
    MultiDropdown({ state, title: labelTxt, options: opts, searchable });

  // ---- canvas toolbar ----
  // ---- anchored popovers (Project & History) ----
  // Both former left drawers are now `dd-panel` popovers anchored to their
  // triggers (topbar `proj-name` and the toolbar History button), opening
  // downward over the canvas. They reuse the export/filter popover machinery
  // (`placePanel` + outside-click + Esc) and are mutually exclusive. A
  // shared helper syncs listener registration to the open state via
  // `van.derive` so any close path (Esc, outside click, the other trigger)
  // cleans up correctly.
  // `wirePopover` wires the open/close lifecycle (outside-click, reposition
// on resize/open) for a popover whose panel is a direct workspace function
// child (re-rendered each time it opens) and whose trigger is a stable
// button elsewhere (topbar/toolbar). It looks the panel + anchor up by id
// at event time, so it works even though the panel node is recreated on
// each open. `van.derive` re-runs reliably (unlike a function child nested in
// an IIFE-created node), so any close path cleans up correctly.
  const wirePopover = ({ state, panelId, anchorId, maxHeight = 240 }) => {
    const onOutside = (e) => {
      if (!state.val) return;
      const p = document.getElementById(panelId);
      const a = document.getElementById(anchorId);
      if (p && !p.contains(e.target) && !(a && a.contains(e.target))) state.val = false;
    };
    const reposition = () => {
      if (!state.val) return;
      const p = document.getElementById(panelId);
      const a = document.getElementById(anchorId);
      if (p && a) placePanel(p, a, maxHeight);
    };
    van.derive(() => {
      if (state.val) {
        document.addEventListener("mousedown", onOutside, true);
        window.addEventListener("resize", reposition);
        requestAnimationFrame(() => requestAnimationFrame(() => { if (state.val) reposition(); }));
      } else {
        document.removeEventListener("mousedown", onOutside, true);
        window.removeEventListener("resize", reposition);
      }
    });
  };

  // Inline-SVG glyph helper + the canvas-toolbar icon table. Defined here
  // (before the History popover trigger, which also uses them) so the whole
  // toolbar + popovers share one set of high-contrast single-glyph icons.
  const iconSVG = (markup) => {
    const d = document.createElement("div");
    d.innerHTML = markup.trim();
    return d.firstChild;
  };
  const IC = {
    lensGraph: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="3.5" cy="4" r="1.6"/><circle cx="12.5" cy="4.5" r="1.6"/><circle cx="8" cy="12" r="1.6"/><path d="M4.7 4.6 L11.3 4.5 M4.2 5.4 L7.4 11 M11.8 5.4 L8.6 11"/></svg>',
    lensMatrix: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>',
    unDim: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.4" opacity="0.45"/><circle cx="8" cy="8" r="6.2" opacity="0.3"/></svg>',
    unHide: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.4"/><path d="M3.2 3.2 L12.8 12.8"/></svg>',
    edgesBundle: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/><line x1="4.5" y1="8" x2="11.5" y2="8" stroke-width="3"/></svg>',
    edgesExpand: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/><path d="M4.5,8 C7,4 9,4 11.5,8"/><line x1="4.5" y1="8" x2="11.5" y2="8"/><path d="M4.5,8 C7,12 9,12 11.5,8"/></svg>',
    labelsShow: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4.5" width="11" height="7" rx="1.5"/><path d="M5.5,9.5 V6.5 h2 M5.5,8 H7 M9.5,9.5 V6.5 h1.5 M9.5,8.5 h1.5 v1.5 h-1.5 Z"/></svg>',
    labelsHide: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4.5" width="11" height="7" rx="1.5" opacity="0.5"/><path d="M5.5,9.5 V6.5 h2 M5.5,8 H7 M9.5,9.5 V6.5 h1.5 M9.5,8.5 h1.5 v1.5 h-1.5 Z" opacity="0.5"/><line x1="1.5" y1="14.5" x2="14.5" y2="1.5" stroke="currentColor" stroke-width="1.5"/></svg>',
    undo: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4 L3 6.5 L5.5 9"/><path d="M3 6.5 H9.5 A4 4 0 0 1 13.5 10.5 V11.5"/></svg>',
    redo: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4 L13 6.5 L10.5 9"/><path d="M13 6.5 H6.5 A4 4 0 0 0 2.5 10.5 V11.5"/></svg>',
    history: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5 V8.5 L10.2 10"/><path d="M3 4 L4.6 2.6 M13 4 L11.4 2.6"/></svg>',
    funnel: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3 h12 l-5 5.5 v4.5 l-2 1 v-5.5 z"/></svg>',
    search: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 L13.8 13.8"/></svg>',
    fit: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5.5 V2.5 H5.5 M10.5 2.5 H13.5 V5.5 M13.5 10.5 V13.5 H10.5 M5.5 13.5 H2.5 V10.5"/><circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/></svg>',
    target: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="4"/><path d="M8 1.5 V4 M8 12 V14.5 M1.5 8 H4 M12 8 H14.5"/></svg>',
  };

  // History popover body. Two views: the timeline list (with thumbnails,
  // lazy + capped) and the P2 inline detail (larger mini-SVG + metadata +
  // Restore/Back). The workspace is never covered (no lightbox).
  const historyListBody = () => {
    const h = historyState.val;
    const now = Date.now();
    const entries = h.entries ?? [];
    const future = entries.filter((e) => e.future);
    const current = entries.filter((e) => e.current);
    const past = entries.filter((e) => !e.future && !e.current);
    const cap = historyCap.val;
    const shownPast = past.slice(0, cap);
    const ordered = [...future, ...current, ...shownPast];

    // (Re)create the lazy thumbnail observer scoped to this list render.
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = new IntersectionObserver((rs) => {
      for (const r of rs) if (r.isIntersecting) {
        const el = r.target; const sha = el.getAttribute("data-sha");
        if (sha) ensureThumb(sha, el);
        thumbObserver.unobserve(el);
      }
    }, { root: null, rootMargin: "120px" });

    const row = (e) => {
      const cls = "h-row" + (e.current ? " current" : "") + (e.future ? " future" : "");
      const thumb = div({ class: "h-thumb", "data-sha": e.sha });
      // The current row is the live graph — render its thumbnail immediately
      // (no fetch, no rAF) so it's always present. Other rows lazy-load via
      // the IntersectionObserver when they scroll into view.
      if (e.current && data.val) {
        thumb.appendChild(miniGraphSVG(graphToMini(data.val), { w: 240, h: 96 }).cloneNode(true));
      } else if (thumbObserver) {
        requestAnimationFrame(() => thumbObserver.observe(thumb));
      }
      // DR-12: demote SHA to title (debug-reachable); row reads verb · author · time.
      const shaTip = e.sha || e.short || "";
      return div({
        class: cls,
        title: e.current
          ? (shaTip ? `Current version · ${shaTip}` : "Current version")
          : (shaTip ? `Click to open · ${shaTip}` : "Click to open this version"),
        onclick: () => { if (!e.current) openHistoryDetail(e); },
      },
        thumb,
        div({ class: "h-body" },
          div({ class: "h-msg" }, e.message || "(no message)"),
          div({ class: "h-sub" },
            e.author ? span({ class: "h-author" }, e.author) : null,
            span({ class: "h-when" }, relativeTime(e.when, now)),
          ),
          e.current ? span({ class: "h-now" }, "Now") : null,
        ),
      );
    };

    return div({ class: "history-list" },
      ordered.length ? ordered.map(row) : div({ class: "h-empty" }, "No history yet."),
      past.length > shownPast.length
        ? button({ class: "btn ghost small h-more", onclick: () => (historyCap.val = cap + 10) }, "Show older (", String(past.length - shownPast.length), " more)")
        : null,
    );
  };

  const historyDetailBody = () => {
    const d = historyDetail.val;
    if (!d) return span({ style: "display:none" });
    const e = d.entry;
    const names = d.graph ? new Map((d.graph.systems ?? []).map((s) => [s.id, s.name])) : null;
    return div({ class: "history-detail" },
      div({ class: "pp-head" },
        button({ class: "btn ghost small", title: "Back to the version list", onclick: backToHistoryList }, "\u2190"),
        h3("Version"),
        button({ class: "btn ghost small", title: "Close", onclick: () => { historyDetail.val = null; showHistory.val = false; } }, "\u2715"),
      ),
      div({ class: "inspector-body" },
        div({ class: "hd-graph" },
          () => d.graph
            ? miniGraphSVG(graphToMini(d.graph), { w: 360, h: 220, labels: true, names })
            : div({ class: "cl-empty" }, "Loading version\u2026"),
        ),
        div({ class: "hd-meta", title: e.sha || e.short || undefined },
          div({ class: "hd-msg" }, e.message || "(no message)"),
          div({ class: "h-sub" },
            e.author ? span({ class: "h-author" }, e.author) : null,
            e.when ? span({ class: "h-when" }, relativeTime(e.when, Date.now())) : null,
          ),
        ),
      ),
      div({ class: "hd-actions" },
        button({ class: "btn primary", title: "Jump the live map to this version", onclick: () => restoreVersion(e) }, () => viewMode.val === "main" ? "Restore to my workspace" : "Restore this version"),
        button({ class: "btn ghost", title: "Back to the version list", onclick: backToHistoryList }, "\u2190 Back"),
      ),
    );
  };

  const historyPanelBody = () =>
    div({ class: "history-panel" },
      div({ class: "pp-head" },
        h3(() => `History (${viewMode.val === "main" ? "Main" : "My workspace"})`),
        button({ class: "btn ghost small", title: "Close", onclick: () => (showHistory.val = false) }, "\u2715"),
      ),
      div({ class: "inspector-body" },
        () => historyDetail.val ? historyDetailBody() : div(null,
          h5("Version timeline"),
          // DR-12: two lines max — concept (versions), not mechanism (commits).
          p({ class: "cl-empty", style: "margin-top:4px" },
            "Every change is saved automatically. Click a version to preview it, then Restore — or use Ctrl+Z / Ctrl+Shift+Z."),
          historyListBody(),
        ),
      ),
    );

  const historyMenu = (() => {
    const btn = button({
      type: "button",
      id: "history-trigger",
      class: () => "ctool-btn" + (showHistory.val ? " active" : ""),
      title: "Browse version history and restore a past version",
      "aria-label": "History",
      "aria-haspopup": "true",
      "aria-expanded": () => showHistory.val ? "true" : "false",
      onclick: () => { showHistory.val = !showHistory.val; if (showHistory.val) showProject.val = false; },
    }, iconSVG(IC.history));
    wirePopover({ state: showHistory, panelId: "history-popover", anchorId: "history-trigger", maxHeight: 640 });
    return div({ class: "dd history-dd", "data-dd": "History" }, btn);
  })();

  // History popover: a DIRECT workspace function child so it re-renders
  // (list vs detail, fresh thumbnails) each time it opens or historyState/
  // historyDetail change. position:fixed + placePanel anchor it to the
  // toolbar trigger without covering the workspace.
  const historyPopover = () => {
    if (!showHistory.val) return span({ style: "display:none" });
    return div({
      id: "history-popover",
      class: "dd-panel history-panel-pop open",
      role: "dialog",
      "aria-label": "Version history",
    }, historyPanelBody());
  };
  van.derive(() => {
    const _o = showHistory.val, _d = historyDetail.val, _h = historyState.val, _c = historyCap.val;
    if (_o) requestAnimationFrame(() => requestAnimationFrame(() => { const p = document.getElementById("history-popover"), a = document.getElementById("history-trigger"); if (p && a) placePanel(p, a, 640); }));
  });

  // A slim row above the canvas holding the live view controls: lens
  // (Graph/Matrix), how unmatched items are treated (Dim/Hide), and edge
  // rendering (Bundle/Expand). These are switch-while-working controls, so
  // they stay one click away here rather than buried in the project drawer.
  // The drawer keeps the *persisted* Bundle/Expand + spacing defaults; this
  // row binds to the same state, so toggling here updates the project too.
  //
  // The toolbar is fully iconified (§3 of the version-history rework): each
  // group is a 2-button segmented toggle, both options visible, the active
  // one highlighted — the property that makes the toolbar scannable. Every
  // button carries a `title` (hover tooltip with group + state) and
  // `aria-label` (screen readers) because the text group label is gone.
  // (`iconSVG` + the `IC` glyph table are defined above, next to makePopover,
  // so the History popover trigger — built earlier — can use them too.)

  // A 2-button segmented icon toggle. `opts` = [[iconMarkup, active(), onClick(),
  // a11yLabel]]. The group tooltip is shared; each button's title carries the
  // group + its own state (e.g. "Unmatched: Dim — click for Hide").
  const ctoolGroup = (groupLabel, groupTitle, opts) =>
    div({ class: "ctool", title: groupTitle, role: "group", "aria-label": groupLabel },
      span({ class: "ctool-label", "aria-hidden": "true" }, groupLabel),
      div({ class: "mode-toggle" },
        opts.map(([icon, active, onClick, a11y]) =>
          button({
            type: "button",
            class: () => "ctool-btn" + (active() ? " active" : ""),
            title: `${groupLabel}: ${a11y}`,
            "aria-label": `${groupLabel}: ${a11y}`,
            "aria-pressed": () => active() ? "true" : "false",
            onclick: onClick,
          }, iconSVG(icon))),
      ),
    );

  // DR-9: graph-only toolbar groups stay visible in Matrix but go inert
  // (dimmed + no pointer events) so layout doesn't jump.
  const ctoolGraphOnly = (node) =>
    div({
      class: () => "ctool-graph-only" + (view.val === "matrix" ? " is-inert" : ""),
      "aria-disabled": () => (view.val === "matrix" ? "true" : "false"),
      title: () => (view.val === "matrix" ? "Applies to the Graph lens" : undefined),
    }, node);

  const canvasToolbar = () =>
    div({ class: "canvas-toolbar" },
      // View (Mine · Main) lives in the topbar next to the project name (DR-3) —
      // not here among display toggles. Lens / Unmatched / Edges / Labels stay.
      ctoolGroup("Lens", "Lens: force-directed map or system×system matrix", [
        [IC.lensGraph,  () => view.val === "graph",  () => (view.val = "graph"),  "Graph — click for Matrix"],
        [IC.lensMatrix, () => view.val === "matrix", () => (view.val = "matrix"), "Matrix — click for Graph"],
      ]),
      ctoolGraphOnly(ctoolGroup("Unmatched", "How unmatched items are treated: dimmed in place, or removed from the map", [
        [IC.unDim,  () => mode.val === "dim",  () => (mode.val = "dim"),  "Dim — click for Hide"],
        [IC.unHide, () => mode.val === "hide", () => (mode.val = "hide"), "Hide — click for Dim"],
      ])),
      // Edges/Labels are set-and-forget display prefs (also in the Project
      // popover's Display section) — shown here only when the toolbar has
      // room (≥1200px, .ctool-optional).
      ctoolGraphOnly(span({ class: "ctool-optional" },
        ctoolGroup("Edges", "Edges: one aggregated strand per connection (width = stream count), or one curve per stream fanned out parallel", [
          [IC.edgesBundle,  () => !expand.val, () => (expand.val = false), "Bundle — click for Expand"],
          [IC.edgesExpand, () => expand.val,  () => (expand.val = true),  "Expand — click for Bundle"],
        ]),
        ctoolGroup("Labels", "Show or hide stream name labels on edges", [
          [IC.labelsShow, () => showEdgeLabels.val,  () => (showEdgeLabels.val = true),  "Show — click for Hide"],
          [IC.labelsHide, () => !showEdgeLabels.val, () => (showEdgeLabels.val = false), "Hide — click for Show"],
        ]),
      )),
      // History cluster: Undo / Redo (disabled-aware) + a divider + the
      // History popover trigger. Undo/Redo live here, not in the Project
      // popover, because they are transient one/few-shot actions.
      div({ class: "ctool ctool-history", role: "group", "aria-label": "History and Filters" },
        button({
          type: "button",
          class: "ctool-btn",
          title: () => undoBlocked() ? "Switch to My workspace to undo" : "Undo (Ctrl+Z)",
          "aria-label": "Undo",
          disabled: () => undoBlocked() || !historyState.val.can_undo,
          onclick: doUndo,
        }, iconSVG(IC.undo)),
        button({
          type: "button",
          class: "ctool-btn",
          title: () => undoBlocked() ? "Switch to My workspace to redo" : "Redo (Ctrl+Shift+Z)",
          "aria-label": "Redo",
          disabled: () => undoBlocked() || !historyState.val.can_redo,
          onclick: doRedo,
        }, iconSVG(IC.redo)),
        span({ class: "ctool-divider", "aria-hidden": "true" }),
        historyMenu,
        span({ class: "ctool-divider", "aria-hidden": "true" }),
        // Filter On/Off lives only on the funnel. When Off with saved facets,
        // badge + dormant styling tell the story (no canvas banner).
        button({
          type: "button",
          class: () => {
            const n = activeFacetCount();
            const on = showFilterHud.val;
            return "ctool-btn"
              + (on ? " active" : "")
              + (n > 0 ? " has-facets" : "")
              + (!on && n > 0 ? " dormant" : "");
          },
          title: () => {
            const n = activeFacetCount();
            if (!showFilterHud.val && n > 0) {
              return `${n} filter${n === 1 ? "" : "s"} saved · click to re-enable`;
            }
            if (n > 0) return `Filters (${n} active) — click to open or turn off`;
            return "Toggle filters";
          },
          "aria-label": "Toggle Filters HUD",
          "aria-pressed": () => showFilterHud.val ? "true" : "false",
          onclick: () => {
            showFilterHud.val = !showFilterHud.val;
            if (showFilterHud.val) {
              hudCollapsed.val = false;
            } else {
              clearDraftInput(); // hiding the HUD discards the draft preview
            }
          },
        },
          iconSVG(IC.funnel),
          span({
            class: "ctool-badge",
            "aria-hidden": "true",
            style: () => (activeFacetCount() > 0 ? "" : "display:none"),
          }, () => String(activeFacetCount() || "")),
        ),
      ),
    );

  // ---- export menu ----
  // Folds the infrequent SVG / JSON downloads behind one button so the
  // topbar's primary cluster is brand + project + filters + Analysis, and
  // the export actions never wrap loose onto a second line. The panel uses
  // the same viewport-aware placement as the filter dropdowns.
  const exportMenu = (() => {
    const open = van.state(false);
    let root, btn, panel;
    const close = () => {
      open.val = false;
      document.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("resize", reposition);
    };
    const onOutside = (e) => { if (!root.contains(e.target) && !panel.contains(e.target)) close(); };
    const reposition = () => { if (open.val) placePanel(panel, root); };
    const toggle = () => {
      if (open.val) { close(); return; }
      open.val = true;
      document.addEventListener("mousedown", onOutside, true);
      window.addEventListener("resize", reposition);
      requestAnimationFrame(() => requestAnimationFrame(() => { if (open.val) placePanel(panel, root); }));
    };
    const doSVG = () => { close(); graph.exportSVG(`${proj}-map`); };
    const doJSON = () => {
      close();
      const a = document.createElement("a");
      a.href = api.exportURL(proj);
      a.download = `${proj}.spaghetti.json`;
      a.click();
    };
    // Integration register (.xlsx). Prefer POST with a canvas PNG; on any
    // rasterization failure fall back to GET (workbook without the picture).
    const doXLSX = () => {
      close();
      const trigger = (href, download) => {
        const a = document.createElement("a");
        a.href = href;
        a.download = download || "";
        a.click();
      };
      const fallbackGET = () => {
        trigger(api.reportURL(proj), "");
      };
      const downloadBlob = async (res) => {
        const cd = res.headers.get("Content-Disposition") || "";
        const m = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(cd);
        const name = m ? decodeURIComponent(m[1].replace(/"$/, "")) : `${proj}-integration-register.xlsx`;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        trigger(url, name);
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      };
      (async () => {
        try {
          let mapPng = null;
          try {
            mapPng = await graph.exportMapPNG();
          } catch {
            // rasterization failed — workbook without picture is still useful
          }
          if (mapPng) {
            const res = await fetch(api.reportURL(proj), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ map_png: mapPng }),
            });
            if (!res.ok) throw new Error(`report ${res.status}`);
            await downloadBlob(res);
            return;
          }
          fallbackGET();
        } catch {
          fallbackGET();
        }
      })();
    };
    const onKeys = (e) => {
      if (e.key === "Escape" && open.val) { e.stopPropagation(); e.preventDefault(); close(); btn.focus(); }
      if ((e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") && !open.val) { e.preventDefault(); toggle(); }
    };
    btn = button({
      type: "button", class: "btn export-btn",
      title: "Download the map as an SVG image, the project as a shareable JSON file, or an .xlsx integration register",
      onclick: toggle, onkeydown: onKeys,
    }, "Export", span({ class: "proj-caret" }, "▾"));
    panel = div(
      { class: "dd-panel export-panel", style: () => (open.val ? "" : "display:none"), onkeydown: onKeys },
      button({ type: "button", class: "dd-opt", onclick: doSVG },
        span({ class: "dd-check" }, "▦"), span("SVG image")),
      button({ type: "button", class: "dd-opt", onclick: doJSON },
        span({ class: "dd-check" }, "{}"), span("Project JSON")),
      button({ type: "button", class: "dd-opt", onclick: doXLSX },
        span({ class: "dd-check" }, "▤"), span("Integration register (.xlsx)")),
    );
    root = div({ class: "dd export-dd", "data-dd": "Export" }, btn, panel);
    return root;
  })();

  // ---- filter HUD ----
  // All committed filter conditions, including flow (variant A: regular facet)
  // and cluster chips (GS-5 A1 — live references in the Systems "where" grain).
  const activeFacetCount = () => {
    let n = 0;
    if (filters.scope.val !== "all") n++;
    if (filters.queries.val && filters.queries.val.length) n += filters.queries.val.length;
    if (filters.systems.val.size) n += filters.systems.val.size;
    if (filters.clusters.val.size) n += filters.clusters.val.size;
    if (filters.statuses.val.size) n += filters.statuses.val.size;
    if (filters.timings.val.size) n += filters.timings.val.size;
    if (filters.needs.val.size) n += filters.needs.val.size;
    if (filters.flow.val) n++;
    return n;
  };

  // Clears committed filters (+ draft). Does not toggle Filter On/Off.
  const clearAllFilters = () => {
    filters.q.val = "";
    filters.scope.val = "all";
    filters.queries.val = [];
    filters.statuses.val = new Set();
    filters.timings.val = new Set();
    filters.needs.val = new Set();
    filters.systems.val = new Set();
    filters.clusters.val = new Set();
    filters.flow.val = "";
  };

  const hudCollapsed = van.state(true);
  const showSuggestions = van.state(false);
  const hudSearchText = van.state("");
  const hlIndex = van.state(-1);

  const clearDraftInput = () => {
    clearTimeout(qTimer); // a pending debounce must not resurrect the draft
    filters.q.val = "";
    filters.scope.val = "all";
    hudSearchText.val = "";
    hudSearchInput.value = "";
    hlIndex.val = -1;
  };

  const commitSearchQuery = () => {
    const text = filters.q.val.trim();
    if (text) {
      const next = [...filters.queries.val];
      const scope = filters.scope.val;
      if (!next.some(q => q.q === text && q.scope === scope)) {
        filters.queries.val = [...next, { q: text, scope }];
      }
      clearDraftInput();
    }
  };

  const toggleSystem = (sysId) => {
    const next = new Set(filters.systems.val);
    if (next.has(sysId)) next.delete(sysId);
    else next.add(sysId);
    filters.systems.val = next;
    clearDraftInput();
  };
  const toggleCluster = (clusterId) => {
    const next = new Set(filters.clusters.val);
    if (next.has(clusterId)) next.delete(clusterId);
    else {
      next.add(clusterId);
      const c = data.val?.clusters?.find((x) => x.id === clusterId);
      if (c) {
        clusterNameCache.set(c.id, c.name);
        persistClusterNames();
      }
    }
    filters.clusters.val = next;
    clearDraftInput();
  };
  const toggleStatus = (st) => {
    const next = new Set(filters.statuses.val);
    if (next.has(st)) next.delete(st);
    else next.add(st);
    filters.statuses.val = next;
    clearDraftInput();
  };
  const toggleTiming = (t) => {
    const next = new Set(filters.timings.val);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    filters.timings.val = next;
    clearDraftInput();
  };
  const toggleNeed = (ndId) => {
    const next = new Set(filters.needs.val);
    if (next.has(ndId)) next.delete(ndId);
    else next.add(ndId);
    filters.needs.val = next;
    clearDraftInput();
  };

  // Live member count for a cluster chip title / picker meta (§2.6 / §4).
  const clusterMemberCount = (c) => {
    if (!c) return 0;
    const present = new Set((data.val?.systems ?? []).map((s) => s.id));
    return (c.system_ids ?? []).filter((id) => present.has(id)).length;
  };

  // Facet rows are always available (not gated by text-search scope). Scope only
  // affects the committed search query. Systems list is capped so Status/Need
  // are not buried under a long scroll (H3/H4).
  const SYSTEM_SUGGEST_CAP = 20;
  let lastHudItems = []; // keyboard Enter / highlight without remounting the list
  let mouseHlIndex = -1; // hover index for Enter (H3a; not reactive)

  const getInteractiveItems = () => {
    if (!data.val) return [];
    const q = filters.q.val.trim().toLowerCase();
    const scope = filters.scope.val;
    const items = [];

    if (filters.q.val.trim()) {
      items.push({
        type: "action",
        label: `⏎ Press Enter to search for "${filters.q.val}"` + (scope !== "all" ? ` in ${scope}` : ""),
        onclick: () => commitSearchQuery(),
      });
    }

    ["all", "systems", "streams", "entities", "fields"].forEach((sc) => {
      items.push({
        type: "scope",
        value: sc,
        label: `in: ${sc}`,
        selected: filters.scope.val === sc,
        onclick: () => { filters.scope.val = sc; },
      });
    });

    // Clusters section ABOVE Systems (§2.6). Hue dot + name + muted count.
    const clusters = (data.val.clusters ?? []).filter((c) => !q || c.name.toLowerCase().includes(q));
    clusters.forEach((c) => {
      const n = clusterMemberCount(c);
      items.push({
        type: "cluster",
        value: c.id,
        label: c.name,
        meta: plural(n, "system"),
        dot: graph.clusterColorHex?.(c.color) ?? "#3fae94",
        selected: filters.clusters.val.has(c.id),
        onclick: () => toggleCluster(c.id),
      });
    });

    const systems = (data.val.systems ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));
    if (systems.length > 0) {
      systems.slice(0, SYSTEM_SUGGEST_CAP).forEach((s) => {
        items.push({
          type: "system",
          value: s.id,
          label: s.name,
          selected: filters.systems.val.has(s.id),
          onclick: () => toggleSystem(s.id),
        });
      });
      if (systems.length > SYSTEM_SUGGEST_CAP) {
        items.push({
          type: "hint",
          label: `…${systems.length - SYSTEM_SUGGEST_CAP} more systems — type to narrow`,
          selected: false,
          onclick: () => {},
        });
      }
    }

    // Status / Timing / Need / Flow are facets (or focus), not gated by text scope.
    ["planned", "implemented", "unknown"]
      .filter((st) => !q || st.toLowerCase().includes(q))
      .forEach((st) => {
        items.push({
          type: "status",
          value: st,
          label: st,
          selected: filters.statuses.val.has(st),
          onclick: () => toggleStatus(st),
        });
      });

    ["real-time", "scheduled"]
      .filter((t) => !q || t.toLowerCase().includes(q))
      .forEach((t) => {
        items.push({
          type: "timing",
          value: t,
          label: t,
          selected: filters.timings.val.has(t),
          onclick: () => toggleTiming(t),
        });
      });

    (data.val.needs ?? [])
      .filter((n) => !q || n.name.toLowerCase().includes(q))
      .forEach((n) => {
        items.push({
          type: "need",
          value: n.id,
          label: n.name,
          selected: filters.needs.val.has(n.id),
          onclick: () => toggleNeed(n.id),
        });
      });

    // Flow is a regular single-valued filter condition (like status/need).
    (data.val.flows ?? [])
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .forEach((f) => {
        items.push({
          type: "flow",
          value: f.id,
          label: f.name,
          selected: filters.flow.val === f.id,
          onclick: () => {
            filters.flow.val = filters.flow.val === f.id ? "" : f.id;
            clearDraftInput();
          },
        });
      });

    return items;
  };

  // Imperative keyboard/hover highlight — must NOT rebuild the list (H3a).
  const applyHudHighlight = (idx) => {
    mouseHlIndex = idx;
    const els = document.querySelectorAll(".hud-suggestions-scroll .hud-item");
    els.forEach((el, i) => el.classList.toggle("hl", i === idx));
    if (idx >= 0 && els[idx]) els[idx].scrollIntoView({ block: "nearest" });
  };

  const hudSearchInput = input({
    type: "text",
    class: "hud-search-input",
    placeholder: "Search or filter…",
    value: () => hudSearchText.val,
    oninput: (e) => {
      hudSearchText.val = e.target.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        filters.q.val = e.target.value;
        hlIndex.val = -1;
        applyHudHighlight(-1);
      }, 150);
      showSuggestions.val = true;
    },
    onfocus: () => {
      showSuggestions.val = true;
      hlIndex.val = -1;
      applyHudHighlight(-1);
    },
    onkeydown: (e) => {
      const items = lastHudItems.length ? lastHudItems : getInteractiveItems();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (items.length) {
          const next = (hlIndex.val + 1) % items.length;
          hlIndex.val = next;
          applyHudHighlight(next);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length) {
          const next = (hlIndex.val - 1 + items.length) % items.length;
          hlIndex.val = next;
          applyHudHighlight(next);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = hlIndex.val >= 0 ? hlIndex.val : mouseHlIndex;
        if (pick >= 0 && pick < items.length) {
          const it = items[pick];
          if (it.type !== "hint") it.onclick();
        } else {
          commitSearchQuery();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        clearDraftInput(); // draft is a preview; collapsing discards it
        hudCollapsed.val = true;
        showSuggestions.val = false;
      }
    },
  });

  document.addEventListener("click", (e) => {
    const hudEl = document.getElementById("filter-hud");
    const pillEl = document.getElementById("hud-collapsed-pill");
    const triggerEl = document.querySelector('[aria-label="Toggle Filters HUD"]');
    if (hudEl && !hudEl.contains(e.target) && (!pillEl || !pillEl.contains(e.target)) && (!triggerEl || !triggerEl.contains(e.target))) {
      if (!hudCollapsed.val) clearDraftInput(); // discard the draft preview
      hudCollapsed.val = true;
      showSuggestions.val = false;
    }
  });

  // Chip label: prefix stays visible; value truncates with ellipsis in the pill.
  // Collapsed pill shows a vertical stack of ALL chips (CSS: max 2 visible + scroll).
  // Cluster chips (§2.6): amber geometry + 8px hue dot; deleted/absent state muted.
  const filterChip = (fullLabel, onClear, opts = {}) =>
    div({
      class: "f-chip" + (opts.deleted ? " f-chip-deleted" : "") + (opts.extraClass ? ` ${opts.extraClass}` : ""),
      title: opts.title ?? fullLabel,
    },
      opts.dot != null
        ? span({
            class: "f-chip-dot",
            style: `background:${opts.deleted ? "#3b4a5e" : opts.dot}`,
          })
        : null,
      span({ class: "f-chip-text" }, fullLabel),
      button({
        type: "button",
        title: "Remove",
        onclick: (e) => { e.stopPropagation(); onClear(); },
      }, "✕"),
    );

  const buildFacetChips = () => {
    const chips = [];
    const queries = filters.queries.val;
    for (let idx = 0; idx < queries.length; idx++) {
      const item = queries[idx];
      const label = item.scope !== "all" ? `${item.scope}: "${item.q}"` : `Search: "${item.q}"`;
      const i = idx;
      chips.push(filterChip(label, () => {
        const next = [...filters.queries.val];
        next.splice(i, 1);
        filters.queries.val = next;
      }));
    }
    // Cluster chips (A1) sit with systems as the "where" grain — render first
    // among where chips so the pill lists them with systems.
    for (const cid of filters.clusters.val) {
      const c = data.val?.clusters?.find((x) => x.id === cid);
      const cached = clusterNameCache.get(cid);
      if (c) {
        const n = clusterMemberCount(c);
        chips.push(filterChip(c.name, () => toggleCluster(cid), {
          dot: graph.clusterColorHex?.(c.color) ?? "#3fae94",
          title: plural(n, "system"),
        }));
      } else {
        // Deleted / absent (e.g. Main without this Mine-only cluster).
        const nm = cached || "Cluster";
        chips.push(filterChip(`${nm} (deleted)`, () => toggleCluster(cid), {
          deleted: true,
          dot: "#3b4a5e",
          title: "0 systems",
        }));
      }
    }
    for (const sysId of filters.systems.val) {
      const name = data.val?.systems.find((s) => s.id === sysId)?.name || sysId;
      chips.push(filterChip(`System: ${name}`, () => toggleSystem(sysId)));
    }
    for (const st of filters.statuses.val) {
      chips.push(filterChip(`Status: ${st}`, () => toggleStatus(st)));
    }
    for (const t of filters.timings.val) {
      chips.push(filterChip(`Timing: ${t}`, () => toggleTiming(t)));
    }
    for (const ndId of filters.needs.val) {
      const name = data.val?.needs.find((n) => n.id === ndId)?.name || ndId;
      chips.push(filterChip(`Need: ${name}`, () => toggleNeed(ndId)));
    }
    if (filters.flow.val) {
      const name = data.val?.flows.find((f) => f.id === filters.flow.val)?.name || filters.flow.val;
      chips.push(filterChip(`Flow: ${name}`, () => { filters.flow.val = ""; }));
    }
    return chips;
  };

  const buildAllChips = () => buildFacetChips();

  const FilterHud = () => {
    if (!showFilterHud.val || !data.val) return span({ style: "display:none" });

    let hudWasDragged = false;

    const startDrag = (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startTop = hudPos.val.top;
      const startLeft = hudPos.val.left;
      hudWasDragged = false;

      const move = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
          hudWasDragged = true;
        }
        const colEl = document.querySelector(".canvas-col");
        const containerEl = document.getElementById("filter-hud-container");
        const pillEl = document.getElementById("hud-collapsed-pill");
        const isCollapsed = hudCollapsed.val;
        const hudWidth = isCollapsed ? (pillEl?.offsetWidth || 180) : (containerEl?.clientWidth || 340);
        const hudHeight = isCollapsed ? (pillEl?.offsetHeight || 36) : (containerEl?.clientHeight || 80);
        const maxLeft = (colEl?.clientWidth ?? window.innerWidth) - hudWidth - 10;
        const maxTop = (colEl?.clientHeight ?? window.innerHeight) - hudHeight - 10;
        const minTop = (colEl?.querySelector(".canvas-toolbar")?.offsetHeight ?? 39) + 8;

        hudPos.val = {
          top: Math.max(minTop, Math.min(maxTop, startTop + deltaY)),
          left: Math.max(10, Math.min(maxLeft, startLeft + deltaX)),
        };
      };

      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };

      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    // Build suggestions without reading hlIndex — hover must not remount (H3a).
    const buildSuggestionsBody = () => {
      const items = getInteractiveItems();
      lastHudItems = items;
      const sections = [];
      let currentGlobalIndex = 0;

      const renderItem = (item) => {
        const idx = currentGlobalIndex++;
        const isSelected = item.selected;
        const base = "hud-item"
          + (item.type === "action" ? " action-item" : "")
          + (item.type === "hint" ? " hint-item" : "")
          + (isSelected ? " selected" : "");
        return div({
          class: base,
          "data-hud-idx": String(idx),
          onmouseenter: (e) => {
            if (item.type === "hint") return;
            const scroll = e.currentTarget.closest(".hud-suggestions-scroll");
            scroll?.querySelectorAll(".hud-item.hl").forEach((el) => el.classList.remove("hl"));
            e.currentTarget.classList.add("hl");
            mouseHlIndex = idx;
          },
          onclick: () => { if (item.type !== "hint") item.onclick(); },
        },
          div({ class: "hud-item-main" },
            item.dot
              ? span({ class: "cluster-dot", style: `background:${item.dot}` })
              : null,
            span({ class: "hud-item-label" }, item.label),
          ),
          item.meta ? span({ class: "hud-item-meta" }, item.meta) : null,
          isSelected ? span({ class: "hud-item-check" }, "✓") : null,
        );
      };

      const pushSection = (title, type) => {
        const list = items.filter((x) => x.type === type);
        if (!list.length) return;
        sections.push(div({ class: "hud-section-title" }, title));
        list.forEach((item) => sections.push(renderItem(item)));
      };

      pushSection("Actions", "action");
      pushSection("Scope", "scope");
      // Clusters above Systems (§2.6) — grain cue is the right-aligned count.
      pushSection("Clusters", "cluster");
      pushSection("Systems", "system");
      items.filter((x) => x.type === "hint").forEach((item) => sections.push(renderItem(item)));
      pushSection("Status", "status");
      pushSection("Timing", "timing");
      pushSection("Need", "need");
      pushSection("Flow", "flow");

      return sections;
    };

    const activeChipsBlock = () => {
      // Always track committed state so chips reappear after commit (H1).
      filters.queries.val;
      filters.systems.val;
      filters.clusters.val;
      filters.statuses.val;
      filters.timings.val;
      filters.needs.val;
      filters.flow.val;
      data.val;
      const chips = buildAllChips();
      return div({ class: "hud-active-section" },
        div({ class: "hud-section-title hud-active-title" }, "Active"),
        chips.length
          ? div({ class: "hud-active-chips-row" }, ...chips)
          : div({ class: "hud-active-empty" }, "None — pick a filter below or type a search"),
      );
    };

    // Collapsed pill body — vertical chip stack (CSS caps at 2 visible + scroll).
    // Variant A: every active filter is listed; Flow pinned first for journey context.
    const pillBody = () => {
      filters.queries.val;
      filters.systems.val;
      filters.clusters.val;
      filters.statuses.val;
      filters.timings.val;
      filters.needs.val;
      filters.flow.val;
      filters.q.val;
      data.val;
      const chips = buildAllChips();
      if (!chips.length) {
        return span({ class: "hud-search-placeholder" }, "Search or filter…");
      }
      // buildFacetChips appends Flow last when present — promote it to the top.
      let ordered = chips;
      if (filters.flow.val && chips.length > 1) {
        ordered = [chips[chips.length - 1], ...chips.slice(0, -1)];
      }
      return div({ class: "hud-pill-chips" }, ...ordered);
    };

    return div({
      id: "filter-hud-container",
      style: () => `position:absolute; top:${hudPos.val.top}px; left:${hudPos.val.left}px; z-index:1000;`,
    },
      div({
        id: "hud-collapsed-pill",
        class: () => "hud-collapsed-pill" + (activeFacetCount() > 0 ? " has-active" : ""),
        style: () => hudCollapsed.val ? "" : "display:none",
        title: "Click to edit filters · drag to move",
        onmousedown: (e) => {
          if (e.target.tagName === "BUTTON" || e.target.closest("button")) return;
          startDrag(e);
        },
        onclick: (e) => {
          if (e.target.tagName === "BUTTON" || e.target.closest("button")) return;
          if (!hudWasDragged) {
            hudCollapsed.val = false;
            showSuggestions.val = true;
          }
        },
      },
        span({ class: "hud-search-icon", "aria-hidden": "true" }, () => iconSVG(IC.search)),
        // Explicit binding wrapper so chip updates always remount the pill body.
        () => pillBody(),
      ),
      div({
        id: "filter-hud",
        class: "filter-hud",
        style: () => hudCollapsed.val ? "display:none" : "",
      },
        div({ class: "hud-handle", onmousedown: startDrag }),
        div({ class: "hud-body" },
          div({ class: "hud-search-container" },
            div({ class: "hud-input-bar" },
              span({ class: "hud-search-icon" }, iconSVG(IC.search)),
              hudSearchInput,
              button({
                class: "hud-clear-btn",
                style: () => (activeFacetCount() > 0 || filters.q.val.trim()) ? "" : "display:none",
                onclick: () => {
                  clearAllFilters();
                  hudSearchInput.value = "";
                  hudSearchText.val = "";
                },
              }, "Clear"),
            ),
            // Sticky Active strip — always above the fold when expanded (H1).
            activeChipsBlock,
          ),
          () => {
            // Rebuild only when suggestion *content* deps change — not hlIndex (H3a).
            showSuggestions.val;
            filters.q.val;
            filters.scope.val;
            filters.queries.val;
            filters.systems.val;
            filters.clusters.val;
            filters.statuses.val;
            filters.timings.val;
            filters.needs.val;
            filters.flow.val;
            data.val;
            if (!showSuggestions.val) {
              return div({ class: "hud-suggestions", style: "display:none" });
            }
            return div({ class: "hud-suggestions" },
              div({ class: "hud-suggestions-scroll" }, ...buildSuggestionsBody()),
              div({ class: "hud-suggestions-footer" }, "Enter to select/add • ↑↓ to navigate"),
            );
          },
        ),
      ),
    );
  };

  // ---- project settings popover (anchored to the topbar proj-name) ----
  // Replaces the former left `.project-drawer`. Body = description + Canvas
  // switches (Bundle/Expand + arc spacing + edge labels) + Architects section.
  const saveDescription = (description) => busy(async () => {
    await api.projects.update(proj, { name: proj, description: description.trim() });
    toast("Project saved");
    reload();
  });

  const projectPanelBody = () => {
    try {
    const pr = data.val.project;
    return div({ class: "project-panel" },
      div({ class: "pp-head" },
        h3("Project"),
        button({ class: "btn ghost small", title: "Close", onclick: () => (showProject.val = false) }, "\u2715"),
      ),
      div({ class: "inspector-body" },
        field("Name", input({ type: "text", value: pr.name, disabled: true, title: "Rename via the project folder on disk" })),
        field("Description", input({
          type: "text", value: pr.description ?? "",
          placeholder: "What map is this?",
          onchange: (e) => saveDescription(e.target.value),
        })),
        div({ class: "analysis-section", style: "margin-top:14px" },
          h5({ title: "These display choices are saved per project and travel with exports." }, "Display"),
          field("Edges", div({ class: "mode-toggle", title: "Bundle: one aggregated strand per connection (width = stream count). Expand: one curve per stream, fanned out parallel." },
            button({ class: () => (expand.val ? "" : "active"), onclick: () => (expand.val = false) }, "Bundle"),
            button({ class: () => (expand.val ? "active" : ""), onclick: () => (expand.val = true) }, "Expand"),
          )),
          field("Edge labels", div({ class: "mode-toggle", title: "Show or hide stream name labels on edges" },
            button({ class: () => (showEdgeLabels.val ? "active" : ""), onclick: () => (showEdgeLabels.val = true) }, "Show"),
            button({ class: () => (showEdgeLabels.val ? "" : "active"), onclick: () => (showEdgeLabels.val = false) }, "Hide"),
          )),
          field("Filter map", div({ class: "mode-toggle", title: "Enable or disable active filters on the map" },
            button({ class: () => (showFilterHud.val ? "active" : ""), onclick: () => (showFilterHud.val = true) }, "On"),
            button({ class: () => (showFilterHud.val ? "" : "active"), onclick: () => (showFilterHud.val = false) }, "Off"),
          )),
          field("Arc spacing", div({ class: "fan-spacing", title: "Gap between parallel strands in Expand mode" },
            input({
              type: "range", min: "12", max: "80", step: "2", value: fanSpacing.val,
              oninput: (e) => (fanSpacing.val = +e.target.value),
            }),
            span({ class: "fan-spacing-val" }, () => fanSpacing.val + "px"),
          )),
          button({
            class: "btn small",
            style: () => "margin-top:6px;" + ((activeFacetCount() > 0 || filters.q.val.trim()) ? "" : "display:none"),
            title: "Filters are saved per architect for this project — they never travel with merges or exports",
            onclick: () => {
              clearAllFilters();
              hudSearchInput.value = "";
              hudSearchText.val = "";
            },
          }, "Clear active filters"),
        ),
        (architectsPanel ||= ArchitectsSection(proj, reload)),
      ),
    );
    } catch (err) {
      return div({ class: "project-panel", style: "padding:14px;color:#e0623c" }, "PANEL ERR: " + (err && (err.stack || err.message)) + " | " + String(err));
    }
  };

  const projectMenu = (() => {
    const btn = button({
      type: "button",
      id: "project-trigger",
      class: () => "proj-name" + (showProject.val ? " active" : ""),
      title: "Project settings — description and canvas display preferences",
      "aria-haspopup": "true",
      "aria-expanded": () => showProject.val ? "true" : "false",
      onclick: () => { showProject.val = !showProject.val; if (showProject.val) showHistory.val = false; },
    }, proj, span({ class: "proj-caret" }, "\u25BE"));
    wirePopover({ state: showProject, panelId: "project-popover", anchorId: "project-trigger", maxHeight: 560 });
    return div({ class: "dd project-dd", "data-dd": "Project" }, btn);
  })();

  // Project popover: a DIRECT workspace function child so the body (which
  // depends on data.val + the architects list) re-renders each time it opens.
  const projectPopover = () => {
    if (!showProject.val || !data.val) return span({ style: "display:none" });
    return div({
      id: "project-popover",
      class: "dd-panel project-panel-pop open",
      role: "dialog",
      "aria-label": "Project settings",
    }, projectPanelBody());
  };

  const topbar = () =>
    div({ class: "topbar" },
      a({ class: "brand-mini", href: "#/" }, logoSVG(22), "SpaghettiMapper"),
      projectMenu,
      // DR-3: whose line (Mine · Main) sits next to the project name, always
      // labeled — not an icon pair among display toggles. Signed-in only.
      ViewToggle({ reload }),
      span({ class: "spacer" }),
      button({
        class: () => "btn" + (selection.val?.type === "analysis" ? " primary" : ""),
        title: "Coverage stats and unjustified data in motion",
        onclick: () => (selection.val = selection.val?.type === "analysis" ? null : { type: "analysis" }),
      }, "Analysis"),
      exportMenu,
      AccountControl(),
    );

  // (The read-only preview lightbox is gone — replaced by the P2 inline
  // detail view inside the History popover. See historyDetailBody above.)

  const e2eFiltersBridge = () => {
    const statusEl = div({ "data-dd": "Status" });
    statusEl._ddSet = (v) => {
      if (!v) {
        filters.statuses.val = new Set();
      } else {
        filters.statuses.val = new Set(Array.isArray(v) ? v : [v]);
      }
    };

    const scopeEl = div({ "data-dd": "Scope" });
    scopeEl._ddSet = (v) => {
      filters.scope.val = v || "all";
    };

    const flowEl = div({ "data-dd": "Flow" });
    flowEl._ddSet = (v) => {
      filters.flow.val = v || "";
      if (v) showFilterHud.val = true;
    };

    // Systems facet bridge for e2e (GS-4 hide-filter hull tests).
    const systemsEl = div({ "data-dd": "Systems" });
    systemsEl._ddSet = (v) => {
      if (!v || (Array.isArray(v) && !v.length)) filters.systems.val = new Set();
      else filters.systems.val = new Set(Array.isArray(v) ? v : [v]);
    };

    // Clusters facet bridge for e2e (GS-5).
    const clustersEl = div({ "data-dd": "Clusters" });
    clustersEl._ddSet = (v) => {
      if (!v || (Array.isArray(v) && !v.length)) filters.clusters.val = new Set();
      else {
        const ids = Array.isArray(v) ? v : [v];
        for (const id of ids) {
          const c = data.val?.clusters?.find((x) => x.id === id);
          if (c) {
            clusterNameCache.set(c.id, c.name);
            persistClusterNames();
          }
        }
        filters.clusters.val = new Set(ids);
      }
    };

    const needsEl = div({ "data-dd": "Needs" });
    needsEl._ddSet = (v) => {
      if (!v || (Array.isArray(v) && !v.length)) filters.needs.val = new Set();
      else filters.needs.val = new Set(Array.isArray(v) ? v : [v]);
    };

    return div({ style: "display:none" },
      statusEl,
      scopeEl,
      flowEl,
      systemsEl,
      clustersEl,
      needsEl,
      // Mock search box for compatibility
      div({ class: "filters" },
        input({
          class: "search",
          value: () => filters.q.val,
          oninput: (e) => { filters.q.val = e.target.value; }
        })
      )
    );
  };

  // ---- assemble ----
  // Floating zoom cluster (bottom-right of the canvas): the on-screen
  // counterpart to wheel/pinch — visible, clickable, and labelled with the
  // current zoom. The % label resets to 100%; Fit lives here (a view action
  // belongs on the canvas, not in the mode toolbar). Hidden in matrix lens.
  const zoomCtl = div({
    class: "canvas-zoomctl",
    style: () => (view.val === "matrix" ? "display:none" : ""),
  },
    button({ class: "zctl-btn", title: "Zoom out (−)", "aria-label": "Zoom out", onclick: () => graph.zoomBy(0.8) }, "−"),
    button({ class: "zctl-pct", title: "Zoom level — click for 100%", "aria-label": "Reset zoom to 100%", onclick: () => graph.zoomTo(1) },
      () => Math.round(zoomLevel.val * 100) + "%"),
    button({ class: "zctl-btn", title: "Zoom in (+)", "aria-label": "Zoom in", onclick: () => graph.zoomBy(1.25) }, "+"),
    span({ class: "ctool-divider", "aria-hidden": "true" }),
    button({ class: "zctl-btn", title: "Fit map to view (0)", "aria-label": "Fit map to view", onclick: () => graph.fitToView() }, iconSVG(IC.fit)),
  );
  // Filter Off + saved facets: funnel badge + .dormant styling only (option 1).
  // No floating canvas banner — duplicate chrome and not draggable.

  const canvasCol = div({ class: "canvas-col" }, canvasToolbar, FilterHud, canvasEl, zoomCtl);
  // Keep the floating HUD inside the canvas column whenever the column
  // resizes (rail/inspector drag, window resize) — a position saved against
  // a wide canvas must not strand the pill under the inspector, and the
  // toolbar's measured height (not an assumed single row) sets the floor.
  const hudClamp = new ResizeObserver(() => {
    const colW = canvasCol.clientWidth, colH = canvasCol.clientHeight;
    if (!colW || !colH) return;
    const pill = document.getElementById("hud-collapsed-pill");
    const box = document.getElementById("filter-hud-container");
    const hw = (hudCollapsed.val ? pill?.offsetWidth : box?.clientWidth) || 320;
    const hh = (hudCollapsed.val ? pill?.offsetHeight : box?.clientHeight) || 80;
    const minTop = (canvasCol.querySelector(".canvas-toolbar")?.offsetHeight ?? 39) + 8;
    const p = hudPos.val;
    const left = Math.max(10, Math.min(colW - hw - 10, p.left));
    const top = Math.max(minTop, Math.min(colH - hh - 10, p.top));
    if (left !== p.left || top !== p.top) hudPos.val = { top, left };
  });
  hudClamp.observe(canvasCol);
  // Also watch the strip itself: if it ever does wrap taller (last-resort
  // net near MIN_CANVAS), the HUD yields immediately.
  const tbEl = canvasCol.querySelector(".canvas-toolbar");
  if (tbEl) hudClamp.observe(tbEl);
  return div({ class: "workspace" },
    topbar,
    div({ class: "body-split" },
      div({
        class: () => "rail" + (editing.val ? " form-open" : ""),
        style: () => `width:${effRailWidth()}px;flex:none`,
      },
        div({ class: "rail-tabs" },
          ["systems", "streams", "needs", "flows", "clusters"].map((t) =>
            button({ class: () => (tab.val === t ? "active" : ""), onclick: () => { tab.val = t; } }, t)),
        ),
        div({ class: "rail-body" }, railBody),
      ),
      makeResizer(railWidth, "resizer--rail", "sm.railW"),
      canvasCol,
      inspectorHandle,
      inspector,
    ),
    projectPopover,
    historyPopover,
    e2eFiltersBridge,
  );
}


// subscribeProjectEvents opens an SSE subscription for a project and calls
// onArchitects (refresh the architects list) for every event, plus onGraph
// (reload the graph) when main changes (a merge/abort). A single subscription
// per project is kept; switching projects replaces it.
let projectES = null;
let projectESFor = null;

// The architects list is shared state, loaded when a project opens (not when
// the Project drawer opens) and kept live by the project SSE subscription, so
// the panel can reflect concurrent architects even before you open it.
let architectsList = van.state(null);
let architectsProj = null;
function loadArchitects(proj) {
  api.architects.list(proj)
    .then((a) => { if (architectsProj === proj) architectsList.val = a || []; })
    .catch(() => { if (architectsProj === proj) architectsList.val = []; });
}

function subscribeProjectEvents(proj, onArchitects, onGraph) {
  if (!authEnabled.val) return; // no architects to watch under -no-auth
  if (projectESFor === proj && projectES) return;
  if (projectES) projectES.close();
  if (archTick) { clearInterval(archTick); archTick = null; } // panel rebuilt on project switch
  projectESFor = proj;
  projectES = new EventSource(`/api/projects/${encodeURIComponent(proj)}/events`);
  projectES.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      onArchitects();
      if (ev.type === "merge" || ev.type === "abort") onGraph();
    } catch { onArchitects(); }
  };
  projectES.onerror = () => { /* EventSource auto-reconnects; just keep going */ };
}

// ---- architect panel helpers ----

// relativeTime turns a Date / ISO string into a short "3m ago" label relative
// to `now` (a ms epoch). Empty when the timestamp is missing/invalid.
function relativeTime(when, now) {
  if (!when) return "";
  const t = (when instanceof Date ? when : new Date(when)).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// statusFor classifies a branch relative to main for the panel pill:
//   ready    — ahead only (a clean fast-forward combine)
//   diverged — ahead and behind (3-way merge; may conflict)
//   idle     — nothing ahead (nothing to combine right now)
function statusFor(x) {
  if (x.ahead > 0 && x.behind === 0) return "ready";
  if (x.ahead > 0 && x.behind > 0) return "diverged";
  return "idle";
}
const STATUS_LABEL = { ready: "Ready", diverged: "Diverged", idle: "Up to date" };

// ArchitectsSection lists active architect branches and lets you combine one
// into main or discard it. On a clean merge the branch is pruned and the graph
// reloads; on hard conflicts a modal asks keep-main / keep-architect per
// conflict. The list refreshes live via the project SSE subscription, and a
// 30 s tick keeps the relative timestamps fresh.
let archTick = null;
function ArchitectsSection(proj, reload) {
  const merging = van.state(null);   // { id, conflicts, choices } when resolving
  const aborting = van.state(null);  // id with a pending discard confirm
  const now = van.state(Date.now());
  // The list itself is shared module state, loaded by the workspace and kept
  // live by the SSE subscription; we just render it. A slow clock keeps the
  // relative timestamps fresh while the panel is open.
  if (archTick) clearInterval(archTick);
  archTick = setInterval(() => (now.val = Date.now()), 30000);

  const combine = async (id) => {
    const { status, data } = await api.architects.merge(proj, id);
    if (status === 200) { toast(`Combined ${id} into main`); loadArchitects(proj); reload(); return; }
    if (status === 409 && data.conflicts) { merging.val = { id, conflicts: data.conflicts, choices: {} }; return; }
    toast(data.error || `Combine failed (${status})`, true);
  };

  const doAbort = async (id) => {
    aborting.val = null;
    try { await api.architects.abort(proj, id); toast(`Discarded ${id}'s branch`); loadArchitects(proj); reload(); }
    catch (e) { toast(e.message || "Discard failed", true); }
  };

  return () => {
    const a = architectsList.val;
    // While the architects list is loading, keep a live (hidden) placeholder
    // so VanJS keeps this function bound and re-runs it when list arrives —
    // returning null would drop the binding and the panel would never appear.
    if (a === null) return span({ style: "display:none" });
    if (sessionUser.val === null && a.length === 0) return null;
    const n = now.val;
    const recent = a.some((x) => { const t = new Date(x.when).getTime(); return !Number.isNaN(t) && (n - t) < 90000; });
    const head = div({ class: "architects-head" },
      h5("Architects"),
      a.length > 0 ? span({ class: "count-badge" }, String(a.length)) : null,
      recent ? span({ class: "live-dot", title: "Someone is active right now" }, span({ class: "live-dot-pulse" }), "live") : null,
    );
    const rows = a.length === 0
      ? p({ class: "cl-empty" }, "No concurrent architects right now. Edits you make land on your own branch.")
      : div({ class: "architect-list" },
          a.map((x) => {
            const st = statusFor(x);
            const name = x.name || x.id;
            return div({ class: "architect-row" },
              div({ class: "architect-head" },
                div({ class: "architect-id", title: `branch: ${x.id}` },
                  span({ class: "architect-initial" }, (name[0] || "?").toUpperCase()),
                  span({ class: "architect-name" }, name),
                  span({ class: "architect-arch" }, x.id),
                ),
                div({ class: "architect-head-right" },
                  span({ class: `architect-status ${st}`, title: `${x.ahead} ahead · ${x.behind} behind main` }, STATUS_LABEL[st]),
                ),
              ),
              div({ class: "architect-meta" },
                span({ class: "architect-msg", title: x.message || "" }, x.message || "no commits yet"),
                x.last_commit ? span({ class: "architect-hash" }, `#${x.last_commit}`) : null,
                span({ class: "architect-when", title: x.when ? new Date(x.when).toLocaleString() : "" }, relativeTime(x.when, n)),
                span({ class: "architect-ab", title: "commits ahead / behind main" }, `+${x.ahead} / −${x.behind}`),
              ),
              div({ class: "architect-actions" },
                button({ class: "btn ghost small", disabled: x.ahead === 0, title: x.ahead === 0 ? "Nothing to combine yet" : `Combine ${x.id} into main`, onclick: () => combine(x.id) }, "Combine"),
                aborting.val === x.id
                  ? span({ class: "abort-confirm" },
                      button({ class: "btn ghost small danger", title: `Permanently discard ${x.id}'s branch`, onclick: () => doAbort(x.id) }, "Confirm discard"),
                      button({ class: "btn ghost small", onclick: () => (aborting.val = null) }, "Cancel"),
                    )
                  : button({ class: "btn ghost small", title: `Discard ${x.id}'s branch`, onclick: () => (aborting.val = x.id) }, "Discard"),
              ),
            );
          }),
        );
    return div({ class: "analysis-section architects-section", style: "margin-top:14px" },
      head,
      rows,
      MergeModal(merging, applyResolutionsFor(merging, proj, reload)),
    );
  };
}

// applyResolutionsFor returns the apply handler bound to the current merge
// state, used by MergeModal's Combine button.
function applyResolutionsFor(merging, proj, reload) {
  return async () => {
    const m = merging.val;
    if (!m) return;
    const resolutions = { ...m.choices };
    const { status, data } = await api.architects.merge(proj, m.id, resolutions);
    if (status === 200) { toast(`Combined ${m.id} into main`); merging.val = null; loadArchitects(proj); reload(); return; }
    toast(data.error || "Resolve all conflicts to combine", true);
  };
}

// MergeModal renders a per-conflict keep-main / keep-architect chooser when a
// combine hits hard conflicts.
function MergeModal(merging, onApply) {
  return () => {
    const m = merging.val;
    if (!m) return null;
    const key = (c) => `${c.file}:${c.id}`;
    const setChoice = (c, val) => { merging.val = { ...m, choices: { ...m.choices, [key(c)]: val } }; };
    const canApply = Object.keys(m.choices).length === m.conflicts.length;
    return div({ class: "merge-modal-overlay", onclick: (e) => { if (e.target.classList?.contains("merge-modal-overlay")) merging.val = null; } },
      div({ class: "merge-modal", role: "dialog", "aria-label": "Resolve conflicts" },
        div({ class: "merge-modal-head" }, h5("Resolve conflicts"), button({ class: "btn ghost small", onclick: () => (merging.val = null) }, "✕")),
        p({ class: "cl-empty" }, "Both sides changed some of the same things. Pick which version to keep for each."),
        div({ class: "conflict-list" },
          m.conflicts.map((c) => div({ class: "conflict-row" },
            div({ class: "conflict-what" }, `${c.file} · ${c.id} · ${c.kind}`),
            div({ class: "conflict-choices" },
              button({ class: () => "choice" + (m.choices[key(c)] === "ours" ? " active" : ""), onclick: () => setChoice(c, "ours") }, "Keep main"),
              button({ class: () => "choice" + (m.choices[key(c)] === "theirs" ? " active" : ""), onclick: () => setChoice(c, "theirs") }, "Keep architect"),
            ),
          )),
        ),
        div({ class: "form-actions", style: "display:flex;gap:8px;justify-content:flex-end;margin-top:10px" },
          button({ class: "btn ghost", onclick: () => (merging.val = null) }, "Cancel"),
          button({ class: "btn primary", disabled: () => !canApply, onclick: onApply }, "Combine"),
        ),
      ),
    );
  };
}
