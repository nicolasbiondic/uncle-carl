/**
 * liveSleeveConfigs — the "vivo = validado" lock (W4 parity, 2026-09-25).
 *
 * Derives, from the SAME exported constants src/index.ts wires into the
 * production engines, the walk-forward CandidateConfig equivalent of each
 * live sleeve, next to the path of its AUTHORITATIVE experiment manifest —
 * the artifact whose pure OOS chain justified wiring this exact config.
 *
 * Why this exists: the 2026-09-24/25 audits found that what ran live was
 * not what the simulator had validated (16-min-stale SIP bars, tick phase,
 * stops never tested together, inherited position sizing) and nobody
 * noticed for weeks. This module + its test (liveSleeveConfigs.test.ts)
 * make that drift a TEST FAILURE: any decision-relevant key that diverges
 * between the live wiring and the manifest candidate must either match or
 * be explicitly declared (with a reason) in the test's exception list.
 *
 * Direction of truth: src/index.ts's exported constants remain the single
 * source (this module IMPORTS them — safe, `main()` is import.meta.main
 * gated and several tests already import src/index.ts). Wiring literals
 * that index.ts does NOT export (slotHysteresis, the crypto volTarget, the
 * sharpe gate, the meanrev volStop) are declared here as constants and
 * LOCKED against src/index.ts's source text by the test — the same
 * falsifier style AGENTS.md documents (`rg 'slotHysteresis: true'` → 1).
 * They were deliberately NOT hoisted out of index.ts: AGENTS.md documents
 * rg-based falsifiers against those exact literals, and index.ts is under
 * concurrent edit by parallel streams.
 *
 * Consumers: scripts/parity-check.ts (daily live↔replay decision monitor)
 * and scripts/rehearse-daily-pass.ts (next-pass dry run) build their
 * replay/engine configs from THESE derivations, so what they check is what
 * production actually runs.
 */

import {
  MOMENTUM_STOCKS_MAX_LONGS,
  MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT,
  MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT,
  MOMENTUM_STOCKS_DAILY_HORIZON,
  MOMENTUM_STOCKS_DAILY_VOL_STOP,
  MOMENTUM_CRYPTO_MAX_LONGS,
  MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT,
  MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT,
  MOMENTUM_USDC_MAX_LONGS,
  MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT,
  MOMENTUM_USDC_MAX_GROSS_EXPOSURE_MULT,
  MOMENTUM_USDC_DAILY_HORIZON,
  MOMENTUM_USDC_DAILY_VOL_STOP,
  MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT,
} from "../index";
import { USDC_SYMBOL_MAP } from "../executor/binance/quoteAsset";
import { MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE, RISK_PROFILES } from "./riskProfiles";
import { DEFAULT_TSM_CONFIG } from "../strategies/momentum/TimeSeriesMomentum";
import { DEFAULT_RISK_CONFIG, type RiskGuardConfig } from "../strategies/momentum/RiskGuard";
import { DEFAULT_MEANREV_CONFIG } from "../strategies/meanrev/MeanRevEngine";
import type { TrailStopConfig, VolTargetConfig } from "../strategies/momentum/MomentumEngine";

/**
 * Structural subset of scripts/walk-forward.ts's CandidateConfig covering
 * every key the live sleeves use. Declared HERE (not imported) because the
 * tsc program is rooted at src/ — importing scripts/ would drag the whole
 * research harness into `bun run typecheck`. Compatibility is enforced at
 * runtime by scripts/liveSleeveConfigs.test.ts, which feeds these objects
 * through walk-forward's own validateCandidate().
 */
export interface LiveCandidateConfig {
  name: string;
  cadenceMin: number;
  notionalPctPerSlot?: number;
  entryPct?: number;
  exitPct?: number;
  maxLongs?: number;
  maxShorts?: number;
  lookbackDays?: number;
  lookbackDaysList?: number[];
  maLengthDays?: number;
  slotHysteresis?: boolean;
  hardStop?: { mode: "volScaled" } & TrailStopConfig;
  tsmTrail?: TrailStopConfig;
  sharpeGate?: { lookbackDays: number; minSharpe: number };
  volTarget?: VolTargetConfig;
  risk?: Partial<RiskGuardConfig>;
  maxGrossExposureMult?: number;
  meanrev?: {
    entryRsi: number;
    smaLong: number;
    smaExit: number;
    timeStopDays: number;
    maxPositions: number;
    slotPct: number;
    rsiMethod?: "cutler" | "wilder";
    deterministicTieBreak?: boolean;
  };
}

// ── wiring literals index.ts does NOT export ────────────────────────────
// Each of these mirrors a literal inside main()'s engine wiring. The test
// locks them against src/index.ts's source text; if the wiring changes,
// change BOTH or the lock fails.

