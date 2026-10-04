// ══════════════════════════════════════════════
// Risk Guard (v7.0 — "Momentum Edge")
// ══════════════════════════════════════════════
//
// Portfolio-level circuit breakers. The previous system had per-trade
// stop-loss but no portfolio cap, which is why the bot drew down 66% in
// 18 days while every individual stop "worked". Drawdown control is the
// single most important risk discipline in momentum trading because the
// strategy by design rides trends — including the trends that turn into
// crashes.
//
// Rules (in priority order):
//   1. Hard daily loss cap (-3% of equity): pause new entries, keep
//      managing existing positions, resume next UTC day.
//   2. Soft drawdown (-10% peak-to-trough): pause 24h.
//   3. Hard drawdown (-20% peak-to-trough): pause 7d, alert human.
//   4. Consecutive losing rebalances (5+): pause 24h regardless of
//      drawdown size — the model may be in a regime it doesn't fit.
//
// Existing positions are NEVER force-closed by RiskGuard — that's the
// per-position stop-loss's job. RiskGuard only stops NEW entries.
// This separation prevents the cascading-liquidation antipattern.

export interface RiskGuardConfig {
  dailyLossCapPct: number;        // -0.03 = -3%
  softDrawdownPct: number;        // -0.10
  hardDrawdownPct: number;        // -0.20
  consecutiveLossLimit: number;   // 5
  softPauseHours: number;         // 24
  hardPauseHours: number;         // 168 (7d)
  /**
   * Opt-in CONTINUOUS drawdown sizing (Grossman & Zhou 1993: exposure
   * proportional to the cushion over the drawdown floor), replacing the
   * BINARY soft-drawdown pause. When set, the soft-drawdown breaker is
   * IGNORED (it never arms a pause) and instead NEW entries are sized at
   *   scale = clamp(1 − (dd − startPct)/(endPct − startPct), minScale, 1)
   * exposed via RiskAssessment.entryScale on every open verdict. All other
   * protections stay INTACT: hard drawdown (20% pause), daily loss cap,
   * loss streak, and existing positions are never touched (entries-only,
   * same philosophy as the pauses). Rationale: the binary pause is
   * path-dependent on the sleeve's OWN equity — with a flat book the
   * drawdown only closes by peak decay (half-life 30d), so one 24h pause
   * re-arms into a multi-week lockout (47 pauses, p90 13d, max 34d in the
   * 2021-26 OOS). Undefined = OFF (byte-identical legacy behavior).
   */
  ddScale?: DrawdownScaleConfig;
  /**
   * Opt-in SHADOW-EQUITY RESUME for the soft-drawdown pause (2026-09-26;
   * absent = byte-identical legacy behavior). Motivation: the soft pause is
   * path-dependent on the sleeve's OWN equity — with a flat book the
   * drawdown only closes by peak decay (half-life 30d), so one 24h pause
   * re-arms into a multi-week lockout (47 pauses, p50 2d / p90 13d / max
   * 34d in the 2021-26 OOS; live: flat since ~2026-09-10). Unlike ddScale
   * (REFUTED 2026-09-25 — scaling entries in 2022 lost money the pause
   * avoided) this keeps the pause fully closed to entries; it only changes
   * WHEN it lifts: while soft-paused the ENGINE tracks a VIRTUAL equity of
   * the long book the TSM ranking would hold (same slot logic, no orders,
   * net of estimated costs — MomentumEngine.updateShadowResume), and the
   * pause lifts when the STRATEGY works again — virtual equity up
   * `recoverPct` from the pause-start anchor, or above the pre-pause peak —
   * instead of when the peak has decayed. On resume the drawdown reference
   * peak re-anchors to the CURRENT real equity so the old peak cannot
   * immediately re-arm the pause. Hard-DD (20%), daily loss cap and
   * loss-streak breakers are untouched; a hard/daily/streak pause is NEVER
   * lifted by this mechanism (soft-drawdown pauses only, matched by
   * reason). State (RiskState.shadowResume) exists only during a tracked
   * episode.
   */
  shadowResume?: ShadowResumeConfig;
  /**
   * Half-life (days) for the equity-peak decay. 0 = legacy all-time ratchet.
   * Without decay the soft-drawdown breaker is a PERMANENT lockout: once
   * equity sits >10% below its all-time peak, the 24h pause re-arms forever
   * (the engine can't trade, so the drawdown never closes). The 2024 crypto
   * walk-forward died on Jan 17 and missed a +100% year to this exact loop.
   */
  peakHalfLifeDays: number;
  /** Meaning of the equity value supplied to evaluateRisk. */
  equitySemantics?: EquitySemantics;
}

