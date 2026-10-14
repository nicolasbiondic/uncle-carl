#!/usr/bin/env bun
/**
 * Line A data pipeline: point-in-time Binance USDT-M perp history (including
 * delisted contracts) from data.binance.vision into the research DB
 * hist-perps.db in the research data dir (scripts/lib/researchData.ts:
 * $UC_RESEARCH_DATA_DIR, default ~/code/wt/data — OUTSIDE the repo, never
 * touches data/historical.db).
 *
 * Tables (historical_bars / funding_rates use the exact historical.db DDL so
 * scripts/backtest-momentum-wf.ts `loadBars` and walk-forward's
 * hashDataSnapshot work unchanged; source = "binance_vision_um"):
 *   - historical_bars: 1d klines for EVERY USDT-M perp ever listed, 1h
 *     klines for every symbol that is ever a member of the monthly PIT
 *     universe (scripts/lib/xsls-universe.ts) ∪ BTCUSDT (benchmark).
 *   - quote_volume_1d: daily quoted volume (ranking input for membership).
 *   - funding_rates: real settled funding for every symbol ever listed
 *     (monthly zips) + current-month top-up from fapi REST for members.
 *   - download_log: idempotency + gap documentation (ok/404 per URL).
 *
 * Monthly zips for complete months; the current month comes from the daily
 * zips (klines) and from fapi/v1/fundingRate (funding — binance.vision has
 * no daily funding dumps).
 *
 * Usage:
 *   bun scripts/fetch-binance-perps-vision.ts 1d        # all symbols, daily klines (monthly + current-month daily)
 *   bun scripts/fetch-binance-perps-vision.ts funding   # all symbols, monthly funding zips
 *   bun scripts/fetch-binance-perps-vision.ts 1h        # PIT members ∪ BTCUSDT, hourly klines
 *   bun scripts/fetch-binance-perps-vision.ts funding-rest  # current-month funding via fapi for members ∪ BTCUSDT
 *   bun scripts/fetch-binance-perps-vision.ts coverage  # coverage/gap report → ../data/hist-perps-coverage.json
 */

import { Database } from "bun:sqlite";
import { computeMonthlyMembership, DEFAULT_MEMBERSHIP, isEligibleSymbol } from "./lib/xsls-universe";
import { researchDataPath } from "./lib/researchData";

const DB_PATH = researchDataPath("hist-perps.db");
const SOURCE = "binance_vision_um";
const S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const DL = "https://data.binance.vision";
const CONCURRENCY = 32;

const db = new Database(DB_PATH, { create: true });
db.exec(`
  PRAGMA journal_mode = WAL;
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
  CREATE TABLE IF NOT EXISTS quote_volume_1d (
    symbol    TEXT    NOT NULL,
    timestamp INTEGER NOT NULL,
    quote_volume REAL NOT NULL,
    PRIMARY KEY (symbol, timestamp)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS funding_rates (
    symbol TEXT NOT NULL,
    funding_time INTEGER NOT NULL,
    rate REAL NOT NULL,
    PRIMARY KEY (symbol, funding_time)
  );
  CREATE TABLE IF NOT EXISTS download_log (
    url TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    rows INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL
  );
`);

