/**
 * Read the OUTER OOS base-tier chain out of an existing walk-forward
 * artifact directory (data/backtests/<manifestHash>/) WITHOUT re-running
 * anything. Shared by scripts/sequence-risk.ts and scripts/tearsheet.ts.
 *
 * runs.jsonl holds every trial the run executed: inner selection folds
 * ("k/j"), outer tests ("k/test"), the stress tier, and the break-even
 * curve replays (which also carry costTier "base" but at swept slippage) —
 * so the outer base chain is the subset with foldPath "k/test", costTier
 * "base" AND the manifest's declared base costs (the same filter
 * /tmp combine.ts uses). The tier equal to base slippage is a cache hit on
 * the base trial (same trial id), so no dedupe is needed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplayResult } from "../backtest-momentum-wf";
import type { ExperimentManifest, WalkForwardSummary } from "../walk-forward";

export interface LoadedArtifact {
  manifest: ExperimentManifest;
  summary: WalkForwardSummary;
  /** Outer-test base-tier results, sorted chronologically (fromMs asc). */
  outerResults: ReplayResult[];
}

export function loadArtifact(dir: string): LoadedArtifact {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest-resolved.json"), "utf-8")) as ExperimentManifest;
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf-8")) as WalkForwardSummary;
  const base = manifest.costs.base;
  const outerResults: ReplayResult[] = [];
  const lines = readFileSync(join(dir, "runs.jsonl"), "utf-8").trim().split("\n");
  for (const line of lines) {
    if (!line) continue;
    const t = JSON.parse(line) as { foldPath: string; costTier: string; status: string; result?: ReplayResult };
    if (!/^\d+\/test$/.test(t.foldPath) || t.costTier !== "base") continue;
    if (t.status !== "complete" || !t.result) continue;
    if (t.result.config?.slippageBps !== base.slippageBps || t.result.config?.commissionBps !== base.commissionBps) continue;
    outerResults.push(t.result);
  }
  outerResults.sort((a, b) => a.fromMs - b.fromMs);
  if (outerResults.length === 0) {
    throw new Error(`no outer base-tier results found in ${dir}/runs.jsonl (expected foldPath "k/test", costTier "base" at slippage ${base.slippageBps} / commission ${base.commissionBps} bps)`);
  }
  return { manifest, summary, outerResults };
}
