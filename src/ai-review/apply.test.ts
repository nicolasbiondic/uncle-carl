import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_REVIEW_APPLY, aiReviewHook, applyReview, modelWeightsOfJournal, readJournaledReview, reviewApplies, reviewForPass } from "./apply";
import { sealDecision, type Override, type SleeveId } from "./contract";
import { baseDecision, MEANREV, MOMENTUM } from "./testFixtures";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ai-review-apply-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ov = (symbol: string, over: Partial<Override> = {}): Override => ({
  sleeve: "momentum_stocks", symbol, action: "exit", factor: 0, meanConfidence: 0.8,
  votes: [{ family: "claude", action: "exit", confidence: 0.8 }, { family: "gpt", action: "exit", confidence: 0.8 }],
  reason: "Motivo.", sources: ["https://a.com/x"], ...over,
});
const put = (session: string, overrides: Override[]) => {
  const d = sealDecision(baseDecision({ session, decidedAt: `${session}T13:15:00.000Z`, overrides }));
  writeFileSync(join(dir, `${session}.json`), JSON.stringify(d));
  return d;
};

describe("the switch", () => {
  test("both sleeves are OFF in what is delivered (the director flips them in his own commit, after verifying)", () => {
    expect(AI_REVIEW_APPLY).toEqual({ momentum_stocks: false, meanrev_stocks: false });
    expect(Object.isFrozen(AI_REVIEW_APPLY)).toBe(true);
    for (const s of ["momentum_stocks", "meanrev_stocks"]) expect(reviewApplies(s, {})).toBe(false);
  });
  test("reviewApplies: the table decides; AI_REVIEW_APPLY=off beats it; crypto and unknown sleeves never apply", () => {
    const on = { momentum_stocks: true, meanrev_stocks: false };
    expect(reviewApplies("momentum_stocks", {}, on)).toBe(true);
    expect(reviewApplies("meanrev_stocks", {}, on)).toBe(false);
    for (const kill of ["off", "OFF", " off ", "0", "false"]) expect(reviewApplies("momentum_stocks", { AI_REVIEW_APPLY: kill }, on)).toBe(false);
    expect(reviewApplies("momentum_stocks", { AI_REVIEW_APPLY: "on" }, on)).toBe(true); // an env value never turns a sleeve ON by itself
    expect(reviewApplies("meanrev_stocks", { AI_REVIEW_APPLY: "on" }, on)).toBe(false);
    expect(reviewApplies("momentum_crypto", {}, { ...on, momentum_crypto: true } as any)).toBe(false);
  });
});

