// ═══ Admin-only routes: circuit breakers, API key config ═══
//
// POST /api/config/keys (browser-mutated .env) and POST /api/test-order
// (unmanaged broker orders bypassing the trade/order ledger) were removed —
// v4 is environment-managed/read-only and no current dashboard/script calls
// either mutation. GET /api/config/keys (masked status) is retained.

import express from "express";
import type { AccountManager } from "../../account/AccountManager";
import { config } from "../../config";
import { isNonProductionBinanceHost } from "../../executor/binance-executor";
import { requireAdmin } from "../auth-store";

export function registerAdminRoutes(app: express.Application, am: AccountManager): void {
  // v8: manual circuit pause/resume removed — the engines' RiskGuard owns
  // pausing; its state is read-only on the dashboard (/api/circuits).

  // ── GET /api/config/keys ────────────────────────────────────────────────
  // F4a: reads the EXECUTORS' effective credential views (env OR registry —
  // whatever the runtime actually signs with), never config directly; in env
  // mode the views resolve to the exact config values this route always used.
  app.get("/api/config/keys", requireAdmin, (_req, res) => {
    const mask = (k: string) =>
      k && k !== "" && !k.startsWith("your_") ? k.slice(0, 4) + "…" + k.slice(-4) : "(not set)";
    const alpacaView = am.executor.alpaca.credentialPublicView();
    const binanceView = am.executor.binance.credentialPublicView();
    res.json({
      alpaca: { keyId: alpacaView.authType === "oauth" ? "(oauth)" : mask(alpacaView.keyId), paper: alpacaView.paper },
      binance: {
        keyId: mask(binanceView.apiKey),
        testnet: isNonProductionBinanceHost(binanceView.restBase),
        connected: am.executor.binance.isConnected(),
      },
      telegram: {
        configured: !!(config.telegram.botToken && config.telegram.botToken !== "your_telegram_bot_token"),
      },
    });
  });
}
