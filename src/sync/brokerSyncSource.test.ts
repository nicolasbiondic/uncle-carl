// ══════════════════════════════════════════════
// BrokerSyncSource — the STACK B shim BrokerSync consumes.
// Fake executors (plain objects cast to the type) — no network.
// ══════════════════════════════════════════════

import { describe, test, expect } from "bun:test";
import { buildBrokerSyncSources } from "./brokerSyncSource";
import type { AlpacaExecutor } from "../executor/alpaca-executor";
import type { BinanceExecutor } from "../executor/binance-executor";

function fakeAlpaca(overrides: Record<string, any> = {}): AlpacaExecutor {
  return {
    isConnected: () => overrides.connected ?? true,
    getAccount: overrides.getAccount ?? (async () => ({ equity: "101000.50", cash: "25000.25" })),
    getPositions: overrides.getPositions ?? (async () => []),
  } as unknown as AlpacaExecutor;
}

function fakeBinance(overrides: Record<string, any> = {}): BinanceExecutor {
  return {
    isConnected: () => overrides.connected ?? true,
    getBalance: overrides.getBalance ?? (async () => ({ marginEquity: 10_250, marginCash: 8_000, wallet: 10_000, unrealizedPnl: 250 })),
    getPositions: overrides.getPositions ?? (async () => []),
    getAssetBreakdown: overrides.getAssetBreakdown ?? (async () => []),
  } as unknown as BinanceExecutor;
}

describe("buildBrokerSyncSources — identity + status", () => {
  test("builds alpaca_paper + binance_testnet with ids/names and connected status", () => {
    const [a, b] = buildBrokerSyncSources(fakeAlpaca(), fakeBinance());
    expect(a.id).toBe("alpaca_paper");
    expect(a.name).toBe("Alpaca Paper");
    expect(a.status).toBe("connected");
    expect(b.id).toBe("binance_testnet");
    expect(b.name).toBe("Binance Futures Testnet");
    expect(b.status).toBe("connected");
  });

  test("status reflects isConnected() live (not a build-time snapshot)", () => {
    const [a, b] = buildBrokerSyncSources(fakeAlpaca({ connected: false }), fakeBinance({ connected: false }));
    expect(a.status).toBe("disconnected");
    expect(b.status).toBe("disconnected");
  });

  test("only the binance source exposes getAssetBreakdown", () => {
    const [a, b] = buildBrokerSyncSources(fakeAlpaca(), fakeBinance());
    expect(a.getAssetBreakdown).toBeUndefined();
    expect(typeof b.getAssetBreakdown).toBe("function");
  });
});

describe("alpaca source", () => {
  test("getAccount parses SDK string equity/cash → numbers", async () => {
    const [a] = buildBrokerSyncSources(
      fakeAlpaca({ getAccount: async () => ({ equity: "101000.50", cash: "25000.25" }) }),
      fakeBinance(),
    );
    expect(await a.getAccount()).toEqual({ totalEquity: 101000.5, availableCash: 25000.25 });
  });

  test("getAccount throws when the SDK returns null", async () => {
    const [a] = buildBrokerSyncSources(fakeAlpaca({ getAccount: async () => null }), fakeBinance());
    await expect(a.getAccount()).rejects.toThrow("returned null");
  });

  test("getOpenPositions maps avgEntryPrice → entryPrice, keeps alpaca symbol/side/qty", async () => {
    const [a] = buildBrokerSyncSources(
      fakeAlpaca({
        getPositions: async () => [
          { symbol: "AAPL", market: "stock", side: "buy", quantity: 10, avgEntryPrice: 150, currentPrice: 155, unrealizedPnl: 50, unrealizedPnlPct: 3, openedAt: 0 },
        ],
      }),
      fakeBinance(),
    );
    expect(await a.getOpenPositions()).toEqual([
      { symbol: "AAPL", side: "buy", quantity: 10, entryPrice: 150 },
    ]);
  });
});

describe("binance source", () => {
  test("getAccount copies margin values (operational sync — the full account total is AccountManager's job)", async () => {
    const [, b] = buildBrokerSyncSources(
      fakeAlpaca(),
      fakeBinance({ getBalance: async () => ({ marginEquity: 4_675.0407, marginCash: 2_004.9246, wallet: 4_442.9792, unrealizedPnl: 232.0615 }) }),
    );
    expect(await b.getAccount()).toEqual({ totalEquity: 4_675.0407, availableCash: 2_004.9246 });
  });

  test("getOpenPositions: raw→alpaca symbol, signed→side, abs qty, skips zero-amt", async () => {
    const [, b] = buildBrokerSyncSources(
      fakeAlpaca(),
      fakeBinance({
        getPositions: async () => [
          { symbol: "BTCUSDT", positionAmt: 0.5, entryPrice: 60_000, unrealizedProfit: 0, leverage: 2, updateTime: 0 },
          { symbol: "ETHUSDT", positionAmt: -3, entryPrice: 3_000, unrealizedProfit: 0, leverage: 2, updateTime: 0 },
          { symbol: "SOLUSDT", positionAmt: 0, entryPrice: 100, unrealizedProfit: 0, leverage: 2, updateTime: 0 },
        ],
      }),
    );
    expect(await b.getOpenPositions()).toEqual([
      { symbol: "BTC/USD", side: "buy", quantity: 0.5, entryPrice: 60_000 },
      { symbol: "ETH/USD", side: "sell", quantity: 3, entryPrice: 3_000 },
    ]);
  });

  test("getAssetBreakdown passes through the executor's breakdown", async () => {
    const breakdown = [{ asset: "USDT", balance: 100, availableBalance: 80, usdValue: 100 }];
    const [, b] = buildBrokerSyncSources(fakeAlpaca(), fakeBinance({ getAssetBreakdown: async () => breakdown }));
    expect(await b.getAssetBreakdown!()).toEqual(breakdown);
  });
});

