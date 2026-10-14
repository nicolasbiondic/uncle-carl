// Shared fixtures for the ai-quorum tests: in-memory historical.db clone
// (same schema as data/historical.db) and an in-memory quorum DB.

import { Database } from "bun:sqlite";
import { openQuorumDb } from "./db";

export function memQuorumDb(): Database {
  return openQuorumDb(":memory:");
}

export function memHistoricalDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE historical_bars (
      symbol TEXT NOT NULL, timeframe TEXT NOT NULL, timestamp INTEGER NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      volume REAL NOT NULL, source TEXT NOT NULL,
      fetched_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (symbol, timeframe, timestamp)
    );
    CREATE TABLE funding_rates (
      symbol TEXT NOT NULL, funding_time INTEGER NOT NULL, rate REAL NOT NULL,
      PRIMARY KEY (symbol, funding_time)
    );
  `);
  return db;
}

export function insertDailyBar(db: Database, symbol: string, ts: number, open: number, close = open): void {
  db.query(
    "INSERT OR REPLACE INTO historical_bars (symbol, timeframe, timestamp, open, high, low, close, volume, source) VALUES (?, '1d', ?, ?, ?, ?, ?, 0, 'test')",
  ).run(symbol, ts, open, Math.max(open, close), Math.min(open, close), close);
}

export function insertFunding(db: Database, symbol: string, ts: number, rate: number): void {
  db.query("INSERT OR REPLACE INTO funding_rates (symbol, funding_time, rate) VALUES (?, ?, ?)").run(symbol, ts, rate);
}

/** Stock daily bars are stamped 04:00 UTC; crypto dailies 00:00 UTC. */
export const stockDay = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 4, 0, 0);
export const cryptoDay = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 0, 0, 0);
