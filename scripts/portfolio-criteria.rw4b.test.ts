// RW4b (docs/reports/RW-reescritura-rentable.md §14): the leveraged-E1 criteria — R1–R7 plus GPT's Q3
// conditions (account drawdown, −0.18 Sharpe haircut, margin cost, Feb–Mar 2020 and 2022 windows).
// Synthetic chains only: no database, no real data.
import { describe, expect, test } from "bun:test";
import type { ReplayResult } from "./backtest-momentum-wf";
import { penalizedPsr, type WalkForwardSummary } from "./walk-forward";
import {
  RW4B_LIMITS,
  accountPerformance,
  annualizedSharpe,
  chainDailyReturns,
  computeRW2Criteria,
  computeRW4bCriteria,
  isRw4bName,
  parseCriteriaArtifacts,
  rw2DesignOf,
  type DailySeries,
  type RW4bCriteriaInputs,
} from "./portfolio-criteria";
import { mulberry32 } from "./lib/syntheticCandles";

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
function gaussian(seed: number, n: number, mu: number, sigma: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const u1 = rng() || 1e-12, u2 = rng();
    return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  });
}
function foldResult(label: string, dates: string[], rets: number[], initial = 50_000): ReplayResult {
  let eq = initial;
  const equityHistory = [{ t: Date.parse(dates[0]) - 86_400_000, eq }];
  const dailyReturns = dates.map((date, i) => { eq *= 1 + rets[i]; equityHistory.push({ t: Date.parse(date) + 5 * 3_600_000, eq }); return { date, ret: rets[i] }; });
  return {
    sleeve: "stocks", window: { label, from: new Date(equityHistory[0].t).toISOString(), to: new Date(Date.parse(dates[dates.length - 1]) + 86_400_000).toISOString() },
    fromMs: equityHistory[0].t, toMs: Date.parse(dates[dates.length - 1]) + 86_400_000,
    config: { initialEquity: initial, rthOnly: false, sleeve: "stocks", source: "alpaca_wide" } as ReplayResult["config"],
    finalEquity: eq, totalReturn: eq / initial - 1, maxDrawdown: 0.1, sharpe: annualizedSharpe(rets, 252), winRate: 0.5, trades: 4, tradesPerDay: 0.1,
    expectancy: 1, fees: 1, funding: 0, marginInterest: 1_500, liquidations: 0, marginRejects: 0, ruined: false, bench: 0,
    dailyReturns, sessionReturns: [], tradesBySymbol: { AAA: { trades: 2, grossPnl: 300, fees: 0, funding: 0 }, BBB: { trades: 1, grossPnl: 100, fees: 0, funding: 0 }, CCC: { trades: 1, grossPnl: -50, fees: 0, funding: 0 } },
    equityHistory, closedTrades: [], turnoverAnnual: 5, displacementCloses: 0, profitLockCloses: 0, gateBlocks: {}, hash: "h",
    finalRiskState: { peakEquity: eq, dayStartEquity: eq, dayStartedAt: 0, consecutiveLosses: 0, pausedUntil: 0, pauseReason: "", lastEvalAt: 0 },
  };
}
function summaryOf(outer: ReplayResult[], stress: ReplayResult[], over: Partial<WalkForwardSummary> = {}): WalkForwardSummary {
  return {
    manifestHash: "m", configHash: "c", dataHash: "d", codeHash: "k", asOfMs: 0, resolvedTo: "", selectedCandidate: null,
    outerSelection: outer.map(r => ({ foldPath: r.window.label, candidateName: "x", candidateHash: "h" })),
    innerSelection: [], outerTests: outer.map(r => ({ foldPath: r.window.label, result: r })), stressTests: stress.map(r => ({ foldPath: r.window.label, result: r })),
    stitchedOos: { totalReturn: 0.3, sharpe: 1.2, maxDrawdown: 0.12, winRate: 0.5, trades: 8, expectancy: 1, fees: 2, funding: 0, marginInterest: 4, liquidations: 0, marginRejects: 0, ruined: false, benchSharpe: 0.7 },
    concentration: { maxTradesFracByFold: [], maxPnlFracByFold: [], totalTradesBySymbol: {}, totalGrossPnlBySymbol: {} },
    loo: [], skippedFolds: [], outerPsr: 0.97, observations: 800, breakEvenSlippageBps: 12, breakEvenCurve: [],
    acceptance: {}, approved: false, approvalReason: "", complete: true, priorTrialsComplete: true,
    ...over,
  };
}

// 3 folds from 2019-10-01: they cover February–March 2020 and all of 2022.
const N = 280;
const ALL = weekdays("2019-10-01", 3 * N);
const FOLDS = [ALL.slice(0, N), ALL.slice(N, 2 * N), ALL.slice(2 * N)];
const sliceFolds = (rets: number[]) => FOLDS.map((_, i) => rets.slice(i * N, (i + 1) * N));

