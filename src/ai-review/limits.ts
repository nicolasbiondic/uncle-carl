// Pre-registered limits the AI cannot pass (docs/reports/IA-revision-de-noticias-2026-11-14.md §3.4).
// Constants are FIXED for the trial period; change one only by declaring an error
// in the pre-registration. Enforced: src/ai-review/limits.test.ts.

import type { Dropped, Override, OverrideAction, SleeveId } from "./contract";
import { SLEEVE_IDS } from "./contract";

/** At most this many names overridden at once per sleeve (3 of 11 momentum, 6 of 32 mean reversion). */
export const MAX_NAMES: Readonly<Record<SleeveId, number>> = { momentum_stocks: 3, meanrev_stocks: 6 };

/** A decision stays valid this many NYSE sessions after its own, then lapses. */
export const MAX_AGE_SESSIONS = 5;

/** Share of the model's weight kept. What is freed stays in cash. Short is 0 until stage C. */
export const FACTOR: Readonly<Record<OverrideAction, number>> = { reduce: 0.5, exit: 0, short: 0 };

export const MAX_SOURCES = 6;

/** Rank by mean confidence (high first), then symbol, so the cut is deterministic. */
export function rank(a: Pick<Override, "meanConfidence" | "symbol">, b: Pick<Override, "meanConfidence" | "symbol">): number {
  return b.meanConfidence - a.meanConfidence || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
}

/** Cap each sleeve at MAX_NAMES; what is cut is reported, never silent. Output is ordered by sleeve, then rank. */
export function capOverrides(overrides: Override[]): { kept: Override[]; dropped: Dropped[] } {
  const kept: Override[] = [];
  const dropped: Dropped[] = [];
  for (const sleeve of SLEEVE_IDS) {
    const mine = overrides.filter(o => o.sleeve === sleeve).sort(rank);
    kept.push(...mine.slice(0, MAX_NAMES[sleeve]));
    for (const o of mine.slice(MAX_NAMES[sleeve])) dropped.push({ sleeve, symbol: o.symbol, why: `over_limit:${MAX_NAMES[sleeve]}` });
  }
  return { kept, dropped };
}
