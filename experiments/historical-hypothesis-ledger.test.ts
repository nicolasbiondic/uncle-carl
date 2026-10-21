import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { researchDataPath } from "../scripts/lib/researchData";

const root = join(import.meta.dir, "..");
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
});
