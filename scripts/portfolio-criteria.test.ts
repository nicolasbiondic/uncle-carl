import { describe, expect, test } from "bun:test";
import type { ReplayResult } from "./backtest-momentum-wf";
import type { WalkForwardSummary } from "./walk-forward";
import {
  CRITERIA,
  alignedSharpe,
  annualizedSharpe,
  chainDailyReturns,
  computeCriteria,
  correlationOnCommonDates,
  designOf,
  passiveDecideFor,
  passiveEqualWeightDecide,
  passiveTrendDecide,
  seriesOf,
  topDecileSymbols,
  yearPnlShares,
  type CriteriaInputs,
  type DailySeries,
} from "./portfolio-criteria";
import { SessionPriceView, seriesFromBars } from "./lib/portfolioData";
import type { MembershipView, PortfolioStrategyConfig } from "../src/portfolio-engine/types";
import { mulberry32 } from "./lib/syntheticCandles";

// ── synthetic summary builder ─────────────────────────────────────────────

function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(from);
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

function foldResult(label: string, dates: string[], rets: number[], extra: Partial<ReplayResult> = {}, initial = 50_000): ReplayResult {
  let eq = initial;
  const equityHistory = [{ t: Date.parse(dates[0]) - 86_400_000, eq }];
  const dailyReturns = dates.map((date, i) => { eq *= 1 + rets[i]; equityHistory.push({ t: Date.parse(date) + 5 * 3_600_000, eq }); return { date, ret: rets[i] }; });
  return {
    sleeve: "stocks", window: { label, from: new Date(equityHistory[0].t).toISOString(), to: new Date(Date.parse(dates[dates.length - 1]) + 86_400_000).toISOString() },
    fromMs: equityHistory[0].t, toMs: Date.parse(dates[dates.length - 1]) + 86_400_000,
    config: { initialEquity: initial, rthOnly: false, sleeve: "stocks", source: "alpaca_wide" } as ReplayResult["config"],
    finalEquity: eq, totalReturn: eq / initial - 1, maxDrawdown: 0.1, sharpe: annualizedSharpe(rets, 252), winRate: 0.5, trades: 4, tradesPerDay: 0.1,
    expectancy: 1, fees: 1, funding: 0, marginInterest: 2, liquidations: 0, marginRejects: 0, ruined: false, bench: 0,
    dailyReturns, sessionReturns: [], tradesBySymbol: { AAA: { trades: 2, grossPnl: 300, fees: 0, funding: 0 }, BBB: { trades: 1, grossPnl: 100, fees: 0, funding: 0 }, CCC: { trades: 1, grossPnl: -50, fees: 0, funding: 0 } },
    equityHistory, closedTrades: [], turnoverAnnual: 5, displacementCloses: 0, profitLockCloses: 0, gateBlocks: {}, hash: "h",
    finalRiskState: { peakEquity: eq, dayStartEquity: eq, dayStartedAt: 0, consecutiveLosses: 0, pausedUntil: 0, pauseReason: "", lastEvalAt: 0 },
    ...extra,
  };
}

function gaussianSeries(seed: number, n: number, mu: number, sigma: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const u1 = rng() || 1e-12, u2 = rng();
    return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  });
}

function summaryOf(outer: ReplayResult[], stress: ReplayResult[], over: Partial<WalkForwardSummary> = {}): WalkForwardSummary {
  return {
    manifestHash: "m", configHash: "c", dataHash: "d", codeHash: "k", asOfMs: 0, resolvedTo: "", selectedCandidate: null,
    outerSelection: outer.map(r => ({ foldPath: r.window.label, candidateName: "x", candidateHash: "h" })),
    innerSelection: [], outerTests: outer.map(r => ({ foldPath: r.window.label, result: r })), stressTests: stress.map(r => ({ foldPath: r.window.label, result: r })),
    stitchedOos: { totalReturn: 0.3, sharpe: 1.2, maxDrawdown: 0.12, winRate: 0.5, trades: 8, expectancy: 1, fees: 2, funding: 0, marginInterest: 4, liquidations: 0, marginRejects: 0, ruined: false, benchSharpe: 0.7 },
    concentration: { maxTradesFracByFold: [], maxPnlFracByFold: [], totalTradesBySymbol: {}, totalGrossPnlBySymbol: {} },
    loo: [{ excludedSymbol: "AAA", stitchedReturn: 0.2, stitchedSharpe: 0.9, stitchedMaxDrawdown: 0.1, totalTrades: 5 }, { excludedSymbol: "BBB", stitchedReturn: 0.25, stitchedSharpe: 1.1, stitchedMaxDrawdown: 0.1, totalTrades: 5 }],
    skippedFolds: [], outerPsr: 0.97, observations: 500, breakEvenSlippageBps: 9, breakEvenCurve: [{ slippageBps: 0, sharpe: 1.3, totalReturn: 0.3 }, { slippageBps: 10, sharpe: -0.1, totalReturn: -0.01 }],
    acceptance: {}, approved: false, approvalReason: "", complete: true, priorTrialsComplete: true,
    ...over,
  };
}

