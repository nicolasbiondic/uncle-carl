// Shared-Alpaca-wallet equity attribution (2026-07-11 fix): both Alpaca
// sleeves carry a LEDGER equity (initial allocation + realized + unrealized of
// their OWN trades) so the consolidated view never counts the shared wallet
// 1.5×, and the momentum engine sizes on sleeve capital, not account equity.

import { describe, test, expect, beforeAll } from "bun:test";
import { closeTrade, getTradingStats, getOpenTrades } from "../db/database";
import { computeSleeveLedger, buildSleevePriceMap, EquityTracker } from "./EquityTracker";
import { RISK_PROFILES, type RiskProfileId } from "../config/riskProfiles";
import { makeTestDb, seedOpenTrade } from "../test-support/db";

// The three original v8 sleeves this file's fixtures seed/exercise.
// momentum_crypto_usdc/momentum_btc (2026-07-19) are separate wallets with
// their own tests (src/account/coinmUsdcSleeves.test.ts) — they must NOT
// enter this file's "shared Alpaca wallet counted once" totals.
const V8_SLEEVE_IDS: RiskProfileId[] = ["momentum_stocks", "meanrev_stocks", "momentum_crypto"];
import { AlpacaMomentumAdapter } from "../strategies/momentum/AlpacaMomentumAdapter";

const stubAlpaca = {
  getCachedPrice: (s: string) => (s === "AAPL" ? 110 : 0),
  getLatestPrice: async () => 0,
} as any;

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
  // AlpacaMomentumAdapter.getEquity fed a fabricated equity to RiskGuard and
  // position sizing. These tests FAIL under any per-leg coercion revert:
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

describe("AlpacaMomentumAdapter.getEquity — sleeve ledger, not account equity", () => {
  test("momentum_stocks sizes on its 50k allocation + its own pnl", async () => {
    const adapter = new AlpacaMomentumAdapter(stubAlpaca);
    expect(await adapter.getEquity()).toBe(50_000 + 1000 + 100); // 51,100
  });

  test("meanrev_stocks sees only its own realized pnl", async () => {
    const adapter = new AlpacaMomentumAdapter(stubAlpaca, {
      accountId: "meanrev_stocks", timeframe: "1Day", strategy: "MEANREV", closeReason: "MEANREV_EXIT",
    });
    expect(await adapter.getEquity()).toBe(50_000 - 200); // 49,800
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

  test("adapter.getEquity() and the snapshot-writer's own buildSleevePriceMap+computeSleeveLedger call agree — the invariant that was broken", async () => {
    // Same shape AccountManager.syncAlpacaAccount uses: pre-build the price
    // map, then feed computeSleeveLedger the exact same way the adapter does.
    const coldCacheWithRest = { getCachedPrice: () => 0, getLatestPrice: async () => 110 };
    const adapter = new AlpacaMomentumAdapter(coldCacheWithRest as any);

    const adapterEquity = await adapter.getEquity();

    const openTrades = getOpenTrades("momentum_stocks");
    const prices = await buildSleevePriceMap(coldCacheWithRest, openTrades);
    const initial = RISK_PROFILES.momentum_stocks.initialEquity;
    const realized = getTradingStats("momentum_stocks").totalPnl;
    const writerEquity = computeSleeveLedger(initial, realized, openTrades, s => prices.get(s) ?? 0).equity;

    expect(adapterEquity).toBe(writerEquity);
  });
});

describe("consolidated equity has NO double count", () => {
  test("Σ(sleeve ledger equity) = Σ(initial allocations) + total pnl — the shared wallet is counted once", async () => {
    const ms = await new AlpacaMomentumAdapter(stubAlpaca).getEquity();
    const mr = await new AlpacaMomentumAdapter(stubAlpaca, {
      accountId: "meanrev_stocks", timeframe: "1Day", strategy: "MEANREV", closeReason: "MEANREV_EXIT",
    }).getEquity();
    const crypto = RISK_PROFILES.momentum_crypto.initialEquity; // no trades seeded → ledger = initial

    const totalInitial = V8_SLEEVE_IDS.reduce((s, id) => s + RISK_PROFILES[id].initialEquity, 0);
    expect(totalInitial).toBe(105_000); // 50k + 50k + 5k — NOT 155k (old 100k momentum_stocks)

    const realized = getTradingStats("momentum_stocks").totalPnl + getTradingStats("meanrev_stocks").totalPnl;
    const unrealized = 100; // AAPL open position marked at 110
    expect(ms + mr + crypto).toBeCloseTo(totalInitial + realized + unrealized, 6); // 105,900

    // The pre-fix bug shape: momentum_stocks = whole broker account (~101.5k)
    // + meanrev 50k ⇒ alpaca counted 1.5×. Both sleeves must sum to the 100k
    // Alpaca allocation + their v8 pnl instead.
    expect(ms + mr).toBeCloseTo(100_000 + realized + unrealized, 6); // 100,900
  });
});
