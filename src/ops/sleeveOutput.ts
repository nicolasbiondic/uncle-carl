// ══════════════════════════════════════════════
// Sleeve OUTPUT liveness — "does it produce?", not "does it beat?"
// ══════════════════════════════════════════════
//
// Born from the shadow_momentum_crypto incident (2026-07): the sleeve ticked
// happily for WEEKS while every single open failed with "no price" — 77
// consecutive failures, ZERO trades rows — and the only trace was log.warn
// lines nobody reads. The heartbeat registry (src/ops/heartbeat.ts) answers
// "is the loop alive?"; it can never catch this, because the loop WAS alive.
// This module answers "is the loop producing anything?". Same class as the
// /rejects command that answered "sin rechazos" for months because nothing
// wrote the table: running ≠ producing, and silence must page.
//
// Deliberately a SIBLING of HeartbeatRegistry, not an extension: heartbeat is
// in-memory + time-based + checker-driven, and resetting on restart is
// CORRECT for it (a fresh process gets a fresh liveness window). Output
// liveness is count-based, event-driven (recorded at the open/close call
// sites), and MUST survive restarts — this bot restarts several times a day,
// and an in-memory counter that resets on every deploy never reaches its
// threshold (the exact defect AGENTS.md documents for unreconciledCounts /
// pdtBlockedUntil, and the reason BrokerSync's drift fingerprint moved to
// sync_state). State lives in the sync_state kv table, one JSON row per
// sleeve, so a brand-new process resumes the count where the old one left it.
//
// Two signals, both behind cooldowns (alert fatigue is what made the owner
// stop looking — see BrokerSync's QTY_DRIFT_RENOTIFY_MS):
//
// 1. Consecutive open FAILURES (strong, unambiguous): every failed
//    openPosition increments a per-sleeve counter; any successful open resets
//    it. At OPEN_FAIL_THRESHOLD it pages via EVENTS.ERROR_BURST with the
//    sleeve, the count, and the grouped reasons. Threshold 5: a transient
//    network blip fails 1-2 attempts and resets on the next success (no
//    page), while a fully-dead open path (the crypto case: EVERY attempt
//    fails) plans ~4 opens/tick and crosses 5 within 1-2 ticks — pages in
//    ~1-2h at hourly cadence instead of going unnoticed for weeks.
//
// 2. Productive SILENCE (weak, may be legitimate): a sleeve that ticked
//    ≥ SILENCE_MIN_TICKS times with zero opens AND zero closes for
//    ≥ SILENCE_WINDOW_MS pages ONCE (re-pages at most once per window while
//    the condition persists; re-armed by any output). Window 14 days:
//    momentum_stocks legitimately ends 41% of sessions flat (measured,
//    AGENTS.md 2026-07-27 §2), so short windows would page on normal
//    behavior — 14 consecutive zero-action sessions is ≈ 0.41^14 ≈ 4e-6
//    under independence, and even with regime correlation two full weeks of
//    literal zero activity deserves exactly one human look. MIN_TICKS=10
//    keeps a mostly-down bot (the heartbeat's class, not ours) from paging
//    here: elapsed time alone is not evidence the sleeve had chances to act.
//    LIMITATION (honest): this signal cannot distinguish "no signal fired"
//    from "blocked by regime/risk for weeks" — the alert text says so.
//    "Tried to open and failed" is signal 1's job, not this one's.
//
// Covers live AND shadow sleeves: a shadow book's output IS the evidence the
// SleeveGovernor needs for promotion (≥30 trades/90d) — an empty shadow book
// blocks promotion forever, silently (crypto, and shadow_pairs before it).

import { eventBus, EVENTS } from "../utils/events";
import { createLogger } from "../utils/logger";
import { getSyncState, setSyncState } from "../db/database";
import { isTradingEnabled } from "../config";
import { RISK_DENIAL_CODES } from "../risk/RiskEngine";

const log = createLogger("SleeveOutput");

/**
 * True when `reason` names a POLICY veto — RiskEngine's pre-trade codes
 * (SwitchingAdapter.openPosition returns `reason: veto.code` verbatim), the
 * maintenance kill-switch backstop, or an engine-local gross-exposure-cap
 * block (MomentumEngine/MeanRevEngine's own bookkeeping, never reaching the
 * broker) — never a broker/network failure. B-ops-alerts.md #4 (repeated
 * `RISK_DENY:NOTIONAL_EXCEEDS_MAXIMUM` after the 2026-09-24 1× gross-cap
 * change) is exactly the case this exists for: 25 sound vetoes in a row are
 * NOT the same incident class as a broken open path, and must not share its
 * counter/threshold.
 */
