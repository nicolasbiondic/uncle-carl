// BinanceMomentumAdapter.getOpenPositions contract (2026-09-28):
//  - entryTime from the trade row — MomentumEngineConfig.reunderwriteBefore
//    (the one-shot MODEL_CUTOVER) skips positions without it. Missing, the
//    USDC daily kernel's first pass (2026-09-27) kept the hourly model's
//    UNI/NEAR/BCH instead of re-underwriting them.
//  - notional at the MARK price (what the replay's SimBroker uses for the
//    gross-exposure cap), derived from one positionRisk read; entry price
//    only when the broker read fails.
import { describe, expect, test, beforeAll } from "bun:test";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";
import { AlpacaMomentumAdapter } from "./AlpacaMomentumAdapter";
import { MomentumEngine } from "./MomentumEngine";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";

beforeAll(() => { makeTestDb(); });

const ENTRY = Date.UTC(2026, 7, 29, 1, 16, 52);

describe("BinanceMomentumAdapter.getOpenPositions", () => {
  test("carries the row's entryTime and values the position at the mark price", async () => {
    seedOpenTrade("uni-row", "op_usdc", { symbol: "UNI/USDC", market: "crypto", entryPrice: 4.421, quantity: 377, entryTime: ENTRY });
    const bin = {
      isConnected: () => true,
      // mark = 4.421 + 1971.46 / 377 = 9.65
      getPositions: async () => [{ symbol: "UNIUSDC", positionAmt: 377, entryPrice: 4.421, unrealizedProfit: 1971.463, leverage: 2, updateTime: 1 }],
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, bin, { accountId: "op_usdc", quoteAsset: "USDC" });
    const [p] = await adapter.getOpenPositions();
    expect(p.entryTime).toBe(ENTRY);
    expect(p.notional).toBeCloseTo(377 * (4.421 + 1971.463 / 377), 6);
    expect(p.notional).toBeGreaterThan(377 * 4.421 * 2); // winner valued at mark, not entry cost
  });

  test("a failing positionRisk read never throws — entry-price notional, entryTime still present", async () => {
    seedOpenTrade("near-row", "op_usdc2", { symbol: "NEAR/USDC", market: "crypto", entryPrice: 2.16, quantity: 192, entryTime: ENTRY });
    const bin = { isConnected: () => true, getPositions: async () => { throw new Error("timeout"); } } as any;
    const adapter = new BinanceMomentumAdapter({} as any, bin, { accountId: "op_usdc2", quoteAsset: "USDC" });
    const [p] = await adapter.getOpenPositions();
    expect(p.notional).toBeCloseTo(192 * 2.16, 6);
    expect(p.entryTime).toBe(ENTRY);
  });
});

describe("every DB-backed live adapter exposes entryTime (MODEL_CUTOVER depends on it)", () => {
  test("Alpaca and Binance adapters agree on the contract", async () => {
    seedOpenTrade("aapl-row", "op_alpaca", { symbol: "AAPL", market: "stock", entryPrice: 332, quantity: 75, entryTime: ENTRY });
    const alpaca = new AlpacaMomentumAdapter({ getCachedPrice: () => 341 } as any, { accountId: "op_alpaca" });
    expect((await alpaca.getOpenPositions())[0].entryTime).toBe(ENTRY);
    seedOpenTrade("sol-row", "op_binance", { symbol: "SOL/USD", market: "crypto", entryPrice: 121, quantity: 10, entryTime: ENTRY });
    const binance = new BinanceMomentumAdapter({} as any, { isConnected: () => true, getPositions: async () => [] } as any, { accountId: "op_binance" });
    expect((await binance.getOpenPositions())[0].entryTime).toBe(ENTRY);
  });

  test("an engine wired with reunderwriteBefore closes a Binance position entered before the boundary", async () => {
    seedOpenTrade("bch-row", "op_cutover", { symbol: "BCH/USD", market: "crypto", entryPrice: 338, quantity: 7, entryTime: ENTRY });
    const closes: any[] = [];
    const bin = {
      isConnected: () => true,
      getPositions: async () => [{ symbol: "BCHUSDT", positionAmt: 7, entryPrice: 338, unrealizedProfit: 0, leverage: 2, updateTime: 1 }],
      getBalance: async () => ({ marginEquity: 5000 }),
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, bin, { accountId: "op_cutover" });
    // Only the cutover path matters here: stub the close, keep the real getOpenPositions.
    (adapter as any).closePosition = async (a: any) => { closes.push(a); return { ok: true }; };
    (adapter as any).fetchCandles = async () => [];
    const engine = new MomentumEngine({
      universe: ["BCH/USD"], mode: "time-series", reunderwriteBefore: Date.UTC(2026, 8, 27),
      regime: { minSymbolsForCorrelation: 100 },
    } as any, adapter as any, { info() {}, warn() {}, error() {}, debug() {} } as any);
    await engine.tick();
    expect(closes.map(c => [c.symbol, c.closeReason])).toEqual([["BCH/USD", "MODEL_CUTOVER"]]);
  });
});
