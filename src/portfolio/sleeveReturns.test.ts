// ══════════════════════════════════════════════
// Daily sleeve return series (src/portfolio/sleeveReturns.ts).
// Contracts under test:
//   • ONE observation per ET day (last snapshot of the day), ET boundaries
//     via getETDateKey — a 23:30 ET write and a 00:30 ET write land on
//     different days even though both are the "same" UTC morning.
//   • A non-continuous era boundary (rebase OR undeclared) produces an
//     explicit gap, never an invented return; a declared "continuous"
//     transition does NOT break the series.
//   • A grid day without snapshots produces a gap (no multi-day return
//     disguised as daily).
//   • Alpaca sleeves observe on ET trading days (weekend rows dropped,
//     Fri→Mon adjacent); Binance sleeves on calendar days.
//   • Shadow sleeve (mode row + fresh snapshots) is distinguishable from a
//     broken pipeline (stale snapshots), which is distinguishable from an
//     empty series.
// All fixtures use January 2026 (EST, UTC−5: ET day D = [D 05:00Z, D+1 05:00Z)).
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { makeTestDb, rawSnap } from "../test-support/db";
import { registerEquitySemanticsTransition } from "../db/database";
import { SleeveGovernor } from "../governor/SleeveGovernor";
import { getDailySleeveReturns, nextGridDay } from "./sleeveReturns";

/** Epoch ms for `hourET` (0-23, EST winter) on YYYY-MM-DD. */
const et = (key: string, hourET: number, min = 0) =>
  Date.parse(`${key}T00:00:00Z`) + (hourET + 5) * 3_600_000 + min * 60_000;

describe("one observation per ET day", () => {
  test("several snapshots the same ET day → one mark (the last); 23:30 ET vs 00:30 ET split correctly", () => {
    makeTestDb();
    // momentum_crypto (binance ⇒ calendar grid). Jan 5/6/7 2026 (Mon/Tue/Wed).
    rawSnap("momentum_crypto", 5_000, et("2026-01-05", 10), 5);
    rawSnap("momentum_crypto", 5_050, et("2026-01-05", 22), 5);   // last of Jan 5 → the mark
    rawSnap("momentum_crypto", 5_100, et("2026-01-06", 9), 5);
    rawSnap("momentum_crypto", 5_200, et("2026-01-06", 23, 30), 5); // 23:30 ET Jan 6 = 04:30Z Jan 7 — still Jan 6
    rawSnap("momentum_crypto", 5_150, et("2026-01-07", 0, 30), 5);  // 00:30 ET Jan 7 — Jan 7's (only) mark
    // now = Jan 8 noon ET ⇒ Jan 5-7 are completed days.
    const s = getDailySleeveReturns("momentum_crypto", { now: et("2026-01-08", 12) });
    expect(s.grid).toBe("calendar_days");
    expect(s.obsPerYear).toBe(365);
    expect(s.equitySource).toBe("broker_truth");
    expect(s.nDailyMarks).toBe(3);
    expect(s.nObservations).toBe(2);
    expect(s.returns[0].dateKey).toBe("2026-01-06");
    expect(s.returns[0].ret).toBeCloseTo(5_200 / 5_050 - 1, 10); // last-of-day marks on both sides
    expect(s.returns[1].dateKey).toBe("2026-01-07");
    expect(s.returns[1].ret).toBeCloseTo(5_150 / 5_200 - 1, 10);
    expect(s.gaps).toHaveLength(0);
  });

  test("the current (incomplete) ET day is never an observation", () => {
    makeTestDb();
    rawSnap("momentum_crypto", 5_000, et("2026-01-05", 22), 5);
    rawSnap("momentum_crypto", 5_100, et("2026-01-06", 10), 5); // "today" for this call
    const s = getDailySleeveReturns("momentum_crypto", { now: et("2026-01-06", 12) });
    expect(s.nDailyMarks).toBe(1); // only Jan 5
    expect(s.nObservations).toBe(0);
  });
});

