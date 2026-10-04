// ══════════════════════════════════════════════
// Tests for metrics.ts
//
// Cross-checked against QuantStats / Empyrical reference values for
// canonical inputs. Tolerances are loose (1e-6) since pure math.
// ══════════════════════════════════════════════

import { describe, test, expect } from "bun:test";
import {
  mean, stdev, quantile, cumulativeReturn, cagr, volatility,
  sharpe, sortino, calmar, omega, tailRatio,
  drawdownSeries, maxDrawdown, ulcerIndex, recoveryFactor,
  valueAtRisk, conditionalVaR,
  profitFactor, winRate, expectancy, payoffRatio, kelly, riskOfRuin,
  computeMetricBundle,
  skewness, kurtosis, deflatedSharpe,
} from "./metrics";

const APPROX = 1e-9;

describe("primitives", () => {
  test("mean of empty = 0", () => expect(mean([])).toBe(0));
  test("mean basic", () => expect(mean([1, 2, 3, 4])).toBeCloseTo(2.5, 9));

  test("stdev of single = 0", () => expect(stdev([5])).toBe(0));
  test("stdev population", () => {
    // values [1,2,3,4,5], mean=3, popvar = (4+1+0+1+4)/5 = 2, sd=√2
    expect(stdev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2), 9);
  });

  test("quantile median", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBeCloseTo(3, 9);
  });
  test("quantile interp", () => {
    // sorted = [1,2,3,4,5], q=0.25 → pos=1 → exact 2
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBeCloseTo(2, 9);
  });
});

describe("return aggregates", () => {
  test("cumulativeReturn flat = 0", () => {
    expect(cumulativeReturn([0, 0, 0])).toBe(0);
  });
  test("cumulativeReturn compound", () => {
    // (1.1)(1.1)(1.1) - 1 ≈ 0.331
    expect(cumulativeReturn([0.1, 0.1, 0.1])).toBeCloseTo(0.331, 9);
  });
  test("cumulativeReturn with loss", () => {
    // +50% then -50% = -25%
    expect(cumulativeReturn([0.5, -0.5])).toBeCloseTo(-0.25, 9);
  });

  test("cagr identity", () => {
    // 252 days of 0.001 daily: total = 1.001^252 - 1 ≈ 0.288
    // CAGR with periodsPerYear=252 over 252 periods = (1+total)^(252/252)-1 = total
    const r = Array(252).fill(0.001);
    const total = cumulativeReturn(r);
    expect(cagr(r, 252)).toBeCloseTo(total, 9);
  });

  test("volatility scales by √period", () => {
    const r = [0.01, -0.01, 0.02, -0.015];
    expect(volatility(r, 252)).toBeCloseTo(stdev(r) * Math.sqrt(252), 9);
  });
});

describe("risk-adjusted ratios", () => {
  test("sharpe of constant = 0 (sd=0)", () => {
    expect(sharpe([0.01, 0.01, 0.01])).toBe(0);
  });

  test("sharpe positive returns", () => {
    const r = [0.01, -0.005, 0.015, 0.005, -0.002];
    const m = mean(r), s = stdev(r);
    const expected = (m / s) * Math.sqrt(252);
    expect(sharpe(r)).toBeCloseTo(expected, 9);
  });

  test("sortino ignores upside vol", () => {
    // [+5%, +5%, -1%, -1%]: stdev sees all 4, downside dev sees only the -1%s.
    // Sortino > Sharpe in this case.
    const r = [0.05, 0.05, -0.01, -0.01];
    expect(sortino(r)).toBeGreaterThan(sharpe(r));
  });

  test("calmar = CAGR / |maxDD|", () => {
    const r = [0.05, -0.10, 0.08]; // dd ≈ -10%
    expect(calmar(r, 252)).toBeCloseTo(cagr(r, 252) / Math.abs(maxDrawdown(r)), 9);
  });

  test("omega above 1 when wins > losses", () => {
    expect(omega([0.02, -0.01, 0.02, -0.01])).toBeCloseTo(2, APPROX);
  });

  test("tailRatio with symmetric returns ≈ 1", () => {
    const sym: number[] = [];
    for (let i = -50; i <= 50; i++) sym.push(i / 1000);
    expect(tailRatio(sym)).toBeCloseTo(1, 1); // approx
  });
});

