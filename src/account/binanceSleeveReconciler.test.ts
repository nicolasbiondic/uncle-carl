// ══════════════════════════════════════════════
// BinanceSleeveReconciler — the property that motivated the extraction:
// the three Binance sleeves (USDT / USDC / COIN-M) run ONE reconciliation
// algorithm, so a fix applies to all of them at once. Locks:
//   1. The historical copy-paste bug (the QUANTITY tolerance reused in the
//      trigger-PRICE comparison, which let an absurd trigger pass as
//      "protection" on cheap high-qty symbols) is now a single function —
//      verifyProtectiveStop — and BOTH linear sleeves reject it identically
//      through their real sync paths. (COIN-M's stop verification is
//      broker-side — executor.ensureLiveStop on an inverse contract — a
//      documented hook, so the tolerance property doesn't apply to it.)
//   2. The unreconciled-flat-row grace (leave open N−1 passes, close as
//      MANUAL_CLOSE_UNRECONCILED on pass N) is IDENTICAL across all three.
//   3. The per-sleeve grace counters are pruned every completed pass — the
//      old shared trade-UUID map leaked forever (audit 2026-08-06).
//   4. The reconciler module writes NO equity_snapshots (single-writer
//      contract, same grep-style lock as moneyWrites.test.ts).
// ══════════════════════════════════════════════

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { getDB, initDatabase, getOpenTrades, insertTrade } from "../db/database";
import { AccountManager } from "./AccountManager";
import {
  verifyProtectiveStop, UnreconciledGrace, emergencyCloseVerified,
  UNRECONCILED_CLOSE_AFTER,
} from "./BinanceSleeveReconciler";
import { inversePnlUsdAtExit } from "../executor/binance-coinm-executor";
import { BinanceExecutor } from "../executor/binance-executor";

beforeAll(() => initDatabase(":memory:"));
beforeEach(() => {
  getDB().exec("DELETE FROM trades; DELETE FROM activity_log; DELETE FROM equity_snapshots;");
});

// ── Shared fakes ─────────────────────────────────────────────────────────

function usdtManager(binance: Record<string, any>) {
  return new AccountManager({
    binance: {
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 10_000, marginCash: 9_000, wallet: 10_000, unrealizedPnl: 0 }),
      getAccountTotal: async () => null,
      getRecentTrades: async () => [],
      hasFilledStopClose: async () => false,
      getAlgoOrderHistory: async () => [],
      cancelAllOrders: async () => {},
      ...binance,
    },
    alpaca: { getCachedPrice: () => 0 },
    osm: {},
  } as any);
}

function usdcManager(usdc: Record<string, any>) {
  const manager = new AccountManager({
    binance: { isConnected: () => false },
    alpaca: { getCachedPrice: () => 0 },
    osm: {},
  } as any);
  manager.attachUsdcExecutor({
    isConnected: () => true,
    getBalance: async () => ({ marginEquity: 5_000, marginCash: 5_000, wallet: 5_000, unrealizedPnl: 0 }),
    getRecentTrades: async () => [],
    hasFilledStopClose: async () => false,
    getAlgoOrderHistory: async () => [],
    cancelAllOrders: async () => {},
    ...usdc,
  } as any);
  return manager;
}

function coinmManager(coinm: Record<string, any>) {
  const manager = new AccountManager({
    binance: { isConnected: () => false },
    alpaca: { getCachedPrice: () => 0 },
    osm: {},
  } as any);
  manager.attachCoinmExecutor({
    isConnected: () => true,
    getEquityUsd: async () => 1_000,
    getOwnedPosition: async () => null,
    getFilters: async () => ({ contractSize: 100 }),
    ...coinm,
  } as any, { live: true });
  return manager;
}

// ── 1. verifyProtectiveStop: the single copy of the tolerance logic ──────

