// ══════════════════════════════════════════════
// Momentum Engine (v7.0 — "Momentum Edge")
// ══════════════════════════════════════════════
//
// Top-level orchestrator for the momentum strategy. Coordinates the four
// pure modules (TimeSeriesMomentum, RegimeFilter, RiskGuard, Rebalancer) and
// translates their outputs into broker calls. tick() is reentrancy-guarded
// (`ticking`) — see the field docstring below.
//
// Lifecycle:
//   start() → bar-close-aligned rebalance scheduler (nextAlignedTickDelayMs:
//             every rebalanceMinutes boundary + 15s), plus an early boot tick
//             when the next boundary is far away.
//   stop()  → clear timer. Open positions remain (managed by exit logic).
//
// On every rebalance tick:
//   1. Fetch candles for every symbol in the universe.
//   2. RegimeFilter: is the market tradeable? If not, only manage exits.
//   3. RiskGuard: any portfolio breach? If yes, only manage exits.
//   4. TimeSeriesMomentum: rank, pick targets.
//   5. Rebalancer: compute close/open actions.
//   6. Execute via the injected broker adapter.
//   7. Update RiskGuard state with the realised PnL of this rebalance.
//
// Side effects intentionally limited to:
//   - candle fetcher (read)
//   - broker adapter (read positions, place orders)
//   - logger
//   - state persistence callback
//
// The engine is constructible without a real broker — pass a fake adapter
// for tests. See MomentumEngine.test.ts (next file).

import type { MomentumDecision, MomentumScorerConfig } from "./MomentumScorer";
import { DEFAULT_MOMENTUM_CONFIG } from "./MomentumScorer";
import { TimeSeriesMomentum, type TSMConfig, DEFAULT_TSM_CONFIG } from "./TimeSeriesMomentum";
import { RegimeFilter, type RegimeFilterConfig, DEFAULT_REGIME_CONFIG } from "./RegimeFilter";
import { evaluateRisk, recordRebalanceOutcome, detectPauseTransition, isSoftDrawdownPauseReason, isLossStreakPauseReason, MODEL_REANCHOR_REV, INITIAL_RISK_STATE, DEFAULT_RISK_CONFIG, type RiskState, type RiskGuardConfig, type RiskAssessment } from "./RiskGuard";
import { planRebalance, type CurrentPosition, type RebalanceAction } from "./Rebalancer";
import type { OHLCV } from "../../utils/types";
import { heartbeats } from "../../ops/heartbeat";
import { sleeveOutput, isPolicyPreventedReason } from "../../ops/sleeveOutput";
import { eventBus, EVENTS } from "../../utils/events";
import { isTradingEnabled } from "../../config";
import { systemClock, type Clock } from "../../utils/clock";

export interface MomentumBrokerAdapter {
  /** Returns currently open positions on the broker (already in our domain
   *  shape). `entryTime` (epoch ms) is optional — the DB-backed adapters
   *  (Alpaca/Binance/Shadow) supply it from the trade row; it feeds the
   *  opt-in model cutover (see MomentumEngineConfig.reunderwriteBefore),
   *  which skips any position without it. */
  getOpenPositions(): Promise<Array<CurrentPosition & { entryTime?: number }>>;
  /** Live equity in USD (cash + unrealised). */
  getEquity(): Promise<number>;
  /** Realised PnL since the previous call. Implementation can read trade outcomes. */
  getRealisedPnlSince(epochMs: number): Promise<number>;
  /**
   * Open a market position for `symbol` with given side and target USD notional.
   * Implementation handles symbol mapping, leverage, and stop-loss attachment.
   */
  /** `stopLossPct` (optional): entry-anchored hard-stop distance in percent
   *  units, computed by the ENGINE at decision time (vol-scaled sleeves,
   *  `volStop` config). Adapters that persist a stop derive the stop PRICE
   *  from the FILL price with it; absent → the adapter/profile legacy fixed
   *  distance applies unchanged. */
  openPosition(action: { symbol: string; side: "buy" | "sell"; notionalUsd: number; stopLossPct?: number }): Promise<{ ok: boolean; reason?: string }>;
  /** Close the entire position for the given symbol/side. `closeReason` is an
   *  optional CANONICAL telemetry label (e.g. TRAIL_STOP_CLOSE_REASON) the
   *  adapter maps onto trades.close_reason; absent (plan-driven signal-flip
   *  closes) the adapter keeps its default rebalance label. */
  closePosition(action: { symbol: string; side: "buy" | "sell"; closeReason?: string }): Promise<{ ok: boolean; reason?: string }>;
  /** Fetch the candle history for one symbol at the engine's bar timeframe. */
  fetchCandles(symbol: string, bars: number): Promise<OHLCV[]>;
  /**
   * OPTIONAL — data source for the market-trend entry gate (see
   * MomentumEngineConfig.marketTrend): the last `days` closes of CLOSED
   * UTC daily bars for `symbol`, oldest→newest. "Closed" is a hard causal
   * requirement: the still-forming day must NEVER be included (live:
   * klinesToOHLCV already drops the partial kline; sim: SimBroker only
   * reveals days whose UTC end is ≤ its clock). May return fewer than
   * `days` closes (or []) when history/data is unavailable — the gate then
   * FAILS OPEN (entries allowed), documented on evaluateMarketTrendGate.
   * Adapters that don't implement it behave as "no data" (fail-open).
   */
  fetchDailyCloses?(symbol: string, days: number): Promise<number[]>;
}

// v8: cross-sectional mode was removed (dead — every call site, live and
// backtest, has always passed "time-series"; see MomentumScorer.ts history).
// The field/type survive so existing config literals ({ mode: "time-series" })
// still type-check without touching every caller.
export type MomentumMode = "time-series";

export interface VolTargetConfig {
  /** Target annualized volatility in percent (e.g. 60 = 60%/yr). */
  annualizedPct: number;
  /** Bars of close history used for realized vol. */
  lookbackBars: number;
  /** Scale clamp floor (e.g. 0.3). */
  minScale: number;
  /** Scale clamp ceiling (e.g. 1.0 = de-risk only, never lever up). */
  maxScale: number;
}

/**
 * Vol-targeted sizing scale (Moskowitz/Ooi/Pedersen): target / realized vol,
 * clamped to [minScale, maxScale]. Realized vol = stdev of log returns over
 * the last `lookbackBars` closes, annualized by sqrt(barsPerYear).
 * Fails open to 1 (full base size) when history is too short or degenerate.
 */
export function volTargetScale(closes: number[], cfg: VolTargetConfig, barsPerYear: number): number {
  const n = Math.min(cfg.lookbackBars, closes.length - 1);
  if (n < 2 || barsPerYear <= 0) return 1;
  const rets: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return 1;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  const realizedVol = Math.sqrt(variance) * Math.sqrt(barsPerYear);
  if (!(realizedVol > 0)) return 1;
  return Math.min(cfg.maxScale, Math.max(cfg.minScale, (cfg.annualizedPct / 100) / realizedVol));
}

export interface VolSizingConfig {
  /** Bars of close history for each symbol's realized vol σᵢ (per-bar stdev,
   *  NOT annualized — only the cross-sectional RATIO σ_ref/σᵢ is used, so
   *  annualization would cancel out). */
  lookbackBars: number;
  /** Clamp floor for σ_ref/σᵢ (e.g. 0.5 = a high-vol name gets at least half a slot). */
  minScale: number;
  /** Clamp ceiling (e.g. 2.0 = a low-vol name gets at most a double slot). */
  maxScale: number;
}

/**
 * Per-symbol realized vol for inverse-volatility sizing (see
 * MomentumEngineConfig.volSizing): stdev of the symbol's bar log returns
 * over the last `lookbackBars` closes. Returns null when history is
 * insufficient — the FULL lookbackBars returns are required, so a
 * short-tape symbol never enters the cross-sectional median with a noisier
 * estimate — or when the series is degenerate (σ = 0 or unusable closes).
 */
export function volSizingSigma(closes: number[], lookbackBars: number): number | null {
  if (lookbackBars < 2 || closes.length < lookbackBars + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - lookbackBars; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (!(a > 0) || !(b > 0)) return null;
    rets.push(Math.log(b / a));
  }
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  const sigma = Math.sqrt(variance);
  return sigma > 0 ? sigma : null;
}

/** Median of a non-empty list; null on empty (volSizing fails open then). */
function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface CapacityGuardConfig {
  /** Max entry notional as a percent of ADV$ (1 = the order may take up to
   *  1% of the average daily dollar volume). */
  maxAdvPct: number;
  /** ADV$ lookback in DAILY bars (days). Sub-daily engines aggregate their
   *  own bars into days (e.g. 24×1h bars per day on crypto). */
  lookbackBars: number;
  /** "observe" logs a WARN + telemetry and lets the entry through;
   *  "enforce" blocks it as a policy veto (recordPreventedByPolicy). */
  mode: "observe" | "enforce";
}

/**
 * Average daily dollar volume (ADV$) over the last `lookbackDays` days:
 * mean of Σ(close×volume) per day, where a day is `barsPerDay` consecutive
 * bars of the engine's own decision candles (1 on daily data; 24 on 1h
 * crypto). Returns null — the capacity guard then FAILS OPEN — when history
 * is shorter than the window, any bar carries non-finite/negative volume or
 * a non-positive close, or the whole window traded nothing: missing volume
 * data must never manufacture a block (same fail-open discipline as the
 * market-trend gate).
 */
export function averageDailyDollarVolume(bars: OHLCV[], lookbackDays: number, barsPerDay: number): number | null {
  const perDay = Math.max(1, Math.round(barsPerDay));
  const need = lookbackDays * perDay;
  if (!(lookbackDays >= 1) || bars.length < need) return null;
  let total = 0;
  for (let i = bars.length - need; i < bars.length; i++) {
    const { close, volume } = bars[i];
    if (!Number.isFinite(volume) || volume < 0 || !Number.isFinite(close) || close <= 0) return null;
    total += close * volume;
  }
  const adv = total / lookbackDays;
  return adv > 0 ? adv : null;
}

export interface TrailStopConfig {
  /** Multiplier on realized daily vol. Trail distance = kSigma × σ(daily). */
  kSigma: number;
  /** Bars of close history used for realized vol (e.g. 24 on 1h bars = σ(24h)). */
  lookbackBars: number;
  /** Clamp floor in percent-units (2 = 2%). */
  minPct: number;
  /** Clamp ceiling in percent-units (8 = 8%). */
  maxPct: number;
}

/**
 * Vol-regime trailing-stop distance: kSigma × realized daily vol of the
 * symbol, clamped to [minPct, maxPct] (percent-units, e.g. 2..8). Realized
 * daily vol = stdev of bar log returns over the last `lookbackBars` closes,
 * scaled by sqrt(barsPerDay). Fails open to maxPct (widest stop) when
 * history is too short or degenerate.
 */
