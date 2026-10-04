// ══════════════════════════════════════════════
// BinanceMomentumAdapter — reconcile-row exclusion + honest "row missing"
// close contract (P0 fixes: fabricated reconcile PnL was reaching
// RiskGuard; a confirmed broker close with no DB row falsely reported ok:true).
// ══════════════════════════════════════════════

import { describe, test, expect, beforeAll } from "bun:test";
import { getDB, updateTradeCloseReason } from "../../db/database";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
});

describe("BinanceMomentumAdapter.getRealisedPnlSince — reconcile exclusion", () => {
  test("excludes MANUAL_CLOSE_UNRECONCILED pnl, includes a normal closed row", async () => {
    seedOpenTrade("fabricated-reconcile", "momentum_crypto", {
      symbol: "BTC/USD", market: "crypto", exitPrice: 200, pnl: 99999,
      entryTime: Date.now() - 1000, exitTime: Date.now(), status: "closed",
    });
    updateTradeCloseReason("fabricated-reconcile", "MANUAL_CLOSE_UNRECONCILED");

    seedOpenTrade("real-close", "momentum_crypto", {
      symbol: "ETH/USD", market: "crypto", exitPrice: 110, pnl: 10,
      entryTime: Date.now() - 1000, exitTime: Date.now(), status: "closed",
    });
    updateTradeCloseReason("real-close", "MOMENTUM_REBALANCE");

    const adapter = new BinanceMomentumAdapter({} as any, {} as any, { accountId: "momentum_crypto" });
    const net = await adapter.getRealisedPnlSince(0);

    expect(net).toBe(10); // the invented 99999 must never reach RiskGuard
  });
});

describe("BinanceMomentumAdapter ownership boundary — the DB, not the broker, defines what is ours (P0, shared broker account)", () => {
  // This API key is SHARED with the canonical prod deployment (AGENTS.md
  // "Project Location"): the broker book is the AGGREGATE of both. Reverting
  // getOpenPositions/closePosition to broker-derived ownership makes every
  // test in this describe fail (positions appear / the close call fires /
  // the aggregate qty is closed).

  test("a broker position with NO DB row is invisible to getOpenPositions() — the engine never manages positions it didn't book (adoption is AccountManager's job)", async () => {
    const bin = {
      isConnected: () => true,
      getPositions: async () => [{ symbol: "ETHUSDT", positionAmt: 1.431, entryPrice: 2500, unrealizedProfit: 0, leverage: 2, updateTime: 1 }],
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, bin, { accountId: "momentum_crypto_ownership" });
    expect(await adapter.getOpenPositions()).toEqual([]);
  });

  test("closePosition with NO DB row refuses BEFORE any broker call — the aggregate position is never liquidated", async () => {
    const calls = { positions: 0, close: 0, cancel: 0 };
    const bin = {
      isConnected: () => true,
      getPositions: async () => { calls.positions++; return [{ symbol: "BTCUSDT", positionAmt: 1, entryPrice: 100 }]; },
      closePosition: async () => { calls.close++; return { success: true, filledPrice: 105, commission: 0, realizedPnl: 5 }; },
      cancelAllOrders: async () => { calls.cancel++; },
    } as any;

    const result = await new BinanceMomentumAdapter({} as any, bin, { accountId: "momentum_crypto_no_row" })
      .closePosition({ symbol: "BTC/USD", side: "buy" });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no open DB trade");
    expect(calls.close).toBe(0);     // the old code closed Math.abs(positionAmt) here
    expect(calls.positions).toBe(0); // broker not even read without ownership
    expect(calls.cancel).toBe(0);    // protective orders we don't own untouched
  });

  test("closePosition closes the RECORDED row quantity, never the broker aggregate (ours 0.2 + not-ours 0.3)", async () => {
    seedOpenTrade("own-share", "momentum_crypto_bounded", {
      symbol: "BTC/USD", market: "crypto", quantity: 0.2, entryTime: Date.now(),
    });
    const closes: number[] = [];
    const bin = {
      isConnected: () => true,
      getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: 0.5, entryPrice: 100 }],
      closePosition: async (_s: string, qty: number) => { closes.push(qty); return { success: true, filledPrice: 105, commission: 0, realizedPnl: 1 }; },
      cancelAllOrders: async () => {},
    } as any;

    const res = await new BinanceMomentumAdapter({} as any, bin, { accountId: "momentum_crypto_bounded" })
      .closePosition({ symbol: "BTC/USD", side: "buy" });

    expect(res.ok).toBe(true);
    expect(closes).toEqual([0.2]); // our share — NOT the aggregate 0.5
  });

  test("open persists OUR order's executed qty, never the broker aggregate — end to end: not-ours 0.3 + our fill 0.2 = broker 0.5 → row 0.2, native stop 0.2, close 0.2", async () => {
    // The account already holds 0.3 BTC that isn't ours (e.g. a manual
    // position). Our order executes 0.2, so
    // positionRisk reports the AGGREGATE 0.5 the moment we open. Persisting
    // that 0.5 (the old `finalQty = Math.abs(live.positionAmt)`) sized the
    // row, the broker-native stop AND the later min(row, broker) close to
    // liquidate prod's share. Re-adding that line fails all three assertions.
    const accountId = "momentum_crypto_cotenant_qty";
    const stopQtys: number[] = [];
    const closeQtys: number[] = [];
    const bin = {
      isConnected: () => true,
      getPrice: async () => 100,
      placeOrder: async () => ({
        id: "our-order-1", symbol: "BTC/USD", market: "crypto", side: "buy", type: "market",
        quantity: 0.2, // OUR order's terminal executed qty (executor resolves it per-order)
        price: 100, status: "filled", externalId: "777", filledPrice: 100, filledAt: Date.now(),
        createdAt: Date.now(), updatedAt: Date.now(), openCommission: 0,
        submittedAt: Date.now(), submittedPx: 100,
      }),
      // Aggregate book: prod's 0.3 + ours 0.2.
      getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: 0.5, entryPrice: 100 }],
      placeStopMarketClose: async (_s: string, _side: string, _px: number, qty: number) => { stopQtys.push(qty); return true; },
      closePosition: async (_s: string, qty: number) => { closeQtys.push(qty); return { success: true, filledPrice: 105, commission: 0, realizedPnl: 1 }; },
      cancelAllOrders: async () => {},
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, bin, { accountId });

    const open = await adapter.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 20 });
    expect(open.ok).toBe(true);
    const rows = (await adapter.getOpenPositions());
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(0.2);   // the row is born OURS, not aggregate
    expect(stopQtys).toEqual([0.2]);      // native stop sized to our share only

    const close = await adapter.closePosition({ symbol: "BTC/USD", side: "buy" });
    expect(close.ok).toBe(true);
    expect(closeQtys).toEqual([0.2]);     // min(row 0.2, broker 0.5) — prod's 0.3 untouched
  });

  test("broker holds LESS than our row → close bounds to the broker quantity (never oversubmit)", async () => {
    seedOpenTrade("own-shrunk", "momentum_crypto_shrunk", {
      symbol: "ETH/USD", market: "crypto", entryPrice: 2500, quantity: 0.5, entryTime: Date.now(),
    });
    const closes: number[] = [];
    const bin = {
      isConnected: () => true,
      getPositions: async () => [{ symbol: "ETHUSDT", positionAmt: 0.1, entryPrice: 2500 }],
      closePosition: async (_s: string, qty: number) => { closes.push(qty); return { success: true, filledPrice: 2600, commission: 0, realizedPnl: 1 }; },
      cancelAllOrders: async () => {},
    } as any;

    const res = await new BinanceMomentumAdapter({} as any, bin, { accountId: "momentum_crypto_shrunk" })
      .closePosition({ symbol: "ETH/USD", side: "buy" });

    expect(res.ok).toBe(true);
    expect(closes).toEqual([0.1]); // min(row 0.5, broker 0.1)
  });
});

