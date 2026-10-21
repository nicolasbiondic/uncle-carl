import { describe, expect, test, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  IndexMembershipView,
  SessionPriceView,
  calendarDaysBetween,
  calendarForSource,
  fundingByUtcSession,
  fundingSessionOf,
  indexOfDate,
  lastIndexAtOrBefore,
  loadFundingRates,
  loadSessionSeries,
  perpSymbolFor,
  seriesFromBars,
  sessionDateOf,
} from "./portfolioData";
import { fixtureBars, writeDailyFixture } from "./portfolioSynthetic";

const tmp = mkdtempSync(join(tmpdir(), "rw-pdata-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("session-date conventions", () => {
  test("stocks: the ET date of an ET-midnight daily bar is the session; crypto: the UTC day", () => {
    expect(calendarForSource("alpaca_wide")).toBe("us");
    expect(calendarForSource("yahoo")).toBe("us");
    expect(calendarForSource("binance_futures")).toBe("utc");
    // Alpaca daily bars: 04:00Z (EDT) / 05:00Z (EST) = ET midnight of the session.
    expect(sessionDateOf(Date.parse("2024-07-01T04:00:00Z"), "us")).toBe("2024-07-01");
    expect(sessionDateOf(Date.parse("2024-01-16T05:00:00Z"), "us")).toBe("2024-01-16");
    // A bar stamped 00:00Z is the previous ET evening, not the UTC date.
    expect(sessionDateOf(Date.parse("2024-07-02T00:00:00Z"), "us")).toBe("2024-07-01");
    expect(sessionDateOf(Date.parse("2024-07-02T00:00:00Z"), "utc")).toBe("2024-07-02");
  });

  test("calendar days between sessions accrue weekends (Fri → Mon = 3)", () => {
    expect(calendarDaysBetween("2024-07-05", "2024-07-08")).toBe(3);
    expect(calendarDaysBetween("2024-07-08", "2024-07-09")).toBe(1);
  });

  test("binary search on ISO dates", () => {
    const dates = ["2024-01-02", "2024-01-03", "2024-01-05"];
    expect(lastIndexAtOrBefore(dates, "2024-01-01")).toBe(-1);
    expect(lastIndexAtOrBefore(dates, "2024-01-03")).toBe(1);
    expect(lastIndexAtOrBefore(dates, "2024-01-04")).toBe(1);
    expect(lastIndexAtOrBefore(dates, "2024-12-31")).toBe(2);
    expect(indexOfDate(dates, "2024-01-04")).toBe(-1);
    expect(indexOfDate(dates, "2024-01-05")).toBe(2);
  });
});

describe("SessionPriceView — point-in-time guard", () => {
  const bars = Array.from({ length: 10 }, (_, i) => ({ date: `2024-01-${String(10 + i).padStart(2, "0")}`, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1 }));
  const series = new Map([["AAA", seriesFromBars("AAA", bars)]]);

  test("never returns a bar dated after asOf; history is oldest → newest and clipped", () => {
    const view = new SessionPriceView(series, "2024-01-14");
    const h = view.history("AAA", 100);
    expect(h.map(b => b.date)).toEqual(["2024-01-10", "2024-01-11", "2024-01-12", "2024-01-13", "2024-01-14"]);
    expect(view.history("AAA", 2).map(b => b.date)).toEqual(["2024-01-13", "2024-01-14"]);
    expect(view.barCount("AAA")).toBe(5);
    expect(view.lastClose("AAA")).toBe(104.5);
    expect(h.every(b => b.date <= view.asOf)).toBe(true);
  });

  test("asOf between sessions clips at the last completed one; unknown symbol → [] / 0", () => {
    const view = new SessionPriceView(series, "2024-01-09");
    expect(view.history("AAA", 5)).toEqual([]);
    expect(view.barCount("AAA")).toBe(0);
    expect(view.lastClose("AAA")).toBeUndefined();
    expect(new SessionPriceView(series, "2024-02-01").barCount("ZZZ")).toBe(0);
    expect(new SessionPriceView(series, "2024-02-01").history("ZZZ", 3)).toEqual([]);
  });
});

describe("IndexMembershipView", () => {
  test("start inclusive, end exclusive, exclusions removed, overlapping tickers for loading", () => {
    const dbPath = join(tmp, "mem.db");
    writeDailyFixture(dbPath, {
      source: "alpaca_wide", from: "2024-01-02", sessions: 5, series: [],
      membership: [
        { index: "sp500", ticker: "AAA", start: "2020-01-01", end: null },
        { index: "sp500", ticker: "BBB", start: "2024-01-03", end: "2024-01-05" },
        { index: "sp500", ticker: "XXX", start: "2000-01-01", end: null },
      ],
    });
    const db = new Database(dbPath, { readonly: true });
    try {
      const view = IndexMembershipView.load(db, "sp500", ["XXX"]);
      expect(view.members("2024-01-02")).toEqual(["AAA"]);
      expect(view.members("2024-01-03")).toEqual(["AAA", "BBB"]);
      expect(view.members("2024-01-04")).toEqual(["AAA", "BBB"]);
      expect(view.members("2024-01-05")).toEqual(["AAA"]);
      expect(view.overlapping(Date.parse("2024-01-06"), Date.parse("2024-02-01"))).toEqual(["AAA"]);
      expect(view.overlapping(Date.parse("2023-01-01"), Date.parse("2024-02-01"))).toEqual(["AAA", "BBB"]);
      expect(() => IndexMembershipView.load(db, "nope")).toThrow(/no rows/);
    } finally {
      db.close();
    }
  });
});

