#!/usr/bin/env bun
/**
 * Line A driver: runs the project's nested walk-forward protocol
 * (scripts/walk-forward.ts runWalkForward — folds, inner DSR selection,
 * stress chain, LOO, break-even curve, PSR evidence, summary schema) with
 * the cross-sectional long/short kernel (scripts/crypto-xsls-replay.ts)
 * injected as the ReplayRunner, then evaluates the §12 pre-registered
 * criteria that the manifest's acceptance gates cannot express:
 *
 *   5. daily OOS correlation vs the CURRENT combined portfolio (the 4
 *      authoritative chains, capital-weighted) ≤ 0.30;
 *   7a. no calendar year contributes > 50% of OOS P&L;
 *   7b. Sharpe ≥ 0.5 after removing the top-decile symbols by gross P&L
 *       (same per-fold selected candidates, no reselection);
 *   8. executed orders/day of the OOS (reported, no minimum).
 *
 * Everything is written to data/backtests/<manifestHash>/lineA-criteria.json
 * next to the protocol's own summary.json. Nothing here is wired live.
 *
 * Usage: bun scripts/crypto-xsls-wf.ts experiments/crypto-xsls-v1.json [--dry-run] [--no-breakeven]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  candidateToReplayConfig,
  DEFAULT_CODE_FILES,
  loadManifest,
  periodsPerYear,
  runWalkForward,
  stitchEquityHistory,
  stitchedMetrics,
  type ExperimentManifest,
  type WalkForwardSummary,
  type ReplayRunner,
} from "./walk-forward";
import type { ReplayResult } from "./backtest-momentum-wf";
import { runXslsReplay, type XslsReplayResult, type XslsSignal } from "./crypto-xsls-replay";

/** The 4 authoritative OOS chains (V plan §4/§12) with their live capital
 *  allocations (riskProfiles initialEquity: 50k/50k/5k/5k). */
const AUTHORITATIVE_CHAINS = [
  { name: "momentum_stocks", hash: "5f03d68daed8572ebb73d5c283dfd80ec1064d5b47e8afb9c1f871d8537f091d", capital: 50_000 },
  { name: "meanrev_stocks", hash: "624d50e930d47ef55e42f16e6537e0e895dec847fb0b709c26b2ecd94ea37db7", capital: 50_000 },
  { name: "momentum_crypto", hash: "06e1a160c3556102aa2fff769f9e4c2a3d27d09a6f3874841286426425faf6e4", capital: 5_000 },
  { name: "momentum_crypto_usdc", hash: "413ffb90cd968bfdfe51f1b1eebc87612f262ce9ecb7d2ca82fd59383a704625", capital: 5_000 },
];

const CODE_FILES = [
  ...DEFAULT_CODE_FILES,
  "scripts/crypto-xsls-replay.ts",
  "scripts/crypto-xsls-wf.ts",
  "scripts/lib/xsls-universe.ts",
].sort();

/** First base outer-test record per foldPath from an artifact's runs.jsonl
 *  (the actual OOS chain — break-even tier reruns are appended AFTER). */
function chainDailyReturns(artifactDir: string): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Set<string>();
  const lines = readFileSync(join(artifactDir, "runs.jsonl"), "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    const rec = JSON.parse(line);
    if (rec.costTier !== "base" || rec.status !== "complete" || !/^\d+\/test$/.test(rec.foldPath)) continue;
    if (seen.has(rec.foldPath)) continue;
    seen.add(rec.foldPath);
    for (const d of rec.result?.dailyReturns ?? []) out.set(d.date, d.ret);
  }
  return out;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/**
 * Manifest-level ranking signal (line F2): an EXTRA top-level manifest key
 * (`"signal": "fundingCarry"`), absent for line A. It flows into
 * manifestIdentity (unknown keys ride the `...rest` spread), so the
 * configHash — and with it the artifact identity — distinguishes a carry
 * manifest from a price-momentum manifest with identical candidates.
 */
function manifestSignal(m: ExperimentManifest): XslsSignal {
  const s = (m as unknown as Record<string, unknown>).signal ?? "priceMomentum";
  if (s !== "priceMomentum" && s !== "fundingCarry") {
    throw new Error(`manifest.signal must be "priceMomentum" or "fundingCarry", got ${JSON.stringify(s)}`);
  }
  return s;
}

