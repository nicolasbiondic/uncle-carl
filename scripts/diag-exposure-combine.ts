#!/usr/bin/env bun
/**
 * Línea E — §12-E combiner (2026-10-09, docs/reports/LE-exposicion.md).
 *
 * Reads the 16 diag-exposure-*.json chains (4 portfolios × k ∈ {1, 1.25,
 * 1.5, 2}) and evaluates every k-combination under the PRE-REGISTERED
 * selection rule (V-plan Parte 2 §12-E, fixed in master 43576b4 before any
 * chain ran):
 *
 *   max combined log-growth s.t.
 *     - combined OOS maxDD ≤ 20%;
 *     - each portfolio's own stitched maxDD ≤ its manifest acceptance gate;
 *     - Alpaca combined gross cap ≤ 1.8× account equity;
 *     - Binance gross cap ≤ 3× per pool.
 *
 * Combination model (declared): per-sleeve capital is FIXED (owner rule, no
 * reallocation layer), so the combined curve is Σ Cᵢ · Eᵢ(t)/Eᵢ(t₀) —
 * buy-and-hold capital shares, each sleeve compounding internally; missing
 * dates (stock sleeves on weekends/holidays) carry the last close. Stock
 * sleeves' daily buckets are shifted −1 day (daily-bar replay labels the
 * session by its END — the scorecard's shiftDays convention) so all four
 * series share the UTC-date axis. Window = intersection of the four OOS
 * spans. Leverage constraints use the CONFIGURED gross caps (worst case),
 * not the realized gross.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── declared parameters ───────────────────────────────────────────────
/** Capital per portfolio (§13 V-plan): Alpaca $100k assigned 50/50 to the
 *  two stock sleeves (= the manifests' ledgers); Binance USDT pool $4.9k
 *  (all momentum_crypto); USDC sleeve equity ≈ $7.4k (prod's own cap log,
 *  "1× equity ($7394)", 2026-09/10). */
const CAPITAL = { stocks: 50_000, meanrev: 50_000, crypto: 4_900, usdc: 7_400 } as const;
/** Alpaca account equity (§13: patrimonio $108.3k). */
const ALPACA_EQUITY = 108_300;
/** Per-portfolio configured gross cap at k=1 (G headroom already inside). */
const BASE_CAP = { stocks: 1.15, meanrev: 0.966, crypto: 1.725, usdc: 1.15 } as const;
const SHIFT_DAYS = { stocks: -1, meanrev: 0, crypto: 0, usdc: -1 } as const;
const KS = [1.0, 1.25, 1.5, 2.0] as const;
const CHAINS: Record<string, Record<number, string>> = {
  stocks: { 1.0: "momentum-stocks-daily-blend3-pure-v1", 1.25: "momentum-stocks-daily-blend3-k125-exposure-v1", 1.5: "momentum-stocks-daily-blend3-k150-exposure-v1", 2.0: "momentum-stocks-daily-blend3-k200-exposure-v1" },
  meanrev: { 1.0: "meanrev-slot12-pure-v1", 1.25: "meanrev-slot12-k125-exposure-v1", 1.5: "meanrev-slot12-k150-exposure-v1", 2.0: "meanrev-slot12-k200-exposure-v1" },
  usdc: { 1.0: "momentum-crypto-usdc-daily-s5-pure-v1", 1.25: "momentum-crypto-usdc-daily-s5-k125-exposure-v1", 1.5: "momentum-crypto-usdc-daily-s5-k150-exposure-v1", 2.0: "momentum-crypto-usdc-daily-s5-k200-exposure-v1" },
  crypto: { 1.0: "momentum-crypto-2026w-control-pure-v1", 1.25: "momentum-crypto-2026w-k125-exposure-v1", 1.5: "momentum-crypto-2026w-k150-exposure-v1", 2.0: "momentum-crypto-2026w-k200-exposure-v1" },
};
const PORTFOLIOS = Object.keys(CHAINS) as Array<keyof typeof CHAINS & keyof typeof CAPITAL>;

