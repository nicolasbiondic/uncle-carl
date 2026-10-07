// ═══ platform_meta — tiny installation-scoped key/value store ═══
//
// Owns its table with CREATE TABLE IF NOT EXISTS on first use (the same
// self-contained pattern as platform/accounts/repository.ts — database.ts is
// NOT touched). First use: the installation's stable instance id, minted
// once and persisted, from which per-user account ids are derived for the
// dashboard's Ajustes page (GET /api/platform/me).

import { createHash } from "crypto";
import type { Database } from "bun:sqlite";
import { getDB } from "../db/database";

const ensured = new WeakSet<Database>();

function db(): Database {
  const d = getDB();
  if (!ensured.has(d)) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS platform_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    ensured.add(d);
  }
  return d;
}

export function getPlatformMeta(key: string): string | null {
  const row = db().prepare(`SELECT value FROM platform_meta WHERE key = ?`).get(key) as { value: string } | null;
  return row ? row.value : null;
}

export function setPlatformMeta(key: string, value: string): void {
  db().prepare(`INSERT INTO platform_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** The installation's stable id: a UUID minted ONCE and persisted under
 *  'instance_id'. Every later call (and every restart) returns the same. */
export function getInstanceId(): string {
  const existing = getPlatformMeta("instance_id");
  if (existing) return existing;
  const id = crypto.randomUUID(); // Web Crypto (Bun global)
  setPlatformMeta("instance_id", id);
  return id;
}

/** Stable, non-reversible user-facing account id:
 *  "acct_" + first 12 hex chars of sha256(instanceId + ":" + username). */
export function accountIdFor(instanceId: string, username: string): string {
  const h = createHash("sha256").update(`${instanceId}:${username}`).digest("hex");
  return `acct_${h.slice(0, 12)}`;
}
