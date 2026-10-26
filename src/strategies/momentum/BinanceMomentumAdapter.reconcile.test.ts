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
  test("Turtle gets consecutive completed venue OHLC only, and its hourly source never falls back to Alpaca", async () => {
    const saved = globalThis.fetch, day = Math.floor(Date.now() / 86400000) * 86400000;
    let alpacaReads = 0;
    const raw = Array.from({ length: 56 }, (_, i) => {
      const t = day - (55 - i) * 86400000;
      return [t, "100", i === 55 ? "1000000000" : "110", "90", "100", "1", t + 86400000 - 1];
    });
    const a = new BinanceMomentumAdapter({ getBars: async () => { alpacaReads++; return []; } } as any, {} as any);
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify(raw))) as any;
      const bars = await a.fetchDailyBars("BTC/USD", 55);
      expect(bars).toHaveLength(55); expect(bars.at(-1)!.timestamp).toBe(day - 86400000);
      expect(Math.max(...bars.map(b => b.high))).toBe(110);
      raw.splice(10, 1);
      expect(await new BinanceMomentumAdapter({} as any, {} as any).fetchDailyBars("BTC/USD", 55)).toEqual([]);
      globalThis.fetch = (async () => new Response("[]")) as any;
      expect(await a.fetchCandles("BTC/USD", 50, { strictVenue: true })).toEqual([]); expect(alpacaReads).toBe(0);
      await a.fetchCandles("BTC/USD", 50); expect(alpacaReads).toBe(1); // legacy contract
    } finally { globalThis.fetch = saved; }
  });
  test.each(["buy", "sell"] as const)("idle overlay %s: durable role, no native stop, restart ownership and risk PnL", async side => {
    const accountId = `idle-role-${side}`;
    let stops = 0;
    const bin = {
      isConnected: () => true,
      getPrice: async () => 100,
      getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: side === "buy" ? 0.2 : -0.2, entryPrice: 100, unrealizedProfit: 0 }],
      placeOrder: async () => ({ id: `idle-fill-${side}`, quantity: 0.2, price: 100, status: "filled", filledPrice: 100, filledAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }),
      placeStopMarketClose: async () => { stops++; return true; },
      closePosition: async () => ({ success: true, filledPrice: 105, commission: 0, realizedPnl: side === "buy" ? 1 : -1 }),
      cancelAllOrders: async () => {},
    } as any;
    const a = new BinanceMomentumAdapter({} as any, bin, { accountId });
    expect(await a.openPosition({ symbol: "BTC/USD", side, notionalUsd: 20, role: "idle-overlay" })).toEqual({ ok: true });
    expect(stops).toBe(0);
    expect((getDB().query("SELECT strategy, stop_loss FROM trades WHERE account_id = ?").get(accountId) as any)).toEqual({ strategy: "IDLE_OVERLAY", stop_loss: 0 });
    const restarted = new BinanceMomentumAdapter({} as any, bin, { accountId });
    expect(await restarted.getOpenPositions()).toMatchObject([{ side, role: "idle-overlay" }]);
    expect(await restarted.closePosition({ symbol: "BTC/USD", side, closeReason: "IDLE_OVERLAY_EXIT" })).toEqual({ ok: true });
    expect(await restarted.getRealisedPnlSince(0)).toBe(side === "buy" ? 1 : -1);
  });

  const mkBin = (native: string) => ({
    isConnected: () => true,
    getPositions: async () => [{ symbol: native, positionAmt: 0.2, entryPrice: 100 }],
    closePosition: async () => ({ success: true, filledPrice: 105, commission: 0, realizedPnl: 1 }),
    cancelAllOrders: async () => {},
  } as any);

  test.each(["TRAIL_STOP", "TREND_EXIT", "IDLE_OVERLAY_EXIT", "BREAKOUT_SHORT_EXIT", "BREAKOUT_SHORT_STOP", "BREAKOUT_SHORT_PRIORITY", "BREAKOUT_SHORT_DRAWDOWN", "BREAKOUT_SHORT_TIME_STOP"])("engine close persists close_reason=%s", async closeReason => {
    const id = `trail-close-binance-${closeReason}`;
    seedOpenTrade(id, "momentum_crypto_trailreason", {
      symbol: "BTC/USD", market: "crypto", quantity: 0.2, entryTime: Date.now(),
    });

    const res = await new BinanceMomentumAdapter({} as any, mkBin("BTCUSDT"), { accountId: "momentum_crypto_trailreason" })
      .closePosition({ symbol: "BTC/USD", side: "buy", closeReason });

    expect(res.ok).toBe(true);
    const row = getDB().prepare(`SELECT status, close_reason FROM trades WHERE id = ?`).get(id) as any;
    expect(row).toEqual({ status: "closed", close_reason: closeReason });
  });

  test("Turtle entry stores N, fill and 2N stop atomically; restart recovers ownership, no native stop", async () => {
    const accountId = "breakout-persistence";
    let stops = 0, submittedQty = 0;
    const bin = {
      isConnected: () => true, getPrice: async () => 100,
      getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: -0.2, entryPrice: 99, unrealizedProfit: 0 }],
      placeOrder: async (_s: any, qty: number) => { submittedQty = qty; return { id: "breakout-fill", quantity: 0.2, status: "filled", filledPrice: 99, filledAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }; },
      placeStopMarketClose: async () => { stops++; return true; },
      closePosition: async () => ({ success: true, filledPrice: 105, commission: 0, realizedPnl: -1.2 }), cancelAllOrders: async () => {},
    } as any;
    const a = new BinanceMomentumAdapter({} as any, bin, { accountId });
    expect(await a.openPosition({ symbol: "BTC/USD", side: "sell", notionalUsd: 20, role: "breakout-short", breakout: { n: 3, stopN: 2, quantity: 0.2 } })).toEqual({ ok: true });
    expect(stops).toBe(0); expect(submittedQty).toBe(0.2);
    const restarted = new BinanceMomentumAdapter({} as any, bin, { accountId });
    expect(await restarted.getOpenPositions()).toMatchObject([{ role: "breakout-short", entryPrice: 99, breakoutN: 3, stopLoss: 105, quantity: 0.2 }]);
    expect(await restarted.closePosition({ symbol: "BTC/USD", side: "sell", closeReason: "BREAKOUT_SHORT_STOP" })).toEqual({ ok: true });
    expect(await restarted.getRealisedPnlSince(0)).toBeCloseTo(-1.2);
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
