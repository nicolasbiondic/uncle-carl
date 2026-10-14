#!/usr/bin/env bun
/**
 * Line A replay kernel: cross-sectional long/short crypto momentum,
 * dollar-neutral, over the PIT monthly top-N universe of Binance USDT-M
 * perps (scripts/lib/xsls-universe.ts), on the research DB
 * $UC_RESEARCH_DATA_DIR/hist-perps.db (1h klines + real funding from
 * data.binance.vision, delisted contracts included).
 *
 * It is a ReplayRunner for scripts/walk-forward.ts `runWalkForward` — the
 * whole protocol (nested purged folds, inner DSR selection, stress chain,
 * LOO, break-even curve, PSR evidence, summary schema) is the project's
 * own; only the simulator differs. NOT wired to anything live.
 *
 * How the momentum-shaped ReplayConfig maps onto this strategy
 * (candidateToReplayConfig fills it from the manifest; the manifest
 * declares the semantics):
 *   - cadenceMin        → rebalance every R minutes (decisions on the UTC
 *                         grid, aligned with 8h funding settlements).
 *   - lookbackDays      → signal lookback L: close(T)/close(T−L) − 1.
 *   - maxLongs/maxShorts→ k names long (top of the ranking) / k short
 *                         (bottom), equal dollar weight.
 *   - notionalPctPerSlot→ per-slot notional as a fraction of CURRENT equity
 *                         (k long + k short slots ⇒ gross = 2k × slot).
 *   - slippageBps + commissionBps → per-side cost on every fill's notional.
 *   - funding           → real settled funding_rates events (longs pay
 *                         positive rates, shorts receive; applied at each
 *                         settlement on the live notional).
 *   - universe          → eligibility FILTER over the PIT membership (this
 *                         is what makes walk-forward's LOO work: membership
 *                         ∩ cfg.universe, never backfilled).
 *   - refSymbol         → benchmark only (BTCUSDT), never traded (the
 *                         membership rule excludes the 8 momentum bases).
 *   - entryPct/exitPct, hardStopPct, leverage and every other momentum knob
 *     are IGNORED by this kernel — the manifest sets them to inert values
 *     and documents it.
 *
 * Execution model: decisions at bar close T use only bars closed at or
 * before T; fills at the close of the bar ending at T, costs charged on
 * |Δnotional|. Positions in a symbol with no fresh bar for ≥ DELIST_MS are
 * force-closed at its last close (delisting). Everything is closed at fold
 * end ("fold_end", with costs) so stitched folds never carry phantom
 * exposure.
 */

import { Database } from "bun:sqlite";
import type { ClosedTrade, ReplayConfig, ReplayResult } from "./backtest-momentum-wf";
import type { RiskState } from "../src/strategies/momentum/RiskGuard";
import {
  computeMonthlyMembership,
  DEFAULT_MEMBERSHIP,
  monthKey,
  type MonthMembership,
} from "./lib/xsls-universe";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** No fresh bar for this long while holding ⇒ treat as delisted, close at last price. */
const DELIST_MS = 24 * HOUR;
/** Equity below this fraction of initial ⇒ ruined (chain is cut by the orchestrator). */
const RUIN_FRACTION = 0.05;
/**
 * Settlement-attribution tolerance (F2, 2026-10-10): Binance funding events
 * are timestamped a few ms AFTER the nominal 00/08/16 UTC hour. A settlement
 * at ~T belongs to whoever held DURING the interval ending at T — i.e. the
 * PRE-rebalance book — and a position opened at the T decision must NOT pay
 * it. Both the mark-loop application window ((t−1h, t] + ε) and the carry
 * signal's "settled at or before the decision" window use this ε, and a new
 * episode's funding pointer starts strictly after entry+ε.
 */
const FUNDING_EPS_MS = 60_000;
/** Ignore dust rebalance deltas below this notional (USD). */
const MIN_ORDER_USD = 1;

export type XslsReplayResult = ReplayResult & { orders: number; ordersPerDay: number };

/** H-only execution overlay. Absent: A/F2's result and cash path are unchanged. */
export interface HourlyDropSpec {
  threshold: number;
  holdHours: number;
  zAt: (times: number[], closes: number[], index: number) => number | null;
}

export interface DropDiagnostics {
  signals: number;
  btcBlocked: number;
  btcUnavailable: number;
  fundingBlocked: number;
  capacityBlocked: number;
  boundaryBlocked: number;
  delayedExits: number;
  rebound: Array<{ hour: number; count: number; sum: number }>;
}

