// ensureAlpacaNativeStops — broker-native GTC stop-loss for the SHARED
// Alpaca wallet (OPEN.md P1: a stocks position was naked ~70% of calendar
// time because checkAllStopLoss can't close anything outside market hours).
// Mirrors the Binance sleeves' native STOP_MARKET pattern: place at/after
// open (≤60s via the Alpaca sync, which start() also awaits at startup),
// verify on every pass, replace on drift, attribute a FIRED stop back to its
// row. The 15s SL loop stays primary — a failed install must never close,
// throw, or otherwise degrade the pre-existing protection path.

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { closeTrade, getDB, getOpenTrades, insertTrade, updateTradeCloseReason } from "../db/database";
import { ALPACA_STOP_ON_FILL } from "./AccountManager";
import { RISK_PROFILES } from "../config/riskProfiles";
import { stopLossClientOrderId } from "../executor/alpaca-executor";
import { makeTestDb } from "../test-support/db";
import { makeAccountManager } from "../test-support/account";
import { captureBursts } from "../test-support/events";

const STOP_PCT = RISK_PROFILES.momentum_stocks.stopLossPct;
const ENTRY = 100;
const EXPECTED_STOP = ENTRY * (1 - STOP_PCT / 100); // long → protective SELL below entry

function manager(alpaca: Record<string, any>) {
  const m = makeAccountManager({
    alpaca: {
      isConnected: () => true,
      getAccount: async () => ({ equity: "100000", cash: "50000" }),
      getCachedPrice: () => 0,
      getLatestPrice: async () => 0,
      getPositions: async () => [],
      getOpenStopOrders: async () => [],
      cancelOrderById: async () => true,
      getOrderStateByClientId: async () => null,
      getOrderById: async () => null,
      invalidateCandleCache: () => {},
      placeStopLossOrder: async () => ({ ok: true, orderId: "stop-1" }),
      ...alpaca,
    },
  });
  // Passes run back-to-back here: zero the orphan-stop wall-clock floor so
  // the pass-count grace is what these tests exercise (the floor has its own
  // test below).
  (m as any).orphanStopGraceMinMs = 0;
  return m;
}

function seedTrade(accountId: string, overrides: Record<string, any> = {}): string {
  const id = overrides.id ?? `t_${Math.random().toString(36).slice(2, 10)}`;
  insertTrade({
    id,
    symbol: overrides.symbol ?? "AAPL",
    market: overrides.market ?? "stock",
    side: overrides.side ?? "buy",
    strategy: "MOMENTUM_TSM",
    entryPrice: overrides.entryPrice ?? ENTRY,
    quantity: overrides.quantity ?? 76,
    entryTime: overrides.entryTime ?? Date.now(),
    status: "open",
    // Vol-scaled per-row stop PRICE (2026-08-28 override) — undefined
    // persists NULL, i.e. the legacy profile-distance rows.
    stopLoss: overrides.stopLoss,
  } as any, accountId);
  return id;
}

function brokerStock(symbol: string, quantity: number) {
  return {
    symbol, market: "stock" as const, side: "buy" as const, quantity,
    avgEntryPrice: ENTRY, currentPrice: ENTRY, unrealizedPnl: 0, unrealizedPnlPct: 0, openedAt: Date.now(),
  };
}

function verifiedStop(tradeId: string, qty = 76) {
  return {
    id: "live-stop-1",
    clientOrderId: stopLossClientOrderId("momentum_stocks", tradeId),
    symbol: "AAPL", side: "sell" as const, qty, stopPrice: EXPECTED_STOP, status: "new",
  };
}

beforeAll(() => { makeTestDb(); });
beforeEach(() => {
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM equity_snapshots; DELETE FROM corporate_actions;");
});

describe("ensureAlpacaNativeStops — placement", () => {
  test("open stock row without a native stop → GTC stop placed at profile.stopLossPct anchored to ENTRY, own qty, deterministic (sleeve, trade) id", async () => {
    const tradeId = seedTrade("momentum_stocks");
    const stopCalls: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async (p: any) => { stopCalls.push(p); return { ok: true, orderId: "stop-1" }; },
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]).toEqual({
      symbol: "AAPL",
      positionSide: "buy",
      quantity: 76,
      stopPrice: EXPECTED_STOP, // SAME trigger checkAllStopLoss derives — the two layers agree
      accountId: "momentum_stocks",
      tradeId,
      stillNeeded: expect.any(Function), // under-lock re-check (OPEN.md P1 ABBV) — must always travel with the placement
    });
  });

  test("a verified live stop → nothing placed, nothing canceled (idempotent pass)", async () => {
    const tradeId = seedTrade("momentum_stocks");
    const placed: any[] = [];
    const canceled: string[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOpenStopOrders: async () => [verifiedStop(tradeId)],
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true }; },
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(placed).toHaveLength(0);
    expect(canceled).toHaveLength(0);
  });

  test("qty is bounded to OUR row when the shared broker book holds MORE (manual/foreign shares are not ours to close)", async () => {
    seedTrade("momentum_stocks", { quantity: 76 });
    const stopCalls: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 150)], // aggregate > our row
      placeStopLossOrder: async (p: any) => { stopCalls.push(p); return { ok: true }; },
    });
    await (m as any).ensureAlpacaNativeStops();
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0].quantity).toBe(76); // never the broker aggregate
  });

  test("qty is bounded to the BROKER when it holds less than our row (never an over-sized stop)", async () => {
    seedTrade("momentum_stocks", { quantity: 76 });
    const stopCalls: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 50)],
      placeStopLossOrder: async (p: any) => { stopCalls.push(p); return { ok: true }; },
    });
    await (m as any).ensureAlpacaNativeStops();
    expect(stopCalls[0].quantity).toBe(50);
  });

  test("a drifted stop (trigger off the expected price) is canceled by EXACT id and re-placed", async () => {
    const tradeId = seedTrade("momentum_stocks");
    const canceled: string[] = [];
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOpenStopOrders: async () => [{
        id: "drifted-stop-9",
        clientOrderId: stopLossClientOrderId("momentum_stocks", tradeId),
        symbol: "AAPL", side: "sell", qty: 76, stopPrice: 50, status: "new", // absurd trigger ≠ protection
      }],
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true }; },
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(canceled).toEqual(["drifted-stop-9"]);
    expect(placed).toHaveLength(1);
    expect(placed[0].stopPrice).toBe(EXPECTED_STOP);
  });
});

