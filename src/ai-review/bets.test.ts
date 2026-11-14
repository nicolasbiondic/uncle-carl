// Stage C, the pure side: which `short` verdicts become bets (the cap over BOTH strategies), how a bet is sized and stopped, the
// switch, and what the journal keeps. The engine's use of all this is src/portfolio-engine/live/PortfolioEngine.bets.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_REVIEW_BETS, aiReviewHook, appliedWeightsSane, applyBets, modelWeightsOfJournal, readJournaledReview, reviewBetsOn, reviewForPass, sizeBets, type ReviewEffect } from "./apply";
import { betOutcome, betsOf } from "./bets";
import { sealDecision, type Override, type SleeveId } from "./contract";
import { BET_MAX_COUNT, BET_MAX_USD, BET_STOP_FRACTION } from "./limits";
import { baseDecision, MEANREV, MOMENTUM } from "./testFixtures";

const BOTH = { momentum_stocks: true, meanrev_stocks: true } as const;
const short = (symbol: string, meanConfidence = 0.8, sleeve: SleeveId = "momentum_stocks", over: Partial<Override> = {}): Override => ({
  sleeve, symbol, action: "short", factor: 0, meanConfidence,
  votes: [{ family: "claude", action: "short", confidence: meanConfidence }, { family: "gpt", action: "short", confidence: meanConfidence }],
  reason: `Motivo de ${symbol}.`, sources: ["https://news.example/a"], ...over,
});
const exit = (symbol: string, meanConfidence = 0.8, sleeve: SleeveId = "momentum_stocks"): Override =>
  short(symbol, meanConfidence, sleeve, { action: "exit", votes: [{ family: "claude", action: "exit", confidence: meanConfidence }, { family: "gpt", action: "exit", confidence: meanConfidence }] });

describe("the constants of a bet are the pre-registered ones", () => {
  test("$2,500, two bets, 8 %; the bets switch is ON (the director, 2026-11-14, after his review)", () => {
    expect(BET_MAX_USD).toBe(2500);
    expect(BET_MAX_COUNT).toBe(2);
    expect(BET_STOP_FRACTION).toBe(0.08);
    expect(AI_REVIEW_BETS).toBe(true);
  });
});

describe("betsOf: only a `short` with a fund, in a strategy that applies, the two best of the WHOLE decision", () => {
  const on = { applies: BOTH, betsOn: true };
  test("switch off: no bet, whatever the decision says", () => {
    expect(betsOf({ overrides: [short("NVDA")] }, { applies: BOTH, betsOn: false })).toEqual([]);
  });
  test("a short of a stock with a fund is a bet; exit and reduce are not; a short without a fund is not", () => {
    const o = [short("NVDA", 0.85), exit("AAPL"), short("KO", 0.9, "meanrev_stocks"), { ...exit("MSFT"), action: "reduce" as const, factor: 0.5 }];
    expect(betsOf({ overrides: o }, on)).toEqual([{ sleeve: "momentum_stocks", underlying: "NVDA", symbol: "NVDD", meanConfidence: 0.85 }]);
  });
  test("a strategy whose switch does not apply places no bet", () => {
    const d = { overrides: [short("NVDA", 0.9), short("AVGO", 0.8, "meanrev_stocks")] };
    expect(betsOf(d, { applies: { momentum_stocks: false, meanrev_stocks: true }, betsOn: true }).map(b => b.underlying)).toEqual(["AVGO"]);
    expect(betsOf(d, { applies: { momentum_stocks: false, meanrev_stocks: false }, betsOn: true })).toEqual([]);
  });
  test("at most two in the whole decision, the most confident first whichever strategy, then by symbol", () => {
    const d = { overrides: [short("NVDA", 0.7), short("AVGO", 0.9, "meanrev_stocks"), short("AAPL", 0.8), short("NFLX", 0.8, "meanrev_stocks")] };
    expect(betsOf(d, on).map(b => `${b.sleeve}:${b.underlying}`)).toEqual(["meanrev_stocks:AVGO", "momentum_stocks:AAPL"]); // 0.9, then 0.8 (AAPL < NFLX)
    expect(betsOf({ overrides: [short("NVDA", 0.6), short("AAPL", 0.6), short("MSFT", 0.6)] }, on).map(b => b.underlying)).toEqual(["AAPL", "MSFT"]); // tie: symbol
  });
  test("deterministic: the order of the file does not matter", () => {
    const o = [short("NVDA", 0.7), short("AVGO", 0.9, "meanrev_stocks"), short("AAPL", 0.8), short("NFLX", 0.8, "meanrev_stocks")];
    const a = betsOf({ overrides: o }, on), b = betsOf({ overrides: [...o].reverse() }, on);
    expect(b).toEqual(a);
  });
  test("one bet per stock even if a tampered file lists it twice (the better one counts)", () => {
    const d = { overrides: [short("NVDA", 0.7), short("NVDA", 0.9, "meanrev_stocks"), short("AAPL", 0.6)] };
    expect(betsOf(d, on).map(b => [b.sleeve, b.underlying])).toEqual([["meanrev_stocks", "NVDA"], ["momentum_stocks", "AAPL"]]);
  });
  test("never throws on a hostile shape", () => {
    expect(betsOf({ overrides: [] }, on)).toEqual([]);
    expect(betsOf({ overrides: [short("NVDA")] }, { applies: undefined as any, betsOn: true })).toEqual([]);
  });
  test("betOutcome tells the owner's message what became of each short", () => {
    const d = { overrides: [short("NVDA", 0.9), short("AAPL", 0.85), short("MSFT", 0.8), short("IWM", 0.95), exit("META")] };
    expect(betOutcome(d, d.overrides[0], on)).toBe("bet");
    expect(betOutcome(d, d.overrides[1], on)).toBe("bet");
    expect(betOutcome(d, d.overrides[2], on)).toBe("cap");        // the third bet
    expect(betOutcome(d, d.overrides[3], on)).toBe("no_fund");    // IWM has no fund
    expect(betOutcome(d, d.overrides[4], on)).toBeNull();         // an exit is not a short
    expect(betOutcome(d, d.overrides[0], { applies: BOTH, betsOn: false })).toBeNull();
    expect(betOutcome(d, d.overrides[0], { applies: { ...BOTH, momentum_stocks: false }, betsOn: true })).toBeNull();
  });
});

