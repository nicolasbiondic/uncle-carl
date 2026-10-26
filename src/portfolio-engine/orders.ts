import type { PlanOrders } from "./types";
import { compareSymbols } from "./signals";

/** Floor the DELTA on both sides: rounding must never cross the target or
 * create a short. Off-step residual dust remains for the caller to report. */
export function roundQtyDown(qty: number, step: number): number {
  if (!(qty > 0) || !Number.isFinite(qty)) return 0;
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  // Try the adjacent upper lattice point first: 0.3 / 0.1 is slightly
  // below 3 in binary. Accept it only when the decimal quantity fits.
  let units = Math.ceil(qty / step);
  let rounded = Number((units * step).toPrecision(15));
  if (rounded > qty) rounded = Number((--units * step).toPrecision(15));
  return Math.max(0, rounded);
}

export const planOrders: PlanOrders = (target, book, prices, rules) => {
  if (!(book.equity > 0) || !Number.isFinite(book.equity)) return [];
  const current: Record<string, number> = {};
  for (const p of book.positions) {
    if (!Number.isFinite(p.qty) || p.qty < 0) throw new Error(`Long-only book required: ${p.symbol}`);
    current[p.symbol] = (current[p.symbol] ?? 0) + p.qty;
  }
  const orders: ReturnType<PlanOrders> = [];
  for (const symbol of [...new Set([...Object.keys(target.weights), ...Object.keys(current)])].sort(compareSymbols)) {
    const price = prices[symbol];
    if (!(price > 0) || !Number.isFinite(price)) continue;
    const weight = target.weights[symbol] ?? 0;
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`Invalid long-only target: ${symbol}`);
    const held = current[symbol] ?? 0;
    const currentWeight = held * price / book.equity;
    const renew = held > 0 && target.maxHold?.includes(symbol);
    if (renew) {
      // A mandatory full lot exit ignores the delta band/minimum: neither may prolong its life.
      orders.push({ symbol, side: "sell", qty: held, notional: held * price, targetWeight: weight, currentWeight,
        reduceOnly: true, maxHold: "close" });
    }
    // Only strictly INSIDE the band skips; .22 - .20 rounds below .02.
    const epsilon = 8 * Number.EPSILON * Math.max(1, weight, currentWeight);
    if (!renew && Math.abs(weight - currentWeight) + epsilon < rules.rebalanceBand) continue;
    const delta = weight * book.equity / price - (renew ? 0 : held);
    const side = delta > 0 ? "buy" : "sell";
    const maxQty = side === "sell" ? Math.min(held, Math.abs(delta)) : delta;
    const step = rules.qtyStep?.[symbol] ?? (rules.fractional ? null : 1);
    const qty = step === null ? maxQty : roundQtyDown(maxQty, step);
    const notional = qty * price;
    if (!(qty > 0) || !Number.isFinite(notional) || notional < (rules.minNotional?.[symbol] ?? rules.minOrderNotional)) continue;
    orders.push({ symbol, side, qty, notional, targetWeight: weight, currentWeight, reduceOnly: side === "sell",
      ...(renew ? { maxHold: "rebuy" as const } : {}) });
  }
  return orders.sort((a, b) => (a.side === b.side ? compareSymbols(a.symbol, b.symbol) : a.side === "sell" ? -1 : 1));
};
