// ══════════════════════════════════════════════
// SYSTEM SMOKE TEST — boot the REAL wiring against fakes + an AGED on-disk DB
//
// The unit tests in this repo each exercise ONE function against a fresh
// in-memory DB. The incidents that actually hurt were CROSS-MODULE and
// data-shaped — none reproducible by a single-function unit test:
//
//   • 4-day silent BrokerSync no-op / 31h scan freeze  → a dead loop emits
//     nothing, so ERROR_BURST can't see it. Only a LIVENESS registry catches it.
//   • "$161k vs $111k" portfolio total                 → sleeve equities
//     double-counted the broker wallet into the sum.
//   • "$111,580 vs $111,353" stale-accounts total      → headline read the
//     deprecated `accounts` table instead of *_main snapshots.
//   • poisoned snapshot anchors (recurred 6×)          → old-semantics rows
//     leaked into first-snapshot / day-P&L anchors.
//   • deflated win-rate (27% shown, 70% real)          → pnl=0 reconcile /
//     backfill / shadow / legacy phantoms counted as losses.
//
// This test assembles as much of the real graph as is possible without a
// network: initDatabase(tmpfile) → seed an aged/scarred prod-shaped DB →
// assert the money-truth layer (src/portfolio/truth.ts) + the liveness layer
// (src/ops/heartbeat.ts) + a real AccountManager boot read those seams
// correctly. Deterministic: temp file DB, injected clock, no setInterval, no
// network.
//
// SEAM NOTE (handed to orchestrator): AccountManager's constructor HARD-WIRES
// `new OrderExecutor()` (→ AlpacaExecutor + BinanceExecutor); there is no
// executor-injection seam. Construction is network-free (both executor
// constructors only store config; network lives in their `init()`, which we
// never call), so we boot the real object and assert its DB-derived views.
// To fake broker RESPONSES for a fuller boot (start()/sync loops), the class
// would need an injectable executor — a one-line constructor param.
// ══════════════════════════════════════════════

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  initDatabase, getDB, saveEquitySnapshot, saveAccount,
  getTradingStats, getETDayStart, EQUITY_SEMANTICS,
} from "../db/database";
import {
  getPortfolioEquityNow, getSleeveEquityNow,
  reconcilePortfolioInvariants, setBrokerTruthAvailable,
} from "../portfolio/truth";
import { RISK_PROFILES, ALL_PROFILE_IDS } from "../config/riskProfiles";
import { HeartbeatRegistry, type HeartbeatStatus } from "../ops/heartbeat";
import { eventBus, EVENTS } from "../utils/events";

// ── Seed scenario (single source for every assert below) ─────────────────
// Broker wallets carry pre-v8 P&L history the sleeve ledgers deliberately
// don't; that constant offset is the "legacy gap" the invariant checker knows.
const SEED = {
  // *_main broker-truth series (start anchor + latest)
  alpacaMainStart: 110_000, alpacaMainNow: 111_000,
  binanceMainStart: 5_000, binanceMainNow: 5_500,
  // latest per-sleeve equity = allocation + realized (unrealized left at 0)
  sleeveNow: { momentum_stocks: 52_000, meanrev_stocks: 49_000, momentum_crypto: 5_500 },
  // realized PnL per sleeve = Σ its closed non-reconcile trades
  realized: { momentum_stocks: 2_000, meanrev_stocks: -1_000, momentum_crypto: 500 },
} as const;

// Derived expectations (computed, not hand-typed, so they can't drift).
const BROKER_TOTAL_NOW = SEED.alpacaMainNow + SEED.binanceMainNow;          // 116_500
const SLEEVE_SUM = Object.values(SEED.sleeveNow).reduce((a, b) => a + b, 0); // 106_500
// Scoped to the sleeves this fixture actually seeds (SEED.sleeveNow's keys).
// momentum_crypto_usdc/momentum_btc (2026-07-19, own wallets, no seeded
// snapshots here) must NOT inflate this — they have their own coverage in
// src/account/coinmUsdcSleeves.test.ts.
const ALLOCS = (Object.keys(SEED.sleeveNow) as (keyof typeof SEED.sleeveNow)[])
  .reduce((s, id) => s + RISK_PROFILES[id].initialEquity, 0); // 105_000
