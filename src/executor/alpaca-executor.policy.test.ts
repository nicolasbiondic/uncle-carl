// ══════════════════════════════════════════════
// AlpacaExecutor — execution policy + order outcome taxonomy (2026-08-03)
// ══════════════════════════════════════════════
//
// Hard invariants:
//  - DEFAULT (no policy): placeOrder submits ONE market order — byte-for-byte
//    today's behavior. This is the production no-op guarantee.
//  - With an entry policy: limit chase (never market) for that sleeve only.
//  - A transport-ambiguous submit NEVER resends: it resolves by QUERYING the
//    idempotent client_order_id; unresolved → UnknownOrderResult.
//  - An exit policy's limit phase ALWAYS degrades to the market path.

import { describe, test, expect, afterEach } from "bun:test";
import { setExecutionPolicy, __clearExecutionPolicies, isUnknownOrder, validatePolicy } from "./executionPolicy";
import { fakeAlpacaExecutor } from "../test-support/alpaca";

afterEach(() => __clearExecutionPolicies());

const executor = (): any => fakeAlpacaExecutor({ resolveRetryDelayMs: 1 });

function stockSignal(side: "buy" | "sell" = "buy"): any {
  return {
    id: "sig1", symbol: "AAPL", market: "stock", side, strategy: "MOMENTUM",
    strength: "strong", price: 100, timestamp: Date.now(), indicators: {}, reason: "test",
  };
}

const freshSnap = () => ({
  LatestQuote: { AskPrice: 100.1, BidPrice: 99.9, Timestamp: new Date().toISOString() },
  LatestTrade: { Price: 100, Timestamp: new Date().toISOString() },
});

describe("placeOrder DEFAULT — no policy, market order exactly as today", () => {
  test("submits exactly one MARKET order and never a limit order", async () => {
    delete process.env.EXECUTION_POLICY_JSON;
    __clearExecutionPolicies();
    const exec = executor();
    const created: any[] = [];
    exec.client = {
      getOrders: async () => [],
      getSnapshot: async () => freshSnap(),
      createOrder: async (p: any) => {
        created.push(p);
        return { id: "b1", status: "filled", filled_qty: "5", filled_avg_price: "100.05" };
      },
    };
    const order = await exec.placeOrder(stockSignal("buy"), 5, "momentum_stocks");
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("market");
    expect(created[0].limit_price).toBeUndefined();
    expect(created[0].qty).toBe(5);
    expect(created[0].time_in_force).toBe("day");
    expect(order?.status).toBe("filled");
    expect((order as any)?.type).toBe("market");
    // estimate telemetry rides along without changing the order itself
    expect((order as any)?.estPx).toBe(100.1);
  });
});

describe("placeOrder with an entry limit_chase policy", () => {
  test("submits a LIMIT order at the touch (offset 0) and returns the chase fill", async () => {
    setExecutionPolicy("chase_sleeve", validatePolicy({
      entry: { style: "limit_chase", offsetBps: 0, refreshThresholdBps: 5, maxReprices: 2, maxDistanceBps: 20, timeoutMs: 2_000, pollIntervalMs: 5 },
    })!);
    const exec = executor();
    const created: any[] = [];
    exec.client = {
      getOrders: async () => [],
      getSnapshot: async () => freshSnap(),
      createOrder: async (p: any) => { created.push(p); return { id: "L1" }; },
      getOrder: async (id: string) => ({ id, status: "filled", filled_qty: "5", filled_avg_price: "100.02" }),
    };
    const order = await exec.placeOrder(stockSignal("buy"), 5, "chase_sleeve");
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("limit");
    expect(created[0].limit_price).toBeCloseTo(100.1, 10); // ask touch, floored to cents
    expect(String(created[0].client_order_id).startsWith("uc8-")).toBe(true);
    expect((order as any)?.type).toBe("limit");
    expect((order as any)?.filledPrice).toBe(100.02);
    expect((order as any)?.filledQty).toBe(5);
  });

  test("opt-in maxEstImpactBps aborts the entry when the estimate exceeds it", async () => {
    setExecutionPolicy("gated_sleeve", validatePolicy({
      entry: { style: "limit_chase", offsetBps: 0, refreshThresholdBps: 5, maxReprices: 1, maxDistanceBps: 20, timeoutMs: 500, maxEstImpactBps: 1 },
    })!);
    const exec = executor();
    const created: any[] = [];
    exec.client = {
      getOrders: async () => [],
      // half-spread = 10bps > 1bps threshold → abort before any order
      getSnapshot: async () => freshSnap(),
      createOrder: async (p: any) => { created.push(p); return { id: "x" }; },
    };
    const order = await exec.placeOrder(stockSignal("buy"), 5, "gated_sleeve");
    expect(order).toBeNull();
    expect(created).toHaveLength(0);
  });
});

