// ══════════════════════════════════════════════
// Account Manager v8 — sleeve position/state orchestrator
//
// The COMBINED 5-indicator engine was amputated (2026-07-10); signal
// generation lives in the engines wired by index.ts. What remains here is
// still a WIDE surface — this list is the honest inventory (2026-08-06
// audit counted 12 responsibilities against a docstring claiming 4; the
// Binance reconciliation algorithm has since moved to
// BinanceSleeveReconciler.ts, ONE parameterized copy for the three Binance
// sleeves). Update this list when you add a responsibility:
//   1.  Loop lifecycle: 7 concurrent intervals (15s SL; 60s Alpaca/USDT
//       syncs; staggered 60s USDC/COIN-M syncs; 5min snapshots; 6h prune),
//       heartbeats, reentrancy guards, start/stop.
//   2.  Hard stop-loss defense-in-depth (15s, profile.stopLossPct) plus the
//       deferred-close / PDT-block bookkeeping around it.
//   3.  Broker equity sync (broker = truth): Alpaca account, FAPI USDT/USDC
//       margin pools, DAPI COIN-M — cached into EquityTracker/*_main truth.
//   4.  DB ↔ broker position reconciliation: Binance side delegated to
//       BinanceSleeveReconciler.ts; Alpaca orphan adoption stays here.
//   5.  Alpaca broker-native GTC stops (place/verify/adopt/attribute fills).
//   6.  Corporate-action application (advisory feed → row/stop/cache fixes).
//   7.  equity_snapshots SINGLE writer (writeAllSnapshots) + daily
//       portfolio-invariant check.
//   8.  In-memory position/state maintenance + Alpaca WS subscriptions.
//   9.  Sleeve activation registry (attach*, live/close-only/truth-only).
//   10. Dashboard/Telegram read models (consolidated state, summaries,
//       market data, per-account views).
// ══════════════════════════════════════════════

import { v4 as uuid } from "uuid";
import { getEnabledStocks, getEnabledCrypto } from "../config/symbols";
import {
  RISK_PROFILES, ALL_PROFILE_IDS, MOMENTUM_STOCKS_UNIVERSE,
  type RiskProfile, type RiskProfileId,
} from "../config/riskProfiles";
import { EquityTracker, computeSleeveLedger, buildSleevePriceMap } from "./EquityTracker";
import { OrderExecutor } from "../executor/order-executor";
import { stopLossClientOrderId, TERMINAL_ORDER_STATUSES, CLIENT_ORDER_ID_PREFIX, type AlpacaStopOrder } from "../executor/alpaca-executor";
import { BinanceExecutor } from "../executor/binance-executor";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import {
  BinanceCoinMExecutor, inversePnlUsdAtExit, positionUsd,
} from "../executor/binance-coinm-executor";
import {
  reconcileLinearBinanceSleeve, reconcileCoinmSleeve, UnreconciledGrace,
  USDT_SLEEVE_SPEC, USDC_SLEEVE_SPEC, getOpenCommission,
} from "./BinanceSleeveReconciler";
import {
  getTradingStats, getOpenTrades, closeTrade, insertTrade,
  saveEquitySnapshot,
  getRecentSignals, getRecentTrades, getV8StartedAt,
  insertActivity, updateTradeCloseReason, updateTradeStopLoss,
  getETDateKey, getETDayBounds, pruneOldData, recordFill, isSyncOwned, pnlOf,
  getAlpacaV8StartEquity,
  recordCorporateAction, markCorporateActionApplied, applySplitToOpenStockTrades,
} from "../db/database";
import type { CorporateActionEvent } from "../market/corporateActions";
import {
  getPortfolioEquityNow, getPortfolioEquityStartDisplay, getSleeveEquityStartDisplay,
  reconcilePortfolioInvariants, setBrokerTruthAvailable, isBrokerTruthAvailable,
} from "../portfolio/truth";
import { heartbeats } from "../ops/heartbeat";
import { publishInstanceManifest } from "../ops/instanceManifest";
import { checkPrice, DEFAULT_PLAUSIBILITY, plausibilityMode, RejectionTally } from "../market/plausibility";
import { createLogger } from "../utils/logger";
import { isMarketOpen } from "../utils/marketHours";
import { eventBus, EVENTS } from "../utils/events";
import type { PortfolioState, Position } from "../utils/types";
import { buildPerformanceSummary } from "./performanceSummary";
import { MEANREV_UNIVERSE } from "../strategies/meanrev/MeanRevEngine";
import { isTreasurySymbol } from "../treasury/treasurySymbols";

const log = createLogger("AccountManager");

/** Alpaca Basic/IEX real-time bar feed caps a single stream at ~30 symbols. */
const ALPACA_STOCK_WS_MAX = 30;

/** Throttle for the "no Alpaca SL price" warn/error escalation, per (account,symbol). */
const UNAVAILABLE_PRICE_LOG_COOLDOWN_MS = 5 * 60_000;

/** Escalate a stuck DEFERRED close to an aggregated ERROR_BURST page after
 *  this many consecutive defers for the same (profile,symbol,trigger). The
 *  DEFERRED log itself only re-fires when the broker's reason CHANGES, so a
 *  close stuck on one stable reason would otherwise log once, ever, and go
 *  silent forever — this is the only thing that still pages for it. */
const DEFERRED_CLOSE_ESCALATE_AFTER = 20; // ~5min at the 15s SL loop cadence
const DEFERRED_CLOSE_ALERT_COOLDOWN_MS = 5 * 60_000;

/** Cooldown for the corrupt-sleeve-ledger (NaN marker) drift-guard page. */
const LEDGER_CORRUPT_ALERT_COOLDOWN_MS = 5 * 60_000;

/** The sleeves whose positions live on the SHARED Alpaca wallet (stocks).
 *  Universes disjoint by construction (riskProfiles.disjoint.test.ts), so a
 *  symbol maps to exactly one of them — the native-stop reconciler leans on
 *  that when matching a broker stop order to the row it protects. */
const ALPACA_STOCK_SLEEVES = ["momentum_stocks", "meanrev_stocks"] as const;

/** Alpaca stock-sleeve orphan-adoption grace, in 60s syncAlpacaAccount
 *  cycles. 3 cycles ≈ 3min, matching the Binance sleeves' wall-clock grace on
 *  positionRisk.updateTime — Alpaca positions have no equivalent broker
 *  timestamp, so cycle count substitutes for wall-clock delta. */
const ALPACA_ADOPTION_GRACE_CYCLES = 3;

/** Orphan-STOP sweep grace (OPEN.md P1, 2026-08-11 ABBV), in 60s native-stop
 *  passes: a uc8- GTC stop whose symbol shows NO broker position must survive
 *  this many consecutive passes before it is canceled. Guards the INVERSE
 *  race — a just-filled entry whose position the broker's enumeration hasn't
 *  surfaced yet while a stop from a prior cycle rests — because the expensive
 *  false positive here is canceling a LIVE position's only overnight
 *  protection. 3 cycles ≈ 3min, deliberately the same wall-clock shape as
 *  ALPACA_ADOPTION_GRACE_CYCLES; an orphaned sell stop resting ≤3min is a
 *  bounded risk (it only fires if price crosses its trigger in that window),
 *  a naked position is not. */
const ALPACA_ORPHAN_STOP_GRACE_CYCLES = 3;
/** Wall-clock floor for the same grace (2026-09-26): since stop-on-fill
 *  (ALPACA_STOP_ON_FILL) a pass also runs ~3s after entry fills, so three
 *  passes no longer imply ~3 minutes. A stop is canceled only after BOTH
 *  the pass count AND this much time since it was first seen orphaned — the
 *  inverse race it guards (a live position transiently missing from the
 *  broker's enumeration) is a wall-clock phenomenon. */
export const ALPACA_ORPHAN_STOP_GRACE_MIN_MS = 150_000;

/** Broker-native GTC stop ON FILL (2026-09-26). A just-filled Alpaca stock
 *  ENTRY used to wait for the NEXT 60s syncAlpacaAccount cycle to arm its
 *  native GTC stop (observed live: QCOM filled 13:36:29 → stop placed
 *  13:37:12); during that window only the 15s loop protects, and a process
 *  death inside it leaves the position naked until the next boot's startup
 *  sync. When true, the ORDER_FILLED event (emitted by
 *  AlpacaMomentumAdapter.openPosition AFTER the trades row is persisted —
 *  persistFillOrReconcile precedes the emit, so the pass can see the row)
 *  schedules ONE debounced ensureAlpacaNativeStops pass, reusing the
 *  existing reconciler exactly: serialized (nativeStopsPass), idempotent,
 *  deterministic client_order_ids. Deliberately NOT order_class
 *  bracket/oto: a DAY entry's stop child expires at the close, and a second
 *  stop-placement path would fight this reconciler (two live stops → 2× qty
 *  sold on trigger → accidental short). The 60s timer pass remains the
 *  backstop. false = previous behavior (60s-cycle placement only). */
export const ALPACA_STOP_ON_FILL = true;

/** Debounce for the stop-on-fill pass: one engine pass fills several
 *  entries seconds apart (meanrev can open up to 7 slots in one runDaily) —
 *  a short fuse batches them into ONE pass instead of N back-to-back. */
export const ALPACA_STOP_ON_FILL_DEBOUNCE_MS = 3_000;

// ── Broker REST reconnection backoff (2026-08-16) ──────────────────────────
// `connected` used to be assigned in exactly ONE place per executor — its
// init(), called once at startup (alpaca-executor.ts / order-executor.ts:28).
// A broker that failed to connect at boot, or refused mid-run, stayed dead
// until cron's health watchdog killed the whole process (2026-08-13: Alpaca
// REST timed out at startup, the bot ran DEGRADED and blind to 9 positions —
// no stop-loss loop, no sync — until the watchdog restart). The reconnector
// below rides the EXISTING 60s sync loops (no new timer): exponential
// backoff, jittered, capped — never a naked retry-every-tick hammer against
// a down API. Exported for brokerReconnect.test.ts.
export const RECONNECT_BASE_DELAY_MS = 30_000;
export const RECONNECT_MAX_DELAY_MS = 5 * 60_000;
/** Jitter: each failed attempt schedules the next at delay×(1..1+FRAC). */
export const RECONNECT_JITTER_FRAC = 0.25;

/** Minimal executor surface the reconnector drives. Test fakes without
 *  init() (test-support/account.ts) are skipped, never crashed on. */
export interface ReconnectableExecutor {
  isConnected?: () => boolean;
  init?: () => Promise<boolean>;
}

interface ReconnectState {
  delayMs: number;      // backoff to apply AFTER the next failure
  nextAttemptAt: number;
  attempts: number;
  inFlight: boolean;    // init() can outlive a 60s tick — never overlap two
}

// isSyncOwned moved to db/database.ts (2026-07-26) so BrokerSync and the
// reconcilers here share ONE definition — BrokerSync used to match only the
// sync_ id prefix, so a UUID row tagged strategy='BROKER_SYNC' was skipped by
// both sides and stayed open forever. Re-exported to keep existing importers.
export { isSyncOwned };

export function recordUnavailablePriceMiss(misses: Map<string, number>, key: string): number {
  const count = (misses.get(key) ?? 0) + 1;
  misses.set(key, count);
  return count;
}

/** Sanity ceiling on the derived per-row stop distance (OPEN.md P2
 *  2026-08-29): 3× the widest vol-stop maxPct configured anywhere in the
 *  system (12, meanrev) = 36. Since the 2026-08-28 override trades.stop_loss
 *  is load-bearing — a corrupt value (entry $100 / stop $0.01 → 99.99%)
 *  would de-facto disable the 15s loop AND arm an absurd GTC while the
 *  dashboard reads "protected". No writer produces such a value today (all
 *  verified sane), so a breach means the column got corrupted (tooling,
 *  bad migration): fall back to the profile distance and log ERROR. */
export const ROW_STOP_MAX_PCT = 36;

/** Once-per-(symbol,tradeId) dedup for the ceiling breach ERROR — the 15s
 *  loop re-derives every pass and a permanent corrupt row must not become a
 *  4-lines-per-minute log flood. Unbounded only if corrupt rows are
 *  unbounded, which is the never-happens case this guards. */
const rowStopBreachLogged = new Set<string>();

/** Per-ROW hard-stop distance in percent units. Precedence: the row's
 *  persisted stop PRICE (trades.stop_loss — vol-scaled at entry for the
 *  stock sleeves since the 2026-08-28 owner override; for everyone else the
 *  armed native trigger mirrored back by the ensure passes), falling back to
 *  the profile's fixed pct when the row carries none. The stop must sit on
 *  the PROTECTIVE side of entry — a corrupt/inverted value falls back to the
 *  fixed distance instead of arming a nonsense stop — and derive a distance
 *  ≤ ROW_STOP_MAX_PCT (see above). Every stop consumer (15s loop,
 *  native-stop ensure, Binance stopConfirm) MUST derive through here, or the
 *  layers fight (the ensure pass literally replaces any armed stop that
 *  disagrees with its expectation). */
export function rowStopPct(
  trade: { side: string; entryPrice: number; stopLoss?: number | null; symbol?: string; id?: string },
  fallbackPct: number,
): number {
  const stop = trade.stopLoss;
  if (!(typeof stop === "number" && stop > 0 && trade.entryPrice > 0)) return fallbackPct;
  const protective = trade.side === "buy" ? stop < trade.entryPrice : stop > trade.entryPrice;
  if (!protective) return fallbackPct;
  const pct = (Math.abs(trade.entryPrice - stop) / trade.entryPrice) * 100;
  if (pct > ROW_STOP_MAX_PCT) {
    const key = `${trade.symbol ?? "?"}:${trade.id ?? "?"}`;
    if (!rowStopBreachLogged.has(key)) {
      rowStopBreachLogged.add(key);
      log.error(`rowStopPct ${key}: derived stop distance ${pct.toFixed(2)}% exceeds sanity ceiling ${ROW_STOP_MAX_PCT}% (entry ${trade.entryPrice}, stop ${stop}) — trades.stop_loss looks corrupt; using fallback ${fallbackPct}%`);
    }
    return fallbackPct;
  }
  return pct;
}

/** Build a bounded, deterministic Alpaca stock WS symbol list.
 *  1) Every currently held stock is included first.
 *  2) Remaining slots (up to `max`) are filled from the configured universe,
 *     sorted deterministically.
 *  3) If held positions alone exceed the cap, `droppedHeld` reports the ones
 *     that will not receive live bars.
 */
export function boundedAlpacaStockSymbols(
  held: string[],
  universe: string[],
  max = ALPACA_STOCK_WS_MAX,
): { symbols: string[]; droppedHeld: string[] } {
  const uniqueHeld = [...new Set(held)].sort();
  const heldTake = uniqueHeld.slice(0, max);
  const droppedHeld = uniqueHeld.slice(max);
  const heldSet = new Set(heldTake);
  const fill = [...new Set(universe)].filter(s => !heldSet.has(s)).sort();
  const remaining = max - heldTake.length;
  const symbols = [...heldTake, ...fill.slice(0, remaining)];
  return { symbols, droppedHeld };
}

/** Engine risk state surfaced on the dashboard (injected from index.ts). */
export interface EngineCircuitState {
  paused: boolean;
  reason: string;
  resumeAt: number;
}

// ── Single Account Instance ─────────────────
export class AccountInstance {
  readonly id: RiskProfileId;
  readonly profile: RiskProfile;
  readonly equity: EquityTracker;
  positions: Map<string, Position> = new Map();
  state: PortfolioState;

  constructor(id: RiskProfileId) {
    this.id = id;
    this.profile = RISK_PROFILES[id];
    this.equity = new EquityTracker(id);
    this.state = this.defaultState();
  }

  private defaultState(): PortfolioState {
    return {
      totalEquity: this.equity.equity, cash: this.equity.cash,
      stocksValue: 0, cryptoValue: 0, positions: [],
      dailyPnl: 0, dailyPnlPct: 0,
      totalPnl: this.equity.totalPnl, totalPnlPct: this.equity.totalPnlPct,
      openPositions: 0, dailyTrades: 0, winRate: 0, timestamp: Date.now(),
    };
  }
}

// ── Account Manager ─────────────────────────
export class AccountManager {
  readonly accounts: Map<RiskProfileId, AccountInstance> = new Map();
  readonly executor: OrderExecutor;

  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private accountSyncInterval: ReturnType<typeof setInterval> | null = null;
  private reconcileInterval: ReturnType<typeof setInterval> | null = null;
  private stopLossInterval: ReturnType<typeof setInterval> | null = null;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private viewId: RiskProfileId | "consolidated" = "consolidated";

  /** Last completed broker sync (either side) — liveness signal for /healthz/full. */
  lastSyncAt = 0;

  /** Latest broker-truth reading per broker — cached by the 60s syncs, drained
   *  by the single snapshot writer (writeAllSnapshots). null until first sync. */
  private alpacaMainTruth: { equity: number; cash: number } | null = null;
  private binanceMainTruth: { equity: number; cash: number } | null = null;
  /** binance_coinm_main (DAPI) — sole-owned by momentum_btc, same cache
   *  contract as the two above. Read-only: never written to by an order path. */
  private binanceCoinmMainTruth: { equity: number; cash: number } | null = null;
  /** Per-sleeve "flat on broker, no attributable fills yet" grace counters
   *  (BinanceSleeveReconciler.UnreconciledGrace). One instance per sleeve —
   *  the old single shared map was keyed by trade UUID and NEVER pruned (an
   *  unbounded leak); each of these prunes itself at the end of every
   *  completed reconcile pass, same pattern as unavailablePriceMisses. */
  private usdtGrace = new UnreconciledGrace();
  private usdcGrace = new UnreconciledGrace();
  private coinmGrace = new UnreconciledGrace();
  /** Consecutive-orphan counter per Alpaca symbol, stock-sleeve adoption
   *  grace (see syncAlpacaAccount) — Alpaca positions carry no broker-native
   *  open timestamp, so this substitutes for Binance's wall-clock
   *  positionRisk.updateTime grace with a multi-cycle equivalent. One map
   *  serves both sleeves: the universes are disjoint, so a symbol has
   *  exactly one owner. */
  private alpacaOrphanCycles = new Map<string, number>();
  /** Consecutive-miss counter per (accountId:symbol). Pruned to open
   *  positions at the end of every checkAllStopLoss pass — self-bounding,
   *  no separate cleanup needed on stop() or price recovery. */
  private unavailablePriceMisses = new Map<string, number>();
  /** Single global cooldown for the aggregated price-unavailable alert
   *  (one ERROR_BURST per pass across ALL stale symbols, not per symbol). */
  private lastPriceAlertAt = 0;
  /** SL-price plausibility rejections (src/market/plausibility.ts) —
   *  cooldown-aggregated, one summary line per 5min window max. */
  private plausibilityTally = new RejectionTally();
  /** Consecutive-defer counter per (accountId:symbol:trigger). Pruned to
   *  open positions at the end of every checkAllStopLoss pass, same
   *  contract as unavailablePriceMisses above. */
  private deferredCloseCounts = new Map<string, number>();
  /** Single global cooldown for the aggregated stuck-close alert (one
   *  ERROR_BURST per pass across ALL escalated closes, not per position). */
  private lastDeferredCloseAlertAt = 0;
  /** Single global cooldown for the corrupt-sleeve-ledger page (60s sync
   *  cadence would otherwise page every pass while the corruption persists). */
  private lastLedgerCorruptAlertAt = 0;
  /** tradeId → broker order id of an ADOPTED protective stop: a forward
   *  split makes Alpaca REPLACE our GTC stop with a price/qty-adjusted
   *  successor under a broker-generated client_order_id — invisible to the
   *  uc8- enumeration, reachable only through the original order's
   *  `replaced_by` chain (see resolveMissingNativeStop). In-memory only: a
   *  restart re-discovers the adoption by walking the chain again. */
  private adoptedNativeStops: Map<string, string> = new Map();
  /** Consecutive-orphan counter per broker STOP-ORDER id (not symbol: a
   *  re-entered symbol's fresh stop must start a fresh count) for the
   *  orphan-stop sweep — see sweepOrphanedAlpacaStops. Entries whose stop is
   *  no longer orphaned (position back, stop gone/filled/canceled) are
   *  pruned at the end of every pass, same self-bounding contract as
   *  alpacaOrphanCycles. */
  private alpacaOrphanStopCycles = new Map<string, number>();
  /** First wall-clock sighting of each orphaned stop (paired with
   *  alpacaOrphanStopCycles; pruned together). Field, not constant, so tests
   *  can zero the floor via orphanStopGraceMinMs. */
  private alpacaOrphanStopFirstSeen = new Map<string, number>();
  private orphanStopGraceMinMs = ALPACA_ORPHAN_STOP_GRACE_MIN_MS;
  /** Debounce state for the stop-on-fill native-stop pass (see
   *  ALPACA_STOP_ON_FILL / scheduleStopOnFillPass). `stopOnFillDebounceMs`
   *  is a field (not the constant inline) so tests can shrink the fuse. */
  private stopOnFillTimer: ReturnType<typeof setTimeout> | null = null;
  private stopOnFillFirstFillAt = 0;
  private stopOnFillCount = 0;
  private stopOnFillDebounceMs = ALPACA_STOP_ON_FILL_DEBOUNCE_MS;

