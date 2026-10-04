// ══════════════════════════════════════════════
// momentum_crypto_usdc / momentum_btc integration tests — 2026-07-19,
// corrected 2026-07-19 (reviewer pass): the original version of this file
// asserted a FALSE premise — that momentum_crypto_usdc owns a wallet
// physically separate from binance_main. It does not: momentum_crypto_usdc
// trades USDC-margined perps on the SAME FAPI account momentum_crypto (USDT)
// and binance_main (the account total) already read — BinanceExecutor.
// getAccountTotal() sums every asset row (USDT/USDC/BTC) exactly once. Only
// momentum_btc (DAPI COIN-M) is a genuinely separate ledger, with its own
// broker-truth series binance_coinm_main. See src/config/riskProfiles.ts
// BROKER_MAIN_SERIES/LEDGER_SLEEVE_BROKERS and src/portfolio/truth.ts.
//
// Covers: the corrected accounting model, activation safety (flags-off ⇒ no
// account/card/circuit/snapshot rows; close-only when exposure exists), and
// AccountManager's attach/shutdown contract for the two new sleeves.

import { describe, test, expect, beforeEach } from "bun:test";
import {
  closeTradeExplicit, currentSemantics,
  saveEquitySnapshot, getDB,
} from "../db/database";
import { RISK_PROFILES, ALL_PROFILE_IDS, BROKER_MAIN_SERIES, LEDGER_SLEEVE_BROKERS } from "../config/riskProfiles";
import { reconcilePortfolioInvariants, setBrokerTruthAvailable, getPortfolioEquityNow } from "../portfolio/truth";
import { AccountManager } from "./AccountManager";
import { makeTestDb, seedOpenTrade } from "../test-support/db";

describe("riskProfiles registry — momentum_crypto_usdc / momentum_btc", () => {
  test("both are registered with disjoint EXECUTOR-ROUTING broker ids, never 'binance'", () => {
    expect(ALL_PROFILE_IDS).toContain("momentum_crypto_usdc");
    expect(ALL_PROFILE_IDS).toContain("momentum_btc");
    expect(RISK_PROFILES.momentum_crypto_usdc.broker).toBe("binance_usdc");
    expect(RISK_PROFILES.momentum_btc.broker).toBe("binance_coinm");
    // Never collide with the existing USDT sleeve's EXECUTOR — that's the
    // ownership boundary "never route USDC/COIN-M through the USDT executor"
    // depends on structurally.
    expect(RISK_PROFILES.momentum_crypto_usdc.broker).not.toBe(RISK_PROFILES.momentum_crypto.broker);
    expect(RISK_PROFILES.momentum_btc.broker).not.toBe(RISK_PROFILES.momentum_crypto.broker);
  });

  test("USDC bucket: $5000 initial, 2x leverage", () => {
    expect(RISK_PROFILES.momentum_crypto_usdc.initialEquity).toBe(5_000);
    expect(RISK_PROFILES.momentum_crypto_usdc.leverage).toBe(2);
  });

  test("BTC bucket: configurable seed, 2x leverage", () => {
    expect(RISK_PROFILES.momentum_btc.leverage).toBe(2);
    expect(RISK_PROFILES.momentum_btc.initialEquity).toBeGreaterThan(0);
  });

  test("ACCOUNTING model: momentum_crypto_usdc shares binance_main (same FAPI account as momentum_crypto); momentum_btc owns its own binance_coinm_main", () => {
    expect(BROKER_MAIN_SERIES[RISK_PROFILES.momentum_crypto.broker]).toBe("binance_main");
    expect(BROKER_MAIN_SERIES[RISK_PROFILES.momentum_crypto_usdc.broker]).toBe("binance_main");
    expect(BROKER_MAIN_SERIES[RISK_PROFILES.momentum_btc.broker]).toBe("binance_coinm_main");
    // Neither binance* sleeve is a computed LEDGER — each reads its own
    // margin-pool balance straight from the broker (funding-exempt from the
    // ledger-vs-broker cross-check, same as momentum_crypto always was).
    expect(LEDGER_SLEEVE_BROKERS.has(RISK_PROFILES.momentum_crypto.broker)).toBe(false);
    expect(LEDGER_SLEEVE_BROKERS.has(RISK_PROFILES.momentum_crypto_usdc.broker)).toBe(false);
    expect(LEDGER_SLEEVE_BROKERS.has(RISK_PROFILES.momentum_btc.broker)).toBe(false);
  });
});

