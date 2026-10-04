// ══════════════════════════════════════════════
// Binance COIN-M Momentum Adapter — standalone BTCUSD_PERP sleeve
// ══════════════════════════════════════════════
//
// Implements MomentumBrokerAdapter against BinanceCoinMExecutor. Single
// product: "BTC/COIN-M" (internal symbol) → BTCUSD_PERP. Inverse-contract
// sizing/PnL — NEVER quantity*price. Standalone: not wired into
// index.ts/AccountManager/risk profiles; the account_id below is a label
// for its own trades rows, not a live risk profile.
//
// Persistence seam (deliberate, documented): insertTrade/insertSignal/
// insertOrder are reused as-is (they're generic column writers, market-
// agnostic). closeTrade() is NOT reused — its internal pnl_pct formula is
// `pnl / (entry_price * quantity)`, which is correct for LINEAR contracts
// (quantity = base units) but wrong for INVERSE ones (quantity here is
// contract COUNT, not BTC size). This adapter computes pnl/pnl_pct itself
// via the inverse formula and writes them atomically via the canonical
// `closeTradeExplicit()` helper (src/db/database.ts), which accepts an
// explicit pnl AND pnl_pct (never derives pnl_pct from the linear formula).

import type { MomentumBrokerAdapter } from "./MomentumEngine";
import { MODEL_CUTOVER_CLOSE_REASON, SLOT_DISPLACED_CLOSE_REASON, TIME_STOP_CLOSE_REASON, TRAIL_STOP_CLOSE_REASON } from "./MomentumEngine";
import type { CurrentPosition } from "./Rebalancer";
import type { OHLCV } from "../../utils/types";
import {
  BinanceCoinMExecutor, computeContracts, positionUsd, inversePnlBtc,
  type OwnedStop, type CoinMCloseResult, type CoinMPosition,
} from "../../executor/binance-coinm-executor";
import { getDB, insertTrade, insertSignal, insertOrder, closeTradeExplicit, accumulatePartialCloseLedger, RECONCILE_CLOSE_SQL } from "../../db/database";
import { eventBus, EVENTS } from "../../utils/events";
import { createLogger } from "../../utils/logger";
import { fetchT } from "../../utils/timeout";
import { v4 as uuid } from "uuid";

const log = createLogger("BinanceCoinMMomentumAdapter");

/** The only symbol this adapter accepts — explicit product identity. */
export const COINM_INTERNAL_SYMBOL = "BTC/COIN-M";

// Canonical engine-driven close labels persisted VERBATIM on
// trades.close_reason — coherence with the FAPI/Alpaca adapters. NOTE: the
// momentum_btc sleeve does NOT configure tsmTrail today (index.ts), so the
// engine never actually sends TRAIL_STOP here; the mapping exists so
// enabling the trail later needs no adapter change.
const ENGINE_CLOSE_REASONS: ReadonlySet<string> = new Set([TRAIL_STOP_CLOSE_REASON, TIME_STOP_CLOSE_REASON, SLOT_DISPLACED_CLOSE_REASON, MODEL_CUTOVER_CLOSE_REASON]);

export interface BinanceCoinMMomentumAdapterConfig {
  accountId: string;
  stopLossPct: number;
  /** DAPI kline interval for fetchCandles (e.g. "1h"). */
  klineInterval: string;
}

export const DEFAULT_COINM_ADAPTER_CONFIG: BinanceCoinMMomentumAdapterConfig = {
  accountId: "coinm_btc",
  stopLossPct: 4,
  klineInterval: "1h",
};

export class BinanceCoinMMomentumAdapter implements MomentumBrokerAdapter {
  private cfg: BinanceCoinMMomentumAdapterConfig;

