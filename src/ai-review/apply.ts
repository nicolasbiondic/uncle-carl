// AI review, stage B: what the live stock engine may do with a decision (docs/reports/IA-revision-de-noticias-2026-11-14.md §3.4).
// Pure and fail-open: nothing here throws into a pass, a missing or invalid decision means "no override", and no
// result can ever raise a weight, touch a symbol outside the sleeve's own universe, or exceed the pre-registered
// number of names. Enforced: src/ai-review/apply.test.ts, src/portfolio-engine/live/PortfolioEngine.aiReview.test.ts.

import { OVERRIDE_ACTIONS, SLEEVE_IDS, type Override, type OverrideAction, type SleeveId } from "./contract";
import { loadActiveDecision } from "./active";
import { FACTOR, MAX_NAMES, rank } from "./limits";

/** Does the bot ACT on the review of this sleeve? Both off in what is delivered: the director flips a sleeve to
 *  `true` in its own commit, after verifying the first informed days, and releases it with scripts/release.ts. */
export const AI_REVIEW_APPLY: Readonly<Record<SleeveId, boolean>> = Object.freeze({ momentum_stocks: false, meanrev_stocks: false });

/** Kill switch that needs no release: AI_REVIEW_APPLY=off in the bot's environment (restart to take effect). */
export function reviewApplies(sleeve: string, env: Record<string, string | undefined> = process.env,
  table: Readonly<Record<SleeveId, boolean>> = AI_REVIEW_APPLY): boolean {
  const kill = (env.AI_REVIEW_APPLY ?? "").trim().toLowerCase();
  if (kill === "off" || kill === "0" || kill === "false") return false;
  return (SLEEVE_IDS as readonly string[]).includes(sleeve) && table[sleeve as SleeveId] === true;
}

export interface ReviewEffect {
  symbol: string;
  action: OverrideAction;
  factor: number;
  modelWeight: number;
  appliedWeight: number;
}

export interface AppliedReview { weights: Record<string, number>; effects: ReviewEffect[] }

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 1);

/** applied = model × factor for an overridden symbol the model holds (weight > 0); every other weight is untouched,
 *  nothing is renormalised (what is freed stays in cash), and no weight ever rises. The factor is clamped to
 *  [0, 1] and is never milder-than-nothing nor stronger than its action allows (reduce 0.5, exit 0, short 0). */
export function applyReview(modelWeights: Readonly<Record<string, number>>,
  overrides: ReadonlyArray<Pick<Override, "symbol" | "action" | "factor">>): AppliedReview {
  const weights: Record<string, number> = { ...modelWeights };
  const effects: ReviewEffect[] = [];
  const seen = new Set<string>();
  for (const o of overrides) {
    if (seen.has(o.symbol)) continue;
    seen.add(o.symbol);
    const own = FACTOR[o.action];
    if (own === undefined) continue;
    const model = modelWeights[o.symbol];
    if (!(typeof model === "number" && Number.isFinite(model) && model > 0)) continue;
    const factor = Math.max(clamp01(o.factor), own);
    const applied = model * factor;
    if (!(applied < model)) continue;
    weights[o.symbol] = applied;
    effects.push({ symbol: o.symbol, action: o.action, factor, modelWeight: model, appliedWeight: applied });
  }
  return { weights, effects };
}

export interface ReviewForPass { decisionId: string; decisionSession: string; overrides: Override[] }

/** The active decision's overrides for ONE sleeve at this session, or null (no decision, expired, corrupt, a later
 *  session, any error). Re-validated and clamped by loadActiveDecision; here again restricted to the sleeve's own
 *  universe, to the pre-registered number of names, and to reduce/exit/short. Never throws. */
