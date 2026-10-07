// ── accounts.js — "Broker accounts" slideover + add-account modal (2026-10-04)
//
// Platform registry UI: list registered broker accounts (provider, env,
// status, last verification, account number — NEVER a secret), connect
// Alpaca via OAuth when the installation has a Connect app, or register
// API keys (Alpaca / Binance USDⓈ-M) through a guided form. The backend
// (/api/platform/accounts) verifies with read-only calls before saving.
// Pure render/format helpers are exported for accounts.test.js.

import { api } from "../api.js";
import { t } from "../store.js";
import { esc, icon } from "../ui.js";

// ── pure helpers (unit-tested) ───────────────────────────────────────────

export function providerLabel(p) {
  return p === "alpaca" ? "Alpaca" : p === "binance_usdm" ? "Binance USDⓈ-M" : String(p || "?");
}

export function envLabel(env) {
  if (env === "paper") return "Paper";
  if (env === "live") return t("Live", "Real");
  if (env === "demo") return "Demo";
  return String(env || "?");
}

export function statusInfo(status) {
  if (status === "verified") return { cls: "ok", label: t("Verified", "Verificada") };
  if (status === "error") return { cls: "err", label: "Error" };
  if (status === "revoked") return { cls: "warn", label: t("Revoked", "Revocada") };
  return { cls: "warn", label: t("Unverified", "Sin verificar") };
}

export function authTypeLabel(a) {
  return a === "oauth" ? "OAuth" : a === "api_key" ? t("API keys", "Claves API") : String(a || "?");
}

/** Providers with MORE than one verified account and no runtime link on any
 *  of them: the next boot cannot pick one by itself (runtime.ts refuses to
 *  guess). Returns provider labels to warn about. */
export function multiVerifiedUnlinked(accounts) {
  const byProvider = new Map();
  for (const a of accounts || []) {
    if (a.status !== "verified") continue;
    const e = byProvider.get(a.provider) || { count: 0, linked: false };
    e.count++;
    if (a.runtimeLinked) e.linked = true;
    byProvider.set(a.provider, e);
  }
  return [...byProvider.entries()].filter(([, e]) => e.count > 1 && !e.linked).map(([p]) => providerLabel(p));
}

export function multiVerifiedWarningHtml(accounts) {
  const providers = multiVerifiedUnlinked(accounts);
  if (!providers.length) return "";
  return `<div class="acc-setup" role="alert" style="margin-bottom:var(--s3)">⚠ ${t(
    `More than one verified ${providers.join(", ")} account and no explicit link — the next start would not know which one to use. Set RUNTIME_ACCOUNT_* (or instance.json runtimeAccounts) to the account id.`,
    `Hay más de una cuenta verificada de ${providers.join(", ")} sin vínculo explícito — el próximo arranque no sabría cuál usar. Fija RUNTIME_ACCOUNT_* (o runtimeAccounts en instance.json) con el id de la cuenta.`,
  )}</div>`;
}

export function fmtWhen(ts) {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleString() : "—";
}

/** Parses the OAuth round-trip result the backend encodes on the SPA URL
 *  (accounts_oauth=ok&id=… | accounts_oauth=error&reason=…). Null if the
 *  URL carries no OAuth result at all. */
export function oauthResultFromSearch(search) {
  const p = new URLSearchParams(search || "");
  const r = p.get("accounts_oauth");
  if (r === "ok") return { ok: true, id: p.get("id") || "" };
  if (r === "error") return { ok: false, reason: p.get("reason") || "unknown" };
  return null;
}

const OAUTH_REASONS = {
  denied: ["Authorization was cancelled at Alpaca", "La autorización se canceló en Alpaca"],
  bad_state: ["Invalid or expired OAuth state — try again", "Estado OAuth inválido o caducado — inténtalo de nuevo"],
  missing_params: ["Alpaca returned an incomplete callback", "Alpaca devolvió un callback incompleto"],
  exchange_failed: ["Could not exchange the code for a token", "No se pudo canjear el código por un token"],
  verification_failed: ["The token did not pass account verification", "El token no pasó la verificación de cuenta"],
  oauth_not_configured: ["No Alpaca OAuth app is configured", "No hay una app OAuth de Alpaca configurada"],
  not_configured: ["Installation not configured (bun run setup)", "Instalación sin configurar (bun run setup)"],
  no_public_url: ["No public base URL configured for the callback", "No hay URL pública configurada para el callback"],
};

