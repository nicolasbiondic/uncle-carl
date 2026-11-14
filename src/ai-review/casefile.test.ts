import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_HOSTS, MAX_CASEFILE_BYTES, buildCaseFile, cleanSummary, fitSize, groupNews, makeGet, preMarketOf, readCloses, readOpenLots, serializeForModel } from "./casefile";
import { parseCaseFile } from "./contract";
import { caseFile, sym } from "./testFixtures";

const SESSION = "2026-11-16"; // Monday; the last session before it is Friday 11-13
const NOW = Date.parse("2026-11-16T13:10:00Z");
const KEY = "PKTESTKEY123456", SECRET = "SECRETTESTVALUE987654321";
const H = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();

let dir: string;
let trading: Database;
let hist: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-review-casefile-"));
  trading = new Database(join(dir, "trading.db"));
  trading.run("CREATE TABLE trades (id TEXT PRIMARY KEY, symbol TEXT, side TEXT, entry_price REAL, quantity REAL, entry_time INTEGER, status TEXT, account_id TEXT)");
  trading.run("CREATE TABLE equity_snapshots (id INTEGER PRIMARY KEY, profile_id TEXT, equity REAL, snapshot_time INTEGER)");
  hist = new Database(join(dir, "historical.db"));
  hist.run("CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, timestamp INTEGER, close REAL, PRIMARY KEY (symbol, timeframe, timestamp))");
});
afterEach(() => { trading.close(); hist.close(); rmSync(dir, { recursive: true, force: true }); });

const day = (d: string) => Date.parse(`${d}T05:00:00Z`); // a daily bar is stamped at New York midnight
function bars(symbol: string, closes: [string, number][], tf = "1d") {
  for (const [d, c] of closes) hist.run("INSERT INTO historical_bars VALUES (?,?,?,?)", [symbol, tf, day(d), c]);
}
const GOOD_BARS: [string, number][] = [["2026-11-06", 100], ["2026-11-09", 102], ["2026-11-10", 104], ["2026-11-11", 103], ["2026-11-12", 105], ["2026-11-13", 110], ["2026-11-16", 999]];

function lot(id: string, symbol: string, account: string, o: Partial<{ side: string; price: number; qty: number; at: string; status: string }> = {}) {
  trading.run("INSERT INTO trades VALUES (?,?,?,?,?,?,?,?)", [id, symbol, o.side ?? "buy", o.price ?? 100, o.qty ?? 10, Date.parse(o.at ?? "2026-11-10T14:36:00Z"), o.status ?? "open", account]);
}