export function trailPctFromVol(closes: number[], cfg: TrailStopConfig, barsPerDay: number): number {
  const n = Math.min(cfg.lookbackBars, closes.length - 1);
  if (n < 2 || barsPerDay <= 0) return cfg.maxPct;
  const rets: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return cfg.maxPct;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  const dailyVol = Math.sqrt(variance) * Math.sqrt(barsPerDay);
  if (!(dailyVol > 0)) return cfg.maxPct;
  return Math.min(cfg.maxPct, Math.max(cfg.minPct, cfg.kSigma * dailyVol * 100));
}

export interface MarketTrendGateConfig {
  /** Symbol whose DAILY closes define the market regime (e.g. "BTC/USD"). */
  symbol: string;
  /** SMA length in CLOSED UTC days (e.g. 200). */
  maDays: number;
}

/**
 * Market-trend gate verdict from a series of CLOSED daily closes
 * (oldest→newest): blocked (true) when the LAST closed daily close sits
 * below the simple moving average of the last `maDays` closes (inclusive
 * of that last close — the classic px < SMA200 bear-market filter).
 * Returns null (gate must FAIL OPEN) when there are fewer than `maDays`
 * usable closes or the series is degenerate — insufficient data can never
 * manufacture a block. Pure and causal by construction: the caller is
 * responsible for passing only CLOSED days (see fetchDailyCloses).
 */
export function marketTrendBlocked(closes: number[], maDays: number): boolean | null {
  if (!Array.isArray(closes) || maDays < 2 || closes.length < maDays) return null;
  const window = closes.slice(-maDays);
  let sum = 0;
  for (const c of window) {
    if (!Number.isFinite(c) || c <= 0) return null;
    sum += c;
  }
  const sma = sum / maDays;
  if (!(sma > 0)) return null;
  return window[window.length - 1] < sma;
}

export interface SharpeGateConfig {
  /** Days of daily returns in the rolling window (e.g. 30). */
  lookbackDays: number;
  /** Minimum annualized Sharpe to allow a NEW entry (e.g. 0). */
  minSharpe: number;
}

/**
 * Annualized Sharpe (mean/sd × sqrt(365)) of the symbol's own daily
 * returns over the last `lookbackDays` days, sampled every `barsPerDay`
 * closes. Returns null (gate fails open) when history is insufficient.
 * sd = 0 degenerates to ±Infinity by mean sign (null when mean is 0 too).
 */
export function rollingSharpe(closes: number[], lookbackDays: number, barsPerDay: number): number | null {
  const step = Math.max(1, Math.round(barsPerDay));
  if (lookbackDays < 2 || closes.length < lookbackDays * step + 1) return null;
  const daily: number[] = [];
  const last = closes.length - 1;
  for (let k = lookbackDays; k >= 1; k--) {
    const a = closes[last - k * step], b = closes[last - (k - 1) * step];
    if (!(a > 0) || !(b > 0)) return null;
    daily.push((b - a) / a);
  }
  const mean = daily.reduce((s, x) => s + x, 0) / daily.length;
  const sd = Math.sqrt(daily.reduce((s, x) => s + (x - mean) ** 2, 0) / (daily.length - 1));
  if (!(sd > 0)) return mean === 0 ? null : (mean > 0 ? Infinity : -Infinity);
  return (mean / sd) * Math.sqrt(365);
}

export interface MomentumEngineConfig {
  /** Strategy mode. Only "time-series" exists (see MomentumMode). Kept as a
   *  field so existing config literals don't need editing. */
  mode: MomentumMode;
  universe: string[];
  rebalanceMinutes: number;
  historyBars: number;
  notionalPctPerSlot: number;
  /**
   * Ops-watchdog loop name (src/ops/heartbeat.ts). When set, start() registers
   * it at the rebalance cadence and tick() beats it after each successful
   * iteration. Leave undefined when index.ts drives tick() externally — the
   * caller registers the name; tick() still beats it (both sleeves configured).
   */
  heartbeatName?: string;
  /** Optional vol-targeted position sizing. Undefined = fixed notionalPctPerSlot (current behavior). */
  volTarget?: VolTargetConfig;
  /**
   * Optional inverse-volatility ENTRY sizing (opt-in, 2026-09-25; Moskowitz–
   * Ooi–Pedersen 2012 risk parity across signals; Barroso & Santa-Clara 2015
   * on momentum crash risk): a NEW entry's notional is
   *   equity × notionalPctPerSlot × clamp(σ_ref/σᵢ, minScale, maxScale)
   * where σᵢ is the symbol's realized vol over the last lookbackBars closes
   * (volSizingSigma) and σ_ref is the MEDIAN σ across the universe symbols
   * with sufficient history on THIS tick. Equalizes each slot's risk
   * contribution (GLD ~15%/yr vs NVDA ~50%/yr under equal notional).
   * ENTRIES ONLY — held positions are never resized (same discipline as
   * volTarget/ddScale); the gross-exposure cap (maxGrossExposureMult) still
   * applies on top of the scaled notional. Fails open to scale 1 for a
   * symbol without a usable σ, and to no scaling at all when no universe
   * symbol has one. Composes multiplicatively with volTarget when both are
   * set. Undefined = OFF (byte-identical legacy sizing).
   */
  volSizing?: VolSizingConfig;
  /** Optional vol-regime trailing stop. Undefined = OFF (fixed hard SL only, current behavior). */
  tsmTrail?: TrailStopConfig;
  /**
   * Optional vol-scaled HARD-stop distance, computed ONCE at entry from the
   * decision candles (trailPctFromVol — the exact formula the stop-sizing
   * artifacts validated) and passed to the adapter as
   * `openPosition.stopLossPct`, which persists the stop PRICE on the trade
   * row; AccountManager's 15s loop and the broker-native stop layer then
   * honor the row's stop over the profile's fixed `stopLossPct`.
   * Undefined = OFF (profile fixed distance, previous behavior — Binance
   * sleeves stay here: their stop axis was never swept).
   * Evidence + provenance: owner decision 2026-08-28 ("no elimines… no es
   * la estrategia, es cómo la aplicas") over locked artifacts ff70c47e
   * (momentum_stocks: fixed-4 +7.55%/Sharpe 0.257/DD 25.80% vs vol-k3
   * +30.12%/0.618 — the fixed stop bought NO drawdown) and 9dcd9781
   * (meanrev: 0.725 vs 0.561, ~+3.5pp DD accepted). The protocol did NOT
   * gate-approve either sleeve (both still lose to SPY on every stop
   * policy); this is a DOCUMENTED OVERRIDE on the stop axis only, same
   * class as the sleeve_modes 2026-08-08 promotion note.
   */
  volStop?: TrailStopConfig;
  /** Optional rolling-Sharpe entry gate. Undefined = OFF (current behavior). */
  sharpeGate?: SharpeGateConfig;
  /**
   * Optional %ADV capacity check on NEW entries (opt-in, 2026-09-26; the
   * LEAN/QuantConnect capacity-analysis idea, reduced to its per-order
   * core): before each open, ADV$ = averageDailyDollarVolume over the last
   * `lookbackBars` DAYS of the decision candles; an entry whose notional
   * exceeds `maxAdvPct`% of it either logs WARN + telemetry
   * (mode "observe" — sleeveOutput.recordCapacityObservation, entry
   * proceeds) or is blocked as a policy veto (mode "enforce" —
   * recordPreventedByPolicy, same class as the gross-exposure cap).
   * Irrelevant at today's ~$7k-in-megacaps size — this is the seatbelt for
   * real capital. Unusable/short volume history FAILS OPEN with a log
   * (never blocks on missing data). Undefined = OFF (byte-identical legacy
   * behavior; the replay manifests never set it).
   */
  capacityGuard?: CapacityGuardConfig;
  /**
   * Optional MARKET-trend entry gate (opt-in, 2026-09-24): blocks NEW
   * entries for the whole sleeve while the gate symbol's last CLOSED UTC
   * daily close is below its `maDays`-day SMA (e.g. BTC/USD < SMA200 =
   * classic crypto bear-market filter). Exits/trails/stops are NEVER
   * touched — same entries-only philosophy as RiskGuard/RegimeFilter.
   * Unlike the soft-DD breaker, this gate is NOT path-dependent on the
   * sleeve's own equity, so it cannot produce the multi-week lockout loop
   * (a flat book whose drawdown only closes by peak decay). Data comes
   * from the adapter's optional fetchDailyCloses; on ANY failure —
   * adapter without the method, fetch error, fewer than maDays closed
   * days — the gate FAILS OPEN (entries allowed) with a warn log: a
   * momentum sleeve's downside is bounded by its stops, while a fail-
   * closed data outage would silently freeze the strategy exactly like
   * the lockout this gate exists to avoid. Undefined = OFF (byte-
   * identical legacy behavior).
   */
  marketTrend?: MarketTrendGateConfig;
  /**
   * Optional per-symbol ENTRY-eligibility hook (research replays only,
   * 2026-10-02 — point-in-time index universes): when set, a symbol for
   * which `entryEligibility(symbol, nowMs)` returns false is excluded from
   * the ranking CANDIDATE set unless currently held, so it can never take
   * a slot as a NEW entry. A held position keeps its full stay/exit logic
   * (signal exits, trail/time stops, slotHysteresis stay-privilege) even
   * after losing eligibility — the same entries-only philosophy as
   * RiskGuard/RegimeFilter/marketTrend above, but per symbol instead of
   * per sleeve. Undefined = byte-identical legacy behavior (enforced by
   * MomentumEngine.entryEligibility.test.ts). No live sleeve sets this;
   * only scripts/backtest-momentum-wf.ts (daily-stocks membership mode)
   * does.
   */
  entryEligibility?: (symbol: string, nowMs: number) => boolean;
  /** Optional time barrier. Undefined = OFF (current behavior: holds are
   *  unlimited — signal flip/trail/hard stop only). See TimeStopConfig. */
  timeStop?: TimeStopConfig;
  scorer: Partial<MomentumScorerConfig>;
  tsm: Partial<TSMConfig>;
  regime: Partial<RegimeFilterConfig>;
  risk: Partial<RiskGuardConfig>;
  /**
   * Aggregate gross-exposure BACKSTOP for this sleeve, as a multiple of
   * equity (e.g. 2.0 = this sleeve's live positions' combined notional may
   * never exceed 2× its own equity). NOT the primary sizing control —
   * notionalPctPerSlot × maxLongs already bounds the THEORETICAL max by
   * construction (see index.ts's exported *_MAX_GROSS_EXPOSURE_MULT
   * constants, and momentumExposureCaps.test.ts which locks each sleeve's
   * REAL production wiring against a hardcoded expectation so a future
   * config bump can't silently raise it). This runtime check catches what
   * the theoretical bound doesn't cover on its own — held positions'
   * market value drifting with price after entry, or the theoretical bound
   * itself being raised without this cap being consciously raised to
   * match. Blocks the NEXT open only; never force-closes anything already
   * held (same entries-only philosophy as RiskGuard). Undefined = OFF (no
   * check — current behavior for any caller that doesn't set it).
   */
  maxGrossExposureMult?: number;
  /**
   * OPT-IN one-shot model cutover (epoch ms). Undefined = OFF (byte-identical
   * current behavior). When set, any held universe position whose
   * `entryTime` is EARLIER than this instant was underwritten by a PRIOR
   * model/sizing regime: it is closed BEFORE the ranking, through the normal
   * engine close path, with the canonical MODEL_CUTOVER close reason. The
   * same tick's ranking and entries then treat the symbol as NOT held — no
   * slotHysteresis stay-privilege — so it is re-bought at the CURRENT slot
   * size only if it ranks and passes the entry thresholds (gross-exposure
   * cap included). One-shot by construction: a re-bought position's new
   * entryTime is after the boundary. A failed close leaves the position for
   * the next tick (it stays held, so the cutover retries). Positions whose
   * adapter reports no entryTime are left alone — never fabricate an age.
   * Motivating incident (2026-09-25, momentum_stocks first daily pass):
   * META/AAPL sized under the pre-2026-09-23 2× regime (0.5/slot) by the
   * old 5m kernel filled the 1× gross cap, blocking the h126 kernel's SMH/
   * MSFT entries — the live book couldn't express the validated 4×0.25
   * model. Wire via MOMENTUM_STOCKS_CUTOVER_AT in index.ts.
   */
  reunderwriteBefore?: number;
  /**
   * OPT-IN model-version key for the persisted RiskState (undefined = OFF,
   * byte-identical current behavior). When set, a LOADED state whose
   * `modelVersion` differs (or is absent — every pre-key state) arms a
   * ONE-SHOT re-anchor (RiskState.pendingModelReanchor, applied by
   * evaluateRisk on the first valid equity: peak := current equity, loss
   * streak := 0, an inherited soft-drawdown or loss-streak pause is cleared;
   * hard/daily-cap pauses and the daily anchor survive). Rationale:
   * data/momentum-state-*.json carries the OLD model's peak and streak across
   * a model cutover, so the new model boots pre-locked by losses it never
   * produced (momentum_crypto sat flat from ~2026-09-10 on the peak, and was
   * re-paused 2026-09-28 by 4 inherited losing rebalances + 1 of its own).
   * Applied exactly once — the stamped state persists the new version on the
   * next save. States stamped under revision 1 (peak only) get the streak
   * restart once on the next boot (MODEL_REANCHOR_REV).
   */
  modelVersion?: string;
}

