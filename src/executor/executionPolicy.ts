// ══════════════════════════════════════════════
// Execution policy — per-sleeve order execution style (2026-08-03)
// ══════════════════════════════════════════════
//
// Motivation: measured slippage of ~7bps flips momentum_stocks' sign of
// profitability, and today every entry/exit is a raw MARKET order. This
// module adds an OPT-IN limit-with-chasing policy per sleeve. With no policy
// configured for a sleeve, every executor path behaves EXACTLY as before
// (market orders) — fixed by executionPolicy.test.ts ("default is no policy")
// and the executors' "default = market" tests.
//
// Semantics distilled from the referenced implementations:
//  - Hummingbot LIMIT_CHASER {distance, refresh_threshold}: keep the order
//    at `offsetBps` from the reference price; only re-issue when the
//    reference drifted more than `refreshThresholdBps` (explicit hysteresis,
//    never cancel/replace ping-pong).
//  - Hummingbot activation_bounds / Freqtrade custom_price_max_distance_ratio:
//    hard clamp — a working order is never further than `maxDistanceBps`
//    from the current reference.
//  - Freqtrade adjust_order_price: bounded repricings per cycle; NEVER
//    replace a partially-filled order (account the fills; decide about the
//    remainder — adjust size, not price).
//  - Freqtrade unfilledtimeout + exit_timeout_count → emergency_exit: an
//    EXIT degrades to MARKET after a bounded timeout, GUARANTEED. A position
//    that cannot close is worse than paying the spread (chaseThenMarket).
//  - NautilusTrader command outcomes: confirmed | proven_failed | unknown.
//    Unknown (timeouts, disconnects, retries exhausted, parse failures after
//    transmit) is NEVER a rejection and NEVER triggers an immediate resend —
//    it resolves by QUERY on the idempotent client_order_id, or by the
//    reconciliation loops (BrokerSync / AccountManager syncs).

import { createLogger } from "../utils/logger";

const log = createLogger("ExecutionPolicy");

// ── Order outcome taxonomy (NautilusTrader-style, three states) ──────────

/**
 * - "confirmed":     the venue confirmed the command (order accepted/filled).
 * - "proven_failed": a DEMONSTRABLE local/venue rejection (validation error,
 *                    HTTP 4xx with a venue error body, confirmed cancel with
 *                    zero fills). Safe to treat as "did not happen".
 * - "unknown":       transmitted (or possibly transmitted) but never
 *                    confirmed: network timeout, disconnect, 5xx, parse
 *                    failure, resolution queries exhausted. MUST NOT be
 *                    treated as a rejection and MUST NOT trigger a resend —
 *                    resolve by querying the idempotent client_order_id or
 *                    leave it to reconciliation.
 */
export type OrderOutcome = "confirmed" | "proven_failed" | "unknown";

/** Returned by executor submit paths instead of `null` when the order's fate
 *  is genuinely unknown. `null` keeps meaning proven_failed (today's
 *  contract); an UnknownOrderResult means "possibly live on the broker —
 *  do NOT resend, do NOT record as rejected". */
export interface UnknownOrderResult {
  outcome: "unknown";
  reason: string;
  /** The idempotent id a later reconciliation query can resolve by. */
  clientOrderId?: string;
}

export function isUnknownOrder(x: unknown): x is UnknownOrderResult {
  return !!x && typeof x === "object" && (x as any).outcome === "unknown";
}

// ── Policy shape ─────────────────────────────────────────────────────────

