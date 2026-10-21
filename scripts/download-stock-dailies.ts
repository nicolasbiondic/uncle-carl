#!/usr/bin/env bun
/**
 * Download daily bars 2016-01-01 → today for the wide universe, 18 D1 ETFs
 * and date-current S&P 500 members (offline pinned membership, or newer import)
 * from Alpaca data REST, into data/historical.db historical_bars (timeframe='1d',
 * source='alpaca_wide').
 *
 * Since 2026-09-25 the series is fetched exactly the way the LIVE engines read
 * their signal bars (src/executor/alpaca-executor.ts): consolidated SIP feed with
 * `end` ≥16 min in the past, and adjustment=all (splits + dividends + spin-offs).
 * Before, it was the account's default feed with adjustment=split, so every
 * backtest ran on different closes than the live signal (and HON's 2026-06-29
 * spin-off left a −50.9% gap that failed validation, dropping HON — a MeanRev
 * universe symbol — from the research DB entirely).
 *
 * Split-adjusted re-download atomically REPLACES existing rows per symbol/timeframe
 * after validation. A failed fetch or a corrupted/invalid series leaves the old
 * history intact (fetch-validate-atomic-replace). MeanRev, D1 and current S&P
 * symbols fail closed; optional legacy wide symbols retain their warning-only
 * behavior. PIT member tapes use the research downloader's identity preparation.
 *
 * Usage: bun run scripts/download-stock-dailies.ts
 */
import {
  initHistoricalStore,
  replaceBars,
  validateAdjustedDailyBars,
  closeHistoricalStore,
} from "../src/data/HistoricalStore";
import { WIDE_UNIVERSE, MOMENTUM_SYMBOLS } from "../src/config/wideUniverse";
import { MEANREV_UNIVERSE } from "../src/strategies/meanrev/MeanRevEngine";
import { prepareMemberSeries } from "./download-sp500-members";
import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { parseStartEndCsv, writeMembership, SP500_SOURCE, SP500_SOURCE_COMMIT, VENDORED_START_END } from "./import-sp500-membership";
import { mergeBarPages } from "./lib/researchData";
export { mergeBarPages };
export { WIDE_UNIVERSE, MOMENTUM_SYMBOLS };

export const RW_D1_ETFS = ["SPY", "QQQ", "IWM", "EFA", "EEM", "SHY", "IEF", "TLT", "LQD", "HYG", "TIP", "GLD", "DBC", "USO", "VNQ", "UUP", "FXE", "FXY"];

/** Bootstrap the pinned PIT membership offline, but never overwrite a newer import. */
function currentSP500Members(db: Database, date: string): string[] {
  const hasMembership = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='index_membership'").get();
  if (!hasMembership || !db.query("SELECT 1 FROM index_membership WHERE index_id='sp500' LIMIT 1").get()) {
    writeMembership(db, parseStartEndCsv(readFileSync(VENDORED_START_END, "utf8")), {
      indexId: "sp500", source: SP500_SOURCE, sourceCommit: SP500_SOURCE_COMMIT,
    });
  }
  const members = db.query(`SELECT DISTINCT ticker FROM index_membership
    WHERE index_id='sp500' AND start_date <= ? AND (end_date IS NULL OR end_date > ?) ORDER BY ticker`).all(date, date) as Array<{ ticker: string }>;
  return members.map(m => m.ticker);
}

export function stockRefreshUniverse(db: Database, date: string): string[] {
  return [...new Set([...WIDE_UNIVERSE, ...MOMENTUM_SYMBOLS, ...RW_D1_ETFS, ...currentSP500Members(db, date)])];
}

