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
import { savePnlWindowMarks } from "../db/database";

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

function trade(o: { id: string; account: string; symbol: string; market?: string; side?: string; qty: number; entry: number; entryTime: number; exit?: number; exitTime?: number; pnl?: number; openCommission?: number; closeReason?: string; partialRealized?: number; partialClosed?: number; partialCommission?: number }) {
  const closed = o.exitTime != null;
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, exit_price, quantity, pnl, entry_time, exit_time, status, account_id, profile_id, open_commission, close_reason,
                         partial_realized_native, partial_closed_contracts, partial_commission_native)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.id, o.symbol, o.market ?? (o.symbol.includes("/") ? "crypto" : "stock"), o.side ?? "buy", "MOMENTUM",
    o.entry, o.exit ?? null, o.qty, o.pnl ?? null, o.entryTime, o.exitTime ?? null, closed ? "closed" : "open",
    o.account, o.account, o.openCommission ?? 0, o.closeReason ?? null,
    o.partialRealized ?? 0, o.partialClosed ?? 0, o.partialCommission ?? 0,
  );
}

/** One portfolio-engine journal row: the pre-trade book and the applied orders
 *  (the shape PortfolioEngine persists — src/portfolio-engine/live/persistence.ts). */
function journal(account: string, decidedAt: number, book: Array<{ symbol: string; qty: number; avgEntryPrice: number }>,
  orders: Array<{ side: "buy" | "sell"; symbol: string; qty: number; price: number; filledAt?: number | null; maxHold?: "close" | "rebuy" }>) {
  getDB().prepare(
    `INSERT INTO portfolio_decisions (account_id, strategy_version, session, as_of, mode, status, equity, book_json, weights_json, stops_json, memory_json, diagnostics_json, orders_json, note, decided_at, updated_at)
     VALUES (?, 'v', ?, ?, 'live', 'submitted', 50000, ?, '{}', '[]', '{}', '{}', ?, NULL, ?, ?)`,
  ).run(account, `s${decidedAt}`, `s${decidedAt}`, JSON.stringify(book), JSON.stringify(orders.map(o => ({
    intent: { side: o.side, symbol: o.symbol, qty: o.qty, notional: o.qty * o.price, ...(o.maxHold ? { maxHold: o.maxHold } : {}) },
    clientOrderId: `c-${o.symbol}-${o.side}`, applied: true,
    result: { ok: true, filledQty: o.qty, avgPrice: o.price, status: "filled" },
    ...(o.filledAt === null ? {} : { filledAt: o.filledAt ?? decidedAt + 90_000 }),
  }))), decidedAt, decidedAt + 120_000);
}

function fill(tradeId: string, account: string, symbol: string, side: string, px: number, qty: number, at: number) {
  getDB().prepare(
    `INSERT INTO fills (trade_id, order_id, account_id, symbol, side, market, expected_px, submitted_px, filled_px, filled_qty, slippage_bps, fill_time, latency_ms, broker)
     VALUES (?, ?, ?, ?, ?, 'crypto', ?, ?, ?, ?, 0, ?, 0, 'binance')`,
  ).run(tradeId, `o-${tradeId}-${at}`, account, symbol, side, px, px, px, qty, at);
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
    expect(ra.closesCount).toBe(3);
    expect(ra.trimsCount).toBe(0);
    expect(ra.startPrices).toBe("bars");
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
    expect(b.holding).toBeCloseTo(-1877.72 - b.closedInWindow! - expectedOpen, 6);
    expect(b.closedInWindow! + b.openChange! + b.holding!).toBeCloseTo(-1877.72, 6);
    expect(b.positions).toBeCloseTo(-1877.72 - b.closedInWindow!, 6);
    expect(b.closedInWindow! + b.positions!).toBe(-1877.72); // exactly, by construction
  });

  test("a short moves the other way", () => {
    const b = computePnlBreakdown({
      db: getDB(), hist, periodDays: 7, pnl: 0, now: NOW,
      openPositions: [open({ accountId: "momentum_crypto", symbol: "SOL/USD", side: "sell", quantity: 2, entryPrice: 120, entryTime: NOW - H, currentPrice: 110 })],
    });
    expect(b.openChange).toBeCloseTo(20, 6);
  });

  test("an open position that can't be priced at the boundary nulls openChange and holding, never positions", () => {
    const b = computePnlBreakdown({
      db: getDB(), hist, periodDays: 7, pnl: -100, now: NOW,
      openPositions: [open({ accountId: "momentum_stocks", symbol: "NVDA", quantity: 29, entryPrice: 225, entryTime: Date.UTC(2026, 8, 20), currentPrice: 230 })],
    });
    expect(b.openChange).toBeNull();
    expect(b.holding).toBeNull();
    expect(b.closedInWindow).toBe(0);
    expect(b.positions).toBe(-100);
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
    expect(b.holding).toBeCloseTo(5000 - 4767.74 - 50, 6);
  });

  test("a missing P&L (a broker leg unavailable) leaves the parts computed and holding/positions null", () => {
    const b = computePnlBreakdown({ db: getDB(), hist, periodDays: 7, pnl: null, openPositions: [], now: NOW });
    expect(b.openChange).toBe(0);
    expect(b.holding).toBeNull();
    expect(b.positions).toBeNull();
  });
});

