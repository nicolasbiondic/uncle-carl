import { describe, expect, test } from "bun:test";
import { RegimeFilter } from "./RegimeFilter";
import type { OHLCV } from "../../utils/types";

/**
 * Build candle history with controllable noise.
 *  - days: total length
 *  - dailyVol: stddev of daily log-return for the BASELINE part
 *  - shockMultiplier: in the LAST 24h, multiply noise by this (simulates a vol spike)
 *  - drift: linear drift per day
 *  - seed: deterministic randomness
 */
function buildNoisy(opts: {
  days: number;
  dailyVol: number;
  shockMultiplier?: number;
  drift?: number;
  seed?: number;
  start?: number;
}): OHLCV[] {
  const barMinutes = 5;
  const barsPerDay = Math.floor(24 * 60 / barMinutes);
  const totalBars = barsPerDay * opts.days;
  const start = opts.start ?? 100;
  let seed = opts.seed ?? 42;
  // Simple LCG for deterministic noise
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 2 ** 32; return (seed / 2 ** 32) * 2 - 1; };

  // Convert daily vol to per-bar vol: σ_bar = σ_day / sqrt(bars_per_day)
  const baselinePerBar = opts.dailyVol / Math.sqrt(barsPerDay);
  const driftPerBar = (opts.drift ?? 0) / barsPerDay;

  const out: OHLCV[] = [];
  let price = start;
  const baseTs = Date.now() - totalBars * barMinutes * 60_000;
  const shockStart = totalBars - barsPerDay;
  for (let i = 0; i < totalBars; i++) {
    const noise = baselinePerBar * (i >= shockStart ? (opts.shockMultiplier ?? 1) : 1) * rand();
    price *= Math.exp(noise + driftPerBar);
    out.push({ open: price, high: price, low: price, close: price, volume: 1, timestamp: baseTs + i * barMinutes * 60_000 });
  }
  return out;
}

describe("RegimeFilter", () => {
  test("returns tradeable=true when volatility is within baseline", () => {
    const m = new Map<string, OHLCV[]>();
    for (let i = 0; i < 5; i++) {
      m.set(`SYM${i}`, buildNoisy({ days: 35, dailyVol: 0.03, seed: 100 + i }));
    }
    const r = new RegimeFilter().assess(m);
    expect(r.tradeable).toBe(true);
    expect(r.details.volRatio).toBeLessThan(2.5);
  });

  test("flags non-tradeable when last 24h volatility is 3x+ baseline", () => {
    const m = new Map<string, OHLCV[]>();
    for (let i = 0; i < 5; i++) {
      m.set(`SYM${i}`, buildNoisy({ days: 35, dailyVol: 0.03, shockMultiplier: 4, seed: 200 + i }));
    }
    const r = new RegimeFilter().assess(m);
    expect(r.tradeable).toBe(false);
    expect(r.reason).toContain("volatility spike");
  });

  test("symbols without enough history are silently dropped", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("OK",      buildNoisy({ days: 35, dailyVol: 0.02, seed: 11 }));
    m.set("TOO_NEW", buildNoisy({ days: 5,  dailyVol: 0.02, seed: 12 }));
    const r = new RegimeFilter().assess(m);
    expect(r.details.universeSize).toBe(1); // only OK survives
    expect(r.tradeable).toBe(true);
  });

  test("flags correlation collapse when all symbols move together", () => {
    // Build the SAME series 6 times — perfect correlation 1.0
    const base = buildNoisy({ days: 35, dailyVol: 0.03, seed: 7 });
    const m = new Map<string, OHLCV[]>();
    for (let i = 0; i < 6; i++) {
      m.set(`COPY${i}`, base.map(c => ({ ...c })));
    }
    const r = new RegimeFilter().assess(m);
    expect(r.tradeable).toBe(false);
    expect(r.reason).toContain("correlation collapse");
    expect(r.details.avgCorrelation).toBeGreaterThan(0.85);
  });

  test("does not flag correlation when universe is too small", () => {
    const m = new Map<string, OHLCV[]>();
    const base = buildNoisy({ days: 35, dailyVol: 0.03, seed: 99 });
    m.set("A", base);
    m.set("B", base.map(c => ({ ...c }))); // perfect correlation but only 2 symbols
    const r = new RegimeFilter({ minSymbolsForCorrelation: 4 }).assess(m);
    expect(r.tradeable).toBe(true);
  });

  test("enabled=false short-circuits: tradeable=true on a tape the enabled filter rejects", () => {
    const m = new Map<string, OHLCV[]>();
    for (let i = 0; i < 5; i++) {
      m.set(`SYM${i}`, buildNoisy({ days: 35, dailyVol: 0.03, shockMultiplier: 4, seed: 200 + i }));
    }
    expect(new RegimeFilter().assess(m).tradeable).toBe(false); // same tape as the vol-spike test
    const off = new RegimeFilter({ enabled: false }).assess(m);
    expect(off.tradeable).toBe(true);
    expect(off.reason).toContain("disabled");
    // Default (enabled undefined) stays the legacy evaluating path.
    expect(new RegimeFilter({}).assess(m).reason).toContain("volatility spike");
  });

  test("respects custom volatility threshold", () => {
    const m = new Map<string, OHLCV[]>();
    for (let i = 0; i < 5; i++) {
      m.set(`SYM${i}`, buildNoisy({ days: 35, dailyVol: 0.03, shockMultiplier: 1.8, seed: 300 + i }));
    }
    // Default 2.5x → should be tradeable. Strict 1.5x → should not.
    expect(new RegimeFilter({ volSpikeMultiplier: 2.5 }).assess(m).tradeable).toBe(true);
    expect(new RegimeFilter({ volSpikeMultiplier: 1.5 }).assess(m).tradeable).toBe(false);
  });
});
