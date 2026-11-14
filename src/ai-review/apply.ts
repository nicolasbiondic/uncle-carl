// AI review, stage B: what the live stock engine may do with a decision (docs/reports/IA-revision-de-noticias-2026-11-14.md §3.4).
// Pure and fail-open: nothing here throws into a pass, a missing or invalid decision means "no override", and no
// result can ever raise a weight, touch a symbol outside the sleeve's own universe, or exceed the pre-registered
// number of names. Enforced: src/ai-review/apply.test.ts, src/portfolio-engine/live/PortfolioEngine.aiReview.test.ts.

import { OVERRIDE_ACTIONS, SLEEVE_IDS, type Override, type OverrideAction, type SleeveId } from "./contract";
import { loadActiveDecision } from "./active";
import { betsOf, type Bet } from "./bets";
import { inverseOf } from "./inverse";
import { BET_MAX_USD, BET_STOP_FRACTION, FACTOR, MAX_NAMES, rank } from "./limits";

/** Does the bot ACT on the review of this sleeve? ON for both stock sleeves since 2026-11-14, by the owner's order
 *  ("no necesito más pruebas, necesito que empieces a operar"; pre-registration, amendment of that day): the first
 *  real decision (2026-11-16) is applied, with no inform-only period. Changed only by a commit released with
 *  scripts/release.ts; AI_REVIEW_APPLY=off in the bot's environment turns it off at once (below). With no decision
 *  file (a fork that does not run the review) an ON switch changes nothing: there is nothing to apply. */
export const AI_REVIEW_APPLY: Readonly<Record<SleeveId, boolean>> = Object.freeze({ momentum_stocks: true, meanrev_stocks: true });

/** Kill switch that needs no release: AI_REVIEW_APPLY=off in the bot's environment (restart to take effect). */
export function reviewApplies(sleeve: string, env: Record<string, string | undefined> = process.env,
  table: Readonly<Record<SleeveId, boolean>> = AI_REVIEW_APPLY): boolean {
  const kill = (env.AI_REVIEW_APPLY ?? "").trim().toLowerCase();
  if (kill === "off" || kill === "0" || kill === "false") return false;
  return (SLEEVE_IDS as readonly string[]).includes(sleeve) && table[sleeve as SleeveId] === true;
}

/** Stage C: does the bot BET on a `short` verdict (buy the stock's inverse fund) as well as taking the stock out? ON since
 *  2026-11-14 (owner: "¿por qué no haces short?", then "necesito que empieces a operar"; turned on by the director after his
 *  review, pre-registration amendment, point 3 and its precisions). With it off a `short` is an exit exactly as in stage B, in
 *  the plan and in the journal. Changed only by a commit released with scripts/release.ts. It never acts alone: a bet needs the
 *  sleeve's own switch too. */
export const AI_REVIEW_BETS: boolean = true;

/** The bets switch with the environment's kill switches: AI_REVIEW_APPLY=off (the whole review) or AI_REVIEW_BETS=off turn bets off
 *  at once, no release (restart to take effect). The environment can never turn them on. */
