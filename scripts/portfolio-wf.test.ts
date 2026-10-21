/**
 * End-to-end: a tiny SYNTHETIC portfolio manifest through the unmodified
 * nested walk-forward (runWalkForward) with the portfolio runner, then the
 * §2.5 criteria evaluator on the resulting summary. Owner rule (RW §6): no
 * real data here — every tape is seeded GBM from scripts/lib/portfolioSynthetic.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWalkForward, type ExperimentManifest, type ReplayRunner } from "./walk-forward";
import { coreKernel, makePortfolioRunner, type PortfolioChainState, type PortfolioReplayResult } from "./portfolio-replay";
import { CRITERIA, evaluatePortfolioCriteria, chainDailyReturns, loadCriteriaSummary } from "./portfolio-criteria";
import { PORTFOLIO_CODE_FILES, assertPortfolioManifest, parseCompare } from "./portfolio-wf";
import type { PortfolioStrategyConfig, VenueRules } from "../src/portfolio-engine/types";
import { writeDailyFixture } from "./lib/portfolioSynthetic";
import { loadArtifactOuterDailyReturns, shiftDailyReturnDate } from "./lib/combinedPortfolioReturns";

const tmp = mkdtempSync(join(tmpdir(), "rw-wf-"));
const outputDirs: string[] = [];
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const d of outputDirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── fixtures ───────────────────────────────────────────────────────────────
const stocksDb = join(tmp, "stocks.db");
writeDailyFixture(stocksDb, {
  source: "alpaca_wide", from: "2020-01-02", sessions: 700,
  series: [
    { symbol: "SPY", seed: 1, startPrice: 300, driftAnnual: 0.15, volAnnual: 0.18 },
    { symbol: "IEF", seed: 2, startPrice: 100, driftAnnual: 0.02, volAnnual: 0.06 },
    { symbol: "GLD", seed: 3, startPrice: 150, driftAnnual: 0.10, volAnnual: 0.15 },
  ],
});
const cryptoDb = join(tmp, "crypto.db");
writeDailyFixture(cryptoDb, {
  source: "binance_futures", from: "2020-10-01", sessions: 900, fundingRate: 0.0001,
  series: [
    { symbol: "BTC/USD", seed: 11, startPrice: 30_000, driftAnnual: 0.4, volAnnual: 0.6 },
    { symbol: "ETH/USD", seed: 12, startPrice: 1_000, driftAnnual: 0.5, volAnnual: 0.8 },
    { symbol: "SOL/USD", seed: 13, startPrice: 20, driftAnnual: 0.6, volAnnual: 1.0 },
  ],
});
const members = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"];
const membershipDb = join(tmp, "sp.db");
writeDailyFixture(membershipDb, {
  source: "alpaca_wide", from: "2020-01-02", sessions: 700,
  series: [
    { symbol: "SPY", seed: 1, startPrice: 300, driftAnnual: 0.15, volAnnual: 0.18 },
    ...members.map((s, i) => ({ symbol: s, seed: 100 + i, startPrice: 50 + 10 * i, driftAnnual: 0.05 + 0.03 * i, volAnnual: 0.2 + 0.05 * i })),
  ],
  membership: [
    ...members.slice(0, 7).map(t => ({ index: "synth", ticker: t, start: "2010-01-01", end: null })),
    { index: "synth", ticker: "HHH", start: "2010-01-01", end: "2022-01-15" }, // leaves mid-window
    { index: "synth", ticker: "SPY", start: "2010-01-01", end: null },        // excluded by the strategy
  ],
});

const alpaca: VenueRules = { venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0 };
const trend = (over: Partial<Extract<PortfolioStrategyConfig, { kind: "xassetTrend" }>>): PortfolioStrategyConfig => ({
  kind: "xassetTrend", universe: ["SPY", "IEF", "GLD"], inceptionGuardBars: 252, volLookback: 63, covLookback: 63,
  portfolioVolTarget: 0.12, perAssetCap: 1, maxGross: 1.8, blendHorizons: [63, 126, 252], maLong: 200, signalBandPct: 0, ...over,
});

function d1Manifest(): ExperimentManifest {
  return {
    name: "rw-synthetic-d1", sleeve: "stocks", trialAccounting: { priorUniqueTrials: 0, complete: true },
    data: { dbPath: stocksDb, source: "alpaca_wide", timeframe: "1d", universe: ["SPY", "IEF", "GLD"], refSymbol: "SPY", rthOnly: false, funding: false, barMinutes: 1440, barMinutesEq: 1440, assetClasses: { SPY: "equity", IEF: "bond", GLD: "commodity" } },
    asOf: "2022-09-01T00:00:00Z",
    window: { from: "2021-03-01", to: "2022-09-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.02, warmupDays: 420 },
    costs: { base: { slippageBps: 2, commissionBps: 0, marginInterest: { annualRate: 0.065 } }, stress: { slippageBps: 5, commissionBps: 0, marginInterest: { annualRate: 0.08 } } },
    ledger: { initialEquity: 50_000 } as ExperimentManifest["ledger"],
    candidates: [
      { name: "vt12-band0", cadenceMin: 1440, portfolio: { strategy: trend({ portfolioVolTarget: 0.12 }), venue: alpaca } },
      { name: "vt15-band1", cadenceMin: 1440, portfolio: { strategy: trend({ portfolioVolTarget: 0.15, signalBandPct: 1 }), venue: alpaca } },
    ],
    acceptance: { minSharpe: -10, maxDrawdown: 1, minTotalReturn: -1, maxConcentration: 1, minTrades: 0 },
  };
}

function d3Manifest(): ExperimentManifest {
  const base: PortfolioStrategyConfig = {
    kind: "cryptoTrend", universe: ["BTC/USD", "ETH/USD", "SOL/USD"], inceptionGuardBars: 252, volLookback: 30, covLookback: 30,
    portfolioVolTarget: 0.35, perAssetCap: 0.6, maxGross: 2.0, blendHorizons: [63, 126, 252], maLong: 200, signalBandPct: 0, stop: { mode: "fixed", pct: 4 },
  };
  const venue: VenueRules = { venue: "binance_usdm", fractional: false, minOrderNotional: 5, rebalanceBand: 0.02, qtyStep: { "BTC/USD": 0.001, "ETH/USD": 0.001, "SOL/USD": 1 } };
  return {
    name: "rw-synthetic-d3", sleeve: "crypto", trialAccounting: { priorUniqueTrials: 0, complete: true },
    data: { dbPath: cryptoDb, source: "binance_futures", timeframe: "1d", universe: ["BTC/USD", "ETH/USD", "SOL/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 1440, barMinutesEq: 1440 },
    asOf: "2023-03-01T00:00:00Z",
    window: { from: "2021-09-01", to: "2023-03-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.02, warmupDays: 300 },
    costs: { base: { slippageBps: 5, commissionBps: 4 }, stress: { slippageBps: 10, commissionBps: 8 } },
    ledger: { initialEquity: 5_000 } as ExperimentManifest["ledger"],
    candidates: [
      { name: "vt35-stop4", cadenceMin: 1440, portfolio: { strategy: base, venue } },
      { name: "vt35-nostop", cadenceMin: 1440, portfolio: { strategy: { ...base, stop: { mode: "none" } }, venue } },
    ],
    acceptance: { minSharpe: -10, maxDrawdown: 1, minTotalReturn: -1, maxConcentration: 1, minTrades: 0 },
  };
}

function d2Manifest(): ExperimentManifest {
  const core: PortfolioStrategyConfig = {
    kind: "factorCore", exclude: ["SPY"], topN: 3, score: "momentum+lowvol", momentumWindow: [120, 21], volWindow: 120, weightVolLookback: 63,
    perNameCap: 0.5, minPrice: 1, minPriorCloses: 120, overlay: { ref: "SPY", ma: 100, bandPct: 1, onExposure: 1, offExposure: 0.5 },
  };
  return {
    name: "rw-synthetic-d2", sleeve: "stocks", trialAccounting: { priorUniqueTrials: 0, complete: true },
    data: { dbPath: membershipDb, source: "alpaca_wide", timeframe: "1d", universe: ["SPY"], refSymbol: "SPY", rthOnly: false, funding: false, barMinutes: 1440, barMinutesEq: 1440, membership: { index: "synth", exclude: ["SPY"] } },
    asOf: "2022-09-01T00:00:00Z",
    window: { from: "2021-03-01", to: "2022-09-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.02, warmupDays: 300 },
    costs: { base: { slippageBps: 2, commissionBps: 0 }, stress: { slippageBps: 5, commissionBps: 0 } },
    ledger: { initialEquity: 50_000 } as ExperimentManifest["ledger"],
    candidates: [
      { name: "momlowvol3-overlay", cadenceMin: 1440, portfolio: { strategy: core, venue: alpaca } },
      { name: "momlowvol3-plain", cadenceMin: 1440, portfolio: { strategy: { ...core, overlay: null }, venue: alpaca } },
    ],
    acceptance: { minSharpe: -10, maxDrawdown: 1, minTotalReturn: -1, maxConcentration: 1, minTrades: 0 },
  };
}

function spyRunner(inner: ReplayRunner, calls: Array<{ label: string; carried: boolean; slippage: number }>): ReplayRunner {
  return async (cfg, win, state) => {
    calls.push({ label: win.label, carried: (state as PortfolioChainState | undefined)?.portfolioMemory !== undefined, slippage: cfg.slippageBps });
    return inner(cfg, win, state);
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("RW portfolio protocol — end to end on synthetic tapes", () => {
  test("RW2 E1/E2/E3: volManaged windows, ex-top-decile, break-even and standalone CLI vs shifted legacy control", async () => {
    for (const design of ["E1", "E2", "E3"] as const) {
      const m = design === "E3" ? d3Manifest() : d1Manifest();
      m.name = `rw2-${design.toLowerCase()}-synthetic`;
      m.candidates = m.candidates.map((c, i) => ({ ...c, name: `vol-${i}`, portfolio: { venue: c.portfolio!.venue,
        strategy: { kind: "volManaged", universe: m.data.universe, inceptionGuardBars: 252, volLookback: design === "E3" ? 30 : 63,
          covLookback: 21, portfolioVolTarget: 0.12 + i * 0.03, annualization: design === "E3" ? 365 : 252, perAssetCap: 0.5, maxGross: 1 } } }));
      const { summary, outputDir } = await runWalkForward(m, { runner: makePortfolioRunner(coreKernel), codeFiles: PORTFOLIO_CODE_FILES, breakEven: true });
      outputDirs.push(outputDir);
      expect(summary.complete).toBe(true);
      expect(summary.skippedFolds).toEqual([]);
      expect(summary.breakEvenCurve).toHaveLength(6);
      for (const t of summary.outerTests) {
        expect((t.result as PortfolioReplayResult).portfolioDiagnostics.stopOrders).toBe(0);
        expect((t.result as PortfolioReplayResult).portfolioDiagnostics.orders).toBeGreaterThan(0);
        if (design === "E3") expect(t.result.funding).not.toBe(0);
      }
      const mine = chainDailyReturns(summary);
      // A synthetic legacy-style control uses one-day-late momentum labels,
      // except meanrev (E2), which already labels the execution session.
      const controlDir = join(tmp, `${design}-control`);
      mkdirSync(controlDir);
      const config = { timeframe: "1d", ...(design === "E2" ? { meanrev: {} } : {}) };
      const points = [...mine].map(([date, ret]) => ({ date: shiftDailyReturnDate(date, design === "E2" ? 0 : 1), ret }));
      writeFileSync(join(controlDir, "summary.json"), JSON.stringify({ outerTests: [{ foldPath: "0/test" }], outerSelection: [{ foldPath: "0/test", candidateHash: "control" }] }));
      writeFileSync(join(controlDir, "runs.jsonl"), [
        { foldPath: "0/test", costTier: "base", status: "complete", candidateHash: "control", result: { config, dailyReturns: points } },
        // Last-record LOO/cost decoy must NOT replace the selected control.
        { foldPath: "0/test", costTier: "base", status: "complete", candidateHash: "decoy", result: { config, dailyReturns: [{ date: "1999-01-01", ret: 100 }] } },
      ].map(r => JSON.stringify(r)).join("\n"));
      expect(loadArtifactOuterDailyReturns(controlDir)).toEqual([...mine].map(([date, ret]) => ({ date, ret })));
      await expect(evaluatePortfolioCriteria(m, summary, outputDir, "synthetic", { quiet: true })).rejects.toThrow(/--control/);
      const report = await evaluatePortfolioCriteria(m, summary, outputDir, "synthetic", { quiet: true, controlArtifact: controlDir, authoritativeArtifact: controlDir });
      expect(report.design).toBe(design);
      expect(report.criteria.R3).toMatchObject({ value: 0, pass: true, threshold: 0 });
      expect(report.reported.commonDays).toBe(mine.size);
      expect(report.reported.authoritative).toMatchObject({ differsByMoreThan005: false });
      expect(report.criteria.R6.detail?.excluded).toHaveLength(1);
      expect(typeof report.criteria.R6.value).toBe("number");
      expect(report.criteria.R7.detail?.curve).toHaveLength(6);
      expect(report.criteria.R7.threshold).toBe(design === "E3" ? 10 : 4);
      expect(existsSync(join(outputDir, "rw2-criteria.json"))).toBe(true);
      expect(existsSync(join(outputDir, "rw-criteria.json"))).toBe(false);
      const restored = loadCriteriaSummary(outputDir);
      expect(chainDailyReturns(restored)).toEqual(mine);
      const rerun = await evaluatePortfolioCriteria(m, restored, outputDir, "synthetic", { quiet: true, controlArtifact: controlDir, authoritativeArtifact: controlDir });
      expect(rerun.criteria).toEqual(report.criteria);
      const cli = Bun.spawnSync([process.execPath, "scripts/portfolio-criteria.ts", outputDir, "--control", controlDir, "--authoritative", controlDir], { cwd: join(import.meta.dir, "..") });
      expect(cli.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(outputDir, "rw2-criteria.json"), "utf8"));
      expect(written.criteria).toEqual(JSON.parse(JSON.stringify(report.criteria)));
      expect(written.reported.commonDays).toBe(mine.size);
      if (design === "E1") {
        const manifestPath = join(tmp, "rw2-e1-synthetic.json");
        writeFileSync(manifestPath, JSON.stringify(m));
        const driver = Bun.spawnSync([process.execPath, "scripts/portfolio-wf.ts", manifestPath, "--control", controlDir, "--authoritative", controlDir], { cwd: join(import.meta.dir, "..") });
        expect(driver.exitCode).toBe(0);
        expect(driver.stdout.toString()).toContain("RW2 §8.5 criteria (E1)");
        const driven = JSON.parse(readFileSync(join(outputDir, "rw2-criteria.json"), "utf8"));
        expect(driven.criteria).toEqual(written.criteria);
        // A compact summary alone is not sufficient evidence for standalone.
        const brokenDir = join(tmp, "broken-artifact");
        mkdirSync(brokenDir);
        writeFileSync(join(brokenDir, "summary.json"), readFileSync(join(outputDir, "summary.json")));
        writeFileSync(join(brokenDir, "runs.jsonl"), "");
        expect(() => loadCriteriaSummary(brokenDir)).toThrow(/missing full base trial/);
      }
    }
  }, 120_000);

  test("D1: nested walk-forward + criteria; session labels, chained memory, break-even curve, rw-criteria.json", async () => {
    const m = d1Manifest();
    assertPortfolioManifest(m);
    const calls: Array<{ label: string; carried: boolean; slippage: number }> = [];
    const runner = spyRunner(makePortfolioRunner(coreKernel, { assetClasses: m.data.assetClasses }), calls);
    const { summary, outputDir } = await runWalkForward(m, { runner, codeFiles: PORTFOLIO_CODE_FILES, breakEven: true });
    outputDirs.push(outputDir);

    expect(summary.complete).toBe(true);
    expect(summary.skippedFolds).toEqual([]);
    expect(summary.outerTests.map(t => t.foldPath)).toEqual(["0/test", "1/test"]);
    expect(summary.outerSelection?.length).toBe(2);
    expect(summary.loo.map(l => l.excludedSymbol).sort()).toEqual(["GLD", "IEF", "SPY"]);
    expect(summary.breakEvenCurve?.length).toBe(6);
    expect(summary.observations).toBeGreaterThan(200);
    expect(summary.stitchedOos.marginInterest).toBeGreaterThan(0);
    expect(summary.stitchedOos.benchSharpe).toBeDefined();

    // Session labels inside each fold's window, weekdays, no duplicates across the chain.
    const labels: string[] = [];
    for (const t of summary.outerTests) {
      for (const d of t.result.dailyReturns) {
        expect(Date.parse(d.date) >= t.result.fromMs && Date.parse(d.date) < t.result.toMs).toBe(true);
        labels.push(d.date);
      }
    }
    expect(new Set(labels).size).toBe(labels.length);
    // The protocol's stitched daily series: one observation per session minus
    // the very first (its bucket merges with the chain's seed point at fromMs —
    // the legacy runners' convention), and no spurious boundary days.
    expect(summary.observations).toBe(labels.length - 1);

    // Chain continuity: inner trials start fresh; fold 1's base and stress tests receive fold 0's memory.
    expect(calls.filter(c => /^\d+\/\d+$/.test(c.label)).every(c => !c.carried)).toBe(true);
    const outer1 = calls.filter(c => c.label === "1/test");
    expect(outer1.length).toBeGreaterThanOrEqual(2);
    expect(outer1.every(c => c.carried)).toBe(true);
    expect(calls.filter(c => c.label === "0/test").every(c => !c.carried)).toBe(true);
    // The runs.jsonl ledger persists the carried memory on the outer trials.
    const runs = readFileSync(join(outputDir, "runs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const base0 = runs.find(r => r.foldPath === "0/test" && r.costTier === "base");
    expect(base0.result.finalRiskState.portfolioMemory.portfolioCore.version).toBe(1);
    expect(existsSync(join(outputDir, "summary.json"))).toBe(true);
    const diag = (summary.outerTests[0].result as PortfolioReplayResult).portfolioDiagnostics;
    expect(diag.sessions).toBe(summary.outerTests[0].result.dailyReturns.length);
    expect(Object.keys(diag.pnlByAssetClass).every(k => ["equity", "bond", "commodity"].includes(k))).toBe(true);

    // Criteria on the same windows.
    const report = await evaluatePortfolioCriteria(m, summary, outputDir, "synthetic-d1", { kernel: coreKernel, quiet: true });
    expect(report.design).toBe("D1");
    expect(report.thresholds).toEqual(CRITERIA.D1);
    expect(Object.keys(report.criteria)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C6b", "C7", "C8"]);
    for (const k of ["C1", "C2", "C3", "C4", "C5", "C6", "C7"]) expect(typeof report.criteria[k].pass).toBe("boolean");
    expect(report.criteria.C4.detail?.observations).toBe(labels.length);     // passive on the same sessions
    expect(report.criteria.C5.detail?.benchmark).toBe("sixtyForty");
    expect(report.criteria.C5.detail?.observations).toBe(labels.length);     // 60/40 on the same sessions
    expect(report.criteria.C6b.detail?.excluded).toHaveLength(1);           // ceil(10 % of 3)
    expect(typeof report.criteria.C6b.value).toBe("number");
    expect(report.criteria.C7.detail?.baseSlippageBps).toBe(2);
    expect(report.criteria.C8.pass).toBeNull();
    expect(report.reported.ordersPerSession).toBeGreaterThan(0);
    expect(report.reported.adjustmentOrdersPerSession).toBeGreaterThan(0);
    expect(existsSync(join(outputDir, "rw-criteria.json"))).toBe(true);
    const written = JSON.parse(readFileSync(join(outputDir, "rw-criteria.json"), "utf8"));
    expect(written.manifestHash).toBe(summary.manifestHash);
    expect(written.criteria.C1.threshold).toBe(0.95);
  }, 120_000);

  test("D3: funding + stops through the protocol; LOO feeds C6b (worst leave-one-out vs 0.6 × Sharpe); BTC benchmark on the same days", async () => {
    const m = d3Manifest();
    const { summary, outputDir } = await runWalkForward(m, { runner: makePortfolioRunner(coreKernel), codeFiles: PORTFOLIO_CODE_FILES, breakEven: false });
    outputDirs.push(outputDir);
    expect(summary.complete).toBe(true);
    expect(summary.skippedFolds).toEqual([]);
    expect(summary.stitchedOos.funding).not.toBe(0);
    expect(summary.loo.length).toBe(3);
    for (const t of summary.outerTests) {
      const first = t.result.dailyReturns[0].date, last = t.result.dailyReturns[t.result.dailyReturns.length - 1].date;
      expect(first).toBe(new Date(t.result.fromMs).toISOString().slice(0, 10));
      expect(last).toBe(new Date(t.result.toMs - 86_400_000).toISOString().slice(0, 10));
      expect(t.result.dailyReturns.length).toBe(Math.round((t.result.toMs - t.result.fromMs) / 86_400_000)); // every UTC day
    }
    const report = await evaluatePortfolioCriteria(m, summary, outputDir, "synthetic-d3", { kernel: coreKernel, quiet: true });
    expect(report.design).toBe("D3");
    expect(report.criteria.C6b.id).toBe("C6b_worstLoo");
    expect(report.criteria.C6b.threshold).toBeCloseTo(0.6 * summary.stitchedOos.sharpe, 12);
    expect(report.criteria.C5.detail?.benchmark).toBe("btc");
    expect(report.criteria.C7.pass).toBe(false);                 // --no-breakeven ⇒ fails closed
    expect(report.criteria.C7.reason).toMatch(/not computed/);
    expect(report.criteria.C3.threshold).toBe(0.6);
    expect(report.criteria.C2.threshold).toBe(0.35);
  }, 120_000);

  test("D2: point-in-time membership through the protocol; equal-weight passive and ex-top-decile via strategy.exclude", async () => {
    const m = d2Manifest();
    const { summary, outputDir } = await runWalkForward(m, { runner: makePortfolioRunner(coreKernel), codeFiles: PORTFOLIO_CODE_FILES, breakEven: false });
    outputDirs.push(outputDir);
    expect(summary.complete).toBe(true);
    expect(summary.skippedFolds).toEqual([]);
    expect(summary.loo).toEqual([]); // the declared universe is the benchmark only — nothing to leave out
    const traded = new Set(summary.outerTests.flatMap(t => Object.keys(t.result.tradesBySymbol)));
    expect(traded.has("SPY")).toBe(false);
    expect([...traded].every(s => members.includes(s))).toBe(true);
    expect(traded.size).toBeGreaterThan(3); // monthly reconstitution rotates the core
    const report = await evaluatePortfolioCriteria(m, summary, outputDir, "synthetic-d2", { kernel: coreKernel, quiet: true });
    expect(report.design).toBe("D2");
    expect(report.criteria.C5.detail?.benchmark).toBe("spy");
    expect(report.criteria.C5.threshold).toBe(0.05);
    expect(typeof report.criteria.C4.value).toBe("number");
    expect(report.criteria.C6b.detail?.excluded).toHaveLength(1);
    expect(typeof report.criteria.C6b.value).toBe("number");
  }, 120_000);

  test("the stock protocol runner refuses portfolio candidates (fail closed, never the momentum sim)", async () => {
    await expect(runWalkForward(d1Manifest(), { codeFiles: PORTFOLIO_CODE_FILES })).rejects.toThrow(/portfolio candidates run through scripts\/portfolio-wf.ts/);
  });

  test("driver helpers", () => {
    expect(parseCompare(["x.json", "--compare", "D2=data/backtests/abc", "--compare", "live=/tmp/l"])).toEqual({ D2: "data/backtests/abc", live: "/tmp/l" });
    expect(() => parseCompare(["--compare", "nolabel"])).toThrow(/label/);
    const m = d1Manifest();
    delete (m.candidates[1] as { portfolio?: unknown }).portfolio;
    expect(() => assertPortfolioManifest(m)).toThrow(/portfolio manifests only/);
    expect(PORTFOLIO_CODE_FILES).toContain("scripts/portfolio-replay.ts");
    expect(PORTFOLIO_CODE_FILES).toContain("src/portfolio-engine/decide.ts");
    expect([...PORTFOLIO_CODE_FILES].sort()).toEqual(PORTFOLIO_CODE_FILES);
  });
});