describe("equity semantics registry — new series start at the current version", () => {
  test("currentSemantics never throws for the new series and matches the current era", () => {
    const era = currentSemantics("momentum_crypto"); // known-good existing series
    expect(currentSemantics("momentum_crypto_usdc")).toBe(era);
    expect(currentSemantics("momentum_btc")).toBe(era);
    expect(currentSemantics("binance_coinm_main")).toBe(era);
  });
});

describe("closeTradeExplicit — canonical inverse-contract close", () => {
  beforeEach(() => { makeTestDb(); });

  test("writes the EXPLICIT pnl/pnl_pct (not the linear formula) and close_reason atomically", () => {
    seedOpenTrade("cm-1", "momentum_btc", {
      symbol: "BTC/COIN-M", market: "crypto", entryPrice: 50_000, quantity: 5, entryTime: Date.now(),
    });

    // Inverse pnl for 5 contracts of $100 notional each, long, entry 50000 ->
    // exit 55000: notional=500, pnl_btc = 500*(1/50000 - 1/55000) ≈ 0.00090909
    // -> at exit price 55000 => ~$50.00. A LINEAR formula would instead give
    // (55000-50000)*5 = $25,000 — wildly wrong for an inverse contract, which
    // is exactly the bug this helper exists to prevent.
    const pnl = 50.0;
    const pnlPct = 10.0;
    const closed = closeTradeExplicit("cm-1", 55_000, Date.now(), pnl, pnlPct, "MOMENTUM_REBALANCE");

    expect(closed).not.toBeNull();
    expect(closed!.pnl).toBe(pnl);
    expect(closed!.pnlPct).toBe(pnlPct);

    const row = getDB().prepare(`SELECT pnl, pnl_pct, status, close_reason FROM trades WHERE id = ?`).get("cm-1") as any;
    expect(row.pnl).toBe(pnl);
    expect(row.pnl_pct).toBe(pnlPct);
    expect(row.status).toBe("closed");
    expect(row.close_reason).toBe("MOMENTUM_REBALANCE");
  });

  test("race-safe: returns null (no-op) when the row is already closed", () => {
    seedOpenTrade("cm-2", "momentum_btc", {
      symbol: "BTC/COIN-M", market: "crypto", entryPrice: 50_000, entryTime: Date.now(),
    });
    expect(closeTradeExplicit("cm-2", 51_000, Date.now(), 1, 1)).not.toBeNull();
    expect(closeTradeExplicit("cm-2", 52_000, Date.now(), 2, 2)).toBeNull(); // already closed
    const row = getDB().prepare(`SELECT pnl FROM trades WHERE id = ?`).get("cm-2") as any;
    expect(row.pnl).toBe(1); // second call did NOT overwrite
  });

  test("close_reason is optional — preserves any existing value via COALESCE", () => {
    seedOpenTrade("cm-3", "momentum_btc", {
      symbol: "BTC/COIN-M", market: "crypto", side: "sell", entryPrice: 50_000, entryTime: Date.now(),
    });
    closeTradeExplicit("cm-3", 49_000, Date.now(), 5, 5); // no reason passed
    const row = getDB().prepare(`SELECT close_reason FROM trades WHERE id = ?`).get("cm-3") as any;
    expect(row.close_reason).toBeNull();
  });
});

