// RSI2 audit (2026-09): rsi2 was mislabeled "Wilder-style" but is actually
// Cutler (2-bar SIMPLE averages, no memory) — with n=2, ANY pair of down
// closes ties to EXACTLY 0, so most real-universe candidates tie and the
// stable `cands.sort` resolves ties by MEANREV_UNIVERSE iteration order.
// This file tests the OPT-IN fix: rsi2Wilder (the actual Wilder recursion)
// + MeanRevEngineConfig.rsiMethod/deterministicTieBreak. Default engine
// behavior (both fields unset) MUST stay byte-identical — see
// scripts/regression-fingerprint.test.ts's meanrev fingerprint, untouched
// by this file.
import { describe, expect, test } from "bun:test";
import { MeanRevEngine, rsi2, rsi2Wilder, type MeanRevLogger } from "./MeanRevEngine";
import { MEANREV_ANCHOR as ANCHOR, daily, flatThen, FakeAdapter } from "../../test-support/meanrev";
import { makeTestDb } from "../../test-support/db";

const silent: MeanRevLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeEngine(adapter: FakeAdapter, universe: string[], extra: any = {}) {
  return new MeanRevEngine(
    { accountId: adapter.accountId, universe, baseUsd: 50_000, ...extra },
    adapter,
    silent,
    { isTradingDay: () => true, now: () => ANCHOR },
  );
}

makeTestDb();

describe("rsi2Wilder — pure math", () => {
  test("converges toward the full-history value as the seed's influence decays by 0.5/bar (n=2)", () => {
    // Deterministic synthetic series (no RNG dependency) with plenty of
    // up/down moves — the convergence property is a fact about the
    // recursion's decay, independent of the series' actual shape.
    const full: number[] = [];
    for (let k = 0; k < 1000; k++) {
      full.push(100 + 15 * Math.sin(k * 0.31) + 5 * Math.sin(k * 1.7) + 0.01 * k);
    }
    const truncated = full.slice(-201); // last 201 points == original indices 799..999
    const a = rsi2Wilder(full, 999);
    const b = rsi2Wilder(truncated, 200); // same underlying closes, fresh (wrong) seed
    expect(Math.abs(a - b)).toBeLessThan(1e-9);
  });

  test("discriminant case [100,110,109,108]: Cutler ties to exactly 0, Wilder does not", () => {
    const closes = [100, 110, 109, 108];
    const i = 3;
    expect(rsi2(closes, i)).toBe(0); // Cutler: last two closes are both down → ties to 0
    const wilder = rsi2Wilder(closes, i);
    expect(wilder).toBeGreaterThan(0);
    // Hand-computed (n=2): seed over Δ1=+10,Δ2=-1 → avgG=5, avgL=0.5; one
    // recursive step for Δ3=-1 → avgG=2.5, avgL=0.75; RSI=100·2.5/3.25.
    expect(Number(wilder.toFixed(6))).toBe(76.923077);
  });
});

describe("MeanRevEngine — rsiMethod (opt-in)", () => {
  test("default (rsiMethod unset) is unchanged: Cutler still ties to 0", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("BUY", daily(flatThen(100, [150, 150, 148, 146])));
    const engine = makeEngine(adapter, ["BUY"]);

    const report = await engine.runDaily();

    expect(report.opens[0]?.rsi).toBe(0);
    expect(adapter.opened.map((o) => o.symbol)).toEqual(["BUY"]);
  });

  test('rsiMethod: "wilder" plumbs into the entry ranking and can produce a non-tied, non-entering value', async () => {
    // Big up-move (100→...→120→118 after 205 flat bars) followed by a small
    // two-day dip: Cutler sees only the LAST two closes (148→146, both
    // down) → 0 < 5 (entry). Wilder's recursion carries the prior +20 move
    // forward (0.5 decay/bar) and lands well above entryRsi=5 → no entry.
    const closes = flatThen(100, [120, 118, 150, 148, 146]);
    const adapter = new FakeAdapter();
    adapter.setCandles("BUY", daily(closes));
    const expectedWilderRsi = rsi2Wilder(closes, closes.length - 1);
    expect(expectedWilderRsi).toBeGreaterThan(5); // sanity: this scenario really does diverge

    const cutlerEngine = makeEngine(adapter, ["BUY"]);
    const cutlerReport = await cutlerEngine.runDaily();
    expect(cutlerReport.opens[0]?.rsi).toBe(0);
    expect(cutlerReport.opens[0]?.ok).toBe(true);

    const adapter2 = new FakeAdapter();
    adapter2.setCandles("BUY", daily(closes));
    const wilderEngine = makeEngine(adapter2, ["BUY"], { rsiMethod: "wilder" });
    const wilderReport = await wilderEngine.runDaily();
    expect(wilderReport.opens.length).toBe(0); // RSI(2)_wilder >= entryRsi(5) → no candidate at all
    expect(adapter2.opened).toEqual([]);
  });
});

describe("MeanRevEngine — deterministicTieBreak (opt-in)", () => {
  // 5 symbols, all Cutler-tied at RSI2=0 (two down closes each), differing
  // only in how far the second close drops — giving the deterministic
  // tie-break a real (2-day return) axis to sort on.
  const drops: Record<string, number> = { B1: 140, B2: 141, B3: 142, B4: 143, B5: 144 };

  function setupAdapter(): FakeAdapter {
    const adapter = new FakeAdapter();
    for (const [sym, x] of Object.entries(drops)) {
      adapter.setCandles(sym, daily(flatThen(100, [150, 148, x])));
    }
    return adapter;
  }

  const permutations: string[][] = [
    ["B1", "B2", "B3", "B4", "B5"],
    ["B5", "B4", "B3", "B2", "B1"],
    ["B3", "B1", "B5", "B2", "B4"],
  ];

  test("true: candidate SET selected is invariant to universe order", async () => {
    const selections: string[][] = [];
    for (const universe of permutations) {
      const adapter = setupAdapter();
      const engine = makeEngine(adapter, universe, { maxPositions: 3, deterministicTieBreak: true });
      await engine.runDaily();
      selections.push(adapter.opened.map((o) => o.symbol).sort());
    }
    // Smallest x = most negative 2-day return = sorted first under the
    // deterministic tie-break, regardless of universe iteration order.
    expect(selections[0]).toEqual(["B1", "B2", "B3"]);
    expect(selections[1]).toEqual(selections[0]);
    expect(selections[2]).toEqual(selections[0]);
  });

  test("false (default): the SAME candidate pool, only reordered, selects a DIFFERENT portfolio — the bug the opt-in fixes", async () => {
    const selections: string[][] = [];
    for (const universe of permutations) {
      const adapter = setupAdapter();
      const engine = makeEngine(adapter, universe, { maxPositions: 3 }); // deterministicTieBreak unset
      await engine.runDaily();
      selections.push(adapter.opened.map((o) => o.symbol).sort());
    }
    // Stable sort on a rsi-only tie preserves universe iteration order, so
    // "the first 3 slots" tracks universe position, not any strategy signal.
    expect(selections[0]).toEqual(["B1", "B2", "B3"]);
    expect(selections[1]).toEqual(["B3", "B4", "B5"]);
    expect(selections[2]).toEqual(["B1", "B3", "B5"]);
    const distinct = new Set(selections.map((s) => s.join(",")));
    expect(distinct.size).toBe(3); // all three permutations disagree
  });
});
