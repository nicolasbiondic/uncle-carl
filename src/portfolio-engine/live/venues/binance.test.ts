import { afterAll, describe, expect, test } from "bun:test";
import { BinanceVenueAdapter, type BinanceVenueOptions } from "./binance";
import { createBinanceUsdmTransport, type BinanceTransportKind } from "../../../executor/binance/usdmTransport";
import { VenueRateLimiter, VENUE_RATE_LIMITER_DEFAULTS } from "../../../executor/rateLimiter";
import type { OrderIntent } from "../../types";

interface Request { method: string; path: string; p: Record<string, string> }
const json = (body: unknown, status = 200) => Response.json(body, { status });
const reject = (code: number, msg = "fake venue error", status = 400) => json({ code, msg }, status);
const symbols = ["BTCUSDT", "ETHUSDT", "BTCUSDC", "ETHUSDC"];
const exchangeInfo = { symbols: symbols.map(symbol => ({
  symbol, status: "TRADING", contractType: "PERPETUAL", marginAsset: symbol.endsWith("USDC") ? "USDC" : "USDT",
  filters: [
    { filterType: "PRICE_FILTER", tickSize: "0.25", minPrice: "0.25", maxPrice: "1000000" },
    { filterType: "LOT_SIZE", stepSize: "0.005", minQty: "0.005", maxQty: "1000" },
    { filterType: "MARKET_LOT_SIZE", stepSize: "0.01", minQty: "0.01", maxQty: "100" },
    { filterType: "MIN_NOTIONAL", notional: symbol.endsWith("USDC") ? "10" : "5" },
  ],
})) };

