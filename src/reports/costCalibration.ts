// ══════════════════════════════════════════════
// Cost calibration — coste REAL de ejecución vs el que asume el simulador
// (open-source review 2026-09, propuesta 6).
//
// Pure functions + READ-ONLY DB readers (every query is a SELECT — tests
// open both DBs readonly and run the whole module). The CLI is
// scripts/calibrate-costs.ts; the dashboard reuses computeCostCalibration
// inside GET /api/v2/scorecard (additive `costs` block).
//
// WHAT IT MEASURES, per live sleeve and side, relative to the PRICE THE
// SIMULATOR ASSUMES IT TRADES AT:
//  • Stocks daily (meanrev_stocks; momentum_stocks only from MODEL_START
//    2026-09-28 — the daily kernel; older fills belong to the retired 5m
//    kernel and are NOT comparable): the sim fills at the OPEN of the
//    decision day (scripts/meanrev-replay.ts; backtest-momentum-wf daily
//    mode). Real cost = side-aware (fill − that day's open)/open in bps —
//    it captures BOTH the open→~09:35 drift and the slippage, exactly the
//    live-vs-sim wedge. Alpaca paper charges no commission.
//  • Crypto hourly (momentum_crypto, momentum_crypto_usdc): the sim fills
//    at the open of the bar FOLLOWING the decision bar; live engines tick
//    at boundary+15s and fill seconds into that same bar → reference =
//    open of the 1h MAINNET bar containing the fill (binance_futures/1h in
//    historical.db; testnet-vs-mainnet basis is part of the measured
//    wedge, deliberately). Plus the REAL commission
//    (trades.open_commission / close_commission ÷ notional, in bps) that
//    the sim charges as commissionBps. Periods are split at 2026-09-10
//    (expected_px basis change — see the Price-basis note in
//    src/reports/fillQuality.ts; our open-based measure does not depend on
//    expected_px, the split keeps eras honest and comparable).
//  • Stops (STOP_LOSS / BROKER_STOP_LOSS / TRAIL_STOP closes): the trade's
//    exit_price vs the stop LEVEL (trades.stop_loss; trailing_stop for
//    TRAIL_STOP) — the stop-market gap the sim does NOT charge (it fills
//    stops at their level). Measured from TRADES, not fills: broker-native
//    stops (BROKER_STOP_LOSS) fill at the broker and never write a fills
//    row. These closes are EXCLUDED from the per-side vs-open stats.
// Non-sim closes (MANUAL_CLOSE*, SYNC_*, *_RECONCILED, BROKER_GONE_404, …)
// are excluded entirely — the simulator never takes those decisions.
//
// RW2 (2026-10-23): momentum_stocks and meanrev_stocks run on the portfolio
// engine, which writes NO fills rows: its ONE execution record is the decision
// journal (portfolio_decisions.orders_json). Since Q7 V1 (2026-11-07) this
// module reads that journal too (readPortfolioExecutions): every filled leg
// (MAX_HOLD close, its -r1 retry, the rebuy, a stale-tick close, a rebalance
// buy, a partial trim or full exit) with the slippage of its fill vs the price
// the pass DECIDED on (`decisionPrice`) and vs the session's UNADJUSTED open
// (`sessionOpenRaw`, when the venue gave it — the replay's reference, raw like
// the fill, so no adjustment bias), by label, symbol and notional bucket.
// Classification is the EXECUTION's own label, never the trade's eventual
// close_reason. A fill the venue reported without a price (the engine marks
// the row at the last close) is an emergency mark, not an execution: it is
// FLAGGED (excluded.emergencyMark) and never measured. The headline `measured`
// of a stock sleeve falls back to the journal's vs-session-open series when
// the fills table has nothing comparable (source "portfolio_journal").
// Caveat, explicit in the output: Alpaca PAPER fills at the quote without
// impact, so every stock number here is a lower bound on a live cost.
// meanrev_stocks (sinceEtDateKey null) still shows the Connors era's fills
// (same reference) under `periods`; the artifact (break-even curve, base
// costs) comes from the version table and IS the engine's.
//
// Caveat (stocks): historical daily bars are adjustment=all — a dividend/
// split ex-date AFTER a fill shifts that day's adjusted open vs the raw
// fill by the adjustment factor, biasing buys UP and sells DOWN by the
// same amount. The per-side means carry that bias; the `combined`
// (buy+sell pooled) mean cancels it to first order — prefer it as the
// headline per-side cost.
// ══════════════════════════════════════════════

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { getETDateKey } from "../db/database";
import { inferOrderLabel, type PersistedOrder, type PortfolioOrderLabel } from "../portfolio-engine/live/persistence";
import {
  MODEL_START, mulberry32, percentile, sleeveExpectationArtifacts,
  type ArtifactRef,
} from "../portfolio/scorecard";

// ── Constants ─────────────────────────────────────────────────────────────

/** 2026-09-10 expected_px basis change (fillQuality.ts Price-basis note). */
export const PRICE_BASIS_BOUNDARY_MS = Date.parse("2026-09-10T00:00:00Z");

