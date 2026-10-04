// Daily-bar stocks sleeve support (2026-09-24, momentum-stocks-horizon-v1
// infrastructure) + TSM horizon axis (lookbackDays/maLengthDays exposed
// through CandidateConfig → ReplayConfig → the engine's tsm config).
//
// GOLDEN RULE (same as backtest-momentum-wf.replayFields.test.ts): any
// config that does not use the new fields must keep its EXACT legacy hash
// (locked literal below), and every legacy code path (5m stocks, 1h crypto)
// must stay byte-identical — the anchored fingerprints in
// scripts/regression-fingerprint.test.ts are the ultimate enforcer.
//
// The daily path's own contract, tested here mechanically:
//   - decision AFTER the close of trading day t (closedIndex hides day t+1),
//   - fill at the OPEN of day t+1 (first bar after the last closed bar —
//     weekends/holidays/DST hour shifts included),
//   - NO lookahead: altering every bar after a cutoff T must not change any
//     trade fully closed well before T (A/B replay comparison).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  annualizationPeriods,
  hashReplayConfig,
  runWithConfig,
  SimBroker,
  validateBarDensity,
  type ReplayConfig,
} from "./backtest-momentum-wf";
import { validateCandidate, candidateToReplayConfig, type ExperimentManifest } from "./walk-forward";
import { gaussian, mulberry32 } from "./lib/syntheticCandles";
import type { OHLCV } from "../src/utils/types";

const DAY = 86_400_000;

const bar = (timestamp: number, open: number, high = open, low = open, close = open): OHLCV =>
  ({ timestamp, open, high, low, close, volume: 1 });

// ── hash identity ─────────────────────────────────────────────────────

// Same literal as backtest-momentum-wf.replayFields.test.ts's baseCfg lock:
// the horizon fields ABSENT must reproduce it bit for bit.
const baseCfg: ReplayConfig = {
  sleeve: "crypto",
  universe: ["BTC/USD"],
  timeframe: "1h",
  source: "binance_futures",
  refSymbol: "BTC/USD",
  rthOnly: false,
  funding: false,
  barMinutes: 60,
  barMinutesEq: 60,
  slippageBps: 5,
  commissionBps: 4,
  initialEquity: 10_000,
  leverage: 2,
  hardStopPct: 0.04,
  cadenceMin: 240,
  notionalPctPerSlot: 0.25,
  entryPct: 5,
  exitPct: -2,
  maxLongs: 2,
  maxShorts: 0,
  shortFunding: "credit",
  warmupDays: 32,
  dbPath: "./data/historical.db",
};

describe("hash identity — lookbackDays / maLengthDays", () => {
  test("absent horizon fields preserve the locked legacy hash", () => {
    expect(hashReplayConfig(baseCfg)).toBe(
      "f9a47ce455bc052223443b03be886d446d29e05d4362cc20233b5fd05ccf738f",
    );
    expect(hashReplayConfig({ ...baseCfg, lookbackDays: undefined, maLengthDays: undefined })).toBe(
      hashReplayConfig(baseCfg),
    );
  });

  test("present horizon fields change the hash; different horizons differ from each other", () => {
    const legacy = hashReplayConfig(baseCfg);
    const h126 = hashReplayConfig({ ...baseCfg, lookbackDays: 126, maLengthDays: 200 });
    const h252 = hashReplayConfig({ ...baseCfg, lookbackDays: 252, maLengthDays: 200 });
    expect(h126).not.toBe(legacy);
    expect(h252).not.toBe(legacy);
    expect(h126).not.toBe(h252);
  });
});

// ── walk-forward candidate surface ────────────────────────────────────

