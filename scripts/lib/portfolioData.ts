// ══════════════════════════════════════════════════════════════════════
// RW portfolio engine — research data views (docs/reports/RW-reescritura-
// rentable.md §2.1, §3).
//
// Point-in-time views over the protocol's read-only SQLite snapshot for the
// daily simulator (scripts/portfolio-replay.ts):
//   - SessionPriceView: the contract's PriceView — never returns a bar dated
//     after `asOf` (the no-look-ahead guarantee lives HERE, not in callers);
//   - IndexMembershipView: the contract's MembershipView over the
//     index_membership table (hist-sp500.db, scripts/import-sp500-membership.ts);
//   - funding-rate loader + per-session sums for perpetuals;
//   - session-date conventions: US sessions (ET date of the bar) for stocks,
//     UTC days for crypto.
//
// No live code imports this module.
// ══════════════════════════════════════════════════════════════════════

import type { Database } from "bun:sqlite";
import type { DailyBar, MembershipView, PriceView, SessionDate } from "../../src/portfolio-engine/types";
import { getETDateKey } from "../../src/db/database";
import { loadMembership, membersOverlapping, type MembershipBook } from "./membership";

export type SessionCalendar = "us" | "utc";

/** Stocks/ETFs (Alpaca, Yahoo…) trade US sessions; Binance perps live on UTC days. */
export function calendarForSource(source: string): SessionCalendar {
  return source === "binance_futures" ? "utc" : "us";
}

const etDateCache = new Map<number, string>();
/** "YYYY-MM-DD" of a bar timestamp under the sleeve's calendar. Daily Alpaca
 *  bars are stamped at ET midnight (04:00/05:00 UTC), so the ET date IS the
 *  session; a UTC slice would also work for them, but the ET rule is the
 *  one that stays right for any ET-stamped daily source. Cached per distinct
 *  timestamp (bars share timestamps across symbols). */
export function sessionDateOf(timestampMs: number, calendar: SessionCalendar): SessionDate {
  if (calendar === "utc") return new Date(timestampMs).toISOString().slice(0, 10);
  let d = etDateCache.get(timestampMs);
  if (d === undefined) {
    d = getETDateKey(timestampMs);
    etDateCache.set(timestampMs, d);
  }
  return d;
}

