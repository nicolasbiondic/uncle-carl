import { describe, expect, test } from "bun:test";
import {
  getMarketStatus,
  getPreviousTradingDay,
  getSessionClose,
  isMarketOpen,
  isTradingDay,
} from "./marketHours";

/** Build a UTC timestamp from an ET wall-clock time on a given date key. */
function et(dateKey: string, hour: number, minute: number): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  // ET → UTC requires the correct offset. For test dates below, summer dates
  // are EDT (-4) and winter dates are EST (-5). The helper is only used for
  // predictable non-transition trading days.
  const isSummer = m >= 4 && m <= 10;
  const offset = isSummer ? 4 : 5;
  return Date.UTC(y, m - 1, d, hour + offset, minute, 0);
}

describe("isTradingDay", () => {
  const cases: { key: string; expected: boolean; note: string }[] = [
    // regular days
    { key: "2024-01-02", expected: true, note: "regular Tue" },
    { key: "2026-07-17", expected: true, note: "regular Fri" },
    // weekends
    { key: "2026-07-18", expected: false, note: "Sat" },
    { key: "2026-07-19", expected: false, note: "Sun" },
    { key: "2025-01-09", expected: false, note: "Carter national day of mourning" },
    // fixed-date holidays
    { key: "2024-01-01", expected: false, note: "New Year's Day Mon" },
    { key: "2025-01-01", expected: false, note: "New Year's Day Wed" },
    { key: "2026-01-01", expected: false, note: "New Year's Day Thu" },
    { key: "2027-01-01", expected: false, note: "New Year's Day Fri" },
    { key: "2027-12-31", expected: false, note: "New Year's observed (Sat Jan 1)" },
    { key: "2024-07-04", expected: false, note: "Independence Day Thu" },
    { key: "2026-07-04", expected: false, note: "Independence Day Sat" },
    { key: "2026-07-03", expected: false, note: "Independence Day observed Fri" },
    { key: "2027-07-04", expected: false, note: "Independence Day Sun" },
    { key: "2027-07-05", expected: false, note: "Independence Day observed Mon" },
    { key: "2024-12-25", expected: false, note: "Christmas Wed" },
    { key: "2025-12-25", expected: false, note: "Christmas Thu" },
    { key: "2027-12-24", expected: false, note: "Christmas observed Fri" },
    { key: "2028-12-25", expected: false, note: "Christmas Mon" },
    // Good Friday
    { key: "2024-03-29", expected: false, note: "Good Friday 2024" },
    { key: "2025-04-18", expected: false, note: "Good Friday 2025" },
    { key: "2026-04-03", expected: false, note: "Good Friday 2026" },
    { key: "2027-03-26", expected: false, note: "Good Friday 2027" },
    { key: "2028-04-14", expected: false, note: "Good Friday 2028" },
    { key: "2029-03-30", expected: false, note: "Good Friday 2029" },
    { key: "2030-04-19", expected: false, note: "Good Friday 2030" },
    // Monday holidays
    { key: "2024-01-15", expected: false, note: "MLK Day 2024" },
    { key: "2024-02-19", expected: false, note: "Presidents Day 2024" },
    { key: "2024-05-27", expected: false, note: "Memorial Day 2024" },
    { key: "2024-06-19", expected: false, note: "Juneteenth 2024" },
    { key: "2024-09-02", expected: false, note: "Labor Day 2024" },
    { key: "2026-06-19", expected: false, note: "Juneteenth Fri" },
    // Thanksgiving
    { key: "2024-11-28", expected: false, note: "Thanksgiving 2024" },
    { key: "2025-11-27", expected: false, note: "Thanksgiving 2025" },
    { key: "2026-11-26", expected: false, note: "Thanksgiving 2026" },
    { key: "2027-11-25", expected: false, note: "Thanksgiving 2027" },
    { key: "2028-11-23", expected: false, note: "Thanksgiving 2028" },
    { key: "2029-11-22", expected: false, note: "Thanksgiving 2029" },
    { key: "2030-11-28", expected: false, note: "Thanksgiving 2030" },
  ];

  test.each(cases)("$key is $expected ($note)", ({ key, expected }) => {
    expect(isTradingDay(key)).toBe(expected);
  });
});

