// ══════════════════════════════════════════════
// Alpaca Momentum Adapter (v8 — stocks sleeve)
// ══════════════════════════════════════════════
//
// Mirrors BinanceMomentumAdapter for the stocks sleeve. Opens/closes via
// AlpacaExecutor market orders, persists trades rows under "momentum_stocks".
// No leverage, no broker-native SL — AccountManager.checkAllStopLoss (15s)
// enforces the 4% hard stop.
//
// The engine feeds on 5Min bars: the stocks config maps "days" to trading
// sessions via barMinutesEq = (24*60)/78 (78 five-minute bars per session),
// so lookbackDays etc. mean TRADING days. index.ts only ticks this engine
// while the market is open.

import type { MomentumBrokerAdapter } from "./MomentumEngine";
import { MODEL_CUTOVER_CLOSE_REASON, SLOT_DISPLACED_CLOSE_REASON, TIME_STOP_CLOSE_REASON, TRAIL_STOP_CLOSE_REASON } from "./MomentumEngine";
import type { CurrentPosition } from "./Rebalancer";
import type { OHLCV, Signal } from "../../utils/types";
import type { AlpacaExecutor } from "../../executor/alpaca-executor";
import { isUnknownOrder } from "../../executor/executionPolicy";
import {
  getDB, insertTrade, closeTrade, updateTradeCloseReason, getOpenTrades, getTradingStats,
  insertSignal, insertOrder, recordFill, RECONCILE_CLOSE_SQL, getETDayStart, getETDateKey,
} from "../../db/database";
import { computeSleeveLedger, buildSleevePriceMap } from "../../account/EquityTracker";
import { RISK_PROFILES, type RiskProfileId } from "../../config/riskProfiles";
import { createLogger } from "../../utils/logger";
import { eventBus, EVENTS } from "../../utils/events";
import { isMarketOpen } from "../../utils/marketHours";
import { v4 as uuid } from "uuid";

const log = createLogger("AlpacaMomentumAdapter");

// Bar-duration lookup for the timeframes this adapter is actually configured
// with (momentum_stocks: "5Min", meanrev_stocks: "1Day"). Falls back to 5Min.
const STOCK_TF_MINUTES: Record<string, number> = { "1Min": 1, "5Min": 5, "15Min": 15, "1Hour": 60, "1Day": 1440 };

// Canonical engine-driven close labels this adapter persists VERBATIM on
// trades.close_reason (telemetry: a TRAIL_STOP exit must be distinguishable
// from a signal-flip MOMENTUM_REBALANCE — both were previously recorded as
// the latter). Anything else (or absent) falls back to the configured
// rebalance label, so free-text can never land in the enum-ish column.
const ENGINE_CLOSE_REASONS: ReadonlySet<string> = new Set([TRAIL_STOP_CLOSE_REASON, TIME_STOP_CLOSE_REASON, SLOT_DISPLACED_CLOSE_REASON, MODEL_CUTOVER_CLOSE_REASON]);

export interface AlpacaMomentumAdapterConfig {
  accountId: string;
  /** Bar timeframe for fetchCandles (Alpaca format: "5Min", "1Day", …). */
  timeframe: string;
  /** Strategy label written on trades rows (and used to filter queries). */
  strategy: string;
  /** close_reason written on engine-driven closes. */
  closeReason: string;
  /** OPT-IN (daily-horizon momentum_stocks wiring only): strip TODAY's
   *  still-forming daily bar from fetchCandles' "1Day" path. MeanRevEngine
   *  does this strip itself (fetchCandles must NOT double-drop for it —
   *  see the fetchCandles docstring), but MomentumEngine has no such strip:
   *  without this flag a daily momentum engine would rank on a partial
   *  session, breaking replay parity (the simulator only ever sees CLOSED
   *  daily bars). Absent/false = previous behavior, byte-identical. */
  dropTodayDailyBar?: boolean;
}

export const DEFAULT_ALPACA_ADAPTER_CONFIG: AlpacaMomentumAdapterConfig = {
  accountId: "momentum_stocks",
  timeframe: "5Min",
  strategy: "MOMENTUM",
  closeReason: "MOMENTUM_REBALANCE",
};

export class AlpacaMomentumAdapter implements MomentumBrokerAdapter {
  private cfg: AlpacaMomentumAdapterConfig;

