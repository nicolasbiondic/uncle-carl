import { describe, test, expect, afterEach } from "bun:test";
import {
  BinanceCoinMExecutor, COINM_SYMBOL_MAP, toCoinMProductSymbol,
  deterministicClientOrderId, computeContracts, positionUsd,
  inversePnlBtc, inversePnlUsdAtExit, COINM_CLIENT_ID_NAMESPACE, isOwnedClientId,
  isNonProductionCoinmHost,
} from "./binance-coinm-executor";
import { fakeCoinMExecutor as make, COINM_EXCHANGE_INFO_FIXTURE as EXCHANGE_INFO_FIXTURE } from "../test-support/binance";

describe("product identity — never FAPI symbols, only BTC/COIN-M", () => {
  test("COINM_SYMBOL_MAP maps exactly one internal symbol", () => {
    expect(COINM_SYMBOL_MAP).toEqual({ "BTC/COIN-M": "BTCUSD_PERP" });
  });
  test("toCoinMProductSymbol rejects the FAPI/linear symbol and raw product symbols", () => {
    expect(toCoinMProductSymbol("BTC/COIN-M")).toBe("BTCUSD_PERP");
    expect(toCoinMProductSymbol("BTC/USD")).toBeNull();      // FAPI linear symbol — must never map
    expect(toCoinMProductSymbol("BTCUSD_PERP")).toBeNull();  // raw product id isn't an internal symbol
    expect(toCoinMProductSymbol("ETH/COIN-M")).toBeNull();   // unsupported product
  });
});

describe("deterministic client order ids", () => {
  test("same seed -> same id, different seed -> different id, bounded length", () => {
    const a = deterministicClientOrderId("open:intent-1");
    const b = deterministicClientOrderId("open:intent-1");
    const c = deterministicClientOrderId("open:intent-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeLessThanOrEqual(36);
    expect(a.startsWith(COINM_CLIENT_ID_NAMESPACE)).toBe(true);
  });

  test("isOwnedClientId matches only the exact namespace, never a foreign/manual id", () => {
    expect(isOwnedClientId(deterministicClientOrderId("stop:x"))).toBe(true);
    expect(isOwnedClientId("leftover")).toBe(false);
    expect(isOwnedClientId("cm-abc")).toBe(false); // NOT the same prefix as the real namespace
    expect(isOwnedClientId(undefined)).toBe(false);
    expect(isOwnedClientId(12345)).toBe(false); // numeric ids (e.g. a raw algoId) are never a client-id match
  });
});

describe("inverse sizing — never quantity*price", () => {
  test("computeContracts floors notional/contractSize; live callers never floor UP to 1", () => {
    expect(computeContracts(10_000, 100)).toBe(100);
    expect(computeContracts(150, 100)).toBe(1);   // floors 1.5 -> 1 (already >= 1, no special-case needed)
    expect(computeContracts(50, 100)).toBe(0);    // sub-one-contract -> REJECT for a live caller (was silently floored to 1)
    expect(computeContracts(0, 100)).toBe(0);
    expect(computeContracts(-5, 100)).toBe(0);
    expect(computeContracts(1000, 0)).toBe(0);
  });

  test("computeContracts floors UP to 1 ONLY with the explicit certification opt-in", () => {
    expect(computeContracts(1, 100, { allowMinimumFloor: true })).toBe(1);
    expect(computeContracts(50, 100, { allowMinimumFloor: true })).toBe(1);
    expect(computeContracts(150, 100, { allowMinimumFloor: true })).toBe(1); // already >=1, flag doesn't change it
    expect(computeContracts(0, 100, { allowMinimumFloor: true })).toBe(0);   // still rejects non-positive notional
  });

  test("positionUsd = |contracts| * contractSize (constant regardless of price)", () => {
    expect(positionUsd(37, 100)).toBe(3700);
    expect(positionUsd(-37, 100)).toBe(3700);
  });

  test("inversePnlBtc/UsdAtExit: long profit, long loss, short profit, short loss", () => {
    // 10 contracts * $100 = $1000 notional. Entry 50,000 -> exit 55,000 (long wins).
    const longBtc = inversePnlBtc("buy", 10, 100, 50_000, 55_000);
    expect(longBtc).toBeCloseTo(1000 * (1 / 50_000 - 1 / 55_000), 10);
    expect(longBtc).toBeGreaterThan(0);
    const longUsd = inversePnlUsdAtExit("buy", 10, 100, 50_000, 55_000);
    expect(longUsd).toBeCloseTo(longBtc * 55_000, 8);

    const longLossUsd = inversePnlUsdAtExit("buy", 10, 100, 55_000, 50_000);
    expect(longLossUsd).toBeLessThan(0);

    const shortWinUsd = inversePnlUsdAtExit("sell", 10, 100, 55_000, 50_000);
    expect(shortWinUsd).toBeGreaterThan(0);
    // short is exactly the mirror of long over the same price move
    expect(inversePnlBtc("sell", 10, 100, 50_000, 55_000)).toBeCloseTo(-longBtc, 10);

    const shortLossUsd = inversePnlUsdAtExit("sell", 10, 100, 50_000, 55_000);
    expect(shortLossUsd).toBeLessThan(0);
  });

  test("degenerate inputs return 0, never NaN/Infinity", () => {
    expect(inversePnlBtc("buy", 10, 100, 0, 50_000)).toBe(0);
    expect(inversePnlBtc("buy", 10, 100, 50_000, 0)).toBe(0);
    expect(inversePnlUsdAtExit("buy", 0, 100, 50_000, 55_000)).toBe(0);
  });
});

describe("exchangeInfo catalog — injectable, cached, validated", () => {
  test("extracts marginAsset/contractSize/PRICE_FILTER/LOT_SIZE/MARKET_LOT_SIZE for BTCUSD_PERP", async () => {
    let calls = 0;
    const exec = make({ fetchExchangeInfoRaw: async () => { calls++; return EXCHANGE_INFO_FIXTURE; } });
    const filters = await exec.getFilters("BTC/COIN-M");
    expect(filters).toEqual({
      status: "TRADING", contractType: "PERPETUAL", marginAsset: "BTC", contractSize: 100,
      tickSize: 0.1, pricePrecision: 1, lotStepSize: 1, lotMinQty: 1, lotMaxQty: 1_000_000,
      marketLotStepSize: 1, marketLotMinQty: 1, marketLotMaxQty: 50_000,
    });
    await exec.getFilters("BTC/COIN-M"); // cached — no second fetch
    expect(calls).toBe(1);
    await exec.getFilters("BTC/COIN-M", { forceRefresh: true });
    expect(calls).toBe(2);
  });

  test("accepts Binance DAPI's official contractStatus field", async () => {
    const row = { ...EXCHANGE_INFO_FIXTURE.symbols[0], contractStatus: "TRADING" } as any;
    delete row.status;
    const exec = make({ fetchExchangeInfoRaw: async () => ({ symbols: [row] }) });
    expect((await exec.getFilters("BTC/COIN-M")).status).toBe("TRADING");
  });

  test("throws when the product isn't TRADING", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], status: "BREAK" }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info });
    await expect(exec.getFilters("BTC/COIN-M")).rejects.toThrow("not TRADING");
  });

  test("throws when a required filter is missing", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], filters: [{ filterType: "PRICE_FILTER", tickSize: "0.1" }] }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info });
    await expect(exec.getFilters("BTC/COIN-M")).rejects.toThrow("missing required filters");
  });

  test("throws when the product isn't in the catalog", async () => {
    const exec = make({ fetchExchangeInfoRaw: async () => ({ symbols: [] }) });
    await expect(exec.getFilters("BTC/COIN-M")).rejects.toThrow("not found");
  });

  test("unsupported internal symbol rejected before any network call", async () => {
    const exec = make({ fetchExchangeInfoRaw: async () => { throw new Error("should not be called"); } });
    await expect(exec.getFilters("ETH/COIN-M")).rejects.toThrow("unsupported COIN-M symbol");
  });

  // 2026-07-19: strict DAPI spec validation. TRADING + PERPETUAL + BTC
  // marginAsset + every filter bound positive (tick/lot/market min AND max)
  // — a malformed or wrong-asset row must never silently pass as usable.
  test("rejects a non-PERPETUAL contractType (e.g. a quarterly delivery contract)", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], contractType: "CURRENT_QUARTER" }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info });
    await expect(exec.getFilters("BTC/COIN-M")).rejects.toThrow("not PERPETUAL");
  });

  test("rejects a wrong/malformed marginAsset (must be exactly BTC, not merely truthy)", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], marginAsset: "USDT" }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info });
    await expect(exec.getFilters("BTC/COIN-M")).rejects.toThrow("marginAsset must be BTC");
  });

  test("rejects a non-positive PRICE_FILTER.tickSize", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], filters: [
      { filterType: "PRICE_FILTER", tickSize: "0" },
      { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "1000000" },
      { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "50000" },
    ] }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info });
    await expect(exec.getFilters("BTC/COIN-M")).rejects.toThrow(/positive/);
  });

  test("rejects a missing/non-positive LOT_SIZE.maxQty (below-one/malformed max never silently defaults)", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" }, // maxQty missing
      { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "50000" },
    ] }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info });
    await expect(exec.getFilters("BTC/COIN-M")).rejects.toThrow(/malformed numeric field/);
  });

  test("rejects a non-positive MARKET_LOT_SIZE.maxQty", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "1000000" },
      { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "0" },
    ] }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info });
    await expect(exec.getFilters("BTC/COIN-M")).rejects.toThrow(/positive/);
  });
});

