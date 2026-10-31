// ═══ Portfolio engine — the live runner (one instance per sleeve) ═══
//
// Lifecycle of one decision (RW-reescritura-rentable §3/§4):
//   1. schedule   — stocks ≥ 09:35 ET on a trading day, crypto ≥ 00:00:15 UTC;
//                   one pass per execution session (portfolio_decisions is the
//                   restart-safe marker).
//   2. data       — PriceView over historical.db ending at the PREVIOUS
//                   session; stale/missing universe data ⇒ skip + alert,
//                   retried every tick until the day's refresh lands.
//   3. book       — the sleeve's own trades rows, reconciled with the venue
//                   (broker = truth: a smaller broker qty shrinks/closes the
//                   row; a larger one is not ours and is only reported);
//                   equity = capital + realized + unrealized at the reference
//                   prices (computeSleeveLedger — the existing sleeves' math).
//   4. decide     — the pure core (decide → planOrders) with the memory of
//                   THIS strategy version.
//   5. persist    — the decision row (target, memory, orders) BEFORE any order.
//   6. submit     — live mode only: deterministic client order ids, sells
//                   first, each fill applied to the rows and marked `applied`
//                   so a restart resumes exactly the orders not yet applied.
//                   A sell refused only because its shares are still held
//                   (an incumbent stop's async cancel) is NOT applied: the pass
//                   stays `decided` and the next tick resumes it with the same
//                   client order id, ≤ maxSellAttempts (5) per order per session,
//                   then terminal + page. Buys wait behind a retrying sell.
//   7. stops      — designs with stops: re-decide on the ACTUAL positions and
//                   sync the venue's stop orders (VenueAdapter.syncStops).
//   Observer mode runs 1–5 and submits nothing, mutates no row.
//
// Adoption (live, every pass — idempotent): open rows of the sleeve under any
// other strategy tag are re-tagged to ours; venue positions in the universe
// with no row anywhere become rows at the broker's basis. Nothing is closed
// to be re-bought.

import { decide as coreDecide, type CoreDecideInput } from "../decide";
import { planOrders as corePlanOrders } from "../orders";
import { overlaySymbols } from "../contingency";
import { MAX_HOLD_CLOSE_REASON } from "../types";
import type {
  BookState, MembershipView, OrderIntent, OrderResult, PlanOrders, PortfolioStrategyConfig, Position, PriceView, SessionDate,
  StopLevel, TargetBook, VenueAdapter, VenueRules,
} from "../types";
import { computeSleeveLedger } from "../../account/EquityTracker";
import { isTradingEnabled } from "../../config";
import { insertActivity } from "../../db/database";
import { createLogger } from "../../utils/logger";
import { isMarketOpen } from "../../utils/marketHours";
import { eventBus, EVENTS } from "../../utils/events";
import { heartbeats as defaultHeartbeats } from "../../ops/heartbeat";
import { portfolioClientOrderId } from "./clientOrderId";
import type { FreshnessReport } from "./priceView";
import {
  getPortfolioDecision, getPortfolioSessionDecision, latestPortfolioMemory, savePortfolioDecision, updatePortfolioDecisionProgress,
  type DecisionMode, type PersistedOrder, type PortfolioDecisionRecord,
} from "./persistence";
import {
  adoptBrokerPosition, adoptSleeveRows, applyBuyFill, applySellFill, loadSleeveRows, positionsFromRows,
  reconcileRowToBroker, sleeveRealizedPnl, type RowsConfig,
} from "./rows";
import { runWindow, type Market, type RunWindow } from "./schedule";

/** What the engine needs from a data source: the contract's PriceView plus
 *  freshness and a last-close fallback for reference prices. */
export interface EnginePriceView {
  readonly asOf: SessionDate;
  history: PriceView["history"];
  barCount: PriceView["barCount"];
  freshness(symbols: readonly string[]): FreshnessReport;
  lastClose(symbol: string): number | null;
}

