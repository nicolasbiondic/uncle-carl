// ══════════════════════════════════════════════
// RiskEngine — global pre-trade veto, on the submit path only
// ══════════════════════════════════════════════
//
// Reference design: NautilusTrader's RiskEngine sits on the order
// submit/modify path and is DELIBERATELY absent from cancel/query — a risk
// limit must never stop you from getting OUT of a position, only from
// getting further IN. It exposes a three-value TradingState (ACTIVE /
// HALTED / REDUCING) and ~40 standardized denial codes shaped
// `CATEGORY_CONDITION: key=value`. This module follows the same shape, cut
// down to what this repo actually needs.
//
// What already exists and this module does NOT replace:
//   - RiskGuard (src/strategies/momentum/RiskGuard.ts): PER-SLEEVE drawdown/
//     daily-loss/loss-streak breaker. Pauses ENTRIES of one sleeve based on
//     that sleeve's own equity curve. Wired directly into every
//     MomentumEngine/MeanRevEngine, upstream of the adapter.
//   - isTradingEnabled() (src/config): global maintenance kill-switch,
//     TRADING_ENABLED=false, blocks ONLY opens, checked live (no caching).
//   - SleeveGovernor/SwitchingAdapter: routes a sleeve's orders to a real or
//     simulated (shadow) adapter based on live-evidence demotion.
//
// What did NOT exist before this module: a single place with STATE (halt /
// reduce-only-mode), per-order notional caps, submit rate limiting, and a
// reduceOnly-vs-exposure integrity check — all with typed, structured denial
// codes instead of ad-hoc boolean returns. This module is that place.
//
// Pure core: `evaluateSubmitCore` takes state/order/context/config/a
// prior-submits-in-window COUNT and returns a decision with no I/O and no
// hidden mutable state — fully unit-testable with plain values. The
// `RiskEngine` class is a thin imperative shell around it: it owns the
// TradingState (loaded from persistence at construction, mutated by
// `setTradingState`) and the per-sleeve sliding-window submit-timestamp
// bookkeeping (in-memory only — losing rate-limit history on a restart is
// fine; losing the HALT/REDUCE flag is not, hence persistence for that and
// only that).
//
// Persistence choice — `sync_state` (src/db/database.ts), not
// `fileStatePersistence` (index.ts): fileStatePersistence's envelope is
// bound to a `path` + capital-base + equity-semantics triple that belongs to
// ONE sleeve engine's own risk/trail state (see RiskGuard.ts). TradingState
// is a single small GLOBAL flag with no capital-base or equity semantics of
// its own — exactly BrokerSync's `sync_state` precedent (its persisted drift
// fingerprint/timestamp, "a small operational flag that must survive a
// restart", src/sync/BrokerSync.ts line ~109). Reusing sync_state's existing
// get/set functions means zero changes to database.ts.
//
// Activating REDUCING — when it would make sense, and how:
//   - Incident (broker API flaky / a strategy is misbehaving in a way that
//     doesn't warrant a full HALT of exits/closes): wind exposure down while
//     the stop-loss loop and BrokerSync keep running normally.
//   - Planned maintenance / deploy window: prefer the existing
//     TRADING_ENABLED=false kill-switch for a hard stop of new opens; use
//     REDUCING instead when you specifically want in-flight de-risking
//     (closes still flow, AND any genuinely reduce-only order is still
//     allowed) rather than an unconditional block.
//   - Deliberate wind-down of a sleeve/strategy being retired: let it exit
//     naturally over days without new entries, instead of an abrupt halt.
//   Activation is two-layered, same pattern as isTradingEnabled():
//     1. `RISK_ENGINE_STATE=REDUCING|HALTED|ACTIVE` env var — read FRESH on
//        every evaluateSubmit call (no caching), for immediate incident
//        response with no restart and no code change. Mirrors
//        TRADING_ENABLED exactly.
//     2. `RiskEngine.setTradingState(next, reason)` — programmatic, for a
//        future ops script or Telegram admin command; persisted via
//        sync_state so it survives a restart. The env var always wins over
//        the persisted value when both are set (same precedence idea as an
//        env override taking priority over a stored default).

import { createLogger } from "../utils/logger";
import { getSyncState, setSyncState } from "../db/database";
import { ALL_PROFILE_IDS } from "../config/riskProfiles";

const log = createLogger("RiskEngine");

// ── Types ────────────────────────────────────────────────────────────────

export type TradingState = "ACTIVE" | "HALTED" | "REDUCING";