describe("getSessionClose", () => {
  const cases: { key: string; close: number; early: boolean; note: string }[] = [
    { key: "2024-07-03", close: 13 * 60, early: true, note: "day before July 4 Thu" },
    { key: "2025-07-03", close: 13 * 60, early: true, note: "day before July 4 Fri" },
    { key: "2028-07-03", close: 13 * 60, early: true, note: "day before July 4 Tue" },
    { key: "2022-07-01", close: 13 * 60, early: true, note: "Friday before July 4 Mon" },
    { key: "2026-07-02", close: 16 * 60, early: false, note: "Thursday before July 4 Sat" },
    { key: "2027-07-01", close: 16 * 60, early: false, note: "Friday before July 4 Sun weekend" },
    { key: "2024-11-29", close: 13 * 60, early: true, note: "Black Friday 2024" },
    { key: "2025-11-28", close: 13 * 60, early: true, note: "Black Friday 2025" },
    { key: "2026-11-27", close: 13 * 60, early: true, note: "Black Friday 2026" },
    { key: "2024-12-24", close: 13 * 60, early: true, note: "Christmas Eve Tue" },
    { key: "2025-12-24", close: 13 * 60, early: true, note: "Christmas Eve Wed" },
    { key: "2027-12-23", close: 16 * 60, early: false, note: "Friday before Christmas Sun" },
    { key: "2027-12-24", close: 16 * 60, early: false, note: "Christmas observed Sat" },
    { key: "2028-12-24", close: 16 * 60, early: false, note: "Christmas Eve Sun" },
    { key: "2024-07-02", close: 16 * 60, early: false, note: "regular day" },
  ];

  test.each(cases)("$key closes at $close ($note)", ({ key, close, early }) => {
    expect(getSessionClose(key)).toEqual({ closeMinutes: close, early });
  });
});

describe("market status functions", () => {
  test("regular trading day hours", () => {
    const ts = et("2024-01-02", 10, 0); // 10:00 ET
    expect(isMarketOpen(ts)).toBe(true);
    expect(getMarketStatus(ts)).toEqual({ status: "open", untilStr: "closes in 6h 0m" });
  });

  test("pre-market", () => {
    const ts = et("2024-01-02", 8, 0);
    expect(isMarketOpen(ts)).toBe(false);
    expect(getMarketStatus(ts)).toEqual({ status: "pre_market", untilStr: "opens in 1h 30m" });
  });

  test("after hours", () => {
    const ts = et("2024-01-02", 17, 30);
    expect(isMarketOpen(ts)).toBe(false);
    expect(getMarketStatus(ts)).toEqual({ status: "after_hours", untilStr: "After hours" });
  });

  test("closed overnight", () => {
    const ts = et("2024-01-02", 2, 0);
    expect(isMarketOpen(ts)).toBe(false);
    expect(getMarketStatus(ts)).toEqual({ status: "closed", untilStr: "Market closed" });
  });

  test("weekend never reports open", () => {
    const ts = et("2026-07-18", 10, 0); // Saturday
    expect(isMarketOpen(ts)).toBe(false);
    expect(getMarketStatus(ts)).toEqual({ status: "closed", untilStr: "Weekend / holiday" });
  });

  test("holiday never reports open", () => {
    const ts = et("2024-07-04", 10, 0); // Independence Day
    expect(isMarketOpen(ts)).toBe(false);
    expect(getMarketStatus(ts)).toEqual({ status: "closed", untilStr: "Weekend / holiday" });
  });

  test("early close before 1 PM is open", () => {
    const ts = et("2024-11-29", 12, 30); // Black Friday 12:30 ET
    expect(isMarketOpen(ts)).toBe(true);
    expect(getMarketStatus(ts)).toEqual({ status: "open", untilStr: "closes in 0h 30m" });
  });

  test("early close after 1 PM is after hours", () => {
    const ts = et("2024-11-29", 14, 0); // Black Friday 2:00 ET
    expect(isMarketOpen(ts)).toBe(false);
    expect(getMarketStatus(ts)).toEqual({ status: "after_hours", untilStr: "After hours (early close)" });
  });
});

