import { store, t } from "../store.js";
import { api } from "../api.js";
import { moneySigned, pct, pctSigned, pctFrac, pnlColor, n, num, etDateTime } from "../fmt.js";
import { byId, esc } from "../ui.js";
import { windowSeg } from "./kpis.js";

// Consolidated from 11 → 7. Portfolio dropped (duplicated the Positions card);
// Hours/Symbols/P&L Source/Tearsheet merged into one "Performance" deep-dive.
const TABS = () => [
  ["equity", t("Equity", "Curva")],
  ["performance", t("Performance", "Rendimiento")],
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
    if (tab === "performance") body.innerHTML = await performance();
    else if (tab === "activity") body.innerHTML = activity(await api.activity(60));
  } catch (e) { body.innerHTML = `<div class="empty">${t("Could not load", "No se pudo cargar")}: ${esc(e.message)}</div>`; }
}

// Performance deep-dive: scorecard + tearsheet summary + P&L source +
// by-symbol + by-hour, stacked (each sub-renderer carries its own header).
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
    + `<div class="card-note" style="margin-bottom:var(--s2)">${t("By symbol", "Por símbolo")}</div>` + symbols(sym) + sep
    + hours(hrs);
}

// ── Scorecard (W5): one row per live sleeve — return vs benchmark on the
// SAME dates, OLS alpha, Sharpe, maxDD, and the OOS expectation-band chip
// (block bootstrap over the validated pure chain; "below" = automatic
// "worse than validated" signal). Window shown: since the current model's
// start when it has data, else 30d (labelled). Exported for tests.
export function scorecardWindow(e) {
  const model = (e.windows || []).find((w) => w.window === "model");
  if (model && model.totalReturnPct != null) return model;
  return (e.windows || []).find((w) => w.window === "30d") || model || null;
}

const BAND_LABEL = () => ({
  below: t("BELOW band", "POR DEBAJO"), within: t("within band", "dentro"),
  above: t("above band", "por encima"),
  insufficient_data: t("insufficient data", "datos insuficientes"),
  unavailable: t("unavailable", "no disponible"),
});

