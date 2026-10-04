// Model-cutover re-anchor, revision 2 (2026-09-28): the loss streak is
// model-local, like the peak. Revision 1 carried momentum_crypto's 4 losing
// rebalances from the pre-vt-35 model through the 09-26 cutover; one stop
// 36h later (ADA, −$36.56) completed "5 consecutive" and paused entries 24h.
//
//   1. FRESH CUTOVER: streak := 0 and an inherited streak pause is cleared,
//      together with the peak (the old model's last period dies with it).
//   2. REVISION UPGRADE (state stamped under rev 1, same model): the streak
//      restarts at 0 in the constructor — the first recorded period after it
//      belongs to the current model and counts — a streak pause clears on the
//      next tick with ONE pause_resolved, and the peak is NOT re-anchored.
//   3. A soft-drawdown or hard pause of the current model survives the
//      upgrade; the upgrade runs once; no modelVersion = legacy behavior.
import { describe, expect, test } from "bun:test";
import { MomentumEngine } from "./MomentumEngine";
import { INITIAL_RISK_STATE, MODEL_REANCHOR_REV, type RiskState } from "./RiskGuard";
import { ramp, FakeBroker, silentLogger, MemoryPersistence } from "../../test-support/momentum";
import { captureEvent } from "../../test-support/events";
import { EVENTS } from "../../utils/events";

const now = Date.now();
const STREAK_PAUSE = "5 consecutive losing rebalances — paused 24h";

function makeEngine(broker: FakeBroker, persistence: MemoryPersistence, modelVersion?: string, heartbeatName?: string) {
  return new MomentumEngine(
    {
      universe: ["X"],
      notionalPctPerSlot: 1.0,
      ...(modelVersion !== undefined ? { modelVersion } : {}),
      ...(heartbeatName ? { heartbeatName } : {}),
    },
    broker,
    silentLogger,
    persistence,
  );
}

/** data/momentum-state-crypto.json on prod, 2026-09-28 06:44 UTC: stamped
 *  "vt35-2026-09-23" under revision 1, streak just tripped. */
const stampedRev1 = (over: Partial<RiskState> = {}): RiskState => ({
  ...INITIAL_RISK_STATE,
  peakEquity: 5417.99,
  dayStartEquity: 5340.48,
  dayStartedAt: now - 3_600_000,
  consecutiveLosses: 0,
  pausedUntil: now + 23 * 3_600_000,
  pauseReason: STREAK_PAUSE,
  lastEvalAt: now - 60_000,
  modelVersion: "crypto-v2",
  pendingModelReanchor: false,
  ...over,
});