describe("portfolio invariants — corrected model: momentum_crypto_usdc IS inside binance_main; momentum_btc owns binance_coinm_main", () => {
  beforeEach(() => { makeTestDb(); });

  // Two snapshots (an early "first" at exactly the configured allocations,
  // then "now") zero out the legacy-gap fudge term cleanly — isolates the
  // drift math itself rather than fighting the historical-offset mechanic
  // (see truth.ts's own legacyGap doc; the pre-existing truth.test.ts fixture
  // uses the same first→now pattern).
  const binanceAllocs = RISK_PROFILES.momentum_crypto.initialEquity + RISK_PROFILES.momentum_crypto_usdc.initialEquity;

  test("check runs PER *_main series: binance_main must equal momentum_crypto + momentum_crypto_usdc (both real FAPI sub-wallets), never just momentum_crypto alone", () => {
    const early = Date.now() - 3 * 86_400_000, now = Date.now();
    saveEquitySnapshot("alpaca_main", 100_000, 100_000, 0, now);
    saveEquitySnapshot("momentum_stocks", 50_000, 50_000, 0, now);
    saveEquitySnapshot("meanrev_stocks", 50_000, 50_000, 0, now);
    // binance_main = momentum_crypto's USDT sub-pool (4_000) + momentum_crypto_usdc's
    // USDC sub-pool (1_000) — the SAME physical FAPI account total.
    saveEquitySnapshot("binance_main", binanceAllocs, binanceAllocs, 0, early);
    saveEquitySnapshot("binance_main", 5_000, 5_000, 0, now);
    saveEquitySnapshot("momentum_crypto", 4_000, 4_000, 0, now);
    saveEquitySnapshot("momentum_crypto_usdc", 1_000, 1_000, 0, now);

    setBrokerTruthAvailable("alpaca", true);
    setBrokerTruthAvailable("binance", true);

    const report = reconcilePortfolioInvariants();
    const check = report.checks.find(c => c.name === "sleeves_vs_binance_main");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);

    // Neither binance* sleeve gets a ledger_ check — both are direct
    // broker-truth reads (funding-exempt), same as momentum_crypto always was.
    expect(report.checks.some(c => c.name === "ledger_momentum_crypto")).toBe(false);
    expect(report.checks.some(c => c.name === "ledger_momentum_crypto_usdc")).toBe(false);
    expect(report.checks.some(c => c.name === "ledger_momentum_btc")).toBe(false);
  });

  test("the double-count this file used to bless as healthy now correctly FAILS: momentum_crypto_usdc equity unrelated to binance_main's actual reading", () => {
    const early = Date.now() - 3 * 86_400_000, now = Date.now();
    saveEquitySnapshot("binance_main", binanceAllocs, binanceAllocs, 0, early);
    saveEquitySnapshot("binance_main", 5_000, 5_000, 0, now); // real FAPI total: just $5k
    saveEquitySnapshot("momentum_crypto", 5_000, 5_000, 0, now);
    saveEquitySnapshot("momentum_crypto_usdc", 50_000, 50_000, 0, now); // fabricated, NOT in binance_main
    setBrokerTruthAvailable("alpaca", false); // alpaca not seeded — isolate this check
    setBrokerTruthAvailable("binance", true);

    const report = reconcilePortfolioInvariants();
    const check = report.checks.find(c => c.name === "sleeves_vs_binance_main");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(false); // binance_main $5,000 vs sleeves $55,000 — real drift
  });

  test("momentum_btc/binance_coinm_main: sole owner, funding-exempt, never mixed into binance_main", () => {
    const early = Date.now() - 3 * 86_400_000, now = Date.now();
    const btcAlloc = RISK_PROFILES.momentum_btc.initialEquity;
    // Only momentum_crypto (USDT) has ever synced binance_main in this
    // fixture — momentum_crypto_usdc stays excluded from the legacy-gap math
    // (it has no snapshot), matching the "never active ⇒ never counted" rule.
    const cryptoAlloc = RISK_PROFILES.momentum_crypto.initialEquity;
    saveEquitySnapshot("binance_main", cryptoAlloc, cryptoAlloc, 0, early);
    saveEquitySnapshot("binance_main", 5_000, 5_000, 0, now);
    saveEquitySnapshot("momentum_crypto", 5_000, 5_000, 0, now);
    saveEquitySnapshot("binance_coinm_main", btcAlloc, btcAlloc, 0, early);
    saveEquitySnapshot("binance_coinm_main", 20_000, 20_000, 0, now); // DAPI, unrelated magnitude
    saveEquitySnapshot("momentum_btc", 20_000, 20_000, 0, now);
    setBrokerTruthAvailable("alpaca", false);
    setBrokerTruthAvailable("binance", true);
    setBrokerTruthAvailable("coinm", true);

    const report = reconcilePortfolioInvariants();
    expect(report.checks.find(c => c.name === "sleeves_vs_binance_main")!.ok).toBe(true);
    expect(report.checks.find(c => c.name === "sleeves_vs_binance_coinm_main")!.ok).toBe(true);
    expect(report.checks.some(c => c.name === "ledger_momentum_btc")).toBe(false);
  });

  test("a never-enabled COIN-M sleeve (no binance_coinm_main snapshot ever) does not block the consolidated total", () => {
    const now = Date.now();
    saveEquitySnapshot("alpaca_main", 100_000, 100_000, 0, now);
    saveEquitySnapshot("binance_main", 5_000, 5_000, 0, now);
    setBrokerTruthAvailable("alpaca", true);
    setBrokerTruthAvailable("binance", true);
    const totals = getPortfolioEquityNow();
    expect(totals.coinm).toBeNull();
    expect(totals.total).toBe(105_000); // NOT null just because COIN-M was never turned on
  });
});

