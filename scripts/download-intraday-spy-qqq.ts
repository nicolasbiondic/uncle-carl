#!/usr/bin/env bun
/**
 * Download 1-minute SPY/QQQ bars 2016-01-01 → today from Alpaca's Market
 * Data v2 API into a NEW database OUTSIDE this repo
 * (hist-intraday.db in the research data dir, scripts/lib/researchData.ts:
 * $UC_RESEARCH_DATA_DIR, default ~/code/wt/data), for Line C (intraday
 * last-half-hour momentum, docs/reports/V-plan-volumen-rentabilidad.md §12).
 *
 * Same auth/basis as the live engines' daily download
 * (scripts/download-stock-dailies.ts): consolidated SIP feed,
 * adjustment=all (splits+dividends), `end` ≥16 min in the past (free-tier
 * SIP delay). RTH-only bars are kept (src/utils/marketHours.isMarketOpen);
 * the sim only ever needs 09:30–16:00 ET (incl. early-close days).
 *
 * Idempotent/resumable: iterates per CALENDAR YEAR per symbol so a failure
 * mid-run only loses the current year's batch; replaceBars is called once
 * per (symbol, year) after validating that year's fetched bars are
 * non-empty — a transient network failure leaves prior years untouched.
 * Re-running re-fetches every year (simple; the full fetch is a few
 * minutes), REPLACING existing rows for years that still have one.
 *
 * Usage: bun run scripts/download-intraday-spy-qqq.ts
 */
import {
  initHistoricalStore,
  upsertBars,
  closeHistoricalStore,
  getCoverage,
} from "../src/data/HistoricalStore";
import type { BarRow } from "../src/data/HistoricalStore";
import { isMarketOpen } from "../src/utils/marketHours";
import { researchDataPath } from "./lib/researchData";

const DB_PATH = researchDataPath("hist-intraday.db");
const SYMBOLS = ["SPY", "QQQ"] as const;
const START_YEAR = 2016;

function mergeBarPages(pages: Array<Record<string, any[]>>, symbols: readonly string[]): Record<string, BarRow[]> {
  const out: Record<string, BarRow[]> = {};
  for (const sym of symbols) out[sym] = [];
  for (const page of pages) {
    for (const sym of symbols) {
      const raw = page[sym] ?? [];
      for (const b of raw) {
        out[sym].push({
          symbol: sym,
          timeframe: "1m",
          timestamp: Date.parse(b.t),
          open: b.o, high: b.h, low: b.l, close: b.c,
          volume: b.v ?? 0,
          source: "alpaca_wide",
        });
      }
    }
  }
  for (const sym of symbols) out[sym].sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

export function filterRth(bars: BarRow[]): BarRow[] {
  return bars.filter(b => isMarketOpen(b.timestamp));
}

async function fetchYear(KEY: string, SEC: string, year: number, startIso: string, endIso: string): Promise<Record<string, BarRow[]>> {
  const rawPages: Array<Record<string, any[]>> = [];
  let pageToken: string | undefined;
  let pageCount = 0;
  do {
    const u = new URL("https://data.alpaca.markets/v2/stocks/bars");
    u.searchParams.set("symbols", SYMBOLS.join(","));
    u.searchParams.set("timeframe", "1Min");
    u.searchParams.set("start", startIso);
    u.searchParams.set("end", endIso);
    u.searchParams.set("adjustment", "all");
    u.searchParams.set("feed", "sip");
    u.searchParams.set("limit", "10000");
    if (pageToken) u.searchParams.set("page_token", pageToken);

    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(u, { headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC } });
      if (res.status === 429 && attempt < 5) { await Bun.sleep(10_000); continue; }
      break;
    }
    if (!res.ok) throw new Error(`${year}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j: any = await res.json();
    rawPages.push(j.bars ?? {});
    pageCount++;
    pageToken = j.next_page_token ?? undefined;
    if (pageToken) await Bun.sleep(220); // ~270 req/min cap at 200/min nominal limit; polite margin
  } while (pageToken);
  console.log(`  ${year}: ${pageCount} page(s)`);
  return mergeBarPages(rawPages, SYMBOLS);
}

if (import.meta.main) {
  const KEY = process.env.ALPACA_API_KEY, SEC = process.env.ALPACA_SECRET_KEY;
  if (!KEY || !SEC) { console.error("missing ALPACA_API_KEY/ALPACA_SECRET_KEY in env"); process.exit(1); }

  const db = initHistoricalStore(DB_PATH);
  const sipEndMs = Date.now() - 16 * 60_000;
  const currentYear = new Date(sipEndMs).getUTCFullYear();
  console.log(`downloading SPY/QQQ 1-minute RTH bars ${START_YEAR}-01-01 → ${new Date(sipEndMs).toISOString()} into ${DB_PATH}`);

  let totalWritten = 0;
  const failures: string[] = [];

  for (let year = START_YEAR; year <= currentYear; year++) {
    const startIso = `${year}-01-01T00:00:00Z`;
    const yearEndMs = Date.UTC(year + 1, 0, 1);
    const endMs = Math.min(yearEndMs, sipEndMs);
    const endIso = new Date(endMs).toISOString();
    if (Date.parse(startIso) >= endMs) break;

    try {
      const barsBySym = await fetchYear(KEY, SEC, year, startIso, endIso);
      for (const sym of SYMBOLS) {
        const rth = filterRth(barsBySym[sym] ?? []);
        if (rth.length === 0) {
          console.warn(`  ${sym} ${year}: 0 RTH bars fetched`);
          continue;
        }
        const r = upsertBars(rth);
        totalWritten += r.written;
        console.log(`  ${sym} ${year}: upserted ${r.written} RTH bars (skipped ${r.skipped})`);
      }
    } catch (e: any) {
      console.error(`  ${year} FAILED: ${e.message}`);
      failures.push(String(year));
    }
  }

  console.log(`\ntotal bars written: ${totalWritten}`);
  for (const sym of SYMBOLS) {
    const cov = getCoverage(sym, "1m");
    console.log(`  ${sym}: ${cov.count} bars, ${cov.firstMs ? new Date(cov.firstMs).toISOString() : "—"} → ${cov.lastMs ? new Date(cov.lastMs).toISOString() : "—"}`);
  }

  closeHistoricalStore();
  if (failures.length > 0) {
    console.error(`FAILED years: ${failures.join(", ")}`);
    process.exit(1);
  }
}
