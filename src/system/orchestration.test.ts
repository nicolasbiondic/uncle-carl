// ══════════════════════════════════════════════
// ORCHESTRATION TESTS — composition, not units (2026-08-06)
//
// AUDITS 2026-07-13: "cada incidente real (sumas erróneas, anclas
// envenenadas, congelación de 31h, BrokerSync no-op de 4 días) vivía en la
// ORQUESTACIÓN que los tests nunca ejercitaron". smoke.test.ts boots the
// graph but drives every loop SEQUENTIALLY; the flag-state space
// (TRADING_ENABLED × RISK_ENGINE_STATE × PLAUSIBILITY_MODE × …) had ~5 of
// ≥3456 reachable states covered. This file exercises the missing classes:
//
//   §A  Two-plus loops CONCURRENT over the same row/symbol (reentrancy
//       guards are the only thing standing between the 15s SL loop, the 60s
//       syncs and BrokerSync's 30s pass — revert any guard and these fail).
//   §B  TRADING_ENABLED=false COMPOSED (engine→adapter→broker chain +
//       AccountManager close/stop/reconcile machinery — the kill-switch
//       must block ONLY opens; src/index.ts:213-218 contract).
//   §C  RISK_ENGINE_STATE=HALTED + TRADING_ENABLED=false SIMULTANEOUS —
//       two independent kill-switches must never compose into "can't exit".
//   §D  PLAUSIBILITY_MODE=enforce with a systematically-implausible feed —
//       the 15s loop stops evaluating entirely (only the native GTC stop
//       remains); that degradation must page (aggregated) and must NOT
//       close anything on garbage.
//   §E  The daily portfolio invariant with the CRYPTO price feed dead —
//       the sibling of src/account/invariantMarketClosed.test.ts (which
//       covers the Alpaca market-closed case; NOT duplicated here).
//   §F  Cold boot against dirty state (broker orphan + DB orphan + stale
//       native stop) — converges without closing anything by mistake.
//
// Every test states its revert-falsifier: the specific protection whose
// removal makes it fail.
// ══════════════════════════════════════════════

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDB } from "../db/database";
import { getLastInvariantReport, setBrokerTruthAvailable } from "../portfolio/truth";
import { LEDGER_SLEEVE_BROKERS, RISK_PROFILES } from "../config/riskProfiles";
import { EVENTS } from "../utils/events";
import { makeTestDb, seedOpenTrade } from "../test-support/db";
import { captureBursts, captureEvent } from "../test-support/events";
import { makeAccountManager } from "../test-support/account";
import { FakeBroker, ramp, silentLogger } from "../test-support/momentum";
import { MomentumEngine } from "../strategies/momentum/MomentumEngine";
import { SwitchingAdapter } from "../governor/SwitchingAdapter";
import { RiskEngine, type RiskEngineState } from "../risk/RiskEngine";
import { BrokerSync } from "../sync/BrokerSync";
import type { BrokerSyncSource } from "../sync/brokerSyncSource";
import { UNRECONCILED_CLOSE_AFTER } from "../account/BinanceSleeveReconciler";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Freeze Date at a US-market-open instant (Fri 2026-07-24 10:00 ET) —
 *  checkAllStopLoss skips stock closes while the market is closed. Console
 *  is captured to keep the suite output readable. Same idiom as
 *  accountManager.test.ts (local there; test files can't import each other). */
async function withMarketOpen<T>(fn: () => Promise<T>): Promise<T> {
  const realDate = Date;
  const openNow = realDate.parse("2026-07-24T14:00:00.000Z");
  globalThis.Date = class extends realDate {
    constructor(...args: any[]) { super(args.length ? args[0] : openNow); }
    static now() { return openNow; }
  } as DateConstructor;
  const realLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    globalThis.Date = realDate;
  }
}

/** Save/restore an env var around a test body (restores deletion too). */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function memRiskPersistence() {
  let saved: RiskEngineState | null = null;
  return { load: () => saved, save: (s: RiskEngineState) => { saved = s; } };
}

/** A market-hours-complete fake Alpaca executor for AccountManager: every
 *  seam syncAlpacaAccount/checkAllStopLoss/ensureAlpacaNativeStops touch.
 *  Pass overrides for what the scenario distinguishes. */
function fakeAlpaca(overrides: Record<string, any> = {}) {
  return {
    isConnected: () => true,
    getAccount: async () => ({ equity: "100000", cash: "50000" }),
    getCachedPrice: () => 0,
    getLatestPrice: async () => 0,
    getRiskPrice: async () => 0,
    getPositions: async () => [],
    getOpenStopOrders: async () => [],
    cancelOrderById: async () => true,
    getOrderStateByClientId: async () => null,
    getOrderById: async () => null,
    invalidateCandleCache: () => {},
    placeStopLossOrder: async () => ({ ok: true, orderId: "stop-x" }),
    closePosition: async () => ({ success: false, reason: "not_stubbed" }),
    startRealTimeStream: async () => {},
    ...overrides,
  };
}