describe("AccountManager — activation safety (flags OFF ⇒ no exposure) and close-only mode", () => {
  beforeEach(() => { makeTestDb(); });

  test("registered ≠ active: a bare AccountManager has both new sleeves registered but INACTIVE", () => {
    const am = new AccountManager();
    expect(ALL_PROFILE_IDS).toContain("momentum_crypto_usdc");
    expect(am.getActiveProfileIds()).not.toContain("momentum_crypto_usdc");
    expect(am.getActiveProfileIds()).not.toContain("momentum_btc");
    expect(am.getActiveProfileIds().length).toBe(ALL_PROFILE_IDS.length - 2);
  });

  test("inactive sleeves produce NO card, NO circuit, and contribute NOTHING to the consolidated total", () => {
    const am = new AccountManager();
    const ids = am.getAccountSummaries().map(s => s.id);
    expect(ids).not.toContain("momentum_crypto_usdc");
    expect(ids).not.toContain("momentum_btc");
    expect(Object.keys(am.getCircuits())).not.toContain("momentum_crypto_usdc");
    expect(Object.keys(am.getCircuits())).not.toContain("momentum_btc");
    // The seed initialEquity ($5,000 + $1,000) must NEVER leak into the
    // consolidated equity/initTotal while inactive.
    const consolidated = am.getConsolidatedState();
    const active = am.getActiveProfileIds();
    const expectedEquity = active.reduce((s, id) => s + am.getAccount(id).equity.equity, 0);
    expect(consolidated.totalEquity).toBeCloseTo(expectedEquity, 6);
  });

  test("attachUsdcExecutor/attachCoinmExecutor never start loops before start() runs (no network)", () => {
    const am = new AccountManager(); // network-free: executors only store config
    const fakeUsdc = { isConnected: () => false, stopUserDataStream: () => { fakeUsdc.stopped = true; }, stopped: false } as any;
    const fakeCoinm = { isConnected: () => false, shutdown: () => { fakeCoinm.stopped = true; }, stopped: false } as any;
    am.attachUsdcExecutor(fakeUsdc);
    am.attachCoinmExecutor(fakeCoinm);
    // Nothing thrown, nothing started — AccountManager.running is false.
    expect(fakeUsdc.stopped).toBe(false);
    expect(fakeCoinm.stopped).toBe(false);
  });

  test("attach() activates the sleeve: it now has a card, defaulting to LIVE mode", () => {
    const am = new AccountManager();
    am.attachUsdcExecutor({ isConnected: () => false } as any);
    am.attachCoinmExecutor({ isConnected: () => false } as any);
    expect(am.getActiveProfileIds()).toContain("momentum_crypto_usdc");
    expect(am.getActiveProfileIds()).toContain("momentum_btc");
    const summaries = am.getAccountSummaries();
    expect(summaries.find(s => s.id === "momentum_crypto_usdc")?.mode).toBe("live");
    expect(summaries.find(s => s.id === "momentum_btc")?.mode).toBe("live");
  });

  test("attach({live:false}) activates CLOSE-ONLY mode: card exists but never claims LIVE", () => {
    const am = new AccountManager();
    am.attachUsdcExecutor({ isConnected: () => false } as any, { live: false });
    am.attachCoinmExecutor({ isConnected: () => false } as any, { live: false });
    expect(am.getActiveProfileIds()).toContain("momentum_crypto_usdc"); // active — exposure is being reconciled
    const summaries = am.getAccountSummaries();
    expect(summaries.find(s => s.id === "momentum_crypto_usdc")?.mode).toBe("close-only");
    expect(summaries.find(s => s.id === "momentum_btc")?.mode).toBe("close-only");
  });

  test("stop() calls the new executors' bounded shutdown (stopUserDataStream / shutdown), never cancels native stops itself", async () => {
    const am = new AccountManager();
    const fakeUsdc = { isConnected: () => false, stopUserDataStream: () => { fakeUsdc.stopped = true; }, stopped: false } as any;
    const fakeCoinm = { isConnected: () => false, shutdown: () => { fakeCoinm.stopped = true; }, stopped: false, cancelActiveStop: () => { fakeCoinm.cancelCalled = true; }, cancelCalled: false } as any;
    am.attachUsdcExecutor(fakeUsdc);
    am.attachCoinmExecutor(fakeCoinm);
    await am.stop();
    expect(fakeUsdc.stopped).toBe(true);
    expect(fakeCoinm.stopped).toBe(true);
    expect(fakeCoinm.cancelCalled).toBe(false); // shutdown() must never sweep native stops
  });

  test("stop() tolerates a throwing executor shutdown (bounded, never crashes the manager)", async () => {
    const am = new AccountManager();
    am.attachUsdcExecutor({ isConnected: () => false, stopUserDataStream: () => { throw new Error("boom"); } } as any);
    am.attachCoinmExecutor({ isConnected: () => false, shutdown: () => { throw new Error("boom"); } } as any);
    await expect(am.stop()).resolves.toBeUndefined();
  });

  test("first enable: syncing broker truth BEFORE the first snapshot write persists the REAL reading, never the EquityTracker constructor seed", async () => {
    const am = new AccountManager();
    // Real config seed is $5,000 (RISK_PROFILES.momentum_crypto_usdc.initialEquity);
    // the broker's actual balance is deliberately different so a seed-jump bug
    // is unmistakable in the assertion.
    expect(am.getAccount("momentum_crypto_usdc").equity.equity).toBe(5_000);
    const fakeUsdc = {
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 1_234.56, marginCash: 1_000, wallet: 1_234.56, unrealizedPnl: 0 }),
      getPositions: async () => [],
    } as any;
    am.attachUsdcExecutor(fakeUsdc, { live: true });

    // Simulates exactly the order src/account/AccountManager.ts#start() now
    // enforces: the startup sync for an ACTIVE sleeve runs BEFORE the first
    // writeAllSnapshots() call (never the staggered +20s periodic loop).
    await (am as any).syncBinanceUsdc();
    expect(am.getAccount("momentum_crypto_usdc").equity.equity).toBeCloseTo(1_234.56, 6);
    (am as any).writeAllSnapshots();

    const row = getDB().prepare(
      `SELECT equity FROM equity_snapshots WHERE profile_id = 'momentum_crypto_usdc' ORDER BY snapshot_time DESC LIMIT 1`
    ).get() as any;
    expect(row.equity).toBeCloseTo(1_234.56, 6); // NOT the $5,000 seed
  });

  test("flags-off, multiple snapshot cycles: zero equity_snapshots rows ever written for an inactive sleeve", () => {
    const am = new AccountManager();
    for (let i = 0; i < 5; i++) (am as any).writeAllSnapshots();
    const count = (getDB().prepare(
      `SELECT COUNT(*) n FROM equity_snapshots WHERE profile_id IN ('momentum_crypto_usdc', 'momentum_btc')`
    ).get() as any).n;
    expect(count).toBe(0);
  });
});

