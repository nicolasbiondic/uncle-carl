#!/usr/bin/env bun
/**
 * refresh-crypto-universe — idempotent binance_futures 1h/1d + funding
 * refresh for every symbol a LIVE crypto sleeve could need, not just
 * momentum_crypto's current 8 (2026-09-26: prod's historical.db had fresh
 * 1h for those 8 but nothing for the 13 USDC bases a momentum_crypto_usdc
 * cutover would need — a silent stale-data trap for the NEXT sleeve).
 *
 * Universe = deriveCryptoUniverseSymbols():
 *   - MOMENTUM_CRYPTO_UNIVERSE (the live momentum_crypto sleeve, 8 USDT perps)
 *   - USDC_SYMBOL_MAP's bases (momentum_crypto_usdc's 13 bases), each mapped
 *     to its USDT perp "BASE/USD" — momentum_crypto_usdc trades BASE/USDC
 *     live, but the signal/backtest data contract everywhere in this repo
 *     (backtest-momentum-wf.ts, parity-check.ts) is source=binance_futures
 *     on the USDT perp; the USDC contract's own history is thin/absent for
 *     several bases. BASE/USD is a proxy for SIGNAL, not a claim the two
 *     venues fill identically (same declared limit as momentum_crypto's own
 *     testnet-fills-vs-mainnet-signal split — see liveSleeveConfigs.test.ts).
 *
 * Klines: BinancePublicFetcher (public mainnet REST, no keys). A symbol with
 * NO existing bars is backfilled from GENESIS (2020-01-01); an existing one
 * tops up incrementally from its last stored bar. Funding: syncFundingHistory
 * (src/market/fundingMonitor.ts), one symbol at a time so a single rate-
 * limited/delisted symbol can't take out the rest of the sync (that function
 * itself throws on the first HTTP error — see its docstring).
 *
 * Idempotent (upsert on symbol/timeframe/timestamp PK; funding upserts on
 * symbol/funding_time PK) and fails OPEN per symbol: a delisted/unreachable
 * symbol is logged and skipped, never aborts the run. Exit 1 (informational
 * — nothing here blocks the live money-path) iff at least one symbol/step
 * failed, so cron logs surface it without `set -e` killing sibling refresh
 * steps (see refresh-historical.sh, which backgrounds this behind `|| true`).
 *
 * Usage: bun run scripts/refresh-crypto-universe.ts [--db data/historical.db]
 */

import { Database } from "bun:sqlite";
import { initHistoricalStore, upsertBars, getCoverage, type Timeframe } from "../src/data/HistoricalStore";
import { fetchBars, toBinanceSymbol } from "../src/data/fetchers/BinancePublicFetcher";
import { MOMENTUM_CRYPTO_UNIVERSE } from "../src/config/riskProfiles";
import { USDC_SYMBOL_MAP } from "../src/executor/binance/quoteAsset";
import { syncFundingHistory } from "../src/market/fundingMonitor";

/** GENESIS: first backfill for a symbol with zero stored bars. Matches
 *  backfill-historical.ts's crypto floor of "since 2019/2020". */
export const CRYPTO_UNIVERSE_GENESIS = Date.parse("2020-01-01T00:00:00Z");

/**
 * Union of every crypto symbol a LIVE sleeve's universe references, as
 * "BASE/USD" (BinancePublicFetcher's internal notation for the USDT perp):
 * MOMENTUM_CRYPTO_UNIVERSE as-is, plus USDC_SYMBOL_MAP's bases translated
 * from "BASE/USDC" to "BASE/USD" (the USDT-perp signal proxy). Deduplicated
 * (8 of the 13 USDC bases already overlap the live 8) and sorted for a
 * stable, diffable symbol list.
 */
export function deriveCryptoUniverseSymbols(): string[] {
  const usdcBasesAsUsd = Object.keys(USDC_SYMBOL_MAP).map(s => s.replace(/\/USDC$/, "/USD"));
  return [...new Set([...MOMENTUM_CRYPTO_UNIVERSE, ...usdcBasesAsUsd])].sort();
}

