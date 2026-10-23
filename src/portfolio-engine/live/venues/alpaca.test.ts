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

describe("releaseLegacyStops / Reg-T guard (executor surface)", () => {
  test("cancels only resting SELL stops on the requested symbols, by exact id; a failed cancel throws", async () => {
    const cancelled: string[] = [];
    const stops = [
      { id: "s1", clientOrderId: "uc8-a", symbol: "SPY", side: "sell" },
      { id: "s2", clientOrderId: "uc8-b", symbol: "TLT", side: "sell" },
      { id: "s3", clientOrderId: "uc8-c", symbol: "SPY", side: "buy" },
    ];
    const venue = new AlpacaVenue(fakeExecutor({ getOpenStopOrders: async () => stops, cancelOrderById: async (id) => { cancelled.push(id); return true; } }), fakeClient());
    expect(await venue.releaseLegacyStops(["SPY"])).toEqual({ released: ["s1"], unconfirmed: [] });
    expect(cancelled).toEqual(["s1"]);
    expect(await venue.releaseLegacyStops([])).toEqual({ released: [], unconfirmed: [] });
    const failing = new AlpacaVenue(fakeExecutor({ getOpenStopOrders: async () => stops, cancelOrderById: async () => false }), fakeClient());
    await expect(failing.releaseLegacyStops(["SPY"])).rejects.toThrow(/could not cancel/);
    // an executor without the stop surface releases nothing (no guess)
    expect(await new AlpacaVenue(fakeExecutor(), fakeClient()).releaseLegacyStops(["SPY"])).toEqual({ released: [], unconfirmed: [] });
  });

  // 2026-10-23: DELETE answered 204 but the stop stayed pending_cancel (shares held) while the engine sold.
  test("waits until each accepted cancel is terminal at the venue (pending_cancel is not enough)", async () => {
    let t = 0;
    const polls: Record<string, number> = { s1: 0, s2: 0 };
    const stops = [
      { id: "s1", clientOrderId: "uc8-a", symbol: "SPY", side: "sell" },
      { id: "s2", clientOrderId: "uc8-b", symbol: "AAPL", side: "sell" },
    ];
    // s1 settles on its 3rd read, s2 on its 1st.
    const client = fakeClient({ getOrder: (id: string) => ({ id, status: ++polls[id] >= (id === "s1" ? 3 : 1) ? "canceled" : "pending_cancel" }) });
    const venue = new AlpacaVenue(fakeExecutor({ getOpenStopOrders: async () => stops, cancelOrderById: async () => true }), client,
      { sleep: async (ms) => { t += ms; }, now: () => t, releasePollMs: 1_000 });
    expect(await venue.releaseLegacyStops(["SPY", "AAPL"])).toEqual({ released: ["s2", "s1"], unconfirmed: [] });
    expect(polls).toEqual({ s1: 3, s2: 1 }); // a settled order is not polled again
    expect(t).toBe(2_000);
  });

  test("a cancel never confirmed is reported unconfirmed after the bounded wait (default 20 s); 404 counts as gone; a failed read is 'not yet'", async () => {
    let t = 0;
    const stops = [
      { id: "stuck", clientOrderId: "uc8-a", symbol: "SPY", side: "sell" },
      { id: "gone", clientOrderId: "uc8-b", symbol: "AAPL", side: "sell" },
      { id: "flaky", clientOrderId: "uc8-c", symbol: "TLT", side: "sell" },
    ];
    let flakyReads = 0;
    const client = fakeClient({
      getOrder: (id: string) => {
        if (id === "gone") throw http(404, "order not found");
        if (id === "flaky") { if (++flakyReads === 1) throw new Error("socket hang up"); return { id, status: "canceled" }; }
        return { id, status: "pending_cancel" };
      },
    });
    const venue = new AlpacaVenue(fakeExecutor({ getOpenStopOrders: async () => stops, cancelOrderById: async () => true }), client,
      { sleep: async (ms) => { t += ms; }, now: () => t });
    const res = await venue.releaseLegacyStops(["SPY", "AAPL", "TLT"]);
    expect(res.released.sort()).toEqual(["flaky", "gone"]);
    expect(res.unconfirmed).toEqual(["stuck"]);
    expect(t).toBeGreaterThanOrEqual(20_000);
    expect(t).toBeLessThanOrEqual(21_000); // bounded, never an open-ended wait
  });

  test("a failed cancel on one stop does not skip the others, and still throws at the end", async () => {
    const cancelled: string[] = [];
    const stops = [
      { id: "bad", clientOrderId: "uc8-a", symbol: "SPY", side: "sell" },
      { id: "ok", clientOrderId: "uc8-b", symbol: "AAPL", side: "sell" },
    ];
    const venue = new AlpacaVenue(fakeExecutor({ getOpenStopOrders: async () => stops, cancelOrderById: async (id) => { cancelled.push(id); return id !== "bad"; } }), fakeClient());
    await expect(venue.releaseLegacyStops(["SPY", "AAPL"])).rejects.toThrow(/could not cancel incumbent stop bad on SPY/);
    expect(cancelled).toEqual(["bad", "ok"]);
  });

  test("buy over Reg-T buying power: blocked before createOrder; equal/under passes; sell never guarded; unreadable fails open", async () => {
    const client = fakeClient();
    const mk = (bp: number | null | "throw") => new AlpacaVenue(fakeExecutor({ getRegTBuyingPower: async () => { if (bp === "throw") throw new Error("x"); return bp; } }), client, { sleep: async () => {} });
    const blocked = await mk(2999).submit(intent({ notional: 3000 }), "id1");
    expect(blocked).toMatchObject({ ok: false, filledQty: 0, status: "insufficient_buying_power" });
    expect(blocked.error).toContain("Reg-T buying power $2999");
    expect(client.calls).toHaveLength(0);
    expect((await mk(3000).submit(intent({ notional: 3000 }), "id2")).ok).toBe(true);
    expect((await mk(1).submit(intent({ side: "sell", reduceOnly: true, notional: 3000 }), "id3")).ok).toBe(true);
    expect((await mk(null).submit(intent(), "id4")).ok).toBe(true);
    expect((await mk("throw").submit(intent(), "id5")).ok).toBe(true);
    expect((await mk(-5).submit(intent(), "id6")).status).toBe("insufficient_buying_power"); // margin call: blocks
  });
});
