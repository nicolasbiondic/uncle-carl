// P&L breakdown (2026-09-29): the period P&L is the change in value; closing a
// position turns an open gain into a realized one without adding money. The
// fixtures are the prod shapes of the week that raised the question: META
// (in 09-04 @607.52, 736.60 at the 7D boundary, out 09-28 for +$4,767.74) and
// UNI/USDC (in 08-29 @4.421, 10.718 at the boundary, out 09-29 for +$1,649.46).
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getDB, getTradingStats } from "../db/database";
import { makeTestDb } from "../test-support/db";
import {
  computePnlBreakdown, computeRealizedAttribution, priceAt, windowStartFor, type BreakdownPosition,
} from "./pnlBreakdown";

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 8, 29, 15, 45); // Tue 2026-09-29 11:45 ET
const S7 = Date.UTC(2026, 8, 23, 4, 0);    // 7D boundary: Wed 09-23 00:00 ET

let hist: Database;

function bar(source: string, timeframe: string, symbol: string, t: number, close: number) {
  hist.prepare(
    `INSERT INTO historical_bars (symbol, timeframe, timestamp, open, high, low, close, volume, source) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(symbol, timeframe, t, close, close, close, close, 1, source);
}

function trade(o: { id: string; account: string; symbol: string; market?: string; side?: string; qty: number; entry: number; entryTime: number; exit?: number; exitTime?: number; pnl?: number; openCommission?: number; closeReason?: string }) {
  const closed = o.exitTime != null;
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, exit_price, quantity, pnl, entry_time, exit_time, status, account_id, profile_id, open_commission, close_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.id, o.symbol, o.market ?? (o.symbol.includes("/") ? "crypto" : "stock"), o.side ?? "buy", "MOMENTUM",
    o.entry, o.exit ?? null, o.qty, o.pnl ?? null, o.entryTime, o.exitTime ?? null, closed ? "closed" : "open",
    o.account, o.account, o.openCommission ?? 0, o.closeReason ?? null,
  );
}

beforeEach(() => {
  makeTestDb();
  hist = new Database(":memory:");
  hist.exec(`CREATE TABLE historical_bars (symbol TEXT NOT NULL, timeframe TEXT NOT NULL, timestamp INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY (symbol, timeframe, timestamp))`);
  // Stocks: daily bars stamped 00:00 ET of their session. The 09-23 bar sits
  // exactly on the boundary and must NOT be the start price.
  bar("alpaca_wide", "1d", "META", Date.UTC(2026, 8, 22, 4), 736.6);
  bar("alpaca_wide", "1d", "META", Date.UTC(2026, 8, 23, 4), 744.1);
  // Crypto: 1h bars stamped at their open; the 03:00 bar closes at the boundary.
  bar("binance_futures", "1h", "UNI/USD", S7 - H, 10.718);
  bar("binance_futures", "1h", "UNI/USD", S7, 10.9);
  bar("binance_futures", "1h", "LINK/USD", S7 - H, 13.153);
});

describe("window boundary", () => {
  test("7D = the ET day start six days back (the same rule getTradingStats and the equity delta use); 0 = all-time", () => {
    expect(windowStartFor(7, NOW)).toBe(S7);
    expect(windowStartFor(1, NOW)).toBe(Date.UTC(2026, 8, 29, 4));
    expect(windowStartFor(0, NOW)).toBe(0);
  });
});

describe("priceAt", () => {
  test("stock: the last session close before the boundary; crypto: the 1h close at the boundary via the BASE/USD proxy", () => {
    expect(priceAt(hist, "META", "stock", S7)).toBe(736.6);
    expect(priceAt(hist, "UNI/USDC", "crypto", S7)).toBe(10.718);
  });

  test("missing or stale bars are null, never guessed", () => {
    expect(priceAt(hist, "AAPL", "stock", S7)).toBeNull();
    expect(priceAt(hist, "META", "stock", S7 + 8 * D)).toBeNull(); // last bar 9 days old
    expect(priceAt(hist, "UNI/USDC", "crypto", S7 + 5 * H)).toBeNull(); // last bar 4h old
    expect(priceAt(null, "META", "stock", S7)).toBeNull();
  });
});

describe("realized attribution — what was cashed vs what was earned before the window", () => {
  function seedWeek() {
    trade({ id: "meta", account: "momentum_stocks", symbol: "META", qty: 40, entry: 607.516501, entryTime: Date.UTC(2026, 8, 4, 13, 48), exit: 726.71, exitTime: Date.UTC(2026, 8, 28, 13, 35), pnl: 4767.74, closeReason: "MODEL_CUTOVER" });
    trade({ id: "uni", account: "momentum_crypto_usdc", symbol: "UNI/USDC", qty: 377, entry: 4.421, entryTime: Date.UTC(2026, 7, 29, 1, 16), exit: 8.8015, exitTime: Date.UTC(2026, 8, 29, 0, 0), pnl: 1649.46, openCommission: 1.99, closeReason: "MODEL_CUTOVER" });
    trade({ id: "bch", account: "momentum_crypto_usdc", symbol: "BCH/USDC", qty: 7.618, entry: 337.17, entryTime: Date.UTC(2026, 8, 26, 18), exit: 324.31, exitTime: Date.UTC(2026, 8, 28, 2, 47), pnl: -98.82, closeReason: "BROKER_STOP_LOSS" });
    // Excluded: a reconcile close in the window, and a close before it.
    trade({ id: "recon", account: "momentum_crypto", symbol: "LINK/USD", qty: 10, entry: 9, entryTime: Date.UTC(2026, 8, 20), exit: 10, exitTime: Date.UTC(2026, 8, 25), pnl: 26, closeReason: "MANUAL_CLOSE_UNRECONCILED" });
    trade({ id: "old", account: "meanrev_stocks", symbol: "KO", qty: 50, entry: 80, entryTime: Date.UTC(2026, 8, 10), exit: 82, exitTime: Date.UTC(2026, 8, 20), pnl: 100, closeReason: "MEANREV_EXIT" });
  }

  test("META and UNI/USDC: realized in full, but most of it was already earned at the boundary", () => {
    seedWeek();
    const ra = computeRealizedAttribution(getDB(), hist, S7);
    expect(ra.count).toBe(3);
    expect(ra.realized).toBeCloseTo(4767.74 + 1649.46 - 98.82, 6);
    const meta = ra.closes.find(c => c.symbol === "META")!;
    expect(meta.earnedBefore).toBeCloseTo((736.6 - 607.516501) * 40, 6); // +$5,163.34 by 09-23
    expect(meta.inWindow).toBeCloseTo(4767.74 - (736.6 - 607.516501) * 40, 6); // −$395.60 in the window
    const uni = ra.closes.find(c => c.symbol === "UNI/USDC")!;
    expect(uni.earnedBefore).toBeCloseTo((10.718 - 4.421) * 377 - 1.99, 6); // net of the entry fee paid before the window
    expect(ra.closes.find(c => c.symbol === "BCH/USDC")!.earnedBefore).toBe(0); // entered inside the window
    expect(ra.earnedBefore).toBeCloseTo(meta.earnedBefore! + uni.earnedBefore!, 6);
  });

  test("a close that can't be marked at the boundary nulls the total (fail closed), the row stays listed", () => {
    seedWeek();
    trade({ id: "aapl", account: "momentum_stocks", symbol: "AAPL", qty: 75, entry: 332, entryTime: Date.UTC(2026, 8, 11), exit: 341.56, exitTime: Date.UTC(2026, 8, 28, 13, 35), pnl: 715.16 });
    const ra = computeRealizedAttribution(getDB(), hist, S7);
    expect(ra.earnedBefore).toBeNull();
    expect(ra.closes.find(c => c.symbol === "AAPL")).toMatchObject({ realized: 715.16, earnedBefore: null, inWindow: null });
  });

  test("COIN-M contracts are not linear in price: a pre-window momentum_btc close nulls the total", () => {
    trade({ id: "btc", account: "momentum_btc", symbol: "BTC/USD", qty: 3, entry: 60_000, entryTime: Date.UTC(2026, 8, 1), exit: 62_000, exitTime: Date.UTC(2026, 8, 25), pnl: 10 });
    bar("binance_futures", "1h", "BTC/USD", S7 - H, 61_000);
    expect(computeRealizedAttribution(getDB(), hist, S7).earnedBefore).toBeNull();
  });

  test("realized is exactly getTradingStats' periodPnl — the figure the KPI sub-line shows", () => {
    const now = Date.now();
    trade({ id: "r1", account: "meanrev_stocks", symbol: "KO", qty: 50, entry: 80, entryTime: now - 2 * D, exit: 81, exitTime: now - D, pnl: 50 });
    trade({ id: "r2", account: "momentum_crypto", symbol: "LINK/USD", qty: 10, entry: 9, entryTime: now - 3 * D, exit: 8, exitTime: now - 2 * D, pnl: -10 });
    trade({ id: "r3", account: "momentum_crypto", symbol: "ADA/USD", qty: 10, entry: 1, entryTime: now - 3 * D, exit: 2, exitTime: now - 2 * D, pnl: 9, closeReason: "SYNC_DETECTED" });
    const ra = computeRealizedAttribution(getDB(), hist, windowStartFor(7));
    const stats = getTradingStats(undefined, 7);
    expect(ra.realized).toBeCloseTo(stats.periodPnl, 9);
    expect(ra.count).toBe(stats.periodClosedTrades);
  });
});

describe("computePnlBreakdown — the bridge adds up to the P&L", () => {
  const open = (o: Partial<BreakdownPosition> & Pick<BreakdownPosition, "accountId" | "symbol" | "quantity" | "entryPrice" | "entryTime" | "currentPrice">): BreakdownPosition =>
    ({ market: o.symbol.includes("/") ? "crypto" : "stock", side: "buy", ...o });

  test("open positions move from the boundary price if they predate the window, from entry otherwise; `other` closes the bridge", () => {
    trade({ id: "meta", account: "momentum_stocks", symbol: "META", qty: 40, entry: 607.516501, entryTime: Date.UTC(2026, 8, 4), exit: 726.71, exitTime: Date.UTC(2026, 8, 28, 13, 35), pnl: 4767.74 });
    const positions = [
      open({ accountId: "momentum_stocks", symbol: "SMH", quantity: 11, entryPrice: 603.68, entryTime: Date.UTC(2026, 8, 28, 13, 36), currentPrice: 607.89 }),
      open({ accountId: "momentum_crypto", symbol: "LINK/USD", quantity: 50, entryPrice: 13, entryTime: Date.UTC(2026, 8, 20), currentPrice: 14 }),
    ];
    const b = computePnlBreakdown({ db: getDB(), hist, periodDays: 7, pnl: -1877.72, openPositions: positions, now: NOW });
    const expectedOpen = (607.89 - 603.68) * 11 + (14 - 13.153) * 50;
    expect(b.windowStart).toBe(S7);
    expect(b.openChange).toBeCloseTo(expectedOpen, 6);
    expect(b.closedInWindow).toBeCloseTo(4767.74 - (736.6 - 607.516501) * 40, 6);
    expect(b.other).toBeCloseTo(-1877.72 - b.closedInWindow! - expectedOpen, 6);
    expect(b.closedInWindow! + b.openChange! + b.other!).toBeCloseTo(-1877.72, 6);
  });

  test("a short moves the other way", () => {
    const b = computePnlBreakdown({
      db: getDB(), hist, periodDays: 7, pnl: 0, now: NOW,
      openPositions: [open({ accountId: "momentum_crypto", symbol: "SOL/USD", side: "sell", quantity: 2, entryPrice: 120, entryTime: NOW - H, currentPrice: 110 })],
    });
    expect(b.openChange).toBeCloseTo(20, 6);
  });

  test("an open position that can't be priced at the boundary nulls openChange and other", () => {
    const b = computePnlBreakdown({
      db: getDB(), hist, periodDays: 7, pnl: -100, now: NOW,
      openPositions: [open({ accountId: "momentum_stocks", symbol: "NVDA", quantity: 29, entryPrice: 225, entryTime: Date.UTC(2026, 8, 20), currentPrice: 230 })],
    });
    expect(b.openChange).toBeNull();
    expect(b.other).toBeNull();
    expect(b.closedInWindow).toBe(0);
  });

  test("all-time: nothing was earned before the window; open positions count their whole unrealized P&L", () => {
    trade({ id: "meta", account: "momentum_stocks", symbol: "META", qty: 40, entry: 607.516501, entryTime: Date.UTC(2026, 8, 4), exit: 726.71, exitTime: Date.UTC(2026, 8, 28, 13, 35), pnl: 4767.74 });
    const b = computePnlBreakdown({
      db: getDB(), hist, periodDays: 0, pnl: 5000, now: NOW,
      openPositions: [open({ accountId: "momentum_crypto", symbol: "LINK/USD", quantity: 50, entryPrice: 13, entryTime: Date.UTC(2026, 8, 20), currentPrice: 14 })],
    });
    expect(b.earnedBefore).toBe(0);
    expect(b.closedInWindow).toBeCloseTo(4767.74, 6);
    expect(b.openChange).toBeCloseTo(50, 6);
    expect(b.other).toBeCloseTo(5000 - 4767.74 - 50, 6);
  });

  test("a missing P&L (a broker leg unavailable) leaves the parts computed and `other` null", () => {
    const b = computePnlBreakdown({ db: getDB(), hist, periodDays: 7, pnl: null, openPositions: [], now: NOW });
    expect(b.openChange).toBe(0);
    expect(b.other).toBeNull();
  });
});
