/**
 * RW5 criteria (docs/reports/RW-reescritura-rentable.md §16.1): a levered book with a
 * market-signal contingency against (A) the current version and (L) the same leverage
 * without the contingency, on their common out-of-sample sessions.
 *
 *   bun scripts/rw5-evaluate.ts <candidateDir> --current <dir> --partner <dir>
 *       [--same-leverage <dir>] [--dd 0.30] [--json]
 *
 * --partner is the OTHER stock sleeve's current version ($50k each) for the account
 * drawdown. R1 and R4–R7 come from the candidate's rw2-criteria.json (portfolio-wf.ts
 * --control). K3/K4 need --same-leverage; without it they are reported as not applicable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadArtifactOuterDailyReturns } from "./lib/combinedPortfolioReturns";

export const RW5_CRASH_WINDOWS = [
  { id: "2020_covid", from: "2020-02-19", to: "2020-06-30" },
  { id: "2022_bear", from: "2022-01-03", to: "2022-12-30" },
  { id: "2025_april", from: "2025-02-19", to: "2025-06-30" },
] as const;
const PPY = 252;

type Series = Map<string, number>;
const toMap = (s: any): Series => s instanceof Map ? s : Array.isArray(s)
  ? new Map(s.map((x: any) => [x.date, x.ret])) : new Map(Object.entries(s));

export function stats(rets: number[]) {
  let eq = 1, peak = 1, dd = 0;
  for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  const n = rets.length, mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const cagr = eq ** (PPY / n) - 1;
  return { days: n, totalReturn: eq - 1, cagr, maxDrawdown: dd, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(PPY) : 0, calmar: dd > 0 ? cagr / dd : Infinity };
}

/** Drawdown inside a window, the peak reset at the window's first session. */
export function windowDrawdown(dates: string[], rets: number[], from: string, to: string): { sessions: number; maxDrawdown: number } {
  let eq = 1, peak = 1, dd = 0, sessions = 0;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < from || dates[i] > to) continue;
    sessions++; eq *= 1 + rets[i]; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
  }
  return { sessions, maxDrawdown: dd };
}

