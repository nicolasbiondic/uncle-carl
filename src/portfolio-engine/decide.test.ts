import { expect, test } from "bun:test";
import { decide, type CoreMemory, type DailyBar, type PriceView, type XassetTrendConfig, type FactorCoreConfig, type BookState } from "./index";
import type { VolManagedConfig } from "./types";

/** No real prices: deterministic alternating growth on a synthetic calendar. */
function synthetic(symbols: readonly string[], asOf = "2020-01-30", lengths: Record<string, number> = {}): PriceView & { calls: { n: number; s: string }[] } {
  const calls: { n: number; s: string }[] = [];
  return { asOf, calls, barCount: s => lengths[s] ?? (symbols.includes(s) ? 30 : 0), history: (s, n) => {
    calls.push({ n, s });
    let price = 100;
    return Array.from({ length: lengths[s] ?? (symbols.includes(s) ? 30 : 0) }, (_, i): DailyBar => {
      price *= i % 2 ? 1.015 : 0.999;
      const date = new Date(Date.parse(`${asOf}T00:00:00Z`) - (29 - i) * 86_400_000).toISOString().slice(0, 10);
      // A PriceView has no explicit date argument: its endpoint is always asOf.
      if (date > asOf) throw new Error("look-ahead request");
      return { date, open: price, close: price, high: price, low: price, volume: 100 };
    }).slice(-n);
  } };
}
const config: XassetTrendConfig = { kind: "xassetTrend", universe: ["A", "B"], inceptionGuardBars: 10,
  blendHorizons: [3, 5, 9], maLong: 5, signalBandPct: 0, volLookback: 5, covLookback: 5,
  portfolioVolTarget: 0.12, perAssetCap: 1, maxGross: 1.8 };
const book: BookState = { equity: 5000, positions: [], memory: {} };
const core: FactorCoreConfig = { kind: "factorCore", exclude: [], topN: 2, score: "momentum+lowvol", momentumWindow: [10, 2],
  volWindow: 10, weightVolLookback: 5, perNameCap: 0.6, minPrice: 5, minPriorCloses: 10, overlay: null };

test("D1 dispatch, inception, no stops and known target vol", () => {
  const target = decide({ view: synthetic(["A", "B"], undefined, { B: 5 }), config, book });
  expect(Object.keys(target.weights)).toEqual(["A"]);
  expect(target.diagnostics.finalVol).toBeCloseTo(0.12, 10);
  expect(target.stops).toEqual([]);
  expect((target.memory.portfolioCore as CoreMemory).signals).toEqual({ A: true, B: false });
});

test("D3 annualizes at 365 and fixed stops use current actual holdings", () => {
  const input = { view: synthetic(["A", "B"]), config, book };
  const stocks = decide(input);
  const crypto = decide({ ...input, config: { ...config, kind: "cryptoTrend", perAssetCap: 0.6, maxGross: 2, stop: { mode: "fixed", pct: 4 } },
    book: { ...book, positions: [{ symbol: "A", qty: 1, avgEntryPrice: 100 }] } });
  expect(crypto.weights.A / stocks.weights.A).toBeCloseTo(Math.sqrt(252 / 365), 10);
  expect(crypto.stops).toEqual([{ symbol: "A", stopPrice: 96 }]);
  expect(crypto.diagnostics.finalVol).toBeCloseTo(0.12, 10);
});

test("signal and overlay hysteresis travel through memory, not holdings", () => {
  const input = { view: synthetic(["A", "B"]), config, book };
  const first = decide(input);
  const second = decide({ ...input, config: { ...config, signalBandPct: 100 }, book: { ...book, memory: first.memory } });
  expect(second.weights).toEqual(first.weights);
  expect(decide({ ...input, config: { ...config, signalBandPct: 100 } }).weights).toEqual({});
});