  /**
   * DEFERRED-once-per-reason log suppression, keyed by profile:symbol:trigger
   * → last logged reason. Logs again only when the reason actually changes
   * (a genuinely new failure mode), so a broker returning varying messages
   * during one persistent failure can't grow this unbounded. Pruned to open
   * positions at the end of every checkAllStopLoss pass (same contract as
   * deferredCloseCounts below) — it used to be cleared only on a successful
   * close or stop(), leaving entries behind for rows closed by other paths.
   */
  private deferredLoggedReasons: Map<string, string> = new Map();
  private pdtBlockedUntil: Map<string, number> = new Map(); // (profile:symbol) → skip close until (403/PDT)
  /** Ops-incident tracker for "broker position OPEN with NO confirmed native
   *  stop" (accountId:symbol → firstAt). One immediate ERROR_BURST page on
   *  the FIRST occurrence (bypasses logger's 10-in-60s threshold — at a 60s
   *  reconcile cadence a persistent install failure would otherwise never
   *  reach it, exactly the CAT 2026-09-14 4×422 incident that paged nobody),
   *  none on repeat passes while it's still failing, and one "resolved" page
   *  when the stop is verified/placed/adopted or the row closes. Pruned to
   *  open stock rows at the end of every runAlpacaNativeStopsPass. */
  private nativeStopIncidents: Map<string, number> = new Map();
  private syncingAlpaca = false;   // reentrancy guards for the 60s sync loops
  private syncingBinance = false;
  /** Per-executor REST reconnect state (see RECONNECT_* constants above).
   *  Entry exists only while that executor is disconnected. */
  private reconnectStates = new Map<string, ReconnectState>();
  private checkingStopLoss = false; // reentrancy guard for the 15s SL loop
  private refreshingBinanceTotal = false; // reentrancy guard for the fire-and-forget account-total refresh

  // 2026-07-19: momentum_crypto_usdc / momentum_btc — attached by index.ts
  // AFTER their own startup preflight passes (MOMENTUM_USDC_ENABLED /
  // MOMENTUM_COINM_ENABLED); null (feature OFF) is the default and is
  // handled everywhere below as "this sleeve has no broker to sync/price
  // against yet". Each is a SEPARATE Binance wallet — never routed through
  // this.executor.binance (the USDT instance) or each other.
  private usdcExecutor: BinanceExecutor | null = null;
  private coinmExecutor: BinanceCoinMExecutor | null = null;
  private usdcSyncInterval: ReturnType<typeof setInterval> | null = null;
  private coinmSyncInterval: ReturnType<typeof setInterval> | null = null;
  private syncingUsdc = false;
  private syncingCoinm = false;

  /** "live" (opens new positions, default) | "close-only" (index.ts attached
   *  the executor because DB/broker exposure existed while the feature flag
   *  is OFF — reconciliation runs, but no engine is wired to open anything
   *  new) | "truth-only" (momentum_btc/COIN-M ONLY — flag off AND no DB
   *  exposure, but DAPI truth is attached unconditionally per the 2026-07-19
   *  mandate: "DAPI truth always exists independently of the trading flag".
   *  binance_coinm_main equity syncs/snapshots, but the sleeve itself stays
   *  INACTIVE — no card, no circuit, no momentum_btc snapshot row, and
   *  syncBinanceCoinM's DB-vs-broker reconciliation never runs, because a
   *  real funded DAPI position with no matching DB row would otherwise look
   *  like an "orphan" and get emergency-closed). Absent entries default to
   *  "live" (every always-on sleeve). Drives the dashboard card's status
   *  label — never a fake "LIVE" while the flag is off. */
  private sleeveMode: Map<RiskProfileId, "live" | "close-only" | "truth-only"> = new Map();

  /** Injected from index.ts — the engines' RiskGuard states, for the dashboard. */
  private engineStates: (() => Partial<Record<RiskProfileId, EngineCircuitState>>) | null = null;

  /** Last stock symbol list sent to Alpaca's IEX WS — used to avoid resubscribing
   *  on every state update when holdings haven't changed. */
  private lastStockWsSymbolsKey = "";

  // Executor is injectable so a system/smoke test can drive the sync loops
  // against a fake broker (the 4-day BrokerSync no-op class was invisible
  // precisely because this path was never bootable in a test). Defaults to the
  // real one so index.ts stays `new AccountManager()`.
  constructor(executor: OrderExecutor = new OrderExecutor()) {
    this.executor = executor;
    for (const id of ALL_PROFILE_IDS) {
      this.accounts.set(id, new AccountInstance(id));
    }
  }

  setEngineStates(fn: () => Partial<Record<RiskProfileId, EngineCircuitState>>) {
    this.engineStates = fn;
  }

  /** Called by index.ts once momentum_crypto_usdc's preflight has passed and
   *  the executor is connected. Starts this sleeve's own 60s reconciliation
   *  loop (staggered — see start()) the next time start() runs, or
   *  immediately if the manager is already running. `live: false` marks the
   *  sleeve ACTIVE (cards/snapshots/reconciliation run) but CLOSE-ONLY — index.ts
   *  attached it despite the feature flag being off because DB/broker
   *  exposure existed; no engine opens new positions in that case. */
  attachUsdcExecutor(exec: BinanceExecutor, opts: { live?: boolean } = {}) {
    this.usdcExecutor = exec;
    this.sleeveMode.set("momentum_crypto_usdc", opts.live === false ? "close-only" : "live");
    if (this.running && !this.usdcSyncInterval) this.startUsdcSyncLoop();
  }

  /** Same contract as attachUsdcExecutor, for momentum_btc / COIN-M — plus a
   *  third mode: `truthOnly: true` attaches the executor for read-only DAPI
   *  truth (binance_coinm_main) WITHOUT activating the momentum_btc sleeve
   *  (see sleeveMode docstring above). index.ts passes this when the flag is
   *  off and there's no DB exposure. */
  attachCoinmExecutor(exec: BinanceCoinMExecutor, opts: { live?: boolean; truthOnly?: boolean } = {}) {
    this.coinmExecutor = exec;
    this.sleeveMode.set("momentum_btc", opts.truthOnly ? "truth-only" : (opts.live === false ? "close-only" : "live"));
    if (this.running && !this.coinmSyncInterval) this.startCoinmSyncLoop();
  }

  /** Registered (config) vs ACTIVE: momentum_crypto_usdc/momentum_btc only
   *  become active once index.ts attaches a preflight-passed executor —
   *  either because the feature flag is on, or (flag off) because real
   *  DB/broker exposure forced a close-only attach (see index.ts). Every
   *  always-on sleeve is active unconditionally. Flags-off-with-no-exposure
   *  sleeves stay OUT of this list forever — no card, no snapshot row, no
   *  circuit, no consolidated-total contribution. momentum_btc in
   *  "truth-only" mode (DAPI truth attached, but never live/close-only)
   *  ALSO stays inactive by this same rule — its binance_coinm_main truth
   *  still syncs (see writeAllSnapshots/syncBinanceCoinM), just not the
   *  sleeve itself. */
  private isActive(id: RiskProfileId): boolean {
    if (id === "momentum_crypto_usdc") return this.usdcExecutor !== null;
    if (id === "momentum_btc") { const m = this.sleeveMode.get("momentum_btc"); return m === "live" || m === "close-only"; }
    return true;
  }

  getActiveProfileIds(): RiskProfileId[] {
    return ALL_PROFILE_IDS.filter(id => this.isActive(id));
  }

  /** Platform F3d: the broker accounts this runtime has wired (the portfolio
   *  validator only accepts these). */
  runtimeAccounts(): string[] {
    return [
      "alpaca_main",
      "binance_usdt",
      ...(this.usdcExecutor ? ["binance_usdc"] : []),
      ...(this.coinmExecutor ? ["binance_coinm"] : []),
    ];
  }

  /** Platform F3d: broker-truth equity of a runtime account, or null without a
   *  fresh broker reading (the portfolio validator then fails closed). The
   *  Binance pools read the trackers the 60s syncs feed with marginEquity. */
  brokerAccountEquity(account: string): number | null {
    switch (account) {
      case "alpaca_main":
        return this.alpacaMainTruth && isBrokerTruthAvailable("alpaca") ? this.alpacaMainTruth.equity : null;
      case "binance_usdt":
        return isBrokerTruthAvailable("binance") ? this.accounts.get("momentum_crypto")?.equity.equity ?? null : null;
      case "binance_usdc":
        return this.usdcExecutor && isBrokerTruthAvailable("binance") ? this.accounts.get("momentum_crypto_usdc")?.equity.equity ?? null : null;
      default:
        return null;
    }
  }

  getCircuits(): Record<string, EngineCircuitState> {
    const out: Record<string, EngineCircuitState> = {};
    const states = this.engineStates?.() ?? {};
    for (const id of this.getActiveProfileIds()) {
      out[id] = states[id] ?? { paused: false, reason: "", resumeAt: 0 };
    }
    return out;
  }

  getActiveStrategies() {
    return [{ name: "MOMENTUM_TSM", enabled: true, signals: 0 }];
  }

  async init() {
    log.info("Initializing Account Manager (2 momentum sleeves)...");
    await this.executor.init();
    this.recoverPositions();
    for (const [, acc] of this.accounts) {
      log.info(`${acc.profile.emoji} ${acc.profile.label}: equity=$${acc.equity.equity.toFixed(2)}, pos=${acc.positions.size}`);
    }
    log.info("Account Manager initialized");
  }

  async start() {
    if (this.running) return;
    this.running = true;

    log.info("🚀 Starting account manager v8 (momentum sleeves: stocks + crypto)...");

    // Alpaca WS for live prices (stocks + crypto) is started lazily inside
    // updateAllStates once positions are loaded, and refreshed when holdings
    // change. Crypto SL pricing uses Binance mark price.

    eventBus.on(EVENTS.PRICE_UPDATE, (data: any) => {
      this.emitPositionUpdates(data.symbol, data.price);
    });

    // Every async setInterval body must be wrapped in `.catch(...)` because
    // `setInterval(() => asyncFn(), …)` discards the returned Promise and any
    // throw inside it becomes an unhandledRejection (silent crash).
    const safeAsync = (label: string, fn: () => Promise<unknown> | unknown) => () => {
      try {
        const r = fn();
        if (r && typeof (r as any).catch === "function") {
          (r as Promise<unknown>).catch((e: any) => log.error(`${label} failed: ${e?.message ?? e}`));
        }
      } catch (e: any) {
        log.error(`${label} threw: ${e?.message ?? e}`);
      }
    };

    // ── Loop heartbeats ──────────────────────────────────────────────────
    // Every orchestrator interval registers here and beat()s at the END of a
    // successful run. Two past outages were SILENT loop deaths the ERROR_BURST
    // logger can't catch (a dead loop emits nothing). The two 60s syncs used to
    // share ONE lastSyncAt, so one dying was invisible — separate per-loop beats
    // fix exactly that. register/beat never throw into the loop (see heartbeat.ts).
    try {
      heartbeats.register("sl_loop", 15_000);        // grace 2 → 30s
      heartbeats.register("sync_alpaca", 60_000);    // grace 2 → 2min
      heartbeats.register("sync_binance", 60_000);   // grace 2 → 2min
      heartbeats.register("snapshots", 5 * 60_000);  // grace 2 → 10min
      heartbeats.register("prune", 6 * 60 * 60_000); // grace 2 → 12h
      if (this.usdcExecutor) heartbeats.register("sync_binance_usdc", 60_000);
      if (this.coinmExecutor) heartbeats.register("sync_binance_coinm", 60_000);
    } catch (e: any) { log.warn(`heartbeat register failed: ${e?.message ?? e}`); }

    this.snapshotInterval = setInterval(safeAsync("snapshot", async () => {
      await this.updateAllStates(); // refresh in-memory state
      this.writeAllSnapshots();     // SINGLE writer of equity_snapshots (see method)
      this.runDailyInvariantCheck();
      heartbeats.beat("snapshots");
    }), 5 * 60_000);

    // Activity listeners
    eventBus.on(EVENTS.ORDER_FILLED, (o: any) => {
      try { insertActivity(o.accountId || null, "order", `${o.side?.toUpperCase()} ${o.quantity} ${o.symbol} @ $${(o.filledPrice || o.price)?.toFixed(2)}`); } catch {}
      this.scheduleStopOnFillPass(o); // never throws — see the method's contract
    });
    eventBus.on(EVENTS.POSITION_CLOSED, (t: any) => {
      try { insertActivity(t.accountId || null, "close", `${t.symbol} PnL $${t.pnl?.toFixed(2)} (${t.pnlPct?.toFixed(1)}%)`); } catch {}
    });

    // Execution WS (EXECUTION_WS=true): consume ORDER_UPDATE from broker WS
    // adapters — advances the OrderStateMachine and persists state on the
    // orders row. The REST polling fallback still runs; whichever fires first
    // wins (the OSM rejects invalid transitions).
    eventBus.on(EVENTS.ORDER_UPDATE, (msg: any) => {
      try {
        const externalId = msg?.externalId;
        if (!externalId) return;
        const { getDB } = require("../db/database");
        const row = getDB()
          .prepare(`SELECT id FROM orders WHERE external_id = ? LIMIT 1`)
          .get(externalId) as { id: string } | undefined;
        if (!row?.id) return;
        const { fromBrokerStatus } = require("../executor/OrderStateMachine");
        const newState = fromBrokerStatus(msg.status);
        if (!newState) return;
        const transition = this.executor.osm.transition(row.id, newState);
        if (transition.ok) {
          const { updateOrderStateFields } = require("../db/database");
          updateOrderStateFields(row.id, newState, msg.filledQty || 0, msg.avgPx || 0);
          if (transition.from !== newState) {
            log.debug(`OSM ${row.id}: ${transition.from ?? "·"} → ${newState} (via WS ${msg.broker})`);
          }
        } else {
          log.debug(`OSM ${row.id}: rejected ${transition.from} → ${newState} (via WS ${msg.broker}); skipping DB write`);
        }
      } catch (e: any) {
        log.warn(`ORDER_UPDATE handler failed: ${e?.message ?? e}`);
      }
    });

    // Broker truth must land before engines start; otherwise the first crypto
    // tick sizes against stale persisted equity and can over-order. Same
    // reasoning for momentum_crypto_usdc/momentum_btc when active (2026-07-19
    // mandate: "first enable initializes from broker truth before first
    // snapshot, no seed jump") — an ACTIVE sleeve's very first
    // writeAllSnapshots() call below must never persist its EquityTracker
    // constructor seed (initialEquity) as if it were a real reading. The
    // periodic loops stay staggered (+20s/+40s, see startUsdcSyncLoop/
    // startCoinmSyncLoop) — only this ONE-TIME startup sync is pulled forward.
    setBrokerTruthAvailable("alpaca", false);
    setBrokerTruthAvailable("binance", false);
    const startupSyncs = [this.syncAlpacaAccount(), this.syncBinanceFutures()];
    if (this.usdcExecutor) startupSyncs.push(this.syncBinanceUsdc());
    if (this.coinmExecutor) startupSyncs.push(this.syncBinanceCoinM());
    await Promise.all(startupSyncs);

    // Warm up state before the first snapshot so a restart with open positions
    // doesn't write a transient dip into the equity curve.
    try { await this.updateAllStates(); } catch (e: any) { log.warn(`startup state warm-up failed: ${e?.message ?? e}`); }
    this.writeAllSnapshots(); // startup anchor via the single writer (*_main skipped until first sync caches truth)

    this.accountSyncInterval = setInterval(safeAsync("syncAlpacaAccount", () => this.syncAlpacaAccount()), 60_000);
    this.reconcileInterval = setInterval(safeAsync("syncBinanceFutures", () => this.syncBinanceFutures()), 60_000);

    // 2026-07-19: momentum_crypto_usdc / momentum_btc — only if index.ts
    // already attached a preflight-passed executor. The startup sync already
    // ran above; these just start the PERIODIC staggered loops (+20s/+40s)
    // so subsequent Binance sync loops don't burst-request in the same tick.
    if (this.usdcExecutor) this.startUsdcSyncLoop();
    if (this.coinmExecutor) this.startCoinmSyncLoop();

    // Hard stop-loss enforcement, detached from the (removed) scan loop.
    this.stopLossInterval = setInterval(safeAsync("checkAllStopLoss", () => this.checkAllStopLoss()), 15_000);

    // DB maintenance (equity_snapshots downsample + table pruning) every 6h.
    this.pruneInterval = setInterval(safeAsync("pruneOldData", () => { pruneOldData(); heartbeats.beat("prune"); }), 6 * 60 * 60_000);

    insertActivity(null, "system", "Account manager started (v8 — 2 momentum sleeves)");
    log.info("✅ Account manager started");
  }

