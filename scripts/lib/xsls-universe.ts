/**
 * Line A (research/crypto-xs-ls): point-in-time monthly universe for the
 * cross-sectional long/short crypto momentum line — §12 of
 * docs/reports/V-plan-volumen-rentabilidad.md.
 *
 * Shared by the downloader (scripts/fetch-binance-perps-vision.ts — decides
 * which symbols need 1h klines + funding) and the replay kernel
 * (scripts/crypto-xsls-replay.ts — decides which symbols are tradable at
 * each decision), so both sides reconstitute the SAME universe from the
 * same deterministic rule:
 *
 *   At each UTC month start T: rank every listed USDT-M perp by its MEAN
 *   DAILY QUOTED VOLUME over the 30 calendar days before T (≥ MIN_DAYS
 *   daily bars required, last bar within FRESH_DAYS of T so a delisted
 *   contract drops out), exclude stablecoins, wrapped/tokenized assets,
 *   composite indices and the 8 momentum_crypto bases (BTC ETH SOL XRP ADA
 *   AVAX DOGE LINK — the live USDT pool nets per symbol in one-way mode, so
 *   the universes must stay disjoint), take the top N. Membership holds for
 *   the whole month.
 *
 * Everything here is pure computation over the research DB
 * ($UC_RESEARCH_DATA_DIR/hist-perps.db, scripts/lib/researchData.ts): no
 * repo data files touched.
 */

import type { Database } from "bun:sqlite";

/** The 8 momentum_crypto bases (riskProfiles MOMENTUM_UNIVERSE) — disjoint pool rule. */
export const MOMENTUM_BASES = ["BTC", "ETH", "SOL", "XRP", "ADA", "AVAX", "DOGE", "LINK"];

/** Stablecoins (anything designed to peg a fiat unit, incl. depegged algo-stables). */
export const STABLE_BASES = [
  "USDC", "BUSD", "TUSD", "USDP", "DAI", "FDUSD", "USDE", "USDD", "PYUSD",
  "EUR", "EURI", "AEUR", "USD1", "USDF", "XUSD", "USTC", "UST", "FRAX",
  "LUSD", "GUSD", "BFUSD", "USDS",
];

/** Wrapped / tokenized representations of another asset (incl. tokenized gold). */
export const WRAPPED_BASES = [
  "WBTC", "WBETH", "BETH", "WETH", "STETH", "WSTETH", "CBETH", "RETH",
  "PAXG", "XAUT",
];

/**
 * Non-crypto underlyings (tokenized equities, commodities, FX, ETFs and
 * composite indices). Snapshot of fapi exchangeInfo underlyingType != "COIN"
 * taken 2026-10-09 — Binance's own classification. Baked as a constant so
 * the universe rule stays deterministic (no live-API dependency); delisted
 * symbols from earlier eras are all crypto (TradFi perps launched 2025+).
 */
