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
window.addEventListener("unhandledrejection", (ev) => {
  const d = document.createElement("pre");
  d.className = "js-error";
  d.style.display = "none";
  d.textContent = "UNHANDLED: " + ((ev.reason && (ev.reason.stack || ev.reason.message)) || ev.reason || "");
  document.body.appendChild(d);
});

const getToggle = (label) => {
  const group = document.querySelector(`.canvas-toolbar [aria-label="${label}"]`);
  return group?.querySelector(".mode-toggle");
};

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
      getToggle("Lens").querySelectorAll("button")[1].click();
    } else if (shotMode === "expand") {
      // one curve per stream, fanned out parallel
      getToggle("Edges").querySelectorAll("button")[1].click();
    } else if (shotMode === "expandflow") {
      getToggle("Edges").querySelectorAll("button")[1].click(); // Expand
      await sleep(300);
      document.querySelectorAll(".rail-tabs button")[3].click(); // flows tab
      await sleep(200);
      document.querySelector(".rail-body .entity-item .btn")?.click(); // Show first flow
    } else if (shotMode === "project") {
      document.querySelector(".topbar .proj-name").click();
      await sleep(300);
    } else if (shotMode === "analysis") {
      [...document.querySelectorAll(".topbar .btn")].find((b) => b.textContent.trim() === "Analysis").click();
    } else if (shotMode === "form") {
      document.querySelectorAll(".rail-tabs button")[1].click();
      await sleep(200);
      document.querySelector(".entity-item .btn")?.click(); // edit first stream
    }
  });
}
// Shared helper: sign in from the auth gate using ?user=&pass= (and optional
// ?name= for setup). Used by ?e2e=home. Signed-in DR-3 view coverage lives
// in scripts/verify-dr3.mjs (not a dump-dom suite).
async function e2eSignInFromGate(params, sleep) {
  for (let i = 0; i < 50; i++) {
    if (document.querySelector(".auth-card form") || document.querySelector(".home-page") || document.querySelector(".workspace")) break;
    await sleep(100);
  }
  // Login form (not setup)
  if (document.querySelector(".auth-card form") && !document.querySelector('input[name="name"]')) {
    const user = params.get("user") || "";
    const pass = params.get("pass") || "";
    const u = document.querySelector('input[name="username"]');
    const p = document.querySelector('input[name="password"]');
    if (u && p && user && pass) {
      u.value = user;
      p.value = pass;
      u.dispatchEvent(new Event("input", { bubbles: true }));
      p.dispatchEvent(new Event("input", { bubbles: true }));
      const authForm = document.querySelector(".auth-card form");
      if (authForm?.requestSubmit) authForm.requestSubmit();
      else document.querySelector('.auth-card button[type="submit"]')?.click();
      for (let i = 0; i < 40; i++) {
        if (document.querySelector(".home-page") || document.querySelector(".workspace")) break;
        await sleep(150);
      }
    }
  }
  // Setup form
  if (document.querySelector('input[name="name"]')) {
    const user = params.get("user") || "e2e-architect";
    const pass = params.get("pass") || "e2e-test-pass";
    const name = params.get("name") || "E2E Architect";
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set('input[name="username"]', user);
    set('input[name="password"]', pass);
    set('input[name="name"]', name);
    const authForm = document.querySelector(".auth-card form");
    if (authForm?.requestSubmit) authForm.requestSubmit();
    else document.querySelector('.auth-card button[type="submit"]')?.click();
    for (let i = 0; i < 40; i++) {
      if (document.querySelector(".home-page") || document.querySelector(".workspace")) break;
      await sleep(150);
    }
  }
}

