// AI review, stage C, in the live stock engine: a `short` verdict becomes a BET, a long position in the stock's 1x inverse fund
// (docs/reports/IA-revision-de-noticias-2026-11-14.md, amendment 2026-11-14, point 3). The engine keeps decide() and planOrders() as they
// are: the fund's weight is added to the target between them, sized min($2,500 ÷ equity, the model's weight of the stock), stopped at 8 %,
// and it ends when the decision stops asking. With the bets switch OFF the pass is stage B's, byte for byte.
// Fake venue, in-memory trading DB and historical.db, real decision files in a temp inbox. No broker, no network.

import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDB, PORTFOLIO_ENGINE_STRATEGY } from "../../db/database";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { PortfolioEngine, type PortfolioEngineOptions } from "./PortfolioEngine";
import { HistoricalPriceView } from "./priceView";
import { getPortfolioDecision } from "./persistence";
import { FakeVenue, XASSET, fixedDecide, makeHistDb, weekdaySessions } from "./testSupport";
import { decide as coreDecide, type CoreDecideInput } from "../decide";
import { planOrders as corePlanOrders } from "../orders";
import type { VolManagedConfig, XassetTrendConfig } from "../types";
import * as applyModule from "../../ai-review/apply";
import { aiReviewHook, type AiReviewHook } from "../../ai-review/apply";
import { FACTOR } from "../../ai-review/limits";
import { sealDecision, type Override, type SleeveId } from "../../ai-review/contract";
import { baseDecision } from "../../ai-review/testFixtures";
import { builtinPortfolio } from "../../portfolios/builtin";

const SLEEVE = "momentum_stocks";
const MEANREV = "meanrev_stocks";
const VERSION = "d1-xasset-v1";
const AS_OF = "2026-10-19";    // Monday
const SESSION = "2026-10-20";  // Tuesday
const WINDOW = { session: SESSION, asOf: AS_OF };
const NOW = Date.parse("2026-10-20T14:00:00Z"); // 10:00 ET
const NEXT = { session: "2026-10-21", asOf: SESSION };
const DAY = 86_400_000;

const UNI = ["NVDA", "AAPL", "MSFT", "META", "KO", "IWM"];
const UNI_MR = ["AVGO", "NFLX", "ORCL", "KO2"];
const PRICES: Record<string, number> = { NVDA: 500, AAPL: 200, MSFT: 400, META: 600, KO: 60, IWM: 200, AVGO: 300, NFLX: 100, ORCL: 150, KO2: 60,
  NVDD: 25, AAPD: 40, MSFD: 30, METD: 37.5, AVS: 50, NFXS: 20, ORCS: 30 };
const cfg = (universe: string[]): XassetTrendConfig => ({ ...XASSET, universe });
const volCfg = (universe: string[]): VolManagedConfig => ({ kind: "volManaged", universe, inceptionGuardBars: 20, volLookback: 20, covLookback: 20,
  portfolioVolTarget: 0.15, annualization: 252, perAssetCap: 1, maxGross: 1, maxHoldSessions: 5, maxHoldStagger: true });

function histDb(last = AS_OF, symbols: readonly string[] = UNI) {
  const sessions = weekdaySessions(last, 300);
  return makeHistDb(Object.fromEntries(symbols.map(s => [s, { sessions }])));
}

/** historical.db up to `AS_OF` where these symbols close at these prices (flat), the rest of the universe at its default. */
function closesDb(closes: Record<string, number>, universe: readonly string[] = UNI) {
  const sessions = weekdaySessions(AS_OF, 300);
  return makeHistDb(Object.fromEntries([...new Set([...universe, ...Object.keys(closes)])].map(s => [s, { sessions, ...(closes[s] !== undefined ? { close: () => closes[s] } : {}) }])));
}

let inbox: string;
beforeAll(() => { makeTestDb(); });
const wipe = () => getDB().exec("DELETE FROM trade_realized_legs; DELETE FROM trades; DELETE FROM portfolio_decisions; DELETE FROM activity_log; DELETE FROM decision_passes;");
beforeEach(() => { wipe(); inbox = mkdtempSync(join(tmpdir(), "ai-review-bets-engine-")); });
afterEach(() => rmSync(inbox, { recursive: true, force: true }));

const short = (symbol: string, meanConfidence = 0.8, sleeve: SleeveId = SLEEVE): Override => ({
  sleeve, symbol, action: "short", factor: FACTOR.short, meanConfidence,
  votes: [{ family: "claude", action: "short", confidence: meanConfidence }, { family: "gpt", action: "short", confidence: meanConfidence }],
  reason: `Motivo de ${symbol}.`, sources: ["https://news.example/a"],
});
const exit = (symbol: string, sleeve: SleeveId = SLEEVE): Override => ({ ...short(symbol, 0.8, sleeve), action: "exit", votes: [
  { family: "claude", action: "exit", confidence: 0.8 }, { family: "gpt", action: "exit", confidence: 0.8 }] });
