// safeAddColumn strictness (OPEN.md P3-6, 2026-08-29): "safe" means
// idempotent — re-running a migration whose column already landed is fine —
// NOT infallible. The old catch-all swallowed every error (missing table,
// locked/corrupt DB), letting the bot boot on a half-migrated schema and die
// later at an arbitrary query. Now only "duplicate column" is swallowed;
// anything else rethrows and aborts boot.

import { beforeAll, describe, expect, test } from "bun:test";
import { getDB, safeAddColumn } from "./database";
import { makeTestDb } from "../test-support/db";

beforeAll(() => { makeTestDb(); });

describe("safeAddColumn", () => {
  test("adds a genuinely new column", () => {
    safeAddColumn("trades", "safe_add_column_test", "REAL", "0");
    const cols = getDB().prepare(`PRAGMA table_info(trades)`).all() as any[];
    expect(cols.some(c => c.name === "safe_add_column_test")).toBe(true);
  });

  test("duplicate column (idempotent re-run) is swallowed — the one expected error", () => {
    // account_id already exists on trades (migrateColumns ran in makeTestDb).
    expect(() => safeAddColumn("trades", "account_id", "TEXT NOT NULL", "'unassigned'")).not.toThrow();
  });

  test("any OTHER error rethrows (aborts boot): missing table is not a duplicate column", () => {
    expect(() => safeAddColumn("no_such_table_p3_6", "c", "TEXT", "'x'")).toThrow();
  });
});
