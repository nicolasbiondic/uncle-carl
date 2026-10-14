#!/usr/bin/env bun
/**
 * Daily Connors mean-reversion replay for the walk-forward protocol
 * (scripts/walk-forward.ts, sleeve "meanrev").
 *
 * BACKTEST-LIVE PARITY (NautilusTrader/LEAN single-kernel pattern): this
 * runner executes the REAL production engine —
 * src/strategies/meanrev/MeanRevEngine.runDaily() — against a simulated
 * broker adapter, exactly like scripts/backtest-momentum-wf.ts drives the
 * real MomentumEngine over SimBroker. The strategy code does not know it is
 * in a backtest; only the injected data/execution adapter changes. The
 * previous version of this file reimplemented the Connors loop (importing
 * rsi2/sma but rehashing entries/exits/slots) — exactly the silent-drift
 * class the single-kernel design eliminates.
 *
 * Engine dependencies isolated via seams (all documented at their source):
 *   - clock: MeanRevEngineDeps.now → the replay's per-day sim timestamp.
 *   - trading calendar: deps.isTradingDay → () => true (the replay timeline
 *     IS the union of data dates; a date with no data never ticks).
 *   - DB entry-idempotency probe: deps.alreadyEnteredToday → () => false
 *     (the sim book is the ledger; no data/trading.db in a replay).
 *   - maintenance kill-switch: the engine's per-pass isTradingEnabled() gate
 *     reads process.env.TRADING_ENABLED. The simulator models PROD (unset);
 *     TRADING_ENABLED is neutralized for the loop and restored after — the
 *     same fix runWithConfig carries for the 2026-08-02 zero-trade-artifact
 *     incident (see scripts/regression-fingerprint.test.ts).
 *   - heartbeats/sleeveOutput: skipped by the engine when heartbeatName is
 *     undefined (it is here).
 *
 * What the ENGINE now brings to the replay that the old reimplementation
 * lacked (production semantics, previously silent divergence):
 *   - RiskGuard portfolio breaker (DEFAULT_RISK_CONFIG, same as live
 *     meanrev_stocks since 2026-08-03) gating NEW entries on drawdown/
 *     loss-streak/daily-cap; `initialRiskState` chains it fold-to-fold like
 *     the momentum replay.
 *   - The fail-closed entry-freshness gate: if ANY universe symbol lacks a
 *     completed bar at least as recent as the previous trading day, the
 *     whole day's entries are skipped (live behavior; the old replay just
 *     dropped stale symbols from the candidate list).
 *   - Time stop counted on the SYMBOL's own completed bars after the entry
 *     date (live counts held sessions from candles), not on the replay's
 *     union-timeline day index.
 *
 * What stays at the DRIVER/adapter level (parity with live protections that
 * do NOT live in the engine):
 *   - Hard stop (cfg.hardStop axis; default fixed cfg.hardStopPct) — parity
 *     with AccountManager.checkAllStopLoss + broker-native GTC stops, which
 *     are NOT engine code, in TWO phases matching live timing (2026-09-25,
 *     OPEN.md "replay evaluates stops AFTER the day's decisions"):
 *       1. GAP-THROUGH stops (today's open <= stop level) fill AT THE OPEN
 *          and are booked BEFORE the engine pass — live's GTC stop / 15s
 *          loop fires at ~09:30, freeing the slot and lowering equity
 *          before the ~09:35 decisions.
 *       2. INTRADAY stops (open above the level, low at/under it) fill at
 *          the stop level AFTER the pass, exactly as before — the ~09:35
 *          pass cannot see an intraday breach that hasn't happened yet.
 *     volScaled resolves the distance ONCE at entry via the production
 *     trailPctFromVol formula (imported) over signal-time closes; "none"
 *     disables it (canonical Connors: time-stop only). Same-day entries
 *     face today's intraday stop (prior-replay parity; they cannot gap —
 *     they were filled at today's open).
 *   - Fills: signal on YESTERDAY's completed bar (the adapter only ever
 *     serves completed bars), fill at TODAY's open ±slippageBps, whole
 *     shares floored on the raw open (prior-replay parity, live Alpaca
 *     rounds to whole shares), commissionBps per side.
 *   - Fold end: remaining positions liquidate at the last close inside the
 *     window (reason "fold_end") so the stitched OOS chain never carries
 *     hidden open P&L.
 *
 * Fail-closed data validation: every universe symbol (and the benchmark
 * refSymbol) must have ≥ smaLong+1 warmup bars before the window, coverage
 * to both window edges, and no internal gap over MAX_GAP_DAYS calendar
 * days (delistings/data holes throw instead of silently going quiet).
 *
 * ── CRYPTO PERPS (source = "binance_futures", 2026-09-25) — all OPT-IN by
 * source; every other source keeps the exact legacy path byte for byte
 * (the anchored fingerprint in scripts/regression-fingerprint.test.ts and
 * every alpaca_wide meanrev hash are untouched):
 *   - 24/7 calendar: nothing to switch — the replay timeline IS the union
 *     of data dates, and binance_futures/1d has a bar every UTC day, so
 *     every UTC day is a session. Internally dates keep the getETDateKey
 *     labels: a UTC-midnight bar always maps to the PREVIOUS ET date (UTC
 *     00:00 = 19:00/20:00 ET), a consistent bijection, so ordering,
 *     completed-bar cuts and the engine's own todayKey all agree. The
 *     engine's freshness gate (previous EQUITY trading day) is a weaker
 *     bound than "yesterday's UTC bar", which always exists — it never
 *     falsely blocks a crypto session.
 *   - Fractional quantities: whole-share flooring would floor a $1250 slot
 *     of BTC to qty 0. Declared bias: no exchange lot-size (stepSize)
 *     rounding — sub-lot dust error is < 0.1% of a slot.
 *   - Funding on long positions: exact settled funding_rate events (same
 *     FundingBook the momentum replay uses, fail-closed on coverage gaps),
 *     applied every replay day for settlements in (prevDay, day] BEFORE
 *     the engine pass, so RiskGuard's equity read includes them. Declared
 *     biases: (a) the settlement notional is marked at the last COMPLETED
 *     daily close (up to 16h stale for the 08:00/16:00 UTC events) instead
 *     of the settlement-time price — a second-order rate×intraday-drift
 *     error; (b) a position that exits at today's open still pays the
 *     settlement stamped exactly at that open (boundary coin-flip charged
 *     conservatively against the long book); (c) a position entered at
 *     today's open does NOT pay that same instant's settlement
 *     (eventsBetween is exclusive on the left).
 *   - Sharpe annualizes √365 (24/7 daily observations), not √252.
 *   - Late-listing waiver: a perp whose FIRST bar in the whole DB is after
 *     the warmup start (AVAX 2020-09-23, SOL 2020-09-14, DOGE 2020-07-10…)
 *     is a listing-date fact, not a data hole — the warmup-depth and
 *     first-bar checks are waived for it (end-coverage and internal-gap
 *     checks stay). Consequence, declared: the ENGINE's fail-closed entry
 *     freshness gate blocks ALL entries until every universe symbol has
 *     smaLong+1 completed bars (live behavior), so folds that start before
 *     the youngest listing matures trade a shortened window.
 *   - No margin model (unchanged from the stocks path): slots are fixed
 *     notional (baseUsd × slotPct, 1.0× gross at 4 × 0.25), so leverage/
 *     liquidation/margin-interest are structurally absent, not simulated.
 */

