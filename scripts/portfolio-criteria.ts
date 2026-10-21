#!/usr/bin/env bun
/**
 * RW portfolio engine — the pre-registered criteria C1–C7 of
 * docs/reports/RW-reescritura-rentable.md §2.5, computed from a walk-forward
 * summary (scripts/walk-forward.ts) plus benchmark runs on the SAME executed
 * outer-OOS windows. Written as rw-criteria.json into the artifact directory
 * by scripts/portfolio-wf.ts.
 *
 *   C1  PSR(SR>0) ≥ 0.95 — the protocol's autocorr-penalized outer PSR.
 *   C2  max drawdown of the stitched OOS chain ≤ 20/25/35 %.
 *   C3  Sharpe of the stitched STRESS-cost chain ≥ 0.5/0.5/0.6.
 *   C4  the signal adds: Sharpe ≥ passive + 0.10, SAME sessions. Passive =
 *       D1/D3 the same construction with the signal forced on (vol target of
 *       the fold's selected candidate); D2 equal-weight of every eligible
 *       name, monthly reconstitution, no overlay. Passive runs through the
 *       same simulator, same costs, same venue rules, chained like the OOS.
 *   C5  better than the market, SAME sessions: D1 ≥ 60/40 SPY/IEF rebalanced
 *       daily; D2 ≥ SPY + 0.05; D3 ≥ BTC + 0.20 (frictionless close-to-close).
 *   C6  no calendar year > 50 % of the stitched P&L (fails closed if P&L ≤ 0).
 *   C6b D1/D2 Sharpe without the top P&L decile of symbols ≥ 0.3 (chain
 *       re-run without them); D3 worst leave-one-out ≥ 0.6 × Sharpe.
 *   C7  break-even EXTRA cost per side ≥ 4/4/10 bps = first Sharpe ≤ 0
 *       crossing of the slippage curve minus the base slippage.
 *   C8  timing vs random — computed OUTSIDE by the independent replication;
 *       reported here as "external".
 *
 * Report-only (§2.5): orders/session with adjustments apart, turnover, mean
 * gross, P&L by asset class, correlation with other chains (live sleeve or
 * other designs) when their artifact directories are supplied.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  candidateToReplayConfig,
  periodsPerYear,
  stitchEquityHistory,
  stitchedMetrics,
  type ExperimentManifest,
  type ReplayRunner,
  type WalkForwardSummary,
} from "./walk-forward";
import type { ReplayResult } from "./backtest-momentum-wf";
import { coreKernel, makePortfolioRunner, type PortfolioChainState, type PortfolioKernel, type PortfolioReplayResult } from "./portfolio-replay";
import { covarianceFromPrices, priceHistory, scaleToVolTarget, selectCoreMembers, trailingVol } from "../src/portfolio-engine";
import type { PortfolioStrategyConfig, SessionDate } from "../src/portfolio-engine/types";
import { calendarForSource, loadSessionSeries } from "./lib/portfolioData";

// ── thresholds (§2.5, verbatim) ──────────────────────────────────────────

export type DesignId = "D1" | "D2" | "D3";
export type MarketBenchmark = "sixtyForty" | "spy" | "btc";

export interface DesignThresholds {
  c1MinPsr: number;
  c2MaxDrawdown: number;
  c3StressMinSharpe: number;
  c4MinExcessVsPassive: number;
  c5Market: MarketBenchmark;
  c5MinExcess: number;
  c6MaxYearShare: number;
  c6b: { kind: "exTopDecile"; minSharpe: number } | { kind: "worstLoo"; minRatio: number };
  c7MinExtraBpsPerSide: number;
}

export const CRITERIA: Record<DesignId, DesignThresholds> = {
  D1: { c1MinPsr: 0.95, c2MaxDrawdown: 0.20, c3StressMinSharpe: 0.5, c4MinExcessVsPassive: 0.10, c5Market: "sixtyForty", c5MinExcess: 0, c6MaxYearShare: 0.5, c6b: { kind: "exTopDecile", minSharpe: 0.3 }, c7MinExtraBpsPerSide: 4 },
  D2: { c1MinPsr: 0.95, c2MaxDrawdown: 0.25, c3StressMinSharpe: 0.5, c4MinExcessVsPassive: 0.10, c5Market: "spy", c5MinExcess: 0.05, c6MaxYearShare: 0.5, c6b: { kind: "exTopDecile", minSharpe: 0.3 }, c7MinExtraBpsPerSide: 4 },
  D3: { c1MinPsr: 0.95, c2MaxDrawdown: 0.35, c3StressMinSharpe: 0.6, c4MinExcessVsPassive: 0.10, c5Market: "btc", c5MinExcess: 0.20, c6MaxYearShare: 0.5, c6b: { kind: "worstLoo", minRatio: 0.6 }, c7MinExtraBpsPerSide: 10 },
};

export function designOf(strategy: PortfolioStrategyConfig): DesignId {
  return strategy.kind === "xassetTrend" ? "D1" : strategy.kind === "factorCore" ? "D2" : "D3";
}

/** Symbols of each fixed benchmark (must be in the manifest's data block). */
export const MARKET_SYMBOLS: Record<MarketBenchmark, Array<{ symbol: string; weight: number }>> = {
  sixtyForty: [{ symbol: "SPY", weight: 0.6 }, { symbol: "IEF", weight: 0.4 }],
  spy: [{ symbol: "SPY", weight: 1 }],
  btc: [{ symbol: "BTC/USD", weight: 1 }],
};

