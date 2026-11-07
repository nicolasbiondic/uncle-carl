// AlpacaVenue — fractional market DAY orders, duplicate client_order_id →
// query, timeout → cancel the ORDER (never DELETE the position), positions
// and prices through the executor. Fake client + fake executor; no network.

import { describe, test, expect } from "bun:test";
import { ALPACA_ACCOUNT_MAX_GROSS, AlpacaVenue, formatFractionalQty, type AlpacaVenueClient, type AlpacaVenueExecutor } from "./alpaca";
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

  // B-6 (2026-11-07): the cancel ACK was treated as settlement for buys and plain sells — a late
  // fill of a "still working" buy became shares no sleeve owned.
  test("a BUY whose cancel never settles throws (journal stays unapplied); the same id resumes and takes the late fill once", async () => {
    let t = 0, cancelAt = -1;
    const book = new Map<string, any>();
    const client = fakeClient({
      createOrder: (p) => { if (book.has(p.client_order_id)) throw http(422, "client_order_id must be unique"); book.set(p.client_order_id, { id: "b1" }); return { id: "b1", status: "accepted", filled_qty: "0" }; },
      cancelOrder: () => { cancelAt = t; },
      getOrder: () => ({ id: "b1", status: cancelAt < 0 ? "accepted" : "pending_cancel", filled_qty: cancelAt < 0 ? "0" : "5", filled_avg_price: "90" }),
      getOrderByClientId: () => ({ id: "b1", status: "filled", filled_qty: "33.333333333", filled_avg_price: "90" }),
    });
    const venue = new AlpacaVenue(fakeExecutor(), client, { fillTimeoutMs: 1_000, pollIntervalMs: 1_000, releaseConfirmTimeoutMs: 3_000,
      sleep: async ms => { t += ms; }, now: () => t });
    await expect(venue.submit(intent(), "buy-stuck")).rejects.toThrow(/buy order b1 still working/);
    expect(t).toBeGreaterThanOrEqual(cancelAt + 3_000); // the bounded confirm loop ran for the buy too
    expect(client.calls.filter(c => c.method === "createOrder")).toHaveLength(1);
    // Next tick, same client id: the venue answers duplicate → the existing (now filled) order is applied once.
    const res = await venue.submit(intent(), "buy-stuck");
    expect(res).toMatchObject({ ok: true, filledQty: 33.333333333, avgPrice: 90, brokerOrderId: "b1" });
    expect(client.calls.filter(c => c.method === "createOrder")).toHaveLength(2);
  });

  test("a plain SELL (not MAX_HOLD) whose cancel never settles throws too; a settled cancel reports the partial", async () => {
    let t = 0;
    const stuck = fakeClient({ createOrder: () => ({ id: "s1", status: "accepted", filled_qty: "0" }),
      getOrder: () => ({ id: "s1", status: "pending_cancel", filled_qty: "1", filled_avg_price: "90" }) });
    const venue = new AlpacaVenue(fakeExecutor(), stuck, { fillTimeoutMs: 1_000, pollIntervalMs: 1_000, releaseConfirmTimeoutMs: 3_000,
      sleep: async ms => { t += ms; }, now: () => t });
    await expect(venue.submit(intent({ side: "sell", reduceOnly: true }), "sell-stuck")).rejects.toThrow(/sell order s1 still working/);
    let t2 = 0, cancelAt = -1;
    const settles = fakeClient({ createOrder: () => ({ id: "s2", status: "accepted", filled_qty: "0" }), cancelOrder: () => { cancelAt = t2; },
      getOrder: () => ({ id: "s2", status: cancelAt < 0 ? "accepted" : t2 < cancelAt + 2_000 ? "pending_cancel" : "canceled", filled_qty: cancelAt < 0 ? "0" : "1", filled_avg_price: "90" }) });
    const res = await new AlpacaVenue(fakeExecutor(), settles, { fillTimeoutMs: 1_000, pollIntervalMs: 1_000, settleMs: 1_000,
      sleep: async ms => { t2 += ms; }, now: () => t2 }).submit(intent({ side: "sell", reduceOnly: true }), "sell-late");
    expect(res).toMatchObject({ ok: false, status: "canceled", filledQty: 1, avgPrice: 90 });
  });

  test("disconnected executor → no call", async () => {
    const client = fakeClient();
    const venue = new AlpacaVenue(fakeExecutor({ isConnected: () => false }), client);
    const res = await venue.submit(intent(), "id");
    expect(res.ok).toBe(false);
    expect(client.calls).toHaveLength(0);
  });
});