interface SymbolSeries {
  closeTimes: number[]; // bar close times (open_time + 1h), ascending
  closes: number[];
  fundingTimes: number[];
  fundingRates: number[];
}

interface DataStore {
  series: Map<string, SymbolSeries>;
  membership: MonthMembership[];
  membershipByMonth: Map<string, string[]>;
  dropSignals?: Map<HourlyDropSpec["zAt"], Map<number, Map<number, DropEntry[]>>>;
}

interface DropEntry { sym: string; z: number; price: number }

const stores = new Map<string, DataStore>();

function getStore(dbPath: string): DataStore {
  let store = stores.get(dbPath);
  if (store) return store;
  const db = new Database(dbPath, { readonly: true });
  try {
    const membership = computeMonthlyMembership(db, Date.parse("2020-06-01"), Date.now(), DEFAULT_MEMBERSHIP);
    store = {
      series: new Map(),
      membership,
      membershipByMonth: new Map(membership.map(m => [m.month, m.symbols])),
    };
    stores.set(dbPath, store);
    return store;
  } finally {
    db.close();
  }
}

function loadSeries(dbPath: string, store: DataStore, symbol: string): SymbolSeries {
  let s = store.series.get(symbol);
  if (s) return s;
  const db = new Database(dbPath, { readonly: true });
  try {
    const bars = db.prepare(
      "SELECT timestamp, close FROM historical_bars WHERE symbol=? AND timeframe='1h' ORDER BY timestamp",
    ).all(symbol) as Array<{ timestamp: number; close: number }>;
    const fr = db.prepare(
      "SELECT funding_time t, rate r FROM funding_rates WHERE symbol=? ORDER BY funding_time",
    ).all(symbol) as Array<{ t: number; r: number }>;
    s = {
      closeTimes: bars.map(b => b.timestamp + HOUR),
      closes: bars.map(b => b.close),
      fundingTimes: fr.map(f => f.t),
      fundingRates: fr.map(f => f.r),
    };
    store.series.set(symbol, s);
    return s;
  } finally {
    db.close();
  }
}

