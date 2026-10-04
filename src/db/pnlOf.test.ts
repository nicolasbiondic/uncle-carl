// Fix A5 (2026-07-26): the price-diff PnL formula was hand-copied at 9 call
// sites and the entry=0/qty=0 → ±Infinity guard lived in only one (closeTrade).
// pnlOf is now the single source; this locks the regression class.

import { describe, expect, test } from "bun:test";
import { pnlOf } from "./database";

describe("pnlOf — canonical guarded PnL", () => {
  test("buy/sell formula matches the historical expression", () => {
    expect(pnlOf("buy", 100, 110, 2)).toEqual({ pnl: 20, pnlPct: 10, raw: 20 });
    expect(pnlOf("sell", 100, 90, 2)).toEqual({ pnl: 20, pnlPct: 10, raw: 20 });
    expect(pnlOf("sell", 100, 110, 2).pnl).toBe(-20);
  });

  test("entry=0, qty=0, non-finite exit — pnl/pnlPct are NEVER NaN/Infinity", () => {
    const cases = [
      pnlOf("buy", 0, 110, 2),        // entry 0 → pct divisor 0
      pnlOf("buy", 100, 110, 0),      // qty 0 → pct divisor 0
      pnlOf("buy", 0, 0, 0),          // everything 0
      pnlOf("buy", 100, NaN, 2),      // NaN exit
      pnlOf("sell", 100, Infinity, 2),// Infinity exit
      pnlOf("buy", Infinity, Infinity, 1), // Inf−Inf = NaN raw
      pnlOf("buy", NaN, NaN, NaN),
    ];
    for (const c of cases) {
      expect(Number.isFinite(c.pnl)).toBe(true);
      expect(Number.isFinite(c.pnlPct)).toBe(true);
    }
  });

  test("entry=0 with finite exit keeps the (finite) raw pnl but zeroes the pct", () => {
    const c = pnlOf("buy", 0, 110, 2);
    expect(c.pnl).toBe(220); // (110-0)*2 is finite — preserved, only the pct is guarded
    expect(c.pnlPct).toBe(0);
  });

  test("raw exposes non-finiteness for closeTrade's MANUAL_CLOSE_UNRECONCILED detection", () => {
    expect(Number.isFinite(pnlOf("buy", NaN, 110, 2).raw)).toBe(false);
    expect(pnlOf("buy", NaN, 110, 2).pnl).toBe(0);
  });
});
