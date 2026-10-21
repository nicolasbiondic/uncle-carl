// Portfolio-engine rows are OUTSIDE the stop machinery: neither the 15s
// checkAllStopLoss loop nor the broker-native GTC ensure pass touches them
// (RW-reescritura-rentable §3). Falsifier: drop the isPortfolioEngineRow
// `continue` in either pass → the PORTFOLIO row below closes at the 4%
// fallback / gets a GTC stop like the control MOMENTUM row does.
//
// BrokerSync: a PORTFOLIO row (pf_ id) whose symbol is absent at the broker
// is bot-managed, not sync-owned → never auto-closed (no phantom deletion).

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { getDB, isPortfolioEngineRow, PORTFOLIO_ENGINE_STRATEGY } from "../../db/database";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { makeAccountManager } from "../../test-support/account";
import { BrokerSync } from "../../sync/BrokerSync";
import type { BrokerSyncSource } from "../../sync/brokerSyncSource";

async function withMarketOpen<T>(fn: () => Promise<T>): Promise<T> {
  const realDate = Date;
  const openNow = realDate.parse("2026-07-24T14:00:00.000Z");
  globalThis.Date = class extends realDate {
    constructor(...args: any[]) { super(args.length ? args[0] : openNow); }
    static now() { return openNow; }
  } as DateConstructor;
  const realLog = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = realLog; globalThis.Date = realDate; }
}

function rowStatus(id: string) {
  return getDB().prepare("SELECT status, close_reason FROM trades WHERE id = ?").get(id) as any;
}

beforeAll(() => { makeTestDb(); });
beforeEach(() => { getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM sync_state;"); });

describe("isPortfolioEngineRow", () => {
  test("only the PORTFOLIO strategy tag", () => {
    expect(isPortfolioEngineRow({ strategy: PORTFOLIO_ENGINE_STRATEGY })).toBe(true);
    expect(isPortfolioEngineRow({ strategy: "MOMENTUM" })).toBe(false);
    expect(isPortfolioEngineRow({ strategy: null })).toBe(false);
  });
});

describe("checkAllStopLoss — PORTFOLIO rows are skipped", () => {
  test("a -10% breach closes the MOMENTUM control row, not the PORTFOLIO row", async () => {
    seedOpenTrade("pf_test_spy", "momentum_stocks", { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 100, quantity: 10 });
    seedOpenTrade("ctl_aapl", "momentum_stocks", { symbol: "AAPL", strategy: "MOMENTUM", entryPrice: 100, quantity: 10 });
    const closed: string[] = [];
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getCachedPrice: () => 0,
        getRiskPrice: async () => 90, // -10%: beyond the 4% fallback
        closePosition: async (symbol: string) => { closed.push(symbol); return { success: true, filledPrice: 90, commission: 0 }; },
      },
    });
    await withMarketOpen(() => (manager as any).checkAllStopLoss());
    expect(closed).toEqual(["AAPL"]);
    expect(rowStatus("pf_test_spy").status).toBe("open");
    expect(rowStatus("ctl_aapl")).toEqual({ status: "closed", close_reason: "STOP_LOSS" });
  });
});

describe("ensureAlpacaNativeStops — PORTFOLIO rows get no GTC stop", () => {
  test("control row gets a stop; the PORTFOLIO row does not", async () => {
    seedOpenTrade("pf_test_tlt", "momentum_stocks", { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 100, quantity: 7.5 });
    seedOpenTrade("ctl_msft", "momentum_stocks", { symbol: "MSFT", strategy: "MOMENTUM", entryPrice: 100, quantity: 10 });
    const stops: any[] = [];
    const broker = (symbol: string, quantity: number) => ({
      symbol, market: "stock" as const, side: "buy" as const, quantity, avgEntryPrice: 100, currentPrice: 100,
      unrealizedPnl: 0, unrealizedPnlPct: 0, openedAt: Date.now(),
    });
    const m = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getAccount: async () => ({ equity: "100000", cash: "50000" }),
        getCachedPrice: () => 0,
        getLatestPrice: async () => 0,
        getPositions: async () => [broker("TLT", 7.5), broker("MSFT", 10)],
        getOpenStopOrders: async () => [],
        cancelOrderById: async () => true,
        getOrderStateByClientId: async () => null,
        getOrderById: async () => null,
        invalidateCandleCache: () => {},
        placeStopLossOrder: async (p: any) => { stops.push(p); return { ok: true, orderId: "stop-1" }; },
      },
    });
    (m as any).orphanStopGraceMinMs = 0;
    await (m as any).ensureAlpacaNativeStops();
    expect(stops.map(s => s.symbol)).toEqual(["MSFT"]);
  });
});

describe("BrokerSync — PORTFOLIO rows are never phantom-closed", () => {
  test("row absent at the broker stays open (bot-managed, not sync-owned)", async () => {
    seedOpenTrade("pf_momentum_stocks_GLD_x", "momentum_stocks", { symbol: "GLD", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 200, quantity: 2.5 });
    seedOpenTrade("sync_1_abc", "alpaca_main", { symbol: "XYZ", strategy: "BROKER_SYNC", entryPrice: 10, quantity: 1 });
    const source: BrokerSyncSource = {
      id: "alpaca_paper", name: "FakeAlpaca", status: "connected",
      getAccount: async () => ({ totalEquity: 100_000, availableCash: 50_000 }),
      getOpenPositions: async () => [], // broker flat
    } as any;
    const bs = new BrokerSync([source], 30_000);
    const realLog = console.log; console.log = () => {};
    try { await bs.syncAll(); } finally { console.log = realLog; }
    expect(rowStatus("pf_momentum_stocks_GLD_x").status).toBe("open");       // ours: left to the engine
    expect(rowStatus("sync_1_abc").status).toBe("closed");                   // control: sync-owned rows DO auto-close
  });
});
