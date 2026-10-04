#!/usr/bin/env bun
/**
 * Funding-aware overlay backtest on the TSM crypto sleeve.
 *
 * Replays the v7/v8 MomentumEngine (time-series, 60min cadence, slot 0.375)
 * over data/historical.db 1h bars — SimBroker pattern copied from
 * scripts/backtest-momentum-wf.ts (standalone on purpose; that script is
 * owned by another agent) — with ONE change: perp funding is REAL, applied
 * per settlement event from the funding_rates table (mainnet history via
 * scripts/download-funding-history.ts) instead of the constant 0.01%/8h.
 *
 * Variants:
 *   a) baseline   — real funding costs, no filter (informative on its own)
 *   b) skip       — reject NEW long entries while the symbol's current
 *                   funding rate > P90 of its own trailing-90d settled
 *                   distribution (BIS crash-predictor)
 *   c) scale      — same trigger, but open at 0.5× notional instead of skip
 *
 * GATE: a variant passes iff it improves geo-mean growth across windows vs
 * (a) AND does not flip any (a)-positive window negative.
 *
 * Usage: bun run scripts/backtest-funding-overlay.ts
 */

import { Database } from "bun:sqlite";
import { MomentumEngine, type MomentumBrokerAdapter } from "../src/strategies/momentum/MomentumEngine";
import { TestClock } from "../src/utils/clock";
import type { CurrentPosition } from "../src/strategies/momentum/Rebalancer";
import type { OHLCV } from "../src/utils/types";

const INITIAL_EQUITY = 10_000;
const HARD_SL_PCT = 0.04;
const SLOT_PCT = 0.375;
const CADENCE_MIN = 60;
const SLIPPAGE_BPS = 5;
const COMMISSION_BPS = 4;
const ENTRY_PCT = 5;
const EXIT_PCT = -2;
const MAX_LONGS = 4;
const P90_WINDOW_MS = 90 * 86_400_000;
const MIN_P90_SAMPLES = 30; // fail-open below this (~10 days of settlements)

const UNIVERSE = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "AVAX/USD", "DOGE/USD", "LINK/USD"];
const REF_SYMBOL = "BTC/USD";
const WINDOWS = [
  { label: "2021", from: "2021-01-01", to: "2022-01-01" },
  { label: "2022", from: "2022-01-01", to: "2023-01-01" },
  { label: "2023", from: "2023-01-01", to: "2024-01-01" },
  { label: "2024", from: "2024-01-01", to: "2025-01-01" },
  { label: "2025", from: "2025-01-01", to: "2026-01-01" },
  { label: "2026ytd", from: "2026-01-01", to: "2026-05-04" },
];

type Variant = "baseline" | "skip" | "scale";
const VARIANTS: Variant[] = ["baseline", "skip", "scale"];

// ── data ──────────────────────────────────────────────────────────────
const hdb = new Database("./data/historical.db", { readonly: true });

function loadBars(symbol: string, fromMs: number, toMs: number): OHLCV[] {
  return hdb.prepare(
    `SELECT open, high, low, close, volume, timestamp FROM historical_bars
     WHERE symbol = ? AND timeframe = '1h' AND timestamp >= ? AND timestamp < ?
     ORDER BY timestamp ASC`,
  ).all(symbol, fromMs, toMs) as OHLCV[];
}

/** Per-symbol settled funding events ("BTC/USD" keys), ascending. */
class FundingBook {
  private ts = new Map<string, number[]>();
  private rates = new Map<string, number[]>();

  constructor() {
    for (const sym of UNIVERSE) {
      const perp = sym.replace("/USD", "USDT");
      const rows = hdb.prepare(
        `SELECT funding_time t, rate r FROM funding_rates WHERE symbol = ? ORDER BY funding_time ASC`,
      ).all(perp) as Array<{ t: number; r: number }>;
      if (rows.length === 0) throw new Error(`no funding history for ${perp} — run scripts/download-funding-history.ts first`);
      this.ts.set(sym, rows.map((x) => x.t));
      this.rates.set(sym, rows.map((x) => x.r));
    }
  }

  /** Index of last event with t <= at, or -1. */
  private idxAt(sym: string, at: number): number {
    const ts = this.ts.get(sym)!;
    let lo = 0, hi = ts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= at) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /** Settlement rates in (fromEx, toInc]. */
  eventsBetween(sym: string, fromEx: number, toInc: number): number[] {
    const a = this.idxAt(sym, fromEx);
    const b = this.idxAt(sym, toInc);
    return b > a ? this.rates.get(sym)!.slice(a + 1, b + 1) : [];
  }