// ── series helpers ───────────────────────────────────────────────────────

export type DailySeries = Map<SessionDate, number>;

export function seriesOf(points: Iterable<{ date: string; ret: number }>): DailySeries {
  const out: DailySeries = new Map();
  for (const p of points) out.set(p.date, p.ret);
  return out;
}

/** The stitched OOS chain by SESSION date: the outer base results' dailyReturns in fold order. */
export function chainDailyReturns(summary: WalkForwardSummary): DailySeries {
  const sorted = [...summary.outerTests].sort((a, b) => a.result.fromMs - b.result.fromMs);
  return seriesOf(sorted.flatMap(t => t.result.dailyReturns));
}

export function annualizedSharpe(rets: readonly number[], ppy: number): number {
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(ppy) : 0;
}

/** Sharpe of two series over their COMMON dates ("mismos días"). */
export function alignedSharpe(a: DailySeries, b: DailySeries, ppy: number): { sharpeA: number; sharpeB: number; observations: number; dates: SessionDate[] } {
  const dates = [...a.keys()].filter(d => b.has(d)).sort();
  return {
    sharpeA: annualizedSharpe(dates.map(d => a.get(d)!), ppy),
    sharpeB: annualizedSharpe(dates.map(d => b.get(d)!), ppy),
    observations: dates.length,
    dates,
  };
}

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  return sxx < 1e-18 || syy < 1e-18 ? 0 : sxy / Math.sqrt(sxx * syy);
}

export function correlationOnCommonDates(a: DailySeries, b: DailySeries): { corr: number; observations: number } {
  const dates = [...a.keys()].filter(d => b.has(d)).sort();
  return { corr: pearson(dates.map(d => a.get(d)!), dates.map(d => b.get(d)!)), observations: dates.length };
}

/** Calendar-year shares of the stitched P&L (dollars of the stitched account). */
export function yearPnlShares(history: Array<{ t: number; eq: number }>): { byYear: Record<string, number>; shares: Record<string, number>; maxShare: number; totalPnl: number } {
  const byYear: Record<string, number> = {};
  for (let i = 1; i < history.length; i++) {
    const year = new Date(history[i].t).toISOString().slice(0, 4);
    byYear[year] = (byYear[year] ?? 0) + (history[i].eq - history[i - 1].eq);
  }
  const totalPnl = Object.values(byYear).reduce((s, v) => s + v, 0);
  const shares: Record<string, number> = {};
  for (const [y, v] of Object.entries(byYear)) shares[y] = totalPnl > 0 ? v / totalPnl : NaN;
  const maxShare = totalPnl > 0 ? Math.max(...Object.values(shares)) : Infinity; // fail closed
  return { byYear, shares, maxShare, totalPnl };
}

