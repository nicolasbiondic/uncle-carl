// risk.shadowResume — simulator/protocol surface (2026-09-26):
//   1. Hash identity: risk without shadowResume = legacy hash byte for byte;
//      adding it changes it; its values change it again.
//   2. validateRisk: strict shape (recoverPct fraction, optional
//      costBpsPerSide), unknown keys rejected.
//   3. candidateToReplayConfig forwards the risk block verbatim.
//   4. continueRiskState scales the tracker's monetary anchors by I/F so a
//      pause episode alive at a fold boundary keeps its drawdown geometry.
import { describe, expect, test } from "bun:test";
import { hashReplayConfig, canonicalJson, type ReplayConfig, type ReplayResult } from "./backtest-momentum-wf";
import { candidateToReplayConfig, continueRiskState, validateCandidate, type CandidateConfig, type ExperimentManifest } from "./walk-forward";
import { INITIAL_RISK_STATE } from "../src/strategies/momentum/RiskGuard";

const baseCfg: ReplayConfig = {
  sleeve: "crypto",
  universe: ["BTC/USD", "ETH/USD"],
  timeframe: "1h",
  source: "binance_futures",
  refSymbol: "BTC/USD",
  rthOnly: false,
  funding: false,
  barMinutes: 60,
  barMinutesEq: 60,
  slippageBps: 5,
  commissionBps: 4,
  initialEquity: 5000,
  leverage: 2,
  hardStopPct: 0.04,
  cadenceMin: 60,
  notionalPctPerSlot: 0.375,
  entryPct: 5,
  exitPct: -2,
  maxLongs: 4,
  maxShorts: 0,
  shortFunding: "credit",
  warmupDays: 45,
  dbPath: "./data/historical.db",
  risk: { peakHalfLifeDays: 30 },
};

const SR = { recoverPct: 0.03, costBpsPerSide: 9 };

describe("hash identity — risk.shadowResume", () => {
  test("absent = legacy hash; present changes it; values change it again", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({ ...baseCfg, risk: { peakHalfLifeDays: 30, shadowResume: undefined } })).toBe(legacy);
    const withSr = hashReplayConfig({ ...baseCfg, risk: { peakHalfLifeDays: 30, shadowResume: SR } });
    expect(withSr).not.toBe(legacy);
    expect(hashReplayConfig({ ...baseCfg, risk: { peakHalfLifeDays: 30, shadowResume: { ...SR, recoverPct: 0.05 } } })).not.toBe(withSr);
    expect(canonicalJson(JSON.parse(JSON.stringify(baseCfg)))).not.toContain('"shadowResume"');
  });
});

describe("validateCandidate — risk.shadowResume shape", () => {
  const momentumCand: CandidateConfig = {
    name: "c",
    cadenceMin: 60,
    entryPct: 5,
    exitPct: -2,
    maxLongs: 4,
    maxShorts: 0,
  };

  test("accepts a well-formed shadowResume (costBpsPerSide optional)", () => {
    expect(() => validateCandidate({ ...momentumCand, risk: { peakHalfLifeDays: 30, shadowResume: SR } })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, risk: { shadowResume: { recoverPct: 0.03 } } })).not.toThrow();
  });

  test("rejects malformed shapes", () => {
    expect(() => validateCandidate({ ...momentumCand, risk: { shadowResume: { recoverPct: 3 } } })).toThrow("FRACTION");
    expect(() => validateCandidate({ ...momentumCand, risk: { shadowResume: { recoverPct: 0 } } })).toThrow("FRACTION");
    expect(() => validateCandidate({ ...momentumCand, risk: { shadowResume: { recoverPct: 0.03, costBpsPerSide: -1 } } })).toThrow("costBpsPerSide");
    expect(() => validateCandidate({ ...momentumCand, risk: { shadowResume: { recoverPct: 0.03, extra: 1 } } })).toThrow("unknown keys");
    expect(() => validateCandidate({ ...momentumCand, risk: { shadowResume: {} } })).toThrow("recoverPct");
  });
});

describe("candidateToReplayConfig — shadowResume forwarding", () => {
  const manifest = {
    name: "t",
    sleeve: "crypto",
    data: {
      dbPath: "./data/historical.db",
      source: "binance_futures",
      timeframe: "1h",
      universe: ["BTC/USD"],
      refSymbol: "BTC/USD",
      rthOnly: false,
      funding: true,
      barMinutes: 60,
      barMinutesEq: 60,
    },
    window: { from: "2021-01-01", to: "2026-09-26", outerFoldCount: 3, innerFoldCount: 3, purgeYears: 0.25, warmupDays: 45 },
    costs: { base: { slippageBps: 5, commissionBps: 4 }, stress: { slippageBps: 10, commissionBps: 8 } },
    ledger: { initialEquity: 5000, leverage: 2, hardStopPct: 0.04 },
    candidates: [],
    acceptance: {},
  } as unknown as ExperimentManifest;

  test("forwards the risk block (shadowResume included) verbatim", () => {
    const cand: CandidateConfig = {
      name: "vt35-resume3",
      cadenceMin: 60,
      entryPct: 5,
      exitPct: -2,
      maxLongs: 4,
      maxShorts: 0,
      risk: { peakHalfLifeDays: 30, shadowResume: SR },
    };
    const cfg = candidateToReplayConfig(manifest, cand, "base");
    expect(cfg.risk).toEqual({ peakHalfLifeDays: 30, shadowResume: SR });
    const cfg2 = candidateToReplayConfig(manifest, { ...cand, risk: { peakHalfLifeDays: 30 } }, "base");
    expect(canonicalJson(JSON.parse(JSON.stringify(cfg2)))).not.toContain('"shadowResume"');
  });
});

describe("continueRiskState — shadow tracker scaling", () => {
  const result = (finalEquity: number, state: object): ReplayResult => ({
    config: { initialEquity: 5000 },
    finalEquity,
    ruined: false,
    finalRiskState: { ...INITIAL_RISK_STATE, peakEquity: 6000, dayStartEquity: 5500, ...state },
  } as unknown as ReplayResult);

  test("scales equity/startEquity/peakRef by I/F; absence stays absent", () => {
    const withTracker = continueRiskState(result(10_000, { shadowResume: { equity: 9_200, startEquity: 9_000, peakRef: 12_000 } }));
    // I/F = 5000/10000 = 0.5
    expect(withTracker.shadowResume).toEqual({ equity: 4_600, startEquity: 4_500, peakRef: 6_000 });
    const without = continueRiskState(result(10_000, {}));
    expect("shadowResume" in without).toBe(false);
  });
});