describe("order outcome taxonomy — ambiguous submits", () => {
  test("transport failure resolves by client_order_id QUERY: no second createOrder, real order returned", async () => {
    const exec = executor();
    let createCalls = 0;
    exec.client = {
      getOrders: async () => [],
      getSnapshot: async () => freshSnap(),
      createOrder: async () => { createCalls++; throw new Error("ETIMEDOUT (no http status)"); },
      getOrderByClientId: async (cid: string) => ({
        id: "real1", client_order_id: cid, status: "filled", filled_qty: "5", filled_avg_price: "100.1",
      }),
    };
    const order = await exec.placeOrder(stockSignal("buy"), 5, "momentum_stocks");
    expect(createCalls).toBe(1); // NEVER resent
    expect(isUnknownOrder(order)).toBe(false);
    expect((order as any)?.externalId).toBe("real1");
    expect((order as any)?.status).toBe("filled");
  });

  test("query 404 proves the submit never landed → null (proven_failed)", async () => {
    const exec = executor();
    exec.client = {
      getOrders: async () => [],
      getSnapshot: async () => freshSnap(),
      createOrder: async () => { throw new Error("socket hang up"); },
      getOrderByClientId: async () => { const e: any = new Error("not found"); e.status = 404; throw e; },
    };
    expect(await exec.placeOrder(stockSignal("buy"), 5, "momentum_stocks")).toBeNull();
  });

  test("resolution exhausted → UnknownOrderResult (NOT null, NOT a rejection, NOT resent)", async () => {
    const exec = executor();
    let createCalls = 0;
    exec.client = {
      getOrders: async () => [],
      getSnapshot: async () => freshSnap(),
      createOrder: async () => { createCalls++; throw new Error("ECONNRESET"); },
      getOrderByClientId: async () => { throw new Error("still down"); },
    };
    const order = await exec.placeOrder(stockSignal("buy"), 5, "momentum_stocks");
    expect(createCalls).toBe(1);
    expect(isUnknownOrder(order)).toBe(true);
    expect((order as any).clientOrderId.startsWith("uc8-")).toBe(true);
  });

  test("a venue-confirmed 4xx stays a plain rejection (null) without any resolution query", async () => {
    const exec = executor();
    let queried = 0;
    exec.client = {
      getOrders: async () => [],
      getSnapshot: async () => freshSnap(),
      createOrder: async () => { const e: any = new Error("insufficient buying power"); e.status = 403; throw e; },
      getOrderByClientId: async () => { queried++; return null; },
    };
    expect(await exec.placeOrder(stockSignal("buy"), 5, "momentum_stocks")).toBeNull();
    expect(queried).toBe(0);
  });
});

describe("closePosition exit policy — GUARANTEED degrade to market", () => {
  test("unfilled limit phase falls through to the market close; success reported from the market fill", async () => {
    setExecutionPolicy("exit_sleeve", validatePolicy({
      exit: { style: "limit_then_market", offsetBps: 0, refreshThresholdBps: 5, maxReprices: 1, maxDistanceBps: 20, timeoutMs: 40, pollIntervalMs: 5 },
    })!);
    const exec = executor();
    let limitOrders = 0;
    let marketCloses = 0;
    let canceled = false;
    exec.client = {
      getOrders: async () => [],
      getSnapshot: async () => freshSnap(),
      getPosition: async () => ({ qty: "10" }),
      createOrder: async (p: any) => { expect(p.type).toBe("limit"); limitOrders++; return { id: "L1" }; },
      getOrder: async (id: string) => ({ id, status: canceled ? "canceled" : "new", filled_qty: "0", filled_avg_price: "0" }),
      cancelOrder: async () => { canceled = true; },
      closePosition: async () => { marketCloses++; return { id: "M1" }; },
    };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 99.9, filledQty: 10, filledAt: Date.now() });

    const res = await exec.closePosition("AAPL", "buy", 10, { accountId: "exit_sleeve" });
    expect(limitOrders).toBe(1);
    expect(marketCloses).toBe(1); // the guarantee: market ALWAYS follows a failed limit phase
    expect(res.success).toBe(true);
    expect(res.outcome).toBe("confirmed");
    expect(res.filledPrice).toBe(99.9);
  });

  test("DEFAULT close (no accountId/policy) never places a limit order", async () => {
    delete process.env.EXECUTION_POLICY_JSON;
    __clearExecutionPolicies();
    const exec = executor();
    let createOrderCalls = 0;
    exec.client = {
      getOrders: async () => [],
      getSnapshot: async () => freshSnap(),
      getPosition: async () => ({ qty: "10" }),
      createOrder: async () => { createOrderCalls++; return { id: "nope" }; },
      closePosition: async () => ({ id: "M1" }),
    };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 99.9, filledQty: 10, filledAt: Date.now() });
    const res = await exec.closePosition("AAPL", "buy", 10);
    expect(createOrderCalls).toBe(0);
    expect(res.success).toBe(true);
    expect(res.outcome).toBe("confirmed");
  });

  test("failure outcomes: http_404 is proven, a bare transport failure is unknown", async () => {
    const exec = executor();
    exec.client = {
      getOrders: async () => [],
      getSnapshot: async () => freshSnap(),
      getPosition: async () => { const e: any = new Error("gone"); e.status = 404; throw e; },
    };
    const gone = await exec.closePosition("AAPL", "buy", 10);
    expect(gone.success).toBe(false);
    expect(gone.reason).toBe("http_404");
    expect(gone.outcome).toBe("proven_failed");

    exec.client.getPosition = async () => ({ qty: "10" });
    exec.client.closePosition = async () => { throw new Error("socket hang up"); };
    const ambiguous = await exec.closePosition("AAPL", "buy", 10);
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.outcome).toBe("unknown"); // may have closed — reconciliation resolves it
  });
});