describe("MAX_HOLD close settlement", () => {
  const close = (qty = 2.733856978) => intent({ symbol: "AVGO", side: "sell", reduceOnly: true, maxHold: "close", qty, notional: qty * 325 });

  test("paper fills after 60 s are allowed to settle before cancelling a mandatory close", async () => {
    let t = 0;
    const client = fakeClient({
      createOrder: () => ({ id: "slow", status: "accepted", filled_qty: "0" }),
      getOrder: () => ({ id: "slow", status: t >= 90_000 ? "filled" : "accepted", filled_qty: t >= 90_000 ? "2.733856978" : "0", filled_avg_price: "325" }),
    });
    const res = await new AlpacaVenue(fakeExecutor(), client, { now: () => t, sleep: async ms => { t += ms; } }).submit(close(), "close");
    expect(res).toMatchObject({ ok: true, filledQty: 2.733856978, avgPrice: 325 });
    expect(t).toBe(90_000);
    expect(client.calls.some(c => c.method === "cancelOrder")).toBe(false);
  });

  test("cancel must become terminal; report late fills so the engine cannot oversell its remainder", async () => {
    let t = 0, cancelAt = -1;
    const client = fakeClient({
      createOrder: () => ({ id: "first", status: "accepted", filled_qty: "0" }),
      cancelOrder: () => { cancelAt = t; },
      getOrder: () => ({ id: "first", status: cancelAt < 0 ? "accepted" : t < cancelAt + 3_000 ? "pending_cancel" : "canceled", filled_qty: cancelAt < 0 ? "0" : "1", filled_avg_price: "325" }),
    });
    const res = await new AlpacaVenue(fakeExecutor(), client, { fillTimeoutMs: 1_000, pollIntervalMs: 1_000, settleMs: 1_000,
      sleep: async ms => { t += ms; }, now: () => t }).submit(close(), "late");
    expect(res).toMatchObject({ ok: false, status: "canceled", filledQty: 1, avgPrice: 325 });
    expect(t).toBeGreaterThanOrEqual(cancelAt + 3_000);
  });

  test("a still-working/unknown close throws, never retries against reserved shares", async () => {
    let t = 0;
    const client = fakeClient({ createOrder: () => ({ id: "stuck", status: "accepted", filled_qty: "0" }),
      getOrder: () => ({ id: "stuck", status: "pending_cancel", filled_qty: "1", filled_avg_price: "325" }) });
    const venue = new AlpacaVenue(fakeExecutor(), client, { fillTimeoutMs: 1_000, pollIntervalMs: 1_000, releaseConfirmTimeoutMs: 3_000,
      sleep: async ms => { t += ms; }, now: () => t });
    await expect(venue.submit(close(), "stuck")).rejects.toThrow(/still working/);
    expect(client.calls.filter(c => c.method === "createOrder")).toHaveLength(1);
    expect(t).toBeLessThanOrEqual(5_000);
    const unknown = fakeClient({ createOrder: () => { throw http(422, "duplicate client_order_id"); }, getOrderByClientId: () => { throw http(503, "unreadable"); } });
    await expect(new AlpacaVenue(fakeExecutor(), unknown).submit(close(), "unknown")).rejects.toThrow(/lookup failed/);
  });

  test("terminal rejection / invalid close returns normally for the engine's existing policy", async () => {
    const rejected = fakeClient({ createOrder: () => { throw http(403, "insufficient qty"); } });
    expect((await new AlpacaVenue(fakeExecutor(), rejected).submit(close(), "reject")).status).toBe("rejected");
    expect(rejected.calls).toHaveLength(1);
    expect((await new AlpacaVenue(fakeExecutor(), rejected).submit(close(0), "invalid")).status).toBe("invalid");
    expect(rejected.calls).toHaveLength(1);
  });
});

