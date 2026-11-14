import { store, t, periodLabel } from "../store.js";
import { money, moneySigned, pct, pctSigned, pnlColor, n, num } from "../fmt.js";
import { esc } from "../ui.js";
import { renderProfiles, sinceStart } from "./profiles.js";

/** `key` marks the cells main.js flashes when their value moves (data-k). */
function kpi(label, valueHtml, cls = "", subHtml = "", key = "") {
  return `<div class="kpi ${cls}"${key ? ` data-k="${key}"` : ""}><span class="kl">${esc(label)}</span><span class="kv">${valueHtml}</span>${subHtml ? `<span class="ks">${subHtml}</span>` : ""}</div>`;
}

/** A P&L figure that opens its breakdown (pnl-breakdown.js) when clicked: a
 *  real button, so it takes focus and Enter/Space like any control. */
function figure(html, days) {
  return `<button type="button" class="kfig" data-act="pnl-why" data-days="${days}" title="${esc(t("Change in account value — click for details", "Cambio del valor de la cuenta — clic para ver el detalle"))}">${html}</button>`;
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
    periodBreakdown: agg?.periodBreakdown ?? null,
    breakdown7d: agg?.breakdown7d ?? null,
    // No closes yet ⇒ null, rendered "—" (never a fabricated 0%).
    winRate: totalClosed > 0 ? (wins / totalClosed) * 100 : (d?.portfolio?.winRate ?? null),
    todayTrades, totalTrades,
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
  const sub = avg7 == null ? "" : `${t("7d avg", "media 7d")} ${num(avg7, 1)}`;
  return kpi(t("Orders today", "Órdenes hoy"), val, "sm", sub);
}

/** P0: 30-day mean compounded daily return of consolidated equity vs goal. */
function returnKpi(kp) {
  if (kp?.ret?.dailyAvgPct30d == null) return "";
  const r = kp.ret.dailyAvgPct30d;
  const goal = kp.targets?.dailyReturnPct ?? null;
  const val = `<span style="color:${pnlColor(r)}">${pctSigned(r, 2)}</span> <span class="kv sub">/${t("day", "día")}</span>`;
  const sub = goal ? `${t("goal", "meta")} ${pct(goal, 2)}/${t("day", "día")}` : t("30d daily mean", "media diaria 30d");
  return kpi(t("Return 30D", "Rentab. 30D"), val, "sm", sub);
}

/** "+$5,875 (+5.2%) since start" under the total equity, amount and percentage
 *  in the result colour; the title names the start date and the value the
 *  percentage is over ("it started with $112,238"). */
export function sinceStartSub(ss) {
  if (!ss) return "";
  const when = ss.startedAt ? new Date(ss.startedAt).toLocaleDateString(store.state.lang === "es" ? "es" : "en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  const base = ss.startEquity > 0 ? t(`: it started with ${money(ss.startEquity, 0)}`, `: empezó con ${money(ss.startEquity, 0)}`) : "";
  const title = when ? t(`Since the system started, ${when}${base}`, `Desde que empezó el sistema, ${when}${base}`) : "";
  const pctHtml = ss.pct == null ? "" : ` <span style="color:${pnlColor(ss.pnl)}">(${pctSigned(ss.pct)})</span>`;
  return `<span title="${esc(title)}"><b style="color:${pnlColor(ss.pnl)}">${moneySigned(ss.pnl, 0)}</b>${pctHtml} ${t("since start", "desde el inicio")}</span>`;
}

export function renderKpis() {
  const s = store.state;
  const k = consolidated(s);
  const pnlL = s.period === 1 ? t("Gain today", "Ganancia hoy") : t(`Gain ${periodLabel(s.period)}`, `Ganancia ${periodLabel(s.period)}`);
  // The server's null is intentional (rebased/unavailable). Never divide by
  // another base to manufacture a percentage beside that same money figure.
  const periodPct = k.periodPnlPct;
  const pnl7dPct = k.pnl7dPct;
  const pctSpan = (v) => v == null ? "" : ` <span class="kv sub">${pctSigned(v)}</span>`;
  // The figure opens the breakdown whenever its bridge exists (old servers
  // without the breakdown fields keep a plain, non-clickable figure).
  const pnlValue = (pnl, pctV, breakdown, days) => {
    if (pnl == null) return "—";
    const html = `<span style="color:${pnlColor(pnl)}">${moneySigned(pnl, 0)}${pctSpan(pctV)}</span>`;
    return breakdown == null ? html : figure(html, days);
  };
  // One row: equity, the two portfolios (profiles.js), the P&L windows, the
  // goals (return, trades), then the win rate.
  return (
    kpi(t("Total equity", "Patrimonio"), k.equity == null ? "—" : money(k.equity, 0), "", sinceStartSub(sinceStart(s)), "equity") +
    renderProfiles() +
    kpi(pnlL, pnlValue(k.periodPnl, periodPct, k.periodBreakdown, s.period), "", "", "today") +
    (s.period === 7 ? "" : kpi(t("Gain over 7 days", "Ganancia de 7 días"), pnlValue(k.pnl7d, pnl7dPct, k.breakdown7d, 7), "sm")) +
    returnKpi(s.kpis) +
    volumeKpi(k, s.kpis) +
    kpi(t("Win rate", "% Ganadas"), k.winRate == null ? "—" : pct(k.winRate, 0), "sm", t("of closed operations", "de las operaciones cerradas"), "win")
  );
}

/** Global time-window selector — drives KPIs, the equity chart, profile stats.
 *  Rendered in the Equity card header (analytics.js), not the KPI strip. */
export function windowSeg(cur) {
  const opts = [[1, t("Today", "Hoy")], [7, "7D"], [30, "30D"], [0, t("All", "Todo")]];
  const btns = opts.map(([v, l]) => `<button class="${v === cur ? "on" : ""}" data-period="${v}" aria-pressed="${v === cur}">${l}</button>`).join("");
  return `<span class="seg">${btns}</span>`;
}
