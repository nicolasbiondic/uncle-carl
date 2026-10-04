/**
 * Sequence-risk Monte Carlo (Jesse pattern, 2026-09 open-source review
 * proposal 2): a point Sharpe/maxDD says nothing about how sensitive the
 * result is to the ORDER in which returns/trades arrived. Two methods over
 * the stitched outer-OOS chain, both deterministic (fixed seed, own PRNG —
 * never Math.random):
 *
 *   1. Moving-block bootstrap of the DAILY returns (default 10-day blocks):
 *      resamples the return series preserving short-range autocorrelation,
 *      giving a distribution of final return and max drawdown under
 *      alternative orderings/samplings of the same daily edge.
 *   2. Reshuffle of the CLOSED TRADES' P&L in the order they closed
 *      (Jesse's "trades reshuffle"): permutes the additive $P&L sequence
 *      over the starting equity. The final return is permutation-invariant;
 *      what moves is the DRAWDOWN — pure sequence risk.
 *
 * For each method: p5/p50/p95 of maxDD (and of final return for the
 * bootstrap), plus the percentile of the OBSERVED maxDD inside its own
 * simulated distribution (1.0 = the realized ordering was worse than every
 * simulated path — Jesse's replica flagged exactly this: "el DD real fue
 * peor que el 97.5% de los reordenamientos").
 *
 * PURE module: no I/O, no imports beyond types. Consumed by
 * scripts/walk-forward.ts (summary.sequenceRisk + the optional
 * maxSequenceDdP95 / maxObservedDdPercentile acceptance gates),
 * scripts/sequence-risk.ts (CLI over existing artifacts) and
 * scripts/tearsheet.ts (Monte Carlo bands).
 */

export interface QuantileTriple {
  p5: number;
  p50: number;
  p95: number;
}

export interface BlockBootstrapReport {
  method: "blockBootstrap";
  paths: number;
  blockSize: number;
  seed: number;
  /** Daily observations resampled. */
  observations: number;
  maxDrawdown: QuantileTriple;
  finalReturn: QuantileTriple;
  /** maxDD of the ACTUAL daily-return sequence (daily resolution — same
   *  resolution as the simulated paths, so the percentile is apples to
   *  apples; the protocol's tick-resolution stitched maxDD can be higher). */
  observedMaxDrawdown: number;
  observedFinalReturn: number;
  /** Fraction of simulated paths whose maxDD ≤ observed (1.0 = observed
   *  worse than every path). */
  observedMaxDdPercentile: number;
}

export interface TradeReshuffleReport {
  method: "tradeReshuffle";
  paths: number;
  seed: number;
  trades: number;
  maxDrawdown: QuantileTriple;
  /** Permutation-invariant: identical for every path by construction. */
  finalReturn: number;
  /** maxDD of the trade-resolution equity path in the ACTUAL close order. */
  observedMaxDrawdown: number;
  observedMaxDdPercentile: number;
}

export interface SequenceRiskSummary {
  /** Absent when the daily series is too short (< MIN_BOOTSTRAP_OBS). */
  bootstrap?: BlockBootstrapReport;
  /** Absent when there are too few closed trades (< MIN_RESHUFFLE_TRADES). */
  tradeReshuffle?: TradeReshuffleReport;
  /** Gate input for maxObservedDdPercentile: the WORST (max) observed-DD
   *  percentile across the methods that could run — conservative: either
   *  method flagging an anomalously bad realized sequence fails the gate.
   *  Absent when neither method could run (gates then fail closed). */
  observedMaxDdPercentile?: number;
}

export const SEQUENCE_RISK_DEFAULTS = {
  blockSize: 10,
  paths: 2000,
  seed: 20260926,
} as const;

/** Below these, the distributions are too degenerate to gate on. */
export const MIN_BOOTSTRAP_OBS = 30;
export const MIN_RESHUFFLE_TRADES = 10;

