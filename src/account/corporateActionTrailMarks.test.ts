// Corporate actions × trail watermarks + late-detection cutoff (OPEN.md P2
// pair, 2026-08-29).
//
//  A) MomentumEngine.scaleMarksForSplit: a past forward split must divide the
//     symbol's trail watermark by the ratio (peak $1,200 across a 10:1 split
//     → $120) and persist it, or the first post-split tick reads a −90%
//     collapse and fires a spurious TRAIL_STOP on the whole winner.
//  B) AccountManager.applyCorporateAction (phase past) emits
//     EVENTS.CORPORATE_ACTION_APPLIED after applying the split to DB rows —
//     the bus is the only bridge to the engines (AccountManager doesn't know
//     them; index.ts subscribes the tsmTrail sleeve).
//  C) applySplitToOpenStockTrades entry_time cutoff: a row ENTERED on/after
//     the ex-date already carries post-split basis and must NOT be rescaled
//     when the feed reports the event late (lookback 5d).

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDB, getETDateKey, getETDayBounds, insertTrade, applySplitToOpenStockTrades } from "../db/database";
import { MomentumEngine, type MomentumPersistedState, type MomentumStatePersistence } from "../strategies/momentum/MomentumEngine";
import { INITIAL_RISK_STATE } from "../strategies/momentum/RiskGuard";
import { EVENTS } from "../utils/events";
import { makeTestDb } from "../test-support/db";
import { makeAccountManager } from "../test-support/account";
import { captureEvent } from "../test-support/events";

// ── Shared harnesses ───────────────────────────────────────────────────────

function collectingLogger() {
  const errors: string[] = [];
  const infos: string[] = [];
  return {
    logger: {
      info: (m: string) => { infos.push(m); },
      warn: (_m: string) => {},
      error: (m: string) => { errors.push(m); },
    },
    errors, infos,
  };
}

/** In-memory MomentumStatePersistence (same fidelity as the real file store)
 *  + save counter so "did NOT persist" is assertable. */
function memoryPersistence(initial: MomentumPersistedState | null = null) {
  let stored: MomentumPersistedState | null = initial;
  let saves = 0;
  const persistence: MomentumStatePersistence = {
    load: () => stored,
    save: (s) => { saves++; stored = JSON.parse(JSON.stringify(s)); },
  };
  return { persistence, get: () => stored, saveCount: () => saves };
}

function engineWithMarks(marks: Record<string, { mark: number; lastTs: number }>) {
  const store = memoryPersistence({ v: 1, risk: { ...INITIAL_RISK_STATE }, trailMarks: marks });
  const logs = collectingLogger();
  // Broker never consulted: constructor only loads state; scaleMarksForSplit
  // touches marks + persistence only.
  const engine = new MomentumEngine(
    { universe: ["NVDA", "AAPL"], tsmTrail: { kSigma: 3, lookbackBars: 78, minPct: 2, maxPct: 8 } },
    {} as any,
    logs.logger,
    store.persistence,
  );
  return { engine, store, logs };
}

function seedStockRow(id: string, accountId: string, over: Record<string, any> = {}): void {
  insertTrade({
    id, symbol: "AAPL", market: "stock", side: "buy", strategy: "MOMENTUM_TSM",
    entryPrice: 100, quantity: 10, entryTime: Date.now() - 60_000, status: "open",
    ...over,
  } as any, accountId);
}

function row(id: string): { quantity: number; entry_price: number; stop_loss: number | null } {
  return getDB().prepare(`SELECT quantity, entry_price, stop_loss FROM trades WHERE id = ?`).get(id) as any;
}

/** AccountManager with the inert Alpaca surface applyCorporateAction touches
 *  (candle-cache invalidation + the forced native-stop re-verification). */
function manager() {
  return makeAccountManager({
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
    },
  });
}

beforeAll(() => { makeTestDb(); });
beforeEach(() => {
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM corporate_actions;");
});

// ── A) MomentumEngine.scaleMarksForSplit ──────────────────────────────────

