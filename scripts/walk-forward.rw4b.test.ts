/**
 * RW4b (docs/reports/RW-reescritura-rentable.md §14): the two optional volManaged knobs in the manifest
 * layer — strict validation, hash identity (absent = every RW2/RW3 hash unchanged, set = a distinct
 * hypothesis) and the four pre-registered draft manifests. No DB, no .env, no trial.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  candidateToReplayConfig,
  canonicalJson,
  loadManifest,
  manifestIdentity,
  resolveAsOf,
  validateManifest,
  validatePortfolioBlock,
  type ExperimentManifest,
  type PortfolioCandidateBlock,
} from "./walk-forward";
import { hashReplayConfig } from "./backtest-momentum-wf";
import { rw2DesignOf } from "./portfolio-criteria";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const experiments = join(import.meta.dir, "..", "experiments");
const venue = { venue: "alpaca" as const, fractional: true, minOrderNotional: 5, rebalanceBand: 0.01 };
const plain: PortfolioCandidateBlock = { strategy: { kind: "volManaged", universe: ["SPY", "QQQ"], inceptionGuardBars: 252,
  volLookback: 63, covLookback: 21, portfolioVolTarget: 0.2, annualization: 252, perAssetCap: 0.25, maxGross: 1.5 }, venue };
const withKnobs = (extra: Record<string, unknown>): PortfolioCandidateBlock => ({ ...plain, strategy: { ...plain.strategy, ...extra } as PortfolioCandidateBlock["strategy"] });
const brake = { startDrawdown: 0.05, maxDrawdown: 0.2, floorScale: 0.25 };

function manifestOf(block: PortfolioCandidateBlock): ExperimentManifest {
  return {
    name: "rw4b-e1-test", sleeve: "stocks", trialAccounting: { priorUniqueTrials: 424, complete: false },
    data: { dbPath: "./x.db", source: "alpaca_wide", timeframe: "1d", universe: ["SPY", "QQQ"], refSymbol: "SPY", rthOnly: false, funding: false, barMinutes: 1440, barMinutesEq: 1440 },
    asOf: "2026-09-24", window: { from: "2017-06-01", to: "2026-09-24", outerFoldCount: 3, innerFoldCount: 3, purgeYears: 0.25, warmupDays: 420 },
    costs: { base: { slippageBps: 2, commissionBps: 0, marginInterest: { annualRate: 0.065 } }, stress: { slippageBps: 5, commissionBps: 2, marginInterest: { annualRate: 0.065 } } },
    ledger: { initialEquity: 50_000 } as ExperimentManifest["ledger"],
    candidates: [{ name: "c", cadenceMin: 1440, portfolio: block }], acceptance: {},
  };
}

describe("RW4b validation of the volManaged knobs", () => {
  test("accepts both knobs, either alone, and neither", () => {
    for (const block of [plain, withKnobs({ drawdownBrake: brake }), withKnobs({ fastVolLookback: 5 }), withKnobs({ drawdownBrake: brake, fastVolLookback: 5 })]) {
      expect(() => validatePortfolioBlock(block)).not.toThrow();
      expect(() => validateManifest(manifestOf(block))).not.toThrow();
    }
    expect(() => validatePortfolioBlock(withKnobs({ drawdownBrake: { startDrawdown: 0, maxDrawdown: 1, floorScale: 1 } }))).not.toThrow();
  });

  test("rejects a brake that is malformed, inverted, or can never recover", () => {
    const bad = (drawdownBrake: unknown, re: RegExp) => expect(() => validatePortfolioBlock(withKnobs({ drawdownBrake }))).toThrow(re);
    bad(null, /drawdownBrake must be an object/);
    bad([], /drawdownBrake must be an object/);
    bad("0.1", /drawdownBrake must be an object/);
    bad({ ...brake, extra: 1 }, /unknown keys: extra/);
    bad({ maxDrawdown: 0.2, floorScale: 0.25 }, /startDrawdown/);
    bad({ startDrawdown: 1, maxDrawdown: 1, floorScale: 0.25 }, /startDrawdown/);
    bad({ ...brake, startDrawdown: -0.01 }, /startDrawdown/);
    bad({ ...brake, startDrawdown: NaN }, /startDrawdown/);
    bad({ ...brake, startDrawdown: 5 }, /startDrawdown/); // a percent, not a fraction
    bad({ ...brake, maxDrawdown: 0.05 }, /maxDrawdown/); // = start
    bad({ ...brake, maxDrawdown: 0.04 }, /maxDrawdown/); // < start
    bad({ ...brake, maxDrawdown: 1.01 }, /maxDrawdown/);
    bad({ ...brake, floorScale: 0 }, /floorScale/); // never recovers
    bad({ ...brake, floorScale: 1.01 }, /floorScale/);
    bad({ ...brake, floorScale: "0.25" }, /floorScale/);
  });

  test("rejects a fast window that is not an integer ≥ 2 smaller than covLookback", () => {
    for (const fastVolLookback of [1, 0, -5, 2.5, NaN, "5", 21, 22, 63]) {
      expect(() => validatePortfolioBlock(withKnobs({ fastVolLookback }))).toThrow(/fastVolLookback/);
    }
    for (const fastVolLookback of [2, 5, 10, 20]) expect(() => validatePortfolioBlock(withKnobs({ fastVolLookback }))).not.toThrow();
  });

  test("the knobs are volManaged-only: other kinds still reject them as unknown keys", () => {
    const d1 = { strategy: { kind: "xassetTrend", universe: ["SPY"], inceptionGuardBars: 252, volLookback: 63, covLookback: 63, portfolioVolTarget: 0.12, perAssetCap: 1, maxGross: 1.8,
      blendHorizons: [63], maLong: 200, signalBandPct: 0 }, venue };
    expect(() => validatePortfolioBlock({ ...d1, strategy: { ...d1.strategy, drawdownBrake: brake } })).toThrow(/unknown keys: drawdownBrake/);
    expect(() => validatePortfolioBlock({ ...d1, strategy: { ...d1.strategy, fastVolLookback: 5 } })).toThrow(/unknown keys: fastVolLookback/);
  });
});

describe("RW4b hash identity", () => {
  const hashes = (block: PortfolioCandidateBlock) => {
    const m = manifestOf(block);
    const c = m.candidates[0];
    return { base: hashReplayConfig(candidateToReplayConfig(m, c, "base")), stress: hashReplayConfig(candidateToReplayConfig(m, c, "stress")) };
  };

  test("absent knobs keep the candidate hash; each knob and each parameter is a distinct hypothesis", () => {
    const h = hashes(plain);
    expect(hashes(withKnobs({ drawdownBrake: undefined, fastVolLookback: undefined }))).toEqual(h); // canonicalJson drops undefined
    const variants = [
      withKnobs({ drawdownBrake: brake }), withKnobs({ fastVolLookback: 5 }), withKnobs({ drawdownBrake: brake, fastVolLookback: 5 }),
      withKnobs({ drawdownBrake: { ...brake, floorScale: 0.3 } }), withKnobs({ drawdownBrake: { ...brake, startDrawdown: 0.06 } }),
      withKnobs({ drawdownBrake: { ...brake, maxDrawdown: 0.25 } }), withKnobs({ drawdownBrake: brake, fastVolLookback: 10 }),
    ].map(b => hashes(b).base);
    expect(new Set([h.base, ...variants]).size).toBe(variants.length + 1);
  });

  test("LOCK: the 14 pre-existing rw2-*/rw3-* manifests keep their configHash and candidate identities (frozen before the knobs existed)", () => {
    const records = readdirSync(experiments).filter(f => /^rw[23]-.*\.json$/.test(f)).sort().map(file => {
      const m = loadManifest(join(experiments, file));
      const asOf = m.asOf.toLowerCase() === "latest" ? Date.parse("2026-10-19T00:00:00Z") : resolveAsOf(m);
      return { file, configHash: sha(canonicalJson(manifestIdentity(m, asOf))),
        candidates: m.candidates.map(c => ({ name: c.name, base: hashReplayConfig(candidateToReplayConfig(m, c, "base")), stress: hashReplayConfig(candidateToReplayConfig(m, c, "stress")) })) };
    });
    expect(records).toHaveLength(14);
    expect(sha(canonicalJson(records))).toBe("63502bc93e4a27cc7994caaecaf5c7bfc786a4a91d4d43bb1d645308b0f95cb0");
  });
});