export interface ShadowResumeConfig {
  /** Virtual-equity gain FRACTION from the pause-start anchor that lifts the
   *  soft pause (e.g. 0.03 = +3%). Must be in (0, 1). */
  recoverPct: number;
  /** Estimated execution cost in bps PER SIDE charged on each virtual
   *  entry/exit's slot notional (default 9 = the replay's base
   *  slippage 5 + commission 4; the sleeve's measured live cost is ~7). */
  costBpsPerSide?: number;
}

/** Shadow-equity tracker persisted on RiskState DURING a soft-pause episode
 *  (see RiskGuardConfig.shadowResume). All three anchors are in the same
 *  monetary units as peakEquity, so rebase/chain scaling applies uniformly. */
export interface ShadowResumeTracker {
  /** Virtual equity of the would-be long book (starts = real equity at pause start). */
  equity: number;
  /** Virtual equity at the pause-start anchor (the +recoverPct base). */
  startEquity: number;
  /** Real peakEquity at pause start — the "new high" resume clause reference. */
  peakRef: number;
}

/** True when this pause reason is the SOFT-drawdown breaker's (the only
 *  pause class shadowResume may lift — hard/daily/streak stay untouched). */
export function isSoftDrawdownPauseReason(reason: string): boolean {
  return reason.startsWith("soft drawdown");
}

export interface DrawdownScaleConfig {
  /** Drawdown FRACTION where scaling starts (e.g. 0.05 = 5%): dd <= startPct → scale 1. */
  startPct: number;
  /** Drawdown FRACTION where the scale reaches minScale (e.g. 0.20). Must be > startPct. */
  endPct: number;
  /** Scale floor in [0, 1). Default 0 — entries fully off at dd >= endPct. */
  minScale?: number;
}

/**
 * Pure entry-sizing factor for a given drawdown fraction:
 * linear from 1 at `startPct` down to `minScale` at `endPct`, clamped to
 * [minScale, 1]. A degenerate config (endPct <= startPct) fails open to 1 —
 * misconfiguration must never freeze or zero entries.
 */
export function ddEntryScale(dd: number, cfg: DrawdownScaleConfig): number {
  const minScale = cfg.minScale ?? 0;
  const span = cfg.endPct - cfg.startPct;
  if (!(span > 0) || !Number.isFinite(dd)) return 1;
  const raw = 1 - (dd - cfg.startPct) / span;
  return Math.min(1, Math.max(minScale, raw));
}

export const EQUITY_SEMANTICS = {
  /** @deprecated era-3 (2026-07-16), USDT collateral only. Kept so old
   * persisted state is recognized (and re-anchored) by the migration path;
   * do not wire into new configs — use BINANCE_TOTAL_MARGIN. */
  BINANCE_USDT_MARGIN: "binance_usdt_margin_equity",
  /** era-4 (2026-07-18): Binance root `totalMarginBalance` (wallet+unrealized,
   * all collateral as valued by the broker). */
  BINANCE_TOTAL_MARGIN: "binance_total_margin_equity",
  SLEEVE_LEDGER: "sleeve_ledger_equity",
  /** momentum_crypto_usdc (2026-07-19): USDC asset-row marginBalance on the
   *  same FAPI account — own wallet, never binance_main's USDT total. */
  BINANCE_USDC_MARGIN: "binance_usdc_margin_equity",
  /** momentum_btc (2026-07-19): DAPI COIN-M wallet marginBalance converted
   *  to USD at mark (BinanceCoinMExecutor.getEquityUsd) — own wallet. */
  BINANCE_COINM_MARGIN: "binance_coinm_margin_equity",
} as const;
export type EquitySemantics = typeof EQUITY_SEMANTICS[keyof typeof EQUITY_SEMANTICS];

export const DEFAULT_RISK_CONFIG: RiskGuardConfig = {
  dailyLossCapPct: 0.03,
  softDrawdownPct: 0.10,
  hardDrawdownPct: 0.20,
  consecutiveLossLimit: 5,
  softPauseHours: 24,
  hardPauseHours: 168,
  peakHalfLifeDays: 30,
};