const miniManifest = (candidates: unknown[]): ExperimentManifest => ({
  name: "t",
  sleeve: "stocks",
  trialAccounting: { priorUniqueTrials: 0, complete: false },
  data: {
    dbPath: "x", source: "alpaca_wide", timeframe: "1d",
    universe: ["SPY", "QQQ"], refSymbol: "SPY", rthOnly: false, funding: false,
    barMinutes: 1440, barMinutesEq: 1440,
  },
  asOf: "2026-01-01",
  window: { from: "2020-01-01", to: "2026-01-01", outerFoldCount: 3, innerFoldCount: 3, purgeYears: 0.25, warmupDays: 420 },
  costs: { base: { slippageBps: 2, commissionBps: 0 }, stress: { slippageBps: 5, commissionBps: 2 } },
  ledger: { initialEquity: 50_000, leverage: 2, hardStopPct: 0.04 },
  candidates: candidates as ExperimentManifest["candidates"],
  acceptance: {},
});

const momoCand = {
  name: "h126", cadenceMin: 1440, notionalPctPerSlot: 0.25, entryPct: 5, exitPct: -2,
  maxLongs: 4, maxShorts: 0, lookbackDays: 126, maLengthDays: 200,
};

describe("CandidateConfig horizon axis", () => {
  test("accepted on momentum candidates and passed through to ReplayConfig", () => {
    expect(() => validateCandidate(momoCand)).not.toThrow();
    const cfg = candidateToReplayConfig(miniManifest([momoCand]), momoCand as any, "base");
    expect(cfg.lookbackDays).toBe(126);
    expect(cfg.maLengthDays).toBe(200);
    // Distinct horizon = distinct candidate identity.
    const cfg252 = candidateToReplayConfig(miniManifest([momoCand]), { ...momoCand, lookbackDays: 252 } as any, "base");
    expect(hashReplayConfig(cfg)).not.toBe(hashReplayConfig(cfg252));
  });

  test("absent horizon keys stay absent in the replay config (legacy hash)", () => {
    const { lookbackDays, maLengthDays, ...noHorizon } = momoCand;
    const cfg = candidateToReplayConfig(miniManifest([noHorizon]), noHorizon as any, "base");
    expect(cfg.lookbackDays).toBeUndefined();
    expect(cfg.maLengthDays).toBeUndefined();
  });

  test("rejects non-integer / non-positive horizons", () => {
    expect(() => validateCandidate({ ...momoCand, lookbackDays: 12.5 })).toThrow(/lookbackDays/);
    expect(() => validateCandidate({ ...momoCand, lookbackDays: 0 })).toThrow(/lookbackDays/);
    expect(() => validateCandidate({ ...momoCand, maLengthDays: -30 })).toThrow(/maLengthDays/);
  });

  test("forbidden on meanrev candidates (the meanrev runner would silently ignore them)", () => {
    const mr = {
      name: "mr", cadenceMin: 1440, lookbackDays: 126,
      meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 },
    };
    expect(() => validateCandidate(mr)).toThrow(/lookbackDays/);
  });
});

// ── annualization ─────────────────────────────────────────────────────

describe("annualizationPeriods — daily stocks cadence", () => {
  test("stocks at daily cadence annualizes at 252, sub-session cadences unchanged", () => {
    expect(annualizationPeriods({ name: "stocks" }, 1440)).toBe(252);
    expect(annualizationPeriods({ name: "stocks" }, 60)).toBe((252 * 390) / 60);
    expect(annualizationPeriods({ name: "stocks" }, 240)).toBe((252 * 390) / 240);
    expect(annualizationPeriods({ name: "crypto" }, 1440)).toBe(365);
    expect(annualizationPeriods({ name: "crypto" }, 60)).toBe(365 * 24);
  });
});

// ── validateBarDensity daily-equity mode ──────────────────────────────

