// Shadow universe (línea D): ~20 symbols — 10 stocks/ETF + 10 crypto — all
// drawn DETERMINISTICALLY from the live universes (riskProfiles.ts /
// quoteAsset.ts are pure config modules, no engine import happens here):
//   - stocks: the first 10 of the momentum_stocks core AS IT WAS before RW11
//     (SPY QQQ IWM GLD AAPL MSFT NVDA META GOOGL AMZN; SMH, the most recent
//     addition then, dropped). Frozen on 2026-11-08: RW11 swapped SPY/QQQ/SMH/GLD
//     for the 2x ETFs SSO/QLD/USD/UGL in the LIVE core (riskProfiles.ts), but the
//     shadow quorum is a forward archive of AI views on cash instruments and must
//     stay comparable day to day; its bars (SPY/QQQ/GLD are D1 ETFs, the rest
//     S&P 500 members) remain in the nightly refresh. Not a trading input.
//   - crypto: the 8 of MOMENTUM_CRYPTO_UNIVERSE plus the first two USDC-sleeve
//     bases not already covered (BCH, BNB), as "BASE/USD" because that is the
//     notation historical.db stores daily crypto bars under.
// Funding comes from funding_rates, keyed by the Binance native "BASEUSDT".

import { MOMENTUM_CRYPTO_UNIVERSE } from "../config/riskProfiles";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import type { AssetClass } from "./types";

export const QUORUM_STOCKS: string[] = ["SPY", "QQQ", "IWM", "GLD", "AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN"];

function extraCryptoFromUsdcSleeve(count: number): string[] {
  const covered = new Set(MOMENTUM_CRYPTO_UNIVERSE.map((s) => s.split("/")[0]));
  const out: string[] = [];
  for (const key of Object.keys(USDC_SYMBOL_MAP)) {
    const base = key.split("/")[0];
    if (!covered.has(base)) { out.push(`${base}/USD`); covered.add(base); }
    if (out.length === count) break;
  }
  return out;
}

export const QUORUM_CRYPTO: string[] = [...MOMENTUM_CRYPTO_UNIVERSE, ...extraCryptoFromUsdcSleeve(2)];

export function universeFor(assetClass: AssetClass): string[] {
  return assetClass === "stocks" ? QUORUM_STOCKS : QUORUM_CRYPTO;
}

/** historical.db funding_rates key for an internal "BASE/USD" crypto symbol. */
export function fundingSymbolFor(internal: string): string {
  return `${internal.split("/")[0]}USDT`;
}
