// ══════════════════════════════════════════════
// Performance Metrics — Sprint 1 (2026-05-05)
//
// Pure functions. Port of the metrics most-used in QuantStats / Empyrical /
// Pyfolio. Inputs are arrays of *daily returns* (e.g. 0.012 = +1.2%) unless
// stated otherwise. All metrics annualise with `periodsPerYear=252` for
// stocks, callers can pass 365 for crypto.
//
// Refs:
//   QuantStats:  https://github.com/ranaroussi/quantstats
//   Empyrical:   https://github.com/quantopian/empyrical
//   Pyfolio:     https://github.com/quantopian/pyfolio
// ══════════════════════════════════════════════

/** Mean of a numeric array. Returns 0 for empty. */
export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population stdev. Returns 0 for length<2. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

/** Linear-interpolated quantile in [0,1]. */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

// ── Return aggregates ───────────────────────────────────────────────

/** Cumulative return as a multiplier (1 + r1)·(1 + r2)·… − 1. */
export function cumulativeReturn(rets: number[]): number {
  let c = 1;
  for (const r of rets) c *= 1 + r;
  return c - 1;
}

/** Compound annual growth rate: (1+totalReturn)^(periods/N) - 1 */
export function cagr(rets: number[], periodsPerYear = 252): number {
  if (!rets.length) return 0;
  const total = cumulativeReturn(rets);
  return Math.pow(1 + total, periodsPerYear / rets.length) - 1;
}

/** Annualised volatility = stdev(daily) × √periodsPerYear. */
export function volatility(rets: number[], periodsPerYear = 252): number {
  return stdev(rets) * Math.sqrt(periodsPerYear);
}

// ── Risk-adjusted ratios ────────────────────────────────────────────

/**
 * Sharpe ratio: (mean − rfPerPeriod) / stdev × √periodsPerYear.
 * `rf` is annual risk-free rate; converted to per-period internally.
 */
export function sharpe(rets: number[], rf = 0, periodsPerYear = 252): number {
  if (rets.length < 2) return 0;
  const sd = stdev(rets);
  // Tolerance, not ===: 50 copies of 0.01 sum to 0.5000000000000002, giving
  // sd ≈ 4e-18 and a garbage ~1e16 Sharpe if compared exactly to zero.
  if (sd < 1e-12) return 0;
  const rfPerPeriod = rf / periodsPerYear;
  return ((mean(rets) - rfPerPeriod) / sd) * Math.sqrt(periodsPerYear);
}

/**
 * Sortino: like Sharpe but uses downside deviation (only negative
 * returns) as denominator. Punishes losses, ignores upside vol.
 */
export function sortino(rets: number[], rf = 0, periodsPerYear = 252): number {
  if (rets.length < 2) return 0;
  const rfPerPeriod = rf / periodsPerYear;
  const downside = rets.filter(r => r < rfPerPeriod);
  if (!downside.length) return 0;
  // Downside deviation: rms of below-target returns (semivariance).
  let s = 0;
  for (const r of downside) s += (r - rfPerPeriod) * (r - rfPerPeriod);
  const dd = Math.sqrt(s / rets.length);
  if (dd === 0) return 0;
  return ((mean(rets) - rfPerPeriod) / dd) * Math.sqrt(periodsPerYear);
}

/**
 * Calmar ratio: CAGR / |max drawdown|. Punishes large peak-to-trough.
 */
export function calmar(rets: number[], periodsPerYear = 252): number {
  const dd = Math.abs(maxDrawdown(rets));
  if (dd === 0) return 0;
  return cagr(rets, periodsPerYear) / dd;
}

/**
 * Omega ratio at threshold t: probability-weighted ratio of gains
 * above t to losses below t. Sensitive to fat tails + skew.
 */
export function omega(rets: number[], threshold = 0): number {
  let gains = 0, losses = 0;
  for (const r of rets) {
    if (r > threshold) gains += r - threshold;
    else losses += threshold - r;
  }
  if (losses === 0) return gains > 0 ? Infinity : 0;
  return gains / losses;
}

/**
 * Tail ratio: 95th-percentile gain / |5th-percentile loss|. >1 = right
 * tail dominates.
 */
export function tailRatio(rets: number[]): number {
  if (rets.length < 20) return 0;
  const top = quantile(rets, 0.95);
  const bot = Math.abs(quantile(rets, 0.05));
  if (bot === 0) return top > 0 ? Infinity : 0;
  return top / bot;
}

// ── Drawdown family ─────────────────────────────────────────────────

/**
 * Equity curve from returns: starts at 1.0, multiplies (1+r) each step.
 */
