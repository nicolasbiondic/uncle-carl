// risk.ddScale — simulator/protocol surface (2026-09-25):
//   1. Hash identity: risk without ddScale = legacy hash byte for byte;
//      adding ddScale changes it; its values change it again.
//   2. validateCandidate/validateRisk: strict shape (fraction units),
//      unknown risk keys rejected (they were silently dropped before).
//   3. candidateToReplayConfig forwards the risk block verbatim.
import { describe, expect, test } from "bun:test";
import { hashReplayConfig, canonicalJson, type ReplayConfig } from "./backtest-momentum-wf";
import { candidateToReplayConfig, validateCandidate, type CandidateConfig, type ExperimentManifest } from "./walk-forward";

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

const DD = { startPct: 0.05, endPct: 0.20, minScale: 0 };

describe("hash identity — risk.ddScale", () => {
  test("absent = legacy hash; present changes it; values change it again", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({ ...baseCfg, risk: { peakHalfLifeDays: 30, ddScale: undefined } })).toBe(legacy);
    const withDd = hashReplayConfig({ ...baseCfg, risk: { peakHalfLifeDays: 30, ddScale: DD } });
    expect(withDd).not.toBe(legacy);
    expect(hashReplayConfig({ ...baseCfg, risk: { peakHalfLifeDays: 30, ddScale: { ...DD, startPct: 0.10 } } })).not.toBe(withDd);
    // canonical JSON of a legacy config literally never contains the key
    expect(canonicalJson(JSON.parse(JSON.stringify(baseCfg)))).not.toContain('"ddScale"');
  });
});

describe("validateCandidate — risk block / ddScale axis", () => {
  const momentumCand: CandidateConfig = {
    name: "c",
    cadenceMin: 60,
    entryPct: 5,
    exitPct: -2,
    maxLongs: 4,
    maxShorts: 0,
  };

  test("accepts the legacy risk block and a well-formed ddScale", () => {
    expect(() => validateCandidate({ ...momentumCand, risk: { peakHalfLifeDays: 30 } })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, risk: { peakHalfLifeDays: 30, ddScale: DD } })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, risk: { softDrawdownPct: 1.0 } })).not.toThrow(); // breakers-v1 ablation pattern
    expect(() => validateCandidate({ ...momentumCand, risk: { ddScale: { startPct: 0.10, endPct: 0.20 } } })).not.toThrow(); // minScale optional
  });

  test("rejects malformed shapes (unknown keys, non-fraction units, inverted ramp)", () => {
    expect(() => validateCandidate({ ...momentumCand, risk: { peakHalfLife: 30 } })).toThrow("unknown keys");
    expect(() => validateCandidate({ ...momentumCand, risk: { ddScale: { startPct: 0.05, endPct: 0.20, extra: 1 } } })).toThrow("unknown keys");
    expect(() => validateCandidate({ ...momentumCand, risk: { ddScale: { startPct: 5, endPct: 20 } } })).toThrow("FRACTION"); // percent-units typo
    expect(() => validateCandidate({ ...momentumCand, risk: { ddScale: { startPct: 0.20, endPct: 0.10 } } })).toThrow("endPct");
    expect(() => validateCandidate({ ...momentumCand, risk: { ddScale: { startPct: 0.05, endPct: 0.20, minScale: 1 } } })).toThrow("minScale");
    expect(() => validateCandidate({ ...momentumCand, risk: { ddScale: { endPct: 0.20 } } })).toThrow("startPct"); // missing start
    expect(() => validateCandidate({ ...momentumCand, risk: "off" as any })).toThrow("risk");
  });

  test("risk stays forbidden on meanrev candidates", () => {
    const meanrevCand = {
      name: "mr",
      cadenceMin: 1440,
      meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 },
      risk: { ddScale: DD },
    };
    expect(() => validateCandidate(meanrevCand)).toThrow();
  });
});

describe("candidateToReplayConfig — risk forwarding", () => {
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
    window: { from: "2021-01-01", to: "2026-07-15", outerFoldCount: 3, innerFoldCount: 3, purgeYears: 0.25, warmupDays: 45 },
    costs: { base: { slippageBps: 5, commissionBps: 4 }, stress: { slippageBps: 10, commissionBps: 8 } },
    ledger: { initialEquity: 5000, leverage: 2, hardStopPct: 0.04 },
    candidates: [],
    acceptance: {},
  } as unknown as ExperimentManifest;

  test("forwards the risk block (ddScale included) verbatim", () => {
    const cand: CandidateConfig = {
      name: "vt35-dd5-20",
      cadenceMin: 60,
      entryPct: 5,
      exitPct: -2,
      maxLongs: 4,
      maxShorts: 0,
      risk: { peakHalfLifeDays: 30, ddScale: DD },
    };
    const cfg = candidateToReplayConfig(manifest, cand, "base");
    expect(cfg.risk).toEqual({ peakHalfLifeDays: 30, ddScale: DD });
    // and absence stays absent (legacy identity)
    const cfg2 = candidateToReplayConfig(manifest, { ...cand, risk: { peakHalfLifeDays: 30 } }, "base");
    expect(cfg2.risk).toEqual({ peakHalfLifeDays: 30 });
    expect(canonicalJson(JSON.parse(JSON.stringify(cfg2)))).not.toContain('"ddScale"');
  });
});
