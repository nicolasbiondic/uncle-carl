import { describe, expect, test } from "bun:test";
import { buildPerformanceSummary } from "./performanceSummary";

describe("buildPerformanceSummary", () => {
  test("shows realized P&L from trades table, % relative to current equity", () => {
    expect(
      buildPerformanceSummary({ totalEquity: 11_800, realizedPnl: 1_200 })
    ).toEqual({
      equityPnl: 1_200,
      equityPnlPct: (1_200 / 11_800) * 100,
    });
  });

  test("avoids division by zero when totalEquity is zero", () => {
    expect(
      buildPerformanceSummary({ totalEquity: 0, realizedPnl: -50 })
    ).toEqual({
      equityPnl: -50,
      equityPnlPct: -5_000,
    });
  });

  test("rebased=true nulls the pct but keeps the $ delta accurate", () => {
    // A DISPLAY-history starting anchor that required a configured cross-era
    // rebase to reach: the $ pnl is still real (the offset cancels a real
    // methodology jump), but base is synthetic — pct would be misleading.
    expect(
      buildPerformanceSummary({ totalEquity: 11_800, realizedPnl: 1_200, startingEquity: 10_000, rebased: true })
    ).toEqual({
      equityPnl: 1_800,
      equityPnlPct: null,
    });
  });
});
