#!/usr/bin/env bun
/**
 * Line B (docs/reports/V-plan-volumen-rentabilidad.md §12): daily replay
 * kernel for a LONG/SHORT short-term reversal strategy over the
 * point-in-time S&P 500 membership (data/hist-sp500.db, index_membership
 * "sp500"), minus the 43 live symbols (shared Alpaca wallet).
 *
 * Strategy per candidate (params in StReversalParams):
 *   - Signal at each session d uses ONLY completed bars (strictly before d):
 *     k-session return r = close[last]/close[last-k] − 1.
 *   - residual="sector": score = r − r_sectorETF over the same k sessions,
 *     where each stock's sector ETF is the one with the highest Pearson
 *     correlation of daily returns over the last `corrLookbackSessions`
 *     completed sessions, recomputed every `sectorRefreshSessions` sessions
 *     (strictly backward-looking; a stock with no computable correlation
 *     falls back to the raw score — declared).
 *   - LONG the lowest scores (biggest losers), SHORT the highest scores
 *     (biggest gainers); `slotsPerSide` fixed-notional slots per side
 *     (slotUsd = initialEquity × maxGrossMult / (2 × slotsPerSide)) —
 *     dollar-neutral at entry by construction (same slot both sides).
 *   - Exit at the open of the `holdDays`-th session after entry (time exit,
 *     reason TIME_EXIT). No intraday hard stop (declared: 1–5 session holds,
 *     the maxDD gate of §12 covers the risk axis). DELISTED closes at the
 *     last recorded close (declared OPTIMISTIC, same as the A-sp500 kernels).
 *
 * Execution model (same discipline as meanrev-replay.ts / the daily stock
 * sleeves): decisions on yesterday's completed bar, fills at TODAY's open
 * ± slippageBps (per-side §12 cost: slippage carries the whole 2/5 bps,
 * commissionBps stays 0), WHOLE shares floored on the raw open (Alpaca
 * doesn't short fractionals) — a symbol whose open doesn't fit one share in
 * the slot is excluded by price. Shorts additionally require open ≥ $5
 * (borrowable/marginable floor, declared).
 *
 * Costs (§12 line B): per-side bps + short borrow `shortBorrowAnnual`
 * (0.5%/yr base, 1%/yr stress) accrued per calendar day on the short book
 * marked at the last completed close, charged to equity daily (reported in
 * the `funding` field of the result). Reg-T margin interest is NOT part of
 * the §12 pre-registered costs for B and is not modeled (declared: the
 * dollar-neutral book's net debit ≈ 0 with short proceeds credited).
 *
 * Timeline = the refSymbol's (SPY) sessions inside the window. Sessions are
 * labeled with getETDateKey like every stock replay. No RiskGuard chain:
 * slots are fixed notional and there is no live engine for this strategy —
 * folds are independent (declared; finalRiskState carries the initial state
 * through untouched for harness compatibility).
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getETDateKey } from "../src/db/database";
import { getPreviousTradingDay } from "../src/utils/marketHours";
import { INITIAL_RISK_STATE, type RiskState } from "../src/strategies/momentum/RiskGuard";
import { canonicalJson, type ClosedTrade } from "./backtest-momentum-wf";
import { isMemberAt, loadMembership, type MembershipBook } from "./lib/membership";
import { rsi2 } from "../src/strategies/meanrev/MeanRevEngine";
import { trailPctFromVol } from "../src/strategies/momentum/MomentumEngine";
import { loadCloseSlices, type CloseSliceRow } from "./lib/closeSlices";

export interface StReversalParams {
  /** k: signal lookback in completed sessions (1–5 per §12 line B). */
  lookbackDays: number;
  /** Exit at the open of the holdDays-th session after entry. */
  holdDays: number;
  /** "sector" = score residual vs the correlation-assigned sector ETF;
   *  "none" = raw k-session return (ablation). */
  residual: "sector" | "none";
  /** Fixed-notional slots per side (dollar-neutral book). */
  slotsPerSide: number;
}

export interface StReversalConfig {
  sleeve: "streversal";
  dbPath: string;
  source: string;
  timeframe: string;
  /** Session timeline + benchmark (SPY). Never traded. */
  refSymbol: string;
  /** Sector ETFs for the residual (XLK/XLF/… — present in hist-sp500.db). */
  sectorEtfs: string[];
  membership: { index: string; exclude: string[] };
  /** Sessions of daily returns for the sector-correlation assignment. */
  corrLookbackSessions: number;
  /** Recompute the sector assignment every N sessions (backward-looking). */
  sectorRefreshSessions: number;
  /** Per-side cost in bps (§12: base 2, stress 5; break-even tiers sweep it). */
  slippageBps: number;
  commissionBps: number;
  /** Short borrow, FRACTION per year (base 0.005, stress 0.01). */
  shortBorrowAnnual: number;
  initialEquity: number;
  /** Gross cap as a multiple of initialEquity (§13: 3× on $8.3k). */
  maxGrossMult: number;
  params: StReversalParams;
  warmupDays: number;
  // Harness-compat flags (stocks daily): hashed, never varied.
  rthOnly: boolean;
  funding: boolean;
  barMinutes: number;
  barMinutesEq: number;
  /** B2 (§12-bis) sizing axis — BOTH OPT-IN: canonicalJson drops undefined
   *  keys, so every line-B candidate keeps its legacy hash and the exact
   *  legacy behavior (fixed-notional slots, whole shares both sides).
   *  "equityProportional": slot = DECISION-TIME equity (marked at the last
   *  completed closes — no lookahead) × maxGrossMult / (2 × slotsPerSide),
   *  recomputed at every rebalance, so exposure de-risks with drawdowns
   *  (the identified B failure mode). Open positions are NOT resized —
   *  the 3–5 session hold rolls the whole book anyway (declared). */
  sizing?: "equityProportional";
  /** B2: longs size exactly (fractional qty — Alpaca supports fractional
   *  long market orders); §12-bis constrains WHOLE shares + price ≥ $5 to
   *  the SHORT side only. Absent/false = legacy (whole shares both sides). */
  fractionalLongs?: boolean;
  /** §12-septies line G (OPT-IN; absent = the exact line-B/B2 behavior AND
   *  every legacy hash — canonicalJson drops undefined keys). See
   *  CloseReversalSpec. When set: params.holdDays = MAX HOLD SESSIONS,
   *  params.residual must be "none" and params.lookbackDays must be 1
   *  (both inert — the Connors signal replaces the residual-momentum one). */
  closeReversal?: CloseReversalSpec;
  /** 15:45-slice database path (runtime-only like dbPath — EXCLUDED from
   *  hashStConfig; the slice rows enter the run's data identity through
   *  hashCloseSlices in the driver). Required with closeReversal. */
  sliceDbPath?: string;
}

