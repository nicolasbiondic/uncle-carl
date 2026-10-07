// Display resampling for GET /api/equity/history (2026-10-06).
//
// Storage keeps every 5-min snapshot for the last 2 days and one per hour
// before that (pruneEquitySnapshots), and the chart (lightweight-charts) gives
// every point the same width, whatever the time between them. Plotted raw, a
// 7D window spent ~80% of its width on the last two days, and a Sunday of flat
// 5-min points made a stock sleeve look dead. One cadence per window makes
// width proportional to time again; for stock-only series, keeping only the US
// regular session drops nights and weekends — when they cannot move — the way
// any multi-day stock chart does.
import { isMarketOpen } from "../utils/marketHours";

/** Cadence for a window of `days` (0 = all-time). Never finer than the
 *  coarsest storage the window reaches: hourly beyond the last 2 days. */
export function displayBucketMs(days: number): number {
  if (days === 1) return 5 * 60_000;
  if (days > 0 && days <= 7) return 60 * 60_000;
  if (days > 0 && days <= 30) return 2 * 60 * 60_000;
  return 24 * 60 * 60_000;
}

/** Window length in days for the route's `days` / `range` query. */
export function windowDays(days: number | undefined, range: string | undefined): number {
  if (range) return range === "all" ? 0 : range === "1w" ? 7 : range === "1m" ? 30 : 1;
  return days ?? 30;
}

/** Keeps the window's first point (the header change is measured from it) and
 *  the LAST point of every bucket after it, and always ends on the newest
 *  reading. `marketHoursOnly` skips points outside the US regular session
 *  (stock-only series); the first and newest points are kept regardless. */
export function resampleEquityForDisplay<T extends { snapshot_time: number }>(
  rows: T[],
  bucketMs: number,
  marketHoursOnly = false,
): T[] {
  if (rows.length <= 2) return rows;
  const first = rows[0];
  const newest = rows[rows.length - 1];
  const bucketOf = (r: T) => Math.floor(r.snapshot_time / bucketMs);
  const out: T[] = [first];
  let bucket = bucketOf(first);
  let pending: T | null = null;
  for (let i = 1; i < rows.length - 1; i++) {
    const r = rows[i];
    if (marketHoursOnly && !isMarketOpen(r.snapshot_time)) continue;
    const b = bucketOf(r);
    if (b !== bucket) {
      if (pending) out.push(pending);
      bucket = b;
    }
    pending = r;
  }
  if (pending && bucketOf(pending) !== bucketOf(newest)) out.push(pending);
  out.push(newest);
  return out;
}
