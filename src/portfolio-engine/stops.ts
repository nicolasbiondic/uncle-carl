import type { DailyBar, Position, PriceView, StopConfig, StopLevel } from "./types";
import { compareSymbols, priceHistory, trailingVol } from "./signals";

export interface StopMemoryEntry { qty: number; avgEntryPrice: number; distance: number }
export type StopMemory = Readonly<Record<string, StopMemoryEntry>>;

/** Percent config values (4, 2, 12) become fractional distances here. */
export function stopDistance(config: StopConfig, closes: readonly number[] = []): number | null {
  if (config.mode === "none") return null;
  if (config.mode === "fixed") return config.pct / 100;
  const vol = trailingVol(closes, config.lookbackBars);
  if (vol === null) return null;
  return Math.max(config.minPct / 100, Math.min(config.maxPct / 100, config.kSigma * vol));
}

/** Call with ACTUAL positions, also immediately after fills, using the same
 * pre-fill PriceView. Never freeze vol from an intended/unfilled quantity.
 * A changed average entry detects an increase even after intervening reductions.
 * Reductions retain distance; flat positions discard their memory (re-entry allowed). */
export function updateStops(config: StopConfig, positions: readonly Position[], view: PriceView, previous: StopMemory = {}): {
  stops: StopLevel[]; memory: Record<string, StopMemoryEntry>;
} {
  const memory: Record<string, StopMemoryEntry> = {};
  const stops: StopLevel[] = [];
  if (config.mode === "none") return { stops, memory };
  for (const p of [...positions].sort((a, b) => compareSymbols(a.symbol, b.symbol))) {
    if (!(p.qty > 0) || !(p.avgEntryPrice > 0)) continue;
    const old = previous[p.symbol];
    const increased = !old || p.qty > old.qty || p.avgEntryPrice !== old.avgEntryPrice;
    const distance = config.mode === "volScaled" && !increased ? old.distance
      : stopDistance(config, config.mode === "volScaled"
        ? priceHistory(view, p.symbol, config.lookbackBars + 1).map(b => b.close) : []);
    if (distance === null) continue;
    memory[p.symbol] = { qty: p.qty, avgEntryPrice: p.avgEntryPrice, distance };
    stops.push({ symbol: p.symbol, stopPrice: p.avgEntryPrice * (1 - distance) });
  }
  return { stops, memory };
}

/** Raw fill reference before adverse slippage/commission. Gap through → open. */
export function stopFillPrice(stopPrice: number, bar: Pick<DailyBar, "open" | "low">): number | null {
  if (!(stopPrice > 0)) return null;
  if (bar.open <= stopPrice) return bar.open;
  return bar.low <= stopPrice ? stopPrice : null;
}
