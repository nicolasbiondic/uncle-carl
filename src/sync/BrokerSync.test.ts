// ══════════════════════════════════════════════
// BrokerSync — liveness, reentrancy, ownership boundary
// ══════════════════════════════════════════════
//
// Covers the confessed 4-day no-op (the reentrancy guard was the lifecycle
// `running` flag, so every syncAll() bailed instantly) plus the v8 ownership
// boundary (Bug 2): a sleeve-owned symbol must NOT be adopted under *_main, or
// it ends up managed by no engine and no stop-loss loop.
//
// Post broker-stack merge: BrokerSync consumes BrokerSyncSource[] (STACK B shim)
// directly — the fakes below ARE that shim's surface, no BrokerRegistry.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { getDB, getSyncState, setSyncState } from "../db/database";
import { BrokerSync, sleeveOwnsSymbol } from "./BrokerSync";
import type { BrokerSyncSource } from "./brokerSyncSource";
import { makeTestDb } from "../test-support/db";
import { captureBursts } from "../test-support/events";

beforeAll(() => {
  makeTestDb();
});

beforeEach(() => {
  // Isolated trades table so tests asserting on sync_ state are not fooled by
  // rows leaked from earlier tests in the same :memory: database.
  getDB().prepare(`DELETE FROM trades`).run();
  // Same for the persisted drift fingerprint (sync_state) — otherwise a later
  // test reusing the same drift shape (e.g. AAPL 152 vs 76) would inherit an
  // earlier test's "already notified" state and wrongly stay silent.
  getDB().prepare(`DELETE FROM sync_state`).run();
});

type Pos = { symbol: string; side: "buy" | "sell"; quantity: number; entryPrice: number };

function makePos(symbol: string): Pos {
  return { symbol, side: "buy", quantity: 10, entryPrice: 100 };
}

/** Minimal BrokerSyncSource stand-in — a plain object with the exact surface
 *  BrokerSync reads. No getAssetBreakdown ⇒ the asset-breakdown branch is
 *  skipped (like the real Alpaca source). Counts calls for assertions. */
function fakeSource(opts: {
  id?: string;
  positions?: Pos[];
  gate?: Promise<void>;
  status?: "connected" | "disconnected";
  positionError?: Error;
  accountError?: Error;
  assetBreakdown?: [];
  assetBreakdownHangs?: boolean; // never resolves/rejects — proves it can't block syncAll()
} = {}): BrokerSyncSource & { calls: { getAccount: number; getOpenPositions: number; getAssetBreakdown: number } } {
  const calls = { getAccount: 0, getOpenPositions: 0, getAssetBreakdown: 0 };
  return {
    id: opts.id ?? "alpaca_paper",
    name: "FakeAlpaca",
    status: opts.status ?? "connected",
    async getAccount() {
      calls.getAccount++;
      if (opts.accountError) throw opts.accountError;
      if (opts.gate) await opts.gate;
      return { totalEquity: 100_000, availableCash: 50_000 };
    },
    async getOpenPositions() {
      calls.getOpenPositions++;
      if (opts.positionError) throw opts.positionError;
      return opts.positions ?? [];
    },
    ...(opts.assetBreakdown || opts.assetBreakdownHangs
      ? {
          getAssetBreakdown: () => {
            calls.getAssetBreakdown++;
            if (opts.assetBreakdownHangs) return new Promise<any>(() => {}); // never settles
            return Promise.resolve(opts.assetBreakdown!);
          },
        }
      : {}),
    calls,
  };
}

describe("sleeveOwnsSymbol (ownership boundary)", () => {
  test("Alpaca momentum + meanrev universes are sleeve-owned; unknown tickers are orphans", () => {
    expect(sleeveOwnsSymbol("alpaca_paper", "AAPL")).toBe(true);  // momentum_stocks
    expect(sleeveOwnsSymbol("alpaca_paper", "KO")).toBe(true);    // meanrev_stocks
    expect(sleeveOwnsSymbol("alpaca_paper", "TSLA")).toBe(false); // no sleeve
  });
  test("Binance crypto universe is sleeve-owned", () => {
    expect(sleeveOwnsSymbol("binance_testnet", "BTC/USD")).toBe(true);
    expect(sleeveOwnsSymbol("binance_testnet", "PEPE/USD")).toBe(false);
  });
});