export async function refreshStockDailies(opts: {
  dbPath?: string; start?: string; end?: string; symbols?: string[];
  key?: string; secret?: string; fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<unknown>;
} = {}): Promise<number> {
  const KEY = opts.key ?? process.env.ALPACA_API_KEY, SEC = opts.secret ?? process.env.ALPACA_SECRET_KEY;
  if (!KEY || !SEC) throw new Error("missing ALPACA_API_KEY/ALPACA_SECRET_KEY in env");
  const db = initHistoricalStore(opts.dbPath ?? "./data/historical.db");
  const start = opts.start ?? "2016-01-01";
  // Free-tier SIP history requires end ≥15 min ago — same 16 min margin as
  // SIP_HISTORY_LAG_MS in src/executor/alpaca-executor.ts.
  const sipEnd = opts.end ?? new Date(Date.now() - 16 * 60_000).toISOString();
  const uniq = [...new Set(opts.symbols ?? stockRefreshUniverse(db, sipEnd.slice(0, 10)))];
  const members = new Set(opts.symbols ? [] : currentSP500Members(db, sipEnd.slice(0, 10)));
  // Resolve PIT tickers at the last known composition date, not at today's
  // possibly renamed/reused symbol (PSKY→SKYD, DOW's default mapping).
  const memberAsOf = members.size ? (db.query(`SELECT MAX(day) day FROM (
    SELECT start_date day FROM index_membership WHERE index_id='sp500'
    UNION SELECT end_date day FROM index_membership WHERE index_id='sp500'
  ) WHERE day <= ?`).get(sipEnd.slice(0, 10)) as { day: string }).day : undefined;
  const strict = new Set<string>([...MEANREV_UNIVERSE, ...RW_D1_ETFS]);
  const required = new Set(opts.symbols ?? [...strict, ...members]);
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? Bun.sleep;
  console.log(`downloading ${uniq.length} symbols, daily ${start} → ${sipEnd}`);

  let total = 0;
  const failures: string[] = [];
  const batches: string[][] = [];
  // Keep PIT and non-PIT requests separate: the older membership identity
  // date must not remap an unrelated symbol from the legacy wide universe.
  for (const group of [uniq.filter(s => !members.has(s)), uniq.filter(s => members.has(s))]) {
    for (let i = 0; i < group.length; i += 50) batches.push(group.slice(i, i + 50));
  }

  try {
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const rawPages: Array<Record<string, any[]>> = [];
    let pageToken: string | undefined;
    let pageCount = 0;

    try {
      do {
        const u = new URL("https://data.alpaca.markets/v2/stocks/bars");
        u.searchParams.set("symbols", batch.join(","));
        u.searchParams.set("timeframe", "1Day");
        u.searchParams.set("start", start);
        u.searchParams.set("adjustment", "all");
        u.searchParams.set("feed", "sip");
        u.searchParams.set("end", sipEnd);
        u.searchParams.set("limit", "10000");
        if (members.has(batch[0]) && memberAsOf) u.searchParams.set("asof", memberAsOf);
        if (pageToken) u.searchParams.set("page_token", pageToken);

        // Every request (including batch boundaries) is paced; never retry a
        // 429 against the key shared with the live bot.
        await sleep(400);
        const res = await fetchFn(u, { headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC } });
        if (res.status === 429) throw new Error("ALPACA_RATE_LIMIT_429: refresh stopped");
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const j: any = await res.json();

        rawPages.push(j.bars ?? {});
        pageCount++;
        pageToken = j.next_page_token ?? undefined;
      } while (pageToken);

      const barsBySym = mergeBarPages(rawPages);

      for (const sym of batch) {
        let bars = barsBySym[sym] ?? [];
        const pit = members.has(sym) && !strict.has(sym);
        if (pit) {
          const tramos = db.query("SELECT start_date, end_date FROM index_membership WHERE index_id='sp500' AND ticker=?").all(sym) as Array<{ start_date: string; end_date: string | null }>;
          const prep = prepareMemberSeries(bars, tramos.map(t => ({
            fromMs: Math.max(Date.parse(t.start_date), Date.parse(start)),
            toMs: Math.min(t.end_date ? Date.parse(t.end_date) : Infinity, Date.parse(sipEnd)),
          })).filter(t => t.fromMs < t.toMs));
          bars = prep.bars;
          for (const note of [...prep.notes, ...prep.inSeriesDiscontinuities]) console.warn(`  ${sym}: ${note}`);
        }
        const v = validateAdjustedDailyBars(sym, bars, { maxFlatZeroVolumeRun: 4, maxAdjGapPct: pit ? 75 : 50 });
        // As in the PIT downloader, genuine in-series jumps are reported,
        // not discarded; filler/empty/invalid tapes still fail closed.
        const errors = pit ? v.errors.filter(e => !e.includes("gross discontinuity")) : v.errors;
        if (errors.length > 0) {
          const msg = errors.join("; ");
          console.error(`  ${sym.padEnd(6)} VALIDATION FAILED: ${msg}`);
          failures.push(sym);
          continue;
        }

        const r = replaceBars(sym, "1d", bars);
        if (r.error) {
          console.error(`  ${sym.padEnd(6)} REPLACE FAILED: ${r.error}`);
          failures.push(sym);
          continue;
        }

        total += r.written;
        console.log(`  ${sym.padEnd(6)} replaced ${r.deleted} rows with ${r.written} all-adjusted SIP bars (${pageCount} page${pageCount > 1 ? "s" : ""})`);
      }
    } catch (e: any) {
      if (e.message.includes("ALPACA_RATE_LIMIT_429")) throw e;
      console.error(`  batch ${i + 1} FAILED: ${e.message} — old data left intact`);
      failures.push(...batch);
    }
    console.log(`batch ${i + 1}/${batches.length} done (${total} bars so far)`);
  }

  const counts = db.query(
    `SELECT symbol, COUNT(*) n FROM historical_bars
     WHERE timeframe='1d' AND source='alpaca_wide' GROUP BY symbol ORDER BY n`,
  ).all() as Array<{ symbol: string; n: number }>;
  console.log(`\ninserted ${total} bars. ${counts.length} symbols.`);
  const thin = counts.filter(c => c.n < 1500);
  console.log(`<1500 bars (${thin.length}): ${thin.map(c => `${c.symbol}:${c.n}`).join(" ") || "none"}`);
  const noData = uniq.filter(s => !counts.some(c => c.symbol === s));
  console.log(`no data at all: ${noData.join(" ") || "none"}`);

  const requiredFailures = [...new Set(failures)].filter(s => required.has(s));
  if (requiredFailures.length > 0) {
    throw new Error(`FAIL-CLOSED: stock refresh failed for ${requiredFailures.join(", ")}`);
  }
  return total;
  } finally {
    closeHistoricalStore();
  }
}

if (import.meta.main) {
  const argOf = (flag: string) => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
  await refreshStockDailies({ dbPath: argOf("--db"), start: argOf("--start"), end: argOf("--end"), symbols: argOf("--symbols")?.split(",") });
}
