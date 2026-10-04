// ══════════════════════════════════════════════
// Broker-truth KPI sourcing (rewritten 2026-07-19 — reviewer pass): Total
// Equity / Top P&L / fixed 7D P&L now read from ONE server-computed
// `pnlAggregate` (routes/profiles.ts, combining every applicable *_main
// broker-truth leg via portfolio/truth.ts combineEquityPnlLegs), not a
// frontend recombination across per-broker `ba.stats`/`ba.equity` fields.
// The old version of this file asserted the OPPOSITE premise — that the
// frontend dedupes brokerAccounts itself and suppresses pct whenever more
// than one broker contributed ("brokerCount>1 suppression", explicitly
// removed per mandate). See kpis.js consolidated().
// ══════════════════════════════════════════════

import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { kpiValues } from "./kpis.js";
import { renderHeader } from "./header.js";

const originalState = { ...store.state };

afterEach(() => Object.assign(store.state, originalState));

const stateWith = (pnlAggregate, extra = {}) => ({
  ...store.state,
  view: "consolidated",
  profiles: [{ pnlAggregate, ...extra }],
  dashboard: { portfolio: { totalEquity: 106826 } },
});

describe("broker-truth equity/P&L — server-computed pnlAggregate", () => {
  test("Total Equity / period / 7D P&L pass through the server aggregate untouched", () => {
    const values = kpiValues(stateWith({
      equity: 112483.2, periodPnl: 90.25, periodPnlPct: 0.08, pnl7d: 350, pnl7dPct: 0.31,
    }));
    expect(values.equity).toBe(112483.2);
    expect(values.periodPnl).toBe(90.25);
    expect(values.periodPnlPct).toBe(0.08);
    expect(values.pnl7d).toBe(350);
    expect(values.pnl7dPct).toBe(0.31);
  });

  test("aggregate pct is no longer suppressed just because multiple brokers contributed (brokerCount>1 suppression removed)", () => {
    // A combined pct across three legs (alpaca+binance+coinm) — the server
    // ships it directly; the frontend must render it as-is, not null it out.
    const values = kpiValues(stateWith({
      equity: 118000, periodPnl: 60.25, periodPnlPct: 0.051, pnl7d: 300, pnl7dPct: 0.26,
    }));
    expect(values.periodPnlPct).toBe(0.051);
    expect(values.pnl7dPct).toBe(0.26);
  });

  test("null aggregate (a required leg missing/stale) stays null — never a fabricated 0 or partial sum", () => {
    const values = kpiValues(stateWith({
      equity: null, periodPnl: null, periodPnlPct: null, pnl7d: null, pnl7dPct: null,
    }));
    expect(values.equity).toBeNull();
    expect(values.periodPnl).toBeNull();
    expect(values.periodPnlPct).toBeNull();
    expect(values.pnl7d).toBeNull();
    expect(values.pnl7dPct).toBeNull();
  });

  test("no pnlAggregate at all (stale payload) degrades to null, not a crash", () => {
    const values = kpiValues({ ...store.state, view: "consolidated", profiles: [{}], dashboard: {} });
    expect(values.equity).toBeNull();
    expect(values.periodPnl).toBeNull();
  });

  test("non-consolidated (single sleeve) view still uses the consolidated aggregate — the KPI bar is portfolio-wide regardless of the selected view (per-sleeve detail lives in the cards/modal below)", () => {
    const values = kpiValues({
      ...store.state, view: "momentum_stocks", profiles: [{ pnlAggregate: { equity: 999999 } }],
      dashboard: { portfolio: { totalEquity: 50250 } },
    });
    expect(values.equity).toBe(999999);
  });

  test("header renders broker equity from marginBreakdown, independent of the KPI aggregate", () => {
    Object.assign(store.state, {
      ...store.state,
      view: "consolidated",
      connections: { alpaca: { connected: true }, binance: { connected: true } },
      profiles: [{
        pnlAggregate: { equity: 112483.2, periodPnl: 0, periodPnlPct: 0, pnl7d: 0, pnl7dPct: 0 },
        brokerAccounts: [
          { brokerId: "alpaca_paper", equity: 102167.88 },
          {
            brokerId: "binance_testnet", equity: 10315.3212,
            marginBreakdown: { usdtFutures: 10315.3212, usdcFutures: null, fapiBtcCollateral: null, coinmMargin: null },
          },
        ],
      }],
    });

    const html = renderHeader();
    expect(html).toContain("$102,167.88");
    expect(html).toContain("$10,315.32");
  });
});