export const DEFAULT_ENGINE_CONFIG: MomentumEngineConfig = {
  mode: "time-series", // empirically best fit for the 60d backtest regime
  universe: ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "AVAX/USD", "DOGE/USD", "LINK/USD"],
  rebalanceMinutes: 240,
  historyBars: Math.floor(35 * 24 * 60 / 5),
  notionalPctPerSlot: 0.25,
  scorer: {},
  tsm: {},
  regime: {},
  risk: {},
};

export interface MomentumEngineLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** One trailing-stop watermark: best close since entry (peak for longs,
 *  trough for shorts) and the timestamp of the last bar folded into it. */
export interface TrailMark {
  mark: number;
  lastTs: number;
}

/**
 * Canonical close_reason label for a trailing-stop exit. Adapters persist it
 * verbatim on trades.close_reason so telemetry can distinguish a TRAIL_STOP
 * from a signal-flip MOMENTUM_REBALANCE (previously both were recorded as
 * the latter and the trail's effectiveness was unmeasurable).
 */
export const TRAIL_STOP_CLOSE_REASON = "TRAIL_STOP";

/**
 * Canonical close_reason label for a time-stop exit (see TimeStopConfig).
 * Whitelisted in the adapters' ENGINE_CLOSE_REASONS alongside TRAIL_STOP so
 * telemetry can distinguish a horizon-expiry close from a signal flip.
 */
export const TIME_STOP_CLOSE_REASON = "TIME_STOP";

/**
 * Canonical close_reason label for a held position closed NOT by its own
 * signal but because a higher-ranked entrant displaced it out of the top-N
 * slots (TimeSeriesMomentum legacy slot assignment — see
 * TSMConfig.slotHysteresis, which eliminates the class when enabled).
 * Whitelisted in the adapters' ENGINE_CLOSE_REASONS alongside TRAIL_STOP /
 * TIME_STOP so telemetry can separate slot churn from genuine signal exits
 * (both used to be recorded as MOMENTUM_REBALANCE, indistinguishably).
 */
export const SLOT_DISPLACED_CLOSE_REASON = "SLOT_DISPLACED";

/**
 * Canonical close_reason label for a position closed by the opt-in model
 * cutover (MomentumEngineConfig.reunderwriteBefore): its entry predates the
 * currently-wired model/sizing regime, so it is re-underwritten — closed
 * before the ranking and re-bought at the CURRENT slot size only if it still
 * ranks and passes the entry thresholds. Whitelisted in the adapters'
 * ENGINE_CLOSE_REASONS (Shadow included — the shadow ledger must classify
 * the same close classes as live or its evidence diverges) so telemetry can
 * separate a one-shot re-underwrite from a signal exit.
 */
export const MODEL_CUTOVER_CLOSE_REASON = "MODEL_CUTOVER";

/**
 * Optional time barrier (López de Prado's third barrier; Hummingbot
 * `TripleBarrierConfig.time_limit`): close any held universe position once
 * it has been held ≥ maxHoldHours. OFF by default (DEFAULT_ENGINE_CONFIG
 * leaves it undefined) — momentum holds are unlimited by design until this
 * axis passes the walk-forward protocol.
 *
 * UNIT — calendar hours on the engine clock (systemClock live, the
 * injected TestClock in replays — src/utils/clock.ts), NOT bars:
 *  - prod telemetry already measures holds in wall hours (p50 20h usdc /
 *    p90 263h momentum_stocks), so the axis is directly comparable to the
 *    numbers that motivated it;
 *  - risk accrues in calendar time (σ√t), including the ~70% of calendar
 *    time the stocks loop cannot trade — overnight/weekend gap exposure is
 *    exactly what a zombie-trade barrier must count, and a bars-held unit
 *    would silently exclude it;
 *  - cadence coherence: crypto (24/7) evaluates every tick; for stocks the
 *    barrier marks EXPIRY and the close executes on the first RTH tick
 *    after it — same semantics as Hummingbot's time_limit with market
 *    orders, and identical live vs replay.
 */
export interface TimeStopConfig {
  /** Max hold in calendar hours; e.g. 264 ≈ prod's p90 stocks hold. */
  maxHoldHours: number;
}

/**
 * A restored watermark whose lastTs is older than this is DISCARDED at load:
 * extending it would claim we trailed bars we never observed (the candle
 * fetch window — ~31-35 days but only per-request bars — may not even cover
 * the gap), so after a long outage it is more honest to re-anchor the trail
 * at the current close than to fire off a peak nobody was watching.
 * Normal deploys restart within minutes, so real watermarks always survive.
 */
export const MAX_RESTORED_TRAIL_MARK_AGE_MS = 7 * 86_400_000;

/**
 * Versioned persistence envelope (v1). RiskState and trail watermarks travel
 * TOGETHER so one atomic write keeps them consistent. The legacy on-disk
 * format — a flat RiskState, which is what all four prod
 * data/momentum-state-*.json files contained before the envelope — is
 * detected and up-converted by the store implementation (fileStatePersistence
 * in index.ts), never by the engine: the engine only ever sees envelopes.
 */
export interface MomentumPersistedState {
  v: 1;
  risk: RiskState;
  /** Keyed `${symbol}|${side}` — same key scheme as MomentumEngine.trailMarks. */
  trailMarks?: Record<string, TrailMark>;
  /** Entry timestamps (epoch ms) keyed `${symbol}|${side}` — the time-stop's
   *  clock anchors. Recorded on every successful open (even with the time
   *  stop OFF, so a later activation knows real entry times), pruned against
   *  live positions before any barrier can fire. Unlike trailMarks, restored
   *  entries have NO max age: an old entry time claims nothing about
   *  unobserved bars, and discarding it would reset the very clock long
   *  holds need most. */
  entryMarks?: Record<string, number>;
  /** End (epoch ms) of the last period recorded into RiskGuard's loss
   *  streak — the realised-pnl anchor. Written in the same envelope as
   *  `risk`, so a restart resumes exactly where the recorded streak ends.
   *  Absent (older files) = the legacy first-tick behavior. Shared by
   *  MomentumEngine and MeanRevEngine. */
  riskAnchorAt?: number;
}

export interface MomentumStatePersistence {
  load(): MomentumPersistedState | null;
  save(state: MomentumPersistedState): void;
}

/** Pure: a persisted realised-pnl anchor, or 0 (the legacy first-tick
 *  behavior) when absent, non-finite, non-positive or in the future. */
export function validRiskAnchor(ms: unknown, now: number): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 && ms <= now ? ms : 0;
}

/** Post-boundary offset for the aligned scheduler: tick 15s AFTER the bar
 *  boundary so the venue has actually closed/published the bar the decision
 *  reads (a tick AT the boundary can still see the previous bar). */
export const ALIGNED_TICK_OFFSET_MS = 15_000;

/** Boot grace for the extra early tick: when the next aligned tick is this
 *  close (≤5min), it IS the early tick — don't fire a redundant one. */
export const EARLY_BOOT_TICK_MIN_LEAD_MS = 5 * 60_000;

/**
 * Milliseconds from `nowMs` until the next `periodMinutes` boundary (UTC
 * epoch-aligned — the same grid exchange bars close on) plus `offsetMs`.
 * If `nowMs` is already inside [boundary, boundary+offset), returns only the
 * remainder until boundary+offset (never a full extra period). Pure — used
 * by start() below and by index.ts's stocks loop, so live ticks land on the
 * exact bar closes the backtest decides on instead of a boot-random phase
 * re-randomized on every deploy.
 */
export function nextAlignedTickDelayMs(nowMs: number, periodMinutes: number, offsetMs = ALIGNED_TICK_OFFSET_MS): number {
  const periodMs = periodMinutes * 60_000;
  const sinceBoundary = ((nowMs % periodMs) + periodMs) % periodMs;
  if (sinceBoundary < offsetMs) return offsetMs - sinceBoundary;
  return periodMs - sinceBoundary + offsetMs;
}

/**
 * Daily-or-slower cadence: has a tick already decided on the CURRENT bar?
 * The current bar's decision boundary is the last aligned boundary + offset
 * at or before `nowMs` (UTC midnight + 15s for 1440). If the persisted
 * lastEvalAt is at/after it, a boot tick would re-decide on the same closed
 * bar — the replay decides once per bar, so the boot tick is skipped (a
 * deploy, or an intraday stop that freed a slot, must not trigger a second
 * same-day decision). Sub-daily cadences always keep their early boot tick.
 */