describe("BrokerSync.syncAll — liveness (the confessed 4-day no-op)", () => {
  test("start() then syncAll() actually iterates sources (running flag no longer bails)", async () => {
    const source = fakeSource();
    const bs = new BrokerSync([source], 30_000);
    bs.start(); // sets running=true — the flag the OLD code wrongly reused as the guard
    const results = await bs.syncAll();
    bs.stop();
    expect(results.length).toBe(1);                 // iterated, not an instant [] bail
    expect(source.calls.getOpenPositions).toBe(1);  // proof it reached the position sync
  });

  test("disconnected sources are skipped", async () => {
    const source = fakeSource({ status: "disconnected" });
    const bs = new BrokerSync([source], 30_000);
    const results = await bs.syncAll();
    expect(results.length).toBe(0);
    expect(source.calls.getOpenPositions).toBe(0);
  });
});

describe("BrokerSync.syncAll — reentrancy guard", () => {
  test("a second syncAll while one is in-flight returns [] without double-work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const source = fakeSource({ gate });
    const bs = new BrokerSync([source], 30_000);

    const p1 = bs.syncAll();          // parks inside syncBroker at getAccount()→gate; syncing=true
    await Promise.resolve();
    const r2 = await bs.syncAll();    // guard trips → []
    expect(r2).toEqual([]);

    release();
    const r1 = await p1;
    expect(r1.length).toBe(1);
    expect(source.calls.getAccount).toBe(1); // the guarded call never ran → no double-work
  });
});

describe("BrokerSync read failures — fail closed", () => {
  test("balance error aborts reconciliation and preserves DB", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('sync_balance_guard','TSLA','stock','buy','BROKER_SYNC',100,1,?,'open','alpaca_main')
    `).run(Date.now());
    const source = fakeSource({ accountError: new Error("account unavailable") });

    const [result] = await new BrokerSync([source]).syncAll();

    expect(result.error).toContain("account unavailable");
    expect(source.calls.getOpenPositions).toBe(0); // never reached positions
    expect((getDB().prepare(`SELECT status FROM trades WHERE id='sync_balance_guard'`).get() as any).status).toBe("open");
  });

  test("positions error aborts reconciliation and preserves DB", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('sync_failure_guard','TSLA','stock','buy','BROKER_SYNC',100,1,?,'open','alpaca_main')
    `).run(Date.now());
    const source = fakeSource({ positionError: new Error("positions unavailable") });

    const [result] = await new BrokerSync([source]).syncAll();

    expect(result.error).toContain("positions unavailable");
    expect((getDB().prepare(`SELECT status FROM trades WHERE id='sync_failure_guard'`).get() as any).status).toBe("open");
  });
});

