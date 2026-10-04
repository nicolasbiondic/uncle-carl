import { describe, test, expect, afterEach } from "bun:test";
import {
  BinanceExecutor,
  fapiClientIdNamespace, fapiClientOrderId, isBotFapiClientId, isNonProductionBinanceHost,
  resolveUserDataWsHost,
} from "./binance-executor";
import { InstrumentCatalog } from "./binance/instrumentSpec";
import { fakeBinanceExecutor as make, makeSpec, defaultCatalog } from "../test-support/binance";

const realFetch = globalThis.fetch;

describe("getAssetBreakdown", () => {
  test("shapes balances, values stables 1:1 and non-stables via getUsdRate, drops zeros", async () => {
    const exec = make({
      signedRequest: async () => [
        { asset: "USDT", balance: "100", availableBalance: "80" },
        { asset: "BTC", balance: "2", availableBalance: "2" },
        { asset: "ETH", balance: "0", availableBalance: "0" }, // filtered
      ],
      getUsdRate: async (a: string) => (a === "BTC" ? 50000 : a === "USDT" ? 1 : 0),
    });
    const out = await exec.getAssetBreakdown();
    expect(out).toEqual([
      { asset: "USDT", balance: 100, availableBalance: 80, usdValue: 100 },
      { asset: "BTC", balance: 2, availableBalance: 2, usdValue: 100000 },
    ]);
  });

  test("non-stable with unpriceable asset → [] (no partial breakdown)", async () => {
    const exec = make({
      signedRequest: async () => [{ asset: "FOO", balance: "5", availableBalance: "5" }],
      getUsdRate: async () => 0,
    });
    expect(await exec.getAssetBreakdown()).toEqual([]);
  });

  test("fail-open: never throws, returns [] on request error", async () => {
    const exec = make({ signedRequest: async () => { throw new Error("boom"); } });
    expect(await exec.getAssetBreakdown()).toEqual([]);
  });

  test("non-array response → []", async () => {
    const exec = make({ signedRequest: async () => ({ code: -1, msg: "nope" }) });
    expect(await exec.getAssetBreakdown()).toEqual([]);
  });

  test("returns [] when not connected", async () => {
    const exec = new BinanceExecutor(); // connected defaults false
    expect(await exec.getAssetBreakdown()).toEqual([]);
  });
});

describe("getBalance", () => {
  // Reviewer P1 (2026-07-18): getBalance is a MARGIN-ONLY read. It must never
  // await getUsdRate/assetIndex, even when assets[] carries non-stable
  // holdings (BTC/USDC) — that fan-out belongs exclusively to
  // getAccountTotal(). A slow/rate-limited asset-index call must not stall
  // margin sync or position reconciliation.
  test("never calls getUsdRate/assetIndex, even with non-stable assets present", async () => {
    let rateCalls = 0;
    const exec = make({
      signedRequest: async () => ({
        multiAssetsMargin: false,
        totalWalletBalance: "4443",
        totalUnrealizedProfit: "232",
        totalMarginBalance: "4675",
        availableBalance: "2005",
        assets: [
          { asset: "USDT", walletBalance: "4443", unrealizedProfit: "232", availableBalance: "2005" },
          { asset: "USDC", walletBalance: "5000", unrealizedProfit: "0", availableBalance: "5000" },
          { asset: "BTC", walletBalance: "0.01", unrealizedProfit: "0", availableBalance: "0.01" },
        ],
      }),
      getUsdRate: async () => { rateCalls++; return 64_750; },
    });

    expect(await exec.getBalance()).toEqual({
      marginEquity: 4675,
      marginCash: 2005,
      wallet: 4443,
      unrealizedPnl: 232,
    });
    expect(rateCalls).toBe(0);
  });

  test("throws fail-closed when totalMarginBalance mismatches wallet+unrealized by more than $0.01", async () => {
    await expect(make({
      signedRequest: async () => ({
        totalWalletBalance: "10086.8949",
        totalUnrealizedProfit: "228.4263",
        totalMarginBalance: "10400", // off by ~84.68, way past the 1c tolerance
        availableBalance: "4658",
      }),
    }).getBalance()).rejects.toThrow("mismatch");
  });

  test("throws on Binance API error and malformed/missing numeric fields", async () => {
    await expect(make({ signedRequest: async () => ({ code: -2015, msg: "bad key" }) }).getBalance()).rejects.toThrow("bad key");
    await expect(make({ signedRequest: async () => ({ totalWalletBalance: "nope", totalUnrealizedProfit: "0", totalMarginBalance: "0", availableBalance: "1" }) }).getBalance()).rejects.toThrow("totalWalletBalance");
    await expect(make({ signedRequest: async () => ({ totalWalletBalance: "1", totalUnrealizedProfit: "nan", totalMarginBalance: "1", availableBalance: "1" }) }).getBalance()).rejects.toThrow("totalUnrealizedProfit");
    await expect(make({ signedRequest: async () => ({ totalWalletBalance: "1", totalUnrealizedProfit: "0", totalMarginBalance: "1", availableBalance: undefined }) }).getBalance()).rejects.toThrow("availableBalance");
    await expect(make({ signedRequest: async () => ({ totalWalletBalance: "1", totalUnrealizedProfit: "0", availableBalance: "1" }) }).getBalance()).rejects.toThrow("totalMarginBalance");
  });
});

describe("getAccountTotal", () => {
  // Real /fapi/v2/account query (2026-07-18): multiAssetsMargin=false, root
  // totalMarginBalance≈4675 covers ONLY the USDT margin asset, but assets[]
  // also carries a USDC=5000 + BTC=0.01 deposit the Binance UI counts toward
  // "Account total" (≈10.3k). Unlike getBalance, THIS is the method allowed
  // to reach assetIndex.
  test("exact production fixture: priced sum of all non-zero assets, BTC priced once via assetIndex", async () => {
    let rateCalls: string[] = [];
    const exec = make({
      signedRequest: async () => ({
        multiAssetsMargin: false,
        totalWalletBalance: "4443",
        totalUnrealizedProfit: "232",
        totalMarginBalance: "4675",
        availableBalance: "2005",
        assets: [
          { asset: "USDT", walletBalance: "4443", unrealizedProfit: "232", availableBalance: "2005" },
          { asset: "USDC", walletBalance: "5000", unrealizedProfit: "0", availableBalance: "5000" },
          { asset: "BTC", walletBalance: "0.01", unrealizedProfit: "0", availableBalance: "0.01" },
        ],
      }),
      // Mirrors the real getUsdRate: stables short-circuit to 1:1, only a
      // non-stable asset reaches the asset-index rate lookup.
      getUsdRate: async (a: string) => {
        if (a === "USDT" || a === "USDC") return 1;
        rateCalls.push(a);
        return a === "BTC" ? 64_750 : 0;
      },
    });

    expect(await exec.getAccountTotal()).toEqual({
      equity: 10_322.5,   // (4443+232) + (5000+0) + (0.01+0)*64750
      cash: 7_652.5,       // 2005 + 5000 + 0.01*64750
    });
    expect(rateCalls).toEqual(["BTC"]); // only the non-stable asset triggers a rate lookup
  });

  test("non-stable asset unpriceable → null (no partial sum)", async () => {
    const exec = make({
      signedRequest: async () => ({
        totalWalletBalance: "4443",
        totalUnrealizedProfit: "232",
        totalMarginBalance: "4675",
        availableBalance: "2005",
        assets: [
          { asset: "USDT", walletBalance: "4443", unrealizedProfit: "232", availableBalance: "2005" },
          { asset: "BTC", walletBalance: "0.01", unrealizedProfit: "0", availableBalance: "0.01" },
        ],
      }),
      getUsdRate: async (a: string) => (a === "USDT" ? 1 : 0), // BTC unpriceable
    });

    expect(await exec.getAccountTotal()).toBeNull();
  });

  test("assets missing or not an array → null", async () => {
    const exec = make({
      signedRequest: async () => ({
        totalWalletBalance: "4443",
        totalUnrealizedProfit: "232",
        totalMarginBalance: "4675",
        availableBalance: "2005",
      }),
    });
    expect(await exec.getAccountTotal()).toBeNull();
  });

  test("empty assets with a non-zero margin account cannot masquerade as a $0 account total", async () => {
    const exec = make({
      signedRequest: async () => ({
        totalWalletBalance: "4443",
        totalUnrealizedProfit: "232",
        totalMarginBalance: "4675",
        availableBalance: "2005",
        assets: [],
      }),
    });
    expect(await exec.getAccountTotal()).toBeNull();
  });

  test("corrupt ledger summing negative fails closed to null (2026-08-18 testnet outage)", async () => {
    // Shaped like the real incident: root totals read as a fresh $5,000
    // account (self-consistent, so the cross-check passes) while assets[]
    // carries a finite, priceable entry that sums the total to ≈ −$1.33e12.
    const exec = make({
      signedRequest: async () => ({
        totalWalletBalance: "5000",
        totalUnrealizedProfit: "0",
        totalMarginBalance: "5000",
        availableBalance: "5000",
        assets: [
          { asset: "USDT", walletBalance: "7270.82", unrealizedProfit: "-1332787248825.19", availableBalance: "7270.82" },
        ],
      }),
    });
    expect(await exec.getAccountTotal()).toBeNull();
  });

  test("root-total mismatch still fails closed (shares getBalance's cross-check)", async () => {
    await expect(make({
      signedRequest: async () => ({
        totalWalletBalance: "10086.8949",
        totalUnrealizedProfit: "228.4263",
        totalMarginBalance: "10400",
        availableBalance: "4658",
        assets: [{ asset: "USDT", walletBalance: "10086.8949", unrealizedProfit: "228.4263", availableBalance: "4658" }],
      }),
    }).getAccountTotal()).rejects.toThrow("mismatch");
  });
});

describe("getPositions", () => {
  test("distinguishes a successful empty account from a request failure", async () => {
    const empty = make({ signedRequest: async () => [] });
    expect(await empty.getPositions()).toEqual([]);

    const failed = make({ signedRequest: async () => { throw new Error("positionRisk unavailable"); } });
    await expect(failed.getPositions()).rejects.toThrow("positionRisk unavailable");

    const apiError = make({ signedRequest: async () => ({ code: -1000, msg: "Internal error" }) });
    await expect(apiError.getPositions()).rejects.toThrow("Internal error");
  });
});

