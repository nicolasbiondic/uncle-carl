// ══════════════════════════════════════════════
// DISPLAY-only equity history rebasing — explicit per-transition
// declarations (registerEquitySemanticsTransition / KNOWN_TRANSITIONS)
// splice every semantics era into one continuous curve for the
// dashboard/Telegram "Since Start" and Equity tab, WITHOUT touching the
// current-era-only operational anchors (getEquityAt/getEquityPnl/
// getEquityHistory*/getRiskMetrics/getDrawdownSeries) those still back risk
// + invariants.
//
// Persisted-offset authority (2026-07-20, §7): a declared "rebase" ALWAYS
// uses its PERSISTED equity_offset when one exists — never a live boundary
// delta re-derived from whatever rows happen to survive, even when the
// surviving neighbors sit only minutes apart. A "close" gap is not proof
// those rows are the true original boundary: thinning/deletion can leave a
// few-minutes-adjacent survivor that already moved with the market,
// silently corrupting an already-published rebase. Boundary-row computation
// only ever happens ONCE, at the first new-semantics write
// (recordFirstTransitionIfNeeded) — never again on read. See "declared
// rebase, offset not yet persisted" below for the still-unknown case, and
// pruneTransitionInvariance.test.ts for the dedicated regression using the
// REAL production ids + REAL recovered forensic offsets (including the
// close-gap-after-deletion shape).
//
// These fixtures use PRIVATE test-only profile ids (never the 5 canonical
// production series) so they can freely declare their own transitions
// without colliding with the real seeded forensic-recovery rows.
// ══════════════════════════════════════════════

import { describe, expect, test, beforeAll } from "bun:test";
import {
  getDB, getEquityAt,
  registerEquitySemanticsTransition,
  getEquityHistoryDisplay, getEquityHistoryByRangeDisplay, getEquityPnlDisplay,
  getEquityDisplayStart,
} from "./database";
import { makeTestDb, rawSnap } from "../test-support/db";

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