describe("marketLotViolation — max contracts is enforced, never just min/step", () => {
  test("placeMarketOrder rejects contracts above MARKET_LOT_SIZE maxQty before any order network call", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "1000000" },
      { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "100" },
    ] }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info, signedRequest: async () => { throw new Error("should not be called"); } });
    await expect(exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 101, intentId: "lot-max" }))
      .rejects.toThrow("MARKET_LOT_SIZE maxQty");
  });
});

describe("routing — every signed call hits /dapi/*, never /fapi/*", () => {
  test("getPositions and getBalanceBtc route through /dapi/v1/*", async () => {
    const paths: string[] = [];
    const exec = make({
      signedRequest: async (_m: string, path: string) => { paths.push(path); return path.includes("positionRisk") ? [] : { asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }; },
    });
    await exec.getPositions("BTC/COIN-M");
    await exec.getBalanceBtc().catch(() => {}); // fixture above isn't an array for balance; error is fine, path still recorded
    expect(paths.every(p => p.startsWith("/dapi/"))).toBe(true);
    expect(paths.some(p => p.includes("/fapi/"))).toBe(false);
  });
});

describe("ownership isolation — BTCUSD_PERP only, even if the broker/mocked response leaks a sibling", () => {
  test("getPositions filters out non-BTCUSD_PERP rows when queried by symbol", async () => {
    const exec = make({
      signedRequest: async () => ([
        { symbol: "BTCUSD_PERP", positionAmt: "5", entryPrice: "50000", markPrice: "51000", unRealizedProfit: "0.01", leverage: "2", updateTime: "1" },
        { symbol: "ETHUSD_PERP", positionAmt: "3", entryPrice: "3000", markPrice: "3100", unRealizedProfit: "0.02", leverage: "2", updateTime: "1" },
      ]),
    });
    const positions = await exec.getPositions("BTC/COIN-M");
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("BTCUSD_PERP");
  });

  test("getOwnedPosition never returns a foreign product", async () => {
    const exec = make({
      signedRequest: async () => ([{ symbol: "ETHUSD_PERP", positionAmt: "3", entryPrice: "3000", markPrice: "3100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]),
    });
    expect(await exec.getOwnedPosition()).toBeNull();
  });

  test("getOwnedPosition PROPAGATES a transport/read failure — never coerces it to null (unknown state, not flat)", async () => {
    const exec = make({ signedRequest: async () => { throw new Error("ECONNRESET"); } });
    await expect(exec.getOwnedPosition()).rejects.toThrow("ECONNRESET");
  });
});

describe("equity — BTC marginBalance converted at mark price, not quantity*price", () => {
  test("parses premiumIndex's real array response", async () => {
    const exec = make({});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { symbol: "BTCUSD_PERP", markPrice: "64660.00000000" },
    ]), { status: 200 })) as any;
    try {
      expect(await (exec as any).fetchMarkPriceRaw("BTCUSD_PERP")).toBe(64_660);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getEquityUsd = (walletBalance + crossUnPnl) * markPrice", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        expect(path).toBe("/dapi/v1/balance");
        return [{ asset: "BTC", balance: "1.5", crossUnPnl: "0.1", availableBalance: "1.2" }];
      },
      fetchMarkPriceRaw: async () => 60_000,
    });
    expect(await exec.getEquityUsd()).toBeCloseTo(1.6 * 60_000, 6);
  });

  test("throws (fail-closed) when no mark price is available", async () => {
    const exec = make({
      signedRequest: async () => [{ asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }],
      fetchMarkPriceRaw: async () => 0,
    });
    await expect(exec.getEquityUsd()).rejects.toThrow("no BTC mark price");
  });
});

