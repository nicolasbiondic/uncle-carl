// ══════════════════════════════════════════════
// BinanceMomentumAdapter.scalePosition — the exposure control's partial
// resize (RW4a, 2026-10-23; MomentumEngineConfig.exposureControl on
// momentum_crypto_usdc). Locks:
//   1. factor < 1: ONE reduceOnly close of (1 − factor) × the ROW's quantity
//      (never the broker aggregate), the row stays open with the remnant and
//      the leg's broker pnl/fee on the partial ledger (COIN-M pattern), the
//      inflight-close guard is held, the native stop is re-sized (place the
//      NEW one at the ROW's stop price first, then sweep ours around it — a
//      double placement failure cancels nothing), BrokerSync's SUM(open qty)
//      equals the broker after the fill.
//   2. the final close nets the partial legs into ONE pnl, pnl_pct over the
//      quantity ever held — the sim's single ClosedTrade.
//   3. factor > 1: a MARKET add through placeOrder, entry = weighted average,
//      open_commission accumulates, stop_loss (price) untouched, native stop
//      re-sized to the new quantity at that SAME price.
//   4. every failure before a confirmed fill leaves position + row untouched
//      and answers ok:false; a flattening reduction is refused.
//   5. ownership: no row → no broker call; wrong quoteAsset symbol → refused.
//   6. the 15s-loop close (AccountManager.closeTradeDirectly's formula) and
//      the reconciler see the right numbers (ledger read / fills summed).
// ══════════════════════════════════════════════

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { getDB, getPartialCloseLedger } from "../../db/database";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { hasInflightEngineClose, resetInflightClosesForTests } from "../../sync/inflightCloses";
import { eventBus, EVENTS } from "../../utils/events";

beforeAll(() => { makeTestDb(); });
beforeEach(() => { resetInflightClosesForTests(); });

let n = 0;
function account() { return `momentum_crypto_usdc_scale_${n++}`; }

function row(accountId: string, symbol = "SOL/USDC") {
  return getDB().prepare(`SELECT * FROM trades WHERE account_id = ? AND symbol = ?`).get(accountId, symbol) as any;
}

/** Fake executor: a 12.78 SOL long at 121.35 on the broker, stop 84.945 on the row. */
function fakeBinance(over: Record<string, any> = {}) {
  const calls: { close: any[]; place: any[]; stops: any[]; cancels: any[]; order: string[] } = { close: [], place: [], stops: [], cancels: [], order: [] };
  let brokerQty = 12.78;
  const bin: any = {
    isConnected: () => true,
    getPrice: async () => 130,
    getBalance: async () => ({ marginEquity: 6000, marginCash: 4000, wallet: 6000, unrealizedPnl: 0 }),
    getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: brokerQty, entryPrice: 121.35, unrealizedProfit: (130 - 121.35) * brokerQty, leverage: 2, updateTime: 1 }],
    getExecutableQuote: async () => ({ price: 129.9, timestamp: Date.now() }),
    closePosition: async (sym: string, qty: number, side: string) => {
      calls.close.push({ sym, qty, side });
      brokerQty -= qty;
      return { success: true, filledPrice: 129.8, commission: 0.05, realizedPnl: (129.8 - 121.35) * qty, filledQty: qty, exitTime: Date.now(), orderId: "x1", submittedAt: Date.now(), submittedPx: 129.9 };
    },
    placeOrder: async (_signal: any, qty: number) => {
      calls.place.push({ qty });
      brokerQty += qty;
      return { id: `add-${calls.place.length}`, symbol: "SOL/USDC", market: "crypto", side: "buy", type: "market", quantity: qty, price: 130, status: "filled", externalId: "e1", filledPrice: 130.2, filledAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), openCommission: 0.03, submittedAt: Date.now(), submittedPx: 130 };
    },
    placeStopMarketClose: async (sym: string, side: string, px: number, qty: number, clientOrderId?: string) => { calls.stops.push({ sym, side, px, qty, clientOrderId }); calls.order.push("place"); return true; },
    cancelAllOrders: async (sym: string, opts: any) => { calls.cancels.push({ sym, opts }); calls.order.push("cancel"); },
    ...over,
  };
  return { bin, calls, brokerQty: () => brokerQty };
}

function adapter(bin: any, accountId: string) {
  return new BinanceMomentumAdapter({} as any, bin, { accountId, quoteAsset: "USDC", candleTimeframe: "1Day", stopLossPct: 4, leverage: 2 });
}

