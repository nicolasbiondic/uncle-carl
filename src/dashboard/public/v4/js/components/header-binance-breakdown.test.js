// ══════════════════════════════════════════════
// Binance wallet decomposition (mandate 2026-07-19): Total = FAPI main + DAPI
// main, decomposed into FOUR independently-sourced components — USDT Futures
// margin equity, USDC Futures margin equity, FAPI BTC collateral USD, COIN-M
// BTC margin equity. The total is built bottom-up as the sum of whatever
// components are present ("do not start from total then add assets"); each
// present component is labeled exactly once. A missing component (its sleeve
// inactive/never enabled) degrades gracefully instead of blanking everything.
// Since 2026-10-25 it is the tooltip of the Binance cell in the KPI strip (it
// rode in the header balance pill, which is gone); Alpaca has no breakdown.
// ══════════════════════════════════════════════

import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { renderProfiles, walletBreakdownTitle } from "./profiles.js";

const originalState = { ...store.state };
afterEach(() => Object.assign(store.state, originalState));

describe("Binance wallet decomposition", () => {
  test("production shape: all 4 sleeves active — total = sum of all 4, each labeled exactly once", () => {
    const title = walletBreakdownTitle({ marginBreakdown: { usdtFutures: 4700, usdcFutures: 900, fapiBtcCollateral: 650, coinmMargin: 1200 } });
    // Total = 4700 + 900 + 650 + 1200 = 7450, built bottom-up.
    expect(title).toContain("Total $7,450.00");
    for (const label of ["USDT Futures", "USDC Futures", "FAPI BTC collateral", "COIN-M BTC margin"]) {
      expect((title.match(new RegExp(label, "g")) || []).length).toBe(1);
    }
    for (const v of ["$4,700.00", "$900.00", "$650.00", "$1,200.00"]) expect(title).toContain(v);
  });

  test("USDC/COIN-M sleeves inactive (never enabled): total collapses to USDT + FAPI BTC collateral only, no phantom components", () => {
    const title = walletBreakdownTitle({ marginBreakdown: { usdtFutures: 5000, usdcFutures: null, fapiBtcCollateral: 650, coinmMargin: null } });
    expect(title).toContain("Total $5,650.00"); // 5000 + 650, no addition error
    expect(title).not.toContain("USDC Futures");
    expect(title).not.toContain("COIN-M");
  });

  test("everything unavailable, or no marginBreakdown at all, gives no title (not a fabricated $0)", () => {
    expect(walletBreakdownTitle({ marginBreakdown: { usdtFutures: null, usdcFutures: null, fapiBtcCollateral: null, coinmMargin: null } })).toBe("");
    expect(walletBreakdownTitle({ marginBreakdown: null })).toBe("");
    expect(walletBreakdownTitle(undefined)).toBe("");
  });

  test("the Binance cell carries it as its tooltip; the Alpaca cell does not", () => {
    Object.assign(store.state, {
      lang: "en", period: 1,
      dashboard: { accounts: [
        { id: "momentum_stocks", label: "Stocks", broker: "alpaca", equity: 1, initialEquity: 1 },
        { id: "momentum_crypto", label: "Crypto", broker: "binance", equity: 1, initialEquity: 1 },
      ] },
      profiles: [{ brokerAccounts: [
        { brokerId: "alpaca_paper", equity: 100000, marginBreakdown: { usdtFutures: 1 } },
        { brokerId: "binance_testnet", equity: 5000, marginBreakdown: { usdtFutures: 5000, usdcFutures: 900 } },
      ] }],
    });
    const html = renderProfiles();
    expect(html).toMatch(/data-broker="binance"[^>]*title="[^"]*Total \$5,900\.00 = USDT Futures/);
    expect(html).not.toMatch(/data-broker="alpaca"[^>]*title="[^"]*Total/);
  });
});
