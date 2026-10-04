// GET /api/v2/pnl-breakdown lives behind the server's auth wall like every
// /api route: 401 without a session, JSON with one.
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
  getConsolidatedState: () => ({ positions: [] }),
} as any;

describe("GET /api/v2/pnl-breakdown", () => {
  test("401 without a session, the breakdown with one", async () => {
    makeTestDb();
    const server = (new DashboardServer(fakeAm) as any).app.listen(0);
    const sid = "pnl-breakdown-test-sid";
    try {
      const { port } = server.address() as { port: number };
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/api/v2/pnl-breakdown?days=7`)).status).toBe(401);
      sessions.set(sid, {
        id: sid, username: "admin", role: "admin", displayName: "Admin",
        createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
        rememberMe: false, settings: { viewId: "consolidated" },
      } as any);
      const res = await fetch(`${base}/api/v2/pnl-breakdown?days=30`, { headers: { cookie: `sid=${sid}` } });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toMatchObject({ periodDays: 30, realized: 0, count: 0, earnedBefore: 0, openChange: 0 });
    } finally {
      sessions.delete(sid);
      server.close();
    }
  });
});