export function alreadyDecidedThisBar(nowMs: number, periodMinutes: number, lastEvalAt: number | undefined, offsetMs = ALIGNED_TICK_OFFSET_MS): boolean {
  if (periodMinutes < 1440 || !lastEvalAt || lastEvalAt <= 0) return false;
  const periodMs = periodMinutes * 60_000;
  const sinceBoundary = ((nowMs % periodMs) + periodMs) % periodMs;
  const lastDecisionAt = sinceBoundary >= offsetMs
    ? nowMs - sinceBoundary + offsetMs
    : nowMs - sinceBoundary - periodMs + offsetMs;
  return lastEvalAt >= lastDecisionAt;
}

export interface RebalanceReport {
  timestamp: number;
  tradeable: boolean;
  blockedReason?: string;
  decisions: MomentumDecision[];
  actions: RebalanceAction[];
  unchanged: string[];
  equity: number;
  realisedPnlSinceLastRebalance: number;
  /** NEW-entry sizing factor from RiskGuard's drawdown scaling
   *  (cfg.risk.ddScale). Present ONLY when that opt-in is configured AND
   *  the risk gate evaluated this tick (valid equity) — legacy reports
   *  keep the exact pre-existing shape. Telemetry: mean scale and ticks
   *  at scale < 1 aggregate from this field. */
  entryScale?: number;
}

export class MomentumEngine {
  private cfg: MomentumEngineConfig;
  private tsm: TimeSeriesMomentum;
  private regime: RegimeFilter;
  private riskState: RiskState = { ...INITIAL_RISK_STATE };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRebalanceAt = 0;
  private running = false;
  /** Reentrancy guard for tick() — distinct from `running` (lifecycle flag,
   *  start()/stop()). Two overlapping ticks (a slow rebalance stacked against
   *  the next interval fire) would double-plan actions off the same broker
   *  read and could open a symbol twice. Mirrors BrokerSync.syncing,
   *  AccountManager.checkingStopLoss, CarryShadowEngine.ticking. */
  private ticking = false;
  /** Trailing-stop watermarks keyed by `${symbol}|${side}` (peak for longs, trough for shorts). */
  private trailMarks = new Map<string, { mark: number; lastTs: number }>();
  /** Entry timestamps (epoch ms) keyed by `${symbol}|${side}` — the time-stop's
   *  clock anchors (see MomentumPersistedState.entryMarks). */
  private entryMarks = new Map<string, number>();
  /** Shadow-equity resume (cfg.risk.shadowResume): symbols the VIRTUAL long
   *  book held at the previous tick, and their last decision closes.
   *  Deliberately EPHEMERAL (not persisted): the monetary anchors live on
   *  RiskState.shadowResume; after a mid-pause restart the first tick
   *  re-seeds holdings from that tick's ranking (one tick of zero virtual
   *  return — conservative, never fabricates a gain). */
  private shadowHeld: string[] = [];
  private shadowPrices = new Map<string, number>();

  constructor(
    cfg: Partial<MomentumEngineConfig>,
    private broker: MomentumBrokerAdapter,
    private log: MomentumEngineLogger,
    private state?: MomentumStatePersistence,
    /** Time source for every decision (LEAN/Nautilus clock seam —
     *  src/utils/clock.ts). Defaults to the system clock (production);
     *  replays inject a TestClock instead of monkeypatching the global
     *  Date object as the walk-forward script used to. */
    private clock: Clock = systemClock,
  ) {
    this.cfg = {
      ...DEFAULT_ENGINE_CONFIG,
      ...cfg,
      scorer: { ...DEFAULT_MOMENTUM_CONFIG, ...DEFAULT_ENGINE_CONFIG.scorer, ...(cfg.scorer ?? {}) },
      tsm:    { ...DEFAULT_TSM_CONFIG,      ...DEFAULT_ENGINE_CONFIG.tsm,    ...(cfg.tsm    ?? {}) },
      regime: { ...DEFAULT_REGIME_CONFIG,   ...DEFAULT_ENGINE_CONFIG.regime, ...(cfg.regime ?? {}) },
      risk:   { ...DEFAULT_RISK_CONFIG,     ...DEFAULT_ENGINE_CONFIG.risk,   ...(cfg.risk   ?? {}) },
    };
    this.tsm = new TimeSeriesMomentum(this.cfg.tsm);
    this.regime = new RegimeFilter(this.cfg.regime);
    if (this.state) {
      const loaded = this.state.load();
      if (loaded) {
        this.riskState = loaded.risk;
        this.restoreTrailMarks(loaded.trailMarks);
        this.restoreEntryMarks(loaded.entryMarks);
        this.lastRebalanceAt = validRiskAnchor(loaded.riskAnchorAt, this.clock.now());
      }
    }
    // One-shot model-cutover re-anchor (cfg.modelVersion — see its docstring):
    // a persisted state from a DIFFERENT (or pre-key) model arms the pending
    // flag; evaluateRisk applies it on the first valid equity. A fresh state
    // (peak 0) just gets stamped — nothing to re-anchor.
    if (this.cfg.modelVersion !== undefined && this.riskState.modelVersion !== this.cfg.modelVersion) {
      const hadAnchors = this.riskState.peakEquity > 0 || this.riskState.dayStartEquity > 0;
      this.riskState = {
        ...this.riskState,
        modelVersion: this.cfg.modelVersion,
        modelReanchorRev: MODEL_REANCHOR_REV,
        ...(hadAnchors ? { pendingModelReanchor: true } : {}),
      };
      if (hadAnchors) {
        this.log.info(
          `model cutover: persisted RiskState predates model "${this.cfg.modelVersion}" — ` +
          `one-shot peak + loss-streak re-anchor armed (old peak ${this.riskState.peakEquity.toFixed(2)}, inherited streak ${this.riskState.consecutiveLosses}${this.riskState.pauseReason ? `, inherited pause "${this.riskState.pauseReason}"` : ""})`,
        );
        this.persistState();
      }
    } else if (this.cfg.modelVersion !== undefined && (this.riskState.modelReanchorRev ?? 1) < MODEL_REANCHOR_REV) {
      // Stamped under revision 1, which kept the prior model's loss streak:
      // restart it once, HERE — the first tick then counts its own period
      // (which belongs to the current model) before evaluateRisk runs. A
      // streak pause is cleared by evaluateRisk (pendingStreakReanchor) so it
      // reports pause_resolved like any other. The peak is left alone.
      const inheritedStreak = this.riskState.consecutiveLosses;
      const streakPause = isLossStreakPauseReason(this.riskState.pauseReason);
      this.riskState = {
        ...this.riskState,
        consecutiveLosses: 0,
        modelReanchorRev: MODEL_REANCHOR_REV,
        ...(streakPause ? { pendingStreakReanchor: true } : {}),
      };
      this.log.info(
        `model "${this.cfg.modelVersion}": re-anchor revision ${MODEL_REANCHOR_REV} — loss streak ${inheritedStreak} ` +
        `inherited from the prior model restarted at 0${streakPause ? `; pause "${this.riskState.pauseReason}" clears on the next tick` : ""} (peak kept)`,
      );
      this.persistState();
    }
  }

  /**
   * Restore persisted trailing-stop watermarks (the deploy-restart fix: an
   * in-memory-only watermark meant every ~daily prod deploy reset the trail
   * to the CURRENT close on first sighting, so a long position never
   * accumulated a trailed peak — the "0 trail closes in v8" evidence).
   *
   * Correctness filters, in order:
   *  - malformed / non-finite / non-positive entries are dropped: a poisoned
   *    state file must never produce a NaN/negative stop level;
   *  - a mark older than MAX_RESTORED_TRAIL_MARK_AGE_MS is dropped (see the
   *    constant's docstring — don't claim to have trailed unobserved weeks);
   *  - liveness/side validity is deliberately NOT checked here (no broker
   *    read belongs in a constructor): applyTrailStops prunes every key not
   *    matching a live `${symbol}|${side}` position BEFORE any mark is read,
   *    so a restored mark for a since-closed position — or for the opposite
   *    side of a flipped one — is deleted on the first tick and can never
   *    fire a close.
   */
  private restoreTrailMarks(marks?: Record<string, TrailMark>): void {
    if (!marks || typeof marks !== "object") return;
    const now = this.clock.now();
    for (const [key, m] of Object.entries(marks)) {
      if (!m || !Number.isFinite(m.mark) || !(m.mark > 0) || !Number.isFinite(m.lastTs)) continue;
      if (now - m.lastTs > MAX_RESTORED_TRAIL_MARK_AGE_MS) continue;
      this.trailMarks.set(key, { mark: m.mark, lastTs: m.lastTs });
    }
  }

  /**
   * Restore persisted entry timestamps (time-stop clock anchors). Malformed/
   * non-finite/non-positive entries are dropped (a poisoned state file must
   * never produce a bogus expiry); there is deliberately NO age cutoff —
   * unlike a trail watermark, an entry time claims nothing about unobserved
   * bars, and an OLD anchor is exactly what the barrier needs to catch a
   * long-held zombie after an outage. Liveness is validated by
   * applyTimeStops' prune against live `${symbol}|${side}` positions before
   * any barrier can fire.
   */
  private restoreEntryMarks(marks?: Record<string, number>): void {
    if (!marks || typeof marks !== "object") return;
    for (const [key, t] of Object.entries(marks)) {
      if (!Number.isFinite(t) || !(t > 0)) continue;
      this.entryMarks.set(key, t);
    }
  }