async function rerunChainWithUniverse(
  m: ExperimentManifest,
  summary: WalkForwardSummary,
  universe: string[],
  runner?: ReplayRunner,
): Promise<ReplayResult[]> {
  const signal = manifestSignal(m);
  const results: ReplayResult[] = [];
  for (const sel of summary.outerSelection ?? []) {
    const candidate = m.candidates.find(c => c.name === sel.candidateName);
    if (!candidate) throw new Error(`candidate ${sel.candidateName} not in manifest`);
    const outer = summary.outerTests.find(t => t.foldPath === sel.foldPath);
    if (!outer) throw new Error(`outer result ${sel.foldPath} missing`);
    const cfg = candidateToReplayConfig(m, candidate, "base", m.data.dbPath);
    cfg.universe = universe.filter(s => s !== undefined);
    cfg.refSymbol = cfg.universe.includes(cfg.refSymbol) ? cfg.refSymbol : cfg.universe[0];
    const win = {
      label: `${sel.foldPath}/ex-top-decile`,
      from: new Date(outer.result.fromMs).toISOString(),
      to: new Date(outer.result.toMs).toISOString(),
    };
    const r = await (runner ? runner(cfg, win) : runXslsReplay(cfg, win, undefined, { signal }));
    if (!r) throw new Error(`ex-top-decile replay failed at ${sel.foldPath}`);
    results.push(r);
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = args.find(a => a.endsWith(".json"));
  if (!manifestPath) {
    console.error("Usage: bun scripts/crypto-xsls-wf.ts <manifest.json> [--dry-run] [--no-breakeven]");
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  const m = loadManifest(manifestPath);
  const signal = manifestSignal(m);
  console.log(`▌ XS-LS walk-forward: ${m.name} (signal ${signal}, ${m.candidates.length} candidates, universe ${m.data.universe.length})`);

  const { summary, outputDir } = await runWalkForward(m, {
    dryRun,
    breakEven: !args.includes("--no-breakeven"),
    runner: (cfg, win, st) => runXslsReplay(cfg, win, st, { signal }),
    codeFiles: CODE_FILES,
  });

  console.log(`\n▌ protocol summary: sharpe=${summary.stitchedOos.sharpe.toFixed(2)} ret=${(summary.stitchedOos.totalReturn * 100).toFixed(1)}% DD=${(summary.stitchedOos.maxDrawdown * 100).toFixed(1)}% trades=${summary.stitchedOos.trades} outerPSR=${summary.outerPsr?.toFixed(3)} approvalReason=${summary.approvalReason}`);
  if (dryRun) return;

  await evaluateXslsCriteria(m, summary, outputDir, manifestPath);
}

/** Shared §12 evaluator. H injects only its runner and output filename;
 * absent options retain A/F2's criterion values and default rerun behavior. */
export async function evaluateXslsCriteria(
  m: ExperimentManifest,
  summary: WalkForwardSummary,
  outputDir: string,
  manifestPath: string,
  opts?: { runner?: ReplayRunner; criteriaFile?: string },
) {
  const ppy = periodsPerYear(m.sleeve, m.data.source);

  // ── criterion 5: daily OOS correlation vs current combined portfolio ──
  const myDaily = new Map<string, number>();
  for (const t of summary.outerTests) for (const d of t.result.dailyReturns) myDaily.set(d.date, d.ret);
  const chains = AUTHORITATIVE_CHAINS.map(c => ({ ...c, daily: chainDailyReturns(join("data", "backtests", c.hash)) }));
  const totalCap = AUTHORITATIVE_CHAINS.reduce((s, c) => s + c.capital, 0);
  // dates where my OOS AND all 4 chains have an observation (their common
  // OOS window is weekday-bound by the stock chains — documented in §12 post-pass)
  const commonDates = [...myDaily.keys()].filter(d => chains.every(c => c.daily.has(d))).sort();
  const combined = commonDates.map(d => chains.reduce((s, c) => s + (c.capital / totalCap) * c.daily.get(d)!, 0));
  const mine = commonDates.map(d => myDaily.get(d)!);
  const corrCombined = pearson(mine, combined);
  const corrPerChain = Object.fromEntries(chains.map(c => {
    const dates = [...myDaily.keys()].filter(d => c.daily.has(d)).sort();
    return [c.name, pearson(dates.map(d => myDaily.get(d)!), dates.map(d => c.daily.get(d)!))];
  }));

  // ── criterion 7a: no calendar year > 50% of OOS P&L ──
  const stitched = stitchEquityHistory(summary.outerTests.map(t => t.result), m.ledger.initialEquity);
  const lastEqByYear = new Map<string, number>();
  for (const p of stitched) lastEqByYear.set(new Date(p.t).toISOString().slice(0, 4), p.eq);
  const years = [...lastEqByYear.keys()].sort();
  let prevEq = m.ledger.initialEquity;
  const yearPnl: Record<string, number> = {};
  for (const y of years) {
    yearPnl[y] = lastEqByYear.get(y)! - prevEq;
    prevEq = lastEqByYear.get(y)!;
  }
  const totalPnl = Object.values(yearPnl).reduce((s, x) => s + x, 0);
  const yearShares = Object.fromEntries(years.map(y => [y, totalPnl !== 0 ? yearPnl[y] / totalPnl : NaN]));
  const maxYearShare = Math.max(...Object.values(yearShares));

  // ── criterion 7b: ex-top-decile-by-P&L Sharpe ≥ 0.5 ──
  const pnlBySym = new Map<string, number>();
  for (const t of summary.outerTests) {
    for (const [sym, v] of Object.entries(t.result.tradesBySymbol)) {
      if (v.trades > 0) pnlBySym.set(sym, (pnlBySym.get(sym) ?? 0) + v.grossPnl);
    }
  }
  const rankedSyms = [...pnlBySym.entries()].sort((a, b) => b[1] - a[1]);
  const topDecileCount = Math.max(1, Math.ceil(rankedSyms.length * 0.1));
  const excluded = rankedSyms.slice(0, topDecileCount).map(([sym]) => sym);
  const exUniverse = m.data.universe.filter(s => !excluded.includes(s));
  const exResults = await rerunChainWithUniverse(m, summary, exUniverse, opts?.runner);
  const exStitched = stitchEquityHistory(exResults, m.ledger.initialEquity);
  const exMetrics = stitchedMetrics(exStitched, exResults, ppy);

  // ── criterion 8: executed orders/day of the OOS ──
  let orders = 0;
  let days = 0;
  for (const t of summary.outerTests) {
    orders += (t.result as XslsReplayResult).orders ?? NaN;
    days += (t.result.toMs - t.result.fromMs) / 86_400_000;
  }
  const ordersPerDay = orders / days;

  // ── §12 verdict (criteria 1–7; 8 is report-only) ──
  const g = summary.acceptance;
  const baseCostPerSide = m.costs.base.slippageBps + m.costs.base.commissionBps;
  const criteria = {
    c1_pureChain: {
      pass: summary.skippedFolds.length === 0 && summary.complete && (summary.outerSelection?.length ?? 0) >= 3,
      outerFolds: summary.outerSelection?.length ?? 0,
      skippedFolds: summary.skippedFolds,
      outerSelection: summary.outerSelection,
    },
    c2_sharpeAndPsr: {
      pass: !!(g.minSharpe?.pass && g.minOuterPsr?.pass),
      sharpe: summary.stitchedOos.sharpe,
      minSharpe: g.minSharpe?.threshold,
      outerPsr: summary.outerPsr ?? null,
      minOuterPsr: g.minOuterPsr?.threshold,
    },
    c3_stressSharpe: {
      pass: !!g.stressMinSharpe?.pass,
      stressSharpe: g.stressMinSharpe?.value,
      threshold: g.stressMinSharpe?.threshold,
    },
    c4_breakEven: {
      pass: !!g.minBreakEvenSlippageBps?.pass,
      breakEvenSlippageBps: summary.breakEvenSlippageBps === Infinity ? "Infinity" : summary.breakEvenSlippageBps ?? null,
      thresholdBps: g.minBreakEvenSlippageBps?.threshold,
      note: `threshold = base slippage ${m.costs.base.slippageBps} + 2× base cost/side (2×${baseCostPerSide}) additional`,
    },
    c5_correlation: {
      pass: Number.isFinite(corrCombined) && Math.abs(corrCombined) <= 0.30,
      corrVsCombined: corrCombined,
      commonDays: commonDates.length,
      window: commonDates.length ? [commonDates[0], commonDates[commonDates.length - 1]] : null,
      weights: Object.fromEntries(AUTHORITATIVE_CHAINS.map(c => [c.name, c.capital / totalCap])),
      corrPerChain,
    },
    c6_maxDrawdown: {
      pass: !!g.maxDrawdown?.pass,
      maxDrawdown: summary.stitchedOos.maxDrawdown,
      threshold: g.maxDrawdown?.threshold,
    },
    c7_robustness: {
      pass: maxYearShare <= 0.5 && exMetrics.sharpe >= 0.5,
      yearPnl,
      yearShares,
      maxYearShare,
      exTopDecile: {
        excludedSymbols: excluded,
        sharpe: exMetrics.sharpe,
        totalReturn: exMetrics.totalReturn,
        maxDrawdown: exMetrics.maxDrawdown,
      },
    },
    c8_ordersPerDay: {
      reportOnly: true,
      orders,
      oosDays: Math.round(days),
      ordersPerDay,
      tradesPerDayClosed: summary.stitchedOos.trades / days,
    },
  };
  const verdictPass = [criteria.c1_pureChain, criteria.c2_sharpeAndPsr, criteria.c3_stressSharpe, criteria.c4_breakEven, criteria.c5_correlation, criteria.c6_maxDrawdown, criteria.c7_robustness].every(c => c.pass);
  const out = {
    generatedAt: new Date().toISOString(),
    manifest: manifestPath,
    manifestHash: summary.manifestHash,
    verdict: verdictPass ? "VALIDADO (criterios §12 1-7)" : "REFUTADO (criterios §12 1-7)",
    criteria,
  };
  if (existsSync(outputDir)) {
    writeFileSync(join(outputDir, opts?.criteriaFile ?? "lineA-criteria.json"), JSON.stringify(out, null, 2));
  }
  console.log("\n▌ §12 criteria");
  for (const [key, c] of Object.entries(criteria)) {
    const pass = (c as any).pass;
    console.log(`   ${key}: ${pass === undefined ? "report-only" : pass ? "PASS" : "FAIL"}`);
  }
  console.log(`   corr vs combined: ${corrCombined.toFixed(3)} over ${commonDates.length} common days`);
  console.log(`   orders/day OOS: ${ordersPerDay.toFixed(1)} (${orders} orders / ${Math.round(days)} days)`);
  console.log(`   VERDICT: ${out.verdict}`);
  console.log(`   written: ${outputDir}/${opts?.criteriaFile ?? "lineA-criteria.json"}`);
  return out;
}

if (import.meta.main) await main();
