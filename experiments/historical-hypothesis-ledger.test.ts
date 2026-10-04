import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
});