export function reviewForPass(input: { dir: string; sleeve: SleeveId; session: string; universe: readonly string[];
  sessionsBetween?: (from: string, to: string) => number }): ReviewForPass | null {
  try {
    const decision = loadActiveDecision({ dir: input.dir, session: input.session, sessionsBetween: input.sessionsBetween });
    if (!decision) return null;
    const own = new Set(input.universe);
    const seen = new Set<string>();
    const mine: Override[] = [];
    for (const o of decision.overrides) {
      if (o.sleeve !== input.sleeve || !own.has(o.symbol) || seen.has(o.symbol)) continue;
      if (!(OVERRIDE_ACTIONS as readonly string[]).includes(o.action)) continue;
      seen.add(o.symbol);
      mine.push({ ...o, factor: Math.max(clamp01(o.factor), FACTOR[o.action]) });
    }
    mine.sort(rank);
    return { decisionId: decision.id, decisionSession: decision.session, overrides: mine.slice(0, MAX_NAMES[input.sleeve]) };
  } catch {
    return null;
  }
}

/** What the engine hands the pass: its sleeve's switch and its decision (the engine never reads either itself). */
export interface AiReviewHook {
  forPass(session: string, universe: readonly string[]): ReviewForPass | null;
  applies(): boolean;
}

export const DEFAULT_INBOX_DIR = "data/ai-review/inbox";

export function aiReviewHook(sleeve: SleeveId, opts: { dir?: string; env?: Record<string, string | undefined>; table?: Readonly<Record<SleeveId, boolean>> } = {}): AiReviewHook {
  const dir = opts.dir ?? DEFAULT_INBOX_DIR;
  return {
    forPass: (session, universe) => reviewForPass({ dir, sleeve, session, universe }),
    applies: () => reviewApplies(sleeve, opts.env ?? process.env, opts.table ?? AI_REVIEW_APPLY),
  };
}

// ── what the journal keeps (diagnostics.aiReview) ────────────────────────
export interface JournaledReview {
  decisionId: string;
  decisionSession: string;
  applied: boolean;
  effects: ReviewEffect[];
  /** Only when applied: the model's own weight of each overridden symbol (the journal's `weights` are the applied ones). */
  modelWeights?: Record<string, number>;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Strict reader of `diagnostics.aiReview` (parity, the effect ledger): anything malformed reads as no review. */
export function readJournaledReview(diagnostics: unknown): JournaledReview | null {
  const r = (diagnostics as { aiReview?: unknown } | null | undefined)?.aiReview as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || typeof r.decisionId !== "string" || typeof r.decisionSession !== "string"
    || typeof r.applied !== "boolean" || !Array.isArray(r.effects)) return null;
  const effects: ReviewEffect[] = [];
  for (const e of r.effects as Array<Record<string, unknown>>) {
    if (!e || typeof e.symbol !== "string" || !isNum(e.modelWeight) || !isNum(e.appliedWeight) || !isNum(e.factor)
      || !(OVERRIDE_ACTIONS as readonly string[]).includes(e.action as string)) return null;
    effects.push({ symbol: e.symbol, action: e.action as OverrideAction, factor: e.factor, modelWeight: e.modelWeight, appliedWeight: e.appliedWeight });
  }
  const out: JournaledReview = { decisionId: r.decisionId, decisionSession: r.decisionSession, applied: r.applied, effects };
  if (r.modelWeights && typeof r.modelWeights === "object") {
    const mw: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.modelWeights as Record<string, unknown>)) if (isNum(v)) mw[k] = v;
    out.modelWeights = mw;
  }
  return out;
}

/** The weights the MODEL produced for a journaled pass: the journal's own when the review only informed, the applied ones
 *  put back to the model's where a review was applied (parity compares the replay of `decide` against these). */
export function modelWeightsOfJournal(weights: Readonly<Record<string, number>>, diagnostics: unknown): Record<string, number> {
  const review = readJournaledReview(diagnostics);
  if (!review || !review.applied) return { ...weights };
  const model: Record<string, number> = { ...weights };
  for (const e of review.effects) model[e.symbol] = e.modelWeight;
  for (const [s, w] of Object.entries(review.modelWeights ?? {})) model[s] = w;
  return model;
}
