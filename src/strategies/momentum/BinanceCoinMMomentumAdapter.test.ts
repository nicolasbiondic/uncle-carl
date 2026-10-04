// ══════════════════════════════════════════════
// BinanceCoinMMomentumAdapter — fixture-driven, real in-memory DB
// (matches the repo convention: fake the broker seam, use the real DB so
// persistence/PnL math is verified against actual rows, not mocked SQL).
// ══════════════════════════════════════════════

import { describe, test, expect, beforeAll } from "bun:test";
import { getDB } from "../../db/database";
import { eventBus, EVENTS } from "../../utils/events";
import { BinanceCoinMMomentumAdapter, COINM_INTERNAL_SYMBOL } from "./BinanceCoinMMomentumAdapter";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
  // Deterministic, real-SQLite way to force insertTrade to throw for the DB
  // persist-failure tests below — no module mocking needed. Any trade row
  // whose account_id matches this sentinel is rejected at the DB layer,
  // exactly like a real constraint violation/disk error would be.
  getDB().exec(`
    CREATE TRIGGER IF NOT EXISTS test_force_insert_trade_fail
    BEFORE INSERT ON trades
    WHEN NEW.account_id = 'coinm-force-insert-fail'
    BEGIN
      SELECT RAISE(ABORT, 'simulated insertTrade failure');
    END;
  `);
});

/** Capture every ERROR_BURST fired during a test (proves the page fires). */
function captureBursts(): { count: number; messages: string[] } {
  const cap = { count: 0, messages: [] as string[] };
  eventBus.on(EVENTS.ERROR_BURST, (d: any) => { cap.count++; cap.messages.push(String(d?.message ?? "")); });
  return cap;
}

const FILTERS = { status: "TRADING", marginAsset: "BTC", contractSize: 100, tickSize: 0.1, pricePrecision: 1, lotStepSize: 1, lotMinQty: 1, marketLotStepSize: 1, marketLotMinQty: 1 };

function fakeExecutor(overrides: Record<string, any> = {}) {
  const calls: Record<string, number> = {};
  const bump = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };
  return {
    calls,
    isConnected: () => true,
    toProductSymbol: (s: string) => (s === COINM_INTERNAL_SYMBOL ? "BTCUSD_PERP" : null),
    getConfig: () => ({ restBase: "https://testnet.binancefuture.com", timeoutMs: 1000 }),
    getFilters: async () => FILTERS,
    getMarkPrice: async () => 50_000,
    getEquityUsd: async () => 12_345,
    getOwnedPosition: async () => null,
    placeMarketOrder: async () => { bump("placeMarketOrder"); return { orderId: 1, clientOrderId: "cm1", status: "FILLED", avgPrice: 50_000, executedQty: 10 }; },
    placeStopMarketClose: async () => { bump("placeStopMarketClose"); return { ok: true, kind: "order", id: "stop1" }; },
    closePosition: async () => { bump("closePosition"); return { success: true, filledPrice: 55_000, executedQty: 10 }; },
    cancelActiveStop: async () => { bump("cancelActiveStop"); return true; },
    listOwnedStops: async () => { bump("listOwnedStops"); return []; }, // no owned stops visible by default
    ...overrides,
  } as any;
}

describe("product identity — only BTC/COIN-M is accepted", () => {
  test("openPosition rejects any other symbol without touching the executor", async () => {
    const exec = fakeExecutor();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t1" });
    const res = await adapter.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("unsupported symbol");
    expect(exec.calls.placeMarketOrder).toBeUndefined();
  });

  test("closePosition rejects any other symbol", async () => {
    const exec = fakeExecutor();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t1" });
    const res = await adapter.closePosition({ symbol: "BTC/USD", side: "buy" });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("unsupported symbol");
  });
});

