// ═══════════════════════════════════════════════════════════════════════
// refresh-crypto-universe — symbol-list derivation only (no network, no DB
// writes: this checkout's data/historical.db is a READ-ONLY symlink, so the
// refresh function itself is exercised manually against a real DB, not in
// `bun test`).
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { deriveCryptoUniverseSymbols } from "./refresh-crypto-universe";
import { MOMENTUM_CRYPTO_UNIVERSE } from "../src/config/riskProfiles";
import { USDC_SYMBOL_MAP } from "../src/executor/binance/quoteAsset";
import { toBinanceSymbol } from "../src/data/fetchers/BinancePublicFetcher";

describe("deriveCryptoUniverseSymbols", () => {
  const symbols = deriveCryptoUniverseSymbols();

  test("contains every momentum_crypto (USDT) universe symbol as-is", () => {
    for (const s of MOMENTUM_CRYPTO_UNIVERSE) expect(symbols).toContain(s);
  });

  test("contains every USDC base translated to its USDT perp (BASE/USD, not BASE/USDC)", () => {
    for (const usdcSymbol of Object.keys(USDC_SYMBOL_MAP)) {
      const base = usdcSymbol.replace("/USDC", "");
      expect(symbols).toContain(`${base}/USD`);
      expect(symbols).not.toContain(usdcSymbol);
    }
  });

  test("deduplicated: no symbol appears twice (8 of the 13 USDC bases overlap the live 8)", () => {
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  test("exact expected size: union of MOMENTUM_CRYPTO_UNIVERSE and USDC bases-as-USD", () => {
    const expected = new Set([
      ...MOMENTUM_CRYPTO_UNIVERSE,
      ...Object.keys(USDC_SYMBOL_MAP).map(s => s.replace("/USDC", "/USD")),
    ]);
    expect(symbols.length).toBe(expected.size);
    expect(new Set(symbols)).toEqual(expected);
  });

  test("sorted (stable, diffable list)", () => {
    expect(symbols).toEqual([...symbols].sort());
  });

  test("every symbol converts to a valid Binance mainnet USDT perp", () => {
    for (const s of symbols) {
      const bin = toBinanceSymbol(s);
      expect(bin).not.toBeNull();
      expect(bin).toMatch(/USDT$/);
    }
  });

  test("includes the 5 USDC-only bases absent from the live 8 (BCH/BNB/LTC/NEAR/UNI)", () => {
    for (const base of ["BCH", "BNB", "LTC", "NEAR", "UNI"]) {
      expect(symbols).toContain(`${base}/USD`);
      expect(MOMENTUM_CRYPTO_UNIVERSE).not.toContain(`${base}/USD`);
    }
  });
});
