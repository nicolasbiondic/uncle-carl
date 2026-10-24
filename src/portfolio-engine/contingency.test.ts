import { describe, expect, test } from "bun:test";
import { decide, type CoreMemory } from "./decide";
import { applyRegimeOverlay, decideRegime, overlaySymbols, selectPitUniverse, type RegimeMemory } from "./contingency";
import { covarianceFromPrices, portfolioVol } from "./construction";
import type { BookState, DailyBar, PriceView, RegimeOverlayConfig, VolManagedConfig } from "./types";

const date = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
function view(data: Record<string, number[]>, asOf = date(Math.max(...Object.values(data).map(v => v.length)) - 1), volumes: Record<string, number> = {}): PriceView {
  return { asOf, barCount: s => data[s]?.filter((_, i) => date(i) <= asOf).length ?? 0,
    history: (s, n) => (data[s] ?? []).map((close, i): DailyBar => ({ date: date(i), open: close, high: close, low: close, close, volume: volumes[s] ?? 1 }))
      .filter(b => b.date <= asOf).slice(-n) };
}
const base: VolManagedConfig = { kind: "volManaged", universe: ["A"], inceptionGuardBars: 4, volLookback: 3, covLookback: 3,
  portfolioVolTarget: 0.25, annualization: 252, perAssetCap: 1, maxGross: 2 };
const overlay: RegimeOverlayConfig = { signals: [{ kind: "maTrend", symbol: "REF", period: 3, sampling: "daily" }], combine: "any", coreScale: 0.25 };
const book: BookState = { equity: 10_000, positions: [], memory: {} };
const state = (riskOff: boolean): RegimeMemory => ({ session: date(0), riskOff, signalOff: [riskOff], pending: 0, switched: false, ready: true });
const tape = { A: [100, 102, 101, 103, 102, 105], REF: [100, 99, 98, 97, 96, 95],
  D: [100, 100.5, 100.2, 100.7, 100.6, 101], E: [100, 100.2, 100.1, 100.4, 100.2, 100.5],
  BIL: [100, 100.01, 100.02, 100.03, 100.04, 100.05], SH: [100, 98, 99, 97, 98, 95] };