// ── Every reducing leg inside the window, exactly once (2026-11-06) ────────
// Prod shapes of the day the owner flagged "+$367 · realized −$912": the
// 5-day rule closes and rebuys the stock lots in one pass, the portfolio
// engine resizes the rest, and the closed rows' pnl nets partial legs booked
// on earlier days.
describe("reducing legs — 5-day renewals, resizes and earlier trims", () => {
  const T0 = Date.UTC(2026, 10, 6, 5);          // Fri 2026-11-06 00:00 ET — today's window
  const NOW6 = Date.UTC(2026, 10, 6, 21);       // 16:00 ET
  const PASS = Date.UTC(2026, 10, 6, 14, 35);   // the 09:35 ET decision
  const D4 = Date.UTC(2026, 10, 4, 14, 35);     // Wed 11-04 pass (before the window)
  const open = (o: Partial<BreakdownPosition> & Pick<BreakdownPosition, "accountId" | "symbol" | "quantity" | "entryPrice" | "entryTime" | "currentPrice">): BreakdownPosition =>
    ({ market: o.symbol.includes("/") ? "crypto" : "stock", side: "buy", ...o });

  function seedAapl() {
    // AAPL: 23.42 @327.04 in on 11-03; trimmed 5 sh @353.58 on 11-04 (+132.70,
    // on the row's partial ledger); MAX_HOLD close of the remaining 18.42 on
    // 11-06 @340.58; rebuy 10.97 @340.72 in the same pass.
    const aaplPnl = (340.58316 - 327.04) * 18.424119326 + 132.7; // the row's pnl nets the earlier leg (≈ +382.22)
    trade({ id: "aapl1", account: "momentum_stocks", symbol: "AAPL", qty: 18.424119326, entry: 327.04, entryTime: Date.UTC(2026, 10, 3, 14, 36), exit: 340.58316, exitTime: PASS + 90_000, pnl: aaplPnl, closeReason: "MAX_HOLD", partialRealized: 132.7, partialClosed: 5 });
    trade({ id: "aapl2", account: "momentum_stocks", symbol: "AAPL", qty: 10.97121672, entry: 340.72, entryTime: PASS + 180_000 });
    journal("momentum_stocks", D4, [{ symbol: "AAPL", qty: 23.424119326, avgEntryPrice: 327.04 }], [
      { side: "sell", symbol: "AAPL", qty: 5, price: 353.58 },
    ]);
    journal("momentum_stocks", PASS, [{ symbol: "AAPL", qty: 18.424119326, avgEntryPrice: 327.04 }], [
      { side: "sell", symbol: "AAPL", qty: 18.424119326, price: 340.58316, filledAt: PASS + 90_000, maxHold: "close" },
      { side: "buy", symbol: "AAPL", qty: 10.97121672, price: 340.72, filledAt: PASS + 180_000, maxHold: "rebuy" },
    ]);
  }

  test("5-day renewal: the close counts once, net of the trim booked before the window; the rebuy is a new lot measured from its fill", () => {
    seedAapl();
    savePnlWindowMarks(T0, T0 - 100_000, [{ market: "stock", symbol: "AAPL", price: 337.4 }]);
    const b = computePnlBreakdown({ db: getDB(), hist, periodDays: 1, pnl: 367, now: NOW6, openPositions: [
      open({ accountId: "momentum_stocks", symbol: "AAPL", quantity: 10.97121672, entryPrice: 340.72, entryTime: PASS + 180_000, currentPrice: 341.5 }),
    ] });
    expect(b.closesCount).toBe(1);
    expect(b.trimsCount).toBe(0); // the 11-04 trim is not this window's
    expect(b.realized).toBeCloseTo((340.58316 - 327.04) * 18.424119326, 6);
    expect(b.earnedBefore).toBeCloseTo((337.4 - 327.04) * 18.424119326, 6);
    expect(b.closedInWindow).toBeCloseTo((340.58316 - 337.4) * 18.424119326, 6);
    expect(b.openChange).toBeCloseTo((341.5 - 340.72) * 10.97121672, 6);
    expect(b.positions).toBeCloseTo(367 - b.closedInWindow!, 9);
    expect(b.closedInWindow! + b.positions!).toBe(367);
    expect(b.startPrices).toBe("marks");
    expect(b.closes.map(c => c.kind)).toEqual(["close"]);
  });

  test("resize legs: a trim inside the window is attributed from its lot's entry and taken out of the open position", () => {
    // SMH 6.26 @512.14 in on 11-04; trimmed 2.05 @468.36 today; 4.22 remain at 470.
    trade({ id: "smh", account: "momentum_stocks", symbol: "SMH", qty: 4.216213657, entry: 512.138741, entryTime: Date.UTC(2026, 10, 4, 14, 37), partialRealized: -89.57, partialClosed: 2.045963148 });
    journal("momentum_stocks", PASS, [{ symbol: "SMH", qty: 6.262176805, avgEntryPrice: 512.138741 }], [
      { side: "sell", symbol: "SMH", qty: 2.045963148, price: 468.36, filledAt: PASS + 100_000 },
    ]);
    savePnlWindowMarks(T0, T0 - 100_000, [{ market: "stock", symbol: "SMH", price: 475 }]);
    const b = computePnlBreakdown({ db: getDB(), hist, periodDays: 1, pnl: -40, now: NOW6, openPositions: [
      open({ accountId: "momentum_stocks", symbol: "SMH", quantity: 4.216213657, entryPrice: 512.138741, entryTime: Date.UTC(2026, 10, 4, 14, 37), currentPrice: 470 }),
    ] });
    expect(b.closesCount).toBe(0);
    expect(b.trimsCount).toBe(1);
    expect(b.realized).toBeCloseTo((468.36 - 512.138741) * 2.045963148, 6);
    expect(b.earnedBefore).toBeCloseTo((475 - 512.138741) * 2.045963148, 6);
    expect(b.closedInWindow).toBeCloseTo((468.36 - 475) * 2.045963148, 6);
    expect(b.openChange).toBeCloseTo((470 - 475) * 4.216213657, 6);
    expect(b.holding).toBeCloseTo(-40 - b.closedInWindow! - b.openChange!, 6);
    expect(b.closes[0]).toMatchObject({ kind: "trim", symbol: "SMH" });
  });

  test("a row trimmed before the window and closed inside it: the earlier trim stays in the earlier day", () => {
    // QQQ 13.07 @693.75 in on 11-02; trimmed 3.98 @675.31 on 11-04 (−73.33); closed today @659.25 (pnl −386.84 nets both).
    const trimPnl = (675.31 - 693.7470923531935) * 3.977623199;          // ≈ −73.33 on 11-04
    const qqqPnl = (659.248609 - 693.7470923531935) * 9.087522239 + trimPnl; // ≈ −386.84, nets both legs
    trade({ id: "qqq", account: "momentum_stocks", symbol: "QQQ", qty: 9.087522239, entry: 693.7470923531935, entryTime: Date.UTC(2026, 10, 2, 14, 39), exit: 659.248609, exitTime: PASS + 160_000, pnl: qqqPnl, closeReason: "MAX_HOLD", partialRealized: trimPnl, partialClosed: 3.977623199 });
    journal("momentum_stocks", D4, [{ symbol: "QQQ", qty: 13.065145438, avgEntryPrice: 693.7470923531935 }], [
      { side: "sell", symbol: "QQQ", qty: 3.977623199, price: 675.31 },
    ]);
    journal("momentum_stocks", PASS, [{ symbol: "QQQ", qty: 9.087522239, avgEntryPrice: 693.7470923531935 }], [
      { side: "sell", symbol: "QQQ", qty: 9.087522239, price: 659.248609, filledAt: PASS + 160_000, maxHold: "close" },
    ]);
    savePnlWindowMarks(T0, T0 - 100_000, [{ market: "stock", symbol: "QQQ", price: 662 }]);
    const b = computePnlBreakdown({ db: getDB(), hist, periodDays: 1, pnl: 0, now: NOW6, openPositions: [] });
    expect(b.closesCount).toBe(1);
    expect(b.trimsCount).toBe(0);
    expect(b.realized).toBeCloseTo(qqqPnl - trimPnl, 6);
    expect(b.closedInWindow).toBeCloseTo((659.248609 - 662) * 9.087522239, 6);
    // The 7D window holds both legs: the trim counts there, once.
    const w = computePnlBreakdown({ db: getDB(), hist, periodDays: 7, pnl: 0, now: NOW6, openPositions: [] });
    expect(w.closesCount).toBe(1);
    expect(w.trimsCount).toBe(1);
    expect(w.realized).toBeCloseTo(qqqPnl, 6); // close net of the trim + the trim = the row's pnl
  });

  test("a legacy journal (no fill time) still recognises the final close on the row's exit day — never counted twice", () => {
    trade({ id: "nvda", account: "momentum_stocks", symbol: "NVDA", qty: 10, entry: 190, entryTime: PASS - 2 * D, exit: 195, exitTime: PASS + 100_000, pnl: 50, closeReason: "MAX_HOLD" });
    journal("momentum_stocks", PASS, [{ symbol: "NVDA", qty: 10, avgEntryPrice: 190 }], [
      { side: "sell", symbol: "NVDA", qty: 10, price: 195, filledAt: null, maxHold: "close" },
    ]);
    savePnlWindowMarks(T0, T0 - 100_000, [{ market: "stock", symbol: "NVDA", price: 192 }]);
    const b = computePnlBreakdown({ db: getDB(), hist, periodDays: 1, pnl: 30, now: NOW6, openPositions: [] });
    expect(b.closesCount).toBe(1);
    expect(b.trimsCount).toBe(0);
    expect(b.realized).toBe(50);
    expect(b.closedInWindow).toBeCloseTo(30, 6);
  });

  test("marks present vs bars fallback: the marks win and are reported; a day without them says so", () => {
    trade({ id: "meta", account: "momentum_stocks", symbol: "META", qty: 40, entry: 607.516501, entryTime: Date.UTC(2026, 8, 4), exit: 726.71, exitTime: Date.UTC(2026, 8, 28, 13, 35), pnl: 4767.74 });
    const bars = computePnlBreakdown({ db: getDB(), hist, periodDays: 7, pnl: 0, openPositions: [], now: NOW });
    expect(bars.startPrices).toBe("bars");
    expect(bars.earnedBefore).toBeCloseTo((736.6 - 607.516501) * 40, 6);
    savePnlWindowMarks(S7, S7 - 95_000, [{ market: "stock", symbol: "META", price: 735.2 }]);
    const marks = computePnlBreakdown({ db: getDB(), hist, periodDays: 7, pnl: 0, openPositions: [], now: NOW });
    expect(marks.startPrices).toBe("marks");
    expect(marks.earnedBefore).toBeCloseTo((735.2 - 607.516501) * 40, 6);
    // A symbol the pass did not hold falls back to bars and the whole figure is labelled approximate.
    trade({ id: "uni", account: "momentum_crypto_usdc", symbol: "UNI/USDC", qty: 377, entry: 4.421, entryTime: Date.UTC(2026, 7, 29), exit: 8.8015, exitTime: Date.UTC(2026, 8, 29), pnl: 1649.46 });
    expect(computePnlBreakdown({ db: getDB(), hist, periodDays: 7, pnl: 0, openPositions: [], now: NOW }).startPrices).toBe("bars");
  });

  test("a crypto short trimmed by the exposure control: the fills leg counts the other way; the final close's own fill is not a trim", () => {
    // SOL/USDC short 12.13 @89.18 in 11-05; the control bought back 3 @85 today (fills row); the rest is open at 84.
    const entry = Date.UTC(2026, 10, 5, 0);
    trade({ id: "sol", account: "momentum_crypto_usdc", symbol: "SOL/USDC", side: "sell", qty: 9.13, entry: 89.18, entryTime: entry, partialRealized: 12.54, partialClosed: 3 });
    fill("sol", "momentum_crypto_usdc", "SOL/USDC", "sell", 89.18, 12.13, entry);          // the entry
    fill("sol", "momentum_crypto_usdc", "SOL/USDC", "buy", 85, 3, Date.UTC(2026, 10, 6, 12, 0, 20)); // the trim (07:00 ET)
    savePnlWindowMarks(T0, T0 - 100_000, [{ market: "crypto", symbol: "SOL/USDC", price: 86 }]);
    // A closed short whose only closing fill is the final close itself: no trim.
    trade({ id: "ada", account: "momentum_crypto", symbol: "ADA/USD", side: "sell", qty: 3747, entry: 0.1805, entryTime: entry, exit: 0.17, exitTime: Date.UTC(2026, 10, 6, 15, 0, 20), pnl: 39.3, partialClosed: 0 });
    fill("ada", "momentum_crypto", "ADA/USD", "buy", 0.17, 3747, Date.UTC(2026, 10, 6, 15, 0, 17));
    savePnlWindowMarks(T0, T0 - 100_000, [{ market: "crypto", symbol: "ADA/USD", price: 0.18 }]);
    const b = computePnlBreakdown({ db: getDB(), hist, periodDays: 1, pnl: 100, now: NOW6, openPositions: [
      open({ accountId: "momentum_crypto_usdc", symbol: "SOL/USDC", side: "sell", quantity: 9.13, entryPrice: 89.18, entryTime: entry, currentPrice: 84 }),
    ] });
    expect(b.closesCount).toBe(1);
    expect(b.trimsCount).toBe(1);
    expect(b.realized).toBeCloseTo((89.18 - 85) * 3 + 39.3, 6);
    expect(b.earnedBefore).toBeCloseTo((89.18 - 86) * 3 + (0.1805 - 0.18) * 3747, 6);
    expect(b.openChange).toBeCloseTo((86 - 84) * 9.13, 6);
    expect(b.closedInWindow! + b.positions!).toBe(100);
  });

  test("a fill without a price on a reducing leg nulls the closes figure (never guessed) but keeps the counts", () => {
    trade({ id: "iwm", account: "momentum_stocks", symbol: "IWM", qty: 19.12, entry: 280.5, entryTime: Date.UTC(2026, 10, 3, 14, 36), partialClosed: 9.34 });
    getDB().prepare(
      `INSERT INTO portfolio_decisions (account_id, strategy_version, session, as_of, mode, status, equity, book_json, weights_json, stops_json, memory_json, diagnostics_json, orders_json, note, decided_at, updated_at)
       VALUES ('momentum_stocks', 'v', 's', 's', 'live', 'submitted', 1, ?, '{}', '[]', '{}', '{}', ?, NULL, ?, ?)`,
    ).run(JSON.stringify([{ symbol: "IWM", qty: 28.46, avgEntryPrice: 280.5 }]),
      JSON.stringify([{ intent: { side: "sell", symbol: "IWM", qty: 9.34, notional: 1 }, clientOrderId: "c", applied: true, filledAt: PASS + 1000, result: { ok: true, filledQty: 9.34, avgPrice: null, status: "filled" } }]),
      PASS, PASS + 1000);
    const b = computePnlBreakdown({ db: getDB(), hist, periodDays: 1, pnl: 10, now: NOW6, openPositions: [] });
    expect(b.trimsCount).toBe(1);
    expect(b.closedInWindow).toBeNull();
    expect(b.positions).toBeNull();
  });
});