/** momentum_stocks `tsm.slotHysteresis` (owner override 2026-09-10, stocks
 *  only; AGENTS.md falsifier: `rg 'slotHysteresis: true' src/index.ts` → 1). */
export const MOMENTUM_STOCKS_SLOT_HYSTERESIS = true;

/** momentum_crypto `volTarget` (vt-35, wired 2026-09-23; AGENTS.md
 *  falsifier: `rg 'volTarget: \{' src/index.ts` → 1). */
export const MOMENTUM_CRYPTO_VOL_TARGET = { annualizedPct: 35, lookbackBars: 720, minScale: 0.33, maxScale: 1.5 };

/** Rolling-Sharpe entry gate every live momentum sleeve wires verbatim. */
export const MOMENTUM_SLEEVE_SHARPE_GATE = { lookbackDays: 30, minSharpe: 0 };

/** meanrev_stocks vol-scaled hard stop (owner override 2026-08-28,
 *  artifact 9dcd9781 vol-k3 on daily bars). */
export const MEANREV_STOCKS_VOL_STOP = { kSigma: 3, lookbackBars: 20, minPct: 2, maxPct: 12 };

// ── authoritative manifests ─────────────────────────────────────────────
/** Paths are repo-root relative (the convention every script here uses). */
export const LIVE_SLEEVE_MANIFESTS = {
  momentum_stocks: "experiments/momentum-stocks-daily-blend3-pure-v1.json",
  // 7 × 0.12 since 2026-09-28 (supersedes breadth7 7 × 0.10; see DEFAULT_MEANREV_CONFIG).
  meanrev_stocks: "experiments/meanrev-slot12-pure-v1.json",
  // Same candidate as momentum-crypto-vt35-pure-v1 (asOf 2026-07-15), re-run
  // 2026-09-26 on a window that includes the live months (asOf latest).
  momentum_crypto: "experiments/momentum-crypto-2026w-control-pure-v1.json",
  // AUTHORITATIVE but NOT gate-certified (U1 rounds 3-5, 2026-09-26): the
  // DAILY kernel d13-s5-blend-63-126-252 (artifact 752767ae…) passes 15/17
  // gates (PSR 0.979, stress/LOO, break-even >30 bps, turnover 10.4×/yr)
  // and fails maxDrawdown (52.4%>45) + excess vs BTC (−24.4pp) — declared
  // honestly. It replaced the refuted hourly control (4b403501…: 10/17
  // failed, break-even 4.2 bps vs ~20 bps real cost) per the pre-registered
  // wiring criterion: most improvement over the same-window hourly control
  // (aaa0bcca…) on Sharpe AND maxDD with the highest break-even. Owner
  // rule: the sleeve keeps trading on the best-known design. Provenance +
  // reversion criteria: MOMENTUM_USDC_DAILY_HORIZON's comment in index.ts.
  momentum_crypto_usdc: "experiments/momentum-crypto-usdc-daily-s5-pure-v1.json",
} as const;

export type LiveSleeveId = keyof typeof LIVE_SLEEVE_MANIFESTS;

export interface LiveSleeveConfig {
  sleeve: LiveSleeveId;
  /** Authoritative experiment manifest (repo-root relative). */
  manifestPath: string;
  /** The live wiring expressed as a walk-forward CandidateConfig. */
  candidate: LiveCandidateConfig;
  /** Live universe, ORDER-SENSITIVE (meanrev's cutler RSI tie-break and the
   *  momentum rank sort both resolve ties by iteration order). */
  universe: string[];
  /** RiskGuard config the live engine effectively runs (defaults + the
   *  sleeve's overrides), MINUS equitySemantics — that key selects which
   *  broker ledger the equity read comes from; the sim broker hands equity
   *  to the engine directly, so there is nothing for it to model. */
  effectiveRisk: RiskGuardConfig;
  /** Sleeve capital base (RISK_PROFILES[..].initialEquity) — the manifest's
   *  ledger.initialEquity counterpart. */
  initialEquity: number;
  /** Profile fixed-stop FALLBACK as a fraction (rows without a persisted
   *  vol stop) — the manifest's ledger.hardStopPct counterpart. */
  hardStopFallbackPct: number;
}

/** DEFAULT_RISK_CONFIG + candidate/live overrides — how BOTH the live
 *  engines and the replay engines resolve their RiskGuard config. */
export function effectiveRiskConfig(overrides?: Partial<RiskGuardConfig>): RiskGuardConfig {
  const { equitySemantics: _dropped, ...rest } = { ...DEFAULT_RISK_CONFIG, ...(overrides ?? {}) };
  return rest as RiskGuardConfig;
}

/** momentum_stocks — live wiring under MOMENTUM_STOCKS_DAILY_HORIZON.
 *  Throws if the daily horizon is switched off: the k8-s8 manifest only
 *  validates the daily kernel, so a revert to the 5m kernel MUST re-point
 *  LIVE_SLEEVE_MANIFESTS and re-derive (loud failure, never silent). */
