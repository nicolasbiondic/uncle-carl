// ── palette.js — ⌘K / Ctrl+K / "/" command palette. Actions are provided by
// main.js (views, tabs, period, theme, lang, versions, logout).
import { esc } from "../ui.js";
import { t } from "../store.js";
import { trapFocus } from "../focus-trap.js";

let root = null, input = null, list = null, acts = [], filtered = [], sel = 0, release = null;

function build() {
  root = document.createElement("div");
  root.className = "pal-backdrop";
  root.innerHTML = `<div class="pal" role="dialog" aria-modal="true" aria-label="Command palette">
    <input class="pal-in" placeholder="${t("Type a command…", "Escribe un comando…")}" aria-label="Command">
    <div class="pal-list" role="listbox"></div></div>`;
  document.body.appendChild(root);
  input = root.querySelector(".pal-in");
  list = root.querySelector(".pal-list");
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  input.addEventListener("input", () => { filter(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); run(filtered[sel]); }
  });
  list.addEventListener("click", (e) => {
    const it = e.target.closest("[data-pi]");
    if (it) run(filtered[+it.dataset.pi]);
  });
  release = trapFocus(root);
}

function filter() {
  const q = input.value.trim().toLowerCase();
  filtered = !q ? acts : acts.filter((a) => a.label.toLowerCase().includes(q));
  sel = 0; paint();
}

function paint() {
  list.innerHTML = filtered.slice(0, 12).map((a, i) =>
    `<div class="pal-item ${i === sel ? "on" : ""}" data-pi="${i}" role="option" aria-selected="${i === sel}">${esc(a.label)}<span class="pal-tag">${esc(a.tag || "")}</span></div>`
  ).join("") || `<div class="pal-item muted">${t("No matches", "Sin resultados")}</div>`;
}

function run(a) { if (!a) return; close(); try { a.run(); } catch (e) { console.error(e); } }
function close() { release?.(); release = null; if (root) { root.remove(); root = null; } }

export function openPalette(actions) {
  if (root) return close();
  acts = actions; build(); filter(); input.focus();
}

export function bindPalette(getActions) {
  document.addEventListener("keydown", (e) => {
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
    if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !inField && !root)) {
      e.preventDefault(); openPalette(getActions());
    } else if (e.key === "Escape" && root) close();
  });
}
