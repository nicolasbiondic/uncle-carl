// Regression test for the legacy-dashboard deletion (v1/v2/v3 removed, v4 only).
import { describe, expect, test } from "bun:test";
import http from "http";
import { WebSocket as WsClient } from "ws";
import { config } from "../config";
import { DashboardServer } from "./server";
import { sessions, USERS } from "./auth-store";
import { heartbeats } from "../ops/heartbeat";
import { makeTestDb } from "../test-support/db";

const fakeAm = {
  executor: {
    // credentialPublicView: F4a — GET /api/config/keys reads the executors'
    // effective (env-or-registry) credential views instead of config.
    alpaca: { isConnected: () => false, lastMessageAt: 0, credentialPublicView: () => ({ keyId: "", paper: true, authType: "api_key" }) },
    binance: { isConnected: () => false, lastMessageAt: 0, credentialPublicView: () => ({ apiKey: "", restBase: "https://demo-fapi.binance.com" }) },
  },
  accounts: new Map(),
  lastSyncAt: 0,
  getCircuits: () => ({}),
  getDashboardData: () => ({}),
} as any;

async function withServer<T>(fn: (baseUrl: string, cookie: string) => Promise<T>): Promise<T> {
  makeTestDb();
  // Platform phase (2026-10-04): these tests describe a CONFIGURED
  // installation (prod has env users). Without any user the dashboard now
  // serves the first-run setup page instead of /login (routes/setup.ts),
  // so seed one when the test env has none.
  const seededUser = USERS.length === 0;
  if (seededUser) USERS.push({ username: "test-admin", passwordHash: "x", role: "admin", displayName: "Test" });
  const dashboard = new DashboardServer(fakeAm);
  // Bypass start()/config port — exercise the same express app on an ephemeral port.
  const app = (dashboard as any).app;
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const sid = "test-sid";
    sessions.set(sid, {
      id: sid, username: "admin", role: "admin", displayName: "Admin",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
    });
    return await fn(`http://127.0.0.1:${port}`, `sid=${sid}`);
  } finally {
    sessions.delete("test-sid");
    if (seededUser) {
      const i = USERS.findIndex(u => u.username === "test-admin");
      if (i >= 0) USERS.splice(i, 1);
    }
    server.close();
  }
}

