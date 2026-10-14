// ══════════════════════════════════════════════
// Línea D — Quórum de modelos de IA, en sombra (docs/reports/V-plan §12).
//
// Shared types for the isolated ai-quorum process (scripts/ai-quorum.ts).
// NOTHING in here imports engines, AccountManager or trading.db — the whole
// experiment lives in data/ai-quorum.db and reads historical.db READ-ONLY.
// Criteria are PRE-REGISTERED in §12-D and must not drift:
//   - quorum: position iff ≥2 of 3 models agree AND mean confidence of the
//     agreeing models ≥ 0.6; equal weights; held one day;
//   - shadow fills at the next daily-bar open after the decision (stocks:
//     next US open; crypto: next 00:00 UTC), costs 2 bps/side stocks and
//     9 bps/side crypto, fictitious notional $100k, zero capital;
//   - verdict at 8 weeks (≥40 sessions with views): book Sharpe ≥ 1.0 net
//     of costs AND above BOTH benchmarks (equal-weight long; sign of 21d
//     momentum) on the same symbols and days.
// ══════════════════════════════════════════════

export type AssetClass = "stocks" | "crypto";

export type View = "long" | "short" | "neutral";

/** One model's opinion on one symbol. Confidence ∈ [0, 1]. */
export interface ModelView { view: View; confidence: number; }

/** Full validated response of one model: symbol → view. */
export type ModelViews = Record<string, ModelView>;

/** Per-symbol features computed from historical.db daily bars (pure). */
export interface SymbolFeatures {
  symbol: string;
  /** Simple close-to-close returns, null when history is too short. */
  ret1: number | null;
  ret5: number | null;
  ret21: number | null;
  ret63: number | null;
  /** Std dev of the last 20 daily log returns (daily, not annualized). */
  vol20: number | null;
  /** Wilder RSI over 14 daily closes. */
  rsi14: number | null;
  /** close / SMA − 1. */
  distMA50: number | null;
  distMA200: number | null;
  /** Mean of the last 3 perp funding rates (8h each). Stocks: null. */
  funding: number | null;
  /** Close of the latest completed daily bar the features were built on. */
  lastClose: number;
  /** Timestamp (ms) of that bar — the decision's information horizon. */
  lastBarTs: number;
}

export interface NewsHeadline { title: string; source: string; }

/** What gets persisted per (assetClass, dateKey) and sent to the models. */
export interface Snapshot {
  assetClass: AssetClass;
  /** UTC date key YYYY-MM-DD of the decision. */
  dateKey: string;
  decidedAt: number;
  symbols: SymbolFeatures[];
  headlines: NewsHeadline[];
}

/** A provider the runner can call. family must differ across the three. */
export interface ProviderSpec {
  /** Stable id persisted in model_views/model_calls, e.g. "openrouter:anthropic/claude-sonnet-4.5". */
  id: string;
  /** Model family for the "three distinct families" rule: anthropic | openai | google | ... */
  family: string;
  kind: "openrouter" | "anthropic" | "openai" | "google" | "proxy";
  model: string;
  apiKey: string;
  /** kind "proxy" only: the OpenAI-compatible server's base URL (no trailing slash), e.g. "http://host:8317/v1". */
  baseUrl?: string;
}

export interface ModelCallResult {
  views: ModelViews;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface QuorumPosition {
  symbol: string;
  /** +1 long, −1 short. Neutral/no-quorum symbols simply have no row. */
  direction: 1 | -1;
  /** Mean confidence of the agreeing models (the ≥0.6 gate input). */
  meanConfidence: number;
}

/** Pre-registered §12-D constants — do not change. */
export const QUORUM_MIN_AGREE = 2;
export const QUORUM_MIN_CONFIDENCE = 0.6;
export const SHADOW_NOTIONAL_USD = 100_000;
export const COST_BPS_PER_SIDE: Record<AssetClass, number> = { stocks: 2, crypto: 9 };
export const VERDICT_WEEKS = 8;
export const VERDICT_MIN_SESSIONS = 40;
