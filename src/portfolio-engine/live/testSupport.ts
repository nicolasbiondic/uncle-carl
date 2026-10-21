// Test doubles for the live portfolio engine. TEST-ONLY (imported from
// *.test.ts in this folder; never from production code).
import { Database } from "bun:sqlite";
import type { OrderIntent, OrderResult, Position, StopLevel, TargetBook, VenueAdapter, VenueId, VenueRules, XassetTrendConfig, CryptoTrendConfig } from "../types";
import type { CoreDecideInput } from "../decide";

/** In-memory historical.db with the real schema; `sessions` are "YYYY-MM-DD"
 *  keys stamped at 04:00Z (Alpaca 1d convention). */
export function makeHistDb(series: Record<string, { sessions: string[]; close?: (i: number) => number }>, stampHour = 4): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS historical_bars (
      symbol TEXT NOT NULL, timeframe TEXT NOT NULL, timestamp INTEGER NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
      source TEXT NOT NULL, fetched_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (symbol, timeframe, timestamp)) WITHOUT ROWID;`);
  const ins = db.prepare(`INSERT INTO historical_bars (symbol, timeframe, timestamp, open, high, low, close, volume, source) VALUES (?, '1d', ?, ?, ?, ?, ?, 1000, 'manual')`);
  for (const [symbol, s] of Object.entries(series)) {
    s.sessions.forEach((d, i) => {
      const c = s.close ? s.close(i) : 100 + i;
      ins.run(symbol, Date.parse(`${d}T00:00:00Z`) + stampHour * 3_600_000, c, c * 1.01, c * 0.99, c);
    });
  }
  return db;
}

/** Weekday sessions ending at `last` (inclusive), `n` of them. */
export function weekdaySessions(last: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${last}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d.toISOString().slice(0, 10));
    t -= 86_400_000;
  }
  return out;
}

export type FillBehavior =
  | { kind: "fill"; price?: number }
  | { kind: "partial"; fraction: number; price?: number }
  | { kind: "reject"; error?: string }
  | { kind: "throw"; error?: string };

export interface SubmitCall { order: OrderIntent; clientOrderId: string }

/** Fake venue: positions are mutable (tests move them to mirror fills),
 *  submit is idempotent by clientOrderId (a repeat returns the FIRST result
 *  without re-filling — the duplicate-id contract). */
export class FakeVenue implements VenueAdapter {
  readonly venue: VenueId;
  positions_: Position[] = [];
  prices_: Record<string, number> = {};
  rules_: VenueRules;
  submits: SubmitCall[] = [];
  stopSyncs: Array<{ stops: readonly StopLevel[]; positions: readonly Position[] }> = [];
  behavior: Record<string, FillBehavior> = {};
  private seen = new Map<string, OrderResult>();
  mirrorFills = true;
  syncStops?: (stops: readonly StopLevel[], positions: readonly Position[]) => Promise<void>;

  constructor(venue: VenueId = "alpaca", opts: { withStops?: boolean } = {}) {
    this.venue = venue;
    this.rules_ = { venue, fractional: true, minOrderNotional: 5, rebalanceBand: 0 };
    if (opts.withStops) this.syncStops = async (stops, positions) => { this.stopSyncs.push({ stops, positions }); };
  }
  async rules(): Promise<VenueRules> { return this.rules_; }
  async positions(symbols: readonly string[]): Promise<Position[]> {
    return this.positions_.filter(p => symbols.includes(p.symbol)).map(p => ({ ...p }));
  }
  async prices(symbols: readonly string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of symbols) if (this.prices_[s] > 0) out[s] = this.prices_[s];
    return out;
  }
  async submit(order: OrderIntent, clientOrderId: string): Promise<OrderResult> {
    this.submits.push({ order, clientOrderId });
    const prior = this.seen.get(clientOrderId);
    if (prior) return { ...prior, status: `${prior.status}` };
    const b = this.behavior[order.symbol] ?? { kind: "fill" };
    if (b.kind === "throw") throw new Error(b.error ?? "transport down");
    let result: OrderResult;
    if (b.kind === "reject") result = { ok: false, filledQty: 0, avgPrice: null, status: "rejected", error: b.error ?? "insufficient buying power" };
    else {
      const qty = b.kind === "partial" ? order.qty * b.fraction : order.qty;
      const price = b.price ?? this.prices_[order.symbol];
      result = { ok: b.kind === "fill", filledQty: qty, avgPrice: price, status: b.kind === "fill" ? "filled" : "canceled", brokerOrderId: `b-${this.submits.length}` };
      if (this.mirrorFills) this.applyToPositions(order.symbol, order.side, qty, price);
    }
    this.seen.set(clientOrderId, result);
    return result;
  }
  private applyToPositions(symbol: string, side: "buy" | "sell", qty: number, price: number) {
    const p = this.positions_.find(x => x.symbol === symbol);
    if (side === "buy") {
      if (!p) this.positions_.push({ symbol, qty, avgEntryPrice: price });
      else { p.avgEntryPrice = (p.qty * p.avgEntryPrice + qty * price) / (p.qty + qty); p.qty += qty; }
    } else if (p) {
      p.qty -= qty;
      if (p.qty <= 1e-9) this.positions_ = this.positions_.filter(x => x !== p);
    }
  }
}

export const XASSET: XassetTrendConfig = {
  kind: "xassetTrend", universe: ["SPY", "TLT", "GLD"], blendHorizons: [63, 126, 252], maLong: 200, signalBandPct: 0,
  inceptionGuardBars: 252, volLookback: 63, covLookback: 63, portfolioVolTarget: 0.12, perAssetCap: 1, maxGross: 1.8,
};

export const CRYPTO_STOP: CryptoTrendConfig = {
  kind: "cryptoTrend", universe: ["BTC", "ETH"], blendHorizons: [63, 126, 252], maLong: 200, signalBandPct: 0,
  inceptionGuardBars: 252, volLookback: 30, covLookback: 30, portfolioVolTarget: 0.35, perAssetCap: 0.6, maxGross: 2,
  stop: { mode: "fixed", pct: 4 },
};

/** decide double: fixed weights, memory counter, optional fixed stops from
 *  actual positions (4% under the average entry). */
export function fixedDecide(weights: Record<string, number>, opts: { stops?: boolean } = {}) {
  const calls: CoreDecideInput[] = [];
  const fn = (input: CoreDecideInput): TargetBook => {
    calls.push(input);
    const n = Number((input.book.memory as any).n ?? 0) + 1;
    const stops = opts.stops ? input.book.positions.filter(p => p.qty > 0).map(p => ({ symbol: p.symbol, stopPrice: p.avgEntryPrice * 0.96 })) : [];
    return { asOf: input.view.asOf, weights, stops, memory: { n, lastAsOf: input.view.asOf }, diagnostics: { fake: true } };
  };
  return Object.assign(fn, { calls });
}
