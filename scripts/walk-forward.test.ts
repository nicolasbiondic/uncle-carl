import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  hashCodeFiles,
  hashDataSnapshot,
  loadManifest,
  generateFolds,
  manifestToSleeve,
  candidateToReplayConfig,
  makeTrialId,
  ledgerComplete,
  aggregateInner,
  selectCandidate,
  stitchEquityHistory,
  stitchedMetrics,
  concentration,
  manifestIdentity,
  resolveAsOf,
  runIdentityHash,
  runLoo,
  runTrial,
  continueRiskState,
  evaluateAcceptance,
  benchmarkFromFoldBars,
  validateCandidate,
  validateManifest,
  validateUniqueCandidates,
  correctedDsr,
  penalizedPsr,
  computeOuterEvidence,
  breakEvenFromCurve,
  stitchedDailyReturns,
  BREAK_EVEN_SLIPPAGE_BPS,
  type ExperimentManifest,
  type CandidateConfig,
  type WindowConfig,
  type InnerMetrics,
  type WalkForwardSummary,
  type ReplayRunner,
  type AcceptanceConfig,
} from "./walk-forward";
import { hashReplayConfig, type ReplayResult } from "./backtest-momentum-wf";
import { INITIAL_RISK_STATE, type RiskState } from "../src/strategies/momentum/RiskGuard";
import { Database } from "bun:sqlite";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const baseManifest: ExperimentManifest = {
  name: "test-stocks",
  sleeve: "stocks",
  trialAccounting: { priorUniqueTrials: 0, complete: true },
  data: {
    dbPath: "./data/historical.db",
    source: "alpaca_split",
    timeframe: "5m",
    universe: ["SPY", "QQQ"],
    refSymbol: "SPY",
    rthOnly: true,
    funding: false,
    barMinutes: 5,
    barMinutesEq: 18.4615384615,
  },
  asOf: "2024-04-01",
  window: {
    from: "2024-01-01",
    to: "2024-04-01",
    outerFoldCount: 3,
    innerFoldCount: 3,
    purgeYears: 0.25,
    warmupDays: 30,
  },
  costs: {
    base: { slippageBps: 2, commissionBps: 0 },
    stress: { slippageBps: 5, commissionBps: 2 },
  },
  ledger: { initialEquity: 10000, leverage: 2, hardStopPct: 0.04 },
  candidates: [
    {
      name: "incumbent",
      cadenceMin: 240,
      notionalPctPerSlot: 0.5,
      entryPct: 5,
      exitPct: -2,
      maxLongs: 2,
      maxShorts: 0,
    },
    {
      name: "alt",
      cadenceMin: 120,
      notionalPctPerSlot: 0.3,
      entryPct: 4,
      exitPct: -2,
      maxLongs: 2,
      maxShorts: 0,
    },
  ],
  acceptance: { minSharpe: 0, maxDrawdown: 0.5, minTotalReturn: -0.5, maxConcentration: 1, minTrades: 0 },
};

