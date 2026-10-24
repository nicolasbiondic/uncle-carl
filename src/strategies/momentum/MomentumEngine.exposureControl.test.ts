// Engine wiring of cfg.exposureControl (RW4a, 2026-10-23 — the portfolio-level
// exposure control that RESIZES open positions; RW-reescritura-rentable.md §13):
//   1. OFF by default: no report key, no scalePosition call, legacy envelope.
//   2. Drawdown axis: a held full-size position is scaled DOWN to λ, the kept
//      fraction is persisted, and a later recovery scales it back UP — never
//      above full size.
//   3. Hysteresis: a λ move inside the band, or an order below minOrderUsd,
//      issues nothing; the SAME λ twice issues nothing the second time.
//   4. Reductions run while entries are BLOCKED (risk pause); add-backs are
//      deferred then (and under the gross cap).
//   5. Entries are sized at λ and recorded at fraction λ.
//   6. Vol axis: a vol spike in the book cuts λ; the pure decision is the
//      single code path live and sim share (same inputs → same λ).
//   7. An adapter without scalePosition leaves the control inert (warn +
//      `unsupported`), never a close+reopen.
//   8. Persistence round-trip; poisoned fractions are dropped.
//   9. decision_passes exposure telemetry: exposure_intended includes the
//      resizes the control DECIDED this pass (a deliberate trim is not an
//      execution shortfall); a failed/unsupported resize shows as
//      real ≠ intended; a deferred add-back is not intended.
import { describe, expect, test } from "bun:test";
import {
  MomentumEngine, bookRealizedVol, exposureResizeFactor, exposureScale,
  type ExposureControlConfig, type MomentumEngineLogger,
} from "./MomentumEngine";
import { INITIAL_RISK_STATE } from "./RiskGuard";
import { ramp, rampTo, FakeBroker, silentLogger, MemoryPersistence } from "../../test-support/momentum";
import type { OHLCV } from "../../utils/types";
import { makeTestDb } from "../../test-support/db";
import { getDB } from "../../db/database";
import { createDecisionRecorder } from "../../telemetry/decisionRecorder";
import { TestClock } from "../../utils/clock";

/** FakeBroker that implements the optional scalePosition (quantity-relative). */
class ScalingFakeBroker extends FakeBroker {
  scaled: Array<{ symbol: string; side: "buy" | "sell"; factor: number; reason?: string }> = [];
  async scalePosition(a: { symbol: string; side: "buy" | "sell"; factor: number; reason?: string }) {
    this.scaled.push(a);
    const p = this.positions.find(x => x.symbol === a.symbol && x.side === a.side);
    if (!p) return { ok: false, reason: "no position" };
    p.quantity *= a.factor;
    p.notional *= a.factor;
    return { ok: true };
  }
}

function seeded(peak: number, dayStart: number, extra: Partial<{ exposureFracs: Record<string, number> }> = {}): MemoryPersistence {
  const p = new MemoryPersistence();
  p.store = {
    v: 1,
    risk: { ...INITIAL_RISK_STATE, peakEquity: peak, dayStartEquity: dayStart, dayStartedAt: Date.now(), lastEvalAt: Date.now() },
    ...extra,
  };
  return p;
}

const DD_ONLY: ExposureControlConfig = { drawdown: { startPct: 0.05, endPct: 0.25 }, minScale: 0.25, band: 0.10, minOrderUsd: 100 };

function engineWith(broker: FakeBroker, xc: ExposureControlConfig | undefined, persistence: MemoryPersistence, log: MomentumEngineLogger = silentLogger) {
  // Freeze the seed instant: DB setup before tick must not introduce a tiny
  // peak decay into exact exposure-telemetry assertions under load.
  return new MomentumEngine({
    universe: ["UP1"],
    notionalPctPerSlot: 0.30,
    scorer: { topLongs: 2, minLongScore: 0.01 },
    ...(xc ? { exposureControl: xc } : {}),
  }, broker, log, persistence, new TestClock(persistence.store!.risk.lastEvalAt));
}

