// ══════════════════════════════════════════════
// Per-sleeve DAILY return series (r_t) — measurement instrument, no
// trading effect. Derives one observation per completed ET day from
// equity_snapshots via getDisplayEquitySeries (semantics-era aware,
// synthetic rows excluded), for the capital-allocation research track:
// no allocation method is even expressible without this series.
//
// Design decisions (each deliberate, see AGENTS.md "ET-aware time"):
//
//  • ET day boundaries via getETDateKey — never setHours(0,0,0,0).
//  • ONE observation per ET day: the LAST snapshot of the day. For 24/7
//    Binance sleeves the ET-midnight boundary IS the daily close; for
//    Alpaca sleeves equity is frozen after the 16:00 ET close (positions
//    marked at last price), so the last snapshot of the day equals the
//    end-of-day mark — one uniform rule for both. Intraday snapshots are
//    never separate observations (intraday trading alone does not
//    produce portfolio returns).
//  • The CURRENT ET day is excluded — its "close" hasn't happened yet; a
//    partial-day return is a different (shorter) horizon and would
//    contaminate the daily series.
//  • A return across a semantics-era boundary that is not a declared
//    "continuous" continuation is EXCLUDED (an explicit gap with cause
//    "era_boundary"), never computed: a rebase keeps $ deltas honest but
//    the % base never literally existed, and discontinuous boundaries
//    trust neither — the exact policy getEquityPnlDisplay applies when it
//    nulls pnlPct/fails closed. Enforced via DisplayEquityRow.segment.
//  • Grid: Alpaca sleeves observe on ET TRADING days (Sat/Sun dropped —
//    equity is structurally frozen, a weekend 0% is not an observation of
//    the strategy; ~252 obs/yr). Binance sleeves observe on CALENDAR days
//    (perps trade 24/7; ~365 obs/yr). Market holidays on the Alpaca grid
//    still yield structural 0% observations (rare; documented limitation).
//  • A day on the grid with no snapshots (or a non-adjacent pair) is a gap
//    with cause "missing_snapshots" — never a multi-day return disguised
//    as a daily one.
//
// Nature of the equity being differenced (document, don't hide):
//  • Alpaca sleeves (momentum_stocks, meanrev_stocks — LEDGER_SLEEVE_BROKERS)
//    carry a COMPUTED ledger (initial + realized + unrealized of their own
//    trades) because they share one physical wallet.
//  • Binance sleeves read their own margin-pool balance from the broker
//    every 60s (broker truth, includes funding).
//    The two series are honest for their sleeve but are not identically
//    sourced; `equitySource` labels each.
//
// Shadow sleeves: a sleeve demoted to shadow keeps SNAPSHOTTING (the 5-min
// snapshot loop is mode-independent) — its real-equity series stays valid
// for whatever is still open, it just stops moving on new entries. So
// "flat because shadow" and "silent because broken" are distinguished by
// DATA FLOW, not by price movement: `seriesFresh` (last snapshot within
// stalenessMs) plus `mode` (from sleeve_modes). shadow+fresh = healthy,
// idle by design; anything+stale = the measurement pipeline itself is down.
// ══════════════════════════════════════════════

import { getDB, getDisplayEquitySeries, getETDateKey } from "../db/database";
import { RISK_PROFILES, LEDGER_SLEEVE_BROKERS, type RiskProfileId } from "../config/riskProfiles";

export interface DailyReturnObservation {
  /** ET date (YYYY-MM-DD) of the day the return is FOR (the "t" in r_t). */
  dateKey: string;
  /** Simple return: equity_t / equity_{t-1} − 1, both end-of-ET-day marks. */
  ret: number;
  equity: number;
  prevEquity: number;
  /** snapshot_time of the end-of-day mark used for equity_t. */
  snapshotTime: number;
}

export type GapCause = "era_boundary" | "missing_snapshots" | "unusable_base";

export interface ReturnGap {
  /** Last observed grid day before the hole. */
  fromDate: string;
  /** First observed grid day after the hole. */
  toDate: string;
  cause: GapCause;
}

export interface SleeveReturnSeries {
  profileId: string;
  /** Observation grid — ET trading days (Alpaca) or calendar days (Binance). */
  grid: "trading_days" | "calendar_days";
  /** Annualization factor consistent with `grid`. */
  obsPerYear: 252 | 365;
  /** How the underlying equity is sourced (see module doc). */
  equitySource: "ledger" | "broker_truth";
  returns: DailyReturnObservation[];
  /** Valid daily return observations (= returns.length). */
  nObservations: number;
  /** End-of-day equity marks found (each yields at most one return). */
  nDailyMarks: number;
  gaps: ReturnGap[];
  /** Exact-0 observations (structurally flat days, e.g. market holidays on
   *  the trading grid, or genuinely positionless days). */
  zeroReturnCount: number;
  /** Governor mode from sleeve_modes; null = no row / table (ungoverned). */
  mode: "live" | "shadow" | null;
  modeSince: number | null;
  lastSnapshotAt: number | null;
  /** Last snapshot within stalenessMs of now — the pipeline is writing. */
  seriesFresh: boolean;
  /** "ok" = data flowing (even if shadow/flat); "stale" = snapshot pipeline
   *  silent (broken or decommissioned); "no_data" = series empty. */
  status: "ok" | "stale" | "no_data";
}

// ── ET-date-key arithmetic (pure string/UTC-ms math on YYYY-MM-DD keys;
//    keys come exclusively from getETDateKey, so ET awareness is upstream) ──

