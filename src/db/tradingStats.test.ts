import { describe, expect, test, beforeAll } from "bun:test";
import { getDB, getTradingStats, getRecentTrades, getRecentSignals, insertSignal, RECONCILE_CLOSE_SQL, insertTrade, closeTrade, closeTradeExplicit } from "./database";
import { makeTestDb } from "../test-support/db";

beforeAll(() => { makeTestDb(); });

let seq = 0;
function seed(o: { account: string; status?: string; pnl?: number | null; closeReason?: string | null; exitTime?: number | null }) {
  const status = o.status ?? "closed";
  const exit = status === "closed" ? (o.exitTime ?? Date.now() - 60_000) : null;
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity,
       entry_time, status, exit_time, pnl, pnl_pct, profile_id, account_id, close_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `ts_${seq++}`, "SPY", "stock", "buy", "MOMENTUM", 100, 1,
    (exit ?? Date.now()) - 3_600_000, status, exit, o.pnl ?? null, o.pnl ?? null,
    o.account, o.account, o.closeReason ?? null,
  );
}

describe("RECONCILE_CLOSE_SQL — canonical exclusion list is complete", () => {
  test("contains every phantom/reconcile close reason", () => {
    for (const reason of [
      "BROKER_GONE_404", "MANUAL_CLOSE_UNRECONCILED", "BACKFILLED_SYNC", "SYNC_DETECTED",
      "MOMENTUM_RECONCILED", "MEANREV_RECONCILED", "SYNC_DUP_RECONCILED", "LEGACY_UNLABELED",
    ]) {
      expect(RECONCILE_CLOSE_SQL).toContain(`'${reason}'`);
    }
  });
});

describe("getTradingStats with no account — v8 sleeves only", () => {
  beforeAll(() => {
    seed({ account: "momentum_stocks", pnl: 10 });                     // real win
    seed({ account: "momentum_stocks", pnl: -4 });                     // real loss
    seed({ account: "meanrev_stocks", pnl: 6 });                       // real win
    seed({ account: "momentum_crypto", status: "open" });              // open — no outcome
    seed({ account: "momentum_crypto", pnl: 0, closeReason: "MOMENTUM_RECONCILED" }); // phantom
    seed({ account: "shadow_meanrev_wide", pnl: 100 });                // shadow book
    seed({ account: "alpaca_low", pnl: 100 });                         // legacy profile
    seed({ account: "sync_123_abc", pnl: 100 });                       // broker-sync row
  });

  test("excludes shadow_, legacy, and sync accounts + reconcile phantoms", () => {
    const s = getTradingStats();
    expect(s.closedTrades).toBe(3);
    expect(s.winningTrades).toBe(2);
    expect(s.totalPnl).toBeCloseTo(12, 6);
  });

  test("winRate denominator is CLOSED trades (open rows don't dilute)", () => {
    const s = getTradingStats();
    expect(s.openTrades).toBe(1);
    expect(s.winRate).toBeCloseTo((2 / 3) * 100, 6); // not 2/4 with the open row
  });

  test("explicit account still works", () => {
    const s = getTradingStats("momentum_stocks");
    expect(s.closedTrades).toBe(2);
    expect(s.winRate).toBeCloseTo(50, 6);
  });

  test("periodDays=0 includes all-time trades instead of treating zero as today", () => {
    seed({ account: "all_time_probe", pnl: 9, exitTime: Date.now() - 730 * 86_400_000 });
    expect(getTradingStats("all_time_probe", 365).periodClosedTrades).toBe(0);
    expect(getTradingStats("all_time_probe", 0).periodClosedTrades).toBe(1);
  });

  test("getRecentTrades default feed hides shadow_ books", () => {
    const all = getRecentTrades(100);
    expect(all.some(t => (t.accountId ?? "").startsWith("shadow_"))).toBe(false);
    // …but an explicit shadow account is still inspectable.
    expect(getRecentTrades(100, "shadow_meanrev_wide").length).toBe(1);
  });

  // Falsifier: revert the V8_ACCOUNTS_SQL filter in getRecentTrades (go back
  // to `NOT LIKE 'shadow_%'`) and this fails — alpaca_low/sync_123_abc come
  // back into the default feed.
  test("getRecentTrades default feed also hides legacy COMBINED profiles and sync_* rows", () => {
    const all = getRecentTrades(100);
    expect(all.some(t => t.accountId === "alpaca_low")).toBe(false);
    expect(all.some(t => (t.accountId ?? "").startsWith("sync_"))).toBe(false);
    // …but still explicitly inspectable by account.
    expect(getRecentTrades(100, "alpaca_low").length).toBe(1);
    expect(getRecentTrades(100, "sync_123_abc").length).toBe(1);
  });
});

