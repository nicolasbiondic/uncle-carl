// ═══ First-run web setup — /setup + /api/setup ═══
// Covers both sides of the additive invariant:
//   - an installation WITH users (prod) never exposes setup (redirect/410);
//   - a brand-new installation serves /setup, demands the log token, and
//     the created owner can immediately log in with the password flow.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { DashboardServer } from "../server";
import { USERS, reloadUsers, sessions } from "../auth-store";
import { resetInstanceConfigForTests, instanceFilePath } from "../../platform/instance";
import { masterKeyPath } from "../../platform/secretBox";
import { resetSetupTokenForTests, getSetupTokenForTests, needsFirstRunSetup } from "./setup";
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

const ENV_KEYS = [
  "UC_DATA_DIR",
  "DASHBOARD_ADMIN_USER", "DASHBOARD_ADMIN_PASSWORD_HASH", "DASHBOARD_ADMIN_DISPLAY_NAME",
  "DASHBOARD_VIEWER_USER", "DASHBOARD_VIEWER_PASSWORD_HASH", "DASHBOARD_VIEWER_DISPLAY_NAME",
];
const savedEnv: Record<string, string | undefined> = {};
let tmp: string;
let server: any;
let base: string;

beforeAll(async () => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uc-websetup-"));
  process.env.UC_DATA_DIR = tmp;
  resetInstanceConfigForTests();
  resetSetupTokenForTests();
  reloadUsers(); // no env users, no instance.json → zero users
  makeTestDb();
  const dashboard = new DashboardServer(fakeAm); // constructor announces the token
  server = (dashboard as any).app.listen(0);
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  require("fs").rmSync(tmp, { recursive: true, force: true }); // stale @types/node lacks rmSync (repo-wide dodge)
  resetInstanceConfigForTests();
  resetSetupTokenForTests();
  reloadUsers();
  server?.close();
});

async function postSetup(body: any): Promise<Response> {
  return await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("first-run web setup (no owner anywhere)", () => {
  test("a fresh installation serves /setup: / and /login redirect there, token was minted", async () => {
    expect(needsFirstRunSetup()).toBe(true);
    expect(getSetupTokenForTests()).toBeTruthy(); // printed in the log at construction

    const root = await fetch(`${base}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/setup");

    const login = await fetch(`${base}/login`, { redirect: "manual" });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/setup");

    const page = await fetch(`${base}/setup`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("First-run setup");
  });

  test("wrong token → 403 and no owner is created; weak inputs → 400", async () => {
    const bad = await postSetup({ token: "not-the-token", username: "owner", password: "longenough" });
    expect(bad.status).toBe(403);
    expect(fs.existsSync(instanceFilePath(tmp))).toBe(false);

    const token = getSetupTokenForTests()!;
    expect((await postSetup({ token, username: "x", password: "longenough" })).status).toBe(400);  // bad username
    expect((await postSetup({ token, username: "owner", password: "short" })).status).toBe(400);   // bad password
    expect(fs.existsSync(instanceFilePath(tmp))).toBe(false);
  });

  test("correct token claims the installation: 0600 files, live user reload, single-use token, then password login works", async () => {
    const token = getSetupTokenForTests()!;
    const ok = await postSetup({ token, username: "Owner", password: "a-strong-password" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, username: "owner" });

    // Files written with owner-only permissions
    expect(fs.statSync(instanceFilePath(tmp)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(masterKeyPath(tmp)).mode & 0o777).toBe(0o600);
    const written = JSON.parse(fs.readFileSync(instanceFilePath(tmp), "utf8"));
    expect(written.owner.username).toBe("owner");
    expect(written.owner.passwordHash.startsWith("$argon2id$")).toBe(true);

    // Live reload — no restart needed
    expect(needsFirstRunSetup()).toBe(false);
    expect(USERS.find(u => u.username === "owner")).toMatchObject({ role: "admin" });
    expect(getSetupTokenForTests()).toBeNull(); // single use

    // Setup is now off…
    const page = await fetch(`${base}/setup`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    expect((await postSetup({ token, username: "evil", password: "whatever123" })).status).toBe(410);

    // …and the owner logs in through the untouched password flow.
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "a-strong-password" }),
    });
    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body.ok).toBe(true);
    expect(body.user).toMatchObject({ username: "owner", role: "admin" });
    // Clean the session created by the login
    for (const [sid, s] of sessions) if (s.username === "owner") sessions.delete(sid);
  });
});