describe("scalePosition — factor < 1 (reduceOnly partial close)", () => {
  test("closes (1 − factor) × the ROW qty, keeps the row open with the remnant, books the leg on the partial ledger, re-sizes the native stop at the ROW's stop price; DB == broker afterwards", async () => {
    const acc = account();
    seedOpenTrade("sol-1", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 12.78, entryPrice: 121.35, stopLoss: 84.945, openCommission: 0.7 });
    const { bin, calls, brokerQty } = fakeBinance();
    let inflightSeen = false;
    const origClose = bin.closePosition;
    bin.closePosition = async (...a: any[]) => { inflightSeen = hasInflightEngineClose(acc, "SOL/USDC"); return origClose(...a); };

    const res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.873, reason: "exposure control: λ 0.873" });
    expect(res).toEqual({ ok: true });

    expect(calls.close.length).toBe(1);
    expect(calls.close[0].qty).toBeCloseTo(12.78 * (1 - 0.873), 9);
    expect(calls.close[0].side).toBe("buy"); // the POSITION side; the executor flips it
    expect(inflightSeen).toBe(true);                                // guard held across the broker mutation
    expect(hasInflightEngineClose(acc, "SOL/USDC")).toBe(false);    // and released

    const r = row(acc);
    expect(r.status).toBe("open");
    expect(r.quantity).toBeCloseTo(12.78 * 0.873, 9);
    expect(r.quantity).toBeCloseTo(brokerQty(), 9);                 // BrokerSync's SUM(open) == broker
    expect(r.entry_price).toBe(121.35);                              // a reduce never moves the entry
    expect(r.stop_loss).toBe(84.945);
    expect(r.pnl).toBeNull();                                        // pnl is written ONCE, at the final close
    const ledger = getPartialCloseLedger("sol-1");
    expect(ledger.closedContracts).toBeCloseTo(12.78 * 0.127, 9);
    expect(ledger.realizedNative).toBeCloseTo((129.8 - 121.35) * 12.78 * 0.127, 6);
    expect(ledger.commissionNative).toBeCloseTo(0.05, 9);
    expect(ledger.commissionAsset).toBe("USDC");

    // Native stop: the NEW one is placed FIRST (stamped as ours, row's price, remnant qty), THEN ours are swept
    // around it (exceptClientOrderIds = the new id; NOT aggregateFlat — the position lives). Never a stop-less instant.
    expect(calls.order).toEqual(["place", "cancel"]);
    expect(calls.stops.length).toBe(1);
    expect(calls.stops[0]).toMatchObject({ sym: "SOL/USDC", side: "buy", px: 84.945 });
    expect(calls.stops[0].qty).toBeCloseTo(r.quantity, 9);
    expect(calls.stops[0].clientOrderId).toMatch(/^uc-/);
    expect(calls.cancels).toEqual([{ sym: "SOL/USDC", opts: { exceptClientOrderIds: [calls.stops[0].clientOrderId] } }]);
  });

  test("the final engine close nets the partial leg into ONE pnl; pnl_pct over the quantity ever held", async () => {
    const acc = account();
    seedOpenTrade("sol-2", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100, stopLoss: 70, openCommission: 1 });
    const { bin } = fakeBinance({
      getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }],
      closePosition: async (_s: string, qty: number) => ({ success: true, filledPrice: 110, commission: 0.1, realizedPnl: 10 * qty, filledQty: qty, exitTime: Date.now(), submittedAt: Date.now(), submittedPx: 110 }),
    });
    const a = adapter(bin, acc);
    expect((await a.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.5 })).ok).toBe(true); // leg: +50 − 0.1
    expect(row(acc).quantity).toBe(5);
    expect((await a.closePosition({ symbol: "SOL/USDC", side: "buy", closeReason: "TRAIL_STOP" })).ok).toBe(true); // final: +50 − 0.1 − 1 (open fee)
    const r = row(acc);
    expect(r.status).toBe("closed");
    expect(r.pnl).toBeCloseTo(50 - 0.1 + 50 - 0.1 - 1, 9);
    expect(r.pnl_pct).toBeCloseTo((r.pnl / (100 * 10)) * 100, 9); // basis = 5 remaining + 5 reduced, not the remnant
    expect(r.close_reason).toBe("TRAIL_STOP");
    expect(r.close_commission).toBeCloseTo(0.1, 9);
  });

  test("15s-loop formula (AccountManager.closeTradeDirectly): broker pnl − fees − open fee + ledger — equals the engine close's", async () => {
    const acc = account();
    seedOpenTrade("sol-3", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100, openCommission: 1 });
    const { bin } = fakeBinance({
      getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }],
      closePosition: async (_s: string, qty: number) => ({ success: true, filledPrice: 110, commission: 0.1, realizedPnl: 10 * qty, filledQty: qty, submittedPx: 110 }),
    });
    await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.5 });
    const ledger = getPartialCloseLedger("sol-3");
    const loopPnl = 50 - 0.1 - 1 + ledger.realizedNative - ledger.commissionNative;
    expect(loopPnl).toBeCloseTo(98.8, 9);
  });

  test("a reduction that would flatten (row or broker) is refused BEFORE any broker call; factor 1 / ≤ 0 / NaN refused", async () => {
    const acc = account();
    seedOpenTrade("sol-4", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100 });
    const { bin, calls } = fakeBinance({ getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 4, entryPrice: 100 }] });
    const a = adapter(bin, acc);
    // row 10 → close 6 ≥ broker 4: would flatten the broker position
    expect((await a.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.4 })).ok).toBe(false);
    expect((await a.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1e-12 })).ok).toBe(false);
    expect((await a.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1 })).ok).toBe(false);
    expect((await a.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0 })).ok).toBe(false);
    expect((await a.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: NaN })).ok).toBe(false);
    expect(calls.close.length).toBe(0);
    expect(calls.place.length).toBe(0);
    expect(row(acc).quantity).toBe(10);
  });

  test("broker does not confirm → ok:false, row untouched, no stop touched, guard released", async () => {
    const acc = account();
    seedOpenTrade("sol-5", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100, stopLoss: 70 });
    const { bin, calls } = fakeBinance({
      getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }],
      closePosition: async () => ({ success: false, filledPrice: 0, commission: 0, realizedPnl: 0, reason: "venue rejection -2022" }),
    });
    const res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.5 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("did not confirm");
    expect(row(acc).quantity).toBe(10);
    expect(getPartialCloseLedger("sol-5").closedContracts).toBe(0);
    expect(calls.cancels.length).toBe(0);
    expect(calls.stops.length).toBe(0);
    expect(hasInflightEngineClose(acc, "SOL/USDC")).toBe(false);
  });

  test("ownership: no row → no broker call; a USDT-style symbol on the USDC adapter → refused; side mismatch → refused", async () => {
    const acc = account();
    const { bin, calls } = fakeBinance();
    const a = adapter(bin, acc);
    let res = await a.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.5 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no open DB trade");
    res = await a.scalePosition({ symbol: "SOL/USD", side: "buy", factor: 0.5 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no binance mapping");
    seedOpenTrade("sol-6", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100 });
    res = await a.scalePosition({ symbol: "SOL/USDC", side: "sell", factor: 0.5 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("side");
    expect(calls.close.length + calls.place.length).toBe(0);
  });

  test("stop placement failing twice (trim): NOTHING is canceled — the old stop stays and still covers the remainder; the resize still reports ok and STOP_RESIZE_FAILED is paged with the trim case", async () => {
    const acc = account();
    seedOpenTrade("sol-7", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100, stopLoss: 70 });
    let attempts = 0;
    const pages: string[] = [];
    const onBurst = (p: any) => { if (String(p.message).includes("STOP_RESIZE_FAILED")) pages.push(p.message); };
    eventBus.on(EVENTS.ERROR_BURST, onBurst);
    try {
      const { bin, calls } = fakeBinance({
        getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }],
        placeStopMarketClose: async () => { attempts++; return false; },
      });
      const res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.5 });
      expect(res.ok).toBe(true);
      expect(attempts).toBe(2);
      expect(calls.cancels).toEqual([]); // the old stop (qty 10, reduceOnly) remains and protects the remnant 5
      expect(row(acc).quantity).toBe(5);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toContain("trim");
    } finally { eventBus.off(EVENTS.ERROR_BURST, onBurst); }
  });

  test("stop placement failing twice (add-back): nothing canceled, the old stop covers only the old quantity — the page says so", async () => {
    const acc = account();
    seedOpenTrade("sol-7b", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100, stopLoss: 70 });
    const pages: string[] = [];
    const onBurst = (p: any) => { if (String(p.message).includes("STOP_RESIZE_FAILED")) pages.push(p.message); };
    eventBus.on(EVENTS.ERROR_BURST, onBurst);
    try {
      const { bin, calls } = fakeBinance({
        getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }],
        placeStopMarketClose: async () => { throw new Error("-1013"); },
      });
      const res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
      expect(res.ok).toBe(true);
      expect(calls.cancels).toEqual([]);
      expect(row(acc).quantity).toBe(15);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toContain("add-back");
    } finally { eventBus.off(EVENTS.ERROR_BURST, onBurst); }
  });

  test("placement succeeds on the second attempt: the old stop is swept only after the new one exists", async () => {
    const acc = account();
    seedOpenTrade("sol-7c", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100, stopLoss: 70 });
    let attempts = 0;
    const { bin, calls } = fakeBinance({
      getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }],
      placeStopMarketClose: async (sym: string, side: string, px: number, qty: number, id?: string) => { attempts++; if (attempts === 1) return false; calls.stops.push({ sym, side, px, qty, clientOrderId: id }); calls.order.push("place"); return true; },
    });
    const res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.5 });
    expect(res.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(calls.order).toEqual(["place", "cancel"]);
    expect(calls.cancels[0].opts.exceptClientOrderIds).toEqual([calls.stops[0].clientOrderId]);
    expect(calls.stops[0].qty).toBe(5);
  });
});

