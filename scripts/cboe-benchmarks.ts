#!/usr/bin/env bun
/**
 * Descriptive statistics of Cboe's option-strategy benchmark indexes, from their free daily
 * history (cdn.cboe.com). A diagnostic, not a trial: no strategy of ours is run, nothing is
 * chosen or wired. Read by docs/reports/OP-personalidades-y-opciones-2026-11-08.md.
 *
 *   WPUT  sell a one-week at-the-money SPX put every week, T-bill collateral
 *   PUT   the same with one-month puts       BXM   buy-write (long SPX, short one-month calls)
 *   CNDR  monthly iron condor (defined risk) BFLY  monthly iron butterfly (defined risk)
 *   PPUT  long SPX plus 5 % out-of-the-money puts                  SPX   price only, no dividends
 *
 * "WPUT kx" sells k times the puts against the same collateral: k·(r − rf) + rf per day, with a
 * declared approximation of the 3-month T-bill by calendar year (RF below). Like
 * scripts/leverage-frontier.ts it ignores margin calls and assumes the levered seller survives.
 * The leverage is rebalanced DAILY, so its worst 5-session windows are an optimistic bound for a
 * weekly put-writer that does not rebalance. "worst 5 sessions" is a rolling 5-session window,
 * not a calendar week.
 *
 * Usage: bun run scripts/cboe-benchmarks.ts
 */

const INDEXES = ["SPX", "WPUT", "PUT", "BXM", "CNDR", "BFLY", "PPUT"] as const;
type IndexName = (typeof INDEXES)[number];

// Approximate 3-month T-bill yield (%) by year; only the levered rows use it.
const RF: Record<string, number> = {
  2006: 4.7, 2007: 4.4, 2008: 1.4, 2009: 0.15, 2010: 0.14, 2011: 0.05, 2012: 0.09, 2013: 0.06,
  2014: 0.03, 2015: 0.05, 2016: 0.32, 2017: 0.93, 2018: 1.94, 2019: 2.06, 2020: 0.37, 2021: 0.05,
  2022: 2.02, 2023: 5.07, 2024: 4.97, 2025: 4.1, 2026: 3.7,
};

async function history(name: IndexName): Promise<Map<string, number>> {
  const res = await fetch(`https://cdn.cboe.com/api/global/us_indices/daily_prices/${name}_History.csv`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const out = new Map<string, number>();
  for (const line of (await res.text()).trim().split("\n").slice(1)) {
    const cols = line.split(",");
    const [mm, dd, yyyy] = cols[0].split("/");
    const close = Number(cols[cols.length === 2 ? 1 : 4]);
    if (Number.isFinite(close) && close > 0) out.set(`${yyyy}-${mm}-${dd}`, close);
  }
  return out;
}

interface DailyReturn { day: string; r: number }

function returns(levels: Map<string, number>, days: readonly string[], k = 1): DailyReturn[] {
  const out: DailyReturn[] = [];
  for (let i = 1; i < days.length; i++) {
    const a = levels.get(days[i - 1]), b = levels.get(days[i]);
    if (!a || !b) continue;
    const r = b / a - 1;
    const rf = (RF[days[i].slice(0, 4)] ?? 2) / 100 / 252;
    out.push({ day: days[i], r: k === 1 ? r : k * (r - rf) + rf });
  }
  return out;
}

function stats(all: readonly DailyReturn[], from: string, to: string) {
  const x = all.filter(p => p.day >= from && p.day <= to);
  let equity = 1, peak = 1, maxDd = 0, maxDdDay = "";
  for (const p of x) {
    equity *= 1 + p.r;
    peak = Math.max(peak, equity);
    if (1 - equity / peak > maxDd) { maxDd = 1 - equity / peak; maxDdDay = p.day; }
  }
  const cagr = equity ** (252 / x.length) - 1;
  const mean = x.reduce((s, p) => s + p.r, 0) / x.length;
  const vol = Math.sqrt(x.reduce((s, p) => s + (p.r - mean) ** 2, 0) / (x.length - 1) * 252);
  let worst5 = 0;
  for (let i = 4; i < x.length; i++) {
    let w = 1;
    for (let j = i - 4; j <= i; j++) w *= 1 + x[j].r;
    worst5 = Math.min(worst5, w - 1);
  }
  return { cagr, vol, maxDd, maxDdDay, worst5 };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

if (import.meta.main) {
  const levels = Object.fromEntries(await Promise.all(INDEXES.map(async n => [n, await history(n)] as const))) as Record<IndexName, Map<string, number>>;
  const days = [...levels.WPUT.keys()].filter(d => levels.SPX.has(d)).sort();
  const rows: [string, DailyReturn[]][] = [
    ...INDEXES.map(n => [n, returns(levels[n], days)] as [string, DailyReturn[]]),
    ["WPUT 2x", returns(levels.WPUT, days, 2)],
    ["WPUT 3x", returns(levels.WPUT, days, 3)],
  ];
  const last = days[days.length - 1];
  for (const [from, label] of [["2006-02-01", `2006 → ${last}`], ["2019-01-01", `2019 → ${last} (after Bondarenko's 2006–2018 study)`]]) {
    console.log(`\n${label}`);
    for (const [name, rs] of rows) {
      const s = stats(rs, from, last);
      console.log(`  ${name.padEnd(8)} CAGR ${pct(s.cagr).padStart(6)} | vol ${pct(s.vol).padStart(6)} | max DD ${pct(s.maxDd).padStart(6)} (${s.maxDdDay}) | worst 5 sessions ${pct(s.worst5)}`);
    }
  }
  console.log("\nyear   SPX(price)   WPUT  WPUT 3x");
  const byYear = (rs: DailyReturn[], y: number) => pct(rs.filter(p => p.day.startsWith(String(y))).reduce((e, p) => e * (1 + p.r), 1) - 1).padStart(7);
  for (let y = 2007; y <= Number(last.slice(0, 4)); y++) {
    console.log(`${y}  ${byYear(rows[0][1], y)}  ${byYear(rows[1][1], y)}  ${byYear(rows[8][1], y)}`);
  }
}
