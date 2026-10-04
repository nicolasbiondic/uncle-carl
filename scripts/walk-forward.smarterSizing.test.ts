// Candidate plumbing for the two 2026-09-25 stocks axes:
//   - volSizing (inverse-volatility entry sizing, momentum-only)
//   - lookbackDaysList (multi-horizon TSM signal, momentum-only,
//     mutually exclusive with lookbackDays)
// Contract per repo convention: strict shape validation (unknown/invalid
// shapes throw — config that changes nothing is rejected), absent keys keep
// the LEGACY candidate hash, set keys are distinct hypotheses, and
// candidateToReplayConfig forwards both verbatim.
import { describe, expect, test } from "bun:test";
import { candidateToReplayConfig, validateCandidate, type CandidateConfig, type ExperimentManifest } from "./walk-forward";
import { hashReplayConfig } from "./backtest-momentum-wf";

const baseManifest: ExperimentManifest = {
  name: "test-smarter-sizing",
  sleeve: "stocks",
  trialAccounting: { priorUniqueTrials: 0, complete: false },
  data: {
    dbPath: "./data/historical.db",
    source: "alpaca_wide",
    timeframe: "1d",
    universe: ["SPY", "QQQ"],
    refSymbol: "SPY",
    rthOnly: false,
    funding: false,
    barMinutes: 1440,
    barMinutesEq: 1440,
  },
  asOf: "2026-09-24",
  window: { from: "2017-06-01", to: "2026-09-24", outerFoldCount: 3, innerFoldCount: 3, purgeYears: 0.25, warmupDays: 420 },
  costs: { base: { slippageBps: 2, commissionBps: 0 }, stress: { slippageBps: 5, commissionBps: 2 } },
  ledger: { initialEquity: 50_000, leverage: 2, hardStopPct: 0.04 },
  candidates: [],
  acceptance: {},
};

const momo: CandidateConfig = {
  name: "base",
  cadenceMin: 1440,
  notionalPctPerSlot: 0.125,
  entryPct: 5,
  exitPct: -2,
  maxLongs: 8,
  maxShorts: 0,
};

const meanrevCandidate: CandidateConfig = {
  name: "mr",
  cadenceMin: 1440,
  meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 },
};

describe("volSizing candidate axis", () => {
  test("valid shape passes; unknown keys, bad lookback, bad clamp all throw", () => {
    expect(() => validateCandidate({ ...momo, volSizing: { lookbackBars: 60, minScale: 0.5, maxScale: 2.0 } })).not.toThrow();
    expect(() => validateCandidate({ ...momo, volSizing: { lookbackBars: 60, minScale: 0.5, maxScale: 2.0, sigma: 1 } })).toThrow(/unknown keys/);
    expect(() => validateCandidate({ ...momo, volSizing: { lookbackBars: 1, minScale: 0.5, maxScale: 2.0 } })).toThrow(/lookbackBars/);
    expect(() => validateCandidate({ ...momo, volSizing: { lookbackBars: 60.5, minScale: 0.5, maxScale: 2.0 } })).toThrow(/lookbackBars/);
    expect(() => validateCandidate({ ...momo, volSizing: { lookbackBars: 60, minScale: 0, maxScale: 2.0 } })).toThrow(/minScale/);
    expect(() => validateCandidate({ ...momo, volSizing: { lookbackBars: 60, minScale: 0.5, maxScale: 0.4 } })).toThrow(/maxScale/);
    expect(() => validateCandidate({ ...momo, volSizing: [0.5, 2] })).toThrow(/object/);
  });

  test("meanrev candidates must not set volSizing", () => {
    expect(() => validateCandidate({ ...meanrevCandidate, volSizing: { lookbackBars: 60, minScale: 0.5, maxScale: 2.0 } }))
      .toThrow(/momentum-only/);
  });

  test("hash identity: absent = legacy hash; set = distinct hypothesis; forwarded verbatim", () => {
    const legacy = hashReplayConfig(candidateToReplayConfig(baseManifest, momo, "base"));
    expect(hashReplayConfig(candidateToReplayConfig(baseManifest, { ...momo, volSizing: undefined }, "base"))).toBe(legacy);
    const vs60 = candidateToReplayConfig(baseManifest, { ...momo, name: "iv60", volSizing: { lookbackBars: 60, minScale: 0.5, maxScale: 2.0 } }, "base");
    const vs20 = candidateToReplayConfig(baseManifest, { ...momo, name: "iv20", volSizing: { lookbackBars: 20, minScale: 0.5, maxScale: 2.0 } }, "base");
    expect(vs60.volSizing).toEqual({ lookbackBars: 60, minScale: 0.5, maxScale: 2.0 });
    expect(hashReplayConfig(vs60)).not.toBe(legacy);
    expect(hashReplayConfig(vs20)).not.toBe(legacy);
    expect(hashReplayConfig(vs20)).not.toBe(hashReplayConfig(vs60));
  });
});

