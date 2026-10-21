#!/usr/bin/env bun
/**
 * RW portfolio engine — the daily research simulator, a ReplayRunner for
 * scripts/walk-forward.ts (docs/reports/RW-reescritura-rentable.md §2.1, §3).
 *
 * It calls the SAME pure functions the live runner will call
 * (src/portfolio-engine: decide, planOrders, stopFillPrice, fillCost,
 * dailyMarginInterest, dailyFunding) and owns only the clock, the book and
 * the accounting. For every session d of the window:
 *
 *   1. financing — ACT/365 margin interest on the cash borrowed at the
 *      previous close, for the calendar days since the previous session
 *      (weekends accrue); perps have no borrow (rate 0 in their manifests);
 *   2. decision — decide() with asOf = the PREVIOUS session (the last
 *      completed one) and the book marked at that session's closes; the
 *      PriceView clips at asOf, so nothing dated d is visible; the execution
 *      session d is passed as `executionSession` (monthly reconstitution);
 *   3. orders — planOrders() with the venue rules and the asOf closes as
 *      reference prices; a symbol without a bar on d skips its order;
 *   4. fills — at d's OPEN, buys at open×(1+slip), sells at open×(1−slip),
 *      commission on the filled notional (CostModel);
 *   5. stops (D3) — decide() again with the ACTUAL post-fill positions and
 *      the same view, so stops anchor on real average entries; a stop whose
 *      level is ≥ d's low sells everything at the level (gap through the
 *      level → at the open), with sell-side slippage and commission;
 *   6. funding — the real settlements paid by the book held through d
 *      (08:00, 16:00 of d and 00:00 of d+1), notional marked at d's close;
 *   7. mark — equity = cash + Σ qty × close_d; dailyReturns are labelled
 *      with the SESSION date d (never the next day).
 *
 * Fold boundaries follow the protocol's other runners: the book starts flat
 * at `initialEquity`, is liquidated at the last session's close
 * (reason "fold_end"), and the STRATEGY MEMORY (TargetBook.memory —
 * hysteresis, core members, overlay state) travels to the next fold inside
 * the protocol's initialRiskState (PortfolioChainState.portfolioMemory).
 *
 * Long-only; cash may go negative (gross > 1) — no margin rejections are
 * modelled (the designs cap gross at 1.8/2.0 by construction).
 */

import { Database } from "bun:sqlite";
import { computeTurnoverAnnual, hashReplayConfig, type ClosedTrade, type ReplayResult } from "./backtest-momentum-wf";
import { isPortfolioReplayConfig, type PortfolioReplayConfig, type ReplayRunner } from "./walk-forward";
import { INITIAL_RISK_STATE, type RiskState } from "../src/strategies/momentum/RiskGuard";
import { decide, planOrders, stopFillPrice, fillCost, dailyMarginInterest, dailyFunding } from "../src/portfolio-engine";
import type { BookState, CostModel, DecideInput, PlanOrders, PortfolioStrategyConfig, Position, SessionDate, TargetBook } from "../src/portfolio-engine/types";
import {
  IndexMembershipView,
  SessionPriceView,
  barAt,
  calendarDaysBetween,
  calendarForSource,
  fundingByUtcSession,
  indexOfDate,
  lastIndexAtOrBefore,
  loadFundingRates,
  loadSessionSeries,
  perpSymbolFor,
  type SessionSeries,
} from "./lib/portfolioData";

// ── kernel injection ──────────────────────────────────────────────────────

/** The pure functions the simulator calls. Production = the core's; tests
 *  inject doubles; benchmarks swap `decide` for a passive variant. */
export interface PortfolioKernel {
  decide: (input: DecideInput & { executionSession?: SessionDate }) => TargetBook;
  planOrders: PlanOrders;
}

export const coreKernel: PortfolioKernel = { decide, planOrders };

/** The protocol's fold-to-fold state, extended with the strategy memory.
 *  RiskGuard anchors are filled for shape only (continueRiskState rescales
 *  them; nothing here reads them back). */
export interface PortfolioChainState extends RiskState {
  portfolioMemory?: Record<string, unknown>;
}

export interface PortfolioDiagnostics {
  sessions: number;
  /** Executed orders (rebalance fills + stop fills); fold-end liquidation excluded. */
  orders: number;
  openingOrders: number;
  closingOrders: number;
  /** Orders that resize an existing position without opening or closing it. */
  adjustmentOrders: number;
  stopOrders: number;
  foldEndOrders: number;
  ordersPerSession: number;
  adjustmentOrdersPerSession: number;
  /** Orders planned on a session where the symbol printed no bar (skipped). */
  skippedNoBar: number;
  /** Held-symbol sessions with no funding settlement in the data (charged 0). */
  fundingMissingSymbolSessions: number;
  avgGross: number;
  maxGross: number;
  /** Net closed-episode P&L by asset class (manifest data.assetClasses; default = sleeve). */
  pnlByAssetClass: Record<string, number>;
  pnlBySymbol: Record<string, number>;
  marginInterest: number;
}

