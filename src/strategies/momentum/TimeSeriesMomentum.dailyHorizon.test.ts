// TSM on DAILY bars with a long horizon (barMinutes 1440 + lookbackDays/
// maLengthDays — the momentum-stocks-horizon axis): "days" must map 1:1 to
// daily bars, the ranker must require exactly max(lookback, MA)+1 closes,
// and the lookback return must anchor at closes[len-1-lookbackDays].

import { describe, expect, test } from "bun:test";
import { TimeSeriesMomentum } from "./TimeSeriesMomentum";
import type { OHLCV } from "../../utils/types";

const DAY = 86_400_000;

function dailyBars(n: number, close: (i: number) => number): OHLCV[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: Date.parse("2020-01-01T05:00:00Z") + i * DAY,
    open: close(i), high: close(i) * 1.001, low: close(i) * 0.999, close: close(i), volume: 1,
  }));
}

describe("TimeSeriesMomentum — daily bars, long horizon", () => {
  const tsm = new TimeSeriesMomentum({
    barMinutes: 1440,
    lookbackDays: 252,
    maLengthDays: 200,
    entryThresholdPct: 5,
    exitThresholdPct: -2,
    maxLongs: 4,
    maxShorts: 0,
  });

  test("253 daily bars suffice (max(252,200)+1); 252 do not", () => {
    const rising = (i: number) => 100 * (1 + i / 500);
    expect(tsm.rank(new Map([["AAA", dailyBars(252, rising)]]))).toHaveLength(0);
    const decisions = tsm.rank(new Map([["AAA", dailyBars(253, rising)]]));
    expect(decisions).toHaveLength(1);
  });

  test("lookback return anchors exactly 252 daily bars back and enters above +5% with px > MA200", () => {
    const rising = (i: number) => 100 * (1 + i / 500); // +50.4%/252 bars, monotonic ⇒ px > MA
    const bars = dailyBars(253, rising);
    const [d] = tsm.rank(new Map([["AAA", bars]]));
    const closes = bars.map(b => b.close);
    const expectedR = (closes[252] - closes[0]) / closes[0];
    expect(d.action).toBe("long");
    expect(d.score).toBeCloseTo(expectedR, 12);
  });

  test("a flat tape (r below +5%) stays flat even with plenty of history", () => {
    const flat = (i: number) => 100 + Math.sin(i / 10); // ~0% lookback return
    const [d] = new TimeSeriesMomentum({
      barMinutes: 1440, lookbackDays: 126, maLengthDays: 200,
      entryThresholdPct: 5, exitThresholdPct: -2, maxLongs: 4, maxShorts: 0,
    }).rank(new Map([["AAA", dailyBars(300, flat)]]));
    expect(d.action).toBe("flat");
  });
});
