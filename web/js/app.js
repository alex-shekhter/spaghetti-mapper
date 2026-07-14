import { Home, Workspace } from "./views.js";

const van = window.van;

const go = (path) => (location.hash = `#${path}`);

function render() {
  const el = document.getElementById("app");
  el.innerHTML = "";
  const m = location.hash.match(/^#\/p\/(.+)$/);
  van.add(el, m ? Workspace(decodeURIComponent(m[1]), { go }) : Home({ go }));
}

window.addEventListener("hashchange", render);
render();
