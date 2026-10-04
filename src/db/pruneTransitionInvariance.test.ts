// ══════════════════════════════════════════════
// Prune / transition invariance regression (§3) — pruneEquitySnapshots must
// preserve the first and last row of every chronological semantics run, not
// just the hourly downsample. getDisplayEquitySeries computes each rebase
// offset/gap from EXACTLY those two boundary rows; pruning either one away
// would silently change an already-published rebase the next time it's read.
//
// This seeds a binance_main era4→era5 (a configured "rebase" transition)
// entirely OLDER than the prune retention window, with its two boundary rows
// sharing an hour bucket with other old rows that WOULD have been thinned by
// the plain hourly downsample — the exact shape that broke without the fix.
//
// Below that: the prune-INDEPENDENCE hardening (2026-07-19, §1/§4/§5/§6) —
// correctness no longer has to rely on prune preserving anything. The 3
// forensic-recovery transitions are seeded at every init (§1/§6), and a
// declared rebase falls back to that PERSISTED offset when the live gap
// fails, so display/P&L are byte-identical whether the exact boundary rows
// survive, get thinned to 56min apart, or are deleted outright (§4/§5).
// ══════════════════════════════════════════════

import { expect, test, describe } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  initDatabase, getDB, pruneEquitySnapshots, getEquityAt,
  getEquityPnlDisplay, getEquityDisplayStart, getEquityHistoryByRangeDisplay,
} from "./database";
import { makeTestDb, rawSnap } from "../test-support/db";

