/**
 * RW12 criteria (docs/reports/RW-reescritura-rentable.md §23): more short when the market falls.
 *
 *   bun scripts/rw12-evaluate.ts stocks <candidateDir> --control <dir> --partner <E2 dir> [--json]
 *   bun scripts/rw12-evaluate.ts crypto <candidateDir> --control <dir> --e1 <dir> --e2 <dir> --other-crypto <dir> [--json]
 *
 * Criterion H (stocks: the risk-off hedge with its own cap), common sessions with the control re-run on the same bars:
 *   H1 CAGR > 0; H2 drawdown of the stock account (candidate + E2, $50k each) ≤ 35 %; H3 the cost against the control is
 *   at most 5 points of CAGR; H4 (max per-fold maxGross of the candidate + 1.03) / 2 ≤ 1.9, the live account clip.
 *   All four: wired. Only H3 fails: the owner decides. H1, H2 or H4 fails: not wired.
 * Criterion C (crypto: a Turtle short the five-day cap closes is renewed), common days with the live control:
 *   C1 CAGR ≥ 0; C2 more trades than the control; C3 drawdown of the four-sleeve book ≤ 35 %; C4 CAGR above the control's.
 *   All four: wired. Otherwise the sleeve stays as it is.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadArtifactOuterDailyReturns } from "./lib/combinedPortfolioReturns";
import { seriesOf } from "./portfolio-criteria";
import { compareOnCommonDays } from "./rw3-compare-artifacts";
import { combinedBookDrawdown, RW5_CRYPTO_CRASH_WINDOWS } from "./rw5-crypto-evaluate";
import { RW5_CRASH_WINDOWS, windowDrawdown } from "./rw5-evaluate";
import { outerGross } from "./rw11-evaluate";

export const ACCOUNT_DRAWDOWN_BUDGET = 0.35;
export const H3_MAX_CAGR_COST = 0.05;
export const ACCOUNT_CLIP = 1.9;
/** E2's highest gross in its live artifact (RW §22), the constant the pre-registration fixed for H4. */
export const PARTNER_PEAK_GROSS = 1.03;
const EPS = 1e-12;

type Criterion = { pass: boolean; value: unknown; threshold: string };
const failedOf = (c: Record<string, Criterion>) => Object.entries(c).filter(([, k]) => !k.pass).map(([id]) => id);

export function criterionH(x: { cagr: number; controlCagr: number; accountDrawdown: number; maxGross: number }) {
  const cost = x.controlCagr - x.cagr, peak = (x.maxGross + PARTNER_PEAK_GROSS) / 2;
  const criteria: Record<string, Criterion> = {
    H1_positive: { pass: x.cagr > 0, value: +x.cagr.toFixed(4), threshold: "CAGR > 0" },
    H2_accountDrawdown: { pass: x.accountDrawdown <= ACCOUNT_DRAWDOWN_BUDGET + EPS, value: +x.accountDrawdown.toFixed(4), threshold: "stock account drawdown ≤ 0.35" },
    H3_cost: { pass: cost <= H3_MAX_CAGR_COST + EPS, value: +cost.toFixed(4), threshold: "control CAGR − candidate CAGR ≤ 0.05" },
    H4_executable: { pass: peak <= ACCOUNT_CLIP + EPS, value: +peak.toFixed(3), threshold: "(max gross + 1.03) / 2 ≤ 1.9" },
  };
  const failed = failedOf(criteria);
  const verdict = failed.length === 0 ? "CUMPLE: se cablea"
    : failed.length === 1 && failed[0] === "H3_cost" ? "SOLO FALLA H3: decide el dueño, no se cablea sin él"
    : `FALLA ${failed.join(", ")}: no se cablea`;
  return { criteria, failed, wire: failed.length === 0, verdict };
}

export function criterionC(x: { cagr: number; controlCagr: number; trades: number; controlTrades: number; bookDrawdown: number }) {
  const criteria: Record<string, Criterion> = {
    C1_nonNegative: { pass: x.cagr >= 0, value: +x.cagr.toFixed(4), threshold: "CAGR ≥ 0" },
    C2_moreTrades: { pass: x.trades > x.controlTrades, value: [x.trades, x.controlTrades], threshold: "more trades than the control" },
    C3_book: { pass: x.bookDrawdown <= ACCOUNT_DRAWDOWN_BUDGET + EPS, value: +x.bookDrawdown.toFixed(4), threshold: "four-sleeve book drawdown ≤ 0.35" },
    C4_beatsControl: { pass: x.cagr > x.controlCagr, value: [+x.cagr.toFixed(4), +x.controlCagr.toFixed(4)], threshold: "CAGR above the live control's" },
  };
  const failed = failedOf(criteria);
  return { criteria, failed, wire: failed.length === 0, verdict: failed.length === 0 ? "CUMPLE: se cablea" : `FALLA ${failed.join(", ")}: el sleeve sigue igual` };
}

