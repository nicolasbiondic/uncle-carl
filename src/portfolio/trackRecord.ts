// ══════════════════════════════════════════════
// Minimum Track Record Length + Probabilistic Sharpe Ratio
// (Bailey & López de Prado, "The Sharpe Ratio Efficient Frontier", 2012)
//
// The instrument that converts "the sleeve lost $4,806" into "the sleeve
// has 8 of the ~N observations needed for its Sharpe to be statistically
// distinguishable from zero". Pure measurement — no allocation decisions.
//
//   PSR(SR*) = Z[ (SR̂ − SR*)·√(n−1) / √(1 − γ₃·SR̂ + ((γ₄−1)/4)·SR̂²) ]
//   MinTRL   = 1 + [1 − γ₃·SR̂ + ((γ₄−1)/4)·SR̂²] · (Z_α / (SR̂ − SR*))²
//
// with Z = standard normal CDF, γ₃ = skew, γ₄ = kurtosis (NOT excess),
// SR̂ = observed Sharpe PER OBSERVATION (never annualized inside these
// formulas — annualization is presentation only), SR* = benchmark Sharpe,
// Z_α = normal quantile for the confidence level (95% → 1.645).
//
// KEY LIMITATION (do not oversell this number): MinTRL treats the OBSERVED
// Sharpe/skew/kurtosis as the true ones. It answers "if the process keeps
// producing exactly these statistics, how long until the estimate clears
// SR* at this confidence" — an OPTIMISTIC MINIMUM, not a guarantee. With
// few observations the inputs themselves are noise; that is why every
// output here carries n, PSR and the missing-observation count TOGETHER —
// a Sharpe printed alone is misinformation.
// ══════════════════════════════════════════════

import { getDailySleeveReturns, type SleeveReturnOptions, type ReturnGap } from "./sleeveReturns";
import { ALL_PROFILE_IDS, RISK_PROFILES } from "../config/riskProfiles";

// ── Normal distribution helpers ──────────────────────────────────────────

/** Standard normal CDF via Abramowitz–Stegun 7.1.26 erf (|ε| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Standard normal inverse CDF (Acklam's algorithm, |ε| < 1.15e-9). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`normInv: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// ── Core formulas (pure, per-observation units) ──────────────────────────

/** Non-normality adjustment term shared by PSR and MinTRL:
 *  1 − γ₃·SR̂ + ((γ₄−1)/4)·SR̂². γ₄ is kurtosis, NOT excess (normal ⇒ 3). */
function adjustment(sr: number, skew: number, kurt: number): number {
  return 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
}

/**
 * Minimum track record length in OBSERVATIONS. Returns null (= infinite /
 * undefined) when sr ≤ srStar: you cannot accumulate evidence for an edge
 * you are not observing — explicit, never a division by zero or NaN.
 */
export function minTrlObservations(sr: number, srStar: number, skew: number, kurt: number, zAlpha: number): number | null {
  if (!(sr > srStar)) return null;
  const adj = adjustment(sr, skew, kurt);
  if (adj <= 0) return null; // pathological moments — the Gaussian expansion itself broke down
  return 1 + adj * Math.pow(zAlpha / (sr - srStar), 2);
}

/** PSR(SR*): probability the true Sharpe exceeds srStar given n observations. */
export function probabilisticSharpe(sr: number, srStar: number, n: number, skew: number, kurt: number): number | null {
  if (n < 2) return null;
  const adj = adjustment(sr, skew, kurt);
  if (adj <= 0) return null;
  return normCdf((sr - srStar) * Math.sqrt(n - 1) / Math.sqrt(adj));
}

// ── Track record from a return series ────────────────────────────────────

export type TrackRecordStatus =
  | "no_data"                       // n = 0
  | "insufficient_observations"     // n below even the Sharpe-reporting floor
  | "zero_variance"                 // sd = 0 — Sharpe undefined
  | "sharpe_not_above_benchmark"    // SR̂ ≤ SR*: MinTRL infinite/undefined
  | "insufficient_track_record"     // SR̂ > SR* but n < MinTRL
  | "track_record_sufficient";      // n ≥ MinTRL at the requested confidence

export interface TrackRecord {
  n: number;
  meanPerObs: number | null;
  sdPerObs: number | null;
  /** Estimated only when n ≥ minObsForMoments; otherwise null (we refuse to
   *  "estimate" skew/kurtosis from a handful of points) and the formulas
   *  fall back to Gaussian moments (γ₃=0, γ₄=3) — see momentsSource. */
  skew: number | null;
  kurtosis: number | null;
  momentsSource: "estimated" | "gaussian_assumed" | null;
  /** Observed Sharpe per observation — ALWAYS read together with psr and
   *  obsMissing; alone it is meaningless at small n. */
  sharpePerObs: number | null;
  sharpeAnnualized: number | null;
  /** PSR(SR*) — probability the true Sharpe exceeds srBenchmark. */
  psr: number | null;
  srBenchmarkPerObs: number;
  confidence: number;
  obsPerYear: number;
  /** MinTRL in observations; null = infinite/undefined (SR̂ ≤ SR*). */
  minTrlObs: number | null;
  obsNeeded: number | null;   // ceil(minTrlObs)
  obsMissing: number | null;  // max(0, obsNeeded − n)
  status: TrackRecordStatus;
}

export interface TrackRecordOptions {
  /** Benchmark Sharpe PER OBSERVATION (default 0: "any edge at all"). */
  srBenchmarkPerObs?: number;
  /** Confidence for MinTRL (default 0.95 → Z_α ≈ 1.645). */
  confidence?: number;
  /** Annualization factor for display only (default 252). */
  obsPerYear?: number;
  /** Below this n, skew/kurtosis are NOT estimated (default 30). */
  minObsForMoments?: number;
  /** Below this n, status is insufficient_observations regardless (default 10). */
  minObsForSharpe?: number;
}