describe("openPosition — inverse sizing + persistence", () => {
  test("computes integer contracts from notional/contractSize and persists the trade row", async () => {
    const exec = fakeExecutor();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-open-1", stopLossPct: 4 });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 }); // 1000/100 = 10 contracts
    expect(res).toEqual({ ok: true });
    expect(exec.calls.placeStopMarketClose).toBe(1);

    const row = getDB().prepare(`SELECT symbol, side, quantity, entry_price, status, stop_loss FROM trades WHERE account_id = 't-open-1'`).get() as any;
    expect(row.symbol).toBe(COINM_INTERNAL_SYMBOL);
    expect(row.side).toBe("buy");
    expect(row.quantity).toBe(10);          // contracts, not BTC size
    expect(row.entry_price).toBe(50_000);
    expect(row.status).toBe("open");
    expect(row.stop_loss).toBeCloseTo(50_000 * 0.96, 6);
  });

  test("returns ok:false when computed contracts <= 0 (bad contractSize)", async () => {
    const exec = fakeExecutor({ getFilters: async () => ({ ...FILTERS, contractSize: 0 }) });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-open-2" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "computed contracts <= 0" });
  });

  test("rejects a live target notional below one contract instead of silently sizing up to a full contract", async () => {
    const exec = fakeExecutor(); // contractSize 100, notional 50 -> sub-one-contract
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-open-tiny" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 50 });
    expect(res).toEqual({ ok: false, reason: "computed contracts <= 0" });
    expect(exec.calls.placeMarketOrder).toBeUndefined(); // never even attempted an order
  });

  test("returns ok:false without persisting when placeMarketOrder returns null (never fabricates a fill)", async () => {
    const exec = fakeExecutor({ placeMarketOrder: async () => null });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-open-3" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    const n = (getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = 't-open-3'`).get() as any).c;
    expect(n).toBe(0);
  });
});

describe("closePosition — explicit inverse PnL, bypasses closeTrade's linear formula", () => {
  test("long win: pnl = contracts*contractSize*(1/entry-1/exit)*exit, pnl_pct on constant notional", async () => {
    seedOpenTrade("coinm-long-1", "t-close-1", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(),
    });
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 55_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => ({ success: true, filledPrice: 55_000, executedQty: 10 }),
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-close-1" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res).toEqual({ ok: true });

    const row = getDB().prepare(`SELECT status, exit_price, pnl, pnl_pct FROM trades WHERE id = 'coinm-long-1'`).get() as any;
    const expectedPnl = 10 * 100 * (1 / 50_000 - 1 / 55_000) * 55_000; // BTC pnl converted to USD at exit
    const expectedPnlPct = (expectedPnl / (10 * 100)) * 100;
    // closeTrade()'s LINEAR formula would instead compute pnl_pct against
    // entry_price*quantity = 50000*10 = 500000 — proving this bypasses it.
    const linearFormulaPnlPct = (expectedPnl / (50_000 * 10)) * 100;
    expect(row.status).toBe("closed");
    expect(row.exit_price).toBe(55_000);
    expect(row.pnl).toBeCloseTo(expectedPnl, 6);
    expect(row.pnl_pct).toBeCloseTo(expectedPnlPct, 6);
    expect(row.pnl_pct).not.toBeCloseTo(linearFormulaPnlPct, 2);
  });

  test("short win: opposite-sign formula, positive pnl when price falls", async () => {
    seedOpenTrade("coinm-short-1", "t-close-2", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", side: "sell", entryPrice: 55_000, quantity: 4, entryTime: Date.now(),
    });
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: -4, entryPrice: 55_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => ({ success: true, filledPrice: 50_000, executedQty: 4 }),
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-close-2" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "sell" });
    expect(res).toEqual({ ok: true });

    const row = getDB().prepare(`SELECT pnl, pnl_pct FROM trades WHERE id = 'coinm-short-1'`).get() as any;
    const expectedPnl = 4 * 100 * (1 / 50_000 - 1 / 55_000) * 50_000;
    expect(expectedPnl).toBeGreaterThan(0); // short profits when price falls
    expect(row.pnl).toBeCloseTo(expectedPnl, 6);
  });

  test("clears the native stop and returns ok:false when the broker position is already flat", async () => {
    const exec = fakeExecutor({ getOwnedPosition: async () => null });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-close-3" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res.ok).toBe(false);
    expect(exec.calls.cancelActiveStop).toBe(1);
  });

  test("position read THROWS before closing — never claims flat, never cancels the protective stop (unknown state)", async () => {
    const exec = fakeExecutor({ getOwnedPosition: async () => { throw new Error("ECONNRESET"); } });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-close-unknown" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res).toEqual({ ok: false, reason: "position read failed; state unknown" });
    expect(exec.calls.cancelActiveStop).toBeUndefined(); // never cancelled on an unread/unknown state
    expect(exec.calls.closePosition).toBeUndefined(); // never even attempted a close without knowing what's live
  });

  test("returns ok:false when the broker close doesn't confirm (no DB mutation)", async () => {
    seedOpenTrade("coinm-noconfirm", "t-close-4", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 2, entryTime: Date.now(),
    });
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 2, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => ({ success: false, filledPrice: 0, executedQty: 0 }),
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-close-4" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res).toEqual({ ok: false, reason: "broker did not confirm close" });
    const row = getDB().prepare(`SELECT status FROM trades WHERE id = 'coinm-noconfirm'`).get() as any;
    expect(row.status).toBe("open");
  });
});

