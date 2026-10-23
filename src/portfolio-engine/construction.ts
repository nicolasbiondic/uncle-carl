import type { DrawdownBrakeConfig, FactorCoreConfig, MembershipView, PriceView, SessionDate } from "./types";
import { compareSymbols, dailyReturns, lowVolScore, momentumReturn, priceHistory, rankScores } from "./signals";

export function inverseVolWeights(vols: Readonly<Record<string, number>>): Record<string, number> {
  const symbols = Object.keys(vols).filter(s => Number.isFinite(vols[s]) && vols[s] > 0).sort(compareSymbols);
  // Relative inverses avoid overflow for very small but positive volatilities.
  const min = symbols.reduce((v, s) => Math.min(v, vols[s]), Infinity);
  const total = symbols.reduce((sum, s) => sum + min / vols[s], 0);
  return Object.fromEntries(symbols.map(s => [s, (min / vols[s]) / total]));
}

export type Covariance = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** Sample DAILY covariance; each array must describe the SAME return dates. */
export function estimateCovariance(returns: Readonly<Record<string, readonly number[]>>): Covariance {
  const symbols = Object.keys(returns).sort(compareSymbols);
  const n = symbols.length ? returns[symbols[0]].length : 0;
  if (symbols.some(s => returns[s].length !== n)) throw new Error("Covariance requires aligned returns");
  const means = Object.fromEntries(symbols.map(s => [s, returns[s].reduce((a, b) => a + b, 0) / (n || 1)]));
  const result: Record<string, Record<string, number>> = {};
  for (const a of symbols) {
    result[a] = {};
    for (const b of symbols) {
      result[a][b] = n < 2 ? 0 : returns[a].reduce((sum, r, i) => sum + (r - means[a]) * (returns[b][i] - means[b]), 0) / (n - 1);
    }
  }
  return result;
}

/** Intersect return intervals, not array offsets: a missing session must not pair unrelated returns. */
export function covarianceFromPrices(view: PriceView, symbols: readonly string[], lookback: number): Covariance {
  const series = symbols.map(symbol => {
    const bars = priceHistory(view, symbol, lookback + 1);
    const returns = dailyReturns(bars.map(b => b.close));
    return new Map(returns.map((r, i) => [`${bars[i].date}/${bars[i + 1].date}`, r]));
  });
  const dates = series.length ? [...series[0].keys()].filter(d => series.every(s => s.has(d))) : [];
  return estimateCovariance(Object.fromEntries(symbols.map((s, i) => [s, dates.map(d => series[i].get(d)!)])));
}

export function portfolioVol(weights: Readonly<Record<string, number>>, covariance: Covariance, annualization: number): number {
  const symbols = Object.keys(weights).sort(compareSymbols);
  let variance = 0;
  for (const a of symbols) for (const b of symbols) variance += weights[a] * weights[b] * (covariance[a]?.[b] ?? 0);
  return Math.sqrt(Math.max(0, variance) * annualization);
}

/** D1/D3 order: normalize inverse vol → target-vol scale → per-asset clip →
 * proportional gross reduction. NO redistribution/releveraging after caps. */
export function scaleToVolTarget(
  vols: Readonly<Record<string, number>>, covariance: Covariance, annualization: number,
  target: number, perAssetCap: number, maxGross: number, fastCovariance?: Covariance,
): { weights: Record<string, number>; scale: number; uncappedVol: number; finalVol: number } {
  const base = inverseVolWeights(vols);
  // RW4b: with a fast covariance the risk the scale reacts to is the larger of the two estimates.
  const uncappedVol = fastCovariance
    ? Math.max(portfolioVol(base, covariance, annualization), portfolioVol(base, fastCovariance, annualization))
    : portfolioVol(base, covariance, annualization);
  // No estimable risk means no finite leverage estimate, not infinite leverage.
  const scale = uncappedVol > 0 ? target / uncappedVol : 0;
  const weights = Object.fromEntries(Object.keys(base).map(s => [s, Math.max(0, Math.min(perAssetCap, base[s] * scale))]));
  const gross = Object.values(weights).reduce((a, b) => a + b, 0);
  if (gross > maxGross) for (const s of Object.keys(weights)) weights[s] *= maxGross / gross;
  return { weights, scale, uncappedVol, finalVol: portfolioVol(weights, covariance, annualization) };
}

/** RW4b drawdown brake: 1 up to `startDrawdown`, linear down to `floorScale` at `maxDrawdown`, flat beyond.
 *  Pure function of the CURRENT drawdown, so it restores itself as the drawdown recovers. */
export function drawdownBrakeScale(drawdown: number, brake: DrawdownBrakeConfig): number {
  if (!(drawdown > brake.startDrawdown)) return 1;
  if (drawdown >= brake.maxDrawdown) return brake.floorScale;
  const progress = (drawdown - brake.startDrawdown) / (brake.maxDrawdown - brake.startDrawdown);
  return 1 - progress * (1 - brake.floorScale);
}

/** D2 water-filling: preserve relative inverse vols among uncapped names.
 * Exposure is exact when feasible; otherwise keep the unallocatable part in cash. */
export function cappedInverseVolWeights(vols: Readonly<Record<string, number>>, exposure: number, cap: number): Record<string, number> {
  const base = inverseVolWeights(vols);
  const result: Record<string, number> = {};
  let pending = Object.keys(base);
  let remaining = Math.min(Math.max(0, exposure), pending.length * Math.max(0, cap));
  while (pending.length) {
    const total = pending.reduce((sum, s) => sum + base[s], 0);
    const capped = pending.filter(s => remaining * base[s] / total > cap);
    if (!capped.length) {
      for (const s of pending) result[s] = remaining * base[s] / total;
      break;
    }
    for (const s of capped) { result[s] = cap; remaining -= cap; }
    const done = new Set(capped);
    pending = pending.filter(s => !done.has(s));
  }
  return result;
}

/** Membership effective at the execution open may differ from the previous
 * close (index additions/removals). Only membership uses that session; all
 * scores, price and history guards still use the completed PriceView. */
export function selectCoreMembers(view: PriceView, membership: MembershipView, config: FactorCoreConfig, membershipSession: SessionDate = view.asOf): {
  members: string[]; scores: Record<string, number>;
} {
  const excluded = new Set(config.exclude);
  const momentum: Record<string, number> = {};
  const lowvol: Record<string, number> = {};
  const needed = Math.max(config.momentumWindow[0] + 1, config.volWindow + 1);
  for (const s of [...new Set(membership.members(membershipSession))].sort(compareSymbols)) {
    // The asOf close counts as a prior close relative to next-session execution.
    if (excluded.has(s) || view.barCount(s) < config.minPriorCloses) continue;
    const closes = priceHistory(view, s, needed).map(b => b.close);
    if (!closes.length || closes[closes.length - 1] < config.minPrice) continue;
    const mom = momentumReturn(closes, config.momentumWindow);
    const lv = lowVolScore(closes, config.volWindow);
    if ((config.score !== "lowvol" && mom === null) || (config.score !== "momentum" && lv === null)) continue;
    if (mom !== null) momentum[s] = mom;
    if (lv !== null) lowvol[s] = lv;
  }
  const mr = rankScores(momentum), vr = rankScores(lowvol);
  const scores = config.score === "momentum" ? momentum : config.score === "lowvol" ? lowvol
    : Object.fromEntries(Object.keys(momentum).filter(s => s in lowvol).map(s => [s, mr[s] + vr[s]]));
  return { members: Object.keys(scores).sort((a, b) => scores[b] - scores[a] || compareSymbols(a, b)).slice(0, config.topN), scores };
}
