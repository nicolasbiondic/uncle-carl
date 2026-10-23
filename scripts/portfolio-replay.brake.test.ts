// RW4b (docs/reports/RW-reescritura-rentable.md §14): the drawdown brake and the fast vol window
// through the daily simulator — identity when they do not bind, de-risking in a decline, and the
// brake's high-water mark crossing folds in the next fold's dollars. Synthetic tapes only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simulatePortfolioWindow, type PortfolioChainState } from "./portfolio-replay";
import type { PortfolioReplayConfig } from "./walk-forward";
import type { CoreMemory } from "../src/portfolio-engine";
import type { VolManagedConfig, VenueRules } from "../src/portfolio-engine/types";
import { writeDailyFixture } from "./lib/portfolioSynthetic";

const tmp = mkdtempSync(join(tmpdir(), "rw4b-replay-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const UNIVERSE = ["SPY", "QQQ", "GLD"];
const db = join(tmp, "decline.db");
// A long, noisy decline: the book must draw down for the brake to have something to do.
writeDailyFixture(db, {
  source: "alpaca_wide", from: "2020-01-02", sessions: 900,
  series: [
    { symbol: "SPY", seed: 21, startPrice: 300, driftAnnual: -0.25, volAnnual: 0.28 },
    { symbol: "QQQ", seed: 22, startPrice: 250, driftAnnual: -0.30, volAnnual: 0.34 },
    { symbol: "GLD", seed: 23, startPrice: 150, driftAnnual: -0.10, volAnnual: 0.18 },
  ],
});

const venue: VenueRules = { venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0.01 };
const managed: VolManagedConfig = {
  kind: "volManaged", universe: UNIVERSE, inceptionGuardBars: 252, volLookback: 63, covLookback: 21,
  portfolioVolTarget: 0.15, annualization: 252, perAssetCap: 0.6, maxGross: 1.5,
};

function cfgOf(strategy: VolManagedConfig): PortfolioReplayConfig {
  return {
    sleeve: "stocks", universe: [...UNIVERSE], timeframe: "1d", source: "alpaca_wide", refSymbol: "SPY", rthOnly: false, funding: false,
    barMinutes: 1440, barMinutesEq: 1440, slippageBps: 2, commissionBps: 0, initialEquity: 50_000, cadenceMin: 1440, notionalPctPerSlot: 0.25,
    entryPct: 0, exitPct: 0, maxLongs: 0, maxShorts: 0, shortFunding: "credit", warmupDays: 420, dbPath: db,
    marginInterest: { annualRate: 0.065 },
    portfolio: { strategy, venue },
  } as PortfolioReplayConfig;
}
const FOLD0 = { label: "0/test", from: "2021-06-01T00:00:00Z", to: "2021-10-01T00:00:00Z" };
const FOLD1 = { label: "1/test", from: "2021-10-01T00:00:00Z", to: "2022-02-01T00:00:00Z" };
const brake = { startDrawdown: 0.01, maxDrawdown: 0.06, floorScale: 0.2 };

describe("drawdown brake and fast vol in the daily simulator", () => {
  test("identity: knobs absent, or a brake that never binds, give the same book day by day", () => {
    const plain = simulatePortfolioWindow(cfgOf(managed), FOLD0);
    const quiet = simulatePortfolioWindow(cfgOf({ ...managed, drawdownBrake: { startDrawdown: 0.99, maxDrawdown: 1, floorScale: 1 } }), FOLD0);
    expect(quiet.dailyReturns).toEqual(plain.dailyReturns);
    expect(quiet.finalEquity).toBe(plain.finalEquity);
    // No brake: the replay's memory carries no peak.
    expect(JSON.stringify((plain.finalRiskState as PortfolioChainState).portfolioMemory)).not.toContain("peakEquity");
    expect(JSON.stringify((quiet.finalRiskState as PortfolioChainState).portfolioMemory)).toContain("peakEquity");
  });

  test("in a decline the brake de-risks: lower mean gross and no deeper drawdown; the margin interest is charged on what remains", () => {
    const plain = simulatePortfolioWindow(cfgOf(managed), FOLD1, undefined, undefined);
    const braked = simulatePortfolioWindow(cfgOf({ ...managed, drawdownBrake: brake }), FOLD1);
    expect(plain.maxDrawdown).toBeGreaterThan(0.03);
    expect(plain.portfolioDiagnostics.avgGross).toBeLessThan(1.45); // the 1.5 cap does not bind: the brake can act // the fixture does hurt
    expect(braked.portfolioDiagnostics.avgGross).toBeLessThan(plain.portfolioDiagnostics.avgGross);
    expect(braked.maxDrawdown).toBeLessThanOrEqual(plain.maxDrawdown + 1e-12);
    expect(braked.marginInterest).toBeLessThanOrEqual(plain.marginInterest + 1e-9);
    expect(plain.marginInterest).toBeGreaterThan(0); // gross > 1 at times: the interest is in the P&L
  });

  test("fast vol lowers leverage with its own window and changes nothing else about the contract", () => {
    const plain = simulatePortfolioWindow(cfgOf(managed), FOLD1);
    const fast = simulatePortfolioWindow(cfgOf({ ...managed, fastVolLookback: 5 }), FOLD1);
    expect(fast.portfolioDiagnostics.avgGross).toBeLessThanOrEqual(plain.portfolioDiagnostics.avgGross + 1e-12);
    expect(fast.dailyReturns.length).toBe(plain.dailyReturns.length);
    expect(fast.dailyReturns).not.toEqual(plain.dailyReturns);
  });

  test("fold chaining: the high-water mark is re-expressed in the next fold's dollars and the drawdown carries over", () => {
    const cfg = cfgOf({ ...managed, drawdownBrake: brake });
    const r0 = simulatePortfolioWindow(cfg, FOLD0);
    const state = r0.finalRiskState as PortfolioChainState;
    const peak = ((state.portfolioMemory!.portfolioCore) as CoreMemory).peakEquity!;
    const maxMark = Math.max(...r0.equityHistory.map(e => e.eq));
    // 1 − initial/peak' = 1 − final/peak (peak = best mark of the finished fold, floor: the starting capital).
    expect(1 - cfg.initialEquity / peak).toBeCloseTo(1 - r0.finalEquity / maxMark, 2);
    const chained = simulatePortfolioWindow(cfg, FOLD1, undefined, state);
    const fresh = simulatePortfolioWindow(cfg, FOLD1);
    // Deterministic: the same inputs give the same book.
    expect(simulatePortfolioWindow(cfg, FOLD1, undefined, state).dailyReturns).toEqual(chained.dailyReturns);
    // The previous fold ended inside a drawdown (fixture fact): the chained run starts already braked.
    expect(r0.finalEquity).toBeLessThan(maxMark * 0.97);
    expect(chained.portfolioDiagnostics.avgGross).toBeLessThan(fresh.portfolioDiagnostics.avgGross);
  });
});
