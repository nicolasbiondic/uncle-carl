// PortfolioEngine — adoption, first rebalance, partial fill, rejection, stale
// skip, observer mode, restart idempotency, decreases/exits, broker=truth
// reconciliation, post-fill stop sync. Fake venue, in-memory trading DB and
// in-memory historical.db. No broker, no network.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { countExecutedOrders, getDB, getDecisionPassSummary, PORTFOLIO_ENGINE_STRATEGY } from "../../db/database";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { PortfolioEngine, HEARTBEAT_GRACE_TICKS, type PortfolioEngineOptions } from "./PortfolioEngine";
import { HeartbeatRegistry } from "../../ops/heartbeat";
import { HistoricalPriceView } from "./priceView";
import { getPortfolioDecision, inferOrderLabel, latestPortfolioMemory, listPortfolioDecisions, savePortfolioDecision } from "./persistence";
import { portfolioClientOrderId } from "./clientOrderId";
import { PORTFOLIO_REBALANCE_CLOSE_REASON, PORTFOLIO_RECONCILED_CLOSE_REASON, loadSleeveRows } from "./rows";
import { FakeVenue, XASSET, CRYPTO_STOP, fixedDecide, makeHistDb, weekdaySessions } from "./testSupport";
import { decide as coreDecide } from "../decide";
import type { VolManagedConfig } from "../types";
import { AlpacaVenue } from "./venues/alpaca";

const SLEEVE = "momentum_stocks";
const VERSION = "d1-xasset-v1";
const AS_OF = "2026-10-19";    // Monday
const SESSION = "2026-10-20";  // Tuesday
const WINDOW = { session: SESSION, asOf: AS_OF };
const NOW = Date.parse("2026-10-20T14:00:00Z"); // 10:00 ET

function histDb(last = AS_OF, symbols = XASSET.universe) {
  const sessions = weekdaySessions(last, 300);
  return makeHistDb(Object.fromEntries(symbols.map(s => [s, { sessions }])));
}

function engine(venue: FakeVenue, over: Partial<PortfolioEngineOptions> = {}, db = histDb()) {
  const alerts: string[] = [];
  const beats: string[] = [];
  const e = new PortfolioEngine({
    accountId: SLEEVE, strategyVersion: VERSION, config: XASSET, capital: 10_000,
    market: "stocks", rowMarket: "stock", quoteAsset: "USD", venue, mode: "live",
    openPriceView: (asOf, symbols) => new HistoricalPriceView({ db, asOf, symbols }),
    decide: fixedDecide({ SPY: 0.5, TLT: 0.3 }),
    now: () => NOW,
    tradingEnabled: () => true,
    alert: (_c, m) => alerts.push(m),
    heartbeats: { register: () => {}, beat: (n) => beats.push(n) },
    ...over,
  });
  return Object.assign(e, { alerts, beats });
}

function rows() { return loadSleeveRows(SLEEVE); }
function row(symbol: string) {
  return getDB().prepare(`SELECT * FROM trades WHERE account_id = ? AND symbol = ? ORDER BY entry_time DESC LIMIT 1`).get(SLEEVE, symbol) as any;
}
function resetState() { getDB().exec("DELETE FROM trade_realized_legs; DELETE FROM trades; DELETE FROM portfolio_decisions; DELETE FROM activity_log; DELETE FROM decision_passes;"); }
function passes() { return getDB().prepare(`SELECT * FROM decision_passes WHERE account_id = ? ORDER BY id`).all(SLEEVE) as any[]; }

// ── Q7 V1 (2026-11-07) fault injection: a crash EXACTLY between the book write and the journal write ──
// A BEFORE UPDATE trigger on portfolio_decisions aborts the journal write while `whenSql` (a predicate
// on the book) holds: the rows have just been written, the order is about to be marked applied. With
// the two writes in one transaction the abort rolls the book back too; with the old code the rows stayed
// and the resume applied the venue's duplicate-id answer a second time.
function crashBetweenWrites(whenSql: string): () => void {
  getDB().exec(`CREATE TRIGGER crash_between_writes BEFORE UPDATE ON portfolio_decisions WHEN (${whenSql})
    BEGIN SELECT RAISE(ABORT, 'crash between book and journal'); END;`);
  return () => getDB().exec("DROP TRIGGER IF EXISTS crash_between_writes");
}
function bookSnapshot() {
  return getDB().prepare(`SELECT symbol, status, quantity, entry_price, pnl, close_reason, partial_realized_native, partial_closed_contracts
    FROM trades WHERE account_id = ? ORDER BY symbol, entry_time, id`).all(SLEEVE);
}
function legsSnapshot() {
  return getDB().prepare(`SELECT t.symbol, l.quantity, l.entry_price, l.exit_price, l.realized_native, l.source
    FROM trade_realized_legs l JOIN trades t ON t.id = l.trade_id WHERE t.account_id = ? ORDER BY l.id`).all(SLEEVE);
}

beforeAll(() => { makeTestDb(); });
beforeEach(() => { getDB().exec("DROP TRIGGER IF EXISTS crash_between_writes"); resetState(); });

describe("first rebalance (empty book)", () => {
  test("buys to the target with deterministic ids, one PORTFOLIO row per symbol, decision persisted as submitted", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const e = engine(venue);
    const rep = await e.runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(rep.rejected).toBe(0);
    expect(venue.submits.map(s => s.order.symbol)).toEqual(["SPY", "TLT"]);
    expect(venue.submits[0].clientOrderId).toBe(portfolioClientOrderId(SLEEVE, SESSION, "SPY"));
    // 0.5 × 10 000 / 500 = 10 SPY; 0.3 × 10 000 / 90 = 33.33… TLT (fractional)
    expect(venue.submits[0].order.qty).toBeCloseTo(10, 9);
    expect(venue.submits[1].order.qty).toBeCloseTo(3000 / 90, 9);
    const r = rows();
    expect(r.map(x => x.symbol).sort()).toEqual(["SPY", "TLT"]);
    for (const x of r) { expect(x.strategy).toBe(PORTFOLIO_ENGINE_STRATEGY); expect(x.strategyVersion).toBe(VERSION); expect(x.id.startsWith("pf_")).toBe(true); }
    const dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(dec.status).toBe("submitted");
    expect(dec.equity).toBe(10_000);
    expect(dec.weights).toEqual({ SPY: 0.5, TLT: 0.3 });
    expect(dec.orders.every(o => o.applied && o.result?.ok)).toBe(true);
    expect(dec.memory).toEqual({ n: 2, lastAsOf: AS_OF }); // decision + post-fill refresh on the actual book
    expect(e.beats).toEqual([]); // runSession alone does not beat; tick() does
  });

  test("the next session reads this version's memory and the rows as the book (no re-buy of held qty)", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const e = engine(venue);
    await e.runSession(WINDOW);
    const decide = fixedDecide({ SPY: 0.5, TLT: 0.3 });
    const e2 = engine(venue, { decide }, histDb("2026-10-20"));
    const rep = await e2.runSession({ session: "2026-10-21", asOf: "2026-10-20" });
    expect(rep.status).toBe("submitted");
    expect(decide.calls[0].book.memory).toEqual({ n: 2, lastAsOf: AS_OF });
    expect(decide.calls[0].book.positions.map(p => p.symbol)).toEqual(["SPY", "TLT"]);
    expect(rep.orders).toHaveLength(0); // already at target
    expect(latestPortfolioMemory(SLEEVE, VERSION)).toEqual({ n: 4, lastAsOf: "2026-10-20" });
    expect(latestPortfolioMemory(SLEEVE, "other-version")).toEqual({});
  });
});

describe("stock-market-closed logging", () => {
  test("logs once per closed period and never submits while the market is closed", async () => {
    const venue = new FakeVenue();
    let now = Date.parse("2026-10-18T14:00:00Z"); // Saturday
    const e = engine(venue, { now: () => now });
    const output: string[] = [];
    const realLog = console.log;
    console.log = (...args: any[]) => output.push(args.join(" "));
    try {
      await e.tick();
      await e.tick();
      now = NOW; // market open: reset the transition state
      expect((e as any).stockMarketClosed()).toBe(false);
      now = Date.parse("2026-10-18T14:00:00Z");
      await e.tick();
    } finally {
      console.log = realLog;
    }
    expect(venue.submits).toHaveLength(0);
    expect(output.filter(line => line.includes("skip: stock market closed (outside regular market hours)"))).toHaveLength(2);
  });
});

