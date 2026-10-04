// ══════════════════════════════════════════════
// BinanceExecutor (FAPI) × rateLimiter + symbolLock — integration
// ══════════════════════════════════════════════
//
// What each test would catch if the protection were reverted:
//  - "shared limiter": someone switching the executor back to a per-instance
//    limiter — the two FAPI instances (USDT + USDC) sign against the SAME
//    account, so a split limiter counts half the traffic and protects nothing.
//  - "one close POST": removing the symbol lock re-opens the double-sell
//    (two concurrent closes both read the same broker qty and both transmit).
//  - "429 → resolve by query": treating a post-transmit 429 as a proven
//    rejection (or blind-retrying it) — the order may be live on the books.
//  - "pre-transmit denial": a limiter denial being reported as "unknown"
//    (it must be a proven non-submission — nothing ever reached the wire).
//  - "418": a Binance IP ban not freezing traffic / not being counted.
//  - "lock timeout": a timed-out mutation hanging, or being reported as if
//    it had transmitted something.

import { describe, test, expect, afterEach } from "bun:test";
import { BinanceExecutor } from "./binance-executor";
import {
  VenueRateLimiter,
  getVenueRateLimiter,
  VENUE_RATE_LIMITER_DEFAULTS,
  __setVenueRateLimiterForTests,
  __resetVenueRateLimitersForTests,
} from "./rateLimiter";
import { symbolLocks } from "./symbolLock";
import { fakeBinanceExecutor as make, defaultCatalog, makeSpec } from "../test-support/binance";

const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetVenueRateLimitersForTests();
  symbolLocks.__resetForTests();
});

// ── Shared limiter per venue ─────────────────────────────────────────────

describe("shared venue limiter", () => {
  test("the USDT and USDC FAPI instances share the SAME limiter (one account, one quota)", () => {
    __resetVenueRateLimitersForTests();
    const usdt = new BinanceExecutor() as any;
    const usdc = new BinanceExecutor({ quoteAsset: "USDC" }) as any;
    expect(usdt.limiter).toBe(usdc.limiter);
    expect(usdt.limiter).toBe(getVenueRateLimiter("binance_fapi"));
    // And it is NOT the DAPI (separate account) or Alpaca bucket.
    expect(usdt.limiter).not.toBe(getVenueRateLimiter("binance_dapi"));
    expect(usdt.limiter).not.toBe(getVenueRateLimiter("alpaca"));
  });
});

// ── Pre-transmit denial = proven non-submission ──────────────────────────

function denyingLimiter(): VenueRateLimiter {
  return new VenueRateLimiter("binance_fapi", {
    ratePerMinute: 600, burst: 0, protectDebt: 0, backgroundReserve: 0,
    maxWaitMs: { protect: 0, trade: 0, background: 0 },
    penalty429Ms: 20_000, penalty418Ms: 120_000,
  });
}

describe("limiter denial happens BEFORE anything is transmitted", () => {
  test("placeOrder under a denying limiter: null (proven not submitted), zero bytes on the wire", async () => {
    __setVenueRateLimiterForTests("binance_fapi", denyingLimiter());
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls++; return new Response("{}"); }) as any;
    const exec = make({ instrumentCatalog: defaultCatalog() }) as any; // REAL signedRequest → real limiter
    exec.leverageBySymbol.set("BTCUSDT", 2); // reach the order POST directly

    const result = await exec.placeOrder({ symbol: "BTC/USD", side: "buy", price: 50_000 }, 0.001, "momentum_crypto");
    expect(result).toBeNull();       // proven non-submission — NOT an {outcome:"unknown"} to chase
    expect(fetchCalls).toBe(0);      // nothing was ever transmitted
  });

  test("closePosition under a denying limiter: outcome proven_failed, zero bytes on the wire", async () => {
    __setVenueRateLimiterForTests("binance_fapi", denyingLimiter());
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls++; return new Response("{}"); }) as any;
    const exec = make({ instrumentCatalog: defaultCatalog() }) as any;

    const result = await exec.closePosition("BTC/USD", 0.001, "buy");
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("proven_failed"); // never transmitted → provably no close
    expect(fetchCalls).toBe(0);
  });
});

// ── 429 after transmit: resolve by QUERY, never resend ───────────────────

