// ══════════════════════════════════════════════
// Binance sleeve reconciler — ONE algorithm, three sleeves (2026-08-06)
//
// Until this extraction, AccountManager carried THREE hand-copied versions of
// the same DB↔broker reconciliation: syncBinanceFutures (USDT), syncBinanceUsdc
// (USDC) and syncBinanceCoinM (COIN-M). The copies drifted exactly the way
// copies do: the USDC one shipped a bug the USDT one didn't have (the QUANTITY
// tolerance reused in the trigger-PRICE comparison — see verifyProtectiveStop),
// and nothing guaranteed the next fix would land in all three. Now:
//
//   - reconcileLinearBinanceSleeve: the FULL algorithm for the two linear
//     USDⓈ-M sleeves (USDT + USDC — same FAPI account, different margin
//     asset). Their REAL semantic differences are explicit LinearSleeveSpec
//     fields, never re-copied logic; cosmetic log/activity wording is kept
//     byte-identical to the pre-extraction copies via spec.reportClosedRow.
//   - reconcileCoinmSleeve: the DAPI inverse-contract sleeve. It shares the
//     primitives a fix must propagate through (UnreconciledGrace,
//     emergencyCloseVerified) but keeps its OWN settlement/close body as a
//     deliberate hook, because the differences are structural, not stylistic:
//       * inverse pnl comes from a partial-close LEDGER in native BTC
//         (getCloseSettlementSince + accumulatePartialCloseLedger), never
//         from linear fill attribution — closeTradeExplicit, not closeTrade;
//       * stop verification is broker-side (executor.ensureLiveStop — owned
//         algo/stop dedupe on an inverse contract), so the linear
//         verifyProtectiveStop tolerances don't apply;
//       * an orphan broker position is NEVER adopted (single-symbol sleeve;
//         a real untracked DAPI holding is exactly what truth-only mode
//         protects) — it is emergency-closed instead.
//
// This module persists NO equity_snapshots (locked by moneyWrites.test.ts):
// broker-equity truth stays in AccountManager, which remains the caller and
// owns connectivity checks, reentrancy guards and heartbeats.
// ══════════════════════════════════════════════

import { v4 as uuid } from "uuid";
import {
  getOpenTrades, closeTrade, closeTradeExplicit, insertTrade, insertActivity,
  updateTradeCloseReason, getDB, isSyncOwned, pnlOf,
  getPartialCloseLedger, accumulatePartialCloseLedger,
} from "../db/database";
import type { TradeRecord } from "../utils/types";
import { BinanceExecutor, fapiClientOrderId } from "../executor/binance-executor";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import { positionUsd, type CoinMPosition } from "../executor/binance-coinm-executor";
import { createLogger } from "../utils/logger";
import { eventBus, EVENTS } from "../utils/events";
import type { Position } from "../utils/types";

// Same logger context as before the extraction — the error-burst detector
// keys on context, and ops greps expect these lines under [AccountManager].
const log = createLogger("AccountManager");

/** Close a flat broker position after five sync cycles without attributable fills. */
export const UNRECONCILED_CLOSE_AFTER = 5;

/** A broker position younger than this may be an engine open whose DB row is
 *  still being persisted — never adopt inside the window (observed live
 *  2026-07-10: the 60s sync raced an insert and duplicated an ETH position). */
const ADOPTION_GRACE_MS = 3 * 60_000;

export function getOpenCommission(tradeId: string): number {
  const row = getDB().prepare(`SELECT open_commission FROM trades WHERE id = ?`).get(tradeId) as { open_commission?: number } | undefined;
  return row?.open_commission || 0;
}

// ── Shared primitives (a fix here reaches every sleeve) ──────────────────

/**
 * Per-sleeve consecutive-cycle counter for "broker is flat but no attributable
 * closing fill exists yet". Replaces the old SHARED `unreconciledCounts` map
 * keyed by trade UUID, which was never pruned — an unbounded leak (every trade
 * that ever hit the grace path and then closed through another path left its
 * counter behind forever). Same self-bounding pattern as AccountManager's
 * unavailablePriceMisses: endPass() prunes every key that was not bumped this
 * pass, which also makes the count genuinely CONSECUTIVE for all sleeves (the
 * USDT copy already reset on a broker re-match; USDC/COIN-M didn't).
 * endPass() must only run when the pass COMPLETED — an aborted pass keeps the
 * counters so a transient broker error can't reset an escalation in progress.
 */
export class UnreconciledGrace {
  private counts = new Map<string, number>();
  private bumped = new Set<string>();

  beginPass(): void { this.bumped.clear(); }

  bump(tradeId: string): number {
    const count = (this.counts.get(tradeId) ?? 0) + 1;
    this.counts.set(tradeId, count);
    this.bumped.add(tradeId);
    return count;
  }

