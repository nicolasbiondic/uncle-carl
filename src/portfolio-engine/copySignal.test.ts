import { describe, expect, test } from "bun:test";
import { decide, type BookState, type CopySignalConfig, type DailyBar, type DecideInput, type PriceView, type SignalEvent, type SignalView, type TargetBook } from "./index";
import type { CopySignalMemory } from "./copySignal";

// Synthetic data only: no real prices, no real filings.

const DAY = 86_400_000;
const at = (date: string, hhmm = "21:30") => Date.parse(`${date}T${hhmm}:00Z`);
const dateBefore = (asOf: string, days: number) => new Date(Date.parse(asOf) - days * DAY).toISOString().slice(0, 10);

/** Daily bars ending at `lastDate` (default asOf); amp = size of the alternating daily move (= the vol). */
function prices(spec: Record<string, { bars?: number; amp?: number; lastDate?: string }>, asOf: string): PriceView {
  const len = (s: string) => (spec[s] ? spec[s].bars ?? 60 : 0);
  return {
    asOf,
    barCount: len,
    history: (s, n) => {
      const k = Math.min(n, len(s));
      const last = spec[s]?.lastDate ?? asOf;
      const amp = spec[s]?.amp ?? 0.01;
      let price = 100;
      const all = Array.from({ length: len(s) }, (_, i): DailyBar => {
        price *= i % 2 ? 1 + amp : 1 - amp;
        return { date: dateBefore(last, len(s) - 1 - i), open: price, high: price, low: price, close: price, volume: 1000 };
      });
      return all.slice(all.length - k);
    },
  };
}

/** An honest view clips at the cutoff; a leaky one hands back events known AFTER it. */
function signalView(events: SignalEvent[], asOf: string, leaky = false): SignalView {
  const cutoffMs = Date.parse(asOf) + DAY - 1;
  return {
    asOf, cutoffMs,
    events: (source, lookbackDays) => events
      .filter(e => e.source === source && e.knownAtMs > cutoffMs - lookbackDays * DAY && (leaky || e.knownAtMs <= cutoffMs))
      .sort((a, b) => a.knownAtMs - b.knownAtMs),
  };
}

let seq = 0;
function ev(symbol: string, knownDate: string, actors: string[], weight: number, role: string[] = ["officer"], source = "s"): SignalEvent {
  seq++;
  return { source, symbol, knownAtMs: at(knownDate), weight, meta: { actors, role, accession: `a${seq}` } };
}

const base: CopySignalConfig = {
  kind: "copySignal", source: "s", lookbackDays: 10, minDistinctInsiders: 2, minDollar: 50_000, topN: 3, holdDays: 5,
  weighting: "equal", perNameCap: 0.5, maxGross: 0.9, exclude: [],
};
const flat: BookState = { equity: 10_000, positions: [], memory: {} };
const ALL = { AAA: {}, BBB: {}, CCC: {}, DDD: {}, EEE: {} };

function run(asOf: string, events: SignalEvent[], over: Partial<CopySignalConfig> = {}, book: BookState = flat, extra: Partial<DecideInput> = {}, universe: Record<string, { bars?: number; amp?: number; lastDate?: string }> = ALL, leaky = false): TargetBook {
  return decide({ view: prices(universe, asOf), signals: signalView(events, asOf, leaky), book, config: { ...base, ...over }, ...extra });
}
const picksOf = (t: TargetBook) => Object.keys(t.weights).sort();
const mem = (t: TargetBook) => (t.memory.copySignal as CopySignalMemory);

describe("no look-ahead", () => {
  const cluster = (d: string, s = "AAA") => [ev(s, d, ["x"], 40_000), ev(s, d, ["y"], 40_000)];

  test("an event known after asOf is never used, even when the view leaks it", () => {
    const future = cluster("2020-03-03"); // known the day AFTER the decision's asOf
    expect(picksOf(run("2020-03-02", future))).toEqual([]);
    const leaked = run("2020-03-02", future, {}, flat, {}, ALL, true);
    expect(picksOf(leaked)).toEqual([]);
    expect(leaked.diagnostics.eventsSeen).toBe(0);
    // the same cluster IS used once its day is the asOf day
    expect(picksOf(run("2020-03-03", future))).toEqual(["AAA"]);
  });

  test("the decision on day D never changes with events known after D", () => {
    const known = cluster("2020-03-02", "AAA");
    const noise = [...cluster("2020-03-04", "BBB"), ...cluster("2020-03-09", "CCC")];
    const a = run("2020-03-02", known);
    const b = run("2020-03-02", [...known, ...noise], {}, flat, {}, ALL, true);
    expect(b.weights).toEqual(a.weights);
    expect(b.memory).toEqual(a.memory);
    expect(b.diagnostics).toEqual(a.diagnostics);
  });

  test("a view for another asOf, or no view at all, is refused", () => {
    expect(() => decide({ view: prices(ALL, "2020-03-02"), signals: signalView([], "2020-03-03"), book: flat, config: base })).toThrow(/asOf/);
    expect(() => decide({ view: prices(ALL, "2020-03-02"), book: flat, config: base })).toThrow(/SignalView/);
  });
});

