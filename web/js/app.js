import { AuthGate } from "./auth.js";
import { Home, Workspace } from "./views.js";
import { api, setOnUnauth } from "./api.js";
import { setSessionUser, setAuthEnabled } from "./session.js";

const van = window.van;
const { div } = van.tags;

const go = (path) => (location.hash = `#${path}`);

// session holds the raw /api/auth/status blob (auth_enabled, needs_setup,
// user) used to decide which gate to render. The reactive user for the
// topbars lives in session.js (setSessionUser).
const session = van.state(null);

async function loadSession() {
  try {
    const s = await api.auth.status();
    session.val = s;
    setSessionUser(s.user);
    setAuthEnabled(s.auth_enabled);
  } catch {
    session.val = { error: true };
    setSessionUser(null);
    setAuthEnabled(false);
  }
}

function render() {
  const el = document.getElementById("app");
  el.innerHTML = "";
  const s = session.val;
  if (!s) return; // loading; loadSession will re-render.
  if (s.error) {
    van.add(el, div({ style: "padding:24px;color:#e0623c" }, "Cannot reach the server."));
    return;
  }
  // Auth disabled server-side (-no-auth): serve the app directly, no gate.
  if (s.auth_enabled === false) {
    const m = location.hash.match(/^#\/p\/(.+)$/);
    van.add(el, m ? Workspace(decodeURIComponent(m[1]), { go }) : Home({ go }));
    return;
  }
  // No user yet → setup or login gate.
  if (s.needs_setup || !s.user) {
    van.add(el, AuthGate({ onAuthed: async () => { await loadSession(); render(); } }));
    return;
  }
  // Authed → the app. The identity control lives in the topbars via session.js.
  const m = location.hash.match(/^#\/p\/(.+)$/);
  van.add(el, m ? Workspace(decodeURIComponent(m[1]), { go }) : Home({ go }));
}

// Any 401 from the API flips back to the gate.
setOnUnauth(async () => { await loadSession(); render(); });
// Sign-out from a topbar bumps the session; re-render to show the gate.
window.addEventListener("auth-changed", () => { loadSession().then(render); });

window.addEventListener("hashchange", render);
loadSession().then(render);