#!/usr/bin/env bun
/**
 * Descriptive frequency of a copySignal design: how many picks per year and how many positions on
 * average the engine's OWN selection produces over the real events and the point-in-time membership.
 * Counts only: no returns, no P&L, no event study (the bars give the session calendar and the
 * tradability test, nothing is marked). Capacity planning for the pre-registration, not evidence.
 *
 *   bun scripts/copy-signal-counts.ts <configs.json> [--from 2016-02-01] [--to 2026-09-30]
 *        [--bars <hist-sp500.db>] [--signals <signals.db>] [--index sp500] [--membership-exclude SPY] [--out <file.json>]
 *
 * configs.json: { "<name>": <CopySignalConfig>, ... } (the `portfolio.strategy` block of a candidate).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { decide } from "../src/portfolio-engine";
import type { CopySignalConfig, MembershipView, SessionDate } from "../src/portfolio-engine/types";
import { IndexMembershipView, SessionPriceView, loadSessionSeries, type SessionSeries } from "./lib/portfolioData";
import { SignalBook, loadSignalEvents } from "./lib/signalData";
import { researchDataPath } from "./lib/researchData";

export interface YearCount { decisions: number; newPicks: number; renewals: number; heldSum: number; daysWithPick: number }
export interface CountResult {
  years: Record<string, YearCount>;
  total: YearCount & { picksPerYear: number; meanHeld: number; meanGross: number; shareDaysWithPick: number; uniqueSymbols: number };
  /** Event-DAYS removed by each filter (an event inside the lookback is counted on every decision day it is seen): a size indicator, not a count of events. */
  filteredEventDays: { insiderClass: number; plan10b5_1: number; reportLag: number };
}

/** Run the engine's decision day by day over `sessions` (asOf in [from, to]); the book is never marked. */
export function countPicks(cfg: CopySignalConfig, world: { series: ReadonlyMap<string, SessionSeries>; sessions: readonly SessionDate[]; membership: MembershipView; book: SignalBook }, from: SessionDate, to: SessionDate): CountResult {
  const years: Record<string, YearCount> = {};
  const symbols = new Set<string>();
  const filtered = { insiderClass: 0, plan10b5_1: 0, reportLag: 0 };
  let memory: Record<string, unknown> = {};
  for (let i = 0; i + 1 < world.sessions.length; i++) {
    const asOf = world.sessions[i];
    if (asOf < from || asOf > to) continue;
    const t = decide({
      view: new SessionPriceView(world.series, asOf), membership: world.membership, signals: world.book.at(asOf),
      book: { equity: 1, positions: [], memory }, config: cfg, executionSession: world.sessions[i + 1],
    });
    memory = t.memory as Record<string, unknown>;
    const y = (years[asOf.slice(0, 4)] ??= { decisions: 0, newPicks: 0, renewals: 0, heldSum: 0, daysWithPick: 0 });
    const d = t.diagnostics as { added: string[]; renewed: string[]; picks: string[]; filtered: typeof filtered };
    y.decisions++;
    y.newPicks += d.added.length;
    y.renewals += d.renewed.length;
    y.heldSum += d.picks.length;
    if (d.picks.length > 0) y.daysWithPick++;
    for (const s of d.added) symbols.add(s);
    for (const k of Object.keys(filtered) as Array<keyof typeof filtered>) filtered[k] += d.filtered[k];
  }
  const all = Object.values(years);
  const sum = (f: (y: YearCount) => number) => all.reduce((a, y) => a + f(y), 0);
  const decisions = sum(y => y.decisions), heldSum = sum(y => y.heldSum), newPicks = sum(y => y.newPicks);
  const spanYears = decisions / 252;
  return {
    years,
    total: {
      decisions, newPicks, renewals: sum(y => y.renewals), heldSum, daysWithPick: sum(y => y.daysWithPick),
      picksPerYear: spanYears > 0 ? newPicks / spanYears : 0,
      meanHeld: decisions > 0 ? heldSum / decisions : 0,
      meanGross: decisions > 0 ? (heldSum / decisions / cfg.topN) * cfg.maxGross : 0,
      shareDaysWithPick: decisions > 0 ? sum(y => y.daysWithPick) / decisions : 0,
      uniqueSymbols: symbols.size,
    },
    filteredEventDays: filtered,
  };
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find(a => a.endsWith(".json") && !a.startsWith("--"));
  if (!file) throw new Error("Usage: bun scripts/copy-signal-counts.ts <configs.json> [--from D] [--to D] [--bars db] [--signals db] [--out file]");
  const configs = JSON.parse(readFileSync(file, "utf8")) as Record<string, CopySignalConfig>;
  const from = flag("--from") ?? "2016-02-01", to = flag("--to") ?? "2026-09-30";
  const barsPath = flag("--bars") ?? researchDataPath("hist-sp500.db");
  const signalsPath = flag("--signals") ?? researchDataPath("signals.db");
  const index = flag("--index") ?? "sp500";
  const exclude = (flag("--membership-exclude") ?? "SPY").split(",").filter(Boolean);
  const DAY = 86_400_000;

  const bars = new Database(barsPath, { readonly: true });
  const membership = IndexMembershipView.load(bars, index, exclude);
  const fromMs = Date.parse(from) - 120 * DAY, toMs = Date.parse(to) + 10 * DAY;
  const series = loadSessionSeries(bars, [...new Set(["SPY", ...membership.overlapping(fromMs, toMs)])], "alpaca_wide", "1d", fromMs, toMs, "us");
  bars.close();
  const spy = series.get("SPY");
  if (!spy) throw new Error("no SPY bars: the session calendar comes from SPY");

  const sdb = new Database(signalsPath, { readonly: true });
  const result: Record<string, CountResult & { config: CopySignalConfig }> = {};
  for (const [name, cfg] of Object.entries(configs)) {
    const events = loadSignalEvents(sdb, cfg.source, fromMs - cfg.lookbackDays * DAY, toMs);
    const book = new SignalBook(events, "us");
    const r = countPicks(cfg, { series, sessions: spy.dates, membership, book }, from, to);
    result[name] = { config: cfg, ...r };
    const t = r.total;
    console.log(`\n${name}: ${t.picksPerYear.toFixed(1)} new picks/yr, mean held ${t.meanHeld.toFixed(2)} of ${cfg.topN} (mean gross ${t.meanGross.toFixed(2)}), days with ≥1 held ${(t.shareDaysWithPick * 100).toFixed(0)}%, ${t.uniqueSymbols} distinct symbols`);
    for (const [y, c] of Object.entries(r.years)) console.log(`  ${y}  new picks ${String(c.newPicks).padStart(3)}  renewals ${String(c.renewals).padStart(2)}  mean held ${(c.heldSum / c.decisions).toFixed(1).padStart(4)}  days≥1 ${(100 * c.daysWithPick / c.decisions).toFixed(0)}%`);
  }
  sdb.close();
  const out = flag("--out");
  if (out) writeFileSync(out, JSON.stringify({ from, to, barsPath: "hist-sp500.db", signals: "signals.db", result }, null, 2));
}

if (import.meta.main) main();
