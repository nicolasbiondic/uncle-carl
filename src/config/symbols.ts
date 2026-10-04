// ══════════════════════════════════════════════
// Symbol Universe v8 — the two momentum sleeves
//
// Both lists are DERIVED from riskProfiles.ts's MOMENTUM_STOCKS_UNIVERSE /
// MOMENTUM_CRYPTO_UNIVERSE, the single source of truth also consumed by
// index.ts's engines and BrokerSync's ownership boundary (SLEEVE_UNIVERSE_*)
// — toggling either universe there now changes the resolved set everywhere.
// stockSymbols used to be a hand-written mirror that could silently drift
// from the engine's real universe (it already bit wideUniverse.ts's copy —
// see riskProfiles.disjoint.test.ts); locked here the same way cryptoSymbols
// already was.
// These lists feed the Alpaca real-time price stream (used by
// checkAllStopLoss + dashboard market data) and the dashboard symbol views.
// ══════════════════════════════════════════════

import { MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE } from "./riskProfiles";

export type Sector = "tech" | "index" | "commodity" | "crypto";
export type AssetClass = "us_equity" | "crypto";

export interface SymbolEntry {
  symbol: string;
  enabled: boolean;
  sector: Sector;
  assetClass: AssetClass;
}

// Cosmetic sector tag per stock symbol (dashboard grouping only — not a
// trading input). New symbols default to "tech" below if not listed here.
const STOCK_SECTORS: Record<string, Sector> = {
  SPY: "index", QQQ: "index", IWM: "index", GLD: "commodity",
};

// ── Stocks sleeve (Alpaca) ──────────────────
export const stockSymbols: SymbolEntry[] = MOMENTUM_STOCKS_UNIVERSE.map(symbol => ({
  symbol, enabled: true, sector: STOCK_SECTORS[symbol] ?? "tech", assetClass: "us_equity",
}));

// ── Crypto sleeve (Binance Futures perps) ───
export const cryptoSymbols: SymbolEntry[] = MOMENTUM_CRYPTO_UNIVERSE.map(symbol => ({
  symbol, enabled: true, sector: "crypto", assetClass: "crypto",
}));

// ── Helpers ─────────────────────────────────

export function getEnabledStocks(): string[] {
  return stockSymbols.filter(s => s.enabled).map(s => s.symbol);
}

export function getEnabledCrypto(): string[] {
  return cryptoSymbols.filter(s => s.enabled).map(s => s.symbol);
}

export function getAssetClass(symbol: string): AssetClass {
  if (symbol.includes("/")) return "crypto";
  const entry = [...stockSymbols, ...cryptoSymbols].find(s => s.symbol === symbol);
  return entry?.assetClass ?? "us_equity";
}

export function getSymbolsByBroker() {
  return {
    stocks: stockSymbols.map(s => ({ ...s })),
    crypto: cryptoSymbols.map(s => ({ ...s })),
  };
}
