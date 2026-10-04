#!/usr/bin/env bun
/**
 * Backfill historical OHLCV bars for backtesting + regime analysis.
 *
 * Sources:
 *   Stocks/ETFs (FMP)        — 10y daily for SPY, QQQ, IWM, GLD, XLE, XLF
 *   Crypto (Binance USD-M)   — futures klines matching live execution, 1h + 1d
 *   ^VIX (Alpha Vantage)     — 20+y daily
 *
 * Run: bun run scripts/backfill-historical.ts
 *      bun run scripts/backfill-historical.ts --crypto-only
 *      bun run scripts/backfill-historical.ts --stocks-only
 *      bun run scripts/backfill-historical.ts --vix-only
 *
 * The script is restartable: existing rows are upserted, gaps filled.
 */

import { initHistoricalStore, upsertBars, replaceBars, getCoverage, listSymbols } from "../src/data/HistoricalStore";
import * as yahoo from "../src/data/fetchers/YahooFetcher";
import * as bin from "../src/data/fetchers/BinancePublicFetcher";

// ── Config ─────────────────────────────────────────────────────────
const STOCKS = ["SPY", "QQQ", "IWM", "GLD", "XLE", "XLF",
  // 2026-06-05: mega-caps added for the v6.1 regression backtest. These were
  // alpaca_low's April profit engine (META/AAPL/GOOGL/NVDA/MSFT/AMZN) but had
  // no historical bars, so backtests silently fell back to synthetic data.
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "NFLX", "ORCL", "PLTR", "V", "MA", "SLV"];
const CRYPTO = ["BTC/USD", "ETH/USD", "SOL/USD", "ADA/USD", "AVAX/USD", "LINK/USD", "XRP/USD", "DOGE/USD"];
const VIX = "^VIX";

// 10 years of daily for stocks, since 2017-08 for crypto.
const NOW = Date.now();
const TEN_Y_AGO = NOW - 10 * 365 * 24 * 60 * 60 * 1000;
const CRYPTO_GENESIS = new Date("2019-09-01T00:00:00Z").getTime();

const TF_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

/**
 * Purge a stored last candle that's still incomplete (closeTime hasn't
 * passed): written before the close-time filter shipped in
 * BinancePublicFetcher, or the process died mid-candle. Safer to drop it
 * than trade on a phantom bar; the next fetch will refill it once closed.
 */
function purgeIncompleteTail(historicalDb: ReturnType<typeof initHistoricalStore>, sym: string, tf: string): void {
  const cov = getCoverage(sym, tf as any);
  if (cov.lastMs == null) return;
  const durationMs = TF_MS[tf];
  if (!durationMs) return;
  if (cov.lastMs + durationMs > NOW) {
    historicalDb.prepare(`DELETE FROM historical_bars WHERE symbol=? AND timeframe=? AND timestamp=?`).run(sym, tf, cov.lastMs);
    console.log(`  ${sym.padEnd(10)} ${tf} purged incomplete tail candle @ ${new Date(cov.lastMs).toISOString()}`);
  }
}

const args = process.argv.slice(2);
const cryptoOnly = args.includes("--crypto-only");
const stocksOnly = args.includes("--stocks-only");
const vixOnly = args.includes("--vix-only");
const skipCrypto = stocksOnly || vixOnly;
const skipStocks = cryptoOnly || vixOnly;
const skipVix = cryptoOnly || stocksOnly;

const historicalDb = initHistoricalStore();

console.log("══════════════════════════════════════════════");
console.log("  Uncle Carl historical backfill");
console.log("══════════════════════════════════════════════");
console.log(`Stocks (FMP):      ${skipStocks ? "skipped" : STOCKS.join(", ")}`);
console.log(`Crypto (Binance):  ${skipCrypto ? "skipped" : CRYPTO.join(", ")}`);
console.log(`VIX (AV):          ${skipVix ? "skipped" : VIX}`);
console.log(`Range: ${new Date(TEN_Y_AGO).toISOString().slice(0,10)} → ${new Date(NOW).toISOString().slice(0,10)}`);
console.log();

let totalWritten = 0;
let totalSkipped = 0;

