// ══════════════════════════════════════════════
// Venue rate limiter — shared per VENUE, priority-classed (2026-08-06)
// ══════════════════════════════════════════════
//
// Motivation (documented incident, src/index.ts): shadow_meanrev_wide's 198
// concurrent Alpaca requests exhausted the account's shared market-data
// quota and poisoned the LIVE sleeves' price reads — a zero-capital shadow
// sleeve left the stop-loss loop blind. The mitigation until now was a
// disabled flag, not a limiter. This module is the limiter.
//
// Design:
//  - ONE limiter per VENUE, not per executor instance. The two
//    BinanceExecutor instances (USDT + USDC) sign against the SAME FAPI
//    account and share its quota; the Alpaca SDK trading client and the raw
//    market-data fetches share the same account quota too. A per-instance
//    limiter would count half the traffic and protect nothing.
//  - Priority CLASSES instead of a fair queue:
//      "protect"    — stop-loss reads, closes, stop placement/cancel. May
//                     take the bucket into a bounded token DEBT, so it can
//                     NEVER queue behind a burst of lower-class traffic.
//                     This is the structural fix for the incident: priority
//                     is enforced by budget partitioning, which has no queue
//                     to be stuck in, rather than by queue ordering, which
//                     always has a head-of-line story.
//      "trade"      — entries, order queries, account/position syncs. Needs
//                     ≥1 real token; bounded wait, then an EXPLICIT denial.
//      "background" — historical bars, exchangeInfo, valuation fan-outs.
//                     Only served while the bucket holds MORE than a reserve
//                     floor, so background traffic can never drain the last
//                     tokens the protect/trade classes will need.
//  - 429/418 handling: notePenalty() honors Retry-After when the venue sent
//    one. A 429 pauses trade/background until the penalty passes (bounded by
//    their max wait → explicit denial) while protect may bypass ONCE per
//    call (counted): a single protective request during a 429 window is
//    worth it — Alpaca never escalates and Binance only bans for REPEATED
//    violations after the 429. A 418 is a Binance IP BAN: everything
//    freezes, protect included — during a ban every request fails anyway
//    AND extends the ban.
//  - A denial always happens BEFORE anything is transmitted, so callers can
//    safely map it to proven_failed in the OrderOutcome taxonomy — it is
//    never the "unknown after transmit" case.
//
// Defaults are deliberately ROOMY (see VENUE_RATE_LIMITER_DEFAULTS): normal
// operation must see zero waiting (fixed by test "normal cadence never
// waits"); the limiter exists to stop stampedes and to react to 429/418,
// not to slow the bot down.

export type RequestClass = "protect" | "trade" | "background";
export type VenueId = "alpaca" | "binance_fapi" | "binance_dapi";

export interface AcquireOutcome {
  ok: boolean;
  waitedMs: number;
  /** Set when ok=false. The request was NEVER transmitted — callers may
   *  safely treat this as proven_failed. */
  reason?: string;
}

export interface VenueRateLimiterOptions {
  /** Sustained refill rate. */
  ratePerMinute: number;
  /** Bucket capacity — the burst absorbed with zero waiting. */
  burst: number;
  /** Extra tokens the protect class may take BELOW zero (its no-queue
   *  guarantee). */
  protectDebt: number;
  /** Background is only served while tokens > this floor. */
  backgroundReserve: number;
  /** Per-class bound on total time acquire() may spend waiting. */
  maxWaitMs: Record<RequestClass, number>;
  /** Penalty window applied on a 429 without a Retry-After header. */
  penalty429Ms: number;
  /** Penalty window applied on a 418 without a Retry-After header. */
  penalty418Ms: number;
  /** True → acquire() is a no-op (used for the shared singletons under
   *  `bun test`, where module state persists across unrelated test files). */
  disabled?: boolean;
  /** Injectable clock/sleep/jitter for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number; // uniform [0,1)
}

export interface RateLimiterMetrics {
  venue: string;
  acquires: number;
  waits: number;
  totalWaitMs: number;
  denials: number;
  http429: number;
  http418: number;
  protectBypasses: number;
  penaltyActive: boolean;
  frozen: boolean;
  tokens: number;
}

export class VenueRateLimiter {
  readonly venue: string;
  private readonly opts: VenueRateLimiterOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  private tokens: number;
  private lastRefillAt: number;
  /** 429 soft penalty: trade/background wait it out (bounded); protect may
   *  bypass. */
  private penaltyUntil = 0;
  /** 418 hard freeze (IP ban): nothing goes out until it passes. */
  private freezeUntil = 0;