export function isPolicyPreventedReason(reason?: string): boolean {
  if (!reason) return false;
  if (reason === "trading_disabled") return true;
  if (reason.startsWith("gross exposure cap")) return true;
  if (reason.startsWith("capacity guard")) return true; // %ADV veto (enforce mode) — a sound policy block, not a broken open path
  return (RISK_DENIAL_CODES as readonly string[]).includes(reason);
}

export const OPEN_FAIL_THRESHOLD = 5;
export const OPEN_FAIL_COOLDOWN_MS = 6 * 60 * 60_000; // re-page ≤4×/day while dead, not per tick
export const SILENCE_WINDOW_MS = 14 * 24 * 60 * 60_000;
export const SILENCE_MIN_TICKS = 10;
const MAX_REASON_KEYS = 8; // grouped-reason map cap — overflow buckets into "(other)"

interface SleeveOutputState {
  fails: number; // consecutive open failures (reset by a successful open)
  reasons: Record<string, number>; // grouped failure reasons since last success
  failAlertAt: number; // last consecutive-failure page (cooldown anchor)
  lastOutputAt: number; // last successful open OR close
  ticksSinceOutput: number; // engine passes since last output
  silenceAlertAt: number; // last productive-silence page
  /** Lifetime count of policy-vetoed attempts (gross cap / RiskEngine deny /
   *  maintenance kill-switch) — telemetry only, never gates a page and never
   *  resets (unlike `fails`, this is not a failure streak to recover from). */
  preventedByPolicy: number;
  /** Most recent policy-veto reason — telemetry only (which gate fired last). */
  lastPolicyReason?: string;
  /** Lifetime count of capacity-guard OBSERVATIONS (mode "observe": the
   *  entry exceeded maxAdvPct%·ADV$ but proceeded) — telemetry only, the
   *  audit trail for flipping the guard to "enforce" before real capital. */
  capacityObservations?: number;
  /** Most recent capacity observation — telemetry only. */
  lastCapacityReason?: string;
}

export class SleeveOutputMonitor {
  constructor(private now: () => number = Date.now) {}

  private key(sleeve: string): string {
    return `sleeve_output:${sleeve}`;
  }

  private load(sleeve: string): SleeveOutputState {
    // Seed lastOutputAt at now() on first sighting — a freshly-wired sleeve
    // gets one full silence window before it can page (heartbeat register()
    // seeds lastBeatMs the same way).
    const fresh: SleeveOutputState = {
      fails: 0, reasons: {}, failAlertAt: 0,
      lastOutputAt: this.now(), ticksSinceOutput: 0, silenceAlertAt: 0,
      preventedByPolicy: 0,
    };
    try {
      const raw = getSyncState(this.key(sleeve));
      if (raw) return { ...fresh, ...JSON.parse(raw) };
    } catch (err) {
      try { log.error(`load('${sleeve}') failed: ${String(err)}`); } catch {}
    }
    return fresh;
  }

  private save(sleeve: string, s: SleeveOutputState): void {
    setSyncState(this.key(sleeve), JSON.stringify(s));
  }

  /** A broker/adapter openPosition returned !ok (or threw). */
  recordOpenFailure(sleeve: string, reason?: string): void {
    // A monitor must never crash the engine it monitors (heartbeat contract).
    try {
      const s = this.load(sleeve);
      s.fails++;
      const k = (reason || "unknown").slice(0, 80);
      if (s.reasons[k] !== undefined || Object.keys(s.reasons).length < MAX_REASON_KEYS) {
        s.reasons[k] = (s.reasons[k] ?? 0) + 1;
      } else {
        s.reasons["(other)"] = (s.reasons["(other)"] ?? 0) + 1;
      }
      const now = this.now();
      // failAlertAt === 0 means "never paged" (JSON-persistable NEVER sentinel
      // — heartbeat's -Infinity doesn't survive JSON.stringify).
      if (s.fails >= OPEN_FAIL_THRESHOLD && (s.failAlertAt === 0 || now - s.failAlertAt >= OPEN_FAIL_COOLDOWN_MS)) {
        s.failAlertAt = now;
        const grouped = Object.entries(s.reasons).map(([r, n]) => `${r} ×${n}`).join(", ");
        const msg = `sleeve '${sleeve}': ${s.fails} consecutive open failures, 0 successes (${grouped}) — the sleeve is producing NOTHING`;
        log.error(msg);
        try {
          eventBus.emit(EVENTS.ERROR_BURST, { context: `sleeve_output:${sleeve}`, message: msg, count: s.fails, windowMs: 0, firstAt: now, lastAt: now });
        } catch {}
      }
      this.save(sleeve, s);
    } catch (err) {
      try { log.error(`recordOpenFailure('${sleeve}') failed: ${String(err)}`); } catch {}
    }
  }

