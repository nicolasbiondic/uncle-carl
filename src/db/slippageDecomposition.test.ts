import { describe, expect, test, beforeAll } from "bun:test";
import { decomposeSlippage, getSlippageStats, recordFill } from "./database";
import { makeTestDb } from "../test-support/db";

beforeAll(() => { makeTestDb(); });

describe("decomposeSlippage — Tanda 5: drift (decision→submit) vs execution (submit→fill)", () => {
  test("buy: paying more at every step reads positive (bad) in every leg", () => {
    const d = decomposeSlippage("buy", 100, 101, 102);
    // total: (102-100)/100 * 10000 = 200bps
    expect(d.totalBps).toBeCloseTo(200, 6);
    // drift: (101-100)/100 * 10000 = 100bps
    expect(d.driftBps).toBeCloseTo(100, 6);
    // execution: (102-101)/101 * 10000 ≈ 99.0099bps
    expect(d.executionBps).toBeCloseTo((1 / 101) * 10_000, 6);
  });

  test("sell: getting less at every step reads positive (bad) in every leg", () => {
    // Sell convention is mirrored: expected(decision) - actual = positive when actual is worse.
    const d = decomposeSlippage("sell", 100, 99, 98);
    // total: (100-98)/100 * 10000 = 200bps
    expect(d.totalBps).toBeCloseTo(200, 6);
    // drift: (100-99)/100 * 10000 = 100bps (price dropped before we even submitted)
    expect(d.driftBps).toBeCloseTo(100, 6);
    // execution: (99-98)/99 * 10000
    expect(d.executionBps).toBeCloseTo((1 / 99) * 10_000, 6);
  });

  test("sell: getting a BETTER fill than submitted reads negative execution (good)", () => {
    const d = decomposeSlippage("sell", 100, 99, 99.5);
    expect(d.driftBps).toBeCloseTo(100, 6); // still drifted down before submit
    // execution: (99-99.5)/99 * 10000 — negative = favorable
    expect(d.executionBps!).toBeLessThan(0);
  });

  test("total ≈ drift + execution for realistic (small) moves — approximate, not exact", () => {
    // Each leg is a rate over its OWN reference price (expected_px for drift,
    // submitted_px for execution) — chaining two differently-based percentage
    // rates doesn't sum exactly; the gap is second-order (drift_pct ×
    // execution_pct) and shrinks toward 0 as the legs shrink.
    const d = decomposeSlippage("buy", 100, 100.05, 100.08);
    const sumApprox = d.driftBps! + d.executionBps!;
    expect(sumApprox).toBeCloseTo(d.totalBps, 1); // within ~0.1bps for a few-bps move
  });

  test("submitted_px = 0 (or absent) ⇒ BOTH driftBps and executionBps are null, never a fabricated 0", () => {
    const d = decomposeSlippage("buy", 100, 0, 102);
    expect(d.driftBps).toBeNull(); // drift's own endpoint (submitted_px) is unknown
    expect(d.executionBps).toBeNull();
    // total is still computable — it only ever needed expected_px/filled_px.
    expect(d.totalBps).toBeCloseTo(200, 6);
  });

  test("REAL meanrev case: decision 100, submit 98.6 (overnight gap), fill 98.6 (no execution cost)", () => {
    // This is the exact finding from the audit: meanrev's slippage_bps
    // averaged -142.8bps across 45 fills, reading like implausibly good
    // execution. It isn't — it's the overnight gap the mean-reversion thesis
    // itself trades on. Decomposed, the -140bps here is ALL drift; the
    // execution leg (the only thing order-routing quality could improve) is
    // ~0.
    const d = decomposeSlippage("buy", 100, 98.6, 98.6);
    expect(d.totalBps).toBeCloseTo(-140, 6);
    expect(d.driftBps).toBeCloseTo(-140, 6);
    expect(d.executionBps!).toBeCloseTo(0, 6);
  });
});

describe("getSlippageStats — decomposition exposed alongside the existing total", () => {
  const account = "slippage_decomp_probe";
  beforeAll(() => {
    // A meanrev-shaped fill: huge favorable drift, ~0 execution.
    recordFill({
      tradeId: "t1", orderId: "o1", accountId: account, symbol: "AAPL", side: "buy",
      market: "stock", expectedPx: 100, submittedPx: 98.6, filledPx: 98.6,
      filledQty: 1, fillTime: Date.now(), latencyMs: 50, broker: "alpaca",
    });
    // A momentum-shaped fill: small unfavorable drift AND execution cost.
    recordFill({
      tradeId: "t2", orderId: "o2", accountId: account, symbol: "AAPL", side: "buy",
      market: "stock", expectedPx: 100, submittedPx: 100.02, filledPx: 100.05,
      filledQty: 1, fillTime: Date.now(), latencyMs: 80, broker: "alpaca",
    });
    // An old fill recorded before submitted_px capture existed: 0 sentinel.
    recordFill({
      tradeId: "t3", orderId: "o3", accountId: account, symbol: "AAPL", side: "buy",
      market: "stock", expectedPx: 100, submittedPx: 0, filledPx: 100.1,
      filledQty: 1, fillTime: Date.now(), latencyMs: 60, broker: "alpaca",
    });
  });

  test("total (p50/p95/count) keeps its prior meaning unchanged", () => {
    const sl = getSlippageStats(account, 24 * 3600_000);
    expect(sl.count).toBe(3);
  });

  test("execution stats only count fills with a usable submitted_px", () => {
    const sl = getSlippageStats(account, 24 * 3600_000);
    expect(sl.executionCount).toBe(2); // t3 excluded — submitted_px was 0
    expect(sl.executionP50).not.toBeNull();
  });

  test("drift stats also require a usable submitted_px (t3's own endpoint is unknown)", () => {
    const sl = getSlippageStats(account, 24 * 3600_000);
    expect(sl.driftCount).toBe(2); // t3 excluded — same reason as execution
    expect(sl.driftP50).not.toBeNull();
  });

  test("no fills in window ⇒ every stat is null/0, nothing fabricated", () => {
    const sl = getSlippageStats("nobody_traded_this_account", 24 * 3600_000);
    expect(sl.count).toBe(0);
    expect(sl.driftP50).toBeNull();
    expect(sl.driftP95).toBeNull();
    expect(sl.driftCount).toBe(0);
    expect(sl.executionP50).toBeNull();
    expect(sl.executionP95).toBeNull();
    expect(sl.executionCount).toBe(0);
  });
});