describe("ensureAlpacaNativeStops — failure containment", () => {
  test("a failed install never throws, never closes the row, and the NEXT row still gets its stop", async () => {
    seedTrade("momentum_stocks", { symbol: "AAPL" });
    seedTrade("meanrev_stocks", { symbol: "KO", quantity: 20 });
    const attempts: string[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76), brokerStock("KO", 20)],
      placeStopLossOrder: async (p: any) => {
        attempts.push(p.symbol);
        return p.symbol === "AAPL" ? { ok: false, reason: "http_403" } : { ok: true };
      },
    });

    await (m as any).ensureAlpacaNativeStops(); // must not throw

    expect(attempts).toEqual(["AAPL", "KO"]); // flow not broken by the failure
    expect(getOpenTrades("momentum_stocks")).toHaveLength(1); // still open → 15s loop keeps guarding it
    expect(getOpenTrades("meanrev_stocks")).toHaveLength(1);
  });

  test("a failed stop-order enumeration skips the pass (unknown ≠ none — no blind double-placement) without breaking syncAlpacaAccount", async () => {
    seedTrade("momentum_stocks");
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOpenStopOrders: async () => { throw new Error("orders endpoint down"); },
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true }; },
    });

    await (m as any).syncAlpacaAccount(); // wrapped: the 60s sync must survive

    expect(placed).toHaveLength(0);
    expect(getOpenTrades("momentum_stocks")).toHaveLength(1);
  });
});

describe("ensureAlpacaNativeStops — startup/periodic wiring + fired-stop attribution", () => {
  test("syncAlpacaAccount (startup path — start() awaits it) places the missing stop", async () => {
    const tradeId = seedTrade("momentum_stocks");
    const stopCalls: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async (p: any) => { stopCalls.push(p); return { ok: true }; },
    });

    await (m as any).syncAlpacaAccount();

    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0].tradeId).toBe(tradeId);
  });

  test("broker flat + our deterministic stop FILLED → row closed at the REAL fill with BROKER_STOP_LOSS (never a fabricated pnl=0)", async () => {
    const tradeId = seedTrade("momentum_stocks", { quantity: 76 });
    const cid = stopLossClientOrderId("momentum_stocks", tradeId);
    const m = manager({
      getPositions: async () => [], // gap fired overnight: broker already flat
      getOrderStateByClientId: async (id: string) =>
        id === cid ? { status: "filled", filledQty: 76, filledAvgPrice: 92.5, filledAt: Date.now() } : null,
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(getOpenTrades("momentum_stocks")).toHaveLength(0);
    const row = getDB().prepare(`SELECT status, exit_price, close_reason, pnl FROM trades WHERE id = ?`).get(tradeId) as any;
    expect(row.status).toBe("closed");
    expect(row.exit_price).toBe(92.5);
    expect(row.close_reason).toBe("BROKER_STOP_LOSS");
    expect(row.pnl).toBeCloseTo((92.5 - ENTRY) * 76, 6); // the real loss, attributed
  });

  test("broker flat but the stop did NOT fill → row left open for the existing reconcile paths", async () => {
    seedTrade("momentum_stocks");
    const m = manager({
      getPositions: async () => [],
      getOrderStateByClientId: async () => ({ status: "canceled", filledQty: 0, filledAvgPrice: 0 }),
    });
    await (m as any).ensureAlpacaNativeStops();
    expect(getOpenTrades("momentum_stocks")).toHaveLength(1);
  });

  test("non-stock rows are out of scope (crypto protection is the Binance executors' native stop)", async () => {
    seedTrade("momentum_stocks", { symbol: "BTC/USD", market: "crypto" });
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => [],
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true }; },
    });
    await (m as any).ensureAlpacaNativeStops();
    expect(placed).toHaveLength(0);
  });
});

