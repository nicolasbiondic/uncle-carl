import { describe, expect, test } from "bun:test";
import { slippageBps, estErrorBps, percentile, summarize, type FillRow } from "./fillQuality";

// ── slippageBps: side-aware sign, 4 quadrants ──────────────────────────

describe("slippageBps", () => {
  test("buy, filled > expected (paid more) → positive (bad)", () => {
    expect(slippageBps("buy", 100, 101)).toBeCloseTo(100, 6); // (101-100)/100*10000
  });

  test("buy, filled < expected (paid less) → negative (good)", () => {
    expect(slippageBps("buy", 100, 99)).toBeCloseTo(-100, 6);
  });

  test("sell, filled > expected (got more) → negative (good)", () => {
    expect(slippageBps("sell", 100, 101)).toBeCloseTo(-100, 6);
  });

  test("sell, filled < expected (got less) → positive (bad)", () => {
    expect(slippageBps("sell", 100, 99)).toBeCloseTo(100, 6);
  });

  test("non-positive expectedPx never fabricates a number — returns 0", () => {
    expect(slippageBps("buy", 0, 101)).toBe(0);
    expect(slippageBps("buy", -5, 101)).toBe(0);
  });
});

// ── estErrorBps: same sign convention, estPx as the reference ─────────

describe("estErrorBps", () => {
  test("buy, filled > est (worse than predicted) → positive (estimator was optimistic)", () => {
    expect(estErrorBps("buy", 100, 101)).toBeCloseTo(100, 6);
  });

  test("buy, filled < est (better than predicted) → negative (estimator was pessimistic)", () => {
    expect(estErrorBps("buy", 101, 100)).toBeCloseTo(-99.00990099, 5);
  });

  test("sell, filled < est (worse than predicted) → positive (estimator was optimistic)", () => {
    expect(estErrorBps("sell", 100, 99)).toBeCloseTo(100, 6);
  });

  test("sell, filled > est (better than predicted) → negative (estimator was pessimistic)", () => {
    expect(estErrorBps("sell", 99, 100)).toBeCloseTo(-101.010101, 4);
  });

  test("non-positive estPx never fabricates a number — returns 0", () => {
    expect(estErrorBps("buy", 0, 101)).toBe(0);
  });
});

// ── percentile: sort + index, no interpolation ─────────────────────────

describe("percentile", () => {
  test("empty input → 0, never NaN", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  test("n=1: any percentile returns the single value", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.9)).toBe(42);
  });

  test("n=2: nearest-rank index = floor(n*p), clamped to last element", () => {
    // floor(2*0.5)=1 → sorted[1]; floor(2*0.9)=1 → sorted[1] (both hit the top).
    expect(percentile([10, 20], 0.5)).toBe(20);
    expect(percentile([10, 20], 0.9)).toBe(20);
  });

  test("n=4: distinguishes p50 from p90 once the index range allows it", () => {
    const xs = [10, 20, 30, 40];
    expect(percentile(xs, 0.5)).toBe(30); // floor(4*0.5)=2 → sorted[2]
    expect(percentile(xs, 0.9)).toBe(40); // floor(4*0.9)=3 → sorted[3]
  });

  test("unsorted input is sorted internally", () => {
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(30);
  });
});

// ── summarize: grouping, buckets, est_px exclusion, integrated case ───

function row(over: Partial<FillRow>): FillRow {
  return {
    broker: "alpaca",
    market: "stock",
    side: "buy",
    expectedPx: 100,
    filledPx: 100,
    filledQty: 1,
    latencyMs: 500,
    estPx: null,
    ...over,
  };
}

describe("summarize — grouping by (broker, market)", () => {
  test("empty input → empty output, never a fabricated zero-row group", () => {
    expect(summarize([])).toEqual([]);
  });

  test("splits into separate groups per (broker, market), sorted deterministically", () => {
    const rows: FillRow[] = [
      row({ broker: "binance", market: "crypto" }),
      row({ broker: "alpaca", market: "stock" }),
      row({ broker: "alpaca", market: "crypto" }),
    ];
    const summary = summarize(rows);
    expect(summary.map(g => `${g.broker}/${g.market}`)).toEqual([
      "alpaca/crypto",
      "alpaca/stock",
      "binance/crypto",
    ]);
    for (const g of summary) expect(g.n).toBe(1);
  });
});

describe("summarize — est_px NULL rows excluded only from the estimator block", () => {
  test("rows without a usable est_px still count toward n/slippage/latency, not estN", () => {
    const rows: FillRow[] = [
      row({ estPx: null, filledPx: 101 }),          // no estimate
      row({ estPx: 0, filledPx: 101 }),               // sentinel zero, also excluded
      row({ estPx: 100.5, filledPx: 101 }),          // usable estimate
    ];
    const [g] = summarize(rows);
    expect(g.n).toBe(3);           // all three counted in the group total
    expect(g.estN).toBe(1);        // only the usable one counted for est-error stats
    expect(g.estErrorAbsBpsP50).not.toBeNull();
  });

  test("a group with zero usable est_px rows reports null est-error stats, not 0", () => {
    const rows: FillRow[] = [row({ estPx: null }), row({ estPx: undefined })];
    const [g] = summarize(rows);
    expect(g.estN).toBe(0);
    expect(g.estErrorAbsBpsP50).toBeNull();
    expect(g.estErrorAbsBpsP90).toBeNull();
  });
});

