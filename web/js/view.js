// FilteredView — THE single place "what is visible under the current
// filters" lives. Every surface (canvas, rail lists, matrix, tooltips,
// inspectors) asks this class instead of re-implementing filter logic;
// a surface that forgets a facet cannot exist, because it never sees the
// unfiltered world unless it explicitly asks for it.
//
// Construct once per (data, filters, mode) and use like a query object:
//   const v = new FilteredView(data, filters, mode);
//   v.streams()                 filtered streams
//   v.systems() / v.needs() / v.flows()
//   v.streamsBetween(a, b)      ALL streams of a pair (for drill-downs)
//   v.streamsOf(systemId)       ALL streams touching a system
//   v.partition(list)           { matched, rest } under current filters
//   v.streamVisible(st) / v.systemVisible(sys)   predicates (dim-mode paint)
//   v.stageOf(streamId)         stage in the focused flow, or null
//   v.scopeLabels()             UI wording for matched/rest sections

import { buildMatcher } from "./matcher.js";

export class FilteredView {
  constructor(data, filters, mode = "dim") {
    this.data = data;
    this.filters = filters;
    this.mode = mode;
    this.M = buildMatcher(data);
    this.focusedFlow = filters.flow
      ? (data.flows ?? []).find((f) => f.id === filters.flow) ?? null
      : null;
    this._stages = this.focusedFlow
      ? new Map((this.focusedFlow.steps ?? []).map((s) => [s.stream_id, s.stage]))
      : null;
  }

  get active() {
    return this.M.active(this.filters);
  }

  // ---- predicates ----

  streamVisible(st) {
    return this.M.streamMatches(st, this.filters);
  }

  systemVisible(sys) {
    return this.M.systemMatches(sys, this.filters, this.data.streams);
  }

  needVisible(n) {
    const q = (this.filters.q ?? "").trim().toLowerCase();
    // a scoped query (systems/fields/…) says nothing about needs
    if (!q || (this.filters.scope || "all") !== "all") return true;
    return (n.name + " " + (n.description ?? "")).toLowerCase().includes(q);
  }

  flowVisible(fl) {
    if (!this.active) return true;
    const q = (this.filters.q ?? "").trim().toLowerCase();
    if (q && (this.filters.scope || "all") === "all" &&
        (fl.name + " " + (fl.description ?? "")).toLowerCase().includes(q)) return true;
    if (this.filters.need && (fl.biz_need_ids ?? []).includes(this.filters.need)) return true;
    return (fl.steps ?? []).some((sp) => {
      const st = this.data.streams.find((s) => s.id === sp.stream_id);
      return st && this.streamVisible(st);
    });
  }

  // ---- filtered collections ----

  streams() { return this.data.streams.filter((st) => this.streamVisible(st)); }
  systems() { return this.data.systems.filter((s) => this.systemVisible(s)); }
  needs() { return this.data.needs.filter((n) => this.needVisible(n)); }
  flows() { return (this.data.flows ?? []).filter((fl) => this.flowVisible(fl)); }

  // ---- scoped queries (drill-down surfaces) ----

  // ALL streams between two systems (unordered pair; a === b for loops).
  streamsBetween(a, b) {
    return this.data.streams.filter((st) => {
      const s = st.source.system_id, t = st.destination.system_id;
      return (s === a && t === b) || (s === b && t === a);
    });
  }

  // ALL streams touching a system.
  streamsOf(systemId) {
    return this.data.streams.filter((st) =>
      st.source.system_id === systemId || st.destination.system_id === systemId);
  }

  // Split any stream list by the current filters. Surfaces render `matched`
  // prominently and fold `rest` — visible but subordinate, never silently
  // mixed in.
  partition(list) {
    if (!this.active) return { matched: list, rest: [] };
    const matched = [], rest = [];
    for (const st of list) (this.streamVisible(st) ? matched : rest).push(st);
    // inside the matched set, focused-flow hops come in stage order
    if (this._stages) {
      matched.sort((x, y) => (this._stages.get(x.id) ?? 1e9) - (this._stages.get(y.id) ?? 1e9));
    }
    return { matched, rest };
  }

  // ---- flow focus ----

  stageOf(streamId) {
    return this._stages?.get(streamId) ?? null;
  }

  // ---- catalog name resolution (delegated so surfaces need only the view) ----

  entName(id) { return this.M.entName(id); }
  fldName(id) { return this.M.fldName(id); }

  // ---- UI wording for partitioned sections ----

  scopeLabels() {
    const flowOnly = this.focusedFlow &&
      !(this.filters.q ?? "").trim() && !this.filters.status &&
      !this.filters.timing && !this.filters.need;
    return flowOnly
      ? { matched: `In "${this.focusedFlow.name}"`, rest: (n) => `Not in this flow (${n})` }
      : { matched: "Matching the filter", rest: (n) => `Not matching the filter (${n})` };
  }
}
