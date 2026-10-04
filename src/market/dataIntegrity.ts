// ══════════════════════════════════════════════
// Data integrity — physically-impossible data detectors (2026-07-29)
//
// WHY: well-formed garbage passes every parse. A bid above the ask, a broker
// event stamped in the future, a candle series with inverted timestamps, a
// positionRisk row with an open position at markPrice 0 — all parse as valid
// numbers and silently poison whatever reads them. Reference:
// nkaz001/hftbacktest validation.py (correct_local_timestamp /
// validate_event_order): if the MINIMUM observed feed latency
// (local_ts - exch_ts) is negative, an event "arrived before it happened" —
// the clocks are desynced.
//
// PHILOSOPHY (live bot, not a backtest cleaner): DETECT AND WARN, never
// silently adjust. hftbacktest SHIFTS timestamps to repair a recording; a
// live bot that silently rewrites broker data hides the exact desync that
// will later produce -1021 recvWindow rejections. Rejection is reserved for
// the few spots where discarding is strictly safer than using (a crossed
// quote for fill telemetry, an out-of-order candle series with a denser
// fallback available). Everything else warns with a per-key cooldown —
// alert fatigue is documented history in this repo.
//
// Kill switch: DATA_INTEGRITY=false disables every wired check (pure
// functions keep working; call sites gate on dataIntegrityEnabled()).
// ══════════════════════════════════════════════

import { createLogger } from "../utils/logger";
import type { OHLCV } from "../utils/types";

const log = createLogger("DataIntegrity");

const ENABLED = (process.env.DATA_INTEGRITY ?? "true").toLowerCase() !== "false";
export function dataIntegrityEnabled(): boolean { return ENABLED; }

// ── Throttled warnings (aggregated, per-key cooldown) ─────────────

export const WARN_COOLDOWN_MS = 5 * 60_000;
const throttle = new Map<string, { at: number; suppressed: number }>();

/** Warn at most once per `cooldownMs` per key; suppressed repeats are counted
 *  and reported on the next emission. Returns true when it actually logged. */
export function warnThrottled(key: string, msg: string, cooldownMs = WARN_COOLDOWN_MS, nowMs = Date.now()): boolean {
  const t = throttle.get(key);
  if (t && nowMs - t.at < cooldownMs) {
    t.suppressed++;
    return false;
  }
  const suffix = t?.suppressed ? ` (+${t.suppressed} suppressed since last)` : "";
  throttle.set(key, { at: nowMs, suppressed: 0 });
  log.warn(`${msg}${suffix}`);
  return true;
}

/** Test seam. */
export function resetWarnThrottle(): void { throttle.clear(); }

// ── Pure detectors ────────────────────────────────────────────────

/** bid > ask: well-formed, physically impossible on a single venue's book. */
export function isCrossedQuote(bid: number, ask: number): boolean {
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && bid > ask;
}

/** Tolerable clock skew before a broker event timestamp "in the future" is
 *  impossible rather than drift. Matches the +5s allowance the executor's
 *  fresh-quote gate has always used. */
export const FUTURE_TS_TOLERANCE_MS = 5_000;

export function isImpossibleFutureTs(exchTs: number, nowMs = Date.now(), toleranceMs = FUTURE_TS_TOLERANCE_MS): boolean {
  return Number.isFinite(exchTs) && exchTs > nowMs + toleranceMs;
}

export interface CandleIssue {
  kind: "out_of_order" | "duplicate" | "gap";
  index: number;       // index of the offending bar (the second of the pair)
  deltaMs: number;     // t[i] - t[i-1]
}

/** Order + continuity of a CLOSED-bar series with fixed spacing.
 *  out_of_order/duplicate = physically impossible from the exchange (or a
 *  corrupted merge). gap = at least one missing bar (delta >= 2×interval) —
 *  anomalous for 24/7 perps but not wrong, callers decide. This is the live
 *  sibling of the backtest validator's ">61min gap in 1h candles" throw. */
export function validateCandleSeries(candles: Pick<OHLCV, "timestamp">[], intervalMs: number): CandleIssue[] {
  const issues: CandleIssue[] = [];
  if (!(intervalMs > 0)) return issues;
  for (let i = 1; i < candles.length; i++) {
    const deltaMs = candles[i].timestamp - candles[i - 1].timestamp;
    if (deltaMs === 0) issues.push({ kind: "duplicate", index: i, deltaMs });
    else if (deltaMs < 0) issues.push({ kind: "out_of_order", index: i, deltaMs });
    else if (deltaMs >= 2 * intervalMs) issues.push({ kind: "gap", index: i, deltaMs });
  }
  return issues;
}