  constructor(
    private executor: BinanceCoinMExecutor,
    cfg: Partial<BinanceCoinMMomentumAdapterConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_COINM_ADAPTER_CONFIG, ...cfg };
  }

  async getOpenPositions(): Promise<CurrentPosition[]> {
    if (!this.executor.isConnected()) throw new Error("binance coin-m not connected");
    const pos = await this.executor.getOwnedPosition();
    if (!pos) return [];
    const filters = await this.executor.getFilters(COINM_INTERNAL_SYMBOL);
    const contracts = Math.abs(pos.positionAmt);
    return [{
      symbol: COINM_INTERNAL_SYMBOL,
      side: pos.positionAmt > 0 ? "buy" : "sell",
      quantity: contracts,
      notional: positionUsd(contracts, filters.contractSize),
    }];
  }

  async getEquity(): Promise<number> {
    if (!this.executor.isConnected()) throw new Error("binance coin-m not connected");
    return this.executor.getEquityUsd();
  }

  async getRealisedPnlSince(epochMs: number): Promise<number> {
    // A DB read failure must never look like "no pnl" — it feeds
    // RiskGuard.recordRebalanceOutcome (MomentumEngine.ts), which persists
    // loss-streak state; a fabricated 0 there is a silent flat period that
    // can hide a real streak. Propagate so the caller freezes instead.
    try {
      const row = getDB().prepare(
        `SELECT COALESCE(SUM(pnl), 0) net FROM trades
         WHERE account_id = ? AND symbol = ? AND strategy = 'MOMENTUM' AND status = 'closed' AND exit_time > ?
           AND ${RECONCILE_CLOSE_SQL}`
      ).get(this.cfg.accountId, COINM_INTERNAL_SYMBOL, epochMs) as any;
      return row?.net ?? 0;
    } catch (e: any) {
      log.error(`getRealisedPnlSince query failed for ${this.cfg.accountId}: ${e.message}`);
      throw e;
    }
  }

  async openPosition(action: { symbol: string; side: "buy" | "sell"; notionalUsd: number }): Promise<{ ok: boolean; reason?: string }> {
    if (action.symbol !== COINM_INTERNAL_SYMBOL) return { ok: false, reason: `unsupported symbol: ${action.symbol} (only ${COINM_INTERNAL_SYMBOL})` };
    if (!this.executor.isConnected()) return { ok: false, reason: "binance coin-m not connected" };

    // Restart invariant (2026-07-19): activeStops is in-memory on the
    // executor and never survives a process restart. Before EVER opening a
    // new position, confirm any position already live on the broker (e.g.
    // left over from before a restart, or a stale partial-close remnant) is
    // ACTUALLY protected by a correctly-sized, correct-side owned native
    // stop — never trust "the executor adopted something at init()" blindly.
    const invariant = await this.verifyOrRepairLiveStop();
    if (!invariant.ok) return invariant;

    const filters = await this.executor.getFilters(COINM_INTERNAL_SYMBOL).catch((e: any) => {
      log.error(`getFilters failed: ${e.message}`);
      return null;
    });
    if (!filters) return { ok: false, reason: "exchangeInfo unavailable" };

    const markPrice = await this.executor.getMarkPrice(COINM_INTERNAL_SYMBOL);
    if (!(markPrice > 0)) return { ok: false, reason: "no mark price" };

    const contracts = computeContracts(action.notionalUsd, filters.contractSize);
    if (contracts <= 0) return { ok: false, reason: "computed contracts <= 0" };

    const intentId = uuid();
    const signal = {
      id: intentId,
      symbol: action.symbol,
      market: "crypto" as const,
      side: action.side,
      strategy: "MOMENTUM" as any,
      strength: "strong" as any,
      price: markPrice,
      timestamp: Date.now(),
      indicators: { _score: 100 } as Record<string, number>,
      reason: "coinm momentum target",
    };
    try { insertSignal(signal, this.cfg.accountId); }
    catch (e: any) { log.warn(`signal telemetry failed: ${e.message}`); }

    let order;
    try {
      order = await this.executor.placeMarketOrder({ internalSymbol: action.symbol, side: action.side, contracts, intentId });
    } catch (e: any) {
      log.error(`placeMarketOrder threw: ${e.message}`);
      return { ok: false, reason: `placeMarketOrder failed: ${e.message}` };
    }
    if (!order) return { ok: false, reason: "placeMarketOrder returned null (not confirmed filled)" };

    let filledPrice = order.avgPrice;
    let filledContracts = order.executedQty > 0 ? order.executedQty : contracts;
    if (!(filledPrice > 0)) {
      // Order status said FILLED (or the executor's own ORPHAN_* exposure
      // recovery kicked in — see placeMarketOrder) but avgPrice wasn't
      // settled — fall back to the broker's own position read, never
      // fabricate a price.
      try {
        const owned = await this.executor.getOwnedPosition();
        if (owned && owned.entryPrice > 0) {
          filledPrice = owned.entryPrice;
          filledContracts = Math.abs(owned.positionAmt);
        }
      } catch (e: any) {
        // A failed position read is unknown, not proof that no fill exists.
        log.error(`CoinM open ${action.symbol}: position reread failed while recovering fill price: ${e.message}`);
      }
    }
    if (!(filledPrice > 0)) {
      // Real broker exposure is confirmed (filledContracts > 0) but NO price
      // is recoverable from anywhere — never quietly return failure and
      // leave an unknown-priced, unprotected position live. Emergency-close
      // it back to flat instead (same discipline as a failed stop install).
      if (filledContracts > 0) {
        log.error(`🚨 CoinM open ${action.symbol}: broker exposure ${filledContracts} contracts confirmed but NO price recoverable anywhere — emergency closing (never leaves unknown-priced exposure unprotected)`);
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "BinanceCoinMMomentumAdapter",
          message: `Ambiguous fill with no recoverable price: ${action.symbol} contracts ${filledContracts} — emergency closing`,
          count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
        });
        return this.emergencyCloseAndReport(action, filledContracts, intentId, "no_settled_price");
      }
      return { ok: false, reason: "no settled fill price" };
    }

    try {
      insertOrder({
        id: intentId, symbol: action.symbol, market: "crypto", side: action.side, type: "market",
        quantity: filledContracts, price: markPrice, status: "filled",
        externalId: String(order.orderId), filledPrice, filledAt: Date.now(),
        createdAt: Date.now(), updatedAt: Date.now(), signal,
      }, this.cfg.accountId);
    } catch (e: any) { log.warn(`order telemetry failed: ${e.message}`); }

    const stopLoss = action.side === "buy"
      ? filledPrice * (1 - this.cfg.stopLossPct / 100)
      : filledPrice * (1 + this.cfg.stopLossPct / 100);
    const nativeStop = await this.executor.placeStopMarketClose(action.symbol, action.side, stopLoss, filledContracts, intentId);
    if (!nativeStop.ok) {
      // A position with no native stop must never be left open (nothing
      // protects it if this process dies) — emergency-close it back to flat
      // and verify. Only after a POSITIVELY verified native stop do we ever
      // proceed to record the trade as open.
      log.error(`🚨 native STOP_MARKET missing for ${action.symbol} contracts=${filledContracts} — emergency closing (never leaves live exposure unprotected)`);
      eventBus.emit(EVENTS.ERROR_BURST, {
        context: "BinanceCoinMMomentumAdapter",
        message: `Native stop install failed: ${action.symbol} contracts ${filledContracts} — emergency closing`,
        count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
      });
      return this.emergencyCloseAndReport(action, filledContracts, intentId, "stop_install_failed");
    }

    const persist = await this.persistFillOrReconcile(intentId, action, filledPrice, filledContracts, stopLoss);
    if (!persist.ok) return persist;

    eventBus.emit(EVENTS.ORDER_FILLED, {
      accountId: this.cfg.accountId, symbol: action.symbol, side: action.side,
      quantity: filledContracts, filledPrice, market: "crypto", strategy: "MOMENTUM",
    });
    return { ok: true };
  }

  /** Tolerant: side mismatch or a >1e-6-contract quantity mismatch both
   *  count as "not this position's stop" — floating point round-trip
   *  through the exchange's own string formatting is the only slack. */
  private stopMatchesPosition(stop: Pick<OwnedStop, "side" | "quantity" | "triggerPrice">, expectedSide: "BUY" | "SELL", expectedQty: number, expectedTrigger: number, tickSize: number): boolean {
    return stop.side === expectedSide && Math.abs(stop.quantity - expectedQty) <= 1e-6 &&
      Math.abs(stop.triggerPrice - expectedTrigger) <= Math.max(tickSize / 2, 1e-9);
  }

  /**
   * Restart invariant: confirms any position CURRENTLY live on the broker is
   * protected by a correctly-sized, correct-side owned native stop — never
   * just "the executor's in-memory activeStops thinks something is tracked"
   * (that map is empty after every restart) and never "an owned stop merely
   * exists" (it could be a stale wrong-sized leftover from a partial-close
   * remnant). Queries the exchange fresh every time via
   * executor.listOwnedStops, exactly like the executor's own startup
   * reconcile, but ALSO verifies correctness instead of blindly adopting.
   *
   * Absent / wrong-sized / foreign-only -> reinstall from the open DB
   * trade's stop_loss (cancelActiveStop is namespace+product-scoped, so a
   * foreign stop is never touched — only our own wrong-sized one, if any,
   * gets cleared). If there's no valid stop_loss to reinstall from, or the
   * reinstall can't be POSITIVELY verified, this BLOCKS every new entry and
   * emergency-closes the position back to flat — verifying flatness before
   * ever reporting anything other than a loud orphan (same discipline as
   * emergencyCloseAndReport below).
   */
  private async verifyOrRepairLiveStop(): Promise<{ ok: boolean; reason?: string }> {
    let live;
    try { live = await this.executor.getOwnedPosition(); }
    catch (e: any) { return { ok: false, reason: `restart_invariant_position_read_failed: ${e.message}` }; }
    if (!live || live.positionAmt === 0) return { ok: true }; // nothing live to protect

    const contracts = Math.abs(live.positionAmt);
    const side: "buy" | "sell" = live.positionAmt > 0 ? "buy" : "sell";
    const expectedStopSide = side === "buy" ? "SELL" : "BUY";
    const filters = await this.executor.getFilters(COINM_INTERNAL_SYMBOL).catch(() => null);
    if (!filters) return { ok: false, reason: "restart_invariant_filters_unavailable" };
    const row = this.getOpenTradeRow(COINM_INTERNAL_SYMBOL);
    const stopLossPrice = row?.stop_loss;
    const expectedTrigger = stopLossPrice && stopLossPrice > 0
      ? Math.floor(stopLossPrice / filters.tickSize) * filters.tickSize
      : 0;

    let owned: OwnedStop[] | undefined;
    try { owned = await this.executor.listOwnedStops(COINM_INTERNAL_SYMBOL); }
    catch (e: any) {
      log.warn(`restart invariant: owned-stop query failed for ${COINM_INTERNAL_SYMBOL}: ${e.message}`);
      return { ok: false, reason: `restart_invariant_owned_stop_read_failed: ${e.message}` };
    }

    if (owned?.some(s => this.stopMatchesPosition(s, expectedStopSide, contracts,
      expectedTrigger || s.triggerPrice, filters.tickSize) && s.triggerPrice > 0)) return { ok: true };

    // Absent / wrong-sized owned stop / only-foreign present -> reinstall
    // from the DB's stop_loss (the only source of truth for what the
    // strategy actually intended to protect this position at).
    if (!(stopLossPrice && stopLossPrice > 0)) {
      log.error(`🚨 restart invariant: live ${COINM_INTERNAL_SYMBOL} (${contracts} contracts) has no valid owned stop and no DB stop_loss to reinstall from — blocking entries`);
      eventBus.emit(EVENTS.ERROR_BURST, {
        context: "BinanceCoinMMomentumAdapter",
        message: `Restart invariant: no repair source for live ${COINM_INTERNAL_SYMBOL} contracts ${contracts} — blocking entries`,
        count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
      });
      return this.emergencyCloseAndReport({ symbol: COINM_INTERNAL_SYMBOL, side }, contracts, `restart-invariant:${Date.now()}`, "restart_invariant_no_repair_source");
    }

    await this.executor.cancelActiveStop(COINM_INTERNAL_SYMBOL); // namespace+product-scoped: clears only our own wrong-sized stop, foreign stops are never touched
    const reinstalled = await this.executor.placeStopMarketClose(COINM_INTERNAL_SYMBOL, side, stopLossPrice, contracts, `restart-repair:${Date.now()}`);
    const verify = reinstalled.ok ? await this.executor.listOwnedStops(COINM_INTERNAL_SYMBOL).catch(() => null) : null;
    const repaired = verify?.some(s => this.stopMatchesPosition(s, expectedStopSide, contracts, expectedTrigger, filters.tickSize));
    if (repaired) {
      log.warn(`restart invariant: reinstalled native stop for live ${COINM_INTERNAL_SYMBOL} (${contracts} contracts) from DB stop_loss ${stopLossPrice}`);
      return { ok: true };
    }
    log.error(`🚨 restart invariant: native stop reinstall failed/unverified for live ${COINM_INTERNAL_SYMBOL} (${contracts} contracts) — blocking entries and emergency-closing`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "BinanceCoinMMomentumAdapter",
      message: `Restart invariant: stop reinstall failed/unverified for live ${COINM_INTERNAL_SYMBOL} contracts ${contracts} — emergency closing`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
    return this.emergencyCloseAndReport({ symbol: COINM_INTERNAL_SYMBOL, side }, contracts, `restart-invariant:${Date.now()}`, "restart_invariant_repair_failed");
  }

  /**
   * Emergency-closes a just-opened, unprotected (no native stop) position
   * back to flat and POSITIVELY verifies it via a broker position re-read —
   * "the close call reported success" is not proof by itself. Loudly pages
   * either way: a successful, verified close is still the direct result of a
   * stop-install failure and worth knowing about; an unverified/failed close
   * leaves real broker exposure with no protection, which is the worse case.
   */
  private async emergencyCloseAndReport(
    action: { symbol: string; side: "buy" | "sell" },
    contracts: number,
    intentId: string,
    reasonTag: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const closed = await this.executor.closePosition(action.symbol, contracts, action.side, `emergency:${intentId}`);
    if (closed.success) {
      // "closed.success" is NOT proof by itself — a fresh reread must
      // POSITIVELY prove flat before ever claiming "reconciled to flat".
      // If the reread itself throws (transport/read failure), the state is
      // UNKNOWN — never coerce that into "flat" (the old .catch(()=>null)
      // bug: an unrelated read failure would silently masquerade as a
      // verified close).
      let live: CoinMPosition | null = null;
      let rereadFailed = false;
      try { live = await this.executor.getOwnedPosition(); }
      catch (e: any) { rereadFailed = true; log.error(`🚨🚨 emergency close reported success but the reread to verify flatness FAILED for ${action.symbol}: ${e.message} — state UNKNOWN, NOT claiming flat`); }
      if (!rereadFailed && (!live || live.positionAmt === 0)) {
        log.error(`Emergency close OK for ${action.symbol} — reconciled to flat (no unprotected position left open)`);
        return { ok: false, reason: `${reasonTag}_emergency_closed` };
      }
      if (!rereadFailed) log.error(`🚨🚨 emergency close reported success but broker still shows a live ${action.symbol} position — MANUAL VERIFICATION REQUIRED`);
      eventBus.emit(EVENTS.ERROR_BURST, {
        context: "BinanceCoinMMomentumAdapter",
        message: `Emergency close unverified for ${action.symbol} contracts ${contracts}${rereadFailed ? " (flatness reread failed — state unknown)" : ""}`,
        count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
      });
      return { ok: false, reason: `${reasonTag}_emergency_close_unverified` };
    }
    log.error(`🚨🚨 ORPHAN POSITION ${action.symbol} contracts=${contracts} — UNPROTECTED (no native stop) and emergency close FAILED — MANUAL RECONCILE REQUIRED`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "BinanceCoinMMomentumAdapter",
      message: `ORPHAN unprotected position ${action.symbol} contracts ${contracts}: emergency close failed`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
    return { ok: false, reason: `${reasonTag}_emergency_close_failed` };
  }

  /**
   * Persist the trade row for a JUST-FILLED, natively-stopped position —
   * reconcile if it can't. Ported from BinanceMomentumAdapter's FAPI pattern
   * (retry once -> emergency close -> loud orphan), adapted for inverse
   * contracts (quantity is contract COUNT, entryPrice/stopLoss are already
   * inverse-correct — no linear notional math here).
   */
  private async persistFillOrReconcile(
    orderId: string,
    action: { symbol: string; side: "buy" | "sell" },
    filledPrice: number,
    filledContracts: number,
    stopLoss: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    const tradeRow = {
      id: orderId, symbol: action.symbol, market: "crypto", side: action.side, strategy: "MOMENTUM" as any,
      entryPrice: filledPrice, quantity: filledContracts, entryTime: Date.now(), status: "open", stopLoss,
    };
    if (this.tryInsert(tradeRow)) return { ok: true };

    log.error(`insertTrade FAILED after a real fill (${action.symbol} contracts=${filledContracts}) — paging + retrying once`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "BinanceCoinMMomentumAdapter",
      message: `DB persist failed after real fill: ${action.symbol} contracts ${filledContracts} — reconciling`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
    if (this.tryInsert(tradeRow)) return { ok: true };

    // Retry failed → the position is live on the broker (with a native stop)
    // but has no DB record. Close it — an unrecorded position is worse than
    // none.
    const closed = await this.executor.closePosition(action.symbol, filledContracts, action.side, `emergency:${orderId}`);
    if (closed.success) {
      // Same discipline as emergencyCloseAndReport: a reread THROW is
      // UNKNOWN state, never "flat". Only a positively-successful reread
      // proving flat/absent justifies canceling the native stop — cancelling
      // it on a failed reread could strip real protection off a live position.
      let live: CoinMPosition | null = null;
      let rereadFailed = false;
      try { live = await this.executor.getOwnedPosition(); }
      catch (e: any) { rereadFailed = true; log.error(`🚨 emergency close after DB persist failure: reread to verify flatness FAILED for ${action.symbol}: ${e.message} — state UNKNOWN, leaving native stop in place`); }
      if (!rereadFailed && (!live || live.positionAmt === 0)) {
        await this.executor.cancelActiveStop(action.symbol); // clear the native SL we placed above — position is flat now
        log.error(`Emergency close OK for ${action.symbol} — reconciled to flat (no orphan)`);
        return { ok: false, reason: "db_persist_failed_position_closed" };
      }
    }
    // Close failed, reread failed, or didn't verify flat: leave the native STOP_MARKET SL in place as a backstop.
    log.error(`🚨 ORPHAN POSITION ${action.symbol} contracts=${filledContracts} — MANUAL RECONCILE (broker holds it; DB write AND emergency close both failed/unverified; native SL left as backstop)`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "BinanceCoinMMomentumAdapter",
      message: `ORPHAN position ${action.symbol} contracts ${filledContracts}: DB write and emergency close both failed/unverified`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
    return { ok: false, reason: "db_persist_failed" };
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
    if (action.symbol !== COINM_INTERNAL_SYMBOL) return { ok: false, reason: `unsupported symbol: ${action.symbol}` };
    if (!this.executor.isConnected()) return { ok: false, reason: "binance coin-m not connected" };
    // TRAIL_STOP (or a future canonical label) from the engine; default flip label otherwise.
    const closeReason = action.closeReason && ENGINE_CLOSE_REASONS.has(action.closeReason)
      ? action.closeReason
      : "MOMENTUM_REBALANCE";

    // A read failure here is UNKNOWN state, never "flat" — cancelling the
    // protective stop on an unconfirmed read could strip protection off a
    // position that's actually still live.
    let live: CoinMPosition | null;
    try {
      live = await this.executor.getOwnedPosition();
    } catch (e: any) {
      log.error(`🚨 closePosition: position read failed for ${action.symbol}: ${e.message} — state unknown, refusing to cancel stop or claim flat`);
      return { ok: false, reason: "position read failed; state unknown" };
    }
    if (!live || live.positionAmt === 0) {
      await this.executor.cancelActiveStop(action.symbol);
      return { ok: false, reason: "broker position already flat; awaiting fill reconciliation" };
    }

    const filters = await this.executor.getFilters(COINM_INTERNAL_SYMBOL);
    const contracts = Math.abs(live.positionAmt);
    const intentId = uuid();

    // Snapshot the owned stop(s) actually protecting this position BEFORE
    // the close — the exact reconcile target for the post-close cleanup
    // below (never a blind "cancelActiveStop covers everything" assumption
    // about how many stops are live).
    let preStops: OwnedStop[];
    try {
      preStops = await this.executor.listOwnedStops(action.symbol);
    } catch (e: any) {
      log.warn(`listOwnedStops pre-close failed for ${action.symbol}: ${e.message}`);
      return { ok: false, reason: "owned stop read failed; state unknown" };
    }

    const result = await this.executor.closePosition(action.symbol, contracts, action.side, intentId);
    if (!result.success || result.filledPrice <= 0) return { ok: false, reason: "broker did not confirm close" };

    // Fetched ONCE and reused for both the partial-stage ledger accumulation
    // below and (on the final stage) the full-close PnL write — entry_price
    // never changes across stages, only quantity/stop_loss do.
    const row = this.getOpenTradeRow(action.symbol);

    // Accumulate THIS stage's broker-settled (or, when settlement is
    // unavailable, synthetic price-delta) realizedPnl/commission into the
    // row's running ledger — atomic, additive, NEVER overwrites an earlier
    // stage's numbers (see accumulatePartialCloseLedger in src/db/database.ts).
    // Every stage does this, partial or final, so the final stage's USD
    // conversion sums the TRUE total instead of just its own slice — the
    // 10->4->0 case this exists for.
    const remnant = Math.max(0, contracts - result.executedQty);
    let ledger: { realizedNative: number; commissionNative: number; commissionAsset: string; closedContracts: number } | null = null;
    if (row) {
      const grossNative = this.stageGrossNative(action.side, row.entry_price, filters, result);
      ledger = accumulatePartialCloseLedger(row.id, {
        realizedNative: grossNative,
        commissionNative: result.commissionNative || 0,
        commissionAsset: result.commissionAsset || "",
        closedContracts: result.executedQty,
        remainingContracts: remnant > 0 ? remnant : undefined,
      });
    }

    // NEVER treat any reduction as a full close — the executor now returns
    // the EXACT broker-confirmed executedQty (never falls back to the
    // requested `contracts`). A partial fill must never mark the DB row
    // fully closed, and must never leave the remnant unprotected.
    if (remnant > 0) return this.handlePartialClose(action, result, contracts, remnant, intentId, row);

    if (!await this.reconcileStopsAfterClose(action.symbol, preStops, "full close")) {
      return { ok: false, reason: "owned stop post-close read failed; state unknown" };
    }

    try {
      if (!row) return { ok: false, reason: "broker closed; no open DB row to reconcile" };

      // Convert the SUMMED native (BTC) ledger to USD exactly ONCE, at the
      // final exit price — never per-stage (that would apply the conversion
      // rate twice instead of once to the true accumulated total). Falls
      // back to this stage alone only if the ledger write itself failed
      // (row already closed by a racing process — extremely rare).
      const totals = ledger ?? { realizedNative: this.stageGrossNative(action.side, row.entry_price, filters, result), commissionNative: result.commissionNative || 0, commissionAsset: result.commissionAsset || "", closedContracts: result.executedQty };
      if (totals.commissionAsset && totals.commissionAsset !== "BTC") {
        return { ok: false, reason: `unsupported COIN-M commission asset ${totals.commissionAsset}` };
      }
      const netBtc = totals.realizedNative - totals.commissionNative;
      const pnl = netBtc * result.filledPrice;
      const positionUsdAtEntry = positionUsd(totals.closedContracts, filters.contractSize);
      const pnlPct = positionUsdAtEntry > 0 ? (pnl / positionUsdAtEntry) * 100 : 0;
      const exitTime = Date.now();

      const closed = closeTradeExplicit(row.id, result.filledPrice, exitTime, pnl, pnlPct, closeReason);
      if (!closed) return { ok: false, reason: "broker closed; DB row already closed by another process" };

      // Report the reason closeTradeExplicit actually persisted: it FORCES
      // MANUAL_CLOSE_UNRECONCILED when handed a non-finite pnl, and an event
      // claiming MOMENTUM_REBALANCE would contradict the stored row.
      eventBus.emit(EVENTS.POSITION_CLOSED, {
        id: row.id, accountId: this.cfg.accountId, symbol: action.symbol,
        exitPrice: result.filledPrice, exitTime, pnl, pnlPct,
        close_reason: closed.closeReason ?? closeReason,
      });
    } catch (e: any) {
      log.error(`Broker closed ${action.symbol}, but DB close failed: ${e.message}`);
      return { ok: false, reason: "broker closed; DB reconciliation pending" };
    }
    return { ok: true };
  }

  /** Shared open-trade-row lookup for closePosition/handlePartialClose/the
   *  restart invariant — entry_price/stop_loss are read from the SAME row
   *  regardless of which caller needs them. Tolerant of a missing/unreadable
   *  row (returns undefined, logs a warning) since every caller already has
   *  its own fallback for that case. */
  private getOpenTradeRow(symbol: string): { id: string; entry_price: number; quantity: number; stop_loss: number | null } | undefined {
    try {
      return (getDB().prepare(
        `SELECT id, entry_price, quantity, stop_loss FROM trades
         WHERE account_id = ? AND symbol = ? AND status = 'open' AND strategy = 'MOMENTUM'
         ORDER BY entry_time DESC LIMIT 1`
      ).get(this.cfg.accountId, symbol) as any) ?? undefined;
    } catch (e: any) {
      log.warn(`open trade row lookup failed for ${symbol}: ${e.message}`);
      return undefined;
    }
  }

  /**
   * Gross realized PnL (native asset, e.g. BTC) for ONE close stage. Trusts
   * the broker-settled realizedPnl from /dapi/v1/userTrades for THIS order
   * when it was actually available (commissionAsset is only ever set from a
   * real settled fill — see BinanceCoinMExecutor.fetchOrderSettlement).
   * Falls back to the price-delta inverse formula (the same math an inverse
   * contract settles by) when settlement genuinely wasn't available —
   * NEVER silently drops a stage's PnL just because userTrades was flaky.
   */
  private stageGrossNative(
    side: "buy" | "sell", entryPrice: number, filters: { contractSize: number },
    result: Pick<CoinMCloseResult, "filledPrice" | "executedQty" | "realizedPnlNative" | "commissionAsset">,
  ): number {
    if (result.commissionAsset) return result.realizedPnlNative;
    return inversePnlBtc(side, result.executedQty, filters.contractSize, entryPrice, result.filledPrice);
  }

  /**
   * Cancels the tracked stop and verifies, via a FRESH listOwnedStops read
   * (live broker state, not the stale pre-close snapshot), that nothing
   * owned still protects a now-flat position. `preStops` is logged for
   * context only — a stray stop the pre-close snapshot missed must still
   * be caught by the post-close read.
   */
  private async reconcileStopsAfterClose(
    internalSymbol: string,
    preStops: Array<{ kind: "order" | "algo"; id: string }>,
    context: string,
  ): Promise<boolean> {
    await this.executor.cancelActiveStop(internalSymbol);
    let remaining: OwnedStop[];
    try {
      remaining = await this.executor.listOwnedStops(internalSymbol);
    } catch (e: any) {
      log.warn(`listOwnedStops post-close verify failed for ${internalSymbol}: ${e.message}`);
      return false;
    }
    if (remaining.length === 0) return true;
    log.error(`🚨 ${context} for ${internalSymbol}: ${remaining.length} owned stop(s) still present after cancelActiveStop (pre-close snapshot had ${preStops.length}) — MANUAL RECONCILE REQUIRED`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "BinanceCoinMMomentumAdapter",
      message: `Stray owned stop(s) after ${context} on ${internalSymbol}: ${remaining.map(s => `${s.kind}:${s.id}`).join(",")}`,
      count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
    });
    return true;
  }

  /**
   * Partial close only: the broker reduced FEWER contracts than requested.
   * Never touches the DB "closed" state here (the remnant's PnL isn't
   * realized yet) — instead reinstalls an exact-size native stop for what's
   * left so the remnant is NEVER unprotected, shrinks the DB row's tracked
   * quantity down to the remnant so a later full close computes PnL off the
   * correct size, and returns failure so the caller (Rebalancer) retries
   * the remainder on its next pass.
   */
  private async handlePartialClose(
    action: { symbol: string; side: "buy" | "sell" },
    result: { filledPrice: number; executedQty: number },
    requested: number,
    remnant: number,
    intentId: string,
    row?: { id: string; stop_loss: number | null },
  ): Promise<{ ok: boolean; reason?: string }> {
    const stopLoss = row?.stop_loss && row.stop_loss > 0 ? row.stop_loss : undefined;
    // The original stop was sized for the FULL pre-close position; it must
    // be replaced with one sized EXACTLY to the remnant, never left at the
    // old (now too-large) size and never simply removed.
    const reinstallPrice = stopLoss ?? (action.side === "buy"
      ? result.filledPrice * (1 - this.cfg.stopLossPct / 100)
      : result.filledPrice * (1 + this.cfg.stopLossPct / 100));
    await this.executor.cancelActiveStop(action.symbol);
    let reinstalled = await this.executor.placeStopMarketClose(action.symbol, action.side, reinstallPrice, remnant, `resize:${intentId}`);
    if (reinstalled.ok) {
      // Trust-but-verify: a native-stop API success is not proof by itself
      // — confirm the remnant's protection is actually visible on the
      // broker (same discipline as the emergency-close verification above)
      // before ever reporting the remnant protected.
      const stops = await this.executor.listOwnedStops(action.symbol).catch((e: any) => {
        log.warn(`listOwnedStops remnant verify failed for ${action.symbol}: ${e.message}`);
        return null;
      });
      if (stops === null || stops.length === 0) {
        log.error(`🚨🚨 partial close remnant ${remnant}/${requested} of ${action.symbol}: placeStopMarketClose reported ok but NO owned stop is visible on the broker — MANUAL RECONCILE REQUIRED`);
        reinstalled = { ok: false };
      }
    }
    if (!reinstalled.ok) {
      log.error(`🚨 partial close left ${remnant}/${requested} contracts of ${action.symbol} UNPROTECTED (native stop reinstall failed) — MANUAL RECONCILE REQUIRED`);
      eventBus.emit(EVENTS.ERROR_BURST, {
        context: "BinanceCoinMMomentumAdapter",
        message: `Partial close remnant unprotected: ${action.symbol} contracts ${remnant}`,
        count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now(),
      });
    }
    log.warn(`CoinM partial close for ${action.symbol}: closed ${result.executedQty}/${requested} contracts @ ${result.filledPrice} — remnant ${remnant} stays open${reinstalled.ok ? " (native stop reinstalled)" : " (UNPROTECTED, see error above)"}`);
    return { ok: false, reason: reinstalled.ok ? "partial_close_remnant_protected" : "partial_close_remnant_unprotected" };
  }

  /** Seam for tests: public endpoint, no signature. */
  private async fetchKlinesRaw(product: string, limit: number): Promise<any[]> {
    const cfg = this.executor.getConfig();
    const resp = await fetchT(`${cfg.restBase}/dapi/v1/klines?symbol=${product}&interval=${this.cfg.klineInterval}&limit=${limit}`, {}, cfg.timeoutMs);
    if (!resp.ok) throw new Error(`dapi/v1/klines HTTP ${resp.status}`);
    return resp.json();
  }

  async fetchCandles(symbol: string, bars: number): Promise<OHLCV[]> {
    if (symbol !== COINM_INTERNAL_SYMBOL) return [];
    const product = this.executor.toProductSymbol(symbol);
    if (!product) return [];
    const raw = await this.fetchKlinesRaw(product, Math.min(bars, 1500));
    if (!Array.isArray(raw)) return [];
    // DAPI kline row shape: [openTime, open, high, low, close, volume, closeTime, ...]
    return raw.map((k: any[]) => ({
      timestamp: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
  }
}