export interface RiskEngineState {
  tradingState: TradingState;
  reason: string;
  /** epoch ms of the last setTradingState call; 0 = never explicitly set. */
  changedAt: number;
}

export const INITIAL_RISK_ENGINE_STATE: RiskEngineState = {
  tradingState: "ACTIVE",
  reason: "",
  changedAt: 0,
};

/**
 * The order shape RiskEngine reasons about. Deliberately a SUPERSET of what
 * SwitchingAdapter.openPosition carries today (symbol/side/notionalUsd) —
 * quantity/price/reduceOnly are optional so this stays useful for richer
 * future call sites without forcing today's integration to fabricate values
 * it doesn't have.
 */
export interface RiskOrder {
  /** Sleeve identifier (e.g. "momentum_stocks") — keys per-sleeve limits. */
  sleeve: string;
  symbol: string;
  side: "buy" | "sell";
  notionalUsd: number;
  quantity?: number;
  price?: number;
  /** True if the CALLER claims this order can only reduce/close exposure,
   *  never open or add to a position. Checked against `context`, not
   *  trusted blindly — see REDUCE_ONLY_INCREASES_EXPOSURE. */
  reduceOnly?: boolean;
}

/**
 * Just enough position context to judge whether an order INCREASES net
 * exposure. Never used to size or price anything.
 */
export interface RiskOrderContext {
  /** Side of the currently-held position for this symbol; undefined/null = flat. */
  currentPositionSide?: "buy" | "sell" | null;
  /** Absolute quantity currently held (ignored if currentPositionSide is absent). */
  currentPositionQty?: number;
}

export interface RateLimitConfig {
  maxSubmits: number;
  windowMs: number;
}

/**
 * Every field is optional and unset by default — an empty `{}` config is a
 * genuine no-op (see the "default no-op" test): no notional cap, no rate
 * limit, no precision limit. Only the fundamental positivity checks and the
 * TradingState gate (default ACTIVE) are always active, and ACTIVE + a
 * realistic order never denies.
 */
export interface RiskEngineConfig {
  maxNotionalPerOrderUsd?: number;
  maxNotionalPerOrderUsdBySleeve?: Record<string, number>;
  rateLimit?: RateLimitConfig;
  rateLimitBySleeve?: Record<string, RateLimitConfig>;
  /** Max decimal places allowed on `order.quantity`, if quantity is supplied. */
  maxQuantityDecimals?: number;
  maxQuantityDecimalsBySleeve?: Record<string, number>;
}

export type RiskDenialCode =
  | "NOTIONAL_NOT_POSITIVE"
  | "QUANTITY_NOT_POSITIVE"
  | "PRICE_NOT_POSITIVE"
  | "QUANTITY_PRECISION_EXCEEDED"
  | "REDUCE_ONLY_INCREASES_EXPOSURE"
  | "TRADING_STATE_HALTED"
  | "TRADING_STATE_REDUCING"
  | "NOTIONAL_EXCEEDS_MAXIMUM"
  | "RATE_LIMIT_EXCEEDED";

/** Runtime membership list mirroring RiskDenialCode — SwitchingAdapter.openPosition
 *  returns `reason: veto.code` verbatim on a deny, so this is the exact string
 *  a broker adapter's `res.reason` carries for a policy veto (as opposed to a
 *  real broker/network failure). Used by sleeveOutput.isPolicyPreventedReason
 *  to keep "sleeve producing NOTHING" from firing on sound risk management. */
export const RISK_DENIAL_CODES: readonly RiskDenialCode[] = [
  "NOTIONAL_NOT_POSITIVE", "QUANTITY_NOT_POSITIVE", "PRICE_NOT_POSITIVE",
  "QUANTITY_PRECISION_EXCEEDED", "REDUCE_ONLY_INCREASES_EXPOSURE",
  "TRADING_STATE_HALTED", "TRADING_STATE_REDUCING",
  "NOTIONAL_EXCEEDS_MAXIMUM", "RATE_LIMIT_EXCEEDED",
];

export type RiskDecision =
  | { allow: true }
  | {
      allow: false;
      code: RiskDenialCode;
      /** Human-readable "CODE: key=value, key2=value2" — stable prefix, variable tail. */
      detail: string;
      /** Same key/values as `detail`, structured for programmatic use/tests. */
      context: Record<string, string | number | boolean>;
    };

// ── Pure core ────────────────────────────────────────────────────────────

function deny(code: RiskDenialCode, ctx: Record<string, string | number | boolean>): RiskDecision {
  const detail = `${code}: ${Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join(", ")}`;
  return { allow: false, code, detail, context: ctx };
}