describe("selection", () => {
  test("needs the distinct insiders AND the dollars; repeated purchases by one insider are one insider", () => {
    const events = [
      ev("AAA", "2020-03-02", ["x"], 100_000), ev("AAA", "2020-03-02", ["x"], 100_000), // one insider, plenty of dollars
      ev("BBB", "2020-03-02", ["x"], 10_000), ev("BBB", "2020-03-02", ["y"], 10_000), // two insiders, too few dollars
      ev("CCC", "2020-03-02", ["x"], 30_000), ev("CCC", "2020-03-02", ["y"], 30_000), // both
    ];
    const t = run("2020-03-02", events);
    expect(picksOf(t)).toEqual(["CCC"]);
    const c = (t.diagnostics.candidates as Array<{ symbol: string }>).map(x => x.symbol);
    expect(c).toEqual(["CCC"]);
  });

  test("a joint filing counts each owner; an event without actors is one shared unknown actor", () => {
    const joint = [ev("AAA", "2020-03-02", ["x", "y"], 60_000)];
    expect(picksOf(run("2020-03-02", joint))).toEqual(["AAA"]);
    const anon = (s: string, w: number): SignalEvent => ({ source: "s", symbol: s, knownAtMs: at("2020-03-02"), weight: w, meta: {} });
    expect(picksOf(run("2020-03-02", [anon("BBB", 40_000), anon("BBB", 40_000)]))).toEqual([]);
    expect(picksOf(run("2020-03-02", [anon("BBB", 40_000), anon("BBB", 40_000)], { minDistinctInsiders: 1 }))).toEqual(["BBB"]);
  });

  test("rank: more insiders first, then more dollars, then symbol; topN keeps the best", () => {
    const events = [
      ev("EEE", "2020-03-02", ["a", "b", "c"], 60_000),
      ev("DDD", "2020-03-02", ["a", "b"], 900_000),
      ev("CCC", "2020-03-02", ["a", "b"], 200_000),
      ev("BBB", "2020-03-02", ["a", "b"], 200_000),
      ev("AAA", "2020-03-02", ["a", "b"], 100_000),
    ];
    const t = run("2020-03-02", events, { topN: 3 });
    expect(t.diagnostics.added).toEqual(["EEE", "DDD", "BBB"]); // EEE (3 insiders), DDD ($900k), BBB before CCC (equal $: symbol)
    expect(picksOf(t)).toEqual(["BBB", "DDD", "EEE"]);
  });

  test("exclude, role filter and lookback window", () => {
    const events = [
      ev("AAA", "2020-03-02", ["a", "b"], 80_000),
      ev("BBB", "2020-03-02", ["a", "b"], 80_000, ["tenPercentOwner"]),
      ev("CCC", "2020-02-10", ["a", "b"], 80_000), // known 21 days before: outside a 10-day window
    ];
    expect(picksOf(run("2020-03-02", events, { exclude: ["AAA"] }))).toEqual(["BBB"]);
    expect(picksOf(run("2020-03-02", events, { roles: ["officer", "director"] }))).toEqual(["AAA"]);
    expect(picksOf(run("2020-03-02", events, { lookbackDays: 30 }))).toEqual(["AAA", "BBB", "CCC"]);
    expect(picksOf(run("2020-03-02", events))).toEqual(["AAA", "BBB"]);
  });

  test("other sources are ignored", () => {
    expect(picksOf(run("2020-03-02", [ev("AAA", "2020-03-02", ["a", "b"], 80_000, ["officer"], "other")]))).toEqual([]);
  });

  test("membership gates new picks (members at the execution session); untradable names are skipped", () => {
    const events = [ev("AAA", "2020-03-02", ["a", "b"], 80_000), ev("BBB", "2020-03-02", ["a", "b"], 80_000), ev("CCC", "2020-03-02", ["a", "b"], 80_000), ev("DDD", "2020-03-02", ["a", "b"], 80_000)];
    let asked: string | undefined;
    const membership = { members: (d: string) => { asked = d; return ["AAA", "BBB", "CCC"]; } };
    const universe = { AAA: {}, BBB: { bars: 5 }, CCC: { lastDate: "2020-02-01" }, DDD: {} }; // BBB: too little history for 1 bar? no — 5 bars; CCC: stale
    const t = run("2020-03-02", events, {}, flat, { membership, executionSession: "2020-03-03" }, universe);
    expect(asked).toBe("2020-03-03");
    expect(picksOf(t)).toEqual(["AAA", "BBB"]); // CCC stale; DDD not a member
    const noBars = run("2020-03-02", events, {}, flat, {}, { AAA: {} });
    expect(picksOf(noBars)).toEqual(["AAA"]);
  });
});

