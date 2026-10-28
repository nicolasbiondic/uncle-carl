#!/usr/bin/env bun
/**
 * Manifest-driven nested walk-forward protocol for the v8 momentum sleeves.
 *
 *   - Deterministic expanding outer + inner folds with purged gaps.
 *   - Inner fold candidate selection uses corrected DSR → median Sharpe →
 *     median drawdown → hash tie-break.
 *   - Outer folds run only the selected candidate; stress costs run the same
 *     candidate without reselection.
 *   - Stitched OOS equity curve, per-symbol/fold concentration, and
 *     leave-one-symbol-out sensitivity.
 *   - SHA-256 canonical hashes for config, data snapshot, and code.
 *   - Outputs under ignored data/backtests/<manifestHash>/.
 *   - Approval is impossible if the prior trial ledger is incomplete or any
 *     acceptance gate fails. Nothing is auto-deployed.
 *
 * Usage:
 *   bun run experiment:wf -- experiments/momentum-stocks-v1.json
 *   bun run experiment:wf -- experiments/momentum-crypto-v1.json --dry-run
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  loadBars,
  runWithConfig,
  hashReplayConfig,
  isRth,
  latestCommonAsOf,
  type HardStopSpec,
  type MeanRevSimParams,
  type ProfitLockSpec,
  type ReplayConfig,
  type ReplayResult,
  type Sleeve,
} from "./backtest-momentum-wf";
import { runMeanRevReplay } from "./meanrev-replay";
import {
  autocorrPenalty,
  deflatedSharpe,
  kurtosis,
  mean as seriesMean,
  skewness,
  stdev as seriesStdev,
} from "../src/reports/metrics";
// PSR/MinTRL come from trackRecord (per-observation moments convention,
// γ₄ NON-excess) — the same instrument the live dashboard uses, so the
// protocol's outer verdict and production speak the same statistics.
import { minTrlObservations, probabilisticSharpe as psrFromMoments } from "../src/portfolio/trackRecord";
import { computeSequenceRisk, type SequenceRiskSummary } from "./lib/sequenceRisk";
import { expandDataPath } from "./lib/researchData";
import { hashCloseSlices } from "./lib/closeSlices";
import { hashSignalEvents } from "./lib/signalData";
import { missingLiveExcludes } from "./lib/liveStockExcludes";
import { breakoutHistoryDays, validateBreakoutShort, idleOverlayHistoryDays, validateIdleOverlay, type BreakoutShortConfig, type IdleOverlayConfig, type ExposureControlConfig, type MarketTrendGateConfig, type ShortStopSpec, type TimeStopConfig, type TrailStopConfig, type TrendExitConfig, type VolSizingConfig, type VolTargetConfig } from "../src/strategies/momentum/MomentumEngine";
import type { RiskGuardConfig, RiskState } from "../src/strategies/momentum/RiskGuard";
import { getETDateKey } from "../src/db/database";
import type { PortfolioStrategyConfig, VenueRules } from "../src/portfolio-engine/types";
import { overlaySymbols } from "../src/portfolio-engine/contingency";

// ── CLI ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const manifestPath = args.find(a => a.endsWith(".json")) ?? "";
const dryRun = args.includes("--dry-run");
// Skip the break-even slippage curve (6 cost tiers × outer folds of extra
// replays) on quick iterations. Any manifest gating on
// minBreakEvenSlippageBps then fails CLOSED ("curve not computed").
const noBreakEven = args.includes("--no-breakeven");

// ── types ─────────────────────────────────────────────────────────────
export interface CandidateConfig {
  name: string;
  cadenceMin: number;
  notionalPctPerSlot?: number;
  /** Momentum execution knobs — required for stocks/crypto candidates,
   *  FORBIDDEN for meanrev candidates (enforced in validateCandidate). */
  entryPct?: number;
  exitPct?: number;
  maxLongs?: number;
  maxShorts?: number;
  /** Short-side entry threshold in PERCENT, strictly negative (TSMConfig.
   *  shortEntryThresholdPct via ReplayConfig.shortEntryPct). Line-S axis.
   *  Absent = engine default (−5) AND the legacy candidate hash. Requires
   *  maxShorts ≥ 1 (inert otherwise — the class every axis here rejects). */
  shortEntryPct?: number;
  /** Short-side exit threshold in PERCENT, > shortEntryPct (TSMConfig.
   *  shortExitThresholdPct). Absent = engine default (+2) AND the legacy
   *  hash. Requires maxShorts ≥ 1. */
  shortExitPct?: number;
  /** Short-regime gate (TSMConfig.shortRegime — line S): shorts only enter
   *  or stay while refSymbol's last CLOSED UTC daily close < SMA(maDays) of
   *  its daily closes; otherwise a held short's decision is exit. FAIL
   *  CLOSED on missing data (opposite of marketTrend's fail-open). Absent =
   *  OFF AND the legacy hash. Requires maxShorts ≥ 1. */
  shortRegime?: { refSymbol: string; maDays: number };
  /** Short-universe restriction (TSMConfig.shortUniverse): only these
   *  symbols may fill short slots. Absent = OFF AND the legacy hash.
   *  Requires maxShorts ≥ 1. */
  shortUniverse?: string[];
  /** Short-only stop distance (line S-bis — MomentumEngine.ShortStopSpec):
   *  fixed pct is a FRACTION (0.08 = 8%); volScaled is kSigma × the σ of
   *  DAILY log returns over lookbackDays COMPLETED UTC daily closes,
   *  clamped [minPct, maxPct] PERCENT-units. Longs keep hardStop/
   *  hardStopPct. Absent = OFF AND the legacy hash. Requires maxShorts ≥ 1. */
  shortStop?: ShortStopSpec;
  /** TSM lookback horizon in bar-math DAYS (ReplayConfig.lookbackDays →
   *  TimeSeriesMomentum.lookbackDays; trading days on stocks via
   *  barMinutesEq). The horizon axis (momentum-stocks-horizon-v1): the
   *  inherited crypto default is 14d, individual-stock continuation lives
   *  at 3-12 months (Jegadeesh-Titman 1993). Momentum sleeves only. Absent
   *  = engine default (14) AND the legacy candidate hash. */
  lookbackDays?: number;
  /** TSM moving-average trend-filter length in bar-math DAYS
   *  (maLengthDays). Momentum sleeves only. Absent = engine default (30)
   *  AND the legacy candidate hash. */
  maLengthDays?: number;
  /** TSM multi-horizon signal (ReplayConfig.lookbackDaysList →
   *  TSMConfig.lookbackDaysList; Hurst/Ooi/Pedersen 2017): r = MEAN of the
   *  lookback returns over each horizon (bar-math days), thresholds on the
   *  blended r, MA unchanged. Mutually exclusive with lookbackDays (one
   *  signal definition per candidate). Momentum sleeves only. Absent =
   *  single-horizon AND the legacy candidate hash. */
  lookbackDaysList?: number[];
  /** Post-hard-stop re-entry cooldown in DECISION bars (B2, sweepable):
   *  only the sim's "stop_loss" close arms it — trail/signal-flip exits
   *  ("rebalance") never do. 0/absent = off; candidateToReplayConfig
   *  normalizes 0 to absent so both keep the legacy hash (and an explicit-0
   *  candidate duplicates the incumbent — caught by the duplicate guard).
   *  Momentum sleeves only: the meanrev runner would silently ignore it,
   *  so it is FORBIDDEN there like the other momentum-only knobs. */
  cooldownBarsAfterStop?: number;
  volTarget?: VolTargetConfig;
  /** Inverse-volatility ENTRY sizing (ReplayConfig.volSizing →
   *  MomentumEngineConfig.volSizing; Moskowitz/Ooi/Pedersen 2012, Barroso &
   *  Santa-Clara 2015): entry notional = equity × notionalPctPerSlot ×
   *  clamp(σ_ref/σᵢ, minScale, maxScale), σ_ref = median universe σ on the
   *  tick. Entries only; gross cap unaffected. Momentum sleeves only.
   *  Absent = OFF (legacy sizing AND the legacy candidate hash). */
  volSizing?: VolSizingConfig;
  tsmTrail?: TrailStopConfig;
  sharpeGate?: { lookbackDays: number; minSharpe: number };
  /** Engine-level time barrier (MomentumEngine.timeStop) — momentum sleeves
   *  only (meanrev has its own timeStopDays inside `meanrev`). Absent = OFF
   *  (production incumbent). */
  timeStop?: TimeStopConfig;
  /** RW7: remove the one-decision trail/time-stop re-entry veto. Default off. */
  allowSameTickReentry?: boolean;
  /** Market-trend entry gate (MomentumEngine.marketTrend): block NEW
   *  entries while `symbol`'s last CLOSED UTC daily close is below its
   *  `maDays` SMA (e.g. BTC/USD < SMA200). Momentum sleeves only. Absent =
   *  OFF (production incumbent AND the legacy hash). */
  marketTrend?: MarketTrendGateConfig;
  risk?: Partial<RiskGuardConfig>;
  /** Portfolio exposure control (RW4a, 2026-10-23 — ReplayConfig.
   *  exposureControl → MomentumEngineConfig.exposureControl): resizes the
   *  OPEN book toward one sleeve-level scale λ from realized book vol
   *  (volCap) and/or RiskGuard drawdown (drawdown), with a hysteresis band
   *  and a minimum order size. Momentum sleeves only (the meanrev runner
   *  would silently ignore it). Absent = OFF AND the legacy candidate hash. */
  exposureControl?: ExposureControlConfig;
  /** Own-coin completed daily SMA exit + long entry restriction; absent = OFF. */
  trendExit?: TrendExitConfig;
  idleOverlay?: IdleOverlayConfig;
  breakoutShort?: BreakoutShortConfig;
  /** Present iff the manifest sleeve is "meanrev" (enforced in validateManifest). */
  meanrev?: MeanRevSimParams;
  /** Hard-stop axis (stop-sizing sweep) — valid on EVERY sleeve, including
   *  meanrev (it parametrizes the AccountManager-parity protection, not a
   *  momentum knob). Absent = fixed at ledger.hardStopPct. */
  hardStop?: HardStopSpec;
  /** Profit-lock axis (ReplayConfig passthrough — see ProfitLockSpec).
   *  Momentum sleeves only (forbidden on meanrev — that runner doesn't
   *  implement it, so it would be config that changes nothing). Absent =
   *  off (legacy hash). */
  profitLock?: ProfitLockSpec;
  /** TSM slot-displacement hysteresis toggle (axis owned by the simulator
   *  stream — ReplayConfig.slotHysteresis). Momentum sleeves only. Absent =
   *  legacy displacement behavior AND the legacy hash. */
  slotHysteresis?: boolean;
  /** Regime-filter axis: the literal string "off" normalizes to
   *  `{ enabled: false }` in the replay config; an object is forwarded
   *  verbatim (merged over the engine's injected barMinutes — see
   *  runWithConfig). Momentum sleeves only. Absent = legacy (filter on). */
  regime?: { enabled?: boolean; [k: string]: unknown } | "off";
  /** Aggregate gross-exposure cap multiplier (ReplayConfig passthrough →
   *  MomentumEngineConfig / MeanRevEngineConfig). Valid on EVERY sleeve
   *  since 2026-10-05 (G gross-cap diagnostic): the meanrev runner now
   *  forwards it to the real MeanRevEngine (cap = baseUsd × mult, the live
   *  semantics), the momentum runners always did (cap = equity × mult).
   *  Absent = OFF — engine default AND the legacy candidate hash. */
  maxGrossExposureMult?: number;
  /** Meanrev RSI computation method: Cutler (SMA — the incumbent) vs
   *  Wilder (smoothed — the Connors-literature convention). Meanrev sleeve
   *  only; mapped into meanrev sim params by candidateToReplayConfig.
   *  Absent = "cutler" (legacy hash). */
  rsiMethod?: "cutler" | "wilder";
  /** Meanrev deterministic candidate-ordering tie-break. Meanrev sleeve
   *  only; mapped into meanrev sim params. Absent = legacy iteration
   *  order (legacy hash). */
  deterministicTieBreak?: boolean;
  /** RW portfolio engine (docs/reports/RW-reescritura-rentable.md §2, 2026-10-20):
   *  the candidate IS a pure PortfolioStrategyConfig (D1 xassetTrend / D2
   *  factorCore / D3 cryptoTrend) plus the simulator's venue rules. Present
   *  ⇒ the candidate runs ONLY through scripts/portfolio-replay.ts (driver
   *  scripts/portfolio-wf.ts; defaultReplayRunner refuses it) and every
   *  momentum/meanrev knob is FORBIDDEN (config that changes nothing). The
   *  cost model derives from costs.{base,stress} + data.funding. Absent =
   *  legacy candidate AND legacy hash (canonicalJson drops undefined). */
  portfolio?: PortfolioCandidateBlock;
}

/** The candidate `portfolio` block — see CandidateConfig.portfolio. Both
 *  parts enter the candidate identity (hashReplayConfig over
 *  PortfolioReplayConfig.portfolio): two candidates differing only in a venue
 *  rule execute differently and must hash differently. */
export interface PortfolioCandidateBlock {
  strategy: PortfolioStrategyConfig;
  venue: VenueRules;
}

/** A resolved replay config carrying a portfolio candidate. Structurally a
 *  ReplayConfig (the protocol's runner signature is unchanged); the portfolio
 *  runner narrows with isPortfolioReplayConfig and fails closed otherwise. */
export type PortfolioReplayConfig = ReplayConfig & { portfolio: PortfolioCandidateBlock };

export function isPortfolioReplayConfig(cfg: ReplayConfig): cfg is PortfolioReplayConfig {
  return (cfg as PortfolioReplayConfig).portfolio !== undefined;
}

/**
 * Canonical list of CandidateConfig keys that affect execution or risk.
 * Used to validate and reject unknown fields that would be silently dropped.
 */
const VALID_CANDIDATE_KEYS = new Set<keyof CandidateConfig>([
  "name",
  "cadenceMin",
  "notionalPctPerSlot",
  "entryPct",
  "exitPct",
  "maxLongs",
  "maxShorts",
  "shortEntryPct",
  "shortExitPct",
  "shortRegime",
  "shortUniverse",
  "shortStop",
  "lookbackDays",
  "maLengthDays",
  "lookbackDaysList",
  "cooldownBarsAfterStop",
  "volTarget",
  "volSizing",
  "tsmTrail",
  "sharpeGate",
  "timeStop",
  "allowSameTickReentry",
  "marketTrend",
  "risk",
  "exposureControl",
  "trendExit",
  "idleOverlay",
  "breakoutShort",
  "meanrev",
  "hardStop",
  "profitLock",
  "slotHysteresis",
  "regime",
  "maxGrossExposureMult",
  "rsiMethod",
  "deterministicTieBreak",
  "portfolio",
]);

/**
 * Validate a TimeStopConfig. Strict key allowlist — an unknown key would be
 * silently dropped by the engine (config that changes nothing), so throw.
 */
function validateTimeStop(t: unknown): void {
  if (!t || typeof t !== "object") throw new Error("timeStop must be an object");
  const obj = t as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(k => k !== "maxHoldHours");
  if (unknown.length > 0) throw new Error(`timeStop has unknown keys: ${unknown.join(", ")}`);
  if (!Number.isFinite(obj.maxHoldHours) || (obj.maxHoldHours as number) <= 0) {
    throw new Error("timeStop.maxHoldHours must be a positive number of calendar hours");
  }
}

/**
 * Validate a MarketTrendGateConfig. Strict key allowlist — an unknown key
 * would be silently dropped by the engine (config that changes nothing).
 */
function validateMarketTrend(mt: unknown): void {
  if (!mt || typeof mt !== "object") throw new Error("marketTrend must be an object");
  const obj = mt as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(k => k !== "symbol" && k !== "maDays");
  if (unknown.length > 0) throw new Error(`marketTrend has unknown keys: ${unknown.join(", ")}`);
  if (typeof obj.symbol !== "string" || obj.symbol.length === 0) {
    throw new Error("marketTrend.symbol must be a non-empty string");
  }
  if (!Number.isInteger(obj.maDays) || (obj.maDays as number) < 2) {
    throw new Error("marketTrend.maDays must be an integer >= 2 (closed UTC days)");
  }
}

/**
 * Validate a CandidateConfig.risk block (Partial<RiskGuardConfig>). Until
 * 2026-09-25 the block was forwarded verbatim with NO key check, so a typo'd
 * key was silently dropped (config that changes nothing — the class every
 * other axis here rejects). Strict allowlist = RiskGuardConfig's keys;
 * `ddScale` (the continuous drawdown-sizing axis) additionally gets a strict
 * shape check: FRACTION units like its RiskGuardConfig siblings (startPct
 * 0.05 = 5% — NOT percent-units), endPct > startPct, optional minScale in
 * [0, 1). Legacy numeric keys (softDrawdownPct 1.0 as the breakers-v1
 * ablation pattern, etc.) keep their historical freedom — no range checks
 * are retrofitted onto manifests that already ran.
 */
function validateRisk(r: unknown): void {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("risk must be an object");
  const obj = r as Record<string, unknown>;
  const allowed = [
    "dailyLossCapPct", "softDrawdownPct", "hardDrawdownPct", "consecutiveLossLimit",
    "softPauseHours", "hardPauseHours", "peakHalfLifeDays", "equitySemantics", "ddScale", "shadowResume", "mode",
  ];
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length > 0) throw new Error(`risk has unknown keys: ${unknown.join(", ")}`);
  if (obj.mode !== undefined && obj.mode !== "sizeOnly") throw new Error('risk.mode must be "sizeOnly"');
  if (obj.mode === "sizeOnly" && (obj.ddScale !== undefined || obj.shadowResume !== undefined)) {
    throw new Error("risk.mode sizeOnly cannot combine with ddScale or shadowResume; use exposureControl for sizing");
  }
  if (obj.ddScale !== undefined) {
    const dd = obj.ddScale as Record<string, unknown>;
    if (!dd || typeof dd !== "object" || Array.isArray(dd)) throw new Error("risk.ddScale must be an object");
    const ddUnknown = Object.keys(dd).filter(k => !["startPct", "endPct", "minScale"].includes(k));
    if (ddUnknown.length > 0) throw new Error(`risk.ddScale has unknown keys: ${ddUnknown.join(", ")}`);
    const start = dd.startPct as number, end = dd.endPct as number;
    if (!Number.isFinite(start) || start < 0 || start >= 1) {
      throw new Error("risk.ddScale.startPct must be a drawdown FRACTION in [0, 1), e.g. 0.05 = 5%");
    }
    if (!Number.isFinite(end) || end <= start || end > 1) {
      throw new Error("risk.ddScale.endPct must be a drawdown FRACTION in (startPct, 1]");
    }
    if (dd.minScale !== undefined && (!Number.isFinite(dd.minScale) || (dd.minScale as number) < 0 || (dd.minScale as number) >= 1)) {
      throw new Error("risk.ddScale.minScale must be in [0, 1)");
    }
  }
  // Shadow-equity resume axis (2026-09-26): strict shape like ddScale —
  // recoverPct is a virtual-equity gain FRACTION, costBpsPerSide an
  // OPTIONAL per-side cost estimate in bps (engine default 9).
  if (obj.shadowResume !== undefined) {
    const sr = obj.shadowResume as Record<string, unknown>;
    if (!sr || typeof sr !== "object" || Array.isArray(sr)) throw new Error("risk.shadowResume must be an object");
    const srUnknown = Object.keys(sr).filter(k => !["recoverPct", "costBpsPerSide"].includes(k));
    if (srUnknown.length > 0) throw new Error(`risk.shadowResume has unknown keys: ${srUnknown.join(", ")}`);
    if (!Number.isFinite(sr.recoverPct) || (sr.recoverPct as number) <= 0 || (sr.recoverPct as number) >= 1) {
      throw new Error("risk.shadowResume.recoverPct must be a gain FRACTION in (0, 1), e.g. 0.03 = 3%");
    }
    if (sr.costBpsPerSide !== undefined && (!Number.isFinite(sr.costBpsPerSide) || (sr.costBpsPerSide as number) < 0)) {
      throw new Error("risk.shadowResume.costBpsPerSide must be a non-negative number of bps");
    }
  }
}

/**
 * Validate an ExposureControlConfig (RW4a). Strict key allowlists at every
 * level — an unknown key would be silently dropped by the engine (config that
 * changes nothing). At least one axis (volCap, drawdown) must be present:
 * a control with no axis is λ ≡ 1, i.e. the incumbent plus a hash change.
 * Units: drawdown.* are FRACTIONS like RiskGuardConfig (0.05 = 5%);
 * volCap.annualizedPct is PERCENT like VolTargetConfig (35 = 35%/yr);
 * minScale/band are fractions; minOrderUsd is USD.
 */
function validateExposureControl(x: unknown): void {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("exposureControl must be an object");
  const obj = x as Record<string, unknown>;
  const allowed = ["volCap", "drawdown", "minScale", "band", "minOrderUsd"];
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length > 0) throw new Error(`exposureControl has unknown keys: ${unknown.join(", ")}`);
  if (obj.volCap === undefined && obj.drawdown === undefined) {
    throw new Error("exposureControl needs at least one axis: volCap and/or drawdown");
  }
  if (obj.volCap !== undefined) {
    const v = obj.volCap as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("exposureControl.volCap must be an object");
    const vUnknown = Object.keys(v).filter(k => !["annualizedPct", "fastBars", "slowBars"].includes(k));
    if (vUnknown.length > 0) throw new Error(`exposureControl.volCap has unknown keys: ${vUnknown.join(", ")}`);
    if (!Number.isFinite(v.annualizedPct) || (v.annualizedPct as number) < 1 || (v.annualizedPct as number) > 300) {
      throw new Error("exposureControl.volCap.annualizedPct must be PERCENT-units in [1, 300], e.g. 35 = 35%/yr");
    }
    if (!Number.isInteger(v.fastBars) || (v.fastBars as number) < 2) throw new Error("exposureControl.volCap.fastBars must be an integer >= 2");
    if (!Number.isInteger(v.slowBars) || (v.slowBars as number) < (v.fastBars as number)) throw new Error("exposureControl.volCap.slowBars must be an integer >= fastBars");
  }
  if (obj.drawdown !== undefined) {
    const d = obj.drawdown as Record<string, unknown>;
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("exposureControl.drawdown must be an object");
    const dUnknown = Object.keys(d).filter(k => !["startPct", "endPct", "reference"].includes(k));
    if (dUnknown.length > 0) throw new Error(`exposureControl.drawdown has unknown keys: ${dUnknown.join(", ")}`);
    if (d.reference !== undefined && d.reference !== "decayedPeak" && d.reference !== "highWaterMark") {
      throw new Error('exposureControl.drawdown.reference must be "decayedPeak" or "highWaterMark"');
    }
    const start = d.startPct as number, end = d.endPct as number;
    if (!Number.isFinite(start) || start < 0 || start >= 1) {
      throw new Error("exposureControl.drawdown.startPct must be a drawdown FRACTION in [0, 1), e.g. 0.05 = 5%");
    }
    if (!Number.isFinite(end) || end <= start || end > 1) {
      throw new Error("exposureControl.drawdown.endPct must be a drawdown FRACTION in (startPct, 1]");
    }
  }
  if (!Number.isFinite(obj.minScale) || (obj.minScale as number) <= 0 || (obj.minScale as number) > 1) {
    throw new Error("exposureControl.minScale must be a fraction in (0, 1] (0 would flatten the book — use the pauses for that)");
  }
  if (!Number.isFinite(obj.band) || (obj.band as number) < 0 || (obj.band as number) >= 1) {
    throw new Error("exposureControl.band must be a fraction in [0, 1), e.g. 0.10 = 10 pp of kept size");
  }
  if (!Number.isFinite(obj.minOrderUsd) || (obj.minOrderUsd as number) < 0) {
    throw new Error("exposureControl.minOrderUsd must be a non-negative number of USD");
  }
}