describe("reviewBetsOn: the switch, and the kill switches that can only turn it off", () => {
  test("a flag of true needs the environment not to say off; the environment never turns it on", () => {
    expect(reviewBetsOn({}, true)).toBe(true);
    expect(reviewBetsOn({}, false)).toBe(false);
    expect(reviewBetsOn({ AI_REVIEW_BETS: "on" }, false)).toBe(false);
    for (const kill of ["off", "OFF", " off ", "0", "false"]) {
      expect(reviewBetsOn({ AI_REVIEW_BETS: kill }, true)).toBe(false);
      expect(reviewBetsOn({ AI_REVIEW_APPLY: kill }, true)).toBe(false);   // the review's own kill switch turns the bets off too
    }
  });
  test("the real switch is on, and either kill switch of the environment turns it off", () => {
    expect(reviewBetsOn({})).toBe(true);
    expect(reviewBetsOn({ AI_REVIEW_BETS: "off" })).toBe(false);
    expect(reviewBetsOn({ AI_REVIEW_APPLY: "off" })).toBe(false);
  });
});

describe("sizeBets: min($2,500 ÷ equity, the model's weight of the stock), the stop at 8 %, an entry price and a decision of the day for a new entry", () => {
  const effect = (symbol: string, modelWeight: number): ReviewEffect => ({ symbol, action: "short", factor: 0, modelWeight, appliedWeight: 0 });
  const bet = (underlying: string, symbol: string) => ({ sleeve: "momentum_stocks" as const, underlying, symbol, meanConfidence: 0.8 });
  const ctx = (over: Record<string, unknown> = {}) => ({ equity: 20_000, positions: [], prices: { NVDD: 50 }, entryPriced: new Set(["NVDD"]), fresh: true, ...over }) as any;

  test("the cap binds when the model had more: $2,500 of $20,000 = 0.125", () => {
    const r = sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx());
    expect(r).toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: 0.125, modelWeight: 0.2, stopped: false }]);
  });
  test("the model's weight binds when it was smaller: the review never raises what the strategy has invested", () => {
    const r = sizeBets({ NVDA: 0.05 }, [effect("NVDA", 0.05)], [bet("NVDA", "NVDD")], ctx());
    expect(r[0].weight).toBe(0.05);
  });
  test("a stock the model did not hold (no effect) is no bet; neither is one whose effect is not a short", () => {
    expect(sizeBets({ NVDA: 0 }, [], [bet("NVDA", "NVDD")], ctx())).toEqual([]);
    expect(sizeBets({ NVDA: 0.2 }, [{ ...effect("NVDA", 0.2), action: "exit" }], [bet("NVDA", "NVDD")], ctx())).toEqual([]);
  });
  test("a bet whose fund is not the stock's fund (a tampered pair), an unknown fund, or a fund the model holds is no bet", () => {
    expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "AAPD")], ctx({ prices: { AAPD: 40 }, entryPriced: new Set(["AAPD"]) }))).toEqual([]);
    expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "ZZZZ")], ctx())).toEqual([]);
    expect(sizeBets({ NVDA: 0.2, NVDD: 0.1 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx())).toEqual([]);
  });
  test("a NEW bet needs an entry price for the fund (the engine's estimate or the venue's own fresh price): any other price is not enough", () => {
    expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ entryPriced: new Set() }))).toEqual([]);
    expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ prices: {} }))).toEqual([]);
    expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ prices: { NVDD: Number.NaN } }))).toEqual([]);
  });
  test("a bet already held keeps its size without an entry price (the sell must still be possible)", () => {
    const held = [{ symbol: "NVDD", qty: 10, avgEntryPrice: 50 }];
    const r = sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ positions: held, entryPriced: new Set() }));
    expect(r).toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: 0.125, modelWeight: 0.2, stopped: false }]);
  });
  test("a NEW bet needs a decision of this very session: an older decision that is still valid opens nothing", () => {
    expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ fresh: false }))).toEqual([]);
    expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ fresh: undefined }))).toEqual([]);   // not said = not fresh
  });
  test("a bet already held goes on under an older decision, and its stop still works there", () => {
    const held = [{ symbol: "NVDD", qty: 10, avgEntryPrice: 50 }];
    expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ positions: held, fresh: false })))
      .toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: 0.125, modelWeight: 0.2, stopped: false }]);
    expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ positions: held, fresh: false, prices: { NVDD: 46 } })))
      .toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: 0, modelWeight: 0.2, stopped: true }]);
  });
  test("the stop: 8 % or more below the average entry is stopped (weight 0), 7.9 % is kept", () => {
    const held = [{ symbol: "NVDD", qty: 10, avgEntryPrice: 100 }];
    const at = (price: number) => sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ positions: held, prices: { NVDD: price } }))[0];
    expect(at(92)).toMatchObject({ weight: 0, stopped: true, modelWeight: 0.2 });
    expect(at(80)).toMatchObject({ weight: 0, stopped: true });
    expect(at(92.1)).toMatchObject({ weight: 0.125, stopped: false });   // 7.9 %
    expect(at(110)).toMatchObject({ weight: 0.125, stopped: false });
  });
  test("a bad equity gives no bet, never a throw", () => {
    for (const equity of [0, -5, Number.NaN, Infinity]) expect(sizeBets({ NVDA: 0.2 }, [effect("NVDA", 0.2)], [bet("NVDA", "NVDD")], ctx({ equity }))).toEqual([]);
  });
  test("applyBets adds only the funds with weight above zero and never overwrites a key", () => {
    const bets = [{ underlying: "NVDA", symbol: "NVDD", weight: 0.125, modelWeight: 0.2, stopped: false }, { underlying: "AAPL", symbol: "AAPD", weight: 0, modelWeight: 0.1, stopped: true }];
    expect(applyBets({ NVDA: 0, AAPL: 0 }, bets)).toEqual({ NVDA: 0, AAPL: 0, NVDD: 0.125 });
    expect(applyBets({ NVDD: 0.01 }, bets)).toEqual({ NVDD: 0.01 });
  });
});

