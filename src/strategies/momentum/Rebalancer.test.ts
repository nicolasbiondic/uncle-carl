import { describe, expect, test } from "bun:test";
import { planRebalance, type CurrentPosition } from "./Rebalancer";
import { SLOT_DISPLACED_CLOSE_REASON } from "./MomentumEngine";
import type { MomentumDecision } from "./MomentumScorer";

function dec(symbol: string, action: MomentumDecision["action"], score = 0.05): MomentumDecision {
  return { symbol, action, score, rank: 0, reason: "test" };
}

function pos(symbol: string, side: "buy" | "sell", notional = 1000): CurrentPosition {
  return { symbol, side, quantity: 1, notional };
}

describe("planRebalance", () => {
  test("opens new positions when nothing is held", () => {
    const plan = planRebalance({
      decisions: [dec("BTC/USD", "long"), dec("ETH/USD", "long"), dec("XRP/USD", "flat")],
      currentPositions: [],
      notionalPerSlot: 1000,
    });
    expect(plan.actions).toEqual([
      { type: "open", symbol: "BTC/USD", side: "buy", notionalTarget: 1000, reason: "new target slot" },
      { type: "open", symbol: "ETH/USD", side: "buy", notionalTarget: 1000, reason: "new target slot" },
    ]);
    expect(plan.unchanged).toEqual([]);
  });

  test("keeps positions whose symbol+side still match target — no churn", () => {
    const plan = planRebalance({
      decisions: [dec("BTC/USD", "long"), dec("ETH/USD", "long")],
      currentPositions: [pos("BTC/USD", "buy"), pos("ETH/USD", "buy")],
      notionalPerSlot: 1000,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.unchanged.sort()).toEqual(["BTC/USD", "ETH/USD"]);
  });

  test("closes positions that left the target portfolio", () => {
    const plan = planRebalance({
      decisions: [dec("ETH/USD", "long")],
      currentPositions: [pos("BTC/USD", "buy"), pos("ETH/USD", "buy")],
      notionalPerSlot: 1000,
    });
    expect(plan.actions.length).toBe(1);
    expect(plan.actions[0]).toEqual({
      type: "close", symbol: "BTC/USD", side: "buy",
      reason: "symbol no longer in target portfolio",
    });
    expect(plan.unchanged).toEqual(["ETH/USD"]);
  });

  test("flipping a position emits both close and reopen on the new side", () => {
    const plan = planRebalance({
      decisions: [dec("BTC/USD", "short")],
      currentPositions: [pos("BTC/USD", "buy")],
      notionalPerSlot: 1000,
    });
    expect(plan.actions.length).toBe(2);
    expect(plan.actions[0]).toMatchObject({ type: "close", symbol: "BTC/USD", side: "buy" });
    expect(plan.actions[1]).toMatchObject({ type: "open", symbol: "BTC/USD", side: "sell" });
    expect(plan.actions[1].reason).toContain("side flip");
  });

  test("complex case: 1 hold, 1 close, 1 flip, 1 open", () => {
    const plan = planRebalance({
      decisions: [
        dec("HOLD",  "long"),
        dec("FLIP",  "short"),
        dec("NEW",   "long"),
        // GONE not in decisions = flat = close
      ],
      currentPositions: [
        pos("HOLD", "buy"),
        pos("FLIP", "buy"),
        pos("GONE", "buy"),
      ],
      notionalPerSlot: 500,
    });

    const closes = plan.actions.filter(a => a.type === "close");
    const opens = plan.actions.filter(a => a.type === "open");
    expect(closes.map(c => c.symbol).sort()).toEqual(["FLIP", "GONE"]);
    expect(opens.map(o => `${o.symbol}:${o.side}`).sort()).toEqual(["FLIP:sell", "NEW:buy"]);
    expect(plan.unchanged).toEqual(["HOLD"]);
  });

  test("notionalBySymbol overrides per-symbol, falls back to notionalPerSlot", () => {
    const plan = planRebalance({
      decisions: [dec("BTC/USD", "long"), dec("ETH/USD", "long")],
      currentPositions: [],
      notionalPerSlot: 1000,
      notionalBySymbol: new Map([["BTC/USD", 400]]), // ETH missing → fallback
    });
    const bySym = new Map(plan.actions.map(a => [a.symbol, a.notionalTarget]));
    expect(bySym.get("BTC/USD")).toBe(400);
    expect(bySym.get("ETH/USD")).toBe(1000);
  });

  test("displaced flat decision → close carries SLOT_DISPLACED closeReason; plain signal exit carries none", () => {
    const plan = planRebalance({
      decisions: [
        { ...dec("PUSHED", "flat"), displaced: true }, // still-valid held ranked out of top-N
        dec("EXITED", "flat"),                          // genuine signal exit
      ],
      currentPositions: [pos("PUSHED", "buy"), pos("EXITED", "buy")],
      notionalPerSlot: 1000,
    });
    const closes = plan.actions.filter(a => a.type === "close");
    expect(closes.map(c => c.symbol).sort()).toEqual(["EXITED", "PUSHED"]);
    const pushed = closes.find(c => c.symbol === "PUSHED")!;
    expect(pushed.closeReason).toBe(SLOT_DISPLACED_CLOSE_REASON);
    const exited = closes.find(c => c.symbol === "EXITED")!;
    // Key entirely absent (not just undefined) — non-displaced actions stay
    // byte-identical to the pre-field shape.
    expect("closeReason" in exited).toBe(false);
  });

  test("ignores flat decisions when planning new opens", () => {
    const plan = planRebalance({
      decisions: [dec("A", "flat"), dec("B", "flat")],
      currentPositions: [],
      notionalPerSlot: 1000,
    });
    expect(plan.actions).toEqual([]);
  });
});