export interface EntryExecutionConfig {
  style: "limit_chase";
  /** Distance from the reference (side touch) toward the PASSIVE side, in
   *  bps. Positive = behind the touch (maker-ish); negative = cross through.
   *  Always clamped by maxDistanceBps. */
  offsetBps: number;
  /** Hysteresis: only reprice when the reference drifted ≥ this many bps
   *  from the price basis of the working order. */
  refreshThresholdBps: number;
  /** Max cancel/replace operations per chase cycle. */
  maxReprices: number;
  /** Hard clamp: submitted price always within this many bps of the current
   *  reference, both sides. */
  maxDistanceBps: number;
  /** Total chase budget. At timeout the remainder is canceled and whatever
   *  filled is accounted. */
  timeoutMs: number;
  pollIntervalMs?: number;
  /** OPT-IN abort: if the pre-trade book-VWAP impact estimate exceeds this,
   *  the ENTRY is aborted (logged loudly). ABSENT = never abort (default —
   *  we measure before we gate; see bookDepth.ts). */
  maxEstImpactBps?: number;
  /**
   * Minimum fraction of the requested qty a chased ENTRY must fill to count
   * as a position (default MIN_ENTRY_FILL_FRACTION). Below it the sliver is
   * flattened and the entry reported as a plain rejection.
   *
   * WHY (2026-09-05, momentum_crypto_usdc): the chase's only rejection test
   * was `filledQty <= 0`, so a 0.4% fill came back as a completed order and
   * was persisted as a position. Live result over 7 days: entry notionals of
   * $7 / $44 / $99 against a ~$1,870 slot, average deployment $902 — half
   * the intended size, in fragments, each one occupying a slot, paying fees
   * and carrying a stop sized for a position that does not exist. The
   * sleeve's own fill telemetry indicts those slivers: the <$1k bucket fills
   * at 4.7bps median slippage and 62.9s median latency versus 0.2bps / 1.0s
   * for the full-size fills — dust is both slower AND dearer.
   *
   * The observed distribution has a clean gap (fills are either ~100% or
   * ≤35% of target), so the default sits at 0.5: below half the intended
   * size the position's economics are distorted enough that not trading is
   * the better outcome. Exits are NOT subject to this — a partial exit is
   * risk removed, and the exit path keeps its guaranteed market fallback.
   */
  minFillFraction?: number;
}

/** Default for {@link EntryExecutionConfig.minFillFraction}. */
export const MIN_ENTRY_FILL_FRACTION = 0.5;

export interface ExitExecutionConfig {
  style: "limit_then_market";
  offsetBps: number;
  refreshThresholdBps: number;
  maxReprices: number;
  maxDistanceBps: number;
  /** Bounded limit phase; after this the remainder goes MARKET, guaranteed
   *  (chaseThenMarket). This is the non-negotiable exit invariant. */
  timeoutMs: number;
  pollIntervalMs?: number;
}

export interface ExecutionPolicy {
  entry?: EntryExecutionConfig;
  exit?: ExitExecutionConfig;
}

// ── Registry (default: EMPTY — every sleeve trades market, exactly as
//    before). Populated only via setExecutionPolicy() or the
//    EXECUTION_POLICY_JSON env var. ──────────────────────────────────────

const registry = new Map<string, ExecutionPolicy>();
let envLoaded = false;

function finite(n: unknown): n is number { return typeof n === "number" && Number.isFinite(n); }

function validateEntry(e: any): EntryExecutionConfig | null {
  if (!e || e.style !== "limit_chase") return null;
  if (![e.offsetBps, e.refreshThresholdBps, e.maxReprices, e.maxDistanceBps, e.timeoutMs].every(finite)) return null;
  if (!(e.refreshThresholdBps > 0) || !(e.maxDistanceBps > 0) || !(e.timeoutMs > 0) || e.maxReprices < 0) return null;
  if (e.maxEstImpactBps !== undefined && !finite(e.maxEstImpactBps)) return null;
  // A nonsensical threshold is DROPPED to the default rather than guessed —
  // same fail-toward-safe rule the rest of this validator follows. >1 would
  // reject every fill; <0 would disable the guard silently.
  if (e.minFillFraction !== undefined &&
      (!finite(e.minFillFraction) || e.minFillFraction < 0 || e.minFillFraction > 1)) {
    delete e.minFillFraction;
  }
  return e as EntryExecutionConfig;
}

function validateExit(e: any): ExitExecutionConfig | null {
  if (!e || e.style !== "limit_then_market") return null;
  if (![e.offsetBps, e.refreshThresholdBps, e.maxReprices, e.maxDistanceBps, e.timeoutMs].every(finite)) return null;
  if (!(e.refreshThresholdBps > 0) || !(e.maxDistanceBps > 0) || !(e.timeoutMs > 0) || e.maxReprices < 0) return null;
  return e as ExitExecutionConfig;
}

/** Validate a raw policy object; null when nothing valid remains. An invalid
 *  section is DROPPED (fail toward market — the conservative default),
 *  never guessed. */
export function validatePolicy(raw: any): ExecutionPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = validateEntry(raw.entry) ?? undefined;
  const exit = validateExit(raw.exit) ?? undefined;
  if (!entry && !exit) return null;
  return { entry, exit };
}