export function liveMomentumStocksConfig(): LiveSleeveConfig {
  const horizon = MOMENTUM_STOCKS_DAILY_HORIZON;
  if (!horizon) {
    throw new Error(
      "liveMomentumStocksConfig: MOMENTUM_STOCKS_DAILY_HORIZON is null (5m kernel) — " +
      "the k8-s8 manifest no longer describes the live sleeve; re-derive against the 5m manifest",
    );
  }
  return {
    sleeve: "momentum_stocks",
    manifestPath: LIVE_SLEEVE_MANIFESTS.momentum_stocks,
    candidate: {
      name: "live:momentum_stocks",
      cadenceMin: 1440, // one decision per ET trading day ≥ 09:35
      notionalPctPerSlot: MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT,
      entryPct: DEFAULT_TSM_CONFIG.entryThresholdPct,
      exitPct: DEFAULT_TSM_CONFIG.exitThresholdPct,
      maxLongs: MOMENTUM_STOCKS_MAX_LONGS,
      maxShorts: DEFAULT_TSM_CONFIG.maxShorts,
      ...(horizon.lookbackDaysList
        ? { lookbackDaysList: [...horizon.lookbackDaysList] }
        : { lookbackDays: horizon.lookbackDays }),
      maLengthDays: horizon.maLengthDays,
      slotHysteresis: MOMENTUM_STOCKS_SLOT_HYSTERESIS,
      hardStop: { mode: "volScaled", ...MOMENTUM_STOCKS_DAILY_VOL_STOP },
      tsmTrail: { ...MOMENTUM_STOCKS_DAILY_VOL_STOP },
      sharpeGate: { ...MOMENTUM_SLEEVE_SHARPE_GATE },
      risk: { peakHalfLifeDays: DEFAULT_RISK_CONFIG.peakHalfLifeDays },
      // Live-only runtime backstop — see the test's declared-exceptions list.
      maxGrossExposureMult: MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT,
    },
    universe: [...MOMENTUM_STOCKS_UNIVERSE],
    effectiveRisk: effectiveRiskConfig({ peakHalfLifeDays: DEFAULT_RISK_CONFIG.peakHalfLifeDays }),
    initialEquity: RISK_PROFILES.momentum_stocks.initialEquity,
    hardStopFallbackPct: RISK_PROFILES.momentum_stocks.stopLossPct / 100,
  };
}

/** meanrev_stocks — DEFAULT_MEANREV_CONFIG is already the single source for
 *  the strategy knobs; index.ts adds only the vol stop + backstop. */
export function liveMeanRevStocksConfig(): LiveSleeveConfig {
  return {
    sleeve: "meanrev_stocks",
    manifestPath: LIVE_SLEEVE_MANIFESTS.meanrev_stocks,
    candidate: {
      name: "live:meanrev_stocks",
      cadenceMin: 1440,
      hardStop: { mode: "volScaled", ...MEANREV_STOCKS_VOL_STOP },
      meanrev: {
        entryRsi: DEFAULT_MEANREV_CONFIG.entryRsi,
        smaLong: DEFAULT_MEANREV_CONFIG.smaLong,
        smaExit: DEFAULT_MEANREV_CONFIG.smaExit,
        timeStopDays: DEFAULT_MEANREV_CONFIG.timeStopDays,
        maxPositions: DEFAULT_MEANREV_CONFIG.maxPositions,
        slotPct: DEFAULT_MEANREV_CONFIG.slotPct,
        // rsiMethod / deterministicTieBreak: only forwarded when the live
        // engine sets them (today both are undefined = legacy cutler +
        // iteration-order tie-break, matching the manifest's absence).
        ...(DEFAULT_MEANREV_CONFIG.rsiMethod !== undefined ? { rsiMethod: DEFAULT_MEANREV_CONFIG.rsiMethod } : {}),
        ...(DEFAULT_MEANREV_CONFIG.deterministicTieBreak !== undefined
          ? { deterministicTieBreak: DEFAULT_MEANREV_CONFIG.deterministicTieBreak }
          : {}),
      },
    },
    universe: [...DEFAULT_MEANREV_CONFIG.universe],
    effectiveRisk: effectiveRiskConfig(DEFAULT_MEANREV_CONFIG.risk),
    initialEquity: RISK_PROFILES.meanrev_stocks.initialEquity,
    hardStopFallbackPct: RISK_PROFILES.meanrev_stocks.stopLossPct / 100,
  };
}

