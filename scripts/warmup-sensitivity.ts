#!/usr/bin/env bun
/**
 * Warm-up sensitivity check (Freqtrade `recursive-analysis` pattern —
 * open-source review 2026-09 proposal 3; complements
 * scripts/lookahead-analysis.ts, which shrinks the FUTURE side of the data
 * while this varies the PAST side).
 *
 * Takes a walk-forward manifest, resolves its single candidate to the exact
 * ReplayConfig the protocol would run (candidateToReplayConfig — same
 * simulators, same engines), and replays the SAME evaluation window three
 * times with warm-up W, 1.5W and 2W (W = manifest window.warmupDays). The
 * warm-up only extends the history loaded BEFORE the evaluation start; the
 * decision loop starts at the same instant in all three runs, so if every
 * indicator is truly windowed (rolling, bounded state) the decisions —
 * entries, exits and the daily equity path — must be IDENTICAL. A
 * divergence exposes unbounded indicator state (e.g. a recursively-smoothed
 * RSI seeded at the first loaded bar), a gate that reads "all loaded
 * history", or insufficient historyBars.
 *
 * Evaluation start: defaults to the manifest window.from. When the DB's own
 * history can't supply the LARGEST warm-up variant before that date (the
 * variants would silently load the same clipped history and compare nothing)
 * the start is bumped to firstBar + maxWarmup + margin and reported.
 * Override with --eval-from. The replays themselves are untouched — the
 * window is already a parameter of their contract.
 *
 * Usage:
 *   bun scripts/warmup-sensitivity.ts experiments/<manifest>.json \
 *     [--hist <db>] [--candidate <name>] [--factors 1,1.5,2] \
 *     [--eval-from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Exit codes: 0 = convergent, 1 = DIVERGENT (first date+symbol reported),
 * 2 = usage/data error.
 */

import { Database } from "bun:sqlite";
import {
  candidateToReplayConfig,
  defaultReplayRunner,
  loadManifest,
  resolveAsOf,
  type CandidateConfig,
  type ExperimentManifest,
} from "./walk-forward";
import type { ReplayResult } from "./backtest-momentum-wf";

// ── pure comparison layer (unit-tested with synthetic series) ─────────

export interface DecisionSnapshot {
  label: string;
  warmupDays: number;
  dailyReturns: Array<{ date: string; ret: number }>;
  closedTrades: Array<{ symbol: string; side: string; pnl: number; exitAt: number; entryAt?: number; qty?: number }>;
}

export interface Divergence {
  kind: "trade" | "dailyReturn";
  /** ISO date (YYYY-MM-DD) of the first diverging decision. */
  date: string;
  symbol?: string;
  detail: string;
}

function tradeKeyDate(t: DecisionSnapshot["closedTrades"][number]): string {
  return new Date(t.entryAt ?? t.exitAt).toISOString().slice(0, 10);
}

function sortTrades(ts: DecisionSnapshot["closedTrades"]) {
  return [...ts].sort((a, b) =>
    (a.entryAt ?? a.exitAt) - (b.entryAt ?? b.exitAt) || a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol));
}

/**
 * First decision divergence between two replay snapshots of the SAME
 * evaluation window, or null when they are identical (within eps on
 * floating-point fields). Checks the trade stream (entries/exits: symbol,
 * side, entry/exit instant, qty, pnl) and the daily equity-return stream
 * (the "cartera diaria" — identical positions must produce an identical
 * daily path), and reports the EARLIEST diverging date across both.
 */
