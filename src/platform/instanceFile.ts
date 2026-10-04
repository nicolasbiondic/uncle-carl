// ═══ instance.json / master.key writers — shared by `bun run setup`
//     (scripts/setup.ts) and the first-run web setup page ═══
//
// All functions here are pure(ish) filesystem helpers tested against a temp
// directory (src/platform/instanceFile.test.ts). They are deliberately
// MERGE-based and idempotent: re-running setup only changes the fields the
// caller provides, never clobbers the rest, and NEVER overwrites an
// existing master.key.

import crypto from "crypto";
import fs from "fs";
import { instanceFilePath, normalizePublicUrl } from "./instance";
import { masterKeyPath } from "./secretBox";

// ── Partial updates (every field optional — merge semantics) ───────────────

export interface InstanceUpdate {
  dashboard?: { host?: string; port?: number; publicUrl?: string | null };
  owner?: { username: string; passwordHash: string; displayName?: string };
  oauth?: {
    github?: { clientId: string; clientSecret: string; allowedId: number; allowedLogin?: string } | null;
    google?: { clientId: string; clientSecret: string; allowedEmail: string } | null;
  };
}

/** Read existing instance.json (or {}), tolerant of a missing file. A
 *  corrupt file throws here (unlike the runtime loader): setup must not
 *  silently discard a file the owner hand-edited badly. */
export function readInstanceJson(dataDir: string): any {
  const p = instanceFilePath(dataDir);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Deep-merge an update into the existing instance.json object.
 *  `null` for an oauth provider REMOVES it; `publicUrl: null` clears it. */
export function mergeInstanceUpdate(existing: any, update: InstanceUpdate): any {
  const out = { ...existing };

  if (update.dashboard) {
    const d = { ...(existing.dashboard ?? {}) };
    if (update.dashboard.host !== undefined) d.host = update.dashboard.host;
    if (update.dashboard.port !== undefined) d.port = update.dashboard.port;
    if (update.dashboard.publicUrl !== undefined) {
      if (update.dashboard.publicUrl === null) delete d.publicUrl;
      else d.publicUrl = update.dashboard.publicUrl;
    }
    out.dashboard = d;
  }

  if (update.owner) {
    out.owner = {
      username: update.owner.username.trim().toLowerCase(),
      passwordHash: update.owner.passwordHash,
      displayName: update.owner.displayName?.trim() || update.owner.username.trim(),
    };
  }

  if (update.oauth) {
    const o = { ...(existing.oauth ?? {}) };
    if (update.oauth.github !== undefined) {
      if (update.oauth.github === null) delete o.github;
      else o.github = update.oauth.github;
    }
    if (update.oauth.google !== undefined) {
      if (update.oauth.google === null) delete o.google;
      else o.google = update.oauth.google;
    }
    out.oauth = o;
  }

  return out;
}

/** Write instance.json atomically (tmp + rename) with mode 0600. */
export function writeInstanceJson(dataDir: string, obj: any): string {
  fs.mkdirSync(dataDir, { recursive: true } as any); // repo-wide idiom: stale fs typings lack the options overload
  const p = instanceFilePath(dataDir);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
  fs.chmodSync(p, 0o600); // rename preserves the tmp mode, but make it explicit
  return p;
}

/** Create <dataDir>/master.key (32 random bytes, base64, mode 0600) if and
 *  only if it does not exist. NEVER overwrites — losing this key loses every
 *  sealed secret. */
export function ensureMasterKey(dataDir: string): { path: string; created: boolean } {
  fs.mkdirSync(dataDir, { recursive: true } as any); // repo-wide idiom: stale fs typings lack the options overload
  const p = masterKeyPath(dataDir);
  if (fs.existsSync(p)) return { path: p, created: false };
  const key = crypto.randomBytes(32).toString("base64");
  fs.writeFileSync(p, key + "\n", { mode: 0o600, flag: "wx" }); // wx: fail instead of clobber on a race
  return { path: p, created: true };
}

// ── Owner input validation (shared CLI + web) ──────────────────────────────

export function validateOwnerUsername(username: string): string | null {
  const u = username.trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(u)) {
    return "Username must be 3-32 characters: letters, digits, dot, dash, underscore";
  }
  return null;
}

export function validateOwnerPassword(password: string): string | null {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters";
  }
  if (password.length > 256) return "Password too long (max 256 characters)";
  return null;
}

/** Argon2id hash — the same verifier (Bun.password.verify) the login route
 *  already uses accepts argon2id and bcrypt transparently. */
export async function hashOwnerPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, { algorithm: "argon2id" });
}

// ── Display helpers ────────────────────────────────────────────────────────

/** Dashboard base URL to print/show: PUBLIC_URL when set, else localhost. */
export function dashboardBaseUrl(publicUrl: string | null, port: number): string {
  return normalizePublicUrl(publicUrl) ?? `http://localhost:${port}`;
}

/** The exact callback URLs to register in the GitHub / Google OAuth apps. */
export function oauthCallbackUrls(publicUrl: string | null, port: number): { github: string; google: string } {
  const base = dashboardBaseUrl(publicUrl, port);
  return {
    github: `${base}/auth/oauth/github/callback`,
    google: `${base}/auth/oauth/google/callback`,
  };
}