// Three calendar years so a healthy chain can satisfy "no year > 50 % of P&L".
const dates0 = weekdays("2022-01-03", 260), dates1 = weekdays("2023-01-02", 260), dates2 = weekdays("2024-01-01", 260);
const strat0 = gaussianSeries(1, 260, 0.0008, 0.008), strat1 = gaussianSeries(2, 260, 0.0008, 0.008), strat2 = gaussianSeries(4, 260, 0.0008, 0.008);
const outer = [foldResult("0/test", dates0, strat0), foldResult("1/test", dates1, strat1), foldResult("2/test", dates2, strat2)];
const stress = outer.map((r, i) => foldResult(`${i}/test`, [dates0, dates1, dates2][i], [strat0, strat1, strat2][i].map(x => x - 0.0002)));
const mine = chainDailyReturns(summaryOf(outer, stress));
const passiveWeak: DailySeries = new Map([...mine].map(([d, r]) => [d, r - 0.0006]));                    // same days, lower drift ⇒ lower Sharpe
const noise = gaussianSeries(3, mine.size, 0, 0.01);
const marketFlat: DailySeries = new Map([...mine.keys()].map((d, i) => [d, noise[i]]));                  // independent zero-drift market

function inputs(design: "D1" | "D2" | "D3", over: Partial<CriteriaInputs> = {}): CriteriaInputs {
  return { design, summary: summaryOf(outer, stress), ppy: 252, initialEquity: 50_000, baseSlippageBps: 2, passive: passiveWeak, market: marketFlat, exTopDecile: { excluded: ["AAA"], sharpe: 0.8, totalReturn: 0.2, maxDrawdown: 0.1 }, ...over };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("series helpers", () => {
  test("chainDailyReturns concatenates the outer folds in chronological order by session label", () => {
    const s = chainDailyReturns(summaryOf([outer[2], outer[0], outer[1]], []));
    expect(s.size).toBe(780);
    expect([...s.keys()][0]).toBe("2022-01-03");
    expect(s.get("2023-01-02")).toBe(strat1[0]);
  });

  test("alignedSharpe judges both series on their COMMON dates only", () => {
    const a = seriesOf([{ date: "2024-01-02", ret: 0.01 }, { date: "2024-01-03", ret: -0.01 }, { date: "2024-01-04", ret: 0.02 }, { date: "2024-01-05", ret: 0.0 }]);
    const b = seriesOf([{ date: "2024-01-03", ret: 0.005 }, { date: "2024-01-04", ret: 0.005 }, { date: "2024-01-09", ret: 0.5 }]);
    const r = alignedSharpe(a, b, 252);
    expect(r.dates).toEqual(["2024-01-03", "2024-01-04"]);
    expect(r.observations).toBe(2);
    expect(r.sharpeA).toBeCloseTo(annualizedSharpe([-0.01, 0.02], 252), 12);
    expect(r.sharpeB).toBe(0); // constant ⇒ sd 0 ⇒ 0
    expect(annualizedSharpe([0.01], 252)).toBe(0);
    expect(correlationOnCommonDates(a, a).corr).toBeCloseTo(1, 12);
  });

  test("yearPnlShares in stitched dollars, failing closed on non-positive P&L", () => {
    const hist = [{ t: Date.parse("2021-12-31"), eq: 100 }, { t: Date.parse("2022-06-01"), eq: 160 }, { t: Date.parse("2023-06-01"), eq: 200 }];
    const y = yearPnlShares(hist);
    expect(y.byYear).toEqual({ "2022": 60, "2023": 40 });
    expect(y.maxShare).toBeCloseTo(0.6, 12);
    expect(yearPnlShares([{ t: 0, eq: 100 }, { t: 86_400_000, eq: 90 }]).maxShare).toBe(Infinity);
  });

  test("topDecileSymbols: ceil(10 %) ≥ 1 by summed closed P&L, positive first", () => {
    expect(topDecileSymbols(summaryOf(outer, []))).toEqual(["AAA"]);
    const many = foldResult("0/test", dates0, strat0, { tradesBySymbol: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`S${i}`, { trades: 1, grossPnl: i, fees: 0, funding: 0 }])) });
    expect(topDecileSymbols(summaryOf([many], []))).toEqual(["S19", "S18"]);
  });

  test("designOf maps strategy kinds to D1/D2/D3", () => {
    expect(designOf({ kind: "xassetTrend" } as PortfolioStrategyConfig)).toBe("D1");
    expect(designOf({ kind: "factorCore" } as PortfolioStrategyConfig)).toBe("D2");
    expect(designOf({ kind: "cryptoTrend" } as PortfolioStrategyConfig)).toBe("D3");
  });
});

