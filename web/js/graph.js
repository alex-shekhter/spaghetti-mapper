// D3 "bird's eye" canvas.
//
// Systems render as nodes; all streams between the same pair of systems
// aggregate into ONE curved strand whose width encodes how many streams it
// carries. Arrowheads show flow direction. Styling is applied as SVG
// attributes (not CSS classes) so the exported SVG file is self-contained,
// including the legend.

import { FilteredView } from "./view.js";
import { flowShape } from "./analysis.js";
import { plural } from "./ui.js";

const d3 = window.d3;

const COLORS = {
  page: "#10151d",
  panel: "#161d28",
  line: "#2a3646",
  node: "#1c2532",
  nodeStroke: { internal: "#3987e5", external: "#d95926", unknown: "#898781" },
  label: "#f2f4f7",
  label2: "#98a2b3",
  muted: "#667085",
  strand: "#5f7186",
  strandHi: "#e6a23c",
  badgeFill: "#1c2532",
  badgeText: "#f2f4f7",
};

// Cluster palette keys → hex (renderer owns hex; stored as key). Amber never.
// Order = auto-assign table order (least-used, ties: first in this list).
const CLUSTER_COLOR_KEYS = [
  "verdigris", "iris", "moss", "rosewood",
  "ochre", "glacier", "plum", "fog",
];
const CLUSTER_COLORS = {
  verdigris: "#3fae94",
  iris: "#8f7ce8",
  moss: "#86a94e",
  rosewood: "#c9698c",
  ochre: "#b98d4f",
  glacier: "#5fa7c7",
  plum: "#a06bb8",
  fog: "#7d8ba1",
};
const clusterHex = (key) => CLUSTER_COLORS[key] || CLUSTER_COLORS.verdigris;
// Hull plate expand / 2-member ghost offset (graph units) — plan §2.2
const HULL_PAD = 38;
const HULL_PAIR_GHOST = 26;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const DIM_OPACITY = 0.1;
const NODE_R = 14;
const INSET = NODE_R + 4; // strand endpoints stop at the node rim so arrows show
const LABEL_MIN_ZOOM = 0.8;
const DEFAULT_FAN_SPACING = 34; // px between parallel strands in Expand mode (overridable per project)
// Edge-label density (DR-5): hide labels that can't fit, sit them off the
// strand, and fade the shorter of any pair that still collides.
const EDGE_LABEL_MIN_SCREEN = 90; // hide when edge's on-screen length is shorter
const EDGE_LABEL_PAD = 12;        // perpendicular offset from _mid (bow direction)
const EDGE_LABEL_CHAR_W = 6.0;    // ~0.57em of 10.5px system-ui (graph units)
const EDGE_LABEL_H = 12;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Aggregate streams into one link per unordered system pair.
// Self-referencing streams become loop links.
function aggregate(data) {
  const sysIds = new Set(data.systems.map((s) => s.id));
  const byPair = new Map();
  for (const st of data.streams) {
    const sa = st.source.system_id, sb = st.destination.system_id;
    if (!sysIds.has(sa) || !sysIds.has(sb)) continue; // dangling refs
    const [a, b] = sa < sb ? [sa, sb] : [sb, sa];
    const key = `${a}~${b}`;
    let link = byPair.get(key);
    if (!link) {
      link = { key, a, b, loop: sa === sb, streams: [], dirAB: false, dirBA: false };
      byPair.set(key, link);
    }
    link.streams.push(st);
    const bi = st.direction === "bi";
    if (bi || sa === a) link.dirAB = true; // flow a -> b
    if (bi || sa === b) link.dirBA = true; // flow b -> a
  }
  return [...byPair.values()];
}

// Expand: one link PER STREAM between a pair, fanned out parallel so each
// stream is individually visible. Each link keeps the same shape as an
// aggregated link (single-element `streams`, pair `a`/`b`, dir flags) so the
// rest of the renderer is unchanged; it only adds `fan` (index within the
// pair) and `fanCount` for the perpendicular offset. The link `key` is the
// stream id, so the flow overlay can resolve a hop to its own curve.
function expandLinks(data) {
  const sysIds = new Set(data.systems.map((s) => s.id));
  const countByPair = new Map();
  for (const st of data.streams) {
    const sa = st.source.system_id, sb = st.destination.system_id;
    if (!sysIds.has(sa) || !sysIds.has(sb)) continue;
    const [a, b] = sa < sb ? [sa, sb] : [sb, sa];
    const pk = sa === sb ? `loop~${a}` : `${a}~${b}`;
    countByPair.set(pk, (countByPair.get(pk) ?? 0) + 1);
  }
  const idxByPair = new Map();
  const links = [];
  for (const st of data.streams) {
    const sa = st.source.system_id, sb = st.destination.system_id;
    if (!sysIds.has(sa) || !sysIds.has(sb)) continue;
    const [a, b] = sa < sb ? [sa, sb] : [sb, sa];
    const pk = sa === sb ? `loop~${a}` : `${a}~${b}`;
    const fan = idxByPair.get(pk) ?? 0;
    idxByPair.set(pk, fan + 1);
    const bi = st.direction === "bi";
    links.push({
      key: st.id, a, b, loop: sa === sb, streams: [st],
      dirAB: bi || sa === a, dirBA: bi || sa === b,
      fan, fanCount: countByPair.get(pk),
    });
  }
  return links;
}

// Perpendicular offset of a strand within its fan (0 in Bundle mode where
// fan/fanCount are absent). Uses the instance fanSpacing so the gap is
// adjustable per project.
const fanOffOf = (d, spacing) =>
  d.fanCount != null ? (d.fan - (d.fanCount - 1) / 2) * spacing : 0;