describe("DST boundaries", () => {
  test("spring-forward day is interpreted in ET", () => {
    // 2026-03-08 is Sunday; check Monday 09:30 ET = 13:30 UTC (EDT).
    expect(isMarketOpen(new Date("2026-03-09T13:30:00.000Z").getTime())).toBe(true);
    // Friday before, 09:30 ET = 14:30 UTC (EST).
    expect(isMarketOpen(new Date("2026-03-06T14:30:00.000Z").getTime())).toBe(true);
  });

  test("fall-back day is interpreted in ET", () => {
    // 2026-11-01 is Sunday; check Monday 09:30 ET = 14:30 UTC (EST).
    expect(isMarketOpen(new Date("2026-11-02T14:30:00.000Z").getTime())).toBe(true);
    // Friday before, 09:30 ET = 13:30 UTC (EDT).
    expect(isMarketOpen(new Date("2026-10-30T13:30:00.000Z").getTime())).toBe(true);
  });

  test("spring-forward day Good Friday is not a trading day", () => {
    // Good Friday 2024 is 2024-03-29 (before spring-forward on 2024-03-10)
    // Use ET timestamps: good Friday should be closed.
    expect(isTradingDay("2024-03-29")).toBe(false);
    expect(isMarketOpen(et("2024-03-29", 10, 0))).toBe(false);
  });

  test("fall-back day Good Friday is not a trading day", () => {
    // Good Friday 2025 is 2025-04-18 (before fall-back on 2025-11-02)
    expect(isTradingDay("2025-04-18")).toBe(false);
    expect(isMarketOpen(et("2025-04-18", 10, 0))).toBe(false);
  });

  test("Christmas Eve on DST transition day", () => {
    // 2024-12-24 is before fall-back; verify it's an early close
    const close = getSessionClose("2024-12-24");
    expect(close.early).toBe(true);
    expect(close.closeMinutes).toBe(13 * 60);
  });
});

describe("getPreviousTradingDay", () => {
  const cases: { key: string; expected: string; note: string }[] = [
    { key: "2026-07-17", expected: "2026-07-16", note: "Fri <- Thu" },
    { key: "2026-07-20", expected: "2026-07-17", note: "Mon <- Fri" },
    { key: "2026-07-06", expected: "2026-07-02", note: "post-July4-observed" },
    { key: "2024-07-08", expected: "2024-07-05", note: "post-July4 Thu" },
    { key: "2025-01-02", expected: "2024-12-31", note: "post-New Year's" },
    { key: "2028-01-03", expected: "2027-12-30", note: "post-New Year's observed" },
  ];

  test.each(cases)("$key -> $expected ($note)", ({ key, expected }) => {
    expect(getPreviousTradingDay(key)).toBe(expected);
  });
});

describe("observed holidays (Saturday/Sunday shift), 2024-2030", () => {
  // New Year's Day: Jan 1, or observed Dec 31 Fri if Jan 1 is Sat
  const newYearCases: { key: string; trading: boolean; note: string }[] = [
    { key: "2024-01-01", trading: false, note: "Jan 1 Mon" },
    { key: "2025-01-01", trading: false, note: "Jan 1 Wed" },
    { key: "2026-01-01", trading: false, note: "Jan 1 Thu" },
    { key: "2027-01-01", trading: false, note: "Jan 1 Fri" },
    { key: "2027-12-31", trading: false, note: "observed Fri (Jan 1 Sat)" },
    { key: "2028-01-03", trading: true, note: "observed Mon (Jan 1 Sun), Jan 3 is trading" },
    { key: "2029-01-01", trading: false, note: "Jan 1 Mon" },
  ];
  test.each(newYearCases)("New Year: $key trading=$trading ($note)", ({ key, trading }) => {
    expect(isTradingDay(key)).toBe(trading);
  });

  // Juneteenth: Jun 19, observed Fri if Sat, observed Mon if Sun
  const juneteenthCases: { key: string; trading: boolean; note: string }[] = [
    { key: "2024-06-19", trading: false, note: "Jun 19 Wed" },
    { key: "2025-06-19", trading: false, note: "Jun 19 Thu" },
    { key: "2026-06-19", trading: false, note: "Jun 19 Fri" },
    { key: "2027-06-18", trading: false, note: "observed Fri (Jun 19 Sat)" },
    { key: "2028-06-19", trading: false, note: "Jun 19 Mon" },
    { key: "2029-06-19", trading: false, note: "Jun 19 Wed" },
    { key: "2030-06-19", trading: false, note: "Jun 19 Thu" },
  ];
  test.each(juneteenthCases)("Juneteenth: $key trading=$trading ($note)", ({ key, trading }) => {
    expect(isTradingDay(key)).toBe(trading);
  });

  // Independence Day: Jul 4, observed Fri if Sat, observed Mon if Sun
  const july4Cases: { key: string; trading: boolean; note: string }[] = [
    { key: "2024-07-04", trading: false, note: "Jul 4 Thu" },
    { key: "2025-07-04", trading: false, note: "Jul 4 Fri" },
    { key: "2026-07-03", trading: false, note: "observed Fri (Jul 4 Sat)" },
    { key: "2027-07-05", trading: false, note: "observed Mon (Jul 4 Sun)" },
    { key: "2028-07-04", trading: false, note: "Jul 4 Tue" },
    { key: "2029-07-04", trading: false, note: "Jul 4 Wed" },
  ];
  test.each(july4Cases)("Independence Day: $key trading=$trading ($note)", ({ key, trading }) => {
    expect(isTradingDay(key)).toBe(trading);
  });

  // Christmas: Dec 25, observed Fri if Sat, observed Mon if Sun
  const christmasCases: { key: string; trading: boolean; note: string }[] = [
    { key: "2024-12-25", trading: false, note: "Dec 25 Wed" },
    { key: "2025-12-25", trading: false, note: "Dec 25 Thu" },
    { key: "2026-12-25", trading: false, note: "Dec 25 Fri" },
    { key: "2027-12-24", trading: false, note: "observed Fri (Dec 25 Sat)" },
    { key: "2028-12-25", trading: false, note: "Dec 25 Mon" },
    { key: "2029-12-25", trading: false, note: "Dec 25 Tue" },
    { key: "2030-12-25", trading: false, note: "Dec 25 Wed" },
  ];
  test.each(christmasCases)("Christmas: $key trading=$trading ($note)", ({ key, trading }) => {
    expect(isTradingDay(key)).toBe(trading);
  });
});

