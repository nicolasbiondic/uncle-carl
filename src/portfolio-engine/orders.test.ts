import { expect, test } from "bun:test";
import { planOrders, roundQtyDown } from "./orders";
import type { BookState, TargetBook, VenueRules } from "./types";

const target = (weights: Record<string, number>): TargetBook => ({ asOf: "2020-01-01", weights, memory: {}, diagnostics: {}, stops: [] });
const book: BookState = { equity: 1000, positions: [{ symbol: "A", qty: 2, avgEntryPrice: 100 }], memory: {} };
const rules: VenueRules = { venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0 };

test("weights × equity / price minus held, sells first and reduceOnly", () => {
  const orders = planOrders(target({ A: 0.1, B: 0.2 }), book, { A: 100, B: 50 }, rules);
  expect(orders).toEqual([
    { symbol: "A", side: "sell", qty: 1, notional: 100, targetWeight: 0.1, currentWeight: 0.2, reduceOnly: true },
    { symbol: "B", side: "buy", qty: 4, notional: 200, targetWeight: 0.2, currentWeight: 0, reduceOnly: false },
  ]);
  expect(planOrders(target({}), book, { A: 100 }, rules)[0].qty).toBe(2);
});

test("absolute rebalance band and venue-specific minimum notional after rounding", () => {
  expect(planOrders(target({ A: 0.21 }), book, { A: 100 }, { ...rules, rebalanceBand: 0.02 })).toEqual([]);
  expect(planOrders(target({ B: 0.02 }), { ...book, positions: [] }, { B: 100 }, { ...rules, rebalanceBand: 0.02 })).toHaveLength(1);
  expect(planOrders(target({ B: 0.004 }), book, { B: 100 }, rules)).toEqual([]);
  expect(planOrders(target({ B: 0.005 }), book, { B: 100 }, rules)).toHaveLength(1);
  expect(planOrders(target({ B: 0.009 }), book, { B: 100 }, { ...rules, minNotional: { B: 10 } })).toEqual([]);
  expect(planOrders(target({ B: 0.009 }), book, { B: 100 }, { ...rules, qtyStep: { B: 0.05 }, minNotional: { B: 6 } })).toEqual([]);
  // 0.22 - 0.2 is represented slightly below 0.02: equality must still trade.
  expect(planOrders(target({ A: 0.22 }), book, { A: 100 }, { ...rules, rebalanceBand: 0.02 })).toHaveLength(1);
  expect(planOrders(target({ A: 0.219999 }), book, { A: 100 }, { ...rules, rebalanceBand: 0.02 })).toHaveLength(0);
});

test("step floors the delta, never overshoots target or becomes short", () => {
  expect(roundQtyDown(0.3, 0.1)).toBe(0.3);
  expect(roundQtyDown(0.29999999999999993, 0.1)).toBe(0.2);
  expect(roundQtyDown(1.99, 1)).toBe(1);
  expect(roundQtyDown(1, 0)).toBe(0);
  const b = { ...book, positions: [{ symbol: "A", qty: 2.07, avgEntryPrice: 100 }] };
  const sell = planOrders(target({ A: 0.024 }), b, { A: 100 }, { ...rules, qtyStep: { A: 0.1 } })[0];
  expect(sell.qty).toBe(1.8);
  expect(2.07 - sell.qty).toBeGreaterThanOrEqual(0.24);
  const flat = planOrders(target({}), b, { A: 100 }, { ...rules, fractional: false })[0];
  expect(flat.qty).toBe(2);
  const buy = planOrders(target({ B: 0.205 }), book, { B: 100 }, { ...rules, fractional: false })[0];
  expect(buy.qty).toBe(2);
});

test("property sweep: every executable delta stays between current and target", () => {
  for (let i = 1; i < 1000; i++) {
    const held = i / 137, wanted = (i % 37) / 7;
    const b = { ...book, positions: [{ symbol: "A", qty: held, avgEntryPrice: 1 }] };
    const orders = planOrders(target({ A: wanted / 1000 }), b, { A: 1 }, { ...rules, minOrderNotional: 0, qtyStep: { A: 0.03 } });
    if (!orders.length) continue;
    const o = orders[0], after = held + (o.side === "buy" ? o.qty : -o.qty);
    expect(after).toBeGreaterThanOrEqual(Math.min(held, wanted) - 1e-14);
    expect(after).toBeLessThanOrEqual(Math.max(held, wanted) + 1e-14);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(o.qty / 0.03).toBeCloseTo(Math.round(o.qty / 0.03), 10);
  }
});

test("missing/invalid price or insolvent equity skips; short targets/books rejected", () => {
  expect(planOrders(target({ B: 0.3 }), book, { A: NaN, B: 0 }, rules)).toEqual([]);
  expect(planOrders(target({ B: 0.3 }), { ...book, equity: 0 }, { B: 1 }, rules)).toEqual([]);
  expect(() => planOrders(target({ A: -1 }), book, { A: 1 }, rules)).toThrow("long-only");
  expect(() => planOrders(target({}), { ...book, positions: [{ symbol: "A", qty: -1, avgEntryPrice: 1 }] }, { A: 1 }, rules)).toThrow("Long-only");
});
