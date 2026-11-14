// The review's track record for the analysts' case file (docs/reports/IA-revision-de-noticias-2026-11-14.md, amendment 2026-11-14,
// point 2: "cada mañana los modelos reciben … el historial de las decisiones de la revisión y lo que pasó después").
// It is NOT a second formula: the episodes, their effects and the costs are `buildLedger`'s (src/ai-review/effects.ts), fed with the
// last 20 NYSE sessions of the same journal and the same daily opens as scripts/ai-review-report.ts. Only the applied ledger counts.
// Misses (the pre-registration's "omisiones"): a stock the strategy HELD (the journal's book of that pass) that fell 5 % or more
// from one session's open to the next session's open while the review had no action on it.
// Pure over the passes and opens handed to it; `readHistory` reads both databases READ-ONLY (the caller opens them that way).
// Enforced: src/ai-review/history.test.ts.

import type { Database } from "bun:sqlite";
import { readJournaledReview } from "./apply";
import { getPreviousTradingDay } from "./calendar";
import { HISTORY_MAX_EPISODES, HISTORY_MAX_MISSES, SLEEVE_IDS, type CaseHistory, type HistoryEpisode, type HistoryMiss, type SleeveId } from "./contract";
import { AI_REVIEW_START, buildLedger, nextSessionOf, type OpenLookup } from "./effects";
import { dailyOpenLookup, readPasses, type HeldPass } from "./journalDb";

/** NYSE sessions the history looks back over. */
export const HISTORY_SESSIONS = 20;
/** The history may never take more than this of the case file (the whole file stays under MAX_CASEFILE_BYTES). */
export const HISTORY_MAX_BYTES = 4_000;
/** A fall of this much or more, open to open, is a strong fall (pre-registration §4). */
export const MISS_DROP_FRACTION = 0.05;

/** The first of the last 20 sessions before `session`, and never before the review's own first session (`start`): what a held
 *  stock did before the review existed is not its record. */
export function historyWindowStart(session: string, start: string = AI_REVIEW_START): string {
  let d = session;
  for (let i = 0; i < HISTORY_SESSIONS; i++) d = getPreviousTradingDay(d);
  return d < start ? start : d;
}

export interface HistoryInput {
  session: string;
  passes: readonly HeldPass[];
  opens: OpenLookup;
  /** Each sleeve's own universe: what the review can act on (SH and the like are out). */
  universes: Readonly<Record<SleeveId, readonly string[]>>;
  nextSession?: (s: string) => string;
  /** The review's first session (default AI_REVIEW_START); tests pass their own. */
  start?: string;
}

const bySessionDesc = <T extends { session: string }>(a: T, b: T) => (a.session < b.session ? 1 : a.session > b.session ? -1 : 0);

/** Every miss of the passes handed in (no cap), newest first: scripts/ai-review-report.ts lists them all, the case file keeps the last ten. */
export function findMisses(passes: readonly HeldPass[], opens: OpenLookup, universes: HistoryInput["universes"], nextSession: (s: string) => string = nextSessionOf): HistoryMiss[] {
  const misses: HistoryMiss[] = [];
  const seen = new Set<string>();
  for (const p of passes) {
    const sleeve = p.sleeve as SleeveId;
    if (!(SLEEVE_IDS as readonly string[]).includes(sleeve)) continue;
    const acted = new Set(readJournaledReview(p.diagnostics)?.effects.map(e => e.symbol) ?? []);
    const own = new Set(universes[sleeve]);
    for (const symbol of p.held) {
      const key = `${p.session}|${sleeve}|${symbol}`;
      if (!own.has(symbol) || acted.has(symbol) || seen.has(key)) continue;
      const open = opens(symbol, p.session), next = opens(symbol, nextSession(p.session));
      if (open === null || next === null || !(open > 0) || !(next > 0)) continue;
      const fall = 1 - next / open;
      if (fall < MISS_DROP_FRACTION - 1e-9) continue;
      seen.add(key);
      misses.push({ session: p.session, sleeve, symbol, dropPct: Math.round(fall * 1000) / 10 });
    }
  }
  return misses.sort((a, b) => bySessionDesc(a, b) || b.dropPct - a.dropPct || (a.symbol < b.symbol ? -1 : 1));
}

/** The record, or undefined when there is nothing to show yet (no applied decision and no miss in the window). */
export function buildHistory(input: HistoryInput): CaseHistory | undefined {
  const start = historyWindowStart(input.session, input.start);
  const nextSession = input.nextSession ?? nextSessionOf;
  const window = input.passes.filter(p => p.session >= start && p.session < input.session);
  if (window.length === 0) return undefined;

  const block = buildLedger(window, input.opens, nextSession).applied;
  // Stage C: a bet is its own episode with `action: "bet"` (the stock it is against is `symbol`), next to the stock's own exit.
  const episodes: HistoryEpisode[] = [...block.episodes].reverse().map(e => ({
    sleeve: e.sleeve, symbol: e.symbol, action: e.kind === "bet" ? "bet" as const : e.action, from: e.startSession, to: e.endSession === null ? null : e.lastSession,
    sessions: e.days.length, effectUsd: e.days.length === e.pendingDays ? null : Math.round(e.effectUsd),
  }));
  const savedUsd = Math.round(block.savedUsd - block.missedUsd + (block.betUsd ?? 0));
  const costUsd = Math.round(block.costUsd);

  const misses = findMisses(window, input.opens, input.universes, nextSession);

  if (episodes.length === 0 && misses.length === 0) return undefined;
  const sessions = [...new Set(window.map(p => p.session))].sort();
  return fitHistory({
    since: sessions[0], sessions: sessions.length,
    episodes: episodes.slice(0, HISTORY_MAX_EPISODES),
    savedUsd, costUsd, netUsd: savedUsd - costUsd,
    misses: misses.slice(0, HISTORY_MAX_MISSES),
  });
}

/** Under `max` bytes of JSON: drop the OLDEST entry (an episode's start, a miss's session) until it fits. Totals keep covering the window. */
export function fitHistory(h: CaseHistory, max = HISTORY_MAX_BYTES): CaseHistory {
  const out: CaseHistory = { ...h, episodes: [...h.episodes], misses: [...h.misses] };
  while (JSON.stringify(out).length > max && (out.episodes.length > 0 || out.misses.length > 0)) {
    const e = out.episodes.at(-1), m = out.misses.at(-1);
    if (e && (!m || e.from <= m.session)) out.episodes.pop(); else out.misses.pop();
  }
  return out;
}

/** The history for `session` from the bot's own databases (both opened read-only by the caller); undefined when there is none. */
export function readHistory(tradingDb: Database, historicalDb: Database, session: string, universes: HistoryInput["universes"], start: string = AI_REVIEW_START): CaseHistory | undefined {
  const passes = readPasses(tradingDb, historyWindowStart(session, start));
  if (passes.length === 0) return undefined;
  return buildHistory({ session, passes, opens: dailyOpenLookup(historicalDb), universes, start });
}