describe("closePosition — partial fills never mark a full close, remnant stays protected", () => {
  test("partial close reinstalls an exact-size native stop for the remnant, shrinks DB quantity, and returns failure (never ok:true)", async () => {
    seedOpenTrade("coinm-partial-1", "t-partial-1", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(), stopLoss: 48_000,
    });
    const stopCalls: any[] = [];
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 55_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => ({ success: true, filledPrice: 55_000, executedQty: 6 }), // requested 10, only 6 actually closed
      placeStopMarketClose: async (...args: any[]) => { stopCalls.push(args); return { ok: true, kind: "order", id: "resized-stop" }; },
      // The reinstalled stop is genuinely visible on the broker afterward —
      // the post-reinstall verification must find it and NOT downgrade to
      // "unprotected".
      listOwnedStops: async () => [{ kind: "order", id: "resized-stop" }],
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-partial-1" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res).toEqual({ ok: false, reason: "partial_close_remnant_protected" });
    expect(exec.calls.cancelActiveStop).toBe(1);
    expect(stopCalls.length).toBe(1);
    expect(stopCalls[0][3]).toBe(4); // exact remnant quantity (10 requested - 6 actually closed)
    const row = getDB().prepare(`SELECT status, quantity FROM trades WHERE id = 'coinm-partial-1'`).get() as any;
    expect(row.status).toBe("open"); // never marked closed on a partial fill
    expect(row.quantity).toBe(4);    // shrunk to the remnant so a later full close computes correct pnl
  });

  test("partial close reinstall API reports ok but the broker shows NO owned stop -> verified and downgraded to unprotected", async () => {
    seedOpenTrade("coinm-partial-3", "t-partial-3", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(), stopLoss: 48_000,
    });
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 55_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => ({ success: true, filledPrice: 55_000, executedQty: 6 }),
      placeStopMarketClose: async () => ({ ok: true, kind: "order", id: "resized-stop" }), // API says ok...
      listOwnedStops: async () => [], // ...but nothing is actually visible on the broker
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-partial-3" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res).toEqual({ ok: false, reason: "partial_close_remnant_unprotected" });
    expect(burst.count).toBeGreaterThanOrEqual(1);
  });

  test("partial close with a failed stop reinstall pages loudly and still refuses to claim success", async () => {
    seedOpenTrade("coinm-partial-2", "t-partial-2", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(), stopLoss: 48_000,
    });
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 55_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => ({ success: true, filledPrice: 55_000, executedQty: 3 }),
      placeStopMarketClose: async () => ({ ok: false }),
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-partial-2" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res).toEqual({ ok: false, reason: "partial_close_remnant_unprotected" });
    expect(burst.count).toBeGreaterThanOrEqual(1);
    const row = getDB().prepare(`SELECT status, quantity FROM trades WHERE id = 'coinm-partial-2'`).get() as any;
    expect(row.status).toBe("open");
    expect(row.quantity).toBe(7); // still shrunk to the remnant even though protection failed
  });

  test("full close (executedQty === requested contracts) takes the normal close path, not partial", async () => {
    seedOpenTrade("coinm-full-1", "t-full-1", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(),
    });
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 55_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => ({ success: true, filledPrice: 55_000, executedQty: 10 }),
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-full-1" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res).toEqual({ ok: true });
    const row = getDB().prepare(`SELECT status FROM trades WHERE id = 'coinm-full-1'`).get() as any;
    expect(row.status).toBe("closed");
  });

  // 2026-07-19: the 10->4->0 partial-close ledger. Each stage's
  // BROKER-SETTLED realizedPnl/commission (native asset, e.g. BTC) must
  // accumulate atomically (accumulatePartialCloseLedger) so the FINAL stage
  // converts the TRUE SUM to USD exactly once — never just its own slice,
  // which would silently drop stage 1's PnL entirely (the bug this ledger
  // replaces: the old code recomputed pnl from the shrunk row.quantity at
  // final close, losing every earlier stage).
  test("multi-stage close (10->4->0) sums broker-settled realizedPnl/commission across BOTH stages exactly once, converted to USD once", async () => {
    seedOpenTrade("coinm-multistage-1", "t-multistage-1", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(), stopLoss: 48_000,
    });

    let stage = 1;
    const exec = fakeExecutor({
      getOwnedPosition: async () => (stage === 1
        ? { symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 55_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }
        : { symbol: "BTCUSD_PERP", positionAmt: 4, entryPrice: 50_000, markPrice: 56_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => (stage === 1
        ? { success: true, filledPrice: 55_000, executedQty: 6, realizedPnlNative: 0.0010, commissionNative: 0.0001, commissionAsset: "BTC" }
        : { success: true, filledPrice: 56_000, executedQty: 4, realizedPnlNative: 0.0007, commissionNative: 0.00007, commissionAsset: "BTC" }),
      placeStopMarketClose: async () => ({ ok: true, kind: "order", id: "resized-stop" }),
      listOwnedStops: async () => [{ kind: "order", id: "resized-stop", side: "SELL", quantity: 4, triggerPrice: 48_000 }],
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-multistage-1" });

    // Stage 1: 10 -> 4. Never marks closed; the ledger accumulates stage 1's
    // native realizedPnl/commission and the 6 contracts actually closed.
    const res1 = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res1).toEqual({ ok: false, reason: "partial_close_remnant_protected" });
    let row = getDB().prepare(
      `SELECT status, quantity, partial_realized_native, partial_commission_native, partial_closed_contracts FROM trades WHERE id = 'coinm-multistage-1'`
    ).get() as any;
    expect(row.status).toBe("open");
    expect(row.quantity).toBe(4);
    expect(row.partial_realized_native).toBeCloseTo(0.0010, 10);
    expect(row.partial_commission_native).toBeCloseTo(0.0001, 10);
    expect(row.partial_closed_contracts).toBe(6);

    // Stage 2: 4 -> 0. Sums stage 1 + stage 2 (never just stage 2 alone).
    stage = 2;
    const res2 = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res2).toEqual({ ok: true });
    row = getDB().prepare(`SELECT status, pnl, pnl_pct FROM trades WHERE id = 'coinm-multistage-1'`).get() as any;
    expect(row.status).toBe("closed");
    const totalRealized = 0.0010 + 0.0007;
    const totalCommission = 0.0001 + 0.00007;
    // Conversion happens ONCE, at the FINAL stage's exit price (56000) — not
    // stage 1's 55000 applied to stage 1's slice and stage 2's separately.
    const expectedPnl = (totalRealized - totalCommission) * 56_000;
    const expectedPnlPct = (expectedPnl / (10 * 100)) * 100; // original 10 contracts, never the shrunk remnant
    expect(row.pnl).toBeCloseTo(expectedPnl, 6);
    expect(row.pnl_pct).toBeCloseTo(expectedPnlPct, 6);
  });
});

