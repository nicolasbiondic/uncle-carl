import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDB } from "../db/database";
import { boundedAlpacaStockSymbols, recordUnavailablePriceMiss, isSyncOwned } from "./AccountManager";
import { EVENTS } from "../utils/events";
import { makeTestDb, seedOpenTrade } from "../test-support/db";
import { captureBursts, captureEvent } from "../test-support/events";
import { makeAccountManager } from "../test-support/account";

/** Both the price-unavailable escalation and the DEFERRED-close tests fake
 *  Date to a fixed moment during US market hours (checkAllStopLoss skips
 *  stock closes while the market is closed), and capture console.log to
 *  inspect what the logger printed. */
async function withFakeMarketOpenDate<T>(fn: () => Promise<T>): Promise<{ result: T; output: string[] }> {
  const realDate = Date;
  const openNow = realDate.parse("2026-07-24T14:00:00.000Z");
  globalThis.Date = class extends realDate {
    constructor(...args: any[]) { super(args.length ? args[0] : openNow); }
    static now() { return openNow; }
  } as DateConstructor;
  const output: string[] = [];
  const realLog = console.log;
  console.log = (...args: any[]) => output.push(args.join(" "));
  try {
    const result = await fn();
    return { result, output };
  } finally {
    console.log = realLog;
    globalThis.Date = realDate;
  }
}

beforeAll(() => makeTestDb());
beforeEach(() => getDB().exec("DELETE FROM trades; DELETE FROM activity_log;"));

describe("boundedAlpacaStockSymbols", () => {
  const universe = Array.from({ length: 50 }, (_, i) => `SYM${i.toString().padStart(2, "0")}`);

  test("caps a no-position subscription at the IEX limit", () => {
    const { symbols, droppedHeld } = boundedAlpacaStockSymbols([], universe);
    expect(symbols).toHaveLength(30);
    expect(symbols).toEqual(universe.slice(0, 30));
    expect(droppedHeld).toEqual([]);
  });

  test("prioritizes held stocks over raw universe order", () => {
    const held = ["SYM35", "SYM22", "SYM09"];
    const { symbols, droppedHeld } = boundedAlpacaStockSymbols(held, universe);
    expect(symbols).toHaveLength(30);
    expect(symbols).toContain("SYM35");
    expect(symbols).toContain("SYM22");
    expect(symbols).toContain("SYM09");
    expect(droppedHeld).toEqual([]);
  });

  test("regression: held stock outside the first 30 universe slots is still subscribed", () => {
    // Without the held-first rule, SYM35 would be dropped because the raw
    // universe's first 30 slots are SYM00..SYM29.
    const { symbols } = boundedAlpacaStockSymbols(["SYM35"], universe);
    expect(symbols).toContain("SYM35");
    expect(symbols).toHaveLength(30);
  });

  test("held stock not in the configured universe is still included", () => {
    const { symbols } = boundedAlpacaStockSymbols(["ZOOM"], universe);
    expect(symbols).toContain("ZOOM");
    expect(symbols).toHaveLength(30);
  });

  test("deterministically drops held stocks when they exceed the cap", () => {
    const held = [...universe].reverse(); // 50 held positions
    const { symbols, droppedHeld } = boundedAlpacaStockSymbols(held, universe);
    expect(symbols).toHaveLength(30);
    expect(symbols).toEqual(universe.slice(0, 30));
    expect(droppedHeld).toHaveLength(20);
    expect(droppedHeld).toEqual(universe.slice(30));
  });

  test("deduplicates held symbols and ignores duplicate universe entries", () => {
    const { symbols } = boundedAlpacaStockSymbols(
      ["AAPL", "AAPL", "MSFT"],
      ["AAPL", "MSFT", "AAPL", "TSLA"],
    );
    expect(symbols.slice(0, 2)).toEqual(["AAPL", "MSFT"]);
    expect(symbols).toContain("TSLA");
    expect(symbols).toHaveLength(3);
  });
});