describe("RW4b draft manifests (§14)", () => {
  const files = [
    ["rw4b-e1-lev-vt20-g150-brake-v1.json", "vt20-g150-brake-fast5", 0.2, 1.5, true, 424],
    ["rw4b-e1-lev-vt25-g150-brake-v1.json", "vt25-g150-brake-fast5", 0.25, 1.5, true, 425],
    ["rw4b-e1-lev-vt25-g200-brake-v1.json", "vt25-g200-brake-fast5", 0.25, 2, true, 426],
    ["rw4b-e1-lev-vt20-g150-brakeonly-v1.json", "vt20-g150-brake", 0.2, 1.5, false, 427],
  ] as const;
  const e1 = loadManifest(join(experiments, "rw2-e1-stocks-volmanaged-v1.json"));
  const e1Block = e1.candidates[0].portfolio!.strategy as Extract<PortfolioCandidateBlock["strategy"], { kind: "volManaged" }>;

  test("exactly the four manifests, ≤ 4 candidates in all, trials chained 424 → 428, one candidate each", () => {
    expect(readdirSync(experiments).filter(f => /^rw4b-/.test(f)).sort()).toEqual(files.map(f => f[0]).sort());
    files.forEach(([file, , , , , prior], i) => {
      const m = loadManifest(join(experiments, file));
      expect(m.name).toBe(file.replace(/\.json$/, ""));
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
      expect(m.trialAccounting.priorUniqueTrials).toBe(424 + i);
      expect(m.candidates).toHaveLength(1);
      expect(rw2DesignOf(m.name)).toBe("E1");
    });
  });

  for (const [file, cand, vt, gross, fast] of files) {
    test(`${file}: E1's universe, window, costs and capital; margin 6.5 %; the brake (and fast vol) as pre-registered`, () => {
      const m = loadManifest(join(experiments, file));
      expect(() => validateManifest(m)).not.toThrow();
      // Same sessions as the control: window, asOf, folds, data and ledger are E1's.
      expect(m.asOf).toBe(e1.asOf);
      expect(m.window).toEqual(e1.window);
      expect(m.data).toEqual(e1.data);
      expect(m.ledger).toEqual(e1.ledger);
      expect(m.sleeve).toBe("stocks");
      // Costs: E1's, margin interest 6.5 % in base and stress.
      expect(m.costs).toEqual(e1.costs);
      expect(m.costs.base.marginInterest?.annualRate).toBe(0.065);
      expect(m.costs.stress.marginInterest?.annualRate).toBe(0.065);
      const c = m.candidates[0];
      expect(c.name).toBe(cand);
      const s = c.portfolio!.strategy as typeof e1Block;
      // The RW2 E1 construction byte for byte on every axis but the three pre-registered ones.
      const { portfolioVolTarget, maxGross, drawdownBrake, fastVolLookback, ...rest } = s;
      const { portfolioVolTarget: _v, maxGross: _g, ...e1Rest } = e1Block;
      expect(rest).toEqual(e1Rest);
      expect(portfolioVolTarget).toBe(vt);
      expect(maxGross).toBe(gross);
      expect(vt).toBeGreaterThanOrEqual(0.2);
      expect(vt).toBeLessThanOrEqual(0.25);
      expect(drawdownBrake).toEqual(brake);
      if (fast) expect(fastVolLookback).toBe(5); else expect(fastVolLookback).toBeUndefined();
      expect(c.portfolio!.venue).toEqual(e1.candidates[0].portfolio!.venue);
      expect(m.description).toMatch(/2027-01-21/);
      expect(m.description).toMatch(/DRAFT PRE-REGISTRATION/);
    });
  }
});
