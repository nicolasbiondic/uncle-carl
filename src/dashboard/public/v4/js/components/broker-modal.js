// ── broker-modal.js — sleeve detail modal opened from a broker summary card
// (profiles.js). Same modal pattern as candle.js: backdrop, Escape, X, click-out.
import { store, t, periodLabel } from "../store.js";
import { money, moneySigned, pct, pctSigned, pnlColor, n, dur } from "../fmt.js";
import { esc, icon, byId } from "../ui.js";
import { statsById, brokerKey, BROKER_LABEL } from "./profiles.js";
import { sleeveExposure } from "./positions.js";
import { trapFocus } from "../focus-trap.js";
import { api } from "../api.js";

let root = null;
let release = null;

export function openBrokerModal(key, onSelect) {
  close();
  const accounts = (store.state.dashboard?.accounts || []).filter((a) => brokerKey(a.broker) === key);
  const stats = statsById(store.state.profiles);
  const positions = store.state.dashboard?.portfolio?.positions || [];
  const exposureById = new Map(sleeveExposure(positions, store.state.dashboard?.accounts || []).map((r) => [r.id, r]));
  const unrealizedById = unrealizedPnlBySleeve(positions);
  // Header total = the SAME broker-truth equity the card + header pill show — do
  // NOT re-sum per-sleeve equities here (that reintroduces the exact mismatch
  // the broker-truth fix removed). Fall back to the sleeve sum only if absent.
  const bt = (store.state.profiles || []).flatMap((p) => p.brokerAccounts || []).find((a) => String(a.brokerId || "").includes(key));
  const totalEquity = bt && bt.equity != null ? n(bt.equity) : accounts.reduce((s, a) => s + n(a.equity), 0);
  const name = BROKER_LABEL[key] || key;

  root = document.createElement("div");
  root.className = "cm-backdrop";
  root.innerHTML = `<div class="cm bm-modal" role="dialog" aria-modal="true" aria-label="${esc(name)}">
    <div class="cm-head">
      <b>${esc(name)}</b>
      <span class="muted">${money(totalEquity, 0)}</span>
      <span style="flex:1"></span>
      <button class="icn" data-bmclose aria-label="${t("Close", "Cerrar")}">${icon("x")}</button>
    </div>
    <div class="bm-list" id="bmList">${accounts.map((a) => row(a, stats[a.id], exposureById.get(a.id), unrealizedById.get(a.id), null)).join("") || `<div class="empty">${t("No sleeves", "Sin sleeves")}</div>`}</div>
  </div>`;
  document.body.appendChild(root);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-bmclose]")) return close();
    const r = e.target.closest("[data-sleeve]");
    if (r) { const id = r.dataset.sleeve; close(); onSelect(id); }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const r = e.target.closest?.("[data-sleeve]");
    if (r) { e.preventDefault(); const id = r.dataset.sleeve; close(); onSelect(id); }
  });
  document.addEventListener("keydown", escClose);
  release = trapFocus(root);

  // WHY-paused detail (cause, DD vs soft/hard thresholds, resume ETA) lands
  // one fetch after the first paint — /api/v2/sleeves/risk is a second
  // round-trip the modal doesn't need to block on. Re-render only the rows
  // still on screen (the modal may have been closed by the time this lands).
  api.sleeveRisk().then(({ sleeves } = {}) => {
    if (!root || !Array.isArray(sleeves)) return;
    const riskById = new Map(sleeves.map((s) => [s.id, s]));
    const list = byId("bmList");
    if (list) list.innerHTML = accounts.map((a) => row(a, stats[a.id], exposureById.get(a.id), unrealizedById.get(a.id), riskById.get(a.id))).join("");
  }).catch(() => {});
}

/** { profileId -> summed unrealizedPnl } across the currently open positions
 *  payload — same "priced() before summing" discipline as positions.js's
 *  positionsTotals (a missing price must not silently count as break-even). */
export function unrealizedPnlBySleeve(positions) {
  const out = new Map();
  for (const p of positions || []) {
    const id = p?.profileId;
    if (!id || !Number.isFinite(Number(p?.unrealizedPnl))) continue;
    out.set(id, (out.get(id) || 0) + Number(p.unrealizedPnl));
  }
  return out;
}

/** Small "12% / 20% soft-hard" bar — a filled segment at the current DD,
 *  soft/hard threshold ticks. Pure presentation, no fetch. */
function ddBar(ddPct, softPct, hardPct) {
  if (ddPct == null) return "";
  const clampPct = (x) => Math.max(0, Math.min(100, x * 100));
  const fillColor = ddPct >= hardPct ? "var(--down)" : ddPct >= softPct ? "var(--warn)" : "var(--up)";
  // Scale the bar to 1.2x the hard threshold so both ticks are visible even
  // when DD is currently small.
  const scale = Math.max(hardPct * 1.2, ddPct * 1.05, 0.01);
  return `<div style="position:relative;height:4px;background:var(--bg-2);border-radius:2px;margin-top:4px" title="${t("Drawdown vs soft/hard thresholds", "Drawdown vs umbrales soft/hard")}">
    <div style="position:absolute;inset:0 auto 0 0;width:${clampPct(ddPct / scale)}%;background:${fillColor};border-radius:2px"></div>
    <div style="position:absolute;top:-2px;bottom:-2px;left:${clampPct(softPct / scale)}%;width:1px;background:var(--warn)"></div>
    <div style="position:absolute;top:-2px;bottom:-2px;left:${clampPct(hardPct / scale)}%;width:1px;background:var(--down)"></div>
  </div>`;
}

