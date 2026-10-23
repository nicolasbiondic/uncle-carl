/**
 * copySignal through the research protocol: validation, identity, the replay
 * simulator, the nested walk-forward and the criteria evaluator. SYNTHETIC
 * tapes and synthetic events only (owner rule: nothing real before the
 * director pre-registers).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  candidateToReplayConfig, manifestIdentity, runWalkForward, validateManifest, validatePortfolioBlock,
  type ExperimentManifest, type PortfolioReplayConfig as PortfolioReplayConfigLike,
} from "./walk-forward";
import { hashReplayConfig } from "./backtest-momentum-wf";
import { coreKernel, makePortfolioRunner, simulatePortfolioWindow } from "./portfolio-replay";
import { CRITERIA, evaluatePortfolioCriteria, designOf, passiveDecideFor, makePassiveRunner } from "./portfolio-criteria";
import { PORTFOLIO_CODE_FILES } from "./portfolio-wf";
import { SignalBook, loadSignalEvents, openSignalsDbForWrite, replaceSourceRows, type SignalRow } from "./lib/signalData";
import { IndexMembershipView, loadSessionSeries } from "./lib/portfolioData";
import { countPicks } from "./copy-signal-counts";
import { SEC_FORM4_BUY_SOURCE, knownAtMsFor } from "./lib/secInsider";
import { usSessionTimestamps, writeDailyFixture } from "./lib/portfolioSynthetic";
import { LIVE_STOCK_EXCLUDES, missingLiveExcludes } from "./lib/liveStockExcludes";
import type { CopySignalConfig, VenueRules } from "../src/portfolio-engine/types";

const tmp = mkdtempSync(join(tmpdir(), "copy-signal-"));
const outputDirs: string[] = [];
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const d of outputDirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── synthetic world ────────────────────────────────────────────────────────

const members = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"];
const barsDb = join(tmp, "sp.db");
const SESSIONS = 700;
writeDailyFixture(barsDb, {
  source: "alpaca_wide", from: "2020-01-02", sessions: SESSIONS,
  series: [
    { symbol: "SPY", seed: 1, startPrice: 300, driftAnnual: 0.15, volAnnual: 0.18 },
    ...members.map((s, i) => ({ symbol: s, seed: 100 + i, startPrice: 50 + 10 * i, driftAnnual: 0.05 + 0.03 * i, volAnnual: 0.2 + 0.05 * i })),
  ],
  membership: [
    ...members.slice(0, 7).map(t => ({ index: "synth", ticker: t, start: "2010-01-01", end: null })),
    { index: "synth", ticker: "HHH", start: "2010-01-01", end: "2022-01-15" },
    { index: "synth", ticker: "SPY", start: "2010-01-01", end: null },
  ],
});
const sessionDates = usSessionTimestamps("2020-01-02", SESSIONS).map(t => new Date(t).toISOString().slice(0, 10));

function row(symbol: string, knownDate: string, actors: string[], weight: number): SignalRow {
  return {
    source: SEC_FORM4_BUY_SOURCE, symbol, known_at_ms: knownAtMsFor(knownDate), weight,
    meta_json: JSON.stringify({ actors, role: ["officer"], insiderClass: "opportunistic", lagDays: 2, plan10b5_1: false, accession: `${symbol}-${knownDate}-${actors.join("")}` }),
  };
}
/** Every 12th session from #300 on, a 2-insider cluster in the next symbol of the rotation. */
function baselineRows(): SignalRow[] {
  // Coverage markers: one event of a non-member name at each end of the tape (never tradable).
  const out: SignalRow[] = [row("ZZZ", sessionDates[10], ["f0"], 1_000), row("ZZZ", sessionDates[695], ["f1"], 1_000)];
  let k = 0;
  for (let i = 300; i < 650; i += 12, k++) {
    const sym = members[k % members.length];
    out.push(row(sym, sessionDates[i], [`i${k}a`], 60_000), row(sym, sessionDates[i], [`i${k}b`], 40_000));
  }
  return out;
}
function writeSignals(name: string, rows: SignalRow[]): string {
  const path = join(tmp, name);
  const db = openSignalsDbForWrite(path);
  replaceSourceRows(db, SEC_FORM4_BUY_SOURCE, rows);
  db.close();
  return path;
}
const signalsDb = writeSignals("signals.db", baselineRows());

