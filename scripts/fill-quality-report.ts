#!/usr/bin/env bun
// ══════════════════════════════════════════════
// fill-quality-report.ts — empirical paper-vs-real haircut (2026-09-02)
// ══════════════════════════════════════════════
//
// Answers: how much does REALIZED slippage (decision price → actual fill)
// actually cost, broken down by broker/market/side/trade-size, and how far
// off is the pre-trade impact estimator (est_px, src/executor/bookDepth.ts)
// versus what actually happened? Nobody has read the `fills` table's
// telemetry since it started recording est_px (2026-08-03) — ~330 fills in
// prod, ~167 with a usable estimate. All the math is pure and tested in
// src/reports/fillQuality.ts; this file is only the CLI — a readonly
// sqlite read, summarize, print.
//
// Decisions this feeds:
//  - EntryExecutionConfig.maxEstImpactBps is OFF by default ("disabled
//    until the estimator is validated" — bookDepth.ts:22). A small, STABLE
//    |est error| across enough fills (see estN per group/bucket) is the
//    evidence that would justify turning it on; a large or noisy one says
//    leave it off.
//  - The realized-slippage numbers here ARE the empirical haircut that
//    should discount any paper-backtest expectation before it's trusted
//    live — that's the whole point of a "paper-vs-real" report.
//
// Usage:
//   bun scripts/fill-quality-report.ts
//   bun scripts/fill-quality-report.ts --db data/trading.db --since-days 30
//   bun scripts/fill-quality-report.ts --from 2026-09-10 --until 2026-09-24
//   bun scripts/fill-quality-report.ts --json
//
// --from/--until (ISO dates, from inclusive / until exclusive, on fill_time)
// exist for the Price-basis note (src/reports/fillQuality.ts, 2026-09-10):
// Binance entry expected_px was the MARK price before that date and the
// executable-quote touch after — slippage_bps across the boundary is not
// comparable, and this CLI used to offer only the relative --since-days,
// silently mixing both bases for any window ≥ ~11d. When both relative and
// absolute cuts are given, the EFFECTIVE window is their intersection.

import { Database } from "bun:sqlite";
import { summarize, type FillRow, type GroupSummary } from "../src/reports/fillQuality";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const DB_PATH = arg("--db", "data/trading.db");
const SINCE_DAYS = Number(arg("--since-days", "30"));
const FROM_ARG = arg("--from", "");
const UNTIL_ARG = arg("--until", "");
const JSON_OUT = process.argv.includes("--json");

/** The 2026-09-10 expected_px basis change (see header). A window that
 *  CROSSES this instant mixes MARK-based and touch-based slippage. */
export const PRICE_BASIS_BOUNDARY_MS = Date.parse("2026-09-10T00:00:00Z");

export interface EffectiveWindow {
  /** Inclusive lower bound on fill_time (ms). */
  fromMs: number;
  /** Exclusive upper bound on fill_time (ms); Infinity = unbounded. */
  untilMs: number;
  /** True when the window straddles the 2026-09-10 price-basis change. */
  crossesPriceBasisBoundary: boolean;
}

/** Pure so it's testable without a DB: resolve --since-days/--from/--until
 *  into one effective [fromMs, untilMs) window (intersection of all cuts).
 *  Throws on an unparseable ISO date or an empty window — the CLI turns
 *  that into a clear error + exit 1 instead of a silently-empty report. */
export function resolveWindow(
  opts: { sinceDays: number; from?: string; until?: string },
  nowMs: number = Date.now(),
): EffectiveWindow {
  const parseIso = (flag: string, v: string): number => {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) throw new Error(`${flag} "${v}" is not a parseable ISO date (e.g. 2026-09-10 or 2026-09-10T00:00:00Z)`);
    return ms;
  };
  if (!Number.isFinite(opts.sinceDays)) throw new Error(`--since-days "${opts.sinceDays}" is not a number`);
  let fromMs = nowMs - Math.max(0, opts.sinceDays) * 24 * 3600_000;
  let untilMs = Infinity;
  if (opts.from) fromMs = Math.max(fromMs, parseIso("--from", opts.from));
  if (opts.until) untilMs = Math.min(untilMs, parseIso("--until", opts.until));
  if (untilMs <= fromMs) throw new Error(`empty window: effective --until (${new Date(untilMs).toISOString()}) is not after effective --from (${new Date(fromMs).toISOString()})`);
  return {
    fromMs,
    untilMs,
    crossesPriceBasisBoundary: fromMs < PRICE_BASIS_BOUNDARY_MS && untilMs > PRICE_BASIS_BOUNDARY_MS,
  };
}

function describeWindow(w: EffectiveWindow): string {
  const until = w.untilMs === Infinity ? "now" : new Date(w.untilMs).toISOString();
  return `[${new Date(w.fromMs).toISOString()} .. ${until}) UTC`;
}

function openDb(dbPath: string): Database {
  try {
    return new Database(dbPath, { readonly: true });
  } catch (e: any) {
    console.error(`✗ Could not open ${dbPath}: ${e.message}`);
    process.exit(1);
    throw e; // unreachable — keeps the function's return type honest
  }
}

