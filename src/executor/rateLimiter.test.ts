// ══════════════════════════════════════════════
// VenueRateLimiter — unit tests (deterministic virtual clock)
// ══════════════════════════════════════════════
//
// Every test here guards a specific regression:
//  - "normal cadence never waits"  → someone tightening the defaults or the
//    token math until the limiter throttles PRODUCTION traffic.
//  - "protect preempts background" → the documented incident (a shadow
//    sleeve's stampede starving the stop-loss loop's price reads): if the
//    priority classes lose their budget partitioning, protect queues behind
//    background and this fails.
//  - "Retry-After respected"       → dropping the venue's own penalty window.
//  - "jitter bounded"              → unbounded/removed jitter (thundering
//    herd on penalty expiry, or waits stretching past the class bound).
//  - "shared per venue"            → someone instantiating a limiter per
//    executor instance again (counts half the traffic, protects nothing).
//  - "418 freezes everything"      → treating a Binance IP ban like a plain
//    429 and letting protect traffic extend the ban.

import { describe, test, expect, afterEach } from "bun:test";
import {
  VenueRateLimiter,
  getVenueRateLimiter,
  retryAfterMsFromHeaders,
  __resetVenueRateLimitersForTests,
  type VenueRateLimiterOptions,
} from "./rateLimiter";

function makeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    advance: (ms: number) => { t += ms; },
    sleeps,
  };
}

function makeLimiter(over: Partial<VenueRateLimiterOptions> = {}) {
  const clock = makeClock();
  const l = new VenueRateLimiter("test_venue", {
    ratePerMinute: 600, // 10 tokens/s
    burst: 10,
    protectDebt: 5,
    backgroundReserve: 2,
    maxWaitMs: { protect: 3_000, trade: 10_000, background: 20_000 },
    penalty429Ms: 20_000,
    penalty418Ms: 120_000,
    now: clock.now,
    sleep: clock.sleep,
    jitter: () => 0,
    ...over,
  });
  return { l, clock };
}

afterEach(() => {
  __resetVenueRateLimitersForTests();
});

describe("normal operation is never throttled", () => {
  test("a full burst and a sustained below-rate cadence acquire with ZERO waiting", async () => {
    const { l, clock } = makeLimiter();
    // Whole burst at t=0 — instant.
    for (let i = 0; i < 10; i++) {
      const r = await l.acquire("trade");
      expect(r.ok).toBe(true);
      expect(r.waitedMs).toBe(0);
    }
    // Sustained cadence below the refill rate — still never a wait.
    for (let i = 0; i < 50; i++) {
      clock.advance(200); // 200ms @ 10 tokens/s = 2 tokens refilled per step
      const r = await l.acquire("trade");
      expect(r.ok).toBe(true);
      expect(r.waitedMs).toBe(0);
    }
    const m = l.metrics();
    expect(m.waits).toBe(0);
    expect(m.denials).toBe(0);
    expect(clock.sleeps.length).toBe(0); // the sleep seam was never touched
  });

  test("mixed classes at normal cadence: protect/trade/background all instant", async () => {
    const { l, clock } = makeLimiter();
    for (let i = 0; i < 20; i++) {
      clock.advance(500);
      for (const cls of ["protect", "trade", "background"] as const) {
        const r = await l.acquire(cls);
        expect(r.ok).toBe(true);
        expect(r.waitedMs).toBe(0);
      }
    }
    expect(l.metrics().waits).toBe(0);
  });
});

describe("priority classes — the shadow-stampede incident", () => {
  test("under a background stampede, protect NEVER waits (budget partitioning, not queue order)", async () => {
    // Slow refill so a drained bucket stays drained for the test's duration.
    const { l } = makeLimiter({ ratePerMinute: 60, maxWaitMs: { protect: 3_000, trade: 2_000, background: 500 } });

    // Background stampede: it may only drain the bucket down to the reserve
    // floor (2), i.e. 8 of these 30 succeed and the rest are denied — they
    // can never take the last tokens.
    let bgOk = 0;
    for (let i = 0; i < 30; i++) {
      const r = await l.acquire("background");
      if (r.ok) bgOk++;
    }
    expect(bgOk).toBe(8); // burst 10 − reserve 2

    // The stop-loss loop arrives mid-stampede: instant service, straight
    // into the protect debt allowance — zero waiting, no queue to sit in.
    for (let i = 0; i < 7; i++) { // tokens 2 → −5 (protectDebt)
      const r = await l.acquire("protect");
      expect(r.ok).toBe(true);
      expect(r.waitedMs).toBe(0);
    }

    // And the stampede stays locked out while protect was served.
    const afterBg = await l.acquire("background");
    expect(afterBg.ok).toBe(false);
    expect(afterBg.reason).toContain("budget exhausted");
  });

  test("trade is denied EXPLICITLY (bounded) when the budget cannot refill in time — never an unbounded block", async () => {
    const { l } = makeLimiter({ ratePerMinute: 60, maxWaitMs: { protect: 3_000, trade: 100, background: 500 } });
    for (let i = 0; i < 10; i++) await l.acquire("trade"); // drain the burst
    const r = await l.acquire("trade"); // needs ~1000ms of refill > 100ms bound
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("budget exhausted");
    expect(l.metrics().denials).toBe(1);
  });

  test("a bounded wait for refill is honored when it fits the class budget", async () => {
    const { l, clock } = makeLimiter({ ratePerMinute: 600 }); // 10/s → 100ms per token
    for (let i = 0; i < 10; i++) await l.acquire("trade");
    const r = await l.acquire("trade"); // waits ~100ms virtual for one token
    expect(r.ok).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(100);
    expect(clock.sleeps.length).toBeGreaterThan(0);
    expect(l.metrics().waits).toBe(1);
  });
});