describe("BrokerSync valid empty positions", () => {
  test("empty broker positions close orphaned sync_ rows", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('sync_empty_guard','TSLA','stock','buy','BROKER_SYNC',100,1,?,'open','alpaca_main')
    `).run(Date.now());
    const source = fakeSource({ positions: [] });

    const [result] = await new BrokerSync([source]).syncAll();

    expect(result.error).toBeUndefined();
    expect(result.positions).toEqual([]);
    expect((getDB().prepare(`SELECT status FROM trades WHERE id='sync_empty_guard'`).get() as any).status).toBe("closed");
  });
});

describe("BrokerSync — asset-breakdown telemetry never blocks reconciliation (P1 fix)", () => {
  test("syncAll() completes and reaches getOpenPositions() even when getAssetBreakdown() never resolves", async () => {
    const source = fakeSource({ assetBreakdownHangs: true });
    const bs = new BrokerSync([source], 30_000);

    const results = await bs.syncAll(); // must NOT hang waiting on the asset-breakdown promise

    expect(results.length).toBe(1);
    expect(results[0].error).toBeUndefined();
    expect(source.calls.getOpenPositions).toBe(1); // reconciliation reached positions
    expect(source.calls.getAssetBreakdown).toBe(1); // fired, but fire-and-forget

    await bs.syncAll();
    expect(source.calls.getOpenPositions).toBe(2);
    expect(source.calls.getAssetBreakdown).toBe(1); // one hung telemetry request, never an accumulating pile
  });
});

describe("BrokerSync — Bug 2: sleeve-owned symbols are NOT adopted under *_main", () => {
  test("adopts only genuine orphans; leaves sleeve-owned symbols to per-sleeve syncs", async () => {
    const beforeTs = Date.now();
    const source = fakeSource({ positions: [makePos("AAPL"), makePos("TSLA")] });
    const bs = new BrokerSync([source], 30_000);
    await bs.syncAll();

    const db = getDB();
    // AAPL is momentum_stocks' — must be left for the sleeve's own sync.
    const aapl = db.prepare(`SELECT COUNT(*) c FROM trades WHERE symbol = 'AAPL' AND status = 'open'`).get() as any;
    expect(aapl.c).toBe(0);

    // TSLA belongs to no sleeve → adopted under alpaca_main with a sync_ id.
    // Exact-count + recent-timestamp assertions prevent a false-positive when a
    // pre-existing sync_ row (leaked from an earlier test) masks a broken adoption.
    const tsla = db.prepare(`SELECT COUNT(*) c FROM trades WHERE symbol = 'TSLA' AND status = 'open' AND id LIKE 'sync_%' AND entry_time >= ?`).get(beforeTs) as any;
    expect(tsla.c).toBe(1);
    const tslaRow = db.prepare(`SELECT id, account_id FROM trades WHERE symbol = 'TSLA' AND status = 'open'`).get() as any;
    expect(tslaRow.account_id).toBe("alpaca_main");
    expect(String(tslaRow.id).startsWith("sync_")).toBe(true);
  });
});

// Covers the live incident (see file header of BrokerSync.ts): broker held
// ~2x the DB's recorded quantity on 7 sleeve-owned symbols, invisible because
// every existing check only asked "does a DB row exist", never "does the size
// match". Detection only — asserts no order/trade-mutation side effect.
// 2026-09-09: a one-cycle GRACE PERIOD was added to every test below that
// asserted an immediate page for a NEW/CHANGED fingerprint. Root cause of the
// change: BrokerSync paged twice this week (ADA/USD 2026-09-04 03:32, DIS
// 2026-09-09) for a fingerprint that had already resolved by the very next
// sync — a benign broker/DB persistence race (BrokerSync read the broker in
// the same ~30s cycle the adapter was persisting the fill's trades row), not
// a real discrepancy. A new/changed fingerprint now must be seen on TWO
// CONSECUTIVE syncAll() passes before it pages/persists; tests that used to
// call syncAll() once and assert an immediate burst now call it twice. This
// does NOT weaken the "any broker≠DB mismatch is real" guarantee — it only
// delays the page by one cycle to rule out the sub-cycle persistence race.
describe("BrokerSync — quantity-drift detection (read-only, DETECTION ONLY)", () => {
  test("broker qty double the DB qty → confirmed after 2 consecutive syncs, ONE aggregated alert naming AAPL with both numbers, no order, no mutation", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_aapl','AAPL','stock','buy','MOMENTUM',150,76,?,'open','momentum_stocks')
    `).run(Date.now());
    const source = fakeSource({ positions: [{ symbol: "AAPL", side: "buy", quantity: 152, entryPrice: 150 }] });
    const sync = new BrokerSync([source]);
    const { bursts, detach } = captureBursts();
    try {
      await sync.syncAll(); // 1st sighting → candidate only, grace period, no page yet
      expect(bursts.length).toBe(0);
      await sync.syncAll(); // 2nd consecutive sync, SAME fingerprint → confirmed, pages
    } finally { detach(); }

    expect(bursts.length).toBe(1); // exactly one aggregated alert, not one per symbol
    expect(bursts[0].context).toBe("BrokerSync");
    expect(bursts[0].message).toContain("AAPL");
    expect(bursts[0].message).toContain("152"); // broker qty
    expect(bursts[0].message).toContain("76");  // db qty

    // No order placed (fakeSource has no order surface — proves nothing but
    // the detector was even asked to place one) and no trade row mutated.
    const row = getDB().prepare(`SELECT status, quantity FROM trades WHERE id='trade_aapl'`).get() as any;
    expect(row.status).toBe("open");
    expect(row.quantity).toBe(76);
  });

  // (a) The actual false-alarm shape: drift seen once, then gone. Never pages.
  test("a drift seen ONCE then gone the next sync never pages — the benign broker/DB persistence race (ADA/USD 2026-09-04, DIS 2026-09-09)", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_ada','ADA/USD','crypto','buy','MOMENTUM_CRYPTO',1,0,?,'open','momentum_crypto')
    `).run(Date.now());
    const source = fakeSource({ positions: [{ symbol: "ADA/USD", side: "buy", quantity: 40, entryPrice: 1 }] });
    const sync = new BrokerSync([source]);
    const { bursts, detach } = captureBursts();
    try {
      await sync.syncAll(); // broker=40, db=0 (fill just landed, insertTrade racing this sync) → candidate, no page
      // The adapter's insertTrade lands: DB now matches the broker.
      getDB().prepare(`UPDATE trades SET quantity = 40 WHERE id = 'trade_ada'`).run();
      await sync.syncAll(); // drift gone → candidate discarded silently, never paged
    } finally { detach(); }

    expect(bursts.length).toBe(0);
    expect(getSyncState("drift_fingerprint") ?? "").toBe(""); // never persisted as confirmed
  });

  // (e) A drift then a DIFFERENT drift the very next sync — neither pages
  // until the second one repeats.
  test("drift A one cycle, drift B the next — neither pages yet; B pages once confirmed on the third sync", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_e','AAPL','stock','buy','MOMENTUM',150,76,?,'open','momentum_stocks')
    `).run(Date.now());
    let qty = 152; // drift A
    const source = fakeSource({ positions: [] as any });
    (source as any).getOpenPositions = async () => [{ symbol: "AAPL", side: "buy", quantity: qty, entryPrice: 150 }];
    const sync = new BrokerSync([source]);
    const { bursts, detach } = captureBursts();
    try {
      await sync.syncAll(); // drift A (152) → candidate, no page
      qty = 200;            // drift B — a DIFFERENT fingerprint before A ever confirmed
      await sync.syncAll(); // A superseded (never paged); B becomes the new candidate → still no page
      expect(bursts.length).toBe(0);
      await sync.syncAll(); // B seen twice consecutively → confirmed, pages
    } finally { detach(); }

    expect(bursts.length).toBe(1);
    expect(bursts[0].message).toContain("200");
  });

  // Drift is a STATE. The first version re-paged every 5 minutes about the same
  // 7 symbols while their reconciliation was already queued — the owner got an
  // alert every couple of minutes. Page on CHANGE, stay quiet otherwise.
  test("an UNCHANGED drift pages once, not once per sync pass", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_dup','AAPL','stock','buy','MOMENTUM',150,76,?,'open','momentum_stocks')
    `).run(Date.now());
    const source = fakeSource({ positions: [{ symbol: "AAPL", side: "buy", quantity: 152, entryPrice: 150 }] });
    const sync = new BrokerSync([source]);
    const { bursts, detach } = captureBursts();
    try {
      for (let i = 0; i < 5; i++) await sync.syncAll();
    } finally { detach(); }
    expect(bursts.length).toBe(1);
  });

  test("a CHANGED drift needs its OWN 2-consecutive-sync confirmation before it pages again — the grace period applies per fingerprint, not just the first one", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_chg','AAPL','stock','buy','MOMENTUM',150,76,?,'open','momentum_stocks')
    `).run(Date.now());
    let qty = 152;
    const source = fakeSource({ positions: [] as any });
    (source as any).getOpenPositions = async () => [{ symbol: "AAPL", side: "buy", quantity: qty, entryPrice: 150 }];
    const sync = new BrokerSync([source]);
    const { bursts, detach } = captureBursts();
    try {
      await sync.syncAll();      // 152 vs 76, 1st sighting → candidate, no page
      await sync.syncAll();      // 152 vs 76, 2nd consecutive → confirmed, PAGES
      await sync.syncAll();      // unchanged, already confirmed → silent
      qty = 200;                 // drift MOVED — a new fingerprint, own grace period
      await sync.syncAll();      // 1st sighting of 200 → candidate, no page yet
      expect(bursts.length).toBe(1); // still just the original page
      await sync.syncAll();      // 200 seen twice consecutively → confirmed, pages
    } finally { detach(); }
    expect(bursts.length).toBe(2);
    expect(bursts[1].message).toContain("200");
  });

  test("matching broker/DB quantity produces no drift alert", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_nvda','NVDA','stock','buy','MOMENTUM',400,121,?,'open','momentum_stocks')
    `).run(Date.now());
    const source = fakeSource({ positions: [{ symbol: "NVDA", side: "buy", quantity: 121, entryPrice: 400 }] });
    const { bursts, detach } = captureBursts();
    try {
      await new BrokerSync([source]).syncAll();
    } finally { detach(); }

    expect(bursts.length).toBe(0);
  });

  // 2026-07-27: the 6h renotify (2005ad1) assumed the drift was temporary
  // ("reconciliation queued for Monday"). Since the two-deployment
  // consolidation to a single system, an unresolved drift is a REAL bug (a
  // stale DB row, a manual partial close, or a reconciliation gap) awaiting
  // investigation — it still shouldn't page every cycle while that
  // investigation is pending, so it reminds once per DAY, worded as an
  // unresolved discrepancy (never as an expected/permanent state). Reverting
  // QTY_DRIFT_RENOTIFY_MS to 6h makes the first half fail (a 12h-old
  // unchanged drift would page again); reverting the message makes the
  // toContain assertions fail.
  test("an unchanged drift re-reminds once per DAY (not 6h) and reads as an UNRESOLVED real discrepancy", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_24h','AAPL','stock','buy','MOMENTUM',150,76,?,'open','momentum_stocks')
    `).run(Date.now());
    const positions = [{ symbol: "AAPL", side: "buy" as const, quantity: 152, entryPrice: 150 }];
    // Persisted state: same fingerprint, last alerted 12h ago — inside 24h,
    // but would already re-page under the old 6h interval.
    setSyncState("drift_fingerprint", "AAPL:152:76");
    setSyncState("drift_alert_at", String(Date.now() - 12 * 60 * 60_000));
    const { bursts, detach } = captureBursts();
    try {
      await new BrokerSync([fakeSource({ positions })]).syncAll();
      expect(bursts.length).toBe(0); // 12h < 24h → silent

      // 25h since the last reminder → one daily reminder, worded as known state.
      setSyncState("drift_alert_at", String(Date.now() - 25 * 60 * 60_000));
      await new BrokerSync([fakeSource({ positions })]).syncAll(); // fresh instance re-reads persisted state
      expect(bursts.length).toBe(1);
      expect(bursts[0].message).toContain("still unresolved");
      expect(bursts[0].message).toContain("discrepancy");
      expect(bursts[0].message).toContain("not an expected state");
    } finally { detach(); }
  });

  test("broker position with NO db row at all is reported (100% drift), confirmed after 2 consecutive syncs", async () => {
    const source = fakeSource({ positions: [{ symbol: "XLP", side: "buy", quantity: 58, entryPrice: 80 }] });
    const sync = new BrokerSync([source]);
    const { bursts, detach } = captureBursts();
    try {
      await sync.syncAll(); // 1st sighting → candidate, no page
      expect(bursts.length).toBe(0);
      await sync.syncAll(); // 2nd consecutive → confirmed, pages
    } finally { detach(); }

    expect(bursts.length).toBe(1);
    expect(bursts[0].message).toContain("XLP");
    expect(bursts[0].message).toContain("58");
  });
});

