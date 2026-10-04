// Test-support: mean-reversion fixtures. TEST-ONLY.
import type { MeanRevBrokerAdapter, MeanRevPosition } from "../strategies/meanrev/MeanRevEngine";
import { insertTrade } from "../db/database";
import type { OHLCV } from "../utils/types";

export const DAY = 86_400_000;
/** Fri 2026-07-17 10:00 ET; the suite's deterministic "now". */
export const MEANREV_ANCHOR = Date.UTC(2026, 6, 17, 14, 0, 0);

/** Build a daily series from an array of closes, one bar per calendar day,
 *  ENDING YESTERDAY relative to MEANREV_ANCHOR (last completed bar).
 *  open=high=low=close for simplicity. */
export function daily(closes: number[]): OHLCV[] {
  const lastTs = MEANREV_ANCHOR - DAY;
  return closes.map((c, i) => ({
    open: c, high: c, low: c, close: c, volume: 1,
    timestamp: lastTs - (closes.length - 1 - i) * DAY,
  }));
}

/** 205 flat bars at `level`, then a tail. Keeps SMA200 ≈ level. */
export function flatThen(level: number, tail: number[]): number[] {
  return [...Array(205).fill(level), ...tail];
}

let testAccountNo = 0;

/** In-memory mean-rev broker adapter; each instance gets its own accountId
 *  so suites sharing the process DB never cross-contaminate. */
export class FakeAdapter implements MeanRevBrokerAdapter {
  candleStore = new Map<string, OHLCV[]>();
  positions: MeanRevPosition[] = [];
  opened: Array<{ symbol: string; side: string; notionalUsd: number; stopLossPct?: number }> = [];
  closed: Array<{ symbol: string; side: string }> = [];
  accountId = `test_meanrev_${++testAccountNo}`;
  /** Deliberately NOT RISK_PROFILES.meanrev_stocks.initialEquity (50k) or any
   *  other "round" account-aggregate-looking number — tests assert the risk
   *  gate consumes exactly this sleeve-scoped value. */
  equity = 12_345;
  realisedPnlSince: number | Error = 0;

  setCandles(symbol: string, candles: OHLCV[]) { this.candleStore.set(symbol, candles); }

  async getOpenPositions() { return this.positions.map((p) => ({ ...p })); }
  async getEquity() { return this.equity; }
  async getRealisedPnlSince(_epochMs: number) {
    if (this.realisedPnlSince instanceof Error) throw this.realisedPnlSince;
    return this.realisedPnlSince;
  }
  async openPosition(a: { symbol: string; side: "buy" | "sell"; notionalUsd: number }) {
    this.opened.push(a);
    insertTrade({
      id: `${this.accountId}-${this.opened.length}-${a.symbol}`,
      symbol: a.symbol, market: "stock", side: a.side, strategy: "MEANREV",
      entryPrice: 100, quantity: 1, entryTime: MEANREV_ANCHOR, status: "open",
    } as any, this.accountId);
    return { ok: true };
  }
  async closePosition(a: { symbol: string; side: "buy" | "sell" }) {
    this.closed.push(a);
    return { ok: true };
  }
  async fetchCandles(symbol: string, _bars: number) {
    return this.candleStore.get(symbol) ?? [];
  }
}
