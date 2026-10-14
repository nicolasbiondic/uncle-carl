import { describe, expect, test } from "bun:test";
import { computeQuorum } from "./quorum";
import type { ModelViews } from "./types";

const v = (view: "long" | "short" | "neutral", confidence: number) => ({ view, confidence });

describe("computeQuorum — pre-registered §12-D rule", () => {
  test("2 of 3 agree long with mean confidence ≥ 0.6 → long position", () => {
    const models: ModelViews[] = [
      { BTC: v("long", 0.7) },
      { BTC: v("long", 0.6) },
      { BTC: v("short", 0.9) },
    ];
    const q = computeQuorum(models, ["BTC"]);
    expect(q.length).toBe(1);
    expect(q[0].symbol).toBe("BTC");
    expect(q[0].direction).toBe(1);
    expect(q[0].meanConfidence).toBeCloseTo(0.65, 10);
  });

  test("2 agree but mean confidence of the AGREEING models < 0.6 → no position", () => {
    const models: ModelViews[] = [
      { SPY: v("long", 0.5) },
      { SPY: v("long", 0.69) },
      { SPY: v("neutral", 1.0) }, // high-confidence neutral must not rescue the mean
    ];
    expect(computeQuorum(models, ["SPY"])).toEqual([]);
  });

  test("3 of 3 short → short with mean of all three", () => {
    const models: ModelViews[] = [
      { ETH: v("short", 0.6) },
      { ETH: v("short", 0.7) },
      { ETH: v("short", 0.8) },
    ];
    const q = computeQuorum(models, ["ETH"]);
    expect(q[0].direction).toBe(-1);
    expect(q[0].meanConfidence).toBeCloseTo(0.7, 10);
  });

  test("neutral agreement is NOT a position; full disagreement is not either", () => {
    expect(computeQuorum([
      { QQQ: v("neutral", 0.9) }, { QQQ: v("neutral", 0.9) }, { QQQ: v("neutral", 0.9) },
    ], ["QQQ"])).toEqual([]);
    expect(computeQuorum([
      { QQQ: v("long", 0.9) }, { QQQ: v("short", 0.9) }, { QQQ: v("neutral", 0.9) },
    ], ["QQQ"])).toEqual([]);
  });

  test("boundary: mean confidence exactly 0.6 qualifies", () => {
    const q = computeQuorum([
      { GLD: v("long", 0.6) }, { GLD: v("long", 0.6) }, { GLD: v("short", 0.1) },
    ], ["GLD"]);
    expect(q.length).toBe(1);
  });

  test("only 2 models answered (one call failed): their agreement still counts", () => {
    const q = computeQuorum([
      { IWM: v("short", 0.8) }, { IWM: v("short", 0.7) },
    ], ["IWM"]);
    expect(q).toEqual([{ symbol: "IWM", direction: -1, meanConfidence: 0.75 }]);
  });

  test("a model missing the symbol is simply not counted", () => {
    const q = computeQuorum([
      { AAPL: v("long", 0.9) }, {}, { AAPL: v("long", 0.9) },
    ], ["AAPL"]);
    expect(q.length).toBe(1);
  });
});
