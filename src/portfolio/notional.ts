/** USD notional, never contracts × coin price. The sole registered inverse
 * product is BTCUSD_PERP ($100/contract); unknown inverse products fail closed.
 * A caller with exchange metadata may supply its actual contract size. */
export function notionalUsd(broker: string, symbol: string, quantity: number, price: number, contractSize?: number): number | null {
  if (!Number.isFinite(quantity)) return null;
  const unit = broker === "binance_coinm" ? contractSize ?? (symbol === "BTC/USD" ? 100 : NaN) : price;
  return Number.isFinite(unit) && unit > 0 ? Math.abs(quantity) * unit : null;
}
