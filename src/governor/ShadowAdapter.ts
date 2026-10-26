// ══════════════════════════════════════════════
// ShadowAdapter — simulated broker for shadow sleeves
// ══════════════════════════════════════════════
//
// Implements the MomentumBrokerAdapter interface with ZERO broker calls:
// opens/closes are simulated fills at the current market price ± 2bps
// adverse slippage, persisted as ordinary trades rows under a "shadow_*"
// account id. The engines (MomentumEngine / MeanRevEngine) can't tell the
// difference — same interface, same DB bookkeeping.
//
// KNOWN BIAS (document per spec): shadow fills have NO hard-SL simulation.
// AccountManager.checkAllStopLoss only loops ALL_PROFILE_IDS, so shadow
// positions exit ONLY via engine logic (SMA exit / time stop / rebalance).
// A live sleeve would additionally get stopped out at −4% intraday, which
// usually LOSES less than the engine exit on the worst trades but also
// never turns a stopped trade back into a winner → shadow results are
// slightly OPTIMISTIC. Promotion decisions must discount this.
//
// Price source: stocks use AlpacaExecutor (cached WS price, REST fallback).
// Crypto uses the SAME source as fetchCandles — Binance klines — because
// Alpaca's crypto feed is too sparse/contended (WS 406) and returned 0 for
// every open: the shadow_momentum_crypto book recorded NOTHING for weeks
// (same bug class as shadow_pairs 2026-07-16, price path instead of candles).

import type { MomentumBrokerAdapter } from "../strategies/momentum/MomentumEngine";
import { BREAKOUT_SHORT_TIME_STOP } from "../strategies/momentum/MomentumEngine";
import { BREAKOUT_SHORT_EXIT, BREAKOUT_SHORT_STOP, BREAKOUT_SHORT_PRIORITY, BREAKOUT_SHORT_DRAWDOWN, IDLE_OVERLAY_EXIT_CLOSE_REASON, MODEL_CUTOVER_CLOSE_REASON, SLOT_DISPLACED_CLOSE_REASON, TIME_STOP_CLOSE_REASON, TRAIL_STOP_CLOSE_REASON, TREND_EXIT_CLOSE_REASON } from "../strategies/momentum/MomentumEngine";
import type { CurrentPosition } from "../strategies/momentum/Rebalancer";
import type { OHLCV } from "../utils/types";
import { getDB, insertTrade, closeTrade, updateTradeCloseReason, getOpenTrades, RECONCILE_CLOSE_SQL, accumulatePartialCloseLedger, getPartialCloseLedger, increaseOpenTradeQuantity, pnlOf } from "../db/database";
import { createLogger } from "../utils/logger";
import { binanceKlinesEnabled, fetchBinanceKlines } from "../market/binanceKlines";

const log = createLogger("ShadowAdapter");

/** 2bps adverse slippage on every simulated fill. */
export const SHADOW_SLIPPAGE = 0.0002;

// Canonical engine-driven close labels persisted VERBATIM on
// trades.close_reason — the same whitelist as the live adapters
// (AlpacaMomentumAdapter/BinanceMomentumAdapter), so shadow telemetry can
// distinguish TRAIL_STOP/TIME_STOP/SLOT_DISPLACED from a signal-flip close.
// Anything else (or absent) falls back to cfg.closeReason, so free-text can
// never land in the enum-ish column.
const ENGINE_CLOSE_REASONS: ReadonlySet<string> = new Set([TRAIL_STOP_CLOSE_REASON, TIME_STOP_CLOSE_REASON, SLOT_DISPLACED_CLOSE_REASON, MODEL_CUTOVER_CLOSE_REASON, TREND_EXIT_CLOSE_REASON, IDLE_OVERLAY_EXIT_CLOSE_REASON, BREAKOUT_SHORT_EXIT, BREAKOUT_SHORT_STOP, BREAKOUT_SHORT_PRIORITY, BREAKOUT_SHORT_DRAWDOWN, BREAKOUT_SHORT_TIME_STOP]);

/** Minimal slice of AlpacaExecutor the shadow adapter needs (test-injectable). */
export interface ShadowPriceSource {
  getCachedPrice(symbol: string): number;
  getLatestPrice(symbol: string): Promise<number>;
  getBars(symbol: string, timeframe: string, limit: number): Promise<OHLCV[]>;
}