describe("DashboardServer legacy-dashboard removal", () => {
  test("/healthz is public and reports v4", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect((await res.json()).version).toBe("v4");
    });
  });

  test("login identifies the current v4 dashboard", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/login`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Trading System &nbsp;·&nbsp; v4");
    });
  });

  test("/ and /v4 serve the v4 SPA for an authenticated session", async () => {
    await withServer(async (base, cookie) => {
      for (const path of ["/", "/v4"]) {
        const res = await fetch(`${base}${path}`, { headers: { cookie } });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("Uncle Carl · v4");
      }
    });
  });

  test("/v1, /v2, /v3 no longer exist (404)", async () => {
    await withServer(async (base, cookie) => {
      for (const path of ["/v1", "/v2", "/v3"]) {
        const res = await fetch(`${base}${path}`, { headers: { cookie } });
        expect(res.status).toBe(404);
      }
    });
  });

  test("legacy root static assets are gone", async () => {
    await withServer(async (base, cookie) => {
      for (const path of ["/dashboard.js", "/dashboard.css", "/index.html"]) {
        const res = await fetch(`${base}${path}`, { headers: { cookie } });
        expect(res.status).toBe(404);
      }
    });
  });

  test("/v4 static assets are still served", async () => {
    await withServer(async (base, cookie) => {
      const res = await fetch(`${base}/v4/js/main.js`, { headers: { cookie } });
      expect(res.status).toBe(200);
    });
  });
});

// P0 regression (2026-07-27): start() must REJECT on a bind failure instead
// of hanging forever — the pre-fix bug that produced an 8h27m zombie process
// (no SL loop, no heartbeats, no shutdown handler) after a port collision.
// Uses a throwaway high port (NOT config.dashboard.port — a real bot instance
// may legitimately be bound to that one on this host) that start() is pointed
// at by temporarily mutating config.dashboard.port.
describe("DashboardServer.start() port-bind failure", () => {
  test("rejects instead of hanging when the port is already in use", async () => {
    makeTestDb();
    const testPort = 48173;
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(testPort, resolve);
    });
    const originalPort = config.dashboard.port;
    (config.dashboard as any).port = testPort;
    try {
      const dashboard = new DashboardServer(fakeAm);
      await expect(dashboard.start()).rejects.toThrow();
    } finally {
      (config.dashboard as any).port = originalPort;
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

// P1 regression (2026-07-27): /healthz used to return 200 as long as SQLite
// answered, blind to every dead trading loop — the same class of blindness
// that let the zombie process (no SL loop, no heartbeats) look healthy.
// watchdog.sh only ever queries /healthz, never /healthz/full.
// 2026-09-11 amendment — LIVENESS, not readiness: a loop that is merely
// STALE (one pass overran its grace, e.g. waiting on a 504-ing broker) must
// NOT flip /healthz to 503, because watchdog.sh restarts on any non-200 and
// a restart is worse than a slow pass (five restarts in 20 minutes on
// 2026-09-11, 83 in the history, none a dead process). Only a DEAD loop —
// silent out of all proportion to its cadence (isDeadLoop) — is a 503.
describe("/healthz reflects critical loop staleness (P1 fix, liveness semantics 2026-09-11)", () => {
  test("a STALE-but-alive loop is reported in the body but keeps 200 — the watchdog must not restart a slow pass", async () => {
    await withServer(async (base) => {
      const name = "test:critical_loop_regression";
      heartbeats.register(name, 50, { graceMultiplier: 1 }); // stale after 50ms, dead only after 5min
      await new Promise((r) => setTimeout(r, 80));
      const staleRes = await fetch(`${base}/healthz`);
      expect(staleRes.status).toBe(200);              // revert-falsifier: the old rule returned 503 here
      const staleBody = await staleRes.json();
      expect(staleBody.status).toBe("degraded");
      expect(staleBody.stale_loop_count).toBeGreaterThan(0);
      // Public payload stays minimal — no position/equity/PnL data.
      expect(staleBody).not.toHaveProperty("open_positions");
      expect(staleBody).not.toHaveProperty("brokers");

      heartbeats.beat(name); // recover
      const okRes = await fetch(`${base}/healthz`);
      expect(okRes.status).toBe(200);
      expect((await okRes.json()).status).toBe("ok");
      // heartbeats is a process-wide singleton with no unregister() — widen
      // this loop's interval so it can't go stale again later in the suite.
      heartbeats.register(name, 10 * 60_000);
    });
  });

  test("a DEAD loop (silent far beyond its cadence — the zombie case) still 503s", async () => {
    await withServer(async (base) => {
      const name = "test:critical_loop_dead";
      heartbeats.register(name, 15_000); // the SL loop's cadence
      // Backdate the last beat past the dead floor (5 min). The registry is a
      // process singleton on Date.now with no clock seam, so reach in.
      (heartbeats as any).beats.get(name).lastBeatMs = Date.now() - 6 * 60_000;
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("dead");
      expect(body.dead_loop_count).toBeGreaterThan(0);

      heartbeats.beat(name);
      heartbeats.register(name, 10 * 60_000);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });
  });

  test("shadow_* and funding_monitor staleness does NOT flip /healthz to 503 (observational, not critical)", async () => {
    await withServer(async (base) => {
      heartbeats.register("shadow_test_regression", 50, { graceMultiplier: 1 });
      heartbeats.register("funding_monitor", 50, { graceMultiplier: 1 });
      await new Promise((r) => setTimeout(r, 80));
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      heartbeats.beat("shadow_test_regression");
      heartbeats.beat("funding_monitor");
    });
  });
});

// Regression test for the final legacy/backend dead-code deletion batch
// (2026-07-20): unmanaged/mutation routes removed, current routes untouched.
describe("dead-code deletion batch: removed mutations are gone", () => {
  const csrfHeaders = (cookie: string) => ({ cookie, "x-csrf-token": "x", "Content-Type": "application/json" });

  test("POST /api/test-order no longer exists (unmanaged broker orders)", async () => {
    await withServer(async (base, cookie) => {
      const res = await fetch(`${base}/api/test-order`, {
        method: "POST", headers: csrfHeaders(cookie),
        body: JSON.stringify({ symbol: "AAPL", side: "buy", quantity: 1 }),
      });
      expect(res.status).toBe(404);
    });
  });

  test("POST /api/config/keys no longer exists; GET /api/config/keys (masked status) still works", async () => {
    await withServer(async (base, cookie) => {
      const post = await fetch(`${base}/api/config/keys`, {
        method: "POST", headers: csrfHeaders(cookie), body: JSON.stringify({ alpacaKey: "x" }),
      });
      expect(post.status).toBe(404);

      const get = await fetch(`${base}/api/config/keys`, { headers: { cookie } });
      expect(get.status).toBe(200);
      const body = await get.json();
      expect(body).toHaveProperty("alpaca");
      expect(body).toHaveProperty("binance");
    });
  });

  test("session.ts routes no longer exist", async () => {
    await withServer(async (base, cookie) => {
      for (const path of ["/api/session", "/api/view-mode"]) {
        const res = await fetch(`${base}${path}`, { headers: { cookie } });
        expect(res.status).toBe(404);
      }
      const settings = await fetch(`${base}/api/session/settings`, {
        method: "POST", headers: csrfHeaders(cookie), body: "{}",
      });
      expect(settings.status).toBe(404);
    });
  });

  test("legacy v1 profile/spark routes no longer exist", async () => {
    await withServer(async (base, cookie) => {
      for (const path of ["/api/profiles", "/api/profiles/active", "/api/profile-spark"]) {
        const res = await fetch(`${base}${path}`, { headers: { cookie } });
        expect(res.status).toBe(404);
      }
      const switchRes = await fetch(`${base}/api/profiles/switch`, {
        method: "POST", headers: csrfHeaders(cookie), body: JSON.stringify({ id: "momentum_stocks" }),
      });
      expect(switchRes.status).toBe(404);
    });
  });

  test("GET /api/portfolio-history (legacy portfolio_snapshots) no longer exists", async () => {
    await withServer(async (base, cookie) => {
      const res = await fetch(`${base}/api/portfolio-history`, { headers: { cookie } });
      expect(res.status).toBe(404);
    });
  });

  test("POST /api/symbols/:symbol/toggle no longer exists; GET /api/symbols (read-only) still works", async () => {
    await withServer(async (base, cookie) => {
      const post = await fetch(`${base}/api/symbols/AAPL/toggle`, {
        method: "POST", headers: csrfHeaders(cookie), body: JSON.stringify({ enabled: false }),
      });
      expect(post.status).toBe(404);

      const get = await fetch(`${base}/api/symbols`, { headers: { cookie } });
      expect(get.status).toBe(200);
      const body = await get.json();
      expect(body).toHaveProperty("stocks");
      expect(body).toHaveProperty("crypto");
    });
  });

  test("current /api/v2/profiles route is still registered (not 404)", async () => {
    await withServer(async (base, cookie) => {
      const res = await fetch(`${base}/api/v2/profiles`, { headers: { cookie } });
      expect(res.status).not.toBe(404);
    });
  });

  test("current /api/dashboard route is still registered (unaffected by removed /api/profiles v1)", async () => {
    await withServer(async (base, cookie) => {
      const res = await fetch(`${base}/api/dashboard`, { headers: { cookie } });
      expect(res.status).not.toBe(404);
    });
  });
});

// P3-5 regression: the CSRF gate's `startsWith("/api/")` was case-sensitive,
// while Express routing is case-insensitive — a POST to "/API/..." skipped
// the CSRF check that "/api/..." enforces.
describe("CSRF gate is case-insensitive on the /api/ prefix (P3-5 fix)", () => {
  test("POST /API/... without a CSRF header is rejected just like /api/...", async () => {
    await withServer(async (base, cookie) => {
      const resLower = await fetch(`${base}/api/config/keys`, {
        method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}",
      });
      expect(resLower.status).toBe(403);

      const resUpper = await fetch(`${base}/API/config/keys`, {
        method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}",
      });
      expect(resUpper.status).toBe(403);
    });
  });
});

// Platform phase (2026-10-04): the WS origin allowlist must include the
// origin of PUBLIC_URL (an owner dashboard behind a tunnel/proxy), while
// still rejecting foreign origins — and with PUBLIC_URL unset the check is
// exactly the pre-platform one (covered by the other suites in this file).
describe("verifyWsClient honors PUBLIC_URL origin", () => {
  test("PUBLIC_URL origin connects; a foreign origin is still rejected", async () => {
    const { resetInstanceConfigForTests } = await import("../platform/instance");
    const savedPublicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "https://bot.example.com/dash";
    resetInstanceConfigForTests();
    makeTestDb();
    const dashboard = new DashboardServer(fakeAm);
    const server = (dashboard as any).server as http.Server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    const sid = "ws-publicurl-sid";
    sessions.set(sid, {
      id: sid, username: "admin", role: "admin", displayName: "Admin",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
    });
    try {
      const connect = (origin: string) => new Promise<boolean>((resolve) => {
        const ws = new WsClient(`ws://127.0.0.1:${port}`, { headers: { cookie: `sid=${sid}`, origin } });
        let settled = false;
        const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
        ws.once("open", () => { ws.close(); settle(true); });
        // Persistent handler: a rejected handshake can emit more than one
        // error (403 response + socket teardown) — a bare once() leaves the
        // second one unhandled and crashes the test process.
        ws.on("error", () => settle(false));
      });
      expect(await connect("https://bot.example.com")).toBe(true);   // PUBLIC_URL origin
      expect(await connect("https://evil.example.com")).toBe(false); // still rejected
    } finally {
      sessions.delete(sid);
      if (savedPublicUrl === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = savedPublicUrl;
      resetInstanceConfigForTests();
      await dashboard.stop();
    }
  });
});

