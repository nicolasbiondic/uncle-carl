// RW4b (docs/reports/RW-reescritura-rentable.md §14): the two optional volManaged knobs —
// a drawdown brake on the target vol and a faster portfolio-vol estimate for the scale.
// Synthetic bars only: no database, no real data.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decide, drawdownBrakeScale, rebaseDrawdownMemory, type CoreMemory, type DailyBar, type PriceView } from "./index";
import type { BookState, DrawdownBrakeConfig, VolManagedConfig } from "./types";

/** Calendar-day dates ending at `asOf`; closes follow the given per-symbol daily returns (oldest first). */
function viewOf(returnsBySymbol: Record<string, readonly number[]>, asOf = "2024-03-01"): PriceView {
  const bars = (symbol: string): DailyBar[] => {
    const rets = returnsBySymbol[symbol] ?? [];
    let close = 100;
    const out: DailyBar[] = [{ date: shift(asOf, -rets.length), open: close, high: close, low: close, close, volume: 1 }];
    rets.forEach((r, i) => {
      close *= 1 + r;
      out.push({ date: shift(asOf, -(rets.length - 1 - i)), open: close, high: close, low: close, close, volume: 1 });
    });
    return out;
  };
  return {
    asOf,
    barCount: s => (returnsBySymbol[s] ? returnsBySymbol[s].length + 1 : 0),
    history: (s, n) => bars(s).slice(-n),
  };
}
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Deterministic pseudo-noise in [-1, 1]. */
const noise = (i: number, seed: number) => Math.sin(i * 12.9898 + seed * 78.233) * 0.5 + Math.cos(i * 4.1414 + seed) * 0.5;
const series = (n: number, seed: number, amp: number, tail?: { days: number; amp: number }) =>
  Array.from({ length: n }, (_, i) => noise(i, seed) * (tail && i >= n - tail.days ? tail.amp : amp));

const base: VolManagedConfig = {
  kind: "volManaged", universe: ["A", "B", "C"], inceptionGuardBars: 30, volLookback: 40, covLookback: 21,
  portfolioVolTarget: 0.03, annualization: 252, perAssetCap: 1, maxGross: 2,
};
const brake: DrawdownBrakeConfig = { startDrawdown: 0.05, maxDrawdown: 0.25, floorScale: 0.25 };
const calm = () => viewOf({ A: series(60, 1, 0.01), B: series(60, 2, 0.012), C: series(60, 3, 0.008) });
const bookAt = (equity: number, memory: BookState["memory"] = {}): BookState => ({ equity, positions: [], memory });
const gross = (w: Readonly<Record<string, number>>) => Object.values(w).reduce((a, b) => a + b, 0);

describe("drawdownBrakeScale", () => {
  test("1 up to the start, linear to the floor at the max, flat beyond, monotone and continuous", () => {
    expect(drawdownBrakeScale(0, brake)).toBe(1);
    expect(drawdownBrakeScale(0.05, brake)).toBe(1);
    expect(drawdownBrakeScale(0.15, brake)).toBeCloseTo(0.625, 12); // halfway: (1 + 0.25) / 2
    expect(drawdownBrakeScale(0.25, brake)).toBe(0.25);
    expect(drawdownBrakeScale(0.6, brake)).toBe(0.25);
    expect(drawdownBrakeScale(1, brake)).toBe(0.25);
    let previous = 1;
    for (let dd = 0; dd <= 0.4; dd += 0.005) {
      const s = drawdownBrakeScale(dd, brake);
      expect(s).toBeLessThanOrEqual(previous + 1e-12);
      expect(previous - s).toBeLessThan(0.05); // no jump
      previous = s;
    }
    expect(drawdownBrakeScale(0.1, { startDrawdown: 0, maxDrawdown: 1, floorScale: 1 })).toBe(1);
  });
});