describe("getRecentSignals with no account — v8 sleeves only", () => {
  function seedSignal(accountId: string) {
    insertSignal({
      id: `sig_${seq++}`, symbol: "SPY", market: "stock", side: "buy", strategy: "MOMENTUM",
      strength: "strong", price: 100, timestamp: Date.now(), indicators: {}, reason: "test",
    }, accountId);
  }

  beforeAll(() => {
    seedSignal("momentum_stocks");
    seedSignal("alpaca_low"); // legacy profile — should not leak into the default feed
  });

  // Falsifier: revert the V8_ACCOUNTS_SQL filter in getRecentSignals (go back
  // to the unfiltered `SELECT * FROM signals`) and this fails.
  test("default feed hides legacy COMBINED profiles", () => {
    const all = getRecentSignals(100) as any[];
    expect(all.some(s => s.account_id === "alpaca_low")).toBe(false);
    expect(all.some(s => s.account_id === "momentum_stocks")).toBe(true);
    // …but still explicitly inspectable by account.
    expect(getRecentSignals(100, "alpaca_low").length).toBe(1);
  });
});

describe("closeTrade — pnl_pct corruption guard (P1)", () => {
  test("quantity=0 stores pnl_pct=0, not Infinity/NaN", () => {
    insertTrade({
      id: "ct_zero_qty", symbol: "SPY", market: "stock", side: "buy", strategy: "MOMENTUM",
      entryPrice: 100, quantity: 0, entryTime: Date.now(), status: "open",
    } as any, "momentum_stocks");
    const closed = closeTrade("ct_zero_qty", 110, Date.now());
    expect(closed).not.toBeNull();
    expect(closed!.pnlPct).toBe(0);
    expect(Number.isFinite(closed!.pnlPct)).toBe(true);
  });

  test("non-finite overridePnl falls back to price-derived pnl when it's finite", () => {
    insertTrade({
      id: "ct_bad_override", symbol: "SPY", market: "stock", side: "buy", strategy: "MOMENTUM",
      entryPrice: 100, quantity: 1, entryTime: Date.now(), status: "open",
    } as any, "momentum_stocks");
    const closed = closeTrade("ct_bad_override", 110, Date.now(), 0, NaN);
    // rawPnl = (110-100)*1 = 10, finite — must be used instead of a
    // fabricated 0 (a 0 would falsely count as a genuine breakeven outcome
    // in RECONCILE_CLOSE_SQL-scoped stats).
    expect(closed!.pnl).toBe(10);
    expect(closed!.pnlPct).toBe(10);
    const row = getDB().prepare(`SELECT pnl, pnl_pct, close_reason FROM trades WHERE id = ?`).get("ct_bad_override") as any;
    expect(row.pnl).toBe(10);
    expect(row.close_reason).not.toBe("MANUAL_CLOSE_UNRECONCILED");
  });

  test("non-finite overridePnl AND non-finite price-derived pnl store 0 with excluded close_reason", () => {
    insertTrade({
      id: "ct_bad_both", symbol: "SPY", market: "stock", side: "buy", strategy: "MOMENTUM",
      entryPrice: 100, quantity: 1, entryTime: Date.now(), status: "open",
    } as any, "close_contract");
    const closed = closeTrade("ct_bad_both", NaN, Date.now(), 0, NaN);
    expect(closed!.closeReason).toBe("MANUAL_CLOSE_UNRECONCILED");
    expect(closed!.pnl).toBe(0);
    expect(closed!.pnlPct).toBe(0);
    const row = getDB().prepare(`SELECT pnl, pnl_pct, close_reason FROM trades WHERE id = ?`).get("ct_bad_both") as any;
    expect(row.pnl).toBe(0);
    expect(Number.isFinite(row.pnl_pct)).toBe(true);
    expect(row.close_reason).toBe("MANUAL_CLOSE_UNRECONCILED");
    const stats = getTradingStats("close_contract", 0);
    expect(stats.closedTrades).toBe(0);
    expect(stats.totalPnl).toBe(0);
  });

  test("closeTradeExplicit rejects non-finite pnl and excludes the row from stats", () => {
    insertTrade({
      id: "ct_explicit_bad", symbol: "BTC/USD", market: "crypto", side: "buy", strategy: "MOMENTUM",
      entryPrice: 100, quantity: 1, entryTime: Date.now(), status: "open",
    } as any, "explicit_contract");
    const closed = closeTradeExplicit("ct_explicit_bad", 110, Date.now(), NaN, 10);
    expect(closed!.closeReason).toBe("MANUAL_CLOSE_UNRECONCILED");
    expect(closed!.pnl).toBe(0);
    expect(closed!.pnlPct).toBe(0);
    const row = getDB().prepare(`SELECT pnl, pnl_pct, close_reason FROM trades WHERE id = ?`).get("ct_explicit_bad") as any;
    expect(row).toEqual({ pnl: 0, pnl_pct: 0, close_reason: "MANUAL_CLOSE_UNRECONCILED" });
    expect(getTradingStats("explicit_contract", 0).closedTrades).toBe(0);
  });

  test("closeTradeExplicit returns the SAME reason it persisted (precedence must match SQL)", () => {
    insertTrade({
      id: "ct_explicit_reason_precedence", symbol: "BTC/USD", market: "crypto", side: "buy", strategy: "MOMENTUM",
      entryPrice: 100, quantity: 1, entryTime: Date.now(), status: "open",
    } as any, "explicit_contract");
    // Give the open row an existing close_reason, then close with a DIFFERENT one.
    getDB().prepare(`UPDATE trades SET close_reason = ? WHERE id = ?`).run("STALE_REASON", "ct_explicit_reason_precedence");
    const closed = closeTradeExplicit("ct_explicit_reason_precedence", 110, Date.now(), 10, 10, "NEW_REASON");
    const row = getDB().prepare(`SELECT close_reason FROM trades WHERE id = ?`).get("ct_explicit_reason_precedence") as any;
    expect(row.close_reason).toBe("NEW_REASON");
    expect(closed!.closeReason).toBe(row.close_reason);
  });
});

describe("getRecentTrades orders by latest activity (2026-09-29: UNI/USDC closed but missing from the dashboard)", () => {
  test("a position entered weeks ago and closed now ranks before rows entered later but closed earlier", () => {
    const now = Date.now();
    const ins = (id: string, entry: number, exit: number | null) => getDB().prepare(
      `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity, entry_time, status, exit_time, pnl, pnl_pct, profile_id, account_id, close_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, "UNI/USDC", "crypto", "buy", "MOMENTUM", 4.421, 377, entry, exit === null ? "open" : "closed", exit, exit === null ? null : 1, null, "order_probe", "order_probe", exit === null ? null : "MODEL_CUTOVER");
    ins("old-entry-closed-now", now - 31 * 86_400_000, now - 1_000);       // UNI: in 08-29, out 09-29
    ins("recent-entry-closed-earlier", now - 3 * 86_400_000, now - 2 * 86_400_000);
    ins("open-entered-yesterday", now - 86_400_000, null);
    const ids = getRecentTrades(2, "order_probe").map(t => t.id);
    expect(ids).toEqual(["old-entry-closed-now", "open-entered-yesterday"]);
  });
});
