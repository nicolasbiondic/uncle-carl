// syncBinanceUsdc orphan adoption is UNCONDITIONAL (single-deployment
// consolidation, 2026-07-29 — same as its siblings binanceAdopt.test.ts,
// meanrevAdopt.test.ts): this process is the sole trader of the account, so
// an untracked broker position is always ours to recover. This path doesn't
// just adopt: it arms a broker-native stop first and EMERGENCY-CLOSES the
// position whenever the stop install can't be verified. Its emergency close
// is bounded to a fresh broker re-read (never the stale sync-pass aggregate).

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDB, getOpenTrades } from "../db/database";
import { RISK_PROFILES } from "../config/riskProfiles";
import { makeTestDb } from "../test-support/db";
import { makeAccountManager } from "../test-support/account";

function managerWithUsdc(usdc: Record<string, any>) {
  const manager = makeAccountManager({
    alpaca: { getCachedPrice: () => 0 },
  });
  manager.attachUsdcExecutor({
    isConnected: () => true,
    getBalance: async () => ({ marginEquity: 5_000, marginCash: 5_000, wallet: 5_000, unrealizedPnl: 0 }),
    getRecentTrades: async () => [],
    hasFilledStopClose: async () => false,
    getAlgoOrderHistory: async () => [],
    cancelAllOrders: async () => {},
    ...usdc,
  } as any);
  return manager;
}

// Older than the 3-min adoption grace so adoption (not the grace) decides.
function brokerPos(overrides: Partial<Record<string, any>> = {}) {
  return {
    symbol: "BTCUSDC",
    positionAmt: 0.5,
    entryPrice: 50_000,
    unrealizedProfit: 0,
    updateTime: Date.now() - 10 * 60_000,
    ...overrides,
  };
}

const STOP_PCT = RISK_PROFILES.momentum_crypto_usdc.stopLossPct;
const EXPECTED_STOP = 50_000 * (1 - STOP_PCT / 100); // long → protective SELL below entry

beforeAll(() => { makeTestDb(); });
beforeEach(() => {
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM equity_snapshots;");
});

describe("AccountManager syncBinanceUsdc orphan adoption", () => {
  test("adopts as a SYNC_RECOVERY row when the native stop is verified live (no env flag needed)", async () => {
    const stopCalls: any[] = [];
    const manager = managerWithUsdc({
      getPositions: async () => [brokerPos()],
      placeStopMarketClose: async (...args: any[]) => { stopCalls.push(args); return true; },
      getOpenProtectiveOrders: async () => [{
        symbol: "BTCUSDC", side: "SELL", type: "STOP_MARKET",
        quantity: 0.5, triggerPrice: EXPECTED_STOP, reduceOnly: true,
      }],
    });

    await (manager as any).syncBinanceUsdc();

    const rows = getOpenTrades("momentum_crypto_usdc");
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("BTC/USDC");
    expect(rows[0].quantity).toBe(0.5);
    const raw = getDB().prepare(`SELECT strategy FROM trades WHERE symbol = 'BTC/USDC'`).get() as any;
    expect(raw.strategy).toBe("SYNC_RECOVERY");
    // The stop the adoption armed: position side, expected trigger, full qty.
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0][0]).toBe("BTC/USDC");
    expect(stopCalls[0][1]).toBe("buy");
    expect(stopCalls[0][2]).toBeCloseTo(EXPECTED_STOP, 8);
    expect(stopCalls[0][3]).toBe(0.5);
  });

  test("emergency close is bounded to a FRESH broker re-read, never the stale sync-pass aggregate", async () => {
    const closeArgs: any[] = [];
    let positionReads = 0;
    const manager = managerWithUsdc({
      getPositions: async () => {
        positionReads++;
        if (positionReads === 1) return [brokerPos()];                       // sync-pass read: 0.5
        if (positionReads === 2) return [brokerPos({ positionAmt: 0.3 })];   // fresh pre-close re-read: shrank
        return [];                                                           // post-close verification: flat
      },
      placeStopMarketClose: async () => false, // stop install fails → unprotected orphan → emergency close
      closePosition: async (...args: any[]) => {
        closeArgs.push(args);
        return { success: true, filledPrice: 50_000, commission: 0, realizedPnl: 0 };
      },
    });

    await (manager as any).syncBinanceUsdc();

    expect(closeArgs).toHaveLength(1);
    expect(closeArgs[0][0]).toBe("BTC/USDC");
    expect(closeArgs[0][1]).toBe(0.3); // min(sync-pass 0.5, fresh 0.3) — the bound under test
    expect(getOpenTrades("momentum_crypto_usdc")).toHaveLength(0); // unprotected → not adopted
  });

  test("orphan that went flat before the emergency close: nothing is closed, our just-installed stop is cleared", async () => {
    let closes = 0;
    const cancels: any[] = [];
    let positionReads = 0;
    const manager = managerWithUsdc({
      getPositions: async () => {
        positionReads++;
        return positionReads === 1 ? [brokerPos()] : []; // fresh re-read: flat
      },
      placeStopMarketClose: async () => false,
      closePosition: async () => { closes++; return { success: true, filledPrice: 1, commission: 0, realizedPnl: 0 }; },
      cancelAllOrders: async (...args: any[]) => { cancels.push(args); },
    });

    await (manager as any).syncBinanceUsdc();

    expect(closes).toBe(0);
    expect(cancels).toEqual([["BTC/USDC", { aggregateFlat: true }]]);
    expect(getOpenTrades("momentum_crypto_usdc")).toHaveLength(0);
  });
});
