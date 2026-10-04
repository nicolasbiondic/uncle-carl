// Engine wiring of cfg.volSizing (inverse-volatility ENTRY sizing —
// Moskowitz/Ooi/Pedersen 2012; Barroso & Santa-Clara 2015):
//   1. NEW-entry notional = equity × pctPerSlot × clamp(σ_ref/σᵢ, min, max),
//      σ_ref = MEDIAN σ across universe symbols with sufficient history.
//   2. The clamp binds on both sides.
//   3. Fail-open: a symbol without a usable σ sizes at scale 1; when NO
//      symbol has one, sizing is exactly legacy.
//   4. Entries-only: a held position is never resized.
//   5. The gross-exposure cap still applies ON TOP of the scaled notional.
//   6. Composes multiplicatively with volTarget.
//   7. Legacy identity: without volSizing, notional is exactly equity × pct.
import { describe, expect, test } from "bun:test";
import { MomentumEngine, volSizingSigma, volTargetScale } from "./MomentumEngine";
import { FakeBroker, silentLogger } from "../../test-support/momentum";
import type { OHLCV } from "../../utils/types";

/** Daily bars from a closes array (timestamps 1d apart, ending "now"). */
function daily(closes: number[]): OHLCV[] {
  const end = Date.now();
  return closes.map((c, i) => ({
    open: c, high: c, low: c, close: c, volume: 1,
    timestamp: end - (closes.length - 1 - i) * 86_400_000,
  }));
}

/** Uptrending tape with controllable per-bar vol: alternating ±vol around a
 *  steady drift, long enough for TSM (lookback 5 / MA 5 daily) + σ window. */
function tape(vol: number, bars = 40, drift = 0.02): number[] {
  const closes = [100];
  for (let i = 1; i < bars; i++) {
    closes.push(closes[i - 1] * (1 + drift + (i % 2 === 0 ? vol : -vol)));
  }
  return closes;
}

const TSM = { barMinutes: 1440, lookbackDays: 5, maLengthDays: 5, entryThresholdPct: 5, exitThresholdPct: -2, maxLongs: 4, maxShorts: 0 };

function makeEngine(broker: FakeBroker, cfg: Record<string, unknown>) {
  return new MomentumEngine({
    universe: ["LOW", "MID", "HIGH"],
    notionalPctPerSlot: 0.25,
    tsm: TSM,
    regime: { enabled: false },
    ...cfg,
  } as any, broker, silentLogger);
}

const VS = { lookbackBars: 20, minScale: 0.5, maxScale: 2.0 };

function setTapes(broker: FakeBroker) {
  const tapes = { LOW: tape(0.004), MID: tape(0.012), HIGH: tape(0.03) };
  for (const [sym, closes] of Object.entries(tapes)) broker.setCandles(sym, daily(closes));
  return tapes;
}

