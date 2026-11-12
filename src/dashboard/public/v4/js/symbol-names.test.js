// ── Every symbol a live strategy can hold has a plain name (owner, 2026-11-12) ──
// The owner read "USD" (a 2x semiconductors ETF) as dollars. The universes are
// imported from the code that trades them, so adding a symbol to a sleeve
// without naming it here fails this test instead of showing a bare code.
import { describe, expect, test } from "bun:test";
import { symbolName, symbolBase } from "./symbol-names.js";
import { MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE } from "../../../../config/riskProfiles";
import { MEANREV_UNIVERSE } from "../../../../strategies/meanrev/MeanRevEngine";
import { builtinPortfolios } from "../../../../portfolios/builtin";
import { USDC_SYMBOL_MAP } from "../../../../executor/binance/quoteAsset";
import { TREASURY_SYMBOLS } from "../../../../treasury/treasurySymbols";

/** Every symbol string reachable from a definition's params: universes, the
 *  breakout-short list, the regime overlay's signal and hedge symbols. */
function definitionSymbols(node, out = new Set(), key = "") {
  if (Array.isArray(node)) {
    if ((key === "universe" || key === "symbols") && node.every((s) => typeof s === "string")) node.forEach((s) => out.add(s));
    else node.forEach((v) => definitionSymbols(v, out, key));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "symbol" && typeof v === "string") out.add(v);
      else definitionSymbols(v, out, k);
    }
  }
  return out;
}

const live = () => {
  const sets = {
    "momentum_stocks universe": MOMENTUM_STOCKS_UNIVERSE,
    "meanrev universe": MEANREV_UNIVERSE,
    "crypto USDT universe": MOMENTUM_CRYPTO_UNIVERSE,
    "crypto USDC universe": Object.keys(USDC_SYMBOL_MAP),
    "treasury symbols": [...TREASURY_SYMBOLS],
    "built-in definitions": [...definitionSymbols(builtinPortfolios().map((d) => d.params))],
  };
  return Object.entries(sets).flatMap(([from, symbols]) => symbols.map((symbol) => ({ from, symbol })));
};

describe("symbolName covers every live symbol", () => {
  test("the live universes are not empty (the import would otherwise pass vacuously)", () => {
    const all = live();
    expect(MOMENTUM_STOCKS_UNIVERSE.length).toBe(11);
    expect(MEANREV_UNIVERSE.length).toBe(32);
    expect(all.some((x) => x.symbol === "SH")).toBe(true);   // the hedge comes from the definition, not from a universe
    expect(all.some((x) => x.symbol === "SPY")).toBe(true);  // the switch's signal
    expect(all.some((x) => x.symbol === "NEAR/USDC")).toBe(true);
  });

  for (const lang of ["en", "es"]) {
    test(`every live symbol has a ${lang} name`, () => {
      const missing = live().filter(({ symbol }) => !symbolName(symbol, lang)).map(({ from, symbol }) => `${symbol} (${from})`);
      expect(missing).toEqual([]);
    });
  }

  test("no name is a bare ticker or an empty string, except a coin that is its own name", () => {
    for (const { symbol } of live()) {
      for (const lang of ["en", "es"]) {
        const name = symbolName(symbol, lang);
        expect(name.trim().length).toBeGreaterThan(1);
        if (!symbol.includes("/")) expect(name).not.toBe(symbol);
      }
    }
  });
});

describe("symbolName wording", () => {
  test("the symbols the owner could not read", () => {
    expect(symbolName("USD", "en")).toBe("Semiconductors ×2");
    expect(symbolName("USD", "es")).toBe("Semiconductores ×2");
    expect(symbolName("UGL", "es")).toBe("Oro ×2");
    expect(symbolName("SSO", "en")).toBe("S&P 500 ×2");
    expect(symbolName("QLD", "en")).toBe("Nasdaq 100 ×2");
    expect(symbolName("SH", "en")).toBe("Against the S&P 500");
    expect(symbolName("SH", "es")).toBe("Contra el S&P 500");
    expect(symbolName("IWM", "es")).toBe("Empresas pequeñas de EE. UU.");
    expect(symbolName("AAPL")).toBe("Apple");
  });

  test("crypto reads by its base, whatever the quote asset", () => {
    expect(symbolName("XRP/USDC")).toBe("XRP");
    expect(symbolName("BTC/USD")).toBe("Bitcoin");
    expect(symbolName("ETH/USDC", "es")).toBe("Ethereum");
    expect(symbolName("BTC/COIN-M")).toBe("Bitcoin");
    expect(symbolBase("XRP/USDC")).toBe("XRP");
    expect(symbolBase("AAPL")).toBe("AAPL");
  });

  test("unknown or empty symbols answer null, never a guess", () => {
    expect(symbolName("ZZZZ")).toBeNull();
    expect(symbolName("1000PEPE/USDC")).toBeNull();
    expect(symbolName("")).toBeNull();
    expect(symbolName(null)).toBeNull();
    expect(symbolName(undefined, "es")).toBeNull();
  });

  test("case-insensitive; the language defaults to English", () => {
    expect(symbolName("aapl")).toBe("Apple");
    expect(symbolName("ugl")).toBe("Gold ×2");
  });
});