  clear(tradeId: string): void {
    this.counts.delete(tradeId);
    this.bumped.delete(tradeId);
  }

  /** Prune every counter not bumped this pass. Call ONLY on a completed pass. */
  endPass(): void {
    for (const key of this.counts.keys()) {
      if (!this.bumped.has(key)) this.counts.delete(key);
    }
  }

  get size(): number { return this.counts.size; }
}

export interface ProtectiveOrderReadback {
  symbol: string;
  side: string;
  quantity: number;
  triggerPrice: number;
  reduceOnly: boolean;
}

/**
 * THE single copy of the protective-stop read-back verification — the exact
 * code whose duplication caused the historical bug this module exists to
 * prevent: the USDC copy reused the QUANTITY tolerance in the trigger (PRICE)
 * comparison, so on cheap high-qty symbols (DOGE/ADA/XRP) an absurd trigger
 * passed as "protection" and could adopt an UNPROTECTED position.
 * Tolerances are SEPARATE and unit-correct: quantity must cover ~the whole
 * position (rejects partial stops; positionAmt is already lot-step aligned so
 * an exact-ish match holds), and the trigger must be on the PROTECTIVE side of
 * entry AND within 1% of the expected stop PRICE — a near-zero/far trigger is
 * not real protection.
 */
export function verifyProtectiveStop(
  orders: ProtectiveOrderReadback[],
  exp: { brokerSymbol: string; positionSide: "buy" | "sell"; entryPrice: number; stopPrice: number; quantity: number },
): boolean {
  const qtyTol = Math.max(exp.quantity * 1e-3, 1e-8);
  const trigTol = Math.max(exp.stopPrice * 0.01, 1e-8);
  const closeSide = exp.positionSide === "buy" ? "SELL" : "BUY";
  return orders.some(order => {
    if (order.symbol !== exp.brokerSymbol || !order.reduceOnly || order.side !== closeSide) return false;
    if (!Number.isFinite(order.quantity) || Math.abs(order.quantity - exp.quantity) > qtyTol) return false;
    const trigger = order.triggerPrice;
    if (!Number.isFinite(trigger) || trigger <= 0) return false;
    const onProtectiveSide = exp.positionSide === "buy" ? trigger < exp.entryPrice : trigger > exp.entryPrice;
    return onProtectiveSide && Math.abs(trigger - exp.stopPrice) <= trigTol;
  });
}

/** Expected stop trigger at profile.stopLossPct from entry, protective side. */
export function stopPriceFromEntry(side: "buy" | "sell", entryPrice: number, stopLossPct: number): number {
  return side === "buy"
    ? entryPrice * (1 - stopLossPct / 100)
    : entryPrice * (1 + stopLossPct / 100);
}

/**
 * The one verdict for "did the emergency close verifiably flatten the
 * position?" — shared by all three sleeves. A reread that FAILED is UNKNOWN
 * state, never proof of flat (final-reviewer blocker, locked for COIN-M by
 * coinmUsdcSleeves.test.ts and now structurally shared with USDT/USDC).
 */
export function emergencyCloseVerified(closeSuccess: boolean, rereadOk: boolean, remainingAmt: number): boolean {
  return closeSuccess && rereadOk && remainingAmt === 0;
}

// ── Linear (USDⓈ-M) sleeves: USDT + USDC ─────────────────────────────────

export interface LinearBrokerPosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  unrealizedProfit: number;
  updateTime: number;
}

/** Structural view of BinanceExecutor — exactly what the reconciler touches. */
export interface LinearSleeveExecutor {
  getPositions(): Promise<LinearBrokerPosition[]>;
  getRecentTrades(binanceSymbol: string, limit: number, sinceMs?: number): Promise<{ realizedPnl: number; commission: number; price: number; qty: number; side: string; time: number }[]>;
  hasFilledStopClose(binanceSymbol: string, closeSide: "BUY" | "SELL", qty: number, sinceMs: number): Promise<boolean>;
  placeStopMarketClose(internalSymbol: string, positionSide: "buy" | "sell", stopPrice: number, quantity?: number, clientOrderId?: string): Promise<boolean>;
  getOpenProtectiveOrders(symbol?: string): Promise<ProtectiveOrderReadback[]>;
  cancelAllOrders(internalSymbol: string, opts?: { aggregateFlat?: boolean }): Promise<void>;
  closePosition(symbol: string, quantity: number, side: "buy" | "sell"): Promise<{ success: boolean }>;
  getAlgoOrderHistory?(binanceSymbol: string, sinceMs?: number): Promise<any[]>;
}

/** The slice of AccountInstance the reconciler needs (structural — this
 *  module never imports AccountManager, so no cycle). */
export interface SleeveAccount {
  profile: { stopLossPct: number };
  positions: Map<string, Position>;
}

