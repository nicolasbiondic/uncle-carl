#!/usr/bin/env bun
/**
 * Walk-forward backtest of the v7 TSM MomentumEngine over data/historical.db.
 *
 * Two sleeves, backtested independently (they run on separate wallets live):
 *   - crypto: 8 perps, 1h bars
 *   - stocks: 10 large-caps/ETFs, 5m bars
 *
 * Sweeps rebalance cadence (240/120/60 min) across multiple out-of-sample
 * windows. Reports trades/day — the metric under evaluation for v8.
 *
 * Production-parity behavior absent from the retired legacy replay:
 *   - replay clock injected (a TestClock passed to the engine — the
 *     src/utils/clock.ts seam; the Date.now monkeypatch is gone) so
 *     RiskGuard day/pause logic runs in sim time, not wall time
 *   - getRealisedPnlSince filters by exit TIMESTAMP (old script compared
 *     against exit PRICE — RiskGuard never saw losses)
 *   - simulates the 4% hard SL the live adapter attaches
 *   - stocks use ONLY the engine's hourly vol trail (no duplicate 5m trail)
 *   - margin/buying-power enforced at baseline (M=1), with whole-share stock
 *     sizing like live Alpaca
 *   - crypto funding uses exact settled funding_rate events from mainnet
 *   - YTD window ends at the latest common complete data/asOf exclusive
 *   - no decision executes at the fold right edge without a next bar inside
 *     the interval (execution uses the next open only)
 *
 * Usage: bun run scripts/backtest-momentum-wf.ts [--sleeve crypto|stocks|all]
 *
 * --cooldownstop N  Post-hard-stop re-entry cooldown in decision bars
 *   (descriptive runs; the sweepable axis lives in CandidateConfig).
 *
 * --exposure 1,1.5,2,3,4  Kelly sweep: scales notionalPctPerSlot by M.
 *   Margin realism is always on (simplified but honest, per broker semantics):
 *   - initial margin locked at entry = actual_notional / leverage
 *   - stock quantity = floor(target / fill_price) whole shares
 *   - opens REJECTED when used+new margin > equity (Binance -2019 / Reg-T BP)
 *   - liquidation when equity < maintenance (0.5% of notional crypto tier-1;
 *     25% stocks Reg-T): force-close everything at 1% adverse + normal slippage
 *   - equity ≤ 0 ⇒ window stops, returns −100%
 */

import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { MomentumEngine, trailPctFromVol, type MarketTrendGateConfig, type MomentumBrokerAdapter, type MomentumStatePersistence, type TimeStopConfig, type TrailMark, type TrailStopConfig, type VolSizingConfig, type VolTargetConfig } from "../src/strategies/momentum/MomentumEngine";
import type { CurrentPosition } from "../src/strategies/momentum/Rebalancer";
import { DEFAULT_TSM_CONFIG, type TSMConfig } from "../src/strategies/momentum/TimeSeriesMomentum";
import type { OHLCV } from "../src/utils/types";
import { RISK_PROFILES } from "../src/config/riskProfiles";
import { INITIAL_RISK_STATE, type RiskGuardConfig, type RiskState } from "../src/strategies/momentum/RiskGuard";
import { getETDateKey } from "../src/db/database";
import { isMarketOpen } from "../src/utils/marketHours";
import { TestClock } from "../src/utils/clock";
import { isMemberAt, lastClosedIndex, loadMembership, membersOverlapping, topNByDollarVolume, type MembershipBook } from "./lib/membership";

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleeveArg = argOf("--sleeve") ?? "all";
const entryPct = parseFloat(argOf("--entry") ?? "5");
const exitPct = parseFloat(argOf("--exit") ?? "-2");
const maxLongs = parseInt(argOf("--maxlongs") ?? "4", 10);
const maxShorts = parseInt(argOf("--shorts") ?? "0", 10);
// "credit": shorts RECEIVE funding at the same rate longs pay (typical
// positive-funding regime). "zero": shorts pay/receive nothing
// (conservative-neutral — checks the edge isn't funding-driven).
const shortFunding = (argOf("--shortfunding") ?? "credit") as "credit" | "zero";
const slotPct = parseFloat(argOf("--slot") ?? "0.25");
const exposures = (argOf("--exposure") ?? "1").split(",").map(Number);
const cadenceArg = argOf("--cadence");
// --voltarget A,LB,MIN,MAX e.g. --voltarget 60,720,0.3,1.0
const volTargetArg = argOf("--voltarget");
const volTarget = volTargetArg
  ? (() => {
      const [a, lb, min, max] = volTargetArg.split(",").map(Number);
      return { annualizedPct: a, lookbackBars: lb, minScale: min, maxScale: max };
    })()
  : undefined;
// --trail K,LB,MIN,MAX e.g. --trail 3,24,2,8 (kSigma, lookbackBars, minPct, maxPct)
// LB is in BARS of the sleeve's timeframe: 24 = σ(24h) on crypto 1h; 78 = 1 RTH day on stocks 5m.
const trailArg = argOf("--trail");
const tsmTrail = trailArg
  ? (() => {
      const [k, lb, min, max] = trailArg.split(",").map(Number);
      return { kSigma: k, lookbackBars: lb, minPct: min, maxPct: max };
    })()
  : undefined;
// --sharpegate N,THR e.g. --sharpegate 30,0 (lookbackDays, minSharpe annualized)
const sharpeArg = argOf("--sharpegate");
const sharpeGate = sharpeArg
  ? (() => {
      const [d, thr] = sharpeArg.split(",").map(Number);
      return { lookbackDays: d, minSharpe: thr };
    })()
  : undefined;
// --cooldownstop N: after a HARD-STOP close (SimBroker reason "stop_loss"
// only), block NEW entries on that symbol for N decision bars (engine
// cadence ticks, not data bars). 0/absent = off (legacy behavior + hash).
const cooldownStopArg = argOf("--cooldownstop");
const cooldownBarsAfterStopArg = cooldownStopArg !== undefined ? parseInt(cooldownStopArg, 10) : undefined;

const HARD_SL_PCT = 0.04;

/**
 * Hard-stop axis for the stop-sizing sweep (OPEN.md P2: `stopLossPct: 4`
 * constant across sleeves whose horizons differ 10×). Three modes:
 *   - "fixed":     entry-anchored stop at `pct` (FRACTION, e.g. 0.04 = 4%)
 *                  — identical semantics to the legacy `hardStopPct` field
 *                  and to live AccountManager.checkAllStopLoss.
 *   - "volScaled": entry-anchored stop whose DISTANCE is computed once at
 *                  entry with the EXACT production `trailPctFromVol` formula
 *                  (kSigma × realized daily vol from log returns over
 *                  `lookbackBars` closes, clamped to [minPct, maxPct]
 *                  percent-units — see MomentumEngine.trailPctFromVol, which
 *                  is IMPORTED, not copied). Unlike the live trail, the
 *                  anchor never ratchets: it protects from ENTRY, like the
 *                  stop it would replace.
 *   - "none":      no hard stop; only the strategy's own exits run
 *                  (signal/SMA/time-stop/trail/fold-end).
 * Absent (`ReplayConfig.hardStop === undefined`) means the legacy behavior:
 * fixed at `hardStopPct`. JSON.stringify drops undefined, so pre-existing
 * candidate hashes are untouched by this axis existing.
 */
export type HardStopSpec =
  | { mode: "fixed"; pct: number }
  | ({ mode: "volScaled" } & TrailStopConfig)
  | { mode: "none" };

/**
 * Profit-lock axis (opt-in, third stop mechanism alongside the fixed hard
 * stop and the engine's own vol trail): once a position's peak-vs-entry
 * gain reaches `armAtPct`, its stop RATCHETS to a locked level that can
 * only move in the profitable direction thereafter — unlike the trail
 * (refuted on crypto: it amputates fat-tail winners) and the fixed hard
 * stop (refuted on stocks: worst point on its own axis), this never
 * loosens once armed and never fires before `armAtPct` is reached (a
 * pre-arm retreat is still caught only by the ordinary hard stop).
 *   - "breakeven": locks the stop at entryPrice × (1 ± lockPct/100)
 *     (long/short); lockPct=0 is the literal breakeven price.
 *   - "peakMinus": locks the stop at peak × (1 ∓ lockPct/100)
 *     (long/short), re-ratcheting every time a new peak is set — peak
 *     itself only ever tracks the best CLOSE of a CLOSED bar seen since
 *     entry (SimPosition.peakPrice), coherent with the engine's own trail
 *     convention of trailing closes, not intrabar extremes.
 * See SimBroker.checkStops for the ratchet + effective-level mechanics.
 */
export interface ProfitLockSpec {
  /** Gain from entry (percent-units, e.g. 10 = +10%) at which the lock arms. */
  armAtPct: number;
  mode: "breakeven" | "peakMinus";
  lockPct: number;
}

/**
 * Entry-anchored stop distance as a FRACTION for a position opened now,
 * given the decision-time close history (last element = latest CLOSED bar —
 * no lookahead into the execution bar). Returns null for mode "none".
 * volScaled inherits trailPctFromVol's fail-open-to-maxPct on short or
 * degenerate history.
 */
export function entryStopFraction(spec: HardStopSpec, closes: number[], barsPerDay: number): number | null {
  if (spec.mode === "none") return null;
  if (spec.mode === "fixed") return spec.pct;
  return trailPctFromVol(closes, spec, barsPerDay) / 100;
}

/**
 * A live position already open at the replay EPOCH (scripts/parity-check.ts
 * — OPEN.md P2 "el libro del sim arranca vacío en el epoch"), extracted
 * from trading.db by parity-check's extractSeedPositions. Fed to
 * runWithConfig/runMeanRevReplay so the sim's book starts with exactly the
 * positions live already held, instead of empty — the sim then manages
 * them (exits, slot occupancy, gross-exposure headroom, time stops, trail
 * marks) exactly like a position it opened itself.
 */
export interface SeedPosition {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  entryPrice: number;
  /** epoch ms (trades.entry_time). */
  entryAt: number;
  /** trades.stop_loss — the position's REAL persisted stop price. null/
   *  undefined = the row never got one (see seedStopFraction's fallback). */
  stopPrice?: number | null;
}

/**
 * Entry-anchored stop DISTANCE (fraction) for a seeded position. Prefers
 * the row's own persisted stop PRICE — the live position's actual stop,
 * which may differ from what a fresh entry would compute today (a
 * volScaled distance is resolved ONCE, at entry, from signal-time history
 * this function does not have for a position opened before the replay's
 * loaded window). A stop on the wrong side of entry (malformed data) is
 * treated as absent. Absent a usable price: mode "none" seeds truly
 * unprotected (matches a fresh "none" entry); any other mode falls back to
 * the sleeve's FIXED hardStopPct — the same fallback
 * AccountManager.checkAllStopLoss applies to a stop-less live row
 * (AGENTS.md "row stop first, profile stopLossPct as fallback") — rather
 * than re-deriving a volScaled distance it has no data for.
 */
export function seedStopFraction(
  seed: Pick<SeedPosition, "side" | "entryPrice" | "stopPrice">,
  spec: HardStopSpec,
  legacyFallbackPct: number,
): number | null {
  if (seed.stopPrice !== undefined && seed.stopPrice !== null && seed.stopPrice > 0 && seed.entryPrice > 0) {
    const frac = seed.side === "buy"
      ? (seed.entryPrice - seed.stopPrice) / seed.entryPrice
      : (seed.stopPrice - seed.entryPrice) / seed.entryPrice;
    if (frac > 0) return frac;
  }
  return spec.mode === "none" ? null : legacyFallbackPct;
}

/**
 * Reconstructs a TSM trail watermark for a position seeded mid-hold: the
 * best close since entry (peak for longs, trough for shorts), walked
 * across every bar strictly between `entryAt` and the replay epoch
 * (`epochMs`) — the SAME accumulation MomentumEngine.applyTrailStops
 * performs tick-to-tick, computed in one pass up front because the sim's
 * book is empty before the epoch and never ticked through that history.
 * Falls back to `{ mark: entryPrice, lastTs: entryAt }` when no bars fall
 * in range (the position's entry predates the replay's own loaded
 * history) — a DECLARED limitation: understates the true trail for such a
 * seed (rare: both sleeves this fix targets carry positions only days
 * before their epoch, well inside the replay's multi-month warmup).
 */
export function seedTrailMark(seed: Pick<SeedPosition, "side" | "entryPrice" | "entryAt">, bars: OHLCV[], epochMs: number): TrailMark {
  const long = seed.side === "buy";
  let mark = seed.entryPrice;
  let lastTs = seed.entryAt;
  for (const b of bars) {
    if (b.timestamp <= seed.entryAt || b.timestamp >= epochMs) continue;
    if (long ? b.close > mark : b.close < mark) mark = b.close;
    lastTs = b.timestamp;
  }
  return { mark, lastTs };
}

export interface Sleeve {
  name: "crypto" | "stocks" | "meanrev";
  universe: string[];
  timeframe: string;
  barMinutes: number;      // real bar spacing
  barMinutesEq: number;    // "day math" bar minutes (stocks: 78 RTH bars = 1 day)
  slippageBps: number;
  commissionBps: number;
  funding: boolean;
  windows: Array<{ label: string; from: string; to: string }>;
  refSymbol: string;       // drives the tick timeline
  source: string;
  rthOnly: boolean;
  initialEquity: number;
  notionalPctPerSlot: number;
  leverage: number;
  hardStopPct: number;
  tsmTrail?: TrailStopConfig;
  sharpeGate?: { lookbackDays: number; minSharpe: number };
}