describe("drawdown family", () => {
  test("drawdownSeries flat = zeros", () => {
    expect(drawdownSeries([0, 0, 0])).toEqual([0, 0, 0]);
  });

  test("maxDrawdown known case", () => {
    // equity: 1, 1.10, 0.99, 1.05  → peak=1.10, valley=0.99 → -10%
    expect(maxDrawdown([0.10, -0.10, 0.0606])).toBeCloseTo(-0.1, 4);
  });

  test("ulcerIndex of monotonic up = 0", () => {
    expect(ulcerIndex([0.01, 0.01, 0.01, 0.01])).toBe(0);
  });

  test("recoveryFactor with 0 dd = 0", () => {
    expect(recoveryFactor([0.01, 0.01])).toBe(0);
  });
});

describe("VaR / CVaR", () => {
  test("VaR at 5% = 5th percentile", () => {
    const r = Array.from({ length: 100 }, (_, i) => (i - 50) / 1000);
    // 5th percentile of -50..49 milli = quantile([-0.05..0.049], 0.05)
    expect(valueAtRisk(r, 0.05)).toBeLessThan(0);
  });

  test("CVaR ≤ VaR (more negative)", () => {
    const r = Array.from({ length: 100 }, () => Math.random() - 0.55);
    const v = valueAtRisk(r, 0.05);
    const cv = conditionalVaR(r, 0.05);
    expect(cv).toBeLessThanOrEqual(v);
  });
});

describe("trade-quality", () => {
  test("profitFactor", () => {
    expect(profitFactor([10, -5, 8, -3])).toBeCloseTo((10 + 8) / (5 + 3), 9);
  });

  test("winRate", () => {
    expect(winRate([1, -1, 1, -1, 1])).toBeCloseTo(3 / 5, 9);
  });

  test("expectancy = mean", () => {
    expect(expectancy([10, -5, 8, -3])).toBeCloseTo(2.5, 9);
  });

  test("payoffRatio", () => {
    expect(payoffRatio([10, -5, 20, -10])).toBeCloseTo(15 / 7.5, 9); // (15)/(7.5)=2
  });

  test("kelly with 60% WR + 2:1 payoff", () => {
    // f = 0.6 - 0.4/2 = 0.6 - 0.2 = 0.4
    const pnls = [2, 2, 2, 2, 2, 2, -1, -1, -1, -1]; // 6W, 4L, payoff=2
    expect(kelly(pnls)).toBeCloseTo(0.4, 9);
  });

  test("kelly clamped at 0 for losing strategy", () => {
    expect(kelly([1, 1, -2, -2, -2])).toBe(0);
  });

  test("riskOfRuin = 1 for negative-edge", () => {
    expect(riskOfRuin([-1, -1, -1, 1])).toBe(1);
  });
});

describe("computeMetricBundle integration", () => {
  test("returns all expected fields for a real-ish series", () => {
    // 30-day series, mostly positive with a small drawdown
    const r = [
      0.005, 0.003, -0.002, 0.008, 0.001, -0.005, 0.004, 0.002,
      -0.010, -0.005, 0.001, 0.006, 0.003, 0.005, 0.002, -0.003,
      0.004, 0.006, 0.001, 0.002, -0.001, 0.003, 0.005, 0.004,
      0.002, 0.001, 0.003, 0.002, -0.001, 0.002,
    ];
    const b = computeMetricBundle(r);
    expect(b.periods).toBe(r.length);
    expect(b.cumReturn).toBeGreaterThan(0);
    expect(b.cagr).toBeGreaterThan(0);
    expect(b.volatility).toBeGreaterThan(0);
    expect(b.sharpe).toBeGreaterThan(0);
    expect(b.sortino).toBeGreaterThan(0);
    expect(b.maxDrawdown).toBeLessThan(0);
    expect(b.var95).toBeLessThan(0);
    expect(b.cvar95).toBeLessThanOrEqual(b.var95);
    expect(b.ulcerIndex).toBeGreaterThan(0);
  });

  test("flat series produces sensible zeros", () => {
    const r = Array(30).fill(0);
    const b = computeMetricBundle(r);
    expect(b.cumReturn).toBe(0);
    expect(b.cagr).toBe(0);
    expect(b.volatility).toBe(0);
    expect(b.sharpe).toBe(0);
    expect(b.maxDrawdown).toBe(0);
  });
});

