// ── "Monthly returns" per account/sleeve (2026-09-24 audit fix, item 2) ────
// Used to hard-bind to binance_main regardless of what the dashboard was
// showing. These are the pure selection helpers; the picker UI itself
// (data-mr click wiring in main.js) isn't unit-tested here, same convention
// as the rest of the codebase's DOM-wiring code.
import { describe, expect, test } from "bun:test";
import { costCell, monthlyReturnsOptions, resolveMonthlyReturnsProfile, scorecard, windowLabel, benchmarkName, monthShort } from "./analytics.js";
import { executionLine } from "./funnel.js";
import { store } from "../store.js";

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

  test("no explicit pick, consolidated view: a WHOLE broker account (the first *_main leg), never a single sleeve", () => {
    expect(resolveMonthlyReturnsProfile(null, "consolidated", options)).toBe("alpaca_main");
  });

  test("an explicit pick that is no longer a valid option (sleeve disappeared) is discarded, not trusted blindly", () => {
    expect(resolveMonthlyReturnsProfile("momentum_btc", "consolidated", options)).toBe("alpaca_main");
  });

  test("binance_main absent from options (e.g. only Alpaca configured): falls back to the first option, never throws", () => {
    const alpacaOnly = monthlyReturnsOptions([{ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca" }]);
    expect(resolveMonthlyReturnsProfile(null, "consolidated", alpacaOnly)).toBe("alpaca_main");
  });
});

// ── One plain-language line per portfolio (owner, 2026-10-25) ──────────────
describe("scorecard — plain-language rows", () => {
  const entity = (band) => ({
    id: "momentum_stocks", kind: "sleeve", label: "Momentum Stocks", benchmarkSymbol: "SPY",
    band, windows: [{ window: "model", nObs: 5, totalReturnPct: 1, benchmark: {} }],
  });

  test("a row reads: name, window, return, benchmark by name, worst drop — statistics folded underneath", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "en";
      const html = scorecard({ entities: [{
        id: "momentum_stocks", kind: "sleeve", label: "Momentum Stocks", benchmarkSymbol: "SPY", modelStart: "2026-09-25",
        band: { status: "within", artifactDir: "data/backtests/abc", cumReturnPct: { p5: -4, p50: 3, p95: 12 }, horizonSessions: 20 },
        windows: [{ window: "model", nObs: 20, totalReturnPct: -3.5, alphaAnnPct: 2.1, sharpe: 0.8, maxDrawdownPct: 7.7, benchmark: { totalReturnPct: -1.0 } }],
      }] });
      expect(html).toContain('<details class="sc-row" data-sc="momentum_stocks">');
      expect(html).toContain('<span class="sc-name">Momentum Stocks <span class="sc-win">since Sep 25</span></span>');
      expect(html).toContain('<span class="sc-ret" style="color:var(--down)">−3.5%</span>');
      expect(html).toContain('<span class="sc-bench"><span class="sc-l">S&amp;P 500</span> −1.0%</span>');
      expect(html).toContain('<span class="sc-dd"><span class="sc-l">worst drop</span> −7.7%</span>');
      // the statistics are still there, in the fold
      const more = html.slice(html.indexOf('class="sc-more"'));
      expect(more).toContain("Sharpe</span> 0.80");
      expect(more).toContain("Alpha per year</span> +2.1%");
      expect(more).toContain("within the expected band");
      expect(more).toContain("Costs per side</span>");
      expect(more).toContain('href="/api/v2/tearsheet/momentum_stocks"');
      // no table, no ALL-CAPS heading, no em-dash label
      expect(html).not.toContain("<table");
      expect(html).not.toContain("card-note");
      expect(html).not.toMatch(/Scorecard —|SCORECARD/);
    } finally { store.state.lang = lang; }
  });

  test("the window is in words: since <date> for the model window, last N days otherwise", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "en";
      expect(windowLabel({ window: "model" }, "2026-09-25")).toBe("since Sep 25");
      expect(windowLabel({ window: "30d" }, "2026-09-25")).toBe("last 30 days");
      expect(windowLabel({ window: "model" }, null)).toBe("since the current model");
      store.state.lang = "es";
      expect(windowLabel({ window: "30d" }, null)).toBe("últimos 30 días");
      expect(windowLabel({ window: "model" }, "2026-09-25")).toMatch(/^desde 25 sep/);
    } finally { store.state.lang = lang; }
  });

  test("benchmarks are named, unknown symbols fall back to the ticker", () => {
    expect(benchmarkName("SPY")).toBe("S&P 500");
    expect(benchmarkName("BTC/USD")).toBe("Bitcoin");
    expect(benchmarkName("XLE")).toBe("XLE");
    expect(benchmarkName("SOL/USD")).toBe("SOL");
  });

  test("months are short names, not numbers", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "en";
      expect(monthShort("2026-10")).toBe("Oct");
      expect(monthShort("garbage")).toBe("garbage");
    } finally { store.state.lang = lang; }
  });

  test("caveat is only a tooltip on the heading", () => {
    const html = scorecard({ entities: [entity({ status: "unavailable" })] });
    expect(html).toMatch(/class="an-h"[^>]*title="[^"]*(Few weeks|Con pocas semanas)[^"]*">/);
    expect(html.replace(/title="[^"]*"/g, "")).not.toMatch(/Few weeks|Con pocas semanas/);
  });

  test("insufficient data is a muted dash, with the escaped reason in its tooltip", () => {
    const html = scorecard({ entities: [entity({ status: "insufficient_data", reason: 'Only 5 sessions, need 20 & "complete" days' })] });
    expect(html).toContain('<span class="muted" title="Only 5 sessions, need 20 &amp; &quot;complete&quot; days">—</span>');
    expect(html).not.toContain('class="mchip"');
    expect(html).not.toMatch(/>insufficient data<|>datos insuficientes</);
  });

  test("missing reason has a localized explanation", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "en";
      expect(scorecard({ entities: [entity({ status: "insufficient_data" })] })).toContain('title="Not enough live data to evaluate the band">—');
      store.state.lang = "es";
      expect(scorecard({ entities: [entity({ status: "insufficient_data" })] })).toContain('title="Sin datos de vivo suficientes para evaluar la banda">—');
    } finally { store.state.lang = lang; }
  });

  test("other band states keep their bordered chips and titles", () => {
    for (const status of ["below", "within", "above", "unavailable"]) {
      const html = scorecard({ entities: [entity({ status, reason: "band reason" })] });
      expect(html).toContain('class="mchip" title="band reason"');
      expect(html).toContain("border-color:");
    }
  });

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
    expect(html).toMatch(/Costs per side|Costes por lado/); // the stat is present, its value an em dash
    expect(html).not.toContain("/api/v2/tearsheet/"); // no artifactDir → no link
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

describe("execution quality line (Volume tab)", () => {
  test("one sentence with typical and bad-case slippage, latency and fills", () => {
    const lang = store.state.lang;
    try {
      store.state.lang = "en";
      const html = executionLine({ count: 124, p50: 3.14, p95: 9.02, meanLatencyMs: 419.6 });
      expect(html).toContain("Execution quality");
      expect(html).toContain("<b>3.1 bps</b> typical");
      expect(html).toContain("<b>9.0 bps</b> bad case");
      expect(html).toContain("<b>420 ms</b>");
      expect(html).toContain("124 fills");
    } finally { store.state.lang = lang; }
  });

  test("nothing measured → nothing rendered (no fabricated zeros)", () => {
    expect(executionLine(null)).toBe("");
    expect(executionLine({ count: 0, p50: 0, p95: 0 })).toBe("");
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