export const SLEEVES: Sleeve[] = [
  {
    name: "crypto",
    universe: ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "AVAX/USD", "DOGE/USD", "LINK/USD"],
    timeframe: "1h",
    barMinutes: 60,
    barMinutesEq: 60,
    slippageBps: 5,
    commissionBps: 4,
    funding: true,
    refSymbol: "BTC/USD",
    source: "binance_futures",
    rthOnly: false,
    initialEquity: RISK_PROFILES.momentum_crypto.initialEquity,
    notionalPctPerSlot: 0.375,
    leverage: RISK_PROFILES.momentum_crypto.leverage,
    hardStopPct: RISK_PROFILES.momentum_crypto.stopLossPct / 100,
    tsmTrail: undefined,
    sharpeGate: { lookbackDays: 30, minSharpe: 0 },
    windows: [
      { label: "2021", from: "2021-01-01", to: "2022-01-01" },
      { label: "2022", from: "2022-01-01", to: "2023-01-01" },
      { label: "2023", from: "2023-01-01", to: "2024-01-01" },
      { label: "2024", from: "2024-01-01", to: "2025-01-01" },
      { label: "2025", from: "2025-01-01", to: "2026-01-01" },
      { label: "2026ytd", from: "2026-01-01", to: "2026-05-04" }, // overwritten by latest-common asOf
    ],
  },
  {
    name: "stocks",
    universe: ["SPY", "QQQ", "IWM", "GLD", "AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN"],
    timeframe: "5m",
    barMinutes: 5,
    // ponytail: RTH has ~78 5m bars/day; map "lookbackDays" to trading days
    barMinutesEq: (24 * 60) / 78,
    slippageBps: 2,
    commissionBps: 0,
    funding: false,
    refSymbol: "SPY",
    source: "alpaca_split",
    rthOnly: true,
    initialEquity: RISK_PROFILES.momentum_stocks.initialEquity,
    notionalPctPerSlot: 0.5,
    leverage: 2, // Reg-T buying-power cap in the simulator; live sleeve sizes on a cash ledger.
    hardStopPct: RISK_PROFILES.momentum_stocks.stopLossPct / 100,
    tsmTrail: { kSigma: 3, lookbackBars: 78, minPct: 2, maxPct: 8 },
    sharpeGate: { lookbackDays: 30, minSharpe: 0 },
    windows: [
      { label: "2024", from: "2024-01-01", to: "2025-01-01" },
      { label: "2025", from: "2025-01-01", to: "2026-01-01" },
      { label: "2026ytd", from: "2026-01-01", to: "2026-07-06" }, // overwritten by latest-common asOf
    ],
  },
];

const CADENCES_MIN = cadenceArg ? [parseInt(cadenceArg, 10)] : [240, 120, 60];

// ── data loading ──────────────────────────────────────────────────────
let hdb: Database | null = null;
export function getHdb(): Database {
  return hdb ??= new Database("./data/historical.db", { readonly: true });
}

export function isRth(timestamp: number): boolean {
  return isMarketOpen(timestamp);
}

function openMarketDurationMs(fromMs: number, toMs: number): number {
  let duration = 0;
  for (let t = fromMs; t < toMs; t += 5 * 60_000) {
    if (isMarketOpen(t)) duration += Math.min(5 * 60_000, toMs - t);
  }
  return duration;
}

// ponytail: Alpaca IEX can omit quiet ETF bars; raise only if a full refetch
// proves a larger isolated gap is genuine source behavior.
const RTH_SPARSE_TOLERANCE_MS = 90 * 60_000;

function countBarsBetween(bars: OHLCV[] | undefined, fromMs: number, toMs: number): number {
  if (!bars || bars.length === 0 || fromMs >= toMs) return 0;
  const lowerBound = (target: number) => {
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].timestamp < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return lowerBound(toMs) - lowerBound(fromMs);
}

/**
 * Validate bar density/coverage for a symbol over [fromMs, toMs).
 * Accepts RTH overnight/weekend/holiday closures and early closes.
 * Fail-closed: throws when an expected open-market bar is missing.
 */
export function validateBarDensity(
  bars: OHLCV[],
  symbol: string,
  barMinutes: number,
  rthOnly: boolean,
  fromMs: number,
  toMs: number,
  peerBars?: OHLCV[],
): void {
  if (bars.length === 0) {
    throw new Error(`no bars for ${symbol} in [${isoDate(fromMs)}, ${isoDate(toMs)})`);
  }
  const barMs = barMinutes * 60_000;
  // Daily equity bars (barMinutes >= 1440, rthOnly=false — the alpaca_wide/1d
  // sleeve): bars are spaced in TRADING days, so weekends are 3-calendar-day
  // gaps, holiday clusters reach ~4-5 days, and the bar timestamp's UTC hour
  // shifts ±1h across DST. Tolerate up to 6 calendar days at the start, end
  // and between bars; anything longer is a genuine hole (meanrev's own daily
  // validator fails at 10). Sub-daily behavior below is byte-identical.
  const dailyEq = barMinutes >= 1440 && !rthOnly;
  const dailyToleranceMs = 6 * barMs;
  const first = bars[0].timestamp;
  const last = bars[bars.length - 1].timestamp;
  const startMissing = dailyEq
    ? first > fromMs + dailyToleranceMs
    : rthOnly
      ? openMarketDurationMs(fromMs, first) > barMs * 3
      : first > fromMs + barMs + 60_000;
  if (startMissing && (!rthOnly || !peerBars || countBarsBetween(peerBars, fromMs, first) > 3)) {
    throw new Error(
      `${symbol} first bar ${isoDate(first)} is ${((first - fromMs) / 3_600_000).toFixed(1)}h after window start ${isoDate(fromMs)}`,
    );
  }
  const endMissing = dailyEq
    ? last + dailyToleranceMs < toMs
    : rthOnly
      ? openMarketDurationMs(last + barMs, toMs) > barMs * 3
      : last + barMs + 60_000 < toMs;
  if (endMissing && (!rthOnly || !peerBars || countBarsBetween(peerBars, last + barMs, toMs) > 3)) {
    throw new Error(
      `${symbol} last bar ${isoDate(last)} is ${((toMs - last) / 3_600_000).toFixed(1)}h before window end ${isoDate(toMs)}`,
    );
  }

  // Alpaca's IEX feed legitimately omits quiet RTH intervals; preserve the
  // production-equivalent one-hour sparsity allowance. Crypto remains strict.
  // Daily equity bars use the trading-calendar tolerance declared above.
  const maxGapMs = dailyEq ? dailyToleranceMs : barMs + (rthOnly ? RTH_SPARSE_TOLERANCE_MS : 60_000);
  for (let i = 1; i < bars.length; i++) {
    const gap = bars[i].timestamp - bars[i - 1].timestamp;
    if (gap <= maxGapMs) continue;

    if (rthOnly && openMarketDurationMs(bars[i - 1].timestamp + barMs, bars[i].timestamp) <= RTH_SPARSE_TOLERANCE_MS) {
      continue;
    }
    if (rthOnly && peerBars && countBarsBetween(peerBars, bars[i - 1].timestamp + barMs, bars[i].timestamp) <= RTH_SPARSE_TOLERANCE_MS / (5 * 60_000)) {
      // Source-wide Alpaca/IEX outage: the live engine had no timeline tick either.
      continue;
    }

    // Unexplained gap; fail closed.
    throw new Error(
      `${symbol} gap ${(gap / 3_600_000).toFixed(1)}h exceeds tolerance [${isoDate(bars[i - 1].timestamp)} -> ${isoDate(bars[i].timestamp)}]`,
    );
  }
}

/**
 * Validate coverage for all symbols in a sleeve over [fromMs, toMs).
 * Calls validateBarDensity for each symbol; fails on first error.
 */
export function validateBarCoverage(
  db: Database,
  sleeve: Sleeve,
  fromMs: number,
  toMs: number,
): Map<string, OHLCV[]> {
  const out = new Map<string, OHLCV[]>();
  for (const sym of sleeve.universe) {
    const bars = loadBars(sym, sleeve.timeframe, sleeve.source, sleeve.rthOnly, fromMs, toMs, db);
    out.set(sym, bars);
  }
  const referenceBars = out.get(sleeve.refSymbol);
  const referencePeer = sleeve.universe.find(sym => sym !== sleeve.refSymbol);
  for (const sym of sleeve.universe) {
    const peers = sym === sleeve.refSymbol ? out.get(referencePeer ?? "") : referenceBars;
    validateBarDensity(out.get(sym)!, sym, sleeve.barMinutes, sleeve.rthOnly, fromMs, toMs, peers);
  }
  return out;
}

export function loadBars(symbol: string, timeframe: string, source: string, rthOnly: boolean, fromMs: number, toMs: number, db = getHdb()): OHLCV[] {
  const rows = db.prepare(
    `SELECT open, high, low, close, volume, timestamp FROM historical_bars
     WHERE symbol = ? AND timeframe = ? AND source = ? AND timestamp >= ? AND timestamp < ?
     ORDER BY timestamp ASC`,
  ).all(symbol, timeframe, source, fromMs, toMs) as OHLCV[];
  return rthOnly ? rows.filter(bar => isRth(bar.timestamp)) : rows;
}

/** Latest timestamp whose bar is actually usable for this sleeve (RTH-filtered when needed). */
export function latestUsableBarTimestamp(sleeve: Sleeve, sym: string, db = getHdb()): number | null {
  const rows = db.prepare(
    `SELECT timestamp FROM historical_bars WHERE symbol = ? AND timeframe = ? AND source = ? ORDER BY timestamp DESC LIMIT 200`,
  ).all(sym, sleeve.timeframe, sleeve.source) as Array<{ timestamp: number }>;
  for (const r of rows) {
    if (!sleeve.rthOnly || isRth(r.timestamp)) return r.timestamp;
  }
  return rows[rows.length - 1]?.timestamp ?? null;
}

/** Latest common complete asOf (exclusive) for a sleeve. Limited by bars and, for crypto, funding. */
export function latestCommonAsOf(sleeve: Sleeve, db = getHdb()): number {
  let minAsOf = Infinity;
  for (const sym of sleeve.universe) {
    const lastBar = latestUsableBarTimestamp(sleeve, sym, db);
    let asOf = (lastBar ?? 0) + sleeve.barMinutes * 60_000;
    if (sleeve.funding) {
      const perp = sym.replace("/USD", "USDT");
      const fundRow = db.prepare(`SELECT MAX(funding_time) m FROM funding_rates WHERE symbol = ?`).get(perp) as { m: number | null };
      const fundAsOf = fundRow.m ?? 0;
      asOf = Math.min(asOf, fundAsOf);
    }
    if (asOf < minAsOf) minAsOf = asOf;
  }
  return minAsOf;
}

// ── funding coverage validation ──────────────────────────────────────
export const FUNDING_INTERVAL_MS = 8 * 3_600_000;
export const FUNDING_START_TOLERANCE_MS = FUNDING_INTERVAL_MS; // 8h
export const FUNDING_MAX_GAP_MS = FUNDING_INTERVAL_MS + 3_600_000; // 9h

export function isoDate(ms: number): string { return new Date(ms).toISOString(); }

/**
 * Verify settled-funding coverage over [fromMs, toMs) for every crypto symbol.
 * Fail-closed: missing first settlement, internal gaps, or a short tail all throw
 * with explicit symbol / range / gap details. Returns the loaded rows per symbol.
 */
export function validateFundingCoverage(
  db: Database,
  symbols: string[],
  fromMs: number,
  toMs: number,
): Map<string, Array<{ t: number; r: number }>> {
  const out = new Map<string, Array<{ t: number; r: number }>>();
  for (const sym of symbols) {
    const perp = sym.replace("/USD", "USDT");
    const rows = db.prepare(
      `SELECT funding_time t, rate r FROM funding_rates WHERE symbol = ? ORDER BY funding_time ASC`,
    ).all(perp) as Array<{ t: number; r: number }>;
    if (rows.length === 0) {
      throw new Error(`no funding history for ${perp}`);
    }
    const first = rows[0].t;
    const last = rows[rows.length - 1].t;
    // Fail closed: first event must be near the window start (within 8h tolerance).
    if (first > fromMs + FUNDING_START_TOLERANCE_MS) {
      throw new Error(
        `funding coverage gap: ${perp} first settlement ${isoDate(first)} is ` +
        `${((first - fromMs) / 3_600_000).toFixed(1)}h after window start ${isoDate(fromMs)} ` +
        `(>${FUNDING_START_TOLERANCE_MS / 3_600_000}h)`,
      );
    }
    // Fail closed: last event must reach or exceed window end.
    if (last < toMs) {
      throw new Error(
        `funding coverage gap: ${perp} last settlement ${isoDate(last)} is before window end ${isoDate(toMs)}`,
      );
    }
    // Fail closed: no internal gap exceeding 9h (8h cadence + 1h tolerance).
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].t - rows[i - 1].t > FUNDING_MAX_GAP_MS) {
        throw new Error(
          `funding gap >${FUNDING_MAX_GAP_MS / 3_600_000}h for ${perp}: ` +
          `${isoDate(rows[i - 1].t)} -> ${isoDate(rows[i].t)}`,
        );
      }
    }
    out.set(sym, rows);
  }
  return out;
}

// ── funding book (deterministic settled-event lookup) ─────────────────
/** Per-symbol settled funding events (internal "/USD" keys), ascending. Fail-closed on gaps. */
export class FundingBook {
  private ts = new Map<string, number[]>();
  private rates = new Map<string, number[]>();