const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── Forensic recovery facts (2026-07-19, read-only backup, see database.ts
// KNOWN_TRANSITIONS) — exact values recovered from the pre-prune backup. ──
const REBASE_23_OFFSET = -5641.0895599999985; // binance_main + momentum_crypto 2→3
const REBASE_45_OFFSET = 5648.7809707819015;  // binance_main 4→5
const T_OLD_23 = Date.parse("2026-07-17T20:14:36.952Z");
const OLD_23_EQ = 10239.761283079999;
const T_NEW_23 = Date.parse("2026-07-17T20:16:11.183Z");
const NEW_23_EQ = 4598.67172308;
const T_OLD_45 = Date.parse("2026-07-18T23:45:25.235Z");
const OLD_45_EQ = 4672.30890138;
const T_NEW_45 = Date.parse("2026-07-18T23:48:26.940Z");
const NEW_45_EQ = 10321.089872161901;

test("pruning preserves a configured transition's boundary rows — display anchors and P&L are identical before/after", () => {
  makeTestDb();
  const now = Date.now();
  const hourBase = Math.floor((now - 10 * DAY) / HOUR) * HOUR; // old, hour-aligned, well past the 2-day retention

  // era4 run: first row + a "last" row sharing era5's hour bucket.
  rawSnap("binance_main", 4_700, hourBase, 4);                 // era4 first
  rawSnap("binance_main", 4_750, hourBase + 50 * 60_000, 4);   // era4 LAST — rebase anchor; rn=2 in its hour, would be pruned without the fix
  // era5 run starts 3min later (configured "rebase", gap in bounds), still in-bucket.
  rawSnap("binance_main", 9_800, hourBase + 53 * 60_000, 5);   // era5 FIRST — rebase anchor; rn=3, would be pruned without the fix
  rawSnap("binance_main", 9_850, hourBase + 58 * 60_000, 5);   // era5 non-boundary filler — legitimately prunable
  // Recent, full-resolution tail (inside the 2-day retention window).
  rawSnap("binance_main", 9_900, now - 60_000, 5);

  const snapshot = () => ({
    pnl: getEquityPnlDisplay("binance_main", 0),
    start: getEquityDisplayStart("binance_main"),
    opStart: getEquityAt("binance_main", 0), // current-era-only operational anchor
  });

  const before = snapshot();
  // Sanity: the fixture actually exercises the rebase path (not a no-op).
  expect(before.start!.rebased).toBe(true);

  const pruned = pruneEquitySnapshots(2);
  expect(pruned).toBe(1); // only the non-boundary filler (9,850) is prunable

  const after = snapshot();
  expect(after).toEqual(before);

  const survivors = (getDB().prepare(
    `SELECT equity FROM equity_snapshots WHERE profile_id='binance_main' ORDER BY snapshot_time ASC`
  ).all() as { equity: number }[]).map(r => r.equity);
  expect(survivors).toContain(4_750); // era4 last (rebase anchor) survives
  expect(survivors).toContain(9_800); // era5 first (rebase anchor) survives
  expect(survivors).not.toContain(9_850); // true filler row was thinned
});

// ══════════════════════════════════════════════
// §1/§6 — the 3 recovered transitions are seeded idempotently at every init,
// including on an EXISTING DB that predates the equity_semantics_transitions
// table (a real migration path, not just a fresh :memory: test DB).
// ══════════════════════════════════════════════
describe("recovered transitions are seeded idempotently at init", () => {
  test("binance_main 2→3, momentum_crypto 2→3, and binance_main 4→5 exist with the exact recovered offsets + provenance", () => {
    makeTestDb();
    const db = getDB();
    const row = (p: string, f: number, t: number) => db.prepare(
      `SELECT kind, equity_offset, source, boundary_old_time, boundary_old_equity, boundary_new_time, boundary_new_equity
         FROM equity_semantics_transitions WHERE profile_id=? AND from_semantics=? AND to_semantics=?`
    ).get(p, f, t) as any;

    const bm23 = row("binance_main", 2, 3);
    expect(bm23.kind).toBe("rebase");
    expect(bm23.equity_offset).toBe(REBASE_23_OFFSET);
    expect(bm23.source).toContain("backup-recovery");
    expect(bm23.boundary_old_time).toBe(T_OLD_23);
    expect(bm23.boundary_old_equity).toBe(OLD_23_EQ);
    expect(bm23.boundary_new_time).toBe(T_NEW_23);
    expect(bm23.boundary_new_equity).toBe(NEW_23_EQ);

    const mc23 = row("momentum_crypto", 2, 3);
    expect(mc23.kind).toBe("rebase");
    expect(mc23.equity_offset).toBe(REBASE_23_OFFSET);
    expect(mc23.source).toContain("backup-recovery");

    const bm45 = row("binance_main", 4, 5);
    expect(bm45.kind).toBe("rebase");
    expect(bm45.equity_offset).toBe(REBASE_45_OFFSET);
    expect(bm45.boundary_old_equity).toBe(OLD_45_EQ);
    expect(bm45.boundary_new_equity).toBe(NEW_45_EQ);
  });

  test("migration onto an existing DB where the table is ABSENT recreates + reseeds it, never duplicating or overwriting on repeated opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "uc-transitions-migration-"));
    const path = join(dir, "trading.db");
    try {
      initDatabase(path);
      getDB().close();

      // Simulate a real pre-migration production DB: drop the table entirely
      // (as if this DB predates this feature), leaving everything else intact.
      const raw = new Database(path);
      raw.exec("DROP TABLE equity_semantics_transitions");
      raw.close();

      // Reopen through the normal init path — this IS the migration.
      initDatabase(path);
      const countOffset = () => getDB().prepare(
        `SELECT COUNT(*) n, MIN(equity_offset) mn, MAX(equity_offset) mx
           FROM equity_semantics_transitions WHERE profile_id='binance_main' AND from_semantics=2 AND to_semantics=3`
      ).get() as { n: number; mn: number; mx: number };
      let r = countOffset();
      expect(r.n).toBe(1);
      expect(r.mn).toBe(REBASE_23_OFFSET);
      expect(r.mx).toBe(REBASE_23_OFFSET);
      getDB().close();

      // A THIRD open (table now present) stays idempotent too — no duplicate
      // rows, offset untouched (first declaration wins, forever).
      initDatabase(path);
      r = countOffset();
      expect(r.n).toBe(1);
      expect(r.mn).toBe(REBASE_23_OFFSET);
    } finally {
      try { getDB().close(); } catch {}
      require("fs").rmSync(dir, { recursive: true, force: true }); // dodges bun-types' fs shim (omits rmSync)
    }
  });
});

