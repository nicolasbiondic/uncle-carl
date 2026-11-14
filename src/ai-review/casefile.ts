// The day's case file (pre-registration §3.1): deterministic, no model, READ-ONLY.
//   positions   trading.db opened { readonly: true } (open `trades` rows of the two stock sleeves)
//   closes      historical.db opened { readonly: true } (timeframe 1d)
//   pre-market  Alpaca DATA API snapshot (null when unavailable)
//   news        Alpaca DATA API news, last 72 h, the 8 most recent distinct headlines per symbol
// The only network calls are GETs to data.alpaca.markets with the bot's own keys (headers; never printed, never
// written, never in an error message). The universes are passed in (scripts/ai-review-casefile.ts reads them from
// src/portfolios/builtin.ts) so this module imports nothing from engines or brokers.
// Enforced: src/ai-review/casefile.test.ts (read-only, GET only, host, 8 headlines, 72 h, size cap).

import type { Database } from "bun:sqlite";
import { SLEEVE_IDS, SLEEVE_NAMES, SUMMARY_MAX_CHARS, type CaseFile, type CaseNews, type CaseSleeve, type CaseSymbol, type SleeveId } from "./contract";
import { getPreviousTradingDay, nyClock, nyInstant, sessionsBetween } from "./calendar";
// @ts-ignore shared owner-facing names, plain JS also used by the dashboard.
import { symbolName } from "../dashboard/public/v4/js/symbol-names.js";

export const ALLOWED_HOSTS: readonly string[] = ["data.alpaca.markets"];
export const NEWS_WINDOW_HOURS = 72;
export const NEWS_PER_SYMBOL = 8;
export const NEWS_GROUP_SIZE = 10;
export const NEWS_PAGE_LIMIT = 50;
export const NEWS_MAX_PAGES = 3;
export const MAX_CASEFILE_BYTES = 80_000;

export interface CaseFileDeps {
  session: string;
  nowMs: number;
  /** Opened with { readonly: true } by the caller. */
  tradingDb: Database;
  /** Opened with { readonly: true } by the caller. */
  historicalDb: Database;
  universes: Record<SleeveId, readonly string[]>;
  fetchFn: typeof fetch;
  keyId: string;
  secretKey: string;
  /** Alpaca data feed for the snapshot (the bot's own: iex unless configured). */
  feed?: string;
  nameOf?: (symbol: string) => string | null;
  sleep?: (ms: number) => Promise<unknown>;
}

