// ══════════════════════════════════════════════════════════════
// TreasurySweep — opt-in idle-cash sweep for the shared Alpaca account.
//
// OWNER-GATED, OFF BY DEFAULT: wired only when ALPACA_TREASURY_SWEEP in
// src/index.ts is non-null (default null, locked by TreasurySweep.test.ts).
// This is a NEW component on the money path of the shared account, so the
// owner flips it on explicitly — it is NOT capital reallocation: every
// sleeve keeps its own ledger untouched; the sweep only parks the ACCOUNT's
// unencumbered cash in a T-bill ETF and gives it back (sells) when the
// sleeves' entries have drawn the cash negative on margin.
//
// Two once-per-ET-day passes (both driven by a 60s tick from index.ts):
//   1. SWEEP  (≥ 10:30 ET, after both stock sleeves' ≥09:35 daily passes):
//      if account cash > cashBufferPct × equity, BUY the excess of the
//      configured ETF (BOXX). Entries of the sleeves NEVER trigger a
//      pre-sell: the account is margin, intraday buying power covers them
//      (AlpacaMomentumAdapter's shared Reg-T guard mirrors the broker
//      pre-submit), and cash simply goes negative until the cover pass.
//   2. COVER  (≥ 15:50 ET, before the close): if cash is NEGATIVE, sell
//      just enough of the ETF to bring cash back to the buffer, so the
//      account never carries a margin debit overnight. It sells ONLY the
//      treasury ETF, capped at the broker-reported quantity we actually
//      hold — sleeve positions are structurally unreachable from here
//      (and the universe-disjunction test keeps the ETF out of every
//      sleeve universe, so even an aggregate-position sell could not touch
//      a sleeve's book).
//
// Truth & idempotency: the treasury keeps NO trades rows and no ledger —
// broker truth (getAccount cash/equity + getPositions) is re-read on every
// pass. Idempotency is layered: an in-memory once-per-ET-day marker, plus
// the deterministic client_order_id placeOrder derives from entryDayKey
// (uc8-treasury-… for the sweep, uc8-treasury-eod-… for the cover), so
// even a restart that re-runs a pass is rejected broker-side as a
// duplicate (422 → resolved to the EXISTING order, never a double-buy).
// Broker read failures do nothing and leave the day marker unset (the 60s
// tick retries); an UNKNOWN order outcome marks the day done and is left
// to broker truth (never resent — repo doctrine).
//
// P&L attribution: activity_log rows under account "treasury" (event_type
// "treasury"), never a sleeve ledger. The ETF position itself is excluded
// from orphan adoption, drift detection and the native-stop pass via
// treasurySymbols.ts.
// ══════════════════════════════════════════════════════════════

import { getETDateKey, getETDayStart, insertActivity } from "../db/database";
import { isMarketOpen } from "../utils/marketHours";
import { isUnknownOrder, type UnknownOrderResult } from "../executor/executionPolicy";
import { isTreasurySymbol, TREASURY_SYMBOLS } from "./treasurySymbols";
import type { Order, Signal } from "../utils/types";
import { createLogger } from "../utils/logger";
import { v4 as uuid } from "uuid";

export { TREASURY_SYMBOLS, isTreasurySymbol };

const log = createLogger("Treasury");

export interface TreasurySweepConfig {
  /** ETF to park idle cash in — must be a member of TREASURY_SYMBOLS. */
  symbol: string;
  /** Cash cushion kept liquid, as a fraction of account equity (e.g. 0.10). */
  cashBufferPct: number;
  /** Don't bother sweeping crumbs — minimum buy notional (default $1,000). */
  minOrderNotionalUsd?: number;
}

/** accountId fed to placeOrder for the daily BUY — the client_order_id
 *  becomes `uc8-treasury-<sha16>` (deterministic per ET day, broker-side
 *  idempotent). */
export const TREASURY_SWEEP_ACCOUNT_ID = "treasury";
/** accountId for the end-of-day cover SELL — `uc8-treasury-eod-<sha16>`.
 *  Distinct from the sweep id so a same-day buy and sell can never collide
 *  on one deterministic client_order_id. */
export const TREASURY_COVER_ACCOUNT_ID = "treasury-eod";

/** Sweep window: ≥ 10:30 ET (after the ≥09:35 sleeve passes have had ~an
 *  hour to complete/retry), market open, at most once per ET day. */
export function treasurySweepDue(nowMs: number, lastRunKey: string): boolean {
  if (!isMarketOpen(nowMs)) return false;
  if ((nowMs - getETDayStart(nowMs)) / 60_000 < 10 * 60 + 30) return false;
  return getETDateKey(nowMs) !== lastRunKey;
}

/** Cover window: ≥ 15:50 ET (late enough that the day's entries/closes have
 *  settled into the cash figure, early enough to fill before the bell),
 *  market open, at most once per ET day. */
