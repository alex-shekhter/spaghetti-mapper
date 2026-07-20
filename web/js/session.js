// Shared session state so any view (topbars, panels) can show the signed-in
// architect and sign out, without reaching into app.js. app.js owns the
// full auth/status blob for gate routing; this holds just the user object.

import { api } from "./api.js";

const van = window.van;
const { button, div, span } = van.tags;

export const sessionUser = van.state(null); // {id,name,is_admin} | null
// authEnabled mirrors /api/auth/status#auth_enabled. False under -no-auth;
// the Architects panel uses it to skip its SSE subscription (there are no
// architects to watch, and a live EventSource would keep headless test runs
// from settling).
export const authEnabled = van.state(false);

export function setSessionUser(u) { sessionUser.val = u || null; }
export function setAuthEnabled(v) { authEnabled.val = !!v; }

// requestSignOut clears the cookie and notifies app.js to re-evaluate the
// gate. Routed through a window event so app.js doesn't have to be imported
// here (which would create a cycle: app.js imports views.js, views.js imports
// this, and we don't want this importing app.js).
export async function requestSignOut() {
  await api.auth.logout().catch(() => {});
  sessionUser.val = null;
  location.hash = "";
  window.dispatchEvent(new Event("auth-changed"));
}

// AccountControl renders a compact identity pill with a sign-out button.
// Returns null when nobody is signed in (e.g. -no-auth, or pre-gate).
export function AccountControl() {
  return () => {
    const u = sessionUser.val;
    if (!u) return null;
    return div({ class: "account-chip" },
      span({ class: "account-chip-name", title: `Signed in as ${u.id}` }, u.name || u.id),
      button({ class: "ghost", onclick: requestSignOut, title: "Sign out" }, "Sign out"),
    );
  };
}