export interface ClosedRowReport {
  effReason: string;
  symbol: string;
  pnl: number;
  exitPrice: number;
  graceCycles: number;
  /** true when the close is the no-attributable-fills fallback (grace expired). */
  unreconciled: boolean;
  /** true when settlement was unavailable or returned no closing fills. */
  settlementFallback: boolean;
}

/**
 * The REAL per-sleeve differences, parameterized explicitly (never flattened):
 * every field below is a divergence that existed between the two hand-written
 * copies and is preserved verbatim.
 */
export interface LinearSleeveSpec {
  accountId: "momentum_crypto" | "momentum_crypto_usdc";
  /** Brand for orphan/emergency/settlement lines + error activity rows ("Binance"/"USDC"). */
  brand: string;
  /** The `📡 <tag>:` prefix of sync log lines ("Sync"/"USDC sync"). */
  syncTag: string;
  toBrokerSymbol(internal: string): string | null | undefined;
  toInternalSymbol(brokerSymbol: string): string | null | undefined;
  /** USDT lets a settlement (getRecentTrades) throw abort the whole pass
   *  (outer catch logs "sync failed", heartbeat skipped); USDC catches
   *  per-trade and proceeds to the fallback-price close after the grace. */
  settlementFailure: "abort-pass" | "per-trade-fallback";
  /** USDT refreshes the in-memory unrealized PnL from the broker when a row
   *  matches a live position; USDC has never surfaced that (display-only). */
  refreshUnrealizedOnMatch: boolean;
  /** Which open rows block orphan adoption: USDT checks EVERY non-shadow
   *  account's open rows (incl. sync_-owned); USDC only its own sleeve's
   *  non-sync-owned rows (its positions are product-scoped to its symbol map). */
  orphanBlockScope: "all-non-shadow" | "sleeve-open-rows";
  /** Also attribute a stop via the algo-order history endpoint. BOTH linear
   *  sleeves need this: they share BinanceExecutor.placeStopMarketClose,
   *  whose −4120 fallback lands stops as algo orders — filled algo orders
   *  are invisible to /fapi/v1/allOrders, the only store hasFilledStopClose
   *  reads. (Was USDC-only until 2026-08-19 — a refactor artifact preserved
   *  verbatim, which left momentum_crypto with ZERO BROKER_STOP_LOSS closes
   *  in its whole history while USDC attributed 5.) */
  algoOrderStopAttribution: boolean;
  /** USDT logs a warn line when it detects a flat-on-broker open row. */
  logFlatDetection: boolean;
  /** USDT logs a debug line when adoption defers inside the 3-min grace. */
  logAdoptionGrace: boolean;
  /** Sleeve-branded close reporting (activity row + log line), byte-identical
   *  to the pre-extraction copies — cosmetic only, all money logic is above. */
  reportClosedRow(info: ClosedRowReport): void;
}

export const USDT_SLEEVE_SPEC: LinearSleeveSpec = {
  accountId: "momentum_crypto",
  brand: "Binance",
  syncTag: "Sync",
  toBrokerSymbol: (internal) => BinanceExecutor.toBinanceSymbol(internal),
  toInternalSymbol: (broker) => BinanceExecutor.toAlpacaSymbol(broker),
  settlementFailure: "abort-pass",
  refreshUnrealizedOnMatch: true,
  orphanBlockScope: "all-non-shadow",
  algoOrderStopAttribution: true,
  logFlatDetection: true,
  logAdoptionGrace: true,
  reportClosedRow: ({ effReason, symbol, pnl, exitPrice, graceCycles, unreconciled }) => {
    if (unreconciled) {
      log.error(`🛑 UNRECONCILED close ${symbol}: flat on broker, no attributable fills after ${graceCycles} cycles — closed at $${exitPrice}`);
      insertActivity("momentum_crypto", "circuit", `UNRECONCILED CLOSE: ${symbol} flat on broker, no fills after ${graceCycles} cycles`);
    } else {
      insertActivity("momentum_crypto", "close", `${effReason === "BROKER_STOP_LOSS" ? "BROKER STOP" : "EXTERNAL CLOSE"}: ${symbol} PnL $${pnl.toFixed(2)}`);
      log.info(`📡 ${effReason} closed ${symbol} [momentum_crypto]: PnL=$${pnl.toFixed(4)}`);
    }
  },
};

const REVERSE_USDC_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(USDC_SYMBOL_MAP).map(([internal, native]) => [native, internal]),
);