function put(session: string, overrides: Override[], dir = inbox) {
  const d = sealDecision(baseDecision({ session, decidedAt: `${session}T13:15:00.000Z`, overrides }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.json`), JSON.stringify(d));
  return d;
}
const BOTH = { momentum_stocks: true, meanrev_stocks: true };
/** `bets`: the AI_REVIEW_BETS flag, given by each test (the real one is on since 2026-11-14). */
const hookOf = (bets: boolean, sleeve: SleeveId = SLEEVE, env: Record<string, string | undefined> = {}): AiReviewHook =>
  aiReviewHook(sleeve, { dir: inbox, env, table: BOTH, bets });

function engine(venue: FakeVenue, over: Partial<PortfolioEngineOptions> = {}, db = histDb()) {
  const alerts: string[] = [];
  const e = new PortfolioEngine({
    accountId: SLEEVE, strategyVersion: VERSION, config: cfg(UNI), capital: 10_000,
    market: "stocks", rowMarket: "stock", quoteAsset: "USD", venue, mode: "live",
    openPriceView: (asOf, symbols) => new HistoricalPriceView({ db, asOf, symbols }),
    decide: fixedDecide({ NVDA: 0.5, AAPL: 0.2 }),
    now: () => NOW, tradingEnabled: () => true, alert: (_c, m) => alerts.push(m),
    heartbeats: { register: () => {}, beat: () => {} },
    ...over,
  });
  return Object.assign(e, { alerts });
}
const rowOf = (symbol: string, account = SLEEVE) =>
  (getDB().prepare(`SELECT * FROM trades WHERE account_id = ? AND symbol = ? ORDER BY entry_time DESC LIMIT 1`).get(account, symbol) ?? undefined) as any;
const journal = (account = SLEEVE, session = SESSION) => getPortfolioDecision(account, VERSION, session)!;
const book = (account = SLEEVE) => getDB().prepare(`SELECT symbol, status, quantity, entry_price, pnl, close_reason, partial_realized_native
  FROM trades WHERE account_id = ? ORDER BY symbol, entry_time, id`).all(account);
const aiOf = (account = SLEEVE, session = SESSION) => (journal(account, session).diagnostics as any).aiReview;

/** A venue whose broker holds these lots, with rows for them (qty, average entry), at these prices. */
function world(lots: Record<string, [number, number]>, prices: Record<string, number> = {}, account = SLEEVE) {
  const v = new FakeVenue();
  v.prices_ = { ...PRICES, ...prices };
  for (const [symbol, [qty, entry]] of Object.entries(lots)) {
    seedOpenTrade(`pf_${account}_${symbol}`, account, { symbol, strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: entry, quantity: qty, entryTime: Date.parse("2026-10-19T14:00:00Z") });
    v.positions_.push({ symbol, qty, avgEntryPrice: entry });
  }
  return v;
}
/** NVDA 10 @ 500 ($5,000 = the model's 0.5 of $10,000) and AAPL 10 @ 200 (0.2): the book is on target, the model orders nothing. */
const onTarget = (prices: Record<string, number> = {}) => world({ NVDA: [10, 500], AAPL: [10, 200] }, prices);

function footprint(venue: FakeVenue, account = SLEEVE) {
  const dec = journal(account);
  return JSON.stringify({ submits: venue.submits, weights: dec.weights, orders: dec.orders, stops: dec.stops, memory: dec.memory, status: dec.status, book: book(account) });
}
const stripAi = (o: any) => ({ ...o, diagnostics: { ...o.diagnostics, aiReview: undefined } });
/** The whole journal record of a pass, as JSON (decidedAt/updatedAt are the engine's fixed clock). */
const record = (account = SLEEVE) => JSON.stringify({ ...stripAi(journal(account)), id: undefined });

describe("bets switch OFF: a `short` is an exit, byte for byte what stage B did", () => {
  test("plan, orders, rows and journal are the same as with a stage-B hook (no `betsOn`), with no fund, no `bets`, no quantity step", async () => {
    put(SESSION, [short("NVDA")]);
    const stageB = onTarget();
    const hookB: AiReviewHook = { forPass: hookOf(false).forPass, applies: () => true };       // the stage-B hook has no betsOn
    await engine(stageB, { aiReview: hookB }).runSession(WINDOW);
    const fpB = footprint(stageB), recB = record(), aiB = aiOf();
    wipe();
    const off = onTarget();
    const rep = await engine(off, { aiReview: hookOf(false) }).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(footprint(off)).toBe(fpB);
    expect(record()).toBe(recB);
    expect(JSON.stringify(aiOf())).toBe(JSON.stringify(aiB));
    expect(off.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:NVDA:10"]);
    expect(journal().weights).toEqual({ NVDA: 0, AAPL: 0.2 });
    expect(aiOf()).toEqual({ decisionId: expect.stringMatching(/^[0-9a-f]{12}$/), decisionSession: SESSION, applied: true,
      effects: [{ symbol: "NVDA", action: "short", factor: 0, modelWeight: 0.5, appliedWeight: 0 }], modelWeights: { NVDA: 0.5 } });
    expect(aiOf()).not.toHaveProperty("bets");
    expect((journal().diagnostics as any).rules).toEqual({ venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0 });
    expect(journal().orders.map(o => [o.intent.symbol, o.label])).toEqual([["NVDA", "ai_review_sell"]]);
    expect(journal().orders[0]).not.toHaveProperty("closeReason");
    expect(rowOf("NVDA")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });
    expect(rowOf("NVDD")).toBeUndefined();
  });

  test("the kill switches turn the bets off with the flag on: AI_REVIEW_BETS=off (exit only) and AI_REVIEW_APPLY=off (the model's own pass)", async () => {
    put(SESSION, [short("NVDA")]);
    const off = onTarget();
    await engine(off, { aiReview: hookOf(true, SLEEVE, { AI_REVIEW_BETS: "off" }) }).runSession(WINDOW);
    expect(off.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:NVDA"]);
    expect(aiOf()).not.toHaveProperty("bets");
    wipe();
    const killed = onTarget();
    await engine(killed, { aiReview: hookOf(true, SLEEVE, { AI_REVIEW_APPLY: "off" }) }).runSession(WINDOW);
    expect(killed.submits).toEqual([]);
    expect(aiOf()).toMatchObject({ applied: false });
    expect(aiOf()).not.toHaveProperty("bets");
  });
});

describe("bets ON: a `short` takes the stock out and bets against it with the stock's inverse fund", () => {
  test("NVDA sold in full ($5,000), NVDD bought for min($2,500, the model's dollars) = 100 shares; nothing else changes; the journal has the applied weights WITH the fund", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = onTarget();
    const rep = await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:NVDA:10", "buy:NVDD:100"]);   // sells first
    expect(venue.submits[0].order).toMatchObject({ reduceOnly: true, targetWeight: 0, currentWeight: 0.5 });
    expect(venue.submits[1].order).toMatchObject({ reduceOnly: false, targetWeight: 0.25, notional: 2500 });
    const dec = journal();
    expect(dec.weights).toEqual({ NVDA: 0, AAPL: 0.2, NVDD: 0.25 });
    expect(aiOf()).toMatchObject({ applied: true, modelWeights: { NVDA: 0.5 },
      effects: [{ symbol: "NVDA", action: "short", factor: 0, modelWeight: 0.5, appliedWeight: 0 }],
      bets: [{ underlying: "NVDA", symbol: "NVDD", weight: 0.25, modelWeight: 0.5, stopped: false }] });
    expect(dec.orders.map(o => [o.intent.symbol, o.label])).toEqual([["NVDA", "ai_review_sell"], ["NVDD", "ai_review_bet_buy"]]);
    expect(rowOf("NVDA")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });
    expect(rowOf("NVDD")).toMatchObject({ status: "open", quantity: 100, entry_price: 25 });
    expect(rowOf("AAPL")).toMatchObject({ status: "open", quantity: 10 });                       // nothing else moved
    const gross = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);
    expect(gross(dec.weights)).toBeLessThanOrEqual(gross({ NVDA: 0.5, AAPL: 0.2 }));            // total applied gross ≤ the model's
    expect(dec.orders.every(o => o.applied)).toBe(true);
  });

  test("the model had less in the stock than $2,500: the fund gets the model's dollars, never more (the review does not raise what is invested)", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = world({ NVDA: [2, 500], AAPL: [10, 200] });                                    // the model's 0.1 of $10,000 = $1,000 = 2 shares
    await engine(venue, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.1, AAPL: 0.2 }) }).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:NVDA:2", "buy:NVDD:40"]);
    expect(journal().weights).toEqual({ NVDA: 0, AAPL: 0.2, NVDD: 0.1 });
    expect(aiOf().bets).toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: 0.1, modelWeight: 0.1, stopped: false }]);
  });

  test("a stock the model does not hold this pass (weight 0) is no bet at all", async () => {
    put(SESSION, [short("MSFT")]);
    const venue = onTarget();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(venue.submits).toEqual([]);
    expect((journal().diagnostics as any).aiReview).toBeUndefined();
  });

  test("an `exit` or a `reduce` of a stock with a fund is never a bet", async () => {
    put(SESSION, [exit("NVDA")]);
    const venue = onTarget();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:NVDA"]);
    expect(aiOf()).not.toHaveProperty("bets");
  });

  test("a short of a stock WITHOUT a fund (IWM) takes it out only, as before", async () => {
    put(SESSION, [short("IWM")]);
    const venue = world({ IWM: [10, 200] });
    await engine(venue, { aiReview: hookOf(true), decide: fixedDecide({ IWM: 0.2 }) }).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:IWM"]);
    expect(journal().weights).toEqual({ IWM: 0 });
    expect(aiOf()).not.toHaveProperty("bets");
    expect(rowOf("IWM")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });
  });

  test("the THIRD bet of a decision is an exit only: three shorts with funds, the two most confident are bets", async () => {
    put(SESSION, [short("NVDA", 0.9), short("AAPL", 0.85), short("MSFT", 0.7)]);
    const venue = world({ NVDA: [4, 500], AAPL: [10, 200], MSFT: [5, 400] });                    // 0.2 + 0.2 + 0.2
    await engine(venue, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.2, AAPL: 0.2, MSFT: 0.2 }) }).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:AAPL", "sell:MSFT", "sell:NVDA", "buy:AAPD", "buy:NVDD"]);
    expect(journal().weights).toEqual({ NVDA: 0, AAPL: 0, MSFT: 0, NVDD: 0.2, AAPD: 0.2 });
    expect(aiOf().bets.map((b: any) => b.symbol)).toEqual(["NVDD", "AAPD"]);
    expect(rowOf("MSFD")).toBeUndefined();
    expect(rowOf("MSFT")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });  // exit only
  });

  test("the cap is over BOTH sleeves: the better two by confidence, whichever sleeve (two engines, one decision)", async () => {
    // momentum NVDA .7 and AAPL .65, meanrev AVGO .9 and NFLX .8 → the bets are AVGO and NFLX; momentum only exits
    put(SESSION, [short("NVDA", 0.7), short("AAPL", 0.65), short("AVGO", 0.9, MEANREV), short("NFLX", 0.8, MEANREV)]);
    const mom = world({ NVDA: [4, 500], AAPL: [10, 200] });
    const mr = world({ AVGO: [10, 300], NFLX: [20, 100] }, {}, MEANREV);
    await engine(mom, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.2, AAPL: 0.2 }) }).runSession(WINDOW);
    await engine(mr, { accountId: MEANREV, config: cfg(UNI_MR), aiReview: hookOf(true, MEANREV), decide: fixedDecide({ AVGO: 0.3, NFLX: 0.2 }) }, histDb(AS_OF, UNI_MR)).runSession(WINDOW);
    expect(mom.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:AAPL", "sell:NVDA"]);          // exits, no fund
    expect(aiOf(SLEEVE)).not.toHaveProperty("bets");
    expect(mr.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:AVGO:10", "sell:NFLX:20", "buy:AVS:50", "buy:NFXS:100"]);
    expect(aiOf(MEANREV).bets.map((b: any) => [b.underlying, b.symbol, b.weight])).toEqual([["AVGO", "AVS", 0.25], ["NFLX", "NFXS", 0.2]]);
  });

  test("one bet in each sleeve when the best two are split: momentum NVDA .95 and meanrev AVGO .9 beat AAPL .8 and NFLX .7", async () => {
    put(SESSION, [short("NVDA", 0.95), short("AVGO", 0.9, MEANREV), short("AAPL", 0.8), short("NFLX", 0.7, MEANREV)]);
    const mom = world({ NVDA: [4, 500], AAPL: [10, 200] });
    const mr = world({ AVGO: [10, 300], NFLX: [20, 100] }, {}, MEANREV);
    await engine(mom, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.2, AAPL: 0.2 }) }).runSession(WINDOW);
    await engine(mr, { accountId: MEANREV, config: cfg(UNI_MR), aiReview: hookOf(true, MEANREV), decide: fixedDecide({ AVGO: 0.3, NFLX: 0.2 }) }, histDb(AS_OF, UNI_MR)).runSession(WINDOW);
    expect(aiOf(SLEEVE).bets.map((b: any) => b.symbol)).toEqual(["NVDD"]);
    expect(aiOf(MEANREV).bets.map((b: any) => b.symbol)).toEqual(["AVS"]);
    expect(rowOf("AAPD")).toBeUndefined();
    expect(rowOf("NFXS", MEANREV)).toBeUndefined();
  });
});

describe("a whole-share fund is bought in whole shares, rounded DOWN, and skipped when it rounds to zero", () => {
  const metaWorld = (prices: Record<string, number> = {}) => world({ META: [8.333333333, 600] }, prices);
  const opts = (): Partial<PortfolioEngineOptions> => ({ aiReview: hookOf(true), decide: fixedDecide({ META: 0.5 }) });

  test("METD at $37.50: $2,500 ÷ 37.50 = 66.67 → 66 shares; the venue's rules carry step 1 for it", async () => {
    put(SESSION, [short("META")]);
    const venue = metaWorld();
    await engine(venue, opts()).runSession(WINDOW);
    const buy = venue.submits.find(s => s.order.side === "buy")!.order;
    expect(buy).toMatchObject({ symbol: "METD", qty: 66, notional: 66 * 37.5 });
    expect(Number.isInteger(buy.qty)).toBe(true);
    expect((journal().diagnostics as any).rules.qtyStep).toEqual({ METD: 1 });
    expect(rowOf("METD")).toMatchObject({ status: "open", quantity: 66 });
  });

  test("a fractionable fund (NVDD) keeps its fractions: no step is added for it", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = world({ NVDA: [10, 500] }, { NVDD: 24.7 });
    await engine(venue, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.5 }) }).runSession(WINDOW);
    expect(venue.submits.find(s => s.order.side === "buy")!.order.qty).toBeCloseTo(2500 / 24.7, 9);
    expect((journal().diagnostics as any).rules).not.toHaveProperty("qtyStep");
  });

  test("a fund that costs more than the bet ($3,000 a share): the order rounds to zero and is skipped; the exit still happens", async () => {
    put(SESSION, [short("META")]);
    const venue = metaWorld({ METD: 3000 });
    const rep = await engine(venue, opts()).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:META"]);
    expect(rowOf("METD")).toBeUndefined();
    expect(rowOf("META")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });
  });

  test("the venue's own step is never loosened: a step the venue already hands for a fund is kept when it is coarser than 1", async () => {
    put(SESSION, [short("META")]);
    const venue = metaWorld();
    venue.rules_ = { ...venue.rules_, qtyStep: { METD: 5 } };
    await engine(venue, opts()).runSession(WINDOW);
    expect(venue.submits.find(s => s.order.side === "buy")!.order.qty).toBe(65);
  });
});

describe("the stop: a held fund 8 % or more below its average entry is sold at this pass, whatever the decision says", () => {
  const stopWorld = (nvdd: number) => world({ NVDD: [100, 25] }, { NVDD: nvdd });
  const opts = (): Partial<PortfolioEngineOptions> => ({ aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.5 }) });

  test("8.0 % below (25 → 23): sold with ai_review_bet_sell, the row closes AI_REVIEW_BET_STOP, the underlying is NOT bought back", async () => {
    put(SESSION, [short("NVDA")]);                                  // the decision still asks for the bet
    const venue = stopWorld(23);
    await engine(venue, opts()).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:NVDD:100"]);
    expect(journal().orders.map(o => [o.intent.symbol, o.label, o.closeReason])).toEqual([["NVDD", "ai_review_bet_sell", "AI_REVIEW_BET_STOP"]]);
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_STOP" });
    expect(rowOf("NVDD").pnl).toBeCloseTo(-200, 6);
    expect(aiOf().bets).toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: 0, modelWeight: 0.5, stopped: true }]);
    expect(journal().weights).toEqual({ NVDA: 0 });                   // no fund weight for THIS session
    expect(rowOf("NVDA")).toBeUndefined();
  });

  test("7.9 % below (25 → 23.025): kept, the fund is not sold (the usual weight target may top it up; no stop, no END)", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = stopWorld(23.025);
    await engine(venue, opts()).runSession(WINDOW);
    expect(venue.submits.filter(s => s.order.symbol === "NVDD" && s.order.side === "sell")).toEqual([]);
    expect(rowOf("NVDD")).toMatchObject({ status: "open", close_reason: null });
    expect(rowOf("NVDD").quantity).toBeGreaterThanOrEqual(100);
    expect(aiOf().bets).toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: expect.any(Number), modelWeight: 0.5, stopped: false }]);
    expect(journal().weights.NVDD).toBeGreaterThan(0);
    expect(journal().orders.every(o => o.closeReason === undefined)).toBe(true);
  });

  test("after a stop the SAME decision, a day older, does not buy the bet back: the stock stays out, no fund order", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = stopWorld(23);
    await engine(venue, opts()).runSession(WINDOW);
    expect(rowOf("NVDD").status).toBe("closed");
    const rep = await engine(venue, { ...opts(), now: () => NOW + DAY }, histDb(SESSION)).runSession(NEXT);   // no decision of 10-21: Tuesday's is still valid
    expect(rep.status).toBe("submitted");
    expect(rep.orders).toEqual([]);
    expect(journal(SLEEVE, NEXT.session).weights).toEqual({ NVDA: 0 });
    expect(aiOf(SLEEVE, NEXT.session)).not.toHaveProperty("bets");
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_STOP" });
  });

  test("the stop is checked once a day, at the pass: a NEW decision of the next session that asks again opens a new entry", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = stopWorld(23);
    await engine(venue, opts()).runSession(WINDOW);
    expect(rowOf("NVDD").status).toBe("closed");
    put(NEXT.session, [short("NVDA")]);
    const rep = await engine(venue, { ...opts(), now: () => NOW + DAY }, histDb(SESSION)).runSession(NEXT);
    expect(rep.orders.map(o => [o.intent.symbol, o.intent.side, o.label])).toEqual([["NVDD", "buy", "ai_review_bet_buy"]]);
    expect(rowOf("NVDD")).toMatchObject({ status: "open" });
    expect(aiOf(SLEEVE, NEXT.session).bets[0]).toMatchObject({ stopped: false });
  });

  test("the stop is judged on the fund's ESTIMATED price when the venue's is stale: the stock rose 9 % since its close, the fund is 9 % down", async () => {
    put(SESSION, [short("NVDA")]);
    // The venue still shows 25 for the fund (an old print); its bar of yesterday closed at 25 and NVDA went from 500 to 545.
    const venue = world({ NVDD: [100, 25] }, { NVDD: 25, NVDA: 545 });
    await engine(venue, opts(), closesDb({ NVDA: 500, NVDD: 25 })).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:NVDD:100"]);
    expect(journal().orders[0]).toMatchObject({ label: "ai_review_bet_sell", closeReason: "AI_REVIEW_BET_STOP" });
    expect(journal().orders[0].decisionPrice).toBeCloseTo(22.75, 9);
    expect(aiOf().bets).toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: 0, modelWeight: 0.5, stopped: true }]);
  });
});

describe("a NEW bet needs the decision of this very session", () => {
  test("yesterday's decision, still valid: the stock goes out as always, but no bet is opened on old news", async () => {
    put(AS_OF, [short("NVDA")]);
    const venue = onTarget();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:NVDA"]);
    expect(journal().weights).toEqual({ NVDA: 0, AAPL: 0.2 });
    expect(aiOf()).toMatchObject({ decisionSession: AS_OF, applied: true });
    expect(aiOf()).not.toHaveProperty("bets");
  });

  test("a bet that is already open goes on under yesterday's decision (and its stop keeps working)", async () => {
    put(AS_OF, [short("NVDA")]);
    const venue = world({ NVDD: [100, 25] });
    await engine(venue, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.5 }) }).runSession(WINDOW);
    expect(venue.submits).toEqual([]);                                // on target: $2,500 of $10,000
    expect(journal().weights).toEqual({ NVDA: 0, NVDD: 0.25 });
    expect(aiOf().bets).toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: 0.25, modelWeight: 0.5, stopped: false }]);
    wipe();
    const fallen = world({ NVDD: [100, 25] }, { NVDD: 22 });
    await engine(fallen, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.5 }) }).runSession(WINDOW);
    expect(fallen.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:NVDD:100"]);
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_STOP" });
  });
});

describe("a fund with no target leaves in full, whatever the planner's rebalance band", () => {
  // A band of 2 % of the strategy ($200 of $10,000) and a fund lot worth $100: the planner alone would leave it where it is.
  const small = (prices: Record<string, number> = {}) => { const v = world({ NVDD: [4, 25] }, prices); v.rules_ = { ...v.rules_, rebalanceBand: 0.02 }; return v; };
  const opts = (): Partial<PortfolioEngineOptions> => ({ aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.5 }) });

  test("the bet ended: the small lot is sold whole (END) although it is inside the band", async () => {
    put(SESSION, []);
    const venue = small();
    await engine(venue, opts()).runSession(WINDOW);
    expect(venue.submits.filter(s => s.order.symbol === "NVDD").map(s => `${s.order.side}:${s.order.qty}`)).toEqual(["sell:4"]);
    expect(journal().orders.find(o => o.intent.symbol === "NVDD")).toMatchObject({ label: "ai_review_bet_sell", closeReason: "AI_REVIEW_BET_END" });
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_END" });
    expect(journal().orders.map(o => o.intent.side)).toEqual(["sell", "buy"]);   // sells first: the fund, then the model's own NVDA buy
  });

  test("the stop on a small lot sells it whole (STOP): a stop that sells nothing is no stop", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = small({ NVDD: 22 });
    await engine(venue, opts()).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:NVDD:4"]);
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_STOP" });
  });

  test("a whole-share fund leaves in whole shares; a STOCK's small lot stays the planner's business (the band still holds for it)", async () => {
    put(SESSION, []);
    const venue = world({ METD: [3, 37.5], KO: [1, 60] });                 // $112.50 and $60, both inside the 2 % band; the model wants neither
    venue.rules_ = { ...venue.rules_, rebalanceBand: 0.02 };
    await engine(venue, { aiReview: hookOf(true), decide: fixedDecide({}) }).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:METD:3"]);
    expect(rowOf("KO")).toMatchObject({ status: "open" });
  });

  test("fail-open: a planner that fails when asked about the small lot leaves the pass exactly as the planner made it", async () => {
    put(SESSION, []);
    const venue = small();
    let asked = 0;
    const plan: typeof corePlanOrders = (target, book, prices, rules) => {
      if (rules.rebalanceBand === 0) { asked++; throw new Error("boom"); }      // only the second question (no band) fails
      return corePlanOrders(target, book, prices, rules);
    };
    const rep = await engine(venue, { ...opts(), planOrders: plan }).runSession(WINDOW);
    expect(asked).toBe(1);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["buy:NVDA"]);   // the model's own order; the small fund lot stays for now
    expect(rowOf("NVDD")).toMatchObject({ status: "open" });
  });

  test("a lot at its five-session limit already has its MAX_HOLD close: no second sell is added", async () => {
    put(SESSION, []);
    seedOpenTrade("old-fund", SLEEVE, { symbol: "NVDD", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 25, quantity: 4, entryTime: Date.parse("2026-10-12T14:00:00Z") });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "NVDD", qty: 4, avgEntryPrice: 25 }];
    venue.prices_ = { NVDA: 500, NVDD: 25 };
    venue.rules_ = { ...venue.rules_, rebalanceBand: 0.02 };
    await engine(venue, { config: volCfg(["NVDA"]), decide: coreDecide, aiReview: hookOf(true) }, histDb(AS_OF, ["NVDA"])).runSession(WINDOW);
    expect(venue.submits.filter(s => s.order.symbol === "NVDD").map(s => `${s.order.side}:${s.order.maxHold}`)).toEqual(["sell:close"]);
    expect(getDB().prepare("SELECT close_reason FROM trades WHERE id = 'old-fund'").get()).toEqual({ close_reason: "MAX_HOLD" });
  });
});

describe("the bet ends when the decision stops asking for it", () => {
  test("the next decision drops it: the fund is sold (AI_REVIEW_BET_END) and the stock is bought back as an ordinary rebalance buy, in ONE pass, sells first", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = onTarget();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(rowOf("NVDD")).toMatchObject({ status: "open", quantity: 100 });
    const before = venue.submits.length;
    put(NEXT.session, []);                                           // the next morning's decision lifts it
    const rep = await engine(venue, { aiReview: hookOf(true), now: () => NOW + DAY }, histDb(SESSION)).runSession(NEXT);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.slice(before).map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:NVDD", "buy:NVDA"]);
    expect(rep.orders.map(o => [o.intent.symbol, o.label])).toEqual([["NVDD", "ai_review_bet_sell"], ["NVDA", "rebalance_buy"]]);
    expect(rep.orders[0].closeReason).toBe("AI_REVIEW_BET_END");
    expect(rep.orders[1].intent.maxHold).toBeUndefined();
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_END" });
    expect(rowOf("NVDA")).toMatchObject({ status: "open" });
    expect(getPortfolioDecision(SLEEVE, VERSION, NEXT.session)!.weights).toEqual({ NVDA: 0.5, AAPL: 0.2 });
    expect((getPortfolioDecision(SLEEVE, VERSION, NEXT.session)!.diagnostics as any).aiReview).toBeUndefined();
  });

  test("a decision that lapses (no file at all) ends it the same way: the fund is sold, the model's own weights come back", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = onTarget();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    rmSync(inbox, { recursive: true, force: true });
    const rep = await engine(venue, { aiReview: hookOf(true), now: () => NOW + DAY }, histDb(SESSION)).runSession(NEXT);
    expect(rep.orders.map(o => [o.intent.symbol, o.label])).toEqual([["NVDD", "ai_review_bet_sell"], ["NVDA", "rebalance_buy"]]);
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_END" });
  });

  test("with the bets switch turned OFF while a bet is open, the next pass closes it (END): a fund is never held without the review asking", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = onTarget();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    const rep = await engine(venue, { aiReview: hookOf(false), now: () => NOW + DAY }, histDb(SESSION)).runSession(NEXT);
    expect(rep.orders.map(o => [o.intent.symbol, o.intent.side, o.label])).toEqual([["NVDD", "sell", "ai_review_bet_sell"]]);
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_END" });
    expect(rowOf("NVDA")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });  // the decision still takes NVDA out (stage B), no bet
  });

  test("a partial sell of the fund (the stock's model weight fell) leaves the row open and closes nothing", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = world({ NVDD: [100, 25], AAPL: [10, 200] });         // $2,500 held, the model now has 0.1 in NVDA → the bet shrinks to 0.1
    await engine(venue, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.1, AAPL: 0.2 }) }).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.qty}`)).toEqual(["sell:NVDD:60"]);
    expect(journal().orders[0]).toMatchObject({ label: "ai_review_bet_sell", closeReason: "AI_REVIEW_BET_END" });
    expect(rowOf("NVDD")).toMatchObject({ status: "open", quantity: 40, close_reason: null });
  });
});

