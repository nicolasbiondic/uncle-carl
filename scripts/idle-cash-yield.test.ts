// Fixture tests for the idle-cash-yield arithmetic (S3 research 2026-09-27).
// Locks the pure functions of scripts/idle-cash-yield.ts: idle-fraction
// reconstruction from closedTrades, the act/360 DTB3 overlay (incl. the
// momentum-daily label lag), metric math, DTB3 CSV parsing (holiday
// carry-forward) and the outer-base run selection rule.

import { describe, test, expect } from "bun:test";
import {
  idleFractionSeries,
  overlayReturns,
  seriesMetrics,
  parseDtb3Csv,
  selectOuterBaseRuns,
  utcDateKey,
  type EquityPoint,
  type ReplayTrade,
} from "./idle-cash-yield";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1); // 2024-01-01

describe("idleFractionSeries", () => {
  test("no trades → fully idle", () => {
    const eq: EquityPoint[] = [{ t: T0, eq: 100 }, { t: T0 + DAY, eq: 100 }];
    expect(idleFractionSeries(eq, [])).toEqual([1, 1]);
  });

  test("open notional at entry-cost basis, trade active on [entryAt, exitAt)", () => {
    const eq: EquityPoint[] = [
      { t: T0, eq: 100 },
      { t: T0 + DAY, eq: 100 },
      { t: T0 + 2 * DAY, eq: 100 },
      { t: T0 + 3 * DAY, eq: 100 },
    ];
    // 5 shares @ $8 = $40 notional, held days 1..2 (exit ON day 3 boundary → released)
    const trades: ReplayTrade[] = [{ entryAt: T0 + DAY, exitAt: T0 + 3 * DAY, entryPrice: 8, qty: 5 }];
    expect(idleFractionSeries(eq, trades)).toEqual([1, 0.6, 0.6, 1]);
  });

  test("levered book (notional > equity) clamps to 0, never negative", () => {
    const eq: EquityPoint[] = [{ t: T0, eq: 100 }];
    const trades: ReplayTrade[] = [{ entryAt: T0 - DAY, exitAt: T0 + DAY, entryPrice: 30, qty: 5 }]; // $150 notional
    expect(idleFractionSeries(eq, trades)).toEqual([0]);
  });

  test("overlapping trades sum their notionals", () => {
    const eq: EquityPoint[] = [{ t: T0, eq: 200 }];
    const trades: ReplayTrade[] = [
      { entryAt: T0 - DAY, exitAt: T0 + DAY, entryPrice: 10, qty: 5 },  // $50
      { entryAt: T0 - 2 * DAY, exitAt: T0 + 2 * DAY, entryPrice: 25, qty: 2 }, // $50
    ];
    expect(idleFractionSeries(eq, trades)).toEqual([0.5]);
  });
});

describe("overlayReturns (act/360)", () => {
  test("360 calendar days at 4% on 50% idle adds exactly 2% simple", () => {
    const eq: EquityPoint[] = [{ t: T0, eq: 100 }, { t: T0 + 360 * DAY, eq: 100 }];
    const o = overlayReturns(eq, [0.5, 0.5], () => 0.04);
    expect(o.base[0]).toBeCloseTo(0, 12);
    expect(o.withYield[0]).toBeCloseTo(0.02, 12);
    expect(o.extraCompounded).toBeCloseTo(0.02, 12);
  });

  test("weekend gap accrues 3/360 — act/360 over the real calendar gap", () => {
    // Friday → Monday: 3 days at 3.6% on fully idle cash = 3.6% × 3/360 = 0.03%
    const fri = Date.UTC(2024, 0, 5);
    const eq: EquityPoint[] = [{ t: fri, eq: 100 }, { t: fri + 3 * DAY, eq: 100 }];
    const o = overlayReturns(eq, [1, 1], () => 0.036);
    expect(o.withYield[0]).toBeCloseTo(0.0003, 12);
  });

  test("labelLagDays shifts the DTB3 lookup back one day (momentum daily labels by session END)", () => {
    const seen: string[] = [];
    const eq: EquityPoint[] = [{ t: T0 + DAY, eq: 100 }, { t: T0 + 2 * DAY, eq: 100 }];
    overlayReturns(eq, [1, 1], k => { seen.push(k); return 0.04; }, 1);
    expect(seen).toEqual([utcDateKey(T0)]); // 2024-01-02 labeled point → 2024-01-01 rate
  });

  test("zero idle fraction → overlay is a no-op", () => {
    const eq: EquityPoint[] = [{ t: T0, eq: 100 }, { t: T0 + DAY, eq: 110 }];
    const o = overlayReturns(eq, [0, 0], () => 0.05);
    expect(o.withYield[0]).toBe(o.base[0]);
    expect(o.extraCompounded).toBe(0);
  });
});

