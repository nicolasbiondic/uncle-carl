#!/usr/bin/env bun
/**
 * Line C replay kernel — intraday SPY/QQQ last-half-hour momentum (Gao, Han,
 * Li & Zhou 2018), docs/reports/V-plan-volumen-rentabilidad.md §12.
 *
 * Nested nested walk-forward over a manifest (experiments/intraday-spy-qqq-v1.json):
 *   - expanding outer/inner folds with a purge gap (reuses
 *     scripts/walk-forward.ts's `generateFolds` — pure date math, sleeve-agnostic)
 *   - inner-fold candidate selection via corrected DSR -> median Sharpe ->
 *     median drawdown -> hash tie-break (reuses `aggregateInner`/`selectCandidate`)
 *   - outer test (base cost) + stress test (same candidate, no reselection)
 *   - stitched OOS evidence: outerPsr/foldPsr/minTrl/breakEvenCurve (reuses
 *     `penalizedPsr`/`breakEvenFromCurve`/`BREAK_EVEN_SLIPPAGE_BPS`) and
 *     sequence risk (reuses scripts/lib/sequenceRisk.ts)
 *   - correlation vs the 4 authoritative live chains, capital-weighted
 *     (scripts/lib/combinedPortfolioReturns.ts)
 *
 * Output schema mirrors scripts/walk-forward.ts's WalkForwardSummary field
 * names (stitchedOos, outerSelection, outerPsr, foldPsr, breakEvenCurve,
 * acceptance, ...) — this is a NEW, independent kernel (the intraday
 * strategy/engine has nothing in common with MomentumEngine/MeanRevEngine),
 * not a call into walk-forward.ts's runWalkForward.
 *
 * Usage: bun run scripts/intraday-wf.ts experiments/intraday-spy-qqq-v1.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  generateFolds,
  aggregateInner,
  selectCandidate,
  penalizedPsr,
  breakEvenFromCurve,
  BREAK_EVEN_SLIPPAGE_BPS,
  type WindowConfig,
  type InnerMetrics,
  type CandidateAggregate,
} from "./walk-forward";
import {
  computeDayOutcome,
  netReturn,
  ordersForDay,
  type MinBar,
  type IntradayCandidate,
  type DayOutcome,
} from "./lib/intradayMomentum";
import { computeSequenceRisk } from "./lib/sequenceRisk";
import { expandDataPath } from "./lib/researchData";
import {
  combinedWeightedDailyReturns,
  alignSeries,
  pearsonCorrelation,
} from "./lib/combinedPortfolioReturns";
import { sleeveExpectationArtifacts } from "../src/portfolio/scorecard";
import {
  cumulativeReturn,
  sharpe as sharpeOf,
  maxDrawdown as maxDrawdownOf,
  autocorrPenalty,
  skewness,
  kurtosis,
  stdev,
  mean as meanOf,
  deflatedSharpe,
} from "../src/reports/metrics";
import { minTrlObservations, probabilisticSharpe as psrFromMoments } from "../src/portfolio/trackRecord";
import { getETDateKey, getETDayStart } from "../src/db/database";
import { isTradingDay, getSessionClose } from "../src/utils/marketHours";

const PPY = 252; // NYSE trading days/year — same convention as the stocks/meanrev sleeves.

// ── capital weights for criterion 5 (correlation with the live combined book) ──
// Matches src/config/riskProfiles.ts live allocations: momentum_stocks/meanrev_stocks
// 50k each (shared Alpaca wallet), momentum_crypto/momentum_crypto_usdc 5k each.
const LIVE_ARTIFACT_WEIGHTS: Record<string, number> = {
  momentum_stocks: 50_000,
  meanrev_stocks: 50_000,
  momentum_crypto: 5_000,
  momentum_crypto_usdc: 5_000,
};

// ── manifest types ──────────────────────────────────────────────────────
interface Manifest {
  name: string;
  line: string;
  description: string;
  trialAccounting: { priorUniqueTrials: number; complete: boolean };
  data: { dbPath: string; universe: [string, string]; timeframe: string; source: string };
  window: { from: string; to: string; outerFoldCount: number; innerFoldCount: number; purgeYears: number };
  costs: { base: { bpsPerSide: number }; stress: { bpsPerSide: number } };
  ledger: { initialEquity: number };
  candidates: IntradayCandidate[];
  acceptance: {
    minOuterPsr: number;
    minSharpeBase: number;
    minSharpeStress: number;
    minBreakEvenSlippageBpsPerSide: number;
    maxCorrelationWithPortfolio: number;
    maxDrawdown: number;
    maxYearPnlShare: number;
    minSharpePerSymbol: number;
  };
}

interface DayPoint { date: string; ret: number }

function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}
function hashStr(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
function hashCandidate(c: IntradayCandidate): string {
  return hashStr(canonicalJson(c));
}

// ── data loading ─────────────────────────────────────────────────────────
interface SymbolData {
  byDate: Map<string, MinBar[]>;
  sortedDates: string[];
  prevClose: Map<string, number>;
}

function loadSymbolData(db: Database, symbol: string, timeframe: string): SymbolData {
  const rows = db.prepare(
    `SELECT timestamp, open, high, low, close, volume FROM historical_bars
     WHERE symbol = ? AND timeframe = ? ORDER BY timestamp ASC`,
  ).all(symbol, timeframe) as MinBar[];
  if (rows.length === 0) throw new Error(`no bars for ${symbol}/${timeframe} in ${db.filename}`);
  const byDate = new Map<string, MinBar[]>();
  for (const b of rows) {
    const dk = getETDateKey(b.timestamp);
    (byDate.get(dk) ?? byDate.set(dk, []).get(dk)!).push(b);
  }
  const sortedDates = [...byDate.keys()].sort();
  const prevClose = new Map<string, number>();
  for (let i = 1; i < sortedDates.length; i++) {
    const prevBars = byDate.get(sortedDates[i - 1])!;
    prevClose.set(sortedDates[i], prevBars[prevBars.length - 1].close);
  }
  return { byDate, sortedDates, prevClose };
}

/** sha256 over every consumed bar row — the data identity (hashDataSnapshot's convention, scripts/walk-forward.ts). */
function hashBars(data: Record<string, SymbolData>): string {
  const h = createHash("sha256");
  for (const sym of Object.keys(data).sort()) {
    const d = data[sym];
    h.update(`symbol:${sym}:dates:${d.sortedDates.length}\n`);
    for (const dk of d.sortedDates) {
      for (const b of d.byDate.get(dk)!) {
        h.update(`${sym}|${b.timestamp}|${b.open}|${b.high}|${b.low}|${b.close}|${b.volume}\n`);
      }
    }
  }
  return h.digest("hex");
}

