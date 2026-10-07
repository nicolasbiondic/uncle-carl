import { describe, expect, test } from "bun:test";
import { displayBucketMs, resampleEquityForDisplay, windowDays } from "./equityResample";

const MIN = 60_000;
const HOUR = 60 * MIN;
const pt = (t: number, equity = 100) => ({ snapshot_time: t, equity, cash: 0, rebased: false });

describe("displayBucketMs / windowDays", () => {
  test("Today keeps 5 min; 7D hourly; 30D 2 h; all-time daily", () => {
    expect(displayBucketMs(1)).toBe(5 * MIN);
    expect(displayBucketMs(7)).toBe(HOUR);
    expect(displayBucketMs(30)).toBe(2 * HOUR);
    expect(displayBucketMs(0)).toBe(24 * HOUR);
  });
  test("maps the route's query to a window", () => {
    expect(windowDays(7, undefined)).toBe(7);
    expect(windowDays(undefined, "all")).toBe(0);
    expect(windowDays(undefined, "1w")).toBe(7);
    expect(windowDays(undefined, "1m")).toBe(30);
    expect(windowDays(undefined, "1d")).toBe(1);
    expect(windowDays(undefined, undefined)).toBe(30);
  });
});

describe("resampleEquityForDisplay", () => {
  // Mon 2026-10-05 00:00 ET = 04:00 UTC.
  const MON = Date.UTC(2026, 9, 5, 4, 0);

  test("hourly-stored days and 5-min-stored days come out at one cadence (width ∝ time)", () => {
    const rows = [];
    for (let h = 0; h < 48; h++) rows.push(pt(MON - 48 * HOUR + h * HOUR + MIN));          // old: 1/hour
    for (let m = 0; m < 48 * 12; m++) rows.push(pt(MON + m * 5 * MIN + 2 * MIN));          // recent: 1/5 min
    const out = resampleEquityForDisplay(rows, HOUR);
    // The chart gives every point the same width: one point per hour, old or
    // recent, is what makes width proportional to time.
    const perHour = new Map<number, number>();
    for (const r of out.slice(1)) perHour.set(Math.floor(r.snapshot_time / HOUR), (perHour.get(Math.floor(r.snapshot_time / HOUR)) ?? 0) + 1);
    expect(Math.max(...perHour.values())).toBe(1);
    expect(perHour.size).toBe(96 - 1); // every hour of the span except the first point's own hour
  });

  test("keeps the window's first point and ends on the newest reading", () => {
    const rows = [pt(MON, 1), pt(MON + 5 * MIN, 2), pt(MON + 10 * MIN, 3), pt(MON + 65 * MIN, 4), pt(MON + 70 * MIN, 5)];
    const out = resampleEquityForDisplay(rows, HOUR);
    expect(out[0].equity).toBe(1);
    expect(out[out.length - 1].equity).toBe(5);
    expect(out.map((r) => r.equity)).toEqual([1, 3, 5]); // last of the first hour, then the newest
  });

  test("market-hours-only drops nights and the weekend, keeping first and newest", () => {
    const SAT = Date.UTC(2026, 9, 3, 16, 0); // Sat 12:00 ET
    const rows = [
      pt(Date.UTC(2026, 9, 2, 13, 0), 1),  // Fri 09:00 ET — first point, kept
      pt(Date.UTC(2026, 9, 2, 15, 0), 2),  // Fri 11:00 ET — session
      pt(Date.UTC(2026, 9, 2, 19, 0), 3),  // Fri 15:00 ET — session
      pt(Date.UTC(2026, 9, 2, 23, 0), 4),  // Fri 19:00 ET — after hours
      pt(SAT, 5),                          // Saturday
      pt(SAT + 24 * HOUR, 6),              // Sunday
      pt(Date.UTC(2026, 9, 5, 15, 0), 7),  // Mon 11:00 ET — session
      pt(Date.UTC(2026, 9, 5, 22, 0), 8),  // Mon 18:00 ET — newest, kept
    ];
    expect(resampleEquityForDisplay(rows, HOUR, true).map((r) => r.equity)).toEqual([1, 2, 3, 7, 8]);
  });

  test("short series pass through untouched", () => {
    const rows = [pt(MON, 1), pt(MON + MIN, 2)];
    expect(resampleEquityForDisplay(rows, HOUR, true)).toBe(rows);
  });
});
