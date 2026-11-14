// AI review, stage C: which `short` verdicts of a decision become a BET (docs/reports/IA-revision-de-noticias-2026-11-14.md,
// amendment 2026-11-14, point 3). A bet exists only for an override whose action is `short` after the quorum (two short votes),
// in a strategy whose switch applies, with the bets switch on, for a stock that has an inverse fund, and it is one of the at most
// BET_MAX_COUNT bets of the WHOLE decision (both strategies together), the most confident first, then by symbol. Everything else
// `short` is an exit, as before. Pure and deterministic: the bot (src/ai-review/apply.ts) and the dev machine's message
// (src/ai-review/texts.ts) call this same function. Enforced: src/ai-review/bets.test.ts.

import type { Override, SleeveId } from "./contract";
import { inverseOf } from "./inverse";
import { BET_MAX_COUNT, rank } from "./limits";

export interface Bet {
  sleeve: SleeveId;
  /** The stock the bet is against (the override's symbol). */
  underlying: string;
  /** Its inverse fund: the instrument that is bought. */
  symbol: string;
  meanConfidence: number;
}

export interface BetsInput {
  /** Which strategies' switch applies (the bot's own view; a strategy that only informs places no bet). */
  applies: Readonly<Record<SleeveId, boolean>>;
  /** The bets switch (AI_REVIEW_BETS, with the kill switches of src/ai-review/apply.ts). */
  betsOn: boolean;
}

/** The at most 2 bets of the decision, in rank order. Never throws; an override outside this shape is simply not a bet. */
export function betsOf(decision: { overrides: readonly Override[] }, input: BetsInput): Bet[] {
  if (input.betsOn !== true) return [];
  const candidates: Bet[] = [];
  for (const o of [...decision.overrides].sort(rank)) {
    if (o.action !== "short" || input.applies?.[o.sleeve] !== true) continue;
    const fund = inverseOf(o.symbol);
    if (!fund) continue;
    // one bet per stock and per fund, whatever the file says (the strategies' universes are disjoint)
    if (candidates.some(c => c.underlying === o.symbol || c.symbol === fund.symbol)) continue;
    candidates.push({ sleeve: o.sleeve, underlying: o.symbol, symbol: fund.symbol, meanConfidence: o.meanConfidence });
  }
  return candidates.slice(0, BET_MAX_COUNT);
}

/** What becomes of ONE `short` override of a strategy that applies, for the owner's message:
 *  `bet` it becomes a bet, `no_fund` the stock has no inverse fund, `cap` there are already two better bets. Null when the
 *  bets are off or the override is not a short of a strategy that applies (it is then worded as it always was). */
export function betOutcome(decision: { overrides: readonly Override[] }, o: Override, input: BetsInput): "bet" | "no_fund" | "cap" | null {
  if (input.betsOn !== true || o.action !== "short" || input.applies?.[o.sleeve] !== true) return null;
  if (!inverseOf(o.symbol)) return "no_fund";
  return betsOf(decision, input).some(b => b.sleeve === o.sleeve && b.underlying === o.symbol) ? "bet" : "cap";
}