describe("placeOrder", () => {
  test("signedRequest: HTTP 400 with Binance error code -4120 in JSON throws error with .code attached", async () => {
    const realFetchBackup = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ code: -4120, msg: "Order type not supported for this contract" }),
      })) as unknown as typeof fetch;

      const exec = new BinanceExecutor() as any;
      exec.connected = true;
      exec.apiKey = "test";
      exec.secretKey = "test";

      try {
        await exec.signedRequest("POST", "/fapi/v1/order", { symbol: "BTCUSDT" });
        throw new Error("should have thrown");
      } catch (e: any) {
        expect(e.code).toBe(-4120);
        expect(e.message).toMatch(/HTTP 400/);
        expect(e.message).toMatch(/Order type not supported/);
      }
    } finally {
      globalThis.fetch = realFetchBackup;
    }
  });

  test("reaches Algo Order API when STOP_MARKET returns documented -4120", async () => {
    const calls: string[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === "/fapi/v1/order") {
          const error = new Error("unsupported") as Error & { code: number };
          error.code = -4120;
          throw error;
        }
        if (path === "/fapi/v1/algoOrder") return { algoId: 7 };
        throw new Error(`unexpected request ${method} ${path}`);
      },
    });
    expect(await exec.placeStopMarketClose("BTC/USD", "buy", 90, 1)).toBe(true);
    expect(calls).toEqual(["POST /fapi/v1/order", "POST /fapi/v1/algoOrder"]);
  });

  test("does not route unrelated stop errors through Algo Order API", async () => {
    const calls: string[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        throw Object.assign(new Error("bad request"), { code: -2019 });
      },
    });
    expect(await exec.placeStopMarketClose("BTC/USD", "buy", 90, 1)).toBe(false);
    expect(calls).toEqual(["POST /fapi/v1/order"]);
  });

  test("accepted open that never fills is canceled and confirmed flat before null", async () => {
    const calls: string[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (method === "POST" && path === "/fapi/v1/order") return { status: "NEW", orderId: 99, avgPrice: "0", executedQty: "0", updateTime: 1 };
        if (method === "GET" && path === "/fapi/v1/order") return { status: calls.includes("DELETE /fapi/v1/order") ? "CANCELED" : "NEW", avgPrice: "0", executedQty: "0" };
        if (method === "DELETE" && path === "/fapi/v1/order") return {};
        if (method === "GET" && path === "/fapi/v2/positionRisk") return [];
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.leverageBySymbol.set("BTCUSDT", 2);

    const signal = { id: "s", symbol: "BTC/USD", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 100, timestamp: Date.now(), indicators: {}, reason: "test" } as any;
    expect(await exec.placeOrder(signal, 1, "momentum_crypto")).toBeNull();
    expect(calls).toContain("DELETE /fapi/v1/order");
    expect(calls).toContain("GET /fapi/v2/positionRisk");
  });

  test("cancels a partial residual, confirms terminal, and returns final position quantity", async () => {
    const calls: string[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (method === "POST" && path === "/fapi/v1/leverage") return {};
        if (method === "POST" && path === "/fapi/v1/order") return { status: "PARTIALLY_FILLED", orderId: 11, avgPrice: "100", executedQty: "0.5" };
        if (method === "GET" && path === "/fapi/v1/order") return { status: calls.includes("DELETE /fapi/v1/order") ? "CANCELED" : "PARTIALLY_FILLED" };
        if (method === "DELETE" && path === "/fapi/v1/order") return {};
        if (method === "GET" && path === "/fapi/v2/positionRisk") return [{ symbol: "BTCUSDT", positionAmt: "0.4", entryPrice: "101", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        if (method === "GET" && path === "/fapi/v1/userTrades") throw new Error("commission history lag");
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.leverageBySymbol.set("BTCUSDT", 2);
    const signal = { id: "partial", symbol: "BTC/USD", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 100, timestamp: Date.now(), indicators: {}, reason: "test" } as any;
    const order = await exec.placeOrder(signal, 1, "momentum_crypto");
    expect(order?.quantity).toBe(0.4);
    expect(order?.filledPrice).toBe(101);
    expect(calls).toContain("DELETE /fapi/v1/order");
    expect(calls).toContain("GET /fapi/v2/positionRisk");
  });

  test("commission-history lag after a confirmed fill does not discard the position", async () => {
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        if (method === "POST" && path === "/fapi/v1/order") return { status: "FILLED", orderId: 12, avgPrice: "100", executedQty: "1" };
        if (method === "GET" && path === "/fapi/v1/userTrades") throw new Error("not indexed yet");
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.leverageBySymbol.set("BTCUSDT", 2);
    const signal = { id: "lag", symbol: "BTC/USD", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 100, timestamp: Date.now(), indicators: {}, reason: "test" } as any;
    const order = await exec.placeOrder(signal, 1, "momentum_crypto");
    expect(order?.quantity).toBe(1);
    expect(order?.openCommission).toBe(0);
  });
});

describe("placeStopMarketClose floors to the exact PRICE_FILTER tickSize, not a decimal-place count", () => {
  // 2026-07-19 reviewer finding: stopPrice.toFixed(decimals) rounds to N
  // decimal places but does NOT floor to a multiple of tickSize — a tick of
  // 0.25 rejects any price that isn't ...00/25/50/75, and toFixed(2) lets
  // "90.37" straight through. Must floor to the tick itself (same as qty
  // flooring against LOT_SIZE step).
  test("tickSize 0.25: 90.37 floors to 90.25, not a naive 2-decimal round", async () => {
    const calls: any[] = [];
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT", { tickSize: 0.25 })]),
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/fapi/v1/order") return { orderId: 1 };
        throw new Error(`unexpected ${method} ${path}`);
      },
    });
    expect(await exec.placeStopMarketClose("BTC/USD", "buy", 90.37, 1)).toBe(true);
    const orderCall = calls.find((c) => c.path === "/fapi/v1/order");
    expect(orderCall?.params.stopPrice).toBe("90.25"); // floored to the 0.25 tick, not "90.37"
  });

  test("tickSize 0.25 also floors on the Algo Order API fallback (-4120)", async () => {
    const calls: any[] = [];
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT", { tickSize: 0.25 })]),
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/fapi/v1/order") { const e = new Error("unsupported") as Error & { code: number }; e.code = -4120; throw e; }
        if (path === "/fapi/v1/algoOrder") return { algoId: 7 };
        throw new Error(`unexpected ${method} ${path}`);
      },
    });
    expect(await exec.placeStopMarketClose("BTC/USD", "buy", 90.37, 1)).toBe(true);
    const algoCall = calls.find((c) => c.path === "/fapi/v1/algoOrder");
    expect(algoCall?.params.triggerPrice).toBe("90.25");
  });
});

