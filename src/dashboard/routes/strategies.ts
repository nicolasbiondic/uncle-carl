// ═══ Strategy, symbol, and equity history routes ═══

import express from "express";
import type { AccountManager } from "../../account/AccountManager";
import {
  getEquityHistoryDisplay, getEquityHistoryByRangeDisplay,
} from "../../db/database";
import { getSymbolsByBroker } from "../../config/symbols";
import { toBoundedInt } from "../dashboard-utils";
import { BROKER_SNAPSHOT_MAX_AGE_MS, isMainSeriesApplicable } from "../../portfolio/truth";

export function registerStrategyRoutes(app: express.Application, _am: AccountManager): void {
  // 2026-07-22 route audit: removed /api/strategies and
  // /api/strategies/performance — zero refs in api.js, components, tests, or
  // scripts (dead-tabs.test.js explicitly asserts `api.strategies` is
  // undefined frontend-side). am.getActiveStrategies() stays in use
  // internally for getDashboardData; getStrategyPerformance in
  // db/database.ts is now orphaned (see report).

  // ── GET /api/symbols ────────────────────────────────────────────────────
  // kept: no frontend caller today, but server.test.ts asserts this stays
  // 200 (read-only ops/dashboard visibility) while the old mutation
  // /api/symbols/:symbol/toggle is gone. The engines receive their universe
  // explicitly (config/symbols.ts) so a mutation endpoint here would not
  // change what actually trades.
  app.get("/api/symbols", (_req, res) => res.json(getSymbolsByBroker()));

  // ── GET /api/equity/history ─────────────────────────────────────────────
  app.get("/api/equity/history", (req, res) => {
    const profileId = (req.query.profile_id as string) || (req.query.account as string) || "";
    const range     = req.query.range as string;

    // Consolidated: aggregate equity from broker totals (alpaca_main + binance_main
    // [+ binance_coinm_main once DAPI is applicable]). These rows are written by
    // syncAlpacaAccount/syncBinanceFutures/syncBinanceCoinM with the FULL broker
    // equity, so the curve matches the KPI bar and the broker cards exactly.
    // The previous behaviour summed the 4 individual profiles (alpaca_low/high +
    // binance_low/high), which only reflected the bot-managed slice — leaving
    // unallocated capital out and creating an apparent KPI vs curve mismatch.
    if (!profileId || profileId === "consolidated") {
      const coreLegs = ["alpaca_main", "binance_main"];
      // binance_coinm_main (DAPI) joins the curve only once it has EVER
      // recorded a snapshot (mirrors isMainSeriesApplicable — a never-
      // enabled sleeve must not appear at all, same as getPortfolioEquityNow's
      // "never turned on ⇒ $0, not present" contract). Fetched at full "all"
      // history unconditionally so its genesis (first-ever) timestamp/value
      // are known regardless of the requested `range`/`days` window.
      const coinmApplicable = isMainSeriesApplicable("coinm");
      const coinmGenesis = coinmApplicable ? getEquityHistoryByRangeDisplay("binance_coinm_main", "all")[0] : undefined;
      const coinmGenesisBucket = coinmGenesis ? Math.floor(coinmGenesis.snapshot_time / 300_000) * 300_000 : 0;
      const legs = coinmGenesis ? [...coreLegs, "binance_coinm_main"] : coreLegs;

      const profileData: Record<string, Map<number, { equity: number; cash: number; rebased: boolean }>> = {};
      const allBuckets = new Set<number>();

      for (const pid of legs) {
        const rows = range
          ? getEquityHistoryByRangeDisplay(pid, range)
          : getEquityHistoryDisplay(pid, toBoundedInt(req.query.days, 30, 0, 365));
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
      const result: { snapshot_time: number; equity: number; cash: number; rebased: boolean }[] = [];

      // R5 fix (2026-05-10): removed the "skip stale initial values" heuristic.
      // It was added to mask a pre-2026-05-04 bug where snapshots could be
      // written with stale config initial_equity until the first broker sync.
      // After the audit fixes, snapshots always carry the real equity value
      // from creation. With the backfilled alpaca_main/binance_main data,
      // this heuristic was incorrectly deleting valid initial buckets where
      // the value happened to be close to the bucket-0 value, leaving the
      // consolidated curve starting from a single profile only (e.g. just
      // binance_main at $10,674) and making "Since Start" report +948%.

      for (const bucket of sortedBuckets) {
        let totalEquity = 0, totalCash = 0, anyRebased = false, allKnown = true;
        for (const pid of legs) {
          const val = profileData[pid]?.get(bucket);
          if (val) lastKnown[pid] = { ...val, at: bucket };

          if (pid === "binance_coinm_main" && coinmGenesis && bucket < coinmGenesisBucket) {
            // DAPI hadn't launched yet at this point in history — use its
            // first-ever observed reading as a constant synthetic baseline
            // (mandate 2026-07-19: "preserve old consolidated history
            // despite the new DAPI series starting now") instead of dropping
            // the whole bucket until every leg happens to have data. Marked
            // rebased: this leg's contribution here is synthetic, not a real
            // reading, so a simple all-time % can't be computed off it.
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

      return res.json(result);
    }

    if (range) res.json(getEquityHistoryByRangeDisplay(profileId, range));
    else res.json(getEquityHistoryDisplay(profileId, toBoundedInt(req.query.days, 30, 0, 365)));
  });
}