describe("placeMarketOrder — timeout -> query-by-client-id, no duplicate POST", () => {
  test("polls to FILLED via GET after the initial POST returns NEW", async () => {
    let posts = 0, gets = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string, params: any) => {
        if (method === "POST") { posts++; return { orderId: 1, status: "NEW", avgPrice: "0", executedQty: "0" }; }
        if (path === "/dapi/v1/positionRisk") return []; // pre-submit exposure snapshot — flat
        gets++;
        expect(path).toBe("/dapi/v1/order");
        expect(params.origClientOrderId).toBeDefined();
        return gets >= 2 ? { orderId: 1, status: "FILLED", avgPrice: "50000", executedQty: "10" } : { orderId: 1, status: "NEW" };
      },
    });
    exec.isConnected = () => true;
    (exec as any).connected = true;
    const result = await exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 10, intentId: "abc" });
    expect(result).toEqual({ orderId: 1, clientOrderId: deterministicClientOrderId("open:abc"), status: "FILLED", avgPrice: 50000, executedQty: 10 });
    expect(posts).toBe(1); // exactly one POST — every retry is a GET
  });

  test("returns null (never fabricates a fill) when FILLED never confirms within the deadline", async () => {
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (_method: string, path: string) => path === "/dapi/v1/positionRisk" ? [] : { orderId: 2, status: "NEW" },
    });
    const result = await exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 5, intentId: "timeout-case" });
    expect(result).toBeNull();
  });

  test("duplicate clientOrderId (-4015) queries the existing order instead of posting again", async () => {
    let posts = 0, gets = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (method === "POST") {
          posts++;
          const err = new Error("Duplicate clientOrderId") as any; err.code = -4015; throw err;
        }
        if (path === "/dapi/v1/positionRisk") return [];
        gets++;
        return { orderId: 3, status: "FILLED", avgPrice: "50000", executedQty: "5" };
      },
    });
    const result = await exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "sell", contracts: 5, intentId: "dup" });
    expect(result?.status).toBe("FILLED");
    expect(posts).toBe(1); // never retried the POST
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  test("rejects non-integer or <1 contracts before any network call", async () => {
    const exec = make({ signedRequest: async () => { throw new Error("should not be called"); } });
    await expect(exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 0, intentId: "x" })).rejects.toThrow("positive integer");
    await expect(exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 1.5, intentId: "x" })).rejects.toThrow("positive integer");
  });

  test("ambiguous submit error (no Binance error code — e.g. a transport failure) reconciles via query, never throws blindly", async () => {
    let posts = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (method === "POST") { posts++; throw new Error("socket hang up"); }
        if (path === "/dapi/v1/positionRisk") return [];
        return { orderId: 4, status: "FILLED", avgPrice: "50000", executedQty: "7" };
      },
    });
    const result = await exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 7, intentId: "ambiguous" });
    expect(result?.status).toBe("FILLED");
    expect(posts).toBe(1); // never retried the POST
  });

  test("propagates the original ambiguous error when the order genuinely never reached Binance (reconcile query also fails)", async () => {
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string) => {
        if (method === "POST") throw new Error("connection refused");
        throw new Error("order does not exist");
      },
    });
    await expect(exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 3, intentId: "never-sent" }))
      .rejects.toThrow("connection refused");
  });

  test("timeout with a partial fill cancels the exact residual and recovers the ACTUAL filled qty, never null", async () => {
    const calls: any[] = [];
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/dapi/v1/positionRisk") return [];
        if (method === "DELETE") return { orderId: 8, status: "CANCELED" };
        if (method === "POST") return { orderId: 8, status: "NEW" };
        const deleted = calls.some(c => c.method === "DELETE");
        return deleted
          ? { orderId: 8, status: "CANCELED", avgPrice: "50000", executedQty: "4" } // Binance reports a canceled residual's partial fill this way
          : { orderId: 8, status: "NEW", avgPrice: "0", executedQty: "0" };
      },
    });
    const result = await exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 10, intentId: "partial-timeout" });
    expect(result).toEqual({ orderId: 8, clientOrderId: deterministicClientOrderId("open:partial-timeout"), status: "CANCELED", avgPrice: 50000, executedQty: 4 });
    expect(calls.some(c => c.method === "DELETE" && c.params.origClientOrderId === deterministicClientOrderId("open:partial-timeout"))).toBe(true);
  });
});

describe("placeMarketOrder / closePosition — MARKET_LOT_SIZE validation", () => {
  test("placeMarketOrder rejects contracts below MARKET_LOT_SIZE minQty before any order network call", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "1000000" },
      { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "5", maxQty: "50000" },
    ] }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info, signedRequest: async () => { throw new Error("should not be called"); } });
    await expect(exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 2, intentId: "lot-min" }))
      .rejects.toThrow("MARKET_LOT_SIZE minQty");
  });

  test("placeMarketOrder rejects contracts not a multiple of MARKET_LOT_SIZE stepSize", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "1000000" },
      { filterType: "MARKET_LOT_SIZE", stepSize: "2", minQty: "2", maxQty: "50000" },
    ] }] };
    const exec = make({ fetchExchangeInfoRaw: async () => info, signedRequest: async () => { throw new Error("should not be called"); } });
    await expect(exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 3, intentId: "lot-step" }))
      .rejects.toThrow("MARKET_LOT_SIZE stepSize");
  });

  test("closePosition rejects a lot-size violation without ever submitting", async () => {
    const info = { symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "1000000" },
      { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "5", maxQty: "50000" },
    ] }] };
    let posted = false;
    const exec = make({
      fetchExchangeInfoRaw: async () => info,
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") return [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        if (method === "POST") posted = true;
        return { orderId: 1 };
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 2, "buy", "lot-close");
    expect(result.success).toBe(false);
    expect(posted).toBe(false);
  });
});

describe("placeMarketOrder — ambiguous failure never silently drops real exposure", () => {
  test("submit AND reconcile-by-id both fail, but the broker position moved -> recovers the ACTUAL exposure instead of throwing blind", async () => {
    let posCalls = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") {
          posCalls++;
          return posCalls === 1 ? [] : [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "51000", markPrice: "51200", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        }
        if (method === "POST") throw new Error("socket hang up");
        throw new Error("order does not exist"); // the deterministic-id requery ALSO fails
      },
    });
    const result = await exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 10, intentId: "orphan-recover" });
    expect(result).toEqual({ orderId: "unknown", clientOrderId: "unknown", status: "ORPHAN_RECOVERED", avgPrice: 51000, executedQty: 10 });
  });

  test("submit AND reconcile-by-id both fail, position unchanged -> propagates the original error (nothing was silently dropped)", async () => {
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") return []; // flat before AND after — nothing happened
        if (method === "POST") throw new Error("connection refused");
        throw new Error("order does not exist");
      },
    });
    await expect(exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 10, intentId: "no-op" }))
      .rejects.toThrow("connection refused");
  });

  test("recovered exposure with NO recoverable price still reports the ACTUAL qty (never returns null when contracts are live)", async () => {
    let posCalls = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      fetchMarkPriceRaw: async () => 0, // mark price ALSO unavailable
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") {
          posCalls++;
          return posCalls === 1 ? [] : [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "0", markPrice: "0", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        }
        if (method === "POST") throw new Error("socket hang up");
        throw new Error("order does not exist");
      },
    });
    const result = await exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 10, intentId: "orphan-no-price" });
    expect(result).toEqual({ orderId: "unknown", clientOrderId: "unknown", status: "ORPHAN_UNRECOVERABLE_PRICE", avgPrice: 0, executedQty: 10 });
  });

  test("poll cancel/query never reaches a terminal state, but the position moved -> recovers instead of returning null", async () => {
    let posCalls = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (_method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") {
          posCalls++;
          return posCalls === 1 ? [] : [{ symbol: "BTCUSD_PERP", positionAmt: "5", entryPrice: "52000", markPrice: "52100", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        }
        // Order side never reaches a terminal status, even after the cancel attempt (e.g. a wedged/lost order record).
        return { orderId: 9, status: "PENDING_CANCEL" };
      },
    });
    const result = await exec.placeMarketOrder({ internalSymbol: "BTC/COIN-M", side: "buy", contracts: 5, intentId: "wedged" });
    expect(result).toEqual({ orderId: "unknown", clientOrderId: "unknown", status: "ORPHAN_RECOVERED", avgPrice: 52000, executedQty: 5 });
  });
});

