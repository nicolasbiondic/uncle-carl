/**
 * RW5 crypto criteria (docs/reports/RW-reescritura-rentable.md §16.6): a crypto sleeve with the
 * own-coin trend exit (`trendExit`) against its live control on their common out-of-sample days.
 *
 *   bun scripts/rw5-crypto-evaluate.ts <candidateDir> --control <dir> --e1 <dir> --e2 <dir>
 *       --other-crypto <dir> [--sizing | --overlay] [--json]
 *
 * --sizing (§16.13, a pure size change): T1–T3 become S1 drawdown ≤ 40 % (the owner's line),
 * S2 Calmar ≥ the control's and S3 Sharpe ≥ the control's − 0.05; T4–T6 stay.
 * --overlay (§16.17, an added return stream): T2 becomes O1 CAGR ≥ the control's + 3 points and
 * O2 drawdown ≤ 40 %; T1 and T3–T6 stay.
 *
 * T1–T3 on the common days of candidate and control (365 days a year, the RW4a arithmetic of
 * rw3-compare-artifacts.ts). T4 and T6 from the summary.json files. T5 on the four-sleeve book
 * (50k E1, 50k E2, 5k this sleeve, 5k the other crypto sleeve's live version) over every date of
 * the overlap of the four series; a sleeve without a return on a date (stocks on weekends and
 * holidays) contributes 0 that day.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadArtifactOuterDailyReturns } from "./lib/combinedPortfolioReturns";
import { seriesOf, type DailySeries } from "./portfolio-criteria";
import { compareOnCommonDays } from "./rw3-compare-artifacts";
import { windowDrawdown } from "./rw5-evaluate";

export const RW5_CRYPTO_CRASH_WINDOWS = [
  { id: "2022_ftx", from: "2022-11-01", to: "2023-01-31" },
  { id: "2024_correction", from: "2024-03-13", to: "2024-09-30" },
  { id: "2025_q1", from: "2025-01-21", to: "2025-05-31" },
  { id: "2025_26_bear", from: "2025-10-06", to: "2026-08-31" },
] as const;
export const RW5_CRYPTO_MIN_WINDOW_DAYS = 20;
const PPY = 365;
const BOOK_CAPITALS = [50_000, 50_000, 5_000, 5_000] as const;

type Criterion = { pass: boolean; value: unknown; threshold: unknown };

/** Four fixed-capital sleeves, each compounding its own capital; missing date = 0 return. */
export function combinedBookDrawdown(series: readonly DailySeries[], capitals: readonly number[] = BOOK_CAPITALS) {
  const firsts = series.map(s => [...s.keys()].sort()[0]);
  const lasts = series.map(s => [...s.keys()].sort().at(-1)!);
  const from = firsts.reduce((a, b) => (a > b ? a : b)), to = lasts.reduce((a, b) => (a < b ? a : b));
  const dates = [...new Set(series.flatMap(s => [...s.keys()]))].filter(d => d >= from && d <= to).sort();
  let eq = [...capitals];
  const start = capitals.reduce((a, b) => a + b, 0);
  let peak = start, maxDrawdown = 0;
  for (const d of dates) {
    eq = eq.map((e, i) => e * (1 + (series[i].get(d) ?? 0)));
    const total = eq.reduce((a, b) => a + b, 0);
    peak = Math.max(peak, total);
    maxDrawdown = Math.max(maxDrawdown, (peak - total) / peak);
  }
  return { days: dates.length, from, to, totalReturn: eq.reduce((a, b) => a + b, 0) / start - 1, maxDrawdown };
}