describe("validateBarDensity — daily equity bars (barMinutes 1440, rthOnly=false)", () => {
  // Mon 2024-01-08 → Fri, skip weekend, Mon 2024-01-15 (3-day gap), with a
  // DST-style hour shift on the second week.
  const mon = Date.parse("2024-01-08T05:00:00Z");
  const week1 = [0, 1, 2, 3, 4].map(i => bar(mon + i * DAY, 100));
  const week2 = [7, 8, 9, 10, 11].map(i => bar(mon + i * DAY - 3_600_000, 100)); // hour shift
  const bars = [...week1, ...week2];

  test("accepts weekend gaps, holiday clusters (≤6 days) and DST hour shifts", () => {
    expect(() => validateBarDensity(bars, "SPY", 1440, false, mon, mon + 12 * DAY)).not.toThrow();
    // 4-day holiday cluster (Thu holiday + weekend): Fri..Wed missing.
    const holiday = [...week1.slice(0, 4), bar(mon + 9 * DAY, 100)];
    expect(() => validateBarDensity(holiday, "SPY", 1440, false, mon, mon + 10 * DAY)).not.toThrow();
  });

  test("rejects a hole longer than 6 calendar days", () => {
    const holed = [...week1, bar(mon + 12 * DAY, 100)];
    expect(() => validateBarDensity(holed, "SPY", 1440, false, mon, mon + 13 * DAY)).toThrow(/gap/);
  });

  test("rejects a late start / early end beyond the tolerance", () => {
    expect(() => validateBarDensity(week2, "SPY", 1440, false, mon, mon + 12 * DAY)).toThrow(/first bar/);
    expect(() => validateBarDensity(week1, "SPY", 1440, false, mon, mon + 12 * DAY)).toThrow(/last bar/);
  });

  test("sub-daily behavior untouched: 1h crypto still rejects >1h gaps", () => {
    const hbars = [bar(0, 100), bar(3_600_000, 100), bar(3 * 3_600_000, 100)];
    expect(() => validateBarDensity(hbars, "BTC/USD", 60, false, 0, 4 * 3_600_000)).toThrow(/gap/);
  });
});

// ── SimBroker daily execution: close→next-open across weekends/DST ────