interface Diag {
  manifestName: string;
  stitchedOos: { totalReturn: number; cagr: number | null; sharpe: number; maxDrawdown: number; trades: number; fees: number; funding: number; marginInterest: number };
  outerPsr: number | null;
  maxDrawdownGate: number;
  dailyCloses: Array<{ date: string; eq: number }>;
}

function shiftDate(date: string, days: number): string {
  if (days === 0) return date;
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const diag = new Map<string, Diag>();
for (const p of PORTFOLIOS) for (const k of KS) {
  const path = join("data", "backtests", `diag-exposure-${CHAINS[p][k]}.json`);
  if (!existsSync(path)) { console.error(`missing ${path} — run the chain first`); process.exit(1); }
  diag.set(`${p}|${k}`, JSON.parse(readFileSync(path, "utf8")));
}

// Per-portfolio normalized equity by (shifted) date. Same dates across k by
// construction (same folds) — asserted below.
function seriesFor(p: string, k: number): Map<string, number> {
  const d = diag.get(`${p}|${k}`)!;
  const out = new Map<string, number>();
  const e0 = d.dailyCloses[0].eq;
  for (const { date, eq } of d.dailyCloses) out.set(shiftDate(date, SHIFT_DAYS[p as keyof typeof SHIFT_DAYS]), eq / e0);
  return out;
}
for (const p of PORTFOLIOS) {
  const base = [...seriesFor(p, 1.0).keys()];
  for (const k of KS.slice(1)) {
    const other = [...seriesFor(p, k).keys()];
    if (base[0] !== other[0] || base[base.length - 1] !== other[other.length - 1]) {
      throw new Error(`${p}: k=${k} dates differ from k=1 (${other[0]}..${other[other.length - 1]} vs ${base[0]}..${base[base.length - 1]})`);
    }
  }
}

// Common OOS window (intersection) + daily UTC grid.
const spans = PORTFOLIOS.map(p => { const ds = [...seriesFor(p, 1.0).keys()]; return { from: ds[0], to: ds[ds.length - 1] }; });
const from = spans.map(s => s.from).sort().reverse()[0];
const to = spans.map(s => s.to).sort()[0];
const grid: string[] = [];
for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
  grid.push(new Date(t).toISOString().slice(0, 10));
}

/** Normalized-to-window-start equity on the full grid (carry last). */
function onGrid(p: string, k: number): number[] {
  const s = seriesFor(p, k);
  const out: number[] = [];
  let last: number | null = null;
  // Seed with the last close at or before `from`.
  for (const [d, v] of s) { if (d <= from) last = v; }
  if (last === null) throw new Error(`${p} k=${k}: no close at or before ${from}`);
  const seed = last;
  for (const d of grid) { if (s.has(d)) last = s.get(d)!; out.push(last / seed); }
  return out;
}
const gridSeries = new Map<string, number[]>();
for (const p of PORTFOLIOS) for (const k of KS) gridSeries.set(`${p}|${k}`, onGrid(p, k));

