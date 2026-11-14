// scripts/ai-review-report.ts end to end on temp databases: an exit that saves money, one that costs, a reduce, a pending day,
// costs once at the start and once at the end, applied and hypothetical apart, nothing written to either database.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyOpenLookup, readPasses, reportFrom } from "./ai-review-report";

let dir: string, tradingPath: string, histPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ai-review-report-")); tradingPath = join(dir, "trading.db"); histPath = join(dir, "historical.db"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const eff = (symbol: string, action: string, modelWeight: number, appliedWeight: number) => ({ symbol, action, factor: appliedWeight / modelWeight, modelWeight, appliedWeight });
const review = (applied: boolean, ...effects: any[]) => ({ aiReview: { decisionId: "abc123def456", decisionSession: "2026-11-16", applied, effects }, vols: { NVDA: 0.4 }, freshness: { stale: [] } });

function build(passes: Array<[string, string, string, number, unknown]>, opens: Record<string, number>) {
  const db = new Database(tradingPath), hist = new Database(histPath);
  db.exec(`CREATE TABLE portfolio_decisions (id INTEGER PRIMARY KEY, account_id TEXT, strategy_version TEXT, session TEXT, mode TEXT, status TEXT, equity REAL, diagnostics_json TEXT)`);
  hist.exec(`CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL)`);
  const ins = db.query("INSERT INTO portfolio_decisions (account_id, strategy_version, session, mode, status, equity, diagnostics_json) VALUES (?, 'v', ?, ?, ?, ?, ?)");
  for (const [sleeve, session, status, equity, diagnostics] of passes) ins.run(sleeve, session, "live", status, equity, JSON.stringify(diagnostics));
  ins.run("momentum_stocks", "2026-11-12", "observer", "observed", 10_000, JSON.stringify(review(true, eff("NVDA", "exit", 0.2, 0)))); // an observer is not a pass
  const bar = hist.query("INSERT INTO historical_bars VALUES (?, '1d', 'alpaca_wide', ?, ?, ?, ?, ?, 1000)");
  for (const [key, open] of Object.entries(opens)) { const [symbol, session] = key.split("@"); bar.run(symbol, Date.parse(`${session}T04:00:00Z`), open, open, open, open); }
  db.close(); hist.close();
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("the report over temp databases", () => {
  const S = (s: string, session: string, equity = 10_000, diagnostics: unknown = {}) => [s, session, "submitted", equity, diagnostics] as [string, string, string, number, unknown];
  const fixture = () => build([
    S("momentum_stocks", "2026-11-16", 10_000, review(true, eff("NVDA", "exit", 0.2, 0), eff("AAPL", "exit", 0.1, 0))),
    S("momentum_stocks", "2026-11-17", 10_000, review(true, eff("NVDA", "exit", 0.2, 0))),
    S("momentum_stocks", "2026-11-18"),
    S("meanrev_stocks", "2026-11-16", 10_000, review(true, eff("JPM", "reduce", 0.05, 0.025))),
    S("meanrev_stocks", "2026-11-17", 10_000, review(true, eff("XOM", "exit", 0.04, 0))),      // goes on: its next open is not in yet
    S("meanrev_stocks", "2026-11-18"),
  ], { "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95, "NVDA@2026-11-18": 90, "AAPL@2026-11-16": 200, "AAPL@2026-11-17": 210, "JPM@2026-11-16": 250, "JPM@2026-11-17": 240, "XOM@2026-11-17": 100 });

  test("saves, costs, reduce, pending, and the costs once at each end", () => {
    fixture();
    const l = reportFrom(tradingPath, histPath);
    const by = Object.fromEntries(l.applied.episodes.map(e => [e.symbol, e]));
    expect(by.NVDA.effectUsd).toBeCloseTo(205.263, 2);
    expect(by.AAPL.effectUsd).toBeCloseTo(-50, 9);
    expect(by.JPM.effectUsd).toBeCloseTo(10, 9);
    expect(by.XOM).toMatchObject({ pendingDays: 1, endSession: "2026-11-18", effectUsd: 0 }); // XOM@2026-11-18 is not in the data
    expect([by.NVDA, by.AAPL, by.JPM, by.XOM].map(e => e.costUsd)).toEqual([4, 2, 0.5, 0.8]);
    expect(l.applied).toMatchObject({ decisions: 4, cases: 5, pendingCases: 1 });
    expect(l.hypothetical.decisions).toBe(0);
  });

  test("the observer's row and the malformed ones are not passes; the other diagnostics are never parsed", () => {
    fixture();
    const db = new Database(tradingPath, { readonly: true });
    try {
      const passes = readPasses(db);
      expect(passes).toHaveLength(6);
      expect(passes.every(p => Object.keys(p.diagnostics as object).join() === "aiReview")).toBe(true);
      expect(readPasses(db, "2026-11-17")).toHaveLength(4);
    } finally { db.close(); }
  });

  test("read-only: both databases are byte-identical after the report", () => {
    fixture();
    const before = [sha(tradingPath), sha(histPath)];
    reportFrom(tradingPath, histPath);
    expect([sha(tradingPath), sha(histPath)]).toEqual(before);
  });

  test("a database without the journal table, or an empty one, reads as nothing", () => {
    new Database(tradingPath).exec("CREATE TABLE other (x)");
    new Database(histPath).exec("CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL)");
    expect(reportFrom(tradingPath, histPath).applied.decisions).toBe(0);
  });

  test("dailyOpenLookup finds a bar stamped anywhere inside the session's UTC day (04:00Z or 05:00Z) and nothing outside it", () => {
    build([], {});
    const hist = new Database(histPath);
    hist.query("INSERT INTO historical_bars VALUES ('ZZZ', '1d', 'alpaca_wide', ?, 12.5, 1, 1, 1, 1)").run(Date.parse("2026-11-16T05:00:00Z"));
    const open = dailyOpenLookup(hist);
    expect(open("ZZZ", "2026-11-16")).toBe(12.5);
    expect(open("ZZZ", "2026-11-17")).toBeNull();
    expect(open("QQQ", "2026-11-16")).toBeNull();
    hist.close();
  });

  test("the CLI: --json prints the whole ledger, the default prints the Spanish summary; a missing database exits 2", async () => {
    fixture();
    const run = async (...args: string[]) => {
      const p = Bun.spawn(["bun", join(import.meta.dir, "ai-review-report.ts"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: process.env.TMPDIR } });
      return { out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited };
    };
    const json = await run("--db", tradingPath, "--hist", histPath, "--json");
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out);
    expect(Object.keys(parsed).sort()).toEqual(["applied", "generatedAt", "hypothetical"]);
    expect(parsed.applied.decisions).toBe(4);
    const text = await run("--db", tradingPath, "--hist", histPath);
    expect(text.code).toBe(0);
    expect(text.out).toStartWith("La revisión de IA lleva 4 decisiones aplicadas en 2 días: evitó $215 de pérdidas y dejó de ganar $50");
    const missing = await run("--db", join(dir, "nope.db"), "--hist", histPath);
    expect(missing.code).toBe(2);
  });

  test("hypothetical days (the switch was off) get their own block and do not touch the applied totals", () => {
    build([
      S("momentum_stocks", "2026-11-16", 10_000, review(false, eff("NVDA", "exit", 0.2, 0))),
      S("momentum_stocks", "2026-11-17"),
    ], { "NVDA@2026-11-16": 100, "NVDA@2026-11-17": 95 });
    const l = reportFrom(tradingPath, histPath);
    expect(l.applied).toMatchObject({ decisions: 0, cases: 0, netUsd: 0 });
    expect(l.hypothetical).toMatchObject({ decisions: 1, cases: 1 });
    expect(l.hypothetical.savedUsd).toBeCloseTo(100, 9);
  });
});
