#!/usr/bin/env bun
/**
 * Backfill 5-minute stock/ETF bars from Alpaca into historical.db so the hour
 * filter can be backtested (the crypto 1h test proved removing hour filters
 * blind LOSES — stocks need their own intraday validation). Restartable (upsert).
 *
 * Run: bun run scripts/backfill-intraday.ts
 *      bun run scripts/backfill-intraday.ts --from 2024-01-01 --syms AAPL,MSFT
 *      bun run scripts/backfill-intraday.ts --replace --from 2023-01-01
 */
import { initHistoricalStore, upsertBars, replaceBars, getCoverage } from "../src/data/HistoricalStore";
import { fetchAlpacaStockBars } from "../src/data/fetchers/AlpacaFetcher";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SYMS = arg("--syms", "AAPL,MSFT,NVDA,GOOGL,AMZN,META,SPY,QQQ,IWM,GLD").split(",");
const FROM = new Date(arg("--from", "2023-01-01") + "T00:00:00Z").getTime();
const TO = Date.now();
const REPLACE = process.argv.includes("--replace");

const historicalDb = initHistoricalStore();
console.log(`Alpaca 5min backfill · ${SYMS.length} syms · ${new Date(FROM).toISOString().slice(0,10)} → ${new Date(TO).toISOString().slice(0,10)}\n`);

let total = 0;
for (const symbol of SYMS) {
  const t0 = Date.now();
  try {
    const existingSource = historicalDb.prepare(
      `SELECT source FROM historical_bars WHERE symbol=? AND timeframe='5m' LIMIT 1`
    ).get(symbol) as { source: string } | undefined;
    const replaceAll = REPLACE || (!!existingSource && existingSource.source !== "alpaca_split");

    const before = getCoverage(symbol, "5m");
    if (REPLACE && before.firstMs && FROM > before.firstMs) {
      throw new Error(`--replace --from would truncate history before ${new Date(FROM).toISOString().slice(0, 10)}`);
    }
    // Migration: fetch the full split-adjusted range first, replace only
    // after a successful, non-empty fetch (never delete-then-fetch — a
    // network failure must leave the old, complete history intact).
    const from = replaceAll ? FROM : Math.max(FROM, (before.lastMs ?? 0) + 1);
    const bars = from < TO ? await fetchAlpacaStockBars(symbol, "5m", from, TO) : [];

    if (replaceAll) {
      if (bars.length === 0) {
        throw new Error(`migration fetch returned 0 bars — refusing to replace ${before.count} existing rows`);
      }
      const r = replaceBars(symbol, "5m", bars);
      total += r.written;
      console.log(`  ${symbol.padEnd(6)} replaced ${r.deleted} rows with ${r.written} split-adjusted bars · ${((Date.now()-t0)/1000).toFixed(0)}s`);
    } else {
      if (bars.length) upsertBars(bars);
      total += bars.length;
      const cov = getCoverage(symbol, "5m");
      console.log(`  ${symbol.padEnd(6)} ${String(bars.length).padStart(7)} bars · coverage ${cov.firstMs ? new Date(cov.firstMs).toISOString().slice(0,10) : "?"}→${cov.lastMs ? new Date(cov.lastMs).toISOString().slice(0,10) : "?"} · ${((Date.now()-t0)/1000).toFixed(0)}s`);
    }
  } catch (e: any) {
    console.log(`  ${symbol.padEnd(6)} FAILED: ${e?.message ?? e}`);
  }
}
console.log(`\nDone. ${total} bars written to data/historical.db (5m).`);