// Fix A4 (2026-07-26): BrokerSync's "sync-owned" predicate matched only the
// sync_ id prefix while AccountManager's isSyncOwned also matched
// strategy='BROKER_SYNC'. A UUID row with that tag was skipped by BOTH
// reconcilers → open forever. Both sides now share db/database.ts#isSyncOwned.
describe("BrokerSync 2a — shared isSyncOwned predicate", () => {
  test("auto-closes a UUID-id row tagged strategy='BROKER_SYNC' when the broker is flat (was a permanent phantom)", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('a-uuid-broker-sync','TSLA','stock','buy','BROKER_SYNC',100,1,?,'open','alpaca_main')
    `).run(Date.now());
    const source = fakeSource({ positions: [] });

    const [result] = await new BrokerSync([source]).syncAll();

    expect(result.error).toBeUndefined();
    const row = getDB().prepare(`SELECT status, close_reason, pnl FROM trades WHERE id='a-uuid-broker-sync'`).get() as any;
    expect(row.status).toBe("closed");
    expect(row.close_reason).toBe("SYNC_DETECTED");
    expect(row.pnl).toBe(0); // exit at entry price — best-estimate contract unchanged
  });

  test("still leaves genuinely bot-managed rows (UUID, non-sync strategy) to AccountManager", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('a-uuid-momentum','TSLA','stock','buy','MOMENTUM',100,1,?,'open','momentum_stocks')
    `).run(Date.now());
    const source = fakeSource({ positions: [] });

    await new BrokerSync([source]).syncAll();

    expect((getDB().prepare(`SELECT status FROM trades WHERE id='a-uuid-momentum'`).get() as any).status).toBe("open");
  });
});