const alpaca: VenueRules = { venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0 };
const copy = (over: Partial<CopySignalConfig> = {}): CopySignalConfig => ({
  kind: "copySignal", source: SEC_FORM4_BUY_SOURCE, lookbackDays: 10, minDistinctInsiders: 2, minDollar: 50_000,
  topN: 3, holdDays: 30, weighting: "equal", perNameCap: 0.4, maxGross: 0.9, exclude: [...LIVE_STOCK_EXCLUDES], ...over,
});

function manifest(signalsPath = signalsDb, name = "copy-synthetic"): ExperimentManifest {
  return {
    name, sleeve: "stocks", trialAccounting: { priorUniqueTrials: 0, complete: true },
    data: { dbPath: barsDb, source: "alpaca_wide", timeframe: "1d", universe: ["SPY"], refSymbol: "SPY", rthOnly: false, funding: false, barMinutes: 1440, barMinutesEq: 1440, membership: { index: "synth", exclude: ["SPY"] }, signals: { dbPath: signalsPath } },
    asOf: "2022-09-01T00:00:00Z",
    window: { from: "2021-03-01", to: "2022-09-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.02, warmupDays: 300 },
    costs: { base: { slippageBps: 2, commissionBps: 0 }, stress: { slippageBps: 5, commissionBps: 0 } },
    ledger: { initialEquity: 50_000 } as ExperimentManifest["ledger"],
    candidates: [
      { name: "equal-h30", cadenceMin: 1440, portfolio: { strategy: copy(), venue: alpaca } },
      { name: "invvol-h60", cadenceMin: 1440, portfolio: { strategy: copy({ weighting: "inverseVol", volLookback: 40, holdDays: undefined, holdSessions: 40, insiderClass: "opportunistic", exclude10b5_1: true, maxReportLagDays: 30, minDollarPerInsider: 25_000 }), venue: alpaca } },
    ],
    acceptance: { minSharpe: -10, maxDrawdown: 1, minTotalReturn: -1, maxConcentration: 1, minTrades: 0 },
  };
}

// ── validation ─────────────────────────────────────────────────────────────

describe("copySignal manifest validation", () => {
  test("a well-formed manifest validates", () => {
    expect(() => validateManifest(manifest())).not.toThrow();
  });

  test("strict strategy shape: unknown keys, weighting/volLookback coupling, bounds", () => {
    const block = (s: Record<string, unknown>) => () => validatePortfolioBlock({ strategy: s, venue: alpaca });
    expect(block({ ...copy() })).not.toThrow();
    expect(block({ ...copy(), extra: 1 })).toThrow(/unknown keys: extra/);
    expect(block({ ...copy({ weighting: "inverseVol" }) })).toThrow(/volLookback/);
    expect(block({ ...copy({ volLookback: 20 }) })).toThrow(/only for weighting "inverseVol"/);
    expect(block({ ...copy(), weighting: "risk" })).toThrow(/weighting/);
    expect(block({ ...copy({ topN: 0 }) })).toThrow(/topN/);
    expect(block({ ...copy({ holdDays: 1.5 }) })).toThrow(/holdDays/);
    expect(block({ ...copy({ holdDays: undefined }) })).toThrow(/exactly one of holdDays/);
    expect(block({ ...copy({ holdSessions: 21 }) })).toThrow(/exactly one of holdDays/);
    expect(block({ ...copy({ holdDays: undefined, holdSessions: 21 }) })).not.toThrow();
    expect(block({ ...copy({ holdDays: undefined, holdSessions: 0 }) })).toThrow(/holdSessions/);
    expect(block({ ...copy({ insiderClass: "routine" }) })).not.toThrow();
    expect(block({ ...copy(), insiderClass: "lucky" })).toThrow(/insiderClass/);
    expect(block({ ...copy({ exclude10b5_1: true }) })).not.toThrow();
    expect(block({ ...copy(), exclude10b5_1: "yes" })).toThrow(/exclude10b5_1/);
    expect(block({ ...copy({ maxReportLagDays: 30 }) })).not.toThrow();
    expect(block({ ...copy({ maxReportLagDays: -1 }) })).toThrow(/maxReportLagDays/);
    expect(block({ ...copy({ minDollarPerInsider: 25_000 }) })).not.toThrow();
    expect(block({ ...copy({ minDollarPerInsider: -5 }) })).toThrow(/minDollarPerInsider/);
    expect(block({ ...copy({ minDollar: -1 }) })).toThrow(/minDollar/);
    expect(block({ ...copy({ perNameCap: 0 }) })).toThrow(/perNameCap/);
    expect(block({ ...copy({ maxGross: 3 }) })).toThrow(/maxGross/);
    expect(block({ ...copy({ roles: [] }) })).toThrow(/roles/);
    expect(block({ ...copy({ roles: ["officer", "director"] }) })).not.toThrow();
    expect(block({ ...copy({ source: "" }) })).toThrow(/source/);
  });

  test("shared Alpaca wallet: every candidate excludes the live stock universes and the treasury ETFs", () => {
    const m = manifest();
    const strip = (drop: string[]) => ({ ...m, candidates: [{ name: "x", cadenceMin: 1440, portfolio: { strategy: copy({ exclude: LIVE_STOCK_EXCLUDES.filter(s => !drop.includes(s)) }), venue: alpaca } }] });
    expect(() => validateManifest(strip([]))).not.toThrow();
    expect(() => validateManifest(strip(["SGOV"]))).toThrow(/missing: SGOV/); // treasury
    expect(() => validateManifest(strip(["NVDA"]))).toThrow(/missing: NVDA/); // momentum_stocks
    expect(() => validateManifest(strip(["JPM", "XLE"]))).toThrow(/missing: JPM, XLE/); // meanrev_stocks
    expect(() => validateManifest({ ...m, candidates: [{ name: "x", cadenceMin: 1440, portfolio: { strategy: copy({ exclude: [] }), venue: alpaca } }] })).toThrow(/shared Alpaca wallet/);
    expect(missingLiveExcludes(["SPY"]).length).toBe(LIVE_STOCK_EXCLUDES.length - 1);
  });

  test("copySignal requires data.membership and data.signals; no other kind may set data.signals", () => {
    const m = manifest();
    expect(() => validateManifest({ ...m, data: { ...m.data, signals: undefined } })).toThrow(/requires data.signals/);
    expect(() => validateManifest({ ...m, data: { ...m.data, membership: undefined } })).toThrow(/requires data.membership/);
    expect(() => validateManifest({ ...m, data: { ...m.data, signals: { dbPath: "" } } })).toThrow(/dbPath/);
    expect(() => validateManifest({ ...m, data: { ...m.data, signals: { dbPath: "x", extra: 1 } as never } })).toThrow(/unknown keys/);
    const vm = { ...m, data: { ...m.data, membership: undefined }, candidates: [{ name: "vm", cadenceMin: 1440, portfolio: { strategy: { kind: "volManaged" as const, universe: ["SPY"], inceptionGuardBars: 5, volLookback: 5, covLookback: 5, portfolioVolTarget: 0.15, annualization: 252 as const, perAssetCap: 1, maxGross: 1 }, venue: alpaca } }] };
    expect(() => validateManifest(vm as ExperimentManifest)).toThrow(/must not set data.signals/);
    const legacy = { ...vm, data: { ...vm.data, signals: undefined } };
    expect(() => validateManifest(legacy as ExperimentManifest)).not.toThrow();
  });
});

// ── identity ───────────────────────────────────────────────────────────────

describe("live stock excludes", () => {
  test("the literal lists of the live sleeves and the treasury sweep (a change to a live universe forces a manifest review)", () => {
    const e1 = "SPY QQQ IWM GLD AAPL MSFT NVDA META GOOGL AMZN SMH".split(" ");
    const e2 = "ABBV AVGO BAC CAT COST CVX DIS GE HD HON JNJ JPM KO LLY MA MCD MRK NFLX NKE ORCL PG QCOM UNH V WMT XLE XLF XLI XLP XLV XOM SLV".split(" ");
    const treasury = ["BOXX", "SGOV", "BIL"];
    expect([...LIVE_STOCK_EXCLUDES]).toEqual([...new Set([...e1, ...e2, ...treasury])].sort());
    expect(LIVE_STOCK_EXCLUDES.length).toBe(46);
  });
});

describe("copySignal identity", () => {
  test("the signals path is runtime-only: configHash and candidate hashes ignore it; the candidate carries the path", () => {
    const a = manifest(signalsDb), b = manifest(join(tmp, "elsewhere.db"));
    const asOfMs = Date.parse("2022-09-01T00:00:00Z");
    expect(JSON.stringify(manifestIdentity(a, asOfMs))).toBe(JSON.stringify(manifestIdentity(b, asOfMs)));
    const ca = candidateToReplayConfig(a, a.candidates[0], "base"), cb = candidateToReplayConfig(b, b.candidates[0], "base");
    expect(hashReplayConfig(ca)).toBe(hashReplayConfig(cb));
    expect(ca.signalsDbPath).toBe(signalsDb);
    // a different strategy parameter IS a different candidate
    const c = candidateToReplayConfig({ ...a, candidates: [{ ...a.candidates[0], portfolio: { strategy: copy({ topN: 4 }), venue: alpaca } }] }, { name: "x", cadenceMin: 1440, portfolio: { strategy: copy({ topN: 4 }), venue: alpaca } }, "base");
    expect(hashReplayConfig(c)).not.toBe(hashReplayConfig(ca));
  });

  test("a legacy manifest's resolved config never gains a signals key", () => {
    const m = manifest();
    const legacy = { ...m, data: { ...m.data, signals: undefined, membership: undefined } } as ExperimentManifest;
    const cfg = candidateToReplayConfig(legacy, { name: "vm", cadenceMin: 1440 }, "base");
    expect("signalsDbPath" in cfg).toBe(false);
    expect(JSON.stringify(manifestIdentity(legacy, Date.parse("2022-09-01T00:00:00Z")))).not.toContain("signals");
  });

  test("designOf: copySignal is D4 with the stock benchmarks (SPY) and the equal-weight member passive", () => {
    expect(designOf(copy())).toBe("D4");
    expect(CRITERIA.D4.c5Market).toBe("spy");
    expect(passiveDecideFor(copy()).name).toBe("passiveCopyBenchmarkDecide");
  });
});

// ── the simulator ──────────────────────────────────────────────────────────

describe("copySignal replay", () => {
  test("D4 passive invests in >100 PIT names despite the strategy's 1% band", async () => {
    const path = join(tmp, "passive-wide.db");
    const names = Array.from({ length: 120 }, (_, i) => `P${i}`);
    writeDailyFixture(path, {
      source: "alpaca_wide", from: "2021-02-01", sessions: 80,
      series: ["SPY", ...names].map((symbol, i) => ({ symbol, seed: i + 1, startPrice: 100, driftAnnual: 0.2, volAnnual: 0.2 })),
      membership: names.map(ticker => ({ index: "synth", ticker, start: "2010-01-01", end: null })),
    });
    const m = manifest();
    const candidate = { ...m.candidates[0], portfolio: { strategy: copy(), venue: { ...alpaca, rebalanceBand: 0.01 } } };
    const cfg = candidateToReplayConfig(m, candidate, "base", path);
    const r = await makePassiveRunner(copy())(cfg, { label: "passive", from: "2021-03-01", to: "2021-04-01" });
    expect(r).not.toBeNull();
    expect(r!.trades).toBe(120);
    expect((r as ReturnType<typeof simulatePortfolioWindow>).portfolioDiagnostics.avgGross).toBeGreaterThan(0.95);
    expect(r!.dailyReturns.some(d => d.ret !== 0)).toBe(true);
    expect(r!.sharpe).not.toBe(0);
    // Monthly buy-and-hold, not a daily equal-weight turnover strategy.
    expect((r as ReturnType<typeof simulatePortfolioWindow>).portfolioDiagnostics.adjustmentOrders).toBe(0);
    expect(candidate.portfolio.venue.rebalanceBand).toBe(0.01);
  });
  const win = { label: "t", from: "2021-06-01T00:00:00Z", to: "2021-09-01T00:00:00Z" };
  const cfgOf = (signalsPath: string, strategy = copy()) => {
    const m = manifest(signalsPath);
    return candidateToReplayConfig(m, { name: "c", cadenceMin: 1440, portfolio: { strategy, venue: alpaca } }, "base") as PortfolioReplayConfigLike;
  };

  test("trades the event symbols, long-only, inside the point-in-time membership; gross stays under maxGross", () => {
    const r = simulatePortfolioWindow(cfgOf(signalsDb), win);
    expect(r.trades).toBeGreaterThan(0);
    const traded = Object.keys(r.tradesBySymbol);
    expect(traded.length).toBeGreaterThan(1);
    expect(traded.every(s => members.includes(s))).toBe(true);
    expect(r.portfolioDiagnostics.maxGross).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.portfolioDiagnostics.avgGross).toBeGreaterThan(0.05);
    expect(r.closedTrades.every(t => t.side === "buy")).toBe(true);
    expect(r.ruined).toBe(false);
  });

  test("no look-ahead end to end: events known AFTER a session never move the books up to it", () => {
    const base = simulatePortfolioWindow(cfgOf(signalsDb), win);
    // Extra cluster known on session #385 (inside the window; HHH/AAA are the rotation's own picks around it);
    // it may only matter from the NEXT session's decision on.
    const day = sessionDates[385];
    const more = baselineRows().concat(row("CCC", day, ["z1"], 90_000), row("CCC", day, ["z2"], 90_000), row("DDD", day, ["z3"], 90_000), row("DDD", day, ["z4"], 90_000));
    const extra = simulatePortfolioWindow(cfgOf(writeSignals("signals-extra.db", more)), win);
    const upTo = base.dailyReturns.filter(d => d.date <= day);
    expect(upTo.length).toBeGreaterThan(10);
    for (const d of upTo) expect(extra.dailyReturns.find(x => x.date === d.date)!.ret).toBe(d.ret);
    // …and it does matter afterwards (the test would be vacuous otherwise)
    expect(extra.dailyReturns.some(x => base.dailyReturns.find(b => b.date === x.date)!.ret !== x.ret)).toBe(true);
    // the same events known only after the window ends change nothing at all
    const late = baselineRows().concat(row("GGG", sessionDates[600], ["z1"], 90_000), row("GGG", sessionDates[600], ["z2"], 90_000));
    const lateRun = simulatePortfolioWindow(cfgOf(writeSignals("signals-late.db", late)), win);
    expect(lateRun.dailyReturns).toEqual(base.dailyReturns);
    expect(lateRun.finalEquity).toBe(base.finalEquity);
  });

  test("a window the events do not cover fails closed (an uncovered tail would silently read as cash)", () => {
    const rows = baselineRows();
    const cut = sessionDates.findIndex(d => d >= "2021-08-20");
    const noTail = writeSignals("signals-notail.db", rows.filter(r => r.known_at_ms < knownAtMsFor(sessionDates[cut])));
    expect(() => simulatePortfolioWindow(cfgOf(noTail), win)).not.toThrow(); // window ends 2021-09-01, data to ~2021-08-20: inside the tolerance
    expect(() => simulatePortfolioWindow(cfgOf(noTail), { ...win, to: "2021-12-01T00:00:00Z" })).toThrow(/ends .* shorten the window/);
    const noHead = writeSignals("signals-nohead.db", rows.filter(r => r.known_at_ms > knownAtMsFor(sessionDates[360])));
    expect(() => simulatePortfolioWindow(cfgOf(noHead), win)).toThrow(/starts .* lookback/);
    expect(() => simulatePortfolioWindow(cfgOf(writeSignals("signals-other.db", rows.map(r => ({ ...r, source: "other" })))), win)).toThrow(/no rows/);
  });

  test("the replay needs data.signals (fails closed)", () => {
    const cfg = cfgOf(signalsDb);
    delete cfg.signalsDbPath;
    expect(() => simulatePortfolioWindow(cfg, win)).toThrow(/signalsDbPath/);
  });
});