export function equityCurve(rets: number[]): number[] {
  const out: number[] = new Array(rets.length);
  let eq = 1;
  for (let i = 0; i < rets.length; i++) {
    eq *= 1 + rets[i];
    out[i] = eq;
  }
  return out;
}

/**
 * Drawdown series: percentage below running peak. Always ≤ 0.
 */
export function drawdownSeries(rets: number[]): number[] {
  const eq = equityCurve(rets);
  const out: number[] = new Array(eq.length);
  let peak = -Infinity;
  for (let i = 0; i < eq.length; i++) {
    if (eq[i] > peak) peak = eq[i];
    out[i] = peak > 0 ? (eq[i] - peak) / peak : 0;
  }
  return out;
}

/** Maximum drawdown (most negative value of drawdownSeries). */
export function maxDrawdown(rets: number[]): number {
  const dd = drawdownSeries(rets);
  if (!dd.length) return 0;
  let m = 0;
  for (const v of dd) if (v < m) m = v;
  return m;
}

/**
 * Average drawdown across all underwater periods. Negative number.
 */
export function avgDrawdown(rets: number[]): number {
  const dd = drawdownSeries(rets);
  const under = dd.filter(d => d < 0);
  return under.length ? mean(under) : 0;
}

/**
 * Ulcer Index: rms of drawdowns (in percent points). Penalises both
 * depth and duration of underwater periods.
 */
export function ulcerIndex(rets: number[]): number {
  const dd = drawdownSeries(rets);
  if (!dd.length) return 0;
  let s = 0;
  for (const d of dd) s += d * d * 10000; // percent²
  return Math.sqrt(s / dd.length);
}

/**
 * Recovery Factor: cumulative net return / |max drawdown|.
 * "How many max drawdowns of profit have I made?"
 */
export function recoveryFactor(rets: number[]): number {
  const total = cumulativeReturn(rets);
  const dd = Math.abs(maxDrawdown(rets));
  if (dd === 0) return 0;
  return total / dd;
}

// ── VaR / CVaR ──────────────────────────────────────────────────────

/** Value at Risk at confidence (1 - alpha). E.g. var95 = quantile(rets, 0.05). */
export function valueAtRisk(rets: number[], alpha = 0.05): number {
  return quantile(rets, alpha);
}

/**
 * Conditional VaR (expected shortfall): mean of the worst alpha%
 * of returns. Always ≤ valueAtRisk for the same alpha.
 */
export function conditionalVaR(rets: number[], alpha = 0.05): number {
  if (!rets.length) return 0;
  const v = valueAtRisk(rets, alpha);
  const tail = rets.filter(r => r <= v);
  return tail.length ? mean(tail) : v;
}

// ── Trade-quality ratios (input is per-trade pnl, not daily returns) ─

/** Profit Factor: sum of wins / |sum of losses|. */
export function profitFactor(pnls: number[]): number {
  let win = 0, loss = 0;
  for (const p of pnls) {
    if (p > 0) win += p;
    else if (p < 0) loss += -p;
  }
  if (loss === 0) return win > 0 ? Infinity : 0;
  return win / loss;
}

/** Win rate as a fraction in [0,1]. */
export function winRate(pnls: number[]): number {
  if (!pnls.length) return 0;
  let w = 0;
  for (const p of pnls) if (p > 0) w++;
  return w / pnls.length;
}

/**
 * Expectancy per trade: average dollar P&L per trade. Positive = edge.
 */
export function expectancy(pnls: number[]): number {
  return mean(pnls);
}

/**
 * Payoff Ratio: avgWin / |avgLoss|.
 */
export function payoffRatio(pnls: number[]): number {
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  if (!losses.length) return wins.length ? Infinity : 0;
  const aw = mean(wins);
  const al = Math.abs(mean(losses));
  if (al === 0) return aw > 0 ? Infinity : 0;
  return aw / al;
}

/**
 * Kelly fraction (simplified): edge over odds.
 *   f = winRate − (1 − winRate) / payoffRatio
 * Returns the fraction of equity to risk per trade for max log-growth.
 * Negative = no edge; clamp to 0.
 */
export function kelly(pnls: number[]): number {
  const wr = winRate(pnls);
  const pr = payoffRatio(pnls);
  if (!isFinite(pr) || pr === 0) return 0;
  const f = wr - (1 - wr) / pr;
  return Math.max(0, f);
}

/**
 * Risk of Ruin (simplified Vince formula for fixed-fraction):
 *   ROR = ((1 - edge) / (1 + edge))^N
 * where edge = winRate × avgWin/avgLoss − (1 − winRate). For N tries.
 * Returns probability in [0, 1].
 */
