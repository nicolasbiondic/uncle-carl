#!/usr/bin/env bun
/**
 * Download the FULL Binance MAINNET funding-rate history for our 8-perp
 * universe into funding_rates in data/historical.db (idempotent upsert;
 * re-runs resume from MAX(funding_time)+1 per symbol).
 *
 * Public endpoint, no API key. Testnet funding is pinned at 0.01% — signals
 * must come from mainnet, which is why this hits fapi.binance.com directly.
 *
 * Usage: bun run scripts/download-funding-history.ts
 */

import { Database } from "bun:sqlite";
import {
  FUNDING_DB_PATH,
  FUNDING_PERIODS_PER_YEAR,
  FUNDING_SYMBOLS,
  syncFundingHistory,
} from "../src/market/fundingMonitor";

const db = new Database(FUNDING_DB_PATH);

console.log(`Syncing funding history for ${FUNDING_SYMBOLS.length} symbols → ${FUNDING_DB_PATH} …`);
const counts = await syncFundingHistory(db);

console.log("\nsymbol    | upserted | total | first      | last       | mean APR | P90 APR (2021→)");
console.log("----------|----------|-------|------------|------------|----------|----------------");
const FROM_2021 = Date.parse("2021-01-01");
for (const sym of FUNDING_SYMBOLS) {
  const tot = db.prepare(
    `SELECT COUNT(*) n, MIN(funding_time) a, MAX(funding_time) b FROM funding_rates WHERE symbol = ?`,
  ).get(sym) as { n: number; a: number; b: number };
  const rates = (db.prepare(
    `SELECT rate FROM funding_rates WHERE symbol = ? AND funding_time >= ? ORDER BY rate ASC`,
  ).all(sym, FROM_2021) as Array<{ rate: number }>).map((r) => r.rate);
  const mean = rates.reduce((s, r) => s + r, 0) / Math.max(1, rates.length);
  const p90 = rates.length > 0 ? rates[Math.floor(0.9 * (rates.length - 1))] : NaN;
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  console.log(
    `${sym.padEnd(9)} | ${String(counts[sym] ?? 0).padStart(8)} | ${String(tot.n).padStart(5)} | ${d(tot.a)} | ${d(tot.b)} | ` +
    `${(mean * FUNDING_PERIODS_PER_YEAR * 100).toFixed(1).padStart(7)}% | ${(p90 * FUNDING_PERIODS_PER_YEAR * 100).toFixed(1).padStart(7)}%`,
  );
}
