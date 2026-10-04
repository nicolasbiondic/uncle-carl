// ═══ Auth + Session store (module-level singletons) ═══

import type express from "express";
import { createLogger } from "../utils/logger";
import { getClientIp } from "./dashboard-utils";
import { loadInstanceConfig } from "../platform/instance";

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

// ── Stores (in-memory; replaced by DB-backed users in a future phase) ──────

export const sessions      = new Map<string, Session>();
export const loginAttempts = new Map<string, LoginAttemptState>();

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
  const s = sessions.get(sid);
  if (!s) return null;
  const ttl = s.rememberMe ? REMEMBER_ME_TTL : SESSION_TTL;
  if (Date.now() - s.lastActivity > ttl) { sessions.delete(sid); return null; }
  s.lastActivity = Date.now();
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
  for (const [k, attempt] of loginAttempts) {
    const stale   = now - attempt.firstAttemptAt > LOGIN_WINDOW_MS * 2;
    const unlocked = attempt.lockUntil === 0 || now > attempt.lockUntil + LOGIN_WINDOW_MS;
    if (stale && unlocked) loginAttempts.delete(k);
  }
}

setInterval(sweepStaleSessions, 60 * 60_000);
