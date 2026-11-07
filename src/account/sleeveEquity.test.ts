// Shared-Alpaca-wallet equity attribution (2026-07-11 fix): both Alpaca
// sleeves carry a LEDGER equity (initial allocation + realized + unrealized of
// their OWN trades) so the consolidated view never counts the shared wallet
// 1.5×, and the momentum engine sizes on sleeve capital, not account equity.

import { describe, test, expect, beforeAll } from "bun:test";
import { closeTrade } from "../db/database";
import { computeSleeveLedger, buildSleevePriceMap, EquityTracker } from "./EquityTracker";
import { makeTestDb, seedOpenTrade } from "../test-support/db";

// (The AlpacaMomentumAdapter.getEquity tests that used to live here went with
// the adapter on 2026-11-07; the ledger math below is what the snapshot
// writer and the portfolio engine's Alpaca venue still share.)

beforeAll(() => {
  makeTestDb();

  // momentum_stocks: one closed winner (+$1000), one open AAPL position
  // (entry 100 × 10, marked at 110 ⇒ unrealized +$100).
  seedOpenTrade("ms-closed", "momentum_stocks", { symbol: "SPY", quantity: 10, entryTime: Date.now() - 3600_000 });
  closeTrade("ms-closed", 200, Date.now() - 1800_000);
  seedOpenTrade("ms-open", "momentum_stocks", { quantity: 10, entryTime: Date.now() });

  // meanrev_stocks: one closed loser (−$200).
  seedOpenTrade("mr-closed", "meanrev_stocks", { symbol: "KO", strategy: "MEANREV", entryPrice: 200, quantity: 2, entryTime: Date.now() - 3600_000 });
  closeTrade("mr-closed", 100, Date.now() - 1800_000);
});

describe("computeSleeveLedger", () => {
  test("equity = initial + realized + unrealized; cash = initial + realized − cost basis", () => {
    const open = [{ symbol: "AAPL", side: "buy", entryPrice: 100, quantity: 10 }];
    const l = computeSleeveLedger(50_000, 1000, open, () => 110);
    expect(l.unrealized).toBe(100);
    expect(l.equity).toBe(51_100);
    expect(l.cash).toBe(50_000); // 50000 + 1000 − 1000 cost basis
  });

  test("no price → falls back to entry (unrealized 0), never fabricates", () => {
    const open = [{ symbol: "X", side: "buy", entryPrice: 100, quantity: 5 }];
    const l = computeSleeveLedger(50_000, 0, open, () => 0);
    expect(l.unrealized).toBe(0);
    expect(l.equity).toBe(50_000);
  });

  test("cash floors at 0 when open cost basis exceeds initial + realized", () => {
    const open = [{ symbol: "X", side: "buy", entryPrice: 1000, quantity: 100 }];
    const l = computeSleeveLedger(50_000, 0, open, () => 0);
    expect(l.cash).toBe(0);
  });

  test("short side unrealized sign is correct", () => {
    const open = [{ symbol: "X", side: "sell", entryPrice: 100, quantity: 10 }];
    expect(computeSleeveLedger(0, 0, open, () => 90).unrealized).toBe(100);
    expect(computeSleeveLedger(0, 0, open, () => 110).unrealized).toBe(-100);
  });

  // ── fail-closed on corrupt rows (P1 regression, 2026-07-27) ─────────────
  // The per-leg pnlOf().pnl coercion kept `equity` FINITE while costBasis/
  // cash were poisoned NaN — syncLedger's fail-closed guard never fired and
  // the (since retired) AlpacaMomentumAdapter.getEquity fed a fabricated
  // equity to RiskGuard and position sizing. These tests FAIL under any per-leg coercion revert:
  // with quantity=NaN the coerced ledger yields a finite 51,100 equity.
  test("a quantity=NaN row invalidates the WHOLE ledger — never a finite equity next to healthy legs", () => {
    const open = [
      { symbol: "AAPL", side: "buy", entryPrice: 100, quantity: 10 },
      { symbol: "BAD", side: "buy", entryPrice: 100, quantity: NaN },
    ];
    const l = computeSleeveLedger(50_000, 1000, open, () => 110);
    expect(Number.isFinite(l.equity)).toBe(false);
    expect(Number.isFinite(l.cash)).toBe(false);
    expect(Number.isFinite(l.unrealized)).toBe(false);
  });

  test("an entryPrice=Infinity row invalidates the ledger (coercion would yield a plausible finite equity)", () => {
    const open = [{ symbol: "X", side: "buy", entryPrice: Infinity, quantity: 1 }];
    const l = computeSleeveLedger(50_000, 0, open, () => 0);
    expect(Number.isFinite(l.equity)).toBe(false);
  });

  test("a non-finite PRICE from the price source invalidates instead of silently falling back to entry", () => {
    const open = [{ symbol: "X", side: "buy", entryPrice: 100, quantity: 1 }];
    expect(Number.isFinite(computeSleeveLedger(50_000, 0, open, () => NaN).equity)).toBe(false);
  });

  test("end-to-end: corrupt row → invalidated ledger → syncLedger freezes at last good value (never accepts a fabricated equity)", () => {
    const t = new EquityTracker("momentum_stocks");
    const goodEquity = t.equity;
    const l = computeSleeveLedger(50_000, 0, [{ symbol: "X", side: "buy", entryPrice: 100, quantity: NaN }], () => 0);
    t.syncLedger(l.equity, l.cash);
    expect(t.equity).toBe(goodEquity); // frozen, not NaN and not a coerced fake
  });
});


