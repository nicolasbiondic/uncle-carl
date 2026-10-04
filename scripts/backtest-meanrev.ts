#!/usr/bin/env bun
/** Production-config replay of the live daily mean-reversion sleeve. */

import { Database } from "bun:sqlite";
import { RISK_PROFILES } from "../src/config/riskProfiles";
import { getETDateKey } from "../src/db/database";
import {
  DEFAULT_MEANREV_CONFIG,
  MEANREV_UNIVERSE,
  rsi2,
  sma,
} from "../src/strategies/meanrev/MeanRevEngine";

const cfg = DEFAULT_MEANREV_CONFIG;
const SLIPPAGE = 2 / 10_000;
const STOP_PCT = RISK_PROFILES.meanrev_stocks.stopLossPct / 100;
const SLOT_USD = cfg.baseUsd * cfg.slotPct;

interface RawBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Bar extends RawBar { date: string }

interface Series {
  bars: Bar[];
  closes: number[];
  indexByDate: Map<string, number>;
}

interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryDay: number;
  mark: number;
}

interface ClosedTrade {
  pnl: number;
  reason: "SMA_EXIT" | "TIME_STOP" | "STOP_LOSS";
}

const db = new Database("./data/historical.db", { readonly: true });
const query = db.prepare(
  `SELECT timestamp, open, high, low, close
   FROM historical_bars
   WHERE symbol = ? AND timeframe = '1d' AND source = 'alpaca_wide'
   ORDER BY timestamp ASC`,
);

const series = new Map<string, Series>();
let duplicateDates = 0;
for (const symbol of MEANREV_UNIVERSE) {
  const byDate = new Map<string, Bar>();
  for (const row of query.all(symbol) as RawBar[]) {
    const date = getETDateKey(row.timestamp);
    if (byDate.has(date)) duplicateDates++;
    byDate.set(date, { ...row, date }); // latest timestamp wins for a duplicate trading date
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length === 0) throw new Error(`No alpaca_wide daily bars for ${symbol}`);
  series.set(symbol, {
    bars,
    closes: bars.map(bar => bar.close),
    indexByDate: new Map(bars.map((bar, index) => [bar.date, index])),
  });
}
db.close();

const dates = [...new Set([...series.values()].flatMap(item => item.bars.map(bar => bar.date)))].sort();
if (dates.length === 0) throw new Error("No alpaca_wide daily bars for the deployed universe");

interface ReplayResult {
  label: string;
  sessions: number;
  closedTrades: number;
  openPositions: number;
  winRate: number;
  profitFactor: number;
  returnPct: number;
  maxDrawdownPct: number;
}