export interface ShadowAdapterConfig {
  /** trades.account_id for this shadow book, e.g. "shadow_meanrev_wide". */
  accountId: string;
  /** trades.strategy label. */
  strategy: string;
  /** close_reason written on engine-driven closes. */
  closeReason: string;
  /** Bar timeframe for fetchCandles (Alpaca format). */
  timeframe: string;
  /** Paper equity base — getEquity() = baseUsd + Σ closed pnl. */
  baseUsd: number;
  /** trades.market column. */
  market: "stock" | "crypto";
}

export const DEFAULT_SHADOW_CONFIG: ShadowAdapterConfig = {
  accountId: "shadow_meanrev_wide",
  strategy: "MEANREV_WIDE",
  closeReason: "MEANREV_EXIT",
  timeframe: "1Day",
  baseUsd: 50_000,
  market: "stock",
};

/** Bar interval per Alpaca-format timeframe (freshness window = 2× this). */
const TF_MS: Record<string, number> = {
  "1Min": 60_000, "5Min": 300_000, "15Min": 900_000, "1Hour": 3_600_000, "1Day": 86_400_000,
};

export class ShadowAdapter implements MomentumBrokerAdapter {
  private cfg: ShadowAdapterConfig;

  constructor(
    private prices: ShadowPriceSource,
    cfg: Partial<ShadowAdapterConfig> = {},
    /** Test seam — production always uses the real Binance klines helper. */
    private klines: typeof fetchBinanceKlines = fetchBinanceKlines,
  ) {
    this.cfg = { ...DEFAULT_SHADOW_CONFIG, ...cfg };
  }

  get accountId(): string {
    return this.cfg.accountId;
  }

  async getOpenPositions(): Promise<Array<CurrentPosition & { entryTime: number }>> {
    return getOpenTrades(this.cfg.accountId).map((t) => {
      const current = this.prices.getCachedPrice(t.symbol) || t.entryPrice;
      return {
        symbol: t.symbol,
        side: t.side as "buy" | "sell",
        quantity: t.quantity,
        notional: t.quantity * current,
        entryTime: t.entryTime,
        ...(t.strategy === "IDLE_OVERLAY" ? { role: "idle-overlay" as const } : {}),
        ...(t.strategy === "BREAKOUT_SHORT" ? { role: "breakout-short" as const, entryPrice: t.entryPrice, stopLoss: t.stopLoss, breakoutN: t.breakoutN } : {}),
      };
    });
  }

  async getEquity(): Promise<number> {
    const row = getDB().prepare(
      `SELECT COALESCE(SUM(pnl), 0) net FROM trades WHERE account_id = ? AND status = 'closed' AND ${RECONCILE_CLOSE_SQL}`
    ).get(this.cfg.accountId) as any;
    return this.cfg.baseUsd + (row?.net ?? 0);
  }

  async getRealisedPnlSince(epochMs: number): Promise<number> {
    const row = getDB().prepare(
      `SELECT COALESCE(SUM(pnl), 0) net FROM trades
       WHERE account_id = ? AND status = 'closed' AND exit_time > ? AND ${RECONCILE_CLOSE_SQL}`
    ).get(this.cfg.accountId, epochMs) as any;
    return row?.net ?? 0;
  }