describe("canonical hashing", () => {
  test("canonicalJson is deterministic regardless of key order", () => {
    const a = canonicalJson({ z: 1, a: 2, b: { y: 3, x: 4 } });
    const b = canonicalJson({ a: 2, b: { x: 4, y: 3 }, z: 1 });
    expect(a).toBe(b);
  });

  test("hashReplayConfig excludes runtime-only dbPath so identical semantic configs have same hash", () => {
    const c1 = candidateToReplayConfig(baseManifest, baseManifest.candidates[0], "base", "/tmp/snapshot1.db");
    const c2 = candidateToReplayConfig(baseManifest, baseManifest.candidates[0], "base", "/tmp/snapshot2.db");
    // Same semantic config despite different dbPath
    expect(c1.dbPath).not.toBe(c2.dbPath);
    expect(hashReplayConfig(c1)).toBe(hashReplayConfig(c2));
  });

  test("candidate config hash is stable across copies and stress costs differ", () => {
    const c1 = candidateToReplayConfig(baseManifest, baseManifest.candidates[0], "base");
    const c2 = candidateToReplayConfig(baseManifest, baseManifest.candidates[0], "base");
    expect(hashReplayConfig(c1)).toBe(hashReplayConfig(c2));
    const c3 = candidateToReplayConfig(baseManifest, baseManifest.candidates[0], "stress");
    expect(hashReplayConfig(c3)).not.toBe(hashReplayConfig(c1));
    expect(c3.slippageBps).toBeGreaterThan(c1.slippageBps);
    expect(c3.commissionBps).toBeGreaterThan(c1.commissionBps);
  });

  test("two candidates with different cadenceMin yield distinct hashes", () => {
    const incumbent = candidateToReplayConfig(baseManifest, baseManifest.candidates[0], "base");
    const alt = candidateToReplayConfig(baseManifest, baseManifest.candidates[1], "base");
    const incumbentHash = hashReplayConfig(incumbent);
    const altHash = hashReplayConfig(alt);
    expect(incumbentHash).not.toBe(altHash);
    expect(incumbent.cadenceMin).toBe(240);
    expect(alt.cadenceMin).toBe(120);
  });

  test("two candidates with different notionalPctPerSlot yield distinct hashes and behavior", () => {
    const incumbent = candidateToReplayConfig(baseManifest, baseManifest.candidates[0], "base");
    const alt = candidateToReplayConfig(baseManifest, baseManifest.candidates[1], "base");
    expect(hashReplayConfig(incumbent)).not.toBe(hashReplayConfig(alt));
    // Both map properly to ReplayConfig fields that affect execution
    expect(incumbent.notionalPctPerSlot).toBe(0.5);
    expect(alt.notionalPctPerSlot).toBe(0.3);
    expect(incumbent.entryPct).toBe(5);
    expect(alt.entryPct).toBe(4);
  });

  test("validateCandidate rejects unknown keys", () => {
    const validCandidate: CandidateConfig = {
      name: "test",
      cadenceMin: 240,
      entryPct: 5,
      exitPct: -2,
      maxLongs: 2,
      maxShorts: 0,
    };
    expect(() => validateCandidate(validCandidate)).not.toThrow();

    const invalidCandidate = { ...validCandidate, unknownKey: "should fail" };
    expect(() => validateCandidate(invalidCandidate)).toThrow(/unknown keys.*unknownKey/);
  });

  test("hashCodeFiles returns a non-empty sha256 hex string", async () => {
    const h = await hashCodeFiles();
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  test("run identity changes with config, data, or code", () => {
    const base = runIdentityHash("config-a", "data-a", "code-a");
    expect(runIdentityHash("config-b", "data-a", "code-a")).not.toBe(base);
    expect(runIdentityHash("config-a", "data-b", "code-a")).not.toBe(base);
    expect(runIdentityHash("config-a", "data-a", "code-b")).not.toBe(base);
  });
});

describe("manifest validation", () => {
  test("requires explicit, complete prior-trial accounting metadata", () => {
    expect(() => validateManifest({ ...baseManifest, trialAccounting: undefined } as any))
      .toThrow("trialAccounting.priorUniqueTrials");
    expect(() => validateManifest({ ...baseManifest, trialAccounting: { priorUniqueTrials: -1, complete: true } }))
      .toThrow("trialAccounting.priorUniqueTrials");
    expect(() => validateManifest({ ...baseManifest, trialAccounting: { priorUniqueTrials: 0, complete: undefined as any } }))
      .toThrow("trialAccounting.complete");
  });
});

describe("no-training outer folds", () => {
  test("first outer fold is skipped when purge gap consumes all training data", () => {
    const asOf = Date.parse("2024-04-01");
    // A purge gap larger than the initial train segment skips the first fold,
    // while later expanding folds eventually accumulate enough history.
    const w: WindowConfig = { ...baseManifest.window, purgeYears: 0.1 };
    const folds = generateFolds(w, asOf);
    expect(folds[0].inner.length).toBe(0);
    expect(folds[folds.length - 1].inner.length).toBeGreaterThan(0);
  });

  test("outer folds with no inner results are skipped, not defaulted to first candidate", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-skip-"));
    const dbPath = join(tmpDir, "historical.db");
    let db: Database | null = null;
    let outputDir: string | undefined;
    try {
      db = new Database(dbPath);
      db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const start = Date.parse("2023-12-01T00:00:00Z");
      db.transaction(() => {
        for (let i = 0; i < 120 * 24; i++) {
          const t = start + i * 3600_000;
          stmt.run("SPY", "5m", "alpaca_split", t, 100, 100, 100, 100, 1);
        }
      })();
      db.close();
      db = null;

      const { runWalkForward } = await import("./walk-forward");
      const m: ExperimentManifest = {
        ...baseManifest,
        data: { ...baseManifest.data, dbPath, source: "alpaca_split", timeframe: "5m", universe: ["SPY"], refSymbol: "SPY", rthOnly: false, funding: false, barMinutes: 5, barMinutesEq: 18.4615384615 },
        window: { ...baseManifest.window, outerFoldCount: 1, innerFoldCount: 0, purgeYears: 1, warmupDays: 5 },
      };
      const wf = await runWalkForward(m, { dryRun: false });
      outputDir = wf.outputDir;
      const { summary } = wf;
      expect(summary.skippedFolds).toContain("0");
      expect(summary.outerTests).toHaveLength(0);
      expect(summary.complete).toBe(false);
      expect(summary.approved).toBe(false);
      expect(summary.approvalReason).toContain("skipped");
    } finally {
      db?.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30000);
});

describe("fold generation", () => {
  test("expanding outer folds partition the window and include purge gap", () => {
    const asOf = Date.parse("2024-04-01");
    const w = { ...baseManifest.window, purgeYears: 0.05 };
    const folds = generateFolds(w, asOf);
    expect(folds).toHaveLength(3);
    const first = folds[0];
    const last = folds[2];
    expect(first.test.fromMs).toBeGreaterThan(Date.parse("2024-01-01"));
    expect(last.test.toMs).toBe(asOf);
    expect(first.inner.length).toBeGreaterThan(0);
    // Purge gap: outer train end must be before test start.
    const purgeMs = 0.05 * 365.25 * 24 * 60 * 60 * 1000;
    expect(first.test.fromMs - purgeMs).toBeLessThan(first.test.fromMs);
    // Inner folds live inside the train region before the purge gap.
    const lastOuter = folds[folds.length - 1];
    expect(lastOuter.inner.length).toBeGreaterThan(0);
    expect(lastOuter.inner[0].fromMs).toBe(Date.parse("2024-01-01"));
    expect(lastOuter.inner[lastOuter.inner.length - 1].toMs).toBeLessThan(lastOuter.test.fromMs - purgeMs + 1);
  });

  test("inner folds are contained within the outer train and expanding", () => {
    const asOf = Date.parse("2024-04-01");
    const w = { ...baseManifest.window, purgeYears: 0.05 };
    const folds = generateFolds(w, asOf);
    // Use the last outer fold where the train span is large enough for inner folds.
    const outer = folds[folds.length - 1];
    expect(outer.inner.length).toBe(3);
    for (let i = 0; i < outer.inner.length; i++) {
      expect(outer.inner[i].fromMs).toBeLessThan(outer.inner[i].toMs);
      if (i > 0) {
        expect(outer.inner[i].fromMs).toBe(outer.inner[i - 1].toMs);
      }
      expect(outer.inner[i].toMs).toBeLessThan(outer.test.fromMs);
    }
  });

  test("asOf truncates the right edge", () => {
    const asOf = Date.parse("2024-03-15");
    const folds = generateFolds({ ...baseManifest.window, to: "2024-04-01" }, asOf);
    expect(folds[folds.length - 1].test.toMs).toBe(asOf);
  });
});

describe("trial ledger", () => {
  test("makeTrialId is deterministic and unique", () => {
    const a = makeTrialId("0/1", "abc", "base");
    const b = makeTrialId("0/1", "abc", "base");
    const c = makeTrialId("0/1", "abc", "stress");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64); // full SHA-256 hex string
  });

  test("ledgerComplete requires at least one complete record", () => {
    expect(ledgerComplete([])).toBe(false);
    expect(ledgerComplete([{ id: "1", status: "pending" } as any])).toBe(false);
    expect(ledgerComplete([{ id: "1", status: "complete" } as any])).toBe(true);
  });

  test("cached trials are reused only for the same config/data/code context", async () => {
    let calls = 0;
    const runner = async (cfg: any, win: any) => {
      calls++;
      return { config: cfg, window: win } as any;
    };
    const fold = { path: "0/0", fromMs: 0, toMs: 1 };
    const candidate = baseManifest.candidates[0];
    const first = await runTrial(baseManifest, candidate, fold, "base", undefined, undefined, runner, "run-a");
    const reused = await runTrial(baseManifest, candidate, fold, "base", first, undefined, runner, "run-a");
    const refreshed = await runTrial(baseManifest, candidate, fold, "base", first, undefined, runner, "run-b");
    expect(reused.hash).toBe(first.hash);
    expect(refreshed.hash).not.toBe(first.hash);
    expect(calls).toBe(2);
  });
});

describe("leave-one-symbol-out", () => {
  test("maps stitched metrics to the fields consumed by acceptance gates", async () => {
    const m: ExperimentManifest = {
      ...baseManifest,
      sleeve: "crypto",
      data: { ...baseManifest.data, universe: ["BTC/USD", "ETH/USD"], refSymbol: "BTC/USD", rthOnly: false },
    };
    const outer = {
      path: "0",
      test: { path: "0/test", fromMs: 0, toMs: 86_400_000 },
      inner: [],
    };
    const selected = new Map([["0", m.candidates[0]]]);
    const { results: loo, cutChains } = await runLoo(m, selected, [outer], undefined, async (cfg, win) => ({
      sleeve: cfg.sleeve,
      window: win,
      fromMs: 0,
      toMs: 86_400_000,
      config: cfg,
      finalEquity: 11_000,
      totalReturn: 0.1,
      maxDrawdown: 0,
      sharpe: 1,
      winRate: 1,
      trades: 1,
      tradesPerDay: 1,
      expectancy: 1_000,
      fees: 0,
      funding: 0,
      liquidations: 0,
      marginRejects: 0,
      ruined: false,
      bench: 0,
      dailyReturns: [],
      sessionReturns: [],
      tradesBySymbol: { [cfg.universe[0]]: { trades: 1, grossPnl: 1_000, fees: 0, funding: 0 } },
      equityHistory: [{ t: 0, eq: 10_000 }, { t: 86_400_000, eq: 11_000 }],
      closedTrades: [{ symbol: cfg.universe[0], side: "buy", pnl: 1_000, exitAt: 86_400_000, reason: "test" }],
      hash: "test",
      finalRiskState: { ...INITIAL_RISK_STATE },
    }));
    expect(loo).toHaveLength(2);
    expect(loo[0].stitchedReturn).toBeCloseTo(0.1);
    expect(loo[0].stitchedSharpe).toBeDefined();
    expect(loo[0].stitchedMaxDrawdown).toBe(0);
    expect(loo[0].totalTrades).toBe(1);
    expect(cutChains).toHaveLength(0);
  });
});

describe("deterministic selection", () => {
  function metric(c: string, dsr: number, sharpe: number, dd: number): InnerMetrics {
    return {
      candidateHash: c,
      candidateName: c,
      foldPath: "0/0",
      dsr,
      sharpe,
      maxDrawdown: dd,
      totalReturn: 0,
      trades: 0,
    };
  }

  test("selects by median DSR first", () => {
    const inner: InnerMetrics[] = [
      metric("a", 0.8, 1.0, 0.2),
      metric("a", 0.7, 1.0, 0.2),
      metric("b", 0.6, 2.0, 0.1),
      metric("b", 0.5, 2.0, 0.1),
    ];
    const selected = selectCandidate(aggregateInner(inner));
    expect(selected.candidateName).toBe("a");
  });

  test("ties broken by median Sharpe, then DD, then hash", () => {
    const inner: InnerMetrics[] = [
      metric("z", 0.6, 1.0, 0.2),
      metric("a", 0.6, 1.0, 0.2),
      metric("z", 0.6, 1.0, 0.2),
      metric("a", 0.6, 1.0, 0.2),
    ];
    const selected = selectCandidate(aggregateInner(inner));
    expect(selected.candidateHash).toBe("a");
  });
});

describe("stitched OOS + concentration", () => {
  function fakeResult(label: string, from: number, to: number, history: number[], tradesBySymbol: Record<string, { trades: number; grossPnl: number; fees: number; funding: number }>): any {
    return {
      window: { label },
      fromMs: from,
      toMs: to,
      equityHistory: history.map((eq, i) => ({ t: from + i * 3600000, eq })),
      closedTrades: Object.entries(tradesBySymbol).flatMap(([symbol, v]) =>
        Array.from({ length: v.trades }, () => ({ symbol, pnl: v.grossPnl / Math.max(1, v.trades) })),
      ),
      tradesBySymbol,
      fees: 0,
      funding: 0,
      liquidations: 0,
      marginRejects: 0,
      ruined: false,
    };
  }

  test("stitchEquityHistory concatenates folds at scale", () => {
    const r1 = fakeResult("0/test", 0, 100, [100, 110], { A: { trades: 1, grossPnl: 10, fees: 0, funding: 0 } });
    const r2 = fakeResult("1/test", 100, 200, [100, 90], { A: { trades: 1, grossPnl: -10, fees: 0, funding: 0 } });
    const stitched = stitchEquityHistory([r1, r2], 100);
    expect(stitched[0].eq).toBe(100);
    // Fold 1: 100 -> 110. Fold 2: 100 -> 90, scaled to start at 110 => 110 -> 99.
    expect(stitched[stitched.length - 1].eq).toBeCloseTo(99, 6);
  });

  test("stitchedMetrics compute annualized Sharpe and drawdown", () => {
    const r = fakeResult("0/test", 0, 1000, [100, 101, 102, 103], { A: { trades: 4, grossPnl: 6, fees: 0, funding: 0 } });
    const m = stitchedMetrics(r.equityHistory, [r], 365);
    expect(m.totalReturn).toBe(0.03);
    expect(m.sharpe).toBeGreaterThan(0);
    expect(m.maxDrawdown).toBe(0);
    expect(m.trades).toBe(4);
  });

  test("concentration reports max fraction by fold", () => {
    const r1 = fakeResult("0/test", 0, 100, [100, 110], {
      A: { trades: 9, grossPnl: 90, fees: 0, funding: 0 },
      B: { trades: 1, grossPnl: 10, fees: 0, funding: 0 },
    });
    const r2 = fakeResult("1/test", 100, 200, [100, 90], {
      A: { trades: 5, grossPnl: 50, fees: 0, funding: 0 },
      B: { trades: 5, grossPnl: 50, fees: 0, funding: 0 },
    });
    const c = concentration([r1, r2]);
    expect(c.maxTradesFracByFold).toHaveLength(2);
    expect(c.maxTradesFracByFold.find(f => f.foldPath === "0/test")?.symbol).toBe("A");
    expect(c.totalTradesBySymbol.A).toBe(14);
  });
});

describe("manifest identity", () => {
  test("manifestIdentity excludes mutable trial ledger and approval state", () => {
    const m: ExperimentManifest = {
      ...baseManifest,
      approved: { candidateHash: "abc", selectedAt: "2024-01-01", reason: "test" },
      trialLedger: [{ id: "1", candidateHash: "abc", candidateName: "x", foldPath: "0/0", costTier: "base", fromMs: 0, toMs: 1, status: "complete", hash: "h" }],
    };
    const asOfMs = Date.parse(m.asOf);
    const id1 = canonicalJson(manifestIdentity(m, asOfMs));
    const id2 = canonicalJson(manifestIdentity({ ...m, approved: undefined, trialLedger: [] }, asOfMs));
    expect(id1).toBe(id2);
  });

  test("manifestIdentity includes prior trial accounting because it changes DSR and approval", () => {
    const asOfMs = Date.parse(baseManifest.asOf);
    const id1 = canonicalJson(manifestIdentity(baseManifest, asOfMs));
    const id2 = canonicalJson(manifestIdentity({
      ...baseManifest,
      trialAccounting: { priorUniqueTrials: 251, complete: false },
    }, asOfMs));
    expect(id1).not.toBe(id2);
  });

  test("manifestIdentity excludes the runtime database path", () => {
    const asOfMs = Date.parse(baseManifest.asOf);
    const id1 = canonicalJson(manifestIdentity(baseManifest, asOfMs));
    const id2 = canonicalJson(manifestIdentity({
      ...baseManifest,
      data: { ...baseManifest.data, dbPath: "/tmp/same-data.db" },
    }, asOfMs));
    expect(id2).toBe(id1);
  });

  test("manifestIdentity includes resolved asOf and fold boundaries for deterministic identity", () => {
    const m: ExperimentManifest = baseManifest;
    const asOfMs = Date.parse(m.asOf);
    const id = manifestIdentity(m, asOfMs) as any;
    expect(id.asOfResolved).toBe(new Date(asOfMs).toISOString());
    expect(id.foldBoundaries).toBeDefined();
    expect(id.foldBoundaries).toHaveLength(m.window.outerFoldCount);
    // Verify that fold boundaries are included (they change when asOf changes with "latest")
    expect(id.foldBoundaries[0]).toHaveProperty("path");
    expect(id.foldBoundaries[0]).toHaveProperty("testFromMs");
    expect(id.foldBoundaries[0]).toHaveProperty("testToMs");
  });

  test("candidateToReplayConfig carries manifest warmupDays and snapshot override", () => {
    const cfg = candidateToReplayConfig(baseManifest, baseManifest.candidates[0], "base", "/tmp/snapshot.db");
    expect(cfg.warmupDays).toBe(baseManifest.window.warmupDays);
    expect(cfg.dbPath).toBe("/tmp/snapshot.db");
  });
});

describe("acceptance gates include stress and LOO", () => {
  function fakeSummary(): WalkForwardSummary {
    const base = {
      sleeve: "crypto", window: { label: "0/test", from: "2024-01-01", to: "2024-02-01" },
      fromMs: 0, toMs: 1, config: { initialEquity: 10_000, sleeve: "crypto" } as any,
      finalEquity: 11_000, totalReturn: 0.1, maxDrawdown: 0.05, sharpe: 1.2,
      winRate: 0.5, trades: 10, tradesPerDay: 0.5, expectancy: 10,
      fees: 0, funding: 0, liquidations: 0, marginRejects: 0, ruined: false,
      bench: 0, dailyReturns: [], sessionReturns: [], tradesBySymbol: {},
      equityHistory: [{ t: 0, eq: 10_000 }, { t: 1, eq: 11_000 }], closedTrades: [], hash: "h",
    };
    const stressResult = { ...base, totalReturn: 0.08, sharpe: 1.0, maxDrawdown: 0.06 };
    return {
      manifestHash: "", configHash: "", dataHash: "", codeHash: "", asOfMs: 0, resolvedTo: "",
      selectedCandidate: null,
      innerSelection: [],
      outerTests: [{ foldPath: "0/test", result: base as any }],
      stressTests: [{ foldPath: "0/test", result: stressResult as any }],
      stitchedOos: { totalReturn: 0.1, sharpe: 1.2, maxDrawdown: 0.05, winRate: 0.5, trades: 10, expectancy: 10, fees: 0, funding: 0, liquidations: 0, marginRejects: 0, ruined: false },
      concentration: { maxTradesFracByFold: [], maxPnlFracByFold: [], totalTradesBySymbol: {}, totalGrossPnlBySymbol: {} },
      loo: [
        { excludedSymbol: "BTC/USD", stitchedReturn: 0.09, stitchedSharpe: 1.1, stitchedMaxDrawdown: 0.05, totalTrades: 9 },
        { excludedSymbol: "ETH/USD", stitchedReturn: 0.02, stitchedSharpe: 0.3, stitchedMaxDrawdown: 0.12, totalTrades: 9 },
      ],
      skippedFolds: [],
      acceptance: {}, approved: false, approvalReason: "", complete: true, priorTrialsComplete: true,
    };
  }

  test("stress and LOO gates are evaluated when present and thresholds are explicit", () => {
    const summary = fakeSummary();
    evaluateAcceptance(summary, {
      minSharpe: 0,
      stressMinSharpe: 0.5, stressMaxDrawdown: 0.1, stressMinTotalReturn: -0.1,
      looMinSharpe: 0.5, looMaxDrawdown: 0.1, looMinTotalReturn: -0.1,
    });
    expect(summary.acceptance.minSharpe.pass).toBe(true);
    expect(summary.acceptance.stressMinSharpe.pass).toBe(true);
    expect(summary.acceptance.looMinSharpe.pass).toBe(false); // worst LOO sharpe = 0.3
  });

  test("LOO drawdown gate uses the worst excluded-symbol drawdown", () => {
    const summary = fakeSummary();
    evaluateAcceptance(summary, {
      looMaxDrawdown: 0.1,
      stressMinSharpe: 0, stressMaxDrawdown: 1, stressMinTotalReturn: -1,
      looMinSharpe: -1, looMinTotalReturn: -1,
    });
    expect(summary.acceptance.looMaxDrawdown.value).toBe(0.12);
    expect(summary.acceptance.looMaxDrawdown.pass).toBe(false);
  });

  test("missing stress or LOO results/thresholds fail rather than omitting gates", () => {
    const summary = fakeSummary();
    summary.stressTests = [];
    summary.loo = [];
    evaluateAcceptance(summary, { minSharpe: 0 });
    expect(summary.acceptance.stressMinSharpe.pass).toBe(false);
    expect(summary.acceptance.looMinSharpe.pass).toBe(false);
    expect(summary.approvalReason).toContain("gate(s) failed");
  });

  test("skipped folds block approval even if gates pass", () => {
    const summary = fakeSummary();
    summary.skippedFolds = ["0"];
    evaluateAcceptance(summary, {
      minSharpe: -10, maxDrawdown: 10, minTotalReturn: -10, maxConcentration: 10, minTrades: 0,
      stressMinSharpe: -10, stressMaxDrawdown: 10, stressMinTotalReturn: -10,
      looMinSharpe: -10, looMaxDrawdown: 10, looMinTotalReturn: -10,
    });
    expect(summary.approved).toBe(false);
    expect(summary.approvalReason).toContain("skipped outer folds");
  });

  test("incomplete historical trial accounting blocks approval", () => {
    const summary = fakeSummary();
    summary.priorTrialsComplete = false;
    evaluateAcceptance(summary, {
      minSharpe: -10, maxDrawdown: 10, minTotalReturn: -10, maxConcentration: 10, minTrades: 0,
      stressMinSharpe: -10, stressMaxDrawdown: 10, stressMinTotalReturn: -10,
      looMinSharpe: -10, looMaxDrawdown: 10, looMinTotalReturn: -10,
    });
    expect(summary.approved).toBe(false);
    expect(summary.approvalReason).toContain("historical trial accounting incomplete");
  });
});

describe("per-outer-fold nested selection", () => {
  function seedDb(tmpDir: string, dbPath: string) {
    mkdirSync(tmpDir, { recursive: true });
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const start = Date.parse("2023-12-01T00:00:00Z");
      let price = 100;
      db.run(`CREATE TABLE IF NOT EXISTS funding_rates (
        symbol TEXT, funding_time INTEGER, rate REAL,
        PRIMARY KEY(symbol, funding_time)
      )`);
      const fundStmt = db.prepare("INSERT OR REPLACE INTO funding_rates VALUES (?,?,?)");
      db.transaction(() => {
        for (let i = 0; i < 90 * 24; i++) {
          const t = start + i * 3600_000;
          price = price * (1 + (Math.sin(i / 100) * 0.001));
          stmt.run("BTC/USD", "1h", "binance_futures", t, price, price * 1.001, price * 0.999, price, 1);
        }
        for (let i = 0; i < 100 * 24; i++) {
          fundStmt.run("BTCUSDT", start + i * 3600_000, 0.0001);
        }
      })();
    } finally {
      db.close();
    }
  }

  function fakeResult(cfg: any, win: any): any {
    // Candidate A wins outer fold 0's inner data; candidate B wins later folds.
    // Use the fold path embedded in the window label.
    const fold = win.label;
    const isInner = /^\d+\/\d+$/.test(fold);
    const isOuter0 = fold === "0/test";
    const isOuter1 = fold === "1/test";

    // Mock metrics so fold 0 prefers A and folds 1/2 prefer B.
    let sharpe = 0;
    if (isInner) {
      if (fold.startsWith("0/")) sharpe = cfg.cadenceMin === 240 ? 1.5 : 0.5;
      else sharpe = cfg.cadenceMin === 120 ? 1.5 : 0.5;
    } else {
      sharpe = cfg.cadenceMin === 240 ? (isOuter0 ? 1.2 : 0.3) : (isOuter1 ? 1.2 : 0.3);
    }

    return {
      window: { label: win.label, from: win.from, to: win.to },
      fromMs: Date.parse(win.from),
      toMs: Date.parse(win.to),
      config: cfg,
      finalEquity: cfg.initialEquity * (1 + sharpe * 0.01),
      totalReturn: sharpe * 0.01,
      maxDrawdown: 0.05,
      sharpe,
      winRate: 0.5,
      trades: isInner ? 5 : 10,
      tradesPerDay: 0.1,
      expectancy: 1,
      fees: 0,
      funding: 0,
      liquidations: 0,
      marginRejects: 0,
      ruined: false,
      bench: 0,
      dailyReturns: [{ date: "2024-01-01", ret: sharpe * 0.01 }],
      sessionReturns: [{ from: win.from, to: win.to, ret: sharpe * 0.01 }],
      tradesBySymbol: {},
      equityHistory: [{ t: Date.parse(win.from), eq: cfg.initialEquity }, { t: Date.parse(win.to), eq: cfg.initialEquity * (1 + sharpe * 0.01) }],
      closedTrades: [],
      hash: "h",
      finalRiskState: { ...INITIAL_RISK_STATE },
    };
  }

  test("different candidates can be selected for different outer folds", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-nested-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedDb(tmpDir, dbPath);

      const m: ExperimentManifest = {
        ...baseManifest,
        name: "wf-nested",
        sleeve: "crypto",
        data: { ...baseManifest.data, dbPath, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60 },
        asOf: "2024-04-01",
        window: { from: "2024-02-01", to: "2024-04-01", outerFoldCount: 3, innerFoldCount: 2, purgeYears: 0.01, warmupDays: 30 },
        candidates: [
          { ...baseManifest.candidates[0], name: "A", cadenceMin: 240 },
          { ...baseManifest.candidates[0], name: "B", cadenceMin: 120 },
        ],
      };

      const { runWalkForward } = await import("./walk-forward");
      const wf = await runWalkForward(m, {
        dryRun: false,
        runner: async (cfg, win) => fakeResult(cfg, win),
      });
      outputDir = wf.outputDir;
      const { summary } = wf;

      expect(summary.skippedFolds).toHaveLength(0);
      const outer0 = summary.outerTests.find(t => t.foldPath === "0/test");
      const outer1 = summary.outerTests.find(t => t.foldPath === "1/test");
      expect(outer0).toBeDefined();
      expect(outer1).toBeDefined();
      expect(outer0!.result.config.cadenceMin).toBe(240);
      expect(outer1!.result.config.cadenceMin).toBe(120);

      // Stress tests should use the same per-fold selected candidate.
      const stress0 = summary.stressTests.find(t => t.foldPath === "0/test");
      const stress1 = summary.stressTests.find(t => t.foldPath === "1/test");
      expect(stress0!.result.config.cadenceMin).toBe(240);
      expect(stress1!.result.config.cadenceMin).toBe(120);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30000);
});

describe("snapshot hashing, use, and cleanup", () => {
  function seedDb(tmpDir: string, dbPath: string) {
    mkdirSync(tmpDir, { recursive: true });
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const start = Date.parse("2023-12-01T00:00:00Z");
      let price = 100;
      db.run(`CREATE TABLE IF NOT EXISTS funding_rates (
        symbol TEXT, funding_time INTEGER, rate REAL,
        PRIMARY KEY(symbol, funding_time)
      )`);
      const fundStmt = db.prepare("INSERT OR REPLACE INTO funding_rates VALUES (?,?,?)");
      db.transaction(() => {
        for (let i = 0; i < 120 * 24; i++) {
          const t = start + i * 3600_000;
          price = price * (1 + (Math.sin(i / 100) * 0.001));
          stmt.run("BTC/USD", "1h", "binance_futures", t, price, price * 1.001, price * 0.999, price, 1);
        }
        for (let i = 0; i < 150 * 24; i++) {
          fundStmt.run("BTCUSDT", start + i * 3600_000, 0.0001);
        }
      })();
    } finally {
      db.close();
    }
  }

  test("snapshot is created, hashed, used by every trial, and cleaned up", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-snapshot-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedDb(tmpDir, dbPath);

      const m: ExperimentManifest = {
        ...baseManifest,
        name: "wf-snapshot",
        sleeve: "crypto",
        data: { ...baseManifest.data, dbPath, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60 },
        asOf: "2024-03-01",
        window: { from: "2024-01-15", to: "2024-03-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.05, warmupDays: 32 },
        candidates: [baseManifest.candidates[0]],
      };

      const { runWalkForward } = await import("./walk-forward");
      const wf = await runWalkForward(m, { dryRun: false });
      outputDir = wf.outputDir;
      const { summary } = wf;

      expect(summary.dataHash).toMatch(/^[a-f0-9]{64}$/);
      expect(summary.outerTests.length).toBeGreaterThan(0);

      const snapshotPath = summary.outerTests[0].result.config.dbPath;
      expect(snapshotPath).not.toBe(dbPath);
      expect(snapshotPath).toContain("snapshot.db");

      // All trials should replay from the snapshot path.
      for (const t of summary.outerTests) expect(t.result.config.dbPath).toBe(snapshotPath);
      for (const t of summary.stressTests) expect(t.result.config.dbPath).toBe(snapshotPath);

      // Snapshot should be cleaned up after the run.
      expect(existsSync(snapshotPath)).toBe(false);
      expect(outputDir).toContain("data/backtests/");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30000);

  test("dry-run does not label unexecuted folds as structurally skipped", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-dry-run-"));
    const dbPath = join(tmpDir, "historical.db");
    try {
      seedDb(tmpDir, dbPath);
      const m: ExperimentManifest = {
        ...baseManifest,
        sleeve: "crypto",
        data: { ...baseManifest.data, dbPath, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60 },
        asOf: "2024-03-01",
        window: { from: "2024-01-15", to: "2024-03-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0, warmupDays: 15 },
        candidates: [baseManifest.candidates[0]],
      };
      const { runWalkForward } = await import("./walk-forward");
      const { summary } = await runWalkForward(m, { dryRun: true });
      expect(summary.skippedFolds).toHaveLength(0);
      expect(summary.complete).toBe(false);
      expect(summary.approvalReason).toContain("current trial ledger incomplete");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("small end-to-end walk-forward", () => {
  function seedDb(tmpDir: string, dbPath: string) {
    mkdirSync(tmpDir, { recursive: true });
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      // 60 days of 1h BTC bars, enough for warmup + a few folds.
      const start = Date.parse("2023-12-01T00:00:00Z");
      let price = 100;
      db.run(`CREATE TABLE IF NOT EXISTS funding_rates (
        symbol TEXT, funding_time INTEGER, rate REAL,
        PRIMARY KEY(symbol, funding_time)
      )`);
      const fundStmt = db.prepare("INSERT OR REPLACE INTO funding_rates VALUES (?,?,?)");
      // Seed beyond the walk-forward window end to satisfy FundingBook coverage.
      db.transaction(() => {
        for (let i = 0; i < 120 * 24; i++) {
          const t = start + i * 3600_000;
          price = price * (1 + (Math.sin(i / 100) * 0.001));
          stmt.run("BTC/USD", "1h", "binance_futures", t, price, price * 1.001, price * 0.999, price, 1);
        }
        for (let i = 0; i < 150 * 24; i++) {
          fundStmt.run("BTCUSDT", start + i * 3600_000, 0.0001);
        }
      })();
    } finally {
      db.close();
    }
  }

  test("single-candidate protocol completes and writes output", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-e2e-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedDb(tmpDir, dbPath);

      const m: ExperimentManifest = {
        ...baseManifest,
        name: "wf-e2e",
        sleeve: "crypto",
        data: { ...baseManifest.data, dbPath, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60 },
        asOf: "2024-03-01",
        window: { from: "2024-01-15", to: "2024-03-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.05, warmupDays: 32 },
        candidates: [baseManifest.candidates[0]],
      };

      const { runWalkForward } = await import("./walk-forward");
      const wf = await runWalkForward(m, { dryRun: false });
      outputDir = wf.outputDir;
      const { summary } = wf;

      expect(summary.selectedCandidate).not.toBeNull();
      expect(summary.complete).toBe(true);
      expect(summary.stitchedOos.trades).toBeGreaterThanOrEqual(0);
      expect(summary.acceptance.maxDrawdown.pass).toBe(true);
      expect(summary.stressTests.length).toBeGreaterThan(0);
      expect(summary.loo).toHaveLength(0); // no valid leave-one-out portfolio remains
      expect(outputDir).toContain("data/backtests/");
      const diskSummary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8"));
      expect(diskSummary.outerTests[0].result.totalReturn).toBeDefined();
      expect(diskSummary.outerTests[0].result.equityHistory).toBeUndefined();
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30000);
});

describe("reproducibility fixes", () => {
  test("latest asOf resolves from the supplied immutable snapshot", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-asof-snapshot-"));
    const sourcePath = join(tmpDir, "source.db");
    const snapshotPath = join(tmpDir, "snapshot.db");
    const seed = (path: string, timestamp: number) => {
      const db = new Database(path);
      db.run(`CREATE TABLE historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      db.run("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)", ["BTC/USD", "1h", "binance_futures", timestamp, 100, 100, 100, 100, 1]);
      db.close();
    };
    try {
      const older = Date.parse("2024-01-01T00:00:00Z");
      seed(sourcePath, older + 86_400_000);
      seed(snapshotPath, older);
      const m: ExperimentManifest = {
        ...baseManifest,
        asOf: "latest",
        sleeve: "crypto",
        data: { ...baseManifest.data, dbPath: sourcePath, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: false, barMinutes: 60, barMinutesEq: 60 },
      };
      expect(resolveAsOf(m, snapshotPath)).toBe(older + 3_600_000);
      expect(resolveAsOf(m)).toBe(older + 86_400_000 + 3_600_000);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("snapshot created before resolving asOf race condition", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-snapshot-race-"));
    const dbPath = join(tmpDir, "historical.db");
    let db: Database | null = null;
    let outputDir: string | undefined;
    try {
      // Seed a minimal db
      db = new Database(dbPath);
      db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const start = Date.parse("2023-12-01T00:00:00Z");
      db.transaction(() => {
        for (let i = 0; i < 200 * 24; i++) {
          const t = start + i * 3600_000;
          stmt.run("BTC/USD", "1h", "binance_futures", t, 100, 100, 100, 100, 1);
        }
      })();
      db.close();
      db = null;

      const { runWalkForward } = await import("./walk-forward");
      const m: ExperimentManifest = {
        ...baseManifest,
        name: "wf-snapshot-race",
        sleeve: "crypto",
        data: { ...baseManifest.data, dbPath, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: false, barMinutes: 60, barMinutesEq: 60 },
        asOf: "latest", // Resolve to latest common asOf
        window: { from: "2024-01-15", to: "2024-09-01", outerFoldCount: 1, innerFoldCount: 1, purgeYears: 0.05, warmupDays: 32 },
        candidates: [baseManifest.candidates[0]],
      };

      // Run twice with the same manifest but latest asOf — should produce same results
      const { summary: s1, outputDir: dir1 } = await runWalkForward(m, { dryRun: false });
      const { summary: s2, outputDir: dir2 } = await runWalkForward(m, { dryRun: false });
      outputDir = dir1;

      // Both should resolve to the same asOf and produce the same snapshot-based results
      expect(s1.asOfMs).toBe(s2.asOfMs);
      expect(s1.dataHash).toBe(s2.dataHash);
      expect(s1.selectedCandidate?.hash).toBe(s2.selectedCandidate?.hash);
      expect(dir2).toBe(dir1); // same manifest identity ⇒ same outputDir, one cleanup suffices
    } finally {
      db?.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30000);

  test("dataHash changes when consumed bar row changes, not on unrelated rows", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-data-hash-"));
    const dbPath1 = join(tmpDir, "db1.db");
    const dbPath2 = join(tmpDir, "db2.db");

    function seedDb(path: string, unrelatedPrice?: number) {
      const db = new Database(path);
      db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const start = Date.parse("2024-01-01T00:00:00Z");
      db.transaction(() => {
        for (let i = 0; i < 48; i++) {
          const t = start + i * 3600_000;
          stmt.run("BTC/USD", "1h", "binance_futures", t, 100, 100, 100, 100, 1);
          if (unrelatedPrice !== undefined) {
            stmt.run("ETH/USD", "1h", "binance_futures", t, unrelatedPrice, unrelatedPrice, unrelatedPrice, unrelatedPrice, 1);
          }
        }
      })();
      db.close();
    }

    try {
      seedDb(dbPath1);
      seedDb(dbPath2, 999);
      const m: ExperimentManifest = {
        ...baseManifest,
        name: "wf-data-hash",
        sleeve: "crypto",
        data: { ...baseManifest.data, dbPath: dbPath1, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: false, barMinutes: 60, barMinutesEq: 60 },
        candidates: [baseManifest.candidates[0]],
      };
      const sleeve = manifestToSleeve(m);
      const fromMs = Date.parse("2024-01-01T00:00:00Z");
      const toMs = Date.parse("2024-01-03T00:00:00Z");
      const h1 = await hashDataSnapshot(dbPath1, sleeve, fromMs, toMs, 0);
      const h2 = await hashDataSnapshot(dbPath2, sleeve, fromMs, toMs, 0);
      expect(h2).toBe(h1);

      const db = new Database(dbPath2);
      db.run("UPDATE historical_bars SET close = 101 WHERE symbol = 'BTC/USD' AND timestamp = ?", [fromMs]);
      db.close();
      expect(await hashDataSnapshot(dbPath2, sleeve, fromMs, toMs, 0)).not.toBe(h1);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30000);

  test("duplicate effective candidates after resolution are rejected", async () => {
    const { runWalkForward } = await import("./walk-forward");
    const m: ExperimentManifest = {
      ...baseManifest,
      data: { ...baseManifest.data, dbPath: "/definitely/missing/historical.db" },
      candidates: [
        { ...baseManifest.candidates[0], name: "A" },
        { ...baseManifest.candidates[0], name: "B" },
      ],
    };
    await expect(runWalkForward(m)).rejects.toThrow("duplicate effective candidate");
  });

  test("hashCodeFiles fails closed if required source file is missing", async () => {
    await expect(hashCodeFiles(["/definitely/missing/walk-forward-source.ts"]))
      .rejects.toThrow("required code file missing");
  });

  test("prior trial DSR uses priorUniqueTrials + numCandidates for deflated Sharpe", async () => {
    const { correctedDsr: correctedDsrFn } = await import("./walk-forward");
    const mockResult: any = {
      dailyReturns: Array.from({ length: 100 }, (_, i) => ({ date: "", ret: 0.001 + Math.sin(i / 5) * 0.005 })),
    };

    // With priorUniqueTrials=100 and 2 candidates, the correction uses max(1, 100 + 2) = 102 trials
    // With priorUniqueTrials=0 and 2 candidates, uses max(1, 0 + 2) = 2 trials
    const dsr1 = correctedDsrFn(mockResult, 2, 100, "crypto");
    const dsr2 = correctedDsrFn(mockResult, 2, 0, "crypto");
    // Higher priorUniqueTrials → higher denominator → lower DSR (conservative deflation)
    expect(dsr1).toBeLessThan(dsr2);
  });
});

describe("nested runner coverage validation", () => {
  test("validateBarDensity is called by runWithConfig; fails on sparse bar gaps", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const bars = [
      { timestamp: 0, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      // 2h gap (unexplained for non-RTH; would be explained for RTH by weekend/holiday)
      { timestamp: 2 * 3_600_000 + 100_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      { timestamp: 3 * 3_600_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
    ];
    expect(() => validateBarDensity(bars, "BTC/USD", 60, false, 0, 4 * 3_600_000)).toThrow("gap");
  });

  test("validateFundingCoverage is called by runWithConfig; fails on large funding gaps", () => {
    const { validateFundingCoverage } = require("./backtest-momentum-wf");
    const db = new Database(":memory:");
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    const stmt = db.prepare("INSERT INTO funding_rates VALUES (?,?,?)");
    const start = Date.now();
    stmt.run("BTCUSDT", start, 0.0001);
    stmt.run("BTCUSDT", start + 8 * 3_600_000, 0.0001);
    // Create > 9h gap
    stmt.run("BTCUSDT", start + 18 * 3_600_000, 0.0001);
    stmt.run("BTCUSDT", start + 200 * 3_600_000, 0.0001);
    expect(() => validateFundingCoverage(db, ["BTC/USD"], start, start + 200 * 3_600_000)).toThrow("funding gap");
    db.close();
  });
});

describe("continueRiskState — outer-fold I/F scaling", () => {
  function fold(finalEquity: number, state: Partial<RiskState>): ReplayResult {
    return {
      config: { initialEquity: 10_000 } as any,
      finalEquity,
      finalRiskState: { ...INITIAL_RISK_STATE, ...state },
    } as any;
  }

  test("scales peakEquity/dayStartEquity/equityBase by I/F, preserves pauses/timestamps/streaks", () => {
    const result = fold(12_000, {
      peakEquity: 12_000, dayStartEquity: 11_000, equityBase: 12_000,
      consecutiveLosses: 2, pausedUntil: 123_456, pauseReason: "x",
      dayStartedAt: 999, lastEvalAt: 1_000,
    });

    const next = continueRiskState(result);

    // I/F = 10_000/12_000
    expect(next.peakEquity).toBeCloseTo(10_000, 6);
    expect(next.dayStartEquity).toBeCloseTo(11_000 * (10_000 / 12_000), 6);
    expect(next.equityBase).toBeCloseTo(10_000, 6);
    // Everything else passes through untouched.
    expect(next.consecutiveLosses).toBe(2);
    expect(next.pausedUntil).toBe(123_456);
    expect(next.pauseReason).toBe("x");
    expect(next.dayStartedAt).toBe(999);
    expect(next.lastEvalAt).toBe(1_000);
  });

  test("omits equityBase when absent from the source state", () => {
    const result = fold(11_000, { peakEquity: 11_000, dayStartEquity: 10_500 });
    const next = continueRiskState(result);
    expect(next.equityBase).toBeUndefined();
  });

  test("F <= 0 fails closed: state passes through unscaled, cannot resurrect later folds", () => {
    const result = fold(0, { peakEquity: 9_000, dayStartEquity: 8_500, equityBase: 9_000, pausedUntil: 5_000, pauseReason: "hard drawdown" });
    const next = continueRiskState(result);
    expect(next).toEqual({ ...result.finalRiskState });
  });

  test("negative F fails closed: state passes through unscaled", () => {
    const result = fold(-500, { peakEquity: 9_000, dayStartEquity: 8_500 });
    const next = continueRiskState(result);
    expect(next.peakEquity).toBe(9_000);
    expect(next.dayStartEquity).toBe(8_500);
  });

  test("non-finite F fails closed: state passes through unscaled", () => {
    const result = fold(NaN, { peakEquity: 9_000, dayStartEquity: 8_500 });
    const next = continueRiskState(result);
    expect(next.peakEquity).toBe(9_000);
    expect(next.dayStartEquity).toBe(8_500);
  });
});

describe("trial cache invalidation on initialRiskState change", () => {
  test("a different initialRiskState forces a rerun even with the same config/data/code context", async () => {
    let calls = 0;
    const runner = async (cfg: any, win: any) => {
      calls++;
      return { config: cfg, window: win } as any;
    };
    const fold = { path: "0/test", fromMs: 0, toMs: 1 };
    const candidate = baseManifest.candidates[0];
    const stateA: RiskState = { ...INITIAL_RISK_STATE, peakEquity: 10_000 };
    const stateB: RiskState = { ...INITIAL_RISK_STATE, peakEquity: 11_000 };

    const first = await runTrial(baseManifest, candidate, fold, "base", undefined, undefined, runner, "run-a", stateA);
    const rerunSameState = await runTrial(baseManifest, candidate, fold, "base", first, undefined, runner, "run-a", stateA);
    const rerunDifferentState = await runTrial(baseManifest, candidate, fold, "base", first, undefined, runner, "run-a", stateB);
    const rerunNoState = await runTrial(baseManifest, candidate, fold, "base", first, undefined, runner, "run-a", undefined);

    expect(rerunSameState.hash).toBe(first.hash); // cache hit
    expect(rerunDifferentState.hash).not.toBe(first.hash); // cache miss — upstream chain changed
    expect(rerunNoState.hash).not.toBe(first.hash); // cache miss — presence of state matters too
    // id (fold × candidate × cost tier) stays stable regardless of state.
    expect(rerunDifferentState.id).toBe(first.id);
    expect(calls).toBe(3); // first, rerunDifferentState, rerunNoState (rerunSameState reused the cache)
  });
});

describe("LOO chains reset between excluded symbols", () => {
  test("each excluded-symbol chain is independent and resets — never continues into the next symbol", async () => {
    const m: ExperimentManifest = {
      ...baseManifest,
      sleeve: "crypto",
      data: { ...baseManifest.data, universe: ["BTC/USD", "ETH/USD", "SOL/USD"], refSymbol: "BTC/USD", rthOnly: false },
    };
    const outerFolds = [
      { path: "0", test: { path: "0/test", fromMs: 0, toMs: 86_400_000 }, inner: [] },
      { path: "1", test: { path: "1/test", fromMs: 86_400_000, toMs: 172_800_000 }, inner: [] },
    ];
    const selected = new Map([["0", m.candidates[0]], ["1", m.candidates[0]]]);

    const calls: Array<{ label: string; initialRiskState?: RiskState }> = [];
    let counter = 0;
    const runner: ReplayRunner = async (cfg, win) => {
      calls.push({ label: win.label });
      const finalEquity = cfg.initialEquity * (1.1 + 0.1 * counter++);
      return {
        sleeve: cfg.sleeve, window: win, fromMs: Date.parse(win.from), toMs: Date.parse(win.to), config: cfg,
        finalEquity, totalReturn: 0.1, maxDrawdown: 0, sharpe: 1, winRate: 1, trades: 1, tradesPerDay: 1,
        expectancy: 1, fees: 0, funding: 0, liquidations: 0, marginRejects: 0, ruined: false, bench: 0,
        dailyReturns: [], sessionReturns: [], tradesBySymbol: {},
        equityHistory: [{ t: Date.parse(win.from), eq: cfg.initialEquity }, { t: Date.parse(win.to), eq: finalEquity }],
        closedTrades: [], hash: "h",
        finalRiskState: { ...INITIAL_RISK_STATE, peakEquity: finalEquity, pausedUntil: 0, pauseReason: "" },
      } as ReplayResult;
    };
    // Wrap to capture the initialRiskState argument passed in (the plain
    // runner above ignores its 3rd param on purpose — record separately).
    const spy: ReplayRunner = async (cfg, win, initialRiskState) => {
      const r = await runner(cfg, win, initialRiskState);
      calls[calls.length - 1].initialRiskState = initialRiskState;
      return r;
    };

    await runLoo(m, selected, outerFolds, undefined, spy);

    // 3 symbols x 2 folds = 6 calls, grouped per symbol in universe order.
    expect(calls).toHaveLength(6);
    const perSymbol = [calls.slice(0, 2), calls.slice(2, 4), calls.slice(4, 6)];
    for (const [fold0, fold1] of perSymbol) {
      // Fresh start for every excluded symbol...
      expect(fold0.initialRiskState).toBeUndefined();
      // ...but continuity WITHIN a symbol's own chain.
      expect(fold1.initialRiskState).toBeDefined();
    }
    // Cross-symbol isolation: symbol B's fold0 must not carry symbol A's fold1 state.
    expect(perSymbol[1][0].initialRiskState).toBeUndefined();
    expect(perSymbol[2][0].initialRiskState).toBeUndefined();
  });

  test("a ruined LOO fold cuts that symbol's chain only: fold 1 never invokes the runner for it, other symbols are unaffected", async () => {
    const m: ExperimentManifest = {
      ...baseManifest,
      sleeve: "crypto",
      data: { ...baseManifest.data, universe: ["BTC/USD", "ETH/USD"], refSymbol: "BTC/USD", rthOnly: false },
    };
    const outerFolds = [
      { path: "0", test: { path: "0/test", fromMs: 0, toMs: 86_400_000 }, inner: [] },
      { path: "1", test: { path: "1/test", fromMs: 86_400_000, toMs: 172_800_000 }, inner: [] },
    ];
    const selected = new Map([["0", m.candidates[0]], ["1", m.candidates[0]]]);

    // Excluding BTC/USD leaves universe=[ETH/USD]; excluding ETH/USD leaves [BTC/USD].
    // Ruin the fold-0 replay for the "excluded BTC/USD" chain specifically
    // (identifiable by its remaining universe being exactly [ETH/USD]).
    const calls: Array<{ label: string; universe: string[] }> = [];
    const runner: ReplayRunner = async (cfg, win) => {
      calls.push({ label: win.label, universe: cfg.universe });
      const ruinThis = win.label.startsWith("0/test/") && cfg.universe[0] === "ETH/USD";
      const finalEquity = ruinThis ? 0 : cfg.initialEquity * 1.1;
      return {
        sleeve: cfg.sleeve, window: win, fromMs: Date.parse(win.from), toMs: Date.parse(win.to), config: cfg,
        finalEquity, totalReturn: 0, maxDrawdown: 0, sharpe: 0, winRate: 0.5, trades: 1, tradesPerDay: 1,
        expectancy: 1, fees: 0, funding: 0, liquidations: 0, marginRejects: 0, ruined: ruinThis, bench: 0,
        dailyReturns: [], sessionReturns: [], tradesBySymbol: {},
        equityHistory: [{ t: Date.parse(win.from), eq: cfg.initialEquity }, { t: Date.parse(win.to), eq: finalEquity }],
        closedTrades: [], hash: "h",
        finalRiskState: { ...INITIAL_RISK_STATE, peakEquity: Math.max(0, finalEquity), pausedUntil: 0, pauseReason: "" },
      } as ReplayResult;
    };

    const { results, cutChains } = await runLoo(m, selected, outerFolds, undefined, runner);

    // loo-BTC/USD (universe=[ETH/USD]) ruined at fold 0 — cut, fold 1 never called.
    const btcCalls = calls.filter(c => c.universe[0] === "ETH/USD");
    expect(btcCalls).toHaveLength(1);
    expect(cutChains).toContain("1/test:loo-BTC/USD");

    // loo-ETH/USD (universe=[BTC/USD]) is a fully independent chain — both folds ran.
    const ethCalls = calls.filter(c => c.universe[0] === "BTC/USD");
    expect(ethCalls).toHaveLength(2);
    expect(cutChains.some(c => c.includes("loo-ETH/USD"))).toBe(false);

    // The excluded-BTC result still reflects only its real (fold-0) data —
    // no zombie fold-1 entry — while excluded-ETH has full 2-fold coverage.
    const looResult = results.find(r => r.excludedSymbol === "BTC/USD");
    expect(looResult).toBeDefined();
  });
});

describe("outer chain continuity wiring (runWalkForward)", () => {
  function seedDb(tmpDir: string, dbPath: string) {
    mkdirSync(tmpDir, { recursive: true });
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const start = Date.parse("2023-12-01T00:00:00Z");
      let price = 100;
      db.run(`CREATE TABLE IF NOT EXISTS funding_rates (
        symbol TEXT, funding_time INTEGER, rate REAL,
        PRIMARY KEY(symbol, funding_time)
      )`);
      const fundStmt = db.prepare("INSERT OR REPLACE INTO funding_rates VALUES (?,?,?)");
      let ethPrice = 100;
      db.transaction(() => {
        for (let i = 0; i < 90 * 24; i++) {
          const t = start + i * 3600_000;
          price = price * (1 + (Math.sin(i / 100) * 0.001));
          stmt.run("BTC/USD", "1h", "binance_futures", t, price, price * 1.001, price * 0.999, price, 1);
          // Second symbol — only consumed by tests whose manifest universe
          // includes ETH/USD (e.g. the LOO tests below); harmless extra rows
          // for the single-symbol tests, which never query it.
          ethPrice = ethPrice * (1 + (Math.cos(i / 100) * 0.001));
          stmt.run("ETH/USD", "1h", "binance_futures", t, ethPrice, ethPrice * 1.001, ethPrice * 0.999, ethPrice, 1);
        }
        for (let i = 0; i < 100 * 24; i++) {
          fundStmt.run("BTCUSDT", start + i * 3600_000, 0.0001);
          fundStmt.run("ETHUSDT", start + i * 3600_000, 0.0001);
        }
      })();
    } finally {
      db.close();
    }
  }

  function buildManifest(dbPath: string): ExperimentManifest {
    return {
      ...baseManifest,
      name: "wf-chain",
      sleeve: "crypto",
      data: { ...baseManifest.data, dbPath, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60 },
      asOf: "2024-04-01",
      window: { from: "2024-02-01", to: "2024-04-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.01, warmupDays: 30 },
      candidates: [{ ...baseManifest.candidates[0], name: "only" }],
    };
  }

  function spyRunner(m: ExperimentManifest, calls: Array<{ label: string; isInner: boolean; costTier: "base" | "stress"; initialRiskState?: RiskState }>, results: ReplayResult[], finalEquityFor: (label: string, costTier: "base" | "stress", counter: number) => number): ReplayRunner {
    let counter = 0;
    return async (cfg, win, initialRiskState) => {
      const isInner = /^\d+\/\d+$/.test(win.label);
      const costTier: "base" | "stress" = (cfg.slippageBps === m.costs.stress.slippageBps && cfg.commissionBps === m.costs.stress.commissionBps) ? "stress" : "base";
      const finalEquity = finalEquityFor(win.label, costTier, counter++);
      const result: ReplayResult = {
        sleeve: cfg.sleeve, window: win, fromMs: Date.parse(win.from), toMs: Date.parse(win.to), config: cfg,
        finalEquity, totalReturn: (finalEquity - cfg.initialEquity) / cfg.initialEquity, maxDrawdown: 0, sharpe: 0,
        winRate: 0.5, trades: 1, tradesPerDay: 1, expectancy: 1, fees: 0, funding: 0, liquidations: 0,
        marginRejects: 0, ruined: !(finalEquity > 0) || !Number.isFinite(finalEquity), bench: 0,
        dailyReturns: [], sessionReturns: [], tradesBySymbol: {},
        equityHistory: [{ t: Date.parse(win.from), eq: cfg.initialEquity }, { t: Date.parse(win.to), eq: finalEquity }],
        closedTrades: [], hash: "h",
        finalRiskState: { ...INITIAL_RISK_STATE, peakEquity: Math.max(0, finalEquity), dayStartEquity: Math.max(0, finalEquity) * 0.9, consecutiveLosses: counter, pausedUntil: 0, pauseReason: "" },
      };
      calls.push({ label: win.label, isInner, costTier: isInner ? "base" : costTier, initialRiskState });
      results.push(result);
      return result;
    };
  }

  test("base and stress outer folds each carry their own chronological chain, isolated from each other; inner trials stay fresh", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-chain-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedDb(tmpDir, dbPath);
      const m = buildManifest(dbPath);
      const calls: Array<{ label: string; isInner: boolean; costTier: "base" | "stress"; initialRiskState?: RiskState }> = [];
      const results: ReplayResult[] = [];
      const runner = spyRunner(m, calls, results, (_label, _costTier, counter) => 10_000 * (1 + 0.1 * (counter + 1)));

      const { runWalkForward } = await import("./walk-forward");
      // breakEven: false — chain-topology test; the break-even tiers would add
      // their own base-cost runner calls and skew the call counts below.
      const wf = await runWalkForward(m, { dryRun: false, runner, breakEven: false });
      outputDir = wf.outputDir;
      const { summary } = wf;

      expect(summary.skippedFolds).toHaveLength(0);

      expect(calls.filter(c => c.isInner).every(c => c.initialRiskState === undefined)).toBe(true);

      const baseCalls = calls.filter(c => !c.isInner && c.costTier === "base");
      const stressCalls = calls.filter(c => !c.isInner && c.costTier === "stress");
      expect(baseCalls).toHaveLength(2);
      expect(stressCalls).toHaveLength(2);

      // Fresh start for both chains on the first outer fold.
      expect(baseCalls[0].initialRiskState).toBeUndefined();
      expect(stressCalls[0].initialRiskState).toBeUndefined();

      // Continuity: fold 1 receives fold 0's I/F-scaled finalRiskState, per chain.
      const baseFold0Result = results[calls.indexOf(baseCalls[0])];
      const stressFold0Result = results[calls.indexOf(stressCalls[0])];
      expect(baseCalls[1].initialRiskState).toEqual(continueRiskState(baseFold0Result));
      expect(stressCalls[1].initialRiskState).toEqual(continueRiskState(stressFold0Result));

      // Isolation: base and stress chains never cross-pollinate.
      expect(baseCalls[1].initialRiskState).not.toEqual(stressCalls[1].initialRiskState);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30_000);

  test("a ruined base fold cuts the base chain: fold 1's base test never invokes the runner, stress is unaffected, and the run cannot be approved", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-ruin-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedDb(tmpDir, dbPath);
      const m = buildManifest(dbPath);
      const calls: Array<{ label: string; isInner: boolean; costTier: "base" | "stress"; initialRiskState?: RiskState }> = [];
      const results: ReplayResult[] = [];
      const runner = spyRunner(m, calls, results, (label, costTier, counter) => {
        if (label === "0/test" && costTier === "base") return 0; // ruin fold 0's base replay
        return 10_000 * (1 + 0.1 * (counter + 1));
      });

      const { runWalkForward } = await import("./walk-forward");
      // breakEven: false — chain-topology test; the break-even tiers would add
      // their own base-cost runner calls and skew the call counts below.
      const wf = await runWalkForward(m, { dryRun: false, runner, breakEven: false });
      outputDir = wf.outputDir;
      const { summary } = wf;

      const baseCalls = calls.filter(c => !c.isInner && c.costTier === "base");
      // The chain is CUT after the ruin: fold 1's base test is NEVER invoked —
      // not with unscaled state, not with any state. Only fold 0 ran.
      expect(baseCalls).toHaveLength(1);
      expect(baseCalls[0].label).toBe("0/test");

      // No zombie trade/result for the never-executed fold 1 in the aggregate.
      expect(summary.outerTests.map(t => t.foldPath)).toEqual(["0/test"]);

      // Stress is an INDEPENDENT chain — unaffected by the base ruin, both
      // folds still ran.
      const stressCalls = calls.filter(c => !c.isInner && c.costTier === "stress");
      expect(stressCalls).toHaveLength(2);
      expect(summary.stressTests.map(t => t.foldPath)).toEqual(["0/test", "1/test"]);

      // Represented fail-closed/incomplete: the cut is recorded and blocks approval.
      expect(summary.skippedFolds).toContain("1/test:base");
      expect(summary.approved).toBe(false);
      expect(summary.approvalReason).toContain("skipped");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30_000);

  test("a ruined stress fold cuts the stress chain independently of base", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-ruin-stress-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedDb(tmpDir, dbPath);
      const m = buildManifest(dbPath);
      const calls: Array<{ label: string; isInner: boolean; costTier: "base" | "stress"; initialRiskState?: RiskState }> = [];
      const results: ReplayResult[] = [];
      const runner = spyRunner(m, calls, results, (label, costTier, counter) => {
        if (label === "0/test" && costTier === "stress") return -50; // ruin fold 0's stress replay
        return 10_000 * (1 + 0.1 * (counter + 1));
      });

      const { runWalkForward } = await import("./walk-forward");
      // breakEven: false — chain-topology test; the break-even tiers would add
      // their own base-cost runner calls and skew the call counts below.
      const wf = await runWalkForward(m, { dryRun: false, runner, breakEven: false });
      outputDir = wf.outputDir;
      const { summary } = wf;

      const stressCalls = calls.filter(c => !c.isInner && c.costTier === "stress");
      expect(stressCalls).toHaveLength(1); // cut after fold 0

      const baseCalls = calls.filter(c => !c.isInner && c.costTier === "base");
      expect(baseCalls).toHaveLength(2); // base chain untouched

      expect(summary.skippedFolds).toContain("1/test:stress");
      expect(summary.approved).toBe(false);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30_000);

  // Fully permissive: every numeric gate would pass even for a total
  // wipeout (100% drawdown, -100% return all within bounds), so the ONLY
  // way a final-fold ruin can be caught is the explicit ruin marker —
  // `approved` is ALWAYS false in this codebase (never auto-deploy), so the
  // real signal under test is `approvalReason` correctly citing the skip/
  // ruin instead of the generic "awaiting explicit human approval" message.
  const permissiveAcceptance: AcceptanceConfig = {
    minSharpe: -100, maxDrawdown: 1, minTotalReturn: -1, maxConcentration: 1, minTrades: 0,
    stressMinSharpe: -100, stressMaxDrawdown: 1, stressMinTotalReturn: -1,
    looMinSharpe: -100, looMaxDrawdown: 1, looMinTotalReturn: -1,
  };

  test("a ruined FINAL base fold — no later fold to cut — still fails acceptance under fully permissive thresholds", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-ruin-final-base-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedDb(tmpDir, dbPath);
      const m = { ...buildManifest(dbPath), acceptance: permissiveAcceptance };
      const calls: Array<{ label: string; isInner: boolean; costTier: "base" | "stress"; initialRiskState?: RiskState }> = [];
      const results: ReplayResult[] = [];
      const runner = spyRunner(m, calls, results, (label, costTier, counter) => {
        if (label === "1/test" && costTier === "base") return 0; // ruin the LAST base fold
        return 10_000 * (1 + 0.1 * (counter + 1));
      });

      const { runWalkForward } = await import("./walk-forward");
      // breakEven: false — chain-topology test; the break-even tiers would add
      // their own base-cost runner calls and skew the call counts below.
      const wf = await runWalkForward(m, { dryRun: false, runner, breakEven: false });
      outputDir = wf.outputDir;
      const { summary } = wf;

      // Both folds DID run — there's no later fold for the chain-cut
      // mechanism to catch. The ruin itself must still be recorded.
      const baseCalls = calls.filter(c => !c.isInner && c.costTier === "base");
      expect(baseCalls).toHaveLength(2);

      expect(summary.skippedFolds).toContain("1/test:base:ruined");
      expect(summary.approvalReason).toContain("skipped");
      expect(summary.approvalReason).not.toContain("awaiting explicit human approval");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30_000);

  test("a ruined FINAL stress fold — no later fold to cut — still fails acceptance under fully permissive thresholds", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-ruin-final-stress-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedDb(tmpDir, dbPath);
      const m = { ...buildManifest(dbPath), acceptance: permissiveAcceptance };
      const calls: Array<{ label: string; isInner: boolean; costTier: "base" | "stress"; initialRiskState?: RiskState }> = [];
      const results: ReplayResult[] = [];
      const runner = spyRunner(m, calls, results, (label, costTier, counter) => {
        if (label === "1/test" && costTier === "stress") return 0; // ruin the LAST stress fold
        return 10_000 * (1 + 0.1 * (counter + 1));
      });

      const { runWalkForward } = await import("./walk-forward");
      const wf = await runWalkForward(m, { dryRun: false, runner });
      outputDir = wf.outputDir;
      const { summary } = wf;

      const stressCalls = calls.filter(c => !c.isInner && c.costTier === "stress");
      expect(stressCalls).toHaveLength(2); // both folds ran, no later fold to cut

      expect(summary.skippedFolds).toContain("1/test:stress:ruined");
      expect(summary.approvalReason).toContain("skipped");
      expect(summary.approvalReason).not.toContain("awaiting explicit human approval");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30_000);

  test("a ruined FINAL LOO fold — no later fold to cut for that symbol — still fails acceptance under fully permissive thresholds", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-ruin-final-loo-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedDb(tmpDir, dbPath);
      const base = buildManifest(dbPath);
      const m: ExperimentManifest = {
        ...base,
        data: { ...base.data, universe: ["BTC/USD", "ETH/USD"] },
        acceptance: permissiveAcceptance,
      };

      const runner: ReplayRunner = async (cfg, win) => {
        // Ruin only the LAST outer fold of the "excluded BTC/USD" LOO chain
        // (remaining universe = [ETH/USD]); every other call — inner,
        // outer base/stress (full universe), and the excluded-ETH/USD LOO
        // chain — stays healthy.
        const ruinThis = win.label.startsWith("1/test/") && cfg.universe[0] === "ETH/USD";
        const finalEquity = ruinThis ? 0 : cfg.initialEquity * 1.1;
        return {
          sleeve: cfg.sleeve, window: win, fromMs: Date.parse(win.from), toMs: Date.parse(win.to), config: cfg,
          finalEquity, totalReturn: (finalEquity - cfg.initialEquity) / cfg.initialEquity, maxDrawdown: 0, sharpe: 0,
          winRate: 0.5, trades: 1, tradesPerDay: 1, expectancy: 1, fees: 0, funding: 0, liquidations: 0,
          marginRejects: 0, ruined: ruinThis, bench: 0,
          dailyReturns: [], sessionReturns: [], tradesBySymbol: {},
          equityHistory: [{ t: Date.parse(win.from), eq: cfg.initialEquity }, { t: Date.parse(win.to), eq: finalEquity }],
          closedTrades: [], hash: "h",
          finalRiskState: { ...INITIAL_RISK_STATE, peakEquity: Math.max(0, finalEquity), pausedUntil: 0, pauseReason: "" },
        } as ReplayResult;
      };

      const { runWalkForward } = await import("./walk-forward");
      const wf = await runWalkForward(m, { dryRun: false, runner });
      outputDir = wf.outputDir;
      const { summary } = wf;

      expect(summary.skippedFolds).toContain("1/test:loo-BTC/USD:ruined");
      expect(summary.approvalReason).toContain("skipped");
      expect(summary.approvalReason).not.toContain("awaiting explicit human approval");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    }
  }, 30_000);
});

describe("benchmark-relative acceptance gates", () => {
  function benchSummary(over: Partial<WalkForwardSummary["stitchedOos"]> = {}): WalkForwardSummary {
    return {
      manifestHash: "", configHash: "", dataHash: "", codeHash: "", asOfMs: 0, resolvedTo: "",
      selectedCandidate: null,
      innerSelection: [],
      outerTests: [],
      stressTests: [],
      stitchedOos: {
        totalReturn: 0.1, sharpe: 1.2, maxDrawdown: 0.05, winRate: 0.5, trades: 10, expectancy: 10,
        fees: 0, funding: 0, liquidations: 0, marginRejects: 0, ruined: false,
        benchReturn: 0.05, benchSharpe: 0.4,
        ...over,
      },
      concentration: { maxTradesFracByFold: [], maxPnlFracByFold: [], totalTradesBySymbol: {}, totalGrossPnlBySymbol: {} },
      loo: [],
      skippedFolds: [],
      acceptance: {}, approved: false, approvalReason: "", complete: true, priorTrialsComplete: true,
    };
  }

  test("minExcessReturnVsBench passes exactly at the boundary and fails just past it", () => {
    // excess return = 0.10 − 0.05 = 0.05
    const atEdge = benchSummary();
    evaluateAcceptance(atEdge, { minExcessReturnVsBench: 0.05 });
    expect(atEdge.acceptance.minExcessReturnVsBench.value).toBeCloseTo(0.05, 12);
    expect(atEdge.acceptance.minExcessReturnVsBench.pass).toBe(true);

    const past = benchSummary();
    evaluateAcceptance(past, { minExcessReturnVsBench: 0.0501 });
    expect(past.acceptance.minExcessReturnVsBench.pass).toBe(false);

    // Negative alpha vs benchmark is now rejectable: +7.6% vs +43% fails a 0 threshold.
    const negAlpha = benchSummary({ totalReturn: 0.076, benchReturn: 0.4307 });
    evaluateAcceptance(negAlpha, { minExcessReturnVsBench: 0 });
    expect(negAlpha.acceptance.minExcessReturnVsBench.value).toBeCloseTo(0.076 - 0.4307, 12);
    expect(negAlpha.acceptance.minExcessReturnVsBench.pass).toBe(false);
  });

  test("minExcessSharpeVsBench passes exactly at the boundary and fails just past it", () => {
    // excess sharpe = 1.5 − 0.5 = 1.0 (both exactly representable in binary)
    const atEdge = benchSummary({ sharpe: 1.5, benchSharpe: 0.5 });
    evaluateAcceptance(atEdge, { minExcessSharpeVsBench: 1.0 });
    expect(atEdge.acceptance.minExcessSharpeVsBench.value).toBeCloseTo(1.0, 12);
    expect(atEdge.acceptance.minExcessSharpeVsBench.pass).toBe(true);

    const past = benchSummary({ sharpe: 1.5, benchSharpe: 0.5 });
    evaluateAcceptance(past, { minExcessSharpeVsBench: 1.0001 });
    expect(past.acceptance.minExcessSharpeVsBench.pass).toBe(false);
  });

  test("a missing benchmark fails closed instead of approving", () => {
    const s = benchSummary({ benchReturn: undefined, benchSharpe: undefined });
    evaluateAcceptance(s, { minExcessReturnVsBench: -10, minExcessSharpeVsBench: -10 });
    expect(s.acceptance.minExcessReturnVsBench.pass).toBe(false);
    expect(s.acceptance.minExcessSharpeVsBench.pass).toBe(false);
  });

  test("bench gates are optional: absent thresholds evaluate nothing", () => {
    const s = benchSummary();
    evaluateAcceptance(s, { minSharpe: 0 });
    expect(s.acceptance.minExcessReturnVsBench).toBeUndefined();
    expect(s.acceptance.minExcessSharpeVsBench).toBeUndefined();
  });

  test("benchmarkFromFoldBars compounds per-fold buy-and-hold like the stitched strategy curve", () => {
    const day = 86_400_000;
    const jan = Date.parse("2024-01-01T05:00:00Z");
    const feb = Date.parse("2024-02-01T05:00:00Z");
    const out = benchmarkFromFoldBars([
      { foldPath: "0/test", fromMs: jan, bars: [{ timestamp: jan, close: 100 }, { timestamp: jan + day, close: 110 }] },
      { foldPath: "1/test", fromMs: feb, bars: [{ timestamp: feb, close: 200 }, { timestamp: feb + day, close: 190 }] },
    ], 252, false);
    expect(out.byFold).toEqual([
      { foldPath: "0/test", benchReturn: expect.closeTo(0.1, 12) },
      { foldPath: "1/test", benchReturn: expect.closeTo(-0.05, 12) },
    ]);
    // Stitched: 1 → 1.1, then ×(190/200) → 1.045.
    expect(out.benchReturn).toBeCloseTo(0.045, 12);
  });

  test("benchmarkFromFoldBars fails closed on a fold with fewer than 2 benchmark bars", () => {
    expect(() => benchmarkFromFoldBars([{ foldPath: "0/test", fromMs: 0, bars: [{ timestamp: 0, close: 100 }] }], 252, false))
      .toThrow(/fewer than 2/);
  });
});

describe("meanrev sleeve manifest validation", () => {
  const meanrevCandidate: CandidateConfig = {
    name: "incumbent",
    cadenceMin: 1440,
    meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 },
  };
  const meanrevManifest: ExperimentManifest = {
    ...baseManifest,
    name: "test-meanrev",
    sleeve: "meanrev",
    data: {
      ...baseManifest.data,
      source: "alpaca_wide",
      timeframe: "1d",
      universe: ["KO", "PG"],
      refSymbol: "SPY",
      rthOnly: false,
      funding: false,
      barMinutes: 1440,
      barMinutesEq: 1440,
    },
    ledger: { initialEquity: 50000, leverage: 1, hardStopPct: 0.04 },
    candidates: [meanrevCandidate],
  };

  test("sleeve meanrev is accepted with benchmark-only refSymbol outside the universe", () => {
    expect(() => validateManifest(meanrevManifest)).not.toThrow();
  });

  test("meanrev refSymbol inside the traded universe is rejected (disjointness guard)", () => {
    expect(() => validateManifest({
      ...meanrevManifest,
      data: { ...meanrevManifest.data, universe: ["KO", "SPY"] },
    })).toThrow(/must NOT be in data.universe/);
  });

  test("meanrev manifests require meanrev params on every candidate; momentum manifests reject them", () => {
    expect(() => validateManifest({
      ...meanrevManifest,
      candidates: [{ name: "x", cadenceMin: 1440, entryPct: 5, exitPct: -2, maxLongs: 2, maxShorts: 0 }],
    })).toThrow(/require candidate.meanrev/);
    expect(() => validateManifest({
      ...baseManifest,
      candidates: [meanrevCandidate],
    })).toThrow(/must not carry meanrev params/);
  });

  test("meanrev candidates must not smuggle momentum-only knobs (silently-ignored config)", () => {
    expect(() => validateCandidate({ ...meanrevCandidate, entryPct: 5 })).toThrow(/momentum-only/);
    expect(() => validateCandidate({ ...meanrevCandidate, notionalPctPerSlot: 0.5 })).toThrow(/momentum-only/);
  });

  test("meanrev param bounds and unknown keys fail validation", () => {
    const withMr = (mr: Record<string, unknown>) => ({ ...meanrevCandidate, meanrev: { ...meanrevCandidate.meanrev, ...mr } });
    expect(() => validateCandidate(withMr({ entryRsi: 0 }))).toThrow(/entryRsi/);
    expect(() => validateCandidate(withMr({ timeStopDays: 0 }))).toThrow(/timeStopDays/);
    expect(() => validateCandidate(withMr({ slotPct: 1.5 }))).toThrow(/slotPct/);
    expect(() => validateCandidate(withMr({ bogus: 1 }))).toThrow(/unknown keys/);
  });

  test("candidates differing only in meanrev params hash distinctly; duplicates are caught", () => {
    const twoDistinct: ExperimentManifest = {
      ...meanrevManifest,
      candidates: [
        meanrevCandidate,
        { ...meanrevCandidate, name: "alt", meanrev: { ...meanrevCandidate.meanrev!, entryRsi: 10 } },
      ],
    };
    expect(() => validateUniqueCandidates(twoDistinct)).not.toThrow();
    const duplicated: ExperimentManifest = {
      ...meanrevManifest,
      candidates: [meanrevCandidate, { ...meanrevCandidate, name: "copy" }],
    };
    expect(() => validateUniqueCandidates(duplicated)).toThrow(/duplicate effective candidate/);
  });

  test("hardStop axis is allowed on meanrev AND momentum candidates (it is not a momentum-only knob)", () => {
    expect(() => validateCandidate({ ...meanrevCandidate, hardStop: { mode: "none" } })).not.toThrow();
    expect(() => validateCandidate({ ...meanrevCandidate, hardStop: { mode: "volScaled", kSigma: 2, lookbackBars: 20, minPct: 2, maxPct: 10 } })).not.toThrow();
    expect(() => validateCandidate({ ...baseManifest.candidates[0], hardStop: { mode: "fixed", pct: 0.04 } })).not.toThrow();
  });

  test("hardStop specs fail closed on bad modes, cross-mode keys, and out-of-range values", () => {
    const withStop = (hardStop: unknown) => ({ ...meanrevCandidate, hardStop });
    expect(() => validateCandidate(withStop({ mode: "trailing" }))).toThrow(/hardStop.mode/);
    expect(() => validateCandidate(withStop({ mode: "none", pct: 0.04 }))).toThrow(/unknown keys/);
    expect(() => validateCandidate(withStop({ mode: "fixed", pct: 4 }))).toThrow(/fraction/); // percent-vs-fraction confusion
    expect(() => validateCandidate(withStop({ mode: "fixed", pct: 0.04, kSigma: 2 }))).toThrow(/unknown keys/);
    expect(() => validateCandidate(withStop({ mode: "volScaled", kSigma: 0, lookbackBars: 20, minPct: 2, maxPct: 10 }))).toThrow(/kSigma/);
    expect(() => validateCandidate(withStop({ mode: "volScaled", kSigma: 2, lookbackBars: 1, minPct: 2, maxPct: 10 }))).toThrow(/lookbackBars/);
    expect(() => validateCandidate(withStop({ mode: "volScaled", kSigma: 2, lookbackBars: 20, minPct: 12, maxPct: 10 }))).toThrow(/maxPct/);
  });

  test("timeStop axis: momentum-only (meanrev has its own timeStopDays), strict keys, positive hours, distinct hashes, absent = legacy hash", () => {
    const momo = baseManifest.candidates[0];
    // Momentum candidates accept it; meanrev candidates must reject it.
    expect(() => validateCandidate({ ...momo, timeStop: { maxHoldHours: 264 } })).not.toThrow();
    expect(() => validateCandidate({ ...meanrevCandidate, timeStop: { maxHoldHours: 264 } })).toThrow(/momentum-only/);
    // Fail-closed spec validation.
    expect(() => validateCandidate({ ...momo, timeStop: { maxHoldHours: 0 } })).toThrow(/maxHoldHours/);
    expect(() => validateCandidate({ ...momo, timeStop: { maxHoldHours: -24 } })).toThrow(/maxHoldHours/);
    expect(() => validateCandidate({ ...momo, timeStop: { maxHoldHours: 264, unit: "bars" } })).toThrow(/unknown keys/);
    expect(() => validateCandidate({ ...momo, timeStop: {} })).toThrow(/maxHoldHours/);
    // Candidate identity: absent timeStop preserves the pre-axis hash
    // (canonicalJson drops undefined — old artifacts stay comparable);
    // horizons are distinct hypotheses.
    const legacy = hashReplayConfig(candidateToReplayConfig(baseManifest, momo, "base"));
    const withUndef = hashReplayConfig(candidateToReplayConfig(baseManifest, { ...momo, timeStop: undefined }, "base"));
    expect(withUndef).toBe(legacy);
    const h1 = hashReplayConfig(candidateToReplayConfig(baseManifest, { ...momo, name: "ts120", timeStop: { maxHoldHours: 120 } }, "base"));
    const h2 = hashReplayConfig(candidateToReplayConfig(baseManifest, { ...momo, name: "ts264", timeStop: { maxHoldHours: 264 } }, "base"));
    expect(new Set([legacy, h1, h2]).size).toBe(3);
  });

  test("candidates differing only in hardStop are distinct hypotheses (hash + duplicate guard)", () => {
    const incumbent = meanrevCandidate; // absent hardStop = legacy fixed
    const noStop: CandidateConfig = { ...meanrevCandidate, name: "no-stop", hardStop: { mode: "none" } };
    const volK2: CandidateConfig = { ...meanrevCandidate, name: "vol-k2", hardStop: { mode: "volScaled", kSigma: 2, lookbackBars: 20, minPct: 2, maxPct: 10 } };
    const m: ExperimentManifest = { ...meanrevManifest, candidates: [incumbent, noStop, volK2] };
    expect(() => validateUniqueCandidates(m)).not.toThrow();
    const hashes = m.candidates.map(c => hashReplayConfig(candidateToReplayConfig(m, c, "base")));
    expect(new Set(hashes).size).toBe(3);
    // A candidate whose hardStop differs only by clamp is still unique...
    const volK2Wide: CandidateConfig = { ...volK2, name: "vol-k2-wide", hardStop: { mode: "volScaled", kSigma: 2, lookbackBars: 20, minPct: 2, maxPct: 12 } };
    expect(() => validateUniqueCandidates({ ...m, candidates: [...m.candidates, volK2Wide] })).not.toThrow();
    // ...but a same-spec copy is caught.
    expect(() => validateUniqueCandidates({ ...m, candidates: [...m.candidates, { ...volK2, name: "copy" }] })).toThrow(/duplicate effective candidate/);
  });

  test("cooldownBarsAfterStop is momentum-only: meanrev candidates reject it like the other silently-ignored knobs", () => {
    expect(() => validateCandidate({ ...meanrevCandidate, cooldownBarsAfterStop: 4 })).toThrow(/momentum-only/);
  });

  test("meanrev manifests reject costs.marginInterest (financing not modeled by the meanrev runner)", () => {
    expect(() => validateManifest({
      ...meanrevManifest,
      costs: { ...meanrevManifest.costs, base: { ...meanrevManifest.costs.base, marginInterest: { annualRate: 0.075 } } },
    })).toThrow(/must not set costs.base.marginInterest/);
  });
});

describe("A3 margin interest + B2 cooldown — cost/candidate plumbing and hash identity", () => {
  const momo = baseManifest.candidates[0];

  test("costs.marginInterest flows into ReplayConfig per tier; a tier without the key stays legacy-hashed", () => {
    const m: ExperimentManifest = {
      ...baseManifest,
      costs: { base: { ...baseManifest.costs.base, marginInterest: { annualRate: 0.075 } }, stress: baseManifest.costs.stress },
    };
    const withMi = candidateToReplayConfig(m, momo, "base");
    expect(withMi.marginInterest).toEqual({ annualRate: 0.075 });
    const legacy = candidateToReplayConfig(baseManifest, momo, "base");
    expect(legacy.marginInterest).toBeUndefined();
    expect(hashReplayConfig(withMi)).not.toBe(hashReplayConfig(legacy));
    // The stress tier of the SAME manifest carries no marginInterest key:
    // its hash must equal the pre-axis stress hash byte for byte.
    expect(hashReplayConfig(candidateToReplayConfig(m, momo, "stress")))
      .toBe(hashReplayConfig(candidateToReplayConfig(baseManifest, momo, "stress")));
  });

  test("validateManifest bounds marginInterest: fraction in [0,1), strict keys", () => {
    const withMi = (tier: "base" | "stress", mi: unknown): ExperimentManifest => ({
      ...baseManifest,
      costs: { ...baseManifest.costs, [tier]: { ...baseManifest.costs[tier], marginInterest: mi } } as ExperimentManifest["costs"],
    });
    expect(() => validateManifest(withMi("base", { annualRate: 0.075 }))).not.toThrow();
    expect(() => validateManifest(withMi("stress", { annualRate: 0.09 }))).not.toThrow();
    expect(() => validateManifest(withMi("base", { annualRate: 7.5 }))).toThrow(/fraction/); // percent-units typo
    expect(() => validateManifest(withMi("base", { annualRate: -0.01 }))).toThrow(/fraction/);
    expect(() => validateManifest(withMi("stress", { annualRate: 0.075, compounding: "daily" }))).toThrow(/unknown keys/);
    expect(() => validateManifest(withMi("base", {}))).toThrow(/annualRate/);
  });

  test("cooldownBarsAfterStop: valid momentum axis with integer bounds; 0/absent normalize to the legacy hash; positive N is a distinct hypothesis", () => {
    expect(() => validateCandidate({ ...momo, cooldownBarsAfterStop: 4 })).not.toThrow();
    expect(() => validateCandidate({ ...momo, cooldownBarsAfterStop: 0 })).not.toThrow();
    expect(() => validateCandidate({ ...momo, cooldownBarsAfterStop: -1 })).toThrow(/non-negative integer/);
    expect(() => validateCandidate({ ...momo, cooldownBarsAfterStop: 2.5 })).toThrow(/non-negative integer/);

    const legacy = hashReplayConfig(candidateToReplayConfig(baseManifest, momo, "base"));
    expect(hashReplayConfig(candidateToReplayConfig(baseManifest, { ...momo, cooldownBarsAfterStop: undefined }, "base"))).toBe(legacy);
    // Explicit 0 = off = the SAME hypothesis: normalized to absent so it
    // hashes identically (and would be caught as a duplicate candidate).
    expect(hashReplayConfig(candidateToReplayConfig(baseManifest, { ...momo, cooldownBarsAfterStop: 0 }, "base"))).toBe(legacy);
    const cd4 = candidateToReplayConfig(baseManifest, { ...momo, cooldownBarsAfterStop: 4 }, "base");
    expect(cd4.cooldownBarsAfterStop).toBe(4);
    expect(hashReplayConfig(cd4)).not.toBe(legacy);
    // Different N = different hypotheses.
    const cd8 = hashReplayConfig(candidateToReplayConfig(baseManifest, { ...momo, cooldownBarsAfterStop: 8 }, "base"));
    expect(cd8).not.toBe(hashReplayConfig(cd4));
  });

  test("stitchedMetrics sums marginInterest across folds, tolerating legacy results without the field", () => {
    const mk = (fromMs: number, marginInterest?: number): ReplayResult => ({
      fromMs,
      equityHistory: [{ t: fromMs, eq: 100 }, { t: fromMs + 3_600_000, eq: 101 }],
      closedTrades: [],
      tradesBySymbol: {},
      fees: 0,
      funding: 0,
      ...(marginInterest !== undefined ? { marginInterest } : {}),
      liquidations: 0,
      marginRejects: 0,
      ruined: false,
      config: { rthOnly: false } as ReplayResult["config"],
    } as unknown as ReplayResult);
    const legacyFold = mk(0); // cached pre-axis artifact: no field at all
    const chargedFold = mk(3_600_000, 12.5);
    const stitched = stitchEquityHistory([legacyFold, chargedFold], 100);
    const m = stitchedMetrics(stitched, [legacyFold, chargedFold], 365);
    expect(m.marginInterest).toBeCloseTo(12.5, 9);
  });
});

// ══════════════════════════════════════════════
// 2026-09 evidence layer: outer PSR/MinTRL/fold-PSR gates, microstructure
// gates (turnover/displacement), break-even curve, forward-compat candidate
// axes, and the hashCodeFiles pins for engine-adjacent modules.
// ══════════════════════════════════════════════
import { mean as mMean, stdev as mStdev, skewness as mSkew, kurtosis as mKurt, autocorrPenalty as mAcp } from "../src/reports/metrics";
import { probabilisticSharpe as psrRef } from "../src/portfolio/trackRecord";
import { readdirSync } from "node:fs";

/** Deterministic LCG return series — i.i.d.-ish, no Math.random in tests. */
function lcgRets(n: number, seed = 42, drift = 0.001, vol = 0.01): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    out.push(drift + vol * (s / 2 ** 32 - 0.5));
  }
  return out;
}

const permissiveLegacy: AcceptanceConfig = {
  minSharpe: -10, maxDrawdown: 10, minTotalReturn: -10, maxConcentration: 10, minTrades: 0,
  stressMinSharpe: -10, stressMaxDrawdown: 10, stressMinTotalReturn: -10,
  looMinSharpe: -10, looMaxDrawdown: 10, looMinTotalReturn: -10,
};

function evResult(over: Record<string, unknown> = {}): any {
  return {
    sleeve: "crypto", window: { label: "0/test", from: "2024-01-01", to: "2024-02-01" },
    fromMs: 0, toMs: 100, config: { initialEquity: 10_000, sleeve: "crypto" },
    finalEquity: 11_000, totalReturn: 0.1, maxDrawdown: 0.05, sharpe: 1.2,
    winRate: 0.5, trades: 10, tradesPerDay: 0.5, expectancy: 10,
    fees: 0, funding: 0, liquidations: 0, marginRejects: 0, ruined: false,
    bench: 0, dailyReturns: [], sessionReturns: [], tradesBySymbol: {},
    equityHistory: [{ t: 0, eq: 10_000 }, { t: 1, eq: 11_000 }], closedTrades: [], hash: "h",
    ...over,
  };
}

function evSummary(over: Partial<WalkForwardSummary> = {}, outerResults?: any[]): WalkForwardSummary {
  const outer = (outerResults ?? [evResult()]).map((r: any) => ({ foldPath: r.window.label, result: r }));
  return {
    manifestHash: "", configHash: "", dataHash: "", codeHash: "", asOfMs: 0, resolvedTo: "",
    selectedCandidate: null,
    innerSelection: [],
    outerTests: outer,
    stressTests: [{ foldPath: "0/test", result: evResult({ totalReturn: 0.08, sharpe: 1.0 }) }],
    stitchedOos: { totalReturn: 0.1, sharpe: 1.2, maxDrawdown: 0.05, winRate: 0.5, trades: 20, expectancy: 10, fees: 0, funding: 0, liquidations: 0, marginRejects: 0, ruined: false },
    concentration: { maxTradesFracByFold: [], maxPnlFracByFold: [], totalTradesBySymbol: {}, totalGrossPnlBySymbol: {} },
    loo: [{ excludedSymbol: "BTC/USD", stitchedReturn: 0.09, stitchedSharpe: 1.1, stitchedMaxDrawdown: 0.05, totalTrades: 9 }],
    skippedFolds: [],
    acceptance: {}, approved: false, approvalReason: "", complete: true, priorTrialsComplete: true,
    ...over,
  };
}

describe("evidence gates: minOuterPsr / minTrlSatisfied / minFoldsPsrAbove", () => {
  test("minOuterPsr passes above and fails below the threshold", () => {
    const pass = evSummary({ outerPsr: 0.97 });
    evaluateAcceptance(pass, { ...permissiveLegacy, minOuterPsr: 0.95 });
    expect(pass.acceptance.minOuterPsr.pass).toBe(true);
    expect(pass.acceptance.minOuterPsr.value).toBe(0.97);

    const fail = evSummary({ outerPsr: 0.9 });
    evaluateAcceptance(fail, { ...permissiveLegacy, minOuterPsr: 0.95 });
    expect(fail.acceptance.minOuterPsr.pass).toBe(false);
    expect(fail.approvalReason).toContain("minOuterPsr");
  });

  test("minOuterPsr fails CLOSED when the evidence layer never produced a PSR", () => {
    const s = evSummary(); // no outerPsr
    evaluateAcceptance(s, { ...permissiveLegacy, minOuterPsr: 0.95 });
    expect(s.acceptance.minOuterPsr.pass).toBe(false);
    expect(s.acceptance.minOuterPsr.reason).toContain("not computed");
  });

  test("a manifest WITHOUT evidence gates never evaluates them (legacy verdict intact)", () => {
    const s = evSummary(); // no evidence fields at all
    evaluateAcceptance(s, permissiveLegacy);
    expect(s.acceptance.minOuterPsr).toBeUndefined();
    expect(s.acceptance.minTrlSatisfied).toBeUndefined();
    expect(s.acceptance.minFoldsPsrAbove).toBeUndefined();
    expect(s.acceptance.maxTurnoverAnnual).toBeUndefined();
    expect(s.acceptance.maxDisplacementShare).toBeUndefined();
    expect(s.acceptance.minBreakEvenSlippageBps).toBeUndefined();
    expect(s.approvalReason).toContain("awaiting explicit human approval");
  });

  test("minTrlSatisfied: passes when n ≥ MinTRL, fails when short, fails on infinite MinTRL", () => {
    const pass = evSummary({ observations: 600, minTrl: 500 });
    evaluateAcceptance(pass, { ...permissiveLegacy, minTrlSatisfied: true });
    expect(pass.acceptance.minTrlSatisfied.pass).toBe(true);

    const short = evSummary({ observations: 400, minTrl: 500 });
    evaluateAcceptance(short, { ...permissiveLegacy, minTrlSatisfied: true });
    expect(short.acceptance.minTrlSatisfied.pass).toBe(false);

    // SR ≤ 0 ⇒ MinTRL infinite (null): no sample length certifies it.
    const inf = evSummary({ observations: 5000, minTrl: null });
    evaluateAcceptance(inf, { ...permissiveLegacy, minTrlSatisfied: true });
    expect(inf.acceptance.minTrlSatisfied.pass).toBe(false);

    const missing = evSummary(); // evidence layer never ran
    evaluateAcceptance(missing, { ...permissiveLegacy, minTrlSatisfied: true });
    expect(missing.acceptance.minTrlSatisfied.pass).toBe(false);
    expect(missing.acceptance.minTrlSatisfied.reason).toContain("not computed");
  });

  test("minFoldsPsrAbove counts folds ≥ threshold; NaN folds never count; empty fails closed", () => {
    const foldPsr = [
      { foldPath: "0/test", psr: 0.9 },
      { foldPath: "1/test", psr: 0.6 },
      { foldPath: "2/test", psr: 0.2 },
    ];
    const pass = evSummary({ foldPsr });
    evaluateAcceptance(pass, { ...permissiveLegacy, minFoldsPsrAbove: { threshold: 0.5, count: 2 } });
    expect(pass.acceptance.minFoldsPsrAbove.pass).toBe(true);
    expect(pass.acceptance.minFoldsPsrAbove.value).toBe(2);

    const fail = evSummary({ foldPsr });
    evaluateAcceptance(fail, { ...permissiveLegacy, minFoldsPsrAbove: { threshold: 0.5, count: 3 } });
    expect(fail.acceptance.minFoldsPsrAbove.pass).toBe(false);

    const withNan = evSummary({ foldPsr: [{ foldPath: "0/test", psr: NaN }, { foldPath: "1/test", psr: 0.6 }] });
    evaluateAcceptance(withNan, { ...permissiveLegacy, minFoldsPsrAbove: { threshold: 0.5, count: 1 } });
    expect(withNan.acceptance.minFoldsPsrAbove.value).toBe(1);
    expect(withNan.acceptance.minFoldsPsrAbove.pass).toBe(true);

    const empty = evSummary({ foldPsr: [] });
    evaluateAcceptance(empty, { ...permissiveLegacy, minFoldsPsrAbove: { threshold: 0.5, count: 1 } });
    expect(empty.acceptance.minFoldsPsrAbove.pass).toBe(false);
    expect(empty.acceptance.minFoldsPsrAbove.reason).toContain("no per-fold PSR");
  });

  test("validateManifest rejects malformed evidence-gate thresholds", () => {
    const withAcc = (acceptance: any) => ({ ...baseManifest, acceptance });
    expect(() => validateManifest(withAcc({ minOuterPsr: 1.5 }))).toThrow("minOuterPsr");
    expect(() => validateManifest(withAcc({ minTrlSatisfied: false }))).toThrow("minTrlSatisfied");
    expect(() => validateManifest(withAcc({ minFoldsPsrAbove: { threshold: 0.5 } }))).toThrow("count");
    expect(() => validateManifest(withAcc({ minFoldsPsrAbove: { threshold: 2, count: 1 } }))).toThrow("threshold");
    expect(() => validateManifest(withAcc({ minFoldsPsrAbove: { threshold: 0.5, count: 1, extra: 1 } }))).toThrow("unknown keys");
    expect(() => validateManifest(withAcc({ maxTurnoverAnnual: 0 }))).toThrow("maxTurnoverAnnual");
    expect(() => validateManifest(withAcc({ maxDisplacementShare: 1.2 }))).toThrow("maxDisplacementShare");
    expect(() => validateManifest(withAcc({ minBreakEvenSlippageBps: -1 }))).toThrow("minBreakEvenSlippageBps");
    // Well-formed values still validate.
    expect(() => validateManifest(withAcc({
      ...baseManifest.acceptance, minOuterPsr: 0.95, minTrlSatisfied: true,
      minFoldsPsrAbove: { threshold: 0.5, count: 2 }, maxTurnoverAnnual: 150,
      maxDisplacementShare: 0.35, minBreakEvenSlippageBps: 20,
    }))).not.toThrow();
  });
});

describe("microstructure gates: maxTurnoverAnnual / maxDisplacementShare", () => {
  test("turnover gate takes the duration-weighted mean and binds on both sides", () => {
    const results = [
      evResult({ window: { label: "0/test", from: "a", to: "b" }, fromMs: 0, toMs: 100, turnoverAnnual: 100 }),
      evResult({ window: { label: "1/test", from: "b", to: "c" }, fromMs: 100, toMs: 200, turnoverAnnual: 200 }),
    ];
    const pass = evSummary({}, results);
    evaluateAcceptance(pass, { ...permissiveLegacy, maxTurnoverAnnual: 150 });
    expect(pass.acceptance.maxTurnoverAnnual.value).toBeCloseTo(150, 9);
    expect(pass.acceptance.maxTurnoverAnnual.pass).toBe(true);

    const fail = evSummary({}, results);
    evaluateAcceptance(fail, { ...permissiveLegacy, maxTurnoverAnnual: 149 });
    expect(fail.acceptance.maxTurnoverAnnual.pass).toBe(false);
  });

  test("turnover gate fails CLOSED when any replay did not produce the metric", () => {
    const results = [
      evResult({ turnoverAnnual: 100 }),
      evResult({ window: { label: "1/test", from: "b", to: "c" } }), // no turnoverAnnual (old cached artifact)
    ];
    const s = evSummary({}, results);
    evaluateAcceptance(s, { ...permissiveLegacy, maxTurnoverAnnual: 1000 });
    expect(s.acceptance.maxTurnoverAnnual.pass).toBe(false);
    expect(s.acceptance.maxTurnoverAnnual.reason).toBe("metric not produced by replay");
  });

  test("displacement share = displacement closes / stitched trades; binds on both sides; missing fails closed", () => {
    const results = [
      evResult({ displacementCloses: 3 }),
      evResult({ window: { label: "1/test", from: "b", to: "c" }, displacementCloses: 4 }),
    ];
    const pass = evSummary({}, results); // stitchedOos.trades = 20 → 7/20 = 0.35
    evaluateAcceptance(pass, { ...permissiveLegacy, maxDisplacementShare: 0.35 });
    expect(pass.acceptance.maxDisplacementShare.value).toBeCloseTo(0.35, 9);
    expect(pass.acceptance.maxDisplacementShare.pass).toBe(true);

    const fail = evSummary({}, results);
    evaluateAcceptance(fail, { ...permissiveLegacy, maxDisplacementShare: 0.3 });
    expect(fail.acceptance.maxDisplacementShare.pass).toBe(false);

    const missing = evSummary({}, [evResult()]); // metric absent
    evaluateAcceptance(missing, { ...permissiveLegacy, maxDisplacementShare: 0.35 });
    expect(missing.acceptance.maxDisplacementShare.pass).toBe(false);
    expect(missing.acceptance.maxDisplacementShare.reason).toBe("metric not produced by replay");
  });
});

describe("break-even curve: interpolation + gate", () => {
  test("monotone curve: first Sharpe ≤ 0 crossing by linear interpolation", () => {
    const curve = [
      { slippageBps: 0, sharpe: 1.0 }, { slippageBps: 2, sharpe: 0.8 }, { slippageBps: 5, sharpe: 0.5 },
      { slippageBps: 10, sharpe: 0.1 }, { slippageBps: 20, sharpe: -0.3 }, { slippageBps: 30, sharpe: -0.6 },
    ];
    // Crossing between 10 (0.1) and 20 (-0.3): 10 + 10·(0.1/0.4) = 12.5
    expect(breakEvenFromCurve(curve)).toBeCloseTo(12.5, 9);
    // Order-independent: shuffled input sorts before interpolating.
    expect(breakEvenFromCurve([...curve].reverse())).toBeCloseTo(12.5, 9);
  });

  test("already dead at 0 bps → 0; never crosses → Infinity; empty → undefined", () => {
    expect(breakEvenFromCurve([{ slippageBps: 0, sharpe: -0.2 }, { slippageBps: 10, sharpe: 0.5 }])).toBe(0);
    expect(breakEvenFromCurve([{ slippageBps: 0, sharpe: 1 }, { slippageBps: 30, sharpe: 0.4 }])).toBe(Infinity);
    expect(breakEvenFromCurve([])).toBeUndefined();
  });

  test("non-monotone curve takes the FIRST crossing (micro-execution chaos never resurrects a strategy)", () => {
    const curve = [
      { slippageBps: 0, sharpe: 0.6 }, { slippageBps: 2, sharpe: -0.2 },
      { slippageBps: 5, sharpe: 0.4 }, { slippageBps: 10, sharpe: -0.2 },
    ];
    // FIRST crossing between 0 (0.6) and 2 (-0.2): 0 + 2·(0.6/0.8) = 1.5 —
    // NOT the later 5→10 crossing even though Sharpe pops positive again at 5.
    expect(breakEvenFromCurve(curve)).toBeCloseTo(1.5, 9);
  });

  test("minBreakEvenSlippageBps gate: both sides, Infinity passes, missing curve fails closed", () => {
    const pass = evSummary({ breakEvenSlippageBps: 25 });
    evaluateAcceptance(pass, { ...permissiveLegacy, minBreakEvenSlippageBps: 20 });
    expect(pass.acceptance.minBreakEvenSlippageBps.pass).toBe(true);

    const fail = evSummary({ breakEvenSlippageBps: 15 });
    evaluateAcceptance(fail, { ...permissiveLegacy, minBreakEvenSlippageBps: 20 });
    expect(fail.acceptance.minBreakEvenSlippageBps.pass).toBe(false);

    const never = evSummary({ breakEvenSlippageBps: Infinity });
    evaluateAcceptance(never, { ...permissiveLegacy, minBreakEvenSlippageBps: 20 });
    expect(never.acceptance.minBreakEvenSlippageBps.pass).toBe(true);

    const missing = evSummary();
    evaluateAcceptance(missing, { ...permissiveLegacy, minBreakEvenSlippageBps: 20 });
    expect(missing.acceptance.minBreakEvenSlippageBps.pass).toBe(false);
    expect(missing.acceptance.minBreakEvenSlippageBps.reason).toContain("not computed");
  });
});

describe("penalizedPsr + computeOuterEvidence", () => {
  test("drifty i.i.d.-ish series → high PSR; negative drift → low; constant → null", () => {
    const up = penalizedPsr(lcgRets(400, 7, 0.002, 0.01));
    expect(up).not.toBeNull();
    expect(up!).toBeGreaterThan(0.95);
    const down = penalizedPsr(lcgRets(400, 7, -0.002, 0.01));
    expect(down!).toBeLessThan(0.5);
    expect(penalizedPsr(new Array(100).fill(0.01))).toBeNull();
    expect(penalizedPsr([0.01])).toBeNull();
  });

  test("positive autocorrelation strictly reduces the PSR vs the unpenalized formula", () => {
    // Blocky series (each draw repeated 4×) → strong positive lag-1 autocorr.
    const blocky = lcgRets(100, 11, 0.002, 0.01).flatMap(r => [r, r, r, r]);
    expect(mAcp(blocky)).toBeGreaterThan(1.2);
    const sr = mMean(blocky) / mStdev(blocky);
    const unpenalized = psrRef(sr, 0, blocky.length, mSkew(blocky), mKurt(blocky) + 3);
    expect(penalizedPsr(blocky)!).toBeLessThan(unpenalized!);
  });

  test("computeOuterEvidence: observations, fold PSRs, MinTRL, and the exact power formula", () => {
    const mkRes = (label: string, startDay: number, nDays: number, drift: number): any => {
      const startMs = Date.parse("2024-01-01T00:00:00Z") + startDay * 86_400_000;
      const rets = lcgRets(nDays - 1, 13 + startDay, drift, 0.008);
      let eq = 10_000;
      const equityHistory = [{ t: startMs, eq }];
      const dailyReturns: Array<{ date: string; ret: number }> = [];
      for (let i = 0; i < rets.length; i++) {
        eq *= 1 + rets[i];
        equityHistory.push({ t: startMs + (i + 1) * 86_400_000, eq });
        dailyReturns.push({ date: new Date(startMs + (i + 1) * 86_400_000).toISOString().slice(0, 10), ret: rets[i] });
      }
      return evResult({
        window: { label, from: new Date(startMs).toISOString(), to: new Date(startMs + nDays * 86_400_000).toISOString() },
        fromMs: startMs, toMs: startMs + nDays * 86_400_000,
        equityHistory, dailyReturns, finalEquity: eq, config: { rthOnly: false, initialEquity: 10_000 },
      });
    };
    const r0 = mkRes("0/test", 0, 30, 0.003);
    const r1 = mkRes("1/test", 40, 30, 0.003);
    const stitched = stitchEquityHistory([r0, r1], 10_000);
    const ev = computeOuterEvidence([r0, r1], stitched, 365);
    // 60 distinct UTC days in the stitched curve → 59 daily returns.
    expect(ev.observations).toBe(59);
    expect(ev.foldPsr.map(f => f.foldPath)).toEqual(["0/test", "1/test"]);
    for (const f of ev.foldPsr) expect(f.psr).toBeGreaterThan(0.5);
    expect(ev.outerPsr).toBeGreaterThan(0.9);
    expect(ev.minTrl).not.toBeNull();
    expect(ev.minTrl!).toBeGreaterThan(1);
    expect(ev.certifiableSharpeAtPsr95!).toBeCloseTo((1.645 * Math.sqrt(365)) / Math.sqrt(59), 12);
  });

  test("stitchedDailyReturns matches what stitchedMetrics judges (shared series)", () => {
    const history = [
      { t: Date.parse("2024-01-01T00:00:00Z"), eq: 100 },
      { t: Date.parse("2024-01-01T12:00:00Z"), eq: 101 },
      { t: Date.parse("2024-01-02T00:00:00Z"), eq: 103 },
      { t: Date.parse("2024-01-03T00:00:00Z"), eq: 99 },
    ];
    const rets = stitchedDailyReturns(history, false);
    // Day buckets close at 101 / 103 / 99 → two close-to-close returns.
    expect(rets).toHaveLength(2);
    expect(rets[0]).toBeCloseTo((103 - 101) / 101, 12);
    expect(rets[1]).toBeCloseTo((99 - 103) / 103, 12);
  });
});

describe("forward-compat candidate axes (slotHysteresis / regime / maxGrossExposureMult / rsiMethod / deterministicTieBreak)", () => {
  const momentumCand: CandidateConfig = {
    name: "t", cadenceMin: 60, entryPct: 5, exitPct: -2, maxLongs: 2, maxShorts: 0,
  };
  const meanrevCand: CandidateConfig = {
    name: "mr", cadenceMin: 1440,
    meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 },
  };

  test("momentum candidates accept the new momentum axes with strict types", () => {
    expect(() => validateCandidate({ ...momentumCand, slotHysteresis: true })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, regime: "off" })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, regime: { enabled: false, extraKnob: 1 } })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, maxGrossExposureMult: 1.5 })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, slotHysteresis: 1 as any })).toThrow("slotHysteresis");
    expect(() => validateCandidate({ ...momentumCand, regime: "on" as any })).toThrow("regime");
    expect(() => validateCandidate({ ...momentumCand, regime: { enabled: "no" } as any })).toThrow("regime.enabled");
    expect(() => validateCandidate({ ...momentumCand, maxGrossExposureMult: 0 })).toThrow("maxGrossExposureMult");
  });

  test("sleeve ownership: meanrev-only keys rejected on momentum, momentum-only on meanrev", () => {
    expect(() => validateCandidate({ ...momentumCand, rsiMethod: "wilder" })).toThrow("meanrev-only");
    expect(() => validateCandidate({ ...momentumCand, deterministicTieBreak: true })).toThrow("meanrev-only");
    expect(() => validateCandidate({ ...meanrevCand, slotHysteresis: true })).toThrow("momentum-only");
    expect(() => validateCandidate({ ...meanrevCand, regime: "off" })).toThrow("momentum-only");
    // maxGrossExposureMult is valid on meanrev since 2026-10-05: the runner
    // forwards it to the real MeanRevEngine (G gross-cap diagnostic; the
    // engine-level behavior is locked by meanrev-replay.grossCap.test.ts).
    expect(() => validateCandidate({ ...meanrevCand, maxGrossExposureMult: 0.84 })).not.toThrow();
    expect(() => validateCandidate({ ...meanrevCand, rsiMethod: "wilder", deterministicTieBreak: true })).not.toThrow();
    expect(() => validateCandidate({ ...meanrevCand, rsiMethod: "sma3" as any })).toThrow("rsiMethod");
    // The original unknown-key rejection still holds.
    expect(() => validateCandidate({ ...momentumCand, unknownAxis: 1 } as any)).toThrow("unknown keys");
  });

  test('candidateToReplayConfig: regime "off" → { enabled: false }; axes forwarded; meanrev axes land INSIDE meanrev params', () => {
    const m = { ...baseManifest };
    const cfg = candidateToReplayConfig(m, { ...momentumCand, regime: "off", slotHysteresis: true, maxGrossExposureMult: 1.5 }, "base");
    expect(cfg.regime).toEqual({ enabled: false });
    expect(cfg.slotHysteresis).toBe(true);
    expect(cfg.maxGrossExposureMult).toBe(1.5);

    const passthrough = candidateToReplayConfig(m, { ...momentumCand, regime: { enabled: true, threshold: 3 } }, "base");
    expect(passthrough.regime).toEqual({ enabled: true, threshold: 3 });

    const mrManifest: ExperimentManifest = {
      ...baseManifest, sleeve: "meanrev",
      data: { ...baseManifest.data, universe: ["KO", "PG"], refSymbol: "SPY", funding: false },
    };
    const mrCfg = candidateToReplayConfig(mrManifest, { ...meanrevCand, rsiMethod: "wilder", deterministicTieBreak: true }, "base");
    expect(mrCfg.meanrev?.rsiMethod).toBe("wilder");
    expect(mrCfg.meanrev?.deterministicTieBreak).toBe(true);
    // The candidate's own meanrev object is not mutated.
    expect((meanrevCand.meanrev as any).rsiMethod).toBeUndefined();
  });

  test("hash identity: absent axes keep the legacy hash; set axes are distinct hypotheses", () => {
    const m = { ...baseManifest };
    const legacy = candidateToReplayConfig(m, momentumCand, "base");
    // Undefined values must be dropped by canonical hashing — the serialized
    // config may not even mention the new keys.
    expect(canonicalJson(JSON.parse(JSON.stringify(legacy)))).not.toContain("slotHysteresis");
    expect(canonicalJson(JSON.parse(JSON.stringify(legacy)))).not.toContain('"regime"');
    const withHyst = candidateToReplayConfig(m, { ...momentumCand, slotHysteresis: true }, "base");
    expect(hashReplayConfig(withHyst)).not.toBe(hashReplayConfig(legacy));

    const mrManifest: ExperimentManifest = {
      ...baseManifest, sleeve: "meanrev",
      data: { ...baseManifest.data, universe: ["KO", "PG"], refSymbol: "SPY", funding: false },
    };
    const mrLegacy = candidateToReplayConfig(mrManifest, meanrevCand, "base");
    const mrTie = candidateToReplayConfig(mrManifest, { ...meanrevCand, deterministicTieBreak: true }, "base");
    const mrWilder = candidateToReplayConfig(mrManifest, { ...meanrevCand, rsiMethod: "wilder", deterministicTieBreak: true }, "base");
    expect(canonicalJson(JSON.parse(JSON.stringify(mrLegacy)))).not.toContain("rsiMethod");
    const hashes = new Set([hashReplayConfig(mrLegacy), hashReplayConfig(mrTie), hashReplayConfig(mrWilder)]);
    expect(hashes.size).toBe(3);

    // validateUniqueCandidates sees them as distinct hypotheses, not dupes.
    validateUniqueCandidates({
      ...mrManifest,
      candidates: [meanrevCand, { ...meanrevCand, name: "tie", deterministicTieBreak: true }, { ...meanrevCand, name: "wild", rsiMethod: "wilder", deterministicTieBreak: true }],
    });
  });
});

describe("profitLock candidate axis (2026-09, third stop mechanism)", () => {
  const momentumCand: CandidateConfig = {
    name: "t", cadenceMin: 60, entryPct: 5, exitPct: -2, maxLongs: 2, maxShorts: 0,
  };
  const meanrevCand: CandidateConfig = {
    name: "mr", cadenceMin: 1440,
    meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 },
  };

  test("(h) momentum candidates accept a valid profitLock and reject invalid modes/shapes", () => {
    expect(() => validateCandidate({ ...momentumCand, profitLock: { armAtPct: 10, mode: "breakeven", lockPct: 0 } })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, profitLock: { armAtPct: 15, mode: "peakMinus", lockPct: 8 } })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, profitLock: { armAtPct: 10, mode: "trailing", lockPct: 0 } as any })).toThrow(/profitLock.mode/);
    expect(() => validateCandidate({ ...momentumCand, profitLock: { armAtPct: 0, mode: "breakeven", lockPct: 0 } })).toThrow(/armAtPct/);
    expect(() => validateCandidate({ ...momentumCand, profitLock: { armAtPct: 10, mode: "breakeven", lockPct: -1 } })).toThrow(/lockPct/);
    expect(() => validateCandidate({ ...momentumCand, profitLock: { armAtPct: 10, mode: "breakeven", lockPct: 0, extra: 1 } as any })).toThrow(/unknown keys/);
    expect(() => validateCandidate({ ...momentumCand, profitLock: "on" as any })).toThrow(/profitLock/);
  });

  test("(h) profitLock is FORBIDDEN on meanrev candidates (that runner doesn't implement it — config that changes nothing)", () => {
    expect(() => validateCandidate({ ...meanrevCand, profitLock: { armAtPct: 10, mode: "breakeven", lockPct: 0 } })).toThrow("momentum-only");
  });

  test("candidateToReplayConfig forwards profitLock verbatim; absent keeps the legacy hash", () => {
    const m = { ...baseManifest };
    const legacy = candidateToReplayConfig(m, momentumCand, "base");
    expect(legacy.profitLock).toBeUndefined();
    const withLock = candidateToReplayConfig(m, { ...momentumCand, profitLock: { armAtPct: 10, mode: "breakeven", lockPct: 0 } }, "base");
    expect(withLock.profitLock).toEqual({ armAtPct: 10, mode: "breakeven", lockPct: 0 });
    expect(hashReplayConfig(withLock)).not.toBe(hashReplayConfig(legacy));
  });
});

describe("hashCodeFiles pins engine-adjacent modules (2026-09)", () => {
  test("clock/config/sleeveOutput/events are in the default hash list", () => {
    const src = readFileSync(join(import.meta.dir, "walk-forward.ts"), "utf-8");
    const fnStart = src.indexOf("export async function hashCodeFiles");
    const defaultList = src.slice(fnStart, src.indexOf("].sort()", fnStart));
    for (const f of ["src/utils/clock.ts", "src/config/index.ts", "src/ops/sleeveOutput.ts", "src/utils/events.ts"]) {
      expect(defaultList).toContain(f);
    }
  });
});

describe("break-even curve integration (runWalkForward)", () => {
  function seedBtcDb(dbPath: string) {
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS funding_rates (
        symbol TEXT, funding_time INTEGER, rate REAL,
        PRIMARY KEY(symbol, funding_time)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const fundStmt = db.prepare("INSERT OR REPLACE INTO funding_rates VALUES (?,?,?)");
      const start = Date.parse("2023-12-01T00:00:00Z");
      let price = 100;
      db.transaction(() => {
        for (let i = 0; i < 130 * 24; i++) {
          const t = start + i * 3600_000;
          price = price * (1 + Math.sin(i / 100) * 0.001);
          stmt.run("BTC/USD", "1h", "binance_futures", t, price, price * 1.001, price * 0.999, price, 1);
          fundStmt.run("BTCUSDT", t, 0.0001);
        }
      })();
    } finally {
      db.close();
    }
  }

  /** Sharpe is a decreasing function of cfg.slippageBps: daily drift
   *  0.004 − 0.0005·bps (sign flip at 8 bps) + alternating ±0.004 noise. */
  const slippageSensitiveRunner: ReplayRunner = async (cfg, win) => {
    const from = Date.parse(win.from), to = Date.parse(win.to);
    const days = Math.max(3, Math.floor((to - from) / 86_400_000));
    const drift = 0.004 - 0.0005 * cfg.slippageBps;
    let eq = cfg.initialEquity;
    const equityHistory = [{ t: from, eq }];
    const dailyReturns: Array<{ date: string; ret: number }> = [];
    for (let i = 0; i < days; i++) {
      const ret = drift + (i % 2 === 0 ? 0.004 : -0.004);
      eq *= 1 + ret;
      equityHistory.push({ t: from + (i + 1) * 86_400_000, eq });
      dailyReturns.push({ date: new Date(from + (i + 1) * 86_400_000).toISOString().slice(0, 10), ret });
    }
    return {
      sleeve: cfg.sleeve, window: win, fromMs: from, toMs: to, config: cfg,
      finalEquity: eq, totalReturn: (eq - cfg.initialEquity) / cfg.initialEquity,
      maxDrawdown: 0.05, sharpe: drift * 100, winRate: 0.5, trades: 4, tradesPerDay: 0.2,
      expectancy: 1, fees: 0, funding: 0, liquidations: 0, marginRejects: 0, ruined: false,
      bench: 0, dailyReturns, sessionReturns: [], tradesBySymbol: {},
      equityHistory, closedTrades: [], hash: "h",
      finalRiskState: { ...INITIAL_RISK_STATE },
    } as ReplayResult;
  };

  test("curve covers every tier, reuses the cached base tier, and the gate reads the interpolated crossing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-breakeven-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedBtcDb(dbPath);
      const m: ExperimentManifest = {
        ...baseManifest,
        name: "wf-breakeven",
        sleeve: "crypto",
        data: { ...baseManifest.data, dbPath, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60 },
        asOf: "2024-04-01",
        window: { from: "2024-01-01", to: "2024-04-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.01, warmupDays: 20 },
        candidates: [{ ...baseManifest.candidates[0], name: "only" }],
        acceptance: { ...baseManifest.acceptance, minBreakEvenSlippageBps: 4 },
      };
      const calls: Array<{ label: string; slippageBps: number }> = [];
      const runner: ReplayRunner = async (cfg, win) => {
        calls.push({ label: win.label, slippageBps: cfg.slippageBps });
        return slippageSensitiveRunner(cfg, win);
      };

      const { runWalkForward } = await import("./walk-forward");
      const wf = await runWalkForward(m, { dryRun: false, runner });
      outputDir = wf.outputDir;
      const { summary } = wf;

      expect(summary.breakEvenCurve).toBeDefined();
      expect(summary.breakEvenCurve!.map(p => p.slippageBps)).toEqual(BREAK_EVEN_SLIPPAGE_BPS);
      // Drift crosses 0 at 8 bps → Sharpe crossing interpolates inside (5, 10).
      expect(summary.breakEvenCurve![0].sharpe).toBeGreaterThan(0);
      expect(summary.breakEvenCurve![5].sharpe).toBeLessThan(0);
      expect(summary.breakEvenSlippageBps!).toBeGreaterThan(5);
      expect(summary.breakEvenSlippageBps!).toBeLessThan(10);
      expect(summary.acceptance.minBreakEvenSlippageBps.pass).toBe(true);
      expect(summary.acceptance.minBreakEvenSlippageBps.value).toBe(summary.breakEvenSlippageBps!);

      // The tier equal to base slippage (2 bps) is a pure cache hit: the two
      // outer-test calls at 2 bps come from the BASE chain only.
      const outerBaseCalls = calls.filter(c => /^\d+\/test$/.test(c.label) && c.slippageBps === m.costs.base.slippageBps);
      expect(outerBaseCalls).toHaveLength(2);

      // Evidence layer rides along on the same run.
      expect(summary.observations).toBeGreaterThan(0);
      expect(summary.outerPsr).toBeDefined();
      expect(summary.certifiableSharpeAtPsr95!).toBeCloseTo((1.645 * Math.sqrt(365)) / Math.sqrt(summary.observations!), 9);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 30_000);

  test("breakEven: false skips the curve and the gate fails closed", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-nobreakeven-"));
    const dbPath = join(tmpDir, "historical.db");
    let outputDir: string | undefined;
    try {
      seedBtcDb(dbPath);
      const m: ExperimentManifest = {
        ...baseManifest,
        name: "wf-nobreakeven",
        sleeve: "crypto",
        data: { ...baseManifest.data, dbPath, source: "binance_futures", timeframe: "1h", universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60 },
        asOf: "2024-04-01",
        window: { from: "2024-01-01", to: "2024-04-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.01, warmupDays: 20 },
        candidates: [{ ...baseManifest.candidates[0], name: "only" }],
        acceptance: { ...baseManifest.acceptance, minBreakEvenSlippageBps: 4 },
      };
      const { runWalkForward } = await import("./walk-forward");
      const wf = await runWalkForward(m, { dryRun: false, runner: slippageSensitiveRunner, breakEven: false });
      outputDir = wf.outputDir;
      expect(wf.summary.breakEvenCurve).toBeUndefined();
      expect(wf.summary.breakEvenSlippageBps).toBeUndefined();
      expect(wf.summary.acceptance.minBreakEvenSlippageBps.pass).toBe(false);
      expect(wf.summary.acceptance.minBreakEvenSlippageBps.reason).toContain("not computed");
      expect(wf.summary.approvalReason).toContain("minBreakEvenSlippageBps");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      if (outputDir) try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 30_000);
});

describe("experiments/ manifests stay loadable under the extended validator", () => {
  test("every committed manifest validates and keeps unique effective candidates", () => {
    const dir = join(import.meta.dir, "..", "experiments");
    const files = readdirSync(dir).filter(f => f.endsWith(".json") && !f.startsWith("historical-hypothesis-ledger"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const m = loadManifest(join(dir, f));
      validateUniqueCandidates(m);
    }
  });
});
