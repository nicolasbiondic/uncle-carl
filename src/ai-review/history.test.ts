// The review's track record in the analysts' case file: an exit that saved money, one that cost, one still on with its day pending,
// a miss; the caps; the size cap; absent when empty; read-only and GET-only; the model's file carries it.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_HOSTS, MAX_CASEFILE_BYTES, buildCaseFile, fitSize, serializeForModel } from "./casefile";
import { HISTORY_MAX_EPISODES, HISTORY_MAX_MISSES, parseCaseFile, parseHistory, type CaseHistory } from "./contract";
import { AI_REVIEW_START, buildLedger, nextSessionOf, type JournalPass } from "./effects";
import { HISTORY_MAX_BYTES, HISTORY_SESSIONS, buildHistory, fitHistory, historyWindowStart, readHistory } from "./history";
import { type HeldPass } from "./journalDb";
import { caseFile } from "./testFixtures";

const SESSION = "2026-11-24"; // Tuesday; the last journaled pass is Monday 11-23
const UNIVERSES = { momentum_stocks: ["NVDA", "AAPL", "MSFT"], meanrev_stocks: ["JNJ", "KO", "JPM", "XOM"] };

const eff = (symbol: string, action: "reduce" | "exit", modelWeight: number, appliedWeight: number) => ({ symbol, action, factor: appliedWeight / modelWeight, modelWeight, appliedWeight });
const rev = (applied: boolean, ...effects: ReturnType<typeof eff>[]) => ({ aiReview: { decisionId: "abc123def456", decisionSession: "2026-11-16", applied, effects } });
const pass = (sleeve: string, session: string, held: string[], diagnostics: unknown = {}, equity = 10_000): HeldPass => ({ sleeve, session, status: "submitted", equity, diagnostics, held });

