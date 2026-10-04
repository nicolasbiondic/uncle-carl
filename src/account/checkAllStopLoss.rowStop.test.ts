// ══════════════════════════════════════════════
// checkAllStopLoss / Binance stopConfirm — row-stop precedence (OPEN.md P2)
// ══════════════════════════════════════════════
//
// Closes half the vol-stop chain OPEN.md flagged as unfixtured: no test
// seeded `stop_loss` ≠ the profile's fixed pct and drove the 15s loop or
// the Binance stopConfirm path through it. Both consume the row's stop via
// `rowStopPct` (AccountManager.ts) — see volStopEntry.test.ts for the rest
// of the chain (engine → adapter → persisted price).

import { describe, test, expect, beforeAll } from "bun:test";
import { getDB } from "../db/database";
import { makeTestDb, seedOpenTrade } from "../test-support/db";
import { makeAccountManager } from "../test-support/account";

/** Freeze Date at a US-market-open instant — checkAllStopLoss skips stock
 *  closes while the market is closed. Same idiom as accountManager.test.ts /
 *  orchestration.test.ts (local here too: test files can't import each other). */
async function withMarketOpen<T>(fn: () => Promise<T>): Promise<T> {
  const realDate = Date;
  const openNow = realDate.parse("2026-07-24T14:00:00.000Z");
  globalThis.Date = class extends realDate {
    constructor(...args: any[]) { super(args.length ? args[0] : openNow); }
    static now() { return openNow; }
  } as DateConstructor;
  const realLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    globalThis.Date = realDate;
  }
}

function rowStatus(id: string) {
  return getDB().prepare("SELECT status, close_reason FROM trades WHERE id = ?").get(id) as any;
}

beforeAll(() => { makeTestDb(); });

describe("checkAllStopLoss (15s loop) — row's stop_loss takes precedence over the profile's fixed pct", () => {
  // Falsifier: reverting the loop to `acc.profile.stopLossPct` (ignoring
  // rowStopPct) would close this row at the -5% breach below — the 8%
  // vol-scaled row stop must NOT fire there.
  test("8% row stop: -5% breach (> profile's 4%, < row's 8%) does NOT close; -8.5% breach DOES", async () => {
    // entry 100, stop_loss 92 → rowStopPct = 8% (vs profile momentum_stocks 4%).
    seedOpenTrade("row-stop-8pct", "momentum_stocks", {
      symbol: "AAPL", entryPrice: 100, quantity: 10, stopLoss: 92,
    });
    let price = 95; // -5%: breaches profile 4% but NOT the row's 8%
    let closeCalls = 0;
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getCachedPrice: () => 0,
        getRiskPrice: async () => price,
        closePosition: async () => { closeCalls++; return { success: true, filledPrice: price, commission: 0 }; },
      },
    });

    await withMarketOpen(() => (manager as any).checkAllStopLoss());
    expect(closeCalls).toBe(0);
    expect(rowStatus("row-stop-8pct")).toEqual({ status: "open", close_reason: null });

    price = 91.5; // -8.5%: breaches the row's 8% vol-scaled stop
    await withMarketOpen(() => (manager as any).checkAllStopLoss());
    expect(closeCalls).toBe(1);
    expect(rowStatus("row-stop-8pct")).toEqual({ status: "closed", close_reason: "STOP_LOSS" });
  });

  // Control: a row with NO persisted stop_loss (legacy) still closes at the
  // profile's fixed 4% — rowStopPct's fallback path stays wired.
  test("legacy row (no stop_loss) closes at the profile's fixed 4%", async () => {
    seedOpenTrade("row-stop-legacy", "momentum_stocks", {
      symbol: "MSFT", entryPrice: 100, quantity: 10,
    });
    let closeCalls = 0;
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getCachedPrice: () => 0,
        getRiskPrice: async () => 95, // -5%: breaches the 4% fallback
        closePosition: async () => { closeCalls++; return { success: true, filledPrice: 95, commission: 0 }; },
      },
    });

    await withMarketOpen(() => (manager as any).checkAllStopLoss());
    expect(closeCalls).toBe(1);
    expect(rowStatus("row-stop-legacy")).toEqual({ status: "closed", close_reason: "STOP_LOSS" });
  });
});

describe("closeTradeDirectly (Binance) — stopConfirm carries the ROW's stop pct, not the profile's", () => {
  // Falsifier: reverting `rowStopPct(trade, acc.profile.stopLossPct)` in the
  // stopConfirm builder to the bare profile constant would send 4 here
  // instead of the row's 6.
  test("6% row stop → closePosition's stopConfirm.stopLossPct is 6, not the profile's 4", async () => {
    seedOpenTrade("binance-row-stop-6pct", "momentum_crypto", {
      symbol: "BTC/USD", market: "crypto", entryPrice: 100, quantity: 1, stopLoss: 94,
    });
    const closeArgs: any[] = [];
    const manager = makeAccountManager({
      binance: {
        isConnected: () => true,
        getPrice: async () => 89, // -11%: breaches both the row's 6% and the profile's 4%
        closePosition: async (...args: any[]) => {
          closeArgs.push(args);
          return { success: true, filledPrice: 89, commission: 0, realizedPnl: -11 };
        },
      },
    });

    await (manager as any).checkAllStopLoss();

    expect(closeArgs).toHaveLength(1);
    const [, , , opts] = closeArgs[0];
    expect(opts.stopConfirm.stopLossPct).toBeCloseTo(6, 10);
    expect(rowStatus("binance-row-stop-6pct")).toEqual({ status: "closed", close_reason: "STOP_LOSS" });
  });
});
