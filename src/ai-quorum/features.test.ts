import { describe, expect, test } from "bun:test";
import { distanceToSMA, meanFunding, rsi, simpleReturn, volatility } from "./features";

describe("simpleReturn", () => {
  test("close-to-close over n days", () => {
    expect(simpleReturn([100, 110], 1)).toBeCloseTo(0.10, 10);
    expect(simpleReturn([100, 50, 75, 120], 3)).toBeCloseTo(0.20, 10);
  });
  test("null when history too short or divide-by-zero", () => {
    expect(simpleReturn([100], 1)).toBeNull();
    expect(simpleReturn([], 5)).toBeNull();
    expect(simpleReturn([0, 100], 1)).toBeNull();
  });
});

describe("volatility", () => {
  test("zero for a constant series", () => {
    expect(volatility(Array(25).fill(100), 20)).toBeCloseTo(0, 12);
  });
  test("known two-return case", () => {
    // closes 100,110,100 → log rets ln(1.1), ln(1/1.1): mean 0, sd = ln(1.1).
    expect(volatility([100, 110, 100], 2)).toBeCloseTo(Math.log(1.1), 10);
  });
  test("null when too short", () => {
    expect(volatility([100, 101], 20)).toBeNull();
  });
});

describe("rsi (Wilder 14)", () => {
  test("100 when every move is a gain", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(closes)).toBe(100);
  });
  test("≈0 when every move is a loss", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(closes)!).toBeCloseTo(0, 6);
  });
  test("50 for perfectly alternating equal moves", () => {
    const closes: number[] = [100];
    for (let i = 0; i < 28; i++) closes.push(closes[closes.length - 1] + (i % 2 === 0 ? 1 : -1));
    expect(rsi(closes)!).toBeGreaterThan(45);
    expect(rsi(closes)!).toBeLessThan(55);
  });
  test("null when too short", () => {
    expect(rsi([1, 2, 3])).toBeNull();
  });
});

describe("distanceToSMA", () => {
  test("close vs simple average", () => {
    // closes 90..110 step 10: SMA3 = 100, last = 110 → +10%.
    expect(distanceToSMA([90, 100, 110], 3)).toBeCloseTo(0.10 * (110 / 100 - 1) / (110 / 100 - 1), 10);
    expect(distanceToSMA([90, 100, 110], 3)).toBeCloseTo(110 / 100 - 1, 10);
  });
  test("null when fewer than n closes", () => {
    expect(distanceToSMA([100, 100], 50)).toBeNull();
  });
});

describe("meanFunding", () => {
  test("mean of the last 3 rates", () => {
    expect(meanFunding([0.0001, 0.0002, 0.0003, 0.0006])).toBeCloseTo((0.0002 + 0.0003 + 0.0006) / 3, 12);
  });
  test("null when no rates", () => {
    expect(meanFunding([])).toBeNull();
  });
});