/** Index of the last element of `arr` that is <= t, or -1. */
function idxAtOrBefore(arr: number[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Full LOO reuses the same causal signals, not a billion duplicate z
 * evaluations. Universe/positions/funding/costs remain replay-time filters.
 * Building from loaded future rows is safe: zAt[i] is prefix-only and a
 * candidate is indexed only at its own close time and PIT membership month.
 */
function dropSignals(dbPath: string, store: DataStore, spec: HourlyDropSpec): Map<number, DropEntry[]> {
  const cache = store.dropSignals ??= new Map();
  let byThreshold = cache.get(spec.zAt);
  if (!byThreshold) { byThreshold = new Map(); cache.set(spec.zAt, byThreshold); }
  let signals = byThreshold.get(spec.threshold);
  if (signals) return signals;
  signals = new Map();
  for (const membership of store.membership) {
    const date = new Date(membership.startMs);
    const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    for (const sym of membership.symbols) {
      if (sym === "BTCUSDT") continue;
      const s = loadSeries(dbPath, store, sym);
      for (let i = idxAtOrBefore(s.closeTimes, membership.startMs - 1) + 1; i < s.closeTimes.length && s.closeTimes[i] < end; i++) {
        const z = spec.zAt(s.closeTimes, s.closes, i);
        if (z === null || z > -spec.threshold) continue;
        const t = s.closeTimes[i];
        const entries = signals.get(t) ?? [];
        entries.push({ sym, z, price: s.closes[i] });
        signals.set(t, entries);
      }
    }
  }
  byThreshold.set(spec.threshold, signals);
  return signals;
}

interface Position {
  qty: number; // signed base quantity
  entryAt: number;
  entryPrice: number;
  pnl: number; // running net pnl of the episode (price + funding − fees)
  lastPrice: number;
  lastBarClose: number; // close time of last bar seen
}

/** Ranking signal (fixed per manifest via the driver — see crypto-xsls-wf.ts):
 *  - "priceMomentum" (line A): score = close(T)/close(T−L) − 1; long top-k.
 *  - "fundingCarry" (line F2): score = −(Σ settled funding rates in the
 *    trailing L-day window ÷ L days) — settled-at-or-before-the-decision
 *    only, divided by WINDOW DAYS (not by event count: 1h/4h/8h intervals
 *    coexist). Top-k score = lowest mean funding = LONG; bottom-k = highest
 *    = SHORT, per §12-ter. */
export type XslsSignal = "priceMomentum" | "fundingCarry";

export async function runXslsReplay(
  cfg: ReplayConfig,
  win: { label: string; from: string; to: string },
  _initialRiskState?: RiskState, // no RiskGuard in this kernel — chain state is a no-op by design
  opts?: { signal?: XslsSignal; hourlyDrop?: HourlyDropSpec },
): Promise<ReplayResult | null> {
  const signal: XslsSignal = opts?.signal ?? "priceMomentum";
  const drop = opts?.hourlyDrop;
  const dropDiagnostics: DropDiagnostics | undefined = drop ? {
    signals: 0, btcBlocked: 0, btcUnavailable: 0, fundingBlocked: 0,
    capacityBlocked: 0, boundaryBlocked: 0, delayedExits: 0,
    rebound: Array.from({ length: drop.holdHours }, (_, i) => ({ hour: i + 1, count: 0, sum: 0 })),
  } : undefined;
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);
  const store = getStore(cfg.dbPath!);
  const signals = drop ? dropSignals(cfg.dbPath!, store, drop) : undefined;
  const universe = new Set(cfg.universe);
  const k = Math.min(cfg.maxLongs, cfg.maxShorts);
  const lookbackMs = (cfg.lookbackDays ?? 7) * DAY;
  const cadenceMs = cfg.cadenceMin * 60_000;
  const costPerSide = (cfg.slippageBps + cfg.commissionBps) / 10_000;

  let cash = cfg.initialEquity;
  const positions = new Map<string, Position>();
  const closedTrades: ClosedTrade[] = [];
  const tradesBySymbol: Record<string, { trades: number; grossPnl: number; fees: number; funding: number }> = {};
  const equityHistory: Array<{ t: number; eq: number }> = [];
  let fees = 0;
  let fundingTotal = 0; // net funding P&L (negative = paid)
  let orders = 0;
  let turnover = 0;
  let equity = cfg.initialEquity;
  let peak = equity;
  let maxDd = 0;
  let ruined = false;
  let equitySum = 0;
  let equityN = 0;

  const bySym = (sym: string) => (tradesBySymbol[sym] ??= { trades: 0, grossPnl: 0, fees: 0, funding: 0 });

  const markPrice = (sym: string, t: number): number | null => {
    const s = loadSeries(cfg.dbPath!, store, sym);
    const i = idxAtOrBefore(s.closeTimes, t);
    return i >= 0 ? s.closes[i] : null;
  };

  const closeEpisode = (sym: string, pos: Position, exitPrice: number, t: number, reason: string): void => {
    closedTrades.push({
      symbol: sym,
      side: pos.qty > 0 ? "buy" : "sell",
      pnl: pos.pnl,
      exitAt: t,
      reason,
      entryAt: pos.entryAt,
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: Math.abs(pos.qty),
    });
    const r = bySym(sym);
    r.trades++;
    r.grossPnl += pos.pnl;
  };

  const fill = (sym: string, deltaQty: number, price: number, t: number, reason: string): void => {
    if (deltaQty === 0 || !(price > 0)) return;
    const notional = Math.abs(deltaQty) * price;
    if (notional < MIN_ORDER_USD) return;
    const cost = notional * costPerSide;
    // Cash leg + cost; equity = cash + Σ qty×lastPrice stays exact.
    cash -= deltaQty * price + cost;
    fees += cost;
    orders++;
    turnover += notional;
    bySym(sym).fees += cost;

    const pos = positions.get(sym);
    if (!pos || pos.qty === 0) {
      positions.set(sym, { qty: deltaQty, entryAt: t, entryPrice: price, pnl: -cost, lastPrice: price, lastBarClose: t });
      // Fresh episode: funding starts strictly AFTER entry+ε — a settlement
      // stamped ms after the entry hour belongs to the previous holders.
      const s = loadSeries(cfg.dbPath!, store, sym);
      fundingPtr.set(sym, idxAtOrBefore(s.fundingTimes, t + FUNDING_EPS_MS) + 1);
      return;
    }
    // Realize mark-to-fill on the existing quantity before adjusting it.
    pos.pnl += pos.qty * (price - pos.lastPrice);
    pos.lastPrice = price;
    const newQty = pos.qty + deltaQty;
    if (Math.sign(deltaQty) === Math.sign(pos.qty)) {
      // scale-in
      pos.entryPrice = (pos.entryPrice * Math.abs(pos.qty) + price * Math.abs(deltaQty)) / Math.abs(newQty);
      pos.qty = newQty;
      pos.pnl -= cost;
      return;
    }
    if (Math.abs(newQty) * price < MIN_ORDER_USD) {
      // full close
      pos.pnl -= cost;
      closeEpisode(sym, pos, price, t, reason);
      positions.delete(sym);
      return;
    }
    if (Math.sign(newQty) === Math.sign(pos.qty)) {
      // partial reduce — episode continues
      pos.qty = newQty;
      pos.pnl -= cost;
      return;
    }
    // flip: close the old episode (pro-rata cost), open the remainder
    const closePart = Math.abs(pos.qty) / Math.abs(deltaQty);
    pos.pnl -= cost * closePart;
    closeEpisode(sym, pos, price, t, reason);
    positions.set(sym, {
      qty: newQty,
      entryAt: t,
      entryPrice: price,
      pnl: -cost * (1 - closePart),
      lastPrice: price,
      lastBarClose: t,
    });
    const flipSeries = loadSeries(cfg.dbPath!, store, sym);
    fundingPtr.set(sym, idxAtOrBefore(flipSeries.fundingTimes, t + FUNDING_EPS_MS) + 1);
  };

  const closeAll = (t: number, reason: string): void => {
    for (const [sym, pos] of [...positions]) {
      if (pos.qty === 0) { positions.delete(sym); continue; }
      fill(sym, -pos.qty, pos.lastPrice, t, reason);
    }
  };

  // hourly grid over the fold
  const startHour = Math.ceil(fromMs / HOUR) * HOUR;
  const fundingPtr = new Map<string, number>();

  for (let t = startHour; t < toMs && !ruined; t += HOUR) {
    // 1) mark held positions on this hour's bars; funding; delist checks
    for (const [sym, pos] of positions) {
      if (pos.qty === 0) continue;
      const s = loadSeries(cfg.dbPath!, store, sym);
      const i = idxAtOrBefore(s.closeTimes, t);
      if (i >= 0 && s.closeTimes[i] > pos.lastBarClose) {
        const price = s.closes[i];
        // mark-to-market: equity = cash + Σ qty×lastPrice; pos.pnl is episode bookkeeping
        pos.pnl += pos.qty * (price - pos.lastPrice);
        pos.lastPrice = price;
        pos.lastBarClose = s.closeTimes[i];
      }
      // funding settlements in (t-1h, t] + ε (see FUNDING_EPS_MS: an event
      // stamped ms after the hour belongs to the holders of THIS interval)
      if (cfg.funding) {
        let p = fundingPtr.get(sym) ?? idxAtOrBefore(s.fundingTimes, t - HOUR + FUNDING_EPS_MS) + 1;
        while (p < s.fundingTimes.length && s.fundingTimes[p] <= t + FUNDING_EPS_MS) {
          const pay = pos.qty * pos.lastPrice * s.fundingRates[p]; // longs pay positive rates
          cash -= pay;
          fundingTotal -= pay;
          pos.pnl -= pay;
          bySym(sym).funding -= pay;
          p++;
        }
        fundingPtr.set(sym, p);
      }
      if (drop && s.closeTimes[i] === t) {
        const elapsed = (t - pos.entryAt) / HOUR;
        const rebound = dropDiagnostics!.rebound[elapsed - 1];
        if (rebound) {
          rebound.count++;
          rebound.sum += pos.lastPrice / pos.entryPrice - 1;
        }
        if (elapsed >= drop.holdHours) {
          if (elapsed > drop.holdHours) dropDiagnostics!.delayedExits++;
          fill(sym, -pos.qty, pos.lastPrice, t, "time_exit");
          fundingPtr.delete(sym);
          continue;
        }
      }
      // delisted while held?
      if (t - pos.lastBarClose >= DELIST_MS) {
        fill(sym, -pos.qty, pos.lastPrice, t, "delist");
        fundingPtr.delete(sym);
      }
    }

    // 2) equity mark
    let posValue = 0;
    for (const pos of positions.values()) posValue += pos.qty * pos.lastPrice;
    equity = cash + posValue;
    equitySum += equity;
    equityN++;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
    equityHistory.push({ t, eq: equity });
    if (equity <= RUIN_FRACTION * cfg.initialEquity) {
      ruined = true;
      closeAll(t, "ruin");
      break;
    }

    // 3) rebalance on the cadence grid
    if (t % cadenceMs !== 0) continue;
    const members = store.membershipByMonth.get(monthKey(t)) ?? [];
    if (drop) {
      // BTC is a fixed benchmark, not cfg.refSymbol (LOO may rewrite that).
      const btc = loadSeries(cfg.dbPath!, store, "BTCUSDT");
      const bi = idxAtOrBefore(btc.closeTimes, t);
      const btcZ = bi >= 0 && btc.closeTimes[bi] === t ? drop.zAt(btc.closeTimes, btc.closes, bi) : null;
      const entries: DropEntry[] = [];
      for (const entry of signals!.get(t) ?? []) {
        const { sym } = entry;
        if (!universe.has(sym) || sym === "BTCUSDT" || positions.has(sym)) continue;
        const s = loadSeries(cfg.dbPath!, store, sym);
        dropDiagnostics!.signals++;
        if (btcZ === null) { dropDiagnostics!.btcUnavailable++; continue; }
        if (btcZ <= -2) { dropDiagnostics!.btcBlocked++; continue; }
        // Freshness is fail-closed at entry only. Gaps while held retain
        // A/F's optimistic zero-funding convention, not invented rates.
        const fi = idxAtOrBefore(s.fundingTimes, t + FUNDING_EPS_MS);
        if (cfg.funding && (fi < 0 || t - s.fundingTimes[fi] > 9 * HOUR)) {
          dropDiagnostics!.fundingBlocked++;
          continue;
        }
        if (t + drop.holdHours * HOUR >= toMs) { dropDiagnostics!.boundaryBlocked++; continue; }
        entries.push(entry);
      }
      entries.sort((a, b) => a.z - b.z || a.sym.localeCompare(b.sym));
      const free = Math.max(0, cfg.maxLongs - positions.size);
      dropDiagnostics!.capacityBlocked += Math.max(0, entries.length - free);
      const slot = equity * cfg.notionalPctPerSlot;
      for (const entry of entries.slice(0, free)) {
        // Long-only cash reserve also enforces gross <= equity AFTER fees;
        // no leverage, resizing, early exits or lookahead cap liquidation.
        const notional = Math.min(slot, Math.max(0, cash) / (1 + costPerSide));
        fill(entry.sym, notional / entry.price, entry.price, t, "drop_entry");
      }
      continue;
    }
    const ranked: Array<{ sym: string; ret: number }> = [];
    for (const sym of members) {
      if (!universe.has(sym)) continue;
      const s = loadSeries(cfg.dbPath!, store, sym);
      const iNow = idxAtOrBefore(s.closeTimes, t);
      if (iNow < 0 || s.closeTimes[iNow] !== t) continue; // need a FRESH bar closing exactly at t
      if (signal === "fundingCarry") {
        // Mean DAILY settled funding over the trailing window: Σ rates of
        // events with settlement ≤ decision (+ε), ÷ WINDOW DAYS — never by
        // event count (1h/4h/8h intervals coexist). ≥1 settled event
        // required: a just-listed symbol with no settlements has no carry
        // information and must not rank as "lowest funding".
        const hi = idxAtOrBefore(s.fundingTimes, t + FUNDING_EPS_MS);
        const lo = idxAtOrBefore(s.fundingTimes, t + FUNDING_EPS_MS - lookbackMs);
        if (hi <= lo) continue;
        let sum = 0;
        for (let j = lo + 1; j <= hi; j++) sum += s.fundingRates[j];
        // score = −mean daily funding ⇒ top-k (highest score) = LOWEST
        // funding = LONG; bottom-k = HIGHEST funding = SHORT (§12-ter).
        ranked.push({ sym, ret: -(sum / (cfg.lookbackDays ?? 7)) });
        continue;
      }
      const iPast = idxAtOrBefore(s.closeTimes, t - lookbackMs);
      if (iPast < 0 || t - lookbackMs - s.closeTimes[iPast] > 2 * HOUR) continue; // full lookback required
      const past = s.closes[iPast];
      if (!(past > 0)) continue;
      ranked.push({ sym, ret: s.closes[iNow] / past - 1 });
    }
    ranked.sort((a, b) => (b.ret !== a.ret ? b.ret - a.ret : a.sym.localeCompare(b.sym)));

    const targets = new Map<string, number>(); // signed target notional
    if (ranked.length >= 2 * k) {
      const slot = equity * cfg.notionalPctPerSlot;
      for (let j = 0; j < k; j++) targets.set(ranked[j].sym, slot);
      for (let j = ranked.length - k; j < ranked.length; j++) targets.set(ranked[j].sym, -slot);
    }
    // close positions not in targets
    for (const [sym, pos] of [...positions]) {
      if (pos.qty === 0) { positions.delete(sym); continue; }
      if (!targets.has(sym)) {
        fill(sym, -pos.qty, pos.lastPrice, t, "rebalance");
        fundingPtr.delete(sym);
      }
    }
    // open/resize toward targets
    for (const [sym, targetNotional] of targets) {
      const price = markPrice(sym, t);
      if (price == null || !(price > 0)) continue;
      const cur = positions.get(sym)?.qty ?? 0;
      const targetQty = targetNotional / price;
      fill(sym, targetQty - cur, price, t, "rebalance");
    }
  }

  // fold end: close everything at last marks (with costs) so stitched folds
  // never carry phantom exposure across the boundary.
  if (!ruined) closeAll(toMs - 1, "fold_end");
  let posValue = 0;
  for (const pos of positions.values()) posValue += pos.qty * pos.lastPrice;
  equity = cash + posValue;
  if (equityHistory.length === 0 || equityHistory[equityHistory.length - 1].t < toMs - 1) {
    equityHistory.push({ t: toMs - 1, eq: equity });
  } else {
    equityHistory[equityHistory.length - 1].eq = equity;
  }
  if (equity > peak) peak = equity;
  maxDd = Math.max(maxDd, (peak - equity) / peak);

  // daily returns (UTC day buckets, last mark per day)
  const dailyReturns: Array<{ date: string; ret: number }> = [];
  let prevKey = "";
  let prevClose = cfg.initialEquity;
  let dayLast = cfg.initialEquity;
  for (const ptn of equityHistory) {
    const key = new Date(ptn.t).toISOString().slice(0, 10);
    if (key !== prevKey) {
      if (prevKey) {
        dailyReturns.push({ date: prevKey, ret: prevClose > 0 ? dayLast / prevClose - 1 : 0 });
        prevClose = dayLast;
      }
      prevKey = key;
    }
    dayLast = ptn.eq;
  }
  if (prevKey) dailyReturns.push({ date: prevKey, ret: prevClose > 0 ? dayLast / prevClose - 1 : 0 });

  const rets = dailyReturns.map(r => r.ret);
  const mean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
  const days = Math.max(1, (toMs - fromMs) / DAY);
  const wins = closedTrades.filter(ct => ct.pnl > 0).length;
  const meanEquity = equityN > 0 ? equitySum / equityN : cfg.initialEquity;

  const result: XslsReplayResult = {
    sleeve: cfg.sleeve,
    window: win,
    fromMs,
    toMs,
    config: cfg,
    finalEquity: equity,
    totalReturn: equity / cfg.initialEquity - 1,
    maxDrawdown: maxDd,
    sharpe,
    winRate: closedTrades.length ? wins / closedTrades.length : 0,
    trades: closedTrades.length,
    tradesPerDay: closedTrades.length / days,
    expectancy: closedTrades.length ? closedTrades.reduce((s, ct) => s + ct.pnl, 0) / closedTrades.length : 0,
    fees,
    funding: fundingTotal,
    liquidations: 0,
    marginRejects: 0,
    ruined,
    bench: 0,
    dailyReturns,
    sessionReturns: [],
    tradesBySymbol,
    equityHistory,
    closedTrades,
    turnoverAnnual: meanEquity > 0 ? turnover / meanEquity / (days / 365) : 0,
    displacementCloses: 0,
    profitLockCloses: 0,
    gateBlocks: {},
    hash: "",
    finalRiskState: {
      stateVersion: 1,
      peakEquity: peak,
      dayStartEquity: equity,
      dayStartedAt: toMs,
      consecutiveLosses: 0,
      pausedUntil: 0,
      pauseReason: "",
      lastEvalAt: toMs,
    },
    orders,
    ordersPerDay: orders / days,
  };
  if (dropDiagnostics) Object.assign(result, { dropDiagnostics });
  return result;
}
