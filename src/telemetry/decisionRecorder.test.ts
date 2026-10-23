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

// ── 2026-10-23: gate binding + exposure ─────────────────────────────────────
// D1 of docs/reports/fallos-2026-10-23/rentabilidad.md: `blocks.regime` counted
// the brake on every pass where it was ACTIVE and `signals_long` was recorded
// after the Sharpe gate, so "active" read as "binding". These pin the new
// fields, and that computing them changes nothing the engine does.
describe("gate binding + exposure telemetry (2026-10-23)", () => {
  const IDS = ["A", "B", "C", "D", "E"];
  /** Daily 25 × −2% then 10 × +3.5%: a long signal with a negative rolling Sharpe. */
  const vShape = () => {
    const rets = [...Array(25).fill(-0.02), ...Array(10).fill(0.035)];
    const out: any[] = [];
    let px = 100;
    const baseTs = Date.now() - (rets.length + 1) * 86_400_000;
    out.push({ open: px, high: px, low: px, close: px, volume: 1, timestamp: baseTs });
    rets.forEach((r, i) => {
      px *= 1 + r;
      out.push({ open: px, high: px, low: px, close: px, volume: 1, timestamp: baseTs + (i + 1) * 86_400_000 });
    });
    return out;
  };

  interface Scenario {
    name: string;
    cfg: any;
    candles: Record<string, any[]>;
    /** broker tweaks before the tick(s) */
    setup?: (b: FakeBroker) => void;
  }
  const brake = { correlationCeiling: 0.85, minSymbolsForCorrelation: 4 };
  const scenarios: Scenario[] = [
    { // brake ACTIVE, nothing to buy: the D1 pass that looked like a block
      name: "brake on, no candidates",
      cfg: { universe: IDS, notionalPctPerSlot: 0.30, scorer: { topLongs: 2, minLongScore: 0.001 }, regime: brake },
      candles: Object.fromEntries(IDS.map((s) => [s, ramp(100, 90)])),
    },
    { // brake ACTIVE with real candidates: the brake binds
      name: "brake on, candidates",
      cfg: { universe: IDS, notionalPctPerSlot: 0.30, scorer: { topLongs: 2, minLongScore: 0.001 }, regime: brake },
      candles: Object.fromEntries(IDS.map((s) => [s, ramp(100, 130)])),
    },
    { // Sharpe gate removes the only long
      name: "sharpe gate binds",
      cfg: { universe: ["X"], notionalPctPerSlot: 0.30, tsm: { barMinutes: 1440 }, sharpeGate: { lookbackDays: 30, minSharpe: 0 } },
      candles: { X: vShape() },
    },
    { // slot limit: 3 fresh longs, 2 slots
      name: "slot limit binds",
      cfg: { universe: ["U1", "U2", "U3"], notionalPctPerSlot: 0.30, tsm: { maxLongs: 2 } },
      candles: { U1: ramp(100, 140), U2: ramp(100, 130), U3: ramp(100, 120) },
    },
    { // healthy: everything the ranker wanted gets bought
      name: "no gate binds",
      cfg: { universe: ["U1", "U2"], notionalPctPerSlot: 0.30, scorer: { topLongs: 2, minLongScore: 0.01 } },
      candles: { U1: ramp(100, 130), U2: ramp(100, 120) },
    },
    { // gross cap vetoes the second entry
      name: "gross cap binds",
      cfg: { universe: ["U1", "U2"], notionalPctPerSlot: 0.30, maxGrossExposureMult: 0.4 },
      candles: { U1: ramp(100, 130), U2: ramp(100, 120) },
    },
  ];

  const run = async (s: Scenario, recorder?: DecisionRecorder) => {
    const broker = new FakeBroker();
    for (const [sym, c] of Object.entries(s.candles)) broker.setCandles(sym, c.map((x) => ({ ...x })));
    s.setup?.(broker);
    const engine = new MomentumEngine(s.cfg, broker, silentLogger);
    if (recorder) engine.setDecisionRecorder(recorder, "momentum_crypto");
    const report = await engine.tick();
    return { broker, report };
  };
  const last = () => getDecisionPassSummary(0).find((x) => x.accountId === "momentum_crypto")!;
  const rowOf = () => getDB().prepare(`SELECT * FROM decision_passes ORDER BY id DESC LIMIT 1`).get() as any;

  test("same decisions and orders with the new recording, without a recorder, and with a throwing one", async () => {
    for (const s of scenarios) {
      const bare = await run(s);
      const recorded = await run(s, createDecisionRecorder());
      const throwing = await run(s, { record: () => { throw new Error("recorder exploded"); } });
      for (const other of [recorded, throwing]) {
        expect(other.broker.opened).toEqual(bare.broker.opened);
        expect(other.broker.closed).toEqual(bare.broker.closed);
        expect(other.report.actions).toEqual(bare.report.actions);
        expect(other.report.decisions).toEqual(bare.report.decisions);
        expect(other.report.unchanged).toEqual(bare.report.unchanged);
        expect(other.report.tradeable).toBe(bare.report.tradeable);
        expect(other.report.blockedReason).toBe(bare.report.blockedReason);
      }
    }
  });

  test("D1: the brake active with nothing to buy is NOT binding; with a candidate it is", async () => {
    await run(scenarios[0], createDecisionRecorder());
    let r = rowOf();
    expect(JSON.parse(r.blocks).regime).toBe(1);        // legacy field keeps its meaning: brake was active
    expect(r.signals_raw_long).toBe(0);
    expect(r.signals_after_gates).toBe(0);
    expect(JSON.parse(r.gate_binding)).toEqual([]);     // …but it removed nothing

    const { broker } = await run(scenarios[1], createDecisionRecorder());
    r = rowOf();
    expect(broker.opened).toHaveLength(0);
    expect(JSON.parse(r.blocks).regime).toBe(1);
    expect(r.signals_raw_long).toBeGreaterThan(0);
    expect(r.signals_after_gates).toBe(0);
    // 5 candidates vs 4 default slots: the slot limit also removed one (sorted keys).
    expect(JSON.parse(r.gate_binding)).toEqual(["no_slot", "regime"]);
    expect(r.signals_raw_long).toBe(5);                 // 4 ranked longs + the one refused a slot
    expect(r.signals_long).toBe(4);                     // legacy field: unchanged meaning
  });

  test("Sharpe gate: legacy signals_long is post-gate (0), signals_raw_long is the ranker's 1", async () => {
    await run(scenarios[2], createDecisionRecorder());
    const r = rowOf();
    expect(r.signals_long).toBe(0);
    expect(r.signals_raw_long).toBe(1);
    expect(r.signals_after_gates).toBe(0);
    expect(JSON.parse(r.gate_binding)).toEqual(["sharpe_gate"]);
  });

  test("slot limit: the ranker's refused entry counts as raw long and binds no_slot", async () => {
    const { broker } = await run(scenarios[3], createDecisionRecorder());
    const r = rowOf();
    expect(broker.opened).toHaveLength(2);
    expect(r.signals_long).toBe(2);
    expect(r.signals_raw_long).toBe(3);
    expect(r.signals_after_gates).toBe(2);
    expect(JSON.parse(r.gate_binding)).toEqual(["no_slot"]);
  });

  test("no gate binds → empty gate_binding; real == intended exposure", async () => {
    await run(scenarios[4], createDecisionRecorder());
    const r = rowOf();
    expect(r.signals_raw_long).toBe(2);
    expect(r.signals_after_gates).toBe(2);
    expect(JSON.parse(r.gate_binding)).toEqual([]);
    expect(r.exposure_real).toBeCloseTo(0.6, 9);       // 2 × 30% of 10k equity
    expect(r.exposure_intended).toBeCloseTo(0.6, 9);
  });

  test("gross cap veto is recorded as binding and removes the entry from the intended book", async () => {
    const { broker } = await run(scenarios[5], createDecisionRecorder());
    const r = rowOf();
    expect(broker.opened).toHaveLength(1);
    expect(JSON.parse(r.gate_binding)).toEqual(["gross_cap"]);
    expect(r.signals_raw_long).toBe(2);
    expect(r.signals_after_gates).toBe(1);
    expect(r.exposure_real).toBeCloseTo(0.3, 9);
    expect(r.exposure_intended).toBeCloseTo(0.3, 9);
  });

  test("held book: kept positions count in both exposures; a planned close leaves the intended book", async () => {
    const broker = new FakeBroker();
    broker.setCandles("KEEP", ramp(100, 130));
    broker.setCandles("DROP", ramp(100, 80));
    broker.positions = [
      { symbol: "KEEP", side: "buy", quantity: 1, notional: 2_000 },
      { symbol: "DROP", side: "buy", quantity: 1, notional: 1_000 },
    ];
    const engine = new MomentumEngine({ universe: ["KEEP", "DROP"], notionalPctPerSlot: 0.30 }, broker, silentLogger);
    engine.setDecisionRecorder(createDecisionRecorder(), "momentum_crypto");
    await engine.tick();
    const r = rowOf();
    expect(broker.closed.map((c) => c.symbol)).toEqual(["DROP"]);
    expect(r.exposure_real).toBeCloseTo(0.2, 9);        // DROP closed OK
    expect(r.exposure_intended).toBeCloseTo(0.2, 9);
    expect(r.signals_after_gates).toBe(1);               // KEEP's stay signal
  });

  test("failed opens: intended stays, real does not — five passes flag the sleeve low", async () => {
    const broker = new FakeBroker();
    broker.setCandles("U1", ramp(100, 130));
    broker.openPosition = async (a: any) => { broker.opened.push(a); return { ok: false, reason: "venue down" }; };
    const engine = new MomentumEngine({ universe: ["U1"], notionalPctPerSlot: 0.30 }, broker, silentLogger);
    engine.setDecisionRecorder(createDecisionRecorder(), "momentum_crypto");
    for (let i = 0; i < 5; i++) await engine.tick();
    const e = last().exposure!;
    expect(e.latest.real).toBe(0);
    expect(e.latest.intended).toBeCloseTo(0.3, 9);
    expect(e.latest.ratio).toBe(0);
    expect(e.mean5.passes).toBe(5);
    expect(e.low).toBe(true);
    expect(JSON.parse(rowOf().gate_binding)).toEqual([]); // not a gate: an execution failure
  });

  test("invalid equity: exposure stays NULL, the pass is still recorded", async () => {
    const broker = new FakeBroker();
    broker.setCandles("U1", ramp(100, 130));
    broker.getEquity = async () => { throw new Error("feed down"); };
    const engine = new MomentumEngine({ universe: ["U1"], notionalPctPerSlot: 0.30 }, broker, silentLogger);
    engine.setDecisionRecorder(createDecisionRecorder(), "momentum_crypto");
    await engine.tick();
    const r = rowOf();
    expect(r.exposure_real).toBeNull();
    expect(r.exposure_intended).toBeNull();
    expect(r.signals_raw_long).toBe(1);
  });

  test("MeanRevEngine leaves the new fields NULL (candidates are not even computed behind its gates)", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("BUY", daily(flatThen(100, [150, 150, 148, 146])));
    const engine = new MeanRevEngine(
      { accountId: adapter.accountId, universe: ["BUY"], baseUsd: 50_000 },
      adapter, silentMr, { isTradingDay: () => true, now: () => MEANREV_ANCHOR },
    );
    engine.setDecisionRecorder(createDecisionRecorder());
    await engine.runDaily();
    const r = rowOf();
    for (const k of ["signals_raw_long", "signals_after_gates", "gate_binding", "exposure_real", "exposure_intended"]) {
      expect(r[k]).toBeNull();
    }
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
