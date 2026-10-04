#!/usr/bin/env bun
/**
 * Look-ahead bias detector for the replay runners (Freqtrade
 * `lookahead-analysis` pattern, adapted to this stack).
 *
 * WHAT IT DOES — behavioral, not static: run a baseline replay over a
 * window, then re-run the SAME fully-resolved config with the data series
 * truncated just after each sampled trade event, and require the truncated
 * run to reproduce the baseline's prefix EXACTLY — every closed trade
 * (symbol/side/reason/exitAt/pnl) and every equity mark before the cut.
 * A strategy/simulator that peeks past the truncation point (indicator
 * computed over future bars, shift(-n)-class errors, fills priced off
 * later data) produces a different prefix and FAILS.
 *
 * Freqtrade parity choices, adapted:
 *   - No caching: every replay constructs a fresh engine + fresh SimBroker
 *     from the DB; nothing is reused across runs (runWithConfig /
 *     runMeanRevReplay have no cross-call cache).
 *   - Effectively unlimited capital (default; --no-boost disables): equity
 *     ×100 and, for momentum, leverage ≥100 so margin rejects can never
 *     mask a divergent signal; for meanrev, maxPositions is lifted to the
 *     whole universe so slot exhaustion can't hide a changed entry ranking.
 *     Momentum maxLongs/maxShorts are deliberately NOT lifted: the slot cap
 *     is strategy semantics (TSM ranks and concentrates), and lifting it on
 *     stocks would trip the Reg-T maintenance-margin liquidation simulation.
 *   - Market-like fills are already the only fill model (next-bar open).
 *
 * DETERMINISM PRECONDITION: the baseline is run TWICE and must be
 * bit-identical before any truncation is attributed to look-ahead —
 * otherwise the verdict is NONDETERMINISTIC (a different, equally blocking
 * failure class).
 *
 * HONEST LIMITS (document, don't hide):
 *   1. Like Freqtrade's: only signals that actually FIRED are verified.
 *      A biased indicator that never changed a fired decision in the tested
 *      window/cuts is a false negative.
 *   2. Architecture blind spot: both runners legitimately consume the
 *      EXECUTION bar (decision at tick t fills at the next bar's open), so
 *      truncation always leaves one bar beyond every compared decision.
 *      A peek confined to that execution bar (e.g. "signal reads today's
 *      close, fills at today's open") is behaviorally indistinguishable
 *      from the legitimate fill and is NOT caught here — that class is
 *      pinned instead by the hand-computed fixture tests
 *      (scripts/meanrev-replay.test.ts computes every fill from yesterday's
 *      signal bar BY HAND; scripts/backtest-momentum-wf.test.ts pins
 *      SimBroker.closedIndex/executionPrice to strictly-closed bars).
 *      Peeks extending ≥1 bar PAST the execution bar are caught.
 *
 * Usage:
 *   bun run scripts/lookahead-analysis.ts <manifest.json>
 *     [--cuts N] [--candidate NAME] [--no-boost] [--from ISO --to ISO]
 *   bun run scripts/lookahead-analysis.ts <manifest.json> --recursive
 *
 * Default window: the manifest's LAST outer-fold OOS test window (protocol-
 * representative, keeps runtime bounded). Exit code 0 = PASS, 1 otherwise.
 *
 * --recursive (Freqtrade `recursive-analysis` spirit): tabulates how the
 * FINAL value of each indicator varies with warm-up length (20/40/80/150/
 * 300/600 bars) against a full-history benchmark, per universe symbol.
 * Answers "how much history does live need before indicators converge" and
 * detects backtest↔live divergence from recursive/smoothed indicators.
 */