  async stop() {
    this.running = false;
    this.deferredLoggedReasons.clear();
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    if (this.accountSyncInterval) clearInterval(this.accountSyncInterval);
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
    if (this.stopLossInterval) clearInterval(this.stopLossInterval);
    if (this.pruneInterval) clearInterval(this.pruneInterval);
    if (this.usdcSyncInterval) clearInterval(this.usdcSyncInterval);
    if (this.coinmSyncInterval) clearInterval(this.coinmSyncInterval);
    if (this.stopOnFillTimer) { clearTimeout(this.stopOnFillTimer); this.stopOnFillTimer = null; }
    this.executor.alpaca.cleanup();
    // Bounded, best-effort: close any WS/listenKey/timer the new sleeves'
    // executors opened. Deliberately NEVER cancels native STOP_MARKET/algo
    // stops — those must keep protecting a live position while the process
    // is down (same contract as BinanceCoinMExecutor.shutdown's docstring).
    try { this.usdcExecutor?.stopUserDataStream(); } catch (e: any) { log.warn(`usdc executor shutdown: ${e?.message ?? e}`); }
    try { this.coinmExecutor?.shutdown(); } catch (e: any) { log.warn(`coinm executor shutdown: ${e?.message ?? e}`); }
    log.info("Account manager stopped");
  }

  /** Staggered +20s so the USDC sync doesn't request-burst alongside the
   *  existing USDT sync (which starts at t=0 inside start()). */
  private startUsdcSyncLoop() {
    try { heartbeats.register("sync_binance_usdc", 60_000); } catch (e: any) { log.warn(`heartbeat register failed: ${e?.message ?? e}`); }
    const run = () => this.syncBinanceUsdc().catch((e: any) => log.error(`syncBinanceUsdc failed: ${e?.message ?? e}`));
    setTimeout(run, 20_000);
    this.usdcSyncInterval = setInterval(run, 60_000);
    log.info("🚀 momentum_crypto_usdc sync loop started (+20s stagger)");
  }

  /** Staggered +40s — see startUsdcSyncLoop. */
  private startCoinmSyncLoop() {
    try { heartbeats.register("sync_binance_coinm", 60_000); } catch (e: any) { log.warn(`heartbeat register failed: ${e?.message ?? e}`); }
    const run = () => this.syncBinanceCoinM().catch((e: any) => log.error(`syncBinanceCoinM failed: ${e?.message ?? e}`));
    setTimeout(run, 40_000);
    this.coinmSyncInterval = setInterval(run, 60_000);
    log.info("🚀 momentum_btc sync loop started (+40s stagger)");
  }

  // ── Hard stop-loss (defense-in-depth) ─────
  //
  // Only the hard STOP_LOSS trigger at profile.stopLossPct. The Binance
  // adapter attaches a broker-native SL at open, and Alpaca stock rows get a
  // broker-native GTC stop via ensureAlpacaNativeStops (60s sync) — this
  // loop stays the PRIMARY in-session stop for Alpaca (reacts in 15s, the
  // native stop is the market-closed backstop). No trailing / TAKE_PROFIT /
  // MAX_HOLD — exits belong to the momentum engine's rebalance.

  private async checkAllStopLoss() {
    if (this.checkingStopLoss) return; // reentrancy guard (close polls can exceed 15s)
    this.checkingStopLoss = true;
    try {
      // Pre-fetch Binance mark prices for all open Binance trades.
      const binancePrices: Map<string, number> = new Map();
      if (this.executor.binance.isConnected()) {
        try {
          const binanceSymbols = new Set<string>();
          for (const [id, acc] of this.accounts) {
            if (acc.profile.broker !== "binance") continue;
            for (const trade of getOpenTrades(id)) {
              if (BinanceExecutor.toBinanceSymbol(trade.symbol)) binanceSymbols.add(trade.symbol);
            }
          }
          for (const sym of binanceSymbols) {
            const binSym = BinanceExecutor.toBinanceSymbol(sym)!;
            const price = await this.executor.binance.getPrice(binSym);
            if (price > 0) binancePrices.set(sym, price);
          }
        } catch (e: any) { log.warn(`Binance price fetch failed: ${e.message}`); }
      }

      const marketOpen = isMarketOpen();
      const openPriceKeys = new Set<string>(); // (accountId:symbol) with an open non-Binance position THIS pass
      const staleSymbols: string[] = []; // crossed the consecutive-miss threshold THIS pass
      const openDeferKeys = new Set<string>(); // (accountId:symbol:STOP_LOSS) open THIS pass
      const stuckCloses: string[] = []; // crossed the consecutive-defer threshold THIS pass

      // Tier-3 SL price fallback (2026-08-07): Alpaca's OWN position mark
      // (`current_price` from GET /v2/positions), available 24/7. The IEX
      // tape is so sparse (~2.5-5% of consolidated volume, measured on HON)
      // that a subscribed symbol can go >30s — sometimes minutes — without a
      // single trade, starving both the WS cache and the REST risk read and
      // leaving the stop UNEVALUATED (prod: "Alpaca SL price unavailable for
      // ABBV/CAT/CVX" every 20-30min). Same once-per-pass contract as
      // EquityTracker.buildSleevePriceMap (added 2026-07-25 for the same
      // cache+REST blind spot): fetched lazily, at most ONCE per pass, only
      // if some symbol missed cache AND REST. Alpaca marks serve Alpaca
      // trades ONLY — the Binance branch below never reads this map
      // (pitfall #4: cross-venue price fallback caused false stops).
      let alpacaMarks: Map<string, number> | null | undefined;
      const getAlpacaMarks = async (): Promise<Map<string, number> | null> => {
        if (alpacaMarks !== undefined) return alpacaMarks;
        alpacaMarks = null; // one attempt per pass, even on failure
        if (typeof this.executor.alpaca.getPositions === "function" && this.executor.alpaca.isConnected?.()) {
          try {
            const positions = await this.executor.alpaca.getPositions();
            alpacaMarks = new Map(
              positions
                .filter(p => Number.isFinite(p.currentPrice) && p.currentPrice > 0)
                .map(p => [p.symbol, p.currentPrice]),
            );
          } catch (e: any) {
            log.warn(`SL broker-mark fallback: alpaca getPositions failed (${e?.message ?? e}) — miss escalation proceeds`);
          }
        }
        return alpacaMarks;
      };
      for (const [id, acc] of this.accounts) {
        // momentum_crypto_usdc / momentum_btc (2026-07-19): this loop's price
        // sourcing and closeTradeDirectly's close routing are hardcoded to
        // this.executor.binance (USDT) / this.executor.alpaca — routing a
        // USDC/COIN-M symbol through either would violate "never route
        // USDC/COIN-M through the USDT executor" (separate wallets/APIs).
        // Their protection is the broker-native STOP_MARKET each adapter
        // installs at open (defense-in-depth is native, not this client
        // loop); their own syncBinanceUsdc/syncBinanceCoinM reconcile a
        // broker-flat DB row using the CORRECT executor.
        if (acc.profile.broker === "binance_usdc" || acc.profile.broker === "binance_coinm") continue;
        for (const trade of getOpenTrades(id)) {
          // Treasury ETF (BOXX/SGOV/BIL): never stop-managed — same defense in
          // depth as runAlpacaNativeStopsPass (the sweep keeps no trades
          // row; this only fires on a manual/legacy row).
          if (isTreasurySymbol(trade.symbol)) continue;
          // In scope regardless of skip/continue below — a PDT-blocked or
          // market-closed position is still open and must not be pruned.
          openDeferKeys.add(`${id}:${trade.symbol}:STOP_LOSS`);
          // Stocks: skip SL close attempts while the market is CLOSED. A market
          // close can't fill, so closeTradeDirectly's poll hangs ~30s, stalling
          // the whole 15s loop → the heartbeat watchdog paged `sl_loop` stale
          // and every other position's SL check was delayed (observed 2026-07-16
          // on JNJ overnight). The stop re-evaluates and fires at the next open.
          // Crypto (24/7) is unaffected.
          if (acc.profile.broker !== "binance" && !marketOpen) continue;
          // Skip close attempts on a position the broker keeps 403ing
          // (PDT/permission). Self-clears after the block window.
          const pdtUntil = this.pdtBlockedUntil.get(`${id}:${trade.symbol}`);
          if (pdtUntil && pdtUntil > Date.now()) continue;

          // Correct-broker price sourcing: Binance mark price for Binance
          // trades — NO cross-broker fallback (exchange price discrepancy
          // triggers false stops).
          let currentPrice = 0;
          // Which source produced the price that evaluates this stop — logged
          // on trigger so a stop fired off the broker's mark (not a live
          // trade) is distinguishable in the record.
          let priceSource: "binance_mark" | "ws_cache" | "rest" | "broker_mark" = "binance_mark";
          if (acc.profile.broker === "binance") {
            currentPrice = binancePrices.get(trade.symbol) || 0;
            if (currentPrice <= 0) {
              log.debug(`[${id}] Skip SL check for ${trade.symbol}: no Binance mark price available`);
              continue;
            }
          } else {
            // Risk-monitoring price, NOT the executable one: on the IEX feed a
            // liquid symbol (measured: UNH) can go minutes without printing a
            // trade, and the <30s executable standard left this loop — Alpaca
            // positions' ONLY stop protection — blind for hours. A bounded
            // few-minutes-old price is valid for "is this past its stop?";
            // getRiskPrice stays fail-closed (0) beyond its window.
            const hadFreshCache = (this.executor.alpaca.getCachedPrice?.(trade.symbol) ?? 0) > 0;
            currentPrice = await this.executor.alpaca.getRiskPrice(trade.symbol);
            priceSource = hadFreshCache ? "ws_cache" : "rest";
            const priceKey = `${id}:${trade.symbol}`;
            openPriceKeys.add(priceKey); // in scope this pass → survives the end-of-pass prune below
            if (currentPrice <= 0) {
              // Tier 3: the broker's own mark (see getAlpacaMarks above) —
              // Alpaca marks for Alpaca symbols only, never cross-venue. A
              // missing/zero mark falls through to the miss counter below;
              // no source ever invents a price.
              const mark = (await getAlpacaMarks())?.get(trade.symbol);
              if (Number.isFinite(mark) && (mark as number) > 0) {
                currentPrice = mark as number;
                priceSource = "broker_mark";
              }
            }
            if (currentPrice <= 0) {
              // A sustained miss is the signal, not a single transient one —
              // count consecutive misses and only escalate (see below) past
              // the threshold. No per-symbol log here: with a permanently-down
              // feed across N symbols that would be N pages every pass.
              const misses = recordUnavailablePriceMiss(this.unavailablePriceMisses, priceKey);
              if (misses >= 5) staleSymbols.push(trade.symbol);
              continue;
            }
            // Plausibility vs OUR OWN entry fill — an anchor we actually
            // paid, so an order-of-magnitude gap means the READ is garbage,
            // not the market (measured: worst real 30-day universe move is
            // −52.7%, the ×10 band has >5× margin — see plausibility.ts).
            // Observe (default): count only, price flows on unchanged.
            // Enforce: treat like a price miss so the existing consecutive-
            // miss escalation and aggregated alert cover sustained garbage.
            // Alpaca branch only: Binance marks are exchange-computed, and
            // measured crypto moves (DOGE +1075%/30d) breach any sane band.
            const verdict = checkPrice(currentPrice, trade.entryPrice, DEFAULT_PLAUSIBILITY);
            if (!verdict.ok) {
              this.plausibilityTally.add(`${trade.symbol}:${verdict.reason}`);
              if (plausibilityMode() === "enforce") {
                const misses = recordUnavailablePriceMiss(this.unavailablePriceMisses, priceKey);
                if (misses >= 5) staleSymbols.push(trade.symbol);
                continue;
              }
            }
            this.unavailablePriceMisses.delete(priceKey); // recovered
          }
          // currentPrice > 0 here: both branches above `continue` on a miss.

          // pnlOf's pct ≡ (Δprice/entry)×100 for qty>0; the guard additionally
          // yields 0 (never ±Infinity → false stop) on a corrupt entry/qty.
          const { pnlPct } = pnlOf(trade.side, trade.entryPrice, currentPrice, trade.quantity);

          // Per-ROW stop distance first (vol-scaled at entry, trades.stop_loss
          // — see rowStopPct), profile fixed pct as fallback. Same precedence
          // as ensureNativeStopForRow, or the two layers fight.
          const stopPct = rowStopPct(trade, acc.profile.stopLossPct);
          if (pnlPct <= -stopPct) {
            log.warn(`[${id}] ⛔ STOP_LOSS ${trade.symbol}: ${pnlPct.toFixed(2)}% (stop ${stopPct.toFixed(2)}%${trade.stopLoss ? " row-stop" : ""}, price source: ${priceSource})`);
            const stuck = await this.closeTradeDirectly(acc, trade, currentPrice, "STOP_LOSS");
            if (stuck) stuckCloses.push(stuck);
          }
        }
      }

      // Prune counters for symbols that are no longer an open position —
      // self-bounding, no separate cleanup needed on stop() or recovery.
      for (const key of this.unavailablePriceMisses.keys()) {
        if (!openPriceKeys.has(key)) this.unavailablePriceMisses.delete(key);
      }
      for (const key of this.deferredCloseCounts.keys()) {
        if (!openDeferKeys.has(key)) this.deferredCloseCounts.delete(key);
      }
      // Same keys, same prune: a row closed by ANY path (engine rebalance,
      // BrokerSync, native stop) drops its suppressed-reason entry too.
      for (const key of this.deferredLoggedReasons.keys()) {
        if (!openDeferKeys.has(key)) this.deferredLoggedReasons.delete(key);
      }

      // ONE aggregated page per pass across every stale symbol — an Alpaca
      // feed outage hits many symbols at once, and one Telegram page beats
      // one per symbol every 5 minutes forever.
      if (staleSymbols.length > 0 && Date.now() - this.lastPriceAlertAt >= UNAVAILABLE_PRICE_LOG_COOLDOWN_MS) {
        const windowMs = this.lastPriceAlertAt > 0 ? Date.now() - this.lastPriceAlertAt : UNAVAILABLE_PRICE_LOG_COOLDOWN_MS;
        this.lastPriceAlertAt = Date.now();
        const msg = `Alpaca SL price unavailable for ${staleSymbols.length} symbol(s): ${staleSymbols.join(", ")}`;
        log.warn(`[AccountManager] ${msg}`);
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "AccountManager",
          message: msg,
          count: staleSymbols.length,
          windowMs,
          firstAt: Date.now() - windowMs,
          lastAt: Date.now(),
        });
      }