export type CostPeriodLabel = "all" | "pre-2026-09-10" | "desde-2026-09-10";

/** Closes the sim models AT THE STOP LEVEL — measured separately. */
export const STOP_CLOSE_REASONS = new Set(["STOP_LOSS", "BROKER_STOP_LOSS", "TRAIL_STOP"]);
/** Engine exits the sim also takes (comparable to a sim fill at the ref price). */
export const SIM_EXIT_REASONS = new Set(["MEANREV_EXIT", "MOMENTUM_REBALANCE", "SLOT_DISPLACED", "TIME_STOP"]);

const STOCK_BAR_SOURCE = "alpaca_wide";
const CRYPTO_BAR_SOURCE = "binance_futures";
const HOUR_MS = 3_600_000;

/** Below this many slip observations the verdict refuses to extrapolate. */
export const MIN_N_FOR_VERDICT = 10;

export interface SleeveCostConfig {
  sleeve: string;
  market: "stock" | "crypto";
  /** ET date-key floor: fills before it belong to a DIFFERENT (retired)
   *  execution model and are not comparable to the current sim. */
  sinceEtDateKey: string | null;
  /** fills.symbol → mainnet historical symbol (USDC perps price off the
   *  same underlying: X/USDC → X/USD). */
  mapSymbol: (s: string) => string;
}

export const COST_SLEEVES: SleeveCostConfig[] = [
  { sleeve: "momentum_stocks", market: "stock", sinceEtDateKey: MODEL_START.momentum_stocks, mapSymbol: s => s },
  { sleeve: "meanrev_stocks", market: "stock", sinceEtDateKey: null, mapSymbol: s => s },
  { sleeve: "momentum_crypto", market: "crypto", sinceEtDateKey: null, mapSymbol: s => s },
  { sleeve: "momentum_crypto_usdc", market: "crypto", sinceEtDateKey: null, mapSymbol: s => s.replace("/USDC", "/USD") },
];

// ── Pure math ─────────────────────────────────────────────────────────────

/**
 * Side-aware cost vs the simulator's reference price (a bar OPEN), in bps.
 * Same sign convention as fillQuality.slippageBps: for a BUY, filling ABOVE
 * the reference is a cost → positive; for a SELL, filling BELOW it is a
 * cost → positive. Non-positive reference → 0 (never a fabricated number).
 */
export function costVsOpenBps(side: string, fillPx: number, openPx: number): number {
  if (!(openPx > 0)) return 0;
  const signedDelta = side === "buy" ? fillPx - openPx : openPx - fillPx;
  return (signedDelta / openPx) * 10_000;
}

/**
 * Stop-market gap in bps: fill vs the stop LEVEL, side-aware on the EXIT
 * side (a long's stop exit is a SELL — filling below the level is the cost
 * the sim never charges; a short's stop exit is a BUY — mirror).
 */
export function stopSlipBps(exitSide: string, fillPx: number, stopLevel: number): number {
  return costVsOpenBps(exitSide, fillPx, stopLevel);
}

/** 95% percentile-bootstrap CI of the mean (deterministic: mulberry32).
 *  null when n < 3 — a 2-point CI is noise dressed up as rigor. */
export function bootstrapMeanCI(
  xs: number[], opts: { seed?: number; nBoot?: number } = {},
): { lo: number; hi: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  const rand = mulberry32(opts.seed ?? 42);
  const nBoot = opts.nBoot ?? 2000;
  const means: number[] = [];
  for (let b = 0; b < nBoot; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)];
    means.push(s / n);
  }
  return { lo: percentile(means, 0.025), hi: percentile(means, 0.975) };
}

export interface CostStats {
  n: number;
  meanBps: number;
  medianBps: number;
  p90Bps: number;
  /** 95% bootstrap CI of the mean; null when n < 3. */
  ci95: { lo: number; hi: number } | null;
}

export function computeCostStats(xs: number[], opts: { seed?: number; nBoot?: number } = {}): CostStats | null {
  if (xs.length === 0) return null;
  return {
    n: xs.length,
    meanBps: xs.reduce((s, x) => s + x, 0) / xs.length,
    medianBps: percentile(xs, 0.5),
    p90Bps: percentile(xs, 0.9),
    ci95: bootstrapMeanCI(xs, opts),
  };
}

// ── breakEvenCurve interpolation ──────────────────────────────────────────

export interface BreakEvenPoint { slippageBps: number; sharpe: number }

/** Linear interpolation of the artifact's Sharpe at a per-side cost. NO
 *  extrapolation: outside [min,max] of the curve → sharpe null +
 *  outOfRange (the honest "re-run the chain" signal). */
export function interpolateSharpeAt(curve: BreakEvenPoint[], xBps: number): { sharpe: number | null; outOfRange: boolean } {
  if (curve.length === 0) return { sharpe: null, outOfRange: true };
  const pts = [...curve].sort((a, b) => a.slippageBps - b.slippageBps);
  if (xBps < pts[0].slippageBps || xBps > pts[pts.length - 1].slippageBps) return { sharpe: null, outOfRange: true };
  for (let i = 1; i < pts.length; i++) {
    if (xBps <= pts[i].slippageBps) {
      const a = pts[i - 1], b = pts[i];
      const t = b.slippageBps === a.slippageBps ? 0 : (xBps - a.slippageBps) / (b.slippageBps - a.slippageBps);
      return { sharpe: a.sharpe + (b.sharpe - a.sharpe) * t, outOfRange: false };
    }
  }
  return { sharpe: pts[pts.length - 1].sharpe, outOfRange: false }; // xBps === max (unreachable fallback)
}

