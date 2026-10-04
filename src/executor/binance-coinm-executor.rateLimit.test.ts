// ══════════════════════════════════════════════
// BinanceCoinMExecutor (DAPI) × rateLimiter + symbolLock — integration
// ══════════════════════════════════════════════
//
// DAPI is a genuinely separate account from FAPI, so it gets its OWN venue
// bucket ("binance_dapi") — but the same discipline: shared limiter per
// venue, 429/418 handling (418 loud + frozen), pre-transmit denials that
// are provably non-submissions, and a per-(venue,symbol) mutation lock on
// open/close/stop-place/stop-cancel.

import { describe, test, expect, afterEach } from "bun:test";
import {
  VenueRateLimiter,
  getVenueRateLimiter,
  VENUE_RATE_LIMITER_DEFAULTS,
  __setVenueRateLimiterForTests,
  __resetVenueRateLimitersForTests,
} from "./rateLimiter";
import { symbolLocks } from "./symbolLock";
import { fakeCoinMExecutor as make, COINM_EXCHANGE_INFO_FIXTURE } from "../test-support/binance";

const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetVenueRateLimitersForTests();
  symbolLocks.__resetForTests();
});

describe("venue identity", () => {
  test("CoinM draws from the binance_dapi bucket — shared across CoinM instances, separate from FAPI", () => {
    __resetVenueRateLimitersForTests();
    const a = make() as any;
    const b = make() as any;
    expect(a.limiter).toBe(b.limiter);
    expect(a.limiter).toBe(getVenueRateLimiter("binance_dapi"));
    expect(a.limiter).not.toBe(getVenueRateLimiter("binance_fapi"));
  });
});

describe("limiter denial happens BEFORE anything is transmitted", () => {
  test("closePosition under a denying limiter: success=false, zero bytes on the wire", async () => {
    __setVenueRateLimiterForTests("binance_dapi", new VenueRateLimiter("binance_dapi", {
      ratePerMinute: 600, burst: 0, protectDebt: 0, backgroundReserve: 0,
      maxWaitMs: { protect: 0, trade: 0, background: 0 },
      penalty429Ms: 20_000, penalty418Ms: 120_000,
    }));
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls++; return new Response("{}"); }) as any;
    const exec = make(); // real signedRequest → real limiter

    // Pre-check (positionRisk, class protect) is denied too → state unknown
    // → the close REFUSES to run. Nothing was transmitted; success=false
    // with no fill fabricated is the truthful proven-no-close shape.
    const result = await exec.closePosition("BTC/COIN-M", 1, "buy", "intent-deny");
    expect(result.success).toBe(false);
    expect(result.filledPrice).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});

describe("HTTP 418 (IP ban) on DAPI", () => {
  test("counted, Retry-After honored, venue frozen, next request blocked pre-transmit", async () => {
    const limiter = new VenueRateLimiter("binance_dapi", { ...VENUE_RATE_LIMITER_DEFAULTS.binance_dapi });
    __setVenueRateLimiterForTests("binance_dapi", limiter);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ code: -1003, msg: "Way too many requests; IP banned" }), {
        status: 418,
        headers: { "retry-after": "60" },
      });
    }) as any;
    const exec = make(); // real signedRequest

    await expect(exec.getBalanceBtc()).rejects.toThrow("HTTP 418");
    const m = limiter.metrics();
    expect(m.http418).toBe(1);
    expect(m.frozen).toBe(true);

    await expect(exec.getBalanceBtc()).rejects.toThrow("rate_limited");
    expect(fetchCalls).toBe(1); // the second request never reached the wire
  });
});

// ── Symbol lock on DAPI mutations ────────────────────────────────────────

function dapiFakeBroker() {
  const state = { amt: 1, closePosts: 0 };
  let active = 0;
  let maxActive = 0;
  const signedRequest = async (method: string, path: string) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await sleep(5); // interleaving window: without the lock, requests overlap
      if (path === "/dapi/v1/positionRisk") {
        return state.amt !== 0
          ? [{ symbol: "BTCUSD_PERP", positionAmt: String(state.amt), entryPrice: "50000", markPrice: "50000", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
          : [];
      }
      if (method === "POST" && path === "/dapi/v1/order") {
        state.closePosts++;
        state.amt = 0; // the reduceOnly close consumed the position
        return { orderId: 9, status: "FILLED", avgPrice: "50000", executedQty: "1" };
      }
      if (method === "GET" && path === "/dapi/v1/userTrades") {
        return [{ realizedPnl: "0.001", commission: "0.0001", commissionAsset: "BTC", qty: "1", price: "50000" }];
      }
      if (path === "/dapi/v1/openOrders") return [];
      if (path === "/dapi/v1/openAlgoOrders") return { orders: [] };
      throw new Error(`unexpected ${method} ${path}`);
    } finally {
      active--;
    }
  };
  return { state, signedRequest, maxActive: () => maxActive };
}