describe("native STOP_MARKET — primary /dapi/v1/order, current algoOrder fallback on -4120", () => {
  test("primary path: reduceOnly STOP_MARKET with correct params", async () => {
    const seen: any[] = [];
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string, params: any) => {
        seen.push({ method, path, params });
        return { orderId: 9 };
      },
    });
    const res = await exec.placeStopMarketClose("BTC/COIN-M", "buy", 48_000, 10, "stop-1");
    expect(res.ok).toBe(true);
    expect(res.kind).toBe("order");
    const call = seen.find(s => s.path === "/dapi/v1/order");
    expect(call.params).toMatchObject({
      symbol: "BTCUSD_PERP", side: "SELL", type: "STOP_MARKET", stopPrice: "48000.0",
      quantity: "10", workingType: "MARK_PRICE", reduceOnly: "true",
    });
    expect(call.params.newClientOrderId).toBe(deterministicClientOrderId("stop:stop-1"));
  });

  test("falls back to /dapi/v1/algoOrder (CONDITIONAL) on -4120", async () => {
    const seen: any[] = [];
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string, params: any) => {
        seen.push({ method, path, params });
        if (path === "/dapi/v1/order") { const e = new Error("algo required") as any; e.code = -4120; throw e; }
        return { algoId: "algo-77" };
      },
    });
    const res = await exec.placeStopMarketClose("BTC/COIN-M", "sell", 52_000, 4, "stop-2");
    expect(res).toEqual({ ok: true, kind: "algo", id: "algo-77" });
    const algoCall = seen.find(s => s.path === "/dapi/v1/algoOrder");
    expect(algoCall.params).toMatchObject({
      algoType: "CONDITIONAL", symbol: "BTCUSD_PERP", side: "BUY", type: "STOP_MARKET",
      triggerPrice: "52000.0", quantity: "4", reduceOnly: "true", workingType: "MARK_PRICE",
    });
  });

  test("cancelActiveStop is an exact product-scoped DELETE, no sweep", async () => {
    const calls: any[] = [];
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        return { orderId: 9 };
      },
    });
    await exec.placeStopMarketClose("BTC/COIN-M", "buy", 48_000, 10, "stop-3");
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(true);
    const ok = await exec.cancelActiveStop("BTC/COIN-M");
    expect(ok).toBe(true);
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(false);
    const del = calls.find(c => c.method === "DELETE");
    expect(del).toMatchObject({ path: "/dapi/v1/order", params: { symbol: "BTCUSD_PERP" } });
  });

  test("cancelActiveStop with nothing tracked and no exchange leftover is a no-op success", async () => {
    const exec = make({ signedRequest: async (_m: string, path: string) => (path.includes("open") ? [] : { orderId: 1 }) });
    expect(await exec.cancelActiveStop("BTC/COIN-M")).toBe(true);
  });

  test("ambiguous submit error (no code) on the primary stop endpoint reconciles via query instead of failing", async () => {
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (method === "POST" && path === "/dapi/v1/order") throw new Error("socket hang up");
        if (method === "GET" && path === "/dapi/v1/order") return { orderId: 20, status: "NEW" };
        throw new Error(`unexpected ${method} ${path}`);
      },
    });
    const res = await exec.placeStopMarketClose("BTC/COIN-M", "buy", 48_000, 5, "amb-stop");
    expect(res).toEqual({ ok: true, kind: "order", id: deterministicClientOrderId("stop:amb-stop") });
  });

  test("floors a non-tick-aligned stopPrice down to the nearest PRICE_FILTER.tickSize (0.25)", async () => {
    const info = { symbols: [{
      ...EXCHANGE_INFO_FIXTURE.symbols[0], pricePrecision: 2,
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.25" },
        { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "1000000" },
        { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "50000" },
      ],
    }] };
    const seen: any[] = [];
    const exec = make({
      fetchExchangeInfoRaw: async () => info,
      signedRequest: async (method: string, path: string, params: any) => { seen.push({ method, path, params }); return { orderId: 1 }; },
    });
    await exec.placeStopMarketClose("BTC/COIN-M", "buy", 48_000.30, 5, "tick-1");
    const call = seen.find(s => s.path === "/dapi/v1/order");
    // 48000.30 / 0.25 = 192001.2 -> floor 192001 -> * 0.25 = 48000.25
    expect(call.params.stopPrice).toBe("48000.25");
  });
});

describe("cancelActiveStop — falls back to a live exchange query when nothing is tracked in memory", () => {
  test("finds and cancels an untracked owned stop left over from a prior process (e.g. after a restart)", async () => {
    const calls: any[] = [];
    const ownedId = deterministicClientOrderId("stop:leftover-1");
    const exec = make({
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: ownedId }];
        if (path === "/dapi/v1/openAlgoOrders") return [];
        return { orderId: 1 };
      },
    });
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(false); // nothing tracked in memory
    const ok = await exec.cancelActiveStop("BTC/COIN-M");
    expect(ok).toBe(true);
    const del = calls.find(c => c.method === "DELETE");
    expect(del).toMatchObject({ path: "/dapi/v1/order", params: { symbol: "BTCUSD_PERP", origClientOrderId: ownedId } });
  });

  test("ignores a leftover stop belonging to a sibling product — reports nothing owned to cancel", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") return [{ symbol: "ETHUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: deterministicClientOrderId("stop:foreign-product") }];
        if (path === "/dapi/v1/openAlgoOrders") return [];
        return { orderId: 1 };
      },
    });
    expect(await exec.cancelActiveStop("BTC/COIN-M")).toBe(true);
  });

  test("ignores a same-product reduceOnly STOP_MARKET with a foreign/manual clientOrderId — never adopted or canceled", async () => {
    const calls: any[] = [];
    const exec = make({
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: "manually-placed-by-a-human" }];
        if (path === "/dapi/v1/openAlgoOrders") return [];
        return { orderId: 1 };
      },
    });
    expect(await exec.listOwnedStops("BTC/COIN-M")).toEqual([]);
    expect(await exec.cancelActiveStop("BTC/COIN-M")).toBe(true); // no-op: nothing owned to cancel
    expect(calls.some(c => c.method === "DELETE")).toBe(false); // the foreign stop is never touched
  });
});