export type RiskBreach = "daily_cap" | "soft_drawdown" | "hard_drawdown" | "loss_streak" | null;

export interface RiskState {
  /** Explicit persisted schema. Missing = legacy state with unknown capital base. */
  stateVersion?: number;
  /** Capital basis used when this state was persisted. Enables safe allocation migrations. */
  equityBase?: number;
  /** All-time equity peak observed. */
  peakEquity: number;
  /** Equity at the start of the current UTC day. */
  dayStartEquity: number;
  /** Timestamp (ms) of the dayStartEquity capture. */
  dayStartedAt: number;
  /** Consecutive losing rebalances. Resets on a winning rebalance. */
  consecutiveLosses: number;
  /** Until when the engine is paused (epoch ms). 0 = not paused. */
  pausedUntil: number;
  /** Why we're paused, if we are. */
  pauseReason: string;
  /** Timestamp of the last evaluateRisk call — drives peak decay. */
  lastEvalAt: number;
  /** Explicit meaning of the persisted equity anchors. */
  equitySemantics?: EquitySemantics;
  /** Set by state migration until one valid observation can re-anchor safely. */
  pendingSemanticReanchor?: boolean;
  /** Shadow-equity resume tracker — present ONLY while a soft-drawdown pause
   *  episode is being tracked under cfg.shadowResume (see its docstring).
   *  Legacy states never carry it; absent = byte-identical behavior. */
  shadowResume?: ShadowResumeTracker;
  /** Model-version key of the engine config that persisted this state
   *  (MomentumEngineConfig.modelVersion). A persisted state from a DIFFERENT
   *  model arms pendingModelReanchor below so the new model does not inherit
   *  the old model's equity peak (and its soft-DD lockout). */
  modelVersion?: string;
  /** ONE-SHOT re-anchor at model cutover: on the first valid equity
   *  observation, peakEquity re-anchors to it, the loss streak restarts at 0,
   *  and an inherited soft-drawdown or loss-streak pause is cleared (hard and
   *  daily-cap pauses are left intact), then the flag drops. Armed only by the
   *  engine constructor when the persisted modelVersion differs from the
   *  wired one. */
  pendingModelReanchor?: boolean;
  /** Revision of the model re-anchor semantics this state went through
   *  (MODEL_REANCHOR_REV). Absent on a stamped state = revision 1 (peak +
   *  soft pause only, 2026-09-23..28). */
  modelReanchorRev?: number;
  /** ONE-SHOT upgrade of a state re-anchored under revision 1: clears an
   *  inherited loss-streak pause on the next evaluation (the engine
   *  constructor already restarted the streak at 0). The peak is NOT touched
   *  — it already belongs to the current model. */
  pendingStreakReanchor?: boolean;
}

/** 2 (2026-09-28): the loss streak is model-local too. Revision 1 carried
 *  momentum_crypto's 4 losing rebalances from the pre-vt-35 model through the
 *  cutover; one stop 36h later completed "5 consecutive" and paused entries
 *  24h — a pause the vt-35 replay (streak 0 at model start) never has. */
export const MODEL_REANCHOR_REV = 2;

export function isLossStreakPauseReason(reason: string): boolean {
  return reason.includes("consecutive losing rebalances");
}

export const RISK_STATE_VERSION = 3;

/**
 * Preserve drawdown percentages when a sleeve allocation changes.
 * If the loaded state lacks equityBase, the caller-supplied previousBase is
 * used to scale monetary anchors exactly once; RiskGuard never infers a base
 * on its own. Pauses are cleared only by exact reason match.
 */
export function rebaseRiskState(
  prev: RiskState,
  previousBase: number,
  currentBase: number,
  opts: { clearPauseReason?: string } = {},
): RiskState {
  const effectivePreviousBase = prev.equityBase ?? previousBase;
  const clearPause = opts.clearPauseReason && prev.pauseReason === opts.clearPauseReason;

  if (!(effectivePreviousBase > 0) || !(currentBase > 0) || effectivePreviousBase === currentBase) {
    return {
      ...prev,
      stateVersion: RISK_STATE_VERSION,
      equityBase: currentBase,
      ...(clearPause ? { pausedUntil: 0, pauseReason: "" } : {}),
    };
  }

  const scale = currentBase / effectivePreviousBase;
  return {
    ...prev,
    stateVersion: RISK_STATE_VERSION,
    equityBase: currentBase,
    peakEquity: prev.peakEquity * scale,
    dayStartEquity: prev.dayStartEquity * scale,
    pausedUntil: clearPause ? 0 : prev.pausedUntil,
    pauseReason: clearPause ? "" : prev.pauseReason,
    // Shadow-equity anchors are monetary — they rescale with the base like
    // peakEquity does (absent tracker: key stays absent, legacy shape).
    ...(prev.shadowResume
      ? {
          shadowResume: {
            equity: prev.shadowResume.equity * scale,
            startEquity: prev.shadowResume.startEquity * scale,
            peakRef: prev.shadowResume.peakRef * scale,
          },
        }
      : {}),
  };
}

