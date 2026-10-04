// ══════════════════════════════════════════════
// P&L breakdown — why a period's P&L differs from what was realized in it
// (2026-09-29, owner: "Esos +4000 no los veo").
//
// The period P&L the dashboard and Telegram show is the change in the
// accounts' VALUE over the window (combineEquityPnlLegs over the *_main
// legs). Closing a position adds nothing to that value: it turns an open
// gain into a realized one. A position that built its gain BEFORE the window
// and closed inside it (META: +$5,163 by 09-23, closed 09-28 for +$4,767.74)
// shows its whole pnl as realized but only its in-window move (−$395) in the
// P&L. This module attributes the window's P&L:
//
//   P&L = (realized − earnedBefore) + openChange + other
//
//  realized      Σ pnl of the real closes in the window — the same rows and
//                boundary as getTradingStats' periodPnl (RECONCILE_CLOSE_SQL,
//                v8 accounts, exit_time > windowStart)
//  earnedBefore  for closes entered before windowStart: (P_start − entry)·q,
//                net of the entry commission (paid before the window)
//  openChange    positions open now: (P_now − (P_start if entered before the
//                window, else entry))·q
//  other         the residual: funding, fees of open positions, the treasury
//                ETF (no trades row), the COIN-M leg, reconcile closes, and
//                the gap between the window boundary and each leg's start
//                snapshot
//
// P_start: stocks — the last alpaca_wide 1d close before the window's first
// ET day (bars are stamped 00:00 ET of their session); crypto — the
// binance_futures 1h close at the boundary (mainnet USDT perp; BASE/USDC maps
// to its BASE/USD proxy, the replay's convention). A needed price that is
// missing makes the affected figure null — never guessed.
// ══════════════════════════════════════════════

import type { Database } from "bun:sqlite";
import { getETDayStart, RECONCILE_CLOSE_SQL } from "../db/database";
import { ALL_PROFILE_IDS } from "../config/riskProfiles";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Sleeves whose P&L is linear in price and whose symbols have historical
 *  bars. momentum_btc (COIN-M inverse contracts) is neither. */
export const MARKABLE_ACCOUNTS: ReadonlySet<string> = new Set([
  "momentum_stocks", "meanrev_stocks", "momentum_crypto", "momentum_crypto_usdc",
]);

/** The window boundary every period figure shares (getTradingStats and
 *  getEquityPnlDisplay use the same rule): 0 = all-time, 1 = today's ET day,
 *  N = the ET day start of N−1 days ago. */
export function windowStartFor(periodDays: number, now = Date.now()): number {
  if (periodDays === 0) return 0;
  return periodDays <= 1 ? getETDayStart(now) : getETDayStart(now - (periodDays - 1) * DAY);
}

function direction(side: string): 1 | -1 {
  return side === "sell" || side === "short" ? -1 : 1;
}

/** Price of `symbol` at the instant `at`, from historical.db; null when the
 *  bar is missing or stale (older than a long weekend for stocks, 3h for
 *  crypto). */
export function priceAt(hist: Database | null, symbol: string, market: string, at: number): number | null {
  if (!hist || !(at > 0)) return null;
  try {
    if (market === "stock") {
      const r = hist.prepare(
        `SELECT close c, timestamp t FROM historical_bars WHERE source = 'alpaca_wide' AND timeframe = '1d' AND symbol = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1`,
      ).get(symbol, at) as { c: number; t: number } | null;
      return r && r.c > 0 && at - r.t <= 6 * DAY ? r.c : null;
    }
    if (market === "crypto") {
      const proxy = symbol.replace(/\/USDC$/, "/USD");
      const r = hist.prepare(
        `SELECT close c, timestamp t FROM historical_bars WHERE source = 'binance_futures' AND timeframe = '1h' AND symbol = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1`,
      ).get(proxy, at - HOUR) as { c: number; t: number } | null;
      return r && r.c > 0 && at - r.t <= 3 * HOUR ? r.c : null;
    }
  } catch {}
  return null;
}

