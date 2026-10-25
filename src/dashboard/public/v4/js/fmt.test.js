import { describe, expect, test } from "bun:test";
import { money, moneyCompact, moneySignedCompact, pctSigned, quantity } from "./fmt.js";

describe("compact table money", () => {
  test.each([
    [540.24, "$540"], [525.49, "$525"], [3019.4, "$3,019"],
    [100, "$100"], [-100.5, "$101"], [99.9, "$99.9"],
    [85, "$85"], [8.99, "$8.99"], [0.0777, "$0.0777"],
    [0.00001234, "$0.0000123"], [0, "$0"],
  ])("%s → %s", (value, expected) => {
    expect(moneyCompact(value)).toBe(expected);
  });

  test("signed P&L uses the same precision and a Unicode minus", () => {
    expect(moneySignedCompact(-1794.42)).toBe("−$1,794");
    expect(moneySignedCompact(-85.04)).toBe("−$85");
    expect(moneySignedCompact(8.99)).toBe("+$8.99");
    expect(moneySignedCompact(-0.0777)).toBe("−$0.0777");
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
});