// ── Per-STATUS resolution of a missing stop (2026-08-03) ───────────────────
// Existence alone can't distinguish WHY our stop left the open-order book,
// and the why decides the fix (docs.alpaca.markets, disclosures/corporate
// actions): reverse splits CANCEL working GTC orders (→ naked position,
// re-place NOW); forward splits REPLACE them with an adjusted successor
// under a broker-generated client_order_id (→ invisible to the uc8
// enumeration; placing again would DOUBLE the protection — adopt instead).
describe("resolveMissingNativeStop — canceled vs replaced vs filled", () => {
  test("stop CANCELED broker-side (reverse split / external cancel) → re-placed immediately, with the distinction logged to activity", async () => {
    seedTrade("momentum_stocks");
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOrderStateByClientId: async () => ({ status: "canceled", filledQty: 0, filledAvgPrice: 0, replacedBy: null }),
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true }; },
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(placed).toHaveLength(1);
    expect(placed[0].stopPrice).toBe(EXPECTED_STOP);
    const acts = getDB().prepare(`SELECT message FROM activity_log WHERE account_id = 'momentum_stocks'`).all() as any[];
    expect(acts.some(a => /reverse split/i.test(a.message) && /canceled/i.test(a.message))).toBe(true);
  });

  test("stop REPLACED broker-side (forward split) → replaced_by chain followed, successor ADOPTED, NO duplicate stop placed", async () => {
    const tradeId = seedTrade("momentum_stocks");
    const cid = stopLossClientOrderId("momentum_stocks", tradeId);
    const placed: any[] = [];
    const canceled: string[] = [];
    const lookups: string[] = [];
    const orders: Record<string, any> = {
      // two hops: our order → mid (also replaced) → the live adjusted stop
      "mid-1": { id: "mid-1", clientOrderId: "broker-gen-a", symbol: "AAPL", status: "replaced", type: "stop", side: "sell", qty: 76, stopPrice: 96, replacedBy: "adj-1", filledQty: 0, filledAvgPrice: 0 },
      "adj-1": { id: "adj-1", clientOrderId: "broker-gen-b", symbol: "AAPL", status: "new", type: "stop", side: "sell", qty: 152, stopPrice: 48, replacedBy: null, filledQty: 0, filledAvgPrice: 0 },
    };
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 152)], // post-2:1-split broker book
      getOrderStateByClientId: async (id: string) =>
        id === cid ? { status: "replaced", filledQty: 0, filledAvgPrice: 0, replacedBy: "mid-1" } : null,
      getOrderById: async (id: string) => { lookups.push(id); return orders[id] ?? null; },
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true }; },
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(placed).toHaveLength(0);   // a second stop would sell 2× qty on trigger
    expect(canceled).toHaveLength(0); // the adjusted successor IS the protection
    expect(lookups).toEqual(["mid-1", "adj-1"]);
    const acts = getDB().prepare(`SELECT message FROM activity_log WHERE account_id = 'momentum_stocks'`).all() as any[];
    expect(acts.some(a => /adopted replacement order adj-1/.test(a.message))).toBe(true);

    // Second pass: the adoption short-circuits (re-verified by exact id), still no duplicate.
    lookups.length = 0;
    await (m as any).ensureAlpacaNativeStops();
    expect(placed).toHaveLength(0);
    expect(lookups).toEqual(["adj-1"]);
  });

  test("adopted successor later FILLS while broker goes flat → row closed at the successor's REAL fill (BROKER_STOP_LOSS)", async () => {
    const tradeId = seedTrade("momentum_stocks", { quantity: 76 });
    const cid = stopLossClientOrderId("momentum_stocks", tradeId);
    let brokerBook = [brokerStock("AAPL", 152)];
    let adjStatus: any = { id: "adj-1", clientOrderId: "broker-gen", symbol: "AAPL", status: "new", type: "stop", side: "sell", qty: 152, stopPrice: 48, replacedBy: null, filledQty: 0, filledAvgPrice: 0 };
    const m = manager({
      getPositions: async () => brokerBook,
      getOrderStateByClientId: async (id: string) =>
        id === cid ? { status: "replaced", filledQty: 0, filledAvgPrice: 0, replacedBy: "adj-1" } : null,
      getOrderById: async (id: string) => (id === "adj-1" ? adjStatus : null),
    });

    await (m as any).ensureAlpacaNativeStops(); // pass 1: adopt

    // Overnight: the adjusted stop fires, broker is flat by the next sync.
    brokerBook = [];
    adjStatus = { ...adjStatus, status: "filled", filledQty: 152, filledAvgPrice: 47.5, filledAt: Date.now() };
    // Row basis was adjusted by the corporate-action handler (2:1) — the fill
    // attribution must use the successor's price against the adjusted row.
    getDB().prepare(`UPDATE trades SET quantity = 152, entry_price = 50 WHERE id = ?`).run(tradeId);

    await (m as any).ensureAlpacaNativeStops(); // pass 2: attribute

    const row = getDB().prepare(`SELECT status, exit_price, close_reason, pnl FROM trades WHERE id = ?`).get(tradeId) as any;
    expect(row.status).toBe("closed");
    expect(row.exit_price).toBe(47.5);
    expect(row.close_reason).toBe("BROKER_STOP_LOSS");
    expect(row.pnl).toBeCloseTo((47.5 - 50) * 152, 6); // the real post-split loss, never pnl=0
  });

  test("replaced_by chain ending in a DEAD order (canceled successor) → falls back to re-placing our own stop", async () => {
    const tradeId = seedTrade("momentum_stocks");
    const cid = stopLossClientOrderId("momentum_stocks", tradeId);
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOrderStateByClientId: async (id: string) =>
        id === cid ? { status: "replaced", filledQty: 0, filledAvgPrice: 0, replacedBy: "dead-1" } : null,
      getOrderById: async () => ({ id: "dead-1", clientOrderId: "x", symbol: "AAPL", status: "canceled", type: "stop", side: "sell", qty: 76, stopPrice: 96, replacedBy: null, filledQty: 0, filledAvgPrice: 0 }),
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true }; },
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(placed).toHaveLength(1); // no adoptable protection → naked → re-place
  });
});

// ── Ops paging for a missing native stop (B-ops-alerts.md #3) ─────────────
// Before this fix, a failed GTC install only logged (log.error) — the CAT
// 2026-09-14 incident (4× 422 reinstall failures 13:32–13:35, rearmed
// 13:36:02) never reached logger's 10-in-60s ERROR_BURST threshold at this
// pass's 60s cadence, so nobody was paged. Now: ONE immediate page on the
// FIRST failure (dedup by account:symbol — repeat failures across passes
// don't re-page, same idiom as every other aggregated alert in this file),
// and ONE "RESOLVED" page once the stop actually installs/verifies/adopts
// or the row closes via the stop's own fill.
describe("ops paging for a missing native stop", () => {
  test("install failure pages ops immediately, once — repeated failures across passes do NOT re-page", async () => {
    seedTrade("momentum_stocks", { symbol: "AAPL" });
    const { bursts, detach } = captureBursts("AccountManager.nativeStopMissing");
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async () => ({ ok: false, reason: "http_422" }),
    });
    try {
      // Mirrors the CAT incident: several consecutive 60s passes, all failing.
      for (let i = 0; i < 4; i++) await (m as any).ensureAlpacaNativeStops();
      expect(bursts).toHaveLength(1);
      expect(bursts[0].message).toContain("AAPL");
      expect(bursts[0].message).toContain("http_422");
      expect(bursts[0].message).toContain("NO confirmed native stop");
    } finally {
      detach();
    }
  });

  test("a stop that installs on the very first pass never pages (no false positive)", async () => {
    seedTrade("momentum_stocks", { symbol: "AAPL" });
    const { bursts, detach } = captureBursts("AccountManager.nativeStopMissing");
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async () => ({ ok: true, orderId: "stop-1" }),
    });
    try {
      await (m as any).ensureAlpacaNativeStops();
      expect(bursts).toHaveLength(0);
    } finally {
      detach();
    }
  });

  test("once paged, a later successful install pages a RESOLVED follow-up", async () => {
    seedTrade("momentum_stocks", { symbol: "AAPL" });
    const { bursts, detach } = captureBursts("AccountManager.nativeStopMissing");
    let ok = false;
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async () => (ok ? { ok: true, orderId: "stop-1" } : { ok: false, reason: "http_422" }),
    });
    try {
      await (m as any).ensureAlpacaNativeStops(); // fails → pages
      ok = true;
      await (m as any).ensureAlpacaNativeStops(); // succeeds → resolves
      expect(bursts).toHaveLength(2);
      expect(bursts[0].message).not.toContain("RESOLVED");
      expect(bursts[1].message).toContain("RESOLVED");
      expect(bursts[1].message).toContain("AAPL");
    } finally {
      detach();
    }
  });

  test("the row closing via an UNRELATED path (e.g. the 15s loop / engine rebalance) prunes the incident silently — no RESOLVED page for a position that's simply gone", async () => {
    const tradeId = seedTrade("momentum_stocks", { symbol: "AAPL", quantity: 76 });
    const { bursts, detach } = captureBursts("AccountManager.nativeStopMissing");
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async () => ({ ok: false, reason: "http_422" }),
    });
    try {
      await (m as any).ensureAlpacaNativeStops(); // fails → pages (incident open)
      expect(bursts).toHaveLength(1);
      closeTrade(tradeId, 95, Date.now(), 0); // closed by some other path — row no longer open
      await (m as any).ensureAlpacaNativeStops(); // row is out of scope this pass → prune, not resolve
      expect(bursts).toHaveLength(1); // no second (RESOLVED) page — this is a prune, not a recovery
    } finally {
      detach();
    }
  });
});