export const USDC_SLEEVE_SPEC: LinearSleeveSpec = {
  accountId: "momentum_crypto_usdc",
  brand: "USDC",
  syncTag: "USDC sync",
  toBrokerSymbol: (internal) => USDC_SYMBOL_MAP[internal],
  toInternalSymbol: (broker) => REVERSE_USDC_MAP[broker],
  settlementFailure: "per-trade-fallback",
  refreshUnrealizedOnMatch: false,
  orphanBlockScope: "sleeve-open-rows",
  algoOrderStopAttribution: true,
  logFlatDetection: false,
  logAdoptionGrace: false,
  reportClosedRow: ({ effReason, symbol, pnl, settlementFallback }) => {
    insertActivity("momentum_crypto_usdc", "close", `${effReason}: ${symbol} flat on broker (USDC), PnL $${pnl.toFixed(2)}`);
    const label = settlementFallback ? " [fallback; fill settlement unavailable]" : "";
    if (label) log.warn(`📡 USDC sync: ${effReason} close ${symbol} — PnL=$${pnl.toFixed(4)}${label}`);
    else log.info(`📡 USDC sync: ${effReason} close ${symbol} — PnL=$${pnl.toFixed(4)}`);
  },
};

export interface LinearReconcileDeps {
  exec: LinearSleeveExecutor;
  acc: SleeveAccount;
  grace: UnreconciledGrace;
}

/**
 * The full linear-sleeve reconciliation pass:
 *   Phase 1 — open in DB, flat on broker → attribute closing fills (grace via
 *             UnreconciledGrace when none are attributable) and close the row
 *             with the correct broker-derived reason.
 *   Phase 2 — on broker, not in DB → arm + VERIFY a native stop, then adopt
 *             as SYNC_RECOVERY; an unverifiable stop emergency-closes the
 *             orphan (bounded to a fresh re-read) instead of adopting it.
 * Throws propagate to the caller's sync wrapper (same contract as before the
 * extraction: the pass aborts, counters are NOT pruned, heartbeat is skipped).
 */
export async function reconcileLinearBinanceSleeve(deps: LinearReconcileDeps, spec: LinearSleeveSpec): Promise<void> {
  const { exec, acc, grace } = deps;
  grace.beginPass();

  const brokerPositions = await exec.getPositions();
  const posMap = new Map<string, LinearBrokerPosition>();
  for (const p of brokerPositions) {
    const internal = spec.toInternalSymbol(p.symbol);
    if (internal) posMap.set(internal, p);
  }

  // Ownership boundary: sync_/BROKER_SYNC rows are BrokerSync's.
  const openDb = getOpenTrades(spec.accountId).filter(t => !isSyncOwned(t));

  // Phase 1 — closed on the broker but open in DB.
  for (const trade of openDb) {
    const live = posMap.get(trade.symbol);
    if (live && live.positionAmt !== 0) {
      grace.clear(trade.id); // consecutive semantics: a re-match resets the count
      if (spec.refreshUnrealizedOnMatch) {
        const pos = acc.positions.get(trade.symbol);
        if (pos) {
          // live.unrealizedProfit is the broker's AGGREGATE position PnL for
          // the symbol. When the broker holds MORE than this row (untracked
          // residue from external/unreconciled closes — prod 2026-08-19:
          // broker LINKUSDT 785.75 @ 9.27 vs row 198 @ 9.49 → the row showed
          // the aggregate's +$881 instead of its own +$176), copying it
          // absorbs the whole aggregate. Recover the broker's mark price
          // (linear contracts: uPnL = amt × (mark − entry), amt signed) and
          // scope the PnL to OUR row's entry/quantity.
          const mark = live.entryPrice + live.unrealizedProfit / live.positionAmt;
          if (Number.isFinite(mark) && mark > 0) {
            const { pnl, pnlPct } = pnlOf(pos.side, pos.avgEntryPrice, mark, pos.quantity);
            pos.currentPrice = mark;
            pos.unrealizedPnl = pnl;
            pos.unrealizedPnlPct = pnlPct;
          }
        }
      }
      continue;
    }
    await closeFlatRow(exec, acc, grace, spec, trade);
  }

  // Phase 2 — on the broker but not tracked → protect-then-adopt.
  // shadow_* rows are simulated fills (no broker position behind them) — they
  // must not mask a genuinely untracked broker position. Adoption is
  // UNCONDITIONAL (2026-07-29/30 single-deployment consolidation): this bot is
  // the sole trader of the account, so an untracked position is always ours.
  const blockers: TradeRecord[] = spec.orphanBlockScope === "all-non-shadow"
    ? getOpenTrades().filter(t => !(t.accountId ?? "").startsWith("shadow_"))
    : openDb;
  for (const [internal, p] of posMap) {
    if (p.positionAmt === 0) continue;
    if (blockers.some(t => t.symbol === internal)) continue;
    if (acc.positions.has(internal)) continue;
    if (p.updateTime && Date.now() - p.updateTime < ADOPTION_GRACE_MS) {
      if (spec.logAdoptionGrace) log.debug(`📡 ${spec.syncTag}: ${internal} broker position is <3min old — deferring adoption (engine may still be persisting it)`);
      continue;
    }

    const side: "buy" | "sell" = p.positionAmt > 0 ? "buy" : "sell";
    const quantity = Math.abs(p.positionAmt);
    const stopPrice = stopPriceFromEntry(side, p.entryPrice, acc.profile.stopLossPct);

    // Arm a broker-native stop BEFORE adopting: install, read back, and only
    // trust a VERIFIED protective order; anything less emergency-closes the
    // position rather than adopting it unprotected.
    let protectedLive = false;
    try {
      const placed = await exec.placeStopMarketClose(internal, side, stopPrice, quantity, fapiClientOrderId(`reconcile:${internal}:${Date.now()}`));
      if (placed) {
        const protectiveOrders = await exec.getOpenProtectiveOrders(p.symbol);
        protectedLive = verifyProtectiveStop(protectiveOrders, {
          brokerSymbol: p.symbol, positionSide: side, entryPrice: p.entryPrice, stopPrice, quantity,
        });
      }
    } catch (e: any) {
      log.error(`${spec.brand} orphan ${internal}: native stop install failed: ${e?.message ?? e}`);
    }
    if (!protectedLive) {
      await emergencyCloseUnprotectedOrphan(exec, spec, internal, p.symbol, quantity, side);
      continue;
    }

    const now = Date.now();
    insertTrade({
      id: uuid(), symbol: internal, market: "crypto", side, strategy: "SYNC_RECOVERY",
      entryPrice: p.entryPrice, quantity, entryTime: now, status: "open",
    } as any, spec.accountId);
    acc.positions.set(internal, {
      symbol: internal, market: "crypto", side: side as any, quantity,
      avgEntryPrice: p.entryPrice, currentPrice: p.entryPrice,
      unrealizedPnl: p.unrealizedProfit, unrealizedPnlPct: 0, openedAt: now,
    });
    log.warn(`📡 ${spec.syncTag}: ${internal} exists on Binance but not in DB${spec.accountId === "momentum_crypto" ? " [momentum_crypto]" : ""} — recovered`);
    insertActivity(spec.accountId, "sync", `Recovered ${internal} from ${spec.accountId === "momentum_crypto" ? "Binance" : "Binance USDC"}: ${side} ${quantity} @ $${p.entryPrice.toFixed(2)}`);
  }

  grace.endPass(); // completed pass → prune counters not bumped this pass
}