/** momentum_crypto — 60min TSM on the 8-perp universe, vt-35 sizing. */
export function liveMomentumCryptoConfig(): LiveSleeveConfig {
  return {
    sleeve: "momentum_crypto",
    manifestPath: LIVE_SLEEVE_MANIFESTS.momentum_crypto,
    candidate: {
      name: "live:momentum_crypto",
      cadenceMin: 60,
      notionalPctPerSlot: MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT,
      entryPct: DEFAULT_TSM_CONFIG.entryThresholdPct,
      exitPct: DEFAULT_TSM_CONFIG.exitThresholdPct,
      maxLongs: MOMENTUM_CRYPTO_MAX_LONGS,
      maxShorts: DEFAULT_TSM_CONFIG.maxShorts,
      // lookbackDays/maLengthDays deliberately ABSENT: the crypto sleeve
      // runs the engine defaults (14/30), exactly like the manifest.
      volTarget: { ...MOMENTUM_CRYPTO_VOL_TARGET },
      sharpeGate: { ...MOMENTUM_SLEEVE_SHARPE_GATE },
      risk: { peakHalfLifeDays: DEFAULT_RISK_CONFIG.peakHalfLifeDays },
      maxGrossExposureMult: MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT,
    },
    universe: [...MOMENTUM_CRYPTO_UNIVERSE],
    effectiveRisk: effectiveRiskConfig({ peakHalfLifeDays: DEFAULT_RISK_CONFIG.peakHalfLifeDays }),
    initialEquity: RISK_PROFILES.momentum_crypto.initialEquity,
    hardStopFallbackPct: RISK_PROFILES.momentum_crypto.stopLossPct / 100,
  };
}

/** momentum_crypto_usdc — DAILY TSM blend on the 13 USDC-margined perps
 *  (U1 rounds 3-5; artifact 752767ae…). The manifest's universe is the
 *  USDT-perp PROXY of the same bases ("BASE/USD" internal symbols: USDC
 *  contracts lack pre-2023 history and the USDC/USDT basis is negligible
 *  vs the sleeve's ~20 bps/side measured costs — declared in the
 *  manifest), so the derivation maps the live "BASE/USDC" keys onto their
 *  proxy series, preserving USDC_SYMBOL_MAP's order. */
export function liveMomentumUsdcConfig(): LiveSleeveConfig {
  const horizon = MOMENTUM_USDC_DAILY_HORIZON;
  return {
    sleeve: "momentum_crypto_usdc",
    manifestPath: LIVE_SLEEVE_MANIFESTS.momentum_crypto_usdc,
    candidate: {
      name: "live:momentum_crypto_usdc",
      cadenceMin: 1440, // one decision per UTC day, 00:00 + 15s
      notionalPctPerSlot: MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT,
      entryPct: DEFAULT_TSM_CONFIG.entryThresholdPct,
      exitPct: DEFAULT_TSM_CONFIG.exitThresholdPct,
      maxLongs: MOMENTUM_USDC_MAX_LONGS,
      maxShorts: DEFAULT_TSM_CONFIG.maxShorts,
      lookbackDaysList: [...horizon.lookbackDaysList!],
      maLengthDays: horizon.maLengthDays,
      slotHysteresis: true,
      hardStop: { mode: "volScaled", ...MOMENTUM_USDC_DAILY_VOL_STOP },
      tsmTrail: { ...MOMENTUM_USDC_DAILY_VOL_STOP },
      // No volTarget: the vt35/vtcap hourly redesign candidates LOST
      // (artifacts 65500e1e…, e37f99cf…) — the USDT sleeve's volTarget
      // must NOT leak here.
      sharpeGate: { ...MOMENTUM_SLEEVE_SHARPE_GATE },
      risk: { peakHalfLifeDays: DEFAULT_RISK_CONFIG.peakHalfLifeDays },
      maxGrossExposureMult: MOMENTUM_USDC_MAX_GROSS_EXPOSURE_MULT,
    },
    universe: Object.keys(USDC_SYMBOL_MAP).map(s => s.replace("/USDC", "/USD")),
    effectiveRisk: effectiveRiskConfig({ peakHalfLifeDays: DEFAULT_RISK_CONFIG.peakHalfLifeDays }),
    initialEquity: RISK_PROFILES.momentum_crypto_usdc.initialEquity,
    hardStopFallbackPct: RISK_PROFILES.momentum_crypto_usdc.stopLossPct / 100,
  };
}

export function liveSleeveConfig(sleeve: LiveSleeveId): LiveSleeveConfig {
  switch (sleeve) {
    case "momentum_stocks": return liveMomentumStocksConfig();
    case "meanrev_stocks": return liveMeanRevStocksConfig();
    case "momentum_crypto": return liveMomentumCryptoConfig();
    case "momentum_crypto_usdc": return liveMomentumUsdcConfig();
  }
}

/** meanrev_stocks gross backstop re-exported for the module's own test
 *  (slotPct × maxPositions must equal it — the "never binds" premise). */
export { MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT, MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT, MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT };
