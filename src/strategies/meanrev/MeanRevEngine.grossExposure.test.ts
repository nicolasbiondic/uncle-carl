// Runtime backstop test for MeanRevEngineConfig.maxGrossExposureMult (see its
// docstring, mirrors MomentumEngine.maxGrossExposureMult). meanrev_stocks
// doesn't have the SAME "invisible emergent multiplication" bug momentum_
// stocks had (slotPct and maxPositions already live in one config object,
// DEFAULT_MEANREV_CONFIG) — this is defense-in-depth for a slotPct-only bump
// that would raise exposure without anyone touching maxPositions.
import { describe, expect, test } from "bun:test";
import { MeanRevEngine, type MeanRevLogger } from "./MeanRevEngine";
import { DAY, MEANREV_ANCHOR as ANCHOR, daily, flatThen, FakeAdapter } from "../../test-support/meanrev";
import { makeTestDb } from "../../test-support/db";
import { MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT } from "../../index";

const silent: MeanRevLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeEngine(adapter: FakeAdapter, universe: string[], extra: any = {}) {
  return new MeanRevEngine(
    { accountId: adapter.accountId, universe, baseUsd: 50_000, ...extra },
    adapter,
    silent,
    { isTradingDay: () => true, now: () => ANCHOR },
  );
}

makeTestDb();

describe("MeanRevEngine gross-exposure guard", () => {
  test("today's real cap (0.84x = 7 slots x 0.12) opens all 7 signalling candidates, none blocked", async () => {
    const adapter = new FakeAdapter();
    const universe: string[] = [];
    for (let i = 0; i < 7; i++) {
      const sym = `S${i}`;
      universe.push(sym);
      // Drops well past the RSI2<5 threshold for every symbol (see the
      // "maxPositions respected" test in MeanRevEngine.test.ts — a small
      // drop like `1+i` does NOT reliably signal for low i; these do).
      adapter.setCandles(sym, daily(flatThen(100, [150, 150.1, 150.1 - (10 + i)])));
    }
    const engine = makeEngine(adapter, universe, { maxGrossExposureMult: MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT });

    await engine.runDaily();

    // 7 x (50,000 x 0.12) = 42,000 = exactly 0.84x of baseUsd — the cap.
    expect(adapter.opened.length).toBe(7);
  });

  test("blocks the next escalation: bumping slotPct to 0.15 (unchanged maxPositions/cap)", async () => {
    const adapter = new FakeAdapter();
    const universe: string[] = [];
    for (let i = 0; i < 7; i++) {
      const sym = `S${i}`;
      universe.push(sym);
      adapter.setCandles(sym, daily(flatThen(100, [150, 150.1, 150.1 - (10 + i)])));
    }
    const engine = makeEngine(adapter, universe, {
      slotPct: 0.15, // ESCALATED from production's 0.12 — nobody touched maxPositions or the cap
      maxGrossExposureMult: MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT, // still 0.84x (unchanged)
    });

    await engine.runDaily();

    // Each slot now wants $7,500 (0.15 x 50k). Cap is $42,000: 5 slots
    // ($37.5k) fit, a 6th ($45k) does not.
    expect(adapter.opened.length).toBe(5);
    const totalNotional = adapter.opened.reduce((s, o) => s + o.notionalUsd, 0);
    expect(totalNotional).toBeLessThanOrEqual(42_000);
  });

  test("never force-closes an already-held position — the guard only blocks NEW opens", async () => {
    const adapter = new FakeAdapter();
    // HELD already carries most of the cap's headroom.
    const flatCandles = daily(flatThen(100, [100, 99, 98, 97, 96, 95])); // no SMA5 exit
    adapter.setCandles("HELD", flatCandles);
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 1, notional: 24_000, entryTime: ANCHOR - DAY }];
    adapter.setCandles("NEW", daily(flatThen(100, [150, 150.1, 145])));
    const engine = makeEngine(adapter, ["HELD", "NEW"], { maxGrossExposureMult: 0.5 }); // cap = $25,000

    await engine.runDaily();

    expect(adapter.closed).toEqual([]); // HELD never force-closed
    expect(adapter.opened).toEqual([]); // NEW blocked: 24,000 + 5,000 > 25,000
  });
});
