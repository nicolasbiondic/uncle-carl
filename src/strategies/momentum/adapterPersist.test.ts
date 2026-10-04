// ══════════════════════════════════════════════
// Bug 1 — adapters must NOT swallow insertTrade failure after a real fill
// ══════════════════════════════════════════════
//
// A real broker order fills, then the DB row (the RECORD of that position)
// fails to persist. getOpenPositions is DB-anchored, so a missing row makes the
// engine RE-OPEN next tick (a doubled real position, unmanaged by the sleeve
// stop-loss). The adapter must instead: page (ERROR_BURST), retry once, then
// EMERGENCY-CLOSE the just-opened position — and if THAT fails, log a loud
// orphan and return { ok:false }.
//
// The insert failure is forced with a real in-memory DB by re-using an existing
// trade id (PRIMARY KEY conflict), so no module mocking is needed.

import { describe, test, expect, beforeAll } from "bun:test";
import { getDB } from "../../db/database";
import { eventBus, EVENTS } from "../../utils/events";
import { AlpacaMomentumAdapter } from "./AlpacaMomentumAdapter";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
  // Seed rows whose ids the fake executors re-use → insertTrade hits a PK
  // conflict and throws, exercising the persist-failure path.
  seedOpenTrade("dup-alpaca", "seed", { symbol: "ZZZ", entryPrice: 1, entryTime: Date.now() });
  seedOpenTrade("dup-binance", "seed", { symbol: "ZZZ", market: "crypto", entryPrice: 1, entryTime: Date.now() });
});

/** Capture the next ERROR_BURST (proves the page fires). */
function captureBurst(): { fired: boolean; ctx?: string } {
  const cap: { fired: boolean; ctx?: string } = { fired: false };
  eventBus.once(EVENTS.ERROR_BURST, (d: any) => { cap.fired = true; cap.ctx = d?.context; });
  return cap;
}