describe("MomentumEngine.scaleMarksForSplit", () => {
  test("forward 10:1 split divides the symbol's watermark (1200 → 120), persists it, and leaves other symbols alone", () => {
    const now = Date.now();
    const { engine, store } = engineWithMarks({
      "NVDA|buy": { mark: 1200, lastTs: now - 60_000 },
      "NVDA|sell": { mark: 900, lastTs: now - 60_000 },   // both sides of the key scheme scale
      "AAPL|buy": { mark: 250, lastTs: now - 60_000 },    // different symbol — untouched
    });

    engine.scaleMarksForSplit("NVDA", 10);

    const persisted = store.get()!.trailMarks!;
    expect(persisted["NVDA|buy"].mark).toBeCloseTo(120, 10);
    expect(persisted["NVDA|sell"].mark).toBeCloseTo(90, 10);
    expect(persisted["AAPL|buy"].mark).toBeCloseTo(250, 10);
    expect(store.saveCount()).toBe(1);
  });

  test("reverse split (ratio 0.1) raises the watermark — price axis ÷ratio, same convention as the DB rows", () => {
    const { engine, store } = engineWithMarks({ "NVDA|buy": { mark: 12, lastTs: Date.now() - 60_000 } });
    engine.scaleMarksForSplit("NVDA", 0.1);
    expect(store.get()!.trailMarks!["NVDA|buy"].mark).toBeCloseTo(120, 10);
  });

  test("invalid ratio (0, NaN, negative, Infinity) → no-op + error log, nothing persisted", () => {
    const { engine, store, logs } = engineWithMarks({ "NVDA|buy": { mark: 1200, lastTs: Date.now() - 60_000 } });
    for (const bad of [0, NaN, -2, Infinity]) engine.scaleMarksForSplit("NVDA", bad);
    expect(logs.errors.length).toBe(4);
    expect(logs.errors[0]).toContain("invalid split ratio");
    expect(store.saveCount()).toBe(0);
    expect(store.get()!.trailMarks!["NVDA|buy"].mark).toBe(1200); // untouched
  });

  test("no mark for the symbol → silent no-op (no error, no persist)", () => {
    const { engine, store, logs } = engineWithMarks({ "AAPL|buy": { mark: 250, lastTs: Date.now() - 60_000 } });
    engine.scaleMarksForSplit("NVDA", 10);
    expect(logs.errors).toHaveLength(0);
    expect(store.saveCount()).toBe(0);
  });
});

// ── B) applyCorporateAction emits CORPORATE_ACTION_APPLIED ───────────────

describe("applyCorporateAction → EVENTS.CORPORATE_ACTION_APPLIED", () => {
  test("past forward split emits {symbol, ratio} exactly once after the rows are adjusted", async () => {
    const exDate = getETDateKey(Date.now() - 86_400_000); // yesterday → phase past
    seedStockRow("ca_pre", "momentum_stocks", { entryTime: Date.now() - 3 * 86_400_000 });
    const cap = captureEvent(EVENTS.CORPORATE_ACTION_APPLIED);
    try {
      await manager().applyCorporateAction(
        { symbol: "AAPL", type: "forward_split", exDate, ratio: 10, raw: {} },
        "past",
      );
    } finally { cap.detach(); }
    expect(cap.events).toEqual([{ symbol: "AAPL", ratio: 10 }]);
    expect(row("ca_pre").quantity).toBeCloseTo(100, 10); // and the rows really were adjusted first
    expect(row("ca_pre").entry_price).toBeCloseTo(10, 10);
  });

  test("upcoming phase (alert only) emits nothing", async () => {
    seedStockRow("ca_up", "momentum_stocks");
    const cap = captureEvent(EVENTS.CORPORATE_ACTION_APPLIED);
    try {
      await manager().applyCorporateAction(
        { symbol: "AAPL", type: "forward_split", exDate: getETDateKey(Date.now() + 2 * 86_400_000), ratio: 10, raw: {} },
        "upcoming",
      );
    } finally { cap.detach(); }
    expect(cap.events).toHaveLength(0);
  });

  test("already-applied event (ledger gate) does not re-emit — marks must never scale twice", async () => {
    const exDate = getETDateKey(Date.now() - 86_400_000);
    seedStockRow("ca_once", "momentum_stocks", { entryTime: Date.now() - 3 * 86_400_000 });
    const ev = { symbol: "AAPL", type: "forward_split" as const, exDate, ratio: 10, raw: {} };
    const m = manager();
    await m.applyCorporateAction(ev, "past"); // applies + marks ledger
    const cap = captureEvent(EVENTS.CORPORATE_ACTION_APPLIED);
    try {
      await m.applyCorporateAction(ev, "past"); // re-seen (lookback 5d re-detection)
    } finally { cap.detach(); }
    expect(cap.events).toHaveLength(0);
    expect(row("ca_once").quantity).toBeCloseTo(100, 10); // still ×10 once, not ×100
  });
});