const summary = (dir: string) => JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
const load = (dir: string) => seriesOf(loadArtifactOuterDailyReturns(dir));
const id8 = (dir: string) => dir.split("/").filter(Boolean).pop()!.slice(0, 8);

/** The hedge leg per outer fold, from rw-diagnostics.json: sessions in risk-off, the hedge's mean weight there, its P&L. */
function hedgeByFold(dir: string, symbol: string) {
  const d = JSON.parse(readFileSync(join(dir, "rw-diagnostics.json"), "utf8"));
  return (d.outerFolds as any[]).map(f => ({
    fold: f.foldPath as string, sessions: f.sessions as number, riskOffDays: f.regimeOverlay?.riskOffDays ?? 0,
    hedgeWeight: +(f.regimeOverlay?.weightsByState?.riskOff?.[symbol] ?? 0).toFixed(4), hedgePnl: Math.round(f.pnlBySymbol?.[symbol] ?? 0),
    avgGross: +Number(f.avgGross).toFixed(3), maxGross: +Number(f.maxGross).toFixed(3),
  }));
}

export function evaluateStocks(dirs: { candidate: string; control: string; partner: string }, hedgeSymbol = "SH") {
  const C = load(dirs.candidate), A = load(dirs.control), E2 = load(dirs.partner);
  const cmp = compareOnCommonDays(C, A, 252);
  const dates = [...C.keys()].filter(d => A.has(d)).sort();
  const account = combinedBookDrawdown([C, E2], [50_000, 50_000]), accountControl = combinedBookDrawdown([A, E2], [50_000, 50_000]);
  const g = outerGross(dirs.candidate), c = cmp.candidate, a = cmp.control;
  const h = criterionH({ cagr: c.cagr, controlCagr: a.cagr, accountDrawdown: account.maxDrawdown, maxGross: g.max });
  // The sessions on which the size of the hedge mattered: the two books differ by more than 1 bp. (After a fold's first
  // risk-off episode the equities differ, so order rounding leaves differences of a few 1e-6 on every later session.)
  const differing = dates.filter(d => Math.abs(C.get(d)! - A.get(d)!) > 1e-4);
  const grow = (s: Map<string, number>) => differing.reduce((eq, d) => eq * (1 + s.get(d)!), 1) - 1;
  return {
    candidate: dirs.candidate, control: dirs.control, partner: dirs.partner, commonDays: cmp.commonDays, from: cmp.from, to: cmp.to,
    ...h,
    reported: {
      cagr: [+c.cagr.toFixed(4), +a.cagr.toFixed(4)], sharpe: [+c.sharpe.toFixed(3), +a.sharpe.toFixed(3)],
      sleeveDrawdown: [+c.maxDrawdown.toFixed(4), +a.maxDrawdown.toFixed(4)],
      accountDrawdown: [+account.maxDrawdown.toFixed(4), +accountControl.maxDrawdown.toFixed(4)],
      accountCagr: [account, accountControl].map(b => +(Math.pow(1 + b.totalReturn, 31_557_600_000 / (Date.parse(b.to) - Date.parse(b.from))) - 1).toFixed(4)),
      gross: { candidate: g, control: outerGross(dirs.control), partner: outerGross(dirs.partner) },
      marginInterest: [summary(dirs.candidate).stitchedOos.marginInterest, summary(dirs.control).stitchedOos.marginInterest].map(v => Math.round(v ?? 0)),
      windows: RW5_CRASH_WINDOWS.map(w => ({ id: w.id,
        candidate: +windowDrawdown(dates, dates.map(d => C.get(d)!), w.from, w.to).maxDrawdown.toFixed(4),
        control: +windowDrawdown(dates, dates.map(d => A.get(d)!), w.from, w.to).maxDrawdown.toFixed(4) })),
      sessionsOver1bpApart: { count: differing.length, candidateReturn: +grow(C).toFixed(4), controlReturn: +grow(A).toFixed(4) },
      hedge: { candidate: hedgeByFold(dirs.candidate, hedgeSymbol), control: hedgeByFold(dirs.control, hedgeSymbol) },
    },
  };
}

