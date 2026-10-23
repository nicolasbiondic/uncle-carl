import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareArtifacts, compareOnCommonDays, performanceOnDates } from "./rw3-compare-artifacts";

const tmp = mkdtempSync(join(tmpdir(), "rw3-compare-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A minimal legacy-shaped artifact: one outer fold, base cost, selected hash. */
function fakeArtifact(name: string, points: Array<{ date: string; ret: number }>, config: Record<string, unknown> = { timeframe: "1d", portfolio: {} }): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ outerTests: [{ foldPath: "0/test" }], outerSelection: [{ foldPath: "0/test", candidateHash: "h" }] }));
  writeFileSync(join(dir, "runs.jsonl"), JSON.stringify({ foldPath: "0/test", costTier: "base", status: "complete", candidateHash: "h", result: { config, dailyReturns: points } }));
  return dir;
}

describe("rw3-compare-artifacts", () => {
  test("performanceOnDates compounds only the given dates and reports CAGR/maxDD", () => {
    const s = new Map([["2020-01-01", 0.1], ["2021-01-01", -0.5], ["2022-01-01", 0.2]]);
    const p = performanceOnDates(s, ["2020-01-01", "2021-01-01", "2022-01-01"], 0.3);
    expect(p.sharpe).toBe(0.3);
    expect(p.totalReturn).toBeCloseTo(1.1 * 0.5 * 1.2 - 1, 12);
    expect(p.maxDrawdown).toBeCloseTo(0.5, 12);
    expect(p.years).toBeCloseTo(2, 2);
    expect(p.cagr).toBeCloseTo(Math.pow(0.66, 1 / p.years) - 1, 10);
    // A date the series lacks contributes 0 (same convention as the combiner).
    expect(performanceOnDates(s, ["2020-01-01", "2030-01-01"], 0).totalReturn).toBeCloseTo(0.1, 12);
  });

  test("compareOnCommonDays uses only the shared dates; identical series give delta 0", () => {
    const a = new Map([["2020-01-02", 0.01], ["2020-01-03", -0.02], ["2020-01-06", 0.03], ["2020-01-07", 0.01]]);
    const b = new Map([["2020-01-03", -0.02], ["2020-01-06", 0.03], ["2020-01-08", 0.5]]);
    const c = compareOnCommonDays(a, b, 252);
    expect(c.commonDays).toBe(2);
    expect(c.from).toBe("2020-01-03");
    expect(c.to).toBe("2020-01-06");
    expect(c.deltaSharpe).toBeCloseTo(0, 12);
    expect(c.candidate.totalReturn).toBeCloseTo(0.98 * 1.03 - 1, 12);
    expect(c.control.totalReturn).toBeCloseTo(c.candidate.totalReturn, 12);
  });

  test("compareArtifacts reads two artifact dirs (legacy daily label shift applied to both sides)", () => {
    const cand = fakeArtifact("cand", [{ date: "2020-01-02", ret: 0.02 }, { date: "2020-01-03", ret: 0.01 }], { timeframe: "1d", portfolio: {} });
    // Legacy daily momentum replay: labels one day late → shifted back to the same sessions.
    const ctrl = fakeArtifact("ctrl", [{ date: "2020-01-03", ret: 0.01 }, { date: "2020-01-04", ret: 0.01 }], { timeframe: "1d" });
    const c = compareArtifacts(cand, ctrl, 252);
    expect(c.commonDays).toBe(2);
    expect(c.candidate.totalReturn).toBeCloseTo(1.02 * 1.01 - 1, 12);
    expect(c.control.totalReturn).toBeCloseTo(1.01 * 1.01 - 1, 12);
    expect(c.deltaSharpe).toBeGreaterThan(0);
  });
});