/** Impossible values in a Binance positionRisk row. Only rows with an OPEN
 *  position are judged: flat rows legitimately carry markPrice "0.00000000"
 *  on testnet (documented; today's readers filter positionAmt !== 0 first —
 *  this is the canary for the future reader that won't). */
export function positionPayloadIssues(row: { symbol?: unknown; positionAmt?: unknown; entryPrice?: unknown; markPrice?: unknown }): string[] {
  const issues: string[] = [];
  const amt = parseFloat(String(row?.positionAmt));
  if (!Number.isFinite(amt)) return [`positionAmt "${row?.positionAmt}" is not numeric`];
  if (amt === 0) return issues; // flat rows: zeros are benign
  if (row.entryPrice !== undefined) {
    const entry = parseFloat(String(row.entryPrice));
    if (!(entry > 0)) issues.push(`open position (${amt}) with entryPrice ${row.entryPrice}`);
  }
  if (row.markPrice !== undefined) {
    const mark = parseFloat(String(row.markPrice));
    if (!(mark > 0)) issues.push(`open position (${amt}) with markPrice ${row.markPrice}`);
  }
  return issues;
}

// ── Clock drift ───────────────────────────────────────────────────

/** Round-trip-aware skew from one /fapi/v1/time exchange: server clock minus
 *  the local midpoint of the request. Positive = server ahead of us.
 *  Measured 2026-07-29: ~50-120ms on prod fapi and testnet — healthy. */
export function clockDriftMs(serverTimeMs: number, localBeforeMs: number, localAfterMs: number): number {
  return serverTimeMs - Math.round((localBeforeMs + localAfterMs) / 2);
}

/** |drift| beyond this is worth a warning: still inside Binance's 5s
 *  recvWindow, but no longer "network jitter" — the value of this module is
 *  noticing WHEN the healthy ~120ms stops being healthy, before -1021s. */
export const CLOCK_DRIFT_WARN_MS = 2_500;

export const NEGATIVE_LATENCY_TOLERANCE_MS = 1_000; // small negatives = jitter/granularity
export const DRIFT_WINDOW_MS = 5 * 60_000;          // rolling observation window per feed
export const DRIFT_MIN_SAMPLES = 5;                 // sustained, not a one-off spike
export const DRIFT_ALERT_COOLDOWN_MS = 10 * 60_000;

interface FeedState { minLatencyMs: number; samples: number; windowStart: number; alertedAt: number }

/** Per-feed feed-latency monitor (hftbacktest's correct_local_timestamp idea,
 *  detection only). latency = local_ts - exch_ts; the MINIMUM over a window
 *  being negative beyond tolerance is physically impossible → clocks desynced.
 *  Alerts once per cooldown per feed; never adjusts anything. */
export class ClockDriftMonitor {
  private feeds = new Map<string, FeedState>();
  constructor(private onAlert: (msg: string) => void = (m) => log.warn(m)) {}

  observe(feed: string, exchTs: number, localTs = Date.now()): number {
    const latency = localTs - exchTs;
    let s = this.feeds.get(feed);
    if (!s || localTs - s.windowStart >= DRIFT_WINDOW_MS) {
      s = { minLatencyMs: latency, samples: 0, windowStart: localTs, alertedAt: s?.alertedAt ?? 0 };
      this.feeds.set(feed, s);
    }
    s.minLatencyMs = Math.min(s.minLatencyMs, latency);
    s.samples++;
    if (
      s.samples >= DRIFT_MIN_SAMPLES &&
      s.minLatencyMs < -NEGATIVE_LATENCY_TOLERANCE_MS &&
      localTs - s.alertedAt >= DRIFT_ALERT_COOLDOWN_MS
    ) {
      s.alertedAt = localTs;
      this.onAlert(
        `clock drift on feed "${feed}": min feed latency ${s.minLatencyMs}ms over ${s.samples} samples — ` +
        `events arriving before they happen; local clock is ahead of the exchange. ` +
        `Detection only, nothing adjusted; check NTP before this becomes -1021 recvWindow rejections.`
      );
      return latency;
    }
    return latency;
  }

  /** Inspection/test seam. */
  minLatency(feed: string): number | null { return this.feeds.get(feed)?.minLatencyMs ?? null; }
}

/** Shared instance for the live wiring (bookTicker `time`, etc.). */
export const clockDrift = new ClockDriftMonitor();
