// ══════════════════════════════════════════════
// Binance Momentum Adapter (v8 — crypto sleeve)
// ══════════════════════════════════════════════
//
// Implements MomentumBrokerAdapter against Binance Futures via the existing
// BinanceExecutor. Translates between the strategy's domain (notional USD,
// alpaca-style symbols) and Binance's API (qty in base units, BTCUSDT).
//
// v8: trades rows live under account_id "momentum_crypto"; candles are
// Binance klines at cfg.candleTimeframe (1h legacy default; 1d for the
// USDC daily kernel) from the venue we execute on, with Alpaca bars as the
// fallback; normal momentum attaches a broker-native STOP_MARKET at the
// engine's vol-scaled stopLossPct (profile fixed pct as fallback). Explicit
// research roles opt out: idle TSM has no stop, Turtle stops at hourly close.

import type { MomentumBrokerAdapter } from "./MomentumEngine";
import { BREAKOUT_SHORT_TIME_STOP } from "./MomentumEngine";
import { BREAKOUT_SHORT_EXIT, BREAKOUT_SHORT_STOP, BREAKOUT_SHORT_PRIORITY, BREAKOUT_SHORT_DRAWDOWN, IDLE_OVERLAY_EXIT_CLOSE_REASON, MODEL_CUTOVER_CLOSE_REASON, SLOT_DISPLACED_CLOSE_REASON, TIME_STOP_CLOSE_REASON, TRAIL_STOP_CLOSE_REASON, TREND_EXIT_CLOSE_REASON } from "./MomentumEngine";
import type { CurrentPosition } from "./Rebalancer";
import type { OHLCV } from "../../utils/types";
import type { AlpacaExecutor } from "../../executor/alpaca-executor";
import type { BinanceExecutor } from "../../executor/binance-executor";
import { SYMBOL_MAP, fapiClientOrderId } from "../../executor/binance-executor";
import { isUnknownOrder } from "../../executor/executionPolicy";
import { beginEngineClose, endEngineClose } from "../../sync/inflightCloses";
import type { QuoteAsset } from "../../executor/binance/quoteAsset";
import { USDC_SYMBOL_MAP } from "../../executor/binance/quoteAsset";
import { binanceKlinesEnabled, fetchBinanceKlines } from "../../market/binanceKlines";
import {
  getDB, insertTrade, closeTrade, updateTradeCloseReason, getOpenTrades,
  insertSignal, insertOrder, recordFill, insertActivity, RECONCILE_CLOSE_SQL,
  accumulatePartialCloseLedger, getPartialCloseLedger, increaseOpenTradeQuantity,
} from "../../db/database";
import { eventBus, EVENTS } from "../../utils/events";
import { createLogger } from "../../utils/logger";

const log = createLogger("BinanceMomentumAdapter");

// Canonical engine-driven close labels persisted VERBATIM on
// trades.close_reason (telemetry: TRAIL_STOP exits vs signal-flip
// MOMENTUM_REBALANCE — both were previously recorded as the latter). Any
// other/absent value falls back to MOMENTUM_REBALANCE, so free-text can
// never land in the enum-ish column. Mirrors AlpacaMomentumAdapter.
const ENGINE_CLOSE_REASONS: ReadonlySet<string> = new Set([TRAIL_STOP_CLOSE_REASON, TIME_STOP_CLOSE_REASON, SLOT_DISPLACED_CLOSE_REASON, MODEL_CUTOVER_CLOSE_REASON, TREND_EXIT_CLOSE_REASON, IDLE_OVERLAY_EXIT_CLOSE_REASON, BREAKOUT_SHORT_EXIT, BREAKOUT_SHORT_STOP, BREAKOUT_SHORT_PRIORITY, BREAKOUT_SHORT_DRAWDOWN, BREAKOUT_SHORT_TIME_STOP]);

export interface BinanceMomentumAdapterConfig {
  /** Profile id to associate trades with. */
  accountId: string;
  /** Leverage to use on every position. Default 2. */
  leverage: number;
  /** Hard stop-loss percentage (price move that closes the position).
   *  Default 4%. FALLBACK only when the engine did not pass a per-open
   *  vol-scaled `stopLossPct` (rowStopPct doctrine, AGENTS.md "Stop-loss"). */
  stopLossPct: number;
  /** Settlement wallet this adapter owns. Default USDT (existing momentum_crypto behavior). */
  quoteAsset: QuoteAsset;
  /** Signal-candle timeframe for fetchCandles. Default "1Hour" (legacy,
   *  byte-identical). "1Day" = the momentum_crypto_usdc daily kernel
   *  (U1 2026-09-26, artifact 752767ae…): CLOSED UTC daily klines from the
   *  venue we execute on — klinesToOHLCV already drops the forming bar, so
   *  the series is causal by construction. */
  candleTimeframe: "1Hour" | "1Day";
  /** Allowed Turtle short units. USDⓈ-M perpetuals require no borrow. Absent = disabled. */
  breakoutShortSymbols?: string[];
}

export const DEFAULT_ADAPTER_CONFIG: BinanceMomentumAdapterConfig = {
  accountId: "momentum_crypto",
  leverage: 2,
  stopLossPct: 4,
  quoteAsset: "USDT",
  candleTimeframe: "1Hour",
};

export class BinanceMomentumAdapter implements MomentumBrokerAdapter {
  private cfg: BinanceMomentumAdapterConfig;
  // Own internal<->native symbol translation, keyed by quoteAsset — NOT the
  // executor's static USDT-only helpers. This is what lets a USDC adapter
  // reject "BTC/USD" and a USDT adapter reject "BTC/USDC" without either
  // one depending on the (possibly mocked, in tests) executor instance.
  private readonly symbolMap: Record<string, string>;

