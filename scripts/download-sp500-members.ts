#!/usr/bin/env bun
/**
 * Download SIP daily bars (2016-01-01 → now, adjustment=all, feed=sip —
 * exactly the basis scripts/download-stock-dailies.ts uses for the live
 * research series) for EVERY S&P 500 member whose membership tramo
 * (index_membership, scripts/import-sp500-membership.ts) overlaps
 * [2016-01-01, today], into data/historical.db historical_bars
 * (timeframe='1d', source='alpaca_wide').
 *
 * This is a RESEARCH companion script — it deliberately does NOT touch
 * scripts/download-stock-dailies.ts or its fail-closed exit for live
 * MeanRev universe symbols. Symbols that already have alpaca_wide/1d rows
 * (the prod research copy, refreshed 2026-10-02) are SKIPPED unless
 * --force: their series are already on the same SIP/adjustment=all basis.
 *
 * Fetch strategy:
 *   - CURRENT members (a tramo with empty end_date): batched multi-symbol
 *     requests, 50 at a time (same shape as download-stock-dailies.ts).
 *   - RETIRED tickers: one request per symbol with `asof=<end_date of the
 *     latest in-window tramo>` — Alpaca's point-in-time symbol mapping, so
 *     a renamed/reused ticker resolves to the company that held it THEN
 *     (AABA, delisted banks, acquired names).
 *   - REUSED tickers (two different companies, both with a tramo in the
 *     window — e.g. old DuPont's DD 2016-2017 vs today's DD 2019-): bars
 *     are stored under ONE symbol key, so the two series must never be
 *     mixed. The direct/current mapping wins; an earlier tramo whose range
 *     the stored series does not cover is DETECTED and REPORTED as
 *     "uncovered tramo", never backfilled from a different company.
 *
 * Series preparation (prepareMemberSeries, pure + unit-tested): the tape a
 * retired/reused ticker serves is only trustworthy around its membership
 * tramos, so before writing we
 *   0. drop flat zero-volume FILLER bars (o=h=l=c, v=0 — SIP pads dead
 *      tickers with them: MON/EMC/STI/SBNY…);
 *   1. clip to [first in-window tramo start − 630d of warmup lookback, ∞);
 *   2. split at >30 calendar-day tape gaps (a listed company never has a
 *      30d SIP hole — a gap is a TAPE-IDENTITY break: FB's asof tape stops
 *      at the 2022 META rename and resumes in 2025 as a $39 shell) and
 *      keep the segment with max session-overlap vs the in-window tramos;
 *   3. sacrifice warmup before the LAST >75% discontinuity that predates
 *      the first tramo start (pre-merger tapes, e.g. EVHC);
 *   4. drop a trailing bar whose >75% discontinuity sits AT the tape end
 *      (final-bar corporate-action artifacts, e.g. CTVA 2026-10-01).
 * Then validateAdjustedDailyBars with maxAdjGapPct=75: a REMAINING gross
 * discontinuity inside a tramo is treated as REAL market data (MRNA
 * +177%/199M shares 2026-08-19, ECHO +81% 2025-08-26, bankruptcy tapes) —
 * logged + written + reported, never silently dropped. Other validation
 * failures skip the write and are reported; nothing here fail-closed exits
 * (that discipline belongs to the live-universe script).
 *
 * Rate limit: ≤ ~170 req/min (350 ms sleep between requests), under
 * Alpaca's 200/min.
 *
 * Output: per-tramo coverage report (expected sessions = SPY's calendar)
 * printed and written to data/backtests/sp500-members-coverage.json.
 *
 * Usage: bun run scripts/download-sp500-members.ts [--db ./data/historical.db] [--force]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  initHistoricalStore,
  replaceBars,
  validateAdjustedDailyBars,
  closeHistoricalStore,
} from "../src/data/HistoricalStore";
import type { BarRow } from "../src/data/HistoricalStore";
import { mergeBarPages } from "./download-stock-dailies";

const WINDOW_START = "2016-01-01";
const DAY = 86_400_000;
/** Warmup lookback kept before the first in-window tramo start (the PIT
 *  manifests use warmupDays 420; 630 leaves margin for MA200+blend252). */
const WARMUP_LOOKBACK_DAYS = 630;
/** A >30 calendar-day hole in a daily SIP tape = tape-identity break. */
const TAPE_GAP_MS = 30 * DAY;
const MAX_ADJ_GAP_PCT = 75;

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface TramoRow { ticker: string; start_date: string; end_date: string | null }