describe("AccountManager stop-loss protection", () => {
  test("closes a position when the broker price breaches the stop", async () => {
    seedOpenTrade("stop-loss-test", "momentum_crypto", { symbol: "BTC/USD", market: "crypto" });
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
    expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'stop-loss-test'").get()).toEqual({
      status: "closed", close_reason: "STOP_LOSS",
    });
  });

  // P1 2026-07-27: the SL loop applied the EXECUTABLE (<30s) freshness
  // standard to a RISK read — on the IEX feed UNH went hours with a stale
  // last trade, so getLatestPrice returned 0 every pass and the stop was
  // never evaluated. The loop now uses getRiskPrice (bounded 5-min window,
  // quote-midpoint fallback). Reverting checkAllStopLoss to getLatestPrice
  // makes this fail: price 0 → continue → no close, row stays open.
  test("stop fires on a valid RISK price even when the executable price is unavailable (stale IEX trade)", async () => {
    seedOpenTrade("risk-price-stop-test", "meanrev_stocks", { symbol: "UNH", strategy: "MEANREV" });
    let closeCalls = 0;
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getLatestPrice: async () => 0, // executable path blind (IEX trade >30s old)
        getRiskPrice: async () => 90,  // risk tier still sees the -10% breach
        closePosition: async () => { closeCalls++; return { success: true, filledPrice: 90, commission: 0 }; },
      },
    });
    await withFakeMarketOpenDate(() => (manager as any).checkAllStopLoss());

    expect(closeCalls).toBe(1);
    expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'risk-price-stop-test'").get()).toEqual({
      status: "closed", close_reason: "STOP_LOSS",
    });
  });

  // Co-tenancy P0 (2026-07-27): the stop-loss close must carry OUR row's
  // quantity — a qty-less alpaca.closePosition liquidates the account's
  // AGGREGATE position (ours + the prod deployment's).
  test("stop-loss close passes the DB row's quantity to alpaca.closePosition", async () => {
    seedOpenTrade("qty-forward-test", "meanrev_stocks", { symbol: "UNH", strategy: "MEANREV", quantity: 11 });
    const closeArgs: any[] = [];
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getLatestPrice: async () => 90,
        getRiskPrice: async () => 90,
        closePosition: async (...args: any[]) => { closeArgs.push(args); return { success: true, filledPrice: 90, commission: 0 }; },
      },
    });
    await withFakeMarketOpenDate(() => (manager as any).checkAllStopLoss());

    expect(closeArgs).toHaveLength(1);
    expect(closeArgs[0][2]).toBe(11);
  });

  test("counts unavailable prices so repeated open-position misses can escalate", () => {
    const misses = new Map<string, number>();
    expect(recordUnavailablePriceMiss(misses, "momentum_stocks:AAPL")).toBe(1);
    expect(recordUnavailablePriceMiss(misses, "momentum_stocks:AAPL")).toBe(2);
    for (let i = 0; i < 3; i++) recordUnavailablePriceMiss(misses, "momentum_stocks:AAPL");
    expect(misses.get("momentum_stocks:AAPL")).toBe(5);
    expect(misses.get("momentum_stocks:MSFT")).toBeUndefined();
  });

  test("a single stale price miss is silent — no WARN, no page, position stays open", async () => {
    seedOpenTrade("missing-price-test", "momentum_stocks");
    const { bursts, detach } = captureBursts();
    const manager = makeAccountManager({ alpaca: { getRiskPrice: async () => 0 } });
    const { output } = await withFakeMarketOpenDate(() => (manager as any).checkAllStopLoss());
    detach();

    expect(getDB().prepare("SELECT status FROM trades WHERE id = 'missing-price-test'").get()).toEqual({ status: "open" });
    expect(output.some(line => line.includes("unavailable"))).toBe(false);
    expect(bursts).toHaveLength(0);
  });

  // Finding A: an Alpaca WS/REST outage goes stale for MANY symbols at once —
  // that must page ONCE per pass, not once per symbol (would be N pages every
  // 5 minutes forever with a permanently-down feed).
  test("aggregates many simultaneously-stale symbols into exactly ONE ERROR_BURST", async () => {
    seedOpenTrade("stale-aapl", "momentum_stocks", { symbol: "AAPL" });
    seedOpenTrade("stale-msft", "momentum_stocks", { symbol: "MSFT" });
    const { bursts, detach } = captureBursts();
    const manager = makeAccountManager({ alpaca: { getRiskPrice: async () => 0 } });
    await withFakeMarketOpenDate(async () => {
      // 5 consecutive misses cross the escalation threshold.
      for (let i = 0; i < 5; i++) await (manager as any).checkAllStopLoss();
    });
    detach();

    expect(bursts).toHaveLength(1); // one page, not one per symbol
    expect(bursts[0].context).toBe("AccountManager");
    expect(bursts[0].count).toBe(2); // both stale symbols named in the single alert
    expect(bursts[0].message).toContain("AAPL");
    expect(bursts[0].message).toContain("MSFT");
    expect(typeof bursts[0].windowMs).toBe("number"); // honest elapsed time, not a hardcoded lie
  });

  // Finding A: the miss-counter must not survive a position that closed — a
  // NEW position in the same symbol starts a fresh consecutive-miss count.
  // Behavioral proof: 4 misses (below the 5-miss threshold), the position
  // closes, a new one opens, 4 MORE misses — still silent (a leaked counter
  // would have crossed the threshold and paged); the 5th fresh miss pages.
  test("a position that closed resets the consecutive-miss escalation for its successor", async () => {
    seedOpenTrade("pruned-test", "momentum_stocks");
    const { bursts, detach } = captureBursts();
    const manager = makeAccountManager({ alpaca: { getRiskPrice: async () => 0 } });
    await withFakeMarketOpenDate(async () => {
      for (let i = 0; i < 4; i++) await (manager as any).checkAllStopLoss(); // 4 misses: below threshold

      getDB().exec("UPDATE trades SET status = 'closed' WHERE id = 'pruned-test'");
      await (manager as any).checkAllStopLoss(); // no open AAPL row this pass

      seedOpenTrade("pruned-test-2", "momentum_stocks"); // successor position, same symbol
      for (let i = 0; i < 4; i++) await (manager as any).checkAllStopLoss();
    });

    // A counter leaked from the first position (4 misses) would have crossed
    // the ≥5 threshold during the successor's 4 misses and paged.
    expect(bursts).toHaveLength(0);

    await withFakeMarketOpenDate(() => (manager as any).checkAllStopLoss()); // successor's 5th miss
    detach();
    expect(bursts).toHaveLength(1); // fresh count escalates exactly at 5
    expect(bursts[0].message).toContain("AAPL");
  });

  // Finding B: DEFERRED close suppression logs again only when the broker's
  // reason genuinely changes, not once per distinct message string.
  test("logs a DEFERRED close again only when the broker reason changes", async () => {
    seedOpenTrade("deferred-test", "momentum_stocks");
    let reason = "timeout";
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getRiskPrice: async () => 90, // -10% vs entry → breaches the 4% stop
        closePosition: async () => ({ success: false, reason }),
      },
    });
    const { output } = await withFakeMarketOpenDate(async () => {
      await (manager as any).checkAllStopLoss(); // reason "timeout" → logs
      await (manager as any).checkAllStopLoss(); // same reason → suppressed
      reason = "disconnected";
      await (manager as any).checkAllStopLoss(); // reason changed → logs again
      await (manager as any).checkAllStopLoss(); // same new reason → suppressed
    });

    const deferredLines = output.filter(line => line.includes("close DEFERRED"));
    expect(deferredLines).toHaveLength(2);
    expect(deferredLines[0]).toContain("timeout");
    expect(deferredLines[1]).toContain("disconnected");
  });

  // A close stuck DEFERRED forever with a STABLE reason only logs once
  // (above), which used to mean it went silent forever — now a consecutive-
  // defer counter escalates to ONE aggregated ERROR_BURST past the threshold,
  // not one page per tick.
  test("a close deferred past the threshold with the SAME reason pages exactly once", async () => {
    seedOpenTrade("stuck-deferred-test", "momentum_stocks");
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getRiskPrice: async () => 90, // -10% vs entry → breaches the 4% stop
        closePosition: async () => ({ success: false, reason: "timeout" }),
      },
    });
    const { bursts, detach } = captureBursts();
    await withFakeMarketOpenDate(async () => {
      // DEFERRED_CLOSE_ESCALATE_AFTER = 20 consecutive defers.
      for (let i = 0; i < 25; i++) await (manager as any).checkAllStopLoss();
    });
    detach();

    expect(bursts).toHaveLength(1); // one page, not one per tick
    expect(bursts[0].message).toContain("AAPL");
    expect(bursts[0].message).toContain("stuck DEFERRED");
  });

  // Scenario mounted entirely through the public cycle: 19 consecutive
  // "timeout" defers park the counter one shy of the 20-defer escalation,
  // then the broker starts answering http_403 with the position GONE — the
  // reconcile path must close the row (BROKER_GONE_404) without ever paging,
  // and a successor position in the same symbol must start a FRESH defer
  // count (19 more defers stay silent; the 20th pages) — leaked state from
  // the reconciled close would have paged immediately.
  test("a 403 gone-position reconciliation clears DEFERRED state and never pages", async () => {
    seedOpenTrade("reconciled-403-test", "momentum_stocks");
    let reason = "timeout";
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getRiskPrice: async () => 90,
        closePosition: async () => ({ success: false, reason }),
        getPositions: async () => [], // broker says: position gone
      },
    });
    const { bursts, detach } = captureBursts();
    await withFakeMarketOpenDate(async () => {
      for (let i = 0; i < 19; i++) await (manager as any).checkAllStopLoss(); // one shy of the threshold
      reason = "http_403";
      await (manager as any).checkAllStopLoss(); // reconcile: row closed, defer state cleared
    });

    expect(bursts).toHaveLength(0);
    expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'reconciled-403-test'").get()).toEqual({
      status: "closed", close_reason: "BROKER_GONE_404",
    });

    // Successor position, same symbol: a fresh count must get the FULL 19
    // silent defers again (leaked state would page on the very first one).
    seedOpenTrade("reconciled-403-successor", "momentum_stocks");
    reason = "timeout";
    await withFakeMarketOpenDate(async () => {
      for (let i = 0; i < 19; i++) await (manager as any).checkAllStopLoss();
    });
    expect(bursts).toHaveLength(0);

    await withFakeMarketOpenDate(() => (manager as any).checkAllStopLoss()); // 20th defer
    detach();
    expect(bursts).toHaveLength(1);
    expect(bursts[0].message).toContain("stuck DEFERRED");
  });

  // ── Ops paging for a close rejected (403) with the position still LIVE
  // (B-ops-alerts.md #3) ──────────────────────────────────────────────────
  // Distinct from the "403 gone-position" case above (stillOpen=false, no
  // page needed — the reconcile path handles it). Here the broker CONFIRMS
  // the position is still there but rejects the close (PDT/permission/SSR)
  // — before this fix that only logged+insertActivity, with no ops page at
  // all until the logger's 10-in-60s threshold (never reached: the pdtUntil
  // skip-guard means only ONE attempt happens per 6h block).
  test("a 403 close with the position still live pages ops immediately, once — the 6h pdt-block skip-guard naturally prevents a repeat page", async () => {
    seedOpenTrade("close-rejected-test", "momentum_stocks", { symbol: "AAPL" });
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getRiskPrice: async () => 90, // -10% vs entry → breaches the 4% stop
        closePosition: async () => ({ success: false, reason: "http_403" }),
        getPositions: async () => [{ symbol: "AAPL", quantity: 76 }], // broker CONFIRMS still live
      },
    });
    const { bursts, detach } = captureBursts("AccountManager.closeRejected");
    await withFakeMarketOpenDate(async () => {
      for (let i = 0; i < 3; i++) await (manager as any).checkAllStopLoss();
    });
    detach();

    expect(bursts).toHaveLength(1); // one page, not one per pass
    expect(bursts[0].message).toContain("AAPL");
    expect(bursts[0].message).toContain("close rejected");
    expect(bursts[0].message).toContain("retrying in 6h");
    expect(getDB().prepare("SELECT status FROM trades WHERE id = 'close-rejected-test'").get()).toEqual({ status: "open" });
  });

  test("resolving a close-rejected incident pages a RESOLVED follow-up exactly once, never for an incident that was never paged", async () => {
    const manager = makeAccountManager({});
    const { bursts, detach } = captureBursts("AccountManager.closeRejected");
    try {
      (manager as any).handleAlpacaPdtBlock("momentum_stocks", "AAPL", "STOP_LOSS");
      (manager as any).handleAlpacaPdtBlock("momentum_stocks", "AAPL", "STOP_LOSS"); // still blocked → no re-page
      expect(bursts).toHaveLength(1);

      (manager as any).resolveCloseRejectedIncident("momentum_stocks", "AAPL", "close confirmed by the broker");
      expect(bursts).toHaveLength(2);
      expect(bursts[1].message).toContain("RESOLVED");

      // Already resolved — a second resolve call for the same symbol is a no-op.
      (manager as any).resolveCloseRejectedIncident("momentum_stocks", "AAPL", "close confirmed by the broker");
      expect(bursts).toHaveLength(2);

      // A symbol that never had an incident resolves silently too.
      (manager as any).resolveCloseRejectedIncident("momentum_stocks", "MSFT", "n/a");
      expect(bursts).toHaveLength(2);
    } finally {
      detach();
    }
  });

  // TASK 1 regression: closeTrade forces close_reason=MANUAL_CLOSE_UNRECONCILED
  // when BOTH the caller-supplied pnl and the price-derived pnl are
  // non-finite (fabricated-zero row, must stay excluded from strategy
  // stats). syncBinanceFutures must not clobber that with its own computed
  // MANUAL_CLOSE/BROKER_STOP_LOSS reason.
  test("syncBinanceFutures does not overwrite a MANUAL_CLOSE_UNRECONCILED close_reason", async () => {
    seedOpenTrade("usdt-unreconciled-test", "momentum_crypto", { symbol: "BTC/USD", market: "crypto" });
    // Corrupt entry_price so the price-derived pnl closeTrade falls back to
    // is ALSO non-finite — the only way both pnl sources go bad at once.
    getDB().prepare("UPDATE trades SET entry_price = ? WHERE id = ?").run(Infinity, "usdt-unreconciled-test");

    const manager = makeAccountManager({
      binance: {
        isConnected: () => true,
        getBalance: async () => ({ marginEquity: 1000, marginCash: 1000, wallet: 1000, unrealizedPnl: 0 }),
        getPositions: async () => [], // flat on Binance → attribute broker fills
        getRecentTrades: async () => [
          // realizedPnl NaN (malformed broker data) → netPnl non-finite too.
          { time: Date.now(), side: "SELL", qty: 1, price: 95, realizedPnl: NaN, commission: 0 },
        ],
        hasFilledStopClose: async () => false,
        getAlgoOrderHistory: async () => [],
        getAccountTotal: async () => null,
      },
    });

    const { events: closed, detach } = captureEvent(EVENTS.POSITION_CLOSED);
    await (manager as any).syncBinanceFutures();
    detach();

    expect(getDB().prepare("SELECT close_reason FROM trades WHERE id = ?").get("usdt-unreconciled-test"))
      .toEqual({ close_reason: "MANUAL_CLOSE_UNRECONCILED" });
    expect(closed).toHaveLength(1);
    expect(closed[0].close_reason).toBe("MANUAL_CLOSE_UNRECONCILED");
  });

  // Same guard, the USDC sleeve's sync loop (a separate call site).
  test("syncBinanceUsdc does not overwrite a MANUAL_CLOSE_UNRECONCILED close_reason", async () => {
    seedOpenTrade("usdc-unreconciled-test", "momentum_crypto_usdc", { symbol: "BTC/USDC", market: "crypto" });
    getDB().prepare("UPDATE trades SET entry_price = ? WHERE id = ?").run(Infinity, "usdc-unreconciled-test");

    const manager = makeAccountManager();
    manager.attachUsdcExecutor({
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 1000, marginCash: 1000, wallet: 1000, unrealizedPnl: 0 }),
      getPositions: async () => [], // flat on Binance → attribute broker fills
      getRecentTrades: async () => [
        { time: Date.now(), side: "SELL", qty: 1, price: 95, realizedPnl: NaN, commission: 0 },
      ],
      hasFilledStopClose: async () => false,
      getAlgoOrderHistory: async () => [],
    } as any);

    await (manager as any).syncBinanceUsdc();

    expect(getDB().prepare("SELECT close_reason FROM trades WHERE id = ?").get("usdc-unreconciled-test"))
      .toEqual({ close_reason: "MANUAL_CLOSE_UNRECONCILED" });
  });
});