describe("regime price signals", () => {
  test("MA band retains each signal's state; K confirmations reset on reversal and advance once per session", () => {
    const c: RegimeOverlayConfig = { ...overlay, confirmationDecisions: 2, signals: [{ kind: "maTrend", symbol: "REF", period: 3, sampling: "daily", bandPct: 1 }] };
    const low = view({ REF: [100, 100, 95, 94] }, date(2));
    const first = decideRegime(low, c, state(false));
    expect(first).toMatchObject({ riskOff: false, pending: 1, signalOff: [true] });
    expect(decideRegime(low, c, first)).toBe(first);
    const second = decideRegime(view({ REF: [100, 100, 95, 94] }), c, first);
    expect(second).toMatchObject({ riskOff: true, pending: 0, switched: true });
    const inBand = view({ REF: [100, 100, 100, 100, 100.2] });
    expect(decideRegime(inBand, c, second).riskOff).toBe(true);
    expect(decideRegime(inBand, c, state(false)).riskOff).toBe(false);
    const reversed = decideRegime(view({ REF: [100, 100, 95, 110] }), c, first);
    expect(reversed).toMatchObject({ riskOff: false, pending: 0 });
    expect(() => decideRegime(low, c, second)).toThrow("chronological");
    // Missing input breaks the consecutive-evidence streak; it never votes risk-on.
    expect(decideRegime(view({ REF: [100] }, date(5)), c, first)).toMatchObject({ riskOff: false, pending: 0, ready: false });
    expect(decideRegime(view({ REF: [] }, date(5)), c)).toMatchObject({ riskOff: true, ready: false });
  });

  test("month-end SMA uses completed calendar months, not an in-progress close; execution calendar handles holidays", () => {
    const data = Array.from({ length: 92 }, (_, i) => i < 31 ? 100 : i < 60 ? 120 : 1);
    const c: RegimeOverlayConfig = { ...overlay, signals: [{ kind: "maTrend", symbol: "REF", period: 2, sampling: "monthEnd" }] };
    // March's collapse is not February's close. Feb 29 = synthetic last session, execution Mar 2.
    expect(decideRegime(view({ REF: data }, "2020-02-29"), c, undefined, "2020-03-02").riskOff).toBe(false);
    expect(decideRegime(view({ REF: data }, "2020-03-15"), c).riskOff).toBe(false);
    expect(decideRegime(view({ REF: data }, "2020-03-31"), c, undefined, "2020-04-01").riskOff).toBe(true);
    expect(decideRegime(view({ REF: data }, "2020-03-31"), c).riskOff).toBe(false);
  });

  test("absolute momentum compares adjusted total-return ratios on identical dates", () => {
    const c: RegimeOverlayConfig = { ...overlay, signals: [{ kind: "absMomentum", symbol: "REF", cashProxy: "BIL", lookback: 3 }] };
    expect(decideRegime(view({ REF: [100, 101, 102, 103], BIL: [100, 102, 103, 104] }), c).riskOff).toBe(true);
    expect(decideRegime(view({ REF: [100, 101, 102, 105], BIL: [100, 102, 103, 104] }), c).riskOff).toBe(false);
    const v = view({ REF: [100, 101, 102, 105], BIL: [100, 102, 103, 104] });
    expect(decideRegime({ ...v, history: (s, n) => v.history(s, n).filter(b => s !== "BIL" || b.date !== date(1)) }, c).ready).toBe(false);
  });

  test("Keller 13612W, canary at least k, and any/all/count combinations", () => {
    const canary = { kind: "canary" as const, assets: ["BAD", "GOOD"], horizons: [21, 63, 126, 252], coefficients: [12, 4, 2, 1] };
    const v = view({ BAD: Array.from({ length: 253 }, (_, i) => 500 - i), GOOD: Array.from({ length: 253 }, (_, i) => 100 + i) });
    expect(decideRegime(v, { ...overlay, signals: [canary] }).riskOff).toBe(true);
    expect(decideRegime(v, { ...overlay, signals: [{ ...canary, negativeCount: 2 }] }).riskOff).toBe(false);
    const signals = [canary, { ...canary, assets: ["GOOD"] }];
    expect(decideRegime(v, { ...overlay, signals, combine: "any" }).riskOff).toBe(true);
    expect(decideRegime(v, { ...overlay, signals, combine: "all" }).riskOff).toBe(false);
    expect(decideRegime(v, { ...overlay, signals, combine: 1 }).riskOff).toBe(true);
    expect(decideRegime(v, { ...overlay, signals, combine: 2 }).riskOff).toBe(false);
  });

  test("future bars cannot affect any signal; a violating provider is rejected before reading the future close", () => {
    const c: VolManagedConfig = { ...base, regimeOverlay: { ...overlay, signals: [...overlay.signals,
      { kind: "absMomentum", symbol: "REF", cashProxy: "BIL", lookback: 3 },
      { kind: "canary", assets: ["REF"], horizons: [1, 3], coefficients: [3, 1] }] } };
    const a = decide({ view: view(tape, date(4)), config: c, book });
    const futureTape = Object.fromEntries(Object.entries(tape).map(([s, x]) => [s, [...x.slice(0, 5), 1e9, 1]]));
    expect(JSON.stringify(decide({ view: view(futureTape, date(4)), config: c, book }))).toBe(JSON.stringify(a));
    const v = view(tape, date(4));
    const future: DailyBar = { date: date(5), open: 1, high: 1, low: 1, volume: 1, get close(): number { throw new Error("future close read"); } };
    expect(() => decide({ view: { ...v, history: (s, n) => s === "REF" ? [...v.history(s, n), future] : v.history(s, n) }, config: c, book })).toThrow("point-in-time");
  });
});

