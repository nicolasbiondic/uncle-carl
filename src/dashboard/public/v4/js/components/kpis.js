import { store, t, periodLabel } from "../store.js";
import { money, moneySigned, pct, pctSigned, pnlColor, n, num } from "../fmt.js";
import { esc } from "../ui.js";
import { renderFngKpi } from "./fng.js";

function kpi(label, valueHtml, cls = "", subHtml = "") {
  return `<div class="kpi ${cls}"><span class="kl">${esc(label)}</span><span class="kv">${valueHtml}</span>${subHtml ? `<span class="ks">${subHtml}</span>` : ""}</div>`;
}

/** Line under a P&L KPI (2026-09-29, owner: "Esos +4000 no los veo"): the
 *  P&L is the change in the accounts' value, so a close whose gain was
 *  earned before the window barely moves it. This shows what closed trades
 *  realized in the SAME window (server-side getTradingStats periodPnl) and
 *  opens the attribution (pnl-breakdown.js). */
export function realizedSub(realized, count, days) {
  if (realized == null) return "";
  const c = n(count);
  const what = c === 0
    ? t("no closes", "sin cierres")
    : `${t("realized", "cobrado")} <b style="color:${pnlColor(realized)}">${moneySigned(realized, 0)}</b> ${t("in", "en")} ${num(c, 0)} ${c === 1 ? t("close", "cierre") : t("closes", "cierres")}`;
  return `${what} · <button type="button" class="lnk" data-act="pnl-why" data-days="${days}">${t("breakdown", "desglose")}</button>`;
}

/** Consolidated "today"/period figures derived from the v2 profiles payload so
 *  the KPI bar and the sparkline share ONE window (ET-day, via the API).
 *  Total Equity / Top P&L / fixed 7D P&L all read from `pnlAggregate`
 *  (routes/profiles.ts) — ONE server-computed figure combining every
 *  applicable *_main broker-truth leg (alpaca_main + binance_main +
 *  binance_coinm_main once DAPI is applicable), never a frontend
 *  recombination across brokers (mandate 2026-07-19: "remove any
 *  brokerCount>1 suppression" — the old code only showed a combined pct
 *  when exactly one broker had a figure; the server now always ships ONE
 *  ready pct, weighted across every leg, null only when a leg is genuinely
 *  unavailable/rebased). */
export function kpiValues(state) { return consolidated(state); }
function consolidated(state) {
  const d = state.dashboard;
  const profs = state.profiles || [];
  let totalClosed = 0, wins = 0, totalTrades = 0, todayTrades = 0;
  for (const p of profs) for (const ba of p.brokerAccounts || []) {
    const st = ba.stats || {};
    totalClosed += n(st.closedTrades);
    wins += Math.round(n(st.winRate) / 100 * n(st.closedTrades));
    totalTrades += n(st.totalTrades);
    todayTrades += n(st.todayTrades);
  }
  const agg = profs[0]?.pnlAggregate ?? null;
  return {
    // KPI bar is portfolio-wide regardless of the selected view — it must
    // match the (already-consolidated) periodPnl/pnl7d below it. Per-sleeve
    // detail lives in the cards/modal + the filtered Positions/Trades/Equity.
    equity: agg?.equity ?? null,
    periodPnl: agg?.periodPnl ?? null,
    periodPnlPct: agg?.periodPnlPct ?? null,
    pnl7d: agg?.pnl7d ?? null,
    pnl7dPct: agg?.pnl7dPct ?? null,
    periodRealized: agg?.periodRealized ?? null,
    periodRealizedCount: agg?.periodRealizedCount ?? null,
    realized7d: agg?.realized7d ?? null,
    realized7dCount: agg?.realized7dCount ?? null,
    winRate: totalClosed > 0 ? (wins / totalClosed) * 100 : (n(d?.portfolio?.winRate) || 0),
    open: n(d?.portfolio?.openPositions),
    todayTrades, totalTrades,
    days: n(d?.daysRunning),
  };
}

/** P0 (2026-10-09): volume KPI — executed orders today vs the owner's goal
 *  (server: /api/kpis). Without the payload (old server, harness without the
 *  fixture) falls back to the profiles-derived count, without a goal. */
function volumeKpi(k, kp) {
  const target = kp?.targets?.tradesPerDay ?? null;
  const today = kp?.volume?.today ?? k.todayTrades;
  const avg7 = kp?.volume?.avg7d ?? null;
  const val = target
    ? `${num(today, 0)}/${num(target, 0)} <span class="kv sub">${pct((today / target) * 100, 0)}</span>`
    : `${num(today, 0)} <span class="kv sub">${t("today", "hoy")}</span>`;
  const sub = avg7 == null ? "" : target
    ? `${t("7d avg", "media 7d")} ${num(avg7, 1)} · ${pct((avg7 / target) * 100, 0)}`
    : `${t("7d avg", "media 7d")} ${num(avg7, 1)}`;
  return kpi(t("Trades today", "Trades hoy"), val, "sm", sub);
}