/** Calendar days between two session dates (ACT/365 financing accrues over weekends too). */
export function calendarDaysBetween(from: SessionDate, to: SessionDate): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** One symbol's completed sessions, oldest → newest, parallel arrays. */
export interface SessionSeries {
  symbol: string;
  dates: SessionDate[];
  timestamps: number[];
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

/** Index of the LAST session with date ≤ `date` (−1 when none). Dates are
 *  ISO "YYYY-MM-DD", so string order is chronological order. */
export function lastIndexAtOrBefore(dates: readonly SessionDate[], date: SessionDate): number {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Index of the session dated exactly `date`, or −1. */
export function indexOfDate(dates: readonly SessionDate[], date: SessionDate): number {
  const i = lastIndexAtOrBefore(dates, date);
  return i >= 0 && dates[i] === date ? i : -1;
}

export function barAt(series: SessionSeries, i: number): DailyBar {
  return { date: series.dates[i], open: series.open[i], high: series.high[i], low: series.low[i], close: series.close[i], volume: series.volume[i] };
}

/**
 * Load the daily bars of `symbols` in [fromMs, toMs) from the snapshot into
 * per-symbol session series. Two bars collapsing onto one session date (a
 * source quirk) keep the LAST one, deterministically. Symbols with no rows
 * are absent from the map — callers decide whether that is fatal (the
 * timeline/refSymbol is; a point-in-time member is not).
 */
export function loadSessionSeries(
  db: Database,
  symbols: readonly string[],
  source: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
  calendar: SessionCalendar,
): Map<string, SessionSeries> {
  const out = new Map<string, SessionSeries>();
  const uniq = [...new Set(symbols)].sort();
  if (uniq.length === 0) return out;
  // Chunk the IN list well under SQLite's bound-parameter limit.
  const CHUNK = 400;
  type Row = { symbol: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number | null };
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const rows = db.prepare(
      `SELECT symbol, timestamp, open, high, low, close, volume FROM historical_bars
       WHERE source = ? AND timeframe = ? AND symbol IN (${chunk.map(() => "?").join(",")})
         AND timestamp >= ? AND timestamp < ?
       ORDER BY symbol ASC, timestamp ASC`,
    ).all(source, timeframe, ...chunk, fromMs, toMs) as Row[];
    let cur: { symbol: string; dates: string[]; ts: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] } | null = null;
    const flush = () => {
      if (!cur) return;
      out.set(cur.symbol, {
        symbol: cur.symbol, dates: cur.dates, timestamps: cur.ts,
        open: Float64Array.from(cur.o), high: Float64Array.from(cur.h), low: Float64Array.from(cur.l),
        close: Float64Array.from(cur.c), volume: Float64Array.from(cur.v),
      });
      cur = null;
    };
    for (const r of rows) {
      if (!cur || cur.symbol !== r.symbol) { flush(); cur = { symbol: r.symbol, dates: [], ts: [], o: [], h: [], l: [], c: [], v: [] }; }
      const date = sessionDateOf(r.timestamp, calendar);
      const last = cur.dates.length - 1;
      if (last >= 0 && cur.dates[last] === date) {
        // Same session twice: keep the later row.
        cur.ts[last] = r.timestamp; cur.o[last] = r.open; cur.h[last] = r.high; cur.l[last] = r.low; cur.c[last] = r.close; cur.v[last] = r.volume ?? 0;
        continue;
      }
      cur.dates.push(date); cur.ts.push(r.timestamp);
      cur.o.push(r.open); cur.h.push(r.high); cur.l.push(r.low); cur.c.push(r.close); cur.v.push(r.volume ?? 0);
    }
    flush();
  }
  return out;
}

/** Build a series in memory (tests / benchmarks); bars must be chronological. */
export function seriesFromBars(symbol: string, bars: readonly (DailyBar & { timestamp?: number })[]): SessionSeries {
  return {
    symbol,
    dates: bars.map(b => b.date),
    timestamps: bars.map(b => b.timestamp ?? Date.parse(b.date)),
    open: Float64Array.from(bars.map(b => b.open)),
    high: Float64Array.from(bars.map(b => b.high)),
    low: Float64Array.from(bars.map(b => b.low)),
    close: Float64Array.from(bars.map(b => b.close)),
    volume: Float64Array.from(bars.map(b => b.volume)),
  };
}

/**
 * The contract's PriceView over loaded session series. `asOf` is the last
 * COMPLETED session a decision may read; every accessor clips at it, so a
 * strategy cannot see the execution day (or anything later) even though the
 * series hold the whole replay window.
 */
export class SessionPriceView implements PriceView {
  constructor(private readonly series: ReadonlyMap<string, SessionSeries>, readonly asOf: SessionDate) {}

  private upto(symbol: string): { s: SessionSeries; end: number } | null {
    const s = this.series.get(symbol);
    if (!s) return null;
    const end = lastIndexAtOrBefore(s.dates, this.asOf) + 1; // exclusive
    return end > 0 ? { s, end } : null;
  }

  history(symbol: string, n: number): readonly DailyBar[] {
    const u = this.upto(symbol);
    if (!u || !(n > 0)) return [];
    const start = Math.max(0, u.end - Math.floor(n));
    const out: DailyBar[] = [];
    for (let i = start; i < u.end; i++) out.push(barAt(u.s, i));
    return out;
  }

  barCount(symbol: string): number {
    return this.upto(symbol)?.end ?? 0;
  }

  /** Last close at or before asOf (the decision's reference price), or undefined. */
  lastClose(symbol: string): number | undefined {
    const u = this.upto(symbol);
    return u ? u.s.close[u.end - 1] : undefined;
  }
}