  private m = { acquires: 0, waits: 0, totalWaitMs: 0, denials: 0, http429: 0, http418: 0, protectBypasses: 0 };

  constructor(venue: string, opts: VenueRateLimiterOptions) {
    this.venue = venue;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    this.jitter = opts.jitter ?? Math.random;
    this.tokens = opts.burst;
    this.lastRefillAt = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.lastRefillAt = t;
    this.tokens = Math.min(this.opts.burst, this.tokens + (elapsed * this.opts.ratePerMinute) / 60_000);
  }

  /** Lowest token level `cls` is allowed to leave the bucket at. */
  private floorFor(cls: RequestClass): number {
    if (cls === "protect") return -this.opts.protectDebt;
    if (cls === "background") return this.opts.backgroundReserve;
    return 0;
  }

  /**
   * Take one token for a request of class `cls`. Waits (bounded per class)
   * when the budget or an active 429 penalty requires it; returns an
   * explicit denial — never an unbounded block — when the bound would be
   * exceeded. A denial means NOTHING was transmitted.
   */
  async acquire(cls: RequestClass = "trade"): Promise<AcquireOutcome> {
    if (this.opts.disabled) return { ok: true, waitedMs: 0 };
    this.m.acquires++;
    const start = this.now();
    const maxWait = this.opts.maxWaitMs[cls];
    let waited = false;

    for (;;) {
      const t = this.now();
      const elapsed = t - start;
      this.refill();

      // 418 hard freeze: nothing is sent during an IP ban — protect
      // included (a banned request fails anyway and extends the ban).
      if (this.freezeUntil > t) {
        if (this.freezeUntil - start > maxWait) return this.deny(elapsed, `http_418 ban active for ${this.freezeUntil - t}ms`);
        await this.pause(this.freezeUntil - t);
        waited = true;
        continue;
      }

      // 429 soft penalty.
      if (this.penaltyUntil > t && cls !== "protect") {
        if (this.penaltyUntil - start > maxWait) return this.deny(elapsed, `http_429 penalty active for ${this.penaltyUntil - t}ms`);
        await this.pause(this.penaltyUntil - t);
        waited = true;
        continue;
      }
      const bypassing = this.penaltyUntil > t && cls === "protect";

      if (this.tokens - 1 >= this.floorFor(cls)) {
        this.tokens -= 1;
        if (bypassing) this.m.protectBypasses++;
        if (waited) {
          this.m.waits++;
          this.m.totalWaitMs += elapsed;
        }
        return { ok: true, waitedMs: elapsed };
      }

      // Not enough budget: wait for refill, bounded.
      const deficit = this.floorFor(cls) + 1 - this.tokens;
      const needMs = Math.ceil((deficit * 60_000) / this.opts.ratePerMinute);
      if (elapsed + needMs > maxWait) return this.deny(elapsed, `budget exhausted (class=${cls}, need ~${needMs}ms of refill)`);
      await this.pause(needMs);
      waited = true;
    }
  }

  private deny(waitedMs: number, reason: string): AcquireOutcome {
    this.m.denials++;
    return { ok: false, waitedMs, reason: `${this.venue} ${reason}` };
  }

  private async pause(ms: number): Promise<void> {
    // +0..10% jitter so synchronized waiters don't thundering-herd the
    // venue the instant a penalty/refill window opens.
    const j = 1 + this.jitter() * 0.1;
    await this.sleep(Math.max(1, Math.ceil(ms * j)));
  }

  /**
   * Record a venue rate-limit response. `retryAfterMs` should come from the
   * venue's own Retry-After/X-RateLimit-Reset when available — it is
   * respected exactly; otherwise the per-status default applies.
   * Counted even when the limiter is disabled (observability in tests).
   */
  notePenalty(status: 429 | 418, retryAfterMs?: number): void {
    const t = this.now();
    const ms = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : status === 418 ? this.opts.penalty418Ms : this.opts.penalty429Ms;
    if (status === 418) {
      this.m.http418++;
      this.freezeUntil = Math.max(this.freezeUntil, t + ms);
    } else {
      this.m.http429++;
      this.penaltyUntil = Math.max(this.penaltyUntil, t + ms);
    }
    // Resume gently once the window passes — the venue told us the bucket
    // on ITS side is empty, so ours should not claim otherwise.
    this.tokens = Math.min(this.tokens, 0);
  }