export function reviewBetsOn(env: Record<string, string | undefined> = process.env, flag: boolean = AI_REVIEW_BETS): boolean {
  const off = (v: string | undefined) => ["off", "0", "false"].includes((v ?? "").trim().toLowerCase());
  if (off(env.AI_REVIEW_APPLY) || off(env.AI_REVIEW_BETS)) return false;
  return flag === true;
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

/** What the pass knows when it sizes a bet. */
export interface BetContext {
  equity: number;
  positions: ReadonlyArray<{ symbol: string; qty: number; avgEntryPrice: number }>;
  prices: Readonly<Record<string, number>>;
  /** The funds whose price in `prices` is good enough to OPEN a bet at: the engine's estimate (the fund's last close moved against today's
   *  move of its stock, src/ai-review/inverse.ts) or the venue's own fresh price. A fund outside it is never a NEW bet; a held one keeps
   *  its lot and is judged on the price it has. */
  entryPriced: ReadonlySet<string>;
  /** The active decision is this session's own. A NEW bet needs it: a decision of an earlier session that is still valid keeps a bet that
   *  is already open, it never opens one. So a bet is never entered late on old news, and a stopped bet is not bought back until a new
   *  decision asks for it again. */
  fresh: boolean;
}

/** One bet of this pass as the journal keeps it (`diagnostics.aiReview.bets`): `weight` is the fund's applied weight (0 when
 *  `stopped`), `modelWeight` the MODEL's weight of the underlying stock. */
export interface BetEffect { underlying: string; symbol: string; weight: number; modelWeight: number; stopped: boolean }

/** Fund weight = min(BET_MAX_USD ÷ the pass's equity, the model's weight of the underlying), so the review never raises what the
 *  strategy has invested (what the exit frees is more than what the bet uses). The stop: a HELD fund whose reference price is
 *  BET_STOP_FRACTION or more below the row's average entry has weight 0 for this pass (checked once a day, here, not intraday).
 *  A bet needs an applied `short` effect on its stock (the model held it) and a known fund of that stock; a NEW entry also needs a
 *  decision of this very session and an entry price for the fund (BetContext); anything else is no bet. Pure; never throws for a
 *  malformed input (it returns fewer bets). */
export function sizeBets(modelWeights: Readonly<Record<string, number>>, effects: readonly ReviewEffect[], bets: readonly Bet[], ctx: BetContext): BetEffect[] {
  const out: BetEffect[] = [];
  if (!(ctx.equity > 0) || !Number.isFinite(ctx.equity)) return out;
  const cap = BET_MAX_USD / ctx.equity;
  for (const bet of bets) {
    const fund = inverseOf(bet.underlying);
    if (!fund || fund.symbol !== bet.symbol || modelWeights[fund.symbol] !== undefined) continue;
    const effect = effects.find(e => e.symbol === bet.underlying && e.action === "short" && e.appliedWeight === 0);
    if (!effect || !(effect.modelWeight > 0) || !Number.isFinite(effect.modelWeight)) continue;
    const held = ctx.positions.find(p => p.symbol === fund.symbol && p.qty > 0);
    const price = ctx.prices[fund.symbol];
    const priced = Number.isFinite(price) && price > 0;
    let stopped = false;
    if (held) {
      stopped = priced && held.avgEntryPrice > 0 && (held.avgEntryPrice - price) / held.avgEntryPrice >= BET_STOP_FRACTION - 1e-12;
    } else if (ctx.fresh !== true || !priced || !ctx.entryPriced.has(fund.symbol)) continue;
    out.push({ underlying: bet.underlying, symbol: fund.symbol, weight: stopped ? 0 : Math.min(cap, effect.modelWeight), modelWeight: effect.modelWeight, stopped });
  }
  return out;
}

/** The engine's last check before it aims at `applied` instead of the model's `model` weights (anything false → the model's own):
 *  every model key stays, finite, not below zero and not above the model's; NO other key except the fund of a bet of this pass, whose
 *  weight is above zero and not above either cap (BET_MAX_USD ÷ equity, the model's weight of the stock it bets against); a fund is
 *  the known fund of its stock; and the total never exceeds the model's total (what the review frees is more than the bet uses). */
export function appliedWeightsSane(model: Readonly<Record<string, number>>, applied: Readonly<Record<string, number>>, bets: readonly BetEffect[],
  effects: readonly ReviewEffect[], equity: number): boolean {
  const keys = Object.keys(model);
  const funds = bets.filter(b => b.weight > 0);
  if (Object.keys(applied).length !== keys.length + funds.length) return false;
  if (!keys.every(k => Number.isFinite(applied[k]) && applied[k] >= 0 && applied[k] <= model[k])) return false;
  const cap = BET_MAX_USD / equity;
  for (const b of funds) {
    const fund = inverseOf(b.underlying);
    const effect = effects.find(e => e.symbol === b.underlying);
    if (!fund || fund.symbol !== b.symbol || model[b.symbol] !== undefined || !effect || effect.modelWeight !== b.modelWeight) return false;
    if (!(equity > 0) || !Number.isFinite(b.weight) || !(applied[b.symbol] === b.weight) || b.weight > cap + 1e-12 || b.weight > b.modelWeight + 1e-12) return false;
  }
  const sum = (w: Readonly<Record<string, number>>) => Object.values(w).reduce((s, x) => s + x, 0);
  return sum(applied) <= sum(model) + 1e-9;
}

/** The weights with the bets' funds added (a stopped bet adds nothing). Never touches an existing key. */
export function applyBets(weights: Readonly<Record<string, number>>, bets: readonly BetEffect[]): Record<string, number> {
  const out: Record<string, number> = { ...weights };
  for (const b of bets) if (b.weight > 0 && out[b.symbol] === undefined) out[b.symbol] = b.weight;
  return out;
}

export interface ReviewForPass { decisionId: string; decisionSession: string; overrides: Override[]; /** Stage C: this sleeve's bets (empty unless asked for). */ bets?: Bet[] }

/** The active decision's overrides for ONE sleeve at this session, or null (no decision, expired, corrupt, a later
 *  session, any error). Re-validated and clamped by loadActiveDecision; here again restricted to the sleeve's own
 *  universe, to the pre-registered number of names, and to reduce/exit/short. Never throws. */
export function reviewForPass(input: { dir: string; sleeve: SleeveId; session: string; universe: readonly string[];
  sessionsBetween?: (from: string, to: string) => number;
  /** Stage C: ask for this sleeve's bets. `applies` = every strategy's switch, `on` = the bets switch. Absent or off: no bets. */
  bets?: { applies: Readonly<Record<SleeveId, boolean>>; on: boolean } }): ReviewForPass | null {
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
    const overrides = mine.slice(0, MAX_NAMES[input.sleeve]);
    const out: ReviewForPass = { decisionId: decision.id, decisionSession: decision.session, overrides };
    if (input.bets?.on === true) {
      // The two-bet cap is over the WHOLE decision: this sleeve's validated overrides against the other sleeve's. A claim of the other
      // sleeve on a stock of THIS universe is not its own (the universes are disjoint): it is ignored, so a tampered file can only
      // take a bet slot, never add a bet.
      const others = decision.overrides.filter(o => o.sleeve !== input.sleeve && !own.has(o.symbol));
      out.bets = betsOf({ overrides: [...overrides, ...others] }, { applies: input.bets.applies, betsOn: true }).filter(b => b.sleeve === input.sleeve);
    }
    return out;
  } catch {
    return null;
  }
}

