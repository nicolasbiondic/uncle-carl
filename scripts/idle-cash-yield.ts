// ══════════════════════════════════════════════════════════════
// idle-cash-yield.ts — S3 research (2026-09-27): what would sweeping the
// IDLE cash of each pure-chain replay into 3-month T-bills have added?
//
// For each live sleeve's authoritative pure chain, this reads the OUTER
// base-cost runs from data/backtests/<hash>/runs.jsonl, reconstructs the
// per-session idle-cash fraction (1 − open notional / equity) from
// closedTrades (entryAt/entryPrice/qty; positions still open at the fold
// boundary appear as reason="fold_end" with exitAt = fold end), and overlays
// a T-bill yield (FRED DTB3, act/360) on the idle fraction of each period.
//
// Outer-base selection: foldPath endsWith "/test", costTier === "base", AND
// result.config costs equal to the manifest's costs.base — runs.jsonl also
// contains the break-even slippage sweep, which is costTier "base" with
// DIFFERENT slippage, and the stress tier.
//
// Session-label caveat: the DAILY momentum replays (momentum_stocks blend3,
// momentum_crypto_usdc daily-s5) stamp each session with its END timestamp
// (one natural day late), so their DTB3 lookup shifts back one day
// (`labelLagDays: 1`). DTB3 moves ~0.01pp/day, so this is hygiene, not
// signal.
//
// Crypto sleeves run on Binance Futures TESTNET, which pays NO yield on
// margin — their rows are INFORMATIVE ONLY (a mainnet USDT/USDC Earn product
// would be the real-world analogue). Alpaca sleeves are the actionable ones.
//
// Usage:
//   bun scripts/idle-cash-yield.ts [--dtb3 data/dtb3-cache.csv]
// The DTB3 CSV is the public FRED export (no key):
//   https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3&cosd=2019-01-01
// Downloaded automatically to data/dtb3-cache.csv when absent.
//
// The arithmetic (idle series, act/360 overlay, CAGR/Sharpe/maxDD) is
// exported pure and locked by scripts/idle-cash-yield.test.ts on a fixture.
// ══════════════════════════════════════════════════════════════

import { existsSync, readFileSync, writeFileSync } from "fs";

// ── Pure data shapes ────────────────────────────────────────────────────────

export interface ReplayTrade {
  entryAt: number;
  exitAt: number;
  entryPrice: number;
  qty: number;
}

export interface EquityPoint {
  t: number;
  eq: number;
}

/** date "YYYY-MM-DD" → annualized T-bill discount rate as a FRACTION (0.0408). */
export type RateLookup = (dateKey: string) => number;

// ── Idle-fraction reconstruction ────────────────────────────────────────────

/**
 * Per-period idle fraction from the replay's own ledger: at each equity
 * point t_i, open notional = Σ qty×entryPrice over trades with
 * entryAt ≤ t_i < exitAt (entry-cost basis — the replay does not expose
 * per-bar marks). Idle = clamp(1 − notional/equity, 0, 1): a levered book
 * (notional > equity, e.g. crypto at 1.5× gross) has NO idle cash and never
 * a negative yield here (borrow cost is out of scope — reported as risk).
 */
export function idleFractionSeries(equityHistory: EquityPoint[], trades: ReplayTrade[]): number[] {
  const out: number[] = new Array(equityHistory.length);
  // Sweep-line: sort events once instead of scanning all trades per point.
  const entries = trades.map(tr => ({ t: tr.entryAt, notional: tr.qty * tr.entryPrice })).sort((a, b) => a.t - b.t);
  const exits = trades.map(tr => ({ t: tr.exitAt, notional: tr.qty * tr.entryPrice })).sort((a, b) => a.t - b.t);
  let ei = 0, xi = 0, open = 0;
  for (let i = 0; i < equityHistory.length; i++) {
    const { t, eq } = equityHistory[i];
    while (ei < entries.length && entries[ei].t <= t) open += entries[ei++].notional;
    while (xi < exits.length && exits[xi].t <= t) open -= exits[xi++].notional;
    out[i] = eq > 0 ? Math.min(1, Math.max(0, 1 - open / eq)) : 0;
  }
  return out;
}

