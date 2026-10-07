/**
 * The built-in portfolios: the five hand-wired sleeves of src/index.ts
 * expressed as DATA, with the exact values production wires today
 * (F3a, 2026-10-04 — docs/platform/PLAN.md).
 *
 * Direction of truth: these literals MUST stay equal to what the pure plan
 * functions in src/index.ts produce — src/portfolios/parity.test.ts
 * deep-equals buildPortfolioPlan(each definition) against them. Changing a
 * sleeve's wiring therefore means changing BOTH src/index.ts (where
 * AGENTS.md's rg falsifiers and scripts/liveSleeveConfigs.test.ts lock the
 * source text) AND this file, or the parity test fails.
 *
 * This module deliberately does NOT import from "../index": index.ts
 * imports the factory (which imports this file), and a back-edge would hit
 * the TDZ on index's exported consts during module evaluation.
 */
import { MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE, RISK_PROFILES } from "../config/riskProfiles";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import { COINM_INTERNAL_SYMBOL } from "../strategies/momentum/BinanceCoinMMomentumAdapter";
import { DEFAULT_TSM_CONFIG } from "../strategies/momentum/TimeSeriesMomentum";
import { EQUITY_SEMANTICS } from "../strategies/momentum/RiskGuard";
import type { PortfolioDefinition } from "./types";

/**
 * Evaluated lazily (function, not a top-level const): meanrev capital is
 * env-driven (MEANREV_BASE_USD via RISK_PROFILES) and tests mutate env.
 */
