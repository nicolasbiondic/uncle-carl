// ══════════════════════════════════════════════
// HistoricalStore — persisted OHLCV bars for backtests + regime analysis
//
// The bot's BacktestEngine previously generated synthetic random-walk
// noise. With this store + the fetchers in src/data/fetchers/, we can
// replay real history (SPY 2018-2024 daily, BTC 2017+ 5m, etc) against
// the live signal pipeline.
//
// Schema:
//   historical_bars(symbol, timeframe, timestamp, open, high, low, close, volume, source)
//   PK on (symbol, timeframe, timestamp). UPSERT-safe.
// ══════════════════════════════════════════════

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { createLogger } from "../utils/logger";
import type { OHLCV } from "../utils/types";

const log = createLogger("HistoricalStore");

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type DataSource = "fmp" | "alphavantage" | "binance_public" | "binance_futures" | "alpaca" | "alpaca_split" | "alpaca_wide" | "yahoo" | "manual";

export interface BarRow {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;     // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: DataSource;
}

let db: Database | null = null;

export function initHistoricalStore(path = "./data/historical.db"): Database {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true } as any);
  db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS historical_bars (
      symbol      TEXT    NOT NULL,
      timeframe   TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL,
      open        REAL    NOT NULL,
      high        REAL    NOT NULL,
      low         REAL    NOT NULL,
      close       REAL    NOT NULL,
      volume      REAL    NOT NULL,
      source      TEXT    NOT NULL,
      fetched_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      PRIMARY KEY (symbol, timeframe, timestamp)
    ) WITHOUT ROWID;
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hist_sym_tf_ts ON historical_bars(symbol, timeframe, timestamp);`);
  log.info(`HistoricalStore initialized at ${path}`);
  return db;
}

function getDb(): Database {
  if (!db) initHistoricalStore();
  return db!;
}

/**
 * Sanity: reject bars whose close is 0 or non-finite. The velarde outage
 * on 2026-04-29 wrote zero-prices to its DB; we explicitly refuse to
 * ingest the same garbage.
 */
function isValidBar(b: BarRow): boolean {
  return Number.isFinite(b.timestamp) && b.timestamp >= 0
      && Number.isFinite(b.volume) && b.volume >= 0
      && Number.isFinite(b.close) && b.close > 0
      && Number.isFinite(b.open)  && b.open  > 0
      && Number.isFinite(b.high)  && b.high  > 0
      && Number.isFinite(b.low)   && b.low   > 0;
}

const UPSERT_SQL = `
  INSERT INTO historical_bars (symbol, timeframe, timestamp, open, high, low, close, volume, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol, timeframe, timestamp) DO UPDATE SET
    open=excluded.open, high=excluded.high, low=excluded.low,
    close=excluded.close, volume=excluded.volume, source=excluded.source,
    fetched_at = CAST(strftime('%s','now') AS INTEGER) * 1000
