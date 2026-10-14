// ══════════════════════════════════════════════
// alpaca-v5-compat — shape fidelity + error passthrough (network-free)
// ══════════════════════════════════════════════
//
// The adapter's contract is "v3 in, v3 out": raw snake_case wire JSON with
// numeric strings, v3's PascalCase snapshot entity, and v5 typed errors that
// satisfy AlpacaExecutor's error parses (`e?.response?.status || e?.status`,
// `e?.response?.data?.message ?? e?.message`). Each test feeds the SDK's
// network-free mock (createMockAlpaca) a canned WIRE response and asserts the
// adapter hands back what the v3 SDK used to.

import { describe, test, expect } from "bun:test";
import { mockFetch, type MockRoute } from "@alpacahq/alpaca-trade-api/testing";
import { errors } from "@alpacahq/alpaca-trade-api";
import { createAlpacaV3Compat, type AlpacaV3CompatClient } from "./alpaca-v5-compat";
import { isWashTrade403 } from "./alpaca-executor";

const BASE = { keyId: "k", secretKey: "s", paper: true, baseUrl: "https://paper-api.alpaca.markets" };

// fetchApi injection (not createMockAlpaca): the compat factory builds the
// REAL client configuration — retry:false, rateLimit:false, middleware — and
// the thrown errors share one class identity with the root import's `errors`.
function compat(routes: MockRoute[]): AlpacaV3CompatClient {
  return createAlpacaV3Compat(BASE, { fetchApi: mockFetch(routes) });
}

// A wire order exactly as GET /v2/orders/{id} returns it (numeric strings,
// ISO timestamps, both `type` and `order_type`).
const WIRE_ORDER = {
  id: "904837e3-3b76-47ec-b432-046db621571b",
  client_order_id: "uc8-meanrev_stocks-abcdef0123456789",
  created_at: "2026-10-13T09:35:01.331Z",
  updated_at: "2026-10-13T09:35:02.331Z",
  submitted_at: "2026-10-13T09:35:01.331Z",
  filled_at: "2026-10-13T09:35:02.111Z",
  expired_at: null,
  canceled_at: null,
  failed_at: null,
  replaced_at: null,
  replaced_by: null,
  replaces: null,
  asset_id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415",
  symbol: "AAPL",
  asset_class: "us_equity",
  notional: null,
  qty: "11",
  filled_qty: "11",
  filled_avg_price: "262.41",
  order_class: "simple",
  order_type: "market",
  type: "market",
  side: "buy",
  time_in_force: "day",
  limit_price: null,
  stop_price: null,
  status: "filled",
  extended_hours: false,
  legs: null,
  trail_percent: null,
  trail_price: null,
  hwm: null,
};