// ══════════════════════════════════════════════
// §4/§5 — production-shaped regression with the RECOVERED values. Prod's
// pruneEquitySnapshots had already deleted the exact 2→3 boundary rows
// before this fix, leaving only ~56min-apart survivors — past the old 15min
// live-gap window — which silently reported a fake ≈−$5,272 momentum loss
// instead of the true +$368.37 result. This reproduces that exact shape
// (only distant survivors, no exact boundary rows at all) and asserts the
// CORRECT number, sourced from the persisted offset alone.
// ══════════════════════════════════════════════
describe("production-shaped regression — recovered values, 56min-gap survivors only", () => {
  test("momentum_crypto All = +$368.37427982, not the fake −$5,272.72 an unpatched live-gap computation would show", () => {
    makeTestDb();
    const T_G = Date.parse("2026-07-01T00:00:00Z");
    // era2 → era3 boundary rows are 56min apart — NOT the exact original
    // pair (deleted by prod's prune before this fix), and well past the old
    // 15min live-gap window. Only the persisted offset can rescue this.
    rawSnap("momentum_crypto", 10_272.715280179998, T_G, 2);              // era2 first (all-time start)
    rawSnap("momentum_crypto", 4_700, T_G + 56 * 60_000, 3);              // era3, 56min gap
    rawSnap("momentum_crypto", 4_750, T_G + 57 * 60_000, 4);              // era4 (continuous)
    rawSnap("momentum_crypto", 5_000, T_G + 58 * 60_000, 5);              // era5 = latest

    const r = getEquityPnlDisplay("momentum_crypto", 0)!;
    expect(r.pnl).toBeCloseTo(368.37427982, 6);
    expect(r.pnl).not.toBeCloseTo(-5_272.71528, 1); // the fake pre-fix number
    expect(r.pnlPct).toBeNull(); // crossed a rebase — % stays suppressed

    const start = getEquityDisplayStart("momentum_crypto")!;
    // The displayed start is the RAW era2 value shifted by the exact
    // recovered offset (momentum_crypto has no further rebase past 2→3 —
    // 3→4/4→5 are declared continuous, so nothing else composes in here).
    expect(start.equity).toBeCloseTo(10_272.715280179998 + REBASE_23_OFFSET, 6);
    expect(start.rebased).toBe(true);

    const all = getEquityHistoryByRangeDisplay("momentum_crypto", "all");
    expect(all[0].equity).toBeCloseTo(start.equity, 6); // series[0] IS the display start
    // Directly verify the applied correction equals the recovered offset:
    // latest(raw) − (era2First + offset) === pnl.
    expect(5_000 - (10_272.715280179998 + REBASE_23_OFFSET)).toBeCloseTo(368.37427982, 6);
  });

  test("binance_main's old-era cumulative offset (2→3 rebase composed through 3→4 continuous into 4→5 rebase) is exactly +7.691410781903", () => {
    makeTestDb();
    const T_G = Date.parse("2026-07-01T00:00:00Z");
    rawSnap("binance_main", 10_000, T_G, 2);                              // era2 first — gap to era3 forces the persisted 2→3 fallback (>15min)
    rawSnap("binance_main", 4_600, T_G + 1 * DAY, 3);                     // era3
    rawSnap("binance_main", 4_650, T_OLD_45 - 2 * DAY, 4);                // era4 first (continuous from era3)
    rawSnap("binance_main", OLD_45_EQ, T_OLD_45, 4);                      // era4 last — EXACT recovered boundary
    rawSnap("binance_main", NEW_45_EQ, T_NEW_45, 5);                      // era5 first — EXACT recovered boundary (gap ≈3min, live-eligible)
    rawSnap("binance_main", 10_400, T_NEW_45 + 2 * DAY, 5);               // era5 latest

    const start = getEquityDisplayStart("binance_main")!;
    const cumulative = REBASE_23_OFFSET + REBASE_45_OFFSET;
    expect(cumulative).toBeCloseTo(7.691410781903, 6);
    expect(start.equity - 10_000).toBeCloseTo(cumulative, 6);
    expect(start.rebased).toBe(true);

    // 4→5 stays exact: the live-computed delta (new−old, same-moment,
    // gap≈3min) equals the persisted recovered offset bit-for-bit.
    expect(NEW_45_EQ - OLD_45_EQ).toBe(REBASE_45_OFFSET);

    // Latest is always raw/unchanged, by construction.
    const all = getEquityHistoryByRangeDisplay("binance_main", "all");
    expect(all[all.length - 1].equity).toBe(10_400);
    expect(all[all.length - 1].rebased).toBe(false);
  });
});

