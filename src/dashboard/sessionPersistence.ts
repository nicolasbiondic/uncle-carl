// ═══ Dashboard session persistence (2026-10-11) ═══
//
// Sessions lived only in auth-store's in-memory Map, so every restart — every
// deploy — logged every browser out, "stay signed in" included (it only
// lengthens the TTL). This store mirrors them into SQLite (platform_sessions)
// so a restart keeps them:
//   - rows are keyed by sha256(sid): the raw sid is a bearer token and never
//     reaches the disk or the daily DB backups. A returning cookie finds its
//     row by hashing itself (auth-store's getSessionBySid);
//   - writes: login (upsert), logout/revoke/expiry (delete), and a throttled
//     last-activity touch (at most once per TOUCH_INTERVAL_MS per session).
// auth-store owns the TTL rules and the dormant/live bookkeeping; this module
// is plain storage. Callers treat every method as fail-soft.

import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import type { Session } from "./auth-store";

/** sha256(sid) hex — the only form of a sid that is ever stored. */
export function hashSid(sid: string): string {
  return createHash("sha256").update(sid).digest("hex");
}

/** A persisted session: everything but the raw sid, plus its hash. */
export type StoredSession = Omit<Session, "id"> & { sidHash: string };

export interface SessionStore {
  upsert(sid: string, s: Session): void;
  remove(sid: string): void;
  removeByHash(sidHash: string): void;
  /** upsert, but at most once per touch interval per session. */
  touch(sid: string, s: Session): void;
  loadAll(): StoredSession[];
}

export const TOUCH_INTERVAL_MS = 60_000;

export function createSessionStore(db: Database, opts: { touchIntervalMs?: number } = {}): SessionStore {
  const touchEvery = opts.touchIntervalMs ?? TOUCH_INTERVAL_MS;
  db.run(`CREATE TABLE IF NOT EXISTS platform_sessions (
    sid_hash      TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    role          TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    csrf_token    TEXT NOT NULL,
    remember_me   INTEGER NOT NULL DEFAULT 0,
    settings_json TEXT NOT NULL DEFAULT '{}',
    user_agent    TEXT,
    ip            TEXT
  )`);
  const upsertStmt = db.prepare(`INSERT INTO platform_sessions
      (sid_hash, username, role, display_name, created_at, last_activity, csrf_token, remember_me, settings_json, user_agent, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sid_hash) DO UPDATE SET
      username = excluded.username, role = excluded.role, display_name = excluded.display_name,
      last_activity = excluded.last_activity, csrf_token = excluded.csrf_token, remember_me = excluded.remember_me,
      settings_json = excluded.settings_json, user_agent = excluded.user_agent, ip = excluded.ip`);
  const deleteStmt = db.prepare(`DELETE FROM platform_sessions WHERE sid_hash = ?`);
  const lastWritten = new Map<string, number>();

  const write = (h: string, s: Session) => {
    upsertStmt.run(
      h, s.username, s.role, s.displayName, s.createdAt, s.lastActivity, s.csrfToken,
      s.rememberMe ? 1 : 0, JSON.stringify(s.settings ?? { viewId: "consolidated" }), s.userAgent ?? null, s.ip ?? null,
    );
    lastWritten.set(h, s.lastActivity);
  };
  const removeByHash = (h: string) => { deleteStmt.run(h); lastWritten.delete(h); };

  return {
    upsert(sid, s) { write(hashSid(sid), s); },
    remove(sid) { removeByHash(hashSid(sid)); },
    removeByHash,
    touch(sid, s) {
      const h = hashSid(sid);
      if (s.lastActivity - (lastWritten.get(h) ?? 0) < touchEvery) return;
      write(h, s);
    },
    loadAll() {
      const rows = db.query(`SELECT * FROM platform_sessions`).all() as any[];
      return rows.map((r) => {
        let settings: Session["settings"] = { viewId: "consolidated" };
        try { settings = { ...settings, ...JSON.parse(r.settings_json) }; } catch { /* keep the default */ }
        lastWritten.set(r.sid_hash, r.last_activity);
        return {
          sidHash: r.sid_hash,
          username: r.username,
          role: r.role === "admin" ? "admin" : "viewer",
          displayName: r.display_name,
          createdAt: r.created_at,
          lastActivity: r.last_activity,
          csrfToken: r.csrf_token,
          rememberMe: r.remember_me === 1,
          settings,
          ...(r.user_agent != null ? { userAgent: r.user_agent } : {}),
          ...(r.ip != null ? { ip: r.ip } : {}),
        } as StoredSession;
      });
    },
  };
}
