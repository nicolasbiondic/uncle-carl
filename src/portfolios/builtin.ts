/**
 * The built-in portfolios: every sleeve expressed as DATA, with the exact
 * values production runs today (F3a, 2026-10-04 — docs/platform/PLAN.md).
 *
 * Direction of truth, crypto sleeves (momentum_tsm): these literals MUST stay
 * equal to what the pure plan functions in src/index.ts produce —
 * src/portfolios/parity.test.ts deep-equals buildPortfolioPlan(each
 * definition) against them. Changing a sleeve's wiring therefore means
 * changing BOTH src/index.ts (where AGENTS.md's rg falsifiers and
 * scripts/liveSleeveConfigs.test.ts lock the source text) AND this file.
 * Stock sleeves (template "portfolio", since 2026-11-07): the literal is the
 * manifest candidate of the sleeve's CURRENT model version, locked by
 * src/portfolios/builtinPortfolioEngine.test.ts.
 *
 * This module deliberately does NOT import from "../index": index.ts
 * imports the factory (which imports this file), and a back-edge would hit
 * the TDZ on index's exported consts during module evaluation.
 */
import { MOMENTUM_CRYPTO_UNIVERSE, RISK_PROFILES } from "../config/riskProfiles";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
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
      mode: "live",
      enabled: true,
      params: {
        universe: MOMENTUM_CRYPTO_UNIVERSE,
        rebalanceMinutes: 60,
        barMinutes: 60,
        historyBars: 754, // 31d of 1h bars + warmup margin
        maxLongs: DEFAULT_TSM_CONFIG.maxLongs, // 4 — same source as MOMENTUM_CRYPTO_MAX_LONGS
        notionalPctPerSlot: 0.375,
        // vt-35 (owner-delegated 2026-09-23, artifact 8b673e8a…).
        volTarget: { annualizedPct: 35, lookbackBars: 720, minScale: 0.33, maxScale: 1.5 },
        // RW7 (2deab5da): size-only risk, no regime/Sharpe/cooldown entry filters.
        regime: { enabled: false },
        risk: { mode: "sizeOnly" },
        allowSameTickReentry: true,
        // RW10 §21–21.1 (4aca1803): one Turtle System 1 20/10 short unit per coin.
        breakoutShort: { symbols: [...MOMENTUM_CRYPTO_UNIVERSE], entryDays: 20, exitDays: 10, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 },
        timeStop: { maxHoldHours: 120 }, // RW6 owner rule; RiskState NOT re-anchored
        capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
        equitySemantics: EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN,
        modelVersion: "vt35-corroff-2026-10-23",
        heartbeatName: "momentum:crypto",
        loggerContext: "Momentum:crypto",
        state: { path: "data/momentum-state-crypto.json", currentBase: 5_000, legacyBase: 10_000 },
        governor: { evidenceVersion: "v8.5-crypto-corroff" },
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
        // RW4a c2 (2026-10-23): drawdown exposure control on the OPEN book — λ 1 down to 10% dd, then the line to 0 at 40% floored at 0.25 (0.67 at 20%)
        // drawdown, band 10 pp, min order 100 USD. Artifact 8892c1e9… (experiments/momentum-crypto-usdc-daily-s5-
        // rw4a-xc-dd-pure-v1.json). Executed by BinanceMomentumAdapter.scalePosition.
        // RW7 (68181bd6): risk pauses OFF; regime/Sharpe/cooldown stay.
        risk: { mode: "sizeOnly" },
        exposureControl: { drawdown: { startPct: 0.1, endPct: 0.4 }, minScale: 0.25, band: 0.1, minOrderUsd: 100 },
        timeStop: { maxHoldHours: 120 }, // RW6, same RiskState/drawdown input
        // Owner approved 2026-11-05 (57430944): daily Turtle units, not λ-scaled.
        breakoutShort: { symbols: Object.keys(USDC_SYMBOL_MAP), entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 },
        capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
        equitySemantics: EQUITY_SEMANTICS.BINANCE_USDC_MARGIN,
        // Not re-anchored for RW4a: the same kernel built the live drawdown the control reads (index.ts docstring).
        modelVersion: "daily-s5-blend3-2026-09-26",
        // Expired one-shot (self-expiring window; kept for byte-parity with
        // MOMENTUM_USDC_CUTOVER_AT/_EXPIRES_AT until index.ts retires them).
        // Owner realign 2026-10-06 (see MOMENTUM_USDC_CUTOVER_AT in index.ts).
        cutover: { at: Date.UTC(2026, 9, 6, 5), expiresAt: Date.UTC(2026, 9, 9), symbols: ["UNI/USDC"] },
        heartbeatName: "momentum:crypto_usdc",
        loggerContext: "Momentum:usdc",
        state: { path: "data/momentum-state-usdc.json", currentBase: 5_000, legacyBase: 5_000 },
        governor: { evidenceVersion: "v8.6-usdc-xc-dd" },
      },
    },
    // ── Stock sleeves: PORTFOLIO-ENGINE definitions (RW2, live since 2026-10-23).
    // These are the code's copy of the CURRENT live model of each stock sleeve:
    // byte-equal to the registry row scripts/portfolio-engine-cutover.ts wrote
    // in prod (pe_<sleeve>, source "owner"), i.e. the manifest candidate named
    // by the LAST entry of MODEL_VERSIONS[sleeve] (src/portfolio/modelVersions.ts),
    // with the provenance hash that cutover.ts re-checks at boot (live = tested).
    // Purpose (owner, 2026-11-07, audit C): the TSM/Connors incumbents that used
    // to be the fallback when a DB definition was missing, invalid or could not
    // build are deleted; index.ts now falls back to THIS definition instead and
    // pages. Locked against the manifest + MODEL_VERSIONS by
    // src/portfolios/builtinPortfolioEngine.test.ts: changing the live model =
    // append the version, run the cutover script AND update this literal.
    {
      id: "pe_momentum_stocks",
      name: "momentum_stocks on the portfolio engine (e1-vt45-etf)",
      template: "portfolio",
      account: "alpaca_main",
      capital: RISK_PROFILES.momentum_stocks.initialEquity,
      mode: "live",
      enabled: true,
      params: {
        engine: "portfolio",
        sleeve: "momentum_stocks",
        strategy: {
          kind: "volManaged",
          // RW11 (§22–22.1): 2x ETFs SSO/QLD/USD/UGL replace SPY/QQQ/SMH/GLD in the core (SPY stays the switch's signal).
          universe: ["SSO", "QLD", "IWM", "UGL", "AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN", "USD"],
          inceptionGuardBars: 252,
          volLookback: 63,
          covLookback: 21,
          portfolioVolTarget: 0.45,
          annualization: 252,
          perAssetCap: 0.375,
          maxGross: 2.5,
          // Q5/RW8: SPY 200-day switch (1 % band); risk-off = core to cash + SH at 0.5× core gross.
          regimeOverlay: { signals: [{ kind: "maTrend", symbol: "SPY", period: 200, sampling: "daily", bandPct: 1 }], combine: "any", coreScale: 0, hedge: { symbol: "SH", fraction: 0.5 } },
          fastVolLookback: 5,
          maxHoldSessions: 5,
          maxHoldStagger: true,
        },
        venue: "alpaca",
        runMode: "live",
        strategyVersion: "momentum_stocks@pe-vt45-g250-sma200-fv5-mh5-stagger-sh50-etf2x",
        heartbeatName: "portfolio:momentum_stocks",
        loggerContext: "Portfolio:momentum_stocks",
        minOrderNotional: 5,
        rebalanceBand: 0.01,
        provenance: {
          manifest: "experiments/rw11-e1-vt45-etf-v1.json",
          candidate: "e1-vt45-etf",
          designSha256: "47165bba1b4da6d4e58915113a35790f5451cc24faac816b8dfe8f5ca2b8c759",
        },
      },
    },
    {
      id: "pe_meanrev_stocks",
      name: "meanrev_stocks on the portfolio engine (vt15-maxhold5-stagger)",
      template: "portfolio",
      account: "alpaca_main",
      capital: RISK_PROFILES.meanrev_stocks.initialEquity,
      mode: "live",
      enabled: true,
      params: {
        engine: "portfolio",
        sleeve: "meanrev_stocks",
        strategy: {
          kind: "volManaged",
          universe: ["ABBV", "AVGO", "BAC", "CAT", "COST", "CVX", "DIS", "GE", "HD", "HON", "JNJ", "JPM", "KO", "LLY", "MA", "MCD", "MRK", "NFLX", "NKE", "ORCL", "PG", "QCOM", "UNH", "V", "WMT", "XLE", "XLF", "XLI", "XLP", "XLV", "XOM", "SLV"],
          inceptionGuardBars: 252,
          volLookback: 63,
          covLookback: 21,
          portfolioVolTarget: 0.15,
          annualization: 252,
          perAssetCap: 0.1,
          maxGross: 1,
          maxHoldSessions: 5,
          maxHoldStagger: true,
        },
        venue: "alpaca",
        runMode: "live",
        strategyVersion: "meanrev_stocks@pe-vt15-mh5-stagger",
        heartbeatName: "portfolio:meanrev_stocks",
        loggerContext: "Portfolio:meanrev_stocks",
        minOrderNotional: 5,
        rebalanceBand: 0.01,
        provenance: {
          manifest: "experiments/rw7-e2-meanrev-maxhold5-stagger-v1.json",
          candidate: "vt15-maxhold5-stagger",
          designSha256: "4d5d114b00b41b499940e93229c77813f244646091bb8f5629a77ae557e6c686",
        },
      },
    },
  ];
}

