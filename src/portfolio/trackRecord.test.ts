// ══════════════════════════════════════════════
// MinTRL / PSR math (src/portfolio/trackRecord.ts) — the mandatory "fire
// test" is the published Bailey & López de Prado years-required table for
// IID normal returns (γ₃=0, γ₄=3), 95% confidence, 252 obs/year. If the
// implementation disagrees with that table, the IMPLEMENTATION is wrong —
// the table is the specification and must never be adjusted to fit.
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import {
  normCdf, normInv, minTrlObservations, probabilisticSharpe, computeTrackRecord,
} from "./trackRecord";

const OBS_PER_YEAR = 252;
const Z95 = normInv(0.95);

describe("normal distribution helpers", () => {
  test("normInv reproduces the standard quantiles", () => {
    expect(normInv(0.95)).toBeCloseTo(1.6449, 3);
    expect(normInv(0.975)).toBeCloseTo(1.9600, 3);
    expect(normInv(0.5)).toBeCloseTo(0, 6);
    expect(normInv(0.05)).toBeCloseTo(-1.6449, 3);
  });

  test("normCdf is the inverse of normInv", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(Z95)).toBeCloseTo(0.95, 5);
    expect(normCdf(-Z95)).toBeCloseTo(0.05, 5);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 4);
  });
});

describe("FIRE TEST — published MinTRL years-required table (IID normal, 95%, 252 obs/yr)", () => {
  // [observed annual SR, benchmark annual SR, published years required]
  const TABLE: Array<[number, number, number]> = [
    [0.5, 0.0, 10.83],
    [1.0, 0.0, 2.71], [1.0, 0.5, 10.85],
    [1.5, 0.0, 1.21], [1.5, 0.5, 2.72], [1.5, 1.0, 10.87],
    [2.0, 0.0, 0.69], [2.0, 0.5, 1.22], [2.0, 1.0, 2.73],
    [3.0, 0.0, 0.31], [3.0, 0.5, 0.44], [3.0, 1.0, 0.69],
  ];

  for (const [srAnnual, srStarAnnual, years] of TABLE) {
    test(`SR=${srAnnual} vs SR*>${srStarAnnual} → ${years} years`, () => {
      // Per-observation Sharpe — the annualization trap the module doc warns
      // about: the formulas take SR per observation, NEVER the annual figure.
      const sr = srAnnual / Math.sqrt(OBS_PER_YEAR);
      const srStar = srStarAnnual / Math.sqrt(OBS_PER_YEAR);
      const minTrl = minTrlObservations(sr, srStar, 0, 3, Z95);
      expect(minTrl).not.toBeNull();
      expect(minTrl! / OBS_PER_YEAR).toBeCloseTo(years, 1);
    });
  }

  test("internal consistency: PSR evaluated exactly at n = MinTRL equals the confidence", () => {
    const sr = 1.0 / Math.sqrt(OBS_PER_YEAR);
    const minTrl = minTrlObservations(sr, 0, 0, 3, Z95)!;
    expect(probabilisticSharpe(sr, 0, minTrl, 0, 3)).toBeCloseTo(0.95, 5);
  });
});

describe("SR̂ ≤ SR* — MinTRL is infinite/undefined, explicitly", () => {
  test("minTrlObservations returns null (never NaN/Infinity/division-by-zero)", () => {
    expect(minTrlObservations(0.01, 0.01, 0, 3, Z95)).toBeNull(); // equal
    expect(minTrlObservations(-0.05, 0, 0, 3, Z95)).toBeNull();   // below
  });

  test("computeTrackRecord on a losing series: status says so, PSR < 0.5, no NaN anywhere", () => {
    // 20 observations, clearly negative drift.
    const rets = Array.from({ length: 20 }, (_, i) => -0.004 + 0.002 * Math.sin(i * 2.3));
    const tr = computeTrackRecord(rets, { obsPerYear: OBS_PER_YEAR });
    expect(tr.status).toBe("sharpe_not_above_benchmark");
    expect(tr.minTrlObs).toBeNull();
    expect(tr.obsNeeded).toBeNull();
    expect(tr.obsMissing).toBeNull();
    expect(tr.sharpePerObs!).toBeLessThan(0);
    expect(tr.psr!).toBeLessThan(0.5);
    for (const v of Object.values(tr)) {
      if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
    }
  });
});

