// ── botnow.fixture.js — /api/bot/now as it would have read on Saturday
// 2026-10-24 at 14:30 New York (18:30 UTC). Used by botnow.test.js and by
// `?botfixture` in the dashboard URL (screenshots without a backend).
export const FIXTURE_NOW = Date.parse("2026-10-24T18:30:00Z");

export const BOT_NOW_FIXTURE = {
  asOf: "2026-10-24T18:30:00Z",
  portfolios: [
    {
      id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", engine: "portfolio",
      version: "momentum_stocks@pe-vt30-g250-sma200-fv5", state: "invested",
      positions: 11, investedUsd: 51767, equityUsd: 53210, grossX: 0.97, maxGrossX: 2.5,
      cadence: { kind: "daily", at: "09:35 ET" },
      lastDecision: { at: "2026-10-23T13:35:00Z", entries: 0, exits: 0, resizes: 0, orders: 0, rejected: 0, signalsLong: 11, universe: 11, note: null },
      nextDecisionAt: "2026-10-26T13:35:00Z", // Monday 09:35 EDT
      blocked: null,
      regime: { riskOn: true, ref: "SPY", distancePct: 5.0 },
      exposureScale: null, drawdownPct: 3.1,
    },
    {
      id: "meanrev_stocks", label: "MeanRev Stocks", broker: "alpaca", engine: "meanrev",
      version: "meanrev_stocks@connors-v1", state: "invested",
      positions: 32, investedUsd: 53200, equityUsd: 54980, grossX: 1.0, maxGrossX: null,
      cadence: { kind: "daily", at: "09:35 ET" },
      lastDecision: { at: "2026-10-23T13:41:00Z", entries: 32, exits: 5, resizes: 0, orders: 37, rejected: 0, signalsLong: null, universe: null, note: null },
      nextDecisionAt: "2026-10-26T13:35:00Z",
      blocked: null, regime: null, exposureScale: null, drawdownPct: 1.2,
    },
    {
      id: "momentum_crypto", label: "Momentum Crypto", broker: "binance", engine: "momentum",
      version: "momentum_crypto@vt35-corroff", state: "flat",
      positions: 0, investedUsd: 0, equityUsd: 9870, grossX: 0, maxGrossX: 1.0,
      cadence: { kind: "hourly", at: ":00" },
      lastDecision: { at: "2026-10-24T18:29:00Z", entries: 0, exits: 0, resizes: 0, orders: 0, rejected: 0, signalsLong: 0, universe: 8, note: null },
      nextDecisionAt: "2026-10-24T19:00:15Z",
      blocked: { reason: "no_signal", detail: "0 of 8 symbols with a long signal", until: null },
      regime: null, exposureScale: null, drawdownPct: 0,
    },
    {
      id: "momentum_crypto_usdc", label: "Momentum Crypto USDC", broker: "binance_usdc", engine: "momentum",
      version: "momentum_crypto_usdc@daily-d13s5-xc-dd", state: "invested",
      positions: 4, investedUsd: 4700, equityUsd: 8120, grossX: 0.58, maxGrossX: 1.0,
      cadence: { kind: "daily", at: "00:00 UTC" },
      lastDecision: { at: "2026-10-24T00:00:00Z", entries: 0, exits: 0, resizes: 4, orders: 4, rejected: 0, signalsLong: 4, universe: 8, note: null },
      nextDecisionAt: "2026-10-25T00:00:00Z",
      blocked: { reason: "soft_drawdown", detail: "drawdown 16% ≥ 15% soft limit", until: "2026-10-26T00:00:00Z" },
      regime: null, exposureScale: 0.79, drawdownPct: 16,
    },
  ],
  events: [
    { at: "2026-10-24T16:02:00Z", portfolioId: "momentum_stocks", kind: "cutover", symbol: null, qty: null, usd: null, pnlUsd: null, reason: "model_cutover", detail: "pe-vt30-g250-sma200-fv5" },
    { at: "2026-10-24T00:00:20Z", portfolioId: "momentum_crypto_usdc", kind: "resize", symbol: null, qty: 4, usd: -1250, pnlUsd: null, reason: "drawdown_control", detail: null },
    { at: "2026-10-23T13:41:00Z", portfolioId: "meanrev_stocks", kind: "rebalance", symbol: null, qty: 37, usd: 48200, pnlUsd: null, reason: "daily_rebalance", detail: "32 bought, 5 sold" },
    { at: "2026-10-22T14:05:00Z", portfolioId: "momentum_stocks", kind: "sell", symbol: "NVDA", qty: 12, usd: 2140, pnlUsd: -410, reason: "trailing_stop", detail: null },
  ],
};