export const INITIAL_RISK_STATE: RiskState = {
  stateVersion: RISK_STATE_VERSION,
  peakEquity: 0,
  dayStartEquity: 0,
  dayStartedAt: 0,
  consecutiveLosses: 0,
  pausedUntil: 0,
  pauseReason: "",
  lastEvalAt: 0,
};

export interface RiskAssessment {
  canOpen: boolean;
  reason: string;
  breach: RiskBreach;
  state: RiskState;
  /**
   * NEW-entry sizing factor in [0, 1] — present ONLY when cfg.ddScale is
   * configured (legacy assessments keep the exact pre-existing shape).
   * 1 = full size; (0, 1) = scaled entries (canOpen stays true); 0 = the
   * floor with minScale 0 — canOpen false with a "dd scale:" reason but NO
   * pause armed (re-evaluated every tick, entries resume the moment the
   * cushion reopens — a floor, not a lockout).
   */
  entryScale?: number;
}

/**
 * Stateless decision function. The caller owns persistence of `state`
 * and passes it back in on every call. This keeps RiskGuard easy to test
 * and free of side effects.
 */
export function evaluateRisk(
  prev: RiskState,
  currentEquity: number,
  now: number = Date.now(), // clock-ok: seam default — engines pass their injected clock's now
  cfg: RiskGuardConfig = DEFAULT_RISK_CONFIG,
): RiskAssessment {
  let state: RiskState = { ...prev };

  if (cfg.equitySemantics && !state.equitySemantics) {
    state.equitySemantics = cfg.equitySemantics;
    if (state.peakEquity > 0 || state.dayStartEquity > 0) state.pendingSemanticReanchor = true;
  }
  // A semantic change makes old monetary anchors incomparable. Keep every
  // other risk fact (especially an active pause and loss streak) intact.
  if (state.pendingSemanticReanchor && Number.isFinite(currentEquity) && currentEquity > 0) {
    state.peakEquity = currentEquity;
    state.dayStartEquity = currentEquity;
    state.dayStartedAt = now;
    state.pendingSemanticReanchor = false;
  }
  // One-shot MODEL-CUTOVER re-anchor (see RiskState.pendingModelReanchor):
  // the PRIOR model's peak and loss streak must not decide the NEW model's
  // pauses — re-anchor the peak to the first valid equity, restart the streak
  // and clear an inherited soft-drawdown or loss-streak pause. The daily
  // anchor and hard/daily-cap pauses are account-level facts and pass through
  // untouched. Legacy states never carry the flag — byte-identical behavior.
  if (state.pendingModelReanchor && Number.isFinite(currentEquity) && currentEquity > 0) {
    state.peakEquity = currentEquity;
    state.consecutiveLosses = 0;
    if (isSoftDrawdownPauseReason(state.pauseReason) || isLossStreakPauseReason(state.pauseReason)) {
      state.pausedUntil = 0;
      state.pauseReason = "";
    }
    state.pendingModelReanchor = false;
  }
  if (state.pendingStreakReanchor) {
    if (isLossStreakPauseReason(state.pauseReason)) {
      state.pausedUntil = 0;
      state.pauseReason = "";
    }
    state.pendingStreakReanchor = false;
  }

  // Initialise on first call
  if (state.peakEquity === 0) state.peakEquity = currentEquity;
  if (state.dayStartEquity === 0 || isNewUtcDay(state.dayStartedAt, now)) {
    state.dayStartEquity = currentEquity;
    state.dayStartedAt = now;
  }
  // Decay the peak toward current equity (see peakHalfLifeDays docstring).
  // Persisted pre-fix states have no lastEvalAt — `?? 0` skips the first decay.
  const lastEval = state.lastEvalAt ?? 0;
  if (cfg.peakHalfLifeDays > 0 && lastEval > 0 && now > lastEval && state.peakEquity > currentEquity) {
    const decay = Math.pow(0.5, (now - lastEval) / (cfg.peakHalfLifeDays * 86_400_000));
    state.peakEquity = currentEquity + (state.peakEquity - currentEquity) * decay;
  }
  state.lastEvalAt = now;
  if (currentEquity > state.peakEquity) state.peakEquity = currentEquity;

  // If pause window is still active, refuse opens.
  //
  // Grid-race note (audited 2026-09-25, NOT a bug): a fixed-hours pause is
  // `breach-tick now + N×3600_000`, and momentum ticks fire on the same UTC
  // hour grid (boundary + 15s), with `now` captured at tick START — so
  // pausedUntil lands ON the tick grid ± the two ticks' millisecond jitter,
  // and whether the tick at the expiry hour still sees `pausedUntil > now`
  // is a coin flip on that jitter. Losing it costs ONE extra period of
  // blocked entries and delays pause_resolved by the same period (verified
  // live: momentum_crypto_usdc pause to 10:00:15.002; the 10:00:15.00x tick
  // logged "new entries BLOCKED … paused 24h" and pause_resolved fired on
  // the 11:00 tick). Deliberately left strict: the conservative side of a
  // ms race on a risk breaker is "stay paused one more tick", and the
  // transition detector still fires exactly once either way.
  if (state.pausedUntil > now) {
    return {
      canOpen: false,
      reason: state.pauseReason || `paused until ${new Date(state.pausedUntil).toISOString()}`,
      breach: null,
      state,
    };
  }

  // Else evaluate each rule, MOST SEVERE FIRST so a single call can trigger
  // the strongest breach.
  const dd = (state.peakEquity - currentEquity) / Math.max(state.peakEquity, 1);
  const dailyLoss = (state.dayStartEquity - currentEquity) / Math.max(state.dayStartEquity, 1);

  if (dd >= cfg.hardDrawdownPct) {
    state.pausedUntil = now + cfg.hardPauseHours * 60 * 60_000;
    state.pauseReason = `hard drawdown ${(dd * 100).toFixed(1)}% — paused ${cfg.hardPauseHours}h, human review required`;
    return { canOpen: false, reason: state.pauseReason, breach: "hard_drawdown", state };
  }

  // ddScale replaces the BINARY soft-drawdown pause with continuous entry
  // sizing (see the config docstring): the soft breaker is skipped entirely,
  // the factor is computed here (same decayed-peak dd) and attached to every
  // verdict below. A factor of exactly 0 (minScale 0, dd >= endPct) refuses
  // opens WITHOUT arming a pause — unlike the soft pause there is no 24h
  // re-arm loop; the next tick re-evaluates from scratch.
  let entryScale: number | undefined;
  if (cfg.ddScale) {
    entryScale = ddEntryScale(dd, cfg.ddScale);
    if (entryScale <= 0) {
      return {
        canOpen: false,
        reason: `dd scale: entries scaled to 0 (dd ${(dd * 100).toFixed(1)}% >= ${(cfg.ddScale.endPct * 100).toFixed(1)}%)`,
        breach: null,
        state,
        entryScale: 0,
      };
    }
  } else if (dd >= cfg.softDrawdownPct) {
    state.pausedUntil = now + cfg.softPauseHours * 60 * 60_000;
    state.pauseReason = `soft drawdown ${(dd * 100).toFixed(1)}% — paused ${cfg.softPauseHours}h`;
    return { canOpen: false, reason: state.pauseReason, breach: "soft_drawdown", state };
  }

  if (dailyLoss >= cfg.dailyLossCapPct) {
    // Daily cap pauses until tomorrow UTC, not a fixed window.
    const tomorrow = nextUtcMidnight(now);
    state.pausedUntil = tomorrow;
    state.pauseReason = `daily loss cap ${(dailyLoss * 100).toFixed(2)}% — paused until ${new Date(tomorrow).toISOString()}`;
    return { canOpen: false, reason: state.pauseReason, breach: "daily_cap", state };
  }

  if (state.consecutiveLosses >= cfg.consecutiveLossLimit) {
    state.pausedUntil = now + cfg.softPauseHours * 60 * 60_000;
    state.pauseReason = `${state.consecutiveLosses} consecutive losing rebalances — paused ${cfg.softPauseHours}h`;
    state.consecutiveLosses = 0;
    return { canOpen: false, reason: state.pauseReason, breach: "loss_streak", state };
  }

  return {
    canOpen: true,
    reason: `equity ${currentEquity.toFixed(2)}, peak ${state.peakEquity.toFixed(2)}, dd ${(dd * 100).toFixed(2)}%`,
    breach: null,
    state,
    // Key present ONLY under ddScale — legacy assessments stay byte-identical.
    ...(entryScale !== undefined ? { entryScale } : {}),
  };
}

