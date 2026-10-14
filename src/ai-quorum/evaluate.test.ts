import { describe, expect, test } from "bun:test";
import { evaluate, loadEvalSnapshots, type EvalSnapshot } from "./evaluate";
import { insertModelViews, insertQuorumPositions, insertSnapshot } from "./db";
import { memQuorumDb } from "./testFixtures";
import type { Snapshot } from "./types";

const dkey = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

/** One stocks session: quorum long A; universe A (winner) + B (loser). */
function session(i: number, entryA: number, exitA: number): EvalSnapshot {
  return {
    dateKey: dkey(i),
    assetClass: "stocks",
    symbols: ["A", "B"],
    ret21: { A: -0.10, B: 0.10 }, // mom21 benchmark: short A, long B — both lose
    viewsByModel: {
      m1: { A: { view: "long", confidence: 0.9 }, B: { view: "neutral", confidence: 0.5 } },
      m2: { A: { view: "long", confidence: 0.7 }, B: { view: "short", confidence: 0.4 } },
    },
    quorum: [{ symbol: "A", direction: 1, meanConfidence: 0.8 }],
    fills: { A: { entryPx: entryA, exitPx: exitA }, B: { entryPx: 100, exitPx: 99 } },
  };
}

describe("evaluate — series math", () => {
  test("book return = equal-weight positions net of 2bps/side; hit counted gross", () => {
    const ev = evaluate([session(0, 100, 101), session(1, 100, 100.5)], Date.parse("2026-01-10"));
    expect(ev.book.curve.map((p) => p.ret)).toEqual([
      expect.closeTo(0.01 - 0.0004, 10),
      expect.closeTo(0.005 - 0.0004, 10),
    ]);
    expect(ev.book.hitRate).toBe(1);
    expect(ev.book.nPositions).toBe(2);
    expect(ev.book.nDays).toBe(2);
  });

  test("benchmarks share symbols, days and costs", () => {
    const ev = evaluate([session(0, 100, 101)], Date.parse("2026-01-10"));
    // EW long: mean of A (+1%) and B (−1%) minus 4bps each → −0.04%.
    expect(ev.benchEwLong.curve[0].ret).toBeCloseTo((0.01 - 0.0004 + (-0.01 - 0.0004)) / 2, 10);
    // mom21: short A (−1% gross), long B (−1% gross), both minus costs.
    expect(ev.benchMom21.curve[0].ret).toBeCloseTo((-0.01 - 0.0004 + (-0.01 - 0.0004)) / 2, 10);
    expect(ev.benchMom21.hitRate).toBe(0);
  });

  test("per-model books: non-neutral views with confidence ≥ 0.6 only", () => {
    const ev = evaluate([session(0, 100, 101)], Date.parse("2026-01-10"));
    // m1: only A qualifies (B neutral). m2: A long 0.7 qualifies, B short 0.4 doesn't.
    expect(ev.models.m1.nPositions).toBe(1);
    expect(ev.models.m2.nPositions).toBe(1);
    expect(ev.models.m1.curve[0].ret).toBeCloseTo(0.0096, 10);
  });

  test("a session with views but zero quorum positions is a flat 0 day for the book", () => {
    const s = session(0, 100, 101);
    s.quorum = [];
    const ev = evaluate([s], Date.parse("2026-01-10"));
    expect(ev.book.curve[0].ret).toBe(0);
    expect(ev.book.nDays).toBe(1);
  });

  test("sessions without model views (pending mode) don't enter any series", () => {
    const s = session(0, 100, 101);
    s.viewsByModel = {};
    const ev = evaluate([s], Date.parse("2026-01-10"));
    expect(ev.sessionsWithViews).toBe(0);
    expect(ev.book.nDays).toBe(0);
    expect(ev.firstViewsDate).toBeNull();
    expect(ev.verdictDate).toBeNull();
  });
});