import {
  candidateToReplayConfig,
  generateFolds,
  loadManifest,
  resolveAsOf,
  defaultReplayRunner,
  type ExperimentManifest,
  type ReplayRunner,
} from "./walk-forward";
import { loadBars, type ReplayConfig, type ReplayResult } from "./backtest-momentum-wf";
import { rsi2, sma } from "../src/strategies/meanrev/MeanRevEngine";
import { rollingSharpe, trailPctFromVol } from "../src/strategies/momentum/MomentumEngine";
import { Database } from "bun:sqlite";

// ── prefix comparison ─────────────────────────────────────────────────

/** Terminal-liquidation reasons: artifacts of the window EDGE, not signals —
 *  the truncated run liquidates AT the cut, the baseline doesn't. */
const EDGE_REASONS = new Set(["fold_end", "end"]);

export interface TradeMismatch {
  index: number;
  field: string;
  baseline: string;
  truncated: string;
  /** Baseline event time (when known) — drives edge-window classification. */
  baselineT?: number;
  /** True when the truncated run simply lacks the event (vs a different value). */
  truncatedAbsent?: boolean;
}

export interface EquityMismatch {
  t: number;
  baselineEq: number | null;
  truncatedEq: number | null;
}

export interface PrefixComparison {
  comparedTrades: number;
  comparedEquityPoints: number;
  tradeMismatches: TradeMismatch[];
  equityMismatches: EquityMismatch[];
  /** Strict pass: zero mismatches of any kind. */
  pass: boolean;
  /**
   * True when every mismatch is a MISSING-tail artifact of the truncation
   * mechanics rather than a divergent value: the truncated run lacks an
   * event the baseline has, and that event sits within `edgeToleranceMs`
   * of the cut. Only relevant for RTH momentum (a session-final tick can
   * be decidable in the baseline — next ref bar is tomorrow — but not in
   * the truncated run, whose data ends at the cut). Divergent VALUES are
   * never edge-classified.
   */
  edgeOnly: boolean;
}

const MAX_REPORTED = 5;

function prefixTrades(r: ReplayResult, cutMs: number) {
  return r.closedTrades.filter(t => t.exitAt < cutMs && !EDGE_REASONS.has(t.reason));
}

function prefixEquity(r: ReplayResult, cutMs: number) {
  return r.equityHistory.filter(p => p.t < cutMs);
}

function relDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Compare the truncated run's full event stream against the baseline's
 * prefix strictly before `cutMs`. Exact match required on trade identity
 * (symbol/side/reason/exitAt) and equity timestamps; pnl/equity compare
 * within `tolRel` (identical code on identical data is bit-identical — the
 * tolerance only absorbs printable-float round-trips, default 1e-9).
 */
