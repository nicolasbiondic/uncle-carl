// ══════════════════════════════════════════════
// Heartbeat Registry — universal loop liveness watchdog
// ══════════════════════════════════════════════
//
// The bot runs ~18 timer loops (engine 60min, syncs 60s, BrokerSync 30s, SL
// 15s, daily/carry chains). Two past outages were SILENT loop deaths — a 31h
// scan freeze and a 4-day BrokerSync no-op — that the logger's ERROR_BURST
// (10 identical errors / 60s) can NOT catch: a dead loop emits nothing.
//
// Contract: each loop calls beat(name) at the END of a successful iteration,
// or beatFailed(name) at the end of a pass that COMPLETED but whose broker/
// dependency failed with a handled error (timeout, DNS, 5xx). Either call
// proves the loop is ALIVE — liveness (lastBeatMs) advances on both; only
// beat() advances lastSuccessMs. One internal checker interval scans every
// registered beat; a loop silent for longer than expectedInterval × grace
// emits EVENTS.ERROR_BURST (same on-call path as logger bursts —
// TelegramReporter already listens) plus log.error, once per cooldown. A
// recovered beat re-arms so the next death pages again.
//
// Why the success/failure split (2026-09-23 + 2026-09-25 incidents): during
// the Alpaca outage 09-23 07:32–07:55 and the two DNS cuts 09-25 14:15/15:20
// UTC, the sync loops kept RUNNING — each pass failed fast on a bounded
// broker call and returned — but only success ever beat, so >5min of failed
// passes looked identical to a dead loop: "possible dead loop" pages,
// /healthz 503, and on 09-23 a watchdog restart that started DEGRADED and
// fixed nothing (a restart cannot cure a broker outage). Now a failing-but-
// alive loop keeps its liveness beat (no dead page, /healthz stays 200) and
// instead pages ONCE per episode as "broker unreachable", with a recovery
// notice when a pass succeeds again.

import { eventBus, EVENTS } from "../utils/events";
import { createLogger } from "../utils/logger";

const log = createLogger("Heartbeat");

const NEVER = Number.NEGATIVE_INFINITY; // "not paged since last recovery"
const DEFAULT_GRACE = 2;
const DEFAULT_CHECK_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const AUTO_REGISTER_MS = 60_000; // fallback cadence for defensive auto-registers

// A failing-but-alive loop pages "broker unreachable" only once BOTH hold:
// no success for ≥ this long AND ≥ this many consecutive failed passes.
// The floor matches isDeadLoop's 5min (routes/health.ts): below it a blip
// self-heals before anyone could act on a page.
export const BROKER_UNREACHABLE_MIN_MS = 5 * 60_000;
export const BROKER_UNREACHABLE_MIN_FAILURES = 3;

interface Beat {
  expectedIntervalMs: number;
  grace: number;
  lastBeatMs: number;    // any COMPLETED pass (success or handled failure) — liveness
  lastSuccessMs: number; // last SUCCESSFUL pass — dependency reachability
  consecutiveFailures: number;
  alertedAt: number; // NEVER = re-armed (never paged since last recovery)
  failurePagedAt: number; // NEVER = no open "broker unreachable" episode page
}

export interface HeartbeatStatus {
  name: string;
  lastBeatMs: number;
  ageMs: number;
  expectedIntervalMs: number;
  stale: boolean;
  /** Last successful pass + how long ago; equals lastBeatMs until the first
   *  beatFailed. successAgeMs is the age of the last success. */
  lastSuccessMs: number;
  successAgeMs: number;
  consecutiveFailures: number;
  /** Loop alive but its dependency (broker) failing past the episode
   *  thresholds — the "do NOT restart, a restart can't fix this" state. */
  brokerUnreachable: boolean;
}

/** Shared predicate (health.ts + pages agree on the definition). */
export function isBrokerUnreachable(h: { successAgeMs: number; consecutiveFailures: number }): boolean {
  return h.consecutiveFailures >= BROKER_UNREACHABLE_MIN_FAILURES && h.successAgeMs >= BROKER_UNREACHABLE_MIN_MS;
}

export class HeartbeatRegistry {
  private beats = new Map<string, Beat>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private cooldownMs: number;

  constructor(now: () => number = Date.now, cooldownMs: number = DEFAULT_COOLDOWN_MS) {
    this.now = now;
    this.cooldownMs = cooldownMs;
  }

  register(name: string, expectedIntervalMs: number, opts?: { graceMultiplier?: number }): void {
    const existing = this.beats.get(name);
    // Seed lastBeat at now() so a freshly-declared loop gets one full
    // interval×grace to produce its first beat; preserve it on re-register.
    const seed = this.now();
    this.beats.set(name, {
      expectedIntervalMs,
      grace: opts?.graceMultiplier ?? DEFAULT_GRACE,
      lastBeatMs: existing?.lastBeatMs ?? seed,
      lastSuccessMs: existing?.lastSuccessMs ?? seed,
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      alertedAt: existing?.alertedAt ?? NEVER,
      failurePagedAt: existing?.failurePagedAt ?? NEVER,
    });
  }

