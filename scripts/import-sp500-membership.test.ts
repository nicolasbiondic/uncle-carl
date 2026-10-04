// Fixture tests for the S&P 500 membership import (scripts/
// import-sp500-membership.ts) and the PIT membership helpers
// (scripts/lib/membership.ts). Pure fixtures — no network, no real DB
// beyond a :memory: SQLite.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  parseStartEndCsv,
  parseComponentsCsv,
  reconstructMembersAt,
  stripReuseSuffix,
  validateAgainstComponents,
  writeMembership,
} from "./import-sp500-membership";
import {
  loadMembership,
  isMemberAt,
  membersOverlapping,
  medianDollarVolume,
  topNByDollarVolume,
} from "./lib/membership";
import type { OHLCV } from "../src/utils/types";

const FIXTURE_CSV = [
  "ticker,start_date,end_date",
  "AAA,1996-01-02,",            // current member since the beginning
  "BBB,2010-03-01,2020-06-22",  // removed (end EXCLUSIVE)
  "CCC,1996-01-02,2005-01-10",  // reused ticker: two tramos, two companies
  "CCC,2021-04-19,",
  "DDD,2024-09-23,",            // recent addition
].join("\n");

const DAY = 86_400_000;

describe("parseStartEndCsv", () => {
  test("parses tramos with null end for current members", () => {
    const rows = parseStartEndCsv(FIXTURE_CSV);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ ticker: "AAA", startDate: "1996-01-02", endDate: null });
    expect(rows[1]).toEqual({ ticker: "BBB", startDate: "2010-03-01", endDate: "2020-06-22" });
    expect(rows.filter(r => r.ticker === "CCC")).toHaveLength(2);
  });

  test("fail-closed on malformed rows", () => {
    expect(() => parseStartEndCsv("wrong,header,here\nAAA,2020-01-01,")).toThrow(/header/);
    expect(() => parseStartEndCsv("ticker,start_date,end_date\nAAA,2020-13-99,")).toThrow(/start_date/);
    expect(() => parseStartEndCsv("ticker,start_date,end_date\nAAA,2020-01-01,2019-01-01")).toThrow(/end_date/);
    expect(() => parseStartEndCsv("ticker,start_date,end_date\n")).toThrow(/no tramo rows/);
    // Overlapping tramos for one ticker are a data corruption, not a reuse.
    expect(() =>
      parseStartEndCsv("ticker,start_date,end_date\nAAA,2020-01-01,2022-01-01\nAAA,2021-01-01,"),
    ).toThrow(/overlapping/);
  });
});

describe("membership reconstruction + components validation", () => {
  const tramos = parseStartEndCsv(FIXTURE_CSV);

  test("start inclusive, end EXCLUSIVE", () => {
    expect(reconstructMembersAt(tramos, "2010-03-01").has("BBB")).toBe(true);  // start day: in
    expect(reconstructMembersAt(tramos, "2020-06-21").has("BBB")).toBe(true);  // last member day
    expect(reconstructMembersAt(tramos, "2020-06-22").has("BBB")).toBe(false); // removal day: OUT
    expect(reconstructMembersAt(tramos, "2010-01-01").has("CCC")).toBe(false); // between tramos
    expect(reconstructMembersAt(tramos, "2021-04-19").has("CCC")).toBe(true);  // second tramo
  });

  test("validateAgainstComponents matches with reuse suffixes stripped", () => {
    expect(stripReuseSuffix("AAL-199702")).toBe("AAL");
    expect(stripReuseSuffix("BRK.B")).toBe("BRK.B");
    const components = parseComponentsCsv([
      "date,tickers",
      '2015-06-01,"AAA,BBB,CCC-200501"',   // CCC's FIRST company shows suffixed after reuse
      '2020-06-22,"AAA"',                  // BBB removed effective this date
      '2024-09-23,"AAA,CCC,DDD"',
    ].join("\n"));
    // 2015-06-01: tramos give {AAA, BBB}; components (stripped) give
    // {AAA, BBB, CCC} — deliberately broken sample to prove detection…
    const broken = validateAgainstComponents(tramos, components, 1);
    expect(broken.mismatches.length).toBeGreaterThan(0);
    // …and a coherent set validates cleanly.
    const good = parseComponentsCsv([
      "date,tickers",
      '2015-06-01,"AAA,BBB"',
      '2020-06-22,"AAA"',
      '2024-09-23,"AAA,CCC,DDD"',
    ].join("\n"));
    const v = validateAgainstComponents(tramos, good, 1);
    expect(v.mismatches).toEqual([]);
    expect(v.checkedDates).toBe(3);
  });
});