describe("volManaged drawdown brake", () => {
  test("the target vol falls with the drawdown, is restored as it recovers, and the peak only ratchets up", () => {
    const cfg: VolManagedConfig = { ...base, drawdownBrake: brake };
    let memory: BookState["memory"] = {};
    const step = (equity: number) => {
      const t = decide({ view: calm(), book: bookAt(equity, memory), config: cfg });
      memory = t.memory;
      return t;
    };
    const reference = decide({ view: calm(), book: bookAt(100), config: base }); // no brake
    expect(gross(reference.weights)).toBeLessThan(base.maxGross); // the cap does not bind: the scale is linear
    const a = step(100);   // first decision: peak = 100, drawdown 0
    expect(a.weights).toEqual(reference.weights);
    expect(a.diagnostics.drawdown).toBe(0);
    expect(a.diagnostics.brakeScale).toBe(1);
    const down = step(85); // drawdown 15 % → halfway
    expect(down.diagnostics.brakeScale).toBeCloseTo(0.625, 12);
    expect(down.diagnostics.effectiveVolTarget).toBeCloseTo(0.03 * 0.625, 12);
    for (const s of Object.keys(reference.weights)) expect(down.weights[s] / reference.weights[s]).toBeCloseTo(0.625, 10);
    expect(down.diagnostics.finalVol as number).toBeCloseTo(0.03 * 0.625, 10);
    const floor = step(60); // drawdown 40 % → floor
    expect(floor.diagnostics.brakeScale).toBe(0.25);
    expect(gross(floor.weights) / gross(reference.weights)).toBeCloseTo(0.25, 10);
    const better = step(80); // recovering: drawdown 20 % → 0.625 → 0.4375
    expect(better.diagnostics.brakeScale).toBeCloseTo(0.4375, 12);
    expect(gross(better.weights)).toBeGreaterThan(gross(floor.weights));
    const lowerEquityAgain = step(70);
    expect(lowerEquityAgain.diagnostics.peakEquity).toBe(100); // the peak never falls
    const full = step(98); // drawdown 2 % ≤ start → fully restored
    expect(full.weights).toEqual(reference.weights);
    const newPeak = step(120);
    expect(newPeak.diagnostics.peakEquity).toBe(120);
    expect((newPeak.memory.portfolioCore as CoreMemory).peakEquity).toBe(120);
    expect(step(114).diagnostics.drawdown).toBeCloseTo(0.05, 12);
  });

  test("the brake acts on the vol target: a binding maxGross is not loosened by it", () => {
    const cfg: VolManagedConfig = { ...base, portfolioVolTarget: 2, maxGross: 0.5, drawdownBrake: brake };
    const full = decide({ view: calm(), book: bookAt(100), config: cfg });
    expect(gross(full.weights)).toBeCloseTo(0.5, 12);
    // Mild brake (drawdown 6 % → scale 0.9625) still leaves the (huge) target above the cap: gross stays at the cap.
    const mild = decide({ view: calm(), book: bookAt(94, { portfolioCore: { version: 1, signals: {}, stops: {}, peakEquity: 100 } }), config: cfg });
    expect(mild.diagnostics.brakeScale).toBeCloseTo(0.9625, 10);
    expect(gross(mild.weights)).toBeCloseTo(0.5, 12);
  });

  test("no look-ahead: a decision depends only on the equities seen up to it", () => {
    const cfg: VolManagedConfig = { ...base, drawdownBrake: brake };
    const run = (equities: number[]) => {
      let memory: BookState["memory"] = {};
      return equities.map(e => {
        const t = decide({ view: calm(), book: bookAt(e, memory), config: cfg });
        memory = t.memory;
        return JSON.stringify(t);
      });
    };
    const a = run([100, 90, 80, 95, 130, 60]);
    const b = run([100, 90, 80, 95, 100, 200]);
    expect(a.slice(0, 4)).toEqual(b.slice(0, 4));
    expect(a[4]).not.toEqual(b[4]);
    // The view stays point-in-time: bars after asOf are never requested.
    const guarded: PriceView = { ...calm(), history: (s, n) => {
      const bars = calm().history(s, n);
      if (bars.some(x => x.date > "2024-03-01")) throw new Error("read after asOf");
      return bars;
    } };
    expect(() => decide({ view: guarded, book: bookAt(100), config: { ...cfg, fastVolLookback: 5 } })).not.toThrow();
  });

  test("invalid equities never produce a bigger book: NaN is ignored, equity ≤ 0 brakes to the floor", () => {
    const cfg: VolManagedConfig = { ...base, drawdownBrake: brake };
    const memory = { portfolioCore: { version: 1, signals: {}, stops: {}, peakEquity: 100 } };
    expect(decide({ view: calm(), book: bookAt(Number.NaN, memory), config: cfg }).diagnostics.brakeScale).toBe(1);
    expect(decide({ view: calm(), book: bookAt(0, memory), config: cfg }).diagnostics.brakeScale).toBe(0.25);
    expect((decide({ view: calm(), book: bookAt(Number.NaN, memory), config: cfg }).memory.portfolioCore as CoreMemory).peakEquity).toBe(100);
  });

  test("rebaseDrawdownMemory keeps the drawdown across a fold restart and is a no-op without a brake", () => {
    const memory = { other: 1, portfolioCore: { version: 1 as const, signals: {}, stops: {}, peakEquity: 120_000 } };
    // The fold ended at 90 000 after liquidation (last mark 91 000); the next fold starts at 50 000.
    const next = rebaseDrawdownMemory(memory, 91_000, 90_000, 50_000);
    expect(next.other).toBe(1);
    const peak = (next.portfolioCore as CoreMemory).peakEquity!;
    expect(1 - 50_000 / peak).toBeCloseTo(1 - 90_000 / 120_000, 12);
    // A last mark above the stored peak counts as the peak.
    expect((rebaseDrawdownMemory(memory, 130_000, 125_000, 50_000).portfolioCore as CoreMemory).peakEquity).toBeCloseTo(130_000 * 50_000 / 125_000, 8);
    const plain = { portfolioCore: { version: 1 as const, signals: {}, stops: {} } };
    expect(rebaseDrawdownMemory(plain, 1, 1, 2)).toBe(plain);
    expect(rebaseDrawdownMemory({}, 1, 1, 2)).toEqual({});
    expect(rebaseDrawdownMemory(memory, 1, 0, 2)).toBe(memory);
  });
});