interface Call { method: string; host: string; path: string; params: URLSearchParams; headers: Record<string, string> }
function fakeFetch(handlers: { news?: (p: URLSearchParams, page: number) => unknown; snapshots?: (p: URLSearchParams) => unknown }) {
  const calls: Call[] = [];
  const pages = new Map<string, number>();
  const fn = (async (input: any, init: any) => {
    const u = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", host: u.hostname, path: u.pathname, params: u.searchParams, headers: init?.headers ?? {} });
    if (u.pathname === "/v1beta1/news") {
      const key = u.searchParams.get("symbols")!;
      const page = pages.get(key) ?? 0; pages.set(key, page + 1);
      return Response.json(handlers.news ? handlers.news(u.searchParams, page) : { news: [], next_page_token: null });
    }
    if (u.pathname === "/v2/stocks/snapshots") return Response.json(handlers.snapshots ? handlers.snapshots(u.searchParams) : {});
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const article = (headline: string, hoursAgo: number, symbols: string[], extra: object = {}) => ({ id: Math.random(), headline, summary: `Summary of ${headline}`, source: "benzinga", url: `https://news.example/${encodeURIComponent(headline)}`, created_at: iso(hoursAgo), symbols, ...extra });
const build = (f: typeof fetch, universes = { momentum_stocks: ["NVDA", "AAPL"], meanrev_stocks: ["JNJ"] }, extra = {}) =>
  buildCaseFile({ session: SESSION, nowMs: NOW, tradingDb: trading, historicalDb: hist, universes, fetchFn: f, keyId: KEY, secretKey: SECRET, sleep: async () => {}, ...extra });

describe("the network door", () => {
  test("GET only, only to data.alpaca.markets, keys in headers, never in the URL", async () => {
    for (const s of ["NVDA", "AAPL", "JNJ"]) bars(s, GOOD_BARS);
    const { fn, calls } = fakeFetch({ news: () => ({ news: [article("a", 2, ["NVDA"])], next_page_token: null }) });
    await build(fn);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every(c => c.method === "GET")).toBe(true);
    expect(calls.every(c => ALLOWED_HOSTS.includes(c.host))).toBe(true);
    expect(new Set(calls.map(c => c.path))).toEqual(new Set(["/v1beta1/news", "/v2/stocks/snapshots"]));
    expect(calls.every(c => c.headers["APCA-API-KEY-ID"] === KEY && c.headers["APCA-API-SECRET-KEY"] === SECRET)).toBe(true);
    expect(calls.every(c => !`${c.path}${c.params}`.includes(SECRET) && !`${c.path}${c.params}`.includes(KEY))).toBe(true);
  });
  test("any other host, a non-https URL, or a POST is refused before it leaves the machine", async () => {
    const seen: string[] = [];
    const get = makeGet({ fetchFn: (async (u: any) => { seen.push(String(u)); return Response.json({}); }) as any, keyId: KEY, secretKey: SECRET, sleep: async () => {} });
    await expect(get("https://paper-api.alpaca.markets/v2/orders")).rejects.toThrow("not an allowed host");
    await expect(get("https://evil.example/x")).rejects.toThrow("not an allowed host");
    await expect(get("http://data.alpaca.markets/v2/stocks/snapshots")).rejects.toThrow("not an allowed host");
    expect(seen).toEqual([]);
  });
  test("an error never carries the key or the secret", async () => {
    const get = makeGet({ fetchFn: (async () => { throw new Error(`socket closed for ${KEY} / ${SECRET}`); }) as any, keyId: KEY, secretKey: SECRET, sleep: async () => {} });
    const e = await get("https://data.alpaca.markets/v1beta1/news").catch(x => x as Error);
    expect(String(e.message)).not.toContain(KEY);
    expect(String(e.message)).not.toContain(SECRET);
  });
  test("429 and 5xx are retried a little; a plain 4xx is not", async () => {
    let n = 0;
    const get = makeGet({ fetchFn: (async () => (++n < 3 ? new Response("slow down", { status: 429 }) : Response.json({ ok: 1 }))) as any, keyId: KEY, secretKey: SECRET, sleep: async () => {} });
    expect(await get("https://data.alpaca.markets/v2/stocks/snapshots")).toEqual({ ok: 1 });
    n = 0;
    const get401 = makeGet({ fetchFn: (async () => { n++; return new Response("no", { status: 401 }); }) as any, keyId: KEY, secretKey: SECRET, sleep: async () => {} });
    await expect(get401("https://data.alpaca.markets/v2/stocks/snapshots")).rejects.toThrow("HTTP 401");
    expect(n).toBe(1);
  });
});

describe("read-only", () => {
  test("a write through the handles the script uses fails (readonly databases)", () => {
    trading.close(); hist.close();
    const t = new Database(join(dir, "trading.db"), { readonly: true });
    const h = new Database(join(dir, "historical.db"), { readonly: true });
    expect(() => t.run("DELETE FROM trades")).toThrow();
    expect(() => h.run("DELETE FROM historical_bars")).toThrow();
    expect(readOpenLots(t)).toEqual([]);
    t.close(); h.close();
    trading = new Database(join(dir, "trading.db")); hist = new Database(join(dir, "historical.db")); // for afterEach
  });
  test("the case file builder itself issues no write statement (source scan)", async () => {
    const src = await Bun.file(join(import.meta.dir, "casefile.ts")).text();
    expect(src).not.toMatch(/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|DROP TABLE|ALTER TABLE|CREATE TABLE)\b/i);
    expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/i);
  });
});

describe("positions", () => {
  test("only open rows of the two stock sleeves; held names get value, since-entry result and days held", async () => {
    for (const s of ["NVDA", "AAPL", "JNJ"]) bars(s, GOOD_BARS);
    lot("1", "NVDA", "momentum_stocks", { price: 100, qty: 10, at: "2026-11-10T14:36:00Z" });          // Tue → Mon 16 is the 4th session
    lot("2", "NVDA", "momentum_stocks", { price: 108, qty: 5, at: "2026-11-12T14:36:00Z" });
    lot("3", "AAPL", "momentum_stocks", { status: "closed" });                                       // closed: not held
    lot("4", "JNJ", "crypto_other", {});                                                              // another account: ignored
    lot("5", "SH", "momentum_stocks", {});                                                            // outside the universe: ignored
    trading.run("INSERT INTO equity_snapshots VALUES (1,'momentum_stocks',43677.4,?)", [NOW - 1000]);
    const cf = await build(fakeFetch({}).fn);
    const nv = cf.sleeves[0].symbols.find(s => s.symbol === "NVDA")!;
    expect(nv).toMatchObject({ held: true, positionUsd: 1650, sinceEntryUsd: 100 + 10, lastClose: 110, daysHeld: 4 });
    // (110-100)*10 + (110-108)*5 = 110 ; 15 shares * 110 = 1650
    expect(cf.sleeves[0].symbols.find(s => s.symbol === "AAPL")).toMatchObject({ held: false, positionUsd: null, sinceEntryUsd: null, daysHeld: null });
    expect(cf.sleeves[0].valueUsd).toBe(43677);
    expect(cf.sleeves[1].valueUsd).toBeNull();
    expect(readOpenLots(trading).map(l => l.symbol).sort()).toEqual(["NVDA", "NVDA", "SH"]);
  });
  test("names and sleeve names are the plain Spanish ones", async () => {
    for (const s of ["NVDA", "AAPL", "JNJ"]) bars(s, GOOD_BARS);
    const cf = await build(fakeFetch({}).fn);
    expect(cf.sleeves.map(s => s.name)).toEqual(["Momentum Acciones", "Reversión Acciones"]);
    expect(cf.sleeves[0].symbols[0].name).toBe("Nvidia");
  });
});