describe("queryOwnedStops / listOwnedStops — real DAPI algo-order shape (orderType/algoStatus/reduceOnly)", () => {
  test("matches an open algo stop by orderType + algoStatus (WORKING), reduceOnly as a real boolean, owned clientAlgoId", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") return [];
        if (path === "/dapi/v1/openAlgoOrders") return [{
          algoId: 555, symbol: "BTCUSD_PERP", side: "SELL", positionSide: "BOTH",
          totalQty: "10", executedQty: "0", orderType: "STOP_MARKET", triggerPrice: "51000",
          algoStatus: "WORKING", reduceOnly: true, clientAlgoId: deterministicClientOrderId("stop:algo-owned-1"),
        }];
        return { orderId: 1 };
      },
    });
    const owned = await exec.listOwnedStops("BTC/COIN-M");
    expect(owned).toEqual([{ kind: "algo", id: "555", side: "SELL", quantity: 10, triggerPrice: 51000 }]);
  });

  test("excludes an algo order with a foreign/manual clientAlgoId even though type/status/reduceOnly all match", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") return [];
        if (path === "/dapi/v1/openAlgoOrders") return [{
          algoId: 559, symbol: "BTCUSD_PERP", orderType: "STOP_MARKET",
          algoStatus: "WORKING", reduceOnly: true, clientAlgoId: "some-other-bots-stop",
        }];
        return { orderId: 1 };
      },
    });
    expect(await exec.listOwnedStops("BTC/COIN-M")).toEqual([]);
  });

  test("excludes an algo order in a TERMINAL algoStatus (CANCELLED) even though it's still STOP_MARKET/reduceOnly", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") return [];
        if (path === "/dapi/v1/openAlgoOrders") return [{
          algoId: 556, symbol: "BTCUSD_PERP", orderType: "STOP_MARKET", algoStatus: "CANCELLED", reduceOnly: true,
        }];
        return { orderId: 1 };
      },
    });
    expect(await exec.listOwnedStops("BTC/COIN-M")).toEqual([]);
  });

  test("excludes a non-reduceOnly algo order and a non-STOP orderType", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") return [];
        if (path === "/dapi/v1/openAlgoOrders") return [
          { algoId: 557, symbol: "BTCUSD_PERP", orderType: "STOP_MARKET", algoStatus: "WORKING", reduceOnly: false },
          { algoId: 558, symbol: "BTCUSD_PERP", orderType: "LIMIT", algoStatus: "WORKING", reduceOnly: true },
        ];
        return { orderId: 1 };
      },
    });
    expect(await exec.listOwnedStops("BTC/COIN-M")).toEqual([]);
  });

  test("listOwnedStops is read-only — never mutates (no DELETE call) even when it finds an owned stop", async () => {
    let deleted = false;
    const ownedId = deterministicClientOrderId("stop:readonly-check");
    const exec = make({
      signedRequest: async (method: string, path: string) => {
        if (method === "DELETE") deleted = true;
        if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: ownedId, side: "SELL", origQty: "3", stopPrice: "47000" }];
        if (path === "/dapi/v1/openAlgoOrders") return [];
        return { orderId: 1 };
      },
    });
    const owned = await exec.listOwnedStops("BTC/COIN-M");
    expect(owned).toEqual([{ kind: "order", id: ownedId, side: "SELL", quantity: 3, triggerPrice: 47000 }]);
    expect(deleted).toBe(false);
  });
});

describe("queryOwnedStops / listOwnedStops — unknown state must THROW, never a partial/empty list", () => {
  test("openOrders transport failure throws — never silently degrades to an empty list", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") throw new Error("ETIMEDOUT");
        if (path === "/dapi/v1/openAlgoOrders") return [];
        return { orderId: 1 };
      },
    });
    await expect(exec.listOwnedStops("BTC/COIN-M")).rejects.toThrow("ETIMEDOUT");
  });

  test("openAlgoOrders transport failure throws — even when openOrders succeeded", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") return [];
        if (path === "/dapi/v1/openAlgoOrders") throw new Error("ECONNRESET");
        return { orderId: 1 };
      },
    });
    await expect(exec.listOwnedStops("BTC/COIN-M")).rejects.toThrow("ECONNRESET");
  });

  test("malformed openOrders payload (not an array) throws — never coerced to empty", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") return { msg: "unexpected shape" };
        if (path === "/dapi/v1/openAlgoOrders") return [];
        return { orderId: 1 };
      },
    });
    await expect(exec.listOwnedStops("BTC/COIN-M")).rejects.toThrow("openOrders malformed response");
  });

  test("malformed openAlgoOrders payload (neither an array nor {orders: [...]}) throws — never coerced to empty", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") return [];
        if (path === "/dapi/v1/openAlgoOrders") return { msg: "unexpected shape" };
        return { orderId: 1 };
      },
    });
    await expect(exec.listOwnedStops("BTC/COIN-M")).rejects.toThrow("openAlgoOrders malformed response");
  });

  test("cancelActiveStop: nothing tracked in memory and the owned-stop query fails -> reports FAILURE, never a false 'nothing to cancel'", async () => {
    const exec = make({
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/openOrders") throw new Error("ETIMEDOUT");
        return [];
      },
    });
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(false);
    expect(await exec.cancelActiveStop("BTC/COIN-M")).toBe(false);
  });

  test("ensureLiveStop: owned-stop query fails -> reports UNPROTECTED (false), never blindly attempts a cancel+replace on unknown state", async () => {
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/openOrders") throw new Error("ETIMEDOUT");
        if (method === "DELETE") throw new Error("should not be called");
        if (method === "POST") throw new Error("should not be called");
        return [];
      },
    });
    const position = { symbol: "BTCUSD_PERP", positionAmt: 5, entryPrice: 50_000, markPrice: 50_500, unrealizedProfit: 0, leverage: 2, updateTime: 1 };
    expect(await exec.ensureLiveStop("BTC/COIN-M", position, 48_000)).toBe(false);
  });
});

describe("init() — certification's non-mutating precheck seam", () => {
  test("skipStartupStopReconcile:true never cancels/adopts a pre-existing owned stop", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s" }) as any;
    exec.getServerTimeRaw = async () => Date.now();
    exec.fetchExchangeInfoRaw = async () => EXCHANGE_INFO_FIXTURE;
    let deleteCalled = false;
    const ownedId = deterministicClientOrderId("stop:pre-existing");
    exec.signedRequest = async (method: string, path: string) => {
      if (path === "/dapi/v1/balance") return [{ asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }];
      if (path === "/dapi/v1/positionRisk") return []; // flat
      if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: ownedId }];
      if (path === "/dapi/v1/openAlgoOrders") return [];
      if (method === "DELETE") { deleteCalled = true; return {}; }
      return {};
    };
    expect(await exec.init({ skipStartupStopReconcile: true })).toBe(true);
    expect(deleteCalled).toBe(false); // the mutating reconcile never ran
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(false); // and nothing was silently adopted either
    // The real state is still visible via the read-only precheck seam:
    expect(await exec.listOwnedStops("BTC/COIN-M")).toEqual([{ kind: "order", id: ownedId, side: "", quantity: 0, triggerPrice: 0 }]);
  });

  test("default (no opts) behaves exactly as before — still cancels an orphaned flat-account stop", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s" }) as any;
    exec.getServerTimeRaw = async () => Date.now();
    exec.fetchExchangeInfoRaw = async () => EXCHANGE_INFO_FIXTURE;
    let deleteCalled = false;
    exec.signedRequest = async (method: string, path: string) => {
      if (path === "/dapi/v1/balance") return [{ asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }];
      if (path === "/dapi/v1/positionRisk") return [];
      if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: deterministicClientOrderId("stop:orphan") }];
      if (path === "/dapi/v1/openAlgoOrders") return [];
      if (method === "DELETE") { deleteCalled = true; return {}; }
      return {};
    };
    expect(await exec.init()).toBe(true);
    expect(deleteCalled).toBe(true);
  });

  test("default (no opts) never adopts/cancels a foreign/manual stop even when the account is flat", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s" }) as any;
    exec.getServerTimeRaw = async () => Date.now();
    exec.fetchExchangeInfoRaw = async () => EXCHANGE_INFO_FIXTURE;
    let deleteCalled = false;
    exec.signedRequest = async (method: string, path: string) => {
      if (path === "/dapi/v1/balance") return [{ asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }];
      if (path === "/dapi/v1/positionRisk") return [];
      if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: "manually-placed-by-a-human" }];
      if (path === "/dapi/v1/openAlgoOrders") return [];
      if (method === "DELETE") { deleteCalled = true; return {}; }
      return {};
    };
    expect(await exec.init()).toBe(true);
    expect(deleteCalled).toBe(false); // not ours — never touched
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(false);
  });
});