/**
 * §12-septies line G: Connors-style close-auction reversal over the line-B
 * universe. The SIGNAL is computed at 15:45 ET of each session (the 15:45
 * price is the series' last value; the SMA uses the `smaLong` PRIOR closes,
 * per the pre-registration "media de los 200 cierres previos"):
 *   LONG:  RSI(2) < entryRsi AND p1545 > SMA(smaLong prior closes),
 *          p1545 ≥ minPrice, ≥ minPriorCloses prior closes; lowest RSI
 *          first, max slotsPerSide names.
 *   SHORT (G4 mirror, `short` set): RSI(2) > short.entryRsi AND p1545 <
 *          SMA(prior closes); same floors; highest RSI first.
 * ENTRIES fill in the SAME session's closing auction (close ± cost), whole
 * shares fixed at 15:45 (floor(slot / p1545)). EXITS per `exit`:
 *   "nextOpen":  at the open of the holdDays-th session after entry (G1/G4).
 *   "nextClose": at the next session's close, UNLESS still among the top
 *                slotsPerSide signal names at 15:45 (kept, no sell+rebuy),
 *                max holdDays sessions (G2).
 *   "sma5":      at the close of the first session whose 15:45 price exceeds
 *                the SMA(smaExit) of the 4 prior closes + that price, or at
 *                the close of the holdDays-th session; with the meanrev
 *                vol-scaled hard stop (gap stops at the open, intraday stops
 *                at the level, never on the entry session) (G3).
 */
export interface CloseReversalSpec {
  entryRsi: number;
  smaLong: number;
  minPrice: number;
  minPriorCloses: number;
  exit: "nextOpen" | "nextClose" | "sma5";
  /** Required when exit === "sma5". */
  smaExit?: number;
  /** meanrev vol-scaled hard stop (G3): kSigma × σ(lookbackBars daily
   *  closes), clamped [minPct, maxPct] percent-units, resolved ONCE at
   *  entry from completed closes strictly before the entry session. */
  hardStop?: { kSigma: number; lookbackBars: number; minPct: number; maxPct: number };
  /** G4 mirror short: sell at the close when RSI(2) > entryRsi and p1545 <
   *  SMA(prior closes); cover at the next open; borrow accrues. */
  short?: { entryRsi: number };
}

/** SHA-256 of the canonical config, excluding runtime-only dbPath —
 *  the same identity convention as hashReplayConfig. */
export function hashStConfig(cfg: StReversalConfig): string {
  // sliceDbPath is a machine-local path like dbPath: excluded. It was never
  // present in any legacy config (undefined is dropped by JSON.stringify),
  // so every pre-existing hash is byte-identical.
  const { dbPath, sliceDbPath, ...semantic } = cfg;
  return createHash("sha256").update(canonicalJson(semantic)).digest("hex");
}

const MAX_GAP_DAYS = 10;
const DAY_MS = 86_400_000;

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; volume: number; date: string }
interface Series { bars: Bar[]; closes: number[]; indexByDate: Map<string, number> }

// ── full-history series cache (per dbPath) ──────────────────────────────
// Each orchestrator run uses one immutable snapshot path; dozens of fold
// replays over the same ~700 members amortize the SQL to one load each.
const seriesCache = new Map<string, Map<string, Series | null>>();

function loadFullSeries(db: Database, cfg: StReversalConfig, symbol: string): Series | null {
  let bySymbol = seriesCache.get(cfg.dbPath);
  if (!bySymbol) { bySymbol = new Map(); seriesCache.set(cfg.dbPath, bySymbol); }
  if (bySymbol.has(symbol)) return bySymbol.get(symbol)!;
  const rows = db.prepare(
    `SELECT timestamp, open, high, low, close, volume FROM historical_bars
     WHERE symbol = ? AND timeframe = ? AND source = ?
     ORDER BY timestamp ASC`,
  ).all(symbol, cfg.timeframe, cfg.source) as Array<Omit<Bar, "date">>;
  if (rows.length === 0) { bySymbol.set(symbol, null); return null; }
  // Dedupe by ET trading date, latest timestamp wins — verbatim meanrev-replay.
  const byDate = new Map<string, Bar>();
  for (const row of rows) {
    const date = getETDateKey(row.timestamp);
    byDate.set(date, { ...row, date });
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const s: Series = {
    bars,
    closes: bars.map(b => b.close),
    indexByDate: new Map(bars.map((b, i) => [b.date, i])),
  };
  bySymbol.set(symbol, s);
  return s;
}

/** Index of the first bar dated >= `date` (bars before it are completed). */
function cutIndex(s: Series, date: string): number {
  const bars = s.bars;
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].date < date) lo = mid + 1; else hi = mid; }
  return lo;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  if (sxx < 1e-18 || syy < 1e-18) return null;
  return sxy / Math.sqrt(sxx * syy);
}

