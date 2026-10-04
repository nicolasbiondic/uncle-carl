// ══════════════════════════════════════════════
// reconcile-orphan-exposure — the P0 guardrails (2026-08-19 LINK incident):
//   1. NEVER closes more than the orphan delta (broker − tracked rows);
//      the prod case verbatim: broker 785.75 / row 198 → closes 587.75.
//   2. FAIL-CLOSED: any drift between plan and execution-time re-read
//      aborts — the market moving is never "close and hope".
//   3. Idempotent: a second run (or a replayed stale plan) closes nothing.
//   4. Fully-untracked symbols are skipped, never closed (live reconciler's
//      protect-then-adopt territory).
//   5. Stale-stop detection matches the orphan's leftovers only, never a
//      tracked row's protective stop.
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import {
  planOrphanCloses, applyOrphanClose, isStaleOrphanStop,
  type OrphanPlan, type ApplyDeps,
} from "./reconcile-orphan-exposure";

const toInternal = (s: string) => (s === "LINKUSDT" ? "LINK/USD" : s === "SOLUSDT" ? "SOL/USD" : null);
const linkRow = { symbol: "LINK/USD", market: "crypto", quantity: 198, account_id: "momentum_crypto" };
const linkBroker = { symbol: "LINKUSDT", positionAmt: 785.75, entryPrice: 9.267531784918868, unrealizedProfit: 921.26 };

describe("planOrphanCloses", () => {
  test("prod LINK case verbatim: broker 785.75 / tracked 198 → close 587.75, keep 198", () => {
    const { plans, skipped } = planOrphanCloses([linkRow], [linkBroker], toInternal);
    expect(skipped).toHaveLength(0);
    expect(plans).toHaveLength(1);
    expect(plans[0].orphanQty).toBeCloseTo(587.75, 8);
    expect(plans[0].trackedQty).toBe(198);
    expect(plans[0].side).toBe("buy");
    // notional sanity: mark recovered from entry + uPnL/amt ≈ 10.44
    expect(plans[0].markPrice).toBeCloseTo(9.267531784918868 + 921.26 / 785.75, 6);
  });

  test("broker == tracked → no plan (SOL prod case)", () => {
    const { plans } = planOrphanCloses(
      [{ symbol: "SOL/USD", market: "crypto", quantity: 22.32, account_id: "momentum_crypto" }],
      [{ symbol: "SOLUSDT", positionAmt: 22.32, entryPrice: 82.43, unrealizedProfit: 44.42 }],
      toInternal,
    );
    expect(plans).toHaveLength(0);
  });

  test("broker < tracked (rows exceed broker) → no plan, never a negative close", () => {
    const { plans } = planOrphanCloses(
      [{ ...linkRow, quantity: 900 }],
      [linkBroker],
      toInternal,
    );
    expect(plans).toHaveLength(0);
  });

  test("fully-untracked symbol is SKIPPED, never planned", () => {
    const { plans, skipped } = planOrphanCloses([], [linkBroker], toInternal);
    expect(plans).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("fully untracked");
  });

  test("shadow_* rows do not count as tracked (they have no broker position)", () => {
    const shadow = { symbol: "LINK/USD", market: "crypto", quantity: 189.68, account_id: "shadow_carry" };
    const { plans, skipped } = planOrphanCloses([shadow], [linkBroker], toInternal);
    expect(plans).toHaveLength(0); // tracked=0 → fully-untracked path, skipped
    expect(skipped).toHaveLength(1);
  });

  test("unmapped broker symbol is skipped (not ours to manage)", () => {
    const { plans, skipped } = planOrphanCloses([linkRow], [{ ...linkBroker, symbol: "PEPEUSDT" }], toInternal);
    expect(plans).toHaveLength(0);
    expect(skipped[0].reason).toContain("no internal symbol mapping");
  });
});

function makePlan(overrides: Partial<OrphanPlan> = {}): OrphanPlan {
  return {
    internalSymbol: "LINK/USD", brokerSymbol: "LINKUSDT", side: "buy",
    brokerAbs: 785.75, trackedQty: 198, orphanQty: 587.75,
    markPrice: 10.44, orphanNotionalUsd: 587.75 * 10.44, ...overrides,
  };
}

function deps(overrides: Partial<ApplyDeps> & { closes?: Array<[string, number, string]> } = {}): ApplyDeps {
  const closes = overrides.closes ?? [];
  return {
    readBrokerAbs: overrides.readBrokerAbs ?? (async () => 785.75),
    readTrackedQty: overrides.readTrackedQty ?? (async () => 198),
    closePosition: overrides.closePosition ?? (async (sym, qty, side) => {
      closes.push([sym, qty, side]);
      return { success: true, filledPrice: 10.44 };
    }),
  };
}

