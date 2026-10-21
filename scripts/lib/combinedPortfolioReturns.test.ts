import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadArtifactOuterDailyReturns,
  combinedWeightedDailyReturns,
  pearsonCorrelation,
  alignSeries,
} from "./combinedPortfolioReturns";

function makeArtifact(dir: string, folds: Array<{ foldPath: string; dailyReturns: Array<{ date: string; ret: number }>; config?: object }>) {
  const summary = { outerTests: folds.map(f => ({ foldPath: f.foldPath, result: {} })) };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
  const runs = folds.map(f => ({
    foldPath: f.foldPath, costTier: "base", status: "complete",
    result: { dailyReturns: f.dailyReturns, config: f.config },
  }));
  // also add a decoy inner-fold / stress run that must be IGNORED
  runs.push({ foldPath: folds[0].foldPath, costTier: "stress", status: "complete", result: { dailyReturns: [{ date: "1999-01-01", ret: 99 }] } } as any);
  writeFileSync(join(dir, "runs.jsonl"), runs.map(r => JSON.stringify(r)).join("\n") + "\n");
}

describe("loadArtifactOuterDailyReturns", () => {
  test("concatenates ONLY base-cost outer-test folds, in summary order", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      makeArtifact(dir, [
        { foldPath: "0/test", dailyReturns: [{ date: "2022-01-03", ret: 0.01 }] },
        { foldPath: "1/test", dailyReturns: [{ date: "2023-01-03", ret: -0.02 }] },
      ]);
      const series = loadArtifactOuterDailyReturns(dir);
      expect(series).toEqual([
        { date: "2022-01-03", ret: 0.01 },
        { date: "2023-01-03", ret: -0.02 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aligns daily-bar momentum returns from their result config, but not meanrev or hourly returns", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      makeArtifact(dir, [
        { foldPath: "0/test", dailyReturns: [{ date: "2024-01-03", ret: 0.01 }], config: { timeframe: "1d" } },
        { foldPath: "1/test", dailyReturns: [{ date: "2024-01-03", ret: 0.02 }], config: { timeframe: "1d", meanrev: {} } },
        { foldPath: "2/test", dailyReturns: [{ date: "2024-01-03", ret: 0.03 }], config: { timeframe: "1h" } },
      ]);
      expect(loadArtifactOuterDailyReturns(dir)).toEqual([
        { date: "2024-01-02", ret: 0.01 },
        { date: "2024-01-03", ret: 0.02 },
        { date: "2024-01-03", ret: 0.03 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when a declared outer fold has no complete base-cost run (fail closed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ outerTests: [{ foldPath: "0/test" }] }));
      writeFileSync(join(dir, "runs.jsonl"), "");
      expect(() => loadArtifactOuterDailyReturns(dir)).toThrow(/missing complete base-cost outer-test run/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("combinedWeightedDailyReturns", () => {
  test("weights each artifact by its share of total initialEquity and sums per date", () => {
    const dirA = mkdtempSync(join(tmpdir(), "artifact-"));
    const dirB = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      makeArtifact(dirA, [{ foldPath: "0/test", dailyReturns: [{ date: "2022-01-03", ret: 0.02 }] }]);
      makeArtifact(dirB, [{ foldPath: "0/test", dailyReturns: [{ date: "2022-01-03", ret: -0.01 }] }]);
      const combined = combinedWeightedDailyReturns([
        { dir: dirA, initialEquity: 75 },
        { dir: dirB, initialEquity: 25 },
      ]);
      expect(combined.get("2022-01-03")).toBeCloseTo(0.75 * 0.02 + 0.25 * -0.01, 10);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe("pearsonCorrelation / alignSeries", () => {
  test("perfectly correlated series -> 1", () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
  });
  test("perfectly anti-correlated series -> -1", () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
  });
  test("constant series -> null (undefined correlation)", () => {
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBeNull();
  });
  test("alignSeries inner-joins on common dates, sorted ascending", () => {
    const a = new Map([["2024-01-02", 1], ["2024-01-03", 2], ["2024-01-05", 5]]);
    const b = new Map([["2024-01-03", 20], ["2024-01-05", 50], ["2024-01-06", 60]]);
    const { dates, a: av, b: bv } = alignSeries(a, b);
    expect(dates).toEqual(["2024-01-03", "2024-01-05"]);
    expect(av).toEqual([2, 5]);
    expect(bv).toEqual([20, 50]);
  });
});