// ── Reentrancy: 60s sync vs corporate-action monitor (2026-08-04) ──────────
// applyCorporateAction calls ensureAlpacaNativeStops OUTSIDE the syncingAlpaca
// guard. Two interleaved passes each read openStops once and await per-row;
// with the deterministic client id burned (`canceled` — the reverse-split
// case, the very one the monitor forces) the re-place uses a SALTED id, so
// broker-side duplicate-id idempotency does NOT protect: both passes place →
// two live stops → 2× qty sold on trigger → accidental short position.
describe("ensureAlpacaNativeStops — reentrancy serialization", () => {
  test("two concurrent invocations never place two stops for the same row", async () => {
    seedTrade("momentum_stocks");
    const placed: any[] = [];
    const liveStops: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOpenStopOrders: async () => [...liveStops],
      // Burned deterministic id (reverse-split shape): resolve → "place",
      // and the broker cannot dedupe the salted successor id. The timer here
      // is the await hole: a slow per-row broker read AFTER openStops was
      // already read — the second unguarded pass reads its own (still empty)
      // openStops during this window and places a duplicate.
      getOrderStateByClientId: async () => {
        await new Promise(r => setTimeout(r, 10));
        return { status: "canceled", filledQty: 0, filledAvgPrice: 0, replacedBy: null };
      },
      placeStopLossOrder: async (p: any) => {
        placed.push(p);
        liveStops.push({
          id: `stop-${placed.length}`, clientOrderId: `salted-${placed.length}`,
          symbol: p.symbol, side: "sell", qty: p.quantity, stopPrice: p.stopPrice, status: "new",
        });
        return { ok: true, orderId: `stop-${placed.length}` };
      },
    });

    await Promise.all([
      (m as any).ensureAlpacaNativeStops(), // the 60s sync pass…
      (m as any).ensureAlpacaNativeStops(), // …and the corporate-action monitor's forced pass
    ]);

    // Serialized: the second pass re-reads openStops fresh, verifies the
    // first pass's stop, and no-ops. Unserialized this is 2 → double qty.
    expect(placed).toHaveLength(1);
  });

  test("a THROWN pass does not poison the queue — the next invocation still runs", async () => {
    seedTrade("momentum_stocks");
    let calls = 0;
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => {
        if (++calls === 1) throw new Error("broker read down");
        return [brokerStock("AAPL", 76)];
      },
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true } as any; },
    });

    await expect((m as any).ensureAlpacaNativeStops()).rejects.toThrow("broker read down");
    await (m as any).ensureAlpacaNativeStops(); // queued behind the failure, must still run

    expect(placed).toHaveLength(1);
  });
});

// ── Corporate-action application (daily pre-open monitor callback) ─────────
describe("applyCorporateAction", () => {
  const splitEvent = {
    symbol: "AAPL", type: "forward_split" as const, exDate: "2026-08-01",
    oldRate: 1, newRate: 2, ratio: 2, raw: { symbol: "AAPL", old_rate: 1, new_rate: 2 },
  };

  test("PAST forward split: candle cache invalidated, row basis adjusted ONCE (qty ×2, entry ÷2), stop re-verify forced at the adjusted trigger", async () => {
    // Entered BEFORE the 2026-08-01 ex-date — the held-through-the-split row
    // this scenario always meant. (Since the entry_time cutoff fix, a row
    // entered AFTER the ex-date is deliberately left alone — that intact-row
    // case is locked by corporateActionTrailMarks.test.ts.)
    const tradeId = seedTrade("momentum_stocks", { quantity: 76, entryPrice: 100, entryTime: new Date("2026-07-15T12:00:00Z").getTime() });
    const invalidated: string[] = [];
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 152)],
      invalidateCandleCache: (s: string) => { invalidated.push(s); },
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true }; },
    });

    await m.applyCorporateAction(splitEvent, "past");

    const row = getDB().prepare(`SELECT quantity, entry_price FROM trades WHERE id = ?`).get(tradeId) as any;
    expect(row.quantity).toBe(152);
    expect(row.entry_price).toBe(50);
    expect(invalidated).toEqual(["AAPL"]); // adjustment=all rewrote history retroactively
    // Forced re-verification placed the stop from the ADJUSTED basis — the
    // stale-basis stop (96 > post-split price ~50) would fire instantly.
    expect(placed).toHaveLength(1);
    expect(placed[0].quantity).toBe(152);
    expect(placed[0].stopPrice).toBeCloseTo(50 * (1 - STOP_PCT / 100), 10);

    // IDEMPOTENT: a later daily check re-detecting the same event must not
    // re-apply the ratio (that would corrupt the basis).
    await m.applyCorporateAction(splitEvent, "past");
    const again = getDB().prepare(`SELECT quantity, entry_price FROM trades WHERE id = ?`).get(tradeId) as any;
    expect(again.quantity).toBe(152);
    expect(again.entry_price).toBe(50);
  });

  test("UPCOMING event: alert only (activity + ops page), rows and broker untouched, paged exactly once", async () => {
    const tradeId = seedTrade("momentum_stocks", { quantity: 76, entryPrice: 100 });
    const { bursts, detach } = captureBursts("CorporateActions");
    try {
      const m = manager({});
      const ev = { ...splitEvent, exDate: "2026-08-09" };

      await m.applyCorporateAction(ev, "upcoming");
      await m.applyCorporateAction(ev, "upcoming"); // next daily check re-detects it

      const row = getDB().prepare(`SELECT quantity, entry_price, status FROM trades WHERE id = ?`).get(tradeId) as any;
      expect(row).toEqual({ quantity: 76, entry_price: 100, status: "open" }); // informational — NEVER a close/adjust
      expect(bursts).toHaveLength(1); // once at first detection, not once per day
      const acts = getDB().prepare(`SELECT message FROM activity_log WHERE account_id = 'momentum_stocks'`).all() as any[];
      expect(acts.some(a => /Corporate action AHEAD/.test(a.message))).toBe(true);
    } finally {
      detach();
    }
  });

  test("PAST non-split (stock_merger): no mechanical row fix exists — page a human once, never touch the basis", async () => {
    const tradeId = seedTrade("momentum_stocks", { quantity: 76, entryPrice: 100 });
    const { bursts, detach } = captureBursts("CorporateActions");
    try {
      const m = manager({ getPositions: async () => [brokerStock("AAPL", 76)] });
      const ev = { symbol: "AAPL", type: "stock_merger" as const, exDate: "2026-08-01", raw: {} };

      await m.applyCorporateAction(ev, "past");
      await m.applyCorporateAction(ev, "past");

      const row = getDB().prepare(`SELECT quantity, entry_price FROM trades WHERE id = ?`).get(tradeId) as any;
      expect(row).toEqual({ quantity: 76, entry_price: 100 });
      expect(bursts).toHaveLength(1);
    } finally {
      detach();
    }
  });
});