/** Phase-1 close of a single flat-on-broker row: attribute closing fills,
 *  grace when none exist, then close with the broker-derived reason. */
async function closeFlatRow(
  exec: LinearSleeveExecutor,
  acc: SleeveAccount,
  grace: UnreconciledGrace,
  spec: LinearSleeveSpec,
  trade: TradeRecord,
): Promise<void> {
  if (spec.logFlatDetection) {
    log.warn(`📡 ${spec.syncTag}: ${trade.symbol} closed on Binance but open in DB [${spec.accountId}] — attributing broker fills`);
  }
  const bnSymbol = spec.toBrokerSymbol(trade.symbol);
  if (!bnSymbol) return;
  const closeSide = trade.side === "buy" ? "SELL" : "BUY";

  let closingFills: { realizedPnl: number; commission: number; price: number; qty: number; side: string; time: number }[] = [];
  let settlementFailed = false;
  const fetchFills = async () => {
    const recentTrades = await exec.getRecentTrades(bnSymbol, 1000, trade.entryTime);
    return recentTrades.filter(fill =>
      fill.time >= trade.entryTime && fill.side?.toUpperCase() === closeSide && fill.qty > 0 && fill.price > 0
    );
  };
  if (spec.settlementFailure === "abort-pass") {
    closingFills = await fetchFills(); // a throw aborts the whole pass (outer catch)
  } else {
    try {
      closingFills = await fetchFills();
    } catch (e: any) {
      settlementFailed = true;
      log.error(`${spec.brand} close settlement unavailable for ${trade.symbol}: ${e?.message ?? e}`);
    }
  }

  const cached = acc.positions.get(trade.symbol)?.currentPrice;
  const closedQty = closingFills.reduce((sum, fill) => sum + fill.qty, 0);
  const exitPrice = closedQty > 0
    ? closingFills.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / closedQty
    : (cached && cached > 0 ? cached : trade.entryPrice);
  const closeCommission = closingFills.reduce((sum, fill) => sum + fill.commission, 0);
  const grossPnl = closingFills.reduce((sum, fill) => sum + fill.realizedPnl, 0);
  const pnl = closedQty > 0
    ? grossPnl - closeCommission - getOpenCommission(trade.id)
    : pnlOf(trade.side, trade.entryPrice, exitPrice, trade.quantity).pnl;

  let graceCycles = 0;
  if (closedQty === 0) {
    graceCycles = grace.bump(trade.id);
    if (graceCycles < UNRECONCILED_CLOSE_AFTER) {
      log.warn(`📡 ${spec.syncTag}: ${trade.symbol} is flat but no attributable closing fill is available — leaving DB open (${graceCycles}/${UNRECONCILED_CLOSE_AFTER})`);
      return;
    }
  }

  const exitTime = closingFills.length > 0 ? Math.max(...closingFills.map(fill => fill.time || 0)) || Date.now() : Date.now();
  // Stop attribution reads two stores (regular orders + algo orders — the
  // −4120 fallback in placeStopMarketClose lands stops in the latter, where
  // /fapi/v1/allOrders can't see them). A READ FAILURE is unknown state,
  // never the positive claim "not a stop": the old `.catch(() => false)`
  // silently converted an outage into MANUAL_CLOSE. A positive finding from
  // either store wins; a failed read with no positive finding degrades the
  // label to MANUAL_CLOSE_UNRECONCILED — honest "don't know".
  let stopFilled = false;
  let attributionUnavailable = false;
  if (closedQty > 0) {
    try {
      stopFilled = await exec.hasFilledStopClose(bnSymbol, closeSide, trade.quantity, trade.entryTime);
    } catch (e: any) {
      attributionUnavailable = true;
      log.warn(`${spec.brand} stop attribution: order history unavailable for ${trade.symbol}: ${e?.message ?? e}`);
    }
  }
  if (spec.algoOrderStopAttribution && closedQty > 0 && !stopFilled) {
    try {
      const algoOrders = await exec.getAlgoOrderHistory!(bnSymbol, trade.entryTime);
      stopFilled = algoOrders.some((order: any) => {
        const status = String(order.algoStatus ?? order.status ?? order.orderStatus ?? "").toUpperCase();
        const type = String(order.orderType ?? order.type ?? order.actualOrderType ?? "").toUpperCase();
        const qty = Number(order.executedQty ?? order.totalQty ?? order.quantity ?? order.qty ?? 0);
        return ["FILLED", "TRIGGERED", "FINISHED"].includes(status) && type.includes("STOP") &&
          String(order.side ?? "").toUpperCase() === closeSide && qty + 1e-12 >= trade.quantity &&
          (Number(order.updateTime ?? order.triggerTime ?? order.time ?? 0) || 0) >= trade.entryTime;
      });
    } catch (e: any) {
      attributionUnavailable = true;
      log.warn(`${spec.brand} stop attribution: algo-order history unavailable for ${trade.symbol}: ${e?.message ?? e}`);
    }
  }

  // Broker realized PnL as overridePnl so pnl AND pnl_pct derive from the same
  // number (their signs can't disagree).
  const reason = closedQty > 0
    ? (stopFilled ? "BROKER_STOP_LOSS" : attributionUnavailable ? "MANUAL_CLOSE_UNRECONCILED" : "MANUAL_CLOSE")
    : "MANUAL_CLOSE_UNRECONCILED";
  const result = closeTrade(trade.id, exitPrice, exitTime, closeCommission, pnl);
  if (!result) return;

  acc.positions.delete(trade.symbol);
  grace.clear(trade.id);
  // closeTrade forces close_reason=MANUAL_CLOSE_UNRECONCILED when both the
  // broker PnL and the price-derived PnL are non-finite (fabricated-zero row,
  // excluded from strategy stats) — never clobber that with the computed reason.
  if (result.closeReason !== "MANUAL_CLOSE_UNRECONCILED") {
    try { updateTradeCloseReason(trade.id, reason); } catch {}
  }
  const effReason = result.closeReason ?? reason;
  eventBus.emit(EVENTS.POSITION_CLOSED, { ...result, accountId: spec.accountId, close_reason: effReason });
  spec.reportClosedRow({
    effReason, symbol: trade.symbol, pnl: result.pnl, exitPrice, graceCycles,
    unreconciled: closedQty === 0,
    settlementFallback: settlementFailed || closingFills.length === 0,
  });
}

