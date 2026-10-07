import { describe, expect, test } from "bun:test";
import {
  annualizationPeriods,
  canonicalJson,
  FundingBook,
  getHdb,
  hardStopFillPrice,
  hashReplayConfig,
  latestCommonAsOf,
  liquidateAtFoldEnd,
  runWithConfig,
  seedStopFraction,
  seedTrailMark,
  SimBroker,
  SLEEVES,
  type ReplayConfig,
  type SeedPosition,
} from "./backtest-momentum-wf";
import { INITIAL_RISK_STATE } from "../src/strategies/momentum/RiskGuard";
import { TRAIL_STOP_CLOSE_REASON } from "../src/strategies/momentum/MomentumEngine";
import type { OHLCV } from "../src/utils/types";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bar = (timestamp: number, open: number, high = open, low = open, close = open): OHLCV =>
  ({ timestamp, open, high, low, close, volume: 1 });

describe("backtest-momentum-wf fidelity helpers", () => {
  test("market execution uses the next bar open, not the just-completed close", async () => {
    const candles = new Map([["SPY", [bar(0, 99, 101, 98, 100), bar(60_000, 105, 106, 104, 106)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 });
    broker.now = 60_000;

    const res = await broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 1_050 });

    expect(res.ok).toBe(true);
    expect(broker.positions[0].entryPrice).toBe(105);
  });

  test("hard stop fills on intrabar low at stop price", () => {
    const fill = hardStopFillPrice(
      { side: "buy", entryPrice: 100 },
      bar(0, 100, 101, 95, 99),
      0.04,
    );

    expect(fill).toBe(96);
  });

  test("hard stop gap fills at the gap open", () => {
    const fill = hardStopFillPrice(
      { side: "buy", entryPrice: 100 },
      bar(0, 90, 92, 89, 91),
      0.04,
    );

    expect(fill).toBe(90);
  });

  test("stock Sharpe annualization uses RTH periods, not 24/7 hours", () => {
    expect(annualizationPeriods({ name: "stocks" }, 60)).toBe(252 * 390 / 60);
    expect(annualizationPeriods({ name: "crypto" }, 60)).toBe(365 * 24);
  });

  test("rolling candle windows match fresh slices as replay time advances", async () => {
    const series = Array.from({ length: 10 }, (_, i) => bar(i * 60_000, 100 + i));
    const broker = new SimBroker(10_000, new Map([["A", series]]), 0, 0, 60_000, { leverage: 1, maintRate: 0.25 });
    broker.now = 5 * 60_000;
    expect((await broker.fetchCandles("A", 3)).map(x => x.timestamp)).toEqual([2, 3, 4].map(x => x * 60_000));
    broker.now = 7 * 60_000;
    expect((await broker.fetchCandles("A", 3)).map(x => x.timestamp)).toEqual([4, 5, 6].map(x => x * 60_000));
    broker.now = 3 * 60_000;
    expect((await broker.fetchCandles("A", 3)).map(x => x.timestamp)).toEqual([0, 1, 2].map(x => x * 60_000));
  });
});