  /**
   * Rescale this symbol's trailing-stop watermarks after a stock split
   * (ratio = new_rate/old_rate: forward 1→10 ⇒ 10; price axis ÷ratio — the
   * SAME convention as applySplitToOpenStockTrades in db/database.ts).
   * Without this, a pre-split peak (e.g. $1,200 across a 10:1 split) reads
   * the first post-split tick (~$120) as a −90% collapse and fires a
   * spurious TRAIL_STOP on the whole winner (OPEN.md P2 2026-08-29).
   * A TrailMark carries exactly one price anchor (`mark` — `lastTs` is a
   * bar timestamp, splits don't touch time), so `mark ÷ ratio` is the
   * complete adjustment. Wired from AccountManager's past-split handler via
   * EVENTS.CORPORATE_ACTION_APPLIED (index.ts) — only the tsmTrail sleeve
   * subscribes. Silent no-op when the symbol has no mark (both sides
   * checked); a non-finite/non-positive ratio is a no-op with an error log.
   */
  scaleMarksForSplit(symbol: string, ratio: number): void {
    if (!Number.isFinite(ratio) || !(ratio > 0)) {
      this.log.error(`scaleMarksForSplit ${symbol}: invalid split ratio ${ratio} — trail marks left untouched`);
      return;
    }
    if (ratio === 1) return;
    const prefix = `${symbol}|`;
    let changed = 0;
    for (const [key, state] of this.trailMarks) {
      if (!key.startsWith(prefix)) continue;
      const before = state.mark;
      state.mark = before / ratio;
      changed++;
      this.log.info(`scaleMarksForSplit ${key}: trail watermark ${before} → ${state.mark} (split ratio ${ratio})`);
    }
    if (changed > 0) this.persistState();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log.info(`MomentumEngine starting: universe=[${this.cfg.universe.join(",")}], rebalance every ${this.cfg.rebalanceMinutes}min`);
    if (this.cfg.heartbeatName) heartbeats.register(this.cfg.heartbeatName, this.cfg.rebalanceMinutes * 60_000);
    // Bar-close-aligned scheduler (recursive setTimeout, NOT setInterval):
    // every tick fires at a rebalanceMinutes boundary + 15s, so live decides
    // on the JUST-CLOSED bar exactly like the backtest does — the old
    // boot-anchored setInterval gave each deploy a random phase inside the
    // bar. The next delay is computed AFTER the tick completes, so a slow
    // tick can't stack (tick() is reentrancy-guarded anyway) and any drift
    // re-anchors to the next boundary.
    const scheduleAligned = () => {
      if (!this.running) return;
      this.timer = setTimeout(async () => {
        try {
          await this.tick();
        } catch (e: any) {
          this.log.error(`tick failed: ${e.message}`);
        }
        scheduleAligned();
      }, nextAlignedTickDelayMs(this.clock.now(), this.cfg.rebalanceMinutes));
    };
    // Early boot tick (restored positions need management NOW after a
    // restart, don't await it — data fetch can take a while) — but only when
    // the next boundary is far away; if it's imminent (≤5min), the aligned
    // tick IS the early tick.
    // Daily-or-slower cadence (momentum_crypto_usdc since 2026-09-26): skip
    // the boot tick when a tick already decided on the current bar — one
    // decision per closed bar, like the replay; a restart after 00:00:15 UTC
    // without a completed tick still catches up.
    const decidedThisBar = alreadyDecidedThisBar(this.clock.now(), this.cfg.rebalanceMinutes, this.riskState.lastEvalAt);
    if (decidedThisBar) {
      this.log.info(`early boot tick skipped: this ${this.cfg.rebalanceMinutes}min bar was already decided (last eval ${new Date(this.riskState.lastEvalAt!).toISOString()})`);
    } else if (nextAlignedTickDelayMs(this.clock.now(), this.cfg.rebalanceMinutes) > EARLY_BOOT_TICK_MIN_LEAD_MS) {
      setTimeout(() => this.tick().catch(e => this.log.error(`first tick failed: ${e.message}`)), 1000);
    }
    scheduleAligned();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Shutdown flush: watermarks raised since the last risk-driven persist
    // (e.g. trail extensions on a tick whose equity read failed, which skips
    // the in-tick persists by design) must survive the restart that is
    // usually the very reason stop() is running.
    this.persistState();
    this.log.info("MomentumEngine stopped");
  }

  /** Public for test injection — runs one rebalance and returns the report. */
  async tick(): Promise<RebalanceReport> {
    if (this.ticking) {
      this.log.warn("MomentumEngine tick: previous tick still in progress — skipping this cycle (reentrancy guard)");
      return this.skippedTickReport();
    }
    this.ticking = true;
    try {
      return await this.runTick();
    } finally {
      this.ticking = false;
    }
  }

  private skippedTickReport(): RebalanceReport {
    return {
      timestamp: this.clock.now(),
      tradeable: false,
      blockedReason: "tick already in progress (reentrancy guard)",
      decisions: [],
      actions: [],
      unchanged: [],
      equity: 0,
      realisedPnlSinceLastRebalance: 0,
    };
  }