describe("appliedWeightsSane: the engine's last check; anything false and the pass is the model's own", () => {
  const model = { NVDA: 0.5, AAPL: 0.2 };
  const effects: ReviewEffect[] = [{ symbol: "NVDA", action: "short", factor: 0, modelWeight: 0.5, appliedWeight: 0 }];
  const bet = { underlying: "NVDA", symbol: "NVDD", weight: 0.25, modelWeight: 0.5, stopped: false };
  const good = { NVDA: 0, AAPL: 0.2, NVDD: 0.25 };
  const ok = (applied: Record<string, number>, bets = [bet], equity = 10_000, fx = effects) => appliedWeightsSane(model, applied, bets, fx, equity);

  test("the honest result passes; a stage-B result (no bets) passes by the old rule", () => {
    expect(ok(good)).toBe(true);
    expect(appliedWeightsSane(model, { NVDA: 0, AAPL: 0.1 }, [], effects, 10_000)).toBe(true);
    expect(appliedWeightsSane(model, { NVDA: 0, AAPL: 0.2, NVDD: 0.25 }, [], effects, 10_000)).toBe(false);   // a fund nobody asked for
  });
  test("a bet weight above the $2,500 cap fails (0.30 of $10,000), and so does one above the model's weight of the stock", () => {
    expect(ok({ ...good, NVDD: 0.3 }, [{ ...bet, weight: 0.3 }])).toBe(false);
    expect(appliedWeightsSane({ NVDA: 0.1, AAPL: 0.2 }, { NVDA: 0, AAPL: 0.2, NVDD: 0.12 }, [{ ...bet, weight: 0.12, modelWeight: 0.1 }], [{ ...effects[0], modelWeight: 0.1 }], 100_000)).toBe(false);
  });
  test("a fund that is not the stock's fund, an unknown fund, a fund the model holds, a zero or negative weight: all fail", () => {
    expect(ok({ NVDA: 0, AAPL: 0.2, AAPD: 0.25 }, [{ ...bet, symbol: "AAPD" }])).toBe(false);
    expect(ok({ NVDA: 0, AAPL: 0.2, ZZZZ: 0.25 }, [{ ...bet, symbol: "ZZZZ" }])).toBe(false);
    expect(appliedWeightsSane({ ...model, NVDD: 0.1 }, { NVDA: 0, AAPL: 0.2, NVDD: 0.25 }, [bet], effects, 10_000)).toBe(false);
    expect(ok({ ...good, NVDD: -0.1 }, [{ ...bet, weight: -0.1 }])).toBe(false);
    expect(ok({ NVDA: 0, AAPL: 0.2 }, [{ ...bet, weight: 0, stopped: true }])).toBe(true);                  // a stopped bet adds no key
  });
  test("a bet without an effect on its stock, a different weight in the target than in the bet, an extra key, a bad equity: all fail", () => {
    expect(ok(good, [bet], 10_000, [])).toBe(false);
    expect(ok({ ...good, NVDD: 0.2 })).toBe(false);
    expect(ok({ ...good, EXTRA: 0 })).toBe(false);
    for (const equity of [0, -1, Number.NaN]) expect(ok(good, [bet], equity)).toBe(false);
  });
  test("the total never exceeds the model's: raising a model weight, a negative one or NaN fails", () => {
    expect(ok({ NVDA: 0.5, AAPL: 0.2, NVDD: 0.25 })).toBe(false);                    // the stock was not taken out: gross above the model's
    expect(ok({ NVDA: 0, AAPL: 0.3, NVDD: 0.25 })).toBe(false);
    expect(ok({ NVDA: -0.1, AAPL: 0.2, NVDD: 0.25 })).toBe(false);
    expect(ok({ NVDA: Number.NaN, AAPL: 0.2, NVDD: 0.25 })).toBe(false);
  });
});

