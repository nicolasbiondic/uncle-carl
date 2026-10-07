// ══════════════════════════════════════════════
// MeanRev Engine (v8 — "meanrev_stocks" sleeve)
// ══════════════════════════════════════════════
//
// Daily mean-reversion on stocks (Connors-style RSI2). Backtest-validated in
// scripts/backtest-meanrev.ts (positive in all 6 walk-forward windows
// 2019-2026) — the RSI/SMA math below is copied verbatim from that script.
//
// Rules (long-only, no leverage):
//   Entry (signal on YESTERDAY's completed daily bar, fill after today's
//   open): RSI(2) < entryRsi AND close > SMA(200). Rank by lowest RSI.
//   Exit: yesterday's close > SMA(5), OR held ≥ timeStopDays trading days.
//   Hard SL 4% intraday: AccountManager.checkAllStopLoss (15s loop) via
//   profile.stopLossPct — NOT reimplemented here.
//   Sizing: slot = baseUsd × slotPct (fixed notional, NO equity feedback),
//   max maxPositions concurrent.
//   Portfolio breaker: the SAME RiskGuard the momentum sleeves use
//   (../momentum/RiskGuard) gates NEW entries only — evaluated once per
//   daily pass, right before the entries section, on the sleeve's own
//   equity (broker.getEquity(), sleeve-ledger — never the shared Alpaca
//   account total; see the "portfolio risk gate" comment in runDaily).
//   Exits (SMA_EXIT/TIME_STOP) below are NEVER gated by it — a paused
//   sleeve still manages every open position, it only stops opening new
//   ones. This matters here specifically because entries are correlated BY
//   DESIGN (RSI2<5 fires market-wide on crash days — the slots (7 since 2026-09-24) enter
//   together); before this, the only cap on that was structural (maxPositions ×
//   slotPct).
//
// One pass per trading day: index.ts schedules runDaily() shortly after the
// open (≥ 09:35 ET). Universe is DISJOINT from momentum_stocks by design —
// same broker wallet, no position netting.

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import type { OHLCV } from "../../utils/types";
import type { CurrentPosition } from "../momentum/Rebalancer";
import { getDB, getETDateKey, getETDayBounds } from "../../db/database";
import { isTradingDay, getPreviousTradingDay } from "../../utils/marketHours";
import { heartbeats } from "../../ops/heartbeat";
import { sleeveOutput, isPolicyPreventedReason } from "../../ops/sleeveOutput";
import { isTradingEnabled } from "../../config";
import {
  evaluateRisk, recordRebalanceOutcome, detectPauseTransition, INITIAL_RISK_STATE, DEFAULT_RISK_CONFIG,
  type RiskState, type RiskGuardConfig, type RiskAssessment,
} from "../momentum/RiskGuard";
import { eventBus, EVENTS } from "../../utils/events";
// Reused verbatim, NOT reimplemented — same v1 envelope
// ({ v: 1, risk, trailMarks }) all four momentum sleeves persist through
// (see index.ts's fileStatePersistence). meanrev has no trailing-stop
// watermarks, so it always writes/reads an empty trailMarks map.
import type { CapacityGuardConfig, MomentumStatePersistence, TrailStopConfig } from "../momentum/MomentumEngine";
import { averageDailyDollarVolume, trailPctFromVol, validRiskAnchor } from "../momentum/MomentumEngine";

// ── Math (copied from scripts/backtest-meanrev.ts) ──────────────────────────

/** Cutler's RSI(2) at index i (needs i>=2) — 2-bar SIMPLE averages, NOT the
 *  Wilder/TA-Lib recursive smoothing this function used to be (mis)labeled
 *  as (doc fix only, 2026-09 audit — the math below is UNCHANGED). With
 *  n=2 this ties to EXACTLY 0 for ANY pair of down closes, which is why
 *  most real-universe candidates tie and `cands.sort`'s stability resolves
 *  the tie by MEANREV_UNIVERSE iteration order — see rsi2Wilder (the actual
 *  Wilder recursion) and MeanRevEngineConfig.rsiMethod/deterministicTieBreak,
 *  which fix this opt-in. Kept as the DEFAULT (rsiMethod="cutler" or unset)
 *  for byte-identical legacy behavior. */