describe("volManaged fast vol estimate", () => {
  const crashing = () => viewOf({
    A: series(60, 1, 0.005, { days: 5, amp: 0.05 }), B: series(60, 2, 0.006, { days: 5, amp: 0.05 }), C: series(60, 3, 0.004, { days: 5, amp: 0.05 }),
  });
  const fastCfg: VolManagedConfig = { ...base, fastVolLookback: 5 };

  test("a late vol spike: the scale uses the max of the 5-day and 21-day estimates, so leverage drops at once", () => {
    const slow = decide({ view: crashing(), book: bookAt(100), config: base });
    const fast = decide({ view: crashing(), book: bookAt(100), config: fastCfg });
    expect(fast.diagnostics.fastVol as number).toBeGreaterThan(fast.diagnostics.slowVol as number);
    expect(fast.diagnostics.uncappedVol).toBe(fast.diagnostics.fastVol);
    // Same base weights, the scale shrinks by slowVol / fastVol.
    const ratio = (fast.diagnostics.slowVol as number) / (fast.diagnostics.fastVol as number);
    expect(ratio).toBeLessThan(0.7);
    for (const s of Object.keys(slow.weights)) expect(fast.weights[s] / slow.weights[s]).toBeCloseTo(ratio, 10);
    // The no-fast result is the usual one: the 21-day covariance only.
    expect(slow.diagnostics.slowVol).toBeUndefined();
    expect(slow.diagnostics.uncappedVol).toBeCloseTo(fast.diagnostics.slowVol as number, 12);
  });

  test("a calm tail after a volatile month: max keeps the 21-day estimate, nothing changes", () => {
    const view = viewOf({
      A: [...series(40, 1, 0.03), ...series(20, 11, 0.002)], B: [...series(40, 2, 0.03), ...series(20, 12, 0.002)], C: [...series(40, 3, 0.03), ...series(20, 13, 0.002)],
    });
    // 21-day window: 1 volatile + 20 calm sessions would hide the old turbulence; the fast window is calmer still.
    const slow = decide({ view, book: bookAt(100), config: base });
    const fast = decide({ view, book: bookAt(100), config: fastCfg });
    expect(fast.diagnostics.fastVol as number).toBeLessThanOrEqual(fast.diagnostics.slowVol as number);
    expect(fast.weights).toEqual(slow.weights);
  });

  test("inverse-vol shape is untouched (the fast window only scales), and the brake composes with it", () => {
    const slow = decide({ view: crashing(), book: bookAt(100), config: base });
    const fast = decide({ view: crashing(), book: bookAt(100), config: fastCfg });
    const shape = (w: Readonly<Record<string, number>>) => Object.fromEntries(Object.entries(w).map(([s, v]) => [s, v / gross(w)]));
    for (const s of Object.keys(slow.weights)) expect(shape(fast.weights)[s]).toBeCloseTo(shape(slow.weights)[s], 12);
    const both = decide({ view: crashing(), book: bookAt(85, { portfolioCore: { version: 1, signals: {}, stops: {}, peakEquity: 100 } }),
      config: { ...fastCfg, drawdownBrake: brake } });
    expect(gross(both.weights) / gross(fast.weights)).toBeCloseTo(0.625, 10);
  });
});