/** Ids of definitions this file USED to seed and no longer does. A registry
 *  row with one of these ids and source='builtin' (i.e. never edited by the
 *  owner) is archived at boot by initPlatformPortfolios — never deleted, so
 *  the history stays readable — because no engine in this code can run it:
 *   - momentum_btc: the COIN-M momentum engine was retired 2026-11-07
 *     (owner, audit C). The wallet's truth sync does not depend on a row.
 *   - momentum_stocks / meanrev_stocks: the TSM/Connors incumbent rows. Their
 *     engines (AlpacaMomentumAdapter, the live MeanRevEngine wiring) were
 *     retired the same day; the sleeves run on the pe_<sleeve> definitions. */
export const RETIRED_BUILTIN_IDS: readonly string[] = ["momentum_btc", "momentum_stocks", "meanrev_stocks"];

/** The stock sleeves and the built-in portfolio-engine definition each one
 *  falls back to when the registry gives it no live engine (index.ts). */
export const STOCK_SLEEVE_BUILTIN_DEFINITION: Readonly<Record<"momentum_stocks" | "meanrev_stocks", string>> = {
  momentum_stocks: "pe_momentum_stocks",
  meanrev_stocks: "pe_meanrev_stocks",
};

/** One built-in definition by id; throws on an unknown id (never silent). */
export function builtinPortfolio(id: string): PortfolioDefinition {
  const def = builtinPortfolios().find((d) => d.id === id);
  if (!def) throw new Error(`builtinPortfolio: unknown portfolio id '${id}'`);
  return def;
}