describe("closePosition — queries listOwnedStops before close and reconciles after (exact stop cleanup)", () => {
  test("full close: listOwnedStops queried before AND after cancelActiveStop, no stray stop -> no page", async () => {
    seedOpenTrade("coinm-reconcile-1", "t-reconcile-1", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(),
    });
    let listOwnedStopsCalls = 0;
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 55_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => ({ success: true, filledPrice: 55_000, executedQty: 10 }),
      listOwnedStops: async () => { listOwnedStopsCalls++; return []; },
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-reconcile-1" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res).toEqual({ ok: true });
    expect(listOwnedStopsCalls).toBe(2); // pre-close snapshot + post-close verify
    expect(exec.calls.cancelActiveStop).toBe(1);
    expect(burst.count).toBe(0);
  });

  test("full close: a stray owned stop still present after cancelActiveStop pages loudly (never silently left dangling)", async () => {
    seedOpenTrade("coinm-reconcile-2", "t-reconcile-2", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(),
    });
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 55_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      closePosition: async () => ({ success: true, filledPrice: 55_000, executedQty: 10 }),
      // Still shows a stop even after cancelActiveStop ran — a stray the
      // in-memory cancel didn't actually clear.
      listOwnedStops: async () => [{ kind: "order", id: "stray-stop" }],
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-reconcile-2" });
    const res = await adapter.closePosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy" });
    expect(res).toEqual({ ok: true }); // the close itself still succeeded and was recorded
    expect(burst.count).toBeGreaterThanOrEqual(1);
    expect(burst.messages.some(m => m.includes("Stray owned stop"))).toBe(true);
  });
});