/** Reconstruct an artifact's stitched OOS daily returns (runs.jsonl outer base
 *  trials matching summary.outerSelection) — for the report-only correlations. */
export function artifactOosDailyReturns(artifactDir: string): DailySeries {
  const summary = JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8"));
  const selection = new Map<string, string>((summary.outerSelection ?? []).map((s: { foldPath: string; candidateHash: string }) => [s.foldPath, s.candidateHash]));
  if (selection.size === 0) throw new Error(`artifact ${artifactDir}: no outerSelection in summary.json`);
  const out: DailySeries = new Map();
  for (const line of readFileSync(join(artifactDir, "runs.jsonl"), "utf8").trim().split("\n")) {
    if (!line) continue;
    const t = JSON.parse(line);
    if (t.costTier !== "base" || t.status !== "complete" || !t.result || selection.get(t.foldPath) !== t.candidateHash) continue;
    for (const d of t.result.dailyReturns ?? []) out.set(d.date, d.ret);
  }
  if (out.size === 0) throw new Error(`artifact ${artifactDir}: no OOS daily returns reconstructed`);
  return out;
}

// ── passive benchmarks (same construction, signal forced on) ─────────────

const PASSIVE_KEY = "portfolioPassive";

/** D1/D3: inverse-vol weights of EVERY name past the inception guard, scaled
 *  to the candidate's vol target with the core's own construction (caps and
 *  gross included); no signal, no stops. */
export const passiveTrendDecide: PortfolioKernel["decide"] = ({ view, config, book }) => {
  if (config.kind === "factorCore") throw new Error("passiveTrendDecide: factorCore uses passiveEqualWeightDecide");
  const vols: Record<string, number> = {};
  const needed = Math.max(config.volLookback, config.covLookback) + 1;
  for (const s of [...new Set(config.universe)].sort()) {
    if (view.barCount(s) < config.inceptionGuardBars) continue;
    const closes = priceHistory(view, s, needed).map(b => b.close);
    if (closes.length < needed) continue;
    const vol = trailingVol(closes, config.volLookback);
    if (vol !== null && vol > 0) vols[s] = vol;
  }
  const covariance = covarianceFromPrices(view, Object.keys(vols), config.covLookback);
  const c = scaleToVolTarget(vols, covariance, config.kind === "xassetTrend" ? 252 : 365, config.portfolioVolTarget, config.perAssetCap, config.maxGross);
  return { asOf: view.asOf, weights: c.weights, stops: [], memory: book.memory, diagnostics: { passive: "trend-always-on", vols, scale: c.scale } };
};

/** D2: equal weight of every ELIGIBLE member (the core's own eligibility —
 *  member at the execution session, not excluded, enough prior closes,
 *  price floor, rankable), reconstituted monthly, exposure 1, no overlay. */
export const passiveEqualWeightDecide: PortfolioKernel["decide"] = (input) => {
  const { view, config, book, membership } = input;
  if (config.kind !== "factorCore") throw new Error("passiveEqualWeightDecide: trend designs use passiveTrendDecide");
  if (!membership) throw new Error("passiveEqualWeightDecide requires membership");
  const prev = (book.memory[PASSIVE_KEY] as { month: string; members: string[] } | undefined);
  const month = (input.executionSession ?? view.asOf).slice(0, 7);
  let members = prev?.members ?? [];
  if (!prev || prev.month !== month) {
    members = selectCoreMembers(view, membership, { ...config, topN: Number.MAX_SAFE_INTEGER }, input.executionSession).members;
  }
  const weights: Record<string, number> = {};
  for (const s of members) weights[s] = members.length > 0 ? 1 / members.length : 0;
  return { asOf: view.asOf, weights, stops: [], memory: { ...book.memory, [PASSIVE_KEY]: { month, members } }, diagnostics: { passive: "equal-weight-eligible", count: members.length } };
};

