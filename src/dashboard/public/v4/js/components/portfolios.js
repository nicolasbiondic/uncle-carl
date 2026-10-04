// ── portfolios.js — "Portfolios" view (F3c read + F3d create/edit, platform
// registry). Lists the platform_portfolios registry — template, account,
// capital, universe size, mode, origin (code/db) and the scorecard
// expectation-band state — from GET /api/platform/portfolios (api.js, fails
// soft to null while the route is not mounted). When GET /meta reports
// `writable` (PORTFOLIOS_SOURCE=db + write deps wired), the panel adds a
// "New portfolio" form and per-row edit/archive controls — otherwise it
// stays the F3c read-only view plus a note on how to unlock writes.
// Bilingual via t(); render/parse helpers are pure and tested in
// portfolios.test.js. CSRF + credentials are handled by api.js uniformly.
import { api } from "../api.js";
import { t } from "../store.js";
import { esc, icon } from "../ui.js";
import { trapFocus } from "../focus-trap.js";
import { num } from "../fmt.js";

export function templateLabel(tpl) {
  if (tpl === "momentum_tsm") return t("Momentum TSM", "Momentum TSM");
  if (tpl === "meanrev_connors") return t("Mean reversion (Connors RSI2)", "Reversión a la media (Connors RSI2)");
  return tpl;
}

export function accountLabel(a) {
  const m = {
    alpaca_main: "Alpaca",
    binance_usdt: "Binance USDT-M",
    binance_usdc: "Binance USDC-M",
    binance_coinm: "Binance COIN-M",
  };
  return m[a] || a;
}

/** Scorecard expectation-band chip. No reading → an honest dash, never a
 *  fabricated "ok" (same honesty rule as the backend's band:null). */
export function bandChipHtml(band) {
  if (!band || band.status === "unavailable") return `<span class="muted">—</span>`;
  const m = {
    below: [t("Below band", "Bajo banda"), "var(--down)"],
    within: [t("Within band", "En banda"), "var(--up)"],
    above: [t("Above band", "Sobre banda"), "var(--up)"],
    insufficient_data: [t("Too new", "Muy nuevo"), "var(--muted)"],
  };
  const [label, color] = m[band.status] || [band.status, "var(--muted)"];
  const detail = band.liveCumReturnPct != null && band.p5Pct != null
    ? ` <span class="muted">(${num(band.liveCumReturnPct, 1)}% vs p5 ${num(band.p5Pct, 1)}%)</span>`
    : "";
  return `<span style="color:${color}">${esc(label)}</span>${detail}`;
}

// ── pure form/body helpers (tested DOM-less) ─────────────────────────────

/** JSON.parse with a clear, user-facing error — never a raw stack. An empty
 *  string parses to {ok:true, value:undefined} (the caller decides whether
 *  that is acceptable, e.g. "no params edit" vs "params required"). */