// ── per-candidate day outcomes (precomputed once per symbol) ─────────────
type OutcomeMap = Map<string, Map<string, Omit<DayOutcome, "dateKey">>>; // candidateName -> dateKey -> outcome

function precomputeOutcomes(symData: SymbolData, candidates: IntradayCandidate[]): OutcomeMap {
  const out: OutcomeMap = new Map(candidates.map(c => [c.name, new Map()]));
  for (const dk of symData.sortedDates) {
    const prevClose = symData.prevClose.get(dk);
    if (!prevClose) continue; // first date in the series, no prior close
    if (!isTradingDay(dk)) continue; // defensive; data should already be RTH-only trading days
    const sessionCloseMin = getSessionClose(dk).closeMinutes;
    const dayStartMs = getETDayStart(Date.parse(`${dk}T12:00:00Z`));
    const bars = symData.byDate.get(dk)!;
    for (const c of candidates) {
      const outcome = computeDayOutcome(bars, dayStartMs, sessionCloseMin, prevClose, c);
      if (outcome) out.get(c.name)!.set(dk, outcome);
    }
  }
  return out;
}

// ── series simulation ─────────────────────────────────────────────────────
interface SimResult {
  combined: DayPoint[];
  spyOnly: DayPoint[];
  qqqOnly: DayPoint[];
  trades: number; // closed round-trip trades (both symbols combined)
  tradePnlsCloseOrder: number[]; // net return fraction per executed trade, in date order
}