describe("model re-anchor revision 2 — the loss streak is model-local", () => {
  test("fresh cutover: an inherited streak and its pause reset together with the peak", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    broker.equity = 10_000;
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: { ...INITIAL_RISK_STATE, peakEquity: 12_000, dayStartEquity: 10_000, dayStartedAt: now - 3_600_000, consecutiveLosses: 4, pausedUntil: now + 3_600_000, pauseReason: STREAK_PAUSE, lastEvalAt: now - 60_000 } };

    const engine = makeEngine(broker, persistence, "crypto-v2");
    expect(engine.getRiskState().modelReanchorRev).toBe(MODEL_REANCHOR_REV);
    const report = await engine.tick();
    expect(report.tradeable).toBe(true);
    const st = engine.getRiskState();
    expect(st.consecutiveLosses).toBe(0);
    expect(st.peakEquity).toBe(10_000);
    expect(st.pausedUntil).toBe(0);
  });

  test("fresh cutover: 4 inherited losses + 1 of the new model is a streak of 1, not a pause", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    broker.equity = 10_000;
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: { ...INITIAL_RISK_STATE, peakEquity: 10_500, dayStartEquity: 10_000, dayStartedAt: now - 3_600_000, consecutiveLosses: 4, lastEvalAt: now - 60_000 } };

    const engine = makeEngine(broker, persistence, "crypto-v2");
    await engine.tick(); // re-anchor; first tick of the process records nothing
    broker.realisedSince = -36.56;
    const report = await engine.tick();
    expect(report.tradeable).toBe(true);
    expect(engine.getRiskState().consecutiveLosses).toBe(1);
  });

  test("revision upgrade: the prod state's streak pause clears once (pause_resolved), the peak is kept", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    broker.equity = 5230.77;
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: stampedRev1() };

    const engine = makeEngine(broker, persistence, "crypto-v2", "test:streak-rev2");
    expect(engine.getRiskState().pendingStreakReanchor).toBe(true);
    expect(engine.getRiskState().modelReanchorRev).toBe(MODEL_REANCHOR_REV);
    expect((persistence.store!.risk as RiskState).modelReanchorRev).toBe(MODEL_REANCHOR_REV); // persisted at boot

    const { events, detach } = captureEvent(EVENTS.CIRCUIT_BREAKER);
    try {
      const report = await engine.tick();
      expect(report.tradeable).toBe(true);
      await engine.tick();
      expect(events.filter(e => e.action === "pause_resolved")).toHaveLength(1);
      expect(events[0].reason).toBe(STREAK_PAUSE);
    } finally { detach(); }
    const st = engine.getRiskState();
    expect(st.pausedUntil).toBe(0);
    expect(st.pendingStreakReanchor).toBe(false);
    expect(st.peakEquity).toBeGreaterThan(5400); // NOT re-anchored to 5230.77
  });

  test("revision upgrade: an inherited count restarts in the constructor; the first recorded period after it counts", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    broker.equity = 7782.95;
    const persistence = new MemoryPersistence();
    // momentum_crypto_usdc on prod: 2 losses inherited from the hourly model, no pause.
    persistence.store = { v: 1, risk: stampedRev1({ peakEquity: 7782.95, dayStartEquity: 7782.95, consecutiveLosses: 2, pausedUntil: 0, pauseReason: "" }) };

    const engine = makeEngine(broker, persistence, "crypto-v2");
    expect(engine.getRiskState().consecutiveLosses).toBe(0);
    expect(engine.getRiskState().pendingStreakReanchor ?? false).toBe(false); // nothing to clear
    await engine.tick();
    broker.realisedSince = -98.82;
    await engine.tick();
    expect(engine.getRiskState().consecutiveLosses).toBe(1);
  });

  test("a soft-drawdown or hard pause of the CURRENT model survives the upgrade", async () => {
    for (const pauseReason of ["soft drawdown 11.0% — paused 24h", "hard drawdown 21.0% — paused 168h, human review required"]) {
      const broker = new FakeBroker();
      broker.setCandles("X", ramp(100, 130));
      broker.equity = 4800;
      const persistence = new MemoryPersistence();
      persistence.store = { v: 1, risk: stampedRev1({ consecutiveLosses: 3, pauseReason }) };

      const engine = makeEngine(broker, persistence, "crypto-v2");
      const report = await engine.tick();
      expect(report.tradeable).toBe(false);
      expect(engine.getRiskState().pauseReason).toBe(pauseReason);
      expect(engine.getRiskState().consecutiveLosses).toBe(0); // the count itself was still inherited
    }
  });

  test("one-shot: a second boot over the upgraded state changes nothing", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    broker.equity = 5230.77;
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: stampedRev1() };
    const engine = makeEngine(broker, persistence, "crypto-v2");
    await engine.tick();
    broker.realisedSince = -10;
    await engine.tick();
    expect(engine.getRiskState().consecutiveLosses).toBe(1);

    const engine2 = makeEngine(broker, persistence, "crypto-v2");
    expect(engine2.getRiskState().consecutiveLosses).toBe(1); // a real streak is not reset again
    expect(engine2.getRiskState().pendingStreakReanchor ?? false).toBe(false);
  });

  test("no modelVersion configured: legacy states keep their streak and grow no keys", () => {
    const broker = new FakeBroker();
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: { ...INITIAL_RISK_STATE, peakEquity: 12_000, dayStartEquity: 10_000, dayStartedAt: now, consecutiveLosses: 4, lastEvalAt: now } };
    const engine = makeEngine(broker, persistence);
    const st = engine.getRiskState();
    expect(st.consecutiveLosses).toBe(4);
    expect("modelReanchorRev" in st).toBe(false);
    expect("pendingStreakReanchor" in st).toBe(false);
  });
});