describe("reviewForPass and the hook carry the sleeve's bets, re-validated on read", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ai-review-bets-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (overrides: Override[], session = "2026-11-16") => {
    mkdirSync(dir, { recursive: true });
    const d = sealDecision(baseDecision({ session, decidedAt: `${session}T13:15:00.000Z`, overrides }));
    writeFileSync(join(dir, `${session}.json`), JSON.stringify(d));
    return d;
  };
  const get = (sleeve: SleeveId, universe: readonly string[], on = true, applies: Record<SleeveId, boolean> = { ...BOTH }) =>
    reviewForPass({ dir, sleeve, session: "2026-11-16", universe, bets: { applies, on } });

  test("no `bets` unless asked, and none with the switch off: the result is stage B's", () => {
    put([short("NVDA")]);
    expect(reviewForPass({ dir, sleeve: "momentum_stocks", session: "2026-11-16", universe: MOMENTUM })!.bets).toBeUndefined();
    expect(get("momentum_stocks", MOMENTUM, false)!.bets).toBeUndefined();
    expect(get("momentum_stocks", MOMENTUM)!.bets).toEqual([{ sleeve: "momentum_stocks", underlying: "NVDA", symbol: "NVDD", meanConfidence: 0.8 }]);
  });
  test("the cap is over both sleeves: the better two, each sleeve gets its own", () => {
    put([short("NVDA", 0.7), short("AAPL", 0.75), short("AVGO", 0.9, "meanrev_stocks"), short("NFLX", 0.65, "meanrev_stocks")]);
    expect(get("momentum_stocks", MOMENTUM)!.bets!.map(b => b.underlying)).toEqual(["AAPL"]);
    expect(get("meanrev_stocks", MEANREV)!.bets!.map(b => b.underlying)).toEqual(["AVGO"]);
  });
  test("the other sleeve's claim on a stock of MY universe is not counted (it cannot take a slot from a real bet)", () => {
    put([short("NVDA", 0.99, "meanrev_stocks"), short("AAPL", 0.7), short("MSFT", 0.65)]);
    expect(get("momentum_stocks", MOMENTUM)!.bets!.map(b => b.underlying)).toEqual(["AAPL", "MSFT"]);
  });
  test("a bet on a stock outside my universe is not mine (the sleeve claims what is not its own)", () => {
    put([short("AVGO", 0.9)]);               // momentum claims AVGO, a meanrev stock
    expect(get("momentum_stocks", MOMENTUM)!.overrides).toEqual([]);
    expect(get("momentum_stocks", MOMENTUM)!.bets).toEqual([]);
  });
  test("a decision that is not a short of a stock with a fund has no bets, and an unreadable one is null", () => {
    put([exit("NVDA"), short("IWM")]);
    expect(get("momentum_stocks", MOMENTUM)!.bets).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
    expect(get("momentum_stocks", MOMENTUM)).toBeNull();
  });
  test("aiReviewHook: betsOn follows the flag and the kill switches; forPass hands the bets only when it is on", () => {
    put([short("NVDA")]);
    const table = { momentum_stocks: true, meanrev_stocks: true };
    const off = aiReviewHook("momentum_stocks", { dir, env: {}, table, bets: false });
    expect(off.betsOn!()).toBe(false);
    expect(off.forPass("2026-11-16", MOMENTUM)!.bets).toBeUndefined();
    expect(aiReviewHook("momentum_stocks", { dir, env: {}, table }).betsOn!()).toBe(true);   // no flag given: the real switch
    const on = aiReviewHook("momentum_stocks", { dir, env: {}, table, bets: true });
    expect(on.betsOn!()).toBe(true);
    expect(on.forPass("2026-11-16", MOMENTUM)!.bets!.map(b => b.symbol)).toEqual(["NVDD"]);
    expect(aiReviewHook("momentum_stocks", { dir, env: { AI_REVIEW_APPLY: "off" }, table, bets: true }).betsOn!()).toBe(false);
    expect(aiReviewHook("momentum_stocks", { dir, env: { AI_REVIEW_BETS: "off" }, table, bets: true }).betsOn!()).toBe(false);
    // a sleeve whose switch is off places no bet
    const mom = aiReviewHook("momentum_stocks", { dir, env: {}, table: { momentum_stocks: false, meanrev_stocks: true }, bets: true });
    expect(mom.forPass("2026-11-16", MOMENTUM)!.bets).toEqual([]);
  });
});

