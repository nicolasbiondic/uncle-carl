// Test-support: momentum-engine fixtures. TEST-ONLY.
import type { MomentumBrokerAdapter, MomentumEngineLogger, MomentumPersistedState, MomentumStatePersistence } from "../strategies/momentum/MomentumEngine";
import type { OHLCV } from "../utils/types";

/** Linear-drift candles at 5m bars ENDING just before `endTs` — the
 *  time-hermetic anchor variant (MomentumEngine.clock.test.ts). */
export function rampTo(endTs: number, start: number, end: number, days = 35): OHLCV[] {
  const totalBars = Math.floor((days * 24 * 60) / 5);
  const baseTs = endTs - totalBars * 5 * 60_000;
  const out: OHLCV[] = [];
  for (let i = 0; i < totalBars; i++) {
    const t = i / (totalBars - 1);
    const p = start + (end - start) * t;
    out.push({ open: p, high: p, low: p, close: p, volume: 1, timestamp: baseTs + i * 5 * 60_000 });
  }
  return out;
}

/** Same ramp anchored to Date.now() — the shape three suites duplicated
 *  (a proven strong-gainer fixture when end > start). */
export function ramp(start: number, end: number, days = 35): OHLCV[] {
  return rampTo(Date.now(), start, end, days);
}

/** Silent logger, structurally assignable to MomentumEngineLogger and
 *  MeanRevLogger alike. */
export const silentLogger: MomentumEngineLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** In-memory broker: superset of the two copies MomentumEngine.test.ts and
 *  MomentumEngine.clock.test.ts carried (opened/closed capture, mutable
 *  equity/realisedSince, per-symbol candle store). */
export class FakeBroker implements MomentumBrokerAdapter {
  positions: { symbol: string; side: "buy" | "sell"; quantity: number; notional: number; entryTime?: number }[] = [];
  candleStore = new Map<string, OHLCV[]>();
  equity = 10_000;
  realisedSince = 0;
  opened: any[] = [];
  closed: any[] = [];

  setCandles(symbol: string, candles: OHLCV[]) { this.candleStore.set(symbol, candles); }

  async getOpenPositions() { return this.positions.map(p => ({ ...p })); }
  async getEquity() { return this.equity; }
  async getRealisedPnlSince(_t: number) { return this.realisedSince; }
  async openPosition(a: { symbol: string; side: "buy" | "sell"; notionalUsd: number }) {
    this.opened.push(a);
    this.positions.push({ symbol: a.symbol, side: a.side, quantity: a.notionalUsd / 100, notional: a.notionalUsd });
    return { ok: true };
  }
  async closePosition(a: { symbol: string; side: "buy" | "sell"; closeReason?: string }) {
    this.closed.push(a);
    this.positions = this.positions.filter(p => !(p.symbol === a.symbol && p.side === a.side));
    return { ok: true };
  }
  async fetchCandles(symbol: string, _bars: number) {
    return this.candleStore.get(symbol) ?? [];
  }
}

/** In-memory MomentumStatePersistence — same envelope shape as index.ts's
 *  fileStatePersistence, no filesystem needed for a unit test. */
export class MemoryPersistence implements MomentumStatePersistence {
  store: MomentumPersistedState | null = null;
  load() { return this.store; }
  save(s: MomentumPersistedState) { this.store = s; }
}