// ── T-bill overlay (act/360) ────────────────────────────────────────────────

export function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Per-period simple returns of `equityHistory`, plus the same returns with
 * idleFrac_i × rate(t_i) × Δdays/360 added (act/360 accrual over the REAL
 * calendar gap, so a weekend earns 3/360). `labelLagDays` shifts the DTB3
 * lookup back for replays that stamp sessions by their END.
 */
export function overlayReturns(
  equityHistory: EquityPoint[],
  idleFrac: number[],
  rate: RateLookup,
  labelLagDays = 0,
): { base: number[]; withYield: number[]; periodMs: number[]; extraCompounded: number } {
  const base: number[] = [];
  const withYield: number[] = [];
  const periodMs: number[] = [];
  let extraAcc = 1;
  for (let i = 0; i + 1 < equityHistory.length; i++) {
    const a = equityHistory[i], b = equityHistory[i + 1];
    if (!(a.eq > 0)) continue;
    const r = b.eq / a.eq - 1;
    const dtDays = (b.t - a.t) / 86_400_000;
    const rateKey = utcDateKey(a.t - labelLagDays * 86_400_000);
    const extra = idleFrac[i] * rate(rateKey) * (dtDays / 360);
    base.push(r);
    withYield.push(r + extra);
    periodMs.push(b.t - a.t);
    extraAcc *= 1 + extra;
  }
  return { base, withYield, periodMs, extraCompounded: extraAcc - 1 };
}

// ── Metrics ────────────────────────────────────────────────────────────────

export interface SeriesMetrics {
  totalReturn: number;
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
  years: number;
  periods: number;
}

/** Compound `returns` over `spanMs` of calendar time. Sharpe annualized by
 *  the observed sampling frequency (periods/year = N / years). */
export function seriesMetrics(returns: number[], spanMs: number): SeriesMetrics {
  const years = spanMs / (365.25 * 86_400_000);
  let eq = 1, peak = 1, maxDD = 0;
  for (const r of returns) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = 1 - eq / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const n = returns.length;
  const mean = n ? returns.reduce((s, r) => s + r, 0) / n : 0;
  const variance = n > 1 ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const periodsPerYear = years > 0 ? n / years : 0;
  return {
    totalReturn: eq - 1,
    cagr: years > 0 ? Math.pow(eq, 1 / years) - 1 : 0,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0,
    maxDrawdown: maxDD,
    years,
    periods: n,
  };
}

// ── DTB3 CSV ───────────────────────────────────────────────────────────────

/** Parses FRED's DTB3 CSV ("observation_date,DTB3"; "." = market holiday)
 *  into a lookup that carries the LAST KNOWN rate forward (holidays,
 *  weekends, dates past the end). Rates come in percent → fraction. */
export function parseDtb3Csv(csv: string): RateLookup {
  const byDate = new Map<string, number>();
  const dates: string[] = [];
  for (const line of csv.trim().split("\n").slice(1)) {
    const [d, v] = line.split(",");
    const num = parseFloat(v);
    if (d && Number.isFinite(num)) {
      byDate.set(d, num / 100);
      dates.push(d);
    }
  }
  if (dates.length === 0) throw new Error("DTB3 csv parsed to zero observations");
  return (dateKey: string): number => {
    const hit = byDate.get(dateKey);
    if (hit !== undefined) return hit;
    // carry-forward: binary search the last date ≤ dateKey
    let lo = 0, hi = dates.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= dateKey) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best >= 0 ? byDate.get(dates[best])! : byDate.get(dates[0])!;
  };
}

// ── Artifact runner (I/O — not covered by the fixture test) ───────────────