describe("closePosition", () => {
  test("does not report success for an accepted order that never fills or reduces the position", async () => {
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        if (path === "/fapi/v2/positionRisk") {
          return [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        }
        if (method === "POST" && path === "/fapi/v1/order") {
          return { status: "NEW", avgPrice: "0" };
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 5;

    // Outcome taxonomy: an accepted order that could not be confirmed
    // terminal is UNKNOWN — it may still fill; reconciliation resolves it.
    expect(await exec.closePosition("BTC/USD", 1, "buy")).toEqual({
      success: false,
      filledPrice: 0,
      commission: 0,
      realizedPnl: 0,
      reason: "accepted but not confirmed filled or reduced",
      outcome: "unknown",
    });
  });

  test("accepted late fill converges, returns trade timestamp, and clears stops when flat", async () => {
    const calls: string[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === "/fapi/v2/positionRisk") {
          const count = calls.filter(c => c === "GET /fapi/v2/positionRisk").length;
          return count === 1
            ? [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
            : [];
        }
        if (method === "POST" && path === "/fapi/v1/order") return { status: "NEW", orderId: 7, avgPrice: "0" };
        if (method === "GET" && path === "/fapi/v1/order") return { status: "NEW", avgPrice: "0" };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [{ qty: "1", price: "90", commission: "0.5", realizedPnl: "-10", time: "1234" }];
        if (method === "GET" && path === "/fapi/v1/openOrders") return [];
        if (method === "GET" && path === "/fapi/v1/openAlgoOrders") return [];
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 20;

    await expect(exec.closePosition("BTC/USD", 1, "buy")).resolves.toEqual({
      success: true,
      filledPrice: 90,
      commission: 0.5,
      realizedPnl: -10,
      exitTime: 1234,
      orderId: "7",
      submittedAt: expect.any(Number),
      submittedPx: 0,
      filledQty: 1,
      outcome: "confirmed",
    });
    // Cleanup enumerates both order stores (targeted cancels) — never the
    // old account-wide blind sweep (P1 2026-07-29).
    expect(calls).toContain("GET /fapi/v1/openOrders");
    expect(calls).toContain("GET /fapi/v1/openAlgoOrders");
    expect(calls).not.toContain("DELETE /fapi/v1/allOpenOrders");
  });

  test("clears stops before returning accounting failure when broker is flat but trades lag", async () => {
    const calls: string[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === "/fapi/v2/positionRisk") {
          return calls.filter(c => c === "GET /fapi/v2/positionRisk").length === 1
            ? [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
            : [];
        }
        if (method === "POST" && path === "/fapi/v1/order") return { status: "NEW", orderId: 13, avgPrice: "0" };
        if (method === "GET" && path === "/fapi/v1/order") return { status: "NEW" };
        if (method === "GET" && path === "/fapi/v1/userTrades") throw new Error("settlement lag");
        if (method === "GET" && path === "/fapi/v1/openOrders") return [];
        if (method === "GET" && path === "/fapi/v1/openAlgoOrders") return [];
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 20;
    // Broker reduced but settlement lagged: the close HAPPENED — unknown, not proven.
    await expect(exec.closePosition("BTC/USD", 1, "buy")).resolves.toEqual({ success: false, filledPrice: 0, commission: 0, realizedPnl: 0, reason: "settlement lag", outcome: "unknown" });
    expect(calls).toContain("GET /fapi/v1/openOrders");
    expect(calls).toContain("GET /fapi/v1/openAlgoOrders");
    expect(calls).not.toContain("DELETE /fapi/v1/allOpenOrders");
  });

  test("unconfirmed accepted close is canceled before failure", async () => {
    const calls: string[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === "/fapi/v2/positionRisk") return [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        if (method === "POST" && path === "/fapi/v1/order") return { status: "NEW", orderId: 8, avgPrice: "0" };
        if (method === "GET" && path === "/fapi/v1/order") return { status: "NEW", avgPrice: "0" };
        if (method === "DELETE" && path === "/fapi/v1/order") return {};
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 5;

    expect(await exec.closePosition("BTC/USD", 1, "buy")).toEqual({ success: false, filledPrice: 0, commission: 0, realizedPnl: 0, reason: "accepted but not confirmed filled or reduced", outcome: "unknown" });
    expect(calls).toContain("DELETE /fapi/v1/order");
  });

  test("closePosition returns success but leaves the native stop when order is FILLED and flatness stays unknown (getPositions throws throughout)", async () => {
    let positionRiskCalls = 0;
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        if (path === "/fapi/v2/positionRisk") {
          positionRiskCalls++;
          // First call is the pre-check (before the close order); it must
          // succeed so positionBefore is known. Every later call (mid-poll,
          // post-loop re-fetch) simulates a transient 5xx/rate-limit throw —
          // flatness is never positively confirmed.
          if (positionRiskCalls === 1) {
            return [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
          }
          throw new Error("positionRisk unavailable");
        }
        if (method === "POST" && path === "/fapi/v1/order") return { status: "NEW", orderId: 21, avgPrice: "0" };
        if (method === "GET" && path === "/fapi/v1/order") return { status: "FILLED", avgPrice: "95" };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [{ qty: "1", price: "95", commission: "0.3", realizedPnl: "-5", time: "5678" }];
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 20;
    let cancelCalled = false;
    // closePosition (already holding the symbol lock) calls the UNLOCKED
    // core, not the locked public wrapper — override the core seam.
    exec.cancelAllOrdersCore = async () => { cancelCalled = true; };

    const result = await exec.closePosition("BTC/USD", 1, "buy");
    expect(result.success).toBe(true);
    expect(result.filledPrice).toBeGreaterThan(0);
    // Fill + settlement are confirmed independently of the position read, so
    // success stays true — but flatness was NEVER positively confirmed, so
    // the native stop must be left in place (unknown != flat).
    expect(cancelCalled).toBe(false);
  });

  test("closePosition cancels the native stop once flatness is positively confirmed (positionAmt=0)", async () => {
    let positionRiskCalls = 0;
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        if (path === "/fapi/v2/positionRisk") {
          positionRiskCalls++;
          if (positionRiskCalls === 1) {
            return [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
          }
          // Mid-poll re-check confirms the broker position is genuinely flat.
          return [];
        }
        if (method === "POST" && path === "/fapi/v1/order") return { status: "NEW", orderId: 22, avgPrice: "0" };
        if (method === "GET" && path === "/fapi/v1/order") return { status: "FILLED", avgPrice: "95" };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [{ qty: "1", price: "95", commission: "0.3", realizedPnl: "-5", time: "5678" }];
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 20;
    let cancelCalled = false;
    // closePosition (already holding the symbol lock) calls the UNLOCKED
    // core, not the locked public wrapper — override the core seam.
    exec.cancelAllOrdersCore = async () => { cancelCalled = true; };

    const result = await exec.closePosition("BTC/USD", 1, "buy");
    expect(result.success).toBe(true);
    expect(result.filledPrice).toBeGreaterThan(0);
    expect(cancelCalled).toBe(true);
  });

  // 2026-07-19 reviewer finding: a risk-reducing close must never round a
  // broker-reported qty with an arbitrary fallback precision when the
  // instrument catalog is unavailable — that used to zero out real
  // sub-cent-precision positions (BTCUSDT 0.001 -> "0.00" at the old
  // FALLBACK_DECIMALS=2) and silently no-op the close.
  test("catalog unavailable: preserves the exact broker qty for a close instead of the old 2-decimal fallback (BTCUSDT 0.001 submits nonzero)", async () => {
    const calls: any[] = [];
    const exec = make({
      instrumentCatalog: defaultCatalog([]), // no seeded spec — simulates exchangeInfo unreachable
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/fapi/v2/positionRisk") {
          return [{ symbol: "BTCUSDT", positionAmt: "0.001", entryPrice: "50000", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        }
        if (method === "POST" && path === "/fapi/v1/order") return { status: "FILLED", orderId: 99, avgPrice: "50000" };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [{ qty: "0.001", price: "50000", commission: "0.01", realizedPnl: "1", time: "999" }];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 20;

    const result = await exec.closePosition("BTC/USD", 0.001, "buy");
    const orderCall = calls.find((c: any) => c.method === "POST" && c.path === "/fapi/v1/order");
    expect(orderCall?.params.quantity).toBe("0.001"); // NOT "0.00" — the old FALLBACK_DECIMALS=2 zeroed this
    expect(result.success).toBe(true);
  });

  // 2026-07-19 reviewer finding: a legacy position can be SMALLER than the
  // CURRENT LOT_SIZE step (Binance widened it after the position was
  // opened). Flooring the broker-reported qty to that step silently
  // produces 0 and no-ops a real risk-reducing close. Step here (0.01) is
  // intentionally larger than 0.001 to prove the fallback isn't accidentally
  // reusing the default fixture's finer step.
  test("catalog available but step too coarse for the legacy qty: submits the exact broker qty instead of flooring to zero", async () => {
    const calls: any[] = [];
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT", {
        stepSize: 0.01, minQty: 0.01, marketStepSize: 0.01, marketMinQty: 0.01,
      })]),
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/fapi/v2/positionRisk") {
          const count = calls.filter((c) => c.path === "/fapi/v2/positionRisk").length;
          return count === 1
            ? [{ symbol: "BTCUSDT", positionAmt: "0.005", entryPrice: "50000", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
            : []; // reduced to flat once the exact 0.005 close fills
        }
        if (method === "POST" && path === "/fapi/v1/order") return { status: "FILLED", orderId: 99, avgPrice: "50000" };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [{ qty: "0.005", price: "50000", commission: "0.01", realizedPnl: "1", time: "999" }];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 20;

    const result = await exec.closePosition("BTC/USD", 0.005, "buy");
    const orderCall = calls.find((c: any) => c.method === "POST" && c.path === "/fapi/v1/order");
    expect(orderCall?.params.quantity).toBe("0.005"); // NOT "0" — floorToStep(0.005, 0.01) would zero this
    expect(result.success).toBe(true);
  });

  // Certification P0 (2026-07-20 reviewer finding): a cert-owned close must
  // never let the executor's own sweep touch orders it doesn't own by exact
  // id. skipOrderCleanup:true must gate EVERY cancelAllOrders call site
  // inside closePosition (preflat no-op close, mid-poll, post-settlement).
  test("skipOrderCleanup:true never sweeps /allOpenOrders or enumerates/cancels algo orders", async () => {
    const calls: string[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === "/fapi/v2/positionRisk") {
          const count = calls.filter(c => c === "GET /fapi/v2/positionRisk").length;
          return count === 1
            ? [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
            : [];
        }
        if (method === "POST" && path === "/fapi/v1/order") return { status: "NEW", orderId: 7, avgPrice: "0" };
        if (method === "GET" && path === "/fapi/v1/order") return { status: "NEW", avgPrice: "0" };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [{ qty: "1", price: "90", commission: "0.5", realizedPnl: "-10", time: "1234" }];
        // /fapi/v1/allOpenOrders and /fapi/v1/openAlgoOrders are NOT handled
        // here on purpose — reaching them fails the test.
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any;
    exec.pollDelayMs = 1;
    exec.closePollTimeoutMs = 20;

    const result = await exec.closePosition("BTC/USD", 1, "buy", { skipOrderCleanup: true });
    expect(result.success).toBe(true);
    expect(calls).not.toContain("DELETE /fapi/v1/allOpenOrders");
    expect(calls).not.toContain("GET /fapi/v1/openAlgoOrders");
  });
});

describe("marginAsset ownership: a catalog spec must match this executor's quoteAsset", () => {
  // A USDC-native symbol whose exchangeInfo row somehow carries a USDT
  // margin asset is a data-integrity mismatch — treated identically to "no
  // spec found" everywhere it's consulted.
  test("USDT-margin row on a USDC executor: a NEW entry fails closed (never guesses precision)", async () => {
    const usdc = make({
      options: { quoteAsset: "USDC" },
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDC", { marginAsset: "USDT" })]),
      signedRequest: async () => { throw new Error("must not be called"); },
    }) as any;
    const signal = { id: "s", symbol: "BTC/USDC", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 50000, timestamp: Date.now(), indicators: {}, reason: "test" } as any;
    expect(await usdc.placeOrder(signal, 0.5, "momentum_crypto_usdc")).toBeNull();
  });

  test("USDT-margin row on a USDC executor: a risk-reducing close still proceeds with the exact quantity (fail-open only for closes)", async () => {
    const calls: any[] = [];
    const usdc = make({
      options: { quoteAsset: "USDC" },
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDC", { marginAsset: "USDT" })]),
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/fapi/v2/positionRisk") {
          return [{ symbol: "BTCUSDC", positionAmt: "0.5", entryPrice: "50000", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        }
        if (method === "POST" && path === "/fapi/v1/order") return { status: "FILLED", orderId: 5, avgPrice: "50000" };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [{ qty: "0.5", price: "50000", commission: "0.1", realizedPnl: "1", time: "1" }];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }) as any;
    usdc.pollDelayMs = 1;
    usdc.closePollTimeoutMs = 20;

    const result = await usdc.closePosition("BTC/USDC", 0.5, "buy");
    const orderCall = calls.find((c: any) => c.method === "POST" && c.path === "/fapi/v1/order");
    expect(orderCall?.params.quantity).toBe("0.5");
    expect(result.success).toBe(true);
  });
});

describe("getOpenProtectiveOrders — algo-order quantity shape (totalQty, no origQty)", () => {
  test("reads quantity from totalQty when origQty is absent (real openAlgoOrders shape)", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/fapi/v1/openOrders") return [];
        if (path === "/fapi/v1/openAlgoOrders") return [{
          symbol: "BTCUSDT", orderType: "STOP_MARKET", reduceOnly: "true",
          side: "SELL", totalQty: "3", triggerPrice: "47000",
        }];
        throw new Error(`unexpected path ${path}`);
      },
    });
    const orders = await exec.getOpenProtectiveOrders("BTC/USDT");
    expect(orders).toHaveLength(1);
    expect(orders[0].quantity).toBe(3);
  });
});

describe("getReverseSymbolMap (shim needs it public)", () => {
  test("reverses raw Binance symbol → alpaca symbol", () => {
    const rev = new BinanceExecutor().getReverseSymbolMap();
    expect(rev["BTCUSDT"]).toBe("BTC/USD");
    expect(rev["ETHUSDT"]).toBe("ETH/USD");
  });
});

// ══════════════════════════════════════════════
// Isolated USDC quote-asset wallet (2026-07-19). A second BinanceExecutor
// instance, same account, disjoint symbol map ("BTC/USDC" -> "BTCUSDC").
// Every mutation/list method keys off `this.symbolMap`, so ownership is a
// plain lookup — these tests prove BTCUSDT/BTCUSDC coexist without leaking
// into each other's view or mutation surface.
// ══════════════════════════════════════════════
describe("quote asset isolation (USDT vs USDC)", () => {
  const mixedPositionRisk = [
    { symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: "1" },
    { symbol: "ETHUSDT", positionAmt: "0.5", entryPrice: "3000", unRealizedProfit: "0", leverage: "2", updateTime: "1" },
    { symbol: "LINKUSDT", positionAmt: "10", entryPrice: "15", unRealizedProfit: "0", leverage: "2", updateTime: "1" },
    { symbol: "BTCUSDC", positionAmt: "2", entryPrice: "101", unRealizedProfit: "0", leverage: "2", updateTime: "1" },
  ];

  test("getPositions scopes to the instance's own quote asset — BTCUSDT and BTCUSDC coexist without leaking", async () => {
    const usdt = make({ signedRequest: async () => mixedPositionRisk });
    const usdc = make({ signedRequest: async () => mixedPositionRisk, options: { quoteAsset: "USDC" } });

    const usdtSymbols = (await usdt.getPositions()).map(p => p.symbol).sort();
    expect(usdtSymbols).toEqual(["BTCUSDT", "ETHUSDT", "LINKUSDT"]); // no BTCUSDC leak

    const usdcSymbols = (await usdc.getPositions()).map(p => p.symbol);
    expect(usdcSymbols).toEqual(["BTCUSDC"]); // no USDT positions leak, incl. ETHUSDT/LINKUSDT
  });

  test("a USDC instance refuses to close/cancel a USDT-internal symbol — no broker call is made", async () => {
    const calls: string[] = [];
    const usdc = make({
      signedRequest: async (method: string, path: string) => { calls.push(`${method} ${path}`); throw new Error("must not be called"); },
      options: { quoteAsset: "USDC" },
    });

    expect(await usdc.closePosition("BTC/USD", 1, "buy")).toEqual({ success: false, filledPrice: 0, commission: 0, realizedPnl: 0, reason: "no symbol mapping", outcome: "proven_failed" });
    await usdc.cancelAllOrders("BTC/USD");
    expect(calls).toEqual([]); // zero broker mutations for a symbol this instance doesn't own
  });

  test("a USDT (default) instance refuses to close/cancel a USDC-internal symbol — no broker call is made", async () => {
    const calls: string[] = [];
    const usdt = make({
      signedRequest: async (method: string, path: string) => { calls.push(`${method} ${path}`); throw new Error("must not be called"); },
    });

    expect(await usdt.closePosition("BTC/USDC", 1, "buy")).toEqual({ success: false, filledPrice: 0, commission: 0, realizedPnl: 0, reason: "no symbol mapping", outcome: "proven_failed" });
    await usdt.cancelAllOrders("BTC/USDC");
    expect(calls).toEqual([]);
  });

  test("USDC instance maps its own internal symbol to the native contract (BTC/USDC -> BTCUSDC)", () => {
    const usdc = make({ options: { quoteAsset: "USDC" } });
    expect(usdc.getQuoteAsset()).toBe("USDC");
    expect(usdc.toNativeSymbol("BTC/USDC")).toBe("BTCUSDC");
    expect(usdc.toNativeSymbol("BTC/USD")).toBeNull(); // USDT-style symbol not owned
    expect(usdc.toInternalSymbol("BTCUSDC")).toBe("BTC/USDC");
    expect(usdc.toInternalSymbol("BTCUSDT")).toBeNull();
  });

  test("USDC instance places an order against the native BTCUSDC contract", async () => {
    const calls: { method: string; path: string; params: any }[] = [];
    const usdc = make({
      options: { quoteAsset: "USDC" },
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDC", { marginAsset: "USDC" })]),
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (method === "POST" && path === "/fapi/v1/order") return { status: "FILLED", orderId: 1, avgPrice: "50000", executedQty: "0.5" };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }) as any;
    usdc.leverageBySymbol.set("BTCUSDC", 2);
    const signal = { id: "s", symbol: "BTC/USDC", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 50000, timestamp: Date.now(), indicators: {}, reason: "test" } as any;

    const order = await usdc.placeOrder(signal, 0.5, "momentum_crypto_usdc");
    expect(order?.quantity).toBe(0.5);
    const orderCall = calls.find(c => c.method === "POST" && c.path === "/fapi/v1/order");
    expect(orderCall?.params.symbol).toBe("BTCUSDC");
    // Never touched a USDT native symbol.
    expect(calls.every(c => c.params?.symbol !== "BTCUSDT")).toBe(true);
  });
});

describe("instrument catalog: dynamic filters replace hardcoded precision", () => {
  test("floors AVAXUSDT qty to its exchangeInfo whole-unit step, not the old hardcoded 0.1", async () => {
    const calls: any[] = [];
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("AVAXUSDT", { stepSize: 1, minQty: 1, maxQty: 10000, marketStepSize: 1, marketMinQty: 1, marketMaxQty: 10000 })]),
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (method === "POST" && path === "/fapi/v1/order") return { status: "FILLED", orderId: 2, avgPrice: "40", executedQty: params.quantity };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }) as any;
    exec.leverageBySymbol.set("AVAXUSDT", 2);
    const signal = { id: "avax", symbol: "AVAX/USD", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 40, timestamp: Date.now(), indicators: {}, reason: "test" } as any;

    const order = await exec.placeOrder(signal, 12.7, "binance_low");
    const orderCall = calls.find(c => c.method === "POST" && c.path === "/fapi/v1/order");
    expect(orderCall?.params.quantity).toBe("12"); // floored to whole units per exchangeInfo, not 12.7
    expect(order?.quantity).toBe(12);
  });

  test("BTCUSDC floors on its own tick/step, independent of BTCUSDT's spec", async () => {
    const calls: any[] = [];
    const usdc = make({
      options: { quoteAsset: "USDC" },
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDC", { marginAsset: "USDC", stepSize: 0.0001, minQty: 0.0001, marketStepSize: 0.0001, marketMinQty: 0.0001, maxQty: 100, marketMaxQty: 100 })]),
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (method === "POST" && path === "/fapi/v1/order") return { status: "FILLED", orderId: 3, avgPrice: "50000", executedQty: params.quantity };
        if (method === "GET" && path === "/fapi/v1/userTrades") return [];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }) as any;
    usdc.leverageBySymbol.set("BTCUSDC", 2);
    const signal = { id: "btcusdc", symbol: "BTC/USDC", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 50000, timestamp: Date.now(), indicators: {}, reason: "test" } as any;

    await usdc.placeOrder(signal, 0.123456, "momentum_crypto_usdc");
    const orderCall = calls.find(c => c.method === "POST" && c.path === "/fapi/v1/order");
    expect(orderCall?.params.quantity).toBe("0.1234"); // floored to 0.0001 step, not BTCUSDT's 0.001
  });

  test("rejects an order below MIN_NOTIONAL before ever calling the broker", async () => {
    const calls: any[] = [];
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT", { minNotional: 100 })]),
      signedRequest: async (method: string, path: string, params: any) => { calls.push({ method, path, params }); throw new Error("must not be called"); },
    }) as any;
    exec.leverageBySymbol.set("BTCUSDT", 2);
    const signal = { id: "tiny", symbol: "BTC/USD", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 10, timestamp: Date.now(), indicators: {}, reason: "test" } as any;

    const order = await exec.placeOrder(signal, 0.001, "binance_low"); // notional = 0.01 << 100
    expect(order).toBeNull();
    expect(calls).toEqual([]); // pre-flight rejection, zero broker calls
  });
});

