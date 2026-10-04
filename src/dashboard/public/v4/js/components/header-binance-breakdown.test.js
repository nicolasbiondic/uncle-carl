// ══════════════════════════════════════════════
// Binance header pill (mandate 2026-07-19): Total = FAPI main + DAPI main,
// decomposed into FOUR independently-sourced components — USDT Futures
// margin equity, USDC Futures margin equity, FAPI BTC collateral USD,
// COIN-M BTC margin equity. The displayed total is built bottom-up as the
// sum of whatever components are present ("do not start from total then add
// assets"); each present component is labeled exactly once. A component
// missing (its sleeve inactive/never enabled) degrades gracefully instead of
// blanking the whole pill. Alpaca stays a plain figure.
// ══════════════════════════════════════════════

import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { renderHeader } from "./header.js";

const originalState = { ...store.state };
afterEach(() => Object.assign(store.state, originalState));

const withBinance = (marginBreakdown) => ({
  ...store.state,
  connections: { alpaca: { connected: true }, binance: { connected: true } },
  profiles: [{
    brokerAccounts: [
      { brokerId: "binance_testnet", equity: 5000, marginBreakdown },
    ],
  }],
});

describe("Binance header decomposition", () => {
  test("production shape: all 4 sleeves active — total = sum of all 4, each labeled exactly once", () => {
    Object.assign(store.state, withBinance({
      usdtFutures: 4700, usdcFutures: 900, fapiBtcCollateral: 650, coinmMargin: 1200,
    }));
    const html = renderHeader();
    // Total = 4700 + 900 + 650 + 1200 = 7450, built bottom-up (never a
    // separately-fetched "total" the components are subtracted from).
    expect(html).toContain("$7,450.00");
    const visible = html.match(/<span class="pill-sub">([\s\S]*?)<\/span>/)?.[1] || "";
    for (const label of ["USDT Futures", "USDC Futures", "FAPI BTC collateral", "COIN-M BTC margin"]) {
      expect((visible.match(new RegExp(label, "g")) || []).length).toBe(1);
    }
    expect(html).toContain("$4,700.00");
    expect(html).toContain("$900.00");
    expect(html).toContain("$650.00");
    expect(html).toContain("$1,200.00");
  });

  test("USDC/COIN-M sleeves inactive (never enabled): total collapses to USDT + FAPI BTC collateral only, no phantom components", () => {
    Object.assign(store.state, withBinance({
      usdtFutures: 5000, usdcFutures: null, fapiBtcCollateral: 650, coinmMargin: null,
    }));
    const html = renderHeader();
    expect(html).toContain("$5,650.00"); // 5000 + 650, no addition error
    expect(html).not.toContain("USDC Futures");
    expect(html).not.toContain("COIN-M");
  });

  test("everything unavailable renders no pill balance at all (not a fabricated $0)", () => {
    Object.assign(store.state, withBinance({
      usdtFutures: null, usdcFutures: null, fapiBtcCollateral: null, coinmMargin: null,
    }));
    const html = renderHeader();
    expect(html).not.toContain("pill-balance");
  });

  test("no marginBreakdown on the account (stale/missing broker read) renders no pill balance", () => {
    Object.assign(store.state, {
      ...store.state,
      connections: { alpaca: { connected: true }, binance: { connected: true } },
      profiles: [{ brokerAccounts: [{ brokerId: "binance_testnet", equity: null, marginBreakdown: null }] }],
    });
    const html = renderHeader();
    expect(html).not.toContain("pill-balance");
  });

  test("responsive/a11y: breakdown rides in a dedicated class (CSS-collapsible) and a title (screen-reader/tooltip) — not baked into the always-visible text", () => {
    Object.assign(store.state, withBinance({ usdtFutures: 5000, usdcFutures: 900, fapiBtcCollateral: null, coinmMargin: null }));
    const html = renderHeader();
    expect(html).toContain('class="pill-sub"');
    expect(html).toMatch(/title="[^"]*USDT Futures[^"]*"/);
  });
});
