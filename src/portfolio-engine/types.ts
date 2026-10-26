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

/** One public event of a signal source (e.g. an SEC Form 4 open-market purchase). */
export interface SignalEvent {
  source: string;
  symbol: string;
  /** When the event became PUBLIC (never when it happened). */
  knownAtMs: number;
  /** The producer's magnitude (SEC Form 4: dollar value of the purchase). */
  weight: number;
  /** Producer-specific JSON. `actors: string[]` = the distinct actors behind the event (insider CIKs…). */
  meta: Readonly<Record<string, unknown>>;
}

/** Point-in-time view of signal events (copySignal). Never returns an event known after `cutoffMs`. */
export interface SignalView {
  /** Last COMPLETED session a decision may read. */
  readonly asOf: SessionDate;
  /** Last instant a decision at `asOf` may know about (end of that session's day). */
  readonly cutoffMs: number;
  /** Events of `source` known within the last `lookbackDays` calendar days up to and including `asOf`,
   *  oldest → newest; [] when none. Never an event with knownAtMs > cutoffMs. */
  events(source: string, lookbackDays: number): readonly SignalEvent[];
}

/** A holding of the sleeve. Long-only designs keep qty ≥ 0. */
export interface Position {
  symbol: string;
  qty: number;
  /** Average entry price of the current position (stops measure from it). */
  avgEntryPrice: number;
  /** NYSE session of the OPEN row's entry_time; resizes never reset it. Required with maxHoldSessions. */
  entrySession?: SessionDate;
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
  /** Expired lots: fully sell before sizing a fresh buy to the unchanged target. Absent = off. */
  maxHold?: readonly string[];
}

export interface StopLevel {
  symbol: string;
  /** Sell everything when the price trades at or below this level. */
  stopPrice: number;
}

export interface DecideInput {
  view: PriceView;
  membership?: MembershipView;
  /** Signal events (copySignal only; other kinds ignore it). */
  signals?: SignalView;
  book: BookState;
  config: PortfolioStrategyConfig;
  /** The session the resulting orders execute in (the one after `asOf`). D2 reconstitutes when it is the
   *  first session of a month, with that session's membership. Absent: `asOf`'s month and membership. */
  executionSession?: SessionDate;
}

/** The strategy: pure, deterministic, no clock, no I/O. */
export type Decide = (input: DecideInput) => TargetBook;

// ── Strategy configs: the manifest candidate's `portfolio` block ─────────────

export type PortfolioStrategyConfig = XassetTrendConfig | FactorCoreConfig | CryptoTrendConfig | VolManagedConfig | CopySignalConfig;

/** Copy-trading on a public event stream (e.g. SEC Form 4 open-market purchases): long-only.
 *  At each decision the events of `source` known within the last `lookbackDays` calendar days (incl. asOf) that
 *  pass the event filters (`exclude`, `roles`, `insiderClass`, `exclude10b5_1`, `maxReportLagDays`) and were not
 *  already used by an earlier pick of the same symbol are grouped by symbol. A symbol qualifies when it has
 *  >= minDistinctInsiders distinct actors (`meta.actors`; with `minDollarPerInsider` only actors with at least that
 *  much total `weight` count) and >= minDollar of `weight`. Qualifiers are ranked (distinct actors desc, dollars
 *  desc, symbol asc) and fill the free slots up to `topN` (a full book never rotates); each pick is held
 *  `holdDays` calendar days or `holdSessions` sessions of the symbol's own bars from its selection through memory
 *  (a fresh qualifying cluster on a held name renews the clock), then dropped. Slot size = maxGross / topN, so gross is
 *  maxGross × picks/topN: the rest is cash. Needs `DecideInput.signals`; `membership` (when given) restricts NEW
 *  picks to the members at the execution session. */
export interface CopySignalConfig {
  kind: "copySignal";
  /** Event source, e.g. "sec-form4-buy". */
  source: string;
  lookbackDays: number;
  /** Distinct `meta.actors` required (SEC: distinct insiders). */
  minDistinctInsiders: number;
  /** Minimum sum of `weight` over the qualifying events (SEC: dollars). 0 = no floor. */
  minDollar: number;
  topN: number;
  /** Calendar days a pick is held from its selection. Exactly one of holdDays / holdSessions. */
  holdDays?: number;
  /** Sessions (bars of the picked symbol after its selection) a pick is held. Exactly one of holdDays / holdSessions. */
  holdSessions?: number;
  weighting: "equal" | "inverseVol";
  /** Daily-return stdev lookback; REQUIRED for inverseVol, forbidden for equal. */
  volLookback?: number;
  /** Max weight of one symbol (fraction of equity). */
  perNameCap: number;
  /** Max sum of weights when all topN slots are filled. */
  maxGross: number;
  /** Symbols never held. */
  exclude: string[];
  /** When present, an event counts only if its `meta.role` has any of these (SEC: "officer" | "director" | "tenPercentOwner" | "other"). */
  roles?: string[];
  /** Which actors' events count, by the producer's point-in-time class (`meta.insiderClass`: SEC Form 4 =
   *  Cohen-Malloy-Pomorski "opportunistic" | "routine" | "unknown"). Absent = "all". "routine" is the placebo control. */
  insiderClass?: "all" | "opportunistic" | "routine";
  /** Drop events flagged `meta.plan10b5_1 === true` (a pre-scheduled Rule 10b5-1 plan). Absent = false. */
  exclude10b5_1?: boolean;
  /** Drop events whose `meta.lagDays` (transaction → public) exceeds this, or is unknown. Absent = no limit. */
  maxReportLagDays?: number;
  /** An actor counts toward minDistinctInsiders only with at least this much total `weight` on the symbol in the
   *  window (SEC: dollars); the cluster's dollars are then those of the qualifying actors' events. Absent = 0. */
  minDollarPerInsider?: number;
}