// ══════════════════════════════════════════════
// §4 — byte-equivalent display/P&L before and after DELETING the exact
// boundary rows entirely (not merely pruning/thinning them). Correctness no
// longer depends on those rows surviving at all: deleting them forces the
// live gap check to fail (the surviving neighbors are days apart instead of
// ~3min), which falls back to the SAME persisted offset — so every
// surviving row's displayed value, and every P&L/start anchor, is identical.
// ══════════════════════════════════════════════
describe("byte-equivalent display/P&L before and after deleting the exact boundary rows entirely", () => {
  test("deleting binance_main's exact 4→5 boundary rows changes nothing observable", () => {
    makeTestDb();
    const T_G = Date.parse("2026-07-01T00:00:00Z");
    rawSnap("binance_main", 10_000, T_G, 2);
    rawSnap("binance_main", 4_600, T_G + 1 * DAY, 3);
    rawSnap("binance_main", 4_650, T_OLD_45 - 2 * DAY, 4);   // era4 first — SURVIVES deletion
    rawSnap("binance_main", OLD_45_EQ, T_OLD_45, 4);         // era4 last — EXACT boundary, deleted below
    rawSnap("binance_main", NEW_45_EQ, T_NEW_45, 5);         // era5 first — EXACT boundary, deleted below
    rawSnap("binance_main", 10_350, T_NEW_45 + 1 * DAY, 5);  // era5 mid — SURVIVES, becomes new "first" after deletion
    rawSnap("binance_main", 10_400, T_NEW_45 + 2 * DAY, 5);  // era5 latest — always unaffected

    const snapshot = () => ({
      pnl: getEquityPnlDisplay("binance_main", 0),
      start: getEquityDisplayStart("binance_main"),
      // Only the rows that will SURVIVE deletion, for an apples-to-apples diff.
      survivingDisplay: getEquityHistoryByRangeDisplay("binance_main", "all")
        .filter(r => r.equity !== OLD_45_EQ && r.equity !== NEW_45_EQ)
        .map(r => ({ equity: r.equity, rebased: r.rebased, basis: r.basis })),
    });

    const before = snapshot();
    expect(before.start!.rebased).toBe(true);

    // Delete the exact boundary rows OUTRIGHT — not a prune, a hard DELETE —
    // leaving only survivors 3 days apart at that boundary.
    getDB().prepare(`DELETE FROM equity_snapshots WHERE profile_id='binance_main' AND equity IN (?, ?)`).run(OLD_45_EQ, NEW_45_EQ);
    const survivorGapDays = (T_NEW_45 + 1 * DAY - (T_OLD_45 - 2 * DAY)) / DAY;
    expect(survivorGapDays).toBeGreaterThan(1); // confirms the live gap check now fails (>15min)

    const after = snapshot();
    expect(after).toEqual(before); // byte-equivalent — correctness never depended on the deleted rows
  });
});

