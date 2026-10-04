// ══════════════════════════════════════════════
// Momentum Scorer config/types (v7.0 — "Momentum Edge")
// ══════════════════════════════════════════════
//
// The cross-sectional ranker (`MomentumScorer.rank`, mode="cross-sectional")
// was removed 2026-07-26: MomentumEngine has only ever run "time-series"
// (TimeSeriesMomentum.rank) — every live and backtest call site, verified
// via `rg -n 'mode: "'`, passed "time-series". This file now only holds the
// config/decision TYPES still shared with the live path: `MomentumDecision`
// (TimeSeriesMomentum.ts, Rebalancer.ts) and `MomentumScorerConfig` /
// `DEFAULT_MOMENTUM_CONFIG` (MomentumEngineConfig.scorer — kept for config
// literal compatibility with index.ts/scripts that still pass it, even
// though nothing reads it anymore).

export interface MomentumScorerConfig {
  /** Bar length in minutes. Default 5. */
  barMinutes: number;
  /** Weight for 24h return (0-1). Default 0.5. */
  weight24h: number;
  /** Weight for 3d return (0-1). Default 0.3. */
  weight3d: number;
  /** Weight for 7d return (0-1). Default 0.2. Sum of weights normalised internally. */
  weight7d: number;
  /** Minimum score (decimal, e.g. 0.02 = 2%) for a symbol to be a long candidate. */
  minLongScore: number;
  /** Maximum score (decimal, negative) for a symbol to be a short candidate. */
  maxShortScore: number;
  /** How many longs to keep per rebalance. Default 3. */
  topLongs: number;
  /** How many shorts to keep. 0 disables shorts. Default 0 (longs-only first). */
  topShorts: number;
  /**
   * Hysteresis bonus: how many extra ranks BELOW the cutoff a symbol can fall
   * before we close an existing position. Prevents churn when a symbol oscillates
   * around the rank boundary. Default 1 (top-3 enters, top-4 keeps held positions).
   * (Config-only now — the cross-sectional ranker that consumed this was removed.)
   */
  hysteresisRanks: number;
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumScorerConfig = {
  barMinutes: 5,
  weight24h: 0.2,
  weight3d: 0.3,
  weight7d: 0.5,          // long-term tilt — empirically best in 60d backtest
  minLongScore: 0.020,    // 2.0% — bias toward fewer, higher-conviction trades
  maxShortScore: -0.025,
  topLongs: 3,
  topShorts: 0,
  hysteresisRanks: 1,
};

export interface MomentumDecision {
  symbol: string;
  action: "long" | "short" | "flat";
  score: number;
  rank: number;
  reason: string;
}