describe("verifyProtectiveStop — quantity and price tolerances are separate and unit-correct", () => {
  // Cheap high-qty scenario (DOGE-like): the exact shape where the historical
  // bug passed. qtyTol = 10_000 × 1e-3 = 10; a trigger 0.09 away from the
  // expected stop is INSIDE the quantity tolerance (10) but far outside the
  // price tolerance (1% of 0.096 ≈ 0.00096).
  const exp = { brokerSymbol: "DOGEUSDT", positionSide: "buy" as const, entryPrice: 0.1, stopPrice: 0.096, quantity: 10_000 };
  const order = (overrides: Record<string, any> = {}) => ({
    symbol: "DOGEUSDT", side: "SELL", type: "STOP_MARKET",
    quantity: 10_000, triggerPrice: 0.096, reduceOnly: true, ...overrides,
  });

  test("accepts a stop with the right side/qty and a trigger at the expected price", () => {
    expect(verifyProtectiveStop([order()], exp)).toBe(true);
  });

  test("HISTORICAL BUG LOCK: rejects an absurd trigger that is within the QUANTITY tolerance but outside the PRICE tolerance", () => {
    // |0.006 − 0.096| = 0.09 ≤ qtyTol(10) — the buggy comparison accepted it.
    expect(verifyProtectiveStop([order({ triggerPrice: 0.006 })], exp)).toBe(false);
  });

  test("rejects a partial-quantity stop (not real protection for the whole position)", () => {
    expect(verifyProtectiveStop([order({ quantity: 5_000 })], exp)).toBe(false);
  });

  test("rejects a trigger on the WRONG side of entry, non-reduceOnly orders, and the wrong close side", () => {
    expect(verifyProtectiveStop([order({ triggerPrice: 0.11 })], exp)).toBe(false); // above entry on a long
    expect(verifyProtectiveStop([order({ reduceOnly: false })], exp)).toBe(false);
    expect(verifyProtectiveStop([order({ side: "BUY" })], exp)).toBe(false);
  });
});

// ── 2. The bug scenario through the REAL sync paths of both linear sleeves ──