// ── Wave 1: Deflated Sharpe + higher moments ──────────────────────
describe("Wave 1: Deflated Sharpe Ratio", () => {
  // Mulberry32-ish seeded PRNG so tests are deterministic
  function seeded(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xFFFFFFFF;
    };
  }

  // Numerical-reference oracle: integrates the exact expectation of the
  // maximum of N standard normals and recomputes DSR from first
  // principles. This is independent of the production closed-form.
  function referenceNormalCdf(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  function referenceExpectedMaxNormal(N: number): number {
    if (N <= 1) return 0;
    const phi = referenceNormalCdf;
    const f = (x: number) => 1 - Math.pow(phi(x), N) - Math.pow(phi(-x), N);
    const b = 10;
    const steps = 8000;
    const h = b / steps;
    let sum = 0.5 * (f(0) + f(b));
    for (let i = 1; i < steps; i++) sum += f(i * h);
    return sum * h;
  }
  function referenceDeflatedSharpe(rets: number[], numTrials: number, periodsPerYear = 252): number {
    const n = rets.length;
    if (n < 30 || numTrials < 1) return 0;
    if (stdev(rets) < 1e-12) return 0;
    const srPerPeriod = sharpe(rets, 0, periodsPerYear) / Math.sqrt(periodsPerYear);
    const sk = skewness(rets);
    const rawK = Math.max(1, kurtosis(rets) + 3);
    const seNull = 1 / Math.sqrt(n - 1);
    const srStar = referenceExpectedMaxNormal(numTrials) * seNull;
    const V = (1 - sk * srPerPeriod + ((rawK - 1) / 4) * srPerPeriod * srPerPeriod) / (n - 1);
    const seSr = Math.sqrt(Math.max(1e-12, V));
    if (!Number.isFinite(seSr) || seSr === 0) return 0;
    const z = (srPerPeriod - srStar) / seSr;
    if (!Number.isFinite(z)) return srPerPeriod > srStar ? 1 : 0;
    return Math.max(0, Math.min(1, referenceNormalCdf(z)));
  }

  test("returns 0 for too-few-samples input", () => {
    expect(deflatedSharpe([0.01, 0.02], 1)).toBe(0);
    expect(deflatedSharpe(Array(29).fill(0.01), 1)).toBe(0);
  });

  test("returns a probability in [0, 1] for a positive-drift series", () => {
    const rng = seeded(12345);
    const rets = Array.from({ length: 250 }, () => 0.0008 + (rng() - 0.5) * 0.02);
    const dsr = deflatedSharpe(rets, 1);
    expect(dsr).toBeGreaterThanOrEqual(0);
    expect(dsr).toBeLessThanOrEqual(1);
  });

  test("DSR drops as numTrials grows (multiple-testing penalty)", () => {
    const rng = seeded(99);
    const rets = Array.from({ length: 250 }, () => 0.001 + (rng() - 0.5) * 0.015);
    const dsr1 = deflatedSharpe(rets, 1);
    const dsr100 = deflatedSharpe(rets, 100);
    expect(dsr100).toBeLessThanOrEqual(dsr1);
  });

  test("skewness of a centered cosine series is ~0", () => {
    const rets = Array.from({ length: 1000 }, (_, i) => Math.cos(i / 5));
    expect(Math.abs(skewness(rets))).toBeLessThan(0.1);
  });

  test("excess kurtosis of a Gaussian-ish sample is small", () => {
    const rng = seeded(42);
    const rets: number[] = [];
    for (let i = 0; i < 1000; i++) {
      // Box-Muller approximate normal
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      rets.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
    }
    expect(Math.abs(kurtosis(rets))).toBeLessThan(0.6);
  });

  test("computeMetricBundle exposes deflatedSharpe field", () => {
    const rng = seeded(7);
    const rets = Array.from({ length: 200 }, () => 0.0005 + (rng() - 0.5) * 0.012);
    const b = computeMetricBundle(rets, 0, 252, 50);
    expect(typeof b.deflatedSharpe).toBe("number");
    expect(b.deflatedSharpe).toBeGreaterThanOrEqual(0);
    expect(b.deflatedSharpe).toBeLessThanOrEqual(1);
  });

  // ── Numerical-reference fixtures ──────────────────────────────────
  test("matches the closed-form N=2 expected-normal fixture", () => {
    // E[max(Z1, Z2)] = 1 / sqrt(pi) for independent standard normals.
    expect(referenceExpectedMaxNormal(2)).toBeCloseTo(1 / Math.sqrt(Math.PI), 5);
  });

  test("matches numerical-reference implementation across seeds and trial counts", () => {
    const seeds = [1, 7, 42, 99, 2026];
    const trials = [1, 2, 5, 10, 100, 1000];
    for (const seed of seeds) {
      const rng = seeded(seed);
      const rets = Array.from({ length: 252 }, () => 0.0005 + (rng() - 0.5) * 0.02);
      for (const N of trials) {
        const actual = deflatedSharpe(rets, N);
        const expected = referenceDeflatedSharpe(rets, N);
        expect(Math.abs(actual - expected)).toBeLessThan(2e-3);
      }
    }
  });

  // ── Monotonicity / return-quality tests ───────────────────────────
  test("DSR is non-increasing in numTrials (multiple-testing penalty)", () => {
    const rng = seeded(123);
    const rets = Array.from({ length: 252 }, () => 0.001 + (rng() - 0.5) * 0.015);
    const values = [1, 2, 5, 10, 100, 1000].map(N => deflatedSharpe(rets, N));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1] + 1e-12);
    }
  });

  test("DSR increases with better return quality for fixed trial count", () => {
    const rng = seeded(55);
    const noise = Array.from({ length: 252 }, () => (rng() - 0.5) * 0.02);
    const low = noise.map(r => r + 0.0001);
    const mid = noise.map(r => r + 0.0008);
    const high = noise.map(r => r + 0.002);
    expect(deflatedSharpe(low, 10)).toBeLessThan(deflatedSharpe(mid, 10));
    expect(deflatedSharpe(mid, 10)).toBeLessThan(deflatedSharpe(high, 10));
  });

  // ── Edge cases ────────────────────────────────────────────────────
  test("N=1 null threshold is zero (zero-mean series → DSR = 0.5)", () => {
    const rets = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    expect(deflatedSharpe(rets, 1)).toBeCloseTo(0.5, 6);
  });

  test("constant returns produce 0 because Sharpe is undefined", () => {
    expect(deflatedSharpe(Array(252).fill(0.001), 1)).toBe(0);
  });

  test("invalid or insufficient inputs return 0", () => {
    expect(deflatedSharpe([], 1)).toBe(0);
    expect(deflatedSharpe(Array(29).fill(0.001), 1)).toBe(0);
    expect(deflatedSharpe(Array(252).fill(0.001), 0)).toBe(0);
    expect(deflatedSharpe(Array(252).fill(0.001), -5)).toBe(0);
  });

  test("extreme trial counts stay finite and inside [0, 1]", () => {
    const rng = seeded(3);
    const rets = Array.from({ length: 252 }, () => (rng() - 0.5) * 0.02);
    const dsr = deflatedSharpe(rets, Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(dsr)).toBe(true);
    expect(dsr).toBeGreaterThanOrEqual(0);
    expect(dsr).toBeLessThanOrEqual(1);
  });
});