  private async runTick(): Promise<RebalanceReport> {
    const now = this.clock.now();
    const { equity, valid: equityValid, error: equityError } = await this.readEquity();
    if (!equityValid) {
      this.log.error(`MomentumEngine tick: equity unavailable (${equityError}) — RiskGuard frozen, opens blocked; trailing-stop/close logic still runs best-effort`);
    }

    let realised = 0;
    let realisedValid = true;
    if (this.lastRebalanceAt > 0) {
      // A non-finite return is the same failure class as a throw: NaN makes
      // every RiskGuard comparison false (the streak silently freezes while
      // the anchor would advance, losing the interval forever) and Infinity
      // can RESET a real loss streak. One failure branch handles both.
      let failure: string | undefined;
      try {
        realised = await this.broker.getRealisedPnlSince(this.lastRebalanceAt);
        if (!Number.isFinite(realised)) failure = `returned non-finite ${realised}`;
      } catch (e: any) {
        failure = e.message;
      }
      if (failure !== undefined) {
        realisedValid = false;
        realised = 0; // parity with the throw path — never leak NaN/Infinity into the report
        this.log.error(`MomentumEngine tick: getRealisedPnlSince failed (${failure}) — RiskGuard loss-streak counter frozen this tick (a DB read failure must never look like a flat/zero period); opens blocked, anchor NOT advanced`);
        // Page directly: at rebalance cadence (60-240min) these errors can
        // never reach the logger's 10-in-60s ERROR_BURST threshold on their
        // own, so a persistent failure would otherwise stay silent for days.
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "MomentumEngine",
          message: `getRealisedPnlSince failed (${failure}) — loss-streak breaker frozen, opens blocked`,
          count: 1, windowMs: 0, firstAt: now, lastAt: now,
        });
      }
    }

    // Update streak counter from the previous period's outcome — SKIPPED
    // when equity OR the realised-pnl read is invalid: a frozen/unknown
    // value must never mutate or persist RiskGuard state.
    // The anchor advances in the SAME step and both reach disk in one
    // envelope: a restart resumes exactly where the recorded streak ends —
    // no period dropped, none counted twice. (Until 2026-10-03 the anchor
    // lived in memory only, so every restart's first tick skipped its
    // period: XRP −$6.27 closed 18:00, deploy restart 18:20 on 2026-10-02.)
    if (equityValid && realisedValid) {
      if (this.lastRebalanceAt > 0) this.riskState = recordRebalanceOutcome(this.riskState, realised);
      this.lastRebalanceAt = now;
      this.persistState();
    }

    // Fetch candles for the universe (parallel).
    const candleEntries = await Promise.all(
      this.cfg.universe.map(async (sym): Promise<[string, OHLCV[]]> => {
        try {
          const c = await this.broker.fetchCandles(sym, this.cfg.historyBars);
          return [sym, c];
        } catch (e: any) {
          this.log.warn(`fetchCandles ${sym} failed: ${e.message}`);
          return [sym, []];
        }
      }),
    );
    const candles = new Map<string, OHLCV[]>();
    for (const [sym, c] of candleEntries) if (c.length > 0) candles.set(sym, c);

    // Vol-regime trailing stop (flag-gated): exits are managed BEFORE the
    // risk/regime gates so held positions get trailed even while blocked.
    const trailActions = this.cfg.tsmTrail ? await this.applyTrailStops(candles) : [];
    // Time barrier (flag-gated, OFF by default): same placement discipline —
    // an expired hold must close even while entries are blocked.
    const timeStopActions = this.cfg.timeStop ? await this.applyTimeStops(now) : [];
    const trailClosedSymbols = new Set([...trailActions, ...timeStopActions].map(a => a.symbol));

    // Risk gate — SKIPPED when equity is invalid (no evaluate/mutate/persist
    // of RiskGuard state). Entries are forced blocked instead; exits below
    // are entry-only gated so legitimate closes still run.
    let canOpen: boolean;
    let riskBlockedReason: string | undefined;
    // Drawdown-scaled entry sizing (cfg.risk.ddScale, opt-in): factor in
    // (0, 1] multiplied into NEW-entry notional below. undefined when the
    // opt-in is off OR equity is invalid (entries are force-blocked then).
    let entryScale: number | undefined;
    if (equityValid) {
      const riskCheck = evaluateRisk(this.riskState, equity, now, this.cfg.risk as RiskGuardConfig);
      this.emitPauseTransition(this.riskState, now, riskCheck); // BEFORE overwrite — needs the pre-call state
      this.riskState = riskCheck.state;
      canOpen = riskCheck.canOpen;
      riskBlockedReason = riskCheck.reason;
      entryScale = riskCheck.entryScale;
      // Shadow-equity resume (cfg.risk.shadowResume, opt-in — see the
      // RiskGuardConfig docstring): tracks the would-be long book's virtual
      // equity through a soft-drawdown pause and lifts the pause the moment
      // the STRATEGY recovers, re-anchoring the peak to real equity. Runs on
      // the same decision candles this tick fetched; a resume unblocks
      // entries THIS tick (the plan below executes at the next bar open,
      // exactly like any unpaused tick).
      if (this.cfg.risk.shadowResume) {
        const resumed = this.updateShadowResume(candles, equity, now);
        if (resumed) {
          canOpen = true;
          riskBlockedReason = undefined;
        }
      }
      this.persistState();
    } else {
      canOpen = false;
      riskBlockedReason = `equity unavailable: ${equityError}`;
    }

    // Same fail-closed pattern as invalid equity: a frozen loss-streak
    // breaker (realised read failed, see above) must not keep authorizing
    // NEW entries — block opens, let exits below run normally.
    if (!realisedValid && canOpen) {
      canOpen = false;
      riskBlockedReason = "realised-pnl read failed: loss-streak breaker frozen";
    }

    // Regime gate
    const regimeCheck = this.regime.assess(candles);

    // Market-trend gate (flag-gated, entries-only — see the marketTrend
    // config docstring). Evaluated every tick so gateBlocks attribution is
    // honest even when another gate also blocks; the blockedReason chain
    // below keeps the risk/regime reasons' priority.
    const trendCheck = this.cfg.marketTrend ? await this.evaluateMarketTrendGate() : { blocked: false as const };

    // Maintenance kill-switch gate (TRADING_ENABLED=false, src/config/
    // index.ts): blocks ONLY new opens. Entry-only, exactly like the risk/
    // regime gates above — trail stops and plan closes below still execute,
    // so existing positions never lose management. Filtering here (before
    // the adapter is ever called) keeps sleeveOutput's consecutive-open-
    // failure pager quiet: a host in maintenance must not page "sleeve
    // producing NOTHING".
    const tradingDisabled = !isTradingEnabled();
    const blocked = tradingDisabled || !canOpen || !regimeCheck.tradeable || trendCheck.blocked;
    const blockedReason = tradingDisabled
      ? "TRADING_ENABLED=false (maintenance kill-switch)"
      : !canOpen ? riskBlockedReason
      : !regimeCheck.tradeable ? regimeCheck.reason
      : trendCheck.blocked ? trendCheck.reason
      : undefined;
    if (blocked) {
      this.log.warn(`MomentumEngine new entries BLOCKED: ${blockedReason}`);
    } else if (entryScale !== undefined && entryScale < 1) {
      // Telemetry for the continuous dd-scaling regime: not blocked, but
      // NEW entries are sized down proportionally to the drawdown cushion.
      this.log.info(`dd scale: NEW entries sized at ${(entryScale * 100).toFixed(0)}% of base notional`);
    }

    // Score, plan, execute.
    const positions = await this.broker.getOpenPositions();
    const universeSet = new Set(this.cfg.universe);
    let universePositions = positions.filter(p => universeSet.has(p.symbol));

    // Model cutover (opt-in, one-shot — see reunderwriteBefore's docstring):
    // positions underwritten by a prior model/regime are closed BEFORE the
    // ranking, unconditionally (closes are never gated, same discipline as
    // trail/time stops above). A successfully closed symbol is removed from
    // this tick's position snapshot so the ranking/plan below treat it as
    // NOT held (no slotHysteresis privilege, fresh entry thresholds, current
    // slot size, gross-cap seed excludes it). A failed close stays held and
    // is retried next tick.
    const cutoverActions: RebalanceAction[] = [];
    if (this.cfg.reunderwriteBefore !== undefined) {
      const boundary = this.cfg.reunderwriteBefore;
      for (const p of universePositions) {
        if (!(typeof p.entryTime === "number" && p.entryTime > 0 && p.entryTime < boundary)) continue;
        const reason = `model cutover: entry ${new Date(p.entryTime).toISOString()} predates re-underwrite boundary ${new Date(boundary).toISOString()}`;
        try {
          const res = await this.broker.closePosition({ symbol: p.symbol, side: p.side, closeReason: MODEL_CUTOVER_CLOSE_REASON });
          if (res.ok) {
            const key = `${p.symbol}|${p.side}`;
            this.trailMarks.delete(key);
            this.entryMarks.delete(key); // hold ended — a same-tick re-open re-anchors both
            cutoverActions.push({ type: "close", symbol: p.symbol, side: p.side, reason });
            this.log.info(`MomentumEngine ${p.symbol} ${reason}`);
          } else {
            this.log.warn(`model-cutover close ${p.symbol} failed: ${res.reason} — position stays held, retried next tick`);
          }
        } catch (e: any) {
          this.log.error(`model-cutover close ${p.symbol} threw: ${e.message}`);
        }
      }
      if (cutoverActions.length > 0) {
        const closedKeys = new Set(cutoverActions.map(a => `${a.symbol}|${a.side}`));
        universePositions = universePositions.filter(p => !closedKeys.has(`${p.symbol}|${p.side}`));
      }
    }

    const heldSymbols = new Set(universePositions.filter(p => p.side === "buy").map(p => p.symbol));
    const heldShorts = new Set(universePositions.filter(p => p.side === "sell").map(p => p.symbol));
    // PIT entry-eligibility (cfg.entryEligibility, opt-in — see docstring):
    // ineligible symbols leave the ranking candidate set unless held, so a
    // NEW entry can never take a slot; held ones keep normal stay/exit
    // logic and their slot privilege. Absent hook = the exact same map.
    let rankCandles = candles;
    if (this.cfg.entryEligibility) {
      rankCandles = new Map<string, OHLCV[]>();
      for (const [sym, c] of candles) {
        if (heldSymbols.has(sym) || heldShorts.has(sym) || this.cfg.entryEligibility(sym, now)) rankCandles.set(sym, c);
      }
    }
    let decisions = this.tsm.rank(rankCandles, heldSymbols, heldShorts);

    // Rolling-Sharpe entry gate (flag-gated): NEW entries only — held
    // positions keep their normal stay/exit logic. Fails open (null) on
    // insufficient history.
    if (this.cfg.sharpeGate) {
      const { lookbackDays, minSharpe } = this.cfg.sharpeGate;
      decisions = decisions.map(d => {
        if (d.action === "flat") return d;
        const alreadyHeld = d.action === "long" ? heldSymbols.has(d.symbol) : heldShorts.has(d.symbol);
        if (alreadyHeld) return d;
        const closes = (candles.get(d.symbol) ?? []).map(c => c.close);
        const s = rollingSharpe(closes, lookbackDays, this.barsPerDay());
        if (s !== null && s < minSharpe) {
          return { ...d, action: "flat" as const, reason: `sharpe gate: ${s.toFixed(2)} < ${minSharpe} (${lookbackDays}d)` };
        }
        return d;
      });
    }

    // A symbol trail- or time-stopped THIS tick sits out one tick — otherwise
    // the rebalance below would re-open it at the same price (fee churn only;
    // for the time stop it would also reset the barrier's clock for free).
    if (trailClosedSymbols.size > 0) {
      decisions = decisions.map(d =>
        d.action !== "flat" && trailClosedSymbols.has(d.symbol)
          ? { ...d, action: "flat" as const, reason: "protective-stopped this tick" }
          : d,
      );
    }

    // ddScale factor multiplies the base slot notional, COMPOSING with the
    // per-symbol volTarget scaling below (dd × vol, both entries-only).
    // `?? 1` keeps the legacy product bit-identical (x * 1 === x in IEEE754)
    // when the opt-in is off. Held positions are never resized: the plan's
    // notional only reaches OPEN actions (Rebalancer.planRebalance).
    const baseNotional = equity * this.cfg.notionalPctPerSlot * (entryScale ?? 1);
    let notionalBySymbol: Map<string, number> | undefined;
    if (this.cfg.volTarget) {
      const barsPerYear = this.barsPerDay() * 365;
      notionalBySymbol = new Map();
      for (const d of decisions) {
        if (d.action === "flat") continue;
        const closes = (candles.get(d.symbol) ?? []).map(c => c.close);
        notionalBySymbol.set(d.symbol, baseNotional * volTargetScale(closes, this.cfg.volTarget, barsPerYear));
      }
    }
    // Inverse-volatility entry sizing (cfg.volSizing, opt-in — see the config
    // docstring): clamp(σ_ref/σᵢ) multiplies the slot notional for NEW
    // entries only. σ_ref = median σ across universe symbols with sufficient
    // history THIS tick; composes multiplicatively with volTarget above.
    if (this.cfg.volSizing) {
      const vs = this.cfg.volSizing;
      const sigmas = new Map<string, number>();
      for (const sym of this.cfg.universe) {
        const closes = (candles.get(sym) ?? []).map(c => c.close);
        const sigma = volSizingSigma(closes, vs.lookbackBars);
        if (sigma !== null) sigmas.set(sym, sigma);
      }
      const sigmaRef = medianOf([...sigmas.values()]);
      if (sigmaRef !== null && sigmaRef > 0) {
        notionalBySymbol ??= new Map();
        for (const d of decisions) {
          if (d.action === "flat") continue;
          const sigma = sigmas.get(d.symbol);
          // Fail open to 1 (unscaled) for a symbol without a usable σ.
          const scale = sigma !== undefined
            ? Math.min(vs.maxScale, Math.max(vs.minScale, sigmaRef / sigma))
            : 1;
          notionalBySymbol.set(d.symbol, (notionalBySymbol.get(d.symbol) ?? baseNotional) * scale);
        }
      }
    }
    // Rankers omit symbols whose history is unusable. A held omission means
    // "no decision", not "flat"; keep it until usable candles return.
    const decidedSymbols = new Set(decisions.map(d => d.symbol));
    const heldWithoutDecision = universePositions.filter(p => !decidedSymbols.has(p.symbol));
    const plan = planRebalance({
      decisions,
      currentPositions: universePositions.filter(p => decidedSymbols.has(p.symbol)),
      notionalPerSlot: baseNotional,
      notionalBySymbol,
    });
    plan.unchanged.push(...heldWithoutDecision.map(p => p.symbol));

    // If any held symbol is undecidable, it still occupies capital/slot. Exits
    // for decidable holdings may run, but block all fresh opens until data returns.
    const hasUndecidableHold = heldWithoutDecision.length > 0;

    // Always execute closes BEFORE opens (free up capital, avoid margin issues).
    // (Trail closes were already executed inside applyTrailStops.)
    // Risk and regime gates are entry-only: exits still execute while blocked.
    const allowed = (blocked || hasUndecidableHold) ? plan.actions.filter(a => a.type === "close") : plan.actions;
    const ordered = [...allowed.filter(a => a.type === "close"), ...allowed.filter(a => a.type === "open")];
    // Output-liveness accounting (src/ops/sleeveOutput.ts): every open result
    // feeds the consecutive-failure signal (the shadow_momentum_crypto "77
    // failures, 0 rows, nobody noticed" class); opens/closes count as output
    // for the productive-silence signal. Keyed by heartbeatName — every wired
    // sleeve has one; tests without it skip the monitor (no DB writes).
    const sleeve = this.cfg.heartbeatName;
    const executed = [...trailActions, ...timeStopActions, ...cutoverActions];
    if (sleeve && executed.length > 0) sleeveOutput.recordClose(sleeve);
    // Gross-exposure guard bookkeeping (see maxGrossExposureMult docstring):
    // local running total, no extra broker reads. Seeded from THIS tick's
    // pre-loop position snapshot (universePositions) and updated in lockstep
    // as closes/opens execute below, so it stays accurate without re-fetching.
    const notionalBySymbolSide = new Map(universePositions.map(p => [`${p.symbol}|${p.side}`, Math.abs(p.notional)]));
    let liveGrossNotional = universePositions.reduce((s, p) => s + Math.abs(p.notional), 0);
    for (const a of ordered) {
      try {
        if (a.type === "close") {
          // Plan-computed canonical label (today only SLOT_DISPLACED, from the
          // Rebalancer) rides along exactly like the TRAIL_STOP/TIME_STOP
          // closes above; absent → the adapter's default rebalance label.
          const res = await this.broker.closePosition({ symbol: a.symbol, side: a.side, ...(a.closeReason ? { closeReason: a.closeReason } : {}) });
          if (res.ok) {
            executed.push(a);
            liveGrossNotional -= notionalBySymbolSide.get(`${a.symbol}|${a.side}`) ?? 0;
            this.entryMarks.delete(`${a.symbol}|${a.side}`); // hold ended — drop the clock anchor
            if (sleeve) sleeveOutput.recordClose(sleeve);
          }
          else this.log.warn(`close ${a.symbol} failed: ${res.reason}`);
        } else {
          const notionalUsd = a.notionalTarget ?? 0;
          if (this.cfg.maxGrossExposureMult !== undefined && equityValid) {
            const cap = equity * this.cfg.maxGrossExposureMult;
            if (liveGrossNotional + notionalUsd > cap) {
              const reason = `gross exposure cap: live $${liveGrossNotional.toFixed(0)} + new $${notionalUsd.toFixed(0)} would exceed ${this.cfg.maxGrossExposureMult}× equity ($${cap.toFixed(0)} on $${equity.toFixed(0)} equity)`;
              this.log.warn(`open ${a.symbol} BLOCKED by ${reason}`);
              // Policy veto, never reached the broker — see sleeveOutput's
              // isPolicyPreventedReason docstring (B-ops-alerts.md #4).
              if (sleeve) sleeveOutput.recordPreventedByPolicy(sleeve, reason);
              continue;
            }
          }
          // %ADV capacity check (capacityGuard docstring): observe warns,
          // enforce vetoes; uncomputable ADV$ fails OPEN with a log.
          if (this.cfg.capacityGuard) {
            const cg = this.cfg.capacityGuard;
            const adv = averageDailyDollarVolume(candles.get(a.symbol) ?? [], cg.lookbackBars, this.barsPerDay());
            if (adv === null) {
              this.log.warn(`capacity guard ${a.symbol}: ADV$ not computable (short/missing volume history) — fail-open, entry allowed`);
            } else if (notionalUsd > adv * (cg.maxAdvPct / 100)) {
              const reason = `capacity guard: entry $${notionalUsd.toFixed(0)} > ${cg.maxAdvPct}% of ADV$ $${adv.toFixed(0)} (${cg.lookbackBars}d)`;
              if (cg.mode === "enforce") {
                this.log.warn(`open ${a.symbol} BLOCKED by ${reason}`);
                if (sleeve) sleeveOutput.recordPreventedByPolicy(sleeve, reason);
                continue;
              }
              this.log.warn(`open ${a.symbol} ${reason} — observe mode, entry proceeds`);
              if (sleeve) sleeveOutput.recordCapacityObservation(sleeve, reason);
            }
          }
          // Vol-scaled hard stop (volStop docstring): distance from the SAME
          // decision closes the trail uses; fails open to maxPct inside
          // trailPctFromVol when history is short/degenerate.
          const stopLossPct = this.cfg.volStop
            ? trailPctFromVol((candles.get(a.symbol) ?? []).map(c => c.close), this.cfg.volStop, this.barsPerDay())
            : undefined;
          const res = await this.broker.openPosition({ symbol: a.symbol, side: a.side, notionalUsd, ...(stopLossPct !== undefined ? { stopLossPct } : {}) });
          if (res.ok) {
            executed.push(a);
            liveGrossNotional += notionalUsd;
            // Record the TRUE entry time even with the time stop OFF, so a
            // later activation measures real holds instead of first-sightings.
            this.entryMarks.set(`${a.symbol}|${a.side}`, now);
            if (sleeve) sleeveOutput.recordOpenSuccess(sleeve);
          }
          else {
            this.log.warn(`open ${a.symbol} failed: ${res.reason}`);
            // A RiskEngine deny / maintenance kill-switch is sound risk
            // management working, not a broken open path — see
            // isPolicyPreventedReason (B-ops-alerts.md #4).
            if (sleeve) {
              if (isPolicyPreventedReason(res.reason)) sleeveOutput.recordPreventedByPolicy(sleeve, res.reason);
              else sleeveOutput.recordOpenFailure(sleeve, res.reason);
            }
          }
        }
      } catch (e: any) {
        this.log.error(`action ${a.type} ${a.symbol} threw: ${e.message}`);
        if (a.type === "open" && sleeve) sleeveOutput.recordOpenFailure(sleeve, e.message);
      }
    }
    // Tick recorded AFTER outputs so a pass that finally produces something
    // resets the silence counter before the check runs (no page on recovery).
    if (sleeve) sleeveOutput.recordTick(sleeve);

    // A tick with invalid equity OR a failed realised-pnl read is not a
    // successful rebalance: the lookback anchor did not advance (see the
    // streak update above) and the liveness heartbeat is not beaten — a
    // persistently broken feed must surface as a stale-loop page, not hide
    // behind "the loop is still ticking". Anchor discipline: lastRebalanceAt
    // advances iff this tick's interval was recorded (same
    // equityValid&&realisedValid predicate), so on recovery the next
    // successful read covers the FULL window since the last RECORDED
    // interval — a failed read's losses are recovered, never dropped, and
    // never double-counted.

    this.log.info(
      `Rebalance done: equity=$${equity.toFixed(2)}, ${executed.filter(a => a.type === "close").length} close, ${executed.filter(a => a.type === "open").length} open, ${plan.unchanged.length} hold. Realised since last: ${realisedValid ? `$${realised.toFixed(2)}` : "unknown (read failed)"}`
    );

    if (equityValid && realisedValid) this.beatHeartbeat();
    return {
      timestamp: now,
      tradeable: !blocked,
      blockedReason,
      decisions,
      actions: executed,
      unchanged: plan.unchanged,
      equity,
      realisedPnlSinceLastRebalance: realised,
      // Key present ONLY under ddScale — legacy reports stay byte-identical.
      ...(entryScale !== undefined ? { entryScale } : {}),
    };
  }

  private barsPerDay(): number {
    return (24 * 60) / (this.cfg.tsm.barMinutes ?? DEFAULT_TSM_CONFIG.barMinutes);
  }

  /**
   * Market-trend gate evaluation (cfg.marketTrend REQUIRED by the caller).
   * Causal: fetchDailyCloses only ever supplies CLOSED UTC daily bars.
   * FAIL-OPEN contract (documented on the config field): adapter without
   * fetchDailyCloses, a throwing/empty fetch, or fewer than maDays closed
   * days all return { blocked: false } with a warn log — missing data may
   * never freeze entries the way the soft-DD lockout does.
   */
  private async evaluateMarketTrendGate(): Promise<{ blocked: boolean; reason?: string }> {
    const { symbol, maDays } = this.cfg.marketTrend!;
    if (!this.broker.fetchDailyCloses) {
      this.log.warn(`market trend gate: adapter has no fetchDailyCloses — failing OPEN (${symbol} SMA${maDays} unenforced)`);
      return { blocked: false };
    }
    let closes: number[];
    try {
      closes = await this.broker.fetchDailyCloses(symbol, maDays);
    } catch (e: any) {
      this.log.warn(`market trend gate: fetchDailyCloses ${symbol} failed (${e.message}) — failing OPEN`);
      return { blocked: false };
    }
    const verdict = marketTrendBlocked(closes, maDays);
    if (verdict === null) {
      this.log.warn(`market trend gate: ${closes?.length ?? 0} closed daily closes for ${symbol} (< ${maDays} or degenerate) — failing OPEN`);
      return { blocked: false };
    }
    if (!verdict) return { blocked: false };
    const window = closes.slice(-maDays);
    const sma = window.reduce((s, x) => s + x, 0) / maDays;
    const last = window[window.length - 1];
    // Reason format matters: normalizeGateReason buckets on the part before
    // the first ":" → gateBlocks key "market trend" (vs "soft drawdown").
    return { blocked: true, reason: `market trend: ${symbol} daily close ${last} < SMA${maDays} ${sma.toFixed(2)}` };
  }

  /**
   * Vol-regime trailing stop: for each held universe position, track the
   * best close since entry (peak for longs, trough for shorts) across ALL
   * bar closes seen (including bars between ticks, via candle history) and
   * close when price retraces more than trailPctFromVol from it. Executes
   * the closes on the broker immediately; returns the actions taken.
   */
  private async applyTrailStops(candles: Map<string, OHLCV[]>): Promise<RebalanceAction[]> {
    const cfg = this.cfg.tsmTrail!;
    const actions: RebalanceAction[] = [];
    let positions: CurrentPosition[];
    try {
      positions = await this.broker.getOpenPositions();
    } catch (e: any) {
      this.log.warn(`trail stop: getOpenPositions failed: ${e.message}`);
      return actions;
    }
    const universeSet = new Set(this.cfg.universe);
    const held = positions.filter(p => universeSet.has(p.symbol));

    // Drop watermarks for positions that no longer exist (closed elsewhere).
    // This prune ALSO validates restored marks (restoreTrailMarks): running
    // before any mark is read below, it deletes a persisted mark whose
    // position was closed while the process was down, or whose side no
    // longer matches (a flipped position produces a different `symbol|side`
    // key) — a restored watermark only ever applies to the SAME live position.
    const liveKeys = new Set(held.map(p => `${p.symbol}|${p.side}`));
    for (const key of this.trailMarks.keys()) if (!liveKeys.has(key)) this.trailMarks.delete(key);

    for (const p of held) {
      const series = candles.get(p.symbol) ?? [];
      if (series.length === 0) continue;
      const closes = series.map(c => c.close);
      const px = closes[closes.length - 1];
      if (!(px > 0)) continue;

      const key = `${p.symbol}|${p.side}`;
      const long = p.side === "buy";
      let state = this.trailMarks.get(key);
      if (!state) {
        // First sighting (position opened last tick, or engine restart):
        // start the watermark at the current close.
        state = { mark: px, lastTs: series[series.length - 1].timestamp };
      } else {
        // Extend the watermark over every bar close since the last update —
        // this is what "trail on bar closes between ticks" means.
        for (let i = series.length - 1; i >= 0 && series[i].timestamp > state.lastTs; i--) {
          const c = series[i].close;
          if (long ? c > state.mark : c < state.mark) state.mark = c;
        }
        state.lastTs = series[series.length - 1].timestamp;
      }
      this.trailMarks.set(key, state);

      const trailPct = trailPctFromVol(closes, cfg, this.barsPerDay()) / 100;
      const stop = long ? state.mark * (1 - trailPct) : state.mark * (1 + trailPct);
      const hit = long ? px <= stop : px >= stop;
      if (!hit) continue;

      const reason = `trail stop: px ${px.toFixed(4)} through ${(trailPct * 100).toFixed(2)}% from ${long ? "peak" : "trough"} ${state.mark.toFixed(4)}`;
      try {
        // closeReason: canonical TRAIL_STOP label → trades.close_reason, so
        // telemetry can separate trail exits from signal-flip rebalances.
        const res = await this.broker.closePosition({ symbol: p.symbol, side: p.side, closeReason: TRAIL_STOP_CLOSE_REASON });
        if (res.ok) {
          this.trailMarks.delete(key);
          this.entryMarks.delete(key); // hold ended — drop the time-stop anchor
          actions.push({ type: "close", symbol: p.symbol, side: p.side, reason });
          this.log.info(`MomentumEngine ${p.symbol} ${reason}`);
        } else {
          this.log.warn(`trail close ${p.symbol} failed: ${res.reason}`);
        }
      } catch (e: any) {
        this.log.error(`trail close ${p.symbol} threw: ${e.message}`);
      }
    }
    return actions;
  }

  /**
   * Time barrier (López de Prado's third barrier; flag-gated via
   * cfg.timeStop): close any held universe position whose clock anchor is
   * ≥ maxHoldHours old. Runs right after applyTrailStops, BEFORE the risk/
   * regime/kill-switch gates — an expired hold must close even while entries
   * are blocked. A position with no anchor (opened before the feature/state
   * existed, or state lost) is anchored at NOW and never fired on first
   * sighting — conservative: it restarts the clock rather than fabricating
   * an expiry we didn't measure (persistence makes this the rare path;
   * normal deploys restore real anchors).
   */
  private async applyTimeStops(now: number): Promise<RebalanceAction[]> {
    const cfg = this.cfg.timeStop!;
    const actions: RebalanceAction[] = [];
    let positions: CurrentPosition[];
    try {
      positions = await this.broker.getOpenPositions();
    } catch (e: any) {
      this.log.warn(`time stop: getOpenPositions failed: ${e.message}`);
      return actions;
    }
    const universeSet = new Set(this.cfg.universe);
    const held = positions.filter(p => universeSet.has(p.symbol));

    // Prune anchors for positions that no longer exist (closed elsewhere, or
    // side flipped → different key). Runs before any anchor is read, so a
    // restored anchor only ever applies to the SAME live position — the
    // trailMarks liveness pattern.
    const liveKeys = new Set(held.map(p => `${p.symbol}|${p.side}`));
    for (const key of this.entryMarks.keys()) if (!liveKeys.has(key)) this.entryMarks.delete(key);

    const maxHoldMs = cfg.maxHoldHours * 3_600_000;
    for (const p of held) {
      const key = `${p.symbol}|${p.side}`;
      const entryAt = this.entryMarks.get(key);
      if (entryAt === undefined) {
        this.entryMarks.set(key, now);
        continue;
      }
      if (now - entryAt < maxHoldMs) continue;
      const reason = `time stop: held ${((now - entryAt) / 3_600_000).toFixed(1)}h >= ${cfg.maxHoldHours}h`;
      try {
        // closeReason: canonical TIME_STOP label → trades.close_reason, so
        // telemetry separates horizon expiries from signal-flip rebalances.
        const res = await this.broker.closePosition({ symbol: p.symbol, side: p.side, closeReason: TIME_STOP_CLOSE_REASON });
        if (res.ok) {
          this.entryMarks.delete(key);
          this.trailMarks.delete(key); // position gone — its watermark with it
          actions.push({ type: "close", symbol: p.symbol, side: p.side, reason });
          this.log.info(`MomentumEngine ${p.symbol} ${reason}`);
        } else {
          this.log.warn(`time-stop close ${p.symbol} failed: ${res.reason}`);
        }
      } catch (e: any) {
        this.log.error(`time-stop close ${p.symbol} threw: ${e.message}`);
      }
    }
    return actions;
  }

  private persistState() {
    // RiskState + trail watermarks + time-stop entry anchors in ONE v1
    // envelope, so the store's single atomic tmp+rename write (index.ts)
    // keeps them mutually consistent. On a normal tick this runs right after
    // applyTrailStops (the evaluateRisk persist), so a mark raised or
    // cleared this tick reaches disk the same tick; stop() flushes the
    // equity-invalid-tick corner.
    if (this.state) {
      this.state.save({
        v: 1,
        risk: this.riskState,
        trailMarks: Object.fromEntries(this.trailMarks),
        entryMarks: Object.fromEntries(this.entryMarks),
        ...(this.lastRebalanceAt > 0 ? { riskAnchorAt: this.lastRebalanceAt } : {}),
      });
    }
  }

  /**
   * Shadow-equity resume (cfg.risk.shadowResume — see RiskGuardConfig):
   * while the sleeve sits in a SOFT-drawdown pause, maintain a VIRTUAL
   * equity of the long book the TSM ranking would hold — same slot logic
   * (a second rank() call with the VIRTUAL holdings, so stay/exit
   * hysteresis applies exactly as it would live), each slot at
   * notionalPctPerSlot of virtual equity, net of an estimated
   * costBpsPerSide on every virtual entry/exit. The pause lifts when the
   * strategy demonstrably works again: virtual equity ≥ startEquity ×
   * (1 + recoverPct), or above the pre-pause peak. On resume the
   * drawdown reference peak re-anchors to CURRENT real equity (the old
   * peak must not re-arm the pause immediately) and the tracker drops.
   * Only soft-drawdown pauses are ever lifted; a hard/daily/streak pause
   * (or natural recovery) clears the tracker without touching anything.
   * Returns true iff the pause was lifted this call. Mutates this.riskState;
   * the caller persists.
   */
  private updateShadowResume(candles: Map<string, OHLCV[]>, equity: number, now: number): boolean {
    const cfg = this.cfg.risk.shadowResume!;
    const st = this.riskState;
    const softPaused = st.pausedUntil > now && isSoftDrawdownPauseReason(st.pauseReason);
    if (!softPaused) {
      // Natural recovery, expiry, or a non-soft pause: episode over (or not
      // ours to track) — drop the tracker and the ephemeral book.
      if (st.shadowResume) {
        const { shadowResume: _dropped, ...rest } = st;
        this.riskState = rest;
      }
      this.shadowHeld = [];
      this.shadowPrices.clear();
      return false;
    }

    const lastClose = (sym: string): number => {
      const series = candles.get(sym);
      const px = series && series.length > 0 ? series[series.length - 1].close : 0;
      return px > 0 ? px : 0;
    };

    let tracker = st.shadowResume;
    if (!tracker) {
      // Episode start (the breach tick, or first tick after a restart that
      // lost the tracker): anchor at the current REAL equity.
      tracker = { equity, startEquity: equity, peakRef: st.peakEquity };
      this.shadowHeld = [];
      this.shadowPrices.clear();
    } else {
      // Fold the previous holdings' close-to-close returns into the virtual
      // equity: each slot carries notionalPctPerSlot of virtual equity
      // (matching live base sizing; volTarget/ddScale deliberately not
      // modeled — declared estimate, not a parallel engine).
      let ret = 0;
      for (const sym of this.shadowHeld) {
        const px = lastClose(sym);
        const prev = this.shadowPrices.get(sym) ?? 0;
        if (px > 0 && prev > 0) ret += this.cfg.notionalPctPerSlot * (px / prev - 1);
      }
      tracker = { ...tracker, equity: tracker.equity * (1 + ret) };
    }

    // Re-rank with the VIRTUAL holdings so held-slot hysteresis (exit at
    // -2% instead of entry at +5%) shapes the virtual book like a real one.
    const shadowDecisions = this.tsm.rank(candles, new Set(this.shadowHeld));
    const newHeld = shadowDecisions.filter(d => d.action === "long").map(d => d.symbol);
    const prevSet = new Set(this.shadowHeld);
    const newSet = new Set(newHeld);
    let sides = 0;
    for (const s of newHeld) if (!prevSet.has(s)) sides++;
    for (const s of this.shadowHeld) if (!newSet.has(s)) sides++;
    if (sides > 0) {
      const costBps = cfg.costBpsPerSide ?? 9;
      tracker = { ...tracker, equity: tracker.equity * (1 - this.cfg.notionalPctPerSlot * (costBps / 10_000) * sides) };
    }
    this.shadowHeld = newHeld;
    this.shadowPrices.clear();
    for (const sym of newHeld) {
      const px = lastClose(sym);
      if (px > 0) this.shadowPrices.set(sym, px);
    }

    const recovered = tracker.equity >= tracker.startEquity * (1 + cfg.recoverPct)
      || tracker.equity > tracker.peakRef;
    if (!recovered) {
      this.riskState = { ...st, shadowResume: tracker };
      return false;
    }

    // RESUME: lift the soft pause, re-anchor the peak to real equity, drop
    // the tracker. The next evaluateRisk call sees dd = 0 from the new
    // anchor — the old peak can no longer re-arm the lockout.
    const priorReason = st.pauseReason;
    const { shadowResume: _done, ...rest } = st;
    this.riskState = { ...rest, pausedUntil: 0, pauseReason: "", peakEquity: equity };
    this.shadowHeld = [];
    this.shadowPrices.clear();
    this.log.info(
      `shadow-equity resume: virtual equity ${tracker.equity.toFixed(2)} recovered ` +
      `${(((tracker.equity / tracker.startEquity) - 1) * 100).toFixed(2)}% from pause start ` +
      `(threshold ${(cfg.recoverPct * 100).toFixed(1)}%) — lifting "${priorReason}", peak re-anchored to ${equity.toFixed(2)}`,
    );
    const sleeve = this.cfg.heartbeatName;
    if (sleeve) {
      eventBus.emit(EVENTS.CIRCUIT_BREAKER, {
        sleeve, profileId: sleeve, action: "pause_resolved",
        reason: `shadow-equity resume: ${priorReason}`,
      });
    }
    return true;
  }

  /** Fires EVENTS.CIRCUIT_BREAKER exactly on a pause state CHANGE (never per
   *  tick while already/still paused — see detectPauseTransition's
   *  docstring, B-ops-alerts.md #1). `prevState` must be `this.riskState`
   *  captured BEFORE evaluateRisk's call overwrites it. Hard-drawdown pages
   *  ops too, via a SEPARATE ERROR_BURST (never inline here — telegram-
   *  reporter's CIRCUIT_BREAKER handler stays user-chat-only by contract,
   *  see alerts.test.ts). No-op without a heartbeatName (tests/backtests
   *  have no sleeve identity to report against). */
  private emitPauseTransition(prevState: RiskState, now: number, riskCheck: RiskAssessment): void {
    const sleeve = this.cfg.heartbeatName;
    if (!sleeve) return;
    const t = detectPauseTransition(prevState, riskCheck);
    if (!t) return;
    if (t.kind === "pause_started") {
      eventBus.emit(EVENTS.CIRCUIT_BREAKER, { sleeve, profileId: sleeve, action: "pause_started", reason: t.reason, resumeAt: t.pausedUntil });
      if (t.breach === "hard_drawdown") {
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "RiskGuard.hardDrawdown",
          message: `[${sleeve}] hard-drawdown pause: ${t.reason}`,
          count: 1, windowMs: 0, firstAt: now, lastAt: now,
        });
      }
    } else {
      eventBus.emit(EVENTS.CIRCUIT_BREAKER, { sleeve, profileId: sleeve, action: "pause_resolved", reason: t.priorReason });
    }
  }

  /**
   * Fetch equity, validating it's a usable number. Never throws — callers
   * branch on `valid` instead, so a broken equity feed degrades the tick
   * (RiskGuard frozen, opens blocked) rather than aborting it outright
   * (trailing-stop/close logic still needs to run best-effort).
   */
  private async readEquity(): Promise<{ equity: number; valid: boolean; error?: string }> {
    let raw: number;
    try {
      raw = await this.broker.getEquity();
    } catch (e: any) {
      return { equity: 0, valid: false, error: e.message };
    }
    if (!Number.isFinite(raw) || raw <= 0) {
      return { equity: Number.isFinite(raw) ? raw : 0, valid: false, error: `invalid equity ${raw}` };
    }
    return { equity: raw, valid: true };
  }

  /** Beat the ops watchdog (src/ops/heartbeat.ts) if a name is configured. */
  private beatHeartbeat(): void {
    if (this.cfg.heartbeatName) heartbeats.beat(this.cfg.heartbeatName);
  }

  getRiskState(): Readonly<RiskState> {
    return this.riskState;
  }
}
