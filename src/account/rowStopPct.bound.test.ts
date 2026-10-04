// rowStopPct sanity ceiling (OPEN.md P2 2026-08-29): trades.stop_loss is
// load-bearing since the 2026-08-28 override, but the derivation only checked
// the protective SIDE, not the magnitude — entry $100 / stop $0.01 derived a
// 99.99% "stop" that de-facto disabled the 15s loop and armed an absurd GTC
// while the dashboard read "protected". Anything wider than ROW_STOP_MAX_PCT
// (3× the widest configured vol-stop maxPct: 3×12 = 36) now falls back to the
// profile distance. The pre-existing unit tests (protective side, fallback,
// precedence) live in volStopEntry.test.ts and must keep passing untouched —
// every distance ≤ 36 derives exactly as before.

import { describe, expect, test } from "bun:test";
import { rowStopPct, ROW_STOP_MAX_PCT } from "./AccountManager";

describe("rowStopPct magnitude ceiling", () => {
  test("ceiling constant is 3× the widest configured maxPct (12)", () => {
    expect(ROW_STOP_MAX_PCT).toBe(36);
  });

  test("corrupt near-zero stop (entry $100 / stop $0.01 → 99.99%) falls back to the profile distance", () => {
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: 0.01, symbol: "AAPL", id: "t1" }, 4)).toBe(4);
  });

  test("short side breach (stop far above entry) falls back too", () => {
    expect(rowStopPct({ side: "sell", entryPrice: 100, stopLoss: 500, symbol: "AAPL", id: "t2" }, 4)).toBe(4);
  });

  test("boundary: exactly 36% passes through; just past it falls back", () => {
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: 64 }, 4)).toBeCloseTo(36, 10);   // == ceiling → honored
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: 63.9 }, 4)).toBe(4);              // 36.1% → fallback
  });

  test("sane distances are untouched (the volStopEntry.test.ts contract): 6% long, 3% short, fallback paths", () => {
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: 94 }, 4)).toBeCloseTo(6, 10);
    expect(rowStopPct({ side: "sell", entryPrice: 100, stopLoss: 103 }, 4)).toBeCloseTo(3, 10);
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: null }, 4)).toBe(4);
    expect(rowStopPct({ side: "buy", entryPrice: 100, stopLoss: 105 }, 4)).toBe(4); // inverted — pre-existing side check
  });
});