interface Combo {
  k: Record<string, number>;
  logGrowthDaily: number; pctPerDay: number; totalReturn: number; maxDD: number; sharpe: number;
  alpacaGrossCapX: number; binanceUsdtCapX: number; binanceUsdcCapX: number;
  pass: { combinedDD: boolean; gates: boolean; alpaca: boolean; binance: boolean; all: boolean };
}
const combos: Combo[] = [];
for (const kSt of KS) for (const kMr of KS) for (const kCr of KS) for (const kUs of KS) {
  const ks = { stocks: kSt, meanrev: kMr, crypto: kCr, usdc: kUs };
  const curves = PORTFOLIOS.map(p => gridSeries.get(`${p}|${ks[p]}`)!);
  const caps = PORTFOLIOS.map(p => CAPITAL[p]);
  const eq: number[] = grid.map((_, i) => curves.reduce((s, c, j) => s + caps[j] * c[i], 0));
  let peak = eq[0], maxDD = 0;
  const rets: number[] = [];
  for (let i = 1; i < eq.length; i++) {
    rets.push(Math.log(eq[i] / eq[i - 1]));
    peak = Math.max(peak, eq[i]);
    maxDD = Math.max(maxDD, (peak - eq[i]) / peak);
  }
  const g = rets.reduce((s, x) => s + x, 0) / rets.length;
  const mean = g; // log-daily
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const alpacaGross = CAPITAL.stocks * BASE_CAP.stocks * kSt + CAPITAL.meanrev * BASE_CAP.meanrev * kMr;
  const combo: Combo = {
    k: ks,
    logGrowthDaily: g,
    pctPerDay: Math.exp(g) - 1,
    totalReturn: eq[eq.length - 1] / eq[0] - 1,
    maxDD,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    alpacaGrossCapX: alpacaGross / ALPACA_EQUITY,
    binanceUsdtCapX: BASE_CAP.crypto * kCr,
    binanceUsdcCapX: BASE_CAP.usdc * kUs,
    pass: { combinedDD: false, gates: false, alpaca: false, binance: false, all: false },
  };
  combo.pass.combinedDD = maxDD <= 0.20;
  // Per-portfolio gate (§12-E). DECLARED interpretation: momentum_crypto_usdc's
  // AUTHORITATIVE k=1 chain already violates its own maxDD gate (52.6% > 45%
  // — "authoritative, not gate-certified", owner rule keeps it trading), so a
  // literal reading rejects EVERY combination including the live status quo.
  // k=1 is therefore exempt where the authoritative chain itself violates the
  // gate (the owner already accepted that book); any k>1 must meet the gate.
  // `gatesLiteral` keeps the strict reading for the report.
  combo.pass.gates = PORTFOLIOS.every(p => {
    const d = diag.get(`${p}|${ks[p]}`)!;
    if (d.stitchedOos.maxDrawdown <= d.maxDrawdownGate) return true;
    const k1 = diag.get(`${p}|1`)!;
    return ks[p] === 1.0 && k1.stitchedOos.maxDrawdown > k1.maxDrawdownGate;
  });
  (combo as any).gatesLiteral = PORTFOLIOS.every(p => { const d = diag.get(`${p}|${ks[p]}`)!; return d.stitchedOos.maxDrawdown <= d.maxDrawdownGate; });
  combo.pass.alpaca = alpacaGross <= 1.8 * ALPACA_EQUITY;
  combo.pass.binance = combo.binanceUsdtCapX <= 3 && combo.binanceUsdcCapX <= 3;
  combo.pass.all = combo.pass.combinedDD && combo.pass.gates && combo.pass.alpaca && combo.pass.binance;
  combos.push(combo);
}

combos.sort((a, b) => b.logGrowthDaily - a.logGrowthDaily);
const selected = combos.find(c => c.pass.all) ?? null;
// Pareto frontier over ALL combos (maxDD vs log-growth), for the report.
const frontier = combos
  .filter(c => !combos.some(o => o.maxDD < c.maxDD - 1e-12 && o.logGrowthDaily > c.logGrowthDaily + 1e-15))
  .sort((a, b) => a.maxDD - b.maxDD);

const out = { window: { from, to, days: grid.length }, capital: CAPITAL, alpacaEquity: ALPACA_EQUITY, selected, frontier, combos };
writeFileSync(join("data", "backtests", "diag-exposure-combos.json"), JSON.stringify(out, null, 1));
const fmt = (c: Combo) => `k=[st ${c.k.stocks}, mr ${c.k.meanrev}, cr ${c.k.crypto}, us ${c.k.usdc}] g=${(c.pctPerDay * 100).toFixed(4)}%/d DD=${(c.maxDD * 100).toFixed(1)}% shp=${c.sharpe.toFixed(2)} alpaca=${c.alpacaGrossCapX.toFixed(2)}x usdt=${c.binanceUsdtCapX.toFixed(2)}x ${c.pass.all ? "✓" : `✗(${Object.entries(c.pass).filter(([k2, v]) => k2 !== "all" && !v).map(([k2]) => k2).join(",")})`}`;
console.log(`▌ §12-E combinations — window ${from} → ${to} (${grid.length} days)`);
console.log(`  SELECTED: ${selected ? fmt(selected) : "NONE passes all constraints"}`);
console.log(`  top 10 by log-growth:`);
for (const c of combos.slice(0, 10)) console.log(`   ${fmt(c)}`);
console.log(`  frontier (${frontier.length} points) written to data/backtests/diag-exposure-combos.json`);