  /** Last settled rate at `at` — what a live monitor would observe. */
  latestRate(sym: string, at: number): number | null {
    const i = this.idxAt(sym, at);
    return i >= 0 ? this.rates.get(sym)![i] : null;
  }

  /** P90 of the trailing-90d settled distribution at `at`; null when < MIN_P90_SAMPLES. */
  p90Trailing(sym: string, at: number): number | null {
    const ts = this.ts.get(sym)!;
    const b = this.idxAt(sym, at);
    if (b < 0) return null;
    let a = this.idxAt(sym, at - P90_WINDOW_MS); // window start (exclusive)
    const w = this.rates.get(sym)!.slice(a + 1, b + 1);
    if (w.length < MIN_P90_SAMPLES) return null;
    const sorted = [...w].sort((x, y) => x - y);
    return sorted[Math.floor(0.9 * (sorted.length - 1))];
  }
}

const book = new FundingBook();

// ── sim broker (copied from backtest-momentum-wf.ts; margin sim stripped —
//    exposure is fixed at 1× — and funding is real-event-driven) ────────
interface SimPosition { symbol: string; side: "buy" | "sell"; qty: number; entryPrice: number; entryAt: number }
interface ClosedTrade { symbol: string; pnl: number; exitAt: number; reason: string }

class SimBroker implements MomentumBrokerAdapter {
  cash: number;
  positions: SimPosition[] = [];
  closed: ClosedTrade[] = [];
  equityHistory: Array<{ t: number; eq: number }> = [];
  now = 0;
  fundingPaid = 0;
  feesPaid = 0;
  skips = 0;   // variant b: rejected long opens
  scales = 0;  // variant c: halved long opens

  constructor(cash: number, private candles: Map<string, OHLCV[]>, private variant: Variant) {
    this.cash = cash;
  }