export function riskOfRuin(pnls: number[], tries = 100): number {
  const wr = winRate(pnls);
  const pr = payoffRatio(pnls);
  if (!isFinite(pr) || pr === 0 || wr === 0 || wr === 1) return 0;
  const edge = wr * pr - (1 - wr);
  if (edge <= 0) return 1;
  const ratio = (1 - edge) / (1 + edge);
  return Math.pow(Math.max(0, Math.min(1, ratio)), tries);
}

// ── Higher moments + Deflated Sharpe (Wave 1) ───────────────────────

/**
 * Sample skewness of a return series. Returns 0 when n < 3 or stdev = 0.
 */
export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  let acc = 0;
  for (const x of xs) acc += Math.pow((x - m) / s, 3);
  return (n / ((n - 1) * (n - 2))) * acc;
}

/**
 * Sample excess kurtosis (Fisher definition; normal distribution → ~0).
 */
export function kurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  let acc = 0;
  for (const x of xs) acc += Math.pow((x - m) / s, 4);
  const term1 = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3));
  const term2 = (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return term1 * acc - term2;
}

/**
 * Standard normal CDF — Abramowitz & Stegun 7.1.26 approximation.
 * |error| < 7.5e-8 over the whole real line (verified in tests against
 * erf-based reference values).
 */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** Return `fallback` when `x` is NaN or infinite. */
