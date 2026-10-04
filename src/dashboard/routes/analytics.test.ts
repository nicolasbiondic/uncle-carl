// ══════════════════════════════════════════════
// /api/analytics/track-record — review-point progress and declared risk
// policy are published for every sleeve EVEN WITH NO DATA: the ex-ante
// goalpost ("N of M observations") must exist before the observations do,
// or "decide after 8 trades" sneaks back in through the UI.
// ══════════════════════════════════════════════

import express from "express";
import { describe, expect, test } from "bun:test";
import { registerAnalyticsRoutes } from "./analytics";
import { makeTestDb } from "../../test-support/db";
import { ALL_PROFILE_IDS } from "../../config/riskProfiles";

describe("GET /api/analytics/track-record — ex-ante review point exposure", () => {
  test("empty DB: every sleeve carries finite reviewPoint progress + declared risk retirement", async () => {
    makeTestDb();
    const app = express();
    registerAnalyticsRoutes(app, {} as any);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/api/analytics/track-record`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.sleeves.length).toBe(ALL_PROFILE_IDS.length);
      for (const s of body.sleeves) {
        // Progress exists with zero observations — REVERT CANARY for (3).
        expect(s.reviewPoint).not.toBeNull();
        expect(s.reviewPoint.nObservations).toBe(0);
        expect(Number.isFinite(s.reviewPoint.obsTarget)).toBe(true);
        expect(s.reviewPoint.obsTarget).toBeGreaterThan(0);
        expect(s.reviewPoint.reached).toBe(false);
        expect(s.reviewPoint.progress).toBe(`0 of ${s.reviewPoint.obsTarget} observations`);
        expect(s.reviewPoint.note).toContain("does NOT imply retiring or promoting");
        // Declared, auditable risk retirement (2): threshold + since when +
        // what enforces it (entry pause — the sleeve is never turned off).
        expect(s.riskRetirement.softDrawdownPct).toBe(0.10);
        expect(s.riskRetirement.hardDrawdownPct).toBe(0.20);
        expect(s.riskRetirement.dailyLossCapPct).toBe(0.03);
        expect(s.riskRetirement.declaredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(s.riskRetirement.enforcedBy).toContain("RiskGuard");
      }
    } finally {
      server.close();
    }
  });
});
