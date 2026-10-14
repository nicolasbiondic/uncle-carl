// Snapshot builder (línea D): per-symbol features from historical.db daily
// bars (READ-ONLY handle — this process must never write that file) plus the
// day's news headlines (the dashboard's news aggregation reused as a library).

import { Database } from "bun:sqlite";
import { distanceToSMA, meanFunding, rsi, simpleReturn, volatility } from "./features";
import { fundingSymbolFor, universeFor } from "./universe";
import type { AssetClass, NewsHeadline, Snapshot, SymbolFeatures } from "./types";

export function openHistoricalReadOnly(path: string): Database {
  return new Database(path, { readonly: true });
}

export function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Daily closes up to `asOf` (inclusive), oldest→newest, capped at 260 bars. */
function dailyCloses(hist: Database, symbol: string, asOf: number): Array<{ ts: number; close: number }> {
  const rows = hist.query<{ timestamp: number; close: number }, [string, number]>(
    `SELECT timestamp, close FROM historical_bars
     WHERE symbol = ? AND timeframe = '1d' AND timestamp <= ?
     ORDER BY timestamp DESC LIMIT 260`,
  ).all(symbol, asOf);
  return rows.reverse().map((r) => ({ ts: r.timestamp, close: r.close }));
}

function recentFunding(hist: Database, internalSymbol: string, asOf: number): number[] {
  const rows = hist.query<{ rate: number }, [string, number]>(
    `SELECT rate FROM funding_rates WHERE symbol = ? AND funding_time <= ?
     ORDER BY funding_time DESC LIMIT 3`,
  ).all(fundingSymbolFor(internalSymbol), asOf);
  return rows.reverse().map((r) => r.rate);
}

export function buildSymbolFeatures(
  symbol: string,
  bars: Array<{ ts: number; close: number }>,
  fundingRates: number[] | null,
): SymbolFeatures | null {
  if (bars.length === 0) return null;
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  return {
    symbol,
    ret1: simpleReturn(closes, 1),
    ret5: simpleReturn(closes, 5),
    ret21: simpleReturn(closes, 21),
    ret63: simpleReturn(closes, 63),
    vol20: volatility(closes, 20),
    rsi14: rsi(closes, 14),
    distMA50: distanceToSMA(closes, 50),
    distMA200: distanceToSMA(closes, 200),
    funding: fundingRates ? meanFunding(fundingRates) : null,
    lastClose: last.close,
    lastBarTs: last.ts,
  };
}

export function buildSnapshot(
  hist: Database,
  assetClass: AssetClass,
  now: number,
  headlines: NewsHeadline[],
): Snapshot {
  const symbols: SymbolFeatures[] = [];
  for (const symbol of universeFor(assetClass)) {
    const bars = dailyCloses(hist, symbol, now);
    const funding = assetClass === "crypto" ? recentFunding(hist, symbol, now) : null;
    const f = buildSymbolFeatures(symbol, bars, funding);
    if (f) symbols.push(f); // a symbol with zero bars is silently absent — honest gap
  }
  return { assetClass, dateKey: utcDateKey(now), decidedAt: now, symbols, headlines };
}

const pct = (v: number | null): string => (v == null ? "n/a" : (v * 100).toFixed(2) + "%");
const num = (v: number | null, digits = 1): string => (v == null ? "n/a" : v.toFixed(digits));

/** The exact prompt each model receives. Deterministic given the snapshot. */
export function buildPrompt(snapshot: Snapshot): string {
  const lines: string[] = [];
  lines.push(
    "You are one of three independent market analysts in a daily voting experiment.",
    `Asset class today: ${snapshot.assetClass === "stocks" ? "US stocks/ETFs (next regular session)" : "crypto perpetuals (next 24h, UTC days)"}.`,
    `Decision date (UTC): ${snapshot.dateKey}. Horizon: one day, entered at the next daily open.`,
    "",
    "For EACH symbol below, give your directional view for the next day and a confidence in [0,1].",
    "Indicators are computed on completed daily bars (ret = close-to-close returns; vol20 = daily stdev of last 20 log returns; dMA = close/SMA-1; funding = mean of last 3 perp funding rates).",
    "",
    "symbol | ret1 | ret5 | ret21 | ret63 | vol20 | RSI14 | dMA50 | dMA200 | funding",
  );
  for (const s of snapshot.symbols) {
    lines.push([
      s.symbol, pct(s.ret1), pct(s.ret5), pct(s.ret21), pct(s.ret63), pct(s.vol20),
      num(s.rsi14), pct(s.distMA50), pct(s.distMA200),
      s.funding == null ? "n/a" : (s.funding * 100).toFixed(4) + "%",
    ].join(" | "));
  }
  if (snapshot.headlines.length > 0) {
    lines.push("", "Recent headlines:");
    for (const h of snapshot.headlines.slice(0, 12)) lines.push(`- [${h.source}] ${h.title}`);
  }
  lines.push(
    "",
    "Respond with ONLY a JSON object, no prose, mapping EVERY symbol above to",
    '{"view":"long"|"short"|"neutral","confidence":<number 0..1>}.',
    `Example: {"${snapshot.symbols[0]?.symbol ?? "SPY"}":{"view":"neutral","confidence":0.4}}`,
  );
  return lines.join("\n");
}
