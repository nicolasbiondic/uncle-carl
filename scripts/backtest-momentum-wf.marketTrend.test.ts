// Market-trend gate — simulator/protocol surface (2026-09-24):
//   1. Hash identity: marketTrend absent = legacy hash byte for byte;
//      present (any value) changes it.
//   2. validateCandidate: strict shape, momentum-only.
//   3. candidateToReplayConfig forwards the axis verbatim.
//   4. dailyClosesFromBars: UTC-day aggregation of 1h bars.
//   5. SimBroker.fetchDailyCloses: strict causality — a day is only visible
//      once its UTC end <= sim clock, the in-progress day never is.
import { describe, expect, test } from "bun:test";
import {
  SimBroker,
  dailyClosesFromBars,
  hashReplayConfig,
  canonicalJson,
  type ReplayConfig,
} from "./backtest-momentum-wf";
import { candidateToReplayConfig, validateCandidate, type CandidateConfig, type ExperimentManifest } from "./walk-forward";
import type { OHLCV } from "../src/utils/types";

const H = 3_600_000;
const D = 86_400_000;

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
};

describe("hash identity — marketTrend", () => {
  test("absent = legacy hash; present changes it; value changes it again", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({ ...baseCfg, marketTrend: undefined })).toBe(legacy);
    const withGate = hashReplayConfig({ ...baseCfg, marketTrend: { symbol: "BTC/USD", maDays: 200 } });
    expect(withGate).not.toBe(legacy);
    expect(hashReplayConfig({ ...baseCfg, marketTrend: { symbol: "BTC/USD", maDays: 100 } })).not.toBe(withGate);
    // canonical JSON of a legacy config literally never contains the key
    expect(canonicalJson(JSON.parse(JSON.stringify(baseCfg)))).not.toContain('"marketTrend"');
  });
});

describe("validateCandidate — marketTrend axis", () => {
  const momentumCand: CandidateConfig = {
    name: "c",
    cadenceMin: 60,
    entryPct: 5,
    exitPct: -2,
    maxLongs: 4,
    maxShorts: 0,
  };

  test("accepts a well-formed gate; rejects malformed shapes", () => {
    expect(() => validateCandidate({ ...momentumCand, marketTrend: { symbol: "BTC/USD", maDays: 200 } })).not.toThrow();
    expect(() => validateCandidate({ ...momentumCand, marketTrend: "on" as any })).toThrow("marketTrend");
    expect(() => validateCandidate({ ...momentumCand, marketTrend: { symbol: "", maDays: 200 } })).toThrow("symbol");
    expect(() => validateCandidate({ ...momentumCand, marketTrend: { symbol: "BTC/USD", maDays: 1 } })).toThrow("maDays");
    expect(() => validateCandidate({ ...momentumCand, marketTrend: { symbol: "BTC/USD", maDays: 200.5 } })).toThrow("maDays");
    expect(() => validateCandidate({ ...momentumCand, marketTrend: { symbol: "BTC/USD", maDays: 200, extra: 1 } })).toThrow("unknown keys");
  });

  test("forbidden on meanrev candidates (momentum-only knob)", () => {
    const meanrevCand = {
      name: "mr",
      cadenceMin: 1440,
      meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 },
      marketTrend: { symbol: "BTC/USD", maDays: 200 },
    };
    expect(() => validateCandidate(meanrevCand)).toThrow("momentum-only");
  });
});

