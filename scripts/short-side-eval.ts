#!/usr/bin/env bun
/**
 * Line S (V §12-quinquies) — criteria evaluation vs the long-only control.
 *
 * Usage:
 *   bun scripts/short-side-eval.ts <S-artifact-dir> <control-artifact-dir> <refSymbol> <timeframe> <source>
 *
 * Writes <S-artifact-dir>/lineS-criteria.json with the 6 pre-registered
 * criteria (same window, same costs — both chains come from the same
 * manifest geometry) plus the pre-declared reports: added orders/day, short
 * P&L by year, time in bear regime, gross-cap short vetoes.
 *
 * Read-only over artifacts + data/historical.db. Nothing wired.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { dailyClosesFromBars, loadBars, type ClosedTrade } from "./backtest-momentum-wf";
import { marketTrendBlocked } from "../src/strategies/momentum/MomentumEngine";

const [sDir, cDir, refSymbol, timeframe, source] = process.argv.slice(2);
if (!sDir || !cDir || !refSymbol || !timeframe || !source) {
  console.error("Usage: bun scripts/short-side-eval.ts <S-dir> <control-dir> <refSymbol> <timeframe> <source>");
  process.exit(1);
}

interface OuterRec {
  foldPath: string;
  fromMs: number;
  toMs: number;
  closedTrades: ClosedTrade[];
  trades: number;
  shortBorrow: number;
  grossCapShortBlocks: number;
}

/** First base outer-test record per foldPath (the actual OOS chain —
 *  break-even tier reruns are appended AFTER in runs.jsonl). */
