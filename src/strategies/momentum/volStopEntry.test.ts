// ══════════════════════════════════════════════
// Vol-scaled hard stop at entry (owner override 2026-08-28)
// ══════════════════════════════════════════════
//
// "No es la estrategia, es cómo la aplicas": the locked stop-sizing
// artifacts measured the fixed profile 4% as the WORST setting of its axis
// on BOTH stock sleeves (ff70c47e stocks: +7.55%/Sharpe 0.257 vs vol-k3
// +30.12%/0.618 with NO drawdown benefit; 9dcd9781 meanrev: 0.561 vs
// 0.725). The protocol could not approve the change (both sleeves still
// lose to SPY on every stop policy), so this ships as a DOCUMENTED owner
// override on the stop axis only — same class as the 2026-08-08 crypto
// promotion note in sleeve_modes.
//
// Locked here (the full chain, so no single layer can silently revert):
//  • MomentumEngine with `volStop` passes stopLossPct =
//    trailPctFromVol(decision closes, spec, barsPerDay) — the EXACT
//    production formula the artifacts validated — to openPosition.
//  • Without `volStop` (Binance sleeves: axis never swept) the action
//    carries NO stopLossPct: legacy fixed distance, behavior unchanged.
//  • MeanRevEngine passes it on DAILY bars (barsPerDay = 1).
//  • AlpacaMomentumAdapter derives the stop PRICE from the REAL fill and
//    persists trades.stop_loss; absent → NULL (legacy).
//  • rowStopPct (AccountManager): row-stop precedence + protective-side
//    validation — the derivation every stop consumer must share.

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { getDB } from "../../db/database";
import { MomentumEngine, trailPctFromVol, type TrailStopConfig } from "./MomentumEngine";
import { DEFAULT_TSM_CONFIG } from "./TimeSeriesMomentum";
import { MeanRevEngine, type MeanRevLogger } from "../meanrev/MeanRevEngine";
import { AlpacaMomentumAdapter } from "./AlpacaMomentumAdapter";
import { rowStopPct } from "../../account/AccountManager";
import { FakeBroker, ramp, silentLogger } from "../../test-support/momentum";
import { daily, flatThen, FakeAdapter, MEANREV_ANCHOR } from "../../test-support/meanrev";
import { makeTestDb } from "../../test-support/db";

const STOCKS_SPEC: TrailStopConfig = { kSigma: 3, lookbackBars: 78, minPct: 2, maxPct: 8 };
const MEANREV_SPEC: TrailStopConfig = { kSigma: 3, lookbackBars: 20, minPct: 2, maxPct: 12 };

beforeAll(() => { makeTestDb(); });
afterEach(() => {
  getDB().exec(`DELETE FROM trades; DELETE FROM orders; DELETE FROM signals;`);
});

describe("MomentumEngine → openPosition.stopLossPct", () => {
  test("with volStop: stopLossPct is EXACTLY trailPctFromVol over the decision closes", async () => {
    const broker = new FakeBroker();
    const candles = ramp(100, 130); // strong gainer → opens
    broker.setCandles("UP", candles);
    const engine = new MomentumEngine(
      {
        universe: ["UP"], notionalPctPerSlot: 0.3,
        scorer: { topLongs: 1, minLongScore: 0.001 },
        volStop: STOCKS_SPEC,
      },
      broker, silentLogger,
    );

    await engine.tick();

    expect(broker.opened).toHaveLength(1);
    // barsPerDay mirrors the engine's own derivation from the default bar size.
    const barsPerDay = (24 * 60) / DEFAULT_TSM_CONFIG.barMinutes;
    const expected = trailPctFromVol(candles.map(c => c.close), STOCKS_SPEC, barsPerDay);
    expect(broker.opened[0].stopLossPct).toBeCloseTo(expected, 10);
    // And the spec's clamps hold — a degenerate expectation here would mean
    // the fixture no longer exercises the formula.
    expect(expected).toBeGreaterThanOrEqual(STOCKS_SPEC.minPct);
    expect(expected).toBeLessThanOrEqual(STOCKS_SPEC.maxPct);
  });

  test("without volStop (Binance sleeves): the action carries NO stopLossPct — legacy fixed distance", async () => {
    const broker = new FakeBroker();
    broker.setCandles("UP", ramp(100, 130));
    const engine = new MomentumEngine(
      { universe: ["UP"], notionalPctPerSlot: 0.3, scorer: { topLongs: 1, minLongScore: 0.001 } },
      broker, silentLogger,
    );

    await engine.tick();

    expect(broker.opened).toHaveLength(1);
    expect("stopLossPct" in broker.opened[0]).toBe(false);
  });
});