describe("the owner's five-session rule applies to the fund lot like to any other", () => {
  const entry = Date.parse("2026-10-12T14:00:00Z");                  // five NYSE sessions before 2026-10-20
  const lot = (symbol = "NVDD", qty = 40) => {
    seedOpenTrade("fund-lot", SLEEVE, { symbol, strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 25, quantity: qty, entryTime: entry });
    const v = new FakeVenue();
    v.positions_ = [{ symbol, qty, avgEntryPrice: 25 }];
    v.prices_ = { NVDA: 500, [symbol]: 25 };
    return v;
  };
  const real = (over: Partial<PortfolioEngineOptions> = {}): Partial<PortfolioEngineOptions> => ({ config: volCfg(["NVDA"]), decide: coreDecide, ...over });
  const db = () => histDb(AS_OF, ["NVDA"]);

  test("the lot is closed by MAX_HOLD and keeps its label and reason; while the decision still asks for the bet it is bought back (max_hold_rebuy)", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = lot();
    await engine(venue, real({ aiReview: hookOf(true) }), db()).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.maxHold}`)).toEqual(["sell:NVDD:close", "buy:NVDD:rebuy"]);
    expect(journal().orders.map(o => [o.label, o.closeReason])).toEqual([["max_hold_close", undefined], ["max_hold_rebuy", undefined]]);
    expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'fund-lot'").get()).toEqual({ status: "closed", close_reason: "MAX_HOLD" });
    expect(rowOf("NVDD")).toMatchObject({ status: "open", quantity: 100, entry_time: NOW });                  // $2,500 ÷ $25, a fresh lot
    expect(aiOf().bets[0]).toMatchObject({ underlying: "NVDA", symbol: "NVDD", stopped: false });
  });

  test("when the bet ended (the decision dropped it) the expired lot is closed by MAX_HOLD and NOT bought back", async () => {
    put(SESSION, []);
    const venue = lot();
    await engine(venue, real({ aiReview: hookOf(true) }), db()).runSession(WINDOW);
    expect(venue.submits.filter(s => s.order.symbol === "NVDD").map(s => `${s.order.side}:${s.order.maxHold}`)).toEqual(["sell:close"]);   // the model's own NVDA buy is another order
    expect(journal().orders.filter(o => o.intent.symbol === "NVDD").map(o => o.label)).toEqual(["max_hold_close"]);
    expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'fund-lot'").get()).toEqual({ status: "closed", close_reason: "MAX_HOLD" });
    expect(rowOf("NVDD")).toMatchObject({ status: "closed" });
  });

  test("the stop on the same day as the five-session close: the close keeps MAX_HOLD, and there is no rebuy", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = lot();
    venue.prices_.NVDD = 22;                                         // 12 % below the 25 entry
    await engine(venue, real({ aiReview: hookOf(true) }), db()).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.maxHold}`)).toEqual(["sell:close"]);
    expect(getDB().prepare("SELECT close_reason FROM trades WHERE id = 'fund-lot'").get()).toEqual({ close_reason: "MAX_HOLD" });
    expect(aiOf().bets[0]).toMatchObject({ stopped: true, weight: 0 });
  });

  test("a stale-data pass only closes the expired lot (closes only): it opens no bet and never asks the review", async () => {
    put(SESSION, [short("NVDA")]);
    let asked = 0;
    const hook: AiReviewHook = { ...hookOf(true), forPass: () => { asked++; return null; } };
    const venue = lot();
    const rep = await engine(venue, real({ aiReview: hook }), histDb("2026-10-16", ["NVDA"])).runSession(WINDOW);
    expect(rep.status).toBe("skipped_stale");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}:${s.order.maxHold}`)).toEqual(["sell:NVDD:close"]);
    expect(journal().orders.map(o => o.label)).toEqual(["stale_close"]);
    expect(asked).toBe(0);
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "MAX_HOLD" });
  });
});

describe("decide() receives the fund lot in book.positions and nothing breaks", () => {
  const SYMS = ["NVDA", "AAPL", "MSFT", "META"];
  const spyDecide = () => { const calls: CoreDecideInput[] = []; const fn = (i: CoreDecideInput) => { calls.push(i); return coreDecide(i); }; return Object.assign(fn, { calls }); };
  const seed = (id: string, symbol: string, qty: number, price: number, entry: string) => {
    seedOpenTrade(id, SLEEVE, { symbol, strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: price, quantity: qty, entryTime: Date.parse(`${entry}T14:00:00Z`) });
    return { symbol, qty, avgEntryPrice: price };
  };
  const opts = (decide: ReturnType<typeof spyDecide>, over: Partial<PortfolioEngineOptions> = {}): Partial<PortfolioEngineOptions> =>
    ({ config: volCfg(SYMS), decide, aiReview: hookOf(true), ...over });

  test("the stagger: with 3 core lots and the fund lot (4 lots, quota 1) the OLDEST lot rotates — the fund's when it is the oldest, a core lot's when it is not — and the fund is bought back while the bet stands", async () => {
    put(SESSION, [short("NVDA")]);
    // fund lot entered 10-14 (oldest); core lots 10-19 → the fund lot rotates: close + rebuy, label max_hold_*, the core lots are untouched
    let venue = new FakeVenue();
    venue.prices_ = { NVDA: 500, AAPL: 200, MSFT: 400, META: 600, NVDD: 25 };
    venue.positions_ = [seed("f", "NVDD", 40, 25, "2026-10-14"), seed("a", "AAPL", 2, 200, "2026-10-19"), seed("m", "MSFT", 1, 400, "2026-10-19"), seed("x", "META", 1, 600, "2026-10-19")];
    let decide = spyDecide();
    await engine(venue, opts(decide), histDb(AS_OF, SYMS)).runSession(WINDOW);
    expect(decide.calls[0].book.positions.map(p => p.symbol)).toContain("NVDD");              // decide() got the fund lot
    expect(decide.calls[0].book.positions.find(p => p.symbol === "NVDD")).toMatchObject({ qty: 40, avgEntryPrice: 25, entrySession: "2026-10-14" });
    expect((decide.calls[0] as any).book.memory).toBeDefined();
    const fundOrders = journal().orders.filter(o => o.intent.symbol === "NVDD");
    expect(fundOrders.map(o => [o.intent.side, o.intent.maxHold, o.label])).toEqual([["sell", "close", "max_hold_close"], ["buy", "rebuy", "max_hold_rebuy"]]);
    expect(journal().orders.filter(o => o.intent.maxHold && o.intent.symbol !== "NVDD")).toEqual([]);   // no core lot rotated
    expect(Object.keys(journal().weights)).toContain("NVDD");
    wipe();
    // core lots entered 10-13 (older) and the fund lot 10-19 → a core lot rotates, the fund lot is not touched by the stagger
    venue = new FakeVenue();
    venue.prices_ = { NVDA: 500, AAPL: 200, MSFT: 400, META: 600, NVDD: 25 };
    venue.positions_ = [seed("f", "NVDD", 100, 25, "2026-10-19"), seed("a", "AAPL", 2, 200, "2026-10-13"), seed("m", "MSFT", 1, 400, "2026-10-14"), seed("x", "META", 1, 600, "2026-10-14")];
    decide = spyDecide();
    await engine(venue, opts(decide), histDb(AS_OF, SYMS)).runSession(WINDOW);
    expect(journal().orders.filter(o => o.intent.maxHold === "close").map(o => o.intent.symbol)).toEqual(["AAPL"]);
    expect(journal().orders.filter(o => o.intent.symbol === "NVDD").map(o => o.intent.maxHold)).not.toContain("close");
  });

  test("the regime switch going risk-off while a bet is open: decide() never sees the fund as the model's, and the bet follows the review's size rule (the model has no weight in the stock → the bet ends, END)", async () => {
    // the live RW11 definition, the real kernel: SPY below its SMA200 → risk-off (core 0, the SH hedge)
    const strategy = (builtinPortfolio("pe_momentum_stocks").params as any).strategy as VolManagedConfig;
    const symbols = [...new Set([...strategy.universe, "SPY", "SH"])];
    const sessions = weekdaySessions(AS_OF, 300);
    const histFor = (riskOn: boolean) => makeHistDb(Object.fromEntries(symbols.map((s, j) => [s, { sessions,
      close: (i: number) => s === "SPY" ? (i === 299 ? (riskOn ? 140 : 80) : 100 + Math.sin(i)) : 100 + i * 0.04 + 2 * Math.sin(i * (0.3 + j * 0.1)) }])));
    const mkWorld = (hist: ReturnType<typeof histFor>) => {
      const view = new HistoricalPriceView({ db: hist, asOf: AS_OF, symbols });
      const v = new FakeVenue();
      v.prices_ = Object.fromEntries(symbols.map(s => [s, view.lastClose(s) ?? 100]));
      v.prices_.NVDD = 25;
      v.rules_ = { ...v.rules_, rebalanceBand: 0.02 };
      // the fund lot (entered the day before) and an older core lot: the stagger's quota of one rotation goes to the OLDER lot, not to the fund
      v.positions_ = [seed("f", "NVDD", 100, 25, "2026-10-19"), seed("c", "SSO", 5, v.prices_.SSO, "2026-10-13")];
      return v;
    };
    put(SESSION, [short("NVDA")]);
    for (const riskOn of [true, false]) {
      wipe();
      const hist = histFor(riskOn);
      const venue = mkWorld(hist);
      const decide = spyDecide();
      const rep = await engine(venue, { config: strategy, decide, aiReview: hookOf(true), capital: 10_000 }, hist).runSession(WINDOW);
      expect(rep.status).toBe("submitted");
      expect((decide.calls[0].book.positions).map(p => p.symbol)).toContain("NVDD");
      const modelWeights = decide.calls[0] ? coreDecide(decide.calls[0]).weights : {};
      expect(Object.keys(modelWeights)).not.toContain("NVDD");                                  // the fund is never the model's
      if (riskOn) {
        const nvda = journal().weights.NVDA;
        expect(nvda).toBe(0);
        const bet = aiOf().bets[0];
        expect(bet).toMatchObject({ underlying: "NVDA", symbol: "NVDD", stopped: false });
        expect(bet.weight).toBeCloseTo(Math.min(2500 / journal().equity, bet.modelWeight), 12);
        // the bet stands: at most a resize, never an END or a stop, and the stagger's rotation went to the older core lot
        const fundOrders = journal().orders.filter(o => o.intent.symbol === "NVDD");
        expect(fundOrders.every(o => ["ai_review_bet_sell", "ai_review_bet_buy"].includes(o.label!))).toBe(true);
        expect(rowOf("NVDD")).toMatchObject({ status: "open", close_reason: null });
      } else {
        expect(Object.keys(journal().weights)).toEqual(["SH"]);
        expect(rep.orders.find(o => o.intent.symbol === "NVDD")).toMatchObject({ label: "ai_review_bet_sell", closeReason: "AI_REVIEW_BET_END", applied: true });
        expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_END" });
        expect(rep.orders.find(o => o.intent.symbol === "SH")).toMatchObject({ label: "rebalance_buy" });   // the model's own hedge
      }
    }
  });
});

describe("RiskEngine gate, prices and the venue", () => {
  for (const state of ["HALTED", "REDUCING"] as const) test(`${state}: the fund's BUY is skipped with its own code; the underlying's sell goes`, async () => {
    put(SESSION, [short("NVDA")]);
    const venue = onTarget();
    const rep = await engine(venue, { aiReview: hookOf(true), tradingState: () => state }).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:NVDA"]);
    expect(rep.orders.filter(o => o.intent.side === "buy").map(o => [o.intent.symbol, o.label, o.skipped])).toEqual([["NVDD", "ai_review_bet_buy", state === "HALTED" ? "risk_engine_halted" : "risk_engine_reducing"]]);
    expect(rowOf("NVDA")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });
    expect(rowOf("NVDD")).toBeUndefined();
  });

  test("a held fund is still SOLD while HALTED (sells always go)", async () => {
    put(SESSION, []);
    const venue = world({ NVDD: [100, 25], AAPL: [10, 200] });
    await engine(venue, { aiReview: hookOf(true), tradingState: () => "HALTED", decide: fixedDecide({ AAPL: 0.2 }) }).runSession(WINDOW);
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:NVDD"]);
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_END" });
  });

  const noBet = async (venue: FakeVenue, db: ReturnType<typeof histDb>) => {
    const rep = await engine(venue, { aiReview: hookOf(true) }, db).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:NVDA"]);
    expect(journal().weights).toEqual({ NVDA: 0, AAPL: 0.2 });
    expect(aiOf()).not.toHaveProperty("bets");
    expect(rowOf("NVDD")).toBeUndefined();
  };
  const noVenuePrice = () => { const v = onTarget(); delete v.prices_.NVDD; return v; };

  test("no price a bet can open at → no bet, the exit still happens: no venue price for the fund and no bar of yesterday", async () => {
    put(SESSION, [short("NVDA")]);
    await noBet(noVenuePrice(), histDb());
  });

  test("... or a bar of the fund that is not yesterday's, or a stock whose move since its close is not believable (a split)", async () => {
    put(SESSION, [short("NVDA")]);
    const sessions = weekdaySessions(AS_OF, 300);
    const stale = makeHistDb({ ...Object.fromEntries(UNI.map(s => [s, { sessions, close: () => 500 }])), NVDD: { sessions: sessions.slice(0, -1), close: () => 25 } });
    await noBet(noVenuePrice(), stale);
    wipe();
    await noBet(noVenuePrice(), closesDb({ NVDA: 5000, NVDD: 25 }));     // NVDA "fell 90 %" overnight: a 10-for-1 split, not a move
  });

  test("the fund's reference price is the ESTIMATE whenever it can be made — its close of yesterday moved against today's move of the stock — with or without a venue price for the fund", async () => {
    put(SESSION, [short("NVDA")]);
    // NVDA closed at 520 and trades at 500 (−3.846 %); NVDD closed at 24 → 24 × (2 − 500/520) = 24.923…
    const estimate = 24 * (2 - 500 / 520);
    for (const venueHasFund of [false, true]) {
      wipe();
      const venue = onTarget();
      if (!venueHasFund) delete venue.prices_.NVDD;                      // else the venue says 25: the estimate still wins
      const rep = await engine(venue, { aiReview: hookOf(true) }, closesDb({ NVDA: 520, NVDD: 24 })).runSession(WINDOW);
      expect(rep.status).toBe("submitted");
      const buy = journal().orders.find(o => o.intent.symbol === "NVDD")!;
      expect(buy).toMatchObject({ label: "ai_review_bet_buy", applied: true });
      expect(buy.decisionPrice).toBeCloseTo(estimate, 9);
      expect(buy.intent.qty).toBeCloseTo(2500 / estimate, 6);            // $2,500 at the estimate
      expect((journal().diagnostics as any).prices.NVDD).toBeCloseTo(estimate, 9);
      expect(aiOf().bets).toEqual([{ underlying: "NVDA", symbol: "NVDD", weight: 0.25, modelWeight: 0.5, stopped: false }]);
    }
  });

  test("no estimate without the venue's own price of the STOCK (its last close is not today's move): then only a fund the venue prices can open a bet", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = onTarget();
    delete venue.prices_.NVDA;                                           // NVDA falls back to its last close (500): no move to read
    await engine(venue, { aiReview: hookOf(true) }, closesDb({ NVDA: 500, NVDD: 24 })).runSession(WINDOW);
    const buy = journal().orders.find(o => o.intent.symbol === "NVDD")!;
    expect(buy.decisionPrice).toBe(25);                                  // the venue's own price of the fund
    wipe();
    const neither = onTarget();
    delete neither.prices_.NVDA; delete neither.prices_.NVDD;
    await engine(neither, { aiReview: hookOf(true) }, closesDb({ NVDA: 500, NVDD: 24 })).runSession(WINDOW);
    expect(journal().orders.map(o => o.intent.symbol)).toEqual(["NVDA"]);
    expect(aiOf()).not.toHaveProperty("bets");
  });

  test("the venue's price call reaches the fund (it joins the symbols BEFORE the reference prices) only when bets are on", async () => {
    put(SESSION, [short("NVDA")]);
    const seen: string[][] = [];
    const spy = (v: FakeVenue) => { const p = v.prices.bind(v); v.prices = async (s: readonly string[]) => { seen.push([...s]); return p(s); }; return v; };
    await engine(spy(onTarget()), { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(seen[0]).toContain("NVDD");
    wipe(); seen.length = 0;
    await engine(spy(onTarget()), { aiReview: hookOf(false) }).runSession(WINDOW);
    expect(seen[0]).not.toContain("NVDD");
    expect(seen[0]).toEqual(["NVDA", "AAPL", "MSFT", "META", "KO", "IWM"]);
  });

  test("a resumed pass finishes the fund's buy with the journaled label, even if the decision file is gone", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = onTarget();
    venue.behavior.NVDD = { kind: "throw", error: "socket hang up" };
    expect((await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW)).status).toBe("failed");
    expect(journal().status).toBe("decided");
    expect(journal().orders.map(o => [o.intent.symbol, o.label, o.applied])).toEqual([["NVDA", "ai_review_sell", true], ["NVDD", "ai_review_bet_buy", false]]);
    rmSync(inbox, { recursive: true, force: true });
    venue.behavior = {};
    const rep = await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(rep.status).toBe("resumed");
    expect(rowOf("NVDD")).toMatchObject({ status: "open", quantity: 100 });
  });

  test("a resumed STOP sell closes with the journaled reason (AI_REVIEW_BET_STOP) without the decision", async () => {
    put(SESSION, [short("NVDA")]);
    const venue = world({ NVDD: [100, 25] }, { NVDD: 23 });
    venue.behavior.NVDD = { kind: "throw", error: "socket hang up" };
    await engine(venue, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.5 }) }).runSession(WINDOW);
    expect(journal().orders[0]).toMatchObject({ label: "ai_review_bet_sell", closeReason: "AI_REVIEW_BET_STOP", applied: false });
    rmSync(inbox, { recursive: true, force: true });
    venue.behavior = {};
    await engine(venue, { aiReview: hookOf(true), decide: fixedDecide({ NVDA: 0.5 }) }).runSession(WINDOW);
    expect(rowOf("NVDD")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_BET_STOP" });
  });
});

describe("fail-open: whatever goes wrong the pass is the model's own or the exit only, never an error", () => {
  const exitOnly = async () => {
    const v = onTarget();
    put(SESSION, [exit("NVDA")]);
    await engine(v, { aiReview: hookOf(false) }).runSession(WINDOW);
    const fp = footprint(v);
    wipe();
    return fp;
  };
  const doubleOf = (bets: unknown[], overrides: Override[] = [short("NVDA")]): AiReviewHook => ({
    forPass: () => ({ decisionId: "abc123def456", decisionSession: SESSION, overrides, bets: bets as any }), applies: () => true, betsOn: () => true,
  });
  const nvdaBet = { sleeve: SLEEVE, underlying: "NVDA", symbol: "NVDD", meanConfidence: 0.8 };

  test("an unknown fund symbol, another stock's fund, a fund of a stock outside the universe: exit only, no fund order", async () => {
    for (const bet of [{ ...nvdaBet, symbol: "ZZZZ" }, { ...nvdaBet, symbol: "AAPD" }, { ...nvdaBet, underlying: "AVGO", symbol: "AVS" }, { ...nvdaBet, underlying: "SH", symbol: "SH" }]) {
      wipe();
      const venue = onTarget();
      const rep = await engine(venue, { aiReview: doubleOf([bet], [short("NVDA"), short("AVGO")]) }).runSession(WINDOW);
      expect(rep.status).toBe("submitted");
      expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:NVDA"]);
      expect(journal().weights).toEqual({ NVDA: 0, AAPL: 0.2 });
      expect(aiOf()).not.toHaveProperty("bets");
    }
  });

  test("a tampered decision FILE: a short on a fund itself, on an unknown symbol, or on a stock of the other sleeve changes nothing", async () => {
    const base = await (async () => { const v = onTarget(); await engine(v, { aiReview: hookOf(true) }).runSession(WINDOW); const fp = footprint(v); wipe(); return fp; })();
    put(SESSION, [short("NVDD"), short("ZZZZ"), short("AVGO"), short("SH")]);
    const venue = onTarget();
    await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
    expect(footprint(venue)).toBe(base);
    expect((journal().diagnostics as any).aiReview).toBeUndefined();
  });

  test("a bet of the other sleeve's stock cannot be placed from this sleeve even if a hook hands it over", async () => {
    const venue = world({ AVGO: [10, 300], AAPL: [10, 200] });
    const rep = await engine(venue, { aiReview: doubleOf([{ ...nvdaBet, underlying: "AVGO", symbol: "AVS" }], [short("AVGO")]), decide: fixedDecide({ AVGO: 0.3, AAPL: 0.2 }) }).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.filter(s => s.order.symbol === "AVS")).toEqual([]);
  });

  const shapes: Array<[string, () => AiReviewHook | undefined]> = [
    ["no inbox directory", () => aiReviewHook(SLEEVE, { dir: join(inbox, "missing"), env: {}, table: BOTH, bets: true })],
    ["an empty inbox", () => { mkdirSync(inbox, { recursive: true }); return hookOf(true); }],
    ["a corrupt file", () => { writeFileSync(join(inbox, `${SESSION}.json`), "{ not json"); return hookOf(true); }],
    ["a truncated half-transfer only", () => { writeFileSync(join(inbox, `${SESSION}.json.tmp`), JSON.stringify(sealDecision(baseDecision({ session: SESSION, overrides: [short("NVDA")] })))); return hookOf(true); }],
    ["a decision older than 5 sessions", () => { put("2026-10-12", [short("NVDA")]); return hookOf(true); }],
    ["a decision for a later session", () => { put("2026-10-21", [short("NVDA")]); return hookOf(true); }],
    ["a tampered decision (its id no longer matches)", () => {
      const d = sealDecision(baseDecision({ session: SESSION, overrides: [short("NVDA")] }));
      writeFileSync(join(inbox, `${SESSION}.json`), JSON.stringify({ ...d, reviewed: 7 })); return hookOf(true);
    }],
    ["a decision with no overrides", () => { put(SESSION, []); return hookOf(true); }],
    ["a reviewForPass that throws", () => ({ forPass: () => { throw new Error("disk on fire"); }, applies: () => true, betsOn: () => true })],
    ["a switch reader that throws", () => { put(SESSION, [short("NVDA")]); return { forPass: hookOf(true).forPass, applies: () => { throw new Error("env gone"); }, betsOn: () => true }; }],
    ["a bets switch reader that throws", () => { put(SESSION, [short("NVDA")]); return { forPass: hookOf(true).forPass, applies: () => true, betsOn: () => { throw new Error("env gone"); } }; }],
    ["no hook at all", () => undefined],
  ];
  for (const [name, make] of shapes) test(name, async () => {
    const base = await (async () => { const v = onTarget(); await engine(v).runSession(WINDOW); const fp = footprint(v); wipe(); return fp; })();
    const hook = make();
    const venue = onTarget();
    const rep = await engine(venue, hook ? { aiReview: hook } : {}).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    // every shape but the broken bets reader is the model's own pass; with a bets reader that throws the whole review is ignored too
    expect(footprint(venue)).toBe(base);
    expect(journal().diagnostics).not.toHaveProperty("aiReview");
  });

  test("exit-only baseline helper is itself stable (sanity of the comparisons above)", async () => {
    const a = await exitOnly();
    const b = await exitOnly();
    expect(a).toBe(b);
  });
});

describe("a bet that cannot be sized costs the bet only: the stock still goes out", () => {
  const broken: Array<[string, () => unknown]> = [
    ["the sizing throws", () => { throw new Error("boom"); }],
    ["a weight above both caps", () => [{ underlying: "NVDA", symbol: "NVDD", weight: 0.9, modelWeight: 0.5, stopped: false }]],
    ["another stock's fund", () => [{ underlying: "NVDA", symbol: "AAPD", weight: 0.1, modelWeight: 0.5, stopped: false }]],
  ];
  test.each(broken)("%s: NVDA is sold as the review asked, no fund order, no `bets` in the journal", async (_name, impl) => {
    const spy = spyOn(applyModule, "sizeBets").mockImplementation(impl as any);
    try {
      put(SESSION, [short("NVDA")]);
      const venue = onTarget();
      const rep = await engine(venue, { aiReview: hookOf(true) }).runSession(WINDOW);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(rep.status).toBe("submitted");
      expect(venue.submits.map(s => `${s.order.side}:${s.order.symbol}`)).toEqual(["sell:NVDA"]);
      expect(journal().weights).toEqual({ NVDA: 0, AAPL: 0.2 });
      expect(aiOf()).toMatchObject({ applied: true, effects: [{ symbol: "NVDA", action: "short", appliedWeight: 0 }] });
      expect(aiOf()).not.toHaveProperty("bets");
      expect(rowOf("NVDA")).toMatchObject({ status: "closed", close_reason: "AI_REVIEW_EXIT" });
    } finally { spy.mockRestore(); }
  });
});

describe("observers and the crypto engines never see a bet", () => {
  test("observer mode: the hook is never asked, no fund is priced or planned", async () => {
    put(SESSION, [short("NVDA")]);
    const calls: string[] = [];
    const hook: AiReviewHook = { forPass: s => { calls.push(s); return null; }, applies: () => { calls.push("applies"); return true; }, betsOn: () => { calls.push("betsOn"); return true; } };
    const venue = onTarget();
    const rep = await engine(venue, { mode: "observer", strategyVersion: "d1-observer", aiReview: hook }).runSession(WINDOW);
    expect(rep.status).toBe("observed");
    expect(calls).toEqual([]);
    expect(venue.submits).toHaveLength(0);
  });

  test("a crypto engine, even live and even with a hook that would bet: no call, no fund, the model's own pass", async () => {
    put(SESSION, [short("BTC")]);
    const calls: string[] = [];
    const hook: AiReviewHook = { forPass: s => { calls.push(s); return null; }, applies: () => { calls.push("applies"); return true; }, betsOn: () => { calls.push("betsOn"); return true; } };
    const venue = new FakeVenue("binance_usdm");
    venue.prices_ = { BTC: 60_000, ETH: 3_000 };
    const db = makeHistDb({ BTC: { sessions: weekdaySessions(AS_OF, 300) }, ETH: { sessions: weekdaySessions(AS_OF, 300) } }, 0);
    const rep = await engine(venue, { config: cfg(["BTC", "ETH"]), market: "crypto", rowMarket: "crypto", quoteAsset: "USDT", decide: fixedDecide({ BTC: 0.5, ETH: 0.3 }), aiReview: hook }, db).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(calls).toEqual([]);
    expect(journal().weights).toEqual({ BTC: 0.5, ETH: 0.3 });
    expect(venue.submits.every(s => !["NVDD", "AAPD", "MSFD", "METD", "GGLS", "AMZD", "AVS", "NFXS", "ORCS", "QCMD"].includes(s.order.symbol))).toBe(true);
  });
});
