// AI review, stage C: the 1x inverse fund of a stock, the instrument a `short` vote is bet with
// (docs/reports/IA-revision-de-noticias-2026-11-14.md, amendment 2026-11-14, point 3). Pure data, and the fund's price estimate.
// The ten funds the paper broker lists (read from it on 2026-11-14: 1x daily inverse, tradable). `fractionable` is the
// BROKER's flag: the other seven trade in WHOLE shares only, so the venue's quantity step for them is 1.
// Enforced: src/ai-review/inverse.test.ts, src/config/riskProfiles.disjoint.test.ts (no fund is in any sleeve's universe,
// a hedge, a signal or a treasury symbol; no fund appears twice).

export interface InverseFund {
  /** The stock the fund moves against. */
  underlying: string;
  /** The fund's own ticker. */
  symbol: string;
  /** The broker lets the paper account buy fractions of it (false: whole shares only). */
  fractionable: boolean;
}

export const INVERSE_FUNDS: readonly InverseFund[] = Object.freeze([
  { underlying: "NVDA", symbol: "NVDD", fractionable: true },
  { underlying: "AAPL", symbol: "AAPD", fractionable: true },
  { underlying: "MSFT", symbol: "MSFD", fractionable: true },
  { underlying: "META", symbol: "METD", fractionable: false },
  { underlying: "GOOGL", symbol: "GGLS", fractionable: false },
  { underlying: "AMZN", symbol: "AMZD", fractionable: false },
  { underlying: "AVGO", symbol: "AVS", fractionable: false },
  { underlying: "NFLX", symbol: "NFXS", fractionable: false },
  { underlying: "ORCL", symbol: "ORCS", fractionable: false },
  { underlying: "QCOM", symbol: "QCMD", fractionable: false },
].map(f => Object.freeze(f)));

export const INVERSE_SYMBOLS: readonly string[] = Object.freeze(INVERSE_FUNDS.map(f => f.symbol));

/** The funds that trade in whole shares only (the venue's quantity step is 1). */
export const WHOLE_SHARE_FUNDS: readonly string[] = Object.freeze(INVERSE_FUNDS.filter(f => !f.fractionable).map(f => f.symbol));

const BY_UNDERLYING = new Map(INVERSE_FUNDS.map(f => [f.underlying, f]));
const BY_SYMBOL = new Map(INVERSE_FUNDS.map(f => [f.symbol, f]));

/** The fund that bets against `underlying`, or null (a stock without a fund is only taken out). */
export const inverseOf = (underlying: string): InverseFund | null => BY_UNDERLYING.get(underlying) ?? null;

/** The fund whose ticker is `symbol`, or null (the lookup the other way). */
export const fundOf = (symbol: string): InverseFund | null => BY_SYMBOL.get(symbol) ?? null;

export const isInverseSymbol = (symbol: string): boolean => BY_SYMBOL.has(symbol);
export const isWholeShareFund = (symbol: string): boolean => BY_SYMBOL.get(symbol)?.fractionable === false;

/** A stock that "moved" more than this since its last close did not move: it split, or one of the two prices is wrong. No estimate then. */
export const ESTIMATE_MAX_MOVE = 0.25;

/** Today's price of a 1x daily inverse fund, from data that is reliable at the pass: the fund's last close moved AGAINST the move of its
 *  stock since the stock's last close (stock −5 % → fund +5 %). Why an estimate: the bot's live feed sees a small part of the market's
 *  trades and almost none of these funds' (read from the broker on 2026-11-14: six of the ten had no trade on it in a session's first six
 *  minutes, and one's last trade there was two days old), while their daily bars (the whole market) and the stocks' live prices are sound.
 *  null when any input is missing or the stock's move is not believable. Pure. */
export function inverseFundEstimate(fundClose: number | null | undefined, stockClose: number | null | undefined, stockNow: number | null | undefined): number | null {
  if (!(Number(fundClose) > 0) || !(Number(stockClose) > 0) || !(Number(stockNow) > 0)) return null;
  const move = Number(stockNow) / Number(stockClose) - 1;
  if (!Number.isFinite(move) || Math.abs(move) > ESTIMATE_MAX_MOVE) return null;
  const estimate = Number(fundClose) * (1 - move);
  return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
}
