// ══════════════════════════════════════════════
// bookDepth — VWAP-from-real-depth slippage estimation (2026-08-03)
// ══════════════════════════════════════════════

import { describe, test, expect } from "bun:test";
import { walkBook, estimateFromBook, estimateFromQuote, type BookLevel } from "./bookDepth";

describe("walkBook", () => {
  test("consumes levels best-first and returns the exact VWAP", () => {
    // Buy $250 against asks [100×1, 101×2]: $100 at 100, $150 at 101.
    const asks: BookLevel[] = [[100, 1], [101, 2]];
    const w = walkBook(asks, 250)!;
    const qty = 1 + 150 / 101;
    expect(w.qty).toBeCloseTo(qty, 10);
    expect(w.vwapPx).toBeCloseTo(250 / qty, 10);
    expect(w.exhausted).toBe(false);
  });

  test("thin book: exhausted flag when depth can't cover the notional (NO invented depth)", () => {
    const asks: BookLevel[] = [[100, 0.5]]; // only $50 visible
    const w = walkBook(asks, 500)!;
    expect(w.exhausted).toBe(true);
    expect(w.matchedNotional).toBeCloseTo(50, 10);
    expect(w.vwapPx).toBeCloseTo(100, 10); // only what was actually seen
  });

  test("empty/malformed book → null, never a fabricated price", () => {
    expect(walkBook([], 100)).toBeNull();
    expect(walkBook([[0, 5] as BookLevel, [NaN, 1] as BookLevel], 100)).toBeNull();
    expect(walkBook([[100, 1]], 0)).toBeNull();
  });
});

describe("estimateFromBook", () => {
  test("deep book: small notional ≈ half-spread impact", () => {
    const bids: BookLevel[] = [[99.9, 100]];
    const asks: BookLevel[] = [[100.1, 100]];
    const e = estimateFromBook(bids, asks, "buy", 1_000)!;
    expect(e.midPx).toBeCloseTo(100, 10);
    expect(e.estPx).toBeCloseTo(100.1, 10);
    expect(e.estImpactBps).toBeCloseTo(10, 5); // 0.1/100 = 10bps
    expect(e.depthLimited).toBe(false);
  });

  test("THIN book: walking deep levels produces a large impact (this is the case that kills 7bps-margin strategies)", () => {
    // Tiny size at touch, real size only 1% away.
    const bids: BookLevel[] = [[100, 0.01], [99, 200]];
    const asks: BookLevel[] = [[100.02, 0.01], [101.02, 200]];
    const e = estimateFromBook(bids, asks, "buy", 10_000)!;
    expect(e.midPx).toBeCloseTo(100.01, 10);
    expect(e.estPx).toBeGreaterThan(101); // nearly the whole fill walks to the deep level
    expect(e.estImpactBps).toBeGreaterThan(90);
    expect(e.depthLimited).toBe(false);

    // sell side symmetry
    const s = estimateFromBook(bids, asks, "sell", 10_000)!;
    expect(s.estPx).toBeLessThan(99.1);
    expect(s.estImpactBps).toBeGreaterThan(90);
  });

  test("exhausted depth surfaces as depthLimited (estimate is a documented lower bound)", () => {
    const e = estimateFromBook([[99.9, 1]], [[100.1, 1]], "buy", 50_000)!;
    expect(e.depthLimited).toBe(true);
  });

  test("missing touch or crossed book → null", () => {
    expect(estimateFromBook([], [[100.1, 1]], "buy", 100)).toBeNull();
    expect(estimateFromBook([[100.2, 1]], [[100.1, 1]], "buy", 100)).toBeNull(); // crossed
  });
});

describe("estimateFromQuote (Alpaca L1-only honest proxy)", () => {
  test("estPx is the side touch, impact the half-spread, depthLimited ALWAYS true", () => {
    const buy = estimateFromQuote(99, 101, "buy")!;
    expect(buy.estPx).toBe(101);
    expect(buy.midPx).toBe(100);
    expect(buy.estImpactBps).toBeCloseTo(100, 5);
    expect(buy.depthLimited).toBe(true); // no depth ladder exists on IEX — never pretend otherwise

    const sell = estimateFromQuote(99, 101, "sell")!;
    expect(sell.estPx).toBe(99);
    expect(sell.estImpactBps).toBeCloseTo(100, 5);
    expect(sell.depthLimited).toBe(true);
  });

  test("degenerate quotes → null", () => {
    expect(estimateFromQuote(0, 101, "buy")).toBeNull();
    expect(estimateFromQuote(102, 101, "buy")).toBeNull();
  });
});