describe("computeCriteria — §2.5 thresholds and fail-closed semantics", () => {
  test("thresholds are the pre-registered table", () => {
    expect(CRITERIA.D1.c2MaxDrawdown).toBe(0.20); expect(CRITERIA.D2.c2MaxDrawdown).toBe(0.25); expect(CRITERIA.D3.c2MaxDrawdown).toBe(0.35);
    expect(CRITERIA.D3.c3StressMinSharpe).toBe(0.6); expect(CRITERIA.D1.c3StressMinSharpe).toBe(0.5);
    expect(CRITERIA.D1.c5Market).toBe("sixtyForty"); expect(CRITERIA.D2.c5MinExcess).toBe(0.05); expect(CRITERIA.D3.c5MinExcess).toBe(0.20);
    expect(CRITERIA.D3.c7MinExtraBpsPerSide).toBe(10); expect(CRITERIA.D1.c7MinExtraBpsPerSide).toBe(4);
    expect(CRITERIA.D3.c6b).toEqual({ kind: "worstLoo", minRatio: 0.6 });
  });

  test("a healthy D1 summary passes C1–C7; C8 stays external", () => {
    const r = computeCriteria(inputs("D1"));
    expect(r.criteria.C1).toMatchObject({ pass: true, value: 0.97, threshold: 0.95 });
    expect(r.criteria.C2).toMatchObject({ pass: true, value: 0.12, threshold: 0.20 });
    expect(r.criteria.C3.pass).toBe(true);
    expect(r.criteria.C3.value).toBeGreaterThan(0.5);
    expect(r.criteria.C4.pass).toBe(true);
    expect(r.criteria.C4.detail?.observations).toBe(780);
    expect(r.criteria.C5.pass).toBe(true);
    expect(r.criteria.C5.detail?.benchmark).toBe("sixtyForty");
    expect(r.criteria.C6.pass).toBe(true);
    expect(r.criteria.C6b).toMatchObject({ id: "C6b_exTopDecile", pass: true, value: 0.8, threshold: 0.3 });
    expect(r.criteria.C7).toMatchObject({ pass: true, value: 7, threshold: 4 }); // 9 − 2 bps
    expect(r.criteria.C8.pass).toBeNull();
    expect(r.allPass).toBe(true);
    expect(r.verdict).toMatch(/CUMPLE/);
    expect(r.reported.stitchedSharpe).toBe(1.2);
  });

  test("D3 uses the worst leave-one-out against 0.6 × the stitched Sharpe and its own thresholds", () => {
    const r = computeCriteria(inputs("D3", { ppy: 365, baseSlippageBps: 5 }));
    expect(r.criteria.C6b).toMatchObject({ id: "C6b_worstLoo", value: 0.9 });
    expect(r.criteria.C6b.threshold).toBeCloseTo(0.72, 12);
    expect(r.criteria.C6b.pass).toBe(true);
    expect(r.criteria.C6b.detail?.worstExcluded).toBe("AAA");
    expect(r.criteria.C7).toMatchObject({ value: 4, threshold: 10, pass: false }); // 9 − 5 < 10
    expect(r.criteria.C5.threshold).toBe(0.20);
    expect(r.criteria.C2.threshold).toBe(0.35);
    expect(r.allPass).toBe(false);
    expect(r.verdict).toMatch(/FALLA: C7/);
  });

  test("fail closed: missing passive / market / break-even / LOO / ex-top-decile, non-positive P&L, too few common days", () => {
    const r = computeCriteria(inputs("D1", {
      passive: null, market: null, marketError: "no IEF bars", exTopDecile: null,
      summary: summaryOf(outer, [], { breakEvenSlippageBps: undefined, outerPsr: undefined, loo: [] }),
    }));
    expect(r.criteria.C1).toMatchObject({ pass: false, value: null });
    expect(r.criteria.C1.reason).toMatch(/not computed/);
    expect(r.criteria.C3).toMatchObject({ pass: false, value: null, reason: "missing stress results" });
    expect(r.criteria.C4).toMatchObject({ pass: false, reason: "passive benchmark not computed" });
    expect(r.criteria.C5).toMatchObject({ pass: false, reason: "no IEF bars" });
    expect(r.criteria.C6b).toMatchObject({ pass: false, reason: "ex-top-decile re-run not computed" });
    expect(r.criteria.C7).toMatchObject({ pass: false, value: null });
    expect(r.allPass).toBe(false);
    const d3 = computeCriteria(inputs("D3", { summary: summaryOf(outer, stress, { loo: [] }) }));
    expect(d3.criteria.C6b).toMatchObject({ pass: false, reason: "no LOO results" });
    // A losing chain can never satisfy C6 (share of a non-positive total is undefined).
    const losing = outer.map((r, i) => foldResult(`${i}/test`, [dates0, dates1, dates2][i], [strat0, strat1, strat2][i].map(x => -Math.abs(x))));
    const l = computeCriteria(inputs("D1", { summary: summaryOf(losing, stress) }));
    expect(l.criteria.C6.pass).toBe(false);
    expect(l.criteria.C6.reason).toMatch(/≤ 0/);
    // Fewer than 30 common sessions is no evidence.
    const few: DailySeries = new Map([...mine].slice(0, 10));
    const f = computeCriteria(inputs("D1", { passive: few }));
    expect(f.criteria.C4.pass).toBe(false);
    expect(f.criteria.C4.reason).toMatch(/only 10 common sessions/);
  });

  test("C4/C5 compare on the SAME sessions: a benchmark missing half the days is judged on the overlap only", () => {
    const half: DailySeries = new Map([...mine].filter((_, i) => i % 2 === 0).map(([d, r]) => [d, r * 0.5]));
    const r = computeCriteria(inputs("D1", { passive: half }));
    expect(r.criteria.C4.detail?.observations).toBe(390);
    const strategyOnOverlap = annualizedSharpe([...half.keys()].map(d => mine.get(d)!), 252);
    expect(r.criteria.C4.detail?.strategySharpe).toBeCloseTo(strategyOnOverlap, 12);
  });

  test("C7: a curve that never crosses passes with value null + neverCrosses; crossing below base fails", () => {
    const inf = computeCriteria(inputs("D1", { summary: summaryOf(outer, stress, { breakEvenSlippageBps: Infinity }) }));
    expect(inf.criteria.C7.pass).toBe(true);
    expect(inf.criteria.C7.detail?.neverCrosses).toBe(true);
    const dead = computeCriteria(inputs("D1", { summary: summaryOf(outer, stress, { breakEvenSlippageBps: 0 }) }));
    expect(dead.criteria.C7).toMatchObject({ pass: false, value: -2 });
  });

  test("report-only block: correlations on common dates, turnover duration-weighted, P&L by class scaled to the stitched account", () => {
    const withDiag = outer.slice(0, 2).map((r, i) => ({ ...r, totalReturn: i === 0 ? 0.5 : 0.1, portfolioDiagnostics: { sessions: 260, orders: 520, openingOrders: 10, closingOrders: 10, adjustmentOrders: 500, stopOrders: 0, foldEndOrders: 3, ordersPerSession: 2, adjustmentOrdersPerSession: 500 / 260, skippedNoBar: 0, fundingMissingSymbolSessions: 0, avgGross: 1.2, maxGross: 1.8, pnlByAssetClass: { equity: 100, bond: 50 }, pnlBySymbol: {}, marginInterest: 0 } })) as ReplayResult[];
    const r = computeCriteria(inputs("D1", { summary: summaryOf(withDiag, stress.slice(0, 2)), compare: { live: mine, noise: marketFlat } }));
    expect(r.reported.ordersPerSession).toBe(2);
    expect(r.reported.adjustmentOrdersPerSession).toBeCloseTo(500 / 260, 12);
    expect(r.reported.turnoverAnnual).toBe(5);
    expect(r.reported.avgGross).toBeCloseTo(1.2, 12);
    expect((r.reported.pnlByAssetClass as Record<string, number>).equity).toBeCloseTo(100 + 1.5 * 100, 12); // fold 1 dollars × (1 + fold 0 return)
    expect((r.reported.correlations as Record<string, { corr: number }>).live.corr).toBeCloseTo(1, 12);
    expect(Math.abs((r.reported.correlations as Record<string, { corr: number }>).noise.corr)).toBeLessThan(0.3);
  });
});

