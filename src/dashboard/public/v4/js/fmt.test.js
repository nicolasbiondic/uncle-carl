import { describe, expect, test } from "bun:test";
import { money, moneySigned, moneyCompact, moneySignedCompact, pctSigned, quantity } from "./fmt.js";

describe("compact table money", () => {
  test.each([
    [540.24, "$540"], [525.49, "$525"], [3019.4, "$3,019"],
    [100, "$100"], [-100.5, "$101"], [99.9, "$100"],
    [85.4, "$85"], [10, "$10"], [8.99, "$9"], [0.0777, "<$1"],
    [0.00001234, "<$1"], [0, "$0"],
  ])("%s → %s", (value, expected) => {
    expect(moneyCompact(value)).toBe(expected);
  });

  test("signed P&L uses the same precision and a Unicode minus", () => {
    expect(moneySignedCompact(-1794.42)).toBe("−$1,794");
    expect(moneySignedCompact(-85.04)).toBe("−$85");
    expect(moneySignedCompact(-12.6)).toBe("−$13");
    expect(moneySignedCompact(8.99)).toBe("+$9");
    expect(moneySignedCompact(-0.0777)).toBe("−<$1");
    expect(moneySignedCompact(0)).toBe("+$0");
  });

  test("numeric strings work; invalid inputs stay finite", () => {
    expect(moneyCompact("3019.4")).toBe("$3,019");
    for (const value of [null, undefined, NaN, Infinity, "invalid"]) {
      expect(moneyCompact(value)).toBe("$0");
    }
  });

  test("fixed-precision money elsewhere and one-decimal percentages are unchanged", () => {
    expect(money(540.24)).toBe("$540.24");
    expect(pctSigned(-0.3)).toBe("−0.3%");
  });
});

describe("table quantity", () => {
  test.each([
    [0, "0"], [1, "1"], [8, "8"], [10, "10"], [1234, "1,234"],
    [10.4, "10"], [12.7, "13"], [1.24, "1"], [9.84, "10"],
    [0.0123, "0.0123"], [0.00001234, "0.0000123"], [0.9876, "0.988"],
    [-12.7, "-13"], [-1.24, "-1"], [-0.0123, "-0.0123"], ["12.7", "13"],
  ])("%s → %s", (value, expected) => {
    expect(quantity(value)).toBe(expected);
  });

  test("missing or invalid quantity is unknown, not zero", () => {
    for (const value of [null, undefined, "", "invalid", NaN, Infinity]) {
      expect(quantity(value)).toBe("—");
    }
  });
});

import { pnlWhole } from "./fmt.js";
test("table P&L is whole dollars", () => {
  expect(pnlWhole(-85.48)).toBe("−$85");
  expect(pnlWhole(38.69)).toBe("+$39");
  expect(pnlWhole(-1794.33)).toBe("−$1,794");
  expect(pnlWhole(-340.5)).toBe(moneySigned(-340.5, 0));
  expect(pnlWhole(-0.2)).toBe("−$0");
});

import { etTime, etDate, etDateTime, etStamp, etDayKey } from "./fmt.js";
describe("ET time formatters", () => {
  test("a missing time is a dash, never the current time", () => {
    for (const v of [null, undefined, "", 0, NaN, "x"]) {
      expect(etTime(v)).toBe("—");
      expect(etDate(v)).toBe("—");
      expect(etDateTime(v)).toBe("—");
      expect(etStamp(v)).toBe("—");
      expect(etDayKey(v)).toBe("");
    }
  });
  test("a real time is New York time, and etStamp names the zone", () => {
    const ms = Date.UTC(2026, 10, 6, 15, 5); // 10:05 AM EST
    expect(etTime(ms)).toBe("10:05 AM");
    expect(etDateTime(ms)).toBe("Nov 6, 10:05 AM");
    expect(etStamp(ms)).toBe("Nov 6, 10:05 AM ET");
    expect(etDayKey(Date.UTC(2026, 10, 7, 3, 0))).toBe("2026-11-06"); // 10 PM ET on the 6th
  });
});
