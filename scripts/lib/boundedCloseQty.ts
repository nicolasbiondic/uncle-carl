// Shared by close-all-positions.ts and close-crypto-now.ts (P1, 2026-07-29).
//
// The Binance Futures broker book may contain positions we have no DB row
// for (opened manually, or by some other unaccounted process): closing
// Math.abs(positionAmt) there would liquidate a position that isn't ours to
// manage. These scripts' real semantic is "flush what WE opened" (their DB
// reconcile step only ever touches OUR rows), so the broker leg must close
// min(Σ our open rows, broker qty) per symbol and SKIP symbols we hold no
// row for — the same bounding the Alpaca leg of close-all-positions.ts got
// on 2026-07-27.

export interface OpenTradeRowLike {
  symbol: string;
  market: string;
  quantity: number;
  account_id?: string | null;
}

/**
 * min(Σ our open crypto rows for `internalSymbol`, broker |positionAmt|).
 * Returns 0 when we hold no row (manual/unknown position — do not touch).
 * `shadow_*` rows are simulated fills with no broker position behind them —
 * counting them would inflate our share past what we actually hold.
 */
export function boundedCryptoCloseQty(
  openRows: OpenTradeRowLike[],
  internalSymbol: string,
  brokerAbsQty: number,
): number {
  const ours = openRows
    .filter(t =>
      t.market === "crypto" &&
      t.symbol === internalSymbol &&
      !(t.account_id ?? "").startsWith("shadow_"))
    .reduce((s, t) => s + t.quantity, 0);
  if (!(ours > 0) || !(brokerAbsQty > 0)) return 0;
  return Math.min(ours, brokerAbsQty);
}