export function builtinPortfolios(): PortfolioDefinition[] {
  return [
    {
      id: "momentum_crypto",
      name: "Momentum TSM — Binance USDT perps",
      template: "momentum_tsm",
      account: "binance_usdt",
      capital: RISK_PROFILES.momentum_crypto.initialEquity,
      // Registered DEFAULT is shadow (recent windows negative at launch);
      // the owner promoted the sleeve to live 2026-08-08 via sleeve_modes —
      // that persisted row, not this default, is the effective mode.
      mode: "live",
      enabled: true,
      params: {
        universe: MOMENTUM_CRYPTO_UNIVERSE,
        rebalanceMinutes: 60,
        barMinutes: 60,
        historyBars: 754, // 31d of 1h bars + warmup margin
        maxLongs: DEFAULT_TSM_CONFIG.maxLongs, // 4 — same source as MOMENTUM_CRYPTO_MAX_LONGS
        notionalPctPerSlot: 0.375,
        sharpeGate: { lookbackDays: 30, minSharpe: 0 },
        // vt-35 (owner-delegated 2026-09-23, artifact 8b673e8a…).
        volTarget: { annualizedPct: 35, lookbackBars: 720, minScale: 0.33, maxScale: 1.5 },
        capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
        equitySemantics: EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN,
        modelVersion: "vt35-2026-09-23",
        heartbeatName: "momentum:crypto",
        loggerContext: "Momentum:crypto",
        state: { path: "data/momentum-state-crypto.json", currentBase: 5_000, legacyBase: 10_000 },
        governor: { promotionEligible: false, evidenceVersion: "v8-crypto-no-hard-sl" },
      },
    },
    {
      id: "momentum_crypto_usdc",
      name: "Momentum TSM daily — Binance USDC perps",
      template: "momentum_tsm",
      account: "binance_usdc",
      capital: RISK_PROFILES.momentum_crypto_usdc.initialEquity,
      mode: "live",
      enabled: true, // runtime additionally gated by MOMENTUM_USDC_ENABLED (unchanged)
      params: {
        universe: Object.keys(USDC_SYMBOL_MAP),
        rebalanceMinutes: 1440, // one decision per UTC day at 00:00 + 15s
        barMinutes: 1440,
        // d13-s5-blend-63-126-252 (U1 rounds 3-5, artifact 752767ae…).
        horizon: { lookbackDaysList: [63, 126, 252], maLengthDays: 200 },
        maxLongs: 5,
        notionalPctPerSlot: 0.2,
        slotHysteresis: true,
        tsmTrail: { kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 },
        volStop: { kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 },
        sharpeGate: { lookbackDays: 30, minSharpe: 0 },
        capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
        equitySemantics: EQUITY_SEMANTICS.BINANCE_USDC_MARGIN,
        modelVersion: "daily-s5-blend3-2026-09-26",
        // Expired one-shot (self-expiring window; kept for byte-parity with
        // MOMENTUM_USDC_CUTOVER_AT/_EXPIRES_AT until index.ts retires them).
        // Owner realign 2026-10-06 (see MOMENTUM_USDC_CUTOVER_AT in index.ts).
        cutover: { at: Date.UTC(2026, 9, 6, 5), expiresAt: Date.UTC(2026, 9, 9), symbols: ["UNI/USDC"] },
        heartbeatName: "momentum:crypto_usdc",
        loggerContext: "Momentum:usdc",
        state: { path: "data/momentum-state-usdc.json", currentBase: 5_000, legacyBase: 5_000 },
        governor: { evidenceVersion: "v8.3-usdc-daily" },
      },
    },
    {
      id: "momentum_btc",
      name: "Momentum TSM — Binance COIN-M BTC perp",
      template: "momentum_tsm",
      account: "binance_coinm",
      capital: RISK_PROFILES.momentum_btc.initialEquity,
      mode: "live",
      enabled: false, // MOMENTUM_COINM_ENABLED defaults false — flag-off sleeve
      params: {
        universe: [COINM_INTERNAL_SYMBOL],
        rebalanceMinutes: 60,
        barMinutes: 60,
        historyBars: 754,
        maxLongs: 1, // single symbol IS the one slot
        notionalPctPerSlot: 1,
        sharpeGate: { lookbackDays: 30, minSharpe: 0 },
        equitySemantics: EQUITY_SEMANTICS.BINANCE_COINM_MARGIN,
        heartbeatName: "momentum:btc",
        loggerContext: "Momentum:coinm",
        state: { path: "data/momentum-state-btc.json", currentBase: 1_000, legacyBase: 1_000 },
        governor: { evidenceVersion: "v8.2-coinm-launch" },
      },
    },
    {
      id: "momentum_stocks",
      name: "Momentum TSM daily — Alpaca stocks/ETFs",
      template: "momentum_tsm",
      account: "alpaca_main",
      capital: RISK_PROFILES.momentum_stocks.initialEquity,
      mode: "live",
      enabled: true,
      params: {
        universe: MOMENTUM_STOCKS_UNIVERSE,
        rebalanceMinutes: 60, // informational — index.ts drives the tick (docs.test counts it)
        barMinutes: 1440,
        // Daily blend3 kernel (k8-s8 + blend, artifacts 5a5a9577…/cc2f5d69…).
        horizon: { lookbackDaysList: [63, 126, 252], maLengthDays: 200 },
        maxLongs: 8,
        notionalPctPerSlot: 0.125,
        slotHysteresis: true, // owner override 2026-09-10, stocks only
        tsmTrail: { kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 },
        volStop: { kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 },
        sharpeGate: { lookbackDays: 30, minSharpe: 0 },
        capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
        equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER,
        modelVersion: "daily-blend3-2026-09-28",
        // Expired one-shot (see MOMENTUM_STOCKS_CUTOVER_AT in index.ts).
        // Owner realign 2026-10-06 (see MOMENTUM_STOCKS_CUTOVER_AT in index.ts).
        cutover: { at: Date.UTC(2026, 9, 6, 5), expiresAt: Date.UTC(2026, 9, 9), symbols: ["GOOGL"] },
        heartbeatName: "momentum:stocks",
        loggerContext: "Momentum:stocks",
        state: { path: "data/momentum-state-stocks.json", currentBase: 50_000, legacyBase: 100_000 },
        governor: { evidenceVersion: "v8-stocks" },
      },
    },
    {
      id: "meanrev_stocks",
      name: "Connors RSI(2) mean-reversion — Alpaca stocks/ETFs",
      template: "meanrev_connors",
      account: "alpaca_main",
      capital: RISK_PROFILES.meanrev_stocks.initialEquity,
      mode: "live",
      enabled: true, // runtime additionally gated by MEANREV_ENABLED !== "false" (unchanged)
      params: {
        // Strategy knobs live in DEFAULT_MEANREV_CONFIG (single source);
        // these are the only index.ts overrides.
        volStop: { kSigma: 3, lookbackBars: 20, minPct: 2, maxPct: 12 }, // vol-k3, artifact 9dcd9781
        capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
        equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER,
        heartbeatName: "meanrev:stocks",
        loggerContext: "MeanRev:stocks",
        schedulerLabel: "meanrev",
        state: {
          path: "data/meanrev-state-stocks.json",
          currentBase: RISK_PROFILES.meanrev_stocks.initialEquity,
          legacyBase: RISK_PROFILES.meanrev_stocks.initialEquity,
        },
        governor: { evidenceVersion: "v8-meanrev" },
      },
    },
  ];
}

/** One built-in definition by id; throws on an unknown id (never silent). */
export function builtinPortfolio(id: string): PortfolioDefinition {
  const def = builtinPortfolios().find((d) => d.id === id);
  if (!def) throw new Error(`builtinPortfolio: unknown portfolio id '${id}'`);
  return def;
}