describe("seriesMetrics", () => {
  test("CAGR compounds over calendar time", () => {
    // +21% over exactly 2 years → CAGR = 1.21^(1/2) − 1 = 10%
    const m = seriesMetrics([0.1, 0.1], 2 * 365.25 * DAY);
    expect(m.totalReturn).toBeCloseTo(0.21, 12);
    expect(m.cagr).toBeCloseTo(0.1, 12);
  });

  test("maxDD from the compounded curve", () => {
    const m = seriesMetrics([0.5, -0.4, 0.2], 365.25 * DAY);
    // curve: 1.5, 0.9, 1.08 → peak 1.5, trough 0.9 → DD 40%
    expect(m.maxDrawdown).toBeCloseTo(0.4, 12);
  });

  test("constant returns → zero variance → Sharpe 0 (guard, not NaN)", () => {
    const m = seriesMetrics([0.01, 0.01], 365.25 * DAY);
    expect(m.sharpe).toBe(0);
    expect(Number.isFinite(m.cagr)).toBe(true);
  });

  test("Sharpe annualizes by observed frequency", () => {
    // alternating ±1% daily for one year (252 obs): mean 0, sharpe 0; add drift
    const rets = Array.from({ length: 252 }, (_, i) => (i % 2 === 0 ? 0.011 : -0.009));
    const m = seriesMetrics(rets, 365.25 * DAY);
    // mean 0.001, sd ≈ 0.01002, periods/yr = 252 → sharpe ≈ 0.001/0.01002×√252
    expect(m.sharpe).toBeCloseTo((0.001 / Math.sqrt(0.00010040160642570284)) * Math.sqrt(252 / 1), 1);
  });
});

describe("parseDtb3Csv", () => {
  const csv = [
    "observation_date,DTB3",
    "2024-01-02,5.25",
    "2024-01-03,.",      // holiday marker
    "2024-01-04,5.20",
  ].join("\n");

  test("percent → fraction, holidays carry forward", () => {
    const rate = parseDtb3Csv(csv);
    expect(rate("2024-01-02")).toBeCloseTo(0.0525, 12);
    expect(rate("2024-01-03")).toBeCloseTo(0.0525, 12); // "." skipped → carry-forward
    expect(rate("2024-01-04")).toBeCloseTo(0.052, 12);
    expect(rate("2024-06-01")).toBeCloseTo(0.052, 12);  // past end → last known
    expect(rate("2023-12-31")).toBeCloseTo(0.0525, 12); // before start → first known
  });

  test("empty csv throws", () => {
    expect(() => parseDtb3Csv("observation_date,DTB3\n")).toThrow();
  });
});

describe("selectOuterBaseRuns", () => {
  const mkRun = (foldPath: string, costTier: string, slippageBps: number, commissionBps: number, tag: string) => ({
    foldPath,
    costTier,
    result: { config: { slippageBps, commissionBps }, equityHistory: [{ t: T0, eq: 1 }], closedTrades: [], tag },
  });

  test("keeps only outer test runs at exactly the manifest base costs, first per fold", () => {
    const runs = [
      mkRun("0/0", "base", 2, 0, "inner"),              // inner fold → out
      mkRun("0/test", "base", 2, 0, "outer-base"),      // ✓
      mkRun("0/test", "stress", 5, 2, "outer-stress"),  // stress tier → out
      mkRun("0/test", "base", 0, 0, "sweep-0"),         // break-even sweep → out
      mkRun("0/test", "base", 30, 0, "sweep-30"),       // break-even sweep → out
      mkRun("0/test", "base", 2, 0, "duplicate"),       // dup fold → out (first wins)
      mkRun("1/test", "base", 2, 0, "outer-base-f1"),   // ✓
    ];
    const picked = selectOuterBaseRuns(runs as any, { slippageBps: 2, commissionBps: 0 });
    expect(picked.map(r => r.foldPath)).toEqual(["0/test", "1/test"]);
  });

  test("missing commissionBps in config treated as 0", () => {
    const run = {
      foldPath: "0/test", costTier: "base",
      result: { config: { slippageBps: 2 }, equityHistory: [], closedTrades: [] },
    };
    expect(selectOuterBaseRuns([run] as any, { slippageBps: 2 }).length).toBe(1);
  });
});