// ── Wave 2: PSR / DSR (paper form) / smart Sharpe ─────────────────
import {
  normalCdf, normalInv, probabilisticSharpe, deflatedSharpeRatio,
  autocorrPenalty, smartSharpe,
} from "./metrics";

describe("Wave 2: normal helpers", () => {
  // Reference values pinned from Python's math.erf / statistics.NormalDist
  // (exact to double precision). Documented accuracy: normalCdf (A&S
  // 7.1.26) |err| < 7.5e-8 → assert at 1e-7; normalInv (Acklam) relative
  // |err| < 1.15e-9 → assert at 1e-8.
  test("normalCdf matches erf-based reference values within 7.5e-8", () => {
    const ref: Array<[number, number]> = [
      [0, 0.5],
      [1, 0.8413447460685429],
      [1.96, 0.9750021048517795],
      [-1.96, 0.0249978951482205],
      [3.09, 0.9989991757199825],
    ];
    for (const [z, phi] of ref) {
      expect(Math.abs(normalCdf(z) - phi)).toBeLessThan(7.5e-8); // A&S 7.1.26 bound
    }
  });

  test("normalCdf symmetry Φ(z) + Φ(−z) = 1", () => {
    for (const z of [0.1, 0.5, 1, 1.645, 2.5, 4]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 7);
    }
  });

  test("normalInv matches published quantiles", () => {
    expect(normalInv(0.5)).toBeCloseTo(0, 8);
    expect(normalInv(0.975)).toBeCloseTo(1.9599639845400536, 8);
    expect(normalInv(0.99)).toBeCloseTo(2.3263478740408408, 8);
    expect(normalInv(0.999)).toBeCloseTo(3.090232306167813, 8);
    expect(normalInv(0.001)).toBeCloseTo(-3.090232306167813, 8);
    expect(normalInv(0.0001)).toBeCloseTo(-3.71901648545568, 8);
    // just below the p_low=0.02425 branch switch
    expect(normalInv(0.02425)).toBeCloseTo(-1.9729610513118845, 8);
  });

  test("normalInv round-trips through normalCdf", () => {
    for (const z of [-3, -1.5, -0.2, 0, 0.7, 2, 3]) {
      // Limited by the cdf's 7.5e-8 abs error: near z=3 that maps to
      // ~7.5e-8/pdf(3) ≈ 1.7e-5 in z-space, so assert at 1e-4.
      expect(normalInv(normalCdf(z))).toBeCloseTo(z, 4);
    }
  });

  test("normalInv degenerate inputs are explicit, not silent NaN", () => {
    expect(normalInv(0)).toBe(-Infinity);
    expect(normalInv(-1)).toBe(-Infinity);
    expect(normalInv(1)).toBe(Infinity);
    expect(normalInv(2)).toBe(Infinity);
    expect(Number.isNaN(normalInv(NaN))).toBe(true);
  });
});

