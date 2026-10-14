// ═══ Auth + Session store (module-level singletons) ═══

import type express from "express";
import { createLogger } from "../utils/logger";
import { getClientIp } from "./dashboard-utils";
import { loadInstanceConfig } from "../platform/instance";
import { hashSid, type SessionStore, type StoredSession } from "./sessionPersistence";

const log = createLogger("Dashboard");

// ── Types ──────────────────────────────────────────────────────────────────

export interface User {
  username: string;
  passwordHash: string;
  role: "admin" | "viewer";
  displayName: string;
}

export interface Session {
  id: string;
  username: string;
  role: "admin" | "viewer";
  displayName: string;
  createdAt: number;
  lastActivity: number;
  csrfToken: string;
  rememberMe: boolean;
  settings: { viewId: string };
  /** Device metadata captured at login (platform sessions UI). Optional:
   *  pre-existing sessions/tests without them stay valid. */
  userAgent?: string;
  ip?: string;
}

export interface LoginAttemptState {
  count: number;
  firstAttemptAt: number;
  lockUntil: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const SESSION_TTL       =  7 * 24 * 60 * 60_000; // 7 days (default)
export const REMEMBER_ME_TTL   = 30 * 24 * 60 * 60_000; // 30 days (remember me)

// Audit fix wave 5 (2026-05-04): use `||` not `??` so that an empty
// .env value (DASHBOARD_LOGIN_MAX_ATTEMPTS=) doesn't coerce to 0 and lock
// every user out instantly. Also clamp to sensible minimums.
function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}
export const LOGIN_WINDOW_MS = envInt("DASHBOARD_LOGIN_WINDOW_MS", 15 * 60_000, 1_000);
export const LOGIN_LOCK_MS   = envInt("DASHBOARD_LOGIN_LOCK_MS",   15 * 60_000, 1_000);
export const LOGIN_MAX_ATTEMPTS = envInt("DASHBOARD_LOGIN_MAX_ATTEMPTS", 8, 1);

// ── Stores ─────────────────────────────────────────────────────────────────
//
// Live sessions sit in memory, keyed by the raw sid (the cookie value). Since
// 2026-10-11 they are also mirrored to SQLite when index.ts attaches a store
// (src/dashboard/sessionPersistence.ts), so a restart no longer logs anyone
// out: stored sessions load as DORMANT (only their sha256 is known) and the
// first request carrying the cookie promotes them back (getSessionBySid).
// With no store attached (tests, scripts) everything stays in memory, exactly
// as before.

let sessionStore: SessionStore | null = null;
/** Stored sessions not seen since this process started: sha256(sid) → session. */
const dormant = new Map<string, StoredSession>();

function persist(op: (store: SessionStore) => void, what: string): void {
  if (!sessionStore) return;
  try {
    op(sessionStore);
  } catch (e: any) {
    log.warn(`Dashboard: session ${what} not persisted (${e?.message ?? e}) — it stays valid in memory until a restart`);
  }
}

const ttlOf = (s: { rememberMe: boolean }) => (s.rememberMe ? REMEMBER_ME_TTL : SESSION_TTL);

/** set/delete write through to the attached store; clear() only forgets
 *  memory (tests use it to simulate a restart). */
class SessionMap extends Map<string, Session> {
  override set(sid: string, s: Session): this {
    super.set(sid, s);
    persist((st) => st.upsert(sid, s), "save");
    return this;
  }
  override delete(sid: string): boolean {
    const had = super.delete(sid);
    persist((st) => st.remove(sid), "delete");
    return had;
  }
}

export const sessions      = new SessionMap();
export const loginAttempts = new Map<string, LoginAttemptState>();

/**
 * Wires persistence (index.ts, at boot): stored sessions load as dormant,
 * expired rows are deleted, and any session already live is saved.
 */
export function attachSessionPersistence(store: SessionStore): { restored: number; expired: number } {
  sessionStore = store;
  dormant.clear();
  const live = new Set([...sessions.keys()].map(hashSid));
  const now = Date.now();
  let restored = 0;
  let expired = 0;
  for (const d of store.loadAll()) {
    if (live.has(d.sidHash)) continue;
    if (now - d.lastActivity > ttlOf(d)) {
      persist((st) => st.removeByHash(d.sidHash), "prune");
      expired++;
      continue;
    }
    dormant.set(d.sidHash, d);
    restored++;
  }
  for (const [sid, s] of sessions) persist((st) => st.upsert(sid, s), "save");
  return { restored, expired };
}

/** Tests: drop the store and the dormant sessions (live ones stay in memory). */
export function detachSessionPersistence(): void {
  sessionStore = null;
  dormant.clear();
}

/** Opaque per-session handle: NEVER the raw sid (a sid is a bearer token).
 *  The first 16 hex chars of sha256(sid), so a dormant session (only its hash
 *  is known) shows the same handle it will have once live. */
export function sessionHandle(sid: string): string {
  return hashSid(sid).slice(0, 16);
}