// ── descriptive counts ─────────────────────────────────────────────────────

describe("copy-signal-counts", () => {
  test("picks per year and mean positions from the engine's own selection: counts only, no returns", () => {
    const bars = new Database(barsDb, { readonly: true });
    const membership = IndexMembershipView.load(bars, "synth", ["SPY"]);
    const series = loadSessionSeries(bars, ["SPY", ...members], "alpaca_wide", "1d", Date.parse("2021-01-01"), Date.parse("2022-09-30"), "us");
    bars.close();
    const sdb = new Database(signalsDb, { readonly: true });
    const book = new SignalBook(loadSignalEvents(sdb, SEC_FORM4_BUY_SOURCE, 0, Date.parse("2022-10-01")), "us");
    sdb.close();
    const world = { series, sessions: series.get("SPY")!.dates, membership, book };
    const r = countPicks(copy({ topN: 4 }), world, "2021-03-01", "2022-08-31");
    expect(r.total.newPicks).toBeGreaterThan(5);
    expect(r.total.meanHeld).toBeGreaterThan(0.5);
    expect(r.total.meanHeld).toBeLessThanOrEqual(4);
    expect(r.total.meanGross).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(Object.keys(r.years)).toEqual(["2021", "2022"]);
    expect(r.total.uniqueSymbols).toBeGreaterThan(2);
    expect(JSON.stringify(r)).not.toMatch(/return|pnl|sharpe/i);
    // a stricter cluster fires less
    const strict = countPicks(copy({ topN: 4, minDistinctInsiders: 3 }), world, "2021-03-01", "2022-08-31");
    expect(strict.total.newPicks).toBe(0);
    // a class nobody belongs to picks nothing; the events here are all "opportunistic"
    expect(countPicks(copy({ topN: 4, insiderClass: "routine" }), world, "2021-03-01", "2022-08-31").total.newPicks).toBe(0);
    expect(countPicks(copy({ topN: 4, insiderClass: "opportunistic" }), world, "2021-03-01", "2022-08-31").total.newPicks).toBe(r.total.newPicks);
  });
});