/**
 * Helper: caller invokes this AFTER a rebalance to update the streak counter.
 * Positive P&L resets, negative increments, and a quiet zero-P&L window leaves
 * the streak unchanged. Returns the new state.
 */
export function recordRebalanceOutcome(prev: RiskState, periodPnl: number): RiskState {
  const next = { ...prev };
  if (periodPnl > 0) {
    next.consecutiveLosses = 0;
  } else if (periodPnl < 0) {
    next.consecutiveLosses += 1;
  }
  return next;
}

// ── Pause transitions (B-ops-alerts.md #1) ──────────────────────────────────
//
// evaluateRisk is called every tick/pass regardless of state, so "still
// paused" (the `pausedUntil > now` continuation branch) and "just paused"
// (a fresh breach) are both silent by construction unless the CALLER
// distinguishes them — which nobody did: 372 blocked crypto ticks over 16
// days paged nobody (B-ops-alerts.md #1). `breach` already carries exactly
// that distinction (non-null ONLY on a fresh breach this call; null on both
// the continuation branch and the canOpen:true branch), so detecting a
// TRANSITION needs no new state — only the pre-call state, to tell a
// recovery (was paused, now open) from "was already open".

export type PauseTransition =
  | { kind: "pause_started"; reason: string; pausedUntil: number; breach: NonNullable<RiskBreach> }
  | { kind: "pause_resolved"; priorReason: string };

