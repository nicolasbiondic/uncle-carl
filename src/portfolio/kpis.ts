// ═══ Owner KPIs (P0, 2026-10-09) — volume, return, risk vs the owner's goals ═══
//
// One computation shared by GET /api/kpis (dashboard header + KPI strip) and
// the Telegram daily digest, so the owner sees the SAME figures everywhere:
//
//   - volume: executed orders today + 7-day mean (countExecutedOrders —
//     entry and exit count separately; shadow_* books and sync_* rows never
//     count). Goal: KPI_TARGET_TRADES_PER_DAY (owner: 30 = 100%).
//   - return: 30-day mean compounded daily return of the CONSOLIDATED equity
//     series (src/portfolio/consolidatedEquity.ts — the same *_main
//     broker-truth aggregation /api/equity/history serves, bounded by
//     DISPLAY_HISTORY_START). Goal: KPI_TARGET_DAILY_RETURN_PCT (owner: 0.12).
//   - risk: drawdown from the display-history peak of that same consolidated
//     series. Budget: KPI_RISK_BUDGET_DD_PCT (owner: 25).
//
// Targets are OPTIONAL (env > instance.json, src/platform/instance.ts): a
// fresh install/fork shows the raw figures with every target null.

import {
  countExecutedOrders, getETDayStart, getEquityHistoryByRangeDisplay,
} from "../db/database";
import { buildConsolidatedEquitySeries } from "./consolidatedEquity";
import { loadInstanceConfig, type KpiTargets } from "../platform/instance";

export interface KpiSnapshot {
  targets: KpiTargets;
  volume: {
    /** Executed orders in the current ET day. */
    today: number;
    /** Mean executed orders/day over the last 7 ET days (today included —
     *  same rolling window the Telegram digest's "7D" counters use). */
    avg7d: number;
  };
  ret: {
    /** Mean compounded daily return over the last ≤30 days of consolidated
     *  equity, in percent. null when the series can't support it (fresh
     *  install, <1 day of data, non-positive equity). */
    dailyAvgPct30d: number | null;
    /** Actual elapsed days behind the figure (a young install has <30). */
    windowDays: number;
  };
  risk: {
    /** Drawdown from the display-history peak, percent (0 = at the peak). */
    drawdownPct: number | null;
    peakEquity: number | null;
    equity: number | null;
  };
}

export function computeKpiSnapshot(now: number = Date.now()): KpiSnapshot {
  const targets = loadInstanceConfig().kpiTargets;

  // Volume — ET-day windows, the same convention as every "today" stat.
  const today = countExecutedOrders(getETDayStart(now), now);
  const weekStart = getETDayStart(now - 6 * 86_400_000);
  const avg7d = countExecutedOrders(weekStart, now) / 7;

  // Return — 30d window of the consolidated series ("1m" range).
  let dailyAvgPct30d: number | null = null;
  let windowDays = 0;
  const series30 = buildConsolidatedEquitySeries((pid) => getEquityHistoryByRangeDisplay(pid, "1m"));
  if (series30.length >= 2) {
    const first = series30[0];
    const last = series30[series30.length - 1];
    const elapsedDays = (last.snapshot_time - first.snapshot_time) / 86_400_000;
    if (elapsedDays >= 1 && first.equity > 0 && last.equity > 0) {
      dailyAvgPct30d = (Math.pow(last.equity / first.equity, 1 / elapsedDays) - 1) * 100;
      windowDays = Math.round(elapsedDays * 10) / 10;
    }
  }

  // Risk — drawdown from the peak over the whole DISPLAY history.
  let drawdownPct: number | null = null;
  let peakEquity: number | null = null;
  let equity: number | null = null;
  const seriesAll = buildConsolidatedEquitySeries((pid) => getEquityHistoryByRangeDisplay(pid, "all"));
  if (seriesAll.length > 0) {
    let peak = -Infinity;
    for (const p of seriesAll) if (p.equity > peak) peak = p.equity;
    const lastEq = seriesAll[seriesAll.length - 1].equity;
    if (peak > 0) {
      peakEquity = peak;
      equity = lastEq;
      drawdownPct = Math.max(0, ((peak - lastEq) / peak) * 100);
    }
  }

  return {
    targets,
    volume: { today, avg7d },
    ret: { dailyAvgPct30d, windowDays },
    risk: { drawdownPct, peakEquity, equity },
  };
}
