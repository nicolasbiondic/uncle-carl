// ══════════════════════════════════════════════
// Money-number write-path narrowing (v8) — the "6× portfolio sums wrong" locks.
//
// Two structural guarantees this refactor introduced:
//   (B1) The deprecated accounts.equity/cash columns are NOT written on the
//        60s hot path — EquityTracker.syncBrokerTruth / syncLedger update
//        in-memory state only (truth = equity_snapshots via portfolio/truth.ts).
//   (B2) equity_snapshots has ONE writer: AccountManager.writeAllSnapshots
//        (driven by the 5-min loop + startup). The 60s broker syncs cache
//        broker truth on the instance but persist nothing.
// ══════════════════════════════════════════════

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { loadAccount } from "../db/database";
import { EquityTracker } from "./EquityTracker";
import { makeTestDb } from "../test-support/db";

describe("B1 — the deprecated ledger columns are frozen on the hot path", () => {
  test("syncBrokerTruth / syncLedger update memory only, never re-persist equity/cash", () => {
    makeTestDb();
    // Constructor seeds the row ONCE (initial allocation); that write is kept.
    const t = new EquityTracker("momentum_crypto");
    const seeded = loadAccount("momentum_crypto")!;

    // Both live sync entry points, with values far from the seed.
    t.syncBrokerTruth(seeded.equity + 12_345, seeded.cash + 6_789);
    t.syncLedger(seeded.equity + 999, seeded.cash + 111);

    const after = loadAccount("momentum_crypto")!;
    // Persisted ledger columns are UNTOUCHED by the hot path…
    expect(after.equity).toBe(seeded.equity);
    expect(after.cash).toBe(seeded.cash);
    // …while the in-memory value (what the dashboard cards read) tracks live.
    expect(t.equity).toBe(seeded.equity + 999);
    expect(t.cash).toBe(seeded.cash + 111);
  });

  test("syncBrokerTruth accepts a finite zero/negative reading, throws on NaN", () => {
    makeTestDb();
    const t = new EquityTracker("momentum_crypto");

    t.syncBrokerTruth(0, 0);
    expect(t.equity).toBe(0);
    expect(t.cash).toBe(0);

    t.syncBrokerTruth(-50, -10);
    expect(t.equity).toBe(-50);
    expect(t.cash).toBe(-10);

    expect(() => t.syncBrokerTruth(NaN, 100)).toThrow();
    expect(() => t.syncBrokerTruth(100, NaN)).toThrow();
  });
});

// ── grep-style source assertion (spec-sanctioned) for the writer boundary ──
// Extract a method body by brace-matching from its definition signature. The
// broker syncs' bodies must contain no snapshot write; writeAllSnapshots must.
function methodBody(src: string, sig: string): string {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error(`signature not found: ${sig}`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces for ${sig}`);
}

describe("B2 — equity_snapshots has a single writer", () => {
  const src = readFileSync(join(import.meta.dir, "AccountManager.ts"), "utf-8");

  test("the 60s broker syncs persist NO equity_snapshots (in-memory only)", () => {
    expect(methodBody(src, "private async syncAlpacaAccount()")).not.toContain("saveEquitySnapshot");
    expect(methodBody(src, "private async syncBinanceFutures()")).not.toContain("saveEquitySnapshot");
  });

  test("writeAllSnapshots is the sole writer and covers sleeves + both broker-truth rows", () => {
    const body = methodBody(src, "private writeAllSnapshots()");
    expect(body).toContain("saveEquitySnapshot");
    expect(body).toContain('"alpaca_main"');
    expect(body).toContain('"binance_main"');
  });
});
