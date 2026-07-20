// Custom themed dropdown — native <select> popups can't be styled and look
// foreign next to the app's theme.
//
// Usage:
//   Dropdown({ state, options, title })                    — bound to a van.state
//   Dropdown({ value, options, onchange })                 — plain initial value + callback
//   Dropdown({ editable: true, value, options, onchange }) — free text with suggestions
//
// options: [[value, label], …] or a thunk returning that (re-read on open).
// The root element exposes `_ddSet(value)` as a hook for the e2e harness.

const van = window.van;
const { button, div, input, span } = van.tags;

// Count + word with a real plural (DR-6). Prefer this over "field(s)".
//   plural(1, "field") → "1 field"
//   plural(4, "field") → "4 fields"
//   plural(1, "entity", "entities") → "1 entity"
export function plural(n, word, pluralWord) {
  const p = pluralWord ?? `${word}s`;
  return `${n} ${n === 1 ? word : p}`;
}

// Place a `position: fixed` dropdown panel adjacent to its anchor (`root`)
// without ever being clipped by the viewport. The panel flips above/below
// depending on which side has room, and its height is clamped to the
// available space so the option list scrolls instead of overflowing the
// window. (The old single-rAF placement measured the panel before its
// options had rendered — VanJS flushes DOM updates on a setTimeout(0) that
// runs after rAF — so it saw a ~0-height panel, opened it "below" a
// near-the-bottom anchor, and got clipped, leaving only the first option
// visible.)
//
// Call AFTER the panel's contents have been laid out; `afterPaint` below
// defers past VanJS's setTimeout(0) update flush so the height is real.
export function placePanel(panel, root, maxHeight = 240) {
  const r = root.getBoundingClientRect();
  panel.style.minWidth = Math.max(r.width, 120) + "px";
  // keep the panel under the anchor horizontally but clamp into the viewport
  const maxLeft = window.innerWidth - panel.offsetWidth - 8;
  panel.style.left = Math.max(4, Math.min(r.left, Math.max(4, maxLeft))) + "px";

  const margin = 3;
  // Let the panel be as tall as it wants for a moment so scrollHeight
  // reflects the full option list, not a previously-clamped box.
  panel.style.maxHeight = maxHeight + "px";
  const natural = Math.max(0, Math.min(maxHeight, panel.scrollHeight));

  const spaceBelow = window.innerHeight - r.bottom - margin;
  const spaceAbove = r.top - margin;

  let placeBelow, h;
  if (spaceBelow >= natural || spaceBelow >= spaceAbove) {
    placeBelow = true;
    h = Math.min(natural, Math.max(0, spaceBelow));
  } else {
    placeBelow = false;
    h = Math.min(natural, Math.max(0, spaceAbove));
  }
  // Tiny viewport fallback: use whichever side has more room, even if the
  // panel has to scroll. Keeps at least 60px visible.
  if (h < 60) {
    if (spaceBelow >= spaceAbove) { placeBelow = true; h = Math.max(60, Math.min(maxHeight, spaceBelow)); }
    else { placeBelow = false; h = Math.max(60, Math.min(maxHeight, spaceAbove)); }
  }
  panel.style.maxHeight = h + "px";

  // Use the REAL rendered height (content + padding + border) for the offset
  // math so the panel never spills past the viewport and never overlaps the
  // anchor when flipped above it.
  const offsetH = panel.offsetHeight || h;
  let top = placeBelow ? r.bottom + margin : r.top - offsetH - margin;
  top = Math.max(2, Math.min(top, window.innerHeight - offsetH - 2));
  panel.style.top = top + "px";
}

// Defer a callback past the next paint AND past VanJS's setTimeout(0) DOM
// flush (VanJS batches updates on a 0ms timeout, which runs after the rAF
// of the current turn). Double-rAF lands on the following turn, after the
// options have actually been inserted, so panel.scrollHeight is meaningful.
export const afterPaint = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