// 2026-08-07: tier-3 SL price fallback — the broker's own position mark.
// Prod symptom: "Alpaca SL price unavailable for ABBV/CAT/CVX" every 20-30min
// — the IEX tape is so sparse (~2.5-5% of consolidated volume) that a
// subscribed symbol can go >30s without a trade, starving BOTH the WS cache
// and the REST risk read, so the stop was never evaluated. The broker mark
// (getPositions().currentPrice) is available 24/7 and closes that hole, same
// tier structure as EquityTracker.buildSleevePriceMap.
describe("AccountManager stop-loss broker-mark fallback (tier 3)", () => {
  // Revert-falsifier: remove the getAlpacaMarks fallback in checkAllStopLoss
  // → price 0 → miss counted → continue → no close → this fails (that IS
  // today's prod behavior).
  test("cache empty + REST 0 + broker mark available → the stop IS evaluated and fires, logged as broker_mark", async () => {
    seedOpenTrade("mark-fallback-test", "momentum_stocks");
    let closeCalls = 0;
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getRiskPrice: async () => 0, // WS cache and REST both blind (sparse IEX tape)
        getPositions: async () => [{ symbol: "AAPL", currentPrice: 90 }], // broker's own mark: -10% breach
        closePosition: async () => { closeCalls++; return { success: true, filledPrice: 90, commission: 0 }; },
      },
    });
    const { output } = await withFakeMarketOpenDate(() => (manager as any).checkAllStopLoss());

    expect(closeCalls).toBe(1);
    expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'mark-fallback-test'").get()).toEqual({
      status: "closed", close_reason: "STOP_LOSS",
    });
    // The price source is recorded distinguishably: a stop fired off the
    // broker's mark (not a live trade) must say so.
    expect(output.some(line => line.includes("price source: broker_mark"))).toBe(true);
  });

  // Revert-falsifier: route the miss counting through the fallback wrongly
  // (e.g. use a zero/absent mark anyway) → either a fabricated close or no
  // escalation — both assertions break.
  test("all three sources empty (mark present but zero) → miss counted, escalation intact, no invented price", async () => {
    seedOpenTrade("mark-empty-test", "momentum_stocks");
    const { bursts, detach } = captureBursts();
    let closeCalls = 0;
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getRiskPrice: async () => 0,
        // The real getPositions coerces a malformed current_price to 0 —
        // a zero mark must never be used as a price.
        getPositions: async () => [{ symbol: "AAPL", currentPrice: 0 }],
        closePosition: async () => { closeCalls++; return { success: true, filledPrice: 90, commission: 0 }; },
      },
    });
    await withFakeMarketOpenDate(async () => {
      for (let i = 0; i < 5; i++) await (manager as any).checkAllStopLoss(); // cross the 5-miss threshold
    });
    detach();

    expect(closeCalls).toBe(0);
    expect(getDB().prepare("SELECT status FROM trades WHERE id = 'mark-empty-test'").get()).toEqual({ status: "open" });
    const priceBursts = bursts.filter(b => String(b.message).includes("SL price unavailable"));
    expect(priceBursts).toHaveLength(1); // escalation path unchanged
    expect(priceBursts[0].message).toContain("AAPL");
  });

  // Revert-falsifier: skip the (existing, shared) plausibility check for the
  // mark path → the ×20 garbage mark flows on and closes the row.
  test("an implausible broker mark is rejected in enforce mode — treated as a miss, never a close", async () => {
    const saved = process.env.PLAUSIBILITY_MODE;
    process.env.PLAUSIBILITY_MODE = "enforce";
    try {
      seedOpenTrade("mark-implausible-test", "momentum_stocks");
      let closeCalls = 0;
      const manager = makeAccountManager({
        alpaca: {
          isConnected: () => true,
          getRiskPrice: async () => 0,
          getPositions: async () => [{ symbol: "AAPL", currentPrice: 2000 }], // ×20 off our own entry fill (100)
          closePosition: async () => { closeCalls++; return { success: true, filledPrice: 2000, commission: 0 }; },
        },
      });
      const { bursts, detach } = captureBursts();
      await withFakeMarketOpenDate(async () => {
        for (let i = 0; i < 5; i++) await (manager as any).checkAllStopLoss();
      });
      detach();

      expect(closeCalls).toBe(0); // garbage mark never produced a close
      expect(getDB().prepare("SELECT status FROM trades WHERE id = 'mark-implausible-test'").get()).toEqual({ status: "open" });
      // Converted into the ordinary miss escalation — blind LOUDLY.
      expect(bursts.filter(b => String(b.message).includes("SL price unavailable"))).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.PLAUSIBILITY_MODE;
      else process.env.PLAUSIBILITY_MODE = saved;
    }
  });

  // Revert-falsifier: fetch marks per symbol instead of per pass → the call
  // count doubles (same criterion as buildSleevePriceMap: at most ONE
  // getPositions per pass, however many symbols missed).
  test("getPositions is called at most ONCE per pass even with multiple price-starved symbols", async () => {
    seedOpenTrade("mark-once-a", "momentum_stocks", { symbol: "AAPL" });
    seedOpenTrade("mark-once-b", "meanrev_stocks", { symbol: "JNJ", strategy: "MEANREV" });
    let getPositionsCalls = 0;
    let closeCalls = 0;
    const manager = makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getRiskPrice: async () => 0,
        getPositions: async () => {
          getPositionsCalls++;
          return [{ symbol: "AAPL", currentPrice: 90 }, { symbol: "JNJ", currentPrice: 90 }];
        },
        closePosition: async () => { closeCalls++; return { success: true, filledPrice: 90, commission: 0 }; },
      },
    });
    await withFakeMarketOpenDate(() => (manager as any).checkAllStopLoss());

    expect(getPositionsCalls).toBe(1); // one broker read served both symbols
    expect(closeCalls).toBe(2);        // and both stops were evaluated
  });

  // Pitfall #4 (AGENTS.md): cross-exchange price fallback caused false stops
  // historically. Even with an (adversarial) Alpaca mark for the Binance
  // symbol sitting in the map, the Binance branch must never read it.
  test("a Binance symbol NEVER receives an Alpaca price — even when the mark map contains it", async () => {
    seedOpenTrade("mark-venue-stock", "momentum_stocks", { symbol: "AAPL" });
    seedOpenTrade("mark-venue-btc", "momentum_crypto", { symbol: "BTC/USD", market: "crypto" });
    let binanceCloses = 0;
    const manager = makeAccountManager({
      binance: {
        isConnected: () => true,
        getPrice: async () => 0, // no Binance mark this pass
        closePosition: async () => { binanceCloses++; return { success: true, filledPrice: 50, commission: 0, realizedPnl: -50 }; },
      },
      alpaca: {
        isConnected: () => true,
        getRiskPrice: async () => 0,
        // Adversarial map: an Alpaca "mark" for the Binance symbol at a
        // deep-breach price. Only AAPL may consume from this map.
        getPositions: async () => [{ symbol: "AAPL", currentPrice: 90 }, { symbol: "BTC/USD", currentPrice: 50 }],
        closePosition: async () => ({ success: true, filledPrice: 90, commission: 0 }),
      },
    });
    await withFakeMarketOpenDate(() => (manager as any).checkAllStopLoss());

    expect(binanceCloses).toBe(0); // the -50% "breach" from the Alpaca mark never reached Binance
    expect(getDB().prepare("SELECT status FROM trades WHERE id = 'mark-venue-btc'").get()).toEqual({ status: "open" });
    expect(getDB().prepare("SELECT status, close_reason FROM trades WHERE id = 'mark-venue-stock'").get()).toEqual({
      status: "closed", close_reason: "STOP_LOSS", // the Alpaca symbol DID use its own venue's mark
    });
  });
});

