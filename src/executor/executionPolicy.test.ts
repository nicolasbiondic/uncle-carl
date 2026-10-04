// ══════════════════════════════════════════════
// Execution policy + limit chaser — invariants (2026-08-03)
// ══════════════════════════════════════════════
//
// The invariants under test are the spec's hard requirements:
//  - DEFAULT: no sleeve has a policy → executors behave exactly as today.
//  - Hysteresis: no reprice below refreshThresholdBps.
//  - Bounded reprices: at most maxReprices cancel/replace ops.
//  - A partially-filled order is NEVER cancel/replaced for price.
//  - Exits ALWAYS degrade to market after the bounded limit phase.
//  - Price clamp: never further than maxDistanceBps from the reference.
//  - Outcome taxonomy: unknown is neither a rejection nor a resend trigger.

import { describe, test, expect, afterEach } from "bun:test";
import {
  chaseLimit, chaseThenMarket, chaseTargetPrice, resolveExecutionPolicy,
  setExecutionPolicy, __clearExecutionPolicies, validatePolicy, isUnknownOrder,
  type ChaseVenue, type ChaseParams,
} from "./executionPolicy";
import { ALL_PROFILE_IDS } from "../config/riskProfiles";

afterEach(() => __clearExecutionPolicies());

// ── Fake clock: sleep advances virtual time, no real waiting ─────────────
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
  };
}

function params(over: Partial<ChaseParams> = {}): ChaseParams {
  const clock = fakeClock();
  return {
    side: "buy", qty: 10,
    offsetBps: 0, refreshThresholdBps: 5, maxReprices: 2, maxDistanceBps: 20,
    timeoutMs: 1_000, pollIntervalMs: 100,
    now: clock.now, sleep: clock.sleep,
    ...over,
  };
}

interface VenueLog { places: Array<{ px: number; qty: number; attempt: number }>; cancels: string[] }

/** Scriptable venue: `refs` yields reference prices in call order (last one
 *  repeats); `fetchScript` yields order states per fetch. */
function mockVenue(opts: {
  refs?: number[];
  fetch?: (ref: string, nthFetch: number) => { status: "working" | "filled" | "terminal"; filledQty: number; filledAvgPx: number } | null;
  cancel?: (ref: string) => { confirmed: boolean; filledQty: number; filledAvgPx: number };
  placeFail?: { outcome: "proven_failed" | "unknown"; reason: string };
}): { venue: ChaseVenue; log: VenueLog } {
  const log: VenueLog = { places: [], cancels: [] };
  let refCalls = 0;
  let fetchCalls = 0;
  let orderSeq = 0;
  const refs = opts.refs ?? [100];
  const venue: ChaseVenue = {
    minQty: 1,
    refPrice: async () => refs[Math.min(refCalls++, refs.length - 1)]!,
    roundPrice: (px) => Math.round(px * 100) / 100,
    place: async (px, qty, attempt) => {
      if (opts.placeFail) return { ok: false, ...opts.placeFail };
      log.places.push({ px, qty, attempt });
      return { ok: true, ref: `o${++orderSeq}` };
    },
    fetch: async (ref) => opts.fetch
      ? opts.fetch(ref, fetchCalls++)
      : { status: "working", filledQty: 0, filledAvgPx: 0 },
    cancel: async (ref) => {
      log.cancels.push(ref);
      return opts.cancel ? opts.cancel(ref) : { confirmed: true, filledQty: 0, filledAvgPx: 0 };
    },
  };
  return { venue, log };
}

// ── DEFAULT: no policy configured → market behavior everywhere ───────────

describe("default execution policy", () => {
  test("NO sleeve has a policy by default — every profile resolves undefined (market, exactly as today)", () => {
    delete process.env.EXECUTION_POLICY_JSON;
    __clearExecutionPolicies();
    for (const id of ALL_PROFILE_IDS) {
      expect(resolveExecutionPolicy(id)).toBeUndefined();
    }
    expect(resolveExecutionPolicy("anything_else")).toBeUndefined();
  });

  test("setExecutionPolicy activates and clears per sleeve", () => {
    const policy = validatePolicy({ entry: { style: "limit_chase", offsetBps: 0, refreshThresholdBps: 5, maxReprices: 1, maxDistanceBps: 20, timeoutMs: 1000 } })!;
    setExecutionPolicy("momentum_stocks", policy);
    expect(resolveExecutionPolicy("momentum_stocks")?.entry?.style).toBe("limit_chase");
    setExecutionPolicy("momentum_stocks", undefined);
    expect(resolveExecutionPolicy("momentum_stocks")).toBeUndefined();
  });

  test("validatePolicy drops invalid sections (fails toward market), never guesses", () => {
    expect(validatePolicy(null)).toBeNull();
    expect(validatePolicy({ entry: { style: "yolo" } })).toBeNull();
    expect(validatePolicy({ entry: { style: "limit_chase", offsetBps: "2" } })).toBeNull();
    const mixed = validatePolicy({
      entry: { style: "limit_chase", offsetBps: 1, refreshThresholdBps: 0, maxReprices: 1, maxDistanceBps: 20, timeoutMs: 1000 }, // invalid threshold
      exit: { style: "limit_then_market", offsetBps: 0, refreshThresholdBps: 5, maxReprices: 1, maxDistanceBps: 20, timeoutMs: 1000 },
    });
    expect(mixed?.entry).toBeUndefined();
    expect(mixed?.exit?.style).toBe("limit_then_market");
  });
});

