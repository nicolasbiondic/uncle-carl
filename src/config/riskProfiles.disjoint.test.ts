import { describe, expect, test } from "bun:test";
import { MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE } from "./riskProfiles";
import { MEANREV_UNIVERSE } from "../strategies/meanrev/MeanRevEngine";
import { stockSymbols, cryptoSymbols } from "./symbols";
import { SLEEVE_UNIVERSE_BINANCE } from "../sync/BrokerSync";
import { MOMENTUM_SYMBOLS } from "./wideUniverse";
import { SYMBOL_MAP } from "../executor/binance-executor";
import { readFileSync } from "node:fs";
import { currentModelVersion } from "../portfolio/modelVersions";
import { portfolioEngineOwnedSymbols, portfolioUniverse } from "../portfolios/validate";
import { TREASURY_SYMBOLS, isTreasurySymbol } from "../treasury/treasurySymbols";
import { builtinPortfolios } from "../portfolios/builtin";
import { INVERSE_FUNDS, INVERSE_SYMBOLS } from "../ai-review/inverse";

// The two Alpaca sleeves (momentum_stocks, meanrev_stocks) share ONE wallet.
// AlpacaExecutor.closePosition(symbol) liquidates the AGGREGATE broker position
// while only the requesting sleeve closes its DB row — so a symbol owned by BOTH
// sleeves leaves a phantom open DB row when the other exits (the April incident
// class). The universes MUST stay disjoint. This guards every future expansion.
describe("momentum_stocks ∩ meanrev_stocks universes", () => {
  // stockSymbols (price stream/dashboard) used to be a hand-written mirror
  // that could drift from MOMENTUM_STOCKS_UNIVERSE — now derived; this locks it.
  test("stockSymbols (price stream/dashboard) matches MOMENTUM_STOCKS_UNIVERSE", () => {
    expect(stockSymbols.filter(s => s.enabled).map(s => s.symbol).sort())
      .toEqual([...MOMENTUM_STOCKS_UNIVERSE].sort());
  });

  test("are disjoint (shared-wallet aggregate-close phantom)", () => {
    const mr = new Set(MEANREV_UNIVERSE);
    const overlap = MOMENTUM_STOCKS_UNIVERSE.filter(s => mr.has(s));
    expect(overlap).toEqual([]);
  });

  test("RW11 tradable universe = the 2x-ETF core + the SH overlay, disjoint from meanrev and treasury; SPY is signal-only", () => {
    const version = currentModelVersion("momentum_stocks")!;
    const manifest = JSON.parse(readFileSync(new URL(`../../${version.manifest}`, import.meta.url), "utf8"));
    const params = manifest.candidates.find((c: any) => c.name === version.candidate).portfolio;
    const tradable = portfolioUniverse("portfolio", params);
    expect(params.strategy.universe).toEqual(MOMENTUM_STOCKS_UNIVERSE);
    expect(tradable.sort()).toEqual([...MOMENTUM_STOCKS_UNIVERSE, "SH"].sort());
    expect(tradable.filter(s => MEANREV_UNIVERSE.includes(s))).toEqual([]);
    expect(tradable.filter(isTreasurySymbol)).toEqual([]);
    expect(isTreasurySymbol("SH")).toBe(false);
    // RW11: the four 2x ETFs are core assets of momentum_stocks and of nobody else; SPY feeds the
    // SMA200 switch but is not tradable by this sleeve any more (its rows are sold at the cutover pass).
    for (const s of ["SSO", "QLD", "USD", "UGL"]) {
      expect(MOMENTUM_STOCKS_UNIVERSE).toContain(s);
      expect(MEANREV_UNIVERSE).not.toContain(s);
      expect(isTreasurySymbol(s)).toBe(false);
    }
    expect(params.strategy.regimeOverlay.signals.map((s: any) => s.symbol)).toEqual(["SPY"]);
    expect(tradable).not.toContain("SPY");
    // BrokerSync's ownership boundary (B-4) is derived from the same tradable universe: a live
    // definition carrying this strategy registers SH as sleeve-owned, never an alpaca_main orphan.
    const owned = portfolioEngineOwnedSymbols([{ id: "pe", name: "E1", template: "portfolio", account: "alpaca_main", capital: 1, mode: "live", enabled: true,
      params: { ...params, engine: "portfolio", venue: "alpaca", runMode: "live" } }]);
    expect(owned.alpaca).toEqual(tradable.sort());
  });

  test("neither universe has internal duplicates", () => {
    expect(new Set(MOMENTUM_STOCKS_UNIVERSE).size).toBe(MOMENTUM_STOCKS_UNIVERSE.length);
    expect(new Set(MEANREV_UNIVERSE).size).toBe(MEANREV_UNIVERSE.length);
  });
});

