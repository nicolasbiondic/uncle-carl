import { expect, test } from "bun:test";
import { dailyFunding, dailyMarginInterest, fillCost } from "./costs";
import type { CostModel } from "./types";

const model: CostModel = { slippageBps: 5, commissionBps: 4, marginInterestAnnual: 0.065, funding: "real" };
test("adverse slippage per side and commission on executed notional", () => {
  const buy = fillCost("buy", 2, 100, model), sell = fillCost("sell", 2, 100, model);
  expect(buy.price).toBeCloseTo(100.05);
  expect(sell.price).toBeCloseTo(99.95);
  expect(buy.commission).toBeCloseTo(200.1 * 0.0004);
  expect(sell.commission).toBeCloseTo(199.9 * 0.0004);
  expect(buy.cashDelta).toBeCloseTo(-200.1 - buy.commission);
  expect(sell.cashDelta).toBeCloseTo(199.9 - sell.commission);
  expect(buy.slippage).toBeCloseTo(0.1);
});
test("interest charges only borrowed cash, ACT/365 including elapsed weekends", () => {
  expect(dailyMarginInterest(1000, model)).toBeCloseTo(65 / 365);
  expect(dailyMarginInterest(1000, model, 3)).toBeCloseTo(195 / 365);
  expect(dailyMarginInterest(-1000, model)).toBe(0);
});
test("actual summed daily funding may be a debit or a credit", () => {
  expect(dailyFunding(1000, 0.0003, model)).toBeCloseTo(0.3);
  expect(dailyFunding(1000, -0.0003, model)).toBeCloseTo(-0.3);
  expect(dailyFunding(1000, 0.0003, { ...model, funding: "none" })).toBe(0);
});