describe("funding", () => {
  test("perp symbol mapping follows the research DB convention", () => {
    expect(perpSymbolFor("BTC/USD")).toBe("BTCUSDT");
    expect(perpSymbolFor("DOGE/USD")).toBe("DOGEUSDT");
  });

  test("a settlement at 00:00 (+ms jitter) of d+1 is paid by the book held through d; 08:00/16:00 by d itself", () => {
    expect(fundingSessionOf(Date.parse("2024-03-02T00:00:00.005Z"))).toBe("2024-03-01");
    expect(fundingSessionOf(Date.parse("2024-03-02T00:00:00.000Z"))).toBe("2024-03-01");
    expect(fundingSessionOf(Date.parse("2024-03-01T08:00:00.003Z"))).toBe("2024-03-01");
    expect(fundingSessionOf(Date.parse("2024-03-01T16:00:00.000Z"))).toBe("2024-03-01");
    const sums = fundingByUtcSession([
      { time: Date.parse("2024-03-01T08:00:00.001Z"), rate: 0.0001 },
      { time: Date.parse("2024-03-01T16:00:00.002Z"), rate: 0.0002 },
      { time: Date.parse("2024-03-02T00:00:00.005Z"), rate: 0.0003 },
      { time: Date.parse("2024-03-02T08:00:00.000Z"), rate: 0.0004 },
    ]);
    expect(sums.get("2024-03-01")).toBeCloseTo(0.0006, 12);
    expect(sums.get("2024-03-02")).toBeCloseTo(0.0004, 12);
  });

  test("loadFundingRates reads the snapshot's funding_rates for the perp symbols in range", () => {
    const dbPath = join(tmp, "fund.db");
    writeDailyFixture(dbPath, { source: "binance_futures", from: "2024-03-01", sessions: 3, fundingRate: 0.0002, series: [{ symbol: "BTC/USD", seed: 1, startPrice: 50_000, driftAnnual: 0, volAnnual: 0.5 }] });
    const db = new Database(dbPath, { readonly: true });
    try {
      const ev = loadFundingRates(db, ["BTCUSDT"], Date.parse("2024-03-01"), Date.parse("2024-03-04"));
      const btc = ev.get("BTCUSDT")!;
      // 00/08/16 × 3 days; the settlement stamped 2024-03-04T00:00:00.005Z
      // sits 5 ms past toMs and is OUT (the same inclusive bound
      // hashDataSnapshot uses, so the sim never reads unhashed rows).
      expect(btc.length).toBe(9);
      expect(btc.every(e => e.rate === 0.0002)).toBe(true);
      expect(btc[0].time).toBe(Date.parse("2024-03-01T00:00:00.005Z"));
    } finally {
      db.close();
    }
  });
});

describe("loadSessionSeries", () => {
  test("stocks fixture: weekday sessions dated by ET, values intact, oldest → newest", () => {
    const dbPath = join(tmp, "stk.db");
    const spec = { source: "alpaca_wide" as const, from: "2024-07-01", sessions: 6, series: [{ symbol: "SPY", seed: 7, startPrice: 500, driftAnnual: 0.1, volAnnual: 0.2 }] };
    writeDailyFixture(dbPath, spec);
    const expected = fixtureBars(spec);
    const db = new Database(dbPath, { readonly: true });
    try {
      const series = loadSessionSeries(db, ["SPY", "MISSING"], "alpaca_wide", "1d", 0, Date.parse("2030-01-01"), "us");
      expect(series.has("MISSING")).toBe(false);
      const spy = series.get("SPY")!;
      // 2024-07-01 (Mon) … skips Sat 07-06 / Sun 07-07.
      expect(spy.dates).toEqual(["2024-07-01", "2024-07-02", "2024-07-03", "2024-07-04", "2024-07-05", "2024-07-08"]);
      expect(Array.from(spy.close)).toEqual(expected.map(b => b.close));
      expect(Array.from(spy.open)).toEqual(expected.map(b => b.open));
      expect(spy.timestamps).toEqual(expected.map(b => b.timestamp));
    } finally {
      db.close();
    }
  });

  test("two rows on one session keep the later row; the range filter applies to timestamps", () => {
    const dbPath = join(tmp, "dup.db");
    const db = new Database(dbPath);
    try {
      db.run(`CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume INTEGER, PRIMARY KEY(symbol, timeframe, source, timestamp))`);
      const ins = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
      ins.run("X", "1d", "alpaca_wide", Date.parse("2024-07-01T04:00:00Z"), 1, 1, 1, 1, 1);
      ins.run("X", "1d", "alpaca_wide", Date.parse("2024-07-01T05:00:00Z"), 2, 2, 2, 2, 2); // same ET session, later stamp
      ins.run("X", "1d", "alpaca_wide", Date.parse("2024-07-02T04:00:00Z"), 3, 3, 3, 3, 3);
      const s = loadSessionSeries(db, ["X"], "alpaca_wide", "1d", 0, Date.parse("2024-07-02T00:00:00Z"), "us").get("X")!;
      expect(s.dates).toEqual(["2024-07-01"]);
      expect(s.close[0]).toBe(2);
    } finally {
      db.close();
    }
  });
});