/** Open prices by "SYMBOL@session": a price holds until the next one listed (and back to the start); an unlisted symbol is flat at 100. */
const PRICES: Record<string, number> = {
  "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95, "NVDA@2026-11-18": 90,   // two days of an exit that avoided 5 % twice
  "AAPL@2026-11-16": 200, "AAPL@2026-11-17": 210,                          // an exit that cost: it rose 5 %
  "MSFT@2026-11-17": 400, "MSFT@2026-11-18": 376,                          // held, no action, −6 %: a miss
  "SH@2026-11-18": 100, "SH@2026-11-19": 93,                               // −7 % but outside the universe: not a miss
  "JNJ@2026-11-19": 100, "JNJ@2026-11-20": 95,                             // exactly −5 %: a miss
  "KO@2026-11-19": 100, "KO@2026-11-20": 95.1,                             // −4.9 %: not a miss
  "XOM@2026-11-23": 100,
};
function opens(symbol: string, session: string): number | null {
  if (session >= SESSION) return null; // the case file's own session has no open yet: its pass cannot be measured
  const own = Object.entries(PRICES).filter(([k]) => k.startsWith(`${symbol}@`)).map(([k, v]) => [k.split("@")[1], v] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (own.length === 0) return 100;
  return (own.filter(([d]) => d <= session).at(-1) ?? own[0])[1];
}

/** The scenario: NVDA exit 2 days, AAPL exit 1 day, XOM exit still on (pending), MSFT and JNJ fell with no action. */
const PASSES: HeldPass[] = [
  pass("momentum_stocks", "2026-11-16", ["NVDA", "AAPL", "MSFT"], rev(true, eff("NVDA", "exit", 0.2, 0), eff("AAPL", "exit", 0.1, 0))),
  pass("momentum_stocks", "2026-11-17", ["AAPL", "MSFT"], rev(true, eff("NVDA", "exit", 0.2, 0))),
  pass("momentum_stocks", "2026-11-18", ["MSFT", "SH"]),
  pass("momentum_stocks", "2026-11-19", ["MSFT"]),
  pass("momentum_stocks", "2026-11-20", ["MSFT"]),
  pass("momentum_stocks", "2026-11-23", ["MSFT"]),
  pass("meanrev_stocks", "2026-11-19", ["JNJ", "KO", "JPM"]),
  pass("meanrev_stocks", "2026-11-23", ["JPM"], rev(true, eff("XOM", "exit", 0.04, 0))),
];

describe("the history from a journal", () => {
  test("an exit that saved money, one that cost, one still on with its day pending, and the misses — whole dollars, one decimal", () => {
    const h = buildHistory({ session: SESSION, passes: PASSES, opens, universes: UNIVERSES })!;
    expect(h).toEqual({
      since: "2026-11-16", sessions: 6,
      episodes: [
        { sleeve: "meanrev_stocks", symbol: "XOM", action: "exit", from: "2026-11-23", to: null, sessions: 1, effectUsd: null },
        { sleeve: "momentum_stocks", symbol: "NVDA", action: "exit", from: "2026-11-16", to: "2026-11-17", sessions: 2, effectUsd: 205 },
        { sleeve: "momentum_stocks", symbol: "AAPL", action: "exit", from: "2026-11-16", to: "2026-11-16", sessions: 1, effectUsd: -50 },
      ],
      savedUsd: 155, costUsd: 6, netUsd: 149,
      misses: [
        { session: "2026-11-19", sleeve: "meanrev_stocks", symbol: "JNJ", dropPct: 5 },
        { session: "2026-11-17", sleeve: "momentum_stocks", symbol: "MSFT", dropPct: 6 },
      ],
    });
  });

  test("it is the ledger's own number, not a second formula: same episodes, same effects, same costs", () => {
    const h = buildHistory({ session: SESSION, passes: PASSES, opens, universes: UNIVERSES })!;
    const block = buildLedger(PASSES as JournalPass[], opens).applied;
    expect(h.episodes).toHaveLength(block.episodes.length);
    expect(h.savedUsd).toBe(Math.round(block.savedUsd - block.missedUsd));
    expect(h.costUsd).toBe(Math.round(block.costUsd));
    for (const e of block.episodes) {
      const mine = h.episodes.find(x => x.symbol === e.symbol)!;
      expect(mine.effectUsd).toBe(e.pendingDays === e.days.length ? null : Math.round(e.effectUsd));
    }
  });

  test("a miss is a held stock in the sleeve's own universe, a fall of 5 % or more, with no action on it", () => {
    const h = buildHistory({ session: SESSION, passes: PASSES, opens, universes: UNIVERSES })!;
    const symbols = h.misses.map(m => m.symbol);
    expect(symbols).not.toContain("SH");   // outside the universe: the review cannot act on it
    expect(symbols).not.toContain("KO");   // −4.9 %
    expect(symbols).not.toContain("NVDA"); // the review acted on it
    expect(h.misses.find(m => m.symbol === "JNJ")!.dropPct).toBe(5);
    // a stock the review had an action on is not an omission even when it falls
    const acted = [pass("momentum_stocks", "2026-11-17", ["MSFT"], rev(true, eff("MSFT", "exit", 0.1, 0)))];
    expect(buildHistory({ session: SESSION, passes: acted, opens, universes: UNIVERSES })!.misses).toEqual([]);
    // a hypothetical action (the switch was off) is still an action of the review
    const hypo = [pass("momentum_stocks", "2026-11-17", ["MSFT"], rev(false, eff("MSFT", "exit", 0.1, 0)))];
    expect(buildHistory({ session: SESSION, passes: hypo, opens, universes: UNIVERSES })).toBeUndefined();
  });

  test("a fall that cannot be measured yet (no next open) is not a miss", () => {
    const p = [pass("momentum_stocks", "2026-11-23", ["MSFT"])];
    expect(buildHistory({ session: SESSION, passes: p, opens: () => null, universes: UNIVERSES })).toBeUndefined();
  });

  test("the window is the last 20 NYSE sessions before the case file's session; the session itself and older passes stay out", () => {
    const LONG_AGO = "2026-01-01"; // a review old enough that the 20-session window is what binds
    const start = historyWindowStart(SESSION, LONG_AGO);
    expect(HISTORY_SESSIONS).toBe(20);
    expect(start).toBe("2026-10-27"); // the 20 sessions Oct 27 .. Nov 23
    const before = "2026-10-26";
    const old = [pass("momentum_stocks", before, ["NVDA"], rev(true, eff("NVDA", "exit", 0.2, 0))), pass("momentum_stocks", SESSION, ["NVDA"], rev(true, eff("NVDA", "exit", 0.2, 0)))];
    expect(buildHistory({ session: SESSION, passes: old, opens, universes: UNIVERSES, start: LONG_AGO })).toBeUndefined();
    const edge = [pass("momentum_stocks", start, ["NVDA"], rev(true, eff("NVDA", "exit", 0.2, 0)))];
    expect(buildHistory({ session: SESSION, passes: edge, opens, universes: UNIVERSES, start: LONG_AGO })!.since).toBe(start);
  });

  test("never before the review's own first session: a fall of a held stock in the days before it existed is not a miss of the review", () => {
    expect(AI_REVIEW_START).toBe("2026-11-16");
    expect(historyWindowStart(SESSION)).toBe(AI_REVIEW_START); // 20 sessions back would be Oct 27
    // NVDA fell 9 % from Friday 11-13 to Monday 11-16 while held: the journal has that pass, the review did not exist
    const px = (symbol: string, session: string) => (symbol === "NVDA" && session >= "2026-11-16" ? 91 : 100);
    const pre = [pass("momentum_stocks", "2026-11-13", ["NVDA"])];
    expect(buildHistory({ session: SESSION, passes: pre, opens: px, universes: UNIVERSES })).toBeUndefined();
    // the same fall counted when the review is told it started earlier
    expect(buildHistory({ session: SESSION, passes: pre, opens: px, universes: UNIVERSES, start: "2026-11-01" })!.misses).toEqual([{ session: "2026-11-13", sleeve: "momentum_stocks", symbol: "NVDA", dropPct: 9 }]);
  });

  test("absent when there is nothing to show: no passes, passes without a decision or a fall, or only hypothetical decisions", () => {
    expect(buildHistory({ session: SESSION, passes: [], opens, universes: UNIVERSES })).toBeUndefined();
    const quiet = [pass("momentum_stocks", "2026-11-18", ["MSFT"]), pass("meanrev_stocks", "2026-11-18", ["JPM"])];
    expect(buildHistory({ session: SESSION, passes: quiet, opens, universes: UNIVERSES })).toBeUndefined();
    const informed = [pass("momentum_stocks", "2026-11-16", ["NVDA"], rev(false, eff("NVDA", "exit", 0.2, 0)))];
    expect(buildHistory({ session: SESSION, passes: informed, opens, universes: UNIVERSES })).toBeUndefined();
  });
});

describe("the caps", () => {
  const SYMS = Array.from({ length: 20 }, (_, i) => `S${String.fromCharCode(65 + i)}`);
  const universes = { momentum_stocks: SYMS, meanrev_stocks: [] as string[] };
  const sessionsFrom = (start: string, n: number) => { const out = [start]; while (out.length < n) out.push(nextSessionOf(out.at(-1)!)); return out; };

  test(`at most ${HISTORY_MAX_EPISODES} episodes, newest first; the totals still cover the whole window`, () => {
    const sessions = sessionsFrom(historyWindowStart(SESSION, "2026-01-01"), 20);
    expect(sessions.at(-1)).toBe("2026-11-23");
    // one episode per session, each a different stock that fell 10 % the next day: it saved 0.1 × 10 000 × 10 % = $100
    const passes = sessions.map((s, i) => pass("momentum_stocks", s, [], rev(true, eff(SYMS[i], "exit", 0.1, 0))));
    const px = (symbol: string, session: string) => { const i = SYMS.indexOf(symbol); return i >= 0 && session === nextSessionOf(sessions[i]) ? 90 : 100; };
    const h = buildHistory({ session: SESSION, passes, opens: px, universes, start: "2026-01-01" })!;
    expect(h.episodes).toHaveLength(HISTORY_MAX_EPISODES);
    expect(h.episodes[0].from).toBe("2026-11-23");
    expect(h.episodes.map(e => e.from)).toEqual([...h.episodes.map(e => e.from)].sort().reverse());
    expect(h.sessions).toBe(20);
    expect(h.savedUsd).toBe(2000);        // 20 × $100, not 15
    expect(h.costUsd).toBe(39);           // $1 to start each of the 20, $1 to end each of the 19 that ended (the last one goes on)
    expect(h.netUsd).toBe(1961);
  });

  test(`at most ${HISTORY_MAX_MISSES} misses, newest first`, () => {
    const sessions = sessionsFrom("2026-11-02", 13);
    // the held stock loses 10 % every session
    const px = (symbol: string, session: string) => (symbol === "SA" && sessions.includes(session) ? 100 * 0.9 ** sessions.indexOf(session) : 100);
    const passes = sessions.slice(0, 12).map(s => pass("momentum_stocks", s, ["SA"]));
    const h = buildHistory({ session: SESSION, passes, opens: px, universes, start: "2026-01-01" })!;
    expect(h.misses).toHaveLength(HISTORY_MAX_MISSES);
    expect(h.misses[0]).toEqual({ session: "2026-11-17", sleeve: "momentum_stocks", symbol: "SA", dropPct: 10 });
    expect(h.misses.map(m => m.session)).toEqual([...h.misses.map(m => m.session)].sort().reverse());
    expect(h.episodes).toEqual([]);
  });

  test("fitHistory drops the OLDEST entry first until it fits, and keeps the totals", () => {
    const full: CaseHistory = {
      since: "2026-10-26", sessions: 20, savedUsd: 500, costUsd: 20, netUsd: 480,
      episodes: Array.from({ length: 15 }, (_, i) => ({ sleeve: "momentum_stocks" as const, symbol: "NVDA", action: "exit" as const, from: `2026-11-${String(20 - i).padStart(2, "0")}`, to: null, sessions: 1, effectUsd: 10 })),
      misses: Array.from({ length: 10 }, (_, i) => ({ session: `2026-11-${String(19 - i).padStart(2, "0")}`, sleeve: "meanrev_stocks" as const, symbol: "JNJ", dropPct: 5.5 })),
    };
    expect(JSON.stringify(full).length).toBeLessThan(HISTORY_MAX_BYTES);
    const small = fitHistory(full, 900);
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(900);
    expect(small).toMatchObject({ savedUsd: 500, costUsd: 20, netUsd: 480, since: "2026-10-26", sessions: 20 });
    expect(small.episodes.length + small.misses.length).toBeLessThan(25);
    // what stays is the newest of each list
    expect(small.episodes).toEqual(full.episodes.slice(0, small.episodes.length));
    expect(small.misses).toEqual(full.misses.slice(0, small.misses.length));
    const oldestKept = [...small.episodes.map(e => e.from), ...small.misses.map(m => m.session)].sort()[0];
    const newestDropped = [...full.episodes.slice(small.episodes.length).map(e => e.from), ...full.misses.slice(small.misses.length).map(m => m.session)].sort().at(-1)!;
    expect(newestDropped <= oldestKept).toBe(true);
    expect(fitHistory(full)).toEqual(full);
    expect(fitHistory(full, 10)).toMatchObject({ episodes: [], misses: [] });
  });
});

describe("the contract", () => {
  const good = () => buildHistory({ session: SESSION, passes: PASSES, opens, universes: UNIVERSES })!;
  test("a built history parses back unchanged", () => {
    expect(parseHistory(good())).toEqual({ ok: true, value: good() });
    expect(parseCaseFile({ ...caseFile(), history: good() }).ok).toBe(true);
  });
  test("strict: fractions of a dollar, a bad date, a bad action, too many entries, and unknown shapes are refused", () => {
    const bad = (mut: (h: any) => void) => { const h: any = structuredClone(good()); mut(h); return parseHistory(h).ok; };
    expect(bad(h => { h.savedUsd = 155.5; })).toBe(false);
    expect(bad(h => { h.costUsd = -1; })).toBe(false);
    expect(bad(h => { h.since = "2026-13-40"; })).toBe(false);
    expect(bad(h => { h.sessions = 0; })).toBe(false);
    expect(bad(h => { h.episodes[0].action = "keep"; })).toBe(false);
    expect(bad(h => { h.episodes[0].effectUsd = 1.5; })).toBe(false);
    expect(bad(h => { h.episodes[1].to = "2026-01-01"; })).toBe(false);
    expect(bad(h => { h.episodes = Array.from({ length: 16 }, () => h.episodes[0]); })).toBe(false);
    expect(bad(h => { h.misses = Array.from({ length: 11 }, () => h.misses[0]); })).toBe(false);
    expect(bad(h => { h.misses[0].dropPct = 6.25; })).toBe(false);
    expect(bad(h => { h.misses[0].symbol = "not a ticker"; })).toBe(false);
    expect(bad(h => { h.misses[0].sleeve = "crypto"; })).toBe(false);
    expect(parseHistory("x").ok).toBe(false);
    expect(parseCaseFile({ ...caseFile(), history: { since: "2026-11-16" } }).ok).toBe(false);
  });
});

// ── with real SQLite files: read-only, the case file, the model's file ──────────────────────────
let dir: string, tradingPath: string, histPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ai-review-history-")); tradingPath = join(dir, "trading.db"); histPath = join(dir, "historical.db"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeDatabases(passes: HeldPass[]) {
  const db = new Database(tradingPath), hist = new Database(histPath);
  db.exec(`CREATE TABLE portfolio_decisions (id INTEGER PRIMARY KEY, account_id TEXT, strategy_version TEXT, session TEXT, mode TEXT, status TEXT, equity REAL, book_json TEXT, diagnostics_json TEXT)`);
  db.exec(`CREATE TABLE trades (id TEXT PRIMARY KEY, symbol TEXT, side TEXT, entry_price REAL, quantity REAL, entry_time INTEGER, status TEXT, account_id TEXT)`);
  db.exec(`CREATE TABLE equity_snapshots (id INTEGER PRIMARY KEY, profile_id TEXT, equity REAL, snapshot_time INTEGER)`);
  const ins = db.query("INSERT INTO portfolio_decisions (account_id, strategy_version, session, mode, status, equity, book_json, diagnostics_json) VALUES (?, 'v', ?, 'live', ?, ?, ?, ?)");
  for (const p of passes) ins.run(p.sleeve, p.session, p.status, p.equity, JSON.stringify(p.held.map(symbol => ({ symbol, qty: 1, avgEntryPrice: 1 }))), JSON.stringify(p.diagnostics));
  ins.run("meanrev_stocks", "2026-11-20", "submitted", 10_000, "not json", "{}");          // a malformed book reads as nothing held
  db.query("INSERT INTO portfolio_decisions (account_id, strategy_version, session, mode, status, equity, book_json, diagnostics_json) VALUES ('momentum_stocks', 'v2', '2026-11-18', 'observer', 'observed', 1, '[{\"symbol\":\"MSFT\",\"qty\":1}]', ?)").run(JSON.stringify(rev(true, eff("MSFT", "exit", 0.1, 0))));
  hist.exec(`CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL)`);
  const bar = hist.query("INSERT INTO historical_bars VALUES (?, '1d', 'alpaca_wide', ?, ?, ?, ?, ?, 1000)");
  const symbols = [...UNIVERSES.momentum_stocks, ...UNIVERSES.meanrev_stocks, "SH"];
  for (const session of ["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23"]) {
    for (const symbol of symbols) { const o = opens(symbol, session) ?? 100; bar.run(symbol, Date.parse(`${session}T05:00:00Z`), o, o, o, o); }
  }
  db.close(); hist.close();
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const get = (url: unknown) => { void url; return Response.json({ news: [], next_page_token: null }); };

describe("from the databases", () => {
  test("readHistory over temp databases is the same history; both files are byte-identical afterwards", () => {
    writeDatabases(PASSES);
    const before = [sha(tradingPath), sha(histPath)];
    const t = new Database(tradingPath, { readonly: true }), h = new Database(histPath, { readonly: true });
    try {
      const got = readHistory(t, h, SESSION, UNIVERSES)!;
      expect(got).toEqual(buildHistory({ session: SESSION, passes: PASSES, opens, universes: UNIVERSES })!);
      expect(got.misses.map(m => m.symbol)).toEqual(["JNJ", "MSFT"]);   // the observer's row and the malformed book changed nothing
    } finally { t.close(); h.close(); }
    expect([sha(tradingPath), sha(histPath)]).toEqual(before);
  });

  test("the builder stays read-only and GET-only (source scan of every file that feeds the history)", () => {
    for (const f of ["history.ts", "journalDb.ts", "casefile.ts"]) {
      const src = readFileSync(join(import.meta.dir, f), "utf8");
      expect(src).not.toMatch(/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|DROP TABLE|ALTER TABLE|CREATE TABLE)\b/i);
      expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/i);
      expect(src).not.toMatch(/\.(run|exec)\(/);
    }
    expect(ALLOWED_HOSTS).toEqual(["data.alpaca.markets"]);
  });

  test("the case file carries it, the file the model reads carries it too (one episode or miss per line), and the whole stays under its cap", async () => {
    writeDatabases(PASSES);
    const t = new Database(tradingPath, { readonly: true }), h = new Database(histPath, { readonly: true });
    try {
      const calls: string[] = [];
      const fetchFn = (async (u: any, init: any) => { calls.push(`${init?.method ?? "GET"} ${new URL(String(u)).hostname}`); return get(u); }) as unknown as typeof fetch;
      const cf = await buildCaseFile({ session: SESSION, nowMs: Date.parse("2026-11-24T13:10:00Z"), tradingDb: t, historicalDb: h, universes: UNIVERSES, fetchFn, keyId: "K", secretKey: "S", sleep: async () => {} });
      expect(cf.history).toEqual(buildHistory({ session: SESSION, passes: PASSES, opens, universes: UNIVERSES }));
      expect(parseCaseFile(JSON.parse(JSON.stringify(cf))).ok).toBe(true);
      expect(new Set(calls)).toEqual(new Set(["GET data.alpaca.markets"]));

      const text = serializeForModel(cf);
      const { applies, ...forModel } = cf;
      expect(JSON.parse(text)).toEqual(forModel);
      expect(JSON.parse(text).history.episodes).toHaveLength(3);
      expect(text).not.toContain('"applies"');
      expect(Math.max(...text.split("\n").map(l => l.length))).toBeLessThan(1000);

      // the worst case: a maximal history next to a maximal news load stays under the cap and valid
      const fat = caseFile({ history: { ...cf.history!, episodes: Array.from({ length: 15 }, () => cf.history!.episodes[1]), misses: Array.from({ length: 10 }, () => cf.history!.misses[0]) } });
      for (const s of fat.sleeves) for (const y of s.symbols) y.news = Array.from({ length: 8 }, (_, i) => ({ at: "2026-11-23T10:00:00.000Z", source: "benzinga", headline: `${y.symbol} headline ${i} ${"w".repeat(80)}`, summary: "s".repeat(300), url: `https://news.example.com/${y.symbol}/${i}/${"p".repeat(90)}` }));
      expect(JSON.stringify(fat).length).toBeGreaterThan(MAX_CASEFILE_BYTES);
      const fitted = fitSize(fat);
      expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_CASEFILE_BYTES);
      expect(fitted.history).toEqual(fat.history);
      expect(JSON.stringify(fat.history).length).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
      expect(parseCaseFile(fitted).ok).toBe(true);
    } finally { t.close(); h.close(); }
  });

  test("absent when empty: no journal rows (or no journal table at all) leave the case file without `history`", async () => {
    const empty = new Database(tradingPath);
    empty.exec(`CREATE TABLE trades (id TEXT PRIMARY KEY, symbol TEXT, side TEXT, entry_price REAL, quantity REAL, entry_time INTEGER, status TEXT, account_id TEXT)`);
    empty.exec(`CREATE TABLE equity_snapshots (id INTEGER PRIMARY KEY, profile_id TEXT, equity REAL, snapshot_time INTEGER)`);
    empty.close();
    const hist = new Database(histPath);
    hist.exec(`CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, timestamp INTEGER, close REAL)`);
    hist.query("INSERT INTO historical_bars VALUES ('NVDA', '1d', ?, 100)").run(Date.parse("2026-11-23T05:00:00Z"));
    hist.close();
    const t = new Database(tradingPath, { readonly: true }), h = new Database(histPath, { readonly: true });
    try {
      const cf = await buildCaseFile({ session: SESSION, nowMs: Date.parse("2026-11-24T13:10:00Z"), tradingDb: t, historicalDb: h, universes: { momentum_stocks: ["NVDA"], meanrev_stocks: [] }, fetchFn: (async (u: any) => get(u)) as unknown as typeof fetch, keyId: "K", secretKey: "S", sleep: async () => {} });
      expect(cf.history).toBeUndefined();
      expect("history" in cf).toBe(false);
      expect(serializeForModel(cf)).not.toContain('"history"');
      expect(cf.warnings ?? []).toEqual([]);
      expect(readHistory(t, h, SESSION, UNIVERSES)).toBeUndefined();
    } finally { t.close(); h.close(); }
  });

  test("a history that cannot be read never costs the day's case file: it is left out with a warning", async () => {
    writeDatabases(PASSES);
    const hist = new Database(histPath);
    hist.exec("ALTER TABLE historical_bars RENAME COLUMN \"open\" TO \"opening\"");
    hist.close();
    const t = new Database(tradingPath, { readonly: true }), h = new Database(histPath, { readonly: true });
    try {
      const cf = await buildCaseFile({ session: SESSION, nowMs: Date.parse("2026-11-24T13:10:00Z"), tradingDb: t, historicalDb: h, universes: UNIVERSES, fetchFn: (async (u: any) => get(u)) as unknown as typeof fetch, keyId: "K", secretKey: "S", sleep: async () => {} });
      expect(cf.history).toBeUndefined();
      expect(cf.warnings?.join(" ")).toContain("history unavailable");
      expect(cf.sleeves[0].symbols.length).toBeGreaterThan(0);
    } finally { t.close(); h.close(); }
  });
});
