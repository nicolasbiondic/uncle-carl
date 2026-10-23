/**
 * RW4b (docs/reports/RW-reescritura-rentable.md §14) end to end on SYNTHETIC tapes: a braked, fast-vol
 * volManaged manifest through the unmodified nested walk-forward with the portfolio runner, then the
 * RW4b evaluator with a control (E1) and a partner (E2) artifact. No real data, no trial.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWalkForward, type ExperimentManifest } from "./walk-forward";
import { coreKernel, makePortfolioRunner, type PortfolioReplayResult } from "./portfolio-replay";
import { chainDailyReturns, evaluatePortfolioCriteria } from "./portfolio-criteria";
import { PORTFOLIO_CODE_FILES } from "./portfolio-wf";
import { writeDailyFixture } from "./lib/portfolioSynthetic";
import { shiftDailyReturnDate } from "./lib/combinedPortfolioReturns";

const tmp = mkdtempSync(join(tmpdir(), "rw4b-wf-"));
const outputDirs: string[] = [];
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const d of outputDirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

const db = join(tmp, "stocks.db");
writeDailyFixture(db, {
  source: "alpaca_wide", from: "2020-01-02", sessions: 700,
  series: [
    { symbol: "SPY", seed: 1, startPrice: 300, driftAnnual: 0.15, volAnnual: 0.18 },
    { symbol: "IEF", seed: 2, startPrice: 100, driftAnnual: 0.02, volAnnual: 0.06 },
    { symbol: "GLD", seed: 3, startPrice: 150, driftAnnual: 0.10, volAnnual: 0.15 },
  ],
});

function manifest(): ExperimentManifest {
  const strategy = { kind: "volManaged" as const, universe: ["SPY", "IEF", "GLD"], inceptionGuardBars: 252, volLookback: 63, covLookback: 21,
    portfolioVolTarget: 0.2, annualization: 252 as const, perAssetCap: 0.6, maxGross: 1.5,
    drawdownBrake: { startDrawdown: 0.05, maxDrawdown: 0.2, floorScale: 0.25 }, fastVolLookback: 5 };
  return {
    name: "rw4b-e1-synthetic", sleeve: "stocks", trialAccounting: { priorUniqueTrials: 424, complete: false },
    data: { dbPath: db, source: "alpaca_wide", timeframe: "1d", universe: ["SPY", "IEF", "GLD"], refSymbol: "SPY", rthOnly: false, funding: false, barMinutes: 1440, barMinutesEq: 1440 },
    asOf: "2022-09-01T00:00:00Z",
    window: { from: "2021-03-01", to: "2022-09-01", outerFoldCount: 2, innerFoldCount: 1, purgeYears: 0.02, warmupDays: 420 },
    costs: { base: { slippageBps: 2, commissionBps: 0, marginInterest: { annualRate: 0.065 } }, stress: { slippageBps: 5, commissionBps: 2, marginInterest: { annualRate: 0.065 } } },
    ledger: { initialEquity: 50_000 } as ExperimentManifest["ledger"],
    candidates: [{ name: "braked", cadenceMin: 1440, portfolio: { strategy, venue: { venue: "alpaca", fractional: true, minOrderNotional: 5, rebalanceBand: 0 } } }],
    acceptance: {},
  };
}

/** A synthetic artifact directory with one outer fold carrying `points` (what loadArtifactOuterDailyReturns reads). */
function artifactDir(name: string, points: Array<{ date: string; ret: number }>, config: Record<string, unknown>): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ outerTests: [{ foldPath: "0/test" }], outerSelection: [{ foldPath: "0/test", candidateHash: name }] }));
  writeFileSync(join(dir, "runs.jsonl"), JSON.stringify({ foldPath: "0/test", costTier: "base", status: "complete", candidateHash: name, result: { config, dailyReturns: points } }));
  return dir;
}

