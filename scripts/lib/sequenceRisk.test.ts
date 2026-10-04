import { describe, expect, test } from "bun:test";
import {
  blockBootstrap,
  bootstrapEquityBand,
  computeSequenceRisk,
  maxDrawdownFromPnl,
  maxDrawdownFromReturns,
  MIN_BOOTSTRAP_OBS,
  MIN_RESHUFFLE_TRADES,
  mulberry32,
  quantileSorted,
  tradeReshuffle,
} from "./sequenceRisk";

describe("mulberry32", () => {
  test("deterministic for a fixed seed, uniform in [0, 1)", () => {
    const a = mulberry32(42), b = mulberry32(42);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    // Different seeds differ.
    const c = mulberry32(43);
    expect(Array.from({ length: 100 }, () => c())).not.toEqual(seqA);
  });
});

describe("quantileSorted", () => {
  test("interpolates linearly", () => {
    const xs = [0, 1, 2, 3, 4];
    expect(quantileSorted(xs, 0)).toBe(0);
    expect(quantileSorted(xs, 1)).toBe(4);
    expect(quantileSorted(xs, 0.5)).toBe(2);
    expect(quantileSorted(xs, 0.25)).toBe(1);
    expect(quantileSorted([1, 2], 0.5)).toBe(1.5);
    expect(Number.isNaN(quantileSorted([], 0.5))).toBe(true);
  });
});

describe("max drawdown helpers", () => {
  test("maxDrawdownFromReturns matches a hand-computed path", () => {
    // 1 → 1.1 → 0.88 → 0.968: peak 1.1, trough 0.88 → DD = 0.2
    const dd = maxDrawdownFromReturns([0.1, -0.2, 0.1]);
    expect(dd).toBeCloseTo(0.2, 12);
    expect(maxDrawdownFromReturns([0.01, 0.02, 0.03])).toBe(0);
  });

  test("maxDrawdownFromPnl is additive over initial equity and floors ruin at 1", () => {
    // 100 → 120 → 90: DD = 30/120 = 0.25
    expect(maxDrawdownFromPnl([20, -30], 100)).toBeCloseTo(0.25, 12);
    expect(maxDrawdownFromPnl([-100], 100)).toBe(1);
    expect(maxDrawdownFromPnl([-150], 100)).toBe(1);
  });
});

describe("blockBootstrap", () => {
  const flat = Array.from({ length: 100 }, () => 0.001);

  test("deterministic: same inputs and seed produce identical reports", () => {
    const rets = Array.from({ length: 200 }, (_, i) => (i % 7 === 0 ? -0.02 : 0.004));
    const a = blockBootstrap(rets, { paths: 500, seed: 7 });
    const b = blockBootstrap(rets, { paths: 500, seed: 7 });
    expect(a).toEqual(b);
    const c = blockBootstrap(rets, { paths: 500, seed: 8 });
    expect(c!.maxDrawdown).not.toEqual(a!.maxDrawdown);
  });

  test("constant positive returns → zero drawdown everywhere, observed percentile 1 (all paths ≤ observed 0)", () => {
    const r = blockBootstrap(flat, { paths: 200 })!;
    expect(r.maxDrawdown.p5).toBe(0);
    expect(r.maxDrawdown.p95).toBe(0);
    expect(r.observedMaxDrawdown).toBe(0);
    // Every simulated DD (0) ≤ observed (0) → empirical CDF = 1.
    expect(r.observedMaxDdPercentile).toBe(1);
    // Final return of every resample of a constant series equals the observed.
    expect(r.finalReturn.p5).toBeCloseTo(r.observedFinalReturn, 12);
    expect(r.finalReturn.p95).toBeCloseTo(r.observedFinalReturn, 12);
  });

  test("quantiles are ordered and the observed percentile is a probability", () => {
    const rand = mulberry32(1);
    const rets = Array.from({ length: 300 }, () => (rand() - 0.48) * 0.02);
    const r = blockBootstrap(rets, { paths: 500 })!;
    expect(r.maxDrawdown.p5).toBeLessThanOrEqual(r.maxDrawdown.p50);
    expect(r.maxDrawdown.p50).toBeLessThanOrEqual(r.maxDrawdown.p95);
    expect(r.finalReturn.p5).toBeLessThanOrEqual(r.finalReturn.p95);
    expect(r.observedMaxDdPercentile).toBeGreaterThanOrEqual(0);
    expect(r.observedMaxDdPercentile).toBeLessThanOrEqual(1);
    expect(r.observations).toBe(300);
  });

  test("undefined below the minimum observation count", () => {
    expect(blockBootstrap(flat.slice(0, MIN_BOOTSTRAP_OBS - 1))).toBeUndefined();
  });
});

