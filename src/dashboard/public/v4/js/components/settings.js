// ── settings.js — slideover: theme, language, window, API-key status (masked).
import { api } from "../api.js";
import { store, t } from "../store.js";
import { esc, icon } from "../ui.js";
import { trapFocus } from "../focus-trap.js";

let root = null;
let escHandler = null;
let release = null;

export async function openSettings(onChange) {
  close();
  const el = root = document.createElement("div");
  root.className = "so-backdrop";
  const s = store.state;
  const seg = (name, opts, cur) => `<span class="seg" data-set="${name}">` + opts.map(([v, l]) => `<button class="${String(v) === String(cur) ? "on" : ""}" data-v="${v}">${l}</button>`).join("") + `</span>`;
  root.innerHTML = `<aside class="so" role="dialog" aria-modal="true" aria-label="${t("Settings", "Ajustes")}">
    <div class="so-head"><b>${t("Settings", "Ajustes")}</b><button class="icn" data-sclose aria-label="${t("Close", "Cerrar")}">${icon("x")}</button></div>
    <div class="so-body">
      <label>${t("Theme", "Tema")}</label>
      ${seg("theme", [["dark", "Dark"], ["terminal", "Terminal"], ["light", "Light"]], s.theme)}
      <label>${t("Language", "Idioma")}</label>
      ${seg("lang", [["en", "English"], ["es", "Español"]], s.lang)}
      <label>${t("Default window", "Ventana por defecto")}</label>
      ${seg("period", [[1, t("Today", "Hoy")], [7, "7D"], [30, "30D"], [0, t("All", "Todo")]], s.period)}
      <label>${t("API keys", "Claves API")}</label>
      <div id="soKeys" class="muted" style="font-size:var(--t-xs)">…</div>
      <div class="muted" style="font-size:var(--t-xs);margin-top:var(--s2)">${t("Keys are managed via environment variables (.env), not the dashboard.", "Las claves se gestionan por variables de entorno (.env), no desde el panel.")}</div>
    </div></aside>`;
  document.body.appendChild(root);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-sclose]")) return close();
    const b = e.target.closest(".seg[data-set] button");
    if (b) {
      const key = b.closest(".seg").dataset.set;
      const v = key === "period" ? +b.dataset.v : b.dataset.v;
      store.set({ [key]: v });
      b.closest(".seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      onChange?.(key);
    }
  });
  escHandler = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", escHandler);
  release = trapFocus(root);
  try {
    const k = await api.configKeys();
    if (root !== el || !el.isConnected) return;
    const box = el.querySelector("#soKeys"); // "el", not module-level "root" — safe even if the panel closed while awaiting
    if (box) box.innerHTML = !k ? t("Admin only", "Solo admin") :
      `Alpaca: <code>${esc(k.alpaca?.keyId || "—")}</code> ${k.alpaca?.paper ? "(paper)" : ""}<br>` +
      `Binance: <code>${esc(k.binance?.keyId || "—")}</code> ${k.binance?.testnet ? "(testnet)" : ""} ${k.binance?.connected ? "· ✓" : ""}<br>` +
      `Telegram: ${k.telegram?.configured ? "✓ " + t("configured", "configurado") : "—"}`;
  } catch {
    if (root !== el || !el.isConnected) return;
    const box = el.querySelector("#soKeys");
    if (box) box.innerHTML = t("Could not load", "No se pudo cargar");
  }
}

export function close() {
  if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
  release?.(); release = null;
  if (root) { root.remove(); root = null; }
}