export interface PortfolioEngineOptions {
  accountId: string;
  strategyVersion: string;
  config: PortfolioStrategyConfig;
  /** Fixed sleeve capital (owner rule: per-sleeve capital never reallocates). */
  capital: number;
  market: Market;
  /** trades.market of the rows. */
  rowMarket: "stock" | "crypto";
  /** Quote asset label on the partial-realized ledger (USD / USDT / USDC). */
  quoteAsset: string;
  venue: VenueAdapter;
  mode: DecisionMode;
  /** Opens the point-in-time view for `asOf` covering `symbols`. */
  openPriceView: (asOf: SessionDate, symbols: readonly string[]) => EnginePriceView;
  membership?: MembershipView;
  /** Injectable pure core (tests use doubles; production the real one). */
  decide?: (input: CoreDecideInput) => TargetBook;
  planOrders?: PlanOrders;
  now?: () => number;
  tradingEnabled?: () => boolean;
  /** Universe symbols allowed to be stale/missing before the pass is skipped. */
  maxStaleSymbols?: number;
  /** Relative tolerance when comparing DB vs broker quantities. */
  qtyTolerance?: number;
  heartbeatName?: string;
  heartbeats?: { register(name: string, intervalMs: number, opts?: { graceMultiplier?: number }): void; beat(name: string): void };
  alert?: (context: string, message: string) => void;
  /** Submissions per retryable sell (held-quantity rejection) per session before it is terminal (default 5). */
  maxSellAttempts?: number;
  /** Tick cadence of start() (ms). */
  tickMs?: number;
  /** Consecutive failed passes before one page per session. */
  failPageAfter?: number;
}

/** "retrying": the pass is live and `decided` with orders still to retry next tick (a sell the venue refused
 *  because the shares are still held, plus the buys deferred behind it). */
export type RunStatus = "not_due" | "already_done" | "skipped_stale" | "observed" | "submitted" | "resumed" | "retrying" | "failed";

export interface PortfolioRunReport {
  status: RunStatus;
  session?: SessionDate;
  asOf?: SessionDate;
  orders: PersistedOrder[];
  rejected: number;
  note?: string;
}

const DEFAULT_QTY_TOLERANCE = 1e-6;
/** Submissions of one retryable sell per session before it is terminal (and pages). */
const DEFAULT_MAX_SELL_ATTEMPTS = 5;
/** Alpaca: `http_403 insufficient qty available for order (requested: X, available: 0)` while a resting order
 *  (e.g. a stop whose cancel has not settled) still holds the shares; also its `held_for_orders` field. */
const HELD_QTY_REJECTION_RE = /insufficient\s+(qty|quantity)|held[_ ]for[_ ]orders|available:\s*[\d.]+\s*\)/i;

/** A SELL the venue refused only because the shares are held/unavailable right now. The venue never created the
 *  order (a 403's client id stays free), so the same id can be sent again. Every other rejection is terminal. */
export function isRetryableSellRejection(intent: OrderIntent, result: OrderResult): boolean {
  return intent.side === "sell" && !result.ok && !(result.filledQty > 0) && result.status === "rejected"
    && HELD_QTY_REJECTION_RE.test(result.error ?? "");
}

interface SubmitOutcome {
  /** Orders whose rejection is terminal (applied) in THIS call. */
  rejected: PersistedOrder[];
  /** Orders left unapplied for the next tick: retryable sells and the buys deferred behind them. */
  retrying: number;
  /** Market closed while the pass was awaiting data or an earlier order. */
  marketClosed?: boolean;
}

export class PortfolioEngine {
  private readonly log;
  private readonly decideFn: (input: CoreDecideInput) => TargetBook;
  private readonly planFn: PlanOrders;
  private readonly now: () => number;
  private readonly tradingEnabled: () => boolean;
  private readonly alertFn: (context: string, message: string) => void;
  private readonly heartbeatName: string;
  private readonly rows: RowsConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failStreak = 0;
  private failPagedSession = "";
  private stalePagedSession = "";

  constructor(private readonly opts: PortfolioEngineOptions) {
    this.log = createLogger(`Portfolio:${opts.accountId}`);
    this.decideFn = opts.decide ?? coreDecide;
    this.planFn = opts.planOrders ?? corePlanOrders;
    this.now = opts.now ?? Date.now;
    this.tradingEnabled = opts.tradingEnabled ?? isTradingEnabled;
    this.alertFn = opts.alert ?? ((context, message) => {
      const at = this.now();
      eventBus.emit(EVENTS.ERROR_BURST, { context, message, count: 1, windowMs: 0, firstAt: at, lastAt: at });
    });
    this.heartbeatName = opts.heartbeatName ?? `portfolio:${opts.accountId}`;
    this.rows = { accountId: opts.accountId, strategyVersion: opts.strategyVersion, market: opts.rowMarket, quoteAsset: opts.quoteAsset };
  }

