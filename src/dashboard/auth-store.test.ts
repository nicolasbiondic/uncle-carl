import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { loadUsersFromEnv, loadUsers, sessions, sweepStaleSessions, SESSION_TTL, REMEMBER_ME_TTL } from "./auth-store";
import type { Session } from "./auth-store";
import { resetInstanceConfigForTests, instanceFilePath } from "../platform/instance";

const KEYS = [
  "DASHBOARD_ADMIN_USER", "DASHBOARD_ADMIN_PASSWORD_HASH", "DASHBOARD_ADMIN_DISPLAY_NAME",
  "DASHBOARD_VIEWER_USER", "DASHBOARD_VIEWER_PASSWORD_HASH", "DASHBOARD_VIEWER_DISPLAY_NAME",
];
function clearEnv() { for (const k of KEYS) delete process.env[k]; }

describe("loadUsersFromEnv — multi-user / roles (audit F3)", () => {
  beforeEach(clearEnv);

  test("admin only — backward compatible", () => {
    process.env.DASHBOARD_ADMIN_USER = "alice";
    process.env.DASHBOARD_ADMIN_PASSWORD_HASH = "hash-admin";
    const u = loadUsersFromEnv();
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ username: "alice", role: "admin", displayName: "Admin" });
  });

  test("optional read-only viewer is added as a 2nd user", () => {
    process.env.DASHBOARD_ADMIN_USER = "alice";
    process.env.DASHBOARD_ADMIN_PASSWORD_HASH = "hash-admin";
    process.env.DASHBOARD_VIEWER_USER = "guest";
    process.env.DASHBOARD_VIEWER_PASSWORD_HASH = "hash-viewer";
    process.env.DASHBOARD_VIEWER_DISPLAY_NAME = "Read Only";
    const u = loadUsersFromEnv();
    expect(u).toHaveLength(2);
    expect(u.find(x => x.username === "guest")).toMatchObject({ role: "viewer", displayName: "Read Only" });
    expect(u.find(x => x.username === "alice")!.role).toBe("admin");
  });

  test("usernames are lowercased and duplicates rejected (admin wins)", () => {
    process.env.DASHBOARD_ADMIN_USER = "Alice";
    process.env.DASHBOARD_ADMIN_PASSWORD_HASH = "hash-admin";
    process.env.DASHBOARD_VIEWER_USER = "alice"; // collides after lowercasing
    process.env.DASHBOARD_VIEWER_PASSWORD_HASH = "hash-viewer";
    const u = loadUsersFromEnv();
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ username: "alice", role: "admin" });
  });

  test("no credentials → login disabled (empty)", () => {
    expect(loadUsersFromEnv()).toHaveLength(0);
  });

  test("a viewer without an admin still loads", () => {
    process.env.DASHBOARD_VIEWER_USER = "guest";
    process.env.DASHBOARD_VIEWER_PASSWORD_HASH = "h";
    const u = loadUsersFromEnv();
    expect(u).toHaveLength(1);
    expect(u[0].role).toBe("viewer");
  });
});

// Platform phase (2026-10-04): loadUsers = env users + the instance.json
// owner. The first test is the ADDITIVE lock: with no instance.json the
// result is byte-identical to loadUsersFromEnv (today's prod behavior).
describe("loadUsers — env users + instance.json owner", () => {
  const KEYS2 = [...KEYS, "UC_DATA_DIR"];
  let saved: Record<string, string | undefined> = {};
  let tmp: string;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS2) { saved[k] = process.env[k]; delete process.env[k]; }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uc-authstore-"));
    process.env.UC_DATA_DIR = tmp;
    resetInstanceConfigForTests();
  });
  afterEach(() => {
    for (const k of KEYS2) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    require("fs").rmSync(tmp, { recursive: true, force: true }); // stale @types/node lacks rmSync (repo-wide dodge)
    resetInstanceConfigForTests();
  });

  function writeOwner(owner: any) {
    fs.writeFileSync(instanceFilePath(tmp), JSON.stringify({ owner }));
    resetInstanceConfigForTests();
  }

  test("ADDITIVE LOCK: without instance.json, loadUsers === loadUsersFromEnv (prod unchanged)", () => {
    process.env.DASHBOARD_ADMIN_USER = "alice";
    process.env.DASHBOARD_ADMIN_PASSWORD_HASH = "hash-admin";
    process.env.DASHBOARD_VIEWER_USER = "guest";
    process.env.DASHBOARD_VIEWER_PASSWORD_HASH = "hash-viewer";
    expect(loadUsers()).toEqual(loadUsersFromEnv());
    expect(loadUsers()).toHaveLength(2);
  });

  test("instance.json owner is added as an admin alongside env users", () => {
    process.env.DASHBOARD_VIEWER_USER = "guest";
    process.env.DASHBOARD_VIEWER_PASSWORD_HASH = "hash-viewer";
    writeOwner({ username: "nico", passwordHash: "owner-hash", displayName: "Nico" });
    const users = loadUsers();
    expect(users).toHaveLength(2);
    expect(users.find(u => u.username === "nico")).toMatchObject({ role: "admin", passwordHash: "owner-hash" });
  });

  test("username collision: the env user wins (env > instance.json)", () => {
    process.env.DASHBOARD_ADMIN_USER = "nico";
    process.env.DASHBOARD_ADMIN_PASSWORD_HASH = "env-hash";
    writeOwner({ username: "Nico", passwordHash: "file-hash" });
    const users = loadUsers();
    expect(users).toHaveLength(1);
    expect(users[0].passwordHash).toBe("env-hash");
  });
});

// P3-3 regression: the janitor used to sweep every session against the fixed
// SESSION_TTL (7d), killing "remember me" sessions (30d TTL) between day 7
// and day 30 — the live-lookup path (getSessionBySid) already honored
// rememberMe; the janitor didn't.
describe("sweepStaleSessions honors rememberMe (P3-3 fix)", () => {
  function makeSession(id: string, overrides: Partial<Session>): Session {
    return {
      id, username: "u", role: "viewer", displayName: "U",
      createdAt: Date.now(), lastActivity: Date.now(), csrfToken: "x",
      rememberMe: false, settings: { viewId: "consolidated" },
      ...overrides,
    };
  }

  test("rememberMe session with 10d-old lastActivity survives the sweep (still < 30d)", () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60_000;
    expect(10 * 24 * 60 * 60_000).toBeGreaterThan(SESSION_TTL);
    expect(10 * 24 * 60 * 60_000).toBeLessThan(REMEMBER_ME_TTL);
    sessions.set("remember-10d", makeSession("remember-10d", { rememberMe: true, lastActivity: tenDaysAgo }));
    try {
      sweepStaleSessions();
      expect(sessions.has("remember-10d")).toBe(true);
    } finally {
      sessions.delete("remember-10d");
    }
  });

  test("non-rememberMe session with 10d-old lastActivity is swept (> 7d SESSION_TTL)", () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60_000;
    sessions.set("normal-10d", makeSession("normal-10d", { rememberMe: false, lastActivity: tenDaysAgo }));
    try {
      sweepStaleSessions();
      expect(sessions.has("normal-10d")).toBe(false);
    } finally {
      sessions.delete("normal-10d");
    }
  });
});