  constructor(db: Database, symbols: string[], fromMs: number, toMs: number) {
    for (const sym of symbols) {
      const perp = sym.replace("/USD", "USDT");
      const rows = db.prepare(
        `SELECT funding_time t, rate r FROM funding_rates WHERE symbol = ? ORDER BY funding_time ASC`,
      ).all(perp) as Array<{ t: number; r: number }>;
      if (rows.length === 0) throw new Error(`no funding history for ${perp}`);
      const minT = rows[0].t;
      const maxT = rows[rows.length - 1].t;
      // Fail closed on missing coverage at the start of the window.
      if (minT > fromMs + 9 * 3_600_000) {
        throw new Error(
          `funding coverage gap: ${perp} starts ${new Date(minT).toISOString()} after window start ${new Date(fromMs).toISOString()}`,
        );
      }
      if (maxT < toMs) {
        throw new Error(
          `funding coverage gap: ${perp} ends ${new Date(maxT).toISOString()} before window end ${new Date(toMs).toISOString()}`,
        );
      }
      // Crypto funding events are scheduled every 8h; tolerate 1h slippage.
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].t - rows[i - 1].t > 9 * 3_600_000) {
          throw new Error(
            `funding gap > 9h for ${perp}: ${new Date(rows[i - 1].t).toISOString()} -> ${new Date(rows[i].t).toISOString()}`,
          );
        }
      }
      this.ts.set(sym, rows.map(x => x.t));
      this.rates.set(sym, rows.map(x => x.r));
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
}

// ── sim broker ────────────────────────────────────────────────────────
export interface SimPosition {
  symbol: string; side: "buy" | "sell"; qty: number; entryPrice: number; entryAt: number; entryMargin: number;
  /** Commission charged at open (already deducted from cash there). Netted into ClosedTrade.pnl at close. */
  entryCommission?: number;
  /** Running net cash impact of funding since entry (positive = credit received, negative = cost paid; already applied to cash as it accrued). Netted into ClosedTrade.pnl at close. */
  fundingCashDelta?: number;
  /** Entry-anchored hard-stop distance (FRACTION) resolved at open from the
   *  broker's HardStopSpec; null = no hard stop for this position (mode
   *  "none"); undefined = legacy path (broker-level fixed hardStopPct). */
  stopFrac?: number | null;
  /** Best CLOSE of a CLOSED bar seen since entry (max for longs, min for
   *  shorts); initialized to entryPrice at open, updated by checkStops
   *  EVERY tick regardless of whether profitLock is configured. */
  peakPrice?: number;
  /** Profit-lock ratchet level (price), or null while unarmed / when
   *  profitLock isn't configured. Monotonic once armed: never retreats
   *  (max for longs, min for shorts — see checkStops). */
  lockLevel?: number | null;
}
export interface ClosedTrade {
  symbol: string; side: "buy" | "sell"; pnl: number; exitAt: number; reason: string;
  /** Optional entry/exit metadata (additive, 2026-08-06) for op-by-op live-vs-sim
   *  comparison (research). Absent on rows produced before this field existed;
   *  not part of candidate identity (hashReplayConfig hashes config only). */
  entryAt?: number; entryPrice?: number; exitPrice?: number; qty?: number;
  /**
   * The engine's own canonical close_reason (TRAIL_STOP_CLOSE_REASON,
   * TIME_STOP_CLOSE_REASON, SLOT_DISPLACED_CLOSE_REASON…), forwarded
   * verbatim from MomentumEngine's closePosition action. Deliberately a
   * SEPARATE field from `reason`: `reason` is the SimBroker-level
   * classification ("rebalance"/"stop_loss"/"liquidation"/"fold_end") that
   * scripts/regression-fingerprint.test.ts hashes byte-for-byte
   * (tradesSha256 over symbol|side|pnl|exitAt|reason) — collapsing the
   * engine's richer label into `reason` would silently change that anchor
   * for every trail/time-stop close. `engineCloseReason` carries the
   * richer label without touching it; absent on every close that isn't a
   * closePosition() call with a closeReason set (stop_loss/liquidation/
   * fold_end, and any signal-flip close).
   */
  engineCloseReason?: string;
}

/**
 * Bar-level fill for a stop at an already-resolved price LEVEL (gaps fill
 * at the bar open, otherwise at the level itself). Shared by the hard stop
 * and the profit-lock ratchet — both are just different ways of arriving
 * at a level; the fill mechanics are identical.
 */
export function stopFillPrice(pos: Pick<SimPosition, "side">, bar: OHLCV, level: number): number | null {
  if (pos.side === "buy") {
    if (bar.open <= level) return bar.open;
    return bar.low <= level ? level : null;
  }
  if (bar.open >= level) return bar.open;
  return bar.high >= level ? level : null;
}

/** Legacy wrapper: resolves the fixed entry-anchored hard-stop level from
 *  entryPrice/stopPct, then defers to stopFillPrice. Kept exported with its
 *  original signature so every pre-existing call site/test is untouched. */
export function hardStopFillPrice(pos: Pick<SimPosition, "side" | "entryPrice">, bar: OHLCV, stopPct = HARD_SL_PCT): number | null {
  const level = pos.side === "buy" ? pos.entryPrice * (1 - stopPct) : pos.entryPrice * (1 + stopPct);
  return stopFillPrice(pos, bar, level);
}

export function annualizationPeriods(sleeve: Pick<Sleeve, "name">, cadenceMin: number): number {
  if (sleeve.name === "stocks") {
    // A cadence at or above one full RTH session (390 minutes — e.g. the
    // 1440 daily-bar cadence) is one decision per TRADING day ⇒ 252
    // periods/yr; the naive 252×390/1440 would understate to 68/yr. Every
    // pre-existing sub-session cadence (60/120/240) divides unchanged.
    return (252 * 390) / Math.min(cadenceMin, 390);
  }
  return (365 * 24 * 60) / cadenceMin;
}

/**
 * Canonical close_reason for a slot-displacement close (a held symbol
 * bumped out of its slot by a higher-ranked candidate under
 * `tsm.slotHysteresis`). Campo provisto por src/strategies/momentum
 * (stream paralelo): `MomentumEngine.ts` will export
 * `SLOT_DISPLACED_CLOSE_REASON` with this exact string once that stream
 * lands. Declared locally (not imported) so this file typechecks whether
 * or not the export exists yet in this checkout; the VALUE is what
 * matters for matching `ClosedTrade.engineCloseReason`, not the binding's
 * origin.
 */
export const SLOT_DISPLACED_CLOSE_REASON = "SLOT_DISPLACED";

/**
 * Stable bucket key for an entry-block reason (RiskGuard.pauseReason /
 * RegimeFilter.reason / the engine's own equity/realised-pnl fail-closed
 * messages), used to aggregate `gateBlocks` without the numeric noise
 * (percentages, timestamps) that would otherwise fragment an identical
 * reason into many distinct keys. Takes the part before the first ":"
 * when present (RegimeFilter / sharpe-gate format "label: details");
 * otherwise strips a leading numeric count ("5 consecutive…") and
 * truncates at the first remaining digit or parenthetical/em-dash detail
 * block. Examples: "volatility spike: realized vol 3.00×…" → "volatility
 * spike"; "soft drawdown 12.3% — paused 24h" → "soft drawdown"; "daily
 * loss cap 3.50% — paused until…" → "daily loss cap"; "sharpe gate: 0.12
 * < 0 (30d)" → "sharpe gate".
 */
export function normalizeGateReason(reason: string): string {
  let base = reason;
  const colon = base.indexOf(":");
  if (colon > 0) base = base.slice(0, colon);
  base = base.replace(/^\d+\s+/, ""); // leading count, e.g. "5 consecutive…"
  const digit = base.search(/\d/);
  if (digit > 0) base = base.slice(0, digit);
  base = base.split(" — ")[0].split(" (")[0];
  return base.trim().toLowerCase();
}

/**
 * Aggregate a 1h (or any intraday) bar series into UTC daily closes for the
 * market-trend gate: one entry per UTC calendar day, `close` = close of the
 * LAST bar inside that day, `dayEndMs` = exclusive end of the day (UTC
 * midnight AFTER it). A day is only causally observable once `now >=
 * dayEndMs` — SimBroker.fetchDailyCloses enforces that cut, this function
 * just builds the lookup arrays. Pure/exported for unit tests.
 */
export function dailyClosesFromBars(bars: OHLCV[]): { dayEndMs: number[]; closes: number[] } {
  const dayEndMs: number[] = [];
  const closes: number[] = [];
  for (const b of bars) {
    const end = (Math.floor(b.timestamp / 86_400_000) + 1) * 86_400_000;
    if (dayEndMs.length > 0 && dayEndMs[dayEndMs.length - 1] === end) {
      closes[closes.length - 1] = b.close; // later bar in the same UTC day
    } else {
      dayEndMs.push(end);
      closes.push(b.close);
    }
  }
  return { dayEndMs, closes };
}

/** Aggregate one block reason per tick (undefined = tick wasn't blocked)
 *  into counts keyed by `normalizeGateReason`. Pure so it's unit-testable
 *  without running a full replay. */