describe("writeMembership + loadMembership (round-trip)", () => {
  test("round-trips through index_membership and answers PIT queries", () => {
    const db = new Database(":memory:");
    const tramos = parseStartEndCsv(FIXTURE_CSV);
    const written = writeMembership(db, tramos, { indexId: "sp500", source: "fixture", sourceCommit: "deadbeef" });
    expect(written).toBe(5);
    // Idempotent: a re-import replaces, never duplicates.
    expect(writeMembership(db, tramos, { indexId: "sp500", source: "fixture", sourceCommit: "deadbeef" })).toBe(5);
    expect((db.query("SELECT COUNT(*) n FROM index_membership").get() as any).n).toBe(5);

    const book = loadMembership(db, "sp500");
    expect(isMemberAt(book, "BBB", Date.parse("2020-06-21T04:00:00Z"))).toBe(true);
    expect(isMemberAt(book, "BBB", Date.parse("2020-06-22T04:00:00Z"))).toBe(false); // end EXCLUSIVE
    expect(isMemberAt(book, "CCC", Date.parse("2010-01-05T04:00:00Z"))).toBe(false); // between tramos
    expect(isMemberAt(book, "CCC", Date.parse("2022-01-05T04:00:00Z"))).toBe(true);
    expect(isMemberAt(book, "ZZZ", Date.parse("2022-01-05T04:00:00Z"))).toBe(false);

    expect(membersOverlapping(book, Date.parse("2016-01-01"), Date.parse("2026-01-01")))
      .toEqual(["AAA", "BBB", "CCC", "DDD"]);
    expect(membersOverlapping(book, Date.parse("2021-01-01"), Date.parse("2026-01-01")))
      .toEqual(["AAA", "CCC", "DDD"]);

    expect(() => loadMembership(db, "nope")).toThrow(/no rows/);
    expect(() => loadMembership(new Database(":memory:"), "sp500")).toThrow(/unavailable/);
  });
});

describe("point-in-time liquidity ranking", () => {
  const bar = (i: number, close: number, volume: number): OHLCV =>
    ({ timestamp: i * DAY, open: close, high: close, low: close, close, volume });

  test("medianDollarVolume uses only bars CLOSED at nowMs (no lookahead)", () => {
    const bars = [bar(0, 10, 100), bar(1, 10, 200), bar(2, 10, 300), bar(3, 10, 9_999_999)];
    // now = close of bar 2 + 1 day ⇒ bars 0..2 closed, bar 3 NOT closed.
    const now = 3 * DAY;
    expect(medianDollarVolume(bars, now, DAY, 3)).toBe(10 * 200);
    // Mutating the future bar must not change the score.
    const mutated = [...bars.slice(0, 3), bar(3, 99999, 1)];
    expect(medianDollarVolume(mutated, now, DAY, 3)).toBe(10 * 200);
    // Insufficient closed history ⇒ not rankable.
    expect(medianDollarVolume(bars, now, DAY, 4)).toBeNull();
  });

  test("topNByDollarVolume is deterministic with symbol tie-break", () => {
    const candles = new Map<string, OHLCV[]>([
      ["HI", [bar(0, 100, 1000), bar(1, 100, 1000)]],
      ["LO", [bar(0, 10, 100), bar(1, 10, 100)]],
      ["TIE_B", [bar(0, 50, 100), bar(1, 50, 100)]],
      ["TIE_A", [bar(0, 50, 100), bar(1, 50, 100)]],
      ["SHORT", [bar(1, 1_000_000, 1_000_000)]], // only 1 closed bar — unrankable
    ]);
    const now = 2 * DAY;
    expect([...topNByDollarVolume(candles.keys(), candles, now, DAY, 2, 2)]).toEqual(["HI", "TIE_A"]);
    expect([...topNByDollarVolume(candles.keys(), candles, now, DAY, 2, 3)]).toEqual(["HI", "TIE_A", "TIE_B"]);
  });
});