export function oauthResultMessage(result) {
  if (!result) return "";
  if (result.ok) return t("Alpaca account connected", "Cuenta de Alpaca conectada") + (result.id ? `: ${result.id}` : "");
  const m = OAUTH_REASONS[result.reason];
  return m ? t(m[0], m[1]) : t("OAuth failed", "Falló OAuth") + ` (${result.reason})`;
}

export function renderAccountRow(a) {
  const st = statusInfo(a.status);
  const linkedReason = a.runtimeLinked
    ? t("In use by the bot — link another account and restart before removing this one", "En uso por el bot — vincula otra cuenta y reinicia antes de quitar esta")
    : "";
  const dis = a.runtimeLinked ? `disabled title="${esc(linkedReason)}"` : "";
  const revoked = a.status === "revoked";
  return `<div class="acc-row" data-acc-id="${esc(a.id)}">
    <div class="acc-main">
      <b>${esc(a.label)}</b>
      <span class="chip">${esc(providerLabel(a.provider))}</span>
      <span class="chip">${esc(envLabel(a.environment))}</span>
      <span class="chip">${esc(authTypeLabel(a.authType))}</span>
      <span class="acc-status ${st.cls}">${esc(st.label)}</span>
      ${a.runtimeLinked ? `<span class="acc-status ok" title="${esc(linkedReason)}">${t("In use by the bot", "En uso por el bot")}</span>` : ""}
    </div>
    <div class="acc-sub muted">
      ${a.accountRef ? `${t("Account", "Cuenta")} <code>${esc(a.accountRef)}</code> · ` : ""}
      ${t("Verified", "Verificada")}: ${esc(fmtWhen(a.lastVerifiedAt))}
      ${a.lastError ? `<div class="acc-err">${esc(a.lastError)}</div>` : ""}
    </div>
    <div class="acc-actions">
      <button class="acc-btn" data-acc-view="${esc(a.id)}">${t("View", "Ver")}</button>
      <button class="acc-btn" data-acc-verify="${esc(a.id)}" ${revoked ? `disabled title="${esc(t("Revoked — reconnect the account to verify it", "Revocada — reconecta la cuenta para verificarla"))}"` : ""}>${t("Verify", "Verificar")}</button>
      ${revoked ? "" : `<button class="acc-btn danger" data-acc-revoke="${esc(a.id)}" ${dis}>${t("Revoke", "Revocar")}</button>`}
      <button class="acc-btn danger" data-acc-del="${esc(a.id)}" ${dis}>${t("Remove", "Quitar")}</button>
    </div>
  </div>`;
}

/** Read-only detail (no secrets exist to show — only the redacted record). */
export function renderAccountDetail(a) {
  const st = statusInfo(a.status);
  const row = (l, v) => `<div class="set-row"><span>${esc(l)}</span><span class="set-v">${v}</span></div>`;
  return row("Id", `<code>${esc(a.id)}</code>`)
    + row(t("Label", "Etiqueta"), esc(a.label))
    + row(t("Provider", "Proveedor"), esc(providerLabel(a.provider)))
    + row(t("Environment", "Entorno"), esc(envLabel(a.environment)))
    + row(t("Auth", "Autenticación"), esc(authTypeLabel(a.authType)))
    + row(t("Status", "Estado"), `<span class="acc-status ${st.cls}">${esc(st.label)}</span>`)
    + row(t("Account number", "Nº de cuenta"), a.accountRef ? `<code>${esc(a.accountRef)}</code>` : "—")
    + row(t("Last verified", "Última verificación"), esc(fmtWhen(a.lastVerifiedAt)))
    + row(t("Created", "Creada"), esc(fmtWhen(a.createdAt)))
    + row(t("In use by the bot", "En uso por el bot"), a.runtimeLinked ? t("Yes", "Sí") : "No")
    + (a.lastError ? row("Error", `<span class="acc-err">${esc(a.lastError)}</span>`) : "")
    + `<div class="muted acc-note">${t("Credentials are sealed and never displayed.", "Las credenciales están cifradas y nunca se muestran.")}</div>`;
}

