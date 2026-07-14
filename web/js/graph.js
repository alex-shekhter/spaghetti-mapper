// D3 "bird's eye" canvas.
//
// Systems render as nodes; all streams between the same pair of systems
// aggregate into ONE curved strand whose width encodes how many streams it
// carries. Arrowheads show flow direction. Styling is applied as SVG
// attributes (not CSS classes) so the exported SVG file is self-contained,
// including the legend.

import { FilteredView } from "./view.js";
import { flowShape } from "./analysis.js";

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

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const DIM_OPACITY = 0.1;
const NODE_R = 14;
const INSET = NODE_R + 4; // strand endpoints stop at the node rim so arrows show
const LABEL_MIN_ZOOM = 0.8;

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

export function createGraph(container, { onSelect, onLayoutChange }) {
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
  hint.textContent = "drag to pin · double-click to unpin · click an edge to dig in · Esc closes the inspector";
  container.appendChild(hint);

  let zoomK = 1;
  const zoom = d3.zoom()
    .scaleExtent([0.15, 4])
    .on("zoom", (e) => {
      zoomLayer.attr("transform", e.transform);
      if ((zoomK >= LABEL_MIN_ZOOM) !== (e.transform.k >= LABEL_MIN_ZOOM)) {
        zoomK = e.transform.k;
        paint();
      }
      zoomK = e.transform.k;
    });
  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", (e) => {
    if (e.target === svg.node()) onSelect(null);
  });

  let sim = null;
  let nodes = [], links = [];
  let flowRowsCache = []; // hops of the focused flow, resolved to links
  let lastData = null;
  let V = null; // FilteredView — the one source of "what is visible"
  let filters = { q: "", scope: "all", statuses: new Set(), timings: new Set(), needs: new Set(), systems: new Set(), flow: "" };
  let mode = "dim";
  let selection = null;
  const posCache = new Map(); // node id -> {x, y, fx, fy}
  let saveTimer = null;

  const size = () => {
    const r = container.getBoundingClientRect();
    return { w: r.width || 800, h: r.height || 600 };
  };

  new ResizeObserver(() => {
    const { w, h } = size();
    if (sim) sim.force("center", d3.forceCenter(w / 2, h / 2)).alpha(0.1).restart();
    placeLegend();
  }).observe(container);

  const widthScale = (n) => Math.min(1.8 + 2.2 * Math.log2(n + 1), 10);

  // ---- matching (canvas-side composition of the shared matcher) ----

  const active = () => V && V.active;
  const linkMatched = (l) => l.streams.some((st) => V.streamVisible(st));
  const nodeMatched = (n) => !active() || V.systemVisible(n);

  // ---- geometry ----

  // Strand path: a quadratic curve bowing perpendicular to the line, with
  // endpoints inset to the node rim so arrowheads stay visible.
  function strandPath(d) {
    if (d.loop) {
      const { x, y } = d.source;
      d._mid = [x, y - 46];
      return `M${x - 9},${y - 12} a16,16 0 1,1 18,0`;
    }
    const x1 = d.source.x, y1 = d.source.y, x2 = d.target.x, y2 = d.target.y;
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    const bow = Math.min(dist * 0.12, 34);
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

  function linkTooltip(l) {
    // while a flow is focused, the tooltip tells the flow's story for this
    // strand: its hops with stage and true direction — not the aggregate
    const hops = flowRowsCache.filter((r) => r.link.key === l.key);
    if (filters.flow && hops.length) {
      const stById = new Map(lastData.streams.map((s) => [s.id, s]));
      const rows = hops.sort((x, y) => x.stage - y.stage).map((r) => {
        const st = stById.get(r.id);
        const from = r.dir === "ab" ? l.a : l.b, to = r.dir === "ab" ? l.b : l.a;
        return `<div class="tt-row"><span><span class="tt-stage">${r.stage}</span>${esc(st.name)}</span>` +
          `<span class="tt-meta">${esc(sysName(from))} &#8594; ${esc(sysName(to))} · ${esc(st.status)}</span></div>`;
      }).join("");
      const others = l.streams.length - hops.length;
      const note = others > 0 ? `<div class="tt-meta">+${others} other stream${others === 1 ? "" : "s"} on this connection — not in this flow</div>` : "";
      return `<b>hops of the focused flow</b>${rows}${note}<div class="tt-hint">click to dig in</div>`;
    }
    const head = l.loop
      ? `<b>${esc(sysName(l.a))}</b> internal flow`
      : `<b>${esc(sysName(l.a))}</b> ${l.dirBA ? "&#8596;" : "&#8594;"} <b>${esc(sysName(l.b))}</b>`;
    const rows = l.streams.slice(0, 5).map((st) =>
      `<div class="tt-row"><span>${esc(st.name)}</span><span class="tt-meta">${esc(st.status)} · ${esc(st.timing)}${st.api_type ? " · " + esc(st.api_type) : ""}</span></div>`).join("");
    const more = l.streams.length > 5 ? `<div class="tt-meta">+${l.streams.length - 5} more…</div>` : "";
    return `${head}${rows}${more}<div class="tt-hint">click to dig in</div>`;
  }

  function nodeTooltip(n) {
    const inc = links.filter((l) => l.a === n.id || l.b === n.id)
      .reduce((sum, l) => sum + l.streams.length, 0);
    const ents = (n.entities ?? []).length;
    const flds = (n.entities ?? []).reduce((s, e) => s + (e.fields ?? []).length, 0);
    return `<b>${esc(n.name)}</b> <span class="tt-meta">${esc(n.type)}</span>` +
      (n.description ? `<div>${esc(n.description)}</div>` : "") +
      `<div class="tt-meta">${inc} stream(s) · ${ents} entit${ents === 1 ? "y" : "ies"} · ${flds} field(s)</div>`;
  }

  // ---- legend (inside the SVG so exports carry it) ----

  function placeLegend() {
    const { h } = size();
    legendG.attr("transform", `translate(14, ${h - 172})`);
  }

  function drawLegend() {
    legendG.selectAll("*").remove();
    legendG.append("rect")
      .attr("width", 172).attr("height", 158).attr("rx", 8)
      .attr("fill", COLORS.panel).attr("stroke", COLORS.line).attr("opacity", 0.92);
    legendG.append("text").attr("x", 12).attr("y", 20)
      .attr("font-size", 9.5).attr("letter-spacing", 1.5).attr("fill", COLORS.muted)
      .text("LEGEND");
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

  function snapshotPositions() {
    for (const n of nodes) posCache.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy });
  }

  function scheduleLayoutSave() {
    if (!onLayoutChange) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      snapshotPositions();
      const out = {};
      for (const [id, p] of posCache) {
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
          out[id] = { x: Math.round(p.x), y: Math.round(p.y), pinned: p.fx != null };
        }
      }
      onLayoutChange(out);
    }, 800);
  }

  // ---- rendering ----

  function rebuild() {
    if (!lastData) return;
    const { w, h } = size();

    const hiding = mode === "hide" && active();
    const allLinks = aggregate(lastData);

    const keepLink = (l) => !hiding || linkMatched(l);
    const keepNode = (n) => !hiding || nodeMatched(n);

    snapshotPositions();

    nodes = lastData.systems.filter(keepNode).map((s) => {
      const cached = posCache.get(s.id);
      return {
        ...s,
        x: cached?.x ?? w / 2 + (Math.random() - 0.5) * 80,
        y: cached?.y ?? h / 2 + (Math.random() - 0.5) * 80,
        fx: cached?.fx ?? null, fy: cached?.fy ?? null,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    links = allLinks.filter((l) => keepLink(l) && byId.has(l.a) && byId.has(l.b))
      .map((l) => ({ ...l, source: l.a, target: l.b }));

    emptyNote.style.display = nodes.length ? "none" : "flex";

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
      .attr("stroke-width", (d) => widthScale(d.streams.length))
      .attr("stroke-dasharray", linkDash);
    linkAll
      .on("click", (e, d) => { e.stopPropagation(); onSelect({ type: "edge", a: d.a, b: d.b }); })
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

    // -- labels for single-stream edges (zoom-gated) --
    const trunc = (s) => (s.length > 22 ? s.slice(0, 21) + "…" : s);
    const labelSel = labelG.selectAll("text.elabel").data(links.filter((l) => l.streams.length === 1), (d) => d.key);
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
      .on("click", (e, d) => { e.stopPropagation(); onSelect({ type: "node", id: d.id }); })
      .on("dblclick", (e, d) => { d.fx = d.fy = null; sim.alpha(0.25).restart(); scheduleLayoutSave(); })
      .on("mouseenter", (e, d) => showTooltip(e, nodeTooltip(d)))
      .on("mousemove", moveTooltip)
      .on("mouseleave", hideTooltip)
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; hideTooltip(); })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); scheduleLayoutSave(); }));

    // -- simulation (self-loops render but exert no force) --
    const simLinks = links.filter((l) => !l.loop);
    if (sim) sim.stop();
    sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(simLinks).id((d) => d.id).distance(160).strength(0.5))
      .force("charge", d3.forceManyBody().strength(-520))
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("collide", d3.forceCollide(42))
      .on("tick", () => {
        linkAll.select(".hit").attr("d", strandPath);
        linkAll.select(".strand").attr("d", strandPath);
        badgeG.selectAll("g.badge").attr("transform", (d) => `translate(${d._mid?.[0] ?? 0},${d._mid?.[1] ?? 0})`);
        positionStages();
        labelG.selectAll("text.elabel")
          .attr("x", (d) => d._mid?.[0] ?? 0)
          .attr("y", (d) => (d._mid?.[1] ?? 0) - 7);
        nodeAll.attr("transform", (d) => `translate(${d.x},${d.y})`);
      })
      .on("end", scheduleLayoutSave);
    sim.alpha(nodes.every((n) => posCache.has(n.id)) ? 0.25 : 0.9).restart();

    paint();
  }

  function paintLink(sel, hover = false) {
    const marker = (on, hi) => (on ? `url(#${hi ? "arr-hi" : "arr"})` : null);
    const overlayOwnsDirection = (d) => filters.flow && flowRowsCache.some((r) => r.link.key === d.key);
    sel.select(".strand")
      .attr("stroke", (d) => {
        const hi = hover || (selection?.type === "edge" && selection.a === d.a && selection.b === d.b);
        return hi ? COLORS.strandHi : COLORS.strand;
      })
      .attr("marker-end", (d) => {
        if (overlayOwnsDirection(d)) return null;
        const hi = hover || (selection?.type === "edge" && selection.a === d.a && selection.b === d.b);
        return marker(!d.loop && d.dirAB, hi);
      })
      .attr("marker-start", (d) => {
        if (overlayOwnsDirection(d)) return null;
        const hi = hover || (selection?.type === "edge" && selection.a === d.a && selection.b === d.b);
        return marker(!d.loop && d.dirBA, hi);
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
      const key = a < b ? `${a}~${b}` : `${b}~${a}`;
      const link = linkByKey.get(key);
      if (!link) continue; // dangling or hidden by hide-mode
      const dir = a === link.a ? "ab" : "ba";
      const dk = key + dir;
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
      return { path: `M${x - 9},${y - 12} a16,16 0 1,1 18,0`, chip: [x, y - 46] };
    }
    const x1 = l.source.x, y1 = l.source.y, x2 = l.target.x, y2 = l.target.y;
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    const bow = Math.min(dist * 0.12, 34) + d.idx * 9;
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
    linkG.selectAll("g.link")
      .attr("opacity", (d) => (dimming && !linkMatched(d) ? DIM_OPACITY : 1))
      .each(function () { paintLink(d3.select(this)); });
    badgeG.selectAll("g.badge")
      .attr("opacity", (d) => (dimming && !linkMatched(d) ? DIM_OPACITY : 1));
    labelG.selectAll("text.elabel")
      .attr("visibility", zoomK >= LABEL_MIN_ZOOM ? "visible" : "hidden")
      .attr("opacity", (d) => (dimming && !linkMatched(d) ? DIM_OPACITY : 1));
    nodeG.selectAll("g.node")
      .attr("opacity", (d) => (dimming && !nodeMatched(d) ? DIM_OPACITY : 1))
      .select(".halo")
      .attr("visibility", (d) => (selection?.type === "node" && selection.id === d.id ? "visible" : "hidden"));
    paintStages();
  }

  return {
    setData(data) {
      lastData = data;
      V = new FilteredView(data, filters, mode);
      // seed positions from the saved layout for nodes we haven't placed yet
      for (const [id, p] of Object.entries(data.layout ?? {})) {
        if (!posCache.has(id)) {
          posCache.set(id, { x: p.x, y: p.y, fx: p.pinned ? p.x : null, fy: p.pinned ? p.y : null });
        }
      }
      rebuild();
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
      paint();
    },
    exportSVG(name) {
      const { w, h } = size();
      const clone = svg.node().cloneNode(true);
      clone.setAttribute("width", w);
      clone.setAttribute("height", h);
      clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.setAttribute("width", "100%");
      bg.setAttribute("height", "100%");
      bg.setAttribute("fill", COLORS.page);
      clone.insertBefore(bg, clone.firstChild);
      const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.svg`;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
