// Test-support: shared DB fixtures. TEST-ONLY — imported exclusively from
// *.test.ts files; nothing in production code may depend on this module.
import type { Database } from "bun:sqlite";
import { getDB, initDatabase, insertTrade } from "../db/database";

/** Fresh in-memory database. Re-initializes the module-global handle the
 *  entire codebase reads through getDB() — the exact one-liner 44 test files
 *  used to spell as `initDatabase(":memory:")`. Returns the handle for
 *  suites that keep a local reference. */
export function makeTestDb(): Database {
  initDatabase(":memory:");
  return getDB();
}

/** Raw equity_snapshots row — the canonical seeder five db suites duplicated
 *  verbatim (cash mirrors equity, zero open positions). `synthetic` marks a
 *  fabricated backfill row (syntheticSnapshots suite). */
export function rawSnap(profile: string, equity: number, time: number, semantics: number, synthetic = 0): void {
  getDB().prepare(
    `INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time, semantics, synthetic) VALUES (?,?,?,?,?,?,?)`
  ).run(profile, equity, equity, 0, time, semantics, synthetic);
}

/** Seed one OPEN trades row through the public insertTrade path. Defaults are
 *  the shape dozens of tests repeated inline; pass only what distinguishes
 *  the scenario (symbol/market/strategy/price/…). */
export function seedOpenTrade(id: string, accountId: string, over: Record<string, any> = {}): void {
  insertTrade({
    id, symbol: "AAPL", market: "stock", side: "buy", strategy: "MOMENTUM",
    entryPrice: 100, quantity: 1, entryTime: Date.now() - 60_000, status: "open",
    ...over,
  } as any, accountId);
}
