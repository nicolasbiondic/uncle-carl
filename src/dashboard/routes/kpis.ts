// ═══ P0 (2026-10-09): owner KPIs + decision funnel routes ═══
//
//   GET /api/kpis            — volume / return / risk vs the owner's goals
//                              (src/portfolio/kpis.ts, shared with Telegram).
//   GET /api/funnel?days=1|7|30 — per-portfolio decision funnel: passes,
//                              signals, entries, exits, blocks by reason
//                              (decision_passes telemetry), plus live
//                              executed orders/day vs the validated design.
//                              Since 2026-10-23 each account also carries
//                              signalsRawLong / signalsAfterGates / gateBinding
//                              (gates that removed a candidate, not merely
//                              active) and `exposure` {latest, mean5, low}:
//                              real vs intended gross / sleeve equity, `low`
//                              when the 5-pass ratio < 0.8.

import express from "express";
import { computeKpiSnapshot } from "../../portfolio/kpis";
import { countExecutedOrders, getDecisionPassSummary, getETDayStart } from "../../db/database";
import { toBoundedInt } from "../dashboard-utils";

/**
 * Validated design volume in COMPLETE operations (round trips) per day —
 * §2 of docs/reports/V-plan-volumen-rentabilidad.md for the crypto chains
 * (06e1a160 crypto, 413ffb90 USDC). One executed ORDER = half an operation,
 * so orders/day ≈ ×2.
 *
 * RW2 (2026-10-23): the two stock sleeves run on the portfolio engine
 * (`@pe-vt15`, docs/reports/RW-reescritura-rentable.md §9): orders per
 * session 0.74 (E1) and 0.46 (E2) → 0.37 / 0.23 ops per day. Until then:
 * 0.05 (5f03d68d) and 1.20 (624d50e9). countExecutedOrders includes confirmed
 * rebalances from the portfolio decision journal; the engine still writes
 * no decision_passes, so its funnel rows show 0 passes.
 */
export const DESIGN_OPS_PER_DAY: Record<string, number> = {
  momentum_stocks: 0.37,
  meanrev_stocks: 0.23,
  momentum_crypto: 0.78,
  momentum_crypto_usdc: 0.08,
};

export function registerKpiRoutes(app: express.Application): void {
  app.get("/api/kpis", (_req, res) => {
    res.json(computeKpiSnapshot());
  });

  app.get("/api/funnel", (req, res) => {
    const days = toBoundedInt(req.query.days, 7, 1, 30);
    const now = Date.now();
    // ET-day-aligned window: "1" = today, "7" = the last 7 ET days inclusive —
    // the same convention getTradingStats' period windows use.
    const since = getETDayStart(now - (days - 1) * 86_400_000);
    const summaries = getDecisionPassSummary(since);

    // Union of portfolios with telemetry and portfolios with a declared
    // design figure, so a freshly-deployed recorder still shows every row.
    const ids = [...new Set([...Object.keys(DESIGN_OPS_PER_DAY), ...summaries.map((s) => s.accountId)])];
    const byId = new Map(summaries.map((s) => [s.accountId, s]));

    let liveOrdersTotal = 0;
    let designOrdersTotal = 0;
    const accounts = ids.map((accountId) => {
      const s = byId.get(accountId);
      const liveOrders = countExecutedOrders(since, now, accountId);
      const designOps = DESIGN_OPS_PER_DAY[accountId] ?? null;
      const designOrdersPerDay = designOps !== null ? designOps * 2 : null;
      liveOrdersTotal += liveOrders;
      if (designOrdersPerDay !== null) designOrdersTotal += designOrdersPerDay;
      return {
        accountId,
        passes: s?.passes ?? 0,
        universe: s?.universe ?? null,
        signalsLong: s?.signalsLong ?? 0,
        signalsShort: s?.signalsShort ?? 0,
        entries: s?.entries ?? 0,
        exits: s?.exits ?? 0,
        blocks: s?.blocks ?? {},
        lastBlockNote: s?.lastBlockNote ?? null,
        slotsUsed: s?.slotsUsed ?? null,
        slotsTotal: s?.slotsTotal ?? null,
        // 2026-10-23: gate-binding (null / {} on passes recorded before it or
        // by an engine that cannot measure it) and sleeve exposure.
        signalsRawLong: s?.signalsRawLong ?? null,
        signalsAfterGates: s?.signalsAfterGates ?? null,
        gateBinding: s?.gateBinding ?? {},
        gateBindingPasses: s?.gateBindingPasses ?? 0,
        exposure: s?.exposure ?? null,
        liveOrders,
        liveOrdersPerDay: liveOrders / days,
        designOpsPerDay: designOps,
        designOrdersPerDay,
      };
    });

    res.json({
      days,
      accounts,
      totals: {
        liveOrdersPerDay: liveOrdersTotal / days,
        designOrdersPerDay: designOrdersTotal,
      },
    });
  });
}