// ── the protocol ───────────────────────────────────────────────────────────

describe("copySignal through the nested walk-forward and the criteria", () => {
  test("runs end to end; the signals rows enter the data identity; D4 criteria with SPY and equal-weight member benchmarks", async () => {
    const m = manifest();
    const { summary, outputDir } = await runWalkForward(m, { runner: makePortfolioRunner(coreKernel), codeFiles: PORTFOLIO_CODE_FILES, breakEven: false });
    outputDirs.push(outputDir);
    expect(summary.complete).toBe(true);
    expect(summary.skippedFolds).toEqual([]);
    expect(summary.outerTests.map(t => t.foldPath)).toEqual(["0/test", "1/test"]);
    const traded = new Set(summary.outerTests.flatMap(t => Object.keys(t.result.tradesBySymbol)));
    expect(traded.size).toBeGreaterThan(1);
    expect(traded.has("SPY")).toBe(false);

    const report = await evaluatePortfolioCriteria(m, summary, outputDir, "synthetic-copy", { kernel: coreKernel, quiet: true });
    expect(report.design).toBe("D4");
    expect(report.criteria.C5.detail?.benchmark).toBe("spy");
    expect(typeof report.criteria.C4.value).toBe("number");
    expect(report.criteria.C4.detail?.observations).toBeGreaterThan(100);
    expect(report.criteria.C4.detail?.passiveSharpe).toBeDefined();
    expect(typeof report.criteria.C6b.value).toBe("number"); // ex-top-decile re-run through strategy.exclude, with the real signals

    // Data identity: same config, different event rows → same configHash, different dataHash/manifestHash.
    const changed = writeSignals("signals-changed.db", baselineRows().map((r, i) => (i === 0 ? { ...r, weight: r.weight + 1 } : r)));
    const second = await runWalkForward(manifest(changed), { runner: makePortfolioRunner(coreKernel), codeFiles: PORTFOLIO_CODE_FILES, breakEven: false, dryRun: true });
    expect(second.summary.configHash).toBe(summary.configHash);
    expect(second.summary.dataHash).not.toBe(summary.dataHash);
    expect(second.summary.manifestHash).not.toBe(summary.manifestHash);
  }, 240_000);

  test("the code identity covers the copySignal kernel and the signal data module", () => {
    expect(PORTFOLIO_CODE_FILES).toContain("src/portfolio-engine/copySignal.ts");
    expect(PORTFOLIO_CODE_FILES).toContain("scripts/lib/signalData.ts");
    expect([...PORTFOLIO_CODE_FILES].sort()).toEqual(PORTFOLIO_CODE_FILES);
  });
});

// keep bun:sqlite import used for a sanity check of the shared table
test("signals.db keeps the shared format after the fixtures wrote it", () => {
  const db = new Database(signalsDb, { readonly: true });
  const cols = (db.query("PRAGMA table_info(signal_events)").all() as Array<{ name: string; type: string }>).map(c => `${c.name}:${c.type}`);
  db.close();
  expect(cols).toEqual(["source:TEXT", "symbol:TEXT", "known_at_ms:INTEGER", "weight:REAL", "meta_json:TEXT"]);
});
