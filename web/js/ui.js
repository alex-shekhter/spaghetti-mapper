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
