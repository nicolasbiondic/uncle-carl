import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDB, saveEquitySnapshot } from "../db/database";
import { getBrokerSnapshotNow, setBrokerTruthAvailable } from "../portfolio/truth";
import { makeTestDb, seedOpenTrade } from "../test-support/db";
import { makeAccountManager } from "../test-support/account";

const ENTRY_TIME = Date.now() - 60_000;

function seedOpen(id: string) {
  seedOpenTrade(id, "momentum_crypto", {
    symbol: "BTC/USD",
    market: "crypto",
    entryTime: ENTRY_TIME,
    openCommission: 2,
  });
}

function managerWith(binance: any) {
  return makeAccountManager({ binance });
}

beforeAll(() => { makeTestDb(); });
beforeEach(() => {
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM equity_snapshots;");
  setBrokerTruthAvailable("binance", true);
});

describe("AccountManager Binance native-stop reconciliation", () => {
  test("attributes closing fills since entry and records a real broker stop outcome", async () => {
    seedOpen("native-stop");
    const calls: any[] = [];
    const manager = managerWith({
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 10_000, marginCash: 9_000, wallet: 10_000, unrealizedPnl: 0 }),
      getAccountTotal: async () => null,
      getPositions: async () => [],
      getRecentTrades: async (...args: any[]) => {
        calls.push(args);
        return [
          { realizedPnl: -99, commission: 9, price: 50, qty: 1, side: "SELL", time: ENTRY_TIME - 1 },
          { realizedPnl: 0, commission: 2, price: 100, qty: 1, side: "BUY", time: ENTRY_TIME + 1 },
          { realizedPnl: -5, commission: 0.4, price: 90, qty: 0.4, side: "SELL", time: ENTRY_TIME + 2 },
          { realizedPnl: -6, commission: 0.6, price: 89, qty: 0.6, side: "SELL", time: ENTRY_TIME + 3 },
        ];
      },
      hasFilledStopClose: async () => true,
      getPrice: async () => 999,
    });

    await (manager as any).syncBinanceFutures();

    expect(calls).toEqual([["BTCUSDT", 1000, ENTRY_TIME]]);
    const row = getDB().prepare(
      `SELECT status, exit_price, pnl, open_commission, close_commission, close_reason
       FROM trades WHERE id = 'native-stop'`
    ).get() as any;
    expect(row.status).toBe("closed");
    expect(row.exit_price).toBeCloseTo(89.4, 8);
    expect(row.pnl).toBe(-14);
    expect(row.open_commission).toBe(2);
    expect(row.close_commission).toBe(1);
    expect(row.close_reason).toBe("BROKER_STOP_LOSS");
  });

  test("flat broker without stop-order evidence is attributed as external manual close", async () => {
    seedOpen("manual-close");
    const manager = managerWith({
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 10_000, marginCash: 9_000, wallet: 10_000, unrealizedPnl: 0 }),
      getAccountTotal: async () => null,
      getPositions: async () => [],
      getRecentTrades: async () => [
        { realizedPnl: 3, commission: 0.5, price: 103, qty: 1, side: "SELL", time: ENTRY_TIME + 10 },
      ],
      hasFilledStopClose: async () => false,
      getAlgoOrderHistory: async () => [], // both stores read OK and both say no → positively NOT a stop
      getPrice: async () => 999,
    });

    await (manager as any).syncBinanceFutures();

    const row = getDB().prepare(`SELECT status, close_reason, exit_time FROM trades WHERE id = 'manual-close'`).get() as any;
    expect(row.status).toBe("closed");
    // A real closing fill WAS found (getRecentTrades) → this is a reconciled
    // external close = MANUAL_CLOSE. *_UNRECONCILED is now reserved strictly for
    // the no-settlement fallback (reviewer fix 2026-07-21).
    expect(row.close_reason).toBe("MANUAL_CLOSE");
    expect(row.exit_time).toBe(ENTRY_TIME + 10);
  });

  test("leaves DB state untouched when the broker position read is unavailable", async () => {
    seedOpen("position-read-failed");
    let tradeReads = 0;
    const manager = managerWith({
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 10_000, marginCash: 9_000, wallet: 10_000, unrealizedPnl: 0 }),
      getAccountTotal: async () => null,
      getPositions: async () => { throw new Error("positionRisk unavailable"); },
      getRecentTrades: async () => { tradeReads++; return []; },
      hasFilledStopClose: async () => false,
    });

    await (manager as any).syncBinanceFutures();

    const row = getDB().prepare(`SELECT status, close_reason FROM trades WHERE id = 'position-read-failed'`).get() as any;
    expect(row).toEqual({ status: "open", close_reason: null });
    expect(tradeReads).toBe(0);
  });

  test("unreconciled flat-broker position escalates to MANUAL_CLOSE_UNRECONCILED after N cycles", async () => {
    seedOpen("unreconciled-escalation");
    const manager = managerWith({
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 10_000, marginCash: 9_000, wallet: 10_000, unrealizedPnl: 0 }),
      getAccountTotal: async () => null,
      getPositions: async () => [],
      getRecentTrades: async () => [],
    });

    for (let cycle = 0; cycle < 4; cycle++) {
      await (manager as any).syncBinanceFutures();
    }
    expect(getDB().prepare(`SELECT status FROM trades WHERE id = 'unreconciled-escalation'`).get()).toEqual({ status: "open" });
    expect(getDB().prepare(`SELECT COUNT(*) AS count FROM activity_log WHERE account_id = 'momentum_crypto' AND event_type = 'circuit'`).get()).toEqual({ count: 0 });

    await (manager as any).syncBinanceFutures();

    const row = getDB().prepare(`SELECT status, close_reason FROM trades WHERE id = 'unreconciled-escalation'`).get() as any;
    expect(row).toEqual({ status: "closed", close_reason: "MANUAL_CLOSE_UNRECONCILED" });
    expect(getDB().prepare(`SELECT COUNT(*) AS count FROM activity_log WHERE account_id = 'momentum_crypto' AND event_type = 'circuit'`).get()).toEqual({ count: 1 });
  });

  test("margin sync + positions resolve WITHOUT waiting for the slow account-total refresh; releasing it lands binance_main via the null→valid auto-write", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const manager = managerWith({
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 4675.0407, marginCash: 2004.9246, wallet: 4442.9792, unrealizedPnl: 232.0615 }),
      getAccountTotal: async () => { await gate; return { equity: 10322.5407, cash: 7652.4246 }; },
      getPositions: async () => [],
      getRecentTrades: async () => [],
    });
    (manager as any).running = true; // enables the null→valid auto-snapshot-write

    await (manager as any).syncBinanceFutures();

    // Margin sleeve + positions are already resolved even though the
    // account-total gate is still closed — proof syncBinanceFutures never
    // awaits getAccountTotal (reviewer P1, 2026-07-18).
    expect((manager as any).accounts.get("momentum_crypto").equity.equity).toBe(4675.0407);
    expect((manager as any).binanceMainTruth).toBeNull();
    expect(getDB().prepare(`SELECT COUNT(*) AS count FROM equity_snapshots WHERE profile_id = 'binance_main'`).get()).toEqual({ count: 0 });

    releaseGate();
    await new Promise((r) => setTimeout(r, 0)); // flush the deferred refresh's microtasks

    expect((manager as any).binanceMainTruth).toEqual({ equity: 10322.5407, cash: 7652.4246 });
    const latest = getDB().prepare(
      `SELECT equity, cash FROM equity_snapshots WHERE profile_id = 'binance_main' ORDER BY snapshot_time DESC LIMIT 1`
    ).get() as any;
    expect(latest.equity).toBe(10322.5407);
    expect(latest.cash).toBe(7652.4246);
    expect((manager as any).accounts.get("momentum_crypto").equity.equity).toBe(4675.0407);
  });

  test("updates the margin sleeve but does not cache a partial account total", async () => {
    const manager = managerWith({
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 4675.0407, marginCash: 2004.9246, wallet: 4442.9792, unrealizedPnl: 232.0615 }),
      getAccountTotal: async () => null,
      getPositions: async () => [],
      getRecentTrades: async () => [],
    });
    (manager as any).running = true;

    await (manager as any).syncBinanceFutures();
    await new Promise((r) => setTimeout(r, 0)); // flush the deferred refresh
    (manager as any).writeAllSnapshots();

    expect((manager as any).accounts.get("momentum_crypto").equity.equity).toBe(4675.0407);
    expect((manager as any).binanceMainTruth).toBeNull();
    expect(getDB().prepare(`SELECT COUNT(*) AS count FROM equity_snapshots WHERE profile_id = 'binance_main'`).get()).toEqual({ count: 0 });
  });

  test("an unavailable account-total refresh invalidates the prior persisted total", async () => {
    saveEquitySnapshot("binance_main", 10_322.54, 7_652.42, 0);
    const manager = managerWith({
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 4_675.04, marginCash: 2_004.92, wallet: 4_442.98, unrealizedPnl: 232.06 }),
      getAccountTotal: async () => null,
      getPositions: async () => [],
      getRecentTrades: async () => [],
    });

    expect(getBrokerSnapshotNow("binance")?.equity).toBe(10_322.54);
    await (manager as any).syncBinanceFutures();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getBrokerSnapshotNow("binance")).toBeNull();
    expect(getDB().prepare(`SELECT COUNT(*) AS count FROM equity_snapshots WHERE profile_id = 'binance_main'`).get()).toEqual({ count: 1 });
  });
});
