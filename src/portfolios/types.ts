/**
 * Platform portfolios (F3a, 2026-10-04 — docs/platform/PLAN.md).
 *
 * A PortfolioDefinition is a sleeve expressed as DATA: strategy template +
 * broker account + fixed capital + universe + params. The factory
 * (./factory.ts) turns a definition into the exact build plan that
 * src/index.ts used to assemble by hand for each sleeve: engine config,
 * adapter options, state-persistence spec, heartbeat, governor registration
 * and scheduler choice.
 *
 * Parity contract: src/portfolios/parity.test.ts deep-equals
 * buildPortfolioPlan(builtin) against the pure plan functions exported from
 * src/index.ts (the verbatim extraction of the hand-written wiring). Any
 * drift between "sleeves as data" and the validated wiring is a test
 * failure, exactly like the liveSleeveConfigs "vivo = validado" lock.
 */
import type {
  MomentumEngineConfig,
  VolTargetConfig,
  ExposureControlConfig,
  TrailStopConfig,
  TimeStopConfig,
  SharpeGateConfig,
  CapacityGuardConfig,
} from "../strategies/momentum/MomentumEngine";
import type { MeanRevEngineConfig } from "../strategies/meanrev/MeanRevEngine";
import type { EquitySemantics } from "../strategies/momentum/RiskGuard";
import type { AlpacaMomentumAdapterConfig } from "../strategies/momentum/AlpacaMomentumAdapter";
import type { BinanceMomentumAdapterConfig } from "../strategies/momentum/BinanceMomentumAdapter";
import type { BinanceCoinMMomentumAdapterConfig } from "../strategies/momentum/BinanceCoinMMomentumAdapter";
import type { PortfolioStrategyConfig, VenueId } from "../portfolio-engine/types";

export type PortfolioTemplate = "momentum_tsm" | "meanrev_connors" | "portfolio";

/** Broker accounts the runtime knows how to wire today. */
export type PortfolioAccountId = "alpaca_main" | "binance_usdt" | "binance_usdc" | "binance_coinm";

/** Registered governor DEFAULT mode. A persisted sleeve_modes row (owner
 *  action via scripts/set-sleeve-mode.ts) still overrides it at runtime. */
export type PortfolioMode = "live" | "shadow";

export interface PortfolioStateSpec {
  path: string;
  currentBase: number;
  legacyBase: number;
}

export interface PortfolioGovernorSpec {
  promotionEligible?: boolean;
  evidenceVersion: string;
}

/** One-shot MODEL_CUTOVER window (reunderwriteBefore); self-expiring. */
export interface PortfolioCutoverSpec {
  at: number;
  expiresAt: number;
  /** Only these symbols (MomentumEngineConfig.reunderwriteSymbols); absent = all. */
  symbols?: string[];
}

/** Daily TSM horizon (same shape as index.ts's MomentumStocksDailyHorizon). */
export interface DailyHorizonSpec {
  lookbackDays?: number;
  lookbackDaysList?: number[];
  maLengthDays: number;
}

export interface MomentumTsmParams {
  universe: string[];
  rebalanceMinutes: number;
  /** Bar math fed to tsm/regime/scorer (60 on hourly kernels, 1440 on daily). */
  barMinutes: number;
  /** Explicit candle history for hourly kernels (754 today); daily kernels
   *  derive max(lookback, MA) + 11 — the replay's own formula. */
  historyBars?: number;
  horizon?: DailyHorizonSpec;
  maxLongs: number;
  notionalPctPerSlot: number;
  slotHysteresis?: boolean;
  volTarget?: VolTargetConfig;
  timeStop?: TimeStopConfig;
  /** Portfolio exposure control (RW4a, 2026-10-23 — MomentumEngineConfig.
   *  exposureControl): resizes the OPEN book toward one sleeve-level scale
   *  from realized book vol and/or drawdown. Research knob: NO built-in
   *  definition sets it until a pre-registered candidate passes
   *  (RW-reescritura-rentable.md §13). Absent = OFF. */
  exposureControl?: ExposureControlConfig;
  /** RegimeFilterConfig overrides on top of `barMinutes` (RW3, 2026-10-23: momentum_crypto
   *  loosens correlationCeiling 0.85 → 1.01 = correlation-collapse brake OFF, vol-spike check
   *  stays ON). Absent = the engine's DEFAULT_REGIME_CONFIG thresholds. */
  regime?: { correlationCeiling?: number };
  tsmTrail?: TrailStopConfig;
  volStop?: TrailStopConfig;
  sharpeGate?: SharpeGateConfig;
  capacityGuard?: CapacityGuardConfig;
  equitySemantics: EquitySemantics;
  modelVersion?: string;
  cutover?: PortfolioCutoverSpec;
  heartbeatName: string;
  loggerContext: string;
  state: PortfolioStateSpec;
  governor: PortfolioGovernorSpec;
}

export interface MeanRevConnorsParams {
  /** Strategy knobs (universe, RSI, SMAs, slots) come from
   *  DEFAULT_MEANREV_CONFIG — already the single source; index.ts only ever
   *  added the overrides below. */
  volStop: TrailStopConfig;
  capacityGuard?: CapacityGuardConfig;
  equitySemantics: EquitySemantics;
  heartbeatName: string;
  loggerContext: string;
  /** scheduleDailyStockRun label (marker + retry file names). */
  schedulerLabel: string;
  state: PortfolioStateSpec;
  governor: PortfolioGovernorSpec;
}