describe("early closes: Black Friday, Christmas Eve, July 3", () => {
  const blackFridayCases: { key: string; early: boolean; note: string }[] = [
    { key: "2024-11-29", early: true, note: "day after Thu Thanksgiving 2024" },
    { key: "2025-11-28", early: true, note: "day after Thu Thanksgiving 2025" },
    { key: "2026-11-27", early: true, note: "day after Thu Thanksgiving 2026" },
    { key: "2027-11-26", early: true, note: "day after Thu Thanksgiving 2027" },
    { key: "2028-11-24", early: true, note: "day after Thu Thanksgiving 2028" },
    { key: "2029-11-23", early: true, note: "day after Thu Thanksgiving 2029" },
    { key: "2030-11-29", early: true, note: "day after Thu Thanksgiving 2030" },
  ];
  test.each(blackFridayCases)("Black Friday: $key early=$early ($note)", ({ key, early }) => {
    expect(getSessionClose(key).early).toBe(early);
  });

  const christmasEveCases: { key: string; early: boolean; note: string }[] = [
    { key: "2024-12-24", early: true, note: "Dec 24 Tue (Dec 25 Wed trading day)" },
    { key: "2025-12-24", early: true, note: "Dec 24 Wed (Dec 25 Thu trading day)" },
    { key: "2026-12-24", early: true, note: "Dec 24 Thu (Dec 25 Fri trading day)" },
    { key: "2027-12-23", early: false, note: "Dec 23 Thu (Dec 24 Fri = observed, Dec 25 Sat)" },
    { key: "2027-12-24", early: false, note: "Dec 24 Fri (observed Christmas, not trading)" },
    { key: "2028-12-24", early: false, note: "Dec 24 Sun (not trading)" },
    { key: "2029-12-24", early: true, note: "Dec 24 Mon (Dec 25 Tue trading day)" },
    { key: "2030-12-24", early: true, note: "Dec 24 Tue (Dec 25 Wed trading day)" },
  ];
  test.each(christmasEveCases)("Christmas Eve: $key early=$early ($note)", ({ key, early }) => {
    expect(getSessionClose(key).early).toBe(early);
  });

  const july3Cases: { key: string; early: boolean; note: string }[] = [
    { key: "2022-07-01", early: true, note: "Fri before Mon Jul 4" },
    { key: "2023-07-03", early: true, note: "Mon before Tue Jul 4" },
    { key: "2024-07-03", early: true, note: "Wed before Thu Jul 4" },
    { key: "2025-07-03", early: true, note: "Thu before Fri Jul 4" },
    { key: "2026-07-02", early: false, note: "Thu before Sat Jul 4 (observed Fri Jul 3)" },
    { key: "2026-07-03", early: false, note: "Fri (not trading, observed)" },
    { key: "2027-07-01", early: false, note: "Thu before Sun Jul 4 (no early close Fri)" },
    { key: "2028-07-03", early: true, note: "Mon before Tue Jul 4" },
  ];
  test.each(july3Cases)("July 3 early: $key early=$early ($note)", ({ key, early }) => {
    expect(getSessionClose(key).early).toBe(early);
  });
});

describe("early close times are always 1:00 PM ET (780 min)", () => {
  const earlyCloseDates = [
    "2024-11-29", // Black Friday
    "2024-12-24", // Christmas Eve
    "2024-07-03", // July 3
    "2025-11-28",
    "2025-12-24",
    "2025-07-03",
  ];
  test.each(earlyCloseDates)("$key closes at 1:00 PM", (key) => {
    expect(getSessionClose(key)).toEqual({ closeMinutes: 13 * 60, early: true });
  });
});