/**
 * The contract's MembershipView over the research DB's index_membership
 * table (fail-closed loader from scripts/lib/membership.ts: start inclusive,
 * end exclusive, NULL end = current). `members(date)` compares the date's
 * UTC midnight against the tramos, which is the same rule the daily
 * momentum/meanrev replays apply.
 */
export class IndexMembershipView implements MembershipView {
  private readonly cache = new Map<SessionDate, readonly string[]>();
  constructor(readonly book: MembershipBook, private readonly exclude: ReadonlySet<string> = new Set()) {}

  static load(db: Database, indexId: string, exclude: readonly string[] = []): IndexMembershipView {
    return new IndexMembershipView(loadMembership(db, indexId), new Set(exclude));
  }

  members(date: SessionDate): readonly string[] {
    const hit = this.cache.get(date);
    if (hit) return hit;
    const atMs = Date.parse(date);
    const out: string[] = [];
    for (const [ticker, tramos] of this.book) {
      if (this.exclude.has(ticker)) continue;
      if (tramos.some(t => atMs >= t.startMs && (t.endMs === null || atMs < t.endMs))) out.push(ticker);
    }
    out.sort();
    this.cache.set(date, out);
    return out;
  }

  /** Tickers (minus the exclusions) with a tramo overlapping [fromMs, toMs) — the symbols a replay must load. */
  overlapping(fromMs: number, toMs: number): string[] {
    return membersOverlapping(this.book, fromMs, toMs).filter(t => !this.exclude.has(t));
  }
}

// ── funding (perpetuals) ─────────────────────────────────────────────────

/** Research-DB perp symbol for a bar symbol: "BTC/USD" → "BTCUSDT" (the
 *  convention hashDataSnapshot / latestCommonAsOf already use). */
export function perpSymbolFor(symbol: string): string {
  return symbol.replace("/USD", "USDT");
}

export interface FundingEvent { time: number; rate: number }

/** Settled funding events of `perpSymbols` in [fromMs, toMs], oldest → newest. */
export function loadFundingRates(db: Database, perpSymbols: readonly string[], fromMs: number, toMs: number): Map<string, FundingEvent[]> {
  const out = new Map<string, FundingEvent[]>();
  const uniq = [...new Set(perpSymbols)].sort();
  if (uniq.length === 0) return out;
  const rows = db.prepare(
    `SELECT symbol, funding_time, rate FROM funding_rates
     WHERE symbol IN (${uniq.map(() => "?").join(",")}) AND funding_time >= ? AND funding_time <= ?
     ORDER BY symbol ASC, funding_time ASC`,
  ).all(...uniq, fromMs, toMs) as Array<{ symbol: string; funding_time: number; rate: number }>;
  for (const r of rows) {
    (out.get(r.symbol) ?? out.set(r.symbol, []).get(r.symbol)!).push({ time: r.funding_time, rate: r.rate });
  }
  return out;
}

const HOUR_MS = 3_600_000;

/**
 * The UTC session that PAYS a settlement: events settle at 00:00/08:00/16:00
 * UTC with millisecond jitter in the data (…00:00:00.005). Rounded to the
 * hour, an event at T belongs to the day containing T − ε, so the 00:00
 * settlement of day d+1 is paid by the book held through day d, and a
 * position opened at the 00:00 open of day d does NOT pay that instant's
 * settlement (the fcarry convention).
 */
export function fundingSessionOf(eventTimeMs: number): SessionDate {
  const rounded = Math.round(eventTimeMs / HOUR_MS) * HOUR_MS;
  return new Date(rounded - 1).toISOString().slice(0, 10);
}

/** session date → sum of the rates settled against that session's book. */
export function fundingByUtcSession(events: readonly FundingEvent[]): Map<SessionDate, number> {
  const out = new Map<SessionDate, number>();
  for (const e of events) {
    const d = fundingSessionOf(e.time);
    out.set(d, (out.get(d) ?? 0) + e.rate);
  }
  return out;
}