/** RW (2026-10-20): a sleeve run by the portfolio engine
 *  (src/portfolio-engine/live). `strategy` is the manifest candidate's
 *  `portfolio` block; `runMode` observer computes and persists, submits
 *  nothing. NOT wired to any sleeve yet — the director does that at cutover. */
export interface PortfolioEngineParams {
  engine: "portfolio";
  /** The incumbent sleeve this definition runs on: the `trades.account_id`
   *  whose rows the engine reads (observer) or manages (live). The definition
   *  id is its OWN registry id (never the sleeve's, whose row belongs to the
   *  incumbent); that is how an observer coexists with the incumbent and how
   *  rollback leaves the incumbent definition untouched. Absent: the engine
   *  runs on the definition id (research/tests only; index.ts requires it). */
  sleeve?: string;
  strategy: PortfolioStrategyConfig;
  venue: VenueId;
  runMode: "observer" | "live";
  strategyVersion: string;
  heartbeatName: string;
  loggerContext: string;
  /** Venue order rules the design was validated with. */
  minOrderNotional: number;
  rebalanceBand: number;
  /** Universe symbols allowed to be stale before the pass is skipped (default 0). */
  maxStaleSymbols?: number;
  /** Strategy symbol → historical_bars symbol (e.g. {"BTC": "BTC/USD"}). */
  dataSymbols?: Record<string, string>;
  /** Written by scripts/portfolio-engine-cutover.ts: where the design came from
   *  and the hash of what was tested (designHash). A LIVE definition whose
   *  design no longer matches its hash is refused at boot: live = tested. */
  provenance?: PortfolioEngineProvenance;
}

export interface PortfolioEngineProvenance {
  manifest: string;
  candidate: string;
  /** sha256 of designHash input (see src/portfolio-engine/live/cutover.ts). */
  designSha256: string;
}

export type PortfolioParams = MomentumTsmParams | MeanRevConnorsParams | PortfolioEngineParams;

export interface PortfolioDefinition {
  id: string;
  name: string;
  template: PortfolioTemplate;
  account: PortfolioAccountId;
  /** Fixed sleeve capital (owner rule: per-sleeve capital never reallocates). */
  capital: number;
  mode: PortfolioMode;
  /** Registry-level flag. Runtime env gates (MOMENTUM_USDC_ENABLED /
   *  MOMENTUM_COINM_ENABLED / MEANREV_ENABLED) still apply unchanged. */
  enabled: boolean;
  params: PortfolioParams;
}

// ── build plan: what index.ts's main() consumes ─────────────────────────

export type AdapterSpec =
  | { kind: "alpaca"; options: Partial<AlpacaMomentumAdapterConfig> }
  | { kind: "binance_usdm"; options: Partial<BinanceMomentumAdapterConfig> }
  | { kind: "binance_coinm"; options: Partial<BinanceCoinMMomentumAdapterConfig> };

export interface ShadowSpec {
  strategy: string;
  closeReason: string;
  timeframe: string;
  market: "stock" | "crypto";
}

export interface StatePersistenceSpec {
  path: string;
  currentBase: number;
  legacyBase: number;
  equitySemantics: EquitySemantics;
}

export interface GovernorRegistrationSpec {
  sleeve: string;
  kind: PortfolioMode;
  promotionEligible?: boolean;
  evidenceVersion: string;
}

export interface HeartbeatSpec {
  name: string;
  intervalMs: number;
  graceMultiplier?: number;
}

export type SchedulerSpec =
  | { kind: "engine-start" }
  | { kind: "index-stocks-daily"; markerPath: string }
  | { kind: "index-stocks-hourly" }
  | { kind: "index-meanrev-daily"; label: string };

export interface MomentumPortfolioPlan {
  template: "momentum_tsm";
  portfolioId: string;
  engineConfig: Partial<MomentumEngineConfig>;
  adapter: AdapterSpec;
  shadow: ShadowSpec;
  loggerContext: string;
  statePersistence: StatePersistenceSpec;
  governorRegistration: GovernorRegistrationSpec;
  scheduler: SchedulerSpec;
  /** Present only when index.ts drives the tick loop itself (alpaca momentum:
   *  engine.start() is never called, so main() registers the heartbeat). */
  heartbeat?: HeartbeatSpec;
}

export interface MeanRevPortfolioPlan {
  template: "meanrev_connors";
  portfolioId: string;
  engineConfig: Partial<MeanRevEngineConfig>;
  adapter: { kind: "alpaca"; options: Partial<AlpacaMomentumAdapterConfig> };
  shadow: ShadowSpec;
  loggerContext: string;
  statePersistence: StatePersistenceSpec;
  governorRegistration: GovernorRegistrationSpec;
  scheduler: SchedulerSpec;
}

/** Build plan of a portfolio-engine sleeve: everything the live factory
 *  (src/portfolio-engine/live/factory.ts) needs besides the venue instances. */
export interface PortfolioEnginePlan {
  template: "portfolio";
  portfolioId: string;
  account: PortfolioAccountId;
  capital: number;
  params: PortfolioEngineParams;
  heartbeat: HeartbeatSpec;
}

export type PortfolioBuildPlan = MomentumPortfolioPlan | MeanRevPortfolioPlan | PortfolioEnginePlan;
