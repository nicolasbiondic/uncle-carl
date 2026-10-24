// RW5: synthetic/config-only validation. No data or trials.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { candidateToReplayConfig, canonicalJson, loadManifest, manifestIdentity, resolveAsOf, validateManifest, validatePortfolioBlock } from "./walk-forward";
import { hashReplayConfig } from "./backtest-momentum-wf";
import { rw2DesignOf } from "./portfolio-criteria";
import type { VolManagedConfig } from "../src/portfolio-engine/types";

const dir = join(import.meta.dir, "..", "experiments");
const source = () => loadManifest(join(dir, "rw3-e1-stocks-lev-vt25-g200-v1.json"));
const overlay = { signals: [{ kind: "maTrend", symbol: "SPY", period: 10, sampling: "monthEnd" }], combine: "any", coreScale: 0,
  defensive: { assets: ["IEF", "GLD", "BIL"], momentumLookback: 63, volLookback: 63, cashProxy: "BIL" } };
const pit = { topN: 6, liquidityLookback: 63, minHoldingRebalances: 21 };
const block = (extra: Record<string, unknown>) => { const b = source().candidates[0].portfolio!; return { ...b, strategy: { ...b.strategy, ...extra } }; };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("RW5 strict optional config accepts all signals/actions/combiners and rejects malformed or silently ignored knobs", () => {
  for (const extra of [{}, { regimeOverlay: overlay }, { pitUniverse: pit }, { regimeOverlay: overlay, pitUniverse: pit }, { regimeOverlay: overlay, maxGross: 2.5 }]) {
    expect(() => validatePortfolioBlock(block(extra))).not.toThrow();
  }
  for (const combine of ["any", "all", 1, 2]) expect(() => validatePortfolioBlock(block({ regimeOverlay: { ...overlay, combine,
    signals: [{ kind: "absMomentum", symbol: "SPY", cashProxy: "BIL", lookback: 252 },
      { kind: "canary", assets: ["SPY", "EEM"], horizons: [21, 63, 126, 252], coefficients: [12, 4, 2, 1], negativeCount: 2 }],
    hedge: { symbol: "SH", fraction: 0.1 }, confirmationDecisions: 2 } }))).not.toThrow();
  const badOverlays: unknown[] = [null, [], {}, { ...overlay, unknown: true }, { ...overlay, signals: [] }, { ...overlay, combine: "most" },
    { ...overlay, combine: 2 }, { ...overlay, combine: 0 }, { ...overlay, confirmationDecisions: 0 }, { ...overlay, confirmationDecisions: 1.5 },
    { ...overlay, coreScale: -1 }, { ...overlay, coreScale: 1.01 }, { ...overlay, coreScale: NaN },
    { ...overlay, signals: [{ ...overlay.signals[0], period: 1 }] }, { ...overlay, signals: [{ ...overlay.signals[0], sampling: "weekly" }] },
    { ...overlay, signals: [{ ...overlay.signals[0], bandPct: -1 }] }, { ...overlay, signals: [{ ...overlay.signals[0], symbol: "" }] },
    { ...overlay, signals: [{ kind: "canary", assets: ["SPY", "SPY"], horizons: [21], coefficients: [1] }] },
    { ...overlay, signals: [{ kind: "canary", assets: ["SPY"], horizons: [21, 21], coefficients: [1, 1] }] },
    { ...overlay, signals: [{ kind: "canary", assets: ["SPY"], horizons: [21], coefficients: [1, 1] }] },
    { ...overlay, signals: [{ kind: "canary", assets: ["SPY"], horizons: [21], coefficients: [-1] }] },
    { ...overlay, signals: [{ kind: "canary", assets: ["SPY"], horizons: [21], coefficients: [1], negativeCount: 2 }] },
    { ...overlay, signals: [{ kind: "absMomentum", symbol: "SPY", cashProxy: "SPY", lookback: 21 }] },
    { ...overlay, signals: [{ kind: "absMomentum", symbol: "SPY", cashProxy: "BIL", lookback: 0 }] },
    { ...overlay, defensive: { ...overlay.defensive, volLookback: 1 } }, { ...overlay, defensive: { ...overlay.defensive, assets: [] } },
    { ...overlay, hedge: { symbol: "SH", fraction: 0 } }, { ...overlay, hedge: { symbol: "SH", fraction: Infinity } },
    { ...overlay, hedge: { symbol: "GLD", fraction: 0.1 } }];
  for (const regimeOverlay of badOverlays) expect(() => validatePortfolioBlock(block({ regimeOverlay }))).toThrow();
  for (const pitUniverse of [null, [], {}, { ...pit, foo: 1 }, { ...pit, topN: 0 }, { ...pit, liquidityLookback: 0 }, { ...pit, minHoldingRebalances: 0 }, { ...pit, minHoldingRebalances: 1.5 }, { ...pit, exclude: ["A", "A"] }]) {
    expect(() => validatePortfolioBlock(block({ pitUniverse }))).toThrow();
  }
  expect(() => validatePortfolioBlock(block({ regimeOverlay: overlay, annualization: 365 }))).toThrow("stocks");
  expect(() => validatePortfolioBlock(block({ regimeOverlay: overlay, maxGross: 2.51 }))).toThrow("maxGross");
  expect(() => validatePortfolioBlock(block({ regimeOverlay: overlay, covLookback: 1 }))).toThrow("covLookback");
});