describe("closes", () => {
  test("never the session's own bar; 1-day and 5-day returns; daily timeframe only", () => {
    bars("NVDA", GOOD_BARS);
    bars("NVDA", [["2026-11-13", 1]], "1h");
    const c = readCloses(hist, "NVDA", SESSION)!;
    expect(c.lastClose).toBe(110);
    expect(c.lastDate).toBe("2026-11-13");
    expect(c.ret1dPct).toBe(4.8);   // 110/105
    expect(c.ret5dPct).toBe(10);    // 110/100 (five sessions earlier)
    expect(readCloses(hist, "NOPE", SESSION)).toBeNull();
  });
  test("a symbol without bars is left out with a warning; a stale close is flagged", async () => {
    bars("NVDA", GOOD_BARS);
    bars("AAPL", [["2026-11-10", 100]]);
    const cf = await build(fakeFetch({}).fn);
    expect(cf.sleeves[0].symbols.map(s => s.symbol)).toEqual(["NVDA", "AAPL"]);
    expect(cf.sleeves[1].symbols).toEqual([]);
    expect(cf.warnings?.join(" ")).toContain("no daily bars, left out: JNJ");
    expect(cf.warnings?.join(" ")).toContain("older than the last session (2026-11-13): AAPL");
  });
});

describe("news", () => {
  test("the news query: symbols, start 72 h before, limit 50, sort desc", async () => {
    for (const s of ["NVDA", "AAPL", "JNJ"]) bars(s, GOOD_BARS);
    const { fn, calls } = fakeFetch({});
    await build(fn);
    const q = calls.find(c => c.path === "/v1beta1/news")!;
    expect(q.params.get("start")).toBe(new Date(NOW - 72 * H).toISOString());
    expect(q.params.get("limit")).toBe("50");
    expect(q.params.get("sort")).toBe("desc");
    expect(q.params.get("symbols")).toBe("NVDA,AAPL,JNJ");
  });
  test("follows next_page_token up to a cap", async () => {
    for (const s of ["NVDA", "AAPL", "JNJ"]) bars(s, GOOD_BARS);
    const { fn, calls } = fakeFetch({ news: (_p, page) => ({ news: [article(`h${page}`, 1 + page, ["NVDA"])], next_page_token: `tok${page}` }) });
    const cf = await build(fn);
    expect(calls.filter(c => c.path === "/v1beta1/news")).toHaveLength(3);
    expect(calls.filter(c => c.path === "/v1beta1/news")[1].params.get("page_token")).toBe("tok0");
    expect(cf.sleeves[0].symbols[0].news.map(n => n.headline)).toEqual(["h0", "h1", "h2"]);
  });
  test("per symbol: the 8 most recent DISTINCT headlines of the last 72 h, newest first, summary cut to 300", () => {
    const arts = [
      ...Array.from({ length: 12 }, (_, i) => article(`Story ${i}`, i + 1, ["NVDA"])),
      article("story 0", 30, ["NVDA"]),                                // same headline, different case: a duplicate
      article("Too old", 73, ["NVDA"]),                                // outside 72 h
      article("From the future", -2, ["NVDA"]),                        // after now
      article("Other company", 1, ["TSLA"]),                           // not ours
      article("Long one", 0.5, ["NVDA"], { summary: "x".repeat(900) }),
    ];
    const g = groupNews(arts, new Set(["NVDA"]), NOW);
    const n = g.get("NVDA")!;
    expect(n).toHaveLength(8);
    expect(n[0].headline).toBe("Long one");
    expect(n[0].summary).toHaveLength(300);
    expect(n.map(x => x.headline)).not.toContain("Too old");
    expect(n.map(x => x.headline)).not.toContain("From the future");
    expect(new Set(n.map(x => x.headline.toLowerCase())).size).toBe(8);
    expect(n.map(x => Date.parse(x.at))).toEqual([...n.map(x => Date.parse(x.at))].sort((a, b) => b - a));
    expect(g.has("TSLA")).toBe(false);
  });
  test("an article tagged with several of our symbols appears under each; HTML in a summary is stripped", () => {
    const g = groupNews([article("Both", 1, ["NVDA", "AAPL"], { summary: "<p>Hello <b>world</b></p>" })], new Set(["NVDA", "AAPL"]), NOW);
    expect(g.get("NVDA")![0].summary).toBe("Hello world");
    expect(g.get("AAPL")).toHaveLength(1);
    expect(cleanSummary("a  b\n c")).toBe("a b c");
  });
  test("no news at all (every request failed) is an error: a review of nothing is not a review", async () => {
    for (const s of ["NVDA", "AAPL", "JNJ"]) bars(s, GOOD_BARS);
    const f = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    await expect(build(f)).rejects.toThrow("no news could be read");
  });
  test("pre-market failing is not an error: null and a warning", async () => {
    for (const s of ["NVDA", "AAPL", "JNJ"]) bars(s, GOOD_BARS);
    const f = (async (input: any) => (String(input).includes("snapshots") ? new Response("x", { status: 403 }) : Response.json({ news: [] }))) as unknown as typeof fetch;
    const cf = await build(f);
    expect(cf.sleeves[0].symbols.every(s => s.preMarket === null)).toBe(true);
    expect(cf.warnings?.join(" ")).toContain("pre-market unavailable");
  });
});