describe("margin balance: quote-asset row selection", () => {
  test("USDC instance reads its own assets[] row (marginBalance/walletBalance/availableBalance), not USDT root totals", async () => {
    const usdc = make({
      options: { quoteAsset: "USDC" },
      signedRequest: async () => ({
        // Root totals reflect ONLY the USDT margin asset — must be ignored.
        totalWalletBalance: "4443", totalUnrealizedProfit: "232", totalMarginBalance: "4675", availableBalance: "2005",
        assets: [
          { asset: "USDT", walletBalance: "4443", unrealizedProfit: "232", marginBalance: "4675", availableBalance: "2005" },
          { asset: "USDC", walletBalance: "5000", unrealizedProfit: "10", marginBalance: "5010", availableBalance: "4800" },
        ],
      }),
    });
    expect(await usdc.getBalance()).toEqual({ marginEquity: 5010, marginCash: 4800, wallet: 5000, unrealizedPnl: 10 });
  });

  test("USDC instance throws when its asset row is absent", async () => {
    const usdc = make({
      options: { quoteAsset: "USDC" },
      signedRequest: async () => ({
        totalWalletBalance: "4443", totalUnrealizedProfit: "232", totalMarginBalance: "4675", availableBalance: "2005",
        assets: [{ asset: "USDT", walletBalance: "4443", unrealizedProfit: "232", marginBalance: "4675", availableBalance: "2005" }],
      }),
    });
    await expect(usdc.getBalance()).rejects.toThrow("no USDC asset row");
  });

  test("USDC instance still fails closed on its own row's internal mismatch", async () => {
    const usdc = make({
      options: { quoteAsset: "USDC" },
      signedRequest: async () => ({
        assets: [{ asset: "USDC", walletBalance: "5000", unrealizedProfit: "10", marginBalance: "9999", availableBalance: "4800" }],
      }),
    });
    await expect(usdc.getBalance()).rejects.toThrow("mismatch");
  });
});

function bookTicker(symbol: string, ask: number, bid: number, time: number): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ symbol, askPrice: String(ask), bidPrice: String(bid), time }),
  } as Response;
}

function fetchQueue(...responses: Response[]): void {
  globalThis.fetch = (async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  }) as unknown as typeof fetch;
}