export function evaluateCrypto(dirs: { candidate: string; control: string; e1: string; e2: string; otherCrypto: string }) {
  const C = load(dirs.candidate), A = load(dirs.control);
  const cmp = compareOnCommonDays(C, A, 365);
  const dates = [...C.keys()].filter(d => A.has(d)).sort();
  const s = summary(dirs.candidate), sc = summary(dirs.control), c = cmp.candidate, a = cmp.control;
  const others = [load(dirs.e1), load(dirs.e2)], other = load(dirs.otherCrypto);
  const book = combinedBookDrawdown([...others, C, other]), bookControl = combinedBookDrawdown([...others, A, other]);
  const k = criterionC({ cagr: c.cagr, controlCagr: a.cagr, trades: s.stitchedOos.trades, controlTrades: sc.stitchedOos.trades, bookDrawdown: book.maxDrawdown });
  const shorts = (sm: any) => (sm.outerTests as any[]).map(t => {
    const b = t.result.breakoutShortStats ?? { opens: 0, shortDays: 0, exits: {} };
    return { fold: t.foldPath as string, ret: +Number(t.result.totalReturn).toFixed(4), dd: +Number(t.result.maxDrawdown).toFixed(4), opens: b.opens, shortDays: Math.round(b.shortDays), exits: b.exits };
  });
  return {
    candidate: dirs.candidate, control: dirs.control, commonDays: cmp.commonDays, from: cmp.from, to: cmp.to,
    ...k,
    reported: {
      cagr: [+c.cagr.toFixed(4), +a.cagr.toFixed(4)], sharpe: [+c.sharpe.toFixed(3), +a.sharpe.toFixed(3)],
      sleeveDrawdown: [+c.maxDrawdown.toFixed(4), +a.maxDrawdown.toFixed(4)],
      bookDrawdown: [+book.maxDrawdown.toFixed(4), +bookControl.maxDrawdown.toFixed(4)],
      trades: [s.stitchedOos.trades, sc.stitchedOos.trades], fees: [Math.round(s.stitchedOos.fees), Math.round(sc.stitchedOos.fees)],
      funding: [Math.round(s.stitchedOos.funding ?? 0), Math.round(sc.stitchedOos.funding ?? 0)],
      windows: RW5_CRYPTO_CRASH_WINDOWS.map(w => ({ id: w.id,
        candidate: +windowDrawdown(dates, dates.map(d => C.get(d)!), w.from, w.to).maxDrawdown.toFixed(4),
        control: +windowDrawdown(dates, dates.map(d => A.get(d)!), w.from, w.to).maxDrawdown.toFixed(4) })),
      shorts: { candidate: shorts(s), control: shorts(sc) },
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const [kind, candidate] = args;
  const need = (n: string) => { const v = flag(n); if (!v) throw new Error(`missing ${n} <dir>`); return v; };
  if (!candidate || (kind !== "stocks" && kind !== "crypto")) {
    throw new Error("usage: rw12-evaluate.ts stocks <candidateDir> --control <dir> --partner <dir> | crypto <candidateDir> --control <dir> --e1 <dir> --e2 <dir> --other-crypto <dir> [--json]");
  }
  const out = kind === "stocks"
    ? evaluateStocks({ candidate, control: need("--control"), partner: need("--partner") })
    : evaluateCrypto({ candidate, control: need("--control"), e1: need("--e1"), e2: need("--e2"), otherCrypto: need("--other-crypto") });
  if (args.includes("--json")) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  console.log(`${id8(candidate)} vs ${id8(out.control)} on ${out.commonDays} ${kind === "stocks" ? "sessions" : "days"} ${out.from} → ${out.to}`);
  for (const [id, c] of Object.entries(out.criteria)) console.log(`  ${id}: ${c.pass ? "PASS" : "FAIL"} value=${JSON.stringify(c.value)} threshold=${JSON.stringify(c.threshold)}`);
  for (const [key, v] of Object.entries(out.reported)) console.log(`  ${key}: ${JSON.stringify(v)}`);
  console.log(`  VERDICT: ${out.verdict}`);
}
