#!/usr/bin/env bun
/**
 * Vega phase R (quorum Q9, experiments/options-vega-r-v1.json data.secondProvider), step 2: the second
 * provider. READ-ONLY market-data GETs plus GET /v2/options/contracts (paper keys from .env); never an
 * order, never an account endpoint.
 *
 * For every week with an entry >= 2024-02-02 whose exit <= min(2026-11-06, last SPY session in
 * data/historical.db), and for SPY and QQQ:
 *   1. raw close at entry: the mirror's underlying_daily through the mirror, Alpaca raw daily bars
 *      (adjustment=raw, SIP) after it — stored in alpaca_underlying_daily from 2024-01-01 so the two
 *      sources can be compared on the overlap;
 *   2. listed expirations at entry: the mirror's (through its last date) or GET /v2/options/contracts
 *      for expirations in (entry, entry + 5 sessions] (stored in alpaca_listed) — the frozen calendar
 *      rule picks the eligible E;
 *   3. contracts of E, puts and calls, strike in [0.85, 1.15] × raw close (alpaca_contracts);
 *   4. their 1Day bars from entry to the expiration session (alpaca_option_bars).
 * Also SPY/QQQ cash dividends (ex-dates) after the mirror, for the early-assignment diagnostic.
 *
 * Resumable: a (underlying, entry) with status done in alpaca_weeks is skipped. <= 180 requests/min.
 * Usage: bun run scripts/download-alpaca-option-bars.ts [--from 2024-02-02] [--to 2026-11-06]
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWeeks, eligibleExpiration, type Session } from "./lib/optionsWeekly";
import { alpacaRawCloses, buildSessions, historicalAdjustedCloses, mirrorLastOptionsDate, mirrorListed, mirrorUnderlying, openOptionsDb, UNDERLYINGS } from "./lib/optionsData";

const ROOT = join(import.meta.dir, "..");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "experiments/options-vega-r-v1.json"), "utf8"));
const STRIKE_BAND = [0.85, 1.15] as const;
const MIN_SPACING_MS = 340; // <= 180 requests/min

const KEY = process.env.ALPACA_API_KEY, SEC = process.env.ALPACA_SECRET_KEY;
const H = { "APCA-API-KEY-ID": KEY ?? "", "APCA-API-SECRET-KEY": SEC ?? "" };
let lastRequest = 0, requests = 0;

async function get(url: URL): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + MIN_SPACING_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    lastRequest = Date.now(); requests++;
    const res = await fetch(url, { headers: H });
    if (res.status === 429 && attempt < 6) { await Bun.sleep(10_000 * (attempt + 1)); continue; }
    if ((res.status >= 500 || res.status === 408) && attempt < 4) { await Bun.sleep(3_000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.pathname}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

function etDate(iso: string): Session {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function fetchRawUnderlying(db: Database, from: string, to: string): Promise<void> {
  const ins = db.prepare("INSERT OR REPLACE INTO alpaca_underlying_daily VALUES (?,?,?,?,?,?,?)");
  let token: string | undefined;
  let n = 0;
  do {
    const u = new URL("https://data.alpaca.markets/v2/stocks/bars");
    u.searchParams.set("symbols", UNDERLYINGS.join(","));
    u.searchParams.set("timeframe", "1Day"); u.searchParams.set("adjustment", "raw"); u.searchParams.set("feed", "sip");
    u.searchParams.set("start", from); u.searchParams.set("end", to); u.searchParams.set("limit", "10000");
    if (token) u.searchParams.set("page_token", token);
    const j = await get(u);
    db.transaction(() => {
      for (const [sym, bars] of Object.entries(j.bars ?? {}) as [string, any[]][]) for (const b of bars) { ins.run(sym, etDate(b.t), b.o, b.h, b.l, b.c, b.v); n++; }
    })();
    token = j.next_page_token ?? undefined;
  } while (token);
  console.log(`raw underlying bars: ${n} rows ${from} → ${to}`);
}

async function fetchDividends(db: Database, from: string, to: string): Promise<void> {
  const ins = db.prepare("INSERT OR REPLACE INTO alpaca_dividends VALUES (?,?,?)");
  let token: string | undefined, n = 0;
  do {
    const u = new URL("https://data.alpaca.markets/v1/corporate-actions");
    u.searchParams.set("symbols", UNDERLYINGS.join(",")); u.searchParams.set("types", "cash_dividend");
    u.searchParams.set("start", from); u.searchParams.set("end", to); u.searchParams.set("limit", "1000");
    if (token) u.searchParams.set("page_token", token);
    const j = await get(u);
    for (const d of j.corporate_actions?.cash_dividends ?? []) { ins.run(d.symbol, d.ex_date, d.rate); n++; }
    token = j.next_page_token ?? undefined;
  } while (token);
  console.log(`cash dividends: ${n} rows ${from} → ${to}`);
}

interface Contract { symbol: string; expiration: string; type: "call" | "put"; strike: number }

async function fetchContracts(underlying: string, expGte: string, expLte: string): Promise<Contract[]> {
  const out: Contract[] = [];
  for (const status of ["inactive", "active"]) {
    let token: string | undefined;
    do {
      const u = new URL("https://paper-api.alpaca.markets/v2/options/contracts");
      u.searchParams.set("underlying_symbols", underlying);
      u.searchParams.set("expiration_date_gte", expGte); u.searchParams.set("expiration_date_lte", expLte);
      u.searchParams.set("status", status); u.searchParams.set("limit", "10000");
      if (token) u.searchParams.set("page_token", token);
      const j = await get(u);
      for (const c of j.option_contracts ?? []) out.push({ symbol: c.symbol, expiration: c.expiration_date, type: c.type, strike: Number(c.strike_price) });
      token = j.next_page_token ?? undefined;
    } while (token);
  }
  return out;
}

async function fetchBars(db: Database, symbols: string[], start: string, end: string): Promise<number> {
  const ins = db.prepare("INSERT OR REPLACE INTO alpaca_option_bars VALUES (?,?,?,?,?,?,?,?,?)");
  let n = 0;
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    let token: string | undefined;
    do {
      const u = new URL("https://data.alpaca.markets/v1beta1/options/bars");
      u.searchParams.set("symbols", batch.join(",")); u.searchParams.set("timeframe", "1Day");
      u.searchParams.set("start", start); u.searchParams.set("end", end); u.searchParams.set("limit", "10000");
      if (token) u.searchParams.set("page_token", token);
      const j = await get(u);
      db.transaction(() => {
        for (const [sym, bars] of Object.entries(j.bars ?? {}) as [string, any[]][]) for (const b of bars) { ins.run(sym, etDate(b.t), b.o, b.h, b.l, b.c, b.v, b.n, b.vw); n++; }
      })();
      token = j.next_page_token ?? undefined;
    } while (token);
  }
  return n;
}

if (import.meta.main) {
  if (!KEY || !SEC) { console.error("missing ALPACA_API_KEY/ALPACA_SECRET_KEY in env"); process.exit(1); }
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const from = arg("--from", MANIFEST.windows.overlap.match(/\d{4}-\d{2}-\d{2}/)![0]);
  const toCap = arg("--to", "2026-11-06");

  const db = openOptionsDb(MANIFEST.data.primary.dbPath, false);
  const mirrorSpy = mirrorUnderlying(db, "SPY");
  const historicalSpy = historicalAdjustedCloses(join(ROOT, "data/historical.db"), "SPY");
  const sessions = buildSessions(mirrorSpy, historicalSpy);
  const lastSession = sessions[sessions.length - 1];
  const to = toCap < lastSession ? toCap : lastSession;
  const mirrorLast = Object.fromEntries(UNDERLYINGS.map(u => [u, mirrorLastOptionsDate(db, u)]));
  console.log(`sessions ${sessions[0]} → ${lastSession} (${sessions.length}); mirror last options date ${JSON.stringify(mirrorLast)}; entries ${from} → exits <= ${to}`);

  await fetchRawUnderlying(db, "2024-01-01", lastSession);
  await fetchDividends(db, "2024-01-01", lastSession);
  const raw = Object.fromEntries(UNDERLYINGS.map(u => [u, alpacaRawCloses(db, u)]));
  const mirrorRaw = Object.fromEntries(UNDERLYINGS.map(u => [u, new Map(mirrorUnderlying(db, u).map(r => [r.date, r.close]))]));

  const weeks = buildWeeks(sessions).filter(w => w.entry >= from && w.entry <= to);
  const done = new Set(db.query<{ k: string }, []>("SELECT underlying || '|' || entry k FROM alpaca_weeks WHERE status = 'done'").all().map(r => r.k));
  const upsertWeek = db.prepare("INSERT OR REPLACE INTO alpaca_weeks VALUES (?,?,?,?,?,?,?,?,?)");
  const insListed = db.prepare("INSERT OR REPLACE INTO alpaca_listed VALUES (?,?,?)");
  const insContract = db.prepare("INSERT OR REPLACE INTO alpaca_contracts VALUES (?,?,?,?,?)");
  let fetched = 0, skipped = 0;
  const t0 = Date.now();

  for (const w of weeks) {
    const i0 = sessions.indexOf(w.entry);
    const horizon = sessions[Math.min(sessions.length - 1, i0 + 5)];
    if (i0 + 5 > sessions.length - 1) { console.log(`${w.entry}: horizon beyond the session list, stop`); break; }
    for (const u of UNDERLYINGS) {
      if (done.has(`${u}|${w.entry}`)) { skipped++; continue; }
      const now = new Date().toISOString();
      const S = w.entry <= mirrorLast[u] ? mirrorRaw[u].get(w.entry) : raw[u].get(w.entry);
      if (S === undefined) { upsertWeek.run(u, w.entry, null, null, "no-close", 0, 0, "no raw close at entry", now); console.log(`${u} ${w.entry}: no raw close`); continue; }
      // every contract expiring in (entry, entry+5 sessions]: the listed set and E's chain in one query
      const contracts = await fetchContracts(u, sessions[i0 + 1], horizon);
      const alpacaExpirations = [...new Set(contracts.map(c => c.expiration))].sort();
      db.transaction(() => { for (const e of alpacaExpirations) insListed.run(u, w.entry, e); })();
      // the calendar: the mirror's listing through the mirror (same E as the primary run), Alpaca's after it
      const listed = w.entry <= mirrorLast[u] ? mirrorListed(db, u, w.entry) : alpacaExpirations;
      const ex = eligibleExpiration(sessions, w.entry, listed);
      if (!ex) { upsertWeek.run(u, w.entry, null, null, "done", 0, 0, "no eligible expiration", now); console.log(`${u} ${w.entry}: no eligible expiration`); continue; }
      if (ex.exit > to) { upsertWeek.run(u, w.entry, ex.expiration, ex.exit, "beyond", 0, 0, "exit after the cap", now); continue; }
      const chain = contracts.filter(c => c.expiration === ex.expiration && c.strike >= STRIKE_BAND[0] * S && c.strike <= STRIKE_BAND[1] * S);
      db.transaction(() => { for (const c of chain) insContract.run(c.symbol, u, c.expiration, c.type, c.strike); })();
      let note = contracts.some(c => c.expiration === ex.expiration) ? null : "E not listed at Alpaca";
      const bars = chain.length ? await fetchBars(db, chain.map(c => c.symbol), w.entry, ex.expirationSession) : 0;
      upsertWeek.run(u, w.entry, ex.expiration, ex.exit, "done", chain.length, bars, note, new Date().toISOString());
      fetched++;
      console.log(`${u} ${w.entry} → E ${ex.expiration} (exit ${ex.exit}): ${chain.length} contracts, ${bars} bars${note ? ` [${note}]` : ""} | ${requests} req, ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
    }
  }
  const totals = db.query<{ contracts: number; bars: number; weeks: number }, []>("SELECT count(*) weeks, sum(contracts) contracts, sum(bars) bars FROM alpaca_weeks WHERE status = 'done'").get()!;
  console.log(`done: ${fetched} fetched, ${skipped} skipped; totals ${JSON.stringify(totals)}; ${requests} requests`);
  db.close();
}