interface Position {
  symbol: string;
  side: "buy" | "sell";   // entry side: buy = long, sell = short
  qty: number;            // positive
  entryPrice: number;
  entryAt: number;
  entrySession: number;
  entryFee: number;
  mark: number;
  borrowPaid: number;     // shorts only
  /** closeReversal G3: entry-anchored hard-stop PRICE (longs). */
  stopPrice?: number | null;
  /** closeReversal: entry session's date (drives the night/day split). */
  entryDate?: string;
}

export interface StReversalResult {
  sleeve: string;
  window: { label: string; from: string; to: string };
  fromMs: number;
  toMs: number;
  config: StReversalConfig;
  finalEquity: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number;
  trades: number;
  tradesPerDay: number;
  expectancy: number;
  fees: number;
  /** Short borrow paid (carry cost channel — the `funding` slot of the
   *  shared summary schema). */
  funding: number;
  liquidations: number;
  marginRejects: number;
  ruined: boolean;
  bench: number;
  dailyReturns: Array<{ date: string; ret: number }>;
  sessionReturns: Array<{ from: string; to: string; ret: number }>;
  tradesBySymbol: Record<string, { trades: number; grossPnl: number; fees: number; funding: number }>;
  equityHistory: Array<{ t: number; eq: number }>;
  closedTrades: ClosedTrade[];
  /** Σ(entry+exit notional)/initialEquity annualized over the window. */
  turnoverAnnual: number;
  /** Executed fills (1 entry + 1 exit per closed trade) per SESSION. */
  ordersPerSession: number;
  /** Sessions replayed (refSymbol timeline inside the window). */
  sessions: number;
  /** Max Σ|position notional| observed at the daily close marks. */
  maxGrossSeen: number;
  hash: string;
  finalRiskState: RiskState;
  /** closeReversal output-only extras (absent on the legacy path). Gross
   *  night (close→next open) vs day (open→close/exit) price-leg split. */
  nightPnl?: number;
  dayPnl?: number;
  /** closeReversal signal telemetry: per-session averages and how many
   *  sessions ended with every long (short) slot occupied. */
  signalStats?: {
    sessions: number;
    avgLongSignals: number;
    fullLongSessions: number;
    avgShortSignals?: number;
    fullShortSessions?: number;
  };
}

const membershipCache = new Map<string, MembershipBook>();

// closeReversal: 15:45-slice cache per slice-DB path (same amortization as
// seriesCache — dozens of fold replays reuse one immutable snapshot).
const sliceCache = new Map<string, Map<string, Map<string, CloseSliceRow>>>();

/**
 * Run one fully-resolved reversal replay. Same contract as the other
 * kernels: config + window in, result (or null on an empty window) out.
 */