describe("regime actions and risk ordering", () => {
  test("scale-only keeps released cash, never relevered by the target; risk-on has no action", () => {
    const v = view(tape), c = { ...base, regimeOverlay: overlay };
    const off = applyRegimeOverlay(v, c, { A: 0.5 }, true, 1);
    expect(off.weights).toEqual({ A: 0.125 });
    expect(applyRegimeOverlay(v, c, { A: 0.5 }, false, 1).weights).toEqual({ A: 0.5 });
    const cold = decide({ view: v, config: c, book });
    expect((cold.memory.portfolioCore as CoreMemory).regime!.riskOff).toBe(true);
  });

  test("freed weight is positive-momentum inverse vol, including additive overlap with the core", () => {
    const v = view(tape), c: VolManagedConfig = { ...base, regimeOverlay: { ...overlay, coreScale: 0.5,
      defensive: { assets: ["D", "E", "REF"], momentumLookback: 3, volLookback: 3, cashProxy: "BIL" } } };
    const r = applyRegimeOverlay(v, c, { A: 0.5 }, true, 1);
    expect(r.weights.A).toBe(0.25);
    expect(r.weights.D + r.weights.E).toBeCloseTo(0.25, 12);
    expect(r.weights.REF).toBeUndefined(); expect(r.weights.BIL).toBeUndefined();
    const dv = Math.sqrt(covarianceFromPrices(v, ["D", "E"], 3).D.D), ev = Math.sqrt(covarianceFromPrices(v, ["D", "E"], 3).E.E);
    expect(r.weights.D / r.weights.E).toBeCloseTo(ev / dv, 12);
    const overlap = applyRegimeOverlay(v, { ...c, regimeOverlay: { ...c.regimeOverlay!, defensive: { ...c.regimeOverlay!.defensive!, assets: ["A"] } } }, { A: 0.5 }, true, 1);
    expect(overlap.weights).toEqual({ A: 0.5 });
  });

  test("a gap inside one allocated history is not fatal: the covariance keeps the shared intervals, as the core does", () => {
    const n = 30, wave = (k: number, amp: number) => Array.from({ length: n }, (_, i) => 100 + amp * Math.sin(i * k) + i * 0.1);
    const v0 = view({ A: wave(0.7, 2), D: wave(1.3, 1), BIL: Array.from({ length: n }, (_, i) => 100 + i * 0.01), REF: wave(0.4, 3) });
    const gappy: PriceView = { ...v0, history: (s, k) => s === "D" ? v0.history(s, k + 1).filter(b => b.date !== date(n - 6)).slice(-k) : v0.history(s, k) };
    const c: VolManagedConfig = { ...base, volLookback: 5, covLookback: 10, regimeOverlay: { ...overlay, coreScale: 0,
      defensive: { assets: ["BIL"], momentumLookback: 5, volLookback: 5, cashProxy: "BIL" } } };
    const r = applyRegimeOverlay(gappy, c, { A: 0.5, D: 0.5 }, false, 0.25);
    expect(r.covariance).toEqual(covarianceFromPrices(gappy, ["A", "D"], 10));
    expect(Object.keys(r.weights).sort()).toEqual(["A", "D"]);
    expect(Object.values(r.weights).every(w => Number.isFinite(w) && w > 0)).toBe(true);
  });

  test("no qualifying defense → cash proxy; long hedge is h × PRE-overlay core gross", () => {
    const v = view(tape), c: VolManagedConfig = { ...base, regimeOverlay: { ...overlay, coreScale: 0,
      defensive: { assets: ["REF"], momentumLookback: 3, volLookback: 3, cashProxy: "BIL" }, hedge: { symbol: "SH", fraction: 0.2 } } };
    expect(applyRegimeOverlay(v, c, { A: 0.5 }, true, 1).weights).toEqual({ BIL: 0.5, SH: 0.1 });
    expect(overlaySymbols(c.regimeOverlay!, false)).toEqual(["BIL", "REF", "SH"]);
    expect(() => applyRegimeOverlay(view({ ...tape, BIL: [] }), c, { A: 0.5 }, true, 1)).toThrow("fresh covariance history");
    // Constant cash has no estimable volatility, but must stay cash, not be scaled to zero/infinity.
    expect(applyRegimeOverlay(view({ ...tape, BIL: tape.BIL.map(() => 100) }), { ...c, regimeOverlay: { ...c.regimeOverlay!, hedge: undefined } }, { A: 0.5 }, true, 1).weights).toEqual({ BIL: 0.5 });
  });

  test("vol ceiling, per-name and gross caps include defense/hedge and clipping never leaves risk above target", () => {
    const v = view(tape), c: VolManagedConfig = { ...base, perAssetCap: 0.15, maxGross: 0.2,
      regimeOverlay: { ...overlay, coreScale: 1, hedge: { symbol: "SH", fraction: 0.9 } } };
    const r = applyRegimeOverlay(v, c, { A: 1 }, true, 0.01);
    expect(Math.max(...Object.values(r.weights))).toBeLessThanOrEqual(0.15);
    expect(Object.values(r.weights).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(0.2 + 1e-12);
    expect(portfolioVol(r.weights, r.covariance, 252)).toBeLessThanOrEqual(0.01 + 1e-12);
  });

  test("opaque JSON memory, post-fill/retry idempotence and default-off identity", () => {
    const config = { ...base, regimeOverlay: { ...overlay, confirmationDecisions: 3 } };
    const first = decide({ view: view(tape), config, book, executionSession: date(6) });
    const memory = JSON.parse(JSON.stringify(first.memory));
    const second = decide({ view: view(tape), config, book: { ...book, memory, positions: [{ symbol: "A", qty: 2, avgEntryPrice: 105 }] }, executionSession: date(6) });
    expect(second).toEqual(first);
    const plain = decide({ view: view(tape), config: base, book });
    expect(JSON.stringify(decide({ view: view(tape), config: { ...base, regimeOverlay: undefined, pitUniverse: undefined }, book }))).toBe(JSON.stringify(plain));
    expect(plain.memory.portfolioCore).not.toHaveProperty("regime");
    expect(plain.memory.portfolioCore).not.toHaveProperty("pit");
  });
});

describe("PIT liquidity universe", () => {
  const config: VolManagedConfig = { ...base, universe: ["ETF"], pitUniverse: { topN: 1, liquidityLookback: 3, minHoldingRebalances: 2, exclude: ["EX"] } };
  const data = { A: tape.A, B: tape.A, ETF: tape.A, EX: tape.A, FUTURE: tape.A, NEW: [100] };
  test("top N by trailing dollar volume, fixed ETFs, deterministic ties, exclusion, inception and no future members", () => {
    const membership = { members: (d: string) => { expect(d).toBe(date(4)); return ["B", "A", "EX", "ETF", "NEW"]; } };
    const v = view(data, date(3), { EX: 1e9, FUTURE: 1e9, ETF: 1e9 });
    expect(selectPitUniverse(v, membership, config, undefined, date(4)).ages).toEqual({ A: 1 });
    const t = decide({ view: v, membership, config, book, executionSession: date(4) });
    expect(Object.keys(t.weights)).toEqual(["A", "ETF"]);
    expect(() => decide({ view: v, config, book })).toThrow("membership");
  });

  test("min M rebalances includes entry; duplicate calls do not age, exit from membership overrides tenure", () => {
    const membership = { members: () => ["A", "B"] };
    const first = selectPitUniverse(view(data, date(3), { A: 2 }), membership, config);
    expect(first.ages).toEqual({ A: 1 });
    expect(selectPitUniverse(view(data, date(3), { B: 100 }), membership, config, first)).toBe(first);
    const second = selectPitUniverse(view(data, date(4), { B: 100 }), membership, config, first);
    expect(second.ages).toEqual({ A: 2 });
    expect(selectPitUniverse(view(data, date(5), { B: 100 }), membership, config, second).ages).toEqual({ B: 1 });
    expect(selectPitUniverse(view(data, date(4)), { members: () => ["B"] }, config, first).ages).toEqual({ B: 1 });
    expect(selectPitUniverse(view({ ...data, A: [100] }, date(4)), membership, config, first).ages).toEqual({ B: 1 });
    expect(() => selectPitUniverse(view(data, date(3)), membership, config, second)).toThrow("chronological");
  });
});