beforeAll(() => {
  makeTestDb();

  // ── rb_chain: full 2→3→4→5 chain, each rebase carrying its PERSISTED
  // offset (as if already recorded by the first new-semantics write) —
  // exercises the mechanism end-to-end via the persisted value, not a live
  // read-time computation (era3→era4 is a declared "continuous" real
  // continuation, needs no offset).
  registerEquitySemanticsTransition("rb_chain", 2, 3, "rebase", { offset: 5_000 - 10_050, source: "test" });
  registerEquitySemanticsTransition("rb_chain", 3, 4, "continuous", { source: "test" });
  registerEquitySemanticsTransition("rb_chain", 4, 5, "rebase", { offset: 9_800 - 4_750, source: "test" });
  rawSnap("rb_chain", 10_000, T0, 2);                              // era2 first (= all-time display start)
  rawSnap("rb_chain", 10_050, T0 + 1 * DAY, 2);                    // era2 last (within-era delta preserved)
  rawSnap("rb_chain", 5_000, T0 + 1 * DAY + 5 * 60_000, 3);        // era3 first: declared 2→3, gap 5min
  rawSnap("rb_chain", 5_010, T0 + 2 * DAY, 3);                     // era3 last
  rawSnap("rb_chain", 4_700, T0 + 2 * DAY + 10 * 60_000, 4);       // era4 first: declared continuous, gap 10min
  rawSnap("rb_chain", 4_750, T0 + 3 * DAY, 4);                     // era4 last
  rawSnap("rb_chain", 9_800, T0 + 3 * DAY + 3 * 60_000, 5);        // era5 first: declared 4→5, gap 3min
  rawSnap("rb_chain", 9_900, T0 + 4 * DAY, 5);                     // era5 latest (== raw, offset 0)

  // ── rb_fallback: a declared rebase whose SURVIVING boundary rows are
  // >15min apart (thinned/pruned) — must fall back to the PERSISTED offset,
  // independent of (and deliberately different from) what those surviving
  // rows would compute live. This is the exact production incident (§2/§5):
  // pruning ate the true boundary, leaving only distant survivors.
  registerEquitySemanticsTransition("rb_fallback", 2, 3, "rebase", { offset: 999, source: "test-persisted" });
  rawSnap("rb_fallback", 100, T0, 2);                              // era2 last — a LIVE delta here would be +999,900
  rawSnap("rb_fallback", 1_000_000, T0 + 20 * 60_000, 3);          // era3 first — 20min gap, exceeds the live window
  rawSnap("rb_fallback", 1_000_100, T0 + 1 * DAY, 3);              // latest

  // ── rb_pending: a declared rebase with NEITHER a close live gap NOR a
  // persisted offset yet (a future-bump declaration whose first live write
  // hasn't happened) — genuinely unknown, must fail closed like undeclared.
  registerEquitySemanticsTransition("rb_pending", 2, 3, "rebase", { source: "test-pending" });
  rawSnap("rb_pending", 100, T0, 2);
  rawSnap("rb_pending", 200, T0 + 20 * 60_000, 3);

  // ── rb_pending_close_gap: same "no persisted offset yet" case, but the
  // surviving rows sit only 2min apart — proves boundary-row computation is
  // NEVER performed at read time, even when a gap would look "close enough"
  // under the old (removed) live-computation path.
  registerEquitySemanticsTransition("rb_pending_close_gap", 2, 3, "rebase", { source: "test-pending-close" });
  rawSnap("rb_pending_close_gap", 100, T0, 2);
  rawSnap("rb_pending_close_gap", 200, T0 + 2 * 60_000, 3);

  // ── rb_undeclared: no registration at all for this pair — must stay
  // discontinuous even with a small (otherwise-live-eligible) gap.
  rawSnap("rb_undeclared", 500, T0, 2);
  rawSnap("rb_undeclared", 300, T0 + 1 * 60_000, 3);

  // ── rb_reverse: one declared+live-clean rebase, followed by an undeclared
  // reverse-direction boundary (3→2) — the later unknown boundary poisons
  // (marks discontinuous) every row before it, all the way back to the
  // start, even though the first boundary was itself clean.
  registerEquitySemanticsTransition("rb_reverse", 2, 3, "rebase", { offset: 4_000 - 8_000, source: "test" });
  rawSnap("rb_reverse", 8_000, T0, 2);
  rawSnap("rb_reverse", 4_000, T0 + 1 * 60_000, 3);                // declared, live gapOk
  rawSnap("rb_reverse", 7_000, T0 + 3 * DAY, 2);                   // 3→2 undeclared

  // ── rb_continuous: a declared CONTINUOUS pair ⇒ display equals raw
  // everywhere, even across a huge jump (no correction, never discontinuous).
  registerEquitySemanticsTransition("rb_continuous", 2, 3, "continuous", { source: "test" });
  rawSnap("rb_continuous", 100_000, T0, 2);
  rawSnap("rb_continuous", 50_000, T0 + 1 * DAY, 3);
  rawSnap("rb_continuous", 50_100, T0 + 2 * DAY, 3);

  // ── one-row eras + duplicate timestamps + old-semantics rows, for
  // determinism under weird inputs (a single run — no boundary at all).
  rawSnap("rb_dup", 1_000, T0, 0);                // invisible (semantics<2)
  rawSnap("rb_dup", 1_000, T0 + 1 * DAY, 1);      // invisible (semantics<2)
  rawSnap("rb_dup", 2_000, T0 + 2 * DAY, 5);      // single current-era row
  rawSnap("rb_dup", 2_100, T0 + 2 * DAY, 5);      // duplicate snapshot_time, same era

  // ── alpaca_main: a REAL registered production id (needed to exercise the
  // SEMANTICS_REGISTRY-driven "current era" filter + stale-run quarantine,
  // both of which key off the registry). Its own eras are seeded
  // "continuous" (offset 0 everywhere) — this fixture is about the
  // operational-vs-display SPLIT, not rebase math.
  rawSnap("alpaca_main", 100, T0, 2);
  rawSnap("alpaca_main", 150, T0 + 1 * DAY, 3);
  rawSnap("alpaca_main", 200, T0 + 2 * DAY, 4);
  rawSnap("alpaca_main", 300, T0 + 3 * DAY, 5);
  rawSnap("alpaca_main", 310, T0 + 4 * DAY, 5);
});