describe("failure semantics", () => {
  test("transport, API and malformed failures propagate through the shim", async () => {
    const boom = async () => { throw new Error("network down"); };
    const [a, b] = buildBrokerSyncSources(
      fakeAlpaca({ getAccount: boom, getPositions: boom }),
      fakeBinance({ getBalance: boom, getPositions: boom, getAssetBreakdown: boom }),
    );
    await expect(a.getAccount()).rejects.toThrow("network down");
    await expect(a.getOpenPositions()).rejects.toThrow("network down");
    await expect(b.getAccount()).rejects.toThrow("network down");
    await expect(b.getOpenPositions()).rejects.toThrow("network down");
    await expect(b.getAssetBreakdown!()).rejects.toThrow("network down");
  });

  test("balance error aborts the binance source read", async () => {
    const [, b] = buildBrokerSyncSources(
      fakeAlpaca(),
      fakeBinance({ getBalance: async () => { throw new Error("account unavailable"); } }),
    );
    await expect(b.getAccount()).rejects.toThrow("account unavailable");
  });

  test("positions error aborts the binance source read", async () => {
    const [, b] = buildBrokerSyncSources(
      fakeAlpaca(),
      fakeBinance({ getPositions: async () => { throw new Error("positions unavailable"); } }),
    );
    await expect(b.getOpenPositions()).rejects.toThrow("positions unavailable");
  });

  test("valid zero balances remain valid", async () => {
    const [a, b] = buildBrokerSyncSources(
      fakeAlpaca({ getAccount: async () => ({ equity: "0", cash: "0" }) }),
      fakeBinance({ getBalance: async () => ({ marginEquity: 0, marginCash: 0, wallet: 0, unrealizedPnl: 0 }) }),
    );
    expect(await a.getAccount()).toEqual({ totalEquity: 0, availableCash: 0 });
    expect(await b.getAccount()).toEqual({ totalEquity: 0, availableCash: 0 });
  });

  test("valid empty positions remain valid", async () => {
    const [a, b] = buildBrokerSyncSources(
      fakeAlpaca({ getPositions: async () => [] }),
      fakeBinance({ getPositions: async () => [] }),
    );
    expect(await a.getOpenPositions()).toEqual([]);
    expect(await b.getOpenPositions()).toEqual([]);
  });

  test("Alpaca getAccount throws on null or malformed numeric fields", async () => {
    const [aNull] = buildBrokerSyncSources(
      fakeAlpaca({ getAccount: async () => null }),
      fakeBinance(),
    );
    await expect(aNull.getAccount()).rejects.toThrow("returned null");

    const [aBad] = buildBrokerSyncSources(
      fakeAlpaca({ getAccount: async () => ({ equity: "not_a_number", cash: "100" }) }),
      fakeBinance(),
    );
    await expect(aBad.getAccount()).rejects.toThrow("malformed");
  });

  test("Binance getAccount throws on null, undefined, or malformed numeric fields", async () => {
    const [, bNull] = buildBrokerSyncSources(
      fakeAlpaca(),
      fakeBinance({ getBalance: async () => null }),
    );
    await expect(bNull.getAccount()).rejects.toThrow("returned null/undefined");

    const [, bBad] = buildBrokerSyncSources(
      fakeAlpaca(),
      fakeBinance({ getBalance: async () => ({ marginEquity: NaN, marginCash: 7_652, wallet: 4_442, unrealizedPnl: 0 }) }),
    );
    await expect(bBad.getAccount()).rejects.toThrow("malformed");

    const [, bBadCash] = buildBrokerSyncSources(
      fakeAlpaca(),
      fakeBinance({ getBalance: async () => ({ marginEquity: 10_000, marginCash: Infinity, wallet: 4_442, unrealizedPnl: 0 }) }),
    );
    await expect(bBadCash.getAccount()).rejects.toThrow("malformed");
  });

  test("Binance getOpenPositions throws on non-array response", async () => {
    const [, b] = buildBrokerSyncSources(
      fakeAlpaca(),
      fakeBinance({ getPositions: async () => ({ msg: "rate limited" }) }),
    );
    await expect(b.getOpenPositions()).rejects.toThrow("non-array");
  });

  test("Binance getOpenPositions throws on malformed non-flat position", async () => {
    const [, b] = buildBrokerSyncSources(
      fakeAlpaca(),
      fakeBinance({ getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: "not-a-number", entryPrice: 1 }] }),
    );
    await expect(b.getOpenPositions()).rejects.toThrow("positionAmt");
  });

  test("Alpaca getOpenPositions throws on malformed position", async () => {
    const [a] = buildBrokerSyncSources(
      fakeAlpaca({ getPositions: async () => [{ symbol: "AAPL", side: "buy", quantity: 1, avgEntryPrice: NaN }] }),
      fakeBinance(),
    );
    await expect(a.getOpenPositions()).rejects.toThrow("malformed position");
  });
});
