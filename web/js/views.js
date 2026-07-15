import { api } from "./api.js";
import { createGraph } from "./graph.js";
import { FilteredView } from "./view.js";
import { analyze, flowShape, flowImpliedNeeds, deriveStages } from "./analysis.js";
import { Dropdown, MultiDropdown, placePanel } from "./ui.js";

const van = window.van;
const {
  a, button, div, form, h1, h3, h4, h5,
  input, label, p, span,
} = van.tags;

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

export function toast(msg, isError = false) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "show" + (isError ? " error" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = ""), 3200);
}

const busy = async (fn) => {
  try {
    await fn();
  } catch (e) {
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

  const ProjectCard = (proj) =>
    div(
      { class: "project-card", onclick: () => go(`/p/${encodeURIComponent(proj.name)}`) },
      h3(proj.name),
      p(proj.description || "No description yet."),
      div({ class: "card-actions" },
        button({
          class: "btn ghost small danger",
          onclick: (e) => {
            e.stopPropagation();
            if (!confirm(`Delete project "${proj.name}"? (It moves to the trash folder, recoverable by hand.)`)) return;
            busy(async () => {
              await api.projects.del(proj.name);
              toast(`Project "${proj.name}" moved to trash`);
              reload();
            });
          },
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

  return div({ class: "home" },
    div({ class: "brand" }, logoSVG(40), h1("Spaghetti", van.tags.b("Mapper"))),
    p({ class: "tagline" },
      "Document the integrations you have, see the tangle you built, and decide which strands to cut."),
    div({ style: "display:flex;align-items:baseline;gap:14px" },
      van.tags.h2("Projects"),
      button({ class: "btn ghost small", style: "margin-bottom:14px", onclick: importProject }, "Import project file…"),
    ),
    () => {
      const list = projects.val;
      if (list === null) return div({ class: "empty-note" }, "Loading…");
      return div({ class: "project-grid" },
        list.map(ProjectCard),
        creating.val
          ? div({ class: "new-project" }, h3("New project"), NewProjectForm())
          : div({ class: "new-project", style: "display:flex;align-items:center;justify-content:center;cursor:pointer;min-height:120px", onclick: () => (creating.val = true) },
              span({ style: "color:var(--ink-2)" }, "+ New project")),
      );
    },
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
            span({ class: "cl-meta" }, `${(e.fields ?? []).length} fields`),
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
  const filters = {
    q: van.state(""), scope: van.state("all"),
    statuses: van.state(new Set()), timings: van.state(new Set()),
    needs: van.state(new Set()), systems: van.state(new Set()),
    flow: van.state(""),
  };
  const mode = van.state("dim");
  const view = van.state("graph"); // graph | matrix
  const expand = van.state(false); // Bundle (aggregated strands) vs Expand (one curve per stream)
  const fanSpacing = van.state(34); // px between parallel strands in Expand mode (per-project pref)
  const showProject = van.state(false); // Project panel drawer open?

  const reload = () => busy(async () => {
    const g = await api.graph(proj);
    // seed per-project display prefs once, from the saved display.json (via
    // the graph payload). Don't clobber the user's in-session choice on later
    // reloads (e.g. after editing a system).
    if (!data.val) {
      expand.val = !!g.display?.expand;
      fanSpacing.val = g.display?.fan_spacing ? Math.max(12, Math.min(80, g.display.fan_spacing)) : 34;
    }
    data.val = g;
  });
  reload();

  // Persist display prefs (debounced) — mirrors layout save.
  let displayTimer = null;
  const saveDisplay = () => {
    clearTimeout(displayTimer);
    displayTimer = setTimeout(() =>
      api.saveDisplay(proj, { expand: expand.val, fan_spacing: fanSpacing.val }).catch(() => {}),
      500);
  };

  const filterVals = () => ({
    q: filters.q.val, scope: filters.scope.val,
    statuses: filters.statuses.val, timings: filters.timings.val,
    needs: filters.needs.val, systems: filters.systems.val,
    flow: filters.flow.val,
  });
  // THE filtering entry point: every surface builds its view here and asks
  // it what is visible — filter semantics live in FilteredView alone.
  const filteredView = () => new FilteredView(data.val, filterVals(), mode.val);

  const sysName = (id) => data.val?.systems.find((s) => s.id === id)?.name ?? "(deleted system)";
  const needNames = (ids) => (ids ?? []).map((id) => data.val?.needs.find((n) => n.id === id)?.name).filter(Boolean);

  // ---- graph canvas ----
  const canvasEl = div({ class: "canvas-wrap" });
  const graph = createGraph(canvasEl, {
    onSelect: (sel) => (selection.val = sel),
    onLayoutChange: (layout) => api.saveLayout(proj, layout).catch(() => {}),
  });

  van.derive(() => {
    if (data.val) graph.setData(data.val);
  });
  van.derive(() => {
    graph.setFilter(filterVals(), mode.val);
  });
  van.derive(() => graph.setSelection(selection.val));
  van.derive(() => graph.setExpand(expand.val));
  van.derive(() => graph.setFanSpacing(fanSpacing.val));
  // Persist display prefs whenever they change (debounced).
  van.derive(() => { expand.val; saveDisplay(); });
  van.derive(() => { fanSpacing.val; saveDisplay(); });

  // ---- matrix view (same data, same FilteredView, different lens) ----
  const matrixView = () => {
    const d = data.val;
    if (view.val !== "matrix" || !d) return span({ style: "display:none" });
    const V = filteredView();
    const systems = [...d.systems].sort((x, y) => x.name.localeCompare(y.name));
    const cellStreams = (src, dst) => V.partition(
      d.streams.filter((st) => st.source.system_id === src.id && st.destination.system_id === dst.id)).matched;
    const { table, thead, tbody, tr, th, td } = van.tags;
    return div({ class: "matrix-wrap" },
      p({ class: "matrix-note" }, "Rows send, columns receive. Cell = matching streams; click to dig in."),
      table({ class: "matrix" },
        thead(tr(th({ class: "corner" }, "src \\ dst"), systems.map((s) => th({ class: "col-head" }, span(s.name))))),
        tbody(systems.map((src) =>
          tr(
            th({ class: "row-head" }, src.name),
            systems.map((dst) => {
              const streams = cellStreams(src, dst);
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
    );
  };
  van.add(canvasEl, matrixView);
  van.derive(() => canvasEl.classList.toggle("matrix-mode", view.val === "matrix"));

  // Esc closes the inspector (one live handler across route changes)
  if (window._smKeyHandler) document.removeEventListener("keydown", window._smKeyHandler);
  window._smKeyHandler = (e) => {
    if (e.key === "Escape") { selection.val = null; showProject.val = false; }
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

  const remove = (kind, item, guardMsg) => {
    if (!confirm(guardMsg ?? `Delete "${item.name}"? (It moves to the project trash.)`)) return;
    busy(async () => {
      await api[kind].del(proj, item.id);
      if (selection.val) selection.val = null;
      toast("Deleted (recoverable from the project's .trash folder)");
      reload();
    });
  };

  // ---- rail lists ----
  const SystemItem = (s) => {
    const ents = (s.entities ?? []).length;
    const flds = (s.entities ?? []).reduce((n, e) => n + (e.fields ?? []).length, 0);
    return div({ class: "entity-item" },
      div({ class: "ei-head" },
        span({ class: `type-dot ${s.type || "unknown"}` }),
        span({ class: "ei-name" }, s.name, " ", provChip(s)),
        div({ class: "ei-actions" },
          button({ class: "btn ghost small", onclick: () => (editing.val = { kind: "systems", item: s }) }, "Edit"),
          button({ class: "btn ghost small danger", onclick: () => {
            const used = data.val.streams.filter((st) => st.source.system_id === s.id || st.destination.system_id === s.id).length;
            remove("systems", s, used
              ? `"${s.name}" is used by ${used} stream(s). Deleting it also deletes those streams (all recoverable from trash). Continue?`
              : `Delete system "${s.name}"? (Recoverable from trash.)`);
          } }, "Del"),
        ),
      ),
      s.description ? div({ class: "ei-sub" }, s.description) : null,
      ents ? div({ class: "ei-sub" }, `${ents} entit${ents === 1 ? "y" : "ies"} · ${flds} field(s)`) : null,
    );
  };

  const StreamItem = (st) =>
    div({ class: "entity-item" },
      div({ class: "ei-head" },
        span({ class: "ei-name" }, st.name, " ", provChip(st)),
        div({ class: "ei-actions" },
          button({ class: "btn ghost small", onclick: () => (editing.val = { kind: "streams", item: st }) }, "Edit"),
          button({ class: "btn ghost small danger", onclick: () => remove("streams", st) }, "Del"),
        ),
      ),
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
          button({ class: "btn ghost small", onclick: () => (editing.val = { kind: "needs", item: n }) }, "Edit"),
          button({ class: "btn ghost small danger", onclick: () => {
            const used = data.val.streams.filter((st) => (st.biz_need_ids ?? []).includes(n.id)).length;
            remove("needs", n, used
              ? `"${n.name}" groups ${used} stream(s). They will simply lose this need. Continue?`
              : `Delete business need "${n.name}"?`);
          } }, "Del"),
        ),
      ),
      n.description ? div({ class: "ei-sub" }, n.description) : null,
      div({ class: "ei-sub" }, `${data.val.streams.filter((st) => (st.biz_need_ids ?? []).includes(n.id)).length} stream(s)`),
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
          button({ class: "btn ghost small", title: "Open the flow inspector and focus it on the map", onclick: () => { selection.val = { type: "flow", id: fl.id }; filters.flow.val = fl.id; } }, "Show"),
          button({ class: "btn ghost small", onclick: () => (editing.val = { kind: "flows", item: fl }) }, "Edit"),
          button({ class: "btn ghost small danger", onclick: () => remove("flows", fl) }, "Del"),
        ),
      ),
      fl.description ? div({ class: "ei-sub" }, fl.description) : null,
      div({ class: "ei-sub" },
        `${(fl.steps ?? []).length} hop(s) · ${shape.stages.length} stage(s)`,
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
          : StreamForm({ proj, item: ed.item, systems: d.systems, needs: d.needs, onSave: (v) => save("streams", v), onCancel: () => (editing.val = null) }))
      : null;

    const addLabel = { systems: "+ Add system", streams: "+ Add stream", needs: "+ Add business need", flows: "+ Add flow" }[kind];
    const addBtn = formEl ? null
      : kind === "streams" && d.systems.length < 1
        ? div({ class: "empty-note" }, "Add a system first — a stream connects systems.")
      : kind === "flows" && d.streams.length < 1
        ? div({ class: "empty-note" }, "Add streams first — a flow strings existing streams together.")
        : button({ class: "btn rail-add", onclick: () => (editing.val = { kind }) }, addLabel);

    // rail lists come straight from the shared view — same logic as canvas
    const all = { systems: d.systems, streams: d.streams, needs: d.needs, flows: d.flows }[kind];
    const filtered = { systems: () => V.systems(), streams: () => V.streams(), needs: () => V.needs(), flows: () => V.flows() }[kind]();

    const items = filtered.map({ systems: SystemItem, streams: StreamItem, needs: NeedItem, flows: FlowItem }[kind]);
    const shownNote = filtered.length !== all.length
      ? div({ class: "shown-note" }, `${filtered.length} of ${all.length} match the filter`)
      : null;
    const empty = all.length ? null : div({ class: "empty-note" },
      { systems: "No systems yet. Systems are the boxes on your map.",
        streams: "No streams yet. Streams are the data flows between systems.",
        needs: "No business needs yet. Use them to group streams by why they exist.",
        flows: "No flows yet. A flow is an end-to-end journey: pick the streams a piece of data travels through." }[kind]);

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
  // Compact "3 ent · all 5 fld" style summary used in the always-visible line.
  const epSummary = (ep) => {
    const { entN, fldN, mode } = epCounts(ep);
    const fldStr = mode === "all" ? `all ${fldN}` : mode === "unknown" || mode == null ? "?" : String(fldN);
    return `${entN} ent · ${fldStr} fld`;
  };
  const kv = (k, v) => div({ class: "sc-kv" }, span({ class: "sc-kv-k" }, k), span({ class: "sc-kv-v" }, v || "—"));

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
      return div({ class: "sc-ep" },
        div({ class: "sc-ep-head" },
          span({ class: "sc-ep-sys", title: sysNm }, sysNm),
          span({ class: "sc-ep-count" }, label),
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
        div({ class: "sc-summary" },
          span(sysName(st.source.system_id)), " ", span({ class: "arrow" }, arrow), " ",
          span(sysName(st.destination.system_id)), "  ·  ",
          span(epSummary(st.source)), " ", span({ class: "arrow" }, arrow), " ", span(epSummary(st.destination))),
      ),
      collapsed ? null : div({ class: "sc-body" },
        div({ class: "sc-eps" },
          epColumn(st.source, "source", "src"),
          div({ class: "sc-arrow" }, arrow),
          epColumn(st.destination, "destination", "dst"),
        ),
        div({ class: "sc-contract" },
          kv("Timing", st.timing),
          kv("API type", st.api_type),
          kv("Format", st.data_format),
        ),
        needs.length
          ? div({ class: "sc-needs" },
              h5({ class: "insp-h", style: "margin-bottom:3px" }, "Needs"),
              needs.map((n) => span({ class: "chip" }, n)))
          : null,
        div({ class: "sc-actions" },
          button({ class: "btn ghost small", onclick: (ev) => { ev.stopPropagation(); tab.val = "streams"; editing.val = { kind: "streams", item: st }; } }, "Edit stream"),
        ),
      ),
    );
  };

  // ---- analysis panel ----
  const justifyField = (row, needId, on) => busy(async () => {
    const sys = data.val.systems.find((s) => s.id === row.sys.id);
    const fld = sys?.entities.find((e) => e.id === row.ent.id)?.fields.find((f) => f.id === row.fld.id);
    if (!fld) return;
    const set = new Set(fld.biz_need_ids ?? []);
    on ? set.add(needId) : set.delete(needId);
    fld.biz_need_ids = [...set];
    await api.systems.update(proj, sys.id, sys);
    toast(on ? "Justified" : "Justification removed");
    reload();
  });

  const analysisBody = (d) => {
    const A = analyze(d);
    const stat = (label, val) => div({ class: "stat-line" }, span(label), van.tags.b(val));
    const justifyRow = (row) =>
      div({ class: "arow" },
        div({ class: "arow-head" },
          span({ class: "mono", style: "color:var(--ink-3)" }, `${row.sys.name} · ${row.ent.name} · `),
          van.tags.b(row.fld.name),
          row.fld.type ? span({ class: "cl-meta" }, row.fld.type) : null,
        ),
        div({ class: "arow-moved" }, "in motion via ", row.movedBy.map((s) => s.name).join(", ")),
        d.needs.length
          ? div({ class: "arow-needs" },
              d.needs.map((n) => label(
                input({
                  type: "checkbox", checked: (row.fld.biz_need_ids ?? []).includes(n.id),
                  oninput: (ev) => justifyField(row, n.id, ev.target.checked),
                }),
                span(n.name))))
          : div({ class: "cl-empty" }, "Define business needs to justify fields."),
      );

    return [
      div({ class: "analysis-section" },
        h5("Documentation coverage"),
        stat("Systems with a catalog", `${A.systemsWithCatalog} / ${d.systems.length}`),
        stat("Fields typed", `${A.typedFields} / ${A.totalFields}`),
        stat("Fields justified by a need", `${A.justifiedFields} / ${A.totalFields}`),
        stat("Streams with a business need", `${A.streamsWithNeeds} / ${d.streams.length}`),
        p({ class: "cl-empty", style: "margin-top:6px" },
          "Conclusions below only cover what's documented — absent facts are gaps, not truths."),
      ),
      div({ class: "analysis-section" },
        h5(`Unjustified data in motion (${A.movedUnjustified.length})`),
        A.movedUnjustified.length
          ? [p({ class: "cl-empty" }, "These fields move between systems, but no business need justifies them — candidates to cut or to document."),
             A.movedUnjustified.map(justifyRow)]
          : p({ class: "cl-empty" }, A.moved.length
              ? "Every moving field is justified. Clean plate."
              : "No field-level movement documented yet — pick entities/fields on your streams to enable this analysis."),
      ),
      A.movedJustified.length
        ? van.tags.details({ class: "analysis-section" },
            van.tags.summary(`Justified data in motion (${A.movedJustified.length})`),
            A.movedJustified.map(justifyRow))
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
    if (sel.type === "analysis") {
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
      sub = `${shape.streams.length} hop${shape.streams.length === 1 ? "" : "s"} · ${shape.stages.length} stage${shape.stages.length === 1 ? "" : "s"}`;
      body = [
        fl.description ? p({ style: "color:var(--ink-2);margin-bottom:10px" }, fl.description) : null,
        div({ style: "display:flex;gap:8px;margin-bottom:12px" },
          button({
            class: () => "btn small" + (filters.flow.val === fl.id ? " primary" : ""),
            onclick: () => (filters.flow.val = filters.flow.val === fl.id ? "" : fl.id),
          }, () => (filters.flow.val === fl.id ? "Focused on map ✓" : "Focus on map")),
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
    } else {
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
              div({ class: "coverage", style: "margin-bottom:4px" }, van.tags.b(`${ents.length}`), ` entit${ents.length === 1 ? "y" : "ies"} · `, van.tags.b(`${typed}/${flds}`), " fields typed"),
              ents.map((e) => div({ class: "ei-sub" }, `${e.name} (${(e.fields ?? []).length} fields)`, " ", provChip(e))))
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
    }

    return div({
      class: "inspector",
      style: () => `width:${inspWidth.val}px;flex:none`,
    },
      div({ class: "inspector-head" },
        h3(title), span({ class: "sub" }, sub),
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
  // A slim row above the canvas holding the live view controls: lens
  // (Graph/Matrix), how unmatched items are treated (Dim/Hide), and edge
  // rendering (Bundle/Expand). These are switch-while-working controls, so
  // they stay one click away here rather than buried in the project drawer.
  // The drawer keeps the *persisted* Bundle/Expand + spacing defaults; this
  // row binds to the same state, so toggling here updates the project too.
  const ctoolGroup = (label, title, opts) =>
    div({ class: "ctool", title },
      span({ class: "ctool-label" }, label),
      div({ class: "mode-toggle" },
        opts.map(([txt, active, onClick]) =>
          button({ class: () => active() ? "active" : "", onclick: onClick }, txt)),
      ),
    );

  const canvasToolbar = () =>
    div({ class: "canvas-toolbar" },
      ctoolGroup("Lens", "Lens: force-directed map or system×system matrix", [
        ["Graph", () => view.val === "graph", () => (view.val = "graph")],
        ["Matrix", () => view.val === "matrix", () => (view.val = "matrix")],
      ]),
      ctoolGroup("Unmatched", "How unmatched items are treated: dimmed in place, or removed from the map", [
        ["Dim", () => mode.val === "dim", () => (mode.val = "dim")],
        ["Hide", () => mode.val === "hide", () => (mode.val = "hide")],
      ]),
      ctoolGroup("Edges", "Edges: one aggregated strand per connection (width = stream count), or one curve per stream fanned out parallel — handy for busy connections and flow focus", [
        ["Bundle", () => !expand.val, () => (expand.val = false)],
        ["Expand", () => expand.val, () => (expand.val = true)],
      ]),
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
    const onKeys = (e) => {
      if (e.key === "Escape" && open.val) { e.stopPropagation(); e.preventDefault(); close(); btn.focus(); }
      if ((e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") && !open.val) { e.preventDefault(); toggle(); }
    };
    btn = button({
      type: "button", class: "btn export-btn", title: "Download the map as an SVG image or the whole project as a shareable JSON file",
      onclick: toggle, onkeydown: onKeys,
    }, "Export", span({ class: "proj-caret" }, "▾"));
    panel = div(
      { class: "dd-panel export-panel", style: () => (open.val ? "" : "display:none"), onkeydown: onKeys },
      button({ type: "button", class: "dd-opt", onclick: doSVG },
        span({ class: "dd-check" }, "▦"), span("SVG image")),
      button({ type: "button", class: "dd-opt", onclick: doJSON },
        span({ class: "dd-check" }, "{}"), span("Project JSON")),
    );
    root = div({ class: "dd export-dd", "data-dd": "Export" }, btn, panel);
    return root;
  })();

  const topbar = () =>
    div({ class: "topbar" },
      a({ class: "brand-mini", href: "#/" }, logoSVG(22), "SpaghettiMapper"),
      button({
        class: () => "proj-name" + (showProject.val ? " active" : ""),
        title: "Project settings — description and canvas display preferences",
        onclick: () => (showProject.val = !showProject.val),
      }, proj, span({ class: "proj-caret" }, "▾")),
      span({ class: "spacer" }),
      div({ class: "filters" },
        span({ class: "flabel" }, "Filter"),
        searchBox,
        scopeSelect,
        MultiDropdown({
          state: filters.systems, title: "Systems", searchable: true,
          options: () => (data.val?.systems ?? []).map((s) => [s.id, s.name]),
        }),
        multiFilterSelect(filters.statuses, "Status", () => [["planned", "planned"], ["implemented", "implemented"], ["unknown", "unknown"]]),
        multiFilterSelect(filters.timings, "Timing", () => [["real-time", "real-time"], ["scheduled", "scheduled"]]),
        multiFilterSelect(filters.needs, "Need", () => (data.val?.needs ?? []).map((n) => [n.id, n.name]), true),
        filterSelect(filters.flow, "Flow", () => (data.val?.flows ?? []).map((fl) => [fl.id, fl.name])),
      ),
      button({
        class: () => "btn" + (selection.val?.type === "analysis" ? " primary" : ""),
        title: "Coverage stats and unjustified data in motion",
        onclick: () => (selection.val = selection.val?.type === "analysis" ? null : { type: "analysis" }),
      }, "Analysis"),
      exportMenu,
    );

  // ---- project panel (drawer) ----
  // A left-side drawer overlaying the rail; the canvas stays visible to the
  // right so the fan-spacing slider previews live. Holds project metadata
  // plus the per-project canvas display prefs (Bundle/Expand + spacing).
  const saveDescription = (description) => busy(async () => {
    await api.projects.update(proj, { name: proj, description: description.trim() });
    toast("Project saved");
    reload();
  });

  const projectPanel = () => {
    if (!showProject.val || !data.val) return span({ style: "display:none" });
    try {
      const pr = data.val.project;
      return div({ class: "project-drawer-overlay", onclick: (e) => { if (e.target.classList?.contains("project-drawer-overlay")) showProject.val = false; } },
        div({ class: "project-drawer", role: "dialog", "aria-label": "Project settings" },
          div({ class: "project-drawer-head" },
            h3("Project"),
            button({ class: "btn ghost small", title: "Close", onclick: () => (showProject.val = false) }, "✕"),
          ),
          div({ class: "inspector-body" },
            field("Name", input({ type: "text", value: pr.name, disabled: true, title: "Rename via the project folder on disk" })),
            field("Description", input({
              type: "text", value: pr.description ?? "",
              placeholder: "What map is this?",
              onchange: (e) => saveDescription(e.target.value),
            })),
            div({ class: "analysis-section", style: "margin-top:14px" },
              h5("Canvas"),
              field("Edges", div({ class: "mode-toggle", title: "Bundle: one aggregated strand per connection (width = stream count). Expand: one curve per stream, fanned out parallel." },
                button({ class: () => (expand.val ? "" : "active"), onclick: () => (expand.val = false) }, "Bundle"),
                button({ class: () => (expand.val ? "active" : ""), onclick: () => (expand.val = true) }, "Expand"),
              )),
              field("Arc spacing", div({ class: "fan-spacing", title: "Gap between parallel strands in Expand mode" },
                input({
                  type: "range", min: "12", max: "80", step: "2", value: fanSpacing.val,
                  oninput: (e) => (fanSpacing.val = +e.target.value),
                }),
                span({ class: "fan-spacing-val" }, () => `${fanSpacing.val}px`),
              )),
              p({ class: "cl-empty", style: "margin-top:6px" }, "The Bundle/Expand choice and arc spacing are saved per project and travel with exports."),
            ),
          ),
        ),
      );
    } catch (err) {
      return div({ class: "project-drawer", style: "padding:14px;color:#e0623c" }, "PANEL ERR: " + (err && (err.stack || err.message)) + " | " + String(err));
    }
  };

  // ---- assemble ----
  return div({ class: "workspace" },
    topbar,
    div({ class: "body-split" },
      div({
        class: "rail",
        style: () => `width:${railWidth.val}px;flex:none`,
      },
        div({ class: "rail-tabs" },
          ["systems", "streams", "needs", "flows"].map((t) =>
            button({ class: () => (tab.val === t ? "active" : ""), onclick: () => { tab.val = t; } }, t)),
        ),
        div({ class: "rail-body" }, railBody),
      ),
      makeResizer(railWidth, "resizer--rail", "sm.railW"),
      div({ class: "canvas-col" }, canvasToolbar, canvasEl),
      inspectorHandle,
      inspector,
    ),
    projectPanel,
  );
}
