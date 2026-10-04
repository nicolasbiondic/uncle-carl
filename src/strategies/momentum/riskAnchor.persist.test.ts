// The realised-pnl anchor survives restarts (2026-10-03). It lived in memory
// only, so every restart's first tick skipped recordRebalanceOutcome and
// re-anchored at boot: the period since the last pre-restart tick never
// reached the loss streak (XRP −$6.27 closed 2026-10-02 18:00, deploy
// restart 18:20, momentum_crypto). The anchor now advances in the same step
// as the streak update and is written in the same envelope.
import { describe, expect, test } from "bun:test";
import { MomentumEngine, validRiskAnchor } from "./MomentumEngine";
import { INITIAL_RISK_STATE } from "./RiskGuard";
import { ramp, FakeBroker, silentLogger, MemoryPersistence } from "../../test-support/momentum";

function makeEngine(broker: FakeBroker, persistence: MemoryPersistence) {
  return new MomentumEngine({ universe: ["X"], notionalPctPerSlot: 1.0 }, broker, silentLogger, persistence);
}

function freshBroker(): FakeBroker {
  const broker = new FakeBroker();
  broker.setCandles("X", ramp(100, 130));
  broker.equity = 10_000;
  return broker;
}

describe("realised-pnl anchor persistence", () => {
  test("a restart records the period since the last pre-restart tick instead of dropping it", async () => {
    const broker = freshBroker();
    const persistence = new MemoryPersistence();
    const before = await makeEngine(broker, persistence);
    const t0 = Date.now();
    await before.tick(); // first tick of the process: anchors, records nothing
    const anchor = persistence.store?.riskAnchorAt;
    expect(anchor).toBeGreaterThanOrEqual(t0);
    expect(before.getRiskState().consecutiveLosses).toBe(0);

    broker.realisedSince = -6.27; // a losing close lands, then the process restarts
    const after = makeEngine(broker, persistence);
    await after.tick();
    expect(after.getRiskState().consecutiveLosses).toBe(1);
    expect(persistence.store!.riskAnchorAt!).toBeGreaterThanOrEqual(anchor!);
  });

  test("an envelope without riskAnchorAt (written before 2026-10-03) keeps the legacy first tick: nothing recorded", async () => {
    const broker = freshBroker();
    broker.realisedSince = -50;
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: { ...INITIAL_RISK_STATE } };
    const engine = makeEngine(broker, persistence);
    await engine.tick();
    expect(engine.getRiskState().consecutiveLosses).toBe(0);
    expect(persistence.store!.riskAnchorAt).toBeGreaterThan(0); // from now on it is persisted
  });

  test("validRiskAnchor rejects absent, non-finite, non-positive and future anchors", () => {
    const now = 1_790_000_000_000;
    expect(validRiskAnchor(now - 60_000, now)).toBe(now - 60_000);
    expect(validRiskAnchor(now, now)).toBe(now);
    for (const bad of [undefined, null, "123", NaN, Infinity, 0, -5, now + 1]) expect(validRiskAnchor(bad, now)).toBe(0);
  });
});