describe("symbol lock on CoinM mutations", () => {
  test("two concurrent closes of BTC/COIN-M → serialized: exactly ONE reduceOnly POST reaches the broker", async () => {
    const broker = dapiFakeBroker();
    const exec = make({
      signedRequest: broker.signedRequest,
      fetchExchangeInfoRaw: async () => COINM_EXCHANGE_INFO_FIXTURE,
    });

    const [a, b] = await Promise.all([
      exec.closePosition("BTC/COIN-M", 1, "buy", "intent-a"),
      exec.closePosition("BTC/COIN-M", 1, "buy", "intent-b"),
    ]);

    expect(broker.state.closePosts).toBe(1); // WITHOUT the lock: 2 — double-sell into a short
    const results = [a, b];
    expect(results.filter(r => r.success).length).toBe(1);
    const winner = results.find(r => r.success)!;
    expect(winner.filledPrice).toBe(50_000);
    expect(winner.executedQty).toBe(1);
    // The loser's serialized pre-check read the post-close truth (flat) and
    // provably transmitted nothing — no fabricated fill.
    const loser = results.find(r => !r.success)!;
    expect(loser.filledPrice).toBe(0);
    expect(loser.executedQty).toBe(0);
  });

  test("a close and a stop-cancel on the same product never interleave on the wire", async () => {
    const broker = dapiFakeBroker();
    const exec = make({
      signedRequest: broker.signedRequest,
      fetchExchangeInfoRaw: async () => COINM_EXCHANGE_INFO_FIXTURE,
    });

    const [closed, cancelled] = await Promise.all([
      exec.closePosition("BTC/COIN-M", 1, "buy", "intent-x"),
      exec.cancelActiveStop("BTC/COIN-M"),
    ]);
    expect(closed.success).toBe(true);
    expect(cancelled).toBe(true); // nothing tracked/owned → genuinely nothing to cancel
    expect(broker.maxActive()).toBe(1); // every broker request ran under exactly one holder
  });

  test("lock timeout is an EXPLICIT pre-transmit failure for every mutation — never a hang, never a fabricated result", async () => {
    const exec = make({
      signedRequest: async (method: string, path: string) => { throw new Error(`must not transmit: ${method} ${path}`); },
      fetchExchangeInfoRaw: async () => { throw new Error("must not fetch"); },
    }) as any;
    exec.lockTimeoutMs = 20;

    const release = await symbolLocks.acquire("binance_dapi", "BTC/COIN-M", { label: "test holder" });
    expect(release).not.toBeNull();
    try {
      const closed = await exec.closePosition("BTC/COIN-M", 1, "buy", "intent-t");
      expect(closed.success).toBe(false);
      expect(closed.filledPrice).toBe(0); // nothing fabricated

      const opened = await exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 1, intentId: "intent-t" });
      expect(opened).toBeNull(); // proven not submitted — broker unchanged

      const stop = await exec.placeStopMarketClose("BTC/COIN-M", "buy", 45_000, 1, "intent-t");
      expect(stop).toEqual({ ok: false });

      const cancel = await exec.cancelActiveStop("BTC/COIN-M");
      expect(cancel).toBe(false); // "not cleared", never "nothing was there"

      const ensured = await exec.ensureLiveStop("BTC/COIN-M", { symbol: "BTCUSD_PERP", positionAmt: 1, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }, 45_000);
      expect(ensured).toBe(false); // reported UNPROTECTED — the fail-closed direction
    } finally {
      release!();
    }
  });

  test("ensureLiveStop holds ONE lock across verify→cancel→replace (cores are unlocked — no self-deadlock)", async () => {
    // An owned-but-wrong stop exists; ensureLiveStop must cancel and replace
    // it in a single locked critical section. If someone re-routes the inner
    // steps through the LOCKED public wrappers, the non-reentrant lock turns
    // this call into a bounded timeout and the test fails.
    const posts: string[] = [];
    let stopInstalled = false;
    const exec = make({
      signedRequest: async (method: string, path: string, params: any) => {
        if (path === "/dapi/v1/openOrders") {
          return stopInstalled
            ? [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: "uc-coinm-new", side: "SELL", origQty: "1", stopPrice: "45000.0" }]
            : [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: "uc-coinm-old", side: "SELL", origQty: "1", stopPrice: "40000.0" }];
        }
        if (path === "/dapi/v1/openAlgoOrders") return { orders: [] };
        if (method === "DELETE" && path === "/dapi/v1/order") { posts.push("cancel"); return {}; }
        if (method === "POST" && path === "/dapi/v1/order") { posts.push(`place:${params.type}`); stopInstalled = true; return { orderId: 11, status: "NEW" }; }
        throw new Error(`unexpected ${method} ${path}`);
      },
      fetchExchangeInfoRaw: async () => COINM_EXCHANGE_INFO_FIXTURE,
    });

    const ok = await exec.ensureLiveStop("BTC/COIN-M", { symbol: "BTCUSD_PERP", positionAmt: 1, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }, 45_000);
    expect(ok).toBe(true);
    expect(posts).toEqual(["cancel", "place:STOP_MARKET"]); // wrong stop replaced, exactly once
  });
});
