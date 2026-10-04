// ══════════════════════════════════════════════
// Regression guard — the "no sixth recurrence" lock.
//
// The `accounts` table's equity/cash columns are DEPRECATED since v8: nothing
// keeps them fresh, so any reader serves frozen numbers (the Jul 12 digest
// printed a stale $111,580 total from them). Truth lives in equity_snapshots,
// consumed via src/portfolio/truth.ts.
//
// This test SCANS the source tree and fails CI if anyone reintroduces a read
// of the accounts table outside the layers that own it:
//   src/db/        — loadAccount/saveAccount (EquityTracker's own ledger
//                    persistence write-read pair) + schema/migrations
//   src/sync/      — BrokerSync's upsert write path
//   src/portfolio/ — the truth module itself (reads snapshots, not accounts,
//                    but excluded so this file's own patterns don't self-match)
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC_ROOT = join(import.meta.dir, "..");
const EXCLUDED_TOP_DIRS = new Set(["portfolio", "db", "sync"]);

const BANNED: { re: RegExp; why: string }[] = [
  { re: /(FROM|JOIN)\s+accounts\b/i, why: "reads the deprecated accounts table (use src/portfolio/truth.ts)" },
  { re: /\baccounts\s+WHERE\s+id\s+IN\s*\(\s*'(alpaca|binance)_main'/i, why: "reads stale *_main accounts rows" },
  { re: /UPDATE\s+accounts\s+SET\s+(equity|cash)\b/i, why: "writes accounts equity/cash outside db/sync layers" },
];

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir) as string[]) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (dir === SRC_ROOT && EXCLUDED_TOP_DIRS.has(name)) continue;
      yield* tsFiles(full);
    } else if (name.endsWith(".ts")) {
      yield full;
    }
  }
}

describe("stale accounts-table reads are structurally banned", () => {
  test("no file outside src/{portfolio,db,sync} touches accounts equity/cash", () => {
    const violations: string[] = [];
    for (const file of tsFiles(SRC_ROOT)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        for (const { re, why } of BANNED) {
          if (re.test(line)) violations.push(`${file}:${i + 1} — ${why}\n    ${line.trim()}`);
        }
      });
    }
    expect(violations.join("\n\n")).toBe("");
  });
});