/** Emergency-close an orphan whose native stop could not be verified. Bounded
 *  to the broker's CURRENT amount, re-read at the moment of the destructive
 *  call — the sync-pass read can be stale (a stop may have fired, a manual
 *  close may have reduced). A failed re-read is UNKNOWN, never flat: the close
 *  still proceeds with the recorded quantity because an unprotected orphan
 *  must not stay open, but a confirmed-flat re-read skips it. */
async function emergencyCloseUnprotectedOrphan(
  exec: LinearSleeveExecutor,
  spec: LinearSleeveSpec,
  internal: string,
  brokerSymbol: string,
  quantity: number,
  side: "buy" | "sell",
): Promise<void> {
  let freshAbs: number | null = null;
  try {
    freshAbs = Math.abs((await exec.getPositions()).find(pos => pos.symbol === brokerSymbol)?.positionAmt ?? 0);
  } catch (e: any) {
    log.warn(`${spec.brand} orphan ${internal}: fresh position re-read failed (${e?.message ?? e}) — proceeding with the sync-pass quantity`);
  }
  if (freshAbs === 0) {
    // Went flat on its own — nothing to adopt or close; clear any stop we
    // just installed for it (aggregate confirmed flat).
    await exec.cancelAllOrders(internal, { aggregateFlat: true });
    log.info(`📡 ${spec.syncTag}: orphan ${internal} went flat before the emergency close — nothing to adopt`);
    return;
  }
  const closeQty = Math.min(quantity, freshAbs ?? quantity);
  const close = await exec.closePosition(internal, closeQty, side);
  let stillLive: LinearBrokerPosition[] | null = null;
  try { stillLive = await exec.getPositions(); }
  catch (e: any) { log.error(`${spec.brand} orphan ${internal}: post-emergency-close verification failed: ${e?.message ?? e}`); }
  const remaining = stillLive?.find(pos => pos.symbol === brokerSymbol)?.positionAmt ?? 0;
  if (!emergencyCloseVerified(close.success, stillLive !== null, remaining)) {
    log.error(`🚨 ${spec.brand} orphan ${internal} is unprotected and emergency close was not verified — MANUAL RECONCILE REQUIRED`);
    insertActivity(spec.accountId, "error", `${spec.brand} unprotected orphan ${internal}: emergency close not verified`);
  } else {
    log.error(`${spec.brand} orphan ${internal}: native stop unavailable; emergency-closed and verified flat`);
  }
}