// ── The armed stop must be VISIBLE, not just real (2026-08-09) ────────────
// The owner looked at the dashboard, saw "—" in every Alpaca SL cell, and
// reasonably concluded the positions were unprotected. They were not: all
// nine carried a live GTC stop at the broker. The Binance adapters had always
// mirrored the trigger onto trades.stop_loss; the Alpaca path never did. A
// protection an operator cannot see is one they cannot trust — these fail if
// the mirroring is removed.
describe("the armed stop is mirrored onto the trade row (dashboard SL column)", () => {
  test("placing a stop writes its trigger to trades.stop_loss", async () => {
    const tradeId = seedTrade("momentum_stocks");
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async () => ({ ok: true, orderId: "stop-1" }),
    });

    await (m as any).ensureAlpacaNativeStops();

    const row = getDB().prepare(`SELECT stop_loss FROM trades WHERE id = ?`).get(tradeId) as any;
    expect(row.stop_loss).toBeCloseTo(EXPECTED_STOP, 6);
  });

  test("a VERIFIED pre-existing stop refreshes the row too — a restart must not leave it blank", async () => {
    const tradeId = seedTrade("momentum_stocks");
    const stopCalls: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOpenStopOrders: async () => [verifiedStop(tradeId)],
      placeStopLossOrder: async (p: any) => { stopCalls.push(p); return { ok: true, orderId: "x" }; },
    });

    await (m as any).ensureAlpacaNativeStops();

    const row = getDB().prepare(`SELECT stop_loss FROM trades WHERE id = ?`).get(tradeId) as any;
    expect(row.stop_loss).toBeCloseTo(EXPECTED_STOP, 6);
    // …and visibility was achieved WITHOUT placing a duplicate stop.
    expect(stopCalls).toHaveLength(0);
  });

  test("a failed install leaves stop_loss NULL — never claim protection that is not there", async () => {
    const tradeId = seedTrade("momentum_stocks");
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async () => ({ ok: false, reason: "broker rejected" }),
    });

    await (m as any).ensureAlpacaNativeStops();

    const row = getDB().prepare(`SELECT stop_loss FROM trades WHERE id = ?`).get(tradeId) as any;
    expect(row.stop_loss).toBeNull();
  });
});

// ── Check-then-act race across the symbol lock (OPEN.md P1, 2026-08-11) ────
// Prod incident: 9 Alpaca positions, 10 live GTC stops. ABBV's row closed
// with MEANREV_EXIT while a native-stops pass that had ALREADY decided "this
// row needs a stop" (from a pre-close snapshot) sat waiting on the symbol
// lock; on acquiring it, the pass placed a stop for a closed row. A sell stop
// with no long behind it opens a NAKED SHORT if it fires, and its resting
// presence wash-trade-403s every new buy of the symbol. The fix: the decision
// is re-validated UNDER the lock via the stillNeeded callback (DB row still
// open) plus the executor's own broker-flat re-read.
describe("check-then-act race: row closed between the pass's decision and stop placement", () => {
  test("row closed while the placement waited on the symbol lock → stillNeeded (re-read under the lock) is false → NO stop placed, audited as skip, never as install failure", async () => {
    const tradeId = seedTrade("meanrev_stocks", { symbol: "ABBV", quantity: 20 });
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("ABBV", 20)],
      // Honor the executor's under-lock contract exactly like the real
      // placeStopLossOrder does: the concurrent closePosition HOLDS the
      // symbol lock while it cancels stops, sells and closes the row — only
      // then does the queued placement run and consult stillNeeded.
      placeStopLossOrder: async (p: any) => {
        closeTrade(tradeId, 105, Date.now(), 0); // the close wins the lock first
        if (p.stillNeeded && !(await p.stillNeeded())) {
          return { ok: false, skipped: true, reason: "row no longer open (closed while waiting for the symbol lock)" };
        }
        placed.push(p);
        return { ok: true, orderId: "orphan-to-be" };
      },
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(placed).toHaveLength(0); // revert-falsifier: drop the caller's stillNeeded → 1 → orphan class reopened
    const acts = getDB().prepare(`SELECT event_type, message FROM activity_log WHERE account_id = 'meanrev_stocks'`).all() as any[];
    expect(acts.some(a => a.event_type === "system" && /skipped/i.test(a.message))).toBe(true); // audited…
    expect(acts.some(a => a.event_type === "error")).toBe(false); // …and the race guard working is NOT an install failure
  });

  test("the stillNeeded callback tells DB truth: true while the row is open, false once it closes", async () => {
    const tradeId = seedTrade("meanrev_stocks", { symbol: "ABBV", quantity: 20 });
    const answers: boolean[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("ABBV", 20)],
      placeStopLossOrder: async (p: any) => {
        answers.push(await p.stillNeeded()); // open at decision time
        closeTrade(tradeId, 105, Date.now(), 0);
        answers.push(await p.stillNeeded()); // closed while lock-waiting
        return { ok: false, skipped: true, reason: "row no longer open" };
      },
    });
    await (m as any).ensureAlpacaNativeStops();
    expect(answers).toEqual([true, false]);
  });
});

