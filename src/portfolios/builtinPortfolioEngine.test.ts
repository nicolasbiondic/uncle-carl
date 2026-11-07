// ═══ The stock sleeves' built-in portfolio-engine definitions (owner, 2026-11-07) ═══
//
// Since the TSM/Connors incumbents were deleted, the code's ONLY answer to a
// registry problem on a stock sleeve is the built-in definition in
// src/portfolios/builtin.ts (pe_<sleeve>). This file is what makes "the same
// current live model" true rather than hoped:
//   1. the definition's strategy block IS the manifest candidate named by the
//      sleeve's current MODEL_VERSIONS entry, byte for byte (so a model change
//      that forgets builtin.ts fails CI);
//   2. its provenance hash is the hash cutover.ts re-checks at boot (live = tested);
//   3. it resolves LIVE through the real boot resolver on an EMPTY registry
//      (PORTFOLIOS_SOURCE=code, or a DB whose definitions are all broken);
//   4. it is byte-equal to what scripts/portfolio-engine-cutover.ts would write
//      for the same candidate (so the registry and the code cannot drift);
//   5. the seed never overwrites an owner-written registry row of the same id.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinPortfolio, builtinPortfolios, STOCK_SLEEVE_BUILTIN_DEFINITION } from "./builtin";
import { initPlatformPortfolios, loadPlatformPortfolioRows } from "./store";
import type { PortfolioEngineParams } from "./types";
import { MODEL_VERSIONS, currentModelVersion } from "../portfolio/modelVersions";
import { designHash, resolvePortfolioWiring } from "../portfolio-engine/live/cutover";
import { MOMENTUM_STOCKS_UNIVERSE } from "../config/riskProfiles";
import { MEANREV_UNIVERSE } from "../strategies/meanrev/MeanRevEngine";
import { overlaySymbols } from "../portfolio-engine/contingency";

const ROOT = join(import.meta.dir, "..", "..");
const READY = { alpaca: null, binance_usdm: null, binance_usdc: null } as const;

function candidateBlock(manifestPath: string, candidate: string): { strategy: any; venue: any } {
  const m = JSON.parse(readFileSync(join(ROOT, manifestPath), "utf-8"));
  const c = (m.candidates ?? []).find((x: any) => x.name === candidate);
  if (!c?.portfolio) throw new Error(`${manifestPath}: candidate ${candidate} has no portfolio block`);
  return c.portfolio;
}

describe("built-in portfolio-engine definitions ≡ the current live model of each stock sleeve", () => {
  for (const [sleeve, defId] of Object.entries(STOCK_SLEEVE_BUILTIN_DEFINITION)) {
    const def = builtinPortfolio(defId);
    const p = def.params as PortfolioEngineParams;
    const version = currentModelVersion(sleeve)!;

    test(`${sleeve}: the definition is the manifest candidate of MODEL_VERSIONS' LAST entry (${version.id}), with the manifest's own design hash`, () => {
      expect(def.template).toBe("portfolio");
      expect(def.account).toBe("alpaca_main");
      expect(def.enabled).toBe(true);
      expect(def.mode).toBe("live");
      expect(p.engine).toBe("portfolio");
      expect(p.sleeve).toBe(sleeve);
      expect(p.runMode).toBe("live");
      expect(p.venue).toBe("alpaca");
      expect(p.heartbeatName).toBe(`portfolio:${sleeve}`);
      expect(version.engine).toBe("portfolio");
      expect(p.strategyVersion).toBe(version.id);
      expect(p.provenance?.manifest).toBe(version.manifest!);
      expect(p.provenance?.candidate).toBe(version.candidate!);
      const block = candidateBlock(version.manifest!, version.candidate!);
      expect(p.strategy).toEqual(block.strategy);
      expect(p.minOrderNotional).toBe(block.venue.minOrderNotional);
      expect(p.rebalanceBand).toBe(block.venue.rebalanceBand);
      expect(block.venue.venue).toBe("alpaca");
      const manifestHash = designHash({ strategy: block.strategy, venue: block.venue.venue, minOrderNotional: block.venue.minOrderNotional, rebalanceBand: block.venue.rebalanceBand });
      expect(p.provenance?.designSha256).toBe(manifestHash);
      expect(designHash(p)).toBe(manifestHash);
    });

    test(`${sleeve}: the universe is the sleeve's canonical constant (disjointness locks transfer)`, () => {
      const universe = (p.strategy as any).universe as string[];
      expect(universe).toEqual(sleeve === "momentum_stocks" ? [...MOMENTUM_STOCKS_UNIVERSE] : [...MEANREV_UNIVERSE]);
    });
  }

  test("the two definitions resolve LIVE together on an empty registry — the PORTFOLIOS_SOURCE=code boot and the all-broken-registry fallback", () => {
    const w = resolvePortfolioWiring({ defs: builtinPortfolios(), venueReady: READY });
    expect(w.problems).toEqual([]);
    expect(w.observers).toEqual([]);
    expect(w.live.map(pl => pl.params.sleeve).sort()).toEqual(["meanrev_stocks", "momentum_stocks"]);
    // the shared-wallet rule between the two (plus the RW8 hedge SH) holds inside the code itself
    const mom = builtinPortfolio("pe_momentum_stocks").params as PortfolioEngineParams;
    const mr = builtinPortfolio("pe_meanrev_stocks").params as PortfolioEngineParams;
    const momSymbols = new Set([...(mom.strategy as any).universe, ...overlaySymbols((mom.strategy as any).regimeOverlay, false)]);
    for (const s of (mr.strategy as any).universe as string[]) expect(momSymbols.has(s)).toBe(false);
  });

  test("a version bump that forgets builtin.ts is caught: an older MODEL_VERSIONS entry is refused by the resolver", () => {
    const list = MODEL_VERSIONS.momentum_stocks;
    const previous = list[list.length - 2];
    expect(previous).toBeDefined();
    const w = resolvePortfolioWiring({
      defs: builtinPortfolios(), venueReady: READY,
      modelVersions: { ...MODEL_VERSIONS, momentum_stocks: [...list, { ...previous, id: `${previous.id}-next` }] },
    });
    expect(w.live.map(pl => pl.params.sleeve)).toEqual(["meanrev_stocks"]);
    expect(w.problems.map(pr => pr.message).join(" ")).toContain("is not the LAST entry of MODEL_VERSIONS");
  });

  test("the seed adds the definitions to a fresh DB and never overwrites an owner-written row of the same id (prod's pe_ rows)", () => {
    const db = new Database(":memory:");
    initPlatformPortfolios(db, 1_000);
    const fresh = Object.fromEntries(loadPlatformPortfolioRows(db).map(r => [r.id, r]));
    expect(fresh.pe_momentum_stocks.source).toBe("builtin");
    expect(fresh.pe_meanrev_stocks.params).toEqual(builtinPortfolio("pe_meanrev_stocks").params);
    // prod: the cutover script wrote the row (source "owner"); a later code change must not touch it
    db.run("UPDATE platform_portfolios SET source = 'owner', name = 'owner-written', updated_at = 5 WHERE id = 'pe_momentum_stocks'");
    initPlatformPortfolios(db, 2_000);
    const after = loadPlatformPortfolioRows(db).find(r => r.id === "pe_momentum_stocks")!;
    expect(after.name).toBe("owner-written");
    expect(after.updatedAt).toBe(5);
  });
});