export const NON_CRYPTO_SYMBOLS = new Set([
"AAOIUSDT", "AAPLUSDT", "ACNUSDT", "ADBEUSDT", "AGPUUSDT", "AKAMUSDT",
"ALABUSDT", "ALLUSDT", "AMATUSDT", "AMCUSDT", "AMDUSDT", "AMZNUSDT",
"ANETUSDT", "ANTHROPICUSDT", "APLDUSDT", "APPUSDT", "ARMUSDT", "ASMLUSDT",
"ASTSUSDT", "AVGOUSDT", "AXTIUSDT", "BABAUSDT", "BBXUSDT", "BEUSDT",
"BITOUSDT", "BMNRUSDT", "BNCUSDT", "BOTUSDT", "BRKBUSDT", "BSPUSDT",
"BTCDOMUSDT", "BWETUSDT", "BXUSDT", "BYDUSDT", "BZUSDT", "CATUSDT",
"CBRSUSDT", "CIENUSDT", "CLUSDT", "COHRUSDT", "COINUSDT", "COPPERUSDT",
"COSTUSDT", "CRCLUSDT", "CRDOUSDT", "CRMLUSDT", "CRMUSDT", "CRWDUSDT",
"CRWVUSDT", "CSCOUSDT", "CSOPSAMSUNG2LUSDT", "CSOPSKHYNIX2LUSDT", "CVNAUSDT",
"CXMTUSDT", "CYPHUSDT", "DDOGUSDT", "DEFIUSDT", "DELLUSDT", "DISUSDT",
"DJTUSDT", "DKNGUSDT", "DRAMUSDT", "EBAYUSDT", "EWJUSDT", "EWTUSDT",
"EWYUSDT", "EWZUSDT", "FLEXUSDT", "FLNCUSDT", "FWDIUSDT", "GDXUSDT",
"GEVUSDT", "GIGADEVUSDT", "GLWUSDT", "GMEUSDT", "GOOGLUSDT", "GPROUSDT",
"GSUSDT", "GTLBUSDT", "HANMIUSDT", "HDUSDT", "HIMSUSDT", "HK0625USDT",
"HK0700USDT", "HK0992USDT", "HK1810USDT", "HOODUSDT", "HPEUSDT", "HUTUSDT",
"HYUNDAIUSDT", "IBMUSDT", "INTCUSDT", "INTWUSDT", "IONQUSDT", "IRENUSDT",
"IWMUSDT", "JPMUSDT", "KLACUSDT", "KODEX200USDT", "KORUUSDT", "KOUSDT",
"KSTRUSDT", "KUAISHOUUSDT", "LGELECTRONICSUSDT", "LITEUSDT", "LLYUSDT",
"LRCXUSDT", "LYTEUSDT", "MARAUSDT", "MCDUSDT", "MDBUSDT", "MEITUANUSDT",
"METAUSDT", "MINIMAXUSDT", "MOONSHOTUSDT", "MPUSDT", "MRKUSDT", "MRNAUSDT",
"MRVLUSDT", "MSFTUSDT", "MSTRUSDT", "MUUSDT", "MUUUSDT", "MVLLUSDT",
"NATGASUSDT", "NAVERUSDT", "NBISUSDT", "NETUSDT", "NFLXUSDT", "NKEUSDT",
"NOKUSDT", "NOWUSDT", "NVDAUSDT", "NVDLUSDT", "NVOUSDT", "OKLOUSDT",
"ONDSUSDT", "OPENAIUSDT", "ORCLUSDT", "OURAUSDT", "PANWUSDT", "PATHUSDT",
"PAYPUSDT", "PDDUSDT", "PENGUSDT", "PLTRUSDT", "POPMARTUSDT", "PYPLUSDT",
"QCOMUSDT", "QNTXUSDT", "QQQUSDT", "RAMUSDT", "RDDTUSDT", "RIVNUSDT",
"RKLBUSDT", "RUMUSDT", "SAMSUNGEMUSDT", "SAMSUNGUSDT", "SECZUSDT", "SHAZUSDT",
"SHOPUSDT", "SKDDUSDT", "SKHYNIXUSDT", "SKHYUSDT", "SKUUUSDT", "SMCIUSDT",
"SMHUSDT", "SNDKUSDT", "SNOWUSDT", "SNXXUSDT", "SOFIUSDT", "SONYUSDT",
"SOXLUSDT", "SOXSUSDT", "SPCXUSDT", "SPYUSDT", "SQQQUSDT", "STRCUSDT",
"STXXUSDT", "TBTUSDT", "TEAMUSDT", "TEMUSDT", "TENCENTUSDT", "TERUSDT",
"TMFUSDT", "TQQQUSDT", "TSLAUSDT", "TSLLUSDT", "TSMUSDT", "TTWOUSDT",
"TWSTUSDT", "TXNUSDT", "TZAUSDT", "UBERUSDT", "UNHUSDT", "UNITREEUSDT",
"URNMUSDT", "USARUSDT", "USDBRLUSDT", "USDEXUSDT", "UVXYUSDT", "VKTXUSDT",
"VRTUSDT", "VSTUSDT", "VUSDT", "WDCUSDT", "WENUSDT", "WMTUSDT", "XAGUSDT",
"XAUUSDT", "XBIUSDT", "XLEUSDT", "XOMUSDT", "XPDUSDT", "XPTUSDT", "ZHIPUUSDT",
"ZHONGJIUSDT", "ZMUSDT", "ZSUSDT"
]);