function simulateSeries(
  spyOut: Map<string, Omit<DayOutcome, "dateKey">>,
  qqqOut: Map<string, Omit<DayOutcome, "dateKey">>,
  dateKeys: string[],
  costBpsPerSide: number,
  extraBpsPerSide = 0,
): SimResult {
  const combined: DayPoint[] = [], spyOnly: DayPoint[] = [], qqqOnly: DayPoint[] = [];
  let trades = 0;
  const tradePnlsCloseOrder: number[] = [];
  for (const dk of dateKeys) {
    const s = spyOut.get(dk), q = qqqOut.get(dk);
    const sNet = s ? netReturn(s.direction, s.grossReturn, costBpsPerSide, extraBpsPerSide) : 0;
    const qNet = q ? netReturn(q.direction, q.grossReturn, costBpsPerSide, extraBpsPerSide) : 0;
    combined.push({ date: dk, ret: 0.5 * sNet + 0.5 * qNet });
    spyOnly.push({ date: dk, ret: sNet });
    qqqOnly.push({ date: dk, ret: qNet });
    if (s && s.direction !== 0) { trades++; tradePnlsCloseOrder.push(sNet); }
    if (q && q.direction !== 0) { trades++; tradePnlsCloseOrder.push(qNet); }
  }
  return { combined, spyOnly, qqqOnly, trades, tradePnlsCloseOrder };
}

function seriesMetrics(points: DayPoint[]) {
  const rets = points.map(p => p.ret);
  return {
    totalReturn: cumulativeReturn(rets),
    sharpe: sharpeOf(rets, 0, PPY),
    maxDrawdown: Math.abs(maxDrawdownOf(rets)),
  };
}