// ── C) entry_time cutoff on late-detected splits ──────────────────────────

describe("applySplitToOpenStockTrades entry_time cutoff (late split detection)", () => {
  test("DB level: only rows entered before the cutoff are rescaled; omitting the cutoff keeps the old adjust-everything behavior", () => {
    const cutoff = Date.now();
    seedStockRow("db_pre", "momentum_stocks", { symbol: "NVDA", entryTime: cutoff - 86_400_000, stopLoss: 96 });
    seedStockRow("db_post", "momentum_stocks", { symbol: "NVDA", entryTime: cutoff + 60_000, stopLoss: 9.6 });

    expect(applySplitToOpenStockTrades("NVDA", 10, cutoff)).toBe(1);
    expect(row("db_pre").entry_price).toBeCloseTo(10, 10);
    expect(row("db_pre").quantity).toBeCloseTo(100, 10);
    expect(row("db_pre").stop_loss!).toBeCloseTo(9.6, 10);
    expect(row("db_post").entry_price).toBeCloseTo(100, 10); // post-split entry: intact
    expect(row("db_post").quantity).toBeCloseTo(10, 10);
    expect(row("db_post").stop_loss!).toBeCloseTo(9.6, 10);

    // No cutoff → legacy behavior: everything open on the symbol adjusts.
    expect(applySplitToOpenStockTrades("NVDA", 2)).toBe(2);
  });

  test("handler level: a row entered ON the ex-date (post-split basis) survives the late-detected event untouched", async () => {
    const exDate = getETDateKey(); // today, phase past (exDate <= today)
    const [exDayStart] = getETDayBounds(exDate);
    seedStockRow("h_pre", "momentum_stocks", { entryTime: exDayStart - 86_400_000, stopLoss: 96 });
    seedStockRow("h_post", "meanrev_stocks", { entryTime: Date.now() }); // entered after the split, basis already correct

    await manager().applyCorporateAction(
      { symbol: "AAPL", type: "forward_split", exDate, ratio: 10, raw: {} },
      "past",
    );

    expect(row("h_pre").entry_price).toBeCloseTo(10, 10);
    expect(row("h_pre").quantity).toBeCloseTo(100, 10);
    expect(row("h_pre").stop_loss!).toBeCloseTo(9.6, 10);
    expect(row("h_post").entry_price).toBeCloseTo(100, 10); // NOT corrupted by the late event
    expect(row("h_post").quantity).toBeCloseTo(10, 10);
  });

  test("handler level: unusable exDate falls back to adjusting ALL open rows (better than skipping the adjustment)", async () => {
    seedStockRow("h_all_1", "momentum_stocks", { entryTime: Date.now() - 3 * 86_400_000 });
    seedStockRow("h_all_2", "momentum_stocks", { id: "h_all_2", entryTime: Date.now() });

    await manager().applyCorporateAction(
      // phase forced by caller; the malformed exDate exercises the fallback
      { symbol: "AAPL", type: "forward_split", exDate: "not-a-date", ratio: 10, raw: {} },
      "past",
    );

    expect(row("h_all_1").entry_price).toBeCloseTo(10, 10);
    expect(row("h_all_2").entry_price).toBeCloseTo(10, 10);
  });
});