describe("summarize — notional buckets", () => {
  test("default boundaries [1000, 5000, 25000] sort fills into 4 labeled buckets", () => {
    const rows: FillRow[] = [
      row({ filledQty: 5, filledPx: 100 }),     // $500   → <$1k
      row({ filledQty: 20, filledPx: 100 }),    // $2000  → $1k-$5k
      row({ filledQty: 100, filledPx: 100 }),   // $10000 → $5k-$25k
      row({ filledQty: 1000, filledPx: 100 }),  // $100000 → >$25k
    ];
    const [g] = summarize(rows);
    expect(g.buckets.map(b => b.bucket)).toEqual(["<$1k", "$1k-$5k", "$5k-$25k", ">$25k"]);
    expect(g.buckets.map(b => b.n)).toEqual([1, 1, 1, 1]);
  });

  test("custom boundaries are respected", () => {
    const rows: FillRow[] = [row({ filledQty: 1, filledPx: 50 }), row({ filledQty: 1, filledPx: 500 })];
    const [g] = summarize(rows, { notionalBucketsUsd: [100] });
    expect(g.buckets.map(b => b.bucket)).toEqual(["<$100", ">$100"]);
    expect(g.buckets[0].n).toBe(1);
    expect(g.buckets[1].n).toBe(1);
  });

  test("empty buckets report n=0 and null est-error stats, never crash", () => {
    const rows: FillRow[] = [row({ filledQty: 5, filledPx: 100 })]; // $500, only the <$1k bucket is populated
    const [g] = summarize(rows);
    const midBucket = g.buckets.find(b => b.bucket === "$5k-$25k")!;
    expect(midBucket.n).toBe(0);
    expect(midBucket.estErrorAbsBpsP50).toBeNull();
    expect(midBucket.slippageBpsP50).toBe(0); // percentile([]) → 0, documented
  });
});

describe("summarize — buy/sell breakdown and entry/exit labeling", () => {
  test("sideIsEntryExit is true for market='stock' (long-only sleeves), false for 'crypto' (shorts exist)", () => {
    const rows: FillRow[] = [row({ broker: "alpaca", market: "stock" }), row({ broker: "binance", market: "crypto" })];
    const summary = summarize(rows);
    expect(summary.find(g => g.market === "stock")!.sideIsEntryExit).toBe(true);
    expect(summary.find(g => g.market === "crypto")!.sideIsEntryExit).toBe(false);
  });

  test("buy/sell rows are split with independent n and percentiles", () => {
    const rows: FillRow[] = [
      row({ side: "buy", expectedPx: 100, filledPx: 101 }),  // +100bps
      row({ side: "buy", expectedPx: 100, filledPx: 102 }),  // +200bps
      row({ side: "sell", expectedPx: 100, filledPx: 99 }),  // +100bps (sell, got less = bad)
    ];
    const [g] = summarize(rows);
    expect(g.buy.n).toBe(2);
    expect(g.sell.n).toBe(1);
    expect(g.buy.slippageBpsP50).toBeCloseTo(200, 6); // floor(2*0.5)=1 → sorted[1]=200
    expect(g.sell.slippageBpsP50).toBeCloseTo(100, 6);
  });

  test("a side with zero rows reports n=0 and null percentiles, not 0", () => {
    const rows: FillRow[] = [row({ side: "buy" })];
    const [g] = summarize(rows);
    expect(g.sell).toEqual({ n: 0, slippageBpsP50: null, slippageBpsP90: null });
  });
});

describe("summarize — integrated small case with synthetic fills", () => {
  test("realistic mixed batch: two brokers, mixed sides, mixed est_px coverage, mixed notional", () => {
    const rows: FillRow[] = [
      // alpaca/stock: a clean momentum entry (buy) and exit (sell), both with estimates
      row({ broker: "alpaca", market: "stock", side: "buy", expectedPx: 100, filledPx: 100.2, estPx: 100.1, filledQty: 10, latencyMs: 300 }),
      row({ broker: "alpaca", market: "stock", side: "sell", expectedPx: 105, filledPx: 104.8, estPx: 104.9, filledQty: 10, latencyMs: 250 }),
      // binance/crypto: a short entry (sell) with no estimate, larger notional
      row({ broker: "binance", market: "crypto", side: "sell", expectedPx: 50_000, filledPx: 49_950, estPx: null, filledQty: 0.5, latencyMs: 80 }),
    ];
    const summary = summarize(rows);
    expect(summary).toHaveLength(2);

    const alpaca = summary.find(g => g.broker === "alpaca")!;
    expect(alpaca.n).toBe(2);
    expect(alpaca.estN).toBe(2);
    expect(alpaca.sideIsEntryExit).toBe(true);
    expect(alpaca.buy.n).toBe(1);
    expect(alpaca.sell.n).toBe(1);
    // notional: 10*100.2=1002 and 10*104.8=1048, both land in $1k-$5k
    expect(alpaca.buckets.find(b => b.bucket === "$1k-$5k")!.n).toBe(2);

    const binance = summary.find(g => g.broker === "binance")!;
    expect(binance.n).toBe(1);
    expect(binance.estN).toBe(0);
    expect(binance.estErrorAbsBpsP50).toBeNull();
    expect(binance.sideIsEntryExit).toBe(false);
    // notional: 0.5*49950=24975 → $5k-$25k
    expect(binance.buckets.find(b => b.bucket === "$5k-$25k")!.n).toBe(1);
  });
});