// ══════════════════════════════════════════════
// §7 — the specific case §4 above doesn't cover: deleting the exact boundary
// rows but leaving CLOSE (5-10min) neighboring survivors — not distant ones
// — that moved with the market in the meantime. A "close" gap used to be
// (wrongly) trusted as "the same moment" and would recompute a DIFFERENT,
// wrong offset from these survivors. The persisted forensic offset must be
// used regardless — output stays byte-identical to before the deletion.
// ══════════════════════════════════════════════
describe("byte-equivalent display/P&L when the exact boundary rows are deleted but CLOSE (5-10min) survivors with real market movement remain", () => {
  test("deleting binance_main's exact 4→5 boundary rows, with near-boundary survivors 6/7min out that moved off the true boundary values, still uses the persisted offset", () => {
    makeTestDb();
    const T_G = Date.parse("2026-07-01T00:00:00Z");
    rawSnap("binance_main", 10_000, T_G, 2);
    rawSnap("binance_main", 4_600, T_G + 1 * DAY, 3);
    rawSnap("binance_main", 4_650, T_OLD_45 - 2 * DAY, 4);                 // era4 first — survives
    rawSnap("binance_main", OLD_45_EQ - 50, T_OLD_45 - 4 * 60_000, 4);     // era4 near-boundary survivor, 4min out, market moved −50
    rawSnap("binance_main", OLD_45_EQ, T_OLD_45, 4);                      // era4 last — EXACT boundary, deleted below
    rawSnap("binance_main", NEW_45_EQ, T_NEW_45, 5);                      // era5 first — EXACT boundary, deleted below
    rawSnap("binance_main", NEW_45_EQ + 80, T_NEW_45 + 5 * 60_000, 5);    // era5 near-boundary survivor, 5min out, market moved +80
    rawSnap("binance_main", 10_400, T_NEW_45 + 2 * DAY, 5);               // era5 latest — always unaffected

    const snapshot = () => ({
      pnl: getEquityPnlDisplay("binance_main", 0),
      start: getEquityDisplayStart("binance_main"),
      survivingDisplay: getEquityHistoryByRangeDisplay("binance_main", "all")
        .filter(r => r.equity !== OLD_45_EQ && r.equity !== NEW_45_EQ)
        .map(r => ({ equity: r.equity, rebased: r.rebased, basis: r.basis })),
    });

    const before = snapshot();
    expect(before.start!.rebased).toBe(true);

    // Delete the exact boundary rows OUTRIGHT, leaving only the 4/5min-out
    // survivors — a total gap under 15min, still WELL within the old
    // (removed) "trust the live gap" window, and a naive live delta between
    // them (NEW_45_EQ+80 − (OLD_45_EQ−50) = the true offset +130) would
    // silently report a different, wrong number if read-time ever
    // recomputed it.
    getDB().prepare(`DELETE FROM equity_snapshots WHERE profile_id='binance_main' AND equity IN (?, ?)`).run(OLD_45_EQ, NEW_45_EQ);
    const survivorGapMin = (T_NEW_45 + 5 * 60_000 - (T_OLD_45 - 4 * 60_000)) / 60_000;
    expect(survivorGapMin).toBeLessThan(15); // confirms this is the "close gap" shape, not §4's distant one
    expect(survivorGapMin).toBeGreaterThan(5); // and within the "5-10min... with market movement" shape the spec calls out

    const after = snapshot();
    expect(after).toEqual(before); // byte-identical — the persisted offset, not the close-but-wrong survivors, drove the result

    // Sanity: pin the actual (correct) result to the known composed offset
    // (2→3 rebase carried through the 3→4 continuous boundary), and confirm
    // it is NOT the ~130-off value a live recomputation off the near-boundary
    // survivors would have produced.
    const cumulative = REBASE_23_OFFSET + REBASE_45_OFFSET;
    expect(after.start!.equity - 10_000).toBeCloseTo(cumulative, 6);
    expect(after.start!.equity - 10_000).not.toBeCloseTo(cumulative + 130, 1);
  });
});
