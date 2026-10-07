// Runtime backstop test for MomentumEngineConfig.maxGrossExposureMult (see
// its docstring in MomentumEngine.ts). Two things locked here:
//  1. At TODAY's production config (notionalPctPerSlot=0.125, maxLongs=8,
//     cap=1.0×), the cap never blocks anything — the theoretical bound
//     already can't exceed it by construction.
//  2. The NEXT escalation (an extra slot, or a bigger per-slot size) that
//     would push live gross exposure past the declared cap gets a NEW open
//     blocked, not force-closed anything already held.
import { describe, expect, test } from "bun:test";
import { MomentumEngine } from "./MomentumEngine";
import { ramp, FakeBroker, silentLogger } from "../../test-support/momentum";
import { MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT, MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT, MOMENTUM_STOCKS_MAX_LONGS } from "../../index";

describe("MomentumEngine gross-exposure guard", () => {
  test("today's real cap (1.0x, 8 slots x 0.125 since 2026-09-25) opens exactly the top 8 candidates, none blocked", async () => {
    const broker = new FakeBroker(); // equity = 10_000
    // 9 strong-gainer candidates, distinct returns so ranking is deterministic.
    const universe: string[] = [];
    for (let i = 1; i <= 9; i++) { universe.push(`UP${i}`); broker.setCandles(`UP${i}`, ramp(100, 210 - 10 * i)); }
    const engine = new MomentumEngine({
      universe,
      notionalPctPerSlot: MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT, // 0.125 — same as production
      tsm: { maxLongs: MOMENTUM_STOCKS_MAX_LONGS }, // 8 — same as production
      maxGrossExposureMult: MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT, // 1.0 — same as production
      scorer: { topLongs: 9, minLongScore: 0.001 },
      regime: { minSymbolsForCorrelation: 100 },
    }, broker, silentLogger);

    const report = await engine.tick();

    expect(report.tradeable).toBe(true);
    // TSM's own maxLongs=8 picks the 8 best trends (UP1-UP8); the guard
    // doesn't need to block anything because 8 x 0.125 = 1.0x is exactly the cap.
    expect(broker.opened.map(a => a.symbol).sort()).toEqual(universe.slice(0, 8).sort());
    expect(broker.opened.length).toBe(8);
    const totalNotional = broker.opened.reduce((s, a) => s + a.notionalUsd, 0);
    expect(totalNotional).toBeCloseTo(10_000, 0); // exactly 1.0x of 10k equity
  });

  test("blocks the next escalation: bumping maxLongs to 10 (unchanged notionalPctPerSlot/cap) still caps gross exposure at the 1.15x backstop", async () => {
    // Since 2026-10-07 the backstop carries the measured headroom (1.15x =
    // product × GROSS_CAP_HEADROOM — G diagnostic, docs/reports/
    // G-gross-cap.md), so a maxLongs 8→9 bump (1.125x) now fits INSIDE it by
    // design (that is exactly the organic mark-to-market drift the headroom
    // exists for). The escalation the guard still blocks is 10 slots (1.25x).
    const broker = new FakeBroker(); // equity = 10_000
    const universe: string[] = [];
    for (let i = 1; i <= 10; i++) { universe.push(`UP${i}`); broker.setCandles(`UP${i}`, ramp(100, 215 - 10 * i)); }
    const engine = new MomentumEngine({
      universe,
      notionalPctPerSlot: MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT, // 0.125 — unchanged
      tsm: { maxLongs: 10 }, // ESCALATED from production's 8 — nobody updated the cap
      maxGrossExposureMult: MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT, // still 1.15 (unchanged)
      scorer: { topLongs: 10, minLongScore: 0.001 },
      regime: { minSymbolsForCorrelation: 100 },
    }, broker, silentLogger);

    await engine.tick();

    // TSM itself would happily open all 10 (10 x 0.125 = 1.25x) — the guard
    // is the only thing stopping it: 9 x $1,250 = $11,250 fits the $11,500
    // cap, the weakest-ranked (10th) candidate does not.
    expect(broker.opened.length).toBe(9);
    expect(broker.opened.map(a => a.symbol).sort()).toEqual(universe.slice(0, 9).sort());
    const totalNotional = broker.opened.reduce((s, a) => s + a.notionalUsd, 0);
    expect(totalNotional).toBeLessThanOrEqual(10_000 * MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT); // never exceeds the 1.15x cap
  });

  test("blocks the next escalation: bumping notionalPctPerSlot to 0.375 (unchanged maxLongs/cap)", async () => {
    const broker = new FakeBroker(); // equity = 10_000
    broker.setCandles("UP1", ramp(100, 200));
    broker.setCandles("UP2", ramp(100, 180));
    broker.setCandles("UP3", ramp(100, 170));
    broker.setCandles("UP4", ramp(100, 160));
    const engine = new MomentumEngine({
      universe: ["UP1", "UP2", "UP3", "UP4"],
      notionalPctPerSlot: 0.375, // ESCALATED from production's 0.125 — "3x per slot"
      tsm: { maxLongs: MOMENTUM_STOCKS_MAX_LONGS }, // 8 — unchanged
      maxGrossExposureMult: MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT, // still 1.15 (unchanged)
      scorer: { topLongs: 4, minLongScore: 0.001 },
      regime: { minSymbolsForCorrelation: 100 },
    }, broker, silentLogger);

    await engine.tick();

    // Each slot now wants $3,750 (0.375 x 10k). Cap is $11,500 (1.15x since
    // 2026-10-07): 3 slots ($11.25k) fit, a 4th ($15k) does not — the guard
    // blocks it.
    expect(broker.opened.length).toBe(3);
    const totalNotional = broker.opened.reduce((s, a) => s + a.notionalUsd, 0);
    expect(totalNotional).toBeLessThanOrEqual(10_000 * MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT);
  });

  test("never force-closes an already-held position — the guard only blocks NEW opens", async () => {
    const broker = new FakeBroker();
    broker.positions = [{ symbol: "HELD", side: "buy", quantity: 1, notional: 19_000 }]; // already near the cap
    broker.setCandles("HELD", ramp(100, 130));
    broker.setCandles("NEW", ramp(100, 200));
    const engine = new MomentumEngine({
      universe: ["HELD", "NEW"],
      notionalPctPerSlot: 0.5,
      maxGrossExposureMult: 2.0, // cap = $20,000 on $10k equity
      scorer: { topLongs: 2, minLongScore: 0.001 },
      regime: { minSymbolsForCorrelation: 100 },
    }, broker, silentLogger);

    const report = await engine.tick();

    // HELD stays open (never force-closed by the guard); NEW is blocked
    // because 19,000 + 5,000 > 20,000.
    expect(broker.closed).toEqual([]);
    expect(broker.opened).toEqual([]);
    expect(report.unchanged).toContain("HELD");
  });
});
