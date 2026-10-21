// ═══ Portfolio engine — when a sleeve decides, and on which data ═══
//
// Stocks/ETFs: one pass per ET trading day at ≥ 09:35 ET (the meanrev /
// daily-momentum discipline: decide on yesterday's COMPLETED session, fill
// after today's open). Crypto: one pass per UTC day at ≥ 00:00:15 UTC on the
// just-closed UTC day. Pure functions of the clock — the engine persists the
// session it ran and never runs twice for the same one.

import { getETDateKey, getETDayStart } from "../../db/database";
import { getPreviousTradingDay, isTradingDay } from "../../utils/marketHours";
import type { SessionDate } from "../types";

export type Market = "stocks" | "crypto";

export interface RunWindow {
  /** The execution session (today's key) — the decision's idempotency key. */
  session: SessionDate;
  /** The last COMPLETED session the data must end at. */
  asOf: SessionDate;
}

export const STOCKS_RUN_MINUTES_ET = 9 * 60 + 35;
export const CRYPTO_RUN_SECONDS_UTC = 15;

export function utcDateKey(ms: number): SessionDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function previousUtcDay(dateKey: SessionDate): SessionDate {
  return utcDateKey(Date.parse(`${dateKey}T00:00:00Z`) - 86_400_000);
}

/** null when no pass is due right now (closed day, before the run time). */
export function runWindow(market: Market, nowMs: number): RunWindow | null {
  if (market === "stocks") {
    const today = getETDateKey(nowMs);
    if (!isTradingDay(today)) return null;
    const minutes = (nowMs - getETDayStart(nowMs)) / 60_000;
    if (minutes < STOCKS_RUN_MINUTES_ET) return null;
    return { session: today, asOf: getPreviousTradingDay(today) };
  }
  const today = utcDateKey(nowMs);
  const seconds = (nowMs - Date.parse(`${today}T00:00:00Z`)) / 1000;
  if (seconds < CRYPTO_RUN_SECONDS_UTC) return null;
  return { session: today, asOf: previousUtcDay(today) };
}
