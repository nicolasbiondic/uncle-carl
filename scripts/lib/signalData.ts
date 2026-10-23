// ══════════════════════════════════════════════════════════════════════
// Signal events — research data views for the copy-trading line.
//
// signals.db (researchDataPath("signals.db"), never in git) holds ONE shared
// table, written by several producers (SEC Form 4 purchases here, Hyperliquid
// events by another agent) and read by the research runner:
//
//   signal_events(source TEXT, symbol TEXT, known_at_ms INTEGER,
//                 weight REAL, meta_json TEXT)
//
//   - known_at_ms: the instant the event became public (never the event's own
//     time). A decision may use an event only if known_at_ms <= its cutoff.
//   - weight: the producer's magnitude (SEC: dollar value of the purchase).
//   - meta_json: producer-specific JSON; `actors` (string[]) is the generic
//     key the engine reads to count DISTINCT actors behind a symbol.
//
// SessionSignalView is the contract's SignalView over loaded events: the
// no-look-ahead guarantee lives HERE (like SessionPriceView for bars).
// No live code imports this module.
// ══════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type { SessionDate, SignalEvent, SignalView } from "../../src/portfolio-engine/types";
import { getETDayBounds } from "../../src/db/database";
import { researchDataPath } from "./researchData";
import type { SessionCalendar } from "./portfolioData";

export const SIGNALS_DB_FILE = "signals.db";

/** Exactly the shared format: do not add, rename or retype columns. */
export const SIGNAL_EVENTS_DDL =
  "CREATE TABLE IF NOT EXISTS signal_events(source TEXT, symbol TEXT, known_at_ms INTEGER, weight REAL, meta_json TEXT)";
const SIGNAL_EVENTS_INDEX =
  "CREATE INDEX IF NOT EXISTS signal_events_source_known ON signal_events(source, known_at_ms)";

export function defaultSignalsDbPath(): string {
  return researchDataPath(SIGNALS_DB_FILE);
}

/** Open (creating if needed) a signals database for writing. */
export function openSignalsDbForWrite(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SIGNAL_EVENTS_DDL);
  db.exec(SIGNAL_EVENTS_INDEX);
  return db;
}

export interface SignalRow { source: string; symbol: string; known_at_ms: number; weight: number; meta_json: string }

/** Replace ALL rows of `source` with `rows` in one transaction (idempotent rebuilds; other sources untouched). */
export function replaceSourceRows(db: Database, source: string, rows: Iterable<SignalRow>): number {
  const del = db.prepare("DELETE FROM signal_events WHERE source = ?");
  const ins = db.prepare("INSERT INTO signal_events(source, symbol, known_at_ms, weight, meta_json) VALUES (?, ?, ?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    del.run(source);
    for (const r of rows) { ins.run(r.source, r.symbol, r.known_at_ms, r.weight, r.meta_json); n++; }
  })();
  return n;
}

