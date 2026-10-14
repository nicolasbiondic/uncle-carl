// ═══ GET /api/ai-quorum/summary — "Quórum IA (sombra)" panel (línea D) ═══
//
// Read-only window into data/ai-quorum.db, the SEPARATE database written by
// scripts/ai-quorum.ts (cron). The dashboard never writes it and the bot
// never reads it. Shadow trades NEVER count toward the volume KPI — this
// endpoint is the "shown apart" surface §11 requires. Registered behind
// server.ts's auth wall like every other data route.

import type express from "express";
import { existsSync } from "fs";
import { Database } from "bun:sqlite";
import { evaluate, loadEvalSnapshots } from "../../ai-quorum/evaluate";
import { createLogger } from "../../utils/logger";

const log = createLogger("Dashboard");

export interface AiQuorumDeps {
  dbPath?: string;
  now?: () => number;
}

export function buildAiQuorumSummary(dbPath: string, now: number): unknown {
  if (!existsSync(dbPath)) {
    return { status: "none", message: "ai-quorum.db not found — the cron has not run yet" };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const snapshots = loadEvalSnapshots(db);
    const ev = evaluate(snapshots, now);
    const anyViews = ev.sessionsWithViews > 0;
    const nSnapshots = snapshots.length;

    // Latest day's views + quorum, for the "vistas de hoy" table.
    const latest = db.query<{ id: number; asset_class: string; date_key: string; status: string }, []>(
      "SELECT id, asset_class, date_key, status FROM snapshots ORDER BY date_key DESC, id DESC LIMIT 2",
    ).all();
    const latestDate = latest[0]?.date_key ?? null;
    const today = latest.filter((s) => s.date_key === latestDate).map((s) => ({
      assetClass: s.asset_class,
      dateKey: s.date_key,
      status: s.status,
      views: db.query<{ model_id: string; symbol: string; view: string; confidence: number }, [number]>(
        "SELECT model_id, symbol, view, confidence FROM model_views WHERE snapshot_id = ? ORDER BY symbol, model_id",
      ).all(s.id),
      quorum: db.query<{ symbol: string; direction: number; mean_confidence: number }, [number]>(
        "SELECT symbol, direction, mean_confidence FROM quorum_positions WHERE snapshot_id = ? ORDER BY symbol",
      ).all(s.id),
    }));

    // Spend: current UTC month.
    const monthStart = new Date(now);
    monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const spend = db.query<{ total: number | null }, [number]>(
      "SELECT SUM(cost_usd) AS total FROM model_calls WHERE called_at >= ?",
    ).get(monthStart.getTime());

    return {
      status: anyViews ? "active" : nSnapshots > 0 ? "pending_keys" : "none",
      snapshots: nSnapshots,
      firstViewsDate: ev.firstViewsDate,
      verdictDate: ev.verdictDate,
      sessionsWithViews: ev.sessionsWithViews,
      sessionsRequired: ev.sessionsRequired,
      verdict: ev.verdict,
      today,
      curve: ev.book.curve,
      stats: {
        book: strip(ev.book),
        benchEwLong: strip(ev.benchEwLong),
        benchMom21: strip(ev.benchMom21),
        models: Object.fromEntries(Object.entries(ev.models).map(([k, v]) => [k, strip(v)])),
      },
      spendMonthUsd: spend?.total ?? 0,
    };
  } finally {
    db.close();
  }
}

function strip(s: { sharpe: number | null; hitRate: number | null; nDays: number; nPositions: number }) {
  return { sharpe: s.sharpe, hitRate: s.hitRate, nDays: s.nDays, nPositions: s.nPositions };
}

export function registerAiQuorumRoutes(app: express.Application, deps?: AiQuorumDeps): void {
  app.get("/api/ai-quorum/summary", (_req, res) => {
    try {
      res.json(buildAiQuorumSummary(deps?.dbPath ?? process.env.AI_QUORUM_DB_PATH?.trim() ?? "data/ai-quorum.db", (deps?.now ?? Date.now)()));
    } catch (e: any) {
      log.error(`/api/ai-quorum/summary failed: ${e?.message ?? e}`);
      res.status(500).json({ status: "error", error: String(e?.message ?? e) });
    }
  });
}
