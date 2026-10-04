// ══════════════════════════════════════════════
// Synthetic-snapshot quarantine (2026-07-28) — equity_snapshots.synthetic=1
// marks rows that are NOT real equity observations (the 2026-04-05→05-10
// linear-backfill segment on both *_main series, the 2026-06-19 binance_main
// bad broker read). They stay in the table (history, reversibility) but must
// be invisible to EVERY P&L / anchor / series read.
//
// Falsifiability: each test targets one specific `AND synthetic = 0` filter.
// Removing the filter from getDisplayEquitySeries flips the "All" start
// anchor to the fabricated row (first test block fails); removing it from
// getEquityAt makes the poisoned reading resurface (second block fails).
// Verified empirically by reverting the filters during development.
// ══════════════════════════════════════════════

import { describe, expect, test, beforeAll } from "bun:test";
import {
  getEquityAt,
  getEquityHistoryByRangeDisplay, getEquityPnlDisplay, getEquityDisplayStart,
  getBotStartedAt, getV8StartedAt,
} from "./database";
import { makeTestDb, rawSnap } from "../test-support/db";

const DAY = 86_400_000;
const T0 = Date.parse("2026-04-05T00:00:00Z");

beforeAll(() => {
  makeTestDb();

  // alpaca_main (registered series, current semantics 5, no transitions in
  // range): a fabricated backfill segment PRECEDING all real data — the
  // exact live shape (the synthetic segment is the first data of the series).
  rawSnap("alpaca_main", 99_999.54, T0, 5, 1);            // synthetic diagonal start
  rawSnap("alpaca_main", 100_500, T0 + 10 * DAY, 5, 1);   // synthetic diagonal middle
  rawSnap("alpaca_main", 101_323.33, T0 + 36 * DAY, 5);   // first REAL observation
  rawSnap("alpaca_main", 102_000, T0 + 40 * DAY, 5);      // latest real

  // binance_main: real series with ONE bad-read dip marked synthetic.
  rawSnap("binance_main", 10_288, T0 + 3 * DAY, 5);
  rawSnap("binance_main", 9_663, T0 + 4 * DAY, 5, 1);     // the −6.1% bad broker read
  rawSnap("binance_main", 10_289, T0 + 5 * DAY, 5);
});

describe("display path (chart + 'All' P&L) excludes synthetic rows", () => {
  test("getEquityPnlDisplay(0) anchors on the first REAL row, not the fabricated segment", () => {
    const r = getEquityPnlDisplay("alpaca_main", 0)!;
    expect(r.startEquity).toBe(101_323.33);
    expect(r.pnl).toBeCloseTo(102_000 - 101_323.33, 6);
  });

  test("getEquityDisplayStart skips the synthetic segment", () => {
    expect(getEquityDisplayStart("alpaca_main")!.equity).toBe(101_323.33);
  });

  test("the 'all' history series (the chart) contains no synthetic row", () => {
    const eqs = getEquityHistoryByRangeDisplay("alpaca_main", "all").map(r => r.equity);
    expect(eqs).toEqual([101_323.33, 102_000]);
    const beqs = getEquityHistoryByRangeDisplay("binance_main", "all").map(r => r.equity);
    expect(beqs).toEqual([10_288, 10_289]);
  });
});

describe("current-era operational anchors exclude synthetic rows", () => {
  test("getEquityAt never returns the bad-read value", () => {
    // At the bad read's own timestamp, the answer is the last REAL reading.
    expect(getEquityAt("binance_main", T0 + 4 * DAY)).toBe(10_288);
  });

  test("getBotStartedAt ignores fabricated history", () => {
    // trades table is empty; the earliest REAL snapshot is binance_main's
    // T0+3d row — NOT alpaca_main's synthetic T0 row.
    expect(getBotStartedAt()).toBe(T0 + 3 * DAY);
  });

  // 2026-09-24 audit fix: getV8StartedAt is the v8-scoped sibling used for the
  // dashboard's "RUNNING" KPI — alpaca_main/binance_main are broker-truth
  // legs, not v8 sleeve ids (ALL_PROFILE_IDS), so neither fixture row above
  // counts; only a v8 sleeve's own snapshot/trade should.
  test("getV8StartedAt ignores non-v8 profile_id/account_id rows (alpaca_main/binance_main aren't sleeve ids)", () => {
    expect(getV8StartedAt()).toBe(Infinity);
    rawSnap("momentum_stocks", 50_000, T0 + 20 * DAY, 5);
    expect(getV8StartedAt()).toBe(T0 + 20 * DAY);
  });
});