export function createGraph(container, { onSelect, onLayoutChange, onZoom }) {
  const svg = d3.create("svg")
    .attr("xmlns", "http://www.w3.org/2000/svg")
    .attr("font-family", FONT);

  // Arrowhead markers: one per strand state (normal / highlighted).
  const defs = svg.append("defs");
  for (const [id, color] of [["arr", COLORS.strand], ["arr-hi", COLORS.strandHi]]) {
    defs.append("marker")
      .attr("id", id).attr("viewBox", "0 -4 8 8")
      .attr("refX", 6.5).attr("refY", 0)
      .attr("markerWidth", 11).attr("markerHeight", 11)
      .attr("markerUnits", "userSpaceOnUse") // fixed size, not scaled by stroke width
      .attr("orient", "auto-start-reverse")
      .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", color);
  }

  const zoomLayer = svg.append("g").attr("class", "zoom-layer");
  // Hulls sit under strands/nodes (first child of zoomLayer) — plan §2.2.
  const hullG = zoomLayer.append("g").attr("class", "hulls");
  const linkG = zoomLayer.append("g");
  const flowG = zoomLayer.append("g");  // directional hop overlays when a flow is focused
  const badgeG = zoomLayer.append("g").attr("class", "badges");
  const stageG = zoomLayer.append("g"); // per-hop stage chips
  const labelG = zoomLayer.append("g");
  const nodeG = zoomLayer.append("g");
  const legendG = svg.append("g").attr("class", "legend");

  container.appendChild(svg.node());

  const tooltip = document.createElement("div");
  tooltip.className = "graph-tooltip";
  container.appendChild(tooltip);

  const emptyNote = document.createElement("div");
  emptyNote.className = "canvas-empty";
  emptyNote.style.display = "none";
  emptyNote.innerHTML = `<div style="font-size:15px">Nothing on the map yet</div>
    <div>Add systems in the left rail, then connect them with streams.<br>The tangle draws itself.</div>`;
  container.appendChild(emptyNote);

  const hint = document.createElement("div");
  hint.className = "canvas-hint";
  hint.textContent = "drag to pin · shift-drag to select a group · click an edge to dig in";
  container.appendChild(hint);

  const IDLE_HINT = "drag to pin · shift-drag to select a group · click an edge to dig in";
  const INSPECTOR_HINT = "Esc closes the inspector";

  // ---- minimap (smart auto-show bird's-eye view) ----
  // An HTML overlay (never part of exportSVG) that appears only while the
  // graph extends beyond the viewport — zoomed in, or a map bigger than the
  // window — and hides when everything is visible. Click or drag pans the
  // main view; wheel zooms it.
  const MM_W = 176, MM_H = 116, MM_MARGIN = 40;
  const minimap = document.createElement("div");
  minimap.className = "minimap";
  minimap.style.display = "none";
  container.appendChild(minimap);
  const mmSvg = d3.create("svg").attr("width", MM_W).attr("height", MM_H).attr("aria-label", "Map overview");
  const mmEdgeG = mmSvg.append("g");
  const mmNodeG = mmSvg.append("g");
  const mmView = mmSvg.append("rect")
    .attr("fill", "rgba(230,162,60,0.10)")
    .attr("stroke", COLORS.strandHi).attr("stroke-width", 1);
  minimap.appendChild(mmSvg.node());
  let mmT = null; // graph→minimap mapping {s, ox, oy}, valid while shown

  let zoomK = 1;
  let showEdgeLabels = true; // show stream name labels on edges (per-project pref)
  const zoom = d3.zoom()
    .scaleExtent([0.15, 4])
    // Shift is reserved for marquee / multi-select — never pan with it.
    .filter((e) => !e.shiftKey && !e.button)
    .on("zoom", (e) => {
      if (e.sourceEvent) autoFitPending = false; // user took over the view
      zoomLayer.attr("transform", e.transform);
      const prevK = zoomK;
      zoomK = e.transform.k;
      // Full paint when crossing the label-zoom floor (dimming + other
      // visibility); otherwise re-run density only when zoom *scale* changes
      // (screen-length threshold). Collision geometry is graph-unit and
      // pan-invariant, so pure pans skip the work (DR-5 review).
      if ((prevK >= LABEL_MIN_ZOOM) !== (zoomK >= LABEL_MIN_ZOOM)) paint();
      else if (showEdgeLabels && prevK !== zoomK) positionEdgeLabels();
      // FU-1: re-place labels vs fixed HUD on pan/zoom (screen-space). Lightweight
      // path only — no plate rebuild / tspan rewrite / event rebind (nodes unmoved).
      updateHullLabelPlacement();
      onZoom?.(zoomK);
      scheduleMinimap();
    });
  svg.call(zoom).on("dblclick.zoom", null);

  // ---- marquee (shift-drag on background) ----
  // Screen-space rect on the svg root (not zoomLayer). Sub-4px release = clear.
  // Esc cancels without changing selection (cancelMarquee).
  let marquee = null; // { x0, y0, x1, y1, rect } while active
  let marqueePreview = new Set(); // node ids lit during drag
  let suppressBgClick = false; // swallow the click that follows a marquee mouseup
  let groupDrag = null; // { starts: Map<id,{x,y}>, ox, oy } while group-dragging
  let marqueeMove = null; // window mousemove listener while marqueeing
  let marqueeUp = null;   // window mouseup listener while marqueeing

  const marqueeRectEl = () => {
    let r = svg.select("rect.marquee");
    if (r.empty()) {
      r = svg.append("rect")
        .attr("class", "marquee")
        .attr("fill", "#e6a23c")
        .attr("fill-opacity", 0.06)
        .attr("stroke", "#e6a23c")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "4,3")
        .attr("pointer-events", "none")
        .style("display", "none");
    }
    return r;
  };

  const idsInMarquee = (x0, y0, x1, y1) => {
    const t = d3.zoomTransform(svg.node());
    const [gx0, gy0] = t.invert([Math.min(x0, x1), Math.min(y0, y1)]);
    const [gx1, gy1] = t.invert([Math.max(x0, x1), Math.max(y0, y1)]);
    const out = [];
    for (const n of nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      if (n.x >= gx0 && n.x <= gx1 && n.y >= gy0 && n.y <= gy1) out.push(n.id);
    }
    return out;
  };

  const paintMarqueeHalos = () => {
    nodeG.selectAll("g.node").select(".halo")
      .attr("visibility", (d) => (haloVisible(d.id) ? "visible" : "hidden"));
  };

  const detachMarqueeListeners = () => {
    // Bound on both window and document: real pointer events bubble through
    // document; synth e2e events are often dispatched on window only.
    if (marqueeMove) {
      window.removeEventListener("mousemove", marqueeMove, true);
      document.removeEventListener("mousemove", marqueeMove, true);
    }
    if (marqueeUp) {
      window.removeEventListener("mouseup", marqueeUp, true);
      document.removeEventListener("mouseup", marqueeUp, true);
    }
    marqueeMove = marqueeUp = null;
  };

  const endMarqueeUI = () => {
    detachMarqueeListeners();
    // Always hide the rect (even if marquee state was already cleared).
    marqueeRectEl().style("display", "none");
    marquee = null;
    marqueePreview = new Set();
    document.body.style.userSelect = "";
    container.style.cursor = "";
    paintMarqueeHalos();
  };

  const emitSelectionFromIds = (ids) => {
    if (ids.length >= 2) onSelect({ type: "group", ids });
    else if (ids.length === 1) onSelect({ type: "node", id: ids[0] });
    else onSelect(null);
  };

  // Union marquee hits with the existing group/node selection.
  const unionWithSelection = (hitIds) => {
    const base = [];
    if (selection?.type === "group") base.push(...selection.ids);
    else if (selection?.type === "node") base.push(selection.id);
    return [...new Set([...base, ...hitIds])];
  };

  const toggleNodeInSelection = (id) => {
    const base = [];
    if (selection?.type === "group") base.push(...selection.ids);
    else if (selection?.type === "node") base.push(selection.id);
    const i = base.indexOf(id);
    if (i >= 0) base.splice(i, 1);
    else base.push(id);
    emitSelectionFromIds(base);
  };

  // AJ-6: stream ids whose links should paint as hovered + endpoint halos.
  let highlightStreamIds = null; // Set<string> | null
  let highlightNodeIds = null;   // Set<string> | null

  const haloVisible = (id) => {
    if (marqueePreview.has(id)) return true;
    if (selection?.type === "node" && selection.id === id) return true;
    if (selection?.type === "group" && selection.ids.includes(id)) return true;
    if (highlightNodeIds?.has(id)) return true;
    return false;
  };

  const pointerOnInteractive = (target) => {
    const el = target;
    if (!el || el === svg.node()) return false;
    // Nodes, links, and hulls own their clicks; marquee only starts on empty canvas.
    return !!el.closest?.("g.node, g.link, g.hull, g.legend, .minimap");
  };

  svg.on("mousedown.marquee", (e) => {
    if (!e.shiftKey || e.button !== 0) return;
    if (pointerOnInteractive(e.target)) return;
    // Ignore events that are not primary-button press (defensive for synth events).
    e.preventDefault();
    e.stopPropagation();
    autoFitPending = false;
    // Cancel any prior marquee listeners before starting a new one.
    detachMarqueeListeners();
    const svgRect = svg.node().getBoundingClientRect();
    const x0 = e.clientX - svgRect.left;
    const y0 = e.clientY - svgRect.top;
    const rect = marqueeRectEl();
    marquee = { x0, y0, x1: x0, y1: y0, rect };
    marqueePreview = new Set();
    document.body.style.userSelect = "none";
    container.style.cursor = "crosshair";
    rect
      .attr("x", x0).attr("y", y0).attr("width", 0).attr("height", 0)
      .style("display", null);

    const setCorner = (ev) => {
      if (!marquee || ev.clientX == null) return;
      const r = svg.node().getBoundingClientRect();
      marquee.x1 = ev.clientX - r.left;
      marquee.y1 = ev.clientY - r.top;
      const x = Math.min(marquee.x0, marquee.x1);
      const y = Math.min(marquee.y0, marquee.y1);
      const w = Math.abs(marquee.x1 - marquee.x0);
      const h = Math.abs(marquee.y1 - marquee.y0);
      marquee.rect.attr("x", x).attr("y", y).attr("width", w).attr("height", h);
      marqueePreview = new Set(idsInMarquee(marquee.x0, marquee.y0, marquee.x1, marquee.y1));
      paintMarqueeHalos();
    };
    marqueeMove = (ev) => setCorner(ev);
    marqueeUp = (ev) => {
      if (!marquee) { detachMarqueeListeners(); return; }
      // Prefer the release coordinates (mousemove can be starved under virtual time).
      setCorner(ev);
      const dx = Math.abs(marquee.x1 - marquee.x0);
      const dy = Math.abs(marquee.y1 - marquee.y0);
      const hits = (dx < 4 && dy < 4)
        ? null // sub-4px → clear (background click)
        : idsInMarquee(marquee.x0, marquee.y0, marquee.x1, marquee.y1);
      endMarqueeUI();
      suppressBgClick = true;
      if (hits === null) onSelect(null);
      else emitSelectionFromIds(unionWithSelection(hits));
    };
    // Capture on window + document so both real pointer paths and synth
    // e2e events (often dispatched on window) reach the handler.
    window.addEventListener("mousemove", marqueeMove, true);
    window.addEventListener("mouseup", marqueeUp, true);
    document.addEventListener("mousemove", marqueeMove, true);
    document.addEventListener("mouseup", marqueeUp, true);
  });

  svg.on("click", (e) => {
    if (suppressBgClick) { suppressBgClick = false; return; }
    if (e.target === svg.node()) onSelect(null);
  });

  let sim = null;
  let nodes = [], links = [];
  let flowRowsCache = []; // hops of the focused flow, resolved to links
  let lastData = null;
  let clusters = []; // from graph payload
  let clusterById = new Map();
  // Cluster ids that should play the §2.5 create animation on next hull paint.
  const pendingHullAnim = new Set();
  let hullHoverId = null; // cluster id under pointer (for hover opacities)
  let entById = new Map();   // entity id -> entity (for endpoint field counts)
  let needById = new Map(); // need id -> need (for chip names)
  let V = null; // FilteredView — the one source of "what is visible"
  let filters = { q: "", scope: "all", statuses: new Set(), timings: new Set(), needs: new Set(), systems: new Set(), clusters: new Set(), flow: "" };
  let mode = "dim";
  let expand = false; // Bundle (aggregated strands) vs Expand (one curve per stream)
  let fanSpacing = DEFAULT_FAN_SPACING; // px between parallel strands in Expand mode
  let selection = null;
  // One-shot auto-fit: arm on load (and on resetLayout, i.e. restore/undo/
  // redo), consume on the first settle. A manual zoom/pan before it fires
  // disarms it so the user's view is never yanked away.
  let autoFitPending = true;
  const posCache = new Map(); // node id -> {x, y, fx, fy}
  let saveTimer = null;
  let newNodeSaveTimer = null;          // (A′) separate timer for the new-nodes-only sim-end save
  let savedLayout = new Map();         // id -> {x, y, pinned}: the last layout we PUT (the (B) no-op guard baseline)
  let lastSavedLayout = "";            // canonical string of savedLayout

  const fanOff = (d) => fanOffOf(d, fanSpacing);

  const size = () => {
    const r = container.getBoundingClientRect();
    return { w: r.width || 800, h: r.height || 600 };
  };

  new ResizeObserver(() => {
    const { w, h } = size();
    if (sim) sim.force("center", d3.forceCenter(w / 2, h / 2)).alpha(0.1).restart();
    placeLegend();
    scheduleMinimap();
  }).observe(container);

  const widthScale = (n) => Math.min(1.8 + 2.2 * Math.log2(n + 1), 10);

  // ?e2e counts as reduced motion: the headless harness's virtual time
  // starves rAF-driven d3 transitions (they freeze mid-flight), and the
  // suite asserts end states — so it runs the instant-transform path.
  const reducedMotion = () =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    new URLSearchParams(location.search).has("e2e");
  const zoomTarget = (animate, ms) => (animate && !reducedMotion() ? svg.transition().duration(ms) : svg);

  // Center the node bounding box in the viewport via the zoom transform
  // (never above 1.25x — fit is about seeing everything, not magnifying a
  // small graph into blobs). Layout coordinates are untouched, so nothing
  // is re-saved and a plain zoom/pan continues from the fitted view.
  function fitToView(animate = true) {
    if (!nodes.length) return;
    const { w, h } = size();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    if (!Number.isFinite(minX)) return;
    const PAD = 70; // node radius + name label + breathing room
    const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
    const k = Math.max(0.15, Math.min((w - 2 * PAD) / bw, (h - 2 * PAD) / bh, 1.25));
    const t = d3.zoomIdentity
      .translate(w / 2 - k * (minX + maxX) / 2, h / 2 - k * (minY + maxY) / 2)
      .scale(k);
    zoomTarget(animate, 350).call(zoom.transform, t);
  }

  // Bounding box of the given node ids (visible members only).
  function nodesBBox(ids) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const id of ids) {
      const n = nodes.find((x) => x.id === id);
      if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      any = true;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  // Fit the view to a subset of nodes (cluster Focus button — plan §5.2).
  // Same math as fitToView but scoped to the given ids.
  function fitToNodeIds(ids, animate = true) {
    const bb = nodesBBox(ids);
    if (!bb) return;
    const { w, h } = size();
    const PAD = 70;
    const bw = Math.max(bb.maxX - bb.minX, 1), bh = Math.max(bb.maxY - bb.minY, 1);
    const k = Math.max(0.15, Math.min((w - 2 * PAD) / bw, (h - 2 * PAD) / bh, 1.25));
    const t = d3.zoomIdentity
      .translate(w / 2 - k * (bb.minX + bb.maxX) / 2, h / 2 - k * (bb.minY + bb.maxY) / 2)
      .scale(k);
    zoomTarget(animate, 350).call(zoom.transform, t);
  }

  // Pan the current selection to the canvas center at the current zoom —
  // orientation without a surprise rescale. No-op for non-map selections.
  function focusSelection() {
    if (!selection) return;
    let cx, cy;
    if (selection.type === "node") {
      const n = nodes.find((x) => x.id === selection.id);
      if (!n) return;
      cx = n.x; cy = n.y;
    } else if (selection.type === "group") {
      const bb = nodesBBox(selection.ids);
      if (!bb) return;
      cx = (bb.minX + bb.maxX) / 2; cy = (bb.minY + bb.maxY) / 2;
    } else if (selection.type === "cluster") {
      const c = clusterById.get(selection.id);
      if (!c) return;
      const bb = nodesBBox(c.system_ids ?? []);
      if (!bb) return;
      cx = (bb.minX + bb.maxX) / 2; cy = (bb.minY + bb.maxY) / 2;
    } else if (selection.type === "edge") {
      const a = nodes.find((x) => x.id === selection.a);
      const b = nodes.find((x) => x.id === selection.b);
      if (!a || !b) return;
      cx = (a.x + b.x) / 2; cy = (a.y + b.y) / 2;
    } else return;
    const { w, h } = size();
    const k = d3.zoomTransform(svg.node()).k;
    const t = d3.zoomIdentity.translate(w / 2 - k * cx, h / 2 - k * cy).scale(k);
    zoomTarget(true, 300).call(zoom.transform, t);
  }

  // (DR-4) Opening the inspector must not bury the selection it describes.
  // The inspector either shrinks the canvas column (flex split, ≥1000px) or
  // overlays it absolutely (<1000px); either way the clicked node/edge can
  // end up clipped at the panel seam. Measured a tick after setSelection
  // because the inspector mounts in the same reactive flush, after the
  // graph is told about the selection.
  let visTimer = null;
  function scheduleEnsureVisible() {
    clearTimeout(visTimer);
    visTimer = setTimeout(() => { visTimer = null; ensureSelectionVisible(); }, 0);
  }
  function ensureSelectionVisible() {
    if (!selection) return;
    const cRect = container.getBoundingClientRect();
    if (!cRect.width) return;
    // visible right boundary: the inspector's left edge when it intrudes on
    // the container (overlay mode), else the container's own right edge
    // (split mode clips at the seam)
    let boundary = cRect.right;
    const insp = container.closest(".body-split")?.querySelector(".inspector");
    if (insp) {
      const r = insp.getBoundingClientRect();
      if (r.width && r.left < boundary && r.bottom > cRect.top && r.top < cRect.bottom) {
        boundary = Math.max(cRect.left, r.left);
      }
    }
    // selection extent in screen coords, computed from graph data + the zoom
    // transform (not DOM rects — SVG bounding rects don't track transforms
    // in the headless e2e harness): node halo + centered label, or the
    // selected connection's strand midpoint(s), padded
    const t = d3.zoomTransform(svg.node());
    let left = Infinity, right = -Infinity;
    if (selection.type === "node") {
      const n = nodes.find((x) => x.id === selection.id);
      if (!n || !Number.isFinite(n.x)) return;
      const cx = cRect.left + t.applyX(n.x);
      const half = t.k * Math.max(NODE_R + 12, n.name.length * 3.6);
      left = cx - half; right = cx + half;
    } else if (selection.type === "group" || selection.type === "cluster") {
      const ids = selection.type === "group"
        ? selection.ids
        : (clusterById.get(selection.id)?.system_ids ?? []);
      for (const id of ids) {
        const n = nodes.find((x) => x.id === id);
        if (!n || !Number.isFinite(n.x)) continue;
        const cx = cRect.left + t.applyX(n.x);
        const half = t.k * Math.max(NODE_R + 12, (n.name?.length ?? 4) * 3.6);
        left = Math.min(left, cx - half);
        right = Math.max(right, cx + half);
      }
      if (right === -Infinity) return;
    } else if (selection.type === "edge") {
      const PAD = 30; // room for the count badge / stage chips around _mid
      for (const l of links) {
        if (l.a !== selection.a || l.b !== selection.b || !l._mid) continue;
        const sx = cRect.left + t.applyX(l._mid[0]);
        left = Math.min(left, sx - PAD);
        right = Math.max(right, sx + PAD);
      }
      if (right === -Infinity) return;
    } else return;
    const overlap = right - boundary;
    if (overlap <= 0) return;
    // never push the selection out of the left side of a narrow canvas
    const pan = Math.min(overlap + 24, left - cRect.left - 8);
    if (pan <= 0) return;
    zoomTarget(true, 200).call(zoom.transform,
      d3.zoomIdentity.translate(t.x - pan, t.y).scale(t.k));
  }

  // Redraw the minimap and decide whether it should be on screen at all.
  // Coalesced through rAF because it's called from zoom events and sim ticks.
  let mmRaf = 0;
  const scheduleMinimap = () => {
    if (!mmRaf) mmRaf = requestAnimationFrame(() => { mmRaf = 0; updateMinimap(); });
  };
  function updateMinimap() {
    if (!nodes.length) { minimap.style.display = "none"; mmT = null; return; }
    const { w, h } = size();
    const t = d3.zoomTransform(svg.node());
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    if (!Number.isFinite(minX)) { minimap.style.display = "none"; mmT = null; return; }
    // shown only while some of the graph lies outside the viewport
    const off = t.x + t.k * minX < -MM_MARGIN || t.y + t.k * minY < -MM_MARGIN ||
                t.x + t.k * maxX > w + MM_MARGIN || t.y + t.k * maxY > h + MM_MARGIN;
    minimap.style.display = off ? "" : "none";
    if (!off) { mmT = null; return; }
    const pad = 30;
    const s = Math.min(MM_W / (maxX - minX + 2 * pad), MM_H / (maxY - minY + 2 * pad));
    const ox = (MM_W - s * (maxX - minX)) / 2 - s * minX;
    const oy = (MM_H - s * (maxY - minY)) / 2 - s * minY;
    mmT = { s, ox, oy };
    const px = (v) => v * s + ox, py = (v) => v * s + oy;
    mmEdgeG.selectAll("line").data(links.filter((l) => !l.loop), (d) => d.key).join("line")
      .attr("stroke", COLORS.strand).attr("stroke-width", 1)
      .attr("x1", (d) => px(d.source.x)).attr("y1", (d) => py(d.source.y))
      .attr("x2", (d) => px(d.target.x)).attr("y2", (d) => py(d.target.y));
    mmNodeG.selectAll("circle").data(nodes, (d) => d.id).join("circle")
      .attr("r", 2.5).attr("fill", COLORS.node).attr("stroke-width", 1.2)
      .attr("stroke", (d) => COLORS.nodeStroke[d.type] || COLORS.nodeStroke.unknown)
      .attr("cx", (d) => px(d.x)).attr("cy", (d) => py(d.y));
    // viewport rectangle: the on-screen slice mapped back into graph coords
    mmView
      .attr("x", px((0 - t.x) / t.k)).attr("y", py((0 - t.y) / t.k))
      .attr("width", (w / t.k) * s).attr("height", (h / t.k) * s);
  }
  const mmPan = (e) => {
    if (!mmT) return;
    const r = minimap.getBoundingClientRect();
    const gx = (e.clientX - r.left - mmT.ox) / mmT.s;
    const gy = (e.clientY - r.top - mmT.oy) / mmT.s;
    const { w, h } = size();
    const k = d3.zoomTransform(svg.node()).k;
    svg.call(zoom.transform, d3.zoomIdentity.translate(w / 2 - k * gx, h / 2 - k * gy).scale(k));
  };
  minimap.addEventListener("mousedown", (e) => {
    e.preventDefault();
    mmPan(e);
    const mv = (ev) => mmPan(ev);
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  });
  minimap.addEventListener("wheel", (e) => {
    e.preventDefault();
    svg.call(zoom.scaleBy, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  // ---- matching (canvas-side composition of the shared matcher) ----

  const active = () => V && V.active;
  const linkMatched = (l) => l.streams.some((st) => V.streamVisible(st));
  const nodeMatched = (n) => !active() || V.systemVisible(n);

  // ---- geometry ----

  // Strand path: a quadratic curve bowing perpendicular to the line, with
  // endpoints inset to the node rim so arrowheads stay visible.
  // Also stamps d._len (chord length) and d._bowDir (unit vector along the
  // bow) so edge labels can sit off the strand and know screen length.
  function strandPath(d) {
    if (d.loop) {
      const { x, y } = d.source;
      const off = fanOff(d);
      d._mid = [x + off, y - 46];
      d._len = 100; // ~arc length of the self-loop; always long enough to label
      d._bowDir = [0, -1];
      return `M${x - 9 + off},${y - 12} a16,16 0 1,1 18,0`;
    }
    const x1 = d.source.x, y1 = d.source.y, x2 = d.target.x, y2 = d.target.y;
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    d._len = dist;
    const bow = Math.min(dist * 0.12, 34) + fanOff(d);
    // Unit perpendicular (CCW of source→target); bow sign chooses which side.
    const nx = -dy / dist, ny = dx / dist;
    const sign = bow >= 0 ? 1 : -1;
    d._bowDir = [nx * sign, ny * sign];
    const mx = (x1 + x2) / 2 - (dy / dist) * bow;
    const my = (y1 + y2) / 2 + (dx / dist) * bow;
    // inset endpoints along the curve tangents
    const t1 = Math.hypot(mx - x1, my - y1) || 1;
    const p1x = x1 + ((mx - x1) / t1) * INSET, p1y = y1 + ((my - y1) / t1) * INSET;
    const t2 = Math.hypot(x2 - mx, y2 - my) || 1;
    const p2x = x2 - ((x2 - mx) / t2) * INSET, p2y = y2 - ((y2 - my) / t2) * INSET;
    d._mid = [(p1x + 2 * mx + p2x) / 4, (p1y + 2 * my + p2y) / 4];
    return `M${p1x},${p1y} Q${mx},${my} ${p2x},${p2y}`;
  }

  // Position edge labels off the strand and apply the density pass (DR-5):
  // master Labels toggle + zoom floor use visibility; short-edge and
  // collision losers use opacity:0 so they can return on drag/zoom without
  // a rebuild. Prefer matched (lit) labels over dimmed, then longer edges.
  // Badges and stage chips are fixed obstacles so labels yield to them.
  function positionEdgeLabels() {
    const labelsOn = zoomK >= LABEL_MIN_ZOOM && showEdgeLabels;
    const dimming = mode === "dim" && active();
    const entries = [];
    labelG.selectAll("text.elabel").each(function (d) {
      const el = d3.select(this);
      if (!labelsOn) {
        el.attr("visibility", "hidden");
        return;
      }
      el.attr("visibility", "visible");
      const mid = d._mid || [0, 0];
      const dir = d._bowDir || [0, -1];
      const lx = mid[0] + dir[0] * EDGE_LABEL_PAD;
      const ly = mid[1] + dir[1] * EDGE_LABEL_PAD;
      el.attr("x", lx).attr("y", ly);
      const text = this.textContent || "";
      const w = Math.max(text.length * EDGE_LABEL_CHAR_W, 8);
      const len = d._len ?? 0;
      const short = len * zoomK < EDGE_LABEL_MIN_SCREEN;
      entries.push({
        el, d, lx, ly, w,
        // text-anchor middle; y is baseline → vertical centre ≈ y − 0.35·H
        cy: ly - EDGE_LABEL_H * 0.35,
        len,
        short,
        dim: dimming && !linkMatched(d),
        hide: short, // short always fades; collision may add more
      });
    });
    // Obstacles from selection data (not DOM rects — headless SVG bboxes
    // don't track the zoom transform). 20×EDGE_LABEL_H boxes on each mid.
    const obstacles = [];
    if (badgeG.attr("display") !== "none") {
      badgeG.selectAll("g.badge").each((d) => {
        const m = d._mid;
        if (!m) return;
        obstacles.push({ lx: m[0], cy: m[1], w: 20 });
      });
    }
    stageG.selectAll("g.stage").each((d) => {
      const c = overlayGeom(d).chip;
      if (!c) return;
      obstacles.push({ lx: c[0], cy: c[1], w: 20 });
    });
    // Greedy keep: matched first, then longest edge. Seed with obstacles
    // so labels that hit a badge/chip fade; obstacles themselves never fade.
    const candidates = entries
      .filter((e) => !e.short)
      .sort((a, b) => (a.dim - b.dim) || (b.len - a.len));
    const kept = obstacles.slice();
    const overlaps = (a, b) =>
      Math.abs(a.lx - b.lx) < (a.w + b.w) / 2 &&
      Math.abs(a.cy - b.cy) < EDGE_LABEL_H;
    for (const e of candidates) {
      if (kept.some((k) => overlaps(e, k))) e.hide = true;
      else kept.push(e);
    }
    for (const e of entries) {
      let op = 1;
      if (e.hide) op = 0;
      else if (e.dim) op = DIM_OPACITY;
      e.el.attr("opacity", op);
    }
  }

  function linkDash(l) {
    const statuses = new Set(l.streams.map((s) => s.status));
    if (statuses.size === 1 && statuses.has("planned")) return "7,5";
    if (statuses.size === 1 && statuses.has("unknown")) return "2,4";
    return null;
  }

  // ---- tooltip ----

  function showTooltip(e, html) {
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
    moveTooltip(e);
  }
  function moveTooltip(e) {
    const r = container.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    tooltip.style.left = Math.min(x + 14, r.width - tooltip.offsetWidth - 8) + "px";
    tooltip.style.top = Math.min(y + 14, r.height - tooltip.offsetHeight - 8) + "px";
  }
  const hideTooltip = () => (tooltip.style.display = "none");

  const sysName = (id) => lastData?.systems.find((s) => s.id === id)?.name ?? "?";
  const needName = (id) => needById.get(id)?.name;
  const needNames = (ids) => (ids ?? []).map((id) => needById.get(id)?.name).filter(Boolean);

  // Endpoint payload summary — same vocabulary as the inspector strand-card
  // (DR-6). Spell out entity/field; fields_mode "all" → "all fields".
  function epSummary(ep) {
    const entN = (ep.entity_ids ?? []).length;
    const ent = plural(entN, "entity", "entities");
    if (ep.fields_mode === "all") return `${ent} · all fields`;
    if (ep.fields_mode === "list") {
      return `${ent} · ${plural((ep.field_ids ?? []).length, "field")}`;
    }
    return `${ent} · fields not documented`;
  }
  // Both endpoints empty and neither is a documented mode → one phrase, no arrow.
  function payloadBothUndocumented(st) {
    const bare = (ep) =>
      (ep.entity_ids ?? []).length === 0
      && ep.fields_mode !== "all"
      && ep.fields_mode !== "list";
    return bare(st.source) && bare(st.destination);
  }

  // A stream's true direction within its unordered pair: → / ← / ⇄, or ↺
  // for a self-loop. The aggregate strand hides who pushes to whom.
  function dirGlyph(st, l) {
    if (l.loop) return "&#8635;";
    if (st.direction === "bi") return "&#8646;";
    return st.source.system_id === l.a ? "&#8594;" : "&#8592;";
  }

  function statusBreakdown(streams) {
    const counts = {};
    for (const s of streams) counts[s.status] = (counts[s.status] ?? 0) + 1;
    return ["implemented", "planned", "unknown"]
      .filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(", ") || "—";
  }

  const ttKv = (k, v) =>
    `<div class="tt-kv"><span class="tt-kv-k">${k}</span><span class="tt-kv-v">${v ? esc(v) : "—"}</span></div>`;

  // Need summary for a stream row: the single need's name, or an "N needs" count.
  function needTail(st) {
    const ns = needNames(st.biz_need_ids);
    if (!ns.length) return "";
    return " · " + (ns.length === 1 ? esc(ns[0]) : plural(ns.length, "need"));
  }

  function linkTooltip(l) {
    // while a flow is focused, the tooltip tells the flow's story for this
    // strand: its hops with stage and true direction — not the aggregate
    const hops = flowRowsCache.filter((r) => r.link.key === l.key);
    if (filters.flow && hops.length) {
      const stById = new Map(lastData.streams.map((s) => [s.id, s]));
      const rows = hops.sort((x, y) => x.stage - y.stage).map((r) => {
        const st = stById.get(r.id);
        const from = r.dir === "ab" ? l.a : l.b, to = r.dir === "ab" ? l.b : l.a;
        const api = st.api_type ? " · " + esc(st.api_type) : "";
        return `<div class="tt-row"><span><span class="tt-stage">${r.stage}</span>${esc(st.name)}</span>` +
          `<span class="tt-meta">${esc(sysName(from))} &#8594; ${esc(sysName(to))} · ${esc(st.status || "—")}${api}${needTail(st)}</span></div>`;
      }).join("");
      const others = l.streams.length - hops.length;
      const note = others > 0
        ? `<div class="tt-meta">+${plural(others, "other stream")} on this connection — not in this flow</div>`
        : "";
      return `<div class="tt-head">hops of the focused flow</div>${rows}${note}<div class="tt-hint">click to dig in</div>`;
    }

    // Single stream (or any expanded strand, which is one curve per stream):
    // show a compact strand-card preview — true source → destination, the
    // contract facts, endpoint catalog shape, and needs.
    if (l.streams.length === 1) {
      const st = l.streams[0];
      const arrow = st.direction === "bi" ? "&#8646;" : "&#8594;";
      const src = st.source.system_id, dst = st.destination.system_id;
      const head = l.loop
        ? `<div class="tt-head"><b>${esc(sysName(src))}</b> internal flow</div>`
        : `<div class="tt-head"><b>${esc(sysName(src))}</b> ${arrow} <b>${esc(sysName(dst))}</b></div>`;
      const prov = st.provenance && st.provenance.source !== "manual"
        ? `<span class="prov-chip">${esc(st.provenance.source)}</span>` : "";
      const statusChip = `<span class="chip ${esc(st.status || "")}">${esc(st.status || "—")}</span>`;
      const title = `<div class="tt-title">${esc(st.name)}${prov}${statusChip}</div>`;
      const eps = payloadBothUndocumented(st)
        ? `<div class="tt-eps">payload not documented</div>`
        : `<div class="tt-eps"><span>${esc(sysName(src))} [${epSummary(st.source)}]</span>` +
          `<span class="tt-arrow">${arrow}</span>` +
          `<span>${esc(sysName(dst))} [${epSummary(st.destination)}]</span></div>`;
      const contract = `<div class="tt-contract">${ttKv("Timing", st.timing)}${ttKv("API", st.api_type)}${ttKv("Format", st.data_format)}</div>`;
      const needs = needNames(st.biz_need_ids);
      const needsRow = needs.length ? `<div class="tt-needs">${needs.map((n) => `<span class="chip">${esc(n)}</span>`).join("")}</div>` : "";
      return `${head}${title}${eps}${contract}${needsRow}<div class="tt-hint">click to dig in</div>`;
    }

    // Aggregated strand: pair header + status breakdown + per-stream rows
    // that each carry their own true direction, format, and needs.
    const head = l.loop
      ? `<div class="tt-head"><b>${esc(sysName(l.a))}</b> internal flow</div>`
      : `<div class="tt-head"><b>${esc(sysName(l.a))}</b> ${l.dirBA ? "&#8596;" : "&#8594;"} <b>${esc(sysName(l.b))}</b></div>`;
    const stats = `<div class="tt-stats">${plural(l.streams.length, "stream")} · ${statusBreakdown(l.streams)}</div>`;
    const rows = l.streams.slice(0, 5).map((st) => {
      const api = st.api_type ? " · " + esc(st.api_type) : "";
      const fmt = st.data_format ? " · " + esc(st.data_format) : "";
      return `<div class="tt-row"><span><span class="tt-dir">${dirGlyph(st, l)}</span>${esc(st.name)}</span>` +
        `<span class="tt-meta">${esc(st.status || "—")} · ${esc(st.timing || "—")}${api}${fmt}${needTail(st)}</span></div>`;
    }).join("");
    const more = l.streams.length > 5 ? `<div class="tt-meta">+${l.streams.length - 5} more…</div>` : "";
    return `${head}${stats}${rows}${more}<div class="tt-hint">click to dig in</div>`;
  }

  function nodeTooltip(n) {
    const inc = links.filter((l) => l.a === n.id || l.b === n.id)
      .reduce((sum, l) => sum + l.streams.length, 0);
    const ents = (n.entities ?? []).length;
    const flds = (n.entities ?? []).reduce((s, e) => s + (e.fields ?? []).length, 0);
    return `<b>${esc(n.name)}</b> <span class="tt-meta">${esc(n.type)}</span>` +
      (n.description ? `<div>${esc(n.description)}</div>` : "") +
      `<div class="tt-meta">${plural(inc, "stream")} · ${plural(ents, "entity", "entities")} · ${plural(flds, "field")}</div>`;
  }

  // ---- cluster hulls ("the plate") — plan §2.1–2.5 ----

  const hullCurve = d3.line()
    .x((d) => d[0]).y((d) => d[1])
    .curve(d3.curveCatmullRomClosed.alpha(0.8));

  // Expand ring points outward from centroid by HULL_PAD.
  function expandHullPts(pts) {
    if (!pts.length) return pts;
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    return pts.map(([x, y]) => {
      const dx = x - cx, dy = y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return [x + (dx / len) * HULL_PAD, y + (dy / len) * HULL_PAD];
    });
  }

  // Geometry for one cluster from currently visible member nodes only.
  // 0 → null (render nothing). 1 → circle. 2 → pair + ghost points. 3+ → hull.
  function hullGeom(memberNodes) {
    const pts = memberNodes
      .filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y))
      .map((n) => [n.x, n.y]);
    if (pts.length === 0) return null;
    if (pts.length === 1) {
      const [x, y] = pts[0];
      // Closed circle as a path (no arc NaN risk for e2e).
      const r = HULL_PAD;
      const path = `M${x + r},${y} A${r},${r} 0 1,0 ${x - r},${y} A${r},${r} 0 1,0 ${x + r},${y} Z`;
      // Top/bottom anchors: 10 graph-units outside the plate (current top behavior).
      return {
        path,
        topAnchor: [x, y - r - 10],
        bottomAnchor: [x, y + r + 10],
      };
    }
    let ring;
    if (pts.length === 2) {
      // Capsule / soft oval: two members + two ghosts at the segment midpoint,
      // perpendicular ±HULL_PAIR_GHOST. Control points MUST walk the diamond
      // in cyclic boundary order (A → G+ → B → G−). Order A → B → G+ → G−
      // makes curveCatmullRomClosed self-intersect (butterfly / figure-8).
      const [[x1, y1], [x2, y2]] = pts;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const px = (-dy / len) * HULL_PAIR_GHOST, py = (dx / len) * HULL_PAIR_GHOST;
      const gPlus = [mx + px, my + py];
      const gMinus = [mx - px, my - py];
      ring = expandHullPts([[x1, y1], gPlus, [x2, y2], gMinus]);
    } else {
      // d3.polygonHull returns null (or <3 pts) for collinear sets — fall back
      // to a padded ring over all member points so the plate still appears.
      const hull = d3.polygonHull(pts);
      if (hull && hull.length >= 3) {
        ring = expandHullPts(hull);
      } else {
        // Treat as a multi-point strip: expand every point from the centroid.
        ring = expandHullPts(pts);
        if (ring.length < 3) return null;
      }
    }
    const path = hullCurve(ring);
    if (!path || path.includes("NaN")) return null;
    // Topmost / bottommost ring points for label anchors (middle, 10 graph-units out).
    let top = ring[0], bot = ring[0];
    for (const p of ring) {
      if (p[1] < top[1]) top = p;
      if (p[1] > bot[1]) bot = p;
    }
    return {
      path,
      topAnchor: [top[0], top[1] - 10],
      bottomAnchor: [bot[0], bot[1] + 10],
    };
  }

  function clusterTooltip(c, memberCount) {
    const nNeeds = (c.biz_need_ids ?? []).length;
    const meta = nNeeds > 0
      ? `${plural(memberCount, "system")} · ${plural(nNeeds, "need")}`
      : plural(memberCount, "system");
    return `<b>${esc(c.name)}</b>` +
      `<div class="tt-meta">${esc(meta)}</div>` +
      (c.description ? `<div>${esc(c.description)}</div>` : "");
  }

  // Hull opacity triple from §2.1 for the given visual state.
  function hullOpacities(state) {
    if (state === "selected") return { fill: 0.12, stroke: 0.90 };
    if (state === "hover") return { fill: 0.07, stroke: 0.65 };
    if (state === "dimmed") return { fill: 0.03, stroke: 0.15 };
    return { fill: 0.07, stroke: 0.45 }; // normal
  }

  function clusterHullState(c) {
    if (selection?.type === "cluster" && selection.id === c.id) return "selected";
    if (hullHoverId === c.id) return "hover";
    // Dim when filter is active and no visible member is matched.
    const dimming = mode === "dim" && active();
    if (dimming) {
      const members = (c.system_ids ?? [])
        .map((id) => nodes.find((n) => n.id === id))
        .filter(Boolean);
      if (!members.length || !members.some((n) => nodeMatched(n))) return "dimmed";
    }
    return "normal";
  }

  function labelCounterScale() {
    const kc = Math.max(0.4, Math.min(2.5, zoomK));
    return 1 / kc;
  }

  // FU-1: label box estimate in screen px (counter-scale keeps size constant).
  const HULL_LABEL_H = 11;
  const HULL_LABEL_CHAR_W = 6.5;
  const HULL_LABEL_NUDGE = 15; // screen px per step
  const HULL_LABEL_MAX_NUDGE = 2;

  function hullLabelBoxW(cluster) {
    const nameUp = String(cluster.name || "").toUpperCase();
    const nNeeds = (cluster.biz_need_ids ?? []).length;
    const tail = nNeeds > 0 ? ` · ${plural(nNeeds, "need")}` : "";
    return (nameUp.length + tail.length) * HULL_LABEL_CHAR_W;
  }

  // FU-1 placement: mutates row.lx/ly. Screen-space boxes; never hide.
  // Priority: top → nudge up ×2 → bottom → nudge down ×2 → accept bottom.
  function applyHullLabelPlacement(rows) {
    if (!rows.length) return;
    const t = d3.zoomTransform(svg.node());
    const k = t.k || 1;
    // HUD obstacle: outermost container (#filter-hud-container), padded 6px,
    // converted to svg-relative coords. Absent when filter HUD is off.
    let hudBox = null;
    const hudEl = document.getElementById("filter-hud-container");
    if (hudEl) {
      const hr = hudEl.getBoundingClientRect();
      const sr = svg.node().getBoundingClientRect();
      if (hr.width > 0 && hr.height > 0) {
        const pad = 6;
        hudBox = {
          left: hr.left - sr.left - pad,
          top: hr.top - sr.top - pad,
          right: hr.right - sr.left + pad,
          bottom: hr.bottom - sr.top + pad,
        };
      }
    }
    const boxesHit = (a, b) =>
      Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 &&
      Math.abs(a.cy - b.cy) < HULL_LABEL_H + 4;
    const hitsHud = (cx, cy, w) => {
      if (!hudBox) return false;
      const left = cx - w / 2, right = cx + w / 2;
      const top = cy - HULL_LABEL_H / 2, bottom = cy + HULL_LABEL_H / 2;
      return !(right < hudBox.left || left > hudBox.right ||
        bottom < hudBox.top || top > hudBox.bottom);
    };
    const clearOf = (cx, cy, w, placed) => {
      if (hitsHud(cx, cy, w)) return false;
      const cand = { cx, cy, w };
      return !placed.some((p) => boxesHit(cand, p));
    };
    // Process topmost-first (screen y asc), then cluster id.
    const order = rows.slice().sort((a, b) => {
      const ay = t.applyY(a.topAnchor[1]);
      const by = t.applyY(b.topAnchor[1]);
      return ay - by || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    const placed = [];
    for (const row of order) {
      const w = row.lw;
      let bestGx = row.bottomAnchor[0];
      let bestGy = row.bottomAnchor[1];
      let found = false;
      // 1–2: try top, then nudge upward (screen) up to 2 steps of 15px.
      for (let step = 0; step <= HULL_LABEL_MAX_NUDGE && !found; step++) {
        const gx = row.topAnchor[0];
        const gy = row.topAnchor[1] - (step * HULL_LABEL_NUDGE) / k;
        const cx = t.applyX(gx), cy = t.applyY(gy);
        if (clearOf(cx, cy, w, placed)) {
          bestGx = gx; bestGy = gy; found = true;
        }
      }
      // 3–4: try bottom, then nudge downward up to 2 steps.
      for (let step = 0; step <= HULL_LABEL_MAX_NUDGE && !found; step++) {
        const gx = row.bottomAnchor[0];
        const gy = row.bottomAnchor[1] + (step * HULL_LABEL_NUDGE) / k;
        const cx = t.applyX(gx), cy = t.applyY(gy);
        if (clearOf(cx, cy, w, placed)) {
          bestGx = gx; bestGy = gy; found = true;
        }
      }
      // 5: accept bottom with overlap (never hide).
      row.lx = bestGx;
      row.ly = bestGy;
      placed.push({ cx: t.applyX(bestGx), cy: t.applyY(bestGy), w });
    }
  }

  function applyHullLabelTransforms() {
    const s = labelCounterScale();
    hullG.selectAll("g.hull-label").attr("transform", function () {
      const d = d3.select(this).datum();
      if (!d || !Number.isFinite(d.lx) || !Number.isFinite(d.ly)) return null;
      return `translate(${d.lx},${d.ly}) scale(${s})`;
    });
  }

  // Pan/zoom-only: re-place existing hull rows vs HUD + counter-scale transforms.
  // Skips path/tspan rebuild and event rebind (nodes unmoved on pure viewport change).
  function updateHullLabelPlacement() {
    const rows = [];
    hullG.selectAll("g.hull").each(function (d) {
      if (d && d.topAnchor && d.bottomAnchor && Number.isFinite(d.lw)) rows.push(d);
    });
    if (!rows.length) return;
    applyHullLabelPlacement(rows);
    // Keep g.hull-label datum in sync with mutated row (same object ref).
    hullG.selectAll("g.hull").each(function (d) {
      d3.select(this).select("g.hull-label").datum(d);
    });
    applyHullLabelTransforms();
  }

  // Recompute hull paths + labels from current node positions.
  // Called from paint() and the sim tick (same places strand paths move).
  // Viewport pan/zoom uses updateHullLabelPlacement() instead (FU-1).
  function paintHulls() {
    if (!lastData) {
      hullG.selectAll("*").remove();
      return;
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const rows = [];
    for (const c of clusters) {
      const members = (c.system_ids ?? []).map((id) => byId.get(id)).filter(Boolean);
      const geom = hullGeom(members);
      if (!geom) continue;
      rows.push({
        id: c.id,
        cluster: c,
        path: geom.path,
        topAnchor: geom.topAnchor,
        bottomAnchor: geom.bottomAnchor,
        // Defaults; FU-1 placement overwrites lx/ly below.
        lx: geom.topAnchor[0],
        ly: geom.topAnchor[1],
        lw: hullLabelBoxW(c),
        memberCount: members.length,
        hex: clusterHex(c.color),
        state: clusterHullState(c),
      });
    }

    applyHullLabelPlacement(rows);

    const sel = hullG.selectAll("g.hull").data(rows, (d) => d.id);
    sel.exit().remove();
    const enter = sel.enter().append("g")
      .attr("class", "hull")
      .attr("cursor", "pointer");
    enter.append("path")
      .attr("class", "hull-plate")
      .attr("stroke-width", 1.5)
      .attr("fill-rule", "evenodd");
    const labEnter = enter.append("g").attr("class", "hull-label").attr("pointer-events", "none");
    labEnter.append("text")
      .attr("class", "hull-label-text")
      .attr("text-anchor", "middle")
      .attr("font-size", 9.5)
      .attr("letter-spacing", 1.5)
      .attr("fill-opacity", 0.9)
      .attr("paint-order", "stroke")
      .attr("stroke", COLORS.page)
      .attr("stroke-width", 3);
    const all = enter.merge(sel);
    all.each(function (d) {
      const g = d3.select(this);
      const plate = g.select("path.hull-plate");
      const op = hullOpacities(d.state);
      plate
        .attr("d", d.path)
        .attr("fill", d.hex)
        .attr("stroke", d.hex)
        .attr("fill-opacity", op.fill)
        .attr("stroke-opacity", op.stroke);
      const nNeeds = (d.cluster.biz_need_ids ?? []).length;
      const nameUp = String(d.cluster.name || "").toUpperCase();
      const labelText = g.select("text.hull-label-text");
      labelText.selectAll("tspan").remove();
      labelText.attr("fill", d.hex).text(nameUp);
      if (nNeeds > 0) {
        labelText.append("tspan")
          .attr("letter-spacing", 0.5)
          .text(` · ${plural(nNeeds, "need")}`);
      }
      const s = labelCounterScale();
      g.select("g.hull-label")
        .datum(d)
        .attr("transform", `translate(${d.lx},${d.ly}) scale(${s})`);
    });
    all
      .on("click", (e, d) => {
        e.stopPropagation();
        // Shift-click on a hull is a no-op (hulls are not group members).
        if (e.shiftKey) return;
        hideTooltip();
        onSelect({ type: "cluster", id: d.id });
      })
      .on("mouseenter", function (e, d) {
        hullHoverId = d.id;
        // Update only this hull's opacities for hover (no transition).
        const op = hullOpacities(clusterHullState(d.cluster));
        d3.select(this).select("path.hull-plate")
          .attr("fill-opacity", op.fill)
          .attr("stroke-opacity", op.stroke);
        showTooltip(e, clusterTooltip(d.cluster, d.memberCount));
      })
      .on("mousemove", moveTooltip)
      .on("mouseleave", function (e, d) {
        if (hullHoverId === d.id) hullHoverId = null;
        const op = hullOpacities(clusterHullState(d.cluster));
        d3.select(this).select("path.hull-plate")
          .attr("fill-opacity", op.fill)
          .attr("stroke-opacity", op.stroke);
        hideTooltip();
      });

    // §2.5 create animation: stroke-dashoffset draw → fill fade → label appear.
    // Gate behind reducedMotion() / ?e2e so the harness sees the end state.
    for (const id of [...pendingHullAnim]) {
      const row = rows.find((r) => r.id === id);
      if (!row) { pendingHullAnim.delete(id); continue; }
      const g = all.filter((d) => d.id === id);
      if (g.empty()) { pendingHullAnim.delete(id); continue; }
      pendingHullAnim.delete(id);
      const plate = g.select("path.hull-plate");
      const label = g.select("g.hull-label");
      if (reducedMotion()) {
        // Instant final state already applied above.
        continue;
      }
      const node = plate.node();
      let len = 0;
      try { len = node.getTotalLength(); } catch { len = 400; }
      if (!Number.isFinite(len) || len <= 0) len = 400;
      const finalFill = hullOpacities(row.state).fill;
      plate
        .attr("fill-opacity", 0)
        .attr("stroke-dasharray", len)
        .attr("stroke-dashoffset", len);
      label.attr("opacity", 0);
      plate.transition().duration(400)
        .attr("stroke-dashoffset", 0)
        .on("end", () => {
          plate.attr("stroke-dasharray", null).attr("stroke-dashoffset", null);
          plate.transition().duration(150)
            .attr("fill-opacity", finalFill)
            .on("end", () => {
              label.transition().duration(120).attr("opacity", 1);
            });
        });
    }
  }

  // ---- legend (inside the SVG so exports carry it) ----

  // Collapsible so it stops eating canvas on small windows; the preference is
  // global (not per project) and exports always render it open.
  let legendOpen = localStorage.getItem("sm.legendOpen") !== "false";

  function placeLegend() {
    const { h } = size();
    legendG.attr("transform", `translate(14, ${h - (legendOpen ? 172 : 42)})`);
  }

  function drawLegend() {
    legendG.selectAll("*").remove();
    // DR-11: no legend on an empty map — it competes with the empty-state copy.
    if (!nodes.length) {
      legendG.attr("display", "none");
      return;
    }
    legendG.attr("display", null);
    legendG.append("rect")
      .attr("width", 172).attr("height", legendOpen ? 158 : 28).attr("rx", 8)
      .attr("fill", COLORS.panel).attr("stroke", COLORS.line).attr("opacity", 0.92);
    const head = legendG.append("g").attr("cursor", "pointer")
      .on("click", () => {
        legendOpen = !legendOpen;
        try { localStorage.setItem("sm.legendOpen", String(legendOpen)); } catch {}
        drawLegend();
      });
    head.append("rect").attr("width", 172).attr("height", 28).attr("fill", "transparent");
    head.append("text").attr("x", 12).attr("y", 18)
      .attr("font-size", 9.5).attr("letter-spacing", 1.5).attr("fill", COLORS.muted)
      .text("LEGEND");
    head.append("text").attr("x", 160).attr("y", 18).attr("text-anchor", "end")
      .attr("font-size", 9).attr("fill", COLORS.muted)
      .text(legendOpen ? "▾" : "▸");
    if (!legendOpen) { placeLegend(); return; }
    const rows = [
      { dot: COLORS.nodeStroke.internal, label: "internal system" },
      { dot: COLORS.nodeStroke.external, label: "external system" },
      { dot: COLORS.nodeStroke.unknown, dash: true, label: "unknown system" },
      { line: null, label: "implemented / mixed" },
      { line: "7,5", label: "all planned" },
      { line: "2,4", label: "all unknown" },
      { badge: true, label: "streams on link" },
    ];
    rows.forEach((r, i) => {
      const g = legendG.append("g").attr("transform", `translate(12, ${36 + i * 17})`);
      if (r.dot) {
        g.append("circle").attr("cx", 8, 0).attr("r", 5)
          .attr("fill", COLORS.node).attr("stroke", r.dot).attr("stroke-width", 2)
          .attr("stroke-dasharray", r.dash ? "2,2" : null);
      } else if (r.badge) {
        g.append("circle").attr("cx", 8).attr("r", 6.5)
          .attr("fill", COLORS.badgeFill).attr("stroke", COLORS.strandHi).attr("stroke-width", 1.2);
        g.append("text").attr("x", 8).attr("y", 2.8).attr("text-anchor", "middle")
          .attr("font-size", 8).attr("font-weight", 700).attr("fill", COLORS.badgeText).text("3");
      } else {
        g.append("path").attr("d", "M0,0 L16,0")
          .attr("stroke", COLORS.strand).attr("stroke-width", 2.4)
          .attr("stroke-dasharray", r.line).attr("marker-end", "url(#arr)");
      }
      g.append("text").attr("x", 26).attr("y", 3.5)
        .attr("font-size", 10.5).attr("fill", COLORS.label2).text(r.label);
    });
    placeLegend();
  }
  drawLegend();

  // ---- layout persistence ----
  // (A)+(A′)+(B) from the version-history rework. Two save paths, each with
  // its OWN debounce timer (a drag and a sim-end fire close together; sharing
  // a timer would let the new-nodes-only call clobber the drag's full-save):
  //   • scheduleLayoutSave        — FULL posCache save (drag end / dblclick).
  //   • scheduleLayoutSaveNewNodes — sim-end save persisting only nodes that
  //     lack a saved position (random placements) + dropping stale entries.
  // Both funnel through sendLayout, which skips the PUT when the payload is
  // byte-identical to the last sent layout (the (B) no-op guard).

  function snapshotPositions() {
    for (const n of nodes) posCache.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy });
  }

  // Canonical, order-independent layout signature for the (B) no-op guard.
  const canonLayout = (out) =>
    Object.keys(out).sort()
      .map((k) => k + ":" + Math.round(out[k].x) + "," + Math.round(out[k].y) + "," + (out[k].pinned ? 1 : 0))
      .join("|");

  const sendLayout = (out) => {
    if (!onLayoutChange) return;
    const canon = canonLayout(out);
    if (canon === lastSavedLayout) return; // (B) no-op guard: skip no-op PUTs
    lastSavedLayout = canon;
    savedLayout = new Map(Object.entries(out));
    onLayoutChange(out);
  };

  // Full posCache save — the payload for drag end / dblclick (all current
  // nodes at their positions, the moved node + jitter-frozen unpinned nodes).
  const doFullSave = () => {
    snapshotPositions();
    const out = {};
    for (const [id, p] of posCache) {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        out[id] = { x: Math.round(p.x), y: Math.round(p.y), pinned: p.fx != null };
      }
    }
    sendLayout(out);
  };

  function scheduleLayoutSave() {
    if (!onLayoutChange) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; doFullSave(); }, 800);
  }

  // (A′) sim-end saver: keep the saved position for every existing current
  // node (so deterministic re-settle jitter on existing nodes is a no-op), and
  // persist the placed position only for nodes NOT in savedLayout (the random
  // placement case). Nodes that have disappeared (deleted) are absent from
  // `nodes` and so drop out of `out` — this also cleans stale entries.
  function scheduleLayoutSaveNewNodes() {
    if (!onLayoutChange) return;
    clearTimeout(newNodeSaveTimer);
    newNodeSaveTimer = setTimeout(() => {
      snapshotPositions();
      const out = {};
      for (const n of nodes) {
        const p = posCache.get(n.id);
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const saved = savedLayout.get(n.id);
        out[n.id] = saved
          ? { x: saved.x, y: saved.y, pinned: saved.pinned }
          : { x: Math.round(p.x), y: Math.round(p.y), pinned: p.fx != null };
      }
      sendLayout(out);
    }, 800);
  }

  // ---- rendering ----

  function rebuild() {
    if (!lastData) return;
    const { w, h } = size();

    const hiding = mode === "hide" && active();
    const allLinks = expand ? expandLinks(lastData) : aggregate(lastData);

    const keepLink = (l) => !hiding || linkMatched(l);
    const keepNode = (n) => !hiding || nodeMatched(n);

    snapshotPositions();

    // (§1.5) Place new nodes (no cached position) at the centroid of the
    // existing nodes + a small random offset, so a new system appears inside
    // the cluster where the user is looking — not flung to canvas center or
    // the periphery. Fall back to canvas center when there are no cached nodes.
    let cx = 0, cy = 0, cn = 0;
    for (const p of posCache.values()) {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) { cx += p.x; cy += p.y; cn++; }
    }
    const centroidX = cn ? cx / cn : w / 2;
    const centroidY = cn ? cy / cn : h / 2;

    nodes = lastData.systems.filter(keepNode).map((s) => {
      const cached = posCache.get(s.id);
      return {
        ...s,
        x: cached?.x ?? centroidX + (Math.random() - 0.5) * 40,
        y: cached?.y ?? centroidY + (Math.random() - 0.5) * 40,
        fx: cached?.fx ?? null, fy: cached?.fy ?? null,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Resolve source/target to node objects for ALL render links (not just
    // those in the simulation) so parallel links in Expand mode that are
    // deduped out of the force still follow the nodes they share. forceLink
    // moves nodes, and every link points at the same node objects.
    links = allLinks.filter((l) => keepLink(l) && byId.has(l.a) && byId.has(l.b))
      .map((l) => ({ ...l, source: byId.get(l.a), target: byId.get(l.b) }));

    emptyNote.style.display = nodes.length ? "none" : "flex";
    drawLegend(); // DR-11: show/hide with node count

    // -- links: visible strand + wide invisible hit area --
    const linkSel = linkG.selectAll("g.link").data(links, (d) => d.key);
    linkSel.exit().remove();
    const linkEnter = linkSel.enter().append("g").attr("class", "link").attr("cursor", "pointer");
    linkEnter.append("path").attr("class", "hit")
      .attr("fill", "none").attr("stroke", "transparent").attr("stroke-width", 16);
    linkEnter.append("path").attr("class", "strand")
      .attr("fill", "none").attr("stroke-linecap", "butt");
    const linkAll = linkEnter.merge(linkSel);
    linkAll.select(".strand")
      .attr("stroke-width", (d) => (expand ? 2.4 : widthScale(d.streams.length)))
      .attr("stroke-dasharray", linkDash);
    linkAll
      .on("click", (e, d) => {
        e.stopPropagation();
        // Shift-click on an edge is a no-op (edges are not group members).
        if (e.shiftKey) return;
        hideTooltip();
        onSelect({ type: "edge", a: d.a, b: d.b });
      })
      .on("mouseenter", function (e, d) {
        paintLink(d3.select(this), true);
        showTooltip(e, linkTooltip(d));
      })
      .on("mousemove", moveTooltip)
      .on("mouseleave", function () { paintLink(d3.select(this), false); hideTooltip(); });

    // -- badges (stream count) --
    const badgeSel = badgeG.selectAll("g.badge").data(links.filter((l) => l.streams.length > 1), (d) => d.key);
    badgeSel.exit().remove();
    const badgeEnter = badgeSel.enter().append("g").attr("class", "badge").attr("pointer-events", "none");
    badgeEnter.append("circle").attr("r", 9)
      .attr("fill", COLORS.badgeFill).attr("stroke", COLORS.strandHi).attr("stroke-width", 1.4);
    badgeEnter.append("text")
      .attr("text-anchor", "middle").attr("dy", "0.34em")
      .attr("font-size", 10).attr("font-weight", 700).attr("fill", COLORS.badgeText);
    badgeEnter.merge(badgeSel).select("text").text((d) => d.streams.length);

    // -- labels: every strand in Expand mode, only single-stream edges in Bundle --
    const trunc = (s) => (s.length > 22 ? s.slice(0, 21) + "…" : s);
    const labelData = expand ? links : links.filter((l) => l.streams.length === 1);
    const labelSel = labelG.selectAll("text.elabel").data(labelData, (d) => d.key);
    labelSel.exit().remove();
    labelSel.enter().append("text").attr("class", "elabel")
      .attr("text-anchor", "middle").attr("pointer-events", "none")
      .attr("font-size", 10.5).attr("fill", COLORS.label2)
      .attr("stroke", COLORS.page).attr("stroke-width", 3).attr("paint-order", "stroke")
      .merge(labelSel)
      .text((d) => trunc(d.streams[0].name));

    // -- nodes --
    const nodeSel = nodeG.selectAll("g.node").data(nodes, (d) => d.id);
    nodeSel.exit().remove();
    const nodeEnter = nodeSel.enter().append("g").attr("class", "node").attr("cursor", "pointer");
    nodeEnter.append("circle").attr("class", "halo")
      .attr("r", 21).attr("fill", "none").attr("stroke", COLORS.strandHi)
      .attr("stroke-width", 2).attr("visibility", "hidden");
    nodeEnter.append("circle").attr("class", "body").attr("r", NODE_R).attr("fill", COLORS.node);
    nodeEnter.append("text").attr("class", "nlabel")
      .attr("text-anchor", "middle").attr("y", 30)
      .attr("font-size", 12).attr("font-weight", 600)
      .attr("fill", COLORS.label)
      .attr("stroke", COLORS.page).attr("stroke-width", 3.5).attr("paint-order", "stroke");
    const nodeAll = nodeEnter.merge(nodeSel);
    nodeAll.select(".body")
      .attr("stroke", (d) => COLORS.nodeStroke[d.type] || COLORS.nodeStroke.unknown)
      .attr("stroke-width", 2.5)
      .attr("stroke-dasharray", (d) => (d.type === "internal" || d.type === "external" ? null : "3,3"));
    nodeAll.select(".nlabel").text((d) => d.name);
    nodeAll
      .on("click", (e, d) => {
        e.stopPropagation();
        hideTooltip();
        // Shift-click toggles membership; plain click replaces with single-select.
        if (e.shiftKey) toggleNodeInSelection(d.id);
        else onSelect({ type: "node", id: d.id });
      })
      .on("dblclick", (e, d) => { d.fx = d.fy = null; sim.alpha(0.25).restart(); scheduleLayoutSave(); })
      .on("mouseenter", (e, d) => showTooltip(e, nodeTooltip(d)))
      .on("mousemove", moveTooltip)
      .on("mouseleave", hideTooltip)
      .call(d3.drag()
        // Shift is multi-select, not drag. Keep left-button only (matches d3 default).
        .filter((e) => !e.shiftKey && e.button === 0)
        .on("start", (e, d) => {
          if (!e.active) sim.alphaTarget(0.25).restart();
          hideTooltip();
          // Group drag: move every member by the same delta when the grabbed
          // node is in the current group. Otherwise drag that node alone —
          // selection does not change either way.
          const inGroup = selection?.type === "group" && selection.ids.includes(d.id);
          if (inGroup) {
            const starts = new Map();
            for (const id of selection.ids) {
              const n = nodes.find((x) => x.id === id);
              if (n) {
                starts.set(id, { x: n.x, y: n.y });
                n.fx = n.x; n.fy = n.y;
              }
            }
            groupDrag = { starts, ox: d.x, oy: d.y };
          } else {
            groupDrag = null;
            d.fx = d.x; d.fy = d.y;
          }
        })
        .on("drag", (e, d) => {
          // (§1.5) clamp into the viewport so nodes can't be parked off-canvas
          // (fixed nodes bypass the tick clamp). Group drag clamps the whole
          // formation's bounding box with one shared delta — never squash.
          const { w: dw, h: dh } = size();
          const m = NODE_R + 8;
          if (groupDrag) {
            let dx = e.x - groupDrag.ox;
            let dy = e.y - groupDrag.oy;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const s of groupDrag.starts.values()) {
              minX = Math.min(minX, s.x + dx);
              maxX = Math.max(maxX, s.x + dx);
              minY = Math.min(minY, s.y + dy);
              maxY = Math.max(maxY, s.y + dy);
            }
            if (minX < m) dx += m - minX;
            if (maxX > dw - m) dx -= maxX - (dw - m);
            if (minY < m) dy += m - minY;
            if (maxY > dh - m) dy -= maxY - (dh - m);
            for (const [id, s] of groupDrag.starts) {
              const n = nodes.find((x) => x.id === id);
              if (!n) continue;
              n.fx = s.x + dx; n.fy = s.y + dy;
              n.x = n.fx; n.y = n.fy;
            }
          } else {
            d.fx = Math.max(m, Math.min(dw - m, e.x));
            d.fy = Math.max(m, Math.min(dh - m, e.y));
          }
        })
        .on("end", (e) => {
          if (!e.active) sim.alphaTarget(0);
          groupDrag = null;
          scheduleLayoutSave();
        }));

    // -- simulation (self-loops render but exert no force) --
    // One force link per unordered pair, even in Expand mode, so the
    // simulation's pull between two nodes is independent of how many streams
    // run between them (otherwise expanded pairs would clump).
    const simLinks = [];
    const simSeen = new Set();
    for (const l of links) {
      if (l.loop) continue;
      const pk = l.a < l.b ? `${l.a}~${l.b}` : `${l.b}~${l.a}`;
      if (simSeen.has(pk)) continue;
      simSeen.add(pk);
      simLinks.push(l);
    }
    if (sim) sim.stop();
    sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(simLinks).id((d) => d.id).distance(160).strength(0.5))
      .force("charge", d3.forceManyBody().strength(-520))
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("collide", d3.forceCollide(48))
      .on("tick", () => {
        // (§1.5) Viewport clamp on every tick: nodes can never leave the
        // visible canvas, so a flung new/unpinned node is always catchable.
        const m = NODE_R + 8;
        for (const n of nodes) {
          n.x = Math.max(m, Math.min(w - m, n.x));
          n.y = Math.max(m, Math.min(h - m, n.y));
        }
        const linkNow = linkG.selectAll("g.link");
        linkNow.select(".hit").attr("d", strandPath);
        linkNow.select(".strand").attr("d", strandPath);
        badgeG.selectAll("g.badge").attr("transform", (d) => `translate(${d._mid?.[0] ?? 0},${d._mid?.[1] ?? 0})`);
        positionStages();
        positionEdgeLabels();
        nodeG.selectAll("g.node").attr("transform", (d) => `translate(${d.x},${d.y})`);
        paintHulls(); // plate stretches live during drags (§2.2)
        scheduleMinimap();
      })
      // (A)+(A′)+(§1.5) The sim is a one-shot auto-placer: when it settles,
      // pin every unpinned node at its settled position (so the layout freezes
      // and won't re-flow on later rebuilds), then persist only the nodes that
      // lack a saved position. The unconditional sim-end save (the chatter
      // source) is gone; drag/dblclick keep their own full-save.
      .on("end", () => {
        for (const n of nodes) if (n.fx == null) { n.fx = n.x; n.fy = n.y; }
        if (autoFitPending) { autoFitPending = false; fitToView(); }
        snapshotPositions();
        // If a drag/dblclick full-save is pending, flush it now — after
        // auto-pin — so it captures the re-pinned state (not a mid-flight
        // unpinned one) regardless of how long the sim took to settle.
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; doFullSave(); }
        scheduleLayoutSaveNewNodes();
      });
    // (§1.5) Lower the new-node alpha (0.9 -> 0.3) so new nodes aren't booted
    // with high energy; keep 0.25 when every node already has a cached
    // position (a re-settle of an existing layout).
    sim.alpha(nodes.every((n) => posCache.has(n.id)) ? 0.25 : 0.3).restart();

    // Saved layouts barely move during the re-settle — fit right away
    // (no animation) instead of waiting for the sim to wind down. Fresh
    // auto-placements keep autoFitPending armed for the sim-end fit.
    if (autoFitPending && nodes.length && nodes.every((n) => posCache.has(n.id))) {
      autoFitPending = false;
      fitToView(false);
    }

    paint();
  }

  function paintLink(sel, hover = false) {
    const marker = (on, hi) => (on ? `url(#${hi ? "arr-hi" : "arr"})` : null);
    const overlayOwnsDirection = (d) => filters.flow && flowRowsCache.some((r) => r.link.key === d.key);
    const linkHi = (d) =>
      hover ||
      (selection?.type === "edge" && selection.a === d.a && selection.b === d.b) ||
      !!(highlightStreamIds && d.streams.some((s) => highlightStreamIds.has(s.id)));
    sel.select(".strand")
      .attr("stroke", (d) => (linkHi(d) ? COLORS.strandHi : COLORS.strand))
      .attr("marker-end", (d) => {
        if (overlayOwnsDirection(d)) return null;
        return marker(!d.loop && d.dirAB, linkHi(d));
      })
      .attr("marker-start", (d) => {
        if (overlayOwnsDirection(d)) return null;
        return marker(!d.loop && d.dirBA, linkHi(d));
      });
  }

  // Focused-flow overlay: each hop of the flow gets its own amber curve ON
  // its strand, drawn in the hop's actual direction with an arrowhead and a
  // stage chip — so "BF -> DEV1 -> Mule -> BF" reads directly off the map
  // even when a strand carries streams both ways. Count badges hide while a
  // flow is focused so the stage story is the only numbering visible.
  function flowRows() {
    const flow = V?.focusedFlow;
    if (!flow) return [];
    const linkByKey = new Map(links.map((l) => [l.key, l]));
    const stById = new Map(lastData.streams.map((s) => [s.id, s]));
    const rows = [];
    const dirCount = new Map();
    for (const step of flow.steps ?? []) {
      const st = stById.get(step.stream_id);
      if (!st) continue;
      const a = st.source.system_id, b = st.destination.system_id;
      const pairKey = a < b ? `${a}~${b}` : `${b}~${a}`;
      // Expand: links are keyed by stream id, so a hop resolves to its OWN
      // curve. Bundle: links are keyed by the unordered pair.
      const link = linkByKey.get(expand ? st.id : pairKey);
      if (!link) continue; // dangling or hidden by hide-mode
      const dir = a === link.a ? "ab" : "ba";
      const dk = pairKey + dir;
      const idx = dirCount.get(dk) ?? 0;
      dirCount.set(dk, idx + 1);
      rows.push({ id: st.id, link, dir, idx, stage: Math.max(1, step.stage || 1) });
    }
    return rows;
  }

  // hop geometry: same curve as the strand, oriented in the hop's direction,
  // bowed a little further out for the 2nd+ hop sharing a strand+direction
  function overlayGeom(d) {
    const l = d.link;
    if (l.loop) {
      const { x, y } = l.source;
      const off = fanOff(l);
      return { path: `M${x - 9 + off},${y - 12} a16,16 0 1,1 18,0`, chip: [x + off, y - 46] };
    }
    const x1 = l.source.x, y1 = l.source.y, x2 = l.target.x, y2 = l.target.y;
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    const bow = Math.min(dist * 0.12, 34) + fanOff(l) + d.idx * 9;
    const mx = (x1 + x2) / 2 - (dy / dist) * bow;
    const my = (y1 + y2) / 2 + (dx / dist) * bow;
    const t1 = Math.hypot(mx - x1, my - y1) || 1;
    const p1 = [x1 + ((mx - x1) / t1) * INSET, y1 + ((my - y1) / t1) * INSET];
    const t2 = Math.hypot(x2 - mx, y2 - my) || 1;
    const p2 = [x2 - ((x2 - mx) / t2) * INSET, y2 - ((y2 - my) / t2) * INSET];
    const [s, e] = d.dir === "ab" ? [p1, p2] : [p2, p1];
    const q = (t) => [
      (1 - t) * (1 - t) * s[0] + 2 * (1 - t) * t * mx + t * t * e[0],
      (1 - t) * (1 - t) * s[1] + 2 * (1 - t) * t * my + t * t * e[1],
    ];
    return { path: `M${s[0]},${s[1]} Q${mx},${my} ${e[0]},${e[1]}`, chip: q(0.55) };
  }

  function paintStages() {
    const rows = flowRowsCache;
    badgeG.attr("display", rows.length ? "none" : null);

    const ov = flowG.selectAll("path.flow-overlay").data(rows, (d) => d.id);
    ov.exit().remove();
    ov.enter().append("path").attr("class", "flow-overlay")
      .attr("fill", "none").attr("stroke", COLORS.strandHi).attr("stroke-width", 2.6)
      .attr("stroke-dasharray", "7,7").attr("stroke-linecap", "round")
      .attr("pointer-events", "none").attr("marker-end", "url(#arr-hi)");

    const chips = stageG.selectAll("g.stage").data(rows, (d) => d.id);
    chips.exit().remove();
    const enter = chips.enter().append("g").attr("class", "stage").attr("pointer-events", "none");
    enter.append("circle").attr("r", 9)
      .attr("fill", COLORS.strandHi).attr("stroke", COLORS.page).attr("stroke-width", 1.5);
    enter.append("text")
      .attr("text-anchor", "middle").attr("dy", "0.34em")
      .attr("font-size", 10).attr("font-weight", 700).attr("fill", COLORS.page);
    chips.merge(enter).select("text").text((d) => d.stage);
    positionStages();
  }

  function positionStages() {
    flowG.selectAll("path.flow-overlay").attr("d", (d) => overlayGeom(d).path);
    stageG.selectAll("g.stage").attr("transform", (d) => {
      const c = overlayGeom(d).chip;
      return `translate(${c[0]},${c[1]})`;
    });
  }

  // Apply dimming, selection highlight, and label visibility without
  // touching the simulation.
  function paint() {
    flowRowsCache = flowRows();
    const dimming = mode === "dim" && active();
    // Geometry is normally advanced by the simulation tick, but set it here
    // too so strands have a path immediately after a rebuild (and in
    // headless / no-tick-yet situations) — positions are already current.
    const linkNow = linkG.selectAll("g.link");
    linkNow.select(".hit").attr("d", strandPath);
    linkNow.select(".strand").attr("d", strandPath);
    linkNow
      .attr("opacity", (d) => (dimming && !linkMatched(d) ? DIM_OPACITY : 1))
      .each(function () { paintLink(d3.select(this)); });
    badgeG.selectAll("g.badge")
      .attr("opacity", (d) => (dimming && !linkMatched(d) ? DIM_OPACITY : 1));
    // Master toggle + density (short edges / collisions) live in one place.
    positionEdgeLabels();
    nodeG.selectAll("g.node")
      .attr("opacity", (d) => (dimming && !nodeMatched(d) ? DIM_OPACITY : 1))
      .select(".halo")
      .attr("visibility", (d) => (haloVisible(d.id) ? "visible" : "hidden"));
    paintHulls();
    paintStages();
    scheduleMinimap();
  }

  // Stamp node transforms + strand geometry from current data coordinates.
  // rebuild() only writes transforms on sim ticks — cloning right after
  // rebuild without this leaves nodes at 0,0 (or stale) while labels float
  // at the real midpoints (that was the broken Map sheet).
  function syncGeometry() {
    const linkNow = linkG.selectAll("g.link");
    linkNow.select(".hit").attr("d", strandPath);
    linkNow.select(".strand").attr("d", strandPath);
    badgeG.selectAll("g.badge").attr("transform", (d) =>
      `translate(${d._mid?.[0] ?? 0},${d._mid?.[1] ?? 0})`);
    positionStages();
    positionEdgeLabels();
    nodeG.selectAll("g.node").attr("transform", (d) => `translate(${d.x},${d.y})`);
    paintHulls();
  }

  return {
    setData(data) {
      lastData = data;
      clusters = data.clusters ?? [];
      clusterById = new Map(clusters.map((c) => [c.id, c]));
      entById = new Map();
      for (const s of data.systems) for (const e of (s.entities ?? [])) entById.set(e.id, e);
      needById = new Map((data.needs ?? []).map((n) => [n.id, n]));
      V = new FilteredView(data, filters, mode);
      // seed positions from the saved layout for nodes we haven't placed yet
      for (const [id, p] of Object.entries(data.layout ?? {})) {
        if (!posCache.has(id)) {
          posCache.set(id, { x: p.x, y: p.y, fx: p.pinned ? p.x : null, fy: p.pinned ? p.y : null });
        }
      }
      // (B) Seed the no-op guard baseline from the saved layout so a freshly
      // loaded layout isn't re-PUT as a no-op commit, and the new-nodes-only
      // saver knows which nodes already have a saved position.
      const seed = {};
      for (const [id, p] of Object.entries(data.layout ?? {})) {
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
          seed[id] = { x: Math.round(p.x), y: Math.round(p.y), pinned: !!p.pinned };
        }
      }
      savedLayout = new Map(Object.entries(seed));
      lastSavedLayout = canonLayout(seed);
      rebuild();
    },
    // resetLayout clears the in-memory positions + the no-op guard baseline so
    // the next setData re-seeds from the incoming layout. Call before a reload
    // that changes the underlying version (restore / undo / redo) — otherwise
    // posCache keeps the pre-version-change positions and the canvas would
    // show the old layout instead of the restored one.
    resetLayout() {
      // Stop the sim and drop the old nodes BEFORE clearing posCache: the
      // next setData's rebuild() starts with snapshotPositions(), and a stale
      // `nodes` array would write the pre-restore positions right back over
      // the freshly seeded restored layout. (d3's sim.stop() doesn't dispatch
      // "end", so no late sim-end snapshot/save can sneak in either.)
      if (sim) sim.stop();
      nodes = [];
      links = [];
      // Cancel pending layout saves: flushing them after the version change
      // would PUT the old layout back on top of the restored head.
      clearTimeout(saveTimer); saveTimer = null;
      clearTimeout(newNodeSaveTimer); newNodeSaveTimer = null;
      posCache.clear();
      savedLayout = new Map();
      lastSavedLayout = "";
      autoFitPending = true; // restored/undone layouts deserve a fresh fit
    },
    fitToView() {
      fitToView();
    },
    focusSelection,
    // Fit to a cluster's members (Focus button in cluster inspector §5.2).
    fitToCluster(id) {
      const c = clusterById.get(id);
      if (!c) return;
      fitToNodeIds(c.system_ids ?? []);
    },
    // Queue the §2.5 create animation for a cluster id (Make cluster flow).
    // Next paintHulls runs it (instant under ?e2e / reduced motion).
    animateClusterCreate(id) {
      if (id) pendingHullAnim.add(id);
      paintHulls();
    },
    // Palette helpers for the inspector/rail (keep hex ownership in the renderer).
    clusterColorKeys: () => CLUSTER_COLOR_KEYS.slice(),
    clusterColorHex: (key) => clusterHex(key),
    // Least-used palette key (ties: table order) for a new cluster.
    leastUsedClusterColor() {
      const counts = Object.fromEntries(CLUSTER_COLOR_KEYS.map((k) => [k, 0]));
      for (const c of clusters) {
        if (c.color && counts[c.color] != null) counts[c.color]++;
      }
      let best = CLUSTER_COLOR_KEYS[0], bestN = Infinity;
      for (const k of CLUSTER_COLOR_KEYS) {
        if (counts[k] < bestN) { bestN = counts[k]; best = k; }
      }
      return best;
    },
    // AJ-6: light carrying strands + endpoint halos for analysis hover.
    // Pass null to clear. No selection/zoom/pan change. No-op under ?e2e.
    highlightStreams(ids) {
      if (new URLSearchParams(location.search).has("e2e")) return;
      if (ids == null || (Array.isArray(ids) && ids.length === 0)) {
        highlightStreamIds = null;
        highlightNodeIds = null;
      } else {
        highlightStreamIds = new Set(ids);
        highlightNodeIds = new Set();
        for (const l of links) {
          if (l.streams.some((s) => highlightStreamIds.has(s.id))) {
            highlightNodeIds.add(l.a);
            highlightNodeIds.add(l.b);
          }
        }
      }
      linkG.selectAll("g.link").each(function () {
        paintLink(d3.select(this), false);
      });
      nodeG.selectAll("g.node").select(".halo")
        .attr("visibility", (d) => (haloVisible(d.id) ? "visible" : "hidden"));
    },
    // Step or set the zoom around the canvas center; scaleExtent clamps.
    zoomBy(factor) {
      zoomTarget(true, 150).call(zoom.scaleBy, factor);
    },
    zoomTo(k) {
      zoomTarget(true, 150).call(zoom.scaleTo, k);
    },
    setFilter(f, m) {
      const wasHiding = mode === "hide" && active();
      filters = f;
      mode = m;
      if (lastData) V = new FilteredView(lastData, filters, mode);
      const nowHiding = mode === "hide" && active();
      if (nowHiding || wasHiding) rebuild();
      else paint();
    },
    setSelection(sel) {
      selection = sel;
      // the hint teaches one thing at a time: how to leave the inspector
      // while it's open, how to work the map otherwise
      hint.textContent = sel ? INSPECTOR_HINT : IDLE_HINT;
      paint();
      scheduleEnsureVisible();
    },
    // Esc priority 1: cancel an in-progress marquee without changing selection.
    isMarqueeActive() { return !!marquee; },
    cancelMarquee() {
      if (!marquee) return false;
      endMarqueeUI();
      suppressBgClick = true;
      return true;
    },
    // Pin / unpin a set of nodes, then one full-layout save (one commit).
    pinNodes(ids) {
      const set = new Set(ids);
      for (const n of nodes) {
        if (!set.has(n.id)) continue;
        n.fx = n.x; n.fy = n.y;
      }
      scheduleLayoutSave();
    },
    unpinNodes(ids) {
      const set = new Set(ids);
      for (const n of nodes) {
        if (!set.has(n.id)) continue;
        n.fx = n.fy = null;
      }
      if (sim) sim.alpha(0.25).restart();
      scheduleLayoutSave();
    },
    // Visible node ids currently on the canvas (hide-mode already removed the rest).
    visibleNodeIds() { return nodes.map((n) => n.id); },
    setExpand(on) {
      on = !!on;
      if (on === expand) return;
      expand = on;
      if (lastData) rebuild();
    },
    setFanSpacing(n) {
      n = Math.max(12, Math.min(80, +n || DEFAULT_FAN_SPACING));
      if (n === fanSpacing) return;
      fanSpacing = n;
      if (lastData) paint();
    },
    setShowEdgeLabels(on) {
      on = !!on;
      if (on === showEdgeLabels) return;
      showEdgeLabels = on;
      if (lastData) paint();
    },
    // buildExportSVG(exportMode):
    //   "viewport" (default) — live canvas: current pan/zoom + filters +
    //     selection chrome. Used by Export → SVG image (WYSIWYG screenshot).
    //   "register" — full project graph for the integration-register Map
    //     sheet: filters/selection/highlights cleared, geometry synced, then
    //     fit-framed so every system is visible. Matches unfiltered Streams
    //     sheets. Live canvas restored after clone (no visibility:hidden —
    //     that attribute was cloned into the export and blanked the PNG).
    // Legend is always open on the export; minimap/HUD stay out (HTML only).
    // Note: parameter is exportMode — not the live filter `mode` binding.
    buildExportSVG(exportMode = "viewport") {
      const forRegister = exportMode === "register";
      const { w, h } = size();
      const svgEl = svg.node();

      const emptyFilters = () => ({
        q: "", scope: "all",
        statuses: new Set(), timings: new Set(), needs: new Set(),
        systems: new Set(), clusters: new Set(), flow: "",
      });

      const restoreLive = (snap) => {
        if (!snap) return;
        filters = snap.filters;
        mode = snap.mode;
        selection = snap.selection;
        highlightStreamIds = snap.highlightStreamIds;
        highlightNodeIds = snap.highlightNodeIds;
        if (lastData) {
          V = new FilteredView(lastData, filters, mode);
          rebuild();
          // rebuild starts the sim; geometry will tick in. Don't leave the
          // canvas frozen at the unfiltered snapshot.
        }
      };

      let snap = null;
      let clone;
      try {
        if (forRegister) {
          snap = {
            filters,
            mode,
            selection,
            highlightStreamIds,
            highlightNodeIds,
          };
          filters = emptyFilters();
          mode = "dim";
          selection = null;
          highlightStreamIds = null;
          highlightNodeIds = null;
          if (lastData) {
            V = new FilteredView(lastData, filters, mode);
            rebuild();
            // Stop the sim so an async tick cannot mutate mid-clone, then
            // stamp transforms/paths from data coords (rebuild alone is not enough).
            if (sim) sim.stop();
            paint();
            syncGeometry();
          }
        }

        const wasOpen = legendOpen;
        if (!wasOpen) { legendOpen = true; drawLegend(); }
        clone = svgEl.cloneNode(true);
        if (!wasOpen) { legendOpen = false; drawLegend(); }
      } finally {
        // Always put the live canvas back before returning or throwing.
        restoreLive(snap);
      }

      clone.setAttribute("width", w);
      clone.setAttribute("height", h);
      clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
      // Defensive: never ship a hidden root (inline style or attribute).
      clone.style.visibility = "";
      clone.style.display = "";
      clone.removeAttribute("visibility");

      // Register path: fit every node into frame on the clone only. Viewport
      // path keeps the live zoom-layer transform (true WYSIWYG).
      if (forRegister) {
        const zl = clone.querySelector("g.zoom-layer");
        // Fit against full system set from lastData (positions in posCache),
        // not the post-restore `nodes` array which may be hide-mode filtered.
        const fitNodes = (lastData?.systems ?? []).map((s) => {
          const p = posCache.get(s.id);
          return { x: p?.x, y: p?.y };
        });
        if (zl && fitNodes.length) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const n of fitNodes) {
            if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
            minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
            minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
          }
          if (Number.isFinite(minX)) {
            const padT = 70, padR = 80, padL = 80, padB = 190; // 190 clears open legend
            const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
            const k = Math.max(0.15, Math.min(
              (w - padL - padR) / bw,
              (h - padT - padB) / bh,
              1.25,
            ));
            const tx = padL + (w - padL - padR) / 2 - k * (minX + maxX) / 2;
            const ty = padT + (h - padT - padB) / 2 - k * (minY + maxY) / 2;
            zl.setAttribute("transform", `translate(${tx},${ty}) scale(${k})`);
          }
        }
      }
      // Transient chrome never belongs in either export.
      clone.querySelector("rect.marquee")?.remove();
      // Selection halos are live-UI chrome; strip them from the register picture.
      if (forRegister) {
        clone.querySelectorAll("g.node .halo").forEach((el) => {
          el.setAttribute("visibility", "hidden");
        });
      }

      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.setAttribute("width", "100%");
      bg.setAttribute("height", "100%");
      bg.setAttribute("fill", COLORS.page);
      clone.insertBefore(bg, clone.firstChild);
      return { svg: new XMLSerializer().serializeToString(clone), w, h };
    },
    exportSVG(name) {
      const { svg: svgStr } = this.buildExportSVG("viewport");
      const blob = new Blob([svgStr], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.svg`;
      a.click();
      URL.revokeObjectURL(url);
    },
    // Rasterize the full-project map for the integration-register Map sheet
    // (register mode: unfiltered + fit). Rejects on any failure so the caller
    // can fall back to a GET without a picture.
    exportMapPNG() {
      return new Promise((resolve, reject) => {
        try {
          const { svg: svgStr, w, h } = this.buildExportSVG("register");
          const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = Math.max(1, Math.round(w * 2));
              canvas.height = Math.max(1, Math.round(h * 2));
              const ctx = canvas.getContext("2d");
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              URL.revokeObjectURL(url);
              canvas.toBlob((png) => {
                if (!png) { reject(new Error("toBlob failed")); return; }
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = reader.result;
                  const b64 = typeof dataUrl === "string" && dataUrl.includes(",")
                    ? dataUrl.split(",")[1]
                    : dataUrl;
                  resolve(b64);
                };
                reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
                reader.readAsDataURL(png);
              }, "image/png");
            } catch (e) {
              URL.revokeObjectURL(url);
              reject(e);
            }
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("SVG image load failed"));
          };
          img.src = url;
        } catch (e) {
          reject(e);
        }
      });
    },
  };
}