describe("era boundaries — hole, never an invented return", () => {
  test("declared REBASE splits the series: $-continuity is spliced but the % return across it is excluded", () => {
    makeTestDb();
    // Private test id (unregistered ⇒ calendar grid, no registry quarantine).
    registerEquitySemanticsTransition("tr_era", 4, 5, "rebase", { offset: 90, source: "test" });
    rawSnap("tr_era", 100, et("2026-01-05", 22), 4);
    rawSnap("tr_era", 110, et("2026-01-06", 22), 4);
    rawSnap("tr_era", 200, et("2026-01-07", 22), 5); // rebase boundary 4→5
    rawSnap("tr_era", 210, et("2026-01-08", 22), 5);
    const s = getDailySleeveReturns("tr_era", { now: et("2026-01-09", 12) });
    expect(s.nDailyMarks).toBe(4);
    // Jan 6 (within era 4) and Jan 8 (within era 5) are valid; Jan 7 is a hole.
    expect(s.returns.map(r => r.dateKey)).toEqual(["2026-01-06", "2026-01-08"]);
    expect(s.returns[0].ret).toBeCloseTo(0.10, 10);
    expect(s.returns[1].ret).toBeCloseTo(210 / 200 - 1, 10);
    expect(s.gaps).toEqual([{ fromDate: "2026-01-06", toDate: "2026-01-07", cause: "era_boundary" }]);
  });

  test("UNDECLARED transition (discontinuous) is likewise a hole", () => {
    makeTestDb();
    rawSnap("tr_undecl", 100, et("2026-01-05", 22), 4);
    rawSnap("tr_undecl", 500, et("2026-01-06", 22), 5); // no registered 4→5 for this id
    const s = getDailySleeveReturns("tr_undecl", { now: et("2026-01-07", 12) });
    expect(s.nObservations).toBe(0);
    expect(s.gaps).toEqual([{ fromDate: "2026-01-05", toDate: "2026-01-06", cause: "era_boundary" }]);
  });

  test("declared CONTINUOUS transition does NOT break the series", () => {
    makeTestDb();
    registerEquitySemanticsTransition("tr_cont", 4, 5, "continuous", { source: "test" });
    rawSnap("tr_cont", 100, et("2026-01-05", 22), 4);
    rawSnap("tr_cont", 101, et("2026-01-06", 22), 5);
    const s = getDailySleeveReturns("tr_cont", { now: et("2026-01-07", 12) });
    expect(s.gaps).toHaveLength(0);
    expect(s.nObservations).toBe(1);
    expect(s.returns[0].ret).toBeCloseTo(0.01, 10);
  });

  test("synthetic rows are invisible (same rule as every display anchor)", () => {
    makeTestDb();
    rawSnap("momentum_crypto", 5_000, et("2026-01-05", 22), 5);
    rawSnap("momentum_crypto", 9_999, et("2026-01-06", 22), 5, 1); // synthetic — must not become a mark
    rawSnap("momentum_crypto", 5_100, et("2026-01-06", 23), 5);
    const s = getDailySleeveReturns("momentum_crypto", { now: et("2026-01-07", 12) });
    expect(s.returns[0].ret).toBeCloseTo(5_100 / 5_000 - 1, 10);
  });
});

describe("grid holes and unusable bases", () => {
  test("a day without snapshots → explicit gap, never a 2-day return", () => {
    makeTestDb();
    rawSnap("momentum_crypto", 5_000, et("2026-01-05", 22), 5);
    rawSnap("momentum_crypto", 5_100, et("2026-01-06", 22), 5);
    // Jan 7 missing entirely.
    rawSnap("momentum_crypto", 5_300, et("2026-01-08", 22), 5);
    const s = getDailySleeveReturns("momentum_crypto", { now: et("2026-01-09", 12) });
    expect(s.returns.map(r => r.dateKey)).toEqual(["2026-01-06"]);
    expect(s.gaps).toEqual([{ fromDate: "2026-01-06", toDate: "2026-01-08", cause: "missing_snapshots" }]);
  });

  test("non-positive base equity → gap, not a bogus percentage", () => {
    makeTestDb();
    rawSnap("tr_zero", 0, et("2026-01-05", 22), 5);
    rawSnap("tr_zero", 100, et("2026-01-06", 22), 5);
    const s = getDailySleeveReturns("tr_zero", { now: et("2026-01-07", 12) });
    expect(s.nObservations).toBe(0);
    expect(s.gaps[0].cause).toBe("unusable_base");
  });
});