export type PortfolioReplayResult = ReplayResult & { portfolioDiagnostics: PortfolioDiagnostics };

export interface SimulatorOptions {
  /** Replace the strategy decision (passive benchmarks). */
  decide?: PortfolioKernel["decide"];
  /** symbol → asset class, for the P&L-by-class diagnostic. */
  assetClasses?: Readonly<Record<string, string>>;
}

export function makePortfolioRunner(kernel: PortfolioKernel = coreKernel, opts: SimulatorOptions = {}): ReplayRunner {
  return async (cfg, win, initialRiskState) => {
    if (!isPortfolioReplayConfig(cfg)) {
      throw new Error("portfolio runner: the resolved config carries no `portfolio` block — this runner serves portfolio candidates only");
    }
    return simulatePortfolioWindow(cfg, win, kernel, initialRiskState as PortfolioChainState | undefined, opts);
  };
}

/** The production research runner: the core's decide/planOrders. */
export const runPortfolioReplay: ReplayRunner = makePortfolioRunner();

// ── helpers ───────────────────────────────────────────────────────────────

/** cfg.universe is the protocol's DOMAIN (data identity, LOO, ex-top-decile
 *  reruns): trend/volManaged trade strategy.universe ∩ domain; factorCore's
 *  domain is the point-in-time membership, its exclusions travel in
 *  strategy.exclude (the rerun helpers extend that list). */
export function effectiveStrategy(strategy: PortfolioStrategyConfig, domain: ReadonlySet<string>): PortfolioStrategyConfig {
  if (strategy.kind === "factorCore") return strategy;
  const universe = strategy.universe.filter(s => domain.has(s));
  if (universe.length === 0) throw new Error("portfolio runner: strategy.universe ∩ cfg.universe is empty");
  return universe.length === strategy.universe.length ? strategy : { ...strategy, universe };
}

export function costModelOf(cfg: PortfolioReplayConfig): CostModel {
  return {
    slippageBps: cfg.slippageBps,
    commissionBps: cfg.commissionBps,
    marginInterestAnnual: cfg.marginInterest?.annualRate ?? 0,
    funding: cfg.funding ? "real" : "none",
  };
}

interface Episode {
  qty: number;
  avgEntry: number;
  entryAt: number;
  entryPrice: number;
  realized: number;
  fees: number;
  /** Net funding cash impact since entry (positive = received). */
  funding: number;
  peakQty: number;
}

const DAY_MS = 86_400_000;

// ── the simulator ─────────────────────────────────────────────────────────

