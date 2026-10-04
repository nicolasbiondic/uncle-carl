// ══════════════════════════════════════════════
// AlpacaMomentumAdapter.fetchCandles — production/replay parity
// ══════════════════════════════════════════════
//
// The corrected walk-forward replay (scripts/backtest-momentum-wf.ts) only
// ever sees regular-trading-hours, fully-closed 5-min bars. Live production
// must feed the momentum engine the exact same shape of data, or the live
// bot trades a different (unvalidated) input distribution than the one the
// backtest proved has an edge.

import { describe, test, expect } from "bun:test";
import { AlpacaMomentumAdapter } from "./AlpacaMomentumAdapter";
import type { OHLCV } from "../../utils/types";

function bar(timestamp: number, close = 100): OHLCV {
  return { open: close, high: close, low: close, close, volume: 10, timestamp };
}

function fakeAlpaca(bars: OHLCV[]) {
  const calls: number[] = [];
  return {
    calls,
    getBars: async (_symbol: string, _tf: string, limit: number) => { calls.push(limit); return bars; },
  } as any;
}

describe("AlpacaMomentumAdapter.fetchCandles — 5Min sleeve (momentum_stocks)", () => {
  // Monday 2024-01-08, EST (UTC-5, no DST in January).
  const BLACK_FRIDAY_AFTER_CLOSE = Date.UTC(2023, 10, 24, 18, 30, 0); // Fri 13:30 ET — early close was 13:00
  const CHRISTMAS_RTH = Date.UTC(2023, 11, 25, 15, 0, 0); // Mon 10:00 ET — holiday
  const SAT_PREMARKET = Date.UTC(2024, 0, 6, 15, 0, 0);   // Sat 10:00 ET — weekend, not RTH
  const MON_PREMARKET = Date.UTC(2024, 0, 8, 13, 0, 0);   // Mon 08:00 ET — pre-market, not RTH
  const MON_RTH_1 = Date.UTC(2024, 0, 8, 15, 0, 0);       // Mon 10:00 ET — RTH, closed
  const MON_RTH_2 = Date.UTC(2024, 0, 8, 20, 50, 0);      // Mon 15:50 ET — RTH, closed by NOW
  const MON_RTH_FORMING = Date.UTC(2024, 0, 8, 20, 55, 0); // Mon 15:55 ET — RTH but still forming
  const NOW = Date.UTC(2024, 0, 8, 20, 58, 0);            // Mon 15:58 ET

  test("drops holidays, early-close overflow, weekend, pre-market, and forming bars", async () => {
    const raw = [
      bar(BLACK_FRIDAY_AFTER_CLOSE, 88),
      bar(CHRISTMAS_RTH, 89),
      bar(SAT_PREMARKET, 90),
      bar(MON_PREMARKET, 95),
      bar(MON_RTH_1, 101),
      bar(MON_RTH_2, 102),
      bar(MON_RTH_FORMING, 999), // must never leak into the engine's input
    ];
    const alpaca = fakeAlpaca(raw);
    const adapter = new AlpacaMomentumAdapter(alpaca, { timeframe: "5Min" });

    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const out = await adapter.fetchCandles("SPY", 2);
      expect(out.map(b => b.close)).toEqual([101, 102]);
      expect(alpaca.calls).toEqual([2]); // enough on the first ask — no widening needed
    } finally {
      Date.now = realNow;
    }
  });

  test("widens the ask (bounded) when RTH+closed filtering leaves too few bars", async () => {
    // Only 1 of 3 raw bars survives filtering; asking for 2 must widen once.
    const raw = [
      bar(SAT_PREMARKET, 90),
      bar(MON_PREMARKET, 95),
      bar(MON_RTH_1, 101),
    ];
    const alpaca = fakeAlpaca(raw);
    const adapter = new AlpacaMomentumAdapter(alpaca, { timeframe: "5Min" });

    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const out = await adapter.fetchCandles("SPY", 2);
      expect(out.map(b => b.close)).toEqual([101]);
      // Widens once (2 → 4); the fake always returns the same 3-bar set, so
      // raw.length(3) < requested(4) signals "history exhausted" and the
      // bounded loop stops there instead of spinning to the 4-attempt cap.
      expect(alpaca.calls).toEqual([2, 4]);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("AlpacaMomentumAdapter.fetchCandles — 1Day sleeve (meanrev_stocks)", () => {
  test("does not apply RTH/forming-bar filtering — MeanRevEngine owns daily-bar hygiene", async () => {
    // A same-day (still-forming, by daily-bar standards) bar must pass through
    // untouched: MeanRevEngine already strips today's partial daily bar itself
    // (getETDateKey comparison) — filtering here too would double-drop.
    const raw = [bar(Date.now() - 86_400_000, 50), bar(Date.now(), 51)];
    const alpaca = fakeAlpaca(raw);
    const adapter = new AlpacaMomentumAdapter(alpaca, { timeframe: "1Day" });

    const out = await adapter.fetchCandles("AAPL", 2);
    expect(out).toEqual(raw);
    expect(alpaca.calls).toEqual([2]);
  });
});
