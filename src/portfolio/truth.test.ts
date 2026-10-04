// ══════════════════════════════════════════════
// src/portfolio/truth.ts — single-source getters + the daily invariant
// checker (§4): a seeded CONSISTENT book passes; the classic double-count
// (a sleeve snapshot carrying the whole broker wallet) fails loudly.
// ══════════════════════════════════════════════

import { describe, expect, test, beforeAll } from "bun:test";
import { EQUITY_SEMANTICS, getETDayStart, saveEquitySnapshot, getDB, getEquityPnlDisplay } from "../db/database";
import {
  getPortfolioEquityNow, getPortfolioEquityStart, getPortfolioEquityStartDisplay,
  getBrokerSnapshotNow,
  getSleeveEquityNow, getSleevePct, getSinceStartPct, getTodayPnl,
  reconcilePortfolioInvariants, getLastInvariantReport, setBrokerTruthAvailable,
  combineEquityPnlLegs,
} from "./truth";
import { makeTestDb } from "../test-support/db";

beforeAll(() => {
  makeTestDb();
  setBrokerTruthAvailable("alpaca", true);
  setBrokerTruthAvailable("binance", true);
  const now = Date.now();
  const midnight = getETDayStart();

  // Broker-truth *_main series: first (3d ago) → ET-midnight anchor → latest.
  saveEquitySnapshot("alpaca_main", 101_500, 90_000, 0, now - 3 * 86_400_000);
  saveEquitySnapshot("alpaca_main", 101_400, 90_000, 0, midnight - 60_000);
  saveEquitySnapshot("alpaca_main", 101_300, 90_100, 0, now);
  saveEquitySnapshot("binance_main", 5_200, 4_000, 0, now - 3 * 86_400_000);
  saveEquitySnapshot("binance_main", 5_150, 4_000, 0, midnight - 59_000);
  saveEquitySnapshot("binance_main", 5_100, 4_050, 0, now);

  // Sleeve ledgers (allocations: stocks 50k + meanrev 50k + crypto 5k).
  saveEquitySnapshot("momentum_stocks", 50_100, 40_000, 1, now);
  saveEquitySnapshot("meanrev_stocks", 49_900, 45_000, 1, now);
  saveEquitySnapshot("momentum_crypto", 5_100, 4_000, 1, now);
});

describe("truth getters — latest/first *_main snapshots, never `accounts`", () => {
  test("getPortfolioEquityNow sums the latest broker snapshots", () => {
    const now = getPortfolioEquityNow();
    expect(now.alpaca).toBe(101_300);
    expect(now.binance).toBe(5_100);
    expect(now.total).toBe(106_400);
  });

  test("consolidated totals fail closed when either broker snapshot is missing", () => {
    const db = getDB();
    db.prepare(`UPDATE equity_snapshots SET semantics = ? WHERE profile_id = 'binance_main' AND semantics = ?`)
      .run(EQUITY_SEMANTICS - 1, EQUITY_SEMANTICS);
    try {
      expect(getPortfolioEquityNow()).toEqual({ total: null, alpaca: 101_300, binance: null, coinm: null });
      expect(getPortfolioEquityStart()).toEqual({ total: null, alpaca: 101_500, binance: null, coinm: null });
      expect(getSinceStartPct()).toBeNull();
    } finally {
      db.prepare(`UPDATE equity_snapshots SET semantics = ? WHERE profile_id = 'binance_main' AND semantics = ?`)
        .run(EQUITY_SEMANTICS, EQUITY_SEMANTICS - 1);
    }
  });

  test("failed or stale live truth invalidates a persisted broker snapshot", () => {
    setBrokerTruthAvailable("binance", false);
    expect(getBrokerSnapshotNow("binance")).toBeNull();
    expect(getPortfolioEquityNow().total).toBeNull();
    setBrokerTruthAvailable("binance", true);

    const shift = 20 * 60_000;
    const db = getDB();
    db.prepare(`UPDATE equity_snapshots SET snapshot_time = snapshot_time - ? WHERE profile_id = 'binance_main'`).run(shift);
    try {
      expect(getBrokerSnapshotNow("binance")).toBeNull();
      expect(getPortfolioEquityNow().total).toBeNull();
    } finally {
      db.prepare(`UPDATE equity_snapshots SET snapshot_time = snapshot_time + ? WHERE profile_id = 'binance_main'`).run(shift);
    }
  });

  test("getBrokerSnapshotNow exposes cash for the broker cards", () => {
    expect(getBrokerSnapshotNow("alpaca")!.cash).toBe(90_100);
  });

  test("since-start anchors on the FIRST *_main snapshots", () => {
    expect(getPortfolioEquityStart().total).toBe(106_700);
    expect(getSinceStartPct()!).toBeCloseTo(((106_400 - 106_700) / 106_700) * 100, 6);
  });

  test("sleeve equity/pct come from the latest sleeve snapshot vs config allocation", () => {
    expect(getSleeveEquityNow("momentum_stocks")).toBe(50_100);
    expect(getSleevePct("momentum_stocks")!).toBeCloseTo(0.2, 6);
    expect(getSleevePct("momentum_crypto")!).toBeCloseTo(2.0, 6);
  });

  test("getTodayPnl = mark-to-market day move summed over both mains", () => {
    // alpaca −100 + binance −50, anchored at the last snapshot ≤ ET midnight.
    expect(getTodayPnl()!).toBeCloseTo(-150, 6);
  });

  test("getTodayPnl includes binance_coinm_main (DAPI) once it is applicable — never a partial 2-broker sum once COIN-M is live", () => {
    const midnight = getETDayStart();
    saveEquitySnapshot("binance_coinm_main", 1_000, 1_000, 0, midnight - 60_000);
    saveEquitySnapshot("binance_coinm_main", 970, 970, 0, Date.now());
    setBrokerTruthAvailable("coinm", true);
    try {
      // alpaca −100 + binance −50 + coinm −30 = −180.
      expect(getTodayPnl()!).toBeCloseTo(-180, 6);
    } finally {
      setBrokerTruthAvailable("coinm", false);
    }
  });
});

