// New surface added on top of the pre-existing backtest-momentum-wf.ts
// contract (see scripts/backtest-momentum-wf.test.ts for the base suite):
//   1. maxGrossExposureMult passthrough to the real MomentumEngine.
//   2. shortFunding actually read per-instance by SimBroker.applyFunding
//      (previously a hashed-but-dead config field — see applyFunding).
//   3. regime passthrough (merged over the always-injected barMinutes).
//   4. turnoverAnnual / displacementCloses / gateBlocks on ReplayResult.
//
// GOLDEN RULE enforced throughout: hashReplayConfig(cfg) for any config that
// doesn't use these new fields must equal the SAME hash as before this file
// existed (locked below as a literal), and every new field is absent =
// legacy hash, present = distinct hash (same pattern as HardStopSpec /
// marginInterest / cooldownBarsAfterStop in scripts/backtest-momentum-wf.test.ts).

import { describe, expect, test } from "bun:test";
import {
  aggregateGateBlocks,
  computeTurnoverAnnual,
  FundingBook,
  hashReplayConfig,
  normalizeGateReason,
  runWithConfig,
  SimBroker,
  SLOT_DISPLACED_CLOSE_REASON,
  type ReplayConfig,
} from "./backtest-momentum-wf";
import { TRAIL_STOP_CLOSE_REASON } from "../src/strategies/momentum/MomentumEngine";
import type { OHLCV } from "../src/utils/types";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bar = (timestamp: number, open: number, high = open, low = open, close = open): OHLCV =>
  ({ timestamp, open, high, low, close, volume: 1 });

// Same shape as scripts/backtest-momentum-wf.test.ts's "A3/B2 hash identity"
// baseCfg — deliberately duplicated (not imported) so this file's identity
// lock is self-contained and independent of the other file's edits.
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

describe("hash identity — maxGrossExposureMult / regime / slotHysteresis", () => {
  test("LOCKED: baseCfg's hash today (fixed literal — any future drift here is a real hash break)", () => {
    expect(hashReplayConfig(baseCfg)).toBe(
      "f9a47ce455bc052223443b03be886d446d29e05d4362cc20233b5fd05ccf738f",
    );
  });

  test("absent new fields (undefined explicit or omitted) preserve the locked hash", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({
      ...baseCfg,
      maxGrossExposureMult: undefined,
      regime: undefined,
      slotHysteresis: undefined,
    })).toBe(legacy);
  });

  test("maxGrossExposureMult present changes the hash", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({ ...baseCfg, maxGrossExposureMult: 2 })).not.toBe(legacy);
  });

  test("regime present (even an empty-effect enabled:false) changes the hash", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({ ...baseCfg, regime: { enabled: false } })).not.toBe(legacy);
  });

  test("slotHysteresis present changes the hash", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({ ...baseCfg, slotHysteresis: true })).not.toBe(legacy);
  });

  test("two candidates differing ONLY in one new field hash differently from each other too", () => {
    const a = hashReplayConfig({ ...baseCfg, maxGrossExposureMult: 2 });
    const b = hashReplayConfig({ ...baseCfg, maxGrossExposureMult: 3 });
    expect(a).not.toBe(b);
  });
});