// ── S3 listing (marker pagination) ─────────────────────────────────────
async function s3List(prefix: string): Promise<{ prefixes: string[]; keys: string[] }> {
  const prefixes: string[] = [];
  const keys: string[] = [];
  let marker = "";
  for (;;) {
    const url = `${S3}?delimiter=/&prefix=${encodeURIComponent(prefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
    const res = await fetchRetry(url);
    const xml = await res.text();
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix>/g)) prefixes.push(m[1]);
    for (const m of xml.matchAll(/<Contents><Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!truncated) break;
    const lastKey = keys[keys.length - 1];
    const lastPrefix = prefixes[prefixes.length - 1];
    marker = [lastKey, lastPrefix].filter(Boolean).sort().pop() ?? "";
    if (!marker) break;
  }
  return { prefixes, keys };
}

async function fetchRetry(url: string, tries = 5): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return res;
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error(`fetch failed after ${tries} tries: ${url}: ${lastErr}`);
}

/** All USDT-M perp symbols ever listed (klines dir is the authority, incl. delisted). */
async function listAllSymbols(): Promise<string[]> {
  const { prefixes } = await s3List("data/futures/um/monthly/klines/");
  return prefixes
    .map(p => p.split("/").filter(Boolean).pop()!)
    .filter(s => /^[A-Z0-9]+USDT$/.test(s)); // USDT-quoted, no _YYMMDD delivery suffix
}

/** Unzip a fetched .zip (single CSV inside) via funzip. */
async function unzipCsv(buf: ArrayBuffer): Promise<string> {
  const proc = Bun.spawn(["funzip"], { stdin: new Uint8Array(buf), stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

const logged = new Set<string>(
  (db.prepare("SELECT url FROM download_log WHERE status IN ('ok','404')").all() as Array<{ url: string }>).map(r => r.url),
);
const logStmt = db.prepare("INSERT OR REPLACE INTO download_log (url, status, rows, fetched_at) VALUES (?, ?, ?, ?)");

const insBar = db.prepare(
  "INSERT OR REPLACE INTO historical_bars (symbol, timeframe, timestamp, open, high, low, close, volume, source) VALUES (?,?,?,?,?,?,?,?,?)",
);
const insQv = db.prepare("INSERT OR REPLACE INTO quote_volume_1d (symbol, timestamp, quote_volume) VALUES (?,?,?)");
const insFunding = db.prepare("INSERT OR REPLACE INTO funding_rates (symbol, funding_time, rate) VALUES (?,?,?)");

/** Binance epoch fields switched to microseconds in some 2025+ dumps. */
function normMs(t: number): number {
  return t > 1e14 ? Math.round(t / 1000) : t;
}

function ingestKlines(symbol: string, timeframe: string, csv: string): number {
  const lines = csv.split("\n");
  let n = 0;
  const tx = db.transaction(() => {
    for (const line of lines) {
      if (!line || line.startsWith("open_time")) continue;
      const f = line.split(",");
      if (f.length < 8) continue;
      const ts = normMs(Number(f[0]));
      if (!Number.isFinite(ts)) continue;
      insBar.run(symbol, timeframe, ts, Number(f[1]), Number(f[2]), Number(f[3]), Number(f[4]), Number(f[5]), SOURCE);
      if (timeframe === "1d") insQv.run(symbol, ts, Number(f[7]));
      n++;
    }
  });
  tx();
  return n;
}

function ingestFunding(symbol: string, csv: string): number {
  const lines = csv.split("\n");
  let n = 0;
  const tx = db.transaction(() => {
    for (const line of lines) {
      if (!line || line.startsWith("calc_time")) continue;
      const f = line.split(",");
      if (f.length < 3) continue;
      const ts = normMs(Number(f[0]));
      const rate = Number(f[2]);
      if (!Number.isFinite(ts) || !Number.isFinite(rate)) continue;
      insFunding.run(symbol, ts, rate);
      n++;
    }
  });
  tx();
  return n;
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  let done = 0;
  const t0 = Date.now();
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx]);
      done++;
      if (done % 500 === 0) {
        console.log(`  ${done}/${items.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    }
  });
  await Promise.all(runners);
}

interface FileTask { url: string; symbol: string; kind: "1d" | "1h" | "funding" }

async function downloadTask(t: FileTask): Promise<void> {
  if (logged.has(t.url)) return;
  const res = await fetchRetry(t.url);
  if (res.status === 404) {
    logStmt.run(t.url, "404", 0, Date.now());
    logged.add(t.url);
    return;
  }
  const csv = await unzipCsv(await res.arrayBuffer());
  const n = t.kind === "funding" ? ingestFunding(t.symbol, csv) : ingestKlines(t.symbol, t.kind, csv);
  logStmt.run(t.url, "ok", n, Date.now());
  logged.add(t.url);
}

/** Zip keys under a prefix (skips .CHECKSUM). */
async function zipKeys(prefix: string): Promise<string[]> {
  const { keys } = await s3List(prefix);
  return keys.filter(k => k.endsWith(".zip"));
}

/** "YYYY-MM" of the current UTC month — the only month served by the DAILY
 *  dumps that the monthly dumps don't already cover. */
const CURRENT_MONTH = new Date().toISOString().slice(0, 7);

/** Daily-dump zips restricted to the current month (complete months come
 *  from the monthly dumps; downloading every historical daily file would be
 *  ~700k requests for nothing). */