describe("adoption (first live run)", () => {
  test("legacy MOMENTUM rows of the sleeve are re-tagged, never sold and re-bought", async () => {
    // Held: 10 SPY @ 480 from the old engine; broker agrees.
    seedOpenTrade("legacy-spy", SLEEVE, { symbol: "SPY", strategy: "MOMENTUM", entryPrice: 480, quantity: 10 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: 10, avgEntryPrice: 480 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    // Equity = 10 000 + (500−480)×10 = 10 200; SPY target 0.5 → 10.2 shares → buy 0.2.
    const e = engine(venue, { decide: fixedDecide({ SPY: 0.5 }) });
    const rep = await e.runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits).toHaveLength(1);
    expect(venue.submits[0].order.side).toBe("buy");
    expect(venue.submits[0].order.qty).toBeCloseTo(0.2, 6);
    const r = row("SPY");
    expect(r.id).toBe("legacy-spy");                     // same row, grown — not closed/re-opened
    expect(r.strategy).toBe(PORTFOLIO_ENGINE_STRATEGY);
    expect(r.strategy_version).toBe(VERSION);
    expect(r.quantity).toBeCloseTo(10.2, 6);
    expect(r.entry_price).toBeCloseTo((480 * 10 + 500 * 0.2) / 10.2, 6);
    expect(getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = ? AND status = 'closed'`).get(SLEEVE)).toEqual({ c: 0 });
  });

  test("a broker position of the universe with no row anywhere becomes a row at the broker basis", async () => {
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "GLD", qty: 5, avgEntryPrice: 190 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.behavior.GLD = { kind: "reject" }; // the tiny top-up is refused: the adopted row stays at the broker basis
    const e = engine(venue, { decide: fixedDecide({ GLD: 0.1 }) }); // 0.1 × 10 050 / 200 = 5.025 → buy 0.025
    await e.runSession(WINDOW);
    const r = row("GLD");
    expect(r).toBeTruthy();
    expect(r.strategy).toBe(PORTFOLIO_ENGINE_STRATEGY);
    expect(r.entry_price).toBe(190);
    expect(r.quantity).toBe(5);
    expect(venue.submits[0].order.qty).toBeCloseTo(0.025, 9);
  });
});

describe("partial fills, rejections, decreases", () => {
  test("a partial fill records only the filled quantity", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.behavior.SPY = { kind: "partial", fraction: 0.5 };
    const e = engine(venue, { decide: fixedDecide({ SPY: 0.5 }) });
    const rep = await e.runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(row("SPY").quantity).toBeCloseTo(5, 9);
    expect(rep.orders[0].result).toMatchObject({ filledQty: 5, status: "canceled", ok: false });
    expect(rep.rejected).toBe(1); // not ok → reported, but the fill is on the row
  });

  test("a rejection leaves no row, counts as rejected and pages once", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.behavior.TLT = { kind: "reject", error: "insufficient buying power" };
    const e = engine(venue);
    const rep = await e.runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(rep.rejected).toBe(1);
    expect(row("TLT")).toBeFalsy();
    expect(row("SPY")).toBeTruthy();
    expect(e.alerts).toHaveLength(1);
    expect(e.alerts[0]).toContain("insufficient buying power");
    const dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(dec.orders.find(o => o.intent.symbol === "TLT")!.result).toMatchObject({ ok: false, status: "rejected" });
  });

  test("a decrease records partial realized P&L; a full exit closes with PORTFOLIO_REBALANCE and the summed pnl", async () => {
    seedOpenTrade("pf_spy", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 400, quantity: 10 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: 10, avgEntryPrice: 400 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    // equity 10 000 + 1 000 = 11 000; target 0.25 → 5.5 shares → sell 4.5
    const e = engine(venue, { decide: fixedDecide({ SPY: 0.25 }) });
    await e.runSession(WINDOW);
    expect(venue.submits[0].order).toMatchObject({ side: "sell", reduceOnly: true });
    expect(venue.submits[0].order.qty).toBeCloseTo(4.5, 9);
    let r = row("SPY");
    expect(r.status).toBe("open");
    expect(r.quantity).toBeCloseTo(5.5, 9);
    expect(r.partial_realized_native).toBeCloseTo(4.5 * 100, 6);
    expect(r.entry_price).toBe(400);
    // Next session: weight 0 → sell everything → closed, pnl = 450 + 5.5×100.
    const e2 = engine(venue, { decide: fixedDecide({}) }, histDb("2026-10-20"));
    await e2.runSession({ session: "2026-10-21", asOf: "2026-10-20" });
    r = row("SPY");
    expect(r.status).toBe("closed");
    expect(r.close_reason).toBe(PORTFOLIO_REBALANCE_CLOSE_REASON);
    expect(r.pnl).toBeCloseTo(1000, 6);
    expect(r.exit_price).toBe(500);
    expect(rows()).toHaveLength(0);
  });
});

describe("MAX_HOLD with the real Alpaca venue", () => {
  const qty = 2.733856978;
  const entryTime = Date.parse("2026-10-12T14:00:00Z");
  const config: VolManagedConfig = { kind: "volManaged", universe: ["SPY"], inceptionGuardBars: 20,
    volLookback: 20, covLookback: 20, portfolioVolTarget: 0.15, annualization: 252,
    perAssetCap: 1, maxGross: 1, maxHoldSessions: 5, maxHoldStagger: true };

  function setup(mode: "partial" | "unfilled" | "partial_unfilled" | "pending" | "zero") {
    seedOpenTrade("expired", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: qty, entryTime });
    // Even aggregate excess at the broker is NOT this sleeve's to sell.
    seedOpenTrade("other-sleeve", "meanrev_stocks", { symbol: "SPY", strategy: "MOMENTUM", entryPrice: 500, quantity: 7 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: qty + 7, avgEntryPrice: 500 }];
    venue.prices_ = { SPY: 500 };
    const sent: any[] = [], book = new Map<string, any>();
    const state = { mode, t: 0, session: SESSION, ambiguousRemainder: false, lookupFails: false };
    const real = new AlpacaVenue({ isConnected: () => true, getPositions: async () => [], getLatestPrice: async () => 500,
      getOpenStopOrders: async () => { throw Error("must not touch the stop book"); },
      cancelOrderById: async () => { throw Error("must not cancel another sleeve's stop"); } }, {
      createOrder: async p => {
        const id = String(p.client_order_id);
        if (book.has(id)) throw Object.assign(Error("duplicate client_order_id"), { status: 422 });
        sent.push(p);
        const o = { id, status: "filled", filled_qty: String(p.qty), filled_avg_price: id.endsWith("-r1") ? "502" : "500" };
        if (p.side === "sell" && (state.mode === "unfilled" || (state.mode === "partial_unfilled" && id.endsWith("-r1")))) Object.assign(o, { status: "canceled", filled_qty: "0" });
        else if (p.side === "sell" && !id.endsWith("-r1")) Object.assign(o, { status: "canceled", filled_qty: state.mode === "zero" ? "0" : "1" });
        else if (p.side === "sell" && state.mode === "pending") Object.assign(o, { status: "pending_cancel", filled_qty: "0" });
        book.set(id, o);
        if (id.endsWith("-r1")) {
          const journal = getPortfolioDecision(SLEEVE, VERSION, state.session)!;
          expect(journal.orders.find(o => o.clientOrderId === id)).toMatchObject({ applied: false, result: null });
          expect(journal.orders[0].applied).toBe(true);
          if (state.ambiguousRemainder) throw Error("response lost after fill");
        }
        return o;
      },
      getOrder: async id => book.get(id),
      getOrderByClientId: async id => { if (id.endsWith("-r1") && state.lookupFails) throw Object.assign(Error("unknown"), { status: 503 }); return book.get(id); },
      cancelOrder: async () => {},
    }, { fillTimeoutMs: 1_000, pollIntervalMs: 1_000, releaseConfirmTimeoutMs: 2_000,
      sleep: async ms => { state.t += ms; }, now: () => state.t });
    venue.submit = async (order, id) => { venue.submits.push({ order, clientOrderId: id }); return real.submit(order, id); };
    return { venue, state, sent, book };
  }

  for (const mode of ["partial", "zero"] as const) test(`${mode} close → confirmed remainder → only THEN rebuy; separate executions, MAX_HOLD ledger and other sleeve intact`, async () => {
    const { venue, sent } = setup(mode);
    const rep = await engine(venue, { config, decide: coreDecide }).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(rep.rejected).toBe(1); // first broker order really was canceled; the retry filled
    expect(sent.map(p => p.side)).toEqual(["sell", "sell", "buy"]);
    const remainder = mode === "partial" ? 1.733856978 : qty;
    expect(sent.slice(0, 2).map(p => p.qty)).toEqual([String(qty), String(remainder)]);
    expect(sent[1].client_order_id).toBe(`${sent[0].client_order_id}-r1`);
    expect(getDB().query("SELECT status, close_reason FROM trades WHERE id='expired'").get()).toEqual({ status: "closed", close_reason: "MAX_HOLD" });
    expect((getDB().query("SELECT pnl FROM trades WHERE id='expired'").get() as any).pnl).toBeCloseTo(remainder * 2, 8);
    expect(row("SPY").entry_time).toBe(NOW);
    expect(countExecutedOrders(NOW - 1, NOW, SLEEVE)).toBe(mode === "partial" ? 3 : 2);
    expect(getDB().query("SELECT quantity, status FROM trades WHERE id='other-sleeve'").get()).toEqual({ quantity: 7, status: "open" });
  });

  test("still-working remainder defers rebuy and row application; restart recovers cumulative fills exactly once", async () => {
    const { venue, sent, book } = setup("pending");
    const e = engine(venue, { config, decide: coreDecide });
    expect((await e.runSession(WINDOW)).status).toBe("failed");
    expect(sent.map(p => p.side)).toEqual(["sell", "sell"]);
    expect(row("SPY").quantity).toBeCloseTo(qty - 1, 9);
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[0].applied).toBe(true);
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[1].applied).toBe(false);
    const remainder = [...book.values()].find(o => o.id.endsWith("-r1"))!;
    Object.assign(remainder, { status: "filled", filled_qty: "1.733856978" });
    expect((await engine(venue, { config, decide: coreDecide }).runSession(WINDOW)).status).toBe("resumed");
    expect(sent.map(p => p.side)).toEqual(["sell", "sell", "buy"]);
    expect(getDB().query("SELECT status, close_reason FROM trades WHERE id='expired'").get()).toEqual({ status: "closed", close_reason: "MAX_HOLD" });
    expect((await e.runSession(WINDOW)).status).toBe("already_done");
    expect(sent).toHaveLength(3);
  });

  test("Q7 V1 atomic apply: a crash between the first leg's row write and its journal write persists nothing; the resume applies that leg once, then -r1 and the rebuy; book and legs equal a clean run", async () => {
    // Clean run first: the reference book.
    {
      const { venue } = setup("partial");
      expect((await engine(venue, { config, decide: coreDecide }).runSession(WINDOW)).status).toBe("submitted");
    }
    const clean = { book: bookSnapshot(), legs: legsSnapshot() };
    resetState();
    const { venue, sent, book } = setup("partial");
    const recover = crashBetweenWrites(`(SELECT quantity FROM trades WHERE id = 'expired') < ${qty}`);
    const rep = await engine(venue, { config, decide: coreDecide }).runSession(WINDOW);
    expect(rep.status).toBe("failed");
    expect(rep.note).toContain("crash between book and journal");
    expect(sent.map(p => p.side)).toEqual(["sell"]); // the broker DID fill 1 share of it
    expect(row("SPY")).toMatchObject({ quantity: qty, status: "open" }); // …but the book is untouched
    expect(legsSnapshot()).toEqual([]);
    const journal = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(journal.status).toBe("decided");
    expect(journal.orders.map(o => o.clientOrderId!.endsWith("-r1"))).toEqual([false, false]); // the -r1 leg was NOT journaled either
    expect(journal.orders[0]).toMatchObject({ applied: false, result: null });
    recover();
    const resumed = await engine(venue, { config, decide: coreDecide }).runSession(WINDOW);
    expect(resumed.status).toBe("resumed");
    expect(sent.map(p => p.side)).toEqual(["sell", "sell", "buy"]); // the first id was answered by the venue's existing order, never re-created
    expect(venue.submits.filter(s => s.clientOrderId === sent[0].client_order_id)).toHaveLength(2);
    expect(book.size).toBe(3); // close, its -r1 remainder, rebuy: three broker orders, as in the clean run
    expect(bookSnapshot()).toEqual(clean.book);
    expect(legsSnapshot()).toEqual(clean.legs);
    expect(countExecutedOrders(NOW - 1, NOW, SLEEVE)).toBe(3);
    // Execution record: the remainder leg is its own labeled execution with the parent's decision price.
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders.map(o => [o.label, o.decisionPrice]))
      .toEqual([["max_hold_close", 500], ["retry", 500], ["max_hold_rebuy", 500]]);
  });

  test("ambiguous retry fill survives restart without reapplying the first fill or selling twice", async () => {
    const { venue, state, sent } = setup("partial");
    state.ambiguousRemainder = state.lookupFails = true;
    expect((await engine(venue, { config, decide: coreDecide }).runSession(WINDOW)).status).toBe("failed");
    expect(sent).toHaveLength(2);
    expect(row("SPY").quantity).toBeCloseTo(qty - 1, 9);
    state.ambiguousRemainder = state.lookupFails = false;
    expect((await engine(venue, { config, decide: coreDecide }).runSession(WINDOW)).status).toBe("resumed");
    expect(sent.map(p => p.side)).toEqual(["sell", "sell", "buy"]);
    expect(countExecutedOrders(NOW - 1, NOW, SLEEVE)).toBe(3);
  });

  for (const mode of ["unfilled", "partial_unfilled"] as const) test(`${mode}: retry is bounded; age is preserved and NEXT session closes overdue remainder before any buy`, async () => {
    const { venue, state, sent } = setup(mode);
    const first = await engine(venue, { config, decide: coreDecide }).runSession(WINDOW);
    expect(first.orders.find(o => o.intent.maxHold === "rebuy")!.skipped).toBe("max_hold_close_incomplete");
    expect(sent.map(p => p.side)).toEqual(["sell", "sell"]);
    const remaining = mode === "unfilled" ? qty : qty - 1;
    expect(row("SPY")).toMatchObject({ entry_time: entryTime, quantity: remaining, status: "open" });
    state.mode = "partial";
    state.session = "2026-10-21";
    const next = await engine(venue, { config, decide: coreDecide, now: () => Date.parse("2026-10-21T14:00:00Z") }, histDb("2026-10-20"))
      .runSession({ session: "2026-10-21", asOf: "2026-10-20" });
    expect(next.rejected).toBe(1);
    expect(next.orders[0].intent).toMatchObject({ side: "sell", maxHold: "close", qty: remaining });
    expect(sent.slice(2).map(p => p.side)).toEqual(["sell", "sell", "buy"]);
    expect(getDB().query("SELECT close_reason FROM trades WHERE id='expired'").get()).toEqual({ close_reason: "MAX_HOLD" });
  });
});

describe("a BUY whose cancel never settles (real Alpaca venue)", () => {
  // B-6: before, the partial was applied and the order marked applied; the late fill became
  // "excess not ours" at the broker and the sleeve bought the symbol again.
  test("the pass fails with the buy unapplied and no row; a restart resumes the SAME id and applies the late fill once", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const book = new Map<string, any>();
    const state = { t: 0, settled: false };
    const real = new AlpacaVenue({ isConnected: () => true, getPositions: async () => [], getLatestPrice: async () => 500 }, {
      createOrder: async p => {
        const id = String(p.client_order_id);
        if (book.has(id)) throw Object.assign(Error("duplicate client_order_id"), { status: 422 });
        const o = { id, status: "accepted", filled_qty: "0", filled_avg_price: null };
        book.set(id, o);
        return o;
      },
      getOrder: async id => book.get(id),
      getOrderByClientId: async id => book.get(id),
      cancelOrder: async id => { const o = book.get(id); Object.assign(o, state.settled ? { status: "filled", filled_qty: "10", filled_avg_price: "500" } : { status: "pending_cancel", filled_qty: "4", filled_avg_price: "500" }); },
    }, { fillTimeoutMs: 1_000, pollIntervalMs: 1_000, releaseConfirmTimeoutMs: 2_000, sleep: async ms => { state.t += ms; }, now: () => state.t });
    venue.submit = async (order, id) => { venue.submits.push({ order, clientOrderId: id }); return real.submit(order, id); };
    const opts: Partial<PortfolioEngineOptions> = { decide: fixedDecide({ SPY: 0.5 }) };
    expect((await engine(venue, opts, histDb()).runSession(WINDOW)).status).toBe("failed");
    expect(rows()).toEqual([]); // the 4-share partial of a still-working order is NOT booked
    const journal = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(journal.status).toBe("decided");
    expect(journal.orders[0]).toMatchObject({ applied: false, result: { status: "unknown", filledQty: 0 } });
    expect(journal.orders[0].result!.error).toContain("still working");
    // The order filled fully after the cancel ACK; the restart resumes with the same id.
    Object.assign(book.get(journal.orders[0].clientOrderId!), { status: "filled", filled_qty: "10", filled_avg_price: "500" });
    expect((await engine(venue, opts, histDb()).runSession(WINDOW)).status).toBe("resumed");
    expect(venue.submits.map(s => s.clientOrderId)).toEqual([journal.orders[0].clientOrderId!, journal.orders[0].clientOrderId!]);
    expect(rows().map(r => [r.symbol, r.quantity])).toEqual([["SPY", 10]]);
    expect((await engine(venue, opts, histDb()).runSession(WINDOW)).status).toBe("already_done");
    expect(rows()[0].quantity).toBe(10);
  });
});

describe("broker = truth", () => {
  test("broker holds less than the row → the row shrinks before the decision; more → untouched and reported", async () => {
    seedOpenTrade("pf_spy", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 400, quantity: 10 });
    seedOpenTrade("pf_tlt", SLEEVE, { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 90, quantity: 10 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: 6, avgEntryPrice: 400 }, { symbol: "TLT", qty: 15, avgEntryPrice: 90 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const decide = fixedDecide({});
    const e = engine(venue, { decide });
    await e.runSession(WINDOW);
    const book = decide.calls[0].book;
    expect(book.positions.find(p => p.symbol === "SPY")!.qty).toBeCloseTo(6, 9);
    expect(book.positions.find(p => p.symbol === "TLT")!.qty).toBe(10); // excess 5 is not ours
    // The 4 SPY that vanished externally were realized at the reference price.
    const spyRowBefore = getDB().prepare(`SELECT partial_realized_native p FROM trades WHERE id = 'pf_spy'`).get() as any;
    expect(spyRowBefore.p).toBeCloseTo(400, 6);
    const dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(String((dec.diagnostics as any).drift)).toContain("TLT");
    // Then weight 0 sold both: SPY 6 and TLT 10 (never the broker's 15).
    expect(venue.submits.find(s => s.order.symbol === "TLT")!.order.qty).toBe(10);
    expect(venue.submits.find(s => s.order.symbol === "SPY")!.order.qty).toBeCloseTo(6, 9);
  });

  test("broker flat for a row → the row closes PORTFOLIO_RECONCILED", async () => {
    seedOpenTrade("pf_gld", SLEEVE, { symbol: "GLD", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 190, quantity: 2 });
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    await engine(venue, { decide: fixedDecide({}) }).runSession(WINDOW);
    expect(row("GLD")).toMatchObject({ status: "closed", close_reason: PORTFOLIO_RECONCILED_CLOSE_REASON });
    expect(venue.submits).toHaveLength(0);
  });
});

describe("stale data", () => {
  test("data ending before the previous session → skipped, alert once, nothing submitted; retried when fresh", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const stale = histDb("2026-10-16");
    const e = engine(venue, {}, stale);
    const rep = await e.runSession(WINDOW);
    expect(rep.status).toBe("skipped_stale");
    expect(rep.note).toContain("stale [GLD, SPY, TLT]".replace("GLD, SPY, TLT", rep.note!.match(/stale \[(.*?)\]/)![1]));
    expect(venue.submits).toHaveLength(0);
    expect(e.alerts).toHaveLength(1);
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.status).toBe("skipped_stale");
    // Same session, data refreshed meanwhile → the pass runs.
    await e.runSession(WINDOW); // still stale: no second alert
    expect(e.alerts).toHaveLength(1);
    const fresh = engine(venue, {}, histDb());
    const rep2 = await fresh.runSession(WINDOW);
    expect(rep2.status).toBe("submitted");
    expect(venue.submits).toHaveLength(2);
    expect(listPortfolioDecisions(SLEEVE)).toHaveLength(1); // same key, overwritten
  });

  // B-7 (2026-11-07): the five-session rule used to depend on the 04:00 data refresh — a stale
  // pass skipped the MAX_HOLD closes too.
  describe("closes-only on stale data", () => {
    const config: VolManagedConfig = { kind: "volManaged", universe: ["SPY"], inceptionGuardBars: 20, volLookback: 20, covLookback: 20,
      portfolioVolTarget: 0.15, annualization: 252, perAssetCap: 1, maxGross: 1, maxHoldSessions: 5, maxHoldStagger: true };
    const STALE_CID = portfolioClientOrderId(SLEEVE, SESSION, "SPY", "stale-close");
    const stale = () => histDb("2026-10-16", ["SPY"]);
    const freshDb = () => histDb(AS_OF, ["SPY"]);
    function setup(expired = true) {
      seedOpenTrade("lot", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 4,
        entryTime: Date.parse(expired ? "2026-10-12T14:00:00Z" : "2026-10-16T14:00:00Z") });
      const venue = new FakeVenue();
      venue.positions_ = [{ symbol: "SPY", qty: 4, avgEntryPrice: 500 }];
      venue.prices_ = { SPY: 510 };
      return venue;
    }
    const opts = (over: Partial<PortfolioEngineOptions> = {}): Partial<PortfolioEngineOptions> => ({ config, decide: coreDecide, ...over });

    test("stale + expired lot → the MAX_HOLD close is sent with its own id, no rebuy; the record stays skipped_stale; a repeat stale tick resends nothing", async () => {
      const venue = setup();
      const e = engine(venue, opts(), stale());
      const rep = await e.runSession(WINDOW);
      expect(rep.status).toBe("skipped_stale");
      expect(venue.submits.map(s => [s.clientOrderId, s.order.side, s.order.maxHold, s.order.qty])).toEqual([[STALE_CID, "sell", "close", 4]]);
      expect(row("SPY")).toMatchObject({ status: "closed", close_reason: "MAX_HOLD" });
      expect(rows()).toEqual([]); // closes only: nothing bought back on stale data
      const rec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
      expect(rec.status).toBe("skipped_stale");
      expect(rec.orders).toHaveLength(1);
      expect(rec.orders[0]).toMatchObject({ clientOrderId: STALE_CID, applied: true, result: { ok: true, filledQty: 4 } });
      expect(e.alerts).toHaveLength(1);
      expect(e.alerts[0]).toContain("1 MAX_HOLD close(s) sent anyway");
      expect((await e.runSession(WINDOW)).status).toBe("skipped_stale");
      expect((await engine(venue, opts(), stale()).runSession(WINDOW)).status).toBe("skipped_stale"); // restart, still stale
      expect(venue.submits).toHaveLength(1);
      expect(e.alerts).toHaveLength(1);
    });

    test("a lot that is not expired is left alone on stale data", async () => {
      const venue = setup(false);
      expect((await engine(venue, opts(), stale()).runSession(WINDOW)).status).toBe("skipped_stale");
      expect(venue.submits).toHaveLength(0);
      expect(row("SPY").status).toBe("open");
    });

    test("fresh data later in the session → the normal pass decides on the remaining book: no second close, the stale fill stays in the journal", async () => {
      const venue = setup();
      await engine(venue, opts(), stale()).runSession(WINDOW);
      const rep = await engine(venue, opts(), freshDb()).runSession(WINDOW);
      expect(rep.status).toBe("submitted");
      expect(venue.submits.filter(s => s.order.side === "sell")).toHaveLength(1);
      expect(venue.submits.filter(s => s.order.side === "buy").length).toBeGreaterThan(0); // re-entered at the design's weight, new lot
      expect(row("SPY")).toMatchObject({ status: "open", entry_time: NOW });
      const rec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
      expect(rec.status).toBe("submitted");
      expect(rec.orders[0]).toMatchObject({ clientOrderId: STALE_CID, applied: true });
      expect(rec.orders.filter(o => o.intent.maxHold === "close")).toHaveLength(1);
      expect(countExecutedOrders(NOW - 1, NOW, SLEEVE)).toBe(venue.submits.length);
      expect((await engine(venue, opts(), freshDb()).runSession(WINDOW)).status).toBe("already_done");
    });

    test("another version the same session is not blocked by the closes-only record and never resends the close", async () => {
      const venue = setup();
      await engine(venue, opts(), stale()).runSession(WINDOW);
      const rep = await engine(venue, opts({ strategyVersion: "new-version" }), freshDb()).runSession(WINDOW);
      expect(rep.status).toBe("submitted");
      expect(venue.submits.filter(s => s.order.side === "sell")).toHaveLength(1);
      expect(getPortfolioDecision(SLEEVE, "new-version", SESSION)!.status).toBe("submitted");
    });

    test("venue outcome unknown during the stale close → failed, journal unapplied; a restart (still stale) resumes the SAME id once; fresh data then decides", async () => {
      const venue = setup();
      venue.behavior.SPY = { kind: "throw", error: "socket hang up" };
      expect((await engine(venue, opts(), stale()).runSession(WINDOW)).status).toBe("failed");
      const rec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
      expect(rec.status).toBe("skipped_stale");
      expect(rec.orders[0]).toMatchObject({ clientOrderId: STALE_CID, applied: false, result: { status: "unknown" } });
      expect(row("SPY").status).toBe("open");
      venue.behavior = {};
      expect((await engine(venue, opts(), stale()).runSession(WINDOW)).status).toBe("skipped_stale");
      expect(venue.submits.map(s => s.clientOrderId)).toEqual([STALE_CID, STALE_CID]); // same id, venue dedups
      expect(row("SPY")).toMatchObject({ status: "closed", close_reason: "MAX_HOLD" });
      expect((await engine(venue, opts(), freshDb()).runSession(WINDOW)).status).toBe("submitted");
      expect(venue.submits.filter(s => s.order.side === "sell")).toHaveLength(2); // the two attempts of ONE order
      expect(countExecutedOrders(NOW - 1, NOW, SLEEVE)).toBe(venue.submits.length - 1);
    });

    test("fresh data arriving while a stale close is still unsettled: the close is finished first, then the pass decides", async () => {
      const venue = setup();
      venue.behavior.SPY = { kind: "throw", error: "socket hang up" };
      expect((await engine(venue, opts(), stale()).runSession(WINDOW)).status).toBe("failed");
      venue.behavior = {};
      const rep = await engine(venue, opts(), freshDb()).runSession(WINDOW);
      expect(rep.status).toBe("submitted");
      expect(venue.submits.filter(s => s.order.side === "sell").map(s => s.clientOrderId)).toEqual([STALE_CID, STALE_CID]);
      expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[0]).toMatchObject({ clientOrderId: STALE_CID, applied: true });
      expect(row("SPY")).toMatchObject({ status: "open", entry_time: NOW });
    });
  });

  test("one missing symbol is tolerated when maxStaleSymbols allows it", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const db = histDb(AS_OF, ["SPY", "TLT"]); // GLD missing entirely
    expect((await engine(venue, {}, db).runSession(WINDOW)).status).toBe("skipped_stale");
    expect((await engine(venue, { maxStaleSymbols: 1 }, db).runSession(WINDOW)).status).toBe("submitted");
  });
});

describe("observer mode", () => {
  test("computes and persists, submits nothing, mutates no row", async () => {
    seedOpenTrade("legacy-spy", SLEEVE, { symbol: "SPY", strategy: "MOMENTUM", entryPrice: 480, quantity: 10 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: 10, avgEntryPrice: 480 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const e = engine(venue, { mode: "observer", strategyVersion: "d1-observer" });
    const rep = await e.runSession(WINDOW);
    expect(rep.status).toBe("observed");
    expect(venue.submits).toHaveLength(0);
    expect(rep.orders.length).toBeGreaterThan(0);
    expect(rep.orders.every(o => o.skipped === "observer" && o.clientOrderId === null && !o.applied)).toBe(true);
    const r = row("SPY");
    expect(r).toMatchObject({ id: "legacy-spy", strategy: "MOMENTUM", quantity: 10 }); // untouched
    const dec = getPortfolioDecision(SLEEVE, "d1-observer", SESSION)!;
    expect(dec.mode).toBe("observer");
    expect(dec.status).toBe("observed");
    expect(dec.orders.map(o => o.intent.symbol)).toEqual(rep.orders.map(o => o.intent.symbol));
    // A second pass the same session is a no-op.
    expect((await e.runSession(WINDOW)).status).toBe("already_done");
  });
});

describe("idempotency across a restart within a session", () => {
  for (const status of ["submitted", "decided", "observed"] as const) test(`a cutover after a ${status} pass waits for the next session, without inheriting memory`, async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    await engine(venue).tick();
    const prior = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    savePortfolioDecision({ ...prior, status });
    const submits = venue.submits.length;
    const decide = fixedDecide({ GLD: 0.2 });
    let now = Date.parse("2026-10-20T15:00:00Z"); // cutover during regular hours
    const next = engine(venue, { strategyVersion: "new-version", decide, now: () => now }, histDb(SESSION));
    expect((await next.tick()).status).toBe("already_done");
    expect(venue.submits).toHaveLength(submits);
    expect(decide.calls).toHaveLength(0);
    expect(getPortfolioDecision(SLEEVE, "new-version", SESSION)).toBeNull();
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)).toEqual({ ...prior, status });
    now = Date.parse("2026-10-21T13:35:00Z");
    expect((await next.tick()).status).toBe("submitted");
    expect(decide.calls[0].book.memory).toEqual({});
    expect(getPortfolioDecision(SLEEVE, "new-version", "2026-10-21")!.status).toBe("submitted");
  });

  test("a cutover before the day's pass decides with the new version; another sleeve does not block it", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    await engine(venue, { accountId: "meanrev_stocks", decide: fixedDecide({}) }).tick();
    const decide = fixedDecide({ GLD: 0.2 });
    expect((await engine(venue, { strategyVersion: "new-version", decide }).tick()).status).toBe("submitted");
    expect(decide.calls[0].book.memory).toEqual({});
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)).toBeNull();
    expect(getPortfolioDecision(SLEEVE, "new-version", SESSION)!.status).toBe("submitted");
  });

  test("a stale skip by the previous version did not decide and does not block the new version", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    expect((await engine(venue, {}, histDb("2026-10-16")).tick()).status).toBe("skipped_stale");
    expect((await engine(venue, { strategyVersion: "new-version" }).tick()).status).toBe("submitted");
  });

  test("overlapping versions recheck the session after awaiting venue data", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const reports = await Promise.all([
      engine(venue).tick(),
      engine(venue, { strategyVersion: "new-version" }).tick(),
    ]);
    expect(reports.map(r => r.status).sort()).toEqual(["already_done", "submitted"]);
    expect(listPortfolioDecisions(SLEEVE)).toHaveLength(1);
    expect(venue.submits).toHaveLength(2);
  });

  test("a completed session is not re-run; a crash mid-submission resumes only the unapplied orders with the same ids", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    // First process: TLT's transport dies after SPY filled → pass fails with the decision persisted as 'decided'.
    venue.behavior.TLT = { kind: "throw", error: "socket hang up" };
    const e1 = engine(venue);
    const rep1 = await e1.runSession(WINDOW);
    expect(rep1.status).toBe("failed");
    const dec1 = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(dec1.status).toBe("decided");
    expect(dec1.orders.find(o => o.intent.symbol === "SPY")!.applied).toBe(true);
    expect(dec1.orders.find(o => o.intent.symbol === "TLT")!.applied).toBe(false);
    expect(row("SPY").quantity).toBeCloseTo(10, 9);
    // "Restart": a fresh engine on the same DB, venue healthy again.
    venue.behavior = {};
    const decide = fixedDecide({ SPY: 0.9, TLT: 0.9 }); // a re-DECISION would re-plan at 0.9 — must not happen
    const e2 = engine(venue, { decide });
    const rep2 = await e2.runSession(WINDOW);
    expect(rep2.status).toBe("resumed");
    expect(decide.calls).toHaveLength(1); // only the post-fill stop/memory refresh on the actual book
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.weights).toEqual({ SPY: 0.5, TLT: 0.3 }); // original target kept
    expect(rep2.orders.map(o => o.intent.symbol)).toEqual(["SPY", "TLT"]); // no new orders planned
    const tltSubmits = venue.submits.filter(s => s.order.symbol === "TLT");
    expect(tltSubmits).toHaveLength(2); // the failed one + the resume
    expect(new Set(tltSubmits.map(s => s.clientOrderId)).size).toBe(1); // same deterministic id
    expect(venue.submits.filter(s => s.order.symbol === "SPY")).toHaveLength(1); // SPY never resent
    expect(row("SPY").quantity).toBeCloseTo(10, 9); // not doubled
    expect(row("TLT").quantity).toBeCloseTo(3000 / 90, 9);
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.status).toBe("submitted");
    // Third process: nothing to do.
    const e3 = engine(venue, { decide });
    expect((await e3.runSession(WINDOW)).status).toBe("already_done");
    expect(venue.submits).toHaveLength(3);
  });

  test("the venue's duplicate-id answer is applied once even when the fill happened before the crash", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const e1 = engine(venue, { decide: fixedDecide({ SPY: 0.5 }) });
    await e1.runSession(WINDOW);
    // Simulate a crash AFTER the broker filled but BEFORE the row/progress write:
    // roll the persisted order back to unapplied and drop the row.
    getDB().exec(`DELETE FROM trades WHERE account_id = '${SLEEVE}'`);
    const dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    for (const o of dec.orders) { o.applied = false; o.result = null; }
    getDB().prepare(`UPDATE portfolio_decisions SET status = 'decided', orders_json = ? WHERE id = ?`).run(JSON.stringify(dec.orders), dec.id!);
    const e2 = engine(venue, { decide: fixedDecide({ SPY: 0.5 }) });
    const rep = await e2.runSession(WINDOW);
    expect(rep.status).toBe("resumed");
    expect(venue.submits).toHaveLength(2);
    expect(venue.positions_.find(p => p.symbol === "SPY")!.qty).toBeCloseTo(10, 9); // venue filled ONCE
    expect(row("SPY").quantity).toBeCloseTo(10, 9);
  });
});

describe("trading kill-switch and stops", () => {
  test("TRADING_ENABLED=false skips buys, sells still go", async () => {
    seedOpenTrade("pf_tlt", SLEEVE, { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 90, quantity: 10 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "TLT", qty: 10, avgEntryPrice: 90 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const e = engine(venue, { decide: fixedDecide({ SPY: 0.5 }), tradingEnabled: () => false });
    const rep = await e.runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => s.order.side)).toEqual(["sell"]);
    expect(rep.orders.find(o => o.intent.symbol === "SPY")!.skipped).toBe("trading_disabled");
  });

  // B-2 (2026-11-07): the account-identity halt (instanceManifest → RiskEngine HALTED) only reached
  // the incumbents through SwitchingAdapter; the portfolio engine — the whole Alpaca book — kept buying.
  for (const state of ["HALTED", "REDUCING"] as const) test(`RiskEngine ${state} skips every buy of the pass with its own code; sells and MAX_HOLD closes still go`, async () => {
    seedOpenTrade("pf_tlt", SLEEVE, { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 90, quantity: 10 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "TLT", qty: 10, avgEntryPrice: 90 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const e = engine(venue, { decide: fixedDecide({ SPY: 0.5, GLD: 0.1 }), tradingState: () => state });
    const rep = await e.runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => s.order.side)).toEqual(["sell"]);
    const code = state === "HALTED" ? "risk_engine_halted" : "risk_engine_reducing";
    expect(rep.orders.filter(o => o.intent.side === "buy").map(o => o.skipped)).toEqual([code, code]);
    expect(rep.orders.find(o => o.intent.side === "sell")!.applied).toBe(true);
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders.filter(o => o.skipped === code)).toHaveLength(2);
    expect(rows().map(r => r.symbol)).toEqual([]); // TLT sold, nothing bought
  });

  test("a MAX_HOLD close is sent while HALTED; its rebuy is skipped by the halt, not by an incomplete close", async () => {
    seedOpenTrade("expired", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 4, entryTime: Date.parse("2026-10-12T14:00:00Z") });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: 4, avgEntryPrice: 500 }];
    venue.prices_ = { SPY: 500 };
    const config: VolManagedConfig = { kind: "volManaged", universe: ["SPY"], inceptionGuardBars: 20, volLookback: 20, covLookback: 20,
      portfolioVolTarget: 0.15, annualization: 252, perAssetCap: 1, maxGross: 1, maxHoldSessions: 5 };
    const rep = await engine(venue, { config, decide: coreDecide, tradingState: () => "HALTED" }, histDb(AS_OF, ["SPY"])).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(venue.submits.map(s => `${s.order.side}:${s.order.maxHold}`)).toEqual(["sell:close"]);
    expect(row("SPY")).toMatchObject({ status: "closed", close_reason: "MAX_HOLD" });
    expect(rep.orders.find(o => o.intent.maxHold === "rebuy")!.skipped).toBe("risk_engine_halted");
  });

  test("designs with stops: re-decide on the actual book after fills and sync the venue's stops", async () => {
    const venue = new FakeVenue("binance_usdm", { withStops: true });
    venue.prices_ = { BTC: 60_000, ETH: 3_000 };
    const decide = fixedDecide({ BTC: 0.5, ETH: 0.3 }, { stops: true });
    const db = makeHistDb({ BTC: { sessions: weekdaySessions(AS_OF, 300) }, ETH: { sessions: weekdaySessions(AS_OF, 300) } }, 0);
    const e = engine(venue, { config: CRYPTO_STOP, market: "crypto", rowMarket: "crypto", quoteAsset: "USDT", decide }, db);
    const rep = await e.runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(decide.calls).toHaveLength(2);           // decision + post-fill refresh
    expect(decide.calls[1].book.positions.map(p => p.symbol)).toEqual(["BTC", "ETH"]);
    expect(venue.stopSyncs).toHaveLength(1);
    expect(venue.stopSyncs[0].stops).toEqual([
      { symbol: "BTC", stopPrice: 60_000 * 0.96 }, { symbol: "ETH", stopPrice: 3_000 * 0.96 },
    ]);
    const dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(dec.stops).toHaveLength(2);
    expect(dec.memory).toEqual({ n: 2, lastAsOf: AS_OF }); // the refreshed memory is what the next session reads
  });

  test("a design with stops on a venue without syncStops pages", async () => {
    const venue = new FakeVenue("binance_usdm");
    venue.prices_ = { BTC: 60_000, ETH: 3_000 };
    const db = makeHistDb({ BTC: { sessions: weekdaySessions(AS_OF, 300) }, ETH: { sessions: weekdaySessions(AS_OF, 300) } }, 0);
    const e = engine(venue, { config: CRYPTO_STOP, market: "crypto", rowMarket: "crypto", quoteAsset: "USDT", decide: fixedDecide({ BTC: 0.5 }, { stops: true }) }, db);
    await e.runSession(WINDOW);
    expect(e.alerts.some(a => a.includes("no syncStops"))).toBe(true);
  });
});

describe("tick() scheduling", () => {
  test("an after-hours restart neither decides nor submits, even when runSession is called directly", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const decide = fixedDecide({ SPY: 0.5 });
    const e = engine(venue, { decide, now: () => Date.parse("2026-10-20T22:22:00Z") });
    expect((await e.tick()).status).toBe("not_due");
    expect((await e.runSession(WINDOW)).status).toBe("not_due");
    expect(decide.calls).toHaveLength(0);
    expect(venue.submits).toHaveLength(0);
    expect(listPortfolioDecisions(SLEEVE)).toHaveLength(0);
  });

  test("an after-hours restart does not resume pending orders", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.behavior.TLT = { kind: "throw", error: "socket hang up" };
    expect((await engine(venue).tick()).status).toBe("failed");
    const prior = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    venue.behavior = {};
    const submits = venue.submits.length;
    const e = engine(venue, { now: () => Date.parse("2026-10-20T22:22:00Z") });
    expect((await e.tick()).status).toBe("not_due");
    expect((await e.runSession(WINDOW)).status).toBe("not_due");
    expect(venue.submits).toHaveLength(submits);
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)).toEqual(prior);
  });

  test("a pass crossing the market close leaves remaining orders pending, not submitted", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    let now = Date.parse("2026-10-20T19:59:59Z");
    const submit = venue.submit.bind(venue);
    venue.submit = async (order, id) => {
      const result = await submit(order, id);
      now = Date.parse("2026-10-20T20:00:00Z");
      return result;
    };
    expect((await engine(venue, { now: () => now }).tick()).status).toBe("not_due");
    expect(venue.submits.map(s => s.order.symbol)).toEqual(["SPY"]);
    const prior = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(prior.status).toBe("decided");
    expect(prior.orders.map(o => o.applied)).toEqual([true, false]);
    expect(prior.note).toContain("market closed");
    // The next session (even after a version change/restart) retires the old
    // journal, not its unsent order ids. Today's target is decided afresh.
    venue.submit = submit;
    now = Date.parse("2026-10-21T14:00:00Z");
    const next = engine(venue, { now: () => now, strategyVersion: "next-version" }, histDb(SESSION));
    expect((await next.tick()).status).toBe("submitted");
    const ended = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(ended.status).toBe("submitted");
    expect(ended.note).toContain("session ended with 1 unsent order(s)");
    expect(ended.orders[0]).toEqual(prior.orders[0]);
    expect(ended.orders[1]).toMatchObject({ applied: false, skipped: "session_ended", result: null });
    expect(venue.submits.slice(1).every(s => s.clientOrderId !== prior.orders[1].clientOrderId)).toBe(true);
    expect((await next.tick()).status).toBe("already_done");
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)).toEqual(ended);
  });

  test("not due → beats and does nothing; due → runs once per session, later ticks are already_done", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    let now = Date.parse("2026-10-20T13:00:00Z"); // 09:00 ET — before 09:35
    const e = engine(venue, { now: () => now });
    expect((await e.tick()).status).toBe("not_due");
    expect(e.beats).toEqual(["portfolio:momentum_stocks"]);
    now = Date.parse("2026-10-20T13:36:00Z"); // 09:36 ET
    expect((await e.tick()).status).toBe("submitted");
    expect((await e.tick()).status).toBe("already_done");
    expect(venue.submits).toHaveLength(2);
    now = Date.parse("2026-10-24T14:00:00Z"); // Saturday
    expect((await e.tick()).status).toBe("not_due");
  });

  // F-7 / B-10 (2026-11-07): registered at 24 h × 5 grace, a stopped timer went unnoticed for ~5 days.
  test("heartbeat at the tick cadence: every tick beats (not_due included), a failed pass is alive-but-failing, ~10 min of silence is stale", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    let now = Date.parse("2026-10-20T13:00:00Z"); // 09:00 ET — not due
    const registry = new HeartbeatRegistry(() => now);
    const e = engine(venue, { now: () => now, heartbeats: registry, tickMs: 60_000 });
    e.start(); e.stop(); // start() registers; stop() clears the timers (the test drives tick() itself)
    const status = () => registry.snapshot().find(h => h.name === "portfolio:momentum_stocks")!;
    expect(status()).toMatchObject({ expectedIntervalMs: 60_000, stale: false });
    now += 60_000 * (HEARTBEAT_GRACE_TICKS + 1);
    expect(status().stale).toBe(true);                       // silent for 11 ticks → stale
    expect((await e.tick()).status).toBe("not_due");
    expect(status()).toMatchObject({ stale: false, ageMs: 0 });  // a not_due tick beats
    now = Date.parse("2026-10-20T13:36:00Z");
    venue.positions = async () => { throw new Error("broker down"); };
    expect((await e.tick()).status).toBe("failed");
    expect(status()).toMatchObject({ stale: false, consecutiveFailures: 1 }); // alive, dependency failing
    venue.positions = FakeVenue.prototype.positions;
    expect((await e.tick()).status).toBe("submitted");
    expect(status()).toMatchObject({ stale: false, consecutiveFailures: 0 });
    expect((await e.tick()).status).toBe("already_done");
    expect(status().ageMs).toBe(0);
  });

  test("a failing pass pages after failPageAfter consecutive failures, once per session", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.positions = async () => { throw new Error("broker down"); };
    const e = engine(venue, { failPageAfter: 3 });
    for (let i = 0; i < 5; i++) expect((await e.tick()).status).toBe("failed");
    expect(e.alerts).toHaveLength(1);
    expect(e.alerts[0]).toContain("broker down");
    expect(e.beats).toEqual([]);
  });
});

// 2026-10-23: Alpaca's stop cancel is asynchronous, the engine's sells came back
// `http_403 insufficient qty available for order (requested: X, available: 0)` and were
// marked applied: nothing retried until the next session.
describe("held-quantity sell rejections are retried within the session", () => {
  const HELD = "http_403 insufficient qty available for order (requested: 10, available: 0)";
  const SPY_CID = portfolioClientOrderId(SLEEVE, SESSION, "SPY");

  function setup(reject: { times?: number; error?: string } = {}) {
    seedOpenTrade("pf_spy", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 400, quantity: 10 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: 10, avgEntryPrice: 400 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.behavior.SPY = { kind: "reject", error: HELD, ...reject };
    return venue;
  }
  // Sell SPY entirely, buy GLD with the proceeds.
  const mk = (venue: FakeVenue, over: Partial<PortfolioEngineOptions> = {}) => engine(venue, { decide: fixedDecide({ GLD: 0.1 }), ...over });

  test("rejected sell stays unapplied and the pass stays decided; the buy waits; the next ticks resume with the SAME client id until it fills", async () => {
    const venue = setup({ times: 2 });
    const decide = fixedDecide({ GLD: 0.1 });
    const e1 = engine(venue, { decide });
    const rep1 = await e1.tick();
    expect(rep1.status).toBe("retrying");
    expect(rep1.rejected).toBe(0);
    expect(e1.beats).toEqual(["portfolio:momentum_stocks"]); // a retrying pass is alive, not failing
    let dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(dec.status).toBe("decided");
    expect(dec.orders.map(o => [o.intent.symbol, o.applied, o.attempts ?? 0])).toEqual([["SPY", false, 1], ["GLD", false, 0]]);
    expect(dec.note).toContain("retrying next tick");
    expect(venue.submits.map(s => s.order.symbol)).toEqual(["SPY"]); // GLD buy deferred behind the sell
    expect(row("SPY").quantity).toBe(10);
    expect(e1.alerts).toHaveLength(0);
    // Progress was recorded and stops were refreshed even though orders are pending:
    expect(decide.calls).toHaveLength(2); // decision + the post-fill refresh
    expect(dec.memory).toEqual({ n: 1, lastAsOf: AS_OF }); // memory = the FIRST call's until the pass closes

    // A restart between ticks changes nothing: attempts live in the decision row.
    const e2 = engine(venue, { decide });
    const rep2 = await e2.tick();
    expect(rep2.status).toBe("retrying");
    dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(dec.orders[0].attempts).toBe(2);
    expect(dec.memory).toEqual({ n: 1, lastAsOf: AS_OF });
    // Every refresh re-decided from that same first-call memory (the core advances once per session).
    expect(decide.calls.slice(1).every(c => (c.book.memory as any).n === 1)).toBe(true);

    const e3 = engine(venue, { decide });
    const rep3 = await e3.tick();
    expect(rep3.status).toBe("resumed");
    expect(rep3.rejected).toBe(0);
    dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(dec.status).toBe("submitted");
    expect(dec.orders.every(o => o.applied && o.result?.ok)).toBe(true);
    expect(dec.memory).toEqual({ n: 2, lastAsOf: AS_OF }); // refreshed once, at close
    expect(venue.submits.filter(s => s.order.symbol === "SPY")).toHaveLength(3);
    expect(new Set(venue.submits.filter(s => s.order.symbol === "SPY").map(s => s.clientOrderId))).toEqual(new Set([SPY_CID]));
    expect(venue.submits.filter(s => s.order.symbol === "GLD")).toHaveLength(1); // bought once, after the sell
    expect(venue.submits.map(s => s.order.symbol).slice(-2)).toEqual(["SPY", "GLD"]);
    expect(row("SPY")).toMatchObject({ status: "closed", close_reason: PORTFOLIO_REBALANCE_CLOSE_REASON });
    expect(row("GLD").quantity).toBeGreaterThan(0);
    expect(e3.alerts).toHaveLength(0);
    // Done: later ticks do nothing.
    expect((await engine(venue, { decide }).tick()).status).toBe("already_done");
    expect(venue.submits).toHaveLength(4);
  });

  test("the cap per order per session: the Nth rejection is terminal and pages once; the deferred buy then goes; a session never loops", async () => {
    const venue = setup(); // rejects forever
    const statuses: string[] = [];
    const alerts: string[] = [];
    for (let i = 0; i < 8; i++) {
      const e = mk(venue, { maxSellAttempts: 3, alert: (_c, m) => alerts.push(m) });
      statuses.push((await e.tick()).status);
    }
    expect(statuses).toEqual(["retrying", "retrying", "resumed", "already_done", "already_done", "already_done", "already_done", "already_done"]);
    expect(venue.submits.filter(s => s.order.symbol === "SPY")).toHaveLength(3); // exactly the cap
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("sell SPY");
    expect(alerts[0]).toContain("gave up after 3 attempts");
    const dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(dec.status).toBe("submitted");
    expect(dec.orders.find(o => o.intent.symbol === "SPY")).toMatchObject({ applied: true, attempts: 3 });
    expect(dec.orders.find(o => o.intent.symbol === "SPY")!.result).toMatchObject({ ok: false, status: "rejected" });
    expect(row("SPY").quantity).toBe(10); // the sell never happened; the row is still the broker's truth
    expect(venue.submits.filter(s => s.order.symbol === "GLD")).toHaveLength(1); // the buy was not lost
  });

  test("default cap is 5 submissions", async () => {
    const venue = setup();
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await mk(venue).tick()).status);
    expect(statuses).toEqual(["retrying", "retrying", "retrying", "retrying", "resumed", "already_done"]);
    expect(venue.submits.filter(s => s.order.symbol === "SPY")).toHaveLength(5);
  });

  test("every other rejection stays terminal on the first attempt (no retry, pass submitted)", async () => {
    for (const error of ["http_422 asset SPY is not tradable", "insufficient buying power", "http_403 forbidden"]) {
      getDB().exec("DELETE FROM trades; DELETE FROM portfolio_decisions;");
      const venue = setup({ error });
      const e = mk(venue);
      const rep = await e.runSession(WINDOW);
      expect(rep.status).toBe("submitted");
      expect(rep.rejected).toBe(1);
      expect(venue.submits.filter(s => s.order.symbol === "SPY")).toHaveLength(1);
      expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[0]).toMatchObject({ applied: true });
      expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[0].attempts).toBeUndefined();
    }
  });

  test("a BUY rejected with the same words is terminal: only sells are retryable", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.behavior.TLT = { kind: "reject", error: HELD };
    const rep = await engine(venue).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect(rep.rejected).toBe(1);
  });

  test("a retried sell that fills is applied once (row sold, no double apply) even when only part was refused first", async () => {
    const venue = setup({ times: 1 });
    await mk(venue).runSession(WINDOW);
    const rep = await mk(venue).runSession(WINDOW);
    expect(rep.status).toBe("resumed");
    expect(rep.orders.find(o => o.intent.symbol === "SPY")!.result).toMatchObject({ ok: true, filledQty: 10 });
    expect(venue.positions_.find(p => p.symbol === "SPY")).toBeUndefined();
    expect(getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = ? AND symbol = 'SPY' AND status = 'closed'`).get(SLEEVE)).toEqual({ c: 1 });
  });

  test("a resume of a retrying sell asks the venue to release the incumbent's stops again; unconfirmed cancels are logged, not paged", async () => {
    const venue = setup({ times: 1 });
    const calls: string[][] = [];
    venue.releaseLegacyStops = async (symbols) => { calls.push([...symbols]); return { released: ["s1"], unconfirmed: ["s2"] }; };
    const e = mk(venue);
    await e.runSession(WINDOW);
    expect(calls).toHaveLength(1);
    const e2 = mk(venue);
    await e2.runSession(WINDOW);
    expect(calls).toHaveLength(2);
    expect(e.alerts).toHaveLength(0);
    expect(e2.alerts).toHaveLength(0);
    const msgs = (getDB().prepare(`SELECT message FROM activity_log WHERE account_id = ?`).all(SLEEVE) as any[]).map(r => r.message).join("\n");
    expect(msgs).toContain("released 1 incumbent stop order(s)");
    expect(msgs).toContain("not confirmed");
    expect(msgs).toContain("s2");
  });

  test("a venue that still answers releaseLegacyStops with a bare id array keeps working", async () => {
    const venue = setup({ times: 0 });
    venue.releaseLegacyStops = async () => ["s1"];
    const rep = await mk(venue).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    expect((getDB().prepare(`SELECT message FROM activity_log WHERE account_id = ?`).all(SLEEVE) as any[]).map(r => r.message).join("\n")).toContain("released 1 incumbent stop order(s)");
  });
});