export function parseParamsJson(text) {
  const s = (text ?? "").trim();
  if (!s) return { ok: true, value: undefined };
  let value;
  try {
    value = JSON.parse(s);
  } catch (e) {
    return { ok: false, error: t("Invalid params JSON", "JSON de params inválido") + `: ${e?.message || e}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: t("params must be a JSON object", "params debe ser un objeto JSON") };
  }
  return { ok: true, value };
}

/** Builds the POST /api/platform/portfolios body from the "new portfolio"
 *  form state, or returns the client-side errors (same shape the API
 *  answers with: {ok:false, errors:[...]}). `form.source` is "preset" or
 *  "free"; only the fields that branch needs are read. */
export function buildCreateBody(form) {
  const errors = [];
  const id = String(form?.id ?? "").trim();
  const name = String(form?.name ?? "").trim();
  const account = String(form?.account ?? "").trim();
  const capital = Number(form?.capital);
  if (!id) errors.push(t("id is required", "el id es obligatorio"));
  if (!name) errors.push(t("name is required", "el nombre es obligatorio"));
  if (!account) errors.push(t("account is required", "la cuenta es obligatoria"));
  if (!Number.isFinite(capital) || capital <= 0) errors.push(t("capital must be a number > 0", "el capital debe ser un número mayor que 0"));

  if (form?.source === "free") {
    const template = String(form?.template ?? "");
    if (template !== "momentum_tsm" && template !== "meanrev_connors") {
      errors.push(t("template is required", "la plantilla es obligatoria"));
    }
    const parsed = parseParamsJson(form?.paramsText);
    if (!parsed.ok) errors.push(parsed.error);
    else if (parsed.value === undefined) errors.push(t("params are required for a free template", "params es obligatorio para una plantilla libre"));
    if (errors.length) return { ok: false, errors };
    return { ok: true, body: { id, name, account, capital, template, params: parsed.value } };
  }

  const preset = String(form?.preset ?? "").trim();
  if (!preset) errors.push(t("preset is required", "el preset es obligatorio"));
  if (errors.length) return { ok: false, errors };
  return { ok: true, body: { id, name, account, capital, preset } };
}

/** Builds the PATCH /api/platform/portfolios/:id body from the edit-row
 *  form state: name, capital, enabled always included (idempotent — the API
 *  only flags pending_restart on an actual change); params included only
 *  when the textarea is non-empty (full replacement, parsed client-side
 *  first for a clear error instead of a round trip to find a typo). */
export function buildPatchBody(form) {
  const errors = [];
  const name = String(form?.name ?? "").trim();
  const capital = Number(form?.capital);
  if (!name) errors.push(t("name is required", "el nombre es obligatorio"));
  if (!Number.isFinite(capital) || capital <= 0) errors.push(t("capital must be a number > 0", "el capital debe ser un número mayor que 0"));
  const body = { name, capital, enabled: !!form?.enabled };
  if (form?.paramsText !== undefined && String(form.paramsText).trim() !== "") {
    const parsed = parseParamsJson(form.paramsText);
    if (!parsed.ok) errors.push(parsed.error);
    else body.params = parsed.value;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, body };
}

/** API errors (400/422 {errors:[...]}) rendered verbatim, as a list — never
 *  summarized or reworded, so the owner sees exactly what the validator
 *  refused. */
export function formatErrors(errors) {
  if (!errors || !errors.length) return "";
  return `<ul class="pf-errlist">${errors.map((e) => `<li>${esc(String(e))}</li>`).join("")}</ul>`;
}

// ── row / table rendering ────────────────────────────────────────────────

export function portfolioRowHtml(p, writable) {
  const disabled = p.enabled ? "" : ` · <span class="muted">${t("disabled", "desactivado")}</span>`;
  const unvalidated = p.validation === "unvalidated"
    ? ` <span style="color:var(--down)" title="${t("Params differ from the validated artifact", "Parámetros distintos del artefacto validado")}">⚠ ${t("unvalidated", "no validado")}</span>`
    : "";
  const pending = p.status === "pending_restart"
    ? ` · <span class="muted">${t("pending restart — applies on the next restart", "pendiente de reinicio — se aplica en el próximo reinicio")}</span>`
    : "";
  const archived = p.status === "archived" ? ` · <span class="muted">${t("archived", "archivado")}</span>` : "";
  const actions = writable ? `<td class="pf-actions">
      <button class="acc-btn" data-pf-edit="${esc(p.id)}">${t("Edit", "Editar")}</button>
      <button class="acc-btn danger" data-pf-archive="${esc(p.id)}" data-pf-archived="${p.status === "archived" ? "1" : "0"}">
        ${p.status === "archived" ? t("Restore", "Restaurar") : t("Archive", "Archivar")}
      </button>
    </td>` : "";
  return `<tr class="${p.status === "archived" ? "pf-row-archived" : ""}">
    <td><b>${esc(p.name)}</b>${unvalidated}<div class="muted" style="font-size:var(--t-xs)">${esc(p.id)}${pending}${archived}</div></td>
    <td>${esc(templateLabel(p.template))}</td>
    <td>${esc(accountLabel(p.account))}</td>
    <td>$${num(p.capital, 0)}</td>
    <td>${Number(p.universeSize) || 0}</td>
    <td>${esc(p.mode)}${disabled}</td>
    <td>${bandChipHtml(p.band)}</td>
    ${actions}
  </tr>`;
}

const EMPTY_META = { writable: false, presets: [], accounts: [] };

export function renderPortfoliosBody(items, meta = EMPTY_META) {
  if (!items) return `<div class="muted">${t("Portfolios API unavailable (route not mounted yet)", "API de portafolios no disponible (ruta aún sin montar)")}</div>`;
  const writable = !!meta?.writable;
  const newBtn = writable ? `<button class="acc-btn primary" data-pf-new>${t("New portfolio", "Nuevo portafolio")}</button>` : "";
  const writeNote = writable
    ? ""
    : `<div class="muted pf-note">${t("Create and edit unlock with PORTFOLIOS_SOURCE=db.", "Crear y editar se activan con PORTFOLIOS_SOURCE=db.")}</div>`;
  const head = `<div class="pf-head">
    <div class="muted" style="font-size:var(--t-xs)">${t("Source", "Origen")}: ${esc(sourceLabel(items))}</div>
    ${newBtn}
  </div>${writeNote}`;
  if (!items.length) return `${head}<div class="muted">${t("No portfolios", "Sin portafolios")}</div>`;
  const actionsHead = writable ? `<th>${t("Actions", "Acciones")}</th>` : "";
  return `${head}
    <div class="scroll"><table class="postbl"><thead><tr>
      <th>${t("Portfolio", "Portafolio")}</th><th>${t("Template", "Plantilla")}</th><th>${t("Account", "Cuenta")}</th>
      <th>${t("Capital", "Capital")}</th><th>${t("Universe", "Universo")}</th><th>${t("Mode", "Modo")}</th><th>${t("Band", "Banda")}</th>${actionsHead}
    </tr></thead><tbody>${items.map((p) => portfolioRowHtml(p, writable)).join("")}</tbody></table></div>`;
}

function sourceLabel(items) {
  const origin = items && items.length ? items[0].origin : null;
  return origin === "db"
    ? t("database registry (PORTFOLIOS_SOURCE=db)", "registro en base de datos (PORTFOLIOS_SOURCE=db)")
    : t("code — built-in definitions (PORTFOLIOS_SOURCE=code)", "código — definiciones integradas (PORTFOLIOS_SOURCE=code)");
}

// ── "new portfolio" form (pure render; the caller wires events) ─────────

function accountOptionsHtml(accounts, selected) {
  return accounts.map((a) => `<option value="${esc(a)}" ${a === selected ? "selected" : ""}>${esc(accountLabel(a))}</option>`).join("");
}

function presetOptionsHtml(presets, selected) {
  return presets.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? "selected" : ""}>${esc(p.name)} (${esc(accountLabel(p.account))})</option>`).join("");
}

/** Example params for a free template: the validated preset sharing that
 *  template (never a blank editor for the owner to guess the shape of). */
export function exampleParamsFor(presets, template) {
  const match = (presets || []).find((p) => p.template === template);
  return match ? match.exampleParams : {};
}

export function renderCreateFormHtml(meta, state) {
  const source = state.source === "free" ? "free" : "preset";
  const toggle = `<div class="acc-choose">
    <button type="button" class="acc-btn ${source === "preset" ? "on" : ""}" data-pf-source="preset">${t("Validated preset", "Preset validado")}</button>
    <button type="button" class="acc-btn ${source === "free" ? "on" : ""}" data-pf-source="free">${t("Free template", "Plantilla libre")}</button>
  </div>`;
  const common = `
    <label>${t("Id", "Id")}</label>
    <input class="acc-input" id="pfId" placeholder="momentum_stocks_v2" value="${esc(state.id || "")}">
    <label>${t("Name", "Nombre")}</label>
    <input class="acc-input" id="pfName" value="${esc(state.name || "")}">
    <label>${t("Account", "Cuenta")}</label>
    <select class="acc-input" id="pfAccount"><option value="">—</option>${accountOptionsHtml(meta.accounts, state.account)}</select>
    <label>${t("Capital", "Capital")} (USD)</label>
    <input class="acc-input" id="pfCapital" type="number" min="0" step="1" value="${esc(state.capital ?? "")}">`;
  let specific;
  if (source === "preset") {
    specific = `<label>${t("Preset", "Preset")}</label>
      <select class="acc-input" id="pfPreset"><option value="">—</option>${presetOptionsHtml(meta.presets, state.preset)}</select>`;
  } else {
    const template = state.template || "momentum_tsm";
    const paramsText = state.paramsText !== undefined ? state.paramsText : JSON.stringify(exampleParamsFor(meta.presets, template), null, 2);
    specific = `<label>${t("Template", "Plantilla")}</label>
      <select class="acc-input" id="pfTemplate">
        <option value="momentum_tsm" ${template === "momentum_tsm" ? "selected" : ""}>${templateLabel("momentum_tsm")}</option>
        <option value="meanrev_connors" ${template === "meanrev_connors" ? "selected" : ""}>${templateLabel("meanrev_connors")}</option>
      </select>
      <div class="pf-warn">⚠ ${t("Not validated: no artifact backs this configuration.", "No validado: sin artefacto que la respalde.")}</div>
      <label>${t("Params (JSON)", "Params (JSON)")}</label>
      <textarea class="acc-input pf-json" id="pfParams" rows="10" spellcheck="false">${esc(paramsText)}</textarea>`;
  }
  return `${toggle}${common}${specific}
    <button type="button" class="acc-btn primary" data-pf-create-save>${t("Create", "Crear")}</button>
    <div class="acc-msg" id="pfCreateMsg"></div>`;
}

export function renderEditFormHtml(p, state) {
  const paramsText = state.paramsText !== undefined ? state.paramsText : JSON.stringify(p.params ?? {}, null, 2);
  return `<label>${t("Name", "Nombre")}</label>
    <input class="acc-input" id="pfeName" value="${esc(state.name ?? p.name)}">
    <label>${t("Capital", "Capital")} (USD)</label>
    <input class="acc-input" id="pfeCapital" type="number" min="0" step="1" value="${esc(state.capital ?? p.capital)}">
    <label class="pf-check"><input type="checkbox" id="pfeEnabled" ${state.enabled ?? p.enabled ? "checked" : ""}> ${t("Enabled", "Activado")}</label>
    <label>${t("Advanced params (JSON, full replacement)", "Params avanzados (JSON, reemplazo completo)")}</label>
    <textarea class="acc-input pf-json" id="pfeParams" rows="12" spellcheck="false">${esc(paramsText)}</textarea>
    <button type="button" class="acc-btn primary" data-pf-edit-save>${t("Save", "Guardar")}</button>
    <div class="acc-msg" id="pfEditMsg"></div>`;
}

// ── stateful UI ──────────────────────────────────────────────────────────

let root = null;         // slideover backdrop
let createModal = null;  // "new portfolio" modal
let editModal = null;    // edit-row modal
let escHandler = null;
let release = null;
let meta = EMPTY_META;
let items = null;
let createState = { source: "preset" };

function msgEl(container, id) { return container?.querySelector(`#${id}`); }

async function reload(el) {
  items = await api.platformPortfolios();
  const body = el.querySelector("#pfBody");
  if (body) body.innerHTML = renderPortfoliosBody(items, meta);
}

export async function openPortfolios() {
  close();
  const el = root = document.createElement("div");
  root.className = "so-backdrop";
  root.innerHTML = `<aside class="so" role="dialog" aria-modal="true" aria-label="${t("Portfolios", "Portafolios")}" style="min-width:min(900px,92vw)">
    <div class="so-head"><b>${t("Portfolios", "Portafolios")}</b><button class="icn" data-pfclose aria-label="${t("Close", "Cerrar")}">${icon("x")}</button></div>
    <div class="so-body" id="pfBody"><div class="muted">…</div></div></aside>`;
  document.body.appendChild(root);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  root.addEventListener("click", onPanelClick);
  escHandler = (e) => { if (e.key === "Escape") { if (editModal) closeEdit(); else if (createModal) closeCreate(); else close(); } };
  document.addEventListener("keydown", escHandler);
  release = trapFocus(root);
  try {
    meta = await api.platformPortfoliosMeta();
  } catch {
    meta = EMPTY_META;
  }
  if (root !== el || !el.isConnected) return;
  await reload(el).catch(() => {});
}

function onPanelClick(e) {
  if (e.target.closest("[data-pfclose]")) return close();
  if (e.target.closest("[data-pf-new]")) return openCreate();
  const edit = e.target.closest("[data-pf-edit]");
  if (edit) return openEdit(edit.dataset.pfEdit);
  const archive = e.target.closest("[data-pf-archive]");
  if (archive) return doArchive(archive.dataset.pfArchive, archive.dataset.pfArchived === "1");
}

async function doArchive(id, isArchived) {
  const p = (items || []).find((x) => x.id === id);
  const name = p ? p.name : id;
  const question = isArchived
    ? t(`Restore portfolio '${name}'? This is your decision — the system never recommends it.`, `¿Restaurar el portafolio '${name}'? Esta decisión es tuya — el sistema nunca la recomienda.`)
    : t(`Archive portfolio '${name}'? This is your decision — the system never recommends it. It applies on the next restart.`, `¿Archivar el portafolio '${name}'? Esta decisión es tuya — el sistema nunca la recomienda. Se aplica en el próximo reinicio.`);
  if (!confirm(question)) return;
  try {
    await api.patchPlatformPortfolio(id, { archived: !isArchived });
  } catch (err) {
    alert(err?.data?.errors ? err.data.errors.join("\n") : (err?.message || t("Failed", "Falló")));
  }
  if (root) await reload(root).catch(() => {});
}

// ── "new portfolio" modal ────────────────────────────────────────────────

function renderCreateModal() {
  return `<div class="cm acc-modal" role="dialog" aria-modal="true" aria-label="${t("New portfolio", "Nuevo portafolio")}">
    <div class="cm-head"><b>${t("New portfolio", "Nuevo portafolio")}</b><span style="flex:1"></span>
      <button class="icn" data-pf-create-close aria-label="${t("Close", "Cerrar")}">${icon("x")}</button></div>
    <div class="acc-mbody">${renderCreateFormHtml(meta, createState)}</div></div>`;
}

function openCreate() {
  closeCreate();
  createState = { source: "preset" };
  createModal = document.createElement("div");
  createModal.className = "cm-backdrop pf-modal-backdrop";
  createModal.innerHTML = renderCreateModal();
  document.body.appendChild(createModal);
  createModal.addEventListener("pointerdown", (e) => { if (e.target === createModal) closeCreate(); });
  createModal.addEventListener("click", onCreateClick);
  createModal.addEventListener("change", onCreateChange);
}

function readCreateFormState() {
  const el = createModal;
  createState.id = el.querySelector("#pfId")?.value ?? createState.id;
  createState.name = el.querySelector("#pfName")?.value ?? createState.name;
  createState.account = el.querySelector("#pfAccount")?.value ?? createState.account;
  createState.capital = el.querySelector("#pfCapital")?.value ?? createState.capital;
  if (createState.source === "preset") {
    createState.preset = el.querySelector("#pfPreset")?.value ?? createState.preset;
  } else {
    createState.template = el.querySelector("#pfTemplate")?.value ?? createState.template;
    createState.paramsText = el.querySelector("#pfParams")?.value ?? createState.paramsText;
  }
}

function onCreateChange(e) {
  if (e.target.id === "pfTemplate") {
    readCreateFormState();
    createState.paramsText = undefined; // fresh example for the newly picked template
    createModal.querySelector(".acc-mbody").innerHTML = renderCreateFormHtml(meta, createState);
  }
}

async function onCreateClick(e) {
  if (e.target.closest("[data-pf-create-close]")) return closeCreate();
  const toggle = e.target.closest("[data-pf-source]");
  if (toggle) {
    readCreateFormState();
    createState.source = toggle.dataset.pfSource;
    createModal.querySelector(".acc-mbody").innerHTML = renderCreateFormHtml(meta, createState);
    return;
  }
  const save = e.target.closest("[data-pf-create-save]");
  if (save) {
    readCreateFormState();
    const result = buildCreateBody(createState);
    const msg = createModal.querySelector("#pfCreateMsg");
    if (!result.ok) {
      if (msg) { msg.className = "acc-msg err"; msg.innerHTML = formatErrors(result.errors); }
      return;
    }
    save.disabled = true;
    if (msg) { msg.className = "acc-msg"; msg.textContent = t("Saving…", "Guardando…"); }
    try {
      const r = await api.createPlatformPortfolio(result.body);
      if (msg) {
        msg.className = "acc-msg ok";
        msg.textContent = t("Created — applies on the next restart (pending_restart).", "Creado — se aplica en el próximo reinicio (pendiente de reinicio).") + (r?.note ? ` (${r.note})` : "");
      }
      if (root) await reload(root).catch(() => {});
      setTimeout(closeCreate, 1400);
    } catch (err) {
      save.disabled = false;
      if (msg) { msg.className = "acc-msg err"; msg.innerHTML = err?.data?.errors ? formatErrors(err.data.errors) : esc(err?.message || t("Failed", "Falló")); }
    }
  }
}

function closeCreate() {
  if (createModal) { createModal.remove(); createModal = null; }
}

// ── edit-row modal ───────────────────────────────────────────────────────

let editState = {};
let editingId = null;

function openEdit(id) {
  const p = (items || []).find((x) => x.id === id);
  if (!p) return;
  closeEdit();
  editingId = id;
  editState = {};
  editModal = document.createElement("div");
  editModal.className = "cm-backdrop pf-modal-backdrop";
  editModal.innerHTML = `<div class="cm acc-modal" role="dialog" aria-modal="true" aria-label="${t("Edit portfolio", "Editar portafolio")}">
    <div class="cm-head"><b>${esc(p.name)}</b><span style="flex:1"></span>
      <button class="icn" data-pf-edit-close aria-label="${t("Close", "Cerrar")}">${icon("x")}</button></div>
    <div class="acc-mbody">${renderEditFormHtml(p, editState)}</div></div>`;
  document.body.appendChild(editModal);
  editModal.addEventListener("pointerdown", (e) => { if (e.target === editModal) closeEdit(); });
  editModal.addEventListener("click", onEditClick);
}

async function onEditClick(e) {
  if (e.target.closest("[data-pf-edit-close]")) return closeEdit();
  const save = e.target.closest("[data-pf-edit-save]");
  if (!save) return;
  const el = editModal;
  const form = {
    name: el.querySelector("#pfeName")?.value,
    capital: el.querySelector("#pfeCapital")?.value,
    enabled: el.querySelector("#pfeEnabled")?.checked,
    paramsText: el.querySelector("#pfeParams")?.value,
  };
  const result = buildPatchBody(form);
  const msg = el.querySelector("#pfEditMsg");
  if (!result.ok) {
    if (msg) { msg.className = "acc-msg err"; msg.innerHTML = formatErrors(result.errors); }
    return;
  }
  save.disabled = true;
  if (msg) { msg.className = "acc-msg"; msg.textContent = t("Saving…", "Guardando…"); }
  try {
    const r = await api.patchPlatformPortfolio(editingId, result.body);
    if (msg) {
      msg.className = "acc-msg ok";
      msg.textContent = t("Saved — applies on the next restart (pending_restart).", "Guardado — se aplica en el próximo reinicio (pendiente de reinicio).") + (r?.note ? ` (${r.note})` : "");
    }
    if (root) await reload(root).catch(() => {});
    setTimeout(closeEdit, 1400);
  } catch (err) {
    save.disabled = false;
    if (msg) { msg.className = "acc-msg err"; msg.innerHTML = err?.data?.errors ? formatErrors(err.data.errors) : esc(err?.message || t("Failed", "Falló")); }
  }
}

function closeEdit() {
  if (editModal) { editModal.remove(); editModal = null; }
  editingId = null;
}

function close() {
  closeCreate();
  closeEdit();
  if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
  if (release) { release(); release = null; }
  root?.remove();
  root = null;
}