describe("startup reconcile (wired into init) — adopt an owned stop when live, cancel it when flat", () => {
  test("adopts a pre-existing owned stop instead of canceling it when a position is live", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s" }) as any;
    exec.getServerTimeRaw = async () => Date.now();
    exec.fetchExchangeInfoRaw = async () => EXCHANGE_INFO_FIXTURE;
    let deleteCalled = false;
    exec.signedRequest = async (method: string, path: string) => {
      if (path === "/dapi/v1/balance") return [{ asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }];
      if (path === "/dapi/v1/positionRisk") return [{ symbol: "BTCUSD_PERP", positionAmt: "5", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
      if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: deterministicClientOrderId("stop:adopt-me") }];
      if (path === "/dapi/v1/openAlgoOrders") return [];
      if (method === "DELETE") { deleteCalled = true; return {}; }
      return {};
    };
    expect(await exec.init()).toBe(true);
    expect(deleteCalled).toBe(false); // never canceled — it's protecting a live position
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(true);
  });

  test("cancels an orphaned owned stop left over from a prior session when the account is flat", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s" }) as any;
    exec.getServerTimeRaw = async () => Date.now();
    exec.fetchExchangeInfoRaw = async () => EXCHANGE_INFO_FIXTURE;
    const deletes: any[] = [];
    const ownedId = deterministicClientOrderId("stop:orphan-1");
    exec.signedRequest = async (method: string, path: string, params: any) => {
      if (path === "/dapi/v1/balance") return [{ asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }];
      if (path === "/dapi/v1/positionRisk") return [];
      if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: ownedId }];
      if (path === "/dapi/v1/openAlgoOrders") return [];
      if (method === "DELETE") { deletes.push(params); return {}; }
      return {};
    };
    expect(await exec.init()).toBe(true);
    expect(deletes).toEqual([{ symbol: "BTCUSD_PERP", origClientOrderId: ownedId }]);
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(false);
  });

  test("owned stop present but the position read THROWS — init fails closed, stop is never cancelled or adopted", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s" }) as any;
    exec.getServerTimeRaw = async () => Date.now();
    exec.fetchExchangeInfoRaw = async () => EXCHANGE_INFO_FIXTURE;
    let deleteCalled = false;
    let positionRiskCalls = 0;
    const ownedId = deterministicClientOrderId("stop:unknown-state");
    exec.signedRequest = async (method: string, path: string) => {
      if (path === "/dapi/v1/balance") return [{ asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }];
      if (path === "/dapi/v1/positionRisk") {
        positionRiskCalls++;
        // First read (init's own startup log) succeeds flat; the SECOND
        // read (inside reconcileStartupStops, deciding adopt-vs-cancel for
        // the owned stop below) fails — a transport blip, not a genuine
        // flat account.
        if (positionRiskCalls === 1) return [];
        throw new Error("ETIMEDOUT");
      }
      if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: ownedId }];
      if (path === "/dapi/v1/openAlgoOrders") return [];
      if (method === "DELETE") { deleteCalled = true; return {}; }
      return {};
    };
    expect(await exec.init()).toBe(false); // fails closed — never starts blind to the stop's real purpose
    expect(exec.isConnected()).toBe(false);
    expect(deleteCalled).toBe(false); // never cancelled on an unknown/ambiguous read
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(false); // never adopted either
  });

  test("the owned-stop query itself (openOrders) FAILS during reconcile — init fails closed, never coerced to 'no owned stops'", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s" }) as any;
    exec.getServerTimeRaw = async () => Date.now();
    exec.fetchExchangeInfoRaw = async () => EXCHANGE_INFO_FIXTURE;
    let deleteCalled = false;
    exec.signedRequest = async (method: string, path: string) => {
      if (path === "/dapi/v1/balance") return [{ asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }];
      if (path === "/dapi/v1/positionRisk") return []; // flat — irrelevant, the query below fails first
      if (path === "/dapi/v1/openOrders") throw new Error("ETIMEDOUT");
      if (path === "/dapi/v1/openAlgoOrders") return [];
      if (method === "DELETE") { deleteCalled = true; return {}; }
      return {};
    };
    expect(await exec.init()).toBe(false); // fails closed — an unreadable owned-stop query must never be treated as "clean"
    expect(exec.isConnected()).toBe(false);
    expect(deleteCalled).toBe(false);
  });

  test("a live position with only a FOREIGN stop present is left unprotected by this reconcile (never adopts a stop it doesn't own)", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s" }) as any;
    exec.getServerTimeRaw = async () => Date.now();
    exec.fetchExchangeInfoRaw = async () => EXCHANGE_INFO_FIXTURE;
    exec.signedRequest = async (_method: string, path: string) => {
      if (path === "/dapi/v1/balance") return [{ asset: "BTC", balance: "1", crossUnPnl: "0", availableBalance: "1" }];
      if (path === "/dapi/v1/positionRisk") return [{ symbol: "BTCUSD_PERP", positionAmt: "5", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
      if (path === "/dapi/v1/openOrders") return [{ symbol: "BTCUSD_PERP", type: "STOP_MARKET", reduceOnly: "true", clientOrderId: "manually-placed-by-a-human" }];
      if (path === "/dapi/v1/openAlgoOrders") return [];
      return {};
    };
    expect(await exec.init()).toBe(true);
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(false); // not ours — never adopted
  });
});

