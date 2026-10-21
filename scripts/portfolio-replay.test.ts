import { describe, expect, test, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  coreKernel,
  effectiveStrategy,
  makePortfolioRunner,
  runPortfolioReplay,
  simulatePortfolioWindow,
  type PortfolioChainState,
  type PortfolioKernel,
} from "./portfolio-replay";
import type { PortfolioReplayConfig } from "./walk-forward";
import type { ReplayConfig } from "./backtest-momentum-wf";
import { planOrders } from "../src/portfolio-engine";
import type { DecideInput, PortfolioStrategyConfig, SessionDate, TargetBook, VenueRules } from "../src/portfolio-engine/types";
import { fixtureBars, usSessionTimestamps, writeDailyFixture } from "./lib/portfolioSynthetic";

const tmp = mkdtempSync(join(tmpdir(), "rw-replay-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ── fixtures ───────────────────────────────────────────────────────────────

const ETFS = ["SPY", "IEF", "GLD"];
const stocksDb = join(tmp, "stocks.db");
writeDailyFixture(stocksDb, {
  source: "alpaca_wide", from: "2020-01-02", sessions: 700,
  series: [
    { symbol: "SPY", seed: 1, startPrice: 300, driftAnnual: 0.15, volAnnual: 0.18 },
    { symbol: "IEF", seed: 2, startPrice: 100, driftAnnual: 0.02, volAnnual: 0.06 },
    { symbol: "GLD", seed: 3, startPrice: 150, driftAnnual: 0.10, volAnnual: 0.15 },
  ],
});
const cryptoDb = join(tmp, "crypto.db");
writeDailyFixture(cryptoDb, {
  source: "binance_futures", from: "2021-01-01", sessions: 800, fundingRate: 0.0001,
  series: [
    { symbol: "BTC/USD", seed: 11, startPrice: 30_000, driftAnnual: 0.4, volAnnual: 0.6 },
    { symbol: "ETH/USD", seed: 12, startPrice: 1_000, driftAnnual: 0.5, volAnnual: 0.8 },
    { symbol: "SOL/USD", seed: 13, startPrice: 20, driftAnnual: 0.6, volAnnual: 1.0 },
  ],
});

const alpaca: VenueRules = { venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0 };
const binance: VenueRules = { venue: "binance_usdm", fractional: false, minOrderNotional: 5, rebalanceBand: 0.02, qtyStep: { "BTC/USD": 0.001, "ETH/USD": 0.001, "SOL/USD": 1 } };

const d1Strategy: PortfolioStrategyConfig = {
  kind: "xassetTrend", universe: ETFS, inceptionGuardBars: 252, volLookback: 63, covLookback: 63,
  portfolioVolTarget: 0.12, perAssetCap: 1, maxGross: 1.8, blendHorizons: [63, 126, 252], maLong: 200, signalBandPct: 0,
};
const d3Strategy: PortfolioStrategyConfig = {
  kind: "cryptoTrend", universe: ["BTC/USD", "ETH/USD", "SOL/USD"], inceptionGuardBars: 252, volLookback: 30, covLookback: 30,
  portfolioVolTarget: 0.35, perAssetCap: 0.6, maxGross: 2.0, blendHorizons: [63, 126, 252], maLong: 200, signalBandPct: 0,
  stop: { mode: "fixed", pct: 4 },
};

function stocksCfg(over: Partial<ReplayConfig> = {}, strategy: PortfolioStrategyConfig = d1Strategy, venue = alpaca): PortfolioReplayConfig {
  return {
    sleeve: "stocks", universe: [...ETFS], timeframe: "1d", source: "alpaca_wide", refSymbol: "SPY", rthOnly: false, funding: false,
    barMinutes: 1440, barMinutesEq: 1440, slippageBps: 2, commissionBps: 0, initialEquity: 50_000, cadenceMin: 1440, notionalPctPerSlot: 0.25,
    entryPct: 0, exitPct: 0, maxLongs: 0, maxShorts: 0, shortFunding: "credit", warmupDays: 420, dbPath: stocksDb,
    ...over,
    portfolio: { strategy, venue },
  } as PortfolioReplayConfig;
}
function cryptoCfg(over: Partial<ReplayConfig> = {}, strategy: PortfolioStrategyConfig = d3Strategy): PortfolioReplayConfig {
  return {
    sleeve: "crypto", universe: ["BTC/USD", "ETH/USD", "SOL/USD"], timeframe: "1d", source: "binance_futures", refSymbol: "BTC/USD", rthOnly: false, funding: true,
    barMinutes: 1440, barMinutesEq: 1440, slippageBps: 5, commissionBps: 4, initialEquity: 5_000, cadenceMin: 1440, notionalPctPerSlot: 0.25,
    entryPct: 0, exitPct: 0, maxLongs: 0, maxShorts: 0, shortFunding: "credit", warmupDays: 300, dbPath: cryptoDb,
    ...over,
    portfolio: { strategy, venue: binance },
  } as PortfolioReplayConfig;
}

const WIN = { label: "0/test", from: "2021-06-01T00:00:00Z", to: "2021-09-01T00:00:00Z" };

/** A decision double: constant weights, records every input. */
function constantDecide(weights: Record<string, number>, log?: Array<{ asOf: string; exec?: string; memory: Record<string, unknown>; positions: number }>): PortfolioKernel["decide"] {
  return (input: DecideInput & { executionSession?: SessionDate }): TargetBook => {
    log?.push({ asOf: input.view.asOf, exec: input.executionSession, memory: input.book.memory, positions: input.book.positions.length });
    return { asOf: input.view.asOf, weights, stops: [], memory: { ...input.book.memory, n: ((input.book.memory.n as number) ?? 0) + 1 }, diagnostics: {} };
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("portfolio runner — no look-ahead", () => {
  test("every decision at session d sees asOf = the previous session and no bar dated ≥ d", () => {
    const seen: Array<{ asOf: string; exec: string; maxDate: string; countAll: number; countView: number }> = [];
    const spy: PortfolioKernel["decide"] = (input) => {
      const all = fixtureBars({ source: "alpaca_wide", from: "2020-01-02", sessions: 700, series: [{ symbol: "SPY", seed: 1, startPrice: 300, driftAnnual: 0.15, volAnnual: 0.18 }] });
      const hist = input.view.history("SPY", 10_000);
      const exec = (input as { executionSession?: string }).executionSession!;
      seen.push({
        asOf: input.view.asOf, exec,
        maxDate: hist.length ? hist[hist.length - 1].date : "",
        countAll: all.filter(b => new Date(b.timestamp).toISOString().slice(0, 10) <= input.view.asOf).length,
        countView: input.view.barCount("SPY"),
      });
      return { asOf: input.view.asOf, weights: { SPY: 0.5 }, stops: [], memory: input.book.memory, diagnostics: {} };
    };
    const r = simulatePortfolioWindow(stocksCfg(), WIN, { decide: spy, planOrders });
    expect(seen.length).toBe(r.portfolioDiagnostics.sessions);
    for (const s of seen) {
      expect(s.asOf < s.exec).toBe(true);
      expect(s.maxDate).toBe(s.asOf);
    }
    // The first decision reads the last session BEFORE the window, the next ones chain session by session.
    expect(seen[0].asOf).toBe("2021-05-31"); // synthetic calendar: every weekday is a session
    expect(seen[0].exec).toBe("2021-06-01");
    for (let i = 1; i < seen.length; i++) expect(seen[i].asOf).toBe(seen[i - 1].exec);
    // The view exposes exactly the bars up to asOf (the warmup is bounded by warmupDays, so compare within it).
    const warmupStart = new Date(Date.parse(WIN.from) - 420 * 86_400_000).toISOString().slice(0, 10);
    const all = fixtureBars({ source: "alpaca_wide", from: "2020-01-02", sessions: 700, series: [{ symbol: "SPY", seed: 1, startPrice: 300, driftAnnual: 0.15, volAnnual: 0.18 }] });
    for (const s of seen) {
      const expected = all.filter(b => { const d = new Date(b.timestamp).toISOString().slice(0, 10); return d >= warmupStart && d <= s.asOf; }).length;
      expect(s.countView).toBe(expected);
    }
  });

  test("date labels: dailyReturns carry the SESSION date (weekday, ET), one per session, inside the window; equityHistory seeds at the window start", () => {
    const r = simulatePortfolioWindow(stocksCfg(), WIN, { decide: constantDecide({ SPY: 0.6, IEF: 0.4 }), planOrders });
    const dates = r.dailyReturns.map(d => d.date);
    expect(dates.length).toBe(r.portfolioDiagnostics.sessions);
    expect(dates[0]).toBe("2021-06-01");
    expect(dates[dates.length - 1]).toBe("2021-08-31");
    expect(new Set(dates).size).toBe(dates.length);
    for (const d of dates) {
      const dow = new Date(d + "T12:00:00Z").getUTCDay();
      expect(dow).not.toBe(0);
      expect(dow).not.toBe(6);
      expect(d >= "2021-06-01" && d < "2021-09-01").toBe(true);
    }
    expect(r.equityHistory[0]).toEqual({ t: Date.parse(WIN.from), eq: 50_000 });
    expect(r.equityHistory[1].t).toBe(Date.parse("2021-06-01T05:00:00Z"));
    // Session returns mirror the daily labels (from = previous session).
    expect(r.sessionReturns[0]).toEqual({ from: "2021-05-31", to: "2021-06-01", ret: r.dailyReturns[0].ret });
    expect(r.sessionReturns.length).toBe(r.dailyReturns.length);
  });
});

describe("portfolio runner — fills, costs, accounting", () => {
  test("fills at the execution day's OPEN with slippage and commission, sized at the asOf close", () => {
    const slip = 10, comm = 5;
    const cfg = stocksCfg({ slippageBps: slip, commissionBps: comm });
    const r = simulatePortfolioWindow(cfg, { ...WIN, to: "2021-06-03T00:00:00Z" }, { decide: constantDecide({ SPY: 1 }), planOrders }, undefined);
    const spy = fixtureBars({ source: "alpaca_wide", from: "2020-01-02", sessions: 700, series: [{ symbol: "SPY", seed: 1, startPrice: 300, driftAnnual: 0.15, volAnnual: 0.18 }] });
    const byDate = new Map(spy.map(b => [new Date(b.timestamp).toISOString().slice(0, 10), b]));
    const refClose = byDate.get("2021-05-31")!.close;     // asOf close = reference price
    const open = byDate.get("2021-06-01")!.open;          // fill reference
    const qty = (1 * 50_000) / refClose;
    const fillPx = open * (1 + slip / 10_000);
    const commission = qty * fillPx * (comm / 10_000);
    const cash = 50_000 - qty * fillPx - commission;
    const eq1 = cash + qty * byDate.get("2021-06-01")!.close;
    expect(r.dailyReturns[0].ret).toBeCloseTo(eq1 / 50_000 - 1, 10);
    expect(r.equityHistory[1].eq).toBeCloseTo(eq1, 6);
    // Two sessions in the window → entered 06-01, liquidated at 06-02's close (fold_end) with sell-side slippage.
    expect(r.portfolioDiagnostics.sessions).toBe(2);
    expect(r.closedTrades.length).toBe(1);
    expect(r.closedTrades[0].entryPrice).toBeCloseTo(fillPx, 10);
    expect(r.closedTrades[0].reason).toBe("fold_end");
    expect(r.fees).toBeGreaterThan(commission);
    // Costs scale with the cost model: a zero-cost run of the same path ends higher.
    const free = simulatePortfolioWindow(stocksCfg({ slippageBps: 0, commissionBps: 0 }), { ...WIN, to: "2021-06-03T00:00:00Z" }, { decide: constantDecide({ SPY: 1 }), planOrders });
    expect(free.fees).toBe(0);
    expect(free.finalEquity).toBeGreaterThan(r.finalEquity);
  });

  test("accounting invariant: finalEquity − initial = Σ closed-episode pnl − margin interest; trades counts agree; fold end flattens the book", () => {
    for (const r of [
      simulatePortfolioWindow(stocksCfg({ marginInterest: { annualRate: 0.065 } }), WIN, coreKernel),
      simulatePortfolioWindow(stocksCfg({ commissionBps: 3 }), WIN, { decide: constantDecide({ SPY: 0.7, GLD: 0.5, IEF: 0.3 }), planOrders }),
    ]) {
      const pnl = r.closedTrades.reduce((s, t) => s + t.pnl, 0);
      expect(r.finalEquity - 50_000).toBeCloseTo(pnl - (r.marginInterest ?? 0), 6);
      expect(r.trades).toBe(r.closedTrades.length);
      expect(Object.values(r.tradesBySymbol).reduce((s, v) => s + v.trades, 0)).toBe(r.trades);
      expect(Object.values(r.tradesBySymbol).reduce((s, v) => s + v.grossPnl, 0)).toBeCloseTo(pnl, 6);
      expect(Object.values(r.tradesBySymbol).reduce((s, v) => s + v.fees, 0)).toBeCloseTo(r.fees, 6);
      expect(r.totalReturn).toBeCloseTo(r.finalEquity / 50_000 - 1, 12);
      expect(r.equityHistory[r.equityHistory.length - 1].eq).toBeCloseTo(r.finalEquity, 6);
      expect(r.closedTrades.filter(t => t.reason === "fold_end").length).toBeGreaterThan(0);
      expect(r.ruined).toBe(false);
      expect(r.liquidations).toBe(0);
      expect(r.hash).toHaveLength(64);
    }
  });

  test("daily margin interest: ACT/365 on the cash borrowed at the previous close, weekends included", () => {
    // Weight 1.5 held constant (wide band ⇒ no adjustments): borrowed cash is
    // constant after the first fill, so the total interest is borrowed × rate ×
    // (calendar days first→last session) / 365.
    const rate = 0.065;
    const win = { ...WIN, to: "2021-07-01T00:00:00Z" };
    const venue: VenueRules = { ...alpaca, rebalanceBand: 0.9 };
    const r = simulatePortfolioWindow(stocksCfg({ marginInterest: { annualRate: rate } }, d1Strategy, venue), win, { decide: constantDecide({ SPY: 1.5 }), planOrders });
    const first = r.closedTrades[0];
    expect(r.closedTrades.length).toBe(1);
    let borrowed = first.qty! * first.entryPrice! - 50_000; // commission 0
    const dates = r.dailyReturns.map(d => d.date);
    let expected = 0;
    for (let i = 1; i < dates.length; i++) {
      // The debit balance compounds: yesterday's interest is borrowed today.
      const days = (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 86_400_000;
      const interest = borrowed * rate * days / 365;
      expected += interest;
      borrowed += interest;
    }
    expect(r.marginInterest).toBeCloseTo(expected, 6);
    expect((Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86_400_000).toBe(29); // 06-01 → 06-30: weekends accrue
    // Weekend sessions charge 3 days: Monday 06-07 vs Tuesday 06-08.
    const eq = new Map(r.dailyReturns.map((d, i) => [d.date, r.equityHistory[i + 1].eq]));
    const spy = new Map(fixtureBars({ source: "alpaca_wide", from: "2020-01-02", sessions: 700, series: [{ symbol: "SPY", seed: 1, startPrice: 300, driftAnnual: 0.15, volAnnual: 0.18 }] }).map(b => [new Date(b.timestamp).toISOString().slice(0, 10), b.close]));
    const dailyInterest = (d: string, prev: string) => (eq.get(prev)! + first.qty! * (spy.get(d)! - spy.get(prev)!)) - eq.get(d)!;
    // 3 / (1 + 3·rate/365): Tuesday accrues on a balance that already holds Monday's 3-day interest.
    expect(dailyInterest("2021-06-07", "2021-06-04") / dailyInterest("2021-06-08", "2021-06-07")).toBeCloseTo(3 / (1 + 3 * rate / 365), 6);
    const noRate = simulatePortfolioWindow(stocksCfg({}, d1Strategy, venue), win, { decide: constantDecide({ SPY: 1.5 }), planOrders });
    expect(noRate.marginInterest).toBe(0);
    expect(noRate.finalEquity - r.finalEquity).toBeCloseTo(r.marginInterest!, 6);
  });

  test("stops: a TargetBook stop at or above the day's low sells everything at the level; a gap through it fills at the open; otherwise nothing", () => {
    // Hand-made tape: flat 100s, one crash day with a wick, one gap day.
    const dbPath = join(tmp, "stops.db");
    const db = new Database(dbPath);
    const stamps = usSessionTimestamps("2024-01-02", 12);
    const bars = [
      [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
      [100, 101, 93, 99],   // idx 5: wick to 93 → the 5 % stop (95) fills at 95
      [99, 100, 98, 99], [99, 100, 98, 99],
      [90, 91, 89, 90],     // idx 8: gap open 90 < stop 94.05 (re-entry at 99) → fills at the open
      [90, 91, 89, 90], [90, 91, 89, 90], [90, 91, 89, 90],
    ];
    db.run(`CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume INTEGER, PRIMARY KEY(symbol, timeframe, source, timestamp))`);
    const ins = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
    bars.forEach((b, i) => ins.run("AAA", "1d", "alpaca_wide", stamps[i], b[0], b[1], b[2], b[3], 1));
    db.close();
    const strategy: PortfolioStrategyConfig = { ...d1Strategy, universe: ["AAA"], inceptionGuardBars: 1 };
    const stopDecide: PortfolioKernel["decide"] = (input) => ({
      asOf: input.view.asOf, weights: { AAA: 1 }, memory: input.book.memory, diagnostics: {},
      // A 5 % stop from the position's average entry (the shape the core emits).
      stops: input.book.positions.map(p => ({ symbol: p.symbol, stopPrice: p.avgEntryPrice * 0.95 })),
    });
    const cfg = stocksCfg({ universe: ["AAA"], refSymbol: "AAA", dbPath, warmupDays: 10, slippageBps: 0 }, strategy);
    const dates = stamps.map(t => new Date(t).toISOString().slice(0, 10));
    const r = simulatePortfolioWindow(cfg, { label: "s", from: dates[1] + "T00:00:00Z", to: new Date(stamps[11] + 86_400_000).toISOString() }, { decide: stopDecide, planOrders });
    const stops = r.closedTrades.filter(t => t.reason === "stop_loss");
    expect(stops.length).toBe(2);
    expect(stops[0].exitPrice).toBe(95);                 // wick through 95 → at the level
    expect(stops[0].exitAt).toBe(stamps[5]);
    expect(stops[1].exitPrice).toBe(90);                 // gap → at the open
    expect(stops[1].exitAt).toBe(stamps[8]);
    // Re-entry the session after a stop (signal still on), as pre-registered.
    expect(r.closedTrades.filter(t => t.entryAt === stamps[6]).length).toBe(1);
    expect(r.portfolioDiagnostics.stopOrders).toBe(2);
    // Sessions whose low stayed above the level never stop.
    expect(r.closedTrades.filter(t => t.reason === "stop_loss" && ![stamps[5], stamps[8]].includes(t.exitAt)).length).toBe(0);
  });

  test("funding (perps): the book held through each UTC day pays the day's three settlements at the close mark; the last day of the window pays two", () => {
    const rate = 0.0001;
    const win = { label: "f", from: "2022-01-01T00:00:00Z", to: "2022-01-11T00:00:00Z" };
    const venue: VenueRules = { ...binance, rebalanceBand: 0.9, qtyStep: undefined, fractional: true };
    const cfg = cryptoCfg({ slippageBps: 0, commissionBps: 0 });
    cfg.portfolio = { strategy: { ...d3Strategy, stop: { mode: "none" } }, venue };
    const r = simulatePortfolioWindow(cfg, win, { decide: constantDecide({ "BTC/USD": 1 }), planOrders });
    const btc = new Map(fixtureBars({ source: "binance_futures", from: "2021-01-01", sessions: 800, series: [{ symbol: "BTC/USD", seed: 11, startPrice: 30_000, driftAnnual: 0.4, volAnnual: 0.6 }] }).map(b => [new Date(b.timestamp).toISOString().slice(0, 10), b]));
    const qty = 5_000 / btc.get("2021-12-31")!.close;
    let expected = 0;
    for (const d of r.dailyReturns.map(x => x.date)) {
      const settlements = d === "2022-01-10" ? 2 : 3; // the 00:00 of toMs belongs to the next fold
      expected += qty * btc.get(d)!.close * rate * settlements;
    }
    expect(r.portfolioDiagnostics.sessions).toBe(10);
    expect(r.funding).toBeCloseTo(-expected, 6); // paid by the long → negative cash impact
    expect(r.closedTrades[0].pnl).toBeCloseTo(qty * (btc.get("2022-01-10")!.close - btc.get("2021-12-31")!.close) - expected, 4);
    expect(r.tradesBySymbol["BTC/USD"].funding).toBeCloseTo(-expected, 6);
    expect(r.portfolioDiagnostics.fundingMissingSymbolSessions).toBe(0);
    const noFunding = simulatePortfolioWindow({ ...cfg, funding: false }, win, { decide: constantDecide({ "BTC/USD": 1 }), planOrders });
    expect(noFunding.funding).toBe(0);
    expect(noFunding.finalEquity - r.finalEquity).toBeCloseTo(expected, 6);
  });

  test("crypto labels are UTC days (weekends included); venue qtyStep rounding reaches the fills", () => {
    const r = simulatePortfolioWindow(cryptoCfg(), { label: "c", from: "2022-03-01T00:00:00Z", to: "2022-04-01T00:00:00Z" }, { decide: constantDecide({ "BTC/USD": 0.5, "SOL/USD": 0.5 }), planOrders });
    expect(r.dailyReturns.length).toBe(31);
    expect(r.dailyReturns[0].date).toBe("2022-03-01");
    expect(r.dailyReturns[30].date).toBe("2022-03-31");
    expect(r.equityHistory[0].t).toBe(Date.parse("2022-03-01T00:00:00Z"));
    const sol = r.closedTrades.find(t => t.symbol === "SOL/USD")!;
    expect(Number.isInteger(sol.qty!)).toBe(true); // step 1
    expect(r.funding).toBeLessThan(0);
  });
});

describe("portfolio runner — protocol plumbing", () => {
  test("the strategy memory crosses folds through initialRiskState; the trial-visible RiskState keeps its shape", () => {
    const log: Array<{ asOf: string; exec?: string; memory: Record<string, unknown>; positions: number }> = [];
    const kernel = { decide: constantDecide({ SPY: 0.5 }, log), planOrders };
    const r0 = simulatePortfolioWindow(stocksCfg(), WIN, kernel);
    const n0 = r0.portfolioDiagnostics.sessions;
    expect(log[0].memory).toEqual({});
    expect(log[n0 - 1].memory).toEqual({ n: n0 - 1 });
    const state = r0.finalRiskState as PortfolioChainState;
    expect(state.portfolioMemory).toEqual({ n: n0 });
    expect(state.peakEquity).toBeGreaterThan(0);
    expect(state.stateVersion).toBe(3);
    // Fold 1 starts flat at initialEquity but remembers.
    const r1 = simulatePortfolioWindow(stocksCfg(), { label: "1/test", from: "2021-09-01T00:00:00Z", to: "2021-12-01T00:00:00Z" }, kernel, state);
    expect(log[n0].memory).toEqual({ n: n0 });
    expect(log[n0].positions).toBe(0);
    expect(r1.equityHistory[0].eq).toBe(50_000);
    expect((r1.finalRiskState as PortfolioChainState).portfolioMemory).toEqual({ n: n0 + r1.portfolioDiagnostics.sessions });
  });

  test("real core, D1 config: deterministic, sessions = weekdays in the window, orders with adjustments counted, P&L by asset class", async () => {
    const runner = makePortfolioRunner(coreKernel, { assetClasses: { SPY: "equity", IEF: "bond", GLD: "commodity" } });
    const a = await runner(stocksCfg(), WIN);
    const b = await runner(stocksCfg(), WIN);
    expect(a).not.toBeNull();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const d = (a as any).portfolioDiagnostics;
    expect(d.sessions).toBe(a!.dailyReturns.length);
    expect(d.orders).toBe(d.openingOrders + d.closingOrders + d.adjustmentOrders + d.stopOrders);
    expect(d.adjustmentOrders).toBeGreaterThan(0); // daily rebalance without band resizes the book
    expect(d.ordersPerSession).toBeCloseTo(d.orders / d.sessions, 12);
    expect(d.avgGross).toBeGreaterThan(0);
    expect(d.avgGross).toBeLessThanOrEqual(1.8 + 1e-9);
    const classes = Object.keys(d.pnlByAssetClass);
    expect(classes.every(c => ["equity", "bond", "commodity"].includes(c))).toBe(true);
    expect(Object.values(d.pnlByAssetClass as Record<string, number>).reduce((s, v) => s + v, 0)).toBeCloseTo(a!.closedTrades.reduce((s, t) => s + t.pnl, 0), 6);
    expect(a!.turnoverAnnual).toBeGreaterThan(0);
    expect(a!.config).toEqual(stocksCfg());
    expect(a!.sleeve).toBe("stocks");
  });

  test("real core, D3 config: stops re-anchored on actual fills, funding charged, UTC labels", async () => {
    const r = (await runPortfolioReplay(cryptoCfg(), { label: "d3", from: "2022-01-01T00:00:00Z", to: "2022-07-01T00:00:00Z" }))!;
    expect(r.dailyReturns.length).toBe(181);
    expect(r.funding).not.toBe(0);
    const mem = (r.finalRiskState as PortfolioChainState).portfolioMemory as { portfolioCore: { stops: Record<string, unknown> } };
    expect(mem.portfolioCore).toBeDefined();
    expect(r.finalEquity - 5_000).toBeCloseTo(r.closedTrades.reduce((s, t) => s + t.pnl, 0), 6);
  });

  test("cfg.universe is the domain: a LOO-reduced universe narrows the strategy; the runner refuses non-portfolio configs", async () => {
    const seen: string[][] = [];
    const spy: PortfolioKernel["decide"] = (input) => {
      seen.push([...(input.config as { universe: string[] }).universe]);
      return { asOf: input.view.asOf, weights: {}, stops: [], memory: input.book.memory, diagnostics: {} };
    };
    const cfg = stocksCfg({ universe: ["SPY", "IEF"] });
    simulatePortfolioWindow(cfg, { ...WIN, to: "2021-06-03T00:00:00Z" }, { decide: spy, planOrders });
    expect(seen[0]).toEqual(["SPY", "IEF"]);
    expect(effectiveStrategy(d1Strategy, new Set(ETFS))).toBe(d1Strategy);
    expect(() => effectiveStrategy(d1Strategy, new Set(["ZZZ"]))).toThrow(/empty/);
    const { portfolio: _p, ...legacy } = stocksCfg();
    await expect(runPortfolioReplay(legacy as ReplayConfig, WIN)).rejects.toThrow(/no `portfolio` block/);
  });

  test("fails closed on a missing timeline or an insufficient warmup", () => {
    expect(() => simulatePortfolioWindow(stocksCfg({ refSymbol: "NOPE", universe: ["NOPE", "SPY"] }), WIN, coreKernel)).toThrow(/no 1d bars for refSymbol/);
    expect(() => simulatePortfolioWindow(stocksCfg({ warmupDays: 0 }), WIN, coreKernel)).toThrow(/increase warmupDays/);
  });
});
