// ══════════════════════════════════════════════
// Global Event Bus
// ══════════════════════════════════════════════

import { EventEmitter } from "events";

class TradingEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
}

export const eventBus = new TradingEventBus();

export const EVENTS = {
  ORDER_FILLED: "order:filled",
  POSITION_CLOSED: "position:closed",
  PRICE_UPDATE: "price:update",
  CIRCUIT_BREAKER: "circuit:breaker",
  POSITION_UPDATE: "position:update",
  // Emitted by logger when ≥10 same-shape errors fire within 60s. Wired to
  // TelegramReporter so on-call gets paged instead of tailing logs.
  ERROR_BURST: "error:burst",
  // Emitted by broker WS user-data adapters (Alpaca trade_updates, Binance
  // ORDER_TRADE_UPDATE). Carries { broker, externalId, status, filledQty,
  // avgPx, eventType, ts }. Listener: AccountManager (advances OSM).
  ORDER_UPDATE: "order:update",
  // Emitted by AccountManager.applyCorporateAction after a past-ex-date split
  // ratio has been applied to the DB rows. Carries { symbol, ratio }
  // (ratio = new_rate/old_rate — price axis ÷ratio). Listener: the tsmTrail
  // momentum engine (index.ts wires scaleMarksForSplit) — AccountManager
  // doesn't know engines, so the trail-watermark rescale rides the bus.
  CORPORATE_ACTION_APPLIED: "corporate_action:applied",
} as const;
