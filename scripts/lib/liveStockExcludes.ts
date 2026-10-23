// The stock symbols a copy-trading candidate may NEVER hold: the shared Alpaca wallet closes by AGGREGATE
// position (AGENTS.md, "Shared Alpaca wallet"), so a symbol owned by two sleeves produces a phantom open row
// when the other exits. Derived from the live sources, never retyped:
//   E1 / momentum_stocks : MOMENTUM_STOCKS_UNIVERSE (src/config/riskProfiles.ts)
//   E2 / meanrev_stocks  : MEANREV_UNIVERSE (src/strategies/meanrev/MeanRevEngine.ts)
//   treasury sweep       : TREASURY_SYMBOLS (BOXX SGOV BIL, src/treasury/treasurySymbols.ts)
// Every copySignal candidate must list all of them in `exclude` (validatePortfolioManifest enforces it); the
// test of this module pins the literal lists so a change to a live universe forces a review of the manifests.

import { MOMENTUM_STOCKS_UNIVERSE } from "../../src/config/riskProfiles";
import { MEANREV_UNIVERSE } from "../../src/strategies/meanrev/MeanRevEngine";
import { TREASURY_SYMBOLS } from "../../src/treasury/treasurySymbols";

export const LIVE_STOCK_EXCLUDES: readonly string[] = [...new Set([...MOMENTUM_STOCKS_UNIVERSE, ...MEANREV_UNIVERSE, ...TREASURY_SYMBOLS])].sort();

/** The live symbols a candidate's `exclude` fails to list (empty = compliant). */
export function missingLiveExcludes(exclude: readonly string[]): string[] {
  const have = new Set(exclude);
  return LIVE_STOCK_EXCLUDES.filter(s => !have.has(s));
}