describe("429 penalties and Retry-After", () => {
  test("Retry-After is respected exactly: trade waits out the venue's own window", async () => {
    const { l } = makeLimiter();
    l.notePenalty(429, 5_000); // venue said: 5s
    const r = await l.acquire("trade");
    expect(r.ok).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(5_000); // never shorter than the venue's window…
    expect(r.waitedMs).toBeLessThanOrEqual(6_000);    // …and EXACTLY it, not the 20s default (catches ignoring Retry-After)
    expect(l.metrics().http429).toBe(1);
  });

  test("a Retry-After beyond the class bound is an explicit pre-transmit denial", async () => {
    const { l } = makeLimiter(); // trade maxWait 10s
    l.notePenalty(429, 15_000);
    const r = await l.acquire("trade");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("http_429");
  });

  test("without Retry-After the per-status default window applies", async () => {
    const { l } = makeLimiter({ penalty429Ms: 400 });
    l.notePenalty(429);
    const r = await l.acquire("trade");
    expect(r.ok).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(400);
  });

  test("protect may BYPASS a 429 window (counted) — a single protective request is worth it", async () => {
    const { l } = makeLimiter();
    l.notePenalty(429, 10_000);
    const r = await l.acquire("protect");
    expect(r.ok).toBe(true);
    expect(r.waitedMs).toBe(0); // no queue, no wait — the incident's fix
    expect(l.metrics().protectBypasses).toBe(1);
  });

  test("retryAfterMsFromHeaders parses delta-seconds and rejects garbage", () => {
    expect(retryAfterMsFromHeaders(new Headers({ "retry-after": "7" }))).toBe(7_000);
    expect(retryAfterMsFromHeaders(new Headers({ "Retry-After": "0.5" }))).toBe(500);
    expect(retryAfterMsFromHeaders(new Headers({ "retry-after": "0" }))).toBeUndefined();
    expect(retryAfterMsFromHeaders(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterMsFromHeaders(new Headers())).toBeUndefined();
    expect(retryAfterMsFromHeaders(undefined)).toBeUndefined();
    expect(retryAfterMsFromHeaders(null)).toBeUndefined();
  });
});

describe("418 — Binance temporary IP ban", () => {
  test("freezes EVERYTHING, protect included (a banned request only extends the ban)", async () => {
    const { l } = makeLimiter(); // protect maxWait 3s < default 418 window 120s
    l.notePenalty(418);
    const p = await l.acquire("protect");
    expect(p.ok).toBe(false);
    expect(p.reason).toContain("http_418");
    const t = await l.acquire("trade");
    expect(t.ok).toBe(false);
    const m = l.metrics();
    expect(m.http418).toBe(1);
    expect(m.frozen).toBe(true);
    expect(m.protectBypasses).toBe(0); // no bypass exists for a ban
  });

  test("a short venue-provided ban window is waited out, then traffic resumes", async () => {
    const { l } = makeLimiter();
    l.notePenalty(418, 1_000);
    const r = await l.acquire("protect");
    expect(r.ok).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(1_000);
  });
});

describe("backoff jitter is bounded", () => {
  test("every pause is stretched by at most +10% (and at least the base wait)", async () => {
    const { l, clock } = makeLimiter({ jitter: () => 0.9999999 });
    l.notePenalty(429, 1_000);
    const r = await l.acquire("trade");
    expect(r.ok).toBe(true);
    expect(clock.sleeps.length).toBeGreaterThan(0);
    // First pause covers the 1000ms penalty: jittered into [1000, 1100].
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(1_000);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(1_100);
  });

  test("zero jitter sleeps exactly the required window", async () => {
    const { l, clock } = makeLimiter({ jitter: () => 0 });
    l.notePenalty(429, 1_000);
    await l.acquire("trade");
    expect(clock.sleeps[0]).toBe(1_000);
  });
});

describe("shared per venue — one bucket per broker account, never per instance", () => {
  test("getVenueRateLimiter returns the SAME instance for repeated calls on a venue", () => {
    const a = getVenueRateLimiter("binance_fapi");
    const b = getVenueRateLimiter("binance_fapi");
    expect(a).toBe(b);
  });

  test("different venues get different limiters (separate accounts, separate quotas)", () => {
    expect(getVenueRateLimiter("binance_fapi")).not.toBe(getVenueRateLimiter("binance_dapi"));
    expect(getVenueRateLimiter("alpaca")).not.toBe(getVenueRateLimiter("binance_fapi"));
  });

  test("two consumers of one venue draw from the SAME budget", async () => {
    // Simulates the two FAPI executor instances: tokens taken by one are
    // gone for the other.
    const { l } = makeLimiter({ burst: 4, ratePerMinute: 60, maxWaitMs: { protect: 3_000, trade: 10, background: 10 } });
    const consumerA = () => l.acquire("trade");
    const consumerB = () => l.acquire("trade");
    expect((await consumerA()).ok).toBe(true);
    expect((await consumerB()).ok).toBe(true);
    expect((await consumerA()).ok).toBe(true);
    expect((await consumerB()).ok).toBe(true);
    // Budget shared and now exhausted for BOTH.
    expect((await consumerA()).ok).toBe(false);
    expect((await consumerB()).ok).toBe(false);
  });
});

describe("disabled mode (shared singletons under bun test)", () => {
  test("acquire is a no-op but notePenalty still counts for observability", async () => {
    const { l } = makeLimiter({ disabled: true });
    const r = await l.acquire("trade");
    expect(r.ok).toBe(true);
    expect(r.waitedMs).toBe(0);
    l.notePenalty(429);
    l.notePenalty(418);
    const m = l.metrics();
    expect(m.acquires).toBe(0);
    expect(m.http429).toBe(1);
    expect(m.http418).toBe(1);
  });
});