  beat(name: string): void {
    // A monitor must never crash the loop it monitors.
    try {
      const now = this.now();
      const b = this.beats.get(name);
      if (!b) {
        log.warn(`beat() for unregistered loop '${name}' — auto-registering (declare it via register())`);
        this.beats.set(name, { expectedIntervalMs: AUTO_REGISTER_MS, grace: DEFAULT_GRACE, lastBeatMs: now, lastSuccessMs: now, consecutiveFailures: 0, alertedAt: NEVER, failurePagedAt: NEVER });
        return;
      }
      b.lastBeatMs = now;
      b.alertedAt = NEVER; // recovery: re-arm so a future death pages again
      // Close an open "broker unreachable" episode with a recovery notice —
      // the counterpart of the once-per-episode page in check().
      if (b.failurePagedAt !== NEVER) {
        const outageMin = Math.round((now - b.lastSuccessMs) / 60_000);
        const msg = `loop '${name}': broker reachable again after ~${outageMin}min (${b.consecutiveFailures} failed passes) — episode over`;
        log.warn(msg);
        try {
          eventBus.emit(EVENTS.ERROR_BURST, { context: `broker_unreachable:${name}`, message: msg, count: 1, windowMs: now - b.lastSuccessMs });
        } catch { /* a throwing listener must not break the loop */ }
      }
      b.lastSuccessMs = now;
      b.consecutiveFailures = 0;
      b.failurePagedAt = NEVER;
    } catch (err) {
      try { log.error(`beat('${name}') failed: ${String(err)}`); } catch {}
    }
  }

  /** A pass COMPLETED but its broker/dependency failed with a handled error.
   *  Proves liveness (a restart would not help) without claiming success —
   *  the 09-23/09-25 outage class: /healthz must stay 200 and the watchdog
   *  must not restart; check() pages "broker unreachable" once per episode. */
  beatFailed(name: string): void {
    try {
      const now = this.now();
      const b = this.beats.get(name);
      if (!b) {
        log.warn(`beatFailed() for unregistered loop '${name}' — auto-registering (declare it via register())`);
        this.beats.set(name, { expectedIntervalMs: AUTO_REGISTER_MS, grace: DEFAULT_GRACE, lastBeatMs: now, lastSuccessMs: now, consecutiveFailures: 1, alertedAt: NEVER, failurePagedAt: NEVER });
        return;
      }
      b.lastBeatMs = now;          // liveness: the pass DID complete
      b.consecutiveFailures += 1;  // reachability: but its dependency failed
      b.alertedAt = NEVER;         // a completing loop is not a dead loop
    } catch (err) {
      try { log.error(`beatFailed('${name}') failed: ${String(err)}`); } catch {}
    }
  }

  start(checkIntervalMs: number = DEFAULT_CHECK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), checkIntervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One scan pass. Public so tests drive it with an injected clock (no waits). */
  check(): void {
    const now = this.now();
    for (const [name, b] of this.beats) {
      try {
        // Broker-unreachable episode: the loop is completing passes
        // (beatFailed keeps lastBeatMs fresh) but nothing has SUCCEEDED for
        // ≥5min / ≥3 passes. ONE page per episode (failurePagedAt), the
        // recovery notice lives in beat(). Deliberately a DIFFERENT message
        // and context than the dead-loop page below: the on-call action is
        // the opposite ("do not restart — wait out or check the broker").
        const successAge = now - b.lastSuccessMs;
        if (b.failurePagedAt === NEVER && isBrokerUnreachable({ successAgeMs: successAge, consecutiveFailures: b.consecutiveFailures })) {
          b.failurePagedAt = now;
          const msg = `loop '${name}' ALIVE but its broker is unreachable ~${Math.round(successAge / 60_000)}min (${b.consecutiveFailures} consecutive failed passes) — NOT a dead loop, a restart will not fix this`;
          log.error(msg);
          try {
            eventBus.emit(EVENTS.ERROR_BURST, { context: `broker_unreachable:${name}`, message: msg, count: b.consecutiveFailures, windowMs: successAge });
          } catch { /* a throwing listener must not break the checker */ }
        }

        const age = now - b.lastBeatMs;
        if (age <= b.expectedIntervalMs * b.grace) continue; // fresh enough
        if (now - b.alertedAt < this.cooldownMs) continue;   // paged recently
        b.alertedAt = now;
        const msg = `loop '${name}' silent ${Math.round(age / 1000)}s (expected every ${Math.round(b.expectedIntervalMs / 1000)}s ×${b.grace} grace) — possible dead loop`;
        log.error(msg);
        try {
          // Reuse the logger-burst payload shape so TelegramReporter pages it.
          eventBus.emit(EVENTS.ERROR_BURST, { context: `heartbeat:${name}`, message: msg, count: 1, windowMs: age });
        } catch {
          // a throwing listener must not break the checker
        }
      } catch (err) {
        try { log.error(`heartbeat check for '${name}' failed: ${String(err)}`); } catch {}
      }
    }
  }

  /** Point-in-time view for /healthz/full (orchestrator wires it). */
  snapshot(): HeartbeatStatus[] {
    const now = this.now();
    const out: HeartbeatStatus[] = [];
    for (const [name, b] of this.beats) {
      const ageMs = now - b.lastBeatMs;
      const successAgeMs = now - b.lastSuccessMs;
      out.push({
        name,
        lastBeatMs: b.lastBeatMs,
        ageMs,
        expectedIntervalMs: b.expectedIntervalMs,
        stale: ageMs > b.expectedIntervalMs * b.grace,
        lastSuccessMs: b.lastSuccessMs,
        successAgeMs,
        consecutiveFailures: b.consecutiveFailures,
        brokerUnreachable: isBrokerUnreachable({ successAgeMs, consecutiveFailures: b.consecutiveFailures }),
      });
    }
    return out;
  }
}

// Singleton — mirrors the eventBus pattern in src/utils/events.ts.
export const heartbeats = new HeartbeatRegistry();
