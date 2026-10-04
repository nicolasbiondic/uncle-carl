// Engine wiring of risk.ddScale (continuous drawdown-scaled ENTRY sizing):
//   1. The factor multiplies NEW-entry notional (equity × pctPerSlot × dd).
//   2. It COMPOSES with volTarget (dd × vol) — Grossman-Zhou over vt-35.
//   3. Soft-DD lockout gone: a dd that legacy pauses on keeps trading scaled.
//   4. Held positions are never resized; exits still run (entries-only).
//   5. Legacy (no ddScale): report carries NO entryScale key, sizing exact.
import { describe, expect, test } from "bun:test";
import { MomentumEngine, volTargetScale } from "./MomentumEngine";
import { INITIAL_RISK_STATE } from "./RiskGuard";
import { ramp, FakeBroker, silentLogger, MemoryPersistence } from "../../test-support/momentum";

/** Persistence seeding a drawdown as an OVERNIGHT loss: peakEquity `peak`,
 *  dayStartEquity `dayStart` (set it to the broker's current equity so the
 *  intact 3% daily cap doesn't fire on top of the drawdown under test).
 *  lastEvalAt is "now-ish" so the 30d-half-life peak decay is negligible
 *  within one tick. */
function seededPersistence(peak: number, dayStart: number): MemoryPersistence {
  const p = new MemoryPersistence();
  p.store = {
    v: 1,
    risk: { ...INITIAL_RISK_STATE, peakEquity: peak, dayStartEquity: dayStart, dayStartedAt: Date.now(), lastEvalAt: Date.now() },
  };
  return p;
}

const DD = { startPct: 0.05, endPct: 0.20, minScale: 0 };

describe("MomentumEngine risk.ddScale", () => {
  test("scales NEW-entry notional linearly with the drawdown (soft pause gone)", async () => {
    const broker = new FakeBroker();
    broker.equity = 8_800; // dd 12% vs peak 10 000 → scale 1−(0.12−0.05)/0.15
    broker.setCandles("UP1", ramp(100, 130));
    const engine = new MomentumEngine({
      universe: ["UP1"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
      risk: { ddScale: DD },
    }, broker, silentLogger, seededPersistence(10_000, 8_800));

    const report = await engine.tick();

    // Legacy would be BLOCKED here (soft drawdown 12% ≥ 10%); ddScale trades on.
    expect(report.tradeable).toBe(true);
    const expectedScale = 1 - 0.07 / 0.15;
    expect(report.entryScale).toBeCloseTo(expectedScale, 6);
    expect(broker.opened).toHaveLength(1);
    expect(broker.opened[0].notionalUsd).toBeCloseTo(8_800 * 0.30 * expectedScale, 3);
  });

  test("composes multiplicatively with volTarget sizing", async () => {
    const vt = { annualizedPct: 35, lookbackBars: 720, minScale: 0.33, maxScale: 1.5 };
    const broker = new FakeBroker();
    broker.equity = 8_800;
    const candles = ramp(100, 130);
    broker.setCandles("UP1", candles);
    const engine = new MomentumEngine({
      universe: ["UP1"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
      volTarget: vt,
      risk: { ddScale: DD },
    }, broker, silentLogger, seededPersistence(10_000, 8_800));

    const report = await engine.tick();

    expect(report.tradeable).toBe(true);
    const ddFactor = 1 - 0.07 / 0.15;
    // Same closes/barsPerYear the engine used (5m default bars → 288/day).
    const vtFactor = volTargetScale(candles.map(c => c.close), vt, 288 * 365);
    expect(broker.opened).toHaveLength(1);
    expect(broker.opened[0].notionalUsd).toBeCloseTo(8_800 * 0.30 * ddFactor * vtFactor, 3);
  });

  test("hard drawdown still blocks entirely under ddScale", async () => {
    const broker = new FakeBroker();
    broker.equity = 7_800; // dd 22% ≥ hard 20%
    broker.setCandles("UP1", ramp(100, 130));
    const engine = new MomentumEngine({
      universe: ["UP1"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
      risk: { ddScale: DD },
    }, broker, silentLogger, seededPersistence(10_000, 7_800));

    const report = await engine.tick();

    expect(report.tradeable).toBe(false);
    expect(report.blockedReason).toContain("hard drawdown");
    expect(broker.opened).toEqual([]);
  });

  test("entries-only: a held position is neither resized nor closed by scaling; exits still run", async () => {
    const broker = new FakeBroker();
    broker.equity = 10_000;
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine({
      universe: ["X"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
      // dailyLossCapPct neutralized: the 15% drawdown below is INTRADAY by
      // construction and would trip the (intact) 3% cap — this test isolates
      // the entries-only semantics of the scaling itself.
      risk: { ddScale: DD, dailyLossCapPct: 1 },
    }, broker, silentLogger, seededPersistence(10_000, 10_000));
    await engine.tick(); // opens X at full size (no dd yet)
    const heldNotional = broker.positions[0].notional;

    // Equity draws down 15% → deep in the scaled regime; signal still long.
    broker.equity = 8_500;
    const report = await engine.tick();
    expect(report.tradeable).toBe(true);
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0].notional).toBe(heldNotional); // untouched
    expect(broker.closed).toEqual([]);

    // Signal flips → the exit executes even while scaled.
    broker.setCandles("X", ramp(130, 80));
    await engine.tick();
    expect(broker.closed.map(a => a.symbol)).toEqual(["X"]);
  });

  test("legacy intact: without ddScale the report has NO entryScale key and dd 12% still soft-pauses", async () => {
    const broker = new FakeBroker();
    broker.equity = 8_800;
    broker.setCandles("UP1", ramp(100, 130));
    const engine = new MomentumEngine({
      universe: ["UP1"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
    }, broker, silentLogger, seededPersistence(10_000, 8_800));

    const report = await engine.tick();

    expect("entryScale" in report).toBe(false);
    expect(report.tradeable).toBe(false);
    expect(report.blockedReason).toContain("soft drawdown");
    expect(broker.opened).toEqual([]);
  });

  test("legacy sizing byte-identity: no ddScale, no dd → notional is exactly equity × pctPerSlot", async () => {
    const broker = new FakeBroker();
    broker.setCandles("UP1", ramp(100, 130));
    const engine = new MomentumEngine({
      universe: ["UP1"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
    }, broker, silentLogger);

    await engine.tick();

    expect(broker.opened).toHaveLength(1);
    expect(broker.opened[0].notionalUsd).toBe(10_000 * 0.30);
  });
});