describe("evaluate — §12-D verdict (pre-registered)", () => {
  const fortySessions = () =>
    Array.from({ length: 40 }, (_, i) => session(i, 100, i % 2 === 0 ? 101 : 100.6));

  test("verdict date = first views + 8 weeks; null before it", () => {
    const ev = evaluate(fortySessions(), Date.parse("2026-02-01"));
    expect(ev.firstViewsDate).toBe("2026-01-01");
    expect(ev.verdictDate).toBe("2026-02-26");
    expect(ev.verdict).toBeNull();
  });

  test("VALIDADO: book Sharpe ≥ 1 and above both benchmarks, at date with ≥40 sessions", () => {
    const ev = evaluate(fortySessions(), Date.parse("2026-02-26"));
    expect(ev.sessionsWithViews).toBe(40);
    expect(ev.book.sharpe!).toBeGreaterThan(1);
    expect(ev.book.sharpe!).toBeGreaterThan(ev.benchEwLong.sharpe ?? -Infinity);
    expect(ev.verdict).toBe("VALIDADO");
  });

  test("REFUTADO when the book loses money even past the date", () => {
    const losing = Array.from({ length: 40 }, (_, i) => session(i, 100, i % 2 === 0 ? 99 : 99.4));
    const ev = evaluate(losing, Date.parse("2026-02-26"));
    expect(ev.verdict).toBe("REFUTADO");
  });

  test("no verdict with fewer than 40 sessions even after the date", () => {
    const few = Array.from({ length: 10 }, (_, i) => session(i, 100, 101));
    const ev = evaluate(few, Date.parse("2026-12-31"));
    expect(ev.verdict).toBeNull();
  });
});

describe("loadEvalSnapshots — db round trip", () => {
  test("payload, views, quorum and complete fills are reassembled", () => {
    const qdb = memQuorumDb();
    const snap: Snapshot = {
      assetClass: "stocks", dateKey: "2026-10-08", decidedAt: Date.UTC(2026, 9, 8, 21, 15),
      symbols: [
        { symbol: "SPY", ret1: 0, ret5: 0, ret21: 0.05, ret63: 0, vol20: 0.01, rsi14: 55, distMA50: 0.01, distMA200: 0.02, funding: null, lastClose: 500, lastBarTs: 1 },
        { symbol: "QQQ", ret1: 0, ret5: 0, ret21: null, ret63: 0, vol20: 0.01, rsi14: 55, distMA50: 0.01, distMA200: 0.02, funding: null, lastClose: 400, lastBarTs: 1 },
      ],
      headlines: [],
    };
    const id = insertSnapshot(qdb, snap, "ok");
    insertModelViews(qdb, id, "m1", { SPY: { view: "long", confidence: 0.8 }, QQQ: { view: "neutral", confidence: 0.2 } });
    insertQuorumPositions(qdb, id, [{ symbol: "SPY", direction: 1, meanConfidence: 0.8 }]);
    qdb.query("INSERT INTO fills (snapshot_id, symbol, entry_ts, entry_px, exit_ts, exit_px) VALUES (?, 'SPY', 1, 500, 2, 505)").run(id);
    qdb.query("INSERT INTO fills (snapshot_id, symbol, entry_ts, entry_px, exit_ts, exit_px) VALUES (?, 'QQQ', 1, 400, NULL, NULL)").run(id);

    const [loaded] = loadEvalSnapshots(qdb);
    expect(loaded.symbols).toEqual(["SPY", "QQQ"]);
    expect(loaded.ret21).toEqual({ SPY: 0.05, QQQ: null });
    expect(loaded.viewsByModel.m1.SPY.view).toBe("long");
    expect(loaded.quorum).toEqual([{ symbol: "SPY", direction: 1, meanConfidence: 0.8 }]);
    expect(loaded.fills).toEqual({ SPY: { entryPx: 500, exitPx: 505 } }); // incomplete QQQ fill excluded
  });
});
