#!/usr/bin/env bun
/** Line H (§12-septies): signal-only overlay on A's execution/accounting.
 * entryPct = k; exitPct = hold hours. No live engine or shared default changes.
 */
import type { ReplayConfig, ReplayResult } from "./backtest-momentum-wf";
import type { RiskState } from "../src/strategies/momentum/RiskGuard";
import { runXslsReplay, type DropDiagnostics, type XslsReplayResult } from "./crypto-xsls-replay";

const HOUR = 3_600_000;
export type DropReplayResult = XslsReplayResult & { dropDiagnostics: DropDiagnostics };

/** Calendar window [t−720h,t), 600 valid consecutive-hour log returns.
 * Sample sd (n−1), not RMS; current return is NEVER in its own denominator.
 * One chronological pass: even though future closes are loaded, each output
 * consumes only closes <= its hour. NaN means unavailable (including sd=0).
 */
export function hourlyDropZ(times: number[], closes: number[]): Float64Array {
  const z = new Float64Array(times.length).fill(NaN);
  const returns = new Float64Array(times.length).fill(NaN);
  let left = 0, count = 0, sum = 0, squares = 0;
  for (let i = 0; i < times.length; i++) {
    if (i > 0 && times[i] - times[i - 1] === HOUR && closes[i] > 0 && closes[i - 1] > 0) {
      const r = Math.log(closes[i] / closes[i - 1]);
      if (Number.isFinite(r)) returns[i] = r;
    }
    while (left < i && times[left] < times[i] - 720 * HOUR) {
      const r = returns[left++];
      if (Number.isFinite(r)) { count--; sum -= r; squares -= r * r; }
    }
    if (count >= 600 && Number.isFinite(returns[i])) {
      const variance = (squares - sum * sum / count) / (count - 1);
      if (variance > 0) z[i] = returns[i] / Math.sqrt(variance);
    }
    // Add AFTER computing z_i; at the next hour it becomes past information.
    const r = returns[i];
    if (Number.isFinite(r)) { count++; sum += r; squares += r * r; }
  }
  return z;
}

const scores = new WeakMap<number[], Float64Array>();
function zAt(times: number[], closes: number[], index: number): number | null {
  let zs = scores.get(times);
  if (!zs) { zs = hourlyDropZ(times, closes); scores.set(times, zs); }
  return Number.isFinite(zs[index]) ? zs[index] : null;
}

export async function runDropReplay(
  cfg: ReplayConfig,
  win: { label: string; from: string; to: string },
  state?: RiskState,
): Promise<ReplayResult | null> {
  if (![3, 4].includes(cfg.entryPct) || ![4, 12].includes(cfg.exitPct)
    || cfg.cadenceMin !== 60 || cfg.maxLongs !== 5 || cfg.maxShorts !== 0
    || cfg.notionalPctPerSlot !== 0.2 || cfg.lookbackDays !== 30) {
    throw new Error("Line H requires the pre-registered k={3,4}, h={4,12}, 5 long slots, hourly, equity/5 grid");
  }
  return runXslsReplay(cfg, win, state, {
    hourlyDrop: { threshold: cfg.entryPct, holdHours: cfg.exitPct, zAt },
  });
}