// ── Orphan-stop sweep (OPEN.md P1, 2026-08-11) ─────────────────────────────
// Structural half of the ABBV incident: the pass iterated DB rows only, so a
// resting uc8 stop whose row was gone was invisible BY CONSTRUCTION — nothing
// would EVER pick it up. The sweep reads the broker's stop book directly and
// cancels OUR stops with no position behind them: by exact id, never a
// blanket cancel; uc8-owned only; fail-closed on any enumeration failure; and
// only after ALPACA_ORPHAN_STOP_GRACE_CYCLES consecutive orphan sightings
// (the inverse race — a live position transiently missing from enumeration —
// must never cost a position its overnight protection).
describe("orphan-stop sweep", () => {
  const orphan = {
    id: "orphan-stop-abbv",
    clientOrderId: "uc8-meanrev_stocks-slabc123",
    symbol: "ABBV", side: "sell" as const, qty: 20, stopPrice: 234.91, status: "new",
  };

  test("a uc8 stop with NO broker position (and NO DB row — invisible to the per-row pass) is canceled by EXACT id after the grace, and audited", async () => {
    // No DB rows at all: also locks in that the pass no longer early-returns
    // on an empty book (the early return would blind the sweep forever).
    const canceled: string[] = [];
    let book = [orphan];
    const m = manager({
      getPositions: async () => [], // broker flat — ABBV was closed yesterday
      getOpenStopOrders: async () => [...book],
      cancelOrderById: async (id: string) => { canceled.push(id); book = book.filter(o => o.id !== id); return true; },
    });

    // Grace cycles 1–2: seen, counted, NOT canceled.
    await (m as any).ensureAlpacaNativeStops();
    await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual([]);

    // Cycle 3: grace crossed → canceled, by exact id only.
    await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual(["orphan-stop-abbv"]);

    // Audited under the owning sleeve (parsed from the client_order_id).
    const acts = getDB().prepare(`SELECT message FROM activity_log WHERE account_id = 'meanrev_stocks'`).all() as any[];
    expect(acts.some(a => /ORPHANED GTC stop on ABBV/.test(a.message) && /orphan-stop-abbv/.test(a.message))).toBe(true);

    // Idempotent: the stop is gone from the book — nothing more to cancel.
    await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toHaveLength(1);
  });

  test("wall-clock floor: 3 back-to-back passes (stop-on-fill makes passes seconds apart) do NOT cancel before ALPACA_ORPHAN_STOP_GRACE_MIN_MS", async () => {
    const canceled: string[] = [];
    let book = [orphan];
    const m = manager({
      getPositions: async () => [],
      getOpenStopOrders: async () => [...book],
      cancelOrderById: async (id: string) => { canceled.push(id); book = book.filter(o => o.id !== id); return true; },
    });
    (m as any).orphanStopGraceMinMs = 150_000;
    for (let i = 0; i < 4; i++) await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual([]); // pass count crossed, wall clock not
    // Age the first sighting past the floor → the next pass cancels.
    (m as any).alpacaOrphanStopFirstSeen.set(orphan.id, Date.now() - 151_000);
    await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual([orphan.id]);
    expect((m as any).alpacaOrphanStopFirstSeen.has(orphan.id)).toBe(false);
  });

  test("a legitimate stop protecting a LIVE position is NEVER canceled, no matter how many passes (the false positive here strips a position of its overnight protection)", async () => {
    const tradeId = seedTrade("momentum_stocks", { symbol: "AAPL", quantity: 76 });
    const canceled: string[] = [];
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOpenStopOrders: async () => [verifiedStop(tradeId)],
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true }; },
    });
    for (let i = 0; i < 5; i++) await (m as any).ensureAlpacaNativeStops(); // well past any grace
    expect(canceled).toEqual([]);
    expect(placed).toEqual([]); // and the verified stop was never churned either
  });

  test("a stop whose position EXISTS at the broker but has no DB row yet (adoption in flight) survives — held symbol, not an orphan", async () => {
    const canceled: string[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)], // broker long, row not adopted yet
      getOpenStopOrders: async () => [{
        id: "pre-adoption-stop", clientOrderId: "uc8-momentum_stocks-slzzz",
        symbol: "AAPL", side: "sell" as const, qty: 76, stopPrice: EXPECTED_STOP, status: "new",
      }],
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
    });
    for (let i = 0; i < 5; i++) await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual([]);
  });

  test("a FOREIGN stop (no uc8- prefix) is never touched, even with no position behind it — defense in depth over the enumeration filter", async () => {
    const canceled: string[] = [];
    const m = manager({
      getPositions: async () => [],
      // Simulates the upstream uc8 filter failing open: the sweep must
      // re-verify ownership itself before any cancel.
      getOpenStopOrders: async () => [{
        id: "human-stop-1", clientOrderId: "manually-placed-by-a-human",
        symbol: "ABBV", side: "sell" as const, qty: 5, stopPrice: 200, status: "new",
      }],
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
    });
    for (let i = 0; i < 5; i++) await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual([]);
  });

  test("fail closed: a failed positions or stop-book enumeration cancels NOTHING ('unknown' is never 'no position'), and the sweep resumes where it left off once reads recover", async () => {
    const canceled: string[] = [];
    let positionsDown = false;
    let stopsDown = false;
    const m = manager({
      getPositions: async () => { if (positionsDown) throw new Error("positions endpoint down"); return []; },
      getOpenStopOrders: async () => { if (stopsDown) throw new Error("orders endpoint down"); return [orphan]; },
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
    });

    // Two clean sightings — one short of the grace.
    await (m as any).ensureAlpacaNativeStops();
    await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual([]);

    // Broker reads fail exactly when the NEXT pass would have canceled.
    positionsDown = true;
    await expect((m as any).ensureAlpacaNativeStops()).rejects.toThrow("positions endpoint down");
    expect(canceled).toEqual([]);
    positionsDown = false;
    stopsDown = true;
    await (m as any).syncAlpacaAccount(); // wrapped path: the 60s sync survives the throw
    expect(canceled).toEqual([]);

    // Reads recover → counter was preserved (failed passes don't reset it,
    // they just can't act) → the third SUCCESSFUL sighting cancels.
    stopsDown = false;
    await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual(["orphan-stop-abbv"]);
  });

  test("the grace counter RESETS when the position reappears — an intermittently-visible position never accumulates toward a cancel", async () => {
    const canceled: string[] = [];
    let positions: any[] = [];
    const m = manager({
      getPositions: async () => positions,
      getOpenStopOrders: async () => [orphan],
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
    });

    // 2 orphan sightings…
    await (m as any).ensureAlpacaNativeStops();
    await (m as any).ensureAlpacaNativeStops();
    // …then the position shows up again (transient enumeration gap over).
    positions = [brokerStock("ABBV", 20)];
    await (m as any).ensureAlpacaNativeStops();
    // Gone again: the count must restart at 1 — two more sightings stay shy
    // of the grace…
    positions = [];
    await (m as any).ensureAlpacaNativeStops();
    await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual([]); // revert-falsifier: drop the seen-prune → cancel fires here
    // …and only a THIRD consecutive one cancels.
    await (m as any).ensureAlpacaNativeStops();
    expect(canceled).toEqual(["orphan-stop-abbv"]);
  });
});

