import { describe, expect, test, beforeAll } from "bun:test";
import { getDB } from "../db/database";
import { ShadowAdapter, SHADOW_SLIPPAGE, type ShadowPriceSource } from "./ShadowAdapter";
import type { OHLCV } from "../utils/types";
import { makeTestDb } from "../test-support/db";

beforeAll(() => {
  makeTestDb();
});

function priceSource(cached: Record<string, number>, latest: Record<string, number> = {}, bars: OHLCV[] = []): ShadowPriceSource {
  return {
    getCachedPrice: (s) => cached[s] ?? 0,
    getLatestPrice: async (s) => latest[s] ?? 0,
    getBars: async () => bars,
  };
}

let acct = 0;
// Default kline seam returns [] (→ Alpaca fallback) so no test hits the network.
function makeAdapter(prices: ShadowPriceSource, cfg: Record<string, any> = {}, klines: (s: string, tf?: string, n?: number) => Promise<OHLCV[]> = async () => []) {
  return new ShadowAdapter(prices, {
    accountId: `shadow_test_${acct++}`,
    strategy: "TEST",
    closeReason: "TEST_EXIT",
    timeframe: "1Day",
    baseUsd: 50_000,
    market: "stock",
    ...cfg,
  }, klines as any);
}

function kline(close: number, ageMs: number): OHLCV {
  return { timestamp: Date.now() - ageMs, open: close, high: close, low: close, close, volume: 1 };
}

describe("ShadowAdapter — simulated opens", () => {
  test("buy fills at cached price + 2bps adverse, whole shares for stocks", async () => {
    const a = makeAdapter(priceSource({ AAPL: 100 }));
    const res = await a.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 5_000 });
    expect(res.ok).toBe(true);

    const row = getDB().prepare(`SELECT * FROM trades WHERE account_id = ? AND symbol = 'AAPL'`).get(a.accountId) as any;
    expect(row.status).toBe("open");
    expect(row.market).toBe("stock");
    expect(row.strategy).toBe("TEST");
    expect(row.entry_price).toBeCloseTo(100 * (1 + SHADOW_SLIPPAGE), 6);
    expect(row.quantity).toBe(Math.floor(5_000 / (100 * (1 + SHADOW_SLIPPAGE)))); // 49 whole shares
  });

  test("falls back to getLatestPrice when no cached price", async () => {
    const a = makeAdapter(priceSource({}, { MSFT: 200 }));
    const res = await a.openPosition({ symbol: "MSFT", side: "buy", notionalUsd: 2_000 });
    expect(res.ok).toBe(true);
    const row = getDB().prepare(`SELECT entry_price FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.entry_price).toBeCloseTo(200 * (1 + SHADOW_SLIPPAGE), 6);
  });

  test("no price anywhere → rejected, nothing written", async () => {
    const a = makeAdapter(priceSource({}));
    const res = await a.openPosition({ symbol: "GHOST", side: "buy", notionalUsd: 1_000 });
    expect(res.ok).toBe(false);
    const row = getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.c).toBe(0);
  });

  test("crypto market allows fractional quantity", async () => {
    const crypto = makeAdapter(priceSource({ "BTC/USD": 50_000 }), { market: "crypto" });
    const res = await crypto.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 5_000 });
    expect(res.ok).toBe(true);
    const row = getDB().prepare(`SELECT quantity FROM trades WHERE account_id = ?`).get(crypto.accountId) as any;
    expect(row.quantity).toBeGreaterThan(0);
    expect(row.quantity).toBeLessThan(1); // fractional BTC
  });
});

describe("ShadowAdapter — simulated closes and PnL math", () => {
  test("close fills at price − 2bps, writes pnl and close_reason", async () => {
    const a = makeAdapter(priceSource({ AAPL: 100 }));
    await a.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 5_000 });

    // Price rallies to 110 — close.
    const a2 = new ShadowAdapter(priceSource({ AAPL: 110 }), {
      accountId: a.accountId, strategy: "TEST", closeReason: "TEST_EXIT",
      timeframe: "1Day", baseUsd: 50_000, market: "stock",
    });
    const res = await a2.closePosition({ symbol: "AAPL", side: "buy" });
    expect(res.ok).toBe(true);

    const row = getDB().prepare(`SELECT * FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.status).toBe("closed");
    expect(row.close_reason).toBe("TEST_EXIT");
    const entry = 100 * (1 + SHADOW_SLIPPAGE);
    const exit = 110 * (1 - SHADOW_SLIPPAGE);
    expect(row.exit_price).toBeCloseTo(exit, 6);
    expect(row.pnl).toBeCloseTo((exit - entry) * row.quantity, 4);

    // Equity = base + closed pnl; realized-since window respected.
    expect(await a2.getEquity()).toBeCloseTo(50_000 + row.pnl, 4);
    expect(await a2.getRealisedPnlSince(Date.now() - 60_000)).toBeCloseTo(row.pnl, 4);
    expect(await a2.getRealisedPnlSince(Date.now() + 60_000)).toBe(0);
    expect(await a2.getOpenPositions()).toHaveLength(0);
  });

  test("close with no open row → rejected", async () => {
    const a = makeAdapter(priceSource({ AAPL: 100 }));
    const res = await a.closePosition({ symbol: "AAPL", side: "buy" });
    expect(res.ok).toBe(false);
  });
});