// ── COIN-M (DAPI inverse) sleeve ─────────────────────────────────────────

/** Structural view of BinanceCoinMExecutor — what the reconciler touches. */
export interface CoinmSleeveExecutor {
  getOwnedPosition(): Promise<CoinMPosition | null>;
  getFilters(internalSymbol: string): Promise<{ contractSize: number }>;
  getCloseSettlementSince(internalSymbol: string, side: "buy" | "sell", since: number): Promise<{
    realizedPnlNative: number; commissionNative: number; commissionAsset: string;
    executedQty: number; averagePrice: number;
  }>;
  ensureLiveStop(internalSymbol: string, position: CoinMPosition, stopLoss: number): Promise<boolean>;
  closePosition(internalSymbol: string, contracts: number, side: "buy" | "sell", intentId: string): Promise<{ success: boolean }>;
}

export interface CoinmReconcileDeps {
  exec: CoinmSleeveExecutor;
  acc: SleeveAccount;
  grace: UnreconciledGrace;
}

/**
 * momentum_btc reconciliation — same three-way skeleton as the linear sleeves
 * (flat rows closed with grace / live position's stop verified / orphan never
 * left unprotected) but with the inverse-contract semantics kept as explicit
 * hooks rather than flattened into the linear path (see the module header):
 * ledger-based settlement in native BTC via closeTradeExplicit, executor-side
 * stop verification (ensureLiveStop), and emergency close — NEVER adoption —
 * for an orphan broker position. The caller (syncBinanceCoinM) must NOT invoke
 * this in truth-only mode: a real untracked DAPI holding would be
 * emergency-closed as an "orphan".
 */