describe("off by default: absent knobs = the exact RW2/RW3 decision", () => {
  const managed: VolManagedConfig = { kind: "volManaged", universe: ["B", "A", "NEW"], inceptionGuardBars: 5, volLookback: 4, covLookback: 4,
    portfolioVolTarget: 0.1, annualization: 252, perAssetCap: 1, maxGross: 2 };
  const managedView = (): PriceView => {
    const asOf = "2024-01-05";
    const bars = (scale: number) => {
      let close = 100;
      return [0, 0.01, -0.01, 0.01, -0.01].map((ret, i): DailyBar => {
        close *= 1 + scale * ret;
        return { date: `2024-01-0${i + 1}`, open: close, high: close, low: close, close, volume: 1 };
      });
    };
    return { asOf, barCount: s => s === "NEW" ? 4 : 5, history: (s, n) => bars(s === "A" ? 1 : 2).slice(-n) };
  };

  test("frozen digest of four volManaged decisions, byte for byte (computed before the knobs existed)", () => {
    const book: BookState = { equity: 5000, positions: [], memory: {} };
    const outs = [managed, { ...managed, annualization: 365 as const }, { ...managed, portfolioVolTarget: 2, perAssetCap: 0.25, maxGross: 0.3 }, { ...managed, portfolioVolTarget: 0.5 }]
      .map(config => decide({ view: managedView(), book, config }));
    expect(createHash("sha256").update(JSON.stringify(outs)).digest("hex")).toBe("06344afa3d97292ff574c03d04eb14af65ecc6f0ea8be7c37358b02894d9ebfd");
  });

  test("no brake: no peak in memory and no brake/fast diagnostics; equity is ignored", () => {
    const a = decide({ view: calm(), book: bookAt(100), config: base });
    const b = decide({ view: calm(), book: bookAt(1), config: base });
    expect(b).toEqual(a);
    expect(Object.keys((a.memory.portfolioCore as CoreMemory))).not.toContain("peakEquity");
    for (const key of ["drawdown", "brakeScale", "peakEquity", "effectiveVolTarget", "fastVol", "slowVol"]) expect(Object.keys(a.diagnostics)).not.toContain(key);
  });

  test("a brake that never binds (start 0.99) and no fast window reproduce the unbraked weights", () => {
    const quiet = decide({ view: calm(), book: bookAt(10), config: { ...base, drawdownBrake: { startDrawdown: 0.99, maxDrawdown: 1, floorScale: 1 } } });
    expect(quiet.weights).toEqual(decide({ view: calm(), book: bookAt(10), config: base }).weights);
  });
});