export function renderAccountsList(data) {
  if (!data) return `<div class="muted">${t("Could not load accounts", "No se pudieron cargar las cuentas")}</div>`;
  if (data.configured === false) {
    return `<div class="acc-setup">${t(
      "Installation not configured — run `bun run setup` on the server to create the master key before adding broker accounts.",
      "Instalación sin configurar — ejecuta `bun run setup` en el servidor para crear la clave maestra antes de añadir cuentas de broker.",
    )}</div>`;
  }
  const rows = (data.accounts || []).map(renderAccountRow).join("");
  return multiVerifiedWarningHtml(data.accounts) + (rows || `<div class="muted">${t("No broker accounts yet.", "Aún no hay cuentas de broker.")}</div>`);
}

export function renderBinanceSecurityTips() {
  const tip = (en, es) => `<li>${esc(t(en, es))}</li>`;
  return `<ul class="acc-tips">
    ${tip("Enable FUTURES on the key; leave withdrawals DISABLED.", "Activa FUTUROS en la clave; deja los retiros DESACTIVADOS.")}
    ${tip("Restrict the key to this server's IP (allowlist).", "Restringe la clave a la IP de este servidor (lista blanca).")}
    ${tip("Use a dedicated key for this bot — never reuse keys across apps.", "Usa una clave dedicada para este bot — nunca reutilices claves entre apps.")}
  </ul>`;
}

/** Add-account modal body. `data` = the GET /api/platform/accounts payload. */
export function renderAddModal(data, provider) {
  const chooser = `<div class="acc-choose">
    <button class="acc-btn ${provider === "alpaca" ? "on" : ""}" data-acc-provider="alpaca">Alpaca</button>
    <button class="acc-btn ${provider === "binance_usdm" ? "on" : ""}" data-acc-provider="binance_usdm">Binance USDⓈ-M</button>
  </div>`;
  const labelField = `<label>${t("Label", "Etiqueta")}</label>
    <input class="acc-input" id="accLabel" maxlength="64" placeholder="${t("e.g. Main paper account", "p. ej. Cuenta paper principal")}">`;
  let form = "";
  if (provider === "alpaca") {
    const envSeg = `<label>${t("Environment", "Entorno")}</label>
      <select class="acc-input" id="accEnv"><option value="paper">Paper</option><option value="live">${t("Live", "Real")}</option></select>`;
    const oauthPart = data && data.alpacaOAuth
      ? `<button class="acc-btn primary" data-acc-oauth>${t("Connect with Alpaca", "Conectar con Alpaca")}</button>
         <div class="muted acc-note">${t("You will be redirected to Alpaca to authorize access.", "Serás redirigido a Alpaca para autorizar el acceso.")}</div>
         <div class="acc-sep">${t("or use API keys", "o usa claves API")}</div>`
      : `<div class="muted acc-note">${t("No OAuth app configured — use API keys.", "Sin app OAuth configurada — usa claves API.")}</div>`;
    form = `${envSeg}${labelField}${oauthPart}
      <label>API Key ID</label><input class="acc-input" id="accKey" autocomplete="off">
      <label>API Secret</label><input class="acc-input" id="accSecret" type="password" autocomplete="off">
      <button class="acc-btn primary" data-acc-save>${t("Verify & save", "Verificar y guardar")}</button>`;
  } else {
    form = `<label>${t("Environment", "Entorno")}</label>
      <select class="acc-input" id="accEnv"><option value="demo">Demo (demo-fapi)</option><option value="live">${t("Live", "Real")}</option></select>
      ${labelField}
      ${renderBinanceSecurityTips()}
      <label>API Key</label><input class="acc-input" id="accKey" autocomplete="off">
      <label>API Secret</label><input class="acc-input" id="accSecret" type="password" autocomplete="off">
      <button class="acc-btn primary" data-acc-save>${t("Verify & save", "Verificar y guardar")}</button>`;
  }
  return `${chooser}<div class="acc-form">${form}</div>
    <div class="muted acc-note">${t(
      "Credentials are verified with a read-only call, encrypted at rest, and never shown again.",
      "Las credenciales se verifican con una llamada de solo lectura, se cifran en reposo y no vuelven a mostrarse.",
    )}</div>
    <div class="acc-msg" id="accMsg"></div>`;
}