describe("BinanceExecutor executable quote", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("ask for buys, bid for sells", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    fetchQueue(bookTicker("BTCUSDT", 50100, 50095, Date.now()));
    expect(await exec.getExecutableQuote("BTC/USD", "buy")).toEqual({ price: 50100, timestamp: expect.any(Number), bid: 50095, ask: 50100 });
    fetchQueue(bookTicker("BTCUSDT", 50100, 50095, Date.now()));
    expect(await exec.getExecutableQuote("BTC/USD", "sell")).toEqual({ price: 50095, timestamp: expect.any(Number), bid: 50095, ask: 50100 });
  });

  test("rejects stale broker quote and returns null", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    fetchQueue(bookTicker("BTCUSDT", 50100, 50095, Date.now() - 60_000));
    expect(await exec.getExecutableQuote("BTC/USD", "buy")).toBeNull();
  });

  test("telemetry failure is fail-open and logs once", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    globalThis.fetch = (async () => { throw new Error("bookTicker down"); }) as unknown as typeof fetch;
    expect(await exec.getExecutableQuote("BTC/USD", "buy")).toBeNull();
  });

  // 2026-07-29 data integrity: bid > ask is well-formed but physically
  // impossible — the quote is telemetry only, so discarding beats
  // benchmarking fills against garbage.
  test("crossed book (bid > ask) is discarded → null", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    fetchQueue(bookTicker("BTCUSDT", 50095, 50100, Date.now())); // ask < bid
    expect(await exec.getExecutableQuote("BTC/USD", "buy")).toBeNull();
  });

  test("broker timestamp in OUR future beyond tolerable drift → null", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    fetchQueue(bookTicker("BTCUSDT", 50100, 50095, Date.now() + 60_000));
    expect(await exec.getExecutableQuote("BTC/USD", "buy")).toBeNull();
  });
});

// 2026-07-29 data integrity: an OPEN positionRisk row with markPrice
// "0.00000000" (real testnet shape) is impossible — it must WARN but the row
// must be KEPT: dropping it would hide a live position from the stop-loss
// loop, which is its only protection.
describe("getPositions positionRisk payload canary", () => {
  test("impossible markPrice row is kept, never dropped", async () => {
    const exec = make({
      signedRequest: async () => [
        { symbol: "ATOMUSDT", positionAmt: "12.3", entryPrice: "4.512", markPrice: "0.00000000", unRealizedProfit: "0", leverage: "2", updateTime: "1" },
        { symbol: "BTCUSDT", positionAmt: "0.000", entryPrice: "0.0", markPrice: "0.00000000", unRealizedProfit: "0", leverage: "2", updateTime: "0" }, // flat: benign
      ],
    });
    const out = await exec.getPositions();
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("ATOMUSDT");
    expect(out[0].positionAmt).toBe(12.3);
  });
});

function premiumIndexArray(symbol: string, markPrice: number): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ([{ symbol, markPrice: String(markPrice), lastFundingRate: "0.0001", indexPrice: String(markPrice - 1) }]),
  } as Response;
}

function premiumIndexSingle(symbol: string, markPrice: number): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ symbol, markPrice: String(markPrice), lastFundingRate: "0.0001" }),
  } as Response;
}

// OPEN.md P1 (2026-07-31): the client-side stop-loss (AccountManager.
// checkAllStopLoss) and the broker's native STOP_MARKET (workingType:
// MARK_PRICE) must fire on the SAME series. getPrice used to read
// /fapi/v1/ticker/price (last trade); it must now read /fapi/v1/premiumIndex
// (mark price) — same symbol->number shape so every caller is unaffected.
describe("BinanceExecutor getPrice — mark price, not last trade (OPEN.md P1)", () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  test("reads markPrice from premiumIndex array response", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    fetchQueue(premiumIndexArray("BTCUSDT", 50123.4));
    expect(await exec.getPrice("BTCUSDT")).toBe(50123.4);
  });

  test("reads markPrice from premiumIndex single-object response (real symbol-scoped shape)", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    fetchQueue(premiumIndexSingle("BTCUSDT", 49999.9));
    expect(await exec.getPrice("BTCUSDT")).toBe(49999.9);
  });

  test("hits premiumIndex, never ticker/price", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string) => {
      requestedUrl = String(url);
      return premiumIndexSingle("ETHUSDT", 3000);
    }) as unknown as typeof fetch;
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    await exec.getPrice("ETHUSDT");
    expect(requestedUrl).toContain("/fapi/v1/premiumIndex");
    expect(requestedUrl).not.toContain("ticker/price");
  });

  // The falsifier for OPEN.md's P1: a payload where markPrice and a
  // last-trade-shaped decoy field disagree — the stop-loss feed must return
  // markPrice (the series the broker's native stop actually uses), not the
  // decoy.
  test("markPrice diverges from last-trade price — the divergent mark is what feeds the stop check", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ symbol: "BTCUSDT", markPrice: "50100.5", price: "50000.0" }),
    })) as unknown as typeof fetch;
    expect(await exec.getPrice("BTCUSDT")).toBe(50100.5);
  });
});

// 2026-07-29: signedRequestRaw (the listenKey sibling that never checked
// resp.ok) is DELETED — everything routes through signedRequest, which now
// also speaks PUT. Binance really returns HTTP 400 with a body like
// {"code":-1021,"msg":"Timestamp ... outside of the recvWindow"}.
describe("listenKey requests go through the guarded signedRequest", () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  test("the unguarded sibling no longer exists", () => {
    const exec = new BinanceExecutor() as any;
    expect(exec.signedRequestRaw).toBeUndefined();
  });

  test("PUT listenKey keepalive with HTTP 400 {code:-1021} throws with the code attached", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ code: -1021, msg: "Timestamp for this request is outside of the recvWindow." }),
      { status: 400 },
    )) as unknown as typeof fetch;
    const exec = make() as any;
    try {
      await exec.signedRequest("PUT", "/fapi/v1/listenKey", {});
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe(-1021);
      expect(e.message).toContain("recvWindow");
    }
  });
});

describe("BinanceExecutor getUsdRate (real implementation, via global fetch)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("hits Binance's canonical asset index (not a trading price) and feeds getAccountTotal, never getBalance", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string) => {
      requestedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ symbol: "BTCUSD", index: "64775.7427" }) } as Response;
    }) as unknown as typeof fetch;

    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    exec.signedRequest = async () => ({
      totalWalletBalance: "0",
      totalUnrealizedProfit: "0",
      totalMarginBalance: "0",
      availableBalance: "0",
      assets: [{ asset: "BTC", walletBalance: "1", unrealizedProfit: "0", availableBalance: "1" }],
    });

    expect(await exec.getBalance()).not.toHaveProperty("equity"); // getBalance never touches the asset index
    const total = await exec.getAccountTotal();
    expect(requestedUrl.endsWith("/fapi/v1/assetIndex?symbol=BTCUSD")).toBe(true);
    expect(total.equity).toBe(64775.7427);
  });

  test("non-ok or malformed asset-index response fails getAccountTotal closed to null", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    exec.signedRequest = async () => ({
      totalWalletBalance: "0",
      totalUnrealizedProfit: "0",
      totalMarginBalance: "0",
      availableBalance: "0",
      assets: [{ asset: "BTC", walletBalance: "1", unrealizedProfit: "0", availableBalance: "1" }],
    });

    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await exec.getAccountTotal()).toBeNull();

    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ index: "not-a-number" }) })) as unknown as typeof fetch;
    expect(await exec.getAccountTotal()).toBeNull();
  });
});

// 2026-07-19: momentum_crypto_usdc startup gate. Read-only, never places an
// order — see src/config/riskProfiles.ts momentum_crypto_usdc.
describe("preflight (USDC startup gate)", () => {
  test("refuses a non-testnet restBase before any signed request", async () => {
    const exec = new BinanceExecutor({ quoteAsset: "USDC" }) as any;
    exec.baseUrl = "https://fapi.binance.com"; // live host
    exec.apiKey = "k"; exec.secretKey = "s";
    let called = false;
    exec.signedRequest = async () => { called = true; return {}; };
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/testnet/i);
    expect(called).toBe(false);
  });

  test("refuses when dualSidePosition is true (hedge mode, not one-way)", async () => {
    const exec = new BinanceExecutor({ quoteAsset: "USDC" }) as any;
    exec.baseUrl = "https://testnet.binancefuture.com";
    exec.apiKey = "k"; exec.secretKey = "s";
    exec.signedRequest = async (_m: string, path: string) => {
      if (path === "/fapi/v1/positionSide/dual") return { dualSidePosition: true };
      throw new Error(`unexpected ${path}`);
    };
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/one-way/i);
  });

  test("refuses when multiAssetsMargin is true (not single-asset mode)", async () => {
    const exec = new BinanceExecutor({ quoteAsset: "USDC" }) as any;
    exec.baseUrl = "https://testnet.binancefuture.com";
    exec.apiKey = "k"; exec.secretKey = "s";
    exec.signedRequest = async (_m: string, path: string) => {
      if (path === "/fapi/v1/positionSide/dual") return { dualSidePosition: false };
      if (path === "/fapi/v1/multiAssetsMargin") return { multiAssetsMargin: true };
      throw new Error(`unexpected ${path}`);
    };
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/single-asset/i);
  });

  test("refuses when the expected USDC balance row is missing", async () => {
    const exec = new BinanceExecutor({ quoteAsset: "USDC" }) as any;
    exec.baseUrl = "https://testnet.binancefuture.com";
    exec.apiKey = "k"; exec.secretKey = "s";
    exec.signedRequest = async (_m: string, path: string) => {
      if (path === "/fapi/v1/positionSide/dual") return { dualSidePosition: false };
      if (path === "/fapi/v1/multiAssetsMargin") return { multiAssetsMargin: false };
      if (path === "/fapi/v2/account") return { assets: [{ asset: "USDT", walletBalance: "5000" }] }; // no USDC row
      throw new Error(`unexpected ${path}`);
    };
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/USDC/);
  });

  test("refuses when exchangeInfo filters are missing for an owned symbol", async () => {
    const exec = new BinanceExecutor({ quoteAsset: "USDC" }) as any;
    exec.baseUrl = "https://testnet.binancefuture.com";
    exec.apiKey = "k"; exec.secretKey = "s";
    // A REAL (non-throwing) exchangeInfo response that just doesn't list any
    // of this instance's owned symbols — distinct from a network failure.
    exec.catalog = new InstrumentCatalog(async () => ({ symbols: [] }));
    exec.signedRequest = async (_m: string, path: string) => {
      if (path === "/fapi/v1/positionSide/dual") return { dualSidePosition: false };
      if (path === "/fapi/v1/multiAssetsMargin") return { multiAssetsMargin: false };
      if (path === "/fapi/v2/account") return { assets: [{ asset: "USDC", walletBalance: "5000" }] };
      throw new Error(`unexpected ${path}`);
    };
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/exchangeInfo/i);
  });

  test("passes when testnet + one-way + single-asset + balance row + filters all check out", async () => {
    const exec = new BinanceExecutor({ quoteAsset: "USDC" }) as any;
    exec.baseUrl = "https://testnet.binancefuture.com";
    exec.apiKey = "k"; exec.secretKey = "s";
    // Seed every USDC symbol so `ensure()` never hits the network.
    exec.catalog = defaultCatalog(Object.values((exec as any).symbolMap).map((s: any) => makeSpec(s, { marginAsset: "USDC" })));
    exec.signedRequest = async (_m: string, path: string) => {
      if (path === "/fapi/v1/positionSide/dual") return { dualSidePosition: false };
      if (path === "/fapi/v1/multiAssetsMargin") return { multiAssetsMargin: false };
      if (path === "/fapi/v2/account") return { assets: [{ asset: "USDC", walletBalance: "5000" }] };
      throw new Error(`unexpected ${path}`);
    };
    expect(await exec.preflight()).toEqual({ ok: true });
  });
});

