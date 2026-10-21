#!/usr/bin/env bun
/**
 * RW portfolio engine — protocol driver (docs/reports/RW-reescritura-rentable.md
 * §2–§3). Runs a portfolio manifest (every candidate carries `portfolio`)
 * through the UNMODIFIED nested walk-forward of scripts/walk-forward.ts with
 * the daily simulator of scripts/portfolio-replay.ts as its ReplayRunner, then
 * evaluates the pre-registered criteria C1–C7 (scripts/portfolio-criteria.ts)
 * and writes rw-criteria.json + rw-diagnostics.json into the artifact dir.
 *
 *   bun scripts/portfolio-wf.ts experiments/rw-d1-….json [--dry-run] [--no-breakeven]
 *        [--compare <label>=<data/backtests/hash> …]   # report-only correlations
 *
 * Owner rule (§6): nothing here runs on real data before the director
 * publishes the manifests — the tests use synthetic tapes only.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CODE_FILES, loadManifest, runWalkForward, type ExperimentManifest } from "./walk-forward";
import { coreKernel, makePortfolioRunner, type PortfolioReplayResult } from "./portfolio-replay";
import { evaluatePortfolioCriteria } from "./portfolio-criteria";

/** Code identity of a portfolio artifact: the protocol's default list PLUS
 *  the simulator, the driver, the evaluator, the data views and every pure
 *  module of the core that actually decided. */
export const PORTFOLIO_CODE_FILES = [
  ...DEFAULT_CODE_FILES,
  "scripts/portfolio-replay.ts",
  "scripts/portfolio-wf.ts",
  "scripts/portfolio-criteria.ts",
  "scripts/lib/portfolioData.ts",
  "src/portfolio-engine/types.ts",
  "src/portfolio-engine/index.ts",
  "src/portfolio-engine/signals.ts",
  "src/portfolio-engine/construction.ts",
  "src/portfolio-engine/stops.ts",
  "src/portfolio-engine/orders.ts",
  "src/portfolio-engine/costs.ts",
  "src/portfolio-engine/decide.ts",
].sort();

export function assertPortfolioManifest(m: ExperimentManifest): void {
  if (!m.candidates.every(c => c.portfolio !== undefined)) {
    throw new Error("scripts/portfolio-wf.ts serves portfolio manifests only (every candidate with a `portfolio` block); use `bun run experiment:wf` for momentum/meanrev manifests");
  }
}

export function parseCompare(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--compare") continue;
    const spec = args[i + 1] ?? "";
    const eq = spec.indexOf("=");
    if (eq <= 0) throw new Error(`--compare expects <label>=<artifactDir>, got "${spec}"`);
    out[spec.slice(0, eq)] = spec.slice(eq + 1);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = args.find(a => a.endsWith(".json"));
  if (!manifestPath) {
    console.error("Usage: bun scripts/portfolio-wf.ts <manifest.json> [--dry-run] [--no-breakeven] [--compare label=dir]");
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  const breakEven = !args.includes("--no-breakeven");
  const m = loadManifest(manifestPath);
  assertPortfolioManifest(m);
  const kind = m.candidates[0].portfolio!.strategy.kind;
  console.log(`▌ RW portfolio walk-forward: ${m.name} (${kind}, ${m.candidates.length} candidates)`);
  console.log(`   folds: ${m.window.outerFoldCount} outer × ${m.window.innerFoldCount} inner | asOf ${m.asOf}`);
  if (dryRun) console.log("   DRY RUN — no trials executed");

  const runner = makePortfolioRunner(coreKernel, { assetClasses: m.data.assetClasses });
  const { summary, outputDir } = await runWalkForward(m, { dryRun, runner, breakEven, codeFiles: PORTFOLIO_CODE_FILES });

  console.log("\n▌ SUMMARY");
  console.log(`   selected (last fold): ${summary.selectedCandidate?.name ?? "none"}`);
  const chain = summary.outerSelection ?? [];
  if (new Set(chain.map(c => c.candidateHash)).size > 1) {
    console.log(`   ⚠ MIXED OOS CHAIN: ${chain.map(c => `${c.foldPath}=${c.candidateName}`).join(", ")}`);
  }
  console.log(`   stitched OOS: ret=${(summary.stitchedOos.totalReturn * 100).toFixed(1)}% sharpe=${summary.stitchedOos.sharpe.toFixed(2)} DD=${(summary.stitchedOos.maxDrawdown * 100).toFixed(1)}% episodes=${summary.stitchedOos.trades} PSR=${summary.outerPsr?.toFixed(3) ?? "n/a"} obs=${summary.observations ?? 0}`);
  if (summary.stitchedOos.benchReturn !== undefined) {
    console.log(`   bench (${m.data.refSymbol} B&H, same folds): ret=${(summary.stitchedOos.benchReturn * 100).toFixed(1)}% sharpe=${(summary.stitchedOos.benchSharpe ?? 0).toFixed(2)}`);
  }
  console.log(`   protocol gates: ${summary.approvalReason}`);
  if (dryRun) { console.log("   dry-run: no files written"); return; }

  const diagnostics = summary.outerTests.map(t => ({ foldPath: t.foldPath, ...(t.result as PortfolioReplayResult).portfolioDiagnostics }));
  writeFileSync(join(outputDir, "rw-diagnostics.json"), JSON.stringify({ manifestHash: summary.manifestHash, outerFolds: diagnostics }, null, 2));
  await evaluatePortfolioCriteria(m, summary, outputDir, manifestPath, { compareArtifacts: parseCompare(args) });
  console.log(`   artifacts: ${outputDir}/`);
}

if (import.meta.main) await main();
