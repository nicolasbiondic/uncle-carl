/**
 * Portfolio factory (F3a, 2026-10-04 — docs/platform/PLAN.md): builds, from
 * a PortfolioDefinition, everything src/index.ts used to assemble by hand
 * per sleeve — engine config, adapter options, state persistence spec,
 * heartbeat, governor registration and scheduler choice.
 *
 * Parity contract: for every built-in definition the produced plan is
 * deep-equal to the corresponding pure plan function exported from
 * src/index.ts (the verbatim extraction of the hand-written wiring) —
 * locked by src/portfolios/parity.test.ts. No engine behavior lives here;
 * this module only ARRANGES the same objects.
 *
 * Must NOT import from "../index" (index.ts imports this module; a
 * back-edge would hit the TDZ on index's exported consts at module eval).
 */
import type { MomentumEngineConfig } from "../strategies/momentum/MomentumEngine";
import { DEFAULT_MEANREV_CONFIG } from "../strategies/meanrev/MeanRevEngine";
// Neutral module (no index.ts back-edge): the same measured headroom both
// wiring paths multiply into the gross backstop — see its docstring.
import { GROSS_CAP_HEADROOM } from "../config/grossCap";
import { DEFAULT_ADAPTER_CONFIG as DEFAULT_BINANCE_ADAPTER_CONFIG } from "../strategies/momentum/BinanceMomentumAdapter";
import { DEFAULT_ALPACA_ADAPTER_CONFIG } from "../strategies/momentum/AlpacaMomentumAdapter";
import type {
  AdapterSpec,
  DailyHorizonSpec,
  GovernorRegistrationSpec,
  HeartbeatSpec,
  MeanRevConnorsParams,
  MeanRevPortfolioPlan,
  MomentumPortfolioPlan,
  MomentumTsmParams,
  PortfolioBuildPlan,
  PortfolioCutoverSpec,
  PortfolioDefinition,
  SchedulerSpec,
  ShadowSpec,
} from "./types";

/** Longest return horizon of a daily kernel (same math as index.ts's
 *  dailyHorizonMaxLookback — not imported from there: see module docstring). */
function horizonMaxLookback(h: DailyHorizonSpec): number {
  return h.lookbackDaysList ? Math.max(...h.lookbackDaysList) : h.lookbackDays!;
}

/** Self-expiring one-shot cutover: the boundary while the window is open,
 *  otherwise undefined (mirrors momentumStocksCutoverFor/momentumUsdcCutoverFor). */
export function cutoverReunderwriteBefore(cutover: PortfolioCutoverSpec | undefined, nowMs: number): number | undefined {
  if (!cutover) return undefined;
  return nowMs < cutover.expiresAt ? cutover.at : undefined;
}

function governorRegistration(def: PortfolioDefinition, governor: { promotionEligible?: boolean; evidenceVersion: string }): GovernorRegistrationSpec {
  return {
    sleeve: def.id,
    kind: def.mode,
    ...(governor.promotionEligible !== undefined ? { promotionEligible: governor.promotionEligible } : {}),
    evidenceVersion: governor.evidenceVersion,
  };
}