export function treasuryCoverDue(nowMs: number, lastRunKey: string): boolean {
  if (!isMarketOpen(nowMs)) return false;
  if ((nowMs - getETDayStart(nowMs)) / 60_000 < 15 * 60 + 50) return false;
  return getETDateKey(nowMs) !== lastRunKey;
}

/** The exact executor surface the sweep touches (subset of AlpacaExecutor —
 *  structural, so tests inject a plain fake). */
export interface TreasuryBroker {
  isConnected(): boolean;
  getAccount(): Promise<any | null>;
  getPositions(): Promise<{ symbol: string; quantity: number; avgEntryPrice: number }[]>;
  getLatestPrice(symbol: string): Promise<number>;
  /** Share-count fallback when no <30s price exists (AlpacaExecutor). */
  getSizingPrice?(symbol: string): Promise<number>;
  placeOrder(
    signal: Signal,
    quantity: number,
    accountId: string,
    opts: { entryDayKey?: number },
  ): Promise<Order | UnknownOrderResult | null>;
}

export class TreasurySweep {
  private lastSweepKey = "";
  private lastCoverKey = "";
  private running = false;

  constructor(
    private readonly cfg: TreasurySweepConfig,
    private readonly broker: TreasuryBroker,
    /** Maintenance kill-switch mirror (TRADING_ENABLED): gates the BUY only —
     *  the cover SELL is a close-equivalent and keeps running (closes >
     *  opens, always). */
    private readonly tradingEnabled: () => boolean = () => true,
  ) {
    if (!isTreasurySymbol(cfg.symbol)) {
      throw new Error(`TreasurySweep: symbol ${cfg.symbol} is not in TREASURY_SYMBOLS — the adoption/drift/stop exclusions would not cover it`);
    }
    if (!(cfg.cashBufferPct > 0 && cfg.cashBufferPct < 1)) {
      throw new Error(`TreasurySweep: cashBufferPct must be in (0,1), got ${cfg.cashBufferPct}`);
    }
  }

