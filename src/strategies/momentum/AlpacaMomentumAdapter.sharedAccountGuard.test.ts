// ══════════════════════════════════════════════
// Shared-account Reg-T guard (2026-08-20)
// ══════════════════════════════════════════════
//
// The two stock sleeves (momentum_stocks + meanrev_stocks) are DB-ledger
// divisions of ONE real Alpaca account: each sizes off its OWN wallet
// (AlpacaMomentumAdapter.getEquity) and cannot see the other sleeve's live
// exposure, manual shares, or orphans. The only cross-sleeve truth about
// remaining capacity is the broker's own Reg-T buying power — so
// openPosition mirrors it PRE-submit. Until 2026-08-20 nothing runtime
// summed the sleeves against the account (AccountManager's 5-min gross log
// is VISIBILITY ONLY) and the broker's 403 detail died inside the executor,
// arriving as an unmatchable "alpaca.placeOrder returned null" — so
// MeanRevEngine's "insufficient_buying_power" terminal matcher could NEVER
// fire and a doomed day was retried on backoff instead of parked.
//
// Locked here:
//  • notional > Reg-T BP → blocked pre-submit: no placeOrder call,
//    rejected-order telemetry, reason classified TERMINAL by MeanRevEngine.
//  • BP unknown (null) → FAIL OPEN: the broker stays the real enforcer; a
//    transient getAccount error must never freeze entries.
//  • ample BP → unchanged behavior (guard is a mirror, not a new constant).
//  • negative BP (margin call) → blocks: parseable truth, not "unknown".

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { getDB } from "../../db/database";
import { AlpacaMomentumAdapter } from "./AlpacaMomentumAdapter";
import { isTerminalActionFailure } from "../meanrev/MeanRevEngine";
import { makeTestDb } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
});

afterEach(() => {
  getDB().exec(`DELETE FROM trades`);
  getDB().exec(`DELETE FROM orders`);
  getDB().exec(`DELETE FROM signals`);
});

function stubAlpaca(regtBp: number | null) {
  const calls = { placeOrder: 0 };
  return {
    calls,
    isConnected: () => true,
    getCachedPrice: () => 100,
    getLatestPrice: async () => 100,
    getExecutableQuote: async () => null,
    getRegTBuyingPower: async () => regtBp,
    placeOrder: async (_sig: any, qty: number) => {
      calls.placeOrder++;
      return {
        id: `guard-order-${calls.placeOrder}`, quantity: qty, status: "filled",
        filledPrice: 100, filledQty: qty, externalId: `ext-${calls.placeOrder}`,
      };
    },
  } as any;
}

describe("AlpacaMomentumAdapter.openPosition — shared-account Reg-T guard", () => {
  test("notional > Reg-T BP → blocked pre-submit: no broker call, rejected telemetry, TERMINAL reason for meanrev", async () => {
    const alpaca = stubAlpaca(500); // account can take $500; sleeve wants $1000
    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "meanrev_stocks", strategy: "MEANREV" })
      .openPosition({ symbol: "KO", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("insufficient_buying_power");
    expect(alpaca.calls.placeOrder).toBe(0); // never transmitted

    // Dashboard/telemetry parity with a broker rejection: a rejected order row.
    const rejected = getDB().prepare(
      `SELECT COUNT(*) c FROM orders WHERE status = 'rejected' AND account_id = 'meanrev_stocks'`
    ).get() as any;
    expect(rejected.c).toBe(1);

    // Cross-module contract: MeanRevEngine parks the day (terminal) instead
    // of retrying a broke account on backoff. This is the matcher that could
    // never fire before (the 403 detail died inside the executor).
    expect(isTerminalActionFailure(result.reason)).toBe(true);
  });

  test("negative Reg-T BP (margin call) blocks — parseable truth is not 'unknown'", async () => {
    const alpaca = stubAlpaca(-2500);
    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .openPosition({ symbol: "SMH", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("insufficient_buying_power");
    expect(alpaca.calls.placeOrder).toBe(0);
  });

  test("BP unknown (null) → FAIL OPEN: order proceeds, broker stays the enforcer", async () => {
    const alpaca = stubAlpaca(null);
    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .openPosition({ symbol: "QQQ", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(true);
    expect(alpaca.calls.placeOrder).toBe(1);
  });

  test("ample BP → unchanged behavior (mirror, not a new risk constant)", async () => {
    const alpaca = stubAlpaca(100_000);
    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(true);
    expect(alpaca.calls.placeOrder).toBe(1);
  });

  test("boundary: notional exactly == BP is allowed — the guard blocks strictly MORE than the broker reports", async () => {
    const alpaca = stubAlpaca(1000);
    const result = await new AlpacaMomentumAdapter(alpaca, { accountId: "momentum_stocks" })
      .openPosition({ symbol: "IWM", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(true);
    expect(alpaca.calls.placeOrder).toBe(1);
  });
});
