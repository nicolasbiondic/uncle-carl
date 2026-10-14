#!/usr/bin/env bun
/** H driver: exact A nested protocol + exact A §12 evaluator, no grid search
 * beyond the four committed candidates. Full LOO; diagnostics OOS-only.
 * bun scripts/crypto-drop-wf.ts experiments/crypto-drop-reversal-v1.json
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CODE_FILES, loadManifest, runWalkForward } from "./walk-forward";
import { evaluateXslsCriteria } from "./crypto-xsls-wf";
import { runDropReplay, type DropReplayResult } from "./crypto-drop-replay";

async function main() {
  const args = process.argv.slice(2);
  const path = args.find(a => a.endsWith(".json"));
  if (!path) throw new Error("Usage: bun scripts/crypto-drop-wf.ts <manifest.json> [--dry-run]");
  const m = loadManifest(path);
  const dryRun = args.includes("--dry-run");
  const { summary, outputDir } = await runWalkForward(m, {
    dryRun, runner: runDropReplay,
    codeFiles: [...DEFAULT_CODE_FILES, "scripts/crypto-xsls-replay.ts", "scripts/crypto-xsls-wf.ts",
      "scripts/crypto-drop-replay.ts", "scripts/crypto-drop-wf.ts", "scripts/lib/xsls-universe.ts"].sort(),
  });
  if (dryRun) return;
  await evaluateXslsCriteria(m, summary, outputDir, path, { runner: runDropReplay, criteriaFile: "lineH-criteria.json" });
  const diagnostics = summary.outerTests.map(t => ({
    foldPath: t.foldPath, ...(t.result as DropReplayResult).dropDiagnostics,
  }));
  const pnlBySymbol: Record<string, { netPnl: number; pricePnl: number; costs: number; funding: number; trades: number }> = {};
  // Actual account-scale P&L: the harness replays each fold at initial capital
  // and stitches multiplicatively. Scale its dollars by preceding OOS equity.
  let scale = 1;
  for (const t of summary.outerTests) {
    for (const [sym, v] of Object.entries(t.result.tradesBySymbol)) {
      const p = pnlBySymbol[sym] ??= { netPnl: 0, pricePnl: 0, costs: 0, funding: 0, trades: 0 };
      // A's grossPnl field is episode NET P&L (the name is historical).
      p.netPnl += scale * v.grossPnl;
      p.pricePnl += scale * (v.grossPnl + v.fees - v.funding);
      p.costs += scale * v.fees;
      p.funding += scale * v.funding;
      p.trades += v.trades;
    }
    scale *= 1 + t.result.totalReturn;
  }
  const rebound = Array.from({ length: 12 }, (_, i) => {
    const points = diagnostics.flatMap(d => d.rebound.filter(r => r.hour === i + 1));
    const count = points.reduce((s, p) => s + p.count, 0);
    return { hour: i + 1, count, mean: count ? points.reduce((s, p) => s + p.sum, 0) / count : null };
  });
  writeFileSync(join(outputDir, "lineH-diagnostics.json"), JSON.stringify({
    manifestHash: summary.manifestHash, diagnostics, rebound,
    pnlBySymbol: Object.fromEntries(Object.entries(pnlBySymbol).sort((a, b) => b[1].netPnl - a[1].netPnl)),
    note: "Rebound = equal-weight raw close return since entry, observed while held only (h=4 has no hours 5-12), fresh bars only. Symbol dollars scaled to stitched account. BTC counts on eligible unheld symbol-hour signals, before funding/capacity/boundary filters.",
  }, null, 2));
  console.log(`H artifacts: ${outputDir}`);
}

if (import.meta.main) await main();