  /** Driven every ~60s by index.ts. Serialized; both passes are internally
   *  once-per-ET-day. */
  async tick(nowMs: number = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (treasurySweepDue(nowMs, this.lastSweepKey)) await this.runSweep(nowMs);
      if (treasuryCoverDue(nowMs, this.lastCoverKey)) await this.runCover(nowMs);
    } finally {
      this.running = false;
    }
  }

  /** Broker cash/equity, or null when unreadable (→ do nothing, retry). */
  private async readAccount(): Promise<{ cash: number; equity: number } | null> {
    if (!this.broker.isConnected()) return null;
    const acct = await this.broker.getAccount();
    if (!acct) return null;
    const cash = typeof acct.cash === "number" ? acct.cash : parseFloat(String(acct.cash ?? ""));
    const equity = typeof acct.equity === "number" ? acct.equity : parseFloat(String(acct.equity ?? ""));
    if (!Number.isFinite(cash) || !Number.isFinite(equity) || equity <= 0) return null;
    return { cash, equity };
  }

  /** Broker-reported quantity of the treasury ETF we hold (0 when none or
   *  when positions are unreadable — an unreadable book must never sell). */
  private async heldQty(): Promise<{ qty: number; avgEntryPrice: number }> {
    const positions = await this.broker.getPositions();
    const p = positions.find(x => x.symbol === this.cfg.symbol);
    return { qty: p?.quantity ?? 0, avgEntryPrice: p?.avgEntryPrice ?? 0 };
  }

  /** Executable (<30s) price, else the ≤5-min last trade — the price only
   *  sizes the share count of a market order. */
  private async sizingPrice(): Promise<number> {
    const executable = await this.broker.getLatestPrice(this.cfg.symbol);
    if (executable > 0) return executable;
    return (await this.broker.getSizingPrice?.(this.cfg.symbol)) ?? 0;
  }

  private signal(side: "buy" | "sell", price: number, nowMs: number, reason: string): Signal {
    return {
      id: uuid(),
      symbol: this.cfg.symbol,
      market: "stock",
      side,
      strategy: "TREASURY" as any,
      strength: "strong",
      price,
      timestamp: nowMs,
      indicators: {},
      reason,
    };
  }

  /** ≥10:30 ET: buy the cash excess over the buffer. */
  private async runSweep(nowMs: number): Promise<void> {
    const todayKey = getETDateKey(nowMs);
    const acct = await this.readAccount();
    if (!acct) { log.warn("sweep: account unreadable — doing nothing, will retry"); return; }
    const buffer = this.cfg.cashBufferPct * acct.equity;
    const excess = acct.cash - buffer;
    const minNotional = this.cfg.minOrderNotionalUsd ?? 1_000;
    if (excess < minNotional) {
      // Nothing (or crumbs) to sweep — the day is DONE, not retried: cash
      // only shrinks intraday as sleeves enter; re-checking all day would
      // buy on transient closes and churn.
      this.lastSweepKey = todayKey;
      log.info(`sweep ${todayKey}: cash $${acct.cash.toFixed(0)} ≤ buffer $${buffer.toFixed(0)} + min $${minNotional} — nothing to sweep`);
      return;
    }
    if (!this.tradingEnabled()) {
      this.lastSweepKey = todayKey;
      log.warn(`sweep ${todayKey}: TRADING_ENABLED=false — skipping the buy (maintenance kill-switch); cover sells stay active`);
      return;
    }
    const price = await this.sizingPrice();
    if (!(price > 0)) { log.warn(`sweep: no price for ${this.cfg.symbol} — will retry`); return; }
    const qty = Math.floor(excess / price);
    if (qty < 1) { this.lastSweepKey = todayKey; return; }

    const order = await this.broker.placeOrder(
      this.signal("buy", price, nowMs, `treasury sweep: cash $${acct.cash.toFixed(0)} > buffer $${buffer.toFixed(0)}`),
      qty,
      TREASURY_SWEEP_ACCOUNT_ID,
      { entryDayKey: getETDayStart(nowMs) },
    );
    if (isUnknownOrder(order)) {
      // Possibly live on the books — NEVER resend (the deterministic
      // client_order_id already protects a retry, but the doctrine is
      // resolve-by-truth, not resubmit). Day done; tomorrow's sweep
      // recomputes from real cash either way.
      this.lastSweepKey = todayKey;
      log.error(`sweep ${todayKey}: order outcome UNKNOWN (${order.reason}) — not resending; broker truth reconciles`);
      return;
    }
    if (!order) { log.warn(`sweep ${todayKey}: buy rejected/failed — will retry this ET day (idempotent client_order_id)`); return; }
    this.lastSweepKey = todayKey;
    const msg = `tesorería: swept $${(qty * price).toFixed(0)} idle cash → BUY ${qty} ${this.cfg.symbol} @ ~$${price.toFixed(2)} (cash $${acct.cash.toFixed(0)}, buffer $${buffer.toFixed(0)}, equity $${acct.equity.toFixed(0)})`;
    log.info(msg);
    try { insertActivity(TREASURY_SWEEP_ACCOUNT_ID, "treasury", msg); } catch (e: any) { log.warn(`activity write failed: ${e?.message ?? e}`); }
  }

  /** ≥15:50 ET: if cash is negative (a sleeve entry rode intraday margin),
   *  sell just enough ETF to restore the buffer before the close. */
  private async runCover(nowMs: number): Promise<void> {
    const todayKey = getETDateKey(nowMs);
    const acct = await this.readAccount();
    if (!acct) { log.warn("cover: account unreadable — doing nothing, will retry"); return; }
    if (acct.cash >= 0) {
      this.lastCoverKey = todayKey;
      return; // no margin debit — nothing to cover
    }
    const held = await this.heldQty();
    if (held.qty <= 0) {
      // Negative cash and no treasury ETF: the sleeves are levered on their
      // own — NOT this component's cash to reclaim. NEVER sell anything
      // else (sleeve positions are theirs alone).
      this.lastCoverKey = todayKey;
      log.warn(`cover ${todayKey}: cash $${acct.cash.toFixed(0)} < 0 but no ${this.cfg.symbol} held — nothing to sell (sleeve positions are never touched)`);
      return;
    }
    const price = await this.sizingPrice();
    if (!(price > 0)) { log.warn(`cover: no price for ${this.cfg.symbol} — will retry`); return; }
    const target = this.cfg.cashBufferPct * acct.equity;
    const deficit = target - acct.cash; // "volver al colchón"
    const qty = Math.min(held.qty, Math.ceil(deficit / price));
    if (qty < 1) { this.lastCoverKey = todayKey; return; }

    const order = await this.broker.placeOrder(
      this.signal("sell", price, nowMs, `treasury cover: cash $${acct.cash.toFixed(0)} < 0, restoring buffer $${target.toFixed(0)}`),
      qty,
      TREASURY_COVER_ACCOUNT_ID,
      { entryDayKey: getETDayStart(nowMs) },
    );
    if (isUnknownOrder(order)) {
      this.lastCoverKey = todayKey;
      log.error(`cover ${todayKey}: order outcome UNKNOWN (${order.reason}) — not resending; broker truth reconciles`);
      return;
    }
    if (!order) { log.warn(`cover ${todayKey}: sell rejected/failed — will retry this ET day (idempotent client_order_id)`); return; }
    this.lastCoverKey = todayKey;
    const pnlNote = held.avgEntryPrice > 0 ? ` (basis $${held.avgEntryPrice.toFixed(2)}, est P&L $${((price - held.avgEntryPrice) * qty).toFixed(2)})` : "";
    const msg = `tesorería: cash $${acct.cash.toFixed(0)} negative at EOD → SELL ${qty} ${this.cfg.symbol} @ ~$${price.toFixed(2)} to restore buffer $${target.toFixed(0)}${pnlNote}`;
    log.info(msg);
    try { insertActivity(TREASURY_SWEEP_ACCOUNT_ID, "treasury", msg); } catch (e: any) { log.warn(`activity write failed: ${e?.message ?? e}`); }
  }
}
