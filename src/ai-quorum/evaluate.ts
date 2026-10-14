// Automated §12-D evaluation (pre-registered, forward-only):
//   - verdict date = first decision WITH model views + 8 weeks, needing
//     ≥ 40 sessions with views;
//   - VALIDADO iff the shadow book, NET of costs, has Sharpe ≥ 1.0 AND beats
//     in Sharpe BOTH benchmarks on the same symbols and days:
//       (a) equal-weight long;  (b) sign of the 21-day momentum;
//     otherwise the line is redesigned. No capital is ever involved.
//
// Measurement conventions (declared here, not tunable):
//   - a "session" is a UTC date key with ≥1 snapshot that has model views;
//   - daily series are built over sessions whose fills are complete; the
//     book/model return of a session with views but zero positions is 0
//     (the strategy chose to stay flat — that IS a return observation);
//   - benchmarks pay the same per-side costs as the book (fair comparison);
//   - per-model shadow books take every non-neutral view with confidence
//     ≥ 0.6 (the same bar the quorum uses), equal-weighted;
//   - hit rate = share of positions whose GROSS directional return > 0;
//   - Sharpe annualized with √252 on the pooled stocks+crypto daily series.

import type { Database } from "bun:sqlite";
import { grossReturn, netReturn } from "./book";
import type { AssetClass, ModelViews, QuorumPosition } from "./types";
import { QUORUM_MIN_CONFIDENCE, VERDICT_MIN_SESSIONS, VERDICT_WEEKS } from "./types";

export interface EvalSnapshot {
  dateKey: string;
  assetClass: AssetClass;
  symbols: string[];
  /** 21d return per symbol from the stored snapshot (momentum-sign benchmark). */
  ret21: Record<string, number | null>;
  viewsByModel: Record<string, ModelViews>;
  quorum: QuorumPosition[];
  /** Complete fills only (both legs priced). */
  fills: Record<string, { entryPx: number; exitPx: number }>;
}

export interface SeriesStats {
  sharpe: number | null;
  hitRate: number | null;
  nDays: number;
  nPositions: number;
  /** Cumulative compounded curve, one point per session (dateKey asc). */
  curve: Array<{ dateKey: string; ret: number; cum: number }>;
}

export interface Evaluation {
  firstViewsDate: string | null;
  verdictDate: string | null;        // firstViewsDate + 8 weeks
  sessionsWithViews: number;
  sessionsRequired: number;
  book: SeriesStats;
  benchEwLong: SeriesStats;
  benchMom21: SeriesStats;
  models: Record<string, SeriesStats>;
  /** null until the verdict date AND the session minimum are both reached. */
  verdict: "VALIDADO" | "REFUTADO" | null;
}

function sharpeOf(rets: number[]): number | null {
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  return (mean / sd) * Math.sqrt(252);
}

function buildStats(perDay: Map<string, { sum: number; n: number }>, hits: { won: number; total: number }): SeriesStats {
  const keys = [...perDay.keys()].sort();
  const rets: number[] = [];
  const curve: SeriesStats["curve"] = [];
  let cum = 1;
  for (const k of keys) {
    const d = perDay.get(k)!;
    const ret = d.n > 0 ? d.sum / d.n : 0;
    rets.push(ret);
    cum *= 1 + ret;
    curve.push({ dateKey: k, ret, cum });
  }
  return {
    sharpe: sharpeOf(rets),
    hitRate: hits.total > 0 ? hits.won / hits.total : null,
    nDays: keys.length,
    nPositions: hits.total,
    curve,
  };
}

/** Accumulate one position's return into a per-day equal-weight aggregate. */
function acc(map: Map<string, { sum: number; n: number }>, dateKey: string, ret: number): void {
  const cur = map.get(dateKey) ?? { sum: 0, n: 0 };
  cur.sum += ret; cur.n++;
  map.set(dateKey, cur);
}

/** Ensure the day exists in the series even if flat (0 positions → ret 0). */
function touch(map: Map<string, { sum: number; n: number }>, dateKey: string): void {
  if (!map.has(dateKey)) map.set(dateKey, { sum: 0, n: 0 });
}

