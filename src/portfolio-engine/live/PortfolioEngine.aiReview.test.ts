// AI review, stage B, in the live stock engine (docs/reports/IA-revision-de-noticias-2026-11-14.md §3.4).
// The review is a FAIL-OPEN modifier of the target between decide() and planOrders(): with the switch off,
// with no/invalid/expired decision, or with any exception, the pass is byte-for-byte what it was without it.
// Fake venue, in-memory trading DB and historical.db, real decision files in a temp inbox. No broker, no network.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDB, PORTFOLIO_ENGINE_STRATEGY } from "../../db/database";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { PortfolioEngine, type PortfolioEngineOptions } from "./PortfolioEngine";
import { HistoricalPriceView } from "./priceView";
import { getPortfolioDecision } from "./persistence";
import { loadSleeveRows } from "./rows";
import { FakeVenue, XASSET, fixedDecide, makeHistDb, weekdaySessions } from "./testSupport";
import { decide as coreDecide } from "../decide";
import type { VolManagedConfig, XassetTrendConfig } from "../types";
import { aiReviewHook, type AiReviewHook } from "../../ai-review/apply";
import { FACTOR } from "../../ai-review/limits";
import { sealDecision, type Override, type SleeveId } from "../../ai-review/contract";
import { baseDecision } from "../../ai-review/testFixtures";

const SLEEVE = "momentum_stocks";
const VERSION = "d1-xasset-v1";
const AS_OF = "2026-10-19";    // Monday
const SESSION = "2026-10-20";  // Tuesday
const WINDOW = { session: SESSION, asOf: AS_OF };
const NOW = Date.parse("2026-10-20T14:00:00Z"); // 10:00 ET
const NEXT = { session: "2026-10-21", asOf: SESSION };

const volCfg: VolManagedConfig = { kind: "volManaged", universe: ["SPY"], inceptionGuardBars: 20, volLookback: 20, covLookback: 20,
  portfolioVolTarget: 0.15, annualization: 252, perAssetCap: 1, maxGross: 1, maxHoldSessions: 5, maxHoldStagger: true };

function histDb(last = AS_OF, symbols: readonly string[] = XASSET.universe) {
  const sessions = weekdaySessions(last, 300);
  return makeHistDb(Object.fromEntries(symbols.map(s => [s, { sessions }])));
}

let inbox: string;
beforeAll(() => { makeTestDb(); });
beforeEach(() => {
  getDB().exec("DELETE FROM trade_realized_legs; DELETE FROM trades; DELETE FROM portfolio_decisions; DELETE FROM activity_log; DELETE FROM decision_passes;");
  inbox = mkdtempSync(join(tmpdir(), "ai-review-engine-"));
});
afterEach(() => rmSync(inbox, { recursive: true, force: true }));