describe("candidateToReplayConfig — marketTrend forwarding", () => {
  const manifest = {
    name: "t",
    sleeve: "crypto",
    trialAccounting: { priorUniqueTrials: 0, complete: false },
    data: {
      dbPath: "./data/historical.db", source: "binance_futures", timeframe: "1h",
      universe: ["BTC/USD"], refSymbol: "BTC/USD", rthOnly: false, funding: true,
      barMinutes: 60, barMinutesEq: 60,
    },
    asOf: "2026-07-15",
    window: { from: "2021-01-01", to: "2026-07-15", outerFoldCount: 3, innerFoldCount: 3, purgeYears: 0.25, warmupDays: 45 },
    costs: { base: { slippageBps: 5, commissionBps: 4 }, stress: { slippageBps: 10, commissionBps: 8 } },
    ledger: { initialEquity: 5000, leverage: 2, hardStopPct: 0.04 },
    candidates: [],
    acceptance: {},
  } as unknown as ExperimentManifest;

  test("forwarded verbatim when present, absent otherwise", () => {
    const cand: CandidateConfig = { name: "g", cadenceMin: 60, entryPct: 5, exitPct: -2, maxLongs: 4, maxShorts: 0, marketTrend: { symbol: "BTC/USD", maDays: 200 } };
    expect(candidateToReplayConfig(manifest, cand, "base").marketTrend).toEqual({ symbol: "BTC/USD", maDays: 200 });
    const { marketTrend, ...control } = cand;
    expect(candidateToReplayConfig(manifest, control as CandidateConfig, "base").marketTrend).toBeUndefined();
  });
});

function hourBars(fromMs: number, hours: number, closeAt: (i: number) => number): OHLCV[] {
  const out: OHLCV[] = [];
  for (let i = 0; i < hours; i++) {
    const p = closeAt(i);
    out.push({ timestamp: fromMs + i * H, open: p, high: p, low: p, close: p, volume: 1 });
  }
  return out;
}

describe("dailyClosesFromBars", () => {
  test("one close per UTC day = the LAST bar of that day; dayEndMs is the exclusive day end", () => {
    const from = Date.parse("2024-01-01T00:00:00Z");
    const bars = hourBars(from, 72, i => 100 + i); // 3 full days, close rises hourly
    const { dayEndMs, closes } = dailyClosesFromBars(bars);
    expect(dayEndMs).toEqual([from + D, from + 2 * D, from + 3 * D]);
    expect(closes).toEqual([100 + 23, 100 + 47, 100 + 71]);
  });

  test("partial trailing day still aggregates (visibility is the broker's job)", () => {
    const from = Date.parse("2024-01-01T00:00:00Z");
    const bars = hourBars(from, 30, i => 100 + i); // day 1 full + 6 bars of day 2
    const { dayEndMs, closes } = dailyClosesFromBars(bars);
    expect(dayEndMs).toEqual([from + D, from + 2 * D]);
    expect(closes).toEqual([123, 129]);
  });
});

describe("SimBroker.fetchDailyCloses — causality", () => {
  function brokerWithDaily(now: number): SimBroker {
    const b = new SimBroker(10_000, new Map(), 0, 0, H, { leverage: 1, maintRate: 0.005 });
    const from = Date.parse("2024-01-01T00:00:00Z");
    b.marketTrendDaily = {
      symbol: "BTC/USD",
      dayEndMs: [from + D, from + 2 * D, from + 3 * D],
      closes: [10, 20, 30],
    };
    b.now = now;
    return b;
  }
  const from = Date.parse("2024-01-01T00:00:00Z");

  test("mid-day clock never reveals the in-progress day", async () => {
    const b = brokerWithDaily(from + 2 * D + 7 * H); // 7h into day 3
    expect(await b.fetchDailyCloses("BTC/USD", 5)).toEqual([10, 20]);
    expect(await b.fetchDailyCloses("BTC/USD", 1)).toEqual([20]);
  });

  test("exactly at UTC midnight the just-completed day becomes visible", async () => {
    const b = brokerWithDaily(from + 2 * D);
    expect(await b.fetchDailyCloses("BTC/USD", 5)).toEqual([10, 20]);
  });

  test("clock before the first day end / wrong symbol / no data → []", async () => {
    const b = brokerWithDaily(from + 5 * H);
    expect(await b.fetchDailyCloses("BTC/USD", 5)).toEqual([]);
    expect(await b.fetchDailyCloses("ETH/USD", 5)).toEqual([]);
    const empty = new SimBroker(10_000, new Map(), 0, 0, H, { leverage: 1, maintRate: 0.005 });
    expect(await empty.fetchDailyCloses("BTC/USD", 5)).toEqual([]);
  });
});