test("D2 reconstitutes at first observed session of month, not every day", () => {
  const first = decide({ view: synthetic(["A", "B", "C"]), config: core, book, membership: { members: () => ["A", "B"] } });
  expect(first.diagnostics.reconstituted).toBe(true);
  const second = decide({ view: synthetic(["A", "B", "C"], "2020-01-31"), config: core, book: { ...book, memory: first.memory },
    membership: { members: () => { throw new Error("membership scanned outside reconstitution"); } } });
  expect(second.diagnostics.reconstituted).toBe(false);
  expect(Object.keys(second.weights)).toEqual(["A", "B"]);
  const nextMonth = decide({ view: synthetic(["A", "B", "C"], "2020-02-03"), config: core,
    book: { ...book, memory: second.memory }, membership: { members: () => ["B", "C"] } });
  expect(nextMonth.diagnostics.reconstituted).toBe(true);
  expect(Object.keys(nextMonth.weights)).toEqual(["B", "C"]);
  expect(Object.values(nextMonth.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  expect(() => decide({ view: synthetic(["A"]), config: core, book })).toThrow("membership");
});

test("executionSession uses prior closes and membership effective at first-session open", () => {
  const january = decide({ view: synthetic(["A", "B", "C"], "2020-01-30"), config: core, book,
    executionSession: "2020-01-31", membership: { members: () => ["A", "B"] } });
  const firstSession = decide({ view: synthetic(["A", "B", "C"], "2020-01-31"), config: core,
    executionSession: "2020-02-03", book: { ...book, memory: january.memory },
    membership: { members: date => { expect(date).toBe("2020-02-03"); return ["B", "C"]; } } });
  expect(firstSession.asOf).toBe("2020-01-31");
  expect(firstSession.diagnostics.reconstituted).toBe(true);
  expect(Object.keys(firstSession.weights)).toEqual(["B", "C"]);
  const secondSession = decide({ view: synthetic(["A", "B", "C"], "2020-02-03"), config: core,
    executionSession: "2020-02-04", book: { ...book, memory: firstSession.memory },
    membership: { members: () => { throw new Error("must not reconstitute twice"); } } });
  expect(secondSession.diagnostics.reconstituted).toBe(false);
  expect(() => decide({ view: synthetic(["A"]), config: core, book, executionSession: "2020-01-30" })).toThrow("must follow");
});

test("D2 overlay on→in-band→off, recomputes daily vols only for selected names", () => {
  const universe = Array.from({ length: 500 }, (_, i) => `S${i}`);
  const v = synthetic([...universe, "SPY"]);
  const overlay = { ref: "SPY", ma: 5, bandPct: 1, onExposure: 1, offExposure: 0.5 };
  const c = { ...core, overlay, topN: 50, perNameCap: 0.04 };
  const first = decide({ view: v, config: c, book, membership: { members: () => universe } });
  expect((first.memory.portfolioCore as CoreMemory).overlayOn).toBe(true);
  const flat: PriceView = { ...v, history: (s, n) => v.history(s, n).map(b => s === "SPY" ? { ...b, close: 100 } : b) };
  v.calls.length = 0;
  const second = decide({ view: flat, config: c, book: { ...book, memory: first.memory } });
  expect(v.calls).toHaveLength(51);
  expect((second.memory.portfolioCore as CoreMemory).overlayOn).toBe(true);
  expect(Object.values(second.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  const declining: PriceView = { ...v, history: (s, n) => v.history(s, n).map((b, i) => s === "SPY" ? { ...b, close: 100 - i * 5 } : b) };
  const third = decide({ view: declining, config: c, book: { ...book, memory: second.memory } });
  expect((third.memory.portfolioCore as CoreMemory).overlayOn).toBe(false);
  expect(Object.values(third.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(0.5, 12);
});

test("stop-out permits next-decision reentry with no cooldown", () => {
  const c = { ...config, kind: "cryptoTrend" as const, stop: { mode: "fixed" as const, pct: 4 } };
  const first = decide({ view: synthetic(["A", "B"]), config: c, book: { ...book, positions: [{ symbol: "A", qty: 1, avgEntryPrice: 100 }] } });
  const afterStop = decide({ view: synthetic(["A", "B"]), config: c, book: { ...book, memory: first.memory } });
  expect(afterStop.weights.A).toBeGreaterThan(0);
  expect(afterStop.stops).toEqual([]);
  expect((afterStop.memory.portfolioCore as CoreMemory).stops).toEqual({});
});

test("post-fill decision refreshes stops through opaque memory on the SAME view", () => {
  const c = { ...config, kind: "cryptoTrend" as const,
    stop: { mode: "volScaled" as const, kSigma: 3, lookbackBars: 5, minPct: 2, maxPct: 12 } };
  const view = synthetic(["A", "B"]);
  const planned = decide({ view, config: c, book, executionSession: "2020-01-31" });
  expect(planned.stops).toEqual([]);
  const afterFill = decide({ view, config: c, executionSession: "2020-01-31",
    book: { ...book, memory: planned.memory, positions: [{ symbol: "A", qty: 1, avgEntryPrice: 150 }] } });
  expect(afterFill.weights).toEqual(planned.weights);
  const distance = (afterFill.memory.portfolioCore as CoreMemory).stops.A.distance;
  expect(afterFill.stops).toEqual([{ symbol: "A", stopPrice: 150 * (1 - distance) }]);
  expect(distance).toBeGreaterThan(0.02);
  expect(distance).toBeLessThan(0.12);
});

test("preregistered horizons, annualization and risk caps on 300 synthetic closes", () => {
  const data: DailyBar[] = [];
  let close = 100;
  for (let i = 0; i < 300; i++) {
    close *= i % 2 ? 1.006 : 0.998;
    data.push({ date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      open: close, high: close, low: close, close, volume: 1 });
  }
  const view: PriceView = { asOf: data[299].date, barCount: () => 300, history: (_s, n) => data.slice(-n) };
  const d1 = decide({ view, book, config: { ...config, universe: Array.from({ length: 18 }, (_, i) => `ETF${i}`),
    inceptionGuardBars: 252, blendHorizons: [63, 126, 252], maLong: 200, volLookback: 63, covLookback: 63 } });
  expect(Object.values(d1.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1.8);
  expect(Math.max(...Object.values(d1.weights))).toBeLessThanOrEqual(1);
  const d3 = decide({ view, book, config: { ...config, kind: "cryptoTrend", universe: ["BTC", "ETH", "SOL", "XRP", "DOGE"],
    inceptionGuardBars: 252, blendHorizons: [63, 126, 252], maLong: 200, volLookback: 30, covLookback: 30,
    portfolioVolTarget: 0.35, perAssetCap: 0.6, maxGross: 2, stop: { mode: "none" } } });
  expect(Object.values(d3.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(2);
  expect(Math.max(...Object.values(d3.weights))).toBeLessThanOrEqual(0.6);
  const d2 = decide({ view, book, membership: { members: () => Array.from({ length: 500 }, (_, i) => `STOCK${i}`) },
    config: { ...core, momentumWindow: [252, 21], volWindow: 252, weightVolLookback: 63, minPriorCloses: 252,
      topN: 50, perNameCap: 0.04, overlay: { ref: "SPY", ma: 200, bandPct: 1, onExposure: 1, offExposure: 0.5 } } });
  expect(Object.keys(d2.weights)).toHaveLength(50);
  expect(Object.values(d2.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  expect(Math.max(...Object.values(d2.weights))).toBeLessThanOrEqual(0.04);
});

test("deterministic, JSON-roundtrippable, no mutation, no look-ahead", () => {
  const memory = Object.freeze({ unrelated: "preserved" });
  const input = { view: synthetic(["A", "B"]), config: Object.freeze({ ...config }), book: Object.freeze({ ...book, memory }) };
  const before = JSON.stringify(input.book);
  const a = decide(input), b = decide(input);
  expect(a).toEqual(b);
  expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  expect(JSON.stringify(input.book)).toBe(before);
  expect(a.memory.unrelated).toBe("preserved");
  Object.freeze((a.memory.portfolioCore as CoreMemory).signals);
  Object.freeze(a.memory.portfolioCore);
  Object.freeze(a.memory);
  expect(() => decide({ ...input, book: { ...book, memory: a.memory } })).not.toThrow();
  // A violating provider is rejected rather than silently introducing look-ahead.
  const badView: PriceView = { ...input.view, history: (s, n) => input.view.history(s, n).map(b => ({ ...b, date: "2099-01-01" })) };
  expect(() => decide({ ...input, view: badView })).toThrow("point-in-time");
});

const managed: VolManagedConfig = { kind: "volManaged", universe: ["B", "A", "NEW"], inceptionGuardBars: 5,
  volLookback: 4, covLookback: 4, portfolioVolTarget: 0.1, annualization: 252, perAssetCap: 1, maxGross: 2 };

/** Four aligned, zero-mean returns: B = 2A, with sample Var(A) = 4×.01²/3. */
function managedView(): PriceView {
  const asOf = "2024-01-05";
  const bars = (scale: number) => {
    let close = 100;
    return [0, 0.01, -0.01, 0.01, -0.01].map((ret, i): DailyBar => {
      close *= 1 + scale * ret;
      const date = `2024-01-0${i + 1}`;
      if (date > asOf) throw new Error("read after asOf");
      return { date, open: close, high: close, low: close, close, volume: 1 };
    });
  };
  return { asOf, barCount: s => s === "NEW" ? 4 : 5, history: (s, n) => {
    if (s === "NEW") throw new Error("inception guard must skip history");
    return bars(s === "A" ? 1 : 2).slice(-n);
  } };
}

test("RW2 inception, inverse-vol normalization and known covariance target at 252/365", () => {
  for (const annualization of [252, 365] as const) {
    const target = decide({ view: managedView(), book, config: { ...managed, annualization } });
    expect(Object.keys(target.weights)).toEqual(["A", "B"]);
    const gross = target.weights.A + target.weights.B;
    expect(target.weights.A / gross).toBeCloseTo(2 / 3, 12);
    expect(target.weights.B / gross).toBeCloseTo(1 / 3, 12);
    // Independent w'Σw with Σ = Var(A) × [[1,2],[2,4]].
    const vol = Math.sqrt(annualization * (4 * 0.01 ** 2 / 3)) * (target.weights.A + 2 * target.weights.B);
    expect(vol).toBeCloseTo(managed.portfolioVolTarget, 12);
    expect(target.diagnostics.finalVol).toBeCloseTo(vol, 12);
    expect(target.stops).toEqual([]);
  }
  const a = decide({ view: managedView(), book, config: managed });
  const b = decide({ view: managedView(), book, config: { ...managed, annualization: 365 } });
  expect(b.weights.A / a.weights.A).toBeCloseTo(Math.sqrt(252 / 365), 12);
});

test("RW2 caps clip then reduce gross proportionally; no stops or decision memory", () => {
  const view = managedView();
  const cap = decide({ view, book, config: { ...managed, portfolioVolTarget: 2, perAssetCap: 0.25, maxGross: 2 } });
  expect(cap.weights).toEqual({ A: 0.25, B: 0.25 });
  const cfg = { ...managed, portfolioVolTarget: 2, perAssetCap: 0.25, maxGross: 0.3 };
  const a = decide({ view, book, config: cfg });
  expect(Object.values(a.weights).reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(0.3);
  expect(a.weights.A).toBeCloseTo(0.15, 12);
  const prior = { unrelated: 7, portfolioCore: { version: 1, signals: { A: false, B: false }, stops: { A: { distance: 0.04 } } } };
  const frozenBook = Object.freeze({ ...book, memory: Object.freeze(prior), positions: [{ symbol: "A", qty: 10, avgEntryPrice: 100 }] });
  const before = JSON.stringify(frozenBook);
  const b = decide({ view, book: frozenBook, config: cfg });
  expect(b.weights).toEqual(a.weights);
  expect(b.stops).toEqual([]);
  expect(b.memory.unrelated).toBe(7);
  expect((b.memory.portfolioCore as CoreMemory).signals).toEqual({});
  expect((b.memory.portfolioCore as CoreMemory).stops).toEqual({});
  expect(JSON.stringify(frozenBook)).toBe(before);
  expect(decide({ view, book: frozenBook, config: cfg })).toEqual(b);
  expect(decide({ view, book: { ...book, memory: b.memory }, config: cfg }).weights).toEqual(a.weights);
});

test("RW2 deterministic point-in-time view never reads after asOf; future bars are rejected", () => {
  const view = managedView();
  let futureReads = 0;
  const future: DailyBar = { date: "2024-01-06", open: 1, high: 1, low: 1, volume: 1,
    get close(): number { futureReads++; throw new Error("read after asOf"); } };
  const guarded: PriceView = { ...view, history: (s, n) => [...view.history(s, 5), future].filter(b => b.date <= view.asOf).slice(-n) };
  const input = { view: guarded, book, config: managed, executionSession: "2024-01-06" };
  expect(decide(input)).toEqual(decide(input));
  expect(futureReads).toBe(0);
  expect(() => decide({ ...input, view: { ...view, history: (s, n) => [...view.history(s, n - 1), future] } })).toThrow(/point-in-time/);
  expect(futureReads).toBe(0);
});
