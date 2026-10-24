// RW5 integration: synthetic SQLite only; replay and the live runner use the same kernel.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreKernel, makePortfolioRunner, simulatePortfolioWindow, type PortfolioKernel } from "./portfolio-replay";
import { candidateToReplayConfig, loadManifest, runWalkForward, type PortfolioReplayConfig } from "./walk-forward";
import { evaluatePortfolioCriteria } from "./portfolio-criteria";
import { IndexMembershipView } from "./lib/portfolioData";
import { usSessionTimestamps, writeDailyFixture } from "./lib/portfolioSynthetic";
import { PortfolioEngine } from "../src/portfolio-engine/live/PortfolioEngine";
import { HistoricalPriceView } from "../src/portfolio-engine/live/priceView";
import { FakeVenue } from "../src/portfolio-engine/live/testSupport";
import { getPortfolioDecision } from "../src/portfolio-engine/live/persistence";
import { loadSleeveRows } from "../src/portfolio-engine/live/rows";
import { makeTestDb } from "../src/test-support/db";
import { getDB } from "../src/db/database";
import type { RegimeMemory } from "../src/portfolio-engine/contingency";
import type { TargetBook, VolManagedConfig } from "../src/portfolio-engine/types";

const tmp = mkdtempSync(join(tmpdir(), "rw5-synthetic-"));
const path = join(tmp, "hist.db");
const stamps = usSessionTimestamps("2020-01-02", 40);
const dates = stamps.map(t => new Date(t).toISOString().slice(0, 10));
const symbols = ["ETF", "A", "B", "REF", "DEF", "CASH", "SH"];
writeDailyFixture(path, { source: "alpaca_wide", from: dates[0], sessions: 40,
  membership: [{ index: "sp500", ticker: "A", start: dates[0], end: dates[25] }, { index: "sp500", ticker: "B", start: dates[0], end: null }],
  series: symbols.map((symbol, i) => ({ symbol, seed: i + 1, startPrice: 100, driftAnnual: 0.1, volAnnual: 0.15 })) });
const db = new Database(path);
const update = db.prepare("UPDATE historical_bars SET open=?, high=?, low=?, close=?, volume=? WHERE symbol=? AND timestamp=?");
for (let i = 0; i < stamps.length; i++) {
  for (const s of ["REF", "DEF", "CASH"]) {
    const px = s === "REF" ? (i < 12 ? 100 + i : i < 24 ? 112 - 3 * (i - 12) : 76 + 4 * (i - 24))
      : s === "DEF" ? 100 + i * 0.3 + (i % 2) * 0.1 : 100;
    update.run(px, px, px, px, 100, s, stamps[i]);
  }
  db.run("UPDATE historical_bars SET volume=? WHERE symbol='A' AND timestamp=?", i < 18 ? 100_000 : 1, stamps[i]);
  db.run("UPDATE historical_bars SET volume=? WHERE symbol='B' AND timestamp=?", i < 18 ? 1 : 100_000, stamps[i]);
}
const membership = IndexMembershipView.load(db, "sp500");
afterAll(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });
beforeAll(() => { makeTestDb(); });

const strategy: VolManagedConfig = {
  kind: "volManaged", universe: ["ETF"], inceptionGuardBars: 5, volLookback: 3, covLookback: 3,
  annualization: 252, portfolioVolTarget: 0.25, perAssetCap: 0.8, maxGross: 2,
  pitUniverse: { topN: 1, liquidityLookback: 3, minHoldingRebalances: 3 },
  regimeOverlay: { signals: [{ kind: "maTrend", symbol: "REF", period: 3, sampling: "daily" }], combine: "any",
    confirmationDecisions: 2, coreScale: 0.25,
    defensive: { assets: ["DEF"], momentumLookback: 3, volLookback: 3, cashProxy: "CASH" }, hedge: { symbol: "SH", fraction: 0.1 } },
};

function cfg(config = strategy): PortfolioReplayConfig {
  const m = loadManifest(join(import.meta.dir, "../experiments/rw3-e1-stocks-lev-vt25-g200-v1.json"));
  const c = candidateToReplayConfig(m, m.candidates[0], "base") as PortfolioReplayConfig;
  return { ...c, dbPath: path, universe: symbols, refSymbol: "ETF", warmupDays: 100, membership: { index: "sp500" },
    portfolio: { ...c.portfolio, strategy: config } };
}
const win = { label: "synthetic", from: dates[8], to: dates[39] };