function finite(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/**
 * Expected maximum of N i.i.d. standard normals.
 *
 * Computed from the positive and negative tails of the maximum's CDF. The
 * tail beyond 10 is negligible for any practical N, so the result is
 * deterministic and finite.
 * For N ≤ 1 there is no multiple-testing correction, so the threshold is 0.
 */
function expectedMaxNormalZ(N: number): number {
  if (N <= 1) return 0;
  const upper = 10;
  const steps = 4000;
  const h = upper / steps;
  const f = (x: number) => 1 - Math.pow(normalCdf(x), N) - Math.pow(normalCdf(-x), N);
  let sum = 0.5 * (f(0) + f(upper));
  for (let i = 1; i < steps; i++) sum += f(i * h);
  return sum * h;
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, 2014).
 *
 * Probability that the observed Sharpe exceeds the multiple-testing-aware
 * threshold given `numTrials`, with non-Gaussian (skew/kurtosis) adjustment.
 * Returns a probability in [0, 1].
 *
 * Numerical notes:
 * - All Sharpe calculations are done on a per-period basis and then compared
 *   to a threshold measured in the same per-period units.
 * - The null threshold SR* is the expected maximum of `numTrials`
 *   standard normals scaled by the null Sharpe standard error (1/√(n-1)).
 *   For a single trial (N = 1) this threshold is exactly 0.
 * - The standard error of the *estimated* Sharpe uses the raw fourth moment,
 *   i.e. `kurtosis(rets) + 3`, with clamping to keep the expression finite.
 *
 * Use as a tie-breaker when comparing many strategy variants — high SR
 * with many trials degrades to ~0 if it's multiple-testing luck.
 *
 * @param dailyRets daily returns as decimals (e.g. 0.01 = 1%)
 * @param numTrials number of strategy variants tested (sets the bar)
 * @param periodsPerYear annualisation factor (252 for daily stocks)
 */
export function deflatedSharpe(
  dailyRets: number[],
  numTrials: number,
  periodsPerYear = 252,
): number {
  const n = dailyRets.length;
  if (n < 30 || numTrials < 1 || !Number.isFinite(numTrials)) return 0;
  if (stdev(dailyRets) < 1e-12) return 0;

  const srPerPeriod = sharpe(dailyRets, 0, periodsPerYear) / Math.sqrt(periodsPerYear);
  const sk = finite(skewness(dailyRets), 0);
  // Standard error formula needs the *raw* fourth moment.
  const rawK = Math.max(1, finite(kurtosis(dailyRets), 0) + 3);

  // Null Sharpe standard error per period when true SR = 0.
  const seNull = 1 / Math.sqrt(n - 1);
  const srStar = expectedMaxNormalZ(numTrials) * seNull;

  // Non-null standard error of the estimated Sharpe ratio.
  const V =
    (1 - sk * srPerPeriod + ((rawK - 1) / 4) * srPerPeriod * srPerPeriod) /
    (n - 1);
  const seSr = Math.sqrt(Math.max(1e-12, V));
  if (!Number.isFinite(seSr) || seSr === 0) return 0;

  const z = (srPerPeriod - srStar) / seSr;
  if (!Number.isFinite(z)) return srPerPeriod > srStar ? 1 : 0;
  return Math.max(0, Math.min(1, normalCdf(z)));
}

// ── PSR / DSR / smart Sharpe (Wave 2) ───────────────────────────────

/**
 * Inverse standard normal CDF (quantile) — Peter Acklam's rational
 * approximation. Relative |error| < 1.15e-9 (verified in tests against
 * published quantiles, e.g. Φ⁻¹(0.975) = 1.959963985).
 *
 * Degenerate inputs are explicit, never silent NaN:
 *   p ≤ 0 → -Infinity, p ≥ 1 → +Infinity (the mathematical limits),
 *   non-finite p → NaN. Internal callers guard p into (0, 1).
 */
export function normalInv(p: number): number {
  if (!Number.isFinite(p)) return NaN;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Probabilistic Sharpe Ratio (Bailey & López de Prado 2012; same formula
 * as quantstats stats.py `probabilistic_ratio`): probability that the TRUE
 * Sharpe exceeds `srBenchmark`, given estimation noise from a finite,
 * possibly skewed/fat-tailed sample.
 *
 *   σ_SR = sqrt( (1 + 0.5·SR² − skew·SR + (κ_excess/4)·SR²) / (n−1) )
 *   PSR  = Φ( (SR − SR_benchmark) / σ_SR )
 *
 * UNITS: everything is PER-PERIOD (non-annualized). Pass the observed
 * return series raw; to test against an annualized benchmark divide it by
 * √periodsPerYear first. KURTOSIS CONVENTION: the paper writes (κ−3) with
 * κ non-excess; our `kurtosis()` returns EXCESS kurtosis, so it is used
 * directly — do not subtract 3 again.
 *
 * Degenerate cases (documented, never NaN/Infinity):
 *   n < 2 or stdev = 0 (incl. all-equal returns) → 0 ("no evidence"),
 *   σ_SR² ≤ 0 (pathological skew) → clamped to 1e-12, saturating to 0/1.
 */
export function probabilisticSharpe(rets: number[], srBenchmark = 0): number {
  const n = rets.length;
  if (n < 2 || !Number.isFinite(srBenchmark)) return 0;
  const sd = stdev(rets);
  if (sd < 1e-12) return 0;
  const sr = mean(rets) / sd; // per-period Sharpe
  const sk = finite(skewness(rets), 0);
  const exK = finite(kurtosis(rets), 0); // excess kurtosis (normal → 0)
  const v = (1 + 0.5 * sr * sr - sk * sr + (exK / 4) * sr * sr) / (n - 1);
  const sigmaSr = Math.sqrt(Math.max(1e-12, v));
  const z = (sr - srBenchmark) / sigmaSr;
  if (!Number.isFinite(z)) return sr > srBenchmark ? 1 : 0;
  return Math.max(0, Math.min(1, normalCdf(z)));
}

/** Euler–Mascheroni constant, used by the expected-maximum formula. */
const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014): PSR against the
 * Sharpe you'd expect the BEST of `numTrials` configurations to show by
 * pure luck. The null threshold is the expected maximum of N draws:
 *
 *   SR*₀ = sqrt(Var[SR_n]) · [ (1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e)) ]
 *
 * UNITS: `varTrialSharpes` is the variance of the PER-PERIOD (non-
 * annualized) Sharpe estimates across trials. Annualized trial Sharpes?
 * Divide their variance by periodsPerYear first.
 *
 * VALIDATION NOTE: no published worked example with a verifiable repo path
 * was found for the full DSR; the SR*₀ expected-maximum term is instead
 * cross-validated in tests against an independent numerical integration of
 * E[max of N standard normals] (agrees within ~3% for N ≥ 10, the known
 * accuracy of the paper's asymptotic approximation), and DSR itself is
 * pinned by invariants (N=1 ⇒ PSR, monotone non-increasing in N and Var).
 *
 * Degenerate cases: numTrials ≤ 1 or Var ≤ 0 or non-finite → no deflation
 * possible → plain PSR vs 0 (documented fallback, never NaN).
 */
export function deflatedSharpeRatio(
  rets: number[],
  numTrials: number,
  varTrialSharpes: number,
): number {
  if (!Number.isFinite(numTrials) || numTrials <= 1 ||
      !Number.isFinite(varTrialSharpes) || varTrialSharpes <= 0) {
    return probabilisticSharpe(rets, 0);
  }
  const g = EULER_MASCHERONI;
  const srStar = Math.sqrt(varTrialSharpes) *
    ((1 - g) * normalInv(1 - 1 / numTrials) + g * normalInv(1 - 1 / (numTrials * Math.E)));
  return probabilisticSharpe(rets, srStar);
}

/**
 * Autocorrelation penalty on volatility (jesse-ai/jesse
 * services/metrics.py `autocorr_penalty`, itself from quantstats):
 *
 *   ρ = |corr(rets[0..n−2], rets[1..n−1])|   (lag-1, absolute value)
 *   penalty = sqrt( 1 + 2·Σ_{x=1}^{n−1} ((n−x)/n)·ρˣ )
 *
 * ≥ 1 always. Serially-correlated returns (multi-day holds) understate
 * the stdev of the aggregated return, inflating √periodsPerYear-annualized
 * Sharpe; dividing by this penalty corrects it. |·| means mean-reverting
 * (negative-ρ) series are also penalized — that matches the reference.
 *
 * Degenerate cases: n < 3, or either lagged slice constant (corr
 * undefined) → 1 (no penalty, never NaN).
 */
export function autocorrPenalty(rets: number[]): number {
  const n = rets.length;
  if (n < 3) return 1;
  const x = rets.slice(0, -1);
  const y = rets.slice(1);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) * (x[i] - mx);
    syy += (y[i] - my) * (y[i] - my);
  }
  if (sxx < 1e-24 || syy < 1e-24) return 1;
  const coef = Math.min(1, Math.abs(sxy / Math.sqrt(sxx * syy)));
  let sum = 0;
  let pow = 1;
  for (let lag = 1; lag < n; lag++) {
    pow *= coef;
    if (pow < 1e-16) break; // geometric tail is negligible
    sum += ((n - lag) / n) * pow;
  }
  return Math.sqrt(1 + 2 * sum);
}