describe("AccountManager Alpaca drift guard — corrupt sleeve ledger must page, not silence", () => {
  // computeSleeveLedger returns {equity: NaN} as its invalidity marker (by
  // design). Summing that NaN into sleevePnlSum made the drift guard's
  // Math.abs(gap) > 500 comparison ALWAYS false — the drift alarm went silent
  // exactly while the data was corrupt. Reverting the finiteness tracking in
  // syncAlpacaAccount makes this fail: NaN flows through, no ERROR_BURST fires.
  function corruptLedgerManager(latestPrice: number) {
    return makeAccountManager({
      alpaca: {
        isConnected: () => true,
        getAccount: async () => ({ equity: "100000", cash: "50000" }),
        getCachedPrice: () => 0,
        getLatestPrice: async () => latestPrice, // NaN → resolvePrice returns NaN → ledger invalidated
        getPositions: async () => [],            // mark fallback resolves nothing
      },
    });
  }

  test("a NaN sleeve ledger skips the drift comparison explicitly and emits ONE ERROR_BURST (cooldown, no page flood)", async () => {
    seedOpenTrade("corrupt-ledger-open", "momentum_stocks");
    const manager = corruptLedgerManager(NaN);
    const { bursts, detach } = captureBursts();
    try {
      await (manager as any).syncAlpacaAccount();
      await (manager as any).syncAlpacaAccount(); // second pass inside the cooldown window
    } finally {
      detach();
    }
    const ledgerBursts = bursts.filter(b => b.context === "AccountManager" && String(b.message).includes("sleeve ledger invalid"));
    expect(ledgerBursts).toHaveLength(1); // paged, but exactly once per cooldown window
    expect(String(ledgerBursts[0].message)).toContain("momentum_stocks");
  });

  test("a healthy sleeve ledger does not page", async () => {
    seedOpenTrade("healthy-ledger-open", "momentum_stocks");
    const manager = corruptLedgerManager(110);
    const { bursts, detach } = captureBursts();
    try {
      await (manager as any).syncAlpacaAccount();
    } finally {
      detach();
    }
    expect(bursts.filter(b => String(b.message).includes("sleeve ledger invalid"))).toHaveLength(0);
  });
});