describe("shortFunding actually reaches SimBroker.applyFunding (was hashed but dead)", () => {
  function makeFundingDb(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)").run("BTCUSDT", 8 * 3_600_000, 0.0001);
    db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)").run("BTCUSDT", 16 * 3_600_000, 0.0001);
    db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)").run("BTCUSDT", 24 * 3_600_000, 0.0001);
    return db;
  }
  const candles = new Map([["BTC/USD", [
    bar(0, 50_000, 50_000, 50_000, 50_000),
    bar(60 * 60_000, 50_000, 50_000, 50_000, 50_000),
    bar(22 * 60 * 60_000, 50_000, 50_000, 50_000, 50_000),
  ]]]);

  test("credit mode: short RECEIVES positive funding (per-instance, not the module CLI default)", async () => {
    const db = makeFundingDb();
    const book = new FundingBook(db, ["BTC/USD"], 0, 24 * 3_600_000);
    const broker = new SimBroker(10_000, candles, 0, 0, 60 * 60_000, { leverage: 2, maintRate: 0.005 }, 0.04, book, false, undefined, 1, 0, 0, "credit");
    broker.now = 60 * 60_000;
    await broker.openPosition({ symbol: "BTC/USD", side: "sell", notionalUsd: 2_000 });
    broker.applyFunding(60 * 60_000, 22 * 60 * 60_000);
    expect(broker.fundingPaid).toBeCloseTo(-0.20, 1e-6); // negative = received
    expect(broker.cash).toBeCloseTo(10_000 + 0.20, 1e-6);
  });

  test("zero mode: short pays/receives NOTHING — same position, same event, different cash outcome", async () => {
    const db = makeFundingDb();
    const book = new FundingBook(db, ["BTC/USD"], 0, 24 * 3_600_000);
    const broker = new SimBroker(10_000, candles, 0, 0, 60 * 60_000, { leverage: 2, maintRate: 0.005 }, 0.04, book, false, undefined, 1, 0, 0, "zero");
    broker.now = 60 * 60_000;
    await broker.openPosition({ symbol: "BTC/USD", side: "sell", notionalUsd: 2_000 });
    broker.applyFunding(60 * 60_000, 22 * 60 * 60_000);
    expect(broker.fundingPaid).toBe(0);
    expect(broker.cash).toBeCloseTo(10_000, 1e-6);
  });

  test("constructor default (no explicit shortFundingMode) matches the module CLI constant, unchanged for every pre-existing direct SimBroker call site", async () => {
    const db = makeFundingDb();
    const book = new FundingBook(db, ["BTC/USD"], 0, 24 * 3_600_000);
    const broker = new SimBroker(10_000, candles, 0, 0, 60 * 60_000, { leverage: 2, maintRate: 0.005 }, 0.04, book, false);
    broker.now = 60 * 60_000;
    await broker.openPosition({ symbol: "BTC/USD", side: "sell", notionalUsd: 2_000 });
    broker.applyFunding(60 * 60_000, 22 * 60 * 60_000);
    // Default CLI is "credit" (see argOf("--shortfunding") ?? "credit").
    expect(broker.fundingPaid).toBeCloseTo(-0.20, 1e-6);
  });
});

