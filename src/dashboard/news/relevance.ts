import { MOMENTUM_CRYPTO_UNIVERSE, MOMENTUM_STOCKS_UNIVERSE } from "../../config/riskProfiles";
import { USDC_SYMBOL_MAP } from "../../executor/binance/quoteAsset";
import { MEANREV_UNIVERSE } from "../../strategies/meanrev/MeanRevEngine";

export interface NewsRelevanceContext {
  heldSymbols: readonly string[];
  /** Additional symbols from enabled portfolio definitions (including overlays). */
  tradedSymbols?: readonly string[];
}

export const NEWS_UNIVERSE = [...new Set([
  ...MOMENTUM_STOCKS_UNIVERSE, ...MEANREV_UNIVERSE,
  ...MOMENTUM_CRYPTO_UNIVERSE, ...Object.keys(USDC_SYMBOL_MAP),
])]; // COIN-M's BTC is already in the crypto universe.

// Names only provide aliases; membership always comes from the canonical
// universes / portfolio definitions / open rows, never this dictionary.
const NAMES: Record<string, string[]> = {
  AAPL: ["Apple"], MSFT: ["Microsoft"], NVDA: ["Nvidia"], META: ["Meta", "Facebook"],
  GOOGL: ["Alphabet", "Google"], AMZN: ["Amazon"], ABBV: ["AbbVie"], AVGO: ["Broadcom"],
  BAC: ["Bank of America"], CAT: ["Caterpillar"], COST: ["Costco"], CVX: ["Chevron"],
  DIS: ["Disney"], GE: ["General Electric", "GE Aerospace"], HD: ["Home Depot"], HON: ["Honeywell"],
  JNJ: ["Johnson & Johnson", "Johnson and Johnson"], JPM: ["JPMorgan", "JP Morgan", "J.P. Morgan"],
  KO: ["Coca-Cola", "Coca Cola"], LLY: ["Eli Lilly"], MA: ["Mastercard"], MCD: ["McDonald's", "McDonalds"],
  MRK: ["Merck"], NFLX: ["Netflix"], NKE: ["Nike"], ORCL: ["Oracle"], PG: ["Procter & Gamble", "Procter and Gamble"],
  QCOM: ["Qualcomm"], UNH: ["UnitedHealth"], V: ["Visa"], WMT: ["Walmart"], XOM: ["Exxon", "ExxonMobil"],
  SPY: ["SPDR S&P 500"], QQQ: ["Invesco QQQ"], IWM: ["iShares Russell 2000"],
  GLD: ["SPDR Gold"], SLV: ["iShares Silver"], SMH: ["VanEck Semiconductor"],
  XLE: ["Energy Select Sector"], XLF: ["Financial Select Sector"], XLI: ["Industrial Select Sector"],
  XLP: ["Consumer Staples Select Sector"], XLV: ["Health Care Select Sector"],
  BTC: ["Bitcoin"], ETH: ["Ethereum", "Ether"], SOL: ["Solana"], XRP: ["Ripple"], ADA: ["Cardano"],
  AVAX: ["Avalanche"], DOGE: ["Dogecoin"], LINK: ["Chainlink"], BCH: ["Bitcoin Cash"],
  BNB: ["Binance Coin"], LTC: ["Litecoin"], NEAR: ["Near Protocol"], UNI: ["Uniswap"],
};