// ── the only network door ────────────────────────────────────────────────
export function makeGet(deps: Pick<CaseFileDeps, "fetchFn" | "keyId" | "secretKey" | "sleep">) {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  return async function get(url: string): Promise<any> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.includes(u.hostname)) throw new Error(`refused: ${u.hostname} is not an allowed host`);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await deps.fetchFn(url, { method: "GET", headers: { "APCA-API-KEY-ID": deps.keyId, "APCA-API-SECRET-KEY": deps.secretKey, accept: "application/json" } });
      } catch (e) {
        let msg = String((e as Error)?.message ?? e);
        for (const secret of [deps.secretKey, deps.keyId]) if (secret) msg = msg.split(secret).join("***");
        throw new Error(`GET ${u.pathname} failed: ${msg.slice(0, 120)}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`GET ${u.pathname} answered HTTP ${res.status}`);
      return res.json();
    }
  };
}

// ── positions ────────────────────────────────────────────────────────────
export interface Lot { sleeve: SleeveId; symbol: string; qty: number; entryPrice: number; entrySession: string }

export function readOpenLots(db: Database): Lot[] {
  const rows = db.query(
    `SELECT symbol, side, entry_price, quantity, entry_time, account_id FROM trades WHERE status = 'open' AND account_id IN (${SLEEVE_IDS.map(() => "?").join(",")})`,
  ).all(...SLEEVE_IDS) as { symbol: string; side: string; entry_price: number; quantity: number; entry_time: number; account_id: string }[];
  return rows.map(r => ({
    sleeve: r.account_id as SleeveId,
    symbol: r.symbol,
    qty: (/^(short|sell)$/i.test(r.side) ? -1 : 1) * Math.abs(Number(r.quantity)),
    entryPrice: Number(r.entry_price),
    entrySession: nyClock(Number(r.entry_time)).date,
  })).filter(l => Number.isFinite(l.qty) && Number.isFinite(l.entryPrice) && l.qty !== 0);
}

/** Context only: the sleeve's latest equity snapshot; null when the table or the row is missing. */
export function readSleeveValue(db: Database, sleeve: SleeveId): number | null {
  try {
    const r = db.query(`SELECT equity FROM equity_snapshots WHERE profile_id = ? ORDER BY snapshot_time DESC LIMIT 1`).get(sleeve) as { equity: number } | null;
    return r && Number.isFinite(r.equity) ? Math.round(r.equity) : null;
  } catch { return null; }
}

// ── closes ───────────────────────────────────────────────────────────────
export interface Closes { lastClose: number; lastDate: string; ret1dPct: number | null; ret5dPct: number | null }

/** Daily closes of the sessions BEFORE `session` (never the session's own bar). */
export function readCloses(db: Database, symbol: string, session: string): Closes | null {
  const rows = db.query(
    `SELECT timestamp, close FROM historical_bars WHERE symbol = ? AND timeframe = '1d' AND timestamp < ? ORDER BY timestamp DESC LIMIT 6`,
  ).all(symbol, nyInstant(session, 0, 0)) as { timestamp: number; close: number }[];
  if (rows.length === 0 || !(rows[0].close > 0)) return null;
  const ret = (from: number | undefined) => (from && from > 0 ? Math.round((rows[0].close / from - 1) * 1000) / 10 : null);
  return { lastClose: rows[0].close, lastDate: nyClock(rows[0].timestamp).date, ret1dPct: ret(rows[1]?.close), ret5dPct: ret(rows[5]?.close) };
}

// ── news ─────────────────────────────────────────────────────────────────
const normHeadline = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function cleanSummary(s: unknown, max = SUMMARY_MAX_CHARS): string {
  const t = String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Articles → per symbol, the most recent distinct headlines inside the window. */
export function groupNews(articles: any[], symbols: ReadonlySet<string>, nowMs: number, perSymbol = NEWS_PER_SYMBOL): Map<string, CaseNews[]> {
  const from = nowMs - NEWS_WINDOW_HOURS * 3_600_000;
  const out = new Map<string, CaseNews[]>();
  const seen = new Map<string, Set<string>>();
  const sorted = [...articles].filter(a => a && typeof a.headline === "string" && typeof a.url === "string").sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const a of sorted) {
    const t = Date.parse(a.created_at);
    if (!Number.isFinite(t) || t < from || t > nowMs) continue;
    if (!/^https?:\/\//.test(a.url)) continue;
    for (const sym of Array.isArray(a.symbols) ? a.symbols : []) {
      if (!symbols.has(sym)) continue;
      const keys = seen.get(sym) ?? new Set<string>();
      const key = normHeadline(a.headline);
      if (!key || keys.has(key) || keys.has(a.url)) continue;
      const list = out.get(sym) ?? [];
      if (list.length >= perSymbol) continue;
      keys.add(key); keys.add(a.url); seen.set(sym, keys);
      list.push({ at: new Date(t).toISOString(), source: String(a.source ?? a.author ?? "").slice(0, 60), headline: String(a.headline).replace(/\s+/g, " ").trim(), summary: cleanSummary(a.summary), url: a.url });
      out.set(sym, list);
    }
  }
  return out;
}

async function fetchNews(get: (u: string) => Promise<any>, symbols: string[], nowMs: number, warnings: string[]): Promise<Map<string, CaseNews[]>> {
  const start = new Date(nowMs - NEWS_WINDOW_HOURS * 3_600_000).toISOString();
  const wanted = new Set(symbols);
  const articles: any[] = [];
  let groupsOk = 0;
  const groups: string[][] = [];
  for (let i = 0; i < symbols.length; i += NEWS_GROUP_SIZE) groups.push(symbols.slice(i, i + NEWS_GROUP_SIZE));
  for (const g of groups) {
    try {
      let token: string | null = null;
      for (let page = 0; page < NEWS_MAX_PAGES; page++) {
        const u = new URL("https://data.alpaca.markets/v1beta1/news");
        u.searchParams.set("symbols", g.join(","));
        u.searchParams.set("start", start);
        u.searchParams.set("limit", String(NEWS_PAGE_LIMIT));
        u.searchParams.set("sort", "desc");
        if (token) u.searchParams.set("page_token", token);
        const j = await get(u.toString());
        articles.push(...(Array.isArray(j?.news) ? j.news : []));
        token = typeof j?.next_page_token === "string" && j.next_page_token ? j.next_page_token : null;
        if (!token) break;
      }
      groupsOk++;
    } catch (e) {
      warnings.push(`news unavailable for ${g.join(",")}: ${(e as Error).message}`);
    }
  }
  if (groupsOk === 0) throw new Error(`no news could be read at all (${warnings.at(-1) ?? "no symbols"})`);
  return groupNews(articles, wanted, nowMs);
}

async function fetchPreMarket(get: (u: string) => Promise<any>, symbols: string[], feed: string, warnings: string[]): Promise<Record<string, any>> {
  try {
    const u = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
    u.searchParams.set("symbols", symbols.join(","));
    u.searchParams.set("feed", feed);
    const j = await get(u.toString());
    return (j && typeof j === "object" ? (j.snapshots ?? j) : {}) as Record<string, any>;
  } catch (e) {
    warnings.push(`pre-market unavailable: ${(e as Error).message}`);
    return {};
  }
}

/** The pre-market quote against our own last close; null unless the latest trade is from the session's own date. */
export function preMarketOf(snap: any, lastClose: number, session: string): CaseSymbol["preMarket"] {
  const p = Number(snap?.latestTrade?.p);
  const at = snap?.latestTrade?.t;
  const t = Date.parse(at);
  if (!(p > 0) || !Number.isFinite(t) || nyClock(t).date !== session) return null;
  return { price: p, changePct: Math.round((p / lastClose - 1) * 1000) / 10, at: new Date(t).toISOString() };
}

// ── size ─────────────────────────────────────────────────────────────────
/** Shrink until the JSON fits: shorter summaries first, then fewer headlines for names the bot does not hold, then for held ones. */
export function fitSize(cf: CaseFile, max = MAX_CASEFILE_BYTES): CaseFile {
  const size = () => JSON.stringify(cf).length;
  const each = (fn: (y: CaseSymbol) => void) => cf.sleeves.forEach(s => s.symbols.forEach(fn));
  for (const cut of [200, 120, 60, 0]) {
    if (size() <= max) return cf;
    each(y => y.news.forEach(n => { n.summary = cleanSummary(n.summary, cut || 1).slice(0, cut); }));
  }
  for (const held of [false, true]) {
    for (let keep = NEWS_PER_SYMBOL - 1; keep >= 1 && size() > max; keep--) each(y => { if (y.held === held) y.news = y.news.slice(0, keep); });
  }
  return cf;
}

/**
 * Valid JSON laid out for a model that reads it with a line-oriented tool: one symbol header and one headline per
 * line, none longer than the tool's line limit (a single 80 KB line would be cut).
 */
export function serializeForModel(cf: CaseFile): string {
  const j = (x: unknown) => JSON.stringify(x);
  const sleeves = cf.sleeves.map(s => {
    const syms = s.symbols.map(y => {
      const { news, ...head } = y;
      const headJson = j(head).slice(0, -1);
      return `${headJson},"news":[\n${news.map(n => j(n)).join(",\n")}${news.length ? "\n" : ""}]}`;
    });
    return `{"id":${j(s.id)},"name":${j(s.name)},"valueUsd":${j(s.valueUsd)},"symbols":[\n${syms.join(",\n")}\n]}`;
  });
  const warnings = cf.warnings ? `,"warnings":${j(cf.warnings)}` : "";
  return `{"session":${j(cf.session)},"builtAt":${j(cf.builtAt)}${warnings},"sleeves":[\n${sleeves.join(",\n")}\n]}\n`;
}

// ── the whole file ───────────────────────────────────────────────────────
export async function buildCaseFile(d: CaseFileDeps): Promise<CaseFile> {
  const warnings: string[] = [];
  const get = makeGet(d);
  const nameOf = d.nameOf ?? ((s: string) => symbolName(s, "es"));
  const lots = readOpenLots(d.tradingDb);
  const prevSession = getPreviousTradingDay(d.session);

  const closes = new Map<string, Closes>();
  const stale: string[] = [];
  const missing: string[] = [];
  const allSymbols = [...new Set(SLEEVE_IDS.flatMap(s => d.universes[s]))];
  for (const sym of allSymbols) {
    const c = readCloses(d.historicalDb, sym, d.session);
    if (!c) { missing.push(sym); continue; }
    if (c.lastDate < prevSession) stale.push(sym);
    closes.set(sym, c);
  }
  if (missing.length) warnings.push(`no daily bars, left out: ${missing.join(",")}`);
  if (stale.length) warnings.push(`closing price older than the last session (${prevSession}): ${stale.join(",")}`);

  const symbols = allSymbols.filter(s => closes.has(s));
  const news = await fetchNews(get, symbols, d.nowMs, warnings);
  const snaps = await fetchPreMarket(get, symbols, d.feed ?? "iex", warnings);

  const sleeves: CaseSleeve[] = SLEEVE_IDS.map(id => {
    const syms: CaseSymbol[] = [];
    for (const symbol of d.universes[id]) {
      const c = closes.get(symbol);
      if (!c) continue;
      const mine = lots.filter(l => l.sleeve === id && l.symbol === symbol);
      const held = mine.length > 0;
      const qty = mine.reduce((n, l) => n + l.qty, 0);
      syms.push({
        symbol,
        name: nameOf(symbol) ?? symbol,
        held,
        positionUsd: held ? Math.round(qty * c.lastClose) : null,
        sinceEntryUsd: held ? Math.round(mine.reduce((n, l) => n + (c.lastClose - l.entryPrice) * l.qty, 0)) : null,
        // Counted as the engine counts a hold (entry excluded, today's session included): 5 = the lot is due to close.
        daysHeld: held ? Math.max(...mine.map(l => sessionsBetween(l.entrySession, d.session))) : null,
        lastClose: c.lastClose,
        ret1dPct: c.ret1dPct,
        ret5dPct: c.ret5dPct,
        preMarket: preMarketOf(snaps[symbol], c.lastClose, d.session),
        news: news.get(symbol) ?? [],
      });
    }
    return { id, name: SLEEVE_NAMES[id], valueUsd: readSleeveValue(d.tradingDb, id), symbols: syms };
  });

  const cf: CaseFile = { session: d.session, builtAt: new Date(d.nowMs).toISOString(), sleeves };
  if (warnings.length) cf.warnings = warnings.slice(0, 20);
  return fitSize(cf);
}
