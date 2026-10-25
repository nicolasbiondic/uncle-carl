import { store, t, isEs, sleeveLabel } from "../store.js";
import { api } from "../api.js";
import { moneySigned, pnlWhole, pct, pctSigned, pctFrac, pnlColor, n, num, etDateTime } from "../fmt.js";
import { byId, esc } from "../ui.js";
import { windowSeg } from "./kpis.js";
import { fitTablesIn } from "../fit.js";

// Consolidated from 11 → 7. Portfolio dropped (duplicated the Positions card);
// Hours/Symbols/P&L Source/Tearsheet merged into one "Performance" deep-dive.
// "Volume" (2026-10-12): the decision funnel (funnel.js), formerly a card under
// Positions/Trades that crushed that table in the viewport-locked layout.
// "Bot" (2026-10-25, first and default): what each portfolio is doing, in
// sentences — the owner: "tengo que saber qué está haciendo el bot".
const TABS = () => [
  ["bot", "Bot"],
  ["equity", t("Equity", "Curva")],
  ["performance", t("Performance", "Rendimiento")],
  ["volume", t("Volume", "Volumen")],
  ["activity", t("Activity", "Actividad")],
];

// Old persisted tab ids → their new home (so a saved tab doesn't render blank).
const TAB_MIGRATE = { portfolio: "equity", hours: "performance", symbols: "performance", pnlattr: "performance", tearsheet: "performance" };

export function renderAnalyticsShell() {
  const cur = TAB_MIGRATE[store.state.tab] || store.state.tab;
  const tabs = TABS().map(([id, label]) => `<button class="tab ${cur === id ? "on" : ""}" data-atab="${id}">${label}</button>`).join("");
  const windowHtml = cur === "equity" ? `<span class="an-window"><span class="an-window-l">${t("Window", "Ventana")}</span>${windowSeg(store.state.period)}</span>` : "";
  return `<div class="an-head"><div class="tabs">${tabs}</div>${windowHtml}</div><div class="cardbody" id="anBody"><div class="empty">…</div></div>`;
}

export async function loadTab() {
  const body = byId("anBody");
  if (!body) return;
  if (TAB_MIGRATE[store.state.tab]) store.set({ tab: TAB_MIGRATE[store.state.tab] });
  const tab = store.state.tab;
  try {
    if (tab === "equity") { const { loadEquity } = await import("./equity.js"); await loadEquity("anBody"); return; }
    // Leaving the equity tab: #anBody's node the chart lived in is about to
    // be replaced by the innerHTML writes below either way — dispose the
    // lightweight-charts instance explicitly first (see equity.js
    // destroyEquityChart: a detached container keeps no reference of its
    // own to clean up after itself).
    const { destroyEquityChart } = await import("./equity.js");
    destroyEquityChart();
    if (tab === "bot") { const { loadBotNow } = await import("./botnow.js"); await loadBotNow(body); }
    else if (tab === "performance") { body.innerHTML = await performance(); fitTablesIn(body); rememberOpenRows(body); }
    else if (tab === "volume") {
      const { renderFunnelPanel, loadFunnel } = await import("./funnel.js");
      body.innerHTML = renderFunnelPanel();
      await loadFunnel();
    }
    else if (tab === "activity") body.innerHTML = activity(await api.activity(60));
  } catch (e) { body.innerHTML = `<div class="empty">${t("Could not load", "No se pudo cargar")}: ${esc(e.message)}</div>`; }
}

// Performance: one plain-language line per portfolio (return vs its benchmark,
// worst drop; the statistics fold under each line), then monthly returns and
// the drawdown of the whole account, then where the P&L comes from, by symbol
// and by hour. Execution stats (slippage, latency) live in the Volume tab
// since 2026-10-25 — they are about execution, not performance.
async function performance() {
  const period = store.state.period === 0 ? 90 : Math.max(7, store.state.period);
  const [sc, ts, pnl, sym, hrs] = await Promise.all([
    api.scorecard(),
    tearsheet(),
    api.pnlAttribution(365).catch(() => null),
    api.symbolsAnalytics(period).catch(() => null),
    api.hourly(period).catch(() => null),
  ]);
  const sep = `<div style="border-top:1px solid var(--border);margin:var(--s4) 0"></div>`;
  return scorecard(sc) + sep + ts + sep + pnlAttr(pnl) + sep
    + `<div class="an-h">${t("By symbol", "Por símbolo")} <span class="muted">(${period}d)</span></div>` + symbols(sym) + sep
    + `<div class="muted">${t("Closed trades in this window", "Cierres en esta ventana")} (${period}d)</div>`
    + hours(hrs);
}

