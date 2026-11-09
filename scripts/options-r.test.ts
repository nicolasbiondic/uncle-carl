import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canonicalJson, evaluateCriteria, hFor, hTableFromAudit, MANIFEST_PATH, parseCboeCsv, parseFredCsv, pearson, selectWindowWeeks } from "./options-r";
import { BOOTSTRAP, circularBlockBootstrap, holm } from "./lib/optionsWeekly";

describe("options-r acceptance (pure parts)", () => {
  test("the frozen bootstrap: blocks of 4, 10 000 resamples, seed 20261109; deterministic across calls", () => {
    expect(BOOTSTRAP).toEqual({ blockLen: 4, resamples: 10_000, seed: 20261109 });
    const x = Array.from({ length: 120 }, (_, i) => (i % 7 - 3) * 0.004 + 0.0007);
    const a = circularBlockBootstrap(x), b = circularBlockBootstrap(x);
    expect(a).toEqual(b);
    expect(a.n).toBe(120);
    expect(a.resamples).toBe(10_000);
    expect(a.p).toBeGreaterThan(0);
    expect(a.p).toBeLessThanOrEqual(1);
    // p = (1 + #{mean* <= 0}) / (1 + B): a multiple of 1/10001
    expect(Math.abs(a.p * 10_001 - Math.round(a.p * 10_001))).toBeLessThan(1e-9);
  });

  test("Holm over 3 one-sided p-values at 0.10 and the five criteria on synthetic fixtures", () => {
    const ps = [0.01, 0.04, 0.3];
    const rejected = holm(ps, 0.10);
    expect(rejected).toEqual([true, true, false]); // 0.01 <= 0.0333, 0.04 <= 0.05, 0.3 > 0.10
    const good = evaluateCriteria({ bootstrap: { p: 0.01, mean: 0.001 }, maxDrawdownMid: 0.12, overlapMeanMirror: 0.0005, overlapMeanAlpaca: 0.0002, holdoutMean: 0.0003, rules: { anyLegIntoExpiration: false, worstWeekRule: true } }, true);
    expect(good).toEqual({ criteria: { "1_pairedExcess": true, "2_drawdown": true, "3a_overlapConsistency": true, "3b_holdout": true, "4_rules": true }, pass: true });
    // Holm rejected but the mean is not positive → 1 fails (one-sided test is on mean > 0)
    expect(evaluateCriteria({ bootstrap: { p: 0.01, mean: -0.001 }, maxDrawdownMid: 0.1, overlapMeanMirror: 0.1, overlapMeanAlpaca: 0.1, holdoutMean: 0.1, rules: { anyLegIntoExpiration: false, worstWeekRule: true } }, true).criteria["1_pairedExcess"]).toBe(false);
    // not rejected → 1 fails even with p small
    expect(evaluateCriteria({ bootstrap: { p: 0.04, mean: 0.001 }, maxDrawdownMid: 0.1, overlapMeanMirror: 0.1, overlapMeanAlpaca: 0.1, holdoutMean: 0.1, rules: { anyLegIntoExpiration: false, worstWeekRule: true } }, false).pass).toBe(false);
    // drawdown exactly 0.30 passes, 0.3001 fails
    expect(evaluateCriteria({ bootstrap: { p: 0.01, mean: 0.001 }, maxDrawdownMid: 0.30, overlapMeanMirror: 0.1, overlapMeanAlpaca: 0.1, holdoutMean: 0.1, rules: { anyLegIntoExpiration: false, worstWeekRule: true } }, true).criteria["2_drawdown"]).toBe(true);
    expect(evaluateCriteria({ bootstrap: { p: 0.01, mean: 0.001 }, maxDrawdownMid: 0.3001, overlapMeanMirror: 0.1, overlapMeanAlpaca: 0.1, holdoutMean: 0.1, rules: { anyLegIntoExpiration: false, worstWeekRule: true } }, true).criteria["2_drawdown"]).toBe(false);
    // 3a: opposite signs fail; 3b: non-positive fails; missing data → null (reported, never a pass)
    const r = evaluateCriteria({ bootstrap: { p: 0.01, mean: 0.001 }, maxDrawdownMid: 0.1, overlapMeanMirror: 0.001, overlapMeanAlpaca: -0.001, holdoutMean: 0, rules: { anyLegIntoExpiration: false, worstWeekRule: true } }, true);
    expect(r.criteria["3a_overlapConsistency"]).toBe(false);
    expect(r.criteria["3b_holdout"]).toBe(false);
    expect(r.pass).toBe(false);
    const n = evaluateCriteria({ bootstrap: { p: 0.01, mean: 0.001 }, maxDrawdownMid: 0.1, overlapMeanMirror: null, overlapMeanAlpaca: null, holdoutMean: null, rules: { anyLegIntoExpiration: false, worstWeekRule: null } }, true);
    expect(n.criteria["3a_overlapConsistency"]).toBeNull();
    expect(n.criteria["4_rules"]).toBe(true); // O1: exempt from the weekly budget
    expect(n.pass).toBe(false);
    // 4: a leg into expiration or a week beyond 2 % (O2/O3) fails
    expect(evaluateCriteria({ bootstrap: { p: 0.01, mean: 0.001 }, maxDrawdownMid: 0.1, overlapMeanMirror: 0.1, overlapMeanAlpaca: 0.1, holdoutMean: 0.1, rules: { anyLegIntoExpiration: true, worstWeekRule: true } }, true).criteria["4_rules"]).toBe(false);
    expect(evaluateCriteria({ bootstrap: { p: 0.01, mean: 0.001 }, maxDrawdownMid: 0.1, overlapMeanMirror: 0.1, overlapMeanAlpaca: 0.1, holdoutMean: 0.1, rules: { anyLegIntoExpiration: false, worstWeekRule: false } }, true).criteria["4_rules"]).toBe(false);
  });

  test("second-provider h: by underlying, type and |delta| bucket; |delta| above 0.65 falls into the last bucket and is counted", () => {
    // the audit's cells carry Python-formatted keys ("SPY|put|0.0-0.15"); the table is built from their numeric buckets
    const table = hTableFromAudit({
      "SPY|put|0.0-0.15": { underlying: "SPY", type: "put", absDeltaBucket: [0.0, 0.15], h: 0.09 },
      "SPY|put|0.15-0.35": { underlying: "SPY", type: "put", absDeltaBucket: [0.15, 0.35], h: 0.007 },
      "SPY|put|0.35-0.65": { underlying: "SPY", type: "put", absDeltaBucket: [0.35, 0.65], h: 0.005 },
    });
    expect(Object.keys(table).sort()).toEqual(["SPY|put|0", "SPY|put|1", "SPY|put|2"]);
    expect(() => hTableFromAudit({ x: { underlying: "SPY", type: "put", absDeltaBucket: [0.2, 0.3], h: 1 } })).toThrow();
    expect(hFor(table, "SPY", "put", 0.10)).toBe(0.09);
    expect(hFor(table, "SPY", "put", 0.15)).toBe(0.007);
    expect(hFor(table, "SPY", "put", 0.65)).toBe(0.005);
    const clamped = { count: 0 };
    expect(hFor(table, "SPY", "put", 0.80, clamped)).toBe(0.005);
    expect(clamped.count).toBe(1);
    expect(hFor(table, "QQQ", "put", 0.10)).toBeUndefined();
  });

  test("manifest identity is canonical (key order independent) and the manifest's frozen constants are what the runner uses", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    expect(m.acceptance["1_pairedExcess"]).toContain("bloques de 4 semanas, 10.000 remuestreos, semilla 20261109");
    expect(m.acceptance["1_pairedExcess"]).toContain("nivel conjunto 0.10");
    expect(m.acceptance["2_drawdown"]).toContain("<= 0.30");
    expect(m.personality.capitalUsd).toBe(100_000);
    expect(m.windows.overlap).toContain("2024-02-02");
  });

  test("external series parsers: FRED csv (with '.' gaps) and Cboe history csv", () => {
    const fred = parseFredCsv("observation_date,DTB3\n2024-01-02,5.25\n2024-01-03,.\n2024-01-04,5.22\n");
    expect([...fred]).toEqual([["2024-01-02", 5.25], ["2024-01-04", 5.22]]);
    const cboe = parseCboeCsv("DATE,OPEN,HIGH,LOW,CLOSE\n01/03/2024,100,101,99,100.5\n01/04/2024,100.5,102,100,101.2\n");
    expect([...cboe]).toEqual([["2024-01-03", 100.5], ["2024-01-04", 101.2]]);
    expect([...parseCboeCsv("DATE,CLOSE\n01/03/2024,1200.5\n")]).toEqual([["2024-01-03", 1200.5]]);
  });

  test("window weeks: a no-eligible-expiration week inside the window is kept (cash), the last week whose exit falls outside is excluded", () => {
    const wk = (entry: string): any => ({ isoWeek: entry, sessions: [entry], entry, signal: entry });
    const weeks = [wk("2010-05-07"), wk("2010-05-14"), wk("2010-05-21"), wk("2010-05-28"), wk("2010-06-04"), wk("2025-12-05"), wk("2025-12-12"), wk("2025-12-19")];
    const noExpiry = new Set(["2010-05-21", "2010-05-28"]);
    const exitsInside = (w: any) => !noExpiry.has(w.entry) && w.entry <= "2025-12-05"; // 2025-12-12's exit falls after the mirror
    expect(selectWindowWeeks(weeks, "2010-05-14", "2025-12-12", exitsInside).map(w => w.entry))
      .toEqual(["2010-05-14", "2010-05-21", "2010-05-28", "2010-06-04", "2025-12-05"]);
    // runs 1–2 dropped 2010-05-21 and 2010-05-28; the manifest counts them as cash
    expect(selectWindowWeeks(weeks, "2010-05-14", "2025-12-12", exitsInside)).toContainEqual(wk("2010-05-21"));
    expect(selectWindowWeeks(weeks, "2025-12-19", "2026-11-06", () => false)).toEqual([]);
    expect(selectWindowWeeks(weeks, "2025-12-19", "2026-11-06", w => w.entry === "2025-12-19").map(w => w.entry)).toEqual(["2025-12-19"]);
  });

  test("pearson", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(pearson([1, 2], [1, 2])).toBeNull();
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});