import { Database } from "bun:sqlite";
import { MeanRevEngine, type MeanRevBrokerAdapter, type MeanRevPosition } from "../src/strategies/meanrev/MeanRevEngine";
import { trailPctFromVol, type MomentumStatePersistence } from "../src/strategies/momentum/MomentumEngine";
import { INITIAL_RISK_STATE, type RiskState } from "../src/strategies/momentum/RiskGuard";
import { getETDateKey } from "../src/db/database";
import type { OHLCV } from "../src/utils/types";
import { FundingBook, grossCapDiag, hashReplayConfig, seedStopFraction, type ClosedTrade, type HardStopSpec, type ReplayConfig, type ReplayResult, type SeedPosition } from "./backtest-momentum-wf";
import { isMemberAt, loadMembership, topNByDollarVolume } from "./lib/membership";
import { getPreviousTradingDay } from "../src/utils/marketHours";
import { loadCloseSlices, nextCalendarKey, noonEtMs } from "./lib/closeSlices";

/**
 * RSI2-audit passthrough fields (2026-09), declared here via TS declaration
 * merging rather than editing backtest-momentum-wf.ts's MeanRevSimParams
 * directly (ownership split across parallel agents — this file owns the
 * meanrev replay surface). Both are OPTIONAL, mirroring the HardStopSpec/
 * marginInterest pattern on ReplayConfig itself just below: canonicalJson
 * (via JSON.stringify) drops undefined keys, so hashReplayConfig — which
 * hashes the whole canonical cfg — stays byte-identical for any existing
 * candidate that never sets them, and changes the moment either is set.
 * See MeanRevEngineConfig.rsiMethod/deterministicTieBreak for the semantics
 * (src/strategies/meanrev/MeanRevEngine.ts).
 */
declare module "./backtest-momentum-wf" {
  interface MeanRevSimParams {
    /** Passthrough to MeanRevEngineConfig.rsiMethod. Undefined = "cutler"
     *  (legacy/current behavior, unchanged hash). */
    rsiMethod?: "cutler" | "wilder";
    /** Passthrough to MeanRevEngineConfig.deterministicTieBreak. Undefined/
     *  false = legacy stable-sort behavior (unchanged hash). */
    deterministicTieBreak?: boolean;
    /**
     * §12-septies G0 execution mode (OPT-IN; undefined = the exact legacy
     * replay AND the legacy hash). "close1545":
     *   - the SIGNAL series' last value is the session's 15:45 ET price
     *     (adjusted via cfg.sliceDbPath — see scripts/lib/closeSlices.ts):
     *     RSI(2), the SMA200 check and the SMA5 exit check all see it;
     *   - ENTRY fills in the SIGNAL session's closing auction (that day's
     *     close ± cost), whole shares fixed at 15:45 (floor(slot/p1545));
     *   - EXITS (SMA_EXIT / TIME_STOP) fill at the decision session's close;
     *   - the vol-scaled hard stop is unchanged (distance from completed
     *     closes strictly before the entry session; gap stops at the next
     *     open, intraday stops never on the entry session itself — the
     *     position only exists from the close);
     *   - a symbol with NO 15:45 slice that session has no signal that
     *     session (entry-ineligible; held positions hold conservatively).
     * Implemented by shifting the ENGINE clock one session forward so the
     * synthetic 15:45 bar is the engine's "yesterday" — see runMeanRevReplay.
     */
    execution?: "close1545";
  }
}

/** G0 output-only extras (declaration merging, additive — never hashed):
 *  gross night-vs-day P&L split of the close1545 execution mode. */
declare module "./backtest-momentum-wf" {
  interface ReplayResult {
    /** Gross P&L split (price legs only, pre-fee/slippage attribution):
     *  night = close→next-open legs, day = open→close/exit legs. Present
     *  only when meanrev.execution === "close1545". */
    execSplit?: { nightPnl: number; dayPnl: number };
  }
}

const MAX_GAP_DAYS = 10; // > any legal exchange closure (long weekend + holiday)

/** `volume` is loaded for the PIT liquidity screen only (driver-level);
 *  fetchCandles keeps serving volume 0 to the engine — byte-identical. */
interface Bar { timestamp: number; open: number; high: number; low: number; close: number; volume: number; date: string }

interface Series {
  bars: Bar[];
  closes: number[];
  indexByDate: Map<string, number>;
}

function loadDailySeries(db: Database, cfg: ReplayConfig, symbol: string, loadFrom: number, toMs: number): Series {
  const rows = db.prepare(
    `SELECT timestamp, open, high, low, close, volume FROM historical_bars
     WHERE symbol = ? AND timeframe = ? AND source = ? AND timestamp >= ? AND timestamp < ?
     ORDER BY timestamp ASC`,
  ).all(symbol, cfg.timeframe, cfg.source, loadFrom, toMs) as Array<Omit<Bar, "date">>;
  // Dedupe by ET trading date, latest timestamp wins — verbatim backtest-meanrev.ts.
  const byDate = new Map<string, Bar>();
  for (const row of rows) {
    const date = getETDateKey(row.timestamp);
    byDate.set(date, { ...row, date });
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length === 0) throw new Error(`meanrev replay: no ${cfg.source} ${cfg.timeframe} bars for ${symbol}`);
  return {
    bars,
    closes: bars.map(bar => bar.close),
    indexByDate: new Map(bars.map((bar, index) => [bar.date, index])),
  };
}

/** First bar the DB has for this symbol at ALL (no window bound) — the
 *  listing-vs-data-hole discriminator for the crypto late-listing waiver. */
function firstBarEver(db: Database, cfg: ReplayConfig, symbol: string): number {
  const row = db.prepare(
    `SELECT MIN(timestamp) t FROM historical_bars WHERE symbol = ? AND timeframe = ? AND source = ?`,
  ).get(symbol, cfg.timeframe, cfg.source) as { t: number | null };
  return row.t ?? Number.MAX_SAFE_INTEGER;
}

function validateDailyCoverage(series: Series, symbol: string, smaLong: number, loadFrom: number, fromMs: number, toMs: number, lateListing = false): void {
  const bars = series.bars;
  const dayMs = 86_400_000;
  // Late-listing waiver (crypto only — see header): the symbol's first bar
  // EVER is after the warmup start, so demanding warmup depth would fail
  // every fold that predates the listing. Skip warmup-depth and first-bar
  // checks; end-coverage and internal-gap checks below still apply, and the
  // ENGINE's fail-closed freshness gate governs entries until maturity.
  if (!lateListing) {
    const warmupBars = bars.filter(b => b.timestamp < fromMs).length;
    if (warmupBars < smaLong + 1) {
      throw new Error(`meanrev replay: insufficient warmup for ${symbol}: ${warmupBars} bars < ${smaLong + 1}`);
    }
    if (bars[0].timestamp > loadFrom + MAX_GAP_DAYS * dayMs) {
      throw new Error(`meanrev replay: ${symbol} first bar ${bars[0].date} is over ${MAX_GAP_DAYS}d after load start ${new Date(loadFrom).toISOString()}`);
    }
  }
  const last = bars[bars.length - 1];
  if (last.timestamp < toMs - MAX_GAP_DAYS * dayMs) {
    throw new Error(`meanrev replay: ${symbol} last bar ${last.date} is over ${MAX_GAP_DAYS}d before window end ${new Date(toMs).toISOString()}`);
  }
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].timestamp - bars[i - 1].timestamp > MAX_GAP_DAYS * dayMs) {
      throw new Error(`meanrev replay: ${symbol} gap ${bars[i - 1].date} -> ${bars[i].date} exceeds ${MAX_GAP_DAYS}d`);
    }
  }
}

