// ══════════════════════════════════════════════
// AlpacaMomentumAdapter focused P1 fixes
// ══════════════════════════════════════════════
//
// Partial-fill honesty + DB close persistence failure handling.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { getDB } from "../../db/database";
import { eventBus, EVENTS } from "../../utils/events";
import { AlpacaMomentumAdapter } from "./AlpacaMomentumAdapter";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
});

beforeEach(() => {
  getDB().exec(`PRAGMA query_only = OFF`);
});

afterEach(() => {
  getDB().exec(`PRAGMA query_only = OFF`);
  getDB().exec(`DELETE FROM trades`);
  getDB().exec(`DELETE FROM orders`);
  getDB().exec(`DELETE FROM fills`);
  getDB().exec(`DELETE FROM signals`);
});

function captureBurst(): { fired: boolean; message?: string } {
  const cap: { fired: boolean; message?: string } = { fired: false };
  eventBus.once(EVENTS.ERROR_BURST, (d: any) => { cap.fired = true; cap.message = d?.message; });
  return cap;
}

describe("AlpacaMomentumAdapter.openPosition — partial fills", () => {
  test("persists actual filled qty/price, not the full requested qty", async () => {
    const alpaca = {
      isConnected: () => true,
      getCachedPrice: () => 100,
      getLatestPrice: async () => 100,
      getExecutableQuote: async () => null,
      getRegTBuyingPower: async () => null, // unknown → fail-open (guard has its own tests)
      placeOrder: async (_sig: any, qty: number) => ({
        id: "partial-alpaca",
        quantity: qty,
        status: "partial",
        filledPrice: 101,
        filledQty: 3,
        externalId: "broker-partial",
      }),
      pollOrderUntilFilled: async () => ({ status: "filled", filledPrice: 101, filledQty: 3 }),
      closePosition: async () => ({ success: true, filledPrice: 101 }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });

    expect(result).toEqual({ ok: true });
    const row = getDB().prepare(`SELECT quantity, entry_price FROM trades WHERE id = 'partial-alpaca'`).get() as any;
    expect(row).toEqual({ quantity: 3, entry_price: 101 });
  });

  test("fails without persisting when final fill is zero shares", async () => {
    const alpaca = {
      isConnected: () => true,
      getCachedPrice: () => 100,
      getLatestPrice: async () => 100,
      getExecutableQuote: async () => null,
      getRegTBuyingPower: async () => null, // unknown → fail-open (guard has its own tests)
      placeOrder: async (_sig: any, qty: number) => ({
        id: "tiny-alpaca",
        symbol: "AAPL",
        market: "stock",
        side: "buy",
        type: "market",
        quantity: qty,
        price: 100,
        status: "partial",
        filledPrice: 100,
        filledQty: 0,
        externalId: "broker-tiny",
      }),
      pollOrderUntilFilled: async () => ({ status: "filled", filledPrice: 100, filledQty: 0 }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("order not filled");
    const n = getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE id = 'tiny-alpaca'`).get() as any;
    expect(n.c).toBe(0);
  });
});

describe("AlpacaMomentumAdapter.getOpenPositions — account-scoped exposure read", () => {
  test("unchanged: with only same-strategy rows present, output is exactly what the account-scoped read has always returned", async () => {
    seedOpenTrade("exposure-momentum-1", "momentum_stocks", {
      symbol: "QQQ", entryPrice: 400, quantity: 2, entryTime: 1000,
    });

    const alpaca = { getCachedPrice: () => 410 } as any;
    const out = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" }).getOpenPositions();

    expect(out).toEqual([
      { symbol: "QQQ", side: "buy", quantity: 2, notional: 820, entryTime: 1000 },
    ]);
  });

  test("still reports a foreign-strategy (SYNC_RECOVERY) row as exposure, so the engine won't open a duplicate", async () => {
    seedOpenTrade("exposure-sync-recovery", "meanrev_stocks", {
      symbol: "XLE", strategy: "SYNC_RECOVERY", entryPrice: 80, quantity: 10, entryTime: 2000,
    });

    const alpaca = { getCachedPrice: () => 85 } as any;
    const out = await new AlpacaMomentumAdapter(alpaca, { accountId: "meanrev_stocks", strategy: "MEANREV" }).getOpenPositions();

    expect(out).toEqual([
      { symbol: "XLE", side: "buy", quantity: 10, notional: 850, entryTime: 2000 },
    ]);
  });
});

describe("AlpacaMomentumAdapter.closePosition — ownership before broker (aggregate-close P0, 2026-07-27)", () => {
  test("no open DB row → refuses WITHOUT calling the broker (the aggregate isn't ours to close)", async () => {
    let brokerCalls = 0;
    const alpaca = {
      isConnected: () => true,
      closePosition: async () => { brokerCalls++; return { success: true, filledPrice: 100 }; },
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .closePosition({ symbol: "XLP", side: "buy" });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("refusing to touch the aggregate");
    expect(brokerCalls).toBe(0);
  });

  test("forwards OUR row's quantity to the executor close (broker aggregate may be 2×)", async () => {
    seedOpenTrade("qty-bound-row", "momentum_stocks", {
      symbol: "UNH", entryPrice: 400, quantity: 11, entryTime: Date.now(),
    });

    const closeArgs: any[] = [];
    const alpaca = {
      isConnected: () => true,
      closePosition: async (...args: any[]) => { closeArgs.push(args); return { success: true, filledPrice: 405 }; },
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .closePosition({ symbol: "UNH", side: "buy" });

    expect(result.ok).toBe(true);
    expect(closeArgs).toHaveLength(1);
    expect(closeArgs[0][2]).toBe(11); // qty = OUR row, never undefined (whole-position)
  });
});

describe("AlpacaMomentumAdapter.closePosition — DB persistence failure", () => {
  test("pages ERROR_BURST and returns ok=false when DB close fails", async () => {
    seedOpenTrade("db-fail-alpaca", "momentum_stocks", { entryTime: Date.now() });

    const alpaca = {
      isConnected: () => true,
      closePosition: async () => ({ success: true, filledPrice: 105 }),
    } as any;

    // Make the connection read-only so the DB close transaction fails.
    getDB().exec(`PRAGMA query_only = ON`);
    const burst = captureBurst();
    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .closePosition({ symbol: "AAPL", side: "buy" });
    getDB().exec(`PRAGMA query_only = OFF`);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("broker closed; DB reconciliation pending");
    expect(burst.fired).toBe(true);
    expect(burst.message).toContain("DB close persist failed");
  });

  test("404 reconcile only ok when DB close persistence succeeds", async () => {
    seedOpenTrade("rec-ok-alpaca", "momentum_stocks", { entryTime: Date.now() });

    const alpaca = {
      isConnected: () => true,
      closePosition: async () => ({ success: false, filledPrice: 0, reason: "http_404" }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .closePosition({ symbol: "AAPL", side: "buy" });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("broker had no position; DB reconciled");
    const row = getDB().prepare(`SELECT status, close_reason FROM trades WHERE id = 'rec-ok-alpaca'`).get() as any;
    expect(row.status).toBe("closed");
    expect(row.close_reason).toBe("MOMENTUM_RECONCILED");
  });

  test("closes a SYNC_RECOVERY row (adopted-orphan, foreign strategy label) instead of looping ok:false forever", async () => {
    // Simulates AccountManager.ts ~1631-1641: an orphaned broker position
    // adopted into this SAME account_id under strategy 'SYNC_RECOVERY'
    // instead of this adapter's own strategy label ('MEANREV' here).
    seedOpenTrade("sync-recovery-row", "meanrev_stocks", {
      symbol: "XLE", strategy: "SYNC_RECOVERY", entryPrice: 80, quantity: 10, entryTime: Date.now(),
    });

    const alpaca = {
      isConnected: () => true,
      closePosition: async () => ({ success: true, filledPrice: 82 }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, {
      accountId: "meanrev_stocks", strategy: "MEANREV", closeReason: "MEANREV_EXIT",
    }).closePosition({ symbol: "XLE", side: "buy" });

    // Before the fix this returned {ok:false} forever (strategy mismatch:
    // the SELECT only matched 'MEANREV', never 'SYNC_RECOVERY') — the broker
    // was already flattened but the DB row stayed open, so the engine would
    // re-issue the close every tick with no way to ever persist it.
    expect(result).toEqual({ ok: true });
    const row = getDB().prepare(`SELECT status, close_reason FROM trades WHERE id = 'sync-recovery-row'`).get() as any;
    expect(row.status).toBe("closed");
    expect(row.close_reason).toBe("MEANREV_EXIT");
  });

  test("a normal strategy-owned row still closes exactly as today", async () => {
    seedOpenTrade("own-row-momentum", "momentum_stocks", {
      symbol: "SMH", entryPrice: 200, quantity: 4, entryTime: Date.now(),
    });

    const alpaca = {
      isConnected: () => true,
      closePosition: async () => ({ success: true, filledPrice: 205 }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .closePosition({ symbol: "SMH", side: "buy" });

    expect(result).toEqual({ ok: true });
    const row = getDB().prepare(`SELECT status, close_reason FROM trades WHERE id = 'own-row-momentum'`).get() as any;
    expect(row.status).toBe("closed");
    expect(row.close_reason).toBe("MOMENTUM_REBALANCE");
  });

  test("engine trail close persists close_reason=TRAIL_STOP; a signal-flip close stays MOMENTUM_REBALANCE (telemetry P2)", async () => {
    const alpaca = {
      isConnected: () => true,
      closePosition: async () => ({ success: true, filledPrice: 205 }),
    } as any;
    const adapter = new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" });

    // Trail-stop close: the engine passes the canonical TRAIL_STOP label.
    seedOpenTrade("trail-row", "momentum_stocks", { symbol: "SMH", entryPrice: 220, quantity: 4, entryTime: Date.now() });
    const trail = await adapter.closePosition({ symbol: "SMH", side: "buy", closeReason: "TRAIL_STOP" });
    expect(trail).toEqual({ ok: true });
    expect((getDB().prepare(`SELECT close_reason FROM trades WHERE id = 'trail-row'`).get() as any).close_reason)
      .toBe("TRAIL_STOP");

    // Signal flip: no closeReason → default rebalance label.
    seedOpenTrade("flip-row", "momentum_stocks", { symbol: "QQQ", entryPrice: 400, quantity: 2, entryTime: Date.now() });
    const flip = await adapter.closePosition({ symbol: "QQQ", side: "buy" });
    expect(flip).toEqual({ ok: true });
    expect((getDB().prepare(`SELECT close_reason FROM trades WHERE id = 'flip-row'`).get() as any).close_reason)
      .toBe("MOMENTUM_REBALANCE");

    // Non-canonical free text never lands in the column — falls back.
    seedOpenTrade("freetext-row", "momentum_stocks", { symbol: "UNH", entryPrice: 400, entryTime: Date.now() });
    const freetext = await adapter.closePosition({ symbol: "UNH", side: "buy", closeReason: "px dumped lol" });
    expect(freetext).toEqual({ ok: true });
    expect((getDB().prepare(`SELECT close_reason FROM trades WHERE id = 'freetext-row'`).get() as any).close_reason)
      .toBe("MOMENTUM_REBALANCE");
  });

  test("exit fill is recorded with direction-correct bid/ask and actual fill qty", async () => {
    seedOpenTrade("exit-fill-alpaca", "momentum_stocks", { quantity: 5, entryTime: Date.now() });

    const alpaca = {
      isConnected: () => true,
      getExecutableQuote: async () => ({ price: 99, timestamp: Date.now() }),
      closePosition: async () => ({
        success: true,
        filledPrice: 98.9,
        filledQty: 5,
        orderId: "exit-order-1",
        submittedAt: Date.now() - 100,
        submittedPx: 99,
        filledAt: Date.now(),
      }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .closePosition({ symbol: "AAPL", side: "buy" });

    expect(result.ok).toBe(true);
    const fill = getDB().prepare(`SELECT side, expected_px, submitted_px, filled_px, filled_qty, broker FROM fills WHERE trade_id = 'exit-fill-alpaca'`).get() as any;
    expect(fill).toEqual({
      side: "sell",
      expected_px: 99,
      submitted_px: 99,
      filled_px: 98.9,
      filled_qty: 5,
      broker: "alpaca",
    });
  });

  test("exit expected_px is the pre-close quote touch, distinct from submitted_px", async () => {
    seedOpenTrade("exit-distinct-alpaca", "momentum_stocks", { quantity: 3, entryTime: Date.now() });

    const alpaca = {
      isConnected: () => true,
      getExecutableQuote: async () => ({ price: 98.5, timestamp: Date.now() }), // pre-close bid touch
      closePosition: async () => ({
        success: true,
        filledPrice: 98.2,
        filledQty: 3,
        orderId: "exit-order-distinct",
        submittedAt: Date.now() - 50,
        submittedPx: 98.4, // quote AT submission — independent of the pre-close bid above
        filledAt: Date.now(),
      }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .closePosition({ symbol: "AAPL", side: "buy" });

    expect(result.ok).toBe(true);
    const fill = getDB().prepare(`SELECT expected_px, submitted_px, filled_px FROM fills WHERE trade_id = 'exit-distinct-alpaca'`).get() as any;
    expect(fill.expected_px).toBe(98.5);   // pre-close quote, NOT submitted_px
    expect(fill.submitted_px).toBe(98.4);  // still recorded independently
    expect(fill.filled_px).toBe(98.2);
  });

  test("exit pre-close quote requests the CLOSING side (sell for a held long)", async () => {
    seedOpenTrade("exit-side-alpaca", "momentum_stocks", { quantity: 1, entryTime: Date.now() });
    let quoteSide: string | undefined;
    const alpaca = {
      isConnected: () => true,
      getExecutableQuote: async (_symbol: string, side: string) => { quoteSide = side; return { price: 50, timestamp: Date.now() }; },
      closePosition: async () => ({ success: true, filledPrice: 50, filledQty: 1, orderId: "exit-side-order" }),
    } as any;

    await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" }).closePosition({ symbol: "AAPL", side: "buy" });
    expect(quoteSide).toBe("sell");
  });

  test("telemetry fail-open still closes without inventing a benchmark", async () => {
    seedOpenTrade("exit-fallback-alpaca", "momentum_stocks", { quantity: 2, entryTime: Date.now() });

    const alpaca = {
      isConnected: () => true,
      getExecutableQuote: async () => null,
      closePosition: async () => ({
        success: true,
        filledPrice: 97,
        filledQty: 2,
        orderId: "exit-order-2",
      }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .closePosition({ symbol: "AAPL", side: "buy" });

    expect(result.ok).toBe(true);
    const fill = getDB().prepare(`SELECT 1 FROM fills WHERE trade_id = 'exit-fallback-alpaca'`).get();
    expect(fill).toBeNull();
  });
});


describe("AlpacaMomentumAdapter.openPosition — sparse IEX tape (ABBV 2026-09-28)", () => {
  test("no <30s price: sizes the whole-share market order off getSizingPrice instead of refusing", async () => {
    const placed: number[] = [];
    const alpaca = {
      isConnected: () => true,
      getCachedPrice: () => 0,
      getLatestPrice: async () => 0,
      getSizingPrice: async () => 264.34,
      getExecutableQuote: async () => null,
      getRegTBuyingPower: async () => null,
      placeOrder: async (_sig: any, qty: number) => { placed.push(qty); return { id: "abbv-sizing", quantity: qty, status: "filled", filledPrice: 264.5, filledQty: qty, externalId: "b-abbv" }; },
      pollOrderUntilFilled: async () => ({ status: "filled", filledPrice: 264.5, filledQty: 22 }),
      closePosition: async () => ({ success: true, filledPrice: 264.5 }),
    } as any;
    const res = await new AlpacaMomentumAdapter(alpaca, { accountId: "meanrev_stocks", strategy: "MEANREV" } as any)
      .openPosition({ symbol: "ABBV", side: "buy", notionalUsd: 6_000 });
    expect(res).toEqual({ ok: true });
    expect(placed).toEqual([22]); // floor(6000 / 264.34)
  });

  test("no price at any tier → still refuses with the classifiable reason", async () => {
    const alpaca = { isConnected: () => true, getCachedPrice: () => 0, getLatestPrice: async () => 0, getSizingPrice: async () => 0 } as any;
    const res = await new AlpacaMomentumAdapter(alpaca, { accountId: "meanrev_stocks" } as any)
      .openPosition({ symbol: "ABBV", side: "buy", notionalUsd: 6_000 });
    expect(res).toEqual({ ok: false, reason: "no price for ABBV" });
  });
});