describe("holding", () => {
  const cluster = (s: string, d: string) => [ev(s, d, ["x"], 40_000), ev(s, d, ["y"], 40_000)];

  /** Walk consecutive days, feeding the memory back, exactly like the replay does. */
  function walk(days: string[], events: SignalEvent[], over: Partial<CopySignalConfig> = {}) {
    let memory: Record<string, unknown> = {};
    const out: Record<string, TargetBook> = {};
    for (const d of days) { out[d] = run(d, events, over, { ...flat, memory }); memory = out[d].memory; }
    return out;
  }
  const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * DAY).toISOString().slice(0, 10));

  test("a pick is held exactly holdDays calendar days and then dropped", () => {
    const w = walk(days("2020-03-02", 8), cluster("AAA", "2020-03-02"), { holdDays: 5, lookbackDays: 3 });
    // selected on asOf 03-02 (executes 03-03); asOf 03-03..03-06 keep it (age 1..4); asOf 03-07 (age 5) drops it
    for (const d of ["2020-03-02", "2020-03-03", "2020-03-04", "2020-03-05", "2020-03-06"]) expect(picksOf(w[d])).toEqual(["AAA"]);
    expect(picksOf(w["2020-03-07"])).toEqual([]);
    expect(w["2020-03-07"].diagnostics.expired).toEqual(["AAA"]);
    expect(mem(w["2020-03-07"]).picks).toEqual({});
  });

  test("the same events are never reused: no re-entry after expiry while they are still inside the lookback", () => {
    const w = walk(days("2020-03-02", 14), cluster("AAA", "2020-03-02"), { holdDays: 3, lookbackDays: 12 });
    expect(picksOf(w["2020-03-04"])).toEqual(["AAA"]);
    for (const d of days("2020-03-05", 10)) expect(picksOf(w[d])).toEqual([]);
  });

  test("a fresh cluster after expiry re-enters; a fresh cluster while held renews the clock", () => {
    const events = [...cluster("AAA", "2020-03-02"), ...cluster("AAA", "2020-03-04")];
    const w = walk(days("2020-03-02", 10), events, { holdDays: 3, lookbackDays: 2 });
    expect(picksOf(w["2020-03-03"])).toEqual(["AAA"]);
    expect(w["2020-03-04"].diagnostics.renewed).toEqual(["AAA"]); // fresh events at day 3 of a hold: renewed
    expect(mem(w["2020-03-04"]).picks.AAA).toBe("2020-03-04");
    expect(picksOf(w["2020-03-06"])).toEqual(["AAA"]); // would have expired on 03-05 without the renewal
    expect(picksOf(w["2020-03-07"])).toEqual([]);
    const later = walk(days("2020-03-02", 12), [...cluster("AAA", "2020-03-02"), ...cluster("AAA", "2020-03-10")], { holdDays: 3, lookbackDays: 2 });
    expect(picksOf(later["2020-03-06"])).toEqual([]);
    expect(later["2020-03-10"].diagnostics.added).toEqual(["AAA"]);
  });

  test("full slots: a qualifying name waits (its events stay unspent) and enters when a slot frees", () => {
    const events = [...cluster("AAA", "2020-03-02"), ...cluster("BBB", "2020-03-02"), ...cluster("CCC", "2020-03-03")];
    const w = walk(days("2020-03-02", 6), events, { topN: 2, holdDays: 3, lookbackDays: 10 });
    expect(picksOf(w["2020-03-03"])).toEqual(["AAA", "BBB"]); // CCC qualifies but no slot
    expect(picksOf(w["2020-03-04"])).toEqual(["AAA", "BBB"]);
    expect(picksOf(w["2020-03-05"])).toEqual(["CCC"]); // AAA/BBB expired on age 3: CCC takes a slot
  });

  test("the memory is JSON-serializable, idempotent for the same decision, and leaves other keys alone", () => {
    const book: BookState = { ...flat, memory: { portfolioCore: { version: 1, signals: { Z: true }, stops: {} }, other: 7 } };
    const first = run("2020-03-02", cluster("AAA", "2020-03-02"), {}, book);
    const persisted = JSON.parse(JSON.stringify(first.memory)) as Record<string, unknown>;
    expect(persisted.other).toBe(7);
    expect(persisted.portfolioCore).toEqual(book.memory.portfolioCore);
    // the post-fill second call (same view, memory from the first) changes nothing
    const second = run("2020-03-02", cluster("AAA", "2020-03-02"), {}, { ...flat, memory: persisted });
    expect(second.weights).toEqual(first.weights);
    expect(mem(second)).toEqual(mem(first));
    expect(first.stops).toEqual([]);
  });
});