function loadEnvPolicies(): void {
  if (envLoaded) return;
  envLoaded = true;
  const rawJson = process.env.EXECUTION_POLICY_JSON;
  if (!rawJson) return;
  try {
    const parsed = JSON.parse(rawJson);
    for (const [accountId, rawPolicy] of Object.entries(parsed ?? {})) {
      const policy = validatePolicy(rawPolicy);
      if (policy) {
        registry.set(accountId, policy);
        log.warn(`execution policy ACTIVE for ${accountId}: entry=${policy.entry?.style ?? "market"} exit=${policy.exit?.style ?? "market"}`);
      } else {
        log.error(`EXECUTION_POLICY_JSON entry for ${accountId} is invalid — ignored, sleeve stays on market orders`);
      }
    }
  } catch (e: any) {
    log.error(`EXECUTION_POLICY_JSON unparseable (${e.message}) — ALL sleeves stay on market orders`);
  }
}

/** Set (or clear, with undefined) a sleeve's policy programmatically. */
export function setExecutionPolicy(accountId: string, policy: ExecutionPolicy | undefined): void {
  loadEnvPolicies();
  if (policy === undefined) registry.delete(accountId);
  else registry.set(accountId, policy);
}

/** The sleeve's policy, or undefined = behave exactly as today (market). */
export function resolveExecutionPolicy(accountId: string): ExecutionPolicy | undefined {
  loadEnvPolicies();
  return registry.get(accountId);
}

/** TEST-ONLY: wipe every configured policy (also re-arms env loading). */
export function __clearExecutionPolicies(): void {
  registry.clear();
  envLoaded = true; // don't re-read env mid-test unless a test resets it
}

// ── Generic limit chaser ─────────────────────────────────────────────────

/** Minimal venue surface the chaser needs. Implemented privately by each
 *  executor; the chaser itself is broker-agnostic and unit-tested against a
 *  mock venue (executionPolicy.test.ts). */
export interface ChaseVenue {
  /** Current reference price (side touch). ≤0 = unavailable right now. */
  refPrice(): Promise<number>;
  /** Round a candidate limit price to the venue's grid, protectively
   *  (buy rounds down, sell rounds up). */
  roundPrice(px: number, side: "buy" | "sell"): number;
  /** Place a limit order for `qty` at `px`. `attempt` is 0 for the first
   *  placement, then increments per replacement (lets the venue salt
   *  client ids). */
  place(px: number, qty: number, attempt: number): Promise<
    { ok: true; ref: string } | { ok: false; outcome: Exclude<OrderOutcome, "confirmed">; reason: string }
  >;
  /** Current state of a working order. null = read failed (unknown — the
   *  chaser keeps polling until its deadline). */
  fetch(ref: string): Promise<{ status: "working" | "filled" | "terminal"; filledQty: number; filledAvgPx: number } | null>;
  /** Cancel and settle: confirmed=true means the order is TERMINAL and the
   *  returned fills are its final accounting. confirmed=false = state
   *  unknown (may still be live). */
  cancel(ref: string): Promise<{ confirmed: boolean; filledQty: number; filledAvgPx: number }>;
  /** Optional: remainder below this is not worth re-placing. */
  minQty?: number;
}

export interface ChaseParams {
  side: "buy" | "sell";
  qty: number;
  offsetBps: number;
  refreshThresholdBps: number;
  maxReprices: number;
  maxDistanceBps: number;
  timeoutMs: number;
  pollIntervalMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ChaseResult {
  outcome: OrderOutcome;
  filledQty: number;
  /** Weighted average across every order of the chase. 0 when nothing filled. */
  filledAvgPx: number;
  remainingQty: number;
  repricesUsed: number;
  /** Every broker order ref this chase created (for commission attribution). */
  orderRefs: string[];
  reason?: string;
  /** Set when outcome === "unknown" and an order may STILL be live on the
   *  venue — callers must resolve by query/reconciliation, never resend. */
  danglingRef?: string;
}

/** Passive-offset target price, clamped to ±maxDistanceBps of the reference
 *  (activation-bounds/custom_price_max_distance_ratio semantics). Exported
 *  for direct unit testing. */
export function chaseTargetPrice(ref: number, side: "buy" | "sell", offsetBps: number, maxDistanceBps: number): number {
  const raw = side === "buy" ? ref * (1 - offsetBps / 10_000) : ref * (1 + offsetBps / 10_000);
  const lo = ref * (1 - maxDistanceBps / 10_000);
  const hi = ref * (1 + maxDistanceBps / 10_000);
  return Math.min(hi, Math.max(lo, raw));
}

/**
 * Chase a limit order toward fill. Invariants (each unit-tested):
 *  - repricing ONLY when |ref drift| ≥ refreshThresholdBps (hysteresis);
 *  - at most maxReprices cancel/replace operations;
 *  - an order with ANY partial fill is NEVER cancel/replaced for price — it
 *    rests until fill or timeout, then only the remainder is canceled;
 *  - an unconfirmed cancel stops all further repricing (never two possibly
 *    live orders at once) and, if still unresolved at the deadline, returns
 *    outcome "unknown" with danglingRef (resolution by query, NOT resend).
 */
export async function chaseLimit(venue: ChaseVenue, params: ChaseParams): Promise<ChaseResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const poll = params.pollIntervalMs ?? 1_000;
  const minQty = venue.minQty ?? 0;

