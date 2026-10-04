// ══════════════════════════════════════════════
// AlpacaFetcher — historical stock/ETF OHLCV bars from Alpaca's Market Data
// v2 API (the SAME source the live bot scans, so backtests match production).
//
// Endpoint: {dataUrl}/v2/stocks/bars?symbols=...&timeframe=5Min&start=...&end=...
// Auth:     APCA-API-KEY-ID / APCA-API-SECRET-KEY (paper keys work; IEX feed).
// Paged via next_page_token; Alpaca caps ~10k bars/response.
// ══════════════════════════════════════════════

import { TokenBucket } from "./RateLimiter";
import type { BarRow, Timeframe } from "../HistoricalStore";
import { config } from "../../config";
import { fetchT } from "../../utils/timeout";

const limiter = new TokenBucket(20, 5, "alpaca-data"); // polite; Alpaca allows 200/min
type FetchFn = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

const TF_MAP: Record<Timeframe, string | null> = {
  "1m": "1Min", "5m": "5Min", "15m": "15Min", "1h": "1Hour", "4h": null, "1d": "1Day",
};

/**
 * Fetch stock bars in [fromMs, toMs]. Returns oldest→newest. Free IEX feed by
 * default (set ALPACA_DATA_FEED=sip if the account has the subscription).
 */
export async function fetchAlpacaStockBars(
  symbol: string, timeframe: Timeframe, fromMs: number, toMs: number,
  // F4a: oauthToken/dataUrl are injectable so registry-mode callers can pass
  // the runtime account's credentials; the defaults stay config/.env — the
  // research/cron scripts that call this keep today's behavior untouched.
  opts: { fetchFn?: FetchFn; keyId?: string; secretKey?: string; oauthToken?: string; dataUrl?: string; maxPages?: number } = {},
): Promise<BarRow[]> {
  const tf = TF_MAP[timeframe];
  if (!tf) throw new Error(`AlpacaFetcher: unsupported timeframe ${timeframe}`);
  const keyId = opts.keyId ?? config.alpaca.keyId;
  const secretKey = opts.secretKey ?? config.alpaca.secretKey;
  if (!opts.oauthToken && (!keyId || !secretKey)) throw new Error("AlpacaFetcher: no Alpaca keys");
  const dataUrl = opts.dataUrl ?? config.alpaca.dataUrl;
  const authHeaders: Record<string, string> = opts.oauthToken
    ? { Authorization: `Bearer ${opts.oauthToken}` }
    : { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey };
  const fetchFn = opts.fetchFn ?? fetchT;

  const feed = process.env.ALPACA_DATA_FEED || "iex";
  const start = new Date(fromMs).toISOString();
  const end = new Date(toMs).toISOString();
  const out: BarRow[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < (opts.maxPages ?? 500); page++) { // hard stop; each page ≤10k bars
    await limiter.take();
    const params = new URLSearchParams({
      symbols: symbol, timeframe: tf, start, end, limit: "10000", adjustment: "split", feed,
    });
    if (pageToken) params.set("page_token", pageToken);
    const url = `${dataUrl}/v2/stocks/bars?${params}`;
    const resp = await fetchFn(url, {
      headers: authHeaders,
    }, 30_000);
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 160);
      throw new Error(`${resp.status} ${resp.statusText}: ${body}`);
    }
    const data = await resp.json() as any;
    const bars = data.bars?.[symbol] || [];
    for (const b of bars) {
      out.push({ symbol, timeframe, timestamp: new Date(b.t).getTime(), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, source: "alpaca_split" });
    }
    pageToken = data.next_page_token || undefined;
    if (!pageToken) return out;
  }
  throw new Error(`${symbol}: pagination incomplete after ${opts.maxPages ?? 500} pages`);
}