function parseMeta(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Events of `source` with fromMs <= known_at_ms < toMs, oldest first (ties: symbol, weight, meta — deterministic). */
export function loadSignalEvents(db: Database, source: string, fromMs: number, toMs: number): SignalEvent[] {
  const rows = db.prepare(
    `SELECT source, symbol, known_at_ms, weight, meta_json FROM signal_events
     WHERE source = ? AND known_at_ms >= ? AND known_at_ms < ?
     ORDER BY known_at_ms ASC, symbol ASC, weight ASC, meta_json ASC`,
  ).all(source, fromMs, toMs) as SignalRow[];
  return rows.map(r => ({ source: r.source, symbol: r.symbol, knownAtMs: r.known_at_ms, weight: r.weight ?? 0, meta: parseMeta(r.meta_json) }));
}

/** Earliest and latest known_at_ms of a source over the WHOLE table (null when it has no rows). */
export function signalCoverage(db: Database, source: string): { firstMs: number; lastMs: number } | null {
  const r = db.prepare("SELECT min(known_at_ms) a, max(known_at_ms) b, count(*) n FROM signal_events WHERE source = ?").get(source) as { a: number | null; b: number | null; n: number };
  return r.n > 0 && r.a !== null && r.b !== null ? { firstMs: r.a, lastMs: r.b } : null;
}

/** A source may end this long before a window ends (weekends, holidays, a quiet fortnight) before the window counts as uncovered. */
export const SIGNAL_COVERAGE_TOLERANCE_MS = 31 * 86_400_000;

/**
 * Fail closed on a window the events do not cover: the source must start at least `lookbackDays`
 * before the window (the first decision sees a full lookback) and run to within the tolerance of
 * its end. Otherwise the uncovered stretch would silently read as "no events" = cash.
 */
export function assertSignalCoverage(cov: { firstMs: number; lastMs: number } | null, source: string, fromMs: number, toMs: number, lookbackDays: number): void {
  if (!cov) throw new Error(`signals: source "${source}" has no rows`);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (cov.firstMs > fromMs - lookbackDays * 86_400_000) {
    throw new Error(`signals: source "${source}" starts ${iso(cov.firstMs)}, after the first decision's ${lookbackDays}-day lookback of the window ${iso(fromMs)} → ${iso(toMs)}`);
  }
  if (toMs - cov.lastMs > SIGNAL_COVERAGE_TOLERANCE_MS) {
    throw new Error(`signals: source "${source}" ends ${iso(cov.lastMs)} but the window ends ${iso(toMs)}: shorten the window or extend the data (an uncovered stretch would read as no events)`);
  }
}

/** SHA-256 over the rows a replay can consume (every row of `sources` known before toMs), independent of rowid/insertion order. */
export function hashSignalEvents(dbPath: string, sources: readonly string[], toMs: number): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const hash = createHash("sha256");
    for (const source of [...new Set(sources)].sort()) {
      const rows = db.prepare(
        `SELECT symbol, known_at_ms, weight, meta_json FROM signal_events
         WHERE source = ? AND known_at_ms < ?
         ORDER BY known_at_ms ASC, symbol ASC, weight ASC, meta_json ASC`,
      ).all(source, toMs) as Array<{ symbol: string; known_at_ms: number; weight: number | null; meta_json: string | null }>;
      if (rows.length === 0) throw new Error(`signal_events has no rows for source "${source}" known before ${new Date(toMs).toISOString()} in ${dbPath}`);
      hash.update(`signals:${source}:${rows.length}\n`);
      for (const r of rows) hash.update(`${r.symbol}|${r.known_at_ms}|${r.weight ?? ""}|${r.meta_json ?? ""}\n`);
    }
    return hash.digest("hex");
  } finally {
    db.close();
  }
}

// ── the point-in-time view ───────────────────────────────────────────────

const DAY_MS = 86_400_000;

function addDays(date: SessionDate, days: number): SessionDate {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** [startMs, endMs) of the session day under the calendar (ET day for US sessions, UTC day otherwise). */
export function sessionDayBounds(date: SessionDate, calendar: SessionCalendar): [number, number] {
  if (calendar === "utc") { const s = Date.parse(date); return [s, s + DAY_MS]; }
  return getETDayBounds(date);
}

/** First index in `a` (sorted by knownAtMs) with knownAtMs > x. */
function upperBound(a: readonly SignalEvent[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].knownAtMs <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Events indexed once per replay (per source, sorted); `at(asOf)` is a cheap per-session view. */
export class SignalBook {
  private readonly bySource = new Map<string, SignalEvent[]>();
  constructor(events: readonly SignalEvent[], readonly calendar: SessionCalendar) {
    for (const e of events) (this.bySource.get(e.source) ?? this.bySource.set(e.source, []).get(e.source)!).push(e);
    for (const list of this.bySource.values()) list.sort((a, b) => a.knownAtMs - b.knownAtMs);
  }
  at(asOf: SessionDate): SessionSignalView {
    return new SessionSignalView(this.bySource, asOf, this.calendar);
  }
}

/**
 * The contract's SignalView. `asOf` is the last COMPLETED session; the cutoff is
 * the end of that session's day, so an event known after it (the execution day
 * or later) is invisible even though the book holds the whole replay window.
 */
export class SessionSignalView implements SignalView {
  readonly cutoffMs: number;
  constructor(private readonly bySource: ReadonlyMap<string, readonly SignalEvent[]>, readonly asOf: SessionDate, private readonly calendar: SessionCalendar) {
    this.cutoffMs = sessionDayBounds(asOf, calendar)[1] - 1;
  }

  events(source: string, lookbackDays: number): readonly SignalEvent[] {
    const list = this.bySource.get(source);
    if (!list || !(lookbackDays > 0)) return [];
    // Calendar window: the last `lookbackDays` days INCLUDING the asOf day.
    const lowerMs = sessionDayBounds(addDays(this.asOf, -(Math.floor(lookbackDays) - 1)), this.calendar)[0];
    const end = upperBound(list, this.cutoffMs);
    const start = upperBound(list, lowerMs - 1);
    return list.slice(start, end);
  }
}
