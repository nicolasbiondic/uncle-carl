// ══════════════════════════════════════════════
// BinanceMomentumAdapter quote-asset isolation (2026-07-19)
//
// A USDC-configured adapter must own only "*/USDC" internal symbols and
// never mutate/read a USDT-style symbol (and vice versa for the default
// USDT adapter, which must stay behavior-compatible with momentum_crypto
// today). Translation is adapter-owned (not the executor instance), so
// these tests use plain mock `binance` objects — same style as
// adapterPersist.test.ts — with no real BinanceExecutor involved.
// ══════════════════════════════════════════════

import { describe, test, expect, beforeAll } from "bun:test";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";

beforeAll(() => {
  makeTestDb();
});

describe("BinanceMomentumAdapter — quoteAsset symbol ownership", () => {
  test("default (USDT) adapter translates BTC/USD -> BTCUSDT, matching momentum_crypto today", async () => {
    const captured: { symbol: string | null } = { symbol: null };
    const binance = {
      isConnected: () => true,
      getPrice: async (sym: string) => { captured.symbol = sym; return 0; }, // 0 price -> short-circuit before any mutation
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, binance); // no quoteAsset override
    const res = await adapter.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
    expect(captured.symbol).toBe("BTCUSDT");
    expect(res).toEqual({ ok: false, reason: "no price for BTCUSDT" });
  });

  test("USDC adapter translates BTC/USDC -> BTCUSDC", async () => {
    const captured: { symbol: string | null } = { symbol: null };
    const binance = {
      isConnected: () => true,
      getPrice: async (sym: string) => { captured.symbol = sym; return 0; },
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, binance, { accountId: "momentum_crypto_usdc", quoteAsset: "USDC" });
    const res = await adapter.openPosition({ symbol: "BTC/USDC", side: "buy", notionalUsd: 1000 });
    expect(captured.symbol).toBe("BTCUSDC");
    expect(res).toEqual({ ok: false, reason: "no price for BTCUSDC" });
  });

  test("USDC adapter refuses a USDT-style symbol before touching the broker", async () => {
    let priceCalled = false;
    const binance = {
      isConnected: () => true,
      getPrice: async () => { priceCalled = true; return 100; },
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, binance, { quoteAsset: "USDC" });
    const res = await adapter.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "no binance mapping for BTC/USD" });
    expect(priceCalled).toBe(false);
  });

  test("default USDT adapter refuses a USDC-style symbol before touching the broker", async () => {
    let priceCalled = false;
    const binance = {
      isConnected: () => true,
      getPrice: async () => { priceCalled = true; return 100; },
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, binance);
    const res = await adapter.openPosition({ symbol: "BTC/USDC", side: "buy", notionalUsd: 1000 });
    expect(res).toEqual({ ok: false, reason: "no binance mapping for BTC/USDC" });
    expect(priceCalled).toBe(false);
  });

  test("getOpenPositions scopes to the adapter's own quote asset — USDT- and USDC-style rows coexist without leaking", async () => {
    // Ownership is DB-anchored (see the adapter invariant): rows of both
    // quote styles under ONE account_id, each adapter sees only its own.
    seedOpenTrade("qa-usdt-row", "qa_quote_scope", { symbol: "BTC/USD", market: "crypto", entryTime: Date.now() });
    seedOpenTrade("qa-usdc-row", "qa_quote_scope", { symbol: "BTC/USDC", market: "crypto", entryPrice: 101, quantity: 2, entryTime: Date.now() });
    const binance = { isConnected: () => true } as any;

    const usdt = new BinanceMomentumAdapter({} as any, binance, { accountId: "qa_quote_scope" });
    expect(await usdt.getOpenPositions()).toEqual([{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 100, entryTime: expect.any(Number) }]);

    const usdc = new BinanceMomentumAdapter({} as any, binance, { accountId: "qa_quote_scope", quoteAsset: "USDC" });
    expect(await usdc.getOpenPositions()).toEqual([{ symbol: "BTC/USDC", side: "buy", quantity: 2, notional: 202, entryTime: expect.any(Number) }]);
  });

  test("closePosition ownership check happens BEFORE any broker read — a USDC adapter given BTCUSDT-shaped input never calls getPositions", async () => {
    let positionsCalled = 0;
    const binance = { isConnected: () => true, getPositions: async () => { positionsCalled++; return []; } } as any;
    const adapter = new BinanceMomentumAdapter({} as any, binance, { quoteAsset: "USDC" });

    const res = await adapter.closePosition({ symbol: "BTC/USD", side: "buy" }); // wrong quote style
    expect(res).toEqual({ ok: false, reason: "no binance mapping for BTC/USD" });
    expect(positionsCalled).toBe(0);
  });

  test("default USDT adapter closePosition still resolves BTC/USD -> BTCUSDT (regression)", async () => {
    // A DB row of ours must exist for the close path to reach the broker at
    // all (ownership is DB-anchored) — the broker being flat then reconciles.
    seedOpenTrade("qa-close-flat", "qa_close_flat", { symbol: "BTC/USD", market: "crypto", entryTime: Date.now() });
    const binance = {
      isConnected: () => true,
      getPositions: async () => { return [{ symbol: "BTCUSDT", positionAmt: 0, entryPrice: 0 }]; },
      cancelAllOrders: async () => {},
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, binance, { accountId: "qa_close_flat" });
    const res = await adapter.closePosition({ symbol: "BTC/USD", side: "buy" });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("already flat");
  });
});