/**
 * Validate a VolSizingConfig. Strict key allowlist — an unknown key would be
 * silently dropped by the engine (config that changes nothing), so throw.
 * minScale/maxScale bound the σ_ref/σᵢ ratio; a floor of 0 would let a
 * high-vol name's slot vanish silently, so it must be strictly positive.
 */
function validateVolSizing(v: unknown): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("volSizing must be an object");
  const obj = v as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(k => !["lookbackBars", "minScale", "maxScale"].includes(k));
  if (unknown.length > 0) throw new Error(`volSizing has unknown keys: ${unknown.join(", ")}`);
  if (!Number.isInteger(obj.lookbackBars) || (obj.lookbackBars as number) < 2) {
    throw new Error("volSizing.lookbackBars must be an integer >= 2");
  }
  const minScale = obj.minScale as number, maxScale = obj.maxScale as number;
  if (!Number.isFinite(minScale) || minScale <= 0) throw new Error("volSizing.minScale must be positive");
  if (!Number.isFinite(maxScale) || maxScale < minScale) throw new Error("volSizing.maxScale must be >= minScale");
}

/**
 * Validate a HardStopSpec. Strict per-mode key allowlists: an unknown or
 * cross-mode key would be silently dropped by the simulators (config that
 * changes nothing), so it throws instead — same philosophy as
 * validateCandidate's unknown-key rejection.
 */
function validateHardStop(h: unknown): void {
  if (!h || typeof h !== "object") throw new Error("hardStop must be an object");
  const obj = h as Record<string, unknown>;
  const allowedByMode: Record<string, string[]> = {
    fixed: ["mode", "pct"],
    volScaled: ["mode", "kSigma", "lookbackBars", "minPct", "maxPct"],
    none: ["mode"],
  };
  const mode = obj.mode as string;
  const allowed = allowedByMode[mode];
  if (!allowed) throw new Error(`hardStop.mode must be "fixed", "volScaled" or "none", got ${JSON.stringify(obj.mode)}`);
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length > 0) throw new Error(`hardStop (mode ${mode}) has unknown keys: ${unknown.join(", ")}`);
  if (mode === "fixed") {
    if (!Number.isFinite(obj.pct) || (obj.pct as number) <= 0 || (obj.pct as number) >= 1) {
      throw new Error("hardStop.pct must be a fraction in (0, 1), e.g. 0.04");
    }
  } else if (mode === "volScaled") {
    if (!Number.isFinite(obj.kSigma) || (obj.kSigma as number) <= 0) throw new Error("hardStop.kSigma must be positive");
    if (!Number.isInteger(obj.lookbackBars) || (obj.lookbackBars as number) < 2) throw new Error("hardStop.lookbackBars must be an integer >= 2");
    const minPct = obj.minPct as number, maxPct = obj.maxPct as number;
    if (!Number.isFinite(minPct) || minPct <= 0) throw new Error("hardStop.minPct must be positive (percent-units, e.g. 2 = 2%)");
    if (!Number.isFinite(maxPct) || maxPct < minPct || maxPct >= 100) throw new Error("hardStop.maxPct must be >= minPct and < 100 (percent-units)");
  }
}

/**
 * Validate a ProfitLockSpec. Strict key allowlist, same philosophy as
 * validateHardStop: an invalid/unknown shape here is config that would
 * either be silently dropped or arm a lock that never actually moves the
 * stop — the "changes nothing" class every axis here rejects.
 */
function validateProfitLock(p: unknown): void {
  if (!p || typeof p !== "object") throw new Error("profitLock must be an object");
  const obj = p as Record<string, unknown>;
  const allowed = ["armAtPct", "mode", "lockPct"];
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length > 0) throw new Error(`profitLock has unknown keys: ${unknown.join(", ")}`);
  if (obj.mode !== "breakeven" && obj.mode !== "peakMinus") {
    throw new Error(`profitLock.mode must be "breakeven" or "peakMinus", got ${JSON.stringify(obj.mode)}`);
  }
  if (!Number.isFinite(obj.armAtPct) || (obj.armAtPct as number) <= 0) {
    throw new Error("profitLock.armAtPct must be positive (percent-units, e.g. 10 = +10%)");
  }
  if (!Number.isFinite(obj.lockPct) || (obj.lockPct as number) < 0) {
    throw new Error("profitLock.lockPct must be a non-negative number (percent-units)");
  }
}

/**
 * Validate a short-regime gate config (line S). Strict key allowlist — an
 * unknown key would be silently dropped by the engine (config that changes
 * nothing), so throw. Same shape discipline as validateMarketTrend.
 */
function validateShortRegime(sr: unknown): void {
  if (!sr || typeof sr !== "object" || Array.isArray(sr)) throw new Error("shortRegime must be an object");
  const obj = sr as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(k => k !== "refSymbol" && k !== "maDays");
  if (unknown.length > 0) throw new Error(`shortRegime has unknown keys: ${unknown.join(", ")}`);
  if (typeof obj.refSymbol !== "string" || obj.refSymbol.length === 0) {
    throw new Error("shortRegime.refSymbol must be a non-empty string");
  }
  if (!Number.isInteger(obj.maDays) || (obj.maDays as number) < 2) {
    throw new Error("shortRegime.maDays must be an integer >= 2 (closed UTC days)");
  }
}

/**
 * Validate a ShortStopSpec (line S-bis). Strict per-mode key allowlists,
 * same philosophy as validateHardStop. fixed.pct is a FRACTION;
 * volScaled.lookbackDays counts DAILY closes (not bars) with min/max in
 * PERCENT-units.
 */
function validateShortStop(ss: unknown): void {
  if (!ss || typeof ss !== "object" || Array.isArray(ss)) throw new Error("shortStop must be an object");
  const obj = ss as Record<string, unknown>;
  const allowedByMode: Record<string, string[]> = {
    fixed: ["mode", "pct"],
    volScaled: ["mode", "kSigma", "lookbackDays", "minPct", "maxPct"],
  };
  const mode = obj.mode as string;
  const allowed = allowedByMode[mode];
  if (!allowed) throw new Error(`shortStop.mode must be "fixed" or "volScaled", got ${JSON.stringify(obj.mode)}`);
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length > 0) throw new Error(`shortStop (mode ${mode}) has unknown keys: ${unknown.join(", ")}`);
  if (mode === "fixed") {
    if (!Number.isFinite(obj.pct) || (obj.pct as number) <= 0 || (obj.pct as number) >= 1) {
      throw new Error("shortStop.pct must be a fraction in (0, 1), e.g. 0.08");
    }
  } else {
    if (!Number.isFinite(obj.kSigma) || (obj.kSigma as number) <= 0) throw new Error("shortStop.kSigma must be positive");
    if (!Number.isInteger(obj.lookbackDays) || (obj.lookbackDays as number) < 2) throw new Error("shortStop.lookbackDays must be an integer >= 2 (DAILY closes)");
    const minPct = obj.minPct as number, maxPct = obj.maxPct as number;
    if (!Number.isFinite(minPct) || minPct <= 0) throw new Error("shortStop.minPct must be positive (percent-units, e.g. 6 = 6%)");
    if (!Number.isFinite(maxPct) || maxPct < minPct || maxPct >= 100) throw new Error("shortStop.maxPct must be >= minPct and < 100 (percent-units)");
  }
}

/** Canonical MeanRevSimParams keys; unknown keys are rejected like CandidateConfig's. */
const VALID_MEANREV_KEYS = new Set<keyof MeanRevSimParams>([
  "entryRsi",
  "smaLong",
  "smaExit",
  "timeStopDays",
  "maxPositions",
  "slotPct",
  "execution",
]);

// ── RW portfolio candidate block (strict shapes; unknown key = config that
// changes nothing = rejected, like every other axis in this file) ──────────
const posInt = (v: unknown, min = 1) => Number.isInteger(v) && (v as number) >= min;
const finiteIn = (v: unknown, lo: number, hi: number, loOpen = false, hiOpen = false) =>
  Number.isFinite(v) && (loOpen ? (v as number) > lo : (v as number) >= lo) && (hiOpen ? (v as number) < hi : (v as number) <= hi);

function assertKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length > 0) throw new Error(`${where} has unknown keys: ${unknown.join(", ")}`);
}

function assertSymbolList(v: unknown, where: string, allowEmpty = false): void {
  if (!Array.isArray(v) || (!allowEmpty && v.length === 0) || v.some(s => typeof s !== "string" || s.length === 0)) {
    throw new Error(`${where} must be a${allowEmpty ? "n" : " non-empty"} array of symbol strings`);
  }
  if (new Set(v).size !== v.length) throw new Error(`${where} must not contain duplicates`);
}

function validateTrendSignal(s: Record<string, unknown>, where: string): void {
  const bh = s.blendHorizons;
  if (!Array.isArray(bh) || bh.length === 0 || bh.some(h => !posInt(h))) throw new Error(`${where}.blendHorizons must be a non-empty array of positive integers`);
  if (new Set(bh).size !== bh.length) throw new Error(`${where}.blendHorizons must be distinct`);
  if (!posInt(s.maLong, 2)) throw new Error(`${where}.maLong must be an integer >= 2`);
  if (!finiteIn(s.signalBandPct, 0, 100)) throw new Error(`${where}.signalBandPct must be a percent in [0, 100] (0 = no band)`);
}

function validateTrendConstruction(s: Record<string, unknown>, where: string): void {
  assertSymbolList(s.universe, `${where}.universe`);
  if (!posInt(s.inceptionGuardBars)) throw new Error(`${where}.inceptionGuardBars must be a positive integer`);
  if (!posInt(s.volLookback, 2)) throw new Error(`${where}.volLookback must be an integer >= 2`);
  if (!posInt(s.covLookback, 2)) throw new Error(`${where}.covLookback must be an integer >= 2`);
  if (!finiteIn(s.portfolioVolTarget, 0, 2, true, true)) throw new Error(`${where}.portfolioVolTarget must be an annualized FRACTION in (0, 2), e.g. 0.12`);
  if (!finiteIn(s.perAssetCap, 0, 10, true)) throw new Error(`${where}.perAssetCap must be a positive weight fraction`);
  if (!finiteIn(s.maxGross, 0, 10, true)) throw new Error(`${where}.maxGross must be a positive gross fraction`);
}

function validateStopConfig(st: unknown, where: string): void {
  if (!st || typeof st !== "object" || Array.isArray(st)) throw new Error(`${where} must be an object`);
  const s = st as Record<string, unknown>;
  if (s.mode === "none") { assertKeys(s, ["mode"], where); return; }
  if (s.mode === "fixed") {
    assertKeys(s, ["mode", "pct"], where);
    if (!finiteIn(s.pct, 0, 100, true)) throw new Error(`${where}.pct must be a PERCENT in (0, 100], e.g. 4`);
    return;
  }
  if (s.mode === "volScaled") {
    assertKeys(s, ["mode", "kSigma", "lookbackBars", "minPct", "maxPct"], where);
    if (!finiteIn(s.kSigma, 0, 100, true)) throw new Error(`${where}.kSigma must be positive`);
    if (!posInt(s.lookbackBars, 2)) throw new Error(`${where}.lookbackBars must be an integer >= 2`);
    if (!finiteIn(s.minPct, 0, 100, true) || !finiteIn(s.maxPct, 0, 100, true) || (s.maxPct as number) < (s.minPct as number)) {
      throw new Error(`${where}.minPct/maxPct must be PERCENTS in (0, 100] with maxPct >= minPct`);
    }
    return;
  }
  throw new Error(`${where}.mode must be "none", "fixed" or "volScaled"`);
}

function configObject(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} must be an object`);
  return v as Record<string, unknown>;
}

function validateContingency(s: Record<string, unknown>, where: string): void {
  if (s.regimeOverlay === undefined && s.pitUniverse === undefined) return;
  if (s.annualization !== 252) throw new Error(`${where}: RW5 contingency knobs require stocks (annualization=252)`);
  if (!posInt(s.volLookback, 2) || !posInt(s.covLookback, 2)) throw new Error(`${where}: contingency requires volLookback/covLookback >= 2`);
  const symbol = (v: unknown, key: string) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${key} must be a non-empty symbol`);
  };
  if (s.pitUniverse !== undefined) {
    const key = `${where}.pitUniverse`, p = configObject(s.pitUniverse, key);
    assertKeys(p, ["topN", "liquidityLookback", "minHoldingRebalances", "exclude"], key);
    for (const k of ["topN", "liquidityLookback", "minHoldingRebalances"]) if (!posInt(p[k])) throw new Error(`${key}.${k} must be a positive integer`);
    if (p.exclude !== undefined) assertSymbolList(p.exclude, `${key}.exclude`, true);
  }
  if (s.regimeOverlay === undefined) return;
  const key = `${where}.regimeOverlay`, r = configObject(s.regimeOverlay, key);
  assertKeys(r, ["signals", "combine", "confirmationDecisions", "coreScale", "defensive", "hedge"], key);
  if (!Array.isArray(r.signals) || !r.signals.length) throw new Error(`${key}.signals must be a non-empty array`);
  if (r.combine !== "any" && r.combine !== "all" && !(posInt(r.combine) && (r.combine as number) <= r.signals.length)) throw new Error(`${key}.combine must be any, all or a count in [1, signals.length]`);
  if (r.confirmationDecisions !== undefined && !posInt(r.confirmationDecisions)) throw new Error(`${key}.confirmationDecisions must be a positive integer`);
  if (!finiteIn(r.coreScale, 0, 1)) throw new Error(`${key}.coreScale must be in [0, 1]`);
  for (const [i, raw] of r.signals.entries()) {
    const path = `${key}.signals[${i}]`, sig = configObject(raw, path);
    if (sig.kind === "maTrend") {
      assertKeys(sig, ["kind", "symbol", "period", "sampling", "bandPct"], path);
      symbol(sig.symbol, `${path}.symbol`);
      if (!posInt(sig.period, 2)) throw new Error(`${path}.period must be an integer >= 2`);
      if (sig.sampling !== "daily" && sig.sampling !== "monthEnd") throw new Error(`${path}.sampling must be daily or monthEnd`);
      if (sig.bandPct !== undefined && !finiteIn(sig.bandPct, 0, 100, false, true)) throw new Error(`${path}.bandPct must be in [0, 100)`);
    } else if (sig.kind === "absMomentum") {
      assertKeys(sig, ["kind", "symbol", "cashProxy", "lookback"], path);
      symbol(sig.symbol, `${path}.symbol`); symbol(sig.cashProxy, `${path}.cashProxy`);
      if (sig.symbol === sig.cashProxy) throw new Error(`${path}: symbol and cashProxy must differ`);
      if (!posInt(sig.lookback)) throw new Error(`${path}.lookback must be a positive integer`);
    } else if (sig.kind === "canary") {
      assertKeys(sig, ["kind", "assets", "horizons", "coefficients", "negativeCount"], path);
      assertSymbolList(sig.assets, `${path}.assets`);
      if (!Array.isArray(sig.horizons) || !sig.horizons.length || sig.horizons.some(n => !posInt(n)) || new Set(sig.horizons).size !== sig.horizons.length) throw new Error(`${path}.horizons must be distinct positive integers`);
      if (!Array.isArray(sig.coefficients) || sig.coefficients.length !== sig.horizons.length || sig.coefficients.some(n => !Number.isFinite(n) || n <= 0)) throw new Error(`${path}.coefficients must be positive and match horizons`);
      if (sig.negativeCount !== undefined && !(posInt(sig.negativeCount) && (sig.negativeCount as number) <= (sig.assets as string[]).length)) throw new Error(`${path}.negativeCount must be in [1, assets.length]`);
    } else throw new Error(`${path}.kind must be maTrend, absMomentum or canary`);
  }
  if (r.defensive !== undefined) {
    const d = configObject(r.defensive, `${key}.defensive`);
    assertKeys(d, ["assets", "momentumLookback", "volLookback", "cashProxy"], `${key}.defensive`);
    assertSymbolList(d.assets, `${key}.defensive.assets`);
    symbol(d.cashProxy, `${key}.defensive.cashProxy`);
    if (!posInt(d.momentumLookback) || !posInt(d.volLookback, 2)) throw new Error(`${key}.defensive requires momentumLookback >= 1 and volLookback >= 2`);
  }
  if (r.hedge !== undefined) {
    const h = configObject(r.hedge, `${key}.hedge`);
    assertKeys(h, ["symbol", "fraction"], `${key}.hedge`);
    symbol(h.symbol, `${key}.hedge.symbol`);
    if (!finiteIn(h.fraction, 0, 1, true)) throw new Error(`${key}.hedge.fraction must be in (0, 1]`);
    if ((s.universe as string[]).includes(h.symbol as string) || (r.defensive && [...((r.defensive as any).assets as string[]), (r.defensive as any).cashProxy].includes(h.symbol as string))) throw new Error(`${key}.hedge.symbol must not overlap the core or defensive set`);
  }
}

function validatePortfolioStrategy(st: unknown, where: string): void {
  if (!st || typeof st !== "object" || Array.isArray(st)) throw new Error(`${where} must be an object`);
  const s = st as Record<string, unknown>;
  const trendKeys = ["kind", "universe", "inceptionGuardBars", "volLookback", "covLookback", "portfolioVolTarget", "perAssetCap", "maxGross", "blendHorizons", "maLong", "signalBandPct"];
  if (s.kind === "volManaged") {
    assertKeys(s, ["kind", "universe", "inceptionGuardBars", "volLookback", "covLookback", "portfolioVolTarget", "annualization", "perAssetCap", "maxGross", "drawdownBrake", "fastVolLookback", "regimeOverlay", "pitUniverse", "maxHoldSessions", "maxHoldStagger"], where);
    assertSymbolList(s.universe, `${where}.universe`);
    for (const key of ["inceptionGuardBars", "volLookback", "covLookback"]) {
      if (!posInt(s[key])) throw new Error(`${where}.${key} must be a positive integer`);
    }
    if (!finiteIn(s.portfolioVolTarget, 0, 2, true)) throw new Error(`${where}.portfolioVolTarget must be an annualized FRACTION in (0, 2]`);
    if (s.annualization !== 252 && s.annualization !== 365) throw new Error(`${where}.annualization must be 252 or 365`);
    if (s.maxHoldSessions !== undefined && (!posInt(s.maxHoldSessions) || s.annualization !== 252)) {
      throw new Error(`${where}.maxHoldSessions must be a positive integer with annualization 252 (NYSE sessions)`);
    }
    if (s.maxHoldStagger !== undefined && (typeof s.maxHoldStagger !== "boolean" || s.maxHoldSessions === undefined)) {
      throw new Error(`${where}.maxHoldStagger requires a boolean and maxHoldSessions`);
    }
    if (!finiteIn(s.perAssetCap, 0, 1, true)) throw new Error(`${where}.perAssetCap must be a weight FRACTION in (0, 1]`);
    const grossLimit = s.regimeOverlay !== undefined || s.pitUniverse !== undefined ? 2.5 : 2;
    if (!finiteIn(s.maxGross, 0, grossLimit, true)) throw new Error(`${where}.maxGross must be a gross FRACTION in (0, ${grossLimit}]`);
    validateContingency(s, where);
    // RW4b (optional knobs): absent = RW2/RW3 behavior and hashes.
    if (s.fastVolLookback !== undefined) {
      if (!posInt(s.fastVolLookback, 2) || (s.fastVolLookback as number) >= (s.covLookback as number)) {
        throw new Error(`${where}.fastVolLookback must be an integer >= 2 and < covLookback (a FASTER estimate)`);
      }
    }
    if (s.drawdownBrake !== undefined) {
      const b = s.drawdownBrake;
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error(`${where}.drawdownBrake must be an object`);
      const br = b as Record<string, unknown>;
      assertKeys(br, ["startDrawdown", "maxDrawdown", "floorScale"], `${where}.drawdownBrake`);
      if (!finiteIn(br.startDrawdown, 0, 1, false, true)) throw new Error(`${where}.drawdownBrake.startDrawdown must be a drawdown FRACTION in [0, 1)`);
      if (!finiteIn(br.maxDrawdown, 0, 1, true) || (br.maxDrawdown as number) <= (br.startDrawdown as number)) {
        throw new Error(`${where}.drawdownBrake.maxDrawdown must be a drawdown FRACTION in (0, 1] and > startDrawdown`);
      }
      if (!finiteIn(br.floorScale, 0, 1, true)) throw new Error(`${where}.drawdownBrake.floorScale must be in (0, 1] (a zero floor could never recover)`);
    }
    return;
  }
  if (s.kind === "xassetTrend") {
    assertKeys(s, trendKeys, where);
    validateTrendSignal(s, where);
    validateTrendConstruction(s, where);
    return;
  }
  if (s.kind === "cryptoTrend") {
    assertKeys(s, [...trendKeys, "stop"], where);
    validateTrendSignal(s, where);
    validateTrendConstruction(s, where);
    validateStopConfig(s.stop, `${where}.stop`);
    return;
  }
  if (s.kind === "factorCore") {
    assertKeys(s, ["kind", "exclude", "topN", "score", "momentumWindow", "volWindow", "weightVolLookback", "perNameCap", "minPrice", "minPriorCloses", "overlay"], where);
    assertSymbolList(s.exclude, `${where}.exclude`, true);
    if (!posInt(s.topN)) throw new Error(`${where}.topN must be a positive integer`);
    if (s.score !== "momentum" && s.score !== "lowvol" && s.score !== "momentum+lowvol") throw new Error(`${where}.score must be "momentum", "lowvol" or "momentum+lowvol"`);
    const mw = s.momentumWindow;
    if (!Array.isArray(mw) || mw.length !== 2 || !posInt(mw[0]) || !posInt(mw[1], 0) || mw[0] <= mw[1]) {
      throw new Error(`${where}.momentumWindow must be [long, skip] integers with long > skip >= 0 (12-1 = [252, 21])`);
    }
    if (!posInt(s.volWindow, 2)) throw new Error(`${where}.volWindow must be an integer >= 2`);
    if (!posInt(s.weightVolLookback, 2)) throw new Error(`${where}.weightVolLookback must be an integer >= 2`);
    if (!finiteIn(s.perNameCap, 0, 1, true)) throw new Error(`${where}.perNameCap must be a weight FRACTION in (0, 1], e.g. 0.04`);
    if (!finiteIn(s.minPrice, 0, Infinity)) throw new Error(`${where}.minPrice must be a non-negative price`);
    if (!posInt(s.minPriorCloses)) throw new Error(`${where}.minPriorCloses must be a positive integer`);
    if (s.overlay !== null) {
      if (!s.overlay || typeof s.overlay !== "object" || Array.isArray(s.overlay)) throw new Error(`${where}.overlay must be null or an object`);
      const o = s.overlay as Record<string, unknown>;
      assertKeys(o, ["ref", "ma", "bandPct", "onExposure", "offExposure"], `${where}.overlay`);
      if (typeof o.ref !== "string" || o.ref.length === 0) throw new Error(`${where}.overlay.ref must be a symbol`);
      if (!posInt(o.ma, 2)) throw new Error(`${where}.overlay.ma must be an integer >= 2`);
      if (!finiteIn(o.bandPct, 0, 100)) throw new Error(`${where}.overlay.bandPct must be a percent in [0, 100]`);
      if (!finiteIn(o.onExposure, 0, 10) || !finiteIn(o.offExposure, 0, 10)) throw new Error(`${where}.overlay.onExposure/offExposure must be exposure fractions >= 0`);
    }
    return;
  }
  if (s.kind === "copySignal") {
    assertKeys(s, ["kind", "source", "lookbackDays", "minDistinctInsiders", "minDollar", "topN", "holdDays", "holdSessions", "weighting", "volLookback", "perNameCap", "maxGross", "exclude", "roles",
      "insiderClass", "exclude10b5_1", "maxReportLagDays", "minDollarPerInsider"], where);
    if (typeof s.source !== "string" || s.source.length === 0) throw new Error(`${where}.source must be a non-empty event source name`);
    for (const key of ["lookbackDays", "minDistinctInsiders", "topN"]) {
      if (!posInt(s[key])) throw new Error(`${where}.${key} must be a positive integer`);
    }
    if ((s.holdDays === undefined) === (s.holdSessions === undefined)) throw new Error(`${where} needs exactly one of holdDays (calendar days) / holdSessions (sessions)`);
    for (const key of ["holdDays", "holdSessions"]) {
      if (s[key] !== undefined && !posInt(s[key])) throw new Error(`${where}.${key} must be a positive integer`);
    }
    if (!finiteIn(s.minDollar, 0, Infinity)) throw new Error(`${where}.minDollar must be a non-negative dollar amount (0 = no floor)`);
    if (s.weighting !== "equal" && s.weighting !== "inverseVol") throw new Error(`${where}.weighting must be "equal" or "inverseVol"`);
    if (s.weighting === "inverseVol") {
      if (!posInt(s.volLookback, 2)) throw new Error(`${where}.volLookback must be an integer >= 2 (inverseVol)`);
    } else if (s.volLookback !== undefined) {
      throw new Error(`${where}.volLookback is only for weighting "inverseVol" (config that changes nothing)`);
    }
    if (!finiteIn(s.perNameCap, 0, 1, true)) throw new Error(`${where}.perNameCap must be a weight FRACTION in (0, 1]`);
    if (!finiteIn(s.maxGross, 0, 2, true)) throw new Error(`${where}.maxGross must be a gross FRACTION in (0, 2]`);
    assertSymbolList(s.exclude, `${where}.exclude`, true);
    if (s.roles !== undefined) assertSymbolList(s.roles, `${where}.roles`);
    if (s.insiderClass !== undefined && s.insiderClass !== "all" && s.insiderClass !== "opportunistic" && s.insiderClass !== "routine") {
      throw new Error(`${where}.insiderClass must be "all", "opportunistic" or "routine"`);
    }
    if (s.exclude10b5_1 !== undefined && typeof s.exclude10b5_1 !== "boolean") throw new Error(`${where}.exclude10b5_1 must be boolean`);
    if (s.maxReportLagDays !== undefined && !finiteIn(s.maxReportLagDays, 0, 3650)) throw new Error(`${where}.maxReportLagDays must be a number of days in [0, 3650]`);
    if (s.minDollarPerInsider !== undefined && !finiteIn(s.minDollarPerInsider, 0, Infinity)) throw new Error(`${where}.minDollarPerInsider must be a non-negative dollar amount`);
    return;
  }
  throw new Error(`${where}.kind must be "xassetTrend", "factorCore", "cryptoTrend", "volManaged" or "copySignal"`);
}