export function passiveDecideFor(strategy: PortfolioStrategyConfig): PortfolioKernel["decide"] {
  return strategy.kind === "factorCore" ? passiveEqualWeightDecide : passiveTrendDecide;
}

// ── chain re-runs on the executed outer windows ──────────────────────────

export interface OuterWindow { foldPath: string; candidateName: string; fromMs: number; toMs: number }

export function executedOuterWindows(m: ExperimentManifest, summary: WalkForwardSummary): OuterWindow[] {
  const out: OuterWindow[] = [];
  for (const sel of summary.outerSelection ?? []) {
    const outer = summary.outerTests.find(t => t.foldPath === sel.foldPath);
    if (!outer) continue; // chain cut / not executed
    if (!m.candidates.some(c => c.name === sel.candidateName)) throw new Error(`candidate ${sel.candidateName} not in manifest`);
    out.push({ foldPath: sel.foldPath, candidateName: sel.candidateName, fromMs: outer.result.fromMs, toMs: outer.result.toMs });
  }
  return out.sort((a, b) => a.fromMs - b.fromMs);
}

/**
 * Re-run the selected candidates over the executed outer windows with a
 * modified config (universe/exclusions/decision), chaining the strategy
 * memory exactly like the protocol does (finalRiskState → next fold).
 */
export async function rerunChain(
  m: ExperimentManifest,
  windows: OuterWindow[],
  runner: ReplayRunner,
  label: string,
  mutate: (cfg: ReturnType<typeof candidateToReplayConfig>) => void,
  dbPath = m.data.dbPath,
): Promise<ReplayResult[]> {
  const results: ReplayResult[] = [];
  let chain: PortfolioChainState | undefined;
  for (const w of windows) {
    const candidate = m.candidates.find(c => c.name === w.candidateName)!;
    const cfg = candidateToReplayConfig(m, candidate, "base", dbPath);
    mutate(cfg);
    const win = { label: `${w.foldPath}/${label}`, from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString() };
    const r = await runner(cfg, win, chain);
    if (!r) throw new Error(`${label}: replay failed at ${w.foldPath}`);
    results.push(r);
    if (r.ruined || !(r.finalEquity > 0)) break;
    chain = r.finalRiskState as PortfolioChainState;
  }
  return results;
}

/** Top ceil(10 %) symbols by summed closed-episode P&L over the outer chain (positive contributors first). */
export function topDecileSymbols(summary: WalkForwardSummary): string[] {
  const pnl = new Map<string, number>();
  for (const t of summary.outerTests) {
    for (const [sym, v] of Object.entries(t.result.tradesBySymbol)) {
      if (v.trades > 0) pnl.set(sym, (pnl.get(sym) ?? 0) + v.grossPnl);
    }
  }
  const ranked = [...pnl.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (ranked.length === 0) return [];
  return ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.1))).map(([s]) => s);
}

/** Frictionless close-to-close daily returns of a fixed benchmark, labelled by session. */
export function marketDailyReturns(dbPath: string, m: ExperimentManifest, which: MarketBenchmark, fromMs: number, toMs: number): DailySeries {
  const legs = MARKET_SYMBOLS[which];
  const db = new Database(dbPath, { readonly: true });
  try {
    const series = loadSessionSeries(db, legs.map(l => l.symbol), m.data.source, m.data.timeframe, fromMs - 15 * 86_400_000, toMs, calendarForSource(m.data.source));
    const perLeg = legs.map(l => {
      const s = series.get(l.symbol);
      if (!s || s.dates.length < 2) throw new Error(`benchmark ${which}: no ${m.data.timeframe} bars for ${l.symbol} in the data block`);
      const rets: DailySeries = new Map();
      for (let i = 1; i < s.dates.length; i++) if (s.timestamps[i] >= fromMs) rets.set(s.dates[i], s.close[i] / s.close[i - 1] - 1);
      return { weight: l.weight, rets };
    });
    const out: DailySeries = new Map();
    for (const d of perLeg[0].rets.keys()) {
      if (!perLeg.every(l => l.rets.has(d))) continue;
      out.set(d, perLeg.reduce((s, l) => s + l.weight * l.rets.get(d)!, 0));
    }
    return out;
  } finally {
    db.close();
  }
}

