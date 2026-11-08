/**
 * Leverage frontier of the live book — a DIAGNOSTIC, not a trial
 * (docs/reports/LV-frontera-apalancamiento-2026-11-08.md).
 *
 *   bun scripts/leverage-frontier.ts            # four sleeves, their common OOS days
 *   bun scripts/leverage-frontier.ts --stocks   # the two stock sleeves only (from 2019, includes 2020 and 2022)
 *
 * Scales each live artifact's stitched OOS daily returns by k (costs and funding scale
 * with it), charges 6.5 %/yr on the extra borrowed notional of the stock sleeves
 * ((k − 1) × their average gross), compounds each sleeve on its fixed capital and sums.
 * Optimistic upper bound: ignores margin calls, liquidation, the account's 1.9× clip and
 * the vol target re-sizing a real higher target would do.
 */
import { loadArtifactOuterDailyReturns } from "./lib/combinedPortfolioReturns";

const STOCKS_ONLY = process.argv.includes("--stocks");
const ART: Record<string, string> = {
  e1: "0bb06b9d548647410edacd52f86c9f11ff66307bd11f6e734e379f8a7492d5da",
  e2: "2325210c8c7ad56fbbec9d833f2ae9ef641ed85a25d9af357eb693d43dfbb50f",
  ...(STOCKS_ONLY ? {} : {
    c1: "4aca18035a259fac4bfbba41696c6ee19d750dab1cb8fd3d084e47193e4c0f33",
    c2: "574309447f608d2786889e9d98f41de15f3aac3262b4ca8784b3d3bcee9cb0c4",
  }),
};
const CAP: Record<string, number> = { e1: 50_000, e2: 50_000, c1: 5_000, c2: 5_000 };
const GROSS: Record<string, number> = { e1: 1.6, e2: 1.0 }; // average gross before scaling
const RATE = 0.065;

const sleeves = Object.keys(ART);
const ser: Record<string, Map<string, number>> = {};
for (const s of sleeves) ser[s] = new Map(loadArtifactOuterDailyReturns(`data/backtests/${ART[s]}`).map(p => [p.date, p.ret]));
const from = sleeves.map(s => [...ser[s].keys()].sort()[0]).sort().at(-1)!;
const to = sleeves.map(s => [...ser[s].keys()].sort().at(-1)!).sort()[0];
const dates = [...new Set(sleeves.flatMap(s => [...ser[s].keys()]))].filter(d => d >= from && d <= to).sort();

export function run(k: Record<string, number>) {
  const eq: Record<string, number> = Object.fromEntries(sleeves.map(s => [s, CAP[s]]));
  const start = sleeves.reduce((a, s) => a + CAP[s], 0);
  let peak = 0, dd = 0, prev = "";
  const monthEnd = new Map<string, number>();
  for (const d of dates) {
    const days = prev ? Math.max(1, (Date.parse(d) - Date.parse(prev)) / 864e5) : 1;
    for (const s of sleeves) {
      const fin = s in GROSS ? (k[s] - 1) * GROSS[s] * RATE * days / 365 : 0;
      eq[s] *= Math.max(0, 1 + k[s] * (ser[s].get(d) ?? 0) - fin);
    }
    const tot = sleeves.reduce((a, s) => a + eq[s], 0);
    peak = Math.max(peak, tot); dd = Math.max(dd, 1 - tot / peak);
    monthEnd.set(d.slice(0, 7), tot); prev = d;
  }
  const end = sleeves.reduce((a, s) => a + eq[s], 0);
  const cagr = (end / start) ** (365.25 * 864e5 / (Date.parse(to) - Date.parse(from))) - 1;
  let p = start; const mr = [...monthEnd.values()].map(v => { const r = v / p - 1; p = v; return r; });
  const acctGross = (k.e1 * GROSS.e1 * CAP.e1 + k.e2 * GROSS.e2 * CAP.e2) / (CAP.e1 + CAP.e2);
  return { cagr, monthly: (1 + cagr) ** (1 / 12) - 1, dd, worstMonth: Math.min(...mr), acctGross };
}

if (import.meta.main) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(7);
  console.log(`${STOCKS_ONLY ? "stocks only" : "four sleeves"}: ${from} → ${to}, ${dates.length} dates`);
  const res = [];
  for (const e1 of [1, 1.5, 2, 2.5, 3]) for (const e2 of [1, 2, 3, 4, 6]) for (const c of STOCKS_ONLY ? [1] : [0.5, 1, 2, 3]) {
    res.push({ label: `E1 ${e1}x E2 ${e2}x${STOCKS_ONLY ? "" : ` crypto ${c}x`}`, ...run({ e1, e2, c1: c, c2: c }) });
  }
  const base = res.find(r => r.label.startsWith("E1 1x E2 1x") && (STOCKS_ONLY || r.label.endsWith("crypto 1x")))!;
  const show = (t: string, r: typeof base) => console.log(t.padEnd(22), r.label.padEnd(28), "CAGR", pct(r.cagr), "/month", pct(r.monthly), "DD", pct(r.dd), "worst month", pct(r.worstMonth), "gross", `${r.acctGross.toFixed(2)}x`);
  show("today", base);
  for (const lim of [0.25, 0.35, 0.45, 1]) {
    const b = res.filter(r => r.dd <= lim).sort((a, z) => z.cagr - a.cagr)[0];
    if (b) show(lim < 1 ? `best with DD ≤ ${lim * 100}%` : "best at any DD", b);
  }
}
