// ══════════════════════════════════════════════
// Unified Order Executor
// Alpaca → stocks | Binance Testnet → crypto
// Binance profiles NEVER fall back to Alpaca (cross-broker risk)
// ══════════════════════════════════════════════

import { AlpacaExecutor } from "./alpaca-executor";
import { BinanceExecutor } from "./binance-executor";
import { createLogger } from "../utils/logger";
import { OrderStateMachine } from "./OrderStateMachine";
import type { AlpacaRuntimeCredentials, BinanceRuntimeCredentials } from "./credentials";

const log = createLogger("OrderExecutor");

export interface OrderExecutorOptions {
  /** F4a (ACCOUNTS_SOURCE=registry): credentials resolved from the broker-
   *  accounts registry. ABSENT = env mode — both executors read config/.env
   *  exactly as before (byte-identical default). */
  alpacaCredentials?: AlpacaRuntimeCredentials;
  binanceCredentials?: BinanceRuntimeCredentials;
}

export class OrderExecutor {
  public alpaca: AlpacaExecutor;
  public binance: BinanceExecutor;
  // Wave 3c (2026-05-07): typed order state machine, persisted via
  // updateOrderStateFields. Public so the WS adapters in Wave 3d can
  // call into it.
  public readonly osm = new OrderStateMachine();

  constructor(options: OrderExecutorOptions = {}) {
    this.alpaca = new AlpacaExecutor(options.alpacaCredentials ? { credentials: options.alpacaCredentials } : {});
    this.binance = new BinanceExecutor(options.binanceCredentials ? { credentials: options.binanceCredentials } : {});
  }

  async init() {
    await this.alpaca.init();
    const binanceOk = await this.binance.init();
    if (binanceOk) {
      log.info("Order executor initialized (Alpaca stocks + Binance Testnet crypto)");
    } else {
      log.info("Order executor initialized (Alpaca-only — Binance not configured)");
    }
  }

}