async function currentMonthDailyKeys(prefix: string): Promise<string[]> {
  const keys = await zipKeys(prefix);
  return keys.filter(k => k.includes(`-${CURRENT_MONTH}-`));
}

async function phase1d(): Promise<void> {
  const symbols = await listAllSymbols();
  console.log(`1d phase: ${symbols.length} USDT-M perp symbols (incl. delisted)`);
  const tasks: FileTask[] = [];
  await pool(symbols, async sym => {
    const monthly = await zipKeys(`data/futures/um/monthly/klines/${sym}/1d/`);
    const daily = await currentMonthDailyKeys(`data/futures/um/daily/klines/${sym}/1d/`);
    for (const k of [...monthly, ...daily]) tasks.push({ url: `${DL}/${k}`, symbol: sym, kind: "1d" });
  });
  console.log(`1d phase: ${tasks.length} files`);
  await pool(tasks, downloadTask);
  console.log("1d phase done");
}

async function phaseFunding(): Promise<void> {
  const symbols = await listAllSymbols();
  const tasks: FileTask[] = [];
  await pool(symbols, async sym => {
    const monthly = await zipKeys(`data/futures/um/monthly/fundingRate/${sym}/`);
    for (const k of monthly) tasks.push({ url: `${DL}/${k}`, symbol: sym, kind: "funding" });
  });
  console.log(`funding phase: ${tasks.length} files`);
  await pool(tasks, downloadTask);
  console.log("funding phase done");
}

function memberUnion(): string[] {
  const months = computeMonthlyMembership(db, Date.parse("2020-06-01"), Date.now(), DEFAULT_MEMBERSHIP);
  const union = new Set<string>();
  for (const m of months) for (const s of m.symbols) union.add(s);
  union.add("BTCUSDT"); // benchmark refSymbol
  console.log(`membership: ${months.length} months, union ${union.size} symbols`);
  return [...union].sort();
}

async function phase1h(): Promise<void> {
  const symbols = memberUnion();
  const tasks: FileTask[] = [];
  await pool(symbols, async sym => {
    const monthly = await zipKeys(`data/futures/um/monthly/klines/${sym}/1h/`);
    const daily = await currentMonthDailyKeys(`data/futures/um/daily/klines/${sym}/1h/`);
    for (const k of [...monthly, ...daily]) tasks.push({ url: `${DL}/${k}`, symbol: sym, kind: "1h" });
  });
  console.log(`1h phase: ${tasks.length} files for ${symbols.length} symbols`);
  await pool(tasks, downloadTask);
  console.log("1h phase done");
}

