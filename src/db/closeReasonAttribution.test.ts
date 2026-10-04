import { describe, expect, test, beforeAll } from "bun:test";
import { getDB, getCloseReasonAttribution } from "./database";
import { makeTestDb } from "../test-support/db";

beforeAll(() => { makeTestDb(); });

let seq = 0;
function seedClose(o: {
  profile: string;
  closeReason: string | null;
  pnl: number;
  holdMs: number;
  exitTime?: number;
}) {
  const exit = o.exitTime ?? Date.now() - 60_000;
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity,
       entry_time, status, exit_time, pnl, pnl_pct, profile_id, account_id, close_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `cr_${seq++}`, "AAPL", "stock", "buy", "MOMENTUM", 100, 1,
    exit - o.holdMs, "closed", exit, o.pnl, o.pnl, o.profile, o.profile, o.closeReason,
  );
}

describe("getCloseReasonAttribution — Tanda 3 close-cause attribution", () => {
  beforeAll(() => {
    // TRAIL_STOP: 2 closes, avg pnl / avg hold computed below.
    seedClose({ profile: "momentum_stocks", closeReason: "TRAIL_STOP", pnl: 269.32, holdMs: 147 * 3_600_000 });
    seedClose({ profile: "momentum_stocks", closeReason: "TRAIL_STOP", pnl: 30.68, holdMs: 53 * 3_600_000 });
    // STOP_LOSS: 1 close, a loss.
    seedClose({ profile: "momentum_stocks", closeReason: "STOP_LOSS", pnl: -40, holdMs: 10 * 3_600_000 });
    // MOMENTUM_REBALANCE: 1 close.
    seedClose({ profile: "momentum_stocks", closeReason: "MOMENTUM_REBALANCE", pnl: 12, holdMs: 24 * 3_600_000 });
    // Reconcile/phantom rows — must be EXCLUDED entirely (RECONCILE_CLOSE_SQL reused).
    seedClose({ profile: "momentum_stocks", closeReason: "BROKER_GONE_404", pnl: 0, holdMs: 1_000 });
    seedClose({ profile: "momentum_stocks", closeReason: "MOMENTUM_RECONCILED", pnl: 0, holdMs: 1_000 });
    // Different sleeve — must not leak into the momentum_stocks-scoped query.
    seedClose({ profile: "meanrev_stocks", closeReason: "MEANREV_EXIT", pnl: 15, holdMs: 20 * 3_600_000 });
  });

  test("groups by close_reason, excluding reconcile/phantom rows via RECONCILE_CLOSE_SQL", () => {
    const rows = getCloseReasonAttribution("momentum_stocks", 365);
    const reasons = rows.map((r) => r.closeReason).sort();
    expect(reasons).toEqual(["MOMENTUM_REBALANCE", "STOP_LOSS", "TRAIL_STOP"].sort());
  });

  test("TRAIL_STOP aggregates count/totalPnl/avgPnl/avgHoldMs exactly", () => {
    const rows = getCloseReasonAttribution("momentum_stocks", 365);
    const trail = rows.find((r) => r.closeReason === "TRAIL_STOP")!;
    expect(trail.count).toBe(2);
    expect(trail.totalPnl).toBeCloseTo(269.32 + 30.68, 6);
    expect(trail.avgPnl).toBeCloseTo((269.32 + 30.68) / 2, 6);
    expect(trail.avgHoldMs).toBeCloseTo((147 * 3_600_000 + 53 * 3_600_000) / 2, 6);
  });

  test("STOP_LOSS bucket carries its (negative) P&L and its own hold time", () => {
    const rows = getCloseReasonAttribution("momentum_stocks", 365);
    const sl = rows.find((r) => r.closeReason === "STOP_LOSS")!;
    expect(sl.count).toBe(1);
    expect(sl.totalPnl).toBeCloseTo(-40, 6);
    expect(sl.avgHoldMs).toBeCloseTo(10 * 3_600_000, 6);
  });

  test("per-sleeve scoping: a different profile's exits don't leak in", () => {
    const rows = getCloseReasonAttribution("momentum_stocks", 365);
    expect(rows.some((r) => r.closeReason === "MEANREV_EXIT")).toBe(false);
    const meanrev = getCloseReasonAttribution("meanrev_stocks", 365);
    expect(meanrev.map((r) => r.closeReason)).toEqual(["MEANREV_EXIT"]);
  });

  test("the days window excludes trades closed before the cutoff", () => {
    seedClose({
      profile: "momentum_stocks", closeReason: "TIME_STOP", pnl: 5, holdMs: 3_600_000,
      exitTime: Date.now() - 400 * 86_400_000,
    });
    const within = getCloseReasonAttribution("momentum_stocks", 30);
    expect(within.some((r) => r.closeReason === "TIME_STOP")).toBe(false);
    const wide = getCloseReasonAttribution("momentum_stocks", 3650);
    expect(wide.some((r) => r.closeReason === "TIME_STOP")).toBe(true);
  });
});
