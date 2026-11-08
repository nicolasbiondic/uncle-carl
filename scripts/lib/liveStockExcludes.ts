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

/** E1 cores that were live when a committed copySignal manifest was pre-registered and have since been
 *  replaced. Review of 2026-11-08 (RW11, SPY/QQQ/SMH/GLD → SSO/QLD/USD/UGL): a pre-registered manifest is
 *  never edited after its run (its identity hash is its artifact's), so `copy-d4-insider-clusters-v1`
 *  (refuted, artifact a910d39a…) keeps the core it excluded at the time. The four 2x ETFs are not S&P 500
 *  members, the only domain copySignal draws from, so the exclusion would change nothing in its replay.
 *  A candidate written since RW11 must exclude the CURRENT core; the live path does not depend on this
 *  rule at all (copySignal cannot run live, and cutover.ts checks the shared-wallet overlap itself). */
export const RETIRED_MOMENTUM_STOCKS_CORES: readonly (readonly string[])[] = [
  ["SPY", "QQQ", "IWM", "GLD", "AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN", "SMH"],
];

/** The live symbols a candidate's `exclude` fails to list (empty = compliant). A candidate that excludes a
 *  RETIRED E1 core in full is held to that core (see above); everyone else to the current one. */
export function missingLiveExcludes(exclude: readonly string[]): string[] {
  const have = new Set(exclude);
  const grandfathered = RETIRED_MOMENTUM_STOCKS_CORES.some(core => core.every(s => have.has(s)));
  const required = grandfathered ? [...new Set([...MEANREV_UNIVERSE, ...TREASURY_SYMBOLS])].sort() : LIVE_STOCK_EXCLUDES;
  return required.filter(s => !have.has(s));
}
