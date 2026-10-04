#!/usr/bin/env bun
/**
 * DIAGNOSTIC (0 new trials): quantify the soft-DD lockout inside the PURE
 * vt-35 chain (the live incumbent — experiments/momentum-crypto-vt35-pure-v1
 * .json, artifact 8b673e8a). Re-runs the exact same candidate over the same
 * outer-fold chain (RiskState chained fold-to-fold like walk-forward.ts)
 * and reads ReplayResult.blockedTicks to measure:
 *   - every soft-drawdown pause EPISODE (consecutive blocked decision ticks),
 *     its duration in days, and
 *   - what BTC and the equal-weight 8-symbol universe returned WHILE the
 *     sleeve was locked out (the opportunity cost the lockout buys/costs).
 *
 * Same candidate config identity as the artifact => NOT a new hypothesis
 * (ledger identity rule); output is stdout only, nothing persisted.
 *
 * Usage: bun run scripts/research-softdd-lockout.ts [--reason "soft drawdown"]
 */
import {
  loadManifest,
  generateFolds,
  candidateToReplayConfig,
  continueRiskState,
  resolveAsOf,
} from "./walk-forward";
import { runWithConfig, loadBars } from "./backtest-momentum-wf";
import type { RiskState } from "../src/strategies/momentum/RiskGuard";
import type { OHLCV } from "../src/utils/types";

const reasonKey = (() => {
  const i = process.argv.indexOf("--reason");
  return i >= 0 ? process.argv[i + 1] : "soft drawdown";
})();

const m = loadManifest("experiments/momentum-crypto-vt35-pure-v1.json");
const asOfMs = resolveAsOf(m);
const folds = generateFolds(m.window, asOfMs);
const cadenceMs = m.candidates[0].cadenceMin * 60_000;

interface Episode {
  fold: string;
  fromIso: string;
  toIso: string;
  ticks: number;
  days: number;
  btcRet: number;
  universeRet: number;
}

function closeAtOrBefore(bars: OHLCV[], t: number): number | null {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? bars[ans].close : null;
}

function retBetween(bars: OHLCV[], fromMs: number, toMs: number): number {
  const a = closeAtOrBefore(bars, fromMs);
  const b = closeAtOrBefore(bars, toMs);
  return a && b && a > 0 ? b / a - 1 : NaN;
}

async function main() {
  let chainState: RiskState | undefined;
  const episodes: Episode[] = [];
  const perFold: Array<{ fold: string; days: number; blockedTicks: number; totalTicksBlockedShare: number }> = [];

  for (const outer of folds) {
    const cfg = candidateToReplayConfig(m, m.candidates[0], "base");
    const win = {
      label: outer.test.path,
      from: new Date(outer.test.fromMs).toISOString(),
      to: new Date(outer.test.toMs).toISOString(),
    };
    const r = await runWithConfig(cfg, win, chainState);
    if (!r) throw new Error(`replay failed for ${outer.test.path}`);
    chainState = continueRiskState(r);

    const soft = (r.blockedTicks ?? []).filter(bt => bt.reason === reasonKey);
    const foldDays = (r.toMs - r.fromMs) / 86_400_000;
    const decisionTicksApprox = Math.floor((r.toMs - r.fromMs) / cadenceMs);
    perFold.push({
      fold: outer.test.path,
      days: Number(foldDays.toFixed(1)),
      blockedTicks: soft.length,
      totalTicksBlockedShare: Number((soft.length / Math.max(1, decisionTicksApprox)).toFixed(3)),
    });

    // Bars for opportunity-cost pricing over this fold's window.
    const bySym = new Map<string, OHLCV[]>();
    for (const sym of m.data.universe) {
      bySym.set(sym, loadBars(sym, m.data.timeframe, m.data.source, m.data.rthOnly, r.fromMs, r.toMs));
    }
    const btc = bySym.get("BTC/USD")!;

    // Group consecutive blocked ticks into episodes (tolerate up to 3
    // cadences of hole — e.g. an isolated tick blocked by another gate
    // inside the same pause window).
    let start: number | null = null, last: number | null = null, count = 0;
    const flush = () => {
      if (start === null || last === null) return;
      const from = start, to = last + cadenceMs;
      const uniRets = m.data.universe
        .map(s => retBetween(bySym.get(s)!, from, to))
        .filter(x => Number.isFinite(x));
      episodes.push({
        fold: outer.test.path,
        fromIso: new Date(from).toISOString(),
        toIso: new Date(to).toISOString(),
        ticks: count,
        days: Number(((to - from) / 86_400_000).toFixed(2)),
        btcRet: Number(retBetween(btc, from, to).toFixed(4)),
        universeRet: Number((uniRets.reduce((s, x) => s + x, 0) / Math.max(1, uniRets.length)).toFixed(4)),
      });
      start = last = null; count = 0;
    };
    for (const bt of soft) {
      if (start === null) { start = bt.t; last = bt.t; count = 1; continue; }
      if (bt.t - (last as number) <= 3 * cadenceMs) { last = bt.t; count++; continue; }
      flush();
      start = bt.t; last = bt.t; count = 1;
    }
    flush();
  }

  console.log("▌ soft-DD lockout — cadena pura vt-35 (misma config que 8b673e8a, base costs)");
  console.log(JSON.stringify(perFold, null, 2));
  console.log(`\n▌ episodios (${episodes.length}) — reason='${reasonKey}'`);
  for (const e of episodes) {
    console.log(
      `${e.fold}  ${e.fromIso.slice(0, 10)} → ${e.toIso.slice(0, 10)}  ${String(e.days).padStart(6)}d  ` +
      `${String(e.ticks).padStart(5)} ticks  BTC ${(e.btcRet * 100).toFixed(1).padStart(7)}%  EW8 ${(e.universeRet * 100).toFixed(1).padStart(7)}%`,
    );
  }
  const days = episodes.map(e => e.days).sort((a, b) => a - b);
  const q = (p: number) => days.length ? days[Math.min(days.length - 1, Math.floor(p * days.length))] : NaN;
  const totBlocked = days.reduce((s, x) => s + x, 0);
  const totDays = perFold.reduce((s, f) => s + f.days, 0);
  const btcDuring = episodes.reduce((s, e) => s + Math.log(1 + e.btcRet), 0);
  const ewDuring = episodes.reduce((s, e) => s + Math.log(1 + e.universeRet), 0);
  console.log(`\n▌ resumen`);
  console.log(`  episodios: ${episodes.length} | duracion d: min ${days[0] ?? "-"} p50 ${q(0.5)} p90 ${q(0.9)} max ${days[days.length - 1] ?? "-"}`);
  console.log(`  dias bloqueados: ${totBlocked.toFixed(1)} de ${totDays.toFixed(0)} OOS (${(100 * totBlocked / totDays).toFixed(1)}%)`);
  console.log(`  BTC compuesto DURANTE pausas: ${((Math.exp(btcDuring) - 1) * 100).toFixed(1)}% | EW8 compuesto: ${((Math.exp(ewDuring) - 1) * 100).toFixed(1)}%`);
}

await main();
