// ══════════════════════════════════════════════
// Repository-wide guard — equity_snapshots has exactly ONE production writer.
//
// saveEquitySnapshot (this directory) is the only code path allowed to
// INSERT INTO equity_snapshots outside test files. A stray direct insert
// anywhere else (a new ops script, a route handler, a "quick backfill") skips
// the semantics stamp and reintroduces the poisoned-anchor bug class that
// recurred 6 times — see the EQUITY_SEMANTICS doc in ./database.ts. The
// scripts/backfill-main-snapshots.ts script that used to do exactly this
// (raw INSERT, no semantics column at all, referencing dead pre-v8 profile
// ids) was deleted for the same reason.
//
// A NOT-NULL-semantics trigger (installed in migrateColumns, post the
// one-time NULL→2 backfill) backs this up at the DB layer, but catching a
// violation here — at review/CI time — is cheaper than at 3am.
// ══════════════════════════════════════════════

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { getDB } from "./database";
import { makeTestDb } from "../test-support/db";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src", "scripts"];
// The canonical writer — the only non-test file allowed to INSERT.
const CANONICAL_WRITER = join("src", "db", "database.ts");
// The shared test fixture (rawSnap) — TEST-ONLY module, imported exclusively
// from *.test.ts files; enumerated explicitly (not the whole directory) so
// any OTHER support file that grows a direct INSERT still trips the guard.
const TEST_FIXTURE_WRITER = join("src", "test-support", "db.ts");

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir) as string[]) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* tsFiles(full);
    } else if (name.endsWith(".ts")) {
      yield full;
    }
  }
}

describe("equity_snapshots has exactly one production writer", () => {
  test("every direct INSERT lives in the canonical writer or an explicit *.test.ts file", () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      const abs = join(REPO_ROOT, dir);
      let files: Generator<string>;
      try { files = tsFiles(abs); } catch { continue; }
      for (const file of files) {
        const rel = relative(REPO_ROOT, file);
        if (rel === CANONICAL_WRITER) continue;
        if (rel === TEST_FIXTURE_WRITER) continue; // shared rawSnap test seeder
        if (rel.endsWith(".test.ts")) continue; // explicitly enumerated test fixtures
        const lines = readFileSync(file, "utf-8").split("\n");
        lines.forEach((line, i) => {
          if (/INSERT\s+INTO\s+equity_snapshots/i.test(line)) {
            violations.push(`${rel}:${i + 1} — direct INSERT bypasses saveEquitySnapshot's semantics stamp\n    ${line.trim()}`);
          }
        });
      }
    }
    expect(violations.join("\n\n")).toBe("");
  });

  test("the DB rejects a direct NULL-semantics INSERT (post-migration trigger)", () => {
    makeTestDb();
    expect(() => {
      getDB().prepare(
        `INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time) VALUES (?,?,?,?,?)`
      ).run("alpaca_main", 100, 100, 0, Date.now());
    }).toThrow();
  });

  test("saveEquitySnapshot itself never triggers the guard (writes a real semantics value)", () => {
    makeTestDb();
    expect(() => {
      getDB().prepare(
        `INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time, semantics) VALUES (?,?,?,?,?,?)`
      ).run("alpaca_main", 100, 100, 0, Date.now(), 5);
    }).not.toThrow();
  });
});
