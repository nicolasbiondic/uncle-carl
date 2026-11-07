// ══════════════════════════════════════════════
// BinanceMomentumAdapter — reconcile-row exclusion + honest "row missing"
// close contract (P0 fixes: fabricated reconcile PnL was reaching
// RiskGuard; a confirmed broker close with no DB row falsely reported ok:true).
// ══════════════════════════════════════════════

import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { getDB, getOpenTrades, updateTradeCloseReason } from "../../db/database";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { momentumCryptoPortfolioPlan, momentumUsdcPortfolioPlan } from "../../index";
import { USDC_SYMBOL_MAP, type QuoteAsset } from "../../executor/binance/quoteAsset";
import { initPlatformPortfolios, loadPlatformPortfolioDefinitions, loadPlatformPortfolioRows } from "../../portfolios/store";
import { buildPortfolioPlan } from "../../portfolios/factory";
import { validateMomentumParams } from "../../portfolios/validate";
import { MomentumEngine } from "./MomentumEngine";
import { MemoryPersistence, silentLogger } from "../../test-support/momentum";
import { TestClock } from "../../utils/clock";
import { ensureTurtleCatastropheStop, turtleStopClientOrderId } from "../../account/BinanceSleeveReconciler";
import { eventBus, EVENTS } from "../../utils/events";

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
  test("USDC bo13 end to end: boot refresh → DB → validation → factory → engine → adapter opens all 13 native units from completed UTC days", async () => {
    const registry = new Database(":memory:"), saved = globalThis.fetch;
    const day = Math.floor(Date.now() / 86400000) * 86400000, symbols = Object.keys(USDC_SYMBOL_MAP);
    try {
      initPlatformPortfolios(registry, 1_000);
      const row = loadPlatformPortfolioRows(registry).find(r => r.id === "momentum_crypto_usdc")!;
      const { breakoutShort: _leg, ...old } = row.params as any;
      registry.run("UPDATE platform_portfolios SET params_json = ? WHERE id = ?", [JSON.stringify(old), row.id]);
      initPlatformPortfolios(registry, 2_000);
      const refreshed = loadPlatformPortfolioRows(registry).find(r => r.id === row.id)!;
      expect(refreshed).toMatchObject({ source: "builtin", updatedAt: 2_000 });
      const errors: string[] = [];
      validateMomentumParams(refreshed.params, refreshed.account, errors, { permittedCutover: old.cutover });
      expect(errors).toEqual([]);
      const plan = buildPortfolioPlan(loadPlatformPortfolioDefinitions(registry).find(d => d.id === row.id)!, day);
      expect(plan).toEqual(momentumUsdcPortfolioPlan());
      if (plan.template !== "momentum_tsm" || plan.adapter.kind !== "binance_usdm") throw new Error("expected USDM momentum");
      expect(plan.adapter.options.breakoutShortSymbols).toEqual(symbols);
      const reads: string[] = [], orders: Array<{ symbol: string; quantity: number }> = [], stops: any[] = [];
      const raw = Array.from({ length: 264 }, (_, i) => {
        const t = day - (263 - i) * 86400000;
        // Forming day has a huge range; yesterday's low permits the strict breach.
        return [t, "100", i === 263 ? "1000000000" : "110", i === 262 ? "80" : "90", i === 262 ? "89" : "100", "1000", t + 86400000 - 1];
      });
      globalThis.fetch = (async (url: any) => {
        const u = new URL(String(url));
        expect(u.pathname).toBe("/fapi/v1/klines");
        expect(u.searchParams.get("interval")).toBe("1d");
        reads.push(u.searchParams.get("symbol")!);
        return new Response(JSON.stringify(raw));
      }) as any;
      const bin = {
        isConnected: () => true, getBalance: async () => ({ marginEquity: 5_000, marginCash: 5_000 }),
        getPrice: async (native: string) => { expect(Object.values(USDC_SYMBOL_MAP)).toContain(native); return 89; },
        getPositions: async () => orders.map(o => ({ symbol: USDC_SYMBOL_MAP[o.symbol], positionAmt: -o.quantity, entryPrice: 89, unrealizedProfit: 0 })),
        placeOrder: async (s: any, quantity: number, accountId: string) => {
          expect(s.side).toBe("sell"); expect(accountId).toBe(row.id);
          orders.push({ symbol: s.symbol, quantity });
          return { id: `usdc-bo13-e2e-${s.symbol}`, quantity, status: "filled", filledPrice: 89, filledAt: day + 15000 };
        },
        getOpenProtectiveOrders: async () => [],
        placeStopMarketClose: async (...args: any[]) => { stops.push(args); return true; },
      } as any;
      const adapter = new BinanceMomentumAdapter({ getBars: async () => { throw new Error("no Alpaca proxy"); } } as any, bin, plan.adapter.options);
      for (const symbol of symbols) {
        const bars = await adapter.fetchDailyBars(symbol, 56);
        expect(bars).toHaveLength(56); expect(bars.at(-1)!.timestamp).toBe(day - 86400000);
        expect(Math.max(...bars.map(b => b.high))).toBe(110);
        expect(await adapter.fetchDailyBars(symbol, 56)).toBe(bars);
      }
      const report = await new MomentumEngine(plan.engineConfig, adapter, silentLogger, new MemoryPersistence(), new TestClock(day + 15000)).tick();
      expect(orders.map(o => o.symbol)).toEqual(symbols);
      expect(report.actions.filter(a => a.type === "open")).toHaveLength(13);
      expect(stops).toHaveLength(13);
      const held = await new BinanceMomentumAdapter({} as any, bin, plan.adapter.options).getOpenPositions();
      expect(held).toHaveLength(13);
      for (const p of held) {
        expect(p.role).toBe("breakout-short"); expect(p.quantity * p.breakoutN!).toBeCloseTo(50, 10);
        expect(p.stopLoss).toBeCloseTo(89 + 2 * p.breakoutN!, 10);
        expect(stops.find(s => s[0] === p.symbol)?.slice(1, 4)).toEqual(["sell", 89 + 3 * p.breakoutN!, p.quantity]);
      }
      expect(new Set(reads)).toEqual(new Set(Object.values(USDC_SYMBOL_MAP)));
      expect(await new BinanceMomentumAdapter({} as any, bin, plan.adapter.options).openPosition({ symbol: "BTC/USD", side: "sell", notionalUsd: 10, role: "breakout-short", breakout: { n: 20, stopN: 2, quantity: 0.1 } })).toMatchObject({ ok: false });
      raw.splice(240, 1); // missing completed day fails closed, not a shorter channel
      expect(await new BinanceMomentumAdapter({} as any, bin, plan.adapter.options).fetchDailyBars("BTC/USDC", 56)).toEqual([]);
    } finally { globalThis.fetch = saved; registry.close(); }
  });
  test("Turtle gets consecutive completed venue OHLC for every configured coin, and never falls back to Alpaca", async () => {
    const saved = globalThis.fetch, day = Math.floor(Date.now() / 86400000) * 86400000;
    let alpacaReads = 0;
    const raw = Array.from({ length: 57 }, (_, i) => {
      const t = day - (56 - i) * 86400000;
      return [t, "100", i === 56 ? "1000000000" : "110", "90", "100", "1", t + 86400000 - 1];
    });
    const plan = momentumCryptoPortfolioPlan();
    if (plan.adapter.kind !== "binance_usdm") throw new Error("expected USDM");
    const symbols = plan.adapter.options.breakoutShortSymbols!;
    expect(symbols).toHaveLength(8);
    const a = new BinanceMomentumAdapter({ getBars: async () => { alpacaReads++; return []; } } as any, {} as any, plan.adapter.options);
    try {
      const reads: string[] = [];
      globalThis.fetch = (async (url: any) => {
        const u = new URL(String(url));
        expect(u.pathname).toBe("/fapi/v1/klines");
        expect(u.searchParams.get("interval")).toBe("1d");
        reads.push(u.searchParams.get("symbol")!);
        return new Response(JSON.stringify(raw));
      }) as any;
      for (const symbol of symbols) {
        const bars = await a.fetchDailyBars(symbol, 55);
        expect(bars).toHaveLength(55); expect(bars.at(-1)!.timestamp).toBe(day - 86400000);
        expect(Math.max(...bars.map(b => b.high))).toBe(110);
        expect(await a.fetchDailyBars(symbol, 55)).toBe(bars); // per-coin UTC-day cache
      }
      expect(reads).toEqual(symbols.map(s => s.replace("/USD", "USDT")));
      const usdc = new BinanceMomentumAdapter({} as any, {} as any, { quoteAsset: "USDC", candleTimeframe: "1Day" });
      const usdcBars = await usdc.fetchDailyBars("BTC/USDC", 56); // 55 prior days plus D
      expect(usdcBars).toHaveLength(56);
      expect(usdcBars.at(-1)!.timestamp).toBe(day - 86400000);
      expect(reads.at(-1)).toBe("BTCUSDC");
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

  test.each(["BREAKOUT_CATASTROPHE_STOP", "TRAIL_STOP", "TREND_EXIT", "IDLE_OVERLAY_EXIT", "BREAKOUT_SHORT_EXIT", "BREAKOUT_SHORT_STOP", "BREAKOUT_SHORT_PRIORITY", "BREAKOUT_SHORT_DRAWDOWN", "BREAKOUT_SHORT_TIME_STOP", "BREAKOUT_LONG_EXIT", "BREAKOUT_LONG_STOP", "BREAKOUT_LONG_PRIORITY", "BREAKOUT_LONG_DRAWDOWN", "BREAKOUT_LONG_TIME_STOP"])("engine close persists close_reason=%s", async closeReason => {
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

  test.each([
    ...["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "AVAX/USD", "DOGE/USD", "LINK/USD"].map(symbol => ({ symbol, quoteAsset: "USDT" as QuoteAsset })),
    ...Object.keys(USDC_SYMBOL_MAP).map(symbol => ({ symbol, quoteAsset: "USDC" as QuoteAsset })),
  ])("Turtle %j stores 2N separately and installs a sized 3N catastrophe stop", async ({ symbol, quoteAsset }) => {
    const accountId = `breakout-persistence-${symbol}`;
    let stops = 0, submittedQty = 0;
    const bin = {
      isConnected: () => true, getPrice: async (native: string) => { expect(native).toBe(symbol.split("/")[0] + quoteAsset); return 100; },
      getPositions: async () => [{ symbol: symbol.split("/")[0] + quoteAsset, positionAmt: -0.2, entryPrice: 99, unrealizedProfit: 0 }],
      placeOrder: async (s: any, qty: number) => { expect(s).toMatchObject({ symbol, side: "sell" }); submittedQty = qty; return { id: `breakout-fill-${symbol}`, quantity: 0.2, status: "filled", filledPrice: 99, filledAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }; },
      getOpenProtectiveOrders: async () => [],
      placeStopMarketClose: async (s: string, side: string, price: number, qty: number, id: string) => {
        stops++; expect([s, side, price, qty, id]).toEqual([symbol, "sell", 108, 0.2, turtleStopClientOrderId({ id: `breakout-fill-${symbol}`, accountId })]); return true;
      },
      closePosition: async () => ({ success: true, filledPrice: 105, commission: 0, realizedPnl: -1.2 }), cancelAllOrders: async () => {},
    } as any;
    const plan = momentumCryptoPortfolioPlan();
    if (plan.adapter.kind !== "binance_usdm") throw new Error("expected USDM");
    const options = quoteAsset === "USDT" ? plan.adapter.options : { quoteAsset, candleTimeframe: "1Day" as const, breakoutShortSymbols: Object.keys(USDC_SYMBOL_MAP) };
    const a = new BinanceMomentumAdapter({} as any, bin, { ...options, accountId });
    expect(await a.openPosition({ symbol, side: "sell", notionalUsd: 20, role: "breakout-short", breakout: { n: 3, stopN: 2, quantity: 0.2 } })).toEqual({ ok: true });
    expect(stops).toBe(1); expect(submittedQty).toBe(0.2);
    expect((getDB().query("SELECT catastrophe_stop FROM trades WHERE id = ?").get(`breakout-fill-${symbol}`) as any).catastrophe_stop).toBe(108);
    const restarted = new BinanceMomentumAdapter({} as any, bin, { accountId, quoteAsset });
    expect(await restarted.getOpenPositions()).toMatchObject([{ symbol, role: "breakout-short", entryPrice: 99, breakoutN: 3, stopLoss: 105, quantity: 0.2 }]);
    expect(await restarted.closePosition({ symbol, side: "sell", closeReason: "BREAKOUT_SHORT_STOP" })).toEqual({ ok: true });
    expect(await restarted.getRealisedPnlSince(0)).toBeCloseTo(-1.2);
  });

  test.each(["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "AVAX/USD", "DOGE/USD", "LINK/USD"])("Turtle LONG %s preserves 2N and installs a configurable catastrophe stop", async symbol => {
    const accountId = `breakout-long-${symbol}`; let stops = 0, submittedQty = 0;
    const bin = {
      isConnected: () => true, getPrice: async () => 100,
      getPositions: async () => [{ symbol: symbol.split("/")[0] + "USDT", positionAmt: 0.2, entryPrice: 101, unrealizedProfit: 0 }],
      placeOrder: async (s: any, qty: number) => { expect(s).toMatchObject({ symbol, side: "buy" }); submittedQty = qty; return { id: `breakout-long-fill-${symbol}`, quantity: 0.2, status: "filled", filledPrice: 101, filledAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }; },
      getOpenProtectiveOrders: async () => [],
      placeStopMarketClose: async (s: string, side: string, price: number, qty: number) => {
        stops++; expect([s, side, price, qty]).toEqual([symbol, "buy", 89, 0.2]); return true;
      },
      closePosition: async () => ({ success: true, filledPrice: 95, commission: 0, realizedPnl: -1.2 }), cancelAllOrders: async () => {},
    } as any;
    const a = new BinanceMomentumAdapter({} as any, bin, { accountId, breakoutLongSymbols: [symbol] });
    expect(await a.openPosition({ symbol, side: "buy", notionalUsd: 20, role: "breakout-long", breakout: { n: 3, stopN: 2, catastropheN: 4, quantity: 0.2 } })).toEqual({ ok: true });
    expect(stops).toBe(1); expect(submittedQty).toBe(0.2);
    const restarted = new BinanceMomentumAdapter({} as any, bin, { accountId });
    expect(await restarted.getOpenPositions()).toMatchObject([{ symbol, side: "buy", role: "breakout-long", entryPrice: 101, breakoutN: 3, stopLoss: 95, quantity: 0.2 }]);
    expect(await restarted.closePosition({ symbol, side: "buy", closeReason: "BREAKOUT_LONG_STOP" })).toEqual({ ok: true });
    expect(await restarted.getRealisedPnlSince(0)).toBeCloseTo(-1.2);
  });
  test("Turtle LONG rejects unconfigured/unmapped symbols, wrong side and malformed units before broker access", async () => {
    const action = { symbol: "BTC/USD", side: "buy" as const, notionalUsd: 20, role: "breakout-long" as const, breakout: { n: 3, stopN: 2, quantity: 0.2 } };
    expect((await new BinanceMomentumAdapter({} as any, {} as any).openPosition(action)).ok).toBe(false);
    const a = new BinanceMomentumAdapter({} as any, {} as any, { breakoutLongSymbols: ["BTC/USD", "UNKNOWN/USD"] });
    for (const bad of [{ ...action, symbol: "ETH/USD" }, { ...action, symbol: "UNKNOWN/USD" }, { ...action, side: "sell" as const }, { ...action, breakout: undefined }, { ...action, breakout: { ...action.breakout, quantity: NaN } }]) {
      expect((await a.openPosition(bad)).reason).toContain("configured, mapped USDT buy");
    }
  });

  test.each(["USDT", "USDC"] as const)("%s Turtle post-fill stop failure retains the unit and pages once", async quoteAsset => {
    const accountId = `failed-catastrophe-${quoteAsset}`, symbol = quoteAsset === "USDT" ? "BTC/USD" : "BTC/USDC";
    const pages: any[] = [], handler = (p: any) => { if (p.context === "TurtleCatastropheStop") pages.push(p); };
    let closes = 0;
    const bin: any = {
      isConnected: () => true, getPrice: async () => 100,
      getPositions: async () => [{ symbol: `BTC${quoteAsset}`, positionAmt: -1, entryPrice: 100, unrealizedProfit: 0 }],
      placeOrder: async () => ({ id: accountId, quantity: 1, status: "filled", filledPrice: 100 }),
      getOpenProtectiveOrders: async () => [], placeStopMarketClose: async () => false,
      closePosition: async () => { closes++; return { success: true }; },
    };
    eventBus.on(EVENTS.ERROR_BURST, handler);
    try {
      const adapter = new BinanceMomentumAdapter({} as any, bin, { accountId, quoteAsset, breakoutShortSymbols: [symbol] });
      expect(await adapter.openPosition({ symbol, side: "sell", notionalUsd: 100, role: "breakout-short", breakout: { n: 5, stopN: 2, quantity: 1 } })).toEqual({ ok: true });
      expect(await adapter.getOpenPositions()).toMatchObject([{ symbol, stopLoss: 110, breakoutN: 5 }]);
      expect(closes).toBe(0); expect(pages).toHaveLength(1);
    } finally { eventBus.removeListener(EVENTS.ERROR_BURST, handler); }
  });

  for (const quoteAsset of ["USDT", "USDC"] as const) for (const side of ["sell", "buy"] as const) {
    test.each(["EXIT", "STOP", "TIME_STOP", "PRIORITY", "DRAWDOWN", "MODEL_CUTOVER"])(`${quoteAsset} Turtle ${side} %s cancels ONLY its unit stop`, async kind => {
      const accountId = `cancel-turtle-${quoteAsset}-${side}-${kind}`, id = accountId;
      const symbol = quoteAsset === "USDT" ? "BTC/USD" : "BTC/USDC";
      seedOpenTrade(id, accountId, { symbol, market: "crypto", side, strategy: side === "sell" ? "BREAKOUT_SHORT" : "BREAKOUT_LONG", quantity: 1, entryTime: Date.now() });
      const cancels: any[] = [];
      const bin: any = {
        isConnected: () => true,
        getPositions: async () => [{ symbol: `BTC${quoteAsset}`, positionAmt: side === "sell" ? -2 : 2, entryPrice: 100 }],
        closePosition: async (_s: string, qty: number, _side: string, opts: any) => {
          expect(qty).toBe(1); expect(opts).toMatchObject({ skipOrderCleanup: true, onAccepted: expect.any(Function) });
          return { success: true, filledPrice: 100, realizedPnl: 0, commission: 0 };
        },
        cancelAllOrders: async (...args: any[]) => { cancels.push(args); },
      };
      const closeReason = kind === "MODEL_CUTOVER" ? kind : `${side === "sell" ? "BREAKOUT_SHORT" : "BREAKOUT_LONG"}_${kind}`;
      expect(await new BinanceMomentumAdapter({} as any, bin, { accountId, quoteAsset }).closePosition({ symbol, side, closeReason })).toEqual({ ok: true });
      expect(cancels).toEqual([[symbol, { onlyClientOrderIds: [turtleStopClientOrderId({ id, accountId })] }]]);
      expect((getDB().query("SELECT close_reason FROM trades WHERE id = ?").get(id) as any).close_reason).toBe(closeReason);
    });
  }

  test("concurrent ensure/close serializes install before cancellation; stale ensure cannot orphan a stop", async () => {
    const accountId = "turtle-ensure-close-race", symbol = "BTC/USD";
    seedOpenTrade(accountId, accountId, { symbol, market: "crypto", side: "sell", strategy: "BREAKOUT_SHORT", quantity: 1, breakoutN: 5, stopLoss: 110 });
    const trade = getOpenTrades(accountId)[0], trace: string[] = [];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), readStarted = new Promise<void>(r => { entered = r; });
    const bin: any = {
      isConnected: () => true,
      getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: -1, entryPrice: 100 }],
      getOpenProtectiveOrders: async () => { entered(); await gate; return []; },
      placeStopMarketClose: async () => { trace.push("install"); return true; },
      closePosition: async () => { trace.push("close"); return { success: true, filledPrice: 100, realizedPnl: 0, commission: 0 }; },
      cancelAllOrders: async () => { trace.push("cancel"); },
    };
    const ensuring = ensureTurtleCatastropheStop(bin, trade, "BTCUSDT");
    await readStarted;
    const closing = new BinanceMomentumAdapter({} as any, bin, { accountId }).closePosition({ symbol, side: "sell", closeReason: "BREAKOUT_SHORT_EXIT" });
    release(); await ensuring; expect(await closing).toEqual({ ok: true });
    await ensureTurtleCatastropheStop(bin, trade, "BTCUSDT");
    expect(trace).toEqual(["install", "close", "cancel"]);
  });

  test("an unconfirmed Turtle close keeps its catastrophe stop and its row", async () => {
    const accountId = "turtle-close-not-confirmed", symbol = "BTC/USD";
    seedOpenTrade(accountId, accountId, { symbol, market: "crypto", side: "sell", strategy: "BREAKOUT_SHORT" });
    let cancels = 0;
    const bin: any = {
      isConnected: () => true, getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: -1, entryPrice: 100 }],
      closePosition: async () => ({ success: false, filledPrice: 0 }), cancelAllOrders: async () => { cancels++; },
    };
    expect((await new BinanceMomentumAdapter({} as any, bin, { accountId }).closePosition({ symbol, side: "sell" })).ok).toBe(false);
    expect(cancels).toBe(0); expect(getOpenTrades(accountId)).toHaveLength(1);
  });
  test("Turtle rejects unconfigured/unmapped symbols, wrong wallet/side and malformed units before broker access", async () => {
    const action = { symbol: "ETH/USD", side: "sell" as const, notionalUsd: 20, role: "breakout-short" as const, breakout: { n: 3, stopN: 2, quantity: 0.2 } };
    const a = new BinanceMomentumAdapter({} as any, {} as any, { breakoutShortSymbols: ["BTC/USD", "UNKNOWN/USD"] });
    for (const input of [action, { ...action, symbol: "UNKNOWN/USD" }, { ...action, symbol: "BTC/USD", side: "buy" as const },
      { ...action, symbol: "BTC/USD", breakout: { ...action.breakout, n: 0 } }, { ...action, symbol: "BTC/USD", breakout: undefined }]) {
      expect((await a.openPosition(input)).reason).toContain("configured, mapped USDT sell");
    }
    expect((await new BinanceMomentumAdapter({} as any, {} as any).openPosition(action)).ok).toBe(false);
    expect((await new BinanceMomentumAdapter({} as any, {} as any, { quoteAsset: "USDC", breakoutShortSymbols: [action.symbol] }).openPosition(action)).ok).toBe(false);
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