/** Composite index perps — not a single asset. */
export const INDEX_BASES = ["BTCDOM", "DEFI"];

const EXCLUDED = new Set([...MOMENTUM_BASES, ...STABLE_BASES, ...WRAPPED_BASES, ...INDEX_BASES]);

/** Strip Binance quantity-multiplier prefixes: 1000SHIB → SHIB, 1000000MOG → MOG, 1MBABYDOGE → BABYDOGE. */
export function stripMultiplier(base: string): string {
  return base.replace(/^(1000000|10000|1000|1M)/, "");
}

/** Base asset of a USDT-M perp symbol ("1000SHIBUSDT" → "SHIB"). */
export function baseAsset(symbol: string): string {
  return stripMultiplier(symbol.replace(/USDT$/, ""));
}

/** True for symbols the line may trade: USDT-quoted perp (no delivery-date
 *  suffix) whose base is not excluded. */
export function isEligibleSymbol(symbol: string): boolean {
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false; // USDT-margined, no _YYMMDD delivery suffix
  if (NON_CRYPTO_SYMBOLS.has(symbol)) return false; // tokenized TradFi / index perps
  return !EXCLUDED.has(baseAsset(symbol));
}

export interface MembershipParams {
  topN: number;
  /** Calendar days of daily bars the volume rank looks back over. */
  volLookbackDays: number;
  /** Minimum daily bars inside the lookback for a symbol to be rankable. */
  minDays: number;
  /** Last daily bar must open within this many days of the month start. */
  freshDays: number;
}

export const DEFAULT_MEMBERSHIP: MembershipParams = {
  topN: 30,
  volLookbackDays: 30,
  minDays: 20,
  freshDays: 3,
};

export interface MonthMembership {
  /** "YYYY-MM" (UTC month the membership applies to). */
  month: string;
  /** Month start, epoch ms UTC. */
  startMs: number;
  /** Top-N symbols, rank order (highest mean quoted volume first). */
  symbols: string[];
}

/** First day (ms) of the UTC month containing `ms`. */
export function monthStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function nextMonthStartMs(ms: number): number {
  const d = new Date(monthStartMs(ms));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * Compute the PIT monthly membership over [fromMs, toMs] from the research
 * DB's 1d quoted volumes (table quote_volume_1d, populated from the same
 * data.binance.vision daily klines as historical_bars/1d).
 *
 * Deterministic: mean quoted volume desc, ties by symbol asc.
 */
export function computeMonthlyMembership(
  db: Database,
  fromMs: number,
  toMs: number,
  p: MembershipParams = DEFAULT_MEMBERSHIP,
): MonthMembership[] {
  const out: MonthMembership[] = [];
  const stmt = db.prepare(`
    SELECT symbol, COUNT(*) AS n, AVG(quote_volume) AS qv, MAX(timestamp) AS last
    FROM quote_volume_1d
    WHERE timestamp >= ?1 AND timestamp < ?2
    GROUP BY symbol
  `);
  for (let t = monthStartMs(fromMs); t <= toMs; t = nextMonthStartMs(t)) {
    const lookFrom = t - p.volLookbackDays * 86_400_000;
    const rows = stmt.all(lookFrom, t) as Array<{ symbol: string; n: number; qv: number; last: number }>;
    const ranked = rows
      .filter(r => isEligibleSymbol(r.symbol))
      .filter(r => r.n >= p.minDays)
      .filter(r => r.last >= t - p.freshDays * 86_400_000)
      .sort((a, b) => (b.qv !== a.qv ? b.qv - a.qv : a.symbol.localeCompare(b.symbol)))
      .slice(0, p.topN);
    out.push({ month: monthKey(t), startMs: t, symbols: ranked.map(r => r.symbol) });
  }
  return out;
}
