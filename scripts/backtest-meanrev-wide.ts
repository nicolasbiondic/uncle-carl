#!/usr/bin/env bun
/**
 * Wide-universe walk-forward: daily mean-reversion (Connors RSI2) longs.
 * Same rules as scripts/backtest-meanrev.ts but:
 *   - universe = all source='alpaca_wide' symbols with >1500 daily bars,
 *     MINUS the momentum sleeve symbols (SPY,QQQ,IWM,GLD,AAPL,MSFT,NVDA,META,GOOGL,AMZN)
 *   - ENTRY_RSI = 5
 *   - two sizing variants: (a) max 5 × 10% slots, (b) max 20 × 5% slots
 *
 * Usage: bun run scripts/backtest-meanrev-wide.ts
 */
import { Database } from "bun:sqlite";
import { MOMENTUM_SYMBOLS } from "./download-stock-dailies";

const SLIP = 0.0002;
const ENTRY_RSI = 5;
const SL_PCT = 0.04;
const TIME_STOP_DAYS = 10;
const INITIAL = 100_000;

interface Bar { open: number; high: number; low: number; close: number; timestamp: number }

const h = new Database("./data/historical.db", { readonly: true });
const symbols = (h.query(
  `SELECT symbol, COUNT(*) n FROM historical_bars
   WHERE timeframe='1d' AND source='alpaca_wide' GROUP BY symbol HAVING n > 1500`,
).all() as any[]).map(r => r.symbol as string).filter(s => !MOMENTUM_SYMBOLS.has(s));

