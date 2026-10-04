// P1 2026-07-29: the Binance legs of close-all-positions.ts and
// close-crypto-now.ts closed the broker's AGGREGATE position
// (Math.abs(positionAmt)) — that would also liquidate any manual/unknown
// position we have no DB row for. Both legs are now bounded to
// min(Σ our DB rows, broker qty) via boundedCryptoCloseQty, the same rule
// the Alpaca leg got on 2026-07-27.

import { describe, expect, test } from "bun:test";
import { boundedCryptoCloseQty } from "./boundedCloseQty";

const row = (over: Partial<{ symbol: string; market: string; quantity: number; account_id: string | null }> = {}) => ({
  symbol: "ETH/USD", market: "crypto", quantity: 1.0, account_id: "momentum_crypto", ...over,
});

describe("boundedCryptoCloseQty", () => {
  test("no DB row of ours → 0 (manual/unknown position, do not touch)", () => {
    expect(boundedCryptoCloseQty([], "ETH/USD", 1.431)).toBe(0);
    expect(boundedCryptoCloseQty([row({ symbol: "BTC/USD" })], "ETH/USD", 1.431)).toBe(0);
    expect(boundedCryptoCloseQty([row({ market: "stock" })], "ETH/USD", 1.431)).toBe(0);
  });

  test("bounded by BOTH sides: min(our summed rows, broker qty), never the aggregate", () => {
    // Broker holds ours + a manual/unknown position: close only our share.
    expect(boundedCryptoCloseQty([row({ quantity: 0.5 })], "ETH/USD", 1.431)).toBe(0.5);
    // Broker holds LESS than our rows claim: never oversubmit.
    expect(boundedCryptoCloseQty([row({ quantity: 2.0 })], "ETH/USD", 1.431)).toBe(1.431);
    // Multiple rows for the symbol sum up.
    expect(boundedCryptoCloseQty([row({ quantity: 0.3 }), row({ quantity: 0.2, account_id: "momentum_crypto_usdc" })], "ETH/USD", 1.431)).toBeCloseTo(0.5, 12);
  });

  test("shadow_* rows are simulated fills — they never inflate our broker share", () => {
    expect(boundedCryptoCloseQty([row({ account_id: "shadow_momentum_crypto" })], "ETH/USD", 1.431)).toBe(0);
    expect(boundedCryptoCloseQty(
      [row({ quantity: 0.4 }), row({ quantity: 5, account_id: "shadow_momentum_crypto" })],
      "ETH/USD", 1.431,
    )).toBe(0.4);
  });

  test("degenerate inputs → 0 (a broken read must never become a close)", () => {
    expect(boundedCryptoCloseQty([row()], "ETH/USD", 0)).toBe(0);
    expect(boundedCryptoCloseQty([row()], "ETH/USD", NaN)).toBe(0);
    expect(boundedCryptoCloseQty([row({ quantity: NaN })], "ETH/USD", 1)).toBe(0);
  });
});

// Source-level falsifiers: these fail if either script reverts its Binance
// leg to closing the raw broker aggregate (same enforcement style as
// src/config/docs.test.ts). The dangerous reverted shape is
// `const qty = Math.abs(p.positionAmt)` feeding binance.closePosition.
describe("close scripts stay bounded to our DB rows (revert falsifier)", () => {
  const rawAggregateClose = /const qty = Math\.abs\(p\.positionAmt\)/;

  test("scripts/close-all-positions.ts binance leg uses boundedCryptoCloseQty and skips qty=0", async () => {
    const src = await Bun.file(new URL("../close-all-positions.ts", import.meta.url)).text();
    expect(src).toContain("boundedCryptoCloseQty(openRows, alpacaSym");
    expect(src).not.toMatch(rawAggregateClose);
  });

  test("scripts/close-crypto-now.ts uses boundedCryptoCloseQty and skips qty=0", async () => {
    const src = await Bun.file(new URL("../close-crypto-now.ts", import.meta.url)).text();
    expect(src).toContain("boundedCryptoCloseQty(openCrypto, alpacaSym");
    expect(src).not.toMatch(rawAggregateClose);
  });
});
