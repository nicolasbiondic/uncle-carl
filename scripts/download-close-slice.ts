#!/usr/bin/env bun
/**
 * Líneas G0/G (docs/reports/V-plan-volumen-rentabilidad.md §12-septies):
 * download, for EVERY symbol that has alpaca_wide 1d bars in hist-sp500.db
 * and EVERY session from SPY's daily bars 2016-01-04 → 2026-10-01, the SIP
 * 15-minute bar that STARTS 30 minutes before that session's close
 * (15:30 ET normally, 12:30 ET on early-close days — getSessionClose,
 * DST-safe via America/New_York) into a NEW database OUTSIDE the repo:
 * $UC_RESEARCH_DATA_DIR/hist-sp500-close.db.
 *
 * ADJUSTMENT CONSISTENCY (the §12-septies mandate): the 15:45 price must be
 * on the SAME split/dividend basis as the daily closes it is compared with
 * (hist-sp500.db, adjustment=all, downloaded 2026-10-08). Downloading the
 * intraday bars with adjustment=all TODAY would use TODAY's factors —
 * dividends that went ex since 2026-10-08 would silently shift the basis.
 * Instead BOTH the 15-minute slice and the session's daily close are
 * downloaded RAW (raw prints are immutable), and the replay computes
 *   p1545_adj = adjClose(hist-sp500.db) × raw1545 / rawClose
 * — the intraday ratio is adjustment-free (no split/dividend happens inside
 * a session), so the product is exactly on the dailies' basis. Proven on
 * split days (NVDA 2024-06-10, AAPL 2020-08-31, TSLA 2022-08-25) by
 * scripts/download-close-slice.test.ts + the spot checks in
 * docs/reports/LG-reversion-al-cierre.md.
 *
 * Request shape (pre-registered): ONE multi-symbol request per session per
 * kind, symbols chunked so the URL stays < ~6 KB; feed=sip; < 150 req/min.
 * Resumable: download_log(kind, session) marks a session done only after
 * its rows are committed in one transaction; re-running skips done sessions.
 *
 * Auth: ALPACA_API_KEY / ALPACA_SECRET_KEY from the env (source the main
 * checkout's .env). Keys are never printed.
 *
 * Usage: bun run scripts/download-close-slice.ts [--from 2016-01-04] [--to 2026-10-01]
 */
import { Database } from "bun:sqlite";
import { getETDateKey } from "../src/db/database";
import { getSessionClose } from "../src/utils/marketHours";
import { researchDataPath } from "./lib/researchData";

const SRC_DB = researchDataPath("hist-sp500.db");
const OUT_DB = researchDataPath("hist-sp500-close.db");
const MAX_SYMBOLS_URL_BYTES = 5_500; // whole URL stays < ~6 KB
const MAX_REQ_PER_MIN = 145;

// ── pure helpers (tested in download-close-slice.test.ts) ────────────────

const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

/** ET wall-clock (dateKey, minutes since midnight) → epoch ms, DST-safe:
 *  try the two possible ET offsets (EST −5, EDT −4) and keep the candidate
 *  whose America/New_York rendering matches the requested wall time. */
export function etWallTimeToUtcMs(dateKey: string, minutes: number): number {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  for (const offset of ["-05:00", "-04:00"]) {
    const ts = Date.parse(`${dateKey}T${hh}:${mm}:00${offset}`);
    const parts: any = Object.fromEntries(ET_FMT.formatToParts(new Date(ts)).map(p => [p.type, p.value]));
    const gotKey = `${parts.year}-${parts.month}-${parts.day}`;
    const gotHour = parts.hour === "24" ? 0 : Number(parts.hour);
    if (gotKey === dateKey && gotHour === Math.floor(minutes / 60) && Number(parts.minute) === minutes % 60) return ts;
  }
  throw new Error(`etWallTimeToUtcMs: no ET offset renders ${dateKey} ${hh}:${mm}`);
}

/** Start of the SIP 15-minute bar that begins 30 minutes before the
 *  session's close: 15:30 ET normally, 12:30 ET on early-close days. */
export function sliceStartMs(dateKey: string): number {
  const { closeMinutes } = getSessionClose(dateKey);
  return etWallTimeToUtcMs(dateKey, closeMinutes - 30);
}

/** Chunk symbols so the URL-encoded `symbols` param ("," → %2C, 3 bytes)
 *  stays under maxBytes per request. */