const REALIZED_SUM = Object.values(SEED.realized).reduce((a, b) => a + b, 0); // 1_500

let tmpDir: string;
let NOW = 0, PREV = 0;

let tradeSeq = 0;
/** Raw closed/open trade insert — full control over pnl + close_reason + status. */
function seedTrade(
  accountId: string,
  opts: { pnl?: number; closeReason?: string | null; status?: "open" | "closed"; entryPrice?: number; qty?: number } = {},
) {
  const status = opts.status ?? "closed";
  const entryPrice = opts.entryPrice ?? 100;
  const qty = opts.qty ?? 1;
  const pnl = status === "closed" ? (opts.pnl ?? 0) : null;
  const exitPrice = status === "closed" ? entryPrice + (opts.pnl ?? 0) / qty : null;
  const exitTime = status === "closed" ? NOW - 3_600_000 : null;
  const pnlPct = pnl != null && entryPrice * qty > 0 ? (pnl / (entryPrice * qty)) * 100 : null;
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, exit_price, quantity,
       pnl, pnl_pct, entry_time, exit_time, status, account_id, close_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `smoke_${accountId}_${tradeSeq++}`, "TEST/USD", "crypto", "buy", "MOMENTUM_TSM",
    entryPrice, exitPrice, qty, pnl, pnlPct,
    NOW - 7_200_000, exitTime, status, accountId, opts.closeReason ?? null,
  );
}

/** Old-era / null-semantics snapshot — the poison an anchor MUST ignore. */
function poisonSnap(profileId: string, equity: number, at: number, semantics: number | null) {
  getDB().prepare(
    `INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time, semantics)
     VALUES (?,?,?,?,?,?)`,
  ).run(profileId, equity, equity, 0, at, semantics);
}

