// Setup + login gate for SpaghettiMapper. Shown until the user is authenticated.
//
// First run with no users → setup screen (creates the admin). Otherwise →
// login. On success the onAuthed callback re-renders the app. This is the
// human-identity entry point; AI agents authenticate out-of-band with an
// API token via the Authorization header.
//
// DR-1 + LP-3: product identity (two-tone wordmark, static mapped-state tangle
// watermark with CORE COMMERCE plate) as the landing's second page — hero on
// the left, form in a solid side panel on the right. No motion on the gate.

import { api } from "./api.js";

const van = window.van;
const { a, button, div, form, h1, input, p, span, label } = van.tags;

// Squiggle + node endpoints matching the Home logoSVG / tab favicon.
const brandMark = () => {
  const d = document.createElement("div");
  d.innerHTML = `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M4 22 C10 8, 16 30, 22 12 S 30 20, 28 8" fill="none" stroke="#e6a23c" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="4" cy="22" r="2.6" fill="#3987e5"/>
    <circle cx="28" cy="8" r="2.6" fill="#d95926"/>
  </svg>`;
  return d.firstChild;
};

// Static mapped-state tangle (landing hero at t=1) + LP-2/RF-2 CORE COMMERCE plate.
// Opacity is CSS-only; no animation, no rAF — auth screens must stay still while typing.
// Hull path must stay in sync with landing.html #cluster-hull.
const watermark = () => {
  const d = document.createElement("div");
  d.className = "auth-watermark";
  d.setAttribute("aria-hidden", "true");
  d.innerHTML = `<svg viewBox="0 0 1200 640" preserveAspectRatio="xMidYMid slice">
    <g>
      <path d="M888.2,144.6C847.9,101.5,642.9,124.8,625.3,154.4C603.6,190.8,839.8,410.9,878.5,383.2C907.6,362.4,925.5,184.5,888.2,144.6Z"
        fill="#3fae94" fill-opacity=".07" stroke="#3fae94" stroke-opacity=".45" stroke-width="1.5"/>
      <text x="888.2" y="134.6" text-anchor="middle"
        font-family="ui-monospace, SF Mono, Menlo, monospace"
        font-size="9.5" letter-spacing="1.5" fill="#3fae94" fill-opacity=".9">CORE COMMERCE</text>
    </g>
    <g fill="none" stroke-linecap="round">
      <path d="M660 170 C751 170, 769 170, 860 170" stroke="#e6a23c" stroke-width="2" stroke-opacity=".85"/>
      <path d="M860 170 C950 170, 970 170, 1060 170" stroke="#e6a23c" stroke-width="2" stroke-opacity=".85"/>
      <path d="M1060 170 C1060 251, 1060 269, 1060 350" stroke="#e6a23c" stroke-width="2" stroke-opacity=".85"/>
      <path d="M660 170 C751 170, 769 350, 860 350" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".55"/>
      <path d="M660 350 C751 350, 769 170, 860 170" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".55"/>
      <path d="M860 170 C950 170, 970 350, 1060 350" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".55"/>
      <path d="M860 350 C950 350, 970 530, 1060 530" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".55"/>
      <path d="M660 530 C751 530, 769 170, 860 170" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".55"/>
      <path d="M660 530 C751 530, 769 350, 860 350" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".55"/>
      <path d="M860 170 C860 251, 860 449, 860 530" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".55"/>
      <path d="M860 350 C860 431, 860 449, 860 530" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".55"/>
      <path d="M1060 170 C1060 251, 1060 449, 1060 530" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".55"/>
      <path d="M660 170 C751 170, 769 350, 860 350" stroke="#4a5a70" stroke-width="1.5" stroke-opacity=".4"/>
    </g>
    <g>
      <circle cx="660" cy="170" r="7" fill="#161d28" stroke="#3987e5" stroke-width="2"/>
      <circle cx="660" cy="350" r="7" fill="#161d28" stroke="#3987e5" stroke-width="2"/>
      <circle cx="660" cy="530" r="7" fill="#161d28" stroke="#898781" stroke-width="2" stroke-dasharray="3 3"/>
      <circle cx="860" cy="170" r="7" fill="#161d28" stroke="#3987e5" stroke-width="2"/>
      <circle cx="860" cy="350" r="7" fill="#161d28" stroke="#3987e5" stroke-width="2"/>
      <circle cx="860" cy="530" r="7" fill="#161d28" stroke="#3987e5" stroke-width="2"/>
      <circle cx="1060" cy="170" r="7" fill="#161d28" stroke="#d95926" stroke-width="2"/>
      <circle cx="1060" cy="350" r="7" fill="#161d28" stroke="#d95926" stroke-width="2"/>
      <circle cx="1060" cy="530" r="7" fill="#161d28" stroke="#d95926" stroke-width="2"/>
    </g>
  </svg>`;
  return d;
};

