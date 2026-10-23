#!/usr/bin/env bun
/**
 * RW3 (docs/reports/RW-reescritura-rentable.md §10) — "same days" comparison of
 * two walk-forward artifacts: a candidate chain against its control (the
 * live sleeve re-run on the same data snapshot), §8.4 alignment rules.
 *
 *   bun scripts/rw3-compare-artifacts.ts <candidateDir> <controlDir> [--ppy 252|365]
 *
 * Reads the outer-test base-cost daily returns of both artifacts (legacy
 * momentum/meanrev or portfolio-engine, via loadArtifactOuterDailyReturns,
 * which applies the one-day label shift of daily replays), keeps only the
 * COMMON session dates, and prints Sharpe, total return, CAGR and max
 * drawdown of each side on those dates plus the Sharpe difference (R3 of
 * §8.5). Report-only: it writes nothing and counts no trial. For volManaged
 * manifests scripts/portfolio-wf.ts --control already computes R1–R7; this
 * tool covers the momentum-kernel families (c1/c2), whose protocol gates come
 * from their manifest `acceptance` block.
 */
import { loadArtifactOuterDailyReturns } from "./lib/combinedPortfolioReturns";
import { alignedSharpe, seriesOf, type DailySeries } from "./portfolio-criteria";

export interface SameDaysPerformance { sharpe: number; totalReturn: number; cagr: number; maxDrawdown: number; years: number }
export interface SameDaysComparison {
  commonDays: number;
  from: string | undefined;
  to: string | undefined;
  candidate: SameDaysPerformance;
  control: SameDaysPerformance;
  deltaSharpe: number;
}

/** Compound ONLY the supplied dates from unit equity (missing date = 0 return). */
export function performanceOnDates(series: DailySeries, dates: readonly string[], sharpe: number): SameDaysPerformance {
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const d of dates) {
    equity *= 1 + (series.get(d) ?? 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const years = dates.length >= 2 ? (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 31_557_600_000 : 0;
  const cagr = years > 0 && equity > 0 ? Math.pow(equity, 1 / years) - 1 : 0;
  return { sharpe, totalReturn: equity - 1, cagr, maxDrawdown, years };
}

export function compareOnCommonDays(candidate: DailySeries, control: DailySeries, ppy: number): SameDaysComparison {
  const aligned = alignedSharpe(candidate, control, ppy);
  return {
    commonDays: aligned.observations,
    from: aligned.dates[0],
    to: aligned.dates[aligned.dates.length - 1],
    candidate: performanceOnDates(candidate, aligned.dates, aligned.sharpeA),
    control: performanceOnDates(control, aligned.dates, aligned.sharpeB),
    deltaSharpe: aligned.sharpeA - aligned.sharpeB,
  };
}

export function compareArtifacts(candidateDir: string, controlDir: string, ppy: number): SameDaysComparison {
  return compareOnCommonDays(seriesOf(loadArtifactOuterDailyReturns(candidateDir)), seriesOf(loadArtifactOuterDailyReturns(controlDir)), ppy);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirs = args.filter(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--ppy");
  const ppyIdx = args.indexOf("--ppy");
  const ppy = ppyIdx >= 0 ? Number(args[ppyIdx + 1]) : 252;
  if (dirs.length !== 2 || !(ppy === 252 || ppy === 365)) {
    console.error("Usage: bun scripts/rw3-compare-artifacts.ts <candidateDir> <controlDir> [--ppy 252|365]");
    process.exit(1);
  }
  console.log(JSON.stringify(compareArtifacts(dirs[0], dirs[1], ppy), null, 2));
}