function runWindow(label: string, from: string, to?: string): ReplayResult {
  const windowDates = dates.filter(date => date >= from && (!to || date < to));
  const positions: Position[] = [];
  const closed: ClosedTrade[] = [];
  let realizedPnl = 0;
  let equity = cfg.baseUsd;
  let peakEquity = equity;
  let maxDrawdown = 0;

  const closePosition = (position: Position, price: number, reason: ClosedTrade["reason"]): void => {
    const pnl = (price - position.entryPrice) * position.qty;
    realizedPnl += pnl;
    closed.push({ pnl, reason });
    positions.splice(positions.indexOf(position), 1);
  };

  for (let day = 0; day < windowDates.length; day++) {
    const date = windowDates[day];

    // Live evaluates the prior completed bar shortly after today's open. Exits
    // free slots before entries, then all surviving/new positions face today's SL.
    for (const position of [...positions]) {
      const item = series.get(position.symbol)!;
      const currentIndex = item.indexByDate.get(date);
      if (currentIndex === undefined || currentIndex === 0) continue;
      const signalIndex = currentIndex - 1;
      const smaExit = item.bars[signalIndex].close > sma(item.closes, signalIndex, cfg.smaExit);
      const timeStop = day - position.entryDay >= cfg.timeStopDays;
      if (!smaExit && !timeStop) continue;
      const fill = item.bars[currentIndex].open * (1 - SLIPPAGE);
      closePosition(position, fill, smaExit ? "SMA_EXIT" : "TIME_STOP");
    }

    if (positions.length < cfg.maxPositions) {
      const candidates: Array<{ symbol: string; rsi: number; currentIndex: number }> = [];
      for (const symbol of MEANREV_UNIVERSE) {
        if (positions.some(position => position.symbol === symbol)) continue;
        const item = series.get(symbol)!;
        const currentIndex = item.indexByDate.get(date);
        if (currentIndex === undefined) continue;
        const signalIndex = currentIndex - 1;
        if (signalIndex < cfg.smaLong) continue; // pre-window bars provide indicator warmup
        const rsi = rsi2(item.closes, signalIndex);
        if (
          rsi < cfg.entryRsi &&
          item.bars[signalIndex].close > sma(item.closes, signalIndex, cfg.smaLong)
        ) {
          candidates.push({ symbol, rsi, currentIndex });
        }
      }

      candidates.sort((a, b) => a.rsi - b.rsi);
      for (const candidate of candidates.slice(0, cfg.maxPositions - positions.length)) {
        const open = series.get(candidate.symbol)!.bars[candidate.currentIndex].open;
        const qty = Math.floor(SLOT_USD / open);
        if (qty <= 0) continue;
        const entryPrice = open * (1 + SLIPPAGE);
        positions.push({
          symbol: candidate.symbol,
          qty,
          entryPrice,
          entryDay: day,
          mark: entryPrice,
        });
      }
    }

    // This intentionally includes positions opened above on the same daily bar.
    for (const position of [...positions]) {
      const item = series.get(position.symbol)!;
      const currentIndex = item.indexByDate.get(date);
      if (currentIndex === undefined) continue;
      const bar = item.bars[currentIndex];
      const stop = position.entryPrice * (1 - STOP_PCT);
      if (bar.low > stop) continue;
      const fill = Math.min(bar.open, stop) * (1 - SLIPPAGE); // honor overnight gaps through the stop
      closePosition(position, fill, "STOP_LOSS");
    }

    equity = cfg.baseUsd + realizedPnl;
    for (const position of positions) {
      const item = series.get(position.symbol)!;
      const currentIndex = item.indexByDate.get(date);
      if (currentIndex !== undefined) position.mark = item.bars[currentIndex].close;
      equity += (position.mark - position.entryPrice) * position.qty;
    }
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
  }

  const grossProfit = closed.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = closed.reduce((sum, trade) => sum + Math.max(0, -trade.pnl), 0);
  return {
    label,
    sessions: windowDates.length,
    closedTrades: closed.length,
    openPositions: positions.length,
    winRate: closed.length > 0 ? closed.filter(trade => trade.pnl > 0).length / closed.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Number.POSITIVE_INFINITY,
    returnPct: (equity / cfg.baseUsd - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
  };
}

const windows = [
  ["2019-01-01..2021-01-01", "2019-01-01", "2021-01-01"],
  ["2021-01-01..2023-01-01", "2021-01-01", "2023-01-01"],
  ["2023-01-01..2024-01-01", "2023-01-01", "2024-01-01"],
  ["2024-01-01..2025-01-01", "2024-01-01", "2025-01-01"],
  ["2025-01-01..2026-01-01", "2025-01-01", "2026-01-01"],
  ["2026-01-01..2026-07-06", "2026-01-01", "2026-07-06"],
] as const;

const results = windows.map(([label, from, to]) => runWindow(label, from, to));
const fullSample = runWindow("full sample", dates[0]);
const signalStart = dates.find(date => MEANREV_UNIVERSE.some(symbol => {
  const index = series.get(symbol)!.indexByDate.get(date);
  return index !== undefined && index - 1 >= cfg.smaLong;
}));

console.log("Mean-reversion production-config replay");
console.log(`Sample dates: ${dates[0]} -> ${dates.at(-1)} (${dates.length} trading dates; signals from ${signalStart})`);
console.log(`Data: source='alpaca_wide'; ${duplicateDates} duplicate trading-date rows dropped`);
console.log(
  `Config: ${MEANREV_UNIVERSE.length} symbols | RSI2<${cfg.entryRsi} | SMA${cfg.smaLong} trend | ` +
  `SMA${cfg.smaExit} exit | ${cfg.timeStopDays}-day stop | $${cfg.baseUsd.toLocaleString()} base | ` +
  `$${SLOT_USD.toLocaleString()} whole-share slots x ${cfg.maxPositions} | ${STOP_PCT * 100}% hard stop | 2bps adverse fills`,
);
console.log("\nWindow                     Sessions  Closed     WR     PF   Return   Max DD  Open");
for (const result of [...results, fullSample]) {
  const pf = Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : "Inf";
  console.log(
    `${result.label.padEnd(26)} ${String(result.sessions).padStart(8)} ` +
    `${String(result.closedTrades).padStart(7)} ${(result.winRate * 100).toFixed(1).padStart(6)}% ` +
    `${pf.padStart(6)} ${result.returnPct.toFixed(2).padStart(7)}% ` +
    `${result.maxDrawdownPct.toFixed(2).padStart(7)}% ${String(result.openPositions).padStart(5)}`,
  );
}
console.log("\nNote: every window starts flat at $50,000; pre-window bars are indicator warmup only.");
console.log("Note: closed trades/WR/PF exclude end-of-window open positions; return/DD mark them to daily close.");
console.log("Note: daily bars approximate the live 09:35 fill; this replay fills at the next daily open.");
console.log("Note: live and historical signal bars both use split adjustment.");
