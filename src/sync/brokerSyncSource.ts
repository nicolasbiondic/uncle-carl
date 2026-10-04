// ══════════════════════════════════════════════
// BrokerSyncSource — thin shim so BrokerSync consumes the LIVE executor
// instances (STACK B: src/executor/*) instead of the deleted STACK A brokers
// (src/brokers/*). No new broker clients — one client per venue is the whole
// point of the merge. This adapts exactly the surface BrokerSync reads.
// ══════════════════════════════════════════════

import type { AlpacaExecutor } from "../executor/alpaca-executor";
import { BinanceExecutor } from "../executor/binance-executor";

export interface BrokerSyncSource {
  id: string;
  name: string;
  status: "connected" | "disconnected";
  getAccount(): Promise<{ totalEquity: number | null; availableCash: number | null }>;
  getOpenPositions(): Promise<Array<{ symbol: string; side: "buy" | "sell"; quantity: number; entryPrice: number }>>;
  /** Binance only — presence-checked by BrokerSync (Alpaca source omits it). */
  getAssetBreakdown?(): Promise<Array<{ asset: string; balance: number; availableBalance: number; usdValue: number }>>;
}

export function buildBrokerSyncSources(
  alpaca: AlpacaExecutor,
  binance: BinanceExecutor,
): BrokerSyncSource[] {
  const alpacaSource: BrokerSyncSource = {
    id: "alpaca_paper",
    name: "Alpaca Paper",
    // Live getter — connection state changes over the bot's lifetime; a snapshot
    // would freeze it (BrokerSync would keep syncing a dead broker or skip a
    // reconnected one forever).
    get status() { return alpaca.isConnected() ? "connected" : "disconnected"; },
    async getAccount() {
      const raw = await alpaca.getAccount(); // raw SDK: { equity, cash } as strings, or null
      if (!raw) throw new Error("Alpaca getAccount returned null");
      const totalEquity = parseFloat(raw.equity);
      const availableCash = parseFloat(raw.cash);
      if (!Number.isFinite(totalEquity) || !Number.isFinite(availableCash)) {
        throw new Error(`Alpaca getAccount malformed numeric fields: equity=${raw.equity}, cash=${raw.cash}`);
      }
      return { totalEquity, availableCash };
    },
    async getOpenPositions() {
      const positions = await alpaca.getPositions(); // already alpaca symbols + buy/sell + abs qty
      if (!Array.isArray(positions)) throw new Error("Alpaca getPositions returned non-array");
      return positions.map((p) => {
        if (!p || typeof p !== "object" || typeof p.symbol !== "string" || !p.symbol ||
            (p.side !== "buy" && p.side !== "sell") || !Number.isFinite(p.quantity) || p.quantity <= 0 ||
            !Number.isFinite(p.avgEntryPrice) || p.avgEntryPrice <= 0) {
          throw new Error("Alpaca getPositions returned malformed position");
        }
        return { symbol: p.symbol, side: p.side, quantity: p.quantity, entryPrice: p.avgEntryPrice };
      });
    },
  };

  const binanceSource: BrokerSyncSource = {
    id: "binance_testnet",
    name: "Binance Futures Testnet",
    get status() { return binance.isConnected() ? "connected" : "disconnected"; },
    async getAccount() {
      // Operational sync — margin fields ONLY. The full account total
      // (binance_main, needs Binance's assetIndex) is owned by
      // AccountManager.refreshBinanceAccountTotal; that assetIndex fan-out
      // must never sit on BrokerSync's reconciliation path (reviewer P1,
      // 2026-07-18: assetIndex is slower/rate-limited and blocking it here
      // would stall position reconciliation too).
      const balance = await binance.getBalance();
      if (!balance || typeof balance !== "object") {
        throw new Error("Binance getBalance returned null/undefined");
      }
      const { marginEquity, marginCash } = balance;
      if (typeof marginEquity !== "number" || !Number.isFinite(marginEquity) ||
          typeof marginCash !== "number" || !Number.isFinite(marginCash)) {
        throw new Error(`Binance getBalance malformed numeric fields: marginEquity=${marginEquity}, marginCash=${marginCash}`);
      }
      return {
        totalEquity: marginEquity,
        availableCash: marginCash,
      };
    },
    async getOpenPositions() {
      const raw = await binance.getPositions(); // { symbol: "BTCUSDT", positionAmt (signed), entryPrice, ... }
      if (!Array.isArray(raw)) {
        throw new Error(`Binance getPositions returned non-array: ${typeof raw}`);
      }
      const out: Array<{ symbol: string; side: "buy" | "sell"; quantity: number; entryPrice: number }> = [];
      for (const p of raw) {
        if (!p || typeof p !== "object") throw new Error("Binance getPositions returned malformed position");
        const amt = Number(p.positionAmt);
        if (!Number.isFinite(amt)) throw new Error(`Binance position has malformed positionAmt: ${p.positionAmt}`);
        if (amt === 0) continue; // flat positions are valid and need no reconciliation row
        const symbol = BinanceExecutor.toAlpacaSymbol(p.symbol); // raw → alpaca (BTCUSDT → BTC/USD)
        if (!symbol) throw new Error(`Binance position has unmapped symbol: ${p.symbol}`);
        const entryPrice = Number(p.entryPrice);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
          throw new Error(`Binance position ${p.symbol} has malformed entryPrice: ${p.entryPrice}`);
        }
        out.push({
          symbol,
          side: amt > 0 ? "buy" : "sell",
          quantity: Math.abs(amt),
          entryPrice,
        });
      }
      return out;
    },
    async getAssetBreakdown() {
      return await binance.getAssetBreakdown();
    },
  };

  return [alpacaSource, binanceSource];
}
