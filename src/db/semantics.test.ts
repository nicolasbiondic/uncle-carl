// ══════════════════════════════════════════════
// EQUITY_SEMANTICS filtering — the poisoned-anchor killer (§3).
//
// Contract under test: rows written under an OLD semantics era (or dodging
// saveEquitySnapshot entirely → semantics NULL) are INVISIBLE to every anchor
// and series read. A future attribution change only needs to bump the
// constant — old rows drop out of anchors with no manual purge.
// ══════════════════════════════════════════════

import { describe, expect, test, beforeAll } from "bun:test";
import {
  getDB, getETDayStart,
  getEquityAt,
  getDrawdownSeries, saveEquitySnapshot, EQUITY_SEMANTICS,
} from "./database";
import { makeTestDb, rawSnap as sharedRawSnap } from "../test-support/db";

// Canonical production ids: saveEquitySnapshot's per-series registry throws
// for anything not registered (see equitySemanticsRegistry.test.ts), so this
// fixture uses two REAL series (alpaca_main / binance_main) instead of the
// throwaway names it used before that guard existed.
const P = "alpaca_main";
const DD = "binance_main";

const rawSnap = (equity: number, time: number, semantics: number, profile = P) => sharedRawSnap(profile, equity, time, semantics);

beforeAll(() => {
  makeTestDb();
  const now = Date.now();
  const midnight = getETDayStart();

  // OLD-era rows: pre-attribution-fix whole-wallet values (the poison).
  rawSnap(100_000, now - 3 * 86_400_000, EQUITY_SEMANTICS - 1);
  rawSnap(100_500, midnight - 100, EQUITY_SEMANTICS - 1); // closest row to the ET-midnight anchor
  // A writer that dodged saveEquitySnapshot used to be able to land a NULL
  // semantics row here; the post-migration NOT-NULL trigger (see
  // equitySnapshotsWriterGuard.test.ts) now rejects that at the DB layer, so
  // this fixture uses an old-but-stamped era instead to keep testing "old
  // rows stay invisible to current-era anchors".
  rawSnap(99_000, now - 2 * 86_400_000, EQUITY_SEMANTICS - 2);
  rawSnap(999_999, now + 60_000, EQUITY_SEMANTICS - 1);   // old-era row that is newest by time

  // CURRENT-era rows via the ONE writer.
  saveEquitySnapshot(P, 50_000, 50_000, 0, midnight - 1000); // day anchor
  saveEquitySnapshot(P, 50_500, 50_500, 0, now);             // latest

  const base = getETDayStart(now - 5 * 86_400_000) + 18 * 3_600_000;
  rawSnap(10_000, base, EQUITY_SEMANTICS - 1, DD); // old-era all-assets peak: must not anchor drawdown
  saveEquitySnapshot(DD, 5_000, 5_000, 0, base + 86_400_000);
  saveEquitySnapshot(DD, 5_100, 5_100, 0, base + 2 * 86_400_000);
  saveEquitySnapshot(DD, 5_050, 5_050, 0, base + 3 * 86_400_000);
});

describe("anchors ignore old-semantics rows", () => {
  test("current era is 5 (Binance total-assets, 2026-07-18)", () => {
    // Guards against forgetting to bump EQUITY_SEMANTICS on the next
    // attribution-meaning change — see the era doc in database.ts.
    expect(EQUITY_SEMANTICS).toBe(5);
  });

  test("writer stamps the current constant", () => {
    const row = getDB().prepare(
      `SELECT semantics FROM equity_snapshots WHERE profile_id = ? AND equity = ?`
    ).get(P, 50_500) as any;
    expect(row.semantics).toBe(EQUITY_SEMANTICS);
  });

  test("first-snapshot anchor = first CURRENT-era row, not the $100k poison", () => {
    expect(getEquityAt(P, 0)).toBe(50_000);
  });

  test("latest read skips a time-newer old-era row", () => {
    expect(getEquityAt(P, Date.now() + 120_000)).toBe(50_500);
  });

  test("drawdown series ignores old-era peaks", () => {
    const expectedDd = ((5_100 - 5_050) / 5_100) * 100;
    expect(getDrawdownSeries(DD, 90).at(-1)!.dd).toBeCloseTo(-expectedDd, 4);
  });
});
