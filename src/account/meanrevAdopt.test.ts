import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDB, getOpenTrades } from "../db/database";
import { setBrokerTruthAvailable } from "../portfolio/truth";
import { makeTestDb } from "../test-support/db";
import { makeAccountManager } from "../test-support/account";
import { captureBursts } from "../test-support/events";

function managerWith(alpaca: any) {
  return makeAccountManager({
    alpaca: { getCachedPrice: () => 0, ...alpaca },
  });
}

function brokerPos(overrides: Partial<Record<string, any>> = {}) {
  return {
    symbol: "XLP",
    market: "stock" as const,
    side: "buy" as const,
    quantity: 58,
    avgEntryPrice: 72.5,
    currentPrice: 73.1,
    unrealizedPnl: 34.8,
    unrealizedPnlPct: 0.83,
    openedAt: Date.now(),
    ...overrides,
  };
}

beforeAll(() => { makeTestDb(); });
beforeEach(() => {
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM equity_snapshots;");
  setBrokerTruthAvailable("alpaca", true);
});

describe("AccountManager Alpaca stock-sleeve orphan adoption", () => {
  test("adopts a MEANREV_UNIVERSE symbol orphaned on Alpaca after the grace window, as a SYNC_RECOVERY row", async () => {
    const manager = managerWith({
      isConnected: () => true,
      getAccount: async () => ({ equity: "100000", cash: "50000" }),
      getPositions: async () => [brokerPos()],
    });

    // Grace = 3 consecutive 60s cycles before adoption.
    await (manager as any).syncAlpacaAccount();
    await (manager as any).syncAlpacaAccount();
    expect(getOpenTrades("meanrev_stocks")).toHaveLength(0);

    await (manager as any).syncAlpacaAccount();

    const rows = getOpenTrades("meanrev_stocks");
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("XLP");
    expect(rows[0].entryPrice).toBe(72.5);
    expect(rows[0].quantity).toBe(58);
    const raw = getDB().prepare(`SELECT id, strategy FROM trades WHERE symbol = 'XLP'`).get() as any;
    expect(raw.strategy).toBe("SYNC_RECOVERY");
    expect(raw.id.startsWith("sync_")).toBe(false); // bot-managed, not BrokerSync-owned

    // (b) now visible to the stop-loss loop, which sources from getOpenTrades(id).
    expect(getOpenTrades("meanrev_stocks").some(t => t.symbol === "XLP")).toBe(true);
  });

  test("does NOT adopt within the grace window", async () => {
    const manager = managerWith({
      isConnected: () => true,
      getAccount: async () => ({ equity: "100000", cash: "50000" }),
      getPositions: async () => [brokerPos()],
    });

    await (manager as any).syncAlpacaAccount();

    expect(getOpenTrades("meanrev_stocks")).toHaveLength(0);
  });

  test("a MOMENTUM_STOCKS_UNIVERSE orphan is adopted into momentum_stocks (never meanrev) AND gets its native stop in the same pass", async () => {
    // The other half of the XLP incident class: BrokerSync skips it as
    // sleeve-owned, and the old meanrev-only filter here adopted it into
    // NOTHING — no DB row ⇒ no 15s stop, no native GTC stop, forever.
    const stopCalls: any[] = [];
    const manager = managerWith({
      isConnected: () => true,
      getAccount: async () => ({ equity: "100000", cash: "50000" }),
      getPositions: async () => [brokerPos({ symbol: "AAPL" })], // momentum_stocks universe
      getOpenStopOrders: async () => [],
      cancelOrderById: async () => true,
      getOrderStateByClientId: async () => null,
      getOrderById: async () => null,
      placeStopLossOrder: async (p: any) => { stopCalls.push(p); return { ok: true, orderId: "stop-1" }; },
    });

    for (let i = 0; i < 3; i++) await (manager as any).syncAlpacaAccount();

    const rows = getOpenTrades("momentum_stocks");
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("AAPL");
    const raw = getDB().prepare(`SELECT strategy FROM trades WHERE symbol = 'AAPL'`).get() as any;
    expect(raw.strategy).toBe("SYNC_RECOVERY");
    // Disjoint universes ⇒ exactly ONE owner — never a row under both sleeves.
    expect(getOpenTrades("meanrev_stocks")).toHaveLength(0);
    // ensureAlpacaNativeStops runs after adoption in the SAME sync pass:
    // the recovered position is armed immediately, not naked until later.
    expect(stopCalls.some(c => c.symbol === "AAPL" && c.accountId === "momentum_stocks")).toBe(true);
  });

  test("a symbol in NEITHER universe stays out of both sleeves (BrokerSync's to adopt under *_main)", async () => {
    const manager = managerWith({
      isConnected: () => true,
      getAccount: async () => ({ equity: "100000", cash: "50000" }),
      getPositions: async () => [brokerPos({ symbol: "TSLA" })], // no sleeve universe
    });

    for (let i = 0; i < 5; i++) await (manager as any).syncAlpacaAccount();

    expect(getOpenTrades("meanrev_stocks")).toHaveLength(0);
    expect(getOpenTrades("momentum_stocks")).toHaveLength(0);
  });

  test("refuses to adopt a position with a non-finite entry price — does not fabricate a basis", async () => {
    const manager = managerWith({
      isConnected: () => true,
      getAccount: async () => ({ equity: "100000", cash: "50000" }),
      getPositions: async () => [brokerPos({ avgEntryPrice: NaN })],
    });

    for (let i = 0; i < 5; i++) await (manager as any).syncAlpacaAccount();

    expect(getOpenTrades("meanrev_stocks")).toHaveLength(0);
  });

  test("pages ONE aggregated ERROR_BURST on adoption, not silent", async () => {
    const manager = managerWith({
      isConnected: () => true,
      getAccount: async () => ({ equity: "100000", cash: "50000" }),
      getPositions: async () => [brokerPos()],
    });
    const { bursts, detach } = captureBursts();

    for (let i = 0; i < 3; i++) await (manager as any).syncAlpacaAccount();

    detach();
    expect(bursts).toHaveLength(1);
    expect(bursts[0].message).toContain("XLP");
  });
});