export interface TramoClip { fromMs: number; toMs: number }

export interface PreparedSeries {
  bars: BarRow[];
  /** Human-readable notes about what was cut/kept. */
  notes: string[];
  /** >75% discontinuities left INSIDE the kept series (real crashes/events). */
  inSeriesDiscontinuities: string[];
}

/** Fraction gap between consecutive bars (same math as validateAdjustedDailyBars). */
function discontinuityPct(prev: BarRow, b: BarRow): number {
  const gapOpen = Math.abs(b.open - prev.close) / prev.close;
  const gapClose = Math.abs(b.close - prev.close) / prev.close;
  return Math.max(gapOpen, gapClose) * 100;
}

/**
 * Pure tape-preparation pipeline for a member symbol (see header). `clips`
 * are the symbol's in-window membership tramos clipped to the download
 * window; `firstTramoStartMs` bounds the warmup-sacrifice rule.
 */
export function prepareMemberSeries(raw: BarRow[], clips: TramoClip[]): PreparedSeries {
  const notes: string[] = [];
  if (raw.length === 0 || clips.length === 0) return { bars: [], notes, inSeriesDiscontinuities: [] };
  const firstTramoStartMs = Math.min(...clips.map(c => c.fromMs));
  const relevantFromMs = firstTramoStartMs - WARMUP_LOOKBACK_DAYS * DAY;

  // 0. drop flat zero-volume filler + 1. clip the warmup lookback.
  let bars = raw.filter(b =>
    b.timestamp >= relevantFromMs &&
    !(b.volume === 0 && b.open === b.high && b.high === b.low && b.low === b.close),
  );
  if (bars.length === 0) return { bars: [], notes: ["all bars were filler/out of range"], inSeriesDiscontinuities: [] };
  if (bars.length < raw.length) notes.push(`dropped ${raw.length - bars.length} filler/pre-warmup bars`);

  // 2. split at tape-identity gaps, keep the segment covering the tramos.
  const segments: BarRow[][] = [[bars[0]]];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].timestamp - bars[i - 1].timestamp > TAPE_GAP_MS) segments.push([]);
    segments[segments.length - 1].push(bars[i]);
  }
  if (segments.length > 1) {
    const overlap = (seg: BarRow[]) =>
      seg.filter(b => clips.some(c => b.timestamp >= c.fromMs && b.timestamp < c.toMs)).length;
    let best = segments[0];
    for (const seg of segments.slice(1)) if (overlap(seg) >= overlap(best)) best = seg;
    notes.push(`tape split into ${segments.length} segments at >30d gaps; kept ${new Date(best[0].timestamp).toISOString().slice(0, 10)} → ${new Date(best[best.length - 1].timestamp).toISOString().slice(0, 10)} (max tramo overlap)`);
    bars = best;
  }

  // 3. warmup sacrifice: start after the LAST >75% discontinuity that
  //    predates the first tramo start (cross-company pre-merger tape).
  let cutFrom = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].timestamp >= firstTramoStartMs) break;
    if (discontinuityPct(bars[i - 1], bars[i]) > MAX_ADJ_GAP_PCT) cutFrom = i;
  }
  if (cutFrom > 0) {
    notes.push(`sacrificed ${cutFrom} warmup bars before a pre-tramo >75% discontinuity at ${new Date(bars[cutFrom].timestamp).toISOString().slice(0, 10)}`);
    bars = bars.slice(cutFrom);
  }

  // 4. trailing final-bar artifacts (up to 3).
  for (let k = 0; k < 3 && bars.length >= 2; k++) {
    const last = bars[bars.length - 1];
    if (discontinuityPct(bars[bars.length - 2], last) > MAX_ADJ_GAP_PCT) {
      notes.push(`dropped final-bar >75% artifact at ${new Date(last.timestamp).toISOString().slice(0, 10)}`);
      bars = bars.slice(0, -1);
    } else break;
  }

  // Remaining >75% discontinuities = real market data, reported not dropped.
  const inSeriesDiscontinuities: string[] = [];
  for (let i = 1; i < bars.length; i++) {
    const pct = discontinuityPct(bars[i - 1], bars[i]);
    if (pct > MAX_ADJ_GAP_PCT) {
      inSeriesDiscontinuities.push(`${pct.toFixed(1)}% at ${new Date(bars[i].timestamp).toISOString().slice(0, 10)}`);
    }
  }
  return { bars, notes, inSeriesDiscontinuities };
}