// ── the pure evaluator ───────────────────────────────────────────────────

export interface Criterion {
  id: string;
  pass: boolean | null;
  value: number | null;
  threshold: number | null;
  detail?: Record<string, unknown>;
  reason?: string;
}

export interface CriteriaInputs {
  design: DesignId;
  summary: WalkForwardSummary;
  ppy: number;
  initialEquity: number;
  baseSlippageBps: number;
  /** Passive benchmark chain by session (same windows); null = not computed. */
  passive: DailySeries | null;
  /** Fixed market benchmark by session; null = not computed. */
  market: DailySeries | null;
  marketError?: string;
  /** D1/D2 chain re-run without the top P&L decile; null when not computed. */
  exTopDecile: { excluded: string[]; sharpe: number; totalReturn: number; maxDrawdown: number } | null;
  /** Report-only correlations: label → series. */
  compare?: Record<string, DailySeries>;
}

export interface CriteriaReport {
  design: DesignId;
  thresholds: DesignThresholds;
  criteria: Record<string, Criterion>;
  /** Every C1–C7 passes (C8 is external). */
  allPass: boolean;
  verdict: string;
  reported: Record<string, unknown>;
}

const fmtC = (id: string, pass: boolean | null, value: number | null, threshold: number | null, extra: Partial<Criterion> = {}): Criterion =>
  ({ id, pass, value, threshold, ...extra });