// Row-stop precedence (vol-scaled override 2026-08-28). The ensure pass's
// contract used to be "expected = profile 4% from entry; a mismatched stop is
// not protection — replace it". With per-row vol stops that same replace
// logic would UNDO the override every 60s, so expectedStop now derives via
// rowStopPct: row's persisted stop first, profile pct only as fallback.
describe("ensureAlpacaNativeStops — row-stop precedence over profile pct", () => {
  test("row with a vol-scaled stop (8% on a long) → the GTC stop arms AT the row's price, not at profile 4%", async () => {
    const tradeId = seedTrade("momentum_stocks", { stopLoss: ENTRY * 0.92 });
    const stopCalls: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async (p: any) => { stopCalls.push(p); return { ok: true, orderId: "stop-1" }; },
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0].tradeId).toBe(tradeId);
    expect(stopCalls[0].stopPrice).toBeCloseTo(ENTRY * 0.92, 10);
    // Revert-falsifier: restore the profile-only expectedStop → this arms 96.
  });

  test("an ARMED stop matching the row's vol price is VERIFIED — not replaced toward profile 4%", async () => {
    const tradeId = seedTrade("momentum_stocks", { stopLoss: ENTRY * 0.92 });
    const canceled: string[] = [];
    const stopCalls: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOpenStopOrders: async () => [{
        id: "live-vol-stop",
        clientOrderId: stopLossClientOrderId("momentum_stocks", tradeId),
        symbol: "AAPL", side: "sell" as const, qty: 76, stopPrice: ENTRY * 0.92, status: "new",
      }],
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
      placeStopLossOrder: async (p: any) => { stopCalls.push(p); return { ok: true, orderId: "stop-2" }; },
    });

    await (m as any).ensureAlpacaNativeStops();

    // Before the fix: 92 vs expected 96 is outside the 1% tolerance → the
    // pass canceled the vol stop and re-armed 4% — the layers fighting.
    expect(canceled).toEqual([]);
    expect(stopCalls).toEqual([]);
    const row = getOpenTrades("momentum_stocks").find(t => t.id === tradeId) as any;
    expect(row.stopLoss).toBeCloseTo(ENTRY * 0.92, 10); // row mirror intact
  });

  test("row WITHOUT a persisted stop keeps the legacy profile-4% expectation — pre-override rows unchanged", async () => {
    seedTrade("momentum_stocks");
    const stopCalls: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      placeStopLossOrder: async (p: any) => { stopCalls.push(p); return { ok: true, orderId: "stop-3" }; },
    });

    await (m as any).ensureAlpacaNativeStops();

    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0].stopPrice).toBeCloseTo(EXPECTED_STOP, 10);
  });
});