async function fetchBars(
  symbols: string[],
  key: string,
  sec: string,
  sipEnd: string,
  asof?: string,
): Promise<Record<string, BarRow[]>> {
  const rawPages: Array<Record<string, any[]>> = [];
  let pageToken: string | undefined;
  do {
    const u = new URL("https://data.alpaca.markets/v2/stocks/bars");
    u.searchParams.set("symbols", symbols.join(","));
    u.searchParams.set("timeframe", "1Day");
    u.searchParams.set("start", WINDOW_START);
    u.searchParams.set("adjustment", "all");
    u.searchParams.set("feed", "sip");
    u.searchParams.set("end", sipEnd);
    u.searchParams.set("limit", "10000");
    if (asof) u.searchParams.set("asof", asof);
    if (pageToken) u.searchParams.set("page_token", pageToken);
    const res = await fetch(u, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec } });
    if (res.status === 429) { await Bun.sleep(10_000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    rawPages.push(j.bars ?? {});
    pageToken = j.next_page_token ?? undefined;
    await Bun.sleep(350); // ~170 req/min < 200 limit
  } while (pageToken);
  return mergeBarPages(rawPages);
}

if (import.meta.main) {
  const KEY = process.env.ALPACA_API_KEY, SEC = process.env.ALPACA_SECRET_KEY;
  if (!KEY || !SEC) { console.error("missing ALPACA_API_KEY/ALPACA_SECRET_KEY in env"); process.exit(1); }
  const dbPath = argOf("--db") ?? "./data/historical.db";
  const force = process.argv.includes("--force");
  // --redo-members: re-fetch every member EXCEPT the live research
  // universe's symbols (WIDE_UNIVERSE ∪ MOMENTUM_SYMBOLS — those series are
  // prod's, refreshed by download-stock-dailies.ts and left alone here).
  const redoMembers = process.argv.includes("--redo-members");
  const sipEnd = new Date(Date.now() - 16 * 60_000).toISOString();
  const todayKey = sipEnd.slice(0, 10);

  const db = initHistoricalStore(dbPath);

  // ── membership tramos overlapping the window ─────────────────────────
  const tramos = db.prepare(
    `SELECT ticker, start_date, end_date FROM index_membership
     WHERE index_id = 'sp500' AND (end_date IS NULL OR end_date >= ?)
     ORDER BY ticker ASC, start_date ASC`,
  ).all(WINDOW_START) as TramoRow[];
  if (tramos.length === 0) { console.error("no index_membership rows — run scripts/import-sp500-membership.ts first"); process.exit(1); }
  const byTicker = new Map<string, TramoRow[]>();
  for (const t of tramos) (byTicker.get(t.ticker) ?? byTicker.set(t.ticker, []).get(t.ticker)!).push(t);
  console.log(`${tramos.length} tramos overlapping ${WINDOW_START}+ across ${byTicker.size} tickers`);

  // ── classify ─────────────────────────────────────────────────────────
  const { WIDE_UNIVERSE, MOMENTUM_SYMBOLS } = await import("./download-stock-dailies");
  const existing = redoMembers
    ? new Set<string>([...WIDE_UNIVERSE, ...MOMENTUM_SYMBOLS])
    : new Set(
        (db.prepare(`SELECT DISTINCT symbol FROM historical_bars WHERE timeframe='1d' AND source='alpaca_wide'`).all() as Array<{ symbol: string }>)
          .map(r => r.symbol),
      );
  // --symbols A,B,C: restrict to these tickers and bypass the skip set
  // (targeted fixups after an asof/mapping correction).
  const onlySymbols = argOf("--symbols")?.split(",").map(s => s.trim()).filter(Boolean);
  const current: string[] = [];
  const retired: Array<{ ticker: string; asof: string }> = [];
  const skipped: string[] = [];
  for (const [ticker, trs] of byTicker) {
    if (onlySymbols && !onlySymbols.includes(ticker)) continue;
    if (!onlySymbols && !force && existing.has(ticker)) { skipped.push(ticker); continue; }
    const isCurrent = trs.some(t => t.end_date === null);
    if (isCurrent) current.push(ticker);
    else {
      // asof = 7 days BEFORE the latest in-window tramo's removal date:
      // Alpaca's asof mapping is exact-date, and ON the removal date the
      // ticker can already be dead/reassigned — asof=2018-11-06 for CA
      // (delisted that day) returns a zero-volume filler tape, while
      // asof=2018-10-30 returns the real 2016-2018 series. A week earlier
      // the company was still a member, so the mapping is always the right
      // company (verified: CA/MON/LVLT/FI).
      const last = trs[trs.length - 1];
      const asof = new Date(Date.parse(last.end_date!) - 7 * DAY).toISOString().slice(0, 10);
      retired.push({ ticker, asof });
    }
  }
  console.log(`skip (already in DB): ${skipped.length} | current to fetch: ${current.length} | retired to fetch (asof): ${retired.length}`);

  // ── fetch current members in batches of 50 ───────────────────────────
  const failures: Array<{ symbol: string; error: string }> = [];
  const realDiscontinuities: Array<{ symbol: string; events: string[] }> = [];
  let written = 0;
  const windowEndMs = Date.parse(todayKey) + DAY;
  const clipsOf = (sym: string): TramoClip[] =>
    (byTicker.get(sym) ?? []).map(t => ({
      fromMs: Math.max(Date.parse(t.start_date), Date.parse(WINDOW_START)),
      toMs: Math.min(t.end_date ? Date.parse(t.end_date) : Infinity, windowEndMs),
    })).filter(c => c.fromMs < c.toMs);
  const writeSeries = (sym: string, raw: BarRow[]) => {
    if (raw.length === 0) { failures.push({ symbol: sym, error: "no bars returned" }); return; }
    const prep = prepareMemberSeries(raw, clipsOf(sym));
    for (const n of prep.notes) console.log(`  ${sym.padEnd(6)} ${n}`);
    const bars = prep.bars;
    if (bars.length === 0) { failures.push({ symbol: sym, error: "no usable bars after preparation" }); return; }
    const v = validateAdjustedDailyBars(sym, bars, { maxFlatZeroVolumeRun: 4, maxAdjGapPct: MAX_ADJ_GAP_PCT });
    // Remaining gross discontinuities are REAL events (MRNA/ECHO/bankruptcy
    // tapes): write + report. Any OTHER validation failure skips the write.
    const nonDiscErrors = v.ok ? [] : v.errors.filter(e => !e.includes("gross discontinuity"));
    if (nonDiscErrors.length > 0) { failures.push({ symbol: sym, error: nonDiscErrors.join("; ") }); return; }
    if (prep.inSeriesDiscontinuities.length > 0) {
      realDiscontinuities.push({ symbol: sym, events: prep.inSeriesDiscontinuities });
      console.log(`  ${sym.padEnd(6)} kept ${prep.inSeriesDiscontinuities.length} in-series >75% event(s): ${prep.inSeriesDiscontinuities.join(", ")}`);
    }
    const r = replaceBars(sym, "1d", bars);
    if (r.error) { failures.push({ symbol: sym, error: r.error }); return; }
    written += r.written;
    console.log(`  ${sym.padEnd(6)} wrote ${r.written} bars (${new Date(bars[0].timestamp).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].timestamp).toISOString().slice(0, 10)})`);
  };

  for (let i = 0; i < current.length; i += 50) {
    const batch = current.slice(i, i + 50);
    try {
      const bySym = await fetchBars(batch, KEY, SEC, sipEnd);
      for (const sym of batch) writeSeries(sym, bySym[sym] ?? []);
    } catch (e: any) {
      console.error(`  batch FAILED (${batch[0]}…): ${e.message}`);
      failures.push(...batch.map(symbol => ({ symbol, error: `batch: ${e.message}` })));
    }
    console.log(`current batch ${Math.floor(i / 50) + 1}/${Math.ceil(current.length / 50)} done`);
  }

  // ── fetch retired tickers one by one with asof ───────────────────────
  for (let i = 0; i < retired.length; i++) {
    const { ticker, asof } = retired[i];
    try {
      let bySym = await fetchBars([ticker], KEY, SEC, sipEnd, asof);
      let bars = bySym[ticker] ?? [];
      if (bars.length === 0) {
        // Some tickers resolve directly (FB) but not under asof mapping
        // quirks — try the direct query before declaring it missing.
        bySym = await fetchBars([ticker], KEY, SEC, sipEnd);
        bars = bySym[ticker] ?? [];
        if (bars.length > 0) console.log(`  ${ticker.padEnd(6)} asof=${asof} empty, direct query used instead`);
      }
      writeSeries(ticker, bars);
    } catch (e: any) {
      console.error(`  ${ticker.padEnd(6)} FAILED: ${e.message}`);
      failures.push({ symbol: ticker, error: e.message });
    }
    if ((i + 1) % 25 === 0) console.log(`retired ${i + 1}/${retired.length} done`);
  }

  // ── per-tramo coverage report (expected sessions = SPY calendar) ─────
  const spy = (db.prepare(
    `SELECT timestamp FROM historical_bars WHERE symbol='SPY' AND timeframe='1d' AND source='alpaca_wide' ORDER BY timestamp ASC`,
  ).all() as Array<{ timestamp: number }>).map(r => r.timestamp);
  if (spy.length === 0) { console.error("no SPY calendar in DB — coverage report impossible"); process.exit(1); }
  const sessionsBetween = (fromMs: number, toMsEx: number) => spy.filter(t => t >= fromMs && t < toMsEx).length;

  interface TramoCoverage {
    ticker: string; start: string; end: string | null;
    clipFrom: string; clipTo: string;
    expectedSessions: number; actualSessions: number; missingSessions: number;
    note?: string;
  }
  const coverage: TramoCoverage[] = [];
  const barCount = db.prepare(
    `SELECT COUNT(*) n, MIN(timestamp) a, MAX(timestamp) b FROM historical_bars
     WHERE symbol=? AND timeframe='1d' AND source='alpaca_wide' AND timestamp >= ? AND timestamp < ?`,
  );
  for (const t of tramos) {
    const clipFromMs = Math.max(Date.parse(t.start_date), Date.parse(WINDOW_START));
    const clipToMs = Math.min(t.end_date ? Date.parse(t.end_date) : Infinity, Date.parse(todayKey) + DAY);
    const expected = sessionsBetween(clipFromMs, clipToMs);
    const row = barCount.get(t.ticker, clipFromMs, clipToMs) as { n: number; a: number | null; b: number | null };
    const multiTramo = (byTicker.get(t.ticker)?.length ?? 1) > 1;
    coverage.push({
      ticker: t.ticker, start: t.start_date, end: t.end_date,
      clipFrom: new Date(clipFromMs).toISOString().slice(0, 10),
      clipTo: clipToMs === Infinity ? todayKey : new Date(clipToMs).toISOString().slice(0, 10),
      expectedSessions: expected,
      actualSessions: row.n,
      missingSessions: Math.max(0, expected - row.n),
      ...(multiTramo && row.n === 0 ? { note: "reused/re-added ticker: tramo not covered by the stored (single-company) series — NOT mixed, by design" } : {}),
    });
  }
  const zero = coverage.filter(c => c.actualSessions === 0 && c.expectedSessions > 0);
  const thin = coverage.filter(c => c.actualSessions > 0 && c.missingSessions > 5);
  const report = {
    generatedAt: new Date().toISOString(),
    windowStart: WINDOW_START,
    sipEnd,
    tramos: coverage.length,
    fullyCovered: coverage.filter(c => c.missingSessions <= 5).length,
    zeroBarTramos: zero,
    thinTramos: thin,
    fetchFailures: failures,
    inSeriesDiscontinuities: realDiscontinuities,
    barsWritten: written,
  };
  mkdirSync("data/backtests", { recursive: true });
  writeFileSync("data/backtests/sp500-members-coverage.json", JSON.stringify(report, null, 2));
  console.log(`\nwrote ${written} bars. coverage: ${report.fullyCovered}/${coverage.length} tramos within 5 sessions of the SPY calendar`);
  console.log(`tramos with ZERO bars (${zero.length}): ${zero.map(z => `${z.ticker}[${z.clipFrom}→${z.clipTo}]`).join(" ") || "none"}`);
  console.log(`tramos missing >5 sessions (${thin.length}): ${thin.map(z => `${z.ticker}:${z.missingSessions}`).join(" ") || "none"}`);
  console.log(`fetch/validation failures (${failures.length}): ${failures.map(f => f.symbol).join(" ") || "none"}`);
  console.log(`report: data/backtests/sp500-members-coverage.json`);

  closeHistoricalStore();
}