export function computeCriteria(inp: CriteriaInputs): CriteriaReport {
  const th = CRITERIA[inp.design];
  const s = inp.summary;
  const outer = [...s.outerTests].sort((a, b) => a.result.fromMs - b.result.fromMs).map(t => t.result);
  const mine = chainDailyReturns(s);
  const criteria: Record<string, Criterion> = {};

  // C1 — outer PSR (autocorr-penalized, vs SR 0), the protocol's instrument.
  criteria.C1 = fmtC("C1_psr", s.outerPsr !== undefined && s.outerPsr >= th.c1MinPsr, s.outerPsr ?? null, th.c1MinPsr,
    s.outerPsr === undefined ? { reason: "outer PSR not computed (no stitched OOS evidence)" } : {});

  // C2 — stitched max drawdown.
  criteria.C2 = fmtC("C2_maxDrawdown", outer.length > 0 && s.stitchedOos.maxDrawdown <= th.c2MaxDrawdown, outer.length > 0 ? s.stitchedOos.maxDrawdown : null, th.c2MaxDrawdown,
    outer.length === 0 ? { reason: "no executed outer fold" } : {});

  // C3 — stress-cost stitched Sharpe (same instrument as the stress gates).
  {
    const stress = s.stressTests.map(t => t.result);
    if (stress.length === 0) criteria.C3 = fmtC("C3_stressSharpe", false, null, th.c3StressMinSharpe, { reason: "missing stress results" });
    else {
      const sm = stitchedMetrics(stitchEquityHistory(stress, inp.initialEquity), stress, inp.ppy);
      criteria.C3 = fmtC("C3_stressSharpe", sm.sharpe >= th.c3StressMinSharpe, sm.sharpe, th.c3StressMinSharpe, { detail: { stressTotalReturn: sm.totalReturn, stressMaxDrawdown: sm.maxDrawdown } });
    }
  }

  // C4 — signal vs passive, same sessions.
  if (!inp.passive || inp.passive.size === 0) criteria.C4 = fmtC("C4_vsPassive", false, null, th.c4MinExcessVsPassive, { reason: "passive benchmark not computed" });
  else {
    const a = alignedSharpe(mine, inp.passive, inp.ppy);
    const excess = a.sharpeA - a.sharpeB;
    criteria.C4 = fmtC("C4_vsPassive", a.observations >= 30 && excess >= th.c4MinExcessVsPassive, excess, th.c4MinExcessVsPassive, {
      detail: { strategySharpe: a.sharpeA, passiveSharpe: a.sharpeB, observations: a.observations },
      ...(a.observations < 30 ? { reason: `only ${a.observations} common sessions` } : {}),
    });
  }

  // C5 — vs the market benchmark, same sessions.
  if (!inp.market || inp.market.size === 0) criteria.C5 = fmtC("C5_vsMarket", false, null, th.c5MinExcess, { reason: inp.marketError ?? "market benchmark not computed", detail: { benchmark: th.c5Market } });
  else {
    const a = alignedSharpe(mine, inp.market, inp.ppy);
    const excess = a.sharpeA - a.sharpeB;
    criteria.C5 = fmtC("C5_vsMarket", a.observations >= 30 && excess >= th.c5MinExcess, excess, th.c5MinExcess, {
      detail: { benchmark: th.c5Market, strategySharpe: a.sharpeA, marketSharpe: a.sharpeB, observations: a.observations, protocolBenchSharpe: s.stitchedOos.benchSharpe ?? null },
      ...(a.observations < 30 ? { reason: `only ${a.observations} common sessions` } : {}),
    });
  }

  // C6 — calendar-year concentration of the stitched P&L.
  const stitched = outer.length > 0 ? stitchEquityHistory(outer, inp.initialEquity) : [];
  const years = yearPnlShares(stitched);
  criteria.C6 = fmtC("C6_yearShare", outer.length > 0 && years.maxShare <= th.c6MaxYearShare, Number.isFinite(years.maxShare) ? years.maxShare : null, th.c6MaxYearShare, {
    detail: { byYearPnl: years.byYear, shares: years.shares, totalPnl: years.totalPnl },
    ...(years.totalPnl <= 0 ? { reason: "total stitched P&L ≤ 0 (fails closed)" } : {}),
  });

  // C6b — symbol robustness.
  if (th.c6b.kind === "exTopDecile") {
    const x = inp.exTopDecile;
    criteria.C6b = fmtC("C6b_exTopDecile", x !== null && x.sharpe >= th.c6b.minSharpe, x?.sharpe ?? null, th.c6b.minSharpe,
      x ? { detail: { excluded: x.excluded, totalReturn: x.totalReturn, maxDrawdown: x.maxDrawdown } } : { reason: "ex-top-decile re-run not computed" });
  } else {
    const loo = s.loo;
    if (loo.length === 0) criteria.C6b = fmtC("C6b_worstLoo", false, null, th.c6b.minRatio * s.stitchedOos.sharpe, { reason: "no LOO results" });
    else {
      const worst = loo.reduce((w, l) => (l.stitchedSharpe < w.stitchedSharpe ? l : w), loo[0]);
      const floor = th.c6b.minRatio * s.stitchedOos.sharpe;
      criteria.C6b = fmtC("C6b_worstLoo", worst.stitchedSharpe >= floor, worst.stitchedSharpe, floor, {
        detail: { worstExcluded: worst.excludedSymbol, ratio: s.stitchedOos.sharpe > 0 ? worst.stitchedSharpe / s.stitchedOos.sharpe : null, loo: loo.map(l => ({ symbol: l.excludedSymbol, sharpe: l.stitchedSharpe })) },
      });
    }
  }

  // C7 — break-even extra cost per side.
  {
    const be = s.breakEvenSlippageBps;
    const extra = be === undefined ? null : be - inp.baseSlippageBps;
    criteria.C7 = fmtC("C7_breakEvenExtraBps", extra !== null && extra >= th.c7MinExtraBpsPerSide, extra === Infinity ? null : extra, th.c7MinExtraBpsPerSide, {
      detail: { breakEvenSlippageBps: be === Infinity ? "Infinity" : be ?? null, baseSlippageBps: inp.baseSlippageBps, curve: s.breakEvenCurve ?? null, neverCrosses: be === Infinity },
      ...(be === undefined ? { reason: "break-even curve not computed (--no-breakeven / dry-run)" } : {}),
    });
  }

  // C8 — external.
  criteria.C8 = fmtC("C8_timingVsRandom", null, null, 90, { reason: "computed outside the engine by the independent replication (percentile ≥ 90)" });

  // ── report-only ─────────────────────────────────────────────────────────
  const diags = outer.map(r => (r as PortfolioReplayResult).portfolioDiagnostics).filter(Boolean);
  const sessions = diags.reduce((a, d) => a + d.sessions, 0);
  let turnoverW = 0, turnoverAcc = 0;
  for (const r of outer) { const w = Math.max(0, r.toMs - r.fromMs); turnoverW += w; turnoverAcc += (r.turnoverAnnual ?? 0) * w; }
  const pnlByAssetClass: Record<string, number> = {};
  let scale = 1;
  for (const r of outer) {
    const d = (r as PortfolioReplayResult).portfolioDiagnostics;
    if (d) for (const [k, v] of Object.entries(d.pnlByAssetClass)) pnlByAssetClass[k] = (pnlByAssetClass[k] ?? 0) + scale * v;
    scale *= 1 + r.totalReturn; // stitched-account dollars (folds restart at initialEquity)
  }
  const correlations: Record<string, { corr: number; observations: number }> = {};
  for (const [label, series] of Object.entries(inp.compare ?? {})) correlations[label] = correlationOnCommonDates(mine, series);
  const reported = {
    ordersPerSession: sessions > 0 ? diags.reduce((a, d) => a + d.orders, 0) / sessions : null,
    adjustmentOrdersPerSession: sessions > 0 ? diags.reduce((a, d) => a + d.adjustmentOrders, 0) / sessions : null,
    stopOrders: diags.reduce((a, d) => a + d.stopOrders, 0),
    sessions,
    turnoverAnnual: turnoverW > 0 ? turnoverAcc / turnoverW : null,
    avgGross: sessions > 0 ? diags.reduce((a, d) => a + d.avgGross * d.sessions, 0) / sessions : null,
    pnlByAssetClass,
    marginInterest: s.stitchedOos.marginInterest ?? 0,
    funding: s.stitchedOos.funding,
    fees: s.stitchedOos.fees,
    stitchedSharpe: s.stitchedOos.sharpe,
    stitchedTotalReturn: s.stitchedOos.totalReturn,
    observations: s.observations ?? mine.size,
    correlations,
    outerSelection: s.outerSelection ?? [],
  };

  const judged = ["C1", "C2", "C3", "C4", "C5", "C6", "C6b", "C7"];
  const allPass = judged.every(k => criteria[k]?.pass === true);
  return {
    design: inp.design,
    thresholds: th,
    criteria,
    allPass,
    verdict: allPass ? "CUMPLE C1–C7 (C8 pendiente de la réplica independiente)" : `FALLA: ${judged.filter(k => criteria[k]?.pass !== true).join(", ")}`,
    reported,
  };
}