/**
 * Detects a pause STATE CHANGE from one evaluateRisk call — never fires on a
 * tick that merely continues an existing pause or continues being open.
 * `prevState` MUST be the state passed INTO evaluateRisk (before it returns
 * `riskCheck.state`), not the post-call state. Persistence for "don't
 * re-page after a restart" is free: the caller persists `riskState` every
 * call already, so a restart mid-pause reloads it and the next call sees a
 * continuation, not a fresh breach.
 *
 * "Was paused" deliberately compares `pausedUntil` against `lastEvalAt`
 * (both from BEFORE this call), NOT against the CURRENT call's `now`:
 * `pausedUntil` never resets to 0 on natural recovery (evaluateRisk's
 * canOpen:true branch leaves it as a stale past timestamp — see its
 * docstring's "0 = not paused" contract, which only holds going forward,
 * not retroactively), so comparing against `now` would flip permanently
 * false the instant the wall clock passes the ORIGINAL pause window — even
 * if no tick happened to observe the recovery until hours later — while
 * comparing against the stale value forever afterward would refire on
 * every subsequent healthy tick. `lastEvalAt` is the one persisted anchor
 * that's updated on every call (including continuations, before the
 * early-return), so `pausedUntil > lastEvalAt` answers exactly "as of the
 * LAST time we looked, were we still paused" — true throughout an active
 * pause (however many ticks it spans) and exactly once true on the first
 * tick after it lifts, then false forever after.
 */
export function detectPauseTransition(
  prevState: RiskState,
  riskCheck: RiskAssessment,
): PauseTransition | null {
  if (riskCheck.breach) {
    return {
      kind: "pause_started",
      reason: riskCheck.state.pauseReason,
      pausedUntil: riskCheck.state.pausedUntil,
      breach: riskCheck.breach,
    };
  }
  if (prevState.pausedUntil > (prevState.lastEvalAt ?? 0) && riskCheck.canOpen) {
    return { kind: "pause_resolved", priorReason: prevState.pauseReason };
  }
  return null;
}

// ── helpers ──

function isNewUtcDay(prevMs: number, nowMs: number): boolean {
  if (prevMs === 0) return true;
  const prevDay = Math.floor(prevMs / 86_400_000);
  const nowDay  = Math.floor(nowMs / 86_400_000);
  return nowDay !== prevDay;
}

function nextUtcMidnight(nowMs: number): number {
  const day = Math.floor(nowMs / 86_400_000);
  return (day + 1) * 86_400_000;
}
