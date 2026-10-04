// ══════════════════════════════════════════════
// Risk Profiles v8 — 2 momentum sleeves
// momentum_stocks: Alpaca (SPY/QQQ/... 60min TSM, market hours only)
// momentum_crypto: Binance Futures (8 perps, 60min TSM, 24/7)
//
// The v7 COMBINED-engine profile zoo (alpaca_low/high, binance_low/high,
// regime overrides, minScore gates) was amputated 2026-07-10: the walk-forward
// validated TSM MomentumEngine is the only signal engine now. momentum_crypto
// owns the whole Binance wallet (broker = truth). The two Alpaca sleeves SHARE
// one wallet: each tracks a per-sleeve ledger (initialEquity allocation +
// realized + unrealized of its own trades); broker truth is alpaca_main only.
// ══════════════════════════════════════════════

export type RiskProfileId =
  | "momentum_stocks" | "momentum_crypto" | "meanrev_stocks"
  // 2026-07-19: USDⓈ-M USDC-margined + COIN-M BTC-margined sleeves, gated OFF
  // by default until MOMENTUM_USDC_ENABLED/MOMENTUM_COINM_ENABLED preflight
  // passes (see src/index.ts startup gate + src/account/AccountManager.ts
  // attach*Executor). momentum_crypto_usdc trades the SAME physical FAPI
  // account as momentum_crypto (a different margin-asset sub-pool, "binance_
  // usdc" only for EXECUTOR ROUTING — see BROKER_MAIN_SERIES below for why it
  // is NOT a separate wallet for accounting). momentum_btc trades the
  // genuinely separate DAPI COIN-M wallet.
  | "momentum_crypto_usdc" | "momentum_btc";
export type BrokerType = "alpaca" | "binance" | "binance_usdc" | "binance_coinm";

// ══════════════════════════════════════════════
// Accounting model (2026-07-19 correction — see AGENTS.md "Mandatory model").
//
// `broker` above is an EXECUTOR-ROUTING key only (which SDK client instance
// owns this sleeve's orders/positions) — binance/binance_usdc/binance_coinm
// are three DIFFERENT client objects even though the first two hit the same
// physical account. BROKER_MAIN_SERIES is the separate ACCOUNTING key: which
// *_main broker-truth equity_snapshots series this sleeve's wallet is part of.
//
//   • binance_main (FAPI, /fapi/v2/account) is Binance's FULL futures account
//     and its own assetIndex fan-out (BinanceExecutor.getAccountTotal) already
//     sums EVERY asset row — USDT, USDC, and any FAPI BTC collateral — exactly
//     once. momentum_crypto_usdc's USDC margin pool is therefore part of
//     binance_main already; it is NEVER a second wallet to add on top.
//   • binance_coinm_main (DAPI, BTCUSD_PERP) is a genuinely separate ledger —
//     a different API host, different collateral asset, no shared margin with
//     FAPI. momentum_btc is its sole owner (same "sole owner ⇒ broker-truth
//     passthrough, funding-exempt" pattern momentum_crypto already has for
//     binance_main).
// ══════════════════════════════════════════════
export const BROKER_MAIN_SERIES: Record<BrokerType, "alpaca_main" | "binance_main" | "binance_coinm_main"> = {
  alpaca: "alpaca_main",
  binance: "binance_main",
  binance_usdc: "binance_main",       // same FAPI account as "binance" — see doc above
  binance_coinm: "binance_coinm_main", // separate DAPI ledger
};

/** Sleeves whose equity is a COMPUTED ledger (initial + realized + unrealized,
 *  via computeSleeveLedger) rather than a direct broker-truth read. Only these
 *  need the "ledger vs broker" cross-check in portfolio/truth.ts — every
 *  binance* sleeve (momentum_crypto, momentum_crypto_usdc, momentum_btc)
 *  syncs its OWN margin-pool balance straight from the broker every 60s
 *  (AccountManager.syncBinanceFutures/syncBinanceUsdc/syncBinanceCoinM), so
 *  "reconstructing" it from realized+unrealized would always drift by
 *  un-recorded perp funding — the same reason momentum_crypto has always been
 *  exempted. */
