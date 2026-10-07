#!/usr/bin/env bun
/**
 * Gross-exposure cap fidelity diagnostic (G batch, 2026-10-05 —
 * docs/reports/G-gross-cap.md).
 *
 * Runs a walk-forward manifest EXACTLY like `bun run experiment:wf --
 * <manifest> --no-breakeven`, but with the observer hooks in
 * scripts/backtest-momentum-wf.ts (grossCapDiag) armed, and writes
 * data/backtests/diag-grosscap-<manifest-name>.json with:
 *
 *  - the stitched OOS metrics (same numbers summary.json carries), plus a
 *    CAGR derived from the stitched OOS window span;
 *  - over the OUTER TEST replays only (base costs, full universe — the
 *    stitched chain itself; inner/stress/LOO replays are excluded by
 *    window/cost/universe matching): the distribution of pro-forma gross
 *    exposure at every sim open attempt, as the ratio the live cap tests —
 *    (marked gross book + new notional) / denom, denom = mark-to-market
 *    equity (momentum) or fixed baseUsd (meanrev);
 *  - how many of those attempts exceed --live-cap (what live WOULD block
 *    on an uncapped chain), and how many opens the engine actually
 *    BLOCKED ("BLOCKED by gross exposure cap" warns) on a capped chain.
 *
 * Declared approximations (observer-side, diagnostic only): the ratio is
 * recomputed at the broker boundary from the broker's own book, while the
 * engine's in-tick bookkeeping carries slot NOTIONAL for opens executed
 * earlier in the same tick (momentum books whole-share actuals) and reads
 * equity once per tick — differences are a fraction of one slot.
 *
 * Usage:
 *   bun scripts/diag-gross-cap.ts experiments/<manifest>.json --live-cap=1.0
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultReplayRunner, loadManifest, runWalkForward, type ExperimentManifest } from "./walk-forward";
import { grossCapDiag, type ReplayConfig } from "./backtest-momentum-wf";

const args = process.argv.slice(2);
const manifestPath = args.find(a => a.endsWith(".json")) ?? "";
const capArg = args.find(a => a.startsWith("--live-cap="));
if (!manifestPath || !capArg) {
  console.error("Usage: bun scripts/diag-gross-cap.ts <manifest.json> --live-cap=<mult>");
  process.exit(1);
}
const liveCap = Number(capArg.split("=")[1]);
if (!Number.isFinite(liveCap) || liveCap <= 0) throw new Error(`--live-cap must be a positive number, got "${capArg}"`);

interface Invocation {
  index: number;
  winFrom: string;
  winTo: string;
  label: string;
  slippageBps: number;
  commissionBps: number;
  universeSize: number;
  ratios: number[];
  blockedByCap: number;
}

const m: ExperimentManifest = loadManifest(manifestPath);
const fullUniverseSize = m.data.universe.length;
const invocations: Invocation[] = [];
let current: Invocation | null = null;

grossCapDiag.onOpenAttempt = (s) => {
  if (current && s.denom > 0) current.ratios.push((s.grossBefore + s.newNotional) / s.denom);
};
grossCapDiag.onWarn = (msg) => {
  if (current && /BLOCKED by gross exposure cap/.test(msg)) current.blockedByCap++;
};

const runner = async (cfg: ReplayConfig, win: { label: string; from: string; to: string }, initialRiskState?: Parameters<typeof defaultReplayRunner>[2]) => {
  current = {
    index: invocations.length,
    winFrom: win.from,
    winTo: win.to,
    label: win.label,
    slippageBps: cfg.slippageBps,
    commissionBps: cfg.commissionBps,
    universeSize: cfg.universe.length,
    ratios: [],
    blockedByCap: 0,
  };
  invocations.push(current);
  try {
    return await defaultReplayRunner(cfg, win, initialRiskState);
  } finally {
    current = null;
  }
};

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const { summary, outputDir } = await runWalkForward(m, { breakEven: false, runner });

// The stitched OOS chain = the outer TEST trials at base costs with the
// full declared universe. Match runner invocations by fold window + costs
// + universe size (inner folds have different windows; stress has
// different costs; LOO drops one symbol).
const outerTests = (summary as any).outerTests as Array<{ foldPath: string; result: { totalReturn: number; trades: number; window: { from: string; to: string } } }>;
const outerWindows = new Set(outerTests.map(t => `${t.result.window.from}|${t.result.window.to}`));
const outerInvocations = invocations.filter(inv =>
  outerWindows.has(`${inv.winFrom}|${inv.winTo}`)
  && inv.slippageBps === m.costs.base.slippageBps
  && inv.commissionBps === m.costs.base.commissionBps
  && inv.universeSize === fullUniverseSize,
);
if (outerInvocations.length !== outerTests.length) {
  // Fail LOUD: a mismatched attribution would silently poison the stats.
  throw new Error(`matched ${outerInvocations.length} outer-test invocations, expected ${outerTests.length}`);
}

const ratios = outerInvocations.flatMap(inv => inv.ratios).sort((a, b) => a - b);
const above = ratios.filter(r => r > liveCap + 1e-9).length;
const blockedByCap = outerInvocations.reduce((s, inv) => s + inv.blockedByCap, 0);
const st = summary.stitchedOos;
const spanMs = Math.max(...outerTests.map(t => Date.parse(t.result.window.to))) - Math.min(...outerTests.map(t => Date.parse(t.result.window.from)));
const years = spanMs / (365.25 * 86_400_000);
const cagr = years > 0 ? Math.pow(1 + st.totalReturn, 1 / years) - 1 : null;

const out = {
  manifest: manifestPath,
  manifestName: m.name,
  liveCap,
  outputDir,
  resolvedTo: (summary as any).resolvedTo ?? null,
  stitchedOos: {
    totalReturn: st.totalReturn,
    cagr,
    sharpe: st.sharpe,
    maxDrawdown: st.maxDrawdown,
    trades: st.trades,
    winRate: st.winRate,
  },
  outerPsr: (summary as any).outerPsr ?? null,
  foldPsr: (summary as any).foldPsr ?? null,
  oosYears: years,
  openAttempts: {
    n: ratios.length,
    max: ratios.length ? ratios[ratios.length - 1] : null,
    p50: pct(ratios, 50),
    p95: pct(ratios, 95),
    p99: pct(ratios, 99),
    aboveLiveCap: above,
    pctAboveLiveCap: ratios.length ? (100 * above) / ratios.length : null,
  },
  blockedByCapOuterChain: blockedByCap,
  // Raw sorted pro-forma ratios (6-dp) — lets the report derive the
  // activation share at ANY candidate headroom offline, without re-running.
  ratiosSorted: ratios.map(r => Math.round(r * 1e6) / 1e6),
  perFold: outerInvocations.map(inv => ({
    label: inv.label,
    winFrom: inv.winFrom,
    winTo: inv.winTo,
    attempts: inv.ratios.length,
    maxRatio: inv.ratios.length ? Math.max(...inv.ratios) : null,
    above: inv.ratios.filter(r => r > liveCap + 1e-9).length,
    blockedByCap: inv.blockedByCap,
  })),
};

const outPath = join("data", "backtests", `diag-grosscap-${m.name}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\n▌ GROSS-CAP DIAGNOSTIC — ${m.name} (live cap ${liveCap}×)`);
console.log(`   stitched OOS: ret=${(st.totalReturn * 100).toFixed(1)}% cagr=${cagr === null ? "n/a" : (cagr * 100).toFixed(2) + "%"} sharpe=${st.sharpe.toFixed(3)} DD=${(st.maxDrawdown * 100).toFixed(1)}% trades=${st.trades} PSR=${(summary as any).outerPsr?.toFixed(3) ?? "n/a"}`);
console.log(`   open attempts (outer chain): n=${out.openAttempts.n} max=${out.openAttempts.max?.toFixed(3)} p95=${out.openAttempts.p95?.toFixed(3)} p99=${out.openAttempts.p99?.toFixed(3)} above ${liveCap}×: ${above} (${out.openAttempts.pctAboveLiveCap?.toFixed(2)}%)`);
console.log(`   engine-blocked by cap (outer chain): ${blockedByCap}`);
console.log(`   artifact: ${outputDir}/`);
console.log(`   diag: ${outPath}`);