      // ONE aggregated page per pass across every stuck close — same idiom
      // as the stale-price alert above, not a second mechanism.
      if (stuckCloses.length > 0 && Date.now() - this.lastDeferredCloseAlertAt >= DEFERRED_CLOSE_ALERT_COOLDOWN_MS) {
        const windowMs = this.lastDeferredCloseAlertAt > 0 ? Date.now() - this.lastDeferredCloseAlertAt : DEFERRED_CLOSE_ALERT_COOLDOWN_MS;
        this.lastDeferredCloseAlertAt = Date.now();
        const msg = `${stuckCloses.length} close(s) stuck DEFERRED past ${DEFERRED_CLOSE_ESCALATE_AFTER} consecutive attempts: ${stuckCloses.join(", ")}`;
        log.warn(`[AccountManager] ${msg}`);
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "AccountManager",
          message: msg,
          count: stuckCloses.length,
          windowMs,
          firstAt: Date.now() - windowMs,
          lastAt: Date.now(),
        });
      }
      // Plausibility rejection visibility — same aggregated-with-cooldown
      // idiom as the two alerts above (RejectionTally holds the 5min
      // cooldown itself); log-only until enforce mode has live mileage.
      const plausMsg = this.plausibilityTally.flush();
      if (plausMsg) {
        const mode = plausibilityMode();
        log.warn(`[plausibility ${mode}] ${plausMsg}${mode === "observe" ? " (observe: nothing blocked)" : ""}`);
      }

      heartbeats.beat("sl_loop"); // completed a full pass
    } finally {
      this.checkingStopLoss = false;
    }
  }

  // ── Close path ────────────────────────────

  /** Returns a "SYMBOL (trigger: reason)" string once this close's consecutive
   *  defer count crosses DEFERRED_CLOSE_ESCALATE_AFTER, for the caller to
   *  aggregate into one ERROR_BURST per pass — undefined otherwise. */
  private async closeTradeDirectly(acc: AccountInstance, trade: any, exitPrice: number, trigger: string): Promise<string | void> {
    // Do NOT close in DB unless the broker confirms — phantom "closed" rows
    // skew analytics and block retries.
    let realExitPrice = exitPrice;
    let closeCommission = 0;
    let brokerPnl: number | null = null;
    let brokerConfirmed = false;
    let closeTelemetryResult: any;

    if (acc.profile.broker === "binance") {
      if (this.executor.binance.isConnected()) {
        // Mainnet stop confirmation (OPEN.md P1, wired 2026-08-11): on 2026-07-20
        // a LINK stop fired at a testnet price that never existed on mainnet —
        // signals read mainnet klines while execution and the trigger price come
        // from testnet, whose book can print prices that were never real. Only a
        // STOP_LOSS close is confirmed: an engine or reconciler exit is not
        // triggered by a price and has nothing to confirm. Defaults to observe
        // mode, so this counts what it WOULD have blocked and changes nothing
        // until BINANCE_STOP_CONFIRM_MODE says otherwise.
        const closeResult = await this.executor.binance.closePosition(
          trade.symbol, trade.quantity, trade.side,
          trigger === "STOP_LOSS"
            // rowStopPct: confirm against the stop that actually ARMED this
            // row (persisted at entry), not the profile constant — they can
            // differ once a sleeve carries per-row vol-scaled stops.
            ? { stopConfirm: { entryPrice: trade.entryPrice, stopLossPct: rowStopPct(trade, acc.profile.stopLossPct), triggerPrice: exitPrice } }
            : {},
        );
        closeTelemetryResult = closeResult;
        if (closeResult.success && closeResult.filledPrice > 0) {
          realExitPrice = closeResult.filledPrice;
          closeCommission = closeResult.commission;
          brokerPnl = closeResult.realizedPnl - closeResult.commission - getOpenCommission(trade.id);
          brokerConfirmed = true;
          if (closeResult.exitTime) (trade as any).__exitTime = closeResult.exitTime;
        }
      }
    } else if (this.executor.alpaca.isConnected()) {
      // Pass OUR row's quantity — the broker book is the account's AGGREGATE
      // (which may include manual/unknown shares), and a qty-less close
      // liquidates it all. The executor bounds the close to min(ours, broker).
      const closeResult = await this.executor.alpaca.closePosition(trade.symbol, trade.side, trade.quantity);
      closeTelemetryResult = closeResult;
      if (closeResult.success && closeResult.filledPrice > 0) {
        realExitPrice = closeResult.filledPrice;
        brokerConfirmed = true;
      } else if (closeResult.reason === "http_403") {
        // A 403 on close is usually the position being ALREADY FLAT on the
        // broker (Alpaca returns 403, not 404, for some gone positions).
        // Verify: if it's actually gone, reconcile instead of blocking forever.
        let stillOpen = true;
        try {
          const brokerPos = await this.executor.alpaca.getPositions();
          stillOpen = brokerPos.some((p: any) => (p.symbol === trade.symbol) || (p.symbol === trade.symbol.replace("/", "")));
        } catch { stillOpen = true; } // can't verify → assume open, block (safe)
        if (!stillOpen) {
          // A flat broker position with an open row is EXPECTED when the
          // native GTC stop fired (e.g. an overnight gap): attribute the
          // real fill first — a pnl=0 BROKER_GONE_404 row would erase the
          // very loss the stop realized.
          if (await this.attributeAlpacaNativeStopFill(acc, trade)) {
            this.deferredLoggedReasons.delete(`${acc.id}:${trade.symbol}:${trigger}`);
            this.deferredCloseCounts.delete(`${acc.id}:${trade.symbol}:${trigger}`);
            return;
          }
          log.warn(`[${acc.id}] 🗑 ${trigger} ${trade.symbol}: 403 but broker has NO such position — reconciling DB row (BROKER_GONE_404).`);
          if (this.reconcileGonePosition(acc, trade, "BROKER_GONE_404", "closed externally (403/gone) — DB reconciled")) {
            this.deferredLoggedReasons.delete(`${acc.id}:${trade.symbol}:${trigger}`);
            this.deferredCloseCounts.delete(`${acc.id}:${trade.symbol}:${trigger}`);
            return;
          }
        } else {
          this.handleAlpacaPdtBlock(acc.id, trade.symbol, trigger);
        }
      } else if (closeResult.reason === "http_404") {
        // Broker has no position — closed externally. Before writing a
        // fabricated pnl=0 row, check whether OUR native GTC stop fired: if
        // so, close with the REAL fill (BROKER_STOP_LOSS).
        if (await this.attributeAlpacaNativeStopFill(acc, trade)) {
          this.deferredLoggedReasons.delete(`${acc.id}:${trade.symbol}:${trigger}`);
          this.deferredCloseCounts.delete(`${acc.id}:${trade.symbol}:${trigger}`);
          return;
        }
        log.warn(`[${acc.id}] 🗑 ${trigger} ${trade.symbol}: broker returned 404 (position gone). Reconciling DB row (BROKER_GONE_404).`);
        if (this.reconcileGonePosition(acc, trade, "BROKER_GONE_404", "closed externally (broker 404) — DB reconciled")) {
          this.deferredLoggedReasons.delete(`${acc.id}:${trade.symbol}:${trigger}`);
          this.deferredCloseCounts.delete(`${acc.id}:${trade.symbol}:${trigger}`);
          return;
        }
      }
    }

    if (!brokerConfirmed) {
      // Broker did not accept the close. Keep the position open; the 15s loop
      // retries. Log once per (profile,symbol,trigger) — logs again only if
      // the reason CHANGES (a genuinely new failure mode), so a broker
      // returning varying messages during one persistent failure logs once,
      // not once per distinct message.
      const reason = closeTelemetryResult?.reason || "unknown";
      const deferKey = `${acc.id}:${trade.symbol}:${trigger}`;
      if (this.deferredLoggedReasons.get(deferKey) !== reason) {
        this.deferredLoggedReasons.set(deferKey, reason);
        log.warn(`[${acc.id}] 🔁 ${trigger} close DEFERRED for ${trade.symbol}: broker did not confirm (${reason})`);
      }
      const count = (this.deferredCloseCounts.get(deferKey) ?? 0) + 1;
      this.deferredCloseCounts.set(deferKey, count);
      if (count >= DEFERRED_CLOSE_ESCALATE_AFTER) return `${trade.symbol} (${trigger}: ${reason})`;
      return;
    }

    // Close succeeded — clear the suppressed DEFERRED entry and defer
    // counter for this (profile,symbol,trigger).
    this.deferredLoggedReasons.delete(`${acc.id}:${trade.symbol}:${trigger}`);
    this.deferredCloseCounts.delete(`${acc.id}:${trade.symbol}:${trigger}`);
    this.resolveCloseRejectedIncident(acc.id, trade.symbol, "close confirmed by the broker");

    const result = closeTrade(trade.id, realExitPrice, (trade as any).__exitTime || Date.now(), closeCommission, brokerPnl !== null ? brokerPnl : undefined);
    if (!result) return;

    // Fill telemetry is best-effort and never changes the confirmed close.
    try {
      if (closeTelemetryResult?.submittedPx > 0) recordFill({
        tradeId: trade.id,
        orderId: closeTelemetryResult.orderId ?? trade.orderId ?? trade.id,
        accountId: acc.id,
        symbol: trade.symbol,
        side: trade.side === "buy" ? "sell" : "buy",
        market: acc.profile.broker === "binance" ? "crypto" : "stock",
        expectedPx: closeTelemetryResult.submittedPx,
        submittedPx: closeTelemetryResult.submittedPx,
        filledPx: realExitPrice,
        filledQty: closeTelemetryResult.filledQty ?? trade.quantity,
        fillTime: closeTelemetryResult.filledAt ?? closeTelemetryResult.exitTime ?? (trade as any).__exitTime ?? Date.now(),
        latencyMs: Math.max(0, (closeTelemetryResult.filledAt ?? closeTelemetryResult.exitTime ?? Date.now()) - (closeTelemetryResult.submittedAt ?? Date.now())),
        broker: acc.profile.broker,
      });
    } catch (e: any) {
      log.warn(`[${acc.id}] exit fill telemetry failed for ${trade.symbol}: ${e.message}`);
    }

    // closeTrade already forced close_reason=MANUAL_CLOSE_UNRECONCILED when
    // both the broker PnL and the price-derived PnL were non-finite (so the
    // fabricated-zero row is excluded from strategy stats) — don't clobber
    // that with the normal trigger reason.
    if (result.closeReason !== "MANUAL_CLOSE_UNRECONCILED") {
      try { updateTradeCloseReason(trade.id, trigger); } catch {}
    }
    acc.positions.delete(trade.symbol);
    eventBus.emit(EVENTS.POSITION_CLOSED, { ...result, accountId: acc.id });
    log.trade(`[${acc.id}] 📉 ${trigger} closed ${trade.symbol} @ $${realExitPrice.toFixed(4)}: PnL $${result.pnl.toFixed(2)}`);
  }

  /** Reconcile a position the broker no longer holds: close the DB row at entry
   *  (pnl=0), drop it from memory, clear any 403 block, emit a close. */
  private reconcileGonePosition(acc: AccountInstance, trade: any, reasonCode: string, note: string): boolean {
    const gone = closeTrade(trade.id, trade.entryPrice, Date.now(), 0, 0);
    if (!gone) return false;
    try { updateTradeCloseReason(trade.id, reasonCode); } catch {}
    acc.positions.delete(trade.symbol);
    this.resolveCloseRejectedIncident(acc.id, trade.symbol, `position confirmed already flat on the broker (${reasonCode})`);
    insertActivity(acc.id, "close", `${trade.symbol} ${note}`);
    eventBus.emit(EVENTS.POSITION_CLOSED, { ...gone, accountId: acc.id, close_reason: reasonCode });
    return true;
  }

  private handleAlpacaPdtBlock(profileId: RiskProfileId, symbol: string, trigger: string) {
    // Block further close attempts on THIS position for 6h so the 15s loop
    // doesn't hammer the broker with rejected closes. Self-clears.
    const key = `${profileId}:${symbol}`;
    const isNewIncident = !this.pdtBlockedUntil.has(key);
    this.pdtBlockedUntil.set(key, Date.now() + 6 * 60 * 60_000);
    const reason = `Alpaca 403 on ${symbol} (${trigger}) — close rejected (PDT/permission/SSR); retrying in 6h`;
    log.warn(`[${profileId}] 🚧 ${reason}`);
    try { insertActivity(profileId, "circuit", reason); } catch {}
    if (isNewIncident) {
      // Immediate ops page: a close rejected with the position still LIVE
      // (broker confirmed it, not the flat/gone case handled above) — never
      // wait on the logger's 10-in-60s threshold for this.
      eventBus.emit(EVENTS.ERROR_BURST, {
        context: "AccountManager.closeRejected",
        message: `[${profileId}] ${reason}`,
        count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
      });
    }
  }

  /** Resolves a previously-paged close-rejected (403, position live)
   *  incident once the row actually closes or the broker confirms it's
   *  flat — a no-op if this (profile, symbol) never paged. */
  private resolveCloseRejectedIncident(profileId: RiskProfileId, symbol: string, resolution: string): void {
    const key = `${profileId}:${symbol}`;
    if (!this.pdtBlockedUntil.delete(key)) return;
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "AccountManager.closeRejected",
      message: `[${profileId}] ${symbol}: close-rejected incident RESOLVED — ${resolution}`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
  }

  // ── Recovery ──────────────────────────────

  private recoverPositions() {
    let recovered = 0;
    for (const [id, acc] of this.accounts) {
      for (const trade of getOpenTrades(id)) {
        let currentPrice = trade.entryPrice;
        const p = this.executor.alpaca.getCachedPrice(trade.symbol);
        if (p > 0) currentPrice = p;
        const { pnl, pnlPct } = pnlOf(trade.side, trade.entryPrice, currentPrice, trade.quantity);
        acc.positions.set(trade.symbol, {
          symbol: trade.symbol, market: trade.market, side: trade.side as any,
          quantity: trade.quantity, avgEntryPrice: trade.entryPrice, currentPrice,
          unrealizedPnl: pnl, unrealizedPnlPct: pnlPct,
          openedAt: trade.entryTime,
        });
        recovered++;
      }
    }
    if (recovered > 0) log.info(`📦 Recovered ${recovered} positions from DB`);
  }

  // ── State ─────────────────────────────────

  async updateAllStates() {
    for (const [id, acc] of this.accounts) {
      try {
        const stats = getTradingStats(id);
        const openTrades = getOpenTrades(id);

        // The engines open positions via adapters that only write DB rows —
        // the in-memory map must follow the DB, not an in-process open path.
        const openSymbols = new Set(openTrades.map(t => t.symbol));
        for (const sym of [...acc.positions.keys()]) {
          if (!openSymbols.has(sym)) acc.positions.delete(sym);
        }

        // Pre-fetch Binance mark prices for this account. Product-scoped:
        // "binance" (USDT) and "binance_usdc" each price ONLY through their
        // OWN executor instance — never each other, never the USDT instance
        // for a USDC symbol (see src/config/riskProfiles.ts BrokerType).
        const bnPriceMap: Map<string, number> = new Map();
        if (acc.profile.broker === "binance" && this.executor.binance.isConnected()) {
          try {
            for (const trade of openTrades) {
              const binSym = BinanceExecutor.toBinanceSymbol(trade.symbol);
              if (!binSym) continue;
              const price = await this.executor.binance.getPrice(binSym);
              if (price > 0) bnPriceMap.set(trade.symbol, price);
            }
          } catch {}
        } else if (acc.profile.broker === "binance_usdc" && this.usdcExecutor?.isConnected()) {
          try {
            for (const trade of openTrades) {
              const nativeSym = USDC_SYMBOL_MAP[trade.symbol];
              if (!nativeSym) continue;
              const price = await this.usdcExecutor.getPrice(nativeSym);
              if (price > 0) bnPriceMap.set(trade.symbol, price);
            }
          } catch {}
        }
        // KNOWN GAP (crypto): a swallowed Binance price fetch above leaves
        // every crypto position at entryPrice → unrealized 0 for that pass.
        // Display-only degradation: perps trade 24/7 (no market-closed case,
        // only transient connectivity), and the daily invariant's ledger check
        // is scoped to LEDGER_SLEEVE_BROKERS (Alpaca sleeves only), so this
        // cannot produce the false-positive class fixed below for stocks.

        // Alpaca sleeves: THE ONE price resolver (EquityTracker's
        // buildSleevePriceMap: WS cache → REST → broker's own 24/7 position
        // mark) — the SAME 3-level fallback syncAlpacaAccount uses to write
        // the sleeve ledger snapshots. The old direct getLatestPrice read
        // here returned 0 whenever the market was closed (executable-quote
        // freshness gate), pinning every stock position to entryPrice →
        // unrealizedPnl ≡ 0 in acc.state — which fed the dashboard, Telegram,
        // AND runDailyInvariantCheck. The daily invariant fires on the first
        // 5-min tick after the ET-midnight date change (market ALWAYS closed
        // then), so it compared a broker-mark-priced snapshot against
        // initial + realized + 0: a permanent false-positive "violation"
        // whose drift was exactly the real unrealized. Root cause = two
        // different price resolvers for the same number; both sides now share
        // one (locked by src/account/invariantMarketClosed.test.ts).
        const alpacaPriceMap: Map<string, number> | null =
          acc.profile.broker === "alpaca" && openTrades.length > 0
            ? await buildSleevePriceMap(this.executor.alpaca, openTrades)
            : null;

        const positions: Position[] = [];
        let coinmNotionalUsd = 0; // Σ positionUsd for inverse-contract rows (see cryptoValue below)
        for (const trade of openTrades) {
          let currentPrice = trade.entryPrice;
          let pnl: number;
          let pnlPct: number;
          if (acc.profile.broker === "binance_coinm") {
            // Inverse contract: never quantity*price. Same math as
            // BinanceCoinMMomentumAdapter's close-path (display-only here).
            if (this.coinmExecutor?.isConnected()) {
              const mark = await this.coinmExecutor.getMarkPrice(trade.symbol).catch(() => 0);
              if (mark > 0) currentPrice = mark;
            }
            const filters = this.coinmExecutor ? await this.coinmExecutor.getFilters(trade.symbol).catch(() => null) : null;
            pnl = filters ? inversePnlUsdAtExit(trade.side, trade.quantity, filters.contractSize, trade.entryPrice, currentPrice) : 0;
            const notionalAtEntry = filters ? positionUsd(trade.quantity, filters.contractSize) : 0;
            coinmNotionalUsd += notionalAtEntry;
            pnlPct = notionalAtEntry > 0 ? (pnl / notionalAtEntry) * 100 : 0;
          } else {
            if (acc.profile.broker === "binance" || acc.profile.broker === "binance_usdc") {
              const bp = bnPriceMap.get(trade.symbol);
              if (bp && bp > 0) currentPrice = bp;
              // No Alpaca fallback for Binance — price discrepancy causes issues
            } else {
              const latest = alpacaPriceMap?.get(trade.symbol) ?? 0;
              if (latest > 0) currentPrice = latest;
            }
            ({ pnl, pnlPct } = pnlOf(trade.side, trade.entryPrice, currentPrice, trade.quantity));
          }
          const pos: Position = {
            symbol: trade.symbol, market: trade.market, side: trade.side as any,
            quantity: trade.quantity, avgEntryPrice: trade.entryPrice, currentPrice,
            unrealizedPnl: pnl, unrealizedPnlPct: pnlPct, openedAt: trade.entryTime,
            stopLoss: trade.stopLoss || undefined,
            takeProfit: trade.takeProfit || undefined,
            leverage: acc.profile.leverage || 1,
            durationSeconds: Math.floor((Date.now() - trade.entryTime) / 1000),
          };
          positions.push(pos);
          acc.positions.set(trade.symbol, pos);
        }

        const stocksValue = positions.filter(p => p.market === "stock").reduce((s, p) => s + p.quantity * p.currentPrice, 0);
        // COIN-M holds inverse contracts: `quantity` is CONTRACTS (fixed $100
        // notional each), so quantity×price is off by ~contractSize× (prod:
        // 6 BTC contracts read as $410k exposure on a $1k sleeve). Use the
        // Σ positionUsd accumulated above instead.
        const cryptoValue = acc.profile.broker === "binance_coinm"
          ? coinmNotionalUsd
          : positions.filter(p => p.market === "crypto").reduce((s, p) => s + p.quantity * p.currentPrice, 0);
        const { dailyPnl, dailyPnlPct } = acc.equity.getDailyPnlFromStats(stats.todayPnl);

        acc.state = {
          totalEquity: acc.equity.equity, cash: acc.equity.cash,
          stocksValue, cryptoValue, positions,
          dailyPnl, dailyPnlPct,
          totalPnl: acc.equity.totalPnl, totalPnlPct: acc.equity.totalPnlPct,
          openPositions: positions.length, dailyTrades: stats.todayTrades,
          winRate: stats.winRate, timestamp: Date.now(),
        };
      } catch (e: any) { log.error(`State update ${id}: ${e.message}`); }
    }

    // Refresh Alpaca WS stock subscriptions after positions are loaded/updated.
    // Bounded to the IEX 30-symbol cap; held stocks always win. Crypto is
    // always passed through unchanged.
    try { await this.refreshAlpacaWsSubscriptions(); } catch (e: any) {
      log.warn(`Alpaca WS subscription refresh failed: ${e?.message ?? e}`);
    }
  }

  /** Maintain a bounded Alpaca stock WS subscription keyed off in-memory
   *  holdings. Only calls the executor when the bounded symbol set changes. */
  private async refreshAlpacaWsSubscriptions() {
    const held: string[] = [];
    for (const acc of this.accounts.values()) {
      for (const [sym, pos] of acc.positions) {
        if (pos.market === "stock") held.push(sym);
      }
    }

    const universe = [...new Set([...getEnabledStocks(), ...MEANREV_UNIVERSE])];
    const { symbols, droppedHeld } = boundedAlpacaStockSymbols(held, universe);

    if (droppedHeld.length > 0) {
      log.error(
        `Alpaca IEX stock WS limit (${ALPACA_STOCK_WS_MAX}) exceeded by ` +
        `held positions; ${droppedHeld.length} held stocks will not receive live bars: ` +
        droppedHeld.join(", ")
      );
    }

    const key = symbols.join(",");
    if (key === this.lastStockWsSymbolsKey) return;
    this.lastStockWsSymbolsKey = key;

    // Alpaca paper allows ONE market-data WS connection per account. The stock
    // (/v2/iex) and crypto (/v1beta3/crypto/us) endpoints each count against
    // that single limit, so opening both means the crypto socket floods
    // `code=406 connection limit exceeded` forever and neither subscribes.
    // The crypto WS feeds NO money-path (crypto trades run on Binance perps
    // with Binance mark prices — checkAllStopLoss never falls back to
    // Alpaca for crypto), and getLatestPrice keeps its crypto
    // REST fallback. So stream ONLY stocks over WS; drop the redundant crypto
    // socket. ponytail: single-account paper cap; if a paid feed lifts the
    // 1-connection limit, pass getEnabledCrypto() again.
    log.info(`Alpaca stock WS subscribing to ${symbols.length} symbols (${new Set(held).size} held): ${symbols.join(", ")}`);
    await this.executor.alpaca.startRealTimeStream(symbols, []);
  }

  // ── Single writer of equity_snapshots (v8 consolidation) ──
  //
  // The "portfolio sums are wrong" bug class (6 recurrences) partly came from
  // THREE loops writing equity_snapshots: the 60s Alpaca sync wrote alpaca_main
  // + both stock sleeves, the 60s Binance sync wrote binance_main +
  // momentum_crypto, and the 5-min loop wrote all — every sleeve was
  // double-written and could drift between writers.
  //
  // CONTRACT: this method is the ONLY writer of equity_snapshots. The 60s syncs
  // now ONLY update in-memory EquityTracker state (broker truth) and cache the
  // *_main reading on the instance. It is normally driven by the 5-min snapshot
  // loop and startup warm-up, with an immediate fire-and-forget write when
  // refreshBinanceAccountTotal gets the first valid broker-total reading.
  // Sleeve rows come from acc.equity (the freshest ≤60s broker-synced value;
  // the loop runs updateAllStates first); *_main rows come from cached truth.
  //
  // TRADEOFF: *_main now lands at 5-min resolution instead of 60s. ACCEPTABLE —
  // equity_snapshots feed the chart + since-start anchors, not live risk; a
  // 5-min anchor cadence is fine and *_main is skipped only until the first
  // sync populates the cache (≈first 5-min tick after a restart).
  private writeAllSnapshots() {
    // A per-series snapshot write MUST NOT crash the trading bot: equity_snapshots
    // feed the chart + since-start anchors + DD breakers, NOT live position
    // management. An undeclared equity-semantics transition (or any write error)
    // used to throw straight out of here → out of start() → Fatal, killing the
    // whole bot on boot (positions left unmanaged) over a DISPLAY-ledger issue.
    // Now each write is isolated: on failure we log LOUDLY (an operator must
    // declare the transition — KNOWN_TRANSITIONS in db/database.ts) and keep the
    // bot alive. The read path stays fail-closed (getEquityPnlDisplay → null).
    const safeSnap = (id: string, equity: number, cash: number, pos: number) => {
      try {
        saveEquitySnapshot(id, equity, cash, pos);
      } catch (e: any) {
        log.error(`writeAllSnapshots: snapshot skipped for ${id} — ${e.message} (bot keeps trading; declare the transition to restore this series' history)`);
      }
    };
    // Active only: momentum_crypto_usdc/momentum_btc write NOTHING while
    // inactive (flag off, no exposure) — no seed-equity row, no history,
    // no "phantom sleeve" the invariant checker or a chart would have to
    // explain. See isActive/getActiveProfileIds.
    for (const id of this.getActiveProfileIds()) {
      const acc = this.accounts.get(id)!;
      safeSnap(id, acc.equity.equity, acc.equity.cash, acc.positions.size);
    }
    if (this.alpacaMainTruth && isBrokerTruthAvailable("alpaca")) {
      safeSnap("alpaca_main", this.alpacaMainTruth.equity, this.alpacaMainTruth.cash, 0);
    }
    if (this.binanceMainTruth && isBrokerTruthAvailable("binance")) {
      safeSnap("binance_main", this.binanceMainTruth.equity, this.binanceMainTruth.cash, 0);
    }
    if (this.binanceCoinmMainTruth && isBrokerTruthAvailable("coinm")) {
      safeSnap("binance_coinm_main", this.binanceCoinmMainTruth.equity, this.binanceCoinmMainTruth.cash, 0);
    }
    this.logAlpacaAccountGrossExposure();
  }

  // ── Account-level aggregate exposure visibility (2026-08-19 audit fix) ──
  //
  // momentum_stocks and meanrev_stocks SHARE one Alpaca wallet (see AGENTS.md
  // "Shared Alpaca wallet") but nobody previously summed their combined LIVE
  // exposure against the account's real equity — momentum_stocks alone can
  // run at ~2x its OWN $50k allocation (~$103k) and meanrev_stocks owns
  // another ~$25k-50k on top, against a single ~$105k Alpaca account; that
  // sum was never audited anywhere. This logs it every 5min alongside the
  // snapshot write (same cadence, no new loop) — VISIBILITY ONLY, it does
  // NOT block anything. The guards that DO block: per-sleeve
  // MomentumEngine/MeanRevEngine.maxGrossExposureMult, and since 2026-08-20
  // the shared-ACCOUNT pre-submit Reg-T mirror in
  // AlpacaMomentumAdapter.openPosition (getRegTBuyingPower — broker truth,
  // covers both sleeves plus manual/orphan exposure; enforced by
  // AlpacaMomentumAdapter.sharedAccountGuard.test.ts).
  private logAlpacaAccountGrossExposure(): void {
    if (!this.alpacaMainTruth || !isBrokerTruthAvailable("alpaca")) return;
    const accountEquity = this.alpacaMainTruth.equity;
    if (!(accountEquity > 0)) return;
    const stocks = this.accounts.get("momentum_stocks");
    const meanrev = this.accounts.get("meanrev_stocks");
    const combined = (stocks?.state.stocksValue ?? 0) + (meanrev?.state.stocksValue ?? 0);
    const pct = (combined / accountEquity) * 100;
    const msg = `Alpaca account gross exposure: momentum_stocks+meanrev_stocks $${combined.toFixed(0)} of $${accountEquity.toFixed(0)} account equity (${pct.toFixed(1)}%)`;
    if (combined > accountEquity) log.warn(`⚠️ ${msg} — combined sleeve exposure EXCEEDS account equity`);
    else log.info(msg);
  }

  // ── Broker REST reconnection (2026-08-16) ─────────────────────────────
  //
  // Called at the TOP of each executor's own 60s sync (before its
  // isConnected early-return) — the sync loops are the natural place: they
  // already run forever, already beat heartbeats, and a reconnect here
  // makes the very same loop useful again on its next tick. Deliberately
  // NOT a new timer, NOT in the 15s SL loop (60s granularity is plenty for
  // a backoff whose floor is 30s), and NOT in any order path.
  //
  // Contract:
  //  - Never throws (a reconnect failure must never take down a sync loop).
  //  - Backoff 30s → 60s → 2min → 5min cap, ×(1..1.25) jitter; at the cap
  //    it keeps retrying every ~5min forever — cron's health watchdog stays
  //    the last-resort net, this just makes it near-unreachable.
  //  - init() is safe to re-run: both executors re-check their host
  //    allowlists first (paper/live + testnet gates run BEFORE any network
  //    call, so a reconnect can never skip them), and their WS side effects
  //    are guarded (subscribeTradeUpdates wires handlers once;
  //    startUserDataStream tears down the previous stream first).
  //  - After a successful ALPACA reconnect the broker-account swap guard
  //    re-runs (reverifyAlpacaIdentityAfterReconnect): a reconnect that
  //    lands on a DIFFERENT account HALTs exactly like a boot would —
  //    reconnection is never a bypass of rotation detection. Binance
  //    identity is fingerprinted from env keys (instanceManifest.ts), which
  //    a reconnect cannot change, so no re-check is needed there.
  private async maybeReconnectExecutor(
    broker: "alpaca" | "binance" | "binance_usdc" | "binance_coinm",
    exec: ReconnectableExecutor | null | undefined,
    now: number = Date.now(),
  ): Promise<void> {
    try {
      if (!exec || typeof exec.init !== "function" || typeof exec.isConnected !== "function") return;
      if (exec.isConnected()) {
        this.reconnectStates.delete(broker);
        return;
      }
      let st = this.reconnectStates.get(broker);
      if (!st) {
        // First tick that SEES this executor down: attempt immediately —
        // the 60s sync cadence itself is the initial spacing.
        st = { delayMs: RECONNECT_BASE_DELAY_MS, nextAttemptAt: now, attempts: 0, inFlight: false };
        this.reconnectStates.set(broker, st);
      }
      if (st.inFlight || now < st.nextAttemptAt) return;
      st.inFlight = true;
      st.attempts++;
      log.warn(`🔌 ${broker} REST disconnected — reconnect attempt #${st.attempts}`);
      let ok = false;
      try {
        ok = (await exec.init()) === true;
      } catch (e: any) {
        log.error(`${broker} reconnect attempt #${st.attempts} threw: ${e?.message ?? e}`);
      }
      st.inFlight = false;
      if (ok) {
        log.info(`✅ ${broker} RECONNECTED after ${st.attempts} attempt(s) — syncs/stop-loss resume on their next tick`);
        try { insertActivity(null, "system", `${broker} broker connection RECOVERED after ${st.attempts} attempt(s)`); } catch {}
        this.reconnectStates.delete(broker);
        if (broker === "alpaca") await this.reverifyAlpacaIdentityAfterReconnect();
        return;
      }
      const atCap = st.delayMs >= RECONNECT_MAX_DELAY_MS;
      st.nextAttemptAt = now + Math.round(st.delayMs * (1 + Math.random() * RECONNECT_JITTER_FRAC));
      st.delayMs = Math.min(st.delayMs * 2, RECONNECT_MAX_DELAY_MS);
      log.warn(`${broker} reconnect attempt #${st.attempts} failed — next in ~${Math.round((st.nextAttemptAt - now) / 1000)}s${atCap ? " (backoff at 5min cap; retrying indefinitely — cron watchdog remains the last resort)" : ""}`);
    } catch (e: any) {
      log.error(`maybeReconnectExecutor(${broker}) failed: ${e?.message ?? e}`);
    }
  }

  /** Re-run the broker-account swap guard after an Alpaca REST reconnect —
   *  the SAME publishInstanceManifest call index.ts makes at boot (same
   *  fingerprinting, same HALT-on-changed semantics, same first_boot/ack
   *  handling; src/ops/instanceManifest.ts). Startup semantics on a
   *  mismatch: the executor STAYS connected (closes/stops/reconciliation
   *  keep running) while RiskEngine persists HALTED, blocking new opens,
   *  until a human acks the rotation. Non-fatal by the same doctrine as the
   *  boot call site. Instance method so tests can stub/observe it. */
  private async reverifyAlpacaIdentityAfterReconnect(): Promise<void> {
    try {
      await publishInstanceManifest({
        getAlpacaAccountId: async () => {
          const acct = await this.executor.alpaca.getAccount();
          return acct?.account_number ?? acct?.id ?? null;
        },
      });
    } catch (e: any) {
      log.error(`post-reconnect identity re-check failed (non-fatal): ${e?.message ?? e}`);
    }
  }

  // ── Broker sync (broker = truth) ──────────

  private async syncBinanceFutures() {
    await this.maybeReconnectExecutor("binance", this.executor.binance);
    if (!this.executor.binance.isConnected()) {
      this.binanceMainTruth = null;
      setBrokerTruthAvailable("binance", false);
      heartbeats.beatFailed("sync_binance"); // pass completed; broker unreachable — alive, not dead
      return;
    }
    if (this.syncingBinance) return; // reentrancy guard
    this.syncingBinance = true;
    try {
      const acc = this.accounts.get("momentum_crypto")!;

      // 1. Margin balance → the ONLY broker call this loop awaits before
      // moving straight to positions. getBalance is a single fast
      // /fapi/v2/account read with NO assetIndex fan-out (reviewer P1,
      // 2026-07-18): the OLD code also awaited a per-asset assetIndex
      // valuation here, so a slow/rate-limited asset-index call stalled
      // margin sync + position reconciliation for every crypto trade. The
      // account TOTAL (binance_main, needs assetIndex) is refreshed
      // separately, fire-and-forget, below — it never blocks this loop.
      const bal = await this.executor.binance.getBalance();
      acc.equity.syncBrokerTruth(bal.marginEquity, bal.marginCash); // in-memory only (no snapshot write)
      eventBus.emit("equity_update", {
        source: "binance_sync",
        marginEquity: bal.marginEquity,
        marginCash: bal.marginCash,
        wallet: bal.wallet,
        available: bal.marginCash,
        unrealizedPnl: bal.unrealizedPnl,
      });
      log.info(`📡 Binance margin sync: margin=$${bal.marginEquity.toFixed(2)}, wallet=$${bal.wallet.toFixed(2)}, available=$${bal.marginCash.toFixed(2)}, unrealizedPnL=$${bal.unrealizedPnl.toFixed(2)}`);

      // Fire-and-forget: binance_main's account total has its own reentrancy
      // guard + internal try/catch (never an unhandled rejection) and must
      // not delay margin sync or position reconciliation below.
      void this.refreshBinanceAccountTotal().catch((e: any) => log.error(`Binance account-total refresh crashed: ${e?.message ?? e}`));

      // 2. DB ↔ broker position reconciliation — the shared parameterized
      // algorithm (BinanceSleeveReconciler.ts): close rows the broker no
      // longer holds (fill attribution + unreconciled grace) and adopt
      // untracked broker positions behind a VERIFIED native stop (or
      // emergency-close them). USDT_SLEEVE_SPEC carries this sleeve's real
      // semantics: abort-pass settlement failures, all-non-shadow orphan
      // blockers, unrealized refresh on match, circuit-activity escalation.
      await reconcileLinearBinanceSleeve(
        { exec: this.executor.binance, acc, grace: this.usdtGrace },
        USDT_SLEEVE_SPEC,
      );

      this.lastSyncAt = Date.now();
      heartbeats.beat("sync_binance"); // completed a Binance sync
    } catch (e: any) {
      log.warn(`Binance sync failed: ${e.message}`);
      heartbeats.beatFailed("sync_binance"); // handled failure = alive; silence would read as a dead loop
    } finally {
      this.syncingBinance = false;
    }
  }

  /**
   * binance_main's account total, refreshed OUT-OF-BAND from syncBinanceFutures
   * (reviewer P1, 2026-07-18): this is the only path that hits Binance's
   * per-asset assetIndex, so it gets its own reentrancy guard and is never
   * awaited by the margin sync above. Caches null on any failure/incomplete
   * read — never a stale or partial binance_main total (mirrors getAccountTotal's
   * own fail-closed contract).
   */
  private async refreshBinanceAccountTotal(): Promise<void> {
    if (this.refreshingBinanceTotal) return; // a previous refresh is still in flight
    this.refreshingBinanceTotal = true;
    try {
      const total = await this.executor.binance.getAccountTotal();
      const wasNull = this.binanceMainTruth === null;
      if (total && Number.isFinite(total.equity) && Number.isFinite(total.cash)) {
        this.binanceMainTruth = { equity: total.equity, cash: total.cash };
        setBrokerTruthAvailable("binance", true);
        log.info(`📡 Binance account-total refresh: equity=$${total.equity.toFixed(2)}, cash=$${total.cash.toFixed(2)}`);
        // First valid reading after a null cache (e.g. right after a restart):
        // don't make the dashboard's binance_main row wait up to 5min for the
        // next snapshot loop tick — write it once, immediately.
        if (wasNull && this.running) this.writeAllSnapshots();
      } else {
        this.binanceMainTruth = null;
        setBrokerTruthAvailable("binance", false);
        log.warn("📡 Binance account-total refresh: unavailable (assetIndex incomplete or errored)");
      }
    } catch (e: any) {
      this.binanceMainTruth = null;
      setBrokerTruthAvailable("binance", false);
      log.error(`Binance account-total refresh failed: ${e?.message ?? e}`);
    } finally {
      this.refreshingBinanceTotal = false;
    }
  }

  /** momentum_crypto_usdc reconciliation, scoped to the isolated USDC wallet. */
  private async syncBinanceUsdc() {
    await this.maybeReconnectExecutor("binance_usdc", this.usdcExecutor);
    if (!this.usdcExecutor?.isConnected()) { heartbeats.beatFailed("sync_binance_usdc"); return; }
    if (this.syncingUsdc) return;
    this.syncingUsdc = true;
    try {
      const acc = this.accounts.get("momentum_crypto_usdc")!;
      const bal = await this.usdcExecutor.getBalance();
      acc.equity.syncBrokerTruth(bal.marginEquity, bal.marginCash);

      // getPositions() is already scoped to this instance's own symbolMap
      // (ownNative filter, src/executor/binance-executor.ts) — it cannot
      // return a USDT or COIN-M position even if the raw API did. BrokerSync
      // never sees these positions at all (product-owned; its USDT source is
      // quote-scoped). USDC_SLEEVE_SPEC carries this sleeve's real semantics:
      // per-trade settlement fallback, sleeve-scoped orphan blockers,
      // algo-order stop attribution — and the shared reconciler carries the
      // once-divergent stop-verification tolerances (the historical
      // qty-tolerance-reused-as-price-tolerance bug lived HERE; see
      // verifyProtectiveStop in BinanceSleeveReconciler.ts).
      await reconcileLinearBinanceSleeve(
        { exec: this.usdcExecutor, acc, grace: this.usdcGrace },
        USDC_SLEEVE_SPEC,
      );

      heartbeats.beat("sync_binance_usdc");
    } catch (e: any) {
      log.warn(`Binance USDC sync failed: ${e.message}`);
      heartbeats.beatFailed("sync_binance_usdc");
    } finally {
      this.syncingUsdc = false;
    }
  }

  /**
   * momentum_btc reconciliation (2026-07-19) — DAPI COIN-M wallet, inverse
   * contract. Same ABNORMAL-case-only scope as syncBinanceUsdc (see its
   * docstring); closes go through closeTradeExplicit (inverse pnl/pnl_pct,
   * never closeTrade's linear formula).
   */
  private async syncBinanceCoinM() {
    await this.maybeReconnectExecutor("binance_coinm", this.coinmExecutor);
    if (!this.coinmExecutor?.isConnected()) {
      this.binanceCoinmMainTruth = null;
      setBrokerTruthAvailable("coinm", false);
      heartbeats.beatFailed("sync_binance_coinm");
      return;
    }
    if (this.syncingCoinm) return;
    this.syncingCoinm = true;
    try {
      const acc = this.accounts.get("momentum_btc")!;
      const equity = await this.coinmExecutor.getEquityUsd();
      // Inverse wallet has no separate "free margin" figure surfaced by this
      // executor yet — mirrors momentum_crypto's marginCash-as-cash
      // convention with equity itself (conservative: never overstates cash).
      acc.equity.syncBrokerTruth(equity, equity);
      // binance_coinm_main (read-only broker-truth, mandate 2026-07-19):
      // momentum_btc is the SOLE owner of the DAPI wallet, so its own
      // marginBalance×mark reading IS the whole ledger — same value, cached
      // under the *_main key so portfolio/truth.ts can sum it into the
      // consolidated total without a second network call.
      this.binanceCoinmMainTruth = { equity, cash: equity };
      setBrokerTruthAvailable("coinm", true);

      // truth-only (flag off, no DB exposure — mandate 2026-07-19): equity
      // read done, DAPI truth cached above. Stop here — DO NOT run the
      // DB-vs-broker reconciliation below. momentum_btc is inactive (no
      // engine, no DB rows) precisely because it was never enabled, so ANY
      // real broker position (e.g. the account's own long-standing BTC
      // holding) would look like an "orphan with no DB trade" and get
      // emergency-closed by the branch at the bottom of this function — the
      // exact opposite of "read-only". Reconciliation only runs once the
      // sleeve is genuinely live/close-only (attachCoinmExecutor).
      if (this.sleeveMode.get("momentum_btc") === "truth-only") {
        heartbeats.beat("sync_binance_coinm");
        return;
      }

      // Inverse-contract reconciliation — shared skeleton, COIN-M semantics
      // (ledger settlement, executor-side ensureLiveStop, orphan = emergency
      // close, never adoption). See reconcileCoinmSleeve's docstring for why
      // the inverse path is a hook rather than a LinearSleeveSpec.
      await reconcileCoinmSleeve({ exec: this.coinmExecutor, acc, grace: this.coinmGrace });

      heartbeats.beat("sync_binance_coinm");
    } catch (e: any) {
      log.warn(`Binance COIN-M sync failed: ${e.message}`);
      heartbeats.beatFailed("sync_binance_coinm");
    } finally {
      this.syncingCoinm = false;
    }
  }

  private async syncAlpacaAccount() {
    await this.maybeReconnectExecutor("alpaca", this.executor.alpaca);
    if (!this.executor.alpaca.isConnected()) {
      this.alpacaMainTruth = null;
      setBrokerTruthAvailable("alpaca", false);
      heartbeats.beatFailed("sync_alpaca"); // pass completed; broker unreachable — alive, not dead
      return;
    }
    if (this.syncingAlpaca) return; // reentrancy guard
    this.syncingAlpaca = true;
    try {
      const acct = await this.executor.alpaca.getAccount();
      if (!acct) {
        this.alpacaMainTruth = null;
        setBrokerTruthAvailable("alpaca", false);
        heartbeats.beatFailed("sync_alpaca");
        return;
      }
      const totalEquity = parseFloat(acct.equity);
      const alpacaCash = parseFloat(acct.cash);
      if (!Number.isFinite(totalEquity) || totalEquity <= 0 || !Number.isFinite(alpacaCash)) {
        this.alpacaMainTruth = null;
        setBrokerTruthAvailable("alpaca", false);
        heartbeats.beatFailed("sync_alpaca");
        return;
      }

      // The whole Alpaca wallet is SHARED by momentum_stocks + meanrev_stocks:
      // only alpaca_main carries broker truth; each sleeve gets a LEDGER
      // (initial allocation + realized + unrealized of its own trades) so the
      // consolidated view never counts the wallet 1.5×.
      // v8 single-writer: cache broker truth; writeAllSnapshots (5-min loop) is
      // the ONLY writer of the alpaca_main + sleeve snapshots.
      this.alpacaMainTruth = { equity: totalEquity, cash: alpacaCash };
      setBrokerTruthAvailable("alpaca", true);

      let sleevePnlSum = 0;
      const corruptLedgers: string[] = [];
      for (const id of ["momentum_stocks", "meanrev_stocks"] as const) {
        const acc = this.accounts.get(id)!;
        const open = getOpenTrades(id);
        // Cache-first with REST fallback for cold-cache symbols (same
        // resolver AlpacaMomentumAdapter.getEquity uses — see EquityTracker.ts)
        // — a cache-only read here was silently pinning the snapshot to
        // cost basis whenever the WS price cache went cold.
        const prices = await buildSleevePriceMap(this.executor.alpaca, open);
        const ledger = computeSleeveLedger(
          acc.equity.initialEquity,
          getTradingStats(id).totalPnl,
          open,
          s => prices.get(s) ?? 0,
        );
        acc.equity.syncLedger(ledger.equity, ledger.cash); // in-memory only (no snapshot write)
        // computeSleeveLedger returns {equity: NaN, ...} as its invalidity
        // marker (corrupt open trade / non-finite price — by design, so
        // consumers fail closed). Summing that NaN here made the drift guard
        // below compare Math.abs(NaN) > 500 === false — i.e. the drift alarm
        // went SILENT exactly while the data was corrupt. Track it instead.
        if (Number.isFinite(ledger.equity)) {
          sleevePnlSum += ledger.equity - acc.equity.initialEquity;
        } else {
          corruptLedgers.push(id);
        }
      }

      // Alpaca stock-sleeve orphan adoption. BrokerSync deliberately skips
      // EVERY sleeve-universe symbol as "sleeve-owned, adopted by its own 60s
      // sync" (BrokerSync's sleeveOwnsSymbol adoption skip) — but that
      // contract was only half-implemented here: the XLP incident
      // (2026-07-25: 58sh on Alpaca, zero DB rows) got adoption for
      // meanrev_stocks only, so a MOMENTUM_STOCKS_UNIVERSE orphan was adopted
      // by NOBODY — skipped by BrokerSync (sleeve-owned) and by this sync
      // (meanrev-only filter) — and, with checkAllStopLoss and
      // ensureAlpacaNativeStops both iterating getOpenTrades only, sat with
      // NO 15s stop and NO native GTC stop forever. ONE parameterized pass
      // (same idiom as syncBinanceFutures's §2b broker-not-in-DB recovery)
      // now covers both sleeves. The disjoint universes
      // (riskProfiles.disjoint.test.ts) mean each symbol maps to exactly ONE
      // owner, so the row is filed under that owner and never under both.
      //
      // Adoption is UNCONDITIONAL (2026-07-30): it used to sit behind an env
      // kill-switch (default OFF) because the Alpaca
      // account was traded by TWO deployments of this bot sharing one API key
      // (see AUDITS.md for the full forensic history) — adopting an "orphan"
      // then meant capturing the OTHER deployment's position. The second
      // deployment was decommissioned; this bot is now the SOLE deployment
      // trading the account, so an orphan is always ours to recover.
      try {
        const openBySleeve = new Map<(typeof ALPACA_STOCK_SLEEVES)[number], Set<string>>(
          ALPACA_STOCK_SLEEVES.map(id => [id, new Set(getOpenTrades(id).map(t => t.symbol))]),
        );
        // Disjoint by construction (riskProfiles.disjoint.test.ts): first
        // match IS the only match. Neither universe → BrokerSync's to adopt
        // under *_main (legacy/manual position no engine will ever claim).
        const ownerOf = (symbol: string): (typeof ALPACA_STOCK_SLEEVES)[number] | null =>
          MEANREV_UNIVERSE.includes(symbol) ? "meanrev_stocks"
            : MOMENTUM_STOCKS_UNIVERSE.includes(symbol) ? "momentum_stocks"
            : null;
        const seenThisPass = new Set<string>();
        const adopted = new Map<(typeof ALPACA_STOCK_SLEEVES)[number], string[]>();
        for (const bp of await this.executor.alpaca.getPositions()) {
          if (bp.quantity <= 0) continue;
          const owner = ownerOf(bp.symbol);
          if (owner == null) continue; // no sleeve's universe — BrokerSync owns adoption
          if (openBySleeve.get(owner)!.has(bp.symbol)) continue; // already tracked by its owner
          seenThisPass.add(bp.symbol);
          const cycles = (this.alpacaOrphanCycles.get(bp.symbol) ?? 0) + 1;
          this.alpacaOrphanCycles.set(bp.symbol, cycles);
          if (cycles < ALPACA_ADOPTION_GRACE_CYCLES) {
            log.debug(`📡 Sync: ${bp.symbol} orphaned on Alpaca but not in DB [${owner}] — grace ${cycles}/${ALPACA_ADOPTION_GRACE_CYCLES}`);
            continue;
          }
          if (!Number.isFinite(bp.avgEntryPrice) || bp.avgEntryPrice <= 0) {
            log.error(`📡 Sync: ${bp.symbol} orphaned on Alpaca [${owner}] but avg_entry_price is non-finite/non-positive (${bp.avgEntryPrice}) — refusing to fabricate a basis, NOT adopting`);
            continue;
          }
          const now = Date.now();
          insertTrade({
            id: uuid(),
            symbol: bp.symbol,
            market: "stock",
            side: bp.side,
            strategy: "SYNC_RECOVERY",
            entryPrice: bp.avgEntryPrice,
            quantity: bp.quantity,
            entryTime: now,
            status: "open",
          } as any, owner);
          this.accounts.get(owner)!.positions.set(bp.symbol, {
            symbol: bp.symbol,
            market: "stock",
            side: bp.side as any,
            quantity: bp.quantity,
            avgEntryPrice: bp.avgEntryPrice,
            currentPrice: bp.currentPrice > 0 ? bp.currentPrice : bp.avgEntryPrice,
            unrealizedPnl: bp.unrealizedPnl,
            unrealizedPnlPct: bp.unrealizedPnlPct,
            openedAt: now,
          });
          this.alpacaOrphanCycles.delete(bp.symbol);
          if (!adopted.has(owner)) adopted.set(owner, []);
          adopted.get(owner)!.push(bp.symbol);
          log.warn(`📡 Sync: ${bp.symbol} exists on Alpaca but not in DB [${owner}] — recovered ${bp.quantity} @ $${bp.avgEntryPrice.toFixed(2)}`);
          insertActivity(owner, "sync", `Recovered ${bp.symbol} from Alpaca: ${bp.side} ${bp.quantity} @ $${bp.avgEntryPrice.toFixed(2)} — orphan, no prior DB row`);
        }
        // Clear grace counters for symbols that resolved (adopted or gone).
        for (const sym of [...this.alpacaOrphanCycles.keys()]) {
          if (!seenThisPass.has(sym)) this.alpacaOrphanCycles.delete(sym);
        }
        // An orphan is always evidence of an upstream bug (lost insert, dead
        // sync) — must not be silent. ONE aggregated page per sleeve per
        // pass, same idiom as the stuck-close/stale-price alerts above (not
        // one page per symbol, a prior audit round flagged that as a page
        // flood).
        for (const [owner, symbols] of adopted) {
          const msg = `${owner} adopted ${symbols.length} orphaned Alpaca position(s) with no DB row: ${symbols.join(", ")}`;
          eventBus.emit(EVENTS.ERROR_BURST, {
            context: "AccountManager.orphanAdopt",
            message: msg,
            count: symbols.length,
            windowMs: 60_000,
            firstAt: Date.now() - 60_000,
            lastAt: Date.now(),
          });
        }
      } catch (e: any) {
        log.warn(`Alpaca orphan-adoption check failed: ${e.message}`);
      }

      // Broker-native GTC stops — defense in depth (OPEN.md P1: stocks were
      // naked outside market hours). Runs every 60s AND at startup (start()
      // awaits this sync), so a position opened by an adapter is armed within
      // one cycle and a restart re-verifies every stop. Failure here must
      // never break the sync: the 15s SL loop remains the primary protection.
      try {
        await this.ensureAlpacaNativeStops();
      } catch (e: any) {
        log.warn(`Alpaca native-stop reconcile failed: ${e.message}`);
      }

      // Drift guard: compare DELTAS, not absolutes — the broker account carries
      // pre-v8 legacy P&L history the sleeve ledgers deliberately don't.
      // (brokerEquity − brokerEquityAtV8Start) should ≈ Σ(sleeve pnl).
      // A corrupt (NaN-marked) sleeve ledger must produce MORE alarm, not
      // less: skip the comparison explicitly (it can't be computed) and page
      // — one aggregated ERROR_BURST behind a cooldown, same idiom as the
      // stale-price/stuck-close alerts in checkAllStopLoss.
      if (corruptLedgers.length > 0) {
        const msg = `sleeve ledger invalid (NaN) for ${corruptLedgers.join(", ")} — drift guard cannot run, corrupt open-trade data`;
        log.error(`⚖️ ${msg}`);
        if (Date.now() - this.lastLedgerCorruptAlertAt >= LEDGER_CORRUPT_ALERT_COOLDOWN_MS) {
          const windowMs = this.lastLedgerCorruptAlertAt > 0 ? Date.now() - this.lastLedgerCorruptAlertAt : LEDGER_CORRUPT_ALERT_COOLDOWN_MS;
          this.lastLedgerCorruptAlertAt = Date.now();
          eventBus.emit(EVENTS.ERROR_BURST, {
            context: "AccountManager",
            message: msg,
            count: corruptLedgers.length,
            windowMs,
            firstAt: Date.now() - windowMs,
            lastAt: Date.now(),
          });
        }
      } else {
        const v8Start = this.getAlpacaV8StartEquity();
        if (v8Start != null) {
          const brokerDelta = totalEquity - v8Start;
          const gap = brokerDelta - sleevePnlSum;
          // debug, not warn: under two-deployment co-tenancy this gap is
          // prod's trading — EXPECTED, permanent, and it moves every time
          // prod fills an order, so a threshold warn here fired every 60s
          // forever while the daily reconcilePortfolioInvariants (which has
          // a real tolerance and pages on violation) said OK. That invariant
          // check is the single arbiter of "is the accounting broken"; this
          // line is telemetry for reading a specific incident, not an alarm.
          if (Math.abs(gap) > 500) {
            log.debug(`⚖️ Alpaca ledger drift: broker Δ$${brokerDelta.toFixed(2)} since v8 start vs sleeve pnl $${sleevePnlSum.toFixed(2)} (gap $${gap.toFixed(2)})`);
          }
        }
      }

      this.lastSyncAt = Date.now();
      heartbeats.beat("sync_alpaca"); // completed an Alpaca sync
      log.info(`📡 Alpaca sync: equity=$${totalEquity.toFixed(2)}, cash=$${alpacaCash.toFixed(2)}`);
    } catch (e: any) {
      this.alpacaMainTruth = null;
      setBrokerTruthAvailable("alpaca", false);
      log.warn(`Alpaca sync failed: ${e.message}`);
      // 2026-09-23 07:32–07:55 + 2026-09-25 DNS cuts: every pass of this
      // loop failed HERE (bounded getAccount timeout) and returned — the
      // loop was alive the whole time, but only success ever beat, so
      // >5min of broker outage paged "possible dead loop", flipped
      // /healthz to 503 and got the watchdog to restart a healthy process.
      heartbeats.beatFailed("sync_alpaca");
    } finally {
      this.syncingAlpaca = false;
    }
  }

  // ── Alpaca broker-native GTC stops (defense in depth, OPEN.md P1) ────────
  //
  // checkAllStopLoss (15s) remains the PRIMARY Alpaca protection — it reacts
  // faster in-session and covers what the broker won't (e.g. a stop order
  // rejected/expired). This layer replicates the Binance sleeves' native
  // STOP_MARKET pattern for the shared Alpaca wallet: every open stock row
  // carries a broker-side GTC `stop` order at profile.stopLossPct anchored to
  // ENTRY — the SAME trigger the 15s loop derives, so the two layers agree on
  // where the line is. GTC is what makes it matter: an overnight/weekend gap
  // (~70% of calendar time, holds p90 263h) is capped at the next open
  // instead of running unbounded until the loop can trade again.

  /** Reentrancy: TWO independent invokers exist — syncAlpacaAccount (behind
   *  the syncingAlpaca guard) and applyCorporateAction (CorporateActionsMonitor,
   *  NOT behind that guard). Two interleaved passes each read openStops ONCE
   *  and then await per-row: pass B's read can land in pass A's await hole and
   *  miss the stop A just placed; with the deterministic client_order_id
   *  burned (state `canceled` — exactly the reverse-split case the monitor
   *  forces), placeStopLossOrder falls back to a SALTED id, so broker-side
   *  duplicate-id idempotency does not apply — both place → two live stops →
   *  2× qty sold on trigger → accidental short. SERIALIZE (wait) instead of
   *  skip: the corporate-action caller's whole point is re-verifying NOW with
   *  the just-adjusted row basis, and a skip would leave a stale-basis stop
   *  live for up to 60s; the queued pass re-reads openStops fresh, sees its
   *  predecessor's verified stop, and no-ops (a serialized pass is idempotent
   *  — locked by the concurrency test in alpacaNativeStops.test.ts). */
  private nativeStopsPass: Promise<void> = Promise.resolve();
  private ensureAlpacaNativeStops(): Promise<void> {
    const run = this.nativeStopsPass
      .catch(() => {}) // a failed predecessor must not poison the queue (its OWN caller already handled the error)
      .then(() => this.runAlpacaNativeStopsPass());
    this.nativeStopsPass = run;
    return run;
  }

  /** ORDER_FILLED → debounced native-stop pass (see ALPACA_STOP_ON_FILL).
   *  Filter — Alpaca stock-sleeve ENTRIES only, everything else is a no-op:
   *   - ORDER_FILLED is emitted EXCLUSIVELY by the adapters' openPosition
   *     paths (closes emit POSITION_CLOSED), so every event here is an entry;
   *   - the Binance adapters stamp market:"crypto" and install their native
   *     STOP_MARKET inline BEFORE persisting — nothing for this pass to do;
   *   - ShadowAdapter emits no ORDER_FILLED at all (locked by the
   *     source-scan test in alpacaNativeStops.test.ts).
   *  Runs inside the ORDER_FILLED listener, so it must never throw — the
   *  scheduled pass's own failure is caught and logged (the 60s timer pass
   *  remains the backstop). Latency telemetry: fill→stop wall time logged on
   *  pass completion. */
  private scheduleStopOnFillPass(o: any): void {
    try {
      if (!ALPACA_STOP_ON_FILL) return;
      if (o?.market !== "stock") return;
      if (!(ALPACA_STOCK_SLEEVES as readonly string[]).includes(o?.accountId)) return;
      if (this.stopOnFillFirstFillAt === 0) this.stopOnFillFirstFillAt = Date.now();
      this.stopOnFillCount++;
      // Debounce: later fills join the already-pending pass — the pass
      // re-reads getOpenTrades at start, so every row persisted before the
      // fuse burns is covered by the SAME pass.
      if (this.stopOnFillTimer) return;
      this.stopOnFillTimer = setTimeout(() => {
        this.stopOnFillTimer = null;
        const firstFillAt = this.stopOnFillFirstFillAt;
        const fills = this.stopOnFillCount;
        this.stopOnFillFirstFillAt = 0;
        this.stopOnFillCount = 0;
        this.ensureAlpacaNativeStops()
          .then(() => log.info(`🛡 stop-on-fill: native-stop pass completed ${Date.now() - firstFillAt}ms after the first of ${fills} entry fill(s)`))
          .catch((e: any) => log.warn(`stop-on-fill native-stop pass failed: ${e?.message ?? e} — the 60s reconcile remains the backstop`));
      }, this.stopOnFillDebounceMs);
    } catch (e: any) {
      try { log.warn(`scheduleStopOnFillPass failed: ${e?.message ?? e}`); } catch {}
    }
  }

  /** Reconcile native stops for every open Alpaca stock row: place where
   *  missing, replace where drifted, and attribute a FIRED stop back to its
   *  row (BROKER_STOP_LOSS with the real fill, not a fabricated pnl=0).
   *  Unknown ≠ none: if the broker reads fail, the pass skips (never
   *  double-places blindly) and retries next cycle. NEVER call directly —
   *  only through ensureAlpacaNativeStops (the serialization above). */
  private async runAlpacaNativeStopsPass(): Promise<void> {
    const rows: { acc: AccountInstance; trade: any }[] = [];
    for (const id of ALPACA_STOCK_SLEEVES) {
      const acc = this.accounts.get(id)!;
      for (const trade of getOpenTrades(id)) {
        if (trade.market !== "stock") continue; // equities only: Alpaca has no plain GTC stop for crypto, and crypto sleeves are Binance's anyway
        // Treasury ETF (BOXX/SGOV/BIL): the sweep keeps no trades row, so this is
        // pure defense in depth — a manually inserted/legacy row must never
        // arm a GTC stop on the cash-parking position (a fired stop would
        // dump the whole park into a spread spike). TreasurySweep.test.ts.
        if (isTreasurySymbol(trade.symbol)) continue;
        rows.push({ acc, trade });
      }
    }
    // NO early return on rows.length === 0 (OPEN.md P1, 2026-08-11): this
    // pass used to iterate DB rows only, so a stop whose row was already
    // closed was invisible BY CONSTRUCTION — the ABBV orphan rested a full
    // day. The sweep below reads the broker's stop book directly and must
    // run even (especially) when we think we hold nothing.

    // Broker truth for BOTH halves of the pass. Either read failing throws →
    // the whole pass aborts (caller logs, next cycle retries) — fail closed:
    // "unknown" is never "no position", so an unenumerable book cancels
    // NOTHING and places nothing blindly.
    const positions = await this.executor.alpaca.getPositions();
    const brokerQtyBySymbol = new Map<string, number>();
    const heldSymbols = new Set<string>();
    for (const p of positions) {
      if (p.quantity > 0) heldSymbols.add(p.symbol);
      if (p.market === "stock") brokerQtyBySymbol.set(p.symbol, p.quantity);
    }
    const openStops = await this.executor.alpaca.getOpenStopOrders();

    const openIncidentKeys = new Set(rows.map(({ acc, trade }) => `${acc.id}:${trade.symbol}`));
    for (const { acc, trade } of rows) {
      try {
        await this.ensureNativeStopForRow(
          acc,
          trade,
          brokerQtyBySymbol.get(trade.symbol) ?? 0,
          openStops.filter(o => o.symbol === trade.symbol),
        );
      } catch (e: any) {
        // Per-row isolation: one bad row must not leave every OTHER position
        // without its stop. The 15s loop still protects this one.
        log.error(`[${acc.id}] native stop reconcile failed for ${trade.symbol}: ${e?.message ?? e} — 15s SL loop remains the protection`);
      }
    }

    await this.sweepOrphanedAlpacaStops(openStops, heldSymbols);

    // A row closed by ANY path (engine rebalance, BrokerSync, 404 reconcile)
    // is no longer this pass's concern — prune its incident silently (no
    // "resolved" page: the position is gone, not protected-again).
    for (const key of [...this.nativeStopIncidents.keys()]) {
      if (!openIncidentKeys.has(key)) this.nativeStopIncidents.delete(key);
    }
  }

  /** Orphan-stop sweep (OPEN.md P1, 2026-08-11): cancel OUR resting GTC
   *  stops whose symbol has NO position left at the broker. A sell stop with
   *  no long behind it protects nothing — it OPENS a naked short if it fires,
   *  and while it rests Alpaca's wash-trade protection 403s every new buy of
   *  the symbol, silently costing the sleeve the symbol.
   *  Contract:
   *   - targeted cancel by EXACT order id, NEVER a blanket sweep (the blind
   *     cancel-all class already caused an incident — see AUDITS.md);
   *   - uc8-owned only, re-verified HERE (defense in depth over the
   *     getOpenStopOrders filter) — a foreign/manual order is never touched;
   *   - fail closed: both broker reads happen in the caller and THROW on
   *     failure, so this sweep only ever sees a successfully enumerated
   *     book ("unknown" is never "no position");
   *   - ALPACA_ORPHAN_STOP_GRACE_CYCLES consecutive passes before canceling
   *     (inverse race: a live position transiently missing from enumeration
   *     must not cost its protection);
   *   - every cancel is audited (log + activity, attributed to the owning
   *     sleeve parsed from the client_order_id). */
  private async sweepOrphanedAlpacaStops(openStops: AlpacaStopOrder[], heldSymbols: Set<string>): Promise<void> {
    const seenOrphans = new Set<string>();
    for (const stop of openStops) {
      // OURS only — never trust the upstream filter alone for a cancel.
      if (!stop.clientOrderId.startsWith(`${CLIENT_ORDER_ID_PREFIX}-`)) continue;
      if (heldSymbols.has(stop.symbol)) continue; // position alive → its stop is legitimate protection
      seenOrphans.add(stop.id);
      const cycles = (this.alpacaOrphanStopCycles.get(stop.id) ?? 0) + 1;
      this.alpacaOrphanStopCycles.set(stop.id, cycles);
      const firstSeen = this.alpacaOrphanStopFirstSeen.get(stop.id) ?? Date.now();
      this.alpacaOrphanStopFirstSeen.set(stop.id, firstSeen);
      const orphanForMs = Date.now() - firstSeen;
      if (cycles < ALPACA_ORPHAN_STOP_GRACE_CYCLES || orphanForMs < this.orphanStopGraceMinMs) {
        log.debug(`🧹 stop ${stop.id} (${stop.clientOrderId}) on ${stop.symbol} has no broker position behind it — grace ${cycles}/${ALPACA_ORPHAN_STOP_GRACE_CYCLES} passes, ${Math.round(orphanForMs / 1000)}s/${Math.round(this.orphanStopGraceMinMs / 1000)}s before cancel`);
        continue;
      }
      if (!(await this.executor.alpaca.cancelOrderById(stop.id))) {
        log.warn(`🧹 orphaned stop ${stop.id} on ${stop.symbol}: cancel failed — retrying next pass`);
        continue; // counter survives (still seen) → retried immediately next cycle
      }
      this.alpacaOrphanStopCycles.delete(stop.id);
      this.alpacaOrphanStopFirstSeen.delete(stop.id);
      const owner = ALPACA_STOCK_SLEEVES.find(id => stop.clientOrderId.startsWith(`${CLIENT_ORDER_ID_PREFIX}-${id}-`)) ?? "alpaca_main";
      const msg = `Canceled ORPHANED GTC stop on ${stop.symbol} (order ${stop.id}, ${stop.clientOrderId}, ${stop.side} ${stop.qty} @ trigger $${stop.stopPrice.toFixed(2)}): no broker position behind it for ${cycles} consecutive passes — a fired sell stop would have opened a naked short, and its resting presence wash-trade-blocked every new buy`;
      log.warn(`[${owner}] 🧹 ${msg}`);
      insertActivity(owner, "system", msg);
    }
    // Prune counters whose stop is no longer orphaned (position back, or the
    // stop is gone: canceled/filled/replaced) — a symbol that re-orphans
    // later must restart its grace from zero.
    for (const id of [...this.alpacaOrphanStopCycles.keys()]) {
      if (!seenOrphans.has(id)) this.alpacaOrphanStopCycles.delete(id);
    }
    for (const id of [...this.alpacaOrphanStopFirstSeen.keys()]) {
      if (!seenOrphans.has(id)) this.alpacaOrphanStopFirstSeen.delete(id);
    }
  }

  /** First occurrence of "position open, no confirmed native stop" for this
   *  (account, symbol) — pages ops immediately; a repeat while still failing
   *  is a no-op (the log.error at the call site still fires every pass). */
  private pageNativeStopMissing(acc: AccountInstance, symbol: string, reason: string): void {
    const key = `${acc.id}:${symbol}`;
    if (this.nativeStopIncidents.has(key)) return;
    this.nativeStopIncidents.set(key, Date.now());
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "AccountManager.nativeStopMissing",
      message: `[${acc.id}] ${symbol}: broker position OPEN with NO confirmed native stop (${reason}) — 15s SL loop remains the only protection`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
  }

  /** Resolves a previously-paged native-stop incident (verified/placed/
   *  adopted/row closed) — a no-op if this (account, symbol) never paged. */
  private resolveNativeStopMissing(acc: AccountInstance, symbol: string, resolution: string): void {
    const key = `${acc.id}:${symbol}`;
    const firstAt = this.nativeStopIncidents.get(key);
    if (firstAt === undefined) return;
    this.nativeStopIncidents.delete(key);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "AccountManager.nativeStopMissing",
      message: `[${acc.id}] ${symbol}: native-stop incident RESOLVED after ${Math.round((Date.now() - firstAt) / 1000)}s — ${resolution}`,
      count: 1, windowMs: Date.now() - firstAt, firstAt, lastAt: Date.now(),
    });
  }

  /** One row's native-stop reconciliation. `symbolStops` are OUR (uc8-)
   *  open stop orders on this symbol — with disjoint universes and one open
   *  row per (sleeve, symbol), they all belong to this row. */
  private async ensureNativeStopForRow(acc: AccountInstance, trade: any, brokerQty: number, symbolStops: AlpacaStopOrder[]): Promise<void> {
    if (brokerQty <= 0) {
      // Broker flat but the row is open. If OUR deterministic stop FILLED,
      // that's this layer doing its job (gap fired overnight) — close the
      // row with the REAL fill instead of letting the 404 path fabricate
      // pnl=0. Anything else is left to the existing reconcile paths.
      await this.attributeAlpacaNativeStopFill(acc, trade);
      return;
    }

    const closeSide = trade.side === "buy" ? "sell" : "buy";
    // Row-stop precedence (rowStopPct docstring): a vol-scaled stop persisted
    // at entry must be what this layer arms/verifies — computing 4%-from-entry
    // here would REPLACE the wider/narrower vol stop on the next pass ("a
    // mismatched stop is not protection — replace it" below). Derives the
    // price via the same helper the 15s loop uses so both layers agree.
    const stopPct = rowStopPct(trade, acc.profile.stopLossPct);
    const expectedStop = trade.side === "buy"
      ? trade.entryPrice * (1 - stopPct / 100)
      : trade.entryPrice * (1 + stopPct / 100);
    // OUR row's qty, bounded by what the broker actually holds — the wallet
    // is shared and the aggregate may include shares that are not this
    // row's; a stop must never be able to close more than the row it
    // protects (same contract as the qty-bounded closePosition).
    const qty = Math.floor(Math.min(trade.quantity, brokerQty));
    if (qty < 1) return; // sub-share remnant — the 15s loop still covers it

    // Same verification idea as the Binance adoption paths: right side, right
    // qty, trigger on the PROTECTIVE side of entry and within 1% of the
    // expected price. A mismatched stop is not protection — replace it.
    const trigTol = Math.max(expectedStop * 0.01, 0.01);
    const live = symbolStops.filter(o => {
      if (o.side !== closeSide) return false;
      if (!(Number.isFinite(o.qty) && Math.floor(o.qty) === qty)) return false;
      if (!(Number.isFinite(o.stopPrice) && o.stopPrice > 0)) return false;
      const protective = trade.side === "buy" ? o.stopPrice < trade.entryPrice : o.stopPrice > trade.entryPrice;
      return protective && Math.abs(o.stopPrice - expectedStop) <= trigTol;
    });
    if (live.length > 0) {
      // Keep the first verified stop; clear any duplicate/drifted sibling by
      // exact id (same dedupe the COIN-M reconciler does).
      for (const dup of symbolStops) {
        if (dup.id !== live[0].id) await this.executor.alpaca.cancelOrderById(dup.id);
      }
      // A verified uc8 stop is canonical again — drop any stale adoption.
      this.adoptedNativeStops.delete(trade.id);
      // Mirror the ARMED trigger onto the row so the dashboard's SL column
      // reflects reality. Until 2026-08-09 this was only done by the Binance
      // adapters, so every Alpaca position displayed "—" while carrying a live
      // GTC stop — the protection existed and was invisible.
      updateTradeStopLoss(trade.id, live[0].stopPrice);
      this.resolveNativeStopMissing(acc, trade.symbol, "stop verified live");
      return;
    }

    // Our stop is MISSING from the open-order book entirely (not merely
    // drifted). Existence alone can't tell WHY, and the why decides the fix
    // (docs.alpaca.markets, disclosures/corporate actions):
    //   canceled → reverse split cancels GTC orders silently (or a human
    //              canceled it): the position is NAKED — re-place NOW.
    //   replaced → forward split ADJUSTED it broker-side; the successor is
    //              live under a broker-generated client_order_id. Placing a
    //              second stop here would DOUBLE the protection (two live
    //              sell stops → 2× qty sold on trigger) — adopt instead.
    //   filled   → it fired; attribute the real fill to the row.
    // Resolve by querying the deterministic id's STATE before re-placing.
    if (symbolStops.length === 0) {
      const resolution = await this.resolveMissingNativeStop(acc, trade, closeSide);
      if (resolution !== "place") {
        // "protected" (adopted a broker-adjusted successor) or "handled"
        // (fill attributed, row closed) — either way this symbol is no
        // longer naked; clear/resolve any paged incident.
        this.resolveNativeStopMissing(acc, trade.symbol, resolution === "protected" ? "adopted broker-adjusted stop" : "position closed at the stop's real fill");
        return;
      }
    }

    // Nothing verified: clear our stale stops (exact ids), then (re)place.
    for (const stale of symbolStops) {
      await this.executor.alpaca.cancelOrderById(stale.id);
    }
    const placed = await this.executor.alpaca.placeStopLossOrder({
      symbol: trade.symbol,
      positionSide: trade.side,
      quantity: qty,
      stopPrice: expectedStop,
      accountId: acc.id,
      tradeId: trade.id,
      // Re-evaluated by the executor UNDER the symbol lock, immediately
      // before submit (OPEN.md P1, ABBV): this pass decided "needs a stop"
      // from a snapshot taken before waiting on the lock — a concurrent
      // close (which holds the lock while it cancels stops and sells) may
      // have closed the row in the meantime. Re-read DB truth then.
      stillNeeded: () => getOpenTrades(acc.id).some(t => t.id === trade.id),
    });
    if (!placed.ok) {
      if (placed.skipped) {
        // The under-lock re-check invalidated this pass's stale decision
        // (row closed / broker flat while we waited for the symbol lock) —
        // the race guard WORKING, not an install failure.
        log.warn(`[${acc.id}] 🛡 native GTC stop for ${trade.symbol} NOT placed: ${placed.reason ?? "stale decision invalidated under the symbol lock"}`);
        insertActivity(acc.id, "system", `Native GTC stop for ${trade.symbol} skipped: ${placed.reason ?? "stale decision invalidated under the symbol lock"}`);
        return;
      }
      // NEVER emergency-close here (unlike the Binance orphan paths): the row
      // is still guarded by the 15s loop, which is the pre-existing baseline.
      log.error(`[${acc.id}] 🛡 native GTC stop install FAILED for ${trade.symbol} (${placed.reason ?? "unknown"}) — position keeps only the 15s SL loop until the next pass`);
      insertActivity(acc.id, "error", `Native GTC stop install failed for ${trade.symbol}: ${placed.reason ?? "unknown"}`);
      // Immediate ops page on the FIRST failure — a 60s reconcile cadence
      // can never reach the logger's 10-in-60s ERROR_BURST threshold on its
      // own (the CAT 2026-09-14 4×422 install failure paged nobody).
      this.pageNativeStopMissing(acc, trade.symbol, placed.reason ?? "unknown");
      return;
    }
    updateTradeStopLoss(trade.id, expectedStop);
    insertActivity(acc.id, "system", `Native GTC stop armed for ${trade.symbol} @ $${expectedStop.toFixed(2)} (qty ${qty})`);
    this.resolveNativeStopMissing(acc, trade.symbol, `GTC stop armed @ $${expectedStop.toFixed(2)}`);
  }

  /** Our expected stop is not on the open-order book — resolve WHY via the
   *  deterministic client_order_id's broker state and decide the action:
   *  "place" (re-place now), "protected" (a broker-adjusted successor was
   *  adopted — placing again would double the protection), "handled" (the
   *  stop FILLED; the row was closed with the real fill). See the call site
   *  in ensureNativeStopForRow for the corporate-action background. */
  private async resolveMissingNativeStop(acc: AccountInstance, trade: any, closeSide: "buy" | "sell"): Promise<"place" | "protected" | "handled"> {
    const alp = this.executor.alpaca;

    // 1. A previously adopted successor (forward-split adjustment) — cheap
    //    re-verify by exact order id before anything else.
    const adoptedId = this.adoptedNativeStops.get(trade.id);
    if (adoptedId) {
      const adopted = await alp.getOrderById(adoptedId);
      if (adopted?.status === "filled" && adopted.filledAvgPrice > 0) {
        this.closeRowAsBrokerStopLoss(acc, trade, adopted.filledAvgPrice, adopted.filledAt);
        return "handled";
      }
      if (adopted && !TERMINAL_ORDER_STATUSES.has(adopted.status) && adopted.status !== "replaced") {
        return "protected"; // adopted stop still working — that IS the protection
      }
      this.adoptedNativeStops.delete(trade.id); // stale/re-replaced — re-resolve from the origin below
    }

    // 2. The deterministic id's state. Unknown/never-placed → place (first
    //    install, or a failed read — placeStopLossOrder's duplicate-id
    //    handling keeps a blind re-place idempotent broker-side).
    let state: Awaited<ReturnType<typeof alp.getOrderStateByClientId>> = null;
    try {
      state = await alp.getOrderStateByClientId(stopLossClientOrderId(acc.id, trade.id));
    } catch (e: any) {
      log.warn(`[${acc.id}] stop-state lookup failed for ${trade.symbol}: ${e?.message ?? e} — proceeding to (idempotent) re-place`);
    }
    if (!state) return "place";

    if (state.status === "filled" && state.filledAvgPrice > 0) {
      // Fired while the broker still shows shares (shared wallet: the
      // remainder belongs to another owner) — attribute the real fill.
      this.closeRowAsBrokerStopLoss(acc, trade, state.filledAvgPrice, state.filledAt);
      return "handled";
    }

    if (state.status === "replaced") {
      // Forward split: "GTC buy limits and sell stops are adjusted" — Alpaca
      // replaced our order (OrderStatus `replaced`: "updated due to a market
      // event such as corporate action") with a successor that carries a
      // broker-generated client_order_id, invisible to the uc8 enumeration.
      // Walk the replaced_by chain and adopt the working successor.
      const head = await this.followReplacedChain(state.replacedBy);
      if (head && head.status === "filled" && head.filledAvgPrice > 0) {
        this.closeRowAsBrokerStopLoss(acc, trade, head.filledAvgPrice, head.filledAt);
        return "handled";
      }
      if (head && !TERMINAL_ORDER_STATUSES.has(head.status) && head.type.startsWith("stop") && head.side === closeSide) {
        this.adoptedNativeStops.set(trade.id, head.id);
        log.warn(`[${acc.id}] ↔️ ${trade.symbol}: our GTC stop was REPLACED broker-side (corporate action — forward splits adjust GTC sell stops) — adopting adjusted order ${head.id} (${head.side} ${head.qty} @ trigger $${head.stopPrice}) as this row's protection; NOT placing a duplicate stop`);
        insertActivity(acc.id, "system", `Native stop for ${trade.symbol} was adjusted broker-side (corporate action) — adopted replacement order ${head.id} (${head.side} ${head.qty} @ $${head.stopPrice})`);
        return "protected";
      }
      log.warn(`[${acc.id}] ${trade.symbol}: stop replaced_by chain ended ${head ? `in status=${head.status} type=${head.type}` : "unresolvable"} — re-placing our own stop`);
      return "place";
    }

    if (state.status === "canceled" || state.status === "expired") {
      // Reverse split: "all GTC orders will be canceled that were in the
      // market with a trade date prior to the effective date" — canceled
      // WITHOUT our asking. (Also matches a human cancel, or our own burned
      // deterministic id whose salted successor died.) Either way: naked
      // position, re-place immediately.
      log.warn(`[${acc.id}] 🛡 ${trade.symbol}: our GTC stop is ${state.status.toUpperCase()} broker-side without a working replacement (reverse splits cancel GTC orders; or canceled externally) — position had NO native stop; re-placing now`);
      insertActivity(acc.id, "system", `Native stop for ${trade.symbol} found ${state.status} broker-side (reverse split cancels GTC orders / external cancel) — re-placing`);
      return "place";
    }

    return "place"; // rejected/unknown states: same re-place as before, still idempotent
  }

  /** Walk `replaced_by` links to the newest order in the chain (bounded).
   *  null when any hop is unqueryable — unknown is never adoptable. */
  private async followReplacedChain(startId: string | null | undefined): Promise<Awaited<ReturnType<typeof this.executor.alpaca.getOrderById>>> {
    let id = startId ?? null;
    for (let hop = 0; id && hop < 5; hop++) {
      const ord = await this.executor.alpaca.getOrderById(id);
      if (!ord) return null;
      if (ord.status === "replaced" && ord.replacedBy) { id = ord.replacedBy; continue; }
      return ord;
    }
    return null;
  }

  /** Close a row at a broker-native stop's REAL fill under BROKER_STOP_LOSS
   *  (never a fabricated pnl=0), emitting the standard close events. */
  private closeRowAsBrokerStopLoss(acc: AccountInstance, trade: any, fillPrice: number, filledAt?: number): boolean {
    const result = closeTrade(trade.id, fillPrice, filledAt ?? Date.now(), 0);
    if (!result) return false;
    if (result.closeReason !== "MANUAL_CLOSE_UNRECONCILED") {
      try { updateTradeCloseReason(trade.id, "BROKER_STOP_LOSS"); } catch {}
    }
    acc.positions.delete(trade.symbol);
    this.resolveCloseRejectedIncident(acc.id, trade.symbol, "position closed by the native stop's real fill");
    this.adoptedNativeStops.delete(trade.id);
    this.resolveNativeStopMissing(acc, trade.symbol, "position closed by the native stop's real fill");
    insertActivity(acc.id, "close", `${trade.symbol} closed by broker-native GTC stop @ $${fillPrice.toFixed(2)}`);
    eventBus.emit(EVENTS.POSITION_CLOSED, { ...result, accountId: acc.id, close_reason: "BROKER_STOP_LOSS" });
    log.trade(`[${acc.id}] 🛡 BROKER_STOP_LOSS closed ${trade.symbol} @ $${fillPrice.toFixed(4)}: PnL $${result.pnl.toFixed(2)}`);
    return true;
  }

  /** If OUR deterministic stop order for this row reports FILLED at the
   *  broker — or a replaced_by-ADOPTED successor did (forward split) —
   *  close the row with the real fill price/time under BROKER_STOP_LOSS.
   *  Returns true when the row was closed. Unknown/unfilled → false (caller
   *  falls through to the existing reconcile paths). */
  private async attributeAlpacaNativeStopFill(acc: AccountInstance, trade: any): Promise<boolean> {
    const clientOrderId = stopLossClientOrderId(acc.id, trade.id);
    // Best-effort by contract: an unqueryable order is NO attribution, never
    // a thrown error that would break the caller's close/reconcile path.
    let ord: Awaited<ReturnType<typeof this.executor.alpaca.getOrderStateByClientId>> = null;
    try {
      ord = await this.executor.alpaca.getOrderStateByClientId(clientOrderId);
    } catch (e: any) {
      log.warn(`[${acc.id}] native-stop fill attribution unavailable for ${trade.symbol}: ${e?.message ?? e}`);
    }
    if (!ord || ord.status !== "filled" || !(ord.filledAvgPrice > 0)) {
      // The deterministic order didn't fill — but a corporate-action-adopted
      // successor (its fill lives under a broker-generated client_order_id)
      // may have. Same best-effort contract.
      const adoptedId = this.adoptedNativeStops.get(trade.id);
      if (adoptedId) {
        const adopted = await this.executor.alpaca.getOrderById(adoptedId);
        if (adopted?.status === "filled" && adopted.filledAvgPrice > 0) {
          return this.closeRowAsBrokerStopLoss(acc, trade, adopted.filledAvgPrice, adopted.filledAt);
        }
      }
      return false;
    }
    return this.closeRowAsBrokerStopLoss(acc, trade, ord.filledAvgPrice, ord.filledAt);
  }

  // ── Corporate actions (advisory feed → row/stop/cache reconciliation) ────
  // Called by CorporateActionsMonitor (index.ts wiring). The monitor is
  // ADVISORY by contract — Alpaca warns the feed can lag announcements — so
  // nothing here closes a position, and the per-status stop reconciliation
  // above stays the feed-independent defense.

  /** Symbols with an open Alpaca stock row (any sleeve) — the universe the
   *  daily corporate-actions check pays for. */
  getHeldAlpacaStockSymbols(): string[] {
    const out = new Set<string>();
    for (const id of ALPACA_STOCK_SLEEVES) {
      for (const t of getOpenTrades(id)) {
        if (t.market === "stock") out.add(t.symbol);
      }
    }
    return [...out];
  }

  /**
   * One detected corporate-action event on a held symbol.
   *  upcoming (ex_date ahead): ALERT once — log + activity + ERROR_BURST page
   *    (informational; deliberately NO automatic close: the feed can lag and
   *    a wrong auto-close is a destructive action taken on advisory data).
   *  past (ex_date passed): the bars are rewritten (adjustment=all) and
   *    Alpaca's BOD job (02:15–02:30 ET) already adjusted positions/orders —
   *    invalidate the candle cache, apply a split's ratio to our open rows
   *    ONCE (corporate_actions ledger gates re-application), and force the
   *    native-stop re-verification NOW (canceled → re-place, replaced →
   *    adopt) instead of waiting for the next 60s sync.
   * Every detection lands in the corporate_actions table (audit trail).
   */
  async applyCorporateAction(ev: CorporateActionEvent, phase: "past" | "upcoming"): Promise<void> {
    const rec = recordCorporateAction(ev);
    const holders = ALPACA_STOCK_SLEEVES.filter(id =>
      getOpenTrades(id).some(t => t.market === "stock" && t.symbol === ev.symbol));

    if (phase === "upcoming") {
      if (!rec.isNew) return; // already paged at first detection
      const msg = `Corporate action AHEAD on held ${ev.symbol}: ${ev.type} ex ${ev.exDate}${ev.ratio !== undefined ? ` (ratio ${ev.ratio})` : ""} — GTC stops will be canceled (reverse split) or adjusted (forward split) and bars will rewrite; informational, NO automatic close`;
      log.warn(`🏛 ${msg}`);
      for (const id of holders) insertActivity(id, "system", msg);
      eventBus.emit(EVENTS.ERROR_BURST, {
        context: "CorporateActions", message: msg, count: 1,
        windowMs: 60_000, firstAt: Date.now() - 60_000, lastAt: Date.now(),
      });
      return;
    }

    // phase === "past"
    this.executor.alpaca.invalidateCandleCache(ev.symbol);
    if (rec.appliedAt == null) {
      const isSplit = ev.type === "forward_split" || ev.type === "reverse_split";
      if (isSplit && ev.ratio !== undefined && Number.isFinite(ev.ratio) && ev.ratio > 0 && ev.ratio !== 1) {
        // Late-detection cutoff (OPEN.md P2 2026-08-29): a row ENTERED on/
        // after the ex-date already carries post-split basis — rescaling it
        // would fabricate unrealized pnl and re-arm its stop wildly off.
        // Cutoff = the ex-date's ET day-start; an unusable exDate falls back
        // to the old adjust-everything behavior (a wrongly-adjusted fresh row
        // beats skipping the adjustment on a genuinely held-through split).
        let entryBeforeMs: number | undefined;
        if (typeof ev.exDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ev.exDate)) {
          const [dayStart] = getETDayBounds(ev.exDate);
          if (Number.isFinite(dayStart)) entryBeforeMs = dayStart;
        }
        if (entryBeforeMs === undefined) {
          log.warn(`🏛 ${ev.type} on ${ev.symbol}: unusable exDate "${ev.exDate}" — applying split to ALL open rows (no entry_time cutoff)`);
        }
        const changed = applySplitToOpenStockTrades(ev.symbol, ev.ratio, entryBeforeMs);
        // Mirror into the in-memory position maps so the SL loop/dashboard
        // agree with the adjusted basis before the next broker sync lands.
        for (const id of holders) {
          const pos = this.accounts.get(id)!.positions.get(ev.symbol);
          if (pos) { pos.quantity *= ev.ratio; pos.avgEntryPrice /= ev.ratio; }
        }
        const msg = `${ev.type} on ${ev.symbol} (ex ${ev.exDate}, ratio ${ev.ratio}) applied to ${changed} open row(s): qty ×${ev.ratio}, entry ÷${ev.ratio} — matching Alpaca's BOD position adjustment`;
        log.warn(`🏛 ${msg}`);
        for (const id of holders) insertActivity(id, "system", msg);
        // Trail watermarks live in the engines, and AccountManager doesn't
        // know engines — the tsmTrail sleeve subscribes in index.ts and
        // rescales its marks (MomentumEngine.scaleMarksForSplit).
        eventBus.emit(EVENTS.CORPORATE_ACTION_APPLIED, { symbol: ev.symbol, ratio: ev.ratio });
      } else if (rec.isNew) {
        // Mergers/name changes/worthless removals: no mechanical row fix
        // exists — page a human instead of guessing.
        const msg = `Corporate action OCCURRED on held ${ev.symbol}: ${ev.type} ex ${ev.exDate} — no automatic row adjustment for this type; verify the position/basis manually`;
        log.error(`🏛 ${msg}`);
        for (const id of holders) insertActivity(id, "error", msg);
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "CorporateActions", message: msg, count: 1,
          windowMs: 60_000, firstAt: Date.now() - 60_000, lastAt: Date.now(),
        });
      }
      markCorporateActionApplied(ev.symbol, ev.type, ev.exDate);
    }
    // Forced stop re-verification for the whole book (per-row isolation
    // inside): the canceled/replaced distinction handles this symbol's stop.
    try {
      await this.ensureAlpacaNativeStops();
    } catch (e: any) {
      log.warn(`post-corporate-action stop reconcile failed: ${e?.message ?? e} — next 60s sync retries`);
    }
  }

  /** Broker equity at v8 start = first alpaca_main snapshot after the v8
   *  deploy (2026-07-10T14:00Z). The anchor is a fixed HISTORICAL fact
   *  (written under semantics=2), so the lookup accepts semantics>=2 — a
   *  global EQUITY_SEMANTICS bump (2→3 for Binance collateral) must NOT lose
   *  it. Cached once found; null (skip the drift check) while unavailable. */
  private alpacaV8StartEquity: number | undefined;
  private getAlpacaV8StartEquity(): number | null {
    if (this.alpacaV8StartEquity !== undefined) return this.alpacaV8StartEquity;
    const v = getAlpacaV8StartEquity();
    if (v != null) this.alpacaV8StartEquity = v;
    return v;
  }

  /** §4 structural guard: portfolio invariant reconciliation, once per ET day.
   *  Runs inside the 5-min snapshot loop right after fresh snapshots landed. */
  private lastInvariantDay = "";
  private runDailyInvariantCheck() {
    const day = getETDateKey();
    if (this.lastInvariantDay === day) return;
    this.lastInvariantDay = day;
    try {
      const unrealized: Partial<Record<RiskProfileId, number>> = {};
      for (const [id, acc] of this.accounts) {
        unrealized[id] = (acc.state?.positions ?? []).reduce((s, p) => s + p.unrealizedPnl, 0);
      }
      reconcilePortfolioInvariants(unrealized);
    } catch (e: any) {
      log.warn(`invariant check failed to run: ${e?.message ?? e}`);
    }
  }

  // ── Consolidated views ────────────────────

  getConsolidatedState(): PortfolioState {
    const all: Position[] = [];
    let equity = 0, cash = 0, stocksVal = 0, cryptoVal = 0, dailyPnl = 0, totalPnl = 0, dailyTrades = 0;
    let totalT = 0, winT = 0;
    // Active only — an inactive momentum_crypto_usdc/momentum_btc (flag off,
    // no exposure) contributes NOTHING here, not even its seed initialEquity.
    // See isActive/getActiveProfileIds.
    const activeAccounts = this.getActiveProfileIds().map(id => this.accounts.get(id)!);
    for (const acc of activeAccounts) {
      equity += acc.state.totalEquity; cash += acc.state.cash;
      stocksVal += acc.state.stocksValue; cryptoVal += acc.state.cryptoValue;
      dailyPnl += acc.state.dailyPnl; totalPnl += acc.state.totalPnl;
      dailyTrades += acc.state.dailyTrades;
      // Stamp profileId on a COPY (never mutate acc.state.positions, which is
      // also the per-sleeve view + acc.positions map read elsewhere) — the
      // consolidated list is the only place positions from different sleeves
      // land together, so it's the only place a reader needs this to tell a
      // momentum_crypto LINK/USD row apart from a momentum_crypto_usdc
      // LINK/USDC row, or to size exposure vs. each sleeve's allocation.
      all.push(...acc.state.positions.map(p => ({ ...p, profileId: acc.id })));
      // winRate denominator = CLOSED trades (totalTrades counts open rows too).
      const s = getTradingStats(acc.id); totalT += s.closedTrades; winT += s.winningTrades;
    }
    const initTotal = activeAccounts.reduce((s, a) => s + a.equity.initialEquity, 0);
    return {
      totalEquity: equity, cash, stocksValue: stocksVal, cryptoValue: cryptoVal, positions: all,
      dailyPnl, dailyPnlPct: equity > 0 ? (dailyPnl / equity) * 100 : 0,
      totalPnl, totalPnlPct: initTotal > 0 ? (totalPnl / initTotal) * 100 : 0,
      openPositions: all.length, dailyTrades,
      winRate: totalT > 0 ? (winT / totalT) * 100 : 0, timestamp: Date.now(),
    };
  }

  /** Real per-broker-FAMILY unrealized PnL, summed from live position state.
   *  broker="binance" matches every binance* routing key (binance/
   *  binance_usdc/binance_coinm — one combined "Binance" dashboard card). */
  getBrokerUnrealizedPnl(broker: "alpaca" | "binance"): number {
    let sum = 0;
    for (const id of this.getActiveProfileIds()) {
      const acc = this.accounts.get(id)!;
      const matches = broker === "binance" ? acc.profile.broker.startsWith("binance") : acc.profile.broker === "alpaca";
      if (!matches) continue;
      for (const p of acc.state?.positions ?? []) sum += p.unrealizedPnl;
    }
    return sum;
  }

  getState(id?: RiskProfileId | "consolidated"): PortfolioState {
    if (!id || id === "consolidated" || !this.isActive(id as RiskProfileId)) return this.getConsolidatedState();
    return this.accounts.get(id as RiskProfileId)?.state ?? this.getConsolidatedState();
  }

  getDashboardData(viewId?: RiskProfileId | "consolidated"): any {
    const id = viewId ?? this.viewId;
    // Dynamic views accept ACTIVE ids only — a stale session cookie/settings
    // referencing a since-deactivated (or never-active) sleeve falls back to
    // consolidated instead of resurrecting its state/cards.
    const isConsolidated = !id || id === "consolidated" || !this.isActive(id as RiskProfileId);
    const state = isConsolidated ? this.getConsolidatedState() : this.getState(id as RiskProfileId);
    const accountId = isConsolidated ? undefined : id as RiskProfileId;
    const realizedPnl = getTradingStats(isConsolidated ? undefined : accountId as string).totalPnl;

    // Anchor "Since Start" to the first equity snapshot (broker-truth rows for
    // the consolidated view). DISPLAY variants (src/portfolio/truth.ts) span
    // every configured-rebase semantics era, not just the current one — the
    // current-era-only getPortfolioEquityStart stays reserved for
    // reconcilePortfolioInvariants and its own tests
    // (getSleeveEquityStart, its per-sleeve twin, had no caller anywhere and
    // was deleted 2026-09-25).
    const startInfo: { equity: number | undefined; rebased: boolean } = (() => {
      if (isConsolidated) {
        const s = getPortfolioEquityStartDisplay();
        return { equity: s.total ?? undefined, rebased: s.rebased };
      }
      const s = getSleeveEquityStartDisplay(accountId as string);
      return { equity: s?.equity ?? undefined, rebased: s?.rebased ?? false };
    })();
    const startingEquity = startInfo.equity;

    const perfTotalEquity: number | null = (() => {
      if (!isConsolidated) return state.totalEquity;
      // Broker truth = latest *_main equity_snapshots (written every sync),
      // via portfolio/truth — NEVER the stale `accounts` table (frozen at its
      // Jul 9 pre-v8-deploy values; the $111,580-vs-$111,353 incident).
      return getPortfolioEquityNow().total;
    })();

    let todayTrades = 0;
    if (isConsolidated) {
      for (const aid of this.getActiveProfileIds()) todayTrades += getTradingStats(aid).todayTrades;
    } else {
      const acc = this.accounts.get(id as RiskProfileId);
      if (acc) todayTrades = getTradingStats(acc.id).todayTrades;
    }

    return {
      portfolio: state,
      recentSignals: getRecentSignals(20, accountId),
      recentTrades: getRecentTrades(200, accountId), // 200 so the dashboard 30d time-filter is accurate
      activeStrategies: this.getActiveStrategies(),
      marketData: this.getMarketData(),
      viewId: id,
      accounts: this.getAccountSummaries(),
      performance: perfTotalEquity == null
        ? { equityPnl: null, equityPnlPct: null }
        : buildPerformanceSummary({ totalEquity: perfTotalEquity, realizedPnl, startingEquity, rebased: startInfo.rebased }),
      circuits: this.getCircuits(),
      adjustments: [],
      correlations: [],
      dailyTradesUsage: { current: todayTrades, max: 0 },
      // v8-scoped (2026-09-24 audit fix): the "RUNNING" KPI must not count
      // the amputated pre-v8 legacy profiles' April history — see
      // getV8StartedAt's docstring. getBotStartedAt (account-agnostic,
      // whole-table earliest) stays untouched for its other, documented use.
      daysRunning: Math.max(1, Math.ceil((Date.now() - getV8StartedAt()) / 86_400_000)),
    };
  }

  getAccountSummaries() {
    const circuits = this.getCircuits();
    const summaries: any[] = [];
    // Active only — this is THE source of dashboard.accounts (cards) and the
    // /api/accounts feed; an inactive sleeve must produce no card at all.
    for (const id of this.getActiveProfileIds()) {
      const acc = this.accounts.get(id)!;
      const p = acc.profile;
      const stats = getTradingStats(id);
      summaries.push({
        id, label: p.label, emoji: p.emoji, broker: p.broker,
        equity: acc.equity.equity, cash: acc.equity.cash,
        initialEquity: acc.equity.initialEquity,
        totalPnl: acc.equity.totalPnl, totalPnlPct: acc.equity.totalPnlPct,
        positions: acc.positions.size,
        paused: circuits[id]?.paused ?? false,
        todayTrades: stats.todayTrades,
        // "live" (default, every always-on sleeve) | "close-only" (flag off,
        // exposure forced a reconcile-only attach — never a fake "LIVE").
        mode: this.sleeveMode.get(id) ?? "live",
      });
    }
    return summaries;
  }

  private getMarketData(): Record<string, { price: number; change24h: number }> {
    const data: Record<string, { price: number; change24h: number }> = {};
    for (const symbol of [...getEnabledStocks(), ...getEnabledCrypto()]) {
      data[symbol] = { price: this.executor.alpaca.getCachedPrice(symbol), change24h: 0 };
    }
    return data;
  }

  private emitPositionUpdates(symbol: string, currentPrice: number) {
    for (const [id, acc] of this.accounts) {
      const pos = acc.positions.get(symbol);
      if (!pos) continue;
      const { pnl, pnlPct } = pnlOf(pos.side, pos.avgEntryPrice, currentPrice, pos.quantity);
      eventBus.emit(EVENTS.POSITION_UPDATE, { accountId: id, symbol, currentPrice, unrealizedPnl: pnl, unrealizedPnlPct: pnlPct });
    }
  }

  // ── Public getters ────────────────────────
  getAccount(id: RiskProfileId): AccountInstance {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    return account;
  }
}
