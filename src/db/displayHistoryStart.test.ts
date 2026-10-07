// "All" and every display "since start" begin at DISPLAY_HISTORY_START when it
// is set. Earlier rows stay stored; they are only left out of the display.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getDisplayHistoryStart, getEquityDisplayStart, getEquityHistoryByRangeDisplay,
  getEquityHistoryDisplay, getEquityPnlDisplay,
} from "./database";
import { makeTestDb, rawSnap } from "../test-support/db";

const HOUR = 3_600_000;
const V8 = Date.now() - 30 * 24 * HOUR;

describe("DISPLAY_HISTORY_START bounds the display history", () => {
  beforeEach(() => { makeTestDb(); delete process.env.DISPLAY_HISTORY_START; });
  afterEach(() => { delete process.env.DISPLAY_HISTORY_START; });

  test("unset (fresh installs, forks) or invalid → 0, the whole series is shown", () => {
    rawSnap("alpaca_main", 100_000, V8 - 10 * 24 * HOUR, 5);
    rawSnap("alpaca_main", 101_000, V8, 5);
    expect(getDisplayHistoryStart()).toBe(0);
    expect(getEquityHistoryByRangeDisplay("alpaca_main", "all").map((r) => r.equity)).toEqual([100_000, 101_000]);
    process.env.DISPLAY_HISTORY_START = "not-a-date";
    expect(getDisplayHistoryStart()).toBe(0);
  });

  test("a YYYY-MM-DD date is its ET day start", () => {
    process.env.DISPLAY_HISTORY_START = "2026-07-10";
    expect(getDisplayHistoryStart()).toBe(Date.parse("2026-07-10T04:00:00Z")); // EDT
  });

  test("set: All / all-time P&L / since-start begin there; older rows stay stored but hidden", () => {
    rawSnap("alpaca_main", 100_000, V8 - 40 * 24 * HOUR, 5); // earlier era
    rawSnap("alpaca_main", 100_500, V8 - 24 * HOUR, 5);      // earlier era
    rawSnap("alpaca_main", 101_000, V8, 5);
    rawSnap("alpaca_main", 104_000, Date.now() - HOUR, 5);
    process.env.DISPLAY_HISTORY_START = new Date(V8).toISOString();

    expect(getDisplayHistoryStart()).toBe(V8);
    expect(getEquityHistoryByRangeDisplay("alpaca_main", "all").map((r) => r.equity)).toEqual([101_000, 104_000]);
    expect(getEquityHistoryDisplay("alpaca_main", 0).map((r) => r.equity)).toEqual([101_000, 104_000]);
    const pnl = getEquityPnlDisplay("alpaca_main", 0)!;
    expect(pnl.startEquity).toBe(101_000);
    expect(pnl.pnl).toBe(3_000);
    expect(getEquityDisplayStart("alpaca_main")!.equity).toBe(101_000);
    // a bounded window is untouched
    expect(getEquityHistoryDisplay("alpaca_main", 365).map((r) => r.equity)).toEqual([100_000, 100_500, 101_000, 104_000]);
  });
});
