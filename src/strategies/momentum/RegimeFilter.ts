// ══════════════════════════════════════════════
// Regime Filter (v7.0 — "Momentum Edge")
// ══════════════════════════════════════════════
//
// Momentum strategies break in three documented market regimes:
//   1. Volatility spikes (3x+ normal): trends become whipsaws.
//   2. Correlation collapse (everything moves the same way): no
//      cross-sectional dispersion to exploit.
//   3. Mean-reverting markets: momentum literally inverts.
//
// This filter outputs a boolean "tradeable" plus a reason. The orchestrator
// uses it to decide whether to enter new positions. Existing positions are
// NOT closed by the regime filter — they're managed by RiskGuard's stops.
//
// Design rationale: the cost of NOT trading during a hostile regime is
// assumed far lower than the cost of trading through one — but the
// thresholds below (volSpikeMultiplier 2.5, correlationCeiling 0.85) are
// declared constants, never validated by the walk-forward protocol (a
// "+30% Sharpe 2018-2024" claim used to live here with NO artifact behind
// it). Both live in RegimeFilterConfig — sweepable via manifest since
// 2026-09-07 — and `enabled: false` bypasses the filter entirely.

import type { OHLCV } from "../../utils/types";

export interface RegimeFilterConfig {
  /**
   * OPT-OUT master switch. Default true (undefined = enabled — byte-identical
   * legacy behavior). false → assess() returns tradeable=true without
   * evaluating anything: the sleeve trades as if no regime filter existed.
   */
  enabled?: boolean;
  /**
   * Bar length in minutes. Default 5.
   */
  barMinutes: number;
  /**
   * Window for "current" volatility estimate (returns std). Default 24h.
   */
  shortWindowHours: number;
  /**
   * Window for "baseline" volatility. Default 30 days.
   */
  longWindowDays: number;
  /**
   * Multiplier above baseline that flags a vol spike. Default 2.5.
   */
  volSpikeMultiplier: number;
  /**
   * If average pairwise correlation in the universe exceeds this, we treat
   * the market as risk-on/off binary state and disable cross-sectional
   * momentum (no dispersion to exploit). Default 0.85.
   */
  correlationCeiling: number;
  /**
   * Minimum number of symbols with usable history before the filter has
   * any opinion. Below this it returns tradeable=true (insufficient data
   * to claim a regime).
   */
  minSymbolsForCorrelation: number;
}

export const DEFAULT_REGIME_CONFIG: RegimeFilterConfig = {
  barMinutes: 5,
  shortWindowHours: 24,
  longWindowDays: 30,
  volSpikeMultiplier: 2.5,
  correlationCeiling: 0.85,
  minSymbolsForCorrelation: 4,
};

export interface RegimeAssessment {
  tradeable: boolean;
  reason: string;
  details: {
    volRatio: number;          // current / baseline
    avgCorrelation: number;    // -1..1
    universeSize: number;
  };
}

export class RegimeFilter {
  private cfg: RegimeFilterConfig;

  constructor(cfg: Partial<RegimeFilterConfig> = {}) {
    this.cfg = { ...DEFAULT_REGIME_CONFIG, ...cfg };
  }

  assess(candlesBySymbol: Map<string, OHLCV[]>): RegimeAssessment {
    if (this.cfg.enabled === false) {
      // Filter disabled: always tradeable, nothing evaluated. Neutral
      // details (volRatio 1, corr 0) — universeSize reports the input size
      // since usable-history filtering never ran.
      return {
        tradeable: true,
        reason: "regime filter disabled (enabled=false)",
        details: { volRatio: 1, avgCorrelation: 0, universeSize: candlesBySymbol.size },
      };
    }
    const shortBars = Math.floor(this.cfg.shortWindowHours * 60 / this.cfg.barMinutes);
    const longBars  = Math.floor(this.cfg.longWindowDays * 24 * 60 / this.cfg.barMinutes);

    // 1. Compute realized vol per symbol on both windows + log-returns array
    //    (returns array used for correlation in step 2).
    const returnsBySymbol: Map<string, number[]> = new Map();
    let volRatioSum = 0;
    let volRatioCount = 0;

    for (const [symbol, candles] of candlesBySymbol) {
      if (candles.length <= longBars) continue;
      const closes = candles.map(c => c.close);

      // Log-returns (more stable than simple returns).
      const rets: number[] = [];
      for (let i = 1; i < closes.length; i++) {
        if (closes[i - 1] <= 0) continue;
        rets.push(Math.log(closes[i] / closes[i - 1]));
      }
      if (rets.length <= longBars) continue;

      const longSlice  = rets.slice(-longBars);
      const shortSlice = rets.slice(-shortBars);
      const longStd  = std(longSlice);
      const shortStd = std(shortSlice);
      if (longStd <= 0) continue;

      volRatioSum += shortStd / longStd;
      volRatioCount++;
      returnsBySymbol.set(symbol, shortSlice);
    }

    const avgVolRatio = volRatioCount > 0 ? volRatioSum / volRatioCount : 1;

    // 2. Pairwise correlation on the short window. Average across all pairs.
    const symbols = Array.from(returnsBySymbol.keys());
    let avgCorr = 0;
    if (symbols.length >= this.cfg.minSymbolsForCorrelation) {
      let sum = 0;
      let pairs = 0;
      for (let i = 0; i < symbols.length; i++) {
        for (let j = i + 1; j < symbols.length; j++) {
          const a = returnsBySymbol.get(symbols[i])!;
          const b = returnsBySymbol.get(symbols[j])!;
          const c = correlation(a, b);
          if (Number.isFinite(c)) {
            sum += c;
            pairs++;
          }
        }
      }
      avgCorr = pairs > 0 ? sum / pairs : 0;
    }

    // 3. Decide tradeability.
    const details = {
      volRatio: Number(avgVolRatio.toFixed(3)),
      avgCorrelation: Number(avgCorr.toFixed(3)),
      universeSize: symbols.length,
    };

    if (avgVolRatio >= this.cfg.volSpikeMultiplier) {
      return {
        tradeable: false,
        reason: `volatility spike: realized vol ${avgVolRatio.toFixed(2)}× baseline (cap ${this.cfg.volSpikeMultiplier}×)`,
        details,
      };
    }
    if (symbols.length >= this.cfg.minSymbolsForCorrelation && avgCorr >= this.cfg.correlationCeiling) {
      return {
        tradeable: false,
        reason: `correlation collapse: average pairwise corr ${avgCorr.toFixed(2)} (ceiling ${this.cfg.correlationCeiling})`,
        details,
      };
    }
    return {
      tradeable: true,
      reason: `vol ${avgVolRatio.toFixed(2)}× baseline, avg corr ${avgCorr.toFixed(2)}`,
      details,
    };
  }

  getConfig(): Readonly<RegimeFilterConfig> {
    return this.cfg;
  }
}

// ── Math helpers (kept private to this file) ──

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) v += (x - m) ** 2;
  return Math.sqrt(v / (xs.length - 1));
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  const ma = mean(a.slice(-n));
  const mb = mean(b.slice(-n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const ax = a[a.length - n + i] - ma;
    const bx = b[b.length - n + i] - mb;
    num += ax * bx;
    da += ax * ax;
    db += bx * bx;
  }
  const denom = Math.sqrt(da * db);
  if (denom === 0) return NaN;
  return num / denom;
}