describe("HTTP 429 on a transmitted order", () => {
  test("placeOrder resolves a 429'd POST by idempotent client-id QUERY — exactly ONE POST, never a blind resend", async () => {
    let orderPosts = 0;
    const exec = make({
      signedRequest: async (method: string, path: string, params: any) => {
        if (path === "/fapi/v1/leverage") return {};
        if (method === "POST" && path === "/fapi/v1/order") {
          orderPosts++;
          const e: any = new Error("Binance /fapi/v1/order HTTP 429: Too many requests");
          e.httpStatus = 429;
          throw e; // the request WAS transmitted; the venue throttled the response
        }
        if (method === "GET" && path === "/fapi/v1/order" && params?.origClientOrderId) {
          // The query proves the venue DID process the throttled POST.
          return { orderId: 77, status: "FILLED", avgPrice: "50000", executedQty: "0.001", updateTime: 1 };
        }
        if (method === "GET" && path === "/fapi/v1/userTrades") return [];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;

    const result = await exec.placeOrder({ symbol: "BTC/USD", side: "buy", price: 50_000 }, 0.001, "momentum_crypto");
    expect(orderPosts).toBe(1);                 // NEVER a second POST
    expect(result?.externalId).toBe("77");      // the real, already-live order was adopted
    expect(result?.filledPrice).toBe(50_000);
    expect(result?.status).toBe("filled");
  });

  test("when the query can't resolve it either, the outcome is UNKNOWN (left to reconciliation) — still one POST", async () => {
    let orderPosts = 0;
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        if (path === "/fapi/v1/leverage") return {};
        if (method === "POST" && path === "/fapi/v1/order") {
          orderPosts++;
          const e: any = new Error("HTTP 429");
          e.httpStatus = 429;
          throw e;
        }
        if (method === "GET" && path === "/fapi/v1/order") throw new Error("query also throttled");
        throw new Error(`unexpected ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;

    const result = await exec.placeOrder({ symbol: "BTC/USD", side: "buy", price: 50_000 }, 0.001, "momentum_crypto");
    expect(orderPosts).toBe(1);
    expect(result?.outcome).toBe("unknown"); // NOT null: a 429'd POST may be live on the books
    expect(result?.clientOrderId).toStartWith("uc-fapi-");
  });
});

// ── 418: temporary IP ban ────────────────────────────────────────────────

describe("HTTP 418 (IP ban)", () => {
  test("a 418 is counted, honors Retry-After, freezes the venue, and blocks the NEXT request pre-transmit", async () => {
    const limiter = new VenueRateLimiter("binance_fapi", { ...VENUE_RATE_LIMITER_DEFAULTS.binance_fapi });
    __setVenueRateLimiterForTests("binance_fapi", limiter);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ code: -1003, msg: "Way too many requests; IP banned" }), {
        status: 418,
        headers: { "retry-after": "60" },
      });
    }) as any;
    const exec = make({ instrumentCatalog: defaultCatalog() }) as any; // real signedRequest

    await expect(exec.getBalance()).rejects.toThrow("HTTP 418");
    const m = limiter.metrics();
    expect(m.http418).toBe(1);
    expect(m.frozen).toBe(true); // Retry-After 60s ban window is active

    // The very next request is denied BEFORE transmit — sending during a
    // ban fails anyway AND extends the ban.
    await expect(exec.getBalance()).rejects.toThrow("rate_limited");
    expect(fetchCalls).toBe(1);
    expect(limiter.metrics().denials).toBe(1);
  });

  test("a 429 response opens the penalty window with its Retry-After", async () => {
    const limiter = new VenueRateLimiter("binance_fapi", { ...VENUE_RATE_LIMITER_DEFAULTS.binance_fapi });
    __setVenueRateLimiterForTests("binance_fapi", limiter);
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: -1003, msg: "slow down" }), {
      status: 429,
      headers: { "retry-after": "30" },
    })) as any;
    const exec = make({ instrumentCatalog: defaultCatalog() }) as any;

    await expect(exec.getBalance()).rejects.toThrow("HTTP 429");
    const m = limiter.metrics();
    expect(m.http429).toBe(1);
    expect(m.penaltyActive).toBe(true);
    expect(m.frozen).toBe(false); // a 429 is a penalty, not a ban
  });
});

// ── Symbol lock: mutations serialized per (venue, symbol) ────────────────

function fapiFakeBroker() {
  const state = { amt: 1, marketPosts: 0, stopPosts: 0 };
  let active = 0;
  let maxActive = 0;
  const signedRequest = async (method: string, path: string, params: any) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await sleep(5); // interleaving window: without the lock, requests overlap
      if (path === "/fapi/v2/positionRisk") {
        return state.amt !== 0
          ? [{ symbol: "BTCUSDT", positionAmt: String(state.amt), entryPrice: "50000", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
          : [];
      }
      if (method === "POST" && path === "/fapi/v1/order") {
        if (params?.type === "MARKET") {
          state.marketPosts++;
          state.amt = 0; // the close consumed the position
          return { orderId: 1, status: "FILLED", avgPrice: "50000", executedQty: "1" };
        }
        state.stopPosts++;
        return { orderId: 5 }; // STOP_MARKET accepted
      }
      if (method === "GET" && path === "/fapi/v1/order") return { orderId: 1, status: "FILLED", avgPrice: "50000", executedQty: "1" };
      if (path === "/fapi/v1/userTrades") return [{ qty: "1", price: "50000", commission: "0.01", realizedPnl: "5", time: "1" }];
      if (path === "/fapi/v1/openOrders") return [];
      if (path === "/fapi/v1/openAlgoOrders") return { orders: [] };
      throw new Error(`unexpected ${method} ${path}`);
    } finally {
      active--;
    }
  };
  return { state, signedRequest, maxActive: () => maxActive };
}

describe("symbol lock on FAPI mutations", () => {
  test("two concurrent closes of the same symbol → serialized: exactly ONE reduceOnly POST reaches the broker", async () => {
    const broker = fapiFakeBroker();
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT", { stepSize: 1, minQty: 1, marketStepSize: 1, marketMinQty: 1 })]),
      signedRequest: broker.signedRequest,
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 50;

    const [a, b] = await Promise.all([
      exec.closePosition("BTC/USD", 1, "buy"),
      exec.closePosition("BTC/USD", 1, "buy"),
    ]);

    expect(broker.state.marketPosts).toBe(1); // WITHOUT the lock: 2 — an accidental short
    const results = [a, b];
    expect(results.filter(r => r.success).length).toBe(1);
    const loser = results.find(r => !r.success)!;
    expect(loser.reason).toBe("position already flat"); // the serialized re-read told the truth
    expect(loser.outcome).toBe("proven_failed");
  });

  test("a close and a stop placement on the same symbol never interleave on the wire", async () => {
    const broker = fapiFakeBroker();
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT", { stepSize: 1, minQty: 1, marketStepSize: 1, marketMinQty: 1 })]),
      signedRequest: broker.signedRequest,
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 50;

    const [closed, stopped] = await Promise.all([
      exec.closePosition("BTC/USD", 1, "buy"),
      exec.placeStopMarketClose("BTC/USD", "buy", 45_000, 1),
    ]);
    expect(closed.success).toBe(true);
    expect(stopped).toBe(true);
    expect(broker.maxActive()).toBe(1); // every broker request ran under exactly one holder
  });

  test("lock timeout is an EXPLICIT pre-transmit failure for every mutation — never a hang, never 'nothing happened'", async () => {
    const exec = make({
      instrumentCatalog: defaultCatalog(),
      signedRequest: async (method: string, path: string) => { throw new Error(`must not transmit: ${method} ${path}`); },
    }) as any;
    exec.lockTimeoutMs = 20;

    const release = await symbolLocks.acquire("binance_fapi", "BTC/USD", { label: "test holder" });
    expect(release).not.toBeNull();
    try {
      const closed = await exec.closePosition("BTC/USD", 1, "buy");
      expect(closed.success).toBe(false);
      expect(closed.outcome).toBe("proven_failed"); // pre-transmit: provably nothing was sent
      expect(closed.reason).toContain("lock timeout");

      const opened = await exec.placeOrder({ symbol: "BTC/USD", side: "buy", price: 50_000 }, 1, "momentum_crypto");
      expect(opened).toBeNull();

      const stopped = await exec.placeStopMarketClose("BTC/USD", "buy", 45_000, 1);
      expect(stopped).toBe(false);
    } finally {
      release!();
    }
  });
});
