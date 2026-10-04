#!/usr/bin/env bun
/**
 * Research companion to the walk-forward protocol (2026-08-06): per-candidate
 * OUTER-FOLD diagnostic — every candidate of a manifest replayed over the SAME
 * outer test folds the protocol judged its selected candidate on (base costs,
 * per-candidate chronological RiskGuard chain, NO selection). This reproduces
 * the "per-candidate diagnostic over the same outer folds, all candidates
 * reported" figures quoted in experiments/historical-hypothesis-ledger-v1.json
 * for the v1 stop-sizing sweeps (which were computed ad hoc and never
 * committed) — now committed so v2 comparisons are reproducible.
 *
 * IMPORTANT: this is a DIAGNOSTIC, not the protocol. It exists to compare
 * candidates on an axis (e.g. "is fixed-4% still the worst stop?"); it cannot
 * approve anything. Approval remains exclusively the walk-forward run's.
 *
 * Usage: bun run scripts/research-stop-axis-diagnostic.ts experiments/<manifest>.json
 * Artifact: data/backtests/<sha256> (kind: research-stop-axis-diagnostic-v1).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  candidateToReplayConfig,
  canonicalJson,
  defaultReplayRunner,
  generateFolds,
  periodsPerYear,
  resolveAsOf,
  stitchEquityHistory,
  stitchedMetrics,
  validateCandidate,
  type ExperimentManifest,
} from "./walk-forward";
import { hashReplayConfig, type ReplayResult } from "./backtest-momentum-wf";
import type { RiskState } from "../src/strategies/momentum/RiskGuard";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("usage: research-stop-axis-diagnostic.ts <manifest.json>");
const m = JSON.parse(readFileSync(manifestPath, "utf8")) as ExperimentManifest;
for (const c of m.candidates) validateCandidate(c);

async function main() {
  const asOfMs = resolveAsOf(m);
  const folds = generateFolds(m.window, asOfMs);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  console.log(`▌ Per-candidate outer-fold diagnostic — ${m.name} (asOf ${new Date(asOfMs).toISOString()})`);
  console.log(`  outer folds: ${folds.map(f => `${f.path}:[${iso(f.test.fromMs)}..${iso(f.test.toMs)})`).join("  ")}`);

  const rows: Array<Record<string, unknown>> = [];
  for (const c of m.candidates) {
    const results: ReplayResult[] = [];
    let chain: RiskState | undefined;
    for (const outer of folds) {
      const cfg = candidateToReplayConfig(m, c, "base");
      const win = { label: outer.test.path, from: new Date(outer.test.fromMs).toISOString(), to: new Date(outer.test.toMs).toISOString() };
      const r = await defaultReplayRunner(cfg, win, chain);
      if (!r) throw new Error(`null replay for ${c.name} fold ${outer.path}`);
      chain = r.finalRiskState;
      results.push(r);
    }
    const stitched = stitchEquityHistory(results, m.ledger.initialEquity);
    const metrics = stitchedMetrics(stitched, results, periodsPerYear(m.sleeve));
    const stopCloses = results.flatMap(r => r.closedTrades).filter(t => /stop/i.test(t.reason)).length;
    const row = {
      candidate: c.name,
      candidateHash: hashReplayConfig(candidateToReplayConfig(m, c, "base")).slice(0, 12),
      foldReturnsPct: results.map(r => Math.round(r.totalReturn * 10000) / 100),
      stitchedReturnPct: Math.round(metrics.totalReturn * 10000) / 100,
      sharpe: Math.round(metrics.sharpe * 1000) / 1000,
      maxDrawdownPct: Math.round(metrics.maxDrawdown * 10000) / 100,
      trades: metrics.trades,
      winRatePct: Math.round(metrics.winRate * 1000) / 10,
      expectancy: Math.round(metrics.expectancy * 100) / 100,
      stopCloses,
    };
    rows.push(row);
    console.log(
      `  ${c.name.padEnd(22)} ret ${String(row.stitchedReturnPct).padStart(7)}% | sharpe ${String(row.sharpe).padStart(6)} | DD ${String(row.maxDrawdownPct).padStart(6)}% | ` +
      `tr ${String(row.trades).padStart(5)} | WR ${String(row.winRatePct).padStart(5)}% | exp ${String(row.expectancy).padStart(7)} | stops ${row.stopCloses} | folds [${(row.foldReturnsPct as number[]).join(", ")}]`,
    );
  }

  const body = {
    kind: "research-stop-axis-diagnostic-v1",
    generatedAt: new Date().toISOString(),
    manifest: manifestPath,
    manifestName: m.name,
    asOfMs,
    outerFolds: folds.map(f => ({ path: f.test.path, fromMs: f.test.fromMs, toMs: f.test.toMs })),
    note: "Diagnostic only (no selection, base costs, per-candidate chained RiskGuard). Not a protocol run; approves nothing.",
    candidates: rows,
  };
  const hash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  const path = `data/backtests/${hash}`;
  writeFileSync(path, JSON.stringify(body, null, 2));
  console.log(`  artifact: ${path}`);
}

if (import.meta.main) await main();