describe("closePosition — convergence-verified, no fabricated price", () => {
  test("converges via broker position reduction even if order status lags", async () => {
    let posCalls = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") {
          posCalls++;
          // before: 10 contracts open; after the close, reduced to 0.
          return posCalls === 1
            ? [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
            : [];
        }
        if (method === "POST") return { orderId: 5, status: "NEW" };
        return { orderId: 5, status: "NEW", avgPrice: "50500", executedQty: "10" }; // order status never says FILLED
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "close-1");
    expect(result).toEqual({ success: true, filledPrice: 50500, executedQty: 10, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" });
  });

  test("returns success:false when flat before the close (nothing to close)", async () => {
    const exec = make({ signedRequest: async (_m: string, path: string) => path === "/dapi/v1/positionRisk" ? [] : { orderId: 1 } });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "close-2");
    expect(result.success).toBe(false);
  });

  test("does not fabricate a price when convergence never happens", async () => {
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") return [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        if (method === "POST") return { orderId: 6, status: "NEW" };
        return { orderId: 6, status: "NEW" };
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "close-3");
    expect(result).toEqual({ success: false, filledPrice: 0, executedQty: 0, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" });
  });

  test("timeout with a partial reduction cancels the exact residual and reports the ACTUAL reduced qty, never a blanket failure", async () => {
    const calls: any[] = [];
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string, params: any) => {
        calls.push({ method, path, params });
        if (path === "/dapi/v1/positionRisk") return [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]; // broker position feed never reflects the reduction in time
        if (method === "DELETE") return { orderId: 11, status: "CANCELED" };
        if (method === "POST") return { orderId: 11, status: "NEW" };
        const deleted = calls.some(c => c.method === "DELETE");
        return deleted
          ? { orderId: 11, status: "CANCELED", avgPrice: "50200", executedQty: "6" }
          : { orderId: 11, status: "NEW", avgPrice: "0", executedQty: "0" };
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "partial-close-timeout");
    expect(result).toEqual({ success: true, filledPrice: 50200, executedQty: 6, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" });
    expect(calls.some(c => c.method === "DELETE" && c.params.origClientOrderId === deterministicClientOrderId("close:partial-close-timeout"))).toBe(true);
  });
});

describe("closePosition — ambiguous POST catch never blind-replays, exact position reconciliation", () => {
  test("submit AND reconcile-by-id both fail, but the broker position reduced -> recovers the ACTUAL reduction instead of returning a blind failure", async () => {
    let posCalls = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") {
          posCalls++;
          // before: 10 contracts open; after the ambiguous close, reduced to 4.
          return posCalls === 1
            ? [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
            : [{ symbol: "BTCUSD_PERP", positionAmt: "4", entryPrice: "50000", markPrice: "51000", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        }
        if (method === "POST") throw new Error("socket hang up");
        throw new Error("order does not exist"); // the deterministic-id requery ALSO fails
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "amb-close-recover");
    // price recovered from the (partially-closed) position's own entryPrice
    expect(result).toEqual({ success: true, filledPrice: 50000, executedQty: 6, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" });
  });

  test("submit AND reconcile-by-id both fail, position unchanged -> returns failure, never a blind replay", async () => {
    let posCalls = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") {
          posCalls++;
          // Unchanged before/after — nothing actually happened on the broker.
          return [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        }
        if (method === "POST") throw new Error("connection refused");
        throw new Error("order does not exist");
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "amb-close-noop");
    expect(result).toEqual({ success: false, filledPrice: 0, executedQty: 0, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" });
    expect(posCalls).toBeGreaterThanOrEqual(2); // pre-check + the catch's exact re-read, never a blind replay POST
  });

  test("reduced position but NO price recoverable (entryPrice and markPrice both unavailable) -> still fails, never fabricates a price", async () => {
    let posCalls = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      fetchMarkPriceRaw: async () => 0, // mark price ALSO unavailable
      signedRequest: async (method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") {
          posCalls++;
          return posCalls === 1
            ? [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
            : []; // fully closed — no remaining position to read an entryPrice from
        }
        if (method === "POST") throw new Error("socket hang up");
        throw new Error("order does not exist");
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "amb-close-noprice");
    expect(result).toEqual({ success: false, filledPrice: 0, executedQty: 0, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" });
  });
});

describe("measureClosedQty — never trusts a positive executedQty alone when the position is readable", () => {
  test("order under-reports executedQty but the broker position reduced by MORE -> reports the LARGER, real reduction", async () => {
    let posCalls = 0;
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (_method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") {
          posCalls++;
          // before: 10 contracts; after: 1 (a real reduction of 9), but the
          // order response under-reports executedQty as only 6.
          return posCalls === 1
            ? [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }]
            : [{ symbol: "BTCUSD_PERP", positionAmt: "1", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        }
        return { orderId: 21, status: "FILLED", avgPrice: "50500", executedQty: "6" };
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "under-reported-qty");
    expect(result).toEqual({ success: true, filledPrice: 50500, executedQty: 9, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" });
  });
});

// 2026-07-19: partial-close settlement. Each closePosition call queries
// /dapi/v1/userTrades SCOPED TO ITS OWN orderId, summing every fill that
// order produced (never a symbol-wide sweep that could double-count a
// sibling order's fills). BinanceCoinMMomentumAdapter accumulates these
// per-call results across stages (10->4->0) atomically — see
// accumulatePartialCloseLedger in src/db/database.ts.
describe("closePosition — DAPI userTrades settlement (realizedPnl/commission, per-order scoped)", () => {
  test("converged FILLED close sums multiple fills of the SAME order into one realizedPnl/commission/asset", async () => {
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (method: string, path: string, params: any) => {
        if (path === "/dapi/v1/positionRisk") return [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        if (path === "/dapi/v1/userTrades") {
          expect(params.orderId).toBe("30"); // scoped to THIS close order only
          return [
            { orderId: "30", qty: "6", price: "50400", realizedPnl: "0.0010", commission: "0.0001", commissionAsset: "BTC" },
            { orderId: "30", qty: "4", price: "50600", realizedPnl: "0.0015", commission: "0.00015", commissionAsset: "BTC" },
          ];
        }
        if (method === "POST") return { orderId: 30, status: "FILLED", avgPrice: "50500", executedQty: "10" };
        return { orderId: 30, status: "FILLED", avgPrice: "50500", executedQty: "10" };
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "settled-close");
    expect(result).toEqual({
      success: true, filledPrice: 50500, executedQty: 10,
      realizedPnlNative: 0.0025, commissionNative: 0.00025, commissionAsset: "BTC",
    });
  });

  test("a SECOND close order's userTrades never leaks into the first order's settlement", async () => {
    const userTradesBySymbol = {
      "30": [{ orderId: "30", qty: "6", price: "50400", realizedPnl: "1.0", commission: "0.1", commissionAsset: "BTC" }],
      "31": [{ orderId: "31", qty: "4", price: "50600", realizedPnl: "2.0", commission: "0.2", commissionAsset: "BTC" }],
    };
    function makeCloseExec(orderId: string, contracts: number) {
      return make({
        fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
        signedRequest: async (_method: string, path: string, params: any) => {
          if (path === "/dapi/v1/positionRisk") return [{ symbol: "BTCUSD_PERP", positionAmt: String(contracts), entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
          if (path === "/dapi/v1/userTrades") { expect(params.orderId).toBe(orderId); return (userTradesBySymbol as any)[orderId]; }
          return { orderId: Number(orderId), status: "FILLED", avgPrice: "50500", executedQty: String(contracts) };
        },
      });
    }
    const stage1 = await makeCloseExec("30", 6).closePosition("BTC/COIN-M", 6, "buy", "stage-1");
    expect(stage1).toEqual({ success: true, filledPrice: 50500, executedQty: 6, realizedPnlNative: 1.0, commissionNative: 0.1, commissionAsset: "BTC" });
    const stage2 = await makeCloseExec("31", 4).closePosition("BTC/COIN-M", 4, "buy", "stage-2");
    expect(stage2).toEqual({ success: true, filledPrice: 50500, executedQty: 4, realizedPnlNative: 2.0, commissionNative: 0.2, commissionAsset: "BTC" });
  });

  test("a userTrades query failure never fabricates settlement — returns zeros/empty asset, close still reports success", async () => {
    const exec = make({
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (_method: string, path: string) => {
        if (path === "/dapi/v1/positionRisk") return [{ symbol: "BTCUSD_PERP", positionAmt: "10", entryPrice: "50000", markPrice: "50500", unRealizedProfit: "0", leverage: "2", updateTime: "1" }];
        if (path === "/dapi/v1/userTrades") throw new Error("rate limited");
        return { orderId: 40, status: "FILLED", avgPrice: "50500", executedQty: "10" };
      },
    });
    const result = await exec.closePosition("BTC/COIN-M", 10, "buy", "settlement-unavailable");
    expect(result).toEqual({ success: true, filledPrice: 50500, executedQty: 10, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" });
  });
});

describe("shutdown — keeps native stops alive", () => {
  test("flips disconnected + clears filters cache but leaves the tracked stop intact", async () => {
    const exec = make({ fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE, signedRequest: async () => ({ orderId: 1 }) });
    await exec.getFilters("BTC/COIN-M");
    await exec.placeStopMarketClose("BTC/COIN-M", "buy", 48_000, 10, "shutdown-stop");
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(true);

    exec.shutdown();

    expect(exec.isConnected()).toBe(false);
    expect(exec.hasTrackedStop("BTC/COIN-M")).toBe(true); // native SL left in place, protecting a live position
  });
});

// 2026-07-19: momentum_btc startup gate. Read-only, never places an order —
// see src/config/riskProfiles.ts momentum_btc.
describe("preflight (COIN-M startup gate)", () => {
  test("refuses a non-testnet/demo restBase before any signed request", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s", restBase: "https://dapi.binance.com" }) as any;
    let called = false;
    exec.signedRequest = async () => { called = true; return {}; };
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/testnet\/demo/i);
    expect(called).toBe(false);
  });

  test("refuses without API keys configured", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "", secretKey: "" }) as any; // default restBase is demo-dapi (testnet-like)
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/API keys/i);
  });

  test("refuses when dualSidePosition is true (hedge mode, not one-way)", async () => {
    const exec = make({
      getServerTimeRaw: async () => Date.now(),
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/positionSide/dual") return { dualSidePosition: true };
        throw new Error(`unexpected ${path}`);
      },
    });
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/one-way/i);
  });

  test("propagates getFilters' own TRADING/filters validation (not TRADING -> refused)", async () => {
    const exec = make({
      getServerTimeRaw: async () => Date.now(),
      fetchExchangeInfoRaw: async () => ({ symbols: [{ ...EXCHANGE_INFO_FIXTURE.symbols[0], status: "BREAK" }] }),
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/positionSide/dual") return { dualSidePosition: false };
        throw new Error(`unexpected ${path}`);
      },
    });
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/not TRADING/);
  });

  test("refuses when the expected BTC balance row is missing", async () => {
    const exec = make({
      getServerTimeRaw: async () => Date.now(),
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/positionSide/dual") return { dualSidePosition: false };
        if (path === "/dapi/v1/balance") return [{ asset: "ETH", balance: "1", crossUnPnl: "0", availableBalance: "1" }]; // no BTC row
        throw new Error(`unexpected ${path}`);
      },
    });
    const pf = await exec.preflight();
    expect(pf.ok).toBe(false);
    expect(pf.reason).toMatch(/BTC/);
  });

  test("passes when testnet + one-way + TRADING filters + BTC balance row all check out", async () => {
    const exec = make({
      getServerTimeRaw: async () => Date.now(),
      fetchExchangeInfoRaw: async () => EXCHANGE_INFO_FIXTURE,
      signedRequest: async (_m: string, path: string) => {
        if (path === "/dapi/v1/positionSide/dual") return { dualSidePosition: false };
        if (path === "/dapi/v1/balance") return [{ asset: "BTC", balance: "0.5", crossUnPnl: "0", availableBalance: "0.5" }];
        throw new Error(`unexpected ${path}`);
      },
    });
    expect(await exec.preflight()).toEqual({ ok: true });
  });
});

describe("signedRequest — private seam, focused fetch tests", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("HTTP 200 with body code 200 returns data (does not throw)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 200, msg: "success" }), { status: 200 })) as any;
    const exec = make() as any;
    const result = await exec.signedRequest("POST", "/dapi/v1/algoOrder/cancel", {});
    expect(result).toEqual({ code: 200, msg: "success" });
  });

  test("HTTP 200 with body code 0 returns data (does not throw)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 0, msg: "ok" }), { status: 200 })) as any;
    const exec = make() as any;
    const result = await exec.signedRequest("GET", "/dapi/v1/account", {});
    expect(result).toEqual({ code: 0, msg: "ok" });
  });

  test("HTTP 400 with body code -4120 throws with code attached", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: -4120, msg: "invalid order" }), { status: 400 })) as any;
    const exec = make() as any;
    try {
      await exec.signedRequest("POST", "/dapi/v1/order", {});
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain("HTTP 400");
      expect(e.code).toBe(-4120);
    }
  });

  test("HTTP 200 with body code nonzero (not 200) throws with code attached", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: -1013, msg: "invalid qty" }), { status: 200 })) as any;
    const exec = make() as any;
    try {
      await exec.signedRequest("POST", "/dapi/v1/order", {});
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain("-1013");
      expect(e.code).toBe(-1013);
    }
  });

  test("HTTP 200 with no body code returns data (does not throw)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })) as any;
    const exec = make() as any;
    const result = await exec.signedRequest("GET", "/dapi/v1/openOrders", {});
    expect(result).toEqual({ result: "ok" });
  });
});

