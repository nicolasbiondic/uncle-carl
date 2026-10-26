import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { researchDataPath } from "../scripts/lib/researchData";
import { loadArtifactOuterDailyReturns } from "../scripts/lib/combinedPortfolioReturns";
import { compareArtifacts } from "../scripts/rw3-compare-artifacts";
import { combinedBookDrawdown, evaluateCrypto } from "../scripts/rw5-crypto-evaluate";

const root = join(import.meta.dir, "..");
// The public export drops docs/reports/** (scripts/public-export/exclude.txt),
// so a source path there is checked only where that directory exists.
const sourcePathPresent = (p: string) =>
  existsSync(join(root, p)) || (p.startsWith("docs/reports/") && !existsSync(join(root, "docs/reports")));
const ledger = JSON.parse(readFileSync(join(import.meta.dir, "historical-hypothesis-ledger-v1.json"), "utf8"));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function expand(grid: { vary: Record<string, unknown[]>; fixed: Record<string, unknown> }): unknown[] {
  let rows: Record<string, unknown>[] = [{}];
  for (const [key, values] of Object.entries(grid.vary)) {
    rows = rows.flatMap(row => values.map(value => ({ ...row, [key]: value })));
  }
  return rows.map(row => ({ ...grid.fixed, ...row }));
}