const ov = (symbol: string, action: "reduce" | "exit" | "short" = "exit", over: Partial<Override> = {}, sleeve: SleeveId = SLEEVE): Override => ({
  sleeve, symbol, action, factor: FACTOR[action], meanConfidence: 0.8,
  votes: [{ family: "claude", action, confidence: 0.8 }, { family: "gpt", action, confidence: 0.8 }],
  reason: `Motivo de ${symbol}.`, sources: ["https://news.example/a"], ...over,
});
function put(session: string, overrides: Override[], dir = inbox) {
  const d = sealDecision(baseDecision({ session, decidedAt: `${session}T13:15:00.000Z`, overrides }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.json`), JSON.stringify(d));
  return d;
}
const hookOf = (on: boolean, sleeve: SleeveId = SLEEVE, env: Record<string, string | undefined> = {}): AiReviewHook =>
  aiReviewHook(sleeve, { dir: inbox, env, table: { momentum_stocks: on, meanrev_stocks: on } });

function engine(venue: FakeVenue, over: Partial<PortfolioEngineOptions> = {}, db = histDb()) {
  const alerts: string[] = [];
  const e = new PortfolioEngine({
    accountId: SLEEVE, strategyVersion: VERSION, config: XASSET, capital: 10_000,
    market: "stocks", rowMarket: "stock", quoteAsset: "USD", venue, mode: "live",
    openPriceView: (asOf, symbols) => new HistoricalPriceView({ db, asOf, symbols }),
    decide: fixedDecide({ SPY: 0.5, TLT: 0.3 }),
    now: () => NOW, tradingEnabled: () => true, alert: (_c, m) => alerts.push(m),
    heartbeats: { register: () => {}, beat: () => {} },
    ...over,
  });
  return Object.assign(e, { alerts });
}
const rowOf = (symbol: string, account = SLEEVE) =>
  getDB().prepare(`SELECT * FROM trades WHERE account_id = ? AND symbol = ? ORDER BY entry_time DESC LIMIT 1`).get(account, symbol) as any;
const journal = (account = SLEEVE, session = SESSION) => getPortfolioDecision(account, VERSION, session)!;
const book = (account = SLEEVE) => getDB().prepare(`SELECT symbol, status, quantity, entry_price, pnl, close_reason, partial_realized_native
  FROM trades WHERE account_id = ? ORDER BY symbol, entry_time, id`).all(account);

/** Seed the sleeve with SPY 10 @500 (target 0.5 of 10 000) and TLT 20 @90 (target 0.3 → 33.3: underweight). */
function seedBook(venue: FakeVenue) {
  seedOpenTrade("pf_spy", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 10 });
  seedOpenTrade("pf_tlt", SLEEVE, { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 90, quantity: 20 });
  venue.positions_ = [{ symbol: "SPY", qty: 10, avgEntryPrice: 500 }, { symbol: "TLT", qty: 20, avgEntryPrice: 90 }];
  venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
}
const freshVenue = () => { const v = new FakeVenue(); seedBook(v); return v; };

/** Everything the pass leaves behind that the review must not change when it does not apply. */
function footprint(venue: FakeVenue, account = SLEEVE) {
  const dec = journal(account);
  return JSON.stringify({ submits: venue.submits, weights: dec.weights, orders: dec.orders, stops: dec.stops, memory: dec.memory, status: dec.status, book: book(account) });
}
async function baseline(over: Partial<PortfolioEngineOptions> = {}, db = histDb(), setup: (v: FakeVenue) => void = seedBook) {
  const v = new FakeVenue(); setup(v);
  await engine(v, over, db).runSession(WINDOW);
  const fp = footprint(v);
  getDB().exec("DELETE FROM trade_realized_legs; DELETE FROM trades; DELETE FROM portfolio_decisions; DELETE FROM decision_passes;");
  return fp;
}

describe("switch OFF: the pass is exactly what it was, and the journal records what the review would have done", () => {
  test("plan, orders, rows and journal weights are byte-identical; diagnostics.aiReview.applied === false with the hypothetical effects", async () => {
    const base = await baseline();
    put(SESSION, [ov("SPY", "exit"), ov("TLT", "reduce")]);
    const venue = freshVenue();
    await engine(venue, { aiReview: hookOf(false) }).runSession(WINDOW);
    expect(footprint(venue)).toBe(base);
    const dec = journal();
    expect(dec.weights).toEqual({ SPY: 0.5, TLT: 0.3 });
    const d = dec.diagnostics as any;
    expect(d.aiReview).toEqual({
      decisionId: expect.stringMatching(/^[0-9a-f]{12}$/), decisionSession: SESSION, applied: false,
      effects: [
        { symbol: "SPY", action: "exit", factor: 0, modelWeight: 0.5, appliedWeight: 0 },
        { symbol: "TLT", action: "reduce", factor: 0.5, modelWeight: 0.3, appliedWeight: 0.15 },
      ],
    });
    expect(d.aiReview).not.toHaveProperty("modelWeights");
    expect(dec.orders.some(o => o.label === "ai_review_sell")).toBe(false);
    expect(rowOf("SPY").status).toBe("open");
  });

  test("the real switch table is OFF for both sleeves in what is delivered, and the kill switch beats a flipped table", async () => {
    const { AI_REVIEW_APPLY, reviewApplies } = await import("../../ai-review/apply");
    expect(AI_REVIEW_APPLY).toEqual({ momentum_stocks: false, meanrev_stocks: false });
    expect(reviewApplies("momentum_stocks", {})).toBe(false);
    expect(reviewApplies("meanrev_stocks", { AI_REVIEW_APPLY: "off" })).toBe(false);
    const on = { momentum_stocks: true, meanrev_stocks: true };
    expect(reviewApplies("momentum_stocks", {}, on)).toBe(true);
    expect(reviewApplies("momentum_stocks", { AI_REVIEW_APPLY: "off" }, on)).toBe(false);
    expect(reviewApplies("momentum_stocks", { AI_REVIEW_APPLY: " OFF " }, on)).toBe(false);
    expect(reviewApplies("momentum_crypto", {}, on)).toBe(false);
  });
});

describe("switch ON", () => {
  test("exit: the held symbol is sold in full at this pass (ai_review_sell), the row closes AI_REVIEW_EXIT, no other order changes, nothing is bought with the freed cash", async () => {
    const base = JSON.parse(await baseline());
    expect(base.submits.map((s: any) => `${s.order.side}:${s.order.symbol}`)).toEqual(["buy:TLT"]); // TLT is underweight; SPY at target
    put(SESSION, [ov("SPY", "exit")]);
    const venue = freshVenue();
    const rep = await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual([`sell:SPY:10`, `buy:TLT:${base.submits[0].order.qty}`]);
    expect(venue.submits[0].order).toMatchObject({ reduceOnly: true, targetWeight: 0, currentWeight: 0.5 });
    expect(venue.submits[1]).toEqual(base.submits[0]); // the TLT buy is the baseline's, identical down to its client id
    expect(rowOf("SPY")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });
    expect(rowOf("SPY").pnl).toBeCloseTo(0, 9);
    const dec = journal();
    expect(dec.orders.map(o => [o.intent.symbol, o.label])).toEqual([["SPY", "ai_review_sell"], ["TLT", "rebalance_buy"]]);
    expect(dec.weights).toEqual({ SPY: 0, TLT: 0.3 });       // what the bot aims at: G9 and every reader see this
    expect((dec.diagnostics as any).aiReview).toMatchObject({
      applied: true, decisionSession: SESSION, modelWeights: { SPY: 0.5 },
      effects: [{ symbol: "SPY", action: "exit", factor: 0, modelWeight: 0.5, appliedWeight: 0 }],
    });
    expect(dec.orders.every(o => o.applied)).toBe(true);
  });

  test("a symbol the model does not hold in this pass is a no-op and leaves no trace", async () => {
    put(SESSION, [ov("GLD", "exit")]);                       // in the universe, but the model's weights have no GLD
    const base = await baseline();
    put(SESSION, [ov("GLD", "exit")]);
    const venue = freshVenue();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(footprint(venue)).toBe(base);
    expect((journal().diagnostics as any).aiReview).toBeUndefined();
  });

  test("exit on a symbol not held yet: it is simply not bought; the other buys are the baseline's", async () => {
    const empty = (v: FakeVenue) => { v.prices_ = { SPY: 500, TLT: 90, GLD: 200 }; };
    const base = JSON.parse(await baseline({}, histDb(), empty));
    put(SESSION, [ov("SPY", "exit")]);
    const venue = new FakeVenue(); empty(venue);
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(venue.submits.map(s => s.order.symbol)).toEqual(["TLT"]);
    expect(venue.submits[0]).toEqual(base.submits.find((s: any) => s.order.symbol === "TLT"));
    expect(loadSleeveRows(SLEEVE).map(r => r.symbol)).toEqual(["TLT"]);
  });

  test("reduce: half is sold as a trim and the row stays open", async () => {
    put(SESSION, [ov("SPY", "reduce")]);
    const venue = freshVenue();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    const sell = venue.submits.find(s => s.order.side === "sell")!;
    expect(sell.order).toMatchObject({ symbol: "SPY", qty: 5, targetWeight: 0.25 });
    const r = rowOf("SPY");
    expect(r).toMatchObject({ status: "open", quantity: 5, close_reason: null });
    expect(r.partial_realized_native).toBeCloseTo(0, 9);
    expect(journal().weights).toEqual({ SPY: 0.25, TLT: 0.3 });
    expect(journal().orders.find(o => o.intent.symbol === "SPY")!.label).toBe("ai_review_sell");
    expect((journal().diagnostics as any).aiReview.modelWeights).toEqual({ SPY: 0.5 });
  });

  test("the next session without an override: the model's weight returns and the symbol is bought back as an ordinary rebalance buy", async () => {
    put(SESSION, [ov("SPY", "exit")]);
    const venue = freshVenue();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(rowOf("SPY").status).toBe("closed");
    put(NEXT.session, []);                                   // the next morning's decision lifts the override
    const e2 = engine(venue, { aiReview: hookOf(true), now: () => NOW + 86_400_000 }, histDb(SESSION));
    const rep = await e2.runSession(NEXT);
    expect(rep.status).toBe("submitted");
    const buy = rep.orders.find(o => o.intent.symbol === "SPY")!;
    expect(buy).toMatchObject({ label: "rebalance_buy", applied: true });
    expect(buy.intent).toMatchObject({ side: "buy", targetWeight: 0.5 });
    expect(buy.intent.maxHold).toBeUndefined();
    expect(getPortfolioDecision(SLEEVE, VERSION, NEXT.session)!.weights).toEqual({ SPY: 0.5, TLT: 0.3 });
    expect((getPortfolioDecision(SLEEVE, VERSION, NEXT.session)!.diagnostics as any).aiReview).toBeUndefined();
  });

  test("a decision stays in force for its 5 sessions when no newer one arrives: the second morning also keeps the symbol out", async () => {
    put(SESSION, [ov("SPY", "exit")]);
    const venue = freshVenue();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    const rep = await engine(venue, { aiReview: hookOf(true), now: () => NOW + 86_400_000 }, histDb(SESSION)).runSession(NEXT);
    expect(rep.orders.filter(o => o.intent.symbol === "SPY")).toEqual([]);
    expect(getPortfolioDecision(SLEEVE, VERSION, NEXT.session)!.weights).toEqual({ SPY: 0, TLT: 0.3 });
  });

  test("a resumed pass finishes with the journaled label and close reason, even if the decision file is gone", async () => {
    put(SESSION, [ov("SPY", "exit")]);
    const venue = freshVenue();
    venue.behavior.SPY = { kind: "throw", error: "socket hang up" };
    expect((await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW)).status).toBe("failed");
    expect(journal().status).toBe("decided");
    expect(journal().orders[0]).toMatchObject({ label: "ai_review_sell", applied: false });
    rmSync(inbox, { recursive: true, force: true });         // resume reads the journal, not the inbox
    venue.behavior = {};
    const rep = await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(rep.status).toBe("resumed");
    expect(rowOf("SPY")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });
    expect(venue.submits.filter(s => s.order.symbol === "SPY").map(s => s.clientOrderId)).toHaveLength(2);
    expect(new Set(venue.submits.filter(s => s.order.symbol === "SPY").map(s => s.clientOrderId)).size).toBe(1);
  });

  test("tick(): the heartbeat beats on a pass with the review applied", async () => {
    put(SESSION, [ov("SPY", "exit")]);
    const beats: string[] = [];
    const e = engine(freshVenue(), { aiReview: hookOf(true), heartbeats: { register: () => {}, beat: n => beats.push(n) } });
    expect((await e.tick()).status).toBe("submitted");
    expect(beats).toEqual(["portfolio:momentum_stocks"]);
  });
});

describe("a lot at its 5-session limit", () => {
  const entry = Date.parse("2026-10-12T14:00:00Z");
  function expired() {
    seedOpenTrade("lot", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 4, entryTime: entry });
    const v = new FakeVenue();
    v.positions_ = [{ symbol: "SPY", qty: 4, avgEntryPrice: 500 }];
    v.prices_ = { SPY: 510 };
    return v;
  }
  const opts = (over: Partial<PortfolioEngineOptions> = {}): Partial<PortfolioEngineOptions> => ({ config: volCfg, decide: coreDecide, ...over });
  const db = () => histDb(AS_OF, ["SPY"]);

  test("exit: the MAX_HOLD close keeps its label and reason, and there is NO rebuy", async () => {
    const v0 = expired();
    await engine(v0, opts(), db()).runSession(WINDOW);
    const baseBuy = v0.submits.find(s => s.order.side === "buy")!;
    expect(baseBuy).toBeTruthy();                            // without the review the lot is closed and bought back
    getDB().exec("DELETE FROM trade_realized_legs; DELETE FROM trades; DELETE FROM portfolio_decisions;");
    put(SESSION, [ov("SPY", "exit")]);
    const venue = expired();
    await engine(venue, opts({ aiReview: hookOf(true) }), db()).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.maxHold}`)).toEqual(["sell:close"]);
    expect(rowOf("SPY")).toMatchObject({ status: "closed", close_reason: "MAX_HOLD" });
    const dec = journal();
    expect(dec.orders.map(o => o.label)).toEqual(["max_hold_close"]);
    expect(dec.orders[0].intent).toMatchObject({ maxHold: "close", targetWeight: 0 });
    expect((dec.diagnostics as any).aiReview).toMatchObject({ applied: true, effects: [{ symbol: "SPY", action: "exit", appliedWeight: 0 }] });
    expect(dec.weights.SPY).toBe(0);
  });

  test("reduce: close (MAX_HOLD) and a rebuy of HALF the model's rebuy", async () => {
    const v0 = expired();
    await engine(v0, opts(), db()).runSession(WINDOW);
    const baseQty = v0.submits.find(s => s.order.side === "buy")!.order.qty;
    getDB().exec("DELETE FROM trade_realized_legs; DELETE FROM trades; DELETE FROM portfolio_decisions;");
    put(SESSION, [ov("SPY", "reduce")]);
    const venue = expired();
    await engine(venue, opts({ aiReview: hookOf(true) }), db()).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.maxHold}`)).toEqual(["sell:close", "buy:rebuy"]);
    expect(venue.submits[1].order.qty).toBeCloseTo(baseQty / 2, 9);
    expect(journal().orders.map(o => o.label)).toEqual(["max_hold_close", "max_hold_rebuy"]);
    expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'lot'").get()).toEqual({ status: "closed", close_reason: "MAX_HOLD" });
    expect(rowOf("SPY")).toMatchObject({ status: "open", entry_time: NOW });
  });

  test("a partial MAX_HOLD close still gets its -r1 retry with the review applied; the retry keeps its label", async () => {
    put(SESSION, [ov("SPY", "reduce")]);
    const venue = expired();
    venue.behavior.SPY = { kind: "partial", fraction: 0.5 };
    await engine(venue, opts({ aiReview: hookOf(true) }), db()).runSession(WINDOW);
    const dec = journal();
    expect(dec.orders.map(o => o.label).slice(0, 2)).toEqual(["max_hold_close", "retry"]);
    expect(dec.orders[1].clientOrderId!.endsWith("-r1")).toBe(true);
  });

  test("a stale-data pass ignores the review entirely (closes only, the hook is never asked)", async () => {
    put(SESSION, [ov("SPY", "exit")]);
    let asked = 0;
    const hook: AiReviewHook = { forPass: () => { asked++; return null; }, applies: () => true };
    const venue = expired();
    const rep = await engine(venue, opts({ aiReview: hook }), histDb("2026-10-16", ["SPY"])).runSession(WINDOW);
    expect(rep.status).toBe("skipped_stale");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.maxHold}`)).toEqual(["sell:close"]);
    expect(rowOf("SPY")).toMatchObject({ status: "closed", close_reason: "MAX_HOLD" });
    expect(asked).toBe(0);
    expect(journal().diagnostics).not.toHaveProperty("aiReview");
    // fresh data later in the same session: the normal pass runs and only THEN is the review consulted
    await engine(venue, opts({ aiReview: hookOf(true) }), db()).runSession(WINDOW);
    expect(journal().status).toBe("submitted");
    expect(venue.submits.filter(s => s.order.side === "buy")).toEqual([]);
  });
});