/** Minimal connected BrokerSyncSource for the Alpaca side. */
function alpacaSyncSource(positions: () => Array<{ symbol: string; side: "buy" | "sell"; quantity: number; entryPrice: number }>): BrokerSyncSource {
  return {
    id: "alpaca_paper",
    name: "Alpaca Paper",
    status: "connected",
    getAccount: async () => ({ totalEquity: 100_000, availableCash: 50_000 }),
    getOpenPositions: async () => positions(),
  };
}

beforeAll(() => { makeTestDb(); });
beforeEach(() => {
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM equity_snapshots; DELETE FROM sync_state;");
  setBrokerTruthAvailable("alpaca", false);
  setBrokerTruthAvailable("binance", false);
  setBrokerTruthAvailable("coinm", false);
});
afterEach(() => {
  // Belt-and-braces: no test may leak a kill-switch into the rest of the suite
  // (test-setup.ts guarantees the default is "deleted" for all three).
  delete process.env.TRADING_ENABLED;
  delete process.env.RISK_ENGINE_STATE;
  delete process.env.PLAUSIBILITY_MODE;
});

// ══════════════════════════════════════════════
// §A — CONCURRENT LOOPS OVER THE SAME RESOURCE
// ══════════════════════════════════════════════
describe("§A concurrent loops over the same row (reentrancy guards are load-bearing)", () => {
  // Revert-falsifier: remove the `checkingStopLoss` guard in checkAllStopLoss
  // → the second in-flight pass re-reads the still-open row, re-breaches the
  // stop and issues a SECOND broker close → closeCalls becomes 2 and the
  // POSITION_CLOSED count doubles. (Verified by inspection: the guard is the
  // ONLY thing between the two passes — the row only closes after the slow
  // broker close resolves.)
  test("two overlapping 15s SL passes → exactly ONE broker close, row closed once", async () => {
    seedOpenTrade("orch-a1-btc", "momentum_crypto", { symbol: "BTC/USD", market: "crypto" });
    let closeCalls = 0;
    const manager = makeAccountManager({
      binance: {
        isConnected: () => true,
        getPrice: async () => { await sleep(2); return 95; }, // −5% ≤ −4% stop
        closePosition: async () => {
          await sleep(30); // slow broker close — the overlap window
          closeCalls++;
          return { success: true, filledPrice: 95, commission: 0, realizedPnl: -5 };
        },
      },
    });
    const closed = captureEvent(EVENTS.POSITION_CLOSED);
    try {
      // Fire both WITHOUT awaiting the first — a genuine overlap.
      await Promise.all([
        (manager as any).checkAllStopLoss(),
        (manager as any).checkAllStopLoss(),
      ]);
      // A third, sequential pass after the close must be a no-op.
      await (manager as any).checkAllStopLoss();
    } finally {
      closed.detach();
    }

    expect(closeCalls).toBe(1);
    expect(closed.events.filter(e => e.accountId === "momentum_crypto").length).toBe(1);
    const rows = getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'orch-a1-btc'").all() as any[];
    expect(rows).toEqual([{ status: "closed", close_reason: "STOP_LOSS" }]);
  });

  // Revert-falsifiers, one per invariant:
  //  - `checkingStopLoss` / `syncingAlpaca` guards → duplicate close /
  //    duplicate getAccount work.
  //  - BrokerSync's sleeveOwnsSymbol adoption skip → a competing sync_ row
  //    appears for SPY (row count becomes 2).
  //  - the end-of-pass counter prunes → unavailablePriceMisses /
  //    deferredCloseCounts survive the close and leak.
  test("15s SL close in flight + 60s Alpaca sync + 30s BrokerSync over the SAME symbol → one close, one row, no competing sync_ row, ≤1 native stop, counters clean", async () => {
    seedOpenTrade("orch-a2-spy", "momentum_stocks", { symbol: "SPY", entryPrice: 100, quantity: 5 });
    let closeCalls = 0;
    let getAccountCalls = 0;
    let spyOnBroker = true;
    const placedStops: any[] = [];
    const brokerPositions = () => spyOnBroker
      ? [{ symbol: "SPY", market: "stock" as const, side: "buy" as const, quantity: 5, avgEntryPrice: 100, currentPrice: 90, unrealizedPnl: -50, unrealizedPnlPct: -10, openedAt: Date.now() }]
      : [];
    const alpaca = fakeAlpaca({
      getAccount: async () => { getAccountCalls++; return { equity: "100000", cash: "50000" }; },
      getRiskPrice: async () => 90, // −10% ≤ −4% stop
      getPositions: async () => brokerPositions(),
      placeStopLossOrder: async (p: any) => { placedStops.push(p); return { ok: true, orderId: `stop-${placedStops.length}` }; },
      closePosition: async () => {
        await sleep(40); // the overlap window: sync + BrokerSync land inside it
        closeCalls++;
        spyOnBroker = false; // broker flat once the close fills
        return { success: true, filledPrice: 90, commission: 0 };
      },
    });
    const manager = makeAccountManager({ alpaca });
    const brokerSync = new BrokerSync([
      alpacaSyncSource(() => brokerPositions().map(p => ({ symbol: p.symbol, side: p.side, quantity: p.quantity, entryPrice: p.avgEntryPrice }))),
    ]);

    await withMarketOpen(() => Promise.all([
      (manager as any).checkAllStopLoss(),
      (manager as any).syncAlpacaAccount(),
      (manager as any).syncAlpacaAccount(), // second sync must bail (syncingAlpaca guard)
      brokerSync.syncAll(),
      brokerSync.syncAll(),                 // second sweep must bail (syncing guard)
    ]));

    expect(closeCalls).toBe(1);
    expect(getAccountCalls).toBe(1); // reentrancy guard: one effective sync
    // Exactly ONE row for SPY ever — no sync_ duplicate, no re-adoption.
    const rows = getDB().prepare("SELECT id, status, close_reason FROM trades WHERE symbol = 'SPY'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ id: "orch-a2-spy", status: "closed", close_reason: "STOP_LOSS" });
    // The native-stop layer may have armed the (still-open-at-that-moment)
    // row once — but never twice.
    expect(placedStops.length).toBeLessThanOrEqual(1);

    // Shared counters self-prune once the row is gone (next completed pass).
    await withMarketOpen(() => (manager as any).checkAllStopLoss());
    expect((manager as any).unavailablePriceMisses.size).toBe(0);
    expect((manager as any).deferredCloseCounts.size).toBe(0);
  });

  // Revert-falsifier: remove the `syncingBinance` guard → each concurrent
  // pair bumps the UnreconciledGrace counter TWICE per wall-clock cycle, so
  // the flat-row close fires after ~3 pairs instead of 5 effective passes —
  // the "row still open after 4 pairs" assertion fails. (A corrupted
  // beginPass/endPass interleave that RESETS the counter instead fails the
  // second assertion — the row never closes on the 5th pass.)
  test(`overlapping Binance syncs never corrupt UnreconciledGrace: flat row closes after exactly ${UNRECONCILED_CLOSE_AFTER} EFFECTIVE passes, not per invocation`, async () => {
    seedOpenTrade("orch-a3-btc", "momentum_crypto", { symbol: "BTC/USD", market: "crypto", strategy: "MOMENTUM_TSM" });
    const manager = makeAccountManager({
      binance: {
        isConnected: () => true,
        getBalance: async () => ({ marginEquity: 5_000, marginCash: 5_000, wallet: 5_000, unrealizedPnl: 0 }),
        getAccountTotal: async () => ({ equity: 5_000, cash: 5_000 }),
        getPositions: async () => { await sleep(10); return []; }, // broker flat; slow → real overlap window
        getRecentTrades: async () => [],  // no attributable closing fills
        hasFilledStopClose: async () => false,
      },
    });

    // 4 wall-clock cycles, each firing TWO overlapping syncs (like a slow 60s
    // pass overrunning into the next tick). Only 4 EFFECTIVE passes may count.
    for (let i = 0; i < UNRECONCILED_CLOSE_AFTER - 1; i++) {
      await Promise.all([
        (manager as any).syncBinanceFutures(),
        (manager as any).syncBinanceFutures(),
      ]);
    }
    expect(getDB().prepare("SELECT status FROM trades WHERE id = 'orch-a3-btc'").get()).toEqual({ status: "open" });

    // The 5th effective pass crosses the grace and closes UNRECONCILED at entry.
    await (manager as any).syncBinanceFutures();
    expect(getDB().prepare("SELECT status, close_reason, pnl FROM trades WHERE id = 'orch-a3-btc'").get()).toEqual({
      status: "closed", close_reason: "MANUAL_CLOSE_UNRECONCILED", pnl: 0,
    });
  });
});

// ══════════════════════════════════════════════
// §B — TRADING_ENABLED=false IN COMPOSITION
// ══════════════════════════════════════════════
describe("§B TRADING_ENABLED=false composed: blocks ONLY opens (index.ts:213-218 contract)", () => {
  // Revert-falsifiers, by direction:
  //  - remove BOTH the MomentumEngine entry gate AND the SwitchingAdapter
  //    backstop → real.opened gains UP / the direct openPosition succeeds.
  //  - (the catastrophic direction) extend the kill-switch to closes →
  //    real.closed loses LOSER.
  test("real MomentumEngine→SwitchingAdapter chain: tick opens NOTHING but still closes; adapter backstop blocks a direct open", async () => {
    await withEnv({ TRADING_ENABLED: "false" }, async () => {
      const real = new FakeBroker();
      const shadow = new FakeBroker();
      real.setCandles("UP", ramp(100, 130));     // strong gainer → would open
      real.setCandles("LOSER", ramp(100, 80));   // held loser → must close
      real.positions = [{ symbol: "LOSER", side: "buy", quantity: 1, notional: 3000 }];
      seedOpenTrade("orch-b1-loser", "orch_b1_live", { symbol: "LOSER" }); // live DB row → close routes to REAL broker
      const adapter = new SwitchingAdapter(
        "orch_b1", { getMode: () => "live" }, real, shadow, "orch_b1_live",
        new RiskEngine({}, memRiskPersistence()),
      );
      const engine = new MomentumEngine(
        { universe: ["UP", "LOSER"], notionalPctPerSlot: 0.3, scorer: { topLongs: 1, minLongScore: 0.001 } },
        adapter, silentLogger,
      );

      const report = await engine.tick();
      expect(report.blockedReason ?? "").toContain("TRADING_ENABLED=false");
      expect(real.opened).toEqual([]);   // no real open reached the broker
      expect(shadow.opened).toEqual([]); // and none was silently re-routed to shadow
      expect(real.closed.map(a => a.symbol)).toEqual(["LOSER"]); // closes stay fully active

      // Defense in depth: even a path that bypasses the engine gate is
      // stopped at the adapter, with the documented reason code.
      const denied = await adapter.openPosition({ symbol: "UP", side: "buy", notionalUsd: 1000 });
      expect(denied).toEqual({ ok: false, reason: "trading_disabled" });
      expect(real.opened).toEqual([]);
    });

    // Self-falsifying control: with the switch back at its default the SAME
    // chain opens — proving the block above was the flag, not the fixture.
    const real2 = new FakeBroker();
    real2.setCandles("UP", ramp(100, 130));
    const adapter2 = new SwitchingAdapter(
      "orch_b1b", { getMode: () => "live" }, real2, new FakeBroker(), "orch_b1b_live",
      new RiskEngine({}, memRiskPersistence()),
    );
    const engine2 = new MomentumEngine(
      { universe: ["UP"], notionalPctPerSlot: 0.3, scorer: { topLongs: 1, minLongScore: 0.001 } },
      adapter2, silentLogger,
    );
    await engine2.tick();
    expect(real2.opened.map(a => a.symbol)).toEqual(["UP"]);
  });

  // Revert-falsifier: wire isTradingEnabled() into checkAllStopLoss /
  // closeTradeDirectly / ensureAlpacaNativeStops / BrokerSync (the plausible
  // wrong refactor: "trading is disabled, skip broker work") → the stop
  // close, the stop placement or the sync_ reconcile below stops happening.
  test("AccountManager stop-loss close, native-stop arming and BrokerSync reconciliation ALL still run with the kill-switch on", async () => {
    await withEnv({ TRADING_ENABLED: "false" }, async () => {
      seedOpenTrade("orch-b2-aapl", "momentum_stocks", { symbol: "AAPL", entryPrice: 100, quantity: 1 });
      seedOpenTrade("orch-b2-jnj", "meanrev_stocks", { symbol: "JNJ", strategy: "MEANREV", entryPrice: 100, quantity: 1 });
      // sync-owned orphan row (BrokerSync's to reconcile), broker flat:
      getDB().prepare(
        `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity, entry_time, status, account_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run("sync_1000_orchb2", "FOO", "stock", "buy", "BROKER_SYNC", 10, 1, Date.now() - 60_000, "open", "alpaca_main");

      let aaplOnBroker = true;
      const placedStops: any[] = [];
      let closeCalls = 0;
      const brokerBook = () => [
        ...(aaplOnBroker ? [{ symbol: "AAPL", market: "stock" as const, side: "buy" as const, quantity: 1, avgEntryPrice: 100, currentPrice: 90, unrealizedPnl: -10, unrealizedPnlPct: -10, openedAt: Date.now() }] : []),
        { symbol: "JNJ", market: "stock" as const, side: "buy" as const, quantity: 1, avgEntryPrice: 100, currentPrice: 100, unrealizedPnl: 0, unrealizedPnlPct: 0, openedAt: Date.now() },
      ];
      const manager = makeAccountManager({
        alpaca: fakeAlpaca({
          getRiskPrice: async (s: string) => (s === "AAPL" ? 90 : 100), // AAPL breaches, JNJ healthy
          getPositions: async () => brokerBook(),
          placeStopLossOrder: async (p: any) => { placedStops.push(p); return { ok: true, orderId: `stop-${placedStops.length}` }; },
          closePosition: async () => { closeCalls++; aaplOnBroker = false; return { success: true, filledPrice: 90, commission: 0 }; },
        }),
      });
      const brokerSync = new BrokerSync([
        alpacaSyncSource(() => brokerBook().map(p => ({ symbol: p.symbol, side: p.side, quantity: p.quantity, entryPrice: p.avgEntryPrice }))),
      ]);

      await withMarketOpen(async () => {
        await (manager as any).syncAlpacaAccount(); // arms native stops for both open rows
        await (manager as any).checkAllStopLoss();  // closes AAPL at the broker
        await brokerSync.syncAll();                 // reconciles the sync_ orphan
      });

      expect(closeCalls).toBe(1); // the close REACHED the broker despite the switch
      expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'orch-b2-aapl'").get()).toEqual({
        status: "closed", close_reason: "STOP_LOSS",
      });
      expect(placedStops.map(p => p.symbol).sort()).toEqual(["AAPL", "JNJ"]); // stop arming untouched
      expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'sync_1000_orchb2'").get()).toEqual({
        status: "closed", close_reason: "SYNC_DETECTED",
      });
      // The healthy bot-managed row is untouched by all three loops.
      expect(getDB().prepare("SELECT status FROM trades WHERE id = 'orch-b2-jnj'").get()).toEqual({ status: "open" });
    });
  });
});

// ══════════════════════════════════════════════
// §C — BOTH KILL-SWITCHES AT ONCE
// ══════════════════════════════════════════════
describe("§C RISK_ENGINE_STATE=HALTED + TRADING_ENABLED=false simultaneously: exits still work", () => {
  // Revert-falsifier: route SwitchingAdapter.closePosition through
  // riskEngine.evaluateSubmit (the tempting "consistency" refactor its
  // docstring forbids) → HALTED denies the exit and this fails. Also fails
  // if the env override stops being read fresh, or if either switch starts
  // masking the other's denial ordering.
  test("opens denied (risk veto first), closes reach the broker, SL loop still liquidates a breach", async () => {
    await withEnv({ TRADING_ENABLED: "false", RISK_ENGINE_STATE: "HALTED" }, async () => {
      const real = new FakeBroker();
      const risk = new RiskEngine({}, memRiskPersistence()); // persisted ACTIVE — env override must win
      expect(risk.getState().tradingState).toBe("HALTED");   // read fresh, no caching
      const adapter = new SwitchingAdapter(
        "orch_c1", { getMode: () => "live" }, real, new FakeBroker(), "orch_c1_live", risk,
      );

      // Open: denied by the RISK veto (which runs BEFORE the TRADING_ENABLED
      // backstop — locking the documented gate order).
      const denied = await adapter.openPosition({ symbol: "SPY", side: "buy", notionalUsd: 1000 });
      expect(denied).toEqual({ ok: false, reason: "TRADING_STATE_HALTED" });
      expect(real.opened).toEqual([]);

      // Close: NEVER passes through the veto, and the maintenance switch
      // doesn't apply to closes — the real broker must be reached.
      seedOpenTrade("orch-c1-spy", "orch_c1_live", { symbol: "SPY" });
      const closedRes = await adapter.closePosition({ symbol: "SPY", side: "buy" });
      expect(closedRes.ok).toBe(true);
      expect(real.closed.map(a => a.symbol)).toEqual(["SPY"]);

      // And the 15s protective loop still gets OUT of a losing position
      // while both switches are on — the catastrophic failure would be a
      // risk limit blocking an exit.
      seedOpenTrade("orch-c1-btc", "momentum_crypto", { symbol: "BTC/USD", market: "crypto" });
      let closeCalls = 0;
      const manager = makeAccountManager({
        binance: {
          isConnected: () => true,
          getPrice: async () => 95,
          closePosition: async () => { closeCalls++; return { success: true, filledPrice: 95, commission: 0, realizedPnl: -5 }; },
        },
      });
      await (manager as any).checkAllStopLoss();
      expect(closeCalls).toBe(1);
      expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'orch-c1-btc'").get()).toEqual({
        status: "closed", close_reason: "STOP_LOSS",
      });
    });
  });
});

// ══════════════════════════════════════════════
// §D — PLAUSIBILITY_MODE=enforce WITH A DEGRADED FEED
// ══════════════════════════════════════════════
describe("§D enforce mode + systematically implausible feed: SL loop goes blind LOUDLY, never closes on garbage", () => {
  // The feed returns entry/20 — implausible (×20 ≥ ×10 ref band) but, if it
  // flowed, a −95% "loss" that would trigger the stop instantly. In enforce
  // mode AccountManager:641-648 converts the verdict into a price MISS: no
  // evaluation, no close, and the sustained-miss escalation pages once.
  //
  // Revert-falsifiers:
  //  - drop the enforce branch (garbage flows on) → closePosition fires on
  //    pass 1 → `closeCalls === 0` fails.
  //  - drop the miss-counting/aggregated alert → no ERROR_BURST → the
  //    exactly-one-page assertion fails.
  test("8 blind passes: zero closes, row stays open, exactly ONE aggregated ERROR_BURST", async () => {
    await withEnv({ PLAUSIBILITY_MODE: "enforce" }, async () => {
      seedOpenTrade("orch-d1-aapl", "momentum_stocks", { symbol: "AAPL", entryPrice: 100, quantity: 1 });
      let closeCalls = 0;
      const manager = makeAccountManager({
        alpaca: fakeAlpaca({
          getRiskPrice: async () => 5, // garbage read: ×20 off our own entry fill
          closePosition: async () => { closeCalls++; return { success: true, filledPrice: 5, commission: 0 }; },
        }),
      });
      const { bursts, detach } = captureBursts("AccountManager");
      try {
        await withMarketOpen(async () => {
          for (let i = 0; i < 8; i++) await (manager as any).checkAllStopLoss();
        });
      } finally {
        detach();
      }

      expect(closeCalls).toBe(0); // the garbage price NEVER produced a close
      expect(getDB().prepare("SELECT status FROM trades WHERE id = 'orch-d1-aapl'").get()).toEqual({ status: "open" });
      // Escalation: ≥5 consecutive misses → ONE aggregated page (cooldown
      // holds across the remaining passes), naming the blind symbol.
      const priceBursts = bursts.filter(b => String(b.message).includes("SL price unavailable"));
      expect(priceBursts.length).toBe(1);
      expect(priceBursts[0].message).toContain("AAPL");
    });
  });

  // The CONTRAST that makes the test above non-vacuous — and documents why
  // enforce matters: in observe (the current production default, plausibility
  // .ts: "nothing blocked"), the exact same feed liquidates the position at
  // the garbage price (the 2026-07-27 UNH near-incident class).
  test("observe mode (default): the SAME feed closes the position at the garbage price", async () => {
    await withEnv({ PLAUSIBILITY_MODE: undefined }, async () => {
      seedOpenTrade("orch-d2-aapl", "momentum_stocks", { symbol: "AAPL", entryPrice: 100, quantity: 1 });
      let closeCalls = 0;
      const manager = makeAccountManager({
        alpaca: fakeAlpaca({
          getRiskPrice: async () => 5,
          closePosition: async () => { closeCalls++; return { success: true, filledPrice: 5, commission: 0 }; },
        }),
      });
      await withMarketOpen(() => (manager as any).checkAllStopLoss());

      expect(closeCalls).toBe(1);
      expect(getDB().prepare("SELECT status, close_reason, exit_price FROM trades WHERE id = 'orch-d2-aapl'").get()).toEqual({
        status: "closed", close_reason: "STOP_LOSS", exit_price: 5,
      });
    });
  });
});

// ══════════════════════════════════════════════
// §E — DAILY INVARIANT WITH THE CRYPTO FEED DEAD
// (sibling of src/account/invariantMarketClosed.test.ts, which covers the
//  Alpaca market-closed resolver split — NOT duplicated here)
// ══════════════════════════════════════════════
describe("§E daily invariant while the Binance price fetch fails (the documented crypto KNOWN GAP)", () => {
  // AccountManager ~:952 documents the gap: a swallowed Binance getPrice
  // leaves crypto positions entry-pinned (unrealized ≡ 0) for the pass —
  // display-only, BECAUSE (a) the sleeve's snapshot equity comes from broker
  // getBalance truth (which already contains the unrealized), and (b) the
  // ledger reconstruction is scoped to LEDGER_SLEEVE_BROKERS (Alpaca only).
  // This test pins BOTH halves of that safety argument.
  //
  // Revert-falsifiers:
  //  - naively add "binance" to LEDGER_SLEEVE_BROKERS (the tempting "close
  //    the crypto gap" change): ledger_momentum_crypto would compare the
  //    $5,500 broker-truth snapshot against initial+realized+0 = $5,000 →
  //    drift $500 > tol → report.ok flips false → the structural guard
  //    assertion here fails FIRST, by design (today's P0 was exactly this
  //    class on the Alpaca side).
  //  - snapshot momentum_crypto from position math instead of broker truth →
  //    the $5,500 snapshot assertion fails.
  test("full 60s-sync → 5-min sequence: sleeve snapshot = broker truth, invariant clean, degradation stays display-only", async () => {
    seedOpenTrade("orch-e1-btc", "momentum_crypto", {
      symbol: "BTC/USD", market: "crypto", strategy: "MOMENTUM_TSM", entryPrice: 100, quantity: 2,
    });
    const manager = makeAccountManager({
      alpaca: { isConnected: () => false }, // alpaca side dark: its truth simply stays unavailable
      binance: {
        isConnected: () => true,
        // Broker truth CARRIES the +$500 unrealized — margin equity is marked.
        getBalance: async () => ({ marginEquity: 5_500, marginCash: 5_000, wallet: 5_000, unrealizedPnl: 500 }),
        getAccountTotal: async () => ({ equity: 5_500, cash: 5_000 }),
        // Broker still HOLDS the position (reconciler matches, closes nothing)…
        getPositions: async () => [{ symbol: "BTCUSDT", positionAmt: 2, entryPrice: 100, unrealizedProfit: 500, updateTime: Date.now() }],
        getRecentTrades: async () => [],
        hasFilledStopClose: async () => false,
        // …but every PRICE read fails — the degraded-feed scenario.
        getPrice: async () => { throw new Error("simulated feed outage"); },
      },
    });

    // The exact prod sequence: 60s syncs cache truth, then the 5-min loop.
    await (manager as any).syncAlpacaAccount();
    await (manager as any).syncBinanceFutures();
    await (manager as any).refreshBinanceAccountTotal();
    for (let i = 0; i < 50 && (manager as any).binanceMainTruth == null; i++) await sleep(2); // drain the fire-and-forget refresh
    await manager.updateAllStates();
    (manager as any).writeAllSnapshots();
    (manager as any).runDailyInvariantCheck();

    // Nothing was closed by the feed outage.
    expect(getDB().prepare("SELECT status FROM trades WHERE id = 'orch-e1-btc'").get()).toEqual({ status: "open" });

    // (gap, documented) the DISPLAY position is entry-pinned this pass…
    const pos = manager.getAccount("momentum_crypto").state.positions.find(p => p.symbol === "BTC/USD")!;
    expect(pos.currentPrice).toBe(100);
    expect(pos.unrealizedPnl).toBe(0);

    // …but the MONEY paths are broker-truth: the sleeve snapshot carries the
    // unrealized because it comes from getBalance, not from position math.
    const snap = getDB().prepare(
      "SELECT equity FROM equity_snapshots WHERE profile_id = 'momentum_crypto' ORDER BY snapshot_time DESC LIMIT 1",
    ).get() as { equity: number };
    expect(snap.equity).toBe(5_500);
    expect(RISK_PROFILES.momentum_crypto.initialEquity).toBe(5_000); // i.e. snapshot ≠ initial+0

    // The invariant ran, is clean, and — structurally — momentum_crypto has
    // NO ledger reconstruction check (that scoping is what makes the gap
    // benign; see the falsifier note above).
    const report = getLastInvariantReport()!;
    expect(report.ok).toBe(true);
    expect(report.checks.some(c => c.name === "ledger_momentum_crypto")).toBe(false);
    expect(LEDGER_SLEEVE_BROKERS.has("binance" as any)).toBe(false);
    // The binance wallet check DID run against the cached *_main truth.
    expect(report.checks.some(c => c.name === "sleeves_vs_binance_main" && c.ok)).toBe(true);
  });
});

// ══════════════════════════════════════════════
// §F — COLD BOOT AGAINST DIRTY STATE
// ══════════════════════════════════════════════
describe("§F cold start with dirty state: broker orphan + DB orphan + stale native stop converge, nothing closed by mistake", () => {
  // Scenario (all three dirt classes at once, loops interleaved like boot):
  //   • Alpaca holds 5 SPY with NO DB row       → momentum_stocks must adopt
  //     it after the 3-cycle grace (never before), and NOBODY may close it.
  //   • DB holds an open bot-managed JNJ row the broker doesn't have
  //     → neither BrokerSync (bot-managed skip) nor the native-stop pass
  //     (unfilled stop ⇒ no attribution) may fabricate a close.
  //   • DB holds a sync_-owned FOO row the broker doesn't have
  //     → BrokerSync (and ONLY BrokerSync) closes it, SYNC_DETECTED pnl=0.
  //   • A stale uc8 stop (wrong qty) for SPY sits on the broker book
  //     → after adoption it must be canceled by EXACT id and replaced by ONE
  //     correct stop; a re-run must be idempotent (no second stop).
  //
  // Revert-falsifiers:
  //  - remove the ALPACA_ADOPTION_GRACE_CYCLES grace → adoption on cycle 1 →
  //    the "not adopted after 2 cycles" assertion fails.
  //  - remove BrokerSync's isSyncOwned bot-managed skip → JNJ auto-closes →
  //    "JNJ still open" fails.
  //  - remove the stale-stop cancel or the verified-stop no-op → duplicate
  //    live stops → the ≤1-placement / exact-id-cancel assertions fail.
  //  - make any reconcile path "clean up" the orphan by closing it →
  //    closePosition spy fires → the zero-close assertion fails.
  test("3 interleaved sync cycles adopt, reconcile and re-arm; a 4th cycle is a no-op", async () => {
    seedOpenTrade("orch-f1-jnj", "meanrev_stocks", { symbol: "JNJ", strategy: "MEANREV", entryPrice: 100, quantity: 2 });
    getDB().prepare(
      `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity, entry_time, status, account_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run("sync_2000_orchf1", "FOO", "stock", "buy", "BROKER_SYNC", 10, 1, Date.now() - 60_000, "open", "alpaca_main");

    const closeCalls: any[] = [];
    const cancels: string[] = [];
    const placedStops: any[] = [];
    // Broker's open stop book, mutated by cancel/place like the real one.
    let stopBook: Array<{ id: string; clientOrderId: string; symbol: string; side: "buy" | "sell"; qty: number; stopPrice: number; status: string }> =
      [{ id: "orphan-stop-1", clientOrderId: "manual-old", symbol: "SPY", side: "sell", qty: 3, stopPrice: 96, status: "new" }];
    const manager = makeAccountManager({
      alpaca: fakeAlpaca({
        getPositions: async () => [{
          symbol: "SPY", market: "stock" as const, side: "buy" as const, quantity: 5,
          avgEntryPrice: 100, currentPrice: 102, unrealizedPnl: 10, unrealizedPnlPct: 2, openedAt: Date.now(),
        }],
        getOpenStopOrders: async () => [...stopBook],
        cancelOrderById: async (id: string) => { cancels.push(id); stopBook = stopBook.filter(o => o.id !== id); return true; },
        placeStopLossOrder: async (p: any) => {
          placedStops.push(p);
          const id = `uc8-placed-${placedStops.length}`;
          stopBook.push({ id, clientOrderId: id, symbol: p.symbol, side: p.positionSide === "buy" ? "sell" : "buy", qty: p.quantity, stopPrice: p.stopPrice, status: "new" });
          return { ok: true, orderId: id };
        },
        closePosition: async (...args: any[]) => { closeCalls.push(args); return { success: true, filledPrice: 100, commission: 0 }; },
      }),
    });
    const brokerSync = new BrokerSync([
      alpacaSyncSource(() => [{ symbol: "SPY", side: "buy", quantity: 5, entryPrice: 100 }]),
    ]);

    const { bursts, detach } = captureBursts();
    try {
      // Cycles 1–2: inside the adoption grace — SPY must NOT be adopted yet
      // (a broker position can be an engine open whose insert is in flight).
      for (let i = 0; i < 2; i++) {
        await Promise.all([(manager as any).syncAlpacaAccount(), brokerSync.syncAll()]);
      }
      expect(getDB().prepare("SELECT COUNT(*) AS c FROM trades WHERE symbol = 'SPY'").get()).toEqual({ c: 0 });

      // Cycle 3: grace crossed → adopted under its universe owner.
      await Promise.all([(manager as any).syncAlpacaAccount(), brokerSync.syncAll()]);
    } finally {
      detach();
    }

    // Adoption: exactly one open SPY row, owned by momentum_stocks, real basis.
    const spyRows = getDB().prepare(
      "SELECT account_id, status, strategy, entry_price, quantity FROM trades WHERE symbol = 'SPY'",
    ).all() as any[];
    expect(spyRows).toEqual([{ account_id: "momentum_stocks", status: "open", strategy: "SYNC_RECOVERY", entry_price: 100, quantity: 5 }]);
    // …and it paged (an orphan is evidence of an upstream bug, never silent).
    expect(bursts.some(b => b.context === "AccountManager.orphanAdopt" && String(b.message).includes("SPY"))).toBe(true);
    // BrokerSync ALSO paged the qty drift while the dirty state lasted
    // (broker 5 vs DB 0) — dirty boots are loud, not silently patched.
    expect(bursts.some(b => b.context === "BrokerSync" && String(b.message).includes("SPY"))).toBe(true);

    // The stale wrong-qty stop was canceled by EXACT id; ONE correct stop
    // (own qty 5, 4% under entry) protects the adopted row.
    expect(cancels).toContain("orphan-stop-1");
    expect(placedStops.length).toBe(1);
    expect(placedStops[0]).toMatchObject({ symbol: "SPY", quantity: 5, stopPrice: 96, accountId: "momentum_stocks" });
    expect(stopBook.filter(o => o.symbol === "SPY").length).toBe(1); // never two live stops

    // DB orphan (bot-managed, broker flat): left OPEN — no fabricated close.
    expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'orch-f1-jnj'").get()).toEqual({
      status: "open", close_reason: null,
    });
    // sync_-owned orphan: closed by BrokerSync only, pnl 0 at entry.
    expect(getDB().prepare("SELECT status, close_reason, pnl FROM trades WHERE id = 'sync_2000_orchf1'").get()).toEqual({
      status: "closed", close_reason: "SYNC_DETECTED", pnl: 0,
    });
    // NOTHING was closed at the broker during convergence.
    expect(closeCalls).toEqual([]);

    // Cycle 4 (steady state): idempotent — no re-adoption, no second stop,
    // still zero broker closes.
    await Promise.all([(manager as any).syncAlpacaAccount(), brokerSync.syncAll()]);
    expect((getDB().prepare("SELECT COUNT(*) AS c FROM trades WHERE symbol = 'SPY' AND status = 'open'").get() as any).c).toBe(1);
    expect(placedStops.length).toBe(1);
    expect(closeCalls).toEqual([]);
  });
});
