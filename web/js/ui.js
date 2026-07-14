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

export function Dropdown({ state, value = "", options, onchange, editable = false, title = "", cls = "", placeholder = "—" }) {
  const cur = state ?? van.state(value);
  const opts = typeof options === "function" ? options : () => options;
  const open = van.state(false);
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
    window.removeEventListener("resize", close);
  };
  const onOutside = (e) => { if (!root.contains(e.target) && !panel.contains(e.target)) close(); };
  const onScroll = (e) => { if (!panel.contains(e.target)) close(); };

  // fixed positioning so the panel never gets clipped by scrolling ancestors
  const position = () => {
    const r = root.getBoundingClientRect();
    panel.style.minWidth = Math.max(r.width, 120) + "px";
    panel.style.left = Math.max(4, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8)) + "px";
    const below = window.innerHeight - r.bottom;
    const fitsBelow = below > panel.offsetHeight + 10 || r.top < panel.offsetHeight + 10;
    panel.style.top = (fitsBelow ? r.bottom + 3 : r.top - panel.offsetHeight - 3) + "px";
  };
  const toggle = () => {
    if (open.val) { close(); return; }
    open.val = true;
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    requestAnimationFrame(position);
  };

  const pick = (v) => {
    cur.val = v;
    if (editable && inputEl) inputEl.value = v;
    onchange?.(v);
    close();
  };

  const onKeys = (e) => {
    if (e.key === "Escape" && open.val) { e.stopPropagation(); close(); btn.focus(); }
    if ((e.key === "ArrowDown" || e.key === "Enter") && !open.val && !editable) { e.preventDefault(); toggle(); }
  };

  panel = div(
    { class: "dd-panel", style: () => (open.val ? "" : "display:none"), onkeydown: onKeys },
    () => {
      open.val; // re-read options each open (they may derive from app state)
      return div(opts().map(([v, label]) =>
        button({
          type: "button",
          class: () => "dd-opt" + (cur.val === v ? " selected" : ""),
          onclick: () => pick(v),
        }, span({ class: "dd-check" }, () => (cur.val === v ? "✓" : "")), label)));
    },
  );

  if (editable) {
    inputEl = input({
      type: "text", class: "dd-input", value: cur.val, placeholder,
      oninput: (e) => { cur.val = e.target.value; onchange?.(e.target.value); },
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
  root._ddSet = pick;
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
    window.removeEventListener("resize", close);
  };
  const onOutside = (e) => { if (!root.contains(e.target) && !panel.contains(e.target)) close(); };
  const onScroll = (e) => { if (!panel.contains(e.target)) close(); };

  const position = () => {
    const r = root.getBoundingClientRect();
    panel.style.minWidth = Math.max(r.width, 180) + "px";
    panel.style.left = Math.max(4, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8)) + "px";
    const below = window.innerHeight - r.bottom;
    const fitsBelow = below > panel.offsetHeight + 10 || r.top < panel.offsetHeight + 10;
    panel.style.top = (fitsBelow ? r.bottom + 3 : r.top - panel.offsetHeight - 3) + "px";
  };
  const toggle = () => {
    if (open.val) { close(); return; }
    open.val = true;
    q.val = "";
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    requestAnimationFrame(() => { position(); searchEl?.focus(); });
  };

  const toggleVal = (v) => {
    const s = new Set(state.val);
    s.has(v) ? s.delete(v) : s.add(v);
    state.val = s;
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
    if (e.key === "Escape" && open.val) { e.stopPropagation(); close(); btn.focus(); }
    if ((e.key === "ArrowDown" || e.key === "Enter") && !open.val) { e.preventDefault(); toggle(); }
  };

  const filteredOpts = () => {
    const all = opts();
    const needle = q.val.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(([, label]) => String(label).toLowerCase().includes(needle));
  };

  panel = div(
    { class: "dd-panel dd-multi-panel", style: () => (open.val ? "" : "display:none"), onkeydown: onKeys },
    searchable
      ? input({ type: "search", class: "dd-search", placeholder: `Filter ${title.toLowerCase()}…`,
          oninput: (e) => (q.val = e.target.value) })
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
          ? list.map(([v, label]) =>
              button({
                type: "button",
                class: () => "dd-opt dd-multi-opt" + (state.val.has(v) ? " selected" : ""),
                onclick: () => toggleVal(v),
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