// Fix A2 (2026-07-26): markTradeClosed was the fourth close writer and the only
// one without the finiteness / entry×qty>0 guards — it now routes through pnlOf.
describe("BrokerSync markTradeClosed — pnl guards (via pnlOf)", () => {
  test("quantity=0 row closes with pnl_pct=0, never NaN", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('sync_qty0','TSLA','stock','buy','BROKER_SYNC',100,0,?,'open','alpaca_main')
    `).run(Date.now());

    await new BrokerSync([fakeSource({ positions: [] })]).syncAll();

    const row = getDB().prepare(`SELECT status, pnl, pnl_pct FROM trades WHERE id='sync_qty0'`).get() as any;
    expect(row.status).toBe("closed");
    expect(Number.isFinite(row.pnl)).toBe(true);
    expect(row.pnl_pct).toBe(0);
  });

  test("non-finite entry_price row closes with pnl=0/pnl_pct=0, never NaN/Infinity", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('sync_badentry','TSLA','stock','buy','BROKER_SYNC',1e999,1,?,'open','alpaca_main')
    `).run(Date.now());

    await new BrokerSync([fakeSource({ positions: [] })]).syncAll();

    const row = getDB().prepare(`SELECT status, pnl, pnl_pct FROM trades WHERE id='sync_badentry'`).get() as any;
    expect(row.status).toBe("closed");
    expect(row.pnl).toBe(0);
    expect(row.pnl_pct).toBe(0);
  });
});