describe("applyReview", () => {
  const model = { NVDA: 0.2, AAPL: 0.1, MSFT: 0.1, SH: 0.05 };
  test("reduce halves, exit and short zero; every other weight is untouched and nothing is renormalised", () => {
    const r = applyReview(model, [
      { symbol: "NVDA", action: "exit", factor: 0 }, { symbol: "AAPL", action: "reduce", factor: 0.5 }, { symbol: "MSFT", action: "short", factor: 0 },
    ]);
    expect(r.weights).toEqual({ NVDA: 0, AAPL: 0.05, MSFT: 0, SH: 0.05 });
    expect(r.effects).toEqual([
      { symbol: "NVDA", action: "exit", factor: 0, modelWeight: 0.2, appliedWeight: 0 },
      { symbol: "AAPL", action: "reduce", factor: 0.5, modelWeight: 0.1, appliedWeight: 0.05 },
      { symbol: "MSFT", action: "short", factor: 0, modelWeight: 0.1, appliedWeight: 0 },
    ]);
    expect(Object.values(r.weights).reduce((a, b) => a + b, 0)).toBeLessThan(Object.values(model).reduce((a, b) => a + b, 0));
  });
  test("an override on a symbol the model does not hold (absent, zero, negative, NaN) is a no-op with no effect", () => {
    const r = applyReview({ NVDA: 0, AAPL: -1, MSFT: Number.NaN }, [
      { symbol: "NVDA", action: "exit", factor: 0 }, { symbol: "AAPL", action: "exit", factor: 0 }, { symbol: "MSFT", action: "exit", factor: 0 }, { symbol: "ZZZ", action: "exit", factor: 0 },
    ]);
    expect(r.effects).toEqual([]);
    expect(r.weights).toEqual({ NVDA: 0, AAPL: -1, MSFT: Number.NaN });
  });
  test("a factor above 1 never raises a weight, one below 0 never goes negative, NaN does nothing; the action is the ceiling of the cut", () => {
    const r = applyReview({ A: 0.1, B: 0.1, C: 0.1, D: 0.1 }, [
      { symbol: "A", action: "reduce", factor: 1.5 }, { symbol: "B", action: "exit", factor: -3 }, { symbol: "C", action: "exit", factor: Number.NaN },
      { symbol: "D", action: "reduce", factor: -1 },
    ]);
    expect(r.weights).toEqual({ A: 0.1, B: 0, C: 0.1, D: 0.05 }); // 1.5 → 1 (no cut); -3 → 0 (an exit is an exit); NaN → 1; a reduce is never deeper than half
    expect(r.effects.map(e => e.symbol)).toEqual(["B", "D"]);
    for (const k of ["A", "B", "C", "D"]) { expect(r.weights[k]).toBeLessThanOrEqual(0.1); expect(r.weights[k]).toBeGreaterThanOrEqual(0); }
  });
  test("a symbol listed twice counts once (the first)", () => {
    const r = applyReview({ A: 0.2 }, [{ symbol: "A", action: "reduce", factor: 0.5 }, { symbol: "A", action: "exit", factor: 0 }]);
    expect(r.weights.A).toBe(0.1);
    expect(r.effects).toHaveLength(1);
  });
  test("the input is never mutated", () => {
    const m = Object.freeze({ A: 0.2 });
    expect(() => applyReview(m, [{ symbol: "A", action: "exit", factor: 0 }])).not.toThrow();
    expect(m.A).toBe(0.2);
  });
});