describe("declared rebase — persisted offset applied, exact once-computed value", () => {
  test("rb_chain: 2→3 and 4→5 rebase; 3→4 (continuous) does not", () => {
    const all = getEquityHistoryByRangeDisplay("rb_chain", "all");
    expect(all.length).toBe(8);
    const off45 = 9_800 - 4_750;                 // era4→era5 jump cancelled (persisted offset)
    const off23 = 5_000 - 10_050;                 // era2→era3 jump cancelled (persisted offset)
    const offEra4 = off45;                        // era3→era4 continuous: carries era4's offset unchanged
    const offEra3 = off45;                        // same reasoning — era3 inherits era4's offset
    const offEra2 = offEra3 + off23;

    expect(all[0].equity).toBeCloseTo(10_000 + offEra2, 6); // era2 first
    expect(all[1].equity).toBeCloseTo(10_050 + offEra2, 6); // era2 last — within-era delta preserved
    expect(all[1].equity - all[0].equity).toBeCloseTo(50, 6);
    expect(all[2].equity).toBeCloseTo(5_000 + offEra3, 6);  // era3 first — continuous with era2 last
    expect(all[1].equity).toBeCloseTo(all[2].equity, 6);
    expect(all[3].equity).toBeCloseTo(5_010 + offEra3, 6);
    expect(all[3].equity - all[2].equity).toBeCloseTo(10, 6);
    expect(all[4].equity).toBeCloseTo(4_700 + offEra4, 6);
    expect(all[4].equity - all[3].equity).toBeCloseTo(4_700 - 5_010, 6); // real continuous delta, not zeroed
    expect(all[5].equity).toBeCloseTo(4_750 + offEra4, 6);
    expect(all[6].equity).toBeCloseTo(9_800, 6);             // era5 first — continuous with era4 last
    expect(all[5].equity).toBeCloseTo(all[6].equity, 6);
    expect(all[7].equity).toBe(9_900);                       // latest adjusted == latest raw, exactly

    expect(all[7].rebased).toBe(false);
    expect(all[0].rebased).toBe(true);
    expect(all[0].basis).toBe("rebase");
  });
});

describe("declared rebase — the persisted offset always wins, whatever the live gap looks like (§2/§7)", () => {
  test("rb_fallback: uses the registered offset, not the (deliberately different) live delta", () => {
    const all = getEquityHistoryByRangeDisplay("rb_fallback", "all");
    expect(all.length).toBe(3);
    // A live computation across this 20min gap would have given 100+999_900
    // = 1,000,000 (era3's raw first value) — i.e. era2 would look
    // "continuous" with era3. The persisted offset (999) is used instead,
    // proving the result no longer depends on which boundary rows survived.
    expect(all[0].equity).toBe(100 + 999);
    expect(all[0].equity).not.toBeCloseTo(1_000_000, 0);
    expect(all[0].basis).toBe("rebase");
    expect(all[0].rebased).toBe(true);
    expect(all[1].equity).toBe(1_000_000); // era3 first, raw (offset 0 at/after latest run)
    expect(all[2].equity).toBe(1_000_100); // latest, raw
  });

  test("rb_pending: declared rebase with no live gap AND no persisted offset yet ⇒ discontinuous, raw preserved", () => {
    const all = getEquityHistoryByRangeDisplay("rb_pending", "all");
    expect(all.map(r => r.equity)).toEqual([100, 200]); // raw, uncorrected
    expect(all[0].basis).toBe("discontinuous");
    expect(all[0].rebased).toBe(true); // discontinuous still means "don't trust a % across this point"
  });

  test("rb_pending_close_gap: no persisted offset yet ⇒ discontinuous even though the surviving rows are only 2min apart", () => {
    // Read-time never computes a boundary from surviving rows, regardless of
    // how close they sit — that calculation is only ever permitted once, at
    // the first new-semantics write. A close gap here must NOT rescue it.
    const all = getEquityHistoryByRangeDisplay("rb_pending_close_gap", "all");
    expect(all.map(r => r.equity)).toEqual([100, 200]); // raw, uncorrected
    expect(all[0].basis).toBe("discontinuous");
    expect(all[0].rebased).toBe(true);
  });
});

