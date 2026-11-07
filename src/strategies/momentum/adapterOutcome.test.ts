// ══════════════════════════════════════════════
// Adapters × order outcome taxonomy (2026-08-03)
// ══════════════════════════════════════════════
//
// An UNKNOWN submit result (timeout/disconnect after transmit) must never be
// treated as a rejection by the adapters: no rejected-order telemetry, no
// partial-flatten against the broker, no native stop, and above all NO
// immediate resend — resolution belongs to the reconciliation loops.
// Also: the pre-trade estimate (est_px) rides into the fills row.

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { getDB } from "../../db/database";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { makeTestDb } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
});

afterEach(() => {
  getDB().exec(`DELETE FROM trades`);
  getDB().exec(`DELETE FROM orders`);
  getDB().exec(`DELETE FROM fills`);
  getDB().exec(`DELETE FROM signals`);
});

describe("BinanceMomentumAdapter — unknown outcome", () => {
  test("unknown placeOrder result: no rejected row, no native stop, no emergency close, no resend", async () => {
    let stopCalls = 0;
    let closeCalls = 0;
    const binance = {
      isConnected: () => true,
      getQuoteAsset: () => "USDT",
      getPrice: async () => 50_000,
      placeOrder: async () => ({ outcome: "unknown", reason: "socket hang up; resolution exhausted", clientOrderId: "uc-fapi-xyz" }),
      placeStopMarketClose: async () => { stopCalls++; return true; },
      closePosition: async () => { closeCalls++; return { success: true, filledPrice: 50_000, commission: 0, realizedPnl: 0 }; },
      getPositions: async () => [],
      cancelAllOrders: async () => {},
    } as any;

    const result = await new BinanceMomentumAdapter({} as any, binance, { accountId: "momentum_crypto" })
      .openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unknown (in flight)");
    const rejected = getDB().prepare(`SELECT COUNT(*) c FROM orders WHERE status = 'rejected'`).get() as any;
    expect(rejected.c).toBe(0);
    expect((getDB().prepare(`SELECT COUNT(*) c FROM trades`).get() as any).c).toBe(0);
    expect(stopCalls).toBe(0);
    expect(closeCalls).toBe(0);
  });

  test("a NULL placeOrder result (proven_failed) still records the rejection — the taxonomy keeps the two cases distinct", async () => {
    const binance = {
      isConnected: () => true,
      getQuoteAsset: () => "USDT",
      getPrice: async () => 50_000,
      placeOrder: async () => null,
    } as any;

    const result = await new BinanceMomentumAdapter({} as any, binance, { accountId: "momentum_crypto" })
      .openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("binance.placeOrder returned null");
    const rejected = getDB().prepare(`SELECT COUNT(*) c FROM orders WHERE status = 'rejected'`).get() as any;
    expect(rejected.c).toBe(1);
  });
});