  async openPosition(action: Parameters<MomentumBrokerAdapter["openPosition"]>[0]): Promise<{ ok: boolean; reason?: string }> {
    if (action.role === "breakout-short" && (this.cfg.market !== "crypto" || action.symbol !== "BTC/USD" || action.side !== "sell" || !action.breakout || ![action.breakout.n, action.breakout.stopN, action.breakout.quantity].every(x => Number.isFinite(x) && x > 0))) return { ok: false, reason: "invalid breakout short unit" };
    const price = await this.currentPrice(action.symbol);
    if (price <= 0) return { ok: false, reason: `no price for ${action.symbol}` };

    // Adverse fill: buying pays up, shorting sells down.
    const fill = action.side === "buy" ? price * (1 + SHADOW_SLIPPAGE) : price * (1 - SHADOW_SLIPPAGE);
    const qty = action.role === "breakout-short" ? action.breakout!.quantity : this.cfg.market === "stock"
      ? Math.floor(action.notionalUsd / fill)
      : action.notionalUsd / fill;
    if (qty <= 0) return { ok: false, reason: "computed qty <= 0" };

    // Engine-computed vol-scaled stop (openPosition.stopLossPct, same
    // contract as AlpacaMomentumAdapter): derive the stop PRICE from the
    // simulated FILL, side-aware. Absent → undefined → NULL (legacy fixed
    // distance, unaffected — checkAllStopLoss's rowStopPct falls back to
    // the profile's fixed pct).
    const stopLoss = action.role === "breakout-short" ? fill + action.breakout!.n * action.breakout!.stopN : action.stopLossPct !== undefined && action.stopLossPct > 0
      ? (action.side === "buy"
        ? fill * (1 - action.stopLossPct / 100)
        : fill * (1 + action.stopLossPct / 100))
      : undefined;

    insertTrade({
      id: crypto.randomUUID(),
      symbol: action.symbol,
      market: this.cfg.market,
      side: action.side,
      strategy: action.role === "breakout-short" ? "BREAKOUT_SHORT" : action.role === "idle-overlay" ? "IDLE_OVERLAY" : this.cfg.strategy as any,
      breakoutN: action.role === "breakout-short" ? action.breakout!.n : undefined,
      entryPrice: fill,
      quantity: qty,
      entryTime: Date.now(),
      status: "open",
      stopLoss,
    } as any, this.cfg.accountId);

    log.debug(`shadow open ${action.symbol} ${action.side} ${qty} @ $${fill.toFixed(2)} [${this.cfg.accountId}]`);
    return { ok: true };
  }

  async closePosition(action: { symbol: string; side: "buy" | "sell"; closeReason?: string }): Promise<{ ok: boolean; reason?: string }> {
    // Canonical label from the engine; default flip label otherwise —
    // mirrors the live adapters' closePosition.
    const closeReason = action.closeReason && ENGINE_CLOSE_REASONS.has(action.closeReason)
      ? action.closeReason
      : this.cfg.closeReason;
    const row = getDB().prepare(
      `SELECT id, side, quantity, entry_price FROM trades
       WHERE account_id = ? AND symbol = ? AND status = 'open'
       ORDER BY entry_time DESC LIMIT 1`
    ).get(this.cfg.accountId, action.symbol) as any;
    if (!row) return { ok: false, reason: `no open shadow position for ${action.symbol}` };

    const price = await this.currentPrice(action.symbol);
    if (price <= 0) return { ok: false, reason: `no price for ${action.symbol}` };

    // Adverse fill: closing a long sells down, closing a short buys up.
    const fill = row.side === "buy" ? price * (1 - SHADOW_SLIPPAGE) : price * (1 + SHADOW_SLIPPAGE);
    // Partial-reduce legs (scalePosition) net into the ONE final pnl — the
    // same single-row accounting as BinanceMomentumAdapter / the sim.
    const ledger = getPartialCloseLedger(row.id);
    const closed = ledger.closedContracts > 0
      ? closeTrade(row.id, fill, Date.now(), 0,
        pnlOf(row.side, row.entry_price, fill, row.quantity).pnl + ledger.realizedNative,
        { basisQuantity: row.quantity + ledger.closedContracts })
      : closeTrade(row.id, fill, Date.now(), 0);
    if (closed?.closeReason !== "MANUAL_CLOSE_UNRECONCILED") {
      updateTradeCloseReason(row.id, closeReason);
    }
    log.debug(`shadow close ${action.symbol} @ $${fill.toFixed(2)} [${this.cfg.accountId}]`);
    return { ok: true };
  }

