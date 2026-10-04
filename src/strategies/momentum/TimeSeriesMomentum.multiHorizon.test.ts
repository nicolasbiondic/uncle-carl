// TSMConfig.lookbackDaysList (opt-in multi-horizon signal — Hurst/Ooi/
// Pedersen 2017): r = MEAN of the lookback returns over each horizon,
// entry/exit thresholds on the blended r, MA trend filter unchanged.
//   1. Blend math: r is exactly the mean of the per-horizon returns.
//   2. A horizon list can veto an entry the strongest single horizon
//      would have taken (the diversification-of-signal semantics).
//   3. Exit/stay hysteresis applies to the blended r too.
//   4. History: a symbol needs the LONGEST horizon (+1 closes) or it is
//      skipped entirely — no partial blends.
//   5. Legacy identity: absent/empty list reproduces the single-horizon
//      ranking output exactly (byte-identical path).
import { describe, expect, test } from "bun:test";
import { TimeSeriesMomentum, type TSMConfig } from "./TimeSeriesMomentum";
import type { OHLCV } from "../../utils/types";

/** Daily bars from a closes array (timestamps 1d apart, ending "now"). */
function daily(closes: number[]): OHLCV[] {
  const end = Date.now();
  return closes.map((c, i) => ({
    open: c, high: c, low: c, close: c, volume: 1,
    timestamp: end - (closes.length - 1 - i) * 86_400_000,
  }));
}

const BASE: Partial<TSMConfig> = {
  barMinutes: 1440,
  maLengthDays: 2,
  entryThresholdPct: 5,
  exitThresholdPct: -2,
  maxLongs: 4,
  maxShorts: 0,
};

describe("TimeSeriesMomentum.lookbackDaysList (multi-horizon blend)", () => {
  test("r is the mean of the per-horizon lookback returns", () => {
    const tsm = new TimeSeriesMomentum({ ...BASE, lookbackDaysList: [2, 4] });
    // px=110; r2 = (110-104)/104, r4 = (110-100)/100; blend ≈ 7.88% ≥ 5% → long.
    const closes = [100, 101, 104, 105, 110];
    const out = tsm.rank(new Map([["A", daily(closes)]]));
    expect(out).toHaveLength(1);
    const r2 = (110 - 104) / 104, r4 = (110 - 100) / 100;
    expect(out[0].score).toBeCloseTo((r2 + r4) / 2, 12);
    expect(out[0].action).toBe("long");
  });

  test("the blend can veto an entry the strongest single horizon would take", () => {
    // r2 = +5% (single-horizon h2 enters), r4 = −4.55% → blend ≈ +0.23% < 5%.
    const closes = [110, 95, 100, 95, 105];
    const candles = new Map([["A", daily(closes)]]);
    const single = new TimeSeriesMomentum({ ...BASE, lookbackDays: 2 }).rank(candles);
    expect(single[0].action).toBe("long");
    const blended = new TimeSeriesMomentum({ ...BASE, lookbackDaysList: [2, 4] }).rank(candles);
    expect(blended[0].action).toBe("flat");
  });

  test("stay hysteresis applies to the blended r: held stays, fresh does not enter", () => {
    // r2 ≈ 0.96%, r4 = +5% → blend ≈ 2.98%: below entry (5%), above exit (−2%).
    const closes = [100, 95, 104, 95, 105];
    const candles = new Map([["A", daily(closes)]]);
    const tsm = new TimeSeriesMomentum({ ...BASE, lookbackDaysList: [2, 4] });
    expect(tsm.rank(candles)[0].action).toBe("flat");
    expect(tsm.rank(candles, new Set(["A"]))[0].action).toBe("long");
  });

  test("a symbol without history for the LONGEST horizon is skipped entirely", () => {
    const closes = [100, 104, 105, 110]; // 4 closes < max(2,4)+1 = 5
    const candles = new Map([["A", daily(closes)]]);
    expect(new TimeSeriesMomentum({ ...BASE, lookbackDaysList: [2, 4] }).rank(candles)).toHaveLength(0);
    // The same tape IS rankable single-horizon at 2d — the skip above came
    // from the blend's longest horizon, not from the tape being unusable.
    expect(new TimeSeriesMomentum({ ...BASE, lookbackDays: 2 }).rank(candles)).toHaveLength(1);
  });

  test("legacy identity: absent and empty list reproduce the single-horizon output exactly", () => {
    const candles = new Map([
      ["UP", daily([100, 101, 104, 105, 110])],
      ["DOWN", daily([110, 108, 106, 104, 100])],
      ["FLATISH", daily([100, 100.5, 101, 100.4, 100.8])],
    ]);
    const legacy = new TimeSeriesMomentum({ ...BASE, lookbackDays: 2 }).rank(candles, new Set(["FLATISH"]));
    const absent = new TimeSeriesMomentum({ ...BASE, lookbackDays: 2, lookbackDaysList: undefined }).rank(candles, new Set(["FLATISH"]));
    const empty = new TimeSeriesMomentum({ ...BASE, lookbackDays: 2, lookbackDaysList: [] }).rank(candles, new Set(["FLATISH"]));
    expect(absent).toEqual(legacy);
    expect(empty).toEqual(legacy);
  });
});