interface Series { bars: Bar[]; rsi2: Float64Array; sma5: Float64Array; sma200: Float64Array; idx: Map<number, number> }
const series = new Map<string, Series>();
for (const s of symbols) {
  const bars = h.prepare(
    `SELECT open, high, low, close, timestamp FROM historical_bars
     WHERE symbol=? AND timeframe='1d' AND source='alpaca_wide' ORDER BY timestamp ASC`,
  ).all(s) as Bar[];
  const n = bars.length;
  const rsi2 = new Float64Array(n).fill(NaN);
  const sma5 = new Float64Array(n).fill(NaN);
  const sma200 = new Float64Array(n).fill(NaN);
  const pref = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + bars[i].close;
  for (let i = 0; i < n; i++) {
    if (i >= 4) sma5[i] = (pref[i + 1] - pref[i - 4]) / 5;
    if (i >= 199) sma200[i] = (pref[i + 1] - pref[i - 199]) / 200;
    if (i >= 2) {
      const d1 = bars[i - 1].close - bars[i - 2].close;
      const d2 = bars[i].close - bars[i - 1].close;
      const g = (Math.max(d1, 0) + Math.max(d2, 0)) / 2;
      const l = (Math.max(-d1, 0) + Math.max(-d2, 0)) / 2;
      rsi2[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  const idx = new Map<number, number>();
  bars.forEach((b, i) => idx.set(b.timestamp, i));
  series.set(s, { bars, rsi2, sma5, sma200, idx });
}

// unified timeline from SPY (full coverage; SPY itself is not traded)
const timeline = (h.prepare(
  `SELECT timestamp FROM historical_bars WHERE symbol='SPY' AND timeframe='1d' AND source='alpaca_wide' ORDER BY timestamp ASC`,
).all() as any[]).map(r => r.timestamp as number);

interface Pos { symbol: string; qty: number; entry: number; entryDay: number }

function run(fromStr: string, toStr: string, maxPos: number, slotPct: number) {
  const fromMs = Date.parse(fromStr), toMs = Date.parse(toStr);
  let cash = INITIAL;
  const open: Pos[] = [];
  const closed: Array<{ pnl: number; reason: string }> = [];
  let peak = INITIAL, maxDd = 0;
  const eqCurve: number[] = [];

  const startTi = timeline.findIndex(t => t >= fromMs);
  const days = timeline.filter(t => t >= fromMs && t < toMs);
  for (let di = 0; di < days.length; di++) {
    const t = days[di];
    const prevT = timeline[startTi + di - 1];
    if (prevT === undefined) continue;

    // EXITS (signal at prev close, fill at today's open)
    for (const p of [...open]) {
      const sv = series.get(p.symbol)!;
      const iPrev = sv.idx.get(prevT), iNow = sv.idx.get(t);
      if (iPrev === undefined || iNow === undefined) continue;
      const exitSig = sv.bars[iPrev].close > sv.sma5[iPrev] || (di - p.entryDay) >= TIME_STOP_DAYS;
      if (exitSig) {
        const px = sv.bars[iNow].open * (1 - SLIP);
        cash += (px - p.entry) * p.qty;
        closed.push({ pnl: (px - p.entry) * p.qty, reason: "exit" });
        open.splice(open.indexOf(p), 1);
      }
    }
    // SL on today's low
    for (const p of [...open]) {
      const sv = series.get(p.symbol)!, iNow = sv.idx.get(t);
      if (iNow === undefined) continue;
      const slPx = p.entry * (1 - SL_PCT);
      if (sv.bars[iNow].low <= slPx) {
        cash += (slPx * (1 - SLIP) - p.entry) * p.qty;
        closed.push({ pnl: (slPx * (1 - SLIP) - p.entry) * p.qty, reason: "SL" });
        open.splice(open.indexOf(p), 1);
      }
    }

    // ENTRIES from yesterday's close signals
    let equity = cash;
    for (const p of open) {
      const iNow = series.get(p.symbol)!.idx.get(t);
      if (iNow !== undefined) equity += (series.get(p.symbol)!.bars[iNow].close - p.entry) * p.qty;
    }
    if (open.length < maxPos) {
      const cands: Array<{ symbol: string; rsi: number }> = [];
      for (const s of symbols) {
        if (open.some(p => p.symbol === s)) continue;
        const sv = series.get(s)!, iPrev = sv.idx.get(prevT);
        if (iPrev === undefined || iPrev < 200) continue;
        const r = sv.rsi2[iPrev];
        if (r < ENTRY_RSI && sv.bars[iPrev].close > sv.sma200[iPrev]) cands.push({ symbol: s, rsi: r });
      }
      cands.sort((a, b) => a.rsi - b.rsi);
      for (const c of cands.slice(0, maxPos - open.length)) {
        const sv = series.get(c.symbol)!, iNow = sv.idx.get(t);
        if (iNow === undefined) continue;
        const px = sv.bars[iNow].open * (1 + SLIP);
        const qty = Math.floor((equity * slotPct) / px);
        if (qty <= 0) continue;
        open.push({ symbol: c.symbol, qty, entry: px, entryDay: di });
      }
    }

    let eq = cash;
    for (const p of open) {
      const sv = series.get(p.symbol)!, iNow = sv.idx.get(t);
      if (iNow !== undefined) eq += (sv.bars[iNow].close - p.entry) * p.qty;
    }
    eqCurve.push(eq);
    if (eq > peak) peak = eq;
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }

  // liquidate at last close
  const lastT = days[days.length - 1];
  for (const p of open) {
    const sv = series.get(p.symbol)!, iNow = sv.idx.get(lastT);
    const px = iNow !== undefined ? sv.bars[iNow].close : p.entry;
    cash += (px - p.entry) * p.qty;
    closed.push({ pnl: (px - p.entry) * p.qty, reason: "end" });
  }

  const trades = closed.filter(c => c.reason !== "end");
  const wins = trades.filter(c => c.pnl > 0).length;
  const rets: number[] = [];
  for (let i = 1; i < eqCurve.length; i++) if (eqCurve[i - 1] > 0) rets.push(eqCurve[i] / eqCurve[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  return {
    window: `${fromStr}→${toStr}`,
    trades: trades.length,
    perDay: +(trades.length / Math.max(1, days.length)).toFixed(2),
    wr: +(100 * wins / Math.max(1, trades.length)).toFixed(0),
    ret: +((cash - INITIAL) / INITIAL * 100).toFixed(1),
    maxDd: +(maxDd * 100).toFixed(1),
    sharpe: +(sd > 0 ? (mean / sd) * Math.sqrt(252) : 0).toFixed(2),
    exp: +(trades.reduce((s, c) => s + c.pnl, 0) / Math.max(1, trades.length)).toFixed(2),
  };
}

const WINDOWS = [
  ["2019-01-01", "2021-01-01"],
  ["2021-01-01", "2023-01-01"],
  ["2023-01-01", "2024-01-01"],
  ["2024-01-01", "2025-01-01"],
  ["2025-01-01", "2026-01-01"],
  ["2026-01-01", "2026-07-10"],
] as const;

console.log(`universe: ${symbols.length} symbols | RSI2<${ENTRY_RSI} + >SMA200 | exit >SMA5 or ${TIME_STOP_DAYS}d | SL ${SL_PCT * 100}%\n`);
for (const [maxPos, slotPct] of [[5, 0.10], [20, 0.05]] as const) {
  console.log(`--- variant: max ${maxPos} × ${slotPct * 100}% slots ---`);
  for (const [f, t] of WINDOWS) console.log(JSON.stringify(run(f, t, maxPos, slotPct)));
}