export function comparePrefix(
  baseline: ReplayResult,
  truncated: ReplayResult,
  cutMs: number,
  tolRel = 1e-9,
  edgeToleranceMs = 0,
): PrefixComparison {
  const tradeMismatches: TradeMismatch[] = [];
  const equityMismatches: EquityMismatch[] = [];

  const bt = prefixTrades(baseline, cutMs);
  const tt = prefixTrades(truncated, cutMs);
  const n = Math.max(bt.length, tt.length);
  for (let i = 0; i < n && tradeMismatches.length < MAX_REPORTED; i++) {
    const a = bt[i];
    const b = tt[i];
    if (!a || !b) {
      tradeMismatches.push({
        index: i,
        field: "presence",
        baseline: a ? `${a.symbol} ${a.side} ${a.reason} @${new Date(a.exitAt).toISOString()}` : "<absent>",
        truncated: b ? `${b.symbol} ${b.side} ${b.reason} @${new Date(b.exitAt).toISOString()}` : "<absent>",
        baselineT: a?.exitAt,
        truncatedAbsent: !b,
      });
      continue;
    }
    for (const field of ["symbol", "side", "reason", "exitAt"] as const) {
      if (a[field] !== b[field]) {
        tradeMismatches.push({ index: i, field, baseline: String(a[field]), truncated: String(b[field]), baselineT: a.exitAt });
      }
    }
    if (relDiff(a.pnl, b.pnl) > tolRel) {
      tradeMismatches.push({ index: i, field: "pnl", baseline: String(a.pnl), truncated: String(b.pnl), baselineT: a.exitAt });
    }
  }

  const be = prefixEquity(baseline, cutMs);
  const te = prefixEquity(truncated, cutMs);
  const m = Math.max(be.length, te.length);
  for (let i = 0; i < m && equityMismatches.length < MAX_REPORTED; i++) {
    const a = be[i];
    const b = te[i];
    if (!a || !b || a.t !== b.t) {
      equityMismatches.push({ t: a?.t ?? b!.t, baselineEq: a?.eq ?? null, truncatedEq: b?.eq ?? null });
      continue;
    }
    if (relDiff(a.eq, b.eq) > tolRel) {
      equityMismatches.push({ t: a.t, baselineEq: a.eq, truncatedEq: b.eq });
    }
  }

  const pass = tradeMismatches.length === 0 && equityMismatches.length === 0;
  const edgeOnly = !pass && edgeToleranceMs > 0 &&
    tradeMismatches.every(mm =>
      mm.field === "presence" && mm.truncatedAbsent === true &&
      mm.baselineT !== undefined && mm.baselineT >= cutMs - edgeToleranceMs) &&
    equityMismatches.every(em => em.truncatedEq === null && em.t >= cutMs - edgeToleranceMs);

  return {
    comparedTrades: Math.min(bt.length, tt.length),
    comparedEquityPoints: Math.min(be.length, te.length),
    tradeMismatches,
    equityMismatches,
    pass,
    edgeOnly,
  };
}

// ── cut selection ─────────────────────────────────────────────────────

/**
 * Cut points: 1 minute after sampled baseline trade exits (evenly spread),
 * so the sampled trade is the LAST compared event and the truncated series
 * ends as tightly as the fill model allows (see header limit #2). Skips
 * exits in the first `minSpanFrac` of the window (a truncated run needs a
 * meaningful prefix) and exits whose cut would reach past the window end.
 */
export const CUT_EPSILON_MS = 60_000;

export function chooseCuts(
  baseline: ReplayResult,
  opts: { maxCuts: number; fromMs: number; toMs: number; minSpanFrac?: number },
): number[] {
  const minSpan = opts.fromMs + (opts.toMs - opts.fromMs) * (opts.minSpanFrac ?? 0.2);
  const exits = [...new Set(
    baseline.closedTrades
      // liquidation cascades are margin-model edge noise — poor cut anchors.
      .filter(t => !EDGE_REASONS.has(t.reason) && t.reason !== "liquidation")
      .map(t => t.exitAt)
      .filter(e => e >= minSpan && e + CUT_EPSILON_MS < opts.toMs),
  )].sort((a, b) => a - b);
  if (exits.length === 0 || opts.maxCuts <= 0) return [];
  const k = Math.min(opts.maxCuts, exits.length);
  const cuts = new Set<number>();
  for (let i = 0; i < k; i++) {
    const idx = k === 1 ? exits.length - 1 : Math.round((i * (exits.length - 1)) / (k - 1));
    cuts.add(exits[idx] + CUT_EPSILON_MS);
  }
  return [...cuts].sort((a, b) => a - b);
}

// ── capital boost (Freqtrade "unlimited stake" parity) ────────────────

export function boostConfig(cfg: ReplayConfig): ReplayConfig {
  if (cfg.sleeve === "meanrev") {
    if (!cfg.meanrev) throw new Error("meanrev config without meanrev params");
    return {
      ...cfg,
      initialEquity: cfg.initialEquity * 100,
      meanrev: { ...cfg.meanrev, maxPositions: cfg.universe.length },
    };
  }
  return {
    ...cfg,
    initialEquity: cfg.initialEquity * 100,
    leverage: Math.max(cfg.leverage, 100),
  };
}

// ── analysis driver ───────────────────────────────────────────────────