/** Deterministic 32-bit PRNG (mulberry32) — uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolation quantile of an ASCENDING-sorted array, q in [0, 1]. */
export function quantileSorted(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (pos - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

function triple(sortedAsc: number[]): QuantileTriple {
  return {
    p5: quantileSorted(sortedAsc, 0.05),
    p50: quantileSorted(sortedAsc, 0.5),
    p95: quantileSorted(sortedAsc, 0.95),
  };
}

/** Fraction of `sortedAsc` values ≤ observed (empirical CDF). */
function percentileOf(sortedAsc: number[], observed: number): number {
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] <= observed) lo = mid + 1;
    else hi = mid;
  }
  return lo / sortedAsc.length;
}

/** Max drawdown of a compounded daily-return sequence (fraction of peak). */
export function maxDrawdownFromReturns(rets: number[]): number {
  let eq = 1, peak = 1, dd = 0;
  for (const r of rets) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const cur = (peak - eq) / peak;
    if (cur > dd) dd = cur;
  }
  return dd;
}

/** Max drawdown of the additive equity path E0 + cumsum(pnls). A path that
 *  reaches ≤ 0 equity is a full drawdown (1). */
export function maxDrawdownFromPnl(pnls: number[], initialEquity: number): number {
  let eq = initialEquity, peak = initialEquity, dd = 0;
  for (const p of pnls) {
    eq += p;
    if (eq <= 0) return 1;
    if (eq > peak) peak = eq;
    const cur = (peak - eq) / peak;
    if (cur > dd) dd = cur;
  }
  return dd;
}

export interface SequenceRiskOptions {
  blockSize?: number;
  paths?: number;
  seed?: number;
}

/**
 * Moving-block bootstrap of a daily-return series: each path concatenates
 * uniformly-drawn contiguous blocks of `blockSize` days until it reaches the
 * original length (trimmed). Deterministic for a given (series, options).
 */
export function blockBootstrap(
  dailyRets: number[],
  opts: SequenceRiskOptions = {},
): BlockBootstrapReport | undefined {
  const blockSize = opts.blockSize ?? SEQUENCE_RISK_DEFAULTS.blockSize;
  const paths = opts.paths ?? SEQUENCE_RISK_DEFAULTS.paths;
  const seed = opts.seed ?? SEQUENCE_RISK_DEFAULTS.seed;
  const n = dailyRets.length;
  if (n < Math.max(MIN_BOOTSTRAP_OBS, blockSize + 1)) return undefined;
  const rand = mulberry32(seed);
  const maxStart = n - blockSize; // inclusive upper bound for block starts
  const dds: number[] = new Array(paths);
  const finals: number[] = new Array(paths);
  for (let p = 0; p < paths; p++) {
    let eq = 1, peak = 1, dd = 0, count = 0;
    while (count < n) {
      const start = Math.floor(rand() * (maxStart + 1));
      const take = Math.min(blockSize, n - count);
      for (let i = 0; i < take; i++) {
        eq *= 1 + dailyRets[start + i];
        if (eq > peak) peak = eq;
        const cur = (peak - eq) / peak;
        if (cur > dd) dd = cur;
      }
      count += take;
    }
    dds[p] = dd;
    finals[p] = eq - 1;
  }
  dds.sort((a, b) => a - b);
  finals.sort((a, b) => a - b);
  const observedMaxDrawdown = maxDrawdownFromReturns(dailyRets);
  let observedFinalReturn = 1;
  for (const r of dailyRets) observedFinalReturn *= 1 + r;
  return {
    method: "blockBootstrap",
    paths,
    blockSize,
    seed,
    observations: n,
    maxDrawdown: triple(dds),
    finalReturn: triple(finals),
    observedMaxDrawdown,
    observedFinalReturn: observedFinalReturn - 1,
    observedMaxDdPercentile: percentileOf(dds, observedMaxDrawdown),
  };
}

/**
 * Reshuffle of the closed trades' $P&L (in close order) over the starting
 * equity — Jesse's "trades reshuffle". Fisher–Yates with the seeded PRNG.
 */