  price(symbol: string, t: number): number {
    const c = this.candles.get(symbol);
    if (!c || c.length === 0) return 0;
    let lo = 0, hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid].timestamp <= t) lo = mid; else hi = mid - 1;
    }
    return c[lo].timestamp <= t ? c[lo].close : 0;
  }

  async getOpenPositions(): Promise<CurrentPosition[]> {
    return this.positions.map(p => ({
      symbol: p.symbol, side: p.side, quantity: p.qty,
      notional: p.qty * this.price(p.symbol, this.now),
    }));
  }

  equityNow(): number {
    let u = 0;
    for (const p of this.positions) {
      const cur = this.price(p.symbol, this.now);
      if (cur > 0) u += (cur - p.entryPrice) * p.qty * (p.side === "buy" ? 1 : -1);
    }
    return this.cash + u;
  }

  async getEquity(): Promise<number> { return this.equityNow(); }

  async getRealisedPnlSince(epochMs: number): Promise<number> {
    return this.closed.filter(t => t.exitAt > epochMs).reduce((s, t) => s + t.pnl, 0);
  }

  /** True when the symbol's current funding sits above its trailing-90d P90 (fail-open false). */
  crashRisky(symbol: string): boolean {
    const cur = book.latestRate(symbol, this.now);
    const p90 = book.p90Trailing(symbol, this.now);
    return cur !== null && p90 !== null && cur > p90;
  }

  async openPosition(a: { symbol: string; side: "buy" | "sell"; notionalUsd: number }) {
    let notional = a.notionalUsd;
    // Overlay applies to NEW LONG entries only (shorts EARN positive funding).
    if (a.side === "buy" && this.variant !== "baseline" && this.crashRisky(a.symbol)) {
      if (this.variant === "skip") { this.skips++; return { ok: false, reason: "funding>P90 skip" }; }
      notional *= 0.5;
      this.scales++;
    }
    const px = this.price(a.symbol, this.now);
    if (!px || notional <= 0) return { ok: false, reason: "no price" };
    const slip = a.side === "buy" ? px * (1 + SLIPPAGE_BPS / 10_000) : px * (1 - SLIPPAGE_BPS / 10_000);
    const fee = notional * (COMMISSION_BPS / 10_000);
    this.cash -= fee;
    this.feesPaid += fee;
    this.positions.push({ symbol: a.symbol, side: a.side, qty: notional / slip, entryPrice: slip, entryAt: this.now });
    return { ok: true };
  }

  async closePosition(a: { symbol: string; side: "buy" | "sell" }) {
    return this.closeAt(a.symbol, a.side, this.price(a.symbol, this.now), "rebalance");
  }

  closeAt(symbol: string, side: "buy" | "sell", px: number, reason: string) {
    const idx = this.positions.findIndex(p => p.symbol === symbol && p.side === side);
    if (idx < 0 || !px) return { ok: false, reason: "no position/price" };
    const p = this.positions[idx];
    const slip = side === "buy" ? px * (1 - SLIPPAGE_BPS / 10_000) : px * (1 + SLIPPAGE_BPS / 10_000);
    const gross = (slip - p.entryPrice) * p.qty * (side === "buy" ? 1 : -1);
    const fee = p.qty * slip * (COMMISSION_BPS / 10_000);
    this.cash += gross - fee;
    this.feesPaid += fee;
    this.closed.push({ symbol, pnl: gross - fee, exitAt: this.now, reason });
    this.positions.splice(idx, 1);
    return { ok: true };
  }

  checkStopLoss() {
    for (const p of [...this.positions]) {
      const cur = this.price(p.symbol, this.now);
      if (!cur) continue;
      const adverse = p.side === "buy" ? (p.entryPrice - cur) / p.entryPrice : (cur - p.entryPrice) / p.entryPrice;
      if (adverse >= HARD_SL_PCT) {
        const slPx = p.side === "buy" ? p.entryPrice * (1 - HARD_SL_PCT) : p.entryPrice * (1 + HARD_SL_PCT);
        this.closeAt(p.symbol, p.side, slPx, "stop_loss");
      }
    }
  }

  /**
   * REAL funding: every settled event in (prevT, t] charges/credits
   * notional × rate. Positive rate: longs pay, shorts receive; negative
   * rate flips both. Symbols with no event in the interval pay nothing.
   */
  applyFunding(prevT: number, t: number) {
    for (const p of this.positions) {
      const px = this.price(p.symbol, t);
      if (!px) continue;
      for (const rate of book.eventsBetween(p.symbol, Math.max(prevT, p.entryAt), t)) {
        const amt = p.qty * px * rate;
        if (p.side === "buy") { this.cash -= amt; this.fundingPaid += amt; }
        else { this.cash += amt; this.fundingPaid -= amt; }
      }
    }
  }

  async fetchCandles(symbol: string, bars: number): Promise<OHLCV[]> {
    const c = this.candles.get(symbol) ?? [];
    if (c.length === 0) return [];
    let lo = 0, hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid].timestamp <= this.now) lo = mid; else hi = mid - 1;
    }
    if (c[lo].timestamp > this.now) return [];
    return c.slice(Math.max(0, lo + 1 - bars), lo + 1);
  }
}

// ── one run ───────────────────────────────────────────────────────────
interface RunResult {
  variant: Variant; window: string;
  trades: number; winRate: number; ret: number; maxDd: number;
  fees: number; funding: number; skips: number; scales: number;
}

async function runOne(win: { label: string; from: string; to: string }, variant: Variant): Promise<RunResult | null> {
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);
  const loadFrom = fromMs - 32 * 86_400_000; // TSM warmup, as in the wf script

  const candles = new Map<string, OHLCV[]>();
  for (const sym of UNIVERSE) {
    const bars = loadBars(sym, loadFrom, toMs);
    if (bars.length > 0) candles.set(sym, bars);
  }
  const ref = candles.get(REF_SYMBOL);
  if (!ref || ref.length === 0) return null;

  const broker = new SimBroker(INITIAL_EQUITY, candles, variant);
  const clock = new TestClock(fromMs);
  const silent = { info: () => {}, warn: () => {}, error: () => {} };
  const historyBars = Math.ceil((31 * 24 * 60) / 60) + 10;
  const engine = new MomentumEngine(
    {
      mode: "time-series",
      universe: UNIVERSE,
      rebalanceMinutes: CADENCE_MIN,
      historyBars,
      notionalPctPerSlot: SLOT_PCT,
      tsm: { barMinutes: 60, entryThresholdPct: ENTRY_PCT, exitThresholdPct: EXIT_PCT, maxLongs: MAX_LONGS, maxShorts: 0 },
      regime: { barMinutes: 60 },
      scorer: { barMinutes: 60 },
    },
    broker,
    silent,
    undefined,
    clock, // sim clock injection (src/utils/clock.ts) — replaces the Date.now monkeypatch
  );

  const cadenceMs = CADENCE_MIN * 60_000;
  let lastTick = 0;
  let prevT = 0;
  for (const bar of ref) {
    const t = bar.timestamp;
    if (t < fromMs) continue;
    broker.now = t;
    clock.set(t);
    if (prevT) broker.applyFunding(prevT, t);
    prevT = t;
    broker.checkStopLoss();
    if (t - lastTick >= cadenceMs) {
      broker.equityHistory.push({ t, eq: await broker.getEquity() });
      await engine.tick();
      lastTick = t;
    }
  }
  broker.now = toMs;
  for (const p of [...broker.positions]) broker.closeAt(p.symbol, p.side, broker.price(p.symbol, ref[ref.length - 1].timestamp), "end");
  const finalEq = broker.cash;
  broker.equityHistory.push({ t: toMs, eq: finalEq });

  const trades = broker.closed.filter(t => t.reason !== "end");
  const wins = trades.filter(t => t.pnl > 0).length;
  let peak = INITIAL_EQUITY, maxDd = 0;
  for (const e of broker.equityHistory) {
    if (e.eq > peak) peak = e.eq;
    maxDd = Math.max(maxDd, (peak - e.eq) / peak);
  }
  return {
    variant, window: win.label,
    trades: trades.length, winRate: trades.length ? wins / trades.length : 0,
    ret: (finalEq - INITIAL_EQUITY) / INITIAL_EQUITY, maxDd,
    fees: broker.feesPaid, funding: broker.fundingPaid,
    skips: broker.skips, scales: broker.scales,
  };
}