describe("buildSleevePriceMap — the shared cache→REST resolver (2026-07-25 live bug)", () => {
  // Live bug shape: momentum_stocks snapshotted equity EXACTLY at seed value
  // because syncAlpacaAccount's price resolver was cache-only — a cold WS
  // cache (>~30s TTL) silently priced every open leg at its entry cost basis.
  const open = [{ symbol: "AAPL", side: "buy", entryPrice: 100, quantity: 10 }];

  test("cold cache + working REST fallback prices the open leg at REST, not entry — fails if the fallback is removed", async () => {
    const coldCacheWithRest = { getCachedPrice: () => 0, getLatestPrice: async () => 110 };
    const prices = await buildSleevePriceMap(coldCacheWithRest, open);
    const l = computeSleeveLedger(50_000, 0, open, s => prices.get(s) ?? 0);
    expect(l.unrealized).toBe(100); // (110-100)*10, NOT 0
    expect(l.equity).toBe(50_100);
  });

  test("cache AND REST both unavailable degrades to entry price — no throw, finite equity", async () => {
    const bothDown = { getCachedPrice: () => 0, getLatestPrice: async () => { throw new Error("timeout"); } };
    const prices = await buildSleevePriceMap(bothDown, open);
    const l = computeSleeveLedger(50_000, 0, open, s => prices.get(s) ?? 0);
    expect(Number.isFinite(l.equity)).toBe(true);
    expect(l.unrealized).toBe(0);
    expect(l.equity).toBe(50_000);
  });

  test("cache cold, REST 0, broker position mark available → values at the BROKER mark, not entry — the market-closed gap (2026-07-25 live: momentum_stocks −$524)", async () => {
    const marketClosed = {
      getCachedPrice: () => 0,
      getLatestPrice: async () => 0,
      getPositions: async () => [{ symbol: "AAPL", currentPrice: 115 }],
    };
    const prices = await buildSleevePriceMap(marketClosed, open);
    const l = computeSleeveLedger(50_000, 0, open, s => prices.get(s) ?? 0);
    expect(l.unrealized).toBe(150); // (115-100)*10, NOT 0 (would be entry-price fallback)
    expect(l.equity).toBe(50_150);
  });

  test("all three sources unavailable → still degrades to entry price, finite equity, no throw", async () => {
    const allDown = {
      getCachedPrice: () => 0,
      getLatestPrice: async () => 0,
      getPositions: async () => [], // broker has nothing resolvable either
    };
    const prices = await buildSleevePriceMap(allDown, open);
    const l = computeSleeveLedger(50_000, 0, open, s => prices.get(s) ?? 0);
    expect(Number.isFinite(l.equity)).toBe(true);
    expect(l.unrealized).toBe(0);
    expect(l.equity).toBe(50_000);
  });

  test("getPositions() throwing → contained, no exception escapes, degrades to entry price", async () => {
    const brokerThrows = {
      getCachedPrice: () => 0,
      getLatestPrice: async () => 0,
      getPositions: async () => { throw new Error("Alpaca getPositions malformed AAPL qty: bad"); },
    };
    const prices = await buildSleevePriceMap(brokerThrows, open);
    const l = computeSleeveLedger(50_000, 0, open, s => prices.get(s) ?? 0);
    expect(Number.isFinite(l.equity)).toBe(true);
    expect(l.equity).toBe(50_000);
  });

  test("getPositions() called at most once, even with several cold symbols", async () => {
    let calls = 0;
    const multi = [
      { symbol: "AAPL", side: "buy", entryPrice: 100, quantity: 10 },
      { symbol: "NVDA", side: "buy", entryPrice: 200, quantity: 5 },
      { symbol: "XLF", side: "buy", entryPrice: 30, quantity: 20 },
    ];
    const source = {
      getCachedPrice: () => 0,
      getLatestPrice: async () => 0,
      getPositions: async () => { calls++; return [{ symbol: "AAPL", currentPrice: 110 }, { symbol: "NVDA", currentPrice: 210 }, { symbol: "XLF", currentPrice: 31 }]; },
    };
    await buildSleevePriceMap(source, multi);
    expect(calls).toBe(1);
  });

  test("getPositions() NOT called at all when the cache already resolved everything", async () => {
    let calls = 0;
    const source = {
      getCachedPrice: (s: string) => (s === "AAPL" ? 110 : 0),
      getLatestPrice: async () => 0,
      getPositions: async () => { calls++; return []; },
    };
    await buildSleevePriceMap(source, open); // only AAPL, resolved by cache
    expect(calls).toBe(0);
  });
});

