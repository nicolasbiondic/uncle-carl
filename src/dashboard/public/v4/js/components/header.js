import { icon, esc } from "../ui.js";
import { store, t } from "../store.js";
import { etTime } from "../fmt.js";

const ET = "America/New_York";
const etDay = () => new Date().toLocaleDateString("en-US", { timeZone: ET, weekday: "short", day: "2-digit", month: "short" });
const clockText = () => `${etDay()} ${etTime(Date.now())}`;

/** Brand + clock. The two portfolios (balance, status, click for details)
 *  live in the KPI strip since 2026-10-25 (profiles.js), so the header no
 *  longer repeats them as pills. */
export function renderHeader() {
  return `
    <div class="brand">${icon("trend", 20)} Uncle Carl
      <span class="clock" id="clock">${esc(clockText())}</span></div>
  `;
}

/** Right-side actions — split out of renderHeader so the nav can sit between
 *  the brand and these buttons on ONE top row (#topbar).
 *  Every button carries a VISIBLE label on desktop (.icn-l, collapsed to the
 *  icon on narrow screens by app.css) plus an aria-label always. */
export function actionButton(act, iconName, label, extraCls = "") {
  return `<button class="icn lbl${extraCls ? " " + extraCls : ""}" data-act="${act}" aria-label="${esc(label)}" title="${esc(label)}">${icon(iconName)}<span class="icn-l">${esc(label)}</span></button>`;
}

const THEME_NAME = { dark: "Dark", terminal: "Terminal", light: "Light" };

/** Roving focus inside the user menu: which item index a key moves to
 *  (null = the key is not a menu-navigation key). Arrows wrap. */
export function nextMenuIndex(key, current, count) {
  if (!(count > 0)) return null;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp") return current < 0 ? count - 1 : (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** User chip (owner identity) + menu. The chip shows only the display name;
 *  the menu (click / Enter to open, outside click or Escape to close — main.js)
 *  holds Language, Theme (same data-act handlers the header buttons had),
 *  Settings, Log out, and two muted lines: the short account id (once GET
 *  /api/platform/me resolves) and the dashboard version. `open` keeps the menu
 *  open across the header re-render that a language/theme switch triggers. */
export function renderUserChip(open = false) {
  const me = store.state.me;
  const pm = store.state.platformMe;
  const name = me?.displayName || me?.username || t("Account", "Cuenta");
  const shortId = pm?.accountId ? pm.accountId.replace(/^acct_/, "").slice(0, 6) : "";
  const lang = store.state.lang === "es" ? "Español" : "English";
  const theme = THEME_NAME[store.state.theme] || THEME_NAME.dark;
  return `<div class="uchip-wrap">
    <button class="icn lbl uchip" data-act="user-menu" aria-haspopup="menu" aria-expanded="${open}" aria-controls="umenu" aria-label="${esc(name)}">
      ${icon("user")}<span class="icn-l">${esc(name)}</span>
    </button>
    <div class="umenu" id="umenu"${open ? "" : " hidden"} role="menu" aria-label="${esc(name)}">
      <button role="menuitem" class="umenu-item" data-act="lang">${icon("globe")} ${t("Language", "Idioma")}<span class="umenu-v">${lang}</span></button>
      <button role="menuitem" class="umenu-item" data-act="theme">${icon("moon")} ${t("Theme", "Tema")}<span class="umenu-v">${theme}</span></button>
      <a role="menuitem" class="umenu-item" href="#/ajustes" data-act="user-menu-close">${icon("settings")} ${t("Settings", "Ajustes")}</a>
      <button role="menuitem" class="umenu-item danger" data-act="logout">${icon("logout")} ${t("Log out", "Salir")}</button>
      <div class="umenu-meta" role="none">${shortId ? `<span>${t("Account", "Cuenta")} <span class="mono">#${esc(shortId)}</span></span>` : ""}<span>Uncle Carl <span class="mono">v4</span></span></div>
    </div>
  </div>`;
}

export function renderActions(open = false) {
  return renderUserChip(open);
}

/** Persistent portfolio-manager navigation. Labels ALWAYS visible (the owner
 *  asked for named sections, not icon-guessing); aria-current marks the page. */
// Broker accounts are a section of Ajustes since 2026-10-11 (owner: "Settings
// y Accounts podrían estar juntos") — #/cuentas is an alias (router.js).
export const NAV_PAGES = () => [
  ["resumen", "home", t("Overview", "Resumen")],
  ["portafolios", "briefcase", t("Portfolios", "Portafolios")],
  ["actividad", "list", t("Activity", "Actividad")],
  ["ajustes", "settings", t("Settings", "Ajustes")],
];

export function renderNav() {
  const cur = store.state.page;
  return NAV_PAGES().map(([id, ic, label]) =>
    `<a class="nav-link${cur === id ? " on" : ""}" href="#/${id}"${cur === id ? ' aria-current="page"' : ""}>${icon(ic)}<span>${esc(label)}</span></a>`
  ).join("");
}

export function tickClock() {
  const el = document.getElementById("clock");
  if (el) el.textContent = clockText();
}
