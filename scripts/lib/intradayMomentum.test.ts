import { describe, expect, test } from "bun:test";
import {
  computeDayOutcome,
  netReturn,
  ordersForDay,
  type MinBar,
} from "./intradayMomentum";

// Normal RTH session: 09:30 (min 0 of ET day offset... we pass absolute ms,
// dayStartMs = midnight ET). One bar per minute, 09:30..15:59 (390 bars).
const DAY_START = Date.UTC(2024, 5, 10, 4, 0, 0); // arbitrary "midnight ET" anchor for the test
function mkBars(prices: Record<number, { o: number; c: number }>, lastMin = 959): MinBar[] {
  const bars: MinBar[] = [];
  for (let min = 570; min <= lastMin; min++) {
    const p = prices[min];
    const o = p?.o ?? 100;
    const c = p?.c ?? 100;
    bars.push({ timestamp: DAY_START + min * 60_000, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 1000 });
  }
  return bars;
}

describe("computeDayOutcome", () => {
  test("fhh signal: positive first-half-hour return -> long, profits when price rises into the close", () => {
    const bars = mkBars({
      599: { o: 101, c: 101 }, // ~10:00 mark close (prevClose=100 -> +1%)
      930: { o: 102, c: 102 }, // entry open at 15:30
      959: { o: 103, c: 103 }, // exit close at session end
    });
    const out = computeDayOutcome(bars, DAY_START, 960, 100, { name: "c1", signal: "fhh" });
    expect(out).not.toBeNull();
    expect(out!.direction).toBe(1);
    expect(out!.fhhReturn).toBeCloseTo(0.01, 6);
    expect(out!.entryPx).toBe(102);
    expect(out!.exitPx).toBe(103);
    expect(out!.grossReturn).toBeCloseTo(103 / 102 - 1, 10);
  });

  test("fhh signal: negative first-half-hour return -> short, profits when price falls into the close", () => {
    const bars = mkBars({
      599: { o: 99, c: 99 }, // -1%
      930: { o: 102, c: 102 },
      959: { o: 101, c: 101 },
    });
    const out = computeDayOutcome(bars, DAY_START, 960, 100, { name: "c1", signal: "fhh" });
    expect(out!.direction).toBe(-1);
    // short: profits from the price drop 102 -> 101
    expect(out!.grossReturn).toBeCloseTo(-1 * (101 / 102 - 1), 10);
    expect(out!.grossReturn).toBeGreaterThan(0);
  });

  test("fhh signal: zero return is flat (no trade)", () => {
    const bars = mkBars({ 599: { o: 100, c: 100 }, 930: { o: 102, c: 102 }, 959: { o: 103, c: 103 } });
    const out = computeDayOutcome(bars, DAY_START, 960, 100, { name: "c1", signal: "fhh" });
    expect(out!.direction).toBe(0);
    expect(out!.grossReturn).toBe(0);
  });

  test("penultimate signal uses the 15:00-15:30 return, independent of fhh", () => {
    const bars = mkBars({
      599: { o: 100, c: 100 }, // fhh flat
      899: { o: 100, c: 100 }, // 15:00 mark
      929: { o: 102, c: 102 }, // 15:30 mark: +2% over the penultimate half hour
      930: { o: 102, c: 102 },
      959: { o: 104, c: 104 },
    });
    const out = computeDayOutcome(bars, DAY_START, 960, 100, { name: "c2", signal: "penultimate" });
    expect(out!.penultimateReturn).toBeCloseTo(0.02, 6);
    expect(out!.direction).toBe(1);
  });

  test("agree signal requires fhh and penultimate to have the SAME sign, else flat", () => {
    const agreeBars = mkBars({
      599: { o: 101, c: 101 },   // fhh +1%
      899: { o: 100, c: 100 },
      929: { o: 101, c: 101 },   // penultimate +1% -> agrees
      930: { o: 102, c: 102 },
      959: { o: 103, c: 103 },
    });
    expect(computeDayOutcome(agreeBars, DAY_START, 960, 100, { name: "c3", signal: "agree" })!.direction).toBe(1);

    const disagreeBars = mkBars({
      599: { o: 101, c: 101 },   // fhh +1%
      899: { o: 100, c: 100 },
      929: { o: 99, c: 99 },     // penultimate -1% -> disagrees
      930: { o: 102, c: 102 },
      959: { o: 103, c: 103 },
    });
    expect(computeDayOutcome(disagreeBars, DAY_START, 960, 100, { name: "c3", signal: "agree" })!.direction).toBe(0);
  });

  test("fhhThreshold filters out weak signals below the declared bps threshold", () => {
    const weakBars = mkBars({ 599: { o: 100.02, c: 100.02 }, 930: { o: 102, c: 102 }, 959: { o: 103, c: 103 } }); // +2bps
    const out = computeDayOutcome(weakBars, DAY_START, 960, 100, { name: "c4", signal: "fhhThreshold", thresholdBps: 5 });
    expect(out!.direction).toBe(0);

    const strongBars = mkBars({ 599: { o: 100.10, c: 100.10 }, 930: { o: 102, c: 102 }, 959: { o: 103, c: 103 } }); // +10bps
    const out2 = computeDayOutcome(strongBars, DAY_START, 960, 100, { name: "c4", signal: "fhhThreshold", thresholdBps: 5 });
    expect(out2!.direction).toBe(1);
  });

  test("early-close session (<= 15:30 close) yields no decision: no last half hour exists", () => {
    const bars = mkBars({ 599: { o: 101, c: 101 } }, 779); // 13:00 close, session = [570,780)
    const out = computeDayOutcome(bars, DAY_START, 780, 100, { name: "c1", signal: "fhh" });
    expect(out).toBeNull();
  });

  test("missing marker bars (sparse data) fails closed to null, never a silent wrong signal", () => {
    const bars: MinBar[] = [{ timestamp: DAY_START + 930 * 60_000, open: 102, high: 102, low: 102, close: 102, volume: 1 }];
    const out = computeDayOutcome(bars, DAY_START, 960, 100, { name: "c1", signal: "fhh" });
    expect(out).toBeNull();
  });

  test("non-positive prevClose fails closed to null", () => {
    const bars = mkBars({ 599: { o: 101, c: 101 }, 930: { o: 102, c: 102 }, 959: { o: 103, c: 103 } });
    expect(computeDayOutcome(bars, DAY_START, 960, 0, { name: "c1", signal: "fhh" })).toBeNull();
  });
});

describe("netReturn / ordersForDay", () => {
  test("flat day costs nothing and generates no orders", () => {
    expect(netReturn(0, 0, 2)).toBe(0);
    expect(ordersForDay(0)).toBe(0);
  });

  test("a trade day pays the round-trip cost (2 sides) and generates 2 orders", () => {
    expect(netReturn(1, 0.01, 2)).toBeCloseTo(0.01 - 2 * 2 / 10_000, 10);
    expect(ordersForDay(1)).toBe(2);
    expect(ordersForDay(-1)).toBe(2);
  });

  test("extraBpsPerSide (break-even sweep) adds on top of the base cost, per side", () => {
    expect(netReturn(1, 0.01, 2, 10)).toBeCloseTo(0.01 - 2 * (2 + 10) / 10_000, 10);
  });
});