/** RW2 (E1–E3): always invested — inverse-vol weights, one scale to the portfolio vol
 *  target, per-name cap, max gross. No timing signal, no stops: every eligible symbol
 *  is held; only the vol target (and the caps) lower the exposure. */
export interface VolManagedConfig {
  kind: "volManaged";
  universe: string[];
  /** A symbol enters after this many bars of history. */
  inceptionGuardBars: number;
  /** Daily-return stdev lookback for the inverse-vol weights. */
  volLookback: number;
  /** Covariance lookback for the portfolio vol estimate (the de-risking speed). */
  covLookback: number;
  /** Annualized portfolio vol target (e.g. 0.15). */
  portfolioVolTarget: number;
  /** 252 for stocks/ETFs, 365 for crypto. */
  annualization: 252 | 365;
  /** Max weight of one symbol (fraction of equity). */
  perAssetCap: number;
  /** Max sum of weights (1 = no margin). */
  maxGross: number;
  /** Optional NYSE-session lot limit (stocks only). At age >= N, realize and renew at the same target. */
  maxHoldSessions?: number;
  /** RW4b (optional; absent = RW2/RW3 behavior, same outputs and hashes). The target vol is scaled down
   *  continuously as the sleeve's drawdown from its in-memory equity peak deepens, and restored as it recovers. */
  drawdownBrake?: DrawdownBrakeConfig;
  /** RW4b (optional; absent = RW2/RW3 behavior). Window (sessions, 2 ≤ n < covLookback) of a faster covariance
   *  estimate: the portfolio vol used for the scale is max(fast, covLookback) estimate, so leverage drops quickly
   *  in a crash. Weights still use `volLookback`. */
  fastVolLookback?: number;
  /** RW5, absent = unchanged construction. Price signals, never sleeve P&L. */
  regimeOverlay?: RegimeOverlayConfig;
  /** With this knob, `universe` is the FIXED sleeve (e.g. ETFs), plus these PIT stock slots. */
  pitUniverse?: PitUniverseConfig;
}

export type RegimeSignal =
  | { kind: "maTrend"; symbol: string; period: number; sampling: "daily" | "monthEnd"; bandPct?: number }
  | { kind: "absMomentum"; symbol: string; cashProxy: string; lookback: number }
  | { kind: "canary"; assets: string[]; horizons: number[]; coefficients: number[]; negativeCount?: number };

export interface RegimeOverlayConfig {
  signals: RegimeSignal[];
  /** Number means at least that many signals request risk-off. */
  combine: "any" | "all" | number;
  confirmationDecisions?: number;
  coreScale: number;
  /** Freed core weight, inverse-vol across positive-momentum assets, otherwise cashProxy. */
  defensive?: { assets: string[]; momentumLookback: number; volLookback: number; cashProxy: string };
  /** Additional LONG inverse-ETF position, fraction of the pre-overlay core gross. */
  hedge?: { symbol: string; fraction: number };
}

export interface PitUniverseConfig {
  topN: number;
  liquidityLookback: number;
  /** Selection tenure, not a promise of fills. Membership removal/data ineligibility wins over tenure. */
  minHoldingRebalances: number;
  exclude?: string[];
}

/** Drawdown brake: multiplier on the vol target = 1 while drawdown ≤ startDrawdown, then linear down to
 *  floorScale at maxDrawdown, flat at floorScale beyond. Drawdown is a fraction of the peak of the sleeve's
 *  book equity as seen at past decisions (no look-ahead). */
export interface DrawdownBrakeConfig {
  /** Fraction in [0, 1): drawdown at which de-risking starts. */
  startDrawdown: number;
  /** Fraction in (0, 1], > startDrawdown: drawdown at which the multiplier reaches the floor. */
  maxDrawdown: number;
  /** Multiplier floor in (0, 1] (never 0: a zero floor could not recover). */
  floorScale: number;
}

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
  /** Paired renewal legs; a rebuy must wait for the full close, including across restarts. */
  maxHold?: "close" | "rebuy";
}

export const MAX_HOLD_CLOSE_REASON = "MAX_HOLD";

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
  /** Cutover: cancel the resting protective stops the INCUMBENT engine armed on these symbols
   *  (targeted, by exact id, only orders stamped by this bot). Rows adopted by the portfolio engine
   *  leave the incumbent's stop machinery; a stale resting stop would otherwise keep firing on them
   *  and block the engine's own sells. Returns the cancelled order ids (a bare array = all of them
   *  are settled) or, for venues whose cancel is asynchronous, the ids split by whether the venue
   *  CONFIRMED the cancel (the shares stay held until then). Optional. */
  releaseLegacyStops?(symbols: readonly string[]): Promise<string[] | LegacyStopRelease>;
}

export interface LegacyStopRelease {
  /** Cancelled and confirmed terminal at the venue (shares released). */
  released: string[];
  /** Cancel accepted but not confirmed within the venue's bounded wait (shares may still be held). */
  unconfirmed: string[];
}
