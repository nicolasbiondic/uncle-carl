// Retention floors (2026-10-22 ops review): orders, fills, decision passes and
// activity events must survive ≥ 90 days — an incident review of the last month
// found September already gone from the logs and only 3 order rows in its window.
// Companion: scripts/retention.test.ts pins the log rotation (≥ 90 days).
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_LOG_RETENTION_MS, DECISION_PASS_RETENTION_MS, ORPHAN_ORDER_RETENTION_MS, PNL_WINDOW_MARKS_RETENTION_MS,
  getDB, getPnlWindowMarks, insertTrade, pruneOldData, pruneOrphanOrders, recordFill, savePnlWindowMarks,
} from "./database";
import { makeTestDb } from "../test-support/db";

const DAY = 86_400_000;

beforeEach(() => { makeTestDb(); });

function insertOrder(id: string, createdAt: number) {
  getDB().prepare(
    `INSERT INTO orders (id, symbol, market, side, type, quantity, price, status, created_at, updated_at, account_id)
     VALUES (?, 'AAPL', 'stock', 'buy', 'market', 1, 100, 'REJECTED', ?, ?, 'momentum_stocks')`,
  ).run(id, createdAt, createdAt);
}
const orderIds = () => (getDB().prepare(`SELECT id FROM orders ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

describe("retention floors are at least 90 days", () => {
  test("constants", () => {
    expect(ORPHAN_ORDER_RETENTION_MS).toBeGreaterThanOrEqual(90 * DAY);
    expect(ACTIVITY_LOG_RETENTION_MS).toBeGreaterThanOrEqual(90 * DAY);
    expect(DECISION_PASS_RETENTION_MS).toBeGreaterThanOrEqual(90 * DAY);
    expect(PNL_WINDOW_MARKS_RETENTION_MS).toBeGreaterThanOrEqual(90 * DAY);
  });

  test("pnl_window_marks: a 60-day-old window start survives the periodic prune, a 100-day-old one goes", () => {
    const now = Date.now();
    savePnlWindowMarks(now - 60 * DAY, now - 60 * DAY - 1000, [{ market: "stock", symbol: "AAPL", price: 300 }]);
    savePnlWindowMarks(now - 100 * DAY, now - 100 * DAY - 1000, [{ market: "stock", symbol: "AAPL", price: 250 }, { market: "stock", symbol: "BAD", price: 0 }]);
    pruneOldData();
    expect(getPnlWindowMarks(now - 60 * DAY)).toHaveLength(1);
    expect(getPnlWindowMarks(now - 100 * DAY)).toEqual([]);
  });

  test("orders: an unreferenced order is kept for 90 days (it used to be 7), a trade-linked one forever", () => {
    const now = Date.now();
    insertOrder("orphan-10d", now - 10 * DAY);
    insertOrder("orphan-30d", now - 30 * DAY);
    insertOrder("orphan-89d", now - 89 * DAY);
    insertOrder("orphan-91d", now - 91 * DAY);
    insertOrder("linked-400d", now - 400 * DAY);
    insertTrade({
      id: "t1", symbol: "AAPL", market: "stock", side: "buy", strategy: "MOMENTUM",
      entryPrice: 100, quantity: 1, entryTime: now - 400 * DAY, status: "open", orderId: "linked-400d",
    } as any, "momentum_stocks");

    expect(pruneOrphanOrders(now)).toBe(1);
    expect(orderIds()).toEqual(["linked-400d", "orphan-10d", "orphan-30d", "orphan-89d"]);
  });

  test("activity_log: 60-day-old events survive the periodic prune, 100-day-old ones go", () => {
    const now = Date.now();
    const ins = getDB().prepare(`INSERT INTO activity_log (account_id, event_type, message, created_at) VALUES (NULL, 'broker_error', ?, ?)`);
    ins.run("60d", now - 60 * DAY);
    ins.run("85d", now - 85 * DAY);
    ins.run("100d", now - 100 * DAY);
    pruneOldData();
    const left = (getDB().prepare(`SELECT message FROM activity_log ORDER BY created_at`).all() as { message: string }[]).map((r) => r.message);
    expect(left).toEqual(["85d", "60d"]);
  });

  test("fills: nothing prunes them, however old", () => {
    const now = Date.now();
    recordFill({
      tradeId: "t", orderId: "o", accountId: "momentum_stocks", symbol: "AAPL", side: "buy", market: "stock",
      expectedPx: 100, submittedPx: 100, filledPx: 100.1, filledQty: 1, fillTime: now - 400 * DAY, latencyMs: 5, broker: "alpaca",
    });
    pruneOldData();
    pruneOrphanOrders(now);
    expect((getDB().prepare(`SELECT COUNT(*) c FROM fills`).get() as { c: number }).c).toBe(1);
  });

  test("no production code deletes from fills (this guard fails the day somebody adds a prune)", () => {
    const offenders: string[] = [];
    for (const f of new Bun.Glob("**/*.ts").scanSync({ cwd: join(import.meta.dir, ".."), absolute: true })) {
      if (f.endsWith(".test.ts") || f.includes("/test-support/")) continue;
      if (/DELETE\s+FROM\s+fills\b/i.test(readFileSync(f, "utf8"))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