function brand() {
  return div(
    { class: "auth-brand" },
    brandMark(),
    h1("Spaghetti", van.tags.b("Mapper")),
  );
}

function welcomeLink() {
  return a(
    { class: "auth-welcome", href: "/welcome" },
    "What is SpaghettiMapper? →",
  );
}

// LP-3: landing headline + vocab line on the hero half.
function heroCopy() {
  return div(
    { class: "auth-hero-copy" },
    h1(
      { class: "auth-hero-headline" },
      span("You inherited spaghetti."),
      span({ class: "map-line" }, "Leave behind a map."),
    ),
    p({ class: "auth-hero-vocab" }, "systems · streams · flows · needs · clusters"),
  );
}

// LP-3 split page: .auth-page (+ .auth-wrap for e2e selectors) = hero | panel.
function authPage(panelInner) {
  return div(
    { class: "auth-page auth-wrap" },
    div({ class: "auth-hero" }, watermark(), heroCopy()),
    div({ class: "auth-panel" }, panelInner),
  );
}

function card(subtitle, children, onSubmit, submitLabel) {
  const err = van.state("");
  const submitting = van.state(false);
  // Autofocus username after the gate mounts (LP-3).
  queueMicrotask(() => {
    const el = document.querySelector('.auth-card input[name="username"]');
    el?.focus();
  });
  return authPage(
    div(
      { class: "auth-card" },
      brand(),
      subtitle ? p({ class: "auth-sub" }, subtitle) : null,
      form(
        {
          onsubmit: async (e) => {
            e.preventDefault();
            err.val = "";
            submitting.val = true;
            try {
              await onSubmit(new FormData(e.currentTarget));
            } catch (ex) {
              err.val = ex.message || "Something went wrong";
            } finally {
              submitting.val = false;
            }
          },
        },
        children,
        () => (err.val ? div({ class: "auth-err" }, err.val) : null),
        button({ type: "submit", class: "primary", disabled: () => submitting.val },
          () => (submitting.val ? "…" : submitLabel)),
      ),
      welcomeLink(),
    ),
  );
}

function fieldRow(labelText, nameAttr, type, placeholder, opts = {}) {
  const attrs = {
    type,
    name: nameAttr,
    placeholder,
    required: opts.required ?? true,
    autocomplete: opts.autocomplete,
    value: opts.value ?? "",
  };
  if (opts.minlength != null) attrs.minlength = opts.minlength;
  if (opts.autofocus) attrs.autofocus = true;
  return label({ class: "field" },
    span(labelText),
    input(attrs),
    opts.hint ? span({ class: "field-hint" }, opts.hint) : null,
  );
}

// AuthGate renders setup or login based on server status.
export function AuthGate({ onAuthed }) {
  const status = van.state(null); // null = loading
  api.auth.status().then((s) => (status.val = s)).catch(() => (status.val = { error: true }));

  return () => {
    const s = status.val;
    if (!s) {
      return authPage(div({ class: "auth-card" }, "Loading…"));
    }
    if (s.error) {
      return authPage(div({ class: "auth-card" }, "Cannot reach the server."));
    }
    if (s.needs_setup) {
      return card(
        "Create your account to get started. This becomes your architect identity and is stored only on this machine.",
        [
          fieldRow("Username", "username", "text", "alex", { autocomplete: "username", autofocus: true }),
          fieldRow("Display name (optional)", "name", "text", "How your edits are signed", { required: false }),
          fieldRow("Password", "password", "password", "••••••••", {
            autocomplete: "new-password",
            minlength: 8,
            hint: "At least 8 characters",
          }),
        ],
        async (fd) => {
          await api.auth.setup(fd.get("username"), fd.get("password"), fd.get("name"));
          onAuthed();
        },
        "Create account",
      );
    }
    return card(
      "Sign in to continue.",
      [
        fieldRow("Username", "username", "text", "alex", { autocomplete: "username", autofocus: true }),
        fieldRow("Password", "password", "password", "••••••••", { autocomplete: "current-password" }),
      ],
      async (fd) => {
        await api.auth.login(fd.get("username"), fd.get("password"));
        onAuthed();
      },
      "Sign in",
    );
  };
}
