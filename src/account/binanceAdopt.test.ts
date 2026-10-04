// §2b Binance orphan adoption is UNCONDITIONAL (single-deployment
// consolidation, 2026-07-29): this process is the sole trader of the Binance
// account, so an untracked broker position is always ours to recover. The
// adoption must arm a broker-native stop first (verified read-back, same
// pattern as the USDC sibling — usdcAdopt.test.ts) and emergency-close
// instead of adopting when the stop can't be verified.

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDB, getOpenTrades } from "../db/database";
import { RISK_PROFILES } from "../config/riskProfiles";
import { setBrokerTruthAvailable } from "../portfolio/truth";
import { makeTestDb } from "../test-support/db";
import { makeAccountManager } from "../test-support/account";

function managerWith(binance: any) {
  return makeAccountManager({
    binance: {
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 10_000, marginCash: 9_000, wallet: 10_000, unrealizedPnl: 0 }),
      getAccountTotal: async () => null,
      getRecentTrades: async () => [],
      hasFilledStopClose: async () => false,
      cancelAllOrders: async () => {},
      ...binance,
    },
    alpaca: { getCachedPrice: () => 0 },
  });
}

// Older than the 3-min adoption grace so adoption (not the grace) decides.
function brokerPos(overrides: Partial<Record<string, any>> = {}) {
  return {
    symbol: "ETHUSDT",
    positionAmt: 1.431,
    entryPrice: 2500,
    unrealizedProfit: 12.3,
    updateTime: Date.now() - 10 * 60_000,
    ...overrides,
  };
}

const STOP_PCT = RISK_PROFILES.momentum_crypto.stopLossPct;
const EXPECTED_STOP = 2500 * (1 - STOP_PCT / 100); // long → protective SELL below entry

/** A read-back that verifies the stop we just installed (protective SELL,
 *  full quantity, trigger at the expected stop price). */
const verifiedProtectiveOrders = async () => [{
  symbol: "ETHUSDT", side: "SELL", type: "STOP_MARKET",
  quantity: 1.431, triggerPrice: EXPECTED_STOP, reduceOnly: true,
}];

beforeAll(() => { makeTestDb(); });
beforeEach(() => {
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM equity_snapshots;");
  setBrokerTruthAvailable("binance", true);
});

describe("AccountManager syncBinanceFutures §2b orphan adoption", () => {
  test("adopts an untracked Binance position as a bot-managed SYNC_RECOVERY row (no env flag needed)", async () => {
    const manager = managerWith({
      getPositions: async () => [brokerPos()],
      placeStopMarketClose: async () => true,
      getOpenProtectiveOrders: verifiedProtectiveOrders,
    });

    await (manager as any).syncBinanceFutures();

    const rows = getOpenTrades("momentum_crypto");
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("ETH/USD");
    expect(rows[0].entryPrice).toBe(2500);
    expect(rows[0].quantity).toBe(1.431);
    const raw = getDB().prepare(`SELECT id, strategy FROM trades WHERE symbol = 'ETH/USD'`).get() as any;
    expect(raw.strategy).toBe("SYNC_RECOVERY");
    expect(raw.id.startsWith("sync_")).toBe(false); // bot-managed, not BrokerSync-owned
    // In-memory position map populated too — visible to stop-loss/rebalance.
    expect((manager as any).accounts.get("momentum_crypto").positions.has("ETH/USD")).toBe(true);
  });

  test("arms a broker-native stop on the adopted position (profile stopLossPct off entry, full quantity)", async () => {
    const stopCalls: any[] = [];
    const manager = managerWith({
      getPositions: async () => [brokerPos()],
      placeStopMarketClose: async (...args: any[]) => { stopCalls.push(args); return true; },
      getOpenProtectiveOrders: verifiedProtectiveOrders,
    });

    await (manager as any).syncBinanceFutures();

    expect(stopCalls).toHaveLength(1);
    const [symbol, side, stopPrice, quantity] = stopCalls[0];
    expect(symbol).toBe("ETH/USD");
    expect(side).toBe("buy"); // position side; executor derives the SELL close
    expect(stopPrice).toBeCloseTo(EXPECTED_STOP, 8);
    expect(quantity).toBe(1.431);
    expect(getOpenTrades("momentum_crypto")).toHaveLength(1); // stop verified → adopted
  });

  test("does NOT adopt when the stop can't be verified — emergency-closes the unprotected orphan instead (same as USDC path)", async () => {
    const closeArgs: any[] = [];
    let positionReads = 0;
    const manager = managerWith({
      getPositions: async () => {
        positionReads++;
        if (positionReads === 1) return [brokerPos()]; // sync-pass read
        if (positionReads === 2) return [brokerPos()]; // fresh pre-close re-read: still live
        return [];                                     // post-close verification: flat
      },
      placeStopMarketClose: async () => false, // stop install fails → unprotected orphan
      closePosition: async (...args: any[]) => {
        closeArgs.push(args);
        return { success: true, filledPrice: 2500, commission: 0, realizedPnl: 0 };
      },
    });

    await (manager as any).syncBinanceFutures();

    expect(closeArgs).toHaveLength(1);
    expect(closeArgs[0][0]).toBe("ETH/USD");
    expect(closeArgs[0][1]).toBe(1.431);
    expect(closeArgs[0][2]).toBe("buy");
    expect(getOpenTrades("momentum_crypto")).toHaveLength(0); // unprotected → not adopted
    expect((manager as any).accounts.get("momentum_crypto").positions.size).toBe(0);
  });

  test("still respects the 3-min grace before adopting (engine may be persisting the row)", async () => {
    let stops = 0;
    const manager = managerWith({
      getPositions: async () => [brokerPos({ updateTime: Date.now() - 10_000 })], // fresh
      placeStopMarketClose: async () => { stops++; return true; },
      getOpenProtectiveOrders: verifiedProtectiveOrders,
    });

    await (manager as any).syncBinanceFutures();

    expect(stops).toBe(0); // never touches the broker inside the grace window
    expect(getOpenTrades("momentum_crypto")).toHaveLength(0);
  });
});
