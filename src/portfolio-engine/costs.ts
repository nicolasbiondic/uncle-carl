import type { CostModel, OrderIntent } from "./types";

export function fillCost(side: OrderIntent["side"], qty: number, referencePrice: number, model: CostModel): {
  price: number; notional: number; commission: number; slippage: number; cashDelta: number;
} {
  const price = referencePrice * (1 + (side === "buy" ? 1 : -1) * model.slippageBps / 10_000);
  const notional = qty * price;
  const commission = notional * model.commissionBps / 10_000;
  return { price, notional, commission, slippage: qty * Math.abs(price - referencePrice),
    cashDelta: (side === "buy" ? -notional : notional) - commission };
}

/** ACT/365: pass elapsed calendar days (weekends accrue too), not trading sessions. */
export function dailyMarginInterest(borrowedCash: number, model: CostModel, days = 1): number {
  return Math.max(0, borrowedCash) * model.marginInterestAnnual * days / 365;
}

/** Positive = paid by the long, negative = received. Pass the SUM of the day's
 * real funding rates, not an annualized rate or an assumed fixed daily rate. */
export function dailyFunding(perpNotional: number, dailyRate: number, model: CostModel): number {
  return model.funding === "real" ? perpNotional * dailyRate : 0;
}