/**
 * Reads `fills` since `sinceDays` ago. A missing `fills` table (a
 * trading.db that predates Wave 1, 2026-05-07 — plausible on this
 * decommissioned dev checkout, see AGENTS.md "Project Location") is
 * reported as "no fills", not a crash: any other sqlite error still
 * propagates.
 */
function loadRows(dbPath: string, win: EffectiveWindow): FillRow[] {
  const db = openDb(dbPath);
  try {
    const raw = db.prepare(
      `SELECT broker, market, side, expected_px, filled_px, filled_qty, latency_ms, est_px
       FROM fills WHERE fill_time >= ? AND fill_time < ? ORDER BY fill_time`
    ).all(win.fromMs, win.untilMs === Infinity ? Number.MAX_SAFE_INTEGER : win.untilMs) as any[];
    return raw.map(r => ({
      broker: r.broker,
      market: r.market,
      side: r.side,
      expectedPx: r.expected_px,
      filledPx: r.filled_px,
      filledQty: r.filled_qty,
      latencyMs: r.latency_ms,
      estPx: r.est_px,
    }));
  } catch (e: any) {
    if (String(e?.message ?? e).includes("no such table")) return [];
    throw e;
  } finally {
    db.close();
  }
}

function fmt(n: number | null, digits = 1): string {
  return n === null ? "—" : n.toFixed(digits);
}

/** Pads a table of string cells to aligned columns — sort+index simplicity,
 *  no console.table (which doesn't nest well for the per-group + per-bucket
 *  structure this report needs). */
function printAlignedTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  console.log("  " + line(headers));
  console.log("  " + line(widths.map(w => "-".repeat(w))));
  for (const r of rows) console.log("  " + line(r));
}

function printTable(summary: GroupSummary[], win: EffectiveWindow): void {
  console.log(`Fill quality report — window ${describeWindow(win)}, ${DB_PATH}`);
  if (win.crossesPriceBasisBoundary) {
    console.log(`⚠ window CROSSES 2026-09-10 — Binance entry expected_px changed basis there (MARK → executable touch); slippage_bps mixes both. Use --from/--until to isolate one side.`);
  }
  console.log(`(positive bps = cost; positive |est error| shown as magnitude only)\n`);

  printAlignedTable(
    ["broker", "market", "n", "slipP50", "slipP90", "estErrP50", "estErrP90", "estN", "latP50ms", "latP90ms"],
    summary.map(g => [
      g.broker, g.market, String(g.n),
      fmt(g.slippageBpsP50), fmt(g.slippageBpsP90),
      fmt(g.estErrorAbsBpsP50), fmt(g.estErrorAbsBpsP90), String(g.estN),
      fmt(g.latencyMsP50, 0), fmt(g.latencyMsP90, 0),
    ])
  );

  for (const g of summary) {
    const roleLabel = g.sideIsEntryExit
      ? "buy=entry, sell=exit (long-only sleeve)"
      : "buy/sell only — shorts exist on this market, side ≠ entry/exit";
    console.log(`\n── ${g.broker} / ${g.market} (${roleLabel}) ──`);
    printAlignedTable(
      ["side", "n", "slipP50", "slipP90"],
      [
        ["buy", String(g.buy.n), fmt(g.buy.slippageBpsP50), fmt(g.buy.slippageBpsP90)],
        ["sell", String(g.sell.n), fmt(g.sell.slippageBpsP50), fmt(g.sell.slippageBpsP90)],
      ]
    );
    console.log(`  by notional:`);
    printAlignedTable(
      ["bucket", "n", "slipP50", "slipP90", "estErrP50", "estErrP90", "estN", "latP50ms", "latP90ms"].map(h => "  " + h),
      g.buckets.map(b => [
        "  " + b.bucket, String(b.n),
        fmt(b.slippageBpsP50), fmt(b.slippageBpsP90),
        fmt(b.estErrorAbsBpsP50), fmt(b.estErrorAbsBpsP90), String(b.estN),
        fmt(b.latencyMsP50, 0), fmt(b.latencyMsP90, 0),
      ])
    );
  }
}

function main(): void {
  let win: EffectiveWindow;
  try {
    win = resolveWindow({ sinceDays: SINCE_DAYS, from: FROM_ARG || undefined, until: UNTIL_ARG || undefined });
  } catch (e: any) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
    throw e; // unreachable — keeps the type narrow
  }

  const rows = loadRows(DB_PATH, win);
  if (rows.length === 0) {
    console.log(`No fills found in ${DB_PATH} within ${describeWindow(win)} — nothing to report.`);
    process.exit(0);
  }

  const summary = summarize(rows);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      dbPath: DB_PATH,
      window: { fromMs: win.fromMs, untilMs: win.untilMs === Infinity ? null : win.untilMs, crossesPriceBasisBoundary: win.crossesPriceBasisBoundary },
      totalFills: rows.length,
      groups: summary,
    }, null, 2));
  } else {
    printTable(summary, win);
  }
}

// Guarded so tests can import resolveWindow without running the report.
if (import.meta.main) main();