describe("honesty at small n", () => {
  test("n=0 → no_data, all measures null", () => {
    const tr = computeTrackRecord([]);
    expect(tr.status).toBe("no_data");
    expect(tr.sharpePerObs).toBeNull();
    expect(tr.psr).toBeNull();
  });

  test("n=1 → insufficient_observations, no Sharpe fabricated", () => {
    const tr = computeTrackRecord([0.01]);
    expect(tr.status).toBe("insufficient_observations");
    expect(tr.sharpePerObs).toBeNull();
    expect(tr.sdPerObs).toBeNull();
  });

  test("n=8 (the real momentum-sleeve situation) → Sharpe/PSR/missing-obs travel TOGETHER, status honest", () => {
    const rets = [0.012, -0.008, 0.015, -0.011, 0.009, -0.006, 0.013, -0.004];
    const tr = computeTrackRecord(rets, { obsPerYear: OBS_PER_YEAR });
    expect(tr.status).toBe("insufficient_observations");
    // The observed Sharpe IS returned — but never alone:
    expect(tr.sharpePerObs).not.toBeNull();
    expect(tr.psr).not.toBeNull();
    expect(tr.n).toBe(8);
    if (tr.sharpePerObs! > 0) {
      expect(tr.obsNeeded).toBeGreaterThan(8);
      expect(tr.obsMissing).toBe(tr.obsNeeded! - 8);
    }
    // n=8 is far below any moment-estimation floor:
    expect(tr.momentsSource).toBe("gaussian_assumed");
    expect(tr.skew).toBeNull();
    expect(tr.kurtosis).toBeNull();
  });

  test("n below minObsForMoments never estimates skew/kurtosis; n above does", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => 0.001 + 0.01 * Math.sin(i * 1.7));
    const small = computeTrackRecord(mk(15));
    expect(small.momentsSource).toBe("gaussian_assumed");
    expect(small.skew).toBeNull();
    const big = computeTrackRecord(mk(60));
    expect(big.momentsSource).toBe("estimated");
    expect(typeof big.skew).toBe("number");
    expect(typeof big.kurtosis).toBe("number");
    expect(Number.isNaN(big.skew!)).toBe(false);
    expect(Number.isNaN(big.kurtosis!)).toBe(false);
  });

  test("zero variance → zero_variance, Sharpe undefined (no division by zero)", () => {
    const tr = computeTrackRecord(Array(12).fill(0.01));
    expect(tr.status).toBe("zero_variance");
    expect(tr.sharpePerObs).toBeNull();
    expect(tr.psr).toBeNull();
  });
});

describe("computeTrackRecord mechanics", () => {
  test("annualization is presentation-only: sharpeAnnualized = sharpePerObs·√obsPerYear", () => {
    const rets = Array.from({ length: 40 }, (_, i) => 0.001 + 0.01 * Math.sin(i * 1.7));
    const tr252 = computeTrackRecord(rets, { obsPerYear: 252 });
    const tr365 = computeTrackRecord(rets, { obsPerYear: 365 });
    expect(tr252.sharpePerObs!).toBeCloseTo(tr365.sharpePerObs!, 12); // per-obs unchanged
    expect(tr252.sharpeAnnualized!).toBeCloseTo(tr252.sharpePerObs! * Math.sqrt(252), 10);
    expect(tr365.sharpeAnnualized!).toBeCloseTo(tr365.sharpePerObs! * Math.sqrt(365), 10);
    // MinTRL in OBSERVATIONS is annualization-independent too:
    expect(tr252.minTrlObs!).toBeCloseTo(tr365.minTrlObs!, 8);
  });

  test("track_record_sufficient only when n ≥ MinTRL", () => {
    // Strong, stable edge: SR/obs ≈ 0.5 ⇒ MinTRL ≈ 1 + (1.645/0.5)²·1.125 ≈ 13.4
    const rets = Array.from({ length: 200 }, (_, i) => 0.005 + 0.01 * Math.sin(i * 1.7));
    const tr = computeTrackRecord(rets);
    expect(tr.status).toBe("track_record_sufficient");
    expect(tr.n).toBeGreaterThanOrEqual(tr.minTrlObs!);
    expect(tr.obsMissing).toBe(0);
    expect(tr.psr!).toBeGreaterThan(0.95);

    // Weak edge (SR/obs ≈ 0.1 ⇒ MinTRL ≈ 270 obs), only 12 observations:
    const weak = Array.from({ length: 12 }, (_, i) => 0.001 + 0.01 * Math.sin(i * 1.7));
    const short = computeTrackRecord(weak);
    expect(short.status).toBe("insufficient_track_record");
    expect(short.obsMissing!).toBeGreaterThan(0);
  });
});