interface ChainSpec {
  sleeve: string;
  hash: string;
  manifest: string;
  /** daily momentum replays label a session by its END (one day late). */
  labelLagDays: number;
  /** testnet pays no yield → informational only. */
  actionable: boolean;
  /** prod capital the sleeve trades (for $/yr extrapolation). */
  prodCapitalUsd: number;
}

const CHAINS: ChainSpec[] = [
  { sleeve: "momentum_stocks", hash: "cc2f5d690c316db0e36dfbf657b5809f3a78198573422864e286d99c70f868c3", manifest: "experiments/momentum-stocks-daily-blend3-pure-v1.json", labelLagDays: 1, actionable: true, prodCapitalUsd: 54_000 },
  { sleeve: "meanrev_stocks", hash: "033829729c2841f3c085e7e324c9aec81f6791d9f57d964b95556770f9956be8", manifest: "experiments/meanrev-breadth7-pure-v1.json", labelLagDays: 0, actionable: true, prodCapitalUsd: 53_000 },
  { sleeve: "momentum_crypto", hash: "a510131622444378ceb5ee1a3a4f1967acf5bebab9719ca6c152179ce96a4db3", manifest: "experiments/momentum-crypto-2026w-control-pure-v1.json", labelLagDays: 0, actionable: false, prodCapitalUsd: 5_000 },
  { sleeve: "momentum_crypto_usdc", hash: "752767ae1610f58ab0e236615859d6fb4a789c24e0ec771589ba369be3512694", manifest: "experiments/momentum-crypto-usdc-daily-s5-pure-v1.json", labelLagDays: 1, actionable: false, prodCapitalUsd: 5_000 },
];

const DTB3_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3&cosd=2019-01-01";
const DTB3_CACHE = "data/dtb3-cache.csv";

async function loadDtb3(pathArg?: string): Promise<RateLookup> {
  const path = pathArg ?? DTB3_CACHE;
  if (!existsSync(path)) {
    if (pathArg) throw new Error(`--dtb3 file not found: ${pathArg}`);
    console.error(`Downloading DTB3 from FRED → ${path} ...`);
    const res = await fetch(DTB3_URL);
    if (!res.ok) throw new Error(`FRED download failed: HTTP ${res.status}`);
    writeFileSync(path, await res.text());
  }
  return parseDtb3Csv(readFileSync(path, "utf-8"));
}

interface OuterRun {
  foldPath: string;
  equityHistory: EquityPoint[];
  closedTrades: ReplayTrade[];
}

/** The outer BASE tranche: costTier "base" at exactly the manifest's base
 *  costs (excludes the break-even slippage sweep), first run per fold. */
export function selectOuterBaseRuns(
  runs: { foldPath: string; costTier: string; result: any }[],
  baseCosts: { slippageBps: number; commissionBps?: number },
): OuterRun[] {
  const seen = new Set<string>();
  const out: OuterRun[] = [];
  for (const r of runs) {
    if (!r.foldPath.endsWith("/test") || r.costTier !== "base") continue;
    const c = r.result?.config ?? {};
    if (c.slippageBps !== baseCosts.slippageBps) continue;
    if ((c.commissionBps ?? 0) !== (baseCosts.commissionBps ?? 0)) continue;
    if (seen.has(r.foldPath)) continue;
    seen.add(r.foldPath);
    out.push({ foldPath: r.foldPath, equityHistory: r.result.equityHistory, closedTrades: r.result.closedTrades });
  }
  return out.sort((a, b) => a.foldPath.localeCompare(b.foldPath));
}

function fmtPct(x: number, digits = 2): string {
  return `${(x * 100).toFixed(digits)}%`;
}

