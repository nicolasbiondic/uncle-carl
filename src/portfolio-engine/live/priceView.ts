// ═══ Portfolio engine — PriceView over historical.db daily bars ═══
//
// Point-in-time by construction: only bars whose session date ≤ `asOf` are
// loaded, so `history()` can never leak the current session. Session date of a
// daily bar = the UTC date of its timestamp (Alpaca 1d bars are stamped at ET
// midnight = 04:00/05:00Z of the session; Binance 1d bars at 00:00Z of the UTC
// day) — the same labelling the research runner uses.
//
// Freshness is reported, not decided here: `lastSession(symbol)` lets the
// engine refuse a decision whose data does not end at the previous session.

import type { Database } from "bun:sqlite";
import type { DailyBar, PriceView, SessionDate } from "../types";

export const DEFAULT_MAX_BARS = 800;

export interface HistoricalPriceViewOptions {
  db: Database;
  asOf: SessionDate;
  symbols: readonly string[];
  /** Strategy symbol → historical_bars.symbol (e.g. "BTC" → "BTC/USD"); identity by default. */
  dataSymbol?: (symbol: string) => string;
  timeframe?: string;
  /** Bars kept per symbol (oldest dropped). The designs need ≤ 420 warm-up days. */
  maxBars?: number;
}

export interface FreshnessReport {
  asOf: SessionDate;
  /** Symbols with bars whose last session is BEFORE asOf. */
  stale: string[];
  /** Symbols with no bars at all up to asOf. */
  missing: string[];
  /** Symbols whose last bar is exactly asOf. */
  fresh: string[];
}

export function sessionDateOf(timestampMs: number): SessionDate {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/** End-of-day (exclusive) epoch ms of a session date: every bar stamped
 *  anywhere inside that UTC day belongs to it. */
function sessionEndMs(session: SessionDate): number {
  return Date.parse(`${session}T00:00:00Z`) + 86_400_000;
}

export class HistoricalPriceView implements PriceView {
  readonly asOf: SessionDate;
  private readonly bars = new Map<string, DailyBar[]>();

  constructor(opts: HistoricalPriceViewOptions) {
    this.asOf = opts.asOf;
    const tf = opts.timeframe ?? "1d";
    const maxBars = opts.maxBars ?? DEFAULT_MAX_BARS;
    const toData = opts.dataSymbol ?? ((s: string) => s);
    const stmt = opts.db.prepare(`
      SELECT timestamp, open, high, low, close, volume FROM historical_bars
       WHERE symbol = ? AND timeframe = ? AND timestamp < ?
       ORDER BY timestamp DESC LIMIT ?
    `);
    const until = sessionEndMs(opts.asOf);
    for (const symbol of new Set(opts.symbols)) {
      const rows = stmt.all(toData(symbol), tf, until, maxBars) as any[];
      const out: DailyBar[] = [];
      let lastDate = "";
      for (const r of rows.reverse()) {
        const date = sessionDateOf(r.timestamp);
        if (date === lastDate) continue; // defensive: two stamps inside one session keep the first
        if (!(r.close > 0) || !Number.isFinite(r.close)) continue;
        lastDate = date;
        out.push({ date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
      }
      this.bars.set(symbol, out);
    }
  }

  history(symbol: string, n: number): readonly DailyBar[] {
    const b = this.bars.get(symbol);
    if (!b || n <= 0) return [];
    return b.length <= n ? b : b.slice(b.length - n);
  }

  barCount(symbol: string): number {
    return this.bars.get(symbol)?.length ?? 0;
  }

  lastSession(symbol: string): SessionDate | null {
    const b = this.bars.get(symbol);
    return b && b.length > 0 ? b[b.length - 1].date : null;
  }

  lastClose(symbol: string): number | null {
    const b = this.bars.get(symbol);
    return b && b.length > 0 ? b[b.length - 1].close : null;
  }

  freshness(symbols: readonly string[]): FreshnessReport {
    const rep: FreshnessReport = { asOf: this.asOf, stale: [], missing: [], fresh: [] };
    for (const s of new Set(symbols)) {
      const last = this.lastSession(s);
      if (last === null) rep.missing.push(s);
      else if (last < this.asOf) rep.stale.push(s);
      else rep.fresh.push(s);
    }
    return rep;
  }
}