describe("combineEquityPnlLegs — broker *_main legs require a FRESH snapshot, not just a display row (§8)", () => {
  test("both legs fresh: combines normally (baseline, unchanged)", () => {
    const r = combineEquityPnlLegs(["alpaca_main", "binance_main"], 1);
    expect(r).not.toBeNull();
    expect(r!.pnl).toBeCloseTo(-100 + -50, 6); // same day-move as getTodayPnl's fixture
  });

  test("Telegram/dashboard-shaped: one *_main leg goes stale ⇒ combine returns null (P&L), matching getPortfolioEquityNow's total also going null — never a partial/stale $ figure while the total shows unavailable", () => {
    setBrokerTruthAvailable("binance", false);
    try {
      expect(getBrokerSnapshotNow("binance")).toBeNull();
      expect(getPortfolioEquityNow().total).toBeNull(); // "Total" — no number
      expect(combineEquityPnlLegs(["alpaca_main", "binance_main"], 1)).toBeNull(); // "Hoy" — no number
      expect(combineEquityPnlLegs(["alpaca_main", "binance_main"], 7)).toBeNull(); // "7D" — no number
    } finally {
      setBrokerTruthAvailable("binance", true);
    }
  });

  test("a stale *_main leg fails closed even though its stored display row is otherwise perfectly usable (getEquityPnlDisplay alone would have returned a real number)", () => {
    setBrokerTruthAvailable("binance", false);
    try {
      // The underlying display series is untouched and would happily answer —
      // proving the null above comes from the freshness gate, not from a
      // missing/discontinuous row.
      expect(getEquityPnlDisplay("binance_main", 1)).not.toBeNull();
      expect(combineEquityPnlLegs(["alpaca_main", "binance_main"], 1)).toBeNull();
    } finally {
      setBrokerTruthAvailable("binance", true);
    }
  });

  test("sleeve/non-main combinations are unaffected by the freshness gate — retain existing semantics even while a broker main is stale", () => {
    setBrokerTruthAvailable("binance", false);
    try {
      const r = combineEquityPnlLegs(["momentum_stocks", "meanrev_stocks"], 1);
      expect(r).not.toBeNull(); // sleeve ids never map to a BrokerKey — no gate applies
    } finally {
      setBrokerTruthAvailable("binance", true);
    }
  });
});