describe("undeclared transitions fail closed, regardless of gap size", () => {
  test("rb_undeclared: never registered ⇒ discontinuous even with a small (otherwise-eligible) gap", () => {
    const all = getEquityHistoryByRangeDisplay("rb_undeclared", "all");
    expect(all.map(r => r.equity)).toEqual([500, 300]);
    expect(all[0].basis).toBe("discontinuous");
  });

  test("rb_reverse: a later undeclared boundary poisons every row before it, even a persisted-offset rebase", () => {
    const all = getEquityHistoryByRangeDisplay("rb_reverse", "all");
    expect(all.length).toBe(3);
    // The 2→3 boundary itself carries a clean persisted offset (−4,000)...
    expect(all[0].equity).toBe(8_000 - 4_000);
    expect(all[1].equity).toBe(4_000);
    // ...but the LATER 3→2 boundary is undeclared, so the whole earlier path
    // is marked discontinuous, not just its own immediate boundary.
    expect(all[0].basis).toBe("discontinuous");
    expect(all[1].basis).toBe("discontinuous");
    expect(all[2].equity).toBe(7_000); // latest, always raw/offset-0
    expect(all[2].basis).toBe("continuous");
  });
});

describe("declared continuous — raw everywhere, even across a huge jump", () => {
  test("rb_continuous: no correction, never discontinuous", () => {
    const all = getEquityHistoryByRangeDisplay("rb_continuous", "all");
    expect(all.map(r => r.equity)).toEqual([100_000, 50_000, 50_100]);
    expect(all.every(r => r.rebased === false)).toBe(true);
    expect(all.every(r => r.basis === "continuous")).toBe(true);
  });
});

describe("one-row eras, duplicate timestamps, and NULL/old-semantics rows are handled deterministically", () => {
  test("rb_dup: a single run — no boundary, nothing to classify", () => {
    const all = getEquityHistoryByRangeDisplay("rb_dup", "all");
    // The two semantics<2 rows are invisible; the duplicate-timestamp pair
    // both surface, in insertion (id) order, unrebased (no boundary at all).
    expect(all.map(r => r.equity)).toEqual([2_000, 2_100]);
    expect(all.every(r => r.rebased === false)).toBe(true);
  });
});

describe("latest raw == latest adjusted, always", () => {
  test("across every fixture profile", () => {
    for (const p of ["rb_chain", "rb_fallback", "rb_pending", "rb_pending_close_gap", "rb_undeclared", "rb_reverse", "rb_continuous", "rb_dup"]) {
      const raw = getDB().prepare(
        `SELECT equity FROM equity_snapshots WHERE profile_id=? AND semantics>=2 ORDER BY snapshot_time DESC, id DESC LIMIT 1`
      ).get(p) as { equity: number };
      const display = getEquityHistoryByRangeDisplay(p, "all");
      expect(display[display.length - 1].equity).toBe(raw.equity);
    }
  });
});

describe("current-era operational helpers are untouched by the display rebase", () => {
  test("getEquityAt still filters to EQUITY_SEMANTICS only", () => {
    // alpaca_main has only 2 rows at the CURRENT era (5); the display series has 5.
    expect(getEquityAt("alpaca_main", 0)).toBe(300);
  });
});