describe("RiskGuard realised-pnl window: every close counted exactly once, in live order (2026-10-03)", () => {
  const H = 60_000;

  test("an engine close made during tick t is counted by the NEXT tick's read (anchor = t) — it used to be invisible forever", async () => {
    const candles = new Map([["A", [bar(0, 100), bar(H, 100), bar(2 * H, 110), bar(3 * H, 110)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, H, { leverage: 1, maintRate: 0.25 });
    broker.now = H;
    expect((await broker.openPosition({ symbol: "A", side: "buy", notionalUsd: 1_000 })).ok).toBe(true);
    broker.now = 2 * H;
    expect((await broker.closePosition({ symbol: "A", side: "buy", closeReason: "SLOT_DISPLACED" })).ok).toBe(true);

    const close = broker.closed[0];
    expect(close.exitAt).toBe(2 * H + 1); // after the decision instant, like a live fill
    expect(close.pnl).toBeGreaterThan(0);
    // Tick 3H reads "since the anchor 2H" — the winning close resets a live streak, so it must here too.
    expect(await broker.getRealisedPnlSince(2 * H)).toBeCloseTo(close.pnl, 9);
  });

  test("a hard stop filled in the bar that closes at t is counted at tick t and never again", async () => {
    const candles = new Map([["B", [bar(0, 100), bar(H, 100), bar(2 * H, 100, 100, 90, 95)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, H, { leverage: 1, maintRate: 0.25 });
    broker.now = H;
    expect((await broker.openPosition({ symbol: "B", side: "buy", notionalUsd: 1_000 })).ok).toBe(true);
    broker.now = 2 * H;
    broker.checkStops(new Map([["B", candles.get("B")![2]]]));

    const stop = broker.closed[0];
    expect(stop.reason).toBe("stop_loss");
    expect(stop.exitAt).toBe(2 * H);
    expect(await broker.getRealisedPnlSince(H)).toBeCloseTo(stop.pnl, 9); // tick 2H's window
    expect(await broker.getRealisedPnlSince(2 * H)).toBe(0);               // tick 3H's: no double count
  });
});

describe("single volatility trail", () => {
  test("SimBroker never applies a trailing stop; engine owns the only trail", () => {
    const candles = new Map([["SPY", [
      bar(0, 100, 100, 100, 100),
      bar(60_000, 105, 105, 105, 105),
      bar(120_000, 96, 96, 96, 96), // would trigger a 3% trail from 105, but not the 4% hard stop
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = 60_000;
    broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 5_000 });
    expect(broker.positions.length).toBe(1);

    broker.now = 120_000;
    broker.checkStops(new Map([["SPY", candles.get("SPY")![2]]]));

    // Hard stop only: 4% below 100 is 96, which is exactly the low; filled.
    expect(broker.positions.length).toBe(0);
    expect(broker.closed[0].reason).toBe("stop_loss");
  });

  test("a 3% trailing stop distance is ignored by SimBroker", () => {
    const candles = new Map([["SPY", [
      bar(0, 100, 100, 100, 100),
      bar(60_000, 105, 105, 105, 105),
      bar(120_000, 101, 101, 101, 101), // 3.8% pullback from 105 would hit a 3% trail
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = 60_000;
    broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 5_000 });

    broker.now = 120_000;
    broker.checkStops(new Map([["SPY", candles.get("SPY")![2]]]));

    expect(broker.positions.length).toBe(1);
  });
});

describe("hard stop axis — SimBroker (stop-sizing sweep)", () => {
  test("volScaled (pinned 3%) holds through −2.6% and stops through −3.2%, where the legacy default is 4%", () => {
    // min=max=3 pins the distance at 3% regardless of realized vol (the
    // MomentumEngine.test.ts pinning pattern); with <2 decision closes the
    // formula fails open to maxPct=3 anyway — deterministic either way.
    const spec = { mode: "volScaled" as const, kSigma: 3, lookbackBars: 10, minPct: 3, maxPct: 3 };
    const candles = new Map([["SPY", [
      bar(0, 100, 100, 100, 100),
      bar(60_000, 100, 100, 100, 100),        // entry executes here at open 100 → stop 97
      bar(120_000, 100, 100, 97.4, 99),       // −2.6% low: above 97, below the legacy 96 → must HOLD
      bar(180_000, 98, 98, 96.8, 97.5),       // −3.2% low: through 97 → fill AT the stop
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true, spec, 78);
    broker.now = 60_000;
    broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 5_000 });
    expect(broker.positions[0].stopFrac).toBeCloseTo(0.03, 12);

    broker.now = 120_000;
    broker.checkStops(new Map([["SPY", candles.get("SPY")![2]]]));
    expect(broker.positions.length).toBe(1); // 97.4 > 97: a 4%-reasoning test would also hold here, so...

    broker.now = 180_000;
    broker.checkStops(new Map([["SPY", candles.get("SPY")![3]]]));
    expect(broker.positions.length).toBe(0); // ...the discriminating bar: 96.8 ≤ 97 but ABOVE the legacy 96
    expect(broker.closed[0].reason).toBe("stop_loss");
    expect(broker.closed[0].pnl).toBeCloseTo((97 - 100) * 50, 9); // qty 50 = 5000/100, fill at 97
  });

  test("mode none never hard-stops — a −10% bar rides", () => {
    const candles = new Map([["SPY", [
      bar(0, 100, 100, 100, 100),
      bar(60_000, 100, 100, 100, 100),
      bar(120_000, 92, 92, 90, 91), // gap −8%, low −10%: any fixed stop fires; none must not
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true, { mode: "none" }, 78);
    broker.now = 60_000;
    broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 5_000 });
    expect(broker.positions[0].stopFrac).toBeNull();

    broker.now = 120_000;
    broker.checkStops(new Map([["SPY", candles.get("SPY")![2]]]));
    expect(broker.positions.length).toBe(1);
    expect(broker.closed.length).toBe(0);
  });

  test("volScaled resolves the entry distance from DECISION closes via the production trailPctFromVol — the execution bar is excluded", async () => {
    const { trailPctFromVol } = await import("../src/strategies/momentum/MomentumEngine");
    const closes = [100, 101, 99, 102, 100, 103];
    const candles = new Map([["A", closes.map((c, i) => bar(i * 60_000, c, c, c, c))]]);
    const spec = { mode: "volScaled" as const, kSigma: 2, lookbackBars: 3, minPct: 0.1, maxPct: 50 };
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true, spec, 24);
    broker.now = 5 * 60_000; // last CLOSED bar = index 4 (close 100); execution bar = index 5 (open 103)
    await broker.openPosition({ symbol: "A", side: "buy", notionalUsd: 5_000 });

    expect(broker.positions[0].entryPrice).toBe(103);
    const expected = trailPctFromVol([101, 99, 102, 100], spec, 24) / 100; // lookbackBars+1 closes through the decision bar
    expect(broker.positions[0].stopFrac).toBeCloseTo(expected, 12);
    const withExecBar = trailPctFromVol([99, 102, 100, 103], spec, 24) / 100; // lookahead variant must NOT match
    expect(Math.abs(broker.positions[0].stopFrac! - withExecBar)).toBeGreaterThan(1e-6);
  });

  test("absent spec preserves the legacy fixed-hardStopPct path byte for byte", () => {
    const candles = new Map([["SPY", [
      bar(0, 100, 100, 100, 100),
      bar(60_000, 100, 100, 100, 100),
      bar(120_000, 97, 97, 95.9, 96.5), // low −4.1%: through the 4% stop at 96
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = 60_000;
    broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 5_000 });
    expect(broker.positions[0].stopFrac).toBeUndefined();

    broker.now = 120_000;
    broker.checkStops(new Map([["SPY", candles.get("SPY")![2]]]));
    expect(broker.positions.length).toBe(0);
    expect(broker.closed[0].pnl).toBeCloseTo((96 - 100) * 50, 9);
  });
});

describe("baseline margin realism", () => {
  test("baseline M=1 rejects an open that would exceed buying power", async () => {
    const candles = new Map([["SPY", [bar(0, 100, 100, 100, 100), bar(60_000, 100, 100, 100, 100)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = 60_000;

    // 2× leverage ⇒ $20k buying power. First $15k slot uses $7.5k margin.
    const first = await broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 15_000 });
    expect(first.ok).toBe(true);
    // Second $15k slot needs another $7.5k margin; total used ($15k) > equity ($10k) ⇒ reject.
    const second = await broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 15_000 });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("margin_insufficient");
    expect(broker.marginRejects).toBe(1);
  });
});

describe("whole-share stock sizing", () => {
  test("stock quantity is floored to whole shares", async () => {
    const candles = new Map([["SPY", [bar(0, 100, 100, 100, 100), bar(60_000, 33.33, 33.33, 33.33, 33.33)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = 60_000;

    const res = await broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 1_000 });

    expect(res.ok).toBe(true);
    expect(broker.positions[0].qty).toBe(30); // floor(1000 / 33.33)
    expect(broker.positions[0].entryMargin).toBeCloseTo(30 * 33.33, 1e-6);
  });

  test("crypto quantity remains fractional", async () => {
    const candles = new Map([["BTC/USD", [bar(0, 100, 100, 100, 100), bar(60_000, 33.33, 33.33, 33.33, 33.33)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.005 }, 0.04);
    broker.now = 60_000;

    const res = await broker.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1_000 });

    expect(res.ok).toBe(true);
    expect(broker.positions[0].qty).toBeCloseTo(1000 / 33.33, 1e-6);
  });
});

describe("funding event accounting", () => {
  function makeFundingDb(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)").run("BTCUSDT", 8 * 3_600_000, 0.0001);
    db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)").run("BTCUSDT", 16 * 3_600_000, -0.0002);
    db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)").run("BTCUSDT", 24 * 3_600_000, 0.0001);
    return db;
  }

  test("long pays positive funding and receives credit on negative rate", () => {
    const db = makeFundingDb();
    const book = new FundingBook(db, ["BTC/USD"], 0, 24 * 3_600_000);
    const candles = new Map([["BTC/USD", [
      bar(0, 50_000, 50_000, 50_000, 50_000),
      bar(60 * 60_000, 50_000, 50_000, 50_000, 50_000),
      bar(12 * 60 * 60_000, 50_000, 50_000, 50_000, 50_000),
      bar(18 * 60 * 60_000, 50_000, 50_000, 50_000, 50_000),
      bar(22 * 60 * 60_000, 50_000, 50_000, 50_000, 50_000),
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60 * 60_000, { leverage: 2, maintRate: 0.005 }, 0.04, book, false);
    broker.now = 60 * 60_000;
    broker.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 2_000 });
    expect(broker.positions[0].qty).toBeCloseTo(0.04, 1e-6);

    broker.applyFunding(60 * 60_000, 22 * 60 * 60_000);

    // +0.01% at 8h: pay 0.04 * 50_000 * 0.0001 = 0.20
    // -0.02% at 16h: receive 0.04 * 50_000 * 0.0002 = 0.40
    expect(broker.fundingPaid).toBeCloseTo(0.20 - 0.40, 1e-6);
    expect(broker.cash).toBeCloseTo(10_000 - 0.20 + 0.40, 1e-6);
  });

  test("short receives positive funding in credit mode", () => {
    const db = makeFundingDb();
    const book = new FundingBook(db, ["BTC/USD"], 0, 24 * 3_600_000);
    const candles = new Map([["BTC/USD", [
      bar(0, 50_000, 50_000, 50_000, 50_000),
      bar(60 * 60_000, 50_000, 50_000, 50_000, 50_000),
      bar(22 * 60 * 60_000, 50_000, 50_000, 50_000, 50_000),
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60 * 60_000, { leverage: 2, maintRate: 0.005 }, 0.04, book, false);
    broker.now = 60 * 60_000;
    broker.openPosition({ symbol: "BTC/USD", side: "sell", notionalUsd: 2_000 });

    broker.applyFunding(60 * 60_000, 22 * 60 * 60_000);

    expect(broker.fundingPaid).toBeCloseTo(-0.20, 1e-6); // paid is negative ⇒ received
    expect(broker.cash).toBeCloseTo(10_000 + 0.20, 1e-6);
  });

  test("FundingBook fails closed when window extends beyond funding coverage", () => {
    const db = makeFundingDb();
    expect(() => new FundingBook(db, ["BTC/USD"], 0, 48 * 3_600_000)).toThrow("funding coverage gap");
  });
});

describe("latest-common boundary", () => {
  test("crypto asOf is limited by funding, stocks asOf by bars", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume INTEGER)`);
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    const stmt = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
    const fundStmt = db.prepare("INSERT INTO funding_rates VALUES (?,?,?)");
    // BTC bar ends at 100h, funding only to 70h.
    stmt.run("BTC/USD", "1h", "binance_futures", 100 * 60 * 60_000, 1, 1, 1, 1, 1);
    fundStmt.run("BTCUSDT", 70 * 60 * 60_000, 0.0001);
    stmt.run("ETH/USD", "1h", "binance_futures", 90 * 60 * 60_000, 1, 1, 1, 1, 1);
    fundStmt.run("ETHUSDT", 80 * 60 * 60_000, 0.0001);

    const cryptoSleeve = SLEEVES.find(s => s.name === "crypto")!;
    // Override universe for the test so it only sees BTC and ETH.
    const testSleeve = { ...cryptoSleeve, universe: ["BTC/USD", "ETH/USD"] };
    const asOf = latestCommonAsOf(testSleeve, db);
    // Bar asOf BTC = 100h + 1h, funding asOf BTC = 70h  => BTC asOf = 70h
    // Bar asOf ETH = 90h  + 1h, funding asOf ETH = 80h  => ETH asOf = 80h
    // Common = min = 70h (in ms)
    expect(asOf).toBe(70 * 60 * 60_000);
  });
});

describe("fold-edge no-fill", () => {
  test("executionPrice returns 0 when there is no next bar", async () => {
    const candles = new Map([["SPY", [bar(0, 100, 100, 100, 100)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 });
    broker.now = 60_000;

    const res = await broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 1_000 });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no price");
  });

  test("executionPrice rejects a hole: the next bar must be exactly the immediate bar", async () => {
    const candles = new Map([["SPY", [bar(0, 100, 100, 100, 100), bar(120_000, 102, 102, 102, 102)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 });
    broker.now = 60_000;

    const res = await broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 1_000 });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no price");
  });

  test("crypto execution rejects a bar that follows a gap", async () => {
    const candles = new Map([["BTC/USD", [
      bar(0, 100, 100, 100, 100),
      bar(60_000, 101, 101, 101, 101),
      bar(180_000, 103, 103, 103, 103), // gap: missing 120_000
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.005 }, 0.04, undefined, false);
    broker.now = 120_000; // decision at close of 60_000 bar

    const res = await broker.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1_000 });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no price");
  });

  test("crypto execution accepts the immediate next continuous bar", async () => {
    const candles = new Map([["BTC/USD", [
      bar(0, 100, 100, 100, 100),
      bar(60_000, 101, 101, 101, 101),
      bar(120_000, 102, 102, 102, 102),
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.005 }, 0.04, undefined, false);
    broker.now = 60_000;

    const res = await broker.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1_000 });

    expect(res.ok).toBe(true);
    expect(broker.positions[0].entryPrice).toBe(101);
  });

  test("stock execution accepts first RTH bar after an overnight gap", async () => {
    const candles = new Map([["SPY", [
      bar(0, 100, 100, 100, 100), // previous day close
      bar(24 * 60 * 60_000, 101, 101, 101, 101), // next day open (gap is expected)
    ]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 5 * 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = 24 * 60 * 60_000;

    const res = await broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 1_000 });

    expect(res.ok).toBe(true);
    expect(broker.positions[0].entryPrice).toBe(101);
  });
});

describe("canonical JSON hashing", () => {
  test("recursive canonicalJson is deterministic regardless of key order or nesting", () => {
    const a = canonicalJson({ z: 1, a: 2, b: { y: { z: 5, a: 6 }, x: 4 }, c: [3, 2, 1] });
    const b = canonicalJson({ a: 2, b: { x: 4, y: { a: 6, z: 5 } }, z: 1, c: [3, 2, 1] });
    expect(a).toBe(b);
  });

  test("canonicalJson preserves array order", () => {
    const a = canonicalJson({ arr: [3, 2, 1] });
    const b = canonicalJson({ arr: [1, 2, 3] });
    expect(a).not.toBe(b);
  });
});

describe("funding fail-closed", () => {
  function makeFundingDb(startH: number, endH: number, gapH?: number): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    const stmt = db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)");
    let t = startH * 3_600_000;
    while (t <= endH * 3_600_000) {
      stmt.run("BTCUSDT", t, 0.0001);
      t += (gapH ?? 8) * 3_600_000;
    }
    return db;
  }

  test("FundingBook throws when start coverage is missing", () => {
    const db = makeFundingDb(24, 48);
    expect(() => new FundingBook(db, ["BTC/USD"], 0, 48 * 3_600_000)).toThrow("funding coverage gap");
  });

  test("FundingBook throws on an obvious > 9h gap", () => {
    const db = makeFundingDb(0, 48, 12);
    expect(() => new FundingBook(db, ["BTC/USD"], 0, 48 * 3_600_000)).toThrow("funding gap > 9h");
  });
});

describe("replay coverage validation — funding", () => {
  function makeFundingDbForValidation(symbol: string, events: number[]): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    const stmt = db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)");
    for (const t of events) stmt.run(symbol, t, 0.0001);
    return db;
  }

  test("validateFundingCoverage succeeds when first event is near window start", () => {
    const db = makeFundingDbForValidation("BTCUSDT", [0, 8 * 3_600_000, 16 * 3_600_000, 24 * 3_600_000, 32 * 3_600_000]);
    const { validateFundingCoverage } = require("./backtest-momentum-wf");
    const result = validateFundingCoverage(db, ["BTC/USD"], 0, 32 * 3_600_000);
    expect(result.get("BTC/USD")).toHaveLength(5);
    db.close();
  });

  test("validateFundingCoverage fails when first event is > 8h after start", () => {
    const db = makeFundingDbForValidation("BTCUSDT", [9 * 3_600_000, 17 * 3_600_000]);
    const { validateFundingCoverage } = require("./backtest-momentum-wf");
    expect(() => validateFundingCoverage(db, ["BTC/USD"], 0, 24 * 3_600_000)).toThrow("first settlement");
  });

  test("validateFundingCoverage fails when last event is before window end", () => {
    const db = makeFundingDbForValidation("BTCUSDT", [0, 8 * 3_600_000, 16 * 3_600_000]);
    const { validateFundingCoverage } = require("./backtest-momentum-wf");
    expect(() => validateFundingCoverage(db, ["BTC/USD"], 0, 24 * 3_600_000)).toThrow("last settlement");
  });

  test("validateFundingCoverage fails on internal gap > 9h", () => {
    const db = makeFundingDbForValidation("BTCUSDT", [0, 8 * 3_600_000, 18 * 3_600_000, 32 * 3_600_000]);
    const { validateFundingCoverage } = require("./backtest-momentum-wf");
    expect(() => validateFundingCoverage(db, ["BTC/USD"], 0, 32 * 3_600_000)).toThrow("funding gap");
  });
});

describe("replay coverage validation — bar density", () => {
  function stockBars(count: number, startMs = 0, gapMs = 300_000): OHLCV[] {
    const bars: OHLCV[] = [];
    for (let i = 0; i < count; i++) {
      const t = startMs + i * gapMs;
      bars.push({ timestamp: t, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 });
    }
    return bars;
  }

  test("validateBarDensity succeeds for dense bars within tolerance", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const bars = stockBars(100, 0);
    expect(() => validateBarDensity(bars, "SPY", 5, true, 0, 100 * 300_000)).not.toThrow();
  });

  test("validateBarDensity fails on empty bars", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    expect(() => validateBarDensity([], "SPY", 5, true, 0, 1_000_000)).toThrow("no bars");
  });

  test("validateBarDensity fails when first bar is > 3 bars late", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const bars = stockBars(10, 5 * 300_000); // first bar at t=1.5M, should be near t=0
    expect(() => validateBarDensity(bars, "SPY", 5, false, 0, 10 * 300_000)).toThrow("first bar");
  });

  test("validateBarDensity fails on gap without weekend/holiday explanation", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const start = Date.parse("2024-01-09T10:00:00-05:00");
    const bars = [
      { timestamp: start, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      // 3h gap on a Tuesday afternoon (unexplained, in RTH)
      { timestamp: start + 3 * 3_600_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      // Add more bars to fill out the window
      { timestamp: start + 3 * 3_600_000 + 300_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
    ];
    expect(() => validateBarDensity(bars, "SPY", 5, true, start, start + 3 * 3_600_000 + 600_000)).toThrow("gap");
  });

  test("validateBarDensity accepts sparse Alpaca RTH bars within one hour", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const start = Date.parse("2024-01-09T10:00:00-05:00");
    const bars = [
      { timestamp: start, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      { timestamp: start + 15 * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
    ];
    expect(() => validateBarDensity(bars, "GLD", 5, true, start, start + 20 * 60_000)).not.toThrow();
  });

  test("validateBarDensity accepts a source-wide RTH outage but rejects an isolated one", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const start = Date.parse("2024-01-09T10:00:00-05:00");
    const next = start + 3 * 3_600_000;
    const bars = [
      { timestamp: start, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      { timestamp: next, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
    ];
    const peerOutsideGap = [bars[0], bars[1]];
    expect(() => validateBarDensity(bars, "SPY", 5, true, start, next + 300_000, peerOutsideGap)).not.toThrow();
    const peerInsideGap = Array.from({ length: 20 }, (_, i) => ({ ...bars[0], timestamp: start + (i + 1) * 5 * 60_000 }));
    expect(() => validateBarDensity(bars, "SPY", 5, true, start, next + 300_000, peerInsideGap)).toThrow("gap");
  });

  test("validateBarDensity accepts gaps that span market weekends", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    // Friday close to Tuesday open spans a weekend plus MLK Day.
    const fri = Date.parse("2024-01-12T15:55:00-05:00");
    const tue = Date.parse("2024-01-16T09:30:00-05:00");
    const bars = [
      { timestamp: fri, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      { timestamp: tue, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      { timestamp: tue + 300_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
    ];
    expect(() => validateBarDensity(bars, "SPY", 5, true, fri, tue + 300_000 + 100_000)).not.toThrow();
  });

  test("validateBarDensity accepts one sparse opening bar after an overnight close", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const priorClose = Date.parse("2024-01-22T15:55:00-05:00");
    const next = Date.parse("2024-01-23T09:35:00-05:00");
    const bars = [
      { timestamp: priorClose, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      { timestamp: next, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
    ];
    expect(() => validateBarDensity(bars, "GLD", 5, true, priorClose, next + 300_000)).not.toThrow();
  });

  test("validateBarDensity rejects crypto gaps in a 24/7 market", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const bars = [
      { timestamp: 0, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
      // 10h gap, but crypto 24/7 so tolerance = 1h + 60min = 1h60min
      { timestamp: 10 * 3_600_000 + 100_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 },
    ];
    expect(() => validateBarDensity(bars, "BTC/USD", 60, false, 0, 11 * 3_600_000)).toThrow("gap");
  });

  test("validateBarDensity accepts a holiday before the first RTH bar", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const from = Date.parse("2024-01-01T00:00:00Z");
    const first = Date.parse("2024-01-02T09:30:00-05:00");
    const bars = stockBars(2, first);
    expect(() => validateBarDensity(bars, "SPY", 5, true, from, first + 600_000)).not.toThrow();
  });

  test("validateBarDensity rejects missing bars after an RTH window begins", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const from = Date.parse("2024-01-09T09:30:00-05:00");
    const bars = stockBars(2, from + 30 * 60_000);
    expect(() => validateBarDensity(bars, "SPY", 5, true, from, from + 40 * 60_000)).toThrow("first bar");
  });

  test("validateBarDensity succeeds when last bar is within 3 bars of window end", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const bars = stockBars(10, 0);
    const endT = bars[bars.length - 1].timestamp + 300_000;
    expect(() => validateBarDensity(bars, "SPY", 5, true, 0, endT)).not.toThrow();
  });

  test("validateBarDensity fails when last bar is > 3 bars before window end", () => {
    const { validateBarDensity } = require("./backtest-momentum-wf");
    const bars = stockBars(5, 0);
    const endT = bars[bars.length - 1].timestamp + 10 * 300_000; // >3 bars gap
    expect(() => validateBarDensity(bars, "SPY", 5, false, 0, endT)).toThrow("last bar");
  });
});

describe("terminal liquidation (fold_end)", () => {
  const barMs = 60_000;

  test("closes a long position at the last price strictly inside [fromMs, toMs), reason fold_end", () => {
    const candles = new Map([["BTC/USD", [bar(0, 100), bar(barMs, 100), bar(2 * barMs, 105)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, barMs, { leverage: 2, maintRate: 0.005 }, 0.04);
    broker.positions.push({ symbol: "BTC/USD", side: "buy", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 500 });
    const toMs = 3 * barMs; // window end; last bar strictly inside is the 105 close at 2*barMs

    broker.now = toMs;
    liquidateAtFoldEnd(broker, 0, toMs, false);

    expect(broker.positions).toHaveLength(0);
    expect(broker.closed).toHaveLength(1);
    expect(broker.closed[0]).toMatchObject({ symbol: "BTC/USD", side: "buy", reason: "fold_end", exitAt: toMs });
    // gross = (105 - 100) * 10 = 50, zero slippage/commission
    expect(broker.closed[0].pnl).toBeCloseTo(50, 6);
    expect(broker.cash).toBeCloseTo(10_050, 6);
  });

  test("closes a short position at the last price strictly inside [fromMs, toMs), reason fold_end", () => {
    const candles = new Map([["BTC/USD", [bar(0, 100), bar(barMs, 100), bar(2 * barMs, 90)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, barMs, { leverage: 2, maintRate: 0.005 }, 0.04);
    broker.positions.push({ symbol: "BTC/USD", side: "sell", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 500 });
    const toMs = 3 * barMs;

    broker.now = toMs;
    liquidateAtFoldEnd(broker, 0, toMs, false);

    expect(broker.positions).toHaveLength(0);
    expect(broker.closed[0].reason).toBe("fold_end");
    // gross = (100 - 90) * 10 = 100 profit for the short
    expect(broker.closed[0].pnl).toBeCloseTo(100, 6);
    expect(broker.cash).toBeCloseTo(10_100, 6);
  });

  test("missing terminal price fails closed instead of silently dropping the position", () => {
    const broker = new SimBroker(10_000, new Map(), 0, 0, barMs, { leverage: 2, maintRate: 0.005 }, 0.04);
    broker.positions.push({ symbol: "BTC/USD", side: "buy", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 500 });
    broker.now = 3 * barMs;

    expect(() => liquidateAtFoldEnd(broker, 0, 3 * barMs, false)).toThrow("no terminal price");
    // The failed close must not silently drop the position from the book.
    expect(broker.positions).toHaveLength(1);
  });

  test("ruined folds are a no-op — checkLiquidation already flattened everything", () => {
    const candles = new Map([["BTC/USD", [bar(0, 100), bar(barMs, 100), bar(2 * barMs, 105)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, barMs, { leverage: 2, maintRate: 0.005 }, 0.04);
    // Simulate a stray position that would otherwise be closed — the ruined
    // flag must still skip it (checkLiquidation owns ruin accounting).
    broker.positions.push({ symbol: "BTC/USD", side: "buy", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 500 });
    broker.now = 3 * barMs;

    expect(() => liquidateAtFoldEnd(broker, 0, 3 * barMs, true)).not.toThrow();
    expect(broker.positions).toHaveLength(1); // untouched
    expect(broker.closed).toHaveLength(0);
  });

  test("terminal tail (funding settle → liquidation → single equity push) never double-counts MTM", () => {
    const hour = 3_600_000;
    const fromMs = 0;
    const toMs = 4 * hour;
    const candles = new Map([["BTC/USD", [
      bar(0, 100), bar(hour, 100), bar(2 * hour, 110), bar(3 * hour, 110),
    ]]]);
    const db = new Database(":memory:");
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    const stmt = db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)");
    for (const h of [1, 2, 3, 4]) stmt.run("BTCUSDT", h * hour, 0.0001);
    const book = new FundingBook(db, ["BTC/USD"], fromMs, toMs);

    const broker = new SimBroker(10_000, candles, 0, 0, hour, { leverage: 2, maintRate: 0.005 }, 0.04, book, false);
    broker.positions.push({ symbol: "BTC/USD", side: "buy", qty: 1, entryPrice: 100, entryAt: 0, entryMargin: 50 });
    // Simulate the loop having already settled funding through 2h; the tail
    // must pick up exactly the remaining events strictly < toMs (the 3h
    // event), never the one exactly AT toMs (belongs to the NEXT fold).
    const prevT = 2 * hour;
    broker.equityHistory.push({ t: prevT, eq: broker.equityNow() });

    // ── the exact tail sequence runWithConfig performs ──
    broker.now = toMs;
    broker.applyFunding(prevT, toMs, toMs - 1);
    liquidateAtFoldEnd(broker, fromMs, toMs, false);
    const finalEq = broker.equityNow();
    broker.equityHistory.push({ t: toMs, eq: finalEq });

    // Funding: only the 3h event (strictly < toMs=4h) at price 110: 1 * 1 * 110 * 0.0001 = 0.011.
    // The 4h event, exactly AT toMs, is excluded — NOT 0.022 (which would double-count it).
    expect(broker.fundingPaid).toBeCloseTo(0.011, 6);
    // Liquidation: gross = (110 - 100) * 1 = 10, on top of the funding debit.
    expect(broker.cash).toBeCloseTo(10_000 - 0.011 + 10, 6);
    expect(broker.positions).toHaveLength(0);
    const foldEndTrade = broker.closed.find(c => c.reason === "fold_end");
    expect(foldEndTrade).toBeDefined();
    // Net pnl includes the funding cost: gross(10) - entryCommission(0) - exitFee(0) - fundingCost(0.011).
    expect(foldEndTrade!.pnl).toBeCloseTo(10 - 0.011, 6);

    const terminalPoints = broker.equityHistory.filter(p => p.t === toMs);
    expect(terminalPoints).toHaveLength(1);
    expect(terminalPoints[0].eq).toBeCloseTo(finalEq, 6);
    expect(terminalPoints[0].eq).toBeCloseTo(10_000 - 0.011 + 10, 6);
    db.close();
  });

  test("an event exactly at toMs is excluded even when it would otherwise dominate — only the last interior settlement counts", () => {
    const hour = 3_600_000;
    const fromMs = 0;
    const toMs = 4 * hour;
    const candles = new Map([["BTC/USD", [bar(0, 100), bar(hour, 100), bar(2 * hour, 110), bar(3 * hour, 110)]]]);
    const db = new Database(":memory:");
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    const stmt = db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)");
    stmt.run("BTCUSDT", 3 * hour, 0.0001);  // interior — strictly < toMs — must be included
    stmt.run("BTCUSDT", 4 * hour, 0.9);     // exactly AT toMs, huge rate — must be excluded
    const book = new FundingBook(db, ["BTC/USD"], fromMs, toMs);

    const broker = new SimBroker(10_000, candles, 0, 0, hour, { leverage: 2, maintRate: 0.005 }, 0.04, book, false);
    broker.positions.push({ symbol: "BTC/USD", side: "buy", qty: 1, entryPrice: 100, entryAt: 0, entryMargin: 50 });

    broker.now = toMs;
    broker.applyFunding(0, toMs, toMs - 1);

    // If the huge boundary-rate event leaked in, fundingPaid would jump to
    // ~99 (1 * 110 * 0.9). It must stay tiny — only the 3h event applied.
    expect(broker.fundingPaid).toBeCloseTo(1 * 110 * 0.0001, 6);
    db.close();
  });
});

describe("net per-trade pnl (commission + funding netting)", () => {
  test("openPosition records entryCommission; closeAt nets entry+exit commission into ClosedTrade.pnl without touching cash accounting", async () => {
    const candles = new Map([["BTC/USD", [bar(0, 100), bar(60_000, 100)]]]);
    const broker = new SimBroker(10_000, candles, 0, 50 /* 0.5% commission */, 60_000, { leverage: 2, maintRate: 0.005 }, 0.04);
    broker.now = 60_000;
    const open = await broker.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1_000 });
    expect(open.ok).toBe(true);
    const pos = broker.positions[0];
    expect(pos.entryCommission).toBeCloseTo(1_000 * 0.005, 6); // 0.5% of $1000 notional
    const cashAfterOpen = broker.cash;
    expect(cashAfterOpen).toBeCloseTo(10_000 - 5, 6);

    broker.now = 120_000;
    const qty = pos.qty; // 1000 / 100 = 10
    const res = broker.closeAt("BTC/USD", "buy", 110, "test"); // gross winner: (110-100)*qty = 100
    expect(res.ok).toBe(true);
    const exitFee = qty * 110 * 0.005;
    const gross = (110 - 100) * qty;
    const trade = broker.closed[0];
    expect(trade.pnl).toBeCloseTo(gross - 5 - exitFee, 6);
    // Cash accounting is untouched by the netting: open fee already deducted
    // at open, close still applies gross - exitFee exactly as before.
    expect(broker.cash).toBeCloseTo(cashAfterOpen + gross - exitFee, 6);
  });

  test("a gross winner becomes a net loser once entry+exit commission exceed the gross gain — win rate/expectancy consume the net value", async () => {
    const candles = new Map([["SPY", [bar(0, 100), bar(60_000, 100)]]]);
    const broker = new SimBroker(10_000, candles, 0, 60 /* 0.6% commission */, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, true);
    broker.now = 60_000;
    await broker.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 1_000 });
    const qty = broker.positions[0].qty; // floor(1000 / 100) = 10

    broker.now = 120_000;
    broker.closeAt("SPY", "buy", 101, "test"); // +1% gross move
    const trade = broker.closed[0];
    const gross = (101 - 100) * qty;
    expect(gross).toBeGreaterThan(0); // a GROSS winner...
    expect(trade.pnl).toBeLessThan(0); // ...but a NET loser once commission is netted in

    // Same formulas runWithConfig uses for win rate / expectancy — must
    // consume trade.pnl (net), not the gross move.
    const wins = broker.closed.filter(t => t.pnl > 0).length;
    const expectancy = broker.closed.reduce((s, t) => s + t.pnl, 0) / broker.closed.length;
    expect(wins).toBe(0); // NOT counted as a win despite the positive gross move
    expect(expectancy).toBeLessThan(0);
  });

  test("funding cost is netted into pnl even at a flat price — a zero-gross trade with funding paid is a net loser", () => {
    const hour = 3_600_000;
    const candles = new Map([["BTC/USD", [bar(0, 100), bar(hour, 100), bar(2 * hour, 100)]]]);
    const db = new Database(":memory:");
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)").run("BTCUSDT", hour, 0.001);
    const book = new FundingBook(db, ["BTC/USD"], 0, hour);
    const broker = new SimBroker(10_000, candles, 0, 0, hour, { leverage: 2, maintRate: 0.005 }, 0.04, book, false);
    broker.positions.push({ symbol: "BTC/USD", side: "buy", qty: 1, entryPrice: 100, entryAt: 0, entryMargin: 50 });

    broker.applyFunding(0, hour);
    broker.now = 2 * hour;
    const res = broker.closeAt("BTC/USD", "buy", 100, "test"); // flat price: zero gross pnl
    expect(res.ok).toBe(true);

    const trade = broker.closed[0];
    expect(trade.pnl).toBeCloseTo(-1 * 100 * 0.001, 6); // pure funding cost, no gross move, no commission
    expect(trade.pnl).toBeLessThan(0);
    db.close();
  });

  test("funding credit received by a short is netted as a positive contribution to pnl", () => {
    const hour = 3_600_000;
    const candles = new Map([["BTC/USD", [bar(0, 100), bar(hour, 100), bar(2 * hour, 100)]]]);
    const db = new Database(":memory:");
    db.run(`CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))`);
    db.prepare("INSERT INTO funding_rates VALUES (?, ?, ?)").run("BTCUSDT", hour, 0.001); // positive rate: shorts receive (credit mode)
    const book = new FundingBook(db, ["BTC/USD"], 0, hour);
    const broker = new SimBroker(10_000, candles, 0, 0, hour, { leverage: 2, maintRate: 0.005 }, 0.04, book, false);
    broker.positions.push({ symbol: "BTC/USD", side: "sell", qty: 1, entryPrice: 100, entryAt: 0, entryMargin: 50 });

    broker.applyFunding(0, hour);
    broker.now = 2 * hour;
    broker.closeAt("BTC/USD", "sell", 100, "test"); // flat price: zero gross pnl

    const trade = broker.closed[0];
    expect(trade.pnl).toBeCloseTo(1 * 100 * 0.001, 6); // pure funding credit, positive net pnl
  });
});

describe("runtime RiskGuard state (runWithConfig initialRiskState/finalRiskState)", () => {
  function seedFlatCrypto(dbPath: string, fromMs: number, toMs: number, warmupDays: number) {
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
      db.transaction(() => {
        for (let t = seedFrom; t <= seedTo; t += 3_600_000) {
          barStmt.run("BTC/USD", "1h", "binance_futures", t, 100, 100, 100, 100, 1);
          fundStmt.run("BTCUSDT", t, 0.0001);
        }
      })();
    } finally {
      db.close();
    }
  }

  test("initialRiskState seeds RiskGuard and finalRiskState round-trips the active pause", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-riskstate-"));
    const dbPath = join(tmpDir, "historical.db");
    try {
      const fromMs = Date.parse("2024-03-10T00:00:00Z");
      const toMs = fromMs + 2 * 86_400_000;
      const warmupDays = 40;
      seedFlatCrypto(dbPath, fromMs, toMs, warmupDays);

      const cfg: ReplayConfig = {
        sleeve: "crypto",
        universe: ["BTC/USD"],
        timeframe: "1h",
        source: "binance_futures",
        refSymbol: "BTC/USD",
        rthOnly: false,
        funding: true,
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
        warmupDays,
        dbPath,
      };
      const win = { label: "test", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };

      const seededPausedUntil = toMs + 999 * 86_400_000;
      const seeded = {
        ...INITIAL_RISK_STATE,
        pausedUntil: seededPausedUntil,
        pauseReason: "seed-pause-test",
        consecutiveLosses: 3,
      };

      const withSeed = await runWithConfig(cfg, win, seeded);
      expect(withSeed).not.toBeNull();
      // Loaded: the pause is still active the whole replay (now < pausedUntil
      // throughout), so evaluateRisk short-circuits before it could
      // recompute pausedUntil/pauseReason — they round-trip verbatim.
      expect(withSeed!.finalRiskState.pausedUntil).toBe(seededPausedUntil);
      expect(withSeed!.finalRiskState.pauseReason).toBe("seed-pause-test");
      // Flat realised P&L each period leaves the streak counter untouched.
      expect(withSeed!.finalRiskState.consecutiveLosses).toBe(3);
      // Entries blocked for the entire replay: zero trades.
      expect(withSeed!.trades).toBe(0);

      // Contrast: without seeding, a fresh state never breaches on flat
      // price, so pausedUntil stays 0 — proving the seeded value above came
      // from `load()`, not from independently-triggered risk logic.
      const withoutSeed = await runWithConfig(cfg, win);
      expect(withoutSeed).not.toBeNull();
      expect(withoutSeed!.finalRiskState.pausedUntil).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("funding boundary — in-loop iteration at t===toMs (integration through the real replay loop)", () => {
  // Grid-aligned fromMs/toMs on the hourly bar grid: the LAST bar strictly
  // inside [fromMs, toMs) closes exactly at toMs, so the main loop's FINAL
  // iteration has t === toMs. This is the exact iteration whose in-loop
  // `applyFunding` call previously defaulted eventEndMs to `t` (=toMs) and
  // could consume the fold's boundary funding event — a bug the direct
  // liquidateAtFoldEnd unit tests could never catch, since they never drive
  // the loop itself.
  function seedTrendingCrypto(dbPath: string, fromMs: number, toMs: number, warmupDays: number) {
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
          barStmt.run("BTC/USD", "1h", "binance_futures", t, price, price * 1.0002, price * 0.9998, price, 1);
          // Hourly funding at a tiny rate — EXCEPT one huge, distinguishing
          // rate exactly at toMs, the boundary event that MUST be excluded
          // from this fold (it belongs to the next one).
          fundStmt.run("BTCUSDT", t, t === toMs ? 2.0 : 0.0001);
          price *= 1.0007; // steady uptrend: TSM opens early and holds to fold-end
        }
      })();
    } finally {
      db.close();
    }
  }

  test("an in-loop iteration where t===toMs never applies the funding event exactly at toMs", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-fundbound-loop-"));
    const dbPath = join(tmpDir, "historical.db");
    try {
      const fromMs = Date.parse("2024-03-10T00:00:00Z");
      const toMs = fromMs + 2 * 86_400_000; // 48h, exactly grid-aligned to hourly bars
      const warmupDays = 40;
      seedTrendingCrypto(dbPath, fromMs, toMs, warmupDays);

      const cfg: ReplayConfig = {
        sleeve: "crypto",
        universe: ["BTC/USD"],
        timeframe: "1h",
        source: "binance_futures",
        refSymbol: "BTC/USD",
        rthOnly: false,
        funding: true,
        barMinutes: 60,
        barMinutesEq: 60,
        slippageBps: 0,
        commissionBps: 0,
        initialEquity: 10_000,
        leverage: 2,
        hardStopPct: 0.04,
        cadenceMin: 240,
        notionalPctPerSlot: 0.25,
        entryPct: 5,
        exitPct: -2,
        maxLongs: 1,
        maxShorts: 0,
        shortFunding: "credit",
        warmupDays,
        dbPath,
      };
      const win = { label: "test", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };

      const result = await runWithConfig(cfg, win);
      expect(result).not.toBeNull();
      // Sanity: the monotonic uptrend must have actually opened and held a
      // position through fold-end — otherwise this test would trivially
      // pass without ever exercising applyFunding against a real position.
      expect(result!.trades).toBeGreaterThan(0);

      // If the huge boundary-rate event (2.0, exactly at toMs) leaked in
      // through the in-loop call at t===toMs, total funding would jump into
      // the thousands (notional * 2.0). It must stay tiny — only the
      // interior 0.0001-rate hourly events ever apply.
      expect(result!.funding).toBeLessThan(50);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("the host's TRADING_ENABLED=false kill-switch never leaks into a replay (42/42 zero-trade artifact regression)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-killswitch-"));
    const dbPath = join(tmpDir, "historical.db");
    const prev = process.env.TRADING_ENABLED;
    try {
      const fromMs = Date.parse("2024-03-10T00:00:00Z");
      const toMs = fromMs + 2 * 86_400_000;
      const warmupDays = 40;
      seedTrendingCrypto(dbPath, fromMs, toMs, warmupDays);
      const cfg: ReplayConfig = {
        sleeve: "crypto", universe: ["BTC/USD"], timeframe: "1h", source: "binance_futures",
        refSymbol: "BTC/USD", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60,
        slippageBps: 0, commissionBps: 0, initialEquity: 10_000, leverage: 2, hardStopPct: 0.04,
        cadenceMin: 240, notionalPctPerSlot: 0.25, entryPct: 5, exitPct: -2, maxLongs: 1,
        maxShorts: 0, shortFunding: "credit", warmupDays, dbPath,
      };
      const win = { label: "test", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };

      // The decommissioned-host situation: maintenance kill-switch armed.
      process.env.TRADING_ENABLED = "false";
      const result = await runWithConfig(cfg, win);
      expect(result).not.toBeNull();
      // Pre-fix this was 0: the engine's per-tick isTradingEnabled() gate
      // blocked every open and the artifact looked "complete" anyway.
      expect(result!.trades).toBeGreaterThan(0);
      // And the replay restored the host's env — the kill-switch still arms
      // whatever real process runs after us.
      expect(process.env.TRADING_ENABLED).toBe("false");
    } finally {
      if (prev === undefined) delete process.env.TRADING_ENABLED; else process.env.TRADING_ENABLED = prev;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Reg-T margin interest (A3) — SimBroker", () => {
  // Constructor tail: (..., hardStopSpec, barsPerDay, marginInterestAnnualRate, cooldownBarsAfterStop)
  const mkBroker = (rate: number, candles: Map<string, OHLCV[]>) =>
    new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true, undefined, 78, rate, 0);
  const flatSpy = () => new Map([["SPY", [bar(0, 100), bar(60_000, 100)]]]);

  test("charges max(0, gross − equity) × rate/365 per UTC calendar day — weekends included (Fri→Mon = 3 days)", () => {
    const broker = mkBroker(0.073, flatSpy());
    // 200 shares @ 100 = $20k gross on $10k equity → $10k debit balance.
    broker.positions.push({ symbol: "SPY", side: "buy", qty: 200, entryPrice: 100, entryAt: 0, entryMargin: 10_000 });
    broker.now = 60_000;
    // Fri 20:00 UTC → Mon 14:30 UTC crosses the Sat, Sun and Mon UTC
    // midnights: 3 calendar days — the broker charges the weekend too.
    broker.accrueMarginInterest(Date.parse("2024-01-05T20:00:00Z"), Date.parse("2024-01-08T14:30:00Z"));
    const expected = 10_000 * (0.073 / 365) * 3; // $6.00 exactly
    expect(broker.marginInterestPaid).toBeCloseTo(expected, 9);
    expect(broker.cash).toBeCloseTo(10_000 - expected, 9);
  });

  test("intraday range crossing no UTC midnight charges nothing", () => {
    const broker = mkBroker(0.073, flatSpy());
    broker.positions.push({ symbol: "SPY", side: "buy", qty: 200, entryPrice: 100, entryAt: 0, entryMargin: 10_000 });
    broker.now = 60_000;
    broker.accrueMarginInterest(Date.parse("2024-01-05T10:00:00Z"), Date.parse("2024-01-05T23:59:00Z"));
    expect(broker.marginInterestPaid).toBe(0);
    expect(broker.cash).toBe(10_000);
  });

  test("gross ≤ equity (cash-funded book) charges nothing", () => {
    const broker = mkBroker(0.073, flatSpy());
    // 80 shares @ 100 = $8k gross on $10k equity → no debit balance.
    broker.positions.push({ symbol: "SPY", side: "buy", qty: 80, entryPrice: 100, entryAt: 0, entryMargin: 8_000 });
    broker.now = 60_000;
    broker.accrueMarginInterest(Date.parse("2024-01-05T20:00:00Z"), Date.parse("2024-01-08T14:30:00Z"));
    expect(broker.marginInterestPaid).toBe(0);
    expect(broker.cash).toBe(10_000);
  });

  test("rate 0 (absent config) is a strict no-op — the legacy path is untouched", () => {
    const broker = new SimBroker(10_000, flatSpy(), 0, 0, 60_000, { leverage: 2, maintRate: 0.25 }, 0.04, undefined, true);
    broker.positions.push({ symbol: "SPY", side: "buy", qty: 200, entryPrice: 100, entryAt: 0, entryMargin: 10_000 });
    broker.now = 60_000;
    broker.accrueMarginInterest(Date.parse("2024-01-05T20:00:00Z"), Date.parse("2024-01-08T14:30:00Z"));
    expect(broker.marginInterestPaid).toBe(0);
    expect(broker.cash).toBe(10_000);
  });

  test("consecutive disjoint ranges never double-charge a boundary", () => {
    const broker = mkBroker(0.365, flatSpy()); // rate 36.5%/yr → 0.1%/day: easy math
    broker.positions.push({ symbol: "SPY", side: "buy", qty: 200, entryPrice: 100, entryAt: 0, entryMargin: 10_000 });
    broker.now = 60_000;
    const d0 = Date.parse("2024-01-05T10:00:00Z");
    broker.accrueMarginInterest(d0, d0 + 86_400_000);          // crosses 1 midnight
    const firstCharge = broker.marginInterestPaid;
    expect(firstCharge).toBeCloseTo(10_000 * 0.001, 9);
    broker.accrueMarginInterest(d0 + 86_400_000, d0 + 2 * 86_400_000); // 1 more midnight
    // Second charge is on the slightly larger post-charge debit (equity fell
    // by the first charge) — strictly one day's worth each, no double count.
    const secondCharge = broker.marginInterestPaid - firstCharge;
    expect(secondCharge).toBeCloseTo((10_000 + firstCharge) * 0.001, 9);
  });
});

describe("post-stop cooldown (B2) — SimBroker", () => {
  // Continuous 1-min "crypto" tape (fractional qty, strict next-bar
  // execution): flat 100s except one bar whose LOW dips 10% — through the
  // 4% hard stop — while its close stays flat.
  const tape = (n: number, dipAt: number) =>
    Array.from({ length: n }, (_, i) => (i === dipAt ? bar(i * 60_000, 100, 100, 90, 100) : bar(i * 60_000, 100)));
  const open = (broker: SimBroker, symbol = "BTC/USD") =>
    broker.openPosition({ symbol, side: "buy", notionalUsd: 1_000 });

  test("cooldown=4: blocked at decision ticks +1..+3, re-enters exactly at the 4th decision bar after the stop; other symbols unaffected", async () => {
    const candles = new Map([["BTC/USD", tape(20, 5)], ["ETH/USD", tape(20, -1)]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.005 }, 0.04, undefined, false, undefined, 24, 0, 4);
    broker.decisionTicks = 1;
    broker.now = 60_000;
    expect((await open(broker)).ok).toBe(true);

    broker.now = 6 * 60_000; // the dip bar (index 5) just closed
    broker.checkStops(new Map([["BTC/USD", candles.get("BTC/USD")![5]]]));
    expect(broker.closed).toHaveLength(1);
    expect(broker.closed[0].reason).toBe("stop_loss");

    for (const tick of [2, 3, 4]) {
      broker.decisionTicks = tick;
      broker.now = (tick + 6) * 60_000;
      const res = await open(broker);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("cooldown_after_stop");
      // Per-symbol: an un-stopped symbol opens freely during the cooldown.
      const other = await open(broker, "ETH/USD");
      expect(other.ok).toBe(true);
      broker.closeAt("ETH/USD", "buy", 100, "rebalance"); // keep the book clean for the next lap
    }

    broker.decisionTicks = 5; // = 1 (last pre-stop tick) + 4
    broker.now = 12 * 60_000;
    expect((await open(broker)).ok).toBe(true);
  });

  test("0/absent cooldown: the stopped symbol re-enters at the very next decision tick (legacy)", async () => {
    const candles = new Map([["BTC/USD", tape(20, 5)]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.005 }, 0.04);
    broker.decisionTicks = 1;
    broker.now = 60_000;
    await open(broker);
    broker.now = 6 * 60_000;
    broker.checkStops(new Map([["BTC/USD", candles.get("BTC/USD")![5]]]));
    expect(broker.closed[0].reason).toBe("stop_loss");

    broker.decisionTicks = 2;
    broker.now = 8 * 60_000;
    expect((await open(broker)).ok).toBe(true);
  });

  test("non-stop closes never arm the cooldown: 'rebalance' (the sim reason for ALL engine exits — signal flip, vol trail, time stop), 'liquidation', 'fold_end'", async () => {
    const candles = new Map([["BTC/USD", tape(20, -1)]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 2, maintRate: 0.005 }, 0.04, undefined, false, undefined, 24, 0, 4);
    broker.decisionTicks = 1;
    for (const reason of ["rebalance", "liquidation", "fold_end"]) {
      broker.now = 60_000;
      expect((await open(broker)).ok).toBe(true);
      broker.closeAt("BTC/USD", "buy", 100, reason);
      // Same decision tick, immediately re-openable: no cooldown was armed.
      const res = await open(broker);
      expect(res.ok).toBe(true);
      broker.closeAt("BTC/USD", "buy", 100, "rebalance");
    }
  });
});

describe("A3/B2 hash identity — absent keys preserve legacy candidate hashes", () => {
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

  test("explicit undefined equals absent (JSON.stringify drops it); present values are distinct hypotheses", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({ ...baseCfg, marginInterest: undefined, cooldownBarsAfterStop: undefined })).toBe(legacy);
    expect(hashReplayConfig({ ...baseCfg, marginInterest: { annualRate: 0.075 } })).not.toBe(legacy);
    expect(hashReplayConfig({ ...baseCfg, cooldownBarsAfterStop: 4 })).not.toBe(legacy);
  });
});

describe("A3 + B2 through the real replay loop (runWithConfig)", () => {
  /** Hourly uptrend so TSM opens at the first tick and stays long. The bar
   *  at `crashBarTs` (if set) dips its LOW 15% — through the 4%
   *  entry-anchored stop — while its CLOSE stays on trend, so the signal
   *  survives the stop and the engine immediately wants back in. */
  function seedTrendTape(dbPath: string, fromMs: number, toMs: number, warmupDays: number, crashBarTs?: number) {
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
          const low = t === crashBarTs ? price * 0.85 : price * 0.9998;
          stmt.run("BTC/USD", "1h", "binance_futures", t, price, price * 1.0002, low, price, 1);
          price *= 1.0007;
        }
      })();
    } finally {
      db.close();
    }
  }

  const mkCfg = (dbPath: string, extra: Partial<ReplayConfig> = {}): ReplayConfig => ({
    sleeve: "crypto", universe: ["BTC/USD"], timeframe: "1h", source: "binance_futures",
    refSymbol: "BTC/USD", rthOnly: false, funding: false, barMinutes: 60, barMinutesEq: 60,
    slippageBps: 0, commissionBps: 0, initialEquity: 10_000, leverage: 2, hardStopPct: 0.04,
    cadenceMin: 60, notionalPctPerSlot: 0.25, entryPct: 5, exitPct: -2, maxLongs: 1,
    maxShorts: 0, shortFunding: "credit", warmupDays: 40, dbPath, ...extra,
  });

  test("cooldown: legacy re-enters at the stop tick itself; cooldown=4 re-enters when the tick counter reaches stopTick+4 (ticks +1..+3 blocked)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-cooldown-loop-"));
    const dbPath = join(tmpDir, "historical.db");
    try {
      const fromMs = Date.parse("2024-03-10T00:00:00Z");
      const toMs = fromMs + 3 * 86_400_000;
      const crashBarTs = fromMs + 24 * 3_600_000;
      seedTrendTape(dbPath, fromMs, toMs, 40, crashBarTs);
      const win = { label: "test", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };

      const noCd = await runWithConfig(mkCfg(dbPath), win);
      const cd4 = await runWithConfig(mkCfg(dbPath, { cooldownBarsAfterStop: 4 }), win);
      expect(noCd).not.toBeNull();
      expect(cd4).not.toBeNull();

      const stopA = noCd!.closedTrades.find(t => t.reason === "stop_loss");
      const stopB = cd4!.closedTrades.find(t => t.reason === "stop_loss");
      expect(stopA).toBeDefined();
      expect(stopB).toBeDefined();
      expect(stopB!.exitAt).toBe(stopA!.exitAt); // pre-divergence, identical books

      const reentry = (r: typeof noCd, after: number) =>
        r!.closedTrades.filter(t => (t.entryAt ?? 0) >= after).sort((x, y) => (x.entryAt ?? 0) - (y.entryAt ?? 0))[0];
      const reA = reentry(noCd, stopA!.exitAt);
      const reB = reentry(cd4, stopB!.exitAt);
      expect(reA).toBeDefined();
      expect(reB).toBeDefined();
      // The stop fires ON a decision bar here (hourly cadence): the
      // same-iteration re-attempt is already tick +1 of the window, so
      // legacy re-enters at the stop tick itself while cooldown=4 unblocks
      // 3 cadence hours later (ticks +1,+2,+3 rejected, +4 fills).
      expect(reA!.entryAt).toBe(stopA!.exitAt);
      expect(reB!.entryAt).toBe(stopB!.exitAt + 3 * 3_600_000);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("margin interest: absent config reports 0; a 2×-gross book under annualRate 0.075 accrues daily and lands in the result", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wf-margin-loop-"));
    const dbPath = join(tmpDir, "historical.db");
    try {
      const fromMs = Date.parse("2024-03-10T00:00:00Z");
      const toMs = fromMs + 3 * 86_400_000;
      seedTrendTape(dbPath, fromMs, toMs, 40);
      const win = { label: "test", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };

      // 1 slot × 150% notional on 2× leverage: gross ≈ 1.5× equity → a
      // permanent ~0.5×equity debit balance while the position is held.
      const legacy = await runWithConfig(mkCfg(dbPath, { notionalPctPerSlot: 1.5 }), win);
      const charged = await runWithConfig(mkCfg(dbPath, { notionalPctPerSlot: 1.5, marginInterest: { annualRate: 0.075 } }), win);
      expect(legacy).not.toBeNull();
      expect(charged).not.toBeNull();

      expect(legacy!.marginInterest).toBe(0); // reported, but zero — legacy behavior intact
      expect(legacy!.trades).toBeGreaterThan(0);
      // ~$5k debit × 0.075/365 ≈ $1/day over ~3 crossed midnights: nonzero,
      // small, and equity strictly worse than the free-borrow run.
      expect(charged!.marginInterest).toBeGreaterThan(0);
      expect(charged!.marginInterest).toBeLessThan(20);
      expect(charged!.finalEquity).toBeLessThan(legacy!.finalEquity);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════
// OPEN.md P2 — "el libro del sim arranca vacío en el epoch": the seed for
// the replay's book. Pure helpers (seedStopFraction/seedTrailMark),
// SimBroker.seedPositions, and one full runWithConfig wiring check.
// ═══════════════════════════════════════════════════════════════════════
describe("seedStopFraction — entry-anchored stop distance for a seeded position", () => {
  const FIXED: ReplayConfig["hardStop"] = { mode: "fixed", pct: 0.04 };
  const NONE: ReplayConfig["hardStop"] = { mode: "none" };

  test("a persisted stop price is preferred over the sleeve's fixed fallback — long and short", () => {
    expect(seedStopFraction({ side: "buy", entryPrice: 100, stopPrice: 92 }, FIXED!, 0.04)).toBeCloseTo(0.08, 12);
    expect(seedStopFraction({ side: "sell", entryPrice: 100, stopPrice: 108 }, FIXED!, 0.04)).toBeCloseTo(0.08, 12);
  });

  test("a stop on the WRONG side of entry (malformed data) is treated as absent — falls back", () => {
    expect(seedStopFraction({ side: "buy", entryPrice: 100, stopPrice: 110 }, FIXED!, 0.04)).toBeCloseTo(0.04, 12);
  });

  test("no persisted price: mode \"none\" seeds truly unprotected; any other mode falls back to the fixed pct", () => {
    expect(seedStopFraction({ side: "buy", entryPrice: 100, stopPrice: null }, NONE!, 0.04)).toBeNull();
    expect(seedStopFraction({ side: "buy", entryPrice: 100, stopPrice: undefined }, FIXED!, 0.04)).toBeCloseTo(0.04, 12);
  });

  test("a zero/negative price is treated as absent (defensive)", () => {
    expect(seedStopFraction({ side: "buy", entryPrice: 100, stopPrice: 0 }, FIXED!, 0.04)).toBeCloseTo(0.04, 12);
    expect(seedStopFraction({ side: "buy", entryPrice: 100, stopPrice: -5 }, FIXED!, 0.04)).toBeCloseTo(0.04, 12);
  });
});

describe("seedTrailMark — reconstructs the trail watermark from entry to the epoch", () => {
  test("long: the watermark is the PEAK close between entry and the epoch, not the entry price", () => {
    const bars = [
      bar(0, 100), bar(60_000, 110), bar(120_000, 130), bar(180_000, 125), // peak 130
      bar(240_000, 90), // AFTER the epoch — must be excluded
    ];
    const mark = seedTrailMark({ side: "buy", entryPrice: 100, entryAt: 0 }, bars, 240_000);
    // lastTs always advances to the LAST scanned bar (even one that didn't
    // set a new peak) — matches MomentumEngine.applyTrailStops' own
    // accumulation (state.lastTs = the latest bar seen, win or not).
    expect(mark).toEqual({ mark: 130, lastTs: 180_000 });
  });

  test("short: the watermark is the TROUGH close between entry and the epoch", () => {
    const bars = [bar(0, 100), bar(60_000, 90), bar(120_000, 70), bar(180_000, 85)];
    const mark = seedTrailMark({ side: "sell", entryPrice: 100, entryAt: 0 }, bars, 180_000);
    expect(mark).toEqual({ mark: 70, lastTs: 120_000 });
  });

  test("no bars in (entryAt, epoch) falls back to the entry itself — declared limitation for a seed older than the loaded history", () => {
    const bars = [bar(-60_000, 999)]; // only a bar BEFORE entryAt
    const mark = seedTrailMark({ side: "buy", entryPrice: 100, entryAt: 0 }, bars, 60_000);
    expect(mark).toEqual({ mark: 100, lastTs: 0 });
  });

  test("a peak that never beats the entry price still anchors at the entry price (long never trails below it)", () => {
    const bars = [bar(0, 100), bar(60_000, 95), bar(120_000, 90)];
    const mark = seedTrailMark({ side: "buy", entryPrice: 100, entryAt: 0 }, bars, 180_000);
    expect(mark.mark).toBe(100);
  });
});

describe("SimBroker.seedPositions", () => {
  const seed: SeedPosition = { symbol: "KO", side: "buy", qty: 50, entryPrice: 60, entryAt: 123, stopPrice: 55.2 };

  test("pushes a position with the persisted stop distance, zero entry commission, and no cash debit", () => {
    const candles = new Map([["KO", [bar(0, 60), bar(60_000, 60)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, true, { mode: "fixed", pct: 0.04 });
    broker.seedPositions([seed]);
    expect(broker.positions).toHaveLength(1);
    const p = broker.positions[0];
    expect(p).toMatchObject({ symbol: "KO", side: "buy", qty: 50, entryPrice: 60, entryAt: 123, entryCommission: 0, fundingCashDelta: 0, peakPrice: 60, lockLevel: null });
    expect(p.stopFrac).toBeCloseTo((60 - 55.2) / 60, 12); // the REAL persisted stop, not the fixed 4% (which would be 0.04)
    expect(p.entryMargin).toBeCloseTo((50 * 60) / 1, 6);
    expect(broker.cash).toBe(10_000); // entry already happened before this replay — no debit here
  });

  test("the seeded position's margin occupies headroom — a competing open can be rejected exactly as if the engine had opened it itself", async () => {
    const candles = new Map([["KO", [bar(0, 60), bar(60_000, 60)]], ["XLF", [bar(0, 40), bar(60_000, 40)]]]);
    const broker = new SimBroker(5_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, true, { mode: "fixed", pct: 0.04 });
    broker.seedPositions([{ symbol: "KO", side: "buy", qty: 50, entryPrice: 60, entryAt: 0 }]); // margin used: $3,000
    broker.now = 60_000;
    const res = await broker.openPosition({ symbol: "XLF", side: "buy", notionalUsd: 2_500 }); // needs $2,500 more than the $2,000 headroom
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("margin_insufficient");
  });

  test("checkStops fires the seed's OWN persisted stop level — never the sleeve's fixed hardStopPct", () => {
    // entryPrice 60, persisted stop 55.2 (−8%); the sleeve's fixed hardStopPct
    // is 4% (stop 57.6) — if seedPositions ignored the persisted price, this
    // bar's low (56) would ALSO breach 57.6 and fire at the wrong level.
    const candles = new Map([["KO", [bar(0, 60)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, true, { mode: "fixed", pct: 0.04 });
    broker.seedPositions([{ ...seed, entryAt: 0 }]); // checkStops skips a bar older than entryAt — anchor it at the test's bar
    broker.now = 0;
    broker.checkStops(new Map([["KO", bar(0, 60, 60, 54, 56)]])); // low 54 breaches 55.2; 56 does not
    expect(broker.positions).toHaveLength(0);
    expect(broker.closed[0].reason).toBe("stop_loss");
    expect(broker.closed[0].pnl).toBeCloseTo((55.2 - 60) * 50, 6);
  });

  test("a seed with no persisted stop falls back to the sleeve's fixed hardStopPct", () => {
    const candles = new Map([["KO", [bar(0, 60)]]]);
    const broker = new SimBroker(10_000, candles, 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, true, { mode: "fixed", pct: 0.04 });
    broker.seedPositions([{ symbol: "KO", side: "buy", qty: 50, entryPrice: 60, entryAt: 0 }]); // no stopPrice
    expect(broker.positions[0].stopFrac).toBeCloseTo(0.04, 12);
  });
});

describe("runWithConfig — seedPositions wiring (full replay, real engine)", () => {
  const H = 3_600_000;

  /** Hourly tape for a single symbol: flat warmup, then a hand-placed rally
   *  to a PEAK well before the epoch, then a pullback that lands exactly at
   *  the epoch — the bar whose close time equals `epochMs` (timestamp =
   *  epochMs − 1h) is the first one the engine's trail check ever reads
   *  (applyTrailStops prices off the last CLOSED bar at the tick's `now`). */
  function seedPeakThenPullbackTape(dbPath: string, epochMs: number, warmupDays: number) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE historical_bars (
        symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
        open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY(symbol, timeframe, source, timestamp)
      )`);
      const stmt = db.prepare("INSERT OR REPLACE INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      const path: Array<[number, number]> = [
        [epochMs - 6 * H, 100], [epochMs - 5 * H, 116], [epochMs - 4 * H, 132],
        [epochMs - 3 * H, 140], // PEAK
        [epochMs - 2 * H, 135], [epochMs - 1 * H, 130], // last pre-epoch close — tick 1's price
        [epochMs, 126], [epochMs + H, 120], [epochMs + 2 * H, 115], [epochMs + 3 * H, 110],
      ];
      db.transaction(() => {
        const loadFrom = epochMs - warmupDays * 86_400_000;
        for (let t = loadFrom; t < epochMs - 6 * H; t += H) {
          stmt.run("AAA", "1h", "synthetic", t, 100, 100.1, 99.9, 100, 1);
        }
        for (const [t, close] of path) {
          stmt.run("AAA", "1h", "synthetic", t, close, close + 0.1, close - 0.1, close, 1);
        }
      })();
    } finally {
      db.close();
    }
  }

  const EPOCH = Date.parse("2024-03-01T00:00:00Z");

  function cfg(dbPath: string): ReplayConfig {
    return {
      sleeve: "crypto", universe: ["AAA"], timeframe: "1h", source: "synthetic",
      refSymbol: "AAA", rthOnly: false, funding: false, barMinutes: 60, barMinutesEq: 60,
      slippageBps: 0, commissionBps: 0, initialEquity: 10_000, leverage: 1, hardStopPct: 0.04,
      hardStop: { mode: "none" }, // isolate the TRAIL as the only possible stop
      cadenceMin: 60, notionalPctPerSlot: 0.25, entryPct: 5, exitPct: -2, maxLongs: 1, maxShorts: 0,
      lookbackDays: 1, maLengthDays: 1, // minimal history requirement for this fixture
      shortFunding: "credit",
      tsmTrail: { kSigma: 1, lookbackBars: 5, minPct: 5, maxPct: 5 }, // pinned 5% distance
      warmupDays: 5,
      dbPath,
    };
  }

  test("the seeded trail watermark (the PRE-epoch peak) fires on the very FIRST tick — a freshly-initialized mark mathematically cannot", () => withTmp(async dir => {
    const dbPath = join(dir, "historical.db");
    seedPeakThenPullbackTape(dbPath, EPOCH, 5);
    const win = { label: "t", from: new Date(EPOCH).toISOString(), to: new Date(EPOCH + 4 * H).toISOString() };
    const seed: SeedPosition[] = [{ symbol: "AAA", side: "buy", qty: 1, entryPrice: 100, entryAt: EPOCH - 10 * 86_400_000 }];

    const seeded = await runWithConfig(cfg(dbPath), win, undefined, seed);
    expect(seeded).not.toBeNull();
    // Peak 140 (seeded) × 0.95 = 133 ≥ tick-1 price 130 → fires immediately.
    expect(seeded!.closedTrades.length).toBeGreaterThan(0);
    const first = seeded!.closedTrades[0];
    expect(first.symbol).toBe("AAA");
    expect(first.engineCloseReason).toBe(TRAIL_STOP_CLOSE_REASON);
    expect(first.exitAt).toBeLessThanOrEqual(EPOCH + H + 1); // fired at (or immediately after) the very first decision tick
    // Proof it's the INHERITED seed being managed, not a coincidental fresh
    // open-then-trail: the closed trade's entryAt is the seed's true (far
    // pre-epoch) entry time, never anything the replay itself could produce.
    expect(first.entryAt).toBe(seed[0].entryAt);

    // Control: without seeding, the book starts EMPTY — whatever the engine
    // does post-epoch (open fresh, or not), it can only ever inherit an
    // entryAt the REPLAY produced (at/after fromMs) — never the seed's.
    const unseeded = await runWithConfig(cfg(dbPath), win);
    expect(unseeded).not.toBeNull();
    for (const t of unseeded!.closedTrades) expect(t.entryAt).toBeGreaterThanOrEqual(EPOCH);
  }));
});

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "backtest-momentum-wf-seed-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