  metrics(): RateLimiterMetrics {
    const t = this.now();
    return {
      venue: this.venue,
      ...this.m,
      penaltyActive: this.penaltyUntil > t,
      frozen: this.freezeUntil > t,
      tokens: this.tokens,
    };
  }
}

// ── Per-venue defaults ────────────────────────────────────────────────────
//
// Deliberately ROOMY: the point is stampede/429 protection, never throttling
// normal operation.
//  - alpaca: the Basic plan's documented market-data quota is 200 req/min and
//    the official SDK's own default Trading-API limit is 200 req/60s. The
//    bot's measured normal load (scan every 5min over ~40 symbols + the
//    15s/30s/60s loops over a handful of positions) is far below the
//    sustained rate, and burst=60 absorbs a full scan with zero waiting.
//    The incident's 198-request stampede is exactly what lands in the wait
//    queue/denials — while protect traffic rides the debt allowance.
//  - binance_fapi/dapi: Binance limits by request WEIGHT (2400/min per IP on
//    futures); the endpoints this bot uses weigh 1–5. 600 req/min of
//    weight ≤5 keeps even the worst mix inside the cap with margin, and the
//    bot's real cadence is another order of magnitude below that.
export const VENUE_RATE_LIMITER_DEFAULTS: Record<VenueId, VenueRateLimiterOptions> = {
  alpaca: {
    ratePerMinute: 200,
    burst: 60,
    protectDebt: 30,
    backgroundReserve: 10,
    maxWaitMs: { protect: 3_000, trade: 10_000, background: 20_000 },
    penalty429Ms: 20_000,
    penalty418Ms: 120_000,
  },
  binance_fapi: {
    ratePerMinute: 600,
    burst: 120,
    protectDebt: 40,
    backgroundReserve: 20,
    maxWaitMs: { protect: 3_000, trade: 10_000, background: 20_000 },
    penalty429Ms: 20_000,
    penalty418Ms: 120_000,
  },
  binance_dapi: {
    ratePerMinute: 600,
    burst: 120,
    protectDebt: 40,
    backgroundReserve: 20,
    maxWaitMs: { protect: 3_000, trade: 10_000, background: 20_000 },
    penalty429Ms: 20_000,
    penalty418Ms: 120_000,
  },
};

const registry = new Map<string, VenueRateLimiter>();

/**
 * The SHARED limiter for a venue — every executor instance touching that
 * venue's quota must go through the same one. Under `bun test` the shared
 * singletons are created DISABLED (module state persists across unrelated
 * test files and would otherwise leak waits into them); the limiter's own
 * tests construct VenueRateLimiter directly, and integration tests may
 * install a live instance via __setVenueRateLimiterForTests.
 */
export function getVenueRateLimiter(venue: VenueId): VenueRateLimiter {
  let l = registry.get(venue);
  if (!l) {
    l = new VenueRateLimiter(venue, {
      ...VENUE_RATE_LIMITER_DEFAULTS[venue],
      disabled: process.env.NODE_ENV === "test",
    });
    registry.set(venue, l);
  }
  return l;
}

/** Parse a Retry-After header (delta-seconds form) into milliseconds. */
export function retryAfterMsFromHeaders(headers: Headers | undefined | null): number | undefined {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1000) : undefined;
}

/** Snapshot of every venue limiter that has been used (for /metrics). */
export function rateLimiterMetricsAll(): RateLimiterMetrics[] {
  return [...registry.values()].map(l => l.metrics());
}

/** TEST-ONLY: replace a venue's shared limiter (e.g. with an enabled one). */
export function __setVenueRateLimiterForTests(venue: VenueId, limiter: VenueRateLimiter | undefined): void {
  if (limiter === undefined) registry.delete(venue);
  else registry.set(venue, limiter);
}

/** TEST-ONLY: drop every shared limiter (fresh defaults on next use). */
export function __resetVenueRateLimitersForTests(): void {
  registry.clear();
}