function validateVenueRules(v: unknown, where: string): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} must be an object`);
  const r = v as Record<string, unknown>;
  assertKeys(r, ["venue", "fractional", "minOrderNotional", "rebalanceBand", "qtyStep", "minNotional"], where);
  if (r.venue !== "alpaca" && r.venue !== "binance_usdm" && r.venue !== "binance_usdc") throw new Error(`${where}.venue must be "alpaca", "binance_usdm" or "binance_usdc"`);
  if (typeof r.fractional !== "boolean") throw new Error(`${where}.fractional must be boolean`);
  if (!finiteIn(r.minOrderNotional, 0, Infinity)) throw new Error(`${where}.minOrderNotional must be a non-negative notional`);
  if (!finiteIn(r.rebalanceBand, 0, 1, false, true)) throw new Error(`${where}.rebalanceBand must be an absolute weight in [0, 1)`);
  for (const k of ["qtyStep", "minNotional"] as const) {
    if (r[k] === undefined) continue;
    const rec = r[k];
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error(`${where}.${k} must be a symbol → positive number record`);
    for (const [sym, val] of Object.entries(rec as Record<string, unknown>)) {
      if (!finiteIn(val, 0, Infinity, true)) throw new Error(`${where}.${k}.${sym} must be a positive number`);
    }
  }
}

export function validatePortfolioBlock(p: unknown, where = "CandidateConfig.portfolio"): PortfolioCandidateBlock {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`${where} must be an object { strategy, venue }`);
  const b = p as Record<string, unknown>;
  assertKeys(b, ["strategy", "venue"], where);
  validatePortfolioStrategy(b.strategy, `${where}.strategy`);
  validateVenueRules(b.venue, `${where}.venue`);
  return b as unknown as PortfolioCandidateBlock;
}

/**
 * Validates a CandidateConfig object and rejects unknown keys.
 * Ensures all fields that change execution behavior are accounted for.
 */
export function validateCandidate(c: unknown): CandidateConfig {
  if (!c || typeof c !== "object") throw new Error("CandidateConfig must be an object");
  const obj = c as Record<string, unknown>;

  // Reject unknown keys
  const unknownKeys = Object.keys(obj).filter(k => !VALID_CANDIDATE_KEYS.has(k as keyof CandidateConfig));
  if (unknownKeys.length > 0) {
    throw new Error(`CandidateConfig has unknown keys that would be silently dropped: ${unknownKeys.join(", ")}`);
  }

  // Type-check required fields
  if (typeof obj.name !== "string") throw new Error("CandidateConfig.name must be a string");
  if (!Number.isFinite(obj.cadenceMin) || (obj.cadenceMin as number) <= 0) throw new Error("CandidateConfig.cadenceMin must be positive");

  if (obj.portfolio !== undefined) {
    // RW portfolio candidate: the strategy config IS the whole surface. Every
    // momentum/meanrev knob is config that changes nothing here → forbidden.
    const foreign = Object.keys(obj).filter(k => k !== "name" && k !== "cadenceMin" && k !== "portfolio");
    if (foreign.length > 0) throw new Error(`portfolio CandidateConfig must not set momentum/meanrev keys: ${foreign.join(", ")}`);
    if (obj.cadenceMin !== 1440) throw new Error("portfolio CandidateConfig.cadenceMin must be 1440 (one decision per session)");
    validatePortfolioBlock(obj.portfolio);
    return obj as CandidateConfig;
  }

  // The hard-stop axis is sleeve-agnostic: validated here, BEFORE the
  // meanrev branch (it is deliberately NOT in that branch's forbidden list).
  if (obj.hardStop !== undefined) validateHardStop(obj.hardStop);
  if (obj.timeStop !== undefined) validateTimeStop(obj.timeStop);
  if (obj.profitLock !== undefined) validateProfitLock(obj.profitLock);
  if (obj.marketTrend !== undefined) validateMarketTrend(obj.marketTrend);
  // `risk` is momentum-only (forbidden in the meanrev branch below), but its
  // SHAPE is validated up front like the other structured axes.
  if (obj.risk !== undefined) validateRisk(obj.risk);
  if (obj.allowSameTickReentry !== undefined && typeof obj.allowSameTickReentry !== "boolean") {
    throw new Error("allowSameTickReentry must be boolean");
  }
  // `volSizing` is momentum-only (forbidden below), shape-validated up front.
  if (obj.volSizing !== undefined) validateVolSizing(obj.volSizing);
  // `exposureControl` (RW4a) is momentum-only (forbidden below), shape-validated up front.
  if (obj.exposureControl !== undefined) validateExposureControl(obj.exposureControl);
  if (obj.idleOverlay !== undefined) validateIdleOverlay(obj.idleOverlay);
  if (obj.breakoutShort !== undefined) validateBreakoutShort(obj.breakoutShort);
  if (obj.trendExit !== undefined) {
    const t = obj.trendExit as Record<string, unknown>;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("trendExit must be an object");
    if (Object.keys(t).some(k => !["smaDays", "basis"].includes(k))) throw new Error("trendExit has unknown keys");
    if (!Number.isInteger(t.smaDays) || (t.smaDays as number) < 2) throw new Error("trendExit.smaDays must be an integer >= 2");
    if (t.basis !== "dailyClose") throw new Error('trendExit.basis must be "dailyClose"');
  }

  // New sweepable axes (2026-09): typed strictly here; sleeve ownership is
  // enforced below (momentum-only vs meanrev-only lists).
  if (obj.slotHysteresis !== undefined && typeof obj.slotHysteresis !== "boolean") {
    throw new Error("CandidateConfig.slotHysteresis must be boolean");
  }
  if (obj.maxGrossExposureMult !== undefined && (!Number.isFinite(obj.maxGrossExposureMult) || (obj.maxGrossExposureMult as number) <= 0)) {
    throw new Error("CandidateConfig.maxGrossExposureMult must be a positive number");
  }
  if (obj.regime !== undefined && obj.regime !== "off") {
    if (!obj.regime || typeof obj.regime !== "object" || Array.isArray(obj.regime)) {
      throw new Error('CandidateConfig.regime must be "off" or an object');
    }
    const enabled = (obj.regime as Record<string, unknown>).enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new Error("CandidateConfig.regime.enabled must be boolean");
    }
  }
  if (obj.rsiMethod !== undefined && obj.rsiMethod !== "cutler" && obj.rsiMethod !== "wilder") {
    throw new Error('CandidateConfig.rsiMethod must be "cutler" or "wilder"');
  }
  if (obj.deterministicTieBreak !== undefined && typeof obj.deterministicTieBreak !== "boolean") {
    throw new Error("CandidateConfig.deterministicTieBreak must be boolean");
  }

  if (obj.meanrev !== undefined) {
    // Meanrev candidate: the Connors params are the whole strategy surface.
    // Momentum-only knobs are FORBIDDEN (they would be silently ignored by
    // the meanrev runner, i.e. config that changes nothing).
    // maxGrossExposureMult left this list 2026-10-05: runMeanRevReplay now
    // forwards it to MeanRevEngine (it is no longer config that changes
    // nothing on meanrev) — see the G gross-cap diagnostic.
    const forbidden = ["entryPct", "exitPct", "maxLongs", "maxShorts", "shortEntryPct", "shortExitPct", "shortRegime", "shortUniverse", "shortStop", "notionalPctPerSlot", "volTarget", "volSizing", "tsmTrail", "sharpeGate", "timeStop", "allowSameTickReentry", "marketTrend", "risk", "exposureControl", "trendExit", "idleOverlay", "breakoutShort", "cooldownBarsAfterStop", "slotHysteresis", "regime", "profitLock", "lookbackDays", "maLengthDays", "lookbackDaysList"]
      .filter(k => obj[k] !== undefined);
    if (forbidden.length > 0) {
      throw new Error(`meanrev CandidateConfig must not set momentum-only keys: ${forbidden.join(", ")}`);
    }
    const mr = obj.meanrev as Record<string, unknown>;
    if (!mr || typeof mr !== "object") throw new Error("CandidateConfig.meanrev must be an object");
    const unknownMr = Object.keys(mr).filter(k => !VALID_MEANREV_KEYS.has(k as keyof MeanRevSimParams));
    if (unknownMr.length > 0) throw new Error(`CandidateConfig.meanrev has unknown keys: ${unknownMr.join(", ")}`);
    if (!Number.isFinite(mr.entryRsi) || (mr.entryRsi as number) <= 0 || (mr.entryRsi as number) >= 100) throw new Error("meanrev.entryRsi must be in (0, 100)");
    if (!Number.isInteger(mr.smaLong) || (mr.smaLong as number) < 2) throw new Error("meanrev.smaLong must be an integer >= 2");
    if (!Number.isInteger(mr.smaExit) || (mr.smaExit as number) < 1) throw new Error("meanrev.smaExit must be an integer >= 1");
    if (!Number.isInteger(mr.timeStopDays) || (mr.timeStopDays as number) < 1) throw new Error("meanrev.timeStopDays must be an integer >= 1");
    if (!Number.isInteger(mr.maxPositions) || (mr.maxPositions as number) < 1) throw new Error("meanrev.maxPositions must be an integer >= 1");
    if (!Number.isFinite(mr.slotPct) || (mr.slotPct as number) <= 0 || (mr.slotPct as number) > 1) throw new Error("meanrev.slotPct must be in (0, 1]");
    if (mr.execution !== undefined && mr.execution !== "close1545") {
      throw new Error('meanrev.execution only accepts "close1545" — omit the key for the legacy next-open execution');
    }
    return obj as CandidateConfig;
  }

  // Meanrev-only axes are FORBIDDEN on momentum candidates: the momentum
  // simulator would silently ignore them (config that changes nothing) —
  // same philosophy as the momentum-only list inside the meanrev branch.
  const meanrevOnly = ["rsiMethod", "deterministicTieBreak"].filter(k => obj[k] !== undefined);
  if (meanrevOnly.length > 0) {
    throw new Error(`momentum CandidateConfig must not set meanrev-only keys: ${meanrevOnly.join(", ")}`);
  }

  if (!Number.isFinite(obj.entryPct)) throw new Error("CandidateConfig.entryPct must be finite");
  if (!Number.isFinite(obj.exitPct)) throw new Error("CandidateConfig.exitPct must be finite");
  if (!Number.isInteger(obj.maxLongs) || (obj.maxLongs as number) < 0) throw new Error("CandidateConfig.maxLongs must be a non-negative integer");
  if (!Number.isInteger(obj.maxShorts) || (obj.maxShorts as number) < 0) throw new Error("CandidateConfig.maxShorts must be a non-negative integer");
  if (obj.idleOverlay !== undefined && obj.maxShorts !== 0) throw new Error("idleOverlay requires maxShorts=0 in the normal momentum book");
  if (obj.breakoutShort !== undefined && (obj.maxShorts !== 0 || obj.cadenceMin !== 60 || obj.idleOverlay !== undefined)) throw new Error("breakoutShort requires hourly long-only momentum and no idleOverlay");
  if ((obj.maxLongs as number) + (obj.maxShorts as number) === 0) throw new Error("CandidateConfig must allow at least one position");
  // Line-S short axes: every short knob is INERT unless the candidate can
  // actually short (maxShorts >= 1) — config that changes nothing is the
  // class this validator rejects everywhere else.
  const shortKeys = ["shortEntryPct", "shortExitPct", "shortRegime", "shortUniverse", "shortStop"].filter(k => obj[k] !== undefined);
  if (shortKeys.length > 0 && (obj.maxShorts as number) < 1) {
    throw new Error(`short-side keys (${shortKeys.join(", ")}) require maxShorts >= 1`);
  }
  if (obj.shortEntryPct !== undefined && (!Number.isFinite(obj.shortEntryPct) || (obj.shortEntryPct as number) >= 0)) {
    throw new Error("CandidateConfig.shortEntryPct must be a finite NEGATIVE percent (e.g. -5)");
  }
  if (obj.shortExitPct !== undefined) {
    if (!Number.isFinite(obj.shortExitPct)) throw new Error("CandidateConfig.shortExitPct must be finite (percent)");
    const entry = (obj.shortEntryPct as number | undefined) ?? -5; // engine default
    if ((obj.shortExitPct as number) <= entry) {
      throw new Error("CandidateConfig.shortExitPct must be > shortEntryPct (hysteresis: easier to stay than enter)");
    }
  }
  if (obj.shortRegime !== undefined) validateShortRegime(obj.shortRegime);
  if (obj.shortStop !== undefined) validateShortStop(obj.shortStop);
  if (obj.shortUniverse !== undefined) {
    const su = obj.shortUniverse;
    if (!Array.isArray(su) || su.length === 0 || su.some(s => typeof s !== "string" || s.length === 0)) {
      throw new Error("CandidateConfig.shortUniverse must be a non-empty array of symbol strings");
    }
    if (new Set(su).size !== su.length) throw new Error("CandidateConfig.shortUniverse must not contain duplicates");
  }
  if (obj.notionalPctPerSlot !== undefined && (!Number.isFinite(obj.notionalPctPerSlot) || (obj.notionalPctPerSlot as number) <= 0)) {
    throw new Error("CandidateConfig.notionalPctPerSlot must be positive");
  }
  if (obj.cooldownBarsAfterStop !== undefined && (!Number.isInteger(obj.cooldownBarsAfterStop) || (obj.cooldownBarsAfterStop as number) < 0)) {
    throw new Error("CandidateConfig.cooldownBarsAfterStop must be a non-negative integer (decision bars; 0 = off)");
  }
  // Horizon axis: strict integers so a fractional "day" can't silently
  // floor to a different bar count inside TimeSeriesMomentum.rank().
  if (obj.lookbackDays !== undefined && (!Number.isInteger(obj.lookbackDays) || (obj.lookbackDays as number) < 1)) {
    throw new Error("CandidateConfig.lookbackDays must be a positive integer (bar-math days)");
  }
  if (obj.maLengthDays !== undefined && (!Number.isInteger(obj.maLengthDays) || (obj.maLengthDays as number) < 1)) {
    throw new Error("CandidateConfig.maLengthDays must be a positive integer (bar-math days)");
  }
  // Multi-horizon axis: non-empty list of DISTINCT positive integers, and
  // mutually exclusive with lookbackDays — a candidate declares exactly ONE
  // signal definition (a single-element list already duplicates what
  // lookbackDays expresses, with a different hash — rejected as ambiguous).
  if (obj.lookbackDaysList !== undefined) {
    const list = obj.lookbackDaysList;
    if (!Array.isArray(list) || list.length < 2) {
      throw new Error("CandidateConfig.lookbackDaysList must be an array of >= 2 horizons (use lookbackDays for a single horizon)");
    }
    for (const d of list) {
      if (!Number.isInteger(d) || (d as number) < 1) {
        throw new Error("CandidateConfig.lookbackDaysList entries must be positive integers (bar-math days)");
      }
    }
    if (new Set(list).size !== list.length) {
      throw new Error("CandidateConfig.lookbackDaysList entries must be distinct");
    }
    if (obj.lookbackDays !== undefined) {
      throw new Error("CandidateConfig.lookbackDays and lookbackDaysList are mutually exclusive (one signal definition per candidate)");
    }
  }

  return obj as CandidateConfig;
}

export interface CostConfig {
  slippageBps: number;
  commissionBps: number;
  /** Reg-T margin financing (A3): the momentum simulator debits
   *  max(0, grossOpenNotional − equity) × annualRate/365 per UTC calendar
   *  day (weekends included — the broker charges those too). FRACTION per
   *  year, e.g. 0.075 = 7.5%. Absent = 0 charges and the candidate hash
   *  stays the legacy one (undefined keys are dropped). Forbidden on
   *  meanrev manifests (that runner doesn't model financing; leverage 1). */
  marginInterest?: { annualRate: number };
  /** Short-borrow financing (line S): the momentum sim debits gross SHORT
   *  notional × annualRate/365 per UTC calendar day, accrued per position
   *  so ClosedTrade.pnl nets it. Same calendar-day convention and fraction
   *  units as marginInterest; momentum-only (the meanrev runner never
   *  shorts). Absent = 0 charges AND the legacy candidate hash. */
  shortBorrow?: { annualRate: number };
}

export interface DataConfig {
  dbPath: string;
  source: string;
  timeframe: string;
  universe: string[];
  refSymbol: string;
  rthOnly: boolean;
  funding: boolean;
  barMinutes: number;
  barMinutesEq: number;
  /** Point-in-time index universe (ReplayConfig.membership — see its
   *  docstring in backtest-momentum-wf.ts): replay universe = declared
   *  `universe` ∪ index members whose tramo overlaps each fold, minus
   *  `exclude`. Daily stocks/meanrev only. Absent = legacy replays AND the
   *  legacy candidate hashes. */
  membership?: { index: string; exclude?: string[] };
  /** PIT liquidity screen on top of membership (ReplayConfig.liquidityRank):
   *  topN members by median dollar volume over lookbackSessions CLOSED
   *  sessions at each decision date. Requires membership. */
  liquidityRank?: { topN: number; lookbackSessions: number };
  /** PIT MONTHLY perp membership (ReplayConfig.perpsMembership — línea F,
   *  see its docstring in backtest-momentum-wf.ts): the line-A universe
   *  rule over the research perps DB. Crypto-with-funding only; mutually
   *  exclusive with `membership`. Absent = legacy replays AND the legacy
   *  candidate hashes. */
  perpsMembership?: { topN: number; volLookbackDays: number; minDays: number; freshDays: number };
  /** 15:45-slice database (§12-septies G0 — required when any candidate
   *  sets meanrev.execution="close1545"). Runtime-only path like dbPath:
   *  excluded from manifestIdentity; the slice ROWS enter the data identity
   *  via hashCloseSlices in runWalkForward. Absent = legacy. */
  sliceDb?: string;
  /** RW portfolio manifests only — REPORTING labels for the "P&L por clase
   *  de activo" diagnostic (symbol → class, e.g. "SPY": "equity"). Part of
   *  the manifest identity (configHash) like every declared field, never of
   *  a candidate hash (not forwarded to the replay config). Absent = every
   *  symbol reports under its sleeve. */
  assetClasses?: Record<string, string>;
  /** copySignal manifests only (required there, forbidden elsewhere): the signals
   *  database (table signal_events, scripts/lib/signalData.ts). `dbPath` is a
   *  machine-local path like data.dbPath: runtime-only, excluded from configHash and
   *  from every candidate hash; the rows copySignal can consume enter the run's DATA
   *  identity (hashSignalEvents) instead. Absent = every legacy manifest and its hashes. */
  signals?: { dbPath: string };
}

export interface WindowConfig {
  from: string;
  to: string;
  outerFoldCount: number;
  innerFoldCount: number;
  purgeYears: number;
  warmupDays: number;
}

export interface AcceptanceConfig {
  minSharpe?: number;
  maxDrawdown?: number;
  minTotalReturn?: number;
  /**
   * Benchmark-relative gates, both OPTIONAL and per-manifest — a strategy
   * that survives every absolute gate can still be strictly worse than
   * holding the benchmark (momentum_stocks passed with +7.6% against SPY
   * +43% — the OPEN.md P2 this closes). Which vara is fair depends on
   * exposure:
   *   - minExcessReturnVsBench (totalReturn − benchReturn): for
   *     full-exposure strategies (momentum) — always-in capital must beat
   *     what the same capital earns parked in the benchmark.
   *   - minExcessSharpeVsBench (sharpe − benchSharpe): for low-exposure
   *     strategies (meanrev, mostly in cash) — excess RETURN would unfairly
   *     punish a sleeve that only deploys ~50% notional on dip days; the
   *     fair vara is risk-adjusted quality per unit of volatility.
   * Each manifest picks the gate that matches its exposure profile.
   */
  minExcessReturnVsBench?: number;
  minExcessSharpeVsBench?: number;
  maxConcentration?: number;
  minTrades?: number;
  stressMinSharpe?: number;
  stressMaxDrawdown?: number;
  stressMinTotalReturn?: number;
  looMinSharpe?: number;
  looMaxDrawdown?: number;
  looMinTotalReturn?: number;
  /**
   * Evidence gates (2026-09 audit): until these existed, the outer verdict
   * NEVER read a significance statistic — PSR/DSR only entered the inner
   * selection, so a raw-threshold pass on ~2 good folds could look like
   * certification. ALL optional; an absent key is NOT evaluated, so every
   * pre-registered manifest keeps its exact legacy verdict.
   *
   *   - minOuterPsr: PSR of the stitched OOS daily series vs benchmark
   *     Sharpe 0, with the autocorrelation penalty applied to σ (multi-day
   *     holds serially correlate daily returns and overstate the naive SR).
   *   - minTrlSatisfied (only `true` is meaningful): the stitched OOS series
   *     must be at least as long as its own Minimum Track Record Length at
   *     95% (Bailey/López de Prado) — "the sample is long enough to support
   *     the Sharpe it shows". Fails closed when SR ≤ 0 (MinTRL infinite).
   *   - minFoldsPsrAbove: at least `count` outer folds must individually
   *     show PSR ≥ `threshold` — a single spectacular fold may no longer
   *     carry the whole verdict.
   *   - maxTurnoverAnnual / maxDisplacementShare: microstructure gates over
   *     the stitched outer results (annualized turnover; displacement closes
   *     as a fraction of all closes). Fail CLOSED with reason "metric not
   *     produced by replay" when the replay didn't emit the metric (e.g. a
   *     cached artifact from an older simulator).
   *   - minBreakEvenSlippageBps: the break-even curve's first Sharpe ≤ 0
   *     crossing must be at or beyond this many bps of slippage. Fails
   *     closed when the curve wasn't computed (--no-breakeven / dry-run).
   */
  minOuterPsr?: number;
  minTrlSatisfied?: boolean;
  minFoldsPsrAbove?: { threshold: number; count: number };
  maxTurnoverAnnual?: number;
  maxDisplacementShare?: number;
  minBreakEvenSlippageBps?: number;
  /**
   * Sequence-risk Monte Carlo gates (Jesse pattern, 2026-09-26 — see
   * scripts/lib/sequenceRisk.ts). BOTH optional like the other evidence
   * gates: an absent key is not evaluated, so every pre-registered manifest
   * keeps its exact legacy verdict. Fail CLOSED when summary.sequenceRisk
   * couldn't be computed (no outer OOS evidence / series too short).
   *
   *   - maxSequenceDdP95: the p95 max drawdown of the 10-day block
   *     bootstrap of the stitched OOS daily returns must be ≤ this
   *     FRACTION — "even an unlucky reordering of the same daily edge
   *     stays inside the declared risk budget".
   *   - maxObservedDdPercentile: the OBSERVED maxDD's percentile inside
   *     its simulated distribution (worst across bootstrap and trade
   *     reshuffle) must be ≤ this value, e.g. 0.975 — above it, the
   *     realized sequence was anomalously bad vs everything the same
   *     trades/returns could have produced (Jesse's replica flagged
   *     exactly this pattern).
   */
  maxSequenceDdP95?: number;
  maxObservedDdPercentile?: number;
}

export interface ExperimentManifest {
  name: string;
  sleeve: "stocks" | "crypto" | "meanrev";
  description?: string;
  trialAccounting: {
    priorUniqueTrials: number;
    complete: boolean;
  };
  data: DataConfig;
  asOf: string;
  window: WindowConfig;
  costs: { base: CostConfig; stress: CostConfig };
  ledger: {
    initialEquity: number;
    leverage: number;
    hardStopPct: number;
    notionalPctPerSlot?: number;
  };
  candidates: CandidateConfig[];
  acceptance: AcceptanceConfig;
  approved?: {
    candidateHash: string;
    selectedAt: string;
    reason: string;
  };
  trialLedger?: TrialRecord[];
}

export interface TrialRecord {
  id: string;
  candidateHash: string;
  candidateName: string;
  foldPath: string;
  costTier: "base" | "stress";
  fromMs: number;
  toMs: number;
  status: "pending" | "running" | "complete" | "failed";
  result?: ReplayResult;
  hash: string;
}

export interface Fold {
  path: string;
  fromMs: number;
  toMs: number;
}

export interface OuterFold {
  path: string;
  test: Fold;
  inner: Fold[];
}

export interface InnerMetrics {
  candidateHash: string;
  candidateName: string;
  foldPath: string;
  dsr: number;
  sharpe: number;
  maxDrawdown: number;
  totalReturn: number;
  trades: number;
}

export interface LooResult {
  excludedSymbol: string;
  stitchedReturn: number;
  stitchedSharpe: number;
  stitchedMaxDrawdown: number;
  totalTrades: number;
}

export interface WalkForwardSummary {
  manifestHash: string;
  configHash: string;
  dataHash: string;
  codeHash: string;
  asOfMs: number;
  resolvedTo: string;
  selectedCandidate: { hash: string; name: string; reason: string } | null;
  /** Winner of EACH executed outer fold's inner selection — the stitched
   *  OOS chain is composed of these candidates, which can differ per fold.
   *  `selectedCandidate` above is only the LAST fold's winner; reading the
   *  stitched metrics as belonging to it when this list is mixed caused
   *  the 2026-09-15 false "parity drift" alarm (a fold-0 candidate
   *  substitution read as simulator drift). Optional: summaries written
   *  before 2026-09-20 predate the field. */
  outerSelection?: Array<{ foldPath: string; candidateName: string; candidateHash: string }>;
  innerSelection: InnerMetrics[];
  outerTests: Array<{ foldPath: string; result: ReplayResult }>;
  stressTests: Array<{ foldPath: string; result: ReplayResult }>;
  stitchedOos: {
    totalReturn: number;
    sharpe: number;
    maxDrawdown: number;
    winRate: number;
    trades: number;
    orders?: number;
    ordersPerDay?: number;
    expectancy: number;
    fees: number;
    funding: number;
    /** Summed Reg-T margin interest across executed outer folds (A3);
     *  optional so summaries built before the axis existed stay valid. */
    marginInterest?: number;
    liquidations: number;
    marginRejects: number;
    ruined: boolean;
    /** refSymbol buy-and-hold over the SAME stitched OOS windows; absent
     *  only when no outer test executed (dry-run) — bench gates then fail
     *  closed if configured. */
    benchReturn?: number;
    benchSharpe?: number;
  };
  /** refSymbol buy-and-hold return per executed outer test fold. */
  benchByFold?: Array<{ foldPath: string; benchReturn: number }>;
  /** Why the benchmark could not be computed (missing/insufficient refSymbol
   *  bars). Bench gates, if configured, fail closed in that case. */
  benchError?: string;
  concentration: {
    maxTradesFracByFold: Array<{ foldPath: string; symbol: string; frac: number }>;
    maxPnlFracByFold: Array<{ foldPath: string; symbol: string; frac: number }>;
    totalTradesBySymbol: Record<string, number>;
    totalGrossPnlBySymbol: Record<string, number>;
  };
  loo: LooResult[];
  skippedFolds: string[];
  /** Evidence layer (2026-09) — ALL optional so summaries persisted before
   *  it existed stay type-valid, and so unit tests can build summaries
   *  without it (the gates then fail closed when configured). */
  /** Autocorr-penalized PSR of the stitched OOS daily series vs SR 0. */
  outerPsr?: number;
  /** MinTRL (observations) at 95% for the stitched series; null = infinite
   *  (SR ≤ 0: no track record length can certify an absent edge). */
  minTrl?: number | null;
  /** Daily observations in the stitched OOS series. */
  observations?: number;
  /** Autocorr-penalized PSR per executed outer fold (NaN = not computable). */
  foldPsr?: Array<{ foldPath: string; psr: number }>;
  /** Stitched Sharpe/return of the selected candidates re-run (same chains,
   *  NO reselection) at each slippage tier, base commission. */
  breakEvenCurve?: Array<{ slippageBps: number; sharpe: number; totalReturn: number }>;
  /** First Sharpe ≤ 0 crossing of the curve (linear interpolation);
   *  0 = already dead at 0 bps, Infinity = never crosses in the tested
   *  range (serializes as null in summary.json). */
  breakEvenSlippageBps?: number;
  /** Sequence-risk Monte Carlo over the stitched OOS chain (block bootstrap
   *  of daily returns + closed-trade reshuffle — scripts/lib/sequenceRisk.ts).
   *  Optional and additive: summaries persisted before 2026-09-26 predate
   *  the field; the two sequence gates fail closed when it is absent. */
  sequenceRisk?: SequenceRiskSummary;
  /** Power declaration: the smallest ANNUALIZED Sharpe that `observations`
   *  OOS days can certify at PSR 95% vs SR* = 0 (SR = 1.645·√ppy/√n).
   *  Informative only — a protocol run whose target edge is below this
   *  number is structurally undecidable at this window length. */
  certifiableSharpeAtPsr95?: number;
  acceptance: Record<string, { gate: string; value: number; threshold: number; pass: boolean; reason?: string }>;
  approved: boolean;
  approvalReason: string;
  complete: boolean;
  priorTrialsComplete: boolean;
}

// ── hashing ───────────────────────────────────────────────────────────
/**
 * Compute canonical SHA-256 hash over exact consumed historical_bars and funding_rates rows.
 * Validates that all required tables and rows exist; fails closed if data is incomplete.
 * Hash is deterministic across runs with the same data window and universe, regardless of fetched_at or page layout.
 */
export async function hashDataSnapshot(
  snapshotPath: string,
  sleeve: Sleeve,
  fromMs: number,
  toMs: number,
  warmupDays: number,
  membership?: { index: string; exclude?: string[] },
): Promise<string> {
  const loadFrom = fromMs - warmupDays * 86_400_000;
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const hash = createHash("sha256");

    // Validate and hash historical_bars: global window + warmup, deterministically ordered
    const declared = [...new Set(sleeve.universe)].sort();
    let universe = declared;
    // PIT membership (data.membership): the replays consume BOTH the
    // membership tramos and every overlapping member's bars — they are part
    // of the data identity. Members missing bars are reported by the
    // downloader and skipped by the replays (per-tramo presence), so only
    // DECLARED symbols fail closed on absent bars below.
    if (membership) {
      const rows = db.prepare(
        `SELECT ticker, start_date, end_date FROM index_membership
         WHERE index_id = ? ORDER BY ticker ASC, start_date ASC`,
      ).all(membership.index) as Array<{ ticker: string; start_date: string; end_date: string | null }>;
      if (rows.length === 0) throw new Error(`index_membership has no rows for index "${membership.index}" in the snapshot`);
      hash.update(`membership:${membership.index}:${rows.length}\n`);
      const excluded = new Set(membership.exclude ?? []);
      const memberSet = new Set<string>(declared);
      for (const r of rows) {
        hash.update(`${r.ticker}|${r.start_date}|${r.end_date ?? ""}\n`);
        const startMs = Date.parse(r.start_date);
        const endMs = r.end_date ? Date.parse(r.end_date) : null;
        if (!excluded.has(r.ticker) && startMs < toMs && (endMs === null || endMs > fromMs)) memberSet.add(r.ticker);
      }
      universe = [...memberSet].sort();
    }
    if (universe.length === 0) throw new Error("empty universe");
    const placeholders = universe.map(() => "?").join(",");
    const rawBarRows = db.prepare(`
      SELECT source, timeframe, symbol, timestamp, open, high, low, close, volume
      FROM historical_bars
      WHERE source = ? AND timeframe = ? AND symbol IN (${placeholders})
        AND timestamp >= ? AND timestamp < ?
      ORDER BY symbol ASC, timestamp ASC
    `).all(sleeve.source, sleeve.timeframe, ...universe, loadFrom, toMs) as any[];
    const barRows = sleeve.rthOnly ? rawBarRows.filter(row => isRth(row.timestamp)) : rawBarRows;

    // Check that all DECLARED universe symbols have bars (members fail
    // open per tramo — see the membership comment above).
    const barSymbols = new Set(barRows.map(r => r.symbol));
    for (const sym of declared) {
      if (!barSymbols.has(sym)) {
        throw new Error(`missing bars for symbol: ${sym}`);
      }
    }

    hash.update(`bars:${barRows.length}\n`);
    for (const row of barRows) {
      hash.update(`${row.source}|${row.timeframe}|${row.symbol}|${row.timestamp}|${row.open}|${row.high}|${row.low}|${row.close}|${row.volume}\n`);
    }

    // Validate and hash funding_rates if enabled
    if (sleeve.funding) {
      const perpSymbols = universe.map(s => s.replace("/USD", "USDT"));
      const fundingPlaceholders = perpSymbols.map(() => "?").join(",");
      const fundRows = db.prepare(`
        SELECT symbol, funding_time, rate
        FROM funding_rates
        WHERE symbol IN (${fundingPlaceholders}) AND funding_time >= ? AND funding_time <= ?
        ORDER BY symbol ASC, funding_time ASC
      `).all(...perpSymbols, fromMs, toMs) as any[];

      // Verify coverage for all symbols
      const fundSymbols = new Map<string, number>();
      for (const row of fundRows) {
        fundSymbols.set(row.symbol, (fundSymbols.get(row.symbol) ?? 0) + 1);
      }
      for (const perp of perpSymbols) {
        if (!fundSymbols.has(perp)) {
          throw new Error(`missing funding history for symbol: ${perp}`);
        }
      }

      hash.update(`funding:${fundRows.length}\n`);
      for (const row of fundRows) {
        hash.update(`${row.symbol}|${row.funding_time}|${row.rate}\n`);
      }
    }

    return hash.digest("hex");
  } finally {
    db.close();
  }
}

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, (key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) sorted[k] = (value as Record<string, unknown>)[k];
      return sorted;
    }
    return value;
  });
}

function hashString(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

export function runIdentityHash(configHash: string, dataHash: string, codeHash: string): string {
  return hashString(canonicalJson({ configHash, dataHash, codeHash }));
}

/** Default code-identity file list (exported so wrapper drivers can extend
 *  it via runWalkForward's opts.codeFiles without duplicating it). */
export const DEFAULT_CODE_FILES = [
    "bun.lock",
    "package.json",
    "scripts/backtest-momentum-wf.ts",
    "scripts/lib/closeSlices.ts",
    "scripts/lib/membership.ts",
    "scripts/meanrev-replay.ts",
    "scripts/walk-forward.ts",
    "src/strategies/meanrev/MeanRevEngine.ts",
    "src/config/riskProfiles.ts",
    "src/db/database.ts",
    "src/ops/heartbeat.ts",
    "src/reports/metrics.ts",
    "src/strategies/momentum/MomentumEngine.ts",
    "src/strategies/momentum/TimeSeriesMomentum.ts",
    "src/strategies/momentum/MomentumScorer.ts",
    "src/strategies/momentum/RegimeFilter.ts",
    "src/strategies/momentum/RiskGuard.ts",
    "src/strategies/momentum/Rebalancer.ts",
    "src/utils/marketHours.ts",
    // Engine-imported modules that previously did NOT invalidate artifacts
    // (2026-09 audit): a behavior change in any of these altered replay
    // output while old cached evidence kept validating.
    "src/utils/clock.ts",
    "src/config/index.ts",
    "src/ops/sleeveOutput.ts",
    "src/utils/events.ts",
  ].sort();

export async function hashCodeFiles(files = DEFAULT_CODE_FILES): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`runtime:${Bun.version}|${process.platform}|${process.arch}\n`);
  for (const f of files) {
    try {
      const text = readFileSync(f, "utf-8").replace(/\r\n/g, "\n");
      hash.update(text);
    } catch (e) {
      throw new Error(`required code file missing: ${f}`);
    }
  }
  return hash.digest("hex");
}

// ── manifest IO ───────────────────────────────────────────────────────
export function validateManifest(m: ExperimentManifest): ExperimentManifest {
  if (m.sleeve !== "stocks" && m.sleeve !== "crypto" && m.sleeve !== "meanrev") {
    throw new Error("sleeve must be stocks, crypto, or meanrev");
  }
  if (!m.trialAccounting || !Number.isInteger(m.trialAccounting.priorUniqueTrials) || m.trialAccounting.priorUniqueTrials < 0) {
    throw new Error("trialAccounting.priorUniqueTrials must be a non-negative integer");
  }
  if (typeof m.trialAccounting.complete !== "boolean") {
    throw new Error("trialAccounting.complete must be boolean");
  }
  if (!Array.isArray(m.data?.universe) || m.data.universe.length === 0) {
    throw new Error("data.universe must not be empty");
  }
  if (new Set(m.data.universe).size !== m.data.universe.length) {
    throw new Error("data.universe must not contain duplicates");
  }
  // Crypto meanrev (source binance_futures, 2026-09-25): the two stock-side
  // meanrev restrictions below don't apply — there is no shared Alpaca
  // wallet (refSymbol BTC/USD is one of the traded perps, like momentum),
  // and funding is REAL cost on the long book, so it is allowed (the
  // meanrev runner charges settled funding_rates events; validateManifest
  // still forbids it for every non-Binance meanrev source, where the
  // runner would have no perp-symbol mapping).
  const cryptoMeanrev = m.sleeve === "meanrev" && m.data.source === "binance_futures";
  if (m.sleeve === "meanrev" && !cryptoMeanrev) {
    // refSymbol is benchmark/timeline-only for meanrev and must NOT be
    // traded: MEANREV_UNIVERSE is disjoint from the momentum universe by
    // design (shared Alpaca wallet) and SPY belongs to momentum_stocks.
    if (m.data.universe.includes(m.data.refSymbol)) {
      throw new Error("meanrev data.refSymbol is benchmark-only and must NOT be in data.universe");
    }
    if (m.data.funding) throw new Error("meanrev manifests must set data.funding=false");
  } else if (m.data.perpsMembership !== undefined) {
    // Perps-membership mode (línea F): the refSymbol is benchmark-only,
    // exactly like meanrev — BTC is one of the 8 momentum_crypto bases the
    // universe rule EXCLUDES (disjoint USDT pool), and a declared symbol
    // would otherwise enter the tradable domain. The replay loads its bars
    // separately (see runWithConfig).
    if (m.data.universe.includes(m.data.refSymbol)) {
      throw new Error("perpsMembership data.refSymbol is benchmark-only and must NOT be in data.universe");
    }
  } else if (!m.data.universe.includes(m.data.refSymbol)) {
    throw new Error("data.refSymbol must be in data.universe");
  }
  if (!Array.isArray(m.candidates) || m.candidates.length === 0) {
    throw new Error("candidates must not be empty");
  }
  // RW portfolio manifests (every candidate carries `portfolio`): the daily
  // simulator has no leverage knob and no hard stop (stops are the design's,
  // inside the strategy config), so those ledger keys are forbidden there —
  // config that changes nothing. Legacy manifests keep the exact check below.
  const isPortfolioManifest = m.candidates.some(c => c && typeof c === "object" && (c as CandidateConfig).portfolio !== undefined);
  if (isPortfolioManifest) {
    if (!(m.ledger?.initialEquity > 0)) throw new Error("ledger.initialEquity must be positive");
    const extra = Object.keys(m.ledger).filter(k => k !== "initialEquity");
    if (extra.length > 0) throw new Error(`portfolio manifests set ledger.initialEquity only (unused keys: ${extra.join(", ")})`);
  } else if (!(m.ledger?.initialEquity > 0) || !(m.ledger.leverage > 0) || !(m.ledger.hardStopPct > 0 && m.ledger.hardStopPct < 1)) {
    throw new Error("ledger values must be positive and hardStopPct must be below 1");
  }
  // A3 margin-interest cost knob: strict keys and fraction bounds (0.075 =
  // 7.5%/yr; a percent-units 7.5 would be a 750%/yr typo). Valid on EVERY
  // sleeve since 2026-10-09 (línea E): SimMeanRevBroker.accrueMarginInterest
  // now models Reg-T financing with the same calendar-day semantics as the
  // momentum SimBroker (it used to be forbidden here as config that changes
  // nothing) — locked by scripts/meanrev-replay.marginInterest.test.ts.
  for (const tier of ["base", "stress"] as const) {
    const mi = m.costs?.[tier]?.marginInterest;
    if (mi !== undefined) {
      const unknown = Object.keys(mi).filter(k => k !== "annualRate");
      if (unknown.length > 0) throw new Error(`costs.${tier}.marginInterest has unknown keys: ${unknown.join(", ")}`);
      if (!Number.isFinite(mi.annualRate) || mi.annualRate < 0 || mi.annualRate >= 1) {
        throw new Error(`costs.${tier}.marginInterest.annualRate must be a fraction in [0, 1), e.g. 0.075 = 7.5%/yr`);
      }
    }
    // Line-S short-borrow cost knob: same shape discipline as marginInterest
    // but momentum-only (the meanrev runner is long-only — the key would be
    // config that changes nothing there).
    const sb = m.costs?.[tier]?.shortBorrow;
    if (sb !== undefined) {
      if (m.sleeve === "meanrev") {
        throw new Error(`meanrev manifests must not set costs.${tier}.shortBorrow (the meanrev runner never shorts)`);
      }
      const unknown = Object.keys(sb).filter(k => k !== "annualRate");
      if (unknown.length > 0) throw new Error(`costs.${tier}.shortBorrow has unknown keys: ${unknown.join(", ")}`);
      if (!Number.isFinite(sb.annualRate) || sb.annualRate < 0 || sb.annualRate >= 1) {
        throw new Error(`costs.${tier}.shortBorrow.annualRate must be a fraction in [0, 1), e.g. 0.005 = 0.5%/yr`);
      }
    }
  }
  if (!Number.isFinite(Date.parse(m.window?.from)) || !Number.isFinite(Date.parse(m.window?.to))) {
    throw new Error("window.from and window.to must be valid dates");
  }
  // PIT membership axes: strict shapes (an unknown key would be config that
  // changes nothing — the class every other axis here rejects).
  if (m.data.membership !== undefined) {
    const mb = m.data.membership as Record<string, unknown>;
    const unknown = Object.keys(mb).filter(k => k !== "index" && k !== "exclude");
    if (unknown.length > 0) throw new Error(`data.membership has unknown keys: ${unknown.join(", ")}`);
    if (typeof mb.index !== "string" || mb.index.length === 0) throw new Error("data.membership.index must be a non-empty string");
    if (mb.exclude !== undefined) {
      if (!Array.isArray(mb.exclude) || mb.exclude.some(s => typeof s !== "string" || s.length === 0)) {
        throw new Error("data.membership.exclude must be an array of ticker strings");
      }
      if (new Set(mb.exclude).size !== mb.exclude.length) throw new Error("data.membership.exclude must not contain duplicates");
    }
    if (m.sleeve === "crypto") throw new Error("data.membership is stocks/meanrev-only (index membership has no crypto analog)");
    if (m.data.barMinutes < 1440 || m.data.rthOnly || m.data.funding) {
      throw new Error("data.membership requires daily bars (barMinutes>=1440, rthOnly=false, funding=false)");
    }
  }
  if (m.data.liquidityRank !== undefined) {
    if (m.data.membership === undefined) throw new Error("data.liquidityRank requires data.membership");
    const lrk = m.data.liquidityRank as Record<string, unknown>;
    const unknown = Object.keys(lrk).filter(k => k !== "topN" && k !== "lookbackSessions");
    if (unknown.length > 0) throw new Error(`data.liquidityRank has unknown keys: ${unknown.join(", ")}`);
    if (!Number.isInteger(lrk.topN) || (lrk.topN as number) < 1) throw new Error("data.liquidityRank.topN must be a positive integer");
    if (!Number.isInteger(lrk.lookbackSessions) || (lrk.lookbackSessions as number) < 2) throw new Error("data.liquidityRank.lookbackSessions must be an integer >= 2");
  }
  // Línea F: PIT monthly perp membership — strict shape, crypto-only.
  if (m.data.perpsMembership !== undefined) {
    const pm = m.data.perpsMembership as Record<string, unknown>;
    const keys = ["topN", "volLookbackDays", "minDays", "freshDays"];
    const unknown = Object.keys(pm).filter(k => !keys.includes(k));
    if (unknown.length > 0) throw new Error(`data.perpsMembership has unknown keys: ${unknown.join(", ")}`);
    for (const k of keys) {
      if (!Number.isInteger(pm[k]) || (pm[k] as number) < 1) throw new Error(`data.perpsMembership.${k} must be a positive integer`);
    }
    if (m.sleeve !== "crypto" || !m.data.funding || m.data.rthOnly) {
      throw new Error("data.perpsMembership requires the crypto sleeve with funding=true and rthOnly=false");
    }
    if (m.data.membership !== undefined) throw new Error("data.perpsMembership is mutually exclusive with data.membership");
  }
  if (!Number.isInteger(m.window.outerFoldCount) || m.window.outerFoldCount < 1 || !Number.isInteger(m.window.innerFoldCount) || m.window.innerFoldCount < 0) {
    throw new Error("fold counts must be non-negative integers and outerFoldCount must be positive");
  }
  if (!(m.window.purgeYears >= 0) || !(m.window.warmupDays >= 0)) {
    throw new Error("purgeYears and warmupDays must be non-negative");
  }
  for (let i = 0; i < m.candidates.length; i++) {
    try {
      validateCandidate(m.candidates[i]);
      const idle = m.candidates[i].idleOverlay;
      const breakout = m.candidates[i].breakoutShort;
      if (breakout && (m.sleeve !== "crypto" || m.data.source !== "binance_futures" || m.data.timeframe !== "1h" || m.data.barMinutes !== 60 || m.data.barMinutesEq !== 60 || !m.data.funding || m.data.rthOnly || m.data.membership || m.data.perpsMembership || !m.data.universe.includes(breakout.symbol))) {
        throw new Error("breakoutShort requires fixed-universe hourly Binance crypto perpetuals with funding and BTC in data.universe");
      }
      if (idle && (m.sleeve !== "crypto" || m.data.source !== "binance_futures" || !m.data.funding || m.data.rthOnly || m.data.membership || m.data.perpsMembership || idle.symbols.some(s => !m.data.universe.includes(s)))) {
        throw new Error("idleOverlay requires fixed-universe Binance crypto perpetuals with funding and overlay symbols in data.universe");
      }
      if (m.sleeve === "meanrev" && !m.candidates[i].meanrev) {
        throw new Error("meanrev manifests require candidate.meanrev params");
      }
      if (m.sleeve !== "meanrev" && m.candidates[i].meanrev) {
        throw new Error(`sleeve "${m.sleeve}" candidates must not carry meanrev params`);
      }
    } catch (e) {
      throw new Error(`Candidate ${i} (${(m.candidates[i] as any).name ?? "unnamed"}): ${(e as Error).message}`);
    }
  }
  if (isPortfolioManifest) validatePortfolioManifest(m);
  if (m.data.signals !== undefined) {
    if (!isPortfolioManifest) throw new Error("data.signals is portfolio-manifest-only (copySignal)");
    const sg = m.data.signals as unknown as Record<string, unknown>;
    if (!sg || typeof sg !== "object" || Array.isArray(sg)) throw new Error("data.signals must be an object { dbPath }");
    const unknown = Object.keys(sg).filter(k => k !== "dbPath");
    if (unknown.length > 0) throw new Error(`data.signals has unknown keys: ${unknown.join(", ")}`);
    if (typeof sg.dbPath !== "string" || sg.dbPath.length === 0) throw new Error("data.signals.dbPath must be a non-empty path");
  }
  if (m.data.assetClasses !== undefined) {
    if (!isPortfolioManifest) throw new Error("data.assetClasses is portfolio-manifest-only (reporting labels for the RW diagnostics)");
    const ac = m.data.assetClasses;
    if (!ac || typeof ac !== "object" || Array.isArray(ac)) throw new Error("data.assetClasses must be a symbol → class record");
    for (const [sym, cls] of Object.entries(ac)) {
      if (typeof cls !== "string" || cls.length === 0) throw new Error(`data.assetClasses.${sym} must be a non-empty class label`);
    }
  }
  // §12-septies G0: the 15:45-slice DB and the close1545 execution mode come
  // and go together (a slice DB no candidate reads would be config that
  // changes nothing; a close1545 candidate without the DB fails the replay).
  {
    const wantsClose1545 = m.candidates.some(c => c.meanrev?.execution === "close1545");
    if (wantsClose1545 && !m.data.sliceDb) {
      throw new Error('meanrev.execution="close1545" requires data.sliceDb (the 15:45-slice database)');
    }
    if (m.data.sliceDb !== undefined) {
      if (typeof m.data.sliceDb !== "string" || m.data.sliceDb.length === 0) throw new Error("data.sliceDb must be a non-empty path");
      if (m.sleeve !== "meanrev" || m.data.source === "binance_futures") throw new Error("data.sliceDb is stocks-meanrev-only (close1545 execution)");
      if (!wantsClose1545) throw new Error('data.sliceDb set but no candidate uses meanrev.execution="close1545" (config that changes nothing)');
    }
  }
  // Evidence-gate thresholds: strict shapes so a typo'd gate can't silently
  // evaluate as "always pass" (same philosophy as the candidate allowlist).
  const acc = m.acceptance ?? ({} as AcceptanceConfig);
  if (acc.minOuterPsr !== undefined && !(Number.isFinite(acc.minOuterPsr) && acc.minOuterPsr >= 0 && acc.minOuterPsr <= 1)) {
    throw new Error("acceptance.minOuterPsr must be a probability in [0, 1]");
  }
  if (acc.minTrlSatisfied !== undefined && acc.minTrlSatisfied !== true) {
    throw new Error("acceptance.minTrlSatisfied only accepts true — omit the key to disable the gate");
  }
  if (acc.minFoldsPsrAbove !== undefined) {
    const f = acc.minFoldsPsrAbove;
    if (!f || typeof f !== "object") throw new Error("acceptance.minFoldsPsrAbove must be an object { threshold, count }");
    const unknown = Object.keys(f).filter(k => k !== "threshold" && k !== "count");
    if (unknown.length > 0) throw new Error(`acceptance.minFoldsPsrAbove has unknown keys: ${unknown.join(", ")}`);
    if (!Number.isFinite(f.threshold) || f.threshold < 0 || f.threshold > 1) {
      throw new Error("acceptance.minFoldsPsrAbove.threshold must be a probability in [0, 1]");
    }
    if (!Number.isInteger(f.count) || f.count < 1) {
      throw new Error("acceptance.minFoldsPsrAbove.count must be a positive integer");
    }
  }
  if (acc.maxTurnoverAnnual !== undefined && !(Number.isFinite(acc.maxTurnoverAnnual) && acc.maxTurnoverAnnual > 0)) {
    throw new Error("acceptance.maxTurnoverAnnual must be a positive number (× equity per year)");
  }
  if (acc.maxDisplacementShare !== undefined && !(Number.isFinite(acc.maxDisplacementShare) && acc.maxDisplacementShare >= 0 && acc.maxDisplacementShare <= 1)) {
    throw new Error("acceptance.maxDisplacementShare must be a fraction in [0, 1]");
  }
  if (acc.minBreakEvenSlippageBps !== undefined && !(Number.isFinite(acc.minBreakEvenSlippageBps) && acc.minBreakEvenSlippageBps >= 0)) {
    throw new Error("acceptance.minBreakEvenSlippageBps must be a non-negative number of bps");
  }
  if (acc.maxSequenceDdP95 !== undefined && !(Number.isFinite(acc.maxSequenceDdP95) && acc.maxSequenceDdP95 > 0 && acc.maxSequenceDdP95 <= 1)) {
    throw new Error("acceptance.maxSequenceDdP95 must be a drawdown FRACTION in (0, 1], e.g. 0.35");
  }
  if (acc.maxObservedDdPercentile !== undefined && !(Number.isFinite(acc.maxObservedDdPercentile) && acc.maxObservedDdPercentile > 0 && acc.maxObservedDdPercentile <= 1)) {
    throw new Error("acceptance.maxObservedDdPercentile must be a probability in (0, 1], e.g. 0.975");
  }
  return m;
}

/**
 * Manifest-level consistency of an RW portfolio manifest (every candidate
 * carries `portfolio`). One design per manifest; the data block must cover
 * every symbol the strategy can touch (so hashDataSnapshot's identity covers
 * the replay's inputs), daily bars only, and the cost/venue surface must match
 * the design's venue. Called by validateManifest after the per-candidate pass.
 */
export function validatePortfolioManifest(m: ExperimentManifest): void {
  const blocks = m.candidates.map(c => c.portfolio);
  if (blocks.some(b => b === undefined)) throw new Error("portfolio manifests require EVERY candidate to carry `portfolio` (one engine per manifest)");
  const kinds = new Set(blocks.map(b => b!.strategy.kind));
  if (kinds.size !== 1) throw new Error(`portfolio manifests hold ONE design: candidates mix kinds ${[...kinds].join(", ")}`);
  const kind = [...kinds][0];
  const isCrypto = kind === "cryptoTrend" || (kind === "volManaged" && m.sleeve === "crypto");
  if (isCrypto ? m.sleeve !== "crypto" : m.sleeve !== "stocks") {
    throw new Error(`portfolio kind "${kind}" requires sleeve "${isCrypto ? "crypto" : "stocks"}" (annualization/calendar), got "${m.sleeve}"`);
  }
  if (m.data.timeframe !== "1d" || m.data.barMinutes !== 1440 || m.data.rthOnly) {
    throw new Error("portfolio manifests require daily bars: data.timeframe=\"1d\", barMinutes=1440, rthOnly=false");
  }
  if (m.data.funding !== isCrypto) {
    throw new Error(isCrypto
      ? `${kind} requires data.funding=true (real funding is part of the pre-registered cost model)`
      : `${kind} requires data.funding=false (no perpetuals)`);
  }
  if (m.data.perpsMembership !== undefined || m.data.liquidityRank !== undefined) {
    throw new Error("portfolio manifests do not use data.perpsMembership / data.liquidityRank (momentum-kernel axes; config that changes nothing here)");
  }
  const pit = blocks.some(b => b!.strategy.kind === "volManaged" && b!.strategy.pitUniverse !== undefined);
  if (pit && !blocks.every(b => b!.strategy.kind === "volManaged" && b!.strategy.pitUniverse !== undefined)) throw new Error("pitUniverse requires all candidates to use the membership data domain");
  if (kind === "factorCore" || kind === "copySignal" || pit) {
    if (m.data.membership === undefined) throw new Error(`${kind} requires data.membership (point-in-time index universe)`);
    if (pit && m.data.membership.index !== "sp500") throw new Error("pitUniverse requires data.membership.index=sp500");
  } else if (m.data.membership !== undefined) {
    throw new Error(`${kind} must not set data.membership (its universe is the explicit strategy.universe)`);
  }
  if (kind === "copySignal") {
    if (m.data.signals === undefined) throw new Error("copySignal requires data.signals (the signals database)");
  } else if (m.data.signals !== undefined) {
    throw new Error(`${kind} must not set data.signals (config that changes nothing; copySignal only)`);
  }
  const declared = new Set(m.data.universe);
  for (const c of m.candidates) {
    const s = c.portfolio!.strategy;
    const where = `candidate "${c.name}"`;
    if (s.kind === "volManaged" && s.annualization !== (isCrypto ? 365 : 252)) {
      throw new Error(`${where}: volManaged annualization must be ${isCrypto ? 365 : 252} for sleeve "${m.sleeve}"`);
    }
    if (s.kind === "copySignal") {
      // The domain is the point-in-time membership; the events name the symbols. The shared Alpaca wallet
      // closes by aggregate position: no candidate may hold a live sleeve's symbol or a treasury ETF.
      const missing = missingLiveExcludes(s.exclude);
      if (missing.length > 0) throw new Error(`${where}: exclude must list every live stock universe and treasury symbol (shared Alpaca wallet); missing: ${missing.join(", ")}`);
    } else if (s.kind === "factorCore") {
      if (s.overlay && !declared.has(s.overlay.ref)) throw new Error(`${where}: overlay.ref ${s.overlay.ref} must be in data.universe`);
    } else {
      const symbols = s.kind === "volManaged" && s.regimeOverlay ? [...s.universe, ...overlaySymbols(s.regimeOverlay)] : s.universe;
      const missing = symbols.filter(sym => !declared.has(sym));
      if (missing.length > 0) throw new Error(`${where}: strategy.universe symbols missing from data.universe: ${missing.join(", ")}`);
    }
    const venue = c.portfolio!.venue.venue;
    if (isCrypto ? venue === "alpaca" : venue !== "alpaca") {
      throw new Error(`${where}: venue "${venue}" does not match design kind "${kind}"`);
    }
  }
  for (const tier of ["base", "stress"] as const) {
    if (m.costs?.[tier]?.shortBorrow !== undefined) throw new Error(`portfolio manifests are long-only: costs.${tier}.shortBorrow is config that changes nothing`);
  }
}

export function loadManifest(path: string): ExperimentManifest {
  const raw = readFileSync(path, "utf-8");
  const m = validateManifest(JSON.parse(raw) as ExperimentManifest);
  // Datasets outside the repo are named "$UC_RESEARCH_DATA_DIR/…": resolved
  // here, before anything opens or records the path (manifestIdentity leaves
  // dbPath — and sliceDb — out of the config hash anyway).
  m.data.dbPath = expandDataPath(m.data.dbPath);
  if (m.data.sliceDb !== undefined) m.data.sliceDb = expandDataPath(m.data.sliceDb);
  if (m.data.signals !== undefined) m.data.signals = { ...m.data.signals, dbPath: expandDataPath(m.data.signals.dbPath) };
  return m;
}

export function manifestToSleeve(m: ExperimentManifest): Sleeve {
  return {
    name: m.sleeve,
    // Include the refSymbol: the benchmark series participates in the data
    // snapshot hash and the latest-common asOf. For stocks/crypto the
    // refSymbol is already in the universe, so this is a no-op there (data
    // hashes of existing momentum artifacts are unchanged); for meanrev the
    // benchmark lives OUTSIDE the traded universe and must still be covered.
    universe: [...new Set([...m.data.universe, m.data.refSymbol])],
    timeframe: m.data.timeframe,
    barMinutes: m.data.barMinutes,
    barMinutesEq: m.data.barMinutesEq,
    slippageBps: m.costs.base.slippageBps,
    commissionBps: m.costs.base.commissionBps,
    funding: m.data.funding,
    windows: [],
    refSymbol: m.data.refSymbol,
    source: m.data.source,
    rthOnly: m.data.rthOnly,
    initialEquity: m.ledger.initialEquity,
    notionalPctPerSlot: m.ledger.notionalPctPerSlot ?? 0.25,
    leverage: m.ledger.leverage,
    hardStopPct: m.ledger.hardStopPct,
  };
}

export function resolveAsOf(m: ExperimentManifest, dbPath = m.data.dbPath): number {
  if (m.asOf.toLowerCase() === "latest") {
    const db = new Database(dbPath, { readonly: true });
    try {
      return latestCommonAsOf(manifestToSleeve(m), db);
    } finally {
      db.close();
    }
  }
  return Date.parse(m.asOf);
}

// ── fold generation ───────────────────────────────────────────────────
export function generateFolds(window: WindowConfig, asOfMs: number): OuterFold[] {
  const fromMs = Date.parse(window.from);
  const toMs = Math.min(Date.parse(window.to), asOfMs);
  if (toMs <= fromMs) throw new Error(`invalid window: ${window.from} -> ${window.to} resolved to ${toMs}`);
  if (!Number.isInteger(window.outerFoldCount) || window.outerFoldCount < 1) {
    throw new Error("outerFoldCount must be a positive integer");
  }
  const totalSpan = toMs - fromMs;
  const purgeMs = window.purgeYears * 365.25 * 24 * 60 * 60 * 1000;

  const outerFolds: OuterFold[] = [];
  for (let k = 0; k < window.outerFoldCount; k++) {
    // Reserve the first segment for training; every outer test is truly OOS.
    const segmentCount = window.outerFoldCount + 1;
    const outerStart = fromMs + Math.round((totalSpan * (k + 1)) / segmentCount);
    const outerEnd = fromMs + Math.round((totalSpan * (k + 2)) / segmentCount);
    const outerTrainEnd = outerStart - purgeMs;

    const inner: Fold[] = [];
    const innerSpan = Math.max(0, outerTrainEnd - fromMs);
    if (window.innerFoldCount > 0 && innerSpan > 0) {
      for (let j = 0; j < window.innerFoldCount; j++) {
        const innerStart = fromMs + Math.round((innerSpan * j) / window.innerFoldCount);
        const innerEnd = fromMs + Math.round((innerSpan * (j + 1)) / window.innerFoldCount);
        inner.push({ path: `${k}/${j}`, fromMs: innerStart, toMs: innerEnd });
      }
    }
    outerFolds.push({ path: `${k}`, test: { path: `${k}/test`, fromMs: outerStart, toMs: outerEnd }, inner });
  }
  return outerFolds;
}

// ── candidate → replay config ─────────────────────────────────────────
export function candidateToReplayConfig(
  m: ExperimentManifest,
  c: CandidateConfig,
  costTier: "base" | "stress",
  dbPathOverride?: string,
): ReplayConfig {
  const cost = costTier === "base" ? m.costs.base : m.costs.stress;
  const base: ReplayConfig = {
    sleeve: m.sleeve,
    universe: [...m.data.universe],
    timeframe: m.data.timeframe,
    source: m.data.source,
    refSymbol: m.data.refSymbol,
    rthOnly: m.data.rthOnly,
    funding: m.data.funding,
    barMinutes: m.data.barMinutes,
    barMinutesEq: m.data.barMinutesEq,
    slippageBps: cost.slippageBps,
    commissionBps: cost.commissionBps,
    marginInterest: cost.marginInterest,
    // Line-S short-borrow financing: absent keys are dropped by
    // canonicalJson, so every legacy candidate keeps its legacy hash.
    shortBorrow: cost.shortBorrow,
    initialEquity: m.ledger.initialEquity,
    leverage: m.ledger.leverage,
    hardStopPct: m.ledger.hardStopPct,
    hardStop: c.hardStop,
    profitLock: c.profitLock,
    cadenceMin: c.cadenceMin,
    notionalPctPerSlot: c.notionalPctPerSlot ?? m.ledger.notionalPctPerSlot ?? 0.25,
    // Momentum knobs zero out for meanrev candidates (validateCandidate
    // forbids setting them there); sizing for meanrev is meanrev.slotPct.
    entryPct: c.entryPct ?? 0,
    exitPct: c.exitPct ?? 0,
    maxLongs: c.maxLongs ?? 0,
    maxShorts: c.maxShorts ?? 0,
    // Line-S short axes: absent = engine defaults AND the legacy hash.
    shortEntryPct: c.shortEntryPct,
    shortExitPct: c.shortExitPct,
    shortRegime: c.shortRegime,
    shortUniverse: c.shortUniverse,
    shortStop: c.shortStop,
    // TSM horizon axis: absent = engine defaults (14/30) AND legacy hash
    // (undefined keys are dropped by canonicalJson).
    lookbackDays: c.lookbackDays,
    maLengthDays: c.maLengthDays,
    // Multi-horizon axis: absent = single-horizon AND legacy hash.
    lookbackDaysList: c.lookbackDaysList,
    // `|| undefined` normalizes 0 to ABSENT: off must keep the legacy hash.
    cooldownBarsAfterStop: c.cooldownBarsAfterStop || undefined,
    shortFunding: "credit",
    tsmTrail: c.tsmTrail,
    sharpeGate: c.sharpeGate,
    volTarget: c.volTarget,
    // Inverse-vol entry sizing: absent = legacy sizing AND legacy hash.
    volSizing: c.volSizing,
    timeStop: c.timeStop,
    allowSameTickReentry: c.allowSameTickReentry || undefined,
    marketTrend: c.marketTrend,
    risk: c.risk,
    // RW4a exposure control: absent = OFF AND the legacy hash.
    exposureControl: c.exposureControl,
    trendExit: c.trendExit,
    idleOverlay: c.idleOverlay,
    breakoutShort: c.breakoutShort,
    // 2026-09 axes (simulator stream): undefined values are dropped by
    // canonicalJson, so every legacy candidate keeps its legacy hash.
    // `regime: "off"` is manifest sugar for `{ enabled: false }`.
    slotHysteresis: c.slotHysteresis,
    regime: c.regime === "off" ? { enabled: false } : c.regime,
    maxGrossExposureMult: c.maxGrossExposureMult,
    // Meanrev axes ride INSIDE the meanrev sim params (that is where
    // runMeanRevReplay reads them); the object is only rebuilt when the
    // candidate actually sets one, so legacy meanrev hashes are untouched
    // and momentum candidates keep meanrev absent.
    // PIT membership axes (2026-10-02): manifest-level data config, hashed
    // into every candidate identity; absent keys keep legacy hashes.
    membership: m.data.membership,
    liquidityRank: m.data.liquidityRank,
    // Línea F axis (2026-10-10): same manifest-level convention — hashed
    // into every candidate identity; absent keeps every legacy hash.
    perpsMembership: m.data.perpsMembership,
    meanrev: c.meanrev && (c.rsiMethod !== undefined || c.deterministicTieBreak !== undefined)
      ? {
          ...c.meanrev,
          ...(c.rsiMethod !== undefined ? { rsiMethod: c.rsiMethod } : {}),
          ...(c.deterministicTieBreak !== undefined ? { deterministicTieBreak: c.deterministicTieBreak } : {}),
        }
      : c.meanrev,
    warmupDays: m.window.warmupDays,
    dbPath: dbPathOverride ?? m.data.dbPath,
    // §12-septies G0: runtime-only slice-DB path (excluded from
    // hashReplayConfig alongside dbPath; absent = legacy).
    sliceDbPath: m.data.sliceDb,
    // copySignal (research-only signals DB): runtime-only path like dbPath,
    // excluded from hashReplayConfig; the KEY is added only when set, so every
    // legacy resolved config is byte-identical.
    ...(m.data.signals ? { signalsDbPath: m.data.signals.dbPath } : {}),
  };
  // RW portfolio candidate (2026-10-20): the strategy config + venue rules
  // ride on the resolved config so hashReplayConfig covers them (candidate
  // identity) and the portfolio runner reads them. Absent = the exact legacy
  // object above AND every legacy hash (the key is never added).
  if (c.portfolio !== undefined) {
    const withPortfolio: PortfolioReplayConfig = { ...base, portfolio: c.portfolio };
    return withPortfolio;
  }
  return base;
}

export function validateUniqueCandidates(m: ExperimentManifest): void {
  const seen = new Map<string, string>();
  for (const candidate of m.candidates) {
    validateCandidate(candidate);
    const hash = hashReplayConfig(candidateToReplayConfig(m, candidate, "base"));
    const previous = seen.get(hash);
    if (previous) {
      throw new Error(`duplicate effective candidate detected: "${candidate.name}" matches "${previous}"`);
    }
    seen.set(hash, candidate.name);
  }
}

// ── metrics helpers ───────────────────────────────────────────────────
export function periodsPerYear(sleeve: string, source?: string): number {
  // 24/7 venues produce ~365 daily observations/yr regardless of which
  // ENGINE trades them: meanrev on binance_futures perps annualizes like
  // crypto, not like the equity calendar. Every pre-existing combination is
  // unchanged (crypto/binance→365 either way; stocks+meanrev on alpaca→252).
  return sleeve === "crypto" || source === "binance_futures" ? 365 : 252;
}

export function correctedDsr(
  result: ReplayResult,
  numCandidates: number,
  priorUniqueTrials: number,
  sleeveName: string,
): number {
  const rets = result.dailyReturns.map(r => r.ret);
  if (rets.length < 30) return 0;
  // `config?.`: benchmark pseudo-results and unit-test mocks carry no config.
  return deflatedSharpe(rets, Math.max(1, priorUniqueTrials + numCandidates), periodsPerYear(sleeveName, result.config?.source));
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── trial ledger ──────────────────────────────────────────────────────
export function makeTrialId(foldPath: string, candidateHash: string, costTier: string): string {
  return hashString(`${foldPath}:${candidateHash}:${costTier}`);
}

export function ledgerComplete(ledger: TrialRecord[] | undefined): boolean {
  if (!ledger || ledger.length === 0) return false;
  return ledger.every(t => t.status === "complete");
}

// ── execution ─────────────────────────────────────────────────────────
/**
 * Default trial runner: dispatch on the resolved config's sleeve. Momentum
 * sleeves replay through the MomentumEngine simulator; the meanrev sleeve
 * replays through the verbatim Connors daily simulator. Tests inject their
 * own ReplayRunner via opts.runner, bypassing this dispatch entirely.
 */
export const defaultReplayRunner: ReplayRunner = (cfg, win, initialRiskState) => {
  // RW portfolio candidates have their own daily simulator; running them
  // through the momentum/meanrev engines would silently ignore `portfolio`
  // (config that changes nothing, wearing a different candidate hash).
  if (isPortfolioReplayConfig(cfg)) {
    return Promise.reject(new Error("portfolio candidates run through scripts/portfolio-wf.ts (runPortfolioReplay), not `bun run experiment:wf`"));
  }
  return cfg.sleeve === "meanrev" ? runMeanRevReplay(cfg, win, initialRiskState) : runWithConfig(cfg, win, initialRiskState);
};

export async function runTrial(
  m: ExperimentManifest,
  c: CandidateConfig,
  fold: Fold,
  costTier: "base" | "stress",
  existing?: TrialRecord,
  dbPathOverride?: string,
  runner: ReplayRunner = defaultReplayRunner,
  contextHash = "",
  initialRiskState?: RiskState,
): Promise<TrialRecord> {
  const cfg = candidateToReplayConfig(m, c, costTier, dbPathOverride);
  // initialRiskState participates in the trial hash (not the candidate/data
  // hash) so an outer-chain state change invalidates only the cached trials
  // downstream of it, forcing a rerun instead of silently reusing a stale
  // result computed under a different RiskGuard starting point. Trial IDs
  // stay stable (fold × candidate × cost tier) — only `hash` moves.
  const stateHash = initialRiskState ? hashString(canonicalJson(initialRiskState)) : "";
  const trialHash = hashString(canonicalJson({ candidateHash: hashReplayConfig(cfg), foldPath: fold.path, costTier, contextHash, initialRiskState: stateHash }));
  if (existing && existing.status === "complete" && existing.hash === trialHash) {
    return existing.result && dbPathOverride
      ? { ...existing, result: { ...existing.result, config: { ...existing.result.config, dbPath: dbPathOverride } } }
      : existing;
  }
  const id = makeTrialId(fold.path, hashReplayConfig(cfg), costTier);
  const record: TrialRecord = {
    id,
    candidateHash: hashReplayConfig(cfg),
    candidateName: c.name,
    foldPath: fold.path,
    costTier,
    fromMs: fold.fromMs,
    toMs: fold.toMs,
    status: "running",
    hash: trialHash,
  };
  const win = {
    label: fold.path,
    from: new Date(fold.fromMs).toISOString(),
    to: new Date(fold.toMs).toISOString(),
  };
  const result = await runner(cfg, win, initialRiskState);
  if (result) {
    record.status = "complete";
    record.result = result;
  } else {
    record.status = "failed";
  }
  return record;
}

/**
 * True when a replay's ending capital cannot support a continued chain:
 * explicitly ruined, non-positive, or non-finite final equity. The
 * orchestrator (runWalkForward/runLoo) checks this BEFORE ever invoking the
 * runner for the next fold in a chain — a ruined chain must never execute a
 * later fold with reset capital (each fold's SimBroker always restarts cash
 * at the same fixed `initialEquity`, so "continuing" past a wipeout would
 * silently resurrect a dead strategy with fresh money).
 */
export function isChainRuined(result: ReplayResult): boolean {
  return result.ruined || !(result.finalEquity > 0) || !Number.isFinite(result.finalEquity);
}

/**
 * Continue a chronological RiskGuard chain across independent replays
 * (each replay's SimBroker restarts cash at the SAME fixed local initial
 * equity `I`, not the compounded prior-fold ending equity `F`). Monetary
 * anchors (peakEquity, dayStartEquity, equityBase) are rescaled by I/F so
 * drawdown % stays comparable to the next fold's fresh capital base;
 * pauses/timestamps/streaks/semantic metadata pass through untouched.
 *
 * Only ever called by the orchestrator when `!isChainRuined(result)` — the
 * F<=0/non-finite guard below is defense-in-depth for direct callers, not
 * the primary mechanism (that's the orchestrator's chain-cut check, which
 * refuses to even invoke the runner for the next fold on ruin).
 */
export function continueRiskState(result: ReplayResult): RiskState {
  const I = result.config.initialEquity;
  const F = result.finalEquity;
  const state = result.finalRiskState;
  if (!(F > 0) || !Number.isFinite(F)) return { ...state };
  const scale = I / F;
  return {
    ...state,
    peakEquity: state.peakEquity * scale,
    ...(state.highWaterMark !== undefined ? { highWaterMark: state.highWaterMark * scale } : {}),
    dayStartEquity: state.dayStartEquity * scale,
    ...(state.equityBase !== undefined ? { equityBase: state.equityBase * scale } : {}),
    // Shadow-equity resume anchors (risk.shadowResume axis) are monetary —
    // they rescale with the capital base exactly like peakEquity, so a
    // pause episode alive at a fold boundary keeps its drawdown geometry.
    ...(state.shadowResume !== undefined
      ? {
          shadowResume: {
            equity: state.shadowResume.equity * scale,
            startEquity: state.shadowResume.startEquity * scale,
            peakRef: state.shadowResume.peakRef * scale,
          },
        }
      : {}),
  };
}

// ── selection ─────────────────────────────────────────────────────────
export interface CandidateAggregate {
  candidateHash: string;
  candidateName: string;
  medianDsr: number;
  medianSharpe: number;
  medianMaxDrawdown: number;
}

export function aggregateInner(innerResults: InnerMetrics[], candidateName?: string): CandidateAggregate[] {
  const byHash = new Map<string, { name: string; dsrs: number[]; sharpes: number[]; dds: number[] }>();
  for (const r of innerResults) {
    if (candidateName && r.candidateName !== candidateName) continue;
    const cur = byHash.get(r.candidateHash) ?? { name: r.candidateName, dsrs: [], sharpes: [], dds: [] };
    cur.dsrs.push(r.dsr);
    cur.sharpes.push(r.sharpe);
    cur.dds.push(r.maxDrawdown);
    byHash.set(r.candidateHash, cur);
  }
  const arr: CandidateAggregate[] = [];
  for (const [candidateHash, v] of byHash) {
    arr.push({
      candidateHash,
      candidateName: v.name,
      medianDsr: median(v.dsrs),
      medianSharpe: median(v.sharpes),
      medianMaxDrawdown: median(v.dds),
    });
  }
  return arr;
}

export function selectCandidate(aggregates: CandidateAggregate[]): CandidateAggregate {
  if (aggregates.length === 0) throw new Error("no candidates to select");
  const sorted = [...aggregates].sort((a, b) => {
    if (b.medianDsr !== a.medianDsr) return b.medianDsr - a.medianDsr;
    if (b.medianSharpe !== a.medianSharpe) return b.medianSharpe - a.medianSharpe;
    if (a.medianMaxDrawdown !== b.medianMaxDrawdown) return a.medianMaxDrawdown - b.medianMaxDrawdown;
    return a.candidateHash.localeCompare(b.candidateHash);
  });
  return sorted[0];
}

// ── stitched OOS + concentration ──────────────────────────────────────
export function stitchEquityHistory(results: ReplayResult[], initialEquity: number): Array<{ t: number; eq: number }> {
  const sorted = [...results].sort((a, b) => a.fromMs - b.fromMs);
  const stitched: Array<{ t: number; eq: number }> = [{ t: sorted[0]?.fromMs ?? 0, eq: initialEquity }];
  for (const r of sorted) {
    const startEq = stitched[stitched.length - 1].eq;
    const startT = stitched[stitched.length - 1].t;
    if (r.equityHistory.length === 0) continue;
    const first = r.equityHistory[0];
    const scale = startEq / (first.eq || initialEquity);
    for (const pt of r.equityHistory) {
      stitched.push({ t: pt.t, eq: pt.eq * scale });
    }
  }
  return stitched;
}

function bucketByDay(history: Array<{ t: number; eq: number }>, rthOnly: boolean): Array<{ key: string; first: number; last: number }> {
  const out: Array<{ key: string; first: number; last: number }> = [];
  for (const pt of history) {
    const key = rthOnly ? getETDateKey(pt.t) : new Date(pt.t).toISOString().slice(0, 10);
    const cur = out[out.length - 1];
    if (cur && cur.key === key) {
      cur.last = pt.eq;
    } else {
      out.push({ key, first: pt.eq, last: pt.eq });
    }
  }
  return out;
}

/**
 * Daily close-to-close returns of a stitched equity curve (ET-session days
 * for RTH data, UTC calendar days otherwise). Shared by stitchedMetrics and
 * the outer evidence layer (PSR/MinTRL) so both judge the SAME series.
 */
export function stitchedDailyReturns(history: Array<{ t: number; eq: number }>, rthOnly: boolean): number[] {
  const dailyBuckets = bucketByDay(history, rthOnly);
  const dailyRets: number[] = [];
  for (let i = 1; i < dailyBuckets.length; i++) {
    const a = dailyBuckets[i - 1].last, b = dailyBuckets[i].last;
    if (a > 0) dailyRets.push((b - a) / a);
  }
  return dailyRets;
}

export function stitchedMetrics(history: Array<{ t: number; eq: number }>, results: ReplayResult[], periodsPerYear: number) {
  const rthOnly = results[0]?.config?.rthOnly ?? false;
  const dailyRets = stitchedDailyReturns(history, rthOnly);

  const tickRets: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1].eq, b = history[i].eq;
    if (a > 0) tickRets.push((b - a) / a);
  }

  // Use daily/session returns when practical (>= 30 days), else fall back to tick/session returns.
  const rets = dailyRets.length >= 30 ? dailyRets : tickRets;
  const mean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;
  let peak = history[0]?.eq ?? 1, maxDd = 0;
  for (const e of history) {
    if (e.eq > peak) peak = e.eq;
    maxDd = Math.max(maxDd, (peak - e.eq) / peak);
  }
  const totalReturn = history.length > 1 ? (history[history.length - 1].eq - history[0].eq) / history[0].eq : 0;
  const allTrades = results.flatMap(r => r.closedTrades);
  const wins = allTrades.filter(t => t.pnl > 0).length;
  // Never infer executions as 2*trades: partial resizes and seeded holdings
  // differ. Cached results without counters leave the metric unavailable.
  const orders = results.length && results.every(r => r.orders !== undefined)
    ? results.reduce((s, r) => s + r.orders!, 0) : undefined;
  const days = results.reduce((s, r) => s + (r.toMs - r.fromMs) / 86_400_000, 0);
  return {
    totalReturn,
    sharpe,
    maxDrawdown: maxDd,
    winRate: allTrades.length ? wins / allTrades.length : 0,
    trades: allTrades.length,
    ...(orders !== undefined && days > 0 ? { orders, ordersPerDay: orders / days } : {}),
    expectancy: allTrades.length ? allTrades.reduce((s, t) => s + t.pnl, 0) / allTrades.length : 0,
    fees: results.reduce((s, r) => s + r.fees, 0),
    funding: results.reduce((s, r) => s + r.funding, 0),
    // `?? 0`: cached trial results and benchmark pseudo-results predate the field.
    marginInterest: results.reduce((s, r) => s + (r.marginInterest ?? 0), 0),
    liquidations: results.reduce((s, r) => s + r.liquidations, 0),
    marginRejects: results.reduce((s, r) => s + r.marginRejects, 0),
    ruined: results.some(r => r.ruined),
  };
}

// ── outer evidence layer: PSR / MinTRL / power (2026-09 audit) ────────
/**
 * PSR of a daily-return series vs benchmark Sharpe 0, with the
 * autocorrelation penalty applied to σ: SR_adj = mean/(σ·penalty). Multi-day
 * holds serially correlate daily returns, so the naive per-observation SR is
 * biased high — this is the same correction smartSharpe applies, fed into
 * trackRecord's PSR (γ₄ NON-excess convention: metrics.kurtosis() + 3).
 * Returns null when no PSR is computable (n < 2, zero variance, pathological
 * moments) — callers fail closed, never default to a pass.
 */
export function penalizedPsr(rets: number[]): number | null {
  const n = rets.length;
  if (n < 2) return null;
  const sd = seriesStdev(rets);
  if (sd < 1e-12) return null;
  const srAdj = seriesMean(rets) / sd / autocorrPenalty(rets);
  return psrFromMoments(srAdj, 0, n, skewness(rets), kurtosis(rets) + 3);
}

export interface OuterEvidence {
  outerPsr?: number;
  minTrl: number | null;
  observations: number;
  foldPsr: Array<{ foldPath: string; psr: number }>;
  certifiableSharpeAtPsr95?: number;
}

/**
 * Statistical evidence of the stitched outer-OOS series. Until 2026-09 the
 * outer verdict never read PSR/DSR (they only steered the INNER selection);
 * this is the layer the new acceptance gates consume. Everything uses the
 * autocorr-penalized SR — see penalizedPsr.
 */
export function computeOuterEvidence(
  outerTestResults: ReplayResult[],
  stitchedHistory: Array<{ t: number; eq: number }>,
  ppy: number,
): OuterEvidence {
  const rthOnly = outerTestResults[0]?.config?.rthOnly ?? false;
  const dailyRets = stitchedDailyReturns(stitchedHistory, rthOnly);
  const n = dailyRets.length;
  const foldPsr = outerTestResults.map(r => ({
    foldPath: r.window.label,
    psr: penalizedPsr(r.dailyReturns.map(x => x.ret)) ?? NaN,
  }));
  // Power declaration, independent of the observed SR: the smallest
  // ANNUALIZED Sharpe n days can certify at PSR 95% under Gaussian moments
  // (n ≥ (z/(SR/√ppy))² ⇒ SR = z·√ppy/√n, z = 1.645). With ~560 OOS days
  // this is ≈ 1.1 — any target edge below it is undecidable at this window.
  const certifiableSharpeAtPsr95 = n > 0 ? (1.645 * Math.sqrt(ppy)) / Math.sqrt(n) : undefined;
  if (n < 2) return { minTrl: null, observations: n, foldPsr, certifiableSharpeAtPsr95 };
  const sd = seriesStdev(dailyRets);
  if (sd < 1e-12) return { minTrl: null, observations: n, foldPsr, certifiableSharpeAtPsr95 };
  const srAdj = seriesMean(dailyRets) / sd / autocorrPenalty(dailyRets);
  const sk = skewness(dailyRets);
  const k4 = kurtosis(dailyRets) + 3; // non-excess, trackRecord convention
  return {
    outerPsr: psrFromMoments(srAdj, 0, n, sk, k4) ?? undefined,
    // Same penalized SR as the PSR: an autocorrelation-inflated SR would
    // otherwise understate how many observations the claim needs.
    minTrl: minTrlObservations(srAdj, 0, sk, k4, 1.645),
    observations: n,
    foldPsr,
    certifiableSharpeAtPsr95,
  };
}

// ── break-even cost curve ─────────────────────────────────────────────
/** Slippage tiers (bps) for the break-even curve, base commission held
 *  fixed. Generalizes the single ×2 "stress" point, which is known-chaotic
 *  in this sim (raising slippage 5→10 bps has RAISED return). */
export const BREAK_EVEN_SLIPPAGE_BPS = [0, 2, 5, 10, 20, 30];

/**
 * First slippage level at which the curve's Sharpe crosses ≤ 0, by linear
 * interpolation between adjacent measured tiers.
 *
 * Non-monotone curves take the FIRST crossing deliberately: micro-execution
 * chaos can make Sharpe pop back above 0 at a higher tier, and the
 * conservative reading is "the strategy may already die here", never "it
 * resurrects later". Returns 0 when Sharpe ≤ 0 at the lowest tier, Infinity
 * when it never crosses in the tested range, undefined for an empty curve.
 */
export function breakEvenFromCurve(curve: Array<{ slippageBps: number; sharpe: number }>): number | undefined {
  if (!curve || curve.length === 0) return undefined;
  const pts = [...curve].sort((a, b) => a.slippageBps - b.slippageBps);
  if (pts[0].sharpe <= 0) return 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b.sharpe <= 0) {
      // a.sharpe > 0 ≥ b.sharpe here, so the divisor is strictly positive.
      const t = a.sharpe / (a.sharpe - b.sharpe);
      return a.slippageBps + t * (b.slippageBps - a.slippageBps);
    }
  }
  return Infinity;
}

/**
 * Buy-and-hold of the manifest refSymbol over the SAME outer-OOS fold
 * windows the strategy was judged on: per-fold close-to-close return, plus
 * a stitched curve (folds compounded in chronological order, exactly like
 * stitchEquityHistory does for the strategy) yielding benchReturn and
 * benchSharpe with the same daily-bucket Sharpe math as stitchedMetrics.
 * Fail-closed: a fold with fewer than 2 benchmark bars is a data hole, not
 * a zero.
 */
export function benchmarkFromFoldBars(
  foldBars: Array<{ foldPath: string; fromMs: number; bars: Array<{ timestamp: number; close: number }> }>,
  ppy: number,
  rthOnly: boolean,
): { benchReturn: number; benchSharpe: number; byFold: Array<{ foldPath: string; benchReturn: number }> } {
  const byFold: Array<{ foldPath: string; benchReturn: number }> = [];
  const pseudo: ReplayResult[] = [];
  for (const f of foldBars) {
    if (f.bars.length < 2) throw new Error(`benchmark: fewer than 2 refSymbol bars in fold ${f.foldPath}`);
    const first = f.bars[0].close;
    const last = f.bars[f.bars.length - 1].close;
    if (!(first > 0)) throw new Error(`benchmark: non-positive first close in fold ${f.foldPath}`);
    byFold.push({ foldPath: f.foldPath, benchReturn: (last - first) / first });
    pseudo.push({
      fromMs: f.fromMs,
      equityHistory: f.bars.map(b => ({ t: b.timestamp, eq: b.close })),
      closedTrades: [],
      fees: 0,
      funding: 0,
      liquidations: 0,
      marginRejects: 0,
      ruined: false,
      config: { rthOnly } as ReplayResult["config"],
    } as unknown as ReplayResult);
  }
  const stitched = stitchEquityHistory(pseudo, 1);
  const metrics = stitchedMetrics(stitched, pseudo, ppy);
  return { benchReturn: metrics.totalReturn, benchSharpe: metrics.sharpe, byFold };
}

export function concentration(results: ReplayResult[]) {
  const maxTradesFracByFold: Array<{ foldPath: string; symbol: string; frac: number }> = [];
  const maxPnlFracByFold: Array<{ foldPath: string; symbol: string; frac: number }> = [];
  const totalTradesBySymbol: Record<string, number> = {};
  const totalGrossPnlBySymbol: Record<string, number> = {};
  for (const r of results) {
    const trades = Object.entries(r.tradesBySymbol);
    const totalTrades = trades.reduce((s, [, v]) => s + v.trades, 0);
    const totalGross = trades.reduce((s, [, v]) => s + Math.abs(v.grossPnl), 0);
    let bestTrades: { symbol: string; frac: number } | null = null;
    let bestPnl: { symbol: string; frac: number } | null = null;
    for (const [sym, v] of trades) {
      totalTradesBySymbol[sym] = (totalTradesBySymbol[sym] ?? 0) + v.trades;
      totalGrossPnlBySymbol[sym] = (totalGrossPnlBySymbol[sym] ?? 0) + v.grossPnl;
      if (totalTrades > 0) {
        const frac = v.trades / totalTrades;
        if (!bestTrades || frac > bestTrades.frac) bestTrades = { symbol: sym, frac };
      }
      if (totalGross > 0) {
        const frac = Math.abs(v.grossPnl) / totalGross;
        if (!bestPnl || frac > bestPnl.frac) bestPnl = { symbol: sym, frac };
      }
    }
    if (bestTrades) maxTradesFracByFold.push({ foldPath: r.window.label, ...bestTrades });
    if (bestPnl) maxPnlFracByFold.push({ foldPath: r.window.label, ...bestPnl });
  }
  return { maxTradesFracByFold, maxPnlFracByFold, totalTradesBySymbol, totalGrossPnlBySymbol };
}

// ── LOO ───────────────────────────────────────────────────────────────
export interface LooOutcome {
  results: LooResult[];
  /** `${foldPath}:loo-${symbol}` markers for folds never executed because
   *  that symbol's chain was cut by an earlier ruined fold. Non-empty means
   *  the LOO evidence is incomplete — feeds into skippedFolds so approval
   *  cannot pass. */
  cutChains: string[];
}

export async function runLoo(
  m: ExperimentManifest,
  selectedByOuter: Map<string, CandidateConfig>,
  outerFolds: OuterFold[],
  snapshotPath?: string,
  runner: ReplayRunner = defaultReplayRunner,
  /** Symbols to leave out, one chain each. Default (every pre-existing call
   *  site) = the full declared universe — byte-identical legacy. A driver
   *  may restrict it (runWalkForward opts.looTopPnlSymbols: línea F's
   *  360-symbol PIT universe × hourly real-engine replays makes full LOO
   *  computationally impossible; only symbols with material |P&L| can move
   *  the stitched Sharpe, so LOO over the top-|P&L| set bounds the same
   *  single-symbol dependence). */
  symbols: string[] = m.data.universe,
): Promise<LooOutcome> {
  const out: LooResult[] = [];
  const cutChains: string[] = [];
  for (const sym of symbols) {
    const remainingUniverse = m.data.universe.filter(s => s !== sym);
    if (remainingUniverse.length === 0) continue;
    const results: ReplayResult[] = [];
    // Independent chronological chain per excluded symbol — reset here on
    // every new `sym`, never shared with base/stress or other symbols.
    let chainState: RiskState | undefined;
    let chainBroken = false;
    for (const outer of outerFolds) {
      const selected = selectedByOuter.get(outer.path);
      if (!selected) continue;
      if (chainBroken) {
        // Chain cut: never execute a later fold with reset capital.
        cutChains.push(`${outer.test.path}:loo-${sym}`);
        continue;
      }
      const cfg = candidateToReplayConfig(m, selected, "base", snapshotPath);
      cfg.universe = remainingUniverse;
      if (cfg.breakoutShort?.symbol === sym) cfg.breakoutShort = undefined;
      if (cfg.idleOverlay) {
        const symbols = cfg.idleOverlay.symbols.filter(s => s !== sym);
        cfg.idleOverlay = symbols.length ? { ...cfg.idleOverlay, symbols } : undefined;
      }
      // If the excluded symbol was the timeline driver, fall back to the first
      // remaining symbol so the replay still has a reference series.
      cfg.refSymbol = cfg.refSymbol === sym ? cfg.universe[0] : cfg.refSymbol;
      const win = { label: `${outer.test.path}/loo-${sym}`, from: new Date(outer.test.fromMs).toISOString(), to: new Date(outer.test.toMs).toISOString() };
      const r = await runner(cfg, win, chainState);
      if (!r) throw new Error(`incomplete LOO replay for ${sym} at ${outer.test.path}`);
      results.push(r);
      if (isChainRuined(r)) {
        chainBroken = true;
        // Same reasoning as base/stress: the ruin itself blocks approval
        // even when it's the last fold for this excluded symbol and there's
        // no later fold to cut.
        cutChains.push(`${outer.test.path}:loo-${sym}:ruined`);
      } else {
        chainState = continueRiskState(r);
      }
    }
    if (results.length === 0) continue;
    const stitched = stitchEquityHistory(results, m.ledger.initialEquity);
    const metrics = stitchedMetrics(stitched, results, periodsPerYear(m.sleeve, m.data.source));
    out.push({
      excludedSymbol: sym,
      stitchedReturn: metrics.totalReturn,
      stitchedSharpe: metrics.sharpe,
      stitchedMaxDrawdown: metrics.maxDrawdown,
      totalTrades: metrics.trades,
    });
  }
  return { results: out, cutChains };
}

// ── acceptance gates ──────────────────────────────────────────────────
export function evaluateAcceptance(summary: WalkForwardSummary, acceptance: AcceptanceConfig) {
  const gates: WalkForwardSummary["acceptance"] = {};
  const s = summary.stitchedOos;
  const c = summary.concentration;
  const maxConc = Math.max(
    0,
    ...c.maxTradesFracByFold.map(x => x.frac),
    ...c.maxPnlFracByFold.map(x => x.frac),
  );

  gates.minSharpe = { gate: "minSharpe", value: s.sharpe, threshold: acceptance.minSharpe ?? -Infinity, pass: s.sharpe >= (acceptance.minSharpe ?? -Infinity) };
  gates.maxDrawdown = { gate: "maxDrawdown", value: s.maxDrawdown, threshold: acceptance.maxDrawdown ?? Infinity, pass: s.maxDrawdown <= (acceptance.maxDrawdown ?? Infinity) };
  gates.minTotalReturn = { gate: "minTotalReturn", value: s.totalReturn, threshold: acceptance.minTotalReturn ?? -Infinity, pass: s.totalReturn >= (acceptance.minTotalReturn ?? -Infinity) };
  gates.maxConcentration = { gate: "maxConcentration", value: maxConc, threshold: acceptance.maxConcentration ?? Infinity, pass: maxConc <= (acceptance.maxConcentration ?? Infinity) };
  gates.minTrades = { gate: "minTrades", value: s.trades, threshold: acceptance.minTrades ?? 0, pass: s.trades >= (acceptance.minTrades ?? 0) };

  // Benchmark-relative gates — OPTIONAL, evaluated only when the manifest
  // sets a threshold. Rationale (see AcceptanceConfig): full-exposure
  // strategies (momentum) are held to excess RETURN vs the refSymbol's
  // buy-and-hold over the same stitched OOS window; low-exposure strategies
  // (meanrev, mostly cash) are held to excess SHARPE, because excess return
  // would unfairly compare ~50%-max-notional dip-buying against 100%
  // benchmark exposure. A missing benchmark (undefined/NaN) fails closed:
  // NaN comparisons are false, so the gate records pass=false instead of
  // silently approving.
  if (acceptance.minExcessReturnVsBench !== undefined) {
    const excessReturn = s.totalReturn - (s.benchReturn ?? NaN);
    gates.minExcessReturnVsBench = {
      gate: "minExcessReturnVsBench",
      value: excessReturn,
      threshold: acceptance.minExcessReturnVsBench,
      pass: excessReturn >= acceptance.minExcessReturnVsBench,
    };
  }
  if (acceptance.minExcessSharpeVsBench !== undefined) {
    const excessSharpe = s.sharpe - (s.benchSharpe ?? NaN);
    gates.minExcessSharpeVsBench = {
      gate: "minExcessSharpeVsBench",
      value: excessSharpe,
      threshold: acceptance.minExcessSharpeVsBench,
      pass: excessSharpe >= acceptance.minExcessSharpeVsBench,
    };
  }

  // Stress gates: mandatory. Missing results or thresholds fail rather than omit.
  const stressResults = summary.stressTests.map(t => t.result);
  if (stressResults.length > 0 && acceptance.stressMinSharpe !== undefined && acceptance.stressMaxDrawdown !== undefined && acceptance.stressMinTotalReturn !== undefined) {
    const sleeve = stressResults[0].config.sleeve;
    const stressHistory = stitchEquityHistory(stressResults, stressResults[0].config.initialEquity);
    const sm = stitchedMetrics(stressHistory, stressResults, periodsPerYear(sleeve, stressResults[0].config.source));
    gates.stressMinSharpe = { gate: "stressMinSharpe", value: sm.sharpe, threshold: acceptance.stressMinSharpe, pass: sm.sharpe >= acceptance.stressMinSharpe };
    gates.stressMaxDrawdown = { gate: "stressMaxDrawdown", value: sm.maxDrawdown, threshold: acceptance.stressMaxDrawdown, pass: sm.maxDrawdown <= acceptance.stressMaxDrawdown };
    gates.stressMinTotalReturn = { gate: "stressMinTotalReturn", value: sm.totalReturn, threshold: acceptance.stressMinTotalReturn, pass: sm.totalReturn >= acceptance.stressMinTotalReturn };
  } else {
    const reason = stressResults.length === 0 ? "missing stress results" : "missing stress threshold(s)";
    gates.stressMinSharpe = { gate: "stressMinSharpe", value: NaN, threshold: acceptance.stressMinSharpe ?? NaN, pass: false };
    gates.stressMaxDrawdown = { gate: "stressMaxDrawdown", value: NaN, threshold: acceptance.stressMaxDrawdown ?? NaN, pass: false };
    gates.stressMinTotalReturn = { gate: "stressMinTotalReturn", value: NaN, threshold: acceptance.stressMinTotalReturn ?? NaN, pass: false };
    // Keep a non-gate breadcrumb for the approval reason.
    (summary as any)._stressSkipReason = reason;
  }

  // LOO gates: mandatory. Missing results or thresholds fail rather than omit.
  if (summary.loo.length > 0 && acceptance.looMinSharpe !== undefined && acceptance.looMaxDrawdown !== undefined && acceptance.looMinTotalReturn !== undefined) {
    const looSharpe = Math.min(...summary.loo.map(l => l.stitchedSharpe));
    const looDd = Math.max(...summary.loo.map(l => l.stitchedMaxDrawdown));
    const looRet = Math.min(...summary.loo.map(l => l.stitchedReturn));
    gates.looMinSharpe = { gate: "looMinSharpe", value: looSharpe, threshold: acceptance.looMinSharpe, pass: looSharpe >= acceptance.looMinSharpe };
    gates.looMaxDrawdown = { gate: "looMaxDrawdown", value: looDd, threshold: acceptance.looMaxDrawdown, pass: looDd <= acceptance.looMaxDrawdown };
    gates.looMinTotalReturn = { gate: "looMinTotalReturn", value: looRet, threshold: acceptance.looMinTotalReturn, pass: looRet >= acceptance.looMinTotalReturn };
  } else {
    const reason = summary.loo.length === 0 ? "missing LOO results" : "missing LOO threshold(s)";
    gates.looMinSharpe = { gate: "looMinSharpe", value: NaN, threshold: acceptance.looMinSharpe ?? NaN, pass: false };
    gates.looMaxDrawdown = { gate: "looMaxDrawdown", value: NaN, threshold: acceptance.looMaxDrawdown ?? NaN, pass: false };
    gates.looMinTotalReturn = { gate: "looMinTotalReturn", value: NaN, threshold: acceptance.looMinTotalReturn ?? NaN, pass: false };
    (summary as any)._looSkipReason = reason;
  }

  // ── Evidence gates (2026-09) ── ALL optional: an absent key is not
  // evaluated, so pre-registered manifests keep their exact legacy verdict.
  // Every "value missing" case fails CLOSED with an explicit reason.
  if (acceptance.minOuterPsr !== undefined) {
    const v = summary.outerPsr;
    gates.minOuterPsr = {
      gate: "minOuterPsr", value: v ?? NaN, threshold: acceptance.minOuterPsr,
      pass: v !== undefined && v >= acceptance.minOuterPsr,
      ...(v === undefined ? { reason: "outer PSR not computed (no stitched OOS evidence)" } : {}),
    };
  }
  if (acceptance.minTrlSatisfied) {
    const obs = summary.observations;
    const minTrl = summary.minTrl;
    // minTrl === null ⇒ SR ≤ benchmark: MinTRL is infinite, no sample length
    // certifies an edge that is not being observed. undefined ⇒ the evidence
    // layer never ran. Both fail closed.
    const pass = obs !== undefined && minTrl != null && obs >= minTrl;
    gates.minTrlSatisfied = {
      gate: "minTrlSatisfied", value: obs ?? NaN, threshold: minTrl ?? Infinity, pass,
      ...(obs === undefined ? { reason: "evidence layer not computed" } : {}),
    };
  }
  if (acceptance.minFoldsPsrAbove !== undefined) {
    const { threshold, count } = acceptance.minFoldsPsrAbove;
    const folds = summary.foldPsr ?? [];
    const above = folds.filter(f => Number.isFinite(f.psr) && f.psr >= threshold).length;
    gates.minFoldsPsrAbove = {
      gate: "minFoldsPsrAbove", value: above, threshold: count,
      pass: folds.length > 0 && above >= count,
      ...(folds.length === 0 ? { reason: "no per-fold PSR computed" } : {}),
    };
  }
  if (acceptance.maxTurnoverAnnual !== undefined) {
    // Runtime-optional reads: cached artifacts from an older simulator may
    // lack the field even though the current ReplayResult type requires it.
    const rs = summary.outerTests.map(t => t.result as ReplayResult & { turnoverAnnual?: number });
    const missing = rs.length === 0 || rs.some(r => !Number.isFinite(r.turnoverAnnual));
    if (missing) {
      gates.maxTurnoverAnnual = { gate: "maxTurnoverAnnual", value: NaN, threshold: acceptance.maxTurnoverAnnual, pass: false, reason: "metric not produced by replay" };
    } else {
      // Duration-weighted mean of per-fold annualized turnover ≈ annualized
      // turnover of the stitched OOS series.
      let w = 0, acc = 0;
      for (const r of rs) {
        const d = Math.max(0, r.toMs - r.fromMs);
        w += d;
        acc += (r.turnoverAnnual as number) * d;
      }
      const v = w > 0 ? acc / w : NaN;
      gates.maxTurnoverAnnual = { gate: "maxTurnoverAnnual", value: v, threshold: acceptance.maxTurnoverAnnual, pass: v <= acceptance.maxTurnoverAnnual };
    }
  }
  if (acceptance.maxDisplacementShare !== undefined) {
    const rs = summary.outerTests.map(t => t.result as ReplayResult & { displacementCloses?: number });
    const missing = rs.length === 0 || rs.some(r => !Number.isFinite(r.displacementCloses));
    if (missing) {
      gates.maxDisplacementShare = { gate: "maxDisplacementShare", value: NaN, threshold: acceptance.maxDisplacementShare, pass: false, reason: "metric not produced by replay" };
    } else {
      const disp = rs.reduce((sum, r) => sum + (r.displacementCloses as number), 0);
      const v = s.trades > 0 ? disp / s.trades : 0;
      gates.maxDisplacementShare = { gate: "maxDisplacementShare", value: v, threshold: acceptance.maxDisplacementShare, pass: v <= acceptance.maxDisplacementShare };
    }
  }
  if (acceptance.minBreakEvenSlippageBps !== undefined) {
    const v = summary.breakEvenSlippageBps;
    gates.minBreakEvenSlippageBps = {
      gate: "minBreakEvenSlippageBps", value: v ?? NaN, threshold: acceptance.minBreakEvenSlippageBps,
      pass: v !== undefined && v >= acceptance.minBreakEvenSlippageBps,
      ...(v === undefined ? { reason: "break-even curve not computed (--no-breakeven, dry-run, or no executed folds)" } : {}),
    };
  }

  // ── Sequence-risk gates (2026-09-26, Jesse pattern) ── optional like the
  // other evidence gates; fail CLOSED when the Monte Carlo layer is absent
  // (no outer OOS evidence, series/trade count too short, or a pre-existing
  // summary from before the field existed).
  if (acceptance.maxSequenceDdP95 !== undefined) {
    const v = summary.sequenceRisk?.bootstrap?.maxDrawdown.p95;
    gates.maxSequenceDdP95 = {
      gate: "maxSequenceDdP95", value: v ?? NaN, threshold: acceptance.maxSequenceDdP95,
      pass: v !== undefined && v <= acceptance.maxSequenceDdP95,
      ...(v === undefined ? { reason: "sequence-risk bootstrap not computed (no/short stitched OOS series)" } : {}),
    };
  }
  if (acceptance.maxObservedDdPercentile !== undefined) {
    const v = summary.sequenceRisk?.observedMaxDdPercentile;
    gates.maxObservedDdPercentile = {
      gate: "maxObservedDdPercentile", value: v ?? NaN, threshold: acceptance.maxObservedDdPercentile,
      pass: v !== undefined && v <= acceptance.maxObservedDdPercentile,
      ...(v === undefined ? { reason: "sequence-risk Monte Carlo not computed (no/short stitched OOS evidence)" } : {}),
    };
  }

  summary.acceptance = gates;
  const allPass = Object.values(gates).every(g => g.pass);
  const hasSkippedFolds = summary.skippedFolds.length > 0;
  const complete = summary.complete;
  if (hasSkippedFolds) {
    summary.approved = false;
    summary.approvalReason = `validation-only/skipped outer folds exist: ${summary.skippedFolds.join(", ")}`;
  } else if (!complete) {
    summary.approved = false;
    summary.approvalReason = "current trial ledger incomplete";
  } else if (!summary.priorTrialsComplete) {
    summary.approved = false;
    summary.approvalReason = "historical trial accounting incomplete";
  } else if (!allPass) {
    summary.approved = false;
    const failed = Object.values(gates).filter(g => !g.pass).map(g => g.gate);
    const extra: string[] = [];
    if ((summary as any)._stressSkipReason) extra.push((summary as any)._stressSkipReason);
    if ((summary as any)._looSkipReason) extra.push((summary as any)._looSkipReason);
    summary.approvalReason = `gate(s) failed: ${[...failed, ...extra].join(", ")}`;
  } else {
    summary.approved = false; // never auto-deploy; human approval required
    summary.approvalReason = "all gates pass; awaiting explicit human approval (not auto-deployed)";
  }
}

// ── output ────────────────────────────────────────────────────────────
export function writeOutputs(
  outputDir: string,
  manifest: ExperimentManifest,
  runs: TrialRecord[],
  summary: WalkForwardSummary,
) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "manifest-resolved.json"), JSON.stringify(manifest, null, 2));
  const lines = runs.map(r => JSON.stringify(r)).join("\n");
  writeFileSync(join(outputDir, "runs.jsonl"), lines ? lines + "\n" : "");
  const compactResult = (result: ReplayResult) => {
    const { dailyReturns, sessionReturns, equityHistory, closedTrades, blockedTicks, ...metrics } = result;
    return metrics;
  };
  const compactSummary = {
    ...summary,
    outerTests: summary.outerTests.map(t => ({ ...t, result: compactResult(t.result) })),
    stressTests: summary.stressTests.map(t => ({ ...t, result: compactResult(t.result) })),
  };
  writeFileSync(join(outputDir, "summary.json"), JSON.stringify(compactSummary, null, 2));
}

// ── main driver ───────────────────────────────────────────────────────
/**
 * Computes the deterministic identity of an experiment manifest.
 * - Excludes mutable state: trialLedger and human approval metadata
 * - Resolves asOf to exact epoch (handles "latest" asOf)
 * - Includes resolved fold boundaries so asOf=latest changes identity
 *   deterministically with data, while snapshot/data hash remains separate
 */
export function manifestIdentity(m: ExperimentManifest, preResolvedAsOfMs?: number): unknown {
  const { trialLedger, approved, ...rest } = m;
  // dbPath AND sliceDb are machine-local paths (runtime-only): both excluded.
  // sliceDb was never set by any legacy manifest, so every pre-existing
  // configHash is byte-identical.
  // data.signals (copySignal) keeps its presence in the identity but not its
  // machine-local dbPath (its ROWS enter the data hash); absent for every legacy manifest.
  const { dbPath: _dbPath, sliceDb: _sliceDb, signals: _signals, ...semanticDataBase } = rest.data;
  const semanticData = _signals !== undefined ? { ...semanticDataBase, signals: {} } : semanticDataBase;

  // Resolve asOf to exact epoch
  const asOfMs = preResolvedAsOfMs ?? resolveAsOf(m);
  const asOfResolved = new Date(asOfMs).toISOString();

  // Generate folds to capture resolved boundaries (asOf=latest changes these)
  const folds = generateFolds(rest.window, asOfMs);
  const foldBoundaries = folds.map(f => ({
    path: f.path,
    testFromMs: f.test.fromMs,
    testToMs: f.test.toMs,
    innerBoundaries: f.inner.map(i => ({ path: i.path, fromMs: i.fromMs, toMs: i.toMs })),
  }));

  return {
    ...rest,
    data: semanticData,
    asOfResolved,
    foldBoundaries,
  };
}

export type ReplayRunner = (cfg: ReplayConfig, win: { label: string; from: string; to: string }, initialRiskState?: RiskState) => Promise<ReplayResult | null>;

export async function runWalkForward(
  m: ExperimentManifest,
  opts: { dryRun?: boolean; runner?: ReplayRunner; breakEven?: boolean; codeFiles?: string[]; looTopPnlSymbols?: number } = {},
): Promise<{ manifest: ExperimentManifest; summary: WalkForwardSummary; outputDir: string }> {
  validateManifest(m);
  validateUniqueCandidates(m);
  // opts.codeFiles: a wrapper driver with its OWN kernel (e.g. the line-A
  // cross-sectional runner) passes the default list PLUS its kernel files so
  // the artifact's code identity covers the simulator that actually ran.
  // Absent = the default list — every existing manifest keeps its hashes.
  const codeHash = await hashCodeFiles(opts.codeFiles);

  // Create one immutable read-only SQLite snapshot of the data for this run.
  const tmpDir = mkdtempSync(join(tmpdir(), "uncle-carl-wf-"));
  const snapshotPath = join(tmpDir, "snapshot.db");
  try {
    const srcDb = new Database(m.data.dbPath, { readonly: true });
    try {
      // VACUUM INTO creates a consistent, WAL-free snapshot of the live DB.
      srcDb.exec(`VACUUM INTO '${snapshotPath}'`);
    } finally {
      srcDb.close();
    }

    // Resolve "latest" only from the immutable snapshot used by every replay.
    const asOfMs = resolveAsOf(m, snapshotPath);
    const configHash = hashString(canonicalJson(manifestIdentity(m, asOfMs)));
    const folds = generateFolds(m.window, asOfMs);
    const sleeve = manifestToSleeve(m);
    const replayToMs = folds[folds.length - 1].test.toMs;
    const barsDataHash = await hashDataSnapshot(
      snapshotPath,
      sleeve,
      Date.parse(m.window.from),
      replayToMs,
      // Trend exits can read farther back than the ranking warmup. Include
      // every consumed daily-source bar in the immutable data identity.
      Math.max(m.window.warmupDays, ...m.candidates.map(c => c.trendExit ? c.trendExit.smaDays * 2 + 15 : 0),
        ...m.candidates.map(c => c.idleOverlay ? idleOverlayHistoryDays(c.idleOverlay) + 15 : 0),
        ...m.candidates.map(c => c.breakoutShort ? breakoutHistoryDays(c.breakoutShort) + 15 : 0)),
      m.data.membership,
    );
    // §12-septies G0: the 15:45-slice rows are consumed data, so they are
    // part of the run's data identity. Legacy manifests (no sliceDb) keep
    // dataHash = the bars hash, byte-identical.
    const barsAndSlicesHash = m.data.sliceDb
      ? hashString(canonicalJson({ bars: barsDataHash, closeSlices: hashCloseSlices(m.data.sliceDb) }))
      : barsDataHash;
    // copySignal: the event rows a replay can consume (every row of the candidates'
    // sources known before the last fold ends) are consumed data too. Legacy
    // manifests (no data.signals) keep dataHash byte-identical.
    const dataHash = m.data.signals
      ? hashString(canonicalJson({
        base: barsAndSlicesHash,
        signals: hashSignalEvents(m.data.signals.dbPath, m.candidates.flatMap(c => (c.portfolio?.strategy.kind === "copySignal" ? [c.portfolio.strategy.source] : [])), replayToMs),
      }))
      : barsAndSlicesHash;
    // Data or code corrections must never overwrite evidence from an older run.
    const manifestHash = runIdentityHash(configHash, dataHash, codeHash);
    const outputDir = join("data", "backtests", manifestHash);

    // Seed / reconcile trial ledger.
    const runsById = new Map<string, TrialRecord>();
    for (const t of m.trialLedger ?? []) runsById.set(t.id, t);

    const innerMetrics: InnerMetrics[] = [];
    const outerTestResults: ReplayResult[] = [];
    const allTrials: TrialRecord[] = [];
    const outerFoldSelection: Array<{ outer: OuterFold; selected: CandidateConfig | null; selectedHash: string; selectionReason: string; skipped: boolean; skipReason?: string }> = [];

    // ── per-outer-fold nested CV + outer test ─────────────────────────────
    const stressResults: ReplayResult[] = [];
    const selectedByOuter = new Map<string, CandidateConfig>();

    // Independent chronological RiskGuard chains — base and stress never
    // share state (different cost tiers, different drawdown paths). Inner
    // candidate-selection trials below always start fresh (no chain state
    // passed) since they must judge each candidate on its own merits.
    let baseChainState: RiskState | undefined;
    let stressChainState: RiskState | undefined;
    // Once a chain ruins, it is CUT — no later fold in that chain ever
    // invokes the runner again (would silently reset capital on a dead
    // strategy). `chainCutFolds` feeds into skippedFolds so the run can
    // never be approved once this happens.
    let baseChainBroken = false;
    let stressChainBroken = false;
    const chainCutFolds: string[] = [];

    for (const outer of folds) {
      if (outer.inner.length === 0) {
        outerFoldSelection.push({
          outer,
          selected: null,
          selectedHash: "",
          selectionReason: "",
          skipped: true,
          skipReason: "no inner folds / insufficient training data",
        });
        continue;
      }

      // Run all candidates on this outer fold's inner folds only.
      const foldInnerMetrics: InnerMetrics[] = [];
      for (const inner of outer.inner) {
        for (const c of m.candidates) {
          const cfg = candidateToReplayConfig(m, c, "base", snapshotPath);
          const id = makeTrialId(inner.path, hashReplayConfig(cfg), "base");
          let record = runsById.get(id);
          if (!opts.dryRun) {
            record = await runTrial(m, c, inner, "base", record, snapshotPath, opts.runner, manifestHash);
            runsById.set(id, record);
          }
          if (record && record.status === "complete" && record.result) {
            const r = record.result;
            foldInnerMetrics.push({
              candidateHash: record.candidateHash,
              candidateName: record.candidateName,
              foldPath: inner.path,
              dsr: correctedDsr(r, m.candidates.length, m.trialAccounting.priorUniqueTrials, m.sleeve),
              sharpe: r.sharpe,
              maxDrawdown: r.maxDrawdown,
              totalReturn: r.totalReturn,
              trades: r.trades,
            });
          }
          if (record) allTrials.push(record);
        }
      }
      innerMetrics.push(...foldInnerMetrics);

      // Select winner using ONLY this outer fold's inner folds.
      const aggregates = aggregateInner(foldInnerMetrics);
      let selected: CandidateConfig | null = null;
      let selectedHash = "";
      let selectionReason = "";
      if (aggregates.length > 0) {
        const winner = selectCandidate(aggregates);
        selected = m.candidates.find(c => hashReplayConfig(candidateToReplayConfig(m, c, "base", snapshotPath)) === winner.candidateHash) ?? null;
        selectedHash = winner.candidateHash;
        selectionReason = `inner median DSR=${winner.medianDsr.toFixed(3)} Sharpe=${winner.medianSharpe.toFixed(3)} DD=${(winner.medianMaxDrawdown * 100).toFixed(1)}% hash=${winner.candidateHash.slice(0, 8)}`;
      }

      if (!selected) {
        if (opts.dryRun) {
          outerFoldSelection.push({ outer, selected: null, selectedHash: "", selectionReason: "", skipped: false });
          continue;
        }
        outerFoldSelection.push({
          outer,
          selected: null,
          selectedHash: "",
          selectionReason: "",
          skipped: true,
          skipReason: "no usable inner results; cannot select a candidate",
        });
        continue;
      }

      outerFoldSelection.push({ outer, selected, selectedHash, selectionReason, skipped: false });
      selectedByOuter.set(outer.path, selected);

      // Outer test (base) for the selected candidate only — chained. Cut
      // (never invoke the runner) once the base chain has ruined.
      if (baseChainBroken) {
        chainCutFolds.push(`${outer.test.path}:base`);
      } else {
        const baseCfg = candidateToReplayConfig(m, selected, "base", snapshotPath);
        const baseId = makeTrialId(outer.test.path, hashReplayConfig(baseCfg), "base");
        let baseRecord = runsById.get(baseId);
        if (!opts.dryRun) {
          baseRecord = await runTrial(m, selected, outer.test, "base", baseRecord, snapshotPath, opts.runner, manifestHash, baseChainState);
          runsById.set(baseId, baseRecord);
        }
        if (baseRecord && baseRecord.status === "complete" && baseRecord.result) {
          outerTestResults.push(baseRecord.result);
          if (isChainRuined(baseRecord.result)) {
            baseChainBroken = true;
            // The ruin itself is a blocking event, independent of whether a
            // later fold exists to cut — a wipeout on the LAST fold has no
            // subsequent fold, so without this the run could otherwise sail
            // through to "all gates pass" under permissive thresholds.
            chainCutFolds.push(`${outer.test.path}:base:ruined`);
          } else {
            baseChainState = continueRiskState(baseRecord.result);
          }
        }
        if (baseRecord) allTrials.push(baseRecord);
      }

      // Stress test for the same selected candidate (no reselection) — its
      // own independent chain, never mixed with base, cut independently.
      if (stressChainBroken) {
        chainCutFolds.push(`${outer.test.path}:stress`);
      } else {
        const stressCfg = candidateToReplayConfig(m, selected, "stress", snapshotPath);
        const stressId = makeTrialId(outer.test.path, hashReplayConfig(stressCfg), "stress");
        let stressRecord = runsById.get(stressId);
        if (!opts.dryRun) {
          stressRecord = await runTrial(m, selected, outer.test, "stress", stressRecord, snapshotPath, opts.runner, manifestHash, stressChainState);
          runsById.set(stressId, stressRecord);
        }
        if (stressRecord && stressRecord.status === "complete" && stressRecord.result) {
          stressResults.push(stressRecord.result);
          if (isChainRuined(stressRecord.result)) {
            stressChainBroken = true;
            // Same reasoning as base: the ruin itself blocks approval even
            // when it happens to be the last fold in the chain.
            chainCutFolds.push(`${outer.test.path}:stress:ruined`);
          } else {
            stressChainState = continueRiskState(stressRecord.result);
          }
        }
        if (stressRecord) allTrials.push(stressRecord);
      }
    }

    // ── break-even cost curve ─────────────────────────────────────────────
    // Generalized stress: the SAME per-fold selected candidates (no
    // reselection), re-run at each slippage tier with base commission, each
    // tier owning an independent chronological RiskState chain — exactly the
    // stress tier's mechanism. Each tier hashes its slippage into the
    // config, so runTrial caches every tier separately; the tier equal to
    // the manifest's base slippage is a cache hit on the base outer trials.
    let breakEvenCurve: Array<{ slippageBps: number; sharpe: number; totalReturn: number }> | undefined;
    let breakEvenSlippageBps: number | undefined;
    if (!opts.dryRun && (opts.breakEven ?? true) && selectedByOuter.size > 0) {
      const pushedTrialIds = new Set(allTrials.map(t => t.id));
      breakEvenCurve = [];
      for (const level of BREAK_EVEN_SLIPPAGE_BPS) {
        const mLevel: ExperimentManifest = { ...m, costs: { ...m.costs, base: { ...m.costs.base, slippageBps: level } } };
        let tierChainState: RiskState | undefined;
        let tierChainBroken = false;
        const tierResults: ReplayResult[] = [];
        for (const outer of folds) {
          const selected = selectedByOuter.get(outer.path);
          if (!selected) continue;
          // A ruin at this cost tier is the curve's ANSWER ("the strategy
          // dies at this slippage"), not a protocol failure: the chain is
          // cut like base/stress but nothing feeds chainCutFolds — blocking
          // approval on a deliberately hostile tier would make every
          // candidate unfalsifiable at high cost.
          if (tierChainBroken) continue;
          const tierCfg = candidateToReplayConfig(mLevel, selected, "base", snapshotPath);
          const tierId = makeTrialId(outer.test.path, hashReplayConfig(tierCfg), "base");
          let tierRecord = runsById.get(tierId);
          tierRecord = await runTrial(mLevel, selected, outer.test, "base", tierRecord, snapshotPath, opts.runner, manifestHash, tierChainState);
          runsById.set(tierId, tierRecord);
          if (!pushedTrialIds.has(tierRecord.id)) {
            allTrials.push(tierRecord);
            pushedTrialIds.add(tierRecord.id);
          }
          if (tierRecord.status === "complete" && tierRecord.result) {
            tierResults.push(tierRecord.result);
            if (isChainRuined(tierRecord.result)) tierChainBroken = true;
            else tierChainState = continueRiskState(tierRecord.result);
          } else {
            // Failed replay: the curve point covers the executed prefix and
            // ledgerComplete(allTrials) reflects the failure (blocks approval).
            tierChainBroken = true;
          }
        }
        if (tierResults.length > 0) {
          const tierHistory = stitchEquityHistory(tierResults, m.ledger.initialEquity);
          const tierMetrics = stitchedMetrics(tierHistory, tierResults, periodsPerYear(m.sleeve, m.data.source));
          breakEvenCurve.push({ slippageBps: level, sharpe: tierMetrics.sharpe, totalReturn: tierMetrics.totalReturn });
        }
      }
      breakEvenSlippageBps = breakEvenFromCurve(breakEvenCurve);
    }

    // ── stitched OOS + concentration ──────────────────────────────────────
    const stitchedHistory = stitchEquityHistory(outerTestResults, m.ledger.initialEquity);
    const stitched = stitchedMetrics(stitchedHistory, outerTestResults, periodsPerYear(m.sleeve, m.data.source));
    const conc = concentration(outerTestResults);
    const evidence = computeOuterEvidence(outerTestResults, stitchedHistory, periodsPerYear(m.sleeve, m.data.source));

    // ── sequence-risk Monte Carlo (2026-09-26) ── same stitched daily
    // series the evidence layer judges + the closed trades in close order.
    // Additive: absent (undefined) when no outer fold executed; the two
    // optional gates fail closed in that case.
    const sequenceRisk = outerTestResults.length > 0
      ? computeSequenceRisk(
          stitchedDailyReturns(stitchedHistory, outerTestResults[0]?.config?.rthOnly ?? false),
          outerTestResults
            .flatMap(r => r.closedTrades)
            .sort((a, b) => a.exitAt - b.exitAt)
            .map(t => t.pnl),
          m.ledger.initialEquity,
        )
      : undefined;

    // ── refSymbol buy-and-hold benchmark on the SAME executed OOS folds ───
    // Loaded from the immutable snapshot (same bars every replay consumed).
    // Absent when no outer test executed (dry-run/skips): bench gates then
    // fail closed rather than comparing against nothing.
    let benchReturn: number | undefined;
    let benchSharpe: number | undefined;
    let benchByFold: Array<{ foldPath: string; benchReturn: number }> | undefined;
    let benchError: string | undefined;
    if (outerTestResults.length > 0) {
      const snapDb = new Database(snapshotPath, { readonly: true });
      try {
        const foldBars = [...outerTestResults]
          .sort((a, b) => a.fromMs - b.fromMs)
          .map(r => ({
            foldPath: r.window.label,
            fromMs: r.fromMs,
            bars: loadBars(m.data.refSymbol, m.data.timeframe, m.data.source, m.data.rthOnly, r.fromMs, r.toMs, snapDb),
          }));
        const bench = benchmarkFromFoldBars(foldBars, periodsPerYear(m.sleeve, m.data.source), m.data.rthOnly);
        benchReturn = bench.benchReturn;
        benchSharpe = bench.benchSharpe;
        benchByFold = bench.byFold;
      } catch (e) {
        // Do NOT abort the protocol run: the strategy evidence is still
        // valid. The benchmark stays absent, and any configured bench gate
        // fails closed on the missing value instead of silently passing.
        benchError = (e as Error).message;
      } finally {
        snapDb.close();
      }
    }

    // ── leave-one-symbol-out ──────────────────────────────────────────────
    let loo: LooResult[] = [];
    if (selectedByOuter.size > 0 && !opts.dryRun) {
      // opts.looTopPnlSymbols (additive, absent = full-universe legacy):
      // restrict the LOO chains to the N symbols with the largest |gross
      // P&L| across the outer OOS chain — the only ones whose exclusion can
      // move the stitched metrics (see runLoo's `symbols` docstring).
      let looSymbols = m.data.universe;
      if (opts.looTopPnlSymbols !== undefined && opts.looTopPnlSymbols > 0) {
        const pnl = new Map<string, number>();
        for (const r of outerTestResults) {
          for (const [sym, v] of Object.entries(r.tradesBySymbol)) {
            if (v.trades > 0) pnl.set(sym, (pnl.get(sym) ?? 0) + Math.abs(v.grossPnl));
          }
        }
        looSymbols = [...pnl.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, opts.looTopPnlSymbols).map(([s]) => s);
      }
      const looOutcome = await runLoo(m, selectedByOuter, folds, snapshotPath, opts.runner, looSymbols);
      loo = looOutcome.results;
      chainCutFolds.push(...looOutcome.cutChains);
    }

    // ── assemble summary ──────────────────────────────────────────────────
    const lastSelection = [...outerFoldSelection].reverse().find(s => !s.skipped);
    const selectedCandidate = lastSelection?.selected
      ? { hash: lastSelection.selectedHash, name: lastSelection.selected.name, reason: lastSelection.selectionReason }
      : null;

    const summary: WalkForwardSummary = {
      manifestHash,
      configHash,
      dataHash,
      codeHash,
      asOfMs,
      resolvedTo: new Date(asOfMs).toISOString(),
      selectedCandidate,
      outerSelection: outerFoldSelection
        .filter(s => !s.skipped && s.selected !== null)
        .map(s => ({ foldPath: s.outer.test.path, candidateName: s.selected!.name, candidateHash: s.selectedHash })),
      innerSelection: innerMetrics,
      outerTests: outerTestResults.map(r => ({ foldPath: r.window.label, result: r })),
      stressTests: stressResults.map(r => ({ foldPath: r.window.label, result: r })),
      stitchedOos: { ...stitched, benchReturn, benchSharpe },
      benchByFold,
      benchError,
      concentration: conc,
      loo,
      outerPsr: evidence.outerPsr,
      minTrl: evidence.minTrl,
      observations: evidence.observations,
      foldPsr: evidence.foldPsr,
      breakEvenCurve,
      breakEvenSlippageBps,
      sequenceRisk,
      certifiableSharpeAtPsr95: evidence.certifiableSharpeAtPsr95,
      skippedFolds: [...outerFoldSelection.filter(s => s.skipped).map(s => s.outer.path), ...chainCutFolds],
      acceptance: {},
      approved: false,
      approvalReason: "",
      complete: ledgerComplete(allTrials),
      priorTrialsComplete: m.trialAccounting.complete,
    };
    evaluateAcceptance(summary, m.acceptance);

    // ── persist ───────────────────────────────────────────────────────────
    const resolvedManifest = { ...m, trialLedger: allTrials };
    if (!opts.dryRun) {
      writeOutputs(outputDir, resolvedManifest, allTrials, summary);
    }

    return { manifest: resolvedManifest, summary, outputDir };
  } finally {
    // Cleanup immutable snapshot even if the protocol throws.
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  if (!manifestPath) {
    console.error("Usage: bun run experiment:wf -- <manifest.json> [--dry-run]");
    process.exit(1);
  }
  const m = loadManifest(manifestPath);
  console.log(`▌ Walk-forward: ${m.name}`);
  console.log(`   asOf: ${m.asOf} ${m.asOf.toLowerCase() === "latest" ? "(will resolve to latest common bar)" : ""}`);
  console.log(`   candidates: ${m.candidates.map(c => c.name).join(", ")}`);
  console.log(`   folds: ${m.window.outerFoldCount} outer × ${m.window.innerFoldCount} inner`);
  if (dryRun) console.log("   DRY RUN — no trials executed");
  if (noBreakEven) console.log("   --no-breakeven: break-even curve skipped (minBreakEvenSlippageBps gate, if set, fails closed)");

  const { summary, outputDir } = await runWalkForward(m, { dryRun, breakEven: !noBreakEven });

  console.log("\n▌ SUMMARY");
  console.log(`   selected: ${summary.selectedCandidate?.name ?? "none"} (${summary.selectedCandidate?.reason ?? ""})`);
  const chain = summary.outerSelection ?? [];
  if (new Set(chain.map(c => c.candidateHash)).size > 1) {
    console.log(`   ⚠ MIXED OOS CHAIN — each outer fold ran its own inner winner: ${chain.map(c => `${c.foldPath}=${c.candidateName}`).join(", ")}. The stitched metrics below belong to this mix, NOT to "${summary.selectedCandidate?.name ?? "?"}" alone.`);
  }
  console.log(`   stitched OOS: ret=${(summary.stitchedOos.totalReturn * 100).toFixed(1)}% sharpe=${summary.stitchedOos.sharpe.toFixed(2)} DD=${(summary.stitchedOos.maxDrawdown * 100).toFixed(1)}% trades=${summary.stitchedOos.trades}`);
  if (summary.stitchedOos.ordersPerDay !== undefined) console.log(`   executed orders: ${summary.stitchedOos.orders} (${summary.stitchedOos.ordersPerDay.toFixed(2)}/calendar day; goal 30/day; includes resizes and fold-end exits)`);
  if (summary.stitchedOos.marginInterest) {
    console.log(`   margin interest: $${summary.stitchedOos.marginInterest.toFixed(2)} (Reg-T financing, already netted from equity; per-fold values in outerTests[].result.marginInterest)`);
  }
  if (summary.stitchedOos.benchReturn !== undefined) {
    console.log(`   bench (${m.data.refSymbol} B&H, same folds): ret=${(summary.stitchedOos.benchReturn * 100).toFixed(1)}% sharpe=${(summary.stitchedOos.benchSharpe ?? 0).toFixed(2)} | excess ret=${((summary.stitchedOos.totalReturn - summary.stitchedOos.benchReturn) * 100).toFixed(1)}% excess sharpe=${(summary.stitchedOos.sharpe - (summary.stitchedOos.benchSharpe ?? 0)).toFixed(2)}`);
  }
  if (summary.observations !== undefined) {
    const trlStr = summary.minTrl == null ? "∞ (SR ≤ 0)" : `${Math.ceil(summary.minTrl)}`;
    const psrStr = summary.outerPsr !== undefined ? summary.outerPsr.toFixed(3) : "n/a";
    const foldStr = summary.foldPsr?.length ? ` | foldPSR=[${summary.foldPsr.map(f => f.psr.toFixed(2)).join(", ")}]` : "";
    console.log(`   evidence: outerPSR=${psrStr} (autocorr-penalized, vs SR 0) obs=${summary.observations} minTRL=${trlStr}${foldStr}`);
  }
  if (summary.breakEvenCurve) {
    const maxTier = BREAK_EVEN_SLIPPAGE_BPS[BREAK_EVEN_SLIPPAGE_BPS.length - 1];
    const beStr = summary.breakEvenSlippageBps === Infinity
      ? `> ${maxTier} (never crosses in tested range)`
      : `${summary.breakEvenSlippageBps?.toFixed(1)}`;
    console.log(`   break-even slippage: ${beStr} bps | curve: ${summary.breakEvenCurve.map(p => `${p.slippageBps}bps→SR ${p.sharpe.toFixed(2)}`).join(", ")}`);
  }
  if (summary.sequenceRisk?.bootstrap) {
    const b = summary.sequenceRisk.bootstrap;
    const r = summary.sequenceRisk.tradeReshuffle;
    console.log(`   sequence risk (MC, seed ${b.seed}): bootstrap maxDD p5/p50/p95 = ${(b.maxDrawdown.p5 * 100).toFixed(1)}/${(b.maxDrawdown.p50 * 100).toFixed(1)}/${(b.maxDrawdown.p95 * 100).toFixed(1)}% | final ret p5/p50/p95 = ${(b.finalReturn.p5 * 100).toFixed(1)}/${(b.finalReturn.p50 * 100).toFixed(1)}/${(b.finalReturn.p95 * 100).toFixed(1)}% | observed DD pctile: boot ${(b.observedMaxDdPercentile * 100).toFixed(1)}%${r ? `, reshuffle ${(r.observedMaxDdPercentile * 100).toFixed(1)}%` : ""}`);
  }
  if (summary.certifiableSharpeAtPsr95 !== undefined) {
    console.log(`   power: ${summary.observations} OOS daily obs can certify (PSR 95%, SR*=0) only annualized Sharpe ≥ ${summary.certifiableSharpeAtPsr95.toFixed(2)} — smaller true edges are UNDECIDABLE at this window`);
  }
  console.log(`   approved: ${summary.approved} — ${summary.approvalReason}`);
  if (!dryRun) console.log(`   written: ${outputDir}/`);
  else console.log(`   dry-run: no files written`);
}

if (import.meta.main) await main();