function outerRecords(dir: string): OuterRec[] {
  const out = new Map<string, OuterRec>();
  for (const line of readFileSync(join(dir, "runs.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line);
    if (rec.costTier !== "base" || rec.status !== "complete" || !/^\d+\/test$/.test(rec.foldPath)) continue;
    if (out.has(rec.foldPath)) continue;
    const r = rec.result;
    out.set(rec.foldPath, {
      foldPath: rec.foldPath,
      fromMs: r.fromMs,
      toMs: r.toMs,
      closedTrades: r.closedTrades ?? [],
      trades: r.trades,
      shortBorrow: r.shortBorrow ?? 0,
      grossCapShortBlocks: r.grossCapShortBlocks ?? 0,
    });
  }
  return [...out.values()].sort((a, b) => a.fromMs - b.fromMs);
}

const sSum = JSON.parse(readFileSync(join(sDir, "summary.json"), "utf8"));
const cSum = JSON.parse(readFileSync(join(cDir, "summary.json"), "utf8"));
const sOuter = outerRecords(sDir);
const cOuter = outerRecords(cDir);

const oosDays = sOuter.reduce((s, r) => s + (r.toMs - r.fromMs), 0) / 86_400_000;

// ── shorts: net P&L (costs, funding and borrow already netted into
// ClosedTrade.pnl by the sim), by year, and counts ──
const shortTrades = sOuter.flatMap(r => r.closedTrades.filter(t => t.side === "sell" && t.reason !== "end"));
const shortPnlTotal = shortTrades.reduce((s, t) => s + t.pnl, 0);
const shortPnlByYear: Record<string, number> = {};
// Per-close-reason attribution (S-bis report): the engine's canonical label
// when present (TRAIL_STOP/TIME_STOP/SLOT_DISPLACED...), else the sim-level
// classification (rebalance = signal/regime exit, stop_loss, fold_end...).
const shortPnlByReason: Record<string, { n: number; pnl: number }> = {};
for (const t of shortTrades) {
  const y = new Date(t.exitAt).toISOString().slice(0, 4);
  shortPnlByYear[y] = (shortPnlByYear[y] ?? 0) + t.pnl;
  const reason = (t as { engineCloseReason?: string }).engineCloseReason ?? t.reason;
  const slot = (shortPnlByReason[reason] ??= { n: 0, pnl: 0 });
  slot.n++;
  slot.pnl += t.pnl;
}
const shortBorrowTotal = sOuter.reduce((s, r) => s + r.shortBorrow, 0);
const grossCapShortBlocks = sOuter.reduce((s, r) => s + r.grossCapShortBlocks, 0);

// ── time in bear regime over the OOS windows (refSymbol daily closes from
// the SAME research DB; verdict per UTC day with closes dayEnd <= day end,
// marketTrendBlocked's exact math) ──
const db = new Database("./data/historical.db", { readonly: true });
let bearDays = 0, totalDays = 0;
try {
  const from = Math.min(...sOuter.map(r => r.fromMs)) - 600 * 86_400_000;
  const to = Math.max(...sOuter.map(r => r.toMs));
  const daily = dailyClosesFromBars(loadBars(refSymbol, timeframe, source, false, from, to, db));
  for (const rec of sOuter) {
    for (let d = Math.ceil(rec.fromMs / 86_400_000) * 86_400_000; d < rec.toMs; d += 86_400_000) {
      // closes of days fully closed at day-start d (strict causality)
      let hi = -1;
      for (let lo = 0, j = daily.dayEndMs.length - 1; lo <= j;) {
        const mid = (lo + j) >> 1;
        if (daily.dayEndMs[mid] <= d) { hi = mid; lo = mid + 1; } else j = mid - 1;
      }
      if (hi < 0) continue;
      const closes = daily.closes.slice(0, hi + 1);
      const verdict = marketTrendBlocked(closes, 200);
      totalDays++;
      if (verdict === true) bearDays++;
    }
  }
} finally {
  db.close();
}

// ── criteria 1-6 (§12-quinquies) ──
const sharpeS = sSum.stitchedOos.sharpe, sharpeC = cSum.stitchedOos.sharpe;
const ddS = sSum.stitchedOos.maxDrawdown, ddC = cSum.stitchedOos.maxDrawdown;
const stressS = sSum.acceptance.stressMinSharpe.value, stressC = cSum.acceptance.stressMinSharpe.value;
const criteria = {
  c1_pureChain: {
    pass: sSum.skippedFolds.length === 0 && sSum.complete && (sSum.outerSelection?.length ?? 0) >= 3,
    outerSelection: sSum.outerSelection,
    skippedFolds: sSum.skippedFolds,
  },
  c2_sharpeVsControl: { pass: sharpeS >= sharpeC, sharpe: sharpeS, control: sharpeC },
  c3_maxDdVsControl: { pass: ddS <= ddC, maxDrawdown: ddS, control: ddC },
  c4_shortNetPnlPositive: {
    pass: shortTrades.length > 0 && shortPnlTotal > 0,
    shortTrades: shortTrades.length,
    shortPnlNetUsd: shortPnlTotal,
    shortPnlByYear,
    shortPnlByReason,
    shortBorrowUsd: shortBorrowTotal,
  },
  c5_stressSharpeVsControl: { pass: stressS >= stressC, stressSharpe: stressS, control: stressC },
  c6_outerPsr: { pass: (sSum.outerPsr ?? 0) >= 0.95, outerPsr: sSum.outerPsr ?? null, threshold: 0.95 },
};
const verdict = Object.values(criteria).every(c => c.pass);

const report = {
  generatedAt: new Date().toISOString(),
  sArtifact: sDir,
  controlArtifact: cDir,
  verdict: verdict ? "VALIDADO (criterios §12-quinquies 1-6)" : "REFUTADO (criterios §12-quinquies 1-6)",
  criteria,
  reported: {
    // entry + exit each count as one executed order; "added" = vs the control
    ordersPerDayAdded: (2 * (sSum.stitchedOos.trades - cSum.stitchedOos.trades)) / oosDays,
    shortOrdersPerDay: (2 * shortTrades.length) / oosDays,
    oosDays: Math.round(oosDays),
    tradesS: sSum.stitchedOos.trades,
    tradesControl: cSum.stitchedOos.trades,
    bearRegime: { refSymbol, bearDays, totalDays, share: totalDays > 0 ? bearDays / totalDays : null },
    grossCapShortBlocks,
    stitched: {
      s: { ret: sSum.stitchedOos.totalReturn, sharpe: sharpeS, maxDd: ddS, psr: sSum.outerPsr, trades: sSum.stitchedOos.trades },
      control: { ret: cSum.stitchedOos.totalReturn, sharpe: sharpeC, maxDd: ddC, psr: cSum.outerPsr, trades: cSum.stitchedOos.trades },
    },
    controlIdentity: { dataHashMatch: sSum.dataHash === cSum.dataHash, sDataHash: sSum.dataHash, controlDataHash: cSum.dataHash },
  },
};
writeFileSync(join(sDir, "lineS-criteria.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict: report.verdict, criteria: Object.fromEntries(Object.entries(criteria).map(([k, v]) => [k, v.pass])), reported: report.reported }, null, 2));
console.log(`written: ${sDir}/lineS-criteria.json`);
