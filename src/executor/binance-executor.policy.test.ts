// ══════════════════════════════════════════════
// BinanceExecutor — execution policy + order outcome taxonomy (2026-08-03)
// ══════════════════════════════════════════════
//
//  - DEFAULT (no policy): placeOrder submits ONE MARKET POST (now stamped
//    with an idempotent uc-fapi- client id — the resolution handle).
//  - Transport-ambiguous POST: resolved by GET origClientOrderId, NEVER a
//    second POST; unresolved → UnknownOrderResult.
//  - With an entry policy: LIMIT chase for that sleeve only.
//  - closePosition failure paths carry the three-state outcome.

import { describe, test, expect, afterEach } from "bun:test";
import { BinanceExecutor } from "./binance-executor";
import { InstrumentCatalog, type InstrumentSpec } from "./binance/instrumentSpec";
import { setExecutionPolicy, __clearExecutionPolicies, isUnknownOrder, validatePolicy } from "./executionPolicy";

afterEach(() => __clearExecutionPolicies());

function makeSpec(symbol: string): InstrumentSpec {
  return {
    symbol, status: "TRADING", contractType: "PERPETUAL", marginAsset: "USDT",
    tickSize: 0.1, minPrice: 0, maxPrice: 0,
    stepSize: 0.001, minQty: 0.001, maxQty: 1000,
    marketStepSize: 0.001, marketMinQty: 0.001, marketMaxQty: 1000,
    minNotional: null,
  };
}

type Route = (method: string, path: string, params: any) => any;

function makeExec(route: Route): any {
  const exec = new BinanceExecutor() as any;
  exec.connected = true;
  exec.pollDelayMs = 1;
  const catalog = new InstrumentCatalog(async () => { throw new Error("no network in tests"); });
  catalog.seed([makeSpec("BTCUSDT")]);
  exec.catalog = catalog;
  exec.getExecutableQuote = async () => null; // per-test override
  exec.signedRequest = async (method: string, path: string, params: any = {}) => route(method, path, params);
  exec.leverageBySymbol.set("BTCUSDT", 2);
  return exec;
}

function cryptoSignal(side: "buy" | "sell" = "buy"): any {
  return {
    id: "sig1", symbol: "BTC/USD", market: "crypto", side, strategy: "MOMENTUM",
    strength: "strong", price: 50_000, timestamp: Date.now(), indicators: {}, reason: "test",
  };
}

describe("placeOrder DEFAULT — market POST, idempotent client id", () => {
  test("submits exactly one MARKET order stamped uc-fapi-", async () => {
    delete process.env.EXECUTION_POLICY_JSON;
    __clearExecutionPolicies();
    const posts: any[] = [];
    const exec = makeExec((method, path, params) => {
      if (method === "POST" && path === "/fapi/v1/order") {
        posts.push(params);
        return { orderId: 1, status: "FILLED", avgPrice: "50000", executedQty: "0.01", updateTime: 111 };
      }
      if (path === "/fapi/v1/userTrades") return [];
      return {};
    });
    const order = await exec.placeOrder(cryptoSignal("buy"), 0.01, "momentum_crypto");
    expect(posts).toHaveLength(1);
    expect(posts[0].type).toBe("MARKET");
    expect(posts[0].price).toBeUndefined();
    expect(String(posts[0].newClientOrderId).startsWith("uc-fapi-")).toBe(true);
    expect((order as any)?.type).toBe("market");
    expect((order as any)?.filledPrice).toBe(50000);
  });
});

describe("order outcome taxonomy — ambiguous POST", () => {
  test("transport failure → resolved by GET origClientOrderId, NO second POST", async () => {
    let posts = 0;
    let resolvedWith: string | undefined;
    const exec = makeExec((method, path, params) => {
      if (method === "POST" && path === "/fapi/v1/order") {
        posts++;
        throw new Error("socket hang up"); // no code, no httpStatus → ambiguous
      }
      if (method === "GET" && path === "/fapi/v1/order" && params.origClientOrderId) {
        resolvedWith = params.origClientOrderId;
        return { orderId: 7, status: "FILLED", avgPrice: "50000", executedQty: "0.01", updateTime: 111 };
      }
      if (path === "/fapi/v1/userTrades") return [];
      return {};
    });
    const order = await exec.placeOrder(cryptoSignal("buy"), 0.01, "momentum_crypto");
    expect(posts).toBe(1); // NEVER resent
    expect(String(resolvedWith).startsWith("uc-fapi-")).toBe(true);
    expect(isUnknownOrder(order)).toBe(false);
    expect((order as any)?.externalId).toBe("7");
    expect((order as any)?.filledPrice).toBe(50000);
  });

  test("venue-confirmed 4xx rejection → null, no resolution query", async () => {
    let resolutionQueries = 0;
    const exec = makeExec((method, path, params) => {
      if (method === "POST" && path === "/fapi/v1/order") {
        const e: any = new Error("Binance /fapi/v1/order HTTP 400: Filter failure");
        e.code = -1013; e.httpStatus = 400;
        throw e;
      }
      if (method === "GET" && path === "/fapi/v1/order" && params.origClientOrderId) resolutionQueries++;
      return {};
    });
    expect(await exec.placeOrder(cryptoSignal("buy"), 0.01, "momentum_crypto")).toBeNull();
    expect(resolutionQueries).toBe(0);
  });

  test("-2013 on resolution proves the order never landed → null", async () => {
    const exec = makeExec((method, path, params) => {
      if (method === "POST" && path === "/fapi/v1/order") throw new Error("ETIMEDOUT");
      if (method === "GET" && path === "/fapi/v1/order" && params.origClientOrderId) {
        const e: any = new Error("Order does not exist"); e.code = -2013; throw e;
      }
      return {};
    });
    expect(await exec.placeOrder(cryptoSignal("buy"), 0.01, "momentum_crypto")).toBeNull();
  });

  test("resolution exhausted → UnknownOrderResult; the caller gets the idempotent id, not a rejection", async () => {
    let posts = 0;
    const exec = makeExec((method, path, params) => {
      if (method === "POST" && path === "/fapi/v1/order") { posts++; throw new Error("ETIMEDOUT"); }
      if (method === "GET" && path === "/fapi/v1/order" && params.origClientOrderId) throw new Error("still down");
      return {};
    });
    const order = await exec.placeOrder(cryptoSignal("buy"), 0.01, "momentum_crypto");
    expect(posts).toBe(1);
    expect(isUnknownOrder(order)).toBe(true);
    expect((order as any).clientOrderId.startsWith("uc-fapi-")).toBe(true);
  });
});

