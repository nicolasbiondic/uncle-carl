/**
 * Sequence-risk Monte Carlo protocol wiring (2026-09-26, Jesse pattern):
 *   - the two new acceptance gates (maxSequenceDdP95 /
 *     maxObservedDdPercentile) are OPTIONAL — undeclared keys are never
 *     evaluated, so every pre-registered manifest keeps its exact legacy
 *     gate set and verdict;
 *   - declared gates fail CLOSED when summary.sequenceRisk is absent;
 *   - manifest validation rejects malformed thresholds;
 *   - candidate/config hashes are untouched by the new acceptance keys
 *     (acceptance is not part of candidateToReplayConfig).
 */

import { describe, expect, test } from "bun:test";
import {
  candidateToReplayConfig,
  evaluateAcceptance,
  validateManifest,
  type ExperimentManifest,
  type WalkForwardSummary,
} from "./walk-forward";
import { hashReplayConfig } from "./backtest-momentum-wf";
import { computeSequenceRisk, mulberry32 } from "./lib/sequenceRisk";

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
  return {
    manifestHash: "", configHash: "", dataHash: "", codeHash: "", asOfMs: 0, resolvedTo: "",
    selectedCandidate: null,
    innerSelection: [],
    outerTests: [{ foldPath: "0/test", result: base as any }],
    stressTests: [{ foldPath: "0/test", result: { ...base, sharpe: 1.0 } as any }],
    stitchedOos: { totalReturn: 0.1, sharpe: 1.2, maxDrawdown: 0.05, winRate: 0.5, trades: 10, expectancy: 10, fees: 0, funding: 0, liquidations: 0, marginRejects: 0, ruined: false },
    concentration: { maxTradesFracByFold: [], maxPnlFracByFold: [], totalTradesBySymbol: {}, totalGrossPnlBySymbol: {} },
    loo: [{ excludedSymbol: "BTC/USD", stitchedReturn: 0.09, stitchedSharpe: 1.1, stitchedMaxDrawdown: 0.05, totalTrades: 9 }],
    skippedFolds: [],
    acceptance: {}, approved: false, approvalReason: "", complete: true, priorTrialsComplete: true,
  };
}

const permissive = {
  stressMinSharpe: -10, stressMaxDrawdown: 10, stressMinTotalReturn: -10,
  looMinSharpe: -10, looMaxDrawdown: 10, looMinTotalReturn: -10,
};

function realisticSequenceRisk() {
  const rand = mulberry32(11);
  const rets = Array.from({ length: 200 }, () => (rand() - 0.45) * 0.02);
  const pnls = Array.from({ length: 30 }, () => (rand() - 0.4) * 100);
  return computeSequenceRisk(rets, pnls, 10_000, { paths: 300 });
}