export function tradeReshuffle(
  pnlsInCloseOrder: number[],
  initialEquity: number,
  opts: SequenceRiskOptions = {},
): TradeReshuffleReport | undefined {
  const paths = opts.paths ?? SEQUENCE_RISK_DEFAULTS.paths;
  const seed = opts.seed ?? SEQUENCE_RISK_DEFAULTS.seed;
  const n = pnlsInCloseOrder.length;
  if (n < MIN_RESHUFFLE_TRADES || !(initialEquity > 0)) return undefined;
  const rand = mulberry32(seed + 1); // decorrelate from the bootstrap stream
  const work = [...pnlsInCloseOrder];
  const dds: number[] = new Array(paths);
  for (let p = 0; p < paths; p++) {
    for (let i = work.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = work[i];
      work[i] = work[j];
      work[j] = tmp;
    }
    dds[p] = maxDrawdownFromPnl(work, initialEquity);
  }
  dds.sort((a, b) => a - b);
  const observedMaxDrawdown = maxDrawdownFromPnl(pnlsInCloseOrder, initialEquity);
  const totalPnl = pnlsInCloseOrder.reduce((s, x) => s + x, 0);
  return {
    method: "tradeReshuffle",
    paths,
    seed,
    trades: n,
    maxDrawdown: triple(dds),
    finalReturn: totalPnl / initialEquity,
    observedMaxDrawdown,
    observedMaxDdPercentile: percentileOf(dds, observedMaxDrawdown),
  };
}

/**
 * Both methods over a stitched OOS chain. Either can be absent on short
 * evidence; `observedMaxDdPercentile` is the max across the methods that
 * ran (see SequenceRiskSummary docs).
 */
export function computeSequenceRisk(
  dailyRets: number[],
  tradePnlsInCloseOrder: number[],
  initialEquity: number,
  opts: SequenceRiskOptions = {},
): SequenceRiskSummary {
  const bootstrap = blockBootstrap(dailyRets, opts);
  const reshuffle = tradeReshuffle(tradePnlsInCloseOrder, initialEquity, opts);
  const percentiles = [bootstrap?.observedMaxDdPercentile, reshuffle?.observedMaxDdPercentile]
    .filter((x): x is number => x !== undefined);
  return {
    ...(bootstrap ? { bootstrap } : {}),
    ...(reshuffle ? { tradeReshuffle: reshuffle } : {}),
    ...(percentiles.length > 0 ? { observedMaxDdPercentile: Math.max(...percentiles) } : {}),
  };
}

/**
 * Per-day quantile band of bootstrapped cumulative equity (normalized to 1)
 * — the tearsheet's Monte Carlo fan. Same resampling scheme and PRNG as
 * blockBootstrap (but its own stream); deterministic for fixed options.
 * Returns one {p5,p50,p95} per day, or undefined on short series.
 */
export function bootstrapEquityBand(
  dailyRets: number[],
  opts: SequenceRiskOptions = {},
): QuantileTriple[] | undefined {
  const blockSize = opts.blockSize ?? SEQUENCE_RISK_DEFAULTS.blockSize;
  const paths = opts.paths ?? SEQUENCE_RISK_DEFAULTS.paths;
  const seed = opts.seed ?? SEQUENCE_RISK_DEFAULTS.seed;
  const n = dailyRets.length;
  if (n < Math.max(MIN_BOOTSTRAP_OBS, blockSize + 1)) return undefined;
  const rand = mulberry32(seed + 2);
  const maxStart = n - blockSize;
  // paths × n floats — bounded (2000 × a few thousand days) and transient.
  const perDay: Float64Array[] = Array.from({ length: n }, () => new Float64Array(paths));
  for (let p = 0; p < paths; p++) {
    let eq = 1, count = 0;
    while (count < n) {
      const start = Math.floor(rand() * (maxStart + 1));
      const take = Math.min(blockSize, n - count);
      for (let i = 0; i < take; i++) {
        eq *= 1 + dailyRets[start + i];
        perDay[count + i][p] = eq;
      }
      count += take;
    }
  }
  return perDay.map(vals => {
    const sorted = [...vals].sort((a, b) => a - b);
    return {
      p5: quantileSorted(sorted, 0.05),
      p50: quantileSorted(sorted, 0.5),
      p95: quantileSorted(sorted, 0.95),
    };
  });
}