// ── Stop-on-fill (ALPACA_STOP_ON_FILL, 2026-09-26) ──────────────────────────
// A just-filled Alpaca stock ENTRY used to wait ≤60s for the next
// syncAlpacaAccount cycle to arm its GTC stop (QCOM 2026-09-25: fill
// 13:36:29 → stop 13:37:12). The ORDER_FILLED event now schedules ONE
// debounced ensureAlpacaNativeStops pass — same serialized/idempotent
// reconciler, deterministic client ids; the 60s timer stays the backstop.
describe("stop-on-fill — ORDER_FILLED schedules a debounced native-stop pass", () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  function stockFill(accountId: string, symbol = "AAPL") {
    return { accountId, symbol, side: "buy", quantity: 76, filledPrice: ENTRY, market: "stock", strategy: "MOMENTUM" };
  }

  /** Fire fills through the private scheduler with a tiny fuse, then wait
   *  for the debounced pass (timer + serialized queue) to drain. */
  async function drainStopOnFill(m: any, fills: any[], debounceMs = 5) {
    m.stopOnFillDebounceMs = debounceMs;
    for (const f of fills) m.scheduleStopOnFillPass(f);
    await sleep(debounceMs + 25);
    await m.nativeStopsPass.catch(() => {});
    await sleep(0);
  }

  test("flag + wiring: ALPACA_STOP_ON_FILL is ON, the ORDER_FILLED listener schedules the pass, and completion logs the fill→stop latency", () => {
    expect(ALPACA_STOP_ON_FILL).toBe(true);
    const src = readFileSync(join(import.meta.dir, "AccountManager.ts"), "utf-8");
    // The listener block registered in start() must call the scheduler.
    const listener = src.slice(src.indexOf("EVENTS.ORDER_FILLED, (o: any)"), src.indexOf("EVENTS.POSITION_CLOSED"));
    expect(listener).toContain("this.scheduleStopOnFillPass(o)");
    // Latency telemetry: fill→stop wall time is logged on pass completion.
    expect(src).toContain("stop-on-fill: native-stop pass completed");
  });

  test("an Alpaca stock ENTRY fill triggers ONE pass that arms the just-persisted row's stop (fill→stop without waiting for the 60s cycle)", async () => {
    const tradeId = seedTrade("momentum_stocks"); // row persisted BEFORE the event — the adapter's emit order
    let passes = 0;
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => { passes++; return [brokerStock("AAPL", 76)]; },
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true, orderId: "stop-1" }; },
    });

    await drainStopOnFill(m, [stockFill("momentum_stocks")]);

    expect(passes).toBe(1);
    expect(placed).toHaveLength(1);
    expect(placed[0].tradeId).toBe(tradeId);
    expect((m as any).stopOnFillTimer).toBeNull(); // fuse burned, nothing pending
  });

  test("N fills in the same engine pass (both stock sleeves — meanrev uses the same adapter) debounce into ONE pass covering every row", async () => {
    seedTrade("momentum_stocks", { symbol: "AAPL" });
    seedTrade("meanrev_stocks", { symbol: "QCOM" });
    let passes = 0;
    const placed: any[] = [];
    const m = manager({
      getPositions: async () => { passes++; return [brokerStock("AAPL", 76), brokerStock("QCOM", 76)]; },
      placeStopLossOrder: async (p: any) => { placed.push(p); return { ok: true, orderId: `stop-${placed.length}` }; },
    });

    await drainStopOnFill(m, [
      stockFill("momentum_stocks", "AAPL"),
      stockFill("meanrev_stocks", "QCOM"),
      stockFill("momentum_stocks", "AAPL"), // duplicate event — still one pass
    ]);

    expect(passes).toBe(1);
    expect(placed.map((p: any) => `${p.accountId}:${p.symbol}`).sort()).toEqual([
      "meanrev_stocks:QCOM",
      "momentum_stocks:AAPL",
    ]);
  });

  test("crypto fills and non-sleeve accounts schedule NOTHING (Binance stops are installed inline pre-persist)", async () => {
    let passes = 0;
    const m = manager({
      getPositions: async () => { passes++; return []; },
    });

    await drainStopOnFill(m, [
      { accountId: "momentum_crypto", symbol: "BTC/USD", side: "buy", quantity: 1, filledPrice: 50_000, market: "crypto", strategy: "MOMENTUM" },
      { accountId: "momentum_crypto_usdc", symbol: "ETH/USD", side: "buy", quantity: 1, filledPrice: 3_000, market: "crypto", strategy: "MOMENTUM" },
      { accountId: "alpaca_main", symbol: "AAPL", side: "buy", quantity: 1, filledPrice: 100, market: "stock", strategy: "MANUAL" },
      { accountId: "momentum_stocks", symbol: "AAPL" /* market missing → not a stock entry */ },
    ]);

    expect(passes).toBe(0);
    expect((m as any).stopOnFillTimer).toBeNull();
  });

  test("closes and shadow fills cannot trigger by construction: adapters emit ORDER_FILLED only on the open path AFTER persistence; ShadowAdapter never emits it", () => {
    const adapterSrc = readFileSync(join(import.meta.dir, "..", "strategies", "momentum", "AlpacaMomentumAdapter.ts"), "utf-8");
    // Exactly ONE emit, on the entry path, and only after the trades row
    // persisted (persistFillOrReconcile precedes it) — the event is the
    // "row exists" signal the scheduled pass relies on.
    expect(adapterSrc.split("EVENTS.ORDER_FILLED").length - 1).toBe(1);
    expect(adapterSrc.indexOf("persistFillOrReconcile(order.id")).toBeGreaterThan(0);
    expect(adapterSrc.indexOf("persistFillOrReconcile(order.id")).toBeLessThan(adapterSrc.indexOf("EVENTS.ORDER_FILLED"));
    // Close path notifies via POSITION_CLOSED, never ORDER_FILLED.
    expect(adapterSrc).toContain("EVENTS.POSITION_CLOSED");
    // Shadow books place no real orders and must never wake the reconciler.
    const shadowSrc = readFileSync(join(import.meta.dir, "..", "governor", "ShadowAdapter.ts"), "utf-8");
    expect(shadowSrc).not.toContain("ORDER_FILLED");
  });

  test("a fill landing while the 60s timer pass runs QUEUES its pass behind it — serialized, never a duplicate stop", async () => {
    seedTrade("momentum_stocks");
    const placed: any[] = [];
    const liveStops: any[] = [];
    const m = manager({
      getPositions: async () => [brokerStock("AAPL", 76)],
      getOpenStopOrders: async () => [...liveStops],
      // Burned deterministic id + await hole — the exact interleaving shape
      // of the reentrancy suite above; an UNserialized second pass reads its
      // own (still empty) stop book during this window and double-places.
      getOrderStateByClientId: async () => {
        await new Promise(r => setTimeout(r, 15));
        return { status: "canceled", filledQty: 0, filledAvgPrice: 0, replacedBy: null };
      },
      placeStopLossOrder: async (p: any) => {
        placed.push(p);
        liveStops.push({
          id: `stop-${placed.length}`, clientOrderId: stopLossClientOrderId(p.accountId, p.tradeId),
          symbol: p.symbol, side: "sell", qty: p.quantity, stopPrice: p.stopPrice, status: "new",
        });
        return { ok: true, orderId: `stop-${placed.length}` };
      },
    });

    (m as any).stopOnFillDebounceMs = 1;
    const timerPass = (m as any).ensureAlpacaNativeStops(); // the 60s sync pass, in flight…
    (m as any).scheduleStopOnFillPass(stockFill("momentum_stocks")); // …when the fill lands
    await timerPass;
    await new Promise(r => setTimeout(r, 40)); // let the debounced pass fire and drain
    await (m as any).nativeStopsPass;

    // The queued pass re-read the stop book, verified pass 1's stop, no-op'd.
    expect(placed).toHaveLength(1);
  });

  test("MODEL_CUTOVER same-tick close+re-buy (the 2026-09-28 first pass): old row closed with its stop cancel SETTLED, new row gets a fresh stop under its OWN deterministic id — old id untouched, no duplicate", async () => {
    // Old META row: closed by the cutover (close path canceled its GTC stop
    // and — E3, commit 5df5575 — settled the cancel before selling).
    const oldId = seedTrade("momentum_stocks", { id: "meta_old", symbol: "META", quantity: 5, entryPrice: 700 });
    closeTrade(oldId, 710, Date.now(), 0);
    updateTradeCloseReason(oldId, "MODEL_CUTOVER");
    // New META row: re-bought in the SAME tick at the current slot size.
    const newId = seedTrade("momentum_stocks", { id: "meta_new", symbol: "META", quantity: 3, entryPrice: 712 });

    const placed: any[] = [];
    const canceled: string[] = [];
    const liveStops: any[] = [];
    const stateQueries: string[] = [];
    const m = manager({
      getPositions: async () => [{ ...brokerStock("META", 3), avgEntryPrice: 712, currentPrice: 712 }],
      getOpenStopOrders: async () => [...liveStops], // old stop's cancel settled → NOT on the book
      cancelOrderById: async (id: string) => { canceled.push(id); return true; },
      getOrderStateByClientId: async (cid: string) => { stateQueries.push(cid); return null; }, // new id never placed yet
      placeStopLossOrder: async (p: any) => {
        placed.push(p);
        liveStops.push({
          id: "meta-stop-new", clientOrderId: stopLossClientOrderId(p.accountId, p.tradeId),
          symbol: p.symbol, side: "sell", qty: p.quantity, stopPrice: p.stopPrice, status: "new",
        });
        return { ok: true, orderId: "meta-stop-new" };
      },
    });

    // The re-buy's fill event triggers the stop-on-fill pass.
    await drainStopOnFill(m, [{ accountId: "momentum_stocks", symbol: "META", side: "buy", quantity: 3, filledPrice: 712, market: "stock", strategy: "MOMENTUM" }]);

    expect(placed).toHaveLength(1);
    expect(placed[0].tradeId).toBe(newId);         // NEW row's stop…
    expect(placed[0].quantity).toBe(3);            // …at the NEW size (not the old 5)
    expect(canceled).toEqual([]);                  // the settled old stop is never touched
    // Only the NEW row's deterministic id is ever resolved — the closed row
    // is out of scope for the pass entirely.
    for (const cid of stateQueries) expect(cid).toBe(stopLossClientOrderId("momentum_stocks", newId));

    // Idempotency: the 60s backstop pass right after verifies and no-ops.
    await (m as any).ensureAlpacaNativeStops();
    expect(placed).toHaveLength(1);
    expect(canceled).toEqual([]);
  });
});
