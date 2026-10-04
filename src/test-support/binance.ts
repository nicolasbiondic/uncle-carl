// Test-support: Binance executor fixtures (FAPI linear + COIN-M inverse).
// TEST-ONLY. Fixture-driven: every test overrides the PRIVATE network seams
// (signedRequest / fetchExchangeInfoRaw / getServerTimeRaw / fetchMarkPriceRaw)
// on the instance — no live calls, catalogs pre-seeded (never fetch).
import { BinanceExecutor, type BinanceExecutorOptions } from "../executor/binance-executor";
import { BinanceCoinMExecutor } from "../executor/binance-coinm-executor";
import { InstrumentCatalog, type InstrumentSpec } from "../executor/binance/instrumentSpec";

/** Instrument spec fixture mirroring the exact old hardcoded QTY_PRECISION/
 *  PRICE_PRECISION tables for BTCUSDT (step 0.001, tick 0.1) — the default
 *  test catalog seeds this so every pre-existing test keeps its exact old
 *  rounding behavior with ZERO network calls. */
export function makeSpec(symbol: string, over: Partial<InstrumentSpec> = {}): InstrumentSpec {
  return {
    symbol, status: "TRADING", contractType: "PERPETUAL", marginAsset: "USDT",
    tickSize: 0.1, minPrice: 0, maxPrice: 0,
    stepSize: 0.001, minQty: 0.001, maxQty: 1000,
    marketStepSize: 0.001, marketMinQty: 0.001, marketMaxQty: 1000,
    minNotional: null,
    ...over,
  };
}

export function defaultCatalog(specs: InstrumentSpec[] = [makeSpec("BTCUSDT")]): InstrumentCatalog {
  const catalog = new InstrumentCatalog(async () => { throw new Error("no network in tests"); });
  catalog.seed(specs);
  return catalog;
}

/** Connected FAPI executor with pure fakes on every network seam; pass only
 *  the seams the test exercises. */
export function fakeBinanceExecutor(overrides: Partial<Record<"signedRequest" | "getUsdRate" | "getExecutableQuote", any>> & { instrumentCatalog?: InstrumentCatalog; options?: BinanceExecutorOptions } = {}): BinanceExecutor {
  const exec = new BinanceExecutor(overrides.options) as any;
  exec.connected = true;
  exec.getUsdRate = overrides.getUsdRate ?? (async () => 0);
  exec.getExecutableQuote = overrides.getExecutableQuote ?? (async () => null);
  exec.catalog = overrides.instrumentCatalog ?? defaultCatalog();
  if (overrides.signedRequest) exec.signedRequest = overrides.signedRequest;
  return exec as BinanceExecutor;
}

/** DAPI exchangeInfo payload for the two COIN-M perpetuals the suite uses. */
export const COINM_EXCHANGE_INFO_FIXTURE = {
  symbols: [
    {
      symbol: "BTCUSD_PERP",
      status: "TRADING",
      contractType: "PERPETUAL",
      marginAsset: "BTC",
      contractSize: 100,
      pricePrecision: 1,
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.1", minPrice: "0", maxPrice: "1000000" },
        { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "1000000" },
        { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "50000" },
      ],
    },
    {
      symbol: "ETHUSD_PERP",
      status: "TRADING",
      contractType: "PERPETUAL",
      marginAsset: "ETH",
      contractSize: 10,
      pricePrecision: 2,
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01" },
        { filterType: "LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "100000" },
        { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "10000" },
      ],
    },
  ],
};

/** Connected COIN-M executor (fast poll/timeout knobs); instance-level
 *  overrides applied verbatim — pass `connected: false` or any private seam
 *  (signedRequest / fetchExchangeInfoRaw / getServerTimeRaw /
 *  fetchMarkPriceRaw) as needed. */
export function fakeCoinMExecutor(overrides: Record<string, any> = {}): BinanceCoinMExecutor {
  const exec = new BinanceCoinMExecutor({ apiKey: "k", secretKey: "s", pollDelayMs: 2, fillTimeoutMs: 60, closeTimeoutMs: 60 }) as any;
  exec.connected = true;
  Object.assign(exec, overrides);
  return exec as BinanceCoinMExecutor;
}
