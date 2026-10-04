// ── "Monthly returns" per account/sleeve (2026-09-24 audit fix, item 2) ────
// Used to hard-bind to binance_main regardless of what the dashboard was
// showing. These are the pure selection helpers; the picker UI itself
// (data-mr click wiring in main.js) isn't unit-tested here, same convention
// as the rest of the codebase's DOM-wiring code.
import { describe, expect, test } from "bun:test";
import { costCell, monthlyReturnsOptions, resolveMonthlyReturnsProfile, scorecard } from "./analytics.js";

const ACCOUNTS = [
  { id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca" },
  { id: "meanrev_stocks", label: "MeanRev Stocks", broker: "alpaca" },
  { id: "momentum_crypto", label: "Momentum Crypto", broker: "binance" },
  { id: "momentum_crypto_usdc", label: "Momentum Crypto USDC", broker: "binance_usdc" },
];

describe("monthlyReturnsOptions", () => {
  test("broker legs (deduped, one per distinct broker prefix) come before the individual sleeves", () => {
    const opts = monthlyReturnsOptions(ACCOUNTS);
    expect(opts.map((o) => o.id)).toEqual([
      "alpaca_main", "binance_main",
      "momentum_stocks", "meanrev_stocks", "momentum_crypto", "momentum_crypto_usdc",
    ]);
  });

  test("empty/missing accounts -> empty options, never throws", () => {
    expect(monthlyReturnsOptions([])).toEqual([]);
    expect(monthlyReturnsOptions(undefined)).toEqual([]);
  });
});

describe("resolveMonthlyReturnsProfile", () => {
  const options = monthlyReturnsOptions(ACCOUNTS);

  test("an explicit valid pick always wins, regardless of the current view", () => {
    expect(resolveMonthlyReturnsProfile("momentum_crypto", "consolidated", options)).toBe("momentum_crypto");
    expect(resolveMonthlyReturnsProfile("alpaca_main", "momentum_stocks", options)).toBe("alpaca_main");
  });

  test("no explicit pick, viewing a specific sleeve: binds to that sleeve (not binance_main)", () => {
    expect(resolveMonthlyReturnsProfile(null, "momentum_stocks", options)).toBe("momentum_stocks");
  });

  test("no explicit pick, consolidated view: falls back to binance_main (the old default) when present", () => {
    expect(resolveMonthlyReturnsProfile(null, "consolidated", options)).toBe("binance_main");
  });

  test("an explicit pick that is no longer a valid option (sleeve disappeared) is discarded, not trusted blindly", () => {
    expect(resolveMonthlyReturnsProfile("momentum_btc", "consolidated", options)).toBe("binance_main");
  });

  test("binance_main absent from options (e.g. only Alpaca configured): falls back to the first option, never throws", () => {
    const alpacaOnly = monthlyReturnsOptions([{ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca" }]);
    expect(resolveMonthlyReturnsProfile(null, "consolidated", alpacaOnly)).toBe("alpaca_main");
  });
});

describe("scorecard table", () => {
  test("maxDD renders the API's percent value as a percent (11.97 → −12.0%), not divided twice", () => {
    const html = scorecard({ entities: [{
      id: "momentum_crypto_usdc", kind: "sleeve", label: "Momentum Crypto USDC", benchmarkSymbol: "BTC/USD", modelStart: "2026-07-20",
      band: { status: "unavailable" },
      windows: [{ window: "model", nObs: 67, totalReturnPct: 52.59, alphaAnnPct: 114.9, sharpe: 3.94, maxDrawdownPct: 11.97, benchmark: { symbol: "BTC/USD", totalReturnPct: 29.35 } }],
    }] });
    expect(html).toContain("−12.0%");
    expect(html).not.toContain("−0.1%");
  });

  test("no costs block (old API shape) → renders with an em-dash cost cell, never throws", () => {
    const html = scorecard({ entities: [{
      id: "meanrev_stocks", kind: "sleeve", label: "Reversión Stocks", benchmarkSymbol: "SPY", modelStart: "2026-09-25",
      band: { status: "unavailable" },
      windows: [{ window: "model", nObs: 5, totalReturnPct: 1.0, benchmark: {} }],
    }] });
    expect(html).toContain("Cost"); // header present (Costs/Costes)
    expect(html).not.toContain("tearsheet"); // no artifactDir → no link
  });

  test("tearsheet link only for sleeves with an authoritative artifact", () => {
    const html = scorecard({ entities: [{
      id: "momentum_stocks", kind: "sleeve", label: "Momentum Stocks", benchmarkSymbol: "SPY", modelStart: "2026-09-28",
      band: { status: "insufficient_data", artifactDir: "data/backtests/abc" },
      windows: [{ window: "model", nObs: 0, totalReturnPct: 0, benchmark: {} }],
    }] });
    expect(html).toContain(`href="/api/v2/tearsheet/momentum_stocks"`);
    expect(html).toContain(`target="_blank"`);
  });
});

describe("costCell", () => {
  test("no data → em dash", () => {
    expect(costCell(null)).toContain("—");
    expect(costCell({ measured: null })).toContain("—");
  });

  test("real vs assumed + margin, verdict in the tooltip", () => {
    const html = costCell({
      measured: { totalPerSideBps: 7.3, n: 42, slipMeanBps: 3.3, commissionMeanBps: 4.0 },
      assumed: { slippageBps: 5, commissionBps: 4, totalPerSideBps: 9 },
      breakEven: { measuredOutOfCurveRange: false, marginBps: 21.4, marginAtLeastBps: null, outOfRangeDirection: null },
      verdict: "coste real 7.3 bps/lado",
    });
    expect(html).toContain("7.3bps");
    expect(html).toContain("n=42");
    expect(html).toContain("vs 9");
    expect(html).toContain("21");
    expect(html).toContain("coste real 7.3 bps/lado"); // tooltip
  });

  test("small n (<10) hides the break-even margin (no extrapolation)", () => {
    const html = costCell({
      measured: { totalPerSideBps: 7.3, n: 6 },
      assumed: { totalPerSideBps: 9 },
      breakEven: { measuredOutOfCurveRange: false, marginBps: 21.4 },
      verdict: "v",
    });
    expect(html).toContain("n=6");
    expect(html).not.toContain("21");
  });
});