export function evaluate(snapshots: EvalSnapshot[], now: number): Evaluation {
  const withViews = snapshots.filter((s) => Object.keys(s.viewsByModel).length > 0);
  const sessionKeys = new Set(withViews.map((s) => s.dateKey));
  const firstViewsDate = withViews.length > 0 ? [...sessionKeys].sort()[0] : null;
  const verdictDate = firstViewsDate
    ? new Date(Date.parse(firstViewsDate + "T00:00:00Z") + VERDICT_WEEKS * 7 * 86_400_000).toISOString().slice(0, 10)
    : null;

  // Only sessions with views AND complete fills enter the series.
  const usable = withViews.filter((s) => Object.keys(s.fills).length > 0);

  const bookDays = new Map<string, { sum: number; n: number }>();
  const ewDays = new Map<string, { sum: number; n: number }>();
  const momDays = new Map<string, { sum: number; n: number }>();
  const modelDays = new Map<string, Map<string, { sum: number; n: number }>>();
  const bookHits = { won: 0, total: 0 };
  const ewHits = { won: 0, total: 0 };
  const momHits = { won: 0, total: 0 };
  const modelHits = new Map<string, { won: number; total: number }>();

  for (const s of usable) {
    touch(bookDays, s.dateKey);
    // Quorum book.
    for (const p of s.quorum) {
      const f = s.fills[p.symbol];
      if (!f) continue;
      acc(bookDays, s.dateKey, netReturn(p.direction, f.entryPx, f.exitPx, s.assetClass));
      bookHits.total++;
      if (grossReturn(p.direction, f.entryPx, f.exitPx) > 0) bookHits.won++;
    }
    // Benchmarks + model books over the full snapshot universe.
    for (const symbol of s.symbols) {
      const f = s.fills[symbol];
      if (!f) continue;
      // (a) equal-weight long.
      acc(ewDays, s.dateKey, netReturn(1, f.entryPx, f.exitPx, s.assetClass));
      ewHits.total++;
      if (grossReturn(1, f.entryPx, f.exitPx) > 0) ewHits.won++;
      // (b) sign of 21d momentum (flat when unknown or exactly 0 — no cost).
      const r21 = s.ret21[symbol];
      const dir = r21 == null || r21 === 0 ? 0 : r21 > 0 ? 1 : -1;
      touch(momDays, s.dateKey);
      if (dir !== 0) {
        acc(momDays, s.dateKey, netReturn(dir, f.entryPx, f.exitPx, s.assetClass));
        momHits.total++;
        if (grossReturn(dir, f.entryPx, f.exitPx) > 0) momHits.won++;
      }
    }
    // Per-model shadow books.
    for (const [modelId, views] of Object.entries(s.viewsByModel)) {
      if (!modelDays.has(modelId)) modelDays.set(modelId, new Map());
      if (!modelHits.has(modelId)) modelHits.set(modelId, { won: 0, total: 0 });
      const days = modelDays.get(modelId)!;
      const hits = modelHits.get(modelId)!;
      touch(days, s.dateKey);
      for (const symbol of s.symbols) {
        const v = views[symbol];
        const f = s.fills[symbol];
        if (!v || !f || v.view === "neutral" || v.confidence < QUORUM_MIN_CONFIDENCE) continue;
        const dir = v.view === "long" ? 1 : -1;
        acc(days, s.dateKey, netReturn(dir, f.entryPx, f.exitPx, s.assetClass));
        hits.total++;
        if (grossReturn(dir, f.entryPx, f.exitPx) > 0) hits.won++;
      }
    }
  }

  const book = buildStats(bookDays, bookHits);
  const benchEwLong = buildStats(ewDays, ewHits);
  const benchMom21 = buildStats(momDays, momHits);
  const models: Record<string, SeriesStats> = {};
  for (const [id, days] of modelDays) models[id] = buildStats(days, modelHits.get(id)!);

  let verdict: Evaluation["verdict"] = null;
  const today = new Date(now).toISOString().slice(0, 10);
  if (verdictDate && today >= verdictDate && sessionKeys.size >= VERDICT_MIN_SESSIONS) {
    const ok = book.sharpe != null && book.sharpe >= 1.0
      && (benchEwLong.sharpe == null || book.sharpe > benchEwLong.sharpe)
      && (benchMom21.sharpe == null || book.sharpe > benchMom21.sharpe);
    verdict = ok ? "VALIDADO" : "REFUTADO";
  }

  return {
    firstViewsDate,
    verdictDate,
    sessionsWithViews: sessionKeys.size,
    sessionsRequired: VERDICT_MIN_SESSIONS,
    book,
    benchEwLong,
    benchMom21,
    models,
    verdict,
  };
}

/** Assemble EvalSnapshots from ai-quorum.db (read-only usage). */
export function loadEvalSnapshots(qdb: Database): EvalSnapshot[] {
  const snaps = qdb.query<{ id: number; asset_class: AssetClass; date_key: string; payload: string }, []>(
    "SELECT id, asset_class, date_key, payload FROM snapshots ORDER BY date_key ASC",
  ).all();
  const viewsStmt = qdb.query<{ model_id: string; symbol: string; view: string; confidence: number }, [number]>(
    "SELECT model_id, symbol, view, confidence FROM model_views WHERE snapshot_id = ?",
  );
  const quorumStmt = qdb.query<{ symbol: string; direction: number; mean_confidence: number }, [number]>(
    "SELECT symbol, direction, mean_confidence FROM quorum_positions WHERE snapshot_id = ?",
  );
  const fillsStmt = qdb.query<{ symbol: string; entry_px: number | null; exit_px: number | null }, [number]>(
    "SELECT symbol, entry_px, exit_px FROM fills WHERE snapshot_id = ?",
  );
  const out: EvalSnapshot[] = [];
  for (const s of snaps) {
    let symbols: string[] = [];
    const ret21: Record<string, number | null> = {};
    try {
      const payload = JSON.parse(s.payload);
      for (const f of payload?.symbols ?? []) {
        if (!f?.symbol) continue;
        symbols.push(f.symbol);
        ret21[f.symbol] = typeof f.ret21 === "number" ? f.ret21 : null;
      }
    } catch { continue; }
    const viewsByModel: Record<string, ModelViews> = {};
    for (const v of viewsStmt.all(s.id)) {
      (viewsByModel[v.model_id] ??= {})[v.symbol] = { view: v.view as any, confidence: v.confidence };
    }
    const quorum: QuorumPosition[] = quorumStmt.all(s.id).map((q) => ({
      symbol: q.symbol, direction: q.direction as 1 | -1, meanConfidence: q.mean_confidence,
    }));
    const fills: EvalSnapshot["fills"] = {};
    for (const f of fillsStmt.all(s.id)) {
      if (f.entry_px != null && f.exit_px != null) fills[f.symbol] = { entryPx: f.entry_px, exitPx: f.exit_px };
    }
    out.push({ dateKey: s.date_key, assetClass: s.asset_class, symbols, ret21, viewsByModel, quorum, fills });
  }
  return out;
}