/** P0: 30-day mean compounded daily return of consolidated equity vs goal. */
function returnKpi(kp) {
  if (kp?.ret?.dailyAvgPct30d == null) return "";
  const r = kp.ret.dailyAvgPct30d;
  const goal = kp.targets?.dailyReturnPct ?? null;
  const val = `<span style="color:${pnlColor(r)}">${pctSigned(r, 2)}</span> <span class="kv sub">/${t("day", "día")}</span>`;
  const sub = goal
    ? `${t("goal", "meta")} ${pct(goal, 2)} · ${pct(Math.max(0, r / goal) * 100, 0)}`
    : t("30d daily mean", "media diaria 30d");
  return kpi(t("Return 30D", "Rentab. 30D"), val, "sm", sub);
}

/** P0: drawdown from the display-history peak vs the 25% budget. */
function riskKpi(kp) {
  if (kp?.risk?.drawdownPct == null) return "";
  const dd = kp.risk.drawdownPct;
  const budget = kp.targets?.riskBudgetDdPct ?? null;
  const val = `${pct(dd, 1)} <span class="kv sub">DD</span>`;
  const sub = budget
    ? `${t("budget", "presupuesto")} ${pct(budget, 0)} · ${pct((dd / budget) * 100, 0)} ${t("used", "usado")}`
    : t("from peak", "desde el pico");
  return kpi(t("Risk", "Riesgo"), val, "sm", sub);
}

export function renderKpis() {
  const s = store.state;
  const k = consolidated(s);
  const pnlL = s.period === 1 ? t("Today P&L", "P&L Hoy") : t(`${periodLabel(s.period)} P&L`, `P&L ${periodLabel(s.period)}`);
  // Delta % beside each P&L. Prefer the server-computed broker-truth pct
  // (rebase-aware: null when an all-time methodology jump makes a simple return
  // meaningless). When it's null AND we're on the consolidated view, fall back
  // to an HONEST derived %: the All window uses return-on-seed (Σ initialEquity,
  // the true invested base — same basis as the broker cards), NOT the rebased
  // display anchor; the fixed 7D uses the window-start equity (now − 7d P&L),
  // which self-heals once a recent rebase ages out of the window. An actual 0
  // still renders "0.0%"; only a truly underivable value hides.
  const isConsolidated = s.view === "consolidated";
  const seed = (s.dashboard?.accounts || []).reduce((sum, a) => sum + n(a.initialEquity), 0);
  // Derived % when the server pct is null (rebased anchor): All(0) uses return on
  // seed capital (Σ initialEquity, the true invested base); 7D/30D use the
  // window-start equity (now − window P&L), self-healing once a recent rebase
  // ages out of the window. Today(1) never fabricates — a 1-day return over a
  // synthetic anchor is meaningless. Consolidated view only (account-wide basis).
  const derivedPct = (serverPct, pnl, period) => {
    if (serverPct != null) return serverPct;
    if (!isConsolidated || pnl == null || period === 1) return null;
    const base = period === 0 ? seed : (k.equity == null ? null : k.equity - pnl);
    return base && base > 0 ? (pnl / base) * 100 : null;
  };
  const periodPct = derivedPct(k.periodPnlPct, k.periodPnl, s.period);
  const pnl7dPct = derivedPct(k.pnl7dPct, k.pnl7d, 7);
  const pctSpan = (v) => v == null ? "" : ` <span class="kv sub">${pctSigned(v)}</span>`;
  return (
    kpi(t("Total Equity", "Patrimonio"), k.equity == null ? "—" : money(k.equity, 0)) +
    kpi(pnlL, k.periodPnl == null ? "—" : `<span style="color:${pnlColor(k.periodPnl)}">${moneySigned(k.periodPnl)}${pctSpan(periodPct)}</span>`, "", realizedSub(k.periodRealized, k.periodRealizedCount, s.period)) +
    (s.period === 7 ? "" : kpi(t("7D P&L", "P&L 7D"), k.pnl7d == null ? "—" : `<span style="color:${pnlColor(k.pnl7d)}">${moneySigned(k.pnl7d)}${pctSpan(pnl7dPct)}</span>`, "sm", realizedSub(k.realized7d, k.realized7dCount, 7))) +
    kpi(t("Win Rate", "% Ganadas"), pct(k.winRate, 0), "sm lo2") +
    kpi(t("Open", "Abiertas"), num(k.open, 0), "sm lo2") +
    volumeKpi(k, s.kpis) +
    returnKpi(s.kpis) +
    riskKpi(s.kpis) +
    kpi(t("Running", "Activo"), `${num(k.days, 0)} <span class="kv sub">${t("days", "días")}</span>`, "sm lo") +
    renderFngKpi()
  );
}

/** Global time-window selector — drives KPIs, the equity chart, profile stats.
 *  Rendered in the Equity card header (analytics.js), not the KPI strip. */
export function windowSeg(cur) {
  const opts = [[1, t("Today", "Hoy")], [7, "7D"], [30, "30D"], [0, t("All", "Todo")]];
  const btns = opts.map(([v, l]) => `<button class="${v === cur ? "on" : ""}" data-period="${v}" aria-pressed="${v === cur}">${l}</button>`).join("");
  return `<span class="seg">${btns}</span>`;
}