describe("RW4b protocol end to end (synthetic)", () => {
  test("the braked, fast-vol chain runs, carries the brake's peak across folds, and is judged by §14", async () => {
    const m = manifest();
    const { summary, outputDir } = await runWalkForward(m, { runner: makePortfolioRunner(coreKernel), codeFiles: PORTFOLIO_CODE_FILES, breakEven: true });
    outputDirs.push(outputDir);
    expect(summary.complete).toBe(true);
    expect(summary.skippedFolds).toEqual([]);
    for (const t of summary.outerTests) expect((t.result as PortfolioReplayResult).portfolioDiagnostics.orders).toBeGreaterThan(0);
    // The brake's high-water mark is part of the memory that travels between folds.
    const runs = readFileSync(join(outputDir, "runs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const base0 = runs.find(r => r.foldPath === "0/test" && r.costTier === "base");
    expect(base0.result.finalRiskState.portfolioMemory.portfolioCore.peakEquity).toBeGreaterThan(0);

    const mine = chainDailyReturns(summary);
    const control = artifactDir("e1-control", [...mine].map(([date, ret]) => ({ date: shiftDailyReturnDate(date, 1), ret: ret - 0.0003 })), { timeframe: "1d" });
    const partner = artifactDir("e2-partner", [...mine].map(([date, ret]) => ({ date, ret: ret * 0.4 })), { timeframe: "1d", meanrev: {} });

    await expect(evaluatePortfolioCriteria(m, summary, outputDir, "synthetic", { quiet: true, controlArtifact: control })).rejects.toThrow(/--partner/);
    const report = await evaluatePortfolioCriteria(m, summary, outputDir, "synthetic", { quiet: true, controlArtifact: control, partnerArtifact: partner });
    expect(report.design).toBe("E1");
    expect(Object.keys(report.criteria)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "A1", "H1", "H2", "M1", "S1", "S2"]);
    expect(report.criteria.M1.pass).toBe(true);
    expect(report.criteria.M1.detail!.marginInterestPaidUsd as number).toBeGreaterThan(0);
    expect(report.criteria.A1.detail!.commonDays).toBe(mine.size);
    // This synthetic chain starts in 2021: February–March 2020 is outside it and fails closed; 2022 is judged.
    expect(report.criteria.S1).toMatchObject({ pass: false, value: null });
    expect(report.criteria.S2.detail!.sessions as number).toBeGreaterThan(20);
    expect(report.allPass).toBe(false);
    expect(report.verdict).toMatch(/S1/);
    expect(existsSync(join(outputDir, "rw4b-criteria.json"))).toBe(true);
    expect(existsSync(join(outputDir, "rw2-criteria.json"))).toBe(false);
    const written = JSON.parse(readFileSync(join(outputDir, "rw4b-criteria.json"), "utf8"));
    expect(written.reported.partnerArtifact).toBe(partner);
    expect(written.reported.rw4b.wiring).toMatch(/2027-01-21/);

    // The driver: --dry-run needs neither artifact; a real run without --partner is refused before any trial.
    const manifestPath = join(tmp, "rw4b-e1-synthetic.json");
    writeFileSync(manifestPath, JSON.stringify(m));
    const cwd = join(import.meta.dir, "..");
    const dry = Bun.spawnSync([process.execPath, "scripts/portfolio-wf.ts", manifestPath, "--dry-run"], { cwd });
    expect(dry.exitCode).toBe(0);
    const refused = Bun.spawnSync([process.execPath, "scripts/portfolio-wf.ts", manifestPath, "--control", control], { cwd });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toMatch(/--partner/);
  }, 120_000);

  test("RW4b criteria are only for E1 volManaged manifests named rw4b-e1-", async () => {
    const m = manifest();
    const { summary, outputDir } = await runWalkForward({ ...m, name: "rw4b-e1-synthetic-2" }, { runner: makePortfolioRunner(coreKernel), codeFiles: PORTFOLIO_CODE_FILES });
    outputDirs.push(outputDir);
    const dir = artifactDir("any", [], { timeframe: "1d" });
    await expect(evaluatePortfolioCriteria({ ...m, name: "rw4b-e2-synthetic" }, summary, outputDir, "x", { quiet: true, controlArtifact: dir, partnerArtifact: dir })).rejects.toThrow(/E1 volManaged/);
  }, 120_000);
});