/** What the engine hands the pass: its sleeve's switch and its decision (the engine never reads either itself). */
export interface AiReviewHook {
  forPass(session: string, universe: readonly string[]): ReviewForPass | null;
  applies(): boolean;
  /** Stage C: may this sleeve BET on a `short` (AI_REVIEW_BETS and the kill switches)? A hook without it never bets. */
  betsOn?(): boolean;
}

export const DEFAULT_INBOX_DIR = "data/ai-review/inbox";

export function aiReviewHook(sleeve: SleeveId, opts: { dir?: string; env?: Record<string, string | undefined>; table?: Readonly<Record<SleeveId, boolean>>; bets?: boolean } = {}): AiReviewHook {
  const dir = opts.dir ?? DEFAULT_INBOX_DIR;
  const env = () => opts.env ?? process.env;
  const table = () => opts.table ?? AI_REVIEW_APPLY;
  const betsOn = () => reviewBetsOn(env(), opts.bets ?? AI_REVIEW_BETS);
  return {
    forPass: (session, universe) => reviewForPass({ dir, sleeve, session, universe,
      bets: { applies: Object.fromEntries(SLEEVE_IDS.map(s => [s, reviewApplies(s, env(), table())])) as Record<SleeveId, boolean>, on: betsOn() } }),
    applies: () => reviewApplies(sleeve, env(), table()),
    betsOn,
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
  /** Stage C, only when the bets switch is on and a bet of this pass exists: the funds bought against the stocks the review took out.
   *  Absent otherwise, so a journal with the switch off (or before stage C) is exactly what stage B wrote. */
  bets?: BetEffect[];
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
  if (r.bets !== undefined) {
    if (!Array.isArray(r.bets)) return null;
    const bets: BetEffect[] = [];
    for (const b of r.bets as Array<Record<string, unknown>>) {
      if (!b || typeof b.underlying !== "string" || typeof b.symbol !== "string" || !isNum(b.weight) || b.weight < 0 || !isNum(b.modelWeight) || typeof b.stopped !== "boolean") return null;
      bets.push({ underlying: b.underlying, symbol: b.symbol, weight: b.weight, modelWeight: b.modelWeight, stopped: b.stopped });
    }
    out.bets = bets;
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
  // Stage C: the funds the review bought are not the model's (the journal's weights carry them as applied weights).
  for (const b of review.bets ?? []) delete model[b.symbol];
  return model;
}