  constructor(
    private alpaca: AlpacaExecutor,
    cfg: Partial<AlpacaMomentumAdapterConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_ALPACA_ADAPTER_CONFIG, ...cfg };
  }

  /**
   * INVARIANT — read-for-exposure vs read-for-management (two different
   * questions, two different predicates, kept deliberately in sync):
   *
   *  - getOpenPositions() answers "do I already have exposure in this
   *    symbol?" and is ACCOUNT-scoped only (no `strategy` filter). Narrowing
   *    it would make the engine blind to a row this account already holds
   *    under a different strategy label (e.g. an AccountManager-adopted
   *    SYNC_RECOVERY row — see closePosition below) and it would OPEN A
   *    DUPLICATE on top of it. Do not add a strategy filter here.
   *  - closePosition()/markDbClosedNoFill() answer "is this row mine to
   *    manage/close?" and use `strategy IN (this.cfg.strategy,
   *    'SYNC_RECOVERY')` — every row under our own account_id is either
   *    opened by this adapter or adopted FOR this sleeve by AccountManager's
   *    orphan-recovery path (AccountManager.ts ~1631-1641); both are ours.
   *
   * Every row this read reports as exposure must be closable by that write
   * predicate, or the engine re-issues a close forever against a row it can
   * never persist — the historical stuck-trade bug class. Mirrors
   * BinanceMomentumAdapter's identical `strategy IN (...)` widening.
   */
  async getOpenPositions(): Promise<Array<CurrentPosition & { entryTime: number }>> {
    // DB open trades for this sleeve (the DB follows the broker via the sync
    // loops; reading DB here avoids symbol-format mismatch on Alpaca).
    // entryTime rides along for engines with time-based exits (meanrev).
    const out: Array<CurrentPosition & { entryTime: number }> = [];
    for (const t of getOpenTrades(this.cfg.accountId)) {
      const current = this.alpaca.getCachedPrice(t.symbol) || t.entryPrice;
      out.push({
        symbol: t.symbol,
        side: t.side as "buy" | "sell",
        quantity: t.quantity,
        notional: t.quantity * current,
        entryTime: t.entryTime,
      });
    }
    return out;
  }

  async getEquity(): Promise<number> {
    // SLEEVE ledger, NOT the whole Alpaca account: the wallet is shared by
    // momentum_stocks + meanrev_stocks, so sizing on account equity would let
    // one sleeve silently consume the other's capital (observed live: 4 × 25k
    // slots ≈ the entire 101k account). equity = initial allocation +
    // realized (this sleeve's closed trades) + unrealized (its open DB rows).
    const initial = RISK_PROFILES[this.cfg.accountId as RiskProfileId]?.initialEquity ?? 0;
    const open = getOpenTrades(this.cfg.accountId);
    const prices = await buildSleevePriceMap(this.alpaca, open);
    const realized = getTradingStats(this.cfg.accountId).totalPnl;
    return computeSleeveLedger(initial, realized, open, s => prices.get(s) ?? 0).equity;
  }

  async getRealisedPnlSince(epochMs: number): Promise<number> {
    // A DB read failure must never look like "no pnl" — it feeds
    // RiskGuard.recordRebalanceOutcome (MomentumEngine.ts), which persists
    // loss-streak state; a fabricated 0 there is a silent flat period that
    // can hide a real streak. Propagate so the caller freezes instead.
    try {
      const row = getDB().prepare(
        `SELECT COALESCE(SUM(pnl), 0) net
         FROM trades
         WHERE account_id = ? AND status = 'closed' AND exit_time > ?
           AND strategy = ? AND ${RECONCILE_CLOSE_SQL}`
      ).get(this.cfg.accountId, epochMs, this.cfg.strategy) as any;
      return row?.net ?? 0;
    } catch (e: any) {
      log.error(`getRealisedPnlSince query failed for ${this.cfg.accountId}: ${e.message}`);
      throw e;
    }
  }

  async openPosition(action: { symbol: string; side: "buy" | "sell"; notionalUsd: number; stopLossPct?: number }): Promise<{ ok: boolean; reason?: string }> {
    if (!this.alpaca.isConnected()) return { ok: false, reason: "alpaca not connected" };

    let price = this.alpaca.getCachedPrice(action.symbol);
    if (price <= 0) price = await this.alpaca.getLatestPrice(action.symbol);
    // Sparse-IEX-tape fallback for the SHARE COUNT only (market order):
    // the last trade within 5 min — see AlpacaExecutor.getSizingPrice.
    if (price <= 0 && typeof this.alpaca.getSizingPrice === "function") price = await this.alpaca.getSizingPrice(action.symbol);
    if (price <= 0) return { ok: false, reason: `no price for ${action.symbol}` };


    const qty = Math.floor(action.notionalUsd / price);
    if (qty <= 0) return { ok: false, reason: "computed qty < 1 share" };

    const signal: Signal = {
      id: uuid(),
      symbol: action.symbol,
      market: "stock",
      side: action.side,
      strategy: this.cfg.strategy as any,
      strength: "strong" as any,
      price,
      timestamp: Date.now(),
      indicators: { _score: 100 } as Record<string, number>, // synthetic; engine already gated
      reason: `${this.cfg.strategy.toLowerCase()} target`,
    };
    const submittedAt = Date.now();
    try { insertSignal(signal, this.cfg.accountId); }
    catch (e: any) { log.warn(`signal telemetry failed for ${action.symbol}: ${e.message}`); }

    // Shared-account guard (2026-08-20): the sleeve "division" is a DB
    // ledger — sizing reads THIS sleeve's own wallet (getEquity above) and
    // cannot see the other sleeve's live exposure on the ONE real Alpaca
    // account, nor manual/orphan shares living there. The broker's Reg-T
    // buying power is the only cross-sleeve truth, so mirror it pre-submit
    // and block the entry with a terminal-classifiable reason (matches
    // TERMINAL_ACTION_SUBSTRINGS in MeanRevEngine — the broker 403's detail
    // dies inside the executor and used to arrive here as an unmatchable
    // "placeOrder returned null"). This blocks ONLY orders the broker would
    // reject anyway — it is an operational mirror, not a new risk constant.
    // bp === null (unreadable) FAILS OPEN: the broker stays the real
    // enforcer; a transient getAccount error must not freeze entries.
    // Entries only by construction — closes/stops never pass through here.
    const regtBp = await this.alpaca.getRegTBuyingPower();
    if (regtBp !== null && action.notionalUsd > regtBp) {
      const reason = `insufficient_buying_power (shared Alpaca account): need $${action.notionalUsd.toFixed(0)}, Reg-T buying power $${regtBp.toFixed(0)} — blocked pre-submit`;
      log.warn(`OPEN blocked for ${action.symbol} (${this.cfg.accountId}): ${reason}`);
      try {
        insertOrder({
          id: `rejected_${signal.id}`, symbol: action.symbol, market: "stock", side: action.side,
          type: "market", quantity: qty, price, status: "rejected", signal,
          createdAt: submittedAt, updatedAt: Date.now(),
        }, this.cfg.accountId);
      } catch (e: any) { log.warn(`rejected-order telemetry failed for ${action.symbol}: ${e.message}`); }
      return { ok: false, reason };
    }

    // TASK 2 idempotency: meanrev_stocks (1Day timeframe) means at most one
    // entry per (sleeve, symbol, ET trading day) — pass the ET day start so
    // placeOrder derives a DETERMINISTIC client_order_id and a second
    // submission (our own persistence failing, a restart, a stale broker
    // position read — all three happened live) is rejected by Alpaca itself
    // instead of doubling the position. momentum_stocks (5Min, rebalances
    // several times/day) legitimately re-enters the same symbol same-day, so
    // it keeps the unique-suffix default from placeOrder.
    const tfMin = STOCK_TF_MINUTES[this.cfg.timeframe] ?? 5;
    const idempotencyOpts = tfMin >= 1440 ? { entryDayKey: getETDayStart() } : {};
    const order = await this.alpaca.placeOrder(signal, qty, this.cfg.accountId, idempotencyOpts);
    if (isUnknownOrder(order)) {
      // NautilusTrader outcome taxonomy: the order's fate is UNKNOWN (it may
      // be live on the books). NOT a rejection — no rejected-order telemetry,
      // no flatten, and above all NO resend: BrokerSync/AccountManager's
      // reconciliation adopts the position if the order actually filled.
      log.error(`openPosition ${action.symbol}: order outcome UNKNOWN (${order.reason}) — in flight, resolving via reconciliation; NOT retried`);
      return { ok: false, reason: `order outcome unknown (in flight): ${order.reason}` };
    }
    if (!order) {
      try {
        insertOrder({
          id: `rejected_${signal.id}`, symbol: action.symbol, market: "stock", side: action.side,
          type: "market", quantity: qty, price, status: "rejected", signal,
          createdAt: submittedAt, updatedAt: Date.now(),
        }, this.cfg.accountId);
      } catch (e: any) { log.warn(`rejected-order telemetry failed for ${action.symbol}: ${e.message}`); }
      return { ok: false, reason: "alpaca.placeOrder returned null" };
    }
    // DECISION price (known before placeOrder was ever called), NOT
    // order.submittedPx (the quote AT submission — see recordFill/database.ts
    // slippage_bps: expected_px vs submitted_px must be two independent
    // reads, not the same value twice, or slippage_bps is always ~0).
    const expectedPx = price;

    let filledPrice = order.filledPrice ?? 0;
    let filledQty = order.filledQty ?? 0;

    // If the order wasn't immediately and fully filled, poll until terminal.
    // PARTIALLY_FILLED orders cancel the remainder and fetch the real filled
    // amount so we never persist the full requested qty.
    if (order.status === "partial" || !filledPrice || filledQty <= 0) {
      if (!order.externalId) {
        return { ok: false, reason: "no external order id" };
      }
      const result = await this.alpaca.pollOrderUntilFilled(order.externalId, 30_000);
      if (result.status !== "filled" || !result.filledPrice || !(result.filledQty ?? 0)) {
        try { insertOrder({ ...order, status: "rejected", createdAt: order.createdAt ?? submittedAt, updatedAt: Date.now() }, this.cfg.accountId); }
        catch (e: any) { log.warn(`unfilled-order telemetry failed for ${action.symbol}: ${e.message}`); }
        const reconciliation = await this.flattenAndConfirm(action.symbol, result.filledQty ?? 0);
        return { ok: false, reason: `order not filled (${result.status}); ${reconciliation}` };
      }
      filledPrice = result.filledPrice;
      filledQty = result.filledQty!;
      order.filledAt = result.filledAt;
    }

    if (!(filledQty >= 1)) {
      return { ok: false, reason: `insufficient fill (${filledQty})` };
    }

    if (!filledPrice) filledPrice = price;

    const filledAt = order.filledAt ?? Date.now();
    try {
      insertOrder({
        ...order, symbol: action.symbol, market: "stock", side: action.side, type: order.type ?? "market",
        quantity: filledQty, price: order.price ?? price, signal, status: "filled", filledPrice, filledAt,
        createdAt: order.createdAt ?? submittedAt, updatedAt: Date.now(),
      }, this.cfg.accountId);
       if (expectedPx && order.submittedPx && order.submittedPx > 0) recordFill({
         tradeId: order.id, orderId: order.externalId ?? order.id, accountId: this.cfg.accountId,
         symbol: action.symbol, side: action.side, market: "stock",
         expectedPx, submittedPx: order.submittedPx, filledPx: filledPrice,
         filledQty, fillTime: filledAt, latencyMs: Math.max(0, filledAt - (order.submittedAt ?? submittedAt)), broker: "alpaca",
         estPx: order.estPx,
       });
    } catch (e: any) { log.warn(`fill telemetry failed for ${action.symbol}: ${e.message}`); }

    // Engine-computed vol-scaled stop (openPosition.stopLossPct): derive the
    // stop PRICE from the REAL fill (not the decision price) and persist it
    // on the row — AccountManager's 15s loop and ensureAlpacaNativeStops
    // honor trades.stop_loss over the profile's fixed pct. Absent (engines
    // without volStop, Binance sleeves) → NULL → legacy profile distance.
    const stopLossPrice = action.stopLossPct !== undefined && action.stopLossPct > 0
      ? (action.side === "buy"
        ? filledPrice * (1 - action.stopLossPct / 100)
        : filledPrice * (1 + action.stopLossPct / 100))
      : undefined;

    const persist = await this.persistFillOrReconcile(order.id, action, filledPrice, filledQty, stopLossPrice);
    if (!persist.ok) return persist;

    // Telegram/dashboard: adapters are the only open path in v8 (2026-07-11 fix).
    eventBus.emit(EVENTS.ORDER_FILLED, {
      accountId: this.cfg.accountId, symbol: action.symbol, side: action.side,
      quantity: filledQty, filledPrice, market: "stock", strategy: this.cfg.strategy,
    });
    return { ok: true };
  }

  /**
   * Persist the trade row for a JUST-FILLED position — reconcile if it can't.
   *
   * The DB row is the RECORD of a real broker position, NOT best-effort:
   * getOpenPositions reads the DB, so a missing row makes the engine RE-OPEN the
   * same symbol next tick (a doubled real position, unmanaged by the sleeve's
   * checkAllStopLoss 4% stop). On persist failure we log.error + page
   * (ERROR_BURST), retry ONCE, and if it still fails EMERGENCY-CLOSE the
   * just-opened position — a position we can't record is worse than none, so we
   * reconcile toward flat. If the emergency close ALSO fails, log a loud ORPHAN
   * line for manual reconcile.
   */
  private async persistFillOrReconcile(
    orderId: string,
    action: { symbol: string; side: "buy" | "sell" },
    filledPrice: number,
    filledQty: number,
    stopLossPrice?: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    const tradeRow = {
      id: orderId,
      symbol: action.symbol,
      market: "stock",
      side: action.side,
      strategy: this.cfg.strategy as any,
      entryPrice: filledPrice,
      quantity: filledQty,
      entryTime: Date.now(),
      status: "open",
      // Vol-scaled stop PRICE (see openPosition) — insertTrade maps this to
      // trades.stop_loss; undefined persists NULL (legacy fixed distance).
      stopLoss: stopLossPrice,
    };
    if (this.tryInsert(tradeRow)) return { ok: true };

    log.error(`insertTrade FAILED after a real fill (${action.symbol} qty ${filledQty}) — paging + retrying once`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "AlpacaMomentumAdapter",
      message: `DB persist failed after real fill: ${action.symbol} qty ${filledQty} — reconciling`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
    if (this.tryInsert(tradeRow)) return { ok: true };

    // Retry failed → the position is live on the broker with no DB record.
    // Close exactly OUR fill's qty — the aggregate may include shares that
    // aren't ours (manual, or the other sleeve on this shared wallet).
    const closed = await this.alpaca.closePosition(action.symbol, action.side, filledQty);
    if (closed.success && closed.filledPrice > 0) {
      log.error(`Emergency close OK for ${action.symbol} — reconciled to flat (no orphan)`);
      return { ok: false, reason: "db_persist_failed_position_closed" };
    }
    log.error(`🚨 ORPHAN POSITION ${action.symbol} qty ${filledQty} — MANUAL RECONCILE (broker holds it; DB write AND emergency close both failed: ${closed.reason ?? "unknown"})`);
    return { ok: false };
  }

  private tryInsert(tradeRow: any): boolean {
    try {
      insertTrade(tradeRow as any, this.cfg.accountId);
      return true;
    } catch (e: any) {
      log.warn(`insertTrade threw for ${tradeRow.symbol}: ${e?.message ?? e}`);
      return false;
    }
  }

  /** Never leave an accepted-but-unrecordable partial position behind.
   *  Closes only `partialQty` (what OUR cancelled order actually filled) —
   *  a qty-less close would liquidate the rest of the aggregate too (manual
   *  shares, or the other sleeve on this shared wallet).
   *  partialQty <= 0 means nothing of ours filled: don't touch the broker. */
  private async flattenAndConfirm(symbol: string, partialQty: number): Promise<string> {
    let flattened = false;
    if (partialQty > 0) {
      try {
        const close = await this.alpaca.closePosition(symbol, undefined, partialQty);
        flattened = close.success && close.filledPrice > 0;
      } catch (e: any) {
        log.warn(`partial-position flatten failed for ${symbol}: ${e?.message ?? e}`);
      }
    }
    try {
      const positions = await this.alpaca.getPositions?.();
      const stillOpen = positions?.some((p: any) => p.symbol === symbol || p.symbol.replace?.("/", "") === symbol.replace("/", ""));
      if (stillOpen === false) return flattened ? "partial position flattened and confirmed flat" : "partial position confirmed flat";
      return "partial position reconciliation pending";
    } catch (e: any) {
      log.error(`🚨 PARTIAL POSITION ${symbol} — flatten unconfirmed: ${e?.message ?? e}`);
      return "partial position flatten unconfirmed";
    }
  }

  async closePosition(action: { symbol: string; side: "buy" | "sell"; closeReason?: string }): Promise<{ ok: boolean; reason?: string }> {
    if (!this.alpaca.isConnected()) return { ok: false, reason: "alpaca not connected" };
    // TRAIL_STOP (or a future canonical label) from the engine; default flip label otherwise.
    const closeReason = action.closeReason && ENGINE_CLOSE_REASONS.has(action.closeReason)
      ? action.closeReason
      : this.cfg.closeReason;

    // Ownership check BEFORE any broker mutation — mirrors
    // BinanceMomentumAdapter.closePosition. Only a row of OURS authorizes
    // closing anything, and only for the RECORDED quantity: the Alpaca book
    // is the account's AGGREGATE (this sleeve + meanrev_stocks on the shared
    // wallet + any manual shares), and a qty-less close liquidated the part
    // that wasn't ours.
    // Ownership predicate: see the invariant comment on getOpenPositions().
    // Also matches SYNC_RECOVERY rows — an orphan adopted FOR this sleeve
    // (AccountManager.ts ~1631-1641) is the same real position, opened via
    // the adoption path instead of openPosition().
    let row: any;
    try {
      row = getDB().prepare(
        `SELECT id, entry_price, quantity, side FROM trades
         WHERE account_id = ? AND symbol = ? AND status = 'open' AND strategy IN (?, 'SYNC_RECOVERY')
         ORDER BY entry_time DESC LIMIT 1`
      ).get(this.cfg.accountId, action.symbol, this.cfg.strategy) as any;
    } catch (e: any) {
      return { ok: false, reason: `DB ownership lookup failed: ${e.message}` };
    }
    if (!row) {
      return { ok: false, reason: "no open DB trade for this sleeve — refusing to touch the aggregate broker position" };
    }

    // Fill-telemetry benchmark for the EXIT: a quote-touch TRADE price,
    // captured BEFORE the close order is sent — mirrors BinanceMomentumAdapter.
    // `closeSide` is the CLOSING order's side (opposite of the held
    // position: closing a long sells at the bid). Without this, exits
    // recorded expectedPx == result.submittedPx by construction, so
    // decision→fill slippage on exits was never actually measured. Falls
    // back to that same old behavior (expected = submitted) when no fresh
    // quote is available — getExecutableQuote is absent on some older test
    // stubs, tolerated via the typeof check.
    const closeSide: "buy" | "sell" = action.side === "buy" ? "sell" : "buy";
    let preCloseExpectedPx: number | undefined;
    if (typeof (this.alpaca as any).getExecutableQuote === "function") {
      try {
        const quote = await this.alpaca.getExecutableQuote(action.symbol, closeSide);
        if (quote && quote.price > 0) preCloseExpectedPx = quote.price;
      } catch (e: any) { log.debug(`pre-close quote fetch failed for ${action.symbol}: ${e.message}`); }
    }

    // The executor bounds the actual close to min(row.quantity, brokerQty).
    // accountId rides along so an (opt-in) exit execution policy for this
    // sleeve can apply; with none configured this is a no-op (market close).
    const result = await this.alpaca.closePosition(action.symbol, action.side, row.quantity, { accountId: this.cfg.accountId });
    if (!result.success || result.filledPrice <= 0) {
      if (result.reason === "http_404") {
        // Position already gone on the broker — reconcile the DB row if we can.
        const reconciled = this.markDbClosedNoFill(action.symbol);
        if (reconciled) {
          return { ok: true, reason: "broker had no position; DB reconciled" };
        }
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "AlpacaMomentumAdapter",
          message: `404 reconcile DB persist failed: ${action.symbol}`,
          count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
        });
        return { ok: false, reason: "broker had no position; DB reconciliation failed" };
      }
      return { ok: false, reason: result.reason ?? "broker rejected close" };
    }

    try {
      // The ownership row was resolved BEFORE the broker call above.
      const closeTime = Date.now();
      const closed = closeTrade(row.id, result.filledPrice, closeTime, 0);
      if (!closed) throw new Error("DB close returned no row");
      if (closed.closeReason !== "MANUAL_CLOSE_UNRECONCILED") {
        updateTradeCloseReason(row.id, closeReason);
      }
      try {
         if ((result.submittedPx ?? 0) > 0) recordFill({
           tradeId: row.id, orderId: result.orderId ?? row.id, accountId: this.cfg.accountId,
           symbol: action.symbol, side: closeSide, market: "stock",
           expectedPx: preCloseExpectedPx ?? result.submittedPx!, submittedPx: result.submittedPx!,
           filledPx: result.filledPrice, filledQty: result.filledQty ?? row.quantity,
           fillTime: result.filledAt ?? closeTime, latencyMs: Math.max(0, (result.filledAt ?? closeTime) - (result.submittedAt ?? closeTime)),
           broker: "alpaca", estPx: result.estPx,
         });
      } catch (e: any) { log.warn(`exit fill telemetry failed for ${action.symbol}: ${e.message}`); }
      eventBus.emit(EVENTS.POSITION_CLOSED, { ...closed, accountId: this.cfg.accountId, close_reason: closed.closeReason ?? closeReason });
      return { ok: true };
    } catch (e: any) {
      log.error(`Broker closed ${action.symbol}, but DB close failed: ${e.message}`);
      eventBus.emit(EVENTS.ERROR_BURST, {
        context: "AlpacaMomentumAdapter",
        message: `DB close persist failed: ${action.symbol} @ ${result.filledPrice}`,
        count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
      });
      return { ok: false, reason: "broker closed; DB reconciliation pending" };
    }
  }

  /**
   * Production parity with the corrected walk-forward replay
   * (scripts/backtest-momentum-wf.ts): intraday sleeves (momentum_stocks,
   * "5Min") must see RTH-only, fully-CLOSED bars — same discipline as
   * MeanRevEngine's daily-bar drop and binanceKlines' forming-bar drop.
   * Daily bars ("1Day", meanrev_stocks) skip this: RTH filtering is
   * meaningless on a whole-session bar, and MeanRevEngine already strips
   * today's partial daily bar itself — filtering here too would double-drop.
   */
  async fetchCandles(symbol: string, bars: number): Promise<OHLCV[]> {
    const tfMin = STOCK_TF_MINUTES[this.cfg.timeframe] ?? 5;
    if (tfMin >= 1440) {
      if (!this.cfg.dropTodayDailyBar) return await this.alpaca.getBars(symbol, this.cfg.timeframe, bars);
      // Daily-horizon momentum wiring (dropTodayDailyBar): request one extra
      // bar, then strip today's still-forming session (same ET-date rule as
      // MeanRevEngine.runDaily) so the engine only ever ranks CLOSED bars.
      const raw = await this.alpaca.getBars(symbol, this.cfg.timeframe, bars + 1);
      const stripped = raw.length > 0 && getETDateKey(raw[raw.length - 1].timestamp) === getETDateKey()
        ? raw.slice(0, -1)
        : raw;
      return stripped.slice(-bars);
    }

    const barMs = tfMin * 60_000;
    let requested = bars;
    let filtered: OHLCV[] = [];
    // Pre/post-market bars (if the feed returns them) and the still-forming
    // bar both get filtered away below — ask for more than `bars` up front,
    // widening (bounded, max 4 rounds) rather than guessing a fixed ratio.
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await this.alpaca.getBars(symbol, this.cfg.timeframe, requested);
      const now = Date.now();
      filtered = raw.filter(b => b.timestamp + barMs <= now && isMarketOpen(b.timestamp));
      if (filtered.length >= bars || raw.length < requested) break; // enough, or history exhausted
      requested *= 2;
    }
    return filtered.slice(-bars);
  }

  private markDbClosedNoFill(symbol: string): boolean {
    try {
      // Same ownership predicate as closePosition() above — see the
      // invariant comment on getOpenPositions().
      const row = getDB().prepare(
        `SELECT id, entry_price FROM trades
         WHERE account_id = ? AND symbol = ? AND status = 'open' AND strategy IN (?, 'SYNC_RECOVERY')
         LIMIT 1`
      ).get(this.cfg.accountId, symbol, this.cfg.strategy) as any;
      if (!row) return false;
      const closed = closeTrade(row.id, row.entry_price, Date.now(), 0, 0);
      if (!closed) return false;
      updateTradeCloseReason(row.id, `${this.cfg.strategy}_RECONCILED`);
      return true;
    } catch (e: any) {
      log.error(`markDbClosedNoFill failed for ${symbol}: ${e.message}`);
      return false;
    }
  }
}
