// Window-start marks for the P&L bridge (2026-11-06). The single snapshot
// writer keeps each pass's per-symbol marks in memory and, on the first pass
// after an ET-day start, persists the PREVIOUS pass's marks under that day —
// the same pass whose *_main row getEquityPnlDisplay picks as the window
// start (last snapshot ≤ 00:00 ET). A restart across the boundary leaves no
// marks (the bridge falls back to bars); a marks failure never reaches the
// snapshots or the bot.
import { beforeEach, describe, expect, test } from "bun:test";
import { getDB, getETDayStart, getPnlWindowMarks } from "../db/database";
import { makeTestDb } from "../test-support/db";
import { setBrokerTruthAvailable } from "../portfolio/truth";
import { AccountManager } from "./AccountManager";

const H = 3_600_000;
// Fri 2026-11-06 00:00 ET = 05:00 UTC; passes every 5 min like prod.
const DAY_START = Date.UTC(2026, 10, 6, 5);
const T_BEFORE = DAY_START - 99_000;   // 04:58:21 UTC — the last pass of 11-05
const T_AFTER = DAY_START + 201_000;   // 05:03:21 UTC — the first pass of 11-06

function armed(am: AccountManager, clock: () => number) {
  (am as any).snapshotClock = clock;
  (am as any).alpacaMainTruth = { equity: 103_503.18, cash: -3_433.9 };
  setBrokerTruthAvailable("alpaca", true);
  const stocks = am.getAccount("momentum_stocks");
  stocks.equity.syncLedger(49_000, 10_000);
  stocks.state = {
    ...stocks.state,
    positions: [
      { symbol: "AAPL", market: "stock", side: "buy", quantity: 18.42, avgEntryPrice: 327.04, currentPrice: 337.42, unrealizedPnl: 0, unrealizedPnlPct: 0, openedAt: 0, leverage: 1, durationSeconds: 0 } as any,
      { symbol: "NOPX", market: "stock", side: "buy", quantity: 1, avgEntryPrice: 10, currentPrice: 0, unrealizedPnl: 0, unrealizedPnlPct: 0, openedAt: 0, leverage: 1, durationSeconds: 0 } as any,
    ],
  };
  const crypto = am.getAccount("momentum_crypto");
  crypto.equity.syncBrokerTruth(4_800, 4_000);
  crypto.state = {
    ...crypto.state,
    positions: [{ symbol: "SOL/USD", market: "crypto", side: "sell", quantity: 10.89, avgEntryPrice: 92.11, currentPrice: 88.4, unrealizedPnl: 0, unrealizedPnlPct: 0, openedAt: 0, leverage: 1, durationSeconds: 0 } as any],
  };
  // COIN-M is not markable: its BTC/USD would collide with the USDT perp's key.
  const btc = am.getAccount("momentum_btc");
  btc.state = { ...btc.state, positions: [{ symbol: "BTC/USD", market: "crypto", side: "buy", quantity: 3, avgEntryPrice: 1, currentPrice: 75_000, unrealizedPnl: 0, unrealizedPnlPct: 0, openedAt: 0, leverage: 1, durationSeconds: 0 } as any] };
}

const marksFor = (ws: number) => getPnlWindowMarks(ws).sort((a, b) => a.symbol.localeCompare(b.symbol));
const lastMainRowAtOrBefore = (t: number) => (getDB().prepare(
  `SELECT snapshot_time t FROM equity_snapshots WHERE profile_id = 'alpaca_main' AND snapshot_time <= ? ORDER BY snapshot_time DESC LIMIT 1`,
).get(t) as any)?.t;

describe("writeAllSnapshots persists the previous pass's marks when it crosses an ET day start", () => {
  beforeEach(() => { makeTestDb(); });

  test("crossing: the 04:58 pass's prices land under 11-06 00:00 ET, stamped with that pass's time — the row getEquityPnlDisplay picks", () => {
    let now = T_BEFORE;
    const am = new AccountManager();
    armed(am, () => now);
    (am as any).writeAllSnapshots();
    expect(marksFor(DAY_START)).toEqual([]); // nothing to persist yet: no previous pass

    now = T_AFTER;
    (am as any).writeAllSnapshots();
    const marks = marksFor(DAY_START);
    expect(marks).toEqual([
      { market: "stock", symbol: "AAPL", price: 337.42, snapshotTime: T_BEFORE },
      { market: "crypto", symbol: "SOL/USD", price: 88.4, snapshotTime: T_BEFORE },
    ]);
    // Exactly the window-start row: the last alpaca_main snapshot ≤ 00:00 ET
    // is the one this pass wrote, with the same timestamp as the marks.
    expect(lastMainRowAtOrBefore(DAY_START)).toBe(T_BEFORE);
    expect(getETDayStart(T_AFTER)).toBe(DAY_START);

    // Later passes of the same day add nothing; the next day's boundary gets the last pass of 11-06.
    now = T_AFTER + H;
    (am as any).writeAllSnapshots();
    expect(marksFor(DAY_START)).toHaveLength(2);
    am.getAccount("momentum_stocks").state.positions[0].currentPrice = 340.9;
    now = DAY_START + 23 * H;
    (am as any).writeAllSnapshots();
    now = DAY_START + 24 * H + 60_000;
    (am as any).writeAllSnapshots();
    expect(marksFor(DAY_START + 24 * H).find(m => m.symbol === "AAPL")).toEqual({ market: "stock", symbol: "AAPL", price: 340.9, snapshotTime: DAY_START + 23 * H });
  });

  test("restart across the boundary: the first pass of the new process has no previous pass — no marks for that day", () => {
    const am = new AccountManager();
    armed(am, () => T_AFTER);
    (am as any).writeAllSnapshots();
    (am as any).snapshotClock = () => T_AFTER + 300_000;
    (am as any).writeAllSnapshots();
    expect(marksFor(DAY_START)).toEqual([]);
  });

  test("failure isolated: a marks write that throws is logged and the pass's snapshots still land", () => {
    let now = T_BEFORE;
    const am = new AccountManager();
    armed(am, () => now);
    (am as any).writeAllSnapshots();
    getDB().exec("DROP TABLE pnl_window_marks");
    now = T_AFTER;
    expect(() => (am as any).writeAllSnapshots()).not.toThrow();
    expect(lastMainRowAtOrBefore(T_AFTER)).toBe(T_AFTER);
  });
});
