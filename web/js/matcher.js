// Shared filter/search matching over a graph payload, used by the D3 canvas,
// the matrix view, and the rail lists so they always agree on what matches.
//
// Filter shape: { q, scope, statuses, timings, needs, systems, clusters, flow }
//  - facets (statuses/timings/needs) are SETS of selected values; an
//    empty/missing set means "no constraint" (matches everything). status and
//    timing match by equality; need matches if the stream carries ANY of the
//    selected needs OR (GS-5) a system is a member of a cluster that carries
//    the need.
//  - systems is a SET of system ids. clusters is a SET of cluster ids.
//    When either is non-empty they carve out an induced sub-graph: cluster
//    chips expand to the cluster's *current* members (live reference) and
//    union with plain system chips (GS-5 A1). A stream matches only if BOTH
//    endpoints are in the expanded set; a system matches iff its id is in
//    the set. Deleted/absent/empty cluster chips contribute nothing — with
//    no other "where" chips that dims/hides everything.
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
  const clusterById = new Map((data.clusters ?? []).map((c) => [c.id, c]));
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

  // GS-5 A1: expand cluster chips → current member system ids, union with
  // plain system chips. Unresolvable / empty clusters contribute nothing.
  // Returns { set, active } where active means the where-facet is on
  // (even when the expanded set is empty — dims/hides everything).
  function expandedSystems(f) {
    const hasSys = !!(f.systems?.size);
    const hasCl = !!(f.clusters?.size);
    if (!hasSys && !hasCl) return { set: null, active: false };
    const set = new Set(f.systems ?? []);
    if (hasCl) {
      for (const cid of f.clusters) {
        const c = clusterById.get(cid);
        if (!c) continue; // deleted / absent on this view
        for (const sid of c.system_ids ?? []) set.add(sid);
      }
    }
    return { set, active: true };
  }

  // Systems justified by selected needs via cluster membership (GS-5).
  function needViaClusterSystems(f) {
    if (!f.needs?.size) return null;
    const out = new Set();
    for (const c of clusterById.values()) {
      if (!(c.biz_need_ids ?? []).some((id) => f.needs.has(id))) continue;
      for (const sid of c.system_ids ?? []) out.add(sid);
    }
    return out;
  }

  return {
    entName: (id) => entName.get(id) ?? "(deleted)",
    fldName: (id) => fldName.get(id) ?? "(deleted)",
    active: (f) => !!(norm(f) || (f.queries && f.queries.length) || f.flow
      || f.statuses?.size || f.timings?.size || f.needs?.size
      || f.systems?.size || f.clusters?.size),
    // Effective where-set for surfaces that need the expanded id list.
    expandedSystems,
    facets: (st, f) => {
      if (!setOk(f.statuses, st.status)) return false;
      if (!setOk(f.timings, st.timing)) return false;
      if (f.needs?.size) {
        const onStream = setAny(f.needs, st.biz_need_ids);
        if (!onStream) {
          // Need only via cluster: both endpoints must be need-justified
          // systems so non-members stay dimmed (GS-5 accept).
          const via = needViaClusterSystems(f);
          if (!via || !via.has(st.source.system_id) || !via.has(st.destination.system_id)) {
            return false;
          }
        }
      }
      if (f.flow && !(flowStreams.get(f.flow)?.has(st.id) ?? false)) return false;
      return true;
    },
    // Is this system in the chosen subset? (Empty where-facet = no constraint.)
    systemInSet(sysId, f) {
      const { set, active } = expandedSystems(f);
      if (!active) return true;
      return set.has(sysId);
    },
    streamMatches(st, f) {
      if (!this.facets(st, f)) return false;
      // induced sub-graph on the expanded systems set
      const { set, active } = expandedSystems(f);
      if (active && !(set.has(st.source.system_id) && set.has(st.destination.system_id))) {
        return false;
      }

      const queries = f.queries || [];
      const legacyQ = norm(f);
      const allQueries = [...queries];
      if (legacyQ) {
        allQueries.push({ q: legacyQ, scope: scopeOf(f) });
      }
      if (allQueries.length === 0) return true;

      return allQueries.every(({ q: term, scope }) => {
        const needle = (term ?? "").trim().toLowerCase();
        if (!needle) return true;
        return (stText.get(st.id)?.[scope || "all"] ?? "").includes(needle);
      });
    },
    // Does the system itself match the query (independent of its streams)?
    systemDirect(sysId, f) {
      const queries = f.queries || [];
      const legacyQ = norm(f);
      const allQueries = [...queries];
      if (legacyQ) {
        allQueries.push({ q: legacyQ, scope: scopeOf(f) });
      }
      if (allQueries.length === 0) return false;

      return allQueries.every(({ q: term, scope }) => {
        const needle = (term ?? "").trim().toLowerCase();
        if (!needle) return true;
        const sc = scope || "all";
        if (sc === "streams") return false; // systems only match via streams
        return (sysText.get(sysId)?.[sc] ?? "").includes(needle);
      });
    },
    // A system "matches" if it matches the query directly or any of its
    // streams (facet-checked) matches. The systems/clusters subset, when
    // active, is an explicit visibility gate: in = visible, out = not
    // matched. Need-via-cluster membership also counts (GS-5).
    systemMatches(sys, f, streams) {
      if (!this.active(f)) return true;
      const { active: whereOn } = expandedSystems(f);
      if (whereOn) return this.systemInSet(sys.id, f);
      // Need-via-cluster: member of a cluster that carries a selected need.
      if (f.needs?.size) {
        const via = needViaClusterSystems(f);
        if (via?.has(sys.id)) {
          // Still honor other non-where facets? needs is the facet we're
          // satisfying; statuses/timings/flow don't gate systems directly.
          // Text query still applies if present.
          if (!(f.queries?.length) && !norm(f)) return true;
          if (this.systemDirect(sys.id, f)) return true;
          // fall through to stream path for query neighborhoods
        }
      }
      if (this.systemDirect(sys.id, f)) return true;
      return streams.some((st) =>
        (st.source.system_id === sys.id || st.destination.system_id === sys.id) &&
        this.streamMatches(st, f));
    },
  };
}