export function rsi2(closes: number[], i: number): number {
  const d1 = closes[i - 1] - closes[i - 2];
  const d2 = closes[i] - closes[i - 1];
  const avgG = (Math.max(d1, 0) + Math.max(d2, 0)) / 2;
  const avgL = (Math.max(-d1, 0) + Math.max(-d2, 0)) / 2;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

/** Wilder-style RSI(2) at index i — TA-Lib ta_RSI.c smoothing recursion,
 *  ported verbatim for n=2: seed = SIMPLE average of the first n deltas
 *  from closes[0], then for every subsequent bar
 *  avgG=(avgG·(n-1)+max(Δ,0))/n, avgL=(avgL·(n-1)+max(-Δ,0))/n; RSI =
 *  100·avgG/(avgG+avgL) (100 when avgG+avgL is 0). Unlike rsi2 (Cutler),
 *  this is RECURSIVE — it needs the FULL closes[0..i] history, not a fixed
 *  2-bar window — but the seed's influence decays by a factor of 0.5 every
 *  bar (n=2), so it is negligible after ~40 bars regardless of where the
 *  history was truncated (see the convergence test in
 *  MeanRevEngine.rsiMethod.test.ts). Requires i >= 2. */
export function rsi2Wilder(closes: number[], i: number): number {
  const n = 2;
  let avgG = 0;
  let avgL = 0;
  for (let k = 1; k <= n; k++) {
    const d = closes[k] - closes[k - 1];
    avgG += Math.max(d, 0);
    avgL += Math.max(-d, 0);
  }
  avgG /= n;
  avgL /= n;
  for (let k = n + 1; k <= i; k++) {
    const d = closes[k] - closes[k - 1];
    avgG = (avgG * (n - 1) + Math.max(d, 0)) / n;
    avgL = (avgL * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (avgG + avgL === 0) return 100;
  return (100 * avgG) / (avgG + avgL);
}

export function sma(closes: number[], i: number, n: number): number {
  if (i + 1 < n) return NaN;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += closes[k];
  return s / n;
}

// ── Retry control (small JSON state, no framework) ─────────────────────────

/** Reasons that indicate a broker/terminal rejection — do NOT retry these. */
const TERMINAL_ACTION_SUBSTRINGS = [
  "insufficient_buying_power",
  "qty_too_small",
  "computed qty < 1 share",
  "insufficient fill",
  "trading_disabled",
  "halted",
  "suspended",
  "account_blocked",
];

export function isTerminalActionFailure(reason?: string): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return TERMINAL_ACTION_SUBSTRINGS.some((s) => r.includes(s));
}

export interface MeanRevRetryAttempt {
  count: number;
  firstAt: number;
  lastAt: number;
  terminal?: boolean;
  terminalReason?: string;
}

export interface MeanRevRetryState {
  lastSuccessDate?: string;
  attempts: Record<string, MeanRevRetryAttempt>;
}

export interface MeanRevRetryPolicy {
  maxDataRetries: number;
  baseBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
}

export const DEFAULT_MEANREV_RETRY_POLICY: MeanRevRetryPolicy = {
  maxDataRetries: 3,
  baseBackoffMs: 5 * 60 * 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 60 * 60 * 1000,
};

export interface MeanRevRetryDecision {
  run: boolean;
  skipEntries: boolean;
  reason?: "success" | "terminal" | "backoff";
  waitMs?: number;
}

/** Small persisted per-date retry state for meanrev daily runs. */
export class MeanRevRetryController {
  private state: MeanRevRetryState;
  private policy: MeanRevRetryPolicy;

  constructor(
    private statePath: string,
    policy?: Partial<MeanRevRetryPolicy>,
    private fs: {
      existsSync: (p: string) => boolean;
      readFileSync: (p: string, enc: string) => string;
      writeFileSync: (p: string, data: string) => void;
      renameSync: (old: string, neu: string) => void;
    } = { existsSync, readFileSync, writeFileSync, renameSync },
  ) {
    this.policy = { ...DEFAULT_MEANREV_RETRY_POLICY, ...policy };
    this.state = this.load();
  }

  private load(): MeanRevRetryState {
    if (!this.fs.existsSync(this.statePath)) return { attempts: {} };
    try {
      const raw = this.fs.readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as MeanRevRetryState;
      return { ...parsed, attempts: parsed.attempts ?? {} };
    } catch {
      return { attempts: {} };
    }
  }

  save(): void {
    const tmp = `${this.statePath}.tmp`;
    this.fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    this.fs.renameSync(tmp, this.statePath);
  }

  shouldRun(todayKey: string, now: number): MeanRevRetryDecision {
    if (this.state.lastSuccessDate === todayKey) return { run: false, skipEntries: false, reason: "success" };
    const attempt = this.state.attempts[todayKey];
    if (attempt?.terminal) return { run: false, skipEntries: false, reason: "terminal" };
    if (!attempt) return { run: true, skipEntries: false };
    if (attempt.count >= this.policy.maxDataRetries) return { run: true, skipEntries: true };
    const backoff = Math.min(
      this.policy.baseBackoffMs * Math.pow(this.policy.backoffMultiplier, attempt.count - 1),
      this.policy.maxBackoffMs,
    );
    if (now - attempt.lastAt < backoff) {
      return { run: false, skipEntries: false, reason: "backoff", waitMs: backoff - (now - attempt.lastAt) };
    }
    return { run: true, skipEntries: false };
  }

  recordAttempt(todayKey: string, now: number): void {
    const a = this.state.attempts[todayKey] ?? { count: 0, firstAt: now, lastAt: now };
    a.count++;
    a.lastAt = now;
    this.state.attempts[todayKey] = a;
    this.save();
  }

  markSuccess(todayKey: string): void {
    this.state.lastSuccessDate = todayKey;
    delete this.state.attempts[todayKey];
    this.save();
  }

  markTerminal(todayKey: string, reason: string, now: number): void {
    const a = this.state.attempts[todayKey] ?? { count: 1, firstAt: now, lastAt: now };
    a.terminal = true;
    a.terminalReason = reason;
    a.lastAt = now;
    this.state.attempts[todayKey] = a;
    this.save();
  }

  getAttempt(todayKey: string): MeanRevRetryAttempt | undefined {
    return this.state.attempts[todayKey];
  }

  getLastSuccessDate(): string | undefined {
    return this.state.lastSuccessDate;
  }
}

// ── Contracts ────────────────────────────────────────────────────────────

/** Open position as reported by the adapter; entryTime feeds the time stop. */
export type MeanRevPosition = CurrentPosition & { entryTime?: number };

export interface MeanRevBrokerAdapter {
  getOpenPositions(): Promise<MeanRevPosition[]>;
  /** `stopLossPct` (optional): engine-computed vol-scaled hard-stop distance
   *  in percent units (volStop config) — the adapter persists the stop PRICE
   *  derived from the fill; absent → legacy profile fixed distance. */
  openPosition(action: { symbol: string; side: "buy" | "sell"; notionalUsd: number; stopLossPct?: number }): Promise<{ ok: boolean; reason?: string }>;
  closePosition(action: { symbol: string; side: "buy" | "sell" }): Promise<{ ok: boolean; reason?: string }>;
  fetchCandles(symbol: string, bars: number): Promise<OHLCV[]>;
  /** Live sleeve equity in USD — RiskGuard's input. MUST be the sleeve's own
   *  ledger (initial allocation + this sleeve's realized/unrealized only),
   *  NEVER the shared Alpaca account total (momentum_stocks and
   *  meanrev_stocks share one wallet — see AGENTS.md "Shared Alpaca
   *  wallet"). AlpacaMomentumAdapter.getEquity() already computes this per
   *  accountId via computeSleeveLedger; index.ts wires it the same way for
   *  both sleeves. */
  getEquity(): Promise<number>;
  /** Realised PnL since the previous call — feeds RiskGuard's loss-streak
   *  counter via recordRebalanceOutcome, one "period" = one daily pass. */
  getRealisedPnlSince(epochMs: number): Promise<number>;
}

export interface MeanRevLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface MeanRevEngineConfig {
  universe: string[];
  /** DB account whose rows are authoritative for entry idempotency. */
  accountId: string;
  /** Fixed base notional in USD — slot = baseUsd × slotPct. No equity feedback. */
  baseUsd: number;
  slotPct: number;
  maxPositions: number;
  entryRsi: number;
  smaLong: number;
  smaExit: number;
  /** Time stop in TRADING days (counted as completed daily bars since entry). */
  timeStopDays: number;
  historyBars: number;
  /**
   * RSI(2) smoothing method for entry ranking (audited 2026-09, OPT-IN).
   * "cutler" (default when undefined) is the CURRENT/legacy 2-bar SIMPLE
   * average (see rsi2's docstring) — it ties to EXACTLY 0 for any pair of
   * down closes, so most candidates tie and the sort below resolves ties
   * by MEANREV_UNIVERSE iteration order (see deterministicTieBreak).
   * "wilder" uses rsi2Wilder — TA-Lib's actual Wilder recursive smoothing,
   * i.e. what "Connors RSI(2)" is normally understood to mean — which
   * produces a continuous ranking that rarely ties exactly. Undefined =
   * "cutler" = byte-identical to pre-existing behavior.
   */
  rsiMethod?: "cutler" | "wilder";
  /**
   * Break entry-ranking ties deterministically (audited 2026-09, OPT-IN).
   * false/undefined (default) = CURRENT behavior: `cands.sort` is a STABLE
   * sort on rsi alone, so candidates tied on rsi (all too common under
   * rsiMethod="cutler") resolve by MEANREV_UNIVERSE iteration order — an
   * incidental, order-dependent tie-break with no strategy justification.
   * true = break ties by (rsi asc, 2-day return closes[i]/closes[i-2]-1
   * asc, symbol asc), making the chosen candidate SET invariant to universe
   * ordering. Undefined/false = byte-identical to pre-existing behavior.
   */
  deterministicTieBreak?: boolean;
  /**
   * Optional per-symbol ENTRY-eligibility hook (research replays only,
   * 2026-10-02 — point-in-time index universes): a symbol for which
   * `entryEligibility(symbol, nowMs)` returns false is (a) skipped as an
   * ENTRY candidate and (b) EXEMPT from the all-universe entry-freshness
   * gate — it cannot be entered anyway, so its stale/short/delisted series
   * must not block the day's entries for every other symbol (with ~500 PIT
   * members a single dead series would otherwise freeze entries forever).
   * Exits are NEVER touched: a held symbol keeps SMA_EXIT/TIME_STOP
   * regardless of eligibility, same entries-only philosophy as RiskGuard.
   * Undefined = byte-identical legacy behavior (enforced by
   * MeanRevEngine.entryEligibility.test.ts). No live sleeve sets this;
   * only scripts/meanrev-replay.ts (membership mode) does.
   */
  entryEligibility?: (symbol: string, nowMs: number) => boolean;
  /** Optional ops-watchdog loop name; registered on construction, beaten at the
   *  end of each successful runDaily(). Undefined = no heartbeat (tests/backtests). */
  heartbeatName?: string;
  /** RiskGuard portfolio-breaker config. Partial merges over DEFAULT_RISK_CONFIG
   *  (same as MomentumEngine). See the "portfolio risk gate" comment in
   *  runDaily for which defaults were kept as-is and why. */
  risk: Partial<RiskGuardConfig>;
  /**
   * Aggregate gross-exposure BACKSTOP, as a multiple of baseUsd (e.g. 0.5 =
   * live positions' combined notional may never exceed 0.5× baseUsd). NOT
   * the primary sizing control — slotPct × maxPositions already bounds the
   * count-driven max by construction (slots = maxPositions − held.size).
   * This catches a slotPct-only config bump that raises exposure without
   * anyone touching maxPositions. Mirrors MomentumEngine.maxGrossExposureMult
   * — see its docstring. Undefined = OFF (current behavior).
   */
  maxGrossExposureMult?: number;
  /**
   * Optional vol-scaled HARD-stop distance, computed ONCE at entry from the
   * decision closes (trailPctFromVol on DAILY bars, barsPerDay=1) and passed
   * to the adapter as `openPosition.stopLossPct` → persisted stop PRICE on
   * the row → honored by AccountManager's loop and the broker-native stop.
   * Undefined = OFF (profile fixed 4%, previous behavior). Same evidence/
   * override provenance as MomentumEngine.volStop (see its docstring):
   * meanrev artifact 9dcd9781 — vol-k3 +42.33%/Sharpe 0.725/DD 12.58% vs
   * fixed-4 +30.09%/0.561/9.13%; owner accepted the ~+3.5pp DD 2026-08-28.
   */
  volStop?: TrailStopConfig;
  /**
   * Optional %ADV capacity check on NEW entries — the SAME shape and
   * semantics as MomentumEngine.capacityGuard (see its docstring): ADV$
   * from the last `lookbackBars` DAILY bars (this engine's candles are
   * daily by construction, barsPerDay=1); "observe" warns + telemetry,
   * "enforce" vetoes like the gross-exposure cap. Unusable volume history
   * fails OPEN with a log. Undefined = OFF (byte-identical; the replay
   * never sets it).
   */
  capacityGuard?: CapacityGuardConfig;
}

/** Disjoint from the momentum_stocks universe by design (shared Alpaca wallet). */
export const MEANREV_UNIVERSE = [
  "ABBV", "AVGO", "BAC", "CAT", "COST", "CVX", "DIS", "GE", "HD", "HON",
  "JNJ", "JPM", "KO", "LLY", "MA", "MCD", "MRK", "NFLX", "NKE", "ORCL",
  "PG", "QCOM", "UNH", "V", "WMT", "XLE", "XLF", "XLI", "XLP", "XLV",
  "XOM", "SLV",
];

export const DEFAULT_MEANREV_CONFIG: MeanRevEngineConfig = {
  universe: MEANREV_UNIVERSE,
  accountId: "meanrev_stocks",
  baseUsd: 50_000,
  // 0.10 → 0.12 on 2026-09-28 (director decision, owner asked for more ROI):
  // pure chains on the adjustment=all research DB (to 2026-09-25) —
  // experiments/meanrev-slot12-pure-v1.json (624d50e9…) +64.3% / Sharpe 0.70
  // / DD 17.6% / PSR 0.968 vs the 7×0.10 control re-run on the same data
  // (meanrev-slot10-pure-v2, 1616523e…) +50.4% / 0.68 / 15.0% / 0.964; same
  // two gates failed as the control; 0.14 (c6a848ea…) broke the declared 20%
  // DD cap (22.2%). Declared miss: the pre-registered per-fold rule ("no fold
  // worse than control × 0.9") fails on fold 4 by 0.1pp (−0.3% vs −0.2%) —
  // that rule cannot hold on a losing fold for ANY size increase (losses scale
  // with size), so it was mis-specified for a size axis; the other five folds
  // improve. Alpaca-account view (50/50 with momentum_stocks' daily chain):
  // CAGR 15.4% → 16.2%, Sharpe 1.21 → 1.22, maxDD 17.2% → 17.7%. Cap 0.84× of
  // the $50k base + momentum_stocks 1.0× of ~$54k ≈ $96k < ~$108k equity — no
  // margin. Reversion criterion: back to 0.10 if realized sleeve DD over the
  // next 60 trading days exceeds 17%.
  slotPct: 0.12,
  // 5 → 7 on 2026-09-24 (director decision, owner-delegated): pure OOS chain
  // of breadth-7x10 (experiments/meanrev-breadth7-pure-v1.json, artifact
  // 9bfaa6a9…; rerun 2026-09-25 on the gap-stop-fixed replay, 03382972…:
  // +57.5% / 0.76 / DD 14.5%, 13/14 gates) +57.9% / Sharpe 0.77 / DD 14.2% vs the live 5x10's own pure
  // chain (01d92c2a…) +39.9% / 0.69 / 12.7% — better on every absolute metric
  // and on return per unit of exposure, same 12/14 gates (the two failures by
  // <0.01 Sharpe / <0.1 bps). Inner evidence is mixed (control 10/18 inner
  // folds vs 6/18), declared. Capital check: 0.7× of $50k + momentum_stocks
  // 1.0× of ~$55k ≈ $90k < ~$110k account equity — no margin. Reversion
  // criterion (pre-registered): back to 5 if realized sleeve DD over the next
  // 60 trading days exceeds 15%, or live win rate < 55% over ≥ 40 closes.
  maxPositions: 7,
  entryRsi: 5,
  smaLong: 200,
  smaExit: 5,
  timeStopDays: 10,
  historyBars: 210,
  risk: {},
};

export type MeanRevPassStatus =
  | "ok"
  | "incomplete_data"
  | "action_failure"
  | "terminal_action_failure"
  | "entries_skipped";

export interface MeanRevReport {
  timestamp: number;
  status: MeanRevPassStatus;
  closes: Array<{ symbol: string; reason: "SMA_EXIT" | "TIME_STOP"; ok: boolean; detail?: string; terminal?: boolean }>;
  opens: Array<{ symbol: string; rsi: number; ok: boolean; detail?: string; terminal?: boolean }>;
  errors: string[];
  terminalReason?: string;
  /** Set when RiskGuard (or the maintenance kill-switch) blocked NEW entries
   *  this pass. Mirrors MomentumEngine's RebalanceReport.blockedReason. Exits
   *  above are unaffected — this only ever describes why opens were skipped. */
  blockedReason?: string;
}

// ── Engine ───────────────────────────────────────────────────────────────────

/** Injectable dependencies (all defaulted to production implementations).
 *  `alreadyEnteredToday` is the entry-idempotency probe — live it queries the
 *  trades table (durable once-per-symbol/day barrier, see the ENTRIES section);
 *  the walk-forward replay (scripts/meanrev-replay.ts) injects `() => false`
 *  because its sim book IS the ledger and no data/trading.db exists there.
 *  This seam exists so the replay can execute THIS engine instead of
 *  duplicating its loop (backtest-live parity). */
export interface MeanRevEngineDeps {
  isTradingDay: (dateKey: string) => boolean;
  now: () => number;
  alreadyEnteredToday: (accountId: string, symbol: string, dayStartMs: number, dayEndMs: number) => boolean;
}

/** Production default: durable once-per-symbol/day barrier on the trades table
 *  (broker positions can lag a just-filled order; the DB row cannot). */
function dbAlreadyEnteredToday(accountId: string, symbol: string, dayStartMs: number, dayEndMs: number): boolean {
  return getDB().prepare(
    `SELECT 1 FROM trades
     WHERE account_id = ? AND symbol = ?
       AND (status = 'open' OR (entry_time >= ? AND entry_time < ?))
     LIMIT 1`,
  ).get(accountId, symbol, dayStartMs, dayEndMs) !== null;
}

export class MeanRevEngine {
  private cfg: MeanRevEngineConfig;
  private deps: MeanRevEngineDeps;
  private riskState: RiskState = { ...INITIAL_RISK_STATE };
  /** Timestamp of the last VALID risk read (equity AND realised-pnl both
   *  readable), independent of whether the REST of that pass (exits/entries)
   *  went on to succeed. Deliberately NOT the same thing as "last fully
   *  successful daily pass": a retried pass (incomplete_data/action_failure,
   *  see index.ts's scheduleDailyStockRun) must still advance this the
   *  moment its P&L read is incorporated, or every retry re-reads the SAME
   *  already-recorded interval and double/triple-counts one closed loss into
   *  RiskGuard's consecutive-loss streak (bug fixed 2026-09-24 — see
   *  MeanRevEngine.riskAnchor.test.ts). 0 = no prior period to compute
   *  realised pnl for. */
  private lastRiskReadAt = 0;

  constructor(
    cfg: Partial<MeanRevEngineConfig>,
    private broker: MeanRevBrokerAdapter,
    private log: MeanRevLogger,
    deps?: Partial<MeanRevEngineDeps>,
    /** Same MomentumStatePersistence contract the four momentum sleeves use
     *  (index.ts's fileStatePersistence) — reused verbatim, not a parallel
     *  format. trailMarks is always empty on save; ignored on load. */
    private state?: MomentumStatePersistence,
  ) {
    this.cfg = {
      ...DEFAULT_MEANREV_CONFIG,
      ...cfg,
      risk: { ...DEFAULT_RISK_CONFIG, ...DEFAULT_MEANREV_CONFIG.risk, ...(cfg.risk ?? {}) },
    };
    this.deps = {
      isTradingDay: deps?.isTradingDay ?? isTradingDay,
      now: deps?.now ?? Date.now, // clock-ok: seam default — replays inject deps.now
      alreadyEnteredToday: deps?.alreadyEnteredToday ?? dbAlreadyEnteredToday,
    };
    if (this.state) {
      const loaded = this.state.load();
      if (loaded) {
        this.riskState = loaded.risk;
        this.lastRiskReadAt = validRiskAnchor(loaded.riskAnchorAt, this.deps.now());
      }
    }
    // Daily cadence; grace 5 (~5 days) tolerates a 3-day holiday weekend
    // (Fri→Tue ≈ 96h) plus jitter without false-paging. A genuinely dead
    // daily loop still pages within ~5 days.
    if (this.cfg.heartbeatName) heartbeats.register(this.cfg.heartbeatName, 86_400_000, { graceMultiplier: 5 });
  }

  /** One daily pass: exits first (free the slots), then ranked entries.
   *  Returns a status report; the scheduler decides whether to retry. */
  async runDaily(opts?: { skipEntries?: boolean }): Promise<MeanRevReport> {
    const now = this.deps.now();
    const todayKey = getETDateKey(now);
    const report: MeanRevReport = { timestamp: now, status: "ok", closes: [], opens: [], errors: [] };

    // Non-trading day (weekend/holiday) = no completed daily bar expected. Skip
    // cleanly so the scheduler does not retry forever and the heartbeat stays alive.
    if (!this.deps.isTradingDay(todayKey)) {
      this.log.info(`meanrev: ${todayKey} is not a trading day — skipping`);
      if (this.cfg.heartbeatName) heartbeats.beat(this.cfg.heartbeatName);
      return report;
    }

    // ── Portfolio risk gate (RiskGuard, shared with MomentumEngine) ─────────
    // Read equity + last period's realised pnl HERE, before exits/candles —
    // same order MomentumEngine.tick() uses. Nothing below this block is
    // gated on the result: exits always run regardless of what this finds;
    // only the ENTRIES section (near the bottom) branches on `canOpen`.
    const { equity, valid: equityValid, error: equityError } = await this.readEquity();
    if (!equityValid) {
      this.log.error(`MeanRev daily pass: equity unavailable (${equityError}) — RiskGuard frozen, opens blocked; exits still run`);
    }

    let realised = 0;
    let realisedValid = true;
    if (this.lastRiskReadAt > 0) {
      // Same failure class whether it throws or returns non-finite: either
      // way a fabricated 0 would silently hide/reset a real loss streak.
      let failure: string | undefined;
      try {
        realised = await this.broker.getRealisedPnlSince(this.lastRiskReadAt);
        if (!Number.isFinite(realised)) failure = `returned non-finite ${realised}`;
      } catch (e: any) {
        failure = e?.message ?? String(e);
      }
      if (failure !== undefined) {
        realisedValid = false;
        realised = 0;
        this.log.error(`MeanRev daily pass: getRealisedPnlSince failed (${failure}) — loss-streak breaker frozen this pass; opens blocked, anchor NOT advanced`);
      }
    }
    // Record the PREVIOUS period's outcome before evaluating today's risk —
    // skipped whenever either read is invalid, so an unknown value never
    // mutates/persists RiskGuard state (mirrors MomentumEngine.runTick).
    // The anchor advances in the same step and both reach disk in one
    // envelope: a restart resumes where the recorded streak ends. (Until
    // 2026-10-03 the anchor lived in memory only, so a restart between two
    // daily passes — most deploys — dropped a whole day from the streak.)
    // Advance the anchor as soon as THIS period's P&L has been incorporated
    // — deliberately BEFORE exits/entries run, and regardless of whether
    // they go on to fail. index.ts retries an incomplete_data/action_failure
    // pass up to maxDataRetries times, same day, minutes apart; if the
    // anchor only advanced at the bottom of a FULLY successful pass (the
    // pre-2026-09-24 behavior), every retry would re-read the realised P&L
    // "since" the SAME stale anchor and re-record the SAME already-
    // incorporated loss into RiskGuard's consecutive-loss streak — up to
    // maxDataRetries+1 recordings of one closed trade, which can spuriously
    // reach the 5-loss pause threshold. A later retry the same day now reads
    // "since lastRiskReadAt" (this call), so an interval with no NEW closed
    // trade correctly nets to ~0 (recordRebalanceOutcome leaves a 0 P&L
    // streak unchanged).
    if (equityValid && realisedValid) {
      if (this.lastRiskReadAt > 0) this.riskState = recordRebalanceOutcome(this.riskState, realised);
      this.lastRiskReadAt = now;
      this.persistState();
    }

    const expectedDataKey = getPreviousTradingDay(todayKey);

    // Load broker truth FIRST — an unrelated candidate's bad data must never
    // block exits for symbols we already hold (see completeness gate below).
    const positions = (await this.broker.getOpenPositions()).filter((p) => p.side === "buy");
    const held = new Set(positions.map((p) => p.symbol));

    // Fetch daily candles for the universe; DROP today's partial bar — when
    // running intraday, Alpaca "1Day" returns today's in-progress bar last,
    // and signals must be computed on the last COMPLETED bar.
    const candles = new Map<string, OHLCV[]>();
    const lastBarKey = new Map<string, string>(); // symbol → ET date of its last (completed) bar
    await Promise.all(
      this.cfg.universe.map(async (sym) => {
        try {
          let c = await this.broker.fetchCandles(sym, this.cfg.historyBars);
          if (c.length > 0 && getETDateKey(c[c.length - 1].timestamp) === todayKey) c = c.slice(0, -1);
          if (c.length > 0) lastBarKey.set(sym, getETDateKey(c[c.length - 1].timestamp));
          if (c.length >= this.cfg.smaLong + 1) candles.set(sym, c);
        } catch (e: any) {
          report.errors.push(`fetchCandles ${sym}: ${e?.message ?? e}`);
        }
      }),
    );

    // Completeness gate for ENTRIES: every symbol must have a completed daily
    // bar at least as recent as the previous trading day. Exits are processed
    // FIRST below; the rejection for a blocked entry day is returned after exits.
    const isFresh = (sym: string) => {
      const k = lastBarKey.get(sym);
      return candles.has(sym) && k !== undefined && k >= expectedDataKey;
    };
    // PIT entry-eligibility (cfg.entryEligibility, opt-in — see docstring):
    // an ineligible symbol can't be entered, so it is exempt from the
    // freshness gate and skipped as a candidate below. Absent hook = both
    // expressions reduce to the exact legacy forms.
    const isEntryEligible = (sym: string) => !this.cfg.entryEligibility || this.cfg.entryEligibility(sym, now);
    const entriesReady = this.cfg.universe.every((s) => isFresh(s) || !isEntryEligible(s));

    // EXITS — yesterday's close > SMA(5), or the trading-day time stop.
    for (const p of positions) {
      // Entered TODAY (ET): never evaluate the exit on the SAME completed bar
      // that admitted the entry. The bar that fires RSI2<5 (two down closes
      // after a jump) can simultaneously satisfy close > SMA(5), so a same-day
      // retry pass (index.ts re-runs an incomplete_data/action_failure day
      // minutes later) would sell what the first pass just bought — QCOM
      // 2026-09-25 13:36→13:41, JPM 2026-08-17 13:39→13:44. The backtest and
      // scripts/meanrev-replay.ts only ever evaluate exits for positions
      // opened BEFORE today's entries; parity = defer this position's exit to
      // the next daily pass, on the next completed bar.
      if (p.entryTime && getETDateKey(p.entryTime) === todayKey) {
        this.log.info(`meanrev: ${p.symbol} entered today (${todayKey}) — exit evaluation deferred to the next daily pass`);
        continue;
      }
      if (!isFresh(p.symbol)) {
        this.log.warn(`meanrev: no fresh data for held ${p.symbol} — holding conservatively`);
        continue;
      }
      const c = candles.get(p.symbol);
      const closes = c?.map((b) => b.close) ?? [];
      const i = closes.length - 1;

      let reason: "SMA_EXIT" | "TIME_STOP" | null = null;
      if (i >= this.cfg.smaExit - 1 && closes[i] > sma(closes, i, this.cfg.smaExit)) {
        reason = "SMA_EXIT";
      } else if (p.entryTime) {
        // Held sessions = entry day + completed bars dated after it. Matches
        // the backtest's (di − entryDay) ≥ N: fires on the morning of the
        // Nth trading day after entry.
        const entryKey = getETDateKey(p.entryTime);
        const barsAfter = (c ?? []).filter((b) => getETDateKey(b.timestamp) > entryKey).length;
        if (barsAfter + 1 >= this.cfg.timeStopDays) reason = "TIME_STOP";
      }
      if (!reason) continue;

      try {
        const res = await this.broker.closePosition({ symbol: p.symbol, side: "buy" });
        const terminal = isTerminalActionFailure(res.reason);
        report.closes.push({ symbol: p.symbol, reason, ok: res.ok, detail: res.reason, terminal });
        if (res.ok) {
          held.delete(p.symbol);
          if (this.cfg.heartbeatName) sleeveOutput.recordClose(this.cfg.heartbeatName);
        } else this.log.warn(`meanrev close ${p.symbol} (${reason}) failed: ${res.reason}`);
        if (terminal) report.terminalReason = res.reason;
      } catch (e: any) {
        const detail = e?.message ?? String(e);
        const terminal = isTerminalActionFailure(detail);
        report.closes.push({ symbol: p.symbol, reason, ok: false, detail, terminal });
        this.log.error(`meanrev close ${p.symbol} threw: ${e?.message ?? e}`);
        if (terminal) report.terminalReason = detail;
      }
    }

    // Portfolio risk gate — evaluated HERE, right before ENTRIES, never
    // before the exits above (they must run unconditionally even paused).
    // Skipped (fail-closed) when equity is invalid, same as MomentumEngine.
    let canOpen: boolean;
    let riskBlockedReason: string | undefined;
    if (equityValid) {
      const riskCheck = evaluateRisk(this.riskState, equity, now, this.cfg.risk as RiskGuardConfig);
      this.emitPauseTransition(this.riskState, now, riskCheck); // BEFORE overwrite — needs the pre-call state
      this.riskState = riskCheck.state;
      this.persistState();
      canOpen = riskCheck.canOpen;
      riskBlockedReason = riskCheck.reason;
    } else {
      canOpen = false;
      riskBlockedReason = `equity unavailable: ${equityError}`;
    }
    if (!realisedValid && canOpen) {
      canOpen = false;
      riskBlockedReason = "realised-pnl read failed: loss-streak breaker frozen";
    }

    // ENTRIES — RSI(2) < entryRsi AND close > SMA(200), ranked by lowest RSI.
    // Gated on entriesReady: incomplete/stale universe data skips new entries
    // for the day without touching the exits already processed above.
    const slots = this.cfg.maxPositions - held.size;
    if (!isTradingEnabled()) {
      // Maintenance kill-switch (TRADING_ENABLED=false, src/config/index.ts):
      // the exits above already ran; skip entries WITHOUT touching
      // report.status, so the scheduler records a normal successful day — no
      // retry loop, no "FAILED after retries" page for entries this host
      // must not place while the switch is off.
      this.log.info("meanrev: TRADING_ENABLED=false (maintenance kill-switch) — entries skipped, exits processed");
    } else if (!canOpen) {
      report.blockedReason = riskBlockedReason;
      this.log.warn(`MeanRev new entries BLOCKED: ${riskBlockedReason}`);
    } else if (!opts?.skipEntries && slots > 0) {
      if (entriesReady) {
        // rsiMethod OPT-IN (default "cutler" = pre-existing rsi2, byte-
        // identical): see MeanRevEngineConfig.rsiMethod's docstring.
        const rsiFn = this.cfg.rsiMethod === "wilder" ? rsi2Wilder : rsi2;
        const cands: Array<{ symbol: string; rsi: number; ret2d: number }> = [];
        for (const symbol of this.cfg.universe) {
          if (held.has(symbol)) continue;
          if (!isEntryEligible(symbol)) continue; // PIT hook: never a NEW entry
          const c = candles.get(symbol);
          if (!c || c.length < this.cfg.smaLong + 1) continue; // warmup (matches backtest iPrev >= 200)
          const closes = c.map((b) => b.close);
          const i = closes.length - 1;
          const r = rsiFn(closes, i);
          if (r < this.cfg.entryRsi && closes[i] > sma(closes, i, this.cfg.smaLong)) {
            cands.push({ symbol, rsi: r, ret2d: closes[i] / closes[i - 2] - 1 });
          }
        }
        // deterministicTieBreak OPT-IN (default false = pre-existing stable
        // sort on rsi alone, byte-identical): see its docstring.
        if (this.cfg.deterministicTieBreak) {
          cands.sort((a, b) => a.rsi - b.rsi || a.ret2d - b.ret2d || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
        } else {
          cands.sort((a, b) => a.rsi - b.rsi);
        }
        const [dayStart, dayEnd] = getETDayBounds(todayKey);
        // Gross-exposure guard bookkeeping (see maxGrossExposureMult
        // docstring): local running total seeded from the positions STILL
        // held after the exits above, updated in lockstep as opens execute
        // below. Seeding from the pre-exit snapshot counted what this pass
        // had just sold: 2026-10-05 KO was blocked at "live $40984" right
        // after QCOM and ABBV closed, and only entered on the retry pass.
        let liveGrossNotional = positions
          .filter((p) => held.has(p.symbol))
          .reduce((s, p) => s + Math.abs(p.notional), 0);
        let attempted = 0;
        for (const cand of cands) {
          if (attempted >= slots) break;
          // Broker positions can lag a just-filled order. The engine's own DB
          // row cannot be allowed to lag that same fill, so use it as the
          // durable once-per-symbol/day barrier before every submission
          // (injectable seam — see MeanRevEngineDeps).
          if (this.deps.alreadyEnteredToday(this.cfg.accountId, cand.symbol, dayStart, dayEnd)) continue;
          attempted++;
          const notionalUsd = this.cfg.baseUsd * this.cfg.slotPct;
          if (this.cfg.maxGrossExposureMult !== undefined) {
            const cap = this.cfg.baseUsd * this.cfg.maxGrossExposureMult;
            if (liveGrossNotional + notionalUsd > cap) {
              const reason = `gross exposure cap: live $${liveGrossNotional.toFixed(0)} + new $${notionalUsd.toFixed(0)} would exceed ${this.cfg.maxGrossExposureMult}× baseUsd ($${cap.toFixed(0)} on $${this.cfg.baseUsd.toFixed(0)} baseUsd)`;
              this.log.warn(`meanrev open ${cand.symbol} BLOCKED by ${reason}`);
              report.opens.push({ symbol: cand.symbol, rsi: cand.rsi, ok: false, detail: reason });
              // Policy veto, never reached the broker — see sleeveOutput's
              // isPolicyPreventedReason docstring (B-ops-alerts.md #4).
              if (this.cfg.heartbeatName) sleeveOutput.recordPreventedByPolicy(this.cfg.heartbeatName, reason);
              continue;
            }
          }
          // %ADV capacity check (capacityGuard docstring): observe warns,
          // enforce vetoes; uncomputable ADV$ fails OPEN with a log.
          if (this.cfg.capacityGuard) {
            const cg = this.cfg.capacityGuard;
            const adv = averageDailyDollarVolume(candles.get(cand.symbol) ?? [], cg.lookbackBars, 1);
            if (adv === null) {
              this.log.warn(`capacity guard ${cand.symbol}: ADV$ not computable (short/missing volume history) — fail-open, entry allowed`);
            } else if (notionalUsd > adv * (cg.maxAdvPct / 100)) {
              const reason = `capacity guard: entry $${notionalUsd.toFixed(0)} > ${cg.maxAdvPct}% of ADV$ $${adv.toFixed(0)} (${cg.lookbackBars}d)`;
              if (cg.mode === "enforce") {
                this.log.warn(`meanrev open ${cand.symbol} BLOCKED by ${reason}`);
                report.opens.push({ symbol: cand.symbol, rsi: cand.rsi, ok: false, detail: reason });
                // Policy veto, never reached the broker — same accounting as
                // the gross-exposure cap above.
                if (this.cfg.heartbeatName) sleeveOutput.recordPreventedByPolicy(this.cfg.heartbeatName, reason);
                continue;
              }
              this.log.warn(`meanrev open ${cand.symbol} ${reason} — observe mode, entry proceeds`);
              if (this.cfg.heartbeatName) sleeveOutput.recordCapacityObservation(this.cfg.heartbeatName, reason);
            }
          }
          try {
            // Vol-scaled hard stop (volStop docstring): daily closes, so
            // barsPerDay=1 by construction; fails open to maxPct inside
            // trailPctFromVol on short/degenerate history.
            const stopLossPct = this.cfg.volStop
              ? trailPctFromVol((candles.get(cand.symbol) ?? []).map((b) => b.close), this.cfg.volStop, 1)
              : undefined;
            const res = await this.broker.openPosition({
              symbol: cand.symbol,
              side: "buy",
              notionalUsd,
              ...(stopLossPct !== undefined ? { stopLossPct } : {}),
            });
            const terminal = isTerminalActionFailure(res.reason);
            report.opens.push({ symbol: cand.symbol, rsi: cand.rsi, ok: res.ok, detail: res.reason, terminal });
            if (res.ok) liveGrossNotional += notionalUsd;
            if (this.cfg.heartbeatName) {
              if (res.ok) sleeveOutput.recordOpenSuccess(this.cfg.heartbeatName);
              // A RiskEngine deny / maintenance kill-switch is sound risk
              // management working, not a broken open path — see
              // isPolicyPreventedReason (B-ops-alerts.md #4).
              else if (isPolicyPreventedReason(res.reason)) sleeveOutput.recordPreventedByPolicy(this.cfg.heartbeatName, res.reason);
              else sleeveOutput.recordOpenFailure(this.cfg.heartbeatName, res.reason);
            }
            if (!res.ok) this.log.warn(`meanrev open ${cand.symbol} failed: ${res.reason}`);
            if (terminal) report.terminalReason = res.reason;
          } catch (e: any) {
            const detail = e?.message ?? String(e);
            const terminal = isTerminalActionFailure(detail);
            report.opens.push({ symbol: cand.symbol, rsi: cand.rsi, ok: false, detail, terminal });
            if (this.cfg.heartbeatName) sleeveOutput.recordOpenFailure(this.cfg.heartbeatName, detail);
            this.log.error(`meanrev open ${cand.symbol} threw: ${e?.message ?? e}`);
            if (terminal) report.terminalReason = detail;
          }
        }
      } else {
        const bad = this.cfg.universe.filter((s) => !isFresh(s) && isEntryEligible(s));
        const msg =
          `incomplete/stale daily data: expected ${expectedDataKey}, ` +
          `${this.cfg.universe.length - bad.length}/${this.cfg.universe.length} fresh; ` +
          `missing/stale: ${bad.map((s) => `${s}=${lastBarKey.get(s) ?? "none"}`).join(",")}`;
        report.errors.push(msg);
        report.status = "incomplete_data";
        return report;
      }
    }

    // Output-liveness tick (src/ops/sleeveOutput.ts) — recorded AFTER the
    // opens/closes above so a pass that produced output resets the silence
    // counter before the check runs. Non-trading days return early above
    // (a weekend is not a missed chance to act); the incomplete_data early
    // return skips this too — that failure class already pages via
    // MeanRevRetry's "FAILED after retries" burst.
    if (this.cfg.heartbeatName) sleeveOutput.recordTick(this.cfg.heartbeatName);

    // Resolve pass status from collected open/close results.
    const terminalClose = report.closes.find((c) => c.terminal);
    const terminalOpen = report.opens.find((o) => o.terminal);
    if (terminalClose || terminalOpen) {
      report.status = "terminal_action_failure";
      report.terminalReason = report.terminalReason ?? "terminal action failure";
      return report;
    }

    const failedCloses = report.closes.filter((c) => !c.ok).length;
    const failedOpens = report.opens.filter((o) => !o.ok).length;
    if (failedCloses > 0 || failedOpens > 0) {
      report.status = "action_failure";
      return report;
    }

    if (opts?.skipEntries) {
      report.status = "entries_skipped";
    }

    this.log.info(
      `MeanRev daily pass: ${report.closes.length} close, ${report.opens.length} open, ` +
        `${held.size} held, ${report.errors.length} errors`,
    );

    if (this.cfg.heartbeatName) heartbeats.beat(this.cfg.heartbeatName);
    return report;
  }

  /**
   * Fetch sleeve equity, validating it's a usable number. Never throws —
   * callers branch on `valid`, so a broken equity feed degrades the pass
   * (RiskGuard frozen, opens blocked) rather than aborting it outright
   * (exits above already ran best-effort regardless).
   */
  private async readEquity(): Promise<{ equity: number; valid: boolean; error?: string }> {
    let raw: number;
    try {
      raw = await this.broker.getEquity();
    } catch (e: any) {
      return { equity: 0, valid: false, error: e?.message ?? String(e) };
    }
    if (!Number.isFinite(raw) || raw <= 0) {
      return { equity: Number.isFinite(raw) ? raw : 0, valid: false, error: `invalid equity ${raw}` };
    }
    return { equity: raw, valid: true };
  }

  /** Same v1 envelope MomentumEngine persists ({ v: 1, risk, trailMarks }) —
   *  trailMarks is always empty here (meanrev has no trailing-stop). */
  private persistState(): void {
    if (this.state) this.state.save({ v: 1, risk: this.riskState, trailMarks: {}, ...(this.lastRiskReadAt > 0 ? { riskAnchorAt: this.lastRiskReadAt } : {}) });
  }

  /** Same contract as MomentumEngine.emitPauseTransition (B-ops-alerts.md
   *  #1): fires EVENTS.CIRCUIT_BREAKER exactly on a pause state CHANGE,
   *  never per daily pass while already/still paused. `prevState` must be
   *  `this.riskState` captured BEFORE evaluateRisk's call overwrites it.
   *  Hard-drawdown also pages ops via a SEPARATE ERROR_BURST — never inline
   *  here, telegram-reporter's CIRCUIT_BREAKER handler stays user-chat-only
   *  by contract (see alerts.test.ts). No-op without a heartbeatName. */
  private emitPauseTransition(prevState: RiskState, now: number, riskCheck: RiskAssessment): void {
    const sleeve = this.cfg.heartbeatName;
    if (!sleeve) return;
    const t = detectPauseTransition(prevState, riskCheck);
    if (!t) return;
    if (t.kind === "pause_started") {
      eventBus.emit(EVENTS.CIRCUIT_BREAKER, { sleeve, profileId: sleeve, action: "pause_started", reason: t.reason, resumeAt: t.pausedUntil });
      if (t.breach === "hard_drawdown") {
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "RiskGuard.hardDrawdown",
          message: `[${sleeve}] hard-drawdown pause: ${t.reason}`,
          count: 1, windowMs: 0, firstAt: now, lastAt: now,
        });
      }
    } else {
      eventBus.emit(EVENTS.CIRCUIT_BREAKER, { sleeve, profileId: sleeve, action: "pause_resolved", reason: t.priorReason });
    }
  }

  getRiskState(): Readonly<RiskState> {
    return this.riskState;
  }
}