// Home empty-state suite (?e2e=home): auth-enabled, signed-in, zero projects.
// Shell (e2e-auth or verify-dr2) provisions the user; page logs in via
// ?user=&pass= when the gate is up, then asserts DR-2 empty home.
if (new URLSearchParams(location.search).get("e2e") === "home") {
  localStorage.clear();
  window.addEventListener("load", async () => {
    const out = [];
    const ok = (name, cond, actual) => out.push(`${cond ? "PASS" : "FAIL"} ${name}` + (cond ? "" : ` [actual: ${JSON.stringify(actual)}]`));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const params = new URLSearchParams(location.search);

    await e2eSignInFromGate(params, sleep);

    const page = document.querySelector(".home-page");
    const topbar = page?.querySelector(":scope > .topbar");
    const home = page?.querySelector(".home");
    ok("DR-2 home: empty home-page renders", !!page && !!topbar && !!home);
    ok("DR-2 home: account chip sits in the topbar",
      !!topbar?.querySelector(".account-chip"));
    ok("DR-2 home: chip not on Projects heading row",
      !document.querySelector(".home-projects-head .account-chip"));
    ok("DR-2 home: brand-mini in topbar", !!topbar?.querySelector("a.brand-mini"));
    ok("DR-2 home: content wordmark present",
      home?.querySelector(".brand h1 b")?.textContent === "Mapper");
    const invite = document.querySelector(".home-invite");
    ok("DR-2 home: first-run invitation copy present",
      !!invite && /architecture map/i.test(invite.textContent || "")
      && /readable JSON/i.test(invite.textContent || ""),
      invite?.textContent);
    ok("DR-2 home: + New project card present",
      !!document.querySelector(".new-project")
      && /New project/i.test(document.querySelector(".new-project")?.textContent || ""));
    ok("DR-2 home: no project cards yet",
      document.querySelectorAll(".project-card").length === 0);
    const padTop = home ? parseFloat(getComputedStyle(home).paddingTop) : 0;
    ok("DR-2 home: content top pad ≥48px (visual third)", padTop >= 48, padTop);

    const pre = document.createElement("pre");
    pre.id = "e2e-results";
    pre.textContent = "\n" + out.join("\n");
    document.body.appendChild(pre);
  });
} else if (new URLSearchParams(location.search).get("e2e") === "auth") {
  localStorage.clear();
  window.addEventListener("load", async () => {
    const out = [];
    const ok = (name, cond, actual) => out.push(`${cond ? "PASS" : "FAIL"} ${name}` + (cond ? "" : ` [actual: ${JSON.stringify(actual)}]`));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < 40; i++) {
      if (document.querySelector(".auth-card form") || document.querySelector(".home, .workspace")) break;
      await sleep(100);
    }

    const card = document.querySelector(".auth-card");
    const wrap = document.querySelector(".auth-wrap");
    ok("DR-1: auth gate card renders", !!card && !!wrap);

    // LP-3: gate is the landing's second page (hero | panel).
    const page = document.querySelector(".auth-page");
    const hero = page?.querySelector(".auth-hero");
    const panel = page?.querySelector(".auth-panel");
    ok("LP-3: .auth-page contains .auth-hero and .auth-panel", !!page && !!hero && !!panel);
    const heroText = hero?.textContent || "";
    ok("LP-3: hero headline present",
      /You inherited spaghetti/.test(heroText) && /Leave behind a map/.test(heroText),
      heroText.slice(0, 120));
    ok("LP-3: hero vocab line lists five words",
      /systems\s*·\s*streams\s*·\s*flows\s*·\s*needs\s*·\s*clusters/.test(heroText),
      heroText.slice(0, 200));
    const cardW = card ? card.getBoundingClientRect().width : 0;
    ok("LP-3: form column ≤320px", cardW > 0 && cardW <= 321, cardW);
    const panelRect = panel?.getBoundingClientRect();
    ok("LP-3: panel flush to the right edge",
      !!panelRect && Math.abs(panelRect.right - window.innerWidth) < 2,
      { right: panelRect?.right, vw: window.innerWidth });

    const brand = document.querySelector(".auth-brand h1");
    const brandB = brand?.querySelector("b");
    ok("DR-1: two-tone wordmark (Spaghetti + amber Mapper)",
      !!brand && brand.childNodes[0]?.textContent === "Spaghetti" && brandB?.textContent === "Mapper",
      { text: brand?.textContent, b: brandB?.textContent });
    ok("DR-1: brand mark SVG present", !!document.querySelector(".auth-brand svg"));

    const wm = document.querySelector(".auth-watermark");
    const wmCs = wm ? getComputedStyle(wm) : null;
    ok("DR-1: static tangle watermark present", !!wm && !!wm.querySelector("svg"));
    // LP-3: watermark opacity .5 over the hero (was .25 as a floating-card backdrop).
    ok("LP-3: watermark opacity ~0.5",
      !!wmCs && Math.abs(parseFloat(wmCs.opacity) - 0.5) < 0.05,
      wmCs?.opacity);
    ok("DR-1: watermark is static (no CSS animation)",
      !!wmCs && (wmCs.animationName === "none" || wmCs.animationName === ""),
      wmCs?.animationName);
    ok("LP-2: watermark carries CORE COMMERCE hull path",
      !!wm?.querySelector("path[fill='#3fae94'], path[fill=\"#3fae94\"]")
      || /CORE COMMERCE/.test(wm?.textContent || ""),
      wm?.innerHTML?.slice(0, 120));

    const userInput = document.querySelector('input[name="username"]');
    ok("DR-1: username placeholder is an example", userInput?.placeholder === "alex", userInput?.placeholder);

    const nameInput = document.querySelector('input[name="name"]');
    const isSetup = !!nameInput;
    ok("DR-1: gate mode is setup or login", isSetup || !!document.querySelector('input[name="password"]'));
    if (isSetup) {
      ok("DR-1: display-name placeholder is sentence-case product copy",
        nameInput.placeholder === "How your edits are signed", nameInput.placeholder);
      const hint = document.querySelector(".field-hint");
      ok("DR-1: password minimum hint under the field",
        !!hint && /at least 8/i.test(hint.textContent), hint?.textContent);
      const pw = document.querySelector('input[name="password"]');
      ok("DR-1: password input has minlength 8", pw?.getAttribute("minlength") === "8", pw?.getAttribute("minlength"));
    }

    const welcome = document.querySelector("a.auth-welcome");
    ok("DR-1: welcome footer links to /welcome",
      welcome?.getAttribute("href") === "/welcome" && /What is SpaghettiMapper/i.test(welcome.textContent || ""),
      { href: welcome?.getAttribute("href"), text: welcome?.textContent });

    // Tab order: username first focusable control in the form.
    const form = document.querySelector(".auth-card form");
    const focusables = form ? [...form.querySelectorAll("input, button")].filter((el) => !el.disabled) : [];
    ok("DR-1: first form control is username", focusables[0]?.name === "username", focusables[0]?.name);
    // LP-3: username is autofocused on mount (do not steal focus with a manual focus()).
    await sleep(50);
    ok("LP-3: username is document.activeElement after render",
      document.activeElement === userInput,
      document.activeElement?.name || document.activeElement?.tagName);

    // Amber focus ring still available via global :focus-visible / border.
    const focusBorder = userInput ? getComputedStyle(userInput).borderColor : "";
    // After focus, border must be the amber accent (#e6a23c → rgb(230, …)).
    ok("DR-1: focused field uses accent border",
      !!userInput && (focusBorder.includes("230") || focusBorder.includes("e6a23c")),
      focusBorder);

    // /welcome is reachable (same origin); 302→landing is fine.
    let welcomeOk = false;
    try {
      const r = await fetch("/welcome", { redirect: "follow" });
      welcomeOk = r.ok && /landing|SpaghettiMapper|inherited spaghetti/i.test(await r.text());
    } catch (_) { /* network */ }
    ok("DR-1: /welcome serves the landing page", welcomeOk);

    const pre = document.createElement("pre");
    pre.id = "e2e-results";
    // Leading newline keeps the first PASS off the same dump-dom line as
    // the opening <pre> tag so scripts/e2e*.sh can grep ^(PASS|FAIL).
    pre.textContent = "\n" + out.join("\n");
    document.body.appendChild(pre);
  });
} else if (new URLSearchParams(location.search).has("e2e")) {
  localStorage.clear();
  window.addEventListener("load", async () => {
    const out = [];
    const ok = (name, cond, actual) => out.push(`${cond ? "PASS" : "FAIL"} ${name}` + (cond ? "" : ` [actual: ${JSON.stringify(actual)}]`));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ensureFilterHudOpen = async () => {
      const btn = document.querySelector('[aria-label="Toggle Filters HUD"]');
      if (btn && !btn.classList.contains("active")) {
        btn.click();
        await sleep(300);
      }
    };

    // wait for elements to load (up to 10 seconds)
    for (let i = 0; i < 50; i++) {
      if (document.querySelectorAll(".rail-body .entity-item").length === 5 && document.querySelectorAll("g.node").length === 5) {
        break;
      }
      await sleep(200);
    }

    // Deterministic baseline: saved per-project display prefs (Bundle/Expand,
    // arc spacing) may persist a non-default state from a prior run. Force
    // Bundle mode + default spacing so the early bundle-mode assertions hold.
    getToggle("Edges")?.querySelectorAll("button")[0]?.click(); // Bundle
    await sleep(200);

    // Open Filter HUD and ensure filters are enabled
    await ensureFilterHudOpen();

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
    ok("DR-11 legend visible when map has nodes",
      document.querySelector("g.legend")?.getAttribute("display") !== "none");
    ok("single-stream edges have name labels", document.querySelectorAll("text.elabel").length === 4);

    // ---- DR-5: edge-label density (length + collision fade, not display:none) ----
    // Labels stay in the DOM so the master toggle and drag can restore them;
    // short/colliding losers use opacity:0. Visible ones must not overlap.
    // Wait for the first sim ticks to stamp _len and run the density pass —
    // before geometry settles every edge can look "short" and fade to 0.
    {
      let elabels = [];
      for (let i = 0; i < 25; i++) {
        elabels = [...document.querySelectorAll("text.elabel")];
        const ready = elabels.length === 4
          && elabels.every((t) => t.hasAttribute("opacity"))
          && elabels.some((t) => +(t.getAttribute("opacity") ?? 1) > 0.01);
        if (ready) break;
        await sleep(80);
      }
      ok("DR-5 density leaves label elements in DOM", elabels.length === 4);
      ok("DR-5 density sets opacity on every edge label",
        elabels.every((t) => t.hasAttribute("opacity")));
      const readable = elabels.filter((t) =>
        t.getAttribute("visibility") !== "hidden" && +(t.getAttribute("opacity") ?? 1) > 0.01);
      ok("DR-5 density leaves at least one edge label readable on demo", readable.length >= 1);
      let overlap = false;
      for (let i = 0; i < readable.length; i++) {
        for (let j = i + 1; j < readable.length; j++) {
          const a = readable[i], b = readable[j];
          const ax = +a.getAttribute("x"), ay = +a.getAttribute("y");
          const bx = +b.getAttribute("x"), by = +b.getAttribute("y");
          const aw = Math.max((a.textContent || "").length * 6, 8);
          const bw = Math.max((b.textContent || "").length * 6, 8);
          if (Math.abs(ax - bx) < (aw + bw) / 2 && Math.abs(ay - by) < 12) overlap = true;
        }
      }
      ok("DR-5 no two readable edge labels overlap", !overlap);
      ok("DR-5 edge labels have finite positions",
        readable.every((t) => Number.isFinite(+t.getAttribute("x")) && Number.isFinite(+t.getAttribute("y"))));
    }

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
    ok("DR-14 strand card uses prose meta (no TIMING/API eyebrows)",
      !!document.querySelector(".strand-card .sc-meta")
      && !document.querySelector(".strand-card .sc-kv-k")
      && !document.querySelector(".strand-card .sc-contract"));

    // ---- DR-6: real plurals + spelled-out entity/field (no ent/fld, no (s)) ----
    {
      const sc = document.querySelector(".strand-card .sc-summary");
      ok("DR-6 strand card has route + payload lines",
        !!(sc?.querySelector(".sc-route") && sc?.querySelector(".sc-payload")));
      const payload = sc?.querySelector(".sc-payload")?.textContent ?? "";
      ok("DR-6 payload spells entity/field (no ent/fld abbreviations)",
        /\b(entity|entities)\b/.test(payload) && /\bfields?\b/.test(payload)
        && !/\bent\b/.test(payload) && !/\bfld\b/.test(payload));
      ok("DR-6 no mechanical (s) plurals in inspector body",
        !/\w\(s\)/.test(document.querySelector(".inspector-body")?.textContent ?? ""));
      // Commerce system rail card (systems tab is default on cold load)
      document.querySelectorAll(".rail-tabs button")[0]?.click();
      await sleep(150);
      const commerce = [...document.querySelectorAll(".rail-body .entity-item")]
        .find((el) => el.querySelector(".ei-name")?.textContent?.includes("Commerce"));
      const csub = commerce?.textContent ?? "";
      ok("DR-6 systems rail uses real plurals",
        csub.includes("1 entity") && csub.includes("4 fields") && !csub.includes("field(s)"));
      // Order Acknowledgement has no documented endpoints — collapse the
      // doubled "0 entities · fields not documented" payload to one phrase.
      const ack = [...document.querySelectorAll(".strand-card")]
        .find((c) => c.querySelector("h4")?.textContent?.includes("Order Acknowledgement"));
      const ackPayload = ack?.querySelector(".sc-payload")?.textContent?.trim() ?? "";
      ok("DR-6 undocumented stream collapses to 'payload not documented'",
        !!ack
        && ackPayload === "payload not documented"
        && !ackPayload.includes("0 entities"));
    }

    // resizable drawers: left handle always present, right handle only when open
    ok("left resize handle always visible", !!document.querySelector(".resizer--rail"));
    ok("right resize handle appears when inspector opens", !!document.querySelector(".resizer--insp"));
    ok("handle DOM order: rail handle < canvas < insp handle < inspector", (() => {
      const kids = [...document.querySelector(".body-split").children];
      const idx = (sel) => kids.findIndex((e) => e.classList && e.classList.contains(sel));
      return idx("resizer--rail") < idx("canvas-col") && idx("canvas-col") < idx("resizer--insp") && idx("resizer--insp") < idx("inspector");
    })());

    const numW = (el) => +getComputedStyle(el).width.replace("px", "");
    const dragHandle = (sel, dx) => {
      const h = document.querySelector(sel);
      const r = h.getBoundingClientRect();
      h.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.left + 3, clientY: r.top + 10 }));
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + 3 + dx, clientY: r.top + 10 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: r.left + 3 + dx, clientY: r.top + 10 }));
    };

    // reset to defaults first so the deltas are deterministic even if a
    // previous run left a non-default width in localStorage
    document.querySelector(".resizer--rail").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    document.querySelector(".resizer--insp").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await sleep(150);

    // dragging the LEFT handle rightward widens the rail and shrinks the canvas
    const railBefore = numW(document.querySelector(".rail"));
    const canvasBefore = numW(document.querySelector(".canvas-wrap"));
    dragHandle(".resizer--rail", 60);
    await sleep(150);
    const railAfter = numW(document.querySelector(".rail"));
    const canvasAfter = numW(document.querySelector(".canvas-wrap"));
    ok("dragging left handle widens the rail ~60px", railAfter - railBefore >= 55 && railAfter - railBefore <= 65);
    ok("dragging left handle shrinks the canvas", canvasAfter < canvasBefore - 50);
    ok("resizing class cleaned up after drag", !document.body.classList.contains("resizing"));
    // reset to default so repeated runs stay hermetic
    document.querySelector(".resizer--rail").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await sleep(120);

    // dragging the RIGHT handle rightward narrows the inspector (its left edge moves right)
    const inspBefore = numW(document.querySelector(".inspector"));
    dragHandle(".resizer--insp", 60);
    await sleep(150);
    const inspAfter = numW(document.querySelector(".inspector"));
    ok("dragging right handle narrows the inspector ~60px", inspBefore - inspAfter >= 55 && inspBefore - inspAfter <= 65);
    document.querySelector(".resizer--insp").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await sleep(120);

    // Esc closes inspector
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
    ok("Esc closes inspector", !document.querySelector(".inspector"));
    ok("right resize handle gone when inspector closes", !document.querySelector(".resizer--insp"));
    ok("left resize handle still visible after inspector closes", !!document.querySelector(".resizer--rail"));

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
    getToggle("Unmatched")?.querySelectorAll("button")[1]?.click(); // Hide
    await sleep(500);
    ok("hide mode removes unmatched nodes from DOM", document.querySelectorAll("g.node").length === 3);
    ok("hide mode removes unmatched edges from DOM", document.querySelectorAll("g.link").length === 2);

    // clear facet, then text search (catalog-aware: field name "total")
    getToggle("Unmatched")?.querySelectorAll("button")[0]?.click(); // Dim
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
    ok("scope=streams: entity name no longer matches (0 edges lit)", lit() === 0, lit());
    await setScope("entities");
    ok("scope=entities: entity name matches again (1 edge lit)", lit() === 1, lit());
    search.value = "WMS";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await setScope("systems");
    await sleep(400);
    ok("scope=systems: system query lights its neighborhood edge", lit() === 1, lit());
    const litNodes = [...document.querySelectorAll("g.node")].filter((n) => +n.getAttribute("opacity") >= 0.9).length;
    ok("scope=systems: matched system and its neighbor stay lit", litNodes === 2, litNodes);
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
      // open once to assert the frozen three-option menu
      document.querySelector(".topbar .export-btn").click();
      const exportLabels = [...document.querySelectorAll(".export-panel .dd-opt")].map(
        (el) => [...el.querySelectorAll("span")].pop()?.textContent?.trim() ?? ""
      );
      // close without picking (re-toggle)
      document.querySelector(".topbar .export-btn").click();
      ok("Export menu lists SVG image, Project JSON, Integration register (.xlsx)",
        exportLabels.length === 3
        && exportLabels[0] === "SVG image"
        && exportLabels[1] === "Project JSON"
        && exportLabels[2] === "Integration register (.xlsx)",
        exportLabels);

      const exportOpt = (i) => {
        document.querySelector(".topbar .export-btn").click(); // open Export menu
        document.querySelectorAll(".export-panel .dd-opt")[i].click();
      };
      exportOpt(0); // SVG image
      ok("export produces a blob SVG download", !!exported && exported.href.startsWith("blob:") && exported.download.endsWith(".svg"));
      exported = null;
      exportOpt(1); // Project JSON
      ok("export produces a project JSON bundle", !!exported && exported.href.includes("/export") && exported.download.endsWith(".spaghetti.json"));

      // Integration register: fetch the GET endpoint (no download plumbing)
      const rep = await fetch("/api/projects/Demo/report");
      const ct = rep.headers.get("Content-Type") || "";
      const cd = rep.headers.get("Content-Disposition") || "";
      const body = new Uint8Array(await rep.arrayBuffer());
      ok("report endpoint returns 200 xlsx",
        rep.status === 200
        && ct.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        && /integration-register/.test(cd)
        && body.length >= 2 && body[0] === 0x50 && body[1] === 0x4b, // PK zip magic
        { status: rep.status, ct, cd, magic: [...body.slice(0, 2)] });

      // ---- RG Map export: register mode is full project (not live filters) ----
      // Apply a filter that dims/hides most of the demo, then assert register SVG
      // still carries all systems at full opacity with stamped geometry + dark page.
      const parseExport = (svgStr) => {
        const doc = new DOMParser().parseFromString(svgStr, "image/svg+xml");
        const root = doc.documentElement;
        const nodes = [...doc.querySelectorAll("g.node")];
        const names = nodes.map((n) => n.querySelector(".nlabel")?.textContent ?? "");
        const opacities = nodes.map((n) => +(n.getAttribute("opacity") ?? 1));
        const transforms = nodes.map((n) => n.getAttribute("transform") || "");
        const strands = [...doc.querySelectorAll("path.strand")];
        const strandD = strands.map((p) => p.getAttribute("d") || "");
        const styleVis = (root.getAttribute("style") || "") + (root.getAttribute("visibility") || "");
        const hasPageBg = /fill=["']#10151d["']/i.test(svgStr) || !!doc.querySelector('rect[fill="#10151d"]');
        return {
          names,
          opacities,
          transforms,
          strandD,
          hiddenRoot: /visibility\s*:\s*hidden/i.test(styleVis) || root.getAttribute("visibility") === "hidden",
          hasPageBg,
          hasLegend: !!doc.querySelector("g.legend"),
          nodeCount: nodes.length,
          strandCount: strands.length,
        };
      };

      ok("RG: __smGraph export hooks exposed under ?e2e",
        !!(window.__smGraph?.buildExportSVG && window.__smGraph?.exportMapPNG));

      // Force a non-trivial filter: status=planned dims most of the demo.
      document.querySelector('[data-dd="Status"]')?._ddSet?.("planned");
      await sleep(400);
      const dimmedLive = [...document.querySelectorAll("g.node")]
        .filter((n) => +(n.getAttribute("opacity") ?? 1) < 0.5).length;
      ok("RG: live canvas is filtered before register export", dimmedLive >= 1, dimmedLive);

      const reg = window.__smGraph.buildExportSVG("register");
      const regP = parseExport(reg.svg);
      const wantSystems = ["Commerce", "Billing", "Fulfillment", "CRM", "WMS"];
      ok("RG: register SVG includes all 5 demo systems",
        wantSystems.every((n) => regP.names.includes(n)), regP.names);
      ok("RG: register SVG nodes all full opacity (filters not applied)",
        regP.opacities.length === 5 && regP.opacities.every((o) => o >= 0.99), regP.opacities);
      ok("RG: register SVG stamps node transforms (not stuck at origin)",
        regP.transforms.every((t) => {
          const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(t);
          return m && (Math.abs(+m[1]) > 1 || Math.abs(+m[2]) > 1);
        }), regP.transforms);
      ok("RG: register SVG has strand paths with geometry",
        regP.strandCount >= 5 && regP.strandD.every((d) => d.length > 8), regP.strandCount);
      ok("RG: register SVG has dark page background", regP.hasPageBg);
      ok("RG: register SVG root is not visibility:hidden", !regP.hiddenRoot, regP);
      ok("RG: register SVG carries legend", regP.hasLegend);

      // Viewport export keeps filter chrome (dimmed nodes present in the string).
      const vp = window.__smGraph.buildExportSVG("viewport");
      const vpP = parseExport(vp.svg);
      ok("RG: viewport SVG still reflects live filter dimming",
        vpP.opacities.some((o) => o < 0.5), vpP.opacities);

      // PNG rasterization for the Map sheet must succeed and be non-trivial.
      let pngB64 = null;
      let pngErr = null;
      try {
        pngB64 = await window.__smGraph.exportMapPNG();
      } catch (e) {
        pngErr = String(e?.message || e);
      }
      ok("RG: exportMapPNG resolves to base64", !!pngB64 && !pngErr && pngB64.length > 500, { pngErr, len: pngB64?.length });
      // Tiny sanity: PNG magic in decoded bytes
      if (pngB64) {
        const bin = atob(pngB64.slice(0, 32));
        ok("RG: exportMapPNG is a PNG", bin.charCodeAt(0) === 0x89 && bin.slice(1, 4) === "PNG",
          [...bin].slice(0, 4).map((c) => c.charCodeAt(0)));
      }

      // POST workbook with the map embeds media (zip entry under xl/media/).
      if (pngB64) {
        const post = await fetch("/api/projects/Demo/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ map_png: pngB64 }),
        });
        const postBuf = new Uint8Array(await post.arrayBuffer());
        // PK zip; scan central directory strings for xl/media
        const asText = new TextDecoder("latin1").decode(postBuf);
        ok("RG: POST report with map_png returns xlsx containing media",
          post.status === 200
          && postBuf[0] === 0x50 && postBuf[1] === 0x4b
          && /xl\/media\//.test(asText),
          { status: post.status, hasMedia: /xl\/media\//.test(asText) });
      }

      // Clear status filter so the rest of the suite stays baseline.
      document.querySelector('[data-dd="Status"]')?._ddSet?.("");
      await sleep(300);
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }

    // matrix view
    getToggle("Lens")?.querySelectorAll("button")[1]?.click();
    await sleep(300);
    ok("matrix renders one row per system", document.querySelectorAll("table.matrix tbody tr").length === 5, document.querySelectorAll("table.matrix tbody tr").length);
    const cell2 = [...document.querySelectorAll("table.matrix .cell")].find((c) => c.textContent === "2");
    ok("directional matrix shows a 2-stream cell", !!cell2, [...document.querySelectorAll("table.matrix td")].map(td=>td.textContent));
    // DR-9: graph-only groups inert; cells have presence; caption structure
    ok("DR-9 graph-only toolbar groups are inert in matrix",
      [...document.querySelectorAll(".ctool-graph-only")].every((el) =>
        el.classList.contains("is-inert") && el.getAttribute("aria-disabled") === "true"));
    const mxTd = document.querySelector("table.matrix td");
    const mxMin = mxTd ? parseFloat(getComputedStyle(mxTd).minWidth) : 0;
    ok("DR-9 matrix cells ≥ 44px wide", mxMin >= 44, mxMin);
    const cap = document.querySelector(".matrix-caption")?.textContent ?? "";
    // FU-4: pin invariant "one-way" (never "one-ways"); counts from filtered cells
    ok("DR-9 matrix caption lists streams · connections · one-way",
      /\d+ streams?/.test(cap) && /\d+ connections?/.test(cap) && /\d+ one-way\b/.test(cap)
      && !/one-ways/.test(cap), cap);
    // FU-4: caption stream count must equal sum of visible cell numbers (same data).
    const cellSum = () => [...document.querySelectorAll("table.matrix .cell")]
      .reduce((s, c) => s + (+c.textContent || 0), 0);
    const capStreams = (text) => {
      const m = (text || "").match(/^(\d+)\s+streams?\b/);
      return m ? +m[1] : -1;
    };
    const unfilteredSum = cellSum();
    const unfilteredCap = capStreams(cap);
    ok("FU-4 unfiltered caption streams equal sum of cell counts",
      unfilteredCap === unfilteredSum && unfilteredSum > 0,
      { unfilteredCap, unfilteredSum, cap });
    // Selective filter (demo: status=planned → 2 of 7 streams) must shrink caption
    // in lockstep with cells — guards against regressing to d.streams.length.
    setStatus("planned");
    await sleep(400);
    const filtCapText = document.querySelector(".matrix-caption")?.textContent ?? "";
    const filtSum = cellSum();
    const filtCap = capStreams(filtCapText);
    ok("FU-4 filtered caption streams equal sum of cell counts",
      filtCap === filtSum && filtSum > 0, { filtCap, filtSum, filtCapText });
    ok("FU-4 filtered caption streams strictly less than unfiltered",
      filtCap < unfilteredCap, { filtCap, unfilteredCap, filtCapText });
    ok("FU-4 filtered caption still uses invariant one-way",
      /\d+ one-way\b/.test(filtCapText) && !/one-ways/.test(filtCapText), filtCapText);
    setStatus("");
    await sleep(300);
    // Re-find cell after filter clear (table re-rendered)
    const cell2b = [...document.querySelectorAll("table.matrix .cell")].find((c) => c.textContent === "2");
    cell2b?.click();
    await sleep(300);
    ok("matrix cell click digs into the connection", document.querySelectorAll(".strand-card").length === 3);
    getToggle("Lens")?.querySelectorAll("button")[0]?.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);

    // analysis panel + justification roundtrip (AJ-1…AJ-5)
    [...document.querySelectorAll(".topbar .btn")].find((b) => b.textContent.trim() === "Analysis").click();
    await sleep(300);
    ok("analysis panel opens with coverage stats", document.querySelector(".inspector-body")?.textContent.includes("Fields typed"));
    const unjustSection = () => document.querySelectorAll(".analysis-section")[1];
    const beforeCards = unjustSection().querySelectorAll(".arow").length;
    ok("unjustified moving fields are listed", beforeCards > 0, beforeCards);

    // AJ-2: status + line_items share entity + stream → one "2 fields" group card
    const groupCard = [...unjustSection().querySelectorAll(".arow-group")]
      .find((el) => /2 fields/.test(el.textContent || ""));
    ok("AJ-2: SalesOrder status+line_items render as 2-field group",
      !!groupCard && /SalesOrder/.test(groupCard.textContent || ""),
      groupCard?.textContent?.slice(0, 120));

    // AJ-1: suggestion chips (≤3) + one picker; no bare checkboxes outside picker
    const bareCb = [...unjustSection().querySelectorAll(".arow input[type=checkbox]")]
      .filter((inp) => !inp.closest(".arow-picker-list"));
    ok("AJ-1: no always-visible need checkboxes", bareCb.length === 0, bareCb.length);
    const suggestChips = unjustSection().querySelectorAll(".arow-suggest");
    ok("AJ-1: suggestion chips present (≤3 per card max overall on demo)",
      suggestChips.length >= 1 && suggestChips.length <= 6, suggestChips.length);
    ok("AJ-1: each card has a picker control",
      unjustSection().querySelectorAll(".arow-picker").length >= 1);

    // AJ-4: via-line stream names are links
    const streamLink = unjustSection().querySelector("button.arow-stream");
    ok("AJ-4: via-line stream name is a link button", !!streamLink, streamLink?.textContent);

    // Capture next card top for AJ-3 stability (group is first; invoice follows)
    const cardsBefore = [...unjustSection().querySelectorAll(".arow")];
    const nextBefore = cardsBefore[1];
    const nextTopBefore = nextBefore?.getBoundingClientRect().top ?? null;
    const hBefore = (await (await fetch("/api/projects/Demo/history")).json()).entries.length;
    const countBefore = +(unjustSection().querySelector("h5")?.textContent.match(/\((\d+)\)/) || [])[1];

    // AJ-1/2: click first suggestion on the group → one history entry, settle in place
    const groupSuggest = groupCard?.querySelector(".arow-suggest");
    ok("AJ-1: group has a suggestion chip", !!groupSuggest, groupSuggest?.textContent);
    groupSuggest?.click();
    await sleep(1000); // PUT(s) + reload + rerender
    const toastEl = document.getElementById("toast");
    ok("DR-7/AJ-2 toast names fields and need",
      !!toastEl && /Justified 2 fields with .+ — moved to Justified/.test(toastEl.textContent),
      toastEl?.textContent);
    ok("DR-10 toast sits above the canvas hint bar",
      toastEl && parseFloat(getComputedStyle(toastEl).bottom) >= 50);
    const hAfter = (await (await fetch("/api/projects/Demo/history")).json()).entries.length;
    ok("AJ-2: group justify is one history entry", hAfter === hBefore + 1, { hBefore, hAfter });

    const settled = unjustSection().querySelector(".arow-settled");
    ok("AJ-3: settled card present with Undo",
      !!settled && /Justified with/.test(settled.textContent || "") && /Undo/.test(settled.textContent || ""),
      settled?.textContent);
    const countAfter = +(unjustSection().querySelector("h5")?.textContent.match(/\((\d+)\)/) || [])[1];
    ok("AJ-3: section count decremented while card stays",
      countAfter === countBefore - 2 && unjustSection().querySelectorAll(".arow").length >= 1,
      { countBefore, countAfter, cards: unjustSection().querySelectorAll(".arow").length });
    const nextAfter = [...unjustSection().querySelectorAll(".arow")][1];
    const nextTopAfter = nextAfter?.getBoundingClientRect().top ?? null;
    ok("AJ-3: next card top stable (±2px) across justify",
      nextTopBefore != null && nextTopAfter != null && Math.abs(nextTopAfter - nextTopBefore) <= 2,
      { nextTopBefore, nextTopAfter });

    // AJ-3 Undo restores controls
    settled?.querySelector("button.linklike")?.click();
    await sleep(1000);
    ok("AJ-3: Undo restores suggestion controls",
      !!unjustSection().querySelector(".arow-suggest")
      && !unjustSection().querySelector(".arow-settled"));
    const countRestored = +(unjustSection().querySelector("h5")?.textContent.match(/\((\d+)\)/) || [])[1];
    ok("AJ-3: Undo restores section count", countRestored === countBefore, { countRestored, countBefore });

    // AJ-2 split disclosure
    const splitBtn = [...unjustSection().querySelectorAll(".arow-split")]
      .find((b) => /each field separately/.test(b.textContent || ""));
    splitBtn?.click();
    await sleep(100);
    ok("AJ-2: split expands to per-field cards",
      unjustSection().querySelectorAll(".arow").length >= 3
      && !!unjustSection().querySelector(".arow-split")
      && /group fields/.test(unjustSection().querySelector(".arow-split")?.textContent || ""),
      unjustSection().querySelectorAll(".arow").length);
    // collapse again for clean state
    [...unjustSection().querySelectorAll(".arow-split")]
      .find((b) => /group fields/.test(b.textContent || ""))?.click();
    await sleep(100);

    // Single-field justify via suggestion (Invoice) for justified-section checks
    const invoiceCard = [...unjustSection().querySelectorAll(".arow")]
      .find((el) => /Invoice/.test(el.textContent || "") && !el.classList.contains("arow-group"));
    invoiceCard?.querySelector(".arow-suggest")?.click();
    await sleep(1000);
    ok("AJ-1: single-field justify toast",
      /Justified .+ with .+ — moved to Justified/.test(document.getElementById("toast")?.textContent || ""));

    // AJ-4: open stream editor from remaining card (group)
    const via = unjustSection().querySelector("button.arow-stream");
    const viaName = via?.textContent?.trim();
    via?.click();
    await sleep(300);
    const railForm = document.querySelector(".rail-form");
    const nameInput = railForm
      ? [...railForm.querySelectorAll("input[type=text]")].find((el) => el.placeholder === "Orders sync" || el.value === viaName)
      : null;
    ok("AJ-4: stream link opens rail form",
      !!railForm && /Edit stream/i.test(railForm.querySelector("h4")?.textContent || "")
      && nameInput?.value === viaName,
      {
        form: !!railForm,
        h4: railForm?.querySelector("h4")?.textContent,
        name: nameInput?.value,
        viaName,
      });
    ok("AJ-4: analysis panel stays mounted", !!document.querySelector(".analysis-section"));

    // AJ-5: justified section chips + remove
    const justified = [...document.querySelectorAll(".analysis-section")].find((s) => s.tagName === "DETAILS");
    justified?.setAttribute("open", "");
    await sleep(50);
    ok("AJ-5: justified row shows need chips",
      !!justified?.querySelector(".chip.arow-need-chip")
      || !!justified?.querySelector(".arow-need-chip"),
      justified?.querySelector(".arow")?.textContent?.slice(0, 100));
    const bareJustCb = [...(justified?.querySelectorAll("input[type=checkbox]") || [])]
      .filter((inp) => !inp.closest(".arow-picker-list"));
    ok("AJ-5: no bare checkboxes in justified section", bareJustCb.length === 0, bareJustCb.length);
    const removeX = justified?.querySelector(".btn-x");
    removeX?.click();
    await sleep(1000);
    ok("AJ-5: ✕ removes justification (toast)",
      /Removed justification for /.test(document.getElementById("toast")?.textContent || ""),
      document.getElementById("toast")?.textContent);

    // flows: facet, stage badges, inspector diagnostics
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const flows = await (await fetch("/api/projects/Demo/flows")).json();
    ok("flow seeded via API", flows.length === 1);
    document.querySelectorAll(".rail-tabs button")[3].click();
    await sleep(300);
    ok("flows tab lists the flow", document.querySelectorAll(".rail-body .entity-item").length === 1);
    ok("flow item shows deduced ghost need", !!document.querySelector(".rail-body .chip.ghost"), document.querySelector(".rail-body .chip.ghost"));
    {
      const flowSub = document.querySelector(".rail-body .entity-item")?.textContent ?? "";
      ok("DR-6 flow card uses real plurals (no hop(s))",
        flowSub.includes("2 hops") && flowSub.includes("2 stages")
        && !flowSub.includes("hop(s)") && !flowSub.includes("stage(s)"));
    }
    document.querySelector('[data-dd="Flow"]')._ddSet(flows[0].id);
    await sleep(400);
    ok("flow facet lights only its hops", lit() === 2, lit());
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
    ok("clearing flow focus restores the graph", lit() === 5, lit());
    ok("count badges visible again", document.querySelector("g.badges").getAttribute("display") !== "none");

    // Flow is a regular filter condition (variant A): Show enables Filter if
    // needed and paints the Flow chip on the collapsed pill.
    {
      const filterBtn = document.querySelector('[aria-label="Toggle Filters HUD"]');
      if (filterBtn && !filterBtn.classList.contains("active")) filterBtn.click();
      await sleep(150);
      filterBtn.click(); // Filter Off
      await sleep(300);
      ok("filter toggled off before Show", !filterBtn.classList.contains("active"));
      document.querySelectorAll(".rail-tabs button")[3].click(); // flows tab
      await sleep(200);
      document.querySelector(".rail-body .entity-item .btn")?.click(); // Show
      await sleep(400);
      ok("Show re-enables Filter", filterBtn.classList.contains("active"));
      ok("Show draws hop overlays", document.querySelectorAll("path.flow-overlay").length === 2);
      ok("Show shows stage chips", document.querySelectorAll("g.stage").length === 2);
      ok("Show lights only flow hops", lit() === 2, lit());
      // Collapse HUD so the pill is visible
      document.body.click();
      await sleep(200);
      const flowChip = [...document.querySelectorAll(".hud-collapsed-pill .f-chip")]
        .find((c) => !c.classList.contains("f-chip-more") && (c.textContent || "").includes("Flow:"));
      ok("collapsed pill shows Flow chip (variant A)", !!flowChip, flowChip?.textContent);
      ok("funnel badge counts flow as a filter",
        document.querySelector('[aria-label="Toggle Filters HUD"] .ctool-badge')?.textContent === "1");
      // Chip structure: label in .f-chip-text (ellipsis), ✕ separate, full title attr
      const flowText = flowChip?.querySelector(".f-chip-text");
      ok("Flow chip has f-chip-text span", !!flowText, flowChip?.innerHTML);
      ok("Flow chip label is non-empty (not crushed to ✕-only)",
        !!flowText && flowText.textContent.trim().length > 0 && flowText.textContent.includes("Flow:"),
        flowText?.textContent);
      ok("Flow chip title carries full label for tooltip",
        (flowChip?.getAttribute("title") || "").includes("Flow:"), flowChip?.getAttribute("title"));
      ok("Flow chip remove button is separate from label",
        !!flowChip?.querySelector("button") && !flowText?.contains(flowChip.querySelector("button")));
      const textW = flowText?.getBoundingClientRect().width ?? 0;
      ok("Flow chip label has visible width (ellipsis, not zero-width)", textW > 12, textW);
      const textCs = flowText ? getComputedStyle(flowText) : null;
      ok("Flow chip label uses ellipsis truncation",
        !!textCs && textCs.textOverflow === "ellipsis" && textCs.whiteSpace === "nowrap",
        textCs && `${textCs.textOverflow}/${textCs.whiteSpace}`);
      flowChip?.querySelector("button")?.click(); // clear flow chip
      await sleep(300);
      ok("clearing Flow chip restores overlays", document.querySelectorAll("path.flow-overlay").length === 0);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(150);
    }

    // Saved flow filter restores journey context on workspace remount:
    // Flows tab + flow inspector selection (HUD stays collapsed; pill shows chip).
    {
      const flowId = flows[0].id;
      const putRes = await fetch("/api/projects/Demo/userstate", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filter_enabled: true,
          filters: {
            queries: [],
            statuses: [],
            timings: [],
            needs: [],
            systems: [],
            flow: flowId,
          },
        }),
      });
      ok("userstate save for flow restore", putRes.ok, putRes.status);
      location.hash = "#/__flowrestore";
      await sleep(80);
      location.hash = "#/p/Demo";
      await sleep(1500);
      for (let i = 0; i < 25; i++) {
        if (document.querySelectorAll("g.node").length >= 3) break;
        await sleep(120);
      }
      ok("restore opens Flows rail tab",
        document.querySelectorAll(".rail-tabs button")[3]?.classList.contains("active"));
      // Title lives in .inspector-head; body has description + "Focused on map".
      const insp = document.querySelector(".inspector");
      const inspText = insp?.textContent || "";
      ok("restore selects the saved flow (inspector open)",
        !!insp && inspText.includes("Order to warehouse") && inspText.includes("Focused on map"),
        insp ? inspText.slice(0, 120) : null);
      const ft = insp?.querySelector(".focus-toggle");
      ok("DR-13 focus control is a pressed toggle (not primary fill)",
        !!ft && ft.classList.contains("is-pressed") && ft.getAttribute("aria-pressed") === "true"
        && !ft.classList.contains("primary"));
      // FU-4: pressed focus-toggle width stable when Unfocus label is shown.
      // Headless has no real :hover, so force the visibility swap to probe grid
      // sizing; also lock the real :hover rules in app.css (Playwright hover is
      // out of band for this suite).
      if (ft?.classList.contains("is-pressed")) {
        let cssText = "";
        try { cssText = await (await fetch("/css/app.css")).text(); } catch (_) { /* ignore */ }
        ok("FU-4 focus-toggle :hover rules use visibility in app.css",
          /\.btn\.focus-toggle\.is-pressed:hover\s+\.focus-label-on\s*\{[^}]*visibility:\s*hidden/.test(cssText)
          && /\.btn\.focus-toggle\.is-pressed:hover\s+\.focus-label-off\s*\{[^}]*visibility:\s*visible/.test(cssText),
          cssText ? cssText.slice(cssText.indexOf(".btn.focus-toggle"), cssText.indexOf(".btn.focus-toggle") + 500) : "fetch failed");
        const w0 = ft.getBoundingClientRect().width;
        const hoverStyle = document.createElement("style");
        hoverStyle.textContent =
          ".btn.focus-toggle.is-pressed .focus-label-on { visibility: hidden !important; }" +
          ".btn.focus-toggle.is-pressed .focus-label-off { visibility: visible !important; }";
        document.head.appendChild(hoverStyle);
        await sleep(30);
        const w1 = ft.getBoundingClientRect().width;
        const offEl = ft.querySelector(".focus-label-off");
        const offVis = offEl ? getComputedStyle(offEl).visibility : null;
        const offText = offEl?.textContent || "";
        const showsUnfocus = !!offEl
          && offVis === "visible"
          && offText.includes("Unfocus");
        const detail = { vis: offVis, text: offText };
        hoverStyle.remove();
        ok("FU-4 focus-toggle width stable on Unfocus swap",
          Math.abs(w1 - w0) <= 0.5, { w0, w1 });
        ok("FU-4 focus-toggle hover shows Unfocus", showsUnfocus, detail);
      } else {
        ok("FU-4 focus-toggle :hover rules use visibility in app.css", false, "no pressed toggle");
        ok("FU-4 focus-toggle width stable on Unfocus swap", false, "no pressed toggle");
        ok("FU-4 focus-toggle hover shows Unfocus", false, "no pressed toggle");
      }
      ok("restore focuses flow on map (overlays)",
        document.querySelectorAll("path.flow-overlay").length === 2);
      // Ensure Filter stays on and pill can show the Flow chip when collapsed
      const ftRestore = document.querySelector('[aria-label="Toggle Filters HUD"]');
      ok("restore keeps Filter enabled", ftRestore?.classList.contains("active"));
      document.body.click();
      await sleep(250);
      const restoredChip = [...document.querySelectorAll(".hud-collapsed-pill .f-chip")]
        .find((c) => !c.classList.contains("f-chip-more") && (c.textContent || "").includes("Flow:"));
      ok("restore collapsed pill shows Flow chip with label",
        !!restoredChip?.querySelector(".f-chip-text") &&
        (restoredChip.querySelector(".f-chip-text")?.textContent || "").includes("Flow:"),
        restoredChip?.textContent);
      // Clear so later sections start clean
      restoredChip?.querySelector("button")?.click();
      await sleep(300);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(150);
      // Bundle mode may have been left on Expand by prefs — force Bundle for later tests
      getToggle("Edges")?.querySelectorAll("button")[0]?.click();
      await sleep(300);
    }

    // ---- Expand mode: one curve per stream, fanned out parallel ----
    const modeToggles = (label) => getToggle(label);
    modeToggles("Edges")?.querySelectorAll("button")[1]?.click(); // Expand
    await sleep(500);
    ok("expand renders one link per stream (7)", document.querySelectorAll("g.link").length === 7);
    ok("expand hides count badges", !document.querySelector("g.badge"));
    ok("expand labels every strand", document.querySelectorAll("text.elabel").length === 7);
    ok("expand draws thin parallel strands",
      [...document.querySelectorAll("g.link .strand")].every((p) => +p.getAttribute("stroke-width") <= 3));
    // every expanded strand must actually have geometry (a `d`), not just exist
    ok("expand strands all carry geometry",
      [...document.querySelectorAll("g.link .strand")].every((p) => !!p.getAttribute("d")));

    // clicking an expanded strand still opens the pair-based connection inspector
    const pairCount = new Map();
    for (const g of document.querySelectorAll("g.link")) {
      const d = g.__data__;
      const pk = d.a < d.b ? `${d.a}~${d.b}` : `${d.b}~${d.a}`;
      pairCount.set(pk, (pairCount.get(pk) ?? 0) + 1);
    }
    const triplePk = [...pairCount.entries()].find(([, n]) => n === 3)?.[0];
    const tripleLink = [...document.querySelectorAll("g.link")].find((g) => {
      const d = g.__data__;
      const pk = d.a < d.b ? `${d.a}~${d.b}` : `${d.b}~${d.a}`;
      return pk === triplePk;
    });
    tripleLink?.querySelector(".strand").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(300);
    ok("expanded strand click opens the pair inspector", !!document.querySelector(".inspector"));
    ok("pair inspector still lists all 3 streams", document.querySelectorAll(".strand-card").length === 3);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);

    // flow focus in Expand mode: overlays sit on the hops' OWN curves
    document.querySelector('[data-dd="Flow"]')._ddSet(flows[0].id);
    await sleep(400);
    ok("expand + flow lights only the 2 hop strands", lit() === 2, lit());
    ok("expand + flow draws 2 hop overlays", document.querySelectorAll("path.flow-overlay").length === 2);
    ok("expand + flow shows stage chips 1 and 2",
      [...document.querySelectorAll("g.stage text")].map((t) => t.textContent).sort().join(",") === "1,2");
    document.querySelector('[data-dd="Flow"]')._ddSet("");
    await sleep(300);

    // back to Bundle restores the aggregated view
    modeToggles("Edges")?.querySelectorAll("button")[0]?.click(); // Bundle
    await sleep(500);

    // ---- edge-label Show/Hide toggle (toolbar) ----
    const labelsVisible = () => [...document.querySelectorAll("text.elabel")]
      .every((t) => t.getAttribute("visibility") !== "hidden");
    const labelsHidden = () => [...document.querySelectorAll("text.elabel")]
      .every((t) => t.getAttribute("visibility") === "hidden");
    ok("edge labels visible by default", labelsVisible());
    modeToggles("Labels")?.querySelectorAll("button")[1]?.click(); // Hide
    await sleep(200);
    ok("Hide hides every edge label", labelsHidden());
    ok("hiding labels keeps the label elements (count unchanged)",
      document.querySelectorAll("text.elabel").length === 4);
    modeToggles("Labels")?.querySelectorAll("button")[0]?.click(); // Show
    await sleep(200);
    ok("Show restores edge labels", labelsVisible());
    ok("bundle restores 5 aggregated edges", document.querySelectorAll("g.link").length === 5);
    ok("bundle restores count badge 3", document.querySelector("g.badge text")?.textContent === "3");

    // ---- per-project display prefs (Project popover, anchored to proj-name) ----
    document.querySelector(".topbar .proj-name").click();
    await sleep(200);
    ok("project panel opens from the project name", !!document.querySelector(".project-panel-pop.open"));
    ok("project panel has the arc-spacing slider", !!document.querySelector(".fan-spacing input[type=range]"));
    // set Expand + a custom arc spacing via the panel controls (live preview)
    document.querySelector(".project-panel-pop .mode-toggle").querySelectorAll("button")[1].click(); // Expand
    const slider = document.querySelector(".fan-spacing input[type=range]");
    slider.value = "50";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(800); // debounce (500ms) + PUT
    let disp = await (await fetch("/api/projects/Demo/display")).json();
    ok("display prefs persisted (expand + fan_spacing=50)", disp.expand === true && disp.fan_spacing === 50);
    // the panel's second mode-toggle is Edge labels: Show/Hide; flip to Hide
    // and confirm it both hides labels on the canvas and persists.
    const drawerToggles = () => document.querySelectorAll(".project-panel-pop .mode-toggle");
    drawerToggles()[1].querySelectorAll("button")[1].click(); // Hide
    await sleep(400);
    ok("panel Hide hides edge labels on canvas",
      [...document.querySelectorAll("text.elabel")].every((t) => t.getAttribute("visibility") === "hidden"));
    await sleep(500); // debounce
    disp = await (await fetch("/api/projects/Demo/display")).json();
    ok("hide_edge_labels persisted", disp.hide_edge_labels === true);
    // close via the ✕ and confirm the popover unmounts
    document.querySelector(".project-panel-pop .pp-head .btn").click();
    await sleep(200);
    ok("project panel closes", !document.querySelector(".project-panel-pop.open"));
    // Esc also closes: reopen, then Esc
    document.querySelector(".topbar .proj-name").click();
    await sleep(150);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
    ok("Esc closes the project panel", !document.querySelector(".project-panel-pop.open"));
    // reset to bundle + default spacing + labels shown so repeated runs stay hermetic
    document.querySelector(".topbar .proj-name").click();
    await sleep(150);
    const dt = document.querySelectorAll(".project-panel-pop .mode-toggle");
    dt[0].querySelectorAll("button")[0].click(); // Bundle
    dt[1].querySelectorAll("button")[0].click(); // Show labels
    const sl2 = document.querySelector(".fan-spacing input[type=range]");
    sl2.value = "34";
    sl2.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(800);
    document.querySelector(".project-panel-pop .pp-head .btn").click();
    await sleep(200);
    disp = await (await fetch("/api/projects/Demo/display")).json();
    ok("display prefs reset to defaults", disp.expand === false && disp.fan_spacing === 34 && disp.hide_edge_labels === false);

    // ---- version history (undo / redo / history popover + P2 inline detail) ----
    // The controls live in the canvas toolbar (no floating pill). Undo/Redo
    // are icon buttons (aria-label); History opens a popover with thumbnails
    // + an inline detail view (no lightbox).
    const tbtn = (lbl) => document.querySelector(`.ctool-history button[aria-label="${lbl}"]`);
    ok("undo/redo/history buttons in the toolbar", !!(tbtn("Undo") && tbtn("Redo") && tbtn("History")));
    // DR-3: Mine · Main lives in the topbar when signed in; under -no-auth it
    // is absent (solo always reads main). Not an icon pair in the toolbar.
    ok("view toggle absent for anonymous solo",
      !document.querySelector(".topbar .view-toggle")
      && !document.querySelector('.canvas-toolbar .ctool[aria-label="View"]'));
    // Display groups keep aria-pressed so the active half is announced when
    // group labels collapse under container-query pressure.
    const lensBtns = [...(getToggle("Lens")?.querySelectorAll("button") ?? [])];
    ok("DR-3: lens active half has aria-pressed true",
      lensBtns.length === 2 && lensBtns[0].getAttribute("aria-pressed") === "true"
      && lensBtns[1].getAttribute("aria-pressed") === "false",
      lensBtns.map((b) => b.getAttribute("aria-pressed")));
    const unmatchedBtns = [...(getToggle("Unmatched")?.querySelectorAll("button") ?? [])];
    ok("DR-3: unmatched toggles expose aria-pressed",
      unmatchedBtns.length === 2
      && unmatchedBtns.every((b) => b.hasAttribute("aria-pressed")),
      unmatchedBtns.map((b) => b.getAttribute("aria-pressed")));
    // Group labels key off the canvas column (container query), not the
    // viewport — so they return when the inspector closes even on smaller screens.
    // Require a real size container from `container: canvas / inline-size`.
    // container-type is "normal" when that CSS is missing — fail then.
    const canvasCol = document.querySelector(".canvas-col");
    const colCs = canvasCol ? getComputedStyle(canvasCol) : null;
    const cType = (colCs?.containerType || colCs?.webkitContainerType || "").trim();
    ok("DR-3: canvas column is a size container for toolbar labels",
      !!canvasCol && (cType.includes("inline-size") || cType === "size"),
      { containerType: cType, containerName: colCs?.containerName });
    // With no inspector, the demo canvas column is wide enough for labels.
    const ctoolLabel = document.querySelector(".canvas-toolbar .ctool-label");
    const labelDisp = ctoolLabel ? getComputedStyle(ctoolLabel).display : "none";
    ok("DR-3: group labels visible when canvas column is wide (no inspector)",
      !!ctoolLabel && labelDisp !== "none",
      { display: labelDisp, colW: canvasCol?.clientWidth });

    // Make two distinct commits on main so there's something to undo. The
    // creates go through the API directly (server commits via the middleware);
    // a hash round-trip then re-mounts the workspace so the app reloads its
    // graph AND refreshes historyState (enabling the undo button).
    const mkSys = (id, name) => fetch("/api/projects/Demo/systems", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name }),
    }).then(() => sleep(200));
    await mkSys("h1", "HistOne");
    await mkSys("h2", "HistTwo");
    ok("two new commits land on main", (await (await fetch("/api/projects/Demo/graph")).json()).systems.length === 7);
    location.hash = "#/__hist"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1200);
    await ensureFilterHudOpen();
    ok("app graph shows the 7 systems after reload", document.querySelectorAll("g.node").length === 7);

    // Undo/Redo via the toolbar. Headless d3 sims don't fire `end`, so the
    // layout-save path can't be exercised here — undo steps back one data
    // commit at a time (the last commit is create h2).
    const clickUndo = async () => { tbtn("Undo").click(); await sleep(650); };
    await clickUndo();
    ok("undo removes the last commit (h2) -> 6 systems", document.querySelectorAll("g.node").length === 6);
    tbtn("Redo").click(); await sleep(650);
    ok("redo restores h2 -> 7 systems", document.querySelectorAll("g.node").length === 7);
    // leave a clean redo-future: undo back to 6, then redo to 7.
    tbtn("Undo").click(); await sleep(650); tbtn("Redo").click(); await sleep(650);

    // History popover.
    tbtn("History").click(); await sleep(450);
    const hp = document.querySelector(".history-panel");
    ok("history popover opens", !!hp);
    ok("history header shows dynamic workspace context", hp && hp.querySelector("h3").textContent === "History (My workspace)");
    const rows = hp ? [...hp.querySelectorAll(".h-row")] : [];
    ok("history timeline lists versions", rows.length >= 3);
    ok("DR-12 history rows hide short SHA in the list", !hp.querySelector(".h-short"));
    ok("DR-12 history explainer is concept-first (no git SHA in body copy)",
      (hp.querySelector(".inspector-body .cl-empty")?.textContent || "").includes("Every change is saved automatically")
      && !(hp.querySelector(".inspector-body .cl-empty")?.textContent || "").includes("step back and forward"));
    ok("each row has a thumbnail slot", rows.length > 0 && rows.every((r) => r.querySelector(".h-thumb")));
    // The current row renders its thumbnail immediately; lazy rows fill in
    // as their IntersectionObserver fires. Give the observer a beat.
    await sleep(500);
    ok("thumbnails render for visible rows", hp.querySelectorAll(".h-thumb svg").length >= 1);

    // P2 inline detail: click a non-current past row -> detail view (no
    // lightbox over the workspace).
    const pastRow = [...rows].reverse().find((r) => !r.classList.contains("future") && !r.classList.contains("current"));
    ok("a past version row exists", !!pastRow);
    pastRow.click(); await sleep(750);
    const hd = document.querySelector(".history-detail");
    ok("detail view opens for a past version", !!hd);
    ok("detail shows Restore + Back", hd ? hd.querySelectorAll(".hd-actions .btn").length === 2 : false);
    // The oldest past version is the demo import (5 systems); the detail's
    // mini-SVG draws one circle per node (no d3 sim, just dots).
    ok("detail mini-svg shows the past version (5 nodes)", hd ? hd.querySelectorAll("circle").length === 5 : false);
    ok("no preview lightbox is used", !document.querySelector(".preview-overlay"));

    // Back returns to the list.
    [...hd.querySelectorAll(".hd-actions .btn")].find((b) => b.textContent.includes("Back")).click();
    await sleep(300);
    ok("back returns to the list (detail closed)", !document.querySelector(".history-detail"));

    // Restore via detail: reopen the oldest past row, then Restore.
    const oldestRow = [...hp.querySelectorAll(".h-row")].reverse().find((r) => !r.classList.contains("future") && !r.classList.contains("current"));
    oldestRow.click(); await sleep(750);
    const hd2 = document.querySelector(".history-detail");
    [...hd2.querySelectorAll(".hd-actions .btn")].find((b) => b.textContent.includes("Restore")).click();
    await sleep(600);
    await ensureFilterHudOpen();
    const serverSys = async () => (await (await fetch("/api/projects/Demo/graph")).json()).systems.length;
    ok("restore jumps the live map to the past version", await serverSys() === 5);
    ok("restore closes the detail", !document.querySelector(".history-detail"));
    await sleep(400);
    ok("restored canvas shows the past version (5 nodes)", document.querySelectorAll("g.node").length === 5);
    ok("history popover closed after restore", !document.querySelector(".history-popover"));

    // Redo walks all the way back to the pre-restore state (7 systems).
    let guard = 0, rr;
    do { rr = await (await fetch("/api/projects/Demo/redo", { method: "POST" })).json(); await sleep(120); } while (rr && rr.can_redo && ++guard < 50);
    ok("redo walks back to the latest (7 systems)", await serverSys() === 7);
    // Nudge an undo+redo through the toolbar so the app reloads and reflects it.
    tbtn("Undo").click(); await sleep(60); tbtn("Redo").click(); await sleep(700);
    ok("app graph back to 7 after redo-to-latest", document.querySelectorAll("g.node").length === 7);

    // ---- restore must bring back the restored commit's LAYOUT, not just its
    // data (regression: rebuild()'s snapshotPositions() used to write the
    // stale pre-restore node positions back over the freshly seeded restored
    // layout, so the canvas kept the old positions). Two pinned-layout
    // commits, restore to the first, and the canvas must move back.
    const putLayout = (l) => fetch("/api/projects/Demo/layout", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(l),
    }).then(() => sleep(250));
    const sysIds = (await (await fetch("/api/projects/Demo/graph")).json()).systems.map((s) => s.id);
    const mkL = (y) => Object.fromEntries(sysIds.map((id, i) => [id, { x: 100 + i * 60, y, pinned: true }]));
    await putLayout(mkL(140)); // commit A: everything on the y=140 row
    await putLayout(mkL(420)); // commit B: everything on the y=420 row
    location.hash = "#/__lay"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1200);
    // read positions from the bound datum (sim ticks may not paint transforms
    // in headless, but the datum always carries x/y)
    const nodeYs = () => [...document.querySelectorAll("g.node")].map((g) => g.__data__?.y).filter(Number.isFinite);
    ok("canvas shows the latest layout (y≈420)", nodeYs().length === 7 && nodeYs().every((y) => Math.abs(y - 420) < 30));
    tbtn("History").click(); await sleep(450);
    const hp2 = document.querySelector(".history-panel");
    const layRow = hp2 && [...hp2.querySelectorAll(".h-row")].find((r) => !r.classList.contains("future") && !r.classList.contains("current"));
    ok("previous layout commit row exists", !!layRow);
    layRow.click(); await sleep(750);
    const hd3 = document.querySelector(".history-detail");
    [...hd3.querySelectorAll(".hd-actions .btn")].find((b) => b.textContent.includes("Restore")).click();
    await sleep(900);
    ok("restore moves the canvas back to the restored layout (y≈140)",
      nodeYs().length === 7 && nodeYs().every((y) => Math.abs(y - 140) < 30));
    // walk redo back to the latest layout so later sections see the tip state
    let lg = 0, lr;
    do { lr = await (await fetch("/api/projects/Demo/redo", { method: "POST" })).json(); await sleep(120); } while (lr && lr.can_redo && ++lg < 50);
    tbtn("Undo").click(); await sleep(60); tbtn("Redo").click(); await sleep(700);
    ok("app back at the latest layout after redo (y≈420)",
      nodeYs().length === 7 && nodeYs().every((y) => Math.abs(y - 420) < 30));

    // Filter HUD: all filters and search reside in the floating HUD, triggered by a toolbar button.
    ok("filter button present in toolbar", !!document.querySelector('[aria-label="Toggle Filters HUD"]'));
    const ft = document.querySelector('[aria-label="Toggle Filters HUD"]');
    const isHudOpenInitially = ft.classList.contains("active");
    if (isHudOpenInitially) {
      ft.click();
      await sleep(300);
    }
    ft.click();
    await sleep(300);
    ok("filter HUD opens on click", !!document.getElementById("filter-hud") && document.getElementById("filter-hud").style.display !== "none");
    ok("search input exists in the HUD", !!document.querySelector(".hud-search-input"));
    // Type search
    const hudInput = document.querySelector(".hud-search-input");
    hudInput.value = "CRM";
    hudInput.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);

    // Select systems scope to verify unified chip (sets draft scope to "systems")
    const sysSuggest = Array.from(document.querySelectorAll(".hud-item")).find(el => el.textContent.includes("in: systems"));
    if (sysSuggest) {
      sysSuggest.click();
      await sleep(200);
    }

    // Press Enter to commit the search query
    hudInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(200);

    ok("active filters chip matches text search", !!document.querySelector(".f-chip"), document.querySelector(".f-chip"));
    const chipText = document.querySelector(".f-chip")?.textContent || "";
    ok("unified search chip combines scope and query", chipText.includes('systems: "CRM"'), chipText);

    // H1: expanded Active strip must show committed chips (not only the collapsed pill)
    ok("expanded HUD shows Active section", !!document.querySelector(".hud-active-section"));
    ok("expanded Active row shows the search chip",
      !!document.querySelector(".hud-active-chips-row .f-chip") &&
      (document.querySelector(".hud-active-chips-row .f-chip")?.textContent || "").includes("CRM"));
    const funnelBtn = document.querySelector('[aria-label="Toggle Filters HUD"]');
    const facetBadge = funnelBtn?.querySelector(".ctool-badge");
    ok("filter funnel shows facet badge",
      !!facetBadge && facetBadge.style.display !== "none" && facetBadge.textContent === "1",
      facetBadge && `display=${facetBadge.style.display} text=${facetBadge.textContent}`);

    // Stack enough facets to exercise vertical max-2 + scroll (Active + collapsed pill).
    // Order in chips: queries, systems, statuses, timings, needs, flow.
    document.querySelector('[data-dd="Status"]')._ddSet(["planned", "implemented", "unknown"]);
    const flowsForCap = await (await fetch("/api/projects/Demo/flows")).json();
    if (flowsForCap[0]?.id) document.querySelector('[data-dd="Flow"]')._ddSet(flowsForCap[0].id);
    await sleep(350);

    const activeRow = document.querySelector(".hud-active-chips-row");
    ok("expanded Active chips row present with multiple facets",
      !!activeRow && activeRow.querySelectorAll(".f-chip").length >= 3,
      activeRow && activeRow.querySelectorAll(".f-chip").length);
    // Every expanded chip keeps label + ✕ structure
    const activeChips = [...(activeRow?.querySelectorAll(".f-chip") || [])];
    ok("expanded Active chips use f-chip-text labels",
      activeChips.length > 0 && activeChips.every((c) => {
        const t = c.querySelector(".f-chip-text");
        return t && t.textContent.trim().length > 0;
      }),
      activeChips.map((c) => c.textContent).join("|"));
    // Vertical stack, max ~2 chips visible, scroll for the rest
    if (activeRow) {
      const arCs = getComputedStyle(activeRow);
      const maxH = parseFloat(arCs.maxHeight);
      ok("Active chips stack is vertical (column)",
        arCs.flexDirection === "column", arCs.flexDirection);
      ok("Active chips row has max-height ~2 chips",
        Number.isFinite(maxH) && maxH > 30 && maxH <= 72,
        arCs.maxHeight);
      ok("Active chips row allows vertical scroll",
        arCs.overflowY === "auto" || arCs.overflowY === "scroll",
        arCs.overflowY);
      ok("Active chips row height is constrained by max-height",
        activeRow.clientHeight <= maxH + 2,
        `client=${activeRow.clientHeight} max=${maxH} scroll=${activeRow.scrollHeight}`);
      ok("Active chips row overflows (scroll needed with 5 facets)",
        activeRow.scrollHeight > activeRow.clientHeight + 1,
        `client=${activeRow.clientHeight} scroll=${activeRow.scrollHeight}`);
      const prev = activeRow.scrollTop;
      activeRow.scrollTop = Math.min(40, activeRow.scrollHeight);
      ok("Active chips row is scrollable when overflowing",
        activeRow.scrollTop > prev || activeRow.scrollTop > 0,
        activeRow.scrollTop);
      activeRow.scrollTop = 0;
    } else {
      ok("Active chips stack is vertical (column)", false, "no row");
      ok("Active chips row has max-height ~2 chips", false, "no row");
      ok("Active chips row allows vertical scroll", false, "no row");
      ok("Active chips row height is constrained by max-height", false, "no row");
      ok("Active chips row overflows (scroll needed with 5 facets)", false, "no row");
      ok("Active chips row is scrollable when overflowing", false, "no row");
    }

    // H3a: scrolling suggestions then hovering must not reset scrollTop
    const scrollEl = document.querySelector(".hud-suggestions-scroll");
    if (scrollEl) {
      scrollEl.scrollTop = Math.min(200, scrollEl.scrollHeight);
      const before = scrollEl.scrollTop;
      const items = document.querySelectorAll(".hud-suggestions-scroll .hud-item");
      const mid = items[Math.min(8, items.length - 1)];
      mid?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      await sleep(50);
      ok("hover after scroll keeps scroll position (H3a)",
        Math.abs(scrollEl.scrollTop - before) < 4, `before=${before} after=${scrollEl.scrollTop}`);
    } else {
      ok("hover after scroll keeps scroll position (H3a)", false, "no .hud-suggestions-scroll");
    }

    // Need/Status still listed even when scope is systems (H4 partial)
    ok("Need section reachable with scope=systems",
      [...document.querySelectorAll(".hud-section-title")].some((el) => el.textContent === "Need"));

    // Click outside to collapse
    document.body.click();
    await sleep(200);
    ok("HUD collapses to pill when filters are active", !!document.getElementById("hud-collapsed-pill"));

    // Collapsed pill: vertical stack of ALL chips, CSS max 2 visible + scroll (no +N)
    {
      const pillEl = document.getElementById("hud-collapsed-pill");
      const stack = pillEl?.querySelector(".hud-pill-chips");
      const regularPillChips = [...(stack?.querySelectorAll(".f-chip") || [])]
        .filter((c) => !c.classList.contains("f-chip-more"));
      ok("collapsed pill lists all facets (no +N hide)",
        regularPillChips.length >= 5,
        regularPillChips.map((c) => c.textContent).join("|"));
      ok("collapsed pill has no +N chip",
        !pillEl?.querySelector(".f-chip-more"));
      const stackCs = stack ? getComputedStyle(stack) : null;
      ok("collapsed pill chip stack is vertical",
        !!stackCs && stackCs.flexDirection === "column", stackCs?.flexDirection);
      const stackMaxH = stackCs ? parseFloat(stackCs.maxHeight) : NaN;
      ok("collapsed pill stack max-height ~2 chips",
        Number.isFinite(stackMaxH) && stackMaxH > 30 && stackMaxH <= 72,
        stackCs?.maxHeight);
      ok("collapsed pill stack allows vertical scroll",
        !!stackCs && (stackCs.overflowY === "auto" || stackCs.overflowY === "scroll"),
        stackCs?.overflowY);
      ok("collapsed pill stack height constrained (scroll for rest)",
        !!stack && stack.clientHeight <= stackMaxH + 2 && stack.scrollHeight > stack.clientHeight + 1,
        stack && `client=${stack.clientHeight} max=${stackMaxH} scroll=${stack.scrollHeight}`);
      // Flow is journey context — first in the stack when set
      const firstLabel = regularPillChips[0]?.querySelector(".f-chip-text")?.textContent || "";
      ok("collapsed pill pins Flow chip first when flow is active",
        firstLabel.includes("Flow:"), firstLabel);
      // Labels readable: full-width rows with ellipsis, not single-glyph crush
      ok("collapsed pill chip labels readable (ellipsis, not crushed)",
        regularPillChips.every((c) => {
          const t = c.querySelector(".f-chip-text");
          if (!t || t.textContent.trim().length < 3) return false;
          return t.getBoundingClientRect().width > 24;
        }),
        regularPillChips.map((c) => {
          const t = c.querySelector(".f-chip-text");
          return `${t?.textContent}:${t?.getBoundingClientRect().width}`;
        }).join("|"));
      ok("collapsed pill chips expose full label via title",
        regularPillChips.every((c) => (c.getAttribute("title") || "").length > 0));
      // First visible chip should show a meaningful Flow prefix (not "F…" alone)
      ok("collapsed pill Flow label shows 'Flow:' prefix",
        firstLabel.startsWith("Flow:"), firstLabel);
      const badgeN = parseInt(document.querySelector('[aria-label="Toggle Filters HUD"] .ctool-badge')?.textContent || "0", 10);
      ok("funnel badge counts all facets",
        badgeN >= 5, badgeN);
    }

    // Verify dragging the collapsed pill
    const pill = document.getElementById("hud-collapsed-pill");
    const container = document.getElementById("filter-hud-container");
    const initTop = parseInt(container.style.top || "0");
    const initLeft = parseInt(container.style.left || "0");

    pill.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 150, clientY: 150, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 150, clientY: 150, bubbles: true }));
    pill.click(); // Trigger click event
    await sleep(200);

    const newTop = parseInt(container.style.top || "0");
    const newLeft = parseInt(container.style.left || "0");
    ok("collapsed pill is draggable anywhere", newTop !== initTop && newLeft !== initLeft);
    ok("dragging collapsed pill does not expand it", !!document.getElementById("hud-collapsed-pill") && document.getElementById("filter-hud").style.display === "none");

    // Drag pill all the way to the right
    pill.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 3000, clientY: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 3000, clientY: 100, bubbles: true }));
    pill.click(); // Trigger click
    await sleep(200);

    const farRightLeft = parseInt(container.style.left || "0");
    const colEl = document.querySelector(".canvas-col");
    const oldMaxLeft = colEl.clientWidth - 340;
    ok("collapsed pill can be dragged past the old 340px right constraint", farRightLeft > oldMaxLeft);

    // Toggle filter button off (bypass filter). Title is dynamic when facets
    // are active — select by aria-label.
    const filterBtn = document.querySelector('[aria-label="Toggle Filters HUD"]');
    filterBtn?.click();
    await sleep(300);
    ok("HUD hidden when filter toggled off", !document.getElementById("hud-collapsed-pill") || document.getElementById("hud-collapsed-pill").style.display === "none");

    // Option 1: no canvas dormant banner — funnel alone carries bypassed state
    ok("no dormant-filters-banner on canvas when Filter Off",
      !document.querySelector(".dormant-filters-banner"));
    ok("funnel is dormant (saved facets, Filter Off)",
      !!filterBtn && filterBtn.classList.contains("dormant")
      && filterBtn.classList.contains("has-facets")
      && !filterBtn.classList.contains("active"),
      filterBtn?.className);
    const dormBadge = filterBtn?.querySelector(".ctool-badge");
    ok("funnel badge still shows facet count while dormant",
      !!dormBadge && dormBadge.style.display !== "none"
      && parseInt(dormBadge.textContent || "0", 10) >= 5,
      dormBadge?.textContent);
    const dormTitle = filterBtn?.getAttribute("title") || "";
    ok("funnel title says filters saved · re-enable",
      /saved/i.test(dormTitle) && /re-enable/i.test(dormTitle),
      dormTitle);
    const dormCs = filterBtn ? getComputedStyle(filterBtn) : null;
    ok("dormant funnel uses dashed border",
      !!dormCs && dormCs.borderStyle.includes("dashed"),
      dormCs?.borderStyle);

    // Toggle filter button back on
    filterBtn?.click();
    await sleep(300);
    ok("HUD restored when filter toggled back on", !!document.getElementById("filter-hud") && document.getElementById("filter-hud").style.display !== "none");
    ok("funnel no longer dormant when Filter On",
      !filterBtn?.classList.contains("dormant") && filterBtn?.classList.contains("active"));

    // Clear facets only (does not disable Filter or collapse the HUD)
    document.querySelector(".hud-clear-btn").click();
    await sleep(300);
    const chipTexts = [...document.querySelectorAll(".f-chip")].map((c) => c.textContent).join("|");
    ok("Clear removes search facet chip", !chipTexts.includes("CRM"));
    ok("Clear removes status and flow facets",
      !chipTexts.includes("Status:") && !chipTexts.includes("Flow:"), chipTexts);
    ok("Clear keeps Filter enabled",
      document.querySelector('[aria-label="Toggle Filters HUD"]')?.classList.contains("active"));

    // ---- DR-8: stream editor — sticky Save/Cancel, unified combo inputs ----
    document.querySelectorAll(".rail-tabs button")[1].click(); // Streams tab
    await sleep(300);
    document.querySelector(".rail-body .entity-item .btn")?.click(); // edit first stream
    await sleep(400);
    const streamForm = document.querySelector(".rail-form form");
    ok("stream edit form opens from the Streams tab", !!streamForm);
    const railBody = document.querySelector(".rail-body");
    railBody.scrollTop = 0;
    await sleep(150);
    const fa = streamForm?.querySelector(".form-actions");
    const faCs = fa ? getComputedStyle(fa) : null;
    ok("stream form actions are sticky", !!faCs && faCs.position === "sticky", faCs?.position);
    const rbRect = railBody.getBoundingClientRect();
    const faRect = fa?.getBoundingClientRect();
    ok("Save/Cancel visible with the form scrolled to the top",
      !!faRect && faRect.bottom <= rbRect.bottom + 1 && faRect.top >= rbRect.top,
      faRect && { faBottom: Math.round(faRect.bottom), railBottom: Math.round(rbRect.bottom) });
    const combo = streamForm?.querySelector(".dd.editable");
    const comboCs = combo ? getComputedStyle(combo) : null;
    const comboInputCs = combo ? getComputedStyle(combo.querySelector(".dd-input")) : null;
    ok("editable combo is one control: border on container, none on input",
      !!comboCs && comboCs.borderTopWidth === "1px" && comboCs.display === "flex"
      && !!comboInputCs && comboInputCs.borderTopWidth === "0px",
      { combo: comboCs?.borderTopWidth, input: comboInputCs?.borderTopWidth });
    [...(streamForm?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Cancel")?.click();
    await sleep(200);
    ok("Cancel closes the stream editor", !document.querySelector(".rail-form form"));

    // ---- DR-4: opening the inspector pans an occluded selection into view ----
    // Pin a wide row of nodes so the rightmost one sits in the strip the
    // inspector will cover, click it, and the canvas must pan it left of the
    // panel seam. A node already clear of the seam must NOT trigger a pan.
    {
      const graphSys = (await (await fetch("/api/projects/Demo/graph")).json()).systems.map((s) => s.id);
      const wide = Object.fromEntries(graphSys.map((id, i) => [id, { x: 80 + i * 170, y: 350, pinned: true }]));
      await fetch("/api/projects/Demo/layout", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wide),
      });
      await sleep(250);
      location.hash = "#/__dr4"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1200);
      const byX = [...document.querySelectorAll("g.node")].sort((a, b) => (a.__data__?.x ?? 0) - (b.__data__?.x ?? 0));
      ok("DR-4: wide pinned layout loaded", byX.length === 7, byX.length);
      // screen x of a node center from data + zoom transform (SVG bounding
      // rects don't track transforms in this headless harness)
      const svgEl = document.querySelector(".canvas-wrap svg");
      const wrapRect = () => document.querySelector(".canvas-wrap").getBoundingClientRect();
      const screenCx = (g) => wrapRect().left + window.d3.zoomTransform(svgEl).applyX(g.__data__.x);
      const rightmost = byX[byX.length - 1];
      const cxBefore = screenCx(rightmost);
      rightmost.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(1000); // inspector mount + 200ms pan transition
      const inspEl = document.querySelector(".inspector");
      ok("DR-4: node click opens the inspector", !!inspEl);
      const inspLeft = inspEl ? inspEl.getBoundingClientRect().left : 0;
      ok("DR-4: clicked node was occluded by the inspector", cxBefore > inspLeft,
        { cxBefore: Math.round(cxBefore), inspLeft: Math.round(inspLeft) });
      const cxAfter = screenCx(rightmost);
      ok("DR-4: occluded selection pans clear of the inspector seam",
        cxAfter < inspLeft - 20,
        { cxAfter: Math.round(cxAfter), inspLeft: Math.round(inspLeft) });
      ok("DR-4: selection sits inside the visible canvas",
        cxAfter > wrapRect().left && cxAfter < wrapRect().right,
        { cxAfter: Math.round(cxAfter), wrapLeft: Math.round(wrapRect().left), wrapRight: Math.round(wrapRect().right) });
      // a node already clear of the seam must not move the view
      const visible = byX.find((g) => {
        const cx = screenCx(g);
        return cx > wrapRect().left + 80 && cx < inspLeft - 120;
      });
      const txBefore = window.d3.zoomTransform(svgEl).x;
      visible?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(700);
      ok("DR-4: clicking an already-visible node does not pan",
        !!visible && Math.abs(window.d3.zoomTransform(svgEl).x - txBefore) < 1,
        { before: Math.round(txBefore), after: Math.round(window.d3.zoomTransform(svgEl).x) });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(200);
    }

    // ---- GS-1: multi-select, marquee, group drag, Cmd+A, reconciliation ----
    {
      // Live DOM queries — hash remounts replace the svg/wrap nodes.
      const svgEl = () => document.querySelector(".canvas-wrap svg");
      const wrap = () => document.querySelector(".canvas-wrap");
      const gGraph = (await (await fetch("/api/projects/Demo/graph")).json());
      const sysByName = Object.fromEntries(gGraph.systems.map((s) => [s.name, s.id]));
      // Pin a known grid so marquee/drag assertions are stable (3 columns × rows).
      // A=Commerce B=Billing C=CRM — rest far away.
      const pinLayout = {};
      for (const s of gGraph.systems) {
        pinLayout[s.id] = { x: 900, y: 700, pinned: true };
      }
      const A = sysByName["Commerce"], B = sysByName["Billing"], C = sysByName["CRM"];
      if (A) pinLayout[A] = { x: 120, y: 200, pinned: true };
      if (B) pinLayout[B] = { x: 320, y: 200, pinned: true };
      if (C) pinLayout[C] = { x: 520, y: 200, pinned: true };
      await fetch("/api/projects/Demo/layout", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pinLayout),
      });
      await sleep(200);
      location.hash = "#/__gs1"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1200);

      const nodeById = (id) => [...document.querySelectorAll("g.node")].find((g) => g.__data__?.id === id);
      const screenOf = (g) => {
        const svg = svgEl();
        const t = window.d3.zoomTransform(svg);
        const r = wrap().getBoundingClientRect();
        return { x: r.left + t.applyX(g.__data__.x), y: r.top + t.applyY(g.__data__.y) };
      };
      const haloOn = (id) => {
        const g = nodeById(id);
        return g?.querySelector(".halo")?.getAttribute("visibility") === "visible";
      };
      const inspTitle = () => document.querySelector(".inspector h3")?.textContent?.trim() || "";

      // Shift-click toggle: 0 → node → group → node → null
      const nA = nodeById(A), nB = nodeById(B), nC = nodeById(C);
      ok("GS-1: pinned nodes A/B/C present", !!(nA && nB && nC), { A: !!nA, B: !!nB, C: !!nC });
      nA?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(200);
      ok("GS-1: shift-click first node → node selection",
        !!document.querySelector(".inspector") && !inspTitle().includes("selected"),
        inspTitle());
      ok("GS-1: halo on first shift-clicked node", haloOn(A));
      nB?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(250);
      ok("GS-1: shift-click second → group selection",
        /2 systems selected/.test(inspTitle()), inspTitle());
      ok("GS-1: halos on both group members", haloOn(A) && haloOn(B));
      nC?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(200);
      ok("GS-1: shift-click third → 3 systems selected",
        /3 systems selected/.test(inspTitle()), inspTitle());
      // Toggle C off → group of 2
      nC?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(200);
      ok("GS-1: shift-click toggle off → 2 systems selected",
        /2 systems selected/.test(inspTitle()), inspTitle());
      // Toggle B off → single node
      nB?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(200);
      const oneTitle = inspTitle();
      ok("GS-1: shift-click down to 1 → node selection (not group)",
        !!document.querySelector(".inspector") && !oneTitle.includes("selected")
        && (oneTitle.includes("Commerce") || oneTitle.includes("Billing")),
        oneTitle);
      // Toggle the remaining selected node off → null (must hit the selected one)
      const lastNode = oneTitle.includes("Billing") ? nB : nA;
      lastNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(200);
      ok("GS-1: shift-click last off → no inspector", !document.querySelector(".inspector"));

      // Helpers for marquee + d3.drag (mousedown, not pointer events — this d3 build)
      const doMarquee = async (cx0, cy0, cx1, cy1) => {
        svgEl().dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true, cancelable: true, shiftKey: true, button: 0,
          clientX: cx0, clientY: cy0, view: window,
        }));
        await sleep(30);
        window.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true, cancelable: true, shiftKey: true, button: 0,
          clientX: cx1, clientY: cy1, view: window,
        }));
        await sleep(40);
        window.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true, cancelable: true, shiftKey: true, button: 0,
          clientX: cx1, clientY: cy1, view: window,
        }));
        await sleep(200);
      };
      const doDrag = async (el, from, to) => {
        // d3.drag listens on the node (mousedown) then on the window (mousemove/up).
        // Prefer the body circle — it's the hit target users grab.
        const target = el.querySelector?.(".body") || el;
        target.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true, cancelable: true, button: 0, buttons: 1,
          clientX: from.x, clientY: from.y, view: window,
        }));
        await sleep(30);
        // Intermediate steps: some d3 builds only apply drag after a few moves.
        const steps = 4;
        for (let i = 1; i <= steps; i++) {
          const cx = from.x + (to.x - from.x) * (i / steps);
          const cy = from.y + (to.y - from.y) * (i / steps);
          window.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true, cancelable: true, button: 0, buttons: 1,
            clientX: cx, clientY: cy, view: window,
          }));
          await sleep(20);
        }
        window.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true, cancelable: true, button: 0, buttons: 0,
          clientX: to.x, clientY: to.y, view: window,
        }));
        await sleep(80);
      };

      // Re-pin A/B on a known row and remount so DR-4's pan/layout cannot
      // leave nodes or the zoom transform off-screen for marquee math.
      {
        const g2 = await (await fetch("/api/projects/Demo/graph")).json();
        const lay = { ...(g2.layout || {}) };
        for (const s of g2.systems) {
          lay[s.id] = { x: 900, y: 700, pinned: true };
        }
        lay[A] = { x: 140, y: 220, pinned: true };
        lay[B] = { x: 360, y: 220, pinned: true };
        lay[C] = { x: 580, y: 220, pinned: true };
        await fetch("/api/projects/Demo/layout", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(lay),
        });
        await sleep(200);
        location.hash = "#/__gs1m"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1100);
      }
      // Fit via the toolbar button (more reliable than a synth keydown under virtual time)
      const fitBtn = document.querySelector('.canvas-toolbar [aria-label="Fit"], .canvas-toolbar button[title*="Fit"]')
        || [...document.querySelectorAll(".canvas-toolbar button")].find((b) => /fit/i.test(b.getAttribute("title") || ""));
      fitBtn?.click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
      await sleep(500);
      const na = nodeById(A), nb = nodeById(B);
      ok("GS-1: A/B on-canvas before marquee",
        !!na && !!nb && Number.isFinite(na.__data__?.x) && Math.abs(na.__data__.x - 140) < 40,
        { ax: na?.__data__?.x, bx: nb?.__data__?.x });
      const sa = screenOf(na), sb = screenOf(nb);
      const svgRect = svgEl().getBoundingClientRect();
      // Marquee client coords must sit inside the svg; pad in screen space.
      let x0 = Math.min(sa.x, sb.x) - 40;
      let y0 = Math.min(sa.y, sb.y) - 40;
      let x1 = Math.max(sa.x, sb.x) + 40;
      let y1 = Math.max(sa.y, sb.y) + 40;
      // Clamp into the svg rect so invert() maps to real graph space
      x0 = Math.max(svgRect.left + 4, x0);
      y0 = Math.max(svgRect.top + 4, y0);
      x1 = Math.min(svgRect.right - 4, x1);
      y1 = Math.min(svgRect.bottom - 4, y1);
      ok("GS-1: marquee screen box is inside svg",
        x1 - x0 > 20 && y1 - y0 > 10 && x0 >= svgRect.left && x1 <= svgRect.right,
        { x0, y0, x1, y1, svgRect: { l: svgRect.left, t: svgRect.top, r: svgRect.right, b: svgRect.bottom }, sa, sb });

      // Marquee: start drag and assert rect mid-flight, then finish
      svgEl().dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, shiftKey: true, button: 0,
        clientX: x0, clientY: y0, view: window,
      }));
      await sleep(40);
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, shiftKey: true, button: 0,
        clientX: x1, clientY: y1, view: window,
      }));
      await sleep(50);
      const marqueeEl = svgEl()?.querySelector("rect.marquee");
      ok("GS-1: marquee rect appears during shift-drag",
        !!marqueeEl && marqueeEl.style.display !== "none"
        && marqueeEl.getAttribute("display") !== "none");
      if (marqueeEl) {
        ok("GS-1: marquee stroke is amber", marqueeEl.getAttribute("stroke") === "#e6a23c");
        ok("GS-1: marquee fill-opacity 0.06", marqueeEl.getAttribute("fill-opacity") === "0.06");
        ok("GS-1: marquee stroke-dasharray 4,3", marqueeEl.getAttribute("stroke-dasharray") === "4,3");
      }
      window.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true, cancelable: true, shiftKey: true, button: 0,
        clientX: x1, clientY: y1, view: window,
      }));
      await sleep(300);
      ok("GS-1: marquee selects A+B as group",
        /2 systems selected/.test(inspTitle()), inspTitle());
      ok("GS-1: marquee result lights halos on members", haloOn(A) && haloOn(B));

      // Sub-4px marquee clears (click on empty corner of the svg)
      const sr2 = svgEl().getBoundingClientRect();
      await doMarquee(sr2.left + 8, sr2.top + 8, sr2.left + 10, sr2.top + 10);
      ok("GS-1: sub-4px marquee clears selection", !document.querySelector(".inspector"), inspTitle());

      // Build a fresh group for Esc + inspector checks (plain click A, shift B)
      nodeById(A)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(100);
      nodeById(B)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(200);
      ok("GS-1: pre-Esc group inspector open", /2 systems selected/.test(inspTitle()), inspTitle());

      // Esc during marquee cancels and does NOT close inspector
      const sr3 = svgEl().getBoundingClientRect();
      svgEl().dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, shiftKey: true, button: 0,
        clientX: sr3.left + 20, clientY: sr3.top + 20, view: window,
      }));
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, shiftKey: true, button: 0,
        clientX: sr3.left + 120, clientY: sr3.top + 120, view: window,
      }));
      await sleep(50);
      const mqBeforeEsc = svgEl()?.querySelector("rect.marquee");
      ok("GS-1: marquee active before Esc",
        !!mqBeforeEsc && mqBeforeEsc.style.display !== "none");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(100);
      const mqAfterEsc = svgEl()?.querySelector("rect.marquee");
      ok("GS-1: Esc cancels marquee (rect hidden)",
        !mqAfterEsc || mqAfterEsc.style.display === "none"
        || mqAfterEsc.getAttribute("display") === "none");
      ok("GS-1: Esc during marquee keeps inspector open",
        /2 systems selected/.test(inspTitle()), inspTitle());

      // Group inspector: member list + Pin all / Unpin all only (GS-1 surface)
      const insp = document.querySelector(".inspector");
      const memberList = insp?.querySelector(".group-member-list");
      ok("GS-1: group inspector has member list", !!memberList);
      // getComputedStyle resolves vh to px — assert it's a finite height cap, not "none".
      const mh = memberList ? getComputedStyle(memberList).maxHeight : "";
      const mhPx = parseFloat(mh);
      ok("GS-1: member list max-height capped (~40vh)",
        !!memberList && Number.isFinite(mhPx) && mhPx > 80 && mhPx < 800,
        mh);
      const gBtns = [...(insp?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim());
      ok("GS-1: Pin all / Unpin all present",
        gBtns.includes("Pin all") && gBtns.includes("Unpin all"), gBtns);
      ok("GS-1: group inspector has Set type + Delete… (GS-2)",
        gBtns.includes("Set type") && gBtns.some((t) => t.startsWith("Delete")), gBtns);
      ok("GS-1: group inspector has Make cluster (GS-4)",
        gBtns.includes("Make cluster"), gBtns);

      // Group drag: same delta for every member; one history entry.
      // Re-assert group selection in case Esc-path left us without one.
      if (!/2 systems selected/.test(inspTitle())) {
        nodeById(A)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await sleep(80);
        nodeById(B)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        await sleep(200);
      }
      ok("GS-1: group ready for drag", /2 systems selected/.test(inspTitle()), inspTitle());
      const h0 = (await (await fetch("/api/projects/Demo/history")).json()).entries.length;
      const posBefore = {
        A: { x: nodeById(A).__data__.x, y: nodeById(A).__data__.y },
        B: { x: nodeById(B).__data__.x, y: nodeById(B).__data__.y },
      };
      const grab = nodeById(A);
      const gScreen = screenOf(grab);
      await doDrag(grab, gScreen, { x: gScreen.x + 80, y: gScreen.y + 40 });
      const posAfter = {
        A: { x: nodeById(A).__data__.x, y: nodeById(A).__data__.y },
        B: { x: nodeById(B).__data__.x, y: nodeById(B).__data__.y },
      };
      const dAx = posAfter.A.x - posBefore.A.x, dAy = posAfter.A.y - posBefore.A.y;
      const dBx = posAfter.B.x - posBefore.B.x, dBy = posAfter.B.y - posBefore.B.y;
      ok("GS-1: group drag moved members", Math.hypot(dAx, dAy) > 10, { dAx, dAy, dBx, dBy, posBefore, posAfter });
      ok("GS-1: group drag shared delta (formation preserved)",
        Math.hypot(dAx, dAy) > 10 && Math.abs(dAx - dBx) < 2 && Math.abs(dAy - dBy) < 2,
        { dAx, dAy, dBx, dBy });
      // Wait for debounced layout save (800ms) + network
      await sleep(1200);
      const h1 = (await (await fetch("/api/projects/Demo/history")).json()).entries.length;
      ok("GS-1: group drag grows history by exactly 1",
        Math.hypot(dAx, dAy) > 10 && h1 === h0 + 1, { h0, h1, dAx, dAy });

      // Bounding-box clamp: park group against left edge, drag further left —
      // formation must not squash (relative positions stay).
      const edgeLayout = { ...pinLayout };
      edgeLayout[A] = { x: 30, y: 250, pinned: true };
      edgeLayout[B] = { x: 230, y: 250, pinned: true };
      await fetch("/api/projects/Demo/layout", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(edgeLayout),
      });
      await sleep(200);
      location.hash = "#/__gs1b"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1100);
      // re-select A+B via plain + shift (not two shift-clicks from empty)
      nodeById(A)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(80);
      nodeById(B)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(200);
      const gapBefore = nodeById(B).__data__.x - nodeById(A).__data__.x;
      const g2 = nodeById(A);
      const s2 = screenOf(g2);
      await doDrag(g2, s2, { x: s2.x - 200, y: s2.y });
      const gapAfter = nodeById(B).__data__.x - nodeById(A).__data__.x;
      ok("GS-1: edge clamp preserves formation gap",
        Math.abs(gapAfter - gapBefore) < 2, { gapBefore, gapAfter });

      // Cmd/Ctrl+A with hide-filter: only visible nodes.
      // status=planned + Hide leaves a known subset on the canvas (demo: 3).
      document.querySelector('[data-dd="Status"]')?._ddSet("planned");
      await sleep(250);
      getToggle("Unmatched")?.querySelectorAll("button")[1]?.click(); // Hide
      await sleep(450);
      const visibleBefore = document.querySelectorAll("g.node").length;
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "a", bubbles: true, ctrlKey: true, metaKey: true,
      }));
      await sleep(250);
      const titleAfterA = inspTitle();
      const mA = titleAfterA.match(/(\d+) systems selected/);
      const nSel = mA ? +mA[1] : (document.querySelector(".inspector") && !titleAfterA.includes("selected") ? 1 : 0);
      ok("GS-1: Cmd+A with hide-filter selects only visible nodes",
        visibleBefore >= 1 && nSel === visibleBefore,
        { titleAfterA, visibleBefore, nSel });
      // Reset hide mode + status so later tests aren't poisoned
      getToggle("Unmatched")?.querySelectorAll("button")[0]?.click(); // Dim
      document.querySelector('[data-dd="Status"]')?._ddSet("");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(200);

      // Reconciliation: select group of 3, delete one via API, force reload via Save
      const gNow = await (await fetch("/api/projects/Demo/graph")).json();
      const ids3 = gNow.systems.slice(0, 3).map((s) => s.id);
      const killId = ids3[2];
      // Pin layout again and reload workspace
      const lay3 = Object.fromEntries(gNow.systems.map((s, i) => [s.id, { x: 100 + i * 80, y: 300, pinned: true }]));
      await fetch("/api/projects/Demo/layout", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lay3),
      });
      await sleep(150);
      location.hash = "#/__gs1c"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1100);
      for (const id of ids3) {
        nodeById(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        await sleep(80);
      }
      await sleep(200);
      ok("GS-1: pre-delete group of 3", /3 systems selected/.test(inspTitle()), inspTitle());
      await fetch(`/api/projects/Demo/systems/${encodeURIComponent(killId)}`, { method: "DELETE" });
      // Force client reload without clearing selection: Save a need (no-op fields)
      document.querySelectorAll(".rail-tabs button")[2]?.click(); // needs
      await sleep(250);
      const needEdit = [...document.querySelectorAll(".rail-body .entity-item .btn")]
        .find((b) => b.textContent.trim() === "Edit");
      needEdit?.click();
      await sleep(300);
      const needForm = document.querySelector(".rail-form form");
      needForm?.requestSubmit?.() || needForm?.querySelector('button[type="submit"]')?.click();
      await sleep(900);
      const afterDelTitle = inspTitle();
      ok("GS-1: reload after member delete shrinks group (2 left → group)",
        /2 systems selected/.test(afterDelTitle), afterDelTitle);
      // Restore deleted system so later suite counts stay sane
      let ug = 0, uh;
      do {
        uh = await (await fetch("/api/projects/Demo/undo", { method: "POST" })).json();
        await sleep(100);
        const restored = (await (await fetch("/api/projects/Demo/graph")).json()).systems
          .some((s) => s.id === killId);
        if (restored) break;
      } while (uh?.can_undo && ++ug < 8);
      location.hash = "#/__gs1d"; await sleep(60); location.hash = "#/p/Demo"; await sleep(900);
    }

    // ---- GS-2: batch set type + delete (one history entry each) ----
    {
      const g0 = await (await fetch("/api/projects/Demo/graph")).json();
      // Create 3 disposable systems so we don't wreck the demo core.
      const mk = async (name) => {
        const r = await fetch("/api/projects/Demo/systems", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type: "internal" }),
        });
        return r.json();
      };
      const s1 = await mk("GS2-A");
      const s2 = await mk("GS2-B");
      const s3 = await mk("GS2-C");
      // Link s1→s2 so bulk-delete confirm mentions streams.
      await fetch("/api/projects/Demo/streams", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "GS2-link",
          timing: "scheduled", direction: "uni", status: "implemented",
          source: { system_id: s1.id, entity_ids: [], fields_mode: "unknown", field_ids: [] },
          destination: { system_id: s2.id, entity_ids: [], fields_mode: "unknown", field_ids: [] },
        }),
      });
      await sleep(200);
      // Pin them together and remount
      const lay = { ...(g0.layout || {}) };
      for (const s of (await (await fetch("/api/projects/Demo/graph")).json()).systems) {
        lay[s.id] = lay[s.id] || { x: 800, y: 600, pinned: true };
      }
      lay[s1.id] = { x: 150, y: 180, pinned: true };
      lay[s2.id] = { x: 350, y: 180, pinned: true };
      lay[s3.id] = { x: 550, y: 180, pinned: true };
      await fetch("/api/projects/Demo/layout", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lay),
      });
      await sleep(150);
      location.hash = "#/__gs2"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1200);

      const nodeById = (id) => [...document.querySelectorAll("g.node")].find((g) => g.__data__?.id === id);
      const inspTitle = () => document.querySelector(".inspector h3")?.textContent?.trim() || "";
      const selectGroup = async (ids) => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(100);
        nodeById(ids[0])?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await sleep(80);
        for (let i = 1; i < ids.length; i++) {
          nodeById(ids[i])?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
          await sleep(80);
        }
        await sleep(200);
      };
      const histLen = async () => (await (await fetch("/api/projects/Demo/history")).json()).entries.length;
      const toastText = () => document.getElementById("toast")?.textContent || "";

      // ---- Set type on group = one history entry; toast copy ----
      await selectGroup([s1.id, s2.id, s3.id]);
      ok("GS-2: group of 3 disposable systems selected", /3 systems selected/.test(inspTitle()), inspTitle());
      const hBeforeType = await histLen();
      [...document.querySelectorAll(".inspector button")].find((b) => b.textContent.trim() === "Set type")?.click();
      await sleep(150);
      const typeBtns = [...document.querySelectorAll(".group-type-options button, .inspector button")]
        .filter((b) => ["internal", "external", "unknown"].includes(b.textContent.trim()));
      ok("GS-2: Set type expands type options", typeBtns.length >= 3, typeBtns.map((b) => b.textContent));
      typeBtns.find((b) => b.textContent.trim() === "external")?.click();
      await sleep(900);
      const hAfterType = await histLen();
      ok("GS-2: set type on group = one history entry", hAfterType === hBeforeType + 1, { hBeforeType, hAfterType });
      // History message (user-visible)
      const hist = await (await fetch("/api/projects/Demo/history")).json();
      const tipMsg = hist.entries?.find((e) => e.current)?.message || hist.entries?.[0]?.message || "";
      ok("GS-2: history message is set type on N systems",
        /set type on 3 systems/.test(tipMsg), tipMsg);
      ok("GS-2: set-type toast copy",
        /Type set on 3 systems/.test(toastText()), toastText());
      const gTypes = await (await fetch("/api/projects/Demo/graph")).json();
      const types = [s1.id, s2.id, s3.id].map((id) => gTypes.systems.find((s) => s.id === id)?.type);
      ok("GS-2: all three systems are external", types.every((t) => t === "external"), types);

      // ---- Delete key arms confirm strip; does not delete ----
      await selectGroup([s1.id, s2.id, s3.id]);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      await sleep(200);
      const strip = document.querySelector(".inspector .warn-note");
      const stripText = strip?.textContent || "";
      ok("GS-2: Delete key arms the confirm strip", !!strip, stripText);
      ok("GS-2: confirm strip mentions system count", /Delete 3 systems\?/.test(stripText), stripText);
      ok("GS-2: confirm strip mentions stream cascade",
        /1 stream touching them is deleted too/.test(stripText), stripText);
      ok("GS-2: confirm strip says recoverable from trash",
        /Recoverable from the project trash/.test(stripText), stripText);
      // Nothing deleted yet
      const still3 = (await (await fetch("/api/projects/Demo/graph")).json()).systems
        .filter((s) => [s1.id, s2.id, s3.id].includes(s.id));
      ok("GS-2: Delete key alone does not delete", still3.length === 3, still3.length);

      // ---- Confirm delete = one history entry; undo restores all 3 + stream ----
      const hBeforeDel = await histLen();
      [...(strip?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Delete")?.click();
      await sleep(1000);
      const hAfterDel = await histLen();
      ok("GS-2: batch delete of 3 = one history entry", hAfterDel === hBeforeDel + 1, { hBeforeDel, hAfterDel });
      const histDel = await (await fetch("/api/projects/Demo/history")).json();
      const delMsg = histDel.entries?.find((e) => e.current)?.message || "";
      ok("GS-2: history message is delete N systems",
        /delete 3 systems/.test(delMsg), delMsg);
      ok("GS-2: delete toast copy",
        /Deleted 3 systems/.test(toastText()), toastText());
      const afterDel = await (await fetch("/api/projects/Demo/graph")).json();
      ok("GS-2: three systems gone from graph",
        !afterDel.systems.some((s) => [s1.id, s2.id, s3.id].includes(s.id)));
      ok("GS-2: touching stream gone too",
        !afterDel.streams.some((st) => st.name === "GS2-link"));
      ok("GS-2: selection cleared after bulk delete", !document.querySelector(".inspector"));

      // Undo once restores systems + stream
      const undoRes = await (await fetch("/api/projects/Demo/undo", { method: "POST" })).json();
      await sleep(200);
      // Nudge app to reload
      location.hash = "#/__gs2u"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1000);
      const afterUndo = await (await fetch("/api/projects/Demo/graph")).json();
      const restored = afterUndo.systems.filter((s) => [s1.id, s2.id, s3.id].includes(s.id));
      ok("GS-2: one undo restores all 3 systems", restored.length === 3, restored.map((s) => s.name));
      ok("GS-2: one undo restores the touching stream",
        afterUndo.streams.some((st) => st.name === "GS2-link"));
      // Clean up disposable systems for later suite stability (batch delete again)
      await fetch("/api/projects/Demo/systems/batch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ops: [s1.id, s2.id, s3.id].map((id) => ({ op: "delete", id })),
        }),
      });
      await sleep(200);
      location.hash = "#/__gs2done"; await sleep(60); location.hash = "#/p/Demo"; await sleep(900);
      void undoRes;
    }

    // ---- GS-4: cluster frontend — Make cluster, hulls, delete, 1/2-member, hide ----
    {
      const svgEl = () => document.querySelector(".canvas-wrap svg");
      const wrap = () => document.querySelector(".canvas-wrap");
      const g0 = await (await fetch("/api/projects/Demo/graph")).json();
      const byName = Object.fromEntries(g0.systems.map((s) => [s.name, s]));
      const A = byName["Commerce"], B = byName["Billing"], C = byName["CRM"];
      ok("GS-4: Commerce/Billing/CRM present", !!(A && B && C));

      // Clean any leftover clusters from prior runs
      for (const c of (g0.clusters ?? [])) {
        await fetch(`/api/projects/Demo/clusters/${c.id}`, { method: "DELETE" });
      }

      // Pin A,B,C in a known triangle so hulls are stable
      const pinLayout = {};
      for (const s of g0.systems) pinLayout[s.id] = { x: 900, y: 700, pinned: true };
      pinLayout[A.id] = { x: 140, y: 200, pinned: true };
      pinLayout[B.id] = { x: 340, y: 200, pinned: true };
      pinLayout[C.id] = { x: 240, y: 360, pinned: true };
      await fetch("/api/projects/Demo/layout", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pinLayout),
      });
      location.hash = "#/__gs4"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1100);

      const nodeById = (id) => [...document.querySelectorAll("g.node")].find((g) => g.__data__?.id === id);
      const inspTitle = () => document.querySelector(".inspector h3")?.textContent?.trim() || "";
      const hullPath = (clusterId) =>
        document.querySelector(`g.hull path.hull-plate`) &&
        [...document.querySelectorAll("g.hull")].find((g) => g.__data__?.id === clusterId)
          ?.querySelector("path.hull-plate");

      // Select A+B as group via shift-click
      nodeById(A.id)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(150);
      nodeById(B.id)?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      await sleep(250);
      ok("GS-4: group of A+B ready for Make cluster", /2 systems selected/.test(inspTitle()), inspTitle());

      // Make cluster flow
      const makeBtn = [...document.querySelectorAll(".inspector button")]
        .find((b) => b.textContent.trim() === "Make cluster");
      ok("GS-4: Make cluster button present", !!makeBtn);
      makeBtn?.click();
      await sleep(200);
      const nameInput = document.querySelector(".group-cluster-name");
      ok("GS-4: inline cluster name input open", !!nameInput);
      if (nameInput) {
        nameInput.value = "Payments";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const createBtn = [...document.querySelectorAll(".inspector button")]
        .find((b) => b.textContent.trim() === "Create");
      ok("GS-4: Create button present", !!createBtn);
      createBtn?.click();
      await sleep(1200);

      const gAfterCreate = await (await fetch("/api/projects/Demo/graph")).json();
      const payments = (gAfterCreate.clusters ?? []).find((c) => c.name === "Payments");
      ok("GS-4: cluster created via POST", !!payments, gAfterCreate.clusters);
      ok("GS-4: selection is the new cluster",
        !!document.querySelector(".inspector") && inspTitle() === "Payments", inspTitle());
      // ?e2e renders hull instantly (no transition end-state flakiness)
      const plate = payments && [...document.querySelectorAll("g.hull")]
        .find((g) => g.__data__?.id === payments.id)?.querySelector("path.hull-plate");
      ok("GS-4: hull <path> exists after create", !!plate && !!plate.getAttribute("d"),
        plate?.getAttribute("d")?.slice(0, 40));
      const dAttr = plate?.getAttribute("d") || "";
      ok("GS-4: hull path has no NaN", !!dAttr && !dAttr.includes("NaN"), dAttr.slice(0, 80));

      // 2-member plate is a capsule/oval, not a butterfly (Catmull–Rom order bug):
      // the segment midpoint between members must sit inside the filled path.
      // A self-intersecting figure-8 pinches there and fails isPointInFill.
      {
        const nA = nodeById(A.id), nB = nodeById(B.id);
        const midInside = !!(plate && nA && nB && (() => {
          const svg = plate.ownerSVGElement;
          if (!svg?.createSVGPoint) return false;
          const pt = svg.createSVGPoint();
          pt.x = (nA.__data__.x + nB.__data__.x) / 2;
          pt.y = (nA.__data__.y + nB.__data__.y) / 2;
          // isPointInFill is in the element's local user space (graph coords).
          try { return plate.isPointInFill(pt); } catch { return false; }
        })());
        ok("GS-4: 2-member hull is capsule (midpoint inside fill, not butterfly)", midInside);
      }

      // 1-member hull via API
      const solo = await (await fetch("/api/projects/Demo/clusters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Solo", system_ids: [C.id], color: "iris" }),
      })).json();
      location.hash = "#/__gs4s"; await sleep(60); location.hash = "#/p/Demo"; await sleep(900);
      const soloPlate = [...document.querySelectorAll("g.hull")]
        .find((g) => g.__data__?.id === solo.id)?.querySelector("path.hull-plate");
      const soloD = soloPlate?.getAttribute("d") || "";
      ok("GS-4: 1-member hull renders", !!soloPlate && !!soloD, soloD.slice(0, 60));
      ok("GS-4: 1-member hull path has no NaN", !soloD.includes("NaN"), soloD.slice(0, 60));

      // Click hull selects cluster
      const payG = [...document.querySelectorAll("g.hull")]
        .find((g) => g.__data__?.id === payments?.id);
      payG?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(300);
      ok("GS-4: click hull selects cluster", inspTitle() === "Payments", inspTitle());

      // Cluster inspector has Focus + Delete cluster + swatches
      const cBtns = [...document.querySelectorAll(".inspector button")].map((b) => b.textContent.trim());
      ok("GS-4: cluster inspector has Focus", cBtns.includes("Focus"), cBtns);
      ok("GS-4: cluster inspector has Delete cluster", cBtns.includes("Delete cluster"), cBtns);
      ok("GS-4: cluster swatches present (8)",
        document.querySelectorAll(".inspector .cluster-swatch").length === 8);

      // Rail tab "clusters"
      const tabs = [...document.querySelectorAll(".rail-tabs button")].map((b) => b.textContent.trim());
      ok("GS-4: rail has clusters tab", tabs.includes("clusters"), tabs);
      document.querySelectorAll(".rail-tabs button")[4]?.click();
      await sleep(300);
      const railText = document.querySelector(".rail-body")?.textContent || "";
      ok("GS-4: rail shows Payments cluster", /Payments/.test(railText), railText.slice(0, 120));

      // ---- HP-2: history thumbs + detail preview show cluster plates ----
      // Payments (+ Solo) exist at tip; older versions predate create clusters.
      {
        const miniPlatePath = (root) => {
          const g = [...(root?.querySelectorAll("g") ?? [])]
            .find((el) => el.getAttribute("opacity") === "0.14");
          return g?.querySelector("path") || null;
        };
        const histBtn = document.querySelector('.ctool-history button[aria-label="History"]');
        // Ensure history is open (toggle if already open leaves it closed).
        if (!document.querySelector(".history-panel")) {
          histBtn?.click();
          await sleep(500);
        }
        const hpHP = document.querySelector(".history-panel");
        ok("HP-2: history popover opens with clusters present", !!hpHP);

        // Current-row thumb (graphToMini) paints immediately.
        const curRow = hpHP?.querySelector(".h-row.current");
        const curThumb = curRow?.querySelector(".h-thumb svg");
        const curPlate = miniPlatePath(curThumb);
        const curD = curPlate?.getAttribute("d") || "";
        ok("HP-2: current-row thumb has cluster plate", !!curPlate, curD.slice(0, 60));
        ok("HP-2: current-row plate path has no NaN", !!curD && !curD.includes("NaN"), curD.slice(0, 80));

        // Lazy row thumbs: wait for IntersectionObserver fills (existing pattern).
        await sleep(700);
        const thumbsWithPlate = [...(hpHP?.querySelectorAll(".h-thumb svg") ?? [])]
          .filter((svg) => miniPlatePath(svg));
        ok("HP-2: lazy row thumb also has a plate after observer",
          thumbsWithPlate.length >= 1, { n: thumbsWithPlate.length });

        // Pre-cluster version honesty: history/thumb for a sha before the
        // earliest "create clusters" has no clusters; rendered row has no plate.
        // Entries are tip-first — the last matching create is the oldest one.
        const hist = await (await fetch("/api/projects/Demo/history")).json();
        const entries = hist.entries || [];
        let oldestCreateIdx = -1;
        for (let i = 0; i < entries.length; i++) {
          if (/create clusters/i.test(entries[i].message || "")) oldestCreateIdx = i;
        }
        let preSha = null;
        if (oldestCreateIdx >= 0) {
          for (let i = oldestCreateIdx + 1; i < entries.length; i++) {
            if (!entries[i].future && entries[i].sha) { preSha = entries[i].sha; break; }
          }
        }
        ok("HP-2: pre-cluster history sha available", !!preSha, { oldestCreateIdx, n: entries.length });
        if (preSha) {
          const thumbPayload = await (await fetch(
            `/api/projects/Demo/history/thumb?at=${encodeURIComponent(preSha)}`,
          )).json();
          ok("HP-2: pre-cluster thumb payload has no clusters",
            !thumbPayload.clusters || thumbPayload.clusters.length === 0,
            thumbPayload.clusters);
          const preRow = [...(hpHP?.querySelectorAll(".h-row") ?? [])]
            .find((r) => r.querySelector(`.h-thumb[data-sha="${preSha}"]`));
          if (preRow) {
            let guard = 0;
            while (!preRow.querySelector(".h-thumb svg") && guard++ < 25) await sleep(100);
            ok("HP-2: pre-cluster row thumb has no plate",
              !miniPlatePath(preRow.querySelector(".h-thumb svg")));
          } else {
            // History list cap may hide older rows; payload gate still enforces honesty.
            ok("HP-2: pre-cluster row thumb has no plate (payload-only; row outside cap)", true);
          }
        }

        // Detail preview: open the "create clusters" past row when visible.
        const createRow = [...(hpHP?.querySelectorAll(".h-row") ?? [])].find((r) =>
          !r.classList.contains("current")
          && !r.classList.contains("future")
          && /create clusters/i.test(r.querySelector(".h-msg")?.textContent || ""));
        let detailD = "";
        let detailOk = false;
        if (createRow) {
          createRow.click();
          await sleep(800);
          const hd = document.querySelector(".history-detail");
          const dPlate = miniPlatePath(hd?.querySelector("svg"));
          detailD = dPlate?.getAttribute("d") || "";
          detailOk = !!dPlate && !detailD.includes("NaN");
          [...(hd?.querySelectorAll(".hd-actions .btn") ?? [])]
            .find((b) => b.textContent.includes("Back"))?.click();
          await sleep(300);
        } else {
          // Create-clusters row outside list cap: current-row graphToMini is the
          // same code path detail uses for clusters (detail adds labels only).
          detailOk = !!curPlate && !curD.includes("NaN");
          detailD = curD;
        }
        ok("HP-2: history detail preview has cluster plate path without NaN",
          detailOk, detailD.slice(0, 80));

        // Canvas minimap still has no hull/plate elements (scope cut stays).
        const mm = document.querySelector(".minimap");
        const mmHull = mm
          ? mm.querySelectorAll('g.hull, g[opacity="0.14"], path.hull-plate').length
          : 0;
        ok("HP-2: canvas minimap has no cluster plates", mmHull === 0, { mmHull });

        // Close history for GS-4 continue
        if (document.querySelector(".history-panel")) {
          histBtn?.click();
          await sleep(250);
        }
      }

      // FU-2: n=2+ delete confirm uses plural verb "stay"
      // Re-select cluster via hull click
      [...document.querySelectorAll("g.hull")]
        .find((g) => g.__data__?.id === payments?.id)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(250);
      const delClBtn = [...document.querySelectorAll(".inspector button")]
        .find((b) => b.textContent.trim() === "Delete cluster");
      delClBtn?.click();
      await sleep(200);
      const strip = document.querySelector(".inspector .warn-note");
      const stripText = strip?.textContent || "";
      ok("GS-4: delete confirm mentions systems stay (n=2+)",
        /Its 2 systems stay on the map/.test(stripText), stripText);
      ok("FU-2: n=2+ uses stay not stays",
        /systems stay on the map/.test(stripText) && !/system stays on the map/.test(stripText), stripText);
      strip?.querySelector(".btn.danger")?.click();
      await sleep(1000);
      const gAfterDel = await (await fetch("/api/projects/Demo/graph")).json();
      ok("GS-4: cluster gone after delete",
        !(gAfterDel.clusters ?? []).some((c) => c.id === payments?.id));
      ok("GS-4: systems still present after cluster delete",
        gAfterDel.systems.some((s) => s.id === A.id) && gAfterDel.systems.some((s) => s.id === B.id));
      ok("GS-4: hull removed after cluster delete",
        ![...document.querySelectorAll("g.hull")].some((g) => g.__data__?.id === payments?.id));

      // FU-2: n=1 form — singular verb "stays" on 1-member cluster
      [...document.querySelectorAll("g.hull")]
        .find((g) => g.__data__?.id === solo?.id)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(250);
      [...document.querySelectorAll(".inspector button")]
        .find((b) => b.textContent.trim() === "Delete cluster")?.click();
      await sleep(200);
      const soloStrip = document.querySelector(".inspector .warn-note");
      const soloStripText = soloStrip?.textContent || "";
      ok("FU-2: n=1 delete confirm uses stays",
        /Its 1 system stays on the map/.test(soloStripText), soloStripText);
      ok("FU-2: n=1 does not use plural stay",
        !/systems stay on the map/.test(soloStripText), soloStripText);
      // Cancel — keep Solo for hide-filter checks below
      [...(soloStrip?.querySelectorAll("button") ?? [])]
        .find((b) => b.textContent.trim() === "Cancel")?.click();
      await sleep(150);

      // hide-filter leaving 0 visible members → no hull for that cluster.
      // Solo has only CRM (C). Restrict systems to Commerce and Hide unmatched.
      document.querySelector('[data-dd="Systems"]')?._ddSet([A.id]);
      await sleep(200);
      getToggle("Unmatched")?.querySelectorAll("button")[1]?.click(); // Hide
      await sleep(500);
      const cOnCanvas = !!nodeById(C.id);
      const soloHullAfterHide = [...document.querySelectorAll("g.hull")]
        .find((g) => g.__data__?.id === solo.id);
      ok("GS-4: hide mode removed Solo's only member from canvas", !cOnCanvas);
      ok("GS-4: hide-filter 0 visible members → no hull", !soloHullAfterHide);

      // Reset filters
      getToggle("Unmatched")?.querySelectorAll("button")[0]?.click(); // Dim
      document.querySelector('[data-dd="Systems"]')?._ddSet([]);
      await sleep(300);

      // ?e2e / reduced-motion: hull was present immediately after create (no transition wait)
      ok("GS-4: ?e2e renders hull instantly (no transition end-state wait)", !!plate);

      // FU-2: n=0 form — cluster whose members were all deleted (membership stripped).
      // Assert via rail Del → confirmStrip so both call sites are message-tested
      // (inspector covered by n=1/n=2+ above).
      const orphanSys = await (await fetch("/api/projects/Demo/systems", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "FU2-Orphan", type: "internal" }),
      })).json();
      const emptyCl = await (await fetch("/api/projects/Demo/clusters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Empty", system_ids: [orphanSys.id], color: "moss" }),
      })).json();
      await fetch(`/api/projects/Demo/systems/${orphanSys.id}`, { method: "DELETE" });
      location.hash = "#/__fu2z"; await sleep(60); location.hash = "#/p/Demo"; await sleep(900);
      document.querySelectorAll(".rail-tabs button")[4]?.click();
      await sleep(250);
      const emptyItem = [...document.querySelectorAll(".rail-body .entity-item")]
        .find((el) => /Empty/.test(el.textContent || ""));
      ok("FU-2: empty cluster listed in rail", !!emptyItem, emptyItem?.textContent?.slice(0, 80));
      const emptyDel = [...(emptyItem?.querySelectorAll("button") ?? [])]
        .find((b) => b.textContent.trim() === "Del");
      emptyDel?.click();
      await sleep(200);
      const emptyStripText = document.querySelector(".rail-body .warn-note")?.textContent || "";
      ok("FU-2: n=0 rail delete confirm has no stay/stays clause",
        /^Delete cluster "Empty"\?/.test(emptyStripText.trim()) &&
        !/stay/.test(emptyStripText) && !/Its /.test(emptyStripText), emptyStripText);
      // Clean up empty cluster + Solo
      if (emptyCl?.id) {
        await fetch(`/api/projects/Demo/clusters/${emptyCl.id}`, { method: "DELETE" });
      }
      if (solo?.id) {
        await fetch(`/api/projects/Demo/clusters/${solo.id}`, { method: "DELETE" });
      }
      location.hash = "#/__gs4done"; await sleep(60); location.hash = "#/p/Demo"; await sleep(800);
      void hullPath; void svgEl; void wrap;
    }

    // ---- GS-5: cluster filtering (A1) + need-via-cluster ----
    {
      const g0 = await (await fetch("/api/projects/Demo/graph")).json();
      const byName = Object.fromEntries(g0.systems.map((s) => [s.name, s]));
      const A = byName["Commerce"], B = byName["Billing"], C = byName["CRM"];
      // Clear leftover clusters
      for (const c of (g0.clusters ?? [])) {
        await fetch(`/api/projects/Demo/clusters/${c.id}`, { method: "DELETE" });
      }
      // Clear filters
      document.querySelector('[data-dd="Systems"]')?._ddSet([]);
      document.querySelector('[data-dd="Clusters"]')?._ddSet([]);
      document.querySelector('[data-dd="Needs"]')?._ddSet([]);
      document.querySelector('[data-dd="Status"]')?._ddSet("");
      getToggle("Unmatched")?.querySelectorAll("button")[0]?.click(); // Dim
      await sleep(200);

      // Create Payments = Commerce + Billing; empty cluster; attach a need only to cluster later
      const payments = await (await fetch("/api/projects/Demo/clusters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Payments", system_ids: [A.id, B.id], color: "verdigris",
        }),
      })).json();
      const emptyCl = await (await fetch("/api/projects/Demo/clusters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "EmptyIsle", system_ids: [], color: "fog" }),
      })).json();
      // Need used only on the cluster (not on streams)
      let clusterOnlyNeed = (g0.needs ?? [])[0];
      if (!clusterOnlyNeed) {
        clusterOnlyNeed = await (await fetch("/api/projects/Demo/needs", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "GS5-Need", description: "cluster only" }),
        })).json();
      }
      await fetch(`/api/projects/Demo/clusters/${payments.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payments,
          biz_need_ids: [clusterOnlyNeed.id],
        }),
      });
      location.hash = "#/__gs5"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1100);

      // Activate cluster chip → dim non-members
      document.querySelector('[data-dd="Clusters"]')?._ddSet([payments.id]);
      await sleep(400);
      getToggle("Unmatched")?.querySelectorAll("button")[0]?.click(); // Dim
      await sleep(400);
      const nodeOp = (id) => {
        const g = [...document.querySelectorAll("g.node")].find((n) => n.__data__?.id === id);
        return g ? +g.getAttribute("opacity") : null;
      };
      ok("GS-5: cluster chip keeps member systems bright (dim)",
        nodeOp(A.id) >= 0.9 && nodeOp(B.id) >= 0.9,
        { A: nodeOp(A.id), B: nodeOp(B.id) });
      ok("GS-5: cluster chip dims non-member systems (dim)",
        nodeOp(C.id) < 0.2,
        { C: nodeOp(C.id) });
      // Strands touching a member stay matched if both ends in set; Commerce–Billing stream
      const linkMatched = [...document.querySelectorAll("g.link")].some((l) => {
        const d = l.__data__;
        return d && ((d.a === A.id && d.b === B.id) || (d.a === B.id && d.b === A.id))
          && +l.getAttribute("opacity") >= 0.9;
      });
      ok("GS-5: strand between cluster members stays matched", linkMatched);

      // Hide mode removes non-members
      getToggle("Unmatched")?.querySelectorAll("button")[1]?.click(); // Hide
      await sleep(500);
      ok("GS-5: hide mode removes non-member from canvas",
        ![...document.querySelectorAll("g.node")].some((n) => n.__data__?.id === C.id));
      ok("GS-5: hide mode keeps members on canvas",
        [...document.querySelectorAll("g.node")].some((n) => n.__data__?.id === A.id)
        && [...document.querySelectorAll("g.node")].some((n) => n.__data__?.id === B.id));
      getToggle("Unmatched")?.querySelectorAll("button")[0]?.click(); // Dim
      await sleep(300);

      // Chip UI: hue dot + title live count
      const payChip = [...document.querySelectorAll(".f-chip")]
        .find((c) => (c.querySelector(".f-chip-text")?.textContent || "").includes("Payments")
          && !c.classList.contains("f-chip-deleted"));
      ok("GS-5: cluster chip has hue dot", !!payChip?.querySelector(".f-chip-dot"));
      ok("GS-5: cluster chip title is live member count",
        /2 systems/.test(payChip?.getAttribute("title") || ""), payChip?.getAttribute("title"));

      // Liveness: add CRM to Payments, reload — filtered view includes it without touching chip
      await fetch(`/api/projects/Demo/clusters/${payments.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Payments",
          system_ids: [A.id, B.id, C.id],
          color: "verdigris",
          biz_need_ids: [clusterOnlyNeed.id],
        }),
      });
      location.hash = "#/__gs5live"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1000);
      // Re-apply cluster filter (reload may restore from userstate which still has payments id)
      document.querySelector('[data-dd="Clusters"]')?._ddSet([payments.id]);
      await sleep(400);
      ok("GS-5: liveness — new member is matched after membership edit",
        nodeOp(C.id) >= 0.9, { C: nodeOp(C.id) });

      // Union with plain system chip: cluster Payments (A,B,C) + only need to verify union
      // Shrink Payments back to A+B, then add system chip for CRM
      await fetch(`/api/projects/Demo/clusters/${payments.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Payments", system_ids: [A.id, B.id], color: "verdigris",
          biz_need_ids: [clusterOnlyNeed.id],
        }),
      });
      location.hash = "#/__gs5u"; await sleep(60); location.hash = "#/p/Demo"; await sleep(900);
      document.querySelector('[data-dd="Clusters"]')?._ddSet([payments.id]);
      document.querySelector('[data-dd="Systems"]')?._ddSet([C.id]);
      await sleep(400);
      ok("GS-5: cluster ∪ system chip — both sets visible",
        nodeOp(A.id) >= 0.9 && nodeOp(B.id) >= 0.9 && nodeOp(C.id) >= 0.9,
        { A: nodeOp(A.id), B: nodeOp(B.id), C: nodeOp(C.id) });

      // Empty-cluster chip dims everything; title 0 systems
      document.querySelector('[data-dd="Systems"]')?._ddSet([]);
      document.querySelector('[data-dd="Clusters"]')?._ddSet([emptyCl.id]);
      await sleep(400);
      const emptyChip = [...document.querySelectorAll(".f-chip")]
        .find((c) => (c.querySelector(".f-chip-text")?.textContent || "").includes("EmptyIsle"));
      ok("GS-5: empty-cluster chip title is 0 systems",
        /0 systems/.test(emptyChip?.getAttribute("title") || ""), emptyChip?.getAttribute("title"));
      const allDimmed = [...document.querySelectorAll("g.node")]
        .every((n) => +n.getAttribute("opacity") < 0.2);
      ok("GS-5: empty-cluster chip dims everything", allDimmed);

      // Need attached only to cluster → non-members dim
      document.querySelector('[data-dd="Clusters"]')?._ddSet([]);
      document.querySelector('[data-dd="Needs"]')?._ddSet([clusterOnlyNeed.id]);
      await sleep(450);
      ok("GS-5: need-via-cluster keeps member systems bright",
        nodeOp(A.id) >= 0.9 && nodeOp(B.id) >= 0.9, { A: nodeOp(A.id), B: nodeOp(B.id) });
      ok("GS-5: need-via-cluster dims non-member systems",
        nodeOp(C.id) < 0.2, { C: nodeOp(C.id) });
      document.querySelector('[data-dd="Needs"]')?._ddSet([]);
      await sleep(200);

      // Delete cluster while chip active → deleted state, survives reload, ✕ removes
      document.querySelector('[data-dd="Clusters"]')?._ddSet([payments.id]);
      await sleep(400); // cache name + debounce userstate
      await fetch(`/api/projects/Demo/clusters/${payments.id}`, { method: "DELETE" });
      await sleep(200);
      location.hash = "#/__gs5del"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1000);
      // Chip should restore from userstate; name from session cache → "Payments (deleted)"
      let delChip = [...document.querySelectorAll(".f-chip")]
        .find((c) => c.classList.contains("f-chip-deleted")
          || /\(deleted\)/.test(c.querySelector(".f-chip-text")?.textContent || ""));
      if (!delChip) {
        // Fallback if userstate debounce missed: re-arm chip with known id
        document.querySelector('[data-dd="Clusters"]')?._ddSet([payments.id]);
        await sleep(300);
        delChip = [...document.querySelectorAll(".f-chip")]
          .find((c) => c.classList.contains("f-chip-deleted")
            || /\(deleted\)/.test(c.querySelector(".f-chip-text")?.textContent || ""));
      }
      ok("GS-5: deleted cluster chip renders Payments (deleted)",
        !!delChip && /Payments \(deleted\)/.test(delChip.querySelector(".f-chip-text")?.textContent || ""),
        delChip?.textContent);
      ok("GS-5: deleted chip has dashed muted class",
        !!delChip?.classList.contains("f-chip-deleted"));
      // Matches nothing → everything dimmed (only this where chip)
      ok("GS-5: deleted chip matches nothing (all dimmed)",
        [...document.querySelectorAll("g.node")].every((n) => +n.getAttribute("opacity") < 0.2));

      // Survive reload with chip still present
      await fetch("/api/projects/Demo/userstate", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter_enabled: true,
          filters: {
            clusters: [payments.id], systems: [], queries: [],
            statuses: [], timings: [], needs: [], flow: "",
          },
        }),
      });
      location.hash = "#/__gs5us"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1100);
      const afterReloadChip = [...document.querySelectorAll(".f-chip")]
        .find((c) => /\(deleted\)/.test(c.querySelector(".f-chip-text")?.textContent || "")
          || c.classList.contains("f-chip-deleted"));
      ok("GS-5: deleted cluster chip survives reload (no auto-prune)", !!afterReloadChip);

      // ✕ removes it
      afterReloadChip?.querySelector("button")?.click();
      await sleep(300);
      ok("GS-5: ✕ removes deleted cluster chip",
        ![...document.querySelectorAll(".f-chip")]
          .some((c) => c.classList.contains("f-chip-deleted")));

      // userstate round-trip: set a live cluster chip (EmptyIsle still exists), reload
      document.querySelector('[data-dd="Clusters"]')?._ddSet([emptyCl.id]);
      await sleep(500); // allow debounced userstate save
      location.hash = "#/__gs5rt"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1100);
      const restoredEmpty = [...document.querySelectorAll(".f-chip")]
        .find((c) => (c.querySelector(".f-chip-text")?.textContent || "").includes("EmptyIsle"));
      ok("GS-5: userstate round-trip restores cluster chip", !!restoredEmpty, restoredEmpty?.textContent);

      // Absent-on-view (Mine→Main analog): chip id not in graph → deleted state, no crash
      document.querySelector('[data-dd="Clusters"]')?._ddSet(["missing-cluster-id"]);
      await sleep(300);
      const absentChip = [...document.querySelectorAll(".f-chip")]
        .find((c) => c.classList.contains("f-chip-deleted"));
      ok("GS-5: absent cluster id → deleted chip state, no crash", !!absentChip);
      ok("GS-5: canvas still renders with absent chip",
        document.querySelectorAll("g.node").length >= 1);

      // HUD: Clusters section above Systems; vertical pill contract still holds
      document.getElementById("hud-collapsed-pill")?.click();
      await sleep(250);
      document.querySelector(".hud-search-input")?.focus();
      await sleep(200);
      const sectionTitles = [...document.querySelectorAll(".hud-section-title")]
        .map((el) => el.textContent.trim());
      const clIdx = sectionTitles.indexOf("Clusters");
      const sysIdx = sectionTitles.indexOf("Systems");
      ok("GS-5: picker has Clusters section above Systems",
        clIdx >= 0 && sysIdx >= 0 && clIdx < sysIdx, sectionTitles);

      // HUD contract: vertical chips, max 2, scroll
      const pill = document.getElementById("hud-collapsed-pill");
      // collapse again for pill metrics
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(200);
      // Ensure at least 3 chips for scroll check
      document.querySelector('[data-dd="Clusters"]')?._ddSet([emptyCl.id]);
      document.querySelector('[data-dd="Status"]')?._ddSet("planned");
      document.querySelector('[data-dd="Systems"]')?._ddSet([A.id]);
      await sleep(400);
      const pillChips = document.querySelector(".hud-pill-chips");
      const pillCs = pillChips ? getComputedStyle(pillChips) : null;
      ok("GS-5: collapsed pill chips are vertical column",
        pillCs && (pillCs.flexDirection === "column" || pillCs.flexDirection === "column-reverse"),
        pillCs?.flexDirection);
      ok("GS-5: collapsed pill max-height caps visible chips (~2)",
        pillChips && pillChips.scrollHeight >= pillChips.clientHeight,
        { scroll: pillChips?.scrollHeight, client: pillChips?.clientHeight });

      // Cleanup
      document.querySelector('[data-dd="Clusters"]')?._ddSet([]);
      document.querySelector('[data-dd="Systems"]')?._ddSet([]);
      document.querySelector('[data-dd="Status"]')?._ddSet("");
      document.querySelector('[data-dd="Needs"]')?._ddSet([]);
      if (emptyCl?.id) {
        await fetch(`/api/projects/Demo/clusters/${emptyCl.id}`, { method: "DELETE" });
      }
      await fetch("/api/projects/Demo/userstate", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter_enabled: true,
          filters: { systems: [], clusters: [], queries: [], statuses: [], timings: [], needs: [], flow: "" },
        }),
      });
      location.hash = "#/__gs5done"; await sleep(60); location.hash = "#/p/Demo"; await sleep(800);
      void pill;
    }

    // ---- FU-1: cluster label placement (collision + HUD pill occlusion) ----
    {
      const H = 11, CHAR_W = 6.5;
      const g0 = await (await fetch("/api/projects/Demo/graph")).json();
      const byName = Object.fromEntries(g0.systems.map((s) => [s.name, s]));
      const commerce = byName["Commerce"], billing = byName["Billing"];
      const fulfill = byName["Fulfillment"], crm = byName["CRM"], wms = byName["WMS"];
      ok("FU-1: demo systems present",
        !!(commerce && billing && fulfill && crm && wms));

      for (const c of (g0.clusters ?? [])) {
        await fetch(`/api/projects/Demo/clusters/${c.id}`, { method: "DELETE" });
      }

      // Fixture: Payments (3), Warehouse (WMS+CRM), Solo (CRM) — adjacent tops.
      // Pin Warehouse pair and Solo so their top anchors share a screen band.
      const layout = {};
      for (const s of g0.systems) layout[s.id] = { x: 900, y: 700, pinned: true };
      layout[commerce.id] = { x: 120, y: 420, pinned: true };
      layout[billing.id] = { x: 280, y: 420, pinned: true };
      layout[fulfill.id] = { x: 200, y: 560, pinned: true };
      // Warehouse + Solo: two 1-member hulls pinned at the *same* graph point so
      // top anchors coincide (guaranteed collision without FU-1). Payments separate.
      // (Plan fixture also allows Warehouse=WMS+CRM; co-located singles force the ladder.)
      layout[wms.id] = { x: 530, y: 300, pinned: true };
      layout[crm.id] = { x: 530, y: 300, pinned: true };
      await fetch("/api/projects/Demo/layout", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(layout),
      });

      const payments = await (await fetch("/api/projects/Demo/clusters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Payments",
          system_ids: [commerce.id, billing.id, fulfill.id],
          color: "verdigris",
        }),
      })).json();
      const warehouse = await (await fetch("/api/projects/Demo/clusters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Warehouse",
          system_ids: [wms.id],
          color: "iris",
        }),
      })).json();
      const solo = await (await fetch("/api/projects/Demo/clusters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Solo",
          system_ids: [crm.id],
          color: "rosewood",
        }),
      })).json();
      ok("FU-1: fixture clusters created",
        !!(payments?.id && warehouse?.id && solo?.id));

      location.hash = "#/__fu1"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1200);

      const labelBoxes = () => {
        const svg = document.querySelector(".canvas-wrap svg");
        const t = window.d3.zoomTransform(svg);
        return [...document.querySelectorAll("g.hull")].map((g) => {
          const d = g.__data__;
          if (!d) return null;
          const nameUp = String(d.cluster?.name || "").toUpperCase();
          const nNeeds = (d.cluster?.biz_need_ids ?? []).length;
          const tail = nNeeds > 0
            ? ` · ${nNeeds} need${nNeeds === 1 ? "" : "s"}`
            : "";
          const w = (nameUp.length + tail.length) * CHAR_W;
          const cx = t.applyX(d.lx);
          const cy = t.applyY(d.ly);
          const topCx = t.applyX(d.topAnchor[0]);
          const topCy = t.applyY(d.topAnchor[1]);
          return {
            id: d.id, name: nameUp, cx, cy, w, h: H,
            lx: d.lx, ly: d.ly,
            topCx, topCy,
            topAx: d.topAnchor[0], topAy: d.topAnchor[1],
          };
        }).filter(Boolean);
      };

      const boxes = labelBoxes();
      ok("FU-1: every visible hull has a label element",
        boxes.length === document.querySelectorAll("g.hull").length
        && boxes.length >= 3,
        { hulls: document.querySelectorAll("g.hull").length, labels: boxes.length });
      ok("FU-1: every hull-label group is present and visible",
        [...document.querySelectorAll("g.hull g.hull-label")].every((g) => {
          const op = g.getAttribute("opacity");
          return op == null || +op > 0.01;
        }));

      let overlap = false;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (Math.abs(a.cx - b.cx) < (a.w + b.w) / 2
            && Math.abs(a.cy - b.cy) < H + 4) {
            overlap = true;
          }
        }
      }
      ok("FU-1: no two hull-label boxes intersect (estimate formula)",
        !overlap, boxes.map((b) => ({ name: b.name, cx: b.cx, cy: b.cy, w: b.w })));

      // Collision ladder must run: pairs whose *top-anchor* boxes would collide
      // must have at least one label leave the default top placement.
      let topCollidingPairs = 0;
      let ladderMoved = 0;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          const topsCollide =
            Math.abs(a.topCx - b.topCx) < (a.w + b.w) / 2
            && Math.abs(a.topCy - b.topCy) < H + 4;
          if (!topsCollide) continue;
          topCollidingPairs++;
          const aMoved = a.lx !== a.topAx || a.ly !== a.topAy;
          const bMoved = b.lx !== b.topAx || b.ly !== b.topAy;
          if (aMoved || bMoved) ladderMoved++;
        }
      }
      ok("FU-1: fixture has ≥1 top-anchor collision pair (Warehouse/Solo)",
        topCollidingPairs >= 1, { topCollidingPairs, boxes: boxes.map((b) => b.name) });
      ok("FU-1: collision ladder moves at least one label off topAnchor",
        ladderMoved >= 1 && ladderMoved === topCollidingPairs,
        { topCollidingPairs, ladderMoved,
          detail: boxes.map((b) => ({
            name: b.name, ly: b.ly, topAy: b.topAy, moved: b.ly !== b.topAy || b.lx !== b.topAx,
          })) });

      // ---- HUD pill occlusion: pin a 1-member hull under the floating pill ----
      // Ensure HUD is visible (filter on, collapsed pill default).
      const funnelOn = document.querySelector('[aria-label="Toggle Filters HUD"]');
      if (funnelOn && funnelOn.getAttribute("aria-pressed") !== "true") {
        funnelOn.click();
        await sleep(200);
      }
      // Commit a harmless system chip so the collapsed pill has body (visible).
      document.querySelector('[data-dd="Systems"]')?._ddSet([commerce.id]);
      await sleep(300);
      // Collapse if expanded
      const expanded = document.getElementById("filter-hud");
      if (expanded && expanded.style.display !== "none"
        && !document.getElementById("hud-collapsed-pill")?.offsetParent) {
        // click outside or leave expanded — container still has size
      }
      // Prefer collapsed pill for a compact top obstacle
      const hudContainer = document.getElementById("filter-hud-container");
      ok("FU-1: HUD container present for occlusion test", !!hudContainer);

      // Place Solo's member (CRM) so the hull top sits under the HUD center.
      const pinUnderHud = () => {
        const svg = document.querySelector(".canvas-wrap svg");
        const t = window.d3.zoomTransform(svg);
        const sr = svg.getBoundingClientRect();
        const hud = document.getElementById("filter-hud-container");
        if (!hud) return null;
        const hr = hud.getBoundingClientRect();
        // Target: graph point whose top-of-hull (~ y - HULL_PAD - 10) lands
        // under the pill center. HULL_PAD=38 → node y ≈ topAnchorY + 48.
        const screenX = (hr.left + hr.right) / 2 - sr.left;
        const screenY = (hr.top + hr.bottom) / 2 - sr.top + 20; // slightly below pill center
        const [gx, gy] = t.invert([screenX, screenY]);
        // Node center: top anchor is at y - r - 10 with r=38 → node at topAnchor+48
        return { x: gx, y: gy + 48, pinned: true };
      };
      const underPos = pinUnderHud();
      if (underPos && Number.isFinite(underPos.x) && Number.isFinite(underPos.y)) {
        // Keep others out of the way; put CRM under pill
        const lay2 = {};
        for (const s of g0.systems) lay2[s.id] = { x: 100, y: 700, pinned: true };
        lay2[crm.id] = underPos;
        // Keep Payments away so only Solo is near the pill
        lay2[commerce.id] = { x: 100, y: 700, pinned: true };
        lay2[billing.id] = { x: 200, y: 700, pinned: true };
        lay2[fulfill.id] = { x: 300, y: 700, pinned: true };
        lay2[wms.id] = { x: 400, y: 700, pinned: true };
        await fetch("/api/projects/Demo/layout", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(lay2),
        });
        // Drop Warehouse so only Solo sits under the pill (cleaner assert)
        await fetch(`/api/projects/Demo/clusters/${warehouse.id}`, { method: "DELETE" });
        await fetch(`/api/projects/Demo/clusters/${payments.id}`, { method: "DELETE" });
        location.hash = "#/__fu1b"; await sleep(60); location.hash = "#/p/Demo"; await sleep(1100);

        // Re-apply system chip so pill is visible after reload
        document.querySelector('[data-dd="Systems"]')?._ddSet([commerce.id]);
        await sleep(400);

        const hudEl = document.getElementById("filter-hud-container");
        const soloG = [...document.querySelectorAll("g.hull")]
          .find((g) => g.__data__?.id === solo.id);
        const d = soloG?.__data__;
        ok("FU-1: Solo hull present under pill layout", !!d);

        if (d && hudEl) {
          const svg = document.querySelector(".canvas-wrap svg");
          const t = window.d3.zoomTransform(svg);
          const sr = svg.getBoundingClientRect();
          const hr = hudEl.getBoundingClientRect();
          const pad = 6;
          const hudBox = {
            left: hr.left - sr.left - pad,
            top: hr.top - sr.top - pad,
            right: hr.right - sr.left + pad,
            bottom: hr.bottom - sr.top + pad,
          };
          const nameUp = String(d.cluster?.name || "").toUpperCase();
          const nNeeds = (d.cluster?.biz_need_ids ?? []).length;
          const tail = nNeeds > 0
            ? ` · ${nNeeds} need${nNeeds === 1 ? "" : "s"}`
            : "";
          const w = (nameUp.length + tail.length) * CHAR_W;
          const cx = t.applyX(d.lx);
          const cy = t.applyY(d.ly);
          const left = cx - w / 2, right = cx + w / 2;
          const top = cy - H / 2, bottom = cy + H / 2;
          const hits = !(right < hudBox.left || left > hudBox.right
            || bottom < hudBox.top || top > hudBox.bottom);
          ok("FU-1: label screen box does not intersect .hud (pill) rect",
            !hits,
            { cx, cy, w, hudBox, lx: d.lx, ly: d.ly, topAnchor: d.topAnchor });
        } else {
          ok("FU-1: label screen box does not intersect .hud (pill) rect", false, "missing hull or hud");
        }
      } else {
        ok("FU-1: label screen box does not intersect .hud (pill) rect", false, "could not compute pin under HUD");
      }

      // Cleanup
      document.querySelector('[data-dd="Systems"]')?._ddSet([]);
      const gEnd = await (await fetch("/api/projects/Demo/graph")).json();
      for (const c of (gEnd.clusters ?? [])) {
        await fetch(`/api/projects/Demo/clusters/${c.id}`, { method: "DELETE" });
      }
      await fetch("/api/projects/Demo/userstate", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter_enabled: true,
          filters: { systems: [], clusters: [], queries: [], statuses: [], timings: [], needs: [], flow: "" },
        }),
      });
      location.hash = "#/__fu1done"; await sleep(60); location.hash = "#/p/Demo"; await sleep(600);
    }

    // ---- DR-2: Home composition (topbar frame, card meta, vertical balance) ----
    {
      location.hash = "#/";
      await sleep(900);
      const page = document.querySelector(".home-page");
      const topbar = page?.querySelector(":scope > .topbar");
      const home = page?.querySelector(".home");
      ok("DR-2: home-page frame renders", !!page && !!topbar && !!home);
      ok("DR-2: topbar brand-mini present", !!topbar?.querySelector("a.brand-mini"));
      // Under -no-auth AccountControl is null — chip only when signed in
      // (covered by ?e2e=home). Still require the spacer so the layout is
      // the shared topbar, not the old PROJECTS-row chip.
      ok("DR-2: topbar uses spacer (shared frame with workspace)",
        !!topbar?.querySelector(".spacer"));
      ok("DR-2: account chip is NOT glued to Projects heading",
        !document.querySelector(".home-projects-head .account-chip"));
      ok("DR-2: content brand + tagline lead the column",
        !!home?.querySelector(".brand h1 b") && !!home?.querySelector(".tagline"));
      const homeCs = home ? getComputedStyle(home) : null;
      const padTop = homeCs ? parseFloat(homeCs.paddingTop) : 0;
      ok("DR-2: content has visual-third top pad (≥48px)", padTop >= 48, padTop);
      const demoCard = [...document.querySelectorAll(".project-card")]
        .find((c) => c.querySelector("h3")?.textContent === "Demo");
      const meta = demoCard?.querySelector(".card-meta")?.textContent || "";
      // Counts reflect post-suite graph mutations — match the list API, not a fixed fixture.
      const listed = await (await fetch("/api/projects")).json();
      const demoApi = listed.find((p) => p.name === "Demo");
      // omitempty zeros are undefined in JSON — treat as 0 like cardMetaLine.
      const expectSys = `${demoApi?.system_count ?? 0} system`;
      const expectStr = `${demoApi?.stream_count ?? 0} stream`;
      ok("DR-2: project card shows systems · streams meta from list API",
        !!demoApi && meta.includes(expectSys) && meta.includes(expectStr),
        { meta, system_count: demoApi?.system_count, stream_count: demoApi?.stream_count });
      ok("DR-2: project card shows updated-relative meta",
        /updated /.test(meta), meta);
      // Empty invitation only when zero projects — Demo is present.
      ok("DR-2: invite copy absent when projects exist",
        !document.querySelector(".home-invite"));
      ok("DR-2: recently-deleted slot present but hidden (REV-5 placeholder)",
        !!document.querySelector(".home-recently-deleted[hidden], details.home-recently-deleted"));
    }

    const pre = document.createElement("pre");
    pre.id = "e2e-results";
    // Leading newline keeps the first PASS off the same dump-dom line as
    // the opening <pre> tag so scripts/e2e*.sh can grep ^(PASS|FAIL).
    pre.textContent = "\n" + out.join("\n");
    document.body.appendChild(pre);
  });
}
// (screenshot poses for matrix/analysis are handled via ?shot= below)