describe("portfolio invariants — DAPI (binance_coinm_main) staleness fails the consolidated total CLOSED, not partial", () => {
  beforeEach(() => { makeTestDb(); });

  test("coinm APPLICABLE (has a first snapshot) but currently stale ⇒ consolidated total is null, not the alpaca+binance partial sum", () => {
    const now = Date.now();
    saveEquitySnapshot("alpaca_main", 100_000, 100_000, 0, now);
    saveEquitySnapshot("binance_main", 5_000, 5_000, 0, now);
    saveEquitySnapshot("binance_coinm_main", 1_000, 1_000, 0, now - 20 * 60_000); // recorded once, long ago
    setBrokerTruthAvailable("alpaca", true);
    setBrokerTruthAvailable("binance", true);
    setBrokerTruthAvailable("coinm", false); // no live refresh cached — stale/unavailable

    const totals = getPortfolioEquityNow();
    expect(totals.coinm).toBeNull();
    expect(totals.total).toBeNull(); // fail CLOSED — not 105_000 (the partial alpaca+binance sum)
  });
});

describe("momentum_btc TRUTH-ONLY mode (mandate 2026-07-19): DAPI truth exists independently of MOMENTUM_COINM_ENABLED", () => {
  beforeEach(() => { makeTestDb(); });

  test("attachCoinmExecutor({truthOnly:true}) keeps the sleeve INACTIVE — no card, no circuit — while still wiring the sync loop", () => {
    const am = new AccountManager();
    const fakeCoinm = { isConnected: () => true, getEquityUsd: async () => 1_000, getOwnedPosition: async () => null } as any;
    am.attachCoinmExecutor(fakeCoinm, { truthOnly: true });
    expect(am.getActiveProfileIds()).not.toContain("momentum_btc");
    expect(am.getAccountSummaries().map(s => s.id)).not.toContain("momentum_btc");
    expect(Object.keys(am.getCircuits())).not.toContain("momentum_btc");
  });

  test("truth-only sync populates binance_coinm_main broker truth and writes ONLY that snapshot — never a momentum_btc sleeve row", async () => {
    const am = new AccountManager();
    const fakeCoinm = { isConnected: () => true, getEquityUsd: async () => 1_234.56, getOwnedPosition: async () => null } as any;
    am.attachCoinmExecutor(fakeCoinm, { truthOnly: true });
    await (am as any).syncBinanceCoinM();
    (am as any).writeAllSnapshots();

    const coinmRow = getDB().prepare(
      `SELECT equity FROM equity_snapshots WHERE profile_id = 'binance_coinm_main' ORDER BY snapshot_time DESC LIMIT 1`
    ).get() as any;
    expect(coinmRow.equity).toBeCloseTo(1_234.56, 6);
    const sleeveCount = (getDB().prepare(
      `SELECT COUNT(*) n FROM equity_snapshots WHERE profile_id = 'momentum_btc'`
    ).get() as any).n;
    expect(sleeveCount).toBe(0);
  });

  test("CRITICAL: truth-only sync NEVER touches a real broker position with no matching DB row — 'production already has 0.01 BTC in DAPI, flag off, no DB trade' must not get emergency-closed", async () => {
    let closeCalled = false;
    const am = new AccountManager();
    const fakeCoinm = {
      isConnected: () => true,
      getEquityUsd: async () => 5_000,
      // A REAL funded position sits on the broker (0.01 BTC), but the DB has
      // ZERO open trades for momentum_btc (the flag has always been off) —
      // exactly the scenario the live-only reconciliation branches in
      // syncBinanceCoinM would otherwise treat as an "orphan" and
      // emergency-close.
      getOwnedPosition: async () => ({
        symbol: "BTCUSD_PERP", positionAmt: 0.01, entryPrice: 60_000, markPrice: 60_500,
        unrealizedProfit: 5, leverage: 2, updateTime: Date.now(),
      }),
      closePosition: async () => { closeCalled = true; return { success: true, filledPrice: 60_500, executedQty: 0.01, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "BTC" }; },
      getFilters: async () => ({}),
    } as any;
    am.attachCoinmExecutor(fakeCoinm, { truthOnly: true });

    await (am as any).syncBinanceCoinM();

    expect(closeCalled).toBe(false); // the "no DB trade ⇒ orphan" branch must NEVER run in truth-only mode
    (am as any).writeAllSnapshots();
    const coinmRow = getDB().prepare(
      `SELECT equity FROM equity_snapshots WHERE profile_id = 'binance_coinm_main' ORDER BY snapshot_time DESC LIMIT 1`
    ).get() as any;
    expect(coinmRow.equity).toBe(5_000); // equity read still happened — read-only, not a no-op
  });

  test("live/close-only modes are UNCHANGED: reconciliation still runs (regression guard for the truth-only guard above)", async () => {
    let closeCalled = false;
    const am = new AccountManager();
    const fakeCoinm = {
      isConnected: () => true,
      getEquityUsd: async () => 5_000,
      getOwnedPosition: async () => ({
        symbol: "BTCUSD_PERP", positionAmt: 0.01, entryPrice: 60_000, markPrice: 60_500,
        unrealizedProfit: 5, leverage: 2, updateTime: Date.now(),
      }),
      closePosition: async () => { closeCalled = true; return { success: true, filledPrice: 60_500, executedQty: 0.01, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "BTC" }; },
      getFilters: async () => ({}),
    } as any;
    // live mode (flag on), no DB trade ⇒ a broker position with no DB row IS
    // a genuine orphan and must still be emergency-closed as before.
    am.attachCoinmExecutor(fakeCoinm, { live: true });
    await (am as any).syncBinanceCoinM();
    expect(closeCalled).toBe(true);
  });
});

