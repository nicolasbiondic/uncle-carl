/**
 * Synthetic daily fixtures for the RW portfolio-engine research tests
 * (scripts/portfolio-*.test.ts, scripts/lib/portfolioData.test.ts).
 *
 * Owner rule (RW §6): no run of D1/D2/D3 or their benchmarks on real
 * historical data before the director publishes the manifests — every test
 * of the simulator, the protocol wiring and the criteria runs on the tapes
 * built here. Deterministic (seeded GBM from scripts/lib/syntheticCandles.ts),
 * shaped like the research DB:
 *   - stocks: `alpaca_wide` 1d bars on US weekdays stamped at ET midnight
 *     (05:00Z), like the Alpaca daily tape;
 *   - crypto: `binance_futures` 1d bars every UTC day at 00:00Z, plus
 *     funding_rates at 00:00/08:00/16:00 UTC with the data's ms jitter;
 *   - optional index_membership tramos (hist-sp500.db shape).
 *
 * Test-only: nothing under src/ or the research drivers imports this.
 */

import { Database } from "bun:sqlite";
import { generateGbmBars, type SyntheticSeriesSpec } from "./syntheticCandles";

export interface DailyTapeSpec {
  source: "alpaca_wide" | "binance_futures";
  /** First session date "YYYY-MM-DD" (UTC / ET date). */
  from: string;
  /** Number of sessions per symbol. */
  sessions: number;
  series: SyntheticSeriesSpec[];
  /** Per-settlement funding rate (crypto only); default 0.0001 (0.01%). */
  fundingRate?: number;
  /** Optional membership tramos (index_membership). */
  membership?: Array<{ index: string; ticker: string; start: string; end: string | null }>;
}

const DAY_MS = 86_400_000;

/** US weekday session timestamps at ET midnight (05:00Z), starting at `from`. */
export function usSessionTimestamps(from: string, n: number): number[] {
  const out: number[] = [];
  let t = Date.parse(from) + 5 * 3_600_000;
  while (out.length < n) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(t);
    t += DAY_MS;
  }
  return out;
}

/** UTC-day timestamps at 00:00Z. */
export function utcDayTimestamps(from: string, n: number): number[] {
  const start = Date.parse(from);
  return Array.from({ length: n }, (_, i) => start + i * DAY_MS);
}

export interface FixtureBar { symbol: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number }

/** The bars the fixture writes (also handy for in-memory expectations). */
export function fixtureBars(spec: DailyTapeSpec): FixtureBar[] {
  const stamps = spec.source === "binance_futures" ? utcDayTimestamps(spec.from, spec.sessions) : usSessionTimestamps(spec.from, spec.sessions);
  const out: FixtureBar[] = [];
  for (const s of spec.series) {
    const gbm = generateGbmBars({ timeframe: "1d", source: spec.source, fromMs: stamps[0], bars: spec.sessions }, s);
    gbm.forEach((b, i) => out.push({ symbol: s.symbol, timestamp: stamps[i], open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  }
  return out;
}

export function writeDailyFixture(dbPath: string, spec: DailyTapeSpec): void {
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
      symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      PRIMARY KEY(symbol, timeframe, source, timestamp)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS funding_rates (
      symbol TEXT NOT NULL, funding_time INTEGER NOT NULL, rate REAL NOT NULL,
      PRIMARY KEY (symbol, funding_time)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS index_membership (
      index_id TEXT, ticker TEXT, start_date TEXT, end_date TEXT, source TEXT, source_commit TEXT
    )`);
    const bar = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
    const fund = db.prepare("INSERT OR REPLACE INTO funding_rates VALUES (?,?,?)");
    const mem = db.prepare("INSERT INTO index_membership VALUES (?,?,?,?,?,?)");
    db.transaction(() => {
      const bars = fixtureBars(spec);
      for (const b of bars) bar.run(b.symbol, "1d", spec.source, b.timestamp, b.open, b.high, b.low, b.close, b.volume);
      if (spec.source === "binance_futures") {
        const rate = spec.fundingRate ?? 0.0001;
        const start = Date.parse(spec.from);
        // One extra day of settlements past the last bar, like the real tape.
        for (let h = 0; h <= spec.sessions * 24; h += 8) {
          for (const s of spec.series) fund.run(s.symbol.replace("/USD", "USDT"), start + h * 3_600_000 + (h % 24 === 0 ? 5 : 0), rate);
        }
      }
      for (const m of spec.membership ?? []) mem.run(m.index, m.ticker, m.start, m.end, "synthetic", "test");
    })();
  } finally {
    db.close();
  }
}
