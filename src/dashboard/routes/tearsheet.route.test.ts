// ══════════════════════════════════════════════
// GET /api/v2/tearsheet/:sleeve — behind the auth wall (401 without a
// session); :sleeve is ONLY a whitelist key into sleeveExpectationArtifacts
// (no path traversal surface — an unknown sleeve is a clean 404, never a
// filesystem probe); missing tearsheet.html is a clean 404; a present one
// is served as text/html with a no-external-origin CSP. Artifact dirs are
// env-overridable (SCORECARD_ARTIFACT_*), which is how these tests point
// the route at controlled fixtures instead of data/backtests.
// ══════════════════════════════════════════════

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// require("fs") dodges bun-types' fs shim, which omits rmSync and the
// recursive mkdirSync overload (same dodge as scorecard.test.ts).
const rmSync = (p: string, o: any) => { try { require("fs").rmSync(p, o); } catch {} };
const mkdirpSync = (p: string) => require("fs").mkdirSync(p, { recursive: true });
import { DashboardServer } from "../server";
import { sessions } from "../auth-store";
import { makeTestDb } from "../../test-support/db";

const tmp = mkdtempSync(join(tmpdir(), "tearsheet-route-"));
const withFile = join(tmp, "with-tearsheet");
const withoutFile = join(tmp, "without-tearsheet");
const FIXTURE_HTML = "<!doctype html><html><body><h1>tearsheet fixture cc2f</h1></body></html>";

const envKeys = ["SCORECARD_ARTIFACT_MOMENTUM_STOCKS", "SCORECARD_ARTIFACT_MEANREV_STOCKS", "SCORECARD_ARTIFACT_MOMENTUM_CRYPTO_USDC"] as const;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  mkdirpSync(withFile);
  mkdirpSync(withoutFile);
  writeFileSync(join(withFile, "tearsheet.html"), FIXTURE_HTML);
  for (const k of envKeys) prevEnv[k] = process.env[k];
  process.env.SCORECARD_ARTIFACT_MOMENTUM_STOCKS = withFile;   // has tearsheet.html
  process.env.SCORECARD_ARTIFACT_MEANREV_STOCKS = withoutFile; // whitelisted, no file
  // Whitelisted since U1 2026-09-26 (authoritative control artifact 4b403501…,
  // NOT gate-validated — see liveSleeveConfigs.ts); pinned to a fixture so
  // the test doesn't depend on gitignored data/backtests contents.
  process.env.SCORECARD_ARTIFACT_MOMENTUM_CRYPTO_USDC = withFile;
});

afterAll(() => {
  for (const k of envKeys) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function withServer<T>(fn: (baseUrl: string, cookie: string) => Promise<T>): Promise<T> {
  makeTestDb();
  const dashboard = new DashboardServer({
    executor: {
      alpaca: { isConnected: () => false, lastMessageAt: 0 },
      binance: { isConnected: () => false, lastMessageAt: 0 },
    },
    accounts: new Map(),
    lastSyncAt: 0,
    getCircuits: () => ({}),
    getDashboardData: () => ({}),
  } as any);
  const server = (dashboard as any).app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const sid = "tearsheet-test-sid";
    sessions.set(sid, {
      id: sid, username: "admin", role: "admin", displayName: "Admin",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
    } as any);
    return await fn(`http://127.0.0.1:${port}`, `sid=${sid}`);
  } finally {
    sessions.delete("tearsheet-test-sid");
    server.close();
  }
}

describe("GET /api/v2/tearsheet/:sleeve", () => {
  test("401 without a session", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v2/tearsheet/momentum_stocks`);
      expect(res.status).toBe(401);
    });
  });

  test("200 + text/html + restrictive headers when the artifact has a tearsheet", async () => {
    await withServer(async (base, cookie) => {
      const res = await fetch(`${base}/api/v2/tearsheet/momentum_stocks`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain("http"); // no external origins whitelisted
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe(FIXTURE_HTML);
    });
  });

  test("404 (clean JSON, not a crash) when the whitelisted artifact has no tearsheet.html", async () => {
    await withServer(async (base, cookie) => {
      const res = await fetch(`${base}/api/v2/tearsheet/meanrev_stocks`, { headers: { cookie } });
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error).toContain("no generado");
    });
  });

  test("sleeves outside the whitelist are rejected with 404 — including traversal-shaped params", async () => {
    await withServer(async (base, cookie) => {
      for (const bad of [
        "momentum_btc",                  // real sleeve, NO authoritative artifact
        "nonexistent",
        "..%2F..%2F..%2Fetc%2Fpasswd",   // traversal-shaped param never touches the fs
        "__proto__",                     // hasOwnProperty guard, not an `in` lookup
      ]) {
        const res = await fetch(`${base}/api/v2/tearsheet/${bad}`, { headers: { cookie } });
        expect(res.status).toBe(404);
      }
    });
  });

  test("momentum_crypto_usdc is whitelisted since U1 (authoritative control artifact)", async () => {
    await withServer(async (base, cookie) => {
      const res = await fetch(`${base}/api/v2/tearsheet/momentum_crypto_usdc`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(FIXTURE_HTML);
    });
  });
});