describe("Wave 2: Probabilistic Sharpe Ratio", () => {
  // Fixture A: deterministic 20-period series. Reference PSR computed with
  // an independent Python implementation (math.erf CDF, identical sample
  // skew/excess-kurtosis formulas): SR/period = 0.4047358592,
  // skew = -0.1419193258, excess kurt = -0.7401441946.
  const A = [0.01, -0.005, 0.015, 0.005, -0.002, 0.008, -0.01, 0.003, 0.006, -0.004,
             0.012, 0.001, -0.007, 0.009, 0.002, -0.003, 0.011, 0.004, -0.006, 0.007];

  test("matches independent erf-based reference (benchmark 0)", () => {
    expect(probabilisticSharpe(A, 0)).toBeCloseTo(0.9530560208669843, 6);
  });

  test("matches independent erf-based reference (benchmark 0.2/period)", () => {
    expect(probabilisticSharpe(A, 0.2)).toBeCloseTo(0.8016191927479461, 6);
  });

  test("PSR against its own Sharpe is exactly 0.5 (z = 0)", () => {
    const srOwn = mean(A) / stdev(A);
    expect(probabilisticSharpe(A, srOwn)).toBeCloseTo(0.5, 7);
  });

  test("zero-mean alternating series → PSR(0) = 0.5", () => {
    const alt = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    expect(probabilisticSharpe(alt, 0)).toBeCloseTo(0.5, 7);
  });

  test("monotone decreasing in the benchmark", () => {
    expect(probabilisticSharpe(A, 0)).toBeGreaterThan(probabilisticSharpe(A, 0.1));
    expect(probabilisticSharpe(A, 0.1)).toBeGreaterThan(probabilisticSharpe(A, 0.3));
  });

  test("more samples with same moments → more confidence", () => {
    const A4 = [...A, ...A, ...A, ...A];
    expect(probabilisticSharpe(A4, 0)).toBeGreaterThan(probabilisticSharpe(A, 0));
  });

  test("degenerate inputs return 0, never NaN", () => {
    expect(probabilisticSharpe([], 0)).toBe(0);
    expect(probabilisticSharpe([0.01], 0)).toBe(0);                  // n too small
    expect(probabilisticSharpe(Array(50).fill(0.01), 0)).toBe(0);    // all equal, sd=0
    expect(probabilisticSharpe(Array(50).fill(0), 0)).toBe(0);       // variance zero
    expect(probabilisticSharpe(A, NaN)).toBe(0);                     // bad benchmark
  });
});