describe("MomentumEngine volSizing (inverse-volatility entry sizing)", () => {
  test("entry notional = equity × pct × clamp(σ_ref/σᵢ) with σ_ref the universe median", async () => {
    const broker = new FakeBroker();
    const tapes = setTapes(broker);
    const engine = makeEngine(broker, { volSizing: VS });
    const report = await engine.tick();
    expect(report.tradeable).toBe(true);
    expect(broker.opened).toHaveLength(3);

    // Expected scales from the SAME closes/formula the engine used.
    const sigma = Object.fromEntries(Object.entries(tapes).map(([s, c]) => [s, volSizingSigma(c, VS.lookbackBars)!]));
    const sigmaRef = [sigma.LOW, sigma.MID, sigma.HIGH].sort((a, b) => a - b)[1]; // median of 3
    for (const o of broker.opened) {
      const expected = 10_000 * 0.25 * Math.min(2.0, Math.max(0.5, sigmaRef / sigma[o.symbol]));
      expect(o.notionalUsd).toBeCloseTo(expected, 6);
    }
    // Sanity on direction: the low-vol name gets MORE than the high-vol name.
    const bySym = Object.fromEntries(broker.opened.map(o => [o.symbol, o.notionalUsd]));
    expect(bySym.LOW).toBeGreaterThan(bySym.MID);
    expect(bySym.MID).toBeGreaterThan(bySym.HIGH);
  });

  test("the clamp binds on both sides", async () => {
    const broker = new FakeBroker();
    const tapes = setTapes(broker);
    const sigma = Object.fromEntries(Object.entries(tapes).map(([s, c]) => [s, volSizingSigma(c, VS.lookbackBars)!]));
    const sigmaRef = [sigma.LOW, sigma.MID, sigma.HIGH].sort((a, b) => a - b)[1];
    // The unclamped ratios must actually exceed a tight clamp for this test
    // to bite (tape() vols are ~7.5× apart, so they do).
    expect(sigmaRef / sigma.LOW).toBeGreaterThan(1.1);
    expect(sigmaRef / sigma.HIGH).toBeLessThan(0.9);
    const engine = makeEngine(broker, { volSizing: { ...VS, minScale: 0.9, maxScale: 1.1 } });
    await engine.tick();
    const bySym = Object.fromEntries(broker.opened.map(o => [o.symbol, o.notionalUsd]));
    expect(bySym.LOW).toBeCloseTo(10_000 * 0.25 * 1.1, 6);  // ceiling
    expect(bySym.HIGH).toBeCloseTo(10_000 * 0.25 * 0.9, 6); // floor
    expect(bySym.MID).toBeCloseTo(10_000 * 0.25, 6);        // ratio 1 (median itself)
  });

  test("fail-open: no symbol has lookbackBars of history → sizing is exactly legacy", async () => {
    const broker = new FakeBroker();
    setTapes(broker); // 40 daily closes each
    const engine = makeEngine(broker, { volSizing: { lookbackBars: 100, minScale: 0.5, maxScale: 2.0 } });
    await engine.tick();
    expect(broker.opened).toHaveLength(3);
    for (const o of broker.opened) expect(o.notionalUsd).toBe(10_000 * 0.25);
  });

  test("entries-only: a held position is never resized when the vol regime shifts", async () => {
    const broker = new FakeBroker();
    setTapes(broker);
    const engine = makeEngine(broker, { volSizing: VS });
    await engine.tick();
    const held = broker.positions.find(p => p.symbol === "LOW")!.notional;
    // LOW's tape turns violent — its σ rises, but the held slot must not move.
    broker.setCandles("LOW", daily(tape(0.05)));
    await engine.tick();
    expect(broker.positions.find(p => p.symbol === "LOW")!.notional).toBe(held);
  });

  test("the gross-exposure cap applies on top of the scaled notional", async () => {
    const broker = new FakeBroker();
    // LOW is the only strong trend (top-ranked, the single slot) AND the
    // lowest-vol name: its scale clamps to maxScale 2.0 → 0.60 × 2 = 120%
    // of equity, over the 1.0× cap. MID/HIGH drift too little to rank.
    broker.setCandles("LOW", daily(tape(0.004, 40, 0.03)));
    broker.setCandles("MID", daily(tape(0.012, 40, 0.005)));
    broker.setCandles("HIGH", daily(tape(0.03, 40, 0.005)));
    const engine = makeEngine(broker, {
      notionalPctPerSlot: 0.60,
      volSizing: VS,
      maxGrossExposureMult: 1.0,
      tsm: { ...TSM, maxLongs: 1 },
    });
    await engine.tick();
    expect(broker.opened).toEqual([]); // blocked by the cap, never reached the broker
  });

  test("composes multiplicatively with volTarget", async () => {
    const vt = { annualizedPct: 35, lookbackBars: 20, minScale: 0.33, maxScale: 1.5 };
    const broker = new FakeBroker();
    const tapes = setTapes(broker);
    const engine = makeEngine(broker, { volSizing: VS, volTarget: vt });
    await engine.tick();
    const sigma = Object.fromEntries(Object.entries(tapes).map(([s, c]) => [s, volSizingSigma(c, VS.lookbackBars)!]));
    const sigmaRef = [sigma.LOW, sigma.MID, sigma.HIGH].sort((a, b) => a - b)[1];
    for (const o of broker.opened) {
      const vtFactor = volTargetScale(tapes[o.symbol as keyof typeof tapes], vt, 1 * 365); // 1440m bars → 1 bar/day
      const vsFactor = Math.min(2.0, Math.max(0.5, sigmaRef / sigma[o.symbol]));
      expect(o.notionalUsd).toBeCloseTo(10_000 * 0.25 * vtFactor * vsFactor, 6);
    }
  });

  test("legacy identity: without volSizing the notional is exactly equity × pct", async () => {
    const broker = new FakeBroker();
    setTapes(broker);
    const engine = makeEngine(broker, {});
    await engine.tick();
    expect(broker.opened).toHaveLength(3);
    for (const o of broker.opened) expect(o.notionalUsd).toBe(10_000 * 0.25);
  });
});

describe("volSizingSigma", () => {
  test("hand-computed σ of log returns over the last lookbackBars closes", () => {
    // closes → log returns [ln1.1, ln0.9, ln1.2]; sample stdev over n-1.
    const closes = [100, 110, 99, 118.8];
    const rets = [Math.log(1.1), Math.log(0.9), Math.log(1.2)];
    const mean = rets.reduce((s, x) => s + x, 0) / 3;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / 2);
    expect(volSizingSigma(closes, 3)).toBeCloseTo(sd, 12);
  });

  test("null on insufficient history, degenerate series, or unusable closes", () => {
    expect(volSizingSigma([100, 101, 102], 3)).toBeNull();   // needs 4 closes
    expect(volSizingSigma([100, 100, 100, 100], 3)).toBeNull(); // σ = 0
    expect(volSizingSigma([100, 0, 100, 110], 3)).toBeNull();   // non-positive close
    expect(volSizingSigma([100, 110], 1)).toBeNull();           // lookback < 2
  });

  test("uses only the LAST lookbackBars returns", () => {
    const tail = [100, 110, 99, 118.8];
    const withHistory = [500, 250, 700, ...tail];
    expect(volSizingSigma(withHistory, 3)).toBeCloseTo(volSizingSigma(tail, 3)!, 12);
  });
});
