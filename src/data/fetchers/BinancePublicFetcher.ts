// ══════════════════════════════════════════════
// BinancePublicFetcher — pulls historical klines from the public Binance
// USD-M Futures REST endpoint (no auth required). This is the same venue and
// contract family used by the live momentum sleeve.
//
// Endpoint: https://fapi.binance.com/fapi/v1/klines
// ══════════════════════════════════════════════

import { TokenBucket } from "./RateLimiter";
import type { BarRow, Timeframe } from "../HistoricalStore";
import { createLogger } from "../../utils/logger";

const log = createLogger("BinancePublicFetcher");

// Generous compared to the actual 1200/min cap — we're being a good citizen.
const limiter = new TokenBucket(20, 10, "binance-public");

const TF_MAP: Record<Timeframe, string | null> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

/** Convert internal symbol like "BTC/USD" → Binance "BTCUSDT". */
export function toBinanceSymbol(internal: string): string | null {
  if (!internal.includes("/")) return null;
  const [base, quote] = internal.split("/");
  if (!base || !quote) return null;
  // Binance uses USDT (not USD) for crypto pairs.
  const q = quote.toUpperCase() === "USD" ? "USDT" : quote.toUpperCase();
  return `${base.toUpperCase()}${q}`;
}

const BASE = "https://fapi.binance.com/fapi/v1/klines";

/** Fetch up to 1000 klines per call. */
async function fetchPage(
  binanceSymbol: string,
  interval: string,
  startMs: number,
  endMs: number,
): Promise<any[]> {
  await limiter.take();
  const url = `${BASE}?symbol=${binanceSymbol}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Binance ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json() as any[];
}

/**
 * Convert one raw Binance kline row to a BarRow, or null if it's still
 * forming (its closeTime hasn't passed `nowMs` yet). Never persist an
 * incomplete kline — the last row of a page is frequently the currently-
 * open candle when `toMs` reaches into the present.
 * klines format: [openTime, open, high, low, close, volume, closeTime, ...]
 */
export function parseKline(
  k: any[],
  internalSymbol: string,
  timeframe: Timeframe,
  nowMs: number = Date.now(),
): BarRow | null {
  const closeTime = Number(k[6]);
  if (closeTime >= nowMs) return null;
  return {
    symbol: internalSymbol,
    timeframe,
    timestamp: Number(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    source: "binance_futures",
  };
}

/**
 * Fetch all klines for [fromMs, toMs] inclusive. Pages internally to
 * cover ranges larger than 1000 bars.
 */
export async function fetchBars(
  internalSymbol: string,
  timeframe: Timeframe,
  fromMs: number,
  toMs: number,
): Promise<BarRow[]> {
  const bin = toBinanceSymbol(internalSymbol);
  if (!bin) throw new Error(`Cannot convert symbol "${internalSymbol}" to Binance format`);
  const interval = TF_MAP[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);

  const nowMs = Date.now();
  const out: BarRow[] = [];
  let cursor = fromMs;
  while (cursor <= toMs) {
    const page = await fetchPage(bin, interval, cursor, toMs);
    if (!page.length) break;
    for (const k of page) {
      const bar = parseKline(k, internalSymbol, timeframe, nowMs);
      if (bar) out.push(bar); // still-forming candles are silently dropped
    }
    const lastTs = Number(page[page.length - 1][0]);
    if (page.length < 1000) break;          // exhausted
    if (lastTs <= cursor) break;             // safety: no progress
    cursor = lastTs + 1;
    log.debug(`${bin} ${interval}: ${out.length} bars accumulated, cursor=${new Date(cursor).toISOString()}`);
  }
  return out;
}