describe("tradeReshuffle", () => {
  test("final return is permutation-invariant; DD distribution is deterministic", () => {
    const pnls = [50, -30, 20, -10, 40, -60, 25, 15, -5, 30, -20, 10];
    const a = tradeReshuffle(pnls, 1000, { paths: 500, seed: 3 })!;
    const b = tradeReshuffle(pnls, 1000, { paths: 500, seed: 3 })!;
    expect(a).toEqual(b);
    expect(a.finalReturn).toBeCloseTo(pnls.reduce((s, x) => s + x, 0) / 1000, 12);
    expect(a.trades).toBe(pnls.length);
    expect(a.maxDrawdown.p5).toBeLessThanOrEqual(a.maxDrawdown.p95);
  });

  test("a front-loaded loss sequence scores a high observed percentile", () => {
    // All the losses first: the realized ordering is close to the worst case.
    const losses = Array.from({ length: 10 }, () => -50);
    const gains = Array.from({ length: 10 }, () => 80);
    const badFirst = tradeReshuffle([...losses, ...gains], 1000, { paths: 1000 })!;
    const goodFirst = tradeReshuffle([...gains, ...losses], 1000, { paths: 1000 })!;
    expect(badFirst.observedMaxDrawdown).toBeGreaterThan(goodFirst.observedMaxDrawdown);
    expect(badFirst.observedMaxDdPercentile).toBeGreaterThan(0.9);
    expect(goodFirst.observedMaxDdPercentile).toBeLessThan(badFirst.observedMaxDdPercentile);
    // Same multiset of trades → statistically equivalent simulated
    // distribution (sampled paths differ because the shuffle starts from a
    // different arrangement, but the quantiles must agree closely).
    expect(Math.abs(badFirst.maxDrawdown.p50 - goodFirst.maxDrawdown.p50)).toBeLessThan(0.02);
    expect(Math.abs(badFirst.maxDrawdown.p95 - goodFirst.maxDrawdown.p95)).toBeLessThan(0.02);
  });

  test("undefined below the minimum trade count or on non-positive equity", () => {
    expect(tradeReshuffle(Array.from({ length: MIN_RESHUFFLE_TRADES - 1 }, () => 1), 1000)).toBeUndefined();
    expect(tradeReshuffle(Array.from({ length: 20 }, () => 1), 0)).toBeUndefined();
  });
});

describe("computeSequenceRisk", () => {
  test("combines both methods and exposes the worst observed percentile", () => {
    const rand = mulberry32(9);
    const rets = Array.from({ length: 250 }, () => (rand() - 0.45) * 0.02);
    const pnls = Array.from({ length: 40 }, () => (rand() - 0.4) * 100);
    const sr = computeSequenceRisk(rets, pnls, 10_000, { paths: 300 });
    expect(sr.bootstrap).toBeDefined();
    expect(sr.tradeReshuffle).toBeDefined();
    expect(sr.observedMaxDdPercentile).toBe(
      Math.max(sr.bootstrap!.observedMaxDdPercentile, sr.tradeReshuffle!.observedMaxDdPercentile),
    );
  });

  test("degenerate evidence yields absent blocks and no percentile", () => {
    const sr = computeSequenceRisk([0.01, 0.02], [1, 2], 10_000);
    expect(sr.bootstrap).toBeUndefined();
    expect(sr.tradeReshuffle).toBeUndefined();
    expect(sr.observedMaxDdPercentile).toBeUndefined();
  });
});

describe("bootstrapEquityBand", () => {
  test("deterministic, one ordered triple per day", () => {
    const rand = mulberry32(5);
    const rets = Array.from({ length: 120 }, () => (rand() - 0.48) * 0.015);
    const a = bootstrapEquityBand(rets, { paths: 200 })!;
    const b = bootstrapEquityBand(rets, { paths: 200 })!;
    expect(a).toEqual(b);
    expect(a.length).toBe(120);
    for (const q of a) {
      expect(q.p5).toBeLessThanOrEqual(q.p50);
      expect(q.p50).toBeLessThanOrEqual(q.p95);
    }
    expect(bootstrapEquityBand(rets.slice(0, 10))).toBeUndefined();
  });
});