const DAY_MS = 86_400_000;

function keyToUtcMs(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0=Sun … 6=Sat for a date key (day-of-week is time-of-day-independent). */
function dowOfKey(key: string): number {
  return new Date(keyToUtcMs(key)).getUTCDay();
}

function isWeekend(key: string): boolean {
  const dow = dowOfKey(key);
  return dow === 0 || dow === 6;
}

/** Next expected grid day after `key` (skips Sat/Sun on the trading grid). */
export function nextGridDay(key: string, tradingDays: boolean): string {
  let ms = keyToUtcMs(key);
  do { ms += DAY_MS; } while (tradingDays && isWeekend(utcMsToKey(ms)));
  return utcMsToKey(ms);
}

function getSleeveMode(sleeve: string): { mode: "live" | "shadow" | null; modeSince: number | null } {
  try {
    const row = getDB().prepare(`SELECT mode, updated_at FROM sleeve_modes WHERE sleeve = ?`).get(sleeve) as
      | { mode: string; updated_at: number | null } | undefined;
    if (row?.mode === "live" || row?.mode === "shadow") return { mode: row.mode, modeSince: row.updated_at ?? null };
  } catch {
    // sleeve_modes may not exist (governor never constructed) — mode unknown,
    // NOT an error: the series itself is still fully usable.
  }
  return { mode: null, modeSince: null };
}

export interface SleeveReturnOptions {
  /** Injectable clock (tests). */
  now?: number;
  /** Freshness threshold for `seriesFresh`; snapshots are written every
   *  5min, so 30min of silence means the pipeline is down. */
  stalenessMs?: number;
}

export function getDailySleeveReturns(profileId: string, opts: SleeveReturnOptions = {}): SleeveReturnSeries {
  const now = opts.now ?? Date.now();
  const stalenessMs = opts.stalenessMs ?? 30 * 60_000;

  const broker = RISK_PROFILES[profileId as RiskProfileId]?.broker;
  const tradingDays = broker != null && !broker.startsWith("binance"); // alpaca ⇒ ET trading-day grid
  const grid: SleeveReturnSeries["grid"] = tradingDays ? "trading_days" : "calendar_days";
  const obsPerYear = tradingDays ? 252 : 365;
  const equitySource: SleeveReturnSeries["equitySource"] =
    broker != null && LEDGER_SLEEVE_BROKERS.has(broker) ? "ledger" : "broker_truth";
  const { mode, modeSince } = getSleeveMode(profileId);

  const series = getDisplayEquitySeries(profileId); // semantics-aware, synthetic=0 only, ASC
  const lastSnapshotAt = series.length > 0 ? series[series.length - 1].snapshot_time : null;
  const seriesFresh = lastSnapshotAt != null && now - lastSnapshotAt <= stalenessMs;

  const base: Omit<SleeveReturnSeries, "returns" | "nObservations" | "nDailyMarks" | "gaps" | "zeroReturnCount" | "status"> = {
    profileId, grid, obsPerYear, equitySource, mode, modeSince, lastSnapshotAt, seriesFresh,
  };

  if (series.length === 0) {
    return { ...base, returns: [], nObservations: 0, nDailyMarks: 0, gaps: [], zeroReturnCount: 0, status: "no_data" };
  }

  // ── One end-of-day mark per ET day: last snapshot of the day wins (series
  //    is ASC by snapshot_time,id; Map preserves first-seen key order and
  //    dateKey is monotonic in snapshot_time). ──
  const todayKey = getETDateKey(now);
  const marks = new Map<string, { equity: number; segment: number; snapshotTime: number }>();
  for (const row of series) {
    const dateKey = getETDateKey(row.snapshot_time);
    if (dateKey === todayKey) continue;                 // current day: no close yet
    if (tradingDays && isWeekend(dateKey)) continue;    // structurally frozen — not an observation
    // rawEquity, NOT the splice-adjusted `equity`: within a segment the splice
    // offset is constant, and (raw+c)/(raw'+c) is not the return of any
    // balance that ever existed. The segment guard below already forbids
    // crossing the boundaries the offset exists to bridge.
    marks.set(dateKey, { equity: row.rawEquity, segment: row.segment, snapshotTime: row.snapshot_time });
  }

  const points = [...marks.entries()].map(([dateKey, m]) => ({ dateKey, ...m }));
  const returns: DailyReturnObservation[] = [];
  const gaps: ReturnGap[] = [];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1], cur = points[i];
    const gap = (cause: GapCause) => gaps.push({ fromDate: prev.dateKey, toDate: cur.dateKey, cause });
    if (cur.dateKey !== nextGridDay(prev.dateKey, tradingDays)) {
      // ≥1 grid day without a mark in between — a multi-day delta is NOT a
      // daily return; record the hole and move on.
      gap("missing_snapshots");
      continue;
    }
    if (cur.segment !== prev.segment) {
      gap("era_boundary");
      continue;
    }
    if (prev.equity <= 0) {
      gap("unusable_base");
      continue;
    }
    returns.push({
      dateKey: cur.dateKey,
      ret: cur.equity / prev.equity - 1,
      equity: cur.equity,
      prevEquity: prev.equity,
      snapshotTime: cur.snapshotTime,
    });
  }

  return {
    ...base,
    returns,
    nObservations: returns.length,
    nDailyMarks: points.length,
    gaps,
    zeroReturnCount: returns.filter(r => r.ret === 0).length,
    status: seriesFresh ? "ok" : "stale",
  };
}