// Stage C of the AI review (docs/reports/IA-revision-de-noticias-2026-11-14.md, amendment 2026-11-14): the ten inverse funds a `short`
// vote is bet with are bought by the stock sleeves' live pass but belong to NO universe: the shared wallet's aggregate-close phantom
// (above) would return if a fund were also traded by a strategy, and BrokerSync owns them through INVERSE_SYMBOLS, not a universe.
describe("the inverse funds of the AI review (stage C) are in no universe, hedge, signal or treasury symbol", () => {
  const every = (node: unknown, out = new Set<string>(), key = ""): Set<string> => {
    if (Array.isArray(node)) {
      if ((key === "universe" || key === "symbols") && node.every(s => typeof s === "string")) node.forEach(s => out.add(s as string));
      else node.forEach(v => every(v, out, key));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) { if (k === "symbol" && typeof v === "string") out.add(v); else every(v, out, k); }
    }
    return out;
  };
  const definitionSymbols = () => every(builtinPortfolios().map(d => d.params));

  test("no fund is in either stock universe, the crypto universes, a built-in definition (hedge/signal included) or the treasury", () => {
    const taken = new Map<string, string>();
    for (const [from, symbols] of Object.entries({
      "momentum_stocks universe": MOMENTUM_STOCKS_UNIVERSE, "meanrev universe": MEANREV_UNIVERSE, "crypto universe": MOMENTUM_CRYPTO_UNIVERSE,
      "built-in definitions (universes, hedge, signals)": [...definitionSymbols()], "treasury symbols": [...TREASURY_SYMBOLS],
      "stock symbols": stockSymbols.map(s => s.symbol), "the Binance ownership set": [...SLEEVE_UNIVERSE_BINANCE],
    })) for (const s of symbols) taken.set(`${from}|${s}`, s);
    const clashes = [...taken.entries()].filter(([, s]) => INVERSE_SYMBOLS.includes(s)).map(([k]) => k);
    expect(clashes).toEqual([]);
    for (const s of INVERSE_SYMBOLS) expect(isTreasurySymbol(s)).toBe(false);
    expect(INVERSE_SYMBOLS).not.toContain("SH");
  });
  test("each fund appears once, and each stock it bets against is in exactly one stock sleeve's universe", () => {
    expect(new Set(INVERSE_SYMBOLS).size).toBe(INVERSE_SYMBOLS.length);
    for (const f of INVERSE_FUNDS) {
      const homes = [MOMENTUM_STOCKS_UNIVERSE.includes(f.underlying), MEANREV_UNIVERSE.includes(f.underlying)].filter(Boolean);
      expect(homes).toHaveLength(1);
    }
  });
  test("the tradable stocks the funds track are single names (the sleeves never hold the fund itself)", () => {
    for (const f of INVERSE_FUNDS) expect([...MOMENTUM_STOCKS_UNIVERSE, ...MEANREV_UNIVERSE]).not.toContain(f.symbol);
  });
});

// The crypto sleeve universe was previously duplicated in three unlinked
// places (index.ts's engine universe, symbols.ts's cryptoSymbols, BrokerSync's
// SLEEVE_UNIVERSE_BINANCE) — a drift there meant BrokerSync adopting a
// live-traded symbol under binance_main, where no engine/SL loop manages it.
// All three now derive from MOMENTUM_CRYPTO_UNIVERSE (index.ts imports the
// same constant used here); this locks the two derived mirrors against it.
describe("momentum_crypto universe — single source of truth", () => {
  test("cryptoSymbols (price stream/dashboard) matches MOMENTUM_CRYPTO_UNIVERSE", () => {
    expect(cryptoSymbols.filter(s => s.enabled).map(s => s.symbol).sort())
      .toEqual([...MOMENTUM_CRYPTO_UNIVERSE].sort());
  });

  test("BrokerSync's sleeve ownership set matches MOMENTUM_CRYPTO_UNIVERSE", () => {
    expect([...SLEEVE_UNIVERSE_BINANCE].sort()).toEqual([...MOMENTUM_CRYPTO_UNIVERSE].sort());
  });

  test("no internal duplicates", () => {
    expect(new Set(MOMENTUM_CRYPTO_UNIVERSE).size).toBe(MOMENTUM_CRYPTO_UNIVERSE.length);
  });

  // A universe symbol with no SYMBOL_MAP entry cannot be opened OR closed by
  // the Binance executor, fetchBinanceKlines returns [] for it, and
  // getOpenPositions filters it silently — the sleeve fails with zero noise
  // (the shadow_momentum_crypto 10-day blackout class). Any future universe
  // expansion MUST land its native translation in the same commit.
  test("every symbol has a native Binance (USDT-perp) translation in SYMBOL_MAP", () => {
    const unmapped = MOMENTUM_CRYPTO_UNIVERSE.filter(s => !SYMBOL_MAP[s]);
    expect(unmapped).toEqual([]);
  });
});

// wideUniverse.ts's MOMENTUM_SYMBOLS was a third, hand-written copy of the
// momentum_stocks universe that drifted (missed +SMH from b5fb1e5) — it
// feeds scripts/download-stock-dailies.ts and scripts/backtest-meanrev-wide.ts
// (the shadow_meanrev_wide sleeve that consumed it in index.ts was removed
// 2026-09-25, dead by owner decision; those two scripts are the remaining
// live consumers). Now derived from MOMENTUM_STOCKS_UNIVERSE; this locks it
// against drift.
describe("wideUniverse MOMENTUM_SYMBOLS — single source of truth", () => {
  test("matches MOMENTUM_STOCKS_UNIVERSE", () => {
    expect([...MOMENTUM_SYMBOLS].sort()).toEqual([...MOMENTUM_STOCKS_UNIVERSE].sort());
  });
});