// 2026-07-19: FAPI InstrumentCatalog must fail CLOSED on a NEW order when no
// spec is available — replaces the unsafe generic 2-decimal fallback.
describe("placeOrder fails closed without an exchangeInfo spec", () => {
  test("rejects a new order when the instrument catalog has no spec (never guesses 2 decimals)", async () => {
    const exec = make({
      instrumentCatalog: defaultCatalog([]), // empty: BTCUSDT has no seeded spec
      signedRequest: async () => { throw new Error("should never reach the exchange"); },
    }) as any;
    const signal = { id: "s", symbol: "BTC/USD", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 100, timestamp: Date.now(), indicators: {}, reason: "test" } as any;
    expect(await exec.placeOrder(signal, 1)).toBeNull();
  });

  test("still places the order once a spec is seeded (unaffected behavior)", async () => {
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT")]),
      signedRequest: async (method: string, path: string) => {
        if (path === "/fapi/v1/leverage") return {};
        if (method === "POST" && path === "/fapi/v1/order") return { status: "FILLED", orderId: 1, avgPrice: "100", executedQty: "1" };
        if (path === "/fapi/v2/positionRisk") return [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: 1 }];
        throw new Error(`unexpected ${method} ${path}`);
      },
    }) as any;
    const signal = { id: "s", symbol: "BTC/USD", market: "crypto", side: "buy", strategy: "MOMENTUM", strength: "strong", price: 100, timestamp: Date.now(), indicators: {}, reason: "test" } as any;
    const order = await exec.placeOrder(signal, 1);
    expect(order).not.toBeNull();
  });
});

// 2026-07-20: certification used to guess "$20 / price" — silently under-shot
// BTCUSDC's real $100 MIN_NOTIONAL (a step-floored $20 probe landed at
// minQty's ~$65). minCertQty derives the real exchange minimum instead.
describe("minCertQty — exchange-derived minimum certification size", () => {
  test("production-shaped BTCUSDC (price 64660, minNotional 100, step 0.001) needs 0.002, not the 0.001 minQty", async () => {
    const usdc = make({
      options: { quoteAsset: "USDC" },
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDC", {
        marginAsset: "USDC", stepSize: 0.001, minQty: 0.001, maxQty: 1000,
        marketStepSize: 0.001, marketMinQty: 0.001, marketMaxQty: 1000, minNotional: 100,
      })]),
    }) as any;
    expect(await usdc.minCertQty("BTC/USDC", 64660)).toBe(0.002);
  });

  test("no MIN_NOTIONAL filter -> falls back to plain MARKET_LOT_SIZE minQty", async () => {
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT", { minNotional: null })]),
    }) as any;
    expect(await exec.minCertQty("BTC/USD", 50000)).toBe(0.001); // the seeded minQty
  });

  test("required qty > maxQty returns null — never clamps to an invalid (sub-minimum) size", async () => {
    const usdc = make({
      options: { quoteAsset: "USDC" },
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDC", {
        marginAsset: "USDC", stepSize: 0.001, minQty: 0.001, maxQty: 0.0015,
        marketStepSize: 0.001, marketMinQty: 0.001, marketMaxQty: 0.0015, minNotional: 100,
      })]),
    }) as any;
    // Notional needs 0.002 (as above) but maxQty caps at 0.0015 — clamping
    // down would submit a qty that no longer clears MIN_NOTIONAL.
    expect(await usdc.minCertQty("BTC/USDC", 64660)).toBeNull();
  });

  test("unaligned minQty (not an exact multiple of step) rounds UP to the next step, never down", async () => {
    const exec = make({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT", {
        stepSize: 0.001, minQty: 0.0015, maxQty: 1000,
        marketStepSize: 0.001, marketMinQty: 0.0015, marketMaxQty: 1000, minNotional: null,
      })]),
    }) as any;
    expect(await exec.minCertQty("BTC/USD", 50000)).toBe(0.002);
  });

  test("fails closed on a non-finite price (Infinity/NaN)", async () => {
    const exec = make() as any; // default catalog seeds BTCUSDT
    expect(await exec.minCertQty("BTC/USD", Infinity)).toBeNull();
    expect(await exec.minCertQty("BTC/USD", NaN)).toBeNull();
  });

  test("fails closed on an internal symbol this instance doesn't own", async () => {
    const exec = make() as any;
    expect(await exec.minCertQty("FOO/BAR", 100)).toBeNull();
  });

  test("fails closed when no exchangeInfo spec is available for the symbol", async () => {
    const exec = make({ instrumentCatalog: defaultCatalog([]) }) as any; // BTCUSDT not seeded
    expect(await exec.minCertQty("BTC/USD", 100)).toBeNull();
  });

  test("fails closed on a non-positive price", async () => {
    const exec = make() as any; // default catalog seeds BTCUSDT
    expect(await exec.minCertQty("BTC/USD", 0)).toBeNull();
  });
});

describe("signedRequest — private seam, focused fetch tests", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("HTTP 200 with body code 200 returns data (does not throw)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 200, msg: "success", data: "test" }), { status: 200 })) as any;
    const exec = make() as any;
    const result = await exec.signedRequest("POST", "/fapi/v1/algoOrder/cancel", {});
    expect(result).toEqual({ code: 200, msg: "success", data: "test" });
  });

  test("HTTP 200 with body code 0 returns data (does not throw)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 0, msg: "ok", result: "ok" }), { status: 200 })) as any;
    const exec = make() as any;
    const result = await exec.signedRequest("GET", "/fapi/v1/account", {});
    expect(result).toEqual({ code: 0, msg: "ok", result: "ok" });
  });

  test("HTTP 200 with body code nonzero (not 200) throws with code attached", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: -1013, msg: "invalid qty" }), { status: 200 })) as any;
    const exec = make() as any;
    try {
      await exec.signedRequest("POST", "/fapi/v1/order", {});
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain("-1013");
      expect(e.code).toBe(-1013);
    }
  });

  test("HTTP 200 with no body code returns data (does not throw)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })) as any;
    const exec = make() as any;
    const result = await exec.signedRequest("GET", "/fapi/v1/openOrders", {});
    expect(result).toEqual({ result: "ok" });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P1 2026-07-29 — order attribution. Manual orders and pre-namespace legacy
// stops exist on the broker, so every conditional order this bot places must
// carry its own namespace, and order cleanup must be TARGETED — the old
// blind `DELETE /fapi/v1/allOpenOrders` sweep canceled protective
// STOP_MARKETs the bot didn't own every time it closed a symbol (reachable
// from the 15s stop-loss loop). Same hardening COIN-M already had.
// Single-system consolidation (2026-07-30): ownership is the `uc-` prefix —
// every id this codebase ever stamped (including the legacy instance-stamped
// `uc-fapi-<hostname>-…` format) is ours and must stay cancelable.
// ══════════════════════════════════════════════════════════════════════════

describe("FAPI client-order-id namespace", () => {
  test("ids are namespaced, deterministic, ≤36 chars; any uc-* id is ours (legacy instance-stamped stops included)", () => {
    const ns = fapiClientIdNamespace();
    expect(ns).toBe("uc-fapi-");
    const id = fapiClientOrderId("stop:BTCUSDT:x");
    expect(id.startsWith(ns)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(36);
    expect(fapiClientOrderId("stop:BTCUSDT:x")).toBe(id); // deterministic per seed

    expect(isBotFapiClientId(id)).toBe(true);
    // MIGRATION: stops placed before the single-system consolidation carry
    // the old `uc-fapi-<hostname>-…` format — still ours, still cancelable.
    expect(isBotFapiClientId("uc-fapi-prodhost-abc")).toBe(true);
    expect(isBotFapiClientId("uc-cert-usdc-abc")).toBe(true); // cert script's — also ours
    expect(isBotFapiClientId("web_x8s")).toBe(false);         // anonymous/manual
    expect(isBotFapiClientId(undefined)).toBe(false);
    expect(isBotFapiClientId(12345)).toBe(false);             // raw numeric algoId
  });

  test("placeStopMarketClose stamps every stop with the deployment namespace by default (an anonymous stop is unattributable and uncancelable-by-owner)", async () => {
    const calls: any[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (method === "POST" && path === "/fapi/v1/order") return { orderId: 1 };
        throw new Error(`unexpected ${method} ${path}`);
      },
    });
    expect(await exec.placeStopMarketClose("BTC/USD", "buy", 90, 1)).toBe(true);
    const order = calls.find((c) => c.path === "/fapi/v1/order");
    expect(String(order?.params.newClientOrderId ?? "").startsWith(fapiClientIdNamespace())).toBe(true);
  });

  test("the -4120 algo fallback carries the same stamp as clientAlgoId", async () => {
    const calls: any[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/fapi/v1/order") { const e = new Error("unsupported") as Error & { code: number }; e.code = -4120; throw e; }
        if (path === "/fapi/v1/algoOrder") return { algoId: 7 };
        throw new Error(`unexpected ${method} ${path}`);
      },
    });
    expect(await exec.placeStopMarketClose("BTC/USD", "buy", 90, 1)).toBe(true);
    const algoCall = calls.find((c) => c.path === "/fapi/v1/algoOrder");
    expect(String(algoCall?.params.clientAlgoId ?? "").startsWith(fapiClientIdNamespace())).toBe(true);
  });

  test("a caller-provided clientOrderId is used verbatim (cert scripts and reconcile paths own their ids)", async () => {
    const calls: any[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (method === "POST" && path === "/fapi/v1/order") return { orderId: 1 };
        throw new Error(`unexpected ${method} ${path}`);
      },
    });
    expect(await exec.placeStopMarketClose("BTC/USD", "buy", 90, 1, "uc-cert-usdc-abc123")).toBe(true);
    const order = calls.find((c) => c.path === "/fapi/v1/order");
    expect(order?.params.newClientOrderId).toBe("uc-cert-usdc-abc123");
  });
});