describe("AlpacaMomentumAdapter.openPosition — persist failure after a real fill", () => {
  function fakeAlpaca(close: { success: boolean; filledPrice: number; reason?: string }) {
    const calls = { close: 0 };
    return {
      calls,
      isConnected: () => true,
      getCachedPrice: () => 100,
      getLatestPrice: async () => 100,
      getExecutableQuote: async () => ({ price: 100, timestamp: Date.now() }),
      getRegTBuyingPower: async () => null, // unknown → fail-open (guard has its own tests)
      placeOrder: async (_sig: any, qty: number) => ({
        id: "dup-alpaca", quantity: qty, filledPrice: 100, filledQty: qty, status: "filled", externalId: "broker-dup",
      }),
      closePosition: async () => { calls.close++; return close; },
    } as any;
  }

  test("emergency-closes and returns db_persist_failed_position_closed when the close succeeds", async () => {
    const alp = fakeAlpaca({ success: true, filledPrice: 100 });
    const burst = captureBurst();
    const res = await new AlpacaMomentumAdapter(alp).openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "db_persist_failed_position_closed" });
    expect(alp.calls.close).toBe(1);          // exactly one emergency close (after 1 retry)
    expect(burst.fired).toBe(true);           // paged
    expect(burst.ctx).toBe("AlpacaMomentumAdapter");
    // and NO phantom AAPL row was left behind
    const n = getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE symbol = 'AAPL' AND status = 'open'`).get() as any;
    expect(n.c).toBe(0);
  });

  test("returns { ok:false } (no reason) and logs ORPHAN when the emergency close also fails", async () => {
    const alp = fakeAlpaca({ success: false, filledPrice: 0, reason: "http_403" });
    const res = await new AlpacaMomentumAdapter(alp).openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBeUndefined();
    expect(alp.calls.close).toBe(1);
  });
});

describe("BinanceMomentumAdapter.openPosition — persist failure after a real fill", () => {
  // opts.flatAfterClose controls the ALWAYS-reread getPositions call after
  // closePosition — defaults to close.success (a genuinely successful close
  // really did flatten the broker; a failed one leaves the position live).
  function fakeBinance(close: { success: boolean; filledPrice?: number }, opts: { flatAfterClose?: boolean } = {}) {
    const calls = { close: 0, cancel: 0 };
    const flatAfterClose = opts.flatAfterClose ?? close.success;
    let posCalls = 0;
    return {
      calls,
      isConnected: () => true,
      getPrice: async () => 100,
      getExecutableQuote: async () => null,
      placeOrder: async (_sig: any, qty: number) => ({ id: "dup-binance", quantity: qty, filledPrice: 100 }),
      placeStopMarketClose: async () => true,
      // Call 1 (if reached): final-quantity read after the fill. Later
      // calls: the ALWAYS reread after closePosition, never trusted blind.
      getPositions: async () => {
        posCalls++;
        if (posCalls === 1) return [{ symbol: "BTCUSDT", positionAmt: 10, entryPrice: 100 }];
        return flatAfterClose ? [] : [{ symbol: "BTCUSDT", positionAmt: 10, entryPrice: 100 }];
      },
      closePosition: async () => { calls.close++; return { success: close.success, filledPrice: close.filledPrice ?? 0, commission: 0, realizedPnl: 0 }; },
      cancelAllOrders: async () => { calls.cancel++; },
    } as any;
  }

  test("emergency-closes + cancels the native SL, returns db_persist_failed_position_closed", async () => {
    const bin = fakeBinance({ success: true, filledPrice: 100 });
    const burst = captureBurst();
    const res = await new BinanceMomentumAdapter({} as any, bin).openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "db_persist_failed_position_closed" });
    expect(bin.calls.close).toBe(1);
    expect(bin.calls.cancel).toBe(1);         // native STOP_MARKET SL cleaned up after the close
    expect(burst.fired).toBe(true);
    expect(burst.ctx).toBe("BinanceMomentumAdapter");
  });

  test("returns { ok:false } and keeps the native SL as backstop when the emergency close fails", async () => {
    const bin = fakeBinance({ success: false });
    const res = await new BinanceMomentumAdapter({} as any, bin).openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBeUndefined();
    expect(bin.calls.close).toBe(1);
    expect(bin.calls.cancel).toBe(0);         // SL left in place as protection for the orphan
  });
});

describe("BinanceMomentumAdapter commission accounting", () => {
  test("persists entry commission and stores/returns PnL net of both fees exactly once", async () => {
    const before = Date.now() - 1;
    const bin = {
      isConnected: () => true,
      getPrice: async () => 100,
      getExecutableQuote: async () => null,
      placeOrder: async (_sig: any, qty: number) => ({
        id: "commission-binance",
        quantity: qty,
        filledPrice: 100,
        openCommission: 2,
      }),
      placeStopMarketClose: async () => true,
      getPositions: async () => [{ symbol: "ETHUSDT", positionAmt: 10, entryPrice: 100 }],
      closePosition: async () => ({ success: true, filledPrice: 101, commission: 1, realizedPnl: 10 }),
      cancelAllOrders: async () => {},
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, bin);

    expect(await adapter.openPosition({ symbol: "ETH/USD", side: "buy", notionalUsd: 1000 })).toEqual({ ok: true });
    expect(await adapter.closePosition({ symbol: "ETH/USD", side: "buy" })).toEqual({ ok: true });

    const row = getDB().prepare(
      `SELECT pnl, open_commission, close_commission FROM trades WHERE id = 'commission-binance'`
    ).get() as any;
    expect(row).toEqual({ pnl: 7, open_commission: 2, close_commission: 1 });
    expect(await adapter.getRealisedPnlSince(before)).toBe(7);
  });
});

describe("BinanceMomentumAdapter close confirmation", () => {
  test("clears native stops when broker is flat even while fill accounting is pending", async () => {
    seedOpenTrade("awaiting-native-stop", "momentum_crypto", {
      symbol: "SOL/USD", market: "crypto", entryTime: Date.now(),
    });
    let cancels = 0;
    const bin = {
      isConnected: () => true,
      getExecutableQuote: async () => null,
      getPositions: async () => [],
      cancelAllOrders: async () => { cancels++; },
    } as any;

    const result = await new BinanceMomentumAdapter({} as any, bin)
      .closePosition({ symbol: "SOL/USD", side: "buy" });

    expect(result.ok).toBe(false);
    expect(cancels).toBe(1);
    const row = getDB().prepare(`SELECT status FROM trades WHERE id = 'awaiting-native-stop'`).get() as any;
    expect(row.status).toBe("open");
  });

  test("does not cancel or close DB for a zero-price success response", async () => {
    seedOpenTrade("zero-price-close", "momentum_crypto", {
      symbol: "LINK/USD", market: "crypto", entryPrice: 10, entryTime: Date.now(),
    });
    let cancels = 0;
    const bin = {
      isConnected: () => true,
      getExecutableQuote: async () => null,
      getPositions: async () => [{ symbol: "LINKUSDT", positionAmt: 1, entryPrice: 10 }],
      closePosition: async () => ({ success: true, filledPrice: 0, commission: 0, realizedPnl: 0 }),
      cancelAllOrders: async () => { cancels++; },
    } as any;

    const result = await new BinanceMomentumAdapter({} as any, bin)
      .closePosition({ symbol: "LINK/USD", side: "buy" });

    expect(result.ok).toBe(false);
    expect(cancels).toBe(0);
    const row = getDB().prepare(`SELECT status FROM trades WHERE id = 'zero-price-close'`).get() as any;
    expect(row.status).toBe("open");
  });
});

describe("v8 execution telemetry", () => {
  test("Alpaca records the signal, filled order, and fill", async () => {
    const alpaca = {
      isConnected: () => true,
      getCachedPrice: () => 100,
      getLatestPrice: async () => 100,
      getExecutableQuote: async () => ({ price: 100, timestamp: Date.now() }),
      getRegTBuyingPower: async () => null, // unknown → fail-open (guard has its own tests)
      placeOrder: async (signal: any, qty: number) => ({
        id: "telemetry-alpaca", symbol: signal.symbol, market: "stock", side: signal.side,
        type: "market", quantity: qty, price: signal.price, status: "filled",
        externalId: "broker-alpaca", filledPrice: 101, filledQty: qty, filledAt: Date.now(),
        submittedAt: Date.now() - 10, submittedPx: 100,
        createdAt: Date.now(), updatedAt: Date.now(), signal,
      }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .openPosition({ symbol: "MSFT", side: "buy", notionalUsd: 1000 });

    expect(result).toEqual({ ok: true });
    expect((getDB().prepare(`SELECT COUNT(*) c FROM signals WHERE account_id='momentum_stocks' AND symbol='MSFT'`).get() as any).c).toBe(1);
    expect(getDB().prepare(`SELECT status FROM orders WHERE id='telemetry-alpaca'`).get()).toEqual({ status: "filled" });
    expect((getDB().prepare(`SELECT COUNT(*) c FROM fills WHERE order_id='broker-alpaca'`).get() as any).c).toBe(1);
  });

  test("Alpaca entry fill's expected_px is the DECISION price (getCachedPrice), NOT order.submittedPx — three independent values so slippage_bps actually measures something", async () => {
    // Decision (cached) 100 != submitted-at-order-time 100.5 != filled 101.
    // Before the fix expected_px was order.submittedPx (100.5), so
    // slippage_bps ≈ (101-100.5)/100.5*10000 ≈ 50bps — half the true
    // decision-to-fill slippage.
    const alpaca = {
      isConnected: () => true,
      getCachedPrice: () => 100,
      getLatestPrice: async () => 100,
      getExecutableQuote: async () => null,
      getRegTBuyingPower: async () => null, // unknown → fail-open (guard has its own tests)
      placeOrder: async (signal: any, qty: number) => ({
        id: "expected-px-alpaca", symbol: signal.symbol, market: "stock", side: signal.side,
        type: "market", quantity: qty, price: signal.price, status: "filled",
        externalId: "broker-expected-px", filledPrice: 101, filledQty: qty, filledAt: Date.now(),
        submittedAt: Date.now() - 10, submittedPx: 100.5,
        createdAt: Date.now(), updatedAt: Date.now(), signal,
      }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .openPosition({ symbol: "NVDA", side: "buy", notionalUsd: 1000 });

    expect(result).toEqual({ ok: true });
    const fill = getDB().prepare(
      `SELECT expected_px, submitted_px, filled_px, slippage_bps FROM fills WHERE order_id='broker-expected-px'`
    ).get() as any;
    expect(fill.expected_px).toBe(100);      // decision price, NOT submittedPx
    expect(fill.submitted_px).toBe(100.5);   // still recorded, just no longer aliased to expected_px
    expect(fill.filled_px).toBe(101);
    expect(fill.slippage_bps).toBeCloseTo(100, 5); // (101-100)/100 * 10000, not (101-100.5)/100.5*10000 ≈ 50
  });

  test("Alpaca entry expected_px falls back to getLatestPrice when getCachedPrice has no price yet", async () => {
    const alpaca = {
      isConnected: () => true,
      getCachedPrice: () => 0,           // nothing cached
      getLatestPrice: async () => 100,   // sizing/decision price comes from here
      getExecutableQuote: async () => null,
      getRegTBuyingPower: async () => null, // unknown → fail-open (guard has its own tests)
      placeOrder: async (signal: any, qty: number) => ({
        id: "expected-px-fallback-alpaca", symbol: signal.symbol, market: "stock", side: signal.side,
        type: "market", quantity: qty, price: signal.price, status: "filled",
        externalId: "broker-expected-px-fallback", filledPrice: 101, filledQty: qty, filledAt: Date.now(),
        submittedAt: Date.now() - 10, submittedPx: 100.5,
        createdAt: Date.now(), updatedAt: Date.now(), signal,
      }),
    } as any;

    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .openPosition({ symbol: "AMD", side: "buy", notionalUsd: 1000 });

    expect(result).toEqual({ ok: true });
    const fill = getDB().prepare(
      `SELECT expected_px FROM fills WHERE order_id='broker-expected-px-fallback'`
    ).get() as any;
    expect(fill.expected_px).toBe(100); // getLatestPrice fallback, still NOT submittedPx (100.5)
  });

  test("Binance entry fill's expected_px is the DECISION price (getPrice), NOT order.submittedPx", async () => {
    const binance = {
      isConnected: () => true,
      getPrice: async () => 100,
      getExecutableQuote: async () => null,
      placeOrder: async (signal: any, qty: number) => ({
        id: "expected-px-binance", symbol: signal.symbol, market: "crypto", side: signal.side,
        type: "market", quantity: qty, price: signal.price, status: "filled",
        externalId: "broker-expected-px-binance", filledPrice: 101, filledQty: qty, filledAt: Date.now(),
        submittedAt: Date.now() - 10, submittedPx: 100.5,
        createdAt: Date.now(), updatedAt: Date.now(), signal, openCommission: 0,
      }),
      getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: 10, entryPrice: 101 }],
      placeStopMarketClose: async () => true,
    } as any;

    const result = await new BinanceMomentumAdapter({} as any, binance, { accountId: "momentum_crypto" })
      .openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });

    expect(result).toEqual({ ok: true });
    const fill = getDB().prepare(
      `SELECT expected_px, submitted_px, filled_px, slippage_bps FROM fills WHERE order_id='broker-expected-px-binance'`
    ).get() as any;
    expect(fill.expected_px).toBe(100);      // decision price, NOT submittedPx
    expect(fill.submitted_px).toBe(100.5);
    expect(fill.filled_px).toBe(101);
    expect(fill.slippage_bps).toBeCloseTo(100, 5);
  });

  test("Binance entry expected_px is the quote TOUCH (ask for buy) when a fresh quote is available — NOT the mark price", async () => {
    // Audit fix (2026-09-10): entries used to benchmark a real TRADE fill
    // against the MARK price (getPrice) — mark≠last, so the "slippage" was
    // never comparable to anything. Sizing must still use the mark (100),
    // only the fill-telemetry expectedPx switches to the quote touch.
    const binance = {
      isConnected: () => true,
      getPrice: async () => 100,               // mark — sizing only
      getExecutableQuote: async (_sym: string, side: string) =>
        side === "buy" ? { price: 100.4, timestamp: Date.now(), bid: 99.9, ask: 100.4 } : null,
      placeOrder: async (signal: any, qty: number) => ({
        id: "expected-px-quote-binance", symbol: signal.symbol, market: "crypto", side: signal.side,
        type: "market", quantity: qty, price: signal.price, status: "filled",
        externalId: "broker-expected-px-quote", filledPrice: 101, filledQty: qty, filledAt: Date.now(),
        submittedAt: Date.now() - 10, submittedPx: 100.5,
        createdAt: Date.now(), updatedAt: Date.now(), signal, openCommission: 0,
      }),
      getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: 10, entryPrice: 101 }],
      placeStopMarketClose: async () => true,
    } as any;

    const result = await new BinanceMomentumAdapter({} as any, binance, { accountId: "momentum_crypto" })
      .openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });

    expect(result).toEqual({ ok: true });
    const fill = getDB().prepare(
      `SELECT expected_px, submitted_px, filled_px FROM fills WHERE order_id='broker-expected-px-quote'`
    ).get() as any;
    expect(fill.expected_px).toBe(100.4);   // quote ask — NOT mark (100), NOT submittedPx (100.5)
    expect(fill.submitted_px).toBe(100.5);
    expect(fill.filled_px).toBe(101);
  });

  test("Binance exit expected_px is the pre-close quote (bid closing a long), distinct from submitted_px", async () => {
    seedOpenTrade("exit-quote-binance", "momentum_crypto", {
      symbol: "ETH/USD", market: "crypto", quantity: 2, entryTime: Date.now(),
    });
    let quoteSide: string | undefined;
    const bin = {
      isConnected: () => true,
      getExecutableQuote: async (_sym: string, side: string) => { quoteSide = side; return { price: 199.5, timestamp: Date.now() }; },
      getPositions: async () => [{ symbol: "ETHUSDT", positionAmt: 2, entryPrice: 200 }],
      closePosition: async () => ({
        success: true, filledPrice: 199.2, filledQty: 2, commission: 0, realizedPnl: -1,
        orderId: "exit-quote-order", submittedPx: 199.6, submittedAt: Date.now() - 20, exitTime: Date.now(),
      }),
      cancelAllOrders: async () => {},
    } as any;

    const result = await new BinanceMomentumAdapter({} as any, bin, { accountId: "momentum_crypto" })
      .closePosition({ symbol: "ETH/USD", side: "buy" });

    expect(result).toEqual({ ok: true });
    expect(quoteSide).toBe("sell"); // closing a long sells
    const fill = getDB().prepare(
      `SELECT expected_px, submitted_px, filled_px FROM fills WHERE trade_id='exit-quote-binance'`
    ).get() as any;
    expect(fill.expected_px).toBe(199.5);   // pre-close quote, NOT submitted_px (199.6)
    expect(fill.submitted_px).toBe(199.6);
    expect(fill.filled_px).toBe(199.2);
  });

  test("Binance records a rejected attempt without inventing a fill", async () => {
    const binance = {
      isConnected: () => true,
      getPrice: async () => 100,
      getExecutableQuote: async () => null,
      placeOrder: async () => null,
    } as any;

    const result = await new BinanceMomentumAdapter({} as any, binance)
      .openPosition({ symbol: "AVAX/USD", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(false);
    expect((getDB().prepare(`SELECT COUNT(*) c FROM signals WHERE account_id='momentum_crypto' AND symbol='AVAX/USD'`).get() as any).c).toBe(1);
    expect(getDB().prepare(`SELECT status,state FROM orders WHERE account_id='momentum_crypto' AND symbol='AVAX/USD' ORDER BY created_at DESC LIMIT 1`).get()).toEqual({ status: "rejected", state: "REJECTED" });
    expect((getDB().prepare(`SELECT COUNT(*) c FROM fills WHERE account_id='momentum_crypto' AND symbol='AVAX/USD'`).get() as any).c).toBe(0);
  });
});