export interface CloseContribution {
  accountId: string;
  symbol: string;
  entryTime: number;
  exitTime: number;
  realized: number;
  /** Part of `realized` earned before the window (0 when entered inside it);
   *  null when the position can't be marked at the boundary. */
  earnedBefore: number | null;
  inWindow: number | null;
}

export interface RealizedAttribution {
  windowStart: number;
  realized: number;
  count: number;
  earnedBefore: number | null;
  closes: CloseContribution[];
}

export function computeRealizedAttribution(db: Database, hist: Database | null, windowStart: number): RealizedAttribution {
  const accounts = [...ALL_PROFILE_IDS];
  const rows = db.prepare(
    `SELECT account_id a, symbol s, market m, side sd, quantity q, entry_price e, entry_time et, exit_time xt, pnl, open_commission oc
       FROM trades
      WHERE status = 'closed' AND exit_time > ? AND ${RECONCILE_CLOSE_SQL}
        AND account_id IN (${accounts.map(() => "?").join(",")})
      ORDER BY exit_time DESC`,
  ).all(windowStart, ...accounts) as Array<{ a: string; s: string; m: string; sd: string; q: number; e: number; et: number; xt: number; pnl: number | null; oc: number | null }>;

  let realized = 0;
  let earned = 0;
  let unknown = false;
  const closes = rows.map((r): CloseContribution => {
    const pnl = r.pnl ?? 0;
    realized += pnl;
    let before: number | null = 0;
    if (r.et < windowStart) {
      const px = MARKABLE_ACCOUNTS.has(r.a) ? priceAt(hist, r.s, r.m, windowStart) : null;
      before = px == null ? null : (px - r.e) * r.q * direction(r.sd) - (r.oc ?? 0);
    }
    if (before == null) unknown = true;
    else earned += before;
    return { accountId: r.a, symbol: r.s, entryTime: r.et, exitTime: r.xt, realized: pnl, earnedBefore: before, inWindow: before == null ? null : pnl - before };
  });
  return { windowStart, realized, count: rows.length, earnedBefore: unknown ? null : earned, closes };
}

export interface BreakdownPosition {
  accountId: string;
  symbol: string;
  market: string;
  side: string;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  currentPrice: number;
}

export interface PnlBreakdown extends RealizedAttribution {
  periodDays: number;
  pnl: number | null;
  closedInWindow: number | null;
  openChange: number | null;
  openCount: number;
  other: number | null;
}

export function computePnlBreakdown(opts: {
  db: Database;
  hist: Database | null;
  periodDays: number;
  /** The period's equity delta — the figure the KPI shows. */
  pnl: number | null;
  openPositions: BreakdownPosition[];
  now?: number;
}): PnlBreakdown {
  const windowStart = windowStartFor(opts.periodDays, opts.now);
  const ra = computeRealizedAttribution(opts.db, opts.hist, windowStart);

  let openChange = 0;
  let openUnknown = false;
  for (const p of opts.openPositions) {
    if (!MARKABLE_ACCOUNTS.has(p.accountId) || !(p.currentPrice > 0)) { openUnknown = true; continue; }
    const ref = p.entryTime >= windowStart ? p.entryPrice : priceAt(opts.hist, p.symbol, p.market, windowStart);
    if (ref == null) { openUnknown = true; continue; }
    openChange += (p.currentPrice - ref) * p.quantity * direction(p.side);
  }

  const closedInWindow = ra.earnedBefore == null ? null : ra.realized - ra.earnedBefore;
  const open = openUnknown ? null : openChange;
  const other = opts.pnl == null || closedInWindow == null || open == null ? null : opts.pnl - closedInWindow - open;
  return {
    ...ra,
    periodDays: opts.periodDays,
    pnl: opts.pnl,
    closedInWindow,
    openChange: open,
    openCount: opts.openPositions.length,
    other,
  };
}