describe("isSyncOwned", () => {
  // Locks Finding 1: SYNC_RECOVERY rows are AccountManager-inserted (UUID id),
  // NOT BrokerSync-owned. BrokerSync only auto-closes id-prefixed sync_ rows
  // (or the legacy BROKER_SYNC strategy tag). Misclassifying SYNC_RECOVERY as
  // sync-owned makes AccountManager skip reconciling it forever → permanent
  // phantom open row.
  test("does NOT treat a SYNC_RECOVERY row (bot-managed) as sync-owned", () => {
    expect(isSyncOwned({ id: "a-uuid-1234", strategy: "SYNC_RECOVERY" })).toBe(false);
  });

  test("treats sync_-prefixed ids as sync-owned regardless of strategy", () => {
    expect(isSyncOwned({ id: "sync_1234_abc", strategy: "SYNC_RECOVERY" })).toBe(true);
    expect(isSyncOwned({ id: "sync_1234_abc", strategy: null })).toBe(true);
  });

  test("treats the legacy BROKER_SYNC strategy tag as sync-owned", () => {
    expect(isSyncOwned({ id: "a-uuid-5678", strategy: "BROKER_SYNC" })).toBe(true);
  });

  test("does not treat a normal bot-managed row as sync-owned", () => {
    expect(isSyncOwned({ id: "a-uuid-9999", strategy: "MOMENTUM" })).toBe(false);
  });
});