// Final-reviewer blocker: an emergency-close reread that THROWS (transport
// failure) was previously coerced by `.catch(() => null)` into the same
// falsy shape as "confirmed flat", so the reconcile loop silently claimed
// "emergency-closed and verified flat" on a read failure it never actually
// observed. Both live reconcile branches (unprotected DB-tracked position,
// and no-DB-trade orphan) must instead page loudly and never claim verified.
describe("live mode syncBinanceCoinM — emergency-close reread THROW must never be read as verified flat", () => {
  beforeEach(() => { makeTestDb(); });

  test("unprotected DB-tracked position: close succeeds, reread THROWS -> loud MANUAL RECONCILE error, never 'verified flat'", async () => {
    seedOpenTrade("cm-unprotected-throw", "momentum_btc", {
      symbol: "BTC/COIN-M", market: "crypto", entryPrice: 50_000, quantity: 5, entryTime: Date.now(),
      // no stopLoss -> unprotected branch, no ensureLiveStop call needed
    });
    const am = new AccountManager();
    let closeCalled = false;
    let posCalls = 0;
    const fakeCoinm = {
      isConnected: () => true,
      getEquityUsd: async () => 5_000,
      getOwnedPosition: async () => {
        posCalls++;
        if (posCalls === 1) return { symbol: "BTCUSD_PERP", positionAmt: 5, entryPrice: 50_000, markPrice: 50_500, unrealizedProfit: 0, leverage: 2, updateTime: Date.now() };
        throw new Error("ETIMEDOUT"); // the post-close reread fails — state UNKNOWN, not flat
      },
      closePosition: async () => { closeCalled = true; return { success: true, filledPrice: 50_500, executedQty: 5, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "BTC" }; },
      getFilters: async () => ({}),
    } as any;
    am.attachCoinmExecutor(fakeCoinm, { live: true });
    await (am as any).syncBinanceCoinM();
    expect(closeCalled).toBe(true);
    const activity = getDB().prepare(
      `SELECT event_type, message FROM activity_log WHERE account_id = 'momentum_btc' ORDER BY id DESC LIMIT 1`
    ).get() as any;
    expect(activity?.event_type).toBe("error");
    expect(activity?.message).toContain("not verified"); // never claims "verified flat" on a reread that threw
  });

  test("orphan position (no DB trade): close succeeds, reread THROWS -> loud MANUAL RECONCILE error, never 'verified flat'", async () => {
    const am = new AccountManager();
    let closeCalled = false;
    let posCalls = 0;
    const fakeCoinm = {
      isConnected: () => true,
      getEquityUsd: async () => 5_000,
      getOwnedPosition: async () => {
        posCalls++;
        if (posCalls === 1) return { symbol: "BTCUSD_PERP", positionAmt: 0.01, entryPrice: 60_000, markPrice: 60_500, unrealizedProfit: 0, leverage: 2, updateTime: Date.now() };
        throw new Error("ECONNRESET"); // the post-close reread fails — state UNKNOWN, not flat
      },
      closePosition: async () => { closeCalled = true; return { success: true, filledPrice: 60_500, executedQty: 0.01, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "BTC" }; },
      getFilters: async () => ({}),
    } as any;
    am.attachCoinmExecutor(fakeCoinm, { live: true });
    await (am as any).syncBinanceCoinM();
    expect(closeCalled).toBe(true);
    const activity = getDB().prepare(
      `SELECT event_type, message FROM activity_log WHERE account_id = 'momentum_btc' ORDER BY id DESC LIMIT 1`
    ).get() as any;
    expect(activity?.event_type).toBe("error");
    expect(activity?.message).toContain("not verified"); // never claims "verified flat" on a reread that threw
  });
});
