// ═══ platform_broker_accounts repository ═══
//
// Owns its table with CREATE TABLE IF NOT EXISTS on first use — the same
// self-contained pattern as SleeveGovernor's sleeve_modes (database.ts is NOT
// touched; this branch must stay additive).
//
// NOTE the table is named platform_broker_accounts, not the spec's
// broker_accounts: database.ts already defines a LEGACY `broker_accounts`
// table (profile_id/broker_id/api_key_ref, seeded and read by
// getBrokerAccounts() for the v2 dashboard cards). Reusing that name would
// make this module's CREATE TABLE IF NOT EXISTS a silent no-op on every
// existing installation and every INSERT here would then violate the legacy
// schema. A distinct name keeps both worlds intact.

import type { Database } from "bun:sqlite";
import { getDB } from "../../db/database";
import type {
  BrokerAccountRecord, BrokerAccountStatus, BrokerAuthType,
  BrokerEnvironment, BrokerProvider,
} from "./types";

interface Row {
  id: string;
  provider: string;
  label: string;
  environment: string;
  auth_type: string;
  credentials_enc: string;
  status: string;
  account_ref: string | null;
  last_verified_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

// Per-Database-handle ensure guard: tests re-init the module-global handle
// via makeTestDb(), so "did I create the table" must be tracked per handle,
// not per process.
const ensured = new WeakSet<Database>();

function db(): Database {
  const d = getDB();
  if (!ensured.has(d)) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS platform_broker_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('alpaca','binance_usdm')),
        label TEXT NOT NULL,
        environment TEXT NOT NULL CHECK(environment IN ('paper','live','demo')),
        auth_type TEXT NOT NULL CHECK(auth_type IN ('api_key','oauth')),
        credentials_enc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unverified',
        account_ref TEXT,
        last_verified_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    ensured.add(d);
  }
  return d;
}

function toRecord(r: Row): BrokerAccountRecord {
  return {
    id: r.id,
    provider: r.provider as BrokerProvider,
    label: r.label,
    environment: r.environment as BrokerEnvironment,
    authType: r.auth_type as BrokerAuthType,
    status: r.status as BrokerAccountStatus,
    accountRef: r.account_ref,
    lastVerifiedAt: r.last_verified_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class BrokerAccountsRepository {
  list(): BrokerAccountRecord[] {
    const rows = db().prepare(
      `SELECT * FROM platform_broker_accounts ORDER BY created_at ASC, id ASC`
    ).all() as Row[];
    return rows.map(toRecord);
  }

  get(id: string): BrokerAccountRecord | null {
    const row = db().prepare(
      `SELECT * FROM platform_broker_accounts WHERE id = ?`
    ).get(id) as Row | null;
    return row ? toRecord(row) : null;
  }

  /** The sealed blob — only the service (which holds the SecretBox) reads it. */
  getCredentialsEnc(id: string): string | null {
    const row = db().prepare(
      `SELECT credentials_enc FROM platform_broker_accounts WHERE id = ?`
    ).get(id) as { credentials_enc: string } | null;
    return row ? row.credentials_enc : null;
  }

  has(id: string): boolean {
    return !!db().prepare(`SELECT 1 FROM platform_broker_accounts WHERE id = ?`).get(id);
  }

  insert(rec: {
    id: string;
    provider: BrokerProvider;
    label: string;
    environment: BrokerEnvironment;
    authType: BrokerAuthType;
    credentialsEnc: string;
    status: BrokerAccountStatus;
    accountRef: string | null;
    lastVerifiedAt: number | null;
    createdAt: number;
  }): void {
    db().prepare(`
      INSERT INTO platform_broker_accounts
        (id, provider, label, environment, auth_type, credentials_enc,
         status, account_ref, last_verified_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      rec.id, rec.provider, rec.label, rec.environment, rec.authType,
      rec.credentialsEnc, rec.status, rec.accountRef, rec.lastVerifiedAt,
      rec.createdAt, rec.createdAt,
    );
  }

  updateVerification(id: string, v: {
    status: BrokerAccountStatus;
    accountRef?: string | null;
    lastVerifiedAt?: number | null;
    lastError: string | null;
    updatedAt: number;
  }): void {
    db().prepare(`
      UPDATE platform_broker_accounts
      SET status = ?,
          account_ref = COALESCE(?, account_ref),
          last_verified_at = COALESCE(?, last_verified_at),
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(v.status, v.accountRef ?? null, v.lastVerifiedAt ?? null, v.lastError, v.updatedAt, id);
  }

  remove(id: string): boolean {
    const res = db().prepare(`DELETE FROM platform_broker_accounts WHERE id = ?`).run(id);
    return (res as any).changes > 0;
  }
}