describe("observation grid per sleeve nature", () => {
  test("Alpaca sleeve: weekend rows dropped, Fri→Mon is grid-adjacent (a valid return)", () => {
    makeTestDb();
    // Thu Jan 8, Fri Jan 9, Sat 10, Sun 11, Mon Jan 12.
    rawSnap("momentum_stocks", 50_000, et("2026-01-08", 22), 5);
    rawSnap("momentum_stocks", 50_500, et("2026-01-09", 22), 5);
    rawSnap("momentum_stocks", 50_500, et("2026-01-10", 22), 5); // Sat — frozen ledger, not an observation
    rawSnap("momentum_stocks", 50_500, et("2026-01-11", 22), 5); // Sun
    rawSnap("momentum_stocks", 51_510, et("2026-01-12", 22), 5);
    const s = getDailySleeveReturns("momentum_stocks", { now: et("2026-01-13", 12) });
    expect(s.grid).toBe("trading_days");
    expect(s.obsPerYear).toBe(252);
    expect(s.equitySource).toBe("ledger");
    expect(s.nDailyMarks).toBe(3); // Thu, Fri, Mon — weekend never becomes a mark
    expect(s.returns.map(r => r.dateKey)).toEqual(["2026-01-09", "2026-01-12"]);
    expect(s.returns[1].ret).toBeCloseTo(0.02, 10); // Fri→Mon, grid-adjacent
    expect(s.gaps).toHaveLength(0);
    expect(s.zeroReturnCount).toBe(0);
  });

  test("nextGridDay: trading grid skips weekends, calendar grid does not", () => {
    expect(nextGridDay("2026-01-09", true)).toBe("2026-01-12");  // Fri → Mon
    expect(nextGridDay("2026-01-09", false)).toBe("2026-01-10"); // Fri → Sat
    expect(nextGridDay("2026-01-06", true)).toBe("2026-01-07");
  });
});

describe("shadow sleeve vs broken pipeline vs empty series", () => {
  test("shadow + fresh snapshots → mode=shadow, seriesFresh, status ok (idle by design, NOT broken)", () => {
    makeTestDb();
    const gov = new SleeveGovernor();
    gov.setMode("momentum_stocks", "shadow", "test demotion");
    const now = et("2026-01-13", 12);
    rawSnap("momentum_stocks", 50_000, et("2026-01-12", 22), 5);
    rawSnap("momentum_stocks", 50_000, now - 10 * 60_000, 5); // snapshot loop still writing
    const s = getDailySleeveReturns("momentum_stocks", { now });
    expect(s.mode).toBe("shadow");
    expect(s.modeSince).not.toBeNull();
    expect(s.seriesFresh).toBe(true);
    expect(s.status).toBe("ok");
  });

  test("no snapshots for hours → status stale (the measurement pipeline itself is down)", () => {
    makeTestDb();
    const now = et("2026-01-13", 12);
    rawSnap("momentum_crypto", 5_000, now - 3 * 3_600_000, 5);
    const s = getDailySleeveReturns("momentum_crypto", { now });
    expect(s.seriesFresh).toBe(false);
    expect(s.status).toBe("stale");
    expect(s.mode).toBeNull(); // no sleeve_modes row — ungoverned, honestly unknown
  });

  test("empty series → status no_data (a third, distinct state)", () => {
    makeTestDb();
    const s = getDailySleeveReturns("momentum_btc", { now: et("2026-01-13", 12) });
    expect(s.status).toBe("no_data");
    expect(s.nObservations).toBe(0);
    expect(s.lastSnapshotAt).toBeNull();
  });
});
