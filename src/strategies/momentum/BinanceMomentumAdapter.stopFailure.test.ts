// ══════════════════════════════════════════════
// BinanceMomentumAdapter.openPosition — native STOP_MARKET install failure
// (2026-07-19 reviewer finding).
//
// The broker-native stop is the ONLY unattended protection for an open
// crypto position. Before this fix, a failed install was logged/paged but
// openPosition still returned { ok: true } — a live, genuinely unprotected
// position reported as a successful open. It must instead emergency-close
// the just-opened position, verify flatness, cancel only its OWN owned
// stop/orders, and never report success.
// ══════════════════════════════════════════════

import { describe, test, expect, beforeAll } from "bun:test";
import { getDB } from "../../db/database";
import { eventBus, EVENTS } from "../../utils/events";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { makeTestDb } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
});

function captureBurst(): { count: number; messages: string[] } {
  const cap = { count: 0, messages: [] as string[] };
  eventBus.on(EVENTS.ERROR_BURST, (d: any) => { cap.count++; cap.messages.push(String(d?.message ?? "")); });
  return cap;
}

describe("BinanceMomentumAdapter.openPosition — native stop install failure", () => {
  test("stop fails, emergency close succeeds -> ok:false (never a false success), native SL cleared, no DB row", async () => {
    const calls = { close: 0, cancel: 0 };
    let posCalls = 0;
    const bin = {
      isConnected: () => true,
      getPrice: async () => 100,
      getExecutableQuote: async () => null,
      placeOrder: async (_sig: any, qty: number) => ({ id: "stop-fail-close-ok", quantity: qty, filledPrice: 100 }),
      // Call 1: final-quantity read after the fill (still live). Call 2: the
      // ALWAYS reread after closePosition reports success (confirmed flat).
      getPositions: async () => {
        posCalls++;
        return posCalls === 1 ? [{ symbol: "BTCUSDT", positionAmt: 5, entryPrice: 100 }] : [];
      },
      placeStopMarketClose: async () => false, // install fails
      closePosition: async (_sym: string, _qty: number, _side: string) => { calls.close++; return { success: true, filledPrice: 100, commission: 0, realizedPnl: 0 }; },
      cancelAllOrders: async () => { calls.cancel++; },
    } as any;
    const burst = captureBurst();

    const res = await new BinanceMomentumAdapter({} as any, bin).openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 500 });

    expect(res).toEqual({ ok: false, reason: "native_stop_failed_position_closed" });
    expect(calls.close).toBe(1);
    expect(calls.cancel).toBe(1);
    expect(burst.count).toBeGreaterThanOrEqual(1);
    const row = getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE id = 'stop-fail-close-ok' AND status = 'open'`).get() as any;
    expect(row.c).toBe(0); // never persisted as an open position
  });

  test("stop fails, emergency close is unconfirmed, but broker positively confirms flat -> ok:false, reconciled (no orphan)", async () => {
    let posCalls = 0;
    const calls = { close: 0, cancel: 0 };
    const bin = {
      isConnected: () => true,
      getPrice: async () => 100,
      getExecutableQuote: async () => null,
      placeOrder: async (_sig: any, qty: number) => ({ id: "stop-fail-unconfirmed-flat", quantity: qty, filledPrice: 100 }),
      getPositions: async () => {
        posCalls++;
        // Call 1: final-quantity read after the fill (still live).
        // Call 2: flatness re-check after the unconfirmed emergency close.
        return posCalls === 1 ? [{ symbol: "BTCUSDT", positionAmt: 5, entryPrice: 100 }] : [];
      },
      placeStopMarketClose: async () => false,
      closePosition: async () => { calls.close++; return { success: false, filledPrice: 0, commission: 0, realizedPnl: 0 }; },
      cancelAllOrders: async () => { calls.cancel++; },
    } as any;

    const res = await new BinanceMomentumAdapter({} as any, bin).openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 500 });

    expect(res).toEqual({ ok: false, reason: "native_stop_failed_position_closed" });
    expect(calls.close).toBe(1);
    expect(calls.cancel).toBe(1); // cleanup after the positive flatness confirmation
  });

  test("stop fails, close unconfirmed, broker STILL shows the position live -> ok:false, loud ORPHAN, no cleanup call (nothing to clear)", async () => {
    const calls = { close: 0, cancel: 0 };
    const bin = {
      isConnected: () => true,
      getPrice: async () => 100,
      getExecutableQuote: async () => null,
      placeOrder: async (_sig: any, qty: number) => ({ id: "stop-fail-orphan", quantity: qty, filledPrice: 100 }),
      getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: 5, entryPrice: 100 }], // always live
      placeStopMarketClose: async () => false,
      closePosition: async () => { calls.close++; return { success: false, filledPrice: 0, commission: 0, realizedPnl: 0 }; },
      cancelAllOrders: async () => { calls.cancel++; },
    } as any;

    const res = await new BinanceMomentumAdapter({} as any, bin).openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 500 });

    expect(res.ok).toBe(false);
    expect(res.reason).toBeUndefined(); // orphan signature: ok:false with no reason
    expect(calls.close).toBe(1);
    expect(calls.cancel).toBe(0); // never claims cleanup on a position that's still live
  });

  test("USDC adapter's emergency close is product-scoped — only its own symbol, never a USDT sibling", async () => {
    const closedSymbols: string[] = [];
    let posCalls = 0;
    const bin = {
      isConnected: () => true,
      getPrice: async () => 50000,
      getExecutableQuote: async () => null,
      placeOrder: async (_sig: any, qty: number) => ({ id: "stop-fail-usdc", quantity: qty, filledPrice: 50000 }),
      getPositions: async () => {
        posCalls++;
        return posCalls === 1 ? [{ symbol: "BTCUSDC", positionAmt: 0.1, entryPrice: 50000 }] : [];
      },
      placeStopMarketClose: async () => false,
      closePosition: async (sym: string) => { closedSymbols.push(sym); return { success: true, filledPrice: 50000, commission: 0, realizedPnl: 0 }; },
      cancelAllOrders: async () => {},
    } as any;

    const res = await new BinanceMomentumAdapter({} as any, bin, { accountId: "momentum_crypto_usdc", quoteAsset: "USDC" })
      .openPosition({ symbol: "BTC/USDC", side: "buy", notionalUsd: 1000 });

    expect(res.ok).toBe(false);
    expect(closedSymbols).toEqual(["BTC/USDC"]); // never "BTC/USD"
  });
});
