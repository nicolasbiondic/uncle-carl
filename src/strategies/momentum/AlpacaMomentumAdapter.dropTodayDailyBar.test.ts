// AlpacaMomentumAdapterConfig.dropTodayDailyBar (opt-in, daily-horizon
// momentum_stocks wiring): the "1Day" fetchCandles path must strip TODAY's
// still-forming daily bar (MomentumEngine has no MeanRevEngine-style strip
// of its own) and still return the requested number of bars; absent/false
// keeps the raw pass-through byte-identical (meanrev strips for itself —
// dropping here too would double-drop).

import { describe, expect, test } from "bun:test";
import { AlpacaMomentumAdapter } from "./AlpacaMomentumAdapter";
import { getETDayStart } from "../../db/database";
import type { OHLCV } from "../../utils/types";

const DAY = 86_400_000;

function makeStub(bars: OHLCV[]) {
  const calls: Array<{ timeframe: string; n: number }> = [];
  const stub = {
    getBars: async (_symbol: string, timeframe: string, n: number) => {
      calls.push({ timeframe, n });
      return bars.slice(-n);
    },
  } as any;
  return { stub, calls };
}

// 6 completed daily bars ending YESTERDAY, plus today's partial bar (ET
// midnight anchor — the alpaca_wide timestamp convention).
const todayStart = getETDayStart();
const bars: OHLCV[] = Array.from({ length: 7 }, (_, i) => {
  const ts = todayStart - (6 - i) * DAY;
  const px = 100 + i;
  return { timestamp: ts, open: px, high: px, low: px, close: px, volume: 1 };
});
const todayBar = bars[bars.length - 1];

describe("AlpacaMomentumAdapter.fetchCandles — 1Day partial-bar strip", () => {
  test("dropTodayDailyBar: strips today's bar, still returns the requested count", async () => {
    const { stub, calls } = makeStub(bars);
    const adapter = new AlpacaMomentumAdapter(stub, { timeframe: "1Day", dropTodayDailyBar: true });
    const out = await adapter.fetchCandles("SPY", 3);
    expect(calls[0].n).toBe(4); // requests one extra to survive the strip
    expect(out).toHaveLength(3);
    expect(out.some(b => b.timestamp === todayBar.timestamp)).toBe(false);
    expect(out[out.length - 1].timestamp).toBe(todayBar.timestamp - DAY);
  });

  test("dropTodayDailyBar with no today's bar present (e.g. pre-open fetch): nothing stripped", async () => {
    const completedOnly = bars.slice(0, -1);
    const { stub } = makeStub(completedOnly);
    const adapter = new AlpacaMomentumAdapter(stub, { timeframe: "1Day", dropTodayDailyBar: true });
    const out = await adapter.fetchCandles("SPY", 3);
    expect(out).toHaveLength(3);
    expect(out[out.length - 1].timestamp).toBe(todayBar.timestamp - DAY);
  });

  test("default (flag absent): raw pass-through, today's partial bar included — the meanrev contract", async () => {
    const { stub, calls } = makeStub(bars);
    const adapter = new AlpacaMomentumAdapter(stub, { timeframe: "1Day" });
    const out = await adapter.fetchCandles("SPY", 3);
    expect(calls[0].n).toBe(3); // no extra request
    expect(out).toHaveLength(3);
    expect(out[out.length - 1].timestamp).toBe(todayBar.timestamp);
  });
});