describe("exposure control — pure decision", () => {
  test("bookRealizedVol: weighted sum of log returns, annualized; short series skipped; empty → null", () => {
    const flat = Array.from({ length: 50 }, () => 100);
    expect(bookRealizedVol([{ closes: flat, weight: 0.5 }], 20, 8760)).toBeNull(); // σ = 0 → degenerate
    const zig = Array.from({ length: 50 }, (_, i) => (i % 2 ? 103 : 100));
    const s1 = bookRealizedVol([{ closes: zig, weight: 1 }], 20, 8760)!;
    const s2 = bookRealizedVol([{ closes: zig, weight: 0.5 }], 20, 8760)!;
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeCloseTo(s1 / 2, 9); // weight scales σ linearly
    expect(bookRealizedVol([{ closes: zig.slice(0, 10), weight: 1 }], 20, 8760)).toBeNull(); // too short
    expect(bookRealizedVol([{ closes: zig.slice(0, 10), weight: 1 }, { closes: zig, weight: 1 }], 20, 8760)).toBeCloseTo(s1, 9); // short one skipped
    expect(bookRealizedVol([], 20, 8760)).toBeNull();
  });

  test("exposureScale: dd ramp, vol cap, floor, fail-open on missing axis data", () => {
    const cfg: ExposureControlConfig = { volCap: { annualizedPct: 50, fastBars: 10, slowBars: 20 }, drawdown: { startPct: 0.05, endPct: 0.25 }, minScale: 0.25, band: 0.1, minOrderUsd: 0 };
    // No book → vol axis fails open to 1; dd 12% → 1 − 0.07/0.20 = 0.65.
    const a = exposureScale({ cfg, book: [], barsPerYear: 8760, drawdown: 0.12 });
    expect(a.volScale).toBe(1);
    expect(a.ddScale).toBeCloseTo(0.65, 6);
    expect(a.scale).toBeCloseTo(0.65, 6);
    expect(a.sigmaFast).toBeUndefined();
    // Floor: dd 40% → raw −0.75 → floor 0.25.
    expect(exposureScale({ cfg, book: [], barsPerYear: 8760, drawdown: 0.40 }).scale).toBe(0.25);
    // dd below start → 1.
    expect(exposureScale({ cfg, book: [], barsPerYear: 8760, drawdown: 0.02 }).scale).toBe(1);
    // Vol: a ±3% zigzag per bar on 1h bars is ~ 280%/yr at weight 1 → λ_vol = 0.5/σ, floored.
    const zig = Array.from({ length: 40 }, (_, i) => (i % 2 ? 103 : 100));
    const b = exposureScale({ cfg, book: [{ closes: zig, weight: 1 }], barsPerYear: 8760, drawdown: 0 });
    expect(b.sigmaFast).toBeGreaterThan(1);
    expect(b.volScale).toBeLessThan(1);
    expect(b.scale).toBe(0.25);
    // Same inputs → same verdict (the live/sim parity contract of a pure function).
    expect(exposureScale({ cfg, book: [{ closes: zig, weight: 1 }], barsPerYear: 8760, drawdown: 0 })).toEqual(b);
    // Only the LAST slowBars+1 closes matter: prepending history changes nothing, appending bars does.
    const c = exposureScale({ cfg, book: [{ closes: [50, 60, 70, ...zig], weight: 1 }], barsPerYear: 8760, drawdown: 0 });
    expect(c.sigmaFast).toBeCloseTo(b.sigmaFast!, 12);
    expect(c.sigmaSlow).toBeCloseTo(b.sigmaSlow!, 12);
    const d = exposureScale({ cfg, book: [{ closes: [...zig, ...Array.from({ length: 11 }, (_, i) => (i % 2 ? 101 : 100))], weight: 1 }], barsPerYear: 8760, drawdown: 0 });
    expect(d.sigmaFast).toBeDefined();
    expect(Math.abs(d.sigmaFast! - b.sigmaFast!)).toBeGreaterThan(0.1);
  });

  test("exposureResizeFactor: band hysteresis and minimum order", () => {
    const h = { band: 0.10, minOrderUsd: 100 };
    expect(exposureResizeFactor(1, 0.95, 3000, h)).toBeNull();           // inside band
    expect(exposureResizeFactor(1, 0.85, 3000, h)).toBeCloseTo(0.85, 6); // −450 USD
    expect(exposureResizeFactor(1, 0.85, 500, h)).toBeNull();            // −75 USD < min order
    expect(exposureResizeFactor(0.5, 0.85, 3000, h)).toBeCloseTo(1.7, 12); // add-back
    expect(exposureResizeFactor(0.85, 0.85, 3000, h)).toBeNull();        // already there
    expect(exposureResizeFactor(0, 0.85, 3000, h)).toBeNull();           // defensive
  });
});