describe("tolerance fix applies to BOTH linear sleeves via the shared reconciler", () => {
  // An orphan DOGE position whose stop read-back has an absurd trigger that
  // the buggy tolerance would have blessed: the sleeve must NOT adopt it and
  // must emergency-close instead. Parameterized over the two FAPI sleeves.
  const cases = [
    {
      name: "USDT (momentum_crypto)",
      brokerSymbol: "DOGEUSDT",
      accountId: "momentum_crypto",
      build(fake: Record<string, any>) {
        const m = usdtManager(fake);
        return { manager: m, sync: () => (m as any).syncBinanceFutures() };
      },
    },
    {
      name: "USDC (momentum_crypto_usdc)",
      brokerSymbol: "DOGEUSDC",
      accountId: "momentum_crypto_usdc",
      build(fake: Record<string, any>) {
        const m = usdcManager(fake);
        return { manager: m, sync: () => (m as any).syncBinanceUsdc() };
      },
    },
  ] as const;

  for (const c of cases) {
    test(`${c.name}: absurd trigger within the qty tolerance is NOT protection — orphan is emergency-closed, never adopted`, async () => {
      const closeArgs: any[] = [];
      let positionReads = 0;
      const orphan = {
        symbol: c.brokerSymbol, positionAmt: 10_000, entryPrice: 0.1,
        unrealizedProfit: 0, updateTime: Date.now() - 10 * 60_000,
      };
      const { sync } = c.build({
        getPositions: async () => {
          positionReads++;
          return positionReads <= 2 ? [orphan] : []; // sync read + fresh re-read live; post-close flat
        },
        placeStopMarketClose: async () => true, // install "succeeds"…
        getOpenProtectiveOrders: async () => [{
          symbol: c.brokerSymbol, side: "SELL", type: "STOP_MARKET",
          quantity: 10_000, triggerPrice: 0.006, reduceOnly: true, // …but the read-back trigger is absurd
        }],
        closePosition: async (...args: any[]) => {
          closeArgs.push(args);
          return { success: true, filledPrice: 0.1, commission: 0, realizedPnl: 0 };
        },
      });

      await sync();

      expect(closeArgs).toHaveLength(1); // emergency close ran
      expect(getOpenTrades(c.accountId)).toHaveLength(0); // NOT adopted
    });

    test(`${c.name}: a correct read-back trigger IS protection — orphan adopted as SYNC_RECOVERY`, async () => {
      let closes = 0;
      // Echo the stop the reconciler just placed back through the read-back —
      // profile-agnostic (whatever stopLossPct the sleeve uses, the trigger
      // matches), which is exactly the "verified live" condition.
      let placedStop = 0;
      const orphan = {
        symbol: c.brokerSymbol, positionAmt: 10_000, entryPrice: 0.1,
        unrealizedProfit: 0, updateTime: Date.now() - 10 * 60_000,
      };
      const { sync } = c.build({
        getPositions: async () => [orphan],
        placeStopMarketClose: async (_sym: string, _side: string, stopPrice: number) => {
          placedStop = stopPrice;
          return true;
        },
        getOpenProtectiveOrders: async () => [{
          symbol: c.brokerSymbol, side: "SELL", type: "STOP_MARKET",
          quantity: 10_000, triggerPrice: placedStop, reduceOnly: true,
        }],
        closePosition: async () => { closes++; return { success: true, filledPrice: 0.1, commission: 0, realizedPnl: 0 }; },
      });

      await sync();

      expect(closes).toBe(0);
      const rows = getOpenTrades(c.accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(10_000);
      const raw = getDB().prepare(`SELECT strategy FROM trades WHERE account_id = ?`).get(c.accountId) as any;
      expect(raw.strategy).toBe("SYNC_RECOVERY");
    });
  }
});

// ── 2b. getOpenProtectiveOrders' real STOP/STOP_MARKET fix reaches the
// reconciler's protection check (binance-executor.ts's Algo Order readback
// can report orderType "STOP" for the exact fallback path our own
// placeStopMarketClose takes on a -4120 rejection — a raw exact-match filter
// against "STOP_MARKET" alone would drop it and turn a protected orphan into
// an emergency-close). Uses the REAL BinanceExecutor.getOpenProtectiveOrders
// (not a hand-written stub), only signedRequest is faked, so this exercises
// the actual filter/normalize logic verifyProtectiveStop consumes. ────────

describe("getOpenProtectiveOrders' STOP readback is recognized as real protection by the reconciler", () => {
  test("USDT: a broker algo-order readback of orderType \"STOP\" (not \"STOP_MARKET\") is verified as protection — orphan adopted, not emergency-closed", async () => {
    const exec = new BinanceExecutor() as any;
    exec.connected = true;
    let placedStop = 0;
    exec.signedRequest = async (_method: string, path: string) => {
      if (path === "/fapi/v1/openOrders") return [];
      if (path === "/fapi/v1/openAlgoOrders") {
        // Real Binance Algo Order API readback shape (ccxt's captured
        // "createOrder conditional linear swap" response): orderType
        // "STOP", not "STOP_MARKET", even for our own market-close stop.
        return [{
          algoId: "3386", algoType: "CONDITIONAL", orderType: "STOP",
          symbol: "DOGEUSDT", side: "SELL", quantity: "10000", triggerPrice: String(placedStop),
          reduceOnly: true,
        }];
      }
      throw new Error(`unexpected path ${path}`);
    };

    let closes = 0;
    const orphan = {
      symbol: "DOGEUSDT", positionAmt: 10_000, entryPrice: 0.1,
      unrealizedProfit: 0, updateTime: Date.now() - 10 * 60_000,
    };
    const manager = usdtManager({
      getPositions: async () => [orphan],
      placeStopMarketClose: async (_sym: string, _side: string, stopPrice: number) => { placedStop = stopPrice; return true; },
      getOpenProtectiveOrders: (symbol?: string) => exec.getOpenProtectiveOrders(symbol),
      closePosition: async () => { closes++; return { success: true, filledPrice: 0.1, commission: 0, realizedPnl: 0 }; },
    });

    await (manager as any).syncBinanceFutures();

    expect(closes).toBe(0); // NOT emergency-closed — the "STOP" readback was recognized as protection
    const rows = getOpenTrades("momentum_crypto");
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(10_000);
    const raw = getDB().prepare(`SELECT strategy FROM trades WHERE account_id = ?`).get("momentum_crypto") as any;
    expect(raw.strategy).toBe("SYNC_RECOVERY");
  });
});

// ── 3. Unreconciled grace: SAME escalation for all THREE sleeves ─────────

describe("unreconciled-flat-row grace is identical across USDT, USDC and COIN-M", () => {
  const cases = [
    {
      name: "USDT",
      accountId: "momentum_crypto",
      symbol: "BTC/USD",
      build() {
        const m = usdtManager({ getPositions: async () => [] });
        return { manager: m, sync: () => (m as any).syncBinanceFutures(), graceField: "usdtGrace" };
      },
    },
    {
      name: "USDC",
      accountId: "momentum_crypto_usdc",
      symbol: "BTC/USDC",
      build() {
        const m = usdcManager({ getPositions: async () => [] });
        return { manager: m, sync: () => (m as any).syncBinanceUsdc(), graceField: "usdcGrace" };
      },
    },
    {
      name: "COIN-M",
      accountId: "momentum_btc",
      symbol: "BTC/COIN-M",
      build() {
        const m = coinmManager({
          getOwnedPosition: async () => null,
          getCloseSettlementSince: async () => ({
            realizedPnlNative: 0, commissionNative: 0, commissionAsset: "BTC",
            executedQty: 0, averagePrice: 0,
          }),
        });
        return { manager: m, sync: () => (m as any).syncBinanceCoinM(), graceField: "coinmGrace" };
      },
    },
  ] as const;

  for (const c of cases) {
    test(`${c.name}: flat on broker with no attributable fills stays open for ${UNRECONCILED_CLOSE_AFTER - 1} passes, closes MANUAL_CLOSE_UNRECONCILED on pass ${UNRECONCILED_CLOSE_AFTER}`, async () => {
      const id = `grace-${c.accountId}`;
      insertTrade({
        id, symbol: c.symbol, market: "crypto", side: "buy", strategy: "MOMENTUM",
        entryPrice: 100, quantity: 1, entryTime: Date.now() - 60_000, status: "open",
      } as any, c.accountId);
      const { sync } = c.build();

      for (let pass = 1; pass < UNRECONCILED_CLOSE_AFTER; pass++) {
        await sync();
        expect(getDB().prepare(`SELECT status FROM trades WHERE id = ?`).get(id)).toEqual({ status: "open" });
      }
      await sync();
      expect(getDB().prepare(`SELECT status, close_reason FROM trades WHERE id = ?`).get(id)).toEqual({
        status: "closed", close_reason: "MANUAL_CLOSE_UNRECONCILED",
      });
    });

    test(`${c.name}: the grace counter is PRUNED when the row leaves scope through another path (no leak)`, async () => {
      const id = `leak-${c.accountId}`;
      insertTrade({
        id, symbol: c.symbol, market: "crypto", side: "buy", strategy: "MOMENTUM",
        entryPrice: 100, quantity: 1, entryTime: Date.now() - 60_000, status: "open",
      } as any, c.accountId);
      const { manager, sync, graceField } = c.build();

      await sync();
      await sync();
      expect((manager as any)[graceField].size).toBe(1); // counting toward escalation

      // Row closes through ANOTHER path (engine rebalance / BrokerSync / stop).
      getDB().prepare(`UPDATE trades SET status = 'closed' WHERE id = ?`).run(id);
      await sync();
      expect((manager as any)[graceField].size).toBe(0); // pruned, not leaked
    });
  }
});

// ── 4. UnreconciledGrace unit semantics ──────────────────────────────────

describe("UnreconciledGrace", () => {
  test("counts consecutively, prunes non-bumped keys on endPass, keeps counters on an aborted pass", () => {
    const g = new UnreconciledGrace();
    g.beginPass();
    expect(g.bump("a")).toBe(1);
    expect(g.bump("b")).toBe(1);
    g.endPass();

    g.beginPass();
    expect(g.bump("a")).toBe(2); // consecutive
    g.endPass();                 // "b" not bumped this pass → pruned
    expect(g.size).toBe(1);

    g.beginPass();               // pass aborts (no endPass): "a" survives
    expect(g.size).toBe(1);
    g.beginPass();
    expect(g.bump("a")).toBe(3); // still consecutive after the aborted pass
    g.clear("a");
    expect(g.size).toBe(0);
  });
});

// ── 5. Emergency-close verdict: reread failure is never "verified flat" ──

describe("emergencyCloseVerified (shared by all three sleeves)", () => {
  test("verified only when the close succeeded AND the reread worked AND the position is flat", () => {
    expect(emergencyCloseVerified(true, true, 0)).toBe(true);
    expect(emergencyCloseVerified(false, true, 0)).toBe(false); // close failed
    expect(emergencyCloseVerified(true, false, 0)).toBe(false); // reread threw → UNKNOWN, never flat
    expect(emergencyCloseVerified(true, true, 0.3)).toBe(false); // remainder still live
  });
});

// ── 6. deferredLoggedReasons is pruned per SL pass (audit leak #2) ───────

describe("checkAllStopLoss prunes deferredLoggedReasons to open positions", () => {
  test("a row closed by another path drops its suppressed-reason entry on the next pass", async () => {
    insertTrade({
      id: "deferred-prune-test", symbol: "BTC/USD", market: "crypto", side: "buy",
      strategy: "MOMENTUM", entryPrice: 100, quantity: 1, entryTime: Date.now() - 60_000, status: "open",
    } as any, "momentum_crypto");
    const manager = new AccountManager({
      alpaca: {}, osm: {},
      binance: {
        isConnected: () => true,
        getPrice: async () => 90, // −10% breaches the stop → close attempted
        closePosition: async () => ({ success: false, reason: "timeout" }), // broker defers
      },
    } as any);

    await (manager as any).checkAllStopLoss();
    expect((manager as any).deferredLoggedReasons.get("momentum_crypto:BTC/USD:STOP_LOSS")).toBe("timeout");

    // The row leaves scope through ANOTHER path (rebalance/BrokerSync/etc).
    getDB().prepare(`UPDATE trades SET status = 'closed' WHERE id = 'deferred-prune-test'`).run();
    await (manager as any).checkAllStopLoss();
    expect((manager as any).deferredLoggedReasons.size).toBe(0); // pruned, not leaked
  });
});

// ── 7. Single-writer contract: the reconciler persists NO snapshots ──────

describe("BinanceSleeveReconciler stays out of the equity_snapshots write path", () => {
  test("module source contains no saveEquitySnapshot call (writeAllSnapshots remains the sole writer)", () => {
    const src = readFileSync(join(import.meta.dir, "BinanceSleeveReconciler.ts"), "utf-8");
    // The header comment mentions the contract; strip comments before grepping.
    const code = src.replace(/\/\/[^\n]*\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("saveEquitySnapshot");
  });
});

// ── 8. Unrealized refresh is scoped to the SLEEVE's row, never the broker
//      AGGREGATE (2026-08-19 LINK incident) ─────────────────────────────
// Prod: broker LINKUSDT held 785.75 @ 9.2675 (untracked residue from
// external/unreconciled closes) while the momentum_crypto row owned only
// 198 @ 9.49025. The old refresh copied live.unrealizedProfit — the WHOLE
// aggregate's +$874 — onto the 198-unit row (dashboard showed +$870 / +46%
// on a $1.9k notional). The refresh must recover the broker's mark price
// and compute the row's OWN PnL from its own entry/quantity.

describe("linear unrealized refresh never absorbs the broker aggregate", () => {
  function seedRow(symbol: string, quantity: number, entryPrice: number) {
    insertTrade({
      id: `refresh-${symbol}`, symbol, market: "crypto", side: "buy", strategy: "MOMENTUM",
      entryPrice, quantity, entryTime: Date.now() - 60_000, status: "open",
    } as any, "momentum_crypto");
  }
  function seedPos(m: AccountManager, symbol: string, quantity: number, entryPrice: number) {
    const acc = m.getAccount("momentum_crypto");
    acc.positions.set(symbol, {
      symbol, market: "crypto", side: "buy", quantity,
      avgEntryPrice: entryPrice, currentPrice: entryPrice,
      unrealizedPnl: 0, unrealizedPnlPct: 0, openedAt: Date.now() - 60_000,
    } as any);
    return acc;
  }

  test("LINK: broker aggregate 785.75 @ 9.2675 (uPnL ≈ $874) vs row 198 @ 9.49025 → row shows ITS $176.17, not the aggregate", async () => {
    const AGG_QTY = 785.75, AGG_ENTRY = 9.267531784918868, MARK = 10.38;
    seedRow("LINK/USD", 198, 9.49025);
    // Hypothesis (a) guard from the same incident: a shadow_* row for the
    // SAME symbol exists in the DB — it must neither block, be adopted, nor
    // leak into the sleeve's numbers (it has no broker position behind it).
    insertTrade({
      id: "refresh-shadow-LINK", symbol: "LINK/USD", market: "crypto", side: "sell", strategy: "CARRY",
      entryPrice: 10.544, quantity: 189.68, entryTime: Date.now() - 60_000, status: "open",
    } as any, "shadow_carry");
    const m = usdtManager({
      getPositions: async () => [{
        symbol: "LINKUSDT", positionAmt: AGG_QTY, entryPrice: AGG_ENTRY,
        unrealizedProfit: AGG_QTY * (MARK - AGG_ENTRY), // what FAPI positionRisk reports for the aggregate
        updateTime: Date.now() - 10 * 60_000,
      }],
    });
    const acc = seedPos(m, "LINK/USD", 198, 9.49025);

    await (m as any).syncBinanceFutures();

    const pos = acc.positions.get("LINK/USD")!;
    expect(pos.unrealizedPnl).toBeCloseTo(176.17, 2);        // 198 × (10.38 − 9.49025), ±0.01
    expect(pos.currentPrice).toBeCloseTo(MARK, 9);           // broker mark recovered exactly
    expect(pos.unrealizedPnlPct).toBeCloseTo(9.376, 2);      // on the row's own notional
    // the shadow row is untouched and the sleeve's row is still the only real one
    expect(getOpenTrades("momentum_crypto")).toHaveLength(1);
    expect(getDB().prepare(`SELECT status FROM trades WHERE id = 'refresh-shadow-LINK'`).get()).toEqual({ status: "open" });
  });

  test("SOL regression: broker position exactly matches the row → refresh equals the broker's own uPnL", async () => {
    const MARK = 84.14;
    seedRow("SOL/USD", 22.32, 82.43);
    const m = usdtManager({
      getPositions: async () => [{
        symbol: "SOLUSDT", positionAmt: 22.32, entryPrice: 82.43,
        unrealizedProfit: 22.32 * (MARK - 82.43),
        updateTime: Date.now() - 10 * 60_000,
      }],
    });
    const acc = seedPos(m, "SOL/USD", 22.32, 82.43);

    await (m as any).syncBinanceFutures();

    const pos = acc.positions.get("SOL/USD")!;
    expect(pos.unrealizedPnl).toBeCloseTo(22.32 * (MARK - 82.43), 6); // $38.17 — unchanged behavior
    expect(pos.currentPrice).toBeCloseTo(MARK, 9);
  });
});

// ── 9. Stop attribution (2026-08-19 LINK orphan root cause) ──────────────
// Both linear sleeves place stops through the SAME placeStopMarketClose,
// whose −4120 fallback lands them as algo orders — invisible to
// /fapi/v1/allOrders (all hasFilledStopClose reads). With USDT's
// algoOrderStopAttribution=false (a refactor artifact), every algo-stop
// close was labeled MANUAL_CLOSE: momentum_crypto had ZERO
// BROKER_STOP_LOSS in its whole history while USDC attributed 5.
// Also: a READ failure is unknown, never the positive claim "not a stop".

describe("linear stop attribution: algo-order stops and read failures", () => {
  const ENTRY = Date.now() - 60_000;
  const closingFill = { realizedPnl: -50, commission: 0.5, price: 96, qty: 1, side: "SELL", time: ENTRY + 10 };
  const filledAlgoStop = {
    algoStatus: "FILLED", orderType: "STOP_MARKET", side: "SELL",
    executedQty: 1, updateTime: ENTRY + 10,
  };
  const cases = [
    {
      name: "USDT (momentum_crypto)",
      accountId: "momentum_crypto",
      symbol: "BTC/USD",
      build(fake: Record<string, any>) {
        const m = usdtManager({ getPositions: async () => [], ...fake });
        return () => (m as any).syncBinanceFutures();
      },
    },
    {
      name: "USDC (momentum_crypto_usdc)",
      accountId: "momentum_crypto_usdc",
      symbol: "BTC/USDC",
      build(fake: Record<string, any>) {
        const m = usdcManager({ getPositions: async () => [], ...fake });
        return () => (m as any).syncBinanceUsdc();
      },
    },
  ] as const;

  function seed(accountId: string, symbol: string, id: string) {
    insertTrade({
      id, symbol, market: "crypto", side: "buy", strategy: "MOMENTUM",
      entryPrice: 100, quantity: 1, entryTime: ENTRY, status: "open",
    } as any, accountId);
  }
  const reasonOf = (id: string) =>
    (getDB().prepare(`SELECT close_reason FROM trades WHERE id = ?`).get(id) as any).close_reason;

  for (const c of cases) {
    test(`${c.name}: a stop filled as an ALGO order (−4120 fallback) is BROKER_STOP_LOSS, not MANUAL_CLOSE`, async () => {
      const id = `algo-stop-${c.accountId}`;
      seed(c.accountId, c.symbol, id);
      const sync = c.build({
        getRecentTrades: async () => [closingFill],
        hasFilledStopClose: async () => false, // invisible to /fapi/v1/allOrders
        getAlgoOrderHistory: async () => [filledAlgoStop],
      });
      await sync();
      expect(reasonOf(id)).toBe("BROKER_STOP_LOSS");
    });

    test(`${c.name}: hasFilledStopClose READ FAILURE degrades to MANUAL_CLOSE_UNRECONCILED — never the positive claim MANUAL_CLOSE`, async () => {
      const id = `read-fail-${c.accountId}`;
      seed(c.accountId, c.symbol, id);
      const sync = c.build({
        getRecentTrades: async () => [closingFill],
        hasFilledStopClose: async () => { throw new Error("allOrders 5xx"); },
        getAlgoOrderHistory: async () => [], // algo store read OK but empty — still can't rule out a regular stop
      });
      await sync();
      expect(reasonOf(id)).toBe("MANUAL_CLOSE_UNRECONCILED");
    });

    test(`${c.name}: algo-history READ FAILURE (regular store says no) also degrades to MANUAL_CLOSE_UNRECONCILED`, async () => {
      const id = `algo-fail-${c.accountId}`;
      seed(c.accountId, c.symbol, id);
      const sync = c.build({
        getRecentTrades: async () => [closingFill],
        hasFilledStopClose: async () => false,
        getAlgoOrderHistory: async () => { throw new Error("allAlgoOrders 5xx"); },
      });
      await sync();
      expect(reasonOf(id)).toBe("MANUAL_CLOSE_UNRECONCILED");
    });

    test(`${c.name}: a POSITIVE algo finding wins even when the regular-store read failed`, async () => {
      const id = `positive-wins-${c.accountId}`;
      seed(c.accountId, c.symbol, id);
      const sync = c.build({
        getRecentTrades: async () => [closingFill],
        hasFilledStopClose: async () => { throw new Error("allOrders 5xx"); },
        getAlgoOrderHistory: async () => [filledAlgoStop],
      });
      await sync();
      expect(reasonOf(id)).toBe("BROKER_STOP_LOSS");
    });
  }
});

// ── 10. COIN-M exposure: contracts × price is NOT a notional ─────────────

describe("COIN-M state: cryptoValue = Σ positionUsd (inverse $100 contracts), never quantity × price", () => {
  test("6 contracts → $600 exposure, not qty × mark (~$402k on a $1k sleeve)", async () => {
    insertTrade({
      id: "coinm-notional", symbol: "BTC/COIN-M", market: "crypto", side: "buy", strategy: "MOMENTUM",
      entryPrice: 68_380.98, quantity: 6, entryTime: Date.now() - 60_000, status: "open",
    } as any, "momentum_btc");
    const m = coinmManager({ getMarkPrice: async () => 67_000 });

    await m.updateAllStates();

    const acc = m.getAccount("momentum_btc");
    expect(acc.state.cryptoValue).toBe(600);                 // 6 × $100, price-independent
    const pos = acc.positions.get("BTC/COIN-M")!;
    // and the row's PnL stays the inverse-contract math, not linear qty×Δprice
    expect(pos.unrealizedPnl).toBeCloseTo(inversePnlUsdAtExit("buy", 6, 100, 68_380.98, 67_000), 9);
  });
});