export interface CutResult {
  cutIso: string;
  comparison: PrefixComparison;
}

export interface LookaheadReport {
  sleeve: string;
  candidateName: string;
  window: { from: string; to: string };
  boosted: boolean;
  deterministic: boolean;
  baselineTrades: number;
  cuts: CutResult[];
  verdict: "PASS" | "FAIL" | "NONDETERMINISTIC" | "NO_TRADES";
}

/** Bit-level identity of two runs of the same config (determinism gate). */
export function sameRun(a: ReplayResult, b: ReplayResult): boolean {
  return (
    a.finalEquity === b.finalEquity &&
    a.fees === b.fees &&
    a.funding === b.funding &&
    JSON.stringify(a.closedTrades) === JSON.stringify(b.closedTrades) &&
    JSON.stringify(a.equityHistory) === JSON.stringify(b.equityHistory)
  );
}

export async function analyzeLookahead(
  m: ExperimentManifest,
  opts: {
    candidateName?: string;
    from?: string;
    to?: string;
    maxCuts?: number;
    boost?: boolean;
    runner?: ReplayRunner;
    log?: (line: string) => void;
  } = {},
): Promise<LookaheadReport> {
  const log = opts.log ?? console.log;
  const runner = opts.runner ?? defaultReplayRunner;
  const boost = opts.boost ?? true;
  const candidate = opts.candidateName
    ? m.candidates.find(c => c.name === opts.candidateName)
    : m.candidates[0];
  if (!candidate) throw new Error(`candidate not found: ${opts.candidateName}`);

  let from = opts.from;
  let to = opts.to;
  if (!from || !to) {
    // Default: the last outer-fold OOS test window (protocol-representative).
    const asOfMs = resolveAsOf(m);
    const folds = generateFolds(m.window, asOfMs);
    const test = folds[folds.length - 1].test;
    from = from ?? new Date(test.fromMs).toISOString();
    to = to ?? new Date(test.toMs).toISOString();
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);

  let cfg = candidateToReplayConfig(m, candidate, "base");
  if (boost) cfg = boostConfig(cfg);

  const win = { label: "lookahead-baseline", from, to };
  log(`▌ lookahead-analysis: ${m.name} / ${candidate.name} (${m.sleeve})${boost ? " [capital boosted]" : ""}`);
  log(`   window: ${from} → ${to}`);

  const baseline = await runner(cfg, win);
  const rerun = await runner(cfg, win);
  if (!baseline || !rerun) throw new Error("baseline replay returned null (no data in window)");

  const report: LookaheadReport = {
    sleeve: m.sleeve,
    candidateName: candidate.name,
    window: { from, to },
    boosted: boost,
    deterministic: sameRun(baseline, rerun),
    baselineTrades: prefixTrades(baseline, toMs).length,
    cuts: [],
    verdict: "PASS",
  };

  if (!report.deterministic) {
    report.verdict = "NONDETERMINISTIC";
    log("   ✗ NONDETERMINISTIC: two identical baseline runs differ — truncation results would be unattributable.");
    return report;
  }
  log(`   determinism check: OK (double-run bit-identical); baseline trades: ${report.baselineTrades}`);

  if (report.baselineTrades === 0) {
    report.verdict = "NO_TRADES";
    log("   ✗ NO_TRADES: baseline fired no signals — nothing to verify (fail-closed; widen the window).");
    return report;
  }

  // RTH momentum only: a session-final tick can be decidable in the baseline
  // (its next ref bar is tomorrow, still < toMs) but not in the truncated
  // run (data ends at the cut) — a truncation-mechanics artifact, not bias.
  // Missing-tail-only mismatches inside this window are INCONCLUSIVE_EDGE,
  // never silently ok; divergent values always FAIL. 90min covers the
  // RTH_SPARSE_TOLERANCE ref-gap allowance.
  const edgeToleranceMs = m.sleeve !== "meanrev" && cfg.rthOnly
    ? (cfg.cadenceMin + 90) * 60_000
    : 0;

  const cuts = chooseCuts(baseline, { maxCuts: opts.maxCuts ?? 8, fromMs, toMs });
  for (const cut of cuts) {
    const cutIso = new Date(cut).toISOString();
    const truncated = await runner(cfg, { label: `lookahead-cut`, from, to: cutIso });
    if (!truncated) throw new Error(`truncated replay returned null at ${cutIso}`);
    const comparison = comparePrefix(baseline, truncated, cut, 1e-9, edgeToleranceMs);
    report.cuts.push({ cutIso, comparison });
    const status = comparison.pass ? "ok" : comparison.edgeOnly ? "INCONCLUSIVE_EDGE (missing-tail only, inside edge window)" : "DIVERGED";
    log(`   cut ${cutIso}: ${comparison.comparedTrades} trades, ${comparison.comparedEquityPoints} equity marks compared — ${status}`);
    if (!comparison.pass && !comparison.edgeOnly) {
      for (const tm of comparison.tradeMismatches) {
        log(`      trade[${tm.index}].${tm.field}: baseline=${tm.baseline} truncated=${tm.truncated}`);
      }
      for (const em of comparison.equityMismatches) {
        log(`      equity@${new Date(em.t).toISOString()}: baseline=${em.baselineEq} truncated=${em.truncatedEq}`);
      }
    }
  }

  report.verdict = report.cuts.every(c => c.comparison.pass || c.comparison.edgeOnly) ? "PASS" : "FAIL";
  return report;
}

