// Shadow-equity resume (risk.shadowResume) + one-shot model-cutover peak
// re-anchor (MomentumEngineConfig.modelVersion) — engine-level behavior:
//
//   1. LEGACY INTACT: without the opt-in, a soft-DD pause blocks entries and
//      the persisted RiskState never grows shadowResume/modelVersion keys.
//   2. BLOQUEO: with the opt-in, the breach tick still blocks entries (the
//      pause is real — only the RESUME rule changes).
//   3. REANUDACIÓN: while soft-paused, the virtual long book gaining
//      ≥ recoverPct lifts the pause the same tick.
//   4. RE-ANCLAJE: on resume the peak re-anchors to real equity, so the next
//      tick does NOT re-arm the soft pause off the old peak.
//   5. HARD INTACTO: a hard-drawdown pause is never lifted by the shadow
//      tracker (no tracker even exists during it).
//   6. MODEL CUTOVER: a persisted state from another model re-anchors the
//      peak ONCE and clears an inherited soft pause; hard pauses survive.
import { describe, expect, test } from "bun:test";
import { MomentumEngine } from "./MomentumEngine";
import { rebaseRiskState, INITIAL_RISK_STATE, RISK_STATE_VERSION, type RiskState } from "./RiskGuard";
import { ramp, FakeBroker, silentLogger, MemoryPersistence } from "../../test-support/momentum";
import { TestClock } from "../../utils/clock";

/** Engine over one symbol whose slot is 100% of equity, so virtual-book
 *  moves map 1:1 onto price moves (easy arithmetic in assertions). */
function makeEngine(broker: FakeBroker, opts: { shadowResume?: { recoverPct: number; costBpsPerSide?: number }; state?: MemoryPersistence; modelVersion?: string } = {}) {
  return new MomentumEngine(
    {
      universe: ["X"],
      notionalPctPerSlot: 1.0,
      risk: opts.shadowResume ? { shadowResume: opts.shadowResume } : {},
      ...(opts.modelVersion !== undefined ? { modelVersion: opts.modelVersion } : {}),
    },
    broker,
    silentLogger,
    opts.state,
  );
}

describe("shadow-equity resume", () => {
  test("legacy intact: without the opt-in the soft pause blocks and no new state keys appear", async () => {
    const broker = new FakeBroker();
    const persistence = new MemoryPersistence();
    broker.setCandles("X", ramp(100, 130));
    const engine = makeEngine(broker, { state: persistence });

    broker.equity = 10_000;
    await engine.tick(); // seeds peak
    broker.equity = 8_500; // dd 15% > 10% soft
    const blocked = await engine.tick();
    expect(blocked.tradeable).toBe(false);
    expect(blocked.blockedReason).toContain("soft drawdown");

    // Big virtual gain would exist — but the opt-in is off: still paused.
    broker.setCandles("X", ramp(110, 143));
    const still = await engine.tick();
    expect(still.tradeable).toBe(false);

    const persisted = persistence.store!.risk as RiskState;
    expect("shadowResume" in persisted).toBe(false);
    expect("modelVersion" in persisted).toBe(false);
    expect("pendingModelReanchor" in persisted).toBe(false);
  });

  test("bloqueo: the breach tick still blocks entries; the tracker anchors at real equity", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = makeEngine(broker, { shadowResume: { recoverPct: 0.03 } });

    broker.equity = 10_000;
    await engine.tick();
    broker.equity = 8_500;
    const blocked = await engine.tick();
    expect(blocked.tradeable).toBe(false);
    expect(blocked.blockedReason).toContain("soft drawdown");
    const st = engine.getRiskState();
    expect(st.shadowResume).toBeDefined();
    expect(st.shadowResume!.startEquity).toBe(8_500);
    expect(st.shadowResume!.peakRef).toBeCloseTo(10_000, 0);
    // entry cost charged: one virtual entry side at 9 bps on a 1.0 slot
    expect(st.shadowResume!.equity).toBeCloseTo(8_500 * (1 - 0.0009), 4);
  });

  test("reanudación + re-anclaje: virtual gain ≥ recoverPct lifts the pause and re-anchors the peak", async () => {
    // TestClock so the drawdown day and the recovery day are DIFFERENT UTC
    // days (the real lockout shape): otherwise the intact daily-loss cap —
    // masked by the soft pause on the breach tick — would re-arm on the
    // resume tick and the test would measure the wrong protection.
    const t0 = Date.UTC(2026, 0, 5, 1);
    const clock = new TestClock(t0);
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 1.0, risk: { shadowResume: { recoverPct: 0.03 } } },
      broker, silentLogger, undefined, clock,
    );

    broker.equity = 10_000;
    await engine.tick();
    clock.set(t0 + 3_600_000);
    broker.equity = 8_500;
    const blocked = await engine.tick(); // soft breach + tracker seed (holds X virtually at 130)
    expect(blocked.tradeable).toBe(false);
    expect(blocked.blockedReason).toContain("soft drawdown");

    // Next UTC day (24h pause expired, dd still >10% so the soft pause would
    // RE-ARM — the lockout loop): X closes +5% vs the 130 mark, so virtual
    // equity 8492.35 × 1.05 ≈ 8917 ≥ 8755 (=8500×1.03) — resume fires.
    clock.set(t0 + 26 * 3_600_000);
    broker.setCandles("X", ramp(105, 136.5));
    const resumed = await engine.tick();
    expect(resumed.tradeable).toBe(true);

    const st = engine.getRiskState();
    expect(st.pausedUntil).toBe(0);
    expect(st.pauseReason).toBe("");
    expect(st.peakEquity).toBe(8_500); // re-anchored to REAL equity, not the old 10k peak
    expect(st.shadowResume).toBeUndefined();

    // Next tick at the same real equity: dd from the new anchor is 0 — no re-arm.
    clock.set(t0 + 27 * 3_600_000);
    const after = await engine.tick();
    expect(after.tradeable).toBe(true);
  });

  test("hard intacto: a hard-drawdown pause is never tracked nor lifted", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = makeEngine(broker, { shadowResume: { recoverPct: 0.03 } });

    broker.equity = 10_000;
    await engine.tick();
    broker.equity = 7_500; // dd 25% ≥ 20% hard
    const blocked = await engine.tick();
    expect(blocked.tradeable).toBe(false);
    expect(blocked.blockedReason).toContain("hard drawdown");
    expect(engine.getRiskState().shadowResume).toBeUndefined();

    // Massive virtual gain changes nothing: hard pause holds.
    broker.setCandles("X", ramp(120, 156));
    const still = await engine.tick();
    expect(still.tradeable).toBe(false);
    expect(engine.getRiskState().pausedUntil).toBeGreaterThan(Date.now());
    expect(engine.getRiskState().shadowResume).toBeUndefined();
  });

  test("rebaseRiskState scales the shadow tracker's monetary anchors", () => {
    const prev: RiskState = {
      ...INITIAL_RISK_STATE,
      stateVersion: RISK_STATE_VERSION,
      equityBase: 5_000,
      peakEquity: 6_000,
      dayStartEquity: 5_500,
      shadowResume: { equity: 4_600, startEquity: 4_500, peakRef: 6_000 },
    };
    const next = rebaseRiskState(prev, 5_000, 10_000);
    expect(next.shadowResume).toEqual({ equity: 9_200, startEquity: 9_000, peakRef: 12_000 });
    // absence stays absent
    const { shadowResume: _dropped, ...noTracker } = prev;
    expect("shadowResume" in rebaseRiskState(noTracker, 5_000, 10_000)).toBe(false);
  });
});

