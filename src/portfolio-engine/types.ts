// ═══ Portfolio engine — the contract shared by research and live ═══
//
// One decision path for both worlds (docs/reports/RW-reescritura-rentable.md):
//   scripts/portfolio-replay.ts (walk-forward simulator) and
//   src/portfolio-engine/live/* (the live runner) call the SAME pure
//   functions below. Nothing in this file or in the pure modules does I/O.
//
// Ownership: this file is the director's. Agents add their code in their own
// modules; a change here is agreed first, because every other piece depends
// on it.

/** "YYYY-MM-DD": a US trading session for stocks/ETFs, a UTC day for crypto. */
export type SessionDate = string;

export interface DailyBar {
  date: SessionDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Point-in-time view of daily bars. Never returns a bar dated after `asOf`. */
export interface PriceView {
  /** Last COMPLETED session a decision may read. */
  readonly asOf: SessionDate;
  /** Last `n` bars of `symbol` ending at `asOf`, oldest → newest; shorter when history is shorter; [] when none. */
  history(symbol: string, n: number): readonly DailyBar[];
  /** Bars available for `symbol` up to `asOf` (inception guard). */
  barCount(symbol: string): number;
}

/** Point-in-time index membership (D2 core). */
export interface MembershipView {
  members(date: SessionDate): readonly string[];
}

/** A holding of the sleeve. Long-only designs keep qty ≥ 0. */
export interface Position {
  symbol: string;
  qty: number;
  /** Average entry price of the current position (stops measure from it). */
  avgEntryPrice: number;
}

export interface BookState {
  /** Sleeve equity (cash + positions marked at the decision's reference prices). */
  equity: number;
  positions: readonly Position[];
  /** State carried between decisions of ONE strategy version (signal hysteresis,
   *  last reconstitution, core members, overlay state, stopped-out symbols…).
   *  JSON-serializable; persisted by the caller, opaque to it. */
  memory: Readonly<Record<string, unknown>>;
}

export interface TargetBook {
  asOf: SessionDate;
  /** symbol → target weight as a fraction of sleeve equity. Missing = 0. ≥ 0 (long-only). */
  weights: Readonly<Record<string, number>>;
  /** Memory to persist for the next decision. */
  memory: Readonly<Record<string, unknown>>;
  /** Per-symbol price stops to keep at the venue (D3 candidates with stops); [] when none. */
  stops: readonly StopLevel[];
  /** Free-form, JSON-serializable diagnostics (signals, vols, scale factor, overlay…). */
  diagnostics: Readonly<Record<string, unknown>>;
}

export interface StopLevel {
  symbol: string;
  /** Sell everything when the price trades at or below this level. */
  stopPrice: number;
}

export interface DecideInput {
  view: PriceView;
  membership?: MembershipView;
  book: BookState;
  config: PortfolioStrategyConfig;
  /** The session the resulting orders execute in (the one after `asOf`). D2 reconstitutes when it is the
   *  first session of a month, with that session's membership. Absent: `asOf`'s month and membership. */
  executionSession?: SessionDate;
}

/** The strategy: pure, deterministic, no clock, no I/O. */
export type Decide = (input: DecideInput) => TargetBook;

// ── Strategy configs: the manifest candidate's `portfolio` block ─────────────

export type PortfolioStrategyConfig = XassetTrendConfig | FactorCoreConfig | CryptoTrendConfig;

/** Signal shared by D1 and D3: mean of the blend horizons' returns > band AND close > SMA(maLong). */
export interface TrendSignalConfig {
  blendHorizons: number[];
  maLong: number;
  /** Hysteresis band in percent of the blend: enter above +band, exit below −band, else keep. 0 = none. */
  signalBandPct: number;
}

/** D1: multi-asset ETF trend with inverse-vol weights and a portfolio vol target. */
export interface XassetTrendConfig extends TrendSignalConfig {
  kind: "xassetTrend";
  universe: string[];
  /** A symbol enters after this many bars of history. */
  inceptionGuardBars: number;
  /** Daily-return stdev lookback for the inverse-vol weights. */
  volLookback: number;
  /** Covariance lookback for the portfolio vol estimate. */
  covLookback: number;
  /** Annualized portfolio vol target (e.g. 0.12). Annualization: 252. */
  portfolioVolTarget: number;
  /** Max weight of one symbol (fraction of equity). */
  perAssetCap: number;
  /** Max sum of weights. */
  maxGross: number;
}

/** D2: long-only S&P 500 point-in-time core, monthly reconstitution, inverse-vol weights. */
export interface FactorCoreConfig {
  kind: "factorCore";
  /** Symbols never held (other sleeves' universes, ETFs). */
  exclude: string[];
  topN: number;
  score: "momentum" | "lowvol" | "momentum+lowvol";
  /** [long, skip] in sessions: return from t−long to t−skip (12-1 = [252, 21]). */
  momentumWindow: [number, number];
  /** Stdev lookback for the low-vol score. */
  volWindow: number;
  /** Stdev lookback for the inverse-vol weights. */
  weightVolLookback: number;
  perNameCap: number;
  minPrice: number;
  minPriorCloses: number;
  /** Exposure overlay on a reference symbol vs its SMA, with a hysteresis band in percent; null = always onExposure 1. */
  overlay: { ref: string; ma: number; bandPct: number; onExposure: number; offExposure: number } | null;
}

/** D3: crypto daily trend with inverse-vol weights, portfolio vol target and an optional stop. */
export interface CryptoTrendConfig extends TrendSignalConfig {
  kind: "cryptoTrend";
  universe: string[];
  inceptionGuardBars: number;
  volLookback: number;
  covLookback: number;
  /** Annualization: 365. */
  portfolioVolTarget: number;
  perAssetCap: number;
  maxGross: number;
  stop: StopConfig;
}

export type StopConfig =
  | { mode: "none" }
  | { mode: "fixed"; pct: number }
  /** Distance = clamp(kSigma × stdev of the last `lookbackBars` daily returns, minPct, maxPct), set at each increase. */
  | { mode: "volScaled"; kSigma: number; lookbackBars: number; minPct: number; maxPct: number };

// ── Orders ───────────────────────────────────────────────────────────────────

export type VenueId = "alpaca" | "binance_usdm" | "binance_usdc";

export interface VenueRules {
  venue: VenueId;
  /** Alpaca fractional shares: any positive quantity. */
  fractional: boolean;
  /** Skip deltas whose notional is below this (USD / USDT / USDC). */
  minOrderNotional: number;
  /** Skip a symbol when |target weight − current weight| < band (absolute weight). 0 = trade every delta. */
  rebalanceBand: number;
  /** Quantity step per symbol (Binance stepSize); absent = fractional/unit rules above. */
  qtyStep?: Readonly<Record<string, number>>;
  /** Per-symbol minimum notional (Binance); falls back to minOrderNotional. */
  minNotional?: Readonly<Record<string, number>>;
}

export interface OrderIntent {
  symbol: string;
  side: "buy" | "sell";
  /** Quantity after venue rounding (always > 0). */
  qty: number;
  /** qty × reference price. */
  notional: number;
  targetWeight: number;
  currentWeight: number;
  /** True for any order that only reduces an existing position. */
  reduceOnly: boolean;
}

/** Pure: target weights + current book + reference prices → the orders that move the book to the target. */
export type PlanOrders = (
  target: TargetBook,
  book: BookState,
  prices: Readonly<Record<string, number>>,
  rules: VenueRules,
) => OrderIntent[];

// ── Costs (research simulator) ───────────────────────────────────────────────

export interface CostModel {
  slippageBps: number;
  commissionBps: number;
  /** Annual rate on borrowed cash (gross > 1). 0 = none. */
  marginInterestAnnual: number;
  /** Perpetuals: apply the real funding rates from the data. */
  funding: "real" | "none";
}

// ── Live venues (implemented in src/portfolio-engine/live/venues/*) ──────────

export interface OrderResult {
  ok: boolean;
  filledQty: number;
  avgPrice: number | null;
  status: string;
  brokerOrderId?: string;
  error?: string;
}

export interface VenueAdapter {
  readonly venue: VenueId;
  /** Order-size rules for these symbols (fetched from the venue where needed). */
  rules(symbols: readonly string[]): Promise<VenueRules>;
  /** Broker positions for these symbols (broker = truth). */
  positions(symbols: readonly string[]): Promise<Position[]>;
  /** Execution reference prices (last trade or mark). */
  prices(symbols: readonly string[]): Promise<Record<string, number>>;
  /** Idempotent by clientOrderId: a retry with the same id must never duplicate an order. */
  submit(order: OrderIntent, clientOrderId: string): Promise<OrderResult>;
  /** Make the venue's stop orders for these symbols match `stops` exactly (D3 with stops); optional. */
  syncStops?(stops: readonly StopLevel[], positions: readonly Position[]): Promise<void>;
}
