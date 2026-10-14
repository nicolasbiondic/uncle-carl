import { describe, expect, test } from "bun:test";
import { computeFill, fillPendingFills, grossReturn, netReturn } from "./book";
import { getSnapshot, insertSnapshot } from "./db";
import { cryptoDay, insertDailyBar, memHistoricalDb, memQuorumDb, stockDay } from "./testFixtures";
import type { Snapshot } from "./types";

describe("computeFill — entry at first open AFTER the decision, exit one bar later", () => {
  const bars = [
    { ts: stockDay(2026, 10, 7), open: 100 },
    { ts: stockDay(2026, 10, 8), open: 102 },
    { ts: stockDay(2026, 10, 9), open: 105 },
  ];
  test("decision at 21:15 UTC on the 7th fills at the 8th's open, exits at the 9th's", () => {
    const decidedAt = Date.UTC(2026, 9, 7, 21, 15);
    expect(computeFill(bars, decidedAt)).toEqual({
      entryTs: stockDay(2026, 10, 8), entryPx: 102,
      exitTs: stockDay(2026, 10, 9), exitPx: 105,
    });
  });
  test("a bar stamped exactly at the decision is NOT used (strictly after)", () => {
    const f = computeFill(bars, stockDay(2026, 10, 8));
    expect(f.entryPx).toBe(105);
    expect(f.exitPx).toBeNull();
  });
  test("no bars yet → all legs null (pending fill)", () => {
    expect(computeFill([], 0)).toEqual({ entryTs: null, entryPx: null, exitTs: null, exitPx: null });
  });
});

describe("return math — §12-D costs", () => {
  test("stocks pay 2 bps per side (4 bps round trip)", () => {
    // long, +1% gross → net = 1% − 0.04% = 0.96%
    expect(netReturn(1, 100, 101, "stocks")).toBeCloseTo(0.0096, 10);
  });
  test("crypto pays 9 bps per side (18 bps round trip)", () => {
    expect(netReturn(1, 100, 101, "crypto")).toBeCloseTo(0.01 - 0.0018, 10);
  });
  test("short direction flips the gross sign, costs still subtract", () => {
    expect(grossReturn(-1, 100, 99)).toBeCloseTo(0.01, 10);
    expect(netReturn(-1, 100, 99, "stocks")).toBeCloseTo(0.0096, 10);
  });
});

describe("fillPendingFills — lazy, idempotent, read-only on historical", () => {
  function makeSnapshot(qdb: ReturnType<typeof memQuorumDb>, decidedAt: number): number {
    const snap: Snapshot = {
      assetClass: "crypto", dateKey: "2026-10-08", decidedAt,
      symbols: [{
        symbol: "BTC/USD", ret1: 0, ret5: 0, ret21: 0.1, ret63: 0, vol20: 0.01, rsi14: 50,
        distMA50: 0, distMA200: 0, funding: 0, lastClose: 100, lastBarTs: decidedAt - 1,
      }],
      headlines: [],
    };
    return insertSnapshot(qdb, snap, "ok");
  }

  test("fills appear as bars arrive, legs are never re-priced", () => {
    const qdb = memQuorumDb();
    const hist = memHistoricalDb();
    const decidedAt = Date.UTC(2026, 9, 8, 0, 15); // crypto decision 00:15 UTC
    const id = makeSnapshot(qdb, decidedAt);

    // No bars after the decision yet → placeholder row, no prices.
    fillPendingFills(qdb, hist, Date.now());
    let row = qdb.query<any, [number]>("SELECT * FROM fills WHERE snapshot_id = ?").get(id);
    expect(row.entry_px).toBeNull();

    // The 9th's bar lands (open 200) → entry priced, exit still pending.
    insertDailyBar(hist, "BTC/USD", cryptoDay(2026, 10, 9), 200);
    fillPendingFills(qdb, hist, Date.now());
    row = qdb.query<any, [number]>("SELECT * FROM fills WHERE snapshot_id = ?").get(id);
    expect(row.entry_px).toBe(200);
    expect(row.exit_px).toBeNull();

    // The 10th's bar lands (open 210) → exit priced; entry unchanged.
    insertDailyBar(hist, "BTC/USD", cryptoDay(2026, 10, 10), 210);
    fillPendingFills(qdb, hist, Date.now());
    row = qdb.query<any, [number]>("SELECT * FROM fills WHERE snapshot_id = ?").get(id);
    expect(row.entry_px).toBe(200);
    expect(row.exit_px).toBe(210);

    // Re-running changes nothing (idempotent) even if earlier bars mutate.
    insertDailyBar(hist, "BTC/USD", cryptoDay(2026, 10, 9), 999);
    fillPendingFills(qdb, hist, Date.now());
    row = qdb.query<any, [number]>("SELECT * FROM fills WHERE snapshot_id = ?").get(id);
    expect(row.entry_px).toBe(200);
  });

  test("bars after `now` are not used (no peeking)", () => {
    const qdb = memQuorumDb();
    const hist = memHistoricalDb();
    const decidedAt = Date.UTC(2026, 9, 8, 0, 15);
    const id = makeSnapshot(qdb, decidedAt);
    insertDailyBar(hist, "BTC/USD", cryptoDay(2026, 10, 9), 200);
    insertDailyBar(hist, "BTC/USD", cryptoDay(2026, 10, 10), 210);
    fillPendingFills(qdb, hist, cryptoDay(2026, 10, 9) + 1000); // only the 9th exists "now"
    const row = qdb.query<any, [number]>("SELECT * FROM fills WHERE snapshot_id = ?").get(id);
    expect(row.entry_px).toBe(200);
    expect(row.exit_px).toBeNull();
  });

  test("getSnapshot sees what insertSnapshot wrote (idempotence key)", () => {
    const qdb = memQuorumDb();
    makeSnapshot(qdb, Date.UTC(2026, 9, 8, 0, 15));
    expect(getSnapshot(qdb, "crypto", "2026-10-08")).not.toBeNull();
    expect(getSnapshot(qdb, "crypto", "2026-10-09")).toBeNull();
  });
});