  get accountId(): string { return this.opts.accountId; }
  get mode(): DecisionMode { return this.opts.mode; }

  // ── scheduling ─────────────────────────────────────────────────────────

  /** Register the heartbeat and drive tick() on a timer (boot tick after 30s). */
  start(): void {
    const hb = this.opts.heartbeats ?? defaultHeartbeats;
    hb.register(this.heartbeatName, 86_400_000, { graceMultiplier: 5 });
    const tickMs = this.opts.tickMs ?? 60_000;
    this.bootTimer = setTimeout(() => { this.tick().catch(() => {}); }, Math.min(30_000, tickMs));
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, tickMs);
    this.log.info(`portfolio engine started (${this.opts.mode}, ${this.opts.market}, ${this.opts.config.kind} ${this.opts.strategyVersion})`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.timer = null;
    this.bootTimer = null;
  }

  /** One scheduler tick: run the session when due and not yet done. Beats the
   *  heartbeat when idle or successful; a persistently failing pass goes
   *  stale and pages after `failPageAfter` consecutive failures. */
  async tick(): Promise<PortfolioRunReport> {
    const hb = this.opts.heartbeats ?? defaultHeartbeats;
    const window = this.stockMarketClosed() ? null : runWindow(this.opts.market, this.now());
    if (!window) { hb.beat(this.heartbeatName); return { status: "not_due", orders: [], rejected: 0 }; }
    if (this.running) return { status: "not_due", orders: [], rejected: 0, note: "pass in progress" };
    this.running = true;
    try {
      const report = await this.runSession(window);
      if (report.status === "failed") {
        this.failStreak++;
        const after = this.opts.failPageAfter ?? 10;
        if (this.failStreak >= after && this.failPagedSession !== window.session) {
          this.failPagedSession = window.session;
          this.alertFn(`Portfolio:${this.opts.accountId}`,
            `${this.opts.accountId} portfolio pass failing ${this.failStreak}× in a row for ${window.session}: ${report.note ?? "?"} — no decision taken yet`);
        }
      } else {
        this.failStreak = 0;
        hb.beat(this.heartbeatName);
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  // ── one session ────────────────────────────────────────────────────────

  private stockMarketClosed(): boolean {
    if (this.opts.market !== "stocks" || isMarketOpen(this.now())) return false;
    this.log.info("skip: stock market closed (outside regular market hours)");
    return true;
  }

  async runSession(window: RunWindow): Promise<PortfolioRunReport> {
    const { session, asOf } = window;
    if (this.stockMarketClosed()) return { status: "not_due", session, asOf, orders: [], rejected: 0, note: "stock market closed" };
    const key = { accountId: this.opts.accountId, strategyVersion: this.opts.strategyVersion, session };
    try {
      const existing = getPortfolioDecision(key.accountId, key.strategyVersion, session);
      if (existing && (existing.status === "observed" || existing.status === "submitted")) {
        return { status: "already_done", session, asOf, orders: existing.orders, rejected: 0 };
      }
      if (existing && existing.status === "decided" && this.opts.mode === "live") {
        // Crashed between persisting the decision and finishing the orders:
        // resume ONLY what was not applied, same client order ids.
        return await this.resume(existing);
      }
      return await this.decideAndExecute(window);
    } catch (e: any) {
      const note = String(e?.message ?? e);
      this.log.error(`pass ${session} failed: ${note}`);
      try {
        const prior = getPortfolioDecision(key.accountId, key.strategyVersion, session);
        if (prior && prior.status === "decided") updatePortfolioDecisionProgress(key, { note: `resume pending: ${note}` }, this.now());
      } catch { /* the failure report is the signal */ }
      return { status: "failed", session, asOf, orders: [], rejected: 0, note };
    }
  }

  private decisionSymbols(asOf: SessionDate, memory: Readonly<Record<string, unknown>>, session?: SessionDate): { all: string[]; required: string[] } {
    const cfg = this.opts.config;
    if (cfg.kind === "factorCore") {
      if (!this.opts.membership) throw new Error("factorCore needs a MembershipView (point-in-time index members)");
      const members = [...this.opts.membership.members(asOf)].filter(s => !cfg.exclude.includes(s));
      const core = (memory.portfolioCore as any)?.coreMembers as string[] | undefined;
      const required = new Set<string>(members);
      if (cfg.overlay) required.add(cfg.overlay.ref);
      for (const s of core ?? []) required.add(s);
      return { all: [...required], required: [...required] };
    }
    if (cfg.kind === "copySignal") throw new Error("copySignal is research-only: no live signal source is wired");
    if (cfg.kind === "volManaged" && (cfg.regimeOverlay || cfg.pitUniverse)) {
      const members = cfg.pitUniverse ? (() => {
        if (!this.opts.membership) throw new Error("pitUniverse needs a MembershipView (point-in-time index members)");
        return this.opts.membership.members(session ?? asOf).filter(s => !cfg.pitUniverse!.exclude?.includes(s));
      })() : [];
      const all = [...new Set([...cfg.universe, ...members, ...(cfg.regimeOverlay ? overlaySymbols(cfg.regimeOverlay, false) : [])])];
      // Candidates with unavailable history are ineligible, not a reason to block the entire PIT book.
      const required = [...new Set([...cfg.universe, ...(cfg.regimeOverlay ? overlaySymbols(cfg.regimeOverlay) : [])])];
      return { all, required };
    }
    return { all: [...cfg.universe], required: [...cfg.universe] };
  }

  private hasDesignStops(): boolean {
    const cfg = this.opts.config;
    return cfg.kind === "cryptoTrend" && cfg.stop.mode !== "none";
  }

  private hasMaxHold(): boolean {
    return this.opts.config.kind === "volManaged" && this.opts.config.maxHoldSessions !== undefined;
  }

  private alreadyDecided({ session, asOf }: RunWindow): PortfolioRunReport | null {
    const existing = getPortfolioSessionDecision(this.opts.accountId, session);
    return existing ? {
      status: "already_done", session, asOf, orders: existing.orders, rejected: 0,
      note: `session already decided by ${existing.strategyVersion} (${existing.status})`,
    } : null;
  }

  private async decideAndExecute(window: RunWindow): Promise<PortfolioRunReport> {
    const prior = this.alreadyDecided(window);
    if (prior) return prior;
    const { session, asOf } = window;
    const live = this.opts.mode === "live";
    const key = { accountId: this.opts.accountId, strategyVersion: this.opts.strategyVersion, session };
    const memory = latestPortfolioMemory(key.accountId, key.strategyVersion);
    const symbols = this.decisionSymbols(asOf, memory, session);

    // 2. data freshness
    const rowsBefore = loadSleeveRows(this.opts.accountId);
    const heldSymbols = rowsBefore.map(r => r.symbol);
    const view = this.opts.openPriceView(asOf, [...new Set([...symbols.all, ...symbols.required, ...heldSymbols])]);
    if (view.asOf !== asOf) throw new Error(`price view asOf ${view.asOf} ≠ expected ${asOf}`);
    const fresh = view.freshness(symbols.required);
    const staleCount = fresh.stale.length + fresh.missing.length;
    if (staleCount > (this.opts.maxStaleSymbols ?? 0)) {
      const note = `data not at ${asOf}: stale [${fresh.stale.join(", ")}] missing [${fresh.missing.join(", ")}]`;
      this.log.warn(`skip ${session}: ${note}`);
      savePortfolioDecision({
        ...key, asOf, mode: this.opts.mode, status: "skipped_stale", equity: 0, book: [], weights: {}, stops: [],
        memory, diagnostics: { freshness: fresh }, orders: [], note, decidedAt: this.now(), updatedAt: this.now(),
      });
      if (this.stalePagedSession !== session) {
        this.stalePagedSession = session;
        this.alertFn(`Portfolio:${this.opts.accountId}`, `${this.opts.accountId}: no decision for ${session} — ${note}`);
      }
      return { status: "skipped_stale", session, asOf, orders: [], rejected: 0, note };
    }

    // 3. book: adoption (live), reconciliation, reference prices, equity
    const venueSymbols = [...new Set([...symbols.all, ...heldSymbols])];
    const brokerPositions = await this.opts.venue.positions(venueSymbols);
    const brokerQty = new Map(brokerPositions.map(p => [p.symbol, p.qty]));
    const prices = await this.referencePrices(venueSymbols, view, brokerPositions);
    const tol = this.opts.qtyTolerance ?? DEFAULT_QTY_TOLERANCE;
    const drift: string[] = [];
    if (live) {
      const adopted = adoptSleeveRows(this.rows, this.now());
      if (adopted.length > 0) this.log.warn(`adopted ${adopted.length} existing row(s) of ${this.opts.accountId}: ${adopted.join(", ")}`);
      const rowSymbols = new Set(loadSleeveRows(this.opts.accountId).map(r => r.symbol));
      for (const p of brokerPositions) {
        if (p.qty <= 0 || rowSymbols.has(p.symbol) || !symbols.all.includes(p.symbol)) continue;
        const id = adoptBrokerPosition(this.rows, p, this.now());
        if (id) this.log.warn(`adopted broker position ${p.symbol} ${p.qty} @ ${p.avgEntryPrice} as row ${id}`);
      }
      await this.releaseIncumbentStops();
      for (const pos of positionsFromRows(loadSleeveRows(this.opts.accountId))) {
        const bq = brokerQty.get(pos.symbol) ?? 0;
        if (bq < pos.qty * (1 - tol)) {
          reconcileRowToBroker(this.rows, pos.symbol, bq, prices[pos.symbol] ?? 0, this.now());
          drift.push(`${pos.symbol}: broker ${bq} < rows ${pos.qty} (rows reconciled)`);
        } else if (bq > pos.qty * (1 + tol)) {
          drift.push(`${pos.symbol}: broker ${bq} > rows ${pos.qty} (excess not ours — untouched)`);
        }
      }
    } else {
      for (const pos of positionsFromRows(rowsBefore)) {
        const bq = brokerQty.get(pos.symbol) ?? 0;
        if (Math.abs(bq - pos.qty) > pos.qty * tol) drift.push(`${pos.symbol}: broker ${bq} vs rows ${pos.qty} (observer: not reconciled)`);
      }
    }
    if (drift.length > 0) this.log.warn(`book drift vs venue: ${drift.join("; ")}`);
    const rows = loadSleeveRows(this.opts.accountId);
    const positions = positionsFromRows(rows, this.hasMaxHold());
    const ledger = computeSleeveLedger(this.opts.capital, sleeveRealizedPnl(this.opts.accountId), rows, s => prices[s] ?? 0);
    if (!Number.isFinite(ledger.equity) || ledger.equity <= 0) {
      throw new Error(`sleeve ledger invalid (equity=${ledger.equity}) — refusing to size on it`);
    }
    const book: BookState = { equity: ledger.equity, positions, memory };

    // 4. decide + plan
    const target = this.decideFn({ view, membership: this.opts.membership, book, config: this.opts.config, executionSession: session });
    const rules: VenueRules = await this.opts.venue.rules(venueSymbols);
    const intents: OrderIntent[] = this.planFn(target, book, prices, rules);

    // 5. persist BEFORE any order
    // Venue reads above await: another version may have claimed this session meanwhile.
    // No await between this check and the synchronous decision write.
    const claimed = this.alreadyDecided(window);
    if (claimed) return claimed;
    const orders: PersistedOrder[] = intents.map(intent => ({
      intent, clientOrderId: live ? portfolioClientOrderId(this.opts.accountId, session, intent.symbol, intent.maxHold) : null,
      result: null, applied: false, ...(live ? {} : { skipped: "observer" }),
    }));
    const record: PortfolioDecisionRecord = {
      ...key, asOf, mode: this.opts.mode, status: live ? "decided" : "observed", equity: ledger.equity,
      book: positions, weights: target.weights, stops: target.stops, memory: target.memory,
      diagnostics: { ...target.diagnostics, freshness: fresh, prices, drift, rules },
      orders, note: null, decidedAt: this.now(), updatedAt: this.now(),
    };
    savePortfolioDecision(record);
    this.log.info(`${session} (asOf ${asOf}) ${this.opts.mode}: equity $${ledger.equity.toFixed(2)}, ${Object.keys(target.weights).length} target(s), ${intents.length} order(s)`);
    if (!live) return { status: "observed", session, asOf, orders, rejected: 0 };

    // 6. submit, 7. stops on the actual book, close-out
    return await this.submitAndSettle(key, asOf, orders, view, target, ledger.equity, "submitted", null);
  }

  /** Steps 6–7 shared by the first pass and the resume. Orders that must be retried (a held-quantity sell
   *  rejection and the buys deferred behind it) keep the decision `decided`: the next tick resumes them with
   *  the same client order ids. Stops are refreshed and progress recorded either way; the post-fill memory is
   *  persisted only by the closing call (the README contract: ONE refresh from the first call's memory). */
  private async submitAndSettle(
    key: { accountId: string; strategyVersion: string; session: SessionDate }, asOf: SessionDate,
    orders: PersistedOrder[], view: EnginePriceView, target: TargetBook, equity: number,
    doneStatus: "submitted" | "resumed", doneNote: string | null,
  ): Promise<PortfolioRunReport> {
    const outcome = await this.submitAll(key, orders, view);
    if (outcome.marketClosed) return {
      status: "not_due", session: key.session, asOf, orders, rejected: outcome.rejected.length, note: "stock market closed",
    };
    const retrying = outcome.retrying > 0;
    await this.refreshStops(key, view, target, equity, !retrying);
    if (retrying) {
      const pending = orders.filter(o => !o.applied && !o.skipped).map(o => `${o.intent.side} ${o.intent.symbol}${o.attempts ? ` (${o.attempts}/${this.opts.maxSellAttempts ?? DEFAULT_MAX_SELL_ATTEMPTS})` : ""}`);
      updatePortfolioDecisionProgress(key, { orders, note: `retrying next tick: ${pending.join(", ")}` }, this.now());
    } else {
      updatePortfolioDecisionProgress(key, { status: "submitted", orders, ...(doneNote ? { note: doneNote } : {}) }, this.now());
    }
    const rejected = outcome.rejected.length;
    if (rejected > 0) {
      this.alertFn(`Portfolio:${this.opts.accountId}`,
        `${this.opts.accountId} ${key.session}: ${rejected} order(s) rejected — ${outcome.rejected.map(o => `${o.intent.side} ${o.intent.symbol}: ${o.result?.error ?? o.result?.status}`).join("; ")}`);
    }
    return { status: retrying ? "retrying" : doneStatus, session: key.session, asOf, orders, rejected };
  }

  /** The rows of this sleeve are ours now (adoption) and out of the stop machinery: the stops the
   *  incumbent armed at the venue go too (a resting full-size stop keeps firing on an adopted row and
   *  makes the venue reject this engine's own sells). Idempotent; the design's own stops are synced
   *  after the fills. A failure alerts and the pass goes on. */
  private async releaseIncumbentStops(): Promise<void> {
    if (!this.opts.venue.releaseLegacyStops) return;
    const symbols = [...new Set(loadSleeveRows(this.opts.accountId).map(r => r.symbol))];
    if (symbols.length === 0) return;
    try {
      const res = await this.opts.venue.releaseLegacyStops(symbols);
      const { released, unconfirmed } = Array.isArray(res) ? { released: res, unconfirmed: [] as string[] } : res;
      if (released.length > 0) {
        insertActivity(this.opts.accountId, "system", `portfolio engine released ${released.length} incumbent stop order(s) on adopted rows: ${released.join(", ")}`);
      }
      if (unconfirmed.length > 0) {
        // Not a page: a sell refused for held shares is retried every tick (submitAll).
        const msg = `${unconfirmed.length} incumbent stop cancel(s) not confirmed by the venue in time (${unconfirmed.join(", ")}) — their shares may still be held; sells refused for it are retried`;
        this.log.warn(msg);
        insertActivity(this.opts.accountId, "system", `portfolio engine: ${msg}`);
      }
    } catch (e: any) {
      this.alertFn(`Portfolio:${this.opts.accountId}`,
        `${this.opts.accountId}: could not release the incumbent's stop orders on adopted rows (${e?.message ?? e}) — a stale stop may still fire or block sells`);
    }
  }

  private async resume(existing: PortfolioDecisionRecord): Promise<PortfolioRunReport> {
    const key = { accountId: existing.accountId, strategyVersion: existing.strategyVersion, session: existing.session };
    this.log.warn(`resuming ${existing.session}: ${existing.orders.filter(o => !o.applied && !o.skipped).length} order(s) not yet applied`);
    const symbols = [...new Set([...existing.orders.map(o => o.intent.symbol), ...loadSleeveRows(this.opts.accountId).map(r => r.symbol)])];
    if (this.opts.config.kind === "volManaged" && (this.opts.config.regimeOverlay || this.opts.config.pitUniverse)) {
      const needed = this.decisionSymbols(existing.asOf, existing.memory, existing.session);
      symbols.push(...needed.all, ...needed.required);
    }
    const view = this.opts.openPriceView(existing.asOf, symbols);
    // A sell already refused for held shares: look for the incumbent's stops again (idempotent; a cancel that
    // failed or never confirmed last tick is the usual cause).
    if (existing.orders.some(o => !o.applied && !o.skipped && (o.attempts ?? 0) > 0)) await this.releaseIncumbentStops();
    const target: TargetBook = { asOf: existing.asOf, weights: existing.weights, stops: existing.stops, memory: existing.memory, diagnostics: existing.diagnostics };
    return await this.submitAndSettle(key, existing.asOf, existing.orders, view, target, existing.equity, "resumed", "resumed after restart");
  }

  /** Submit every pending order (sells first — planOrders' order), apply each
   *  fill to the rows, persist progress after each. A sell refused only because its shares are still
   *  held (isRetryableSellRejection) stays UNAPPLIED with the same client order id, up to
   *  `maxSellAttempts` per session, and the buys behind it wait (sells fund and precede buys); at the cap
   *  it becomes a terminal rejection like any other. */
  private async submitAll(key: { accountId: string; strategyVersion: string; session: SessionDate }, orders: PersistedOrder[], view: EnginePriceView): Promise<SubmitOutcome> {
    const rejected: PersistedOrder[] = [];
    const maxAttempts = this.opts.maxSellAttempts ?? DEFAULT_MAX_SELL_ATTEMPTS;
    let retrying = 0;
    let sellRetrying = false;
    for (const o of orders) {
      if (o.applied || o.skipped) continue;
      if (o.intent.side === "buy" && !this.tradingEnabled()) {
        o.skipped = "trading_disabled";
        this.log.warn(`TRADING_ENABLED=false — buy ${o.intent.symbol} not submitted (sells unaffected)`);
        updatePortfolioDecisionProgress(key, { orders }, this.now());
        continue;
      }
      if (o.intent.side === "buy" && sellRetrying) {
        retrying++; // not submitted, not counted as an attempt: it goes once the sells settle
        continue;
      }
      if (o.intent.maxHold === "rebuy" && loadSleeveRows(this.opts.accountId).some(r => r.symbol === o.intent.symbol && r.quantity > 0)) {
        // Rejected/partial close: never blend a fresh buy into the expired lot or double the exposure.
        o.skipped = "max_hold_close_incomplete";
        updatePortfolioDecisionProgress(key, { orders }, this.now());
        continue;
      }
      const clientOrderId = o.clientOrderId ?? portfolioClientOrderId(key.accountId, key.session, o.intent.symbol, o.intent.maxHold);
      o.clientOrderId = clientOrderId;
      if (this.stockMarketClosed()) {
        updatePortfolioDecisionProgress(key, { orders, note: "stock market closed; pending orders not submitted" }, this.now());
        return { rejected, retrying, marketClosed: true };
      }
      let result;
      try {
        result = await this.opts.venue.submit(o.intent, clientOrderId);
      } catch (e: any) {
        // Outcome unknown (transport): leave it unapplied — the next tick
        // resubmits the SAME id and the venue returns the existing order.
        o.result = { ok: false, filledQty: 0, avgPrice: null, status: "unknown", error: String(e?.message ?? e) };
        updatePortfolioDecisionProgress(key, { orders, note: `order ${o.intent.symbol} outcome unknown: ${o.result.error}` }, this.now());
        throw e;
      }
      if (isRetryableSellRejection(o.intent, result)) {
        o.attempts = (o.attempts ?? 0) + 1;
        if (o.attempts < maxAttempts) {
          o.result = result;
          retrying++;
          sellRetrying = true;
          this.log.warn(`sell ${o.intent.symbol} ${o.intent.qty}: shares still held (${result.error}) — attempt ${o.attempts}/${maxAttempts}, retried next tick with the same client order id`);
          updatePortfolioDecisionProgress(key, { orders }, this.now());
          continue; // stays unapplied
        }
        result = { ...result, error: `${result.error} — gave up after ${o.attempts} attempts this session` };
      }
      o.result = result;
      if (result.filledQty > 0) o.filledAt ??= this.now();
      if (result.filledQty > 0 && result.avgPrice !== null && result.avgPrice > 0) {
        if (o.intent.side === "buy") applyBuyFill(this.rows, o.intent.symbol, result.filledQty, result.avgPrice, this.now());
        else applySellFill(this.rows, o.intent.symbol, result.filledQty, result.avgPrice,
          { nowMs: this.now(), ...(o.intent.maxHold === "close" ? { closeReason: MAX_HOLD_CLOSE_REASON } : {}) });
        if (result.filledQty < o.intent.qty * (1 - (this.opts.qtyTolerance ?? DEFAULT_QTY_TOLERANCE))) {
          this.log.warn(`${o.intent.side} ${o.intent.symbol}: partial fill ${result.filledQty}/${o.intent.qty} (${result.status})`);
        } else {
          this.log.info(`${o.intent.side} ${o.intent.symbol}: filled ${result.filledQty} @ ${result.avgPrice}`);
        }
      } else if (result.filledQty > 0) {
        // Filled but no price from the venue: mark at the last close rather
        // than lose the row (the venue reports this as an error string).
        const px = view.lastClose(o.intent.symbol) ?? 0;
        if (px > 0) {
          if (o.intent.side === "buy") applyBuyFill(this.rows, o.intent.symbol, result.filledQty, px, this.now());
          else applySellFill(this.rows, o.intent.symbol, result.filledQty, px,
            { nowMs: this.now(), ...(o.intent.maxHold === "close" ? { closeReason: MAX_HOLD_CLOSE_REASON } : {}) });
          this.log.error(`${o.intent.side} ${o.intent.symbol}: fill ${result.filledQty} without a price — row marked at last close ${px}`);
        }
      }
      if (!result.ok) {
        rejected.push(o);
        this.log.warn(`${o.intent.side} ${o.intent.symbol} ${o.intent.qty}: NOT filled (${result.status}${result.error ? `: ${result.error}` : ""})`);
      }
      o.applied = true;
      updatePortfolioDecisionProgress(key, { orders }, this.now());
    }
    return { rejected, retrying };
  }

  /** After the fills (README "Calling the core"): re-decide on the ACTUAL
   *  positions with the same view/session and the first call's memory,
   *  persist THAT memory (stop levels from the real average entry) and make
   *  the venue's stops match. Never a second rebalance. */
  private async refreshStops(key: { accountId: string; strategyVersion: string; session: SessionDate }, view: EnginePriceView, target: TargetBook, equity: number, persistMemory = true): Promise<void> {
    const positions = positionsFromRows(loadSleeveRows(this.opts.accountId), this.hasMaxHold());
    const refreshed = this.decideFn({
      view, membership: this.opts.membership, config: this.opts.config, executionSession: key.session,
      book: { equity, positions, memory: target.memory },
    });
    const stops: readonly StopLevel[] = refreshed.stops;
    // While orders are still being retried the stored memory stays the FIRST call's: the next tick refreshes
    // again from it, so the core is only ever advanced once per session (README "Calling the core").
    updatePortfolioDecisionProgress(key, persistMemory ? { memory: refreshed.memory, stops } : { stops }, this.now());
    if (!this.opts.venue.syncStops) {
      if (stops.length > 0) this.alertFn(`Portfolio:${this.opts.accountId}`, `${this.opts.accountId}: design declares ${stops.length} stop(s) but venue ${this.opts.venue.venue} has no syncStops — positions unprotected`);
      return;
    }
    if (stops.length === 0 && !this.hasDesignStops()) return; // nothing to keep in sync
    try {
      await this.opts.venue.syncStops(stops, positions);
    } catch (e: any) {
      this.alertFn(`Portfolio:${this.opts.accountId}`, `${this.opts.accountId}: syncStops failed (${e?.message ?? e}) — ${stops.length} stop(s) may be missing at the venue`);
    }
  }

  private async referencePrices(symbols: readonly string[], view: EnginePriceView, brokerPositions: readonly Position[]): Promise<Record<string, number>> {
    let venuePrices: Record<string, number> = {};
    try {
      venuePrices = await this.opts.venue.prices(symbols);
    } catch (e: any) {
      this.log.warn(`venue prices unavailable (${e?.message ?? e}) — falling back to last closes`);
    }
    const out: Record<string, number> = {};
    const missing: string[] = [];
    for (const s of symbols) {
      const px = venuePrices[s];
      if (Number.isFinite(px) && px > 0) { out[s] = px; continue; }
      const close = view.lastClose(s);
      if (close !== null && close > 0) { out[s] = close; missing.push(s); continue; }
      const held = brokerPositions.find(p => p.symbol === s);
      if (held && held.avgEntryPrice > 0) out[s] = held.avgEntryPrice;
    }
    if (missing.length > 0) this.log.warn(`no venue price for ${missing.join(", ")} — using last close`);
    return out;
  }
}
