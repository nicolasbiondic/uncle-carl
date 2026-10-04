// ══════════════════════════════════════════════
// Broker-side kill switch (Alpaca suspend_trade) — executor behavior
// ══════════════════════════════════════════════
//
// The switch lives AT THE BROKER (`trade_suspended_by_user` on GET
// /v2/account) so zombie processes / stale clones / old code versions can't
// ignore it. Contract under test:
//   - suspended account  → the executor reports it and placeOrder (the only
//     real-broker Alpaca ENTRY path) is blocked pre-transmit;
//   - normal account     → zero behavior change;
//   - closes + protective stops are NEVER gated (bot-side blocks opens ONLY);
//   - a failed/degraded read is FAIL-OPEN (keep last-known, initially false):
//     the broker enforces the suspension authoritatively regardless, so a
//     network blip must not halt startup or entries by itself.

import { afterEach, describe, expect, test, mock } from "bun:test";
import { AlpacaExecutor } from "./alpaca-executor";
import { config } from "../config";
import { fakeAlpacaExecutor as executor } from "../test-support/alpaca";

const stockBuy = { symbol: "AAPL", side: "buy", market: "stock", price: 100 } as any;

/** Fake SDK client for the entry path: stop-sweep enumeration + createOrder. */
function entryClient(overrides: Record<string, any> = {}) {
  return {
    getOrders: mock().mockResolvedValue([]), // pre-buy stop sweep
    createOrder: mock().mockResolvedValue({
      id: "broker-1", status: "filled", filled_qty: "1", filled_avg_price: "100",
      filled_at: new Date().toISOString(),
    }),
    ...overrides,
  };
}

describe("kill switch read", () => {
  test("init() reads trade_suspended_by_user=true from the startup getAccount", async () => {
    const saved = { ...config.alpaca };
    const savedUseWs = config.execution.useWs;
    (config.alpaca as any).keyId = "test-key";
    (config.alpaca as any).paper = true;
    (config.alpaca as any).baseUrl = "https://paper-api.alpaca.markets";
    (config.execution as any).useWs = false;
    try {
      const exec = new AlpacaExecutor() as any;
      exec.client = {
        getAccount: mock().mockResolvedValue({ id: "acc-1", equity: "1000", cash: "500", trade_suspended_by_user: true }),
      };
      expect(await exec.init()).toBe(true); // suspension ≠ startup failure: the bot must run (closes/stops/reconcile)
      expect(exec.isTradeSuspendedByBroker()).toBe(true);
    } finally {
      Object.assign(config.alpaca, saved);
      (config.execution as any).useWs = savedUseWs;
    }
  });

  test("a payload WITHOUT the field never blocks startup — fail-open, not suspended", async () => {
    const saved = { ...config.alpaca };
    const savedUseWs = config.execution.useWs;
    (config.alpaca as any).keyId = "test-key";
    (config.alpaca as any).paper = true;
    (config.alpaca as any).baseUrl = "https://paper-api.alpaca.markets";
    (config.execution as any).useWs = false;
    try {
      const exec = new AlpacaExecutor() as any;
      exec.client = { getAccount: mock().mockResolvedValue({ id: "acc-1", equity: "1000", cash: "500" }) };
      expect(await exec.init()).toBe(true);
      expect(exec.isTradeSuspendedByBroker()).toBe(false);
    } finally {
      Object.assign(config.alpaca, saved);
      (config.execution as any).useWs = savedUseWs;
    }
  });

  test("getAccount() refreshes the flag at runtime (60s account sync piggyback), both directions", async () => {
    const exec = executor() as any;
    exec.client = { getAccount: mock().mockResolvedValue({ id: "a", trade_suspended_by_user: true }) };
    await exec.getAccount();
    expect(exec.isTradeSuspendedByBroker()).toBe(true);

    exec.client.getAccount.mockResolvedValue({ id: "a", trade_suspended_by_user: false });
    await exec.getAccount();
    expect(exec.isTradeSuspendedByBroker()).toBe(false);
  });

  test("a FAILED read keeps the last-known value — a network error neither arms nor clears the switch", async () => {
    const exec = executor() as any;
    exec.client = { getAccount: mock().mockResolvedValue({ id: "a", trade_suspended_by_user: true }) };
    await exec.getAccount();
    expect(exec.isTradeSuspendedByBroker()).toBe(true);

    exec.client.getAccount = mock().mockRejectedValue(new Error("ECONNRESET"));
    expect(await exec.getAccount()).toBeNull(); // existing degraded contract, unchanged
    expect(exec.isTradeSuspendedByBroker()).toBe(true); // still what the broker last said

    // Same for a malformed/degraded payload (field missing): no flip.
    exec.client.getAccount = mock().mockResolvedValue({ id: "a" });
    await exec.getAccount();
    expect(exec.isTradeSuspendedByBroker()).toBe(true);
  });
});

describe("kill switch gate — opens ONLY", () => {
  afterEach(() => {
    // suspend tests never touch globals, but keep parity with the suite style
  });

  test("suspended → placeOrder is blocked PRE-TRANSMIT (nothing reaches the SDK)", async () => {
    const client = entryClient();
    const exec = executor({ client, tradeSuspendedByBroker: true });
    expect(await exec.placeOrder(stockBuy, 1, "momentum_stocks")).toBeNull();
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.getOrders).not.toHaveBeenCalled(); // gated before even the stop sweep
  });

  test("suspended → crypto entries are blocked too", async () => {
    const client = entryClient();
    const exec = executor({ client, tradeSuspendedByBroker: true });
    expect(await exec.placeOrder({ symbol: "BTC/USD", side: "buy", market: "crypto", price: 50_000 } as any, 0.01, "momentum_crypto")).toBeNull();
    expect(client.createOrder).not.toHaveBeenCalled();
  });

  test("normal account → placeOrder behavior unchanged (order submitted and returned)", async () => {
    const client = entryClient();
    const exec = executor({ client });
    const order = await exec.placeOrder(stockBuy, 1, "momentum_stocks");
    expect(order).not.toBeNull();
    expect((order as any).status).toBe("filled");
    expect(client.createOrder).toHaveBeenCalledTimes(1);
  });

  test("suspended → closePosition still runs (exits are NEVER gated bot-side)", async () => {
    const client = {
      getOrders: mock().mockResolvedValue([]), // pre-close stop sweep
      closePosition: mock().mockResolvedValue({ id: "close-1" }),
      getOrder: mock().mockResolvedValue({ status: "filled", filled_qty: "1", filled_avg_price: "99.5", filled_at: new Date().toISOString() }),
    };
    const exec = executor({ client, tradeSuspendedByBroker: true });
    const result = await exec.closePosition("AAPL");
    expect(result.success).toBe(true);
    expect(result.filledPrice).toBe(99.5);
    expect(client.closePosition).toHaveBeenCalledTimes(1);
  });

  test("suspended → placeStopLossOrder still runs (protection is NEVER gated bot-side)", async () => {
    const client = { createOrder: mock().mockResolvedValue({ id: "stop-1" }) };
    const exec = executor({ client, tradeSuspendedByBroker: true });
    const result = await exec.placeStopLossOrder({
      symbol: "AAPL", positionSide: "buy", quantity: 5, stopPrice: 95.123,
      accountId: "momentum_stocks", tradeId: "t1",
    });
    expect(result.ok).toBe(true);
    expect(client.createOrder).toHaveBeenCalledTimes(1);
  });
});
