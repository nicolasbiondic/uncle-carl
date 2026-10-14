// Dashboard sessions survive a restart (owner 2026-10-11: "¿por qué en cada
// auto deploy nuevo me deslogueo? ¿no está funcionando el stay signed in?").
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "crypto";
import {
  sessions, getSessionBySid, attachSessionPersistence, detachSessionPersistence, sessionsOfUser,
  revokeSessionByHandle, revokeOtherSessions, sessionHandle, sweepStaleSessions, SESSION_TTL,
  type Session,
} from "./auth-store";
import { createSessionStore, hashSid, type SessionStore } from "./sessionPersistence";

const newSid = () => randomBytes(32).toString("hex");

function mk(sid: string, over: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id: sid, username: "owner", role: "admin", displayName: "Owner",
    createdAt: now - 1_000, lastActivity: now, csrfToken: `csrf-${sid.slice(0, 8)}`,
    rememberMe: true, settings: { viewId: "consolidated" }, userAgent: "Mozilla/5.0 Chrome/130", ip: "192.0.2.10",
    ...over,
  };
}

let db: Database;

/** A restart: the process forgets every live session; the database survives. */
function restart(store?: SessionStore) {
  sessions.clear(); // Map.prototype.clear — memory only
  detachSessionPersistence();
  return attachSessionPersistence(store ?? createSessionStore(db));
}

const rowCount = () => (db.query("SELECT COUNT(*) n FROM platform_sessions").get() as { n: number }).n;

beforeEach(() => {
  sessions.clear();
  detachSessionPersistence();
  db = new Database(":memory:");
  attachSessionPersistence(createSessionStore(db));
});

afterEach(() => {
  setSystemTime();
  sessions.clear();
  detachSessionPersistence();
  db.close();
});

describe("dashboard sessions survive a restart", () => {
  test("a stay-signed-in session comes back after a restart: same user and CSRF token, live again", () => {
    const sid = newSid();
    sessions.set(sid, mk(sid));
    expect(restart()).toEqual({ restored: 1, expired: 0 });
    expect(sessions.has(sid)).toBe(false); // dormant until the browser returns
    const s = getSessionBySid(sid);
    expect(s?.username).toBe("owner");
    expect(s?.csrfToken).toBe(`csrf-${sid.slice(0, 8)}`);
    expect(s?.id).toBe(sid);
    expect(sessions.has(sid)).toBe(true);
  });

  test("the raw sid never reaches the database — only its sha256", () => {
    const sid = newSid();
    sessions.set(sid, mk(sid));
    const row = db.query("SELECT * FROM platform_sessions").get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(sid);
    expect(row.sid_hash).toBe(hashSid(sid));
  });

  test("a cookie that was never issued finds nothing", () => {
    sessions.set(newSid(), mk("x"));
    restart();
    expect(getSessionBySid(newSid())).toBeNull();
  });

  test("logout deletes the stored row: the cookie is dead after a restart", () => {
    const sid = newSid();
    sessions.set(sid, mk(sid));
    sessions.delete(sid);
    expect(rowCount()).toBe(0);
    restart();
    expect(getSessionBySid(sid)).toBeNull();
  });

  test("a restored session whose browser hasn't returned is listed and revocable (Ajustes → Sessions)", () => {
    const current = newSid();
    const other = newSid();
    sessions.set(current, mk(current));
    sessions.set(other, mk(other, { userAgent: "Mozilla/5.0 (iPhone) Safari/604.1" }));
    restart();
    getSessionBySid(current); // this browser came back; the phone hasn't
    const list = sessionsOfUser("owner");
    expect(list.map((v) => v.handle).sort()).toEqual([sessionHandle(current), sessionHandle(other)].sort());
    expect(list.find((v) => v.handle === sessionHandle(other))?.sid).toBeNull();
    expect(revokeSessionByHandle("owner", sessionHandle(other))).toEqual({ sid: null });
    expect(revokeSessionByHandle("someone-else", sessionHandle(current))).toBeNull();
    expect(rowCount()).toBe(1);
    restart();
    expect(getSessionBySid(other)).toBeNull();
    expect(getSessionBySid(current)).not.toBeNull();
  });

  test("'log out other sessions' also ends the restored ones", () => {
    const keep = newSid();
    sessions.set(keep, mk(keep));
    sessions.set(newSid(), mk("b"));
    sessions.set(newSid(), mk("c"));
    restart();
    getSessionBySid(keep);
    expect(revokeOtherSessions("owner", keep)).toBe(2);
    expect(rowCount()).toBe(1);
  });

  test("expired sessions are removed at boot and by the hourly sweep", () => {
    const old = newSid();
    sessions.set(old, mk(old, { rememberMe: false, lastActivity: Date.now() - SESSION_TTL - 60_000 }));
    expect(restart()).toEqual({ restored: 0, expired: 1 });
    expect(rowCount()).toBe(0);

    const sid = newSid();
    sessions.set(sid, mk(sid, { rememberMe: false }));
    restart(); // dormant now
    setSystemTime(new Date(Date.now() + SESSION_TTL + 60_000));
    sweepStaleSessions();
    expect(rowCount()).toBe(0);
    expect(getSessionBySid(sid)).toBeNull();
  });

  test("activity is written at most once a minute per session", () => {
    const sid = newSid();
    const t0 = Date.now();
    sessions.set(sid, mk(sid, { lastActivity: t0 }));
    const stored = () => (db.query("SELECT last_activity FROM platform_sessions").get() as { last_activity: number }).last_activity;
    setSystemTime(new Date(t0 + 5_000));
    getSessionBySid(sid);
    expect(stored()).toBe(t0);
    setSystemTime(new Date(t0 + 61_000));
    getSessionBySid(sid);
    expect(stored()).toBe(t0 + 61_000);
  });

  test("the selected dashboard view travels with the session", () => {
    const sid = newSid();
    const s = mk(sid);
    sessions.set(sid, s);
    s.settings.viewId = "momentum_stocks";
    sessions.set(sid, s);
    restart();
    expect(getSessionBySid(sid)?.settings.viewId).toBe("momentum_stocks");
  });

  test("a failing database never breaks a login: the session still works in memory", () => {
    const broken: SessionStore = {
      upsert: () => { throw new Error("disk full"); },
      remove: () => { throw new Error("disk full"); },
      removeByHash: () => { throw new Error("disk full"); },
      touch: () => { throw new Error("disk full"); },
      loadAll: () => [],
    };
    restart(broken);
    const sid = newSid();
    expect(() => sessions.set(sid, mk(sid))).not.toThrow();
    expect(getSessionBySid(sid)?.username).toBe("owner");
    expect(() => sessions.delete(sid)).not.toThrow();
  });
});