describe("shortFunding through the real replay loop (runWithConfig) — two configs, one field, different results", () => {
  function seedDowntrend(dbPath: string, fromMs: number, toMs: number, warmupDays: number) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
      const barStmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const fundStmt = db.prepare("INSERT OR REPLACE INTO funding_rates VALUES (?,?,?)");
      const seedFrom = fromMs - (warmupDays + 5) * 86_400_000;
      const seedTo = toMs + 2 * 86_400_000;
      let price = 100;
      db.transaction(() => {
        for (let t = seedFrom; t <= seedTo; t += 3_600_000) {
          barStmt.run("BTC/USD", "1h", "binance_futures", t, price, price * 1.0002, price * 0.9993, price, 1);
          // Positive rate every hour: longs pay, shorts receive in "credit"
          // mode and get nothing in "zero" mode — exactly the axis under test.
          fundStmt.run("BTCUSDT", t, 0.001);
          price *= 0.9993; // steady downtrend: TSM opens a short and holds
        }
      })();
    } finally {
      db.close();
    }
  }

  const mkCfg = (dbPath: string, shortFunding: "credit" | "zero"): ReplayConfig => ({
    sleeve: "crypto", universe: ["BTC/USD"], timeframe: "1h", source: "binance_futures",
    refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60,
    slippageBps: 0, commissionBps: 0, initialEquity: 10_000, leverage: 2, hardStopPct: 0.5,
    cadenceMin: 60, notionalPctPerSlot: 0.25, entryPct: 5, exitPct: -2, maxLongs: 0,
    maxShorts: 1, shortFunding, warmupDays: 40, dbPath,
  });

  test("credit vs zero, shorts held through real funding events, produce different finalEquity/funding", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-shortfunding-loop-"));
    const dbPath = join(tmpDir, "historical.db");
    try {
      const fromMs = Date.parse("2024-03-10T00:00:00Z");
      const toMs = fromMs + 3 * 86_400_000;
      seedDowntrend(dbPath, fromMs, toMs, 40);
      const win = { label: "test", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };

      const credit = await runWithConfig(mkCfg(dbPath, "credit"), win);
      const zero = await runWithConfig(mkCfg(dbPath, "zero"), win);
      expect(credit).not.toBeNull();
      expect(zero).not.toBeNull();

      // Sanity: the downtrend must have actually opened a short — otherwise
      // this test would trivially pass without exercising the axis at all.
      const shortTrades = [...credit!.closedTrades, ...zero!.closedTrades].filter(t => t.side === "sell");
      expect(shortTrades.length).toBeGreaterThan(0);

      expect(credit!.funding).not.toBe(zero!.funding);
      expect(credit!.finalEquity).not.toBe(zero!.finalEquity);
      // Credit mode pays the short a positive-rate credit; zero mode doesn't
      // — credit must end up strictly ahead.
      expect(credit!.finalEquity).toBeGreaterThan(zero!.finalEquity);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("maxGrossExposureMult reaches the real MomentumEngine (prod-parity gap closed)", () => {
  function seedTwoSymbolUptrend(dbPath: string, fromMs: number, toMs: number, warmupDays: number) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const barStmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const seedFrom = fromMs - (warmupDays + 5) * 86_400_000;
      const seedTo = toMs + 2 * 86_400_000;
      db.transaction(() => {
        for (const sym of ["A/USD", "B/USD"]) {
          let price = 100;
          for (let t = seedFrom; t <= seedTo; t += 3_600_000) {
            barStmt.run(sym, "1h", "binance_futures", t, price, price * 1.0002, price * 0.9998, price, 1);
            price *= 1.0007;
          }
        }
      })();
    } finally {
      db.close();
    }
  }

  const mkCfg = (dbPath: string, maxGrossExposureMult?: number): ReplayConfig => ({
    sleeve: "crypto", universe: ["A/USD", "B/USD"], timeframe: "1h", source: "binance_futures",
    refSymbol: "A/USD", rthOnly: false, funding: false, barMinutes: 60, barMinutesEq: 60,
    slippageBps: 0, commissionBps: 0, initialEquity: 10_000, leverage: 1, hardStopPct: 0.5,
    cadenceMin: 60, notionalPctPerSlot: 0.5, entryPct: 5, exitPct: -2, maxLongs: 2,
    maxShorts: 0, shortFunding: "credit", warmupDays: 40, dbPath, maxGrossExposureMult,
  });

  test("a low cap blocks the second same-tick open that an absent cap allows", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-grosscap-loop-"));
    const dbPath = join(tmpDir, "historical.db");
    try {
      const fromMs = Date.parse("2024-03-10T00:00:00Z");
      const toMs = fromMs + 3 * 86_400_000;
      seedTwoSymbolUptrend(dbPath, fromMs, toMs, 40);
      const win = { label: "test", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };

      // 2 slots × 50% notional at leverage 1 = 100% of equity gross if both
      // fill. A 0.6× cap admits the first ($5,000) but not the second
      // (5,000+5,000=10,000 > 6,000) on the tick they'd both first qualify.
      const uncapped = await runWithConfig(mkCfg(dbPath), win);
      const capped = await runWithConfig(mkCfg(dbPath, 0.6), win);
      expect(uncapped).not.toBeNull();
      expect(capped).not.toBeNull();

      // Every open in this uptrend eventually closes at fold_end (no signal
      // flip, no stop), so total closedTrades count == total opens for this
      // scenario — a direct, robust signal that the cap blocked an open.
      expect(capped!.closedTrades.length).toBeLessThan(uncapped!.closedTrades.length);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("displacementCloses — counts SLOT_DISPLACED closes only", () => {
  // `reason` stays the legacy SimBroker classification ("rebalance") byte
  // for byte — scripts/regression-fingerprint.test.ts hashes it
  // (tradesSha256 over symbol|side|pnl|exitAt|reason). The engine's own
  // canonical label travels on the SEPARATE `engineCloseReason` field
  // instead (see ClosedTrade's docstring in backtest-momentum-wf.ts);
  // displacementCloses is computed from THAT field, not `reason`.
  test("a SLOT_DISPLACED close counts; a TRAIL_STOP close of the same broker does not", async () => {
    const candles = new Map([
      ["A", [bar(0, 100), bar(60_000, 100), bar(120_000, 100)]],
      ["B", [bar(0, 100), bar(60_000, 100), bar(120_000, 100)]],
    ]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 });
    broker.now = 60_000;
    await broker.openPosition({ symbol: "A", side: "buy", notionalUsd: 1_000 });
    await broker.openPosition({ symbol: "B", side: "buy", notionalUsd: 1_000 });
    broker.now = 120_000;
    await broker.closePosition({ symbol: "A", side: "buy", closeReason: SLOT_DISPLACED_CLOSE_REASON });
    await broker.closePosition({ symbol: "B", side: "buy", closeReason: TRAIL_STOP_CLOSE_REASON });

    // `reason` is unaffected by closeReason — always "rebalance" for a
    // closePosition() call (the fingerprint-anchored legacy behavior).
    expect(broker.closed.find(t => t.symbol === "A")!.reason).toBe("rebalance");
    expect(broker.closed.find(t => t.symbol === "B")!.reason).toBe("rebalance");
    expect(broker.closed.find(t => t.symbol === "A")!.engineCloseReason).toBe(SLOT_DISPLACED_CLOSE_REASON);
    expect(broker.closed.find(t => t.symbol === "B")!.engineCloseReason).toBe(TRAIL_STOP_CLOSE_REASON);

    const displacementCloses = broker.closed.filter(t => t.engineCloseReason === SLOT_DISPLACED_CLOSE_REASON).length;
    expect(displacementCloses).toBe(1);
  });

  test("a signal-flip close (no closeReason) has no engineCloseReason — never miscounted as displacement", async () => {
    const candles = new Map([["A", [bar(0, 100), bar(60_000, 100), bar(120_000, 100)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 });
    broker.now = 60_000;
    await broker.openPosition({ symbol: "A", side: "buy", notionalUsd: 1_000 });
    broker.now = 120_000;
    await broker.closePosition({ symbol: "A", side: "buy" });

    expect(broker.closed[0].reason).toBe("rebalance");
    expect(broker.closed[0].engineCloseReason).toBeUndefined();
    expect(broker.closed.filter(t => t.engineCloseReason === SLOT_DISPLACED_CLOSE_REASON).length).toBe(0);
  });
});

describe("turnoverAnnual — SimBroker.turnoverNotional accounting + computeTurnoverAnnual", () => {
  test("computeTurnoverAnnual on a synthetic fixture: 2 opens + 2 closes, known notionals/equity/window", () => {
    // opens: 1,000 + 2,000 ; closes: 1,050 + 1,900 → Σ|notional| = 5,950
    const turnoverNotional = 1_000 + 2_000 + 1_050 + 1_900;
    const equityHistory = [{ t: 0, eq: 10_000 }];
    const oneYearMs = 365 * 86_400_000;
    expect(computeTurnoverAnnual(turnoverNotional, equityHistory, 0, oneYearMs, 10_000)).toBeCloseTo(0.595, 6);
  });

  test("empty equityHistory falls back to initialEquity for the mean", () => {
    const oneYearMs = 365 * 86_400_000;
    expect(computeTurnoverAnnual(1_000, [], 0, oneYearMs, 5_000)).toBeCloseTo(0.2, 6);
  });

  test("half a year window doubles the annualized rate for the same turnover", () => {
    const halfYearMs = 182.5 * 86_400_000;
    expect(computeTurnoverAnnual(1_000, [{ t: 0, eq: 10_000 }], 0, halfYearMs, 10_000)).toBeCloseTo(0.2, 6);
  });

  test("SimBroker accumulates turnoverNotional across an open + close pair using EXECUTION price (slippage included)", async () => {
    const candles = new Map([["A", [bar(0, 100, 100, 100, 100), bar(60_000, 100, 100, 100, 100), bar(120_000, 110, 110, 110, 110)]]]);
    const broker = new SimBroker(10_000, candles, 100 /* 1% slippage bps... */, 0, 60_000, { leverage: 1, maintRate: 0.25 });
    broker.now = 60_000;
    await broker.openPosition({ symbol: "A", side: "buy", notionalUsd: 1_000 });
    const openNotional = broker.positions[0].qty * broker.positions[0].entryPrice;
    broker.now = 120_000;
    await broker.closePosition({ symbol: "A", side: "buy" });
    const closeNotional = broker.closed[0].qty! * broker.closed[0].exitPrice!;
    expect(broker.turnoverNotional).toBeCloseTo(openNotional + closeNotional, 6);
  });
});

describe("gateBlocks — normalizeGateReason + aggregateGateBlocks", () => {
  test("normalizeGateReason strips numeric/timestamp noise into stable prefixes", () => {
    expect(normalizeGateReason("volatility spike: realized vol 3.00× baseline (cap 2.5×)")).toBe("volatility spike");
    expect(normalizeGateReason("correlation collapse: average pairwise corr 0.90 (ceiling 0.85)")).toBe("correlation collapse");
    expect(normalizeGateReason("soft drawdown 12.3% — paused 24h")).toBe("soft drawdown");
    expect(normalizeGateReason("daily loss cap 3.50% — paused until 2026-09-08T00:00:00.000Z")).toBe("daily loss cap");
    expect(normalizeGateReason("sharpe gate: 0.12 < 0 (30d)")).toBe("sharpe gate");
  });

  test("two distinct reasons aggregate into two distinct, correctly-counted buckets", () => {
    const reasons: Array<string | undefined> = [
      "soft drawdown 12.3% — paused 24h",
      undefined, // an unblocked tick — must be ignored, not counted as its own bucket
      "soft drawdown 15.0% — paused 24h", // same normalized bucket as above, different raw string
      "sharpe gate: 0.12 < 0 (30d)",
      "volatility spike: realized vol 3.00× baseline (cap 2.5×)",
      "sharpe gate: 0.05 < 0 (30d)",
    ];
    expect(aggregateGateBlocks(reasons)).toEqual({
      "soft drawdown": 2,
      "sharpe gate": 2,
      "volatility spike": 1,
    });
  });

  test("empty/all-undefined input aggregates to an empty object", () => {
    expect(aggregateGateBlocks([undefined, undefined])).toEqual({});
  });
});

describe("ReplayResult always carries turnoverAnnual/displacementCloses/gateBlocks (never undefined)", () => {
  function seedTrendTape(dbPath: string, fromMs: number, toMs: number, warmupDays: number) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      let price = 100;
      db.transaction(() => {
        for (let t = fromMs - (warmupDays + 5) * 86_400_000; t <= toMs + 2 * 86_400_000; t += 3_600_000) {
          stmt.run("BTC/USD", "1h", "binance_futures", t, price, price * 1.0002, price * 0.9998, price, 1);
          price *= 1.0007;
        }
      })();
    } finally {
      db.close();
    }
  }

  test("a normal uptrend fold returns finite, correctly-shaped values for all three new fields", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-newfields-shape-"));
    const dbPath = join(tmpDir, "historical.db");
    try {
      const fromMs = Date.parse("2024-03-10T00:00:00Z");
      const toMs = fromMs + 3 * 86_400_000;
      seedTrendTape(dbPath, fromMs, toMs, 40);
      const win = { label: "test", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
      const cfg: ReplayConfig = {
        sleeve: "crypto", universe: ["BTC/USD"], timeframe: "1h", source: "binance_futures",
        refSymbol: "BTC/USD", rthOnly: false, funding: false, barMinutes: 60, barMinutesEq: 60,
        slippageBps: 0, commissionBps: 0, initialEquity: 10_000, leverage: 2, hardStopPct: 0.04,
        cadenceMin: 60, notionalPctPerSlot: 0.25, entryPct: 5, exitPct: -2, maxLongs: 1,
        maxShorts: 0, shortFunding: "credit", warmupDays: 40, dbPath,
      };
      const result = await runWithConfig(cfg, win);
      expect(result).not.toBeNull();
      expect(result!.trades).toBeGreaterThan(0);

      expect(Number.isFinite(result!.turnoverAnnual)).toBe(true);
      expect(result!.turnoverAnnual).toBeGreaterThan(0); // a trending single-symbol book that trades must turn over

      expect(result!.displacementCloses).toBe(0); // single symbol, single slot: no ranking displacement possible

      expect(typeof result!.gateBlocks).toBe("object");
      expect(result!.gateBlocks).not.toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