describe("SimBroker.executionPrice — daily stocks path", () => {
  const thu = Date.parse("2024-01-04T05:00:00Z");
  const fri = thu + DAY;
  const nextMon = thu + 4 * DAY;
  const candles = new Map<string, OHLCV[]>([
    ["AAA", [bar(thu, 100, 101, 99, 100), bar(fri, 102, 103, 101, 102), bar(nextMon, 110, 111, 109, 110)]],
  ]);

  test("a Friday-close decision fills at MONDAY's open (no fill lost to the weekend gap)", async () => {
    const broker = new SimBroker(50_000, candles, 0, 0, DAY, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = fri + DAY; // decision time: close of Friday's daily bar
    const res = await broker.openPosition({ symbol: "AAA", side: "buy", notionalUsd: 10_000 });
    expect(res.ok).toBe(true);
    expect(broker.positions[0].entryPrice).toBe(110); // Monday open, 0 slippage
  });

  test("a DST hour shift on the next bar still fills at that bar's open", async () => {
    const dstCandles = new Map<string, OHLCV[]>([
      ["AAA", [bar(thu, 100), bar(thu + DAY - 3_600_000, 105, 106, 104, 105)]], // next bar 23h later
    ]);
    const broker = new SimBroker(50_000, dstCandles, 0, 0, DAY, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = thu + DAY;
    const res = await broker.openPosition({ symbol: "AAA", side: "buy", notionalUsd: 10_000 });
    expect(res.ok).toBe(true);
    expect(broker.positions[0].entryPrice).toBe(105);
  });

  test("no execution bar after the decision bar ⇒ no fill (fail closed, no lookback fill)", async () => {
    const tailCandles = new Map<string, OHLCV[]>([["AAA", [bar(thu, 100)]]]);
    const broker = new SimBroker(50_000, tailCandles, 0, 0, DAY, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = thu + DAY;
    const res = await broker.openPosition({ symbol: "AAA", side: "buy", notionalUsd: 10_000 });
    expect(res.ok).toBe(false);
  });

  test("sub-daily stocks path unchanged: exact-timestamp execution bar required", async () => {
    const m5 = 300_000;
    const c5 = new Map<string, OHLCV[]>([["AAA", [bar(0, 100), bar(m5, 101), bar(2 * m5, 102)]]]);
    const broker = new SimBroker(50_000, c5, 0, 0, m5, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = m5; // bar at exactly `now` exists → its open fills
    const res = await broker.openPosition({ symbol: "AAA", side: "buy", notionalUsd: 10_000 });
    expect(res.ok).toBe(true);
    expect(broker.positions[0].entryPrice).toBe(101);
  });
});

// ── full daily replay: trading-calendar tape, no-leakage A/B ──────────

interface DailySpec { symbol: string; seed: number; startPrice: number; driftAnnual: number; volAnnual: number }

const DAILY_SPECS: DailySpec[] = [
  { symbol: "DSA", seed: 71, startPrice: 400, driftAnnual: 0.35, volAnnual: 0.25 },
  { symbol: "DSB", seed: 72, startPrice: 120, driftAnnual: 0.55, volAnnual: 0.40 },
  { symbol: "DSC", seed: 73, startPrice: 45, driftAnnual: -0.10, volAnnual: 0.35 },
  { symbol: "DSD", seed: 74, startPrice: 800, driftAnnual: 0.25, volAnnual: 0.30 },
];

/** GBM daily bars on TRADING days only (Mon–Fri, 05:00Z timestamps —
 *  the alpaca_wide convention), written in the production table shape. */
function writeTradingDayDb(dbPath: string, fromMs: number, tradingDays: number, specs: DailySpec[], scaleAfterMs?: number, scale = 1): Map<string, OHLCV[]> {
  const db = new Database(dbPath);
  const out = new Map<string, OHLCV[]>();
  try {
    db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
      symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      PRIMARY KEY(symbol, timeframe, source, timestamp)
    )`);
    const stmt = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
    for (const spec of specs) {
      const rng = mulberry32(spec.seed);
      const dt = 1 / 252;
      let prevClose = spec.startPrice;
      let t = fromMs;
      const bars: OHLCV[] = [];
      db.transaction(() => {
        for (let i = 0; i < tradingDays; ) {
          const dow = new Date(t).getUTCDay();
          if (dow === 0 || dow === 6) { t += DAY; continue; }
          const z = gaussian(rng);
          const close = prevClose * Math.exp((spec.driftAnnual - spec.volAnnual ** 2 / 2) * dt + spec.volAnnual * Math.sqrt(dt) * z);
          const open = prevClose;
          const high = Math.max(open, close) * 1.004;
          const low = Math.min(open, close) * 0.996;
          const k = scaleAfterMs !== undefined && t >= scaleAfterMs ? scale : 1;
          const b = bar(t, open * k, high * k, low * k, close * k);
          stmt.run(spec.symbol, "1d", "synthetic", b.timestamp, b.open, b.high, b.low, b.close, 1);
          bars.push(b);
          prevClose = close;
          t += DAY;
          i++;
        }
      })();
      out.set(spec.symbol, bars);
    }
  } finally {
    db.close();
  }
  return out;
}

function dailyCfg(dbPath: string): ReplayConfig {
  return {
    sleeve: "stocks",
    universe: DAILY_SPECS.map(s => s.symbol),
    timeframe: "1d",
    source: "synthetic",
    refSymbol: "DSA",
    rthOnly: false,
    funding: false,
    barMinutes: 1440,
    barMinutesEq: 1440,
    slippageBps: 0, // exact-fill assertions below
    commissionBps: 0,
    initialEquity: 50_000,
    leverage: 2,
    hardStopPct: 0.04,
    hardStop: { mode: "volScaled", kSigma: 3, lookbackBars: 20, minPct: 2, maxPct: 12 },
    cadenceMin: 1440,
    notionalPctPerSlot: 0.25,
    entryPct: 5,
    exitPct: -2,
    maxLongs: 2,
    maxShorts: 0,
    lookbackDays: 60,
    maLengthDays: 100,
    shortFunding: "credit",
    tsmTrail: { kSigma: 3, lookbackBars: 20, minPct: 2, maxPct: 12 },
    sharpeGate: { lookbackDays: 30, minSharpe: 0 },
    slotHysteresis: true,
    warmupDays: 240,
    dbPath,
  };
}

const TAPE_FROM = Date.parse("2022-01-03T05:00:00Z"); // a Monday
const WIN = { label: "daily", from: "2022-11-01", to: "2024-06-01" };

describe("daily stocks replay — end to end", () => {
  test("runs, trades, and every fill is the open of the first bar AFTER the decision bar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-daily-"));
    try {
      const dbPath = join(dir, "historical.db");
      const barsBySym = writeTradingDayDb(dbPath, TAPE_FROM, 700, DAILY_SPECS);
      const r = await runWithConfig(dailyCfg(dbPath), WIN);
      expect(r).not.toBeNull();
      expect(r!.trades).toBeGreaterThanOrEqual(3); // anti-vacuity
      expect(Number.isFinite(r!.sharpe)).toBe(true);
      expect(r!.ruined).toBe(false);

      // Mechanical close→next-open/no-lookahead check on EVERY trade with
      // entry metadata: with 0 slippage the recorded entryPrice must equal
      // the OPEN of the first bar strictly after the last bar CLOSED at the
      // decision time (entryAt), and that bar must start at/after entryAt −
      // i.e. the decision never bought at a price it could already see.
      let checked = 0;
      for (const t of r!.closedTrades) {
        if (t.entryAt === undefined || t.entryPrice === undefined || t.reason === "fold_end") continue;
        const bars = barsBySym.get(t.symbol)!;
        // last closed bar at entryAt: timestamp + 1d <= entryAt
        let lastClosed = -1;
        for (let i = 0; i < bars.length; i++) if (bars[i].timestamp + DAY <= t.entryAt!) lastClosed = i;
        expect(lastClosed).toBeGreaterThanOrEqual(0);
        const exec = bars[lastClosed + 1];
        expect(exec).toBeDefined();
        expect(t.entryPrice).toBeCloseTo(exec.open, 10);
        expect(exec.timestamp).toBeGreaterThan(bars[lastClosed].timestamp);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("NO LEAKAGE: rescaling every bar after a cutoff leaves all earlier-closed trades and equity bit-identical", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "wf-daily-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "wf-daily-b-"));
    try {
      const cutoff = Date.parse("2023-10-02T00:00:00Z");
      const dbA = join(dirA, "historical.db");
      const dbB = join(dirB, "historical.db");
      writeTradingDayDb(dbA, TAPE_FROM, 700, DAILY_SPECS);
      writeTradingDayDb(dbB, TAPE_FROM, 700, DAILY_SPECS, cutoff, 1.5); // future ×1.5

      const a = await runWithConfig(dailyCfg(dbA), WIN);
      const b = await runWithConfig(dailyCfg(dbB), WIN);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();

      // Trades whose whole life (incl. the next-open exit fill) settled
      // safely before the cutoff must be identical in both runs.
      const margin = 5 * DAY;
      const key = (t: { symbol: string; side: string; pnl: number; entryAt?: number; exitAt: number }) =>
        `${t.symbol}|${t.side}|${t.pnl.toFixed(8)}|${t.entryAt}|${t.exitAt}`;
      const early = (ts: { exitAt: number }[]) => ts.filter(t => t.exitAt <= cutoff - margin);
      expect(early(b!.closedTrades).map(key)).toEqual(early(a!.closedTrades).map(key));
      expect(early(a!.closedTrades).length).toBeGreaterThan(0); // the comparison is non-vacuous

      // Equity curve before the cutoff must also be identical.
      const eqA = a!.equityHistory.filter(p => p.t <= cutoff - margin);
      const eqB = b!.equityHistory.filter(p => p.t <= cutoff - margin);
      expect(eqB).toEqual(eqA);
      expect(eqA.length).toBeGreaterThan(50);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  }, 120_000);
});