`;

/**
 * Upsert a batch of bars. Skips rows with non-finite or zero closes.
 * Returns count of bars actually written.
 */
export function upsertBars(bars: BarRow[]): { written: number; skipped: number } {
  const d = getDb();
  let written = 0;
  let skipped = 0;
  const stmt = d.prepare(UPSERT_SQL);
  const txn = d.transaction((rows: BarRow[]) => {
    for (const b of rows) {
      if (!isValidBar(b)) { skipped++; continue; }
      stmt.run(b.symbol, b.timeframe, b.timestamp, b.open, b.high, b.low, b.close, b.volume, b.source);
      written++;
    }
  });
  txn(bars);
  return { written, skipped };
}

function validateReplacement(symbol: string, timeframe: Timeframe, bars: BarRow[]): string | null {
  if (bars.length === 0) return `${symbol}/${timeframe}: empty replacement series`;
  const seen = new Set<number>();
  for (const b of bars) {
    if (!isValidBar(b)) return `${symbol}/${timeframe}: invalid bar at ts=${b.timestamp}`;
    if (b.symbol !== symbol) return `${symbol}/${timeframe}: bar symbol mismatch (${b.symbol})`;
    if (b.timeframe !== timeframe) return `${symbol}/${timeframe}: bar timeframe mismatch (${b.timeframe})`;
    if (seen.has(b.timestamp)) return `${symbol}/${timeframe}: duplicate timestamp ${b.timestamp}`;
    seen.add(b.timestamp);
  }
  return null;
}

/**
 * Atomically replace ALL rows for (symbol, timeframe) with `bars` — for
 * source migrations (e.g. spot→futures, non-split→split-adjusted) where
 * the old rows are on the wrong basis and must not coexist with the new
 * ones. Callers MUST fetch + validate `bars` (non-empty) BEFORE calling
 * this: the delete+insert happens in one transaction, but if the network
 * fetch that produced `bars` fails, this function is simply never called
 * and the old, complete history is left untouched.
 *
 * Defensive validation runs BEFORE the transaction so empty, invalid,
 * duplicate-timestamp, wrong-symbol or wrong-timeframe batches fail
 * closed without deleting the existing rows.
 */
export function replaceBars(
  symbol: string,
  timeframe: Timeframe,
  bars: BarRow[],
): { written: number; skipped: number; deleted: number; error?: string } {
  const error = validateReplacement(symbol, timeframe, bars);
  if (error) {
    log.error(`replaceBars aborted: ${error}`);
    return { written: 0, skipped: 0, deleted: 0, error };
  }

  const d = getDb();
  let written = 0;
  let deleted = 0;
  const delStmt = d.prepare(`DELETE FROM historical_bars WHERE symbol = ? AND timeframe = ?`);
  const insStmt = d.prepare(UPSERT_SQL);
  const txn = d.transaction((rows: BarRow[]) => {
    deleted = delStmt.run(symbol, timeframe).changes;
    for (const b of rows) {
      insStmt.run(b.symbol, b.timeframe, b.timestamp, b.open, b.high, b.low, b.close, b.volume, b.source);
      written++;
    }
  });
  txn(bars);
  return { written, skipped: 0, deleted };
}

/**
 * Atomically replace ALL rows for MULTIPLE (symbol, timeframe) series in a
 * single transaction — both-or-neither across the whole group. Same
 * fetch-validate-before-transaction contract as replaceBars: every group's
 * `bars` are validated up front, so one bad group aborts the entire replace
 * without touching any of the others. Used when two symbols' histories are
 * corrected together and must never end up half-swapped (e.g. a repair that
 * spans multiple tickers under one logical change).
 */
export function replaceBarsGroup(
  groups: Array<{ symbol: string; timeframe: Timeframe; bars: BarRow[] }>,
): { written: number; deleted: number; error?: string } {
  for (const g of groups) {
    const error = validateReplacement(g.symbol, g.timeframe, g.bars);
    if (error) {
      log.error(`replaceBarsGroup aborted: ${error}`);
      return { written: 0, deleted: 0, error };
    }
  }

  const d = getDb();
  let written = 0;
  let deleted = 0;
  const delStmt = d.prepare(`DELETE FROM historical_bars WHERE symbol = ? AND timeframe = ?`);
  const insStmt = d.prepare(UPSERT_SQL);
  const txn = d.transaction((gs: typeof groups) => {
    for (const g of gs) {
      deleted += delStmt.run(g.symbol, g.timeframe).changes;
      for (const b of g.bars) {
        insStmt.run(b.symbol, b.timeframe, b.timestamp, b.open, b.high, b.low, b.close, b.volume, b.source);
        written++;
      }
    }
  });
  try {
    txn(groups);
  } catch (e: any) {
    // A failure here (not just prevalidation above) means bun:sqlite already
    // rolled back the whole transaction, including any groups replaced
    // earlier in this same call — both-or-neither holds even for genuine
    // SQL-level failures, not only pre-write validation.
    log.error(`replaceBarsGroup transaction failed, rolled back: ${e.message}`);
    return { written: 0, deleted: 0, error: e.message };
  }
  return { written, deleted };
}

export interface ValidateBarsOptions {
  /** Reject a run of this many consecutive flat (O=H=L=C) zero-volume bars. */
  maxFlatZeroVolumeRun?: number;
  /** Reject an overnight gap (open vs prior close) exceeding this percent. */
  maxAdjGapPct?: number;
}

const dateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Validate a split-adjusted daily series before it replaces persisted rows.
 *
 * Fails closed on:
 *   - long flat zero-volume filler blocks (stale/delisted ticker padding)
 *   - gross overnight gaps inconsistent with a split-adjusted source
 *
 * Returns all errors so callers can log them and skip the symbol.
 */
export function validateAdjustedDailyBars(
  symbol: string,
  bars: BarRow[],
  opts: ValidateBarsOptions = {},
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (bars.length === 0) {
    errors.push(`${symbol}: empty series`);
    return { ok: false, errors };
  }

  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  const maxFlat = opts.maxFlatZeroVolumeRun ?? 5;
  const maxGap = (opts.maxAdjGapPct ?? 50) / 100;

  let flatRun = 0;
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const isFlat = b.volume === 0 && b.open === b.high && b.high === b.low && b.low === b.close;
    if (isFlat) {
      flatRun++;
      if (flatRun >= maxFlat) {
        errors.push(`${symbol}: flat zero-volume filler run >= ${maxFlat} bars ending ${dateKey(b.timestamp)}`);
        break;
      }
    } else {
      flatRun = 0;
    }

    if (i > 0) {
      const prev = sorted[i - 1];
      const gapOpen = Math.abs(b.open - prev.close) / prev.close;
      const gapClose = Math.abs(b.close - prev.close) / prev.close;
      const gap = Math.max(gapOpen, gapClose);
      if (gap > maxGap) {
        errors.push(`${symbol}: gross discontinuity ${(gap * 100).toFixed(1)}% at ${dateKey(b.timestamp)}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function getBars(
  symbol: string,
  timeframe: Timeframe,
  fromMs: number,
  toMs: number,
): OHLCV[] {
  const d = getDb();
  const rows = d.prepare(`
    SELECT timestamp, open, high, low, close, volume
      FROM historical_bars
     WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp ASC
  `).all(symbol, timeframe, fromMs, toMs) as any[];
  return rows.map(r => ({
    timestamp: r.timestamp,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

export function getCoverage(symbol: string, timeframe: Timeframe):
  { count: number; firstMs: number | null; lastMs: number | null } {
  const d = getDb();
  const r = d.prepare(`
    SELECT COUNT(*) as n, MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
      FROM historical_bars WHERE symbol = ? AND timeframe = ?
  `).get(symbol, timeframe) as any;
  return {
    count: r?.n ?? 0,
    firstMs: r?.first_ts ?? null,
    lastMs: r?.last_ts ?? null,
  };
}

export function listSymbols(): Array<{ symbol: string; timeframe: Timeframe; n: number }> {
  const d = getDb();
  return d.prepare(`
    SELECT symbol, timeframe, COUNT(*) as n
      FROM historical_bars GROUP BY symbol, timeframe ORDER BY symbol, timeframe
  `).all() as any[];
}

/**
 * v3.0 audit fix (2026-05-04): clean shutdown closes the WAL-mode handle so
 * the next start doesn't have to recover. Called from src/index.ts's shutdown
 * handler. (An older version of this comment cited MacroRegimeClassifier.stop()
 * — that class no longer exists.)
 */
export function closeHistoricalStore() {
  if (db) {
    try { db.close(); } catch { /* best effort */ }
    db = null;
  }
}
