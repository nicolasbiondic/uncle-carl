// ══════════════════════════════════════════════════════════════
// Treasury ETF symbol registry — the ONE list every exclusion reads.
//
// A treasury sweep symbol (BOXX/SGOV/BIL) lives on the shared Alpaca account but
// belongs to NO sleeve: it must never be adopted as an orphan (AccountManager
// adopts only sleeve-universe symbols; BrokerSync's *_main adoption skips
// this list explicitly), never counted as quantity drift (BrokerSync's
// detectQuantityDrift skips it — the treasury keeps no trades row by
// design: broker truth IS its ledger), and never given a protective stop
// (runAlpacaNativeStopsPass skips it defensively). Locked by
// src/treasury/TreasurySweep.test.ts, including the universe-disjunction
// test (a treasury symbol in a sleeve universe would reintroduce the
// phantom-close class — AGENTS.md "Shared Alpaca wallet").
//
// This module is deliberately dependency-free (imported by BrokerSync and
// AccountManager — no cycles).
// ══════════════════════════════════════════════════════════════

/** Symbols recognized as treasury sweep vehicles. The active one is chosen
 *  by ALPACA_TREASURY_SWEEP (src/index.ts, owner-flipped); ALL of them stay
 *  excluded from adoption/drift/stops even while the sweep is OFF, so a
 *  leftover position after the owner disables the sweep is never mistaken
 *  for an orphan. */
// BOXX first (2026-09-28): Alpaca PAPER does not simulate dividends
// (docs.alpaca.markets/us/docs/paper-trading), and SGOV/BIL pay their yield
// as monthly distributions — their raw price is flat (SGOV 2024-09→2026-09:
// +0.3% total), so in paper they would earn ~0. BOXX (box-spread ETF) accrues
// in NAV with no distributions: +9.0% raw over the same two years (4.3%/yr),
// so it is the only vehicle whose carry is visible in this account. SGOV/BIL
// stay recognized (excluded from adoption/drift/stops) for a real account.
export const TREASURY_SYMBOLS: ReadonlySet<string> = new Set(["BOXX", "SGOV", "BIL"]);

export function isTreasurySymbol(symbol: string): boolean {
  return TREASURY_SYMBOLS.has(symbol);
}