  // Fills already settled from terminal (canceled/replaced) orders.
  let settledQty = 0;
  let settledNotional = 0;
  let repricesUsed = 0;
  const orderRefs: string[] = [];

  const totals = (liveQty: number, liveAvgPx: number) => {
    const qty = settledQty + liveQty;
    const notional = settledNotional + liveQty * liveAvgPx;
    return { qty, avg: qty > 0 ? notional / qty : 0 };
  };
  const result = (outcome: OrderOutcome, liveQty: number, liveAvgPx: number, reason?: string, danglingRef?: string): ChaseResult => {
    const t = totals(liveQty, liveAvgPx);
    return {
      outcome, filledQty: t.qty, filledAvgPx: t.avg,
      remainingQty: Math.max(0, params.qty - t.qty),
      repricesUsed, orderRefs, reason, danglingRef,
    };
  };

  const ref0 = await venue.refPrice();
  if (!(ref0 > 0)) return result("proven_failed", 0, 0, "no reference price");
  let anchor = ref0;

  const placeAt = async (refPx: number, qty: number): Promise<{ ok: true; ref: string } | ChaseResult> => {
    const px = venue.roundPrice(chaseTargetPrice(refPx, params.side, params.offsetBps, params.maxDistanceBps), params.side);
    const placed = await venue.place(px, qty, orderRefs.length);
    if (!placed.ok) {
      // Fills already settled make this a partial success; otherwise the
      // placement's own outcome propagates.
      return result(settledQty > 0 ? "confirmed" : placed.outcome, 0, 0, placed.reason);
    }
    orderRefs.push(placed.ref);
    return placed;
  };

  const first = await placeAt(anchor, params.qty);
  if (!("ok" in first)) return first;
  let currentRef = first.ref;
  let repricingDisabled = false;

  const deadline = now() + params.timeoutMs;
  let lastSeenQty = 0;
  let lastSeenAvg = 0;

  while (now() < deadline) {
    await sleep(poll);
    const st = await venue.fetch(currentRef);
    if (st === null) continue; // read failure — bounded by the deadline
    lastSeenQty = st.filledQty;
    lastSeenAvg = st.filledAvgPx;

    if (st.status === "filled") return result("confirmed", st.filledQty, st.filledAvgPx);
    if (st.status === "terminal") {
      // Died externally (venue cancel/expiry). Account fills; never resend here.
      return st.filledQty > 0 || settledQty > 0
        ? result("confirmed", st.filledQty, st.filledAvgPx, "order terminal with partial fill")
        : result("proven_failed", 0, 0, "order terminal unfilled");
    }

    // working —
    const partiallyFilled = st.filledQty > 0;
    if (partiallyFilled || repricingDisabled || repricesUsed >= params.maxReprices) continue;

    const refNow = await venue.refPrice();
    if (!(refNow > 0)) continue;
    const driftBps = Math.abs(refNow - anchor) / anchor * 10_000;
    if (driftBps < params.refreshThresholdBps) continue; // hysteresis

    const canceled = await venue.cancel(currentRef);
    if (!canceled.confirmed) {
      // The old order may still be live: NEVER place a sibling. Keep polling
      // this one until the deadline.
      repricingDisabled = true;
      continue;
    }
    // Cancel-race fills (the order filled some just before dying) are settled.
    settledQty += canceled.filledQty;
    settledNotional += canceled.filledQty * canceled.filledAvgPx;
    const remaining = params.qty - settledQty;
    if (remaining <= minQty || remaining <= 0) {
      return result(settledQty > 0 ? "confirmed" : "proven_failed", 0, 0, "remainder below minQty after cancel-race fills");
    }
    repricesUsed++;
    anchor = refNow;
    const replaced = await placeAt(anchor, remaining);
    if (!("ok" in replaced)) return replaced;
    currentRef = replaced.ref;
    lastSeenQty = 0;
    lastSeenAvg = 0;
  }