describe("pre-market", () => {
  test("price and change against our last close, only when the latest trade is from the session's own date", () => {
    expect(preMarketOf({ latestTrade: { p: 112.2, t: "2026-11-16T12:55:00Z" } }, 110, SESSION)).toEqual({ price: 112.2, changePct: 2, at: "2026-11-16T12:55:00.000Z" });
    expect(preMarketOf({ latestTrade: { p: 112.2, t: "2026-11-13T21:00:00Z" } }, 110, SESSION)).toBeNull(); // Friday's last trade
    expect(preMarketOf({}, 110, SESSION)).toBeNull();
    expect(preMarketOf({ latestTrade: { p: 0, t: "2026-11-16T12:55:00Z" } }, 110, SESSION)).toBeNull();
  });
  test("it lands in the case file from the snapshot call", async () => {
    for (const s of ["NVDA", "AAPL", "JNJ"]) bars(s, GOOD_BARS);
    const { fn } = fakeFetch({ snapshots: () => ({ NVDA: { latestTrade: { p: 99, t: "2026-11-16T12:40:00Z" } } }) });
    const cf = await build(fn);
    expect(cf.sleeves[0].symbols[0].preMarket).toMatchObject({ price: 99, changePct: -10 });
    expect(cf.sleeves[0].symbols[1].preMarket).toBeNull();
  });
});

describe("size and shape", () => {
  const fat = () => {
    const cf = caseFile();
    for (const s of cf.sleeves) for (const y of s.symbols) y.news = Array.from({ length: 8 }, (_, i) => ({ at: iso(i + 1), source: "benzinga", headline: `${y.symbol} headline number ${i} ${"w".repeat(80)}`, summary: "s".repeat(300), url: `https://news.example.com/${y.symbol}/${i}/${"p".repeat(90)}` }));
    return cf;
  };
  test("a worst-case file (43 symbols × 8 long headlines) is cut under ~80 KB and stays valid", () => {
    const big = fat();
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_CASEFILE_BYTES);
    const cf = fitSize(big);
    expect(JSON.stringify(cf).length).toBeLessThanOrEqual(MAX_CASEFILE_BYTES);
    expect(parseCaseFile(cf).ok).toBe(true);
    const held = cf.sleeves[0].symbols.find(s => s.held)!;
    const other = cf.sleeves[0].symbols.find(s => !s.held)!;
    expect(held.news.length).toBeGreaterThanOrEqual(other.news.length); // what the bot holds keeps the most
    expect(held.news.length).toBeGreaterThan(0);
  });
  test("a normal file is left alone", () => {
    const cf = caseFile();
    expect(fitSize(structuredClone(cf))).toEqual(cf);
  });
  test("the file the model reads is the same JSON, with no line longer than a reader's limit", () => {
    const cf = fat();
    const text = serializeForModel(cf);
    expect(JSON.parse(text)).toEqual(cf);
    expect(Math.max(...text.split("\n").map(l => l.length))).toBeLessThan(1000);
    expect(parseCaseFile(JSON.parse(serializeForModel({ ...caseFile(), warnings: ["w"] }))).ok).toBe(true);
    expect(sym("X").news).toHaveLength(1);
  });
});
