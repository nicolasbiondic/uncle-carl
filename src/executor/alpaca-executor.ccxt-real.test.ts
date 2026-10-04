// ══════════════════════════════════════════════
// REAL-DATA tests for AlpacaExecutor's money-path parsing.
//
// ccxt/ccxt's static corpus for `alpaca` (see __fixtures__/ccxt/NOTICE) only
// captures market-data + GetAccount + Activities endpoints — it does NOT
// exercise Alpaca's Trading API (positions/orders), so it can't feed
// getPositions()/placeOrder()/pollOrderUntilFilled() the way the sibling
// binance-executor.ccxt-real.test.ts does from ccxt. That gap is itself a
// finding (see the bottom of this file / final report).
//
// What DOES exist for the order/position path: real numeric anomalies this
// system has actually measured and documented in AUDITS.md, which are
// exactly the "well-formed but implausible" class a hand-written mock never
// invents. Each fixture below cites its AUDITS.md provenance.
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { AlpacaExecutor } from "./alpaca-executor";

function executor(): any {
  const exec = new AlpacaExecutor() as any;
  exec.connected = true;
  return exec;
}

// ── AUDITS.md: real IEX snapshot, 2026-07-27 sweep of the 43-symbol
// universe — "12 have ask=0 or bid≤0.05, AAPL among them with `bid: 0.01,
// ask: 0`" (AUDITS.md, P0 finding (3)). ──────────────────────────────────
describe("getExecutableQuote fed the REAL AAPL IEX snapshot (AUDITS.md, 2026-07-27: bid 0.01 / ask 0)", () => {
  function snapClient() {
    return {
      getSnapshot: async () => ({
        LatestQuote: { AskPrice: 0, BidPrice: 0.01, Timestamp: new Date().toISOString() },
      }),
    };
  }

  test("a BUY correctly fails closed: ask=0 is not a usable executable price", async () => {
    const exec = executor();
    exec.client = snapClient();
    expect(await exec.getExecutableQuote("AAPL", "buy")).toBeNull();
  });

  test("FINDING: a SELL is NOT rejected — bid=0.01 passes every existing check (price>0, fresh) and becomes the 'executable' fill benchmark for a $190+ stock", async () => {
    // Not a crash, not a NaN — genuinely well-formed data (positive number,
    // fresh timestamp) that is nonetheless three orders of magnitude away
    // from AAPL's real price. getExecutableQuote has no plausibility/
    // magnitude check on the quote it returns — only price>0 and freshness.
    // AUDITS.md already names the consequence downstream (a slippage_bps
    // calc elsewhere would read "≈336,920,000" off exactly this quote) but
    // that consumer lives outside alpaca-executor.ts. Left as a passing,
    // locked-in-behavior test (not skipped): there's no unambiguous "correct"
    // fixed value here — closing this gap needs a product decision on a
    // spread/plausibility threshold, not a mechanical fix.
    const exec = executor();
    exec.client = snapClient();
    expect(await exec.getExecutableQuote("AAPL", "sell")).toEqual({ price: 0.01, timestamp: expect.any(Number), bid: 0.01, ask: undefined });
  });
});

// ── Cancelled order + partial fill ambiguity (AUDITS.md: "Closed broker
// money-path ambiguity (partial fills, ...)" — getPositions() was hardened
// to throw rather than silently drop broker truth for exactly this class of
// bug; pollOrderUntilFilled's cancel path was never given the same
// treatment). ──────────────────────────────────────────────────────────────
describe("pollOrderUntilFilled / cancelAndFetchFinal: cancelled order with a real partial fill", () => {
  test("positive control: cancelled with filled_qty=15/filled_avg_price=182.47 (both present) is correctly reported as a fill", async () => {
    const exec = executor();
    exec.client = {
      getOrder: async () => ({ status: "canceled", filled_qty: "15", filled_avg_price: "182.47", filled_at: "2026-07-20T14:00:00Z" }),
    };
    const result = await exec.pollOrderUntilFilled("order-1", 10, 5, 0);
    expect(result.status).toBe("filled");
    expect(result.filledQty).toBe(15);
    expect(result.filledPrice).toBe(182.47);
  });

  test("positive control: cancelled with nothing filled (filled_qty=0, filled_avg_price=null) is correctly reported as plain cancelled", async () => {
    const exec = executor();
    exec.client = {
      getOrder: async () => ({ status: "canceled", filled_qty: "0", filled_avg_price: null }),
    };
    const result = await exec.pollOrderUntilFilled("order-2", 10, 5, 0);
    expect(result).toEqual({ status: "canceled" });
  });

  test("FIXED: cancelled with a REAL partial fill (filled_qty=15) but filled_avg_price:null no longer loses the fill — resolved via fill-activity/last-price fallback (or surfaced with an unknown price) instead of reported as plain 'canceled'", async () => {
    // A broker-side glitch where filled_avg_price comes back null on an
    // order that genuinely has filled_qty>0 (18 requested, 15 filled, then
    // cancelled — the exact partial-fill-then-cancel shape AUDITS.md's
    // "Closed broker money-path ambiguity" entry is about) is NOT handled:
    //   if (filledQty > 0 && filledAvgPrice > 0) return {status:"filled",...}
    //   return { status: order.status };  // <- falls through here
    // parseFloat(null ?? "0") = parseFloat("0") = 0, so filledAvgPrice is 0,
    // NOT >0, and the function returns bare {status:"canceled"} — the fact
    // that 15 real shares filled is discarded entirely. The broker holds a
    // position (or a since-closed one) our own bookkeeping never recorded a
    // fill for; BrokerSync would eventually "re-discover" it as a phantom
    // sync_* row, but the entry price/time/attribution is lost.
    const exec = executor();
    exec.client = {
      getOrder: async () => ({ status: "canceled", filled_qty: "15", filled_avg_price: null, filled_at: "2026-07-20T14:00:00Z" }),
    };
    const result = await exec.pollOrderUntilFilled("order-3", 10, 5, 0);
    // Desired: the real filled quantity must never be silently dropped just
    // because avg price came back null — at minimum surface filledQty so a
    // caller can decide (re-price from trades, flag for manual reconcile),
    // instead of indistinguishable-from-nothing-filled.
    expect(result.status).toBe("filled");
    expect(result.filledQty).toBe(15);
  });
});
