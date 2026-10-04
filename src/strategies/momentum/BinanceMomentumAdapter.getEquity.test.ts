// ══════════════════════════════════════════════
// BinanceMomentumAdapter.getEquity — must never return a plausible 0 on
// disconnect. 0 is a real balance value too; silently returning it let
// MomentumEngine size/gate off a fake wipeout instead of failing closed.
// ══════════════════════════════════════════════

import { describe, test, expect } from "bun:test";
import { BinanceMomentumAdapter } from "./BinanceMomentumAdapter";

describe("BinanceMomentumAdapter.getEquity", () => {
  test("throws when Binance is disconnected instead of returning 0", async () => {
    const binance = { isConnected: () => false } as any;
    const adapter = new BinanceMomentumAdapter({} as any, binance);
    await expect(adapter.getEquity()).rejects.toThrow("binance not connected");
  });

  test("returns margin equity, not wallet+unrealized", async () => {
    const binance = {
      isConnected: () => true,
      getBalance: async () => ({ marginEquity: 1200, marginCash: 800, wallet: 1000, unrealizedPnl: 50 }),
    } as any;
    const adapter = new BinanceMomentumAdapter({} as any, binance);
    expect(await adapter.getEquity()).toBe(1200);
  });
});
