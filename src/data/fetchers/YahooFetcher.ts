// ══════════════════════════════════════════════
// YahooFetcher — historical bars via the public Yahoo Finance chart API.
// No auth, generous rate limits. Coverage: most US tickers, ETFs, indices,
// and ^VIX, going back to inception (SPY: 1993).
//
// Endpoint: https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
//   ?period1={epochSec}&period2={epochSec}&interval={1d|1h|5m}
//
// Pivot rationale: FMP free tier deprecated 30y daily on 2025-08-31,
// AlphaVantage free tier paywalled `outputsize=full` and capped at
// 25 calls/day. Yahoo remains the only free, multi-decade source.
// ══════════════════════════════════════════════

import { TokenBucket } from "./RateLimiter";
import type { BarRow, Timeframe } from "../HistoricalStore";
import { createLogger } from "../../utils/logger";

const log = createLogger("YahooFetcher");

// Be a good citizen: 4 req/sec is plenty.
const limiter = new TokenBucket(8, 4, "yahoo");

const TF_MAP: Record<Timeframe, string | null> = {
  "1m": "1m",       // last ~7d only
  "5m": "5m",       // last ~60d only
  "15m": "15m",     // last ~60d only
  "1h": "1h",       // last ~730d only
  "4h": null,       // not supported by Yahoo; resample 1h locally if needed
  "1d": "1d",       // full history
};

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

async function fetchOne(url: string): Promise<any> {
  await limiter.take();
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (uncle-carl backfill)" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Yahoo ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}

/**
 * Fetch bars for [fromMs, toMs]. For 1d timeframe Yahoo will return the
 * full history if fromMs predates the symbol's inception. For intraday
 * timeframes Yahoo silently caps the lookback (1h ≈ 2y, 5m ≈ 60d).
 */
export async function fetchBars(
  symbol: string,
  timeframe: Timeframe,
  fromMs: number,
  toMs: number,
): Promise<BarRow[]> {
  const interval = TF_MAP[timeframe];
  if (!interval) throw new Error(`Yahoo doesn't support timeframe ${timeframe}`);

  const p1 = Math.floor(fromMs / 1000);
  const p2 = Math.floor(toMs / 1000);
  const url = `${BASE}/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=${interval}`;
  const data = await fetchOne(url);

  const result = data?.chart?.result?.[0];
  if (!result) {
    const err = data?.chart?.error?.description;
    throw new Error(`Yahoo no result for ${symbol}: ${err ?? "empty response"}`);
  }
  const ts: number[] = result.timestamp ?? [];
  const ohlc = result.indicators?.quote?.[0] ?? {};
  const opens = ohlc.open ?? [];
  const highs = ohlc.high ?? [];
  const lows  = ohlc.low ?? [];
  const closes = ohlc.close ?? [];
  const volumes = ohlc.volume ?? [];

  const out: BarRow[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i], v = volumes[i];
    if (!Number.isFinite(c) || c <= 0) continue;
    out.push({
      symbol,
      timeframe,
      timestamp: t * 1000,
      open: o, high: h, low: l, close: c,
      volume: v ?? 0,
      source: "yahoo",
    });
  }
  log.info(`Yahoo ${symbol} ${timeframe}: ${out.length} bars`);
  return out;
}