export function aggregateGateBlocks(reasons: Array<string | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reasons) {
    if (!r) continue;
    const key = normalizeGateReason(r);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Annualized turnover: total |notional| moved by every open AND close
 * (each counted once, at its execution price — slippage included, matching
 * SimBroker's own accounting) divided by mean equity over the window and by
 * the window's length in years. Equity mean falls back to `initialEquity`
 * when the window produced no equity-history point (e.g. a fold with zero
 * decision ticks).
 */
export function computeTurnoverAnnual(
  turnoverNotional: number,
  equityHistory: Array<{ t: number; eq: number }>,
  fromMs: number,
  toMs: number,
  initialEquity: number,
): number {
  const avgEquity = equityHistory.length > 0
    ? equityHistory.reduce((s, e) => s + e.eq, 0) / equityHistory.length
    : initialEquity;
  const years = (toMs - fromMs) / (365 * 86_400_000);
  if (!(avgEquity > 0) || !(years > 0)) return 0;
  return turnoverNotional / avgEquity / years;
}

/**
 * Gross-exposure diagnostic hooks (G batch, 2026-10-05 — docs/reports/
 * G-gross-cap.md). Both null by default = zero behavior change on every
 * existing chain (and no candidate/config hash is touched: this is observer
 * instrumentation, not config). Set ONLY by scripts/diag-gross-cap.ts:
 *  - onOpenAttempt fires at the TOP of every sim openPosition attempt with
 *    the book's current marked gross notional, the attempted new notional
 *    and the denominator the live cap uses (mark-to-market equity on the
 *    momentum SimBroker; fixed baseUsd on the meanrev sim).
 *  - onWarn receives every engine warn line (replays otherwise run silent),
 *    so capped diagnostic chains can count "BLOCKED by gross exposure cap".
 */
export const grossCapDiag: {
  onOpenAttempt: ((s: { t: number; grossBefore: number; newNotional: number; denom: number }) => void) | null;
  onWarn: ((msg: string) => void) | null;
} = { onOpenAttempt: null, onWarn: null };

export class SimBroker implements MomentumBrokerAdapter {
  cash: number;
  positions: SimPosition[] = [];
  closed: ClosedTrade[] = [];
  equityHistory: Array<{ t: number; eq: number }> = [];
  now = 0;
  fundingPaid = 0;
  feesPaid = 0;
  /** Total Reg-T margin interest charged so far (A3 axis; 0 when off). */
  marginInterestPaid = 0;
  /** Engine DECISION ticks executed so far — incremented by the replay loop
   *  immediately before each engine.tick(). The post-stop cooldown counts
   *  in these units (engine cadence), NOT in data bars. */
  decisionTicks = 0;
  liquidations = 0;
  marginRejects = 0;
  /** Σ|notional| of every open + close, at execution price (slippage
   *  included). Feeds ReplayResult.turnoverAnnual via computeTurnoverAnnual;
   *  0 unless positions actually trade — no behavior change on its own. */
  turnoverNotional = 0;
  /** symbol → decisionTicks value at which entries unblock (B2 axis). Empty
   *  unless cooldownBarsAfterStop > 0 AND a hard stop actually fired. */
  private cooldownUntilTick = new Map<string, number>();
  feesBySymbol = new Map<string, number>();
  fundingBySymbol = new Map<string, number>();
  private candleWindows = new Map<string, { index: number; limit: number; bars: OHLCV[] }>();

  constructor(
    cash: number,
    private candles: Map<string, OHLCV[]>,
    private slippageBps: number,
    private commissionBps: number,
    private barDurationMs: number,
    private margin: { leverage: number; maintRate: number },
    private hardStopPct = HARD_SL_PCT,
    private fundingBook?: FundingBook,
    private isStock = false,
    /** Optional stop-axis override; absent = legacy fixed `hardStopPct`. */
    private hardStopSpec?: HardStopSpec,
    /** Bars per trading day for volScaled realized-vol scaling (78 on 5m RTH stocks, 24 on 1h crypto). */
    private barsPerDay = 1,
    /** Annual Reg-T financing rate as a FRACTION (e.g. 0.075 = 7.5%/yr).
     *  0 = no margin interest — the legacy path, byte for byte. */
    private marginInterestAnnualRate = 0,
    /** Decision bars a symbol stays blocked for NEW entries after a
     *  hard-stop close. 0 = off — the legacy path, byte for byte. */
    private cooldownBarsAfterStop = 0,
    /** Per-instance short-funding mode (credit/zero — see the CLI flag
     *  docstring at the top of this file). Defaults to the module-level CLI
     *  constant so every pre-existing call site (tests included) that omits
     *  this param keeps its exact prior behavior; runWithConfig now passes
     *  `cfg.shortFunding` explicitly instead of relying on the CLI global,
     *  which is the fix for the config having been hashed but never read. */
    private shortFundingMode: "credit" | "zero" = shortFunding,
    /** Profit-lock axis (opt-in, third stop mechanism — see ProfitLockSpec).
     *  Absent = off, the legacy checkStops path byte for byte. */
    private profitLock?: ProfitLockSpec,
  ) { this.cash = cash; }

  closedIndex(candles: OHLCV[], t: number): number {
    let lo = 0, hi = candles.length - 1;
    if (candles[0].timestamp + this.barDurationMs > t) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (candles[mid].timestamp + this.barDurationMs <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  price(symbol: string, t: number): number {
    const c = this.candles.get(symbol);
    if (!c || c.length === 0) return 0;
    const index = this.closedIndex(c, t);
    return index >= 0 ? c[index].close : 0;
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

  async openPosition(a: { symbol: string; side: "buy" | "sell"; notionalUsd: number }) {
    // Gross-exposure diagnostic (observer only — see grossCapDiag): the
    // engine's cap compares Σ|getOpenPositions().notional| + new against
    // equity × mult, so record exactly those terms at attempt time.
    if (grossCapDiag.onOpenAttempt) {
      let gross = 0;
      for (const p of this.positions) gross += Math.abs(p.qty * this.price(p.symbol, this.now));
      grossCapDiag.onOpenAttempt({ t: this.now, grossBefore: gross, newNotional: a.notionalUsd, denom: this.equityNow() });
    }
    // Post-stop cooldown (B2): entries blocked until the decision-tick
    // counter reaches the mark armed by a "stop_loss" close. The map is
    // empty when the axis is off, so the legacy path is untouched.
    const cooldownUntil = this.cooldownUntilTick.get(a.symbol);
    if (cooldownUntil !== undefined && this.decisionTicks < cooldownUntil) {
      return { ok: false, reason: "cooldown_after_stop" };
    }
    const px = this.executionPrice(a.symbol);
    if (!px || a.notionalUsd <= 0) return { ok: false, reason: "no price" };
    const slip = a.side === "buy" ? px * (1 + this.slippageBps / 10_000) : px * (1 - this.slippageBps / 10_000);
    const rawQty = a.notionalUsd / slip;
    const qty = this.isStock ? Math.floor(rawQty) : rawQty;
    if (qty <= 0) return { ok: false, reason: "zero_qty" };
    const actualNotional = qty * slip;
    const need = actualNotional / this.margin.leverage;
    const used = this.positions.reduce((s, p) => s + p.entryMargin, 0);
    if (used + need > this.equityNow()) { this.marginRejects++; return { ok: false, reason: "margin_insufficient" }; }
    this.turnoverNotional += actualNotional;
    const fee = actualNotional * (this.commissionBps / 10_000);
    this.cash -= fee;
    this.feesPaid += fee;
    this.feesBySymbol.set(a.symbol, (this.feesBySymbol.get(a.symbol) ?? 0) + fee);
    // Resolve the entry-anchored stop distance NOW, from decision-time
    // closes only (closedIndex(now) is the last CLOSED bar — the execution
    // bar at `now` is excluded, so volScaled sees exactly what the live
    // engine would have seen when sizing the stop).
    let stopFrac: number | null | undefined;
    if (this.hardStopSpec) {
      let closes: number[] = [];
      if (this.hardStopSpec.mode === "volScaled") {
        const c = this.candles.get(a.symbol) ?? [];
        const idx = this.closedIndex(c, this.now);
        if (idx >= 0) {
          closes = c.slice(Math.max(0, idx + 1 - (this.hardStopSpec.lookbackBars + 1)), idx + 1).map(b => b.close);
        }
      }
      stopFrac = entryStopFraction(this.hardStopSpec, closes, this.barsPerDay);
    }
    this.positions.push({ symbol: a.symbol, side: a.side, qty, entryPrice: slip, entryAt: this.now, entryMargin: need, entryCommission: fee, fundingCashDelta: 0, stopFrac, peakPrice: slip, lockLevel: null });
    return { ok: true };
  }

  /**
   * Seed the book with positions the LIVE sleeve already held at the
   * replay epoch (OPEN.md P2 "el libro del sim arranca vacío en el
   * epoch"). Called ONCE, before the tick loop starts: every seed becomes
   * a normal SimPosition so slot occupancy, gross-exposure headroom, hard
   * stops AND the engine's own trail/time stops all see it exactly like a
   * position the engine opened itself. No commission is charged and cash
   * is untouched (the entry already happened, before this replay window;
   * `entryMargin` is bookkeeping-only — see openPosition, which never
   * debits it from cash either, only `equityNow()` vs. the margin total).
   */
  seedPositions(seeds: SeedPosition[]): void {
    for (const s of seeds) {
      const entryMargin = (s.qty * s.entryPrice) / this.margin.leverage;
      const stopFrac = this.hardStopSpec
        ? seedStopFraction(s, this.hardStopSpec, this.hardStopPct)
        : undefined; // legacy path: no stop-axis override configured — same sentinel as a fresh open's checkStops fallback.
      this.positions.push({
        symbol: s.symbol, side: s.side, qty: s.qty, entryPrice: s.entryPrice, entryAt: s.entryAt,
        entryMargin, entryCommission: 0, fundingCashDelta: 0, stopFrac, peakPrice: s.entryPrice, lockLevel: null,
      });
    }
  }

  async closePosition(a: { symbol: string; side: "buy" | "sell"; closeReason?: string }) {
    // `reason` stays the legacy SimBroker classification ("rebalance") byte
    // for byte — scripts/regression-fingerprint.test.ts hashes it. The
    // engine's own canonical label (TRAIL_STOP/TIME_STOP/SLOT_DISPLACED…)
    // is carried separately on `engineCloseReason` (see ClosedTrade docstring).
    // Stamped 1 ms AFTER the decision instant, like live: an engine close
    // fills seconds after the tick's `now`, which becomes the RiskGuard
    // loss-streak anchor, so the next tick's getRealisedPnlSince(anchor)
    // counts it. Stamped AT `now` (before 2026-10-03), `exitAt > anchor`
    // excluded it forever: the replay's streak only ever saw hard-stop
    // losses and never reset, pausing after every 5 stops, where live pauses
    // after 5 consecutive losing periods (momentum_crypto parity, 2026-10-02
    // 19:00). Hard stops stay at `now`: they fill inside the bar that just
    // closed and are read by THIS tick.
    return this.closeAt(a.symbol, a.side, this.executionPrice(a.symbol), "rebalance", a.closeReason, this.now + 1);
  }

  private executionPrice(symbol: string): number {
    const c = this.candles.get(symbol) ?? [];
    // Daily-bar stocks path: the next session's bar does NOT start exactly at
    // decision time `now` (weekends, holidays, DST hour shifts), so the exact
    // timestamp match below would silently kill every Friday fill. Fill at
    // the OPEN of the first bar AFTER the last CLOSED bar instead — the
    // close→next-open convention, no lookahead: the decision at `now` only
    // ever saw bars closed by `now` (closedIndex), and the execution bar is
    // strictly later. Sub-daily paths below are byte-identical.
    if (this.isStock && this.barDurationMs >= 86_400_000) {
      const lastClosed = this.closedIndex(c, this.now);
      if (lastClosed < 0) return 0; // no decision bar yet
      const exec = c[lastClosed + 1];
      return exec ? exec.open : 0;
    }
    const idx = c.findIndex(b => b.timestamp === this.now);
    if (idx <= 0) return 0; // no execution bar or no preceding decision bar
    const exec = c[idx];
    const prev = c[idx - 1];
    // For crypto (continuous 24/7), the execution bar must be the immediate next bar.
    if (!this.isStock && exec.timestamp - prev.timestamp !== this.barDurationMs) return 0;
    return exec.open;
  }

  closeAt(symbol: string, side: "buy" | "sell", px: number, reason: string, engineCloseReason?: string, exitAt: number = this.now) {
    const idx = this.positions.findIndex(p => p.symbol === symbol && p.side === side);
    if (idx < 0 || !px) return { ok: false, reason: "no position/price" };
    const p = this.positions[idx];
    const slip = side === "buy" ? px * (1 - this.slippageBps / 10_000) : px * (1 + this.slippageBps / 10_000);
    this.turnoverNotional += p.qty * slip;
    const gross = (slip - p.entryPrice) * p.qty * (side === "buy" ? 1 : -1);
    const fee = p.qty * slip * (this.commissionBps / 10_000);
    this.cash += gross - fee;
    this.feesPaid += fee;
    this.feesBySymbol.set(symbol, (this.feesBySymbol.get(symbol) ?? 0) + fee);
    // Net economic pnl: gross trading result minus entry+exit commission,
    // plus/minus accrued funding cash impact. Cash accounting above is
    // UNCHANGED — every component was already applied to cash as it
    // happened (entry fee at open, funding as it settled, gross-fee here).
    // This is a reporting-only derived value consumed by win rate,
    // expectancy, and concentration.
    const netPnl = gross - (p.entryCommission ?? 0) - fee + (p.fundingCashDelta ?? 0);
    this.closed.push({ symbol, side, pnl: netPnl, exitAt, reason, entryAt: p.entryAt, entryPrice: p.entryPrice, exitPrice: slip, qty: p.qty, ...(engineCloseReason !== undefined ? { engineCloseReason } : {}) });
    this.positions.splice(idx, 1);
    // Arm the post-stop cooldown ONLY on the sim's hard-stop close
    // ("stop_loss" — produced exclusively by checkStops). Every engine-side
    // exit (signal flip, vol trail, time stop) arrives via closePosition as
    // "rebalance", and "liquidation"/"fold_end" are terminal — none arm it.
    // Re-entry is allowed at the Nth decision tick after the last tick
    // completed before the stop (so N=4 re-enters exactly 4 decision bars
    // after the stop; N<=1 degenerates to the legacy next-bar re-entry).
    if (reason === "stop_loss" && this.cooldownBarsAfterStop > 0) {
      this.cooldownUntilTick.set(symbol, this.decisionTicks + this.cooldownBarsAfterStop);
    }
    return { ok: true };
  }

  /** Bar-level hard stop using OHLC extremes; gaps fill at the bar open.
   *  Per-position distance (stop-axis sweep): null = no hard stop (mode
   *  "none"), undefined = legacy broker-level fixed hardStopPct.
   *
   *  Profit-lock (opt-in, `this.profitLock` — see ProfitLockSpec):
   *  `peakPrice` is updated from `bar.close` EVERY tick, whether or not
   *  the axis is configured, so enabling it later never depends on
   *  history it didn't collect. Once peak-vs-entry gain reaches
   *  `armAtPct`, `lockLevel` arms and can only ratchet in the profitable
   *  direction (max for longs, min for shorts) — it never retreats. The
   *  EFFECTIVE stop level is whichever of {hard, lock} is tighter (max for
   *  longs, min for shorts: either can be hit first as price moves adverse
   *  to the position), and `closeAt`'s reason records which one fired:
   *  "profit_lock" when the lock is the (strictly) tighter level,
   *  "stop_loss" otherwise (including every pre-arm/legacy/no-lock case). */
  checkStops(barBySymbol: Map<string, OHLCV>) {
    for (const p of [...this.positions]) {
      const bar = barBySymbol.get(p.symbol);
      if (!bar || bar.timestamp < p.entryAt) continue;

      p.peakPrice = p.side === "buy"
        ? Math.max(p.peakPrice ?? p.entryPrice, bar.close)
        : Math.min(p.peakPrice ?? p.entryPrice, bar.close);

      const frac = p.stopFrac === undefined ? this.hardStopPct : p.stopFrac;
      const hardLevel = frac === null ? null : (p.side === "buy" ? p.entryPrice * (1 - frac) : p.entryPrice * (1 + frac));

      if (this.profitLock) {
        const peak = p.peakPrice;
        const gainPct = p.side === "buy"
          ? ((peak - p.entryPrice) / p.entryPrice) * 100
          : ((p.entryPrice - peak) / p.entryPrice) * 100;
        if (gainPct >= this.profitLock.armAtPct) {
          const { mode, lockPct } = this.profitLock;
          const candidate = mode === "breakeven"
            ? (p.side === "buy" ? p.entryPrice * (1 + lockPct / 100) : p.entryPrice * (1 - lockPct / 100))
            : (p.side === "buy" ? peak * (1 - lockPct / 100) : peak * (1 + lockPct / 100));
          p.lockLevel = p.side === "buy"
            ? Math.max(p.lockLevel ?? -Infinity, candidate)
            : Math.min(p.lockLevel ?? Infinity, candidate);
        }
      }

      const lockLevel = p.lockLevel ?? null;
      let effectiveLevel: number | null;
      let triggeredByLock: boolean;
      if (p.side === "buy") {
        const hardEff = hardLevel ?? -Infinity;
        const lockEff = lockLevel ?? -Infinity;
        effectiveLevel = Math.max(hardEff, lockEff) === -Infinity ? null : Math.max(hardEff, lockEff);
        triggeredByLock = lockEff > hardEff;
      } else {
        const hardEff = hardLevel ?? Infinity;
        const lockEff = lockLevel ?? Infinity;
        effectiveLevel = Math.min(hardEff, lockEff) === Infinity ? null : Math.min(hardEff, lockEff);
        triggeredByLock = lockEff < hardEff;
      }
      if (effectiveLevel === null) continue;

      const fill = stopFillPrice(p, bar, effectiveLevel);
      if (fill !== null) { this.closeAt(p.symbol, p.side, fill, triggeredByLock ? "profit_lock" : "stop_loss"); }
    }
  }

  /**
   * Liquidate everything at 1% adverse (+ normal slippage) when equity <
   * maintenance margin on current notional. Returns true on ruin (equity ≤ 0).
   */
  checkLiquidation(): boolean {
    const notional = this.positions.reduce((s, p) => s + p.qty * (this.price(p.symbol, this.now) || p.entryPrice), 0);
    if (this.positions.length > 0 && this.equityNow() < notional * this.margin.maintRate) {
      for (const p of [...this.positions]) {
        const mark = this.price(p.symbol, this.now) || p.entryPrice;
        this.closeAt(p.symbol, p.side, p.side === "buy" ? mark * 0.99 : mark * 1.01, "liquidation");
      }
      this.liquidations++;
    }
    return this.equityNow() <= 0;
  }

  /**
   * REAL funding: every settled event in (prevT, eventEndMs] charges/credits
   * notional × rate. Positive rate: longs pay, shorts receive; negative
   * rate flips both. Fail-closed: the FundingBook constructor already
   * verified coverage up to window end.
   *
   * `eventEndMs` defaults to `t` (in-loop tick calls: the fold is still
   * open, an event exactly at the current tick is legitimately settled).
   * The terminal fold-end call passes `toMs - 1` instead — a fold's data
   * window is `[fromMs, toMs)`, so an event exactly AT `toMs` belongs to
   * the NEXT fold, not this one; the price snapshot itself still prices at
   * `t` (the last available close), only the event range is capped short.
   */
  applyFunding(prevT: number, t: number, eventEndMs: number = t) {
    if (!this.fundingBook) return;
    for (const p of this.positions) {
      const px = this.price(p.symbol, t);
      if (!px) continue;
      for (const rate of this.fundingBook.eventsBetween(p.symbol, Math.max(prevT, p.entryAt), eventEndMs)) {
        const amt = p.qty * px * rate;
        if (p.side === "buy") {
          this.cash -= amt;
          p.fundingCashDelta = (p.fundingCashDelta ?? 0) - amt;
          this.fundingPaid += amt;
          this.fundingBySymbol.set(p.symbol, (this.fundingBySymbol.get(p.symbol) ?? 0) + amt);
        } else if (this.shortFundingMode === "credit") {
          this.cash += amt;
          p.fundingCashDelta = (p.fundingCashDelta ?? 0) + amt;
          this.fundingPaid -= amt;
          this.fundingBySymbol.set(p.symbol, (this.fundingBySymbol.get(p.symbol) ?? 0) - amt);
        } // shortFunding === "zero": shorts pay/receive nothing
      }
    }
  }

  /**
   * Reg-T margin interest (A3): for every UTC calendar-day boundary crossed
   * in (prevT, t], charge max(0, grossOpenNotional − equity) ×
   * annualRate/365 against cash. Day-count choice (documented, deliberate):
   * CALENDAR days via UTC-midnight crossings — brokers accrue financing on
   * weekends and holidays too (a stock book held Fri→Mon is charged 3
   * days), intraday bars charge nothing until the next midnight, and a full
   * year of daily boundaries yields exactly 365 charges, matching the
   * annualRate/365 daily rate. The debit balance is measured once per call
   * at current bar prices (entry-price fallback), the same notional math
   * checkLiquidation uses. Rate 0 / absent config = strict no-op (legacy).
   */
  accrueMarginInterest(prevT: number, t: number) {
    if (this.marginInterestAnnualRate <= 0 || this.positions.length === 0) return;
    const days = Math.floor(t / 86_400_000) - Math.floor(prevT / 86_400_000);
    if (days <= 0) return;
    const gross = this.positions.reduce((s, p) => s + p.qty * (this.price(p.symbol, t) || p.entryPrice), 0);
    const debit = gross - this.equityNow();
    if (debit <= 0) return;
    const charge = debit * (this.marginInterestAnnualRate / 365) * days;
    this.cash -= charge;
    this.marginInterestPaid += charge;
  }

  /** Market-trend gate data (set by runWithConfig iff cfg.marketTrend is
   *  configured): UTC-daily closes of the gate symbol with their exclusive
   *  day-end timestamps (dailyClosesFromBars). Absent = fetchDailyCloses
   *  returns [] and the engine's gate fails open — the legacy path. */
  marketTrendDaily?: { symbol: string; dayEndMs: number[]; closes: number[] };

  /**
   * MomentumBrokerAdapter.fetchDailyCloses (optional interface method):
   * last `days` closes of UTC days that have FULLY CLOSED at the sim clock
   * (dayEndMs <= now — strict causality: the day the current bar belongs to
   * is never visible, no matter how many of its bars exist in the tape).
   */
  async fetchDailyCloses(symbol: string, days: number): Promise<number[]> {
    const d = this.marketTrendDaily;
    if (!d || d.symbol !== symbol || days <= 0) return [];
    // Binary search: last index whose day END is <= now.
    let lo = 0, hi = d.dayEndMs.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (d.dayEndMs[mid] <= this.now) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return [];
    return d.closes.slice(Math.max(0, ans + 1 - days), ans + 1);
  }

  async fetchCandles(symbol: string, bars: number): Promise<OHLCV[]> {
    const c = this.candles.get(symbol) ?? [];
    if (c.length === 0) return [];
    const index = this.closedIndex(c, this.now);
    if (index < 0) return [];
    let state = this.candleWindows.get(symbol);
    if (!state || state.limit !== bars || index < state.index) {
      state = { index, limit: bars, bars: c.slice(Math.max(0, index + 1 - bars), index + 1) };
      this.candleWindows.set(symbol, state);
      return state.bars;
    }
    for (let i = state.index + 1; i <= index; i++) state.bars.push(c[i]);
    if (state.bars.length > bars) state.bars.splice(0, state.bars.length - bars);
    state.index = index;
    return state.bars;
  }
}

/**
 * Terminal liquidation: close every still-open `broker` position at the last
 * price available strictly inside [fromMs, toMs), through the SAME
 * adverse-slippage/commission/cash/trade accounting as every other close,
 * recorded with reason "fold_end". A missing terminal price fails closed
 * (throws) — silently dropping the position would hide P&L instead of
 * losing it explicitly. No-op when `ruined` (checkLiquidation already
 * flattened every position with reason "liquidation"). Caller must set
 * `broker.now = toMs` first so closed trades record the right `exitAt`.
 */
export function liquidateAtFoldEnd(broker: SimBroker, fromMs: number, toMs: number, ruined: boolean): void {
  if (ruined) return;
  for (const p of [...broker.positions]) {
    const px = broker.price(p.symbol, toMs);
    if (!px) {
      throw new Error(`fold_end liquidation: no terminal price for ${p.symbol} in [${isoDate(fromMs)}, ${isoDate(toMs)})`);
    }
    const res = broker.closeAt(p.symbol, p.side, px, "fold_end");
    if (!res.ok) {
      throw new Error(`fold_end liquidation failed for ${p.symbol}: ${res.reason}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Explicit resolved-config replay (extracted so walk-forward.ts can call it)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parameters for the daily Connors mean-reversion replay
 * (scripts/meanrev-replay.ts). Lives inside ReplayConfig so candidate
 * identity (hashReplayConfig) covers every field that changes execution —
 * two meanrev candidates that differ only here must hash differently.
 */
export interface MeanRevSimParams {
  entryRsi: number;
  smaLong: number;
  smaExit: number;
  timeStopDays: number;
  maxPositions: number;
  /** slot notional = initialEquity × slotPct (fixed, NO equity feedback — production parity). */
  slotPct: number;
}

/** Canonical, fully-resolved replay configuration. */
export interface ReplayConfig {
  sleeve: string;
  universe: string[];
  timeframe: string;
  source: string;
  refSymbol: string;
  rthOnly: boolean;
  funding: boolean;
  barMinutes: number;
  barMinutesEq: number;
  slippageBps: number;
  commissionBps: number;
  initialEquity: number;
  leverage: number;
  hardStopPct: number;
  /** Stop-axis override (sweepable per candidate). Absent = fixed at
   *  hardStopPct (legacy behavior; absent keys don't change old hashes). */
  hardStop?: HardStopSpec;
  /** Profit-lock axis (opt-in third stop mechanism — see ProfitLockSpec).
   *  Absent = off, legacy hash. */
  profitLock?: ProfitLockSpec;
  /** Reg-T margin financing (A3, cost-config knob): each UTC calendar day
   *  (weekends included — the broker charges those too) the sim debits
   *  max(0, grossOpenNotional − equity) × annualRate/365. Closes the ~7pp/yr
   *  optimistic bias on 2×-gross stock sleeves whose borrow was free in the
   *  sim. Absent = 0 charges (legacy; absent keys don't change old hashes). */
  marginInterest?: { annualRate: number };
  cadenceMin: number;
  notionalPctPerSlot: number;
  entryPct: number;
  exitPct: number;
  maxLongs: number;
  maxShorts: number;
  /** TSM lookback horizon in bar-math DAYS (TimeSeriesMomentum.lookbackDays;
   *  trading days on stocks via barMinutesEq, calendar days on crypto).
   *  Sweepable (the horizon axis — Jegadeesh-Titman 3-12m continuation vs
   *  the inherited 14d default). Also drives runWithConfig's historyBars.
   *  Absent = engine default (14) AND the legacy hash (undefined keys are
   *  dropped by canonicalJson). */
  lookbackDays?: number;
  /** TSM moving-average length in bar-math DAYS (maLengthDays trend filter).
   *  Absent = engine default (30) AND the legacy hash. */
  maLengthDays?: number;
  /** TSM multi-horizon signal (TSMConfig.lookbackDaysList — Hurst/Ooi/
   *  Pedersen 2017): r = mean of the lookback returns over each horizon
   *  (bar-math days); thresholds apply to the blended r, MA unchanged.
   *  Mutually exclusive with lookbackDays (walk-forward validator). Also
   *  drives runWithConfig's historyBars via the LONGEST horizon. Absent =
   *  single-horizon AND the legacy hash. */
  lookbackDaysList?: number[];
  /** Post-hard-stop re-entry cooldown in DECISION bars (B2, sweepable):
   *  after a "stop_loss" close the symbol is blocked for new entries until
   *  the Nth decision tick after the stop; trail/signal-flip closes
   *  ("rebalance") never arm it. Observed churn motivating the axis:
   *  SOL/USDC stopped 2026-09-02 10:32 and re-entered 11:24 the same day;
   *  GLD 5 entries in 14 days; NVDA re-entered the day after a −$621
   *  trail-stop. 0/absent = off (0 is normalized to absent by the config
   *  builders, so both keep the legacy hash). */
  cooldownBarsAfterStop?: number;
  shortFunding: "credit" | "zero";
  tsmTrail?: TrailStopConfig;
  sharpeGate?: { lookbackDays: number; minSharpe: number };
  volTarget?: VolTargetConfig;
  /** Inverse-volatility ENTRY sizing passthrough
   *  (MomentumEngineConfig.volSizing — the sim instantiates the REAL
   *  engine, so the exact production formula runs): notional = equity ×
   *  notionalPctPerSlot × clamp(σ_ref/σᵢ, minScale, maxScale). Absent =
   *  OFF (legacy sizing AND the legacy hash). */
  volSizing?: VolSizingConfig;
  /** Aggregate gross-exposure backstop, passed straight to
   *  MomentumEngineConfig.maxGrossExposureMult (the sim instantiates the
   *  REAL engine, so this is the same runtime check prod enforces). Absent
   *  = OFF, matching the engine default — absent keys don't change
   *  pre-existing hashes. */
  maxGrossExposureMult?: number;
  /** RegimeFilter passthrough (merged with the always-injected `barMinutes`
   *  derived from barMinutesEq — see runWithConfig). `enabled: false` turns
   *  the filter off entirely; other keys reach RegimeFilterConfig verbatim.
   *  Absent = engine defaults (legacy hash — the field itself, not its
   *  contents, is what enters hashReplayConfig). */
  regime?: { enabled?: boolean; [k: string]: unknown };
  /** TSM slot-hysteresis passthrough. Campo provisto por
   *  src/strategies/momentum (stream paralelo) — TSMConfig may not declare
   *  `slotHysteresis` yet in this checkout; wired defensively in
   *  runWithConfig. Absent = legacy hash. */
  slotHysteresis?: boolean;
  /** Time barrier (engine-level, sweepable). Absent = OFF — production
   *  incumbent behavior; absent keys don't change pre-existing hashes. */
  timeStop?: TimeStopConfig;
  /** Market-trend entry gate (engine-level, sweepable, 2026-09-24): blocks
   *  NEW entries while the gate symbol's last CLOSED UTC daily close is
   *  below its maDays SMA. Daily closes come from the sleeve's own 1h bars
   *  aggregated to UTC days with history loaded BEFORE the window start
   *  (no lookahead — see runWithConfig). Absent = OFF, legacy hash. */
  marketTrend?: MarketTrendGateConfig;
  risk?: Partial<RiskGuardConfig>;
  /** Present iff sleeve === "meanrev": routes the trial to runMeanRevReplay. */
  meanrev?: MeanRevSimParams;
  /**
   * Point-in-time index universe (research, 2026-10-02 — daily stocks
   * replays only): the replay universe becomes cfg.universe (the DECLARED
   * symbols — always entry-eligible, fully fail-closed validated) PLUS
   * every `index` member (index_membership table, scripts/
   * import-sp500-membership.ts) whose membership tramo overlaps the fold
   * window, minus `exclude` (e.g. the momentum sleeve's symbols, to keep
   * the shared-wallet disjunction). Member ENTRY eligibility is evaluated
   * per decision date via the engine's entryEligibility hook (member at d,
   * fresh bar within the daily-calendar tolerance, rankable history);
   * members' data presence is therefore checked PER TRAMO at decision
   * time, not across the whole window. A held position whose symbol
   * leaves the index keeps its normal exit rules; a symbol whose series
   * ENDS inside the fold (delisting) is closed at its last available bar
   * with reason "DELISTED" — declared OPTIMISTIC: the real last negotiable
   * print can be worse than the last recorded close. Absent = the exact
   * legacy replay AND the legacy hash (canonicalJson drops undefined).
   */
  membership?: { index: string; exclude?: string[] };
  /**
   * Point-in-time liquidity screen on top of `membership` (requires it):
   * at each decision date, only the `topN` members by MEDIAN dollar volume
   * (close×volume) over the `lookbackSessions` CLOSED sessions before the
   * decision are entry-eligible — strictly backward-looking (see
   * scripts/lib/membership.ts medianDollarVolume). Declared symbols are
   * never screened. Absent = all members eligible AND the legacy hash.
   */
  liquidityRank?: { topN: number; lookbackSessions: number };
  warmupDays: number;
  dbPath: string;
}

export interface ReplayResult {
  sleeve: string;
  window: { label: string; from: string; to: string };
  fromMs: number;
  toMs: number;
  config: ReplayConfig;
  finalEquity: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number;
  trades: number;
  tradesPerDay: number;
  expectancy: number;
  fees: number;
  funding: number;
  /** Total Reg-T margin interest charged (A3); 0 when the axis is off.
   *  Optional so pre-existing artifacts and the meanrev runner (which does
   *  not model financing — leverage 1) stay type-valid; consumers `?? 0`. */
  marginInterest?: number;
  liquidations: number;
  marginRejects: number;
  ruined: boolean;
  bench: number;
  dailyReturns: Array<{ date: string; ret: number }>;
  sessionReturns: Array<{ from: string; to: string; ret: number }>;
  tradesBySymbol: Record<string, { trades: number; grossPnl: number; fees: number; funding: number }>;
  equityHistory: Array<{ t: number; eq: number }>;
  closedTrades: ClosedTrade[];
  /** Total turnover (Σ|notional| of every open+close) annualized against
   *  mean equity and window length — see computeTurnoverAnnual. Output
   *  only, always computed; not part of candidate identity. */
  turnoverAnnual: number;
  /** Count of closedTrades whose reason is SLOT_DISPLACED_CLOSE_REASON.
   *  Output only, always computed; not part of candidate identity. */
  displacementCloses: number;
  /** Count of closedTrades whose reason is "profit_lock" (SimBroker.checkStops
   *  fired the profit-lock ratchet instead of the hard stop). Output only,
   *  always computed (0 when profitLock is absent); not part of candidate
   *  identity. */
  profitLockCloses: number;
  /** Entry-block reasons this fold hit, aggregated by normalizeGateReason.
   *  Output only, always computed; not part of candidate identity. */
  gateBlocks: Record<string, number>;
  /** Per-tick block timeline: one entry per BLOCKED decision tick, with the
   *  tick's sim time and its normalizeGateReason bucket. Diagnostic output
   *  only (pause-episode durations, blocked-days accounting); not part of
   *  candidate identity, stripped from summary.json by writeOutputs (kept
   *  in runs.jsonl). Optional: artifacts persisted before 2026-09-24 lack it. */
  blockedTicks?: Array<{ t: number; reason: string }>;
  /** Drawdown-scaled entry sizing telemetry (risk.ddScale opt-in): count of
   *  decision ticks whose risk verdict carried an entryScale, how many of
   *  those sat below 1 (entries actually scaled), the mean factor, and the
   *  minimum observed. Output only — present ONLY when the engine reported
   *  the field (i.e. the candidate configured risk.ddScale); legacy runs
   *  keep the exact pre-existing result shape. Not part of candidate
   *  identity (that's config-hash territory: risk.ddScale itself). */
  ddScaleStats?: { ticks: number; ticksBelowOne: number; meanScale: number; minScale: number };
  hash: string;
  /** RiskGuard state at replay end. Runtime-only — carries fold-to-fold continuity in walk-forward.ts. */
  finalRiskState: RiskState;
}

/** Deterministic canonical JSON string for hashing. Recursive key sort. */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, (key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) sorted[k] = (value as Record<string, unknown>)[k];
      return sorted;
    }
    return value;
  });
}

/** SHA-256 of a canonical replay config, excluding runtime-only dbPath. */
export function hashReplayConfig(cfg: ReplayConfig): string {
  const { dbPath, ...semanticCfg } = cfg;
  return createHash("sha256").update(canonicalJson(semanticCfg)).digest("hex");
}

/** Build a ReplayConfig from the legacy Sleeve + CLI overrides. */
export function buildReplayConfig(
  sleeve: Sleeve,
  win: { label: string; from: string; to: string },
  cadenceMin: number,
  exposure: number,
  overrides: {
    slippageBps?: number;
    commissionBps?: number;
    shortFunding?: "credit" | "zero";
    dbPath?: string;
  } = {},
): ReplayConfig {
  return {
    sleeve: sleeve.name,
    universe: [...sleeve.universe],
    timeframe: sleeve.timeframe,
    source: sleeve.source,
    refSymbol: sleeve.refSymbol,
    rthOnly: sleeve.rthOnly,
    funding: sleeve.funding,
    barMinutes: sleeve.barMinutes,
    barMinutesEq: sleeve.barMinutesEq,
    slippageBps: overrides.slippageBps ?? sleeve.slippageBps,
    commissionBps: overrides.commissionBps ?? sleeve.commissionBps,
    initialEquity: sleeve.initialEquity,
    leverage: sleeve.leverage,
    hardStopPct: sleeve.hardStopPct,
    cadenceMin,
    notionalPctPerSlot: (argOf("--slot") ? slotPct : sleeve.notionalPctPerSlot) * exposure,
    entryPct,
    exitPct,
    maxLongs,
    maxShorts,
    // `|| undefined` normalizes 0/NaN to ABSENT: off must keep the legacy hash.
    cooldownBarsAfterStop: cooldownBarsAfterStopArg || undefined,
    shortFunding: overrides.shortFunding ?? shortFunding,
    tsmTrail: tsmTrail ?? sleeve.tsmTrail,
    sharpeGate: sharpeGate ?? sleeve.sharpeGate,
    volTarget,
    warmupDays: sleeve.name === "stocks" ? Math.ceil(30 * (288 / 78) * 1.6) : 32,
    dbPath: overrides.dbPath ?? "./data/historical.db",
  };
}

export interface RunResult {
  sleeve: string; window: string; cadence: number; exposure: number;
  days: number; trades: number; tradesPerDay: number; winRate: number;
  ret: number; maxDd: number; sharpe: number; expectancy: number;
  fees: number; funding: number; marginInterest: number; bench: number;
  liq: number; rejects: number; ruined: boolean;
}

function emptyTradesBySymbol(universe: string[]): Record<string, { trades: number; grossPnl: number; fees: number; funding: number }> {
  const out: Record<string, { trades: number; grossPnl: number; fees: number; funding: number }> = {};
  for (const s of universe) out[s] = { trades: 0, grossPnl: 0, fees: 0, funding: 0 };
  return out;
}

function bucketKey(t: number, rthOnly: boolean): string {
  return rthOnly ? getETDateKey(t) : new Date(t).toISOString().slice(0, 10);
}

function computeDailyReturns(history: Array<{ t: number; eq: number }>, rthOnly: boolean): Array<{ date: string; ret: number }> {
  if (history.length < 2) return [];
  const out: Array<{ key: string; first: number; last: number }> = [];
  for (const pt of history) {
    const key = bucketKey(pt.t, rthOnly);
    const cur = out[out.length - 1];
    if (cur && cur.key === key) {
      cur.last = pt.eq;
    } else {
      out.push({ key, first: pt.eq, last: pt.eq });
    }
  }
  const rets: Array<{ date: string; ret: number }> = [];
  for (let i = 1; i < out.length; i++) {
    const b = out[i];
    const startEq = out[i - 1].last;
    if (startEq > 0) rets.push({ date: b.key, ret: (b.last - startEq) / startEq });
  }
  return rets;
}

function computeSessionReturns(history: Array<{ t: number; eq: number }>, rthOnly: boolean): Array<{ from: string; to: string; ret: number }> {
  if (history.length < 2) return [];
  const out: Array<{ key: string; firstT: number; lastT: number; first: number; last: number }> = [];
  for (const pt of history) {
    const key = bucketKey(pt.t, rthOnly);
    const cur = out[out.length - 1];
    if (cur && cur.key === key) {
      cur.last = pt.eq;
      cur.lastT = pt.t;
    } else {
      out.push({ key, firstT: pt.t, lastT: pt.t, first: pt.eq, last: pt.eq });
    }
  }
  const rets: Array<{ from: string; to: string; ret: number }> = [];
  for (let i = 1; i < out.length; i++) {
    const b = out[i];
    const startEq = out[i - 1].last;
    if (startEq > 0) rets.push({ from: new Date(out[i - 1].lastT).toISOString(), to: new Date(b.lastT).toISOString(), ret: (b.last - startEq) / startEq });
  }
  return rets;
}

/**
 * Run a single fully-resolved replay.
 * `initialRiskState` seeds RiskGuard for fold-to-fold continuity (walk-forward
 * outer chains) — it is runtime-only, deliberately outside ReplayConfig so it
 * never enters `hashReplayConfig`/candidate identity.
 */
export async function runWithConfig(
  cfg: ReplayConfig,
  win: { label: string; from: string; to: string },
  initialRiskState?: RiskState,
  /** Live positions already open at the replay epoch (win.from) — see
   *  SeedPosition / SimBroker.seedPositions. Absent/empty = the exact
   *  legacy behavior (empty book at the epoch). */
  seedPositions?: SeedPosition[],
): Promise<ReplayResult | null> {
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);

  const warmupDays = cfg.warmupDays;
  const loadFrom = fromMs - warmupDays * 86_400_000;
  // History depth follows the TSM horizon: max(lookback, MA) bar-math days
  // + 1 (rank() needs max(lookbackBars, maBars) + 1 closes) + 10 bars of
  // margin. With the horizon fields ABSENT this is max(14, 30) + 1 = 31
  // days — the exact pre-existing constant, so every legacy replay loads
  // byte-identical history.
  // Multi-horizon: the LONGEST lookback in the list drives history depth
  // (absent list spreads to nothing — legacy expression byte-identical).
  const horizonDays = Math.max(
    cfg.lookbackDays ?? DEFAULT_TSM_CONFIG.lookbackDays,
    ...(cfg.lookbackDaysList ?? []),
    cfg.maLengthDays ?? DEFAULT_TSM_CONFIG.maLengthDays,
  ) + 1;
  const historyBars = Math.ceil((horizonDays * 24 * 60) / cfg.barMinutesEq) + 10;
  const minWarmupBars = historyBars;

  const db = new Database(cfg.dbPath, { readonly: true });
  try {
    // Fail closed: validate bar coverage over the entire [fromMs, toMs) window for all symbols.
    // Build a minimal sleeve object for validation.
    const sleeve: Sleeve = {
      name: cfg.sleeve as "crypto" | "stocks",
      universe: cfg.universe,
      timeframe: cfg.timeframe,
      source: cfg.source,
      barMinutes: cfg.barMinutes,
      barMinutesEq: cfg.barMinutesEq,
      slippageBps: 0,
      commissionBps: 0,
      funding: cfg.funding,
      refSymbol: cfg.refSymbol,
      rthOnly: cfg.rthOnly,
      initialEquity: cfg.initialEquity,
      notionalPctPerSlot: cfg.notionalPctPerSlot,
      leverage: cfg.leverage,
      hardStopPct: cfg.hardStopPct,
      windows: [],
    };
    const validatedBars = validateBarCoverage(db, sleeve, fromMs, toMs);

    // Fail closed: validate funding coverage for crypto.
    if (cfg.funding) {
      validateFundingCoverage(db, cfg.universe, fromMs, toMs);
    }

    // ── point-in-time index membership (cfg.membership — see its docstring)
    // DECLARED symbols stay fully fail-closed validated above; MEMBER
    // symbols are checked PER TRAMO at decision time by the eligibility
    // hook (member at d + fresh bar + rankable history), so a member with
    // no bars simply never becomes eligible. Members with zero bars at all
    // are dropped here with a warn — the downloader's coverage report is
    // the authoritative account of those holes.
    let membershipBook: MembershipBook | undefined;
    let memberSymbols: string[] = [];
    if (cfg.membership) {
      if (cfg.sleeve !== "stocks" || cfg.barMinutes < 1440 || cfg.rthOnly || cfg.funding) {
        throw new Error("membership mode requires the daily stocks sleeve (barMinutes>=1440, rthOnly=false, funding=false)");
      }
      membershipBook = loadMembership(db, cfg.membership.index);
      const excluded = new Set([...(cfg.membership.exclude ?? []), ...cfg.universe]);
      memberSymbols = membersOverlapping(membershipBook, fromMs, toMs).filter(s => !excluded.has(s));
    }

    const candles = new Map<string, OHLCV[]>();
    const loadedMembers: string[] = [];
    for (const sym of cfg.universe) {
      const bars = loadBars(sym, cfg.timeframe, cfg.source, cfg.rthOnly, loadFrom, toMs, db);
      if (bars.length > 0) candles.set(sym, bars);
    }
    for (const sym of memberSymbols) {
      const bars = loadBars(sym, cfg.timeframe, cfg.source, cfg.rthOnly, loadFrom, toMs, db);
      if (bars.length > 0) { candles.set(sym, bars); loadedMembers.push(sym); }
    }
    if (cfg.membership && memberSymbols.length - loadedMembers.length > 0) {
      console.warn(`membership(${cfg.membership.index}): ${memberSymbols.length - loadedMembers.length}/${memberSymbols.length} overlapping members have NO bars in [${win.from}, ${win.to}) and are dropped (see the downloader's coverage report)`);
    }
    /** Replay universe = declared ∪ loaded members (declared order first). */
    const replayUniverse = cfg.membership ? [...cfg.universe, ...loadedMembers] : cfg.universe;
    const ref = candles.get(cfg.refSymbol);
    if (!ref || ref.length === 0) { return null; }

    // Fail closed if any symbol lacks sufficient warmup history.
    for (const sym of cfg.universe) {
      const bars = candles.get(sym);
      if (!bars) { throw new Error(`no data for ${sym}`); }
      const warmupBars = bars.filter(b => b.timestamp < fromMs).length;
      if (warmupBars < minWarmupBars) {
        throw new Error(`insufficient warmup for ${sym}: ${warmupBars} bars < ${minWarmupBars}`);
      }
    }

    const fundingBook = cfg.funding ? new FundingBook(db, cfg.universe, fromMs, toMs) : undefined;

    const barDurationMs = cfg.barMinutes * 60_000;

    // PIT entry-eligibility hook (daily stocks membership mode): a member is
    // entry-eligible at decision time `nowMs` iff it is a member at that
    // date, its last CLOSED bar is within the daily-calendar tolerance
    // (6 calendar days — validateBarDensity's dailyEq rule), and, when
    // cfg.liquidityRank is set, it ranks in the topN by median dollar
    // volume over the lookbackSessions CLOSED sessions before `nowMs`
    // (strictly backward-looking). Declared symbols are always eligible.
    // The per-tick allowed-set is cached on nowMs: the engine calls the
    // hook once per symbol per tick.
    let entryEligibility: ((symbol: string, nowMs: number) => boolean) | undefined;
    if (cfg.membership && membershipBook) {
      const book = membershipBook;
      const declaredSet = new Set(cfg.universe);
      const lr = cfg.liquidityRank;
      let cachedNow = NaN;
      let allowed = new Set<string>();
      entryEligibility = (symbol, nowMs) => {
        if (declaredSet.has(symbol)) return true;
        if (nowMs !== cachedNow) {
          cachedNow = nowMs;
          const fresh: string[] = [];
          for (const sym of loadedMembers) {
            if (!isMemberAt(book, sym, nowMs)) continue;
            const bars = candles.get(sym)!;
            const idx = lastClosedIndex(bars, nowMs, barDurationMs);
            if (idx < 0 || nowMs - bars[idx].timestamp > 6 * 86_400_000) continue;
            fresh.push(sym);
          }
          allowed = lr
            ? topNByDollarVolume(fresh, candles, nowMs, barDurationMs, lr.lookbackSessions, lr.topN)
            : new Set(fresh);
        }
        return allowed.has(symbol);
      };
    }
    const broker = new SimBroker(
      cfg.initialEquity,
      candles,
      cfg.slippageBps,
      cfg.commissionBps,
      barDurationMs,
      {
        leverage: cfg.leverage,
        maintRate: cfg.sleeve === "crypto" ? 0.005 : 0.25,
      },
      cfg.hardStopPct,
      fundingBook,
      cfg.sleeve === "stocks",
      cfg.hardStop,
      (24 * 60) / cfg.barMinutesEq,
      cfg.marginInterest?.annualRate ?? 0,
      cfg.cooldownBarsAfterStop ?? 0,
      cfg.shortFunding,
      cfg.profitLock,
    );
    // Seed the book with live positions already open at the epoch (OPEN.md
    // P2) — BEFORE the tick loop starts, so slots/exposure/stops see them
    // from tick 0. Absent/empty seedPositions = byte-identical legacy
    // empty-book behavior.
    if (seedPositions && seedPositions.length > 0) broker.seedPositions(seedPositions);
    // Market-trend gate data: the gate symbol's own bars, loaded with
    // maDays(+slack) of EXTRA history before the fold start so the very
    // first decision tick already sees a full SMA window — never lookahead
    // (fetchDailyCloses only reveals days whose UTC end <= sim now).
    // Fail closed on insufficient pre-window history: a silently fail-open
    // early stretch would make folds incomparable.
    if (cfg.marketTrend) {
      const { symbol: gateSym, maDays } = cfg.marketTrend;
      const gateFrom = fromMs - (maDays + 15) * 86_400_000;
      const gateBars = loadBars(gateSym, cfg.timeframe, cfg.source, cfg.rthOnly, gateFrom, toMs, db);
      const daily = dailyClosesFromBars(gateBars);
      const closedBeforeStart = daily.dayEndMs.filter(t => t <= fromMs).length;
      if (closedBeforeStart < maDays) {
        throw new Error(`marketTrend: only ${closedBeforeStart} closed ${gateSym} days before window start ${win.from} — need ${maDays}`);
      }
      broker.marketTrendDaily = { symbol: gateSym, dayEndMs: daily.dayEndMs, closes: daily.closes };
    }
    // "silent" still forwards warns to the diagnostic hook (null → no-op):
    // the engine's gross-cap veto only exists as a warn line, and replays
    // otherwise discard it (see grossCapDiag docstring).
    const silent = { info: () => {}, warn: (m: string) => { grossCapDiag.onWarn?.(m); }, error: () => {} };
    // In-memory RiskGuard persistence: load() seeds continuity from the prior
    // fold (walk-forward chains); save() is captured so finalRiskState below
    // is exact even if a fold runs zero ticks (engine.getRiskState() is the
    // authoritative fallback either way).
    // v1-envelope shim over the same risk-only continuity: runWithConfig's
    // API stays RiskState-in/RiskState-out (walk-forward.ts untouched).
    // trailMarks are deliberately NOT chained across folds — each fold
    // constructs a fresh engine over a fresh SimBroker book, so a prior
    // fold's watermarks describe positions that don't exist (and would be
    // pruned against live positions on the first tick anyway).
    let persistedRiskState: RiskState | undefined = initialRiskState;
    // Seed trail watermarks (cfg.tsmTrail only) + time-stop entry anchors
    // for every seeded position — see SeedPosition / seedTrailMark. The
    // watermark is reconstructed from the ALREADY-LOADED candles (the
    // replay's own multi-month warmup easily covers the few days a carried
    // position predates its epoch by, both sleeves this fix targets); the
    // entry anchor is always the real entry time, so a time stop (if
    // configured) counts the position's true hold, not time-since-epoch.
    const seedTrailMarks: Record<string, TrailMark> = {};
    const seedEntryMarks: Record<string, number> = {};
    for (const s of seedPositions ?? []) {
      const key = `${s.symbol}|${s.side}`;
      seedEntryMarks[key] = s.entryAt;
      if (cfg.tsmTrail) seedTrailMarks[key] = seedTrailMark(s, candles.get(s.symbol) ?? [], fromMs);
    }
    const hasSeedState = Object.keys(seedTrailMarks).length > 0 || Object.keys(seedEntryMarks).length > 0;
    const statePersistence: MomentumStatePersistence = {
      load: () => (persistedRiskState || hasSeedState)
        ? {
            v: 1,
            risk: persistedRiskState ?? { ...INITIAL_RISK_STATE },
            ...(Object.keys(seedTrailMarks).length > 0 ? { trailMarks: seedTrailMarks } : {}),
            ...(Object.keys(seedEntryMarks).length > 0 ? { entryMarks: seedEntryMarks } : {}),
          }
        : null,
      save: (s) => { persistedRiskState = s.risk; },
    };
    // Sim clock, injected into the engine (src/utils/clock.ts seam). This
    // replaces the old `(Date as any).now = () => t` monkeypatch, which was
    // fragile by construction: the engine's constructor ran BEFORE the patch
    // (so restoreTrailMarks read wall time), and any default parameter
    // evaluated outside the patched window silently read real time. The
    // clock is set to `t` at exactly the point the patch used to be — every
    // Date.now() the engine formerly saw is now clock.now() with the SAME
    // value, so anchored fingerprints are unaffected.
    const clock = new TestClock(fromMs);
    // slotHysteresis: campo provisto por src/strategies/momentum (stream
    // paralelo) — TSMConfig may not declare it yet in this checkout, so it's
    // added via an index-signature-widened local instead of the plain
    // `Partial<TSMConfig>` literal (which would reject an unknown key).
    // Absent (cfg.slotHysteresis === undefined) leaves tsmCfg byte-identical
    // to the pre-existing literal.
    const tsmCfg: Partial<TSMConfig> & Record<string, unknown> = {
      barMinutes: cfg.barMinutesEq,
      entryThresholdPct: cfg.entryPct,
      exitThresholdPct: cfg.exitPct,
      maxLongs: cfg.maxLongs,
      maxShorts: cfg.maxShorts,
    };
    if (cfg.slotHysteresis !== undefined) tsmCfg.slotHysteresis = cfg.slotHysteresis;
    // TSM horizon axis (2026-09-24): absent keys leave tsmCfg byte-identical
    // to the pre-existing literal (engine defaults 14/30 apply).
    if (cfg.lookbackDays !== undefined) tsmCfg.lookbackDays = cfg.lookbackDays;
    if (cfg.maLengthDays !== undefined) tsmCfg.maLengthDays = cfg.maLengthDays;
    // Multi-horizon axis (2026-09-25): absent leaves tsmCfg byte-identical.
    if (cfg.lookbackDaysList !== undefined) tsmCfg.lookbackDaysList = cfg.lookbackDaysList;
    const engine = new MomentumEngine(
      {
        mode: "time-series",
        universe: replayUniverse,
        // PIT membership hook (absent = byte-identical legacy engine config).
        ...(entryEligibility ? { entryEligibility } : {}),
        rebalanceMinutes: cfg.cadenceMin,
        historyBars,
        notionalPctPerSlot: cfg.notionalPctPerSlot,
        volTarget: cfg.volTarget,
        // volSizing: inverse-vol entry sizing (engine-level opt-in) —
        // undefined = OFF, matching the engine's own default.
        volSizing: cfg.volSizing,
        tsmTrail: cfg.tsmTrail,
        sharpeGate: cfg.sharpeGate,
        timeStop: cfg.timeStop,
        // marketTrend: engine-level gate; the SimBroker above already holds
        // the causal daily-close series (absent cfg leaves this undefined —
        // byte-identical legacy engine config).
        marketTrend: cfg.marketTrend,
        tsm: tsmCfg,
        // regime: cfg.regime passthrough (enabled + thresholds) merged over
        // the always-injected barMinutes — absent cfg.regime leaves this
        // byte-identical to the pre-existing `{ barMinutes: cfg.barMinutesEq }`.
        regime: { barMinutes: cfg.barMinutesEq, ...(cfg.regime ?? {}) },
        scorer: { barMinutes: cfg.barMinutesEq },
        risk: cfg.risk,
        // maxGrossExposureMult: already a MomentumEngineConfig field (prod
        // parity — the sim instantiates the real engine). undefined = OFF,
        // matching the engine's own default.
        maxGrossExposureMult: cfg.maxGrossExposureMult,
      },
      broker,
      silent,
      statePersistence,
      clock,
    );

    // The live maintenance kill-switch (TRADING_ENABLED=false — set e.g. in
    // this decommissioned dev checkout's .env) gates every engine OPEN.
    // Inside a replay it silently produces a complete-looking artifact whose
    // every trial has zero trades (it did: 42/42 zero-trade trials,
    // 2026-08-02, artifact discarded). The simulator models PROD, where the
    // variable is unset — neutralize it for the duration of the replay loop
    // and restore after, the src/test-setup.ts pattern. An external
    // `env -u TRADING_ENABLED` CANNOT do this job: src/config's dotenv
    // already repopulated process.env from .env at import time.
    const prevTradingEnabled = process.env.TRADING_ENABLED;
    delete process.env.TRADING_ENABLED;
    const cadenceMs = cfg.cadenceMin * 60_000;
    let lastTick = fromMs - cadenceMs;
    let prevT = 0;
    let ruined = false;
    const tradesBySymbol = emptyTradesBySymbol(replayUniverse);
    // One entry per decision tick that came back blocked (undefined = that
    // tick wasn't blocked); reduced to gateBlocks via aggregateGateBlocks
    // after the loop. blockedTicks keeps the (t, normalized-reason) timeline
    // for pause-episode diagnostics (ReplayResult.blockedTicks).
    const blockReasonsSeen: Array<string | undefined> = [];
    const blockedTicks: Array<{ t: number; reason: string }> = [];
    // One entry per decision tick that reported a ddScale entry factor
    // (risk.ddScale candidates only — legacy reports never carry the field).
    const entryScalesSeen: number[] = [];
    try {
      for (let i = 0; i < ref.length; i++) {
        const bar = ref[i];
        const t = bar.timestamp + barDurationMs;
        if (t < fromMs) continue;
        broker.now = t;
        clock.set(t);
        // Cap the event range to the fold's exclusive upper bound: a bar
        // gap can put `t` at or beyond `toMs` (the last bar loaded is only
        // guaranteed < toMs, not that t = bar.timestamp + barDurationMs
        // stays under it). Without the cap, that iteration would consume a
        // funding event exactly AT toMs — which belongs to the NEXT fold.
        // The price snapshot still prices at `t` (unaffected).
        if (prevT && cfg.funding) broker.applyFunding(prevT, t, Math.min(t, toMs - 1));
        // Margin interest accrues over the same capped range — a UTC-day
        // boundary exactly AT toMs belongs to the next fold, like a funding
        // event. No-op unless cfg.marginInterest set a nonzero rate.
        if (prevT) broker.accrueMarginInterest(prevT, Math.min(t, toMs - 1));
        prevT = t;
        const barBySymbol = new Map<string, OHLCV>();
        for (const [sym, cs] of candles) {
          const idx = broker.closedIndex(cs, t);
          if (idx >= 0) barBySymbol.set(sym, cs[idx]);
        }
        broker.checkStops(barBySymbol);
        // Delisting (membership mode only): a held symbol whose tape is
        // EXHAUSTED (its last bar is the series' final bar and the sim
        // clock is >6 calendar days past it — a live symbol always has a
        // newer bar within the daily-calendar tolerance) closes at that
        // last close with reason "DELISTED". Declared OPTIMISTIC: the real
        // last negotiable print can be worse than the last recorded close.
        if (cfg.membership) {
          for (const p of [...broker.positions]) {
            const c = candles.get(p.symbol);
            if (!c || c.length === 0) continue;
            const idx = broker.closedIndex(c, t);
            if (idx === c.length - 1 && t - c[idx].timestamp > 6 * 86_400_000) {
              broker.closeAt(p.symbol, p.side, c[idx].close, "DELISTED");
            }
          }
        }
        if (broker.checkLiquidation()) { ruined = true; break; }
        const nextBar = ref[i + 1];
        const canDecide = nextBar && nextBar.timestamp < toMs;
        if (t - lastTick >= cadenceMs && canDecide) {
          broker.equityHistory.push({ t, eq: await broker.getEquity() });
          // Decision-tick counter for the post-stop cooldown: incremented
          // BEFORE tick() so this tick's own opens are judged against it.
          broker.decisionTicks++;
          const report = await engine.tick();
          if (!report.tradeable) {
            blockReasonsSeen.push(report.blockedReason);
            if (report.blockedReason) blockedTicks.push({ t, reason: normalizeGateReason(report.blockedReason) });
          }
          if (report.entryScale !== undefined) entryScalesSeen.push(report.entryScale);
          lastTick = t;
        }
      }
    } finally {
      if (prevTradingEnabled !== undefined) process.env.TRADING_ENABLED = prevTradingEnabled;
    }

    broker.now = toMs;

    // Settle funding through the fold's exclusive upper bound: the interval
    // is [fromMs, toMs), so an event settled exactly AT toMs belongs to the
    // NEXT fold and must be excluded here (eventEndMs = toMs - 1), while the
    // price snapshot still prices at toMs (the last available close).
    // Idempotent otherwise: FundingBook.eventsBetween is (fromEx, toInc], so
    // any event already captured by the last in-loop applyFunding call is
    // excluded. checkLiquidation already zeroed `positions` on ruin, so this
    // is a no-op in that case.
    if (cfg.funding) broker.applyFunding(prevT, toMs, toMs - 1);

    // Terminal margin-interest settle mirrors the funding settle: UTC-day
    // boundaries in (lastBar, toMs) accrue while positions are still open;
    // the boundary exactly AT toMs belongs to the next fold.
    if (prevT) broker.accrueMarginInterest(prevT, toMs - 1);

    liquidateAtFoldEnd(broker, fromMs, toMs, ruined);

    // Exactly one terminal equity point, computed AFTER liquidation so it's
    // never a double count against a prior mark-to-market push.
    const finalEq = ruined ? Math.max(0, broker.cash) : broker.equityNow();
    broker.equityHistory.push({ t: toMs, eq: finalEq });

    const days = (Math.min(toMs, ref[ref.length - 1].timestamp) - fromMs) / 86_400_000;
    const trades = broker.closed.filter(t => t.reason !== "end");
    const turnoverAnnual = computeTurnoverAnnual(broker.turnoverNotional, broker.equityHistory, fromMs, toMs, cfg.initialEquity);
    const displacementCloses = trades.filter(t => t.engineCloseReason === SLOT_DISPLACED_CLOSE_REASON).length;
    const profitLockCloses = trades.filter(t => t.reason === "profit_lock").length;
    const gateBlocks = aggregateGateBlocks(blockReasonsSeen);
    const ddScaleStats = entryScalesSeen.length > 0
      ? {
          ticks: entryScalesSeen.length,
          ticksBelowOne: entryScalesSeen.filter(s => s < 1).length,
          meanScale: entryScalesSeen.reduce((s, x) => s + x, 0) / entryScalesSeen.length,
          minScale: Math.min(...entryScalesSeen),
        }
      : undefined;
    const wins = trades.filter(t => t.pnl > 0).length;
    const totalRet = (finalEq - cfg.initialEquity) / cfg.initialEquity;

    let peak = cfg.initialEquity, maxDd = 0;
    for (const e of broker.equityHistory) {
      if (e.eq > peak) peak = e.eq;
      maxDd = Math.max(maxDd, (peak - e.eq) / peak);
    }
    const rets: number[] = [];
    for (let i = 1; i < broker.equityHistory.length; i++) {
      const a = broker.equityHistory[i - 1].eq, b = broker.equityHistory[i].eq;
      if (a > 0) rets.push((b - a) / a);
    }
    const mean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    const perYear = annualizationPeriods({ name: cfg.sleeve as "crypto" | "stocks" }, cfg.cadenceMin);
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(perYear) : 0;

    // equal-weight buy&hold benchmark
    let bench = 0, benchN = 0;
    for (const sym of cfg.universe) {
      const c = candles.get(sym);
      if (!c) continue;
      const start = c.find(b => b.timestamp >= fromMs);
      const end = c[c.length - 1];
      if (start && end && start.close > 0) { bench += (end.close - start.close) / start.close; benchN++; }
    }
    bench = benchN > 0 ? bench / benchN : 0;

    // Per-symbol trade accounting (closed trades only; funding is global and not trivially
    // attributable, but we keep the field for downstream concentration checks).
    for (const t of trades) {
      const acc = tradesBySymbol[t.symbol];
      if (acc) {
        acc.trades++;
        acc.grossPnl += t.pnl;
      }
    }
    for (const [symbol, acc] of Object.entries(tradesBySymbol)) {
      acc.fees = broker.feesBySymbol.get(symbol) ?? 0;
      acc.funding = broker.fundingBySymbol.get(symbol) ?? 0;
    }

    const dailyReturns = computeDailyReturns(broker.equityHistory, cfg.rthOnly);
    const sessionReturns = computeSessionReturns(broker.equityHistory, cfg.rthOnly);

    const hash = hashReplayConfig(cfg);
    // engine.getRiskState() is authoritative (always current), independent of
    // whether any save() ever fired on the injected in-memory persistence.
    const finalRiskState: RiskState = { ...engine.getRiskState() };

    return {
      sleeve: cfg.sleeve,
      window: win,
      fromMs,
      toMs,
      config: cfg,
      finalEquity: finalEq,
      totalReturn: totalRet,
      maxDrawdown: maxDd,
      sharpe,
      winRate: trades.length ? wins / trades.length : 0,
      trades: trades.length,
      tradesPerDay: trades.length / Math.max(1, days),
      expectancy: trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0,
      fees: broker.feesPaid,
      funding: broker.fundingPaid,
      marginInterest: broker.marginInterestPaid,
      liquidations: broker.liquidations,
      marginRejects: broker.marginRejects,
      ruined,
      bench,
      dailyReturns,
      sessionReturns,
      tradesBySymbol,
      equityHistory: broker.equityHistory,
      closedTrades: trades,
      turnoverAnnual,
      displacementCloses,
      profitLockCloses,
      gateBlocks,
      blockedTicks,
      // Key absent on legacy candidates — pre-existing artifacts/runs.jsonl
      // rows keep their exact shape.
      ...(ddScaleStats ? { ddScaleStats } : {}),
      hash,
      finalRiskState,
    };
  } finally {
    db.close();
  }
}

/** Legacy single-run entry point. */
export async function runOne(sleeve: Sleeve, win: { label: string; from: string; to: string }, cadenceMin: number, exposure: number): Promise<RunResult | null> {
  const cfg = buildReplayConfig(sleeve, win, cadenceMin, exposure);
  const r = await runWithConfig(cfg, win);
  if (!r) return null;
  return {
    sleeve: r.sleeve, window: r.window.label, cadence: cfg.cadenceMin, exposure,
    days: (r.toMs - r.fromMs) / 86_400_000,
    trades: r.trades, tradesPerDay: r.tradesPerDay, winRate: r.winRate,
    ret: r.totalReturn, maxDd: r.maxDrawdown, sharpe: r.sharpe, expectancy: r.expectancy,
    fees: r.fees, funding: r.funding, marginInterest: r.marginInterest ?? 0, bench: r.bench,
    liq: r.liquidations, rejects: r.marginRejects, ruined: r.ruined,
  };
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  // Update YTD windows to the latest common complete data and print bounds.
  console.log("▌ ACTUAL BOUNDS");
  for (const sleeve of SLEEVES) {
    if (sleeveArg !== "all" && sleeve.name !== sleeveArg) continue;
    const ytd = sleeve.windows.find(w => w.label === "2026ytd");
    if (!ytd) continue;
    const asOf = latestCommonAsOf(sleeve);
    ytd.to = new Date(asOf).toISOString();
    console.log(`  ${sleeve.name.padEnd(7)} 2026ytd → ${ytd.to}`);
  }
  console.log("");

  const results: RunResult[] = [];
  for (const sleeve of SLEEVES) {
    if (sleeveArg !== "all" && sleeve.name !== sleeveArg) continue;
    for (const M of exposures) {
      for (const win of sleeve.windows) {
        for (const cad of CADENCES_MIN) {
          const r = await runOne(sleeve, win, cad, M);
          if (r) {
            results.push(r);
            console.log(
              `${r.sleeve.padEnd(7)} x${String(M).padEnd(3)} ${r.window.padEnd(8)} ${String(r.cadence).padStart(3)}min | ` +
              `${String(r.trades).padStart(4)} tr (${r.tradesPerDay.toFixed(1)}/d) WR ${(r.winRate * 100).toFixed(0).padStart(3)}% | ` +
              `ret ${(r.ret * 100).toFixed(1).padStart(6)}% (B&H ${(r.bench * 100).toFixed(1)}%) | ` +
              `DD ${(r.maxDd * 100).toFixed(1).padStart(4)}% | Sharpe ${r.sharpe.toFixed(2).padStart(5)} | ` +
              `exp $${r.expectancy.toFixed(2)} | fees $${r.fees.toFixed(0)}${r.funding ? ` fund $${r.funding.toFixed(0)}` : ""}${r.marginInterest ? ` margin $${r.marginInterest.toFixed(0)}` : ""}` +
              ` | liq ${r.liq} rej ${r.rejects}${r.ruined ? " RUINED" : ""}`,
            );
          } else {
            console.log(`${sleeve.name} x${M} ${win.label} ${cad}min | NO DATA`);
          }
        }
      }
      console.log("");
    }
  }

  // ── summary per sleeve × exposure × cadence across windows ───────────
  interface Agg { sleeve: string; cad: number; M: number; n: number; meanRet: number; worst: number; meanDd: number; geo: number; liq: number; ruined: number }
  const aggs: Agg[] = [];
  console.log("▌ SUMMARY (per sleeve × exposure, across windows)");
  for (const sleeve of SLEEVES) {
    if (sleeveArg !== "all" && sleeve.name !== sleeveArg) continue;
    for (const cad of CADENCES_MIN) {
      for (const M of exposures) {
        const rs = results.filter(r => r.sleeve === sleeve.name && r.cadence === cad && r.exposure === M);
        if (rs.length === 0) continue;
        const mean = (f: (r: RunResult) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
        // Kelly-relevant number: geometric-mean growth across windows
        const factors = rs.map(r => 1 + r.ret);
        const geo = factors.some(f => f <= 0) ? -1 : Math.exp(factors.reduce((s, f) => s + Math.log(f), 0) / rs.length) - 1;
        const a: Agg = {
          sleeve: sleeve.name, cad, M, n: rs.length,
          meanRet: mean(r => r.ret), worst: Math.min(...rs.map(r => r.ret)), meanDd: mean(r => r.maxDd), geo,
          liq: rs.reduce((s, r) => s + r.liq, 0), ruined: rs.filter(r => r.ruined).length,
        };
        aggs.push(a);
        console.log(
          `${a.sleeve.padEnd(7)} x${String(a.M).padEnd(3)} ${String(cad).padStart(3)}min | mean ret ${(a.meanRet * 100).toFixed(1).padStart(7)}% | ` +
          `worst ${(a.worst * 100).toFixed(1).padStart(7)}% | mean DD ${(a.meanDd * 100).toFixed(1).padStart(5)}% | ` +
          `GEO ${(a.geo * 100).toFixed(1).padStart(7)}%/window | liq ${a.liq} | ruined ${a.ruined}/${a.n}`,
        );
      }
    }
  }

  // ── Kelly + 1%/day analysis ───────────────────────────────────────────
  for (const sleeve of SLEEVES) {
    if (sleeveArg !== "all" && sleeve.name !== sleeveArg) continue;
    for (const cad of CADENCES_MIN) {
      const as = aggs.filter(a => a.sleeve === sleeve.name && a.cad === cad);
      if (as.length < 2) continue;
      const best = as.reduce((b, a) => (a.geo > b.geo ? a : b));
      const daily = best.geo > -1 ? Math.pow(1 + best.geo, 1 / 365) - 1 : -1;
      console.log(`\n▌ KELLY — ${sleeve.name} ${cad}min`);
      console.log(`  geo by M: ${as.map(a => `x${a.M}=${(a.geo * 100).toFixed(1)}%`).join("  ")}`);
      console.log(`  Kelly-optimal M = x${best.M} → geo ${(best.geo * 100).toFixed(1)}%/window ≈ ${(daily * 100).toFixed(3)}%/day (365d)`);

      const base = as.find(a => a.M === 1);
      if (base && base.meanRet > 0) {
        const target = Math.pow(1.01, 252) - 1; // 1%/trading-day ⇒ ×12.27/yr
        const needM = target / base.meanRet;
        console.log(`▌ 1%/DAY — ${sleeve.name} ${cad}min`);
        console.log(`  target 1%/trading-day = 1.01^252 ≈ ×${(1 + target).toFixed(1)}/yr = +${(target * 100).toFixed(0)}%/yr`);
        console.log(`  linear scaling of baseline mean (+${(base.meanRet * 100).toFixed(0)}%) ⇒ M ≈ x${needM.toFixed(1)}`);
        console.log(
          `  same M on worst window: ${(base.worst * 100).toFixed(0)}% × ${needM.toFixed(1)} = ${(base.worst * needM * 100).toFixed(0)}%` +
          `${base.worst * needM <= -1 ? " (≤ −100% ⇒ RUIN)" : ""} | mean DD ${(base.meanDd * 100).toFixed(0)}% × ${needM.toFixed(1)} = ${(base.meanDd * needM * 100).toFixed(0)}%`,
        );
        console.log(`  broker cap: 2x leverage ⇒ deployable ≤ M=2 at 4×25% slots — x${needM.toFixed(1)} is unopenable, and the sim liquidates long before`);
      }
    }
  }
}

if (import.meta.main) await main();