async function main() {
  const dtb3Arg = process.argv.includes("--dtb3") ? process.argv[process.argv.indexOf("--dtb3") + 1] : undefined;
  const rate = await loadDtb3(dtb3Arg);

  for (const chain of CHAINS) {
    const dir = `data/backtests/${chain.hash}`;
    const manifest = JSON.parse(readFileSync(`${dir}/manifest-resolved.json`, "utf-8"));
    const runs = readFileSync(`${dir}/runs.jsonl`, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    const outer = selectOuterBaseRuns(runs, manifest.costs.base);
    if (outer.length === 0) throw new Error(`${chain.sleeve}: no outer base runs found in ${dir}`);

    console.log(`\n═══ ${chain.sleeve} — ${chain.hash.slice(0, 8)}… (${chain.manifest})${chain.actionable ? "" : "  [INFORMATIVE: testnet pays no yield]"}`);
    console.log(`    base costs ${JSON.stringify(manifest.costs.base)}, ${outer.length} outer folds, DTB3 label lag ${chain.labelLagDays}d`);

    const allBase: number[] = [];
    const allYield: number[] = [];
    let spanMsTotal = 0;
    let idleWeighted = 0, idleWeight = 0;
    let rateWeighted = 0;

    for (const run of outer) {
      const idle = idleFractionSeries(run.equityHistory, run.closedTrades);
      const o = overlayReturns(run.equityHistory, idle, rate, chain.labelLagDays);
      const spanMs = run.equityHistory[run.equityHistory.length - 1].t - run.equityHistory[0].t;
      const mBase = seriesMetrics(o.base, spanMs);
      const mYield = seriesMetrics(o.withYield, spanMs);
      // time-weighted mean idle fraction + mean rate over the fold
      for (let i = 0; i + 1 < run.equityHistory.length; i++) {
        const w = run.equityHistory[i + 1].t - run.equityHistory[i].t;
        idleWeighted += idle[i] * w;
        rateWeighted += rate(utcDateKey(run.equityHistory[i].t - chain.labelLagDays * 86_400_000)) * w;
        idleWeight += w;
      }
      allBase.push(...o.base);
      allYield.push(...o.withYield);
      spanMsTotal += spanMs;
      console.log(
        `    fold ${run.foldPath}: idle Ø ${fmtPct(idle.reduce((s, x) => s + x, 0) / idle.length, 1)} | ` +
        `CAGR ${fmtPct(mBase.cagr)} → ${fmtPct(mYield.cagr)} (+${((mYield.cagr - mBase.cagr) * 10000).toFixed(0)}bps) | ` +
        `Sharpe ${mBase.sharpe.toFixed(3)} → ${mYield.sharpe.toFixed(3)} | ` +
        `maxDD ${fmtPct(mBase.maxDrawdown)} → ${fmtPct(mYield.maxDrawdown)}`,
      );
    }

    const mBase = seriesMetrics(allBase, spanMsTotal);
    const mYield = seriesMetrics(allYield, spanMsTotal);
    const idleAvg = idleWeighted / idleWeight;
    const rateAvg = rateWeighted / idleWeight;
    const dollarsPerYear = idleAvg * rateAvg * chain.prodCapitalUsd;
    console.log(`    STITCHED (${mBase.periods} periods, ${mBase.years.toFixed(2)}y):`);
    console.log(`      idle avg (time-weighted): ${fmtPct(idleAvg, 1)} | DTB3 avg over window: ${fmtPct(rateAvg)}`);
    console.log(`      CAGR   ${fmtPct(mBase.cagr)} → ${fmtPct(mYield.cagr)}  (+${((mYield.cagr - mBase.cagr) * 10000).toFixed(0)} bps/yr)`);
    console.log(`      Sharpe ${mBase.sharpe.toFixed(3)} → ${mYield.sharpe.toFixed(3)}`);
    console.log(`      maxDD  ${fmtPct(mBase.maxDrawdown)} → ${fmtPct(mYield.maxDrawdown)}`);
    console.log(`      ≈ $${dollarsPerYear.toFixed(0)}/yr on the sleeve's prod capital ($${chain.prodCapitalUsd.toLocaleString()}) at TODAY's mix (idle×rate backtest averages)`);
  }
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(1); });
}