export function simulatePortfolioWindow(
  cfg: PortfolioReplayConfig,
  win: { label: string; from: string; to: string },
  kernel: PortfolioKernel = coreKernel,
  chain?: PortfolioChainState,
  opts: SimulatorOptions = {},
): PortfolioReplayResult {
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);
  if (!(toMs > fromMs)) throw new Error(`portfolio runner: invalid window ${win.from} → ${win.to}`);
  const calendar = calendarForSource(cfg.source);
  const ppy = cfg.portfolio.strategy.kind === "volManaged" ? cfg.portfolio.strategy.annualization : calendar === "utc" ? 365 : 252;
  const costModel = costModelOf(cfg);
  const venue = cfg.portfolio.venue;
  const domain = new Set(cfg.universe);
  const strategy = effectiveStrategy(cfg.portfolio.strategy, domain);
  const decideFn = opts.decide ?? kernel.decide;
  const loadFrom = fromMs - cfg.warmupDays * DAY_MS;
  const hasStops = strategy.kind === "cryptoTrend" && strategy.stop.mode !== "none";
  const classOf = (sym: string) => opts.assetClasses?.[sym] ?? cfg.sleeve;

  const db = new Database(cfg.dbPath, { readonly: true });
  let series: Map<string, SessionSeries>;
  let membership: IndexMembershipView | undefined;
  let fundingBySession: Map<string, Map<SessionDate, number>> | undefined;
  try {
    let symbols: string[];
    if (strategy.kind === "factorCore") {
      if (!cfg.membership) throw new Error("portfolio runner: factorCore requires cfg.membership (data.membership in the manifest)");
      membership = IndexMembershipView.load(db, cfg.membership.index, cfg.membership.exclude ?? []);
      symbols = [...new Set([...cfg.universe, cfg.refSymbol, ...membership.overlapping(loadFrom, toMs)])];
    } else {
      symbols = [...new Set([...strategy.universe, cfg.refSymbol])];
    }
    series = loadSessionSeries(db, symbols, cfg.source, cfg.timeframe, loadFrom, toMs, calendar);
    if (costModel.funding === "real") {
      const tradable = strategy.kind === "factorCore" ? [] : strategy.universe;
      // Settlements stamped at/after toMs belong to the next fold (the book
      // is liquidated at the last close): load strictly before toMs.
      const events = loadFundingRates(db, tradable.map(perpSymbolFor), fromMs, toMs);
      fundingBySession = new Map();
      for (const sym of tradable) {
        const evs = (events.get(perpSymbolFor(sym)) ?? []).filter(e => e.time < toMs);
        fundingBySession.set(sym, fundingByUtcSession(evs));
      }
    }
  } finally {
    db.close();
  }

  const ref = series.get(cfg.refSymbol);
  if (!ref) throw new Error(`portfolio runner: no ${cfg.timeframe} bars for refSymbol ${cfg.refSymbol} in [${win.from}, ${win.to}) + warmup`);
  const firstIdx = ref.timestamps.findIndex(t => t >= fromMs);
  if (firstIdx < 0) throw new Error(`portfolio runner: refSymbol ${cfg.refSymbol} has no session inside [${win.from}, ${win.to})`);
  if (firstIdx === 0) throw new Error(`portfolio runner: no completed session before ${win.from} — increase warmupDays`);

  // ── book ────────────────────────────────────────────────────────────────
  const positions = new Map<string, Episode>();
  let cash = cfg.initialEquity;
  let memory: Record<string, unknown> = chain?.portfolioMemory ?? {};
  let prevDate = ref.dates[firstIdx - 1];
  let prevEquity = cfg.initialEquity;
  // Seed point at the window start, like every other runner: stitchEquityHistory
  // seeds the chain at fromMs too, so an earlier-stamped point would create an
  // out-of-order day bucket (a spurious zero return) in the stitched series.
  const equityHistory: Array<{ t: number; eq: number }> = [{ t: fromMs, eq: cfg.initialEquity }];
  const dailyReturns: Array<{ date: string; ret: number }> = [];
  const sessionReturns: Array<{ from: string; to: string; ret: number }> = [];
  const closedTrades: ClosedTrade[] = [];
  const tradesBySymbol: Record<string, { trades: number; grossPnl: number; fees: number; funding: number }> = {};
  const pnlByAssetClass: Record<string, number> = {};
  const pnlBySymbol: Record<string, number> = {};
  let fees = 0, fundingTotal = 0, marginInterestTotal = 0, turnover = 0;
  let sessions = 0, grossSum = 0, maxGross = 0;
  const diag = { opening: 0, closing: 0, adjustment: 0, stop: 0, foldEnd: 0, skippedNoBar: 0, fundingMissing: 0 };
  let ruined = false;
  let lastT = equityHistory[0].t;

  const perSymbol = (sym: string) => (tradesBySymbol[sym] ??= { trades: 0, grossPnl: 0, fees: 0, funding: 0 });

  const lastCloseAtOrBefore = (sym: string, date: SessionDate): number | undefined => {
    const s = series.get(sym);
    if (!s) return undefined;
    const i = lastIndexAtOrBefore(s.dates, date);
    return i >= 0 ? s.close[i] : undefined;
  };

  const fill = (symbol: string, side: "buy" | "sell", qty: number, refPx: number, t: number, reason: "rebalance" | "stop_loss" | "fold_end") => {
    const f = fillCost(side, qty, refPx, costModel);
    cash += f.cashDelta;
    fees += f.commission;
    turnover += f.notional;
    perSymbol(symbol).fees += f.commission;
    let p = positions.get(symbol);
    if (side === "buy") {
      if (!p) {
        p = { qty: 0, avgEntry: 0, entryAt: t, entryPrice: f.price, realized: 0, fees: 0, funding: 0, peakQty: 0 };
        positions.set(symbol, p);
        diag.opening++;
      } else {
        diag.adjustment++;
      }
      p.avgEntry = (p.qty * p.avgEntry + qty * f.price) / (p.qty + qty);
      p.qty += qty;
      p.peakQty = Math.max(p.peakQty, p.qty);
      p.fees += f.commission;
      return;
    }
    if (!p) throw new Error(`portfolio runner: sell without a position (${symbol})`);
    const q = Math.min(qty, p.qty);
    p.realized += q * (f.price - p.avgEntry);
    p.fees += f.commission;
    p.qty -= q;
    const flat = p.qty <= 1e-9 * Math.max(1, p.peakQty);
    if (reason === "stop_loss") diag.stop++;
    else if (reason === "fold_end") diag.foldEnd++;
    else if (flat) diag.closing++;
    else diag.adjustment++;
    if (!flat) return;
    const pnl = p.realized - p.fees + p.funding;
    closedTrades.push({ symbol, side: "buy", pnl, exitAt: t, reason, entryAt: p.entryAt, entryPrice: p.entryPrice, exitPrice: f.price, qty: p.peakQty });
    const ts = perSymbol(symbol);
    ts.trades += 1;
    ts.grossPnl += pnl;
    ts.funding += p.funding;
    pnlBySymbol[symbol] = (pnlBySymbol[symbol] ?? 0) + pnl;
    pnlByAssetClass[classOf(symbol)] = (pnlByAssetClass[classOf(symbol)] ?? 0) + pnl;
    positions.delete(symbol);
  };

  const currentPositions = (): Position[] =>
    [...positions].filter(([, p]) => p.qty > 0).map(([symbol, p]) => ({ symbol, qty: p.qty, avgEntryPrice: p.avgEntry }));

  // ── sessions ────────────────────────────────────────────────────────────
  for (let i = firstIdx; i < ref.dates.length && ref.timestamps[i] < toMs; i++) {
    const d = ref.dates[i];
    const asOf = ref.dates[i - 1];
    const t = ref.timestamps[i];
    sessions++;
    lastT = t;

    // 1. overnight financing on the cash borrowed at the previous close.
    const interest = dailyMarginInterest(-cash, costModel, calendarDaysBetween(prevDate, d));
    cash -= interest;
    marginInterestTotal += interest;

    // 2. decision on the last completed session.
    const view = new SessionPriceView(series, asOf);
    const bookPositions = currentPositions();
    const refPrices: Record<string, number> = {};
    let equityRef = cash;
    for (const p of bookPositions) {
      const px = view.lastClose(p.symbol);
      if (px !== undefined) { refPrices[p.symbol] = px; equityRef += p.qty * px; }
    }
    const book: BookState = { equity: equityRef, positions: bookPositions, memory };
    const target = decideFn({ view, membership, book, config: strategy, executionSession: d });
    for (const s of Object.keys(target.weights)) {
      if (refPrices[s] === undefined) {
        const px = view.lastClose(s);
        if (px !== undefined) refPrices[s] = px;
      }
    }

    // 3–4. orders at the asOf reference prices, filled at d's open.
    const orders = kernel.planOrders(target, book, refPrices, venue);
    for (const o of orders) {
      const s = series.get(o.symbol);
      const bi = s ? indexOfDate(s.dates, d) : -1;
      if (bi < 0) { diag.skippedNoBar++; continue; }
      fill(o.symbol, o.side, o.qty, s!.open[bi], t, "rebalance");
    }

    // 5. stops anchored on the actual fills (same view, no fill-day close).
    memory = target.memory as Record<string, unknown>;
    let stops = target.stops;
    if (hasStops) {
      const post = decideFn({ view, membership, book: { equity: equityRef, positions: currentPositions(), memory }, config: strategy, executionSession: d });
      stops = post.stops;
      memory = post.memory as Record<string, unknown>;
    }
    for (const st of stops) {
      const p = positions.get(st.symbol);
      if (!p || !(p.qty > 0)) continue;
      const s = series.get(st.symbol);
      const bi = s ? indexOfDate(s.dates, d) : -1;
      if (bi < 0) continue;
      const px = stopFillPrice(st.stopPrice, barAt(s!, bi));
      if (px === null) continue;
      fill(st.symbol, "sell", p.qty, px, t, "stop_loss");
    }

    // 6. real funding on the book held through d, marked at d's close.
    if (fundingBySession) {
      for (const [sym, p] of positions) {
        if (!(p.qty > 0)) continue;
        const rate = fundingBySession.get(sym)?.get(d);
        if (rate === undefined) { diag.fundingMissing++; continue; }
        const px = lastCloseAtOrBefore(sym, d) ?? p.avgEntry;
        const paid = dailyFunding(p.qty * px, rate, costModel);
        cash -= paid;
        p.funding -= paid;
        fundingTotal -= paid;
      }
    }

    // 7. mark at the close; the session's return carries its own label.
    let grossNotional = 0;
    for (const [sym, p] of positions) {
      if (!(p.qty > 0)) continue;
      const px = lastCloseAtOrBefore(sym, d);
      if (px === undefined) throw new Error(`portfolio runner: no price to mark ${sym} at ${d}`);
      grossNotional += p.qty * px;
    }
    const equity = cash + grossNotional;
    equityHistory.push({ t, eq: equity });
    const ret = prevEquity > 0 ? equity / prevEquity - 1 : 0;
    dailyReturns.push({ date: d, ret });
    sessionReturns.push({ from: prevDate, to: d, ret });
    if (equity > 0) {
      const gross = grossNotional / equity;
      grossSum += gross;
      maxGross = Math.max(maxGross, gross);
    }
    prevEquity = equity;
    prevDate = d;
    if (!(equity > 0) || !Number.isFinite(equity)) { ruined = true; break; }
  }

  // ── fold end: liquidate at the last session's close ─────────────────────
  if (!ruined && positions.size > 0) {
    for (const [sym, p] of [...positions]) {
      const px = lastCloseAtOrBefore(sym, prevDate);
      if (px === undefined) throw new Error(`portfolio runner: fold_end liquidation has no terminal price for ${sym}`);
      fill(sym, "sell", p.qty, px, lastT, "fold_end");
    }
    // The liquidation costs land on the last session (same bucket).
    equityHistory.push({ t: lastT, eq: cash });
    const last = dailyReturns[dailyReturns.length - 1];
    if (last) {
      const base = equityHistory.length >= 3 ? equityHistory[equityHistory.length - 3].eq : cfg.initialEquity;
      last.ret = base > 0 ? cash / base - 1 : 0;
      sessionReturns[sessionReturns.length - 1].ret = last.ret;
    }
  }
  const finalEquity = ruined ? Math.max(0, prevEquity) : cash;

  // ── metrics (same conventions as the protocol's other runners) ──────────
  const rets = dailyReturns.map(r => r.ret);
  const mean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(ppy) : 0;
  let peak = equityHistory[0].eq, maxDrawdown = 0;
  for (const e of equityHistory) {
    if (e.eq > peak) peak = e.eq;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - e.eq) / peak);
  }
  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const days = (toMs - fromMs) / DAY_MS;
  const refStart = ref.close[firstIdx - 1];
  const refEndIdx = Math.min(ref.dates.length - 1, lastIndexAtOrBefore(ref.dates, prevDate));
  const bench = refStart > 0 && refEndIdx >= 0 ? ref.close[refEndIdx] / refStart - 1 : 0;
  const orders = diag.opening + diag.closing + diag.adjustment + diag.stop;

  const finalRiskState: PortfolioChainState = {
    ...INITIAL_RISK_STATE,
    peakEquity: peak,
    dayStartEquity: finalEquity,
    dayStartedAt: lastT,
    lastEvalAt: lastT,
    portfolioMemory: memory,
  };

  return {
    sleeve: cfg.sleeve,
    window: win,
    fromMs,
    toMs,
    config: cfg,
    finalEquity,
    totalReturn: finalEquity / cfg.initialEquity - 1,
    maxDrawdown,
    sharpe,
    winRate: closedTrades.length ? wins / closedTrades.length : 0,
    trades: closedTrades.length,
    tradesPerDay: days > 0 ? closedTrades.length / days : 0,
    expectancy: closedTrades.length ? closedTrades.reduce((s, t) => s + t.pnl, 0) / closedTrades.length : 0,
    fees,
    funding: fundingTotal,
    marginInterest: marginInterestTotal,
    liquidations: 0,
    marginRejects: 0,
    ruined,
    bench,
    dailyReturns,
    sessionReturns,
    tradesBySymbol,
    equityHistory,
    closedTrades,
    turnoverAnnual: computeTurnoverAnnual(turnover, equityHistory, fromMs, toMs, cfg.initialEquity),
    displacementCloses: 0,
    profitLockCloses: 0,
    gateBlocks: {},
    hash: hashReplayConfig(cfg),
    finalRiskState,
    portfolioDiagnostics: {
      sessions,
      orders,
      openingOrders: diag.opening,
      closingOrders: diag.closing,
      adjustmentOrders: diag.adjustment,
      stopOrders: diag.stop,
      foldEndOrders: diag.foldEnd,
      ordersPerSession: sessions > 0 ? orders / sessions : 0,
      adjustmentOrdersPerSession: sessions > 0 ? diag.adjustment / sessions : 0,
      skippedNoBar: diag.skippedNoBar,
      fundingMissingSymbolSessions: diag.fundingMissing,
      avgGross: sessions > 0 ? grossSum / sessions : 0,
      maxGross,
      pnlByAssetClass,
      pnlBySymbol,
      marginInterest: marginInterestTotal,
    },
  };
}