describe("cancelAllOrders — targeted, namespace-scoped (never a blind /allOpenOrders sweep)", () => {
  const NS = fapiClientIdNamespace();
  // One order of each ownership class, in both stores.
  function fixtures(extraAnon: any[] = []) {
    return {
      openOrders: [
        { orderId: 1, clientOrderId: `${NS}aaa`, type: "STOP_MARKET", reduceOnly: "true", origQty: "1" },           // OURS
        { orderId: 2, clientOrderId: "uc-fapi-prodhost-bbb", type: "STOP_MARKET", reduceOnly: "true", origQty: "2" }, // OURS too — legacy instance-stamped format
        { orderId: 3, clientOrderId: "web_manual", type: "STOP_MARKET", reduceOnly: "true", origQty: "2" },           // anonymous legacy stop
        { orderId: 4, clientOrderId: "web_entry", type: "LIMIT", reduceOnly: "false", origQty: "2" },                 // anonymous NON-stop — NEVER touched
        ...extraAnon,
      ],
      algoOrders: [
        { algoId: 9, clientAlgoId: `${NS}zzz`, orderType: "STOP_MARKET", reduceOnly: true, totalQty: "1" },           // OURS (algo store)
        { algoId: 10, clientAlgoId: "manual-algo", orderType: "STOP_MARKET", reduceOnly: true, totalQty: "3" },       // anonymous legacy (algo)
      ],
    };
  }
  function harness(fx = fixtures()) {
    const calls: Array<{ method: string; path: string; params: any }> = [];
    const exec = make({
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (method === "GET" && path === "/fapi/v1/openOrders") return structuredClone(fx.openOrders);
        if (method === "GET" && path === "/fapi/v1/openAlgoOrders") return structuredClone(fx.algoOrders);
        if (method === "DELETE" && (path === "/fapi/v1/order" || path === "/fapi/v1/algoOrder")) return {};
        // DELETE /fapi/v1/allOpenOrders (the reverted blind sweep) lands here
        // and fails the test loudly.
        throw new Error(`unexpected ${method} ${path}`);
      },
    });
    const deleted = () => calls.filter((c) => c.method === "DELETE");
    return { exec, calls, deleted };
  }

  test("default scope: cancels ONLY our uc-* stamped orders by exact id (legacy instance-stamped format included) — no account-wide sweep, anonymous untouched", async () => {
    const { exec, calls, deleted } = harness();
    await exec.cancelAllOrders("BTC/USD");
    expect(calls.map((c) => `${c.method} ${c.path}`)).not.toContain("DELETE /fapi/v1/allOpenOrders");
    expect(deleted().filter((d) => d.path === "/fapi/v1/order").map((d) => d.params.orderId).sort()).toEqual(["1", "2"]);
    expect(deleted().filter((d) => d.path === "/fapi/v1/algoOrder").map((d) => d.params.algoId)).toEqual(["9"]);
  });

  test("aggregateFlat: also retires anonymous reduceOnly stops (legacy stock, protection-for-nothing) — but never an entry order", async () => {
    const { exec, calls, deleted } = harness();
    await exec.cancelAllOrders("BTC/USD", { aggregateFlat: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).not.toContain("DELETE /fapi/v1/allOpenOrders");
    expect(deleted().filter((d) => d.path === "/fapi/v1/order").map((d) => d.params.orderId).sort()).toEqual(["1", "2", "3"]);
    expect(deleted().filter((d) => d.path === "/fapi/v1/algoOrder").map((d) => d.params.algoId).sort()).toEqual(["10", "9"]);
  });

  test("default scope (aggregate NOT confirmed flat): an anonymous reduceOnly stop survives — it may protect a manual position", async () => {
    const fx = fixtures([{ orderId: 5, clientOrderId: "web_manual2", type: "STOP_MARKET", reduceOnly: "true", origQty: "2" }]);
    const { exec, deleted } = harness(fx);
    await exec.cancelAllOrders("BTC/USD");
    const orderDels = deleted().filter((d) => d.path === "/fapi/v1/order").map((d) => d.params.orderId);
    expect(orderDels).not.toContain("3");
    expect(orderDels).not.toContain("5");
    expect(orderDels).not.toContain("4");
  });

  test("failed enumeration cancels NOTHING — a getOpenOrders error is unknown state, never an empty account", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        calls.push({ method, path });
        throw new Error("exchange 5xx");
      },
    });
    await exec.cancelAllOrders("BTC/USD", { aggregateFlat: true }); // fail-open: must not throw
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });
});

// ── Sandbox-host guard (2026-08-09) ───────────────────────────────────────
// The guard exists so a misconfigured restBase can never trade real money.
// It used to test for the literal substring "testnet", which would have
// REFUSED the very host Binance is migrating the sandbox to
// (demo-fapi.binance.com) — a safety rail that blocks its own migration.
// Deliberately an allowlist: an unknown host must fail CLOSED.
describe("isNonProductionBinanceHost", () => {
  test("accepts the current sandbox host", () => {
    expect(isNonProductionBinanceHost("https://testnet.binancefuture.com")).toBe(true);
  });

  test("accepts the new demo hosts Binance is migrating to", () => {
    expect(isNonProductionBinanceHost("https://demo-fapi.binance.com")).toBe(true);
    expect(isNonProductionBinanceHost("wss://demo-fstream.binance.com")).toBe(true);
  });

  test("REJECTS production — this is the whole point", () => {
    expect(isNonProductionBinanceHost("https://fapi.binance.com")).toBe(false);
    expect(isNonProductionBinanceHost("https://api.binance.com")).toBe(false);
    expect(isNonProductionBinanceHost("https://dapi.binance.com")).toBe(false);
  });

  test("an unknown or empty host fails CLOSED, never open", () => {
    expect(isNonProductionBinanceHost("https://example.com")).toBe(false);
    expect(isNonProductionBinanceHost("")).toBe(false);
    expect(isNonProductionBinanceHost(undefined as any)).toBe(false);
  });

  test("case does not matter — a host is not safe because someone shouted it", () => {
    expect(isNonProductionBinanceHost("HTTPS://TESTNET.BINANCEFUTURE.COM")).toBe(true);
    expect(isNonProductionBinanceHost("HTTPS://FAPI.BINANCE.COM")).toBe(false);
  });
});

// ── User-data WS host derivation (2026-10-02) ──────────────────────────────
// The latent bug this locks out: startUserDataStream chose the WS host with
// `baseUrl.includes("testnet")`, so the DEMO rest base (demo-fapi.binance.com,
// now the default) fell through to MAINNET's fstream.binance.com — a sandbox
// listenKey pointed at the production socket.
describe("resolveUserDataWsHost", () => {
  test("demo rest base NEVER lands on the mainnet socket (the latent bug)", () => {
    const ws = resolveUserDataWsHost("https://demo-fapi.binance.com");
    expect(ws).not.toBe("wss://fstream.binance.com");
    expect(ws).toBe("wss://demo-fstream.binance.com"); // verified live 2026-10-02 (markPriceUpdate stream)
  });

  test("testnet rest base keeps the host this executor has always used", () => {
    expect(resolveUserDataWsHost("https://testnet.binancefuture.com")).toBe("wss://stream.binancefuture.com");
  });

  test("production rest base → production socket (the SDK's WS_STREAMS_PROD constant)", () => {
    expect(resolveUserDataWsHost("https://fapi.binance.com")).toBe("wss://fstream.binance.com");
  });

  test("demo aliases in the sandbox allowlist route to the demo socket", () => {
    expect(resolveUserDataWsHost("https://demo.binance.com")).toBe("wss://demo-fstream.binance.com");
  });
});

// ── init() safety gates (2026-08-09) ──────────────────────────────────────
// AUDIT HOLE 1: preflight() only ever ran for the opt-in USDC/COIN-M
// candidates. The DEFAULT (USDT) instance — built by OrderExecutor for
// momentum_crypto, the sleeve that actually trades — went straight to
// init(), so a production restBase or a hedge-mode account was accepted
// silently. These gates live in init() itself so EVERY construction path
// (bot, scripts, certs) inherits them.
describe("init() safety gates — every instance, not just preflighted ones", () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  test("refuses a production restBase BEFORE any network call — the default USDT instance included", async () => {
    const exec = new BinanceExecutor() as any;
    exec.baseUrl = "https://fapi.binance.com"; // real money
    exec.apiKey = "k"; exec.secretKey = "s";
    let network = 0;
    globalThis.fetch = (async () => { network++; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    exec.signedRequest = async () => { network++; return {}; };
    expect(await exec.init()).toBe(false);
    expect(exec.connectionState).toBe("error");
    expect(exec.isConnected()).toBe(false);
    expect(network).toBe(0); // refused before touching the wire
  });

  // An otherwise fully-working account whose ONLY defect is the one under
  // test — so each refusal below is attributable to its gate alone (remove
  // the gate and init() would succeed, failing the test).
  const workingAccountExecutor = (defect: { dual?: boolean; multi?: boolean }) => {
    const exec = new BinanceExecutor({
      instrumentCatalog: new InstrumentCatalog(async () => ({ symbols: [] })),
    }) as any;
    exec.baseUrl = "https://testnet.binancefuture.com";
    exec.apiKey = "k"; exec.secretKey = "s";
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ serverTime: Date.now() }) })) as unknown as typeof fetch;
    exec.signedRequest = async (_m: string, path: string) => {
      if (path === "/fapi/v2/account") return {
        totalWalletBalance: "1000", totalUnrealizedProfit: "0",
        totalMarginBalance: "1000", availableBalance: "900", canTrade: true,
      };
      if (path === "/fapi/v1/positionSide/dual") return { dualSidePosition: defect.dual ?? false };
      if (path === "/fapi/v1/multiAssetsMargin") return { multiAssetsMargin: defect.multi ?? false };
      if (path === "/fapi/v1/leverage") return {};
      throw new Error(`unexpected ${path}`);
    };
    return exec;
  };

  test("refuses hedge mode (dualSidePosition=true) — reduceOnly closes silently break there", async () => {
    const exec = workingAccountExecutor({ dual: true });
    expect(await exec.init()).toBe(false);
    expect(exec.connectionState).toBe("error");
    expect(exec.isConnected()).toBe(false);
  });

  test("refuses multi-assets margin mode (single-asset margin is a hard assumption)", async () => {
    const exec = workingAccountExecutor({ multi: true });
    expect(await exec.init()).toBe(false);
    expect(exec.connectionState).toBe("error");
    expect(exec.isConnected()).toBe(false);
  });

  test("an UNREADABLE account mode fails CLOSED, never connects blind", async () => {
    const exec = new BinanceExecutor() as any;
    exec.baseUrl = "https://testnet.binancefuture.com";
    exec.apiKey = "k"; exec.secretKey = "s";
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ serverTime: Date.now() }) })) as unknown as typeof fetch;
    exec.signedRequest = async (_m: string, path: string) => {
      if (path === "/fapi/v2/account") return {};
      if (path === "/fapi/v1/positionSide/dual") throw new Error("transport down");
      throw new Error(`unexpected ${path}`);
    };
    expect(await exec.init()).toBe(false);
    expect(exec.isConnected()).toBe(false);
  });

  test("connects when the host is sandbox and the account is one-way + single-asset (prod-shaped happy path)", async () => {
    const exec = new BinanceExecutor({
      instrumentCatalog: new InstrumentCatalog(async () => ({ symbols: [] })),
    }) as any;
    exec.baseUrl = "https://testnet.binancefuture.com";
    exec.apiKey = "k"; exec.secretKey = "s";
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ serverTime: Date.now() }) })) as unknown as typeof fetch;
    exec.signedRequest = async (_m: string, path: string) => {
      if (path === "/fapi/v2/account") return {
        totalWalletBalance: "1000", totalUnrealizedProfit: "0",
        totalMarginBalance: "1000", availableBalance: "900", canTrade: true,
      };
      if (path === "/fapi/v1/positionSide/dual") return { dualSidePosition: false };
      if (path === "/fapi/v1/multiAssetsMargin") return { multiAssetsMargin: false };
      if (path === "/fapi/v1/leverage") return {};
      throw new Error(`unexpected ${path}`);
    };
    expect(await exec.init()).toBe(true);
    expect(exec.isConnected()).toBe(true);
    expect(exec.connectionState).toBe("connected");
  });
});