export interface UserSessionView {
  handle: string;
  /** Raw sid when live in this process; null for a restored session whose
   *  browser hasn't come back since the restart. */
  sid: string | null;
  session: Omit<Session, "id">;
}

/** One user's sessions, live and dormant (Ajustes → Sessions). */
export function sessionsOfUser(username: string): UserSessionView[] {
  const out: UserSessionView[] = [];
  for (const [sid, s] of sessions) if (s.username === username) out.push({ handle: sessionHandle(sid), sid, session: s });
  for (const [h, d] of dormant) if (d.username === username) out.push({ handle: h.slice(0, 16), sid: null, session: d });
  return out;
}

/** Revokes one of `username`'s sessions by handle; null when it isn't theirs or doesn't exist. */
export function revokeSessionByHandle(username: string, handle: string): { sid: string | null } | null {
  for (const [sid, s] of sessions) {
    if (s.username === username && sessionHandle(sid) === handle) {
      sessions.delete(sid);
      return { sid };
    }
  }
  for (const [h, d] of dormant) {
    if (d.username === username && h.slice(0, 16) === handle) {
      dormant.delete(h);
      persist((st) => st.removeByHash(h), "delete");
      return { sid: null };
    }
  }
  return null;
}

/** Revokes every session of `username` except `keepSid`; returns how many. */
export function revokeOtherSessions(username: string, keepSid: string): number {
  let n = 0;
  for (const [sid, s] of sessions) {
    if (s.username === username && sid !== keepSid) { sessions.delete(sid); n++; }
  }
  for (const [h, d] of dormant) {
    if (d.username === username) { dormant.delete(h); persist((st) => st.removeByHash(h), "delete"); n++; }
  }
  return n;
}

/**
 * Loads dashboard users from env. Backward compatible: the admin is still
 * DASHBOARD_ADMIN_USER / DASHBOARD_ADMIN_PASSWORD_HASH (+ optional
 * DASHBOARD_ADMIN_DISPLAY_NAME). Audit F3: an optional READ-ONLY second user
 * (role "viewer") can be added via DASHBOARD_VIEWER_USER /
 * DASHBOARD_VIEWER_PASSWORD_HASH so routine monitoring no longer requires the
 * single admin credential. Viewers authenticate identically but cannot pass
 * `requireAdmin` routes or the WS `switch_view` (both check role === "admin").
 * Exported for tests; USERS caches the result for the login route.
 */
export function loadUsersFromEnv(): User[] {
  const users: User[] = [];
  const add = (role: User["role"], userKey: string, hashKey: string, nameKey: string, defaultName: string) => {
    const username     = (process.env[userKey] ?? "").trim().toLowerCase();
    const passwordHash = (process.env[hashKey] ?? "").trim();
    const displayName  = (process.env[nameKey] ?? "").trim() || defaultName;
    if (!username || !passwordHash) return;
    if (users.some(u => u.username === username)) {
      log.warn(`Dashboard: ignoring duplicate username "${username}" (${role}); usernames must be unique`);
      return;
    }
    users.push({ username, passwordHash, role, displayName });
  };

  add("admin",  "DASHBOARD_ADMIN_USER",  "DASHBOARD_ADMIN_PASSWORD_HASH",  "DASHBOARD_ADMIN_DISPLAY_NAME",  "Admin");
  add("viewer", "DASHBOARD_VIEWER_USER", "DASHBOARD_VIEWER_PASSWORD_HASH", "DASHBOARD_VIEWER_DISPLAY_NAME", "Viewer");
  return users;
}

/**
 * Platform phase (2026-10-04): env users PLUS the instance.json owner
 * written by `bun run setup` / the first-run web setup page
 * (src/platform/instance.ts). The owner is an admin. On a username
 * collision the env user wins (env > instance.json, the platform-wide
 * precedence). With no instance.json this is exactly loadUsersFromEnv —
 * the pre-platform behavior (auth-store.test.ts locks it).
 */
export function loadUsers(): User[] {
  const users = loadUsersFromEnv();
  const owner = loadInstanceConfig().owner;
  if (owner) {
    if (users.some(u => u.username === owner.username)) {
      log.warn(`Dashboard: instance.json owner "${owner.username}" collides with an env-configured user; the env user wins`);
    } else {
      users.push({ username: owner.username, passwordHash: owner.passwordHash, role: "admin", displayName: owner.displayName });
    }
  }
  if (users.length === 0) {
    log.warn("Dashboard login not configured yet — run `bun run setup` (or set DASHBOARD_ADMIN_USER/DASHBOARD_ADMIN_PASSWORD_HASH); the dashboard will serve the first-run setup page");
  } else if (!users.some(u => u.role === "admin")) {
    log.warn("Dashboard: no admin user configured (viewer only); admin-only controls will be unavailable");
  }
  return users;
}

export const USERS: User[] = loadUsers();

/** Re-resolve USERS in place (same array reference — every importer sees the
 *  update). Called after the first-run setup page writes instance.json. */
