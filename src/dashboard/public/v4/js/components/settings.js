// ── settings.js — "Ajustes" page: account identity, sign-in methods,
// sessions, preferences, installation. Mounted by main.js's router
// (#/ajustes); the old slideover + "keys live in .env" block are gone —
// broker credentials are managed in the Cuentas page (platform registry).
import { api } from "../api.js";
import { store, t } from "../store.js";
import { esc, icon } from "../ui.js";

// ── pure helpers (unit-tested in settings.test.js) ───────────────────────

/** Crude-but-honest device label from a User-Agent (full UA in the title). */
export function deviceLabel(ua) {
  const s = String(ua || "");
  if (!s) return t("Unknown device", "Dispositivo desconocido");
  const browser = /Firefox\//.test(s) ? "Firefox"
    : /Edg\//.test(s) ? "Edge"
    : /OPR\//.test(s) ? "Opera"
    : /Chrome\//.test(s) ? "Chrome"
    : /Safari\//.test(s) ? "Safari" : t("Browser", "Navegador");
  const os = /Windows/.test(s) ? "Windows"
    : /Android/.test(s) ? "Android"
    : /iPhone|iPad|iOS/.test(s) ? "iOS"
    : /Mac OS X|Macintosh/.test(s) ? "macOS"
    : /Linux/.test(s) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

export function fmtTs(ts) {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleString() : "—";
}

export function loginMethodsHtml(m) {
  const row = (label, on) =>
    `<div class="set-row"><span>${esc(label)}</span><span class="${on ? "up" : "muted"}">${on ? "✓ " + t("enabled", "activado") : "—"}</span></div>`;
  return row(t("Password", "Contraseña"), !!m?.password) + row("GitHub", !!m?.github) + row("Google", !!m?.google);
}

export function sessionRowHtml(s) {
  return `<div class="set-row" data-sess="${esc(s.handle)}">
    <span>
      <b>${esc(deviceLabel(s.device))}</b>${s.current ? ` <span class="chip">${t("this session", "esta sesión")}</span>` : ""}
      <span class="muted" style="display:block;font-size:var(--t-xs)" title="${esc(s.device || "")}">${esc(s.ip || "")} · ${t("since", "desde")} ${esc(fmtTs(s.createdAt))} · ${t("active", "activa")} ${esc(fmtTs(s.lastActivity))}</span>
    </span>
    <button class="acc-btn danger" data-sess-revoke="${esc(s.handle)}">${s.current ? t("Log out", "Salir") : t("Revoke", "Revocar")}</button>
  </div>`;
}

// ── page ─────────────────────────────────────────────────────────────────

const section = (title, bodyHtml) =>
  `<div class="page-section"><span class="card-note">${esc(title)}</span>${bodyHtml}</div>`;

function copyBtn(value, label) {
  return `<button class="acc-btn" data-copy="${esc(value)}" aria-label="${esc(label)}" title="${esc(label)}">${icon("copy", 12)} ${t("Copy", "Copiar")}</button>`;
}

function preferencesHtml(s) {
  const seg = (name, opts, cur) => `<span class="seg" data-set="${name}">` + opts.map(([v, l]) => `<button class="${String(v) === String(cur) ? "on" : ""}" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join("") + `</span>`;
  return `
    <div class="set-row"><span>${t("Theme", "Tema")}</span>${seg("theme", [["dark", "Dark"], ["terminal", "Terminal"], ["light", "Light"]], s.theme)}</div>
    <div class="set-row"><span>${t("Language", "Idioma")}</span>${seg("lang", [["en", "English"], ["es", "Español"]], s.lang)}</div>
    <div class="set-row"><span>${t("Default window", "Ventana por defecto")}</span>${seg("period", [[1, t("Today", "Hoy")], [7, "7D"], [30, "30D"], [0, t("All", "Todo")]], s.period)}</div>`;
}

function accountHtml(me, pm) {
  const row = (label, valueHtml) => `<div class="set-row"><span>${esc(label)}</span><span class="set-v">${valueHtml}</span></div>`;
  let html = row(t("Name", "Nombre"), esc(me?.displayName || "—"))
    + row(t("Username", "Usuario"), `<code>${esc(me?.username || "—")}</code>`)
    + row(t("Role", "Rol"), esc(me?.role === "admin" ? t("Admin (owner)", "Admin (dueño)") : me?.role || "—"));
  if (pm?.accountId) html += row(t("Account ID", "ID de cuenta"), `<code>${esc(pm.accountId)}</code> ${copyBtn(pm.accountId, t("Copy account ID", "Copiar ID de cuenta"))}`);
  if (pm?.instanceId) html += row(t("Installation ID", "ID de instalación"), `<code style="font-size:var(--t-xs)">${esc(pm.instanceId)}</code> ${copyBtn(pm.instanceId, t("Copy installation ID", "Copiar ID de instalación"))}`);
  return html;
}

function installationHtml(pm) {
  const row = (label, v) => `<div class="set-row"><span>${esc(label)}</span><span class="set-v">${v}</span></div>`;
  return row("Commit", pm?.commit ? `<code>${esc(pm.commit)}</code>` : "—")
    + row(t("Accounts mode", "Modo de cuentas"), `<code>${esc(pm?.accountsSource || "env")}</code>`)
    + row(t("Portfolios source", "Fuente de portafolios"), `<code>${esc(pm?.portfoliosSource || "code")}</code>`)
    + row(t("Public URL", "URL pública"), pm?.publicUrl ? `<code>${esc(pm.publicUrl)}</code>` : `<span class="muted">${t("not set", "sin configurar")}</span>`);
}

let host = null;
let onChangeCb = null;

async function loadSessions() {
  const box = host?.querySelector("#setSessions");
  if (!box) return;
  const data = await api.platformSessions();
  if (!host?.isConnected) return;
  const list = data?.sessions;
  if (!list) { box.innerHTML = `<div class="muted">${t("Session list unavailable on this server.", "Lista de sesiones no disponible en este servidor.")}</div>`; return; }
  box.innerHTML = list.map(sessionRowHtml).join("")
    + (list.length > 1 ? `<button class="acc-btn" data-sess-others style="margin-top:var(--s2)">${t("Log out other sessions", "Cerrar las demás sesiones")}</button>` : "");
}

/** Mounts the Ajustes page into `host` (a fresh #pageBody element).
 *  `onChange(key)` fires on preference changes (main.js re-renders). */
export async function mountSettings(hostEl, onChange) {
  host = hostEl;
  onChangeCb = onChange;
  const s = store.state;
  const me = s.me;
  const pm = s.platformMe;
  const docsNote = `<div class="muted page-note">${t(
    "Sign-in methods are configured on the server — see", "Los métodos de acceso se configuran en el servidor — ver",
  )} <code>docs/platform/self-hosting.md</code></div>`;
  const accountsLink = `<div class="muted page-note">${t("Broker API keys are managed in", "Las claves API de broker se gestionan en")} <a class="lnk" href="#/cuentas">${t("Accounts", "Cuentas")}</a>.</div>`;
  host.innerHTML =
    section(t("Account", "Cuenta"), accountHtml(me, pm))
    + section(t("Sign-in", "Inicio de sesión"), loginMethodsHtml(pm?.loginMethods ?? { password: true }) + docsNote)
    + section(t("Sessions", "Sesiones"), `<div id="setSessions"><div class="muted">…</div></div>`)
    + section(t("Preferences", "Preferencias"), preferencesHtml(s))
    + section(t("Installation", "Instalación"), installationHtml(pm) + accountsLink);
  host.addEventListener("click", onClick);
  loadSessions().catch(() => {});
}

async function onClick(e) {
  const seg = e.target.closest(".seg[data-set] button");
  if (seg) {
    const key = seg.closest(".seg").dataset.set;
    const v = key === "period" ? +seg.dataset.v : seg.dataset.v;
    store.set({ [key]: v });
    seg.closest(".seg").querySelectorAll("button").forEach((x) => { x.classList.toggle("on", x === seg); x.setAttribute("aria-pressed", String(x === seg)); });
    onChangeCb?.(key);
    return;
  }
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); copy.classList.add("on"); setTimeout(() => copy.classList.remove("on"), 800); } catch {}
    return;
  }
  const revoke = e.target.closest("[data-sess-revoke]");
  if (revoke) {
    const row = host.querySelector(`[data-sess="${CSS.escape(revoke.dataset.sessRevoke)}"]`);
    const isCurrent = !!row?.querySelector(".chip");
    if (!confirm(isCurrent
      ? t("Log out this session?", "¿Cerrar esta sesión?")
      : t("Revoke this session? The device will have to sign in again.", "¿Revocar esta sesión? Ese dispositivo tendrá que iniciar sesión de nuevo."))) return;
    try {
      await api.revokeSession(revoke.dataset.sessRevoke);
      if (isCurrent) { location.href = "/login"; return; }
    } catch {}
    loadSessions().catch(() => {});
    return;
  }
  if (e.target.closest("[data-sess-others]")) {
    if (!confirm(t("Log out every other session?", "¿Cerrar todas las demás sesiones?"))) return;
    try { await api.revokeOtherSessions(); } catch {}
    loadSessions().catch(() => {});
  }
}