/** First zero-crossing of Sharpe along the curve (linear between points).
 *  Still positive at the last point → beyondCurve ("break-even > max"). */
export function breakEvenCostBps(curve: BreakEvenPoint[]): { bps: number | null; beyondCurve: boolean } {
  if (curve.length === 0) return { bps: null, beyondCurve: false };
  const pts = [...curve].sort((a, b) => a.slippageBps - b.slippageBps);
  if (pts[0].sharpe <= 0) return { bps: pts[0].slippageBps, beyondCurve: false };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.sharpe > 0 && b.sharpe <= 0) {
      const t = a.sharpe / (a.sharpe - b.sharpe);
      return { bps: a.slippageBps + (b.slippageBps - a.slippageBps) * t, beyondCurve: false };
    }
  }
  return { bps: null, beyondCurve: true };
}

// ── Readonly readers ──────────────────────────────────────────────────────

export interface SlipObs { side: "buy" | "sell"; costBps: number; period: CostPeriodLabel }

export interface SleeveCostObservations {
  slip: SlipObs[];
  /** Stop-market gap vs the stop level, bps (cost-positive). */
  stops: number[];
  /** Real commission per side in bps of notional (crypto only; trade-level
   *  so a partially-closed trade's close_commission isn't double counted). */
  commissionBps: { bps: number; period: CostPeriodLabel }[];
  excluded: { nonSim: number; noBar: number; noStopLevel: number; preModel: number };
}

function periodOf(cfg: SleeveCostConfig, timeMs: number, boundaryMs: number): CostPeriodLabel {
  if (cfg.market === "stock") return "all";
  return timeMs < boundaryMs ? "pre-2026-09-10" : "desde-2026-09-10";
}

/**
 * All SELECTs. `hist` null (or a bar missing) counts the fill under
 * excluded.noBar — never a throw, never a fabricated reference price.
 */
