// The quorum (docs/reports/IA-revision-de-noticias-2026-11-14.md §3.3), code and not a model:
// a symbol is acted on iff at least MIN_AGREE models of DISTINCT families ask for reduce or
// more and their mean confidence is at least MIN_CONFIDENCE. The mildest of the agreeing
// actions applies; short needs two short votes, else it degrades to the mildest agreeing one.
// Pure function of the verdicts; no tuning knobs. Enforced: src/ai-review/quorum.test.ts.
// (src/ai-quorum/ is a different, older shadow experiment and is not touched.)

import type { CaseFile, Decision, Dropped, ModelRecord, ModelVerdict, Override, OverrideAction, SleeveId, Vote, Action } from "./contract";
import { countSymbols, sealDecision, universeOf } from "./contract";
import { FACTOR, MAX_SOURCES, capOverrides } from "./limits";

export const MIN_AGREE = 2;
export const MIN_CONFIDENCE = 0.6;
/** keep < reduce < exit < short. */
export const SEVERITY: Readonly<Record<Action, number>> = { keep: 0, reduce: 1, exit: 2, short: 3 };

export interface FamilyVerdict { family: string; verdict: ModelVerdict }

interface FamilyVote { family: string; action: Action; confidence: number; reason: string; sources: string[] }
export interface SymbolDecision { action: OverrideAction; meanConfidence: number; votes: Vote[]; reason: string; sources: string[] }

const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

/** One symbol from the family votes (a symbol a family left out counts as keep, i.e. is simply not passed). */
export function decideSymbol(votes: FamilyVote[]): SymbolDecision | null {
  // One vote per family (the runner never repeats a family; if one slipped in, the most confident counts once).
  const byFamily = new Map<string, FamilyVote>();
  for (const v of votes) {
    if (v.action === "keep") continue;
    const prev = byFamily.get(v.family);
    if (!prev || v.confidence > prev.confidence) byFamily.set(v.family, v);
  }
  const agreeing = [...byFamily.values()];
  if (agreeing.length < MIN_AGREE) return null;
  const mean = round9(agreeing.reduce((s, v) => s + v.confidence, 0) / agreeing.length);
  if (mean < MIN_CONFIDENCE) return null;

  const mildestFirst = [...agreeing].sort((a, b) => SEVERITY[a.action] - SEVERITY[b.action]);
  let action = mildestFirst[0].action as OverrideAction;
  if (action === "short" && agreeing.filter(v => v.action === "short").length < MIN_AGREE) {
    const notShort = mildestFirst.find(v => v.action !== "short");
    if (!notShort) return null;
    action = notShort.action as OverrideAction;
  }

  const byConfidence = [...agreeing].sort((a, b) => b.confidence - a.confidence || (a.family < b.family ? -1 : 1));
  const sources = [...new Set(byConfidence.flatMap(v => v.sources))].slice(0, MAX_SOURCES);
  return {
    action,
    meanConfidence: mean,
    votes: byConfidence.map(v => ({ family: v.family, action: v.action as OverrideAction, confidence: v.confidence })),
    reason: byConfidence[0].reason,
    sources,
  };
}

export interface QuorumResult { overrides: Override[]; dropped: Dropped[] }

export function computeOverrides(universe: Record<SleeveId, string[]>, verdicts: FamilyVerdict[]): QuorumResult {
  const symbols = [...new Set(verdicts.flatMap(f => Object.keys(f.verdict.verdicts)))].sort();
  const candidates: Override[] = [];
  const dropped: Dropped[] = [];
  for (const symbol of symbols) {
    const votes: FamilyVote[] = verdicts
      .filter(f => f.verdict.verdicts[symbol] !== undefined)
      .map(f => ({ family: f.family, ...f.verdict.verdicts[symbol] }));
    const d = decideSymbol(votes);
    if (!d) continue;
    // A symbol is only overridable in a sleeve whose universe has it; never one the model invented.
    const sleeves = (Object.keys(universe) as SleeveId[]).filter(s => universe[s].includes(symbol));
    if (sleeves.length === 0) { dropped.push({ sleeve: null, symbol, why: "outside_universe" }); continue; }
    for (const sleeve of sleeves) candidates.push({ sleeve, symbol, action: d.action, factor: FACTOR[d.action], meanConfidence: d.meanConfidence, votes: d.votes, reason: d.reason, sources: d.sources });
  }
  const capped = capOverrides(candidates);
  return { overrides: capped.kept, dropped: [...dropped, ...capped.dropped] };
}

/** null = no decision (fewer than MIN_AGREE valid verdicts from distinct families): nothing is shipped. */
export function buildDecision(input: { caseFile: CaseFile; verdicts: FamilyVerdict[]; models: ModelRecord[]; decidedAt: string; stage?: Decision["stage"] }): Decision | null {
  if (new Set(input.verdicts.map(v => v.family)).size < MIN_AGREE) return null;
  const { overrides, dropped } = computeOverrides(universeOf(input.caseFile), input.verdicts);
  return sealDecision({ session: input.caseFile.session, decidedAt: input.decidedAt, stage: input.stage ?? "inform", models: input.models, overrides, dropped, reviewed: countSymbols(input.caseFile) });
}
