// ═══ Analytics, export, reports, insights, and position routes ═══

import express from "express";
import { existsSync, readFileSync } from "fs";
import type { AccountManager } from "../../account/AccountManager";
import {
  getClosedTradesInRange,
  getHourlyAnalytics, getSymbolAnalytics,
  getPnlAttribution, getMonthlyReturns, getDrawdownSeries,
  getSlippageStats, getCloseReasonAttribution,
} from "../../db/database";
import { toBoundedInt } from "../dashboard-utils";
import { getDB } from "../../db/database";
import { getAllSleeveTrackRecords } from "../../portfolio/trackRecord";
import { computeScorecard, openHistoricalReadonly, sleeveExpectationArtifacts } from "../../portfolio/scorecard";
import { computeCostCalibration, type CostCalibration } from "../../reports/costCalibration";
import { getReviewProgress } from "../../portfolio/reviewPoint";
import { SLEEVE_POLICY, type RiskProfileId } from "../../config/riskProfiles";

export function registerAnalyticsRoutes(app: express.Application, _am: AccountManager): void {
  // v8: the market-monitor endpoints (/api/regime, /api/market-context,
  // /api/derivatives, /api/breadth, /api/events, /api/cot, /api/alerts) and
  // the agent/council endpoint (/api/agent) were removed with their modules.
  // 2026-07-22 route audit: removed /api/scenario,
  // /api/analytics/daily, /api/reports/daily, /api/brokers/:brokerId/assets,
  // /api/crypto/rejections, /api/position/:symbol — zero refs in api.js,
  // components, tests, or scripts (see routes/analytics.ts git history for
  // the evidence). Their DB helpers (getScenarioReplay, getDailyAnalytics,
  // getAssetBalances-for-this-callsite, getActivityLog-for-this-callsite)
  // are left in db/database.ts; getActivityLog/getAssetBalances stay live
  // via other callers (see report) — getDailyReport had none anywhere and
  // was deleted 2026-09-25 (getProfile in the same file and in
  // config/riskProfiles.ts, and getSleeveEquityStart in portfolio/truth.ts,
  // were dead the same way — deleted alongside it).

  // ── U6/U7 — Binance order-book depth + time&sales (crypto only) ─────────
  // kept: candle.js modal fetches both (order-book + time&sales overlay).
  // On-demand proxy (the browser can't hit Binance directly: CORS + CSP). All
  // crypto symbols are quoted /USD on our side → USDT-margined perp on Binance.
  const toBinanceFut = (display: string) => display.replace("/", "").replace(/USD$/, "USDT");
  async function binanceFut(path: string): Promise<any | null> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(`https://fapi.binance.com${path}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  app.get("/api/orderbook", async (req, res) => {
    try {
      const sym = (req.query.symbol as string) || "";
      if (!sym.includes("/")) return res.json({ error: "crypto only" });
      // Binance depth only accepts a discrete set of limits; snap to a valid one.
      const reqLimit = toBoundedInt(req.query.limit, 20, 5, 50);
      const limit = [5, 10, 20, 50].includes(reqLimit) ? reqLimit : 20;
      const d = await binanceFut(`/fapi/v1/depth?symbol=${toBinanceFut(sym)}&limit=${limit}`);
      if (!d || !Array.isArray(d.bids)) return res.json({ unavailable: true });
      res.json({ bids: d.bids, asks: d.asks });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.get("/api/tape", async (req, res) => {
    try {
      const sym = (req.query.symbol as string) || "";
      if (!sym.includes("/")) return res.json({ error: "crypto only" });
      const limit = toBoundedInt(req.query.limit, 30, 5, 60);
      const d = await binanceFut(`/fapi/v1/aggTrades?symbol=${toBinanceFut(sym)}&limit=${limit}`);
      if (!Array.isArray(d)) return res.json({ unavailable: true });
      res.json(d.map((t: any) => ({ p: Number(t.p), q: Number(t.q), T: t.T, m: !!t.m })));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // kept: manual CSV/JSON download; external operators may use it without the SPA.
  app.get("/api/trades/export", (req, res) => {
    try {
      const profileId = (req.query.profile as string) || null;
      const from = (req.query.from as string) || "2020-01-01";
      const to = (req.query.to as string) || new Date().toISOString().split("T")[0];
      const format = (req.query.format as string) || "json";
      const trades = getClosedTradesInRange(profileId, from, to);
      if (format === "csv") {
        const header = "id,symbol,market,side,strategy,entry_price,exit_price,quantity,pnl,pnl_pct,entry_time,exit_time,account_id\n";
        const rows = trades.map((t: any) =>
          `${t.id},${t.symbol},${t.market},${t.side},${t.strategy},${t.entry_price},${t.exit_price},${t.quantity},${t.pnl},${t.pnl_pct},${new Date(t.entry_time).toISOString()},${new Date(t.exit_time).toISOString()},${t.account_id}`
        ).join("\n");
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=trades_${from}_${to}.csv`);
        return res.send(header + rows);
      }
      res.json(trades);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/analytics/slippage (Wave 1) ────────────────────────────────
  // kept: analytics.js tearsheet tab (api.slippage()).
  // Returns p50/p95/count/meanLatencyMs for the requested account over
  // the requested window (default 7 days, max 30).
  app.get("/api/analytics/slippage", (req, res) => {
    try {
      const account = (req.query.account as string) || null;
      const windowMs = Math.min(
        parseInt(String(req.query.windowMs ?? "")) || 7 * 24 * 3600_000,
        30 * 24 * 3600_000
      );
      res.json(getSlippageStats(account, windowMs));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 2026-07-09 cleanup: meta-labeler-stats / lgbm-stats / risk-chain /
  // target-weights endpoints removed with their abandoned Wave 4 subsystems.
  // 2026-07-13 cleanup: signal-ic / insights / meta-labels endpoints removed —
  // their backing tables (signal_diagnostics, insights, meta_labels) had no
  // live writer; readers + tables deleted from db/database.ts. Frontend calls
  // (if any) now 404 — the data was empty anyway.

  // ── GET /api/analytics/hourly ───────────────────────────────────────────
  app.get("/api/analytics/hourly", (req, res) => {
    try {
      const profileId = (req.query.profile as string) || null;
      const days      = toBoundedInt(req.query.days, 30, 1, 365);
      res.json(getHourlyAnalytics(profileId, days));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/analytics/symbols ──────────────────────────────────────────
  app.get("/api/analytics/symbols", (req, res) => {
    try {
      const profileId = (req.query.profile as string) || null;
      const days      = toBoundedInt(req.query.days, 30, 1, 365);
      res.json(getSymbolAnalytics(profileId, days));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/analytics/pnl-attribution (algo edge vs reconcile vs sync) ──
  app.get("/api/analytics/pnl-attribution", (req, res) => {
    try {
      const days = toBoundedInt(req.query.days, 365, 1, 3650);
      res.json(getPnlAttribution(days));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/analytics/close-reasons (Tanda 3) ──────────────────────────
  // Per-close_reason attribution (count/P&L/avg hold) — evidence for whether
  // TRAIL_STOP should become momentum's primary exit.
  app.get("/api/analytics/close-reasons", (req, res) => {
    try {
      const profileId = (req.query.profile as string) || null;
      const days      = toBoundedInt(req.query.days, 90, 1, 3650);
      res.json(getCloseReasonAttribution(profileId, days));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/analytics/track-record (2026-08-07) ────────────────────────
  // Per-sleeve daily-return track record: observations accumulated vs
  // observations REQUIRED (Bailey & López de Prado MinTRL at 95% for SR>0),
  // PSR, observed Sharpe — always published together with n and the honest
  // status ("insufficient_observations" when that's the truth), never a
  // Sharpe alone. Pure measurement for the capital-allocation research
  // track; no trading effect. See src/portfolio/trackRecord.ts.
  //
  // 2026-08-08: each sleeve also carries
  //   • reviewPoint — "N of M observations" toward the EX-ANTE review point
  //     (M = MinTRL of the DECLARED expected Sharpe from SLEEVE_POLICY, never
  //     the observed one — see src/portfolio/reviewPoint.ts). Present even
  //     with zero data; reaching M implies review, not action.
  //   • riskRetirement — the declared drawdown limits (riskProfiles.ts
  //     SLEEVE_POLICY) that RiskGuard enforces as entry pauses. Auditable:
  //     threshold + declaredAt + what enforces it.
  app.get("/api/analytics/track-record", (_req, res) => {
    try {
      const sleeves = getAllSleeveTrackRecords().map(rec => {
        const id = rec.profileId as RiskProfileId;
        let reviewPoint = null;
        try { reviewPoint = getReviewProgress(id, rec.trackRecord); } catch {}
        return { ...rec, reviewPoint, riskRetirement: SLEEVE_POLICY[id]?.risk ?? null };
      });
      res.json({ sleeves, generatedAt: Date.now() });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/v2/scorecard (W5, 2026-09-25) ──────────────────────────────
  // Per-sleeve/per-account scorecard: TW return vs benchmark on the SAME
  // dates, α/β OLS, Sharpe/Sortino/maxDD, live PSR, capital utilization and
  // the OOS expectation band (block bootstrap over the authoritative pure
  // chain — src/portfolio/scorecard.ts). Registered inside this function ⇒
  // behind the server's auth wall like every /api route (401 without a
  // session — enforced by src/dashboard/routes/scorecard.route.test.ts).
  // historical.db missing/stale ⇒ benchmark fields null, never a 500.
  // 2026-09-26: additive `costs` block — real execution cost per sleeve/side
  // vs the simulator's assumption (src/reports/costCalibration.ts, same
  // read-only pure module the CLI scripts/calibrate-costs.ts prints).
  // Fail-soft: a costs failure never takes the scorecard down.
  app.get("/api/v2/scorecard", (_req, res) => {
    let hist = null;
    try {
      hist = openHistoricalReadonly();
      let costs: CostCalibration | null = null;
      try { costs = computeCostCalibration(getDB(), hist); } catch { costs = null; }
      res.json({ ...computeScorecard({ db: getDB(), hist }), costs });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      try { hist?.close(); } catch {}
    }
  });

  // ── GET /api/v2/tearsheet/:sleeve (2026-09-26) ──────────────────────────
  // Serves the self-contained tearsheet.html of the sleeve's AUTHORITATIVE
  // pure-chain artifact. The :sleeve param is ONLY a key into the
  // sleeveExpectationArtifacts() whitelist — it never touches a filesystem
  // path (no traversal surface); the file path is entirely map-derived.
  // Registered inside this function ⇒ behind the server's auth wall (401
  // without a session — src/dashboard/routes/tearsheet.route.test.ts).
  app.get("/api/v2/tearsheet/:sleeve", (req, res) => {
    try {
      const artifacts = sleeveExpectationArtifacts();
      const sleeve = String(req.params.sleeve);
      const ref = Object.prototype.hasOwnProperty.call(artifacts, sleeve) ? artifacts[sleeve] : null;
      if (!ref) return res.status(404).json({ error: "sleeve sin artefacto autoritativo" });
      const path = `${ref.dir}/tearsheet.html`;
      if (!existsSync(path)) return res.status(404).json({ error: "tearsheet no generado para este artefacto" });
      const html = readFileSync(path, "utf8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // Self-contained document: inline script/style/data URIs only — no
      // external origins, no frames, no referrer leakage.
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.send(html);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/analytics/monthly-returns + /drawdown (tearsheet) ──────────
  app.get("/api/analytics/monthly-returns", (req, res) => {
    try {
      const profile = (req.query.profile as string) || "binance_main";
      res.json(getMonthlyReturns(profile, toBoundedInt(req.query.months, 12, 3, 36)));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.get("/api/analytics/drawdown", (req, res) => {
    try {
      const profile = (req.query.profile as string) || "binance_main";
      res.json(getDrawdownSeries(profile, toBoundedInt(req.query.days, 90, 7, 3650)));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

}