describe("reconcilePortfolioInvariants — daily books-agree check", () => {
  test("consistent book passes (legacy broker gap tolerated)", () => {
    // Live unrealized matching each sleeve ledger drift: eq = alloc + 0 realized + u.
    const report = reconcilePortfolioInvariants({
      momentum_stocks: 100, meanrev_stocks: -100, momentum_crypto: 100,
    });
    expect(report.ok).toBe(true);
    expect(getLastInvariantReport()).toEqual(report);
    // Both invariant families actually ran — one sleeves_vs_*_main check PER
    // series (exact bucket ownership), not one combined sum.
    expect(report.checks.some(c => c.name === "sleeves_vs_alpaca_main")).toBe(true);
    expect(report.checks.some(c => c.name === "sleeves_vs_binance_main")).toBe(true);
    // 2 reconstruction checks, not 3: momentum_crypto is the SOLE owner of the
    // Binance wallet, so its snapshot is broker-truth (includes perp funding
    // that trades.pnl never records) and is funding-exempt from reconstruction
    // (check (1) validates it against binance_main). Only the two SHARED-wallet
    // Alpaca sleeves get the ledger identity.
    expect(report.checks.filter(c => c.name.startsWith("ledger_")).length).toBe(2);
    expect(report.checks.some(c => c.name === "ledger_momentum_crypto")).toBe(false);
  });

  test("the classic double-count (sleeve snapshot = whole wallet) fails", () => {
    // The exact 2026-07-12 poison: momentum_stocks snapshot carries the whole
    // ~$101k Alpaca wallet instead of its $50k sleeve ledger. Written at test
    // time — strictly newer than the beforeAll rows (DB init sits between).
    saveEquitySnapshot("momentum_stocks", 101_300, 90_000, 1, Date.now());
    const report = reconcilePortfolioInvariants({
      momentum_stocks: 100, meanrev_stocks: -100, momentum_crypto: 100,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.name === "sleeves_vs_alpaca_main")!.ok).toBe(false);
    expect(report.checks.find(c => c.name === "ledger_momentum_stocks")!.ok).toBe(false);
    // The healthy shared-wallet sleeve stays green — the report points AT the
    // broken book, not the whole portfolio.
    expect(report.checks.find(c => c.name === "ledger_meanrev_stocks")!.ok).toBe(true);
    // Clean up the poison so it can't leak into other tests sharing the db singleton.
    getDB().prepare(`DELETE FROM equity_snapshots WHERE profile_id='momentum_stocks' AND equity=101300`).run();
  });
});

describe("DISPLAY-only Since Start spans configured-rebase eras; current-era anchors stay pinned (§6)", () => {
  test("a configured 4→5 boundary just before binance_main's earliest current-era row extends the display start further back and nulls the pct", () => {
    const earliest = getDB().prepare(
      `SELECT snapshot_time FROM equity_snapshots WHERE profile_id='binance_main' ORDER BY snapshot_time ASC LIMIT 1`
    ).get() as { snapshot_time: number };
    // era4 row, 5min before the earliest current-era (5) row — configured pair.
    getDB().prepare(
      `INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time, semantics) VALUES (?,?,?,?,?,?)`
    ).run("binance_main", 3_000, 3_000, 0, earliest.snapshot_time - 5 * 60_000, 4);

    // Operational anchor (invariants) is untouched — still the first CURRENT-era row.
    expect(getPortfolioEquityStart().binance).toBe(5_200);

    // Display anchor reaches further back into the new era4 row instead (raw
    // 3,000, adjusted by binance_main's real PERSISTED 4→5 offset — §7: the
    // 5min gap is irrelevant, only the persisted forensic value is ever used).
    const off45 = (getDB().prepare(
      `SELECT equity_offset FROM equity_semantics_transitions WHERE profile_id='binance_main' AND from_semantics=4 AND to_semantics=5`
    ).get() as { equity_offset: number }).equity_offset;
    const disp = getPortfolioEquityStartDisplay();
    expect(disp.binance).toBeCloseTo(3_000 + off45, 6);
    expect(disp.rebased).toBe(true);

    // getSinceStartPct suppresses % once the display start required a rebase.
    expect(getSinceStartPct()).toBeNull();
  });
});
