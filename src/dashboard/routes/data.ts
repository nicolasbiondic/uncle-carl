// ═══ Core dashboard data routes ═══

import express from "express";
import type { AccountManager } from "../../account/AccountManager";
import { config } from "../../config";
import {
  getRecentTrades,
  getTradingStats, getActivityLog,
} from "../../db/database";
import { getOrCreateSession } from "../auth-store";
import { cached } from "../cache";
import { toBoundedInt } from "../dashboard-utils";

export function registerDataRoutes(app: express.Application, am: AccountManager): void {
  // ── GET /api/dashboard ──────────────────────────────────────────────────
  app.get("/api/dashboard", (req, res) => {
    const s = getOrCreateSession(req, res);
    const view = (req.query.view as string) || s.settings.viewId;
    res.json(am.getDashboardData(view as any));
  });

  // ── GET /api/trades ─────────────────────────────────────────────────────
  // kept: trades.js (api.trades()) + ops script scripts/baseline-report.ts.
  app.get("/api/trades", (req, res) => {
    const limit = toBoundedInt(req.query.limit, 100, 1, 1000);
    const key   = `trades_${limit}_${req.query.account || "all"}`;
    res.json(cached(key, 5_000, () => getRecentTrades(limit, req.query.account as any)));
  });

  // ── GET /api/stats ──────────────────────────────────────────────────────
  // kept: ops script scripts/baseline-report.ts (no frontend caller).
  app.get("/api/stats", (req, res) => {
    const key = `stats_${req.query.account || "all"}`;
    res.json(cached(key, 10_000, () => getTradingStats(req.query.account as any)));
  });

  // ── GET /api/activity ───────────────────────────────────────────────────
  // kept: api.js (activity()) + ops script scripts/baseline-report.ts.
  app.get("/api/activity", (req, res) => {
    const limit = toBoundedInt(req.query.limit, 100, 1, 500);
    res.json(getActivityLog(limit, req.query.type as string, req.query.account as string));
  });

  // ── GET /api/connections ────────────────────────────────────────────────
  app.get("/api/connections", (_req, res) => res.json({
    alpaca: {
      connected: am.executor.alpaca.isConnected(),
      dataConnected: am.executor.alpaca.isDataConnected(),
      state: am.executor.alpaca.connectionState,
      stockWs: am.executor.alpaca.stockWsState,
      cryptoWs: am.executor.alpaca.cryptoWsState,
      lastMessageAt: am.executor.alpaca.lastMessageAt,
    },
    binance: {
      connected: am.executor.binance.isConnected(),
      state: am.executor.binance.connectionState,
      type: "futures",
      // Audit fix (P2, 2026-05-07): surface user-data WS state so the
      // dashboard can tell when EXECUTION_WS=true is in flight vs polling-
      // only. lastMessageAt is updated on every WS message + REST price
      // fetch; userDataWs reflects the listenKey-driven stream specifically.
      lastMessageAt: (am.executor.binance as any).lastMessageAt ?? 0,
      userDataWs: (am.executor.binance as any).userWs
        ? ((am.executor.binance as any).userWs.readyState === 1 ? "open" : "closing")
        : "disconnected",
    },
    mode: config.mode,
  }));
}