/** A chain over ALL with an optional crash overlay on given dates. */
function chainOf(mu: number, sigma: number, seed: number, crash?: { from: string; to: string; ret: number }): number[] {
  const rets = gaussian(seed, ALL.length, mu, sigma);
  if (crash) ALL.forEach((d, i) => { if (d >= crash.from && d <= crash.to) rets[i] = crash.ret; });
  return rets;
}
function summaryFor(rets: number[], stressShave = 0.0002, over: Partial<WalkForwardSummary> = {}): WalkForwardSummary {
  const outer = sliceFolds(rets).map((r, i) => foldResult(`${i}/t`, FOLDS[i], r));
  const stress = sliceFolds(rets).map((r, i) => foldResult(`${i}/t`, FOLDS[i], r.map(x => x - stressShave)));
  return summaryOf(outer, stress, over);
}
const seriesOfRets = (rets: number[], dates = ALL): DailySeries => new Map(dates.map((d, i) => [d, rets[i]]));

const healthy = chainOf(0.0009, 0.008, 1, { from: "2020-02-24", to: "2020-03-06", ret: -0.008 });
const baseInputs = (over: Partial<RW4bCriteriaInputs> = {}): RW4bCriteriaInputs => ({
  design: "E1", summary: summaryFor(healthy), initialEquity: 50_000, baseSlippageBps: 2,
  control: seriesOfRets(healthy.map(r => r - 0.0006)),
  partner: seriesOfRets(chainOf(0.0004, 0.005, 7)),
  marginRates: { base: 0.065, stress: 0.065 },
  exTopDecile: { excluded: ["AAA"], sharpe: 0.8, totalReturn: 0.2, maxDrawdown: 0.1 },
  ...over,
});

describe("names, flags and the account helper", () => {
  test("rw4b-e1- maps to E1; every other prefix keeps its rule; --partner parses", () => {
    expect(rw2DesignOf("rw4b-e1-lev-vt20-g150-v1")).toBe("E1");
    expect(() => rw2DesignOf("rw4-e1-no")).toThrow(/manifest name/);
    expect(() => rw2DesignOf("rw4b-e2-no")).not.toThrow(); // the prefix maps; the evaluator then insists on E1
    expect(isRw4bName("rw4b-e1-lev")).toBe(true);
    expect(isRw4bName("rw3-e1-lev")).toBe(false);
    expect(parseCriteriaArtifacts(["x", "--control", "c", "--partner", "p"])).toEqual({ controlArtifact: "c", partnerArtifact: "p" });
    expect(() => parseCriteriaArtifacts(["--partner"])).toThrow(/expects/);
  });

  test("accountPerformance: two $50k books, no reallocation", () => {
    expect(accountPerformance([-0.2], [0]).maxDrawdown).toBeCloseTo(0.1, 12); // (0.8 + 1) / 2 = 0.9
    const up = accountPerformance([0.5, -0.2], [0, 0]);
    expect(up.maxDrawdown).toBeCloseTo(1 - (1.5 * 0.8 + 1) / (1.5 + 1), 12);
    expect(up.totalReturn).toBeCloseTo((1.2 + 1) / 2 - 1, 12);
    expect(accountPerformance([0.01, 0.01], [0.02, 0.02]).maxDrawdown).toBe(0);
  });
});

