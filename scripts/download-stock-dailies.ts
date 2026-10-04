#!/usr/bin/env bun
/**
 * Download daily bars 2016-01-01 → today for ~200 liquid US large-caps + sector ETFs
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
 * history intact (fetch-validate-atomic-replace). Production MeanRev universe symbols
 * fail closed: any validation/network error for a MeanRev symbol causes a non-zero
 * exit so the corrupted series is never silently used.
 *
 * Usage: bun run scripts/download-stock-dailies.ts
 */
import {
  initHistoricalStore,
  replaceBars,
  validateAdjustedDailyBars,
  closeHistoricalStore,
} from "../src/data/HistoricalStore";
import type { BarRow } from "../src/data/HistoricalStore";
import { WIDE_UNIVERSE, MOMENTUM_SYMBOLS } from "../src/config/wideUniverse";
import { MEANREV_UNIVERSE } from "../src/strategies/meanrev/MeanRevEngine";
export { WIDE_UNIVERSE, MOMENTUM_SYMBOLS };

export function mergeBarPages(pages: Array<Record<string, any[]>>): Record<string, BarRow[]> {
  const out: Record<string, BarRow[]> = {};
  for (const page of pages) {
    for (const [sym, raw] of Object.entries(page ?? {})) {
      const rows = raw.map((b: any) => ({
          symbol: sym,
          timeframe: "1d" as const,
          timestamp: Date.parse(b.t),
          open: b.o,
          high: b.h,
          low: b.l,
          close: b.c,
          volume: b.v ?? 0,
          source: "alpaca_wide" as const,
        }));
      (out[sym] ??= []).push(...rows);
    }
  }
  for (const sym of Object.keys(out)) {
    out[sym].sort((a, b) => a.timestamp - b.timestamp);
  }
  return out;
}

if (import.meta.main) {
  // Bun auto-loads .env
  const KEY = process.env.ALPACA_API_KEY, SEC = process.env.ALPACA_SECRET_KEY;
  if (!KEY || !SEC) { console.error("missing ALPACA_API_KEY/ALPACA_SECRET_KEY in env"); process.exit(1); }

  const db = initHistoricalStore("./data/historical.db");
  const start = "2016-01-01";
  // Free-tier SIP history requires end ≥15 min ago — same 16 min margin as
  // SIP_HISTORY_LAG_MS in src/executor/alpaca-executor.ts.
  const sipEnd = new Date(Date.now() - 16 * 60_000).toISOString();
  const uniq = [...new Set([...WIDE_UNIVERSE, ...MOMENTUM_SYMBOLS])];
  const meanRevSet = new Set(MEANREV_UNIVERSE);
  console.log(`downloading ${uniq.length} symbols, daily ${start} → today`);

  let total = 0;
  const meanrevFailures: string[] = [];

  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
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
        if (pageToken) u.searchParams.set("page_token", pageToken);

        const res = await fetch(u, { headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC } });
        if (res.status === 429) { await Bun.sleep(10_000); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const j: any = await res.json();

        rawPages.push(j.bars ?? {});
        pageCount++;
        pageToken = j.next_page_token ?? undefined;
        if (pageToken) await Bun.sleep(350); // ~170 req/min < 200 limit
      } while (pageToken);

      const barsBySym = mergeBarPages(rawPages);

      for (const sym of batch) {
        const bars = barsBySym[sym] ?? [];
        const v = validateAdjustedDailyBars(sym, bars, { maxFlatZeroVolumeRun: 4, maxAdjGapPct: 50 });
        if (!v.ok) {
          const msg = v.errors.join("; ");
          console.error(`  ${sym.padEnd(6)} VALIDATION FAILED: ${msg}`);
          if (meanRevSet.has(sym)) meanrevFailures.push(sym);
          continue;
        }

        const r = replaceBars(sym, "1d", bars);
        if (r.error) {
          console.error(`  ${sym.padEnd(6)} REPLACE FAILED: ${r.error}`);
          if (meanRevSet.has(sym)) meanrevFailures.push(sym);
          continue;
        }

        total += r.written;
        console.log(`  ${sym.padEnd(6)} replaced ${r.deleted} rows with ${r.written} all-adjusted SIP bars (${pageCount} page${pageCount > 1 ? "s" : ""})`);
      }
    } catch (e: any) {
      console.error(`  batch ${i / 50 + 1} FAILED: ${e.message} — old data left intact`);
      const batchMeanRev = batch.filter(s => meanRevSet.has(s));
      meanrevFailures.push(...batchMeanRev);
    }
    console.log(`batch ${i / 50 + 1}/${Math.ceil(uniq.length / 50)} done (${total} bars so far)`);
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

  closeHistoricalStore();

  if (meanrevFailures.length > 0) {
    console.error(`\nFAIL-CLOSED: ${meanrevFailures.length} MeanRev universe symbol(s) failed: ${[...new Set(meanrevFailures)].join(", ")}`);
    process.exit(1);
  }
}