  /**
   * Exposure-control resize on the shadow book (RW4a, 2026-10-23) — the
   * same single-row accounting as BinanceMomentumAdapter.scalePosition, with
   * simulated fills at the kline price ± SHADOW_SLIPPAGE: factor < 1 realizes
   * the leg's price-diff pnl on the row's partial ledger and shrinks the
   * quantity (row stays open, pnl written once at the final close); factor > 1
   * adds at market, entry becomes the weighted average, stop_loss untouched.
   * Stocks round the leg to whole shares. Never flattens, never creates.
   */
  async scalePosition(action: { symbol: string; side: "buy" | "sell"; factor: number; reason?: string }): Promise<{ ok: boolean; reason?: string }> {
    const { factor } = action;
    if (!(factor > 0) || !Number.isFinite(factor) || factor === 1) return { ok: false, reason: `invalid factor ${factor}` };
    const row = getDB().prepare(
      `SELECT id, side, quantity, entry_price FROM trades
       WHERE account_id = ? AND symbol = ? AND status = 'open'
       ORDER BY entry_time DESC LIMIT 1`
    ).get(this.cfg.accountId, action.symbol) as any;
    if (!row) return { ok: false, reason: `no open shadow position for ${action.symbol}` };
    if (row.side !== action.side) return { ok: false, reason: `row side ${row.side} ≠ requested ${action.side}` };
    const price = await this.currentPrice(action.symbol);
    if (price <= 0) return { ok: false, reason: `no price for ${action.symbol}` };
    const long = row.side === "buy";
    if (factor < 1) {
      const raw = row.quantity * (1 - factor);
      const closeQty = this.cfg.market === "stock" ? Math.floor(raw) : raw;
      if (!(closeQty > 0) || row.quantity - closeQty <= row.quantity * 1e-9) return { ok: false, reason: "reduction too small or would flatten" };
      const fill = long ? price * (1 - SHADOW_SLIPPAGE) : price * (1 + SHADOW_SLIPPAGE);
      const leg = pnlOf(row.side, row.entry_price, fill, closeQty).pnl;
      const ledger = accumulatePartialCloseLedger(row.id, {
        realizedNative: leg, commissionNative: 0, commissionAsset: "USD",
        closedContracts: closeQty, remainingContracts: row.quantity - closeQty,
      });
      if (!ledger) return { ok: false, reason: "row no longer open" };
      log.debug(`shadow reduce ${action.symbol} ×${factor.toFixed(3)} −${closeQty} @ $${fill.toFixed(2)} [${this.cfg.accountId}]`);
      return { ok: true };
    }
    const raw = row.quantity * (factor - 1);
    const addQty = this.cfg.market === "stock" ? Math.floor(raw) : raw;
    if (!(addQty > 0)) return { ok: false, reason: "zero_qty" };
    const fill = long ? price * (1 + SHADOW_SLIPPAGE) : price * (1 - SHADOW_SLIPPAGE);
    const updated = increaseOpenTradeQuantity(row.id, { addQty, fillPrice: fill, commission: 0 });
    if (!updated) return { ok: false, reason: "row no longer open" };
    log.debug(`shadow add ${action.symbol} ×${factor.toFixed(3)} +${addQty} @ $${fill.toFixed(2)} [${this.cfg.accountId}]`);
    return { ok: true };
  }

  async fetchCandles(symbol: string, bars: number): Promise<OHLCV[]> {
    // Crypto candles: Alpaca's crypto feed is too sparse for a 90d/1h window
    // (shadow_pairs asked for 2210 bars and got nothing → never traded). Binance
    // public klines (paginated past the 1500/req cap) are the real source; fall
    // back to Alpaca bars on empty.
    if (this.cfg.market === "crypto" && binanceKlinesEnabled()) {
      const k = await fetchBinanceKlines(symbol, this.cfg.timeframe, bars);
      if (k.length > 0) return k;
    }
    return await this.prices.getBars(symbol, this.cfg.timeframe, bars);
  }

  private async currentPrice(symbol: string): Promise<number> {
    // Crypto: price from the SAME source as fetchCandles (Binance klines),
    // NOT a bid/ask-derived quote — the kline close is a trade that happened.
    if (this.cfg.market === "crypto" && binanceKlinesEnabled()) {
      const k = await this.klines(symbol, this.cfg.timeframe, 2);
      const last = k[k.length - 1];
      if (last) {
        // Freshness (fail-closed): on a live feed the last CLOSED bar opened
        // ≤ 2 intervals ago (i.e. it closed within the last interval). Older
        // means the feed is stale, and a stale fill would fabricate the very
        // evidence the governor uses for promotion → refuse with 0.
        const barMs = TF_MS[this.cfg.timeframe] ?? 3_600_000;
        if (Date.now() - last.timestamp <= 2 * barMs) return last.close;
        log.warn(`stale kline for ${symbol} (${Math.round((Date.now() - last.timestamp) / 60_000)}min old) — no price`);
        return 0;
      }
      // Klines unavailable (unmapped symbol / fetch failure returns []) →
      // fall through to Alpaca, mirroring fetchCandles' fallback direction.
    }
    let price = this.prices.getCachedPrice(symbol);
    if (price <= 0) {
      try {
        price = await this.prices.getLatestPrice(symbol);
      } catch {
        price = 0;
      }
    }
    return price;
  }
}