describe("RiskEngine gate", () => {
  for (const state of ["HALTED", "REDUCING"] as const) test(`${state} with an exit override: the sell goes, every buy is skipped with its own code`, async () => {
    put(SESSION, [ov("SPY", "exit")]);
    const venue = freshVenue();
    const rep = await engine(venue, { aiReview: hookOf(true), tradingState: () => state }).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:SPY"]);
    const code = state === "HALTED" ? "risk_engine_halted" : "risk_engine_reducing";
    expect(rep.orders.filter(o => o.intent.side === "buy").map(o => o.skipped)).toEqual([code]);
    expect(rowOf("SPY")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });
  });
});

describe("limits the review can never pass", () => {
  const SYMS = Array.from({ length: 8 }, (_, i) => `S${i + 1}`);
  const wide = (): XassetTrendConfig => ({ ...XASSET, universe: SYMS });
  const weights = Object.fromEntries(SYMS.map(s => [s, 0.1]));
  const wideVenue = () => { const v = new FakeVenue(); v.prices_ = Object.fromEntries(SYMS.map(s => [s, 100])); return v; };
  const conf = (i: number) => 0.9 - i * 0.02;
  const many = (sleeve: SleeveId) => SYMS.map((s, i) => ov(s, "exit", { meanConfidence: conf(i), votes: [{ family: "claude", action: "exit", confidence: conf(i) }, { family: "gpt", action: "exit", confidence: conf(i) }] }, sleeve));

  test("momentum: at most 3 names even if the file lists 8 (the most confident), the rest untouched", async () => {
    put(SESSION, many("momentum_stocks"));
    const venue = wideVenue();
    await engine(venue, { config: wide(), decide: fixedDecide(weights), aiReview: hookOf(true) }, histDb(AS_OF, SYMS)).runSession(WINDOW);
    const w = journal().weights;
    expect(SYMS.filter(s => w[s] === 0)).toEqual(["S1", "S2", "S3"]);
    expect(SYMS.filter(s => w[s] === 0.1)).toHaveLength(5);
    expect((journal().diagnostics as any).aiReview.effects).toHaveLength(3);
  });

  test("meanrev: at most 6 names", async () => {
    put(SESSION, many("meanrev_stocks"));
    const venue = wideVenue();
    await engine(venue, { accountId: "meanrev_stocks", config: wide(), decide: fixedDecide(weights), aiReview: hookOf(true, "meanrev_stocks") }, histDb(AS_OF, SYMS)).runSession(WINDOW);
    const w = journal("meanrev_stocks").weights;
    expect(SYMS.filter(s => w[s] === 0)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    expect((journal("meanrev_stocks").diagnostics as any).aiReview.effects).toHaveLength(6);
  });

  test("a decision of the OTHER sleeve is not applied here", async () => {
    put(SESSION, [ov("SPY", "exit", {}, "meanrev_stocks")]);
    const base = await baseline();
    put(SESSION, [ov("SPY", "exit", {}, "meanrev_stocks")]);
    const venue = freshVenue();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(footprint(venue)).toBe(base);
  });

  test("symbols outside the sleeve's own universe (SH, the other sleeve's names) are ignored", async () => {
    const base = await baseline();
    put(SESSION, [ov("SH", "exit"), ov("NVDA", "exit"), ov("ABBV", "reduce")]);
    const venue = freshVenue();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(footprint(venue)).toBe(base);
    expect((journal().diagnostics as any).aiReview).toBeUndefined();
  });

  test("a factor above 1 or below 0 in the file never raises a weight: the file is refused, the pass is the baseline", async () => {
    const base = await baseline();
    for (const factor of [1.5, -1]) {
      put(SESSION, [ov("SPY", "exit", { factor })]);
      const venue = freshVenue();
      await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
      expect(footprint(venue)).toBe(base);
      getDB().exec("DELETE FROM trade_realized_legs; DELETE FROM trades; DELETE FROM portfolio_decisions; DELETE FROM decision_passes;");
    }
  });

  test("a hook that hands the engine out-of-range factors (7, NaN) cannot raise or invert a weight: no effect, the model's own pass", async () => {
    const base = await baseline();
    const hook: AiReviewHook = {
      forPass: () => ({ decisionId: "abc", decisionSession: SESSION, overrides: [
        { ...ov("SPY", "exit"), factor: 7 }, { ...ov("TLT", "reduce"), factor: Number.NaN },
      ] }),
      applies: () => true,
    };
    const venue = freshVenue();
    await engine(venue, { aiReview: hook }).runSession(WINDOW);
    expect(footprint(venue)).toBe(base);
  });
});

describe("fail-open: whatever goes wrong with the review, the pass equals the baseline and completes", () => {
  const cases: Array<[string, () => AiReviewHook | undefined]> = [
    ["no inbox directory", () => aiReviewHook(SLEEVE, { dir: join(inbox, "missing"), env: {}, table: { momentum_stocks: true, meanrev_stocks: true } })],
    ["an empty inbox", () => { mkdirSync(inbox, { recursive: true }); return hookOf(true); }],
    ["a corrupt file", () => { writeFileSync(join(inbox, `${SESSION}.json`), "{ not json"); return hookOf(true); }],
    ["a truncated half-transfer only", () => { writeFileSync(join(inbox, `${SESSION}.json.tmp`), JSON.stringify(sealDecision(baseDecision({ session: SESSION, overrides: [ov("SPY")] })))); return hookOf(true); }],
    ["a decision older than 5 sessions", () => { put("2026-10-12", [ov("SPY")]); return hookOf(true); }],
    ["a decision for a later session", () => { put("2026-10-21", [ov("SPY")]); return hookOf(true); }],
    ["a tampered decision (its id no longer matches)", () => {
      const d = sealDecision(baseDecision({ session: SESSION, overrides: [ov("SPY")] }));
      writeFileSync(join(inbox, `${SESSION}.json`), JSON.stringify({ ...d, reviewed: 7 })); return hookOf(true);
    }],
    ["a decision with no overrides", () => { put(SESSION, []); return hookOf(true); }],
    ["a reviewForPass that throws", () => ({ forPass: () => { throw new Error("disk on fire"); }, applies: () => true })],
    ["a switch reader that throws", () => { put(SESSION, [ov("SPY")]); return { forPass: hookOf(true).forPass, applies: () => { throw new Error("env gone"); } }; }],
    ["no hook at all", () => undefined],
  ];
  for (const [name, make] of cases) test(name, async () => {
    const base = await baseline();
    const hook = make();
    const venue = freshVenue();
    const rep = await engine(venue, hook ? { aiReview: hook } : {}).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(footprint(venue)).toBe(base);
    expect(journal().diagnostics).not.toHaveProperty("aiReview");
  });

  test("the kill switch env: the pass equals the baseline (the review only records what it would have done)", async () => {
    const base = await baseline();
    put(SESSION, [ov("SPY", "exit")]);
    const venue = freshVenue();
    await engine(venue, { aiReview: hookOf(true, SLEEVE, { AI_REVIEW_APPLY: "off" }) }).runSession(WINDOW);
    expect(footprint(venue)).toBe(base);
    expect((journal().diagnostics as any).aiReview).toMatchObject({ applied: false, effects: [{ symbol: "SPY", action: "exit" }] });
  });
});

describe("observers and the crypto engines never call the review", () => {
  const spy = () => { const calls: string[] = []; const hook: AiReviewHook = { forPass: s => { calls.push(s); return null; }, applies: () => { calls.push("applies"); return true; } }; return { calls, hook }; };

  test("observer mode", async () => {
    put(SESSION, [ov("SPY", "exit")]);
    const { calls, hook } = spy();
    const venue = freshVenue();
    const rep = await engine(venue, { mode: "observer", strategyVersion: "d1-observer", aiReview: hook }).runSession(WINDOW);
    expect(rep.status).toBe("observed");
    expect(calls).toEqual([]);
    expect(venue.submits).toHaveLength(0);
    const rec = getPortfolioDecision(SLEEVE, "d1-observer", SESSION)!;
    expect(rec.weights).toEqual({ SPY: 0.5, TLT: 0.3 });
    expect(rec.diagnostics).not.toHaveProperty("aiReview");
  });

  test("a crypto engine, even live and even with a hook handed to it", async () => {
    put(SESSION, [ov("BTC", "exit")]);
    const { calls, hook } = spy();
    const venue = new FakeVenue("binance_usdm");
    venue.prices_ = { BTC: 60_000, ETH: 3_000 };
    const cfg = { ...XASSET, universe: ["BTC", "ETH"] };
    const db = makeHistDb({ BTC: { sessions: weekdaySessions(AS_OF, 300) }, ETH: { sessions: weekdaySessions(AS_OF, 300) } }, 0);
    const rep = await engine(venue, { config: cfg, market: "crypto", rowMarket: "crypto", quoteAsset: "USDT", decide: fixedDecide({ BTC: 0.5, ETH: 0.3 }), aiReview: hook }, db).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(calls).toEqual([]);
    expect(journal().weights).toEqual({ BTC: 0.5, ETH: 0.3 });
  });
});