test("both knobs compose: every replay target equals live decide(), signal-only positions are never adopted", async () => {
  getDB().exec("DELETE FROM trades; DELETE FROM portfolio_decisions; DELETE FROM activity_log;");
  const seen = new Map<string, TargetBook>();
  const kernel: PortfolioKernel = { ...coreKernel, decide: input => {
    expect(input.view.history("REF", 10_000).at(-1)!.date).toBe(input.view.asOf);
    const target = coreKernel.decide(input);
    // Real research view vs real live view, same synthetic database and inputs.
    const liveView = new HistoricalPriceView({ db, asOf: input.view.asOf, symbols });
    expect(JSON.stringify(coreKernel.decide({ ...input, view: liveView }))).toBe(JSON.stringify(target));
    seen.set(input.executionSession!, target);
    return target;
  } };
  const replay = simulatePortfolioWindow(cfg(), win, kernel);
  const venue = new FakeVenue();
  venue.positions_ = [{ symbol: "REF", qty: 10, avgEntryPrice: 100 }]; // belongs to somebody else
  const live = new PortfolioEngine({
    accountId: "momentum_stocks", strategyVersion: "rw5-parity", config: strategy, capital: 50_000,
    market: "stocks", rowMarket: "stock", quoteAsset: "USD", venue, mode: "live", membership,
    openPriceView: (asOf, requested) => new HistoricalPriceView({ db, asOf, symbols: requested }),
    tradingEnabled: () => true, now: () => Date.parse(dates[39]),
    alert: (_context, message) => { throw new Error(message); },
    heartbeats: { register: () => {}, beat: () => {} },
  });
  for (const [session, target] of seen) {
    const prices = new HistoricalPriceView({ db, asOf: target.asOf, symbols });
    venue.prices_ = Object.fromEntries(symbols.map(s => [s, prices.lastClose(s)!]));
    expect((await live.runSession({ session, asOf: target.asOf })).status).toBe("submitted");
    const stored = getPortfolioDecision("momentum_stocks", "rw5-parity", session)!;
    expect(stored.weights).toEqual(target.weights);
    expect(stored.memory).toEqual(target.memory); // post-fill refresh must not age confirmations/tenure
    expect(stored.diagnostics.regimeOverlay).toEqual(target.diagnostics.regimeOverlay);
    expect(stored.diagnostics.pitUniverse).toEqual(target.diagnostics.pitUniverse);
  }
  expect(venue.submits.some(s => s.order.symbol === "REF")).toBe(false);
  expect(loadSleeveRows("momentum_stocks").some(r => r.symbol === "REF")).toBe(false);
  expect(venue.positions_.find(p => p.symbol === "REF")!.qty).toBe(10);
  expect([...seen.values()].some(t => "A" in (t.diagnostics.pitUniverse as { ages: Record<string, number> }).ages)).toBe(true);
  expect([...seen.values()].some(t => "B" in (t.diagnostics.pitUniverse as { ages: Record<string, number> }).ages)).toBe(true);

  const telemetry = replay.portfolioDiagnostics.regimeOverlay!;
  expect(telemetry.timeInState.riskOn).toBeGreaterThan(0);
  expect(telemetry.timeInState.riskOff).toBeGreaterThan(0);
  expect(telemetry.timeInState.riskOn + telemetry.timeInState.riskOff).toBe(seen.size);
  expect(telemetry.switches).toBeGreaterThanOrEqual(3);
  for (const key of ["riskOn", "riskOff"] as const) {
    const targets = [...seen.values()].filter(t => (t.diagnostics.regimeOverlay as RegimeMemory).riskOff === (key === "riskOff"));
    expect(telemetry.timeInState[key]).toBe(targets.length);
    expect(telemetry.riskOffDays).toBe(telemetry.timeInState.riskOff);
    for (const s of symbols) {
      const expected = targets.reduce((sum, t) => sum + (t.weights[s] ?? 0), 0) / targets.length;
      expect(telemetry.weightsByState[key][s] ?? 0).toBeCloseTo(expected, 12);
    }
  }
});

test("PIT + overlay: the overlay's symbols load even when a leave-one-out chain drops them from cfg.universe", () => {
  const full = simulatePortfolioWindow(cfg(), win);
  for (const drop of ["DEF", "CASH", "SH", "REF"]) {
    const without = simulatePortfolioWindow({ ...cfg(), universe: symbols.filter(s => s !== drop) }, win);
    expect(without.dailyReturns).toEqual(full.dailyReturns);
  }
});

test("fold chaining preserves confirmation and PIT tenure; default-off replay has no regime telemetry", () => {
  const end = dates[14];
  const first = simulatePortfolioWindow(cfg(), { ...win, to: end });
  const second = simulatePortfolioWindow(cfg(), { ...win, from: end }, coreKernel, first.finalRiskState);
  const whole = simulatePortfolioWindow(cfg(), win);
  expect(second.finalRiskState!.portfolioMemory).toEqual(whole.finalRiskState!.portfolioMemory);
  const a = first.portfolioDiagnostics.regimeOverlay!, b = second.portfolioDiagnostics.regimeOverlay!;
  expect(a.switches + b.switches).toBe(whole.portfolioDiagnostics.regimeOverlay!.switches);
  expect(a.riskOffDays + b.riskOffDays).toBe(whole.portfolioDiagnostics.regimeOverlay!.riskOffDays);
  const plain = simulatePortfolioWindow(cfg({ ...strategy, regimeOverlay: undefined, pitUniverse: undefined }), win);
  expect(plain.portfolioDiagnostics).not.toHaveProperty("regimeOverlay");
});

test("RW5 criteria excludes actual PIT/core/defensive contributors without mutating the registered manifest", async () => {
  const m = loadManifest(join(import.meta.dir, "../experiments/rw3-e1-stocks-lev-vt25-g200-v1.json"));
  m.name = "rw5-e1-synthetic-criteria";
  m.data = { ...m.data, dbPath: path, universe: symbols, refSymbol: "ETF", membership: { index: "sp500" } };
  m.asOf = dates[39];
  m.window = { from: dates[8], to: dates[39], outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0, warmupDays: 100 };
  m.trialAccounting = { priorUniqueTrials: 0, complete: true };
  m.candidates = [{ name: "synthetic", cadenceMin: 1440, portfolio: { ...cfg().portfolio,
    strategy: { ...strategy, regimeOverlay: { ...strategy.regimeOverlay!, hedge: undefined } } } }];
  const before = JSON.stringify(m);
  const { summary, outputDir } = await runWalkForward(m, { runner: makePortfolioRunner(), breakEven: false });
  try {
    const report = await evaluatePortfolioCriteria(m, summary, outputDir, "synthetic-only", { controlArtifact: outputDir, quiet: true });
    expect(report.criteria.R6.detail?.excluded).toHaveLength(1);
    expect(JSON.stringify(m)).toBe(before);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