  // Timeout: cancel the remainder, settle what filled.
  const finalCancel = await venue.cancel(currentRef);
  if (!finalCancel.confirmed) {
    return result("unknown", lastSeenQty, lastSeenAvg, "timeout; cancel unconfirmed — order may still be live", currentRef);
  }
  const liveQty = finalCancel.filledQty;
  const liveAvg = finalCancel.filledAvgPx;
  return settledQty + liveQty > 0
    ? result("confirmed", liveQty, liveAvg, "timeout; partial fill accounted, remainder canceled")
    : result("proven_failed", 0, 0, "timeout; nothing filled, order canceled");
}

// ── Exit helper: limit phase, then GUARANTEED market fallback ────────────

export interface MarketFallbackFill {
  ok: boolean;
  filledQty: number;
  filledAvgPx: number;
  reason?: string;
}

export interface ChaseThenMarketResult {
  /** Combined weighted fills across the limit phase + market fallback. */
  filledQty: number;
  filledAvgPx: number;
  limitFilledQty: number;
  marketAttempted: boolean;
  marketOk: boolean;
  outcome: OrderOutcome;
  reason?: string;
}

/**
 * EXIT execution: bounded limit chase, then the remainder ALWAYS goes to
 * `marketFallback` — even if the chase throws, and even if the chase ended
 * "unknown" (one extra cancel attempt is made first; a still-live limit
 * order will make the market close bounce off the venue, which the caller's
 * retry loop handles — being stuck polite is the one forbidden state).
 */
export async function chaseThenMarket(
  venue: ChaseVenue,
  params: ChaseParams,
  marketFallback: (remainingQty: number) => Promise<MarketFallbackFill>,
): Promise<ChaseThenMarketResult> {
  let chase: ChaseResult;
  try {
    chase = await chaseLimit(venue, params);
  } catch (e: any) {
    chase = {
      outcome: "unknown", filledQty: 0, filledAvgPx: 0, remainingQty: params.qty,
      repricesUsed: 0, orderRefs: [], reason: `chase threw: ${e?.message ?? e}`,
    };
  }
  if (chase.outcome === "unknown" && chase.danglingRef) {
    // One extra settle attempt before going to market.
    try {
      const c = await venue.cancel(chase.danglingRef);
      if (c.confirmed) {
        chase = {
          ...chase,
          outcome: c.filledQty + chase.filledQty > 0 ? "confirmed" : "proven_failed",
          filledQty: Math.max(chase.filledQty, c.filledQty),
          filledAvgPx: c.filledQty > 0 ? c.filledAvgPx : chase.filledAvgPx,
          danglingRef: undefined,
        };
        chase = { ...chase, remainingQty: Math.max(0, params.qty - chase.filledQty) };
      }
    } catch { /* still unknown — market fallback proceeds regardless */ }
  }

  const remaining = Math.max(0, params.qty - chase.filledQty);
  if (remaining <= 0) {
    return {
      filledQty: chase.filledQty, filledAvgPx: chase.filledAvgPx,
      limitFilledQty: chase.filledQty, marketAttempted: false, marketOk: false,
      outcome: "confirmed", reason: chase.reason,
    };
  }

  const mkt = await marketFallback(remaining);
  const totalQty = chase.filledQty + (mkt.ok ? mkt.filledQty : 0);
  const totalNotional = chase.filledQty * chase.filledAvgPx + (mkt.ok ? mkt.filledQty * mkt.filledAvgPx : 0);
  return {
    filledQty: totalQty,
    filledAvgPx: totalQty > 0 ? totalNotional / totalQty : 0,
    limitFilledQty: chase.filledQty,
    marketAttempted: true,
    marketOk: mkt.ok,
    outcome: mkt.ok ? "confirmed" : (chase.filledQty > 0 ? "confirmed" : (chase.outcome === "unknown" ? "unknown" : "proven_failed")),
    reason: mkt.ok ? chase.reason : (mkt.reason ?? chase.reason),
  };
}
