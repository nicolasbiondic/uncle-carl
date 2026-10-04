// ══════════════════════════════════════════════
// BinanceMomentumAdapter — engine vol-scaled stop + daily signal timeframe
// (U1 2026-09-26, momentum_crypto_usdc daily kernel, artifact 752767ae…)
//
// 1. openPosition.stopLossPct (the engine's volStop output — the SAME
//    contract AlpacaMomentumAdapter honors, volStopEntry.test.ts) must
//    drive BOTH the broker-native STOP_MARKET level and the persisted row
//    stop (trades.stop_loss), so the 15s loop / stopConfirm's rowStopPct
//    resolves the vol distance. Absent → profile fixed pct (legacy,
//    byte-identical for the USDT sleeve).
// 2. cfg.candleTimeframe must reach the candle source. The Binance klines
//    fetch is intercepted at the global fetch seam (no network, no module
//    mock — module mocks leak across test files in one bun process): the
//    `interval` query param proves the timeframe plumbing.
// ══════════════════════════════════════════════

import { describe, test, expect, beforeAll } from "bun:test";
import { getDB } from "../../db/database";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { makeTestDb } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
});

function fakeBinance(orderId: string, captured: { stopPrice?: number }) {
  return {
    isConnected: () => true,
    getPrice: async () => 100,
    getExecutableQuote: async () => null,
    placeOrder: async (_sig: any, qty: number) => ({ id: orderId, quantity: qty, filledPrice: 100 }),
    placeStopMarketClose: async (_sym: string, _side: string, stopPrice: number) => {
      captured.stopPrice = stopPrice;
      return true;
    },
    getPositions: async () => [{ symbol: "ETHUSDT", positionAmt: 10, entryPrice: 100 }],
    closePosition: async () => ({ success: true, filledPrice: 100 }),
    cancelAllOrders: async () => {},
  } as any;
}

describe("BinanceMomentumAdapter.openPosition — engine vol-scaled stop (rowStopPct doctrine)", () => {
  test("action.stopLossPct drives the native stop AND the persisted row stop", async () => {
    const captured: { stopPrice?: number } = {};
    const adapter = new BinanceMomentumAdapter({} as any, fakeBinance("volstop-row", captured));
    const res = await adapter.openPosition({ symbol: "ETH/USD", side: "buy", notionalUsd: 1000, stopLossPct: 12.5 });
    expect(res).toEqual({ ok: true });
    // fill 100, 12.5% vol distance → 87.5 (NOT the profile's 4% → 96)
    expect(captured.stopPrice).toBeCloseTo(87.5, 10);
    const row = getDB().prepare(`SELECT stop_loss FROM trades WHERE id = 'volstop-row'`).get() as any;
    expect(row.stop_loss).toBeCloseTo(87.5, 10);
  });

  test("absent stopLossPct falls back to the profile fixed pct (legacy behavior)", async () => {
    const captured: { stopPrice?: number } = {};
    const adapter = new BinanceMomentumAdapter({} as any, fakeBinance("volstop-fallback", captured));
    const res = await adapter.openPosition({ symbol: "ETH/USD", side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: true });
    expect(captured.stopPrice).toBeCloseTo(96, 10); // default stopLossPct 4
    const row = getDB().prepare(`SELECT stop_loss FROM trades WHERE id = 'volstop-fallback'`).get() as any;
    expect(row.stop_loss).toBeCloseTo(96, 10);
  });

  test("degenerate stopLossPct (0) falls back to the profile fixed pct", async () => {
    const captured: { stopPrice?: number } = {};
    const adapter = new BinanceMomentumAdapter({} as any, fakeBinance("volstop-zero", captured));
    const res = await adapter.openPosition({ symbol: "ETH/USD", side: "buy", notionalUsd: 1000, stopLossPct: 0 });
    expect(res).toEqual({ ok: true });
    expect(captured.stopPrice).toBeCloseTo(96, 10);
  });
});

describe("BinanceMomentumAdapter.fetchCandles — candleTimeframe plumbing", () => {
  /** Intercept the klines HTTP call; answer with ONE closed bar so
   *  fetchCandles returns from the Binance path (never the Alpaca
   *  fallback). Returns the captured `interval` query param. */
  async function withFetchCapture(fn: () => Promise<void>): Promise<string | undefined> {
    const realFetch = globalThis.fetch;
    let interval: string | undefined;
    globalThis.fetch = (async (url: any) => {
      const u = new URL(String(url));
      interval = u.searchParams.get("interval") ?? undefined;
      const t = Date.now() - 90_000_000; // open long past; closeTime in the past → bar kept
      return new Response(JSON.stringify([[t, "1", "2", "0.5", "1.5", "10", t + 60_000]]), { status: 200 });
    }) as any;
    try { await fn(); } finally { globalThis.fetch = realFetch; }
    return interval;
  }

  test('default config asks for "1Hour" klines (legacy, byte-identical)', async () => {
    const adapter = new BinanceMomentumAdapter({} as any, {} as any);
    const interval = await withFetchCapture(async () => {
      const bars = await adapter.fetchCandles("ETH/USD", 10);
      expect(bars.length).toBe(1);
    });
    expect(interval).toBe("1h");
  });

  test('candleTimeframe "1Day" asks for "1d" klines (the usdc daily kernel)', async () => {
    const adapter = new BinanceMomentumAdapter({} as any, {} as any, {
      accountId: "momentum_crypto_usdc", quoteAsset: "USDC", candleTimeframe: "1Day",
    });
    const interval = await withFetchCapture(async () => {
      const bars = await adapter.fetchCandles("ETH/USDC", 263);
      expect(bars.length).toBe(1);
    });
    expect(interval).toBe("1d");
  });
});
