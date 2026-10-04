/**
 * Pure comparison layer of scripts/warmup-sensitivity.ts (Freqtrade
 * recursive-analysis pattern): synthetic convergent vs divergent decision
 * snapshots — no DB, no replays.
 */

import { describe, expect, test } from "bun:test";
import { findDivergence, snapshotFromResult, type DecisionSnapshot } from "./warmup-sensitivity";

const D = (date: string) => Date.parse(`${date}T14:30:00Z`);

function snap(label: string, over: Partial<DecisionSnapshot> = {}): DecisionSnapshot {
  return {
    label,
    warmupDays: 45,
    dailyReturns: [
      { date: "2025-01-02", ret: 0.01 },
      { date: "2025-01-03", ret: -0.004 },
      { date: "2025-01-06", ret: 0.002 },
    ],
    closedTrades: [
      { symbol: "BTC/USD", side: "buy", pnl: 120, entryAt: D("2025-01-02"), exitAt: D("2025-01-03"), qty: 0.1 },
      { symbol: "ETH/USD", side: "buy", pnl: -40, entryAt: D("2025-01-03"), exitAt: D("2025-01-06"), qty: 1.5 },
    ],
    ...over,
  };
}

describe("findDivergence", () => {
  test("identical snapshots converge (null)", () => {
    expect(findDivergence(snap("1x"), snap("2x"))).toBeNull();
  });

  test("tiny float noise within eps still converges", () => {
    const v = snap("2x");
    v.dailyReturns = v.dailyReturns.map(d => ({ ...d, ret: d.ret + 1e-15 }));
    expect(findDivergence(snap("1x"), v)).toBeNull();
  });

  test("a diverging daily return reports the first date", () => {
    const v = snap("2x");
    v.dailyReturns = [
      { date: "2025-01-02", ret: 0.01 },
      { date: "2025-01-03", ret: -0.0041 }, // diverges here
      { date: "2025-01-06", ret: 0.005 },
    ];
    const d = findDivergence(snap("1x"), v)!;
    expect(d.kind).toBe("dailyReturn");
    expect(d.date).toBe("2025-01-03");
  });

  test("a diverging entry reports the trade's symbol and date", () => {
    const v = snap("2x");
    v.closedTrades = [
      { symbol: "BTC/USD", side: "buy", pnl: 120, entryAt: D("2025-01-02"), exitAt: D("2025-01-03"), qty: 0.1 },
      { symbol: "SOL/USD", side: "buy", pnl: -40, entryAt: D("2025-01-03"), exitAt: D("2025-01-06"), qty: 1.5 }, // different symbol entered
    ];
    const d = findDivergence(snap("1x"), v)!;
    expect(d.kind).toBe("trade");
    expect(d.date).toBe("2025-01-03");
    expect(d.symbol).toBe("ETH/USD");
  });

  test("an extra trade in one variant reports the unmatched trade", () => {
    const v = snap("2x");
    v.closedTrades = [
      ...v.closedTrades,
      { symbol: "XRP/USD", side: "buy", pnl: 5, entryAt: D("2025-01-06"), exitAt: D("2025-01-07"), qty: 10 },
    ];
    const d = findDivergence(snap("1x"), v)!;
    expect(d.kind).toBe("trade");
    expect(d.symbol).toBe("XRP/USD");
    expect(d.date).toBe("2025-01-06");
  });

  test("a diverging exit instant (same entry) is a trade divergence", () => {
    const v = snap("2x");
    v.closedTrades = snap("x").closedTrades.map((t, i) => i === 0 ? { ...t, exitAt: D("2025-01-06"), pnl: 200 } : t);
    const d = findDivergence(snap("1x"), v)!;
    expect(d.kind).toBe("trade");
    expect(d.symbol).toBe("BTC/USD");
    expect(d.date).toBe("2025-01-02");
  });

  test("the EARLIEST divergence across channels wins", () => {
    const v = snap("2x");
    // Trade diverges on 01-03 (ETH qty), daily return on 01-02.
    v.closedTrades = v.closedTrades.map((t, i) => i === 1 ? { ...t, qty: 2.0 } : t);
    v.dailyReturns = v.dailyReturns.map((d, i) => i === 0 ? { ...d, ret: 0.02 } : d);
    const d = findDivergence(snap("1x"), v)!;
    expect(d.date).toBe("2025-01-02");
    expect(d.kind).toBe("dailyReturn");
  });

  test("snapshotFromResult carries the replay's decision streams verbatim", () => {
    const r: any = {
      dailyReturns: [{ date: "2025-01-02", ret: 0.01 }],
      closedTrades: [{ symbol: "SPY", side: "buy", pnl: 10, exitAt: D("2025-01-02") }],
    };
    const s = snapshotFromResult("1x", 420, r);
    expect(s.dailyReturns).toBe(r.dailyReturns);
    expect(s.closedTrades).toBe(r.closedTrades);
    expect(s.warmupDays).toBe(420);
  });
});