// ── Clamp ────────────────────────────────────────────────────────────────

describe("chaseTargetPrice clamp (activation bounds / max distance)", () => {
  test("aggressive crossing offset is clamped to maxDistanceBps", () => {
    // buy, offset -50bps would cross to 100.5; clamp at +20bps → 100.2
    expect(chaseTargetPrice(100, "buy", -50, 20)).toBeCloseTo(100.2, 10);
    // sell, offset -50bps would cross to 99.5; clamp at -20bps → 99.8
    expect(chaseTargetPrice(100, "sell", -50, 20)).toBeCloseTo(99.8, 10);
  });
  test("passive offset within bounds is untouched", () => {
    expect(chaseTargetPrice(100, "buy", 10, 20)).toBeCloseTo(99.9, 10);
    expect(chaseTargetPrice(100, "sell", 10, 20)).toBeCloseTo(100.1, 10);
  });
});

// ── Chaser invariants ────────────────────────────────────────────────────

describe("chaseLimit", () => {
  test("immediate fill → confirmed with one placement", async () => {
    const { venue, log } = mockVenue({
      fetch: () => ({ status: "filled", filledQty: 10, filledAvgPx: 100 }),
    });
    const r = await chaseLimit(venue, params());
    expect(r.outcome).toBe("confirmed");
    expect(r.filledQty).toBe(10);
    expect(r.filledAvgPx).toBe(100);
    expect(log.places).toHaveLength(1);
    expect(r.repricesUsed).toBe(0);
  });

  test("HYSTERESIS: drift below refreshThresholdBps never reprices", async () => {
    // anchor 100; subsequent refs drift only 2bps (< 5bps threshold)
    const { venue, log } = mockVenue({ refs: [100, 100.02, 100.02, 100.02] });
    const r = await chaseLimit(venue, params({ timeoutMs: 500 }));
    expect(log.places).toHaveLength(1); // never replaced
    expect(r.repricesUsed).toBe(0);
    expect(r.outcome).toBe("proven_failed"); // timed out unfilled, cancel confirmed
    expect(log.cancels).toHaveLength(1); // only the final timeout cancel
  });

  test("drift beyond the threshold reprices — but never more than maxReprices", async () => {
    // every ref read drifts +100bps → would reprice forever without the cap
    const refs = [100, 101, 102.01, 103.03, 104.06, 105.1, 106.15];
    const { venue, log } = mockVenue({ refs });
    const r = await chaseLimit(venue, params({ maxReprices: 2, timeoutMs: 1_000 }));
    expect(r.repricesUsed).toBe(2);
    expect(log.places).toHaveLength(3); // initial + 2 replacements, no more
    // 2 reprice cancels + 1 final timeout cancel
    expect(log.cancels).toHaveLength(3);
  });

  test("a PARTIALLY-FILLED order is never cancel/replaced; remainder canceled at timeout and fills accounted", async () => {
    // massive drift every read — would trigger reprice if it were allowed
    const { venue, log } = mockVenue({
      refs: [100, 110, 120, 130],
      fetch: () => ({ status: "working", filledQty: 4, filledAvgPx: 100 }),
      cancel: () => ({ confirmed: true, filledQty: 4, filledAvgPx: 100 }),
    });
    const r = await chaseLimit(venue, params({ timeoutMs: 500 }));
    expect(log.places).toHaveLength(1);
    expect(r.repricesUsed).toBe(0);
    expect(log.cancels).toHaveLength(1); // ONLY the final timeout cancel
    expect(r.outcome).toBe("confirmed");
    expect(r.filledQty).toBe(4);
    expect(r.remainingQty).toBe(6);
  });

  test("cancel-race fills are settled and only the remainder is re-placed", async () => {
    const { venue, log } = mockVenue({
      refs: [100, 101, 101, 101],
      // order shows no fills while working…
      fetch: () => ({ status: "working", filledQty: 0, filledAvgPx: 0 }),
      // …but the reprice cancel discovers 3 filled just before it died
      cancel: (ref) => ref === "o1"
        ? { confirmed: true, filledQty: 3, filledAvgPx: 100 }
        : { confirmed: true, filledQty: 0, filledAvgPx: 0 },
    });
    const r = await chaseLimit(venue, params({ maxReprices: 1, timeoutMs: 500 }));
    expect(log.places).toHaveLength(2);
    expect(log.places[1]!.qty).toBe(7); // 10 − 3 settled from the canceled order
    expect(r.filledQty).toBe(3);
    expect(r.outcome).toBe("confirmed");
  });

  test("UNKNOWN: timeout with an unconfirmed cancel is never a rejection — danglingRef reported, nothing resent", async () => {
    const { venue, log } = mockVenue({
      cancel: () => ({ confirmed: false, filledQty: 0, filledAvgPx: 0 }),
    });
    const r = await chaseLimit(venue, params({ timeoutMs: 300 }));
    expect(r.outcome).toBe("unknown");
    expect(r.danglingRef).toBeDefined();
    expect(log.places).toHaveLength(1); // NO resend on unknown
  });

  test("an unconfirmed cancel during a reprice DISABLES further repricing (never two live orders)", async () => {
    const { venue, log } = mockVenue({
      refs: [100, 102, 104, 106, 108],
      cancel: () => ({ confirmed: false, filledQty: 0, filledAvgPx: 0 }),
    });
    const r = await chaseLimit(venue, params({ maxReprices: 5, timeoutMs: 800 }));
    expect(log.places).toHaveLength(1); // reprice wanted, cancel unconfirmed → no sibling
    expect(r.outcome).toBe("unknown");
  });

  test("place failure propagates its own outcome (proven vs unknown)", async () => {
    const proven = await chaseLimit(mockVenue({ placeFail: { outcome: "proven_failed", reason: "422" } }).venue, params());
    expect(proven.outcome).toBe("proven_failed");
    const unknown = await chaseLimit(mockVenue({ placeFail: { outcome: "unknown", reason: "timeout" } }).venue, params());
    expect(unknown.outcome).toBe("unknown");
  });

  test("no reference price → proven_failed before anything is placed", async () => {
    const { venue, log } = mockVenue({ refs: [0] });
    const r = await chaseLimit(venue, params());
    expect(r.outcome).toBe("proven_failed");
    expect(log.places).toHaveLength(0);
  });
});

