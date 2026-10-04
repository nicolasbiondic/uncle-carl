// Profit-lock axis (opt-in, third stop mechanism alongside the fixed hard
// stop and the engine's own vol trail — see ProfitLockSpec's docstring in
// backtest-momentum-wf.ts). GOLDEN RULE enforced first: hashReplayConfig
// for any config that doesn't set `profitLock` must equal the SAME hash as
// before this field existed — same pattern as HardStopSpec/regime/
// maxGrossExposureMult in scripts/backtest-momentum-wf.replayFields.test.ts.
//
// Every checkStops test below constructs a SimPosition DIRECTLY (bypassing
// openPosition's execution-price plumbing, which is already covered by the
// "hard stop axis" describe block in scripts/backtest-momentum-wf.test.ts)
// so entry/peak/lock arithmetic stays exact and easy to hand-verify.

import { describe, expect, test } from "bun:test";
import { hashReplayConfig, SimBroker, type ReplayConfig } from "./backtest-momentum-wf";
import type { OHLCV } from "../src/utils/types";

const bar = (timestamp: number, open: number, high = open, low = open, close = open): OHLCV =>
  ({ timestamp, open, high, low, close, volume: 1 });

describe("profitLock — hash identity (GOLDEN RULE)", () => {
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

  test("absent profitLock (explicit undefined or omitted) preserves the legacy hash", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig(baseCfg)).toBe(legacy); // omitted key (baseCfg has no profitLock at all)
    expect(hashReplayConfig({ ...baseCfg, profitLock: undefined })).toBe(legacy); // explicit undefined
  });

  test("profitLock present changes the hash", () => {
    const legacy = hashReplayConfig(baseCfg);
    const withLock = hashReplayConfig({ ...baseCfg, profitLock: { armAtPct: 10, mode: "breakeven" as const, lockPct: 0 } });
    expect(withLock).not.toBe(legacy);
  });

  test("two candidates differing ONLY in profitLock params hash differently from each other too", () => {
    const a = hashReplayConfig({ ...baseCfg, profitLock: { armAtPct: 10, mode: "breakeven" as const, lockPct: 0 } });
    const b = hashReplayConfig({ ...baseCfg, profitLock: { armAtPct: 15, mode: "peakMinus" as const, lockPct: 8 } });
    expect(a).not.toBe(b);
  });
});

