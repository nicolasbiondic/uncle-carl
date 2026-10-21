import { describe, expect, test } from "bun:test";
import { lowVolScore, momentumReturn, overlaySignal, rankScores, sampleVol, trendSignal } from "./signals";

describe("trend blend and hysteresis", () => {
  const config = { blendHorizons: [2, 3], maLong: 2, signalBandPct: 1 };
  test("arithmetic mean of horizon returns, not return of mean price", () => {
    const s = trendSignal([80, 100, 105, 110], config);
    expect(s.blend).toBeCloseTo(((110 / 80 - 1) + (110 / 100 - 1)) / 2, 14);
    expect(s.sma).toBe(107.5);
    expect(s.on).toBe(true);
  });
  test("in-band and exact band boundaries retain the prior state", () => {
    const c = { blendHorizons: [2], maLong: 2, signalBandPct: 25 };
    for (const closes of [[100, 95, 100], [100, 100, 125], [100, 70, 75]]) {
      expect(trendSignal(closes, c, true).on).toBe(true);
      expect(trendSignal(closes, c, false).on).toBe(false);
    }
  });
  test("the preregistered decimal 1% boundary is not crossed by floating point noise", () => {
    const c = { blendHorizons: [2], maLong: 2, signalBandPct: 1 };
    expect(trendSignal([100, 100, 101], c, false).on).toBe(false);
    expect(trendSignal([100, 98, 99], c, true).on).toBe(true);
    expect(trendSignal([100, 100, 101.000001], c, false).on).toBe(true);
    expect(trendSignal([100, 98, 98.999999], c, true).on).toBe(false);
  });
  test("below negative band exits even above SMA; at/below SMA always exits", () => {
    expect(trendSignal([100, 80, 90], { ...config, blendHorizons: [2] }, true).on).toBe(false);
    for (const closes of [[80, 110, 110], [80, 120, 110]]) expect(trendSignal(closes, { ...config, blendHorizons: [2] }, true).on).toBe(false);
  });
  test("zero band still requires positive blend and above SMA; warmup is off", () => {
    const c = { ...config, signalBandPct: 0 };
    expect(trendSignal([80, 100, 105, 110], c).on).toBe(true);
    expect(trendSignal([100], c, true)).toEqual({ on: false, blend: null, sma: null });
  });
});

test("momentum [long,skip] ignores recent returns and needs long+1 closes", () => {
  expect(momentumReturn([10, 12, 15, 50, 1], [4, 2])).toBe(0.5);
  expect(momentumReturn([10, 12, 15, 50, 999], [4, 2])).toBe(0.5);
  expect(momentumReturn([1, 2, 3, 4], [4, 2])).toBeNull();
});

test("low-vol score is negative sample sigma of simple daily returns", () => {
  expect(sampleVol([0.1, -0.1])).toBeCloseTo(Math.sqrt(0.02));
  expect(lowVolScore([100, 110, 99], 2)).toBeCloseTo(-Math.sqrt(0.02));
  expect(lowVolScore([100, 110], 2)).toBeNull();
});

test("larger score has higher rank, ties share their average rank", () => {
  expect(rankScores({ D: 3, B: 1, A: 1, C: 2 })).toEqual({ A: 1.5, B: 1.5, C: 3, D: 4 });
});

describe("D2 overlay", () => {
  const config = { ref: "SPY", ma: 2, bandPct: 1, onExposure: 1, offExposure: 0.5 };
  test("outside the band changes exposure, inside retains state", () => {
    expect(overlaySignal([90, 110], config)).toEqual({ on: true, exposure: 1, sma: 100 });
    expect(overlaySignal([110, 90], config, true)).toEqual({ on: false, exposure: 0.5, sma: 100 });
    for (const last of [99, 100, 101]) {
      expect(overlaySignal([200 - last, last], config, true).exposure).toBe(1);
      expect(overlaySignal([200 - last, last], config, false).exposure).toBe(0.5);
    }
  });
  test("no overlay is always one; cold start is off until a positive crossing", () => {
    expect(overlaySignal([], null).exposure).toBe(1);
    expect(overlaySignal([], config).exposure).toBe(0.5);
    expect(overlaySignal([100, 100], config).on).toBe(false);
  });
});