describe("model-cutover one-shot peak re-anchor", () => {
  const now = Date.now();
  const pausedLegacyState = (pauseReason: string): RiskState => ({
    ...INITIAL_RISK_STATE,
    peakEquity: 12_000,
    dayStartEquity: 10_000,
    dayStartedAt: now - 3_600_000,
    pausedUntil: now + 10 * 3_600_000,
    pauseReason,
    lastEvalAt: now - 3_600_000,
  });

  test("inherited soft pause + old peak: first tick re-anchors and unblocks, exactly once", async () => {
    const broker = new FakeBroker();
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: pausedLegacyState("soft drawdown 13.5% — paused 24h") };
    broker.setCandles("X", ramp(100, 130));
    broker.equity = 10_000;

    const engine = makeEngine(broker, { state: persistence, modelVersion: "crypto-v2" });
    expect(engine.getRiskState().pendingModelReanchor).toBe(true);
    expect(engine.getRiskState().modelVersion).toBe("crypto-v2");

    const report = await engine.tick();
    expect(report.tradeable).toBe(true); // old model's peak/pause no longer decide
    const st = engine.getRiskState();
    expect(st.peakEquity).toBe(10_000);
    expect(st.pausedUntil).toBe(0);
    expect(st.pendingModelReanchor).toBe(false);

    // One-shot: a fresh engine over the STAMPED state arms nothing.
    const engine2 = makeEngine(broker, { state: persistence, modelVersion: "crypto-v2" });
    expect(engine2.getRiskState().pendingModelReanchor ?? false).toBe(false);
  });

  test("inherited HARD pause survives the cutover (only the peak re-anchors)", async () => {
    const broker = new FakeBroker();
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: pausedLegacyState("hard drawdown 21.0% — paused 168h, human review required") };
    broker.setCandles("X", ramp(100, 130));
    broker.equity = 10_000;

    const engine = makeEngine(broker, { state: persistence, modelVersion: "crypto-v2" });
    const report = await engine.tick();
    expect(report.tradeable).toBe(false);
    expect(report.blockedReason).toContain("hard drawdown");
    const st = engine.getRiskState();
    expect(st.peakEquity).toBe(10_000); // re-anchored
    expect(st.pausedUntil).toBeGreaterThan(now); // pause NOT cleared
  });

  test("no modelVersion configured = byte-identical legacy state handling", async () => {
    const broker = new FakeBroker();
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: pausedLegacyState("soft drawdown 13.5% — paused 24h") };
    broker.setCandles("X", ramp(100, 130));
    broker.equity = 10_000;

    const engine = makeEngine(broker, { state: persistence });
    const report = await engine.tick();
    expect(report.tradeable).toBe(false); // inherited pause still blocks
    expect("modelVersion" in engine.getRiskState()).toBe(false);
  });
});