describe("sequence-risk acceptance gates", () => {
  test("undeclared gates are NOT evaluated — legacy manifests keep their exact gate set", () => {
    const withSr = fakeSummary();
    withSr.sequenceRisk = realisticSequenceRisk();
    const withoutSr = fakeSummary(); // pre-2026-09-26 summary: no sequenceRisk at all
    evaluateAcceptance(withSr, { minSharpe: 0, ...permissive });
    evaluateAcceptance(withoutSr, { minSharpe: 0, ...permissive });
    expect(withSr.acceptance.maxSequenceDdP95).toBeUndefined();
    expect(withSr.acceptance.maxObservedDdPercentile).toBeUndefined();
    // Identical gate keys and identical verdict whether or not the summary
    // carries the new evidence block.
    expect(Object.keys(withSr.acceptance).sort()).toEqual(Object.keys(withoutSr.acceptance).sort());
    expect(withSr.approvalReason).toBe(withoutSr.approvalReason);
  });

  test("declared gates evaluate against the computed distribution", () => {
    const s = fakeSummary();
    s.sequenceRisk = realisticSequenceRisk();
    const p95 = s.sequenceRisk.bootstrap!.maxDrawdown.p95;
    const pct = s.sequenceRisk.observedMaxDdPercentile!;
    evaluateAcceptance(s, {
      ...permissive,
      maxSequenceDdP95: p95 + 0.01,
      maxObservedDdPercentile: Math.min(1, pct + 0.001),
    });
    expect(s.acceptance.maxSequenceDdP95.pass).toBe(true);
    expect(s.acceptance.maxSequenceDdP95.value).toBe(p95);
    expect(s.acceptance.maxObservedDdPercentile.pass).toBe(true);
    expect(s.acceptance.maxObservedDdPercentile.value).toBe(pct);

    const fail = fakeSummary();
    fail.sequenceRisk = s.sequenceRisk;
    evaluateAcceptance(fail, {
      ...permissive,
      maxSequenceDdP95: Math.max(1e-9, p95 - 0.0001),
      maxObservedDdPercentile: Math.max(1e-9, pct - 0.0001),
    });
    expect(fail.acceptance.maxSequenceDdP95.pass).toBe(false);
    expect(fail.acceptance.maxObservedDdPercentile.pass).toBe(false);
    expect(fail.approvalReason).toContain("maxSequenceDdP95");
    expect(fail.approvalReason).toContain("maxObservedDdPercentile");
  });

  test("declared gates fail CLOSED when sequenceRisk was never computed", () => {
    const s = fakeSummary(); // no sequenceRisk block
    evaluateAcceptance(s, { ...permissive, maxSequenceDdP95: 0.5, maxObservedDdPercentile: 0.975 });
    expect(s.acceptance.maxSequenceDdP95.pass).toBe(false);
    expect(s.acceptance.maxSequenceDdP95.reason).toContain("not computed");
    expect(s.acceptance.maxObservedDdPercentile.pass).toBe(false);
    expect(s.acceptance.maxObservedDdPercentile.reason).toContain("not computed");
  });

  test("degenerate evidence (bootstrap absent) fails a declared maxSequenceDdP95 closed", () => {
    const s = fakeSummary();
    s.sequenceRisk = computeSequenceRisk([0.01], [], 10_000); // both methods absent
    evaluateAcceptance(s, { ...permissive, maxSequenceDdP95: 0.5, maxObservedDdPercentile: 0.975 });
    expect(s.acceptance.maxSequenceDdP95.pass).toBe(false);
    expect(s.acceptance.maxObservedDdPercentile.pass).toBe(false);
  });
});

describe("manifest validation + hash identity for the new acceptance keys", () => {
  const baseManifest: ExperimentManifest = {
    name: "seqrisk-test",
    sleeve: "crypto",
    trialAccounting: { priorUniqueTrials: 0, complete: true },
    data: {
      dbPath: "./data/historical.db", source: "binance_futures", timeframe: "1h",
      universe: ["BTC/USD", "ETH/USD"], refSymbol: "BTC/USD", rthOnly: false,
      funding: false, barMinutes: 60, barMinutesEq: 60,
    },
    asOf: "2025-01-01",
    window: { from: "2024-01-01", to: "2025-01-01", outerFoldCount: 2, innerFoldCount: 2, purgeYears: 0, warmupDays: 30 },
    costs: { base: { slippageBps: 5, commissionBps: 4 }, stress: { slippageBps: 10, commissionBps: 8 } },
    ledger: { initialEquity: 5000, leverage: 2, hardStopPct: 0.04 },
    candidates: [{ name: "c", cadenceMin: 60, entryPct: 5, exitPct: -2, maxLongs: 2, maxShorts: 0 }],
    acceptance: { minSharpe: 0 },
  };

  test("valid thresholds are accepted; malformed ones are rejected", () => {
    expect(() => validateManifest({ ...baseManifest, acceptance: { maxSequenceDdP95: 0.35, maxObservedDdPercentile: 0.975 } })).not.toThrow();
    expect(() => validateManifest({ ...baseManifest, acceptance: { maxSequenceDdP95: 0 } })).toThrow(/maxSequenceDdP95/);
    expect(() => validateManifest({ ...baseManifest, acceptance: { maxSequenceDdP95: 1.5 } })).toThrow(/maxSequenceDdP95/);
    expect(() => validateManifest({ ...baseManifest, acceptance: { maxObservedDdPercentile: 0 } })).toThrow(/maxObservedDdPercentile/);
    expect(() => validateManifest({ ...baseManifest, acceptance: { maxObservedDdPercentile: 40 } })).toThrow(/maxObservedDdPercentile/);
  });

  test("acceptance keys never enter the candidate hash", () => {
    const withGates: ExperimentManifest = {
      ...baseManifest,
      acceptance: { ...baseManifest.acceptance, maxSequenceDdP95: 0.35, maxObservedDdPercentile: 0.975 },
    };
    const h1 = hashReplayConfig(candidateToReplayConfig(baseManifest, baseManifest.candidates[0], "base"));
    const h2 = hashReplayConfig(candidateToReplayConfig(withGates, withGates.candidates[0], "base"));
    expect(h1).toBe(h2);
  });
});