const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[’‘]/g, "'");
const baseSymbol = (s: string) => s.toUpperCase().split("/")[0].replace(/(?:USDT|USDC|USD_PERP)$/, "");
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const whole = (s: string, flags = "i") => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(s)}(?![\\p{L}\\p{N}_])`, `${flags}u`);

// Exclusions win even when a headline mentions a held name or the Fed.
// Deliberately headline-only: RSS descriptions often contain unrelated promos.
const EXCLUDE = [
  /\b(?:my|our) (?:husband|wife|father|mother|dad|mom|son|daughter|partner|in-laws?|father-in-law|mother-in-law)\b/i,
  /\b(?:should|can|could) I\b|\b(?:am I|I'm|I am)\b/i,
  /\bI (?:inherited|bought|sold|owe|earn|need|want)\b/i,
  /\b(?:mi (?:marido|esposa|padre|madre|suegro|suegra)|deberia (?:yo|comprar|invertir))\b/i,
  /\b(?:personal finance|financial advice|retirement advice|retirement planning|retire early|how to retire|401\(?k\)?|Roth IRA|your retirement|your pension|your mortgage|mortgage advice|first-time home ?buyers?|reverse mortgage)\b/i,
  /\b(?:retirement|retirees?|jubilacion|jubilados?)\b.*\b(?:advice|tips|mistakes|save|savings|consejos|errores|ahorrar)\b/i,
  /\b(?:finanzas personales|consejos? (?:financieros|para jubilarse)|tu (?:jubilacion|hipoteca)|comprar (?:mi|tu|una) casa)\b/i,
  /\b(?:celebrity|celebrities|horoscope|wedding|divorce|dating|vacation|travel tips|lifestyle|famosos|horoscopo|boda|divorcio)\b/i,
  /\b(?:top|best|worst)\s+(?:\d+\s+)?(?:stocks?|coins?|cryptos?|cryptocurrencies|ETFs?|ways?|tips?|reasons?|things?|picks?|acciones|criptomonedas|consejos|razones)\b/i,
  /^(?:["']|these |the )?(?:\d+|three|five|seven|ten|tres|cinco|diez)\s+(?:[\w-]+\s+){0,2}(?:stocks?|coins?|cryptos?|cryptocurrencies|ETFs?|ways?|reasons?|things?|tips?|picks?|acciones|criptomonedas|razones|consejos)\b/i,
  /\b(?:how to (?:buy|invest|save|profit|make money)|what to buy|stocks? to (?:buy|avoid)|buy (?:the dip|now)|should you|why you should|is it time to (?:buy|sell)|price prediction|millionaire|get rich|opinion:|commentary:|editorial:)\b/i,
  /\b(?:is a (?:buy|sell)|must-buy|your (?:portfolio|finances)|price (?:forecast|target for 20\d\d))\b/i,
  /\b(?:como (?:comprar|invertir|ahorrar|ganar dinero)|mejores (?:acciones|criptomonedas)|prediccion de precio|opinion:|deberias|millonario)\b/i,
  /\b(?:opinion|commentary|editorial)\s*:/i,
];

const MACRO: Array<[string, RegExp]> = [
  ["Fed", /\b(?:Fed|FOMC|Federal Reserve|Reserva Federal|rate (?:decisions?|cuts?|hikes?)|interest rates?|tipos de interes|tasas de interes|decision de tasas)\b/i],
  ["Inflation", /\b(?:CPI|PCE|inflation|inflacion|IPC|consumer prices?|precios al consumidor)\b/i],
  ["Jobs", /\b(?:jobs report|employment report|payrolls?|nonfarm|unemployment|jobless claims|informe de empleo|nominas|desempleo)\b/i],
  ["GDP", /\b(?:GDP|PIB|recession|recesion|gross domestic product)\b/i],
  ["Trade", /\b(?:tariffs?|sanctions?|aranceles?|sanciones?)\b/i],
  ["Banks", /\b(?:bank (?:failures?|collaps\w*|runs?|rescue\w*)|banking crisis|quiebra bancaria|crisis bancaria)\b/i],
  ["Crypto", /(?:\b(?:crypto|bitcoin|ethereum|digital assets?|cripto\w*|Binance|Coinbase|Kraken)\b.*\b(?:SEC|regulat\w*|ETF|approv\w*|aprob\w*)\b|\b(?:SEC|regulat\w*|ETF|approv\w*|aprob\w*)\b.*\b(?:crypto|digital assets?|cripto\w*|Binance|Coinbase|Kraken)\b|\b(?:exchange|Binance|Coinbase|Kraken)\b.*\b(?:hack\w*|outage|halt\w*|down|caida|interrupcion)\b|\b(?:hack\w*|outage|caida|interrupcion)\b.*\b(?:exchange|Binance|Coinbase|Kraken)\b)/i],
  ["Markets", /\b(?:S&P\s?500|Nasdaq|Dow Jones|Russell 2000)\b/i],
  ["Oil", /(?:\b(?:oil|crude|Brent|WTI|petroleo)\b.*\b(?:shock|surge\w*|spike\w*|plunge\w*|jump\w*|soar\w*|tumble\w*|supply|disruption|shortage|embargo|OPEC|salta|dispara|desploma)\b|\b(?:OPEC|oil shock|crisis petrolera)\b)/i],
];

function mentions(title: string, symbol: string): boolean {
  // Bare tickers are case-sensitive: "near", "link", "cat", "v" are not assets.
  // Cashtags and full company/coin names are case-insensitive.
  return whole(`$${symbol}`).test(title) || whole(symbol, "").test(title)
    || (NAMES[symbol] ?? []).some(name => whole(normalize(name)).test(title));
}

export function newsRelevance(title: string, context: NewsRelevanceContext): { tag: string; score: number } | null {
  const text = normalize(title);
  if (EXCLUDE.some(pattern => pattern.test(text))) return null;
  const held = [...new Set(context.heldSymbols.map(baseSymbol))].sort();
  const traded = [...new Set([...NEWS_UNIVERSE, ...(context.tradedSymbols ?? [])].map(baseSymbol))].sort();
  for (const symbol of held) if (mentions(text, symbol)) return { tag: symbol, score: 3 };
  for (const symbol of traded) if (mentions(text, symbol)) return { tag: symbol, score: 2 };
  for (const [tag, pattern] of MACRO) if (pattern.test(text)) return { tag, score: 1 };
  return null;
}

/** Relevance first, then recency; stable input order breaks exact ties. No padding. */
export function rankNewsItems<T extends { title: string; pubDate: number | null }>(items: T[], context: NewsRelevanceContext): Array<T & { tag: string }> {
  return items.map(item => ({ item, match: newsRelevance(item.title, context) }))
    .filter((row): row is { item: T; match: { tag: string; score: number } } => row.match !== null)
    .sort((a, b) => b.match.score - a.match.score || (b.item.pubDate ?? 0) - (a.item.pubDate ?? 0))
    .map(({ item, match }) => ({ ...item, tag: match.tag }));
}