export async function reconcileCoinmSleeve(deps: CoinmReconcileDeps): Promise<void> {
  const { exec, acc, grace } = deps;
  grace.beginPass();

  const pos = await exec.getOwnedPosition();
  const openDb = getOpenTrades("momentum_btc").filter(t => !isSyncOwned(t));
  const live = pos && pos.positionAmt !== 0;

  if (!live) {
    for (const trade of openDb) {
      const filters = await exec.getFilters(trade.symbol).catch(() => null);
      const settlement = await exec.getCloseSettlementSince(trade.symbol, trade.side, trade.entryTime);
      const prior = getPartialCloseLedger(trade.id);
      const newlyClosed = Math.max(0, settlement.executedQty - prior.closedContracts);
      const ledger = newlyClosed > 0
        ? accumulatePartialCloseLedger(trade.id, {
          realizedNative: settlement.realizedPnlNative - prior.realizedNative,
          commissionNative: settlement.commissionNative - prior.commissionNative,
          commissionAsset: settlement.commissionAsset,
          closedContracts: newlyClosed,
        })
        : prior;
      const totals = ledger ?? prior;
      const exitPrice = settlement.averagePrice > 0
        ? settlement.averagePrice
        : (acc.positions.get(trade.symbol)?.currentPrice || trade.entryPrice);
      if (settlement.executedQty === 0) {
        const cnt = grace.bump(trade.id);
        if (cnt < UNRECONCILED_CLOSE_AFTER) {
          log.warn(`📡 COIN-M sync: ${trade.symbol} is flat but no attributable closing fill is available — leaving DB open (${cnt}/${UNRECONCILED_CLOSE_AFTER})`);
          continue;
        }
      }
      const pnl = settlement.executedQty > 0 && (!settlement.commissionAsset || settlement.commissionAsset === "BTC")
        ? (totals.realizedNative - totals.commissionNative) * exitPrice
        : 0;
      const notionalAtEntry = filters ? positionUsd(Math.max(totals.closedContracts, trade.quantity), filters.contractSize) : 0;
      const pnlPct = notionalAtEntry > 0 ? (pnl / notionalAtEntry) * 100 : 0;
      const reconciledCommission = !settlement.commissionAsset || settlement.commissionAsset === "BTC";
      const reason = settlement.executedQty > 0 && reconciledCommission ? "MANUAL_CLOSE" : "MANUAL_CLOSE_UNRECONCILED";
      if (settlement.executedQty > 0 && !reconciledCommission) {
        log.error(`COIN-M close ${trade.symbol}: unexpected commission asset ${settlement.commissionAsset}; storing as MANUAL_CLOSE_UNRECONCILED`);
      }
      const closed = closeTradeExplicit(trade.id, exitPrice, Date.now(), pnl, pnlPct, reason);
      if (closed) {
        acc.positions.delete(trade.symbol);
        grace.clear(trade.id);
        // closeTradeExplicit may FORCE close_reason to MANUAL_CLOSE_UNRECONCILED
        // when the pnl it was handed is non-finite. Report the reason that was
        // actually persisted, not the one we asked for — otherwise the event,
        // the activity row and the log all contradict the DB row.
        const effReason = closed.closeReason ?? reason;
        eventBus.emit(EVENTS.POSITION_CLOSED, { ...closed, accountId: "momentum_btc", close_reason: effReason });
        insertActivity("momentum_btc", "close", `${trade.symbol} flat on broker (COIN-M), ${effReason} — closed at $${exitPrice.toFixed(2)}`);
        log.warn(`📡 COIN-M sync: ${effReason} ${trade.symbol} — flat on broker`);
      }
    }
  } else if (openDb.length > 0) {
    const trade = openDb[0];
    const protectedLive = (trade.stopLoss ?? 0) > 0 && await exec.ensureLiveStop(trade.symbol, pos!, trade.stopLoss!);
    if (!protectedLive) {
      const side: "buy" | "sell" = pos!.positionAmt > 0 ? "buy" : "sell";
      const closed = await exec.closePosition(trade.symbol, Math.abs(pos!.positionAmt), side, `reconcile-unprotected:${trade.id}`);
      // A reread THROW is UNKNOWN state, never proof of flat — must not fall
      // through to the "verified flat" branch below (emergencyCloseVerified).
      let stillLive: CoinMPosition | null = null;
      let rereadFailed = false;
      try { stillLive = await exec.getOwnedPosition(); }
      catch (e: any) { rereadFailed = true; log.warn(`COIN-M reread after emergency close failed for ${trade.symbol}: ${e.message}`); }
      if (!emergencyCloseVerified(closed.success, !rereadFailed, stillLive?.positionAmt ?? 0)) {
        log.error(`🚨 COIN-M live ${trade.symbol} is unprotected and emergency close was not verified — MANUAL RECONCILE REQUIRED`);
        insertActivity("momentum_btc", "error", `COIN-M unprotected orphan ${trade.symbol}: emergency close not verified`);
      } else {
        log.error(`COIN-M unprotected ${trade.symbol} emergency-closed and verified flat`);
      }
    }
  } else {
    // Orphan broker position with no DB row: emergency close, NEVER adopt
    // (see the docstring above — this branch must not run in truth-only mode).
    const side: "buy" | "sell" = pos!.positionAmt > 0 ? "buy" : "sell";
    const closed = await exec.closePosition("BTC/COIN-M", Math.abs(pos!.positionAmt), side, `reconcile-orphan:${Date.now()}`);
    let stillLive: CoinMPosition | null = null;
    let rereadFailed = false;
    try { stillLive = await exec.getOwnedPosition(); }
    catch (e: any) { rereadFailed = true; log.warn(`COIN-M reread after orphan emergency close failed: ${e.message}`); }
    if (!emergencyCloseVerified(closed.success, !rereadFailed, stillLive?.positionAmt ?? 0)) {
      log.error(`🚨 COIN-M broker position has no DB trade and emergency close was not verified — MANUAL RECONCILE REQUIRED`);
      insertActivity("momentum_btc", "error", "COIN-M unprotected orphan: no DB stop source and close not verified");
    } else {
      log.error("COIN-M broker position had no DB trade; emergency-closed and verified flat");
    }
  }

  grace.endPass();
}
