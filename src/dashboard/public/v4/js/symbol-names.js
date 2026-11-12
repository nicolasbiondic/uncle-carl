// ── symbol-names.js — a ticker in plain words ───────────────────────────────
// The owner reads "USD" as dollars (it is a 2x semiconductors ETF) and "UGL"
// as nothing. symbolName("UGL", "es") → "Oro ×2"; null when a symbol has no
// name (the table then shows the ticker alone). Pure, no imports, so the test
// (symbol-names.test.js) can check it against the REAL universes: a symbol a
// live strategy can hold without a name here fails the build, so a universe
// change can never put a bare code on screen again.

// [English, Spanish]. Stocks and ETFs by exact ticker.
const STOCKS = {
  // momentum_stocks core (RW11): the 2x ETFs, the single names and the small-cap index
  SSO: ["S&P 500 ×2", "S&P 500 ×2"],
  QLD: ["Nasdaq 100 ×2", "Nasdaq 100 ×2"],
  USD: ["Semiconductors ×2", "Semiconductores ×2"],
  UGL: ["Gold ×2", "Oro ×2"],
  IWM: ["Small US companies", "Empresas pequeñas de EE. UU."],
  AAPL: ["Apple", "Apple"],
  MSFT: ["Microsoft", "Microsoft"],
  NVDA: ["Nvidia", "Nvidia"],
  META: ["Meta (Facebook)", "Meta (Facebook)"],
  GOOGL: ["Google", "Google"],
  AMZN: ["Amazon", "Amazon"],
  // the risk-off hedge and the switch's signal; the 1x ETFs the sleeve held before RW11 (old trades)
  SH: ["Against the S&P 500", "Contra el S&P 500"],
  SPY: ["S&P 500", "S&P 500"],
  QQQ: ["Nasdaq 100", "Nasdaq 100"],
  SMH: ["Semiconductors", "Semiconductores"],
  GLD: ["Gold", "Oro"],
  // meanrev_stocks (MEANREV_UNIVERSE)
  ABBV: ["AbbVie", "AbbVie"],
  AVGO: ["Broadcom", "Broadcom"],
  BAC: ["Bank of America", "Bank of America"],
  CAT: ["Caterpillar", "Caterpillar"],
  COST: ["Costco", "Costco"],
  CVX: ["Chevron", "Chevron"],
  DIS: ["Disney", "Disney"],
  GE: ["GE Aerospace", "GE Aerospace"],
  HD: ["Home Depot", "Home Depot"],
  HON: ["Honeywell", "Honeywell"],
  JNJ: ["Johnson & Johnson", "Johnson & Johnson"],
  JPM: ["JPMorgan", "JPMorgan"],
  KO: ["Coca-Cola", "Coca-Cola"],
  LLY: ["Eli Lilly", "Eli Lilly"],
  MA: ["Mastercard", "Mastercard"],
  MCD: ["McDonald's", "McDonald's"],
  MRK: ["Merck", "Merck"],
  NFLX: ["Netflix", "Netflix"],
  NKE: ["Nike", "Nike"],
  ORCL: ["Oracle", "Oracle"],
  PG: ["Procter & Gamble", "Procter & Gamble"],
  QCOM: ["Qualcomm", "Qualcomm"],
  UNH: ["UnitedHealth", "UnitedHealth"],
  V: ["Visa", "Visa"],
  WMT: ["Walmart", "Walmart"],
  XLE: ["Energy sector", "Sector energía"],
  XLF: ["Financial sector", "Sector financiero"],
  XLI: ["Industrial sector", "Sector industrial"],
  XLP: ["Everyday-goods sector", "Sector consumo básico"],
  XLV: ["Healthcare sector", "Sector salud"],
  XOM: ["Exxon Mobil", "Exxon Mobil"],
  SLV: ["Silver", "Plata"],
  // treasury sweep vehicles (src/treasury/treasurySymbols.ts)
  BOXX: ["Treasury cash fund", "Fondo de efectivo (tesorería)"],
  SGOV: ["Short-term US Treasuries", "Letras del Tesoro de EE. UU."],
  BIL: ["Short-term US Treasuries", "Letras del Tesoro de EE. UU."],
};

// Crypto by BASE: "XRP/USDC", "XRP/USD" and "XRP" all read as XRP's entry.
const CRYPTO = {
  BTC: ["Bitcoin", "Bitcoin"],
  ETH: ["Ethereum", "Ethereum"],
  SOL: ["Solana", "Solana"],
  XRP: ["XRP", "XRP"],
  ADA: ["Cardano", "Cardano"],
  AVAX: ["Avalanche", "Avalanche"],
  DOGE: ["Dogecoin", "Dogecoin"],
  LINK: ["Chainlink", "Chainlink"],
  BCH: ["Bitcoin Cash", "Bitcoin Cash"],
  BNB: ["BNB", "BNB"],
  LTC: ["Litecoin", "Litecoin"],
  NEAR: ["NEAR", "NEAR"],
  UNI: ["Uniswap", "Uniswap"],
};

/** Plain name of a symbol in `lang` ("en" | "es"), or null when unknown. */
export function symbolName(symbol, lang = "en") {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return null;
  const i = lang === "es" ? 1 : 0;
  const hit = STOCKS[sym] || CRYPTO[sym.includes("/") ? sym.split("/")[0] : sym];
  return hit ? hit[i] : null;
}

/** The part of a symbol before its quote asset ("XRP/USDC" → "XRP"). */
export const symbolBase = (symbol) => String(symbol ?? "").split("/")[0];