describe("lookbackDaysList candidate axis", () => {
  test("valid list passes; empty/single/non-integer/duplicate lists throw", () => {
    expect(() => validateCandidate({ ...momo, lookbackDaysList: [63, 126, 252], maLengthDays: 200 })).not.toThrow();
    expect(() => validateCandidate({ ...momo, lookbackDaysList: [] })).toThrow(/>= 2/);
    expect(() => validateCandidate({ ...momo, lookbackDaysList: [126] })).toThrow(/>= 2/);
    expect(() => validateCandidate({ ...momo, lookbackDaysList: [63, 126.5] })).toThrow(/positive integers/);
    expect(() => validateCandidate({ ...momo, lookbackDaysList: [63, 0] })).toThrow(/positive integers/);
    expect(() => validateCandidate({ ...momo, lookbackDaysList: [126, 126] })).toThrow(/distinct/);
    expect(() => validateCandidate({ ...momo, lookbackDaysList: "63,126" })).toThrow();
  });

  test("mutually exclusive with lookbackDays (one signal definition per candidate)", () => {
    expect(() => validateCandidate({ ...momo, lookbackDays: 126, lookbackDaysList: [63, 126, 252] }))
      .toThrow(/mutually exclusive/);
  });

  test("meanrev candidates must not set lookbackDaysList", () => {
    expect(() => validateCandidate({ ...meanrevCandidate, lookbackDaysList: [63, 126] })).toThrow(/momentum-only/);
  });

  test("hash identity: absent = legacy hash; distinct lists = distinct hypotheses; forwarded verbatim", () => {
    const legacy = hashReplayConfig(candidateToReplayConfig(baseManifest, momo, "base"));
    expect(hashReplayConfig(candidateToReplayConfig(baseManifest, { ...momo, lookbackDaysList: undefined }, "base"))).toBe(legacy);
    const b3 = candidateToReplayConfig(baseManifest, { ...momo, name: "b3", lookbackDaysList: [63, 126, 252], maLengthDays: 200 }, "base");
    const b2 = candidateToReplayConfig(baseManifest, { ...momo, name: "b2", lookbackDaysList: [126, 252], maLengthDays: 200 }, "base");
    expect(b3.lookbackDaysList).toEqual([63, 126, 252]);
    expect(hashReplayConfig(b3)).not.toBe(legacy);
    expect(hashReplayConfig(b2)).not.toBe(legacy);
    expect(hashReplayConfig(b2)).not.toBe(hashReplayConfig(b3));
    // Order matters for identity: the list is the declared signal, not a set.
    const b3r = candidateToReplayConfig(baseManifest, { ...momo, name: "b3r", lookbackDaysList: [252, 126, 63], maLengthDays: 200 }, "base");
    expect(hashReplayConfig(b3r)).not.toBe(hashReplayConfig(b3));
  });
});