export function computeTrackRecord(returns: number[], opts: TrackRecordOptions = {}): TrackRecord {
  const srStar = opts.srBenchmarkPerObs ?? 0;
  const confidence = opts.confidence ?? 0.95;
  const obsPerYear = opts.obsPerYear ?? 252;
  const minObsForMoments = opts.minObsForMoments ?? 30;
  const minObsForSharpe = opts.minObsForSharpe ?? 10;

  const n = returns.length;
  const empty: TrackRecord = {
    n, meanPerObs: null, sdPerObs: null, skew: null, kurtosis: null, momentsSource: null,
    sharpePerObs: null, sharpeAnnualized: null, psr: null,
    srBenchmarkPerObs: srStar, confidence, obsPerYear,
    minTrlObs: null, obsNeeded: null, obsMissing: null, status: "no_data",
  };
  if (n === 0) return empty;
  if (n < 2) return { ...empty, meanPerObs: returns[0], status: "insufficient_observations" };

  const mean = returns.reduce((s, x) => s + x, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of returns) {
    const d = x - mean;
    m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
  }
  const sd = Math.sqrt(m2 / (n - 1)); // sample sd
  m2 /= n; m3 /= n; m4 /= n;

  // Degenerate variance: exact zero, OR floating-point dust from a constant
  // series (mean of twelve 0.01s accumulates ~1e-18 of rounding noise — a
  // "Sharpe" of 10^16 from that noise would be the exact dishonesty this
  // module exists to prevent). Relative-to-mean and absolute floors.
  if (sd === 0 || sd < 1e-12 || sd < Math.abs(mean) * 1e-9) {
    return { ...empty, meanPerObs: mean, sdPerObs: 0, status: "zero_variance" };
  }

  // Moments: refuse to estimate 3rd/4th moments from a handful of points —
  // below the floor we SAY so (skew/kurtosis null, momentsSource
  // "gaussian_assumed") and use Gaussian values inside the formulas.
  const momentsEstimated = n >= minObsForMoments;
  const skewEst = momentsEstimated ? m3 / Math.pow(m2, 1.5) : null;
  const kurtEst = momentsEstimated ? m4 / (m2 * m2) : null;
  const skewUsed = skewEst ?? 0;
  const kurtUsed = kurtEst ?? 3;

  const sr = mean / sd;
  const zAlpha = normInv(confidence);
  const psr = probabilisticSharpe(sr, srStar, n, skewUsed, kurtUsed);
  const minTrl = minTrlObservations(sr, srStar, skewUsed, kurtUsed, zAlpha);
  const obsNeeded = minTrl != null ? Math.ceil(minTrl) : null;
  const obsMissing = obsNeeded != null ? Math.max(0, obsNeeded - n) : null;

  let status: TrackRecordStatus;
  if (n < minObsForSharpe) status = "insufficient_observations";
  else if (minTrl == null) status = "sharpe_not_above_benchmark";
  else if (n >= minTrl) status = "track_record_sufficient";
  else status = "insufficient_track_record";

  return {
    n, meanPerObs: mean, sdPerObs: sd,
    skew: skewEst, kurtosis: kurtEst,
    momentsSource: momentsEstimated ? "estimated" : "gaussian_assumed",
    sharpePerObs: sr, sharpeAnnualized: sr * Math.sqrt(obsPerYear),
    psr, srBenchmarkPerObs: srStar, confidence, obsPerYear,
    minTrlObs: minTrl, obsNeeded, obsMissing, status,
  };
}

// ── Per-sleeve composition (returns series → track record) ───────────────

export interface SleeveTrackRecord {
  profileId: string;
  label: string;
  /** Series metadata — honest context the Sharpe must never travel without. */
  series: {
    grid: "trading_days" | "calendar_days";
    obsPerYear: 252 | 365;
    equitySource: "ledger" | "broker_truth";
    nObservations: number;
    nDailyMarks: number;
    gaps: ReturnGap[];
    zeroReturnCount: number;
    firstDate: string | null;
    lastDate: string | null;
    mode: "live" | "shadow" | null;
    modeSince: number | null;
    lastSnapshotAt: number | null;
    seriesFresh: boolean;
    status: "ok" | "stale" | "no_data";
  };
  trackRecord: TrackRecord;
}

export function getSleeveTrackRecord(profileId: string, opts: SleeveReturnOptions = {}): SleeveTrackRecord {
  const s = getDailySleeveReturns(profileId, opts);
  const tr = computeTrackRecord(s.returns.map(r => r.ret), { obsPerYear: s.obsPerYear });
  return {
    profileId,
    label: RISK_PROFILES[profileId as keyof typeof RISK_PROFILES]?.label ?? profileId,
    series: {
      grid: s.grid, obsPerYear: s.obsPerYear, equitySource: s.equitySource,
      nObservations: s.nObservations, nDailyMarks: s.nDailyMarks,
      gaps: s.gaps, zeroReturnCount: s.zeroReturnCount,
      firstDate: s.returns[0]?.dateKey ?? null,
      lastDate: s.returns[s.returns.length - 1]?.dateKey ?? null,
      mode: s.mode, modeSince: s.modeSince,
      lastSnapshotAt: s.lastSnapshotAt, seriesFresh: s.seriesFresh, status: s.status,
    },
    trackRecord: tr,
  };
}

export function getAllSleeveTrackRecords(opts: SleeveReturnOptions = {}): SleeveTrackRecord[] {
  return ALL_PROFILE_IDS.map(id => getSleeveTrackRecord(id, opts));
}