describe("ShadowAdapter — positions and candles", () => {
  test("getOpenPositions marks notional to cached price and carries entryTime", async () => {
    const a = makeAdapter(priceSource({ NVDA: 100 }));
    await a.openPosition({ symbol: "NVDA", side: "buy", notionalUsd: 1_000 });

    const marked = new ShadowAdapter(priceSource({ NVDA: 120 }), {
      accountId: a.accountId, strategy: "TEST", closeReason: "TEST_EXIT",
      timeframe: "1Day", baseUsd: 50_000, market: "stock",
    });
    const pos = await marked.getOpenPositions();
    expect(pos).toHaveLength(1);
    expect(pos[0].symbol).toBe("NVDA");
    expect(pos[0].notional).toBeCloseTo(pos[0].quantity * 120, 4);
    expect(pos[0].entryTime).toBeGreaterThan(0);
  });

  test("fetchCandles delegates to the price source", async () => {
    const bars: OHLCV[] = [{ open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, timestamp: 123 }];
    const a = makeAdapter(priceSource({}, {}, bars));
    expect(await a.fetchCandles("AAPL", 100)).toEqual(bars);
  });
});

// ══════════════════════════════════════════════
// Crypto price source = Binance klines (the shadow_momentum_crypto fix):
// currentPrice must use the SAME source as fetchCandles. Before the fix,
// crypto prices came from Alpaca (sparse/contended → 0) and every simulated
// open failed "no price" — the shadow book recorded nothing for weeks and
// the sleeve's demotion was de-facto permanent.
// ══════════════════════════════════════════════
describe("ShadowAdapter — crypto price via Binance klines", () => {
  test("Alpaca dead + fresh kline → open SUCCEEDS at the kline close", async () => {
    // Alpaca returns 0 everywhere (the live failure mode: WS 406 + sparse REST).
    let klineCalls = 0;
    const a = makeAdapter(priceSource({}), { timeframe: "1Hour", market: "crypto" },
      async () => { klineCalls++; return [kline(3_000, 30 * 60_000)]; });

    const res = await a.openPosition({ symbol: "LINK/USD", side: "buy", notionalUsd: 1_000 });
    expect(res.ok).toBe(true); // pre-fix: { ok: false, reason: "no price for LINK/USD" }
    expect(klineCalls).toBeGreaterThan(0);

    const row = getDB().prepare(`SELECT * FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.status).toBe("open");
    expect(row.entry_price).toBeCloseTo(3_000 * (1 + SHADOW_SLIPPAGE), 6);
  });

  test("stale kline (older than 2× bar interval) → 0, open fails clean, nothing written", async () => {
    // 1Hour timeframe: a kline opened 3h ago is outside the 2h freshness window.
    const a = makeAdapter(priceSource({}), { timeframe: "1Hour", market: "crypto" },
      async () => [kline(3_000, 3 * 3_600_000)]);

    const res = await a.openPosition({ symbol: "LINK/USD", side: "buy", notionalUsd: 1_000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no price");
    const row = getDB().prepare(`SELECT COUNT(*) c FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.c).toBe(0);
  });

  test("empty klines → falls back to Alpaca (mirrors fetchCandles)", async () => {
    const a = makeAdapter(priceSource({ "BTC/USD": 50_000 }), { timeframe: "1Hour", market: "crypto" },
      async () => []);
    const res = await a.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 5_000 });
    expect(res.ok).toBe(true);
    const row = getDB().prepare(`SELECT entry_price FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.entry_price).toBeCloseTo(50_000 * (1 + SHADOW_SLIPPAGE), 6);
  });

  test("stock sleeve NEVER touches klines — Alpaca path unchanged", async () => {
    let klineCalls = 0;
    const a = makeAdapter(priceSource({ AAPL: 100 }), { market: "stock" },
      async () => { klineCalls++; return [kline(999, 0)]; });
    const res = await a.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1_000 });
    expect(res.ok).toBe(true);
    expect(klineCalls).toBe(0);
    const row = getDB().prepare(`SELECT entry_price FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.entry_price).toBeCloseTo(100 * (1 + SHADOW_SLIPPAGE), 6);
  });
});

// ══════════════════════════════════════════════
// OPEN.md P3-2: a demoted (shadow) engine's own row must arm the SAME
// vol-scaled stop a live one would — AlpacaMomentumAdapter derives
// trades.stop_loss from the REAL fill; the shadow book must derive it from
// its SIMULATED fill the same way (side-aware), or a demoted sleeve's
// checkAllStopLoss-equivalent bookkeeping silently reverts to the profile's
// fixed pct on every shadow position.
// ══════════════════════════════════════════════
describe("ShadowAdapter — stopLossPct persists trades.stop_loss (P3-2)", () => {
  test("buy fill + stopLossPct → stop_loss = fill × (1 − pct/100)", async () => {
    const a = makeAdapter(priceSource({ AAPL: 100 }));
    const res = await a.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 5_000, stopLossPct: 5 });
    expect(res.ok).toBe(true);

    const row = getDB().prepare(`SELECT entry_price, stop_loss FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.stop_loss).toBeCloseTo(row.entry_price * 0.95, 10);
  });

  test("sell (short) fill + stopLossPct → stop_loss = fill × (1 + pct/100)", async () => {
    const a = makeAdapter(priceSource({ AAPL: 100 }));
    const res = await a.openPosition({ symbol: "AAPL", side: "sell", notionalUsd: 5_000, stopLossPct: 5 });
    expect(res.ok).toBe(true);

    const row = getDB().prepare(`SELECT entry_price, stop_loss FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.stop_loss).toBeCloseTo(row.entry_price * 1.05, 10);
  });

  test("no stopLossPct → stop_loss NULL (legacy fixed-distance consumers unchanged)", async () => {
    const a = makeAdapter(priceSource({ AAPL: 100 }));
    const res = await a.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 5_000 });
    expect(res.ok).toBe(true);

    const row = getDB().prepare(`SELECT stop_loss FROM trades WHERE account_id = ?`).get(a.accountId) as any;
    expect(row.stop_loss).toBeNull();
  });
});