// P3-4 regression: only the `switch_view` WS message re-validated its session
// against the live store — a broadcast (order/trade/position events) reached
// sockets whose session had already been logged out or expired. Uses the
// DashboardServer's real http.Server (the WebSocketServer is attached there,
// not to the ad-hoc `app.listen(0)` the other tests in this file use).
describe("WS broadcast revalidates session (P3-4 fix)", () => {
  test("a connected client receives broadcasts while its session is valid, and is dropped + gets nothing once the session is destroyed", async () => {
    makeTestDb();
    const dashboard = new DashboardServer(fakeAm);
    const server = (dashboard as any).server as http.Server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    const sid = "ws-p3-4-sid";
    sessions.set(sid, {
      id: sid, username: "admin", role: "admin", displayName: "Admin",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
    });

    try {
      const ws = new WsClient(`ws://127.0.0.1:${port}`, { headers: { cookie: `sid=${sid}` } });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      // Drain the initial "init" payload sent on connect.
      await new Promise<void>((resolve) => ws.once("message", () => resolve()));

      // 1. Session still valid → broadcast is delivered.
      const received: any[] = [];
      ws.on("message", (raw: any) => received.push(JSON.parse(raw.toString())));
      (dashboard as any).broadcast({ type: "test_event", data: { n: 1 } });
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ type: "test_event", data: { n: 1 } });

      // 2. Destroy the session (simulates logout/expiry) → next broadcast
      // must NOT reach this client, and the socket must be closed.
      sessions.delete(sid);
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      (dashboard as any).broadcast({ type: "test_event", data: { n: 2 } });
      await closed;
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(1); // still just the first message
      expect(ws.readyState).not.toBe(WsClient.OPEN);
    } finally {
      sessions.delete(sid);
      await dashboard.stop();
    }
  });
});

