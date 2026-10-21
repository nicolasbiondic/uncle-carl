// ══════════════════════════════════════════════
// strategy_version through the real live adapters (2026-10-20).
//
// modelVersions.test.ts locks insertTrade's stamping; this proves the three
// production write paths reach it with their sleeve id and that a
// MODEL_CUTOVER close keeps the opening version while the re-buy gets the
// current one. Fake executors, in-memory DB — no network, no dev .env.
// ══════════════════════════════════════════════

import { beforeAll, describe, expect, test } from "bun:test";
import { getDB } from "../../db/database";
import { makeTestDb } from "../../test-support/db";
import { currentModelVersionId } from "../../portfolio/modelVersions";
import { AlpacaMomentumAdapter } from "./AlpacaMomentumAdapter";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";

beforeAll(() => { makeTestDb(); });

const versionOf = (id: string) =>
  (getDB().prepare(`SELECT strategy_version v FROM trades WHERE id = ?`).get(id) as any).v as string;

function fakeAlpaca(orderId: string) {
  return {
    isConnected: () => true,
    getCachedPrice: () => 100,
    getLatestPrice: async () => 100,
    getExecutableQuote: async () => ({ price: 100, timestamp: Date.now() }),
    getRegTBuyingPower: async () => null,
    placeOrder: async (signal: any, qty: number) => ({
      id: orderId, symbol: signal.symbol, market: "stock", side: signal.side, type: "market", quantity: qty,
      price: signal.price, status: "filled", externalId: `broker-${orderId}`, filledPrice: 100, filledQty: qty,
      filledAt: Date.now(), submittedAt: Date.now() - 10, submittedPx: 100, createdAt: Date.now(), updatedAt: Date.now(), signal,
    }),
    closePosition: async () => ({ success: true, filledPrice: 110, filledQty: 10 }),
  } as any;
}

function fakeBinance(orderId: string, nativeSymbol: string) {
  return {
    isConnected: () => true,
    getPrice: async () => 100,
    getExecutableQuote: async () => null,
    placeOrder: async (_sig: any, qty: number) => ({
      id: orderId, quantity: qty, filledPrice: 100, openCommission: 0, submittedPx: 100, submittedAt: Date.now() - 10,
    }),
    placeStopMarketClose: async () => true,
    getPositions: async () => [{ symbol: nativeSymbol, positionAmt: 10, entryPrice: 100 }],
    closePosition: async () => ({ success: true, filledPrice: 110, filledQty: 10, commission: 0, realizedPnl: 100 }),
    cancelAllOrders: async () => {},
  } as any;
}

describe("live adapters stamp the sleeve's model version on every row they open", () => {
  for (const sleeve of ["momentum_stocks", "meanrev_stocks"]) {
    test(`AlpacaMomentumAdapter (${sleeve})`, async () => {
      const res = await new AlpacaMomentumAdapter(fakeAlpaca(`alp-${sleeve}`), { accountId: sleeve })
        .openPosition({ symbol: "MSFT", side: "buy", notionalUsd: 1000 });
      expect(res.ok).toBe(true);
      expect(versionOf(`alp-${sleeve}`)).toBe(currentModelVersionId(sleeve)!);
      expect(versionOf(`alp-${sleeve}`)).not.toBe("legacy");
    });
  }

  test("BinanceMomentumAdapter USDT (momentum_crypto)", async () => {
    const res = await new BinanceMomentumAdapter({} as any, fakeBinance("bin-usdt", "BTCUSDT"), { accountId: "momentum_crypto" })
      .openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(true);
    expect(versionOf("bin-usdt")).toBe(currentModelVersionId("momentum_crypto")!);
  });

  test("BinanceMomentumAdapter USDC (momentum_crypto_usdc)", async () => {
    const res = await new BinanceMomentumAdapter({} as any, fakeBinance("bin-usdc", "BTCUSDC"), { accountId: "momentum_crypto_usdc", quoteAsset: "USDC" })
      .openPosition({ symbol: "BTC/USDC", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(true);
    expect(versionOf("bin-usdc")).toBe(currentModelVersionId("momentum_crypto_usdc")!);
  });

  test("a MODEL_CUTOVER close through the adapter keeps the OPENING version on the row", async () => {
    // A row opened by the previous model (explicit old stamp), closed by the
    // current model's cutover pass.
    getDB().prepare(
      `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity, entry_time, status, account_id, profile_id, strategy_version)
       VALUES ('old-meta', 'META', 'stock', 'buy', 'MOMENTUM', 90, 10, ?, 'open', 'momentum_stocks', 'momentum_stocks', 'momentum_stocks@pre-blend')`
    ).run(Date.now() - 86_400_000);
    const adapter = new AlpacaMomentumAdapter({
      ...fakeAlpaca("alp-unused"),
      getPositions: async () => [{ symbol: "META", qty: 10 }],
    }, { accountId: "momentum_stocks" });
    const closed = await adapter.closePosition({ symbol: "META", side: "buy", closeReason: "MODEL_CUTOVER" });
    expect(closed.ok).toBe(true);
    const row = getDB().prepare(`SELECT status, close_reason, strategy_version FROM trades WHERE id = 'old-meta'`).get() as any;
    expect(row).toEqual({ status: "closed", close_reason: "MODEL_CUTOVER", strategy_version: "momentum_stocks@pre-blend" });
  });
});
