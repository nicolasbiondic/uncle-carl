// ══════════════════════════════════════════════
// Core Types for the Trading System
// ══════════════════════════════════════════════

export type Market = "stock" | "crypto";
export type Side = "buy" | "sell";
export type StrategyName =
  | "RSI"
  | "MACD"
  | "SMA_CROSSOVER"
  | "BOLLINGER"
  | "VWAP"
  | "MOMENTUM"         // v7.0: cross-sectional momentum engine (replacement strategy)
  | "MEANREV"           // Connors-style daily mean reversion (MeanRevEngine)
  | "MEANREV_WIDE"      // shadow_meanrev_wide breadth sleeve (ShadowAdapter)
  | "CARRY"             // shadow_carry funding-carry sleeve (CarryShadowEngine)
  | "PAIRS"             // shadow_pairs sleeve (ShadowAdapter)
  | "BROKER_SYNC"       // BrokerSync-adopted row (broker=truth reconcile)
  | "SYNC_RECOVERY";    // AccountManager-adopted orphan row (bot-managed)

export interface Signal {
  id: string;
  symbol: string;
  market: Market;
  side: Side;
  strategy: StrategyName;
  strength: "strong" | "moderate" | "weak";
  price: number;
  timestamp: number;
  indicators: Record<string, number>;
  reason: string;
}

export interface Order {
  id: string;
  symbol: string;
  market: Market;
  side: Side;
  type: "market" | "limit" | "stop" | "stop_limit";
  quantity: number;
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  status: "pending" | "filled" | "partial" | "cancelled" | "rejected";
  externalId?: string;
  signal?: Signal;
  filledAt?: number;
  filledPrice?: number;
  filledQty?: number;
  openCommission?: number;
  createdAt: number;
  updatedAt: number;
  /** Local epoch ms when the order was submitted to the broker. */
  submittedAt?: number;
  /** Executable touch price captured immediately before submission (ask for buys, bid for sells). */
  submittedPx?: number;
  /** Pre-trade estimated VWAP fill price from book depth (bookDepth.ts).
   *  Best-effort telemetry — absent when no estimate was available. */
  estPx?: number;
}

export interface Position {
  symbol: string;
  market: Market;
  side: Side;
  quantity: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  /** Margin deployed at open (cash debited). Used by EquityTracker so equity =
   *  cash + Σ(open margin) + unrealized, i.e. open positions don't dip equity. */
  marginUsed?: number;
  openedAt: number;
  durationSeconds?: number;
  /** Which sleeve owns this row (RiskProfileId). Only set on the CONSOLIDATED
   *  view's positions array (AccountManager.getConsolidatedState) — that is
   *  the one place multiple sleeves' positions land in a single flat list, so
   *  it is the only place a reader could otherwise not tell them apart (e.g.
   *  LINK/USD from momentum_crypto vs LINK/USDC from momentum_crypto_usdc).
   *  A single-sleeve view's positions are already all the same sleeve. */
  profileId?: string;
}

export interface PortfolioState {
  totalEquity: number;
  cash: number;
  stocksValue: number;
  cryptoValue: number;
  positions: Position[];
  dailyPnl: number;
  dailyPnlPct: number;
  totalPnl: number;
  totalPnlPct: number;
  openPositions: number;
  dailyTrades: number;
  winRate: number;
  timestamp: number;
}

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface TradeRecord {
  id: string;
  symbol: string;
  market: Market;
  side: Side;
  strategy: StrategyName;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnl?: number;
  pnlPct?: number;
  entryTime: number;
  exitTime?: number;
  status: "open" | "closed";
  accountId?: string;
  profileId?: string;
  orderId?: string;
  openCommission?: number;
  closeCommission?: number;
  stopLoss?: number;
  takeProfit?: number;
  closeReason?: string;
  /** Exact margin/cash deducted at open; credited back verbatim on close. */
  marginUsed?: number;
}
