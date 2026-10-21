/**
 * Combined-portfolio daily returns from the 4 authoritative pure-chain
 * artifacts (src/portfolio/scorecard.ts sleeveExpectationArtifacts), weighted
 * by their live capital allocation — used by the new research lines' common
 * criterion 5 (docs/reports/V-plan-volumen-rentabilidad.md §12): "correlación
 * diaria del OOS con la cartera actual combinada (las 4 cadenas autoritativas
 * con pesos de capital) <= 0.30".
 *
 * Each artifact's summary.json strips `dailyReturns` from every stored
 * result (scripts/walk-forward.ts writeOutputs/compactResult — only
 * aggregates survive there); runs.jsonl keeps the full per-trial
 * ReplayResult, including dailyReturns. This module re-reads the OUTER TEST
 * (base cost tier) trials named by summary.json's `outerTests[].foldPath`
 * and concatenates their dailyReturns in fold order — exactly the series
 * `stitchedOos` was computed from, just not persisted verbatim.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PortfolioArtifactWeight {
  dir: string;
  initialEquity: number;
}

export interface DailyReturnPoint {
  date: string;
  ret: number;
}

/** Daily-bar momentum replays label a session by its end, one day late. */
export function dailyReturnShiftDays(config: { timeframe?: unknown; meanrev?: unknown; portfolio?: unknown } | undefined): number {
  return config?.timeframe === "1d" && config.meanrev === undefined && config.portfolio === undefined ? -1 : 0;
}

export function shiftDailyReturnDate(date: string, days: number): string {
  if (days === 0) return date;
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Outer-test (base cost, non-overlapping, fold-ordered) daily returns of one artifact. */
export function loadArtifactOuterDailyReturns(dir: string): DailyReturnPoint[] {
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  const foldPaths: string[] = summary.outerTests.map((t: { foldPath: string }) => t.foldPath);
  const selected = new Map<string, string | undefined>(summary.outerTests.map((t: { foldPath: string; result?: { hash?: string } }) => [t.foldPath, t.result?.hash]));
  for (const s of summary.outerSelection ?? []) selected.set(s.foldPath, s.candidateHash);
  const runLines = readFileSync(join(dir, "runs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l));
  const byFold = new Map<string, any>();
  for (const r of runLines) {
    if (r.costTier === "base" && r.status === "complete" && foldPaths.includes(r.foldPath)
      && (!selected.get(r.foldPath) || selected.get(r.foldPath) === (r.candidateHash ?? r.result?.hash))) {
      byFold.set(r.foldPath, r);
    }
  }
  const out: DailyReturnPoint[] = [];
  for (const fp of foldPaths) {
    const r = byFold.get(fp);
    if (!r) throw new Error(`missing complete base-cost outer-test run for foldPath "${fp}" in ${dir}`);
    const shiftDays = dailyReturnShiftDays(r.result.config);
    for (const d of r.result.dailyReturns as DailyReturnPoint[]) {
      out.push({ ...d, date: shiftDailyReturnDate(d.date, shiftDays) });
    }
  }
  return out;
}

/**
 * Capital-weighted sum of the per-artifact daily-return series, keyed by
 * date string. A date missing from an artifact's series (e.g. a stock
 * trading day vs a 24/7 crypto calendar day) contributes 0 from that
 * artifact for that date — the combined series is still defined wherever
 * ANY artifact traded that date.
 */
export function combinedWeightedDailyReturns(weights: PortfolioArtifactWeight[]): Map<string, number> {
  const totalEquity = weights.reduce((s, w) => s + w.initialEquity, 0);
  if (!(totalEquity > 0)) throw new Error("combinedWeightedDailyReturns: total initialEquity must be positive");
  const combined = new Map<string, number>();
  for (const w of weights) {
    const weight = w.initialEquity / totalEquity;
    for (const { date, ret } of loadArtifactOuterDailyReturns(w.dir)) {
      combined.set(date, (combined.get(date) ?? 0) + weight * ret);
    }
  }
  return combined;
}

/** Pearson correlation of two equal-length arrays; null if n<2 or a series is constant. */
export function pearsonCorrelation(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 2 || n !== b.length) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  if (saa < 1e-18 || sbb < 1e-18) return null;
  return sab / Math.sqrt(saa * sbb);
}

/** Inner-join two date->return maps on their common dates, sorted ascending. */
export function alignSeries(a: Map<string, number>, b: Map<string, number>): { dates: string[]; a: number[]; b: number[] } {
  const dates = [...a.keys()].filter(d => b.has(d)).sort();
  return { dates, a: dates.map(d => a.get(d)!), b: dates.map(d => b.get(d)!) };
}