describe("MeanRevEngine → openPosition.stopLossPct (daily bars, barsPerDay = 1)", () => {
  const silent: MeanRevLogger = { info: () => {}, warn: () => {}, error: () => {} };

  test("with volStop: entry carries trailPctFromVol of the daily closes", async () => {
    const adapter = new FakeAdapter();
    // Smooth ~1-1.7%/day moves — NOT the old fixture's +50% jump, which
    // saturated trailPctFromVol at maxPct=12, the SAME value the fail-open
    // path returns for `[]` (OPEN.md P2(d): a degenerate expected can't
    // distinguish "computed from the decision closes" from "computed from
    // nothing"). Ends on two down closes (RSI2 == 0 < entryRsi) while
    // staying above the flat-205 SMA200.
    const closes = flatThen(100, [
      101.6, 100.62464, 102.073635, 100.93041, 102.706785, 101.885131,
      103.189261, 101.703335, 103.656039, 102.660941, 103.810744, 102.481966,
      104.121678, 103.288704, 104.776062, 103.60257, 105.757503, 106.434351,
      105.071992, 103.222725,
    ]);
    adapter.setCandles("KO", daily(closes));
    const engine = new MeanRevEngine(
      { accountId: adapter.accountId, universe: ["KO"], baseUsd: 50_000, volStop: MEANREV_SPEC },
      adapter, silent,
      { isTradingDay: () => true, now: () => MEANREV_ANCHOR },
    );

    await engine.runDaily();

    expect(adapter.opened).toHaveLength(1);
    // NOT "the engine drops today's partial daily bar" (that slice never
    // fires on this fixture): test-support's daily() already builds bars
    // ENDING YESTERDAY relative to MEANREV_ANCHOR, so the array the engine
    // decides on (MeanRevEngine.runDaily's `candles` map) is exactly
    // `daily(closes)` — no additional slicing to mirror here.
    const decisionCloses = daily(closes).map(b => b.close);
    const expected = trailPctFromVol(decisionCloses, MEANREV_SPEC, 1);
    expect(adapter.opened[0].stopLossPct).toBeCloseTo(expected, 6);
    // The spec's clamps hold STRICTLY — landing on either bound would be
    // indistinguishable from the fail-open (empty-closes) path again.
    expect(expected).toBeGreaterThan(MEANREV_SPEC.minPct);
    expect(expected).toBeLessThan(MEANREV_SPEC.maxPct);
  });

  test("without volStop: no stopLossPct on the action", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("KO", daily(flatThen(100, [150, 150.1, 138])));
    const engine = new MeanRevEngine(
      { accountId: adapter.accountId, universe: ["KO"], baseUsd: 50_000 },
      adapter, silent,
      { isTradingDay: () => true, now: () => MEANREV_ANCHOR },
    );

    await engine.runDaily();

    expect(adapter.opened).toHaveLength(1);
    expect("stopLossPct" in adapter.opened[0]).toBe(false);
  });
});

describe("AlpacaMomentumAdapter — persists the stop PRICE from the REAL fill", () => {
  function stubAlpaca(filledPrice: number) {
    return {
      isConnected: () => true,
      getCachedPrice: () => 100,
      getLatestPrice: async () => 100,
      getExecutableQuote: async () => null,
      getRegTBuyingPower: async () => null,
      placeOrder: async (_sig: any, qty: number) => ({
        id: "volstop-fill", quantity: qty, status: "filled",
        filledPrice, filledQty: qty, externalId: "ext-volstop",
      }),
    } as any;
  }

  test("stopLossPct + buy fill 101 → trades.stop_loss = 101 × (1 − pct/100), anchored to FILL not decision price", async () => {
    const res = await new AlpacaMomentumAdapter(stubAlpaca(101), { accountId: "momentum_stocks" })
      .openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000, stopLossPct: 5 });
    expect(res.ok).toBe(true);
    const row = getDB().prepare(`SELECT stop_loss FROM trades WHERE id = 'volstop-fill'`).get() as any;
    expect(row.stop_loss).toBeCloseTo(101 * 0.95, 10);
  });

  test("no stopLossPct → stop_loss NULL (legacy fixed-distance consumers unchanged)", async () => {
    const res = await new AlpacaMomentumAdapter(stubAlpaca(101), { accountId: "momentum_stocks" })
      .openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(true);
    const row = getDB().prepare(`SELECT stop_loss FROM trades WHERE id = 'volstop-fill'`).get() as any;
    expect(row.stop_loss).toBeNull();
  });
});

describe("rowStopPct — the ONE derivation every stop consumer shares", () => {
  test("row stop price → percent distance from entry", () => {
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: 94 }, 4)).toBeCloseTo(6, 10);
    expect(rowStopPct({ side: "sell", entryPrice: 100, stopLoss: 103 }, 4)).toBeCloseTo(3, 10);
  });

  test("no row stop → profile fallback", () => {
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: null }, 4)).toBe(4);
    expect(rowStopPct({ side: "buy", entryPrice: 100 }, 4)).toBe(4);
  });

  test("non-protective (inverted) or corrupt stop falls back — never arms a nonsense stop", () => {
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: 105 }, 4)).toBe(4);  // above entry on a long
    expect(rowStopPct({ side: "sell", entryPrice: 100, stopLoss: 95 }, 4)).toBe(4);  // below entry on a short
    expect(rowStopPct({ side: "buy", entryPrice: 0, stopLoss: 95 }, 4)).toBe(4);     // corrupt entry
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: -5 }, 4)).toBe(4);   // corrupt stop
  });
});