describe("BinanceMomentumAdapter close_reason telemetry — TRAIL_STOP vs signal-flip (P2)", () => {
  const mkBin = (native: string) => ({
    isConnected: () => true,
    getPositions: async () => [{ symbol: native, positionAmt: 0.2, entryPrice: 100 }],
    closePosition: async () => ({ success: true, filledPrice: 105, commission: 0, realizedPnl: 1 }),
    cancelAllOrders: async () => {},
  } as any);

  test("engine trail close persists close_reason=TRAIL_STOP", async () => {
    seedOpenTrade("trail-close-binance", "momentum_crypto_trailreason", {
      symbol: "BTC/USD", market: "crypto", quantity: 0.2, entryTime: Date.now(),
    });

    const res = await new BinanceMomentumAdapter({} as any, mkBin("BTCUSDT"), { accountId: "momentum_crypto_trailreason" })
      .closePosition({ symbol: "BTC/USD", side: "buy", closeReason: "TRAIL_STOP" });

    expect(res.ok).toBe(true);
    const row = getDB().prepare(`SELECT status, close_reason FROM trades WHERE id = 'trail-close-binance'`).get() as any;
    expect(row).toEqual({ status: "closed", close_reason: "TRAIL_STOP" });
  });

  test("signal-flip close (no closeReason) still persists MOMENTUM_REBALANCE; free text falls back too", async () => {
    seedOpenTrade("flip-close-binance", "momentum_crypto_flipreason", {
      symbol: "ETH/USD", market: "crypto", quantity: 0.2, entryTime: Date.now(),
    });
    const adapter = new BinanceMomentumAdapter({} as any, mkBin("ETHUSDT"), { accountId: "momentum_crypto_flipreason" });

    const res = await adapter.closePosition({ symbol: "ETH/USD", side: "buy" });
    expect(res.ok).toBe(true);
    expect((getDB().prepare(`SELECT close_reason FROM trades WHERE id = 'flip-close-binance'`).get() as any).close_reason)
      .toBe("MOMENTUM_REBALANCE");

    seedOpenTrade("freetext-close-binance", "momentum_crypto_flipreason", {
      symbol: "ETH/USD", market: "crypto", quantity: 0.2, entryTime: Date.now(),
    });
    const res2 = await adapter.closePosition({ symbol: "ETH/USD", side: "buy", closeReason: "whatever text" });
    expect(res2.ok).toBe(true);
    expect((getDB().prepare(`SELECT close_reason FROM trades WHERE id = 'freetext-close-binance'`).get() as any).close_reason)
      .toBe("MOMENTUM_REBALANCE");
  });
});