// ── recursive-analysis (warm-up variance) ─────────────────────────────

export interface WarmupVarianceRow {
  indicator: string;
  warmupBars: number;
  /** Mean |deviation| % of the indicator's final value vs full history, across symbols. */
  meanAbsDevPct: number;
  maxAbsDevPct: number;
  symbols: number;
}

/**
 * For each warm-up length, compute `fn` over only the last N closes and
 * compare its final value against `fn` over the full history. Windowed
 * indicators converge to exactly 0 once warmup ≥ window; recursive/smoothed
 * indicators never fully converge — the table shows how much history live
 * needs before backtest↔live divergence is negligible.
 */
export function warmupVariance(
  closesBySymbol: Map<string, number[]>,
  warmups: number[],
  indicator: string,
  fn: (closes: number[]) => number,
): WarmupVarianceRow[] {
  const rows: WarmupVarianceRow[] = [];
  for (const w of warmups) {
    const devs: number[] = [];
    for (const closes of closesBySymbol.values()) {
      if (closes.length < 3) continue;
      const bench = fn(closes);
      const v = fn(closes.slice(-Math.min(w, closes.length)));
      if (!Number.isFinite(bench) || !Number.isFinite(v)) continue;
      devs.push(Math.abs(v - bench) / Math.max(Math.abs(bench), 1e-12) * 100);
    }
    rows.push({
      indicator,
      warmupBars: w,
      meanAbsDevPct: devs.length ? devs.reduce((s, x) => s + x, 0) / devs.length : NaN,
      maxAbsDevPct: devs.length ? Math.max(...devs) : NaN,
      symbols: devs.length,
    });
  }
  return rows;
}

export const DEFAULT_WARMUPS = [20, 40, 80, 150, 300, 600];