// The actual flood: 5 emits in one night, one per deploy/watchdog restart —
// the fingerprint lived only in instance fields, so a fresh BrokerSync (the
// exact effect of a restart, since the process re-constructs everything) had
// no memory of "already notified" and re-paged on its very first sync pass.
describe("BrokerSync — drift alert survives a restart (persisted in sync_state)", () => {
  test("same drift after a simulated restart (NEW BrokerSync, SAME db) pages 0 times — this must fail if persistence is removed", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_restart','AAPL','stock','buy','MOMENTUM',150,76,?,'open','momentum_stocks')
    `).run(Date.now());
    const drift = { symbol: "AAPL", side: "buy" as const, quantity: 152, entryPrice: 150 };
    const sync1 = new BrokerSync([fakeSource({ positions: [drift] })]);

    const { bursts, detach } = captureBursts();
    try {
      await sync1.syncAll(); // process #1, 1st sighting → candidate, no page (grace period)
      await sync1.syncAll(); // process #1, 2nd consecutive → confirmed, pages + persists
      expect(bursts.length).toBe(1);

      // "restart": a brand-new BrokerSync instance — no in-memory state at all —
      // over the SAME (persisted) db, facing the identical, ALREADY-CONFIRMED drift.
      await new BrokerSync([fakeSource({ positions: [drift] })]).syncAll(); // process #2
      expect(bursts.length).toBe(1); // unchanged: still just the one page from before
    } finally { detach(); }
  });

  test("a drift that CHANGED across the restart still pages, confirmed over its own 2 consecutive syncs on the new instance", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_restart2','AAPL','stock','buy','MOMENTUM',150,76,?,'open','momentum_stocks')
    `).run(Date.now());

    const { bursts, detach } = captureBursts();
    try {
      const sync1 = new BrokerSync([fakeSource({ positions: [{ symbol: "AAPL", side: "buy", quantity: 152, entryPrice: 150 }] })]);
      await sync1.syncAll(); // 1st sighting → candidate
      await sync1.syncAll(); // 2nd consecutive → confirmed, pages, persists AAPL:152:76
      expect(bursts.length).toBe(1);

      // "restart" + the drift moved (200 instead of 152). A fresh instance has
      // no in-memory candidate, so 200 must be seen on 2 consecutive syncs of
      // ITS OWN before paging — the same grace a first-ever drift gets.
      const sync2 = new BrokerSync([fakeSource({ positions: [{ symbol: "AAPL", side: "buy", quantity: 200, entryPrice: 150 }] })]);
      await sync2.syncAll(); // 1st sighting on the new instance → candidate, no page
      expect(bursts.length).toBe(1);
      await sync2.syncAll(); // 2nd consecutive → confirmed, pages
      expect(bursts.length).toBe(2);
      expect(bursts[1].message).toContain("200");
    } finally { detach(); }
  });

  test("a resolved drift updates persisted state so a later re-appearance pages again (after its own 2-sync confirmation), even across a restart", async () => {
    getDB().prepare(`
      INSERT INTO trades (id,symbol,market,side,strategy,entry_price,quantity,entry_time,status,account_id)
      VALUES ('trade_restart3','AAPL','stock','buy','MOMENTUM',150,76,?,'open','momentum_stocks')
    `).run(Date.now());

    const { bursts, detach } = captureBursts();
    try {
      const sync1 = new BrokerSync([fakeSource({ positions: [{ symbol: "AAPL", side: "buy", quantity: 152, entryPrice: 150 }] })]);
      await sync1.syncAll(); // 1st sighting → candidate
      await sync1.syncAll(); // 2nd consecutive → confirmed, pages
      expect(bursts.length).toBe(1);

      // Drift resolves (broker qty now matches DB) — a NEW instance ("restart").
      getDB().prepare(`UPDATE trades SET quantity = 152 WHERE id = 'trade_restart3'`).run();
      await new BrokerSync([fakeSource({ positions: [{ symbol: "AAPL", side: "buy", quantity: 152, entryPrice: 150 }] })]).syncAll();
      expect(bursts.length).toBe(1); // no new page — nothing drifting

      // Drift reappears — yet another NEW instance ("restart") — starts its OWN
      // 2-sync grace period again (the earlier confirmation was cleared when it
      // resolved), proving the "resolved" state was persisted too, not just the
      // fingerprint.
      getDB().prepare(`UPDATE trades SET quantity = 76 WHERE id = 'trade_restart3'`).run();
      const sync2 = new BrokerSync([fakeSource({ positions: [{ symbol: "AAPL", side: "buy", quantity: 152, entryPrice: 150 }] })]);
      await sync2.syncAll(); // 1st sighting → candidate, no page
      expect(bursts.length).toBe(1);
      await sync2.syncAll(); // 2nd consecutive → confirmed, pages
      expect(bursts.length).toBe(2);
    } finally { detach(); }
  });
});