/** Current-month funding top-up from fapi (binance.vision has no daily funding dumps). */
async function phaseFundingRest(): Promise<void> {
  const symbols = memberUnion();
  const start = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
  let total = 0;
  await pool(symbols, async sym => {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${start}&limit=1000`;
    const res = await fetchRetry(url);
    if (!res.ok) return;
    const rows = (await res.json()) as Array<{ fundingTime: number; fundingRate: string }>;
    const tx = db.transaction(() => {
      for (const r of rows) {
        if (!Number.isFinite(Number(r.fundingRate))) continue;
        insFunding.run(sym, r.fundingTime, Number(r.fundingRate));
        total++;
      }
    });
    tx();
  });
  console.log(`funding-rest: upserted ${total} current-month settlements`);
}

/**
 * Fill 1h gaps left by incomplete MONTHLY zips (e.g. several symbols miss
 * 2022-02-26..28) from the per-day DAILY dumps. A 404 for a missing day is a
 * genuine halt/delisting window (e.g. BNX redenomination 2023-02) and stays
 * a hole — the kernel's freshness checks handle those.
 */
async function phaseGapfill(): Promise<void> {
  const symbols = (db.prepare("SELECT DISTINCT symbol FROM historical_bars WHERE timeframe='1h'").all() as Array<{ symbol: string }>).map(r => r.symbol);
  const tasks: FileTask[] = [];
  for (const sym of symbols) {
    const ts = (db.prepare("SELECT timestamp FROM historical_bars WHERE symbol=? AND timeframe='1h' ORDER BY timestamp").all(sym) as Array<{ timestamp: number }>).map(r => r.timestamp);
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] - ts[i - 1] <= 3_600_000) continue;
      for (let d = Math.floor((ts[i - 1] + 3_600_000) / 86_400_000) * 86_400_000; d < ts[i]; d += 86_400_000) {
        const day = new Date(d).toISOString().slice(0, 10);
        tasks.push({ url: `${DL}/data/futures/um/daily/klines/${sym}/1h/${sym}-1h-${day}.zip`, symbol: sym, kind: "1h" });
      }
    }
  }
  console.log(`gapfill: ${tasks.length} candidate day files`);
  await pool(tasks, downloadTask);
  const miss = (db.prepare("SELECT COUNT(*) n FROM download_log WHERE status='404'").get() as any).n;
  console.log(`gapfill done (${miss} total 404s = genuine halts)`);
}

function phaseCoverage(): void {
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), dbPath: DB_PATH, source: SOURCE };
  const tfStats = db.prepare(`
    SELECT timeframe, COUNT(DISTINCT symbol) syms, COUNT(*) rows, MIN(timestamp) first, MAX(timestamp) last
    FROM historical_bars GROUP BY timeframe
  `).all() as Array<{ timeframe: string; syms: number; rows: number; first: number; last: number }>;
  report.bars = tfStats.map(r => ({ ...r, first: new Date(r.first).toISOString(), last: new Date(r.last).toISOString() }));
  const fu = db.prepare("SELECT COUNT(DISTINCT symbol) syms, COUNT(*) rows, MIN(funding_time) first, MAX(funding_time) last FROM funding_rates").get() as any;
  report.funding = { ...fu, first: new Date(fu.first).toISOString(), last: new Date(fu.last).toISOString() };
  report.log404 = (db.prepare("SELECT COUNT(*) n FROM download_log WHERE status='404'").get() as any).n;

  // 1h gap scan per symbol: count internal gaps > 1h between consecutive bars.
  const symbols = (db.prepare("SELECT DISTINCT symbol FROM historical_bars WHERE timeframe='1h'").all() as Array<{ symbol: string }>).map(r => r.symbol);
  const gaps: Array<{ symbol: string; bars: number; firstBar: string; lastBar: string; gapCount: number; maxGapHours: number }> = [];
  for (const sym of symbols) {
    const ts = (db.prepare("SELECT timestamp FROM historical_bars WHERE symbol=? AND timeframe='1h' ORDER BY timestamp").all(sym) as Array<{ timestamp: number }>).map(r => r.timestamp);
    let gapCount = 0;
    let maxGap = 0;
    for (let i = 1; i < ts.length; i++) {
      const g = ts[i] - ts[i - 1];
      if (g > 3_600_000) {
        gapCount++;
        if (g > maxGap) maxGap = g;
      }
    }
    gaps.push({
      symbol: sym,
      bars: ts.length,
      firstBar: new Date(ts[0]).toISOString(),
      lastBar: new Date(ts[ts.length - 1]).toISOString(),
      gapCount,
      maxGapHours: Math.round(maxGap / 3_600_000),
    });
  }
  report.hourly = gaps.sort((a, b) => b.gapCount - a.gapCount);

  // Membership summary
  const months = computeMonthlyMembership(db, Date.parse("2020-06-01"), Date.now(), DEFAULT_MEMBERSHIP);
  report.membership = {
    params: DEFAULT_MEMBERSHIP,
    months: months.map(m => ({ month: m.month, n: m.symbols.length, top5: m.symbols.slice(0, 5) })),
    unionSize: new Set(months.flatMap(m => m.symbols)).size,
  };

  const out = researchDataPath("hist-perps-coverage.json");
  Bun.write(out, JSON.stringify(report, null, 2));
  console.log(`coverage report → ${out}`);
  const totalGaps = gaps.reduce((s, g) => s + g.gapCount, 0);
  console.log(`1h symbols: ${gaps.length}, total internal gaps >1h: ${totalGaps}`);
}

const phase = process.argv[2];
if (phase === "1d") await phase1d();
else if (phase === "funding") await phaseFunding();
else if (phase === "1h") await phase1h();
else if (phase === "funding-rest") await phaseFundingRest();
else if (phase === "gapfill") await phaseGapfill();
else if (phase === "coverage") phaseCoverage();
else {
  console.error("Usage: bun scripts/fetch-binance-perps-vision.ts <1d|funding|1h|funding-rest|coverage>");
  process.exit(1);
}
db.close();