interface SimPosition {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryTime: number;
  entryFee: number;
  mark: number;
  /** Entry-anchored hard-stop distance (fraction); null = no hard stop. */
  stopFrac: number | null;
  /** Net funding cash paid since entry (positive = long paid; negative =
   *  credit). Always 0 without a FundingBook — the legacy path. */
  fundingCost: number;
  /** Session date of the entry fill (close1545 mode only — drives the
   *  night/day P&L split; undefined on the legacy path and on seeds). */
  entryDate?: string;
  /** Real decision timestamp (15:45 ET of the entry session) — close1545
   *  metadata for ClosedTrade.entryAt (entryTime carries the shifted ENGINE
   *  clock, which drives the time stop). Undefined on the legacy path. */
  entryRealTs?: number;
}

/** Fill context for the close1545 night/day split (see SimMeanRevBroker.book). */
interface ExitInfo {
  /** Session date the exit fill printed on. */
  date: string;
  /** Where in the session the fill happened: the open (gap stop), the
   *  close (SMA/TIME/fold_end in close1545 mode), or intraday (stop level). */
  kind: "open" | "close" | "intraday";
  /** Raw (pre-slippage) fill price for the intraday kind. */
  rawPx?: number;
}

/** Placeholder reason stamped by closePosition until the driver rewrites it
 *  from the engine's own MeanRevReport (the MeanRevBrokerAdapter contract
 *  carries no closeReason — the report is the engine's reason channel). */
const PENDING_ENGINE_REASON = "__engine_close__";

/**
 * Simulated MeanRevBrokerAdapter over the loaded daily series. The engine
 * sees ONLY completed bars (strictly before `currentDate`) — the execution
 * bar can never leak into a signal; fills price at today's open ±slippage.
 */
export class SimMeanRevBroker implements MeanRevBrokerAdapter {
  positions: SimPosition[] = [];
  closed: ClosedTrade[] = [];
  realizedGross = 0;
  feesPaid = 0;
  /** Net settled funding paid so far (positive = cost; 0 without a book). */
  fundingPaid = 0;
  /** Total Reg-T margin interest charged so far (línea E axis; 0 when off). */
  marginInterestPaid = 0;
  fundingBySymbol = new Map<string, number>();
  /** ET date currently being replayed and its sim timestamp (max in-window
   *  bar timestamp for the date — same stamp the old replay used). In
   *  close1545 mode dayTs is the ENGINE clock (noon ET of the NEXT session)
   *  while currentDate stays the session being replayed. */
  currentDate = "";
  dayTs = 0;
  /** close1545 gross night/day split accumulators (0 on the legacy path). */
  nightPnl = 0;
  dayPnl = 0;

  private slipIn: number;
  private slipOut: number;
  private commRate: number;

  constructor(
    private cfg: ReplayConfig,
    private series: Map<string, Series>,
    private stopSpec: HardStopSpec,
    /** Settled-funding events (crypto perps); absent = no funding (legacy). */
    private fundingBook?: FundingBook,
    /** Fractional sizing (crypto perps); false = whole-share floor (legacy). */
    private fractionalQty = false,
    /** close1545 mode (§12-septies G0): symbol → session → adjusted 15:45
     *  price + its bar-end timestamp. Absent = the exact legacy path. */
    private p1545?: Map<string, Map<string, { px: number; ts: number }>>,
  ) {
    this.slipIn = 1 + cfg.slippageBps / 10_000;
    this.slipOut = 1 - cfg.slippageBps / 10_000;
    this.commRate = cfg.commissionBps / 10_000;
  }

  /** Index of today's bar for `symbol` (undefined = no execution bar today). */
  private todayIndex(symbol: string): number | undefined {
    return this.series.get(symbol)?.indexByDate.get(this.currentDate);
  }

