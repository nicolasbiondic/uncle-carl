// AlpacaVenue — fractional market DAY orders, duplicate client_order_id →
// query, timeout → cancel the ORDER (never DELETE the position), positions
// and prices through the executor. Fake client + fake executor; no network.

import { describe, test, expect } from "bun:test";
import { AlpacaVenue, formatFractionalQty, type AlpacaVenueClient, type AlpacaVenueExecutor } from "./alpaca";
import type { OrderIntent } from "../../types";

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  symbol: "TLT", side: "buy", qty: 33.333333333, notional: 3000, targetWeight: 0.3, currentWeight: 0, reduceOnly: false, ...over,
});

function fakeExecutor(over: Partial<AlpacaVenueExecutor> = {}): AlpacaVenueExecutor {
  return {
    isConnected: () => true,
    getPositions: async () => [
      { symbol: "SPY", market: "stock", side: "buy", quantity: 10.5, avgEntryPrice: 480, currentPrice: 500 },
      { symbol: "AAPL", market: "stock", side: "buy", quantity: 3, avgEntryPrice: 200, currentPrice: 210 },
      { symbol: "DOGE/USD", market: "crypto", side: "buy", quantity: 100, avgEntryPrice: 0.1, currentPrice: 0.2 },
      { symbol: "XYZ", market: "stock", side: "sell", quantity: 2, avgEntryPrice: 50, currentPrice: 49 },
    ],
    getLatestPrice: async (s) => (s === "TLT" ? 90 : 0),
    getCachedPrice: (s) => (s === "SPY" ? 501 : 0),
    ...over,
  };
}

type Call = { method: string; args: any[] };
function fakeClient(script: Partial<Record<keyof AlpacaVenueClient, (...a: any[]) => any>> = {}): AlpacaVenueClient & { calls: Call[] } {
  const calls: Call[] = [];
  const wrap = (method: keyof AlpacaVenueClient, def: (...a: any[]) => any) => async (...args: any[]) => {
    calls.push({ method, args });
    return (script[method] ?? def)(...args);
  };
  return {
    calls,
    createOrder: wrap("createOrder", (p) => ({ id: "o1", status: "filled", filled_qty: String(p.qty), filled_avg_price: "90.1", client_order_id: p.client_order_id })),
    getOrder: wrap("getOrder", () => ({ id: "o1", status: "filled", filled_qty: "1", filled_avg_price: "90" })),
    getOrderByClientId: wrap("getOrderByClientId", () => ({ id: "o-existing", status: "filled", filled_qty: "33.333333333", filled_avg_price: "90.2" })),
    cancelOrder: wrap("cancelOrder", () => undefined),
  };
}

const http = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("formatFractionalQty", () => {
  test("≤ 9 decimals, no trailing zeros", () => {
    expect(formatFractionalQty(10)).toBe("10");
    expect(formatFractionalQty(33.333333333333)).toBe("33.333333333");
    expect(formatFractionalQty(0.2)).toBe("0.2");
  });
});

