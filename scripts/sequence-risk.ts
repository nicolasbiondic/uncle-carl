#!/usr/bin/env bun
/**
 * Sequence-risk Monte Carlo over an EXISTING walk-forward artifact — no
 * replays are re-run; everything comes from runs.jsonl (Jesse pattern,
 * open-source review 2026-09 proposal 2; scripts/lib/sequenceRisk.ts is the
 * pure layer, also wired into scripts/walk-forward.ts as
 * summary.sequenceRisk + the optional maxSequenceDdP95 /
 * maxObservedDdPercentile acceptance gates for NEW runs).
 *
 * Usage:
 *   bun scripts/sequence-risk.ts <artifactDir> [--paths N] [--block N] [--seed N] [--json]
 *
 * Reads the outer base-tier OOS chain (foldPath "k/test", base costs),
 * stitches it exactly like the protocol does, and reports:
 *   - block bootstrap (10-day blocks) of the stitched daily returns:
 *     p5/p50/p95 of maxDD and of final return;
 *   - closed-trade reshuffle (P&L in close order): p5/p50/p95 of maxDD;
 *   - the percentile of the OBSERVED maxDD inside each distribution
 *     (~1.0 = the realized sequence was anomalously bad).
 */

import { loadArtifact } from "./lib/artifact";
import { computeSequenceRisk, SEQUENCE_RISK_DEFAULTS } from "./lib/sequenceRisk";
import { stitchEquityHistory, stitchedDailyReturns } from "./walk-forward";

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const flagsWithValue = new Set(["--paths", "--block", "--seed"]);
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValue.has(args[i])) { i++; continue; }
    if (args[i].startsWith("--")) continue;
    dir = args[i];
    break;
  }
  if (!dir) {
    console.error("Usage: bun scripts/sequence-risk.ts <artifactDir> [--paths N] [--block N] [--seed N] [--json]");
    process.exit(2);
  }
  const opts = {
    paths: Number(argOf("--paths") ?? SEQUENCE_RISK_DEFAULTS.paths),
    blockSize: Number(argOf("--block") ?? SEQUENCE_RISK_DEFAULTS.blockSize),
    seed: Number(argOf("--seed") ?? SEQUENCE_RISK_DEFAULTS.seed),
  };
  const { manifest, summary, outerResults } = loadArtifact(dir);
  const rthOnly = outerResults[0]?.config?.rthOnly ?? false;
  const stitched = stitchEquityHistory(outerResults, manifest.ledger.initialEquity);
  const dailyRets = stitchedDailyReturns(stitched, rthOnly);
  const pnls = outerResults.flatMap(r => r.closedTrades).sort((a, b) => a.exitAt - b.exitAt).map(t => t.pnl);
  const sr = computeSequenceRisk(dailyRets, pnls, manifest.ledger.initialEquity, opts);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ artifact: summary.manifestHash, name: manifest.name, sequenceRisk: sr }, null, 2));
    return;
  }
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`▌ Sequence risk: ${manifest.name} (${summary.manifestHash.slice(0, 8)})`);
  console.log(`   OOS: ${outerResults.length} outer folds, ${dailyRets.length} daily obs, ${pnls.length} closed trades`);
  if (sr.bootstrap) {
    const b = sr.bootstrap;
    console.log(`   block bootstrap (${b.blockSize}d blocks × ${b.paths} paths, seed ${b.seed}):`);
    console.log(`     maxDD     p5 ${pct(b.maxDrawdown.p5)}  p50 ${pct(b.maxDrawdown.p50)}  p95 ${pct(b.maxDrawdown.p95)}   observed ${pct(b.observedMaxDrawdown)} → percentile ${pct(b.observedMaxDdPercentile)}`);
    console.log(`     final ret p5 ${pct(b.finalReturn.p5)}  p50 ${pct(b.finalReturn.p50)}  p95 ${pct(b.finalReturn.p95)}   observed ${pct(b.observedFinalReturn)}`);
  } else {
    console.log("   block bootstrap: not computable (series too short)");
  }
  if (sr.tradeReshuffle) {
    const r = sr.tradeReshuffle;
    console.log(`   trade reshuffle (${r.trades} trades × ${r.paths} paths, seed ${r.seed}):`);
    console.log(`     maxDD     p5 ${pct(r.maxDrawdown.p5)}  p50 ${pct(r.maxDrawdown.p50)}  p95 ${pct(r.maxDrawdown.p95)}   observed ${pct(r.observedMaxDrawdown)} → percentile ${pct(r.observedMaxDdPercentile)}`);
    console.log(`     final ret ${pct(r.finalReturn)} (permutation-invariant)`);
  } else {
    console.log("   trade reshuffle: not computable (too few closed trades)");
  }
  if (sr.observedMaxDdPercentile !== undefined) {
    const anomalous = sr.observedMaxDdPercentile > 0.975;
    console.log(`   verdict: observed-DD percentile (worst method) = ${pct(sr.observedMaxDdPercentile)} → ${anomalous ? "ANOMALOUS sequence (worse than 97.5% of reorderings)" : "normal sequence"}`);
  }
}

if (import.meta.main) await main();