describe("Wave 2: Deflated Sharpe Ratio (paper formula)", () => {
  const A = [0.01, -0.005, 0.015, 0.005, -0.002, 0.008, -0.01, 0.003, 0.006, -0.004,
             0.012, 0.001, -0.007, 0.009, 0.002, -0.003, 0.011, 0.004, -0.006, 0.007];

  // Independent numerical integration of E[max of N standard normals]
  // (same integrand as Wave 1's oracle). The paper's closed form
  // (1−γ)Φ⁻¹(1−1/N) + γΦ⁻¹(1−1/(N·e)) is an asymptotic approximation known
  // to agree within a few percent for moderate N — a sign flip or an
  // n/(n−1) style error blows far past that band.
  function numericalExpectedMax(N: number): number {
    const f = (x: number) => 1 - Math.pow(normalCdf(x), N) - Math.pow(normalCdf(-x), N);
    const b = 10, steps = 8000, h = b / steps;
    let sum = 0.5 * (f(0) + f(b));
    for (let i = 1; i < steps; i++) sum += f(i * h);
    return sum * h;
  }

  test("SR*₀ expected-max term matches numerical integration within 3%", () => {
    const g = 0.5772156649015329;
    for (const N of [10, 100, 251, 1000]) {
      const approx = (1 - g) * normalInv(1 - 1 / N) + g * normalInv(1 - 1 / (N * Math.E));
      const exact = numericalExpectedMax(N);
      expect(Math.abs(approx - exact) / exact).toBeLessThan(0.03);
    }
  });

  test("SR*₀ term matches Python-pinned constants (N=100, Var=0.04)", () => {
    // From statistics.NormalDist: (1−γ)Φ⁻¹(0.99) + γΦ⁻¹(1−1/(100e)) = 2.5306028932016846
    // With Var = 0.04 → SR*₀ = 0.2 × 2.5306028932016846.
    const srStar = 0.2 * 2.5306028932016846;
    expect(deflatedSharpeRatio(A, 100, 0.04)).toBeCloseTo(probabilisticSharpe(A, srStar), 7);
  });

  test("N=1, Var=0, or invalid Var deflate nothing → plain PSR", () => {
    const psr = probabilisticSharpe(A, 0);
    expect(deflatedSharpeRatio(A, 1, 0.5)).toBe(psr);   // single trial
    expect(deflatedSharpeRatio(A, 100, 0)).toBe(psr);   // Var[SR]=0
    expect(deflatedSharpeRatio(A, 100, -1)).toBe(psr);  // nonsense Var
    expect(deflatedSharpeRatio(A, NaN, 0.5)).toBe(psr); // nonsense N
  });

  test("monotone non-increasing in numTrials and in trial variance", () => {
    const byN = [2, 5, 10, 100, 1000].map(N => deflatedSharpeRatio(A, N, 0.01));
    for (let i = 1; i < byN.length; i++) expect(byN[i]).toBeLessThanOrEqual(byN[i - 1] + 1e-12);
    const byVar = [0.001, 0.01, 0.1, 1].map(v => deflatedSharpeRatio(A, 50, v));
    for (let i = 1; i < byVar.length; i++) expect(byVar[i]).toBeLessThanOrEqual(byVar[i - 1] + 1e-12);
  });

  test("stays finite and in [0,1] at extremes", () => {
    for (const dsr of [
      deflatedSharpeRatio(A, Number.MAX_SAFE_INTEGER, 100),
      deflatedSharpeRatio(A, 2, 1e-12),
      deflatedSharpeRatio(Array(50).fill(0.01), 100, 0.5), // sd=0 series
      deflatedSharpeRatio([], 100, 0.5),
    ]) {
      expect(Number.isFinite(dsr)).toBe(true);
      expect(dsr).toBeGreaterThanOrEqual(0);
      expect(dsr).toBeLessThanOrEqual(1);
    }
  });
});