// ── main ──────────────────────────────────────────────────────────────
const results: RunResult[] = [];
for (const variant of VARIANTS) {
  console.log(`▌ VARIANT ${variant}`);
  for (const win of WINDOWS) {
    const r = await runOne(win, variant);
    if (!r) { console.log(`  ${win.label} NO DATA`); continue; }
    results.push(r);
    console.log(
      `  ${r.window.padEnd(8)} | ${String(r.trades).padStart(4)} tr WR ${(r.winRate * 100).toFixed(0).padStart(3)}% | ` +
      `ret ${(r.ret * 100).toFixed(1).padStart(6)}% | DD ${(r.maxDd * 100).toFixed(1).padStart(4)}% | ` +
      `fees $${r.fees.toFixed(0)} funding $${r.funding.toFixed(0)}` +
      (r.skips ? ` | skips ${r.skips}` : "") + (r.scales ? ` | halved ${r.scales}` : ""),
    );
  }
  console.log("");
}

// ── summary + gate ────────────────────────────────────────────────────
function geo(rs: RunResult[]): number {
  const f = rs.map(r => 1 + r.ret);
  return f.some(x => x <= 0) ? -1 : Math.exp(f.reduce((s, x) => s + Math.log(x), 0) / rs.length) - 1;
}

console.log("▌ SUMMARY (geo-mean growth across windows)");
const byVariant = new Map<Variant, RunResult[]>();
for (const v of VARIANTS) byVariant.set(v, results.filter(r => r.variant === v));
for (const v of VARIANTS) {
  const rs = byVariant.get(v)!;
  console.log(
    `  ${v.padEnd(8)} | GEO ${(geo(rs) * 100).toFixed(2).padStart(7)}%/window | mean ret ${(rs.reduce((s, r) => s + r.ret, 0) / rs.length * 100).toFixed(1).padStart(6)}% | ` +
    `worst ${(Math.min(...rs.map(r => r.ret)) * 100).toFixed(1).padStart(6)}% | net funding $${rs.reduce((s, r) => s + r.funding, 0).toFixed(0)}`,
  );
}

const base = byVariant.get("baseline")!;
const baseGeo = geo(base);
console.log("\n▌ GATE — improve geo vs baseline AND no (a)-positive window flips negative");
for (const v of ["skip", "scale"] as Variant[]) {
  const rs = byVariant.get(v)!;
  const g = geo(rs);
  const flipped = base.filter(b => b.ret > 0 && (rs.find(r => r.window === b.window)?.ret ?? 0) <= 0).map(b => b.window);
  const pass = g > baseGeo && flipped.length === 0;
  console.log(
    `  ${v.padEnd(8)} | geo ${(g * 100).toFixed(2)}% vs ${(baseGeo * 100).toFixed(2)}% (${g > baseGeo ? "improves" : "does NOT improve"})` +
    ` | flipped: ${flipped.length ? flipped.join(",") : "none"} → ${pass ? "PASS" : "FAIL"}`,
  );
}