interface StepResult { ok: boolean; written?: number; error?: string }

/** One symbol/timeframe kline refresh. Never throws — failures come back as
 *  `{ ok: false, error }` so the caller can continue the loop. */
async function refreshKlines(sym: string, tf: Timeframe): Promise<StepResult> {
  try {
    const cov = getCoverage(sym, tf);
    const from = cov.lastMs != null ? cov.lastMs + 1 : CRYPTO_UNIVERSE_GENESIS;
    const now = Date.now();
    if (from >= now) return { ok: true, written: 0 };
    const bars = await fetchBars(sym, tf, from, now);
    const r = upsertBars(bars);
    return { ok: true, written: r.written };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** One symbol's funding sync, isolated so a single failing symbol (rate
 *  limit, delisted pair) doesn't take out the batch — syncFundingHistory
 *  itself throws on the first non-OK HTTP response across ALL symbols
 *  passed to it, so it's called with exactly one symbol per call here. */
async function refreshFunding(fundingDb: Database, mainnetSymbol: string): Promise<StepResult> {
  try {
    const counts = await syncFundingHistory(fundingDb, { symbols: [mainnetSymbol] });
    return { ok: true, written: counts[mainnetSymbol] ?? 0 };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export interface RefreshSummary {
  symbols: string[];
  ok: string[];
  failed: Array<{ step: string; error: string }>;
}

/** Refreshes 1h+1d klines and funding for the full derived crypto universe
 *  against `dbPath`. Every symbol/timeframe/funding step is independent —
 *  one failure is recorded in `failed` and the run continues. */
export async function refreshCryptoUniverse(dbPath = "./data/historical.db"): Promise<RefreshSummary> {
  const historicalDb = initHistoricalStore(dbPath);
  const fundingDb = new Database(dbPath);
  const symbols = deriveCryptoUniverseSymbols();
  const ok: string[] = [];
  const failed: Array<{ step: string; error: string }> = [];

  for (const sym of symbols) {
    for (const tf of ["1h", "1d"] as const) {
      const r = await refreshKlines(sym, tf);
      const step = `${sym}:${tf}`;
      if (r.ok) {
        console.log(`  ${step.padEnd(14)} +${r.written} bars`);
        ok.push(step);
      } else {
        console.error(`  ${step.padEnd(14)} FAILED: ${r.error}`);
        failed.push({ step, error: r.error! });
      }
    }
    const mainnetSym = toBinanceSymbol(sym);
    if (!mainnetSym) {
      failed.push({ step: `${sym}:funding`, error: `cannot derive mainnet symbol from "${sym}"` });
      continue;
    }
    const fr = await refreshFunding(fundingDb, mainnetSym);
    const step = `${sym}:funding`;
    if (fr.ok) {
      console.log(`  ${step.padEnd(14)} +${fr.written} funding events`);
      ok.push(step);
    } else {
      console.error(`  ${step.padEnd(14)} FAILED: ${fr.error}`);
      failed.push({ step, error: fr.error! });
    }
  }
  void historicalDb; // kept only to select/init the DB file; upsertBars/getCoverage use the module singleton
  return { symbols, ok, failed };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const dbPath = flag("--db") ?? "./data/historical.db";
  const symbols = deriveCryptoUniverseSymbols();
  console.log(`Refreshing binance_futures 1h/1d + funding for ${symbols.length} crypto-universe symbols`
    + ` (momentum_crypto ∪ momentum_crypto_usdc bases) → ${dbPath}`);
  console.log(`  ${symbols.join(", ")}\n`);

  const summary = await refreshCryptoUniverse(dbPath);

  if (summary.failed.length > 0) {
    console.error(`\n⚠️ ${summary.failed.length}/${summary.ok.length + summary.failed.length} step(s) failed:`);
    for (const f of summary.failed) console.error(`   - ${f.step}: ${f.error}`);
    process.exit(1);
  }
  console.log(`\n✅ crypto-universe refresh complete (${summary.ok.length} steps).`);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`refresh-crypto-universe failed: ${err?.message ?? err}`);
    process.exit(1);
  });
}