describe("getEquityPnlDisplay — periodDays=0 means all-time, pct null when the start point is rebased", () => {
  test("periodDays=0 anchors at the FIRST eligible adjusted point", () => {
    const r = getEquityPnlDisplay("rb_chain", 0)!;
    const off23 = 5_000 - 10_050, off45 = 9_800 - 4_750, offEra2 = off45 + off23;
    const startAdjusted = 10_000 + offEra2;
    expect(r.pnl).toBeCloseTo(9_900 - startAdjusted, 6);
    expect(r.pnlPct).toBeNull(); // crossed declared rebases, even though the offsets cancel numerically here
  });

  test("rb_fallback's all-time pnl uses the persisted offset too — real $ delta, suppressed %", () => {
    const r = getEquityPnlDisplay("rb_fallback", 0)!;
    expect(r.pnl).toBeCloseTo(1_000_100 - (100 + 999), 6);
    expect(r.pnlPct).toBeNull();
  });

  test("rb_reverse's all-time start crosses the later undeclared boundary ⇒ fails closed entirely", () => {
    // Unlike a pure rebase (which still gives a real $ delta with a
    // suppressed %), an unknown boundary can't be trusted for the $ delta
    // either — the whole result fails closed.
    expect(getEquityPnlDisplay("rb_reverse", 0)).toBeNull();
  });

  test("rb_continuous (never rebased) always gets a real pct, even across its own huge raw jump", () => {
    const r = getEquityPnlDisplay("rb_continuous", 0)!;
    expect(r.pnl).toBeCloseTo(50_100 - 100_000, 6);
    expect(r.pnlPct).toBeCloseTo(((50_100 - 100_000) / 100_000) * 100, 6);
  });

  test("returns null with no eligible rows", () => {
    expect(getEquityPnlDisplay("nonexistent_profile_xyz", 0)).toBeNull();
  });
});

describe("getEquityDisplayStart — {equity, rebased} metadata", () => {
  test("rb_chain's all-time start is the era2 value, adjusted, flagged rebased", () => {
    const s = getEquityDisplayStart("rb_chain")!;
    expect(s.rebased).toBe(true);
    expect(s.equity).toBe(10_000); // corrections cancel numerically; metadata still records the rebases
  });

  test("rb_fallback's all-time start reflects the persisted offset", () => {
    const s = getEquityDisplayStart("rb_fallback")!;
    expect(s.equity).toBe(1_099);
    expect(s.rebased).toBe(true);
  });

  test("rb_continuous's all-time start is raw, never rebased", () => {
    const s = getEquityDisplayStart("rb_continuous")!;
    expect(s.equity).toBe(100_000);
    expect(s.rebased).toBe(false);
  });

  test("null when the profile has no eligible rows", () => {
    expect(getEquityDisplayStart("nonexistent_profile_xyz")).toBeNull();
  });
});

describe("getEquityHistoryDisplay — days<=0 means all-time", () => {
  test("days=0 returns the full spliced series, not 'today'", () => {
    const rows = getEquityHistoryDisplay("rb_chain", 0);
    expect(rows.length).toBe(8);
  });
});

// Appended last: mutates the shared alpaca_main fixture, so it must run
// after every other assertion against it above.
describe("stale-era terminal row is quarantined from 'latest'", () => {
  test("a straggler write at a non-current semantics landing after the true latest is ignored", () => {
    // Simulates a race around an EQUITY_SEMANTICS bump: an old-era write lands
    // chronologically AFTER the true (current-era) latest row.
    rawSnap("alpaca_main", 1_234, T0 + 4 * DAY + 60_000, 4); // stale era4, after era5's 310
    const all = getEquityHistoryByRangeDisplay("alpaca_main", "all");
    expect(all[all.length - 1].equity).toBe(310);           // still the true current-era latest
    expect(all.some(r => r.equity === 1_234)).toBe(false);  // the straggler never surfaces
    expect(getEquityDisplayStart("alpaca_main")!.equity).toBe(100); // unaffected
  });
});