  /** Index of the first bar dated >= currentDate (bars before it are completed). */
  private cutIndex(symbol: string): number {
    const bars = this.series.get(symbol)?.bars ?? [];
    let lo = 0, hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].date < this.currentDate) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Last COMPLETED close (strictly before currentDate) — decision-time mark. */
  private lastCompletedClose(symbol: string): number | undefined {
    const cut = this.cutIndex(symbol);
    return cut > 0 ? this.series.get(symbol)!.bars[cut - 1].close : undefined;
  }

  async getOpenPositions(): Promise<MeanRevPosition[]> {
    return this.positions.map(p => ({
      symbol: p.symbol,
      side: "buy" as const,
      quantity: p.qty,
      notional: p.qty * (this.lastCompletedClose(p.symbol) ?? p.mark),
      entryTime: p.entryTime,
    }));
  }

  async fetchCandles(symbol: string, bars: number): Promise<OHLCV[]> {
    const item = this.series.get(symbol);
    if (!item) return [];
    const cut = this.cutIndex(symbol);
    // close1545 mode: the session's 15:45 price is appended as a synthetic
    // LAST bar (dated the session being replayed, which is "yesterday" to
    // the one-session-forward engine clock — never dropped as a partial
    // bar). RSI(2)/SMA200/SMA5 all read closes, so the engine math is
    // untouched: only the last value of the series changes.
    const slice = this.p1545?.get(symbol)?.get(this.currentDate);
    if (slice !== undefined) {
      const out = item.bars.slice(Math.max(0, cut - (bars - 1)), cut).map(b => ({
        open: b.open, high: b.high, low: b.low, close: b.close, volume: 0, timestamp: b.timestamp,
      }));
      out.push({ open: slice.px, high: slice.px, low: slice.px, close: slice.px, volume: 0, timestamp: slice.ts });
      return out;
    }
    return item.bars.slice(Math.max(0, cut - bars), cut).map(b => ({
      open: b.open, high: b.high, low: b.low, close: b.close, volume: 0, timestamp: b.timestamp,
    }));
  }

  async openPosition(a: { symbol: string; side: "buy" | "sell"; notionalUsd: number }): Promise<{ ok: boolean; reason?: string }> {
    // Gross-exposure diagnostic (observer only — see grossCapDiag in
    // backtest-momentum-wf.ts): the live meanrev cap compares
    // Σ|getOpenPositions().notional| + new against baseUsd × mult, with the
    // book marked at the last COMPLETED close — record exactly those terms.
    if (grossCapDiag.onOpenAttempt) {
      let gross = 0;
      for (const p of this.positions) gross += Math.abs(p.qty * (this.lastCompletedClose(p.symbol) ?? p.mark));
      grossCapDiag.onOpenAttempt({ t: this.dayTs, grossBefore: gross, newNotional: a.notionalUsd, denom: this.cfg.initialEquity });
    }
    const i = this.todayIndex(a.symbol);
    if (i === undefined || i === 0) return { ok: false, reason: "no execution bar today" };
    const item = this.series.get(a.symbol)!;
    // close1545 mode: MOC entry in the SIGNAL session's closing auction —
    // qty is fixed when the order is SENT (at 15:45, whole shares floored
    // on the 15:45 price; declared), the fill prints at the close ± cost.
    const slice1545 = this.p1545?.get(a.symbol)?.get(this.currentDate);
    if (this.p1545 !== undefined) {
      if (slice1545 === undefined) return { ok: false, reason: "no 15:45 slice today" };
      const close = item.bars[i].close;
      const qty = Math.floor(a.notionalUsd / slice1545.px);
      if (qty <= 0) return { ok: false, reason: "computed qty < 1 share" };
      const entryPrice = close * this.slipIn;
      const entryFee = qty * entryPrice * this.commRate;
      this.feesPaid += entryFee;
      // "the live vol-scaled hard stop unchanged": distance from COMPLETED
      // closes strictly before the session (same inputs as the legacy path;
      // the 15:45 print deliberately does not enter the vol estimate).
      const stopFrac = this.stopSpec.mode === "none"
        ? null
        : this.stopSpec.mode === "fixed"
          ? this.stopSpec.pct
          : trailPctFromVol(item.closes.slice(0, i), this.stopSpec, 1) / 100;
      this.positions.push({ symbol: a.symbol, qty, entryPrice, entryTime: this.dayTs, entryFee, mark: entryPrice, stopFrac, fundingCost: 0, entryDate: this.currentDate, entryRealTs: slice1545.ts });
      return { ok: true };
    }
    const open = item.bars[i].open;
    // Whole shares floored on the RAW open (live Alpaca rounds to whole
    // shares; prior-replay parity keeps this axis out of the diff). Crypto
    // perps size fractionally instead — flooring a $1250 slot of BTC would
    // yield qty 0 (declared bias in the header: no stepSize rounding).
    const qty = this.fractionalQty ? a.notionalUsd / open : Math.floor(a.notionalUsd / open);
    if (qty <= 0) return { ok: false, reason: "computed qty < 1 share" };
    const entryPrice = open * this.slipIn;
    const entryFee = qty * entryPrice * this.commRate;
    this.feesPaid += entryFee;
    // Resolve the stop distance at ENTRY from signal-time information only:
    // closes strictly before today (index < i) — the execution bar must not
    // leak in. Daily bars → barsPerDay = 1 for volScaled.
    const stopFrac = this.stopSpec.mode === "none"
      ? null
      : this.stopSpec.mode === "fixed"
        ? this.stopSpec.pct
        : trailPctFromVol(item.closes.slice(0, i), this.stopSpec, 1) / 100;
    this.positions.push({ symbol: a.symbol, qty, entryPrice, entryTime: this.dayTs, entryFee, mark: entryPrice, stopFrac, fundingCost: 0 });
    return { ok: true };
  }

  /**
   * Seed the book with positions the LIVE sleeve already held at the
   * replay epoch (OPEN.md P2 "el libro del sim arranca vacío en el
   * epoch"): pushed directly as SimPositions, so maxPositions/slot
   * occupancy, the time stop (reads entryTime straight off
   * getOpenPositions — no persisted anchor needed, unlike momentum's
   * trail) and both stop phases manage them exactly like a position the
   * engine opened itself. meanrev is long-only: a non-"buy" seed is
   * dropped (declared limitation — never hit by the two sleeves this fix
   * targets). No fee is charged and no cash moves (the entry already
   * happened before this replay window).
   */
  seedPositions(seeds: SeedPosition[]): void {
    for (const s of seeds) {
      if (s.side !== "buy") continue;
      const stopFrac = seedStopFraction(s, this.stopSpec, this.cfg.hardStopPct);
      this.positions.push({
        symbol: s.symbol, qty: s.qty, entryPrice: s.entryPrice, entryTime: s.entryAt,
        entryFee: 0, mark: s.entryPrice, stopFrac, fundingCost: 0,
      });
    }
  }

  /**
   * Charge/credit every settled funding event in (fromExMs, toIncMs] on the
   * open long book — the SAME event semantics as SimBroker.applyFunding
   * (positive rate: longs pay; exclusive-left so an entry stamped exactly at
   * a settlement never pays it; per-position left bound = entryTime).
   * Notional marked at the last COMPLETED close (declared bias — header).
   * No-op without a FundingBook: the legacy path, byte for byte.
   */
  applyFunding(fromExMs: number, toIncMs: number): void {
    if (!this.fundingBook) return;
    for (const p of this.positions) {
      const mark = this.lastCompletedClose(p.symbol) ?? p.mark;
      for (const rate of this.fundingBook.eventsBetween(p.symbol, Math.max(fromExMs, p.entryTime), toIncMs)) {
        const cost = p.qty * mark * rate; // long-only book: positive rate = long pays
        p.fundingCost += cost;
        this.fundingPaid += cost;
        this.fundingBySymbol.set(p.symbol, (this.fundingBySymbol.get(p.symbol) ?? 0) + cost);
      }
    }
  }

  async closePosition(a: { symbol: string; side: "buy" | "sell" }): Promise<{ ok: boolean; reason?: string }> {
    const p = this.positions.find(x => x.symbol === a.symbol);
    if (!p) return { ok: false, reason: "no position" };
    const i = this.todayIndex(a.symbol);
    // No bar today (data hole): nothing to price the fill on — fail the
    // close, the engine holds and retries next pass (live analog: order
    // can't execute against a halted/holed symbol).
    if (i === undefined || i === 0) return { ok: false, reason: "no execution bar today" };
    // close1545 mode: exits fill in the SAME session's closing auction (MOC
    // at the decision session's close), not the next open.
    const bar = this.series.get(a.symbol)!.bars[i];
    if (this.p1545 !== undefined) {
      this.book(p, bar.close * this.slipOut, PENDING_ENGINE_REASON, this.dayTs, { date: this.currentDate, kind: "close" });
      return { ok: true };
    }
    const fill = bar.open * this.slipOut;
    this.book(p, fill, PENDING_ENGINE_REASON, this.dayTs);
    return { ok: true };
  }

  /** Decision-time equity (RiskGuard input): initial + realized net + open
   *  P&L marked at the last COMPLETED close — exactly what live's ~09:35 ET
   *  ledger read knows before today's bar exists. */
  async getEquity(): Promise<number> {
    let eq = this.cfg.initialEquity + this.realizedGross - this.feesPaid - this.fundingPaid - this.marginInterestPaid;
    for (const p of this.positions) {
      eq += ((this.lastCompletedClose(p.symbol) ?? p.mark) - p.entryPrice) * p.qty;
    }
    return eq;
  }

  /**
   * Reg-T financing on the borrowed balance (línea E, 2026-10-09 — mirrors
   * SimBroker.accrueMarginInterest, same documented day-count): charge
   * debit × annualRate/365 per CALENDAR day (UTC-midnight crossings — a
   * Fri→Mon hold pays 3 days), where debit = marked gross book − equity,
   * both at the last COMPLETED close (the same decision-time marks
   * getEquity and applyFunding use — today's bar hasn't printed at the
   * pre-pass accrual point). Rate 0 / absent cfg.marginInterest = strict
   * no-op, byte-identical legacy (and the legacy config hash: the key is
   * manifest-level `costs.<tier>.marginInterest`, dropped when undefined).
   */
  accrueMarginInterest(prevT: number, t: number): void {
    const rate = this.cfg.marginInterest?.annualRate ?? 0;
    if (rate <= 0 || prevT <= 0 || this.positions.length === 0) return;
    const days = Math.floor(t / 86_400_000) - Math.floor(prevT / 86_400_000);
    if (days <= 0) return;
    let gross = 0;
    let equity = this.cfg.initialEquity + this.realizedGross - this.feesPaid - this.fundingPaid - this.marginInterestPaid;
    for (const p of this.positions) {
      const mark = this.lastCompletedClose(p.symbol) ?? p.mark;
      gross += p.qty * mark;
      equity += (mark - p.entryPrice) * p.qty;
    }
    const debit = gross - equity;
    if (debit <= 0) return;
    this.marginInterestPaid += debit * (rate / 365) * days;
  }

  /** Sim clock is quantized: every fill of a day shares that day's single
   *  timestamp, so live's strict `exit_time > anchor` (which works because
   *  wall time elapses between a fill and the next pass) becomes `>=` here —
   *  otherwise fills stamped exactly at the anchor would never be counted.
   *  With `>=` alone, a PRE-pass gap stop (checkGapStops, exitAt = today's
   *  dayTs) would be counted TWICE: today (>= yesterday's anchor) and again
   *  tomorrow (>= today's anchor, which equals its exitAt). The cursor makes
   *  the live contract explicit instead: each realized trade feeds RiskGuard
   *  exactly once (the engine reads once per pass, anchor monotonically
   *  advancing — MeanRevEngine.runDaily, lastRiskReadAt). Bookings are
   *  append-ordered with nondecreasing exitAt ≥ the previous anchor, so the
   *  cursor never skips an eligible trade. */
  private riskReadCursor = 0;
  async getRealisedPnlSince(epochMs: number): Promise<number> {
    const unread = this.closed.slice(this.riskReadCursor);
    this.riskReadCursor = this.closed.length;
    return unread.filter(t => t.exitAt >= epochMs).reduce((s, t) => s + t.pnl, 0);
  }

  /**
   * close1545 night/day gross split: entry at close(entryDate), walk the
   * symbol's daily bars to the exit session, splitting each held day into
   * the overnight leg (prev close → open) and the intraday leg (open →
   * close, or open → fill for intraday/open exits). Price legs only (raw
   * closes/opens; slippage/fees are cost channels, reported separately).
   */
  private accumulateSplit(position: SimPosition, info: ExitInfo): void {
    if (position.entryDate === undefined) return; // seeds / legacy path
    const item = this.series.get(position.symbol);
    if (!item) return;
    const e = item.indexByDate.get(position.entryDate);
    const x = item.indexByDate.get(info.date);
    if (e === undefined || x === undefined || x <= e) return;
    const q = position.qty;
    for (let d = e + 1; d <= x; d++) {
      this.nightPnl += q * (item.bars[d].open - item.bars[d - 1].close);
      if (d < x) this.dayPnl += q * (item.bars[d].close - item.bars[d].open);
    }
    if (info.kind === "close") this.dayPnl += q * (item.bars[x].close - item.bars[x].open);
    else if (info.kind === "intraday") this.dayPnl += q * ((info.rawPx ?? item.bars[x].close) - item.bars[x].open);
    // kind "open": the exit IS the open print — no intraday leg.
  }

  /** Book a close with the same accounting the prior replay used. */
  book(position: SimPosition, price: number, reason: string, exitAt: number, exitInfo?: ExitInfo): void {
    if (this.p1545 !== undefined && exitInfo !== undefined) this.accumulateSplit(position, exitInfo);
    const gross = (price - position.entryPrice) * position.qty;
    const exitFee = position.qty * price * this.commRate;
    this.realizedGross += gross;
    this.feesPaid += exitFee;
    // fundingCost is already inside the global fundingPaid (equity-level
    // accounting); netting it here only moves it into the TRADE's own pnl —
    // win rate, expectancy and RiskGuard's realised-pnl read see it, same
    // as SimBroker's fundingCashDelta. Always 0 without a FundingBook
    // (stocks: byte-identical to the pre-funding accounting).
    const netPnl = gross - position.entryFee - exitFee - position.fundingCost;
    // entryAt/entryPrice/exitPrice/qty: the optional ClosedTrade metadata
    // declared for op-by-op live-vs-sim comparison. The momentum SimBroker
    // fills them; this adapter never did until 2026-09-25 (R1 audit: exposure
    // could not be measured; scripts/parity-check.ts reconstructs day-by-day
    // ENTRY decisions from them). OUTPUT-ONLY: NOT part of tradesSha256
    // (symbol|side|pnl|exitAt|reason), no metric or hash reads them.
    this.closed.push({
      symbol: position.symbol, side: "buy", pnl: netPnl, exitAt, reason,
      // close1545: entryAt carries the REAL 15:45 decision instant of the
      // entry session (entryTime is the shifted engine clock). Legacy path:
      // entryRealTs is undefined — byte-identical metadata.
      entryAt: position.entryRealTs ?? position.entryTime, entryPrice: position.entryPrice, exitPrice: price, qty: position.qty,
    });
    this.positions.splice(this.positions.indexOf(position), 1);
  }

  /** Phase 1 (pre-pass) stops: today's open GAPS through the level → the
   *  live GTC stop / 15s loop closes AT THE OPEN, before the ~09:35 engine
   *  pass — the slot is free and equity is down before today's decisions.
   *  Only positions held from a prior day exist here by construction. */
  checkGapStops(): void {
    for (const position of [...this.positions]) {
      if (position.stopFrac === null) continue; // mode "none": strategy exits only
      const i = this.todayIndex(position.symbol);
      if (i === undefined) continue;
      const bar = this.series.get(position.symbol)!.bars[i];
      const stop = position.entryPrice * (1 - position.stopFrac);
      if (bar.open > stop) continue; // not gapped through — phase 2 (intraday) territory
      this.book(position, bar.open * this.slipOut, "STOP_LOSS", this.dayTs, { date: this.currentDate, kind: "open" });
    }
  }

  /** Phase 2 (post-pass) stops: intraday breach on today's bar —
   *  intentionally includes positions opened this same day (prior-replay
   *  parity; live's 15s loop watches from entry). Gap-throughs were already
   *  booked by checkGapStops() pre-pass, so for every position still here
   *  open > stop and min(open, stop) = stop; the min() is kept as a
   *  belt-and-braces floor. */
  checkStops(): void {
    for (const position of [...this.positions]) {
      if (position.stopFrac === null) continue; // mode "none": strategy exits only
      // close1545 mode: a position entered THIS pass filled at the CLOSE —
      // the session's low printed before it existed, so the intraday stop
      // cannot apply on the entry session (first exposure is the next gap).
      if (this.p1545 !== undefined && position.entryDate === this.currentDate) continue;
      const i = this.todayIndex(position.symbol);
      if (i === undefined) continue;
      const bar = this.series.get(position.symbol)!.bars[i];
      const stop = position.entryPrice * (1 - position.stopFrac);
      if (bar.low > stop) continue;
      const fill = Math.min(bar.open, stop) * this.slipOut; // floor only — gaps were booked pre-pass
      this.book(position, fill, "STOP_LOSS", this.dayTs, { date: this.currentDate, kind: "intraday", rawPx: Math.min(bar.open, stop) });
    }
  }

  /** End-of-day equity at today's closes (falls back to the last mark on a
   *  holed date) — feeds the equity curve, never the engine. */
  markToMarket(): number {
    let eq = this.cfg.initialEquity + this.realizedGross - this.feesPaid - this.fundingPaid - this.marginInterestPaid;
    for (const position of this.positions) {
      const i = this.todayIndex(position.symbol);
      if (i !== undefined) position.mark = this.series.get(position.symbol)!.bars[i].close;
      eq += (position.mark - position.entryPrice) * position.qty;
    }
    return eq;
  }
}

