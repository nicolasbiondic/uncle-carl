// A sleeve's equity snapshot is never written before its first sync in this
// process (2026-10-06). Before the fix, the null→valid binance_main write in
// refreshBinanceAccountTotal could run during start() ahead of the Alpaca
// ledger sync, persisting the frozen accounts-table value: one −9% / −4% spike
// per restart on momentum_stocks / meanrev_stocks (57 rows in prod), which
// stretched the dashboard's y-axis until the real moves looked flat.
import { beforeEach, describe, expect, test } from "bun:test";
import { getDB } from "../db/database";
import { makeTestDb } from "../test-support/db";
import { AccountManager } from "./AccountManager";
import { EquityTracker } from "./EquityTracker";

const rowsFor = (profile: string) =>
  getDB().prepare("SELECT equity FROM equity_snapshots WHERE profile_id = ? ORDER BY snapshot_time").all(profile) as { equity: number }[];

describe("EquityTracker.synced", () => {
  beforeEach(() => { makeTestDb(); });

  test("false at construction; true after a broker reading or a ledger valuation; a rejected ledger leaves it false", () => {
    const a = new EquityTracker("momentum_crypto");
    expect(a.synced).toBe(false);
    a.syncBrokerTruth(5_100, 4_000);
    expect(a.synced).toBe(true);

    const b = new EquityTracker("momentum_stocks");
    b.syncLedger(Number.NaN, 0); // rejected (logged), not a valuation
    expect(b.synced).toBe(false);
    b.syncLedger(55_012, 10_000);
    expect(b.synced).toBe(true);
  });
});

describe("writeAllSnapshots never persists an unsynced sleeve", () => {
  beforeEach(() => { makeTestDb(); });

  test("before its first sync a stock sleeve gets no row (no seed/frozen value); after the ledger sync it gets the real one", () => {
    const am = new AccountManager();
    const loaded = am.getAccount("momentum_stocks").equity.equity; // what the tracker loaded from the accounts table

    (am as any).writeAllSnapshots(); // e.g. the early null→valid binance_main write during start()
    expect(rowsFor("momentum_stocks")).toEqual([]);
    expect(rowsFor("meanrev_stocks")).toEqual([]);

    am.getAccount("momentum_stocks").equity.syncLedger(loaded + 4_888.25, 10_000);
    (am as any).writeAllSnapshots();
    expect(rowsFor("momentum_stocks").map((r) => r.equity)).toEqual([loaded + 4_888.25]);
    expect(rowsFor("meanrev_stocks")).toEqual([]); // still unsynced
  });
});
