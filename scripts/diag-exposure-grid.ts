#!/usr/bin/env bun
/**
 * Línea E — exposure-grid driver (2026-10-09, docs/reports/LE-exposicion.md).
 *
 * Runs a walk-forward manifest exactly like `experiment:wf -- <m>
 * --no-breakeven` and writes data/backtests/diag-exposure-<name>.json with
 * everything the §12-E combiner needs:
 *
 *  - the stitched OOS metrics (identical numbers to summary.json) + CAGR
 *    over the stitched span + total margin interest and funding;
 *  - the DATED daily closes of the stitched OOS equity curve (UTC-day
 *    buckets — all four validated manifests are rthOnly:false, so this is
 *    the exact series stitchedMetrics/PSR judge), from which the combiner
 *    builds date-aligned daily returns;
 *  - the manifest's own maxDrawdown acceptance gate, so the per-portfolio
 *    gate check reads from the artifact instead of a re-typed literal.
 *
 * The outer-test replays are captured in-process via the runner seam (same
 * technique as scripts/diag-gross-cap.ts) and stitched with the SAME
 * stitchEquityHistory the protocol uses.
 *
 * Usage: bun scripts/diag-exposure-grid.ts experiments/<manifest>.json
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultReplayRunner, loadManifest, runWalkForward, stitchEquityHistory, type ExperimentManifest } from "./walk-forward";
import type { ReplayConfig, ReplayResult } from "./backtest-momentum-wf";

const manifestPath = process.argv.slice(2).find(a => a.endsWith(".json")) ?? "";
if (!manifestPath) {
  console.error("Usage: bun scripts/diag-exposure-grid.ts <manifest.json>");
  process.exit(1);
}

const m: ExperimentManifest = loadManifest(manifestPath);
const fullUniverseSize = m.data.universe.length;

// Capture FULL ReplayResults (the artifact compacts equityHistory away).
const captured: Array<{ win: { from: string; to: string }; cfg: ReplayConfig; result: ReplayResult }> = [];
const runner = async (cfg: ReplayConfig, win: { label: string; from: string; to: string }, initialRiskState?: Parameters<typeof defaultReplayRunner>[2]) => {
  const result = await defaultReplayRunner(cfg, win, initialRiskState);
  if (result) captured.push({ win: { from: win.from, to: win.to }, cfg, result });
  return result;
};

const { summary, outputDir } = await runWalkForward(m, { breakEven: false, runner });

// The stitched OOS chain = outer TEST trials at base costs with the full
// declared universe (inner folds differ by window, stress by costs, LOO by
// universe size — same attribution as diag-gross-cap.ts).
const outerTests = (summary as any).outerTests as Array<{ foldPath: string; result: { window: { from: string; to: string } } }>;
const outerWindows = new Set(outerTests.map(t => `${t.result.window.from}|${t.result.window.to}`));
const outerResults = captured
  .filter(c =>
    outerWindows.has(`${c.win.from}|${c.win.to}`)
    && c.cfg.slippageBps === m.costs.base.slippageBps
    && c.cfg.commissionBps === m.costs.base.commissionBps
    && c.cfg.universe.length === fullUniverseSize)
  .map(c => c.result);
if (outerResults.length !== outerTests.length) {
  throw new Error(`matched ${outerResults.length} outer-test replays, expected ${outerTests.length}`);
}

// Stitch exactly like the protocol, then bucket by UTC day keeping the date
// (bucketByDay is module-private; all 4 manifests are rthOnly:false, so the
// UTC-date key below reproduces its buckets — guarded by the assertion that
// our return count matches the summary's observation count).
const history = stitchEquityHistory(outerResults, m.ledger.initialEquity);
const buckets: Array<{ date: string; eq: number }> = [];
for (const pt of history) {
  const date = new Date(pt.t).toISOString().slice(0, 10);
  const cur = buckets[buckets.length - 1];
  if (cur && cur.date === date) cur.eq = pt.eq;
  else buckets.push({ date, eq: pt.eq });
}
const nRets = buckets.length - 1;
if ((summary as any).observations !== undefined && (summary as any).observations !== nRets) {
  throw new Error(`daily-bucket mismatch: ${nRets} returns vs summary.observations ${(summary as any).observations}`);
}

const st = summary.stitchedOos;
const spanMs = Date.parse(outerResults[outerResults.length - 1].window.to) - Date.parse(outerResults[0].window.from);
const years = spanMs / (365.25 * 86_400_000);

const out = {
  manifest: manifestPath,
  manifestName: m.name,
  outputDir,
  resolvedTo: (summary as any).resolvedTo ?? null,
  oosYears: years,
  stitchedOos: {
    totalReturn: st.totalReturn,
    cagr: years > 0 ? Math.pow(1 + st.totalReturn, 1 / years) - 1 : null,
    sharpe: st.sharpe,
    maxDrawdown: st.maxDrawdown,
    trades: st.trades,
    winRate: st.winRate,
    fees: st.fees,
    funding: st.funding,
    marginInterest: st.marginInterest ?? 0,
  },
  outerPsr: (summary as any).outerPsr ?? null,
  maxDrawdownGate: m.acceptance.maxDrawdown,
  dailyCloses: buckets.map(b => ({ date: b.date, eq: Math.round(b.eq * 1e4) / 1e4 })),
};
const outPath = join("data", "backtests", `diag-exposure-${m.name}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`\n▌ EXPOSURE GRID — ${m.name}`);
console.log(`   stitched OOS: ret=${(st.totalReturn * 100).toFixed(1)}% cagr=${((out.stitchedOos.cagr ?? 0) * 100).toFixed(2)}% sharpe=${st.sharpe.toFixed(3)} DD=${(st.maxDrawdown * 100).toFixed(1)}% trades=${st.trades} margin$=${(st.marginInterest ?? 0).toFixed(0)} funding$=${(st.funding ?? 0).toFixed(0)}`);
console.log(`   daily closes: ${buckets.length} (${buckets[0]?.date} → ${buckets[buckets.length - 1]?.date})`);
console.log(`   artifact: ${outputDir}/`);
console.log(`   diag: ${outPath}`);