describe("Q5 shared-account gross cap (live only)", () => {
  const absent = () => { throw http(404, "order not found"); };
  test("clips to 1.9x equity INCLUDING treasury/other sleeves; floors fractional quantity, keeps the intent unchanged", async () => {
    expect(ALPACA_ACCOUNT_MAX_GROSS).toBe(1.9);
    const client = fakeClient({ getOrderByClientId: absent });
    const executor = fakeExecutor({ getAccount: async () => ({ equity: "10000", long_market_value: "18000" }), getRegTBuyingPower: async () => 1000 });
    const order = intent({ qty: 30, notional: 3000 });
    const res = await new AlpacaVenue(executor, client).submit(order, "clip");
    expect(client.calls.find(c => c.method === "createOrder")!.args[0].qty).toBe("10");
    expect(res).toMatchObject({ ok: true, filledQty: 10 });
    expect(order.qty).toBe(30); expect(order.notional).toBe(3000);
    const fractional = fakeClient({ getOrderByClientId: absent });
    await new AlpacaVenue(executor, fractional).submit(intent({ qty: 7, notional: 3000 }), "floor");
    expect(Number(fractional.calls.find(c => c.method === "createOrder")!.args[0].qty) * 3000 / 7).toBeLessThanOrEqual(1000);
  });
  test("at/above cap, nonpositive equity or sub-minimum headroom → no BUY; equal/under allowed, sells never read the account", async () => {
    for (const [equity, gross] of [[10000, 19000], [10000, 20000], [0, 0], [-100, 0], [10000, 18996]]) {
      const client = fakeClient({ getOrderByClientId: absent });
      const venue = new AlpacaVenue(fakeExecutor({ getAccount: async () => ({ equity, long_market_value: gross }) }), client);
      expect((await venue.submit(intent(), "blocked")).status).toBe("account_gross_cap");
      expect(client.calls.some(c => c.method === "createOrder")).toBe(false);
    }
    const client = fakeClient();
    const venue = new AlpacaVenue(fakeExecutor({ getAccount: async () => ({ equity: 10000, long_market_value: 16000 }) }), client);
    expect((await venue.submit(intent(), "equal")).ok).toBe(true);
    expect((await venue.submit(intent({ notional: 2000 }), "under")).ok).toBe(true);
    let reads = 0;
    const sell = new AlpacaVenue(fakeExecutor({ getAccount: async () => { reads++; throw new Error("unreachable"); } }), client);
    expect((await sell.submit(intent({ side: "sell" }), "sell")).ok).toBe(true);
    expect(reads).toBe(0);
  });
  test("null, missing, malformed, nonfinite or throwing account fails OPEN, like Reg-T", async () => {
    for (const account of [null, {}, { equity: "bad", long_market_value: 0 }, { equity: "", long_market_value: 0 }, { equity: 100, long_market_value: "" }, { equity: Infinity, long_market_value: 0 }, { equity: 100, long_market_value: -1 }, "throw"]) {
      const client = fakeClient();
      const venue = new AlpacaVenue(fakeExecutor({ getAccount: async () => { if (account === "throw") throw new Error("offline"); return account as any; } }), client);
      expect((await venue.submit(intent(), "open")).ok).toBe(true);
      expect(client.calls.find(c => c.method === "createOrder")!.args[0].qty).toBe("33.333333333");
    }
  });
  test("Reg-T still blocks the clipped order; a consumed cap never hides an existing fill or an unknown lookup", async () => {
    const executor = fakeExecutor({ getAccount: async () => ({ equity: 10000, long_market_value: 18000 }), getRegTBuyingPower: async () => 999 });
    const client = fakeClient({ getOrderByClientId: absent });
    expect((await new AlpacaVenue(executor, client).submit(intent(), "bp")).status).toBe("insufficient_buying_power");
    expect(client.calls.some(c => c.method === "createOrder")).toBe(false);
    const filled = fakeClient();
    expect((await new AlpacaVenue(executor, filled).submit(intent(), "retry")).filledQty).toBe(33.333333333);
    expect(filled.calls.map(c => c.method)).toEqual(["getOrderByClientId"]);
    const unknown = fakeClient({ getOrderByClientId: () => { throw http(503, "unknown"); } });
    await expect(new AlpacaVenue(executor, unknown).submit(intent(), "unknown")).rejects.toThrow("unknown");
    expect(unknown.calls.some(c => c.method === "createOrder")).toBe(false);
  });
  test("two venue instances sharing an executor cannot spend the same headroom concurrently", async () => {
    let gross = 18000;
    const executor = fakeExecutor({ getAccount: async () => ({ equity: 10000, long_market_value: gross }) });
    const client = fakeClient({ getOrderByClientId: absent, createOrder: async (p) => {
      await Promise.resolve();
      gross += Number(p.qty) * 100;
      return { id: "filled", status: "filled", filled_qty: p.qty, filled_avg_price: "100" };
    } });
    const a = new AlpacaVenue(executor, client), b = new AlpacaVenue(executor, client);
    const results = await Promise.all([a.submit(intent({ qty: 10, notional: 1000 }), "a"), b.submit(intent({ qty: 10, notional: 1000 }), "b")]);
    expect(results.map(r => r.status)).toEqual(["filled", "account_gross_cap"]);
    expect(gross).toBe(19000);
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

describe("sessionOpens (Q7 V1 execution record)", () => {
  test("the snapshot's daily bar gives the session's RAW open; another ET date, a bad value or a failure leave the symbol out; no getSnapshot → {}", async () => {
    const snaps: Record<string, any> = {
      SPY: { DailyBar: { OpenPrice: 512.34, Timestamp: "2026-10-20T13:30:00Z" } },   // 09:30 ET of the session
      TLT: { DailyBar: { OpenPrice: 90.5, Timestamp: "2026-10-19T13:30:00Z" } },     // yesterday's bar (pre-open / holiday)
      GLD: { DailyBar: { OpenPrice: 0, Timestamp: "2026-10-20T13:30:00Z" } },
      SH: { DailyBar: null },
    };
    const client = Object.assign(fakeClient(), {
      getSnapshot: async (s: string) => { if (s === "QQQ") throw new Error("429"); return snaps[s]; },
    });
    const venue = new AlpacaVenue(fakeExecutor(), client, { sleep: async () => {} });
    expect(await venue.sessionOpens(["SPY", "TLT", "GLD", "SH", "QQQ", "SPY"], "2026-10-20")).toEqual({ SPY: 512.34 });
    expect(await new AlpacaVenue(fakeExecutor(), fakeClient(), { sleep: async () => {} }).sessionOpens(["SPY"], "2026-10-20")).toEqual({});
  });
});