export function findDivergence(base: DecisionSnapshot, variant: DecisionSnapshot, eps = 1e-9): Divergence | null {
  const candidates: Divergence[] = [];

  // Trade stream.
  const a = sortTrades(base.closedTrades);
  const b = sortTrades(variant.closedTrades);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ta = a[i], tb = b[i];
    const fieldDiffs: string[] = [];
    if (ta.symbol !== tb.symbol) fieldDiffs.push(`symbol ${ta.symbol} vs ${tb.symbol}`);
    if (ta.side !== tb.side) fieldDiffs.push(`side ${ta.side} vs ${tb.side}`);
    if ((ta.entryAt ?? ta.exitAt) !== (tb.entryAt ?? tb.exitAt)) fieldDiffs.push(`entryAt ${ta.entryAt ?? ta.exitAt} vs ${tb.entryAt ?? tb.exitAt}`);
    if (ta.exitAt !== tb.exitAt) fieldDiffs.push(`exitAt ${ta.exitAt} vs ${tb.exitAt}`);
    if (ta.qty !== undefined && tb.qty !== undefined && Math.abs(ta.qty - tb.qty) > eps) fieldDiffs.push(`qty ${ta.qty} vs ${tb.qty}`);
    if (Math.abs(ta.pnl - tb.pnl) > Math.max(eps, Math.abs(ta.pnl) * 1e-9)) fieldDiffs.push(`pnl ${ta.pnl} vs ${tb.pnl}`);
    if (fieldDiffs.length > 0) {
      candidates.push({
        kind: "trade",
        date: tradeKeyDate(ta) <= tradeKeyDate(tb) ? tradeKeyDate(ta) : tradeKeyDate(tb),
        symbol: ta.symbol,
        detail: `trade #${i} differs (${base.label} vs ${variant.label}): ${fieldDiffs.join(", ")}`,
      });
      break;
    }
  }
  if (candidates.length === 0 && a.length !== b.length) {
    const extra = a.length > b.length ? a[n] : b[n];
    candidates.push({
      kind: "trade",
      date: tradeKeyDate(extra),
      symbol: extra.symbol,
      detail: `trade count differs: ${a.length} (${base.label}) vs ${b.length} (${variant.label}); first unmatched: ${extra.symbol}`,
    });
  }

  // Daily equity-return stream.
  const m = Math.min(base.dailyReturns.length, variant.dailyReturns.length);
  for (let i = 0; i < m; i++) {
    const da = base.dailyReturns[i], db = variant.dailyReturns[i];
    if (da.date !== db.date) {
      candidates.push({ kind: "dailyReturn", date: da.date < db.date ? da.date : db.date, detail: `daily-return dates desync: ${da.date} (${base.label}) vs ${db.date} (${variant.label})` });
      break;
    }
    if (Math.abs(da.ret - db.ret) > eps) {
      candidates.push({ kind: "dailyReturn", date: da.date, detail: `daily return differs on ${da.date}: ${da.ret} (${base.label}) vs ${db.ret} (${variant.label})` });
      break;
    }
  }
  if (candidates.length === 0 || !candidates.some(c => c.kind === "dailyReturn")) {
    if (base.dailyReturns.length !== variant.dailyReturns.length) {
      const extra = base.dailyReturns.length > variant.dailyReturns.length
        ? base.dailyReturns[m] : variant.dailyReturns[m];
      candidates.push({ kind: "dailyReturn", date: extra.date, detail: `daily-return count differs: ${base.dailyReturns.length} vs ${variant.dailyReturns.length}` });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((x, y) => x.date.localeCompare(y.date));
  return candidates[0];
}

export function snapshotFromResult(label: string, warmupDays: number, r: ReplayResult): DecisionSnapshot {
  return { label, warmupDays, dailyReturns: r.dailyReturns, closedTrades: r.closedTrades };
}

// ── data-availability probe for the evaluation start ──────────────────

/** Latest first-bar timestamp across the universe (+refSymbol) — the DB's
 *  binding constraint on how much warm-up can actually be loaded. */
export function latestFirstBar(dbPath: string, m: ExperimentManifest): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    let latest = 0;
    for (const sym of new Set([...m.data.universe, m.data.refSymbol])) {
      const row = db.prepare(
        `SELECT MIN(timestamp) t FROM historical_bars WHERE symbol = ? AND timeframe = ? AND source = ?`,
      ).get(sym, m.data.timeframe, m.data.source) as { t: number | null };
      if (row.t === null) throw new Error(`no ${m.data.source}/${m.data.timeframe} bars at all for ${sym} in ${dbPath}`);
      latest = Math.max(latest, row.t);
    }
    return latest;
  } finally {
    db.close();
  }
}

