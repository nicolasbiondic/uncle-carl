// ══════════════════════════════════════════════
// DSR trial-count sensitivity (2026-09-04)
// ══════════════════════════════════════════════
//
// WHY THIS EXISTS
//
// The protocol deflates every candidate's Sharpe by the number of hypotheses
// ever tried (`trialAccounting.priorUniqueTrials` + this manifest's own
// candidates) and picks the inner-fold winner by median DSR
// (walk-forward.ts: correctedDsr → aggregateInner → selectCandidate).
//
// That number is UNKNOWABLE for the pre-protocol era. The 2026-07 sweeps ran
// from a shell — `--voltarget A,LB,MIN,MAX`, `--exposure 1,1.5,2,3,4` — and the
// invocations were never versioned; only the commit prose survives (see the
// ledger batches with inventoryComplete=false). No amount of archaeology can
// recover them, so `trialAccounting.complete` can never honestly become true
// for anything downstream of that era, and approval stays blocked FOREVER on a
// number nobody can measure.
//
// The way out of an unmeasurable nuisance parameter is not to guess it: it is
// to show the DECISION does not depend on it. DSR is monotone in the trial
// count, so this script re-runs the EXACT selection (same helpers, same daily
// returns from the artifact's runs.jsonl) across trial counts spanning orders
// of magnitude. If the same candidate wins from the declared N up to an absurd
// one, the incompleteness is provably non-binding FOR THAT ARTIFACT.
//
// It changes no verdict by itself: the acceptance gates are computed on the
// OUTER folds of the selected candidate and never read the trial count at all.
// What this answers is strictly "could a bigger N have selected someone else?".
//
// USAGE
//   bun run scripts/dsr-trial-sensitivity.ts <artifactHash> [--candidates N]
//
// Reads data/backtests/<artifactHash>/runs.jsonl (inner folds, base cost tier
// — the same subset the selector consumes).

import { readFileSync } from "fs";
import { join } from "path";
import { deflatedSharpe } from "../src/reports/metrics";
import { aggregateInner, selectCandidate, periodsPerYear } from "./walk-forward";

const DEFAULT_TRIAL_GRID = [
  259, 274, 300, 400, 500, 1_000, 2_500, 5_000, 10_000, 50_000, 200_000, 1_000_000,
];

export interface SensitivityRow {
  priorTrials: number;
  winner: string;
  medianDsrByCandidate: Array<{ name: string; medianDsr: number }>;
}

/** Inner folds are "<outer>/<inner>"; the outer test legs are "<outer>/test". */
export function isInnerFold(foldPath: string): boolean {
  return /^\d+\/\d+$/.test(foldPath);
}

/**
 * Replays the production selection across a grid of prior-trial counts.
 * `runs` are the artifact's runs.jsonl records (already parsed).
 */
export function trialSensitivity(
  runs: any[],
  numCandidates: number,
  sleeve: string,
  grid: number[] = DEFAULT_TRIAL_GRID,
): SensitivityRow[] {
  const tiers = new Set(runs.map(r => r.costTier));
  const inner = runs.filter(r =>
    isInnerFold(r.foldPath) &&
    r.result && Array.isArray(r.result.dailyReturns) &&
    (tiers.size === 1 || r.costTier === "base"),
  );
  if (inner.length === 0) throw new Error("no inner-fold runs with dailyReturns in this artifact");

  const ppy = periodsPerYear(sleeve);
  return grid.map((priorTrials) => {
    const metrics = inner.map(r => ({
      candidateHash: r.candidateHash,
      candidateName: r.candidateName,
      // Mirrors correctedDsr() exactly, including its <30-observations guard.
      dsr: r.result.dailyReturns.length >= 30
        ? deflatedSharpe(r.result.dailyReturns.map((x: any) => x.ret), Math.max(1, priorTrials + numCandidates), ppy)
        : 0,
      sharpe: r.result.sharpe,
      maxDrawdown: r.result.maxDrawdown,
    }));
    const agg = aggregateInner(metrics as any);
    return {
      priorTrials,
      winner: selectCandidate(agg).candidateName,
      medianDsrByCandidate: [...agg]
        .sort((a, b) => b.medianDsr - a.medianDsr)
        .map(a => ({ name: a.candidateName, medianDsr: a.medianDsr })),
    };
  });
}

if (import.meta.main) {
  const hash = process.argv[2];
  if (!hash) {
    console.error("usage: bun run scripts/dsr-trial-sensitivity.ts <artifactHash> [--candidates N]");
    process.exit(1);
  }
  const dir = join(process.cwd(), "data", "backtests", hash);
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  const runs = readFileSync(join(dir, "runs.jsonl"), "utf8")
    .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

  // Count candidate NAMES, not hashes: the selector deflates by
  // `m.candidates.length` (one per manifest entry), while a single candidate
  // can carry several hashes across cost tiers / re-resolutions.
  const flagIdx = process.argv.indexOf("--candidates");
  const numCandidates = flagIdx > 0
    ? Number(process.argv[flagIdx + 1])
    : new Set(runs.map((r: any) => r.candidateName)).size;
  const sleeve = runs.find((r: any) => r.result?.sleeve)?.result.sleeve ?? "crypto";

  console.log(`▌ DSR trial-count sensitivity — ${hash.slice(0, 12)}`);
  console.log(`   selected (as recorded): ${summary.selectedCandidate?.name ?? "?"}`);
  console.log(`   approved: ${summary.approved} — ${summary.approvalReason ?? ""}`);
  console.log(`   candidates: ${numCandidates} | sleeve: ${sleeve} (${periodsPerYear(sleeve)} periods/yr)\n`);

  const rows = trialSensitivity(runs, numCandidates, sleeve);
  console.log("  N_prior | winner            | median DSR by candidate (desc)");
  for (const r of rows) {
    const detail = r.medianDsrByCandidate.map(c => `${c.name}=${c.medianDsr.toFixed(4)}`).join("  ");
    console.log(`  ${String(r.priorTrials).padStart(7)} | ${r.winner.padEnd(17)} | ${detail}`);
  }

  const winners = new Set(rows.map(r => r.winner));
  console.log("");
  if (winners.size === 1) {
    console.log(`✅ INVARIANT: "${[...winners][0]}" wins at every trial count from ${rows[0].priorTrials} to ${rows[rows.length - 1].priorTrials.toLocaleString()}.`);
    console.log("   The unauditable pre-protocol trial count cannot have changed this selection.");
  } else {
    console.log(`⚠️  NOT invariant — the winner changes with the trial count: ${[...winners].join(" → ")}`);
    console.log("   The incompleteness IS binding here: the selection depends on a number nobody can measure.");
  }
}
