import { expect, test } from "bun:test";
import { cappedInverseVolWeights, covarianceFromPrices, estimateCovariance, inverseVolWeights, portfolioVol, scaleToVolTarget, selectCoreMembers } from "./construction";
import type { DailyBar, FactorCoreConfig, PriceView } from "./types";

test("inverse vols normalize and ignore zero/nonfinite estimates", () => {
  expect(inverseVolWeights({ A: 1, B: 2, C: 0, D: NaN })).toEqual({ A: 2 / 3, B: 1 / 3 });
  expect(inverseVolWeights({ A: 0 })).toEqual({});
});

test("sample covariance and known uncorrelated portfolio hit annual target", () => {
  const cov = estimateCovariance({ A: [-0.01, 0, 0.01], B: [0.01, -0.02, 0.01] });
  expect(cov.A.A).toBeCloseTo(0.0001, 12);
  expect(cov.B.B).toBeCloseTo(0.0003, 12);
  expect(cov.A.B).toBeCloseTo(0, 12);
  for (const annualization of [252, 365]) {
    const result = scaleToVolTarget({ A: 0.01, B: Math.sqrt(0.0003) }, cov, annualization, 0.12, 10, 10);
    expect(result.finalVol).toBeCloseTo(0.12, 12);
    expect(portfolioVol(result.weights, cov, annualization)).toBeCloseTo(0.12, 12);
  }
  expect(() => estimateCovariance({ A: [1], B: [1, 2] })).toThrow("aligned");
});

test("scale THEN asset cap THEN proportional gross, with no reinflation", () => {
  const cov = { A: { A: 1, B: 0 }, B: { A: 0, B: 1 } };
  const result = scaleToVolTarget({ A: 1, B: 3 }, cov, 1, Math.sqrt(10), 2, 2.4);
  // Base .75/.25, scale 4 → 3/1; asset clipping → 2/1; gross → 1.6/.8.
  expect(result.scale).toBeCloseTo(4);
  expect(result.weights.A).toBeCloseTo(1.6);
  expect(result.weights.B).toBeCloseTo(0.8);
  const clip = scaleToVolTarget({ A: 1, B: 3 }, cov, 1, Math.sqrt(10), 2, 10);
  expect(clip.weights).toEqual({ A: 2, B: 1 });
  expect(clip.finalVol).toBeLessThan(Math.sqrt(10));
  expect(scaleToVolTarget({ A: 1 }, { A: { A: 0 } }, 252, 0.12, 1, 1.8).weights.A).toBe(0);
});

test("D2 cap redistributes and fills exposure only when feasible", () => {
  expect(cappedInverseVolWeights({ A: 1, B: 2, C: 2 }, 1, 0.4)).toEqual({ A: 0.4, B: 0.3, C: 0.3 });
  expect(cappedInverseVolWeights({ A: 1, B: 2 }, 1, 0.04)).toEqual({ A: 0.04, B: 0.04 });
  const vols = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`S${i}`, 1 + i]));
  for (const exposure of [0.5, 1]) {
    const weights = Object.values(cappedInverseVolWeights(vols, exposure, 0.04));
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(exposure, 12);
    expect(Math.max(...weights)).toBeLessThanOrEqual(0.04);
  }
});

function view(data: Record<string, number[]>, counts: Record<string, number> = {}): PriceView {
  return { asOf: "2020-01-04", barCount: s => counts[s] ?? data[s]?.length ?? 0,
    history: (s, n) => (data[s] ?? []).map((close, i): DailyBar => ({ date: `2020-01-0${i + 1}`, open: close, close, low: close, high: close, volume: 1 })).slice(-n) };
}
const config: FactorCoreConfig = { kind: "factorCore", exclude: ["EXCLUDED"], topN: 2, score: "momentum", momentumWindow: [3, 1],
  volWindow: 3, weightVolLookback: 2, perNameCap: 0.04, minPrice: 5, minPriorCloses: 4, overlay: null };

test("PIT universe, exclusion, exact minimum price and prior closes, top N", () => {
  const prices = view({ A: [5, 6, 7, 5], B: [5, 6, 8, 6], EXCLUDED: [5, 20, 30, 40],
    FUTURE: [5, 20, 30, 40], CHEAP: [1, 2, 8, 4.99], NEW: [5, 8, 10, 12] }, { NEW: 3 });
  const membership = { members: (date: string) => {
    expect(date).toBe(prices.asOf); return ["A", "B", "B", "EXCLUDED", "CHEAP", "NEW"];
  } };
  expect(selectCoreMembers(prices, membership, config).members).toEqual(["B", "A"]);
});

test("all three D2 score modes and lexical tie-break", () => {
  const prices = view({ A: [10, 12, 14, 16], B: [10, 10.1, 10.2, 10.3], C: [10, 12, 14, 16] });
  const members = { members: () => ["C", "B", "A"] };
  expect(selectCoreMembers(prices, members, { ...config, topN: 1 }).members).toEqual(["A"]);
  expect(selectCoreMembers(prices, members, { ...config, topN: 1, score: "lowvol" }).members).toEqual(["B"]);
  const combined = selectCoreMembers(prices, members, { ...config, score: "momentum+lowvol" });
  expect(combined.scores.A).toBe(4);
  expect(combined.scores.B).toBe(4);
  expect(combined.members).toEqual(["A", "B"]);
});

test("covariance aligns return intervals, never mismatched offsets", () => {
  const base = view({ A: [100, 110, 99, 100], B: [100, 110, 99, 100] });
  const prices: PriceView = { ...base, history: (s, n) => base.history(s, n).filter(b => s !== "B" || b.date !== "2020-01-02") };
  // Only Jan 3→4 is common, insufficient sample covariance, not false correlation.
  expect(covarianceFromPrices(prices, ["A", "B"], 3)).toEqual({ A: { A: 0, B: 0 }, B: { A: 0, B: 0 } });
});
