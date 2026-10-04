// ══════════════════════════════════════════════
// Shared-pool margin mirror (2026-08-22)
// ══════════════════════════════════════════════
//
// 2026-08-19 incident: orphan positions consumed the USDT pool's available
// margin and every hourly entry died as an anonymous "Margin is insufficient"
// HTTP 400 for ~15 hours (38 rejected orders). The executor logged the real
// cause; the adapter reason said only "binance.placeOrder returned null", so
// the SleeveOutput "producing NOTHING" page (which had ALSO been swallowed by
// the unset ops chat) carried nothing actionable. openPosition now mirrors
// the broker's initial-margin check pre-submit, with a self-diagnosing
// reason. Locked here:
//  • requiredMargin (= notional/leverage) > available → blocked pre-submit:
//    no placeOrder call, rejected-order telemetry, reason names need vs
//    available and points at the orphan-exposure runbook.
//  • balance unreadable (throw) → FAIL OPEN: the broker stays the enforcer.
//  • ample/boundary margin → order reaches the broker unchanged (mirror, not
//    a new risk constant; boundary equality is allowed — we block strictly
//    MORE than the broker's own requirement floor).
//  • the reason labels the ADAPTER's own pool (USDT vs USDC).

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { getDB } from "../../db/database";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { makeTestDb } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
});

afterEach(() => {
  getDB().exec(`DELETE FROM trades`);
  getDB().exec(`DELETE FROM orders`);
  getDB().exec(`DELETE FROM signals`);
});

function stubBinance(marginCash: number | "throw") {
  const calls = { placeOrder: 0, getBalance: 0 };
  return {
    calls,
    isConnected: () => true,
    getPrice: async () => 100,
    getBalance: async () => {
      calls.getBalance++;
      if (marginCash === "throw") throw new Error("network down");
      return { marginEquity: 5_000, marginCash, wallet: 5_000, unrealizedPnl: 0 };
    },
    // Returning null keeps the post-fill path out of scope: reaching this
    // stub at all (calls.placeOrder > 0) is what fail-open/ample assert.
    placeOrder: async () => { calls.placeOrder++; return null; },
  } as any;
}

describe("BinanceMomentumAdapter.openPosition — shared-pool margin mirror", () => {
  // Default leverage 2 → $1000 notional needs ~$500 initial margin.
  test("required margin > available → blocked pre-submit: no broker call, rejected telemetry, self-diagnosing reason", async () => {
    const binance = stubBinance(400); // pool has $400; entry needs ~$500
    const result = await new BinanceMomentumAdapter({} as any, binance, { accountId: "momentum_crypto" })
      .openPosition({ symbol: "ETH/USD", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("insufficient_margin");
    expect(result.reason).toContain("(USDT pool)");
    expect(result.reason).toContain("reconcile-orphan-exposure"); // the runbook, in the page itself
    expect(binance.calls.placeOrder).toBe(0); // never transmitted

    const rejected = getDB().prepare(
      `SELECT COUNT(*) c FROM orders WHERE status = 'rejected' AND account_id = 'momentum_crypto'`
    ).get() as any;
    expect(rejected.c).toBe(1);
  });

  test("USDC adapter labels its OWN pool in the reason", async () => {
    const binance = stubBinance(100);
    const result = await new BinanceMomentumAdapter({} as any, binance, {
      accountId: "momentum_crypto_usdc", quoteAsset: "USDC",
    }).openPosition({ symbol: "ETH/USDC", side: "buy", notionalUsd: 1000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("(USDC pool)");
    expect(binance.calls.placeOrder).toBe(0);
  });

  test("balance unreadable (throw) → FAIL OPEN: the order reaches the broker", async () => {
    const binance = stubBinance("throw");
    const result = await new BinanceMomentumAdapter({} as any, binance, { accountId: "momentum_crypto" })
      .openPosition({ symbol: "ETH/USD", side: "buy", notionalUsd: 1000 });

    expect(binance.calls.placeOrder).toBe(1);       // transmitted despite the failed read
    expect(result.ok).toBe(false);                   // (stub broker then rejected it)
    expect(result.reason).toContain("placeOrder returned null");
    expect(result.reason).not.toContain("insufficient_margin");
  });

  test("ample margin → order reaches the broker unchanged", async () => {
    const binance = stubBinance(10_000);
    await new BinanceMomentumAdapter({} as any, binance, { accountId: "momentum_crypto" })
      .openPosition({ symbol: "ETH/USD", side: "buy", notionalUsd: 1000 });
    expect(binance.calls.placeOrder).toBe(1);
  });

  test("boundary: required margin exactly == available is allowed — the guard blocks strictly MORE", async () => {
    const binance = stubBinance(500); // exactly notional/leverage
    await new BinanceMomentumAdapter({} as any, binance, { accountId: "momentum_crypto" })
      .openPosition({ symbol: "ETH/USD", side: "buy", notionalUsd: 1000 });
    expect(binance.calls.placeOrder).toBe(1);
  });
});
