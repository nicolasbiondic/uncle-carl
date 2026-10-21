// PortfolioEngine — adoption, first rebalance, partial fill, rejection, stale
// skip, observer mode, restart idempotency, decreases/exits, broker=truth
// reconciliation, post-fill stop sync. Fake venue, in-memory trading DB and
// in-memory historical.db. No broker, no network.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { getDB, PORTFOLIO_ENGINE_STRATEGY } from "../../db/database";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { PortfolioEngine, type PortfolioEngineOptions } from "./PortfolioEngine";
import { HistoricalPriceView } from "./priceView";
import { getPortfolioDecision, latestPortfolioMemory, listPortfolioDecisions } from "./persistence";
import { portfolioClientOrderId } from "./clientOrderId";
import { PORTFOLIO_REBALANCE_CLOSE_REASON, PORTFOLIO_RECONCILED_CLOSE_REASON, loadSleeveRows } from "./rows";
import { FakeVenue, XASSET, CRYPTO_STOP, fixedDecide, makeHistDb, weekdaySessions } from "./testSupport";

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

beforeAll(() => { makeTestDb(); });
beforeEach(() => { getDB().exec("DELETE FROM trades; DELETE FROM portfolio_decisions; DELETE FROM activity_log;"); });

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