export function Dropdown({ state, value = "", options, onchange, editable = false, title = "", cls = "", placeholder = "—" }) {
  const cur = state ?? van.state(value);
  const opts = typeof options === "function" ? options : () => options;
  const open = van.state(false);
  let hl = -1; // keyboard highlight index into opts() — managed imperatively
  const labelFor = (v) => {
    const hit = opts().find((o) => o[0] === v);
    return hit ? hit[1] : (v === "" ? placeholder : v);
  };

  let root, panel, btn, inputEl;

  const close = () => {
    if (!open.val) return;
    open.val = false;
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", reposition);
  };
  const onOutside = (e) => { if (!root.contains(e.target) && !panel.contains(e.target)) close(); };
  const onScroll = (e) => { if (!panel.contains(e.target)) close(); };

  const reposition = () => { if (open.val) placePanel(panel, root); };

  // Imperatively set the highlighted option. Toggling a class on the existing
  // buttons (instead of re-rendering the list through a state) keeps the
  // panel's scroll position stable across arrow-key presses and lets us
  // scroll the highlighted row into view synchronously.
  const setHl = (i) => {
    hl = i;
    const rows = panel.querySelectorAll(".dd-opt");
    rows.forEach((el, idx) => el.classList.toggle("hl", idx === i));
    if (i >= 0 && rows[i]) rows[i].scrollIntoView({ block: "nearest" });
  };

  const toggle = () => {
    if (open.val) { close(); return; }
    open.val = true;
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", reposition);
    afterPaint(() => {
      if (!open.val) return;
      placePanel(panel, root);
      const list = opts();
      const i = list.findIndex((o) => o[0] === cur.val);
      setHl(i >= 0 ? i : (list.length ? 0 : -1));
    });
  };

  const pick = (v) => {
    cur.val = v;
    if (editable && inputEl) inputEl.value = v;
    onchange?.(v);
    close();
  };

  const focusAnchor = () => (editable ? inputEl : btn).focus();

  const onKeys = (e) => {
    const list = opts();
    if (!open.val) {
      // open with ArrowDown (always), or Enter/Space (non-editable only —
      // editable inputs let Enter submit their form)
      if (e.key === "ArrowDown") { e.preventDefault(); toggle(); }
      else if ((e.key === "Enter" || e.key === " ") && !editable) { e.preventDefault(); toggle(); }
      return;
    }
    switch (e.key) {
      case "Escape": e.stopPropagation(); e.preventDefault(); close(); focusAnchor(); break;
      case "ArrowDown":
        e.preventDefault();
        if (list.length) setHl((hl + 1) % list.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (list.length) setHl((hl - 1 + list.length) % list.length);
        break;
      case "Home":
        e.preventDefault();
        if (list.length) setHl(0);
        break;
      case "End":
        e.preventDefault();
        if (list.length) setHl(list.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        if (editable) { close(); focusAnchor(); } // confirm the typed text as-is
        else if (hl >= 0 && hl < list.length) pick(list[hl][0]);
        else if (list.length) pick(list[0][0]);
        if (!editable) focusAnchor();
        break;
      case " ":
        if (!editable) { e.preventDefault(); if (hl >= 0 && hl < list.length) pick(list[hl][0]); focusAnchor(); }
        break;
      case "Tab":
        close(); // let focus move on naturally
        break;
    }
  };

  panel = div(
    { class: "dd-panel", style: () => (open.val ? "" : "display:none"), onkeydown: onKeys },
    () => {
      open.val; cur.val; // reactivity: rebuild list on open / select
      const list = opts();
      return div(list.map(([v, label], i) =>
        button({
          type: "button",
          class: "dd-opt" + (cur.val === v ? " selected" : ""),
          onclick: () => pick(v),
          onmouseenter: () => setHl(i),
        }, span({ class: "dd-check" }, () => (cur.val === v ? "✓" : "")), label)));
    },
  );

  if (editable) {
    inputEl = input({
      type: "text", class: "dd-input", value: cur.val, placeholder,
      oninput: (e) => { cur.val = e.target.value; onchange?.(e.target.value); },
      onkeydown: onKeys,
    });
  }
  btn = button(
    {
      type: "button", class: "dd-btn" + (editable ? " dd-caret-only" : ""), title,
      "aria-haspopup": "listbox", "aria-expanded": () => String(open.val),
      onclick: toggle, onkeydown: onKeys,
    },
    editable
      ? span({ class: "dd-caret" }, "▾")
      : [span({ class: "dd-label" }, () => labelFor(cur.val)), span({ class: "dd-caret" }, "▾")],
  );

  root = div({ class: "dd" + (editable ? " editable" : "") + (cls ? " " + cls : ""), "data-dd": title }, inputEl, btn, panel);
  root._ddSet = (v) => { pick(v); };
  return root;
}

// MultiDropdown — a multi-select variant of Dropdown, bound to a
// van.state(Set). Renders a checkbox list with Clear/All/Invert footer.
// Empty set = "no constraint" (the chip reads "Title:all"); a non-empty set
// turns the chip amber so the active filter is obvious.
//
// `options`: [[value, label], …] or a thunk re-read on each open.
// `searchable`: shows a row filter box for long lists (e.g. 30 systems).
//
// `_ddSet(v)` is backward compatible with the single-select Dropdown:
//   _ddSet("")            → clear (empty Set)
//   _ddSet("planned")     → {"planned"}
//   _ddSet(new Set([...])) → that Set verbatim
// so the e2e harness and any single-value callers keep working.
export function MultiDropdown({ state, options, title = "", searchable = false, cls = "" }) {
  if (!state) state = van.state(new Set());
  const opts = typeof options === "function" ? options : () => options;
  const open = van.state(false);
  const q = van.state("");
  let hl = -1; // keyboard highlight into the filtered list — managed imperatively

  const labelFor = () => {
    const n = state.val.size;
    return n ? `${title}:${n}` : `${title}:all`;
  };

  let root, panel, btn, searchEl;

  const close = () => {
    if (!open.val) return;
    open.val = false;
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", reposition);
  };
  const onOutside = (e) => { if (!root.contains(e.target) && !panel.contains(e.target)) close(); };
  const onScroll = (e) => { if (!panel.contains(e.target)) close(); };

  const reposition = () => { if (open.val) placePanel(panel, root); };

  const filteredOpts = () => {
    const all = opts();
    const needle = q.val.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(([, label]) => String(label).toLowerCase().includes(needle));
  };

  const setHl = (i) => {
    hl = i;
    const rows = panel.querySelectorAll(".dd-multi-opt");
    rows.forEach((el, idx) => el.classList.toggle("hl", idx === i));
    if (i >= 0 && rows[i]) rows[i].scrollIntoView({ block: "nearest" });
  };

  const position = () => {
    placePanel(panel, root);
    const list = filteredOpts();
    setHl(hl >= 0 && hl < list.length ? hl : (list.length ? 0 : -1));
  };
  const toggle = () => {
    if (open.val) { close(); return; }
    open.val = true;
    q.val = "";
    hl = -1;
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", reposition);
    afterPaint(() => { if (open.val) { position(); searchEl?.focus(); } });
  };

  const toggleVal = (v) => {
    const s = new Set(state.val);
    s.has(v) ? s.delete(v) : s.add(v);
    state.val = s;
    // state change re-renders the list (VanJS, async) — re-apply highlight
    // once the new rows exist.
    afterPaint(() => { if (open.val) setHl(hl); });
  };
  const setAll = () => (state.val = new Set(opts().map((o) => o[0])));
  const clear = () => (state.val = new Set());
  const invert = () => (state.val = new Set(opts().filter((o) => !state.val.has(o[0])).map((o) => o[0])));

  const _ddSet = (v) => {
    if (v instanceof Set) state.val = new Set(v);
    else if (v === "" || v == null) state.val = new Set();
    else state.val = new Set([v]);
  };

  const onKeys = (e) => {
    const list = filteredOpts();
    if (!open.val) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      return;
    }
    switch (e.key) {
      case "Escape": e.stopPropagation(); e.preventDefault(); close(); btn.focus(); break;
      case "ArrowDown":
        e.preventDefault();
        if (list.length) setHl(hl < 0 ? 0 : (hl + 1) % list.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (list.length) setHl(hl < 0 ? list.length - 1 : (hl - 1 + list.length) % list.length);
        break;
      case "Home":
        e.preventDefault();
        if (list.length) setHl(0);
        break;
      case "End":
        e.preventDefault();
        if (list.length) setHl(list.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        if (hl >= 0 && hl < list.length) toggleVal(list[hl][0]);
        break;
      case "Tab":
        close(); break;
    }
  };

  panel = div(
    { class: "dd-panel dd-multi-panel", style: () => (open.val ? "" : "display:none"), onkeydown: onKeys },
    searchable
      ? input({
          type: "search", class: "dd-search", placeholder: `Filter ${title.toLowerCase()}…`,
          oninput: (e) => { q.val = e.target.value; hl = -1; afterPaint(() => { if (open.val) setHl(-1); }); },
          onkeydown: onKeys,
        })
      : null,
    // The list is rebuilt from a binding. IMPORTANT: wrap the mapped buttons
    // in a div — returning a bare array from a binding makes VanJS stringify
    // it to "[object HTMLButtonElement],…". (The single-select Dropdown wraps
    // opts().map(...) in div(...) for the same reason.)
    () => {
      open.val; q.val; // reactivity triggers
      const list = filteredOpts();
      return div({ class: "dd-multi-list" },
        list.length
          ? list.map(([v, label], i) =>
              button({
                type: "button",
                class: "dd-opt dd-multi-opt" + (state.val.has(v) ? " selected" : ""),
                onclick: () => toggleVal(v),
                onmouseenter: () => setHl(i),
              },
                span({ class: "dd-box" }, () => (state.val.has(v) ? "✓" : "")),
                span({ class: "dd-multi-label" }, label)))
          : div({ class: "cl-empty", style: "padding:6px 9px" }, "No matches"));
    },
    div({ class: "dd-foot" },
      button({ type: "button", class: "btn ghost small", onclick: clear }, "Clear"),
      button({ type: "button", class: "btn ghost small", onclick: setAll }, "All"),
      button({ type: "button", class: "btn ghost small", onclick: invert }, "Invert"),
    ),
  );

  btn = button(
    {
      type: "button",
      class: () => "dd-btn" + (state.val.size ? " active" : ""),
      title, "aria-haspopup": "listbox", "aria-expanded": () => String(open.val),
      onclick: toggle, onkeydown: onKeys,
    },
    span({ class: "dd-label" }, labelFor),
    span({ class: "dd-caret" }, "▾"),
  );

  root = div({ class: "dd dd-multi" + (cls ? " " + cls : ""), "data-dd": title }, btn, panel);
  root._ddSet = _ddSet;
  return root;
}