describe("what the journal keeps of a bet", () => {
  const bet = { underlying: "NVDA", symbol: "NVDD", weight: 0.125, modelWeight: 0.2, stopped: false };
  const review = { decisionId: "abc123def456", decisionSession: "2026-11-16", applied: true,
    effects: [{ symbol: "NVDA", action: "short", factor: 0, modelWeight: 0.2, appliedWeight: 0 }], modelWeights: { NVDA: 0.2 }, bets: [bet] };
  test("readJournaledReview reads the bets strictly; a malformed one reads as no review", () => {
    expect(readJournaledReview({ aiReview: review })).toEqual(review as any);
    expect(readJournaledReview({ aiReview: { ...review, bets: undefined } })!.bets).toBeUndefined();
    for (const bad of [{ ...bet, weight: -1 }, { ...bet, symbol: 5 }, { ...bet, stopped: "no" }, { ...bet, modelWeight: "x" }, null]) {
      expect(readJournaledReview({ aiReview: { ...review, bets: [bad] } })).toBeNull();
    }
    expect(readJournaledReview({ aiReview: { ...review, bets: "yes" } })).toBeNull();
  });
  test("modelWeightsOfJournal puts the underlying back to the model's and drops the fund (it was never the model's)", () => {
    expect(modelWeightsOfJournal({ NVDA: 0, NVDD: 0.125, AAPL: 0.1 }, { aiReview: review })).toEqual({ NVDA: 0.2, AAPL: 0.1 });
  });
});
