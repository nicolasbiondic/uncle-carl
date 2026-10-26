// RW6: synthetic tapes only. No real-data trials, no broker or live definitions.
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decide, maxHoldExpired } from "../src/portfolio-engine/decide";
import { planOrders } from "../src/portfolio-engine/orders";
import { MAX_HOLD_CLOSE_REASON, type BookState, type OrderIntent, type VolManagedConfig } from "../src/portfolio-engine/types";
import { PortfolioEngine } from "../src/portfolio-engine/live/PortfolioEngine";
import { HistoricalPriceView } from "../src/portfolio-engine/live/priceView";
import { FakeVenue } from "../src/portfolio-engine/live/testSupport";
import { portfolioClientOrderId, isPortfolioClientOrderId } from "../src/portfolio-engine/live/clientOrderId";
import { applyBuyFill, applySellFill, loadSleeveRows, positionsFromRows } from "../src/portfolio-engine/live/rows";
import { getPortfolioDecision } from "../src/portfolio-engine/live/persistence";
import { getDB } from "../src/db/database";
import { makeTestDb } from "../src/test-support/db";
import { candidateToReplayConfig, loadManifest, validateManifest, validatePortfolioBlock, type PortfolioReplayConfig } from "./walk-forward";
import { hashReplayConfig } from "./backtest-momentum-wf";
import { rw2DesignOf } from "./portfolio-criteria";
import { coreKernel, simulatePortfolioWindow } from "./portfolio-replay";
import { usSessionTimestamps, writeDailyFixture } from "./lib/portfolioSynthetic";

const tmp = mkdtempSync(join(tmpdir(), "rw6-synthetic-"));
const path = join(tmp, "hist.db");
const dates = usSessionTimestamps("2026-10-01", 24).map(t => new Date(t).toISOString().slice(0, 10));
const symbols = ["ETF", "SH", "REF"];
writeDailyFixture(path, { source: "alpaca_wide", from: dates[0], sessions: dates.length,
  series: symbols.map((symbol, i) => ({ symbol, seed: 10 + i, startPrice: 100, driftAnnual: 0.1, volAnnual: 0.2 })) });
const db = new Database(path);
// The execution open is the prior close: live/replay use the SAME sizing/fill prices, with zero costs.
for (const symbol of symbols) {
  const bars = db.query("SELECT timestamp, close FROM historical_bars WHERE symbol=? ORDER BY timestamp").all(symbol) as Array<{ timestamp: number; close: number }>;
  bars.forEach((b, i) => {
    if (symbol === "REF") db.run("UPDATE historical_bars SET close=? WHERE symbol=? AND timestamp=?", 150 - i, symbol, b.timestamp);
    db.run("UPDATE historical_bars SET open=? WHERE symbol=? AND timestamp=?", bars[Math.max(0, i - 1)].close, symbol, b.timestamp);
  });
}
const strategy: VolManagedConfig = { kind: "volManaged", universe: ["ETF"], inceptionGuardBars: 4,
  volLookback: 3, covLookback: 3, annualization: 252, portfolioVolTarget: 0.15, perAssetCap: 0.8, maxGross: 1, maxHoldSessions: 5 };