// ── OOS evidence (PSR/MinTRL — same primitives as walk-forward.ts's computeOuterEvidence) ──
function outerEvidence(dailyRets: number[]) {
  const n = dailyRets.length;
  if (n < 2) return { outerPsr: undefined as number | undefined, minTrl: null as number | null };
  const sd = stdev(dailyRets);
  if (sd < 1e-12) return { outerPsr: undefined, minTrl: null };
  const srAdj = meanOf(dailyRets) / sd / autocorrPenalty(dailyRets);
  const sk = skewness(dailyRets);
  const k4 = kurtosis(dailyRets) + 3; // non-excess, trackRecord convention
  return {
    outerPsr: psrFromMoments(srAdj, 0, n, sk, k4) ?? undefined,
    minTrl: minTrlObservations(srAdj, 0, sk, k4, 1.645),
  };
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  const manifestPath = process.argv[2] ?? "experiments/intraday-spy-qqq-v1.json";
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // "$UC_RESEARCH_DATA_DIR/hist-intraday.db" -> absolute, BEFORE the config
  // hash below reads the manifest: the hash sees the same path as before.
  manifest.data.dbPath = expandDataPath(manifest.data.dbPath);
  const [SYM_A, SYM_B] = manifest.data.universe; // SPY, QQQ

  const db = new Database(manifest.data.dbPath, { readonly: true });
  const dataA = loadSymbolData(db, SYM_A, manifest.data.timeframe);
  const dataB = loadSymbolData(db, SYM_B, manifest.data.timeframe);
  db.close();

  // Common trading days with a FULL session in both symbols. Drop the very
  // last common date if either symbol's last bar didn't reach the session
  // close (today's session mid-flight / 15-min SIP delay truncation).
  const setB = new Set(dataB.sortedDates);
  let commonDates = dataA.sortedDates.filter(d => setB.has(d));
  const lastBarReachesClose = (sym: SymbolData, dk: string) => {
    const bars = sym.byDate.get(dk)!;
    const last = bars[bars.length - 1];
    const dayStartMs = getETDayStart(Date.parse(`${dk}T12:00:00Z`));
    const min = Math.round((last.timestamp - dayStartMs) / 60_000);
    return min >= getSessionClose(dk).closeMinutes - 2;
  };
  while (commonDates.length > 0) {
    const last = commonDates[commonDates.length - 1];
    if (lastBarReachesClose(dataA, last) && lastBarReachesClose(dataB, last)) break;
    commonDates = commonDates.slice(0, -1);
  }
  const asOfMs = Date.parse(`${commonDates[commonDates.length - 1]}T12:00:00Z`);
  const resolvedTo = new Date(asOfMs).toISOString();

  const window: WindowConfig = {
    from: manifest.window.from,
    to: manifest.window.to.toLowerCase() === "latest" ? resolvedTo : manifest.window.to,
    outerFoldCount: manifest.window.outerFoldCount,
    innerFoldCount: manifest.window.innerFoldCount,
    purgeYears: manifest.window.purgeYears,
    warmupDays: 0, // unused by generateFolds; carried only for WindowConfig's shape
  };
  const folds = generateFolds(window, asOfMs);

  const dateKeyMs = (dk: string) => Date.parse(`${dk}T12:00:00Z`);
  const tradingDaysInRange = (fromMs: number, toMs: number) =>
    commonDates.filter(dk => { const ms = dateKeyMs(dk); return ms >= fromMs && ms < toMs; });

  const outcomesA = precomputeOutcomes(dataA, manifest.candidates);
  const outcomesB = precomputeOutcomes(dataB, manifest.candidates);
  const candidateByHash = new Map(manifest.candidates.map(c => [hashCandidate(c), c]));
  const numTrials = Math.max(1, manifest.trialAccounting.priorUniqueTrials + manifest.candidates.length);

  const innerSelection: InnerMetrics[] = [];
  const outerSelection: Array<{ foldPath: string; candidateName: string; candidateHash: string }> = [];
  const outerTests: Array<{ foldPath: string; candidateName: string; fromMs: number; toMs: number; sim: SimResult }> = [];
  const stressTests: Array<{ foldPath: string; candidateName: string; sim: SimResult }> = [];

  for (const fold of folds) {
    const foldInner: InnerMetrics[] = [];
    for (const inner of fold.inner) {
      const dateKeys = tradingDaysInRange(inner.fromMs, inner.toMs);
      for (const c of manifest.candidates) {
        const sim = simulateSeries(outcomesA.get(c.name)!, outcomesB.get(c.name)!, dateKeys, manifest.costs.base.bpsPerSide);
        const rets = sim.combined.map(p => p.ret);
        const dsr = rets.length >= 30 ? deflatedSharpe(rets, numTrials, PPY) : 0;
        foldInner.push({
          candidateHash: hashCandidate(c), candidateName: c.name, foldPath: inner.path,
          dsr, sharpe: sharpeOf(rets, 0, PPY), maxDrawdown: Math.abs(maxDrawdownOf(rets)),
          totalReturn: cumulativeReturn(rets), trades: sim.trades,
        });
      }
    }
    innerSelection.push(...foldInner);
    const aggregates: CandidateAggregate[] = aggregateInner(foldInner);
    const selected = selectCandidate(aggregates);
    outerSelection.push({ foldPath: fold.path, candidateName: selected.candidateName, candidateHash: selected.candidateHash });
    const selectedConfig = candidateByHash.get(selected.candidateHash)!;

    const testDateKeys = tradingDaysInRange(fold.test.fromMs, fold.test.toMs);
    const simBase = simulateSeries(outcomesA.get(selectedConfig.name)!, outcomesB.get(selectedConfig.name)!, testDateKeys, manifest.costs.base.bpsPerSide);
    outerTests.push({ foldPath: fold.test.path, candidateName: selectedConfig.name, fromMs: fold.test.fromMs, toMs: fold.test.toMs, sim: simBase });
    const simStress = simulateSeries(outcomesA.get(selectedConfig.name)!, outcomesB.get(selectedConfig.name)!, testDateKeys, manifest.costs.stress.bpsPerSide);
    stressTests.push({ foldPath: fold.test.path, candidateName: selectedConfig.name, sim: simStress });
  }

  // ── stitch (outer folds are chronological & non-overlapping by construction) ──
  const stitchedCombined = outerTests.flatMap(t => t.sim.combined);
  const stitchedSpy = outerTests.flatMap(t => t.sim.spyOnly);
  const stitchedQqq = outerTests.flatMap(t => t.sim.qqqOnly);
  const stitchedStressCombined = stressTests.flatMap(t => t.sim.combined);
  const totalTrades = outerTests.reduce((s, t) => s + t.sim.trades, 0);
  const allTradePnls = outerTests.flatMap(t => t.sim.tradePnlsCloseOrder);
  const wins = allTradePnls.filter(p => p > 0).length;

  const stitchedOos = {
    ...seriesMetrics(stitchedCombined),
    winRate: allTradePnls.length ? wins / allTradePnls.length : 0,
    trades: totalTrades,
    expectancy: allTradePnls.length ? allTradePnls.reduce((s, x) => s + x, 0) / allTradePnls.length : 0,
    fees: totalTrades * 2 * manifest.costs.base.bpsPerSide / 10_000 * (manifest.ledger.initialEquity / 2),
    funding: 0,
    marginInterest: 0,
    liquidations: 0,
    marginRejects: 0,
    ruined: false,
  };
  const stitchedStressSharpe = sharpeOf(stitchedStressCombined.map(p => p.ret), 0, PPY);
  const spyMetrics = seriesMetrics(stitchedSpy);
  const qqqMetrics = seriesMetrics(stitchedQqq);

  const combinedRets = stitchedCombined.map(p => p.ret);
  const { outerPsr, minTrl } = outerEvidence(combinedRets);
  const foldPsr = outerTests.map(t => ({ foldPath: t.foldPath, psr: penalizedPsr(t.sim.combined.map(p => p.ret)) ?? NaN }));
  const observations = combinedRets.length;
  const certifiableSharpeAtPsr95 = observations > 0 ? (1.645 * Math.sqrt(PPY)) / Math.sqrt(observations) : undefined;

  // ── break-even curve (same selected candidates per fold, no reselection) ──
  const breakEvenCurve = BREAK_EVEN_SLIPPAGE_BPS.map(tierBps => {
    const points = outerTests.flatMap(t => {
      const dateKeys = tradingDaysInRange(t.fromMs, t.toMs);
      const sim = simulateSeries(outcomesA.get(t.candidateName)!, outcomesB.get(t.candidateName)!, dateKeys, manifest.costs.base.bpsPerSide, tierBps);
      return sim.combined;
    });
    const rets = points.map(p => p.ret);
    return { slippageBps: tierBps, sharpe: sharpeOf(rets, 0, PPY), totalReturn: cumulativeReturn(rets) };
  });
  const breakEvenSlippageBps = breakEvenFromCurve(breakEvenCurve);

  // ── sequence risk (stitched combined daily returns + closed-trade pnls) ──
  const sequenceRisk = computeSequenceRisk(combinedRets, allTradePnls.map(r => r * (manifest.ledger.initialEquity / 2)), manifest.ledger.initialEquity);

  // ── criterion 5: correlation with the live combined 4-chain portfolio ──
  const artifacts = sleeveExpectationArtifacts();
  const weights = Object.entries(artifacts).map(([id, ref]) => ({ dir: ref.dir, initialEquity: LIVE_ARTIFACT_WEIGHTS[id] }));
  const combinedLive = combinedWeightedDailyReturns(weights);
  const ourSeries = new Map(stitchedCombined.map(p => [p.date, p.ret]));
  const aligned = alignSeries(ourSeries, combinedLive);
  const correlation = pearsonCorrelation(aligned.a, aligned.b);

  // ── criterion 7a: no calendar year > 50% of total P&L (arithmetic sum proxy) ──
  const byYear = new Map<string, number>();
  for (const p of stitchedCombined) {
    const y = p.date.slice(0, 4);
    byYear.set(y, (byYear.get(y) ?? 0) + p.ret);
  }
  const totalPnlProxy = [...byYear.values()].reduce((s, x) => s + x, 0);
  const maxYearShare = totalPnlProxy !== 0
    ? Math.max(...[...byYear.values()].map(y => Math.abs(y / totalPnlProxy)))
    : 1; // undefined/degenerate -> fail closed

  // ── criterion 8: orders/day (reported, not gated) ──
  const ordersPerDay = stitchedCombined.length > 0 ? (totalTrades * 2) / stitchedCombined.length : 0;

  // ── acceptance ──
  const acc = manifest.acceptance;
  const gate = (g: string, value: number, threshold: number, pass: boolean, reason?: string) =>
    [g, { gate: g, value, threshold, pass, ...(reason ? { reason } : {}) }] as const;
  const acceptance: Record<string, { gate: string; value: number; threshold: number; pass: boolean; reason?: string }> = Object.fromEntries([
    gate("structuralOuterFolds", outerSelection.length, 3, outerSelection.length >= 3),
    gate("minSharpeBase", stitchedOos.sharpe, acc.minSharpeBase, stitchedOos.sharpe >= acc.minSharpeBase),
    gate("minOuterPsr", outerPsr ?? NaN, acc.minOuterPsr, (outerPsr ?? -1) >= acc.minOuterPsr, outerPsr === undefined ? "outerPsr not computable" : undefined),
    gate("minSharpeStress", stitchedStressSharpe, acc.minSharpeStress, stitchedStressSharpe >= acc.minSharpeStress),
    gate("minBreakEvenSlippageBps", breakEvenSlippageBps ?? NaN, acc.minBreakEvenSlippageBpsPerSide, (breakEvenSlippageBps ?? -1) >= acc.minBreakEvenSlippageBpsPerSide),
    gate("maxCorrelation", correlation ?? NaN, acc.maxCorrelationWithPortfolio, correlation !== null && Math.abs(correlation) <= acc.maxCorrelationWithPortfolio, correlation === null ? "correlation not computable (no overlapping dates)" : undefined),
    gate("maxDrawdown", stitchedOos.maxDrawdown, acc.maxDrawdown, stitchedOos.maxDrawdown <= acc.maxDrawdown),
    gate("maxYearPnlShare", maxYearShare, acc.maxYearPnlShare, maxYearShare <= acc.maxYearPnlShare),
    gate("minSharpeSpy", spyMetrics.sharpe, acc.minSharpePerSymbol, spyMetrics.sharpe >= acc.minSharpePerSymbol),
    gate("minSharpeQqq", qqqMetrics.sharpe, acc.minSharpePerSymbol, qqqMetrics.sharpe >= acc.minSharpePerSymbol),
    gate("ordersPerDayReported", ordersPerDay, 0, true), // criterion 8: reported, never blocks approval
  ]);
  // Criteria 1-7 gate approval; criterion 8 (ordersPerDayReported) never blocks (§12).
  const blockingGates = Object.entries(acceptance).filter(([k]) => k !== "ordersPerDayReported");
  const approved = blockingGates.every(([, g]) => g.pass);
  const approvalReason = approved
    ? "all gates pass; awaiting explicit human approval (not auto-deployed)"
    : `gate(s) failed: ${blockingGates.filter(([, g]) => !g.pass).map(([k]) => k).join(", ")}`;

  // ── hashing / identity ──
  const dataHash = hashBars({ [SYM_A]: dataA, [SYM_B]: dataB });
  const configHash = hashStr(canonicalJson({ ...manifest, window }));
  const codeHash = hashStr([
    readFileSync("scripts/intraday-wf.ts", "utf8"),
    readFileSync("scripts/lib/intradayMomentum.ts", "utf8"),
    readFileSync("scripts/lib/combinedPortfolioReturns.ts", "utf8"),
  ].join("\n"));
  const manifestHash = hashStr(canonicalJson({ configHash, dataHash, codeHash }));

  const summary = {
    manifestHash, configHash, dataHash, codeHash,
    asOfMs, resolvedTo,
    selectedCandidate: outerSelection.length > 0 ? { hash: outerSelection[outerSelection.length - 1].candidateHash, name: outerSelection[outerSelection.length - 1].candidateName, reason: "last fold's inner-selected candidate" } : null,
    outerSelection,
    innerSelection,
    outerTests: outerTests.map(t => ({ foldPath: t.foldPath, candidateName: t.candidateName, result: { ...seriesMetrics(t.sim.combined), trades: t.sim.trades, dailyReturns: t.sim.combined } })),
    stressTests: stressTests.map(t => ({ foldPath: t.foldPath, candidateName: t.candidateName, result: { ...seriesMetrics(t.sim.combined), trades: t.sim.trades } })),
    stitchedOos,
    perSymbol: { [SYM_A]: spyMetrics, [SYM_B]: qqqMetrics },
    outerPsr, minTrl, observations, foldPsr,
    breakEvenCurve, breakEvenSlippageBps: breakEvenSlippageBps === Infinity ? null : breakEvenSlippageBps,
    sequenceRisk,
    certifiableSharpeAtPsr95,
    correlationWithLivePortfolio: correlation,
    ordersPerDay,
    skippedFolds: [] as string[],
    acceptance,
    approved,
    approvalReason,
    complete: true,
    priorTrialsComplete: manifest.trialAccounting.complete,
  };

  const outputDir = join("data", "backtests", manifestHash);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "manifest-resolved.json"), JSON.stringify({ ...manifest, window }, null, 2));
  const runLines: string[] = [];
  for (const r of innerSelection) {
    runLines.push(JSON.stringify({ id: hashStr(`${r.foldPath}:${r.candidateHash}:base`), candidateHash: r.candidateHash, candidateName: r.candidateName, foldPath: r.foldPath, costTier: "base", status: "complete", hash: hashStr(canonicalJson(r)), result: { sharpe: r.sharpe, maxDrawdown: r.maxDrawdown, totalReturn: r.totalReturn, trades: r.trades, dsr: r.dsr } }));
  }
  for (let i = 0; i < outerTests.length; i++) {
    const t = outerTests[i];
    const candidateHash = outerSelection[i].candidateHash;
    runLines.push(JSON.stringify({ id: hashStr(`${t.foldPath}:${candidateHash}:base`), candidateHash, candidateName: t.candidateName, foldPath: t.foldPath, costTier: "base", status: "complete", hash: hashStr(canonicalJson(t.sim.combined)), result: { ...seriesMetrics(t.sim.combined), trades: t.sim.trades, dailyReturns: t.sim.combined, config: { initialEquity: manifest.ledger.initialEquity } } }));
  }
  for (let i = 0; i < stressTests.length; i++) {
    const t = stressTests[i];
    const candidateHash = outerSelection[i].candidateHash;
    runLines.push(JSON.stringify({ id: hashStr(`${t.foldPath}:${candidateHash}:stress`), candidateHash, candidateName: t.candidateName, foldPath: t.foldPath, costTier: "stress", status: "complete", hash: hashStr(canonicalJson(t.sim.combined)), result: { ...seriesMetrics(t.sim.combined), trades: t.sim.trades, dailyReturns: t.sim.combined, config: { initialEquity: manifest.ledger.initialEquity } } }));
  }
  writeFileSync(join(outputDir, "runs.jsonl"), runLines.join("\n") + "\n");
  writeFileSync(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(`\nLine C — intraday SPY/QQQ — artifact: ${outputDir}`);
  console.log(`asOf=${resolvedTo}  outer folds=${folds.length}  observations=${observations}`);
  console.log(`outerSelection: ${outerSelection.map(s => `${s.foldPath}=${s.candidateName}`).join(", ")}`);
  console.log(`stitchedOos: return=${(stitchedOos.totalReturn * 100).toFixed(1)}%  sharpe=${stitchedOos.sharpe.toFixed(3)}  maxDD=${(stitchedOos.maxDrawdown * 100).toFixed(1)}%  trades=${stitchedOos.trades}`);
  console.log(`stressSharpe=${stitchedStressSharpe.toFixed(3)}  outerPsr=${outerPsr?.toFixed(3) ?? "n/a"}  breakEvenBps=${breakEvenSlippageBps}`);
  console.log(`SPY sharpe=${spyMetrics.sharpe.toFixed(3)}  QQQ sharpe=${qqqMetrics.sharpe.toFixed(3)}  correlation=${correlation?.toFixed(3) ?? "n/a"}`);
  console.log(`ordersPerDay=${ordersPerDay.toFixed(2)}`);
  console.log(`approved=${approved}  (${approvalReason})`);
  for (const [k, g] of Object.entries(acceptance)) {
    console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${k.padEnd(28)} value=${typeof g.value === "number" ? g.value.toFixed(4) : g.value}  threshold=${g.threshold}${g.reason ? `  (${g.reason})` : ""}`);
  }
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(1); });
}