beforeAll(() => {
  // On-disk temp DB (the point: WAL, real file, real schema via initDatabase).
  tmpDir = mkdtempSync(join(tmpdir(), "uncle-carl-smoke-"));
  initDatabase(join(tmpDir, "trading.db"));
  setBrokerTruthAvailable("alpaca", true);
  setBrokerTruthAvailable("binance", true);

  NOW = Date.now();
  PREV = getETDayStart(NOW - 86_400_000);

  // ── broker-truth *_main series across two ET days ──
  saveEquitySnapshot("alpaca_main", SEED.alpacaMainStart, SEED.alpacaMainStart, 0, PREV + 1_000);
  saveEquitySnapshot("alpaca_main", SEED.alpacaMainNow, SEED.alpacaMainNow, 0, NOW - 1_000);
  saveEquitySnapshot("binance_main", SEED.binanceMainStart, SEED.binanceMainStart, 0, PREV + 1_000);
  saveEquitySnapshot("binance_main", SEED.binanceMainNow, SEED.binanceMainNow, 0, NOW - 1_000);
  // Poisoned anchor: an OLD-era row that is NEWER than the real latest (by time).
  // If the semantics filter regresses, getPortfolioEquityNow() returns $999,999.
  poisonSnap("alpaca_main", 999_999, NOW - 500, EQUITY_SEMANTICS - 1);

  // ── per-sleeve ledger snapshots (two ET days) ──
  for (const [id, eq] of Object.entries(SEED.sleeveNow)) {
    saveEquitySnapshot(id, eq, eq, 0, PREV + 2_000);
    saveEquitySnapshot(id, eq, eq, 0, NOW - 1_000);
  }

  // ── closed trades → realized PnL that MUST reconcile with the snapshots ──
  seedTrade("momentum_stocks", { pnl: 2_500 });   // win
  seedTrade("momentum_stocks", { pnl: -500 });    // loss  → realized +2_000
  seedTrade("meanrev_stocks", { pnl: 500 });      // win
  seedTrade("meanrev_stocks", { pnl: -1_500 });   // loss  → realized -1_000
  seedTrade("momentum_crypto", { pnl: 500 });     // win   → realized   +500

  // Open positions on the sleeves (aged DB has live risk). The seeded snapshot
  // does NOT bake their unrealized in, and reconcile is called with unrealized=0,
  // so the ledger check stays exact while still exercising getOpenTrades + tol.
  seedTrade("momentum_stocks", { status: "open", entryPrice: 200, qty: 3 });
  seedTrade("momentum_crypto", { status: "open", entryPrice: 50, qty: 2 });

  // ── phantoms that MUST be invisible to the headline stats ──
  // reconcile-reason rows (pnl=0) on LIVE v8 accounts:
  seedTrade("momentum_stocks", { pnl: 0, closeReason: "BROKER_GONE_404" });
  seedTrade("momentum_crypto", { pnl: 0, closeReason: "MOMENTUM_RECONCILED" });
  seedTrade("meanrev_stocks", { pnl: 0, closeReason: "SYNC_DUP_RECONCILED" });
  // legacy pre-v8 accounts (out of the v8 headline scope):
  seedTrade("alpaca_low", { pnl: 9_999 });
  seedTrade("binance_high", { pnl: -9_999 });
  seedTrade("medium", { pnl: 1_234 });
  // shadow simulated book:
  seedTrade("shadow_meanrev_wide", { pnl: 8_888 });

  // ── accounts table (deprecated equity; EquityTracker.loadAccount reads it) ──
  saveAccount("momentum_stocks", SEED.sleeveNow.momentum_stocks, 30_000, RISK_PROFILES.momentum_stocks.initialEquity, SEED.realized.momentum_stocks);
  saveAccount("meanrev_stocks", SEED.sleeveNow.meanrev_stocks, 30_000, RISK_PROFILES.meanrev_stocks.initialEquity, SEED.realized.meanrev_stocks);
  saveAccount("momentum_crypto", SEED.sleeveNow.momentum_crypto, 5_000, RISK_PROFILES.momentum_crypto.initialEquity, SEED.realized.momentum_crypto);
});