describe("openPosition — no recoverable fill price with real exposure never quietly fails", () => {
  test("order avgPrice missing AND the position read also has no usable price -> emergency closes instead of a silent ok:false", async () => {
    let closeCalls = 0;
    const exec = fakeExecutor({
      placeMarketOrder: async () => ({ orderId: "unknown", clientOrderId: "unknown", status: "ORPHAN_UNRECOVERABLE_PRICE", avgPrice: 0, executedQty: 10 }),
      getOwnedPosition: async () => null, // fallback position read also unavailable; then verified flat after the emergency close
      closePosition: async () => { closeCalls++; return { success: true, filledPrice: 50_000, executedQty: 10 }; },
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-noprice-1" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "no_settled_price_emergency_closed" });
    expect(closeCalls).toBe(1);
    expect(burst.count).toBeGreaterThanOrEqual(1);
    const n = (getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = 't-noprice-1'`).get() as any).c;
    expect(n).toBe(0);
  });
});

describe("getOpenPositions / getEquity — delegate to the executor's inverse-safe reads", () => {
  test("getOpenPositions maps contracts -> CurrentPosition with notional = contracts*contractSize", async () => {
    const exec = fakeExecutor({ getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: -7, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }) });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-pos" });
    const positions = await adapter.getOpenPositions();
    expect(positions).toEqual([{ symbol: COINM_INTERNAL_SYMBOL, side: "sell", quantity: 7, notional: 700 }]);
  });

  test("getOpenPositions returns [] when flat", async () => {
    const exec = fakeExecutor({ getOwnedPosition: async () => null });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-pos-2" });
    expect(await adapter.getOpenPositions()).toEqual([]);
  });

  test("getEquity delegates to executor.getEquityUsd (BTC*mark, never quantity*price)", async () => {
    const exec = fakeExecutor({ getEquityUsd: async () => 98_765 });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-eq" });
    expect(await adapter.getEquity()).toBe(98_765);
  });

  test("getEquity throws when disconnected instead of returning a plausible 0", async () => {
    const exec = fakeExecutor({ isConnected: () => false });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-eq-2" });
    await expect(adapter.getEquity()).rejects.toThrow("not connected");
  });
});

// 2026-07-19 reviewer finding: a native stop install failure must NEVER
// report a false ok:true. The adapter must emergency-close the just-opened
// position, POSITIVELY verify flatness, and only then report failure — the
// same discipline already shipped for BinanceMomentumAdapter (FAPI), adapted
// here for inverse contracts.
describe("openPosition — native stop install failure never reports a false success", () => {
  test("stop fails, emergency close succeeds and verified flat -> ok:false, no trade row persisted", async () => {
    let closeCalls = 0;
    const exec = fakeExecutor({
      placeStopMarketClose: async () => ({ ok: false }),
      closePosition: async () => { closeCalls++; return { success: true, filledPrice: 50_000, executedQty: 10 }; },
      getOwnedPosition: async () => null, // verified flat after the emergency close
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-stopfail-1" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "stop_install_failed_emergency_closed" });
    expect(closeCalls).toBe(1);
    expect(burst.count).toBeGreaterThanOrEqual(1);
    const n = (getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = 't-stopfail-1'`).get() as any).c;
    expect(n).toBe(0); // never recorded as an open position
  });

  test("stop fails, emergency close reports success but broker still shows a live position -> ok:false, unverified", async () => {
    // getOwnedPosition is stateful: flat until AFTER a real fill is placed
    // (the restart-invariant gate reads it first, on a genuinely-flat
    // account, before this test's own placeMarketOrder/stop-fail scenario
    // ever runs) — matches real broker semantics instead of a static mock
    // that would trip the new pre-entry gate before reaching this path.
    let filled = false;
    const exec = fakeExecutor({
      placeMarketOrder: async () => { filled = true; return { orderId: 1, clientOrderId: "cm1", status: "FILLED", avgPrice: 50_000, executedQty: 10 }; },
      placeStopMarketClose: async () => ({ ok: false }),
      closePosition: async () => ({ success: true, filledPrice: 50_000, executedQty: 10 }),
      getOwnedPosition: async () => (filled ? { symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 } : null),
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-stopfail-2" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "stop_install_failed_emergency_close_unverified" });
  });

  test("stop fails, emergency close reports success but the reread THROWS -> ok:false, unverified (never coerces an unknown read into a flat claim)", async () => {
    let filled = false;
    const exec = fakeExecutor({
      placeMarketOrder: async () => { filled = true; return { orderId: 1, clientOrderId: "cm1", status: "FILLED", avgPrice: 50_000, executedQty: 10 }; },
      placeStopMarketClose: async () => ({ ok: false }),
      closePosition: async () => ({ success: true, filledPrice: 50_000, executedQty: 10 }),
      getOwnedPosition: async () => {
        if (!filled) return null; // restart-invariant precheck on a genuinely flat account
        throw new Error("ECONNRESET"); // reread after the emergency close fails — state UNKNOWN
      },
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-stopfail-4" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "stop_install_failed_emergency_close_unverified" });
    expect(burst.count).toBeGreaterThanOrEqual(1);
    expect(burst.messages.some(m => m.includes("reread failed"))).toBe(true);
  });

  test("stop fails, emergency close itself fails -> ok:false, loud ORPHAN", async () => {
    let closeCalls = 0;
    const exec = fakeExecutor({
      placeStopMarketClose: async () => ({ ok: false }),
      closePosition: async () => { closeCalls++; return { success: false, filledPrice: 0, executedQty: 0 }; },
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-stopfail-3" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "stop_install_failed_emergency_close_failed" });
    expect(closeCalls).toBe(1);
    expect(burst.count).toBeGreaterThanOrEqual(1);
  });
});

// DB insert failure after a REAL fill (native stop already installed). Ported
// from BinanceMomentumAdapter's FAPI pattern (retry once -> emergency close
// -> loud orphan), adapted for inverse contracts. Forces insertTrade to
// throw with a real SQLite trigger (see beforeAll) — no module mocking.
describe("openPosition — DB persist failure after a real fill (native stop already installed)", () => {
  test("insertTrade fails twice -> emergency close succeeds + verified flat -> reconciled, native stop cleared, no orphan", async () => {
    let closeCalls = 0;
    const exec = fakeExecutor({
      closePosition: async () => { closeCalls++; return { success: true, filledPrice: 50_000, executedQty: 10 }; },
      getOwnedPosition: async () => null, // verified flat after the emergency close
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "coinm-force-insert-fail" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "db_persist_failed_position_closed" });
    expect(closeCalls).toBe(1);                     // exactly one emergency close (after 1 retry)
    expect(exec.calls.cancelActiveStop).toBe(1);    // native SL cleared — position is flat now
    expect(burst.count).toBeGreaterThanOrEqual(1);
    const n = (getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = 'coinm-force-insert-fail'`).get() as any).c;
    expect(n).toBe(0); // the failed inserts never left a row behind
  });

  test("insertTrade fails twice -> emergency close succeeds but the reread THROWS -> ok:false, native stop RETAINED (no cancel, no flat claim)", async () => {
    let closeCalls = 0;
    let posCalls = 0;
    const exec = fakeExecutor({
      closePosition: async () => { closeCalls++; return { success: true, filledPrice: 50_000, executedQty: 10 }; },
      getOwnedPosition: async () => {
        posCalls++;
        if (posCalls === 1) return null; // restart-invariant precheck: genuinely flat
        throw new Error("ETIMEDOUT"); // reread after the emergency close fails — state UNKNOWN
      },
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "coinm-force-insert-fail" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "db_persist_failed" }); // NOT db_persist_failed_position_closed — flatness was never proven
    expect(closeCalls).toBe(1);
    expect(exec.calls.cancelActiveStop).toBeUndefined(); // never cancels the backstop stop on an unverified reread
    expect(burst.count).toBeGreaterThanOrEqual(1);
    const n = (getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = 'coinm-force-insert-fail'`).get() as any).c;
    expect(n).toBe(0);
  });

  test("insertTrade fails twice, emergency close ALSO fails -> ok:false, loud ORPHAN, native SL left as backstop (no cancel)", async () => {
    let closeCalls = 0;
    const exec = fakeExecutor({
      closePosition: async () => { closeCalls++; return { success: false, filledPrice: 0, executedQty: 0 }; },
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "coinm-force-insert-fail" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "db_persist_failed" });
    expect(closeCalls).toBe(1);
    expect(exec.calls.cancelActiveStop).toBeUndefined(); // never claims the SL is cleared on a still-orphaned position
    expect(burst.count).toBeGreaterThanOrEqual(1);
  });
});

// 2026-07-19: restart invariant. activeStops is in-memory on the executor
// and never survives a process restart — before openPosition EVER opens a
// NEW entry it must confirm any position ALREADY live on the broker is
// protected by a correctly-sized, correct-side owned native stop, querying
// the exchange fresh every time (never "activeStops thinks it's tracked").
describe("openPosition — restart invariant: verify/repair the live position's owned stop before any new entry", () => {
  test("a correctly-sized, correct-side owned stop is confirmed present -> entry proceeds normally, no repair touch", async () => {
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      listOwnedStops: async () => [{ kind: "order", id: "s1", side: "SELL", quantity: 10, triggerPrice: 48_000 }],
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-invariant-ok" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: true });
    expect(exec.calls.placeMarketOrder).toBe(1); // gate let the entry through
    expect(exec.calls.cancelActiveStop).toBeUndefined(); // a valid stop is never touched
  });

  test("no owned stop present -> reinstalls from the open DB trade's stop_loss (exact side/price/qty), then entry proceeds", async () => {
    seedOpenTrade("coinm-invariant-1", "t-invariant-repair", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(), stopLoss: 48_000,
    });
    let stopInstalled = false;
    const stopCalls: any[] = [];
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      listOwnedStops: async () => (stopInstalled ? [{ kind: "order", id: "repaired", side: "SELL", quantity: 10, triggerPrice: 48_000 }] : []),
      placeStopMarketClose: async (...args: any[]) => { stopInstalled = true; stopCalls.push(args); return { ok: true, kind: "order", id: "repaired" }; },
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-invariant-repair" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(true);
    expect(exec.calls.cancelActiveStop).toBeGreaterThanOrEqual(1);
    // The FIRST placeStopMarketClose call is the repair — exact side/price/qty from the DB row.
    expect(stopCalls[0].slice(0, 4)).toEqual([COINM_INTERNAL_SYMBOL, "buy", 48_000, 10]);
  });

  test("a wrong-sized owned stop is never blindly trusted — repaired (cancel + reinstall) before entry proceeds", async () => {
    seedOpenTrade("coinm-invariant-2", "t-invariant-wrongsize", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(), stopLoss: 47_500,
    });
    let stopInstalled = false;
    const exec = fakeExecutor({
      getOwnedPosition: async () => ({ symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      // wrong quantity (4) for a 10-contract live position -> never matches.
      listOwnedStops: async () => (stopInstalled
        ? [{ kind: "order", id: "repaired", side: "SELL", quantity: 10, triggerPrice: 47_500 }]
        : [{ kind: "order", id: "wrong-size", side: "SELL", quantity: 4, triggerPrice: 47_500 }]),
      placeStopMarketClose: async () => { stopInstalled = true; return { ok: true, kind: "order", id: "repaired" }; },
    });
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-invariant-wrongsize" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(true);
    expect(exec.calls.cancelActiveStop).toBeGreaterThanOrEqual(1); // the wrong-sized stop is cleared before reinstalling
  });

  test("no owned stop AND no DB stop_loss to reinstall from -> blocks entries, emergency-closes, verified flat", async () => {
    let closed = false;
    let closeCalls = 0;
    const exec = fakeExecutor({
      getOwnedPosition: async () => (closed ? null : { symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      listOwnedStops: async () => [],
      closePosition: async () => { closeCalls++; closed = true; return { success: true, filledPrice: 50_000, executedQty: 10 }; },
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-invariant-noverify" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "restart_invariant_no_repair_source_emergency_closed" });
    expect(closeCalls).toBe(1);
    expect(exec.calls.placeMarketOrder).toBeUndefined(); // never even attempted a new entry
    expect(burst.count).toBeGreaterThanOrEqual(1);
  });

  test("stop repair fails/unverified -> blocks entries, emergency-closes, verified flat", async () => {
    seedOpenTrade("coinm-invariant-3", "t-invariant-repairfail", {
      symbol: COINM_INTERNAL_SYMBOL, market: "crypto", entryPrice: 50_000, quantity: 10, entryTime: Date.now(), stopLoss: 48_000,
    });
    let closed = false;
    let closeCalls = 0;
    const exec = fakeExecutor({
      getOwnedPosition: async () => (closed ? null : { symbol: "BTCUSD_PERP", positionAmt: 10, entryPrice: 50_000, markPrice: 50_000, unrealizedProfit: 0, leverage: 2, updateTime: 1 }),
      listOwnedStops: async () => [], // repair never becomes visible on the broker
      placeStopMarketClose: async () => ({ ok: false }), // reinstall itself fails
      closePosition: async () => { closeCalls++; closed = true; return { success: true, filledPrice: 50_000, executedQty: 10 }; },
    });
    const burst = captureBursts();
    const adapter = new BinanceCoinMMomentumAdapter(exec, { accountId: "t-invariant-repairfail" });
    const res = await adapter.openPosition({ symbol: COINM_INTERNAL_SYMBOL, side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "restart_invariant_repair_failed_emergency_closed" });
    expect(closeCalls).toBe(1);
    expect(exec.calls.placeMarketOrder).toBeUndefined();
    expect(burst.count).toBeGreaterThanOrEqual(1);
  });
});