describe("broker-account routes behind the real auth wall (platform F2, 2026-10-04)", () => {
  test("the Alpaca OAuth callback passes WITHOUT a session (strict sid is not sent cross-site) and only bounces; the list and complete routes still require the session", async () => {
    await withServer(async (base, cookie) => {
      const cb = await fetch(`${base}/api/platform/accounts/oauth/alpaca/callback?code=c&state=s`, { redirect: "manual" });
      expect(cb.status).toBe(200);
      expect(await cb.text()).toContain("/api/platform/accounts/oauth/alpaca/complete?code=c&amp;state=s");

      const listAnon = await fetch(`${base}/api/platform/accounts`, { redirect: "manual" });
      expect(listAnon.status).toBe(401);
      const completeAnon = await fetch(`${base}/api/platform/accounts/oauth/alpaca/complete?code=c&state=s`, { redirect: "manual" });
      expect(completeAnon.status).toBe(401);
      const postCb = await fetch(`${base}/api/platform/accounts/oauth/alpaca/callback`, { method: "POST", redirect: "manual" });
      expect(postCb.status).toBe(401); // only GET is let through

      const list = await fetch(`${base}/api/platform/accounts`, { headers: { cookie } });
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(Array.isArray(body.accounts)).toBe(true);
      expect(typeof body.configured).toBe("boolean");
    });
  });
});

