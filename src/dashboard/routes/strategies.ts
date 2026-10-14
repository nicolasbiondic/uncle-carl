// ═══ Strategy, symbol, and equity history routes ═══

import express from "express";
import type { AccountManager } from "../../account/AccountManager";
import {
  getEquityHistoryDisplay, getEquityHistoryByRangeDisplay,
} from "../../db/database";
import { getSymbolsByBroker } from "../../config/symbols";
import { toBoundedInt } from "../dashboard-utils";
import { buildConsolidatedEquitySeries } from "../../portfolio/consolidatedEquity";
import { RISK_PROFILES, type RiskProfileId } from "../../config/riskProfiles";
import { displayBucketMs, resampleEquityForDisplay, windowDays } from "../equityResample";

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
    // One cadence per window, and only the US session for stock-only series
    // beyond "Today" (equityResample.ts: why raw points looked flat).
    const days = windowDays(req.query.days === undefined ? undefined : toBoundedInt(req.query.days, 30, 0, 365), range);
    const bucketMs = displayBucketMs(days);

    // Consolidated: aggregate equity from broker totals (alpaca_main + binance_main
    // [+ binance_coinm_main once DAPI is applicable]). These rows are written by
    // syncAlpacaAccount/syncBinanceFutures/syncBinanceCoinM with the FULL broker
    // equity, so the curve matches the KPI bar and the broker cards exactly.
    // The previous behaviour summed the 4 individual profiles (alpaca_low/high +
    // binance_low/high), which only reflected the bot-managed slice — leaving
    // unallocated capital out and creating an apparent KPI vs curve mismatch.
    if (!profileId || profileId === "consolidated") {
      // Builder extracted to src/portfolio/consolidatedEquity.ts (P0,
      // 2026-10-09) so /api/kpis and the Telegram digest read the SAME
      // series this chart shows. Semantics unchanged (this route's tests
      // still lock them). R5 note (2026-05-10) preserved there: no
      // "skip stale initial values" heuristic.
      const result = buildConsolidatedEquitySeries((pid) =>
        range
          ? getEquityHistoryByRangeDisplay(pid, range)
          : getEquityHistoryDisplay(pid, toBoundedInt(req.query.days, 30, 0, 365)),
      );
      return res.json(resampleEquityForDisplay(result, bucketMs));
    }

    const rows = range
      ? getEquityHistoryByRangeDisplay(profileId, range)
      : getEquityHistoryDisplay(profileId, toBoundedInt(req.query.days, 30, 0, 365));
    const stockOnly = profileId === "alpaca_main" || RISK_PROFILES[profileId as RiskProfileId]?.broker === "alpaca";
    res.json(resampleEquityForDisplay(rows, bucketMs, stockOnly && days !== 1));
  });
}
