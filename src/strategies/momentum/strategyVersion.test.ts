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
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";

beforeAll(() => { makeTestDb(); });

const versionOf = (id: string) =>
  (getDB().prepare(`SELECT strategy_version v FROM trades WHERE id = ?`).get(id) as any).v as string;

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
  // The stock sleeves' rows are stamped by the portfolio engine's Alpaca venue
  // (src/portfolio-engine/live/venues/alpaca.ts, its own tests); the Alpaca
  // momentum adapter was retired 2026-11-07.
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
       VALUES ('old-eth', 'ETH/USD', 'crypto', 'buy', 'MOMENTUM', 90, 10, ?, 'open', 'momentum_crypto', 'momentum_crypto', 'momentum_crypto@pre-vt35')`
    ).run(Date.now() - 86_400_000);
    const adapter = new BinanceMomentumAdapter({} as any, fakeBinance("bin-unused", "ETHUSDT"), { accountId: "momentum_crypto" });
    const closed = await adapter.closePosition({ symbol: "ETH/USD", side: "buy", closeReason: "MODEL_CUTOVER" });
    expect(closed.ok).toBe(true);
    const row = getDB().prepare(`SELECT status, close_reason, strategy_version FROM trades WHERE id = 'old-eth'`).get() as any;
    expect(row).toEqual({ status: "closed", close_reason: "MODEL_CUTOVER", strategy_version: "momentum_crypto@pre-vt35" });
  });
});