function accountDrawdown(dates: string[], a: Series, b: Series): number {
  let x = 50_000, y = 50_000, peak = 100_000, dd = 0;
  for (const d of dates) { x *= 1 + a.get(d)!; y *= 1 + b.get(d)!; const t = x + y; peak = Math.max(peak, t); dd = Math.max(dd, 1 - t / peak); }
  return dd;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const cand = args[0];
  const current = flag("--current"), partner = flag("--partner"), same = flag("--same-leverage");
  const ddLimit = Number(flag("--dd") ?? 0.30);
  if (!cand || !current || !partner) throw new Error("usage: rw5-evaluate.ts <candidateDir> --current <dir> --partner <dir> [--same-leverage <dir>] [--dd 0.30]");
  const load = async (d: string) => toMap(await loadArtifactOuterDailyReturns(d));
  const C = await load(cand), A = await load(current), P = await load(partner), L = same ? await load(same) : null;
  const dates = [...C.keys()].filter(d => A.has(d) && (!L || L.has(d))).sort();
  if (dates.length < 252) throw new Error(`only ${dates.length} common sessions`);
  const pick = (m: Series) => dates.map(d => m.get(d)!);
  const c = stats(pick(C)), a = stats(pick(A)), l = L ? stats(pick(L)) : null;
  const acctDates = dates.filter(d => P.has(d));
  const acct = accountDrawdown(acctDates, C, P);
  const windows = RW5_CRASH_WINDOWS.map(w => {
    const cw = windowDrawdown(dates, pick(C), w.from, w.to);
    const lw = L ? windowDrawdown(dates, pick(L), w.from, w.to) : null;
    return { ...w, sessions: cw.sessions, candidate: cw.maxDrawdown, sameLeverage: lw?.maxDrawdown ?? null };
  });
  const critPath = join(cand, "rw2-criteria.json");
  const crit = existsSync(critPath) ? JSON.parse(readFileSync(critPath, "utf8")) : null;
  const rItem = (id: string) => {
    const items = crit ? (Array.isArray(crit.criteria) ? crit.criteria : Object.values(crit.criteria ?? {})) : [];
    return (items as any[]).find(x => x.id?.startsWith(id)) ?? null;
  };
  const K: Record<string, { pass: boolean | null; value: unknown; threshold: unknown }> = {
    K1_moreReturn: { pass: c.cagr >= a.cagr + 0.03, value: +(c.cagr - a.cagr).toFixed(4), threshold: "+0.03 CAGR vs current" },
    K2_sleeveDrawdown: { pass: c.maxDrawdown <= ddLimit, value: +c.maxDrawdown.toFixed(4), threshold: ddLimit },
    K2_accountDrawdown: { pass: acct <= ddLimit, value: +acct.toFixed(4), threshold: ddLimit },
    K3_beatsSameLeverage: l ? { pass: c.maxDrawdown < l.maxDrawdown && c.calmar >= l.calmar, value: { dd: [+c.maxDrawdown.toFixed(4), +l.maxDrawdown.toFixed(4)], calmar: [+c.calmar.toFixed(3), +l.calmar.toFixed(3)] }, threshold: "lower DD and Calmar ≥ the same leverage" } : { pass: null, value: "n/a", threshold: "needs --same-leverage" },
    K4_everyCrash: L ? { pass: windows.every(w => w.sessions >= 20 && w.candidate <= (w.sameLeverage as number)), value: windows.map(w => `${w.id}: ${(w.candidate * 100).toFixed(1)}% vs ${((w.sameLeverage as number) * 100).toFixed(1)}% (${w.sessions} s)`), threshold: "window DD ≤ the same leverage's, ≥ 20 sessions each" } : { pass: null, value: windows.map(w => `${w.id}: ${(w.candidate * 100).toFixed(1)}%`), threshold: "needs --same-leverage" },
    K5_R1_psr: { pass: rItem("R1")?.pass ?? null, value: rItem("R1")?.value ?? null, threshold: 0.95 },
    K5_R4_stressSharpe: { pass: rItem("R4")?.pass ?? null, value: rItem("R4")?.value ?? null, threshold: 0.5 },
    K5_R5_yearShare: { pass: rItem("R5")?.pass ?? null, value: rItem("R5")?.value ?? null, threshold: 0.5 },
    K5_R6_exTopDecile: { pass: rItem("R6")?.pass ?? null, value: rItem("R6")?.value ?? null, threshold: 0.3 },
    K5_R7_breakEven: { pass: rItem("R7")?.pass ?? null, value: rItem("R7")?.value ?? null, threshold: 4 },
    K6_sharpeFloor: { pass: c.sharpe >= 0.8 * a.sharpe, value: +c.sharpe.toFixed(3), threshold: +(0.8 * a.sharpe).toFixed(3) },
  };
  const applicable = Object.values(K).filter(k => k.pass !== null);
  const verdict = applicable.every(k => k.pass) && Object.values(K).every(k => k.pass !== false) ? "CUMPLE" : `FALLA: ${Object.entries(K).filter(([, k]) => k.pass === false).map(([id]) => id).join(", ")}`;
  const out = { candidate: cand, commonSessions: dates.length, from: dates[0], to: dates.at(-1), ddLimit, candidateStats: c, current: a, sameLeverage: l, accountDrawdown: acct, windows, criteria: K, verdict };
  if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${cand.split("/").pop()?.slice(0, 8)} on ${dates.length} sessions ${dates[0]} → ${dates.at(-1)}`);
    for (const [id, k] of Object.entries(K)) console.log(`  ${id}: ${k.pass === null ? "n/a" : k.pass ? "PASS" : "FAIL"} value=${JSON.stringify(k.value)} threshold=${JSON.stringify(k.threshold)}`);
    console.log(`  CAGR ${(c.cagr * 100).toFixed(1)}% vs current ${(a.cagr * 100).toFixed(1)}%${l ? ` vs same leverage ${(l.cagr * 100).toFixed(1)}%` : ""}; Sharpe ${c.sharpe.toFixed(2)}; DD ${(c.maxDrawdown * 100).toFixed(1)}%; account DD ${(acct * 100).toFixed(1)}%`);
    console.log(`  VERDICT: ${verdict}`);
  }
}

if (import.meta.main) await main();
