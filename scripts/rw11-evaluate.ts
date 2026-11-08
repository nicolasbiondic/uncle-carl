/**
 * RW11 criterion P (docs/reports/RW-reescritura-rentable.md §22): more leverage on
 * momentum_stocks against its live control, on their common out-of-sample sessions.
 *
 *   bun scripts/rw11-evaluate.ts <candidateDir> --control <dir> --partner <E2 dir> [--json]
 *
 * P1 CAGR ≥ control + 2 points (base costs); P2 account drawdown (candidate + partner,
 * $50k each, both compounding their own capital) ≤ 35 %; P3 total return at 5 bps
 * (summary.breakEvenCurve) ≥ the control's at 5 bps; P4 (max per-fold maxGross of the
 * candidate + max per-fold maxGross of the partner) / 2 ≤ 1.9 (the live account clip).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadArtifactOuterDailyReturns } from "./lib/combinedPortfolioReturns";
import { seriesOf } from "./portfolio-criteria";
import { compareOnCommonDays } from "./rw3-compare-artifacts";
import { combinedBookDrawdown } from "./rw5-crypto-evaluate";
import { RW5_CRASH_WINDOWS, windowDrawdown } from "./rw5-evaluate";

const ACCOUNT_CLIP = 1.9;

function summary(dir: string) {
  return JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
}

/** Gross diagnostics of the outer test runs at base cost (mean of avgGross, max of maxGross). */
export function outerGross(dir: string): { avg: number; max: number } {
  const folds = new Set(summary(dir).outerTests.map((t: { foldPath: string }) => t.foldPath));
  let max = 0, sum = 0, n = 0;
  for (const line of readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n")) {
    const r = JSON.parse(line);
    const g = r.result?.portfolioDiagnostics;
    if (r.costTier !== "base" || !folds.has(r.foldPath) || !g) continue;
    max = Math.max(max, g.maxGross); sum += g.avgGross; n++;
  }
  return { avg: n ? sum / n : NaN, max };
}

function returnAt5bps(dir: string): number {
  const p = (summary(dir).breakEvenCurve ?? []).find((x: { slippageBps: number }) => x.slippageBps === 5);
  if (!p) throw new Error(`${dir}: no breakEvenCurve point at 5 bps`);
  return p.totalReturn;
}

export function evaluateRw11(dirs: { candidate: string; control: string; partner: string }) {
  const load = (d: string) => seriesOf(loadArtifactOuterDailyReturns(d));
  const C = load(dirs.candidate), A = load(dirs.control), E2 = load(dirs.partner);
  const cmp = compareOnCommonDays(C, A, 252);
  const dates = [...C.keys()].filter(d => A.has(d)).sort();
  const account = combinedBookDrawdown([C, E2], [50_000, 50_000]);
  const accountControl = combinedBookDrawdown([A, E2], [50_000, 50_000]);
  const g = outerGross(dirs.candidate), gc = outerGross(dirs.control), gp = outerGross(dirs.partner);
  const r5 = returnAt5bps(dirs.candidate), r5c = returnAt5bps(dirs.control);
  const c = cmp.candidate, a = cmp.control;
  const peakAccountGross = (g.max + gp.max) / 2;
  const criteria = {
    P1_cagr: { pass: c.cagr >= a.cagr + 0.02, value: [+c.cagr.toFixed(4), +a.cagr.toFixed(4)], threshold: "CAGR ≥ control + 0.02" },
    P2_accountDrawdown: { pass: account.maxDrawdown <= 0.35, value: +account.maxDrawdown.toFixed(4), threshold: 0.35 },
    P3_return5bps: { pass: r5 >= r5c, value: [+r5.toFixed(4), +r5c.toFixed(4)], threshold: "total return at 5 bps ≥ control's" },
    P4_executable: { pass: peakAccountGross <= ACCOUNT_CLIP, value: +peakAccountGross.toFixed(3), threshold: ACCOUNT_CLIP },
  };
  const failed = Object.entries(criteria).filter(([, k]) => !k.pass).map(([id]) => id);
  return {
    candidate: dirs.candidate, control: dirs.control, commonDays: cmp.commonDays, from: cmp.from, to: cmp.to,
    criteria,
    reported: {
      sharpe: [+c.sharpe.toFixed(3), +a.sharpe.toFixed(3)],
      sleeveDrawdown: [+c.maxDrawdown.toFixed(4), +a.maxDrawdown.toFixed(4)],
      accountDrawdownControl: +accountControl.maxDrawdown.toFixed(4),
      gross: { candidate: g, control: gc, partner: gp },
      marginInterest: [summary(dirs.candidate).stitchedOos.marginInterest, summary(dirs.control).stitchedOos.marginInterest],
      windows: RW5_CRASH_WINDOWS.map(w => ({
        id: w.id,
        candidate: +windowDrawdown(dates, dates.map(d => C.get(d)!), w.from, w.to).maxDrawdown.toFixed(4),
        control: +windowDrawdown(dates, dates.map(d => A.get(d)!), w.from, w.to).maxDrawdown.toFixed(4),
      })),
    },
    verdict: failed.length === 0 ? "CUMPLE" : `FALLA: ${failed.join(", ")}`,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const [candidate] = args;
  const control = flag("--control"), partner = flag("--partner");
  if (!candidate || !control || !partner) throw new Error("usage: rw11-evaluate.ts <candidateDir> --control <dir> --partner <E2 dir> [--json]");
  const out = evaluateRw11({ candidate, control, partner });
  if (args.includes("--json")) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  console.log(`${candidate.split("/").filter(Boolean).pop()?.slice(0, 8)} vs ${control.split("/").filter(Boolean).pop()?.slice(0, 8)} on ${out.commonDays} sessions ${out.from} → ${out.to}`);
  for (const [id, k] of Object.entries(out.criteria)) console.log(`  ${id}: ${k.pass ? "PASS" : "FAIL"} value=${JSON.stringify(k.value)} threshold=${JSON.stringify(k.threshold)}`);
  console.log(`  reported: ${JSON.stringify(out.reported)}`);
  console.log(`  VERDICT: ${out.verdict}`);
}