describe("profitLock — checkStops ratchet mechanics", () => {
  test("(b) long, breakeven lockPct 0: arms at +10%, effective level = entry (100); a low-99 bar closes at 100 reason profit_lock", () => {
    const profitLock = { armAtPct: 10, mode: "breakeven" as const, lockPct: 0 };
    const broker = new SimBroker(10_000, new Map(), 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, false, undefined, 1, 0, 0, "credit", profitLock);
    broker.positions.push({ symbol: "A", side: "buy", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 1_000, peakPrice: 100, lockLevel: null });

    // Rise to 112 (+12% > armAt 10%): arms the lock at breakeven (100),
    // strictly tighter than the 4% hard stop (96) — no fill yet.
    broker.checkStops(new Map([["A", bar(60_000, 112, 113, 111, 112)]]));
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0].lockLevel).toBeCloseTo(100, 9);

    // Pull back: open 100 (no gap through 100), low 99 crosses the lock.
    broker.checkStops(new Map([["A", bar(120_000, 100, 100.5, 99, 99.5)]]));
    expect(broker.positions).toHaveLength(0);
    expect(broker.closed[0].reason).toBe("profit_lock");
    expect(broker.closed[0].exitPrice).toBeCloseTo(100, 9);
  });

  test("(c) same series WITHOUT profitLock: holds through the low-99 pullback (hard stop 96 untouched), closes only when price actually reaches 96 (stop_loss)", () => {
    const broker = new SimBroker(10_000, new Map(), 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04);
    broker.positions.push({ symbol: "A", side: "buy", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 1_000, peakPrice: 100, lockLevel: null });

    broker.checkStops(new Map([["A", bar(60_000, 112, 113, 111, 112)]]));
    expect(broker.positions).toHaveLength(1);

    broker.checkStops(new Map([["A", bar(120_000, 100, 100.5, 99, 99.5)]]));
    expect(broker.positions).toHaveLength(1); // no lock configured: the same low-99 bar does NOT close it

    broker.checkStops(new Map([["A", bar(180_000, 97, 97, 95, 96)]]));
    expect(broker.positions).toHaveLength(0);
    expect(broker.closed[0].reason).toBe("stop_loss");
    expect(broker.closed[0].exitPrice).toBeCloseTo(96, 9);
  });

  test("(d) long, peakMinus lockPct 8, armAt 15: ratchets 110.4 → 119.6 as the peak rises; a mid pullback to 121 does NOT close; 118 closes at 119.6 profit_lock", () => {
    const profitLock = { armAtPct: 15, mode: "peakMinus" as const, lockPct: 8 };
    const broker = new SimBroker(10_000, new Map(), 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, false, undefined, 1, 0, 0, "credit", profitLock);
    broker.positions.push({ symbol: "A", side: "buy", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 1_000, peakPrice: 100, lockLevel: null });

    // +20% arms at peak 120: lock = 120 × 0.92 = 110.4.
    broker.checkStops(new Map([["A", bar(60_000, 120, 120, 120, 120)]]));
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0].lockLevel).toBeCloseTo(110.4, 9);

    // New peak 130: lock ratchets up to 130 × 0.92 = 119.6.
    broker.checkStops(new Map([["A", bar(120_000, 130, 130, 130, 130)]]));
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0].lockLevel).toBeCloseTo(119.6, 9);

    // Pull back to 121 (low 120, above the 119.6 lock): holds; peak/lock unchanged.
    broker.checkStops(new Map([["A", bar(180_000, 121, 122, 120, 121)]]));
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0].lockLevel).toBeCloseTo(119.6, 9);

    // No gap (open 120 > level), low 118 crosses 119.6 → fills AT the level.
    broker.checkStops(new Map([["A", bar(240_000, 120, 120, 118, 118)]]));
    expect(broker.positions).toHaveLength(0);
    expect(broker.closed[0].reason).toBe("profit_lock");
    expect(broker.closed[0].exitPrice).toBeCloseTo(119.6, 9);
  });

  test("(e) the lock NEVER retreats: peak 130 → pullback to 125 leaves lockLevel at 119.6, not 125×0.92", () => {
    const profitLock = { armAtPct: 15, mode: "peakMinus" as const, lockPct: 8 };
    const broker = new SimBroker(10_000, new Map(), 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, false, undefined, 1, 0, 0, "credit", profitLock);
    broker.positions.push({ symbol: "A", side: "buy", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 1_000, peakPrice: 100, lockLevel: null });

    broker.checkStops(new Map([["A", bar(60_000, 130, 131, 129, 130)]]));
    expect(broker.positions[0].lockLevel).toBeCloseTo(119.6, 9); // 130 × 0.92

    // Close pulls back to 125 (still well above the 119.6 lock) — must NOT
    // recompute a looser level off the new, lower close.
    broker.checkStops(new Map([["A", bar(120_000, 126, 127, 124, 125)]]));
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0].lockLevel).toBeCloseTo(119.6, 9); // unchanged — NOT 125 × 0.92 = 115
    expect(broker.positions[0].peakPrice).toBeCloseTo(130, 9); // peak itself never retreats either
  });

  test("(f) short, mirrored: peakMinus lockPct 8, armAt 15 ratchets DOWN (86.4 → 75.6) as the trough deepens; a rebound through the lock closes at 75.6 profit_lock", () => {
    const profitLock = { armAtPct: 15, mode: "peakMinus" as const, lockPct: 8 };
    const broker = new SimBroker(10_000, new Map(), 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, false, undefined, 1, 0, 0, "credit", profitLock);
    broker.positions.push({ symbol: "A", side: "sell", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 1_000, peakPrice: 100, lockLevel: null });

    // Falls to a trough of 80 (+20% short gain): arms at 80 × 1.08 = 86.4.
    broker.checkStops(new Map([["A", bar(60_000, 80, 80, 80, 80)]]));
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0].lockLevel).toBeCloseTo(86.4, 9);

    // Deepens to 70 (+30%): ratchets DOWN (tighter/more protective for a
    // short) to 70 × 1.08 = 75.6, strictly below the 4% hard stop (104).
    broker.checkStops(new Map([["A", bar(120_000, 70, 70, 70, 70)]]));
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0].lockLevel).toBeCloseTo(75.6, 9);

    // Rebound: no gap (open 72 < level), high 76 crosses 75.6 → fills AT the level.
    broker.checkStops(new Map([["A", bar(180_000, 72, 76, 71, 72)]]));
    expect(broker.positions).toHaveLength(0);
    expect(broker.closed[0].reason).toBe("profit_lock");
    expect(broker.closed[0].exitPrice).toBeCloseTo(75.6, 9);
  });

  test("(g) before arming, a retreat fires ONLY the hard stop (reason stop_loss), even with profitLock configured", () => {
    const profitLock = { armAtPct: 10, mode: "breakeven" as const, lockPct: 0 };
    const broker = new SimBroker(10_000, new Map(), 0, 0, 60_000, { leverage: 1, maintRate: 0.25 }, 0.04, undefined, false, undefined, 1, 0, 0, "credit", profitLock);
    broker.positions.push({ symbol: "A", side: "buy", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 1_000, peakPrice: 100, lockLevel: null });

    // Only +5% — below the 10% arm threshold: lockLevel stays null.
    broker.checkStops(new Map([["A", bar(60_000, 105, 105, 105, 105)]]));
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0].lockLevel).toBeNull();

    // Retreat through the hard stop (96) while still never having armed.
    broker.checkStops(new Map([["A", bar(120_000, 97, 97, 94, 95)]]));
    expect(broker.positions).toHaveLength(0);
    expect(broker.closed[0].reason).toBe("stop_loss");
    expect(broker.closed[0].exitPrice).toBeCloseTo(96, 9);
  });
});
