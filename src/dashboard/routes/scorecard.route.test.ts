// ══════════════════════════════════════════════
// GET /api/v2/scorecard — the route lives BEHIND the server's auth wall
// (401 without a session, JSON with one) and never depends on data/backtests
// artifacts or historical.db being present (empty DB ⇒ every band is
// insufficient_data/unavailable, benchmarks null — still a clean 200).
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { DashboardServer } from "../server";
import { sessions } from "../auth-store";
import { makeTestDb } from "../../test-support/db";

const fakeAm = {
  executor: {
    alpaca: { isConnected: () => false, lastMessageAt: 0 },
    binance: { isConnected: () => false, lastMessageAt: 0 },
  },
  accounts: new Map(),
  lastSyncAt: 0,
  getCircuits: () => ({}),
  getDashboardData: () => ({}),
} as any;

async function withServer<T>(fn: (baseUrl: string, cookie: string) => Promise<T>): Promise<T> {
  makeTestDb();
  const dashboard = new DashboardServer(fakeAm);
  const app = (dashboard as any).app;
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const sid = "scorecard-test-sid";
    sessions.set(sid, {
      id: sid, username: "admin", role: "admin", displayName: "Admin",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
    } as any);
    return await fn(`http://127.0.0.1:${port}`, `sid=${sid}`);
  } finally {
    sessions.delete("scorecard-test-sid");
    server.close();
  }
}

describe("GET /api/v2/scorecard", () => {
  test("401 without a session", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v2/scorecard`);
      expect(res.status).toBe(401);
    });
  });

  test("200 + full entity set with a session, even on an empty DB with no artifacts", async () => {
    await withServer(async (base, cookie) => {
      const res = await fetch(`${base}/api/v2/scorecard`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.entities.length).toBe(6);
      const ids = body.entities.map((e: any) => e.id);
      for (const id of ["momentum_stocks", "meanrev_stocks", "momentum_crypto", "momentum_crypto_usdc", "alpaca_main", "binance_main"]) {
        expect(ids).toContain(id);
      }
      for (const e of body.entities) {
        if (e.kind === "sleeve") {
          expect(e.band).not.toBeNull();
          // Empty DB ⇒ h=0 ⇒ never "below"/"within"/"above"; and the route
          // must not have needed any artifact on disk to answer.
          expect(["insufficient_data", "unavailable"]).toContain(e.band.status);
          expect(e.windows.map((w: any) => w.window)).toEqual(["model", "30d", "90d", "v8"]);
        } else {
          expect(e.band).toBeNull();
          expect(e.windows.map((w: any) => w.window)).toEqual(["30d", "90d", "v8"]);
        }
      }
    });
  });
});