// ── stateful UI ──────────────────────────────────────────────────────────

let root = null;       // the page body element (#pageBody) the view is mounted in
let modal = null;      // add-account modal backdrop
let escHandler = null;
let data = null;       // last GET /api/platform/accounts payload
let pendingOauthResult = null; // parsed OAuth redirect result → banner on next mount

/** main.js stores the OAuth round-trip result here before navigating to
 *  #/cuentas, so the banner shows on the page mount. One-shot. */
export function setPendingOauthResult(result) { pendingOauthResult = result; }

function noticeHtml(text, ok) {
  return text ? `<div class="acc-msg ${ok ? "ok" : "err"}">${esc(text)}</div>` : "";
}

async function reload(el) {
  data = await api.platformAccounts();
  if (!el.isConnected) return;
  const list = el.querySelector("#accList");
  if (list) list.innerHTML = renderAccountsList(data);
  const add = el.querySelector("[data-acc-open-add]");
  if (add) add.disabled = !data || data.configured === false;
}

/** Mounts the "Cuentas" page into `host` (a fresh #pageBody element).
 *  Replaces the old slideover (2026-10-06 portfolio-manager nav). */
export async function mountAccounts(host) {
  closeModal();
  if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
  const oauthResult = pendingOauthResult;
  pendingOauthResult = null;
  root = host;
  host.innerHTML = `
    ${noticeHtml(oauthResultMessage(oauthResult), !!(oauthResult && oauthResult.ok))}
    <div id="accList" class="acc-list"><div class="muted">…</div></div>
    <button class="acc-btn primary" data-acc-open-add style="margin-top:var(--s4)">${t("Connect account", "Conectar cuenta")}</button>
    <div class="muted acc-note">${t(
      "Credentials are encrypted at rest and never shown again. The bot only signs with the account linked at startup.",
      "Las credenciales se cifran en reposo y no vuelven a mostrarse. El bot solo firma con la cuenta vinculada al arrancar.",
    )}</div>`;
  host.addEventListener("click", onPanelClick);
  escHandler = (e) => { if (e.key === "Escape" && modal) closeModal(); };
  document.addEventListener("keydown", escHandler);
  try { await reload(host); } catch { /* renderAccountsList(null) already says it */ }
}

function onPanelClick(e) {
  if (e.target.closest("[data-acc-open-add]")) return openAddModal();
  const view = e.target.closest("[data-acc-view]");
  if (view) return openDetail(view.dataset.accView);
  const verify = e.target.closest("[data-acc-verify]");
  if (verify) return doVerify(verify.dataset.accVerify, verify);
  const revoke = e.target.closest("[data-acc-revoke]");
  if (revoke) return doRevoke(revoke.dataset.accRevoke);
  const del = e.target.closest("[data-acc-del]");
  if (del) return doDelete(del.dataset.accDel);
}

function accountById(id) {
  return (data?.accounts || []).find((a) => a.id === id) || null;
}

function openDetail(id) {
  const a = accountById(id);
  if (!a) return;
  closeModal();
  const el = modal = document.createElement("div");
  modal.className = "cm-backdrop";
  modal.innerHTML = `<div class="cm acc-modal" role="dialog" aria-modal="true" aria-label="${esc(a.label)}">
    <div class="cm-head"><b>${esc(a.label)}</b><span style="flex:1"></span>
      <button class="icn" data-acc-mclose aria-label="${t("Close", "Cerrar")}">${icon("x")}</button></div>
    <div class="acc-mbody">${renderAccountDetail(a)}</div></div>`;
  document.body.appendChild(modal);
  modal.addEventListener("pointerdown", (ev) => { if (ev.target === el) closeModal(); });
  modal.addEventListener("click", (ev) => { if (ev.target.closest("[data-acc-mclose]")) closeModal(); });
}

async function doVerify(id, btn) {
  btn.disabled = true;
  try { await api.verifyPlatformAccount(id); }
  catch (err) { alert(err?.message || t("Verification failed", "Falló la verificación")); }
  if (root) await reload(root).catch(() => {});
}