// ══════════════════════════════════════════════
// Mainnet stop confirmation (OPEN.md P1 — the 2026-07-20 LINK ghost stop)
// ══════════════════════════════════════════════
// The client-side stop evaluates a TESTNET mark that can print prices which
// never existed on real markets. A stop-triggered close (opts.stopConfirm)
// must be confirmed against mainnet before transmitting: enforce blocks a
// ghost, observe only counts, and NO mainnet answer fails OPEN (a mainnet
// outage must never leave a position's stop unexecuted).
describe("closePosition mainnet stop confirmation", () => {
  const savedMode = process.env.BINANCE_STOP_CONFIRM_MODE;
  afterEach(() => {
    if (savedMode === undefined) delete process.env.BINANCE_STOP_CONFIRM_MODE;
    else process.env.BINANCE_STOP_CONFIRM_MODE = savedMode;
  });

  // Real incident series: entry ≈7.956, 4% stop at 7.638, testnet printed
  // 7.8181 on the fill while mainnet traded 8.29–8.36 that hour.
  const LINK_STOP = { entryPrice: 7.956, stopLossPct: 4, triggerPrice: 7.8181 };

  /** signedRequest fake for a full successful close flow (BTCUSDT, the
   *  default seeded catalog symbol) — same shape as the closePosition
   *  suite's late-fill mock above. */
  const fullCloseFlow = (calls: string[]) => async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (path === "/fapi/v2/positionRisk") {
      return calls.filter(c => c === "GET /fapi/v2/positionRisk").length === 1
        ? [{ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
        : [];
    }
    if (method === "POST" && path === "/fapi/v1/order") return { status: "NEW", orderId: 7, avgPrice: "0" };
    if (method === "GET" && path === "/fapi/v1/order") return { status: "FILLED", avgPrice: "95" };
    if (method === "GET" && path === "/fapi/v1/userTrades") return [{ qty: "1", price: "95", commission: "0.1", realizedPnl: "-5", time: "1234" }];
    if (method === "GET" && path === "/fapi/v1/openOrders") return [];
    if (method === "GET" && path === "/fapi/v1/openAlgoOrders") return [];
    throw new Error(`unexpected request ${method} ${path}`);
  };

  test("ENFORCE: the real LINK series is blocked — nothing transmitted, native stop untouched", async () => {
    process.env.BINANCE_STOP_CONFIRM_MODE = "enforce";
    const calls: string[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string) => { calls.push(`${method} ${path}`); throw new Error("must not be reached"); },
    }) as any;
    exec.mainnetMarkPrice = async () => 8.32; // mainnet that hour: 8.29–8.36

    const result = await exec.closePosition("LINK/USD", 314, "buy", { stopConfirm: LINK_STOP });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("proven_failed"); // pre-transmit block — safe for the retry loop
    expect(result.reason).toContain("stop_confirm_rejected");
    expect(calls).toEqual([]); // NO request of any kind: no close, no order cleanup
    expect(exec.getStopConfirmStats()).toMatchObject({ checked: 1, blocked: 1, wouldBlock: 0, confirmed: 0, unavailable: 0 });
  });

  test("ENFORCE: a legitimate stop (mainnet also breaches) closes without friction", async () => {
    process.env.BINANCE_STOP_CONFIRM_MODE = "enforce";
    const calls: string[] = [];
    const exec = make({ signedRequest: fullCloseFlow(calls) }) as any;
    exec.pollDelayMs = 1; exec.closePollTimeoutMs = 20;
    exec.mainnetMarkPrice = async () => 95; // −5% from entry 100: real crash, both venues agree

    const result = await exec.closePosition("BTC/USD", 1, "buy", { stopConfirm: { entryPrice: 100, stopLossPct: 4, triggerPrice: 95.5 } });
    expect(result.success).toBe(true);
    expect(result.filledPrice).toBe(95);
    expect(calls).toContain("POST /fapi/v1/order");
    expect(exec.getStopConfirmStats()).toMatchObject({ checked: 1, confirmed: 1, blocked: 0, wouldBlock: 0, unavailable: 0 });
  });

  // The chosen behavior on an unreachable mainnet is FAIL-OPEN. Tested in
  // both directions of the failure seam (0-return and throw) and in both
  // modes: unavailability may never block, and may never be counted as a
  // rejection.
  test("ENFORCE: mainnet unreachable (returns 0) ⇒ FAIL-OPEN, the close proceeds", async () => {
    process.env.BINANCE_STOP_CONFIRM_MODE = "enforce";
    const calls: string[] = [];
    const exec = make({ signedRequest: fullCloseFlow(calls) }) as any;
    exec.pollDelayMs = 1; exec.closePollTimeoutMs = 20;
    exec.mainnetMarkPrice = async () => 0; // module contract: 0 on any failure

    const result = await exec.closePosition("BTC/USD", 1, "buy", { stopConfirm: { entryPrice: 100, stopLossPct: 4, triggerPrice: 95.5 } });
    expect(result.success).toBe(true);
    expect(calls).toContain("POST /fapi/v1/order");
    expect(exec.getStopConfirmStats()).toMatchObject({ checked: 1, unavailable: 1, blocked: 0, wouldBlock: 0 });
  });

  test("ENFORCE: mainnet seam THROWS ⇒ still FAIL-OPEN, the close proceeds", async () => {
    process.env.BINANCE_STOP_CONFIRM_MODE = "enforce";
    const calls: string[] = [];
    const exec = make({ signedRequest: fullCloseFlow(calls) }) as any;
    exec.pollDelayMs = 1; exec.closePollTimeoutMs = 20;
    exec.mainnetMarkPrice = async () => { throw new Error("mainnet down"); };

    const result = await exec.closePosition("BTC/USD", 1, "buy", { stopConfirm: { entryPrice: 100, stopLossPct: 4 } });
    expect(result.success).toBe(true);
    expect(exec.getStopConfirmStats()).toMatchObject({ checked: 1, unavailable: 1, blocked: 0 });
  });

  test("OBSERVE (default, env unset): a ghost stop is NOT blocked but IS counted as would-block", async () => {
    delete process.env.BINANCE_STOP_CONFIRM_MODE;
    const calls: string[] = [];
    const exec = make({ signedRequest: fullCloseFlow(calls) }) as any;
    exec.pollDelayMs = 1; exec.closePollTimeoutMs = 20;
    exec.mainnetMarkPrice = async () => 100.2; // mainnet in PROFIT vs entry 100 — a ghost trigger

    const result = await exec.closePosition("BTC/USD", 1, "buy", { stopConfirm: { entryPrice: 100, stopLossPct: 4, triggerPrice: 95.9 } });
    expect(result.success).toBe(true); // observe: current prod behavior unchanged
    expect(calls).toContain("POST /fapi/v1/order");
    expect(exec.getStopConfirmStats()).toMatchObject({ checked: 1, wouldBlock: 1, blocked: 0, confirmed: 0 });
  });

  test("OBSERVE: mainnet unreachable ⇒ proceeds, counted unavailable (never a rejection)", async () => {
    delete process.env.BINANCE_STOP_CONFIRM_MODE;
    const calls: string[] = [];
    const exec = make({ signedRequest: fullCloseFlow(calls) }) as any;
    exec.pollDelayMs = 1; exec.closePollTimeoutMs = 20;
    exec.mainnetMarkPrice = async () => 0;

    const result = await exec.closePosition("BTC/USD", 1, "buy", { stopConfirm: { entryPrice: 100, stopLossPct: 4 } });
    expect(result.success).toBe(true);
    expect(exec.getStopConfirmStats()).toMatchObject({ checked: 1, unavailable: 1, wouldBlock: 0, blocked: 0 });
  });

  test("non-stop closes (no stopConfirm opts) never consult mainnet — engine exits are unaffected", async () => {
    process.env.BINANCE_STOP_CONFIRM_MODE = "enforce";
    const calls: string[] = [];
    const exec = make({ signedRequest: fullCloseFlow(calls) }) as any;
    exec.pollDelayMs = 1; exec.closePollTimeoutMs = 20;
    let consulted = false;
    exec.mainnetMarkPrice = async () => { consulted = true; return 0; };

    const result = await exec.closePosition("BTC/USD", 1, "buy");
    expect(result.success).toBe(true);
    expect(consulted).toBe(false);
    expect(exec.getStopConfirmStats()).toMatchObject({ checked: 0 });
  });
});