function decimalPlaces(n: number): number {
  const s = n.toString();
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/**
 * Does this order INCREASE net exposure? Flat → any order increases it.
 * Same side as the current position → adds to it, increases it. Opposite
 * side → only counts as non-increasing if its quantity doesn't exceed the
 * current holding (a strict reduce-or-close); an opposite-side order past
 * that size would flip into a new position beyond flat, which we
 * conservatively still call "increasing" (safe default for REDUCING mode:
 * only unambiguous reductions are let through). An opposite-side order with
 * no declared quantity can't be verified as a reduction, so it's treated as
 * increasing too — conservative by construction.
 */
function orderIncreasesExposure(order: RiskOrder, context: RiskOrderContext): boolean {
  const curSide = context.currentPositionSide ?? null;
  if (!curSide) return true;
  if (curSide === order.side) return true;
  const curQty = context.currentPositionQty ?? 0;
  const orderQty = order.quantity;
  if (orderQty === undefined || !(orderQty > 0)) return true;
  return orderQty > curQty;
}

/**
 * Stateless decision function — no I/O, no hidden mutable state. Callers
 * (the RiskEngine class below) own persistence of `state` and the
 * sliding-window bookkeeping behind `priorSubmitsInWindow`.
 *
 * Check order (most fundamental first, mirrors evaluateRisk's "most severe
 * first" discipline in RiskGuard.ts):
 *   1. Order validity: positivity of notional/quantity/price, quantity precision.
 *   2. reduceOnly integrity — independent of TradingState: a caller-claimed
 *      reduce-only order that actually increases exposure is ALWAYS wrong.
 *   3. TradingState gate: HALTED denies everything; REDUCING denies only
 *      exposure-increasing orders.
 *   4. Per-order notional cap (sleeve override, else global).
 *   5. Submit rate limit (sleeve override, else global).
 */
export function evaluateSubmitCore(
  state: RiskEngineState,
  order: RiskOrder,
  context: RiskOrderContext,
  cfg: RiskEngineConfig,
  priorSubmitsInWindow: number,
): RiskDecision {
  if (!Number.isFinite(order.notionalUsd) || order.notionalUsd <= 0) {
    return deny("NOTIONAL_NOT_POSITIVE", { notional_usd: order.notionalUsd, sleeve: order.sleeve, symbol: order.symbol });
  }
  if (order.quantity !== undefined && (!Number.isFinite(order.quantity) || order.quantity <= 0)) {
    return deny("QUANTITY_NOT_POSITIVE", { quantity: order.quantity, sleeve: order.sleeve, symbol: order.symbol });
  }
  if (order.price !== undefined && (!Number.isFinite(order.price) || order.price <= 0)) {
    return deny("PRICE_NOT_POSITIVE", { price: order.price, sleeve: order.sleeve, symbol: order.symbol });
  }

  const maxDecimals = cfg.maxQuantityDecimalsBySleeve?.[order.sleeve] ?? cfg.maxQuantityDecimals;
  if (order.quantity !== undefined && maxDecimals !== undefined) {
    const decimals = decimalPlaces(order.quantity);
    if (decimals > maxDecimals) {
      return deny("QUANTITY_PRECISION_EXCEEDED", {
        quantity: order.quantity, decimals, max_decimals: maxDecimals, sleeve: order.sleeve, symbol: order.symbol,
      });
    }
  }

  const increasesExposure = orderIncreasesExposure(order, context);
  if (order.reduceOnly && increasesExposure) {
    return deny("REDUCE_ONLY_INCREASES_EXPOSURE", {
      side: order.side, current_side: context.currentPositionSide ?? "flat", sleeve: order.sleeve, symbol: order.symbol,
    });
  }

  if (state.tradingState === "HALTED") {
    return deny("TRADING_STATE_HALTED", { state: state.tradingState, reason: state.reason || "none", sleeve: order.sleeve, symbol: order.symbol });
  }
  if (state.tradingState === "REDUCING" && increasesExposure) {
    return deny("TRADING_STATE_REDUCING", { state: state.tradingState, reason: state.reason || "none", sleeve: order.sleeve, symbol: order.symbol });
  }

  const maxNotional = cfg.maxNotionalPerOrderUsdBySleeve?.[order.sleeve] ?? cfg.maxNotionalPerOrderUsd;
  if (maxNotional !== undefined && order.notionalUsd > maxNotional) {
    return deny("NOTIONAL_EXCEEDS_MAXIMUM", {
      notional_usd: order.notionalUsd, max_notional_usd: maxNotional, sleeve: order.sleeve, symbol: order.symbol,
    });
  }

  const rl = cfg.rateLimitBySleeve?.[order.sleeve] ?? cfg.rateLimit;
  if (rl && priorSubmitsInWindow >= rl.maxSubmits) {
    return deny("RATE_LIMIT_EXCEEDED", {
      submits_in_window: priorSubmitsInWindow, max_submits: rl.maxSubmits, window_ms: rl.windowMs,
      sleeve: order.sleeve, symbol: order.symbol,
    });
  }

  return { allow: true };
}

// ── Persistence (sync_state) ────────────────────────────────────────────

const SYNC_STATE_KEY = "risk_engine:trading_state";

export interface RiskEnginePersistence {
  load(): RiskEngineState | null;
  save(state: RiskEngineState): void;
}

function isTradingState(v: any): v is TradingState {
  return v === "ACTIVE" || v === "HALTED" || v === "REDUCING";
}

/** Default persistence: sync_state kv table. Read/write are try/catch'd —
 *  same defensive posture as SleeveGovernor.getMode — so a DB hiccup falls
 *  back to in-memory state rather than crashing the caller. */
export const dbSyncStatePersistence: RiskEnginePersistence = {
  load(): RiskEngineState | null {
    try {
      const raw = getSyncState(SYNC_STATE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!isTradingState(parsed?.tradingState)) return null;
      return {
        tradingState: parsed.tradingState,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        changedAt: typeof parsed.changedAt === "number" ? parsed.changedAt : 0,
      };
    } catch (e: any) {
      log.warn(`persisted state load failed, defaulting to ACTIVE: ${e?.message ?? e}`);
      return null;
    }
  },
  save(state: RiskEngineState): void {
    try {
      setSyncState(SYNC_STATE_KEY, JSON.stringify(state));
    } catch (e: any) {
      log.warn(`persisted state save failed (in-memory state still governs this process): ${e?.message ?? e}`);
    }
  },
};

function logDenial(order: RiskOrder, decision: Extract<RiskDecision, { allow: false }>): void {
  // Message is deliberately just "RISK_DENY:<code>" — a STABLE shape across
  // calls with the same code, regardless of the variable numbers in
  // `detail`. logger.ts's ERROR_BURST groups by (context, first-80-chars-of-
  // message); putting the variable context in `data` (2nd arg, excluded from
  // that hash) instead of the message means bursts group by denial CODE, not
  // by incidentally-different numbers. A code firing ≥10x/60s pages on-call
  // — useful signal whether it's a sleeve hammering a limit or the state
  // stuck HALTED while something keeps trying to trade.
  log.error(`RISK_DENY:${decision.code}`, { symbol: order.symbol, sleeve: order.sleeve, ...decision.context });
}

// ── RiskEngine class ─────────────────────────────────────────────────────

/**
 * Pre-trade veto for NEW/MODIFIED orders. Deliberately has NO cancel/query
 * method and must NEVER be called from one — see SwitchingAdapter.
 * closePosition's docstring for the wiring decision. A risk limit must
 * never prevent getting OUT of a position, only getting further IN.
 */
export class RiskEngine {
  private state: RiskEngineState;
  private submitTimestamps = new Map<string, number[]>();

  constructor(
    private cfg: RiskEngineConfig = {},
    private persistence: RiskEnginePersistence = dbSyncStatePersistence,
  ) {
    this.state = persistence.load() ?? { ...INITIAL_RISK_ENGINE_STATE };
  }

  /**
   * RISK_ENGINE_STATE env var overrides the persisted state, read FRESH on
   * every call (no caching) — same pattern as isTradingEnabled(). Lets an
   * incident responder flip to HALTED/REDUCING without touching the DB or
   * restarting, and it always wins over whatever setTradingState persisted.
   */
  private effectiveState(): RiskEngineState {
    const override = process.env.RISK_ENGINE_STATE;
    if (isTradingState(override)) {
      return { tradingState: override, reason: `env override (RISK_ENGINE_STATE=${override})`, changedAt: this.state.changedAt };
    }
    return this.state;
  }

  /** Current effective state (env override applied). Dashboard/health surface. */
  getState(): RiskEngineState {
    return this.effectiveState();
  }

  /** Programmatic state change — persisted so it survives a restart. */
  setTradingState(next: TradingState, reason: string): void {
    this.state = { tradingState: next, reason, changedAt: Date.now() }; // clock-ok: operator-action telemetry timestamp, never read by decision logic
    this.persistence.save(this.state);
  }

  private countInWindow(sleeve: string, windowMs: number, now: number): number {
    const arr = this.submitTimestamps.get(sleeve) ?? [];
    const pruned = arr.filter(t => now - t < windowMs);
    this.submitTimestamps.set(sleeve, pruned);
    return pruned.length;
  }

  private recordSubmit(sleeve: string, now: number): void {
    const arr = this.submitTimestamps.get(sleeve) ?? [];
    arr.push(now);
    this.submitTimestamps.set(sleeve, arr);
  }

  /**
   * Evaluate a NEW order submission. NOT for cancels or queries — there is
   * no method here for those on purpose (see class docstring).
   */
  evaluateSubmit(order: RiskOrder, context: RiskOrderContext = {}, now: number = Date.now()): RiskDecision { // clock-ok: seam default — callers/tests inject now
    const rl = this.cfg.rateLimitBySleeve?.[order.sleeve] ?? this.cfg.rateLimit;
    const priorInWindow = rl ? this.countInWindow(order.sleeve, rl.windowMs, now) : 0;
    const decision = evaluateSubmitCore(this.effectiveState(), order, context, this.cfg, priorInWindow);
    if (decision.allow) {
      this.recordSubmit(order.sleeve, now);
    } else {
      logDenial(order, decision);
    }
    return decision;
  }
}

// ── Default shared instance ──────────────────────────────────────────────
//
// Lazily constructed on first use (NOT at module import time): its
// constructor reads sync_state via getDB(), which is undefined until
// initDatabase() runs. Every real call site (SwitchingAdapter, constructed
// from index.ts after initDatabase()) and every test (initDatabase() in
// beforeAll before any SwitchingAdapter is built) satisfies that ordering.
//
// Config is NO LONGER `{}` (2026-09-20 audit, "B2"): an empty config had no
// absolute $ ceiling at all — sizing is entirely percentage-based
// (MEANREV_BASE_USD × slot%, momentum's equity × weight×leverage), so a
// single order-of-magnitude typo in one of those inputs could submit an
// order for hundreds of thousands of dollars with nothing to stop it.
// RISK_MAX_NOTIONAL_PER_ORDER_USD sets a global hard $ cap (default 25_000 —
// comfortably above today's largest real slot, momentum_stocks at ~$25k
// with 2x leverage, so it changes nothing that currently happens, but it
// DOES stop a decimal/zero-count typo cold). Optional per-sleeve overrides:
// RISK_MAX_NOTIONAL_PER_ORDER_USD_<SLEEVE>, sleeve name uppercased (e.g.
// RISK_MAX_NOTIONAL_PER_ORDER_USD_MEANREV_STOCKS).
const DEFAULT_MAX_NOTIONAL_PER_ORDER_USD = 25_000;

function parsePositiveUsd(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Builds getDefaultRiskEngine's config from env. Exported for tests only —
 *  production always calls it with no args (real process.env). */
export function buildDefaultRiskEngineConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RiskEngineConfig {
  const maxNotionalPerOrderUsd =
    parsePositiveUsd(env.RISK_MAX_NOTIONAL_PER_ORDER_USD) ?? DEFAULT_MAX_NOTIONAL_PER_ORDER_USD;
  const maxNotionalPerOrderUsdBySleeve: Record<string, number> = {};
  for (const sleeve of ALL_PROFILE_IDS) {
    const override = parsePositiveUsd(env[`RISK_MAX_NOTIONAL_PER_ORDER_USD_${sleeve.toUpperCase()}`]);
    if (override !== undefined) maxNotionalPerOrderUsdBySleeve[sleeve] = override;
  }
  return {
    maxNotionalPerOrderUsd,
    ...(Object.keys(maxNotionalPerOrderUsdBySleeve).length > 0 ? { maxNotionalPerOrderUsdBySleeve } : {}),
  };
}

let defaultInstance: RiskEngine | null = null;
export function getDefaultRiskEngine(): RiskEngine {
  if (!defaultInstance) {
    const cfg = buildDefaultRiskEngineConfigFromEnv();
    log.info(
      `default RiskEngine armed: maxNotionalPerOrderUsd=${cfg.maxNotionalPerOrderUsd}` +
      (cfg.maxNotionalPerOrderUsdBySleeve
        ? `, overrides=${JSON.stringify(cfg.maxNotionalPerOrderUsdBySleeve)}`
        : ""),
    );
    defaultInstance = new RiskEngine(cfg);
  }
  return defaultInstance;
}

/** Test-only escape hatch: forces the next getDefaultRiskEngine() call to
 *  construct a fresh instance. Not used by production code. */
export function _resetDefaultRiskEngineForTests(): void {
  defaultInstance = null;
}
