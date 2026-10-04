import { describe, expect, test } from "bun:test";
import { MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE } from "./riskProfiles";
import { MEANREV_UNIVERSE } from "../strategies/meanrev/MeanRevEngine";
import { stockSymbols, cryptoSymbols } from "./symbols";
import { SLEEVE_UNIVERSE_BINANCE } from "../sync/BrokerSync";
import { MOMENTUM_SYMBOLS } from "./wideUniverse";
import { SYMBOL_MAP } from "../executor/binance-executor";

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

  test("neither universe has internal duplicates", () => {
    expect(new Set(MOMENTUM_STOCKS_UNIVERSE).size).toBe(MOMENTUM_STOCKS_UNIVERSE.length);
    expect(new Set(MEANREV_UNIVERSE).size).toBe(MEANREV_UNIVERSE.length);
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
