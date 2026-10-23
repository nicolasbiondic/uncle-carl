// increaseOpenTradeQuantity + closeTrade's basisQuantity (RW4a exposure
// control, 2026-10-23): the add-back writer and the pnl_pct basis of a row
// that was partially reduced before its final close.
import { describe, test, expect, beforeAll } from "bun:test";
import { getDB, increaseOpenTradeQuantity, closeTrade, accumulatePartialCloseLedger } from "./database";
import { makeTestDb, seedOpenTrade } from "../test-support/db";

beforeAll(() => { makeTestDb(); });

describe("increaseOpenTradeQuantity", () => {
  test("weighted-average entry, quantity grows, open fee accumulates, stop_loss untouched — one transaction", () => {
    seedOpenTrade("inc-1", "acct_inc", { quantity: 10, entryPrice: 100, stopLoss: 95, openCommission: 1 });
    const out = increaseOpenTradeQuantity("inc-1", { addQty: 5, fillPrice: 130, commission: 0.5 });
    expect(out).toEqual({ quantity: 15, entryPrice: (100 * 10 + 130 * 5) / 15, openCommission: 1.5 });
    const row = getDB().prepare(`SELECT quantity, entry_price, open_commission, stop_loss, status FROM trades WHERE id = 'inc-1'`).get() as any;
    expect(row).toEqual({ quantity: 15, entry_price: 110, open_commission: 1.5, stop_loss: 95, status: "open" });
  });
  test("closed row → null (nothing written); invalid leg → throws", () => {
    seedOpenTrade("inc-2", "acct_inc", { quantity: 10, entryPrice: 100, status: "closed", exitPrice: 101, exitTime: Date.now() });
    expect(increaseOpenTradeQuantity("inc-2", { addQty: 5, fillPrice: 130, commission: 0 })).toBeNull();
    expect((getDB().prepare(`SELECT quantity FROM trades WHERE id = 'inc-2'`).get() as any).quantity).toBe(10);
    seedOpenTrade("inc-3", "acct_inc", { quantity: 10, entryPrice: 100 });
    expect(() => increaseOpenTradeQuantity("inc-3", { addQty: 0, fillPrice: 130, commission: 0 })).toThrow();
    expect(() => increaseOpenTradeQuantity("inc-3", { addQty: 1, fillPrice: NaN, commission: 0 })).toThrow();
  });
});

describe("closeTrade basisQuantity", () => {
  test("a partially reduced row closes with pnl_pct over remnant + reduced, not the remnant alone", () => {
    seedOpenTrade("cb-1", "acct_cb", { quantity: 10, entryPrice: 100 });
    accumulatePartialCloseLedger("cb-1", { realizedNative: 50, commissionNative: 0, commissionAsset: "USDC", closedContracts: 5, remainingContracts: 5 });
    const closed = closeTrade("cb-1", 110, Date.now(), 0, 50 + 50, { basisQuantity: 10 });
    expect(closed?.pnl).toBe(100);
    expect(closed?.pnlPct).toBeCloseTo(10, 9); // 100 / (100 × 10)
  });
  test("absent or invalid basisQuantity → the row's own quantity (every legacy caller unchanged)", () => {
    seedOpenTrade("cb-2", "acct_cb", { quantity: 5, entryPrice: 100 });
    expect(closeTrade("cb-2", 110, Date.now(), 0)?.pnlPct).toBeCloseTo(10, 9);
    seedOpenTrade("cb-3", "acct_cb", { quantity: 5, entryPrice: 100 });
    expect(closeTrade("cb-3", 110, Date.now(), 0, undefined, { basisQuantity: 0 })?.pnlPct).toBeCloseTo(10, 9);
  });
});