/** The per-sleeve risk detail block: mode (live/shadow/paused), cause, DD vs
 *  soft/hard thresholds, resume ETA, utilization, realized vs unrealized P&L.
 *  `risk` is null until the async /api/v2/sleeves/risk fetch lands (first
 *  paint shows just the mode chip from `a.paused`, same as before);
 *  `unrealized` comes from the already-loaded positions payload, so it's
 *  available immediately, independent of that fetch. */
export function riskDetailHtml(a, exposure, unrealized, risk) {
  const parts = [];
  if (exposure) {
    const over = exposure.ratio != null && exposure.ratio >= 1;
    parts.push(`<span title="${t("Gross notional deployed vs allocation", "Nocional bruto desplegado vs asignación")}">${t("Util", "Uso")} <b style="color:${over ? "var(--down)" : "var(--text)"}">${exposure.ratio == null ? "—" : `${(exposure.ratio * 100).toFixed(0)}%`}</b></span>`);
  }
  if (risk) {
    const realized = n(risk.realizedPnl);
    parts.push(`<span>${t("Realized", "Realizado")} <b style="color:${pnlColor(realized)}">${moneySigned(realized)}</b></span>`);
  }
  if (Number.isFinite(unrealized)) parts.push(`<span>${t("Unrealized", "No realizado")} <b style="color:${pnlColor(unrealized)}">${moneySigned(unrealized)}</b></span>`);
  const metaLine = parts.length ? `<div class="muted" style="display:flex;gap:var(--s3);font-size:var(--t-xs);margin-top:4px">${parts.join("")}</div>` : "";

  if (!risk) return `<div style="flex-basis:100%;margin-top:2px">${metaLine}</div>`;

  const dd = risk.drawdown || {};
  const ddLine = dd.currentPct == null
    ? ""
    : `<div class="muted" style="font-size:var(--t-xs);margin-top:4px">DD <b style="color:${dd.currentPct >= dd.hardPct ? "var(--down)" : dd.currentPct >= dd.softPct ? "var(--warn)" : "var(--text)"}">${pct(dd.currentPct * 100, 1)}</b> <span class="muted">/ ${pct(dd.softPct * 100, 0)} soft · ${pct(dd.hardPct * 100, 0)} hard</span></div>${ddBar(dd.currentPct, dd.softPct, dd.hardPct)}`;

  const causeLine = a.paused && risk.reason
    ? `<div style="font-size:var(--t-xs);color:var(--warn);margin-top:4px">${esc(risk.reason)}${risk.resumeAt ? ` <span class="muted">· ${t("resumes in", "reanuda en")} ${dur(risk.resumeAt - Date.now())}</span>` : ""}</div>`
    : "";

  return `<div style="flex-basis:100%;margin-top:2px">${metaLine}${ddLine}${causeLine}</div>`;
}

function modeChip(a, risk) {
  const mode = risk?.mode ?? (a.paused ? "paused" : "live");
  if (mode === "paused") return `<span class="chip" style="color:var(--warn)">${t("PAUSED", "PAUSADO")}</span>`;
  if (mode === "shadow") return `<span class="chip" style="color:var(--muted)" title="${t("Shadow: simulated fills, zero capital at risk", "Shadow: llenados simulados, cero capital en riesgo")}">${t("SHADOW", "SHADOW")}</span>`;
  return `<span class="live"><span class="d"></span>LIVE</span>`;
}

function row(a, st, exposure, unrealized, risk) {
  const winRate = n(st?.winRate), closed = n(st?.closedTrades);
  const periodPnl = n(st?.periodEquityPnl ?? st?.todayPnl);
  const name = a.label || a.id;
  return `<div class="bm-row" data-sleeve="${esc(a.id)}" role="button" tabindex="0">
    <span class="bm-name"><b>${esc(name)}</b><span class="broker">${esc(a.broker || "")}</span></span>
    <span class="bm-metrics">
      <span>${money(a.equity, 0)}</span>
      <span style="color:${pnlColor(a.totalPnlPct)}">${pctSigned(a.totalPnlPct)}</span>
      <span>${esc(periodLabel(store.state.period))} <b style="color:${pnlColor(periodPnl)}">${moneySigned(periodPnl)}</b></span>
      <span>Win <b>${closed ? pct(winRate, 0) : "—"}</b></span>
      ${modeChip(a, risk)}
    </span>
    ${riskDetailHtml(a, exposure, unrealized, risk)}
  </div>`;
}

function escClose(e) { if (e.key === "Escape") close(); }
export function close() { if (root) { root.remove(); root = null; document.removeEventListener("keydown", escClose); release?.(); release = null; } }