describe("MomentumEngine exposureControl", () => {
  test("HWM reference alone changes λ; absent and explicit decayedPeak decide byte-identically", async () => {
    const now = Date.parse("2024-01-31T12:00:00Z");
    const run = async (reference?: "decayedPeak" | "highWaterMark") => {
      const broker = new ScalingFakeBroker();
      broker.equity = 6_000;
      broker.setCandles("UP1", rampTo(now, 100, 130));
      broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
      const persistence = seeded(10_000, 6_000);
      persistence.store!.risk.lastEvalAt = now - 30 * 86_400_000;
      persistence.store!.risk.dayStartedAt = now;
      // Active pause: HWM tracking/reductions must still run; the pause is unchanged.
      persistence.store!.risk.pausedUntil = now + 86_400_000;
      persistence.store!.risk.pauseReason = "existing pause";
      const logs: string[] = [];
      const engine = new MomentumEngine({
        universe: ["UP1"], notionalPctPerSlot: 0.30,
        exposureControl: { ...DD_ONLY, drawdown: { startPct: 0.1, endPct: 0.4, ...(reference ? { reference } : {}) } },
      }, broker, { ...silentLogger, info: m => logs.push(m) }, persistence, new TestClock(now));
      const report = await engine.tick();
      return { report, scaled: broker.scaled, state: persistence.store, logs };
    };
    const absent = await run();
    const decayed = await run("decayedPeak");
    expect(JSON.stringify(decayed)).toBe(JSON.stringify(absent));
    expect(absent.report.exposureControl!.scale).toBeCloseTo(0.5, 12); // decayed peak 8000, dd 25%
    const hwm = await run("highWaterMark");
    expect(hwm.state!.risk.highWaterMark).toBe(10_000);
    expect(hwm.state!.risk.peakEquity).toBe(8_000);
    expect(hwm.report.exposureControl!.scale).toBe(0.25); // HWM dd 40%
    expect(hwm.scaled[0].factor).toBe(0.25);
    expect(hwm.report.blockedReason).toBe(absent.report.blockedReason);
    expect(hwm.logs.some(m => m.includes("λ=0.250") && m.includes("dd HWM") && m.includes("40.0%"))).toBe(true);
  });

  test("live config rejects an unknown drawdown reference", () => {
    expect(() => engineWith(new FakeBroker(), { ...DD_ONLY, drawdown: { ...DD_ONLY.drawdown!, reference: "unknown" as any } }, seeded(10_000, 10_000))).toThrow("drawdown.reference");
  });

  test("OFF by default: no report key, no resize, legacy envelope shape", async () => {
    const broker = new ScalingFakeBroker();
    broker.equity = 9_200;
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const persistence = seeded(10_000, 9_200);
    const engine = engineWith(broker, undefined, persistence);
    const report = await engine.tick();
    expect(report.exposureControl).toBeUndefined();
    expect(broker.scaled).toHaveLength(0);
    expect(persistence.store).not.toHaveProperty("exposureFracs");
  });

  test("drawdown axis: cuts a held full-size position to λ, holds it (hysteresis), then adds back on recovery — never above 1", async () => {
    const broker = new ScalingFakeBroker();
    broker.equity = 9_200; // dd 8% vs peak 10 000 → λ = 1 − 0.03/0.20 = 0.85
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const persistence = seeded(10_000, 9_200);
    const engine = engineWith(broker, DD_ONLY, persistence);

    const r1 = await engine.tick();
    expect(r1.tradeable).toBe(true); // 8% < soft-DD 10%: entries not paused
    expect(r1.exposureControl?.scale).toBeCloseTo(0.85, 6);
    expect(r1.exposureControl?.resizes).toBe(1);
    expect(r1.exposureControl?.resizeNotionalUsd).toBeCloseTo(450, 3);
    expect(broker.scaled).toHaveLength(1);
    expect(broker.scaled[0]).toMatchObject({ symbol: "UP1", side: "buy" });
    expect(broker.scaled[0].factor).toBeCloseTo(0.85, 6);
    expect(persistence.store?.exposureFracs).toEqual({ "UP1|buy": r1.exposureControl!.scale });

    // Same drawdown again → same λ → kept fraction already λ → nothing.
    const r2 = await engine.tick();
    expect(r2.exposureControl?.resizes).toBe(0);
    expect(broker.scaled).toHaveLength(1);

    // dd 7% → λ 0.90: |0.90 − 0.85| = 0.05 ≤ band 0.10 → still nothing.
    broker.equity = 9_300;
    const r3 = await engine.tick();
    expect(r3.exposureControl?.scale).toBeCloseTo(0.90, 6);
    expect(r3.exposureControl?.resizes).toBe(0);

    // Recovery: dd 4% → λ 1 → add back ×(1/0.85); fraction returns to 1.
    broker.equity = 9_600;
    const r4 = await engine.tick();
    expect(r4.exposureControl?.scale).toBe(1);
    expect(r4.exposureControl?.resizes).toBe(1);
    expect(broker.scaled).toHaveLength(2);
    expect(broker.scaled[1].factor).toBeCloseTo(1 / 0.85, 6);
    expect(broker.positions[0].notional).toBeCloseTo(3000, 6); // back to full size, not above
    expect(persistence.store?.exposureFracs).toEqual({ "UP1|buy": 1 });

    // New high (dd 0) → λ 1, fraction 1 → nothing.
    broker.equity = 10_500;
    const r5 = await engine.tick();
    expect(r5.exposureControl?.resizes).toBe(0);
    expect(broker.scaled).toHaveLength(2);
  });

  test("minOrderUsd: a tiny position is left alone even outside the band", async () => {
    const broker = new ScalingFakeBroker();
    broker.equity = 9_200; // λ 0.85
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 3, notional: 300 }); // 15% of 300 = 45 < 100
    const engine = engineWith(broker, DD_ONLY, seeded(10_000, 9_200));
    const r = await engine.tick();
    expect(r.exposureControl?.scale).toBeCloseTo(0.85, 6);
    expect(r.exposureControl?.resizes).toBe(0);
    expect(broker.scaled).toHaveLength(0);
  });

  test("reductions run while entries are BLOCKED by the risk pause; add-backs are deferred", async () => {
    // dd 12% ≥ soft-DD 10% → RiskGuard pauses entries; λ = 0.65.
    const brokerDown = new ScalingFakeBroker();
    brokerDown.equity = 8_800;
    brokerDown.setCandles("UP1", ramp(100, 130));
    brokerDown.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const down = engineWith(brokerDown, DD_ONLY, seeded(10_000, 8_800));
    const r = await down.tick();
    expect(r.tradeable).toBe(false);
    expect(r.exposureControl?.scale).toBeCloseTo(0.65, 6);
    expect(r.exposureControl?.resizes).toBe(1);
    expect(brokerDown.scaled[0].factor).toBeCloseTo(0.65, 6);

    // Same pause, but the position sits at fraction 0.5 (persisted): λ 0.65
    // would ADD — an entry in every sense — so it is deferred, not executed.
    const brokerUp = new ScalingFakeBroker();
    brokerUp.equity = 8_800;
    brokerUp.setCandles("UP1", ramp(100, 130));
    brokerUp.positions.push({ symbol: "UP1", side: "buy", quantity: 15, notional: 1500 });
    const up = engineWith(brokerUp, DD_ONLY, seeded(10_000, 8_800, { exposureFracs: { "UP1|buy": 0.5 } }));
    const r2 = await up.tick();
    expect(r2.tradeable).toBe(false);
    expect(r2.exposureControl?.resizes).toBe(0);
    expect(r2.exposureControl?.deferredUp).toBe(1);
    expect(brokerUp.scaled).toHaveLength(0);
  });

  test("add-back is deferred by the gross-exposure cap", async () => {
    const broker = new ScalingFakeBroker();
    broker.equity = 9_600; // λ 1
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 15, notional: 1500 });
    const engine = new MomentumEngine({
      universe: ["UP1"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
      exposureControl: DD_ONLY,
      maxGrossExposureMult: 0.20, // cap 1 920 USD: 1 500 + 1 500 would exceed it
    }, broker, silentLogger, seeded(10_000, 9_600, { exposureFracs: { "UP1|buy": 0.5 } }));
    const r = await engine.tick();
    expect(r.exposureControl?.scale).toBe(1);
    expect(r.exposureControl?.deferredUp).toBe(1);
    expect(broker.scaled).toHaveLength(0);
  });

  test("NEW entries are sized at λ and recorded at fraction λ", async () => {
    const broker = new ScalingFakeBroker();
    broker.equity = 9_200; // λ 0.85, no pause
    broker.setCandles("UP1", ramp(100, 130));
    const persistence = seeded(10_000, 9_200);
    const engine = engineWith(broker, DD_ONLY, persistence);
    const r = await engine.tick();
    expect(r.tradeable).toBe(true);
    expect(broker.opened).toHaveLength(1);
    expect(broker.opened[0].notionalUsd).toBeCloseTo(9_200 * 0.30 * 0.85, 3);
    expect(persistence.store?.exposureFracs).toEqual({ "UP1|buy": r.exposureControl!.scale });
    // The just-opened position is NOT resized in the same tick.
    expect(broker.scaled).toHaveLength(0);
    expect(r.exposureControl?.resizes).toBe(0);
  });

  test("vol axis: a spike in the held book's realized vol cuts λ; λ equals the pure function on the same inputs", async () => {
    // 35 days of 5m bars ramping 100 → 130, then the last 300 bars zigzag ±2%
    // around 130: the 14d return and the MA30 keep the long signal, the fast
    // window sees a vol explosion.
    const base = ramp(100, 130);
    const spiky: OHLCV[] = base.map((c, i) => {
      if (i < base.length - 300) return c;
      const p = 130 * (i % 2 ? 1.02 : 0.98);
      return { ...c, open: p, high: p, low: p, close: p };
    });
    const broker = new ScalingFakeBroker();
    broker.equity = 10_000; // dd 0 → the dd axis is 1; only vol acts
    broker.setCandles("UP1", spiky);
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const xc: ExposureControlConfig = { volCap: { annualizedPct: 50, fastBars: 120, slowBars: 504 }, minScale: 0.25, band: 0.10, minOrderUsd: 100 };
    const engine = engineWith(broker, xc, seeded(10_000, 10_000));
    const r = await engine.tick();
    expect(r.exposureControl).toBeDefined();
    expect(r.exposureControl!.volScale).toBeLessThan(1);
    expect(r.exposureControl!.ddScale).toBe(1);
    expect(r.exposureControl!.resizes).toBe(1);
    expect(broker.scaled[0].factor).toBeCloseTo(r.exposureControl!.scale, 12);
    // Parity: the engine's λ is exactly the pure decision over the SAME closes
    // and weight (held mark notional ÷ equity) — the one code path live and sim share.
    const pure = exposureScale({ cfg: xc, book: [{ closes: spiky.map(c => c.close), weight: 3000 / 10_000 }], barsPerYear: 288 * 365, drawdown: 0 });
    expect(r.exposureControl!.scale).toBeCloseTo(pure.scale, 12);
    expect(r.exposureControl!.sigmaFast).toBeCloseTo(pure.sigmaFast!, 12);
  });

  test("adapter without scalePosition: control is inert (warn + unsupported), no close/reopen", async () => {
    const broker = new FakeBroker(); // no scalePosition
    broker.equity = 9_200;
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const warns: string[] = [];
    const log: MomentumEngineLogger = { info: () => {}, warn: m => warns.push(m), error: () => {} };
    const engine = engineWith(broker, DD_ONLY, seeded(10_000, 9_200), log);
    const r = await engine.tick();
    expect(r.exposureControl?.scale).toBeCloseTo(0.85, 6);
    expect(r.exposureControl?.resizes).toBe(0);
    expect(r.exposureControl?.unsupported).toBe(1);
    expect(broker.closed).toHaveLength(0);
    expect(broker.opened).toHaveLength(0);
    expect(warns.some(w => w.includes("no scalePosition"))).toBe(true);
  });

  test("equity unavailable: the control is skipped for the tick (no key, no orders)", async () => {
    const broker = new ScalingFakeBroker();
    broker.getEquity = async () => { throw new Error("feed down"); };
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const engine = engineWith(broker, DD_ONLY, seeded(10_000, 9_200));
    const r = await engine.tick();
    expect(r.exposureControl).toBeUndefined();
    expect(broker.scaled).toHaveLength(0);
  });

  test("persistence: fractions survive a restart; poisoned values are dropped; closed positions are pruned", async () => {
    const persistence = seeded(10_000, 9_600, { exposureFracs: { "UP1|buy": 0.7, "GONE|buy": 0.5, "BAD|buy": 1.5, "ZERO|buy": 0 } });
    const broker = new ScalingFakeBroker();
    broker.equity = 9_600; // λ 1 → add-back ×(1/0.7)
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 21, notional: 2100 });
    const engine = engineWith(broker, DD_ONLY, persistence);
    const r = await engine.tick();
    expect(r.exposureControl?.resizes).toBe(1);
    expect(broker.scaled[0].factor).toBeCloseTo(1 / 0.7, 6);
    // Only the live position's fraction remains, at 1 — GONE pruned, BAD/ZERO never restored.
    expect(persistence.store?.exposureFracs).toEqual({ "UP1|buy": 1 });
  });
});