// ── Scorecard (W5): one line per live sleeve — return vs benchmark on the
// SAME dates, worst drop; OLS alpha, Sharpe and the OOS expectation band
// (block bootstrap over the validated pure chain; "below" = automatic
// "worse than validated" signal) fold under the line. Window shown: since
// the current model's start when it has data, else 30d. Exported for tests.
export function scorecardWindow(e) {
  const model = (e.windows || []).find((w) => w.window === "model");
  if (model && model.totalReturnPct != null) return model;
  return (e.windows || []).find((w) => w.window === "30d") || model || null;
}

/** "since Sep 25" / "last 30 days" — the window in words. Exported for tests. */
export function windowLabel(w, modelStart) {
  if (w.window === "model") {
    const d = modelStart ? new Date(`${modelStart}T12:00:00Z`) : null;
    if (d && !Number.isNaN(d.getTime())) {
      const day = d.toLocaleDateString(isEs() ? "es" : "en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      return `${t("since", "desde")} ${day}`;
    }
    return t("since the current model", "desde el modelo actual");
  }
  const days = parseInt(w.window, 10);
  if (Number.isFinite(days)) return t(`last ${days} days`, `últimos ${days} días`);
  return String(w.window);
}

/** The benchmark in words a reader knows. Exported for tests. */
export function benchmarkName(symbol) {
  const names = { SPY: "S&P 500", QQQ: "Nasdaq 100", IWM: "Russell 2000", "BTC/USD": "Bitcoin", "ETH/USD": "Ether" };
  return names[symbol] || String(symbol || "").replace("/USD", "");
}

const BAND_LABEL = () => ({
  below: t("below the expected band", "por debajo de la banda esperada"),
  within: t("within the expected band", "dentro de la banda esperada"),
  above: t("above the expected band", "por encima de la banda esperada"),
  unavailable: t("band unavailable", "banda no disponible"),
});

function bandChip(band) {
  if (!band) return `<span class="muted">—</span>`;
  if (band.status === "insufficient_data") return `<span class="muted" title="${esc(band.reason || t("Not enough live data to evaluate the band", "Sin datos de vivo suficientes para evaluar la banda"))}">—</span>`;
  const label = BAND_LABEL()[band.status] || band.status;
  const color = band.status === "below" ? "var(--down)" : band.status === "above" ? "var(--up)" : "var(--muted, inherit)";
  const adjusted = band.selectionBias
    ? ` · ${t("adjusted for universe selection bias", "ajustada por sesgo de selección")} −${band.selectionBias.sharpeHaircut.toFixed(2)} Sharpe`
    : "";
  const tip = band.cumReturnPct
    ? `h=${n(band.horizonSessions)} · p5 ${pctSigned(band.cumReturnPct.p5)} · p50 ${pctSigned(band.cumReturnPct.p50)} · p95 ${pctSigned(band.cumReturnPct.p95)}${adjusted}`
    : (band.reason || "");
  return `<span class="mchip" title="${esc(tip)}" style="color:${color};border-color:${color};white-space:nowrap">${esc(label)}</span>`;
}

// Compact real-execution-cost cell (additive `costs` block of
// /api/v2/scorecard — src/reports/costCalibration.ts): real mean cost per
// side + n vs the sim's assumption, margin to break-even; full verdict in
// the tooltip. Exported for tests.
export function costCell(c) {
  if (!c || !c.measured) return `<span class="muted">—</span>`;
  const m = c.measured, be = c.breakEven;
  const real = `${num(m.totalPerSideBps, 1)}bps <span class="muted" style="font-size:var(--t-xs)">n=${n(m.n)}</span>`;
  const vs = c.assumed ? ` <span class="muted">vs ${num(c.assumed.totalPerSideBps, 0)}</span>` : "";
  let margin = "";
  if (be && m.n >= 10) {
    if (be.measuredOutOfCurveRange) margin = ` <span style="color:${be.outOfRangeDirection === "above" ? "var(--down)" : "var(--up)"}">${be.outOfRangeDirection === "above" ? "⚠" : "✓"}</span>`;
    else if (be.marginBps != null) margin = ` <span class="muted" style="font-size:var(--t-xs)">${t("margin", "margen")} ${num(be.marginBps, 0)}</span>`;
    else if (be.marginAtLeastBps != null) margin = ` <span class="muted" style="font-size:var(--t-xs)">${t("margin", "margen")} ≥${num(be.marginAtLeastBps, 0)}</span>`;
  }
  return `<span title="${esc(c.verdict || "")}" style="white-space:nowrap">${real}${vs}${margin}</span>`;
}

/** Which portfolio lines the reader has unfolded; survives the 30 s refresh
 *  (the tab is rebuilt from scratch each time). Session only. */
const openRows = new Set();
function rememberOpenRows(body) {
  for (const d of body?.querySelectorAll?.("details.sc-row") ?? []) {
    d.addEventListener("toggle", () => { if (d.open) openRows.add(d.dataset.sc); else openRows.delete(d.dataset.sc); });
  }
}

export function scorecard(sc) {
  if (!sc?.entities?.length) return `<div class="empty">${t("Scorecard unavailable", "Scorecard no disponible")}</div>`;
  const costBySleeve = {};
  for (const c of sc.costs?.sleeves || []) costBySleeve[c.sleeve] = c;
  const dash = `<span class="muted">—</span>`;
  const rows = sc.entities.filter((e) => e.kind === "sleeve").map((e) => {
    const w = scorecardWindow(e);
    if (!w) return "";
    const bench = benchmarkName(e.benchmarkSymbol);
    const win = windowLabel(w, e.modelStart);
    // Tearsheet of the sleeve's authoritative artifact (only when one exists).
    const tsLink = e.band?.artifactDir
      ? `<a href="/api/v2/tearsheet/${encodeURIComponent(e.id)}" target="_blank" rel="noopener">${t("Backtest tearsheet", "Tearsheet del backtest")}</a>`
      : "";
    const stat = (label, value) => `<span class="sc-stat"><span class="sc-l">${label}</span> ${value}</span>`;
    return `<details class="sc-row" data-sc="${esc(e.id)}"${openRows.has(e.id) ? " open" : ""}>
      <summary title="${esc(t("Return vs its benchmark on the same dates. Click for Sharpe, alpha, band and costs.", "Retorno frente a su referencia en las mismas fechas. Clic para Sharpe, alfa, banda y costes."))}">
        <span class="sc-name">${esc(sleeveLabel(e))} <span class="sc-win">${esc(win)}</span></span>
        <span class="sc-ret" style="color:${pnlColor(w.totalReturnPct)}">${w.totalReturnPct == null ? "—" : pctSigned(w.totalReturnPct)}</span>
        <span class="sc-bench">${w.benchmark?.totalReturnPct == null ? dash : `<span class="sc-l">${esc(bench)}</span> ${pctSigned(w.benchmark.totalReturnPct)}`}</span>
        <span class="sc-dd">${w.maxDrawdownPct == null ? dash : `<span class="sc-l">${t("worst drop", "peor caída")}</span> ${w.maxDrawdownPct === 0 ? pct(0, 1) : pctSigned(-Math.abs(w.maxDrawdownPct), 1)}`}</span>
        <span class="sc-chev" aria-hidden="true"></span>
      </summary>
      <div class="sc-more">
        ${stat("Sharpe", w.sharpe == null ? "—" : num(w.sharpe, 2))}
        ${stat(t("Alpha per year", "Alfa anual"), w.alphaAnnPct == null ? "—" : pctSigned(w.alphaAnnPct))}
        ${stat(t("Vs the backtest", "Frente al backtest"), bandChip(e.band))}
        ${stat(t("Costs per side", "Costes por lado"), costCell(costBySleeve[e.id]))}
        ${tsLink}
      </div>
    </details>`;
  }).join("");
  return `<div class="an-h" title="${esc(t(
      "Few weeks of live data certify nothing; the band detects breakage vs the validated OOS distribution, it does not prove alpha.",
      "Con pocas semanas de vivo ninguna métrica certifica edge; la banda detecta roturas frente al OOS validado, no prueba alpha."))}">${t("Each portfolio against its benchmark", "Cada portafolio frente a su referencia")}</div>
    <div class="sc-list">${rows}</div>`;
}

function activity(items) {
  if (!items?.length) return `<div class="empty">${t("No recent activity", "Sin actividad reciente")}</div>`;
  return `<div class="scroll" style="max-height:420px;font-family:var(--mono);font-size:var(--t-xs)">${items.map((a) => `<div style="padding:3px 0;border-bottom:1px solid var(--border)"><span class="muted">[${esc(etDateTime(a.created_at))}]</span> ${a.account_id ? `<span class="muted">[${esc(a.account_id)}]</span> ` : ""}${esc(a.message)}</div>`).join("")}</div>`;
}

function hours(data) {
  if (!data?.length) return `<div class="empty">${t("Not enough data", "Sin datos suficientes")}</div>`;
  const max = Math.max(...data.map((h) => Math.abs(n(h.avgPnl))), 0.01);
  const bars = data.map((h) => {
    const v = n(h.avgPnl), pctH = Math.abs(v) / max * 100, up = v >= 0;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px" title="${h.hour}:00 ET · ${moneySigned(v)} · ${n(h.tradeCount)} trades">
      <div style="height:70px;width:100%;display:flex;align-items:flex-end;justify-content:center"><div style="width:60%;height:${pctH}%;background:${up ? "var(--up)" : "var(--down)"};border-radius:2px 2px 0 0"></div></div>
      <span class="muted" style="font-size:9px">${h.hour}</span></div>`;
  }).join("");
  return `<div class="an-h">${t("Average P&L by hour (ET)", "P&L medio por hora (ET)")}</div><div style="display:flex;gap:2px;align-items:flex-end">${bars}</div>`;
}

function symbols(data) {
  if (!data?.length) return `<div class="empty">${t("No symbol data", "Sin datos por símbolo")}</div>`;
  const rows = data.slice(0, 20).map((s) => `<tr><td>${esc(s.symbol)}</td><td>${n(s.tradeCount)}</td><td style="color:${n(s.winRate) >= .5 ? "var(--up)" : "var(--text)"}">${pctFrac(s.winRate)}</td><td style="color:${pnlColor(s.totalPnl)}">${moneySigned(s.totalPnl)}</td></tr>`).join("");
  return `<div class="scroll"><table><thead><tr><th>${t("Symbol", "Símbolo")}</th><th>${t("Trades", "Trades")}</th><th>Win</th><th>P&L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function pnlAttr(d) {
  if (!d?.buckets) return `<div class="empty">${t("No data", "Sin datos")}</div>`;
  const label = { algo: t("Strategy trades", "Operaciones de la estrategia"), reconcile: t("Broker corrections", "Correcciones del bróker"), sync: t("Positions recovered from the broker", "Posiciones recuperadas del bróker") };
  const tip = { algo: t("Closed strategy trades; not proof of an edge.", "Operaciones cerradas de las estrategias; no demuestra una ventaja."), reconcile: t("Rows closed to match the broker; some P&L values are placeholders.", "Filas cerradas para cuadrar con el bróker; algunos P&L son provisionales."), sync: t("Positions imported by broker synchronization or recovery, not opened by a strategy.", "Posiciones importadas al sincronizar o recuperar el bróker, no abiertas por una estrategia.") };
  const rows = d.buckets.map((b) => `<tr><td title="${esc(tip[b.bucket] || "")}">${label[b.bucket] || esc(b.bucket)}</td><td>${n(b.trades)}</td><td>${pctFrac(b.winRate)}</td><td style="color:${pnlColor(b.totalPnl)}">${pnlWhole(b.totalPnl)}</td><td>${b.profitFactor == null ? "∞" : num(b.profitFactor, 2)}</td></tr>`).join("");
  return `<div class="an-h" title="${esc(t("Closed-trade P&L of the current sleeves, including corrections and recovered positions. Not the change in account equity or a measure of strategy edge.", "P&L de cierres de las carteras actuales, incluidas correcciones y posiciones recuperadas. No es el cambio de patrimonio ni una medida de la ventaja de la estrategia."))}">${t("Where the P&L comes from", "De dónde viene el P&L")}</div>
    <div class="scroll"><table><thead><tr><th>${t("Source", "Fuente")}</th><th>${t("Trades", "Trades")}</th><th>Win</th><th>P&L</th><th>PF</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div style="margin-top:var(--s2);color:${pnlColor(d.netPnl)}">${t("Net", "Neto")}: <b>${pnlWhole(d.netPnl)}</b> <span class="muted">(${n(d.windowDays)}d)</span></div>`;
}

// "Monthly returns" used to hard-bind to binance_main regardless of what the
// dashboard is showing (2026-09-24 audit fix: item 2). Options = every
// broker leg + every live sleeve — built from the SAME dashboard.accounts
// list the rest of the UI derives its sleeve set from (no hardcoded id
// table). Selection persists across tab switches for this session only
// (not localStorage — it's a deep-dive detail, not a global preference).
let mrProfile = null;

/** Pure: broker legs + live sleeves, in that order, deduped. Exported for
 *  testing without the DOM/store. */
export function monthlyReturnsOptions(accounts) {
  const brokers = [...new Set((accounts || []).map((a) => String(a.broker || "").split("_")[0]))].filter(Boolean);
  const brokerOpts = brokers.map((b) => ({ id: `${b}_main`, label: b === "binance" ? "Binance (FAPI)" : b[0].toUpperCase() + b.slice(1) }));
  const sleeveOpts = (accounts || []).map((a) => ({ id: a.id, label: sleeveLabel(a) }));
  return [...brokerOpts, ...sleeveOpts];
}

/** Resolves the profile to display: an explicit user pick (mrProfile) wins;
 *  otherwise a selected sleeve view binds directly to it (a reader looking
 *  at momentum_crypto shouldn't see binance_main's blended returns), and the
 *  consolidated view shows a WHOLE broker account — the first `*_main` leg
 *  (Alpaca, where most of the capital sits; owner 2026-10-25) — never a
 *  single sleeve by default. */
export function resolveMonthlyReturnsProfile(explicit, view, options) {
  if (explicit && options.some((o) => o.id === explicit)) return explicit;
  if (view && view !== "consolidated" && options.some((o) => o.id === view)) return view;
  return options.find((o) => /_main$/.test(o.id))?.id ?? options[0]?.id ?? "binance_main";
}

export function setMonthlyReturnsProfile(id) { mrProfile = id; }

/** "2026-10" -> "Oct" (localized); the full key rides in the title. */
export function monthShort(key) {
  const m = /^(\d{4})-(\d{2})/.exec(String(key || ""));
  if (!m) return String(key || "");
  return new Date(Date.UTC(+m[1], +m[2] - 1, 15)).toLocaleDateString(isEs() ? "es" : "en-US", { month: "short", timeZone: "UTC" });
}

export async function tearsheet() {
  const options = monthlyReturnsOptions(store.state.dashboard?.accounts);
  const profile = resolveMonthlyReturnsProfile(mrProfile, store.state.view, options);
  const [mr, dd] = await Promise.all([api.monthlyReturns(profile, 12), api.drawdown(profile, 90)]);
  const months = (mr || []).map((m) => `<span class="mr-m" title="${esc(m.month || "")}"><span class="sc-l">${esc(monthShort(m.month))}</span><b style="color:${pnlColor(m.pct)}">${pctSigned(m.pct)}</b></span>`).join("") || `<span class="muted">${t("not enough data yet", "aún sin datos suficientes")}</span>`;
  let ddHtml = "";
  if (Array.isArray(dd) && dd.length > 1) {
    const W = 320, H = 44, N = dd.length, worst = Math.min(0, ...dd.map((d) => d.dd)), min = Math.min(worst, -0.01);
    const X = (i) => (i / (N - 1)) * W, Y = (v) => 1 + (v / min) * (H - 2);
    let line = `M ${X(0).toFixed(1)} ${Y(dd[0].dd).toFixed(1)}`;
    for (let i = 1; i < N; i++) line += ` L ${X(i).toFixed(1)} ${Y(dd[i].dd).toFixed(1)}`;
    ddHtml = `<div class="an-h" style="margin-top:var(--s3)" title="${esc(t("Distance below the running peak of daily closing marks within the last 90 days (not intraday peaks).", "Distancia al máximo de los cierres diarios dentro de los últimos 90 días (no máximos intradía)."))}">${t("Drop from peak, last 90 days", "Caída desde máximos, últimos 90 días")} <span class="muted">${t("worst", "peor")} ${pct(worst, 1)}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:44px"><path d="${line} L ${W} 1 Z" fill="var(--down-soft)"/><path d="${line}" fill="none" stroke="var(--down)" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>`;
  }
  // Compact switch: a native select (six segmented buttons took a whole row).
  const picker = options.length > 1
    ? `<select class="mr-pick" data-mr aria-label="${esc(t("Account or portfolio", "Cuenta o portafolio"))}">${options.map((o) => `<option value="${esc(o.id)}"${o.id === profile ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`
    : `<span class="muted">${esc(options[0]?.label || profile)}</span>`;
  return `<div class="an-h" style="display:flex;align-items:center;flex-wrap:wrap;gap:var(--s2)" title="${esc(t("Month-end equity changes across model versions; the current month is month to date.", "Variaciones del patrimonio entre fines de mes, a través de versiones; el mes actual es parcial."))}">${t("Monthly returns", "Retornos mensuales")}${picker}</div><div class="mr-row">${months}</div>${ddHtml}`;
}