describe("scalePosition — factor > 1 (add at market)", () => {
  test("adds (factor − 1) × qty through placeOrder; entry = weighted average, open fee accumulates, stop PRICE untouched, native stop re-sized to the new qty at that price; DB == broker", async () => {
    const acc = account();
    seedOpenTrade("sol-8", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100, stopLoss: 70, openCommission: 1 });
    const { bin, calls, brokerQty } = fakeBinance({
      getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }],
    });
    const res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
    expect(res).toEqual({ ok: true });
    expect(calls.place).toEqual([{ qty: 5 }]);
    expect(calls.close.length).toBe(0);
    const r = row(acc);
    expect(r.status).toBe("open");
    expect(r.quantity).toBe(15);
    expect(r.entry_price).toBeCloseTo((100 * 10 + 130.2 * 5) / 15, 9);
    expect(r.open_commission).toBeCloseTo(1.03, 9);
    expect(r.stop_loss).toBe(70); // stays at the ORIGINAL entry's stop price
    expect(brokerQty()).toBeCloseTo(17.78, 9); // fake started at 12.78 + 5 — the ROW drove the order, not the aggregate
    expect(calls.order).toEqual(["place", "cancel"]);
    expect(calls.stops).toEqual([{ sym: "SOL/USDC", side: "buy", px: 70, qty: 15, clientOrderId: calls.stops[0].clientOrderId }]);
    expect(calls.cancels).toEqual([{ sym: "SOL/USDC", opts: { exceptClientOrderIds: [calls.stops[0].clientOrderId] } }]);
    expect(getPartialCloseLedger("sol-8").closedContracts).toBe(0);
  });

  test("placeOrder rejected (null) or UNKNOWN → ok:false, row untouched, no stop touched", async () => {
    const acc = account();
    seedOpenTrade("sol-9", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100, stopLoss: 70 });
    const { bin, calls } = fakeBinance({ getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }], placeOrder: async () => null });
    let res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
    expect(res.ok).toBe(false);
    bin.placeOrder = async () => ({ outcome: "unknown", reason: "timeout" });
    res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("unknown");
    expect(row(acc)).toMatchObject({ quantity: 10, entry_price: 100, stop_loss: 70 });
    expect(calls.stops.length).toBe(0);
    expect(calls.cancels.length).toBe(0);
  });

  test("insufficient margin (pool mirror) → named refusal before any order", async () => {
    const acc = account();
    seedOpenTrade("sol-10", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100 });
    const { bin, calls } = fakeBinance({
      getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }],
      getBalance: async () => ({ marginEquity: 600, marginCash: 10, wallet: 600, unrealizedPnl: 0 }),
    });
    const res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("insufficient_margin");
    expect(calls.place.length).toBe(0);
  });

  test("add filled but the row vanished (closed meanwhile) → the added qty is undone with a reduceOnly close and ok:false", async () => {
    const acc = account();
    seedOpenTrade("sol-11", acc, { symbol: "SOL/USDC", market: "crypto", quantity: 10, entryPrice: 100 });
    const { bin, calls } = fakeBinance({
      getPositions: async () => [{ symbol: "SOLUSDC", positionAmt: 10, entryPrice: 100 }],
      placeOrder: async (_s: any, qty: number) => {
        getDB().prepare(`UPDATE trades SET status = 'closed' WHERE id = 'sol-11'`).run(); // raced by another close
        return { id: "add-x", quantity: qty, filledPrice: 130, filledAt: Date.now(), openCommission: 0 };
      },
    });
    const res = await adapter(bin, acc).scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
    expect(res.ok).toBe(false);
    expect(calls.close).toEqual([{ sym: "SOL/USDC", qty: 5, side: "buy" }]);
  });
});
