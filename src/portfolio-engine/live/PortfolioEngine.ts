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
import type {
  BookState, MembershipView, OrderIntent, PlanOrders, PortfolioStrategyConfig, Position, PriceView, SessionDate,
  StopLevel, TargetBook, VenueAdapter, VenueRules,
} from "../types";
import { computeSleeveLedger } from "../../account/EquityTracker";
import { isTradingEnabled } from "../../config";
import { insertActivity } from "../../db/database";
import { createLogger } from "../../utils/logger";
import { eventBus, EVENTS } from "../../utils/events";
import { heartbeats as defaultHeartbeats } from "../../ops/heartbeat";
import { portfolioClientOrderId } from "./clientOrderId";
import type { FreshnessReport } from "./priceView";
import {
  getPortfolioDecision, latestPortfolioMemory, savePortfolioDecision, updatePortfolioDecisionProgress,
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
  /** Tick cadence of start() (ms). */
  tickMs?: number;
  /** Consecutive failed passes before one page per session. */
  failPageAfter?: number;
}

export type RunStatus = "not_due" | "already_done" | "skipped_stale" | "observed" | "submitted" | "resumed" | "failed";

export interface PortfolioRunReport {
  status: RunStatus;
  session?: SessionDate;
  asOf?: SessionDate;
  orders: PersistedOrder[];
  rejected: number;
  note?: string;
}

const DEFAULT_QTY_TOLERANCE = 1e-6;

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
    const window = runWindow(this.opts.market, this.now());
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

  async runSession(window: RunWindow): Promise<PortfolioRunReport> {
    const { session, asOf } = window;
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

  private decisionSymbols(asOf: SessionDate, memory: Readonly<Record<string, unknown>>): { all: string[]; required: string[] } {
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
    return { all: [...cfg.universe], required: [...cfg.universe] };
  }

  private hasDesignStops(): boolean {
    const cfg = this.opts.config;
    return cfg.kind === "cryptoTrend" && cfg.stop.mode !== "none";
  }

  private async decideAndExecute(window: RunWindow): Promise<PortfolioRunReport> {
    const { session, asOf } = window;
    const live = this.opts.mode === "live";
    const key = { accountId: this.opts.accountId, strategyVersion: this.opts.strategyVersion, session };
    const memory = latestPortfolioMemory(key.accountId, key.strategyVersion);
    const symbols = this.decisionSymbols(asOf, memory);

    // 2. data freshness
    const rowsBefore = loadSleeveRows(this.opts.accountId);
    const heldSymbols = rowsBefore.map(r => r.symbol);
    const view = this.opts.openPriceView(asOf, [...new Set([...symbols.all, ...heldSymbols])]);
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
    const positions = positionsFromRows(rows);
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
    const orders: PersistedOrder[] = intents.map(intent => ({
      intent, clientOrderId: live ? portfolioClientOrderId(this.opts.accountId, session, intent.symbol) : null,
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

    // 6. submit
    const rejected = await this.submitAll(key, orders, view);
    // 7. stops on the actual book
    await this.refreshStops(key, view, target, ledger.equity);
    updatePortfolioDecisionProgress(key, { status: "submitted", orders }, this.now());
    if (rejected > 0) {
      this.alertFn(`Portfolio:${this.opts.accountId}`,
        `${this.opts.accountId} ${session}: ${rejected} order(s) rejected — ${orders.filter(o => o.result && !o.result.ok).map(o => `${o.intent.side} ${o.intent.symbol}: ${o.result?.error ?? o.result?.status}`).join("; ")}`);
    }
    return { status: "submitted", session, asOf, orders, rejected };
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
      const released = await this.opts.venue.releaseLegacyStops(symbols);
      if (released.length > 0) {
        insertActivity(this.opts.accountId, "system", `portfolio engine released ${released.length} incumbent stop order(s) on adopted rows: ${released.join(", ")}`);
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
    const view = this.opts.openPriceView(existing.asOf, symbols);
    const rejected = await this.submitAll(key, existing.orders, view);
    const target: TargetBook = { asOf: existing.asOf, weights: existing.weights, stops: existing.stops, memory: existing.memory, diagnostics: existing.diagnostics };
    await this.refreshStops(key, view, target, existing.equity);
    updatePortfolioDecisionProgress(key, { status: "submitted", orders: existing.orders, note: "resumed after restart" }, this.now());
    return { status: "resumed", session: existing.session, asOf: existing.asOf, orders: existing.orders, rejected };
  }

  /** Submit every pending order (sells first — planOrders' order), apply each
   *  fill to the rows, persist progress after each. Returns the rejection count. */
  private async submitAll(key: { accountId: string; strategyVersion: string; session: SessionDate }, orders: PersistedOrder[], view: EnginePriceView): Promise<number> {
    let rejected = 0;
    for (const o of orders) {
      if (o.applied || o.skipped) continue;
      if (o.intent.side === "buy" && !this.tradingEnabled()) {
        o.skipped = "trading_disabled";
        this.log.warn(`TRADING_ENABLED=false — buy ${o.intent.symbol} not submitted (sells unaffected)`);
        updatePortfolioDecisionProgress(key, { orders }, this.now());
        continue;
      }
      const clientOrderId = o.clientOrderId ?? portfolioClientOrderId(key.accountId, key.session, o.intent.symbol);
      o.clientOrderId = clientOrderId;
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
      o.result = result;
      if (result.filledQty > 0 && result.avgPrice !== null && result.avgPrice > 0) {
        if (o.intent.side === "buy") applyBuyFill(this.rows, o.intent.symbol, result.filledQty, result.avgPrice, this.now());
        else applySellFill(this.rows, o.intent.symbol, result.filledQty, result.avgPrice, { nowMs: this.now() });
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
          else applySellFill(this.rows, o.intent.symbol, result.filledQty, px, { nowMs: this.now() });
          this.log.error(`${o.intent.side} ${o.intent.symbol}: fill ${result.filledQty} without a price — row marked at last close ${px}`);
        }
      }
      if (!result.ok) {
        rejected++;
        this.log.warn(`${o.intent.side} ${o.intent.symbol} ${o.intent.qty}: NOT filled (${result.status}${result.error ? `: ${result.error}` : ""})`);
      }
      o.applied = true;
      updatePortfolioDecisionProgress(key, { orders }, this.now());
    }
    return rejected;
  }

  /** After the fills (README "Calling the core"): re-decide on the ACTUAL
   *  positions with the same view/session and the first call's memory,
   *  persist THAT memory (stop levels from the real average entry) and make
   *  the venue's stops match. Never a second rebalance. */
  private async refreshStops(key: { accountId: string; strategyVersion: string; session: SessionDate }, view: EnginePriceView, target: TargetBook, equity: number): Promise<void> {
    const positions = positionsFromRows(loadSleeveRows(this.opts.accountId));
    const refreshed = this.decideFn({
      view, membership: this.opts.membership, config: this.opts.config, executionSession: key.session,
      book: { equity, positions, memory: target.memory },
    });
    const stops: readonly StopLevel[] = refreshed.stops;
    updatePortfolioDecisionProgress(key, { memory: refreshed.memory, stops }, this.now());
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
