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
  TrailStopConfig,
  SharpeGateConfig,
  CapacityGuardConfig,
} from "../strategies/momentum/MomentumEngine";
import type { MeanRevEngineConfig } from "../strategies/meanrev/MeanRevEngine";
import type { EquitySemantics } from "../strategies/momentum/RiskGuard";
import type { AlpacaMomentumAdapterConfig } from "../strategies/momentum/AlpacaMomentumAdapter";
import type { BinanceMomentumAdapterConfig } from "../strategies/momentum/BinanceMomentumAdapter";
import type { BinanceCoinMMomentumAdapterConfig } from "../strategies/momentum/BinanceCoinMMomentumAdapter";

export type PortfolioTemplate = "momentum_tsm" | "meanrev_connors";

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

export type PortfolioParams = MomentumTsmParams | MeanRevConnorsParams;

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

export type PortfolioBuildPlan = MomentumPortfolioPlan | MeanRevPortfolioPlan;