export const LEDGER_SLEEVE_BROKERS = new Set<BrokerType>(["alpaca"]);

export interface RiskProfile {
  id: RiskProfileId;
  broker: BrokerType;
  label: string;
  emoji: string;
  initialEquity: number;
  /** Hard stop-loss % enforced by AccountManager.checkAllStopLoss (defense-in-depth). */
  stopLossPct: number;
  /**
   * DISPLAY-ONLY (AccountManager reads it straight onto dashboard
   * Position.leverage — src/account/AccountManager.ts, no order-sizing path
   * reads this field). For binance / binance_coinm sleeves it mirrors the
   * broker-set API leverage (BinanceMomentumAdapter/BinanceCoinMMomentumAdapter
   * call setLeverage independently — this is documentation of that number,
   * not its source). For alpaca sleeves there is no broker API leverage call;
   * this instead declares the sleeve's REAL gross exposure multiple of its
   * own equity (notionalPctPerSlot × maxLongs for momentum_stocks — see
   * index.ts's MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT; slotPct ×
   * maxPositions for meanrev_stocks). momentum_stocks was left at 1 here
   * pre-2026-08-19 despite running at 2.0× gross via Reg-T margin — a lying
   * field is worse than none; kept accurate from here on, locked by
   * exposureCaps.test.ts.
   */
  leverage: number;
}

export const RISK_PROFILES: Record<RiskProfileId, RiskProfile> = {
  momentum_stocks: {
    id: "momentum_stocks",
    broker: "alpaca",
    label: "Momentum Stocks",
    emoji: "📈",
    initialEquity: 50_000, // its ALLOCATION of the shared Alpaca wallet (meanrev_stocks owns the other 50k)
    stopLossPct: 4,
    // 1.0× since 2026-09-23 — notionalPctPerSlot(0.25) × maxLongs(4), see
    // index.ts's MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT (was 2 from launch to
    // 2026-09-23, when the gross axis went through the protocol). Locked to
    // the real product by riskProfiles.exposureCaps.test.ts.
    leverage: 1,
  },
  momentum_crypto: {
    id: "momentum_crypto",
    broker: "binance",
    label: "Momentum Crypto",
    emoji: "🪙",
    // The testnet wallet contains 5k USDT plus non-collateral USDC/BTC while
    // multiAssetsMargin=false. Only the USDT bucket can back USDT perps.
    initialEquity: 5_000,
    stopLossPct: 4,
    leverage: 2,
  },
  // Daily RSI2 mean-reversion sleeve (disjoint stock universe, long-only,
  // fixed $50k base notional). Shares the Alpaca wallet with momentum_stocks;
  // BOTH Alpaca sleeves carry a per-sleeve LEDGER equity (initial + realized +
  // unrealized of their own trades); broker truth lives only in alpaca_main.
  meanrev_stocks: {
    id: "meanrev_stocks",
    broker: "alpaca",
    label: "MeanRev Stocks",
    emoji: "🔄",
    // ponytail: single source for the daily sizing base — index.ts used to
    // re-read MEANREV_BASE_USD itself (a second knob for the same number as
    // this initialEquity), which could silently desync sizing from
    // accounting. Mirrors momentum_btc's MOMENTUM_BTC_INITIAL_USD pattern.
    initialEquity: Number(process.env.MEANREV_BASE_USD) || 50_000,
    stopLossPct: 4,
    leverage: 1,
  },
  // USDC-margined USDⓈ-M sleeve, disjoint symbol universe (BASE/USDC), its
  // OWN margin sub-pool (asset row "USDC" in /fapi/v2/account assets[],
  // never the "USDT" row momentum_crypto reads) on the SAME FAPI account as
  // momentum_crypto — already inside binance_main's account total (see
  // BROKER_MAIN_SERIES above). Gated by MOMENTUM_USDC_ENABLED — see src/index.ts.
  momentum_crypto_usdc: {
    id: "momentum_crypto_usdc",
    broker: "binance_usdc",
    label: "Momentum Crypto USDC",
    emoji: "🟢",
    initialEquity: 5_000,
    stopLossPct: 4,
    leverage: 2,
  },
  // COIN-M inverse-contract sleeve, BTCUSD_PERP only, DAPI wallet (settled in
  // BTC — structurally separate from the FAPI/USDⓈ-M wallet binance_main and
  // momentum_crypto_usdc read). initialEquity here is only the seed shown
  // before the first sync; live risk re-anchors to BinanceCoinMExecutor.
  // getEquityUsd() (marginBalance × mark), same broker-truth pattern as
  // momentum_crypto. Gated by MOMENTUM_COINM_ENABLED — see src/index.ts.
  momentum_btc: {
    id: "momentum_btc",
    broker: "binance_coinm",
    label: "Momentum BTC (COIN-M)",
    emoji: "🟠",
    initialEquity: Number(process.env.MOMENTUM_BTC_INITIAL_USD) || 1_000,
    stopLossPct: 4,
    leverage: 2,
  },
};