function runRecursiveAnalysis(m: ExperimentManifest): void {
  const asOfMs = resolveAsOf(m);
  const db = new Database(m.data.dbPath, { readonly: true });
  const closesBySymbol = new Map<string, number[]>();
  try {
    for (const sym of m.data.universe) {
      const bars = loadBars(sym, m.data.timeframe, m.data.source, m.data.rthOnly, 0, asOfMs, db);
      if (bars.length > 3) closesBySymbol.set(sym, bars.slice(-1200).map(b => b.close));
    }
  } finally {
    db.close();
  }
  const barsPerDay = (24 * 60) / m.data.barMinutesEq;
  const tsmLookbackBars = Math.floor((14 * 24 * 60) / m.data.barMinutesEq);
  const tsmMaBars = Math.floor((30 * 24 * 60) / m.data.barMinutesEq);
  // Fallback mirrors the volScaled stop-sizing sweep's daily-bar lookback
  // floor — lookbackBars < 2 would degenerate trailPctFromVol to a constant
  // maxPct and make the row trivially 0.
  const trailCfg = m.candidates[0]?.tsmTrail ?? { kSigma: 3, lookbackBars: Math.max(20, Math.round(barsPerDay)), minPct: 2, maxPct: 8 };

  const indicators: Array<[string, (cs: number[]) => number]> = [
    ["rsi2 (window 3)", cs => rsi2(cs, cs.length - 1)],
    ["sma5 (window 5)", cs => sma(cs, cs.length - 1, 5)],
    ["sma200 (window 200)", cs => sma(cs, cs.length - 1, 200)],
    [`trailPctFromVol k${trailCfg.kSigma}/lb${trailCfg.lookbackBars}`, cs => trailPctFromVol(cs, trailCfg, barsPerDay)],
    ["rollingSharpe 30d", cs => rollingSharpe(cs, 30, barsPerDay) ?? NaN],
    // Inline replicas of the TSM bar math (TimeSeriesMomentum.rank) for
    // warm-up sizing only — the class itself is not exported.
    [`tsmLookbackReturn ${tsmLookbackBars}bars`, cs =>
      cs.length > tsmLookbackBars ? (cs[cs.length - 1] - cs[cs.length - 1 - tsmLookbackBars]) / cs[cs.length - 1 - tsmLookbackBars] : NaN],
    [`tsmMA ${tsmMaBars}bars`, cs => sma(cs, cs.length - 1, tsmMaBars)],
  ];

  console.log(`▌ recursive-analysis: ${m.name} — final-value deviation % vs full history (${closesBySymbol.size} symbols, ≤1200 bars each)`);
  console.log(`   0.0000% at warmup W ⇒ W bars of live history are sufficient for that indicator.`);
  const header = ["indicator".padEnd(38), ...DEFAULT_WARMUPS.map(w => `w=${w}`.padStart(10))].join(" ");
  console.log(`   ${header}`);
  for (const [name, fn] of indicators) {
    const rows = warmupVariance(closesBySymbol, DEFAULT_WARMUPS, name, fn);
    const cells = rows.map(r => (Number.isFinite(r.meanAbsDevPct) ? `${r.meanAbsDevPct.toFixed(4)}%` : "n/a").padStart(10));
    console.log(`   ${name.padEnd(38)} ${cells.join(" ")}`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────

function cliArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const manifestPath = process.argv.slice(2).find(a => a.endsWith(".json"));
  if (!manifestPath) {
    console.error("Usage: bun run scripts/lookahead-analysis.ts <manifest.json> [--cuts N] [--candidate NAME] [--no-boost] [--from ISO --to ISO] [--recursive]");
    process.exit(2);
  }
  const m = loadManifest(manifestPath);

  if (process.argv.includes("--recursive")) {
    runRecursiveAnalysis(m);
    return;
  }

  const report = await analyzeLookahead(m, {
    candidateName: cliArg("--candidate"),
    from: cliArg("--from"),
    to: cliArg("--to"),
    maxCuts: cliArg("--cuts") ? parseInt(cliArg("--cuts")!, 10) : undefined,
    boost: !process.argv.includes("--no-boost"),
  });

  console.log(`\n▌ VERDICT ${m.sleeve}: ${report.verdict}` +
    (report.verdict === "PASS" ? ` (${report.cuts.length} cuts, ${report.baselineTrades} baseline trades, no prefix divergence)` : ""));
  if (report.verdict !== "PASS") process.exit(1);
}

if (import.meta.main) await main();
