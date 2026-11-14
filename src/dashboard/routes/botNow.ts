import type express from "express";
import type { AccountManager } from "../../account/AccountManager";
import { getDB } from "../../db/database";
import { openHistoricalReadonly } from "../../portfolio/scorecard";
import { buildBotNow, type BotNowDeps, type BotNowRuntime } from "../botNow";

/** Mounted after server.ts's session wall, like the other dashboard reads. */
export function registerBotNowRoutes(app: express.Application, am: AccountManager, runtime: () => readonly BotNowRuntime[], aiReview?: BotNowDeps["aiReview"]): void {
  app.get("/api/bot/now", (_req, res) => {
    const historical = openHistoricalReadonly();
    try {
      res.json(buildBotNow({ db: getDB(), runtime: runtime(), summaries: am.getAccountSummaries(),
        positions: am.getConsolidatedState().positions, historical, aiReview }));
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "bot status unavailable" });
    } finally {
      historical?.close();
    }
  });
}
