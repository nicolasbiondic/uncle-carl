import type { DailyBar, FactorCoreConfig, PriceView, TrendSignalConfig } from "./types";

/** Central point-in-time guard; callers must provide completed, ordered bars. */
export function priceHistory(view: PriceView, symbol: string, n: number): readonly DailyBar[] {
  const bars = view.history(symbol, n);
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date > view.asOf || (i > 0 && bars[i].date <= bars[i - 1].date)) {
      throw new Error(`Invalid point-in-time history: ${symbol}`);
    }
    if (!Number.isFinite(bars[i].close) || bars[i].close <= 0) {
      throw new Error(`Invalid close: ${symbol}`);
    }
  }
  return bars;
}

export function dailyReturns(closes: readonly number[]): number[] {
  return closes.slice(1).map((close, i) => close / closes[i] - 1);
}

/** Sample standard deviation of simple daily returns (not annualized). */
export function sampleVol(returns: readonly number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1));
}

export function trailingVol(closes: readonly number[], lookback: number): number | null {
  if (closes.length < lookback + 1) return null;
  return sampleVol(dailyReturns(closes.slice(-(lookback + 1))));
}

export function trendSignal(closes: readonly number[], config: TrendSignalConfig, previous = false): {
  on: boolean; blend: number | null; sma: number | null;
} {
  const needed = Math.max(config.maLong, ...config.blendHorizons.map(h => h + 1));
  if (closes.length < needed || config.blendHorizons.length === 0) return { on: false, blend: null, sma: null };
  const last = closes[closes.length - 1];
  const blend = config.blendHorizons.reduce((sum, h) => sum + last / closes[closes.length - 1 - h] - 1, 0)
    / config.blendHorizons.length;
  const sma = closes.slice(-config.maLong).reduce((a, b) => a + b, 0) / config.maLong;
  const band = config.signalBandPct / 100;
  // A decimal boundary (101/100 - 1 versus .01) must not flip hysteresis
  // solely because division/subtraction rounded a few machine epsilons.
  const epsilon = 8 * Number.EPSILON * Math.max(1, Math.abs(blend), band);
  const on = last <= sma || blend < -band - epsilon ? false : blend > band + epsilon ? true : previous;
  return { on, blend, sma };
}

/** [long, skip]: excludes the most recent `skip` returns. */
export function momentumReturn(closes: readonly number[], window: readonly [number, number]): number | null {
  const [long, skip] = window;
  if (long <= skip || skip < 0 || closes.length < long + 1) return null;
  return closes[closes.length - 1 - skip] / closes[closes.length - 1 - long] - 1;
}

export function lowVolScore(closes: readonly number[], lookback: number): number | null {
  const vol = trailingVol(closes, lookback);
  return vol === null ? null : -vol;
}

/** Larger is better. Equal scores receive equal average ranks, independent of input order. */
export function rankScores(scores: Readonly<Record<string, number>>): Record<string, number> {
  const symbols = Object.keys(scores).filter(s => Number.isFinite(scores[s]))
    .sort((a, b) => scores[a] - scores[b] || compareSymbols(a, b));
  const ranks: Record<string, number> = {};
  for (let start = 0; start < symbols.length;) {
    let end = start + 1;
    while (end < symbols.length && scores[symbols[end]] === scores[symbols[start]]) end++;
    for (let i = start; i < end; i++) ranks[symbols[i]] = (start + end - 1) / 2 + 1;
    start = end;
  }
  return ranks;
}

/** Code-point ordering rather than host-dependent localeCompare. */
export function compareSymbols(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function overlaySignal(closes: readonly number[], config: FactorCoreConfig["overlay"], previous = false): {
  on: boolean; exposure: number; sma: number | null;
} {
  if (!config) return { on: true, exposure: 1, sma: null };
  if (closes.length < config.ma) return { on: previous, exposure: previous ? config.onExposure : config.offExposure, sma: null };
  const sma = closes.slice(-config.ma).reduce((a, b) => a + b, 0) / config.ma;
  const close = closes[closes.length - 1];
  const on = close > sma * (1 + config.bandPct / 100) ? true
    : close < sma * (1 - config.bandPct / 100) ? false : previous;
  return { on, exposure: on ? config.onExposure : config.offExposure, sma };
}
