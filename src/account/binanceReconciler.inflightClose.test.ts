// ══════════════════════════════════════════════
// P0 (2026-10-09) — MANUAL_CLOSE mis-attribution fix.
//
// Incident 2026-10-02: the 60s sync labeled MANUAL_CLOSE three closes the
// momentum_crypto ENGINE made at its decision minute (SOL 08:00:17, XRP
// 15:00:18, SOL 16:00:18 UTC). Race: the engine's broker close fills, the
// sync pass sees the position flat while the adapter's DB write is still in
// flight, attributes the engine's own fills, and closes the row as
// MANUAL_CLOSE 2–3 s before the adapter would have written the real label.
//
// Fix: src/sync/inflightCloses.ts — the adapter registers the close before
// submitting it and the reconciler defers that row while the entry is fresh.
// P&L is untouched (the adapter's own close writes the same broker-derived
// figures it always did); only the ATTRIBUTION changes.
// ══════════════════════════════════════════════

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDB, initDatabase, insertTrade } from "../db/database";
import { AccountManager } from "./AccountManager";
import { BinanceMomentumAdapter } from "../strategies/momentum/BinanceMomentumAdapter";
import {
  beginEngineClose, endEngineClose, hasInflightEngineClose,
  resetInflightClosesForTests, INFLIGHT_CLOSE_MAX_AGE_MS,
} from "../sync/inflightCloses";

beforeAll(() => initDatabase(":memory:"));
beforeEach(() => {
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM equity_snapshots; DELETE FROM fills;");
  resetInflightClosesForTests();
});

const ENTRY = Date.now() - 3 * 3_600_000;

function seedOpenSol(id = "sol-row") {
  insertTrade({
    id, symbol: "SOL/USD", market: "crypto", side: "buy", strategy: "MOMENTUM",
    entryPrice: 200, quantity: 5, entryTime: ENTRY, status: "open",
  } as any, "momentum_crypto");
}

/** AccountManager whose Binance executor reports SOL flat with an
 *  attributable closing fill — exactly what the sync saw on 2026-10-02. */
function managerSeeingFlatSol(overrides: Record<string, any> = {}) {
  return new AccountManager({
    binance: {
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 10_000, marginCash: 9_000, wallet: 10_000, unrealizedPnl: 0 }),
      getAccountTotal: async () => null,
      getPositions: async () => [], // flat on the broker
      getRecentTrades: async () => [
        { realizedPnl: 5.93, commission: 0.4, price: 205, qty: 5, side: "SELL", time: Date.now() - 2_000 },
      ],
      hasFilledStopClose: async () => false,
      getAlgoOrderHistory: async () => [],
      cancelAllOrders: async () => {},
      ...overrides,
    },
    alpaca: { getCachedPrice: () => 0 },
    osm: {},
  } as any);
}

const rowOf = (id: string) =>
  getDB().prepare(`SELECT status, close_reason FROM trades WHERE id = ?`).get(id) as any;

describe("in-flight engine close vs the 60s sync (2026-10-02 incident)", () => {
  test("REPRODUCTION: while the engine's close is in flight, the sync must NOT close the row as MANUAL_CLOSE", async () => {
    seedOpenSol();
    // The engine decided and submitted its broker close; the adapter's DB
    // write hasn't landed yet.
    beginEngineClose("momentum_crypto", "SOL/USD");

    await (managerSeeingFlatSol() as any).syncBinanceFutures();

    // Without the registry the reconciler attributes the engine's own fill
    // and writes MANUAL_CLOSE here — the exact mislabel of 2026-10-02.
    expect(rowOf("sol-row")).toEqual({ status: "open", close_reason: null });
  });

  test("after the adapter finishes (endEngineClose), the sync reconciles a genuinely external close as MANUAL_CLOSE again", async () => {
    seedOpenSol();
    beginEngineClose("momentum_crypto", "SOL/USD");
    endEngineClose("momentum_crypto", "SOL/USD");

    await (managerSeeingFlatSol() as any).syncBinanceFutures();

    expect(rowOf("sol-row")).toEqual({ status: "closed", close_reason: "MANUAL_CLOSE" });
  });

  test("a stale in-flight entry expires after INFLIGHT_CLOSE_MAX_AGE_MS — a crashed adapter can't block reconciliation forever", async () => {
    seedOpenSol();
    beginEngineClose("momentum_crypto", "SOL/USD", Date.now() - INFLIGHT_CLOSE_MAX_AGE_MS - 1_000);

    expect(hasInflightEngineClose("momentum_crypto", "SOL/USD")).toBe(false);
    await (managerSeeingFlatSol() as any).syncBinanceFutures();
    expect(rowOf("sol-row").status).toBe("closed");
  });

  test("the registry is scoped per portfolio+symbol — another sleeve's close never shields this row", async () => {
    seedOpenSol();
    beginEngineClose("momentum_crypto_usdc", "SOL/USD"); // different portfolio
    beginEngineClose("momentum_crypto", "XRP/USD");      // different symbol

    await (managerSeeingFlatSol() as any).syncBinanceFutures();
    expect(rowOf("sol-row").status).toBe("closed");
  });
});

describe("END-TO-END: engine close racing the sync keeps the ENGINE's close_reason and P&L", () => {
  test("sync pass lands mid-close → the row ends MOMENTUM_REBALANCE with the adapter's broker-derived PnL, not MANUAL_CLOSE", async () => {
    seedOpenSol("sol-e2e");

    // Fake broker: SOL live for the adapter's pre-close read; the close fill
    // resolves only when WE release it, so the sync pass can land in the
    // window between the broker fill and the adapter's DB write.
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((r) => { releaseClose = r; });
    const binance = {
      isConnected: () => true,
      getQuoteAsset: () => "USDT",
      getPositions: async () => [{ symbol: "SOLUSDT", positionAmt: 5, entryPrice: 200, unrealizedProfit: 25, updateTime: ENTRY }],
      cancelAllOrders: async () => {},
      closePosition: async () => {
        await closeGate; // broker already filled; response in flight
        return { success: true, filledPrice: 205, realizedPnl: 25, commission: 0.4 };
      },
    };
    const adapter = new BinanceMomentumAdapter({ getBars: async () => [] } as any, binance as any, { accountId: "momentum_crypto", quoteAsset: "USDT" } as any);

    const closing = adapter.closePosition({ symbol: "SOL/USD", side: "buy" });
    await new Promise((r) => setTimeout(r, 10)); // adapter is now awaiting the broker response

    // The 60s sync fires in that window and sees the position already flat
    // with an attributable fill.
    await (managerSeeingFlatSol() as any).syncBinanceFutures();
    expect(rowOf("sol-e2e").status).toBe("open"); // sync deferred, not MANUAL_CLOSE

    releaseClose();
    const res = await closing;
    expect(res.ok).toBe(true);

    const row = getDB().prepare(`SELECT status, close_reason, pnl FROM trades WHERE id = ?`).get("sol-e2e") as any;
    expect(row.status).toBe("closed");
    expect(row.close_reason).toBe("MOMENTUM_REBALANCE"); // the engine's label, never MANUAL_CLOSE
    expect(row.pnl).toBeCloseTo(25 - 0.4, 6); // broker realizedPnl − close commission − open commission(0)
  });
});