// ── Stocks + VIX (daily) via Yahoo ─────────────────────────────────
if (!skipStocks) {
  console.log("── Stocks daily (Yahoo) ────────────────────────");
  for (const sym of STOCKS) {
    try {
      const cov = getCoverage(sym, "1d");
      const from = cov.lastMs ? cov.lastMs + 1 : TEN_Y_AGO;
      if (from >= NOW) {
        console.log(`  ${sym.padEnd(6)} up-to-date (${cov.count} bars)`);
        continue;
      }
      const bars = await yahoo.fetchBars(sym, "1d", from, NOW);
      const r = upsertBars(bars);
      totalWritten += r.written; totalSkipped += r.skipped;
      console.log(`  ${sym.padEnd(6)} +${r.written} bars (skipped ${r.skipped})`);
    } catch (e: any) {
      console.error(`  ${sym.padEnd(6)} FAILED: ${e.message}`);
    }
  }
  console.log();
}

if (!skipVix) {
  console.log("── VIX daily (Yahoo) ───────────────────────────");
  try {
    const cov = getCoverage(VIX, "1d");
    const from = cov.lastMs ? cov.lastMs + 1 : TEN_Y_AGO;
    if (from >= NOW) {
      console.log(`  ${VIX} up-to-date (${cov.count} bars)`);
    } else {
      const bars = await yahoo.fetchBars(VIX, "1d", from, NOW);
      const r = upsertBars(bars);
      totalWritten += r.written; totalSkipped += r.skipped;
      console.log(`  ${VIX} +${r.written} bars (skipped ${r.skipped})`);
    }
  } catch (e: any) {
    console.error(`  ${VIX} FAILED: ${e.message}`);
  }
  console.log();
}

// ── Crypto (1d + 1h) ──────────────────────────────────────────────
if (!skipCrypto) {
  console.log("── Crypto 1d + 1h (Binance USD-M futures) ─────");
  for (const sym of CRYPTO) {
    for (const tf of ["1d", "1h"] as const) {
      try {
        const existingSource = historicalDb.prepare(
          `SELECT source FROM historical_bars WHERE symbol=? AND timeframe=? LIMIT 1`
        ).get(sym, tf) as { source: string } | undefined;
        const needsMigration = !!existingSource && existingSource.source !== "binance_futures";

        if (!needsMigration) {
          // Self-heal: a previously-incomplete last candle (written before
          // the close-time filter shipped) must not sit there forever.
          purgeIncompleteTail(historicalDb, sym, tf);
        }

        const cov = getCoverage(sym, tf);
        // Migration: refetch full history first, replace only after a
        // successful, non-empty fetch — a network failure must leave the
        // old rows intact (never delete-then-fetch). Incremental: refetch
        // FROM (not after) the last stored candle so a previously-
        // incomplete row gets corrected by the upsert once it has closed.
        const from = needsMigration ? CRYPTO_GENESIS : (cov.lastMs ?? CRYPTO_GENESIS);
        if (!needsMigration && from >= NOW) {
          console.log(`  ${sym.padEnd(10)} ${tf} up-to-date (${cov.count} bars)`);
          continue;
        }

        const bars = await bin.fetchBars(sym, tf, from, NOW);

        if (needsMigration) {
          if (bars.length === 0) {
            throw new Error(`migration fetch returned 0 bars — refusing to replace ${cov.count} existing rows`);
          }
          const r = replaceBars(sym, tf, bars);
          totalWritten += r.written; totalSkipped += r.skipped;
          console.log(`  ${sym.padEnd(10)} ${tf} migrated: replaced ${r.deleted} legacy bars with ${r.written} futures bars`);
        } else {
          const r = upsertBars(bars);
          totalWritten += r.written; totalSkipped += r.skipped;
          console.log(`  ${sym.padEnd(10)} ${tf} +${r.written} bars (skipped ${r.skipped})`);
        }
      } catch (e: any) {
        console.error(`  ${sym.padEnd(10)} ${tf} FAILED: ${e.message}`);
      }
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════");
console.log(`Total bars written: ${totalWritten}, skipped (sanity): ${totalSkipped}`);
console.log("\nCoverage now:");
const sums = listSymbols();
for (const s of sums) {
  const c = getCoverage(s.symbol, s.timeframe as any);
  const fr = c.firstMs ? new Date(c.firstMs).toISOString().slice(0,10) : "—";
  const to = c.lastMs ? new Date(c.lastMs).toISOString().slice(0,10) : "—";
  console.log(`  ${s.symbol.padEnd(10)} ${s.timeframe.padEnd(3)} ${String(s.n).padStart(7)} bars  [${fr} → ${to}]`);
}
console.log("══════════════════════════════════════════════");