export function chunkSymbols(symbols: string[], maxBytes = MAX_SYMBOLS_URL_BYTES): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const s of symbols) {
    const add = s.length + (cur.length > 0 ? 3 : 0); // %2C separator
    if (cur.length > 0 && len + add > maxBytes) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += add;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Extract, per symbol, the close of the bar stamped exactly at wantMs.
 *  Any other bar in the response window is ignored (fail-safe: no bar at
 *  the slice start = no 15:45 price that session). */
export function pickBarAt(bars: Record<string, Array<{ t: string; c: number }>> | undefined, wantMs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [sym, arr] of Object.entries(bars ?? {})) {
    for (const b of arr ?? []) {
      if (Date.parse(b.t) === wantMs && Number.isFinite(b.c) && b.c > 0) out.set(sym, b.c);
    }
  }
  return out;
}

/** First bar per symbol inside the session (daily request returns exactly
 *  one 1Day bar; timestamp varies by venue convention, so match the ET
 *  date instead of an exact stamp). */
export function pickDailyBar(bars: Record<string, Array<{ t: string; c: number }>> | undefined, session: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [sym, arr] of Object.entries(bars ?? {})) {
    for (const b of arr ?? []) {
      if (getETDateKey(Date.parse(b.t)) === session && Number.isFinite(b.c) && b.c > 0 && !out.has(sym)) out.set(sym, b.c);
    }
  }
  return out;
}

/** The §12-septies basis formula: adjusted 15:45 price = adjusted close ×
 *  (raw 15:45 / raw close). Null when any input is unusable. */
export function adjusted1545(adjClose: number, raw1545: number, rawClose: number): number | null {
  if (!(adjClose > 0) || !(raw1545 > 0) || !(rawClose > 0)) return null;
  return adjClose * (raw1545 / rawClose);
}

