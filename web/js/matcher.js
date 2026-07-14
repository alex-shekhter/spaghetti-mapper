// Shared filter/search matching over a graph payload, used by the D3 canvas,
// the matrix view, and the rail lists so they always agree on what matches.
//
// Filter shape: { q, scope, statuses, timings, needs, systems, flow }
//  - facets (statuses/timings/needs) are SETS of selected values; an
//    empty/missing set means "no constraint" (matches everything). status and
//    timing match by equality; need matches if the stream carries ANY of the
//    selected needs.
//  - systems is a SET of system ids. When non-empty it carves out an induced
//    sub-graph: a stream matches only if BOTH endpoints are in the set, and a
//    system matches iff its id is in the set. This is the "work with just
//    these N systems" control.
//  - flow stays single-valued: it is a focus control (drives stage overlays),
//    not a regular facet, so only one flow is focused at a time.
//  - the text query matches according to scope:
//      all      — stream text (name, api, format, endpoint system/entity/field
//                 names) or system text (name, description, catalog)
//      systems  — system name/description; a stream matches when either of
//                 its endpoint systems matches (neighborhood view)
//      streams  — the stream's own name / api type / data format
//      entities — entity names; streams match via referenced entities
//      fields   — field names; streams match via the fields they carry
//                 (explicit field list, or all fields of their entities
//                 when fields_mode is "all")

export function buildMatcher(data) {
  const flowStreams = new Map((data.flows ?? []).map((f) => [f.id, new Set((f.steps ?? []).map((s) => s.stream_id))]));
  const entName = new Map();
  const fldName = new Map();
  for (const s of data.systems) {
    for (const e of s.entities ?? []) {
      entName.set(e.id, e.name);
      for (const f of e.fields ?? []) fldName.set(f.id, f.name);
    }
  }
  const sysById = new Map(data.systems.map((s) => [s.id, s]));
  const low = (parts) => parts.filter(Boolean).join(" ").toLowerCase();

  // per-system texts, by scope
  const sysText = new Map(data.systems.map((s) => {
    const ents = (s.entities ?? []).map((e) => e.name);
    const flds = (s.entities ?? []).flatMap((e) => (e.fields ?? []).map((f) => f.name));
    return [s.id, {
      systems: low([s.name, s.description]),
      entities: low(ents),
      fields: low(flds),
      all: low([s.name, s.description, ...ents, ...flds]),
    }];
  }));

  // fields a stream endpoint actually carries
  const carriedFieldNames = (ep) => {
    if (ep.fields_mode === "list") return (ep.field_ids ?? []).map((id) => fldName.get(id));
    if (ep.fields_mode === "all") {
      const sys = sysById.get(ep.system_id);
      return (sys?.entities ?? [])
        .filter((e) => (ep.entity_ids ?? []).includes(e.id))
        .flatMap((e) => (e.fields ?? []).map((f) => f.name));
    }
    return [];
  };

  // per-stream texts, by scope
  const stText = new Map(data.streams.map((st) => {
    const eps = [st.source, st.destination];
    const own = [st.name, st.api_type, st.data_format];
    const sysNames = eps.map((ep) => sysById.get(ep.system_id)?.name);
    const ents = eps.flatMap((ep) => (ep.entity_ids ?? []).map((id) => entName.get(id)));
    const flds = eps.flatMap(carriedFieldNames);
    return [st.id, {
      streams: low(own),
      systems: low(sysNames), // stream matches "systems" scope via its endpoints
      entities: low(ents),
      fields: low(flds),
      all: low([...own, ...sysNames, ...ents, ...flds]),
    }];
  }));

  const norm = (f) => (f.q ?? "").trim().toLowerCase();
  const scopeOf = (f) => f.scope || "all";
  // empty/missing Set = no constraint; otherwise require membership.
  const setOk = (s, v) => !s?.size || s.has(v);
  const setAny = (s, ids) => !s?.size || (ids ?? []).some((id) => s.has(id));

  return {
    entName: (id) => entName.get(id) ?? "(deleted)",
    fldName: (id) => fldName.get(id) ?? "(deleted)",
    active: (f) => !!(norm(f) || f.flow || f.statuses?.size || f.timings?.size || f.needs?.size || f.systems?.size),
    facets: (st, f) =>
      setOk(f.statuses, st.status) &&
      setOk(f.timings, st.timing) &&
      setAny(f.needs, st.biz_need_ids) &&
      (!f.flow || (flowStreams.get(f.flow)?.has(st.id) ?? false)),
    // Is this system in the chosen subset? (Empty set = no subset constraint.)
    systemInSet(sysId, f) {
      return !f.systems?.size || f.systems.has(sysId);
    },
    streamMatches(st, f) {
      if (!this.facets(st, f)) return false;
      // induced sub-graph on the chosen systems: both endpoints must be in the set
      if (f.systems?.size &&
          !(f.systems.has(st.source.system_id) && f.systems.has(st.destination.system_id)))
        return false;
      const q = norm(f);
      if (!q) return true;
      return (stText.get(st.id)?.[scopeOf(f)] ?? "").includes(q);
    },
    // Does the system itself match the query (independent of its streams)?
    systemDirect(sysId, f) {
      const q = norm(f);
      if (!q) return false;
      const scope = scopeOf(f);
      if (scope === "streams") return false; // systems only match via streams
      return (sysText.get(sysId)?.[scope] ?? "").includes(q);
    },
    // A system "matches" if it matches the query directly or any of its
    // streams (facet-checked) matches. The systems subset, when active, is an
    // explicit visibility gate: in = visible, out = not matched — so picking
    // 5 of 30 systems shows exactly those 5, with the others dimmed/hidden per
    // the Dim/Hide mode. Other facets still filter the streams among them.
    systemMatches(sys, f, streams) {
      if (!this.active(f)) return true;
      if (f.systems?.size) return this.systemInSet(sys.id, f);
      if (this.systemDirect(sys.id, f)) return true;
      return streams.some((st) =>
        (st.source.system_id === sys.id || st.destination.system_id === sys.id) &&
        this.streamMatches(st, f));
    },
  };
}