describe("weights and caps", () => {
  const two = [ev("AAA", "2020-03-02", ["a", "b"], 80_000), ev("BBB", "2020-03-02", ["a", "b"], 70_000)];

  test("equal: slot = maxGross/topN each, gross = maxGross × picks/topN (the rest is cash)", () => {
    const t = run("2020-03-02", two, { topN: 3, maxGross: 0.9 });
    expect(t.weights.AAA).toBeCloseTo(0.3, 12);
    expect(t.weights.BBB).toBeCloseTo(0.3, 12);
    expect(Object.values(t.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(0.6, 12);
    const full = run("2020-03-02", [...two, ev("CCC", "2020-03-02", ["a", "b"], 60_000)], { topN: 3, maxGross: 0.9 });
    expect(Object.values(full.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(0.9, 12);
  });

  test("perNameCap binds and the excess stays in cash; long-only", () => {
    const t = run("2020-03-02", two, { topN: 2, maxGross: 1.8, perNameCap: 0.25 });
    expect(t.weights.AAA).toBeCloseTo(0.25, 12);
    expect(t.weights.BBB).toBeCloseTo(0.25, 12);
    for (const w of Object.values(t.weights)) expect(w).toBeGreaterThanOrEqual(0);
  });

  test("inverseVol: weights proportional to 1/vol, total = the slot exposure, cap respected", () => {
    const universe = { AAA: { amp: 0.01 }, BBB: { amp: 0.02 } };
    const t = run("2020-03-02", two, { weighting: "inverseVol", volLookback: 20, topN: 2, maxGross: 1, perNameCap: 0.9 }, flat, {}, universe);
    const v = t.diagnostics.vols as Record<string, number>;
    expect(t.weights.AAA / t.weights.BBB).toBeCloseTo(v.BBB / v.AAA, 9);
    expect(t.weights.AAA + t.weights.BBB).toBeCloseTo(1, 9);
    expect(t.weights.AAA).toBeGreaterThan(t.weights.BBB);
    const capped = run("2020-03-02", two, { weighting: "inverseVol", volLookback: 20, topN: 2, maxGross: 1, perNameCap: 0.55 }, flat, {}, universe);
    expect(capped.weights.AAA).toBeCloseTo(0.55, 12);
    expect(capped.weights.BBB).toBeCloseTo(0.45, 9);
  });

  test("inverseVol needs history for the vol lookback; a name without it is not picked", () => {
    const universe = { AAA: { amp: 0.01 }, BBB: { bars: 10, amp: 0.02 } };
    const t = run("2020-03-02", two, { weighting: "inverseVol", volLookback: 20, topN: 2 }, flat, {}, universe);
    expect(picksOf(t)).toEqual(["AAA"]);
  });

  test("a held name that loses its bars is dropped, freeing its slot", () => {
    const first = run("2020-03-02", two, { topN: 2 });
    expect(picksOf(first)).toEqual(["AAA", "BBB"]);
    const next = run("2020-03-03", [], { topN: 2 }, { ...flat, memory: first.memory }, {}, { AAA: {}, BBB: { lastDate: "2020-02-10" } });
    expect(picksOf(next)).toEqual(["AAA"]);
    expect(next.diagnostics.dropped).toEqual(["BBB"]);
  });
});

// ── design A knobs: class, 10b5-1, report lag, per-insider dollars, session holds ────────────────────────

function evm(symbol: string, knownDate: string, actors: string[], weight: number, meta: Record<string, unknown>): SignalEvent {
  seq++;
  return { source: "s", symbol, knownAtMs: at(knownDate), weight, meta: { actors, role: ["officer"], accession: `m${seq}`, ...meta } };
}

describe("event filters", () => {
  const pair = (s: string, over: Record<string, unknown>, w = 40_000) => [evm(s, "2020-03-02", [`${s}1`], w, over), evm(s, "2020-03-02", [`${s}2`], w, over)];

  test("insiderClass: opportunistic keeps opportunistic, routine is the placebo, all/absent keep everything; unclassed events never pass a class filter", () => {
    const events = [...pair("AAA", { insiderClass: "opportunistic" }), ...pair("BBB", { insiderClass: "routine" }), ...pair("CCC", { insiderClass: "unknown" }), ...pair("DDD", {})];
    expect(picksOf(run("2020-03-02", events, { insiderClass: "opportunistic" }))).toEqual(["AAA"]);
    expect(picksOf(run("2020-03-02", events, { insiderClass: "routine" }))).toEqual(["BBB"]);
    expect(picksOf(run("2020-03-02", events, { insiderClass: "all", topN: 10 }))).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    expect(picksOf(run("2020-03-02", events, { topN: 10 }))).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    expect((run("2020-03-02", events, { insiderClass: "opportunistic" }).diagnostics.filtered as { insiderClass: number }).insiderClass).toBe(6);
  });

  test("a cluster counts only the insiders of the requested class", () => {
    const mixed = [evm("AAA", "2020-03-02", ["o1"], 40_000, { insiderClass: "opportunistic" }), evm("AAA", "2020-03-02", ["r1"], 40_000, { insiderClass: "routine" })];
    expect(picksOf(run("2020-03-02", mixed))).toEqual(["AAA"]); // 2 insiders of any class
    expect(picksOf(run("2020-03-02", mixed, { insiderClass: "opportunistic" }))).toEqual([]); // 1 opportunistic
  });

  test("exclude10b5_1 drops events flagged as plan trades", () => {
    const events = [...pair("AAA", { plan10b5_1: true }), ...pair("BBB", { plan10b5_1: false }), ...pair("CCC", {})];
    expect(picksOf(run("2020-03-02", events, { exclude10b5_1: true }))).toEqual(["BBB", "CCC"]);
    expect(picksOf(run("2020-03-02", events, { exclude10b5_1: false }))).toEqual(["AAA", "BBB", "CCC"]);
    expect(picksOf(run("2020-03-02", events, { topN: 5 }))).toEqual(["AAA", "BBB", "CCC"]);
  });

  test("maxReportLagDays drops stale filings (and filings of unknown lag); the limit itself passes", () => {
    const events = [...pair("AAA", { lagDays: 30 }), ...pair("BBB", { lagDays: 31 }), ...pair("CCC", { lagDays: 2 }), ...pair("DDD", {}), ...pair("EEE", { lagDays: null })];
    expect(picksOf(run("2020-03-02", events, { maxReportLagDays: 30 }))).toEqual(["AAA", "CCC"]);
    expect(picksOf(run("2020-03-02", events, { topN: 10 }))).toEqual(["AAA", "BBB", "CCC", "DDD", "EEE"]);
    expect((run("2020-03-02", events, { maxReportLagDays: 30 }).diagnostics.filtered as { reportLag: number }).reportLag).toBe(6);
  });

  test("a stale event inside a cluster does not count toward it", () => {
    const events = [evm("AAA", "2020-03-02", ["x"], 40_000, { lagDays: 3 }), evm("AAA", "2020-03-02", ["y"], 40_000, { lagDays: 90 })];
    expect(picksOf(run("2020-03-02", events))).toEqual(["AAA"]);
    expect(picksOf(run("2020-03-02", events, { maxReportLagDays: 30 }))).toEqual([]);
  });
});

describe("minDollarPerInsider", () => {
  test("only insiders with their own dollars count; the cluster's dollars are those of the counted insiders", () => {
    const events = [evm("AAA", "2020-03-02", ["x"], 30_000, {}), evm("AAA", "2020-03-02", ["y"], 10_000, {}), // y is below 25k
      evm("BBB", "2020-03-02", ["x"], 30_000, {}), evm("BBB", "2020-03-02", ["y"], 26_000, {}),
      evm("CCC", "2020-03-02", ["x"], 15_000, {}), evm("CCC", "2020-03-03", ["x"], 15_000, {}), evm("CCC", "2020-03-02", ["z"], 30_000, {})]; // x: 15k+15k = 30k
    const t = run("2020-03-03", events, { minDollarPerInsider: 25_000, minDollar: 0 });
    expect(picksOf(t)).toEqual(["BBB", "CCC"]);
    const c = Object.fromEntries((t.diagnostics.candidates as Array<{ symbol: string; insiders: number; dollars: number }>).map(x => [x.symbol, x]));
    expect(c.BBB).toMatchObject({ insiders: 2, dollars: 56_000 });
    expect(c.CCC).toMatchObject({ insiders: 2, dollars: 60_000 });
    // without it the 10k insider counts (the cluster minimum alone)
    expect(picksOf(run("2020-03-03", events, { minDollar: 0, topN: 5 }))).toEqual(["AAA", "BBB", "CCC"]);
    // the cluster minimum still applies on top
    expect(picksOf(run("2020-03-03", events, { minDollarPerInsider: 25_000, minDollar: 58_000 }))).toEqual(["CCC"]);
  });
});

describe("holdSessions", () => {
  /** Business-day bars only, ending at asOf (a weekday). */
  function weekdayPrices(symbols: string[], asOf: string): PriceView {
    const bars = (s: string, n: number): DailyBar[] => {
      if (!symbols.includes(s)) return [];
      const out: DailyBar[] = [];
      for (let t = Date.parse(asOf); out.length < Math.min(n, 60); t -= DAY) {
        const dow = new Date(t).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        out.unshift({ date: new Date(t).toISOString().slice(0, 10), open: 100, high: 100, low: 100, close: 100 + out.length * 0.1, volume: 1 });
      }
      return out;
    };
    return { asOf, barCount: s => bars(s, 60).length, history: bars };
  }
  const walkWeekdays = (days: string[], events: SignalEvent[], over: Partial<CopySignalConfig>) => {
    let memory: Record<string, unknown> = {};
    const out: Record<string, TargetBook> = {};
    for (const d of days) {
      out[d] = decide({ view: weekdayPrices(["AAA"], d), signals: signalView(events, d), book: { ...flat, memory }, config: { ...base, holdDays: undefined, ...over } });
      memory = out[d].memory;
    }
    return out;
  };
  const week = ["2020-03-06", "2020-03-09", "2020-03-10", "2020-03-11", "2020-03-12", "2020-03-13", "2020-03-16"]; // Fri … Mon
  const events = [ev("AAA", "2020-03-06", ["x"], 40_000), ev("AAA", "2020-03-06", ["y"], 40_000)];

  test("a pick is held N sessions of its own bars: the weekend does not count", () => {
    const w = walkWeekdays(week, events, { holdSessions: 5, lookbackDays: 3 });
    // selected on Fri 03-06; bars after it: Mon 1, Tue 2, Wed 3, Thu 4, Fri 5 → dropped on asOf Fri 03-13
    for (const d of week.slice(0, 5)) expect(picksOf(w[d])).toEqual(["AAA"]);
    expect(picksOf(w["2020-03-13"])).toEqual([]);
    expect(w["2020-03-13"].diagnostics.expired).toEqual(["AAA"]);
    // the same count in CALENDAR days would have dropped it on Wed 03-11
    const cal = walkWeekdays(week, events, { holdDays: 5, holdSessions: undefined, lookbackDays: 3 });
    expect(picksOf(cal["2020-03-10"])).toEqual(["AAA"]);
    expect(picksOf(cal["2020-03-11"])).toEqual([]);
  });

  test("exactly one of holdDays / holdSessions", () => {
    expect(() => run("2020-03-02", [], { holdDays: 5, holdSessions: 5 })).toThrow(/exactly one/);
    expect(() => run("2020-03-02", [], { holdDays: undefined })).toThrow(/exactly one/);
    expect(() => run("2020-03-02", [], { holdDays: undefined, holdSessions: 3 })).not.toThrow();
  });
});
