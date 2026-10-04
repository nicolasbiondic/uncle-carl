// ══════════════════════════════════════════════
// Per-series semantics registry (§1) — currentSemantics/SEMANTICS_REGISTRY
// replace the old "one global EQUITY_SEMANTICS number for every profile"
// assumption. Every registered series happens to share the same version
// today (no migration needed), but the write path enforces registration
// explicitly so a 6th production series can't silently inherit whatever
// number is current.
// ══════════════════════════════════════════════

import { describe, expect, test, beforeAll } from "bun:test";
import {
  getDB, currentSemantics, EQUITY_SEMANTICS, saveEquitySnapshot,
  registerEquitySemanticsTransition,
} from "./database";
import { makeTestDb, rawSnap } from "../test-support/db";

const CANONICAL_SERIES = ["alpaca_main", "binance_main", "momentum_stocks", "momentum_crypto", "meanrev_stocks"];

beforeAll(() => { makeTestDb(); });

describe("currentSemantics — per-series registry", () => {
  test("every canonical production series is registered and equals the flat EQUITY_SEMANTICS constant today", () => {
    for (const id of CANONICAL_SERIES) expect(currentSemantics(id)).toBe(EQUITY_SEMANTICS);
  });

  test("throws for an unregistered series", () => {
    expect(() => currentSemantics("some_new_sleeve_nobody_registered")).toThrow();
  });
});

describe("saveEquitySnapshot — write path enforces the registry", () => {
  test("stamps the registered version for a canonical series", () => {
    saveEquitySnapshot("momentum_stocks", 12_345, 10_000, 1, Date.now());
    const row = getDB().prepare(
      `SELECT semantics FROM equity_snapshots WHERE profile_id='momentum_stocks' AND equity=12345`
    ).get() as { semantics: number };
    expect(row.semantics).toBe(currentSemantics("momentum_stocks"));
  });

  test("throws for an unregistered production series instead of writing an unaudited row", () => {
    expect(() => saveEquitySnapshot("some_new_sleeve_nobody_registered", 100, 100, 0, Date.now())).toThrow();
    const row = getDB().prepare(
      `SELECT COUNT(*) n FROM equity_snapshots WHERE profile_id='some_new_sleeve_nobody_registered'`
    ).get() as { n: number };
    expect(row.n).toBe(0); // the throw happens before any row lands
  });
});

describe("saveEquitySnapshot — atomic first-write transition recording (§3)", () => {
  test("undeclared transition throws loudly and writes nothing", () => {
    // meanrev_stocks's prior row sits at a bogus, never-declared semantics —
    // no (meanrev_stocks, 99, 5) row exists in equity_semantics_transitions.
    rawSnap("meanrev_stocks", 1_000, Date.now() - 60_000, 99);
    expect(() => saveEquitySnapshot("meanrev_stocks", 1_100, 1_000, 0, Date.now())).toThrow(/undeclared equity semantics transition/);
    const row = getDB().prepare(
      `SELECT COUNT(*) n FROM equity_snapshots WHERE profile_id='meanrev_stocks' AND equity=1100`
    ).get() as { n: number };
    expect(row.n).toBe(0); // the throw happens before the snapshot insert — atomic, nothing lands
  });

  test("a declared-but-PENDING rebase computes and persists its offset exactly once, atomically with the snapshot", () => {
    // Declare the future bump's kind ahead of time (no offset yet — mirrors
    // shipping a real EQUITY_SEMANTICS bump before its first live write).
    registerEquitySemanticsTransition("alpaca_main", 99, EQUITY_SEMANTICS, "rebase", { source: "test-pending-declaration" });
    rawSnap("alpaca_main", 40_000, Date.now() - 60_000, 99); // the "old era" row this bump rebases from

    saveEquitySnapshot("alpaca_main", 41_500, 41_000, 0, Date.now()); // first live write of the new era

    const t = getDB().prepare(
      `SELECT kind, equity_offset, boundary_old_equity, boundary_new_equity FROM equity_semantics_transitions WHERE profile_id='alpaca_main' AND from_semantics=99 AND to_semantics=?`
    ).get(EQUITY_SEMANTICS) as any;
    expect(t.kind).toBe("rebase");
    expect(t.equity_offset).toBeCloseTo(41_500 - 40_000, 6); // computed ONCE from this write's equity vs the latest old-era equity
    expect(t.boundary_old_equity).toBe(40_000);
    expect(t.boundary_new_equity).toBe(41_500);

    // A second write at the SAME (now current) semantics is a same-era
    // continuation — prev.semantics === new semantics, so the guard never
    // re-fires and the already-resolved offset is left untouched.
    saveEquitySnapshot("alpaca_main", 41_600, 41_100, 0, Date.now());
    const t2 = getDB().prepare(
      `SELECT equity_offset FROM equity_semantics_transitions WHERE profile_id='alpaca_main' AND from_semantics=99 AND to_semantics=?`
    ).get(EQUITY_SEMANTICS) as any;
    expect(t2.equity_offset).toBe(t.equity_offset);
  });

  test("a declared CONTINUOUS transition writes through with no throw and no offset ever needed", () => {
    registerEquitySemanticsTransition("momentum_crypto", 98, EQUITY_SEMANTICS, "continuous", { source: "test" });
    rawSnap("momentum_crypto", 5_000, Date.now() - 60_000, 98);
    expect(() => saveEquitySnapshot("momentum_crypto", 5_050, 4_000, 1, Date.now())).not.toThrow();
    const t = getDB().prepare(
      `SELECT kind, equity_offset FROM equity_semantics_transitions WHERE profile_id='momentum_crypto' AND from_semantics=98 AND to_semantics=?`
    ).get(EQUITY_SEMANTICS) as any;
    expect(t.kind).toBe("continuous");
    expect(t.equity_offset).toBeNull(); // continuous never needs one
  });
});
