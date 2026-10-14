// ══════════════════════════════════════════════
// P0 (2026-10-09) — decision-pass funnel telemetry.
//
// The hard contract: the recorder is PURE telemetry. An engine makes the
// exact same broker calls with a recorder, without one, and with one that
// THROWS — locked here for both engines. Plus: the rows it writes carry the
// funnel counts the /api/funnel route aggregates, and retention prunes.
// ══════════════════════════════════════════════

import { beforeEach, describe, expect, test } from "bun:test";
import { MomentumEngine } from "../strategies/momentum/MomentumEngine";
import { MeanRevEngine, type MeanRevLogger } from "../strategies/meanrev/MeanRevEngine";
import { ramp, FakeBroker, silentLogger } from "../test-support/momentum";
import { daily, flatThen, FakeAdapter, MEANREV_ANCHOR } from "../test-support/meanrev";
import { makeTestDb } from "../test-support/db";
import { getDB, getDecisionPassSummary, insertDecisionPass } from "../db/database";
import { createDecisionRecorder, type DecisionRecorder, type DecisionPassSnapshot } from "./decisionRecorder";

const silentMr: MeanRevLogger = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => { makeTestDb(); });

function momentumFixture() {
  // One shared candle set so both engines decide on IDENTICAL data.
  const candles = {
    UP1: ramp(100, 130), UP2: ramp(100, 120), FLAT: ramp(100, 100), DOWN: ramp(100, 80),
  };
  const build = (recorder?: DecisionRecorder) => {
    const broker = new FakeBroker();
    for (const [sym, c] of Object.entries(candles)) broker.setCandles(sym, c.map((x) => ({ ...x })));
    const engine = new MomentumEngine({
      universe: ["UP1", "UP2", "FLAT", "DOWN"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
    }, broker, silentLogger);
    if (recorder) engine.setDecisionRecorder(recorder, "momentum_crypto");
    return { broker, engine };
  };
  return build;
}

describe("DecisionRecorder is pure telemetry — identical engine actions with/without it", () => {
  test("MomentumEngine: same opens/closes and same report with no recorder, a real recorder, and a THROWING recorder", async () => {
    const build = momentumFixture();

    const bare = build();
    const recorded = build(createDecisionRecorder());
    const throwing = build({ record: () => { throw new Error("recorder exploded"); } });

    const r1 = await bare.engine.tick();
    const r2 = await recorded.engine.tick();
    const r3 = await throwing.engine.tick();

    expect(recorded.broker.opened).toEqual(bare.broker.opened);
    expect(throwing.broker.opened).toEqual(bare.broker.opened);
    expect(recorded.broker.closed).toEqual(bare.broker.closed);
    expect(throwing.broker.closed).toEqual(bare.broker.closed);
    expect(r2.actions).toEqual(r1.actions);
    expect(r3.actions).toEqual(r1.actions);
    expect(r2.tradeable).toBe(r1.tradeable);
    expect(r3.tradeable).toBe(r1.tradeable);

    // …and the recorded pass carries the funnel counts.
    const rows = getDecisionPassSummary(0);
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s.accountId).toBe("momentum_crypto");
    expect(s.passes).toBe(1);
    expect(s.universe).toBe(4);
    expect(s.signalsLong).toBe(2);
    expect(s.entries).toBe(2);
    expect(s.exits).toBe(0);
    expect(s.slotsUsed).toBe(2);
    expect(s.slotsTotal).toBe(4); // DEFAULT_TSM_CONFIG maxLongs 4 + maxShorts 0
  });

  test("MomentumEngine: a risk-gate-blocked pass records blocks.risk_gate with the motive", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine({
      universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 },
    }, broker, silentLogger);
    engine.setDecisionRecorder(createDecisionRecorder(), "momentum_crypto");

    broker.equity = 10_000;
    await engine.tick();
    broker.equity = 7_500; // −25% → RiskGuard drawdown pause
    await engine.tick();

    const s = getDecisionPassSummary(0).find((x) => x.accountId === "momentum_crypto")!;
    expect(s.passes).toBe(2);
    expect(s.blocks.risk_gate).toBe(1);
    expect(s.lastBlockNote ?? "").toContain("drawdown");
  });

  test("MeanRevEngine: same opens/closes with no recorder, a real recorder, and a THROWING recorder", async () => {
    const mk = (recorder?: DecisionRecorder) => {
      const adapter = new FakeAdapter();
      adapter.setCandles("BUY", daily(flatThen(100, [150, 150, 148, 146])));
      adapter.setCandles("NO", daily(flatThen(100, [90, 88, 86])));
      const engine = new MeanRevEngine(
        { accountId: adapter.accountId, universe: ["BUY", "NO"], baseUsd: 50_000 },
        adapter, silentMr, { isTradingDay: () => true, now: () => MEANREV_ANCHOR },
      );
      if (recorder) engine.setDecisionRecorder(recorder);
      return { adapter, engine };
    };

    const bare = mk();
    const recorded = mk(createDecisionRecorder());
    const throwing = mk({ record: () => { throw new Error("recorder exploded"); } });

    const r1 = await bare.engine.runDaily();
    const r2 = await recorded.engine.runDaily();
    const r3 = await throwing.engine.runDaily();

    const shape = (a: FakeAdapter) => ({ opened: a.opened.map((o) => o.symbol), closed: a.closed.map((c) => c.symbol) });
    expect(shape(recorded.adapter)).toEqual(shape(bare.adapter));
    expect(shape(throwing.adapter)).toEqual(shape(bare.adapter));
    expect(r2.status).toBe(r1.status);
    expect(r3.status).toBe(r1.status);

    const s = getDecisionPassSummary(0).find((x) => x.accountId === recorded.adapter.accountId)!;
    expect(s.passes).toBe(1);
    expect(s.universe).toBe(2);
    expect(s.signalsLong).toBe(1);
    expect(s.entries).toBe(1);
    expect(s.exits).toBe(0);
    expect(s.slotsTotal).toBe(7); // DEFAULT_MEANREV_CONFIG maxPositions
    expect(s.slotsUsed).toBe(1);
  });
});

describe("decision_passes table mechanics", () => {
  const snap = (over: Partial<DecisionPassSnapshot> = {}): DecisionPassSnapshot => ({
    accountId: "momentum_crypto", ts: Date.now(), universe: 8, evaluated: 8,
    signalsLong: 1, signalsShort: 0, entries: 1, exits: 0, blocks: {}, ...over,
  });

  test("90-day retention prunes old rows on insert", () => {
    insertDecisionPass(snap({ ts: Date.now() - 95 * 86_400_000 }));
    insertDecisionPass(snap({ ts: Date.now() - 10 * 86_400_000 }));
    insertDecisionPass(snap({ ts: Date.now() }));
    const n = getDB().prepare(`SELECT COUNT(*) c FROM decision_passes`).get() as any;
    expect(n.c).toBe(2); // the 95-day-old row is gone
  });

  test("summary aggregates blocks by reason across passes", () => {
    insertDecisionPass(snap({ blocks: { risk_gate: 1, no_slot: 2 }, blockNote: "drawdown 7% > 5%" }));
    insertDecisionPass(snap({ blocks: { risk_gate: 1 } }));
    const s = getDecisionPassSummary(0).find((x) => x.accountId === "momentum_crypto")!;
    expect(s.blocks).toEqual({ risk_gate: 2, no_slot: 2 });
    expect(s.lastBlockNote).toBe("drawdown 7% > 5%");
    expect(s.passes).toBe(2);
    expect(s.entries).toBe(2);
  });
});