/**
 * Sharpe with the autocorrelation penalty applied to the denominator
 * (quantstats/jesse `sharpe(..., smart=True)`). Use this — not plain
 * `sharpe` — for strategies holding positions multiple days: their daily
 * returns are serially correlated and the naive √252 annualization is
 * biased high. smartSharpe ≤ sharpe in magnitude, equality iff ρ = 0.
 *
 * Degenerate cases inherit from `sharpe`: n < 2 or stdev = 0 → 0.
 */
export function smartSharpe(rets: number[], rf = 0, periodsPerYear = 252): number {
  return sharpe(rets, rf, periodsPerYear) / autocorrPenalty(rets);
}

// ── Compound utilities ─────────────────────────────────────────────

/**
 * Compute a comprehensive metric bundle from a daily-return series.
 * Used by TearSheet + Telegram.
 */
export interface MetricBundle {
  // Returns
  cumReturn: number;       // total cumulative return as fraction
  cagr: number;            // annualised
  volatility: number;      // annualised stdev
  // Risk-adjusted
  sharpe: number;
  sortino: number;
  calmar: number;
  omega: number;
  /** Wave 1 (Bailey & López de Prado 2014): probability the SR is real
   *  given multiple-testing bias. Range [0,1]. 0 when n < 30. */
  deflatedSharpe: number;
  // Tail
  tailRatio: number;
  var95: number;           // negative number
  cvar95: number;          // negative number
  // Drawdown
  maxDrawdown: number;     // negative number, e.g. -0.15
  avgDrawdown: number;
  ulcerIndex: number;
  recoveryFactor: number;
  // Sample size
  periods: number;
}

export function computeMetricBundle(
  dailyRets: number[],
  rfRate = 0,
  periodsPerYear = 252,
  numTrials = 1,
): MetricBundle {
  return {
    cumReturn: cumulativeReturn(dailyRets),
    cagr: cagr(dailyRets, periodsPerYear),
    volatility: volatility(dailyRets, periodsPerYear),
    sharpe: sharpe(dailyRets, rfRate, periodsPerYear),
    sortino: sortino(dailyRets, rfRate, periodsPerYear),
    calmar: calmar(dailyRets, periodsPerYear),
    omega: omega(dailyRets, 0),
    deflatedSharpe: deflatedSharpe(dailyRets, numTrials, periodsPerYear),
    tailRatio: tailRatio(dailyRets),
    var95: valueAtRisk(dailyRets, 0.05),
    cvar95: conditionalVaR(dailyRets, 0.05),
    maxDrawdown: maxDrawdown(dailyRets),
    avgDrawdown: avgDrawdown(dailyRets),
    ulcerIndex: ulcerIndex(dailyRets),
    recoveryFactor: recoveryFactor(dailyRets),
    periods: dailyRets.length,
  };
}
