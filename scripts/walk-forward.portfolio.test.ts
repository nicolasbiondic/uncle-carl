/**
 * The additive `portfolio` extension of scripts/walk-forward.ts (RW, 2026-10-20):
 * strict validation of the candidate block and the manifest cross-checks, the
 * candidate identity carrying the block, the default runner's refusal, and the
 * LEGACY IDENTITY LOCK — committed manifests with a pinned asOf keep the exact
 * configHash and candidate hashes they had before the extension (frozen here
 * from a run of the pre-extension code; no DB, no .env involved).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  candidateToReplayConfig,
  canonicalJson,
  defaultReplayRunner,
  isPortfolioReplayConfig,
  loadManifest,
  manifestIdentity,
  resolveAsOf,
  validateCandidate,
  validateManifest,
  validatePortfolioBlock,
  type CandidateConfig,
  type ExperimentManifest,
  type PortfolioCandidateBlock,
} from "./walk-forward";
import { hashReplayConfig } from "./backtest-momentum-wf";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const venue = { venue: "alpaca" as const, fractional: true, minOrderNotional: 5, rebalanceBand: 0 };
const d1: PortfolioCandidateBlock = {
  strategy: { kind: "xassetTrend", universe: ["SPY", "IEF"], inceptionGuardBars: 252, volLookback: 63, covLookback: 63, portfolioVolTarget: 0.12, perAssetCap: 1, maxGross: 1.8, blendHorizons: [63, 126, 252], maLong: 200, signalBandPct: 0 },
  venue,
};
const d2: PortfolioCandidateBlock = {
  strategy: { kind: "factorCore", exclude: ["SPY"], topN: 50, score: "momentum+lowvol", momentumWindow: [252, 21], volWindow: 252, weightVolLookback: 63, perNameCap: 0.04, minPrice: 5, minPriorCloses: 252, overlay: { ref: "SPY", ma: 200, bandPct: 1, onExposure: 1, offExposure: 0.5 } },
  venue,
};
const d3: PortfolioCandidateBlock = {
  strategy: { kind: "cryptoTrend", universe: ["BTC/USD", "ETH/USD"], inceptionGuardBars: 252, volLookback: 30, covLookback: 30, portfolioVolTarget: 0.35, perAssetCap: 0.6, maxGross: 2, blendHorizons: [63, 126, 252], maLong: 200, signalBandPct: 0, stop: { mode: "volScaled", kSigma: 3, lookbackBars: 20, minPct: 2, maxPct: 12 } },
  venue: { venue: "binance_usdm", fractional: false, minOrderNotional: 5, rebalanceBand: 0.02, qtyStep: { "BTC/USD": 0.001 } },
};

function manifest(block: PortfolioCandidateBlock, over: Partial<ExperimentManifest> = {}): ExperimentManifest {
  const crypto = block.strategy.kind === "cryptoTrend";
  return {
    name: "rw-test", sleeve: crypto ? "crypto" : "stocks", trialAccounting: { priorUniqueTrials: 0, complete: true },
    data: {
      dbPath: "./x.db", source: crypto ? "binance_futures" : "alpaca_wide", timeframe: "1d",
      universe: crypto ? ["BTC/USD", "ETH/USD"] : block.strategy.kind === "factorCore" ? ["SPY"] : ["SPY", "IEF"],
      refSymbol: crypto ? "BTC/USD" : "SPY", rthOnly: false, funding: crypto, barMinutes: 1440, barMinutesEq: 1440,
      ...(block.strategy.kind === "factorCore" ? { membership: { index: "sp500", exclude: ["SPY"] } } : {}),
    },
    asOf: "2026-10-19T00:00:00Z",
    window: { from: "2016-01-04", to: "2026-10-19", outerFoldCount: 4, innerFoldCount: 3, purgeYears: 0.25, warmupDays: 420 },
    costs: { base: { slippageBps: 2, commissionBps: 0 }, stress: { slippageBps: 5, commissionBps: 0 } },
    ledger: { initialEquity: 50_000 } as ExperimentManifest["ledger"],
    candidates: [{ name: "c1", cadenceMin: 1440, portfolio: block }],
    acceptance: {},
    ...over,
  };
}

describe("portfolio candidate validation", () => {
  test("accepts the three designs and rejects foreign knobs, the wrong cadence and unknown keys", () => {
    for (const b of [d1, d2, d3]) expect(() => validateCandidate({ name: "c", cadenceMin: 1440, portfolio: b })).not.toThrow();
    expect(() => validateCandidate({ name: "c", cadenceMin: 1440, portfolio: d1, entryPct: 5 })).toThrow(/must not set momentum\/meanrev keys: entryPct/);
    expect(() => validateCandidate({ name: "c", cadenceMin: 1440, portfolio: d1, hardStop: { mode: "none" } })).toThrow(/must not set/);
    expect(() => validateCandidate({ name: "c", cadenceMin: 60, portfolio: d1 })).toThrow(/cadenceMin must be 1440/);
    expect(() => validatePortfolioBlock({ ...d1, extra: 1 })).toThrow(/unknown keys: extra/);
    expect(() => validatePortfolioBlock({ strategy: { ...d1.strategy, bogus: 1 }, venue })).toThrow(/unknown keys: bogus/);
    expect(() => validatePortfolioBlock({ strategy: { ...d1.strategy, kind: "magic" }, venue })).toThrow(/kind must be/);
    expect(() => validatePortfolioBlock({ strategy: d1.strategy })).toThrow(/venue must be an object/);
  });

  test("strategy shapes: horizons, lookbacks, fractions vs percents, stop modes, factor-core windows and overlay", () => {
    const bad = (strategy: Record<string, unknown>, re: RegExp) => expect(() => validatePortfolioBlock({ strategy, venue })).toThrow(re);
    bad({ ...d1.strategy, blendHorizons: [] }, /blendHorizons/);
    bad({ ...d1.strategy, blendHorizons: [63, 63] }, /distinct/);
    bad({ ...d1.strategy, maLong: 1 }, /maLong/);
    bad({ ...d1.strategy, signalBandPct: -1 }, /signalBandPct/);
    bad({ ...d1.strategy, portfolioVolTarget: 12 }, /FRACTION/);
    bad({ ...d1.strategy, universe: ["SPY", "SPY"] }, /duplicates/);
    bad({ ...d1.strategy, inceptionGuardBars: 0 }, /inceptionGuardBars/);
    bad({ ...d3.strategy, stop: { mode: "fixed" } }, /stop.pct/);
    bad({ ...d3.strategy, stop: { mode: "volScaled", kSigma: 3, lookbackBars: 20, minPct: 12, maxPct: 2 } }, /maxPct >= minPct/);
    bad({ ...d3.strategy, stop: { mode: "trail" } }, /stop.mode/);
    bad({ ...d3.strategy, stop: { mode: "none", pct: 4 } }, /unknown keys: pct/);
    bad({ ...d2.strategy, momentumWindow: [21, 252] }, /long > skip/);
    bad({ ...d2.strategy, score: "value" }, /score/);
    bad({ ...d2.strategy, perNameCap: 4 }, /perNameCap/);
    bad({ ...d2.strategy, overlay: { ref: "SPY", ma: 200 } }, /overlay/);
    bad({ ...d2.strategy, overlay: { ...d2.strategy.overlay, extra: 1 } }, /unknown keys: extra/);
    expect(() => validatePortfolioBlock({ strategy: { ...d2.strategy, overlay: null }, venue })).not.toThrow();
    const badVenue = (v: Record<string, unknown>, re: RegExp) => expect(() => validatePortfolioBlock({ strategy: d1.strategy, venue: v })).toThrow(re);
    badVenue({ ...venue, venue: "ibkr" }, /venue.venue/);
    badVenue({ ...venue, rebalanceBand: 1 }, /rebalanceBand/);
    badVenue({ ...venue, minOrderNotional: -1 }, /minOrderNotional/);
    badVenue({ ...venue, qtyStep: { SPY: 0 } }, /qtyStep.SPY/);
    badVenue({ ...venue, lot: 1 }, /unknown keys: lot/);
  });

  test("manifest cross-checks: one engine per manifest, sleeve/kind, daily bars, data coverage, membership, funding, venue, ledger, shortBorrow", () => {
    expect(() => validateManifest(manifest(d1))).not.toThrow();
    expect(() => validateManifest(manifest(d2))).not.toThrow();
    expect(() => validateManifest(manifest(d3))).not.toThrow();
    const m1 = manifest(d1);
    expect(() => validateManifest({ ...m1, candidates: [...m1.candidates, { name: "legacy", cadenceMin: 1440, entryPct: 5, exitPct: -2, maxLongs: 2, maxShorts: 0 }] })).toThrow(/EVERY candidate/);
    expect(() => validateManifest({ ...m1, candidates: [...m1.candidates, { name: "c3", cadenceMin: 1440, portfolio: d3 }] })).toThrow(/ONE design/);
    expect(() => validateManifest({ ...m1, sleeve: "crypto" })).toThrow(/requires sleeve "stocks"/);
    expect(() => validateManifest({ ...m1, data: { ...m1.data, timeframe: "1h", barMinutes: 60 } })).toThrow(/daily bars/);
    expect(() => validateManifest({ ...m1, data: { ...m1.data, universe: ["SPY"] } })).toThrow(/missing from data.universe: IEF/);
    expect(() => validateManifest({ ...m1, data: { ...m1.data, funding: true } })).toThrow(/funding=false/);
    expect(() => validateManifest({ ...m1, data: { ...m1.data, membership: { index: "sp500" } } })).toThrow(/must not set data.membership/);
    expect(() => validateManifest({ ...m1, ledger: { initialEquity: 50_000, leverage: 1, hardStopPct: 0.04 } })).toThrow(/ledger.initialEquity only/);
    expect(() => validateManifest({ ...m1, costs: { ...m1.costs, base: { ...m1.costs.base, shortBorrow: { annualRate: 0.005 } } } })).toThrow(/long-only/);
    expect(() => validateManifest({ ...m1, candidates: [{ name: "c", cadenceMin: 1440, portfolio: { ...d1, venue: { ...venue, venue: "binance_usdm" } } }] })).toThrow(/does not match design kind/);
    const m2 = manifest(d2);
    expect(() => validateManifest({ ...m2, data: { ...m2.data, membership: undefined } })).toThrow(/requires data.membership/);
    expect(() => validateManifest({ ...m2, data: { ...m2.data, universe: ["QQQ"], refSymbol: "QQQ" } })).toThrow(/overlay.ref SPY must be in data.universe/);
    const m3 = manifest(d3);
    expect(() => validateManifest({ ...m3, data: { ...m3.data, funding: false } })).toThrow(/funding=true/);
    expect(() => validateManifest({ ...m3, sleeve: "stocks" })).toThrow(/requires sleeve "crypto"/);
    // assetClasses: reporting labels, portfolio-only, shape-checked.
    expect(() => validateManifest({ ...m1, data: { ...m1.data, assetClasses: { SPY: "equity", IEF: "bond" } } })).not.toThrow();
    expect(() => validateManifest({ ...m1, data: { ...m1.data, assetClasses: { SPY: "" } } })).toThrow(/assetClasses.SPY/);
  });
});

describe("portfolio candidate identity", () => {
  test("candidateToReplayConfig carries the block; venue or strategy changes change the hash; legacy configs never gain the key", () => {
    const m = manifest(d1);
    const cfg = candidateToReplayConfig(m, m.candidates[0], "base");
    expect(isPortfolioReplayConfig(cfg)).toBe(true);
    expect(isPortfolioReplayConfig(cfg) && cfg.portfolio).toEqual(d1);
    const h = hashReplayConfig(cfg);
    const otherVenue = candidateToReplayConfig(m, { ...m.candidates[0], portfolio: { ...d1, venue: { ...venue, rebalanceBand: 0.01 } } }, "base");
    const otherVt = candidateToReplayConfig(m, { ...m.candidates[0], portfolio: { ...d1, strategy: { ...d1.strategy, portfolioVolTarget: 0.15 } } }, "base");
    expect(hashReplayConfig(otherVenue)).not.toBe(h);
    expect(hashReplayConfig(otherVt)).not.toBe(h);
    expect(hashReplayConfig(candidateToReplayConfig(m, m.candidates[0], "stress"))).not.toBe(h);
    // The cost model is the manifest's tiers: slippage lives on the config, not in the block.
    expect(cfg.slippageBps).toBe(2);
    expect(candidateToReplayConfig(m, m.candidates[0], "stress").slippageBps).toBe(5);
    const legacy: CandidateConfig = { name: "l", cadenceMin: 240, entryPct: 5, exitPct: -2, maxLongs: 2, maxShorts: 0 };
    const legacyCfg = candidateToReplayConfig({ ...m, candidates: [legacy], ledger: { initialEquity: 1, leverage: 1, hardStopPct: 0.04 } }, legacy, "base");
    expect("portfolio" in legacyCfg).toBe(false);
    expect(isPortfolioReplayConfig(legacyCfg)).toBe(false);
  });

  test("the default protocol runner refuses portfolio configs (fail closed)", async () => {
    const m = manifest(d1);
    const cfg = candidateToReplayConfig(m, m.candidates[0], "base");
    await expect(defaultReplayRunner(cfg, { label: "0/test", from: "2020-01-01T00:00:00Z", to: "2020-02-01T00:00:00Z" })).rejects.toThrow(/portfolio candidates run through scripts\/portfolio-wf.ts/);
  });
});

describe("legacy identity lock — committed manifests keep their configHash and candidate hashes", () => {
  // Frozen from the pre-extension code (commit ecf8009 + rw-core) on 2026-10-20.
  // Pinned-asOf manifests only: manifestIdentity needs no DB to resolve them,
  // so this test runs identically in CI (no data/, no .env).
  const FROZEN: Record<string, { configHash: string; candidates: Array<{ name: string; base: string; stress: string }> }> = {
    "momentum-crypto-vt35-pure-v1.json": {
      configHash: "4c99df1c6deffc6f0ab6932e5ef95d97ba4c3255a0014a94707fd3a296f0275f",
      candidates: [{ name: "vt-35", base: "25ac2cd9cf716bad38bd563fbeb5cd59982341f944346ea73bfa385e2addf9aa", stress: "d178554adc93c82cc821803e2f7c80ec51b17bc739cf5133b1580f3029610cce" }],
    },
    "momentum-stocks-daily-blend3-pure-v1.json": {
      configHash: "c23f9fc2a9672e130212f6738d26c56e6b56f613c29d8b7ccf1e40eb897dfb03",
      candidates: [{ name: "blend-63-126-252", base: "7ad1e27dfd5dd1ba83a9ec442a0765ede67d3af5bdad6430adac6abe17df8d5b", stress: "bb16bc014a2f86a2856c75f8d79a2145e46587072fd43c3bff8da6f8f3e702e8" }],
    },
    "meanrev-sp500pit-pure-v1.json": {
      configHash: "083874f656d298b77c6f1c72ae11048dae252a0f21c79d8232b73c2794a28ae5",
      candidates: [{ name: "sp500pit-meanrev", base: "7d8d90c32e2680098a68012e516ae192bfef61c89966634355ae857ef73e9909", stress: "9c85646de73e9d7205fdabff01e35bb098a55b4d3e0170b47541c59c801c7882" }],
    },
    "crypto-fcarry-v1.json": {
      configHash: "7f898c1ce35c0ff9b50cd184dc9147a587ebecf73aae2b6ae7db4e3cda13dadf",
      candidates: [
        { name: "fc-w3-r8", base: "4efe62fda06d4a5262a43fe78e1718a6dcfb0f8644a260f1510d61468cd9a2a9", stress: "caced9a735515eda755e329e2c7860461b38efd73b926a20c96a9287acf9c43f" },
        { name: "fc-w7-r8", base: "becb9e12431f5b7ab64e8e5168a430d3f4d4fc9c21395abcf5f52970ecc058dc", stress: "43d986da6c068029da87e9bf45ebf976acc1be2f314d8ab518308ac70d385cef" },
        { name: "fc-w3-r24", base: "a8199913a303395e2f7c5123b700c5a89979ec78a0bc6b93a88a331b3a737054", stress: "415fdf44d12222c154d0eb63bb4a7632d08a64a5833d4b5da61a3d04bef4e57a" },
        { name: "fc-w7-r24", base: "e6184fdd1ebc86f2bf0fa8e63900f1cb7d4ba61cc3c0cfb4dd43a30721016243", stress: "b265ecd847ecee70546533e24845ef6429d8d951c4b1aab127a51df5e42e073e" },
      ],
    },
  };

  for (const [file, frozen] of Object.entries(FROZEN)) {
    test(file, () => {
      const m = loadManifest(join(import.meta.dir, "..", "experiments", file));
      expect(m.asOf.toLowerCase()).not.toBe("latest");
      const asOfMs = resolveAsOf(m);
      expect(sha(canonicalJson(manifestIdentity(m, asOfMs)))).toBe(frozen.configHash);
      expect(m.candidates.map(c => ({ name: c.name, base: hashReplayConfig(candidateToReplayConfig(m, c, "base")), stress: hashReplayConfig(candidateToReplayConfig(m, c, "stress")) }))).toEqual(frozen.candidates);
    });
  }
});