describe("RW4b criteria", () => {
  test("a healthy leveraged chain passes R1–R7 and every RW4b condition; R1–R7 are exactly the RW2 verdicts", () => {
    const report = computeRW4bCriteria(baseInputs());
    expect(Object.keys(report.criteria)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "A1", "H1", "H2", "M1", "S1", "S2"]);
    expect(report.allPass).toBe(true);
    expect(report.verdict).toMatch(/CUMPLE R1–R7, A1, H1–H2, M1, S1–S2/);
    expect(report.verdict).toMatch(/2027-01-21|cableado solo al final/);
    const rw2 = computeRW2Criteria(baseInputs());
    for (const key of ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]) expect(report.criteria[key]).toEqual(rw2.criteria[key]);
    expect(RW4B_LIMITS.accountMaxDrawdown).toBe(0.2);
    expect(RW4B_LIMITS.sleeveMaxDrawdown).toBe(0.25);
    expect(report.criteria.R2.threshold).toBe(0.25); // explicit sleeve limit
    expect(report.criteria.A1.threshold).toBe(0.2); // explicit account limit
    expect((report.reported.rw4b as { wiring: string }).wiring).toMatch(/2027-01-21/);
  });

  test("R3 still binds: Sharpe not below E1's on the same days", () => {
    const sharperControl = seriesOfRets(healthy.map(r => r + 0.0004));
    const report = computeRW4bCriteria(baseInputs({ control: sharperControl }));
    expect(report.criteria.R3.pass).toBe(false);
    expect(report.allPass).toBe(false);
    expect(report.verdict).toMatch(/^FALLA: R3/);
  });

  test("A1: the account (E1 variant + E2) is measured on the common sessions; a partner loss breaks it", () => {
    const report = computeRW4bCriteria(baseInputs());
    const a1 = report.criteria.A1;
    expect(a1.detail).toMatchObject({ capitalPerSleeve: 50_000, sleeveMaxDrawdownLimit: 0.25 });
    expect(a1.detail!.commonDays).toBe(ALL.length);
    expect(a1.detail!.controlAccount).toBeDefined(); // the E1-control account is the baseline
    // E2 loses 15 % a day for four sessions in 2021: half of the account falls ~24 %.
    const bad = chainOf(0.0004, 0.005, 7);
    ALL.forEach((d, i) => { if (d >= "2021-05-03" && d <= "2021-05-06") bad[i] = -0.15; });
    const broken = computeRW4bCriteria(baseInputs({ partner: seriesOfRets(bad) }));
    expect(broken.criteria.A1.pass).toBe(false);
    expect(broken.criteria.A1.value).toBeGreaterThan(0.2);
    expect(broken.criteria.A1.value).toBeLessThan(0.45);
    // Without E2 the account cannot be judged: fails closed, with the reason.
    const none = computeRW4bCriteria(baseInputs({ partner: null }));
    expect(none.criteria.A1).toMatchObject({ pass: false, value: null });
    expect(none.criteria.A1.reason).toMatch(/partner/);
    expect(none.criteria.S1.pass).toBe(false);
  });

  test("H1/H2: the −0.18 Sharpe haircut is exact and a thin edge does not survive it", () => {
    const report = computeRW4bCriteria(baseInputs());
    const h1 = report.criteria.H1.detail!;
    const mine = [...chainDailyReturns(baseInputs().summary).values()];
    expect(h1.sharpeAfterHaircut as number).toBeCloseTo(annualizedSharpe(mine, 252) - 0.18, 10);
    expect(h1.controlSharpeSameDaysAfterHaircut as number).toBeCloseTo((h1.controlSharpeSameDays as number) - 0.18, 12);
    expect(report.criteria.H1.value!).toBeLessThanOrEqual(h1.psrBeforeHaircut as number);
    // Find an edge that clears PSR 0.95 raw but not after the haircut (deterministic seeds).
    let found = false;
    for (const mu of [0.0003, 0.0004, 0.0005, 0.0006, 0.0007, 0.0008]) {
      for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
        const rets = chainOf(mu, 0.008, seed);
        const raw = penalizedPsr(rets)!;
        const sd = Math.sqrt(rets.reduce((s, x) => s + (x - rets.reduce((a, b) => a + b, 0) / rets.length) ** 2, 0) / (rets.length - 1));
        const shaved = penalizedPsr(rets.map(r => r - 0.18 * sd / Math.sqrt(252)))!;
        if (raw >= 0.95 && shaved < 0.95 && !found) {
          found = true;
          const r = computeRW4bCriteria(baseInputs({ summary: summaryFor(rets), control: seriesOfRets(rets.map(x => x - 0.0001)) }));
          expect(r.criteria.H1.pass).toBe(false);
          expect(r.criteria.H1.value!).toBeCloseTo(shaved, 12);
          expect(r.criteria.H1.detail!.psrBeforeHaircut as number).toBeCloseTo(raw, 12);
        }
      }
    }
    expect(found).toBe(true);
    // H2: R4's stress Sharpe minus 0.18 must still reach 0.5, i.e. the stress Sharpe itself must reach 0.68.
    const stressedHard = computeRW4bCriteria(baseInputs({ summary: summaryFor(healthy, 0.00075) }));
    const stressSharpe = stressedHard.criteria.R4.value!;
    expect(stressedHard.criteria.H2.value!).toBeCloseTo(stressSharpe - 0.18, 12);
    expect(stressedHard.criteria.H2.pass).toBe(stressSharpe - 0.18 >= 0.5);
    const barely = computeRW4bCriteria(baseInputs({ summary: summaryFor(healthy, 0.0005) }));
    expect(barely.criteria.R4.value!).toBeGreaterThan(0.5);
    expect(barely.criteria.R4.value!).toBeLessThan(0.68);
    expect(barely.criteria.R4.pass).toBe(true);
    expect(barely.criteria.H2.pass).toBe(false);
    expect(computeRW4bCriteria(baseInputs({ summary: summaryOf([], []) })).criteria.H2).toMatchObject({ pass: false, value: null });
  });

  test("M1: margin interest must be in the simulation at ≥ 6.5 % in base and stress, and its cost is reported", () => {
    const ok = computeRW4bCriteria(baseInputs()).criteria.M1;
    expect(ok.pass).toBe(true);
    expect(ok.detail!.marginInterestPaidUsd).toBe(3 * 1_500);
    expect(ok.detail!.marginInterestShareOfNetPnl as number).toBeGreaterThan(0);
    expect(computeRW4bCriteria(baseInputs({ marginRates: { base: 0.05, stress: 0.065 } })).criteria.M1.pass).toBe(false);
    expect(computeRW4bCriteria(baseInputs({ marginRates: { base: 0.065, stress: 0 } })).criteria.M1.pass).toBe(false);
    expect(computeRW4bCriteria(baseInputs({ marginRates: { base: 0.08, stress: 0.08 } })).criteria.M1.pass).toBe(true);
  });

  test("S1/S2: February–March 2020 and 2022 are judged separately, inside their own window", () => {
    const report = computeRW4bCriteria(baseInputs());
    expect(report.criteria.S1.id).toBe("S1_crash2020");
    expect(report.criteria.S2.id).toBe("S2_bear2022");
    expect(report.criteria.S1.detail).toMatchObject({ from: "2020-02-03" });
    expect(report.criteria.S2.detail!.sessions as number).toBeGreaterThan(200);
    expect((report.reported.rw4b as { crashWindows: Record<string, unknown> }).crashWindows.S2_bear2022).toMatchObject({ covered: true });

    // A fast crash (−3 %/day for ten sessions) breaks only S1; 2022 stays fine.
    const crashed = chainOf(0.0009, 0.008, 1, { from: "2020-02-24", to: "2020-03-06", ret: -0.03 });
    const s1 = computeRW4bCriteria(baseInputs({ summary: summaryFor(crashed), control: seriesOfRets(crashed.map(r => r - 0.0006)) }));
    expect(s1.criteria.S1.pass).toBe(false);
    expect(s1.criteria.S1.value!).toBeGreaterThan(0.25);
    expect(s1.criteria.S2.pass).toBe(true);
    expect(s1.verdict).toMatch(/S1/);

    // A 2022 bear market breaks only S2.
    const bear = chainOf(0.0009, 0.008, 1, { from: "2022-03-01", to: "2022-06-30", ret: -0.005 });
    const s2 = computeRW4bCriteria(baseInputs({ summary: summaryFor(bear), control: seriesOfRets(bear.map(r => r - 0.0006)) }));
    expect(s2.criteria.S2.pass).toBe(false);
    expect(s2.criteria.S1.pass).toBe(true);

    // The drawdown is measured inside the window: a deep earlier loss does not count against it.
    const early = chainOf(0.0009, 0.008, 1, { from: "2019-11-01", to: "2019-11-14", ret: -0.04 });
    const fine = computeRW4bCriteria(baseInputs({ summary: summaryFor(early), control: seriesOfRets(early.map(r => r - 0.0006)) }));
    expect(fine.criteria.S1.pass).toBe(true);
    let eq = 1, peak = 1, dd = 0;
    for (const r of early) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
    expect(dd).toBeGreaterThan(0.2); // the whole chain's own drawdown does show it
  });

  test("a window the OOS chain does not cover fails closed", () => {
    const later = weekdays("2021-01-04", 3 * N);
    const folds = [later.slice(0, N), later.slice(N, 2 * N), later.slice(2 * N)];
    const rets = gaussian(3, later.length, 0.0009, 0.008);
    const outer = folds.map((d, i) => foldResult(`${i}/t`, d, rets.slice(i * N, (i + 1) * N)));
    const stress = outer.map((r, i) => foldResult(`${i}/t`, folds[i], rets.slice(i * N, (i + 1) * N).map(x => x - 0.0002)));
    const report = computeRW4bCriteria(baseInputs({ summary: summaryOf(outer, stress), control: seriesOfRets(rets.map(r => r - 0.0006), later), partner: seriesOfRets(chainOf(0.0004, 0.005, 7).slice(0, later.length), later) }));
    expect(report.criteria.S1).toMatchObject({ pass: false, value: null });
    expect(report.criteria.S1.reason).toMatch(/fails closed/);
    expect(report.criteria.S2.detail!.sessions as number).toBeGreaterThan(20); // 2022 is inside this chain
    expect((report.reported.rw4b as { crashWindows: Record<string, unknown> }).crashWindows.S1_crash2020).toMatchObject({ covered: false });
  });
});
