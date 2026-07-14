// Headless smoke test. Only runs when the page is opened with ?e2e.
// Results land in <pre id="e2e-results"> so a --dump-dom run can read them.
// ?shot=edge|dim poses the UI for a screenshot instead of asserting.
window.addEventListener("error", (ev) => {
  const d = document.createElement("pre");
  d.className = "js-error";
  d.style.display = "none";
  d.textContent = (ev.error && ev.error.stack) || ev.message;
  document.body.appendChild(d);
});

const shotMode = new URLSearchParams(location.search).get("shot");
if (shotMode) {
  window.addEventListener("load", async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(2500);
    if (shotMode === "edge") {
      const fat = [...document.querySelectorAll("g.link .strand")]
        .find((p) => +p.getAttribute("stroke-width") > 5);
      fat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } else if (shotMode === "dim") {
      document.querySelector('[data-dd="Status"]')._ddSet("planned");
    } else if (shotMode === "type") {
      // simulate real per-keystroke typing into the search box
      const search = document.querySelector(".filters input.search");
      const word = new URLSearchParams(location.search).get("q") ?? "mule";
      search.focus();
      for (const ch of word) {
        search.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        search.value += ch;
        search.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        search.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        await sleep(80);
      }
      await sleep(700); // debounce + paint
      const probe = document.createElement("pre");
      probe.id = "type-probe";
      probe.style.display = "none";
      probe.textContent = JSON.stringify({
        value: search.value,
        focused: document.activeElement === search,
        nodeOpacities: [...document.querySelectorAll("g.node")].map((n) => n.getAttribute("opacity")),
        railItems: document.querySelectorAll(".rail-body .entity-item").length,
      });
      document.body.appendChild(probe);
    } else if (shotMode === "ddopen") {
      const dd = document.querySelector('[data-dd="Status"]');
      dd.querySelector(".dd-btn").click();
    } else if (shotMode === "flow") {
      document.querySelectorAll(".rail-tabs button")[3].click();
      await sleep(300);
      const fname = new URLSearchParams(location.search).get("fname");
      const items = [...document.querySelectorAll(".rail-body .entity-item")];
      const target = fname ? items.find((i) => i.textContent.includes(fname)) : items[0];
      target?.querySelector(".btn")?.click(); // Show
    } else if (shotMode === "flowhover") {
      document.querySelectorAll(".rail-tabs button")[3].click();
      await sleep(300);
      document.querySelector(".rail-body .entity-item .btn")?.click(); // Show first flow
      await sleep(600);
      // hover the strand carrying a flow hop plus other streams
      const target = [...document.querySelectorAll("g.link")].find((g) =>
        g.querySelectorAll ? g.__data__ && g.__data__.streams.length > 1 && +g.querySelector(".strand").getAttribute("stroke-width") > 0 : false);
      const strand = target?.querySelector(".strand");
      const r = strand?.getBoundingClientRect();
      strand?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    } else if (shotMode === "matrix") {
      document.querySelectorAll(".filters .mode-toggle")[1].querySelectorAll("button")[1].click();
    } else if (shotMode === "analysis") {
      [...document.querySelectorAll(".topbar .btn")].find((b) => b.textContent.trim() === "Analysis").click();
    } else if (shotMode === "form") {
      document.querySelectorAll(".rail-tabs button")[1].click();
      await sleep(200);
      document.querySelector(".entity-item .btn")?.click(); // edit first stream
    }
  });
}
if (new URLSearchParams(location.search).has("e2e")) {
  window.addEventListener("load", async () => {
    const out = [];
    const ok = (name, cond) => out.push(`${cond ? "PASS" : "FAIL"} ${name}`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    await sleep(2500); // data load + force layout settle

    ok("rail systems list renders on cold load", document.querySelectorAll(".rail-body .entity-item").length === 5);
    ok("5 nodes rendered", document.querySelectorAll("g.node").length === 5);
    ok("7 streams aggregate to 5 edges", document.querySelectorAll("g.link").length === 5);
    const badge = document.querySelector("g.badge text");
    ok("aggregated edge shows count badge 3", badge && badge.textContent === "3");

    // arrows & legend & labels
    const withArrow = [...document.querySelectorAll("g.link .strand")]
      .filter((p) => p.getAttribute("marker-end") || p.getAttribute("marker-start"));
    ok("strands carry arrowheads", withArrow.length === 5);
    ok("legend present in SVG", !!document.querySelector("g.legend rect"));
    ok("single-stream edges have name labels", document.querySelectorAll("text.elabel").length === 4);

    // tooltip on hover
    const anyStrand = document.querySelector("g.link .strand");
    anyStrand.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: 400, clientY: 300 }));
    await sleep(100);
    const tt = document.querySelector(".graph-tooltip");
    ok("hover shows tooltip with stream info", tt && tt.style.display === "block" && tt.textContent.includes("click to dig in"));
    anyStrand.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));

    // drill-down: click the fat strand (3 streams)
    const fat = [...document.querySelectorAll("g.link .strand")]
      .find((p) => +p.getAttribute("stroke-width") > 5);
    fat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(300);
    ok("edge click opens inspector", !!document.querySelector(".inspector"));
    ok("inspector lists 3 strand cards", document.querySelectorAll(".strand-card").length === 3);
    ok("inspector resolves catalog entity names", document.querySelector(".inspector-body").textContent.includes("SalesOrder"));

    // Esc closes inspector
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
    ok("Esc closes inspector", !document.querySelector(".inspector"));

    // node click
    document.querySelector("g.node circle.body")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(300);
    ok("node click opens inspector", !!document.querySelector(".inspector"));

    // filter: status=planned, dim mode
    const setStatus = (v) => document.querySelector('[data-dd="Status"]')._ddSet(v);
    setStatus("planned");
    await sleep(300);
    const nodes = [...document.querySelectorAll("g.node")];
    const dimmedN = nodes.filter((n) => +n.getAttribute("opacity") < 0.2).length;
    ok("dim mode keeps all 5 nodes in DOM", nodes.length === 5);
    ok("dim mode dims 2 unmatched nodes", dimmedN === 2);
    const dimmedL = [...document.querySelectorAll("g.link")].filter((l) => +l.getAttribute("opacity") < 0.2).length;
    ok("dim mode dims 3 unmatched edges", dimmedL === 3);

    // regression: drill-down surfaces go through the same FilteredView —
    // an edge click under status=planned must partition, not mix
    fat.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(300);
    const scoped = document.querySelector(".inspector-body")?.textContent ?? "";
    ok("edge inspector partitions by the active filter",
      scoped.includes("Matching the filter") && scoped.includes("Not matching the filter (2)"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);

    // hide mode
    document.querySelectorAll(".mode-toggle button")[1].click();
    await sleep(500);
    ok("hide mode removes unmatched nodes from DOM", document.querySelectorAll("g.node").length === 3);
    ok("hide mode removes unmatched edges from DOM", document.querySelectorAll("g.link").length === 2);

    // clear facet, then text search (catalog-aware: field name "total")
    document.querySelectorAll(".mode-toggle button")[0].click();
    setStatus("");
    await sleep(300);
    ok("clearing filter restores full graph", document.querySelectorAll("g.node").length === 5);

    const search = document.querySelector(".filters input.search");
    const lit = () => [...document.querySelectorAll("g.link")].filter((l) => +l.getAttribute("opacity") >= 0.9).length;
    search.value = "SalesOrder";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(600); // debounce + paint
    ok("text search matches catalog entity (1 edge lit)", lit() === 1);
    // rail agrees with canvas
    document.querySelectorAll(".rail-tabs button")[1].click();
    await sleep(200);
    ok("rail streams list filtered by same query", document.querySelectorAll(".rail-body .entity-item").length === 1);

    // scoped search: same query, different scopes, different results
    const setScope = async (v) => {
      document.querySelector('[data-dd="Scope"]')._ddSet(v);
      await sleep(300);
    };
    await setScope("streams");
    ok("scope=streams: entity name no longer matches (0 edges lit)", lit() === 0);
    await setScope("entities");
    ok("scope=entities: entity name matches again (1 edge lit)", lit() === 1);
    search.value = "WMS";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await setScope("systems");
    await sleep(400);
    ok("scope=systems: system query lights its neighborhood edge", lit() === 1);
    const litNodes = [...document.querySelectorAll("g.node")].filter((n) => +n.getAttribute("opacity") >= 0.9).length;
    ok("scope=systems: matched system and its neighbor stay lit", litNodes === 2);
    await setScope("all");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelectorAll(".rail-tabs button")[0].click();
    await sleep(500);

    // exports: spy on the anchor click so no real download starts headlessly
    let exported = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      exported = { href: this.href, download: this.download };
    };
    try {
      [...document.querySelectorAll(".topbar .btn")].find((b) => b.textContent.trim() === "SVG").click();
      ok("export produces a blob SVG download", !!exported && exported.href.startsWith("blob:") && exported.download.endsWith(".svg"));
      exported = null;
      [...document.querySelectorAll(".topbar .btn")].find((b) => b.textContent.trim() === "JSON").click();
      ok("export produces a project JSON bundle", !!exported && exported.href.includes("/export") && exported.download.endsWith(".spaghetti.json"));
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }

    // matrix view
    document.querySelectorAll(".filters .mode-toggle")[1].querySelectorAll("button")[1].click();
    await sleep(300);
    ok("matrix renders one row per system", document.querySelectorAll("table.matrix tbody tr").length === 5);
    const cell2 = [...document.querySelectorAll("table.matrix .cell")].find((c) => c.textContent === "2");
    ok("directional matrix shows a 2-stream cell", !!cell2);
    cell2?.click();
    await sleep(300);
    ok("matrix cell click digs into the connection", document.querySelectorAll(".strand-card").length === 3);
    document.querySelectorAll(".filters .mode-toggle")[1].querySelectorAll("button")[0].click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);

    // analysis panel + justification roundtrip
    [...document.querySelectorAll(".topbar .btn")].find((b) => b.textContent.trim() === "Analysis").click();
    await sleep(300);
    ok("analysis panel opens with coverage stats", document.querySelector(".inspector-body")?.textContent.includes("Fields typed"));
    const unjustSection = () => document.querySelectorAll(".analysis-section")[1];
    const before = unjustSection().querySelectorAll(".arow").length;
    ok("unjustified moving fields are listed", before > 0);
    unjustSection().querySelector(".arow-needs input").click();
    await sleep(900); // PUT + reload + rerender
    const after = unjustSection().querySelectorAll(".arow").length;
    ok("justifying a field removes it from the unjustified list", after === before - 1);
    const justified = [...document.querySelectorAll(".analysis-section")].find((s) => s.tagName === "DETAILS");
    justified?.setAttribute("open", "");
    justified?.querySelector(".arow-needs input:checked")?.click();
    await sleep(900);
    ok("removing the justification restores the list", unjustSection().querySelectorAll(".arow").length === before);

    // flows: facet, stage badges, inspector diagnostics
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const flows = await (await fetch("/api/projects/Demo/flows")).json();
    ok("flow seeded via API", flows.length === 1);
    document.querySelectorAll(".rail-tabs button")[3].click();
    await sleep(300);
    ok("flows tab lists the flow", document.querySelectorAll(".rail-body .entity-item").length === 1);
    ok("flow item shows deduced ghost need", !!document.querySelector(".rail-body .chip.ghost"));
    document.querySelector('[data-dd="Flow"]')._ddSet(flows[0].id);
    await sleep(400);
    ok("flow facet lights only its hops", lit() === 2);
    const stageTexts = [...document.querySelectorAll("g.stage text")].map((t) => t.textContent).sort().join(",");
    ok("stage chips show 1 and 2", stageTexts === "1,2");
    ok("directional hop overlays drawn", document.querySelectorAll("path.flow-overlay").length === 2);
    ok("count badges hidden while flow focused", document.querySelector("g.badges").getAttribute("display") === "none");

    // focus mode scopes the drill-down surfaces, not just the canvas
    const fatStrand = [...document.querySelectorAll("g.link .strand")].find((p) => +p.getAttribute("stroke-width") > 5);
    ok("focused strand drops its aggregate arrows", !fatStrand.getAttribute("marker-end") && !fatStrand.getAttribute("marker-start"));
    fatStrand.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: 500, clientY: 300 }));
    await sleep(100);
    const ftt = document.querySelector(".graph-tooltip").textContent;
    ok("focused tooltip shows hop with stage + direction", ftt.includes("hops of the focused flow") && ftt.includes("→"));
    ok("focused tooltip notes non-flow streams", ftt.includes("not in this flow"));
    fatStrand.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    fatStrand.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(300);
    const einsp = document.querySelector(".inspector-body")?.textContent ?? "";
    ok("focused edge inspector separates flow hops from the rest",
      einsp.includes('In "Order to warehouse"') && einsp.includes("Not in this flow (2)"));
    document.querySelector(".rail-body .entity-item .btn").click(); // Show
    await sleep(300);
    const insp = document.querySelector(".inspector-body")?.textContent ?? "";
    ok("flow inspector lists stages", insp.includes("Stage 2"));
    ok("flow inspector deduces needs from hops", insp.includes("Order Fulfillment"));
    ok("connected flow has no gap warning", !insp.includes("disconnected"));
    ok("ordered flow has no wiring warning", !insp.includes("contradicts"));
    document.querySelector('[data-dd="Flow"]')._ddSet("");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
    ok("clearing flow facet restores the graph", lit() === 5);
    ok("count badges visible again", document.querySelector("g.badges").getAttribute("display") !== "none");

    const pre = document.createElement("pre");
    pre.id = "e2e-results";
    pre.textContent = out.join("\n");
    document.body.appendChild(pre);
  });
}
// (screenshot poses for matrix/analysis are handled via ?shot= below)