describe("applyOrphanClose — fail-closed execution", () => {
  test("closes EXACTLY the orphan delta and verifies broker == tracked after", async () => {
    const closes: Array<[string, number, string]> = [];
    let closed = false;
    const d = deps({
      closes,
      readBrokerAbs: async () => (closed ? 198 : 785.75), // post-close re-read sees the tracked remainder
      closePosition: async (sym, qty, side) => {
        closes.push([sym, qty, side]);
        closed = true;
        return { success: true, filledPrice: 10.44 };
      },
    });
    const res = await applyOrphanClose(d, makePlan());
    expect(closes).toEqual([["LINK/USD", 587.75, "buy"]]); // never 785.75, never the row's 198
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.remainingAfter).toBe(198);
  });

  test("ABORTS (nothing transmitted) when the broker qty moved between plan and execution", async () => {
    const closes: Array<[string, number, string]> = [];
    const d = deps({ closes, readBrokerAbs: async () => 700.0 }); // a stop/manual close reduced it
    const res = await applyOrphanClose(d, makePlan());
    expect(res.ok).toBe(false);
    expect(res.aborted).toContain("broker qty moved");
    expect(closes).toHaveLength(0);
  });

  test("ABORTS when the tracked rows changed (the bot traded under us)", async () => {
    const closes: Array<[string, number, string]> = [];
    const d = deps({ closes, readTrackedQty: async () => 0 }); // row closed meanwhile
    const res = await applyOrphanClose(d, makePlan());
    expect(res.ok).toBe(false);
    expect(res.aborted).toContain("tracked rows changed");
    expect(closes).toHaveLength(0);
  });

  test("idempotent: replaying the SAME stale plan after a successful run aborts — can never close twice", async () => {
    // After the first run the broker holds only the tracked 198.
    const closes: Array<[string, number, string]> = [];
    const d = deps({ closes, readBrokerAbs: async () => 198 });
    const res = await applyOrphanClose(d, makePlan());
    expect(res.ok).toBe(false);
    expect(res.aborted).toContain("broker qty moved");
    expect(closes).toHaveLength(0);
    // …and a fresh re-plan finds no orphan at all:
    const { plans } = planOrphanCloses(
      [linkRow],
      [{ symbol: "LINKUSDT", positionAmt: 198, entryPrice: 9.49, unrealizedProfit: 188 }],
      toInternal,
    );
    expect(plans).toHaveLength(0);
  });

  test("an unconfirmed close is reported as closeFailed, never as verified", async () => {
    const d = deps({ closePosition: async () => ({ success: false, filledPrice: 0 }) });
    const res = await applyOrphanClose(d, makePlan());
    expect(res.ok).toBe(false);
    expect(res.closeFailed).toContain("VERIFY BROKER STATE MANUALLY");
  });

  test("a close that leaves the wrong remainder is NOT verified", async () => {
    let reads = 0;
    const d = deps({ readBrokerAbs: async () => (++reads === 1 ? 785.75 : 300) }); // partial fill / drift
    const res = await applyOrphanClose(d, makePlan());
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
  });
});

describe("isStaleOrphanStop — cancels the orphan's leftovers, never the tracked stop", () => {
  const rowQtys = [198];
  test("prod case: the 11-Aug row's leftover stop (192.57 @ 8.238) is stale", () => {
    expect(isStaleOrphanStop({ quantity: 192.57, reduceOnly: true, type: "STOP_MARKET" }, rowQtys)).toBe(true);
  });
  test("the tracked row's protective stop (qty=198) is KEPT", () => {
    expect(isStaleOrphanStop({ quantity: 198, reduceOnly: true, type: "STOP_MARKET" }, rowQtys)).toBe(false);
  });
  test("whole-position stops (qty=0), non-reduceOnly and non-STOP orders are KEPT", () => {
    expect(isStaleOrphanStop({ quantity: 0, reduceOnly: true, type: "STOP_MARKET" }, rowQtys)).toBe(false);
    expect(isStaleOrphanStop({ quantity: 192.57, reduceOnly: false, type: "STOP_MARKET" }, rowQtys)).toBe(false);
    expect(isStaleOrphanStop({ quantity: 192.57, reduceOnly: true, type: "LIMIT" }, rowQtys)).toBe(false);
  });
  test("a stop matching the tracked TOTAL across rows is kept", () => {
    expect(isStaleOrphanStop({ quantity: 300, reduceOnly: true, type: "STOP_MARKET" }, [100, 200])).toBe(false);
  });
});