export async function runStReversalReplay(
  cfg: StReversalConfig,
  win: { label: string; from: string; to: string },
  initialRiskState?: RiskState,
): Promise<StReversalResult | null> {
  const p = cfg.params;
  if (p.lookbackDays < 1 || p.holdDays < 1 || p.slotsPerSide < 1) throw new Error("invalid StReversalParams");
  const cr = cfg.closeReversal;
  if (cr) {
    // §12-septies G: the Connors close-auction mode replaces the residual
    // signal entirely — the legacy knobs it ignores must be pinned to inert
    // values (config that changes nothing is rejected, same philosophy as
    // the walk-forward validators).
    if (p.residual !== "none") throw new Error('closeReversal requires params.residual="none"');
    if (p.lookbackDays !== 1) throw new Error("closeReversal requires params.lookbackDays=1 (inert)");
    if (!cfg.sliceDbPath) throw new Error("closeReversal requires cfg.sliceDbPath (hist-sp500-close.db)");
    if (cfg.sizing !== "equityProportional") throw new Error('closeReversal requires sizing="equityProportional" (§12-septies G)');
    if (cfg.fractionalLongs) throw new Error("closeReversal trades WHOLE shares on both legs (no fractionalLongs)");
    if (cr.exit === "sma5" && !(cr.smaExit !== undefined && cr.smaExit >= 1)) throw new Error('closeReversal exit="sma5" requires smaExit');
  }
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);
  const loadFrom = fromMs - cfg.warmupDays * DAY_MS;
  const slipIn = cfg.slippageBps / 10_000;
  const commRate = cfg.commissionBps / 10_000;
  const slotUsd = (cfg.initialEquity * cfg.maxGrossMult) / (2 * p.slotsPerSide);
  const eqProp = cfg.sizing === "equityProportional";
  const minWarmupBars = cr ? cr.minPriorCloses : cfg.corrLookbackSessions + p.lookbackDays + 2;

  const db = new Database(cfg.dbPath, { readonly: true });
  try {
    // ── membership + series ───────────────────────────────────────────────
    const mKey = `${cfg.dbPath}|${cfg.membership.index}`;
    let book = membershipCache.get(mKey);
    if (!book) { book = loadMembership(db, cfg.membership.index); membershipCache.set(mKey, book); }
    const excluded = new Set([...cfg.membership.exclude, cfg.refSymbol, ...cfg.sectorEtfs]);
    const members: string[] = [];
    for (const [ticker, tramos] of book) {
      if (excluded.has(ticker)) continue;
      if (tramos.some(t => t.startMs < toMs && (t.endMs === null || t.endMs > fromMs))) members.push(ticker);
    }
    members.sort();

    const series = new Map<string, Series>();
    let missing = 0;
    for (const sym of members) {
      const s = loadFullSeries(db, cfg, sym);
      if (s) series.set(sym, s); else missing++;
    }
    if (missing > 0) console.warn(`streversal(${win.label}): ${missing}/${members.length} overlapping members have no bars and are dropped`);

    const etfSeries = new Map<string, Series>();
    for (const etf of cfg.sectorEtfs) {
      const s = loadFullSeries(db, cfg, etf);
      if (!s) throw new Error(`streversal: no bars for sector ETF ${etf}`);
      etfSeries.set(etf, s);
    }
    const refSeries = loadFullSeries(db, cfg, cfg.refSymbol);
    if (!refSeries) throw new Error(`streversal: no bars for refSymbol ${cfg.refSymbol}`);
    // Fail-closed refSymbol coverage: full warmup + window, no internal gaps
    // (it IS the session timeline).
    const refWindowBars = refSeries.bars.filter(b => b.timestamp >= fromMs && b.timestamp < toMs);
    if (refWindowBars.length === 0) return null;
    const refWarmup = refSeries.bars.filter(b => b.timestamp >= loadFrom && b.timestamp < fromMs).length;
    if (refWarmup < Math.min(cfg.warmupDays / 2, minWarmupBars)) {
      throw new Error(`streversal: insufficient refSymbol warmup (${refWarmup} bars)`);
    }
    for (let i = 1; i < refWindowBars.length; i++) {
      if (refWindowBars[i].timestamp - refWindowBars[i - 1].timestamp > MAX_GAP_DAYS * DAY_MS) {
        throw new Error(`streversal: refSymbol gap ${refWindowBars[i - 1].date} -> ${refWindowBars[i].date}`);
      }
    }

    // ── state ─────────────────────────────────────────────────────────────
    const positions: Position[] = [];
    const closed: ClosedTrade[] = [];
    let realizedGross = 0;
    let feesPaid = 0;
    let borrowPaid = 0;
    const borrowBySymbol = new Map<string, number>();
    let turnoverNotional = 0;
    let maxGrossSeen = 0;

    const lastCompletedClose = (s: Series, date: string): number | undefined => {
      const cut = cutIndex(s, date);
      return cut > 0 ? s.bars[cut - 1].close : undefined;
    };

    // ── closeReversal: 15:45 prices + night/day split state ──────────────
    let slices: Map<string, Map<string, CloseSliceRow>> | undefined;
    if (cr) {
      slices = sliceCache.get(cfg.sliceDbPath!);
      if (!slices) { slices = loadCloseSlices(cfg.sliceDbPath!); sliceCache.set(cfg.sliceDbPath!, slices); }
    }
    /** Adjusted 15:45 price for (symbol, session): adjClose × raw ratio —
     *  undefined = no 15:45 price that session (no signal). */
    const p1545Of = (sym: string, s: Series, date: string): number | undefined => {
      const row = slices?.get(sym)?.get(date);
      if (row === undefined) return undefined;
      const i = s.indexByDate.get(date);
      if (i === undefined) return undefined;
      return s.bars[i].close * row.ratio;
    };
    let nightPnl = 0;
    let dayPnl = 0;
    let longSignalSum = 0;
    let shortSignalSum = 0;
    let fullLongSessions = 0;
    let fullShortSessions = 0;

    /** closeReversal gross night/day split: entry at close(entryDate), walk
     *  the symbol's bars to the exit session; sign-aware for shorts. Price
     *  legs only (raw opens/closes — costs are separate channels). */
    const accumulateSplit = (pos: Position, info: { date: string; kind: "open" | "close" | "intraday"; rawPx?: number }) => {
      if (pos.entryDate === undefined) return;
      const s = series.get(pos.symbol);
      if (!s) return;
      const e = s.indexByDate.get(pos.entryDate);
      const x = s.indexByDate.get(info.date);
      if (e === undefined || x === undefined || x <= e) return;
      const sq = (pos.side === "buy" ? 1 : -1) * pos.qty;
      for (let d = e + 1; d <= x; d++) {
        nightPnl += sq * (s.bars[d].open - s.bars[d - 1].close);
        if (d < x) dayPnl += sq * (s.bars[d].close - s.bars[d].open);
      }
      if (info.kind === "close") dayPnl += sq * (s.bars[x].close - s.bars[x].open);
      else if (info.kind === "intraday") dayPnl += sq * ((info.rawPx ?? s.bars[x].close) - s.bars[x].open);
    };

    const book2 = (pos: Position, price: number, reason: string, exitAt: number, exitInfo?: { date: string; kind: "open" | "close" | "intraday"; rawPx?: number }) => {
      if (cr && exitInfo) accumulateSplit(pos, exitInfo);
      const sign = pos.side === "buy" ? 1 : -1;
      const gross = (price - pos.entryPrice) * pos.qty * sign;
      const exitFee = pos.qty * price * commRate;
      realizedGross += gross;
      feesPaid += exitFee;
      turnoverNotional += pos.qty * price;
      const netPnl = gross - pos.entryFee - exitFee - pos.borrowPaid;
      closed.push({
        symbol: pos.symbol, side: pos.side, pnl: netPnl, exitAt, reason,
        entryAt: pos.entryAt, entryPrice: pos.entryPrice, exitPrice: price, qty: pos.qty,
      });
      positions.splice(positions.indexOf(pos), 1);
    };

    // ── sector assignment (refreshed every sectorRefreshSessions) ─────────
    let sectorOf = new Map<string, string>();
    const assignSectors = (date: string) => {
      sectorOf = new Map();
      if (p.residual !== "sector") return;
      const L = cfg.corrLookbackSessions;
      // ETF daily-return maps over the last L+10 completed sessions.
      const etfRets = new Map<string, Map<string, number>>();
      for (const [etf, s] of etfSeries) {
        const cut = cutIndex(s, date);
        if (cut < L + 2) continue; // not enough history yet (e.g. XLC pre-2019)
        const m = new Map<string, number>();
        for (let i = Math.max(1, cut - L - 10); i < cut; i++) {
          const prev = s.bars[i - 1].close;
          if (prev > 0) m.set(s.bars[i].date, s.bars[i].close / prev - 1);
        }
        etfRets.set(etf, m);
      }
      if (etfRets.size === 0) return;
      for (const [sym, s] of series) {
        const cut = cutIndex(s, date);
        if (cut < L + 2) continue;
        // Stock daily returns over its last L completed sessions, by date.
        const dates: string[] = [];
        const rets: number[] = [];
        for (let i = cut - L; i < cut; i++) {
          const prev = s.bars[i - 1].close;
          if (prev > 0) { dates.push(s.bars[i].date); rets.push(s.bars[i].close / prev - 1); }
        }
        let best: { etf: string; corr: number } | null = null;
        for (const [etf, m] of etfRets) {
          const xs: number[] = [], ys: number[] = [];
          for (let i = 0; i < dates.length; i++) {
            const er = m.get(dates[i]);
            if (er !== undefined) { xs.push(rets[i]); ys.push(er); }
          }
          if (xs.length < Math.floor(0.8 * L)) continue;
          const c = pearson(xs, ys);
          if (c !== null && (!best || c > best.corr)) best = { etf, corr: c };
        }
        if (best) sectorOf.set(sym, best.etf);
      }
    };

    // ── day loop over the refSymbol session timeline ──────────────────────
    let equity = cfg.initialEquity;
    let peakEquity = equity;
    let maxDrawdown = 0;
    let ruined = false;
    let prevDayTs = 0;
    const equityHistory: Array<{ t: number; eq: number }> = [];

    for (let si = 0; si < refWindowBars.length; si++) {
      const date = refWindowBars[si].date;
      const dayTs = refWindowBars[si].timestamp;

      // 1. Short borrow accrual for the calendar days since the previous
      //    session (weekends/holidays accrue), marked at the last COMPLETED
      //    close — before anything else, like the funding settles of the
      //    crypto replays.
      if (cfg.shortBorrowAnnual > 0 && prevDayTs > 0) {
        const days = Math.max(0, Math.round((dayTs - prevDayTs) / DAY_MS));
        for (const pos of positions) {
          if (pos.side !== "sell") continue;
          const mark = lastCompletedClose(series.get(pos.symbol)!, date) ?? pos.mark;
          const cost = pos.qty * mark * cfg.shortBorrowAnnual * (days / 365);
          pos.borrowPaid += cost;
          borrowPaid += cost;
          borrowBySymbol.set(pos.symbol, (borrowBySymbol.get(pos.symbol) ?? 0) + cost);
        }
      }
      prevDayTs = dayTs;

      // 2. DELISTED: held symbol whose tape is exhausted (>6 calendar days
      //    behind, no future bar) closes at its last close ∓ slippage —
      //    declared OPTIMISTIC, same as the A-sp500 kernels.
      for (const pos of [...positions]) {
        const s = series.get(pos.symbol)!;
        const lastBar = s.bars[s.bars.length - 1];
        if (lastBar.date < date && dayTs - lastBar.timestamp > 6 * DAY_MS) {
          const px = pos.side === "buy" ? lastBar.close * (1 - slipIn) : lastBar.close * (1 + slipIn);
          book2(pos, px, "DELISTED", dayTs, cr ? { date: lastBar.date, kind: "close" } : undefined);
        }
      }

      if (cr) {
        // ── §12-septies G session (closeReversal) ───────────────────────
        // 3G-a. Gap stops at the open (G3 hard stop, meanrev parity: the
        //       live GTC stop fires at ~09:30; never on the entry session —
        //       the position filled at that session's close).
        for (const pos of [...positions]) {
          if (pos.stopPrice == null || pos.side !== "buy" || pos.entrySession >= si) continue;
          const s = series.get(pos.symbol)!;
          const i = s.indexByDate.get(date);
          if (i === undefined) continue;
          if (s.bars[i].open > pos.stopPrice) continue;
          book2(pos, s.bars[i].open * (1 - slipIn), "STOP_LOSS", dayTs, { date, kind: "open" });
        }
        // 3G-b. "next open" exits (G1 / G4): at the open of the holdDays-th
        //       session after entry; shorts cover at the open (+slippage).
        if (cr.exit === "nextOpen") {
          for (const pos of [...positions]) {
            if (si - pos.entrySession < p.holdDays) continue;
            const s = series.get(pos.symbol)!;
            const i = s.indexByDate.get(date);
            if (i === undefined) continue; // no bar today: retry next session
            const open = s.bars[i].open;
            const px = pos.side === "buy" ? open * (1 - slipIn) : open * (1 + slipIn);
            book2(pos, px, "OPEN_EXIT", dayTs, { date, kind: "open" });
          }
        }

        // 4G. The 15:45 decision: signal series = prior completed closes +
        //     the session's adjusted 15:45 price (NOTHING after 15:45 enters
        //     a decision); exits and entries fill in the CLOSING auction.
        const prevKey = getPreviousTradingDay(date);
        interface CrSignal { symbol: string; rsi: number; px: number; closeRaw: number; cut: number }
        const longsSig: CrSignal[] = [];
        const shortsSig: CrSignal[] = [];
        for (const [sym, s] of series) {
          if (!isMemberAt(book, sym, dayTs)) continue;
          const i = s.indexByDate.get(date);
          if (i === undefined || i === 0) continue;       // need today's close to fill
          const cut = cutIndex(s, date);
          if (cut < cr.minPriorCloses) continue;          // ≥ minPriorCloses prior closes
          if (s.bars[cut - 1].date < prevKey) continue;   // stale tape
          const px = p1545Of(sym, s, date);
          if (px === undefined || px < cr.minPrice) continue;
          // Cutler RSI(2) over [c[-2], c[-1], p1545] — same math as meanrev.
          const rsi = rsi2([s.closes[cut - 2], s.closes[cut - 1], px], 2);
          let smaPrior = 0;
          for (let k = cut - cr.smaLong; k < cut; k++) smaPrior += s.closes[k];
          smaPrior /= cr.smaLong;
          const sig: CrSignal = { symbol: sym, rsi, px, closeRaw: s.bars[i].close, cut };
          if (rsi < cr.entryRsi && px > smaPrior) longsSig.push(sig);
          if (cr.short && rsi > cr.short.entryRsi && px < smaPrior) shortsSig.push(sig);
        }
        // Deterministic ranking (Cutler RSI(2) ties at exactly 0/100 are
        // common — declared tie-break by symbol).
        longsSig.sort((a, b) => a.rsi - b.rsi || (a.symbol < b.symbol ? -1 : 1));
        shortsSig.sort((a, b) => b.rsi - a.rsi || (a.symbol < b.symbol ? -1 : 1));
        longSignalSum += longsSig.length;
        shortSignalSum += shortsSig.length;
        const topLong = new Set(longsSig.slice(0, p.slotsPerSide).map(x => x.symbol));

        // Close exits. G2 ("nextClose"): exit at the close UNLESS still
        // among the top-N signal names (kept, no sell+rebuy) and under the
        // holdDays cap. G3 ("sma5"): exit when p1545 > SMA(smaExit) of the
        // (smaExit−1) prior closes + p1545, or at the holdDays-th session
        // (time stop fires even without a slice — it only needs the close).
        const closedThisClose = new Set<string>();
        if (cr.exit === "nextClose" || cr.exit === "sma5") {
          for (const pos of [...positions]) {
            if (pos.side !== "buy" || pos.entrySession >= si) continue;
            const s = series.get(pos.symbol)!;
            const i = s.indexByDate.get(date);
            let reason: string | null = null;
            if (cr.exit === "nextClose") {
              const keep = topLong.has(pos.symbol) && si - pos.entrySession < p.holdDays;
              if (keep) continue;
              reason = si - pos.entrySession >= p.holdDays ? "TIME_EXIT" : "CLOSE_EXIT";
            } else {
              const px = p1545Of(pos.symbol, s, date);
              const cut = cutIndex(s, date);
              if (px !== undefined && cut >= cr.smaExit! - 1) {
                let sma = px;
                for (let k = cut - (cr.smaExit! - 1); k < cut; k++) sma += s.closes[k];
                sma /= cr.smaExit!;
                if (px > sma) reason = "SMA_EXIT";
              }
              if (reason === null && si - pos.entrySession >= p.holdDays) reason = "TIME_STOP";
              if (reason === null) continue;
            }
            if (i === undefined) continue; // no bar today: retry next session
            book2(pos, s.bars[i].close * (1 - slipIn), reason, dayTs, { date, kind: "close" });
            closedThisClose.add(pos.symbol);
          }
        }

        // Entries in the closing auction. Slot = DECISION-TIME equity
        // (marked at the last COMPLETED closes — no lookahead) × gross /
        // (2 × N); qty = whole shares fixed at 15:45 on the 15:45 price.
        const heldSyms = new Set(positions.map(x => x.symbol));
        let freeLong = p.slotsPerSide - positions.filter(x => x.side === "buy").length;
        let freeShort = cr.short ? p.slotsPerSide - positions.filter(x => x.side === "sell").length : 0;
        let eqNow = cfg.initialEquity + realizedGross - feesPaid - borrowPaid;
        for (const pos of positions) {
          const mark = lastCompletedClose(series.get(pos.symbol)!, date) ?? pos.mark;
          eqNow += (mark - pos.entryPrice) * pos.qty * (pos.side === "buy" ? 1 : -1);
        }
        const equityBase = Math.max(0, eqNow);
        const sessionSlotUsd = (equityBase * cfg.maxGrossMult) / (2 * p.slotsPerSide);
        const grossNow = () => positions.reduce((s2, x) => s2 + x.qty * x.mark, 0);
        const enterCr = (c: CrSignal, side: "buy" | "sell"): boolean => {
          const qty = Math.floor(sessionSlotUsd / c.px); // whole shares, fixed at 15:45
          if (qty < 1) return false;
          if (grossNow() + qty * c.px > equityBase * cfg.maxGrossMult * 1.001) return false;
          const fill = side === "buy" ? c.closeRaw * (1 + slipIn) : c.closeRaw * (1 - slipIn);
          const entryFee = qty * fill * commRate;
          feesPaid += entryFee;
          turnoverNotional += qty * fill;
          const s = series.get(c.symbol)!;
          // G3: the meanrev vol-scaled hard stop, resolved ONCE at entry
          // from completed closes strictly before the entry session.
          const stopPrice = side === "buy" && cr.hardStop
            ? fill * (1 - trailPctFromVol(s.closes.slice(0, c.cut), cr.hardStop, 1) / 100)
            : null;
          positions.push({
            symbol: c.symbol, side, qty, entryPrice: fill, entryAt: dayTs,
            entrySession: si, entryFee, mark: fill, borrowPaid: 0, stopPrice, entryDate: date,
          });
          return true;
        };
        for (const c of longsSig) {
          if (freeLong <= 0) break;
          if (heldSyms.has(c.symbol) || closedThisClose.has(c.symbol)) continue;
          if (enterCr(c, "buy")) { heldSyms.add(c.symbol); freeLong--; }
        }
        for (const c of shortsSig) {
          if (freeShort <= 0) break;
          if (heldSyms.has(c.symbol) || closedThisClose.has(c.symbol)) continue;
          if (enterCr(c, "sell")) { heldSyms.add(c.symbol); freeShort--; }
        }
        if (positions.filter(x => x.side === "buy").length >= p.slotsPerSide) fullLongSessions++;
        if (cr.short && positions.filter(x => x.side === "sell").length >= p.slotsPerSide) fullShortSessions++;

        // 4G-b. Intraday stops AFTER the decision (meanrev two-phase
        //       parity); never on the entry session (filled at the close).
        for (const pos of [...positions]) {
          if (pos.stopPrice == null || pos.side !== "buy" || pos.entrySession >= si) continue;
          const s = series.get(pos.symbol)!;
          const i = s.indexByDate.get(date);
          if (i === undefined) continue;
          const bar = s.bars[i];
          if (bar.low > pos.stopPrice) continue;
          const raw = Math.min(bar.open, pos.stopPrice);
          book2(pos, raw * (1 - slipIn), "STOP_LOSS", dayTs, { date, kind: "intraday", rawPx: raw });
        }
      } else {
      // 3. Time exits at TODAY's open (holdDays sessions elapsed). A symbol
      //    without a bar today holds and retries next session.
      const exitedToday = new Set<string>();
      for (const pos of [...positions]) {
        if (si - pos.entrySession < p.holdDays) continue;
        const s = series.get(pos.symbol)!;
        const i = s.indexByDate.get(date);
        if (i === undefined) continue;
        const open = s.bars[i].open;
        const px = pos.side === "buy" ? open * (1 - slipIn) : open * (1 + slipIn);
        book2(pos, px, "TIME_EXIT", dayTs);
        exitedToday.add(pos.symbol);
      }

      // 4. Entries: rank eligible members by score (completed bars only).
      const held = new Set(positions.map(x => x.symbol));
      let freeLong = p.slotsPerSide - positions.filter(x => x.side === "buy").length;
      let freeShort = p.slotsPerSide - positions.filter(x => x.side === "sell").length;
      if (freeLong > 0 || freeShort > 0) {
        if (p.residual === "sector" && si % cfg.sectorRefreshSessions === 0) assignSectors(date);
        // B2 (§12-bis): slot proportional to DECISION-TIME equity (marked at
        // the last COMPLETED closes — no lookahead), recomputed at every
        // rebalance. Legacy ("fixed"): the constant initialEquity-based slot.
        let equityBase = cfg.initialEquity;
        if (eqProp) {
          let eq = cfg.initialEquity + realizedGross - feesPaid - borrowPaid;
          for (const pos of positions) {
            const mark = lastCompletedClose(series.get(pos.symbol)!, date) ?? pos.mark;
            const sign = pos.side === "buy" ? 1 : -1;
            eq += (mark - pos.entryPrice) * pos.qty * sign;
          }
          equityBase = Math.max(0, eq);
        }
        const sessionSlotUsd = eqProp
          ? (equityBase * cfg.maxGrossMult) / (2 * p.slotsPerSide)
          : slotUsd;
        const prevKey = getPreviousTradingDay(date);
        const scored: Array<{ symbol: string; score: number; open: number }> = [];
        for (const [sym, s] of series) {
          if (held.has(sym) || exitedToday.has(sym)) continue;
          if (!isMemberAt(book, sym, dayTs)) continue;
          const i = s.indexByDate.get(date);
          if (i === undefined || i === 0) continue; // no execution bar today
          const cut = cutIndex(s, date);
          if (cut < minWarmupBars) continue;
          if (s.bars[cut - 1].date < prevKey) continue; // stale tape
          const open = s.bars[i].open;
          if (!(open > 0)) continue;
          if (!eqProp) {
            // Legacy line-B prefilter (both sides whole shares, $5 floor).
            if (open < 5) continue;
            if (Math.floor(sessionSlotUsd / open) < 1) continue; // excluded by price
          }
          let score = s.closes[cut - 1] / s.closes[cut - 1 - p.lookbackDays] - 1;
          if (p.residual === "sector") {
            const etf = sectorOf.get(sym);
            if (etf) {
              const es = etfSeries.get(etf)!;
              const ecut = cutIndex(es, date);
              if (ecut > p.lookbackDays) {
                score -= es.closes[ecut - 1] / es.closes[ecut - 1 - p.lookbackDays] - 1;
              }
            }
          }
          scored.push({ symbol: sym, score, open });
        }
        scored.sort((a, b) => a.score - b.score || (a.symbol < b.symbol ? -1 : 1));
        const enter = (c: { symbol: string; open: number }, side: "buy" | "sell", qty: number) => {
          const fill = side === "buy" ? c.open * (1 + slipIn) : c.open * (1 - slipIn);
          const entryFee = qty * fill * commRate;
          feesPaid += entryFee;
          turnoverNotional += qty * fill;
          positions.push({
            symbol: c.symbol, side, qty, entryPrice: fill, entryAt: dayTs,
            entrySession: si, entryFee, mark: fill, borrowPaid: 0,
          });
        };
        // Gross cap (structural with the slot arithmetic; belt and braces).
        const grossNow = () => positions.reduce((s2, x) => s2 + x.qty * x.mark, 0);
        for (let i = 0; i < scored.length && freeLong > 0; i++) {
          const c = scored[i];
          // Longs: fractional (exact slot) when fractionalLongs; else whole
          // shares floored on the raw open (excluded by price at qty 0).
          const qty = cfg.fractionalLongs ? sessionSlotUsd / c.open : Math.floor(sessionSlotUsd / c.open);
          if (!(qty > 0) || (!cfg.fractionalLongs && qty < 1)) continue;
          if (grossNow() + qty * c.open > equityBase * cfg.maxGrossMult * 1.001) break;
          enter(c, "buy", qty);
          freeLong--;
        }
        const taken = new Set(positions.map(x => x.symbol));
        for (let i = scored.length - 1; i >= 0 && freeShort > 0; i--) {
          const c = scored[i];
          if (taken.has(c.symbol)) continue;
          // Shorts (§12-bis): ALWAYS whole shares that fit the slot, $5 floor.
          if (c.open < 5) continue;
          const qty = Math.floor(sessionSlotUsd / c.open);
          if (qty < 1) continue; // excluded by price
          if (grossNow() + qty * c.open > equityBase * cfg.maxGrossMult * 1.001) break;
          enter(c, "sell", qty);
          taken.add(c.symbol);
          freeShort--;
        }
      }
      } // end legacy (non-closeReversal) session block

      // 5. Mark to market at today's closes.
      let eq = cfg.initialEquity + realizedGross - feesPaid - borrowPaid;
      let gross = 0;
      for (const pos of positions) {
        const s = series.get(pos.symbol)!;
        const i = s.indexByDate.get(date);
        if (i !== undefined) pos.mark = s.bars[i].close;
        const sign = pos.side === "buy" ? 1 : -1;
        eq += (pos.mark - pos.entryPrice) * pos.qty * sign;
        gross += pos.qty * pos.mark;
      }
      equity = eq;
      maxGrossSeen = Math.max(maxGrossSeen, gross);
      peakEquity = Math.max(peakEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
      equityHistory.push({ t: dayTs, eq: equity });
      if (equity <= 0) { ruined = true; break; }
    }

    // ── fold-end liquidation (fail closed on a missing terminal price) ────
    if (!ruined) {
      for (const pos of [...positions]) {
        const s = series.get(pos.symbol)!;
        const lastIdx = [...s.bars].reverse().findIndex(b => b.timestamp >= fromMs && b.timestamp < toMs);
        if (lastIdx < 0) throw new Error(`streversal: no terminal price for ${pos.symbol}`);
        const lastBar = s.bars[s.bars.length - 1 - lastIdx];
        const c = lastBar.close;
        const px = pos.side === "buy" ? c * (1 - slipIn) : c * (1 + slipIn);
        book2(pos, px, "fold_end", toMs, cr ? { date: lastBar.date, kind: "close" } : undefined);
      }
    }
    const finalEq = ruined
      ? Math.max(0, equity)
      : cfg.initialEquity + realizedGross - feesPaid - borrowPaid;
    equityHistory.push({ t: toMs, eq: finalEq });
    peakEquity = Math.max(peakEquity, finalEq);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - finalEq) / peakEquity);

    // ── metrics (verbatim conventions of meanrev-replay.ts) ───────────────
    const tradesBySymbol: Record<string, { trades: number; grossPnl: number; fees: number; funding: number }> = {};
    for (const t of closed) {
      const acc = tradesBySymbol[t.symbol] ?? (tradesBySymbol[t.symbol] = { trades: 0, grossPnl: 0, fees: 0, funding: 0 });
      acc.trades++; acc.grossPnl += t.pnl;
    }
    for (const [sym, cost] of borrowBySymbol) {
      if (tradesBySymbol[sym]) tradesBySymbol[sym].funding = cost;
    }
    const dayBuckets: Array<{ key: string; firstT: number; lastT: number; last: number }> = [];
    for (const pt of equityHistory) {
      const key = new Date(pt.t).toISOString().slice(0, 10);
      const cur = dayBuckets[dayBuckets.length - 1];
      if (cur && cur.key === key) { cur.last = pt.eq; cur.lastT = pt.t; }
      else dayBuckets.push({ key, firstT: pt.t, lastT: pt.t, last: pt.eq });
    }
    const dailyReturns: Array<{ date: string; ret: number }> = [];
    const sessionReturns: Array<{ from: string; to: string; ret: number }> = [];
    for (let i = 1; i < dayBuckets.length; i++) {
      const a = dayBuckets[i - 1], b = dayBuckets[i];
      if (a.last > 0) {
        dailyReturns.push({ date: b.key, ret: (b.last - a.last) / a.last });
        sessionReturns.push({ from: new Date(a.lastT).toISOString(), to: new Date(b.lastT).toISOString(), ret: (b.last - a.last) / a.last });
      }
    }
    const rets = dailyReturns.map(r => r.ret);
    const mean = rets.reduce((s2, x) => s2 + x, 0) / Math.max(1, rets.length);
    const sd = Math.sqrt(rets.reduce((s2, x) => s2 + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
    const wins = closed.filter(t => t.pnl > 0).length;
    const days = (toMs - fromMs) / DAY_MS;
    const bench = refWindowBars.length > 1 && refWindowBars[0].close > 0
      ? (refWindowBars[refWindowBars.length - 1].close - refWindowBars[0].close) / refWindowBars[0].close
      : 0;

    return {
      sleeve: cfg.sleeve,
      window: win,
      fromMs,
      toMs,
      config: cfg,
      finalEquity: finalEq,
      totalReturn: (finalEq - cfg.initialEquity) / cfg.initialEquity,
      maxDrawdown,
      sharpe,
      winRate: closed.length ? wins / closed.length : 0,
      trades: closed.length,
      tradesPerDay: closed.length / Math.max(1, days),
      expectancy: closed.length ? closed.reduce((s2, t) => s2 + t.pnl, 0) / closed.length : 0,
      fees: feesPaid,
      funding: borrowPaid,
      liquidations: 0,
      marginRejects: 0,
      ruined,
      bench,
      dailyReturns,
      sessionReturns,
      tradesBySymbol,
      equityHistory,
      closedTrades: closed,
      turnoverAnnual: (turnoverNotional / cfg.initialEquity) * (365 / Math.max(1, days)),
      ordersPerSession: refWindowBars.length > 0 ? (closed.length * 2) / refWindowBars.length : 0,
      sessions: refWindowBars.length,
      maxGrossSeen,
      hash: hashStConfig(cfg),
      finalRiskState: { ...(initialRiskState ?? INITIAL_RISK_STATE) },
      // closeReversal output-only extras (keys absent on the legacy path).
      ...(cr
        ? {
            nightPnl,
            dayPnl,
            signalStats: {
              sessions: refWindowBars.length,
              avgLongSignals: refWindowBars.length > 0 ? longSignalSum / refWindowBars.length : 0,
              fullLongSessions,
              ...(cr.short
                ? {
                    avgShortSignals: refWindowBars.length > 0 ? shortSignalSum / refWindowBars.length : 0,
                    fullShortSessions,
                  }
                : {}),
            },
          }
        : {}),
    };
  } finally {
    db.close();
  }
}

/** Test hook: drop the module-level caches (fixture DBs reuse paths). */
export function clearStReversalCaches(): void {
  seriesCache.clear();
  membershipCache.clear();
  sliceCache.clear();
}