describe("exposure control ↔ decision_passes exposure telemetry (real vs intended)", () => {
  const lastPass = () => getDB().prepare(`SELECT exposure_real, exposure_intended FROM decision_passes ORDER BY id DESC LIMIT 1`).get() as any;
  const withRecorder = (engine: MomentumEngine) => { makeTestDb(); engine.setDecisionRecorder(createDecisionRecorder(), "momentum_crypto_usdc"); return engine; };

  test("a deliberate trim: intended follows the decided resize, so real == intended (no false shortfall)", async () => {
    const broker = new ScalingFakeBroker();
    broker.equity = 9_200; // λ 0.85
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const engine = withRecorder(engineWith(broker, DD_ONLY, seeded(10_000, 9_200)));
    const r = await engine.tick();
    expect(r.exposureControl?.resizes).toBe(1);
    const row = lastPass();
    expect(row.exposure_real).toBeCloseTo(2550 / 9_200, 9);     // liveGrossNotional after the executed resize
    expect(row.exposure_intended).toBeCloseTo(2550 / 9_200, 9); // kept 3000 − 450 decided
    expect(row.exposure_intended / row.exposure_real).toBeCloseTo(1, 9);
  });

  test("a decided trim the adapter FAILS to execute: real stays at the full book, intended is the trimmed one", async () => {
    const broker = new ScalingFakeBroker();
    broker.scalePosition = async () => ({ ok: false, reason: "venue rejection" });
    broker.equity = 9_200;
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const engine = withRecorder(engineWith(broker, DD_ONLY, seeded(10_000, 9_200)));
    const r = await engine.tick();
    expect(r.exposureControl?.resizes).toBe(0);
    const row = lastPass();
    expect(row.exposure_real).toBeCloseTo(3000 / 9_200, 9);
    expect(row.exposure_intended).toBeCloseTo(2550 / 9_200, 9);
    expect(row.exposure_real).not.toBeCloseTo(row.exposure_intended, 6);
  });

  test("adapter without scalePosition (control inert): the decided trim is still intended — real ≠ intended surfaces the inert control", async () => {
    const broker = new FakeBroker();
    broker.equity = 9_200;
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const engine = withRecorder(engineWith(broker, DD_ONLY, seeded(10_000, 9_200)));
    const r = await engine.tick();
    expect(r.exposureControl?.unsupported).toBe(1);
    const row = lastPass();
    expect(row.exposure_real).toBeCloseTo(3000 / 9_200, 9);
    expect(row.exposure_intended).toBeCloseTo(2550 / 9_200, 9);
  });

  test("a DEFERRED add-back (entries blocked) is not intended: real == intended at the kept book", async () => {
    const broker = new ScalingFakeBroker();
    broker.equity = 8_800; // dd 12% → paused, λ 0.65; fraction 0.5 → factor 1.3 would ADD → deferred
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 15, notional: 1500 });
    const engine = withRecorder(engineWith(broker, DD_ONLY, seeded(10_000, 8_800, { exposureFracs: { "UP1|buy": 0.5 } })));
    const r = await engine.tick();
    expect(r.tradeable).toBe(false);
    expect(r.exposureControl?.deferredUp).toBe(1);
    expect(r.exposureControl?.resizes).toBe(0);
    const row = lastPass();
    expect(row.exposure_real).toBeCloseTo(1500 / 8_800, 9);
    expect(row.exposure_intended).toBeCloseTo(1500 / 8_800, 9);
  });

  test("inside the band: nothing decided, real == intended", async () => {
    const broker = new ScalingFakeBroker();
    broker.equity = 9_300; // λ 0.90 vs fraction 1: |Δ| 0.10 ≤ band → nothing
    broker.setCandles("UP1", ramp(100, 130));
    broker.positions.push({ symbol: "UP1", side: "buy", quantity: 30, notional: 3000 });
    const engine = withRecorder(engineWith(broker, DD_ONLY, seeded(10_000, 9_300)));
    await engine.tick();
    const row = lastPass();
    expect(row.exposure_real).toBeCloseTo(3000 / 9_300, 9);
    expect(row.exposure_intended).toBeCloseTo(3000 / 9_300, 9);
  });
});