export function readSleeveCostObservations(
  db: Database, hist: Database | null, cfg: SleeveCostConfig,
  opts: { boundaryMs?: number; sinceMs?: number } = {},
): SleeveCostObservations {
  const boundaryMs = opts.boundaryMs ?? PRICE_BASIS_BOUNDARY_MS;
  const sinceMs = opts.sinceMs ?? 0;
  const out: SleeveCostObservations = {
    slip: [], stops: [], commissionBps: [],
    excluded: { nonSim: 0, noBar: 0, noStopLevel: 0, preModel: 0 },
  };

  const fills = db.prepare(
    `SELECT f.symbol, f.side, f.filled_px, f.fill_time,
            t.side AS trade_side, t.close_reason
     FROM fills f JOIN trades t ON t.id = f.trade_id
     WHERE f.account_id = ? AND f.fill_time >= ? ORDER BY f.fill_time ASC`
  ).all(cfg.sleeve, sinceMs) as {
    symbol: string; side: string; filled_px: number; fill_time: number;
    trade_side: string; close_reason: string | null;
  }[];

  // Reference-open lookups (lazy per symbol for stocks, point query for crypto).
  const dailyOpens = new Map<string, Map<string, number>>();
  const stockOpen = (symbol: string, fillTime: number): number | null => {
    if (!hist) return null;
    let m = dailyOpens.get(symbol);
    if (!m) {
      m = new Map();
      const bars = hist.prepare(
        `SELECT timestamp, open FROM historical_bars
         WHERE source = ? AND symbol = ? AND timeframe = '1d' AND open > 0`
      ).all(STOCK_BAR_SOURCE, symbol) as { timestamp: number; open: number }[];
      // Daily bars are stamped at ET midnight (04/05h UTC of the SAME date)
      // → UTC date of the stamp IS the session date (scorecard.ts contract).
      for (const b of bars) m.set(new Date(b.timestamp).toISOString().slice(0, 10), b.open);
      dailyOpens.set(symbol, m);
    }
    return m.get(getETDateKey(fillTime)) ?? null;
  };
  const hourOpenStmt = hist?.prepare(
    `SELECT open FROM historical_bars
     WHERE source = ? AND symbol = ? AND timeframe = '1h' AND timestamp = ? AND open > 0`
  ) ?? null;
  const cryptoOpen = (symbol: string, fillTime: number): number | null => {
    if (!hourOpenStmt) return null;
    const barTs = Math.floor(fillTime / HOUR_MS) * HOUR_MS;
    const row = hourOpenStmt.get(CRYPTO_BAR_SOURCE, symbol, barTs) as { open: number } | null;
    return row?.open ?? null;
  };

  for (const f of fills) {
    if (cfg.sinceEtDateKey && getETDateKey(f.fill_time) < cfg.sinceEtDateKey) { out.excluded.preModel++; continue; }
    const side: "buy" | "sell" = f.side === "buy" ? "buy" : "sell";
    const isEntry = f.side === f.trade_side;
    if (!isEntry) {
      const reason = f.close_reason ?? "";
      // Stop closes never enter the vs-open stats — the sim fills them AT
      // their level; the gap is measured separately (from trades, below).
      if (STOP_CLOSE_REASONS.has(reason)) continue;
      if (!SIM_EXIT_REASONS.has(reason)) { out.excluded.nonSim++; continue; }
    }
    const refSymbol = cfg.mapSymbol(f.symbol);
    const open = cfg.market === "stock" ? stockOpen(refSymbol, f.fill_time) : cryptoOpen(refSymbol, f.fill_time);
    if (open == null) { out.excluded.noBar++; continue; }
    out.slip.push({ side, costBps: costVsOpenBps(side, f.filled_px, open), period: periodOf(cfg, f.fill_time, boundaryMs) });
  }

  // Stop-market gap: TRADES with a stop close_reason (fills can't see the
  // broker-native ones). exit_price is the real fill the close recorded.
  const stopTrades = db.prepare(
    `SELECT side, close_reason, stop_loss, trailing_stop, exit_price, exit_time
     FROM trades
     WHERE account_id = ? AND status = 'closed' AND exit_time IS NOT NULL AND exit_time >= ?
       AND close_reason IN ('STOP_LOSS','BROKER_STOP_LOSS','TRAIL_STOP')`
  ).all(cfg.sleeve, sinceMs) as {
    side: string; close_reason: string; stop_loss: number | null;
    trailing_stop: number | null; exit_price: number | null; exit_time: number;
  }[];
  for (const t of stopTrades) {
    if (cfg.sinceEtDateKey && getETDateKey(t.exit_time) < cfg.sinceEtDateKey) { out.excluded.preModel++; continue; }
    const level = t.close_reason === "TRAIL_STOP" ? (t.trailing_stop ?? t.stop_loss) : t.stop_loss;
    if (level == null || !(level > 0) || t.exit_price == null || !(t.exit_price > 0)) { out.excluded.noStopLevel++; continue; }
    const exitSide = t.side === "buy" ? "sell" : "buy"; // a long's stop exit SELLs; a short's BUYs
    out.stops.push(stopSlipBps(exitSide, t.exit_price, level));
  }

  // Real commission per side (crypto): trade-level, bps of the side's notional.
  if (cfg.market === "crypto") {
    const trades = db.prepare(
      `SELECT entry_price, exit_price, quantity, open_commission, close_commission,
              entry_time, exit_time, status
       FROM trades WHERE account_id = ?`
    ).all(cfg.sleeve) as {
      entry_price: number | null; exit_price: number | null; quantity: number | null;
      open_commission: number | null; close_commission: number | null;
      entry_time: number | null; exit_time: number | null; status: string;
    }[];
    for (const t of trades) {
      const qty = Math.abs(t.quantity ?? 0);
      const entryNotional = (t.entry_price ?? 0) * qty;
      if ((t.open_commission ?? 0) > 0 && entryNotional > 0 && t.entry_time != null && t.entry_time >= sinceMs) {
        out.commissionBps.push({ bps: (t.open_commission! / entryNotional) * 10_000, period: periodOf(cfg, t.entry_time, boundaryMs) });
      }
      const exitNotional = Math.abs(t.exit_price ?? 0) * qty;
      if (t.status === "closed" && (t.close_commission ?? 0) > 0 && exitNotional > 0 && t.exit_time != null && t.exit_time >= sinceMs) {
        out.commissionBps.push({ bps: (t.close_commission! / exitNotional) * 10_000, period: periodOf(cfg, t.exit_time, boundaryMs) });
      }
    }
  }
  return out;
}

// ── Portfolio-engine journal (Q7 V1): executions by label / symbol / notional ──

/** Alpaca paper: fills at the quote, no impact, no commission. Stated on every stock figure. */
export const PAPER_CAVEAT = "Alpaca PAPER: ejecuta al precio cotizado sin impacto ni comisión — cada coste medido en acciones es una cota INFERIOR del coste real en vivo";

export type NotionalBucket = "<1k" | "1k-5k" | "5k-20k" | ">20k";
export const NOTIONAL_BUCKETS: readonly NotionalBucket[] = ["<1k", "1k-5k", "5k-20k", ">20k"];
export function notionalBucket(usd: number): NotionalBucket {
  return usd < 1_000 ? "<1k" : usd < 5_000 ? "1k-5k" : usd < 20_000 ? "5k-20k" : ">20k";
}

export interface PortfolioExecutionObs {
  session: string;
  symbol: string;
  side: "buy" | "sell";
  label: PortfolioOrderLabel;
  /** The label was derived (journal written before the field existed). */
  labelInferred: boolean;
  qty: number;
  /** filledQty × avgPrice. */
  notional: number;
  bucket: NotionalBucket;
  fillPx: number;
  decisionPrice: number | null;
  sessionOpenRaw: number | null;
  /** Side-aware bps of the fill vs the price the pass decided on; null without a decision price. */
  vsDecisionBps: number | null;
  /** Side-aware bps of the fill vs the session's raw open; null when the venue gave none. */
  vsSessionOpenBps: number | null;
  /** filledQty < intent qty (a partial fill, or the first leg of a close that -r1 finished). */
  partial: boolean;
}

