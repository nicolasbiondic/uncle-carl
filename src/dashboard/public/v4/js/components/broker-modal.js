// ── broker-modal.js — sleeve detail modal opened from a broker summary card
// (profiles.js). Same modal pattern as candle.js: backdrop, Escape, X, click-out.
import { store, t, periodLabel, sleeveLabel } from "../store.js";
import { money, pnlWhole, pct, pctSigned, pnlColor, n, dur } from "../fmt.js";
import { esc, icon, byId } from "../ui.js";
import { statsById, brokerKey, BROKER_LABEL } from "./profiles.js";
import { sleeveExposure, exposurePhrase } from "./positions.js";
import { reasonWord } from "./botnow.js";
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
    <div class="bm-list" id="bmList">${accounts.map((a) => row(a, stats[a.id], exposureById.get(a.id), unrealizedById.get(a.id), null)).join("") || `<div class="empty">${t("No portfolios", "Sin portafolios")}</div>`}</div>
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

/** The pause cause in plain words, from the engine's own sentence (which is
 *  never printed): "" when it matches no known cause. */
export function pauseCause(reason) {
  const r = String(reason || "");
  const code = /soft.drawdown/i.test(r) ? "soft_drawdown" : /hard.drawdown/i.test(r) ? "hard_drawdown"
    : /consecutive|loss.streak/i.test(r) ? "loss_streak" : /daily.loss|daily.cap/i.test(r) ? "daily_cap"
    : /maintenance|trading_disabled|close-only/i.test(r) ? "maintenance" : "";
  return code ? reasonWord(code) : "";
}

/** The per-sleeve detail block: exposure against the sleeve's own cap,
 *  realized vs unrealized P&L, how far below its peak it is (a measure — the
 *  owner's rule is that drawdown is a cost, not a limit, so no thresholds and
 *  no alarm colour) and, when paused, the cause and the resume ETA. `risk` is
 *  null until the async /api/v2/sleeves/risk fetch lands; `unrealized` comes
 *  from the already-loaded positions payload. Anything unknown reads "—". */
export function riskDetailHtml(a, exposure, unrealized, risk) {
  const parts = [];
  if (exposure) {
    const xp = exposurePhrase(exposure);
    parts.push(`<span title="${esc(t("Open positions at market value against the sleeve's own cap", "Posiciones abiertas a precio de mercado frente al tope del propio sleeve"))}">${t("Invested", "Invertido")} <b${xp?.color ? ` style="color:${xp.color}"` : ""}>${xp ? esc(xp.body) : "—"}</b></span>`);
  }
  if (risk) {
    parts.push(`<span>${t("Realized", "Realizado")} <b style="color:${risk.realizedPnl == null ? "var(--muted)" : pnlColor(risk.realizedPnl)}">${risk.realizedPnl == null ? "—" : pnlWhole(risk.realizedPnl)}</b></span>`);
  }
  if (Number.isFinite(unrealized)) parts.push(`<span>${t("Open, since entry", "Sin cerrar (desde la entrada)")} <b style="color:${pnlColor(unrealized)}">${pnlWhole(unrealized)}</b></span>`);
  if (risk) {
    const dd = risk.drawdown?.currentPct;
    parts.push(`<span title="${esc(t("Distance below the sleeve's highest equity. A measure, not a limit.", "Distancia bajo el máximo de patrimonio del sleeve. Una medida, no un límite."))}">${t("Below peak", "Bajo máximo")} <b>${Number.isFinite(dd) ? pct(dd * 100, 1) : "—"}</b></span>`);
  }
  const metaLine = parts.length ? `<div class="muted" style="display:flex;flex-wrap:wrap;gap:var(--s3);font-size:var(--t-xs);margin-top:4px">${parts.join("")}</div>` : "";
  if (!risk) return `<div style="flex-basis:100%;margin-top:2px">${metaLine}</div>`;

  const cause = a.paused ? pauseCause(risk.reason) : "";
  const eta = a.paused && risk.resumeAt ? `${t("resumes in", "reanuda en")} ${dur(risk.resumeAt - Date.now())}` : "";
  const causeLine = cause || eta
    ? `<div style="font-size:var(--t-xs);color:var(--warn);margin-top:4px">${esc([cause ? cap1(cause) : "", eta].filter(Boolean).join(" · "))}</div>`
    : "";
  return `<div style="flex-basis:100%;margin-top:2px">${metaLine}${causeLine}</div>`;
}
const cap1 = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);

/** The venue in words (never the engine's id). */
export function venueLabel(broker) {
  return { alpaca: "Alpaca", binance: "Binance USDT-M", binance_usdc: "Binance USDC-M", binance_coinm: "Binance COIN-M" }[broker] || BROKER_LABEL[brokerKey(broker)] || "";
}

function modeChip(a, risk) {
  const mode = risk?.mode ?? (a.paused ? "paused" : "live");
  if (mode === "paused") return `<span class="chip" style="color:var(--warn)">${t("PAUSED", "PAUSADO")}</span>`;
  return `<span class="live"><span class="d"></span>${t("LIVE", "EN VIVO")}</span>`;
}

function row(a, st, exposure, unrealized, risk) {
  const winRate = n(st?.winRate), closed = n(st?.closedTrades);
  // The window's equity P&L or nothing: never today's realized P&L under another window's label.
  const periodPnl = st?.periodEquityPnl;
  const name = sleeveLabel(a);
  return `<div class="bm-row" data-sleeve="${esc(a.id)}" role="button" tabindex="0">
    <span class="bm-name"><b>${esc(name)}</b><span class="broker muted">${esc(venueLabel(a.broker))}</span></span>
    <span class="bm-metrics">
      <span>${money(a.equity, 0)}</span>
      <span style="color:${pnlColor(a.totalPnlPct)}">${pctSigned(a.totalPnlPct)}</span>
      <span>${esc(periodLabel(store.state.period))} <b style="color:${periodPnl == null ? "var(--muted)" : pnlColor(periodPnl)}">${periodPnl == null ? "—" : pnlWhole(periodPnl)}</b></span>
      <span>${t("Win", "Ganadas")} <b>${closed ? pct(winRate, 0) : "—"}</b></span>
      ${modeChip(a, risk)}
    </span>
    ${riskDetailHtml(a, exposure, unrealized, risk)}
  </div>`;
}

function escClose(e) { if (e.key === "Escape") close(); }
export function close() { if (root) { root.remove(); root = null; document.removeEventListener("keydown", escClose); release?.(); release = null; } }