describe("atomic fill application (Q7 V1): book + journal in one transaction", () => {
  // Every path that applies a fill goes through PortfolioEngine.applyFill; the -r1 remainder path is
  // covered in "MAX_HOLD with the real Alpaca venue" above. A crash between the two writes used to leave
  // the row written and the order unapplied: the resume re-sent the same client id, the venue answered
  // with the already-filled order and the fill was applied twice.
  const SPY_ROW_OPEN = `EXISTS (SELECT 1 FROM trades WHERE account_id = '${SLEEVE}' AND symbol = 'SPY' AND status = 'open')`;

  test("buy: nothing half-persisted after the crash; the resume applies the same client id exactly once", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const recover = crashBetweenWrites(SPY_ROW_OPEN);
    const rep = await engine(venue, { decide: fixedDecide({ SPY: 0.5 }) }).runSession(WINDOW);
    expect(rep.status).toBe("failed");
    expect(rep.note).toContain("crash between book and journal");
    expect(venue.positions_.find(p => p.symbol === "SPY")!.qty).toBeCloseTo(10, 9); // the venue filled
    expect(rows()).toEqual([]);                                                        // the book did not move
    const dec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(dec.status).toBe("decided");
    expect(dec.orders[0]).toMatchObject({ applied: false, result: null });
    expect(dec.note).toContain("resume pending");
    recover();
    const rep2 = await engine(venue, { decide: fixedDecide({ SPY: 0.5 }) }).runSession(WINDOW);
    expect(rep2.status).toBe("resumed");
    const cid = portfolioClientOrderId(SLEEVE, SESSION, "SPY");
    expect(venue.submits.map(s => s.clientOrderId)).toEqual([cid, cid]);               // same id, venue dedups
    expect(venue.positions_.find(p => p.symbol === "SPY")!.qty).toBeCloseTo(10, 9);
    expect(row("SPY").quantity).toBeCloseTo(10, 9);                                    // applied ONCE, not 20
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[0]).toMatchObject({ applied: true, result: { filledQty: 10 } });
    expect(countExecutedOrders(NOW - 1, NOW, SLEEVE)).toBe(1);
  });

  test("sell (partial trim with a realized leg): quantities and trade_realized_legs equal a clean run", async () => {
    const seed = () => {
      seedOpenTrade("lot", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 20, entryTime: NOW - 86_400_000 });
      const venue = new FakeVenue();
      venue.positions_ = [{ symbol: "SPY", qty: 20, avgEntryPrice: 500 }];
      venue.prices_ = { SPY: 510, TLT: 90, GLD: 200 };
      return venue;
    };
    // equity = 10 000 + 20 × 10 = 10 200; target 0.5 → 10 shares: a SELL of 10 realizing +100.
    const decide = () => fixedDecide({ SPY: 0.5 });
    expect((await engine(seed(), { decide: decide() }).runSession(WINDOW)).status).toBe("submitted");
    const clean = { book: bookSnapshot(), legs: legsSnapshot() };
    expect(clean.legs).toEqual([{ symbol: "SPY", quantity: 10, entry_price: 500, exit_price: 510, realized_native: 100, source: "fill" }]);
    resetState();
    const venue = seed();
    const recover = crashBetweenWrites(`(SELECT quantity FROM trades WHERE id = 'lot') < 20`);
    expect((await engine(venue, { decide: decide() }).runSession(WINDOW)).status).toBe("failed");
    expect(venue.positions_.find(p => p.symbol === "SPY")!.qty).toBeCloseTo(10, 9); // venue sold 10
    expect(row("SPY")).toMatchObject({ quantity: 20, partial_realized_native: 0 });  // row untouched
    expect(legsSnapshot()).toEqual([]);                                              // no half-written leg
    recover();
    expect((await engine(venue, { decide: decide() }).runSession(WINDOW)).status).toBe("resumed");
    expect(venue.submits).toHaveLength(2);
    expect(new Set(venue.submits.map(s => s.clientOrderId)).size).toBe(1);
    expect(venue.positions_.find(p => p.symbol === "SPY")!.qty).toBeCloseTo(10, 9);
    expect(bookSnapshot()).toEqual(clean.book);
    expect(legsSnapshot()).toEqual(clean.legs); // ONE leg of 10, not two
  });

  test("stale closes-only pass: the MAX_HOLD close survives the crash and is applied once on the next stale tick", async () => {
    const config: VolManagedConfig = { kind: "volManaged", universe: ["SPY"], inceptionGuardBars: 20, volLookback: 20, covLookback: 20,
      portfolioVolTarget: 0.15, annualization: 252, perAssetCap: 1, maxGross: 1, maxHoldSessions: 5, maxHoldStagger: true };
    const seed = () => {
      seedOpenTrade("lot", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 4, entryTime: Date.parse("2026-10-12T14:00:00Z") });
      const venue = new FakeVenue();
      venue.positions_ = [{ symbol: "SPY", qty: 4, avgEntryPrice: 500 }];
      venue.prices_ = { SPY: 510 };
      return venue;
    };
    const stale = () => histDb("2026-10-16", ["SPY"]);
    expect((await engine(seed(), { config, decide: coreDecide }, stale()).runSession(WINDOW)).status).toBe("skipped_stale");
    const clean = bookSnapshot();
    expect(clean).toMatchObject([{ status: "closed", close_reason: "MAX_HOLD", pnl: 40 }]);
    resetState();
    const venue = seed();
    const recover = crashBetweenWrites(`(SELECT status FROM trades WHERE id = 'lot') = 'closed'`);
    expect((await engine(venue, { config, decide: coreDecide }, stale()).runSession(WINDOW)).status).toBe("failed");
    expect(venue.positions_).toEqual([]);                                   // the venue closed it
    expect(row("SPY")).toMatchObject({ status: "open", quantity: 4 });       // the row did not
    const rec = getPortfolioDecision(SLEEVE, VERSION, SESSION)!;
    expect(rec.status).toBe("skipped_stale");
    expect(rec.orders[0]).toMatchObject({ applied: false, result: null });
    recover();
    expect((await engine(venue, { config, decide: coreDecide }, stale()).runSession(WINDOW)).status).toBe("skipped_stale");
    const cid = portfolioClientOrderId(SLEEVE, SESSION, "SPY", "stale-close");
    expect(venue.submits.map(s => s.clientOrderId)).toEqual([cid, cid]);
    expect(bookSnapshot()).toEqual(clean);
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders).toHaveLength(1);
  });

  test("emergency 'marked at last close' (fill without a price): the mark is atomic with the journal too", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const seen = new Map<string, any>();
    venue.submit = async (order, clientOrderId) => {
      venue.submits.push({ order, clientOrderId });
      if (seen.has(clientOrderId)) return seen.get(clientOrderId);
      venue.positions_.push({ symbol: order.symbol, qty: order.qty, avgEntryPrice: 500 });
      const r = { ok: true, filledQty: order.qty, avgPrice: null, status: "filled", brokerOrderId: "b-1", error: "no filled_avg_price in the venue's answer" };
      seen.set(clientOrderId, r);
      return r;
    };
    const recover = crashBetweenWrites(SPY_ROW_OPEN);
    expect((await engine(venue, { decide: fixedDecide({ SPY: 0.5 }) }).runSession(WINDOW)).status).toBe("failed");
    expect(rows()).toEqual([]);
    recover();
    expect((await engine(venue, { decide: fixedDecide({ SPY: 0.5 }) }).runSession(WINDOW)).status).toBe("resumed");
    expect(venue.submits).toHaveLength(2);
    const r = row("SPY");
    expect(r.quantity).toBeCloseTo(10, 9);
    expect(r.entry_price).toBe(399); // makeHistDb: close = 100 + i over 300 sessions → the last close, not the venue price
    expect(getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = ? AND symbol = 'SPY'`).get(SLEEVE)).toEqual({ c: 1 });
  });
});

describe("execution record in the journal (Q7 V1): label, decisionPrice, sessionOpenRaw, submittedAt", () => {
  const maxHold: VolManagedConfig = { kind: "volManaged", universe: ["SPY"], inceptionGuardBars: 20, volLookback: 20, covLookback: 20,
    portfolioVolTarget: 0.15, annualization: 252, perAssetCap: 1, maxGross: 1, maxHoldSessions: 5, maxHoldStagger: true };

  test("rebalance orders: label by side, the pass's reference price, the venue's RAW session open when offered, the submission time", async () => {
    seedOpenTrade("tlt", SLEEVE, { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 90, quantity: 100, entryTime: NOW - 86_400_000 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "TLT", qty: 100, avgEntryPrice: 90 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const asked: string[][] = [];
    venue.sessionOpens = async (symbols, session) => { asked.push([session, ...symbols]); return { SPY: 498.5 }; }; // TLT: no bar today
    const rep = await engine(venue, { decide: fixedDecide({ SPY: 0.5, TLT: 0.3 }) }).runSession(WINDOW);
    expect(rep.status).toBe("submitted");
    const [sell, buy] = getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders;
    expect(sell).toMatchObject({ intent: { symbol: "TLT", side: "sell" }, label: "rebalance_sell", decisionPrice: 90, sessionOpenRaw: null, submittedAt: NOW });
    expect(buy).toMatchObject({ intent: { symbol: "SPY", side: "buy" }, label: "rebalance_buy", decisionPrice: 500, sessionOpenRaw: 498.5, submittedAt: NOW });
    expect(asked).toEqual([[SESSION, "TLT", "SPY"]]); // one venue read per submit pass, pending symbols only
    expect(buy.result).toMatchObject({ brokerOrderId: expect.any(String), filledQty: 10, avgPrice: 500 });
  });

  test("the session opens are read AFTER the orders went out: recording them never delays an order", async () => {
    seedOpenTrade("tlt", SLEEVE, { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 90, quantity: 100, entryTime: NOW - 86_400_000 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "TLT", qty: 100, avgEntryPrice: 90 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const calls: string[] = [];
    const submit = venue.submit.bind(venue);
    venue.submit = async (intent, id) => { calls.push(`submit ${intent.symbol}`); return submit(intent, id); };
    venue.sessionOpens = async () => { calls.push("sessionOpens"); return { SPY: 498.5, TLT: 90.2 }; };
    expect((await engine(venue, { decide: fixedDecide({ SPY: 0.5, TLT: 0.3 }) }).runSession(WINDOW)).status).toBe("submitted");
    expect(calls).toEqual(["submit TLT", "submit SPY", "sessionOpens"]);
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders.map(o => o.sessionOpenRaw)).toEqual([90.2, 498.5]);
  });

  test("a venue without sessionOpens journals null (declared), and the fields never block an order", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    expect((await engine(venue, { decide: fixedDecide({ SPY: 0.5 }) }).runSession(WINDOW)).status).toBe("submitted");
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[0]).toMatchObject({ label: "rebalance_buy", decisionPrice: 500, sessionOpenRaw: null, submittedAt: NOW });
  });

  test("a venue whose sessionOpens throws: warned, journaled null, the order still goes", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.sessionOpens = async () => { throw new Error("snapshot 429"); };
    expect((await engine(venue, { decide: fixedDecide({ SPY: 0.5 }) }).runSession(WINDOW)).status).toBe("submitted");
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[0]).toMatchObject({ applied: true, sessionOpenRaw: null, result: { filledQty: 10 } });
  });

  test("MAX_HOLD pair: close → max_hold_close, rebuy → max_hold_rebuy; both carry the decision price", async () => {
    seedOpenTrade("lot", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 4, entryTime: Date.parse("2026-10-12T14:00:00Z") });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: 4, avgEntryPrice: 500 }];
    venue.prices_ = { SPY: 510 };
    expect((await engine(venue, { config: maxHold, decide: coreDecide }, histDb(AS_OF, ["SPY"])).runSession(WINDOW)).status).toBe("submitted");
    const orders = getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders;
    expect(orders.map(o => [o.label, o.intent.maxHold, o.decisionPrice])).toEqual([["max_hold_close", "close", 510], ["max_hold_rebuy", "rebuy", 510]]);
    expect(orders.every(o => o.submittedAt === NOW && o.sessionOpenRaw === null)).toBe(true);
  });

  test("stale closes-only pass: label stale_close", async () => {
    seedOpenTrade("lot", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 4, entryTime: Date.parse("2026-10-12T14:00:00Z") });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: 4, avgEntryPrice: 500 }];
    venue.prices_ = { SPY: 510 };
    venue.sessionOpens = async () => ({ SPY: 507 });
    expect((await engine(venue, { config: maxHold, decide: coreDecide }, histDb("2026-10-16", ["SPY"])).runSession(WINDOW)).status).toBe("skipped_stale");
    expect(getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[0]).toMatchObject({ label: "stale_close", decisionPrice: 510, sessionOpenRaw: 507, submittedAt: NOW });
  });

  test("older journal rows without the fields still read, and inferOrderLabel derives the label from what they carry", () => {
    const key = { accountId: SLEEVE, session: SESSION };
    const base = { symbol: "SPY", qty: 1, notional: 500, targetWeight: 0, currentWeight: 0, reduceOnly: true } as const;
    expect(inferOrderLabel({ intent: { ...base, side: "sell", maxHold: "close" }, clientOrderId: portfolioClientOrderId(SLEEVE, SESSION, "SPY", "close") }, key)).toBe("max_hold_close");
    expect(inferOrderLabel({ intent: { ...base, side: "sell", maxHold: "close" }, clientOrderId: portfolioClientOrderId(SLEEVE, SESSION, "SPY", "stale-close") }, key)).toBe("stale_close");
    expect(inferOrderLabel({ intent: { ...base, side: "sell", maxHold: "close" }, clientOrderId: `${portfolioClientOrderId(SLEEVE, SESSION, "SPY", "close")}-r1` }, key)).toBe("retry");
    expect(inferOrderLabel({ intent: { ...base, side: "buy", maxHold: "rebuy", reduceOnly: false }, clientOrderId: portfolioClientOrderId(SLEEVE, SESSION, "SPY", "rebuy") }, key)).toBe("max_hold_rebuy");
    expect(inferOrderLabel({ intent: { ...base, side: "buy", reduceOnly: false }, clientOrderId: portfolioClientOrderId(SLEEVE, SESSION, "SPY") }, key)).toBe("rebalance_buy");
    expect(inferOrderLabel({ intent: { ...base, side: "sell" }, clientOrderId: null }, key)).toBe("rebalance_sell");
    expect(inferOrderLabel({ intent: { ...base, side: "sell" }, clientOrderId: null, label: "max_hold_close" }, key)).toBe("max_hold_close"); // its own label wins
    // A pre-2026-11-07 journal (no label, no prices, no submittedAt) is read back untouched.
    savePortfolioDecision({
      accountId: SLEEVE, strategyVersion: VERSION, session: SESSION, asOf: AS_OF, mode: "live", status: "submitted", equity: 10_000,
      book: [], weights: {}, stops: [], memory: {}, diagnostics: {},
      orders: [{ intent: { ...base, side: "buy", reduceOnly: false }, clientOrderId: "uc8-x-pf0000000000000000", result: { ok: true, filledQty: 1, avgPrice: 501, status: "filled" }, applied: true }],
      note: null, decidedAt: NOW, updatedAt: NOW,
    });
    const o = getPortfolioDecision(SLEEVE, VERSION, SESSION)!.orders[0];
    expect(o.label).toBeUndefined();
    expect(o.decisionPrice).toBeUndefined();
    expect(o.sessionOpenRaw).toBeUndefined();
    expect(o.submittedAt).toBeUndefined();
    expect(inferOrderLabel(o, key)).toBe("rebalance_buy");
  });
});

describe("decision_passes telemetry (Q7 V1 / OPEN.md RW2): one row per completed live pass", () => {
  const maxHold: VolManagedConfig = { kind: "volManaged", universe: ["SPY"], inceptionGuardBars: 20, volLookback: 20, covLookback: 20,
    portfolioVolTarget: 0.15, annualization: 252, perAssetCap: 1, maxGross: 1, maxHoldSessions: 5, maxHoldStagger: true };

  test("a submitted pass writes ONE row: universe, evaluated, signals, filled entries/exits, exposure; later ticks add none; the funnel reads it", async () => {
    seedOpenTrade("tlt", SLEEVE, { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 90, quantity: 100, entryTime: NOW - 86_400_000 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "TLT", qty: 100, avgEntryPrice: 90 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    const e = engine(venue, { decide: fixedDecide({ SPY: 0.5, TLT: 0.3 }) });
    expect((await e.runSession(WINDOW)).status).toBe("submitted");
    const [p, ...rest] = passes();
    expect(rest).toEqual([]);
    // equity 10 000 (100 TLT × 90 = 9 000 + 1 000 cash): sell TLT to 3 000 (33.3…), buy 10 SPY → gross 8 000 / 10 000
    expect(p).toMatchObject({ account_id: SLEEVE, ts: NOW, universe: 3, evaluated: 3, signals_long: 2, signals_short: 0, entries: 1, exits: 1,
      blocks: "{}", block_note: null, slots_used: null, slots_total: null, signals_raw_long: 2, signals_after_gates: 2, gate_binding: "[]" });
    expect(p.exposure_intended).toBeCloseTo(0.8, 9);
    expect(p.exposure_real).toBeCloseTo(0.8, 9);
    expect((await e.runSession(WINDOW)).status).toBe("already_done");
    expect(passes()).toHaveLength(1);
    const funnel = getDecisionPassSummary(0).find(s => s.accountId === SLEEVE)!;
    expect(funnel).toMatchObject({ passes: 1, universe: 3, signalsLong: 2, entries: 1, exits: 1, blocks: {} });
    expect(funnel.exposure!.latest.ratio).toBeCloseTo(1, 9);
  });

  test("a crashed pass writes nothing; its resume completes the session and writes the one row (every leg counted)", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.behavior.TLT = { kind: "throw", error: "socket hang up" };
    expect((await engine(venue).runSession(WINDOW)).status).toBe("failed");
    expect(passes()).toEqual([]);
    venue.behavior = {};
    expect((await engine(venue).runSession(WINDOW)).status).toBe("resumed");
    expect(passes()).toHaveLength(1);
    expect(passes()[0]).toMatchObject({ entries: 2, exits: 0, signals_long: 2 });
  });

  test("a retrying pass (held-shares sell) writes nothing until the session completes", async () => {
    seedOpenTrade("tlt", SLEEVE, { symbol: "TLT", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 90, quantity: 100, entryTime: NOW - 86_400_000 });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "TLT", qty: 100, avgEntryPrice: 90 }];
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.behavior.TLT = { kind: "reject", error: "insufficient qty available for order (requested: 66, available: 0)", times: 1 };
    const e = engine(venue, { decide: fixedDecide({ SPY: 0.5, TLT: 0.3 }) });
    expect((await e.runSession(WINDOW)).status).toBe("retrying");
    expect(passes()).toEqual([]);
    expect((await e.runSession(WINDOW)).status).toBe("resumed"); // the next tick finishes the journal
    expect(passes()).toHaveLength(1);
    expect(passes()[0]).toMatchObject({ entries: 1, exits: 1, blocks: "{}" });
  });

  test("blocks: a buy skipped by TRADING_ENABLED=false counts under trading_disabled and binds that gate; a terminal rejection counts as rejected", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    venue.behavior.TLT = { kind: "reject", error: "insufficient buying power" };
    let enabled = false;
    const e = engine(venue, { decide: fixedDecide({ SPY: 0.5, TLT: 0.3, GLD: 0.1 }), tradingEnabled: () => { enabled = !enabled; return enabled; } });
    // calls alternate true/false per buy: SPY goes, TLT skipped by the kill-switch, GLD goes… order is SPY, TLT, GLD (planOrders)
    expect((await e.runSession(WINDOW)).status).toBe("submitted");
    const p = passes()[0];
    const blocks = JSON.parse(p.blocks);
    expect(blocks.trading_disabled).toBe(1);
    expect(JSON.parse(p.gate_binding)).toEqual(["trading_disabled"]);
    expect(p.signals_raw_long).toBe(3);
    expect(p.signals_after_gates).toBe(2);
    expect(p.entries + (blocks.rejected ?? 0) + blocks.trading_disabled).toBe(3);
    expect(p.block_note).toMatch(/buy (TLT|GLD): (trading_disabled|rejected)/);
  });

  test("MAX_HOLD pair: close and rebuy are one exit and one entry of the same pass", async () => {
    seedOpenTrade("lot", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 4, entryTime: Date.parse("2026-10-12T14:00:00Z") });
    const venue = new FakeVenue();
    venue.positions_ = [{ symbol: "SPY", qty: 4, avgEntryPrice: 500 }];
    venue.prices_ = { SPY: 510 };
    expect((await engine(venue, { config: maxHold, decide: coreDecide }, histDb(AS_OF, ["SPY"])).runSession(WINDOW)).status).toBe("submitted");
    expect(passes()).toHaveLength(1);
    expect(passes()[0]).toMatchObject({ universe: 1, evaluated: 1, signals_long: 1, entries: 1, exits: 1 });
  });

  test("observer passes and stale skips write no row (they decide nothing live)", async () => {
    const venue = new FakeVenue();
    venue.prices_ = { SPY: 500, TLT: 90, GLD: 200 };
    expect((await engine(venue, { mode: "observer" }).runSession(WINDOW)).status).toBe("observed");
    expect(passes()).toEqual([]);
    resetState();
    seedOpenTrade("lot", SLEEVE, { symbol: "SPY", strategy: PORTFOLIO_ENGINE_STRATEGY, entryPrice: 500, quantity: 4, entryTime: Date.parse("2026-10-12T14:00:00Z") });
    venue.positions_ = [{ symbol: "SPY", qty: 4, avgEntryPrice: 500 }];
    expect((await engine(venue, { config: maxHold, decide: coreDecide }, histDb("2026-10-16", ["SPY"])).runSession(WINDOW)).status).toBe("skipped_stale");
    expect(passes()).toEqual([]); // the closes-only tick is journaled on portfolio_decisions, not a funnel pass
  });
});