export interface PortfolioExecutionObservations {
  obs: PortfolioExecutionObs[];
  excluded: {
    /** Filled legs the venue reported WITHOUT a price: the engine marked the row at the last close. Never an execution. */
    emergencyMark: number;
    /** Before the sleeve's comparable model start (session < sinceEtDateKey). */
    preModel: number;
  };
}

/** All SELECTs on portfolio_decisions (live journals of `sleeve`). A database without the table
 *  (an old fixture) yields nothing — never a throw. */
export function readPortfolioExecutions(
  db: Database, sleeve: string, opts: { sinceMs?: number; sinceEtDateKey?: string | null } = {},
): PortfolioExecutionObservations {
  const out: PortfolioExecutionObservations = { obs: [], excluded: { emergencyMark: 0, preModel: 0 } };
  const hasTable = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'portfolio_decisions'`).get();
  if (!hasTable) return out;
  const rows = db.prepare(
    `SELECT account_id, session, orders_json, decided_at, updated_at FROM portfolio_decisions
     WHERE account_id = ? AND mode = 'live' AND updated_at >= ? ORDER BY session ASC, id ASC`,
  ).all(sleeve, opts.sinceMs ?? 0) as { account_id: string; session: string; orders_json: string; decided_at: number; updated_at: number }[];
  for (const r of rows) {
    let orders: PersistedOrder[] = [];
    try { orders = JSON.parse(r.orders_json); } catch { continue; }
    if (!Array.isArray(orders)) continue;
    for (const o of orders) {
      const filledQty = o?.result?.filledQty ?? 0;
      if (!(filledQty > 0) || !o.intent) continue;
      if (opts.sinceEtDateKey && r.session < opts.sinceEtDateKey) { out.excluded.preModel++; continue; }
      if (opts.sinceMs && (o.filledAt ?? r.updated_at) < opts.sinceMs) continue;
      const fillPx = o.result!.avgPrice;
      if (fillPx === null || !(fillPx > 0)) { out.excluded.emergencyMark++; continue; }
      const side: "buy" | "sell" = o.intent.side === "buy" ? "buy" : "sell";
      const decisionPrice = typeof o.decisionPrice === "number" && o.decisionPrice > 0 ? o.decisionPrice : null;
      const sessionOpenRaw = typeof o.sessionOpenRaw === "number" && o.sessionOpenRaw > 0 ? o.sessionOpenRaw : null;
      const notional = filledQty * fillPx;
      out.obs.push({
        session: r.session, symbol: o.intent.symbol, side,
        label: inferOrderLabel(o, { accountId: r.account_id, session: r.session }), labelInferred: !o.label,
        qty: filledQty, notional, bucket: notionalBucket(notional), fillPx, decisionPrice, sessionOpenRaw,
        vsDecisionBps: decisionPrice === null ? null : costVsOpenBps(side, fillPx, decisionPrice),
        vsSessionOpenBps: sessionOpenRaw === null ? null : costVsOpenBps(side, fillPx, sessionOpenRaw),
        partial: filledQty < o.intent.qty * (1 - 1e-6),
      });
    }
  }
  return out;
}

export interface ExecutionGroupStats {
  n: number;
  notional: number;
  vsDecision: CostStats | null;
  vsSessionOpen: CostStats | null;
}

export interface PortfolioExecutionSummary {
  /** Executions measured (filled legs with a price). */
  n: number;
  /** Of them, with a raw session open to compare against. */
  nWithSessionOpen: number;
  /** Labels derived for pre-field journals (0 once every row carries its own). */
  nLabelInferred: number;
  partialFills: number;
  vsDecision: CostStats | null;
  vsSessionOpen: CostStats | null;
  byLabel: Partial<Record<PortfolioOrderLabel, ExecutionGroupStats>>;
  bySymbol: Record<string, ExecutionGroupStats>;
  byBucket: Partial<Record<NotionalBucket, ExecutionGroupStats>>;
  excluded: PortfolioExecutionObservations["excluded"];
  caveat: string;
}

function groupStats(xs: PortfolioExecutionObs[], statOpts: { seed?: number; nBoot?: number }): ExecutionGroupStats {
  return {
    n: xs.length,
    notional: xs.reduce((s, x) => s + x.notional, 0),
    vsDecision: computeCostStats(xs.map(x => x.vsDecisionBps).filter((v): v is number => v !== null), statOpts),
    vsSessionOpen: computeCostStats(xs.map(x => x.vsSessionOpenBps).filter((v): v is number => v !== null), statOpts),
  };
}

function groupBy<K extends string>(xs: PortfolioExecutionObs[], key: (x: PortfolioExecutionObs) => K, statOpts: { seed?: number; nBoot?: number }): Record<K, ExecutionGroupStats> {
  const out = {} as Record<K, ExecutionGroupStats>;
  const groups = new Map<K, PortfolioExecutionObs[]>();
  for (const x of xs) { const k = key(x); groups.set(k, [...(groups.get(k) ?? []), x]); }
  for (const [k, v] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) out[k] = groupStats(v, statOpts);
  return out;
}

export function summarizePortfolioExecutions(
  o: PortfolioExecutionObservations, statOpts: { seed?: number; nBoot?: number } = {},
): PortfolioExecutionSummary {
  const all = groupStats(o.obs, statOpts);
  return {
    n: o.obs.length,
    nWithSessionOpen: o.obs.filter(x => x.vsSessionOpenBps !== null).length,
    nLabelInferred: o.obs.filter(x => x.labelInferred).length,
    partialFills: o.obs.filter(x => x.partial).length,
    vsDecision: all.vsDecision,
    vsSessionOpen: all.vsSessionOpen,
    byLabel: groupBy(o.obs, x => x.label, statOpts),
    bySymbol: groupBy(o.obs, x => x.symbol, statOpts),
    byBucket: groupBy(o.obs, x => x.bucket, statOpts),
    excluded: o.excluded,
    caveat: PAPER_CAVEAT,
  };
}

// ── Artifact context (manifest base costs + breakEvenCurve) ───────────────

export interface ArtifactCostContext {
  manifest: string | null;
  assumed: { slippageBps: number; commissionBps: number } | null;
  curve: BreakEvenPoint[] | null;
}

/** Fail-soft: missing/corrupt artifact ⇒ nulls, never a throw. */
export function loadArtifactCostContext(ref: ArtifactRef | null): ArtifactCostContext {
  const out: ArtifactCostContext = { manifest: ref?.manifest ?? null, assumed: null, curve: null };
  if (!ref) return out;
  try {
    const base = JSON.parse(readFileSync(`${ref.dir}/manifest-resolved.json`, "utf8")).costs?.base;
    if (typeof base?.slippageBps === "number" && typeof base?.commissionBps === "number") {
      out.assumed = { slippageBps: base.slippageBps, commissionBps: base.commissionBps };
    }
  } catch {}
  try {
    if (existsSync(`${ref.dir}/summary.json`)) {
      const curve = JSON.parse(readFileSync(`${ref.dir}/summary.json`, "utf8")).breakEvenCurve;
      if (Array.isArray(curve) && curve.every(p => typeof p?.slippageBps === "number" && typeof p?.sharpe === "number")) {
        out.curve = curve.map(p => ({ slippageBps: p.slippageBps, sharpe: p.sharpe }));
      }
    }
  } catch {}
  return out;
}

// ── Per-sleeve calibration ────────────────────────────────────────────────

export interface SleeveCostPeriodSummary {
  period: CostPeriodLabel;
  buy: CostStats | null;
  sell: CostStats | null;
  /** Both sides pooled — first-order-cancels the dividend-adjustment bias
   *  on stocks (module header) and is the headline per-side slippage. */
  combined: CostStats | null;
  /** Real commission per side, bps (crypto only). */
  commissionPerSide: CostStats | null;
}

export interface SleeveCostCalibration {
  sleeve: string;
  market: "stock" | "crypto";
  comparableSinceEtDate: string | null;
  manifest: string | null;
  periods: SleeveCostPeriodSummary[];
  stops: CostStats | null;
  excluded: SleeveCostObservations["excluded"];
  /** Sim's declared per-side cost (manifest costs.base). */
  assumed: { slippageBps: number; commissionBps: number; totalPerSideBps: number } | null;
  /** Headline: slippage-vs-open (combined sides) + real commission, per
   *  side, on the CURRENT-era period (crypto: desde-2026-09-10). `source`
   *  "portfolio_journal" = the engine journal's fills vs the session's RAW
   *  open (stock sleeves with no comparable fills rows). */
  measured: {
    period: CostPeriodLabel; n: number;
    slipMeanBps: number; slipCi95: { lo: number; hi: number } | null;
    commissionMeanBps: number; totalPerSideBps: number;
    source: "fills" | "portfolio_journal";
  } | null;
  /** Q7 V1: the portfolio engine's executions from its decision journal (null = the sleeve has none). */
  portfolioExecution: PortfolioExecutionSummary | null;
  /** Explicit for every stock sleeve (paper broker); null on crypto. */
  caveat: string | null;
  breakEven: {
    curveMinBps: number; curveMaxBps: number;
    sharpeAtAssumed: number | null;
    sharpeAtMeasured: number | null;
    measuredOutOfCurveRange: boolean;
    /** "below" = cheaper than the curve's best tier (favorable); "above" =
     *  costlier than its worst tier (adverse). null when in range. */
    outOfRangeDirection: "below" | "above" | null;
    /** Sharpe at the nearest curve edge — a BOUND on the expected Sharpe
     *  when out of range (≥ for "below", ≤ for "above"). */
    sharpeAtCurveEdge: number | null;
    breakEvenBps: number | null;
    breakEvenBeyondCurve: boolean;
    /** breakEvenBps − measured total (positive = cushion). */
    marginBps: number | null;
    /** Lower bound on the cushion when break-even lies beyond the curve. */
    marginAtLeastBps: number | null;
  } | null;
  verdict: string;
}

function fmtBps(x: number): string { return `${x >= 0 ? "" : "−"}${Math.abs(x).toFixed(1)}`; }

function buildVerdict(c: SleeveCostCalibration): string {
  if (!c.measured) {
    return c.comparableSinceEtDate
      ? `sin fills comparables aún (modelo actual desde ${c.comparableSinceEtDate})`
      : "sin fills comparables aún";
  }
  const m = c.measured;
  const ci = m.slipCi95 ? `, IC95 slip ${fmtBps(m.slipCi95.lo)}..${fmtBps(m.slipCi95.hi)}` : "";
  const src = m.source === "portfolio_journal" ? ", diario del motor vs apertura cruda de sesión, PAPER" : "";
  const real = `coste real ${fmtBps(m.totalPerSideBps)} bps/lado (slip ${fmtBps(m.slipMeanBps)} + com ${fmtBps(m.commissionMeanBps)}${ci}, n=${m.n}${src})`;
  const assumed = c.assumed ? ` vs supuesto ${c.assumed.totalPerSideBps} bps (slip ${c.assumed.slippageBps} + com ${c.assumed.commissionBps})` : " — sin supuesto declarado (sin artefacto autoritativo)";
  const smallN = m.n < MIN_N_FOR_VERDICT ? ` · OJO: n=${m.n} < ${MIN_N_FOR_VERDICT}, muestra pequeña` : "";
  if (!c.breakEven) return `${real}${assumed} → sin breakEvenCurve del artefacto${smallN}`;
  const be = c.breakEven;
  if (be.measuredOutOfCurveRange) {
    // Out-of-range is a bound, not an extrapolation — it stays honest even
    // with a small n (which the tail flags anyway).
    const edge = be.sharpeAtCurveEdge != null ? be.sharpeAtCurveEdge.toFixed(2) : "n/d";
    return be.outOfRangeDirection === "below"
      ? `${real}${assumed} → por DEBAJO del rango ${be.curveMinBps}–${be.curveMaxBps} bps del breakEvenCurve (favorable): Sharpe esperado ≥ ${edge}; re-correr la cadena con costes reales para cuantificar${smallN}`
      : `${real}${assumed} → por ENCIMA del rango ${be.curveMinBps}–${be.curveMaxBps} bps del breakEvenCurve (Sharpe esperado ≤ ${edge}): re-correr la cadena de validación con costes reales${smallN}`;
  }
  if (m.n < MIN_N_FOR_VERDICT) {
    return `${real}${assumed} → n<${MIN_N_FOR_VERDICT}: muestra pequeña, sin extrapolación de Sharpe`;
  }
  const beTxt = be.breakEvenBeyondCurve
    ? `break-even > ${be.curveMaxBps} bps (margen ≥ ${fmtBps(be.marginAtLeastBps ?? 0)} bps)`
    : `break-even ~${fmtBps(be.breakEvenBps ?? 0)} bps (margen ${fmtBps(be.marginBps ?? 0)} bps)`;
  const sharpeTxt = be.sharpeAtMeasured != null ? `Sharpe esperado ${be.sharpeAtMeasured.toFixed(2)}` : "Sharpe esperado n/d";
  return `${real}${assumed} → ${sharpeTxt}, ${beTxt}`;
}

export function calibrateSleeveCosts(
  db: Database, hist: Database | null, cfg: SleeveCostConfig,
  ref: ArtifactRef | null,
  opts: { boundaryMs?: number; sinceMs?: number; seed?: number; nBoot?: number } = {},
): SleeveCostCalibration {
  const obs = readSleeveCostObservations(db, hist, cfg, opts);
  const ctx = loadArtifactCostContext(ref);
  const statOpts = { seed: opts.seed, nBoot: opts.nBoot };

  const labels: CostPeriodLabel[] = cfg.market === "stock" ? ["all"] : ["pre-2026-09-10", "desde-2026-09-10"];
  const periods: SleeveCostPeriodSummary[] = labels.map(period => {
    const slips = obs.slip.filter(s => s.period === period);
    const comms = obs.commissionBps.filter(cm => cm.period === period).map(cm => cm.bps);
    return {
      period,
      buy: computeCostStats(slips.filter(s => s.side === "buy").map(s => s.costBps), statOpts),
      sell: computeCostStats(slips.filter(s => s.side === "sell").map(s => s.costBps), statOpts),
      combined: computeCostStats(slips.map(s => s.costBps), statOpts),
      commissionPerSide: cfg.market === "crypto" ? computeCostStats(comms, statOpts) : null,
    };
  });

  const headlineLabel: CostPeriodLabel = cfg.market === "stock" ? "all" : "desde-2026-09-10";
  const headline = periods.find(p => p.period === headlineLabel)!;
  const assumed = ctx.assumed
    ? { ...ctx.assumed, totalPerSideBps: ctx.assumed.slippageBps + ctx.assumed.commissionBps }
    : null;

  // Q7 V1: the portfolio engine's journal (its only execution record). Every live sleeve may have one;
  // today only the two stock sleeves run on the engine.
  const journal = readPortfolioExecutions(db, cfg.sleeve, { sinceMs: opts.sinceMs, sinceEtDateKey: cfg.sinceEtDateKey });
  const portfolioExecution = journal.obs.length > 0 || journal.excluded.emergencyMark > 0 ? summarizePortfolioExecutions(journal, statOpts) : null;

  let measured: SleeveCostCalibration["measured"] = null;
  if (headline.combined) {
    const commissionMeanBps = headline.commissionPerSide?.meanBps ?? 0;
    measured = {
      period: headlineLabel, n: headline.combined.n,
      slipMeanBps: headline.combined.meanBps, slipCi95: headline.combined.ci95,
      commissionMeanBps,
      totalPerSideBps: headline.combined.meanBps + commissionMeanBps,
      source: "fills",
    };
  } else if (portfolioExecution?.vsSessionOpen) {
    // No comparable fills rows: the journal's fills vs the session's RAW open are the same wedge the
    // replay assumes (fill at the open), on the same price basis. Paper, stated in the verdict.
    const s = portfolioExecution.vsSessionOpen;
    measured = { period: headlineLabel, n: s.n, slipMeanBps: s.meanBps, slipCi95: s.ci95, commissionMeanBps: 0, totalPerSideBps: s.meanBps, source: "portfolio_journal" };
  }

  let breakEven: SleeveCostCalibration["breakEven"] = null;
  if (ctx.curve && ctx.curve.length >= 2 && measured) {
    // The curve's x-axis is the SLIPPAGE per side with commission held at
    // the manifest's base — interpolate at (real total − base commission)
    // so real==assumed lands exactly on the base point.
    const pts = [...ctx.curve].sort((a, b) => a.slippageBps - b.slippageBps);
    const xMeasured = measured.totalPerSideBps - (assumed?.commissionBps ?? 0);
    const atMeasured = interpolateSharpeAt(pts, xMeasured);
    const atAssumed = assumed ? interpolateSharpeAt(pts, assumed.slippageBps) : { sharpe: null, outOfRange: false };
    const cross = breakEvenCostBps(pts);
    const commissionOffset = assumed?.commissionBps ?? 0;
    const direction: "below" | "above" | null = !atMeasured.outOfRange ? null
      : xMeasured < pts[0].slippageBps ? "below" : "above";
    breakEven = {
      curveMinBps: pts[0].slippageBps, curveMaxBps: pts[pts.length - 1].slippageBps,
      sharpeAtAssumed: atAssumed.sharpe,
      sharpeAtMeasured: atMeasured.sharpe,
      measuredOutOfCurveRange: atMeasured.outOfRange,
      outOfRangeDirection: direction,
      sharpeAtCurveEdge: direction == null ? null : direction === "below" ? pts[0].sharpe : pts[pts.length - 1].sharpe,
      // Break-even expressed as TOTAL per-side cost (slippage + base commission).
      breakEvenBps: cross.bps != null ? cross.bps + commissionOffset : null,
      breakEvenBeyondCurve: cross.beyondCurve,
      marginBps: cross.bps != null ? cross.bps + commissionOffset - measured.totalPerSideBps : null,
      marginAtLeastBps: cross.beyondCurve ? pts[pts.length - 1].slippageBps + commissionOffset - measured.totalPerSideBps : null,
    };
  }

  const out: SleeveCostCalibration = {
    sleeve: cfg.sleeve, market: cfg.market,
    comparableSinceEtDate: cfg.sinceEtDateKey,
    manifest: ctx.manifest,
    periods,
    stops: computeCostStats(obs.stops, statOpts),
    excluded: obs.excluded,
    assumed, measured, breakEven,
    portfolioExecution,
    caveat: cfg.market === "stock" ? PAPER_CAVEAT : null,
    verdict: "",
  };
  out.verdict = buildVerdict(out);
  return out;
}

// ── Full calibration (all sleeves) ────────────────────────────────────────

export interface CostCalibration {
  generatedAt: number;
  priceBasisBoundary: string; // ISO date of the expected_px basis change
  sleeves: SleeveCostCalibration[];
  /** The paper caveat, once more at the top level so no consumer can miss it. */
  caveat: string;
}

export function computeCostCalibration(
  db: Database, hist: Database | null,
  opts: {
    artifacts?: Record<string, ArtifactRef>;
    sleeves?: SleeveCostConfig[];
    boundaryMs?: number; sinceMs?: number; seed?: number; nBoot?: number; now?: number;
  } = {},
): CostCalibration {
  const artifacts = opts.artifacts ?? sleeveExpectationArtifacts();
  const sleeves = (opts.sleeves ?? COST_SLEEVES).map(cfg =>
    calibrateSleeveCosts(db, hist, cfg, artifacts[cfg.sleeve] ?? null, opts));
  return {
    generatedAt: opts.now ?? Date.now(),
    priceBasisBoundary: "2026-09-10",
    sleeves,
    caveat: PAPER_CAVEAT,
  };
}
