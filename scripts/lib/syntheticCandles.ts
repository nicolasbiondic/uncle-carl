/**
 * Deterministic synthetic candle fixtures for research-tool tests.
 *
 * Purpose (Jesse `test_real_strategy_regression.py` pattern): give the
 * regression-fingerprint and lookahead-analysis tests a candle universe that
 * is (a) fully deterministic under a fixed seed, (b) independent of
 * `data/historical.db` (gitignored, dev-checkout-only, 384MB), and
 * (c) shaped like real market data (geometric random walk + drift) so the
 * REAL strategy engines produce a non-trivial number of trades on it.
 *
 * Determinism contract: same seed + same spec ⇒ bit-identical bars, on the
 * same JS engine build. Math.exp/log/sqrt/cos are not bit-specified across
 * ENGINE versions, so fingerprints anchored on these fixtures may shift on
 * a Bun/JavaScriptCore upgrade — same caveat Jesse accepts by pinning
 * Python/numpy. Nothing here reads the clock or unseeded randomness.
 */

import { Database } from "bun:sqlite";

/** Mulberry32 — tiny deterministic PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic standard normal via Box–Muller over a seeded uniform PRNG. */
export function gaussian(rng: () => number): number {
  // Guard u1 > 0 so log() never sees 0.
  const u1 = rng() || Number.MIN_VALUE;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export interface SyntheticBar {
  symbol: string;
  timeframe: string;
  source: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SyntheticSeriesSpec {
  symbol: string;
  /** Per-symbol seed — series are independent streams. */
  seed: number;
  startPrice: number;
  /** Annualized drift, e.g. 0.5 = +50%/yr. */
  driftAnnual: number;
  /** Annualized volatility, e.g. 0.6 = 60%/yr. */
  volAnnual: number;
}

export interface SyntheticTapeSpec {
  timeframe: "1h" | "1d";
  source: string;
  /** First bar timestamp (ms). Hourly bars step 1h; daily bars step 24h. */
  fromMs: number;
  /** Number of bars per symbol. */
  bars: number;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Geometric random walk with drift: close_t = close_{t-1} ×
 * exp((μ − σ²/2)dt + σ√dt·z). open = previous close (no gaps); high/low
 * bracket open/close with a deterministic vol-scaled excursion so intraday
 * stop-loss paths (bar.low/bar.high checks) are exercised.
 */
export function generateGbmBars(tape: SyntheticTapeSpec, spec: SyntheticSeriesSpec): SyntheticBar[] {
  const rng = mulberry32(spec.seed);
  const stepMs = tape.timeframe === "1h" ? 3_600_000 : 86_400_000;
  const dt = tape.timeframe === "1h" ? 1 / (365 * 24) : 1 / 365;
  const mu = spec.driftAnnual;
  const sigma = spec.volAnnual;
  const out: SyntheticBar[] = [];
  let prevClose = spec.startPrice;
  for (let i = 0; i < tape.bars; i++) {
    const z = gaussian(rng);
    const close = prevClose * Math.exp((mu - (sigma * sigma) / 2) * dt + sigma * Math.sqrt(dt) * z);
    const open = prevClose;
    const wickHi = Math.abs(gaussian(rng)) * 0.5 * sigma * Math.sqrt(dt);
    const wickLo = Math.abs(gaussian(rng)) * 0.5 * sigma * Math.sqrt(dt);
    const high = Math.max(open, close) * (1 + wickHi);
    const low = Math.min(open, close) * (1 - wickLo);
    out.push({
      symbol: spec.symbol,
      timeframe: tape.timeframe,
      source: tape.source,
      timestamp: tape.fromMs + i * stepMs,
      open: round4(open),
      high: round4(high),
      low: round4(low),
      close: round4(close),
      volume: 1000,
    });
    prevClose = close;
  }
  return out;
}

/**
 * Write a synthetic universe into a fresh SQLite db with the production
 * `historical_bars` shape (same columns/PK the replay runners query).
 */
export function writeSyntheticDb(dbPath: string, tape: SyntheticTapeSpec, specs: SyntheticSeriesSpec[]): void {
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
      symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      PRIMARY KEY(symbol, timeframe, source, timestamp)
    )`);
    const stmt = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
    const insertAll = db.transaction((rows: SyntheticBar[]) => {
      for (const b of rows) {
        stmt.run(b.symbol, b.timeframe, b.source, b.timestamp, b.open, b.high, b.low, b.close, b.volume);
      }
    });
    for (const spec of specs) insertAll(generateGbmBars(tape, spec));
  } finally {
    db.close();
  }
}