describe("reviewForPass", () => {
  const universe = MOMENTUM;
  const get = (session = "2026-11-16", sleeve: SleeveId = "momentum_stocks", uni: readonly string[] = universe) => reviewForPass({ dir, sleeve, session, universe: uni });
  test("no inbox, an empty one, a corrupt file: null, never a throw", () => {
    expect(get()).toBeNull();
    mkdirSync(dir, { recursive: true });
    expect(get()).toBeNull();
    writeFileSync(join(dir, "2026-11-16.json"), "{ nope");
    expect(get()).toBeNull();
    expect(reviewForPass({ dir: join(dir, "x", "y"), sleeve: "momentum_stocks", session: "2026-11-16", universe })).toBeNull();
    expect(reviewForPass({ dir, sleeve: "momentum_stocks", session: "garbage", universe })).toBeNull();
  });
  test("the decision's id and session travel with the overrides of THIS sleeve, inside its universe", () => {
    const d = put("2026-11-16", [ov("NVDA"), ov("SH"), ov("ABBV", { sleeve: "meanrev_stocks" }), ov("AAPL", { action: "reduce", factor: 0.5, votes: [{ family: "claude", action: "reduce", confidence: 0.8 }, { family: "gpt", action: "reduce", confidence: 0.8 }] })]);
    const r = get()!;
    expect(r.decisionId).toBe(d.id);
    expect(r.decisionSession).toBe("2026-11-16");
    expect(r.overrides.map(o => [o.symbol, o.action, o.factor]).sort()).toEqual([["AAPL", "reduce", 0.5], ["NVDA", "exit", 0]]);
    const rev = get("2026-11-16", "meanrev_stocks", MEANREV)!;
    expect(rev.overrides.map(o => o.symbol)).toEqual(["ABBV"]);
  });
  test("a decision is active for 5 sessions after its own and lapses on the 6th; a later-dated one is not active yet", () => {
    put("2026-11-09", [ov("NVDA")]);
    expect(get("2026-11-16")).not.toBeNull();   // 10, 11, 12, 13, 16 = 5 sessions
    expect(get("2026-11-17")).toBeNull();       // the 6th
    expect(get("2026-11-06")).toBeNull();       // dated after the pass it would serve
  });
  test("never more than 3 (momentum) / 6 (meanrev) names, the most confident first, even with more in the file", () => {
    const conf = (i: number) => 0.95 - i * 0.02;
    const o = (s: string, i: number, sleeve: SleeveId) => ov(s, { sleeve, meanConfidence: conf(i), votes: [{ family: "claude", action: "exit", confidence: conf(i) }, { family: "gpt", action: "exit", confidence: conf(i) }] });
    put("2026-11-16", [...MOMENTUM.slice(0, 7).map((s, i) => o(s, i, "momentum_stocks")), ...MEANREV.slice(0, 9).map((s, i) => o(s, i, "meanrev_stocks"))]);
    expect(get()!.overrides.map(x => x.symbol)).toEqual(MOMENTUM.slice(0, 3));
    expect(get("2026-11-16", "meanrev_stocks", MEANREV)!.overrides.map(x => x.symbol)).toEqual(MEANREV.slice(0, 6));
  });
  test("a decision with no overrides is a decision: an empty list, not null", () => {
    put("2026-11-13", [ov("NVDA")]);
    put("2026-11-16", []);
    expect(get()!.overrides).toEqual([]);
  });
  test("aiReviewHook binds a sleeve, its inbox and its switch", () => {
    put("2026-11-16", [ov("NVDA")]);
    const off = aiReviewHook("momentum_stocks", { dir, env: {} });
    expect(off.applies()).toBe(false);
    expect(off.forPass("2026-11-16", universe)!.overrides.map(o => o.symbol)).toEqual(["NVDA"]);
    expect(aiReviewHook("momentum_stocks", { dir, env: { AI_REVIEW_APPLY: "off" }, table: { momentum_stocks: true, meanrev_stocks: true } }).applies()).toBe(false);
    expect(aiReviewHook("momentum_stocks", { dir, env: {}, table: { momentum_stocks: true, meanrev_stocks: true } }).applies()).toBe(true);
  });
});

describe("what the journal keeps", () => {
  const review = { decisionId: "abc123def456", decisionSession: "2026-11-16", applied: true,
    effects: [{ symbol: "NVDA", action: "exit", factor: 0, modelWeight: 0.2, appliedWeight: 0 }], modelWeights: { NVDA: 0.2 } };
  test("readJournaledReview reads a good record and reads anything malformed as no review", () => {
    expect(readJournaledReview({ aiReview: review })).toEqual(review as any);
    for (const bad of [null, undefined, {}, { aiReview: null }, { aiReview: { ...review, applied: "yes" } }, { aiReview: { ...review, effects: [{ symbol: "A" }] } }, { aiReview: { ...review, effects: [{ ...review.effects[0], action: "keep" }] } }, { aiReview: { ...review, decisionId: 5 } }]) {
      expect(readJournaledReview(bad)).toBeNull();
    }
  });
  test("modelWeightsOfJournal: applied weights go back to the model's; informed-only and no review are the journal's own", () => {
    expect(modelWeightsOfJournal({ NVDA: 0, AAPL: 0.1 }, { aiReview: review })).toEqual({ NVDA: 0.2, AAPL: 0.1 });
    expect(modelWeightsOfJournal({ NVDA: 0.2, AAPL: 0.1 }, { aiReview: { ...review, applied: false, modelWeights: undefined } })).toEqual({ NVDA: 0.2, AAPL: 0.1 });
    expect(modelWeightsOfJournal({ NVDA: 0.2 }, {})).toEqual({ NVDA: 0.2 });
    expect(modelWeightsOfJournal({ NVDA: 0.2 }, { aiReview: "garbage" })).toEqual({ NVDA: 0.2 });
  });
});