export function reloadUsers(): void {
  const fresh = loadUsers();
  USERS.length = 0;
  USERS.push(...fresh);
}

// ── Login attempt helpers ──────────────────────────────────────────────────

export function getLoginKey(req: express.Request, username: string): string {
  return `${username.toLowerCase().trim()}|${getClientIp(req)}`;
}

export function getLoginAttempt(key: string): LoginAttemptState {
  const current = loginAttempts.get(key);
  const now = Date.now();
  if (!current) {
    const s: LoginAttemptState = { count: 0, firstAttemptAt: now, lockUntil: 0 };
    loginAttempts.set(key, s);
    return s;
  }
  if (now - current.firstAttemptAt > LOGIN_WINDOW_MS && now >= current.lockUntil) {
    const reset: LoginAttemptState = { count: 0, firstAttemptAt: now, lockUntil: 0 };
    loginAttempts.set(key, reset);
    return reset;
  }
  return current;
}

export function registerLoginFailure(key: string): LoginAttemptState {
  const state = getLoginAttempt(key);
  state.count += 1;
  if (state.count >= LOGIN_MAX_ATTEMPTS) {
    state.lockUntil = Date.now() + LOGIN_LOCK_MS;
  }
  loginAttempts.set(key, state);
  return state;
}

export function clearLoginAttempt(key: string): void {
  loginAttempts.delete(key);
}

// ── Session helpers ────────────────────────────────────────────────────────

export function getSession(req: express.Request): Session | null {
  const sid = (req as any).cookies?.sid ?? (req.headers["x-session-id"] as string);
  return getSessionBySid(sid);
}

/**
 * Iter 8 (2026-05-04): expose session lookup by raw sid string so non-Express
 * surfaces (notably the WebSocket upgrade handler) can authenticate using the
 * same cookie store, instead of leaving the WS endpoint unauthenticated.
 */
export function getSessionBySid(sid: string | undefined | null): Session | null {
  if (!sid) return null;
  const s = sessions.get(sid) ?? promoteDormant(sid);
  if (!s) return null;
  const ttl = s.rememberMe ? REMEMBER_ME_TTL : SESSION_TTL;
  if (Date.now() - s.lastActivity > ttl) { sessions.delete(sid); return null; }
  s.lastActivity = Date.now();
  persist((st) => st.touch(sid, s), "activity");
  return s;
}

/** A restored session whose cookie just came back becomes live again (its
 *  row already exists — no write). */
function promoteDormant(sid: string): Session | null {
  if (dormant.size === 0) return null;
  const h = hashSid(sid);
  const d = dormant.get(h);
  if (!d) return null;
  dormant.delete(h);
  const { sidHash: _sidHash, ...rest } = d;
  const s: Session = { ...rest, id: sid };
  Map.prototype.set.call(sessions, sid, s);
  return s;
}

export function getOrCreateSession(_req: express.Request, _res: express.Response): Session {
  const existing = getSession(_req);
  if (existing) return existing;
  // Ephemeral placeholder (never persisted; auth wall prevents reaching authenticated routes without a real session)
  return {
    id: "", username: "", role: "viewer", displayName: "",
    createdAt: 0, lastActivity: 0, csrfToken: "",
    rememberMe: false,
    settings: { viewId: "consolidated" },
  };
}

// ── requireAdmin middleware ────────────────────────────────────────────────

export const requireAdmin = (req: any, res: any, next: any) => {
  const s: Session | null = req.session ?? getSession(req);
  if (!s || s.role !== "admin") return res.status(403).json({ error: "Admin role required" });
  next();
};

// ── Periodic cleanup ──────────────────────────────────────────────────────

/**
 * P3-3 fix: the janitor used to sweep every session against the fixed
 * SESSION_TTL (7d), ignoring `rememberMe` — a live lookup (getSessionBySid,
 * above) honors REMEMBER_ME_TTL (30d), but this hourly sweep would delete
 * a "remember me" session out from under an active user between day 7 and
 * day 30. Exported so tests can invoke it directly instead of waiting an
 * hour for the interval to fire.
 */
export function sweepStaleSessions(): void {
  const now = Date.now();
  for (const [k, s] of sessions) {
    const ttl = s.rememberMe ? REMEMBER_ME_TTL : SESSION_TTL;
    if (now - s.lastActivity > ttl) sessions.delete(k);
  }
  for (const [h, d] of dormant) {
    if (now - d.lastActivity > ttlOf(d)) { dormant.delete(h); persist((st) => st.removeByHash(h), "prune"); }
  }
  for (const [k, attempt] of loginAttempts) {
    const stale   = now - attempt.firstAttemptAt > LOGIN_WINDOW_MS * 2;
    const unlocked = attempt.lockUntil === 0 || now > attempt.lockUntil + LOGIN_WINDOW_MS;
    if (stale && unlocked) loginAttempts.delete(k);
  }
}

setInterval(sweepStaleSessions, 60 * 60_000);