const rowsCfg = { accountId: "momentum_stocks", strategyVersion: "rw6-synthetic", market: "stock" as const, quoteAsset: "USD" };
const rules = { venue: "alpaca" as const, fractional: true, minOrderNotional: 5, rebalanceBand: 0.01 };
const hist = (asOf: string) => new HistoricalPriceView({ db, asOf, symbols });
const cfg = (s = strategy, costs = false): PortfolioReplayConfig => {
  const m = loadManifest(join(import.meta.dir, "../experiments/rw6-e1-lev-vt30-g250-maxhold5-v1.json"));
  const c = candidateToReplayConfig(m, m.candidates[0], "base") as PortfolioReplayConfig;
  return { ...c, dbPath: path, universe: symbols, refSymbol: "ETF", warmupDays: 100,
    slippageBps: costs ? 5 : 0, commissionBps: costs ? 2 : 0, marginInterest: { annualRate: 0 },
    portfolio: { strategy: s, venue: rules } };
};
const win = { label: "synthetic", from: dates[6], to: dates[23] };
beforeAll(() => { makeTestDb(); });
beforeEach(() => { getDB().exec("DELETE FROM trades; DELETE FROM portfolio_decisions; DELETE FROM activity_log;"); });
afterAll(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

test("NYSE clock: entry excluded, execution included; holidays/weekends/DST do not age a lot", () => {
  expect(maxHoldExpired("2026-10-01", "2026-10-08", 5)).toBe(true);
  expect(maxHoldExpired("2026-10-02", "2026-10-08", 5)).toBe(false);
  expect(maxHoldExpired("2026-04-02", "2026-04-06", 2)).toBe(false); // Good Friday + weekend
  expect(maxHoldExpired("2026-10-30", "2026-11-02", 1)).toBe(true); // DST weekend
  expect(maxHoldExpired("2020-04-09", "2020-04-13", 2)).toBe(false); // research-era Good Friday
  expect(maxHoldExpired("2021-06-17", "2021-06-18", 1)).toBe(true); // Juneteenth not adopted yet
  expect(maxHoldExpired("2022-06-17", "2022-06-21", 2)).toBe(false);
  expect(maxHoldExpired("2021-12-30", "2021-12-31", 1)).toBe(true); // NYSE stayed open
  expect(maxHoldExpired("2018-12-04", "2018-12-06", 2)).toBe(false); // Bush funeral
});

test("expired lot closes/rebuys in one plan even inside band; younger lots/default-off untouched", () => {
  const view = hist(dates[10]);
  const empty: BookState = { equity: 50_000, positions: [], memory: {} };
  const target = decide({ view, book: empty, config: strategy, executionSession: dates[11] });
  const price = view.lastClose("ETF")!;
  const position = { symbol: "ETF", qty: target.weights.ETF * empty.equity / price, avgEntryPrice: price, entrySession: dates[6] };
  const book = { ...empty, positions: [position] };
  const expired = decide({ view, book, config: strategy, executionSession: dates[11] });
  expect(expired.weights).toEqual(target.weights);
  expect(expired.maxHold).toEqual(["ETF"]);
  const orders = planOrders(expired, book, { ETF: price }, rules);
  expect(orders.map(o => [o.side, o.maxHold])).toEqual([["sell", "close"], ["buy", "rebuy"]]);
  expect(orders[0].qty).toBe(position.qty);
  expect(orders[1].qty).toBeCloseTo(position.qty, 12);
  const young = { ...book, positions: [{ ...position, entrySession: dates[7] }] };
  expect(planOrders(decide({ view, book: young, config: strategy, executionSession: dates[11] }), young, { ETF: price }, rules)).toEqual([]);
  const off = decide({ view, book, config: { ...strategy, maxHoldSessions: undefined }, executionSession: dates[11] });
  expect(off).not.toHaveProperty("maxHold");
  expect(planOrders(off, book, { ETF: price }, rules)).toEqual([]);
  expect(() => decide({ view, book: { ...book, positions: [{ ...position, entrySession: undefined }] }, config: strategy, executionSession: dates[11] })).toThrow("row entrySession");
  // A target exit closes without a rebuy; even sub-minimum expired dust must be sold.
  const dust = { ...book, positions: [{ ...position, qty: 0.001 }] };
  expect(planOrders({ ...expired, weights: {} }, dust, { ETF: price }, rules).map(o => [o.side, o.qty])).toEqual([["sell", 0.001]]);
});

test("row clock survives partial buys/sells; full MAX_HOLD realizes all legs and opens a fresh row", () => {
  const entry = Date.parse(`${dates[6]}T14:00:00Z`), resize = Date.parse(`${dates[10]}T14:00:00Z`);
  applyBuyFill(rowsCfg, "ETF", 10, 100, entry);
  applyBuyFill(rowsCfg, "ETF", 10, 110, resize);
  applySellFill(rowsCfg, "ETF", 5, 120, { nowMs: resize });
  const old = loadSleeveRows(rowsCfg.accountId)[0];
  expect(old.entryTime).toBe(entry);
  expect(old.entryPrice).toBe(105);
  expect(positionsFromRows([old], true)[0].entrySession).toBe(dates[6]);
  const view = hist(dates[10]);
  expect(decide({ view, book: { equity: 50_000, positions: positionsFromRows([old], true), memory: {} }, config: strategy, executionSession: dates[11] }).maxHold).toEqual(["ETF"]);
  const exit = Date.parse(`${dates[11]}T14:00:00Z`);
  applySellFill(rowsCfg, "ETF", 15, 130, { nowMs: exit, closeReason: MAX_HOLD_CLOSE_REASON });
  applyBuyFill(rowsCfg, "ETF", 15, 130, exit);
  const closed = getDB().query("SELECT close_reason, pnl, entry_time FROM trades WHERE id=?").get(old.id) as any;
  expect(closed).toEqual({ close_reason: "MAX_HOLD", pnl: 450, entry_time: entry });
  const fresh = loadSleeveRows(rowsCfg.accountId)[0];
  expect(fresh.id).not.toBe(old.id);
  expect(fresh.entryTime).toBe(exit);
  expect(fresh.partialRealized).toBe(0);
});

for (const hedge of [false, true]) test(`replay/live decide + plan parity, hedge=${hedge}; executed legs and MAX_HOLD labels`, async () => {
  const s: VolManagedConfig = { ...strategy, ...(hedge ? { regimeOverlay: {
    signals: [{ kind: "maTrend" as const, symbol: "REF", period: 3, sampling: "daily" as const }], combine: "any" as const,
    coreScale: 0, hedge: { symbol: "SH", fraction: 0.5 } } } : {}) };
  const seen = new Map<string, { asOf: string; orders: OrderIntent[]; weights: Readonly<Record<string, number>> }>();
  let execution = "", asOf = "", weights: Readonly<Record<string, number>> = {};
  const replay = simulatePortfolioWindow(cfg(s), win, {
    decide: input => {
      const target = decide(input);
      // Both data readers, identical positions/memory and session.
      expect(decide({ ...input, view: hist(input.view.asOf) })).toEqual(target);
      execution = input.executionSession!; asOf = input.view.asOf; weights = target.weights;
      return target;
    },
    planOrders: (...args) => {
      const orders = planOrders(...args);
      seen.set(execution, { asOf, orders, weights });
      return orders;
    },
  });
  const venue = new FakeVenue();
  venue.rules_ = rules;
  let now = 0;
  const live = new PortfolioEngine({ ...rowsCfg, config: s, capital: 50_000, market: "stocks", rowMarket: "stock", venue, mode: "live",
    openPriceView: (asOf, requested) => new HistoricalPriceView({ db, asOf, symbols: requested }),
    tradingEnabled: () => true, now: () => now,
    alert: (_context, message) => { throw new Error(message); }, heartbeats: { register: () => {}, beat: () => {} } });
  for (const [session, expected] of seen) {
    now = Date.parse(`${session}T14:00:00Z`);
    venue.prices_ = Object.fromEntries(symbols.map(sym => [sym, hist(expected.asOf).lastClose(sym)!]));
    const report = await live.runSession({ session, asOf: expected.asOf });
    expect(report.status).toBe("submitted");
    const stored = getPortfolioDecision(rowsCfg.accountId, rowsCfg.strategyVersion, session)!;
    expect(stored.weights).toEqual(expected.weights);
    expect(stored.orders).toHaveLength(expected.orders.length);
    stored.orders.forEach(({ intent }, i) => {
      const wanted = expected.orders[i];
      // The live ledger is capital + realized + unrealized; replay is cash + mark.
      // Equivalent arithmetic accumulates a few ulps over multiple resizes.
      expect({ ...intent, qty: 0, notional: 0, currentWeight: 0 }).toEqual({ ...wanted, qty: 0, notional: 0, currentWeight: 0 });
      expect(intent.qty).toBeCloseTo(wanted.qty, 9);
      expect(intent.notional).toBeCloseTo(wanted.notional, 8);
      expect(intent.currentWeight).toBeCloseTo(wanted.currentWeight, 12);
    });
    expect((await live.runSession({ session, asOf: expected.asOf })).status).toBe("already_done");
  }
  const stats = replay.portfolioDiagnostics.maxHoldStats!;
  expect(stats.closes).toBe(3);
  expect(stats.rebuys).toBe(stats.closes);
  expect(stats.orders).toBe(stats.closes + stats.rebuys);
  expect(replay.closedTrades.filter(t => t.reason === "MAX_HOLD")).toHaveLength(stats.closes);
  expect((getDB().query("SELECT count(*) n FROM trades WHERE close_reason='MAX_HOLD'").get() as any).n).toBe(stats.closes);
  expect(replay.portfolioDiagnostics.orders).toBe(venue.submits.length);
  expect(replay.portfolioDiagnostics.ordersPerSession).toBe(venue.submits.length / seen.size);
  const renewed = venue.submits.filter(o => o.order.maxHold);
  expect(new Set(renewed.map(o => o.clientOrderId)).size).toBe(renewed.length);
  expect(renewed.every(o => isPortfolioClientOrderId(o.clientOrderId))).toBe(true);
  if (hedge) {
    expect(venue.submits.every(o => o.order.symbol === "SH")).toBe(true); // no defensive leg, no core on risk-off
    expect(replay.portfolioDiagnostics.regimeOverlay!.riskOffDays).toBe(seen.size);
  }
});

for (const kind of ["partial", "reject", "retry", "restart"] as const) test(`renewal never rebuys into an incompletely closed lot: ${kind}`, async () => {
  applyBuyFill(rowsCfg, "ETF", 10, 100, Date.parse(`${dates[1]}T14:00:00Z`));
  const venue = new FakeVenue(); venue.rules_ = rules;
  venue.positions_ = [{ symbol: "ETF", qty: 10, avgEntryPrice: 100 }];
  venue.prices_ = { ETF: 100 };
  venue.behavior.ETF = kind === "partial" ? { kind: "partial", fraction: 0.5, price: 100 }
    : kind === "retry" ? { kind: "reject", times: 1, error: "insufficient qty available for order (requested: 10, available: 0)" }
    : kind === "restart" ? { kind: "throw" } : { kind: "reject" };
  const opts = { ...rowsCfg, config: strategy, capital: 50_000, market: "stocks" as const, rowMarket: "stock" as const, venue, mode: "live" as const,
    openPriceView: (asOf: string, requested: readonly string[]) => new HistoricalPriceView({ db, asOf, symbols: requested }),
    tradingEnabled: () => true, now: () => Date.parse(`${dates[11]}T14:00:00Z`), alert: () => {}, heartbeats: { register: () => {}, beat: () => {} } };
  const engine = new PortfolioEngine(opts);
  const window = { session: dates[11], asOf: dates[10] };
  const first = await engine.runSession(window);
  expect(first.status).toBe(kind === "retry" ? "retrying" : kind === "restart" ? "failed" : "submitted");
  expect(venue.submits.map(o => o.order.side)).toEqual(["sell"]);
  if (kind === "retry" || kind === "restart") {
    const firstId = venue.submits[0].clientOrderId;
    venue.behavior.ETF = { kind: "fill", price: 100 };
    expect((await new PortfolioEngine(opts).runSession(window)).status).toBe("resumed");
    expect(venue.submits.map(o => o.order.side)).toEqual(["sell", "sell", "buy"]);
    expect(venue.submits[1].clientOrderId).toBe(firstId);
    expect(venue.submits[2].clientOrderId).not.toBe(firstId);
    expect(loadSleeveRows(rowsCfg.accountId)[0].entryTime).toBe(opts.now());
  } else {
    expect(first.orders.find(o => o.intent.side === "buy")!.skipped).toBe("max_hold_close_incomplete");
    expect(loadSleeveRows(rowsCfg.accountId)[0].entryTime).toBe(Date.parse(`${dates[1]}T14:00:00Z`));
  }
});

test("both renewal legs pay costs; default-off replay has no extra telemetry; default ids stay unchanged", () => {
  let expectedFees = 0, renewalSellFees = 0, renewalBuyFees = 0;
  const quantities = new Map<string, number>();
  let execution = "";
  const paid = simulatePortfolioWindow(cfg(strategy, true), win, {
    decide: input => { execution = input.executionSession!; return decide(input); },
    planOrders: (...args) => {
      const orders = planOrders(...args);
      for (const o of orders) {
        const bar = db.query("SELECT open FROM historical_bars WHERE symbol=? AND timestamp=?").get(o.symbol, Date.parse(execution) + 5 * 3_600_000) as { open: number };
        const fee = o.qty * bar.open * (o.side === "buy" ? 1.0005 : 0.9995) * 0.0002;
        expectedFees += fee;
        if (o.maxHold === "close") renewalSellFees += fee;
        if (o.maxHold === "rebuy") renewalBuyFees += fee;
        quantities.set(o.symbol, (quantities.get(o.symbol) ?? 0) + (o.side === "buy" ? o.qty : -o.qty));
      }
      return orders;
    },
  });
  for (const [symbol, qty] of quantities) expectedFees += qty * hist(dates[22]).lastClose(symbol)! * 0.9995 * 0.0002;
  expect(paid.fees).toBeCloseTo(expectedFees, 9); // every leg + fold-end, not just net deltas
  expect(renewalSellFees).toBeGreaterThan(0);
  expect(renewalBuyFees).toBeGreaterThan(0);
  for (const close of paid.closedTrades.filter(t => t.reason === "MAX_HOLD")) {
    const bar = db.query("SELECT open FROM historical_bars WHERE symbol=? AND timestamp=?").get(close.symbol, close.exitAt) as { open: number };
    expect(close.exitPrice).toBeCloseTo(bar.open * 0.9995, 12);
    const next = paid.closedTrades.find(t => t.entryAt === close.exitAt);
    expect(next!.entryPrice).toBeCloseTo(bar.open * 1.0005, 12);
  }
  const free = simulatePortfolioWindow(cfg(), win);
  expect(paid.fees).toBeGreaterThan(0);
  expect(paid.finalEquity).toBeLessThan(free.finalEquity);
  expect(paid.closedTrades.some(t => t.reason === "MAX_HOLD")).toBe(true);
  const off = simulatePortfolioWindow(cfg({ ...strategy, maxHoldSessions: undefined }), win);
  expect(off.portfolioDiagnostics).not.toHaveProperty("maxHoldStats");
  expect(off.closedTrades.every(t => t.reason !== "MAX_HOLD")).toBe(true);
  expect(portfolioClientOrderId("momentum_stocks", dates[11], "ETF")).toBe(portfolioClientOrderId("momentum_stocks", dates[11], "ETF", undefined));
  expect(new Set([undefined, "close", "rebuy"].map(leg => portfolioClientOrderId("momentum_stocks", dates[11], "ETF", leg as "close" | "rebuy" | undefined))).size).toBe(3);
});

test("strict validation and identity: absent unchanged, enabled/limit changes hashed; drafts reserve 456..458 and copy live exactly", () => {
  const dir = join(import.meta.dir, "../experiments");
  const files = ["rw6-e1-lev-vt30-g250-maxhold5-v1", "rw6-e1-lev-vt30-g250-maxhold5-sh50-v1", "rw6-e2-meanrev-maxhold5-v1"];
  files.forEach((file, i) => {
    const m = loadManifest(join(dir, `${file}.json`));
    expect(() => validateManifest(m)).not.toThrow();
    expect(rw2DesignOf(m.name)).toBe(i < 2 ? "E1" : "E2");
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 456 + i, complete: false });
    expect(m.candidates).toHaveLength(1);
    const live = loadManifest(join(dir, i < 2 ? "rw5-e1-lev-vt30-g250-sma200-fastvol5-cash-v1.json" : "rw2-e2-meanrev-volmanaged-v1.json"));
    const base = live.candidates.find(c => c.name === (i < 2 ? "e1-lev-vt30-g250-sma200-fastvol5" : "vt15"))!;
    expect(m.window).toEqual(live.window); expect(m.costs).toEqual(live.costs); expect(m.ledger).toEqual(live.ledger);
    const block = structuredClone(m.candidates[0].portfolio!);
    const s = block.strategy as VolManagedConfig;
    expect(s.maxHoldSessions).toBe(5); delete s.maxHoldSessions;
    if (i === 1) {
      expect(s.regimeOverlay!.hedge).toEqual({ symbol: "SH", fraction: 0.5 });
      expect(s.regimeOverlay).not.toHaveProperty("defensive");
      expect(m.data.universe).toContain("SH");
      delete s.regimeOverlay!.hedge;
    }
    expect(block).toEqual(base.portfolio!);
  });
  const c = cfg();
  for (const maxHoldSessions of [0, -1, 1.5, NaN, Infinity, null, "5"]) {
    expect(() => validatePortfolioBlock({ ...c.portfolio, strategy: { ...strategy, maxHoldSessions } })).toThrow("maxHoldSessions");
  }
  expect(() => validatePortfolioBlock({ ...c.portfolio, strategy: { ...strategy, annualization: 365 } })).toThrow("NYSE");
  const hash = (maxHoldSessions?: number) => hashReplayConfig({ ...c, portfolio: { ...c.portfolio, strategy: { ...strategy, maxHoldSessions } } });
  const { maxHoldSessions: _off, ...plain } = strategy;
  expect(hash()).toBe(hashReplayConfig({ ...c, portfolio: { ...c.portfolio, strategy: plain } }));
  expect(new Set([hash(), hash(5), hash(6)]).size).toBe(3);
});
