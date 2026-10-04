// ══════════════════════════════════════════════
// Binance USDⓈ-M quote-asset config (2026-07-19)
//
// Two isolated settlement wallets on the SAME futures account: USDT (the
// existing/default sleeve, internal symbols "XXX/USD") and USDC (new,
// internal symbols "XXX/USDC"). Root account totals
// (totalMarginBalance/availableBalance) reflect ONLY the USDT margin asset
// (verified live — see AGENTS.md "Binance account balance mismatch"
// history); USDC lives in `assets[]` as its own row. Keeping the two symbol
// maps disjoint (distinct internal-symbol keys, distinct native-symbol
// values) is what makes ownership checks a plain map lookup everywhere else.
// ══════════════════════════════════════════════

export type QuoteAsset = "USDT" | "USDC";

// USDⓈ-M USDC-margined perpetuals confirmed trading on the account (preflight
// 2026-07-19). ATOM/DOT/TRX have no USDC contract — excluded on purpose.
const USDC_BASES = [
  "ADA", "AVAX", "BCH", "BNB", "BTC", "DOGE", "ETH",
  "LINK", "LTC", "NEAR", "SOL", "UNI", "XRP",
] as const;

export const USDC_SYMBOL_MAP: Record<string, string> = Object.fromEntries(
  USDC_BASES.map((base) => [`${base}/USDC`, `${base}USDC`]),
);