// ── CLI ───────────────────────────────────────────────────────────────

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const manifestPath = process.argv.slice(2).find(a => a.endsWith(".json"));
  if (!manifestPath) {
    console.error("Usage: bun scripts/warmup-sensitivity.ts <manifest.json> [--hist <db>] [--candidate <name>] [--factors 1,1.5,2] [--eval-from YYYY-MM-DD] [--to YYYY-MM-DD]");
    process.exit(2);
  }
  const m = loadManifest(manifestPath);
  const dbPath = argOf("--hist") ?? m.data.dbPath;
  const factors = (argOf("--factors") ?? "1,1.5,2").split(",").map(Number);
  if (factors.some(f => !Number.isFinite(f) || f < 1) || factors[0] !== 1) {
    console.error("--factors must be a comma list starting at 1 (the base warm-up)");
    process.exit(2);
  }

  const candName = argOf("--candidate");
  let candidate: CandidateConfig | undefined = candName
    ? m.candidates.find(c => c.name === candName)
    : (m.candidates.length === 1 ? m.candidates[0] : undefined);
  if (!candidate) {
    console.error(`pick a candidate with --candidate <name>; manifest has: ${m.candidates.map(c => c.name).join(", ")}`);
    process.exit(2);
  }

  const W = m.window.warmupDays;
  const maxWarmupDays = Math.ceil(W * Math.max(...factors));
  const dayMs = 86_400_000;
  const toMs = argOf("--to") ? Date.parse(argOf("--to")!) : Math.min(Date.parse(m.window.to), resolveAsOf(m, dbPath));

  let evalFromMs: number;
  if (argOf("--eval-from")) {
    evalFromMs = Date.parse(argOf("--eval-from")!);
  } else {
    evalFromMs = Date.parse(m.window.from);
    // If the DB can't supply the largest warm-up before window.from, the
    // variants would all load the SAME clipped history (or fail closed) —
    // bump the evaluation start so every variant loads genuinely different,
    // fully-available warm-up. 7d margin absorbs weekends/holidays at the
    // boundary.
    const firstBar = latestFirstBar(dbPath, m);
    const needed = firstBar + maxWarmupDays * dayMs + 7 * dayMs;
    if (needed > evalFromMs) {
      evalFromMs = needed;
      console.log(`⚠ evaluation start bumped to ${new Date(evalFromMs).toISOString().slice(0, 10)}: DB history starts ${new Date(firstBar).toISOString().slice(0, 10)}, and the 2W warm-up (${maxWarmupDays}d) must fit before the start (override with --eval-from)`);
    }
  }
  if (!(toMs > evalFromMs)) {
    console.error(`empty evaluation window: ${new Date(evalFromMs).toISOString()} → ${new Date(toMs).toISOString()}`);
    process.exit(2);
  }

  console.log(`▌ Warm-up sensitivity: ${m.name} / candidate ${candidate.name}`);
  console.log(`   db: ${dbPath}`);
  console.log(`   window: ${new Date(evalFromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)} | warm-ups: ${factors.map(f => `${Math.ceil(W * f)}d`).join(", ")}`);

  const snapshots: DecisionSnapshot[] = [];
  for (const f of factors) {
    const cfg = candidateToReplayConfig(m, candidate, "base", dbPath);
    cfg.warmupDays = Math.ceil(W * f);
    const label = `${f}x(${cfg.warmupDays}d)`;
    const win = { label: `warmup-${f}x`, from: new Date(evalFromMs).toISOString(), to: new Date(toMs).toISOString() };
    const started = Date.now();
    const result = await defaultReplayRunner(cfg, win);
    if (!result) {
      console.error(`   ${label}: replay returned null (no data?)`);
      process.exit(2);
    }
    console.log(`   ${label}: ${result.trades} trades, ret ${(result.totalReturn * 100).toFixed(1)}%, ${result.dailyReturns.length} daily obs (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    snapshots.push(snapshotFromResult(label, cfg.warmupDays, result));
  }

  let diverged = false;
  for (let i = 1; i < snapshots.length; i++) {
    const d = findDivergence(snapshots[0], snapshots[i]);
    if (d) {
      diverged = true;
      console.log(`   ✗ DIVERGES ${snapshots[0].label} vs ${snapshots[i].label}: first at ${d.date}${d.symbol ? ` (${d.symbol})` : ""} [${d.kind}] — ${d.detail}`);
    } else {
      console.log(`   ✓ ${snapshots[0].label} vs ${snapshots[i].label}: identical decisions (trades + daily equity path)`);
    }
  }
  console.log(diverged
    ? "   VERDICT: warm-up SENSITIVE — an indicator/gate carries unbounded state or historyBars is insufficient; do NOT trust artifacts until explained"
    : "   VERDICT: convergent — decisions independent of warm-up depth (Freqtrade recursive-analysis clean)");
  process.exit(diverged ? 1 : 0);
}

if (import.meta.main) await main();
