// Justification & coverage analysis over a graph payload.
//
// A field is "in motion" when a stream carries it: explicitly (fields_mode
// "list") or implicitly (fields_mode "all" over its entity). A moving field
// with no biz_need_ids is unjustified — nobody has said why that data moves.
// Analysis is honest about gaps: coverage numbers say how much of the map the
// conclusions are based on.

// deriveStages: BFS stage numbers (1-based, cycle-tolerant) from stream
// endpoints. Used to PREFILL stages when hops are added and for the
// "auto-number by topology" action — stored stages are the authority.
export function deriveStages(streams) {
  const out = new Map(); // systemId -> outgoing streams
  const indeg = new Map();
  const systems = new Set();
  for (const st of streams) {
    const a = st.source.system_id, b = st.destination.system_id;
    systems.add(a);
    systems.add(b);
    if (!out.has(a)) out.set(a, []);
    out.get(a).push(st);
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
    if (!indeg.has(a)) indeg.set(a, 0);
  }
  const stageOf = new Map(); // streamId -> stage
  const sysStage = new Map();
  const queue = [];
  for (const s of systems) if ((indeg.get(s) ?? 0) === 0) { sysStage.set(s, 0); queue.push(s); }
  const bfs = () => {
    while (queue.length) {
      const sys = queue.shift();
      for (const st of out.get(sys) ?? []) {
        if (stageOf.has(st.id)) continue;
        const stg = (sysStage.get(sys) ?? 0) + 1;
        stageOf.set(st.id, stg);
        const dst = st.destination.system_id;
        if (!sysStage.has(dst)) { sysStage.set(dst, stg); queue.push(dst); }
      }
    }
  };
  bfs();
  // pure cycles have no in-degree-0 root: seed from any unstaged stream
  for (const st of streams) {
    if (!stageOf.has(st.id)) {
      if (!sysStage.has(st.source.system_id)) sysStage.set(st.source.system_id, 0);
      queue.push(st.source.system_id);
      bfs();
    }
  }
  return stageOf;
}

// flowShape resolves a flow's hops with their EXPLICIT stages and derives
// diagnostics from topology: disconnected pieces, and hops whose declared
// stage contradicts the wiring (nothing earlier reaches their source).
export function flowShape(flow, data) {
  const hops = (flow.steps ?? [])
    .map((step) => ({ stream: data.streams.find((s) => s.id === step.stream_id), stage: Math.max(1, step.stage || 1) }))
    .filter((h) => h.stream);
  const streams = hops.map((h) => h.stream);

  const stageOf = new Map(hops.map((h) => [h.stream.id, h.stage]));

  // disconnected pieces (union-find over systems, undirected)
  const systems = new Set(streams.flatMap((st) => [st.source.system_id, st.destination.system_id]));
  const parent = new Map([...systems].map((s) => [s, s]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const st of streams) parent.set(find(st.source.system_id), find(st.destination.system_id));
  const components = new Set([...systems].map(find)).size;

  // order-vs-wiring check: a hop at stage > min should start where some
  // earlier hop ends (or where an earlier hop starts — shared source fan-out)
  const minStage = hops.length ? Math.min(...hops.map((h) => h.stage)) : 1;
  const orderWarnings = hops
    .filter((h) => h.stage > minStage)
    .filter((h) => !hops.some((o) => o.stage < h.stage &&
      (o.stream.destination.system_id === h.stream.source.system_id ||
       o.stream.source.system_id === h.stream.source.system_id)))
    .map((h) => h.stream);

  const stages = [];
  for (const h of hops) (stages[h.stage - 1] ??= []).push(h.stream);
  return {
    streams, stageOf, components, orderWarnings,
    stages: stages.map((s, i) => ({ n: i + 1, streams: s ?? [] })).filter((s) => s.streams.length),
  };
}

// Needs implied by a flow's streams (vs. the flow's own declared needs).
export function flowImpliedNeeds(flow, data) {
  const ids = new Set();
  for (const step of flow.steps ?? []) {
    const st = data.streams.find((s) => s.id === step.stream_id);
    for (const n of st?.biz_need_ids ?? []) ids.add(n);
  }
  return ids;
}

// AJ-1: ordered, deduped need suggestions for a finding row or group.
// Rank: stream (0) → flow (1) → cluster (2), then name A–Z. First source
// wins the chip title when a need appears via multiple paths. Excludes needs
// already on the first field (group members share the same need set when
// grouped). Returns the full list; UI shows at most 3 chips.
export function suggestNeeds(rows, data) {
  if (!rows?.length) return [];
  const exclude = new Set(rows[0].fld.biz_need_ids ?? []);
  const streamIds = new Set();
  for (const r of rows) for (const st of r.movedBy) streamIds.add(st.id);
  const sysIds = new Set(rows.map((r) => r.sys.id));
  const needById = new Map((data.needs ?? []).map((n) => [n.id, n]));
  const seen = new Set();
  const out = []; // { id, name, rank, title }

  const push = (nid, rank, title) => {
    if (!nid || exclude.has(nid) || seen.has(nid)) return;
    const n = needById.get(nid);
    if (!n) return;
    seen.add(nid);
    out.push({ id: nid, name: n.name, rank, title });
  };

  // 1. Carrying streams
  for (const r of rows) {
    for (const st of r.movedBy) {
      for (const nid of st.biz_need_ids ?? []) {
        push(nid, 0, `Suggested — stream "${st.name}" serves this need`);
      }
    }
  }
  // 2. Flows whose hops include a carrying stream → flow.biz_need_ids
  for (const fl of data.flows ?? []) {
    const hits = (fl.steps ?? []).some((s) => streamIds.has(s.stream_id));
    if (!hits) continue;
    for (const nid of fl.biz_need_ids ?? []) {
      push(nid, 1, `Suggested — flow "${fl.name}" serves this need`);
    }
  }
  // 3. Clusters containing the system
  for (const c of data.clusters ?? []) {
    if (!(c.system_ids ?? []).some((id) => sysIds.has(id))) continue;
    for (const nid of c.biz_need_ids ?? []) {
      push(nid, 2, `Suggested — cluster "${c.name}" serves this need`);
    }
  }

  out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return out;
}

// AJ-2: group key — same system, entity, and carrying-stream set.
export function findingGroupKey(row) {
  const streamIds = row.movedBy.map((s) => s.id).sort().join(",");
  return `${row.sys.id}\0${row.ent.id}\0${streamIds}`;
}

// Group rows that share findingGroupKey. Preserves analyze() traversal order
// of first appearance. Singleton groups keep one row (rendered ungrouped).
export function groupFindings(rows) {
  const order = [];
  const map = new Map(); // key -> { key, rows, sys, ent, movedBy }
  for (const row of rows) {
    const key = findingGroupKey(row);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        rows: [],
        sys: row.sys,
        ent: row.ent,
        movedBy: row.movedBy,
      };
      map.set(key, g);
      order.push(g);
    }
    g.rows.push(row);
  }
  return order;
}