/**
 * Run one fully-resolved meanrev replay through the REAL MeanRevEngine.
 * Same contract as runWithConfig (momentum): ReplayConfig in, ReplayResult
 * out. `initialRiskState` seeds the engine's RiskGuard for fold-to-fold
 * chain continuity (it used to be inert here — the old reimplementation had
 * no RiskGuard; the real engine does, like live meanrev_stocks).
 */
export async function runMeanRevReplay(
  cfg: ReplayConfig,
  win: { label: string; from: string; to: string },
  initialRiskState?: RiskState,
  /** Live positions already open at the replay epoch (win.from) — see
   *  SeedPosition / SimMeanRevBroker.seedPositions. Absent/empty = the
   *  exact legacy behavior (empty book at the epoch). */
  seedPositions?: SeedPosition[],
): Promise<ReplayResult | null> {
  const p = cfg.meanrev;
  if (!p) throw new Error("meanrev replay requires cfg.meanrev params");
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);
  const loadFrom = fromMs - cfg.warmupDays * 86_400_000;
  const slipOut = 1 - cfg.slippageBps / 10_000;
  // Stop axis: absent = legacy fixed hardStopPct (pre-existing hashes and
  // behavior untouched).
  const stopSpec: HardStopSpec = cfg.hardStop ?? { mode: "fixed", pct: cfg.hardStopPct };
  // Crypto-perps mode (see header): fractional qty, funding, √365, and the
  // late-listing coverage waiver — all keyed on the source so every other
  // source (alpaca_wide, synthetic fixtures) keeps the legacy path exactly.
  const isCrypto = cfg.source === "binance_futures";
  if (cfg.funding && !isCrypto) {
    throw new Error("meanrev replay: funding=true requires source=binance_futures (funding_rates carry Binance perp symbols)");
  }
  // §12-septies G0 execution mode (OPT-IN by meanrev.execution — see the
  // MeanRevSimParams augmentation above): stocks daily only, declared
  // universe only (no membership), requires the 15:45-slice DB.
  const exec1545 = p.execution === "close1545";
  if (exec1545) {
    if (isCrypto || cfg.funding) throw new Error("meanrev replay: execution=close1545 is stocks-only");
    if (cfg.membership) throw new Error("meanrev replay: execution=close1545 does not support membership mode");
    if (!cfg.sliceDbPath) throw new Error("meanrev replay: execution=close1545 requires cfg.sliceDbPath (hist-sp500-close.db)");
  }

  const db = new Database(cfg.dbPath, { readonly: true });
  try {
    const series = new Map<string, Series>();
    for (const symbol of cfg.universe) {
      const s = loadDailySeries(db, cfg, symbol, loadFrom, toMs);
      const lateListing = isCrypto && firstBarEver(db, cfg, symbol) > loadFrom;
      validateDailyCoverage(s, symbol, p.smaLong, loadFrom, fromMs, toMs, lateListing);
      series.set(symbol, s);
    }

    // ── point-in-time index membership (cfg.membership — see the
    // ReplayConfig docstring in backtest-momentum-wf.ts). DECLARED symbols
    // keep the fail-closed coverage validation above; MEMBER symbols skip
    // it — their data presence is checked PER TRAMO at decision time by the
    // eligibility hook (member at d + fresh completed bar + smaLong+1
    // completed bars), so a hole/late listing just makes them ineligible
    // instead of aborting the fold. Members with no bars at all are
    // dropped with a warn.
    let membershipBook: ReturnType<typeof loadMembership> | undefined;
    const loadedMembers: string[] = [];
    if (cfg.membership) {
      if (isCrypto || cfg.funding) throw new Error("membership mode is stocks-only (alpaca daily bars)");
      membershipBook = loadMembership(db, cfg.membership.index);
      const excluded = new Set([...(cfg.membership.exclude ?? []), ...cfg.universe, cfg.refSymbol]);
      const members: string[] = [];
      for (const [ticker, tramos] of membershipBook) {
        if (excluded.has(ticker)) continue;
        if (tramos.some(t => t.startMs < toMs && (t.endMs === null || t.endMs > fromMs))) members.push(ticker);
      }
      members.sort();
      let missing = 0;
      for (const symbol of members) {
        try {
          series.set(symbol, loadDailySeries(db, cfg, symbol, loadFrom, toMs));
          loadedMembers.push(symbol);
        } catch {
          missing++;
        }
      }
      if (missing > 0) console.warn(`membership(${cfg.membership.index}): ${missing}/${members.length} overlapping members have NO bars in [${win.from}, ${win.to}) and are dropped (see the downloader's coverage report)`);
    }
    const replayUniverse = cfg.membership ? [...cfg.universe, ...loadedMembers] : cfg.universe;
    // Benchmark series (refSymbol may live outside the universe on stocks;
    // on crypto it is BTC and doubles as a traded symbol). NEVER late-listed:
    // it anchors the benchmark, so it must cover the full warmup.
    const refSeries = series.get(cfg.refSymbol) ?? loadDailySeries(db, cfg, cfg.refSymbol, loadFrom, toMs);
    validateDailyCoverage(refSeries, cfg.refSymbol, p.smaLong, loadFrom, fromMs, toMs);
    // Fail-closed settled-funding coverage over the whole fold (FundingBook
    // constructor throws on gaps/short tails) — same instrument as momentum.
    const fundingBook = cfg.funding ? new FundingBook(db, cfg.universe, fromMs, toMs) : undefined;

    // Trading timeline: union of universe dates inside [fromMs, toMs), plus
    // the max in-window bar timestamp per date for equity-history stamps.
    const tsByDate = new Map<string, number>();
    for (const item of series.values()) {
      for (const bar of item.bars) {
        if (bar.timestamp < fromMs || bar.timestamp >= toMs) continue;
        tsByDate.set(bar.date, Math.max(tsByDate.get(bar.date) ?? 0, bar.timestamp));
      }
    }
    const windowDates = [...tsByDate.keys()].sort();
    if (windowDates.length === 0) return null;

    // close1545: adjusted 15:45 prices per universe symbol/session —
    // p1545_adj = adjClose(session) × raw1545/rawClose (basis of the SAME
    // dailies this replay trades; scripts/lib/closeSlices.ts). A session
    // with no slice (or no daily bar) simply has no 15:45 price.
    let p1545Map: Map<string, Map<string, { px: number; ts: number }>> | undefined;
    if (exec1545) {
      const slices = loadCloseSlices(cfg.sliceDbPath!);
      p1545Map = new Map();
      for (const symbol of cfg.universe) {
        const bySession = slices.get(symbol);
        if (!bySession) continue;
        const item = series.get(symbol)!;
        const m = new Map<string, { px: number; ts: number }>();
        for (const [session, row] of bySession) {
          const idx = item.indexByDate.get(session);
          if (idx === undefined) continue;
          m.set(session, { px: item.bars[idx].close * row.ratio, ts: row.sliceStartMs + 15 * 60_000 });
        }
        p1545Map.set(symbol, m);
      }
    }

    // ── the REAL engine over the sim adapter ─────────────────────────────
    const broker = new SimMeanRevBroker(cfg, series, stopSpec, fundingBook, isCrypto, p1545Map);
    // Seed the book with live positions already open at the epoch (OPEN.md
    // P2) — BEFORE the day loop starts, so maxPositions/stops see them
    // from day 1. Absent/empty seedPositions = byte-identical legacy
    // empty-book behavior.
    if (seedPositions && seedPositions.length > 0) broker.seedPositions(seedPositions);

    // PIT entry-eligibility hook (membership mode): a member is eligible at
    // the current session iff it is a member at the sim clock, has smaLong+1
    // COMPLETED bars (the engine's own warmup bound) and its last completed
    // bar is no older than the previous trading day (the engine's isFresh
    // contract — making eligible ⇒ fresh, so one dead tape never blocks the
    // day's entries). cfg.liquidityRank adds the topN median-dollar-volume
    // screen over CLOSED sessions (strictly backward-looking).
    let entryEligibility: ((symbol: string, nowMs: number) => boolean) | undefined;
    if (cfg.membership && membershipBook) {
      const book = membershipBook;
      const declaredSet = new Set(cfg.universe);
      const lr = cfg.liquidityRank;
      const completedCount = (item: Series): number => {
        const bars = item.bars;
        let lo = 0, hi = bars.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].date < broker.currentDate) lo = mid + 1; else hi = mid; }
        return lo;
      };
      let prevKeyFor = "";
      let prevKey = "";
      const memberFresh = (symbol: string, nowMs: number): boolean => {
        if (!isMemberAt(book, symbol, nowMs)) return false;
        const item = series.get(symbol);
        if (!item) return false;
        const cut = completedCount(item);
        if (cut < p.smaLong + 1) return false;
        if (prevKeyFor !== broker.currentDate) { prevKeyFor = broker.currentDate; prevKey = getPreviousTradingDay(broker.currentDate); }
        return item.bars[cut - 1].date >= prevKey;
      };
      const memberOhlcv = lr
        ? new Map(loadedMembers.map(s => [s, series.get(s)!.bars as OHLCV[]]))
        : undefined;
      let cachedNow = NaN;
      let liquid = new Set<string>();
      entryEligibility = (symbol, nowMs) => {
        if (declaredSet.has(symbol)) return true;
        if (!memberFresh(symbol, nowMs)) return false;
        if (!lr) return true;
        if (nowMs !== cachedNow) {
          cachedNow = nowMs;
          const fresh = loadedMembers.filter(s => memberFresh(s, nowMs));
          liquid = topNByDollarVolume(fresh, memberOhlcv!, nowMs, 86_400_000, lr.lookbackSessions, lr.topN);
        }
        return liquid.has(symbol);
      };
    }
    // close1545 (§12-septies G0): a symbol with NO 15:45 slice this session
    // has no signal this session — entry-ineligible AND exempt from the
    // all-universe entry-freshness gate (its daily tape only reaches the
    // previous session, which under the one-session-forward engine clock
    // reads as stale; without the exemption one missing slice would block
    // the whole day's entries). Mutually exclusive with membership mode.
    if (exec1545) {
      entryEligibility = (symbol) => p1545Map!.get(symbol)?.has(broker.currentDate) === true;
    }
    // "silent" still forwards warns to the diagnostic hook (null → no-op):
    // the engine's gross-cap veto only exists as a warn line + report entry,
    // and replays otherwise discard it (see grossCapDiag docstring).
    const silent = { info: () => {}, warn: (m: string) => { grossCapDiag.onWarn?.(m); }, error: () => {} };
    // Risk continuity shim (same pattern as runWithConfig): load() seeds the
    // prior fold's RiskGuard state; engine.getRiskState() below is the
    // authoritative final state. save() is a no-op — nothing outlives the run.
    const statePersistence: MomentumStatePersistence = {
      load: () => initialRiskState ? { v: 1, risk: { ...initialRiskState } } : null,
      save: () => {},
    };
    const engine = new MeanRevEngine(
      {
        universe: [...replayUniverse],
        // PIT membership hook (absent = byte-identical legacy engine config).
        ...(entryEligibility ? { entryEligibility } : {}),
        accountId: `replay_${cfg.sleeve}`,
        baseUsd: cfg.initialEquity, // slot = initialEquity × slotPct, fixed notional (production parity)
        slotPct: p.slotPct,
        maxPositions: p.maxPositions,
        entryRsi: p.entryRsi,
        smaLong: p.smaLong,
        smaExit: p.smaExit,
        timeStopDays: p.timeStopDays,
        // Production keeps historyBars = smaLong + 10 (210 for SMA200); the
        // engine only needs smaLong+1 completed bars for a signal.
        historyBars: p.smaLong + 10,
        // heartbeatName deliberately unset: no ops watchdog, no sleeveOutput
        // DB writes inside a replay.
        risk: {}, // DEFAULT_RISK_CONFIG — exactly what live meanrev_stocks runs
        // RSI2-audit passthrough (both OPT-IN, undefined by default — see
        // the module augmentation above and MeanRevEngineConfig's docstrings).
        rsiMethod: p.rsiMethod,
        deterministicTieBreak: p.deterministicTieBreak,
        // Gross-cap passthrough (G batch, 2026-10-05): ReplayConfig top-level
        // key, same as the momentum runner (runWithConfig). undefined = OFF —
        // the engine default and every legacy hash (canonicalJson drops it).
        // Live meanrev_stocks runs 0.84× of baseUsd (src/index.ts); the
        // authoritative chains never carried it — this is what lets the
        // diagnostic measure that gap.
        maxGrossExposureMult: cfg.maxGrossExposureMult,
      },
      broker,
      silent,
      {
        isTradingDay: () => true, // the timeline IS the data's trading dates
        now: () => broker.dayTs,
        alreadyEnteredToday: () => false, // sim book is the ledger; no trading.db
      },
      statePersistence,
    );

    // Neutralize the host maintenance kill-switch for the replay loop and
    // restore it after (see header; same incident class as runWithConfig).
    const prevTradingEnabled = process.env.TRADING_ENABLED;
    delete process.env.TRADING_ENABLED;

    let equity = cfg.initialEquity;
    let peakEquity = equity;
    let maxDrawdown = 0;
    let ruined = false;
    let prevDayTs = 0;
    const equityHistory: Array<{ t: number; eq: number }> = [];

    try {
      for (let di = 0; di < windowDates.length; di++) {
        const date = windowDates[di];
        const stampTs = tsByDate.get(date)!;
        broker.currentDate = date;
        // close1545 ENGINE-CLOCK SHIFT: the pass that decides session D at
        // 15:45 runs with the engine's todayKey = the NEXT session (or the
        // next calendar day on the fold's last session), so the synthetic
        // 15:45 bar dated D is the engine's last COMPLETED bar (never
        // dropped as a partial), the freshness gate expects exactly D, the
        // same-completed-bar exit deferral works on the following pass, and
        // the time stop counts sessions AFTER the entry session (TIME_STOP
        // fires at the close of the 10th session after the entry close).
        // Legacy path: dayTs = the session's own bar stamp, byte-identical.
        broker.dayTs = exec1545 ? noonEtMs(windowDates[di + 1] ?? nextCalendarKey(date)) : stampTs;

        // Funding settles continuously on live perps: apply every settlement
        // in (prevDay, today] BEFORE the pass, so the RiskGuard equity read
        // inside runDaily already includes it. No-op without a FundingBook.
        // Applied before the gap stops: a position stopped at today's open
        // held through the settlement instant that stamps the open.
        broker.applyFunding(prevDayTs, stampTs);
        // Reg-T financing accrues over the same pre-pass range, so the
        // RiskGuard equity read inside runDaily already includes it (same
        // placement as runWithConfig's accrueMarginInterest call). No-op
        // unless costs.<tier>.marginInterest set a nonzero rate (línea E).
        broker.accrueMarginInterest(prevDayTs, stampTs);
        prevDayTs = stampTs;

        // Delisting (membership mode only): a held symbol whose tape is
        // EXHAUSTED (last bar is the series' final bar, >6 calendar days
        // behind the sim clock, no future bar ever) closes at that last
        // close ± slippage with reason "DELISTED". Declared OPTIMISTIC:
        // the real last negotiable print can be worse.
        if (cfg.membership) {
          for (const position of [...broker.positions]) {
            const item = series.get(position.symbol)!;
            const lastBar = item.bars[item.bars.length - 1];
            if (lastBar.date < date && broker.dayTs - lastBar.timestamp > 6 * 86_400_000) {
              broker.book(position, lastBar.close * slipOut, "DELISTED", broker.dayTs);
            }
          }
        }

        // Phase 1: stops the OPEN gaps through fire BEFORE the engine pass
        // (live: GTC stop / 15s loop closes at ~09:30; the ~09:35 pass sees
        // the slot free and the realized loss — 2026-09-25 fidelity fix).
        broker.checkGapStops();
        // close1545 fidelity (2026-10-14 director review): with a 15:45
        // decision, an INTRADAY stop whose low printed during the session
        // fires BEFORE the decision in live (15 s loop + native GTC stop) —
        // the bar's low timing is unknown, so the conservative reading is
        // "the stop fired first". Run phase 2 BEFORE the pass here: only
        // prior-session positions exist at this point (entries happen inside
        // the pass and are exempt by the entry-session guard), stop-outs
        // book at the stop level and free their slot before the 15:45
        // decision. The legacy 09:35 path keeps phase 2 AFTER the pass,
        // byte-identical.
        if (exec1545) broker.checkStops();

        // Live evaluates the prior completed bar shortly after today's open:
        // exits free slots, then ranked entries — all inside the engine.
        const before = broker.closed.length;
        const report = await engine.runDaily();

        // Rewrite the placeholder reasons with the engine's own labels
        // (SMA_EXIT / TIME_STOP) from its report — the adapter close contract
        // has no reason channel. Fail closed on an unattributed close.
        const booked = broker.closed.slice(before);
        for (const c of report.closes) {
          if (!c.ok) continue;
          const trade = booked.find(t => t.symbol === c.symbol && t.reason === PENDING_ENGINE_REASON);
          if (!trade) throw new Error(`meanrev replay: engine reported a close for ${c.symbol} with no booked trade`);
          trade.reason = c.reason;
        }
        const orphan = booked.find(t => t.reason === PENDING_ENGINE_REASON);
        if (orphan) throw new Error(`meanrev replay: booked close for ${orphan.symbol} not attributed by the engine report`);

        // Phase 2: intraday stops (not gapped at the open) — driver-level
        // (AccountManager parity), after the engine pass, including
        // same-day entries. close1545 already ran this pre-pass (see above;
        // its same-session entries are exempt from intraday stops anyway —
        // they fill at the close, after the session's low printed).
        if (!exec1545) broker.checkStops();

        equity = broker.markToMarket();
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
        // Equity is stamped at the SESSION's own bar timestamp (stampTs ===
        // broker.dayTs on the legacy path) so daily returns keep real
        // session dates under the close1545 engine-clock shift.
        equityHistory.push({ t: stampTs, eq: equity });
        if (equity <= 0) { ruined = true; break; }
      }
    } finally {
      if (prevTradingEnabled !== undefined) process.env.TRADING_ENABLED = prevTradingEnabled;
    }

    // ── fold-end liquidation (fail closed on a missing terminal price) ───
    if (!ruined) {
      // Terminal funding settle: settlements in (last replay day, toMs)
      // accrue while positions ride to the fold edge; the event exactly AT
      // toMs belongs to the NEXT fold (the same toMs−1 cap runWithConfig
      // applies). currentDate pushed past every bar so the mark is the LAST
      // in-window close — the same price the liquidation below uses.
      if (broker.positions.length > 0 && prevDayTs > 0) {
        broker.currentDate = "9999-12-31";
        broker.applyFunding(prevDayTs, toMs - 1);
        // Terminal financing over the same capped range (línea E).
        broker.accrueMarginInterest(prevDayTs, toMs - 1);
      }
      for (const position of [...broker.positions]) {
        const item = series.get(position.symbol)!;
        const lastIdx = [...item.bars].reverse().findIndex(b => b.timestamp >= fromMs && b.timestamp < toMs);
        if (lastIdx < 0) throw new Error(`meanrev replay: no terminal price for ${position.symbol}`);
        const lastBar = item.bars[item.bars.length - 1 - lastIdx];
        const px = lastBar.close * slipOut;
        broker.book(position, px, "fold_end", toMs, exec1545 ? { date: lastBar.date, kind: "close" } : undefined);
      }
    }
    const finalEq = ruined
      ? Math.max(0, equity)
      : cfg.initialEquity + broker.realizedGross - broker.feesPaid - broker.fundingPaid - broker.marginInterestPaid;
    equityHistory.push({ t: toMs, eq: finalEq });
    peakEquity = Math.max(peakEquity, finalEq);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - finalEq) / peakEquity);

    // ── metrics ──────────────────────────────────────────────────────────
    const closed = broker.closed;
    const tradesBySymbol: Record<string, { trades: number; grossPnl: number; fees: number; funding: number }> = {};
    for (const s of replayUniverse) tradesBySymbol[s] = { trades: 0, grossPnl: 0, fees: 0, funding: 0 };
    for (const t of closed) {
      const acc = tradesBySymbol[t.symbol];
      if (acc) { acc.trades++; acc.grossPnl += t.pnl; }
    }
    for (const [symbol, acc] of Object.entries(tradesBySymbol)) {
      acc.funding = broker.fundingBySymbol.get(symbol) ?? 0; // 0 without a book (legacy shape)
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
        const ret = (b.last - a.last) / a.last;
        dailyReturns.push({ date: b.key, ret });
        sessionReturns.push({ from: new Date(a.lastT).toISOString(), to: new Date(b.lastT).toISOString(), ret });
      }
    }
    const rets = dailyReturns.map(r => r.ret);
    const mean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    // 24/7 perps produce ~365 daily observations/yr; the equity calendar 252.
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(isCrypto ? 365 : 252) : 0;

    const wins = closed.filter(t => t.pnl > 0).length;
    const days = (toMs - fromMs) / 86_400_000;

    // refSymbol buy-and-hold over the same window (close-to-close).
    const refWindow = refSeries.bars.filter(b => b.timestamp >= fromMs && b.timestamp < toMs);
    const bench = refWindow.length > 1 && refWindow[0].close > 0
      ? (refWindow[refWindow.length - 1].close - refWindow[0].close) / refWindow[0].close
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
      expectancy: closed.length ? closed.reduce((s, t) => s + t.pnl, 0) / closed.length : 0,
      fees: broker.feesPaid,
      funding: broker.fundingPaid,
      marginInterest: broker.marginInterestPaid,
      liquidations: 0,
      marginRejects: 0,
      ruined,
      bench,
      dailyReturns,
      sessionReturns,
      tradesBySymbol,
      equityHistory,
      closedTrades: closed,
      hash: hashReplayConfig(cfg),
      // Authoritative: the REAL engine's RiskGuard state at replay end —
      // walk-forward chains it into the next fold (previously inert).
      finalRiskState: { ...engine.getRiskState() },
      // G0 output-only extras: gross night/day split of the close1545 mode
      // (absent on the legacy path — the result shape is untouched there).
      ...(exec1545 ? { execSplit: { nightPnl: broker.nightPnl, dayPnl: broker.dayPnl } } : {}),
    };
  } finally {
    db.close();
  }
}