export const ALL_PROFILE_IDS: RiskProfileId[] = [
  "momentum_stocks", "momentum_crypto", "meanrev_stocks",
  "momentum_crypto_usdc", "momentum_btc",
];

// momentum_stocks TSM universe. MUST stay DISJOINT from MEANREV_UNIVERSE:
// the two sleeves share the Alpaca wallet, and closePosition(symbol) liquidates
// the AGGREGATE position while only the requesting sleeve closes its DB row —
// a shared symbol produces a phantom open DB row (the April incident class).
// Enforced by riskProfiles.disjoint.test.ts. +SMH added 2026-07-25 (owner
// mandate, Sol-reviewed, production-parity walk-forward — dominates the
// incumbent on Sharpe/worst-window/return with maxDD +2pp).
export const MOMENTUM_STOCKS_UNIVERSE = [
  "SPY", "QQQ", "IWM", "GLD", "AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN", "SMH",
];

// momentum_crypto TSM universe (8 Binance Futures perps, "BASE/USD" internal
// notation — matches config/symbols.ts + BrokerSync's ownership set, no
// format conversion needed). Single source for the engine universe, the
// price-stream/dashboard mirror in symbols.ts, and BrokerSync's sleeve
// ownership boundary — see riskProfiles.disjoint.test.ts.
export const MOMENTUM_CRYPTO_UNIVERSE = [
  "BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "AVAX/USD", "DOGE/USD", "LINK/USD",
];

// ══════════════════════════════════════════════
// Declared sleeve policy (owner mandate 2026-08-08: "always live, never demo")
//
// Two ex-ante declarations per sleeve, both auditable here and locked by
// riskProfiles.policy.test.ts:
//
// (a) RISK RETIREMENT — expressed as drawdown limits, never as P&L or
//     benchmark comparison. Breaching a limit NEVER turns the sleeve off:
//     RiskGuard (src/strategies/momentum/RiskGuard.ts, wired into every
//     engine) pauses NEW ENTRIES only (soft 10% → 24h, hard 20% → 7d +
//     human review, daily cap 3% → next UTC day) while exits and the hard
//     stop-loss keep managing open positions. The numbers below are a
//     DECLARATION of what the engines actually enforce — all five sleeves
//     run DEFAULT_RISK_CONFIG unmodified (index.ts only overrides
//     equitySemantics); the policy test fails if either side drifts.
//
// (b) EVIDENCE REVIEW POINT — the number of daily-return observations at
//     which a human review of the sleeve is warranted, derived from the
//     Bailey & López de Prado MinTRL of the EXPECTED (backtest/declared)
//     Sharpe — never the observed one, which moves with every data point
//     and would make the goalpost circular. Computation + one-time alert:
//     src/portfolio/reviewPoint.ts. Reaching the review point does NOT
//     imply retiring or promoting — it means there is finally enough data
//     to decide either way.
// ══════════════════════════════════════════════