test("data domain includes signal-only, defensive, cash and hedge symbols; PIT requires sp500 membership", () => {
  const m = source(), s = m.candidates[0].portfolio!.strategy as VolManagedConfig;
  s.regimeOverlay = { ...overlay, signals: [{ kind: "absMomentum", symbol: "EEM", cashProxy: "BIL", lookback: 63 }], combine: "any", hedge: { symbol: "SH", fraction: 0.1 } };
  expect(() => validateManifest(m)).toThrow("data.universe");
  m.data.universe.push("EEM", "BIL", "IEF", "SH");
  expect(() => validateManifest(m)).not.toThrow();
  for (const symbol of ["EEM", "BIL", "IEF", "SH"]) {
    expect(() => validateManifest({ ...m, data: { ...m.data, universe: m.data.universe.filter(x => x !== symbol) } })).toThrow("data.universe");
  }
  s.pitUniverse = pit;
  expect(() => validateManifest(m)).toThrow("membership");
  m.data.membership = { index: "sp500" };
  expect(() => validateManifest(m)).not.toThrow();
  expect(() => validateManifest({ ...m, data: { ...m.data, membership: { index: "nasdaq" } } })).toThrow("sp500");
});

test("LOCK: all 34 existing rw2/rw3/rw4a/rw4b/copy config and candidate hashes frozen before RW5", () => {
  // Independently computed from origin/master 6332307, including momentum-*-rw3/rw4a manifests.
  const rows = readdirSync(dir).filter(f => f.endsWith(".json") && /^(rw[23]-|rw4b-|copy-)|-rw[34][a-z]?-/.test(f)).sort().map(file => {
    const m = loadManifest(join(dir, file));
    return { file, configHash: sha(canonicalJson(manifestIdentity(m, m.asOf === "latest" ? Date.parse("2026-10-19") : resolveAsOf(m)))),
      candidates: m.candidates.map(c => ({ name: c.name, base: hashReplayConfig(candidateToReplayConfig(m, c, "base")), stress: hashReplayConfig(candidateToReplayConfig(m, c, "stress")) })) };
  });
  expect(rows).toHaveLength(34);
  expect(sha(canonicalJson(rows))).toBe("2401aefc70810c2e44767aeac2acff476ef20f9b5b9e1633f7db4c4cbef9eca2");
});

test("absent knobs keep hashes; every knob/parameter enters candidate identity", () => {
  const hash = (extra: Record<string, unknown>) => {
    const m = source(); Object.assign(m.candidates[0].portfolio!.strategy, extra);
    return hashReplayConfig(candidateToReplayConfig(m, m.candidates[0], "base"));
  };
  expect(hash({ regimeOverlay: undefined, pitUniverse: undefined })).toBe(hash({}));
  const variants = [{}, { regimeOverlay: overlay }, { regimeOverlay: { ...overlay, coreScale: 0.2 } },
    { regimeOverlay: { ...overlay, confirmationDecisions: 2 } }, { regimeOverlay: { ...overlay, combine: "all" } },
    { pitUniverse: pit }, { pitUniverse: { ...pit, topN: 7 } }, { pitUniverse: { ...pit, minHoldingRebalances: 22 } },
    { pitUniverse: { ...pit, liquidityLookback: 64 } }];
  expect(new Set(variants.map(hash)).size).toBe(variants.length);
});

