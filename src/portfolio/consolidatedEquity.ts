// ═══ Consolidated equity series — ONE builder for every consumer ═══
//
// Extracted verbatim from GET /api/equity/history's consolidated branch
// (src/dashboard/routes/strategies.ts, 2026-10-09 P0) so the KPI snapshot
// (src/portfolio/kpis.ts) and the Telegram digest read the SAME series the
// dashboard chart shows — never a parallel re-derivation that can drift.
//
// Semantics preserved exactly (locked by routes/strategies.test.ts through
// the route): aggregate of the *_main broker-truth legs (alpaca_main +
// binance_main, + binance_coinm_main once DAPI has EVER snapshotted), 5-min
// bucketing, per-leg last-known carry bounded by BROKER_SNAPSHOT_MAX_AGE_MS,
// COIN-M pre-genesis synthetic baseline marked `rebased`, and a bucket only
// emitted when EVERY leg has a fresh-enough reading.

import { getEquityHistoryByRangeDisplay, type DisplayEquityRow } from "../db/database";
import { BROKER_SNAPSHOT_MAX_AGE_MS, isMainSeriesApplicable } from "./truth";

export interface ConsolidatedEquityPoint {
  snapshot_time: number;
  equity: number;
  cash: number;
  rebased: boolean;
}

/**
 * Build the consolidated series. `fetchLeg` supplies each leg's display rows
 * (the route passes its range/days closure; KPI consumers pass a range) —
 * DISPLAY_HISTORY_START is respected by the Display fetchers themselves.
 */
export function buildConsolidatedEquitySeries(
  fetchLeg: (profileId: string) => DisplayEquityRow[],
): ConsolidatedEquityPoint[] {
  const coreLegs = ["alpaca_main", "binance_main"];
  // binance_coinm_main (DAPI) joins the curve only once it has EVER recorded
  // a snapshot (mirrors isMainSeriesApplicable). Fetched at full "all"
  // history unconditionally so its genesis timestamp/value are known
  // regardless of the requested window.
  const coinmApplicable = isMainSeriesApplicable("coinm");
  const coinmGenesis = coinmApplicable ? getEquityHistoryByRangeDisplay("binance_coinm_main", "all")[0] : undefined;
  const coinmGenesisBucket = coinmGenesis ? Math.floor(coinmGenesis.snapshot_time / 300_000) * 300_000 : 0;
  const legs = coinmGenesis ? [...coreLegs, "binance_coinm_main"] : coreLegs;

  const profileData: Record<string, Map<number, { equity: number; cash: number; rebased: boolean }>> = {};
  const allBuckets = new Set<number>();

  for (const pid of legs) {
    const rows = fetchLeg(pid);
    const map = new Map<number, { equity: number; cash: number; rebased: boolean }>();
    for (const r of rows) {
      const bucket = Math.floor(r.snapshot_time / 300_000) * 300_000;
      map.set(bucket, { equity: r.equity, cash: r.cash, rebased: r.rebased });
      allBuckets.add(bucket);
    }
    profileData[pid] = map;
  }

  const sortedBuckets = [...allBuckets].sort((a, b) => a - b);
  const lastKnown: Record<string, { equity: number; cash: number; rebased: boolean; at: number }> = {};
  const result: ConsolidatedEquityPoint[] = [];

  for (const bucket of sortedBuckets) {
    let totalEquity = 0, totalCash = 0, anyRebased = false, allKnown = true;
    for (const pid of legs) {
      const val = profileData[pid]?.get(bucket);
      if (val) lastKnown[pid] = { ...val, at: bucket };

      if (pid === "binance_coinm_main" && coinmGenesis && bucket < coinmGenesisBucket) {
        // DAPI hadn't launched yet at this point in history — use its
        // first-ever observed reading as a constant synthetic baseline
        // (mandate 2026-07-19) instead of dropping the whole bucket. Marked
        // rebased: this leg's contribution here is synthetic.
        totalEquity += coinmGenesis.equity; totalCash += coinmGenesis.cash;
        anyRebased = true;
        continue;
      }

      // A one-leg-missing point is a plausible-looking partial portfolio
      // total — every leg must have a fresh-enough last known reading.
      if (lastKnown[pid] && bucket - lastKnown[pid].at <= BROKER_SNAPSHOT_MAX_AGE_MS) {
        totalEquity += lastKnown[pid].equity; totalCash += lastKnown[pid].cash;
        if (lastKnown[pid].rebased) anyRebased = true;
      } else {
        allKnown = false;
      }
    }
    if (allKnown) {
      result.push({ snapshot_time: bucket, equity: totalEquity, cash: totalCash, rebased: anyRebased });
    }
  }

  return result;
}