async function doRevoke(id) {
  const a = accountById(id);
  const oauthNote = a?.authType === "oauth"
    ? t(" The OAuth grant also lives at the broker: revoke the app's access from your Alpaca account settings too.",
        " El permiso OAuth también vive en el broker: revoca además el acceso de la app desde los ajustes de tu cuenta de Alpaca.")
    : "";
  const sure = confirm(t(
    `Revoke account '${id}'? The stored credentials are deleted and the bot can no longer use it; the record stays. To use it again you must reconnect it.${oauthNote}`,
    `¿Revocar la cuenta '${id}'? Se eliminan las credenciales guardadas y el bot deja de poder usarla; el registro se conserva. Para usarla de nuevo tendrás que reconectarla.${oauthNote}`,
  ));
  if (!sure) return;
  try { await api.revokePlatformAccount(id); }
  catch (err) { alert(err?.message || t("Revoke failed", "Falló la revocación")); }
  if (root) await reload(root).catch(() => {});
}

async function doDelete(id) {
  const sure = confirm(t(`Remove account '${id}'? The stored credentials are deleted.`, `¿Quitar la cuenta '${id}'? Se eliminan las credenciales guardadas.`));
  if (!sure) return;
  try { await api.deletePlatformAccount(id); }
  catch (err) { alert(err?.message || t("Remove failed", "Falló la eliminación")); }
  if (root) await reload(root).catch(() => {});
}

function openAddModal() {
  closeModal();
  let provider = "alpaca";
  const el = modal = document.createElement("div");
  modal.className = "cm-backdrop";
  const shell = () => `<div class="cm acc-modal" role="dialog" aria-modal="true" aria-label="${t("Add account", "Añadir cuenta")}">
    <div class="cm-head"><b>${t("Add broker account", "Añadir cuenta de broker")}</b><span style="flex:1"></span>
      <button class="icn" data-acc-mclose aria-label="${t("Close", "Cerrar")}">${icon("x")}</button></div>
    <div class="acc-mbody">${renderAddModal(data, provider)}</div></div>`;
  modal.innerHTML = shell();
  document.body.appendChild(modal);
  modal.addEventListener("pointerdown", (e) => { if (e.target === modal) closeModal(); });
  modal.addEventListener("click", async (e) => {
    if (e.target.closest("[data-acc-mclose]")) return closeModal();
    const pick = e.target.closest("[data-acc-provider]");
    if (pick) { provider = pick.dataset.accProvider; el.innerHTML = shell(); return; }
    if (e.target.closest("[data-acc-oauth]")) {
      const env = el.querySelector("#accEnv")?.value === "live" ? "live" : "paper";
      const label = el.querySelector("#accLabel")?.value?.trim() || "";
      const q = new URLSearchParams({ env });
      if (label) q.set("label", label);
      location.href = "/api/platform/accounts/oauth/alpaca/start?" + q.toString();
      return;
    }
    const save = e.target.closest("[data-acc-save]");
    if (save) {
      const msg = el.querySelector("#accMsg");
      const body = {
        provider,
        environment: el.querySelector("#accEnv")?.value,
        label: el.querySelector("#accLabel")?.value?.trim(),
        apiKey: el.querySelector("#accKey")?.value?.trim(),
        apiSecret: el.querySelector("#accSecret")?.value?.trim(),
      };
      save.disabled = true;
      if (msg) { msg.className = "acc-msg"; msg.textContent = t("Verifying with the broker…", "Verificando con el broker…"); }
      try {
        const r = await api.addPlatformAccount(body);
        const warn = (r?.warnings || []).join(" · ");
        if (msg) { msg.className = "acc-msg ok"; msg.textContent = t("Account verified and saved", "Cuenta verificada y guardada") + (warn ? ` — ${warn}` : ""); }
        if (root) await reload(root).catch(() => {});
        setTimeout(closeModal, warn ? 3500 : 900);
      } catch (err) {
        save.disabled = false;
        if (msg) { msg.className = "acc-msg err"; msg.textContent = err?.message || t("Failed", "Falló"); }
      }
    }
  });
}

function closeModal() {
  if (modal) { modal.remove(); modal = null; }
}