function buildMomentumPlan(def: PortfolioDefinition, nowMs: number): MomentumPortfolioPlan {
  const p = def.params as MomentumTsmParams;
  const horizon = p.horizon;
  // Daily kernels size history with the replay's own formula; hourly kernels
  // declare it explicitly (754 = 31d of 1h bars + warmup margin today).
  const historyBars = horizon ? Math.max(horizonMaxLookback(horizon), horizon.maLengthDays) + 11 : p.historyBars;
  if (historyBars === undefined) {
    throw new Error(`portfolio '${def.id}': momentum_tsm needs either params.historyBars or params.horizon`);
  }
  const reunderwriteBefore = cutoverReunderwriteBefore(p.cutover, nowMs);

  const engineConfig: Partial<MomentumEngineConfig> = {
    mode: "time-series",
    universe: p.universe,
    rebalanceMinutes: p.rebalanceMinutes,
    heartbeatName: p.heartbeatName,
    historyBars,
    notionalPctPerSlot: p.notionalPctPerSlot,
    tsm: {
      barMinutes: p.barMinutes,
      maxLongs: p.maxLongs,
      ...(p.slotHysteresis ? { slotHysteresis: true } : {}),
      ...(horizon
        ? (horizon.lookbackDaysList
          ? { lookbackDaysList: horizon.lookbackDaysList, maLengthDays: horizon.maLengthDays }
          : { lookbackDays: horizon.lookbackDays, maLengthDays: horizon.maLengthDays })
        : {}),
    },
    regime: { barMinutes: p.barMinutes },
    scorer: { barMinutes: p.barMinutes },
    ...(p.tsmTrail ? { tsmTrail: { ...p.tsmTrail } } : {}),
    ...(p.volStop ? { volStop: { ...p.volStop } } : {}),
    ...(p.sharpeGate ? { sharpeGate: { ...p.sharpeGate } } : {}),
    ...(p.volTarget ? { volTarget: { ...p.volTarget } } : {}),
    risk: { equitySemantics: p.equitySemantics },
    ...(p.modelVersion ? { modelVersion: p.modelVersion } : {}),
    // The runtime gross backstop is the slot×count product × measured
    // headroom (G diagnostic, docs/reports/G-gross-cap.md, applied
    // 2026-10-07): at the bare product it blocked validated-size entries
    // exactly in trends (locked in scripts/liveSleeveConfigs.test.ts).
    maxGrossExposureMult: p.notionalPctPerSlot * p.maxLongs * GROSS_CAP_HEADROOM,
    ...(p.capacityGuard ? { capacityGuard: { ...p.capacityGuard } } : {}),
    ...(reunderwriteBefore !== undefined
      ? { reunderwriteBefore, ...(p.cutover?.symbols ? { reunderwriteSymbols: [...p.cutover.symbols] } : {}) }
      : {}),
  };

  let adapter: AdapterSpec;
  let shadowTimeframe: string;
  let scheduler: SchedulerSpec;
  let heartbeat: HeartbeatSpec | undefined;
  switch (def.account) {
    case "alpaca_main":
      adapter = {
        kind: "alpaca",
        options: {
          ...(def.id !== DEFAULT_ALPACA_ADAPTER_CONFIG.accountId ? { accountId: def.id } : {}),
          // Daily kernel reads "1Day" bars with today's forming session
          // stripped (MomentumEngine has no MeanRevEngine-style strip).
          ...(horizon ? { timeframe: "1Day", dropTodayDailyBar: true } : {}),
        },
      };
      shadowTimeframe = horizon ? "1Day" : "5Min";
      // index.ts owns the stock tick (engine.start() never called): market
      // hours only, so main() registers the heartbeat and drives the loop.
      scheduler = horizon
        ? { kind: "index-stocks-daily", markerPath: `data/daily-run-${def.id.replace(/_/g, "-")}.txt` }
        : { kind: "index-stocks-hourly" };
      heartbeat = horizon
        ? { name: p.heartbeatName, intervalMs: 86_400_000, graceMultiplier: 5 }
        : { name: p.heartbeatName, intervalMs: 60 * 60_000 };
      break;
    case "binance_usdt":
      adapter = {
        kind: "binance_usdm",
        options: { ...(def.id !== DEFAULT_BINANCE_ADAPTER_CONFIG.accountId ? { accountId: def.id } : {}) },
      };
      shadowTimeframe = p.barMinutes === 1440 ? "1Day" : "1Hour";
      scheduler = { kind: "engine-start" };
      break;
    case "binance_usdc":
      adapter = {
        kind: "binance_usdm",
        options: { accountId: def.id, quoteAsset: "USDC", candleTimeframe: horizon ? "1Day" : "1Hour" },
      };
      shadowTimeframe = p.barMinutes === 1440 ? "1Day" : "1Hour";
      scheduler = { kind: "engine-start" };
      break;
    case "binance_coinm":
      adapter = { kind: "binance_coinm", options: { accountId: def.id } };
      shadowTimeframe = p.barMinutes === 1440 ? "1Day" : "1Hour";
      scheduler = { kind: "engine-start" };
      break;
  }

  const shadow: ShadowSpec = {
    strategy: "MOMENTUM",
    closeReason: "MOMENTUM_REBALANCE",
    timeframe: shadowTimeframe,
    market: def.account === "alpaca_main" ? "stock" : "crypto",
  };

  return {
    template: "momentum_tsm",
    portfolioId: def.id,
    engineConfig,
    adapter,
    shadow,
    loggerContext: p.loggerContext,
    statePersistence: { path: p.state.path, currentBase: p.state.currentBase, legacyBase: p.state.legacyBase, equitySemantics: p.equitySemantics },
    governorRegistration: governorRegistration(def, p.governor),
    scheduler,
    ...(heartbeat ? { heartbeat } : {}),
  };
}

function buildMeanRevPlan(def: PortfolioDefinition): MeanRevPortfolioPlan {
  if (def.account !== "alpaca_main") {
    throw new Error(`portfolio '${def.id}': meanrev_connors only runs on alpaca_main (shared-wallet sleeve)`);
  }
  const p = def.params as MeanRevConnorsParams;
  return {
    template: "meanrev_connors",
    portfolioId: def.id,
    engineConfig: {
      accountId: def.id,
      baseUsd: def.capital,
      heartbeatName: p.heartbeatName,
      risk: { equitySemantics: p.equitySemantics },
      // DEFAULT_MEANREV_CONFIG is the single source for slotPct/maxPositions;
      // the backstop is their product × measured headroom (same derivation as
      // index.ts's MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT — identical FP
      // result; G diagnostic, applied 2026-10-07).
      maxGrossExposureMult: DEFAULT_MEANREV_CONFIG.slotPct * DEFAULT_MEANREV_CONFIG.maxPositions * GROSS_CAP_HEADROOM,
      volStop: { ...p.volStop },
      ...(p.capacityGuard ? { capacityGuard: { ...p.capacityGuard } } : {}),
    },
    adapter: {
      kind: "alpaca",
      options: { accountId: def.id, timeframe: "1Day", strategy: "MEANREV", closeReason: "MEANREV_EXIT" },
    },
    shadow: { strategy: "MEANREV", closeReason: "MEANREV_EXIT", timeframe: "1Day", market: "stock" },
    loggerContext: p.loggerContext,
    statePersistence: { path: p.state.path, currentBase: p.state.currentBase, legacyBase: p.state.legacyBase, equitySemantics: p.equitySemantics },
    governorRegistration: governorRegistration(def, p.governor),
    scheduler: { kind: "index-meanrev-daily", label: p.schedulerLabel },
  };
}

/** Build the full plan for one portfolio. `nowMs` only resolves the
 *  self-expiring cutover window; everything else is pure data. */
export function buildPortfolioPlan(def: PortfolioDefinition, nowMs: number): PortfolioBuildPlan {
  switch (def.template) {
    case "momentum_tsm": return buildMomentumPlan(def, nowMs);
    case "meanrev_connors": return buildMeanRevPlan(def);
    default:
      throw new Error(`buildPortfolioPlan: unknown template '${(def as PortfolioDefinition).template}' (portfolio '${(def as PortfolioDefinition).id}')`);
  }
}