  constructor(
    private alpaca: AlpacaExecutor,
    private binance: BinanceExecutor,
    cfg: Partial<BinanceMomentumAdapterConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_ADAPTER_CONFIG, ...cfg };
    this.symbolMap = this.cfg.quoteAsset === "USDC" ? USDC_SYMBOL_MAP : SYMBOL_MAP;
    if (typeof (this.binance as any)?.getQuoteAsset === "function" && (this.binance as any).getQuoteAsset() !== this.cfg.quoteAsset) {
      log.error(`quoteAsset mismatch: adapter=${this.cfg.quoteAsset} executor=${(this.binance as any).getQuoteAsset()} — ownership checks will disagree with the broker`);
    }
  }

  private toNative(internal: string): string | null { return this.symbolMap[internal] ?? null; }

  /**
   * INVARIANT — ownership comes from the DB, not the broker (mirrors
   * AlpacaMomentumAdapter.getOpenPositions): this Binance API key is SHARED
   * with the canonical prod deployment (AGENTS.md "Project Location"), so
   * binance.getPositions() returns the account's AGGREGATE book — ours plus
   * prod's. Deriving exposure from the broker made the engine manage (and
   * closePosition liquidate) positions this sleeve never opened. Rows under
   * this account_id (MOMENTUM opens + SYNC_RECOVERY adoptions) define what
   * we own; the quoteAsset symbol-map filter keeps a sibling product's rows
   * out. A genuinely-ours position that lost its DB row is adopted by
   * AccountManager.syncBinanceFutures §2b (unconditional since the
   * single-deployment consolidation, 2026-07-29) and stays protected by the
   * broker-native STOP_MARKET placed at open — it is never silently unmanaged.
   */
  async getOpenPositions(): Promise<Array<CurrentPosition & { entryTime: number }>> {
    // Mark prices for the gross-exposure cap (2026-09-28): notional used to be
    // entry-cost (qty × entryPrice), which understates a winner — USDC held
    // UNI at 2.2× its entry price, so the 1.0× cap let the book reach ~1.3×
    // real exposure. The replay values open positions at the CURRENT price
    // (SimBroker.getOpenPositions), so live now does too. One positionRisk
    // read gives mark = entryPrice + unrealizedProfit / positionAmt for every
    // symbol; if the broker read fails the entry price is kept (the previous
    // behavior) — this method must never throw, the engine needs it to manage
    // exits.
    const marks = new Map<string, number>();
    try {
      for (const p of await this.binance.getPositions()) {
        if (!p.positionAmt || !(p.entryPrice > 0)) continue;
        const mark = p.entryPrice + p.unrealizedProfit / p.positionAmt;
        if (Number.isFinite(mark) && mark > 0) marks.set(p.symbol, mark);
      }
    } catch (e: any) {
      log.warn(`getOpenPositions: positionRisk read failed (${e?.message ?? e}) — valuing open positions at entry price this tick`);
    }
    const out: Array<CurrentPosition & { entryTime: number }> = [];
    for (const t of getOpenTrades(this.cfg.accountId)) {
      const native = this.toNative(t.symbol);
      if (!native) continue; // not this adapter's quoteAsset
      out.push({
        symbol: t.symbol,
        side: t.side as "buy" | "sell",
        quantity: t.quantity,
        notional: t.quantity * (marks.get(native) ?? t.entryPrice),
        // entryTime feeds MomentumEngineConfig.reunderwriteBefore (the
        // one-shot MODEL_CUTOVER). Missing here, the USDC daily kernel's
        // first pass (2026-09-27) silently kept the hourly model's positions.
        entryTime: t.entryTime,
        ...(t.strategy === "IDLE_OVERLAY" ? { role: "idle-overlay" as const } : {}),
        ...(t.strategy === "BREAKOUT_SHORT" ? { role: "breakout-short" as const, entryPrice: t.entryPrice, stopLoss: t.stopLoss, breakoutN: t.breakoutN } : {}),
      });
    }
    return out;
  }

  async getEquity(): Promise<number> {
    // 0 is a plausible real balance — returning it on disconnect let the
    // engine silently size/gate off a fake wipeout. Fail loudly instead.
    if (!this.binance.isConnected()) throw new Error("binance not connected");
    const bal = await this.binance.getBalance();
    return bal.marginEquity;
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
           AND strategy IN ('MOMENTUM', 'IDLE_OVERLAY', 'BREAKOUT_SHORT') AND ${RECONCILE_CLOSE_SQL}`
      ).get(this.cfg.accountId, epochMs) as any;
      return row?.net ?? 0;
    } catch (e: any) {
      log.error(`getRealisedPnlSince query failed for ${this.cfg.accountId}: ${e.message}`);
      throw e;
    }
  }

  async openPosition(action: Parameters<MomentumBrokerAdapter["openPosition"]>[0]): Promise<{ ok: boolean; reason?: string }> {
    if (action.role === "breakout-short" && (this.cfg.quoteAsset !== "USDT" || !this.cfg.breakoutShortSymbols?.includes(action.symbol) || !this.toNative(action.symbol) || action.side !== "sell" || !action.breakout || ![action.breakout.n, action.breakout.stopN, action.breakout.quantity].every(x => Number.isFinite(x) && x > 0))) {
      return { ok: false, reason: "breakout short requires a configured, mapped USDT sell with positive N/stopN" };
    }
    if (action.role === "idle-overlay" && (this.cfg.quoteAsset !== "USDT" || !["BTC/USD", "ETH/USD"].includes(action.symbol))) {
      return { ok: false, reason: "idle overlay supports BTC/ETH USDT perpetuals only" };
    }
    if (!this.binance.isConnected()) return { ok: false, reason: "binance not connected" };

    const binanceSym = this.toNative(action.symbol);
    if (!binanceSym) return { ok: false, reason: `no binance mapping for ${action.symbol}` };

    const price = await this.binance.getPrice(binanceSym);
    if (price <= 0) return { ok: false, reason: `no price for ${binanceSym}` };

    // Fill-telemetry benchmark for the ENTRY: a quote-touch TRADE price (ask
    // for buy, bid for sell), sampled here — before placeOrder is ever
    // called, same discipline as `price` above — NOT the mark price used
    // for sizing below. Mark is a funding-smoothed index nobody actually
    // trades at; benchmarking a real fill against it produced a "slippage"
    // number (~0.8bps P50) that was never comparable to the simulator's
    // vs-bar-open figure (~5bps) — audit 2026-09-09, fixed 2026-09-10. Falls
    // back to the mark price (the OLD basis) when no fresh quote is
    // available, so an entry never blocks on quote telemetry; the fallback
    // is only logged at debug (recordFill/fills has no basis column and
    // src/db/database.ts is out of scope for this file — see fillQuality.ts
    // header for the read-side note instead of a persisted flag).
    let entryExpectedPx = price;
    let entryPxIsQuote = false;
    if (typeof (this.binance as any).getExecutableQuote === "function") {
      try {
        const quote = await this.binance.getExecutableQuote(binanceSym, action.side);
        if (quote && quote.price > 0) { entryExpectedPx = quote.price; entryPxIsQuote = true; }
      } catch (e: any) { log.debug(`entry quote fetch failed for ${binanceSym}: ${e.message}`); }
    }
    if (!entryPxIsQuote) log.debug(`entry expectedPx basis=mark (no fresh quote) for ${binanceSym}`);

    // notionalUsd IS the target notional (backtest semantics: notionalPerSlot
    // = equity × slotPct is the full position size). Leverage only reduces the
    // MARGIN the broker locks — it must NOT multiply qty. The old ×leverage
    // here doubled the backtested exposure and starved slots 2-4 of margin
    // ("Margin is insufficient" on the first live tick, 2026-07-10).
    const rawQty = action.role === "breakout-short" ? action.breakout!.quantity : action.notionalUsd / price;
    if (rawQty <= 0) return { ok: false, reason: "computed qty <= 0" };

    // BinanceExecutor.placeOrder expects a Signal-like input. Build a minimal one.
    const signal = {
      id: crypto.randomUUID(),
      symbol: action.symbol,
      market: "crypto" as const,
      side: action.side,
      strategy: "MOMENTUM" as any, // signal is an untyped literal (no Signal annotation) — the
      // literal widens to `string` here regardless of which valid StrategyName is used; unrelated
      // to the union gap this file's getRealisedPnlSince fix addresses (reported, not silenced further).
      strength: "strong" as any,
      price,
      timestamp: Date.now(),
      indicators: { _score: 100 } as Record<string, number>, // synthetic; engine already gated
      reason: "momentum target",
    };
    const submittedAt = Date.now();
    try { insertSignal(signal, this.cfg.accountId); }
    catch (e: any) { log.warn(`signal telemetry failed for ${action.symbol}: ${e.message}`); }

    // Shared-pool margin mirror (2026-08-22): this sleeve is the sole OWNER
    // of its quote-asset margin pool, but the pool's AVAILABLE margin can
    // still be consumed by exposure the sleeve can't see (2026-08-19: orphan
    // positions ate the USDT pool and every hourly entry died as an
    // anonymous "Margin is insufficient" HTTP 400 for ~15 hours — 38
    // rejected orders whose real cause lived only in executor logs). Mirror
    // the broker's own initial-margin check pre-submit so the failure names
    // itself (need vs available) in the adapter reason — which is what the
    // SleeveOutput "producing NOTHING" page carries. requiredMargin =
    // notional/leverage UNDER-estimates the broker's true requirement (fee
    // reserve and buffers excluded), so this blocks strictly LESS than the
    // broker rejects: a mirror, not a new risk constant. Any balance read
    // failure fails OPEN — the broker stays the real enforcer. Entries only
    // by construction (closes/stops never pass through openPosition). The
    // COIN-M adapter is deliberately not mirrored: inverse-contract margin
    // math differs and that sleeve has had zero margin incidents.
    let availableMargin: number | null = null;
    try {
      const bal = await this.binance.getBalance();
      availableMargin = Number.isFinite(bal?.marginCash) ? bal.marginCash : null;
    } catch { /* unreadable → fail open, broker enforces */ }
    const requiredMargin = action.notionalUsd / Math.max(1, this.cfg.leverage);
    if (availableMargin !== null && requiredMargin > availableMargin) {
      const reason = `insufficient_margin (${this.cfg.quoteAsset} pool): need ~$${requiredMargin.toFixed(0)} initial margin for $${action.notionalUsd.toFixed(0)} notional at ${this.cfg.leverage}x, available $${availableMargin.toFixed(0)} — blocked pre-submit; if this persists with no open slots, look for orphan/untracked exposure (scripts/reconcile-orphan-exposure.ts)`;
      log.warn(`OPEN blocked for ${action.symbol} (${this.cfg.accountId}): ${reason}`);
      try {
        insertOrder({
          id: `rejected_${signal.id}`, symbol: action.symbol, market: "crypto", side: action.side,
          type: "market", quantity: rawQty, price, status: "rejected", signal,
          createdAt: submittedAt, updatedAt: Date.now(),
        }, this.cfg.accountId);
      } catch (e: any) { log.warn(`rejected-order telemetry failed for ${action.symbol}: ${e.message}`); }
      return { ok: false, reason };
    }

    const order = await this.binance.placeOrder(signal, rawQty, this.cfg.accountId as any);
    if (isUnknownOrder(order)) {
      // Outcome UNKNOWN (timeout/disconnect after transmit): the order may be
      // live. NOT a rejection — no rejected-order telemetry, and NO resend;
      // AccountManager.syncBinanceFutures adopts a genuinely-filled orphan
      // within 60s (and its native-stop reconcile protects it).
      log.error(`openPosition ${action.symbol}: order outcome UNKNOWN (${order.reason}) — in flight, resolving via reconciliation; NOT retried`);
      return { ok: false, reason: `order outcome unknown (in flight): ${order.reason}` };
    }
    if (!order) {
      try {
        insertOrder({
          id: `rejected_${signal.id}`, symbol: action.symbol, market: "crypto", side: action.side,
          type: "market", quantity: rawQty, price, status: "rejected", signal,
          createdAt: submittedAt, updatedAt: Date.now(),
        }, this.cfg.accountId);
      } catch (e: any) { log.warn(`rejected-order telemetry failed for ${action.symbol}: ${e.message}`); }
      return { ok: false, reason: "binance.placeOrder returned null" };
    }
    // DECISION price captured above (entryExpectedPx: quote-touch, or mark
    // as fallback — known before placeOrder was ever called), NOT
    // order.submittedPx (the quote AT submission — see recordFill/database.ts
    // slippage_bps: expected_px vs submitted_px must be two independent
    // reads, not the same value twice, or slippage_bps is always ~0).
    const expectedPx = entryExpectedPx;

    // order.quantity is OUR order's terminal executed quantity — the executor
    // already resolves it per-order (result.executedQty, then re-polls
    // check.executedQty until the residual is terminal; binance-executor.ts
    // placeOrder). positionRisk's positionAmt is the ACCOUNT AGGREGATE,
    // which may include shares that aren't this order's (manual positions,
    // or historically the second deployment's) — persisting positionAmt here
    // booked those shares as ours, so the row, the native stop, AND the
    // later min(row, broker) close were all sized to liquidate them.
    // The broker read below is an EXISTENCE check only, never a quantity source.
    const finalQty = order.quantity;
    if (typeof (this.binance as any).getPositions === "function") {
      try {
        const live = (await this.binance.getPositions()).find((p: any) => p.symbol === binanceSym && Math.abs(p.positionAmt) > 0);
        if (!live) return { ok: false, reason: "broker position missing after confirmed fill" };
      } catch (e: any) {
        // A transient positionRisk failure must not discard a confirmed fill;
        // the executor's terminal quantity stands and the DB/client loop manages it.
        log.error(`🚨 position existence check failed for live ${action.symbol} — keeping confirmed ${finalQty}: ${e.message}`);
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "BinanceMomentumAdapter",
          message: `Position existence check failed: ${action.symbol}`,
          count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
        });
      }
    }
    if (!(finalQty > 0)) return { ok: false, reason: "broker returned zero final quantity" };
    const filledPrice = order.filledPrice ?? price;
    const filledAt = order.filledAt ?? Date.now();
    try {
      insertOrder({
        ...order, symbol: action.symbol, market: "crypto", side: action.side, type: order.type ?? "market",
         quantity: finalQty, price: order.price ?? price, signal, status: "filled", filledPrice, filledAt,
        createdAt: order.createdAt ?? submittedAt, updatedAt: Date.now(),
      }, this.cfg.accountId);
      if (expectedPx && order.submittedPx && order.submittedPx > 0) recordFill({
        tradeId: order.id, orderId: order.externalId ?? order.id, accountId: this.cfg.accountId,
        symbol: action.symbol, side: action.side, market: "crypto",
        expectedPx, submittedPx: order.submittedPx, filledPx: filledPrice,
        filledQty: finalQty, fillTime: filledAt,
        latencyMs: Math.max(0, filledAt - (order.submittedAt ?? submittedAt)), broker: "binance",
        estPx: order.estPx,
      });
    } catch (e: any) { log.warn(`fill telemetry failed for ${action.symbol}: ${e.message}`); }
    // Engine-computed vol-scaled stop (openPosition.stopLossPct — the
    // AlpacaMomentumAdapter convention): derive the stop PRICE from the
    // REAL fill and use it for BOTH the broker-native STOP_MARKET and the
    // persisted row (trades.stop_loss), so the 15s loop / stopConfirm's
    // rowStopPct honors the vol distance. Absent or degenerate → profile
    // fixed pct (legacy behavior, byte-identical for the USDT sleeve).
    const stopPct = action.stopLossPct !== undefined && action.stopLossPct > 0
      ? action.stopLossPct
      : this.cfg.stopLossPct;
    const stopLoss = action.role === "breakout-short" ? filledPrice + action.breakout!.n * action.breakout!.stopN : action.role === "idle-overlay" ? 0 : action.side === "buy"
      ? filledPrice * (1 - stopPct / 100)
      : filledPrice * (1 + stopPct / 100);

    // Broker-native SL: fires even if the bot is down. It is the ONLY
    // unattended protection for this position (the 15s client stop loop is
    // a secondary backstop, not primary) — an open can never report success
    // while genuinely unprotected, so a failed install reconciles the
    // position closed instead of persisting it. Role-tagged units explicitly
    // opt out: idle TSM has no stop; Turtle evaluates 2N at HOURLY CLOSE only
    // in the shared engine (including live). No unattended stop for that unit.
    const nativeStop = !!action.role || await this.binance.placeStopMarketClose(action.symbol, action.side, stopLoss, finalQty);
    if (!nativeStop) return this.closeAfterStopFailure(action, finalQty, stopLoss);

    // Persist a trade row so getRealisedPnlSince() can attribute the close later.
    const persist = await this.persistFillOrReconcile(order.id, action, filledPrice, finalQty, stopLoss, order.openCommission ?? 0);
    if (!persist.ok) return persist;

    // Telegram/dashboard: adapters are the only open path in v8 — without
    // this emit no open is ever notified (2026-07-11 fix).
    eventBus.emit(EVENTS.ORDER_FILLED, {
      accountId: this.cfg.accountId, symbol: action.symbol, side: action.side,
       quantity: finalQty, filledPrice, market: "crypto", strategy: this.cfg && "MOMENTUM",
    });
    return { ok: true };
  }

  /** Reread the broker's exact position for `symbol`, scoped to this
   *  adapter's own quoteAsset (never a sibling product's symbol). Returns
   *  null when the read itself failed — unknown must never be treated as
   *  flat — or the absolute position amount (0 = confirmed flat). */
  private async rereadOwnedPositionQty(symbol: string): Promise<number | null> {
    const binanceSym = this.toNative(symbol);
    if (!binanceSym) return null;
    try {
      const live = (await this.binance.getPositions()).find((p: any) => p.symbol === binanceSym);
      return Math.abs(live?.positionAmt ?? 0);
    } catch (e: any) {
      log.warn(`flatness re-check failed for ${symbol}: ${e.message}`);
      return null;
    }
  }

  /**
   * Native stop install failed for a JUST-FILLED position — reconcile toward
   * flat instead of ever reporting success. `this.binance` only ever touches
   * its own quoteAsset's native symbols (see toNative/symbolMap), so this
   * emergency close is product-scoped by construction: a USDC adapter's stop
   * failure can never reach a USDT sibling position and vice versa.
   * No trade row is written for this symbol — there is nothing left open to
   * record. `closePosition`'s own success flag is NEVER trusted to cancel
   * protection — the exact owned position is ALWAYS reread afterward, since
   * a "success" response can still describe a partial reduction or race with
   * a concurrent change. Only a positively-confirmed-flat reread may drop
   * protection; a remnant (or unknown flatness) gets a reinstalled stop as a
   * backstop instead — the original install failed, so nothing else protects it.
   */
  private async closeAfterStopFailure(
    action: { symbol: string; side: "buy" | "sell" },
    finalQty: number,
    stopLoss: number,
  ): Promise<{ ok: false; reason?: string }> {
    log.error(`🚨 native STOP_MARKET install failed for live ${action.symbol} qty ${finalQty} — emergency-closing (an open can never report success unprotected)`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "BinanceMomentumAdapter",
      message: `Native stop install failed: ${action.symbol} qty ${finalQty} — emergency closing`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });

    await this.binance.closePosition(action.symbol, finalQty, action.side);

    const remainingQty = await this.rereadOwnedPositionQty(action.symbol);
    if (remainingQty === 0) {
      await this.binance.cancelAllOrders(action.symbol, { aggregateFlat: true }); // confirmed flat — clear whatever order state the close left behind
      log.error(`Emergency close OK for ${action.symbol} after stop-install failure — confirmed flat (no orphan, no DB row)`);
      return { ok: false, reason: "native_stop_failed_position_closed" };
    }

    // A remnant remains, or flatness is unknown (never assume flat). No stop
    // protects it yet (the original install failed) — reinstall one sized to
    // the exact remaining quantity as a backstop, then page loudly either way.
    const remnantQty = remainingQty ?? finalQty;
    const reinstalled = await this.binance.placeStopMarketClose(action.symbol, action.side, stopLoss, remnantQty);
    log.error(`🚨 ORPHAN POSITION ${action.symbol} qty ${remnantQty} — native stop install failed and emergency close did not confirm flat${reinstalled ? " (backstop stop reinstalled)" : " (backstop stop ALSO failed)"} — MANUAL RECONCILE`);
    return { ok: false };
  }

  /**
   * Persist the trade row for a JUST-FILLED position — reconcile if it can't.
   *
   * The DB row is the RECORD of a real broker position, NOT best-effort: the
   * engine's getOpenPositions is ultimately DB-anchored, so a missing row lets
   * the sleeve RE-OPEN the same symbol next rebalance (a doubled real position,
   * unmanaged by the 4% checkAllStopLoss loop). On persist failure we log.error
   * + page (ERROR_BURST), retry ONCE, and if it still fails EMERGENCY-CLOSE the
   * just-opened position — a position we can't record is worse than none, so we
   * reconcile toward flat. If the emergency close ALSO fails, the broker-native
   * STOP_MARKET SL placed above stays as a backstop and we log a loud ORPHAN line.
   */
  private async persistFillOrReconcile(
    orderId: string,
    action: Parameters<MomentumBrokerAdapter["openPosition"]>[0],
    filledPrice: number,
    filledQty: number,
    stopLoss: number,
    openCommission: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    const tradeRow = {
      id: orderId,
      symbol: action.symbol,
      market: "crypto",
      side: action.side,
      strategy: action.role === "breakout-short" ? "BREAKOUT_SHORT" : action.role === "idle-overlay" ? "IDLE_OVERLAY" : "MOMENTUM" as any,
      breakoutN: action.role === "breakout-short" ? action.breakout!.n : undefined,
      entryPrice: filledPrice,
      quantity: filledQty,
      entryTime: Date.now(),
      status: "open",
      stopLoss,
      openCommission,
    };
    if (this.tryInsert(tradeRow)) return { ok: true };

    log.error(`insertTrade FAILED after a real fill (${action.symbol} qty ${filledQty}) — paging + retrying once`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "BinanceMomentumAdapter",
      message: `DB persist failed after real fill: ${action.symbol} qty ${filledQty} — reconciling`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
    if (this.tryInsert(tradeRow)) return { ok: true };

    // Retry failed → the position is live on the broker with no DB record. Close it.
    await this.binance.closePosition(action.symbol, filledQty, action.side);

    // Never trust closePosition's own success flag to cancel the native stop
    // placed above — a "success" response can still describe a partial
    // reduction or race with a concurrent change. Only a
    // positively-confirmed-flat reread may drop protection.
    const remainingQty = await this.rereadOwnedPositionQty(action.symbol);
    if (remainingQty === 0) {
      await this.binance.cancelAllOrders(action.symbol, { aggregateFlat: true }); // confirmed flat — clear the native SL we placed above
      log.error(`Emergency close OK for ${action.symbol} — confirmed flat (no orphan)`);
      return { ok: false, reason: "db_persist_failed_position_closed" };
    }
    // A remnant remains, or flatness is unknown (never assume flat). The
    // native SL placed above already covers the full filledQty — retain it
    // (do NOT cancel) rather than reinstalling.
    const remnantQty = remainingQty ?? filledQty;
    log.error(`🚨 ORPHAN POSITION ${action.symbol} qty ${remnantQty} — MANUAL RECONCILE (broker holds it; DB write AND emergency close both failed to confirm flat; native SL retained as backstop)`);
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

  async closePosition(action: { symbol: string; side: "buy" | "sell"; closeReason?: string }): Promise<{ ok: boolean; reason?: string }> {
    if (!this.binance.isConnected()) return { ok: false, reason: "binance not connected" };
    // TRAIL_STOP (or a future canonical label) from the engine; default flip label otherwise.
    const closeReason = action.closeReason && ENGINE_CLOSE_REASONS.has(action.closeReason)
      ? action.closeReason
      : "MOMENTUM_REBALANCE";

    // Ownership check BEFORE any broker read/mutation — a symbol this
    // adapter doesn't own (wrong quoteAsset style) is refused outright.
    const binanceSym = this.toNative(action.symbol);
    if (!binanceSym) return { ok: false, reason: `no binance mapping for ${action.symbol}` };

    // Ownership check #2, ALSO before any broker mutation: only a row of
    // OURS authorizes closing anything, and only for the RECORDED quantity.
    // The broker book is the account's AGGREGATE (ours + any manual/unknown
    // share — see getOpenPositions); the old close-Math.abs(positionAmt)
    // here liquidated the share that wasn't ours.
    // Also matches SYNC_RECOVERY rows: AccountManager's sync loop adopts an
    // untracked Binance position under this SAME account_id + symbol as a
    // SYNC_RECOVERY row when the adapter's own insert races the sync — it is
    // the same broker position, just opened via the adoption path.
    let row: any;
    try {
      row = getDB().prepare(
        `SELECT id, entry_price, quantity, side, open_commission FROM trades
         WHERE account_id = ? AND symbol = ? AND status = 'open' AND strategy IN ('MOMENTUM', 'SYNC_RECOVERY', 'IDLE_OVERLAY', 'BREAKOUT_SHORT')
         ORDER BY entry_time DESC LIMIT 1`
      ).get(this.cfg.accountId, action.symbol) as any;
    } catch (e: any) {
      return { ok: false, reason: `DB ownership lookup failed: ${e.message}` };
    }
    if (!row) {
      return { ok: false, reason: "no open DB trade for this sleeve — refusing to touch the aggregate broker position" };
    }

    let positions;
    try {
      positions = await this.binance.getPositions();
    } catch (e: any) {
      return { ok: false, reason: `broker positions unavailable: ${e.message}` };
    }
    const live = positions.find(p => p.symbol === binanceSym);
    if (!live || live.positionAmt === 0) {
      // Broker flatness is enough to remove protection. Accounting may still
      // be pending because userTrades is eventually consistent; our stale DB
      // row is closed by AccountManager's 60s sync as an external close.
      await this.binance.cancelAllOrders(action.symbol, { aggregateFlat: true });
      return { ok: false, reason: "broker position already flat; awaiting fill reconciliation" };
    }

    // Close OUR recorded quantity, bounded by what the broker actually holds
    // — never the aggregate. BinanceExecutor.closePosition submits
    // reduceOnly, so even an overshoot could only reduce (never flip short);
    // the min() keeps our accounting honest when the broker holds less than
    // our row claims.
    const qty = Math.min(row.quantity, Math.abs(live.positionAmt));
    if (!(qty > 0)) return { ok: false, reason: `non-positive close qty (row=${row.quantity}, broker=${live.positionAmt})` };

    // Fill-telemetry benchmark for the EXIT: a quote-touch TRADE price,
    // captured BEFORE the close order is sent — mirrors the entry's
    // discipline above. `closeSide` is the CLOSING order's side (opposite
    // of the held position: closing a long sells at the bid). Without this,
    // exits recorded expectedPx == result.submittedPx by construction
    // (identical value, see below), so decision→fill slippage on exits was
    // never actually measured. Falls back to that same old behavior
    // (expected = submitted) when no fresh quote is available —
    // getExecutableQuote is absent on some older test stubs, tolerated via
    // the typeof check like the getPositions call above.
    const closeSide: "buy" | "sell" = action.side === "buy" ? "sell" : "buy";
    let preCloseExpectedPx: number | undefined;
    if (typeof (this.binance as any).getExecutableQuote === "function") {
      try {
        const quote = await this.binance.getExecutableQuote(binanceSym, closeSide);
        if (quote && quote.price > 0) preCloseExpectedPx = quote.price;
      } catch (e: any) { log.debug(`pre-close quote fetch failed for ${binanceSym}: ${e.message}`); }
    }

    // P0 fix (2026-10-02): register this close BEFORE the broker mutation so
    // the 60s sync (BinanceSleeveReconciler.closeFlatRow) doesn't attribute
    // our own fill as MANUAL_CLOSE in the window between the broker fill and
    // the DB write below. Cleared in `finally` — on ANY failure path the
    // reconciler takes over on its next pass, exactly as before.
    beginEngineClose(this.cfg.accountId, action.symbol);
    try {
      const result = await this.binance.closePosition(action.symbol, qty, action.side);
      if (!result.success || result.filledPrice <= 0) return { ok: false, reason: "broker did not confirm close" };

      // Clear the native SL left behind (closePosition=true stops don't
      // auto-cancel when the position is closed by another order). Our
      // position is gone, so our stop MUST go too — a stale reduceOnly stop
      // would later fire against whatever the aggregate still holds (a
      // manual/unknown position) or a FUTURE position of ours. The aggregate
      // may not be flat here, so this is the scoped form: our stamped stops
      // only, never anonymous ones.
      await this.binance.cancelAllOrders(action.symbol);

      // Close the DB row with the broker's realised PnL. A row the exposure
      // control partially reduced (scalePosition, factor < 1) carries those
      // legs' broker-settled pnl/fees on the partial ledger: net them into
      // the ONE final pnl (the sim's partialRealized → ClosedTrade.pnl), with
      // pnl_pct over the quantity ever held, not the remnant.
      try {
        const ledger = getPartialCloseLedger(row.id);
        const netPnl = result.realizedPnl - result.commission - (row.open_commission || 0)
          + ledger.realizedNative - ledger.commissionNative;
        const closeTime = Date.now();
        const closed = closeTrade(row.id, result.filledPrice, closeTime, result.commission, netPnl,
          ledger.closedContracts > 0 ? { basisQuantity: row.quantity + ledger.closedContracts } : {});
        if (!closed) throw new Error("DB close returned no row");
        if (closed?.closeReason !== "MANUAL_CLOSE_UNRECONCILED") {
          updateTradeCloseReason(row.id, closeReason);
        }
        try {
          if ((result.submittedPx ?? 0) > 0) recordFill({
            tradeId: row.id, orderId: result.orderId ?? row.id, accountId: this.cfg.accountId,
            symbol: action.symbol, side: closeSide, market: "crypto",
            expectedPx: preCloseExpectedPx ?? result.submittedPx!, submittedPx: result.submittedPx!,
            filledPx: result.filledPrice, filledQty: result.filledQty ?? row.quantity,
            fillTime: result.exitTime ?? closeTime, latencyMs: Math.max(0, (result.exitTime ?? closeTime) - (result.submittedAt ?? closeTime)),
            broker: "binance", estPx: result.estPx,
          });
        } catch (e: any) { log.warn(`exit fill telemetry failed for ${action.symbol}: ${e.message}`); }
        if (closed) eventBus.emit(EVENTS.POSITION_CLOSED, { ...closed, accountId: this.cfg.accountId, close_reason: closed.closeReason ?? closeReason });
      } catch (e: any) {
        log.error(`Broker closed ${action.symbol}, but DB close failed: ${e.message}`);
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "BinanceMomentumAdapter",
          message: `DB close persist failed: ${action.symbol} @ ${result.filledPrice}`,
          count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
        });
        return { ok: false, reason: "broker closed; DB reconciliation pending" };
      }
      return { ok: true };
    } finally {
      endEngineClose(this.cfg.accountId, action.symbol);
    }
  }

  /**
   * MomentumBrokerAdapter.scalePosition — the portfolio exposure control's
   * partial resize (RW4a, 2026-10-23; MomentumEngineConfig.exposureControl,
   * wired on momentum_crypto_usdc; shared verbatim by the USDT sleeve).
   * Mirrors SimBroker.scalePosition (scripts/backtest-momentum-wf.ts) so live
   * and replay derive the SAME order from their own recorded quantity:
   *
   *  factor < 1 — reduceOnly MARKET close of (1 − factor) × the ROW's quantity
   *    (bounded by the broker's; the executor floors to LOT_SIZE, no
   *    minNotional gate on a reduce). Accounting = the COIN-M partial-close
   *    ledger (accumulatePartialCloseLedger): the leg's broker-settled
   *    realizedPnl/commission accrue on the row, quantity shrinks to the
   *    remnant, the row stays OPEN — ONE trades row per position, pnl written
   *    once at the final close (closePosition / the reconciler sum the legs),
   *    so trades, win rate, expectancy and RiskGuard's getRealisedPnlSince
   *    behave exactly like the sim's single ClosedTrade. No new close reason.
   *  factor > 1 — MARKET add of (factor − 1) × quantity through placeOrder
   *    (every entry filter applies: step, minNotional, margin); entry_price
   *    becomes the weighted average, open_commission accumulates, stop_loss
   *    (the stop PRICE) is untouched — the stop stays at the original entry.
   *
   * In both cases the DB write is ONE transaction on the confirmed fill, so
   * BrokerSync's SUM(open quantity) never sees a phantom mismatch beyond the
   * fill→write instant it already tolerates; the 15s loop and the display
   * re-read rows, so they see the new quantity; the inflight-close guard is
   * held across the reduce like a close. Then the broker-native STOP_MARKET
   * is re-sized to the new quantity at the row's stop price (place the new
   * one FIRST, then sweep ours around it; a double placement failure cancels
   * nothing, pages STOP_RESIZE_FAILED and leaves the row correct — the
   * resize DID happen, so the engine must record it).
   * Never flattens (a reduction that would leave ~nothing is refused — exits
   * are the closes' job) and never creates a position. Any failure BEFORE a
   * confirmed fill leaves position and row untouched and returns ok:false.
   */
  async scalePosition(action: { symbol: string; side: "buy" | "sell"; factor: number; reason?: string }): Promise<{ ok: boolean; reason?: string }> {
    if (!this.binance.isConnected()) return { ok: false, reason: "binance not connected" };
    const { factor } = action;
    if (!(factor > 0) || !Number.isFinite(factor) || factor === 1) return { ok: false, reason: `invalid factor ${factor}` };
    const binanceSym = this.toNative(action.symbol);
    if (!binanceSym) return { ok: false, reason: `no binance mapping for ${action.symbol}` };

    // Ownership: only OUR open row authorizes touching the symbol, and only
    // relative to the RECORDED quantity (same boundary as closePosition).
    let row: any;
    try {
      row = getDB().prepare(
        `SELECT id, entry_price, quantity, side, stop_loss, open_commission FROM trades
         WHERE account_id = ? AND symbol = ? AND status = 'open' AND strategy IN ('MOMENTUM', 'SYNC_RECOVERY')
         ORDER BY entry_time DESC LIMIT 1`
      ).get(this.cfg.accountId, action.symbol) as any;
    } catch (e: any) {
      return { ok: false, reason: `DB ownership lookup failed: ${e.message}` };
    }
    if (!row) return { ok: false, reason: "no open DB trade for this sleeve — refusing to resize the aggregate broker position" };
    if (row.side !== action.side) return { ok: false, reason: `row side ${row.side} ≠ requested ${action.side}` };
    if (!(row.quantity > 0)) return { ok: false, reason: `non-positive row quantity ${row.quantity}` };

    let live: { positionAmt: number } | undefined;
    try {
      live = (await this.binance.getPositions()).find((p: any) => p.symbol === binanceSym);
    } catch (e: any) {
      return { ok: false, reason: `broker positions unavailable: ${e.message}` };
    }
    const brokerQty = Math.abs(live?.positionAmt ?? 0);
    if (!(brokerQty > 0)) return { ok: false, reason: "broker position flat; awaiting reconciliation" };

    // The stop PRICE the re-sized native stop keeps: the row's persisted one
    // (vol-scaled at entry), else the profile distance from the ORIGINAL
    // entry — never re-derived from the new average.
    const stopPrice = row.stop_loss > 0
      ? row.stop_loss
      : (action.side === "buy" ? row.entry_price * (1 - this.cfg.stopLossPct / 100) : row.entry_price * (1 + this.cfg.stopLossPct / 100));
    const why = action.reason ?? "exposure control";

    if (factor < 1) {
      const closeQty = Math.min(row.quantity * (1 - factor), brokerQty);
      // Never flatten: the remnant must be a real position on BOTH books.
      if (!(closeQty > 0) || row.quantity - closeQty <= row.quantity * 1e-9 || brokerQty - closeQty <= brokerQty * 1e-6) {
        return { ok: false, reason: `reduction too small or would flatten (row ${row.quantity}, broker ${brokerQty}, factor ${factor})` };
      }
      const closeSide: "buy" | "sell" = action.side === "buy" ? "sell" : "buy";
      let preExpectedPx: number | undefined;
      if (typeof (this.binance as any).getExecutableQuote === "function") {
        try {
          const quote = await this.binance.getExecutableQuote(binanceSym, closeSide);
          if (quote && quote.price > 0) preExpectedPx = quote.price;
        } catch (e: any) { log.debug(`pre-resize quote fetch failed for ${binanceSym}: ${e.message}`); }
      }
      // Same guard as closePosition: while the fill→DB-write is in flight the
      // reconciler must not attribute our own partial fill.
      beginEngineClose(this.cfg.accountId, action.symbol);
      try {
        const result = await this.binance.closePosition(action.symbol, closeQty, action.side);
        if (!result.success || !(result.filledPrice > 0)) return { ok: false, reason: `broker did not confirm partial close${result.reason ? `: ${result.reason}` : ""}` };
        const filledQty = result.filledQty && result.filledQty > 0 ? Math.min(result.filledQty, row.quantity) : closeQty;
        const remaining = row.quantity - filledQty;
        if (!(remaining > row.quantity * 1e-9)) {
          // The broker took the whole row — not a resize any more. Leave the
          // row to the reconciler (broker flat → attributed close) and say so.
          log.error(`🚨 scalePosition ${action.symbol}: partial reduce filled ${filledQty} ≥ row ${row.quantity} — position flattened; row left to reconciliation`);
          return { ok: false, reason: "partial close consumed the whole row; reconciliation pending" };
        }
        let ledger;
        try {
          ledger = accumulatePartialCloseLedger(row.id, {
            realizedNative: result.realizedPnl, commissionNative: result.commission,
            commissionAsset: this.cfg.quoteAsset, closedContracts: filledQty, remainingContracts: remaining,
          });
        } catch (e: any) {
          ledger = null;
          log.error(`scalePosition ${action.symbol}: partial ledger write threw: ${e.message}`);
        }
        if (!ledger) {
          log.error(`🚨 Broker reduced ${action.symbol} by ${filledQty}, but the DB row ${row.id} could not be updated — reconciliation pending`);
          eventBus.emit(EVENTS.ERROR_BURST, {
            context: "BinanceMomentumAdapter",
            message: `Partial reduce persisted on broker, DB update failed: ${action.symbol} −${filledQty}`,
            count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
          });
          return { ok: false, reason: "broker reduced; DB reconciliation pending" };
        }
        try {
          if ((result.submittedPx ?? 0) > 0) recordFill({
            tradeId: row.id, orderId: result.orderId ?? `${row.id}:resize:${Date.now()}`, accountId: this.cfg.accountId,
            symbol: action.symbol, side: closeSide, market: "crypto",
            expectedPx: preExpectedPx ?? result.submittedPx!, submittedPx: result.submittedPx!,
            filledPx: result.filledPrice, filledQty, fillTime: result.exitTime ?? Date.now(),
            latencyMs: Math.max(0, (result.exitTime ?? Date.now()) - (result.submittedAt ?? Date.now())),
            broker: "binance", estPx: result.estPx,
          });
        } catch (e: any) { log.warn(`resize fill telemetry failed for ${action.symbol}: ${e.message}`); }
        log.info(`📉 ${action.symbol} reduced ×${factor.toFixed(3)}: −${filledQty} @ $${result.filledPrice} (leg pnl ${result.realizedPnl.toFixed(2)}, fee ${result.commission.toFixed(4)}; remaining ${remaining}) — ${why}`);
        try { insertActivity(this.cfg.accountId, "trade", `Resized ${action.symbol} ×${factor.toFixed(3)}: −${filledQty} @ $${result.filledPrice} (remaining ${remaining}) — ${why}`); } catch {}
        await this.resizeNativeStop(action.symbol, action.side, stopPrice, remaining, row.quantity);
        return { ok: true };
      } finally {
        endEngineClose(this.cfg.accountId, action.symbol);
      }
    }

    // factor > 1 — an add-back is an ENTRY: the engine already applied every
    // entry gate and the gross cap; the venue's entry filters apply here.
    const price = await this.binance.getPrice(binanceSym);
    if (!(price > 0)) return { ok: false, reason: `no price for ${binanceSym}` };
    const addQty = row.quantity * (factor - 1);
    if (!(addQty > 0)) return { ok: false, reason: "computed add qty <= 0" };
    // Shared-pool margin mirror (see openPosition): names the failure instead
    // of an anonymous HTTP 400; fails OPEN when unreadable.
    try {
      const bal = await this.binance.getBalance();
      const available = Number.isFinite(bal?.marginCash) ? bal.marginCash : null;
      const required = (addQty * price) / Math.max(1, this.cfg.leverage);
      if (available !== null && required > available) {
        return { ok: false, reason: `insufficient_margin (${this.cfg.quoteAsset} pool): add-back needs ~$${required.toFixed(0)}, available $${available.toFixed(0)}` };
      }
    } catch { /* unreadable → fail open, broker enforces */ }
    const signal = {
      id: crypto.randomUUID(), symbol: action.symbol, market: "crypto" as const, side: action.side,
      strategy: "MOMENTUM" as any, strength: "strong" as any, price, timestamp: Date.now(),
      indicators: { _score: 100 } as Record<string, number>, reason: `exposure control add-back: ${why}`,
    };
    const submittedAt = Date.now();
    const order = await this.binance.placeOrder(signal, addQty, this.cfg.accountId as any);
    if (isUnknownOrder(order)) {
      // In flight: the fill (if any) shows up as broker > row quantity, which
      // BrokerSync's drift page reports; NOT retried (the next tick re-reads
      // the row and re-derives the factor).
      log.error(`scalePosition ${action.symbol}: add-back outcome UNKNOWN (${order.reason}) — in flight, NOT retried`);
      return { ok: false, reason: `order outcome unknown (in flight): ${order.reason}` };
    }
    if (!order) return { ok: false, reason: "binance.placeOrder returned null (add-back rejected)" };
    const filledQty = order.quantity;
    if (!(filledQty > 0)) return { ok: false, reason: "broker returned zero add quantity" };
    const filledPrice = order.filledPrice ?? price;
    const filledAt = order.filledAt ?? Date.now();
    let updated: ReturnType<typeof increaseOpenTradeQuantity> = null;
    try {
      updated = increaseOpenTradeQuantity(row.id, { addQty: filledQty, fillPrice: filledPrice, commission: order.openCommission ?? 0 });
    } catch (e: any) {
      log.error(`scalePosition ${action.symbol}: row increase threw: ${e.message}`);
    }
    if (!updated) {
      // The add filled but the row is gone (closed meanwhile) or the write
      // failed: that quantity is untracked exposure. Undo it (reduceOnly) and
      // page; whatever remains is the reconciler's orphan path.
      log.error(`🚨 scalePosition ${action.symbol}: add-back filled ${filledQty} but the row could not be increased — closing the added quantity`);
      eventBus.emit(EVENTS.ERROR_BURST, {
        context: "BinanceMomentumAdapter",
        message: `Add-back persisted on broker, DB update failed: ${action.symbol} +${filledQty} — undoing`,
        count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
      });
      try { await this.binance.closePosition(action.symbol, filledQty, action.side); } catch (e: any) { log.error(`undo of ${action.symbol} add-back failed: ${e.message}`); }
      return { ok: false, reason: "add-back filled; DB update failed; undo attempted" };
    }
    try {
      insertOrder({
        ...order, symbol: action.symbol, market: "crypto", side: action.side, type: order.type ?? "market",
        quantity: filledQty, price: order.price ?? price, signal, status: "filled", filledPrice, filledAt,
        createdAt: order.createdAt ?? submittedAt, updatedAt: Date.now(),
      }, this.cfg.accountId);
      if (order.submittedPx && order.submittedPx > 0) recordFill({
        tradeId: row.id, orderId: order.externalId ?? order.id, accountId: this.cfg.accountId,
        symbol: action.symbol, side: action.side, market: "crypto",
        expectedPx: price, submittedPx: order.submittedPx, filledPx: filledPrice,
        filledQty, fillTime: filledAt, latencyMs: Math.max(0, filledAt - (order.submittedAt ?? submittedAt)),
        broker: "binance", estPx: order.estPx,
      });
    } catch (e: any) { log.warn(`add-back telemetry failed for ${action.symbol}: ${e.message}`); }
    log.info(`📈 ${action.symbol} added ×${factor.toFixed(3)}: +${filledQty} @ $${filledPrice} (qty ${updated.quantity}, avg entry $${updated.entryPrice.toFixed(6)}, stop stays $${stopPrice}) — ${why}`);
    try { insertActivity(this.cfg.accountId, "trade", `Resized ${action.symbol} ×${factor.toFixed(3)}: +${filledQty} @ $${filledPrice} (qty ${updated.quantity}) — ${why}`); } catch {}
    await this.resizeNativeStop(action.symbol, action.side, stopPrice, updated.quantity, row.quantity);
    return { ok: true };
  }

  /**
   * Re-size the broker-native STOP_MARKET after a confirmed resize, never
   * leaving the position without one: PLACE the new reduceOnly stop first
   * (stamped as ours, same stop price, new quantity; two attempts), and only
   * then cancel OUR other stops for the symbol around it
   * (cancelAllOrders exceptClientOrderIds — never anonymous ones, the
   * aggregate is not flat). If both placements fail, NOTHING is canceled:
   * the old stop stays. After a trim it still protects the whole remainder
   * (reduceOnly clamps to the position); after an add-back it covers only
   * the OLD quantity — the STOP_RESIZE_FAILED page says which case this is.
   * Never undoes the resize: it already happened and the engine records it.
   */
  private async resizeNativeStop(symbol: string, side: "buy" | "sell", stopPrice: number, newQty: number, previousQty: number): Promise<boolean> {
    const native = this.toNative(symbol) ?? symbol;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const clientOrderId = fapiClientOrderId(`stop:${native}:${side}:resize:${Date.now()}:${attempt}:${crypto.randomUUID()}`);
      let placed = false;
      try {
        placed = await this.binance.placeStopMarketClose(symbol, side, stopPrice, newQty, clientOrderId);
      } catch (e: any) {
        log.warn(`resizeNativeStop ${symbol}: attempt ${attempt} threw: ${e.message}`);
      }
      if (!placed) continue;
      try {
        await this.binance.cancelAllOrders(symbol, { exceptClientOrderIds: [clientOrderId] });
      } catch (e: any) {
        // Two of our stops at the same price: harmless (the second is a
        // reduceOnly no-op once the first fills); the next pass's sweep clears it.
        log.warn(`resizeNativeStop ${symbol}: new stop placed but the sweep of the previous ones failed (${e.message}) — a stale duplicate stop may remain`);
      }
      return true;
    }
    const trimmed = newQty < previousQty;
    const coverage = trimmed
      ? `TRIM: the previous stop (qty ${previousQty}) still protects the whole remainder ${newQty} (reduceOnly)`
      : `ADD-BACK: the previous stop (qty ${previousQty}) covers only the old quantity; ${newQty - previousQty} of ${newQty} is unprotected`;
    log.error(`🚨 STOP_RESIZE_FAILED ${symbol} @ $${stopPrice} [${this.cfg.accountId}] — re-sized native stop NOT placed after two attempts, nothing canceled; ${coverage}; ${this.cfg.quoteAsset === "USDT" ? "15s loop still covers the row" : "USDC has no client stop loop"} — MANUAL CHECK`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "BinanceMomentumAdapter",
      message: `STOP_RESIZE_FAILED ${symbol}: ${trimmed ? "trim — old stop still covers the remainder" : "add-back — old stop covers only the old quantity"}`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
    return false;
  }

  async fetchCandles(symbol: string, bars: number, opts?: { strictVenue?: boolean }): Promise<OHLCV[]> {
    // Klines from the venue we execute on, at the configured signal
    // timeframe (default "1Hour" — legacy; "1Day" = the USDC daily kernel).
    // Binance caps a single request at 1500 rows — enough for the hourly
    // engine's ~754-bar ask and the daily kernel's 263-bar ask alike.
    if (binanceKlinesEnabled()) {
      const klines = await fetchBinanceKlines(symbol, this.cfg.candleTimeframe, Math.min(bars, 1000), this.cfg.quoteAsset);
      if (klines.length > 0) return klines;
    }
    if (opts?.strictVenue) return [];
    // Fallback: Alpaca crypto bars at the SAME timeframe. Alpaca has no
    // USDC/COIN-M pairs — for a USDC symbol this legitimately returns []
    // (fail-closed to no signal for that symbol), never a USDT-symbol proxy.
    return await this.alpaca.getBars(symbol, this.cfg.candleTimeframe, bars);
  }

  /** Per-UTC-day cache for fetchDailyCloses: the answer only changes when a
   *  new daily bar closes, so at most one klines request per symbol per day. */
  private dailyClosesCache = new Map<string, { utcDay: number; closes: number[] }>();
  private dailyBarsCache = new Map<string, { utcDay: number; bars: OHLCV[] }>();
  async fetchDailyBars(symbol: string, days: number): Promise<OHLCV[]> {
    if (!binanceKlinesEnabled() || days > 997) return [];
    const utcDay = Math.floor(Date.now() / 86_400_000), key = `${symbol}|${days}`;
    const cached = this.dailyBarsCache.get(key);
    if (cached?.utcDay === utcDay) return cached.bars;
    const bars = (await fetchBinanceKlines(symbol, "1Day", days + 3, this.cfg.quoteAsset)).filter(b => b.timestamp < utcDay * 86_400_000).slice(-days);
    if (bars.length !== days || bars.some((b, i) => b.timestamp !== (utcDay - days + i) * 86_400_000)) return [];
    this.dailyBarsCache.set(key, { utcDay, bars });
    return bars;
  }

  /**
   * Market-trend gate data source (MomentumBrokerAdapter.fetchDailyCloses):
   * last `days` CLOSED UTC daily closes from Binance 1d klines on the venue
   * we execute on. klinesToOHLCV already drops the still-forming daily bar
   * (closeTime in the future), so the series is causal by construction.
   * Fail-open contract: any failure returns [] — the engine's gate then
   * fails OPEN (documented on MomentumEngineConfig.marketTrend); NO Alpaca
   * fallback here (pitfall 4: no cross-exchange price mixing — the gate
   * either reads the venue's own daily closes or abstains).
   */
  async fetchDailyCloses(symbol: string, days: number, opts?: { strictUtc?: boolean }): Promise<number[]> {
    if (!binanceKlinesEnabled()) return [];
    const utcDay = Math.floor(Date.now() / 86_400_000);
    const key = `${symbol}|${days}${opts?.strictUtc ? "|strict" : ""}`;
    const cached = this.dailyClosesCache.get(key);
    if (cached && cached.utcDay === utcDay) return cached.closes;
    // +3 slack: the dropped forming bar plus venue-side off-by-one never
    // starve the SMA window of its exact `days` closes.
    const klines = await fetchBinanceKlines(symbol, "1Day", days + 3, this.cfg.quoteAsset);
    if (opts?.strictUtc) {
      const window = klines.slice(-days);
      if (window.length !== days || window.some((b, i) => b.timestamp !== (utcDay - days + i) * 86_400_000)) return [];
    }
    const closes = klines.map(k => k.close).slice(-days);
    if (closes.length > 0) this.dailyClosesCache.set(key, { utcDay, closes });
    return closes;
  }

}