describe("portfolio registry route behind the real auth wall (platform F3, 2026-10-04)", () => {
  test("read-only in this deploy: the seeded registry lists with a session, 401 without, and writes answer 501", async () => {
    const { initPlatformPortfolios } = await import("../portfolios/store");
    const { getDB } = await import("../db/database");
    await withServer(async (base, cookie) => {
      initPlatformPortfolios(getDB());
      const anon = await fetch(`${base}/api/platform/portfolios`, { redirect: "manual" });
      expect(anon.status).toBe(401);
      const res = await fetch(`${base}/api/platform/portfolios`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      const ids = body.map((p: any) => p.id).sort();
      expect(ids).toEqual(["meanrev_stocks", "momentum_btc", "momentum_crypto", "momentum_crypto_usdc", "momentum_stocks"]);
      const write = await fetch(`${base}/api/platform/portfolios`, {
        method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": "x" }, body: "{}",
      });
      expect(write.status).toBe(501);
    });
  });
});

describe("portfolio writes exist only under PORTFOLIOS_SOURCE=db (platform F3, 2026-10-04)", () => {
  test("db: create validates against the runtime's accounts and broker-truth equity, failing closed without a reading", async () => {
    const { initPlatformPortfolios } = await import("../portfolios/store");
    const { getDB } = await import("../db/database");
    makeTestDb();
    initPlatformPortfolios(getDB());
    const seededUser = USERS.length === 0;
    if (seededUser) USERS.push({ username: "test-admin", passwordHash: "x", role: "admin", displayName: "Test" });
    const prev = process.env.PORTFOLIOS_SOURCE;
    process.env.PORTFOLIOS_SOURCE = "db";
    const equity: Record<string, number | null> = { alpaca_main: 200_000, binance_usdt: null };
    const am = { ...fakeAm, runtimeAccounts: () => ["alpaca_main", "binance_usdt"], brokerAccountEquity: (a: string) => equity[a] ?? null };
    const server = (new DashboardServer(am as any) as any).app.listen(0);
    const sid = "test-sid-db";
    sessions.set(sid, {
      id: sid, username: "admin", role: "admin", displayName: "Admin",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
    });
    try {
      const { port } = server.address() as { port: number };
      const post = (body: object) => fetch(`http://127.0.0.1:${port}/api/platform/portfolios`, {
        method: "POST", headers: { cookie: `sid=${sid}`, "content-type": "application/json", "x-csrf-token": "x" }, body: JSON.stringify(body),
      });
      // No broker reading for the USDT pool → refused (fail closed), nothing written.
      const closed = await post({ id: "crypto_two", name: "Crypto 2", account: "binance_usdt", capital: 1_000, preset: "momentum_crypto" });
      expect(closed.status).toBeGreaterThanOrEqual(400);
      // An account this runtime has not wired → refused.
      const unwired = await post({ id: "usdc_two", name: "USDC 2", account: "binance_usdc", capital: 500, preset: "momentum_crypto_usdc" });
      expect(unwired.status).toBeGreaterThanOrEqual(400);
      const { loadPlatformPortfolioRows } = await import("../portfolios/store");
      expect(loadPlatformPortfolioRows(getDB()).map(r => r.id)).not.toContain("crypto_two");
    } finally {
      if (prev === undefined) delete process.env.PORTFOLIOS_SOURCE; else process.env.PORTFOLIOS_SOURCE = prev;
      sessions.delete(sid);
      if (seededUser) { const i = USERS.findIndex(u => u.username === "test-admin"); if (i >= 0) USERS.splice(i, 1); }
      server.close();
    }
  });
});