// AJ-5: justified grouping also requires identical need sets.
export function justifiedGroupKey(row) {
  const needs = [...(row.fld.biz_need_ids ?? [])].sort().join(",");
  return `${findingGroupKey(row)}\0${needs}`;
}

export function groupJustifiedFindings(rows) {
  const order = [];
  const map = new Map();
  for (const row of rows) {
    const key = justifiedGroupKey(row);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        rows: [],
        sys: row.sys,
        ent: row.ent,
        movedBy: row.movedBy,
        needIds: [...(row.fld.biz_need_ids ?? [])],
      };
      map.set(key, g);
      order.push(g);
    }
    g.rows.push(row);
  }
  return order;
}

export function analyze(data) {
  const rows = []; // {sys, ent, fld, movedBy: [stream]}
  const rowByFieldID = new Map();
  let typed = 0;
  let justified = 0;

  for (const sys of data.systems) {
    for (const ent of sys.entities ?? []) {
      for (const fld of ent.fields ?? []) {
        if (fld.type) typed++;
        if ((fld.biz_need_ids ?? []).length) justified++;
        const row = { sys, ent, fld, movedBy: [] };
        rows.push(row);
        rowByFieldID.set(fld.id, row);
      }
    }
  }

  const sysByID = new Map(data.systems.map((s) => [s.id, s]));
  for (const st of data.streams) {
    for (const ep of [st.source, st.destination]) {
      let ids = [];
      if (ep.fields_mode === "list") {
        ids = ep.field_ids ?? [];
      } else if (ep.fields_mode === "all") {
        const sys = sysByID.get(ep.system_id);
        ids = (sys?.entities ?? [])
          .filter((e) => (ep.entity_ids ?? []).includes(e.id))
          .flatMap((e) => (e.fields ?? []).map((f) => f.id));
      }
      for (const id of ids) {
        const row = rowByFieldID.get(id);
        if (row && !row.movedBy.includes(st)) row.movedBy.push(st);
      }
    }
  }

  const moved = rows.filter((r) => r.movedBy.length);
  const clusters = data.clusters ?? [];
  const clustersWithNeeds = clusters.filter((c) => (c.biz_need_ids ?? []).length).length;
  return {
    totalFields: rows.length,
    typedFields: typed,
    justifiedFields: justified,
    moved,
    movedUnjustified: moved.filter((r) => !(r.fld.biz_need_ids ?? []).length),
    movedJustified: moved.filter((r) => (r.fld.biz_need_ids ?? []).length),
    streamsWithNeeds: data.streams.filter((st) => (st.biz_need_ids ?? []).length).length,
    systemsWithCatalog: data.systems.filter((s) => (s.entities ?? []).length).length,
    // GS-5: clusters can carry business needs at the coarsest grain.
    clustersWithNeeds,
    totalClusters: clusters.length,
  };
}
