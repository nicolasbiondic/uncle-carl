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
import type { EquitySemantics } from "../strategies/momentum/RiskGuard";
import type { BinanceMomentumAdapterConfig } from "../strategies/momentum/BinanceMomentumAdapter";
import type { PortfolioStrategyConfig, VenueId } from "../portfolio-engine/types";

/** "meanrev_connors" is RETIRED (2026-11-07): no engine runs it any more (the
 *  meanrev_stocks sleeve runs on the portfolio engine). The literal stays in
 *  the union only so registry rows seeded before that date (archived at boot,
 *  never deleted) still type-check when read. "momentum_tsm" runs on the
 *  Binance accounts only — its Alpaca adapter was retired the same day. */
export type PortfolioTemplate = "momentum_tsm" | "meanrev_connors" | "portfolio";

/** Broker accounts the runtime knows how to wire today. */
export type PortfolioAccountId = "alpaca_main" | "binance_usdt" | "binance_usdc" | "binance_coinm";

/** Registry label of a definition: "live" trades; "shadow" is the label the
 *  cutover script gives an OBSERVER portfolio-engine definition (computes,
 *  sends nothing). It is a platform_portfolios column, not a runtime mode:
 *  the governor's live/shadow sleeve mode was removed on 2026-11-07 (owner,
 *  audit C) — no sleeve can be routed to a simulated book any more. */
export type PortfolioMode = "live" | "shadow";

export interface PortfolioStateSpec {
  path: string;
  currentBase: number;
  legacyBase: number;
}

export interface PortfolioGovernorSpec {
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
  allowSameTickReentry?: boolean;
  breakoutShort?: MomentumEngineConfig["breakoutShort"];
  /** RW7: only the pause policy is configurable here; equity semantics remain account-owned. */
  risk?: Pick<NonNullable<MomentumEngineConfig["risk"]>, "mode">;
  /** Portfolio exposure control (RW4a, 2026-10-23 — MomentumEngineConfig.
   *  exposureControl): resizes the OPEN book toward one sleeve-level scale
   *  from realized book vol and/or drawdown. Research knob: NO built-in
   *  definition sets it until a pre-registered candidate passes
   *  (RW-reescritura-rentable.md §13). Absent = OFF. */
  exposureControl?: ExposureControlConfig;
  /** RegimeFilterConfig overrides on top of `barMinutes`. Absent = engine defaults. */
  regime?: { enabled?: boolean; correlationCeiling?: number };
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
   *  MEANREV_ENABLED) still apply unchanged. */
  enabled: boolean;
  params: PortfolioParams;
}

// ── build plan: what index.ts's main() consumes ─────────────────────────

export type AdapterSpec =
  | { kind: "binance_usdm"; options: Partial<BinanceMomentumAdapterConfig> };

export interface StatePersistenceSpec {
  path: string;
  currentBase: number;
  legacyBase: number;
  equitySemantics: EquitySemantics;
}

export interface GovernorRegistrationSpec {
  sleeve: string;
  evidenceVersion: string;
}

export interface HeartbeatSpec {
  name: string;
  intervalMs: number;
  graceMultiplier?: number;
}

/** Every momentum plan today is engine-driven (engine.start()); the index.ts
 *  stock schedulers went with the Alpaca incumbents on 2026-11-07. */
export type SchedulerSpec = { kind: "engine-start" };

export interface MomentumPortfolioPlan {
  template: "momentum_tsm";
  portfolioId: string;
  engineConfig: Partial<MomentumEngineConfig>;
  adapter: AdapterSpec;
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

export type PortfolioBuildPlan = MomentumPortfolioPlan | PortfolioEnginePlan;