describe("submit", () => {
  test("fractional market DAY order with the given client_order_id; filled → ok", async () => {
    const client = fakeClient();
    const venue = new AlpacaVenue(fakeExecutor(), client, { sleep: async () => {} });
    const res = await venue.submit(intent(), "uc8-momentum_sto-pfabc");
    expect(client.calls[0].method).toBe("createOrder");
    expect(client.calls[0].args[0]).toEqual({
      symbol: "TLT", side: "buy", type: "market", time_in_force: "day", qty: "33.333333333", client_order_id: "uc8-momentum_sto-pfabc",
    });
    expect(res).toMatchObject({ ok: true, filledQty: 33.333333333, avgPrice: 90.1, status: "filled", brokerOrderId: "o1" });
  });

  test("422 duplicate client_order_id → the existing order is queried, never resent", async () => {
    const client = fakeClient({ createOrder: () => { throw http(422, "client_order_id must be unique"); } });
    const venue = new AlpacaVenue(fakeExecutor(), client, { sleep: async () => {} });
    const res = await venue.submit(intent(), "dup-id");
    expect(client.calls.map(c => c.method)).toEqual(["createOrder", "getOrderByClientId"]);
    expect(client.calls[1].args[0]).toBe("dup-id");
    expect(res).toMatchObject({ ok: true, filledQty: 33.333333333, avgPrice: 90.2, brokerOrderId: "o-existing" });
  });

  test("a 4xx rejection is reported as rejected with the body", async () => {
    const client = fakeClient({ createOrder: () => { throw http(403, "insufficient buying power"); } });
    const venue = new AlpacaVenue(fakeExecutor(), client, { sleep: async () => {} });
    const res = await venue.submit(intent(), "id");
    expect(res).toMatchObject({ ok: false, filledQty: 0, status: "rejected" });
    expect(res.error).toContain("insufficient buying power");
    expect(client.calls).toHaveLength(1);
  });

  test("transport failure → resolved by client_order_id; 404 there proves it never landed", async () => {
    const client = fakeClient({
      createOrder: () => { throw new Error("socket hang up"); },
      getOrderByClientId: () => { throw http(404, "order not found"); },
    });
    const venue = new AlpacaVenue(fakeExecutor(), client, { sleep: async () => {} });
    const res = await venue.submit(intent(), "id");
    expect(res).toMatchObject({ ok: false, status: "rejected", filledQty: 0 });
    expect(client.calls.map(c => c.method)).toEqual(["createOrder", "getOrderByClientId"]);
  });

  test("still working after the timeout → cancel the ORDER by id, report the partial; the position is never deleted", async () => {
    let t = 0;
    let cancelled = false;
    const client = fakeClient({
      createOrder: () => ({ id: "o9", status: "accepted", filled_qty: "0", filled_avg_price: null }),
      // Keeps working until OUR cancel lands; then the broker reports the partial as canceled.
      getOrder: () => ({ id: "o9", status: cancelled ? "canceled" : "partially_filled", filled_qty: "10", filled_avg_price: "90" }),
      cancelOrder: () => { cancelled = true; },
    });
    const venue = new AlpacaVenue(fakeExecutor(), client, { fillTimeoutMs: 5_000, pollIntervalMs: 1_000, settleMs: 0, sleep: async (ms) => { t += ms; }, now: () => t });
    const res = await venue.submit(intent(), "id");
    const methods = client.calls.map(c => c.method);
    expect(methods).toContain("cancelOrder");
    expect(client.calls.find(c => c.method === "cancelOrder")!.args[0]).toBe("o9");
    expect(methods).not.toContain("closePosition");
    expect(res).toMatchObject({ ok: false, filledQty: 10, avgPrice: 90, status: "canceled" });
  });

  test("disconnected executor → no call", async () => {
    const client = fakeClient();
    const venue = new AlpacaVenue(fakeExecutor({ isConnected: () => false }), client);
    const res = await venue.submit(intent(), "id");
    expect(res.ok).toBe(false);
    expect(client.calls).toHaveLength(0);
  });
});

describe("positions / prices / rules", () => {
  test("positions: requested stock longs only (crypto and shorts dropped)", async () => {
    const venue = new AlpacaVenue(fakeExecutor(), fakeClient());
    expect(await venue.positions(["SPY", "XYZ", "DOGE/USD", "TLT"])).toEqual([{ symbol: "SPY", qty: 10.5, avgEntryPrice: 480 }]);
  });
  test("prices: cache, then latest trade, then broker mark; unknown symbols omitted", async () => {
    const venue = new AlpacaVenue(fakeExecutor(), fakeClient());
    expect(await venue.prices(["SPY", "TLT", "AAPL", "GLD"])).toEqual({ SPY: 501, TLT: 90, AAPL: 210 });
  });
  test("rules: fractional, min notional and band from the options", async () => {
    const venue = new AlpacaVenue(fakeExecutor(), fakeClient(), { minOrderNotional: 5, rebalanceBand: 0.02 });
    expect(await venue.rules(["SPY"])).toEqual({ venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0.02 });
    expect((venue as import("../../types").VenueAdapter).syncStops).toBeUndefined();
  });
  test("fromExecutor refuses an executor without the v3-shaped client", () => {
    expect(() => AlpacaVenue.fromExecutor({} as any)).toThrow(/v3-shaped client/);
    const exec = { client: fakeClient(), isConnected: () => true } as any;
    expect(AlpacaVenue.fromExecutor(exec).venue).toBe("alpaca");
  });
});