export function evaluateCrypto(dirs: { candidate: string; control: string; e1: string; e2: string; otherCrypto: string }, opts: { sizing?: boolean; overlay?: boolean } = {}) {
  const load = (d: string) => seriesOf(loadArtifactOuterDailyReturns(d));
  const C = load(dirs.candidate), A = load(dirs.control);
  const cmp = compareOnCommonDays(C, A, PPY);
  if (cmp.commonDays < 365) throw new Error(`only ${cmp.commonDays} common days`);
  const dates = [...C.keys()].filter(d => A.has(d)).sort();
  const calmar = (p: { cagr: number; maxDrawdown: number }) => (p.maxDrawdown > 0 ? p.cagr / p.maxDrawdown : Infinity);
  const windows = RW5_CRYPTO_CRASH_WINDOWS.map(w => {
    const c = windowDrawdown(dates, dates.map(d => C.get(d)!), w.from, w.to);
    const a = windowDrawdown(dates, dates.map(d => A.get(d)!), w.from, w.to);
    return { ...w, days: c.sessions, candidate: c.maxDrawdown, control: a.maxDrawdown };
  });
  const judged = windows.filter(w => w.days >= RW5_CRYPTO_MIN_WINDOW_DAYS);
  const summary = (d: string) => JSON.parse(readFileSync(join(d, "summary.json"), "utf8"));
  const s = summary(dirs.candidate), sc = summary(dirs.control);
  const folds: { psr: number }[] = s.foldPsr ?? [];
  const foldsOk = folds.filter(f => f.psr > 0.5).length;
  const worstLoo = Math.min(...(s.loo ?? []).map((x: { stitchedSharpe: number }) => x.stitchedSharpe));
  const stitchedSharpe: number = s.stitchedOos.sharpe;
  const failedGates = Object.values(s.acceptance ?? {}).filter((g: any) => g.pass === false).map((g: any) => g.gate as string);
  const newlyFailed = failedGates.filter(g => sc.acceptance?.[g]?.pass !== false);
  const book = combinedBookDrawdown([load(dirs.e1), load(dirs.e2), C, load(dirs.otherCrypto)]);
  const c = cmp.candidate, a = cmp.control;
  const T: Record<string, Criterion> = {
    T1_sharpe: { pass: c.sharpe >= a.sharpe, value: [+c.sharpe.toFixed(4), +a.sharpe.toFixed(4)], threshold: "Sharpe ≥ control's, common days" },
    T2_drawdownAndCalmar: { pass: c.maxDrawdown < a.maxDrawdown && calmar(c) >= calmar(a),
      value: { dd: [+c.maxDrawdown.toFixed(4), +a.maxDrawdown.toFixed(4)], calmar: [+calmar(c).toFixed(3), +calmar(a).toFixed(3)] },
      threshold: "lower DD and Calmar ≥ control's" },
    T3_everyCrash: { pass: judged.length === windows.length && judged.every(w => w.candidate <= w.control),
      value: windows.map(w => `${w.id}: ${(w.candidate * 100).toFixed(1)}% vs ${(w.control * 100).toFixed(1)}% (${w.days} d)`),
      threshold: `window DD ≤ control's in every window, ≥ ${RW5_CRYPTO_MIN_WINDOW_DAYS} days each` },
    T4_psr: { pass: s.outerPsr >= 0.95, value: +Number(s.outerPsr).toFixed(4), threshold: 0.95 },
    T4_folds: { pass: folds.length > 0 && foldsOk / folds.length >= 2 / 3, value: folds.map(f => +f.psr.toFixed(3)), threshold: "≥ 2/3 folds with PSR > 0.5" },
    T4_loo: { pass: Number.isFinite(worstLoo) && worstLoo >= 0.6 * stitchedSharpe, value: +(worstLoo / stitchedSharpe).toFixed(3), threshold: "worst LOO ≥ 0.6 × stitched Sharpe" },
    T5_combinedBook: { pass: book.maxDrawdown <= 0.20, value: +book.maxDrawdown.toFixed(4), threshold: 0.20 },
    T6_protocolGates: { pass: newlyFailed.length === 0, value: { failed: failedGates, failedOnlyHere: newlyFailed }, threshold: "no gate fails that the control passes" },
  };
  const K: Record<string, Criterion> = opts.sizing ? {
    S1_ownerLine: { pass: c.maxDrawdown <= 0.40, value: +c.maxDrawdown.toFixed(4), threshold: 0.40 },
    S2_calmar: { pass: calmar(c) >= calmar(a), value: [+calmar(c).toFixed(3), +calmar(a).toFixed(3)], threshold: "Calmar ≥ control's" },
    S3_sharpe: { pass: c.sharpe >= a.sharpe - 0.05, value: [+c.sharpe.toFixed(4), +a.sharpe.toFixed(4)], threshold: "Sharpe ≥ control's − 0.05" },
    ...Object.fromEntries(Object.entries(T).filter(([id]) => !/^T[123]_/.test(id))),
  } : opts.overlay ? {
    O1_moreReturn: { pass: c.cagr >= a.cagr + 0.03, value: +(c.cagr - a.cagr).toFixed(4), threshold: "+0.03 CAGR vs control" },
    O2_ownerLine: { pass: c.maxDrawdown <= 0.40, value: +c.maxDrawdown.toFixed(4), threshold: 0.40 },
    ...Object.fromEntries(Object.entries(T).filter(([id]) => id !== "T2_drawdownAndCalmar")),
  } : T;
  const sumStats = (sm: any) => (sm.outerTests ?? []).reduce((acc: any, t: any) => {
    const x = t.result.trendExitStats;
    return x ? { exits: acc.exits + x.exits, reentries: acc.reentries + x.reentries, orders: acc.orders + x.orders } : acc;
  }, { exits: 0, reentries: 0, orders: 0 });
  const failed = Object.entries(K).filter(([, k]) => !k.pass).map(([id]) => id);
  return {
    candidate: dirs.candidate, control: dirs.control, commonDays: cmp.commonDays, from: cmp.from, to: cmp.to,
    candidateStats: { ...c, calmar: calmar(c) }, controlStats: { ...a, calmar: calmar(a) }, windows, combinedBook: book,
    reported: {
      ownerLine40: c.maxDrawdown <= 0.40,
      trendExitStats: sumStats(s),
      trades: [s.stitchedOos.trades, sc.stitchedOos.trades],
      fees: [s.stitchedOos.fees, sc.stitchedOos.fees],
      turnoverAnnual: [s, sc].map(x => (x.outerTests ?? []).map((t: any) => t.result.turnoverAnnual)),
    },
    criteria: K,
    verdict: failed.length === 0 ? "CUMPLE" : `FALLA: ${failed.join(", ")}`,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const [candidate] = args;
  const control = flag("--control"), e1 = flag("--e1"), e2 = flag("--e2"), otherCrypto = flag("--other-crypto");
  if (!candidate || !control || !e1 || !e2 || !otherCrypto) {
    throw new Error("usage: rw5-crypto-evaluate.ts <candidateDir> --control <dir> --e1 <dir> --e2 <dir> --other-crypto <dir> [--sizing | --overlay] [--json]");
  }
  const out = evaluateCrypto({ candidate, control, e1, e2, otherCrypto }, { sizing: args.includes("--sizing"), overlay: args.includes("--overlay") });
  if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    const c = out.candidateStats, a = out.controlStats;
    console.log(`${candidate.split("/").pop()?.slice(0, 8)} vs ${control.split("/").pop()?.slice(0, 8)} on ${out.commonDays} days ${out.from} → ${out.to}`);
    for (const [id, k] of Object.entries(out.criteria)) console.log(`  ${id}: ${k.pass ? "PASS" : "FAIL"} value=${JSON.stringify(k.value)} threshold=${JSON.stringify(k.threshold)}`);
    console.log(`  CAGR ${(c.cagr * 100).toFixed(1)}% vs ${(a.cagr * 100).toFixed(1)}%; Sharpe ${c.sharpe.toFixed(3)} vs ${a.sharpe.toFixed(3)}; DD ${(c.maxDrawdown * 100).toFixed(1)}% vs ${(a.maxDrawdown * 100).toFixed(1)}%; book DD ${(out.combinedBook.maxDrawdown * 100).toFixed(1)}%`);
    console.log(`  reported: ${JSON.stringify(out.reported)}`);
    console.log(`  VERDICT: ${out.verdict}`);
  }
}