describe("passive benchmark decisions", () => {
  const bars = (seed: number, n: number, start: number) => {
    const rng = mulberry32(seed);
    let px = start;
    return Array.from({ length: n }, (_, i) => {
      px *= 1 + (rng() - 0.5) * 0.02;
      const date = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return { date, open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 1 };
    });
  };
  const series = new Map([["AAA", seriesFromBars("AAA", bars(1, 400, 100))], ["BBB", seriesFromBars("BBB", bars(2, 400, 50))], ["NEW", seriesFromBars("NEW", bars(3, 40, 10))]]);
  const view = new SessionPriceView(series, "2021-02-03");

  test("trend passive: every name past the inception guard gets a weight; no signal, no stops; honours caps and gross", () => {
    const cfg: PortfolioStrategyConfig = { kind: "xassetTrend", universe: ["AAA", "BBB", "NEW"], inceptionGuardBars: 252, volLookback: 63, covLookback: 63, portfolioVolTarget: 0.12, perAssetCap: 0.3, maxGross: 0.5, blendHorizons: [63], maLong: 200, signalBandPct: 0 };
    const t = passiveTrendDecide({ view, book: { equity: 1, positions: [], memory: { keep: 1 } }, config: cfg });
    expect(Object.keys(t.weights).sort()).toEqual(["AAA", "BBB"]);
    expect(Object.values(t.weights).every(w => w > 0 && w <= 0.3 + 1e-12)).toBe(true);
    expect(Object.values(t.weights).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(0.5 + 1e-12);
    expect(t.stops).toEqual([]);
    expect(t.memory).toEqual({ keep: 1 });
    expect(passiveDecideFor(cfg)).toBe(passiveTrendDecide);
    expect(() => passiveTrendDecide({ view, book: { equity: 1, positions: [], memory: {} }, config: { kind: "factorCore" } as PortfolioStrategyConfig })).toThrow();
  });

  test("equal-weight passive: 1/N of every eligible member, reconstituted on a new month, exposure 1, no overlay", () => {
    const membership: MembershipView = { members: () => ["AAA", "BBB", "NEW", "XXX"] };
    const cfg: PortfolioStrategyConfig = { kind: "factorCore", exclude: ["XXX"], topN: 1, score: "momentum+lowvol", momentumWindow: [120, 21], volWindow: 120, weightVolLookback: 63, perNameCap: 0.04, minPrice: 1, minPriorCloses: 200, overlay: { ref: "AAA", ma: 100, bandPct: 1, onExposure: 1, offExposure: 0.5 } };
    const t1 = passiveEqualWeightDecide({ view, membership, book: { equity: 1, positions: [], memory: {} }, config: cfg, executionSession: "2021-02-04" });
    expect(t1.weights).toEqual({ AAA: 0.5, BBB: 0.5 }); // NEW too young, XXX excluded; topN and perNameCap ignored
    expect((t1.memory.portfolioPassive as { month: string }).month).toBe("2021-02");
    // Same month: members kept from memory even if the view changes.
    const t2 = passiveEqualWeightDecide({ view: new SessionPriceView(series, "2021-02-10"), membership: { members: () => ["AAA"] }, book: { equity: 1, positions: [], memory: t1.memory }, config: cfg, executionSession: "2021-02-11" });
    expect(t2.weights).toEqual({ AAA: 0.5, BBB: 0.5 });
    // New month: reconstituted.
    const t3 = passiveEqualWeightDecide({ view: new SessionPriceView(series, "2021-02-26"), membership: { members: () => ["AAA"] }, book: { equity: 1, positions: [], memory: t2.memory }, config: cfg, executionSession: "2021-03-01" });
    expect(t3.weights).toEqual({ AAA: 1 });
    expect(passiveDecideFor(cfg)).toBe(passiveEqualWeightDecide);
    expect(() => passiveEqualWeightDecide({ view, book: { equity: 1, positions: [], memory: {} }, config: cfg })).toThrow(/membership/);
  });
});