// ── DAPI sandbox-host gate (2026-08-09) ───────────────────────────────────
// AUDIT HOLE 1 (COIN-M leg): preflight() checked the host, but init() alone
// did not — index.ts always preflights first, yet scripts/tests may call
// init() directly. The gate now lives in init() too, via the same exported
// predicate preflight() uses. NOTE: deliberately NOT the FAPI allowlist
// (isNonProductionBinanceHost) — that one doesn't know demo-dapi.binance.com
// and would refuse this executor's own default host.
describe("isNonProductionCoinmHost", () => {
  test("accepts the demo/testnet DAPI hosts", () => {
    expect(isNonProductionCoinmHost("https://demo-dapi.binance.com")).toBe(true);
    expect(isNonProductionCoinmHost("https://testnet.binancefuture.com")).toBe(true);
  });
  test("REJECTS production DAPI — this is the whole point", () => {
    expect(isNonProductionCoinmHost("https://dapi.binance.com")).toBe(false);
  });
  test("unknown/empty hosts fail CLOSED", () => {
    expect(isNonProductionCoinmHost("https://example.com")).toBe(false);
    expect(isNonProductionCoinmHost("")).toBe(false);
    expect(isNonProductionCoinmHost(undefined as any)).toBe(false);
  });
});

describe("init() refuses a production DAPI host (independent of preflight)", () => {
  test("production restBase → init false BEFORE any network call", async () => {
    const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s", restBase: "https://dapi.binance.com" }) as any;
    let network = 0;
    exec.getServerTimeRaw = async () => { network++; return Date.now(); };
    exec.fetchExchangeInfoRaw = async () => { network++; return {}; };
    exec.signedRequest = async () => { network++; return {}; };
    expect(await exec.init()).toBe(false);
    expect(exec.isConnected()).toBe(false);
    expect(network).toBe(0);
  });
});