class FakeFapi {
  requests: Request[] = [];
  orders = new Map<string, any>();
  regular: any[] = [];
  algo: any[] = [];
  positions: any[] = [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0.5", entryPrice: "90" }];
  claims = new Set<string>();
  mode = false;
  markPrice = "100";
  forceAlgo = false;
  postError = 0;
  hideOrders = false;
  queryError = false;
  stopReadError = false;
  stopPostError = false;
  hideStops = false;
  loseStopResponseOnce = false;
  executedQty = "0.12";
  avgPrice = "101.25";
  status = "FILLED";
  private nextId = 1;

  handle = (r: Request): Response => {
    this.requests.push(r);
    const { path, method, p } = r;
    if (path === "/fapi/v1/exchangeInfo") return json(exchangeInfo);
    if (path === "/fapi/v1/premiumIndex") return json({ symbol: p.symbol, markPrice: this.markPrice });
    if (path === "/fapi/v1/positionSide/dual") return json({ dualSidePosition: this.mode });
    if (path === "/fapi/v2/positionRisk") return json(this.positions.filter(pos => !p.symbol || pos.symbol === p.symbol));
    if (path === "/fapi/v1/openOrders") return json(this.hideStops ? [] : this.regular.filter(o => o.symbol === p.symbol));
    if (path === "/fapi/v1/openAlgoOrders") {
      return this.stopReadError ? reject(-1000, "cannot enumerate", 503) : json({ orders: this.hideStops ? [] : this.algo.filter(o => o.symbol === p.symbol) });
    }
    if (method === "GET" && path === "/fapi/v1/order") {
      if (this.queryError) return reject(-1000, "query unavailable", 503);
      const order = this.orders.get(p.origClientOrderId);
      return order && !this.hideOrders ? json(order) : reject(-2013, "Order does not exist");
    }
    if (method === "POST" && path === "/fapi/v1/order" && p.type === "MARKET") {
      const order = { symbol: p.symbol, clientOrderId: p.newClientOrderId, orderId: this.nextId++,
        status: this.status, executedQty: this.executedQty, avgPrice: this.avgPrice, cumQuote: "12.15" };
      this.orders.set(p.newClientOrderId, order);
      if (this.postError) return reject(this.postError, "Duplicate/ambiguous order", this.postError === -1000 ? 503 : 400);
      return json({ orderId: order.orderId, status: "NEW", executedQty: "0", avgPrice: "0" });
    }
    if (method === "POST" && (path === "/fapi/v1/order" || path === "/fapi/v1/algoOrder")) {
      if (this.stopPostError) return reject(-2019);
      if (this.forceAlgo && path === "/fapi/v1/order") return reject(-4120);
      const clientId = p.clientAlgoId ?? p.newClientOrderId;
      if (this.stops().some(o => (o.clientAlgoId ?? o.clientOrderId) === clientId)) {
        this.hideStops = false;
        return reject(-4116, "Duplicate stop client id");
      }
      const id = this.nextId++;
      if (path === "/fapi/v1/algoOrder") {
        const stop = { ...p, algoId: id, orderType: "STOP", totalQty: p.quantity };
        this.algo.push(stop);
        if (this.loseStopResponseOnce) { this.loseStopResponseOnce = false; this.hideStops = true; return reject(-1000, "lost response", 503); }
        return json(stop);
      }
      const stop = { ...p, orderId: id, clientOrderId: p.newClientOrderId, origQty: p.quantity };
      this.regular.push(stop);
      if (this.loseStopResponseOnce) { this.loseStopResponseOnce = false; this.hideStops = true; return reject(-1000, "lost response", 503); }
      return json(stop);
    }
    if (method === "DELETE" && path === "/fapi/v1/order") {
      this.regular = this.regular.filter(o => String(o.orderId) !== p.orderId);
      return json({ orderId: Number(p.orderId), status: "CANCELED" });
    }
    if (method === "DELETE" && path === "/fapi/v1/algoOrder") {
      this.algo = this.algo.filter(o => String(o.algoId) !== p.algoId);
      return json({ algoId: Number(p.algoId), code: 200 });
    }
    throw new Error(`Unexpected request ${method} ${path}`); // no settings writes allowed
  };
  marketPosts() { return this.requests.filter(r => r.method === "POST" && r.p.type === "MARKET"); }
  stops() { return [...this.regular, ...this.algo]; }
}

let state = new FakeFapi();
// The REAL transports are pointed ONLY at this loopback HTTP server, with fake
// credentials and an isolated limiter. No .env, executor init or broker calls.
const server = Bun.serve({ port: 0, fetch(req) {
  const url = new URL(req.url);
  const p = Object.fromEntries(url.searchParams);
  delete p.signature; delete p.timestamp;
  return state.handle({ method: req.method, path: url.pathname, p });
} });
afterAll(() => server.stop(true));

function setup(kind: BinanceTransportKind, options: Partial<BinanceVenueOptions> = {}, reset = true) {
  if (reset) state = new FakeFapi();
  const s = state;
  const transport = createBinanceUsdmTransport(kind, {
    baseUrl: () => `http://127.0.0.1:${server.port}`, apiKey: () => "fake-key", secretKey: () => "fake-secret",
    limiter: () => limiter,
  });
  const limiter = new VenueRateLimiter("binance_fapi", { ...VENUE_RATE_LIMITER_DEFAULTS.binance_fapi, disabled: true });
  const venue = new BinanceVenueAdapter({
    venue: "binance_usdm", sleeveId: "d3-usdt", symbols: ["BTC/USD", "ETH/USD"], transport,
    claimOrderId: async id => { if (s.claims.has(id)) return false; s.claims.add(id); return true; },
    ...options,
  });
  return { venue, s };
}

const buy = (qty = 0.129): OrderIntent => ({ symbol: "BTC/USD", side: "buy", qty, notional: qty * 100,
  targetWeight: 0.3, currentWeight: 0.1, reduceOnly: false });
const sell = (qty = 0.129): OrderIntent => ({ ...buy(qty), side: "sell", reduceOnly: true });

for (const kind of ["legacy", "sdk"] as const) describe(`Binance portfolio venue [${kind}]`, () => {
  test("cached exchangeInfo: MARKET_LOT_SIZE step, per-symbol minimum and mark reference", async () => {
    const { venue, s } = setup(kind);
    const rules = await venue.rules(["BTC/USD", "ETH/USD"]);
    expect(rules).toEqual({ venue: "binance_usdm", fractional: false, minOrderNotional: 5, rebalanceBand: 0.02,
      qtyStep: { "BTC/USD": 0.01, "ETH/USD": 0.01 }, minNotional: { "BTC/USD": 5, "ETH/USD": 5 } });
    await venue.rules(["BTC/USD"]);
    expect(s.requests.filter(r => r.path.endsWith("exchangeInfo"))).toHaveLength(1);
    expect(await venue.prices(["BTC/USD"])).toEqual({ "BTC/USD": 100 });
  });

  test("mapping, step flooring, ACK resolution and actual per-order filled quantity/average", async () => {
    const { venue, s } = setup(kind);
    const result = await venue.submit(buy(), "arbitrary spaces/ñ/".repeat(10));
    expect(result).toEqual({ ok: true, filledQty: 0.12, avgPrice: 101.25, status: "FILLED", brokerOrderId: "1" });
    const post = s.marketPosts()[0].p;
    expect(post.symbol).toBe("BTCUSDT");
    expect(post.type).toBe("MARKET");
    expect(post.quantity).toBe("0.12");
    expect(post.reduceOnly).toBeUndefined();
    expect(post.newClientOrderId).toMatch(/^[.A-Z:/a-z0-9_-]{1,36}$/);
  });

  test("non-decimal steps and floating point exact multiples never round up", async () => {
    const { venue, s } = setup(kind);
    // Existing floorToStep handles 0.29 / 0.01 without losing a unit.
    await venue.submit(buy(0.29), "exact-multiple");
    expect(s.marketPosts()[0].p.quantity).toBe("0.29");
    await venue.syncStops([{ symbol: "BTC/USD", stopPrice: 95.37 }], []);
    expect(Number(s.stops()[0].triggerPrice ?? s.stops()[0].stopPrice)).toBe(95.25);
  });

  test("minNotional checked after rounding against mark, not stale intent.notional", async () => {
    const { venue, s } = setup(kind);
    const result = await venue.submit({ ...buy(0.049), notional: 9999 }, "too-small");
    expect(result.status).toBe("SKIPPED");
    expect(s.marketPosts()).toHaveLength(0);
    expect(s.claims.size).toBe(0);
    expect((await venue.submit(buy(0.009), "below-step")).status).toBe("SKIPPED");
  });

  test("sell reduceOnly bounded by live long, below notional allowed; unsafe sides rejected", async () => {
    const { venue, s } = setup(kind);
    s.positions[0].positionAmt = "0.03";
    await venue.submit(sell(1), "reduce");
    expect(s.marketPosts()[0].p).toMatchObject({ symbol: "BTCUSDT", side: "SELL", quantity: "0.03", reduceOnly: "true" });
    expect((await venue.submit({ ...sell(), reduceOnly: false }, "short")).status).toBe("INVALID");
    expect((await venue.submit({ ...buy(), reduceOnly: true }, "buy-reduce")).status).toBe("INVALID");
    s.positions = [];
    expect((await venue.submit(sell(), "flat-sell")).status).toBe("SKIPPED");
    expect(s.marketPosts()).toHaveLength(1);
  });

  test("same id repeated/concurrent/after adapter restart queries original fill, only one POST", async () => {
    const { venue, s } = setup(kind);
    const [a, b] = await Promise.all([venue.submit(buy(), "retry"), venue.submit(buy(), "retry")]);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    s.markPrice = "0.01"; // retry must not be skipped by changed prices/filters
    const restarted = setup(kind, {}, false).venue;
    expect(await restarted.submit(buy(), "retry")).toEqual(a);
    expect(s.marketPosts()).toHaveLength(1);
  });

  test("durable claim prevents a second POST even if order history disappears", async () => {
    const { venue, s } = setup(kind);
    await venue.submit(buy(), "expired-history");
    s.orders.clear();
    const restarted = setup(kind, {}, false).venue;
    expect((await restarted.submit(buy(), "expired-history")).status).toBe("UNKNOWN");
    expect(s.marketPosts()).toHaveLength(1);
  });

  for (const errorCode of [-4116, -2010, -1000]) test(`duplicate/ambiguous POST ${errorCode} resolved by client id, never resent`, async () => {
    const { venue, s } = setup(kind);
    s.postError = errorCode;
    const result = await venue.submit(buy(), "duplicate");
    expect(result.ok).toBe(true);
    expect(result.filledQty).toBe(0.12);
    expect(s.marketPosts()).toHaveLength(1);
    expect(s.requests.filter(r => r.path.endsWith("/order") && r.method === "GET")).toHaveLength(2);
    await venue.submit(buy(), "duplicate");
    expect(s.marketPosts()).toHaveLength(1);
  });

  test("unknown outcome not visible by query stays unknown and never resubmits", async () => {
    const { venue, s } = setup(kind);
    s.postError = -1000; s.hideOrders = true;
    expect((await venue.submit(buy(), "lost-response")).status).toBe("UNKNOWN");
    expect((await venue.submit(buy(), "lost-response")).status).toBe("UNKNOWN");
    expect(s.marketPosts()).toHaveLength(1);
  });

  test("failed pre-query or durable claim cannot authorize submission", async () => {
    const { venue, s } = setup(kind);
    s.queryError = true;
    expect((await venue.submit(buy(), "read-failed")).ok).toBe(false);
    expect(s.marketPosts()).toHaveLength(0);
    s.queryError = false;
    const badJournal = setup(kind, { claimOrderId: async () => { throw new Error("journal unavailable"); } }, false).venue;
    expect((await badJournal.submit(buy(), "claim-failed")).ok).toBe(false);
    expect(s.marketPosts()).toHaveLength(0);
  });

  test("partial fills report executed quantity, not requested or aggregate; cumQuote fallback", async () => {
    const { venue, s } = setup(kind);
    s.status = "PARTIALLY_FILLED"; s.executedQty = "0.04"; s.avgPrice = "0";
    const result = await venue.submit(buy(), "partial");
    expect(result).toMatchObject({ ok: true, filledQty: 0.04, avgPrice: 12.15 / 0.04, status: "PARTIALLY_FILLED" });
    expect(s.marketPosts()).toHaveLength(1);
    s.status = "NEW"; s.executedQty = "0";
    expect(await venue.submit(buy(), "pending")).toMatchObject({ ok: false, filledQty: 0, avgPrice: null, status: "NEW" });
  });

  test("positions only requested symbols, long one-way; never changes account settings", async () => {
    const { venue, s } = setup(kind);
    s.positions.push({ symbol: "BTCUSDC", positionAmt: "2", entryPrice: "80", positionSide: "BOTH" });
    expect(await venue.positions(["BTC/USD"])).toEqual([{ symbol: "BTC/USD", qty: 0.5, avgEntryPrice: 90 }]);
    s.positions[0].positionAmt = "-0.5";
    await expect(venue.positions(["BTC/USD"])).rejects.toThrow(/short/);
    s.positions[0].positionAmt = "0"; s.positions[0].positionSide = "LONG";
    await expect(venue.positions(["BTC/USD"])).rejects.toThrow(/hedge/);
    const { venue: hedged, s: s2 } = setup(kind);
    s2.mode = true;
    expect((await hedged.submit(buy(), "hedge-mode")).error).toContain("one-way");
    expect(s2.requests.some(r => r.method === "POST")).toBe(false);
  });

  test("USDC canonical USD and legacy USDC mapping, no USDT requests or fills", async () => {
    const { venue, s } = setup(kind, { venue: "binance_usdc", sleeveId: "d3-usdc" });
    s.positions = [{ symbol: "BTCUSDC", positionAmt: "0.4", entryPrice: "90", positionSide: "BOTH" },
      { symbol: "BTCUSDT", positionAmt: "7", entryPrice: "80", positionSide: "BOTH" }];
    expect((await venue.rules(["BTC/USD"])).minNotional).toEqual({ "BTC/USD": 10 });
    expect(await venue.positions(["BTC/USD"])).toEqual([{ symbol: "BTC/USD", qty: 0.4, avgEntryPrice: 90 }]);
    await venue.submit(buy(), "usdc");
    await venue.syncStops([{ symbol: "BTC/USD", stopPrice: 95 }], []);
    expect(s.requests.every(r => !r.p.symbol || ["BTCUSDC", "ETHUSDC"].includes(r.p.symbol))).toBe(true);
    const legacy = setup(kind, { venue: "binance_usdc", symbols: ["BTC/USDC"] }, false).venue;
    expect(await legacy.prices(["BTC/USDC"])).toEqual({ "BTC/USDC": 100 });
  });

  test("USDC minimum differs; wrong mappings and aliases fail before I/O", async () => {
    const { venue, s } = setup(kind, { venue: "binance_usdc" });
    expect((await venue.submit(buy(0.09), "usdc-small")).status).toBe("SKIPPED");
    expect(s.marketPosts()).toHaveLength(0);
    expect(() => setup(kind, { venue: "binance_usdc", symbols: ["ATOM/USD"] })).toThrow(/mapping/);
    expect(() => setup(kind, { venue: "binance_usdc", symbols: ["BTC/USD", "BTC/USDC"] })).toThrow(/Duplicate native/);
    expect(() => setup(kind, { symbols: ["BTC/USDC"] })).toThrow(/mapping/);
    await expect(venue.prices(["DOGE/USD"])).rejects.toThrow(/outside sleeve/);
  });

  test("all five D3 majors route through their quote's existing map", async () => {
    const majors = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD"];
    for (const quote of ["USDT", "USDC"] as const) {
      const { venue, s } = setup(kind, { venue: quote === "USDT" ? "binance_usdm" : "binance_usdc", symbols: majors });
      expect(Object.keys(await venue.prices(majors))).toEqual(majors);
      expect(s.requests.map(r => r.p.symbol)).toEqual(["BTC", "ETH", "SOL", "XRP", "DOGE"].map(base => base + quote));
    }
  });

  test("stop create/idempotent/replace quantity/replace tick price/cancel when flat", async () => {
    const { venue, s } = setup(kind);
    s.forceAlgo = true; // exercise -4120 fallback on legacy, SDK pre-transmit on sdk
    const desired = [{ symbol: "BTC/USD", stopPrice: 95.37 }];
    await venue.syncStops(desired, []);
    expect(s.algo).toHaveLength(1);
    expect(s.algo[0]).toMatchObject({ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", quantity: "0.5",
      triggerPrice: "95.25", reduceOnly: "true", workingType: "MARK_PRICE", algoType: "CONDITIONAL" });
    expect(s.algo[0].clientAlgoId).toMatch(/^pe-s-[a-f0-9]{12}-[a-f0-9]+$/);
    expect(s.algo[0].clientAlgoId.length).toBeLessThanOrEqual(36);
    const first = s.algo[0].algoId;
    await venue.syncStops(desired, []);
    expect(s.algo[0].algoId).toBe(first);
    s.positions[0].positionAmt = "0.31";
    await venue.syncStops(desired, [{ symbol: "BTC/USD", qty: 999, avgEntryPrice: 1 }]); // stale snapshot not sizing source
    expect(s.algo).toHaveLength(1);
    expect(s.algo[0].quantity).toBe("0.31");
    expect(s.algo[0].algoId).not.toBe(first);
    const requestCount = s.requests.length;
    await venue.syncStops([{ symbol: "BTC/USD", stopPrice: 94.8 }], []);
    expect(s.algo).toHaveLength(1);
    expect(s.algo[0].triggerPrice).toBe("94.75");
    const changes = s.requests.slice(requestCount).filter(r => r.method === "POST" || r.method === "DELETE");
    expect(changes[0].method).toBe("POST"); // replacement before cancel
    expect(changes.at(-1)?.method).toBe("DELETE");
    s.positions = [];
    await venue.syncStops(desired, []);
    expect(s.stops()).toHaveLength(0);
  });

  test("sync [] cancels own stops across both stores only, preserves other sleeves/manual/quotes", async () => {
    const { venue, s } = setup(kind);
    await venue.syncStops([{ symbol: "BTC/USD", stopPrice: 95 }], []);
    const ownId = s.stops()[0].clientAlgoId ?? s.stops()[0].clientOrderId;
    s.regular.push({ symbol: "BTCUSDT", clientOrderId: ownId, orderId: 777, type: "STOP_MARKET" });
    s.algo.push({ symbol: "BTCUSDT", clientAlgoId: ownId, algoId: 778, orderType: "STOP" });
    s.regular.push({ symbol: "BTCUSDT", clientOrderId: "manual", orderId: 800 });
    s.algo.push({ symbol: "BTCUSDT", clientAlgoId: "uc-fapi-old-sleeve", algoId: 801 });
    const sibling = setup(kind, { sleeveId: "other-sleeve" }, false).venue;
    await sibling.syncStops([{ symbol: "BTC/USD", stopPrice: 92 }], []);
    const siblingStops = s.stops().filter(o => String(o.clientAlgoId ?? o.clientOrderId).startsWith("pe-s-") &&
      (o.clientAlgoId ?? o.clientOrderId) !== ownId);
    expect(siblingStops).toHaveLength(1);
    s.algo.push({ symbol: "BTCUSDC", clientAlgoId: ownId, algoId: 802 });
    await venue.syncStops([], []);
    expect(s.stops()).toHaveLength(4);
    expect(s.stops()).toContainEqual(siblingStops[0]);
    expect(s.regular.some(o => o.orderId === 800)).toBe(true);
    expect(s.algo.some(o => o.algoId === 801)).toBe(true);
    expect(s.algo.some(o => o.algoId === 802)).toBe(true);
  });

  test("failed stop replacement or partial enumeration leaves protection intact", async () => {
    const { venue, s } = setup(kind);
    await venue.syncStops([{ symbol: "BTC/USD", stopPrice: 95 }], []);
    const before = JSON.stringify(s.stops());
    s.stopPostError = true;
    await expect(venue.syncStops([{ symbol: "BTC/USD", stopPrice: 94 }], [])).rejects.toThrow();
    expect(JSON.stringify(s.stops())).toBe(before);
    expect(s.requests.some(r => r.method === "DELETE")).toBe(false);
    s.stopReadError = true;
    await expect(venue.syncStops([], [])).rejects.toThrow();
    expect(JSON.stringify(s.stops())).toBe(before);
    expect(s.requests.some(r => r.method === "DELETE")).toBe(false);
  });

  test("lost stop response plus delayed enumeration cannot create duplicate protection on retry", async () => {
    const { venue, s } = setup(kind);
    s.loseStopResponseOnce = true;
    const desired = [{ symbol: "BTC/USD", stopPrice: 95 }];
    await expect(venue.syncStops(desired, [])).rejects.toThrow();
    expect(s.stops()).toHaveLength(1); // accepted, but the first readback cannot see it
    await venue.syncStops(desired, []);
    expect(s.stops()).toHaveLength(1);
  });

  test("invalid/duplicate stops and out-of-sleeve input never mutate anything", async () => {
    const { venue, s } = setup(kind);
    await expect(venue.syncStops([{ symbol: "BTC/USD", stopPrice: NaN }], [])).rejects.toThrow(/Invalid/);
    await expect(venue.syncStops([{ symbol: "BTC/USD", stopPrice: 90 }, { symbol: "BTC/USD", stopPrice: 91 }], [])).rejects.toThrow(/duplicate/);
    await expect(venue.syncStops([], [{ symbol: "SOL/USD", qty: 1, avgEntryPrice: 10 }])).rejects.toThrow(/outside sleeve/);
    expect(s.requests).toHaveLength(0);
  });
});