describe("Wave 2: autocorrelation penalty + smart Sharpe", () => {
  test("perfectly trending series: hand-computed penalty = 2", () => {
    // rets [1,2,3,4]: lag-1 slices [1,2,3] vs [2,3,4] → corr = 1 exactly.
    // sum = (3/4)·1 + (2/4)·1 + (1/4)·1 = 1.5 → sqrt(1 + 2·1.5) = 2.
    expect(autocorrPenalty([1, 2, 3, 4])).toBeCloseTo(2, 9);
  });

  test("perfect anti-correlation also penalized (|ρ|, per reference impl)", () => {
    // [1,-1,1,-1]: lag-1 corr = −1 → |ρ| = 1 → same penalty as trending.
    expect(autocorrPenalty([1, -1, 1, -1])).toBeCloseTo(2, 9);
  });

  test("penalty is always ≥ 1 and ~1 for white noise", () => {
    let s = 7 >>> 0;
    const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xFFFFFFFF);
    const noise = Array.from({ length: 500 }, () => rng() - 0.5);
    const p = autocorrPenalty(noise);
    expect(p).toBeGreaterThanOrEqual(1);
    expect(p).toBeLessThan(1.5);
  });

  test("degenerate inputs → penalty 1, never NaN", () => {
    expect(autocorrPenalty([])).toBe(1);
    expect(autocorrPenalty([0.01])).toBe(1);
    expect(autocorrPenalty([0.01, 0.02])).toBe(1);        // n < 3
    expect(autocorrPenalty(Array(50).fill(0.01))).toBe(1); // constant → corr undefined
  });

  test("smartSharpe = sharpe / penalty (exact on the hand case)", () => {
    const r = [0.01, 0.02, 0.03, 0.04]; // penalty = 2 (same structure as above)
    expect(smartSharpe(r)).toBeCloseTo(sharpe(r) / 2, 9);
  });

  test("smartSharpe ≤ sharpe for autocorrelated positive-drift series", () => {
    // Multi-day-hold shape: blocks of identical returns → strong lag-1 corr.
    const r: number[] = [];
    let s = 42 >>> 0;
    const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xFFFFFFFF);
    for (let i = 0; i < 60; i++) {
      const block = 0.001 + (rng() - 0.45) * 0.01;
      for (let k = 0; k < 4; k++) r.push(block);
    }
    expect(sharpe(r)).toBeGreaterThan(0);
    expect(smartSharpe(r)).toBeLessThan(sharpe(r));
    expect(smartSharpe(r)).toBeGreaterThan(0);
  });

  test("smartSharpe degenerate inputs → 0", () => {
    expect(smartSharpe([])).toBe(0);
    expect(smartSharpe(Array(50).fill(0.01))).toBe(0); // sd = 0
  });
});