// ── orchestration: benchmarks + criteria for a finished protocol run ─────

export interface EvaluateOptions {
  kernel?: PortfolioKernel;
  /** Research DB for the benchmark re-runs (default: the manifest's). */
  dbPath?: string;
  /** label → artifact directory (data/backtests/<hash>) for report-only correlations. */
  compareArtifacts?: Record<string, string>;
  criteriaFile?: string;
  quiet?: boolean;
}

export async function evaluatePortfolioCriteria(
  m: ExperimentManifest,
  summary: WalkForwardSummary,
  outputDir: string,
  manifestPath: string,
  opts: EvaluateOptions = {},
): Promise<CriteriaReport & { generatedAt: string; manifest: string; manifestHash: string }> {
  const strategy = m.candidates[0]?.portfolio?.strategy;
  if (!strategy) throw new Error("evaluatePortfolioCriteria: not a portfolio manifest");
  const design = designOf(strategy);
  const ppy = periodsPerYear(m.sleeve, m.data.source);
  const kernel = opts.kernel ?? coreKernel;
  const dbPath = opts.dbPath ?? m.data.dbPath;
  const windows = executedOuterWindows(m, summary);
  const assetClasses = m.data.assetClasses;

  // Passive (C4): same simulator, costs, venue; the decision swapped.
  let passive: DailySeries | null = null;
  if (windows.length > 0) {
    const results = await rerunChain(m, windows, makePortfolioRunner(kernel, { decide: passiveDecideFor(strategy), assetClasses }), "passive", () => {}, dbPath);
    passive = seriesOf(results.flatMap(r => r.dailyReturns));
  }

  // Market (C5): frictionless close-to-close on the executed windows.
  let market: DailySeries | null = null;
  let marketError: string | undefined;
  if (windows.length > 0) {
    try {
      market = new Map();
      for (const w of windows) for (const [d, r] of marketDailyReturns(dbPath, m, CRITERIA[design].c5Market, w.fromMs, w.toMs)) market.set(d, r);
    } catch (e) {
      market = null;
      marketError = (e as Error).message;
    }
  }

  // C6b (D1/D2): chain re-run without the top P&L decile.
  let exTopDecile: CriteriaInputs["exTopDecile"] = null;
  if (CRITERIA[design].c6b.kind === "exTopDecile" && windows.length > 0) {
    const excluded = topDecileSymbols(summary);
    if (excluded.length > 0) {
      const results = await rerunChain(m, windows, makePortfolioRunner(kernel, { assetClasses }), "ex-top-decile", cfg => {
        if (strategy.kind === "factorCore") {
          const p = (cfg as typeof cfg & { portfolio: NonNullable<ExperimentManifest["candidates"][0]["portfolio"]> }).portfolio;
          p.strategy = { ...p.strategy, exclude: [...new Set([...(p.strategy as { exclude: string[] }).exclude, ...excluded])] } as PortfolioStrategyConfig;
        } else {
          cfg.universe = cfg.universe.filter(s => !excluded.includes(s));
          if (!cfg.universe.includes(cfg.refSymbol)) cfg.refSymbol = cfg.universe[0];
        }
      }, dbPath);
      if (results.length > 0) {
        const sm = stitchedMetrics(stitchEquityHistory(results, m.ledger.initialEquity), results, ppy);
        exTopDecile = { excluded, sharpe: sm.sharpe, totalReturn: sm.totalReturn, maxDrawdown: sm.maxDrawdown };
      }
    }
  }

  const compare: Record<string, DailySeries> = {};
  for (const [label, dir] of Object.entries(opts.compareArtifacts ?? {})) {
    try { compare[label] = artifactOosDailyReturns(dir); } catch (e) { compare[label] = new Map(); if (!opts.quiet) console.warn(`compare ${label}: ${(e as Error).message}`); }
  }

  const report = computeCriteria({ design, summary, ppy, initialEquity: m.ledger.initialEquity, baseSlippageBps: m.costs.base.slippageBps, passive, market, marketError, exTopDecile, compare });
  const out = { generatedAt: new Date().toISOString(), manifest: manifestPath, manifestHash: summary.manifestHash, ...report };
  if (existsSync(outputDir)) writeFileSync(join(outputDir, opts.criteriaFile ?? "rw-criteria.json"), JSON.stringify(out, null, 2));
  if (!opts.quiet) {
    console.log(`\n▌ RW §2.5 criteria (${design})`);
    for (const c of Object.values(report.criteria)) {
      const v = c.value === null ? "n/a" : c.value.toFixed(3);
      console.log(`   ${c.id}: ${c.pass === null ? "external" : c.pass ? "PASS" : "FAIL"} value=${v} threshold=${c.threshold ?? "—"}${c.reason ? ` (${c.reason})` : ""}`);
    }
    console.log(`   orders/session: ${report.reported.ordersPerSession !== null ? (report.reported.ordersPerSession as number).toFixed(2) : "n/a"} (adjustments ${(report.reported.adjustmentOrdersPerSession as number | null)?.toFixed(2) ?? "n/a"}) | turnover ${((report.reported.turnoverAnnual as number | null) ?? NaN).toFixed(2)}×/yr | mean gross ${((report.reported.avgGross as number | null) ?? NaN).toFixed(2)}`);
    console.log(`   VERDICT: ${report.verdict}`);
    if (existsSync(outputDir)) console.log(`   written: ${join(outputDir, opts.criteriaFile ?? "rw-criteria.json")}`);
  }
  return out;
}