  /**
   * An attempt was VETOED BY POLICY (gross-exposure cap, a RiskEngine deny
   * code, or the maintenance kill-switch) — never even reached, or was
   * correctly rejected by, the broker. Deliberately does NOT touch
   * `fails`/`reasons` (so it can never trip the OPEN_FAIL_THRESHOLD page —
   * that signal means the OPEN PATH is broken, not that risk management
   * vetoed soundly) and does NOT count as output (no trade happened, so the
   * productive-silence clock is unaffected either).
   */
  recordPreventedByPolicy(sleeve: string, reason?: string): void {
    try {
      const s = this.load(sleeve);
      s.preventedByPolicy = (s.preventedByPolicy ?? 0) + 1;
      s.lastPolicyReason = (reason || "unknown").slice(0, 120);
      this.save(sleeve, s);
    } catch (err) {
      try { log.error(`recordPreventedByPolicy('${sleeve}') failed: ${String(err)}`); } catch {}
    }
  }

  /** A capacity-guard OBSERVATION (mode "observe": the entry exceeded its
   *  %ADV budget but proceeded). Telemetry only — same contract as
   *  recordPreventedByPolicy: never touches `fails`, never counts as
   *  output, never pages. Kept SEPARATE from preventedByPolicy because
   *  nothing was prevented — conflating them would corrupt the veto count. */
  recordCapacityObservation(sleeve: string, reason?: string): void {
    try {
      const s = this.load(sleeve);
      s.capacityObservations = (s.capacityObservations ?? 0) + 1;
      s.lastCapacityReason = (reason || "unknown").slice(0, 120);
      this.save(sleeve, s);
    } catch (err) {
      try { log.error(`recordCapacityObservation('${sleeve}') failed: ${String(err)}`); } catch {}
    }
  }

  /** A position actually opened — resets the failure streak AND counts as output. */
  recordOpenSuccess(sleeve: string): void {
    try {
      const s = this.load(sleeve);
      s.fails = 0;
      s.reasons = {};
      s.lastOutputAt = this.now();
      s.ticksSinceOutput = 0;
      s.silenceAlertAt = 0; // re-arm: a future silence episode pages again
      this.save(sleeve, s);
    } catch (err) {
      try { log.error(`recordOpenSuccess('${sleeve}') failed: ${String(err)}`); } catch {}
    }
  }

  /** A position actually closed — output, but deliberately does NOT reset the
   *  open-failure streak (closes succeeding while every open fails is still a
   *  sleeve that can't produce new evidence). */
  recordClose(sleeve: string): void {
    try {
      const s = this.load(sleeve);
      s.lastOutputAt = this.now();
      s.ticksSinceOutput = 0;
      s.silenceAlertAt = 0;
      this.save(sleeve, s);
    } catch (err) {
      try { log.error(`recordClose('${sleeve}') failed: ${String(err)}`); } catch {}
    }
  }

  /** One engine pass ran (whatever it decided). Fires the silence check. */
  recordTick(sleeve: string): void {
    try {
      const s = this.load(sleeve);
      s.ticksSinceOutput++;
      const now = this.now();
      if (
        s.ticksSinceOutput >= SILENCE_MIN_TICKS &&
        now - s.lastOutputAt >= SILENCE_WINDOW_MS &&
        (s.silenceAlertAt === 0 || now - s.silenceAlertAt >= SILENCE_WINDOW_MS) &&
        // A host explicitly configured to not open positions
        // (TRADING_ENABLED=false) produces no output BY DESIGN — paging
        // "zero opens/closes" there is exactly the alert-fatigue class this
        // module's header warns about. State keeps counting so a re-enabled
        // host resumes monitoring with full history.
        isTradingEnabled()
      ) {
        s.silenceAlertAt = now;
        const days = Math.round((now - s.lastOutputAt) / 86_400_000);
        const msg = `sleeve '${sleeve}': ${s.ticksSinceOutput} ticks with zero opens/closes in ${days}d — may be legitimate (flat regime / long holds) or a silent failure; review the sleeve's blocked/rejection logs`;
        log.warn(msg);
        try {
          eventBus.emit(EVENTS.ERROR_BURST, { context: `sleeve_output:${sleeve}`, message: msg, count: s.ticksSinceOutput, windowMs: now - s.lastOutputAt, firstAt: s.lastOutputAt, lastAt: now });
        } catch {}
      }
      this.save(sleeve, s);
    } catch (err) {
      try { log.error(`recordTick('${sleeve}') failed: ${String(err)}`); } catch {}
    }
  }
}

// Singleton — mirrors `heartbeats` in src/ops/heartbeat.ts.
export const sleeveOutput = new SleeveOutputMonitor();
