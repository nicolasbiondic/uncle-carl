// ══════════════════════════════════════════════
// Binance USDⓈ-M public klines → OHLCV (2026-07-05)
//
// WHY: signal candles come from Alpaca's crypto feed, which does not list
// BNB/ATOM/NEAR/TRX at all and serves LTC/BCH/UNI sparsely (~16 bars/day —
// a 200-bar request spans ~12 days of irregular data, useless for 5-min
// indicators). That silently shrank the 24/7 crypto universe from 11 to ~4
// dense symbols. Binance klines are PUBLIC (no auth, weight 2/call —
// 7-11 calls per 5-min scan is nothing) and are the venue we actually
// execute crypto on.
//
// Used as a FALLBACK in scanAllAccounts: only when the Alpaca series is
// too sparse to be honest 5-min data. Kill switch: BINANCE_KLINES=false.
// ══════════════════════════════════════════════

import { createLogger } from "../utils/logger";
import { SYMBOL_MAP } from "../executor/binance-executor";
import { USDC_SYMBOL_MAP, type QuoteAsset } from "../executor/binance/quoteAsset";
import { dataIntegrityEnabled, validateCandleSeries, warnThrottled } from "./dataIntegrity";
import type { OHLCV } from "../utils/types";

const log = createLogger("BinanceKlines");

// Prod market data (real prices; testnet klines are sparse/synthetic).
const BASE = process.env.BINANCE_KLINES_URL || "https://fapi.binance.com";
const ENABLED = (process.env.BINANCE_KLINES ?? "true").toLowerCase() !== "false";

const TF_MAP: Record<string, string> = { "1Min": "1m", "5Min": "5m", "15Min": "15m", "1Hour": "1h", "1Day": "1d" };

export function binanceKlinesEnabled(): boolean { return ENABLED; }

/** Pure mapper (tested): raw Binance kline rows → OHLCV[]. Drops the
 *  still-forming bar (closeTime in the future) so indicators only ever see
 *  CLOSED bars — same no-lookahead discipline the shuffle-prefix audit
 *  enforces on SignalAggregator. */
export function klinesToOHLCV(raw: unknown, nowMs = Date.now()): OHLCV[] {
  if (!Array.isArray(raw)) return [];
  const out: OHLCV[] = [];
  for (const k of raw) {
    if (!Array.isArray(k) || k.length < 7) continue;
    if (Number(k[6]) > nowMs) continue; // partial current bar
    const c = { timestamp: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) };
    if (!Number.isFinite(c.timestamp) || !Number.isFinite(c.close) || c.close <= 0) continue;
    out.push(c);
  }
  return out;
}

const INTERVAL_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000 };

/** Live-path integrity gate (2026-07-29) — the backtest validator throws on
 *  gapped/inverted series, the live path validated NOTHING. Out-of-order or
 *  duplicate bars are physically impossible from the exchange (corrupted
 *  merge/response) → reject to [] so the caller uses its own fallback, same
 *  contract as every other failure here. A GAP only warns (throttled): these
 *  are 24/7 perps so a hole is anomalous, but rejecting a gapped series would
 *  fall back to Alpaca's SPARSER data — strictly worse than keeping it. */
function integrityChecked(symbol: string, interval: string, bars: OHLCV[]): OHLCV[] {
  const intervalMs = INTERVAL_MS[interval];
  if (!dataIntegrityEnabled() || !intervalMs || bars.length < 2) return bars;
  const issues = validateCandleSeries(bars, intervalMs);
  const fatal = issues.filter(i => i.kind !== "gap");
  if (fatal.length > 0) {
    warnThrottled(`klines_order_${symbol}`, `klines ${symbol} ${interval}: ${fatal.length} out-of-order/duplicate bar(s) — physically impossible, series rejected (caller falls back)`);
    return [];
  }
  if (issues.length > 0) {
    warnThrottled(`klines_gap_${symbol}`, `klines ${symbol} ${interval}: ${issues.length} gap(s) of ≥2 bars in ${bars.length}-bar series — kept (fallback data is sparser), indicators may be skewed`);
  }
  return bars;
}

const BINANCE_MAX_PER_REQ = 1500; // fapi klines hard cap; larger `limit` needs paging

async function fetchOneKlinePage(binanceSymbol: string, interval: string, limit: number, endTime?: number): Promise<any[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4_000);
  try {
    let url = `${BASE}/fapi/v1/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  } finally { clearTimeout(t); }
}

/** Fetch klines for an internal symbol ("BNB/USD"). Returns [] on any failure (fail-open to Alpaca bars).
 *  Pages backwards when `limit` exceeds Binance's 1500/request cap (e.g. the
 *  pairs engine's 90d of 1h bars = 2210) so callers actually get what they ask for.
 *  `quoteAsset` picks the NATIVE symbol identity (2026-07-19): default USDT
 *  (existing "BNB/USD" -> "BNBUSDT" behavior, unchanged) or USDC ("BNB/USDC"
 *  -> "BNBUSDC") for the momentum_crypto_usdc sleeve. Never a USDT proxy for a
 *  USDC symbol — an unmapped internal symbol returns [] (fail-closed to the
 *  caller's own fallback), it is never re-resolved against the wrong map. */
export async function fetchBinanceKlines(symbol: string, timeframe = "5Min", limit = 200, quoteAsset: QuoteAsset = "USDT"): Promise<OHLCV[]> {
  if (!ENABLED) return [];
  const binanceSymbol = quoteAsset === "USDC" ? (USDC_SYMBOL_MAP[symbol] ?? null) : (SYMBOL_MAP[symbol] ?? null);
  if (!binanceSymbol) return [];
  const interval = TF_MAP[timeframe] ?? "5m";
  try {
    if (limit <= BINANCE_MAX_PER_REQ) {
      return integrityChecked(symbol, interval, klinesToOHLCV(await fetchOneKlinePage(binanceSymbol, interval, limit)));
    }
    // Page back by endTime until we have `limit` bars or history runs out.
    const byOpen = new Map<number, any[]>();
    let endTime: number | undefined = undefined;
    const maxPages = Math.ceil(limit / BINANCE_MAX_PER_REQ) + 1;
    for (let p = 0; p < maxPages && byOpen.size < limit; p++) {
      const page: any[] = await fetchOneKlinePage(binanceSymbol, interval, BINANCE_MAX_PER_REQ, endTime);
      if (page.length === 0) break;
      for (const k of page) byOpen.set(Number(k[0]), k);
      const earliest = Number(page[0][0]);
      if (!Number.isFinite(earliest)) break;
      endTime = earliest - 1; // next page ends just before the earliest bar we have
      if (page.length < BINANCE_MAX_PER_REQ) break; // exhausted history
    }
    const merged = [...byOpen.values()].sort((a, b) => Number(a[0]) - Number(b[0]));
    return integrityChecked(symbol, interval, klinesToOHLCV(merged).slice(-limit));
  } catch (e: any) {
    log.warn(`klines ${symbol} failed: ${e?.message ?? e}`);
    return [];
  }
}