describe("historical hypothesis ledger", () => {
  test("expands the legacy grids to 251 unique, non-overlapping hypotheses", async () => {
    const legacy = ledger.batches[0];
    const xs = expand(legacy.grids.crossSectional);
    const tsm = expand(legacy.grids.timeSeries);
    const xsHashes = new Set(xs.map(hash));
    const tsmHashes = new Set(tsm.map(hash));

    expect(xs).toHaveLength(8);
    expect(tsm).toHaveLength(243);
    expect(xsHashes.size).toBe(8);
    expect(tsmHashes.size).toBe(243);
    expect([...xsHashes].some(h => tsmHashes.has(h))).toBe(false);
    expect(new Set([...xsHashes, ...tsmHashes]).size).toBe(251);
    expect(legacy.expectedUniqueConfigs).toBe(251);
  });

  test("keeps the ledger incomplete and aligned with both manifests", () => {
    expect(ledger.schema).toBe("historical-hypothesis-ledger");
    expect(ledger.version).toBe(1);
    expect(ledger.authoritativeArtifact.crypto).toMatchObject({
      outerFoldReturnsPct: [9.4, 554.29, -32.05],
      stitchedReturnPct: 386.37,
      sharpe: 0.979,
      maxDrawdownPct: 49.18,
      stressMaxDrawdownPct: 59.41,
      looMaxDrawdownPct: 63.55,
      trades: 648,
    });
    expect(ledger.identity.execution).toContain("initialRiskState");
    expect(ledger.scope.complete).toBe(false);
    expect(ledger.scope.lowerBoundUniqueHypotheses).toBe(251);
    for (const batch of ledger.batches.slice(1)) {
      expect(batch.inventoryComplete).toBe(false);
      expect(batch.resultsComplete).toBe(false);
    }
    expect(ledger.batches[0].inventoryComplete).toBe(true);
    expect(ledger.batches[0].resultsComplete).toBe(false);
    for (const file of ["momentum-crypto-v1.json", "momentum-stocks-v1.json"]) {
      const manifest = JSON.parse(readFileSync(join(root, "experiments", file), "utf8"));
      expect(manifest.trialAccounting).toEqual({ priorUniqueTrials: 251, complete: false });
    }
  });

  test("meanrev claims align with the meanrev manifest and the ledger's own inventory batch", () => {
    const manifest = JSON.parse(readFileSync(join(root, "experiments", "meanrev-stocks-v1.json"), "utf8"));
    const batch = ledger.batches.find((b: any) => b.id === "meanrev-prior-experiments");
    expect(batch.hypothesisCount).toBe(manifest.trialAccounting.priorUniqueTrials);
    expect(batch.inventoryComplete).toBe(false);
    expect(manifest.trialAccounting.complete).toBe(false);
    // The recorded verdict must stay a FAILURE unless a new artifact honestly changes it.
    expect(ledger.authoritativeArtifactMeanrev.verdict).toContain("FAILED");
    expect(ledger.authoritativeArtifactMeanrev.meanrevStocks.gatesFailed)
      .toEqual(["minExcessSharpeVsBench", "minSharpe", "stressMinSharpe"]);
  });

  test("stop-sizing claims align with their manifests, the inventory batch, and stay honest failures", () => {
    const mrManifest = JSON.parse(readFileSync(join(root, "experiments", "meanrev-stop-sizing-v1.json"), "utf8"));
    const stManifest = JSON.parse(readFileSync(join(root, "experiments", "momentum-stop-sizing-v1.json"), "utf8"));
    // Prior-trial arithmetic documented in the stop-sizing-sweeps batch:
    // meanrev 9 (inventoried) + 4 (meanrev-stocks-v1's own candidates) = 13;
    // stocks 251 (legacy grid) + 1 (momentum-stocks-v1 incumbent) = 252.
    expect(mrManifest.trialAccounting).toEqual({ priorUniqueTrials: 13, complete: false });
    expect(stManifest.trialAccounting).toEqual({ priorUniqueTrials: 252, complete: false });
    const batch = ledger.batches.find((b: any) => b.id === "stop-sizing-sweeps");
    expect(batch.hypothesisCount).toBe(mrManifest.candidates.length + stManifest.candidates.length); // 5 + 4, all pre-registered and reported
    // Both verdicts must stay FAILURES unless a new artifact honestly changes them.
    expect(ledger.authoritativeArtifactMeanrevStopSizing.verdict).toContain("FAILED");
    expect(ledger.authoritativeArtifactMeanrevStopSizing.meanrevStopSizing.gatesFailed)
      .toEqual(["minExcessSharpeVsBench", "minSharpe"]);
    expect(ledger.authoritativeArtifactStocksStopSizing.verdict).toContain("FAILED");
    expect(ledger.authoritativeArtifactStocksStopSizing.stocksStopSizing.gatesFailed)
      .toEqual(["minExcessReturnVsBench"]);
  });

  test("crypto threshold-sweep claims align with the manifest, the inventory batch, and stay an honest failure", () => {
    const manifest = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-thresholds-v1.json"), "utf8"));
    // Prior-trial arithmetic documented in the crypto-threshold-sweep batch:
    // 251 (legacy v7 grid) + 1 (momentum-crypto-v1 incumbent) = 252; the
    // manifest's own incumbent is an execution-identity rerun, its 5 variants
    // are the batch's new hypotheses.
    expect(manifest.trialAccounting).toEqual({ priorUniqueTrials: 252, complete: false });
    expect(manifest.candidates).toHaveLength(6);
    const batch = ledger.batches.find((b: any) => b.id === "crypto-threshold-sweep");
    expect(batch.hypothesisCount).toBe(manifest.candidates.length - 1); // 5 pre-registered variants + incumbent rerun
    // The verdict must stay a FAILURE (XRP-dependent LOO) unless a new artifact honestly changes it.
    expect(ledger.authoritativeArtifactCryptoThresholds.verdict).toContain("FAILED");
    expect(ledger.authoritativeArtifactCryptoThresholds.cryptoThresholds.gatesFailed)
      .toEqual(["looMaxDrawdown", "looMinTotalReturn"]);
  });

  // The authoritative artifact lives under gitignored data/backtests/, so a
  // fresh clone or CI never has it — but a checkout holding the research DB
  // it derives from (data/historical.db) is expected to hold (or regenerate)
  // the evidence. Gating on the source DB instead of on the artifact itself
  // is deliberate: skipping whenever the artifact is missing is exactly how
  // a bulk deletion of data/backtests/ once passed with a green suite, while
  // hard-failing everywhere would permanently break clean checkouts.
  const researchDbExists = existsSync(join(root, "data", "historical.db"));
  const testWithDb = researchDbExists ? test : test.skip;

  testWithDb("authoritative artifact evidence exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifact.crypto;
    const round2 = (x: number) => Math.round(x * 100) / 100;
    const round3 = (x: number) => Math.round(x * 1000) / 1000;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      stressMaxDrawdownPct: round2(s.acceptance.stressMaxDrawdown.value * 100),
      looMaxDrawdownPct: round2(s.acceptance.looMaxDrawdown.value * 100),
      trades: s.stitchedOos.trades,
    });

    // Prefer the declared path; a walk-forward run under evolved code writes
    // a NEW hash directory by design ("code corrections must never overwrite
    // evidence from an older run"), so when the declared path is gone the
    // evidence is acceptable from any data/backtests/<hash>/ whose summary
    // reproduces the claimed figures. What is never acceptable is having NO
    // artifact on disk that backs the ledger's numbers.
    const declared = join(root, ledger.authoritativeArtifact.path, "summary.json");
    const backtestsDir = join(root, "data", "backtests");
    const candidatePaths = existsSync(declared)
      ? [declared]
      : (existsSync(backtestsDir) ? readdirSync(backtestsDir) : [])
          .map(d => join(backtestsDir, d, "summary.json"))
          .filter(p => existsSync(p));

    const normalized = candidatePaths.flatMap(p => {
      try {
        return [normalize(JSON.parse(readFileSync(p, "utf8")))];
      } catch {
        return []; // unrelated/partial artifact — not a candidate
      }
    });
    expect(normalized).toContainEqual(claims);
  });

  testWithDb("meanrev authoritative artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactMeanrev.meanrevStocks;
    const round2 = (x: number) => Math.round(x * 100) / 100;
    const round3 = (x: number) => Math.round(x * 1000) / 1000;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      benchReturnPct: round2(s.stitchedOos.benchReturn * 100),
      benchSharpe: round3(s.stitchedOos.benchSharpe),
      excessSharpeVsBench: round3(s.stitchedOos.sharpe - s.stitchedOos.benchSharpe),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });

    // Same declared-path-first, any-reproducing-artifact-second policy as the
    // crypto claim above (a rerun under evolved code writes a NEW hash dir).
    const declared = join(root, ledger.authoritativeArtifactMeanrev.path, "summary.json");
    const backtestsDir = join(root, "data", "backtests");
    const candidatePaths = existsSync(declared)
      ? [declared]
      : (existsSync(backtestsDir) ? readdirSync(backtestsDir) : [])
          .map(d => join(backtestsDir, d, "summary.json"))
          .filter(p => existsSync(p));

    const normalized = candidatePaths.flatMap(p => {
      try {
        return [normalize(JSON.parse(readFileSync(p, "utf8")))];
      } catch {
        return []; // unrelated/partial artifact — not a candidate
      }
    });
    expect(normalized).toContainEqual(claims);
  });

  // Stop-sizing artifacts: same declared-path-first, any-reproducing-
  // artifact-second policy as above.
  const artifactCandidates = (declaredPath: string): string[] => {
    const declared = join(root, declaredPath, "summary.json");
    const backtestsDir = join(root, "data", "backtests");
    return existsSync(declared)
      ? [declared]
      : (existsSync(backtestsDir) ? readdirSync(backtestsDir) : [])
          .map(d => join(backtestsDir, d, "summary.json"))
          .filter(p => existsSync(p));
  };
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const round3 = (x: number) => Math.round(x * 1000) / 1000;

  testWithDb("meanrev stop-sizing artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactMeanrevStopSizing.meanrevStopSizing;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      benchReturnPct: round2(s.stitchedOos.benchReturn * 100),
      benchSharpe: round3(s.stitchedOos.benchSharpe),
      excessSharpeVsBench: round3(s.stitchedOos.sharpe - s.stitchedOos.benchSharpe),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    const normalized = artifactCandidates(ledger.authoritativeArtifactMeanrevStopSizing.path).flatMap(p => {
      try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
    });
    expect(normalized).toContainEqual(claims);
  });

  testWithDb("crypto threshold-sweep artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactCryptoThresholds.cryptoThresholds;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      benchReturnPct: round2(s.stitchedOos.benchReturn * 100),
      benchSharpe: round3(s.stitchedOos.benchSharpe),
      excessReturnVsBenchPct: round2((s.stitchedOos.totalReturn - s.stitchedOos.benchReturn) * 100),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    const normalized = artifactCandidates(ledger.authoritativeArtifactCryptoThresholds.path).flatMap(p => {
      try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
    });
    expect(normalized).toContainEqual(claims);
  });

  test("stocks smarter-sizing claims align with the three manifests and the batch (2026-09-25)", () => {
    const vs = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-daily-volsizing-v1.json"), "utf8"));
    const mh = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-daily-multihorizon-v1.json"), "utf8"));
    const pure = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-daily-blend3-pure-v1.json"), "utf8"));
    // Cascade documented in the batch: 288 (+2 volsizing) → 290 (+2 multihorizon)
    // → 292; the pure chain is an execution identity (+0).
    expect(vs.trialAccounting).toEqual({ priorUniqueTrials: 288, complete: false });
    expect(mh.trialAccounting).toEqual({ priorUniqueTrials: 290, complete: false });
    expect(pure.trialAccounting).toEqual({ priorUniqueTrials: 292, complete: false });
    expect(pure.candidates).toHaveLength(1);
    const batch = ledger.batches.find((b: any) => b.id === "stocks-smarter-sizing-2026-09-25");
    expect(batch.hypothesisCount).toBe(4);
    expect(batch.inventoryComplete).toBe(false);
    expect(batch.resultsComplete).toBe(false);
    // The verdicts must stay honest unless a new artifact changes them:
    // volSizing REFUTED at selection; multi-horizon won the pre-declared
    // criterion on the PURE chain (wiring decision stays with the owner).
    expect(ledger.authoritativeArtifactStocksVolSizing.verdict).toContain("REFUTADO");
    expect(ledger.authoritativeArtifactStocksVolSizing.stocksVolSizing.gatesFailed).toEqual([]);
    expect(ledger.authoritativeArtifactStocksMultiHorizon.verdict).toContain("GANA");
    expect(ledger.authoritativeArtifactStocksMultiHorizon.stocksBlend3Pure.gatesFailed).toEqual([]);
  });

  testWithDb("stocks blend3-pure artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactStocksMultiHorizon.stocksBlend3Pure;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      outerPsr: round3(s.outerPsr),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    const normalized = artifactCandidates(ledger.authoritativeArtifactStocksMultiHorizon.paths.blend3Pure).flatMap(p => {
      try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
    });
    expect(normalized).toContainEqual(claims);
  });

  test("meanrev-crypto claims align with the two manifests and the batch (2026-09-26)", () => {
    const v1 = JSON.parse(readFileSync(join(root, "experiments", "meanrev-crypto-v1.json"), "utf8"));
    const pure = JSON.parse(readFileSync(join(root, "experiments", "meanrev-crypto-rsi10sma200-pure-v1.json"), "utf8"));
    // Cascade documented in the batch: 292 (+3 meanrev-crypto candidates) →
    // 295; the pure chain of the mixed-chain best is an execution identity (+0).
    expect(v1.trialAccounting).toEqual({ priorUniqueTrials: 292, complete: false });
    expect(pure.trialAccounting).toEqual({ priorUniqueTrials: 295, complete: false });
    expect(v1.candidates).toHaveLength(3);
    expect(pure.candidates).toHaveLength(1);
    const batch = ledger.batches.find((b: any) => b.id === "meanrev-crypto-2026-09-26");
    expect(batch.hypothesisCount).toBe(3);
    expect(batch.inventoryComplete).toBe(false);
    expect(batch.resultsComplete).toBe(false);
    // The verdict must stay an honest REFUTATION (6/6 pre-declared shadow
    // criteria failed) unless a new artifact honestly changes it.
    expect(ledger.authoritativeArtifactMeanrevCrypto.verdict).toContain("REFUTADO");
    expect(ledger.authoritativeArtifactMeanrevCrypto.meanrevCrypto.gatesFailed).toEqual([
      "looMaxDrawdown", "looMinSharpe", "looMinTotalReturn", "maxDrawdown",
      "minBreakEvenSlippageBps", "minExcessSharpeVsBench", "minFoldsPsrAbove",
      "minOuterPsr", "minSharpe", "minTotalReturn", "stressMaxDrawdown",
      "stressMinSharpe", "stressMinTotalReturn",
    ]);
  });

  testWithDb("meanrev-crypto pure-chain artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactMeanrevCrypto.meanrevCrypto;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      benchReturnPct: round2(s.stitchedOos.benchReturn * 100),
      benchSharpe: round3(s.stitchedOos.benchSharpe),
      excessSharpeVsBench: round3(s.stitchedOos.sharpe - s.stitchedOos.benchSharpe),
      outerPsr: round3(s.outerPsr),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    const normalized = artifactCandidates(ledger.authoritativeArtifactMeanrevCrypto.path).flatMap(p => {
      try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
    });
    expect(normalized).toContainEqual(claims);
  });

  test("usdc control+redesign claims align with the five manifests and the batch (2026-09-26)", () => {
    const control = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-usdc-control-pure-v1.json"), "utf8"));
    const r1 = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-usdc-redesign-v1.json"), "utf8"));
    const vt35 = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-usdc-vt35-pure-v1.json"), "utf8"));
    const r2 = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-usdc-redesign-v2.json"), "utf8"));
    const vtcap = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-usdc-vtcap-pure-v1.json"), "utf8"));
    // Cascade declared in the manifests: control +1 (295→296), redesign-v1
    // +3 (296→299, its pure chain +0), redesign-v2 +2 (299→301, idem).
    expect(control.trialAccounting).toEqual({ priorUniqueTrials: 295, complete: false });
    expect(r1.trialAccounting).toEqual({ priorUniqueTrials: 296, complete: false });
    expect(vt35.trialAccounting).toEqual({ priorUniqueTrials: 299, complete: false });
    expect(r2.trialAccounting).toEqual({ priorUniqueTrials: 299, complete: false });
    expect(vtcap.trialAccounting).toEqual({ priorUniqueTrials: 301, complete: false });
    expect(control.candidates).toHaveLength(1);
    expect(r1.candidates).toHaveLength(4);
    expect(r2.candidates).toHaveLength(3);
    const batch = ledger.batches.find((b: any) => b.id === "usdc-control-and-redesign-2026-09-26");
    expect(batch.hypothesisCount).toBe(6);
    expect(batch.inventoryComplete).toBe(false);
    expect(batch.resultsComplete).toBe(false);
    // The verdict must stay an honest NO-VALIDADO (control fails 10/17
    // gates; no redesign candidate beat it on the pre-declared robust
    // criterion) unless a new artifact honestly changes it. The owner rule
    // (sleeve keeps trading on the authoritative control) is part of the
    // recorded verdict, not a validation claim.
    expect(ledger.authoritativeArtifactUsdcControl.verdict).toContain("NO VALIDADO");
    expect(ledger.authoritativeArtifactUsdcControl.verdict).toContain("SIGUE OPERANDO");
    expect(ledger.authoritativeArtifactUsdcControl.usdcControl.gatesFailed).toEqual([
      "looMaxDrawdown", "looMinTotalReturn", "maxDisplacementShare", "maxDrawdown",
      "minBreakEvenSlippageBps", "minExcessReturnVsBench", "minOuterPsr",
      "stressMaxDrawdown", "stressMinSharpe", "stressMinTotalReturn",
    ]);
  });

  test("usdc daily-replant claims align with the eight manifests and the batch (2026-09-26, rounds 3-5)", () => {
    const read = (f: string) => JSON.parse(readFileSync(join(root, "experiments", f), "utf8"));
    const dailyV1 = read("momentum-crypto-usdc-daily-v1.json");
    const w2 = read("momentum-crypto-usdc-control-w2-pure-v1.json");
    const s5 = read("momentum-crypto-usdc-daily-s5-pure-v1.json");
    const s8 = read("momentum-crypto-usdc-daily-s8-pure-v1.json");
    // Cascade declared in the manifests: daily-v1 +2 (301→303), w2 +0,
    // pure chains +0, liquid5 +1 (→304), s5 +1 (→305), s6 +1 (→306),
    // s8 +1 (→307).
    expect(dailyV1.trialAccounting).toEqual({ priorUniqueTrials: 301, complete: false });
    expect(w2.trialAccounting).toEqual({ priorUniqueTrials: 303, complete: false });
    expect(s5.trialAccounting).toEqual({ priorUniqueTrials: 304, complete: false });
    expect(s8.trialAccounting).toEqual({ priorUniqueTrials: 306, complete: false });
    expect(dailyV1.candidates).toHaveLength(2);
    expect(s5.candidates).toHaveLength(1);
    const batch = ledger.batches.find((b: any) => b.id === "usdc-daily-replant-2026-09-26");
    expect(batch.hypothesisCount).toBe(6);
    expect(batch.inventoryComplete).toBe(false);
    expect(batch.resultsComplete).toBe(false);
    // The winner is AUTHORITATIVE but NOT certified — the verdict must keep
    // saying so (it fails maxDrawdown + excess vs BTC) unless a new
    // artifact honestly changes it, and the hourly control's record must
    // keep its supersession note.
    expect(ledger.authoritativeArtifactUsdcDaily.verdict).toContain("NO CERTIFICADO");
    expect(ledger.authoritativeArtifactUsdcDaily.verdict).toContain("GANADOR");
    expect(ledger.authoritativeArtifactUsdcDaily.usdcDaily.gatesFailed).toEqual(["maxDrawdown", "minExcessReturnVsBench"]);
    expect(ledger.authoritativeArtifactUsdcControl.verdict).toContain("SUPERSEDIDO");
    // The wired manifest (liveSleeveConfigs) must be THIS batch's winner.
    expect(ledger.authoritativeArtifactUsdcDaily.manifest).toBe("experiments/momentum-crypto-usdc-daily-s5-pure-v1.json");
  });

  testWithDb("usdc daily winner artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactUsdcDaily.usdcDaily;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      benchReturnPct: round2(s.stitchedOos.benchReturn * 100),
      benchSharpe: round3(s.stitchedOos.benchSharpe),
      excessReturnVsBenchPct: round2((s.stitchedOos.totalReturn - s.stitchedOos.benchReturn) * 100),
      outerPsr: round3(s.outerPsr),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    const normalized = artifactCandidates(ledger.authoritativeArtifactUsdcDaily.path).flatMap(p => {
      try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
    });
    expect(normalized).toContainEqual(claims);
  });

  testWithDb("usdc control pure-chain artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactUsdcControl.usdcControl;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      benchReturnPct: round2(s.stitchedOos.benchReturn * 100),
      benchSharpe: round3(s.stitchedOos.benchSharpe),
      excessReturnVsBenchPct: round2((s.stitchedOos.totalReturn - s.stitchedOos.benchReturn) * 100),
      outerPsr: round3(s.outerPsr),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    const normalized = artifactCandidates(ledger.authoritativeArtifactUsdcControl.path).flatMap(p => {
      try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
    });
    expect(normalized).toContainEqual(claims);
  });

  testWithDb("stocks stop-sizing artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactStocksStopSizing.stocksStopSizing;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      benchReturnPct: round2(s.stitchedOos.benchReturn * 100),
      benchSharpe: round3(s.stitchedOos.benchSharpe),
      excessReturnVsBenchPct: round2((s.stitchedOos.totalReturn - s.stitchedOos.benchReturn) * 100),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    const normalized = artifactCandidates(ledger.authoritativeArtifactStocksStopSizing.path).flatMap(p => {
      try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
    });
    expect(normalized).toContainEqual(claims);
  });

  test("stocks slot-size claims align with the three manifests and the batch (2026-09-27)", () => {
    const control = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-slot125-pure-v2.json"), "utf8"));
    const slot167 = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-slot167-pure-v1.json"), "utf8"));
    const slot20 = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-slot20-pure-v1.json"), "utf8"));
    // Cascade declared in the manifests: base=307 (ledger total after the
    // usdc-daily-replant batch); control is an execution identity (+0,
    // same effective candidate re-run on the fresh 2026-09-28 research DB);
    // slot167 +1 (307->308), slot20 +1 (308->309).
    expect(control.trialAccounting).toEqual({ priorUniqueTrials: 307, complete: false });
    expect(slot167.trialAccounting).toEqual({ priorUniqueTrials: 307, complete: false });
    expect(slot20.trialAccounting).toEqual({ priorUniqueTrials: 308, complete: false });
    expect(control.candidates).toHaveLength(1);
    expect(slot167.candidates).toHaveLength(1);
    expect(slot20.candidates).toHaveLength(1);
    // The gross-cap axis itself: control keeps the live shape (8*0.125=1.0x,
    // no explicit guard needed), the two alternates must carry the SAME
    // 1.0x cap explicitly since 8*slotPct > 1.0x nominal for both.
    expect(control.candidates[0].maxGrossExposureMult).toBeUndefined();
    expect(slot167.candidates[0].maxGrossExposureMult).toBe(1.0);
    expect(slot167.candidates[0].notionalPctPerSlot).toBeCloseTo(1 / 6, 10);
    expect(slot20.candidates[0].maxGrossExposureMult).toBe(1.0);
    expect(slot20.candidates[0].notionalPctPerSlot).toBe(0.20);
    const batch = ledger.batches.find((b: any) => b.id === "stocks-slot-size-2026-09-27");
    expect(batch.hypothesisCount).toBe(2);
    expect(batch.inventoryComplete).toBe(false);
    expect(batch.resultsComplete).toBe(false);
    // The verdict must stay an honest REFUTATION (neither alternate beats
    // the control's CAGR, let alone Sharpe AND maxDD) unless a new artifact
    // honestly changes it.
    expect(ledger.authoritativeArtifactStocksSlotSize.verdict).toContain("REFUTADO");
    expect(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot125Control.gatesFailed).toEqual([]);
    expect(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot167.gatesFailed).toEqual([]);
    expect(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot20.gatesFailed).toEqual([]);
    // All gates pass on all three — the loser is decided by the pre-declared
    // COMPARATIVE criterion (CAGR/Sharpe/maxDD vs control), not by a gate.
    expect(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot125Control.stitchedReturnPct)
      .toBeGreaterThan(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot167.stitchedReturnPct);
    expect(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot125Control.stitchedReturnPct)
      .toBeGreaterThan(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot20.stitchedReturnPct);
    expect(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot125Control.sharpe)
      .toBeGreaterThan(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot167.sharpe);
    expect(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot125Control.sharpe)
      .toBeGreaterThan(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot20.sharpe);
    expect(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot125Control.maxDrawdownPct)
      .toBeLessThan(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot167.maxDrawdownPct);
    expect(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot125Control.maxDrawdownPct)
      .toBeLessThan(ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize.slot20.maxDrawdownPct);
  });

  test("sp500 PIT-universe claims align with the three manifests and the batch (2026-10-02)", () => {
    const m1 = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-sp500pit-top20dv-pure-v1.json"), "utf8"));
    const m2 = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-sp500pit-all-pure-v1.json"), "utf8"));
    const m3 = JSON.parse(readFileSync(join(root, "experiments", "meanrev-sp500pit-pure-v1.json"), "utf8"));
    // Cascade declared in the manifests: base=313 (ledger total after the
    // meanrev-core-2026-09-29 batch); the two live-manifest controls rerun
    // on this base are execution identities (+0); M1 +1 (313→314), M2 +1
    // (314→315), M3 +1 (315→316).
    expect(m1.trialAccounting).toEqual({ priorUniqueTrials: 313, complete: false });
    expect(m2.trialAccounting).toEqual({ priorUniqueTrials: 314, complete: false });
    expect(m3.trialAccounting).toEqual({ priorUniqueTrials: 315, complete: false });
    for (const m of [m1, m2, m3]) {
      expect(m.candidates).toHaveLength(1);
      expect(m.data.membership.index).toBe("sp500");
      expect(m.asOf).toBe("2026-10-02T04:00:00Z");
    }
    // The PIT axis itself: M1 = liquidity-screened members, M2 = all
    // members (same declared ETFs + kernel), M3 = meanrev over members
    // minus the momentum sleeve's 11 symbols (shared-wallet disjunction).
    expect(m1.data.liquidityRank).toEqual({ topN: 20, lookbackSessions: 60 });
    expect(m2.data.liquidityRank).toBeUndefined();
    expect(m1.data.universe).toEqual(["SPY", "QQQ", "IWM", "GLD", "SMH"]);
    expect(m2.data.universe).toEqual(m1.data.universe);
    expect(m3.data.universe).toEqual(["XLE", "XLF", "XLI", "XLP", "XLV", "SLV"]);
    expect(m3.data.membership.exclude.sort()).toEqual(
      ["SPY", "QQQ", "IWM", "GLD", "AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN", "SMH"].sort(),
    );
    // Kernels are the LIVE ones, verbatim (the axis is the universe, nothing else).
    const control = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-slot125-pure-v2.json"), "utf8"));
    const { name: _n1, ...m1Kernel } = m1.candidates[0];
    const { name: _n2, ...m2Kernel } = m2.candidates[0];
    const { name: _nc, ...controlKernel } = control.candidates[0];
    expect(m1Kernel).toEqual(controlKernel);
    expect(m2Kernel).toEqual(controlKernel);
    const mrControl = JSON.parse(readFileSync(join(root, "experiments", "meanrev-slot12-pure-v1.json"), "utf8"));
    const { name: _n3, ...m3Kernel } = m3.candidates[0];
    const { name: _nmc, ...mrControlKernel } = mrControl.candidates[0];
    expect(m3Kernel).toEqual(mrControlKernel);
    const batch = ledger.batches.find((b: any) => b.id === "sp500-pit-universe-2026-10-02");
    expect(batch.hypothesisCount).toBe(3);
    expect(batch.inventoryComplete).toBe(false);
    expect(batch.resultsComplete).toBe(false);
    expect(batch.executionReported).toBe(true);
    expect(batch.sourceCommit).toBe("89b33f0");
    // Results against the pre-registered criterion: all three REFUTED.
    // M1 passes every manifest gate but breaks the DD cap
    // max(control DD + 5pp, 25%); M2 also fails maxDrawdown; M3 fails
    // minOuterPsr, which its control passes.
    const art = ledger.authoritativeArtifactSp500Pit;
    expect(art.verdict).toContain("REFUTADO");
    const c = art.sp500Pit;
    const ddCap = Math.max(c.momentumControl.maxDrawdownPct + 5, 25);
    expect(c.m1Top20dv.gatesFailed).toEqual([]);
    expect(c.m1Top20dv.maxDrawdownPct).toBeGreaterThan(ddCap);
    expect(c.m2All.gatesFailed).toContain("maxDrawdown");
    expect(c.momentumControl.gatesFailed).not.toContain("maxDrawdown");
    expect(c.m3Meanrev.outerPsr).toBeLessThan(0.95);
    expect(c.meanrevControl.gatesFailed).not.toContain("minOuterPsr");
  });

  testWithDb("sp500 PIT-universe artifacts exist on disk and reproduce the ledger claims", () => {
    const claims = ledger.authoritativeArtifactSp500Pit.sp500Pit;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      outerPsr: round3(s.outerPsr),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    for (const [key, path] of Object.entries(ledger.authoritativeArtifactSp500Pit.paths) as [string, string][]) {
      const normalized = artifactCandidates(path).flatMap(p => {
        try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
      });
      expect(normalized).toContainEqual(claims[key]);
    }
  });

  test("crypto fixed-sim claims align with the five manifests and the batch (2026-10-04)", () => {
    // Batch crypto-fixedsim-2026-10-04: first crypto batch AFTER the replay
    // loss-streak fix (f0c08c9) — re-adjudicates the stop axis (execution
    // identities of S4, +0), and runs cooldown-after-stop and slotHysteresis
    // for the first time on the LIVE vt-35 kernel (+3). Control reused:
    // 06e1a160 (same configHash/dataHash/codeHash, +0).
    const files = [
      ["momentum-crypto-fixedsim-stop-fixed8-pure-v1.json", 316, "hardStop"],
      ["momentum-crypto-fixedsim-stop-vol-pure-v1.json", 316, "hardStop"],
      ["momentum-crypto-fixedsim-cooldown4-pure-v1.json", 316, "cooldownBarsAfterStop"],
      ["momentum-crypto-fixedsim-cooldown12-pure-v1.json", 317, "cooldownBarsAfterStop"],
      ["momentum-crypto-fixedsim-hysteresis-pure-v1.json", 318, "slotHysteresis"],
    ] as const;
    const control = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-2026w-control-pure-v1.json"), "utf8"));
    const { name: _cn, ...controlKernel } = control.candidates[0];
    for (const [file, prior, axisKey] of files) {
      const m = JSON.parse(readFileSync(join(root, "experiments", file), "utf8"));
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
      expect(m.candidates).toHaveLength(1);
      expect(m.asOf).toBe("latest");
      expect(m.data).toEqual(control.data);
      expect(m.window).toEqual(control.window);
      expect(m.costs).toEqual(control.costs);
      expect(m.ledger).toEqual(control.ledger);
      expect(m.acceptance).toEqual(control.acceptance);
      // ONE axis changed vs the live kernel, nothing else.
      const { name: _n, [axisKey]: axisValue, ...rest } = m.candidates[0];
      expect(axisValue).toBeDefined();
      expect(rest).toEqual(controlKernel);
    }
    const batch = ledger.batches.find((b: any) => b.id === "crypto-fixedsim-2026-10-04");
    expect(batch.hypothesisCount).toBe(3);
    expect(batch.inventoryComplete).toBe(false);
    expect(batch.resultsComplete).toBe(false);
    expect(batch.executionReported).toBe(true);
    // Results against the pre-registered criterion: all five REFUTED.
    const art = ledger.authoritativeArtifactCryptoFixedSim;
    expect(art.verdict).toContain("REFUTADO");
    const c = art.cryptoFixedSim;
    const srBar = c.control.sharpe + 0.05;
    const ddBar = c.control.maxDrawdownPct + 3;
    // Both stop candidates break the DD cap AND lose Sharpe — the S4
    // direction holds (and widens) under the corrected simulator.
    for (const k of ["stopFixed8", "stopVol"] as const) {
      expect(c[k].sharpe).toBeLessThan(srBar);
      expect(c[k].maxDrawdownPct).toBeGreaterThan(ddBar);
    }
    // cooldown4 keeps DD but loses Sharpe.
    expect(c.cooldown4.sharpe).toBeLessThan(srBar);
    expect(c.cooldown4.maxDrawdownPct).toBeLessThanOrEqual(ddBar);
    // cooldown12 passes 4 of 5 conditions but fails the pre-declared
    // worst-LOO >= 1.0 bar (XRP-dependence, worse than the control's own).
    expect(c.cooldown12.sharpe).toBeGreaterThanOrEqual(srBar);
    expect(c.cooldown12.maxDrawdownPct).toBeLessThanOrEqual(ddBar);
    expect(c.cooldown12.outerPsr).toBeGreaterThanOrEqual(0.95);
    expect(c.cooldown12.gatesFailed).toEqual(["maxDisplacementShare"]);
    expect(c.cooldown12.looWorstSharpe).toBeLessThan(1.0);
    expect(c.cooldown12.looWorstSharpe).toBeLessThan(c.control.looWorstSharpe);
    // hysteresis: the only known point with ZERO failed gates
    // (displacementShare 0), but it pays in Sharpe — refuted again on vt-35.
    expect(c.hysteresis.gatesFailed).toEqual([]);
    expect(c.hysteresis.sharpe).toBeLessThan(srBar);
  });

  testWithDb("crypto fixed-sim artifacts exist on disk and reproduce the ledger claims", () => {
    const claims = ledger.authoritativeArtifactCryptoFixedSim.cryptoFixedSim;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      outerPsr: round3(s.outerPsr),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
      looWorstSharpe: round3(Math.min(...s.loo.map((l: { stitchedSharpe: number }) => l.stitchedSharpe))),
    });
    for (const [key, path] of Object.entries(ledger.authoritativeArtifactCryptoFixedSim.paths) as [string, string][]) {
      const normalized = artifactCandidates(path).flatMap(p => {
        try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
      });
      expect(normalized).toContainEqual(claims[key]);
    }
  });

  test("crypto XS-LS (line A) claims align with the manifest and the batch (2026-10-09)", () => {
    const m = JSON.parse(readFileSync(join(root, "experiments", "crypto-xsls-v1.json"), "utf8"));
    // Base documented in the batch: 323 (ledger total after the gross-cap
    // fidelity diagnostic) + 4 pre-registered candidates -> 327.
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 323, complete: false });
    expect(m.candidates).toHaveLength(4);
    // Universe discipline: dollar-neutral k=5/5, gross 1.0x (10 slots x 0.10),
    // and the declared universe NEVER contains the 8 momentum_crypto perps
    // (shared USDT pool nets per symbol) — BTCUSDT is refSymbol/bench only
    // and the PIT membership rule excludes it from trading.
    for (const c of m.candidates) {
      expect(c.maxLongs).toBe(5);
      expect(c.maxShorts).toBe(5);
      expect(c.notionalPctPerSlot).toBe(0.10);
    }
    for (const sym of ["ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT", "DOGEUSDT", "LINKUSDT"]) {
      expect(m.data.universe).not.toContain(sym);
    }
    expect(m.data.refSymbol).toBe("BTCUSDT");
    const batch = ledger.batches.find((b: any) => b.id === "crypto-xs-ls-2026-10-09");
    expect(batch.hypothesisCount).toBe(4);
    expect(batch.inventoryComplete).toBe(false);
    expect(batch.resultsComplete).toBe(false);
    expect(batch.executionReported).toBe(true);
    // The verdict must stay an honest REFUTATION (fails SS12 criteria
    // 2,3,4,6,7) unless a new pre-registered artifact honestly changes it.
    const art = ledger.authoritativeArtifactCryptoXsLs;
    expect(art.verdict).toContain("REFUTADO");
    expect(art.verdict).toContain("NO SE CABLEA");
    expect(art.cryptoXsLs.gatesFailed).toEqual([
      "looMaxDrawdown", "looMinSharpe", "maxDrawdown", "minBreakEvenSlippageBps",
      "minOuterPsr", "minSharpe", "stressMaxDrawdown", "stressMinSharpe",
    ]);
    expect(art.cryptoXsLs.sharpe).toBeLessThan(1.0);
    expect(art.cryptoXsLs.outerPsr).toBeLessThan(0.95);
    expect(art.cryptoXsLs.maxDrawdownPct).toBeGreaterThan(25);
    expect(art.cryptoXsLs.breakEvenSlippageBps).toBeLessThan(23);
    expect(art.cryptoXsLs.exTopDecileSharpe).toBeLessThan(0.5);
    expect(art.cryptoXsLs.maxYearPnlShare).toBeGreaterThan(0.5);
    // Criterion 5 passed (market-neutral as designed) — recorded as a claim.
    expect(Math.abs(art.cryptoXsLs.corrVsCombined)).toBeLessThanOrEqual(0.30);
  });

  testWithDb("crypto XS-LS artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactCryptoXsLs.cryptoXsLs;
    const normalize = (dir: string) => {
      const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
      const c = JSON.parse(readFileSync(join(dir, "lineA-criteria.json"), "utf8"));
      return {
        outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
        stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
        sharpe: round3(s.stitchedOos.sharpe),
        maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
        outerPsr: round3(s.outerPsr),
        trades: s.stitchedOos.trades,
        gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
        corrVsCombined: round3(c.criteria.c5_correlation.corrVsCombined),
        ordersPerDayOos: round2(c.criteria.c8_ordersPerDay.ordersPerDay),
        breakEvenSlippageBps: round2(s.breakEvenSlippageBps),
        exTopDecileSharpe: round3(c.criteria.c7_robustness.exTopDecile.sharpe),
        maxYearPnlShare: round3(c.criteria.c7_robustness.maxYearShare),
      };
    };
    // Same declared-path-first, any-reproducing-artifact-second policy as the
    // other artifact tests (lineA-criteria.json must sit next to summary.json).
    const declared = join(root, ledger.authoritativeArtifactCryptoXsLs.path);
    const backtestsDir = join(root, "data", "backtests");
    const candidateDirs = existsSync(join(declared, "summary.json"))
      ? [declared]
      : (existsSync(backtestsDir) ? readdirSync(backtestsDir) : [])
          .map(d => join(backtestsDir, d))
          .filter(p => existsSync(join(p, "summary.json")) && existsSync(join(p, "lineA-criteria.json")));
    const normalized = candidateDirs.flatMap(p => {
      try { return [normalize(p)]; } catch { return []; }
    });
    expect(normalized).toContainEqual(claims);
  });

  test("crypto funding-carry (line F2) claims align with the manifest and the batch (2026-10-10)", () => {
    const m = JSON.parse(readFileSync(join(root, "experiments", "crypto-fcarry-v1.json"), "utf8"));
    // Base documented in the batch and in V §12-ter: 351 (323 + B 4 + C 4 +
    // A 4 + B2 4 + E 12) + this lot's 4 closed-grid candidates -> 355
    // (line F runs in parallel on the same base; the director resolves the
    // combined count at integration).
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 351, complete: false });
    expect(m.signal).toBe("fundingCarry");
    expect(m.candidates).toHaveLength(4);
    // The CLOSED §12-ter grid, verbatim: window {3,7}d x rebalance {8h,24h},
    // k=5/5 dollar-neutral, slot 0.10 (gross 1.0x) — no other axis moved.
    const grid = m.candidates.map((c: any) => `${c.lookbackDays}/${c.cadenceMin}`).sort();
    expect(grid).toEqual(["3/1440", "3/480", "7/1440", "7/480"]);
    for (const c of m.candidates) {
      expect(c.maxLongs).toBe(5);
      expect(c.maxShorts).toBe(5);
      expect(c.notionalPctPerSlot).toBe(0.10);
    }
    // Universe/data/costs/window are line A's, byte-identical.
    const a = JSON.parse(readFileSync(join(root, "experiments", "crypto-xsls-v1.json"), "utf8"));
    expect(m.data).toEqual(a.data);
    expect(m.window).toEqual(a.window);
    expect(m.costs).toEqual(a.costs);
    expect(m.acceptance).toEqual(a.acceptance);
    const batch = ledger.batches.find((b: any) => b.id === "crypto-funding-carry-2026-10-10");
    expect(batch.hypothesisCount).toBe(4);
    expect(batch.inventoryComplete).toBe(false);
    expect(batch.resultsComplete).toBe(false);
    expect(batch.executionReported).toBe(true);
    // The verdict must stay an honest REFUTATION (fails SS12 criteria
    // 2,3,4,6,7) unless a new pre-registered artifact honestly changes it —
    // including the honest economic finding: the carry IS harvested
    // (funding >> fees) and the PRICE leg still destroys it.
    const art = ledger.authoritativeArtifactCryptoFundingCarry;
    expect(art.verdict).toContain("REFUTADO");
    expect(art.verdict).toContain("NO SE CABLEA");
    const fc = art.cryptoFundingCarry;
    expect(fc.gatesFailed).toEqual([
      "looMaxDrawdown", "looMinSharpe", "looMinTotalReturn", "maxDrawdown",
      "minBreakEvenSlippageBps", "minFoldsPsrAbove", "minOuterPsr", "minSharpe",
      "minTotalReturn", "stressMaxDrawdown", "stressMinSharpe", "stressMinTotalReturn",
    ]);
    expect(fc.sharpe).toBeLessThan(0);
    expect(fc.outerPsr).toBeLessThan(0.95);
    expect(fc.maxDrawdownPct).toBeGreaterThan(25);
    expect(fc.breakEvenSlippageBps).toBe(0);
    expect(fc.exTopDecileSharpe).toBeLessThan(0.5);
    expect(fc.fundingPnlUsd).toBeGreaterThan(fc.feesUsd); // the carry itself was real
    expect(Math.abs(fc.corrVsCombined)).toBeLessThanOrEqual(0.30);
  });

  testWithDb("crypto funding-carry artifact exists on disk and reproduces the ledger claims", () => {
    const claims = ledger.authoritativeArtifactCryptoFundingCarry.cryptoFundingCarry;
    const normalize = (dir: string) => {
      const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
      const c = JSON.parse(readFileSync(join(dir, "lineA-criteria.json"), "utf8"));
      return {
        outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
        stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
        sharpe: round3(s.stitchedOos.sharpe),
        maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
        outerPsr: round3(s.outerPsr),
        trades: s.stitchedOos.trades,
        gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
        corrVsCombined: round3(c.criteria.c5_correlation.corrVsCombined),
        ordersPerDayOos: round2(c.criteria.c8_ordersPerDay.ordersPerDay),
        breakEvenSlippageBps: round2(s.breakEvenSlippageBps),
        exTopDecileSharpe: round3(c.criteria.c7_robustness.exTopDecile.sharpe),
        maxYearPnlShare: round3(c.criteria.c7_robustness.maxYearShare),
        fundingPnlUsd: round2(s.stitchedOos.funding),
        feesUsd: round2(s.stitchedOos.fees),
      };
    };
    const declared = join(root, ledger.authoritativeArtifactCryptoFundingCarry.path);
    const backtestsDir = join(root, "data", "backtests");
    const candidateDirs = existsSync(join(declared, "summary.json"))
      ? [declared]
      : (existsSync(backtestsDir) ? readdirSync(backtestsDir) : [])
          .map(d => join(backtestsDir, d))
          .filter(p => existsSync(join(p, "summary.json")) && existsSync(join(p, "lineA-criteria.json")));
    const normalized = candidateDirs.flatMap(p => {
      try { return [normalize(p)]; } catch { return []; }
    });
    expect(normalized).toContainEqual(claims);
  });

  test("line-S short-side claims align with the two manifests and both batches (2026-10-10)", () => {
    const s1 = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-shortside-v1.json"), "utf8"));
    const s2 = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-shortside-v1.json"), "utf8"));
    // Base documented in V §12-quinquies: 359 after F2 and F; +4 per lot,
    // twin lots on the same base (director resolves the combined count).
    expect(s1.trialAccounting).toEqual({ priorUniqueTrials: 359, complete: false });
    expect(s2.trialAccounting).toEqual({ priorUniqueTrials: 359, complete: false });
    // Each candidate = its control's kernel + ONLY the §12-quinquies short
    // axes, closed grids verbatim.
    const cCtrl = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-2026w-control-pure-v1.json"), "utf8"));
    const kCtrl = JSON.parse(readFileSync(join(root, "experiments", "momentum-stocks-daily-blend3-k150-exposure-v1.json"), "utf8"));
    const { name: _c, ...cKernel } = cCtrl.candidates[0];
    const { name: _k, ...kKernel } = kCtrl.candidates[0];
    const s1Grid = new Set<string>(), s2Grid = new Set<string>();
    for (const c of s1.candidates) {
      const { maxShorts, shortEntryPct, shortExitPct, shortRegime } = c;
      expect(shortRegime).toEqual({ refSymbol: "BTC/USD", maDays: 200 });
      s1Grid.add(`${maxShorts}|${shortEntryPct}|${shortExitPct}`);
    }
    expect(s1Grid).toEqual(new Set(["2|-5|2", "2|-10|0", "4|-5|2", "4|-10|0"]));
    for (const c of s2.candidates) {
      const { maxShorts, shortEntryPct, shortExitPct, shortRegime, shortUniverse } = c;
      expect(shortRegime).toEqual({ refSymbol: "SPY", maDays: 200 });
      expect(shortUniverse).toEqual(["SPY", "QQQ"]);
      s2Grid.add(`${maxShorts}|${shortEntryPct}|${shortExitPct}`);
    }
    expect(s2Grid).toEqual(new Set(["1|-5|2", "1|-5|0", "2|-5|2", "2|-5|0"]));
    // Kernel identity vs control, axis keys aside (maxShorts moves 0→grid).
    for (const c of s1.candidates) {
      const { name: _n, maxShorts: _ms, shortEntryPct: _se, shortExitPct: _sx, shortRegime: _sr, ...rest } = c;
      expect({ ...rest, maxShorts: 0 }).toEqual(cKernel);
    }
    for (const c of s2.candidates) {
      const { name: _n, maxShorts: _ms, shortEntryPct: _se, shortExitPct: _sx, shortRegime: _sr, shortUniverse: _su, ...rest } = c;
      expect({ ...rest, maxShorts: 0 }).toEqual(kKernel);
    }
    // S2 adds ONLY shortBorrow 0.5%/yr on top of the control's costs.
    expect(s2.costs.base.shortBorrow).toEqual({ annualRate: 0.005 });
    expect(s2.costs.stress.shortBorrow).toEqual({ annualRate: 0.005 });
    expect(s1.costs).toEqual(cCtrl.costs);
    for (const id of ["short-side-crypto-2026-10-10", "short-side-stocks-2026-10-10"]) {
      const batch = ledger.batches.find((b: any) => b.id === id);
      expect(batch.hypothesisCount).toBe(4);
      expect(batch.inventoryComplete).toBe(false);
      expect(batch.resultsComplete).toBe(false);
      expect(batch.executionReported).toBe(true);
    }
    // Verdicts must stay honest REFUTATIONS: the redesigned short side
    // SUBTRACTS in both portfolios (criteria 2/4/5 fail in both; 3 also
    // fails on crypto), unless a new pre-registered artifact changes it.
    const a1 = ledger.authoritativeArtifactShortSideCrypto;
    const a2 = ledger.authoritativeArtifactShortSideStocks;
    for (const a of [a1, a2]) {
      expect(a.verdict).toContain("REFUTADO");
      expect(a.verdict).toContain("NO SE CABLEA");
    }
    expect(a1.shortSideCrypto.sharpe).toBeLessThan(a1.shortSideCrypto.control.sharpe);
    expect(a1.shortSideCrypto.maxDrawdownPct).toBeGreaterThan(a1.shortSideCrypto.control.maxDrawdownPct);
    expect(a1.shortSideCrypto.shortPnlNetUsd).toBeLessThan(0);
    expect(a1.shortSideCrypto.stressSharpe).toBeLessThan(a1.shortSideCrypto.control.stressSharpe);
    expect(a2.shortSideStocks.sharpe).toBeLessThan(a2.shortSideStocks.control.sharpe);
    expect(a2.shortSideStocks.maxDrawdownPct).toBeLessThanOrEqual(a2.shortSideStocks.control.maxDrawdownPct);
    expect(a2.shortSideStocks.shortPnlNetUsd).toBeLessThan(0);
    expect(a2.shortSideStocks.stressSharpe).toBeLessThan(a2.shortSideStocks.control.stressSharpe);
  });

  testWithDb("line-S artifacts exist on disk and reproduce the ledger claims", () => {
    const normalize = (dir: string) => {
      const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
      const c = JSON.parse(readFileSync(join(dir, "lineS-criteria.json"), "utf8"));
      return {
        outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
        stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
        sharpe: round3(s.stitchedOos.sharpe),
        maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
        outerPsr: round3(s.outerPsr),
        trades: s.stitchedOos.trades,
        stressSharpe: round3(s.acceptance.stressMinSharpe.value),
        shortTrades: c.criteria.c4_shortNetPnlPositive.shortTrades,
        shortPnlNetUsd: round2(c.criteria.c4_shortNetPnlPositive.shortPnlNetUsd),
        bearRegimeShare: round3(c.reported.bearRegime.share),
        ordersPerDayAdded: round2(c.reported.ordersPerDayAdded),
      };
    };
    for (const key of ["authoritativeArtifactShortSideCrypto", "authoritativeArtifactShortSideStocks"] as const) {
      const art = ledger[key];
      const { control: _ctrl, ...claims } = key === "authoritativeArtifactShortSideCrypto" ? art.shortSideCrypto : art.shortSideStocks;
      const declared = join(root, art.path);
      const backtestsDir = join(root, "data", "backtests");
      const candidateDirs = existsSync(join(declared, "summary.json"))
        ? [declared]
        : (existsSync(backtestsDir) ? readdirSync(backtestsDir) : [])
            .map(d => join(backtestsDir, d))
            .filter(p => existsSync(join(p, "summary.json")) && existsSync(join(p, "lineS-criteria.json")));
      const normalized = candidateDirs.flatMap(p => {
        try { return [normalize(p)]; } catch { return []; }
      });
      expect(normalized).toContainEqual(claims);
    }
  });

  test("line S-bis claims align with the two manifests and both batches (2026-10-10)", () => {
    const s1b = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-shortside-stop-v1.json"), "utf8"));
    const s3 = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-usdc-shortside-v1.json"), "utf8"));
    // Base documented in V §12-sexies: 367 after line S; +4 per twin lot.
    expect(s1b.trialAccounting).toEqual({ priorUniqueTrials: 367, complete: false });
    expect(s3.trialAccounting).toEqual({ priorUniqueTrials: 367, complete: false });
    // S1b: control kernel + fixed short config ((−5,+2), maxShorts 4,
    // regime BTC<SMA200) and ONLY the shortStop axis varying, grid verbatim.
    const cCtrl = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-2026w-control-pure-v1.json"), "utf8"));
    const { name: _c, ...cKernel } = cCtrl.candidates[0];
    const stops = s1b.candidates.map((c: any) => JSON.stringify(c.shortStop));
    expect(new Set(stops).size).toBe(4);
    for (const c of s1b.candidates) {
      expect(c.maxShorts).toBe(4);
      expect(c.shortEntryPct).toBe(-5);
      expect(c.shortExitPct).toBe(2);
      expect(c.shortRegime).toEqual({ refSymbol: "BTC/USD", maDays: 200 });
      const { name: _n, maxShorts: _ms, shortEntryPct: _se, shortExitPct: _sx, shortRegime: _sr, shortStop: _ss, ...rest } = c;
      expect({ ...rest, maxShorts: 0 }).toEqual(cKernel);
    }
    expect(stops).toContain(JSON.stringify({ mode: "fixed", pct: 0.08 }));
    expect(stops).toContain(JSON.stringify({ mode: "fixed", pct: 0.12 }));
    expect(stops).toContain(JSON.stringify({ mode: "fixed", pct: 0.25 }));
    expect(stops).toContain(JSON.stringify({ mode: "volScaled", kSigma: 3, lookbackDays: 20, minPct: 6, maxPct: 20 }));
    // S3: USDC control kernel + regime + the maxShorts × thresholds grid; the
    // shorts share the longs' wide vol stops (NO shortStop key).
    const uCtrl = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-usdc-daily-s5-pure-v1.json"), "utf8"));
    const { name: _u, ...uKernel } = uCtrl.candidates[0];
    const s3Grid = new Set<string>();
    for (const c of s3.candidates) {
      expect(c.shortRegime).toEqual({ refSymbol: "BTC/USD", maDays: 200 });
      expect(c.shortStop).toBeUndefined();
      s3Grid.add(`${c.maxShorts}|${c.shortEntryPct}|${c.shortExitPct}`);
      const { name: _n, maxShorts: _ms, shortEntryPct: _se, shortExitPct: _sx, shortRegime: _sr, ...rest } = c;
      expect({ ...rest, maxShorts: 0 }).toEqual(uKernel);
    }
    expect(s3Grid).toEqual(new Set(["2|-5|2", "2|-10|0", "3|-5|2", "3|-10|0"]));
    for (const id of ["short-side-bis-crypto-stop-2026-10-10", "short-side-bis-usdc-2026-10-10"]) {
      const batch = ledger.batches.find((b: any) => b.id === id);
      expect(batch.hypothesisCount).toBe(4);
      expect(batch.inventoryComplete).toBe(false);
      expect(batch.resultsComplete).toBe(false);
      expect(batch.executionReported).toBe(true);
      // The §12-sexies closure rides the batch evidence: three designs
      // tried, the short side of these strategies is CLOSED pending a new idea.
      expect(batch.evidence).toContain("CERRADO");
    }
    // Verdicts stay honest REFUTATIONS with the mechanism finding pinned:
    // S1b shows the loss REDISTRIBUTES into signal exits once the stop
    // widens (3/182 stop-outs and still negative) — S's "signal exits won"
    // was conditional on the 4% stop absorbing the losers.
    const a1 = ledger.authoritativeArtifactShortSideBisCrypto;
    const a2 = ledger.authoritativeArtifactShortSideBisUsdc;
    for (const a of [a1, a2]) {
      expect(a.verdict).toContain("REFUTADO");
      expect(a.verdict).toContain("NO SE CABLEA");
      expect(a.verdict).toContain("CERRADO");
    }
    expect(a1.shortSideBisCrypto.sharpe).toBeLessThan(a1.shortSideBisCrypto.control.sharpe);
    expect(a1.shortSideBisCrypto.shortPnlNetUsd).toBeLessThan(0);
    expect(a2.shortSideBisUsdc.sharpe).toBeLessThan(a2.shortSideBisUsdc.control.sharpe);
    expect(a2.shortSideBisUsdc.maxDrawdownPct).toBeGreaterThan(a2.shortSideBisUsdc.control.maxDrawdownPct);
    expect(a2.shortSideBisUsdc.shortPnlNetUsd).toBeLessThan(0);
  });

  testWithDb("line S-bis artifacts exist on disk and reproduce the ledger claims", () => {
    const normalize = (dir: string) => {
      const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
      const c = JSON.parse(readFileSync(join(dir, "lineS-criteria.json"), "utf8"));
      return {
        outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
        stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
        sharpe: round3(s.stitchedOos.sharpe),
        maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
        outerPsr: round3(s.outerPsr),
        trades: s.stitchedOos.trades,
        stressSharpe: round3(s.acceptance.stressMinSharpe.value),
        shortTrades: c.criteria.c4_shortNetPnlPositive.shortTrades,
        shortPnlNetUsd: round2(c.criteria.c4_shortNetPnlPositive.shortPnlNetUsd),
        bearRegimeShare: round3(c.reported.bearRegime.share),
        ordersPerDayAdded: round2(c.reported.ordersPerDayAdded),
      };
    };
    for (const [key, claimsKey] of [["authoritativeArtifactShortSideBisCrypto", "shortSideBisCrypto"], ["authoritativeArtifactShortSideBisUsdc", "shortSideBisUsdc"]] as const) {
      const art = ledger[key];
      const { control: _ctrl, ...claims } = art[claimsKey];
      const declared = join(root, art.path);
      const backtestsDir = join(root, "data", "backtests");
      const candidateDirs = existsSync(join(declared, "summary.json"))
        ? [declared]
        : (existsSync(backtestsDir) ? readdirSync(backtestsDir) : [])
            .map(d => join(backtestsDir, d))
            .filter(p => existsSync(join(p, "summary.json")) && existsSync(join(p, "lineS-criteria.json")));
      const normalized = candidateDirs.flatMap(p => {
        try { return [normalize(p)]; } catch { return []; }
      });
      expect(normalized).toContainEqual(claims);
    }
  });

  testWithDb("stocks slot-size artifacts exist on disk and reproduce the ledger claims", () => {
    const claims = ledger.authoritativeArtifactStocksSlotSize.stocksSlotSize;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      outerPsr: round3(s.outerPsr),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    for (const [key, path] of Object.entries(ledger.authoritativeArtifactStocksSlotSize.paths) as [string, string][]) {
      const normalized = artifactCandidates(path).flatMap(p => {
        try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
      });
      expect(normalized).toContainEqual(claims[key]);
    }
  });

  test("line H claims preserve the closed preregistration and count exactly four trials (380->384)", () => {
    const h = JSON.parse(readFileSync(join(root, "experiments/crypto-drop-reversal-v1.json"), "utf8"));
    const a = JSON.parse(readFileSync(join(root, "experiments/crypto-xsls-v1.json"), "utf8"));
    expect(h.trialAccounting).toEqual({ priorUniqueTrials: 380, complete: false });
    expect(h.candidates.map((c: any) => `${c.entryPct}/${c.exitPct}`).sort()).toEqual(["3/12", "3/4", "4/12", "4/4"]);
    for (const c of h.candidates) {
      expect(c.maxLongs).toBe(5); expect(c.maxShorts).toBe(0);
      expect(c.notionalPctPerSlot).toBe(0.2); expect(c.cadenceMin).toBe(60);
    }
    for (const k of ["data", "window", "costs", "acceptance", "asOf"]) expect(h[k]).toEqual(a[k]);
    expect(h.ledger.initialEquity).toBe(1600);
    const batch = ledger.batches.find((b: any) => b.id === "crypto-drop-reversal-linea-h-2026-10-14");
    expect(batch).toMatchObject({ hypothesisCount: 4, priorUniqueTrials: 380, resultingUniqueTrials: 384,
      inventoryComplete: false, resultsComplete: false, executionReported: true });
    expect(batch.sourceCommit).toContain("5961abc");
    const art = ledger.authoritativeArtifactCryptoDropReversal;
    expect(art.verdict).toContain("REFUTADO"); expect(art.verdict).toContain("NO SE CABLEA");
    expect(art.cryptoDropReversal.sharpe).toBeLessThan(0);
    expect(art.cryptoDropReversal.stressSharpe).toBeLessThan(0);
    expect(art.cryptoDropReversal.maxDrawdownPct).toBeGreaterThan(25);
    expect(art.cryptoDropReversal.breakEvenSlippageBps).toBeLessThan(23);
    expect(art.cryptoDropReversal.exTopDecileSharpe).toBeLessThan(0.5);
  });

  // Source DB (not artifact presence) gates the evidence check: deleting H's
  // evidence on this research host must fail, while clean CI can skip it.
  const withPerpsDb = existsSync(researchDataPath("hist-perps.db")) && researchDbExists ? test : test.skip;
  withPerpsDb("line H artifact reproduces ledger numbers, BTC blocks and exact exit times", () => {
    const art = ledger.authoritativeArtifactCryptoDropReversal;
    const dir = join(root, art.path);
    const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    const c = JSON.parse(readFileSync(join(dir, "lineH-criteria.json"), "utf8")).criteria;
    const d = JSON.parse(readFileSync(join(dir, "lineH-diagnostics.json"), "utf8"));
    expect({
      outerFoldReturnsPct: s.outerTests.map((t: any) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100), sharpe: round3(s.stitchedOos.sharpe),
      stressSharpe: round3(s.acceptance.stressMinSharpe.value), maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      outerPsr: round3(s.outerPsr), trades: s.stitchedOos.trades,
      orders: c.c8_ordersPerDay.orders, ordersPerDayOos: round2(c.c8_ordersPerDay.ordersPerDay),
      breakEvenSlippageBps: round2(s.breakEvenSlippageBps), corrVsCombined: round3(c.c5_correlation.corrVsCombined),
      exTopDecileSharpe: round3(c.c7_robustness.exTopDecile.sharpe), maxYearPnlShare: round3(c.c7_robustness.maxYearShare),
      signals: d.diagnostics.reduce((sum: number, p: any) => sum + p.signals, 0),
      btcBlocked: d.diagnostics.reduce((sum: number, p: any) => sum + p.btcBlocked, 0),
      delayedExits: d.diagnostics.reduce((sum: number, p: any) => sum + p.delayedExits, 0),
      rebound12hPct: round3(d.rebound.find((r: any) => r.hour === 12).mean * 100),
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    }).toEqual(art.cryptoDropReversal);
    expect(s.outerSelection.map((t: any) => t.candidateName)).toEqual(Array(3).fill("drop-k3-h12"));
    expect(s.loo).toHaveLength(357);
    expect(s.dataHash).toBe("faaf7c21db5103201801b0aeadc85e013519b2434ac32ef3ab47955bc840ffaf");
    const records = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const seen = new Set<string>();
    let trades = 0;
    for (const r of records) {
      if (r.costTier !== "base" || !/^\d+\/test$/.test(r.foldPath) || seen.has(r.foldPath)) continue;
      seen.add(r.foldPath);
      for (const t of r.result.closedTrades) {
        expect(t.exitAt - t.entryAt).toBe(12 * 3_600_000);
        expect(t.reason).toBe("time_exit"); expect(t.symbol).not.toBe("BTCUSDT");
        trades++;
      }
    }
    expect(trades).toBe(2297);
    const pnlSum = Object.values(d.pnlBySymbol).reduce((sum: number, p: any) => sum + p.netPnl, 0);
    expect(pnlSum).toBeCloseTo(1600 * s.stitchedOos.totalReturn, 8);
  });

  // Line C (intraday SPY/QQQ) reads its own external DB (hist-intraday.db in
  // the research data dir, outside the repo — scripts/lib/researchData.ts),
  // so it needs that DB AND, like every artifact check above, a checkout that
  // carries data/ with its artifacts: an exported tree on a host that has the
  // research DB has no data/backtests to read (first public sync after line
  // C, 2026-10-14).
  const intradayDbExists = existsSync(researchDataPath("hist-intraday.db"));
  const testWithIntradayDb = researchDbExists && intradayDbExists ? test : test.skip;

  testWithIntradayDb("intraday SPY/QQQ (line C) artifact exists on disk and reproduces the ledger claim: REFUTADO", () => {
    const claims = ledger.authoritativeArtifactIntradaySpyQqq.intradaySpyQqq;
    const round2 = (x: number) => Math.round(x * 100) / 100;
    const round3 = (x: number) => Math.round(x * 1000) / 1000;
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      outerPsr: round3(s.outerPsr),
      correlation: round3(s.correlationWithLivePortfolio),
      spySharpe: round3(s.perSymbol.SPY.sharpe),
      qqqSharpe: round3(s.perSymbol.QQQ.sharpe),
      ordersPerDay: round2(s.ordersPerDay),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    const declared = join(root, ledger.authoritativeArtifactIntradaySpyQqq.path, "summary.json");
    const backtestsDir = join(root, "data", "backtests");
    const candidatePaths = existsSync(declared)
      ? [declared]
      : (existsSync(backtestsDir) ? readdirSync(backtestsDir) : [])
          .map(d => join(backtestsDir, d, "summary.json"))
          .filter(p => existsSync(p));
    const normalized = candidatePaths.flatMap(p => {
      try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
    });
    // stressSharpe isn't persisted as a single stitched figure in summary.json
    // (only per-fold stress metrics are) — it is cited in the batch's prose
    // and reproduced by the kernel's console output, not by this disk check.
    const { stressSharpe, ...claimsWithoutStress } = claims;
    expect(normalized).toContainEqual(claimsWithoutStress);
    expect(ledger.authoritativeArtifactIntradaySpyQqq.verdict).toContain("REFUTADO");
  });

  test("lines G0/G close-reversal claims align with the two manifests and both batches (2026-10-14)", () => {
    const g0 = JSON.parse(readFileSync(join(root, "experiments", "meanrev-close-exec-v1.json"), "utf8"));
    const g = JSON.parse(readFileSync(join(root, "experiments", "stocks-close-reversal-v1.json"), "utf8"));
    // Cascade pre-registered in V-plan §12-septies: base 375 (after lines
    // S/S-bis) → G0 +1 = 376 → G +4 = 380.
    expect(g0.trialAccounting).toEqual({ priorUniqueTrials: 375, complete: false });
    expect(g0.candidates).toHaveLength(1);
    expect(g0.candidates[0].meanrev.execution).toBe("close1545");
    expect(g0.data.sliceDb).toBe("$UC_RESEARCH_DATA_DIR/hist-sp500-close.db");
    expect(g.trialAccounting).toEqual({ priorUniqueTrials: 376, complete: false });
    expect(g.candidates).toHaveLength(4);
    expect(g.candidates.every((c: any) => c.closeReversal !== undefined)).toBe(true);
    expect(g.candidates.map((c: any) => c.closeReversal.exit)).toEqual(["nextOpen", "nextClose", "sma5", "nextOpen"]);
    expect(g.candidates[3].closeReversal.short).toEqual({ entryRsi: 95 });
    for (const [id, n] of [["meanrev-close-exec-2026-10-14", 1], ["stocks-close-reversal-2026-10-14", 4]] as const) {
      const batch = ledger.batches.find((b: any) => b.id === id);
      expect(batch.hypothesisCount).toBe(n);
      expect(batch.inventoryComplete).toBe(false);
      expect(batch.resultsComplete).toBe(false);
      expect(batch.executionReported).toBe(true);
    }
    // Verdicts stay honest: G0 flipped to a REFUTATION after the director's
    // stop-ordering fidelity fix (intraday stops fire BEFORE the 15:45
    // decision — conservative under unknown low timing): the conservative
    // chain improves on the control (+0.061 Sharpe, −0.7pp DD) but misses
    // the pre-registered +0.10 bar. The superseded optimistic chain (which
    // credited the close to 8 stop-touched trades) passed all 5 — pinned so
    // the sensitivity of the verdict to execution ordering stays recorded.
    const g0a = ledger.authoritativeArtifactMeanrevCloseExec;
    expect(g0a.verdict).toContain("REFUTADO");
    expect(g0a.verdict).toContain("NO SE CABLEA");
    const mce = g0a.meanrevCloseExec;
    expect(mce.sharpe).toBeLessThan(mce.control.sharpe + 0.1); // the failed criterion 2
    expect(mce.sharpe).toBeGreaterThan(mce.control.sharpe); // still an improvement, honestly short of the bar
    expect(mce.maxDrawdownPct).toBeLessThanOrEqual(mce.control.maxDrawdownPct + 2);
    expect(mce.stressSharpe).toBeGreaterThanOrEqual(mce.control.stressSharpe);
    expect(mce.outerPsr).toBeGreaterThanOrEqual(0.95);
    expect(mce.supersededOptimistic.sharpe).toBeGreaterThanOrEqual(mce.control.sharpe + 0.1);
    const ga = ledger.authoritativeArtifactCloseReversal;
    expect(ga.verdict).toContain("REFUTADO");
    expect(ga.verdict).toContain("NO SE CABLEA");
    expect(ga.closeReversal.nightPnlUsd).toBeGreaterThan(0);
    expect(ga.closeReversal.dayPnlUsd).toBeLessThan(0);
    expect(ga.closeReversal.g4InnerShortPnlUsd).toBeLessThan(0);
  });

  testWithDb("lines G0/G artifacts exist on disk and reproduce the ledger claims", () => {
    const normalize = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      outerPsr: round3(s.outerPsr),
      trades: s.stitchedOos.trades,
      gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
    });
    for (const [key, claimsKey] of [["authoritativeArtifactMeanrevCloseExec", "meanrevCloseExec"], ["authoritativeArtifactCloseReversal", "closeReversal"]] as const) {
      const art = ledger[key];
      const claims = art[claimsKey];
      const expected = {
        outerFoldReturnsPct: claims.outerFoldReturnsPct,
        stitchedReturnPct: claims.stitchedReturnPct,
        sharpe: claims.sharpe,
        maxDrawdownPct: claims.maxDrawdownPct,
        outerPsr: claims.outerPsr,
        trades: claims.trades,
        gatesFailed: [...claims.gatesFailed].sort(),
      };
      const normalized = artifactCandidates(art.path).flatMap(p => {
        try { return [normalize(JSON.parse(readFileSync(p, "utf8")))]; } catch { return []; }
      });
      expect(normalized).toContainEqual(expected);
    }
  });

  // RW rewrite (docs/reports/RW-reescritura-rentable.md): three designs
  // pre-registered before any run, chained 384 → 388 → 392 → 396, each failed
  // by its own §2.5 criteria. The binding verdict is rw-criteria.json, written
  // next to summary.json by scripts/portfolio-criteria.ts.
  const rwDesigns = [
    ["authoritativeArtifactRwD1", "rwD1", "rw-d1-xasset-etf-trend-v1.json", 384, "rw-d1-xasset-etf-trend-2026-10-21"],
    ["authoritativeArtifactRwD2", "rwD2", "rw-d2-sp500-core-v1.json", 388, "rw-d2-sp500-core-2026-10-21"],
    ["authoritativeArtifactRwD3", "rwD3", "rw-d3-crypto-daily-trend-v1.json", 392, "rw-d3-crypto-daily-trend-2026-10-21"],
  ] as const;

  test("RW designs D1/D2/D3 align with their manifests and batches, and stay honest failures (2026-10-21)", () => {
    for (const [key, claimsKey, manifestFile, prior, batchId] of rwDesigns) {
      const m = JSON.parse(readFileSync(join(root, "experiments", manifestFile), "utf8"));
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
      expect(m.candidates).toHaveLength(4);
      expect(m.candidates.every((c: any) => c.portfolio !== undefined)).toBe(true);
      const batch = ledger.batches.find((b: any) => b.id === batchId);
      expect(batch.hypothesisCount).toBe(m.candidates.length);
      expect(batch.priorUniqueTrials).toBe(prior);
      expect(batch.resultingUniqueTrials).toBe(prior + m.candidates.length);
      expect(batch.inventoryComplete).toBe(false);
      expect(batch.resultsComplete).toBe(false);
      expect(batch.executionReported).toBe(true);
      const art = ledger[key];
      expect(art.verdict).toContain("REFUTADO");
      expect(art.verdict).toContain("NO SE CABLEA");
      // C4 is the common failure: the signal never beat the same book always on.
      expect(art[claimsKey].c4StrategySharpe).toBeLessThan(art[claimsKey].c4PassiveSharpe);
      expect(art[claimsKey].criteriaFailed).toContain("C4_vsPassive");
    }
  });

  testWithDb("RW designs D1/D2/D3 artifacts exist on disk and reproduce the ledger claims", () => {
    const normalize = (dir: string) => {
      const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
      const c = JSON.parse(readFileSync(join(dir, "rw-criteria.json"), "utf8"));
      const criteria: any[] = Array.isArray(c.criteria) ? c.criteria : Object.values(c.criteria);
      return {
        outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
        stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
        sharpe: round3(s.stitchedOos.sharpe),
        maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
        outerPsr: round3(s.outerPsr),
        trades: s.stitchedOos.trades,
        criteriaFailed: criteria.filter(x => x.pass === false).map(x => x.id).sort(),
        criteriaVerdict: c.verdict,
      };
    };
    for (const [key, claimsKey] of rwDesigns) {
      const art = ledger[key];
      const claims = art[claimsKey];
      const expected = {
        outerFoldReturnsPct: claims.outerFoldReturnsPct,
        stitchedReturnPct: claims.stitchedReturnPct,
        sharpe: claims.sharpe,
        maxDrawdownPct: claims.maxDrawdownPct,
        outerPsr: claims.outerPsr,
        trades: claims.trades,
        criteriaFailed: [...claims.criteriaFailed].sort(),
        criteriaVerdict: claims.criteriaVerdict,
      };
      const normalized = artifactCandidates(art.path)
        .map(p => join(p, ".."))
        .filter(dir => existsSync(join(dir, "rw-criteria.json")))
        .flatMap(dir => {
          try { return [normalize(dir)]; } catch { return []; }
        });
      expect(normalized).toContainEqual(expected);
    }
  });

  // RW2 "exposición eficiente" (docs/reports/RW-reescritura-rentable.md §8–9): the three
  // always-invested redesigns, chained 396 → 398 → 400 → 402, each judged against its current
  // sleeve rerun on the same data (R3). Binding verdict: rw2-criteria.json next to summary.json.
  const rw2Designs = [
    ["authoritativeArtifactRw2E1", "rw2E1", "rw2-e1-stocks-volmanaged-v1.json", 396, "rw2-e1-stocks-volmanaged-2026-10-21", true],
    ["authoritativeArtifactRw2E2", "rw2E2", "rw2-e2-meanrev-volmanaged-v1.json", 398, "rw2-e2-meanrev-volmanaged-2026-10-21", true],
    ["authoritativeArtifactRw2E3", "rw2E3", "rw2-e3-usdc-volmanaged-v1.json", 400, "rw2-e3-usdc-volmanaged-2026-10-21", false],
  ] as const;

  test("RW2 designs E1/E2/E3 align with their manifests and batches; E1 and E2 pass, E3 is refuted (2026-10-21)", () => {
    for (const [key, claimsKey, manifestFile, prior, batchId, passes] of rw2Designs) {
      const m = JSON.parse(readFileSync(join(root, "experiments", manifestFile), "utf8"));
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
      expect(m.candidates).toHaveLength(2);
      expect(m.candidates.every((c: any) => c.portfolio?.strategy?.kind === "volManaged" && c.portfolio.strategy.maxGross === 1)).toBe(true);
      const batch = ledger.batches.find((b: any) => b.id === batchId);
      expect(batch.hypothesisCount).toBe(m.candidates.length);
      expect(batch.priorUniqueTrials).toBe(prior);
      expect(batch.resultingUniqueTrials).toBe(prior + m.candidates.length);
      expect(batch.inventoryComplete).toBe(false);
      expect(batch.resultsComplete).toBe(false);
      expect(batch.executionReported).toBe(true);
      const art = ledger[key];
      const claims = art[claimsKey];
      expect(art.verdict).toContain(passes ? "VALIDADO" : "REFUTADO");
      expect(claims.criteriaFailed.length === 0).toBe(passes);
      // R3: not below the current sleeve on the same days, exactly as pre-registered.
      expect(claims.r3StrategySharpe >= claims.r3ControlSharpe).toBe(passes);
      if (passes) expect(claims.maxDrawdownPct).toBeLessThanOrEqual(25);
    }
  });

  testWithDb("RW2 designs E1/E2/E3 artifacts exist on disk and reproduce the ledger claims", () => {
    const normalize = (dir: string) => {
      const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
      const c = JSON.parse(readFileSync(join(dir, "rw2-criteria.json"), "utf8"));
      const criteria: any[] = Array.isArray(c.criteria) ? c.criteria : Object.values(c.criteria);
      const r3 = criteria.find(x => x.id === "R3_vsControl");
      return {
        outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
        stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
        sharpe: round3(s.stitchedOos.sharpe),
        maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
        outerPsr: round3(s.outerPsr),
        criteriaFailed: criteria.filter(x => x.pass === false).map(x => x.id).sort(),
        r3StrategySharpe: round3(r3.detail.strategySharpe),
        r3ControlSharpe: round3(r3.detail.controlSharpe),
        r3CommonDays: r3.detail.commonDays,
      };
    };
    for (const [key, claimsKey] of rw2Designs) {
      const art = ledger[key];
      const claims = art[claimsKey];
      const expected = {
        outerFoldReturnsPct: claims.outerFoldReturnsPct,
        stitchedReturnPct: claims.stitchedReturnPct,
        sharpe: claims.sharpe,
        maxDrawdownPct: claims.maxDrawdownPct,
        outerPsr: claims.outerPsr,
        criteriaFailed: [...claims.criteriaFailed].sort(),
        r3StrategySharpe: claims.r3StrategySharpe,
        r3ControlSharpe: claims.r3ControlSharpe,
        r3CommonDays: claims.r3CommonDays,
      };
      const normalized = artifactCandidates(art.path)
        .map(p => join(p, ".."))
        .filter(dir => existsSync(join(dir, "rw2-criteria.json")))
        .flatMap(dir => {
          try { return [normalize(dir)]; } catch { return []; }
        });
      expect(normalized).toContainEqual(expected);
    }
  });

  // ── RW3 "más agresivo" (docs/reports/RW-reescritura-rentable.md §10) + COPY D4 (§11.1) ──
  // Trials 402 → 424, chained across seven batches. The manifests were pre-registered before any run.
  // (a)/(b): R1–R7 from rw2-criteria.json against the live sleeve re-run; (c1)/(c2): the §10.4
  // criteria derived from summary.json + the same-days comparison + the combined book; D4: rw-criteria.json.
  const rw3Portfolio = [
    // batch, authoritative key, claims key, manifests (prior each), [candidate, volTarget, maxGross]
    ["rw3-a-e1-stocks-lev-2026-10-23", "authoritativeArtifactRw3E1Lev", "rw3E1Lev", "e1Rerun", 402,
      [["rw3-e1-stocks-lev-vt20-g150-v1.json", "vt20-g150", 0.2, 1.5], ["rw3-e1-stocks-lev-vt25-g150-v1.json", "vt25-g150", 0.25, 1.5],
       ["rw3-e1-stocks-lev-vt25-g200-v1.json", "vt25-g200", 0.25, 2], ["rw3-e1-stocks-lev-vt30-g200-v1.json", "vt30-g200", 0.3, 2]], "vt30-g200"],
    ["rw3-a-e2-meanrev-lev-2026-10-23", "authoritativeArtifactRw3E2Lev", "rw3E2Lev", "e2", 406,
      [["rw3-e2-meanrev-lev-vt20-g150-v1.json", "vt20-g150", 0.2, 1.5], ["rw3-e2-meanrev-lev-vt25-g150-v1.json", "vt25-g150", 0.25, 1.5],
       ["rw3-e2-meanrev-lev-vt25-g200-v1.json", "vt25-g200", 0.25, 2], ["rw3-e2-meanrev-lev-vt30-g200-v1.json", "vt30-g200", 0.3, 2]], "vt30-g200"],
    ["rw3-b-levetf-book-2026-10-23", "authoritativeArtifactRw3Etf", "rw3Etf", "e1Rerun", 410,
      [["rw3-e1-levetf-vt20-v1.json", "vt20", 0.2, 1], ["rw3-e1-levetf-vt30-v1.json", "vt30", 0.3, 1], ["rw3-e1-levetf-vt40-v1.json", "vt40", 0.4, 1]], "vt40"],
  ] as const;
  // [batch, manifest, candidate, prior, volTarget, correlationCeiling | undefined, maxGrossExposureMult | undefined]
  const rw3C1Manifests = [
    ["rw3-c1-momentum-crypto-2026-10-23", "momentum-crypto-rw3-vt-50-pure-v1.json", "vt-50", 413, 50, undefined, 2.5875],
    ["rw3-c1-momentum-crypto-2026-10-23", "momentum-crypto-rw3-vt-70-pure-v1.json", "vt-70", 414, 70, undefined, 2.5875],
    ["rw3-c1-momentum-crypto-2026-10-23", "momentum-crypto-rw3-vt-35-corr92-pure-v1.json", "vt-35-corr92", 415, 35, 0.92, undefined],
    ["rw3-c1-momentum-crypto-2026-10-23", "momentum-crypto-rw3-vt-50-corr92-pure-v1.json", "vt-50-corr92", 416, 50, 0.92, 2.5875],
    ["rw3-c1-corroff-2026-10-23", "momentum-crypto-rw3-vt-35-corroff-pure-v1.json", "vt-35-corr92", 419, 35, 1.01, undefined],
  ] as const;
  const rw3C2Manifests = [
    ["momentum-crypto-usdc-daily-s5-rw3-vt50-pure-v1.json", "d13-s5-vt50", 417, 50],
    ["momentum-crypto-usdc-daily-s5-rw3-vt70-pure-v1.json", "d13-s5-vt70", 418, 70],
  ] as const;
  const rw3Batches = ledger.batches.filter((b: any) => /^(rw3-|copy-d4-)/.test(b.id));

  // §10.4 (c1)/(c2) criteria on the ledger's own candidate rows. maxDdPct: 45 for c1, the control's DD for c2.
  const rw3KernelMeets = (c: any, controlGatesFailed: string[], maxDdPct: number) =>
    c.sharpeCommonDays >= c.controlSharpeCommonDays &&
    c.maxDrawdownPct <= maxDdPct &&
    c.outerPsr >= 0.95 &&
    c.foldPsr.filter((p: number) => p > 0.5).length >= 2 &&
    c.worstLooRatio >= 0.6 &&
    c.combinedBookMaxDrawdownPct <= 20 &&
    c.gatesFailed.every((g: string) => controlGatesFailed.includes(g));

  test("RW3 (a)/(b)/(c1)/(c2) and COPY D4 align with their manifests and batches; only c1 corroff passes, D4's C4 defect is recorded (2026-10-23)", () => {
    // Seven batches chained 402 → 424.
    expect(rw3Batches.map((b: any) => b.id)).toEqual([
      "rw3-a-e1-stocks-lev-2026-10-23", "rw3-a-e2-meanrev-lev-2026-10-23", "rw3-b-levetf-book-2026-10-23",
      "rw3-c1-momentum-crypto-2026-10-23", "rw3-c2-usdc-vt-2026-10-23", "rw3-c1-corroff-2026-10-23", "copy-d4-insider-clusters-2026-10-23",
    ]);
    expect(rw3Batches.map((b: any) => b.hypothesisCount)).toEqual([4, 4, 3, 4, 2, 1, 4]);
    let prev = 402;
    for (const b of rw3Batches) {
      expect(b.priorUniqueTrials).toBe(prev);
      expect(b.resultingUniqueTrials).toBe(prev + b.hypothesisCount);
      expect(b.inventoryComplete).toBe(false);
      expect(b.resultsComplete).toBe(false);
      expect(b.executionReported).toBe(true);
      for (const p of b.sourcePaths) expect(sourcePathPresent(p)).toBe(true);
      prev = b.resultingUniqueTrials;
    }
    expect(prev).toBe(424);
    expect(rw3Batches.at(-1).resultingUniqueTrials).toBe(424);

    // (a)/(b): one candidate per manifest, one axis (vol target, maxGross), chained priors.
    for (const [batchId, key, claimsKey, , prior, manifests, best] of rw3Portfolio) {
      const batch = ledger.batches.find((b: any) => b.id === batchId);
      expect(batch.priorUniqueTrials).toBe(prior);
      expect(batch.hypothesisCount).toBe(manifests.length);
      manifests.forEach(([file, cand, vt, gross], i) => {
        const m = JSON.parse(readFileSync(join(root, "experiments", file), "utf8"));
        expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior + i, complete: false });
        expect(m.candidates).toHaveLength(1);
        expect(m.candidates[0].name).toBe(cand);
        expect(m.candidates[0].portfolio.strategy).toMatchObject({ kind: "volManaged", portfolioVolTarget: vt, maxGross: gross });
        expect(batch.sourcePaths).toContain(`experiments/${file}`);
      });
      // Every frontier point fails the owner's drawdown budget and R3: frontier references, not candidates.
      const art = ledger[key];
      expect(art.verdict).toContain("REFERENCIA DE FRONTERA");
      expect(art.verdict).toContain("REFUTADO");
      expect(art.verdict).toContain("NO SE CABLEA");
      expect(art.frontier.map((p: any) => p.candidate)).toEqual(manifests.map(m => m[1]));
      for (const p of art.frontier) expect(p.criteriaFailed).toEqual(["R2_maxDrawdown", "R3_vsControl"]);
      expect(art[claimsKey].criteriaFailed).toEqual(["R2_maxDrawdown", "R3_vsControl"]);
      expect(art[claimsKey].maxDrawdownPct).toBeGreaterThan(25);
      expect(art[claimsKey].r3StrategySharpe).toBeLessThan(art[claimsKey].r3ControlSharpe);
      // The referenced point is the family's best return.
      const top = [...art.frontier].sort((a: any, b: any) => b.stitchedReturnPct - a.stitchedReturnPct)[0];
      expect(top.candidate).toBe(best);
      expect(art.path).toContain(top.artifact);
    }
    expect(ledger.authoritativeArtifactRw3E1Lev.rw3E1Lev.controlArtifact).toBe("33b0ac05");
    expect(ledger.authoritativeArtifactRw3E2Lev.rw3E2Lev.controlArtifact).toBe("0b088ca3");
    expect(ledger.authoritativeArtifactRw3Etf.rw3Etf.controlArtifact).toBe("33b0ac05");

    // (c1): five candidates, the pinned control at +0; exactly one passes every §10.4 criterion.
    const ctl = ledger.rw3Controls;
    expect(ctl.trialsAdded).toBe(0);
    const control = JSON.parse(readFileSync(join(root, "experiments", "momentum-crypto-rw3-control-vt35-pure-v1.json"), "utf8"));
    expect(control.trialAccounting.priorUniqueTrials).toBe(402);
    expect(control.candidates[0].regime?.correlationCeiling).toBeUndefined();
    for (const [batchId, file, cand, prior, vt, ceiling, cap] of rw3C1Manifests) {
      const m = JSON.parse(readFileSync(join(root, "experiments", file), "utf8"));
      expect(m.asOf).toBe("2026-10-02T08:00:00Z");
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
      expect(m.candidates).toHaveLength(1);
      expect(m.candidates[0].name).toBe(cand);
      expect(m.candidates[0].volTarget.annualizedPct).toBe(vt);
      expect(m.candidates[0].regime?.correlationCeiling).toBe(ceiling);
      expect(m.candidates[0].maxGrossExposureMult).toBe(cap);
      expect(ledger.batches.find((b: any) => b.id === batchId).sourcePaths).toContain(`experiments/${file}`);
    }
    const c1 = ledger.authoritativeArtifactRw3C1;
    expect(c1.verdict).toContain("VALIDADO");
    expect(c1.candidates.map((c: any) => c.candidate)).toEqual(["vt-50", "vt-70", "vt-35-corr92", "vt-50-corr92", "vt-35-corroff"]);
    expect(c1.candidates.filter((c: any) => rw3KernelMeets(c, ctl.controls.cryptoPinned.gatesFailed, 45)).map((c: any) => c.candidate)).toEqual(c1.passingCandidates);
    expect(c1.passingCandidates).toEqual(["vt-35-corroff"]);
    const w = c1.rw3C1;
    expect(c1.path).toContain("efc086b4");
    expect(w.candidateOnCommonDays.sharpe).toBeGreaterThanOrEqual(w.controlOnCommonDays.sharpe);
    expect(w.maxDrawdownPct).toBeLessThanOrEqual(45);
    expect(w.outerPsr).toBeGreaterThanOrEqual(0.95);
    expect(w.gatesFailed).toEqual(["maxDisplacementShare"]); // the same failed gate as the control
    expect(c1.control.gatesFailed).toEqual(["maxDisplacementShare"]);
    expect(w.combined.maxDrawdown).toBeLessThanOrEqual(0.2);
    // The near miss stays recorded as a miss: corr92 alone loses 0.008 Sharpe to the control.
    expect(c1.candidates.find((c: any) => c.candidate === "vt-35-corr92").sharpeCommonDays).toBeLessThan(c1.control.candidateOnCommonDays.sharpe);

    // (c2): both below the control's Sharpe; the referenced point is the best return.
    const c2 = ledger.authoritativeArtifactRw3C2;
    expect(c2.verdict).toContain("REFUTADO");
    expect(c2.verdict).toContain("NO SE CABLEA");
    expect(c2.passingCandidates).toEqual([]);
    expect(c2.candidates.filter((c: any) => rw3KernelMeets(c, ctl.controls.usdc.gatesFailed, c2.control.maxDrawdownPct)).map((c: any) => c.candidate)).toEqual([]);
    for (const c of c2.candidates) expect(c.sharpeCommonDays).toBeLessThan(c.controlSharpeCommonDays);
    const topC2 = [...c2.candidates].sort((a: any, b: any) => b.stitchedReturnPct - a.stitchedReturnPct)[0];
    expect(topC2.candidate).toBe("d13-s5-vt70");
    expect(c2.path).toContain(topC2.artifact);
    const rwBatchC2 = ledger.batches.find((b: any) => b.id === "rw3-c2-usdc-vt-2026-10-23");
    for (const [file, cand, prior, vt] of rw3C2Manifests) {
      const m = JSON.parse(readFileSync(join(root, "experiments", file), "utf8"));
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
      expect(m.candidates[0].name).toBe(cand);
      expect(m.candidates[0].volTarget.annualizedPct).toBe(vt);
      expect(m.candidates[0].maxGrossExposureMult).toBe(2.3);
      expect(rwBatchC2.sourcePaths).toContain(`experiments/${file}`);
    }

    // D4: refuted by C1, C2, C3, C5, C6b; the C4 pass is recorded as invalid, not hidden.
    const d4m = JSON.parse(readFileSync(join(root, "experiments", "copy-d4-insider-clusters-v1.json"), "utf8"));
    expect(d4m.trialAccounting).toEqual({ priorUniqueTrials: 420, complete: false });
    expect(d4m.candidates.map((c: any) => [c.name, c.portfolio.strategy.holdSessions, c.portfolio.strategy.minDistinctInsiders])).toEqual(
      [["A-h21", 21, 2], ["A-h63", 63, 2], ["A-h126", 126, 2], ["A-c3-h21", 21, 3]]);
    expect(rw3Batches.at(-1).sourcePaths).toContain("experiments/copy-d4-insider-clusters-v1.json");
    const d4 = ledger.authoritativeArtifactCopyD4;
    expect(d4.verdict).toContain("REFUTADO");
    expect(d4.verdict).toContain("NO SE CABLEA");
    expect(d4.copyD4.criteriaFailed).toEqual(["C1_psr", "C2_maxDrawdown", "C3_stressSharpe", "C5_vsMarket", "C6b_exTopDecile"]);
    expect(d4.copyD4.criteriaPassed).toEqual(["C4_vsPassive", "C6_yearShare", "C7_breakEvenExtraBps"]);
    expect(d4.copyD4.c4Passive).toBe(0);
    expect(d4.copyD4.c4Pass).toBe(true); // what rw-criteria.json says
    expect(d4.defect).toMatchObject({ id: "C4_passiveSharpeExactlyZero", c4PassIsValid: false, verdictDependsOnC4: false });
    expect(rw3Batches.at(-1).evidence).toContain("INVALIDO");
    expect(rw3Batches.at(-1).evidence).toContain("EXACTAMENTE 0");
  });

  testWithDb("RW3 and COPY D4 artifacts exist on disk and reproduce the ledger claims", () => {
    const round4 = (x: number) => Math.round(x * 10000) / 10000;
    const pct2 = (x: number) => Math.round(x * 10000) / 100; // round to 4 dp, then percent
    const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
    const backtests = join(root, "data", "backtests");
    const dirOf = (prefix: string) => {
      const d = readdirSync(backtests).find(x => x.startsWith(prefix));
      if (!d) throw new Error(`artifact ${prefix} not found under data/backtests`);
      return join(backtests, d);
    };
    const dirOfPath = (declared: string) => dirOf(declared.replace(/^data\/backtests\//, "").replace(/\/$/, "").slice(0, 8));
    const perf = (p: any) => ({ sharpe: round4(p.sharpe), totalReturn: round4(p.totalReturn), cagr: round4(p.cagr), maxDrawdown: round4(p.maxDrawdown) });
    const base = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => round2(t.result.totalReturn * 100)),
      stitchedReturnPct: round2(s.stitchedOos.totalReturn * 100),
      sharpe: round3(s.stitchedOos.sharpe),
      maxDrawdownPct: round2(s.stitchedOos.maxDrawdown * 100),
      outerPsr: round3(s.outerPsr),
    });
    const ctlDir = (k: string) => dirOfPath(ledger.rw3Controls.controls[k].path);
    // Fixed-capital combined book (§10.4): E1 re-run, E2, crypto, USDC, aligned OOS sessions.
    const combinedMemo = new Map<string, { commonDays: number; totalReturn: number; maxDrawdown: number }>();
    const combined = (crypto: string, usdc: string) => {
      const memoKey = `${crypto}|${usdc}`;
      const hit = combinedMemo.get(memoKey);
      if (hit) return hit;
      const books: Array<[string, number]> = [[ctlDir("e1Rerun"), 50000], [ctlDir("e2"), 50000], [crypto, 5000], [usdc, 5000]];
      const maps = books.map(([d]) => new Map(loadArtifactOuterDailyReturns(d).map(x => [x.date, x.ret] as [string, number])));
      const dates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
      let eq = books.map(b => b[1]);
      let peak = eq.reduce((a, b) => a + b, 0);
      let maxDd = 0;
      for (const d of dates) {
        eq = eq.map((e, i) => e * (1 + (maps[i].get(d) ?? 0)));
        const tot = eq.reduce((a, b) => a + b, 0);
        peak = Math.max(peak, tot);
        maxDd = Math.max(maxDd, (peak - tot) / peak);
      }
      const result = { commonDays: dates.length, totalReturn: round4(eq.reduce((a, b) => a + b, 0) / books.reduce((a, b) => a + b[1], 0) - 1), maxDrawdown: round4(maxDd) };
      combinedMemo.set(memoKey, result);
      return result;
    };

    // Controls (+0, no trial).
    const dataHashOf = (dir: string) => readJson(join(dir, "summary.json")).dataHash.slice(0, 8);
    for (const [k, gates] of [["e1Rerun", false], ["e2", false], ["cryptoPinned", true], ["usdc", true]] as const) {
      const claims = ledger.rw3Controls.controls[k];
      const dir = ctlDir(k);
      const s = readJson(join(dir, "summary.json"));
      expect(claims.artifact).toBe(dir.split("/").pop()!.slice(0, 8));
      expect(claims.dataHash).toBe(dataHashOf(dir));
      expect({ outerFoldReturnsPct: claims.outerFoldReturnsPct, stitchedReturnPct: claims.stitchedReturnPct, sharpe: claims.sharpe, maxDrawdownPct: claims.maxDrawdownPct, outerPsr: claims.outerPsr }).toEqual(base(s));
      if (gates) expect(claims.gatesFailed).toEqual(Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort());
    }
    {
      const claims = ledger.rw3Controls.controls.e1Rerun;
      const c = readJson(join(ctlDir("e1Rerun"), "rw2-criteria.json"));
      expect(claims.criteriaFailed).toEqual((Object.values(c.criteria) as any[]).filter(x => x.pass === false).map(x => x.id).sort());
      expect(claims.selectedPerFold).toEqual(c.reported.outerSelection.map((x: any) => x.candidateName));
    }

    // (a)/(b): full R1–R7 claims for the referenced point, compact claims for every frontier point.
    const portfolioClaims = (dir: string, controlDir: string) => {
      const s = readJson(join(dir, "summary.json"));
      const c = readJson(join(dir, "rw2-criteria.json"));
      const cr: any[] = Object.values(c.criteria);
      const r3 = cr.find(x => x.id === "R3_vsControl");
      const cmp = compareArtifacts(dir, controlDir, 252);
      return {
        ...base(s),
        trades: s.stitchedOos.trades,
        criteriaFailed: cr.filter(x => x.pass === false).map(x => x.id).sort(),
        criteriaVerdict: c.verdict,
        selectedPerFold: c.reported.outerSelection.map((x: any) => x.candidateName),
        r3StrategySharpe: round3(r3.detail.strategySharpe),
        r3ControlSharpe: round3(r3.detail.controlSharpe),
        r3CommonDays: r3.detail.commonDays,
        controlArtifact: controlDir.split("/").pop()!.slice(0, 8),
        stressSharpe: round3(cr.find(x => x.id === "R4_stressSharpe").value),
        maxYearPnlShare: round3(cr.find(x => x.id === "R5_yearShare").value),
        exTopDecileSharpe: round3(cr.find(x => x.id === "R6_exTopDecile").value),
        meanGross: round3(c.reported.avgGross),
        ordersPerSessionOos: round2(c.reported.ordersPerSession),
        turnoverAnnual: round2(c.reported.turnoverAnnual),
        marginInterestUsd: Math.round(c.reported.marginInterest),
        strategyOnCommonDays: perf(cmp.candidate),
        controlOnCommonDays: perf(cmp.control),
      };
    };
    for (const [, key, claimsKey, controlKey, , manifests] of rw3Portfolio) {
      const art = ledger[key];
      const controlDir = ctlDir(controlKey);
      expect(art[claimsKey]).toEqual(portfolioClaims(dirOfPath(art.path), controlDir));
      expect(art.frontier).toHaveLength(manifests.length);
      for (const p of art.frontier) {
        const dir = dirOf(p.artifact);
        const v = portfolioClaims(dir, controlDir);
        // The artifact was produced by the pre-registered manifest, in order.
        expect(readJson(join(dir, "manifest-resolved.json")).name).toBe(manifests[art.frontier.indexOf(p)][0].replace(/\.json$/, ""));
        expect(p).toEqual({
          candidate: p.candidate, artifact: p.artifact, stitchedReturnPct: v.stitchedReturnPct, sharpe: v.sharpe, maxDrawdownPct: v.maxDrawdownPct,
          cagrPctCommonDays: pct2(v.strategyOnCommonDays.cagr), meanGross: v.meanGross, marginInterestUsd: v.marginInterestUsd, criteriaFailed: v.criteriaFailed,
        });
        expect(v.selectedPerFold.every((n: string) => n === p.candidate)).toBe(true);
      }
      // Same data as the control (the ETF book has its own universe, so its hash differs by construction).
      if (key !== "authoritativeArtifactRw3Etf") expect(dataHashOf(dirOfPath(art.path))).toBe(dataHashOf(controlDir));
    }

    // (c1)/(c2): summary.json + same-days comparison + combined book.
    const kernelClaims = (dir: string, controlDir: string, comb?: ReturnType<typeof combined>) => {
      const s = readJson(join(dir, "summary.json"));
      const cmp = compareArtifacts(dir, controlDir, 365);
      const worst = Math.min(...s.loo.map((l: any) => l.stitchedSharpe));
      return {
        selected: s.selectedCandidate.name,
        ...base(s),
        trades: s.stitchedOos.trades,
        foldPsr: s.foldPsr.map((f: any) => round3(f.psr)),
        gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
        worstLooSharpe: round3(worst),
        worstLooRatio: round3(worst / s.stitchedOos.sharpe),
        controlArtifact: controlDir.split("/").pop()!.slice(0, 8),
        commonDays: cmp.commonDays, from: cmp.from, to: cmp.to,
        candidateOnCommonDays: perf(cmp.candidate),
        controlOnCommonDays: perf(cmp.control),
        deltaSharpe: round3(cmp.deltaSharpe),
        combined: comb,
      };
    };
    const compact = (name: string, dir: string, v: ReturnType<typeof kernelClaims> & { combined: ReturnType<typeof combined> }) => ({
      candidate: name, artifact: dir.split("/").pop()!.slice(0, 8),
      stitchedReturnPct: v.stitchedReturnPct, sharpe: v.sharpe, maxDrawdownPct: v.maxDrawdownPct, outerPsr: v.outerPsr, foldPsr: v.foldPsr,
      worstLooRatio: v.worstLooRatio, gatesFailed: v.gatesFailed, commonDays: v.commonDays,
      sharpeCommonDays: v.candidateOnCommonDays.sharpe, controlSharpeCommonDays: v.controlOnCommonDays.sharpe,
      cagrPctCommonDays: pct2(v.candidateOnCommonDays.cagr), maxDrawdownPctCommonDays: pct2(v.candidateOnCommonDays.maxDrawdown),
      combinedBookMaxDrawdownPct: pct2(v.combined.maxDrawdown),
    });
    const cryptoCtl = ctlDir("cryptoPinned");
    const usdcCtl = ctlDir("usdc");
    const c1 = ledger.authoritativeArtifactRw3C1;
    const c1Control = kernelClaims(cryptoCtl, cryptoCtl, combined(cryptoCtl, usdcCtl));
    expect(c1.control).toEqual(c1Control);
    for (const p of c1.candidates) {
      const dir = dirOf(p.artifact);
      const v = { ...kernelClaims(dir, cryptoCtl, combined(dir, usdcCtl)), combined: combined(dir, usdcCtl) };
      expect(p).toEqual(compact(p.candidate, dir, v));
      expect(dataHashOf(dir)).toBe(dataHashOf(cryptoCtl));
      // Re-derive the §10.4 verdict from the artifacts, not from the ledger's own rows.
      expect(rw3KernelMeets(compact(p.candidate, dir, v), c1Control.gatesFailed, 45)).toBe(c1.passingCandidates.includes(p.candidate));
    }
    expect(c1.rw3C1).toEqual(kernelClaims(dirOfPath(c1.path), cryptoCtl, combined(dirOfPath(c1.path), usdcCtl)));
    expect(c1.rw3C1.combined.maxDrawdown).toBeLessThanOrEqual(0.2);
    expect(c1.control.combined.maxDrawdown).toBeLessThan(c1.rw3C1.combined.maxDrawdown);

    const c2 = ledger.authoritativeArtifactRw3C2;
    const c2Control = kernelClaims(usdcCtl, usdcCtl);
    expect(c2.control).toEqual(c2Control);
    for (const p of c2.candidates) {
      const dir = dirOf(p.artifact);
      const v = { ...kernelClaims(dir, usdcCtl, combined(cryptoCtl, dir)), combined: combined(cryptoCtl, dir) };
      expect(p).toEqual(compact(p.candidate, dir, v));
      expect(dataHashOf(dir)).toBe(dataHashOf(usdcCtl));
      expect(rw3KernelMeets(compact(p.candidate, dir, v), c2Control.gatesFailed, c2Control.maxDrawdownPct)).toBe(false);
    }
    const c2Top = dirOfPath(c2.path);
    expect(c2.rw3C2).toEqual(kernelClaims(c2Top, usdcCtl, combined(cryptoCtl, c2Top)));

    // D4: summary.json + rw-criteria.json, including the C4 defect.
    const d4 = ledger.authoritativeArtifactCopyD4;
    const d4Dir = dirOfPath(d4.path);
    const s = readJson(join(d4Dir, "summary.json"));
    const c = readJson(join(d4Dir, "rw-criteria.json"));
    const cr: any[] = Object.values(c.criteria);
    const claims = d4.copyD4;
    expect({
      outerFoldReturnsPct: claims.outerFoldReturnsPct, stitchedReturnPct: claims.stitchedReturnPct, sharpe: claims.sharpe, maxDrawdownPct: claims.maxDrawdownPct, outerPsr: claims.outerPsr,
    }).toEqual(base(s));
    expect(claims.trades).toBe(s.stitchedOos.trades);
    expect(claims.benchSharpe).toBe(round3(s.stitchedOos.benchSharpe));
    expect(claims.benchReturnPct).toBe(round2(s.stitchedOos.benchReturn * 100));
    expect(claims.criteriaFailed).toEqual(cr.filter(x => x.pass === false).map(x => x.id).sort());
    expect(claims.criteriaPassed).toEqual(cr.filter(x => x.pass === true).map(x => x.id).sort());
    expect(claims.criteriaVerdict).toBe(c.verdict);
    expect(claims.selectedPerFold).toEqual(c.reported.outerSelection.map((x: any) => x.candidateName));
    expect([claims.c1, claims.c2, claims.c3, claims.c6, claims.c6b]).toEqual([c.criteria.C1.value, c.criteria.C2.value, c.criteria.C3.value, c.criteria.C6.value, c.criteria.C6b.value].map(round3));
    expect([claims.c4Strategy, claims.c5Market, claims.c5Value]).toEqual([c.criteria.C4.detail.strategySharpe, c.criteria.C5.detail.marketSharpe, c.criteria.C5.value].map(round3));
    expect(claims.c8).toBe(c.criteria.C8.pass); // null: external, never computed
    // The defect: the passive benchmark's Sharpe is exactly 0, so C4's pass is not evidence.
    expect(c.criteria.C4.detail.passiveSharpe).toBe(0);
    expect(claims.c4Passive).toBe(0);
    expect(claims.c4Obs).toBe(c.criteria.C4.detail.observations);
    expect(c.criteria.C4.pass).toBe(true);
    // The verdict stands without C4: five other criteria fail on their own.
    expect(cr.filter(x => x.id !== "C4_vsPassive" && x.pass === false).map(x => x.id).sort()).toEqual(claims.criteriaFailed);
  }, 120_000); // ~25 artifact reads plus eight combined-book rebuilds

  // ── RW4 b/a (docs/reports/RW-reescritura-rentable.md §14 and §13) ──
  // Trials 424 → 428 (RW4b, four E1 leveraged-with-brake chains) → 431 (RW4a c1, momentum_crypto) → 435 (RW4a c2, USDC).
  // The manifests were pre-registered before any run. RW4b fails R3 in all four; RW4a c1 fails in all three;
  // RW4a c2 has ONE chain that meets every §13.4 criterion by a hair, and it is NOT wired (replication and the
  // Binance scalePosition come first).
  // §13.4 criteria for the RW4a kernels: one id per failed criterion, from a compact row and the control's failed gates.
  // (R3 = Sharpe on the common days; DD_commonDays = drawdown on the common days not worse than the control's;
  // DD_sleeveGate = the sleeve's own gate: 45% in c1, the control's own drawdown in c2; the rest as §13.4.)
  const rw4aCriteriaFailed = (c: any, controlGatesFailed: string[], sleeveMaxDdPct: number): string[] =>
    ([
      ["R3_sharpeCommonDays", c.sharpeCommonDays < c.controlSharpeCommonDays],
      ["DD_commonDays", c.maxDrawdownPctCommonDays > c.controlMaxDrawdownPctCommonDays],
      ["DD_sleeveGate", c.maxDrawdownPct > sleeveMaxDdPct],
      ["PSR", c.outerPsr < 0.95],
      ["foldPsr", c.foldPsr.filter((p: number) => p > 0.5).length < 2],
      ["worstLoo", c.worstLooRatio < 0.6],
      ["combinedBookDD", c.combinedBookMaxDrawdownPct > 20],
      ["acceptanceGates", c.gatesFailed.some((g: string) => !controlGatesFailed.includes(g))],
    ] as Array<[string, boolean]>).filter(([, failed]) => failed).map(([id]) => id);

  // ── RW4 recompute helpers: artifacts on disk → the claims the ledger records ──
  const rw4Calc = () => {
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const r4 = (x: number) => Math.round(x * 10000) / 10000;
    const pct2 = (x: number) => Math.round(x * 10000) / 100; // round to 4 dp, then percent
    const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
    const backtests = join(root, "data", "backtests");
    const dirOf = (prefix: string) => {
      const d = readdirSync(backtests).find(x => x.startsWith(prefix));
      if (!d) throw new Error(`artifact ${prefix} not found under data/backtests`);
      return join(backtests, d);
    };
    const dirOfPath = (declared: string) => dirOf(declared.replace(/^data\/backtests\//, "").replace(/\/$/, "").slice(0, 8));
    const short = (dir: string) => dir.split("/").pop()!.slice(0, 8);
    const perf = (p: any) => ({ sharpe: r4(p.sharpe), totalReturn: r4(p.totalReturn), cagr: r4(p.cagr), maxDrawdown: r4(p.maxDrawdown) });
    const base = (s: any) => ({
      outerFoldReturnsPct: s.outerTests.map((t: { result: { totalReturn: number } }) => r2(t.result.totalReturn * 100)),
      stitchedReturnPct: r2(s.stitchedOos.totalReturn * 100),
      sharpe: r3(s.stitchedOos.sharpe),
      maxDrawdownPct: r2(s.stitchedOos.maxDrawdown * 100),
      outerPsr: r3(s.outerPsr),
    });
    const seriesMemo = new Map<string, Map<string, number>>();
    const series = (dir: string) => {
      let m = seriesMemo.get(dir);
      if (!m) { m = new Map(loadArtifactOuterDailyReturns(dir).map(x => [x.date, x.ret] as [string, number])); seriesMemo.set(dir, m); }
      return m;
    };
    const dataHashOf = (dir: string) => readJson(join(dir, "summary.json")).dataHash.slice(0, 8);
    const ids = { e1: "33b0ac05", e2: "0b088ca3", crypto: "efc086b4", usdc: "d0f7fd6f" };
    const dirs = { e1: dirOf(ids.e1), e2: dirOf(ids.e2), crypto: dirOf(ids.crypto), usdc: dirOf(ids.usdc) };

    // §13.4: fixed-capital combined book (50k/50k/5k/5k), series aligned by OOS session.
    const combinedMemo = new Map<string, { commonDays: number; totalReturn: number; maxDrawdown: number }>();
    const combined = (crypto: string, usdc: string) => {
      const memoKey = `${crypto}|${usdc}`;
      const hit = combinedMemo.get(memoKey);
      if (hit) return hit;
      const books: Array<[string, number]> = [[dirs.e1, 50000], [dirs.e2, 50000], [crypto, 5000], [usdc, 5000]];
      const maps = books.map(([d]) => series(d));
      const dates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
      let eq = books.map(b => b[1]);
      let peak = eq.reduce((a, b) => a + b, 0);
      let maxDd = 0;
      for (const d of dates) {
        eq = eq.map((e, i) => e * (1 + (maps[i].get(d) ?? 0)));
        const tot = eq.reduce((a, b) => a + b, 0);
        peak = Math.max(peak, tot);
        maxDd = Math.max(maxDd, (peak - tot) / peak);
      }
      const result = { commonDays: dates.length, totalReturn: r4(eq.reduce((a, b) => a + b, 0) / books.reduce((a, b) => a + b[1], 0) - 1), maxDrawdown: r4(maxDd) };
      combinedMemo.set(memoKey, result);
      return result;
    };

    // §13.6: what the control cost in orders, from summary.json → outerTests[].result.exposureStats.
    const exposureOf = (s: any) => {
      const xs: any[] = s.outerTests.map((t: any) => t.result.exposureStats);
      if (xs.some(x => !x)) return undefined;
      const sum = (k: string) => xs.reduce((a, x) => a + x[k], 0);
      return {
        resizes: sum("resizes"), reductions: sum("reductions"), addBacks: sum("addBacks"), deferredUp: sum("deferredUp"),
        resizeNotionalUsd: Math.round(sum("resizeNotionalUsd")),
        resizesPerFold: xs.map(x => x.resizes),
        meanScalePerFold: xs.map(x => r3(x.meanScale)),
        minScale: r3(Math.min(...xs.map(x => x.minScale))),
        pctTicksBelowOne: r2((100 * sum("ticksBelowOne")) / sum("ticks")),
      };
    };
    const kernelClaims = (dir: string, controlDir: string, comb: ReturnType<typeof combined>) => {
      const s = readJson(join(dir, "summary.json"));
      const cmp = compareArtifacts(dir, controlDir, 365);
      const worst = Math.min(...s.loo.map((l: any) => l.stitchedSharpe));
      const exposure = exposureOf(s);
      return {
        selected: s.selectedCandidate.name,
        ...base(s),
        trades: s.stitchedOos.trades,
        foldPsr: s.foldPsr.map((f: any) => r3(f.psr)),
        gatesFailed: Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort(),
        worstLooSharpe: r3(worst),
        worstLooRatio: r3(worst / s.stitchedOos.sharpe),
        dataHash: s.dataHash.slice(0, 8),
        feesUsd: Math.round(s.stitchedOos.fees),
        controlArtifact: short(controlDir),
        commonDays: cmp.commonDays, from: cmp.from, to: cmp.to,
        candidateOnCommonDays: perf(cmp.candidate),
        controlOnCommonDays: perf(cmp.control),
        deltaSharpe: r3(cmp.deltaSharpe),
        combined: comb,
        ...(exposure ? { exposure } : {}),
      };
    };
    type KernelClaims = ReturnType<typeof kernelClaims>;
    const rw4aRow = (dir: string, v: KernelClaims, control: KernelClaims, sleeveMaxDdPct: number) => {
      const row = {
        candidate: v.selected, artifact: short(dir),
        stitchedReturnPct: v.stitchedReturnPct, sharpe: v.sharpe, maxDrawdownPct: v.maxDrawdownPct, outerPsr: v.outerPsr, foldPsr: v.foldPsr,
        worstLooRatio: v.worstLooRatio, gatesFailed: v.gatesFailed, commonDays: v.commonDays,
        sharpeCommonDays: v.candidateOnCommonDays.sharpe, controlSharpeCommonDays: v.controlOnCommonDays.sharpe,
        cagrPctCommonDays: pct2(v.candidateOnCommonDays.cagr), controlCagrPctCommonDays: pct2(v.controlOnCommonDays.cagr),
        maxDrawdownPctCommonDays: pct2(v.candidateOnCommonDays.maxDrawdown), controlMaxDrawdownPctCommonDays: pct2(v.controlOnCommonDays.maxDrawdown),
        combinedBookMaxDrawdownPct: pct2(v.combined.maxDrawdown),
        feesUsd: v.feesUsd, controlFeesUsd: control.feesUsd,
        ...(v.exposure ? { exposure: v.exposure } : {}),
      };
      return { ...row, criteriaFailed: rw4aCriteriaFailed(row, control.gatesFailed, sleeveMaxDdPct) };
    };

    // §14.3: A1 (account = E1 variant + E2, $50k each, no reallocation) recomputed from the two chains.
    const account = (dir: string) => {
      const mine = series(dir), e1 = series(dirs.e1), e2 = series(dirs.e2);
      const common = [...mine.keys()].filter(d => e1.has(d) && e2.has(d)).sort();
      const run = (a: Map<string, number>) => {
        let ea = 1, eb = 1, peak = 1, maxDd = 0;
        for (const d of common) {
          ea *= 1 + a.get(d)!; eb *= 1 + e2.get(d)!;
          const equity = (ea + eb) / 2;
          peak = Math.max(peak, equity);
          maxDd = Math.max(maxDd, (peak - equity) / peak);
        }
        return r4(maxDd);
      };
      return { commonDays: common.length, candidateMaxDrawdown: run(mine), controlMaxDrawdown: run(e1) };
    };
    const rw4bClaims = (dir: string) => {
      const s = readJson(join(dir, "summary.json"));
      const c = readJson(join(dir, "rw4b-criteria.json"));
      const cr: any[] = Object.values(c.criteria);
      const cmp = compareArtifacts(dir, dirs.e1, 252);
      const acct = account(dir);
      const window = (w: any) => ({
        sleeveMaxDrawdownPct: pct2(w.detail.candidate.sleeve.maxDrawdown), accountMaxDrawdownPct: pct2(w.detail.candidate.account.maxDrawdown),
        controlSleeveMaxDrawdownPct: pct2(w.detail.control.sleeve.maxDrawdown), controlAccountMaxDrawdownPct: pct2(w.detail.control.account.maxDrawdown),
        sessions: w.detail.sessions,
      });
      return {
        ...base(s),
        trades: s.stitchedOos.trades,
        criteriaFailed: cr.filter(x => x.pass === false).map(x => x.id).sort(),
        criteriaPassed: cr.filter(x => x.pass === true).map(x => x.id).sort(),
        criteriaVerdict: c.verdict,
        selectedPerFold: c.reported.outerSelection.map((x: any) => x.candidateName),
        r1Psr: r3(c.criteria.R1.value),
        r2SleeveMaxDrawdownPct: pct2(c.criteria.R2.value),
        r3StrategySharpe: r3(c.criteria.R3.detail.strategySharpe),
        r3ControlSharpe: r3(c.criteria.R3.detail.controlSharpe),
        r3CommonDays: c.criteria.R3.detail.commonDays,
        r3DeltaSharpe: r3(c.criteria.R3.value),
        stressSharpe: r3(c.criteria.R4.value),
        maxYearPnlShare: r3(c.criteria.R5.value),
        exTopDecileSharpe: r3(c.criteria.R6.value),
        accountMaxDrawdownPct: pct2(acct.candidateMaxDrawdown),
        accountControlMaxDrawdownPct: pct2(acct.controlMaxDrawdown),
        accountCommonDays: acct.commonDays,
        haircutPsr: r3(c.criteria.H1.value),
        haircutStressSharpe: r3(c.criteria.H2.value),
        marginInterestUsd: Math.round(c.criteria.M1.detail.marginInterestPaidUsd),
        marginInterestShareOfNetPnl: r3(c.criteria.M1.detail.marginInterestShareOfNetPnl),
        crash2020: window(c.criteria.S1),
        bear2022: window(c.criteria.S2),
        meanGross: r3(c.reported.avgGross),
        ordersPerSessionOos: r2(c.reported.ordersPerSession),
        turnoverAnnual: r2(c.reported.turnoverAnnual),
        controlArtifact: short(dirs.e1), partnerArtifact: short(dirs.e2),
        strategyOnCommonDays: perf(cmp.candidate),
        controlOnCommonDays: perf(cmp.control),
        deltaSharpeSameDays: r3(cmp.deltaSharpe),
      };
    };
    type Rw4bClaims = ReturnType<typeof rw4bClaims>;
    const rw4bRow = (name: string, dir: string, v: Rw4bClaims) => ({
      candidate: name, artifact: short(dir),
      stitchedReturnPct: v.stitchedReturnPct, sharpe: v.sharpe, maxDrawdownPct: v.maxDrawdownPct, deltaSharpeVsE1: v.deltaSharpeSameDays,
      cagrPctCommonDays: pct2(v.strategyOnCommonDays.cagr), accountMaxDrawdownPct: v.accountMaxDrawdownPct,
      marginInterestUsd: v.marginInterestUsd, meanGross: v.meanGross, turnoverAnnual: v.turnoverAnnual, criteriaFailed: v.criteriaFailed,
    });
    return { r2, r3, r4, pct2, readJson, dirOf, dirOfPath, short, base, dataHashOf, dirs, ids, combined, kernelClaims, rw4aRow, account, rw4bClaims, rw4bRow, series };
  };

  const rw4Batches = ledger.batches.filter((b: any) => /^rw4[ab]-/.test(b.id));
  // [manifest, candidate, volTarget, maxGross, prior, fastVol]
  const rw4bManifests = [
    ["rw4b-e1-lev-vt20-g150-brake-v1.json", "vt20-g150-brake-fast5", 0.2, 1.5, 424, true],
    ["rw4b-e1-lev-vt25-g150-brake-v1.json", "vt25-g150-brake-fast5", 0.25, 1.5, 425, true],
    ["rw4b-e1-lev-vt25-g200-brake-v1.json", "vt25-g200-brake-fast5", 0.25, 2, 426, true],
    ["rw4b-e1-lev-vt20-g150-brakeonly-v1.json", "vt20-g150-brake", 0.2, 1.5, 427, false],
  ] as const;
  const rw4DdC1 = { startPct: 0.05, endPct: 0.25 };
  const rw4VolC1 = { annualizedPct: 50, fastBars: 120, slowBars: 504 };
  const rw4DdC2 = { startPct: 0.1, endPct: 0.4 };
  const rw4VolC2 = { annualizedPct: 80, fastBars: 10, slowBars: 42 };
  // [manifest, candidate, prior, volCap, drawdown, softDrawdownPct]
  const rw4aC1Manifests = [
    ["momentum-crypto-rw4a-xc-dd-pure-v1.json", "vt35-corroff-xc-dd", 428, undefined, rw4DdC1, undefined],
    ["momentum-crypto-rw4a-xc-vol-pure-v1.json", "vt35-corroff-xc-vol", 429, rw4VolC1, undefined, undefined],
    ["momentum-crypto-rw4a-xc-both-pure-v1.json", "vt35-corroff-xc-both", 430, rw4VolC1, rw4DdC1, undefined],
  ] as const;
  const rw4aC2Manifests = [
    ["momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1.json", "d13-s5-xc-dd", 431, undefined, rw4DdC2, undefined],
    ["momentum-crypto-usdc-daily-s5-rw4a-xc-vol-pure-v1.json", "d13-s5-xc-vol", 432, rw4VolC2, undefined, undefined],
    ["momentum-crypto-usdc-daily-s5-rw4a-xc-both-pure-v1.json", "d13-s5-xc-both", 433, rw4VolC2, rw4DdC2, undefined],
    ["momentum-crypto-usdc-daily-s5-rw4a-xc-dd-nosoftdd-pure-v1.json", "d13-s5-xc-dd-nosoftdd", 434, undefined, rw4DdC2, 1.0],
  ] as const;

  test("RW4 b/a align with their manifests and batches; RW4b and RW4a-c1 fail, RW4a-c2's winner passes, is replicated and wired (2026-10-23)", () => {
    // Three batches chained 424 → 428 → 431 → 435, where RW5 begins.
    expect(rw4Batches.map((b: any) => b.id)).toEqual(["rw4b-e1-lev-brake-2026-10-23", "rw4a-c1-momentum-crypto-2026-10-23", "rw4a-c2-usdc-2026-10-23"]);
    expect(rw4Batches.map((b: any) => b.hypothesisCount)).toEqual([4, 3, 4]);
    let prev = 424;
    for (const b of rw4Batches) {
      expect(b.priorUniqueTrials).toBe(prev);
      expect(b.resultingUniqueTrials).toBe(prev + b.hypothesisCount);
      expect(b.inventoryComplete).toBe(false);
      expect(b.resultsComplete).toBe(false);
      expect(b.executionReported).toBe(true);
      for (const p of b.sourcePaths) expect(sourcePathPresent(p)).toBe(true);
      prev = b.resultingUniqueTrials;
    }
    expect(prev).toBe(435);
    expect(rw4Batches.at(-1).resultingUniqueTrials).toBe(435);
    expect(rw3Batches.at(-1).resultingUniqueTrials).toBe(424); // RW3/D4 end where RW4 begins

    // Manifests: one candidate each, the pre-registered knobs, priors chained 424..434.
    const manifestOf = (file: string) => JSON.parse(readFileSync(join(root, "experiments", file), "utf8"));
    rw4bManifests.forEach(([file, cand, vt, gross, prior, fast]) => {
      const m = manifestOf(file);
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
      expect(m.candidates).toHaveLength(1);
      expect(m.candidates[0].name).toBe(cand);
      expect(m.candidates[0].portfolio.strategy).toMatchObject({
        kind: "volManaged", portfolioVolTarget: vt, maxGross: gross, drawdownBrake: { startDrawdown: 0.05, maxDrawdown: 0.2, floorScale: 0.25 },
      });
      expect(m.candidates[0].portfolio.strategy.fastVolLookback).toBe(fast ? 5 : undefined);
      expect(rw4Batches[0].sourcePaths).toContain(`experiments/${file}`);
    });
    for (const [batch, manifests, asOf] of [[rw4Batches[1], rw4aC1Manifests, "2026-10-02T08:00:00Z"], [rw4Batches[2], rw4aC2Manifests, "2026-09-26T00:00:00Z"]] as const) {
      for (const [file, cand, prior, volCap, drawdown, soft] of manifests) {
        const m = manifestOf(file);
        expect(m.asOf).toBe(asOf);
        expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
        expect(m.candidates).toHaveLength(1);
        expect(m.candidates[0].name).toBe(cand);
        expect(m.candidates[0].exposureControl).toEqual({
          ...(volCap ? { volCap } : {}), ...(drawdown ? { drawdown } : {}), minScale: 0.25, band: 0.1, minOrderUsd: 100,
        });
        expect(m.candidates[0].risk?.softDrawdownPct).toBe(soft);
        expect(batch.sourcePaths).toContain(`experiments/${file}`);
      }
    }
    for (const [file] of rw4aC1Manifests) {
      const c = manifestOf(file).candidates[0];
      expect(c.volTarget.annualizedPct).toBe(35);
      expect(c.regime.correlationCeiling).toBe(1.01); // the live vt35-corroff config
    }

    // Controls at +0: E1, E2 and USDC are the ones rw3Controls already records; the crypto control is RW3 c1's validated candidate.
    const ctl = ledger.rw4Controls;
    expect(ctl.trialsAdded).toBe(0);
    expect(ctl.controls.e1).toMatchObject({ artifact: "33b0ac05", path: ledger.rw3Controls.controls.e1Rerun.path, dataHash: ledger.rw3Controls.controls.e1Rerun.dataHash });
    expect(ctl.controls.e2).toMatchObject({ artifact: "0b088ca3", path: ledger.rw3Controls.controls.e2.path, dataHash: ledger.rw3Controls.controls.e2.dataHash });
    expect(ctl.controls.usdc).toMatchObject({ artifact: "d0f7fd6f", path: ledger.rw3Controls.controls.usdc.path, dataHash: ledger.rw3Controls.controls.usdc.dataHash });
    expect(ctl.controls.cryptoLive.path).toBe(ledger.authoritativeArtifactRw3C1.path);
    expect(ctl.controls.cryptoLive.path).toContain("efc086b4");

    // RW4b: all four fail ONLY R3; the reference is the best return, not a candidate.
    const b4 = ledger.authoritativeArtifactRw4b;
    expect(b4.verdict).toContain("REFERENCIA DE FRONTERA");
    expect(b4.verdict).toContain("REFUTADO");
    expect(b4.verdict).toContain("NO SE CABLEA");
    expect(b4.frontier.map((p: any) => p.candidate)).toEqual(rw4bManifests.map(m => m[1]));
    for (const p of b4.frontier) {
      expect(p.criteriaFailed).toEqual(["R3_vsControl"]);
      expect(p.deltaSharpeVsE1).toBeLessThan(0);
      expect(p.maxDrawdownPct).toBeLessThanOrEqual(25); // R2 passes
      expect(p.accountMaxDrawdownPct).toBeLessThanOrEqual(20); // A1 passes
    }
    const top4 = [...b4.frontier].sort((a: any, b: any) => b.stitchedReturnPct - a.stitchedReturnPct)[0];
    expect(top4.candidate).toBe("vt25-g150-brake-fast5");
    expect(b4.path).toContain(top4.artifact);
    expect(b4.rw4b.criteriaFailed).toEqual(["R3_vsControl"]);
    expect(b4.rw4b.criteriaVerdict).toBe("FALLA: R3");
    expect(b4.rw4b.r3StrategySharpe).toBeLessThan(b4.rw4b.r3ControlSharpe);
    expect(b4.rw4b.accountMaxDrawdownPct).toBeLessThan(b4.rw4b.accountControlMaxDrawdownPct); // the brake does lower the account drawdown
    expect(b4.rw4b.controlArtifact).toBe("33b0ac05");
    expect(b4.rw4b.partnerArtifact).toBe("0b088ca3");
    expect(rw4Batches[0].evidence).toContain("REFUTADOS LOS 4");

    // RW4a c1: three refuted candidates; the §13.4 verdict re-derived from the ledger's own rows.
    const c1 = ledger.authoritativeArtifactRw4aC1;
    expect(c1.verdict).toContain("REFERENCIA DE FRONTERA");
    expect(c1.verdict).toContain("REFUTADO");
    expect(c1.verdict).toContain("NO SE CABLEA");
    expect(c1.passingCandidates).toEqual([]);
    expect(c1.candidates.map((c: any) => c.candidate)).toEqual(rw4aC1Manifests.map(m => m[1]));
    expect(c1.control.gatesFailed).toEqual(["maxDisplacementShare"]);
    for (const c of c1.candidates) {
      const failed = rw4aCriteriaFailed(c, c1.control.gatesFailed, 45);
      expect(c.criteriaFailed).toEqual(failed);
      expect(failed).toContain("R3_sharpeCommonDays");
      expect(c.sharpeCommonDays).toBeLessThan(c.controlSharpeCommonDays);
      expect(c.controlSharpeCommonDays).toBe(c1.control.candidateOnCommonDays.sharpe);
    }
    const topC1 = [...c1.candidates].sort((a: any, b: any) => b.stitchedReturnPct - a.stitchedReturnPct)[0];
    expect(topC1.candidate).toBe("vt35-corroff-xc-dd");
    expect(c1.path).toContain(topC1.artifact);
    expect(c1.rw4aC1.selected).toBe("vt35-corroff-xc-dd");
    expect(rw4Batches[1].evidence).toContain("REFUTADOS LOS 3");

    // RW4a c2: exactly one chain meets every criterion, by a hair; replicated and wired (feat/rw4a-usdc-xc).
    const c2 = ledger.authoritativeArtifactRw4aC2;
    expect(c2.verdict).toContain("PASA TODOS LOS CRITERIOS");
    expect(c2.verdict).toContain("POR LA MINIMA");
    expect(c2.verdict).toContain("REPLICADO y CABLEADO");
    expect(c2.candidates.map((c: any) => c.candidate)).toEqual(rw4aC2Manifests.map(m => m[1]));
    expect(c2.control.gatesFailed).toEqual(["maxDrawdown", "minExcessReturnVsBench"]);
    for (const c of c2.candidates) expect(c.criteriaFailed).toEqual(rw4aCriteriaFailed(c, c2.control.gatesFailed, c2.control.maxDrawdownPct));
    expect(c2.candidates.filter((c: any) => c.criteriaFailed.length === 0).map((c: any) => c.candidate)).toEqual(c2.passingCandidates);
    expect(c2.passingCandidates).toEqual(["d13-s5-xc-dd"]);
    expect(c2.candidates.find((c: any) => c.candidate === "d13-s5-xc-both").criteriaFailed).toEqual(["R3_sharpeCommonDays"]);
    expect(c2.candidates.find((c: any) => c.candidate === "d13-s5-xc-dd-nosoftdd").criteriaFailed).toEqual(
      ["R3_sharpeCommonDays", "DD_commonDays", "DD_sleeveGate", "PSR", "acceptanceGates"]);
    expect(c2.path).toContain("8892c1e9");
    expect(c2.rw4aC2.selected).toBe("d13-s5-xc-dd");
    const w = c2.rw4aC2;
    expect(w.candidateOnCommonDays.sharpe).toBeGreaterThanOrEqual(w.controlOnCommonDays.sharpe);
    expect(w.candidateOnCommonDays.maxDrawdown).toBeLessThanOrEqual(w.controlOnCommonDays.maxDrawdown);
    expect(w.maxDrawdownPct).toBeLessThanOrEqual(c2.control.maxDrawdownPct);
    expect(w.outerPsr).toBeGreaterThanOrEqual(0.95);
    expect(w.foldPsr.filter((p: number) => p > 0.5)).toHaveLength(3);
    expect(w.worstLooRatio).toBeGreaterThanOrEqual(0.6);
    expect(w.combined.maxDrawdown).toBeLessThanOrEqual(0.2);
    expect(w.gatesFailed).toEqual(c2.control.gatesFailed); // the same two gates the control fails
    expect(w.exposure.resizes).toBe(w.exposure.reductions + w.exposure.addBacks);
    // "by a hair": the margins are tiny, and the return is slightly BELOW the control's.
    expect(w.candidateOnCommonDays.sharpe - w.controlOnCommonDays.sharpe).toBeLessThan(0.02);
    expect(w.controlOnCommonDays.maxDrawdown - w.candidateOnCommonDays.maxDrawdown).toBeLessThan(0.01);
    expect(w.stitchedReturnPct).toBeLessThan(c2.control.stitchedReturnPct);
    // Wired (feat/rw4a-usdc-xc) after the independent replication passed (RW §13.6).
    expect(c2.wiring).toMatchObject({ status: "passes; replicated; wired", wired: true, version: "momentum_crypto_usdc@daily-d13s5-xc-dd", riskStateReanchor: false });
    expect(c2.wiring.satisfied).toHaveLength(3);
    expect(c2.wiring.requiredBeforeWiring).toBeUndefined();
    const rep = c2.wiring.replication;
    expect(rep.maxAbsDeltaSharpePerFold).toBeLessThan(rep.limit);
    expect(rep.limit).toBe(0.10);
    expect(rep.maxAbsDeltaSharpePerFold).toBeLessThan(1e-13);
    expect(rep.winnerFoldSharpe).toHaveLength(3);
    expect(rep.controlFoldSharpe).toHaveLength(3);
    rep.winnerFoldSharpe.forEach((v: number, i: number) => expect(Math.abs(v - rep.controlFoldSharpe[i])).toBeLessThan(0.10));
    expect(rep.resizes).toBe(w.exposure.resizes);           // the same 104 resizes as the artifact
    expect(rep.reductions).toBe(w.exposure.reductions);
    expect(rep.addBacks).toBe(w.exposure.addBacks);
    expect(rep.controlResizes).toBe(0);
    expect(rep.deltaSharpeCommonDays).toBeCloseTo(w.deltaSharpe, 9);
    expect(c2.verdict).toContain("REPLICADO y CABLEADO");
    expect(rw4Batches[2].evidence).toContain("REPLICADO y CABLEADO");
    expect(rw4Batches[2].evidence).not.toContain("PENDIENTE de replica");

    // The claim "wired" holds in the code (CI-safe, source text): the knob in the USDC plan, scalePosition on the
    // Binance adapter, the version with this artifact in the version table — and the live candidate lock reads it.
    const indexSrc = readFileSync(join(root, "src/index.ts"), "utf8");
    expect(indexSrc.split("exposureControl: {").length - 1).toBe(1); // the USDC plan only (momentum_crypto's candidates failed)
    expect(indexSrc).toContain("MOMENTUM_USDC_EXPOSURE_CONTROL");
    const adapterSrc = readFileSync(join(root, "src/strategies/momentum/BinanceMomentumAdapter.ts"), "utf8");
    expect(adapterSrc).toContain("async scalePosition(");
    const versionsSrc = readFileSync(join(root, "src/portfolio/modelVersions.ts"), "utf8");
    expect(versionsSrc).toContain(`id: "${c2.wiring.version}"`);
    expect(versionsSrc).toContain(c2.path.replace(/^data\/backtests\//, "").replace(/\/$/, ""));
    expect(versionsSrc).toContain('manifest: "experiments/momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1.json"');
    expect(readFileSync(join(root, "src/config/liveSleeveConfigs.ts"), "utf8")).toContain("exposureControl: { ...MOMENTUM_USDC_EXPOSURE_CONTROL");
    expect(readFileSync(join(root, "src/portfolios/builtin.ts"), "utf8")).toContain("exposureControl: { drawdown: { startPct: 0.1, endPct: 0.4 }, minScale: 0.25, band: 0.1, minOrderUsd: 100 }");
  });

  testWithDb("RW4 artifacts exist on disk and reproduce the ledger claims (same-day comparison, combined book, account drawdown)", () => {
    const k = rw4Calc();
    const { dirOf, dirOfPath, readJson, dirs, dataHashOf, base, r4 } = k;
    const manifestStem = (file: string) => file.replace(/\.json$/, "");

    // Controls (+0): artifact, data hash, and (crypto) the full chain claims.
    const ctl = ledger.rw4Controls.controls;
    expect(ctl.e1.path).toBe(`data/backtests/${dirs.e1.split("/").pop()}/`);
    expect(ctl.e2.path).toBe(`data/backtests/${dirs.e2.split("/").pop()}/`);
    expect(ctl.usdc.path).toBe(`data/backtests/${dirs.usdc.split("/").pop()}/`);
    expect(ctl.cryptoLive.path).toBe(`data/backtests/${dirs.crypto.split("/").pop()}/`);
    expect([ctl.e1.dataHash, ctl.e2.dataHash, ctl.usdc.dataHash, ctl.cryptoLive.dataHash]).toEqual([dataHashOf(dirs.e1), dataHashOf(dirs.e2), dataHashOf(dirs.usdc), dataHashOf(dirs.crypto)]);
    const cs = readJson(join(dirs.crypto, "summary.json"));
    expect({ outerFoldReturnsPct: ctl.cryptoLive.outerFoldReturnsPct, stitchedReturnPct: ctl.cryptoLive.stitchedReturnPct, sharpe: ctl.cryptoLive.sharpe, maxDrawdownPct: ctl.cryptoLive.maxDrawdownPct, outerPsr: ctl.cryptoLive.outerPsr })
      .toEqual({ ...base(cs) });
    expect(ctl.cryptoLive.gatesFailed).toEqual(Object.values(cs.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort());
    expect(ctl.cryptoLive.selected).toBe(cs.selectedCandidate.name);

    // RW4b: rw4b-criteria.json + compareArtifacts(R3 days) + the account (A1) recomputed from the two chains.
    const b4 = ledger.authoritativeArtifactRw4b;
    for (const p of b4.frontier) {
      const dir = dirOf(p.artifact);
      const v = k.rw4bClaims(dir);
      expect(p).toEqual(k.rw4bRow(p.candidate, dir, v));
      const idx = b4.frontier.indexOf(p);
      expect(readJson(join(dir, "manifest-resolved.json")).name).toBe(manifestStem(rw4bManifests[idx][0]));
      expect(readJson(join(dir, "rw4b-criteria.json")).manifest).toBe(`experiments/${rw4bManifests[idx][0]}`);
      expect(v.selectedPerFold.every((n: string) => n === p.candidate)).toBe(true);
      expect(dataHashOf(dir)).toBe(dataHashOf(dirs.e1));
      // R3: the criteria file and the same-day comparison agree, and it is the only failure.
      expect(v.r3DeltaSharpe).toBe(v.deltaSharpeSameDays);
      expect(v.r3CommonDays).toBe(readJson(join(dir, "rw4b-criteria.json")).reported.commonDays);
      expect(v.r3ControlSharpe).toBe(k.r3(compareArtifacts(dir, dirs.e1, 252).control.sharpe));
      expect(v.criteriaFailed).toEqual(["R3_vsControl"]);
      // A1 recomputed (E1 variant + E2, $50k each) equals what portfolio-wf wrote.
      const acct = k.account(dir);
      const a1 = readJson(join(dir, "rw4b-criteria.json")).criteria.A1;
      expect(acct.candidateMaxDrawdown).toBe(r4(a1.value));
      expect(acct.controlMaxDrawdown).toBe(r4(a1.detail.controlAccount.maxDrawdown));
      expect(acct.commonDays).toBe(a1.detail.commonDays);
      expect(a1.pass).toBe(acct.candidateMaxDrawdown <= 0.2);
    }
    expect(b4.rw4b).toEqual(k.rw4bClaims(dirOfPath(b4.path)));

    // RW4a: summary.json + same-day comparison + combined book, and the §13.4 verdict from the artifacts.
    const checkFamily = (art: any, manifests: ReadonlyArray<readonly [string, string, ...unknown[]]>, controlDir: string, sleeveMaxDdPct: (control: any) => number,
      combinedOf: (candidateDir: string) => ReturnType<typeof k.combined>) => {
      const control = k.kernelClaims(controlDir, controlDir, combinedOf(controlDir));
      expect(art.control).toEqual(control);
      const sleeveMax = sleeveMaxDdPct(control);
      art.candidates.forEach((p: any, i: number) => {
        const dir = dirOf(p.artifact);
        const v = k.kernelClaims(dir, controlDir, combinedOf(dir));
        expect(p).toEqual(k.rw4aRow(dir, v, control, sleeveMax));
        expect(readJson(join(dir, "manifest-resolved.json")).name).toBe(manifestStem(manifests[i][0]));
        expect(v.selected).toBe(manifests[i][1]);
        expect(dataHashOf(dir)).toBe(dataHashOf(controlDir));
        // The same-day comparison is the §13.4 one: both sides on the control's common days (ppy 365).
        expect(v.commonDays).toBe(control.commonDays);
        expect(v.controlOnCommonDays).toEqual(control.candidateOnCommonDays);
        expect(v.deltaSharpe).toBe(k.r3(v.candidateOnCommonDays.sharpe - v.controlOnCommonDays.sharpe));
        // Re-derive the verdict from the artifact, not from the ledger's own row.
        expect(k.rw4aRow(dir, v, control, sleeveMax).criteriaFailed.length === 0).toBe(art.passingCandidates.includes(p.candidate));
        // The resize telemetry is in summary.json and adds up.
        const xs = readJson(join(dir, "summary.json")).outerTests.map((t: any) => t.result.exposureStats);
        expect(xs.every((x: any) => x && x.resizes === x.reductions + x.addBacks)).toBe(true);
      });
      return control;
    };
    const c1 = ledger.authoritativeArtifactRw4aC1;
    checkFamily(c1, rw4aC1Manifests, dirs.crypto, () => 45, d => k.combined(d, dirs.usdc));
    expect(c1.rw4aC1).toEqual(k.kernelClaims(dirOfPath(c1.path), dirs.crypto, k.combined(dirOfPath(c1.path), dirs.usdc)));
    const c2 = ledger.authoritativeArtifactRw4aC2;
    checkFamily(c2, rw4aC2Manifests, dirs.usdc, control => control.maxDrawdownPct, d => k.combined(dirs.crypto, d));
    expect(c2.rw4aC2).toEqual(k.kernelClaims(dirOfPath(c2.path), dirs.usdc, k.combined(dirs.crypto, dirOfPath(c2.path))));
    // The winner's common-day margins straight from compareArtifacts, not from the ledger.
    const cmp = compareArtifacts(dirOfPath(c2.path), dirs.usdc, 365);
    expect(cmp.candidate.sharpe).toBeGreaterThanOrEqual(cmp.control.sharpe);
    expect(cmp.candidate.maxDrawdown).toBeLessThanOrEqual(cmp.control.maxDrawdown);
    expect(cmp.commonDays).toBe(c2.rw4aC2.commonDays);
  }, 120_000); // ~15 artifact reads plus the combined-book rebuilds

  // [manifest stem, artifact prefix, target vol, gross, signal, fast vol, PIT, E2]
  const rw5Manifests = [
    ["rw5-e1-lev-vt20-g150-sma200-v1", "52c40559", 0.2, 1.5, "maTrend", false, false, false],
    ["rw5-e1-lev-vt25-g200-sma200-v1", "2ddb07a5", 0.25, 2, "maTrend", false, false, false],
    ["rw5-e1-lev-vt20-g150-absmom12-v1", "bc6734c8", 0.2, 1.5, "absMomentum", false, false, false],
    ["rw5-e1-lev-vt20-g150-canary-v1", "8bbb886c", 0.2, 1.5, "canary", false, false, false],
    ["rw5-e2-lev-vt20-g150-sma200-v1", "24738ecc", 0.2, 1.5, "maTrend", false, false, true],
    ["rw5-e2-lev-vt25-g200-sma200-v1", "985446a7", 0.25, 2, "maTrend", false, false, true],
    ["rw5-e1-pit-top6-vt15-v1", "ad0cf3a2", 0.15, 1, undefined, false, true, false],
    ["rw5-e1-pit-top6-lev-vt20-g150-sma200-v1", "bcb7c254", 0.2, 1.5, "maTrend", false, true, false],
    ["rw5-e1-lev-vt20-g150-sma200-fastvol5-v1", "39868114", 0.2, 1.5, "maTrend", true, false, false],
    ["rw5-e1-lev-vt25-g200-sma200-fastvol5-v1", "db188948", 0.25, 2, "maTrend", true, false, false],
    ["rw5-e1-pit-top6-lev-vt25-g200-sma200-fastvol5-v1", "b7857555", 0.25, 2, "maTrend", true, true, false],
  ] as const;
  const rw5 = ledger.authoritativeArtifactRw5;
  const rw5Rows: any[] = rw5.candidates;
  const rw5Row = (trial: number) => rw5Rows.find(r => r.trial === trial);
  const rw5Path = (prefix: string): string => ledger.rw5Controls.paths[prefix] ?? rw5Rows.find(r => r.path.startsWith(`data/backtests/${prefix}`))?.path;
  const rw5Round = (n: number) => +n.toFixed(4);
  const rw5Crypto = ledger.authoritativeArtifactRw5Crypto;
  const rw5CryptoRows: any[] = rw5Crypto.candidates;
  const rw5Hwm = ledger.authoritativeArtifactRw5Hwm;
  const rw5HwmRows: any[] = rw5Hwm.candidates;
  const rw5Trail = ledger.authoritativeArtifactRw5Trail;
  const rw5TrailRows: any[] = rw5Trail.candidates;
  const rw5d = ledger.authoritativeArtifactRw5d;
  const rw5dRows: any[] = rw5d.candidates;
  const rw5Q5Size = ledger.authoritativeArtifactRw5Q5Size;
  const rw5Q5SizeRows: any[] = rw5Q5Size.candidates;
  const rw5dCash = ledger.authoritativeArtifactRw5dCash;
  const rw5dCashRows: any[] = rw5dCash.candidates;
  const rw5Q5IdleTsm = ledger.authoritativeArtifactRw5Q5IdleTsm;
  const rw5Q5Breakout = ledger.authoritativeArtifactRw5Q5Breakout;
  const rw5Q5ShortRows: any[] = [...rw5Q5IdleTsm.candidates, ...rw5Q5Breakout.candidates];
  const rw5CryptoPath = (prefix: string): string => prefix === "efc086b4" ? ledger.authoritativeArtifactRw3C1.path
    : prefix === "8892c1e9" ? ledger.authoritativeArtifactRw4aC2.path : rw5Path(prefix);

  test("RW5/b/c pin 435→446, all 11 pre-registered designs and verdicts; K7 still blocks wiring despite RW5c", () => {
    const batches = ["rw5-2026-10-23", "rw5b-2026-10-23", "rw5c-2026-10-23"].map(id => ledger.batches.find((b: any) => b.id === id));
    expect(batches.map((b: any) => [b.id, b.priorUniqueTrials, b.hypothesisCount, b.resultingUniqueTrials]))
      .toEqual([["rw5-2026-10-23", 435, 8, 443], ["rw5b-2026-10-23", 443, 2, 445], ["rw5c-2026-10-23", 445, 1, 446]]);
    expect(rw4Batches.at(-1).resultingUniqueTrials).toBe(435);
    expect(batches[2].resultingUniqueTrials).toBe(446);
    expect(batches.map((b: any) => b.sourceCommit.split(" ")[0])).toEqual(["33caa5d", "6280eb4", "c116698"]);
    for (const b of batches) {
      expect(b.inventoryComplete).toBe(false);
      expect(b.resultsComplete).toBe(false);
      expect(b.executionReported).toBe(true);
      expect(b.sourcePaths.filter((p: string) => p.startsWith("experiments/"))).toHaveLength(b.hypothesisCount);
      for (const p of b.sourcePaths) expect(sourcePathPresent(p)).toBe(true);
    }
    expect(rw5Rows.map(r => r.trial)).toEqual(Array.from({ length: 11 }, (_, i) => 435 + i));
    expect(new Set(rw5Rows.map(r => r.path)).size).toBe(11);
    rw5Manifests.forEach(([stem, prefix, vt, gross, signal, fast, pit, e2], i) => {
      const r = rw5Rows[i], m = JSON.parse(readFileSync(join(root, `experiments/${stem}.json`), "utf8"));
      const c = m.candidates[0], s = c.portfolio.strategy;
      expect(r.manifest).toBe(`experiments/${stem}.json`);
      expect(r.path).toMatch(new RegExp(`^data/backtests/${prefix}[0-9a-f]{56}/$`));
      expect(batches[i < 8 ? 0 : i < 10 ? 1 : 2].sourcePaths).toContain(r.manifest);
      expect(m.name).toBe(stem);
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: 435 + i, complete: false });
      expect(m.candidates).toHaveLength(1);
      expect(c.name).toBe(stem.replace(/^rw5-/, "").replace(/-v1$/, ""));
      expect(c.cadenceMin).toBe(1440);
      expect(s).toMatchObject({ kind: "volManaged", portfolioVolTarget: vt, maxGross: gross, volLookback: 63, covLookback: 21, inceptionGuardBars: 252, annualization: 252, perAssetCap: e2 ? 0.1 : 0.25 });
      expect(s.drawdownBrake).toBeUndefined();
      expect(s.fastVolLookback).toBe(fast ? 5 : undefined);
      expect(s.pitUniverse).toEqual(pit ? { topN: 6, liquidityLookback: 63, minHoldingRebalances: 21 } : undefined);
      const base = JSON.parse(readFileSync(join(root, "experiments", e2 ? "rw3-e2-meanrev-lev-vt20-g150-v1.json" : "rw3-e1-stocks-lev-vt20-g150-v1.json"), "utf8"));
      expect(m.asOf).toBe(base.asOf);
      expect(m.window).toEqual(base.window);
      expect(m.costs).toEqual(base.costs);
      expect(m.ledger.initialEquity).toBe(50_000);
      for (const tier of ["base", "stress"]) expect(m.costs[tier].marginInterest.annualRate).toBe(0.065);
      expect(s.universe).toEqual(pit ? ["SPY", "QQQ", "IWM", "GLD", "SMH"] : base.candidates[0].portfolio.strategy.universe);
      expect(m.data.dbPath).toBe(pit ? "$UC_RESEARCH_DATA_DIR/hist-sp500.db" : "./data/historical.db");
      expect(m.data.membership).toEqual(pit ? { index: "sp500" } : undefined);
      const signals = signal === "maTrend" ? [{ kind: "maTrend", symbol: "SPY", period: 200, sampling: "daily", bandPct: 1 }]
        : signal === "absMomentum" ? [{ kind: "absMomentum", symbol: "SPY", cashProxy: "BIL", lookback: 252 }]
        : [{ kind: "canary", assets: ["SPY", "VWO", "VEA", "BND"], horizons: [21, 63, 126, 252], coefficients: [12, 4, 2, 1], negativeCount: 1 }];
      expect(s.regimeOverlay).toEqual(signal ? { signals, combine: "any", coreScale: 0, defensive: { assets: ["BIL"], momentumLookback: 63, volLookback: 63, cashProxy: "BIL" } } : undefined);
      expect(r.current).toBe(pit && r.trial !== 441 ? "ad0cf3a2" : e2 ? "0b088ca3" : "33b0ac05");
      expect(r.partner).toBe(e2 ? "33b0ac05" : "0b088ca3");
      expect(r.sameLeverage).toBe(pit ? null : e2 ? gross === 2 ? "3c181ce9" : "006f1e03" : gross === 2 ? "49a1160c" : "c512c100");

      // Re-derive K1–K6 from the ledger's figures, independently of its failure labels.
      const f = r.figures, b = f.robustness;
      const pass: Record<string, boolean | null> = {
        K1_moreReturn: f.deltaCagrPp >= 3,
        K2_sleeveDrawdown: f.maxDrawdownPct <= 30,
        K2_accountDrawdown: f.accountMaxDrawdownPct <= 30,
        K3_beatsSameLeverage: r.sameLeverage ? f.maxDrawdownPct < f.sameLeverageMaxDrawdownPct && f.calmar >= f.sameLeverageCalmar : null,
        K4_everyCrash: r.sameLeverage ? f.crashDrawdownsPct.every((dd: number, j: number) => f.crashSessions[j] >= 20 && dd <= f.sameLeverageCrashDrawdownsPct[j]) : null,
        K5_R1_psr: b.K5_R1_psr >= 0.95, K5_R4_stressSharpe: b.K5_R4_stressSharpe >= 0.5,
        K5_R5_yearShare: b.K5_R5_yearShare <= 0.5, K5_R6_exTopDecile: b.K5_R6_exTopDecile >= 0.3,
        K6_sharpeFloor: f.sharpe >= 0.8 * f.currentSharpe,
      };
      expect(r.criteriaFailed).toEqual(Object.keys(pass).filter(k => pass[k] === false));
      expect(r.criteriaNotApplicable).toEqual(Object.keys(pass).filter(k => pass[k] === null));
      expect(r.criteriaVerdict).toBe(r.criteriaFailed.length ? `FALLA: ${r.criteriaFailed.join(", ")}` : "CUMPLE");
      expect(b.K5_R7_breakEven).toBeNull(); // reported pass=true by the evaluator; not a finite cost claim
    });
    expect(rw5Rows.map(r => r.criteriaFailed)).toEqual([
      ["K1_moreReturn", "K4_everyCrash"], ["K4_everyCrash"], ["K1_moreReturn"],
      ["K1_moreReturn", "K3_beatsSameLeverage", "K6_sharpeFloor"], ["K1_moreReturn", "K3_beatsSameLeverage"],
      ["K2_sleeveDrawdown", "K3_beatsSameLeverage", "K4_everyCrash"], ["K1_moreReturn"], ["K1_moreReturn"], ["K1_moreReturn"], [], [],
    ]);
    expect(ledger.rw5Controls.trialsAdded).toBe(0);
    expect(Object.keys(ledger.rw5Controls.paths)).toEqual(["33b0ac05", "0b088ca3", "c512c100", "49a1160c", "006f1e03", "3c181ce9"]);
    expect(rw5Path("33b0ac05")).toBe(ledger.rw4Controls.controls.e1.path);
    expect(rw5Path("0b088ca3")).toBe(ledger.rw4Controls.controls.e2.path);
    for (const [prefix, path] of Object.entries(ledger.rw5Controls.paths)) expect(path).toMatch(new RegExp(`^data/backtests/${prefix}[0-9a-f]{56}/$`));
    for (const entry of [rw5, ledger.authoritativeArtifactRw5Pit, ledger.authoritativeArtifactRw5Frontier]) {
      const r = rw5Row(entry.trial);
      expect(entry.path).toBe(r.path);
      expect(entry.manifest).toBe(r.manifest);
    }
    expect(rw5.trial).toBe(444);
    expect(rw5.wired).toBe(false);
    expect(rw5.verdict).toContain("PASA K1-K6; NO SE CABLEA");
    expect(rw5.wiring.reason).toContain("K7 tal como se escribio fallo");
    expect(rw5.wiring.reason).toContain("decision explicita del dueno pendiente");
    expect(rw5.wiring.requiredBeforeWiring).toHaveLength(4);
    const twin = rw5Row(442), ownTwin = rw5Row(445), pit = rw5Row(441);
    expect(twin.rerun).toEqual({ fixCommits: ["c9691c6", "417ef26"], crashLog: "rw5-e1-pit-top6-lev-vt20-g150-sma200-v1.crash-before-fix.log", extraTrials: 0 });
    expect(rw5.k7).toEqual({ trial: 442, controlTrial: 441, pass: !twin.criteriaFailed.some((k: string) => /^K[12]_/.test(k)), criteriaFailed: ["K1_moreReturn"], deltaCagrPp: twin.figures.deltaCagrPp });
    expect(rw5.k7.pass).toBe(false);
    expect(rw5.ownPitTwin).toEqual({ trial: 445, controlTrial: 441, passesK1K2: !ownTwin.criteriaFailed.some((k: string) => /^K[12]_/.test(k)), deltaCagrPp: ownTwin.figures.deltaCagrPp, replacesK7: false });
    expect(rw5.ownPitTwin.passesK1K2).toBe(true);
    expect(pit.role).toBe("control de sesgo a posteriori");
    expect(ledger.authoritativeArtifactRw5Pit.trial).toBe(441);
    expect(ledger.authoritativeArtifactRw5Pit.measurement).toEqual(Object.fromEntries(["cagrPct", "currentCagrPct", "deltaCagrPp", "sharpe", "currentSharpe"].map(k => [k, pit.figures[k]])));
    expect(pit.figures.cagrPct).toBeCloseTo(20, 0);
    expect(pit.figures.currentCagrPct).toBeCloseTo(21.4, 0);
    expect(ledger.authoritativeArtifactRw5Frontier.trial).toBe(436);
    expect(ledger.authoritativeArtifactRw5Frontier.criteriaFailed).toEqual(rw5Row(436).criteriaFailed);
    expect(ledger.authoritativeArtifactRw5Frontier.wired).toBe(false);
    expect(ledger.authoritativeArtifactRw5Frontier.verdict).toContain("REFERENCIA DE FRONTERA");
  });

  testWithDb("RW5/b/c/d/cash artifacts reproduce every ledger figure and verdict through rw5-evaluate.ts --json (K7 derived separately)", () => {
    const r4 = rw5Round;
    for (const r of [...rw5Rows, ...rw5dRows, ...rw5dCashRows]) {
      const args = [process.execPath, "scripts/rw5-evaluate.ts", r.path, "--current", rw5Path(r.current), "--partner", rw5Path(r.partner), "--dd", "0.30", "--json"];
      if (r.sameLeverage) args.push("--same-leverage", rw5Path(r.sameLeverage));
      const proc = Bun.spawnSync(args, { cwd: root });
      expect({ trial: r.trial, exit: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ trial: r.trial, exit: 0, stderr: "" });
      const e = JSON.parse(proc.stdout.toString()), s = e.candidateStats, a = e.current, l = e.sameLeverage;
      expect(e.ddLimit).toBe(0.30);
      expect(e.windows.map((w: any) => [w.id, w.from, w.to])).toEqual([
        ["2020_covid", "2020-02-19", "2020-06-30"], ["2022_bear", "2022-01-03", "2022-12-30"], ["2025_april", "2025-02-19", "2025-06-30"],
      ]);
      expect(r.figures).toEqual({
        commonSessions: e.commonSessions, cagrPct: r4(s.cagr * 100), deltaCagrPp: r4((s.cagr - a.cagr) * 100), sharpe: r4(s.sharpe),
        maxDrawdownPct: r4(s.maxDrawdown * 100), accountMaxDrawdownPct: r4(e.accountDrawdown * 100), calmar: r4(s.calmar),
        currentCagrPct: r4(a.cagr * 100), currentSharpe: r4(a.sharpe), sameLeverageMaxDrawdownPct: l ? r4(l.maxDrawdown * 100) : null, sameLeverageCalmar: l ? r4(l.calmar) : null,
        crashDrawdownsPct: e.windows.map((w: any) => r4(w.candidate * 100)), sameLeverageCrashDrawdownsPct: l ? e.windows.map((w: any) => r4(w.sameLeverage * 100)) : null,
        crashSessions: e.windows.map((w: any) => w.sessions), robustness: Object.fromEntries(Object.entries(e.criteria).filter(([k]) => k.startsWith("K5_")).map(([k, v]: [string, any]) => [k, v.value === null ? null : r4(v.value)])),
      });
      const criteria: Record<string, { pass: boolean | null }> = e.criteria;
      expect(r.criteriaFailed).toEqual(Object.keys(criteria).filter(k => criteria[k].pass === false));
      expect(r.criteriaNotApplicable).toEqual(Object.keys(criteria).filter(k => criteria[k].pass === null));
      expect(r.criteriaVerdict).toBe(e.verdict);
      expect(e.criteria.K5_R7_breakEven.pass).toBe(true);
      expect(e.criteria.K7).toBeUndefined(); // the CLI does not silently certify the family-wide requirement
      const resolved = JSON.parse(readFileSync(join(root, r.path, "manifest-resolved.json"), "utf8"));
      const manifest = JSON.parse(readFileSync(join(root, r.manifest), "utf8"));
      expect(resolved.name).toBe(manifest.name);
      expect(resolved.trialAccounting).toEqual(manifest.trialAccounting);
      expect(resolved.candidates).toEqual(manifest.candidates);
      const summary = JSON.parse(readFileSync(join(root, r.path, "summary.json"), "utf8"));
      expect(summary.outerSelection.every((s: any) => s.candidateName === manifest.candidates[0].name)).toBe(true);
    }
    // The artifact-backed K1/K2 results above are the inputs of the family-wide K7 and RW5c tests.
    expect(rw5Row(442).criteriaFailed).toContain("K1_moreReturn");
    expect(rw5Row(445).criteriaFailed).toEqual([]);
    expect(rw5.k7.pass).toBe(false);
    expect(rw5.wired).toBe(false);
    expect(rw5d.k7.pass).toBe(rw5dRows[1].criteriaFailed.every((k: string) => !/^K[12]_/.test(k)));
    expect(rw5d.k7.deltaCagrPp).toBe(rw5dRows[1].figures.deltaCagrPp);
    expect(rw5d.wired).toBe(true); // family wired through #453, not the original BIL artifact
  }, 120_000);

  test("RW5 crypto/d pin 446→450, all four designs, T1–T6 failures and K1–K7 winner later wired through cash", () => {
    const batches = ["rw5-crypto-2026-10-24", "rw5d-2026-10-24"].map(id => ledger.batches.find((b: any) => b.id === id));
    expect(batches.map((b: any) => [b.id, b.priorUniqueTrials, b.hypothesisCount, b.resultingUniqueTrials]))
      .toEqual([["rw5-crypto-2026-10-24", 446, 2, 448], ["rw5d-2026-10-24", 448, 2, 450]]);
    expect(ledger.batches.find((b: any) => b.id === "rw5c-2026-10-23").resultingUniqueTrials).toBe(446);
    expect(ledger.batches.find((b: any) => b.id === "rw5d-2026-10-24").resultingUniqueTrials).toBe(450);
    expect(batches.map((b: any) => b.sourceCommit.split(" ")[0])).toEqual(["48cc50b", "5e08e97"]);
    for (const b of batches) {
      expect(b.inventoryComplete).toBe(false);
      expect(b.resultsComplete).toBe(false);
      expect(b.executionReported).toBe(true);
      expect(b.sourcePaths.filter((p: string) => p.startsWith("experiments/"))).toHaveLength(2);
      for (const p of b.sourcePaths) expect(sourcePathPresent(p)).toBe(true);
    }
    const designs = [
      ["momentum-crypto-rw5-trendexit65-pure-v1", "eb8e45d4", "momentum-crypto-rw3-vt-35-corroff-pure-v1", "vt-35-corr92-trendexit65"],
      ["momentum-crypto-usdc-daily-s5-rw5-trendexit65-pure-v1", "c958c6a9", "momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1", "d13-s5-xc-dd-trendexit65"],
      ["rw5-e1-lev-vt30-g250-sma200-fastvol5-v1", "2a92b1fb", "rw5-e1-lev-vt25-g200-sma200-fastvol5-v1", "e1-lev-vt30-g250-sma200-fastvol5"],
      ["rw5-e1-pit-top6-lev-vt30-g250-sma200-fastvol5-v1", "83fff6de", "rw5-e1-pit-top6-lev-vt25-g200-sma200-fastvol5-v1", "e1-pit-top6-lev-vt30-g250-sma200-fastvol5"],
    ];
    const rows = [...rw5CryptoRows, ...rw5dRows];
    expect(rows.map(r => r.trial)).toEqual([446, 447, 448, 449]);
    expect(new Set(rows.map(r => r.path)).size).toBe(4);
    designs.forEach(([stem, prefix, baseStem, candidateName], i) => {
      const r = rows[i], m = JSON.parse(readFileSync(join(root, `experiments/${stem}.json`), "utf8"));
      const base = JSON.parse(readFileSync(join(root, `experiments/${baseStem}.json`), "utf8"));
      expect(r.manifest).toBe(`experiments/${stem}.json`);
      expect(r.path).toMatch(new RegExp(`^data/backtests/${prefix}[0-9a-f]{56}/$`));
      expect(batches[i < 2 ? 0 : 1].sourcePaths).toContain(r.manifest);
      expect(m.name).toBe(stem);
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: 446 + i, complete: false });
      expect(m.candidates).toHaveLength(1);
      const c = m.candidates[0];
      expect(c.name).toBe(candidateName);
      expect(c.cadenceMin).toBe(i === 0 ? 60 : 1440);
      if (i < 2) {
        expect(c.trendExit).toEqual({ smaDays: 65, basis: "dailyClose" });
        delete c.trendExit;
        expect([r.control, r.e1, r.e2, r.otherCrypto]).toEqual([i === 0 ? "efc086b4" : "8892c1e9", "33b0ac05", "0b088ca3", i === 0 ? "8892c1e9" : "efc086b4"]);
      } else {
        const s = c.portfolio.strategy;
        expect(s).toMatchObject({ kind: "volManaged", portfolioVolTarget: 0.3, maxGross: 2.5, fastVolLookback: 5, volLookback: 63, covLookback: 21, annualization: 252, perAssetCap: 0.25 });
        expect(s.drawdownBrake).toBeUndefined();
        expect(s.regimeOverlay).toEqual({ signals: [{ kind: "maTrend", symbol: "SPY", period: 200, sampling: "daily", bandPct: 1 }], combine: "any", coreScale: 0, defensive: { assets: ["BIL"], momentumLookback: 63, volLookback: 63, cashProxy: "BIL" } });
        expect(s.pitUniverse).toEqual(i === 3 ? { topN: 6, liquidityLookback: 63, minHoldingRebalances: 21 } : undefined);
        expect(m.data.dbPath).toBe(i === 3 ? "$UC_RESEARCH_DATA_DIR/hist-sp500.db" : "./data/historical.db");
        expect(m.data.membership).toEqual(i === 3 ? { index: "sp500" } : undefined);
        for (const tier of ["base", "stress"]) expect(m.costs[tier].marginInterest.annualRate).toBe(0.065);
        expect(m.ledger.initialEquity).toBe(50_000);
        expect([r.current, r.partner, r.sameLeverage]).toEqual([i === 2 ? "33b0ac05" : "ad0cf3a2", "0b088ca3", i === 2 ? "49a1160c" : null]);
        s.portfolioVolTarget = base.candidates[0].portfolio.strategy.portfolioVolTarget;
        s.maxGross = base.candidates[0].portfolio.strategy.maxGross;
      }
      // Pin EVERY unchanged knob, universe, cost, horizon and acceptance rule, not just the new knobs.
      c.name = base.candidates[0].name;
      expect({ ...m, name: base.name, description: base.description, trialAccounting: base.trialAccounting }).toEqual(base);
    });
    expect(rw5Crypto.wired).toBe(false);
    expect(rw5CryptoRows.map(r => r.criteriaFailed)).toEqual([
      ["T1_sharpe", "T2_drawdownAndCalmar", "T3_everyCrash"],
      ["T1_sharpe", "T2_drawdownAndCalmar", "T3_everyCrash", "T4_loo", "T6_protocolGates"],
    ]);
    for (const r of [...rw5CryptoRows, ...rw5HwmRows, ...rw5TrailRows]) {
      const f = r.figures, k = r.criteria;
      const pass = {
        T1_sharpe: f.sharpe >= f.controlSharpe,
        T2_drawdownAndCalmar: f.maxDrawdownPct < f.controlMaxDrawdownPct && f.calmar >= f.controlCalmar,
        T3_everyCrash: f.crashDays.every((d: number) => d >= 20) && f.crashDrawdownsPct.every((dd: number, j: number) => dd <= f.controlCrashDrawdownsPct[j]),
        T4_psr: k.T4_psr.value >= 0.95,
        T4_folds: k.T4_folds.value.filter((v: number) => v > 0.5).length / k.T4_folds.value.length >= 2 / 3,
        T4_loo: k.T4_loo.value >= 0.6,
        T5_combinedBook: f.combinedBook.maxDrawdown <= 0.2,
        T6_protocolGates: k.T6_protocolGates.value.failedOnlyHere.length === 0,
      };
      expect(Object.fromEntries(Object.entries(k).map(([id, c]: [string, any]) => [id, c.pass]))).toEqual(pass);
      expect(r.criteriaFailed).toEqual(Object.entries(pass).filter(([, p]) => !p).map(([id]) => id));
      expect(r.criteriaVerdict).toBe(`FALLA: ${r.criteriaFailed.join(", ")}`);
      expect(r.wired).toBe(false);
    }
    for (const r of [...rw5dRows, ...rw5dCashRows]) {
      const f = r.figures, b = f.robustness;
      expect(f.deltaCagrPp).toBeGreaterThanOrEqual(3);
      expect(f.sharpe).toBeGreaterThanOrEqual(0.8 * f.currentSharpe);
      expect(f.maxDrawdownPct).toBeLessThanOrEqual(30);
      expect(f.accountMaxDrawdownPct).toBeLessThanOrEqual(30);
      expect(b.K5_R1_psr).toBeGreaterThanOrEqual(0.95);
      expect(b.K5_R4_stressSharpe).toBeGreaterThanOrEqual(0.5);
      expect(b.K5_R5_yearShare).toBeLessThanOrEqual(0.5);
      expect(b.K5_R6_exTopDecile).toBeGreaterThanOrEqual(0.3);
      expect(b.K5_R7_breakEven).toBeNull(); // data test pins the evaluator's pass=true
      if (r.sameLeverage) {
        expect(f.maxDrawdownPct).toBeLessThan(f.sameLeverageMaxDrawdownPct);
        expect(f.calmar).toBeGreaterThanOrEqual(f.sameLeverageCalmar);
        f.crashDrawdownsPct.forEach((dd: number, j: number) => {
          expect(f.crashSessions[j]).toBeGreaterThanOrEqual(20);
          expect(dd).toBeLessThanOrEqual(f.sameLeverageCrashDrawdownsPct[j]);
        });
      }
      expect(r.criteriaFailed).toEqual([]);
      expect(r.criteriaNotApplicable).toEqual(r.sameLeverage ? [] : ["K3_beatsSameLeverage", "K4_everyCrash"]);
      expect(r.criteriaVerdict).toBe("CUMPLE");
    }
    for (const [entry, r] of [[rw5d, rw5dRows[0]], [ledger.authoritativeArtifactRw5dPit, rw5dRows[1]]]) {
      expect([entry.trial, entry.path, entry.manifest]).toEqual([r.trial, r.path, r.manifest]);
    }
    expect(ledger.authoritativeArtifactRw5dPit.wired).toBe(false);
    expect(rw5d.selected).toBe(true);
    expect(rw5d.verdict).toContain("PASA K1-K7; ELEGIDO");
    expect(rw5d.wiring.reason).toContain("35%");
    expect(rw5d.wiring.reason).toContain("romper la congelacion de momentum_stocks");
    expect(rw5d.wiring.requiredBeforeWiring).toBeUndefined();
    expect(rw5d.wiring.variantTrial).toBe(453);
    expect(rw5d.wiring.artifactEntry).toBe("authoritativeArtifactRw5dCash");
    expect(rw5d.referenceNote).toContain("2x SIN contingencia");
    expect(rw5d.k7).toEqual({ trial: 449, controlTrial: 441, pass: true, criteriaFailed: [], deltaCagrPp: rw5dRows[1].figures.deltaCagrPp });
    expect(ledger.authoritativeArtifactRw5dPit.measurement).toEqual(Object.fromEntries(["cagrPct", "currentCagrPct", "deltaCagrPp", "sharpe", "currentSharpe"].map(k => [k, rw5dRows[1].figures[k]])));
    expect(rw5dRows[0].figures.cagrPct).toBeGreaterThan(rw5Row(444).figures.cagrPct);
    expect(rw5dRows[0].figures.cagrPct).toBeGreaterThan(rw5dRows[1].figures.cagrPct);
    expect(rw5.k7.pass).toBe(false); // RW5d's declared K7 does not rewrite the earlier pre-registration
  });

  test("RW5 HWM pins 450→451, the single live-manifest knob and the honest unwired failure", () => {
    const batch = ledger.batches.find((b: any) => b.id === "rw5-hwm-2026-10-24");
    expect(batch).toMatchObject({ priorUniqueTrials: 450, hypothesisCount: 1, resultingUniqueTrials: 451,
      inventoryComplete: false, resultsComplete: false, executionReported: true });
    expect(batch.sourceCommit).toBe("ae52daf (pre-registro SS16.9 antes de correr); dec3b13 (resultado SS16.10)");
    expect(ledger.batches.find((b: any) => b.id === "rw5d-2026-10-24").resultingUniqueTrials).toBe(batch.priorUniqueTrials);
    for (const p of batch.sourcePaths) expect(sourcePathPresent(p)).toBe(true);
    expect(rw5HwmRows).toHaveLength(1);
    const r = rw5HwmRows[0];
    expect(r.trial).toBe(batch.priorUniqueTrials);
    expect(r.manifest).toBe("experiments/momentum-crypto-usdc-daily-s5-rw5-xc-hwm-pure-v1.json");
    expect(batch.sourcePaths.filter((p: string) => p.startsWith("experiments/"))).toEqual([r.manifest]);
    expect(r.path).toBe("data/backtests/b45c3408a2f66775b80192b4acb024a63924670459076725310eb9a9356b1c53/");
    expect([r.control, r.e1, r.e2, r.otherCrypto]).toEqual(["8892c1e9", "33b0ac05", "0b088ca3", "efc086b4"]);
    const m = JSON.parse(readFileSync(join(root, r.manifest), "utf8"));
    const base = JSON.parse(readFileSync(join(root, "experiments/momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1.json"), "utf8"));
    expect(m.name).toBe("momentum-crypto-usdc-daily-s5-rw5-xc-hwm-pure-v1");
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 450, complete: false });
    expect(m.candidates).toHaveLength(1);
    expect(m.candidates[0].name).toBe("d13-s5-xc-dd");
    expect(m.candidates[0].exposureControl.drawdown.reference).toBe("highWaterMark");
    expect(base.candidates[0].exposureControl.drawdown.reference).toBeUndefined();
    delete m.candidates[0].exposureControl.drawdown.reference;
    // Every other candidate knob, data, cost, window, pause and acceptance rule is unchanged.
    expect({ ...m, name: base.name, description: base.description, trialAccounting: base.trialAccounting }).toEqual(base);
    expect(r.criteriaFailed).toEqual(["T1_sharpe", "T2_drawdownAndCalmar", "T4_psr", "T4_loo", "T6_protocolGates"]);
    expect(r.criteria.T6_protocolGates.value.failedOnlyHere).toEqual(["minOuterPsr"]);
    expect(r.figures.reported.ownerLine40).toBe(true);
    expect(r.figures.maxDrawdownPct).toBeLessThan(40);
    expect(r.figures.controlMaxDrawdownPct).toBeGreaterThan(40);
    expect(r.exposureStats.meanScale).toEqual([0.8226, 0.4314, 0.2777]);
    expect(r.exposureStats.minScale.slice(1)).toEqual([0.25, 0.25]);
    expect(r.wired).toBe(false);
    expect(rw5Hwm.wired).toBe(false);
    expect(rw5Hwm.verdict).toContain("FALLA");
    expect(rw5Hwm.verdict).toContain("NO SE CABLEA");
    expect(batch.evidence).toContain("hipotesis elegida tras observar 2024");
  });

  test("RW5 trail pins 451→452, only tsmTrail changes from live and all four crypto designs fail unwired", () => {
    const batch = ledger.batches.find((b: any) => b.id === "rw5-trail-2026-10-24");
    expect(batch).toMatchObject({ priorUniqueTrials: 451, hypothesisCount: 1, resultingUniqueTrials: 452,
      inventoryComplete: false, resultsComplete: false, executionReported: true });
    expect(batch.sourceCommit).toBe("8297f89 (pre-registro SS16.11 antes de correr); 6add7ba (resultado y cierre SS16.12)");
    expect(ledger.batches.find((b: any) => b.id === "rw5-hwm-2026-10-24").resultingUniqueTrials).toBe(batch.priorUniqueTrials);
    for (const p of batch.sourcePaths) expect(sourcePathPresent(p)).toBe(true);
    expect(rw5TrailRows).toHaveLength(1);
    const r = rw5TrailRows[0];
    expect(r.trial).toBe(batch.priorUniqueTrials);
    expect(r.manifest).toBe("experiments/momentum-crypto-usdc-daily-s5-rw5-trail-chandelier-pure-v1.json");
    expect(batch.sourcePaths.filter((p: string) => p.startsWith("experiments/"))).toEqual([r.manifest]);
    expect(r.path).toBe("data/backtests/57cf6c19e2590c9a92472fc592095a34cc6ca7198bd06881409da4a21f56e148/");
    expect([r.control, r.e1, r.e2, r.otherCrypto]).toEqual(["8892c1e9", "33b0ac05", "0b088ca3", "efc086b4"]);
    const m = JSON.parse(readFileSync(join(root, r.manifest), "utf8"));
    const base = JSON.parse(readFileSync(join(root, "experiments/momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1.json"), "utf8"));
    expect(m.name).toBe("momentum-crypto-usdc-daily-s5-rw5-trail-chandelier-pure-v1");
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 451, complete: false });
    expect(m.candidates).toHaveLength(1);
    expect(m.candidates[0].name).toBe("d13-s5-xc-dd-trail4s22");
    expect(m.candidates[0].tsmTrail).toEqual({ kSigma: 4, lookbackBars: 22, minPct: 5, maxPct: 30 });
    expect(base.candidates[0].tsmTrail).toEqual({ kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 });
    m.candidates[0].name = base.candidates[0].name;
    m.candidates[0].tsmTrail = base.candidates[0].tsmTrail;
    // Every other knob, including the hard stop, exposure control, costs and gates, is live's.
    expect({ ...m, name: base.name, description: base.description, trialAccounting: base.trialAccounting }).toEqual(base);
    expect(r.criteriaFailed).toEqual(["T1_sharpe", "T2_drawdownAndCalmar", "T3_everyCrash", "T4_psr", "T6_protocolGates"]);
    expect(r.criteria.T6_protocolGates.value.failedOnlyHere).toEqual(["stressMaxDrawdown", "looMaxDrawdown", "minOuterPsr"]);
    expect(r.figures.reported.ownerLine40).toBe(false);
    expect(r.figures.maxDrawdownPct).toBeGreaterThan(50);
    expect(r.figures.reported.trades).toEqual([148, 107]);
    expect(r.figures.crashDrawdownsPct[3]).toBeGreaterThan(r.figures.controlCrashDrawdownsPct[3]);
    const round = [...rw5CryptoRows, ...rw5HwmRows, ...rw5TrailRows];
    expect(round.map(r => r.trial)).toEqual([446, 447, 450, 451]);
    for (const r of round) {
      expect(r.criteriaFailed.length).toBeGreaterThan(0);
      expect(r.criteriaVerdict).toBe(`FALLA: ${r.criteriaFailed.join(", ")}`);
      expect(r.wired).toBe(false);
    }
    expect(rw5Trail.wired).toBe(false);
    expect(rw5Trail.verdict).toContain("FALLA");
    expect(rw5Trail.verdict).toContain("NO SE CABLEA");
    expect(batch.evidence).toContain("hipotesis elegida tras observar 2024");
    expect(batch.evidence).toContain("los cuatro disenos de contingencia cripto fallan");
    expect(batch.evidence).toContain("estructural en este backtest");
    expect(batch.evidence).toContain("tamano, decision de riesgo del dueno, no un nuevo sizing validado");
  });

  testWithDb("RW5 crypto/HWM/trail/size/short artifacts reproduce every T/S/O value, figure, verdict and short telemetry through rw5-crypto-evaluate.ts --json", () => {
    const r4 = rw5Round;
    for (const r of [...rw5CryptoRows, ...rw5HwmRows, ...rw5TrailRows, ...rw5Q5SizeRows, ...rw5Q5ShortRows]) {
      const proc = Bun.spawnSync([process.execPath, "scripts/rw5-crypto-evaluate.ts", r.path, "--control", rw5CryptoPath(r.control), "--e1", rw5Path(r.e1), "--e2", rw5Path(r.e2), "--other-crypto", rw5CryptoPath(r.otherCrypto), ...(r.trial === 452 ? ["--sizing"] : rw5Q5ShortRows.includes(r) ? ["--overlay"] : []), "--json"], { cwd: root });
      expect({ trial: r.trial, exit: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ trial: r.trial, exit: 0, stderr: "" });
      const e = JSON.parse(proc.stdout.toString()), s = e.candidateStats, a = e.controlStats;
      expect(e.windows.map((w: any) => [w.id, w.from, w.to])).toEqual([
        ["2022_ftx", "2022-11-01", "2023-01-31"], ["2024_correction", "2024-03-13", "2024-09-30"],
        ["2025_q1", "2025-01-21", "2025-05-31"], ["2025_26_bear", "2025-10-06", "2026-08-31"],
      ]);
      expect(r.figures).toEqual({
        commonDays: e.commonDays, from: e.from, to: e.to, cagrPct: r4(s.cagr * 100), controlCagrPct: r4(a.cagr * 100),
        totalReturnPct: r4(s.totalReturn * 100), controlTotalReturnPct: r4(a.totalReturn * 100), sharpe: r4(s.sharpe), controlSharpe: r4(a.sharpe),
        maxDrawdownPct: r4(s.maxDrawdown * 100), controlMaxDrawdownPct: r4(a.maxDrawdown * 100), calmar: r4(s.calmar), controlCalmar: r4(a.calmar),
        crashDrawdownsPct: e.windows.map((w: any) => r4(w.candidate * 100)), controlCrashDrawdownsPct: e.windows.map((w: any) => r4(w.control * 100)), crashDays: e.windows.map((w: any) => w.days),
        combinedBook: { ...e.combinedBook, totalReturn: r4(e.combinedBook.totalReturn), maxDrawdown: r4(e.combinedBook.maxDrawdown) },
        reported: { ...e.reported, fees: e.reported.fees.map(r4), turnoverAnnual: e.reported.turnoverAnnual.map((x: number[]) => x.map(r4)) },
      });
      expect(r.criteria).toEqual(e.criteria);
      expect(r.criteriaFailed).toEqual(Object.entries(e.criteria).filter(([, k]: [string, any]) => !k.pass).map(([id]) => id));
      expect(r.criteriaVerdict).toBe(e.verdict);
      const resolved = JSON.parse(readFileSync(join(root, r.path, "manifest-resolved.json"), "utf8"));
      const manifest = JSON.parse(readFileSync(join(root, r.manifest), "utf8"));
      expect([resolved.name, resolved.trialAccounting, resolved.candidates]).toEqual([manifest.name, manifest.trialAccounting, manifest.candidates]);
      const summary = JSON.parse(readFileSync(join(root, r.path, "summary.json"), "utf8"));
      const control = JSON.parse(readFileSync(join(root, rw5CryptoPath(r.control), "summary.json"), "utf8"));
      expect(summary.outerSelection.every((s: any) => s.candidateName === manifest.candidates[0].name)).toBe(true);
      const folds = (s: any) => s.outerTests.map((t: any) => [t.foldPath, t.result.fromMs, t.result.toMs]);
      expect(summary.outerTests).toHaveLength(3);
      expect(folds(summary)).toEqual(folds(control));
      if (rw5Q5ShortRows.includes(r)) {
        expect([summary.dataHash, control.dataHash]).toEqual([r.dataHash, r.controlDataHash]);
        expect(summary.dataHash).not.toBe(control.dataHash); // declared extra daily history, not identical inputs
        const key = r.trial === 454 ? "idleOverlayStats" : "breakoutShortStats";
        const stats = summary.outerTests.map((t: any) => t.result[key]);
        const normalize = (s: any) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === "exits" ? v : r4(v as number)]));
        const total: Record<string, any> = {};
        // Sum unrounded fold values: summing the ledger's rounded days can lose 0.0001.
        for (const s of stats) {
          for (const [k, v] of Object.entries(s)) {
            if (k === "exits") {
              total.exits ??= {};
              for (const [reason, n] of Object.entries(v as Record<string, number>)) total.exits[reason] = (total.exits[reason] ?? 0) + n;
            } else total[k] = (total[k] ?? 0) + (v as number);
          }
        }
        expect(r[key]).toEqual({ folds: stats.map(normalize), total: normalize(total) });
        expect(total.orders).toBe(total.opens + total.closes);
        expect(total.opens).toBe(total.closes);
        if (key === "breakoutShortStats") expect(Object.values(total.exits).reduce((a: number, n: any) => a + n, 0)).toBe(total.closes);
        expect(r.wired).toBe(false);
      }
      if (r.trial === 452) {
        expect(summary.dataHash).toBe(control.dataHash);
        expect(e.verdict).toBe("FALLA: S1_ownerLine, S2_calmar, S3_sharpe");
        expect(rw5Q5Size.verdict).toContain("FALLA S1-S3");
        expect(rw5Q5Size.wired).toBe(false);
      }
      if (r.trial === 451) {
        expect(summary.dataHash).toBe(control.dataHash);
        expect(e.verdict.startsWith("FALLA:")).toBe(true);
        expect(rw5Trail.verdict).toContain("FALLA");
        expect(rw5Trail.wired).toBe(false);
      }
      if (r.trial === 450) {
        expect(summary.dataHash).toBe(control.dataHash);
        const scales = (s: any, key: string) => s.outerTests.map((t: any) => r4(t.result.exposureStats[key]));
        expect(r.exposureStats).toEqual({
          meanScale: scales(summary, "meanScale"), controlMeanScale: scales(control, "meanScale"),
          minScale: scales(summary, "minScale"), controlMinScale: scales(control, "minScale"),
        });
        expect(e.verdict.startsWith("FALLA:")).toBe(true);
        expect(rw5Hwm.verdict).toContain("FALLA");
        expect(rw5Hwm.wired).toBe(false);
      }
    }
  }, 120_000);

  test("Q5 sizing/cash pin 452→454, single manifest changes, conditional rejection and wiring through cash", () => {
    const ids = ["rw5-q5-size-2026-10-24", "rw5d-cash-2026-10-24"];
    const batches = ids.map(id => ledger.batches.find((b: any) => b.id === id));
    expect(batches.map((b: any) => [b.id, b.priorUniqueTrials, b.hypothesisCount, b.resultingUniqueTrials]))
      .toEqual([[ids[0], 452, 1, 453], [ids[1], 453, 1, 454]]);
    expect(ledger.batches.find((b: any) => b.id === "rw5-trail-2026-10-24").resultingUniqueTrials).toBe(batches[0].priorUniqueTrials);
    expect(batches[1].id).toBe(ids[1]);
    expect(batches[1].resultingUniqueTrials).toBe(454);
    expect(batches.map((b: any) => b.sourceCommit)).toEqual([
      "7be4c50 (pre-registro SS16.13 antes de correr); cfaa87b (resultado SS16.14)",
      "ab11fe5 (pre-registro SS16.15 antes de correr); 59bebd9 (resultado SS16.16)",
    ]);
    expect(rw5Q5SizeRows).toHaveLength(1);
    expect(rw5dCashRows).toHaveLength(1);
    const designs = [
      [rw5Q5SizeRows[0], "momentum-crypto-usdc-daily-s5-rw5-size075-pure-v1", "bffc241253b03ce381f9a043e1f81d971320f51b3c96d4a8fdafd2358cc281ca", "momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1", "d13-s5-xc-dd-size075"],
      [rw5dCashRows[0], "rw5-e1-lev-vt30-g250-sma200-fastvol5-cash-v1", "fb410729eaf8cbe6efd32c0193f2e23b0313af4ceae0514aebdff1109a66e74b", "rw5-e1-lev-vt30-g250-sma200-fastvol5-v1", "e1-lev-vt30-g250-sma200-fastvol5"],
    ] as const;
    designs.forEach(([r, stem, artifact, baseStem, name], i) => {
      const batch = batches[i];
      expect(batch).toMatchObject({ inventoryComplete: false, resultsComplete: false, executionReported: true });
      for (const p of batch.sourcePaths) expect(sourcePathPresent(p)).toBe(true);
      expect(r.trial).toBe(452 + i);
      expect(r.manifest).toBe(`experiments/${stem}.json`);
      expect(r.path).toBe(`data/backtests/${artifact}/`);
      expect(batch.sourcePaths.filter((p: string) => p.startsWith("experiments/"))).toEqual([r.manifest]);
      const m = JSON.parse(readFileSync(join(root, r.manifest), "utf8"));
      const base = JSON.parse(readFileSync(join(root, `experiments/${baseStem}.json`), "utf8"));
      expect(m.name).toBe(stem);
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: r.trial, complete: false });
      expect(m.candidates).toHaveLength(1);
      const c = m.candidates[0], b = base.candidates[0];
      expect(c.name).toBe(name);
      if (i === 0) {
        expect([c.notionalPctPerSlot, b.notionalPctPerSlot]).toEqual([0.15, 0.20]);
        expect(c.maxLongs).toBe(5);
        c.notionalPctPerSlot = b.notionalPctPerSlot;
        expect([r.control, r.e1, r.e2, r.otherCrypto]).toEqual(["8892c1e9", "33b0ac05", "0b088ca3", "efc086b4"]);
      } else {
        expect(c.portfolio.strategy.regimeOverlay.defensive).toBeUndefined();
        expect(b.portfolio.strategy.regimeOverlay.defensive).toEqual({ assets: ["BIL"], momentumLookback: 63, volLookback: 63, cashProxy: "BIL" });
        c.portfolio.strategy.regimeOverlay.defensive = b.portfolio.strategy.regimeOverlay.defensive;
        expect([r.current, r.partner, r.sameLeverage]).toEqual(["33b0ac05", "0b088ca3", "49a1160c"]);
      }
      c.name = b.name;
      // Every other knob, data source, cost, window and acceptance rule must be identical.
      expect({ ...m, name: base.name, description: base.description, trialAccounting: base.trialAccounting }).toEqual(base);
    });
    const r = rw5Q5SizeRows[0], f = r.figures, k = r.criteria;
    const pass = {
      S1_ownerLine: f.maxDrawdownPct <= 40,
      S2_calmar: f.calmar >= f.controlCalmar,
      S3_sharpe: f.sharpe >= f.controlSharpe - 0.05,
      T4_psr: k.T4_psr.value >= 0.95,
      T4_folds: k.T4_folds.value.filter((v: number) => v > 0.5).length / k.T4_folds.value.length >= 2 / 3,
      T4_loo: k.T4_loo.value >= 0.6,
      T5_combinedBook: f.combinedBook.maxDrawdown <= 0.2,
      T6_protocolGates: k.T6_protocolGates.value.failedOnlyHere.length === 0,
    };
    expect(Object.fromEntries(Object.entries(k).map(([id, c]: [string, any]) => [id, c.pass]))).toEqual(pass);
    expect(r.criteriaFailed).toEqual(Object.entries(pass).filter(([, p]) => !p).map(([id]) => id));
    expect(r.criteriaFailed).toEqual(["S1_ownerLine", "S2_calmar", "S3_sharpe"]);
    expect(r.criteriaVerdict).toBe(`FALLA: ${r.criteriaFailed.join(", ")}`);
    expect([r.wired, rw5Q5Size.wired]).toEqual([false, false]);
    expect(rw5Q5Size.verdict).toContain("NO SE CABLEA");
    expect(batches[0].evidence).toContain("al fallar queda A");
    expect(f.reported.ownerLine40).toBe(false);
    expect(f.reported.trades).toEqual([117, 107]);

    const cash = rw5dCashRows[0], parity = rw5dCash.parity, wiring = rw5dCash.wiring;
    expect([rw5dCash.trial, rw5dCash.manifest, rw5dCash.path]).toEqual([cash.trial, cash.manifest, cash.path]);
    expect([cash.criteriaFailed, cash.criteriaNotApplicable, cash.criteriaVerdict]).toEqual([[], [], "CUMPLE"]);
    expect([rw5d.wired, rw5dCash.wired]).toEqual([true, true]);
    expect(rw5dCash.verdict).toContain("PASA K1-K6 y PARIDAD");
    expect(rw5d.verdict).toContain("CABLEADO mediante la variante en efectivo #453");
    expect(rw5d.path).not.toBe(cash.path); // keep #448's original evidence and K7, not relabel it as cash
    expect(parity).toMatchObject({ controlTrial: rw5d.trial, controlPath: rw5d.path, ppy: 252, commonDays: 1755, deltaSharpe: -0.0029, maxAbsDeltaSharpe: 0.1 });
    expect(parity.pass).toBe(Math.abs(parity.deltaSharpe) <= parity.maxAbsDeltaSharpe);
    expect(rw5d.wiring).toMatchObject({ variantTrial: cash.trial, version: wiring.version, wiredAt: wiring.wiredAt, firstLivePass: wiring.firstLivePass });
    expect(wiring).toMatchObject({ version: "momentum_stocks@pe-vt30-g250-sma200-fv5", wiredAt: "2026-10-24T18:31:00Z", firstLivePass: "2026-10-26T13:35:00Z", modelStart: "2026-10-27" });
    const versions = readFileSync(join(root, "src/portfolio/modelVersions.ts"), "utf8");
    const version = versions.slice(versions.indexOf(`{ id: "${wiring.version}"`)).split("},")[0];
    expect(version).toContain(`since: "${wiring.firstLivePass}"`);
    expect(version).toContain(`modelStart: "${wiring.modelStart}"`);
    expect(version).toContain(`manifest: "${cash.manifest}"`);
    expect(version).toContain(cash.path.replace(/\/$/, ""));
  });

  test("Q5 shorts pin 454→456, live plus one knob, failed criteria and the closing balance", () => {
    const ids = ["rw5-q5-idle-tsm-2026-10-24", "rw5-q5-breakout-2026-10-24"];
    const batches = ids.map(id => ledger.batches.find((b: any) => b.id === id));
    expect(batches.map((b: any) => [b.id, b.priorUniqueTrials, b.hypothesisCount, b.resultingUniqueTrials]))
      .toEqual([[ids[0], 454, 1, 455], [ids[1], 455, 1, 456]]);
    expect(ledger.batches.find((b: any) => b.id === "rw5d-cash-2026-10-24").resultingUniqueTrials).toBe(batches[0].priorUniqueTrials);
    expect(batches.map((b: any) => b.sourceCommit)).toEqual([
      "96a96b4 (pre-registro SS16.17 antes de correr); 0bcea00 (resultado SS16.18)",
      "22e38d1 (pre-registro SS16.19 antes de correr); f26139f (resultado y cierre SS16.20)",
    ]);
    expect(rw5Q5IdleTsm.candidates).toHaveLength(1);
    expect(rw5Q5Breakout.candidates).toHaveLength(1);
    const designs = [
      [rw5Q5IdleTsm, "momentum-crypto-rw5-idle-tsm12-pure-v1", "f5c9e72d1b5b8315037d7394aedc7f4c80ff690a6555667c7958f8c282909a04", "idleOverlay",
        { kind: "tsm", symbols: ["BTC/USD", "ETH/USD"], lookbackDays: 365, volTargetPerAsset: 0.4, ewmaCenterOfMassDays: 60, annualization: 365 },
        ["O2_ownerLine", "T3_everyCrash", "T4_loo", "T6_protocolGates"]],
      [rw5Q5Breakout, "momentum-crypto-rw5-btc-breakout55-pure-v1", "726b818d81ce14177b9e4779d8609a5c57d3170632e96f527968e2c01eb48c11", "breakoutShort",
        { symbol: "BTC/USD", entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01 },
        ["O1_moreReturn", "T3_everyCrash"]],
    ] as const;
    designs.forEach(([entry, stem, artifact, knob, setting, failed], i) => {
      const batch = batches[i], r = entry.candidates[0];
      expect(batch).toMatchObject({ inventoryComplete: false, resultsComplete: false, executionReported: true });
      for (const p of batch.sourcePaths) expect(sourcePathPresent(p)).toBe(true);
      expect(r.trial).toBe(454 + i);
      expect(r.manifest).toBe(`experiments/${stem}.json`);
      expect(r.path).toBe(`data/backtests/${artifact}/`);
      expect(batch.sourcePaths.filter((p: string) => p.startsWith("experiments/"))).toEqual([r.manifest]);
      expect([r.control, r.e1, r.e2, r.otherCrypto]).toEqual(["efc086b4", "33b0ac05", "0b088ca3", "8892c1e9"]);
      const m = JSON.parse(readFileSync(join(root, r.manifest), "utf8"));
      const base = JSON.parse(readFileSync(join(root, "experiments/momentum-crypto-rw3-vt-35-corroff-pure-v1.json"), "utf8"));
      expect(m.name).toBe(stem);
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: r.trial, complete: false });
      expect(m.candidates).toHaveLength(1);
      expect(m.candidates[0].name).toBe("vt-35-corr92");
      expect(m.candidates[0][knob]).toEqual(setting);
      expect(base.candidates[0][knob]).toBeUndefined();
      delete m.candidates[0][knob];
      // All other settings, data declaration, costs, folds and acceptance gates stay live's.
      expect({ ...m, name: base.name, description: base.description, trialAccounting: base.trialAccounting }).toEqual(base);
      const f = r.figures, k = r.criteria;
      const pass = {
        O1_moreReturn: f.cagrPct >= f.controlCagrPct + 3,
        O2_ownerLine: f.maxDrawdownPct <= 40,
        T1_sharpe: f.sharpe >= f.controlSharpe,
        T3_everyCrash: f.crashDays.every((n: number) => n >= 20) && f.crashDrawdownsPct.every((dd: number, j: number) => dd <= f.controlCrashDrawdownsPct[j]),
        T4_psr: k.T4_psr.value >= 0.95,
        T4_folds: k.T4_folds.value.filter((v: number) => v > 0.5).length / k.T4_folds.value.length >= 2 / 3,
        T4_loo: k.T4_loo.value >= 0.6,
        T5_combinedBook: f.combinedBook.maxDrawdown <= 0.2,
        T6_protocolGates: k.T6_protocolGates.value.failedOnlyHere.length === 0,
      };
      expect(Object.fromEntries(Object.entries(k).map(([id, c]: [string, any]) => [id, c.pass]))).toEqual(pass);
      expect(r.criteriaFailed).toEqual(Object.entries(pass).filter(([, p]) => !p).map(([id]) => id));
      expect(r.criteriaFailed).toEqual(failed);
      expect(r.criteriaVerdict).toBe(`FALLA: ${r.criteriaFailed.join(", ")}`);
      expect([r.wired, entry.wired]).toEqual([false, false]);
      expect(entry.verdict).toContain("FALLA");
      expect(entry.verdict).toContain("NO SE CABLEA");
      expect(batch.evidence).toContain("historia diaria extra declarada");
      expect(batch.evidence).toContain("no evidencia independiente");
    });
    const idle = rw5Q5IdleTsm.candidates[0], breakout = rw5Q5Breakout.candidates[0];
    expect(idle.criteria.T6_protocolGates.value.failedOnlyHere).toEqual(["maxDrawdown"]);
    expect(idle.idleOverlayStats.total).toEqual({ orders: 88, opens: 44, closes: 44, activeDays: 163.2083, longDays: 67.9167, shortDays: 115.7083, fundingPaid: 58.1734 });
    expect(breakout.breakoutShortStats.total).toEqual({ orders: 26, opens: 13, closes: 13, shortDays: 332.9583, fundingPaid: -57.8731,
      exits: { BREAKOUT_SHORT_EXIT: 3, BREAKOUT_SHORT_STOP: 5, BREAKOUT_SHORT_PRIORITY: 5 } });
    expect(batches[1].evidence).toContain("los dos disenos de cortos Q5 fallan");
    expect(batches[1].evidence).toContain("sin pausa ni reasignacion");
    expect(rw5Q5Breakout.verdict).toContain("los dos disenos de cortos Q5 fallan");
  });

  const rw6Stocks = ledger.authoritativeArtifactRw6Stocks;
  const rw6Crypto = ledger.authoritativeArtifactRw6Crypto;
  const rw6Rows = [...rw6Stocks.candidates, ...rw6Crypto.candidates];
  const rw6Paths: Record<string, string> = {
    ...ledger.rw6Controls.paths,
    ...Object.fromEntries(rw6Rows.map(r => [r.path.split("/")[2].slice(0, 8), r.path])),
  };
  const rw6Designs = [
    ["rw6-e1-lev-vt30-g250-maxhold5-v1", "721d4998f845909c84a0fc35e6dbb44d5fc93cd62de741ff545b1cfd75a8ab03", "rw5-e1-lev-vt30-g250-sma200-fastvol5-cash-v1", "fb410729", "momentum_stocks@pe-vt30-g250-sma200-fv5-mh5"],
    ["rw6-e1-lev-vt30-g250-maxhold5-sh50-v1", "af69f21f6d8cc4bf9e4a2ac4e2f06b7b6aa6dcaaf4ddea7abc74d007fe376637", "rw6-e1-lev-vt30-g250-maxhold5-v1", "721d4998", null],
    ["rw6-e2-meanrev-maxhold5-v1", "41fdc636f209217bede8220cd4d690000ea4b4e71983dab1f5a6c99a2d5c3ee2", "rw2-e2-meanrev-volmanaged-v1", "0b088ca3", "meanrev_stocks@pe-vt15-mh5"],
    ["momentum-crypto-rw6-maxhold5-pure-v1", "b4abce2e6fbca40228f160418331b300c8ed8f9ba75b38cb6e3e4de901aa0f6b", "momentum-crypto-rw3-vt-35-corroff-pure-v1", "efc086b4", "momentum_crypto@vt35-corroff-mh120"],
    ["momentum-crypto-rw6-maxhold5-breakout55-pure-v1", "67ca214434449bc183b16f9636fab0d14edd6460a0125ac524dd07c5672f0948", "momentum-crypto-rw6-maxhold5-pure-v1", "b4abce2e", null],
    ["momentum-crypto-usdc-daily-s5-rw6-maxhold5-pure-v1", "74efd64b61a839df9844fbe7039c384cd694a0b4ad2d319762b0d71798bfb783", "momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1", "8892c1e9", "momentum_crypto_usdc@daily-d13s5-xc-dd-mh120"],
  ] as const;

  test("RW6 selects batches by id and pins six finished trials 456→462, owner constraints, costs and wiring", () => {
    const ids = ["rw6-stocks-2026-10-26", "rw6-crypto-2026-10-26"];
    const batches = ids.map(id => ledger.batches.find((b: any) => b.id === id));
    expect(batches.map((b: any) => [b.id, b.priorUniqueTrials, b.hypothesisCount, b.resultingUniqueTrials]))
      .toEqual([[ids[0], 456, 3, 459], [ids[1], 459, 3, 462]]);
    expect(ledger.batches.find((b: any) => b.id === "rw5-q5-breakout-2026-10-24").resultingUniqueTrials).toBe(batches[0].priorUniqueTrials);
    expect(ledger.batches.at(-1).id).toBe(ids[1]);
    expect(ledger.batches.at(-1).resultingUniqueTrials).toBe(462);
    expect(batches.map((b: any) => b.sourceCommit)).toEqual([
      "863c647 (pre-registro SS17.1 antes de correr); c57e7ba (resultado SS17.2)",
      "c57e7ba (pre-registro SS17.2 antes de correr); 8dceb77 (resultado SS17.3)",
    ]);
    expect([rw6Stocks.candidates.length, rw6Crypto.candidates.length]).toEqual([3, 3]);
    expect(rw6Rows.map(r => r.trial)).toEqual([456, 457, 458, 459, 460, 461]);
    expect(new Set(rw6Rows.map(r => r.path)).size).toBe(6);
    expect(ledger.rw6Controls.trialsAdded).toBe(0);
    expect(ledger.rw6Controls.paths).toEqual({
      fb410729: ledger.authoritativeArtifactRw5dCash.path,
      "0b088ca3": ledger.rw5Controls.paths["0b088ca3"],
      efc086b4: ledger.rw4Controls.controls.cryptoLive.path,
      "8892c1e9": ledger.authoritativeArtifactRw4aC2.path,
    });
    batches.forEach((b: any, i: number) => {
      expect(b).toMatchObject({ inventoryComplete: false, resultsComplete: false, executionReported: true });
      for (const p of b.sourcePaths) expect(sourcePathPresent(p)).toBe(true);
      expect(b.sourcePaths.filter((p: string) => p.startsWith("experiments/"))).toEqual(rw6Rows.slice(i * 3, i * 3 + 3).map(r => r.manifest));
      expect(b.evidence).toContain("restriccion del dueno");
      expect(b.evidence).toContain("sin pausa ni reasignacion");
    });
    for (const entry of [rw6Stocks, rw6Crypto]) {
      expect(entry.wiring).toEqual({ commit: "c25a751", wiredAt: "2026-10-26T06:03:00Z" });
      expect(entry.verdict).toContain("NO SE CABLEA");
    }
    expect(rw6Rows.map(r => r.figures.deltaCagrPp)).toEqual([-3.5947, -1.9535, -1.7913, -39.3346, -1.0666, -20.3927]);
    for (const r of rw6Rows) {
      const f = r.figures;
      const pass = r.criterion === "H"
        ? { H_cagr: f.cagrPct >= 0, H_bookDrawdown: (r.trial < 459 ? f.accountMaxDrawdownPct : f.combinedBookMaxDrawdownPct) <= 35 }
        : { S_cagr: f.cagrPct >= f.controlCagrPct, S_sleeveDrawdown: f.maxDrawdownPct <= (r.trial < 459 ? 35 : 40) };
      const failed = Object.entries(pass).filter(([, p]) => !p).map(([id]) => id);
      expect(r.criteriaFailed).toEqual(failed);
      expect(r.wired).toBe(failed.length === 0);
      expect(r.criteriaVerdict).toBe(r.wired ? "CUMPLE H; CABLEADO" : "FALLA S; NO SE CABLEA");
      expect(f.cagrPct - f.controlCagrPct).toBeCloseTo(f.deltaCagrPp, 3);
    }
    // H binds the ACCOUNT/BOOK, not each sleeve: USDC's >40% DD still passes H.
    expect(rw6Rows[5].figures.maxDrawdownPct).toBeGreaterThan(40);
    expect(rw6Rows[5].wired).toBe(true);
    const estimate = rw6Crypto.publishedOrdersEstimate;
    expect([estimate.ordersPerDayApprox, estimate.goal]).toEqual([19, 30]);
    expect(estimate.note).toContain("omiten ajustes");
  });

  test("RW6 manifests preserve every live knob except the preregistered hold/short axes, and versions match wiring", () => {
    const versions = readFileSync(join(root, "src/portfolio/modelVersions.ts"), "utf8");
    rw6Designs.forEach(([stem, artifact, baseStem, control, version], i) => {
      const r = rw6Rows[i];
      expect([r.manifest, r.path, r.control, r.version]).toEqual([`experiments/${stem}.json`, `data/backtests/${artifact}/`, control, version]);
      expect(r.criterion).toBe(i === 1 || i === 4 ? "S" : "H");
      expect(r.wired).toBe(version !== null);
      expect(rw6Paths[control]).toMatch(new RegExp(`^data/backtests/${control}[0-9a-f]{56}/$`));
      const m = JSON.parse(readFileSync(join(root, r.manifest), "utf8"));
      const base = JSON.parse(readFileSync(join(root, `experiments/${baseStem}.json`), "utf8"));
      expect(m.name).toBe(stem);
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: r.trial, complete: false });
      expect(m.candidates).toHaveLength(1);
      // E2's control manifest also contains vt12, which is NOT this trial's control.
      if (i === 2) base.candidates = base.candidates.filter((c: any) => c.name === "vt15");
      expect(base.candidates).toHaveLength(1);
      const c = m.candidates[0];
      if (i < 3) {
        expect(c.portfolio.strategy.maxHoldSessions).toBe(5);
        expect(r.partner).toBe(i === 2 ? "721d4998" : "41fdc636");
        if (i === 1) {
          expect(c.portfolio.strategy.regimeOverlay.hedge).toEqual({ symbol: "SH", fraction: 0.5 });
          delete c.portfolio.strategy.regimeOverlay.hedge;
          expect(m.data.universe.pop()).toBe("SH");
        } else delete c.portfolio.strategy.maxHoldSessions;
      } else {
        expect(c.timeStop).toEqual({ maxHoldHours: 120 });
        expect([r.e1, r.e2, r.otherCrypto]).toEqual(["721d4998", "41fdc636", i === 5 ? "b4abce2e" : "8892c1e9"]);
        if (i === 4) {
          expect(c.breakoutShort).toEqual({ symbol: "BTC/USD", entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 });
          delete c.breakoutShort;
        } else delete c.timeStop;
      }
      c.name = base.candidates[0].name;
      expect({ ...m, name: base.name, description: base.description, trialAccounting: base.trialAccounting }).toEqual(base);
      if (version) {
        const block = versions.slice(versions.indexOf(`{ id: "${version}"`)).split("},")[0];
        expect(block).toContain(`manifest: "${r.manifest}"`);
        expect(block).toContain(r.path.replace(/\/$/, ""));
      }
    });
  });

  testWithDb("RW6 artifacts reproduce H/S figures, costs, account/book DD and complete executed-order counters", () => {
    const r4 = rw5Round;
    const summary = (p: string) => JSON.parse(readFileSync(join(root, p, "summary.json"), "utf8"));
    for (const r of rw6Rows) {
      // Gate on the source DB, NOT artifact presence: missing evidence must fail in a research checkout.
      const s = summary(r.path), a = summary(rw6Paths[r.control]);
      const m = JSON.parse(readFileSync(join(root, r.manifest), "utf8"));
      const resolved = JSON.parse(readFileSync(join(root, r.path, "manifest-resolved.json"), "utf8"));
      expect(resolved.candidates).toEqual(m.candidates);
      expect(s.selectedCandidate.name).toBe(m.candidates[0].name);
      expect([s.dataHash, a.dataHash]).toEqual([r.dataHash, r.controlDataHash]);
      const folds = (x: any) => x.outerTests.map((t: any) => [t.foldPath, t.result.fromMs, t.result.toMs]);
      expect(folds(s)).toEqual(folds(a));
      expect(s.approved).toBe(false);
      expect(r.gatesFailed).toEqual(Object.values(s.acceptance).filter((g: any) => !g.pass).map((g: any) => g.gate).sort());
      let cmp, bookDrawdown;
      if (r.trial < 459) {
        cmp = compareArtifacts(join(root, r.path), join(root, rw6Paths[r.control]), 252);
        bookDrawdown = combinedBookDrawdown([r.path, rw6Paths[r.partner]].map(p => new Map(loadArtifactOuterDailyReturns(join(root, p)).map(x => [x.date, x.ret]))), [50_000, 50_000]).maxDrawdown;
        expect(s.stressTests).toHaveLength(s.outerTests.length);
        expect(s.loo.length).toBeGreaterThan(0);
        expect([s._stressSkipReason, s._looSkipReason]).toEqual(["missing stress threshold(s)", "missing LOO threshold(s)"]);
        for (const gate of r.gatesFailed) expect(s.acceptance[gate]).toMatchObject({ value: null, threshold: null, pass: false });
      } else {
        const e = evaluateCrypto({ candidate: join(root, r.path), control: join(root, rw6Paths[r.control]),
          e1: join(root, rw6Paths[r.e1]), e2: join(root, rw6Paths[r.e2]), otherCrypto: join(root, rw6Paths[r.otherCrypto]) });
        cmp = { commonDays: e.commonDays, from: e.from, to: e.to, candidate: e.candidateStats, control: e.controlStats };
        bookDrawdown = e.combinedBook.maxDrawdown;
        // The RW5 evaluator supplies figures, NOT RW6's owner-constraint verdict.
        expect(e.verdict).toStartWith("FALLA:");
      }
      const c = cmp.candidate, b = cmp.control;
      expect(r.figures).toEqual({ commonDays: cmp.commonDays, from: cmp.from, to: cmp.to,
        cagrPct: r4(c.cagr * 100), controlCagrPct: r4(b.cagr * 100), deltaCagrPp: r4((c.cagr - b.cagr) * 100),
        sharpe: r4(c.sharpe), controlSharpe: r4(b.sharpe), maxDrawdownPct: r4(c.maxDrawdown * 100), controlMaxDrawdownPct: r4(b.maxDrawdown * 100),
        [r.trial < 459 ? "accountMaxDrawdownPct" : "combinedBookMaxDrawdownPct"]: r4(bookDrawdown * 100) });
      const results = s.outerTests.map((t: any) => t.result);
      const trades = results.reduce((n: number, x: any) => n + x.trades, 0);
      expect(trades).toBe(s.stitchedOos.trades);
      if (r.trial < 459) {
        const sum = (key: string) => results.reduce((n: number, x: any) => n + x.portfolioDiagnostics[key], 0);
        const sessions = sum("sessions"), diagnosticOrders = sum("orders"), foldEndOrders = sum("foldEndOrders");
        const orders = diagnosticOrders + foldEndOrders;
        expect(r.execution).toEqual({ trades, sessions, diagnosticOrders, foldEndOrders, adjustmentOrders: sum("adjustmentOrders"), orders,
          tradesPerSession: r4(trades / sessions), roundTripProxyOrdersPerSession: r4(2 * trades / sessions), ordersPerSession: r4(orders / sessions) });
        expect(orders).toBe(sum("openingOrders") + sum("closingOrders") + sum("adjustmentOrders") + sum("stopOrders") + foldEndOrders);
        expect(orders).toBeGreaterThan(2 * trades); // the published ~19/day proxy omits adjustments
      } else {
        const orders = results.reduce((n: number, x: any) => n + x.orders, 0);
        const calendarDays = results.reduce((n: number, x: any) => n + (x.toMs - x.fromMs) / 86_400_000, 0);
        expect(r.execution).toEqual({ trades, orders, calendarDays: r4(calendarDays), ordersPerCalendarDay: r4(orders / calendarDays) });
        for (const x of results) expect(x.ordersPerDay).toBeCloseTo(x.orders / ((x.toMs - x.fromMs) / 86_400_000), 10);
      }
      const passed = r.criterion === "H" ? c.cagr >= 0 && bookDrawdown <= 0.35 : c.cagr >= b.cagr && c.maxDrawdown <= (r.trial < 459 ? 0.35 : 0.40);
      expect(r.wired).toBe(passed);
    }
  }, 120_000);

  testWithDb("RW5d cash reproduces parity against the original RW5d artifact, not a new K7 or independent replication", () => {
    const proc = Bun.spawnSync([process.execPath, "scripts/rw3-compare-artifacts.ts", rw5dCash.path, rw5dCash.parity.controlPath, "--ppy", "252"], { cwd: root });
    expect({ exit: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
    const cmp = JSON.parse(proc.stdout.toString()), p = rw5dCash.parity;
    expect(p).toEqual({ controlTrial: rw5d.trial, controlPath: rw5d.path, ppy: 252, commonDays: cmp.commonDays, from: cmp.from, to: cmp.to,
      deltaSharpe: rw5Round(cmp.deltaSharpe), maxAbsDeltaSharpe: 0.1, pass: Math.abs(cmp.deltaSharpe) <= 0.1 });
    expect(p.pass).toBe(true);
    expect(rw5Round(cmp.candidate.sharpe)).toBe(rw5dCashRows[0].figures.sharpe);
    expect(rw5Round(cmp.control.sharpe)).toBe(rw5dRows[0].figures.sharpe);
    const summary = (path: string) => JSON.parse(readFileSync(join(root, path, "summary.json"), "utf8"));
    const c = summary(rw5dCash.path), a = summary(rw5d.path);
    expect(c.dataHash).toBe(a.dataHash);
    const folds = (s: any) => s.outerTests.map((t: any) => [t.foldPath, t.result.fromMs, t.result.toMs]);
    expect(c.outerTests).toHaveLength(3);
    expect(folds(c)).toEqual(folds(a));
  }, 120_000);
});