describe("placeOrder with an entry limit_chase policy", () => {
  test("submits a LIMIT GTC order on the tick grid and returns the chase fill (+estPx telemetry)", async () => {
    setExecutionPolicy("momentum_crypto", validatePolicy({
      entry: { style: "limit_chase", offsetBps: 0, refreshThresholdBps: 5, maxReprices: 1, maxDistanceBps: 20, timeoutMs: 2_000, pollIntervalMs: 5 },
    })!);
    const posts: any[] = [];
    const exec = makeExec((method, path, params) => {
      if (method === "POST" && path === "/fapi/v1/order") { posts.push(params); return { orderId: 11 }; }
      if (method === "GET" && path === "/fapi/v1/order") return { orderId: 11, status: "FILLED", executedQty: "0.01", avgPrice: "49999" };
      if (path === "/fapi/v1/userTrades") return [{ commission: "0.02" }];
      return {};
    });
    exec.getExecutableQuote = async () => ({ price: 50_000, timestamp: Date.now(), bid: 49_999, ask: 50_001 });
    exec.estimateDepthImpact = async () => ({ estPx: 50_005, midPx: 50_000, estImpactBps: 1, depthLimited: false });

    const order = await exec.placeOrder(cryptoSignal("buy"), 0.01, "momentum_crypto");
    expect(posts).toHaveLength(1);
    expect(posts[0].type).toBe("LIMIT");
    expect(posts[0].timeInForce).toBe("GTC");
    expect(posts[0].price).toBe("50000.0"); // touch, floored to the 0.1 tick
    expect(String(posts[0].newClientOrderId).startsWith("uc-fapi-")).toBe(true);
    expect((order as any)?.type).toBe("limit");
    expect((order as any)?.filledPrice).toBe(49_999);
    expect((order as any)?.quantity).toBe(0.01);
    expect((order as any)?.openCommission).toBe(0.02);
    expect((order as any)?.estPx).toBe(50_005);
  });

  test("opt-in maxEstImpactBps aborts before ANY order when the depth estimate exceeds it", async () => {
    setExecutionPolicy("momentum_crypto", validatePolicy({
      entry: { style: "limit_chase", offsetBps: 0, refreshThresholdBps: 5, maxReprices: 1, maxDistanceBps: 20, timeoutMs: 500, maxEstImpactBps: 5 },
    })!);
    let posts = 0;
    const exec = makeExec((method, path) => {
      if (method === "POST" && path === "/fapi/v1/order") posts++;
      return {};
    });
    exec.getExecutableQuote = async () => ({ price: 50_000, timestamp: Date.now(), bid: 49_999, ask: 50_001 });
    exec.estimateDepthImpact = async () => ({ estPx: 50_250, midPx: 50_000, estImpactBps: 50, depthLimited: false });
    expect(await exec.placeOrder(cryptoSignal("buy"), 0.01, "momentum_crypto")).toBeNull();
    expect(posts).toBe(0);
  });
});

describe("closePosition outcome taxonomy", () => {
  test("unmapped symbol / confirmed-flat are PROVEN failures", async () => {
    const exec = makeExec(() => ({}));
    const unmapped = await exec.closePosition("NOPE/USD", 1, "buy");
    expect(unmapped.success).toBe(false);
    expect(unmapped.outcome).toBe("proven_failed");

    const flatExec = makeExec((_method, path) => {
      if (path === "/fapi/v2/positionRisk") return [];
      if (path === "/fapi/v1/openOrders" || path === "/fapi/v1/openAlgoOrders") return [];
      return {};
    });
    const flat = await flatExec.closePosition("BTC/USD", 0.01, "buy");
    expect(flat.success).toBe(false);
    expect(flat.reason).toBe("position already flat");
    expect(flat.outcome).toBe("proven_failed");
  });

  test("close POST transport failure after transmit-attempt is UNKNOWN, never proven", async () => {
    const exec = makeExec((method, path) => {
      if (path === "/fapi/v2/positionRisk") return [{ symbol: "BTCUSDT", positionAmt: "0.01", entryPrice: "50000", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
      if (method === "POST" && path === "/fapi/v1/order") throw new Error("socket hang up");
      return {};
    });
    const res = await exec.closePosition("BTC/USD", 0.01, "buy");
    expect(res.success).toBe(false);
    expect(res.outcome).toBe("unknown"); // may have closed — reconciliation resolves it
  });
});