describe("alpaca-v5-compat shape fidelity", () => {
  test("getAccount returns the raw snake_case account (numeric strings, kill-switch flag)", async () => {
    const client = compat([{
      method: "GET", path: "/v2/account",
      body: {
        id: "acc-1", account_number: "PA3ABC", status: "ACTIVE", currency: "USD",
        equity: "100213.45", cash: "35000.10", buying_power: "374001.0",
        regt_buying_power: "187000.5", trade_suspended_by_user: true,
        pattern_day_trader: false, portfolio_value: "100213.45",
      },
    }]);
    const acc = await client.getAccount();
    expect(acc.id).toBe("acc-1");
    expect(acc.equity).toBe("100213.45");            // numeric STRING, not number
    expect(acc.cash).toBe("35000.10");
    expect(acc.regt_buying_power).toBe("187000.5");  // getRegTBuyingPower reads this
    expect(acc.buying_power).toBe("374001.0");
    expect(acc.trade_suspended_by_user).toBe(true);  // noteTradeSuspended reads this
  });

  test("getOrder / getOrderByClientId return the raw wire order", async () => {
    const client = compat([
      { method: "GET", path: `/v2/orders/${WIRE_ORDER.id}`, body: WIRE_ORDER },
      { method: "GET", path: "/v2/orders:by_client_order_id", body: WIRE_ORDER },
    ]);
    for (const o of [await client.getOrder(WIRE_ORDER.id), await client.getOrderByClientId(WIRE_ORDER.client_order_id)]) {
      expect(o.id).toBe(WIRE_ORDER.id);
      expect(o.client_order_id).toBe(WIRE_ORDER.client_order_id);
      expect(o.filled_qty).toBe("11");                  // parseFloat(order.filled_qty)
      expect(o.filled_avg_price).toBe("262.41");
      expect(o.status).toBe("filled");
      expect(o.type).toBe("market");
      expect(o.order_type).toBe("market");              // getOpenStopOrders reads either
      expect(o.side).toBe("buy");
      expect(o.qty).toBe("11");
      // KNOWN DELTA vs v3: wire `null` on optional fields round-trips to
      // ABSENT (FromJSON maps null→undefined). Every executor read is
      // truthiness- or `??`-guarded (`o.replaced_by ? … : null`,
      // `parseFloat(o?.stop_price ?? "0")`), so behavior is identical.
      expect(o.replaced_by).toBeUndefined();
      // v3 delivered the ISO string axios parsed; executor does new Date(x).getTime()
      expect(new Date(o.filled_at).getTime()).toBe(new Date(WIRE_ORDER.filled_at).getTime());
    }
  });

  test("createOrder sends the executor's snake_case body unchanged (qty stays a number)", async () => {
    let seenBody: any = null;
    const client = compat([{
      method: "POST", path: "/v2/orders",
      respond: async (req) => {
        seenBody = JSON.parse(String(req.init?.body));
        return WIRE_ORDER;
      },
    }]);
    const order = await client.createOrder({
      symbol: "AAPL", side: "buy", type: "market", time_in_force: "day",
      client_order_id: "uc8-meanrev_stocks-abcdef0123456789", qty: 11,
    });
    expect(seenBody.symbol).toBe("AAPL");
    expect(seenBody.side).toBe("buy");
    expect(seenBody.type).toBe("market");
    expect(seenBody.time_in_force).toBe("day");
    expect(seenBody.client_order_id).toBe("uc8-meanrev_stocks-abcdef0123456789");
    expect(seenBody.qty).toBe(11); // v3 sent the number through; still a number
    expect(order.id).toBe(WIRE_ORDER.id);
  });

  test("createOrder carries stop/limit/notional fields (GTC stop placement body)", async () => {
    let seenBody: any = null;
    const client = compat([{
      method: "POST", path: "/v2/orders",
      respond: async (req) => { seenBody = JSON.parse(String(req.init?.body)); return WIRE_ORDER; },
    }]);
    await client.createOrder({
      symbol: "MRK", qty: 7, side: "sell", type: "stop",
      stop_price: 81.44, time_in_force: "gtc", client_order_id: "uc8-x-sl0011",
    });
    expect(seenBody.type).toBe("stop");
    expect(seenBody.stop_price).toBe(81.44);
    expect(seenBody.time_in_force).toBe("gtc");
  });

  test("getOrders forwards status/limit/nested and returns raw wire orders", async () => {
    let seenUrl: URL | null = null;
    const client = compat([{
      method: "GET", path: "/v2/orders",
      respond: async (req) => { seenUrl = req.url; return Response.json([WIRE_ORDER]); },
    }]);
    const out = await client.getOrders({ status: "open", limit: 500, nested: false });
    expect(seenUrl!.searchParams.get("status")).toBe("open");
    expect(seenUrl!.searchParams.get("limit")).toBe("500");
    expect(seenUrl!.searchParams.get("nested")).toBe("false");
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].client_order_id).toBe(WIRE_ORDER.client_order_id);
    expect(out[0].stop_price).toBeUndefined(); // wire null → absent (see KNOWN DELTA above)
  });

  test("getPosition / getPositions return raw snake_case positions", async () => {
    const wirePos = {
      asset_id: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415", symbol: "DOGEUSD",
      exchange: "CRYPTO", asset_class: "crypto", avg_entry_price: "0.2211",
      qty: "1000", side: "long", market_value: "230.00", cost_basis: "221.10",
      unrealized_pl: "8.90", unrealized_plpc: "0.0402",
      unrealized_intraday_pl: "1.00", unrealized_intraday_plpc: "0.004",
      current_price: "0.2300", lastday_price: "0.2290", change_today: "0.0043",
    };
    const client = compat([
      { method: "GET", path: "/v2/positions/DOGEUSD", body: wirePos },
      { method: "GET", path: "/v2/positions", body: [wirePos] },
    ]);
    const one = await client.getPosition("DOGEUSD");
    expect(one.qty).toBe("1000");                   // tryClose: Math.abs(parseFloat(pos.qty))
    const all = await client.getPositions();
    expect(all[0].symbol).toBe("DOGEUSD");
    expect(all[0].asset_class).toBe("crypto");      // getPositions crypto normalization
    expect(all[0].avg_entry_price).toBe("0.2211");
    expect(all[0].current_price).toBe("0.2300");
    expect(all[0].unrealized_pl).toBe("8.90");
    expect(all[0].unrealized_plpc).toBe("0.0402");
  });

  test("closePosition is the whole-position DELETE and returns the close order", async () => {
    let method = "";
    let seenUrl: URL | null = null;
    const client = compat([{
      path: "/v2/positions/AAPL",
      respond: async (req) => { method = req.method; seenUrl = req.url; return WIRE_ORDER; },
    }]);
    const order = await client.closePosition("AAPL");
    expect(method).toBe("DELETE");
    expect(seenUrl!.searchParams.get("qty")).toBe(null); // NEVER a qty at this layer (AGENTS.md close semantics)
    expect(order.id).toBe(WIRE_ORDER.id);
  });

  test("getAccountActivities accepts v3's string activityTypes and returns raw FILL rows", async () => {
    let seenUrl: URL | null = null;
    const wireFill = {
      id: "20261013000000000::fill1", activity_type: "FILL", transaction_time: "2026-10-13T13:35:02.111Z",
      type: "fill", price: "262.41", qty: "11", side: "buy", symbol: "AAPL",
      leaves_qty: "0", order_id: WIRE_ORDER.id, cum_qty: "11", order_status: "filled",
    };
    const client = compat([{
      method: "GET", path: "/v2/account/activities",
      respond: async (req) => { seenUrl = req.url; return Response.json([wireFill]); },
    }]);
    const acts = await client.getAccountActivities({ activityTypes: "FILL" });
    expect(seenUrl!.searchParams.getAll("activity_types").join(",")).toContain("FILL");
    expect(acts[0].order_id).toBe(WIRE_ORDER.id);   // resolvePartialFillPrice reads these
    expect(acts[0].qty).toBe("11");
    expect(acts[0].price).toBe("262.41");
  });

  test("getSnapshot returns v3's PascalCase entity (LatestTrade/LatestQuote/bars)", async () => {
    const client = compat([{
      method: "GET", path: "/v2/stocks/SPY/snapshot",
      body: {
        latestTrade: { t: "2026-10-13T13:35:00.123456789Z", x: "V", p: 660.31, s: 100, c: ["@"], i: 55, z: "B" },
        latestQuote: { t: "2026-10-13T13:35:00.5Z", ax: "V", ap: 660.35, as: 3, bx: "V", bp: 660.28, bs: 2, c: ["R"], z: "B" },
        minuteBar: { t: "2026-10-13T13:34:00Z", o: 660, h: 660.4, l: 659.9, c: 660.3, v: 12345, n: 100, vw: 660.1 },
        dailyBar: { t: "2026-10-13T04:00:00Z", o: 658, h: 661, l: 657.5, c: 660.3, v: 1234567, n: 10000, vw: 659.4 },
        prevDailyBar: { t: "2026-10-10T04:00:00Z", o: 655, h: 659, l: 654, c: 658.2, v: 2234567, n: 20000, vw: 656.9 },
      },
    }]);
    const snap = await client.getSnapshot("SPY");
    expect(snap.LatestTrade.Price).toBe(660.31);
    // v5 parses RFC-3339 into a Date and re-serializes to ms precision; the
    // executor only ever does new Date(Timestamp).getTime(), identical here.
    expect(new Date(snap.LatestTrade.Timestamp).getTime())
      .toBe(new Date("2026-10-13T13:35:00.123456789Z").getTime());
    expect(snap.LatestQuote.BidPrice).toBe(660.28);
    expect(snap.LatestQuote.AskPrice).toBe(660.35);
    expect(new Date(snap.LatestQuote.Timestamp).getTime())
      .toBe(new Date("2026-10-13T13:35:00.5Z").getTime());
    expect(snap.DailyBar.ClosePrice).toBe(660.3);
    expect(snap.PrevDailyBar.OpenPrice).toBe(655);
    expect(snap.MinuteBar.Volume).toBe(12345);
    expect(snap.symbol).toBe("SPY");
  });

  test("getSnapshot tolerates missing sections (quiet/halted symbol)", async () => {
    const client = compat([{
      method: "GET", path: "/v2/stocks/HALT/snapshot",
      body: { latestTrade: { t: "2026-10-13T13:35:00Z", x: "V", p: 10, s: 1, c: [], i: 1, z: "A" } },
    }]);
    const snap = await client.getSnapshot("HALT");
    expect(snap.LatestTrade.Price).toBe(10);
    expect(snap.LatestQuote).toBeUndefined();
    expect(snap.DailyBar).toBeUndefined();
  });

  test("trade_ws: present in key mode with the v3 surface; absent in OAuth mode", () => {
    const keyClient = compat([]);
    const ws: any = keyClient.trade_ws;
    expect(ws).toBeDefined();
    for (const m of ["onConnect", "onDisconnect", "onStateChange", "onError", "onOrderUpdate", "subscribe", "connect", "disconnect"]) {
      expect(typeof ws[m]).toBe("function");
    }
    const oauthClient = createAlpacaV3Compat(
      { oauth: "tok", paper: true, baseUrl: "https://paper-api.alpaca.markets" },
      { fetchApi: mockFetch([]) });
    expect(oauthClient.trade_ws).toBeUndefined(); // executor warns + stays on REST polling
  });

  test("no credentials: the client still exists (v3 parity) and each call rejects with the SDK's credential error", async () => {
    // v5's constructor throws without credentials; v3's didn't. A keyless
    // checkout (CI, a fresh install before linking an account) must keep a
    // client whose configuration is readable and whose calls fail.
    const calls: string[] = [];
    const keyless = createAlpacaV3Compat(
      { keyId: "", secretKey: "", paper: true, baseUrl: "https://paper-api.alpaca.markets" },
      { fetchApi: (async (url: string) => { calls.push(String(url)); throw new Error("must not reach the network"); }) as any });
    expect(keyless.configuration).toEqual({ keyId: "", secretKey: "", paper: true, baseUrl: "https://paper-api.alpaca.markets", oauth: "" });
    await expect(keyless.getAccount()).rejects.toThrow(/authentication/i);
    await expect(keyless.createOrder({ symbol: "SPY", qty: 1, side: "buy", type: "market", time_in_force: "day" })).rejects.toThrow(/authentication/i);
    expect(keyless.trade_ws).toBeUndefined();
    expect(calls).toEqual([]);
    const halfKey = createAlpacaV3Compat({ keyId: "k", secretKey: "", paper: true, baseUrl: "" });
    await expect(halfKey.getPositions()).rejects.toThrow(/authentication/i);
  });

  test("custom trading baseUrl rewrites trading-API URLs only (market data untouched)", async () => {
    const seen: string[] = [];
    const routes: MockRoute[] = [
      { method: "GET", path: "/v2/account", respond: async (req) => { seen.push(req.url.origin); return { id: "a", equity: "1", cash: "1" }; } },
      { method: "GET", path: "/v2/stocks/SPY/snapshot", respond: async (req) => { seen.push(req.url.origin); return {}; } },
    ];
    const client = createAlpacaV3Compat(
      { keyId: "k", secretKey: "s", paper: false, baseUrl: "https://broker-gw.example.com" },
      { fetchApi: mockFetch(routes) });
    await client.getAccount();
    await client.getSnapshot("SPY");
    expect(seen[0]).toBe("https://broker-gw.example.com"); // trading host rewritten
    expect(seen[1]).toBe("https://data.alpaca.markets");   // market data stays default (v3 never got dataBaseUrl)
  });
});