function bandChip(band) {
  if (!band) return `<span class="muted">—</span>`;
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

export function scorecard(sc) {
  if (!sc?.entities?.length) return `<div class="empty">${t("Scorecard unavailable", "Scorecard no disponible")}</div>`;
  const costBySleeve = {};
  for (const c of sc.costs?.sleeves || []) costBySleeve[c.sleeve] = c;
  const rows = sc.entities.filter((e) => e.kind === "sleeve").map((e) => {
    const w = scorecardWindow(e);
    if (!w) return "";
    const bench = e.benchmarkSymbol.replace("/USD", "");
    const winLabel = w.window === "model" ? `${t("model", "modelo")} ${e.modelStart || ""}` : w.window;
    // Tearsheet of the sleeve's authoritative artifact (only when one exists).
    const tsLink = e.band?.artifactDir
      ? ` <a href="/api/v2/tearsheet/${encodeURIComponent(e.id)}" target="_blank" rel="noopener" style="font-size:var(--t-xs)">tearsheet</a>`
      : "";
    return `<tr><td>${esc(e.label)} <span class="muted" style="font-size:var(--t-xs)">${esc(winLabel)}</span>${tsLink}</td>
      <td style="color:${pnlColor(w.totalReturnPct)}">${w.totalReturnPct == null ? "—" : pctSigned(w.totalReturnPct)}</td>
      <td>${w.benchmark?.totalReturnPct == null ? "—" : `${esc(bench)} ${pctSigned(w.benchmark.totalReturnPct)}`}</td>
      <td>${w.alphaAnnPct == null ? "—" : pctSigned(w.alphaAnnPct)}</td>
      <td>${w.sharpe == null ? "—" : num(w.sharpe, 2)}</td>
      <td>${w.maxDrawdownPct == null ? "—" : pctSigned(-w.maxDrawdownPct, 1)}</td>
      <td>${bandChip(e.band)}</td>
      <td>${costCell(costBySleeve[e.id])}</td></tr>`;
  }).join("");
  return `<div class="card-note" style="margin-bottom:var(--s2)">${t("Scorecard — live vs validated backtest", "Scorecard — vivo vs backtest validado")}</div>
    <div class="scroll"><table><thead><tr><th>Sleeve</th><th>${t("Return", "Retorno")}</th><th>Benchmark</th><th>α (${t("ann.", "anual")})</th><th>Sharpe</th><th>maxDD</th><th>${t("Band", "Banda")}</th><th>${t("Costs", "Costes")}</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted" style="margin-top:var(--s2);font-size:var(--t-xs)">${t(
      "Few weeks of live data certify nothing; the band detects breakage vs the validated OOS distribution, it does not prove alpha.",
      "Con pocas semanas de vivo ninguna métrica certifica edge; la banda detecta roturas frente al OOS validado, no prueba alpha.")}</div>`;
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
  return `<div class="card-note" style="margin-bottom:var(--s2)">${t("Avg P&L by hour (ET)", "P&L medio por hora (ET)")}</div><div style="display:flex;gap:2px;align-items:flex-end">${bars}</div>`;
}

function symbols(data) {
  if (!data?.length) return `<div class="empty">${t("No symbol data", "Sin datos por símbolo")}</div>`;
  const rows = data.slice(0, 20).map((s) => `<tr><td>${esc(s.symbol)}</td><td>${n(s.tradeCount)}</td><td style="color:${n(s.winRate) >= .5 ? "var(--up)" : "var(--text)"}">${pctFrac(s.winRate)}</td><td style="color:${pnlColor(s.totalPnl)}">${moneySigned(s.totalPnl)}</td></tr>`).join("");
  return `<div class="scroll"><table><thead><tr><th>${t("Symbol", "Símbolo")}</th><th>${t("Trades", "Trades")}</th><th>Win</th><th>P&L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function pnlAttr(d) {
  if (!d?.buckets) return `<div class="empty">${t("No data", "Sin datos")}</div>`;
  const label = { algo: t("Algorithm edge", "Edge del algoritmo"), reconcile: t("Reconcile", "Reconciliado"), sync: t("Broker sync", "Sync broker") };
  const rows = d.buckets.map((b) => `<tr><td>${label[b.bucket] || b.bucket}</td><td>${n(b.trades)}</td><td>${pctFrac(b.winRate)}</td><td style="color:${pnlColor(b.totalPnl)}">${moneySigned(b.totalPnl)}</td><td>${b.profitFactor == null ? "∞" : num(b.profitFactor, 2)}</td></tr>`).join("");
  return `<div class="card-note" style="margin-bottom:var(--s2)">${t("Where the P&L comes from: real algo edge vs broker-sync reconciliation", "De dónde viene el P&L: edge real del algoritmo vs reconciliación del broker")}</div>
    <div class="scroll"><table><thead><tr><th>${t("Source", "Fuente")}</th><th>${t("Trades", "Trades")}</th><th>Win</th><th>P&L</th><th>PF</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div style="margin-top:var(--s2);color:${pnlColor(d.netPnl)}">${t("Net", "Neto")}: <b>${moneySigned(d.netPnl)}</b> <span class="muted">(${n(d.windowDays)}d)</span></div>`;
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
  const brokerOpts = brokers.map((b) => ({ id: `${b}_main`, label: b[0].toUpperCase() + b.slice(1) }));
  const sleeveOpts = (accounts || []).map((a) => ({ id: a.id, label: a.label || a.id }));
  return [...brokerOpts, ...sleeveOpts];
}

/** Resolves the profile to display: an explicit user pick (mrProfile) wins;
 *  otherwise a selected sleeve view binds directly to it (a reader looking
 *  at momentum_crypto shouldn't see binance_main's blended returns), and the
 *  consolidated view falls back to the first available option (was always
 *  "binance_main" before — same default when it's still present). */
export function resolveMonthlyReturnsProfile(explicit, view, options) {
  if (explicit && options.some((o) => o.id === explicit)) return explicit;
  if (view && view !== "consolidated" && options.some((o) => o.id === view)) return view;
  return options.find((o) => o.id === "binance_main")?.id ?? options[0]?.id ?? "binance_main";
}

export function setMonthlyReturnsProfile(id) { mrProfile = id; }

async function tearsheet() {
  const options = monthlyReturnsOptions(store.state.dashboard?.accounts);
  const profile = resolveMonthlyReturnsProfile(mrProfile, store.state.view, options);
  const [mr, dd, sl] = await Promise.all([api.monthlyReturns(profile, 12), api.drawdown(profile, 90), api.slippage()]);
  const months = (mr || []).map((m) => `<span class="mchip"><span class="l">${esc((m.month || "").slice(5))}</span><b style="color:${pnlColor(m.pct)}">${pctSigned(m.pct)}</b></span>`).join("") || `<span class="muted">${t("not enough data", "sin datos suficientes")}</span>`;
  let ddHtml = "";
  if (Array.isArray(dd) && dd.length > 1) {
    const W = 320, H = 44, N = dd.length, min = Math.min(...dd.map((d) => d.dd), -0.01);
    const X = (i) => (i / (N - 1)) * W, Y = (v) => 1 + (v / min) * (H - 2);
    let line = `M ${X(0).toFixed(1)} ${Y(dd[0].dd).toFixed(1)}`;
    for (let i = 1; i < N; i++) line += ` L ${X(i).toFixed(1)} ${Y(dd[i].dd).toFixed(1)}`;
    ddHtml = `<div class="card-note" style="margin-top:var(--s3)">${t("Drawdown (underwater)", "Drawdown")} · ${t("max", "máx")} ${pct(min, 1)}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:44px"><path d="${line} L ${W} 1 Z" fill="var(--down-soft)"/><path d="${line}" fill="none" stroke="var(--down)" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>`;
  }
  const tca = sl && sl.count ? `<div class="chips" style="margin-top:var(--s3)"><span class="mchip"><span class="l">Slippage p50</span><b>${num(sl.p50, 1)} bps</b></span><span class="mchip"><span class="l">p95</span><b>${num(sl.p95, 1)} bps</b></span><span class="mchip"><span class="l">${t("Latency", "Latencia")}</span><b>${num(sl.meanLatencyMs, 0)} ms</b></span><span class="mchip"><span class="l">Fills</span><b>${n(sl.count)}</b></span></div>` : "";
  const picker = options.length > 1
    ? `<span class="seg" style="margin-left:var(--s2)">${options.map((o) => `<button class="${o.id === profile ? "on" : ""}" data-mr="${esc(o.id)}">${esc(o.label)}</button>`).join("")}</span>`
    : "";
  return `<div class="card-note" style="display:flex;align-items:center;flex-wrap:wrap;gap:var(--s2)">${t("Monthly returns", "Retornos mensuales")} <span class="muted">(${esc(profile)})</span>${picker}</div><div class="chips" style="margin-top:var(--s2)">${months}</div>${ddHtml}${tca}`;
}
