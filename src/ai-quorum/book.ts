// Shadow book mechanics (línea D). Pure math + an idempotent lazy fill pass.
//
// Fill rule (pre-registered): entry = OPEN of the first daily bar whose
// timestamp is strictly AFTER the decision time; exit = OPEN of the bar after
// that (one-day hold). Stock daily bars are stamped 04:00 UTC (their open is
// that session's 09:30 ET print) and crypto dailies 00:00 UTC — so a 21:15
// UTC stock decision fills at the NEXT session's open and a 00:15 UTC crypto
// decision fills at the next 00:00 UTC bar, exactly §12-D's wording. Bars
// arrive in historical.db with the daily 04:00 refresh, so fills lag the
// decision by a refresh cycle — every run executes this pass first and fills
// whatever has become fillable. Idempotent: a priced leg is never re-priced.
//
// Costs per SIDE: 2 bps stocks, 9 bps crypto; a round trip pays both sides.
// Notional is fictitious ($100k per decision day, equal-weighted across that
// day's positions) — returns are all that matters, no capital exists.

import type { Database } from "bun:sqlite";
import type { AssetClass } from "./types";
import { COST_BPS_PER_SIDE } from "./types";

export interface FillLegs { entryTs: number | null; entryPx: number | null; exitTs: number | null; exitPx: number | null; }

/** Pure: pick entry/exit opens from the daily bars AFTER the decision. */
export function computeFill(
  bars: Array<{ ts: number; open: number }>,
  decidedAt: number,
): FillLegs {
  const after = bars.filter((b) => b.ts > decidedAt).sort((a, b) => a.ts - b.ts);
  return {
    entryTs: after[0]?.ts ?? null,
    entryPx: after[0]?.open ?? null,
    exitTs: after[1]?.ts ?? null,
    exitPx: after[1]?.open ?? null,
  };
}

/** Net one-day return of a shadow position: direction×(exit/entry−1) − 2 sides of costs. */
export function netReturn(direction: number, entryPx: number, exitPx: number, assetClass: AssetClass): number {
  return grossReturn(direction, entryPx, exitPx) - (2 * COST_BPS_PER_SIDE[assetClass]) / 10_000;
}

export function grossReturn(direction: number, entryPx: number, exitPx: number): number {
  return direction * (exitPx / entryPx - 1);
}

/**
 * Lazy fill pass over EVERY snapshot symbol (not only quorum positions: the
 * same real opens price the benchmarks and the per-model books). Reads
 * historical.db read-only, writes only ai-quorum.db. Safe to run on every
 * invocation.
 */
export function fillPendingFills(qdb: Database, hist: Database, now: number): number {
  const snapshots = qdb.query<{ id: number; decided_at: number; payload: string }, []>(
    `SELECT id, decided_at, payload FROM snapshots
     WHERE id IN (
       SELECT DISTINCT s.id FROM snapshots s
       LEFT JOIN fills f ON f.snapshot_id = s.id
       WHERE f.snapshot_id IS NULL OR f.exit_px IS NULL
     )`,
  ).all();
  const barQuery = hist.query<{ timestamp: number; open: number }, [string, number]>(
    `SELECT timestamp, open FROM historical_bars
     WHERE symbol = ? AND timeframe = '1d' AND timestamp > ?
     ORDER BY timestamp ASC LIMIT 2`,
  );
  const upsert = qdb.query(
    `INSERT INTO fills (snapshot_id, symbol, entry_ts, entry_px, exit_ts, exit_px)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (snapshot_id, symbol) DO UPDATE SET
       entry_ts = COALESCE(fills.entry_ts, excluded.entry_ts),
       entry_px = COALESCE(fills.entry_px, excluded.entry_px),
       exit_ts  = COALESCE(fills.exit_ts,  excluded.exit_ts),
       exit_px  = COALESCE(fills.exit_px,  excluded.exit_px)`,
  );
  let updated = 0;
  for (const snap of snapshots) {
    let symbols: string[] = [];
    try {
      const payload = JSON.parse(snap.payload);
      symbols = (payload?.symbols ?? []).map((s: any) => s.symbol).filter(Boolean);
    } catch { continue; }
    for (const symbol of symbols) {
      const bars = barQuery.all(symbol, snap.decided_at)
        .map((b) => ({ ts: b.timestamp, open: b.open }))
        .filter((b) => b.ts <= now);
      const legs = computeFill(bars, snap.decided_at);
      if (legs.entryPx == null && legs.exitPx == null) {
        // Still ensure the row exists so the snapshot shows as pending-fill.
        upsert.run(snap.id, symbol, null, null, null, null);
        continue;
      }
      upsert.run(snap.id, symbol, legs.entryTs, legs.entryPx, legs.exitTs, legs.exitPx);
      updated++;
    }
  }
  return updated;
}