describe("alpaca-v5-compat error passthrough (the executor's exact parses)", () => {
  const status = (e: any) => e?.response?.status || e?.status || null;           // placeOrder/closePosition/cancelOrderById
  const bodyMessage = (e: any) => String(e?.response?.data?.message ?? e?.message ?? ""); // wash-trade/held-qty/duplicate-id

  test("wash-trade 403: status + body message classify via isWashTrade403", async () => {
    const client = compat([{
      method: "POST", path: "/v2/orders", status: 403,
      body: { code: 40310000, message: "potential wash trade detected. use complex orders" },
    }]);
    let err: any;
    try { await client.createOrder({ symbol: "AAPL", side: "buy", type: "market", time_in_force: "day", qty: 1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(errors.PermissionError);
    expect(status(err)).toBe(403);
    expect(isWashTrade403(status(err), bodyMessage(err))).toBe(true);
  });

  test("held-for-orders 403: body message survives for HELD_QTY_403_RE", async () => {
    const client = compat([{
      path: "/v2/positions/MA", status: 403,
      body: { code: 40310000, message: "insufficient qty available for order (requested: 9, available: 0)" },
    }]);
    let err: any;
    try { await client.closePosition("MA"); } catch (e) { err = e; }
    expect(status(err)).toBe(403);
    expect(/insufficient qty|held for orders/i.test(bodyMessage(err))).toBe(true);
  });

  test("duplicate client_order_id 422: ValidationError, message names the field", async () => {
    const client = compat([{
      method: "POST", path: "/v2/orders", status: 422,
      body: { code: 42210000, message: "client_order_id must be unique" },
    }]);
    let err: any;
    try { await client.createOrder({ symbol: "AAPL", side: "buy", type: "market", time_in_force: "day", qty: 1, client_order_id: "dup" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(errors.ValidationError);
    expect(status(err)).toBe(422);
    expect(/client[_ -]?order[_ -]?id/i.test(bodyMessage(err))).toBe(true);
  });

  test("404s: getOrderByClientId resolve path and position-gone reconcile", async () => {
    const client = compat([
      { method: "GET", path: "/v2/orders:by_client_order_id", status: 404, body: { code: 40410000, message: "order not found" } },
      { method: "GET", path: "/v2/positions/GONE", status: 404, body: { code: 40410000, message: "position does not exist" } },
    ]);
    for (const call of [() => client.getOrderByClientId("uc8-x-y"), () => client.getPosition("GONE")]) {
      let err: any;
      try { await call(); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(errors.NotFoundError);
      expect(status(err)).toBe(404);
    }
  });

  test("cancelOrder 404/422 reach the executor as those statuses (treated as already-terminal)", async () => {
    const client = compat([{ method: "DELETE", path: /^\/v2\/orders\//, status: 422, body: { code: 42210000, message: "order is not cancelable" } }]);
    let err: any;
    try { await client.cancelOrder("oid-1"); } catch (e) { err = e; }
    expect(status(err)).toBe(422);
  });

  test("429 carries its status for the limiter's notePenalty", async () => {
    const client = compat([{ method: "GET", path: "/v2/account", status: 429, body: { message: "rate limit exceeded" } }]);
    let err: any;
    try { await client.getAccount(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(errors.RateLimitError);
    expect(err?.response?.status ?? err?.status ?? null).toBe(429); // limited()'s exact read
  });

  test("transport failure has NO status → the executor's unknown-outcome path", async () => {
    const client = compat([{
      method: "POST", path: "/v2/orders",
      respond: async () => { throw new TypeError("fetch failed"); },
    }]);
    let err: any;
    try { await client.createOrder({ symbol: "AAPL", side: "buy", type: "market", time_in_force: "day", qty: 1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(errors.FetchError);
    expect(status(err)).toBe(null); // code === null ⇒ resolve by client_order_id, never resend
  });

  test("5xx keeps its status (ambiguous-after-transmit taxonomy)", async () => {
    const client = compat([{ method: "POST", path: "/v2/orders", status: 503, body: { message: "service unavailable" } }]);
    let err: any;
    try { await client.createOrder({ symbol: "AAPL", side: "buy", type: "market", time_in_force: "day", qty: 1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(errors.ApiError);
    expect(status(err)).toBe(503);
  });
});