test("RW5 pre-registration (§16.1, §16.3, §16.4, §16.7): 13 manifests, trials 435→446 and 448→450, the window/costs/capital of their RW3 base, the exact contingencies", () => {
  const files = readdirSync(dir).filter(f => /^rw5-.*\.json$/.test(f) && !f.includes("-cash-")).sort();
  expect(files).toHaveLength(13);
  const ms = files.map(f => loadManifest(join(dir, f)));
  expect(ms.map(m => m.trialAccounting.priorUniqueTrials).sort((a, b) => a - b)).toEqual([435, 436, 437, 438, 439, 440, 441, 442, 443, 444, 445, 448, 449]);
  const DEF = { assets: ["BIL"], momentumLookback: 63, volLookback: 63, cashProxy: "BIL" };
  const contingency: Record<string, unknown> = {
    sma200: { signals: [{ kind: "maTrend", symbol: "SPY", period: 200, sampling: "daily", bandPct: 1 }], combine: "any", coreScale: 0, defensive: DEF },
    absmom12: { signals: [{ kind: "absMomentum", symbol: "SPY", cashProxy: "BIL", lookback: 252 }], combine: "any", coreScale: 0, defensive: DEF },
    canary: { signals: [{ kind: "canary", assets: ["SPY", "VWO", "VEA", "BND"], horizons: [21, 63, 126, 252], coefficients: [12, 4, 2, 1], negativeCount: 1 }], combine: "any", coreScale: 0, defensive: DEF },
  };
  const base = (name: string) => loadManifest(join(dir, name.startsWith("rw5-e2-")
    ? (name.includes("vt25-g200") ? "rw3-e2-meanrev-lev-vt25-g200-v1.json" : "rw3-e2-meanrev-lev-vt20-g150-v1.json")
    : (name.includes("vt25-g200") ? "rw3-e1-stocks-lev-vt25-g200-v1.json" : "rw3-e1-stocks-lev-vt20-g150-v1.json")));
  for (const m of ms) {
    expect(m.description).toContain("PRE-REGISTERED");
    const b = base(m.name);
    expect(m.window).toEqual(b.window); expect(m.costs).toEqual(b.costs); expect(m.ledger).toEqual(b.ledger);
    expect(m.candidates).toHaveLength(1);
    expect(rw2DesignOf(m.name)).toBe(m.name.startsWith("rw5-e2-") ? "E2" : "E1");
    expect(() => validateManifest(m)).not.toThrow();
    const s = m.candidates[0].portfolio!.strategy as VolManagedConfig;
    const key = Object.keys(contingency).find(k => m.name.includes(`-${k}-`));
    if (key) expect(s.regimeOverlay).toEqual(contingency[key] as any); else expect(s.regimeOverlay).toBeUndefined();
    if (m.name.includes("-pit-")) { expect(s.universe).toEqual(["SPY", "QQQ", "IWM", "GLD", "SMH"]); expect(s.pitUniverse).toEqual(pit); }
    else { expect(s.pitUniverse).toBeUndefined(); expect(s.universe).toEqual((b.candidates[0].portfolio!.strategy as VolManagedConfig).universe); }
    if (m.name.includes("-fastvol5-")) expect(s.fastVolLookback).toBe(5); else expect(s.fastVolLookback).toBeUndefined();
    const lev = m.name.includes("vt30-g250") ? [0.3, 2.5] : m.name.includes("vt25-g200") ? [0.25, 2] : m.name.includes("vt20-g150") ? [0.2, 1.5] : [0.15, 1];
    expect([s.portfolioVolTarget, s.maxGross]).toEqual(lev);
  }
});

test("RW5d live-parity check (§16.15): the ONLY candidate change is removing the defensive leg; trial 453 -> 454", () => {
  const original = loadManifest(join(dir, "rw5-e1-lev-vt30-g250-sma200-fastvol5-v1.json"));
  const cash = loadManifest(join(dir, "rw5-e1-lev-vt30-g250-sma200-fastvol5-cash-v1.json"));
  expect(() => validateManifest(cash)).not.toThrow();
  expect(cash.trialAccounting).toEqual({ priorUniqueTrials: 453, complete: false });
  expect(cash.description).toContain("PRE-REGISTERED (2026-10-24) BEFORE any run");
  const expected = structuredClone(original);
  delete (expected.candidates[0].portfolio!.strategy as VolManagedConfig).regimeOverlay!.defensive;
  const rest = (m: typeof cash) => { const { name, description, trialAccounting, ...r } = m; return r; };
  expect(rest(cash)).toEqual(rest(expected));
  expect((cash.candidates[0].portfolio!.strategy as VolManagedConfig).regimeOverlay).not.toHaveProperty("defensive");
});