// ── Exit: guaranteed degrade to market ───────────────────────────────────

describe("chaseThenMarket (exit guarantee)", () => {
  test("unfilled limit phase → market fallback ALWAYS invoked with the full remainder", async () => {
    const { venue } = mockVenue({});
    let marketQty = 0;
    const r = await chaseThenMarket(venue, params({ timeoutMs: 300 }), async (remaining) => {
      marketQty = remaining;
      return { ok: true, filledQty: remaining, filledAvgPx: 99.5 };
    });
    expect(marketQty).toBe(10);
    expect(r.marketAttempted).toBe(true);
    expect(r.marketOk).toBe(true);
    expect(r.outcome).toBe("confirmed");
    expect(r.filledQty).toBe(10);
    expect(r.filledAvgPx).toBeCloseTo(99.5, 10);
  });

  test("partial limit fill + market remainder combine into one weighted result", async () => {
    const { venue } = mockVenue({
      fetch: () => ({ status: "working", filledQty: 4, filledAvgPx: 100 }),
      cancel: () => ({ confirmed: true, filledQty: 4, filledAvgPx: 100 }),
    });
    const r = await chaseThenMarket(venue, params({ timeoutMs: 300 }), async (remaining) => ({
      ok: true, filledQty: remaining, filledAvgPx: 102,
    }));
    expect(r.limitFilledQty).toBe(4);
    expect(r.filledQty).toBe(10);
    expect(r.filledAvgPx).toBeCloseTo((4 * 100 + 6 * 102) / 10, 10);
  });

  test("market fallback runs even when the chase THROWS — being stuck polite is forbidden", async () => {
    const venue: ChaseVenue = {
      refPrice: async () => { throw new Error("venue exploded"); },
      roundPrice: (px) => px,
      place: async () => ({ ok: false, outcome: "proven_failed", reason: "unreachable" }),
      fetch: async () => null,
      cancel: async () => ({ confirmed: true, filledQty: 0, filledAvgPx: 0 }),
    };
    let called = false;
    const r = await chaseThenMarket(venue, params(), async (remaining) => {
      called = true;
      return { ok: true, filledQty: remaining, filledAvgPx: 98 };
    });
    expect(called).toBe(true);
    expect(r.outcome).toBe("confirmed");
  });

  test("full limit fill skips the market fallback entirely", async () => {
    const { venue } = mockVenue({ fetch: () => ({ status: "filled", filledQty: 10, filledAvgPx: 100.01 }) });
    let called = false;
    const r = await chaseThenMarket(venue, params(), async () => { called = true; return { ok: true, filledQty: 0, filledAvgPx: 0 }; });
    expect(called).toBe(false);
    expect(r.outcome).toBe("confirmed");
    expect(r.filledQty).toBe(10);
  });
});

describe("isUnknownOrder", () => {
  test("discriminates the unknown result from Orders and null", () => {
    expect(isUnknownOrder({ outcome: "unknown", reason: "x" })).toBe(true);
    expect(isUnknownOrder(null)).toBe(false);
    expect(isUnknownOrder({ id: "o", status: "filled" })).toBe(false);
  });
});
