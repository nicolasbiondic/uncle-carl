// ═══ /api/platform/me + /api/platform/sessions over a bare express ═══
//
// No auth wall here on purpose (server.ts middleware owns session/CSRF): a
// test middleware stamps req.session, and the suite exercises the routes'
// own contract — identity shape, handle hashing (never the raw sid), the
// username filter (a viewer only sees/revokes their own), revoke-others.

import express from "express";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb } from "../../test-support/db";
import { sessions } from "../auth-store";
import type { Session } from "../auth-store";
import { registerPlatformRoutes, sessionHandle } from "./platform";
import { getInstanceId } from "../../platform/meta";

function mkSession(over: Partial<Session> & { id: string; username: string }): Session {
  const s: Session = {
    role: "admin",
    displayName: over.username,
    createdAt: 1_700_000_000_000,
    lastActivity: Date.now(),
    csrfToken: "csrf",
    rememberMe: false,
    settings: { viewId: "consolidated" },
    userAgent: "TestUA/1.0 (X11; Linux x86_64)",
    ip: "203.0.113.1",
    ...over,
  } as Session;
  sessions.set(s.id, s);
  return s;
}

let server: ReturnType<express.Application["listen"]>;
let base = "";
let actAs: string | null = null;

beforeEach(() => {
  makeTestDb();
  sessions.clear();
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = actAs ? sessions.get(actAs) ?? null : null;
    next();
  });
  registerPlatformRoutes(app);
  server = app.listen(0);
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  server.close();
  sessions.clear();
  actAs = null;
});

const get = (p: string) => fetch(base + p);
const del = (p: string) => fetch(base + p, { method: "DELETE" });
const post = (p: string) => fetch(base + p, { method: "POST" });

describe("GET /api/platform/me", () => {
  test("identity shape: stable accountId derived from instanceId+username", async () => {
    mkSession({ id: "sid-owner", username: "owner", displayName: "The Owner" });
    actAs = "sid-owner";
    const r = await get("/api/platform/me");
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.username).toBe("owner");
    expect(body.displayName).toBe("The Owner");
    expect(body.role).toBe("admin");
    expect(body.accountId).toMatch(/^acct_[0-9a-f]{12}$/);
    expect(body.instanceId).toBe(getInstanceId());
    expect(typeof body.loginMethods?.password).toBe("boolean");
    expect(typeof body.loginMethods?.github).toBe("boolean");
    expect(typeof body.loginMethods?.google).toBe("boolean");
    expect(["env", "registry"]).toContain(body.accountsSource);
    expect(["code", "db"]).toContain(body.portfoliosSource);
    // stable across calls
    const again: any = await (await get("/api/platform/me")).json();
    expect(again.accountId).toBe(body.accountId);
  });

  test("401 without a session", async () => {
    actAs = null;
    expect((await get("/api/platform/me")).status).toBe(401);
  });
});

describe("GET /api/platform/sessions", () => {
  test("lists ONLY the current user's sessions, hashed handles, current flag", async () => {
    mkSession({ id: "sid-a1", username: "owner" });
    mkSession({ id: "sid-a2", username: "owner", userAgent: "OtherUA", ip: "203.0.113.2" });
    mkSession({ id: "sid-v1", username: "viewer", role: "viewer" });
    actAs = "sid-a1";
    const body: any = await (await get("/api/platform/sessions")).json();
    expect(body.sessions.length).toBe(2);
    const handles = body.sessions.map((s: any) => s.handle);
    expect(handles).toContain(sessionHandle("sid-a1"));
    expect(handles).toContain(sessionHandle("sid-a2"));
    expect(handles).not.toContain(sessionHandle("sid-v1"));
    // never the raw sid
    for (const s of body.sessions) {
      expect(s.handle).not.toContain("sid-");
      expect(JSON.stringify(s)).not.toContain("sid-a1");
    }
    expect(body.sessions.find((s: any) => s.handle === sessionHandle("sid-a1")).current).toBe(true);
    expect(body.sessions.find((s: any) => s.handle === sessionHandle("sid-a2")).current).toBe(false);
    expect(body.sessions.find((s: any) => s.handle === sessionHandle("sid-a2")).device).toBe("OtherUA");
  });
});

describe("DELETE /api/platform/sessions/:handle", () => {
  test("revokes one of my sessions by handle", async () => {
    mkSession({ id: "sid-a1", username: "owner" });
    mkSession({ id: "sid-a2", username: "owner" });
    actAs = "sid-a1";
    const r = await del(`/api/platform/sessions/${sessionHandle("sid-a2")}`);
    expect(r.status).toBe(200);
    expect(sessions.has("sid-a2")).toBe(false);
    expect(sessions.has("sid-a1")).toBe(true);
  });

  test("cannot revoke ANOTHER user's session (404, session survives)", async () => {
    mkSession({ id: "sid-a1", username: "owner" });
    mkSession({ id: "sid-v1", username: "viewer", role: "viewer" });
    actAs = "sid-a1";
    const r = await del(`/api/platform/sessions/${sessionHandle("sid-v1")}`);
    expect(r.status).toBe(404);
    expect(sessions.has("sid-v1")).toBe(true);
  });

  test("a viewer revokes their own", async () => {
    mkSession({ id: "sid-v1", username: "viewer", role: "viewer" });
    mkSession({ id: "sid-v2", username: "viewer", role: "viewer" });
    actAs = "sid-v1";
    const r = await del(`/api/platform/sessions/${sessionHandle("sid-v2")}`);
    expect(r.status).toBe(200);
    expect(sessions.has("sid-v2")).toBe(false);
  });
});

describe("POST /api/platform/sessions/revoke-others", () => {
  test("keeps only the current session for this user; other users untouched", async () => {
    mkSession({ id: "sid-a1", username: "owner" });
    mkSession({ id: "sid-a2", username: "owner" });
    mkSession({ id: "sid-a3", username: "owner" });
    mkSession({ id: "sid-v1", username: "viewer", role: "viewer" });
    actAs = "sid-a1";
    const body: any = await (await post("/api/platform/sessions/revoke-others")).json();
    expect(body.revoked).toBe(2);
    expect(sessions.has("sid-a1")).toBe(true);
    expect(sessions.has("sid-a2")).toBe(false);
    expect(sessions.has("sid-a3")).toBe(false);
    expect(sessions.has("sid-v1")).toBe(true);
  });
});