afterAll(() => {
  try { getDB().close(); } catch {}
  // `require` dodges bun-types' fs shim, which omits rmSync from its typings.
  try { require("fs").rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ══════════════════════════════════════════════
// §1 MONEY-TRUTH INVARIANTS (src/portfolio/truth.ts vs the aged DB)
// ══════════════════════════════════════════════
describe("§1 money-truth invariants against an aged, scarred DB", () => {
  test("portfolio equity = latest *_main snapshots, NOT accounts, NOT poison", () => {
    // Maps to: "$111,580 vs $111,353" stale-accounts + poisoned-anchor incidents.
    const now = getPortfolioEquityNow();
    expect(now.alpaca).toBe(SEED.alpacaMainNow);   // 111_000, ignores the $999,999 old-era row
    expect(now.binance).toBe(SEED.binanceMainNow); // 5_500
    expect(now.total).toBe(BROKER_TOTAL_NOW);      // 116_500
  });

  test("Σ sleeve equities has NO double-count (= allocations + v8 realized)", () => {
    // Maps to: the "$161k vs $111k" incident (sleeve sum swallowed the broker wallet).
    const sleeveSum = ALL_PROFILE_IDS.reduce((s, id) => s + (getSleeveEquityNow(id) ?? 0), 0);
    const realizedViaStats = ALL_PROFILE_IDS.reduce((s, id) => s + getTradingStats(id).totalPnl, 0);

    // Semantic invariant: sleeve equity is allocation + its OWN realized PnL.
    expect(sleeveSum).toBeCloseTo(ALLOCS + realizedViaStats, 6);
    // Exact seeded lock: any regression that folds a *_main wallet back into a
    // sleeve reading breaks this (would jump to ~$161k, not stay at $111.5k).
    expect(sleeveSum).toBe(SLEEVE_SUM);            // 106_500
    expect(ALLOCS + REALIZED_SUM).toBe(SLEEVE_SUM);
    // Sleeves sit BELOW the broker total by exactly the legacy gap — never above.
    expect(sleeveSum).toBeLessThan(getPortfolioEquityNow().total!);
  });

  test("getTradingStats (no account) excludes shadow/legacy/reconcile phantoms", () => {
    // Maps to: win-rate deflated to 27% by pnl=0 back-fills counted as losses.
    const stats = getTradingStats();
    expect(stats.closedTrades).toBe(5);    // 2 + 2 + 1 real closes; 3 reconcile rows excluded
    expect(stats.winningTrades).toBe(3);
    expect(stats.winRate).toBe(60);        // 3/5 — NOT 3/8 (37.5%) if phantoms leaked in
    expect(stats.totalPnl).toBe(REALIZED_SUM); // 1_500, excludes legacy ±9_999 / shadow 8_888

    // The phantom/legacy rows DO exist — they're only out of the headline SCOPE,
    // provable by querying that account directly (still applies RECONCILE_CLOSE_SQL).
    expect(getTradingStats("alpaca_low").totalPnl).toBe(9_999);
    expect(getTradingStats("shadow_meanrev_wide").totalPnl).toBe(8_888);
  });

  test("a LARGE-pnl BROKER_SYNC row under *_main is NEVER counted as strategy P&L (April +$2,130 vector)", () => {
    // April 2026: alpaca_low showed +$2,130 that was 99.4% BROKER_SYNC rows —
    // externally-adopted positions, NOT the strategy engine. BrokerSync inserts
    // them under alpaca_main/binance_main, strategy='BROKER_SYNC', id 'sync_*',
    // closed as SYNC_DETECTED. This locks that such a row can NEVER reach a
    // headline strategy stat, no matter how large its price-diff pnl.
    const before = getTradingStats();                       // baseline (5 real closes, +1_500)
    const beforeStocks = getTradingStats("momentum_stocks");

    // The exact April shape: a big-win sync row on the broker-truth account.
    getDB().prepare(
      `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, exit_price, quantity,
         pnl, pnl_pct, entry_time, exit_time, status, account_id, close_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `sync_${Date.now()}_meta`, "META", "stock", "buy", "BROKER_SYNC",
      100, 1086, 1, 986, 986, NOW - 7_200_000, NOW - 3_600_000, "closed", "alpaca_main", "SYNC_DETECTED",
    );

    // Headline (no-account) stats: unchanged — the sync win is out of V8 scope
    // AND excluded by RECONCILE_CLOSE_SQL.
    const after = getTradingStats();
    expect(after.totalPnl).toBe(before.totalPnl);           // still 1_500, not 2_486
    expect(after.closedTrades).toBe(before.closedTrades);   // still 5, not 6
    expect(after.winningTrades).toBe(before.winningTrades); // the +986 win does NOT inflate WR

    // Even a live strategy sleeve query never sees it (wrong account_id).
    const afterStocks = getTradingStats("momentum_stocks");
    expect(afterStocks.totalPnl).toBe(beforeStocks.totalPnl);

    // cleanup: remove the injected row so sibling tests keep their exact counts.
    getDB().prepare(`DELETE FROM trades WHERE strategy = 'BROKER_SYNC' AND symbol = 'META'`).run();
    expect(getTradingStats().closedTrades).toBe(before.closedTrades);
  });

  test("reconcilePortfolioInvariants() is HEALTHY on the consistent seed", () => {
    // unrealized = 0 is valid HERE only because this seed's sleeve snapshots
    // deliberately carry none (see the seed note above). In prod the snapshots
    // DO carry unrealized (broker-mark priced via buildSleevePriceMap), so
    // AccountManager must pass the live per-sleeve unrealized computed with
    // that SAME resolver — locked by src/account/invariantMarketClosed.test.ts
    // (the market-closed false-positive class this call's shape can't catch).
    const report = reconcilePortfolioInvariants();
    const byName = Object.fromEntries(report.checks.map(c => [c.name, c]));
    // Every reconstruction check that RAN must be green. momentum_crypto (sole
    // owner of the Binance wallet) is funding-exempt from reconstruction, so it
    // legitimately has no ledger_ check — only the shared-wallet Alpaca sleeves do.
    const ledgerChecks = report.checks.filter(c => c.name.startsWith("ledger_"));
    expect(ledgerChecks.length).toBeGreaterThan(0);
    for (const c of ledgerChecks) expect(c.ok).toBe(true);
    expect(byName["ledger_momentum_crypto"]).toBeUndefined();
    expect(byName["sleeves_vs_alpaca_main"]?.ok).toBe(true);
    expect(byName["sleeves_vs_binance_main"]?.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  test("reconcilePortfolioInvariants() FAILS on a deliberately double-counted sleeve", () => {
    // Inject the actual bug shape: a current-era snapshot where momentum_stocks
    // grabbed the whole ~$100k Alpaca wallet instead of its $50k sleeve ledger.
    const poison = 102_000;
    saveEquitySnapshot("momentum_stocks", poison, poison, 0, NOW - 400); // newest ≤ now
    expect(getSleeveEquityNow("momentum_stocks")).toBe(poison);

    const bad = reconcilePortfolioInvariants();
    const ledger = bad.checks.find(c => c.name === "ledger_momentum_stocks");
    expect(bad.ok).toBe(false);
    expect(ledger?.ok).toBe(false); // snapshot 102k vs initial+realized 52k → drift 50k

    // Reversible + live: remove the poison and the books agree again.
    getDB().prepare(`DELETE FROM equity_snapshots WHERE profile_id = ? AND equity = ?`).run("momentum_stocks", poison);
    expect(reconcilePortfolioInvariants().ok).toBe(true);
  });
});

// ══════════════════════════════════════════════
// §2 LIVENESS WIRING (src/ops/heartbeat.ts) — the silent-loop-death catcher
// ══════════════════════════════════════════════
describe("§2 heartbeat liveness registry (injected clock, no waits)", () => {
  const byName = (s: HeartbeatStatus[], n: string) => s.find(x => x.name === n)!;

  test("fresh → selective stale detection → recovery re-arm", () => {
    // Maps to: the 4-day BrokerSync no-op + 31h scan freeze that emitted NOTHING.
    let clock = 1_000_000;
    const hb = new HeartbeatRegistry(() => clock);
    hb.register("brokerSync", 30_000); // grace ×2 ⇒ stale after 60s
    hb.register("stopLoss", 15_000);   // grace ×2 ⇒ stale after 30s
    hb.beat("brokerSync");
    hb.beat("stopLoss");

    let snap = hb.snapshot();
    expect(snap.length).toBe(2);
    expect(snap.every(s => !s.stale)).toBe(true); // all fresh

    // Advance 40s: stopLoss (>30s) goes stale; brokerSync (<60s) still fresh.
    clock += 40_000;
    snap = hb.snapshot();
    expect(byName(snap, "stopLoss").stale).toBe(true);
    expect(byName(snap, "brokerSync").stale).toBe(false);

    // check() pages ONLY the dead loop (same ERROR_BURST path TelegramReporter listens on).
    const bursts: string[] = [];
    const handler = (p: any) => bursts.push(p?.context);
    eventBus.on(EVENTS.ERROR_BURST, handler);
    try { hb.check(); } finally { eventBus.removeListener(EVENTS.ERROR_BURST, handler); }
    expect(bursts).toContain("heartbeat:stopLoss");
    expect(bursts).not.toContain("heartbeat:brokerSync");

    // A recovered beat clears staleness (re-arm so a future death pages again).
    hb.beat("stopLoss");
    expect(byName(hb.snapshot(), "stopLoss").stale).toBe(false);
  });
});

// ══════════════════════════════════════════════
// §3 BOOT-CONSTRUCT the real AccountManager against the aged DB (no intervals)
// ══════════════════════════════════════════════
describe("§3 real AccountManager boots & renders coherent shapes", () => {
  test("construct + getConsolidatedState/getAccountSummaries without throwing", () => {
    // Lazy require so a concurrent edit to AccountManager/EquityTracker can't
    // fail this whole file's load — §1/§2 are the highest-value asserts.
    const { AccountManager } = require("../account/AccountManager") as typeof import("../account/AccountManager");

    const am = new AccountManager(); // network-free: executors only store config
    const state = am.getConsolidatedState();
    expect(typeof state.totalEquity).toBe("number");
    expect(Number.isFinite(state.totalEquity)).toBe(true);
    expect(Array.isArray(state.positions)).toBe(true);
    // winRate is derived from the aged DB via getTradingStats — must be sane, not NaN.
    expect(state.winRate).toBeGreaterThanOrEqual(0);
    expect(state.winRate).toBeLessThanOrEqual(100);

    const summaries = am.getAccountSummaries();
    // Registered ≠ active: momentum_crypto_usdc/momentum_btc only join once
    // index.ts attaches a preflight-passed executor (never at bare construction).
    expect(summaries.length).toBe(am.getActiveProfileIds().length);
    expect(summaries.length).toBe(ALL_PROFILE_IDS.length - 2);
    for (const s of summaries) {
      expect(ALL_PROFILE_IDS).toContain(s.id);
      expect(typeof s.equity).toBe("number");
      expect(Number.isFinite(s.equity)).toBe(true);
      expect(typeof s.paused).toBe("boolean");
    }
    // EquityTracker loaded the seeded accounts row → summary equity matches the seed.
    const stocks = summaries.find(s => s.id === "momentum_stocks")!;
    expect(stocks.equity).toBe(SEED.sleeveNow.momentum_stocks);
  });
});

// 2026-07-19: momentum_crypto_usdc / momentum_btc must boot cleanly as part
// of the same graph — attached, synced once, torn down — without throwing
// and without disturbing the pre-existing three sleeves' summaries.
describe("§4 momentum_crypto_usdc + momentum_btc boot, sync, and shut down cleanly", () => {
  test("attach both, run one sync pass each, stop — no throw, correct bucket equity, no cross-contamination", async () => {
    const { AccountManager } = require("../account/AccountManager") as typeof import("../account/AccountManager");
    const am = new AccountManager();

    const fakeUsdc = {
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 5_234.5, marginCash: 5_000, wallet: 5_234.5, unrealizedPnl: 0 }),
      getPositions: async () => [],
      stopUserDataStream: () => {},
    } as any;
    const fakeCoinm = {
      isConnected: () => true,
      getEquityUsd: async () => 1_050.25,
      getOwnedPosition: async () => null,
      shutdown: () => {},
    } as any;

    am.attachUsdcExecutor(fakeUsdc);
    am.attachCoinmExecutor(fakeCoinm);

    // Private sync methods — reach them the same way the rest of this file
    // reaches private internals of the class under test (system-level smoke,
    // not a black-box API test).
    await (am as any).syncBinanceUsdc();
    await (am as any).syncBinanceCoinM();

    const summaries = am.getAccountSummaries();
    const usdc = summaries.find(s => s.id === "momentum_crypto_usdc")!;
    const btc = summaries.find(s => s.id === "momentum_btc")!;
    expect(usdc.equity).toBe(5_234.5);
    expect(btc.equity).toBe(1_050.25);

    // The pre-existing sleeves must be completely unaffected.
    const stocks = summaries.find(s => s.id === "momentum_stocks")!;
    expect(stocks.equity).toBe(SEED.sleeveNow.momentum_stocks);

    const state = am.getConsolidatedState();
    expect(Number.isFinite(state.totalEquity)).toBe(true);

    await expect(am.stop()).resolves.toBeUndefined();
  });
});