export interface SleeveRiskRetirementPolicy {
  /** Daily loss that pauses new entries until next UTC day. */
  dailyLossCapPct: number;
  /** Peak-to-trough drawdown that pauses new entries 24h. */
  softDrawdownPct: number;
  /** Peak-to-trough drawdown that pauses new entries 7d + pages a human. */
  hardDrawdownPct: number;
  /** What enforces this (the sleeve stays alive; only entries pause). */
  enforcedBy: string;
  /** When this policy was declared (audit anchor). */
  declaredAt: string;
}

export interface SleeveReviewPolicy {
  /** EXPECTED annualized Sharpe — declared ex ante, from backtest where one
   *  exists. Deliberately conservative (lower SR ⇒ longer MinTRL runway ⇒
   *  harder to "decide on 8 trades of noise"). */
  expectedSharpeAnnualized: number;
  /** Where the number comes from — honesty over precision. */
  provenance: string;
  /** Bumping the version re-arms the one-time review alert. */
  version: string;
  declaredAt: string;
}

export interface SleevePolicy {
  risk: SleeveRiskRetirementPolicy;
  review: SleeveReviewPolicy;
}

/** All five sleeves currently share DEFAULT_RISK_CONFIG (locked by
 *  riskProfiles.policy.test.ts against src/strategies/momentum/RiskGuard.ts
 *  and the index.ts wiring). */
const SHARED_RISK_RETIREMENT: SleeveRiskRetirementPolicy = {
  dailyLossCapPct: 0.03,
  softDrawdownPct: 0.10,
  hardDrawdownPct: 0.20,
  enforcedBy: "RiskGuard entry-pause (soft 24h / hard 7d + human review); sleeve stays live, exits + hard stop-loss keep managing positions",
  declaredAt: "2026-08-08",
};

export const SLEEVE_POLICY: Record<RiskProfileId, SleevePolicy> = {
  momentum_stocks: {
    risk: SHARED_RISK_RETIREMENT,
    review: {
      expectedSharpeAnnualized: 1.0,
      provenance: "walk-forward +SMH deploy 2026-07-25 (AUDITS.md: Sharpe ~1.11, incumbent ~1.00); declared conservatively at 1.0",
      version: "v1", declaredAt: "2026-08-08",
    },
  },
  momentum_crypto: {
    risk: SHARED_RISK_RETIREMENT,
    review: {
      expectedSharpeAnnualized: 0.95,
      provenance: "v7 crypto walk-forward base Sharpe 0.979 (docs/v7-momentum-edge.md); declared conservatively at 0.95",
      version: "v1", declaredAt: "2026-08-08",
    },
  },
  meanrev_stocks: {
    risk: SHARED_RISK_RETIREMENT,
    review: {
      expectedSharpeAnnualized: 0.7,
      provenance: "owner-declared default — no protocol walk-forward Sharpe on record for this sleeve; low SR chosen so the review runway errs long",
      version: "v1", declaredAt: "2026-08-08",
    },
  },
  momentum_crypto_usdc: {
    risk: SHARED_RISK_RETIREMENT,
    review: {
      expectedSharpeAnnualized: 0.95,
      provenance: "inherits momentum_crypto's walk-forward (same engine/params, USDC universe; no sleeve-specific backtest on record)",
      version: "v1", declaredAt: "2026-08-08",
    },
  },
  momentum_btc: {
    risk: SHARED_RISK_RETIREMENT,
    review: {
      expectedSharpeAnnualized: 0.7,
      provenance: "owner-declared default — single-asset COIN-M TSM, no protocol backtest on record; low SR chosen so the review runway errs long",
      version: "v1", declaredAt: "2026-08-08",
    },
  },
};


export function getInitialEquityForProfile(id: RiskProfileId): number {
  return RISK_PROFILES[id].initialEquity;
}
