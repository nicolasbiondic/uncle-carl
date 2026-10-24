import { expect, test } from "bun:test";
import { combinedBookDrawdown, RW5_CRYPTO_CRASH_WINDOWS } from "./rw5-crypto-evaluate";

test("combined book: a sleeve without a return on a date contributes 0, and the overlap of the series bounds the dates", () => {
  const stocks = new Map([["2024-01-05", 0.01], ["2024-01-08", -0.02]]); // Friday, Monday
  const crypto = new Map([["2024-01-04", 0.5], ["2024-01-05", 0], ["2024-01-06", -0.5], ["2024-01-07", 0], ["2024-01-08", 0.1]]);
  const r = combinedBookDrawdown([stocks, crypto], [100, 100]);
  expect([r.from, r.to, r.days]).toEqual(["2024-01-05", "2024-01-08", 4]);
  // Friday 101 + 100 = 201 (peak); Saturday 101 + 50 = 151; Monday 98.98 + 55.
  expect(r.maxDrawdown).toBeCloseTo(50 / 201, 12);
  expect(r.totalReturn).toBeCloseTo((98.98 + 55) / 200 - 1, 12);
});

test("the §16.6 crash windows are the pre-registered ones, in order and disjoint", () => {
  expect(RW5_CRYPTO_CRASH_WINDOWS.map(w => `${w.from}/${w.to}`)).toEqual([
    "2022-11-01/2023-01-31", "2024-03-13/2024-09-30", "2025-01-21/2025-05-31", "2025-10-06/2026-08-31",
  ]);
  for (let i = 1; i < RW5_CRYPTO_CRASH_WINDOWS.length; i++) {
    expect(RW5_CRYPTO_CRASH_WINDOWS[i].from > RW5_CRYPTO_CRASH_WINDOWS[i - 1].to).toBe(true);
  }
});
