// ══════════════════════════════════════════════════════════════════════
// Point-in-time index membership (research replays only)
//
// Reads the `index_membership` table written by
// scripts/import-sp500-membership.ts into the RESEARCH historical DB and
// answers "was <ticker> a member of <index> at <timestamp>?" plus the
// point-in-time liquidity ranking the PIT manifests opt into
// (data.liquidityRank). Date semantics follow the vendored
// fja05680/sp500 CSV exactly (vendor/sp500/NOTICE.md):
//   - start_date INCLUSIVE, end_date EXCLUSIVE (removal effective date),
//     NULL end = current member;
//   - timestamps compare against UTC-midnight parses of those dates, which
//     is correct for the daily replay clock (decision ticks stamp at
//     04:00/05:00 UTC — strictly after the start date's midnight, strictly
//     after the end date's midnight, so an entry decided ON the removal
//     date is already excluded).
//
// No live code imports this module.
// ══════════════════════════════════════════════════════════════════════

import type { Database } from "bun:sqlite";
import type { OHLCV } from "../../src/utils/types";

/** One membership tramo; endMs is EXCLUSIVE, null = still a member. */
export interface MembershipRange {
  startMs: number;
  endMs: number | null;
}

export type MembershipBook = Map<string, MembershipRange[]>;

/**
 * Load every tramo of `indexId` from the DB's index_membership table.
 * Fail-closed: a missing table or an empty index throws — a replay that
 * silently ran with zero members would be a hand-picked-universe replay
 * wearing a PIT label.
 */
export function loadMembership(db: Database, indexId: string): MembershipBook {
  let rows: Array<{ ticker: string; start_date: string; end_date: string | null }>;
  try {
    rows = db.prepare(
      `SELECT ticker, start_date, end_date FROM index_membership
       WHERE index_id = ? ORDER BY ticker ASC, start_date ASC`,
    ).all(indexId) as typeof rows;
  } catch (e: any) {
    throw new Error(`index_membership unavailable in this DB (run scripts/import-sp500-membership.ts): ${e?.message ?? e}`);
  }
  if (rows.length === 0) throw new Error(`index_membership has no rows for index "${indexId}"`);
  const book: MembershipBook = new Map();
  for (const r of rows) {
    const startMs = Date.parse(r.start_date);
    const endMs = r.end_date ? Date.parse(r.end_date) : null;
    if (!Number.isFinite(startMs) || (endMs !== null && !(endMs > startMs))) {
      throw new Error(`index_membership: invalid tramo ${r.ticker} ${r.start_date} -> ${r.end_date}`);
    }
    (book.get(r.ticker) ?? book.set(r.ticker, []).get(r.ticker)!).push({ startMs, endMs });
  }
  return book;
}

/** Membership test at a timestamp: start inclusive, end EXCLUSIVE. */
export function isMemberAt(book: MembershipBook, symbol: string, atMs: number): boolean {
  const tramos = book.get(symbol);
  if (!tramos) return false;
  for (const t of tramos) {
    if (atMs >= t.startMs && (t.endMs === null || atMs < t.endMs)) return true;
  }
  return false;
}

/** Tickers with at least one tramo overlapping [fromMs, toMs). Sorted. */
export function membersOverlapping(book: MembershipBook, fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (const [ticker, tramos] of book) {
    if (tramos.some(t => t.startMs < toMs && (t.endMs === null || t.endMs > fromMs))) out.push(ticker);
  }
  return out.sort();
}

/** Index of the last bar CLOSED at `nowMs` (timestamp + barDurationMs <= nowMs), or -1. */
export function lastClosedIndex(bars: OHLCV[], nowMs: number, barDurationMs: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp + barDurationMs <= nowMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Median close×volume over the last `lookbackSessions` bars CLOSED at
 * `nowMs` — strictly backward-looking (the execution bar at `nowMs` is
 * never closed yet, so it can't leak in). Returns null when fewer than
 * `lookbackSessions` closed bars exist (a just-listed member is not
 * rankable yet — deterministic, declared).
 */
export function medianDollarVolume(
  bars: OHLCV[],
  nowMs: number,
  barDurationMs: number,
  lookbackSessions: number,
): number | null {
  const idx = lastClosedIndex(bars, nowMs, barDurationMs);
  if (idx + 1 < lookbackSessions) return null;
  const dvs: number[] = [];
  for (let i = idx + 1 - lookbackSessions; i <= idx; i++) {
    dvs.push(bars[i].close * (bars[i].volume ?? 0));
  }
  dvs.sort((a, b) => a - b);
  const mid = Math.floor(dvs.length / 2);
  return dvs.length % 2 ? dvs[mid] : (dvs[mid - 1] + dvs[mid]) / 2;
}

/**
 * The top `topN` of `symbols` by point-in-time median dollar volume at
 * `nowMs`. Ties break by symbol (ascending) so the set is deterministic.
 * Symbols without `lookbackSessions` closed bars are not rankable and never
 * make the cut.
 */
export function topNByDollarVolume(
  symbols: Iterable<string>,
  candles: Map<string, OHLCV[]>,
  nowMs: number,
  barDurationMs: number,
  lookbackSessions: number,
  topN: number,
): Set<string> {
  const scored: Array<{ symbol: string; dv: number }> = [];
  for (const symbol of symbols) {
    const bars = candles.get(symbol);
    if (!bars || bars.length === 0) continue;
    const dv = medianDollarVolume(bars, nowMs, barDurationMs, lookbackSessions);
    if (dv !== null) scored.push({ symbol, dv });
  }
  scored.sort((a, b) => b.dv - a.dv || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return new Set(scored.slice(0, topN).map(s => s.symbol));
}