export function initCloseSliceDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS close_slices (
      symbol TEXT NOT NULL,
      session TEXT NOT NULL,
      slice_start_ms INTEGER NOT NULL,
      raw_c1545 REAL NOT NULL,
      PRIMARY KEY (symbol, session)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS raw_daily_closes (
      symbol TEXT NOT NULL,
      session TEXT NOT NULL,
      raw_close REAL NOT NULL,
      PRIMARY KEY (symbol, session)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS download_log (
      kind TEXT NOT NULL,
      session TEXT NOT NULL,
      status TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (kind, session)
    ) WITHOUT ROWID;
  `);
  return db;
}

// ── main ──────────────────────────────────────────────────────────────────

/** Minimal client-side limiter: sliding 60s window capped at MAX_REQ_PER_MIN. */
const reqTimes: number[] = [];
async function throttle(): Promise<void> {
  const now = Date.now();
  while (reqTimes.length > 0 && reqTimes[0] < now - 60_000) reqTimes.shift();
  if (reqTimes.length >= MAX_REQ_PER_MIN) {
    await Bun.sleep(reqTimes[0] + 60_500 - now);
  }
  reqTimes.push(Date.now());
}

async function fetchBars(
  KEY: string, SEC: string,
  symbols: string[], timeframe: string, startIso: string, endIso: string,
): Promise<Record<string, Array<{ t: string; c: number }>>> {
  const merged: Record<string, Array<{ t: string; c: number }>> = {};
  let pageToken: string | undefined;
  do {
    const u = new URL("https://data.alpaca.markets/v2/stocks/bars");
    u.searchParams.set("symbols", symbols.join(","));
    u.searchParams.set("timeframe", timeframe);
    u.searchParams.set("start", startIso);
    u.searchParams.set("end", endIso);
    u.searchParams.set("adjustment", "raw");
    u.searchParams.set("feed", "sip");
    u.searchParams.set("limit", "10000");
    if (pageToken) u.searchParams.set("page_token", pageToken);
    await throttle();
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(u, { headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC } });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) { await Bun.sleep(10_000); continue; }
      break;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j: any = await res.json();
    for (const [sym, arr] of Object.entries(j.bars ?? {})) {
      (merged[sym] ??= []).push(...(arr as any[]));
    }
    pageToken = j.next_page_token ?? undefined;
  } while (pageToken);
  return merged;
}

if (import.meta.main) {
  const KEY = process.env.ALPACA_API_KEY, SEC = process.env.ALPACA_SECRET_KEY;
  if (!KEY || !SEC) { console.error("missing ALPACA_API_KEY/ALPACA_SECRET_KEY in env"); process.exit(1); }
  const args = process.argv.slice(2);
  const argVal = (flag: string, dflt: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const fromKey = argVal("--from", "2016-01-04");
  const toKey = argVal("--to", "2026-10-01");

  const src = new Database(SRC_DB, { readonly: true });
  const symbols = (src.prepare(
    `SELECT DISTINCT symbol FROM historical_bars WHERE source = 'alpaca_wide' AND timeframe = '1d' ORDER BY symbol ASC`,
  ).all() as Array<{ symbol: string }>).map(r => r.symbol);
  const sessions = (src.prepare(
    `SELECT timestamp FROM historical_bars WHERE symbol = 'SPY' AND source = 'alpaca_wide' AND timeframe = '1d' ORDER BY timestamp ASC`,
  ).all() as Array<{ timestamp: number }>)
    .map(r => getETDateKey(r.timestamp))
    .filter(k => k >= fromKey && k <= toKey);
  src.close();

  const out = initCloseSliceDb(OUT_DB);
  const isDone = out.prepare(`SELECT 1 FROM download_log WHERE kind = ? AND session = ?`);
  const markDone = out.prepare(`INSERT OR REPLACE INTO download_log (kind, session, status, fetched_at) VALUES (?, ?, 'done', ?)`);
  const upsertSlice = out.prepare(`INSERT OR REPLACE INTO close_slices (symbol, session, slice_start_ms, raw_c1545) VALUES (?, ?, ?, ?)`);
  const upsertDaily = out.prepare(`INSERT OR REPLACE INTO raw_daily_closes (symbol, session, raw_close) VALUES (?, ?, ?)`);
  const chunks = chunkSymbols(symbols);
  console.log(`close-slice download: ${symbols.length} symbols (${chunks.length} chunk(s)/request-kind), ${sessions.length} sessions ${fromKey}..${toKey} → ${OUT_DB}`);

  let done = 0;
  const failures: string[] = [];
  for (const session of sessions) {
    for (const kind of ["slice", "raw1d"] as const) {
      if (isDone.get(kind, session)) continue;
      try {
        const rows = new Map<string, number>();
        if (kind === "slice") {
          const startMs = sliceStartMs(session);
          const startIso = new Date(startMs).toISOString();
          const endIso = new Date(startMs + 15 * 60_000).toISOString();
          for (const chunk of chunks) {
            const bars = await fetchBars(KEY, SEC, chunk, "15Min", startIso, endIso);
            for (const [sym, c] of pickBarAt(bars, startMs)) rows.set(sym, c);
          }
          out.transaction(() => {
            for (const [sym, c] of rows) upsertSlice.run(sym, session, startMs, c);
            markDone.run(kind, session, Date.now());
          })();
        } else {
          const startIso = new Date(etWallTimeToUtcMs(session, 0)).toISOString();
          const endIso = new Date(etWallTimeToUtcMs(session, 23 * 60 + 59)).toISOString();
          for (const chunk of chunks) {
            const bars = await fetchBars(KEY, SEC, chunk, "1Day", startIso, endIso);
            for (const [sym, c] of pickDailyBar(bars, session)) rows.set(sym, c);
          }
          out.transaction(() => {
            for (const [sym, c] of rows) upsertDaily.run(sym, session, c);
            markDone.run(kind, session, Date.now());
          })();
        }
      } catch (e: any) {
        console.error(`  ${session} ${kind} FAILED: ${e.message}`);
        failures.push(`${session}:${kind}`);
      }
    }
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${sessions.length} sessions (${new Date().toISOString()})`);
  }

  const nSlices = (out.prepare(`SELECT COUNT(*) n FROM close_slices`).get() as { n: number }).n;
  const nDaily = (out.prepare(`SELECT COUNT(*) n FROM raw_daily_closes`).get() as { n: number }).n;
  const nSessions = (out.prepare(`SELECT COUNT(DISTINCT session) n FROM close_slices`).get() as { n: number }).n;
  console.log(`\nslices: ${nSlices} rows over ${nSessions} sessions; raw daily closes: ${nDaily} rows`);
  out.close();
  if (failures.length > 0) {
    console.error(`FAILED (resumable — rerun to retry): ${failures.length} session-kinds, first: ${failures.slice(0, 5).join(", ")}`);
    process.exit(1);
  }
}
