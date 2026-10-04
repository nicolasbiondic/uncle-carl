// The daily portfolio invariant vs a CLOSED market — the missing test.
//
// runDailyInvariantCheck fires on the first 5-min snapshot tick after the ET
// date change, i.e. midnight ET: the stock market is ALWAYS closed then (and
// after any out-of-hours restart). At that moment the WS price cache is cold
// AND getLatestPrice's executable-quote freshness gate returns 0 — but the
// broker's own position mark is available 24/7. The snapshot side
// (syncAlpacaAccount → buildSleevePriceMap) always used that 3-level
// fallback; the invariant side (updateAllStates → acc.state.positions[]
// .unrealizedPnl) used a direct getLatestPrice read → unrealized ≡ 0 →
// `snapshot vs initial + realized + 0` violated by EXACTLY the real
// unrealized, every day, forever (prod: constant term 45_982.96 vs an
// oscillating $50.7–51k snapshot). Root cause: two price resolvers for one
// number. Fix: updateAllStates prices Alpaca sleeves through THE ONE
// resolver (buildSleevePriceMap) — this file locks both the resolver and the
// end-to-end invariant outcome.

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDB } from "../db/database";
import {
  getLastInvariantReport, reconcilePortfolioInvariants, setBrokerTruthAvailable,
} from "../portfolio/truth";
import { RISK_PROFILES } from "../config/riskProfiles";
import { makeTestDb, seedOpenTrade } from "../test-support/db";
import { makeAccountManager } from "../test-support/account";

const ENTRY = 100;
const QTY = 10;
const BROKER_MARK = 110; // Alpaca's last-close mark, served 24/7 by getPositions
const REAL_UNREALIZED = (BROKER_MARK - ENTRY) * QTY; // $100 > ledger tol ($50 + 1% × $1000)

/** Market-closed Alpaca: WS cache cold, REST quote stale-gated to 0 — only
 *  the broker's own position mark (getPositions) can price the book. */
function marketClosedManager() {
  return makeAccountManager({
    alpaca: {
      isConnected: () => true,
      getAccount: async () => ({ equity: "100000", cash: "50000" }),
      getCachedPrice: () => 0,          // WS cache cold (no bars outside RTH)
      getLatestPrice: async () => 0,    // executable-quote TTL: nothing fresh <30s
      getPositions: async () => [{
        symbol: "AAPL", market: "stock" as const, side: "buy" as const,
        quantity: QTY, avgEntryPrice: ENTRY, currentPrice: BROKER_MARK,
        unrealizedPnl: REAL_UNREALIZED, unrealizedPnlPct: 10, openedAt: Date.now(),
      }],
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
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM equity_snapshots;");
  setBrokerTruthAvailable("alpaca", false);
  setBrokerTruthAvailable("binance", false);
});

function seedOpenRow() {
  seedOpenTrade("t_invariant_aapl", "momentum_stocks", {
    strategy: "MOMENTUM_TSM", entryPrice: ENTRY, quantity: QTY, entryTime: Date.now(),
  });
}

describe("daily invariant with the market CLOSED and real unrealized ≠ 0", () => {
  test("updateAllStates prices stocks through the 24/7 broker-mark fallback, not entryPrice", async () => {
    seedOpenRow();
    const m = marketClosedManager();

    await m.updateAllStates();

    const pos = m.getAccount("momentum_stocks").state.positions.find(p => p.symbol === "AAPL")!;
    expect(pos.currentPrice).toBe(BROKER_MARK);                 // not pinned to entry
    expect(pos.unrealizedPnl).toBeCloseTo(REAL_UNREALIZED, 6);  // not ≡ 0 out of hours
  });

  test("runDailyInvariantCheck does NOT violate: snapshot and invariant use the same resolver", async () => {
    seedOpenRow();
    const m = marketClosedManager();

    // The exact prod sequence around ET midnight: 60s sync writes the ledger
    // truth (broker-mark priced), then the 5-min tick refreshes state, writes
    // snapshots, and reconciles.
    await (m as any).syncAlpacaAccount();
    await m.updateAllStates();
    (m as any).writeAllSnapshots();
    (m as any).runDailyInvariantCheck();

    const report = getLastInvariantReport()!;
    const ledger = report.checks.find(c => c.name === "ledger_momentum_stocks")!;
    expect(ledger.ok).toBe(true);
    expect(report.ok).toBe(true);

    // Snapshot really does carry the unrealized (this is what made 0 wrong).
    const snap = getDB().prepare(
      `SELECT equity FROM equity_snapshots WHERE profile_id = 'momentum_stocks' ORDER BY snapshot_time DESC LIMIT 1`,
    ).get() as { equity: number };
    expect(snap.equity).toBeCloseTo(RISK_PROFILES.momentum_stocks.initialEquity + REAL_UNREALIZED, 6);

    // Falsifier for the old behavior: feeding unrealized = 0 (what the stale
    // getLatestPrice path produced) violates by exactly the real unrealized.
    const stale = reconcilePortfolioInvariants({});
    const staleLedger = stale.checks.find(c => c.name === "ledger_momentum_stocks")!;
    expect(staleLedger.ok).toBe(false);
  });
});
