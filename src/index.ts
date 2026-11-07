// ══════════════════════════════════════════════════════════════
//  🤖 Uncle Carl Trading Bot v8
//  Four live sleeves, two engines:
//    momentum_crypto / momentum_crypto_usdc — MomentumEngine (TSM) over Binance perps
//    momentum_stocks / meanrev_stocks       — portfolio engine over Alpaca (RW2),
//      from the registry definition or, failing that, the code's built-in one
// ══════════════════════════════════════════════════════════════

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { config, isTradingEnabled, assertRequiredConfig, credentialPresent, type AccountsSource } from "./config";
import { loadInstanceConfig, publicBaseUrl } from "./platform/instance";
import { resolveAccountsSource, resolveRegistryRuntimeAccounts } from "./platform/accounts/runtime";
import { alpacaRuntimeAuthHeaders, unlinkedAlpacaCredentials, unlinkedBinanceCredentials, type AlpacaRuntimeCredentials, type BinanceRuntimeCredentials } from "./executor/credentials";
import { OrderExecutor, type OrderExecutorOptions } from "./executor/order-executor";
import { getEnabledStocks, getEnabledCrypto } from "./config/symbols";
import { initDatabase } from "./db/database";
import { initHistoricalStore, closeHistoricalStore } from "./data/HistoricalStore";
import { AccountManager } from "./account/AccountManager";
import { DashboardServer } from "./dashboard/server";
import { attachSessionPersistence } from "./dashboard/auth-store";
import { createSessionStore } from "./dashboard/sessionPersistence";
import { TelegramReporter } from "./telegram/telegram-reporter";
import { BrokerSync, registerSleeveOwnedSymbols } from "./sync/BrokerSync";
import { buildBrokerSyncSources } from "./sync/brokerSyncSource";
import { DailyReporter } from "./reports/DailyReporter";
import { createLogger } from "./utils/logger";
import { VERSION_INFO } from "./utils/version";
import { MomentumEngine, type ExposureControlConfig, type MomentumStatePersistence, type MomentumPersistedState, type TrailMark } from "./strategies/momentum/MomentumEngine";
import { EQUITY_SEMANTICS, rebaseRiskState, RISK_STATE_VERSION, type EquitySemantics, type RiskState } from "./strategies/momentum/RiskGuard";
import { BinanceMomentumAdapter } from "./strategies/momentum/BinanceMomentumAdapter";
import { DEFAULT_TSM_CONFIG } from "./strategies/momentum/TimeSeriesMomentum";
import { BinanceExecutor } from "./executor/binance-executor";
import { isTransientBrokerFailure } from "./executor/transientFailure";
import { setRuntimeLinkedAccounts } from "./platform/accounts/runtimeLinks";
import { BinanceCoinMExecutor } from "./executor/binance-coinm-executor";
import { USDC_SYMBOL_MAP } from "./executor/binance/quoteAsset";
import { MOMENTUM_CRYPTO_UNIVERSE, RISK_PROFILES } from "./config/riskProfiles";
// Measured gross-backstop headroom (G diagnostic, applied 2026-10-07): the
// five *_MAX_GROSS_EXPOSURE_MULT below are slot×count × this factor — see
// src/config/grossCap.ts for the evidence and the rollback (set it to 1.0).
import { GROSS_CAP_HEADROOM } from "./config/grossCap";
import { insertActivity, getOpenTrades, getDB } from "./db/database";
import { liveBandReadings, type BandReading } from "./portfolio/scorecard";
import { eventBus, EVENTS } from "./utils/events";
import { SleeveGovernor } from "./governor/SleeveGovernor";
import { SwitchingAdapter } from "./governor/SwitchingAdapter";
import { FundingMonitor } from "./market/fundingMonitor";
import { TreasurySweep, type TreasurySweepConfig } from "./treasury/TreasurySweep";
import { createDecisionRecorder } from "./telemetry/decisionRecorder";
import { registerGrossCap } from "./ops/grossCaps";
import { CorporateActionsMonitor } from "./market/corporateActions";
import { heartbeats } from "./ops/heartbeat";
import { publishInstanceManifest } from "./ops/instanceManifest";
import { buildPortfolioPlan } from "./portfolios/factory";
import { resolvePortfolioWiring, restoreIncumbentRows, sleevesWithTwoManagers, fallbackDefinitions, PORTFOLIO_SLEEVES, type SleeveManager } from "./portfolio-engine/live/cutover";
import { buildPortfolioEngines, startPortfolioEngines } from "./portfolio-engine/live/wiring";
import { currentModelVersionId } from "./portfolio/modelVersions";
import { stopPriceFromEntry } from "./account/BinanceSleeveReconciler";
import { fapiClientOrderId } from "./executor/binance-executor";
import { builtinPortfolio, STOCK_SLEEVE_BUILTIN_DEFINITION } from "./portfolios/builtin";
import { initPlatformPortfolios, loadPlatformPortfolioDefinitions, markPendingPortfoliosActive, resolvePortfoliosSource } from "./portfolios/store";
import { portfolioEngineOwnedSymbols } from "./portfolios/validate";
import type { MomentumPortfolioPlan, StatePersistenceSpec, PortfolioDefinition } from "./portfolios/types";

const log = createLogger("Main");

// Crash-and-restart policy (2026-09-07, replaces the old log-and-continue
// handlers): a process that threw to the top or dropped a rejection on the
// floor is in an UNKNOWN state — an unknown-state process must not keep
// managing money. Log the stack, page on-call (ERROR_BURST → Telegram),
// give the log appenders/Telegram 500ms to flush, then exit(1); systemd
// (scripts/uncle-carl.service: Restart=always + RestartSec=10s) restarts a
// CLEAN process and the reconcilers (BrokerSync, AccountManager recovery)
// rebuild truth from the broker. RestartSec keeps a persistently-bad state
// from hot-looping; StartLimitBurst parks the unit as `failed` after 5/60s.
function crashAndRestart(kind: string, err: any): void {
  log.error(`${kind}: ${err?.stack ?? err?.message ?? err} — exiting 1 for a clean systemd restart`);
  const now = Date.now();
  try {
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "Main",
      message: `${kind}: ${err?.message ?? err} — process exiting for restart (crash-and-restart policy)`,
      count: 1, windowMs: 0, firstAt: now, lastAt: now,
    });
  } catch { /* paging must never block the exit path */ }
  setTimeout(() => process.exit(1), 500);
}
// Registered ONLY for the real entrypoint: tests import this module for
// fileStatePersistence & co., and an imported process-killing handler would
// let any stray rejection in an unrelated suite take down the test runner.
if (import.meta.main) {
  process.on("unhandledRejection", (reason: any) => crashAndRestart("unhandledRejection", reason));
  process.on("uncaughtException", (err: any) => crashAndRestart("uncaughtException", err));
}

/** Expectation-band readings for the SleeveGovernor: the live scorecard
 *  (trading.db + historical.db, both read-only), mapped per sleeve. */
export function governorBandReadings(): Record<string, BandReading> {
  return liveBandReadings(getDB());
}

/**
 * Tiny JSON-file store for a momentum engine's persisted state (atomic
 * tmp+rename). On-disk format: the v1 envelope `{ v, risk, trailMarks }`
 * (MomentumPersistedState). LEGACY files — a flat RiskState at top level,
 * the exact shape all four prod data/momentum-state-*.json files had before
 * the envelope (2026-08) — are detected by the absence of a `risk` object
 * and read as `{ risk: <flat object>, trailMarks: {} }`, so deploying over
 * old state loses nothing. The equity-base rebase and semantics migration
 * apply to the risk part exactly as they always did.
 */
export function fileStatePersistence(path: string, currentBase: number, legacyBase: number, equitySemantics: EquitySemantics): MomentumStatePersistence {
  return {
    load(): MomentumPersistedState | null {
      try {
        if (!existsSync(path)) return null;
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as any;
        // Envelope detection: v1 nests the risk state under `risk`; the
        // legacy flat form IS the risk state (it has no `risk` key).
        const isEnvelope = parsed && typeof parsed.risk === "object" && parsed.risk !== null;
        const loaded = (isEnvelope ? parsed.risk : parsed) as RiskState;
        const trailMarks: Record<string, TrailMark> =
          isEnvelope && parsed.trailMarks && typeof parsed.trailMarks === "object" ? parsed.trailMarks : {};
        const migrated: RiskState = {
          ...loaded,
          stateVersion: RISK_STATE_VERSION,
          equitySemantics,
          // Missing stock labels are only metadata migration. Missing crypto
          // labels describe the old all-assets metric and require re-anchoring.
          pendingSemanticReanchor: loaded.pendingSemanticReanchor === true || (loaded.equitySemantics === undefined
            ? equitySemantics === EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN
            : loaded.equitySemantics !== equitySemantics),
        };
        const previousBase = migrated.equityBase ?? legacyBase;
        let risk = migrated;
        if (previousBase !== currentBase) {
          log.warn(`risk state ${path}: equity base $${previousBase} → $${currentBase}`);
          risk = rebaseRiskState(migrated, previousBase, currentBase);
        }
        // trailMarks are price watermarks, not equity — an equity-base rebase
        // never scales them. SPLITS do: AccountManager's past-split handler
        // emits EVENTS.CORPORATE_ACTION_APPLIED and the tsmTrail sleeve's
        // engine divides its marks by the ratio (scaleMarksForSplit, wired
        // below in main()). Staleness/liveness/side validation is the
        // engine's job (restoreTrailMarks + the applyTrailStops prune).
        // entryMarks and the realised-pnl anchor ride the same envelope
        // (both were dropped here before 2026-10-03: the anchor so every
        // restart lost a loss-streak period, entryMarks so a time stop would
        // restart its clock). The engines validate what they restore.
        const entryMarks = isEnvelope && parsed.entryMarks && typeof parsed.entryMarks === "object" ? parsed.entryMarks as Record<string, number> : undefined;
        const riskAnchorAt = isEnvelope && typeof parsed.riskAnchorAt === "number" ? parsed.riskAnchorAt : undefined;
        // exposureFracs (RW4a exposure control) ride the same envelope: before
        // 2026-10-24 they were dropped here and in save(), so a restart made the
        // engine treat trimmed positions as full size and trim them again.
        const exposureFracs = isEnvelope && parsed.exposureFracs && typeof parsed.exposureFracs === "object" ? parsed.exposureFracs as Record<string, number> : undefined;
        return { v: 1, risk, trailMarks, ...(entryMarks ? { entryMarks } : {}), ...(riskAnchorAt !== undefined ? { riskAnchorAt } : {}),
          ...(exposureFracs ? { exposureFracs } : {}),
          ...(isEnvelope && typeof parsed.idleOverlayMonth === "string" ? { idleOverlayMonth: parsed.idleOverlayMonth } : {}),
          ...(isEnvelope && parsed.idleOverlayExitPending === true ? { idleOverlayExitPending: true } : {}),
          ...(isEnvelope && parsed.turtleDaily ? { turtleDaily: parsed.turtleDaily } : {}),
          ...(isEnvelope && typeof parsed.breakoutEntryAt === "number" ? { breakoutEntryAt: parsed.breakoutEntryAt } : {}),
          ...(isEnvelope && typeof parsed.breakoutBelowEntry === "boolean" ? { breakoutBelowEntry: parsed.breakoutBelowEntry } : {}),
          ...(isEnvelope && parsed.breakoutBySymbol && typeof parsed.breakoutBySymbol === "object" && !Array.isArray(parsed.breakoutBySymbol) ? { breakoutBySymbol: parsed.breakoutBySymbol } : {}),
          ...(isEnvelope && parsed.breakoutLongBySymbol && typeof parsed.breakoutLongBySymbol === "object" && !Array.isArray(parsed.breakoutLongBySymbol) ? { breakoutLongBySymbol: parsed.breakoutLongBySymbol } : {}) };
      } catch (e: any) {
        if (e?.code === "ENOENT") {
          // File vanished between existsSync and the read — same contract as
          // the fresh-install path above: quiet null, nothing to quarantine.
          log.warn(`momentum state load failed (${path}): ${e?.message ?? e}`);
          return null;
        }
        // The file EXISTS but is unreadable (torn write, full disk, garbage).
        // Silently starting fresh is risk-state amnesia: peakEquity re-anchors
        // at the BOTTOM of a drawdown and an active pause disappears — and a
        // warn never pages (the burst tracker only counts ERROR). Quarantine
        // the file (post-mortem evidence; the next boot won't re-fail on it)
        // and page ops. Still returns null: the engine must boot regardless.
        const quarantine = `${path}.corrupt-${Date.now()}`;
        try { renameSync(path, quarantine); } catch { /* best-effort */ }
        const msg = `momentum state file ${path} is corrupt (${e?.message ?? e}) — quarantined to ${quarantine}; engine starts with FRESH risk state (peak/pause/trail marks lost)`;
        log.error(msg);
        eventBus.emit(EVENTS.ERROR_BURST, {
          context: "StatePersistence", message: msg, count: 1,
          windowMs: 60_000, firstAt: Date.now() - 60_000, lastAt: Date.now(),
        });
        return null;
      }
    },
    save(state: MomentumPersistedState): void {
      try {
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify({
          v: 1,
          risk: { ...state.risk, stateVersion: RISK_STATE_VERSION, equityBase: currentBase, equitySemantics },
          trailMarks: state.trailMarks ?? {},
          entryMarks: state.entryMarks ?? {},
          ...(state.riskAnchorAt !== undefined ? { riskAnchorAt: state.riskAnchorAt } : {}),
          ...(state.exposureFracs && Object.keys(state.exposureFracs).length > 0 ? { exposureFracs: state.exposureFracs } : {}),
          ...(state.idleOverlayMonth ? { idleOverlayMonth: state.idleOverlayMonth } : {}),
          ...(state.idleOverlayExitPending ? { idleOverlayExitPending: true } : {}),
          ...(state.turtleDaily ? { turtleDaily: state.turtleDaily } : {}),
          ...(state.breakoutEntryAt !== undefined ? { breakoutEntryAt: state.breakoutEntryAt } : {}),
          ...(state.breakoutBelowEntry !== undefined ? { breakoutBelowEntry: state.breakoutBelowEntry } : {}),
          ...(state.breakoutBySymbol && Object.keys(state.breakoutBySymbol).length ? { breakoutBySymbol: state.breakoutBySymbol } : {}),
          ...(state.breakoutLongBySymbol && Object.keys(state.breakoutLongBySymbol).length ? { breakoutLongBySymbol: state.breakoutLongBySymbol } : {}),
        }));
        renameSync(tmp, path);
      } catch (e: any) {
        log.warn(`momentum state save failed (${path}): ${e?.message ?? e}`);
      }
    },
  };
}

/**
 * Truth-only mode (no open DB exposure) must never run the mutating startup
 * stop reconcile: that reconcile cancels any owned stop it finds once the
 * account reads flat, but a truth-only wallet's flatness is exactly the state
 * where that stop-cancel would fire — a diagnostic-only attachment must sync
 * balance/mark truth and nothing else. Close-only (real exposure left over
 * from the retired engine) keeps the default (mutating) reconcile unchanged.
 */
export function coinmSkipStartupStopReconcile(hasExposure: boolean): boolean {
  return !hasExposure;
}

/**
 * Startup banner truth (2026-08-09). Both always-on brokers are REQUIRED:
 * Alpaca runs momentum_stocks/meanrev AND feeds market data to the crypto
 * sleeves; Binance FAPI runs momentum_crypto. The old banner said
 * "ALL SYSTEMS OPERATIONAL" at 1/2 connected — a typo'd Binance key looked
 * like a healthy boot. Now any down required broker degrades the banner and
 * pages ops (ERROR_BURST), while the process stays alive so the OTHER
 * broker keeps managing its open positions (closes > opens, always).
 */
export function startupBrokerHealth(
  alpacaUp: boolean,
  binanceUp: boolean,
  // F4b: in registry mode a venue the owner deliberately left UNLINKED is
  // not "down" — no engines were built over it, so a degraded banner and an
  // ops page would be FALSE paging. Default = both required (env mode and
  // fully-linked registry mode: byte-identical to the old 2-arg behavior).
  required: { alpaca: boolean; binance: boolean } = { alpaca: true, binance: true },
): { operational: boolean; down: string[]; unlinked: string[] } {
  const down: string[] = [];
  const unlinked: string[] = [];
  if (required.alpaca) {
    if (!alpacaUp) down.push("alpaca");
  } else {
    unlinked.push("alpaca");
  }
  if (required.binance) {
    if (!binanceUp) down.push("binance");
  } else {
    unlinked.push("binance");
  }
  return { operational: down.length === 0, down, unlinked };
}

/** Daily TSM horizon of a momentum sleeve: a single return lookback or a blend
 *  (mean of the listed lookbacks — Hurst–Ooi–Pedersen 2017), with the MA
 *  trend-filter length, all in sessions. Used by momentum_crypto_usdc; the
 *  Alpaca momentum_stocks kernel that introduced it (2026-09-24) was retired on
 *  2026-11-07 with the stock incumbents (the sleeve runs on the portfolio
 *  engine). The name is kept for the tests and modules that import it. */
export type MomentumStocksDailyHorizon =
  | { lookbackDays: number; lookbackDaysList?: undefined; maLengthDays: number }
  | { lookbackDaysList: number[]; lookbackDays?: undefined; maLengthDays: number };

/** Longest return horizon of the daily kernel (sizes the candle history). */
export function dailyHorizonMaxLookback(h: MomentumStocksDailyHorizon): number {
  return h.lookbackDaysList ? Math.max(...h.lookbackDaysList) : h.lookbackDays;
}

/** Boot decision when a venue sleeve's executor cannot connect (preflight or
 *  init). No exposure → the sleeve stays off. Exposure + a configuration
 *  problem → refuse to boot: trading a misconfigured account is worse than
 *  not running. Exposure + a transient venue/network failure → attach the
 *  unconnected executor: the 60s sync's reconnector brings it up with backoff
 *  and the positions keep their exchange-native stops meanwhile. Refusing to
 *  boot there took every OTHER venue down too, leaving ALL exposure unmanaged
 *  (2026-10-06: Binance demo -1007 on every signed read, systemd restarting
 *  the whole bot every ~10s). `reason` null = init() failed right after a
 *  passed preflight — the venue, not the configuration. */
export function venueBootActionOnConnectFailure(
  hasExposure: boolean,
  reason: string | null,
): "stay_off" | "fail_boot" | "attach_degraded" {
  if (!hasExposure) return "stay_off";
  return reason === null || isTransientBrokerFailure(reason) ? "attach_degraded" : "fail_boot";
}

export const MOMENTUM_CRYPTO_MAX_LONGS = DEFAULT_TSM_CONFIG.maxLongs;
export const MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT = 0.375;
/** Model identity for momentum_crypto's persisted RiskState (one-shot peak
 *  and loss-streak re-anchor on change — MomentumEngineConfig.modelVersion).
 *  Bump it only when the wired model itself changes. Bumped 2026-10-23 for
 *  RW3's correlation brake OFF: the sleeve is flat, and the validated replay
 *  starts a fold with peak = equity and streak 0 (the live state carried a
 *  5,229 peak, a 6.5% drawdown the new model never produced, and 3 losses). */
export const MOMENTUM_CRYPTO_MODEL_VERSION = "vt35-corroff-2026-10-23";
/** SleeveGovernor evidence version: changing it restarts the evidence epoch.
 *  "v8-crypto-no-hard-sl" until 2026-10-23; closes taken with the 0.85
 *  correlation brake on are not evidence against the brake-off band. */
export const MOMENTUM_CRYPTO_EVIDENCE_VERSION = "v8.5-crypto-corroff";
export const MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT = MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT * MOMENTUM_CRYPTO_MAX_LONGS * GROSS_CAP_HEADROOM; // 1.725× (1.5× hasta 2026-10-07 — G gross-cap)

// ══════════════════════════════════════════════
// momentum_crypto_usdc DAILY kernel (U1 round 3-5, 2026-09-26).
//
// The hourly control (3×⅓, engine-default 14/30 TSM) was NOT validated:
// pure chain 4b403501… = +117.1% / Sharpe 0.60 / maxDD 71.2% / break-even
// 4.2 bps vs ~20 bps/side of MEASURED real cost — the kernel churned its
// edge away (871 trades/4.3y, 66% displacement closes). Five pre-registered
// hourly redesign candidates (vt35/vtcap/s4/mh, artifacts 65500e1e…/
// e37f99cf…/6ae8182d…/7143d84e…) all LOST to it. Rounds 3-5 replanted the
// design on DAILY bars (the momentum_stocks pattern): winner = d13-s5-
// blend-63-126-252, artifact 752767ae… (manifest experiments/momentum-
// crypto-usdc-daily-s5-pure-v1.json): +328.4% / Sharpe 1.03 / maxDD 52.4% /
// outerPSR 0.979 / foldPSR 0.92-0.74-0.91 / turnover 10.4×/yr /
// displacement 0 / cost curve FLAT (SR 1.02-1.06 across 0-30 bps slippage).
// NOT gate-certified — declared honestly: it fails maxDrawdown (52.4>45)
// and minExcessReturnVsBench (−24.4pp vs BTC B&H) and passes the other 15
// gates incl. stress/LOO/PSR; it beats the same-window hourly control
// (aaa0bcca…: 176.0% / 0.76 / 70.8%, 9 gates failed) on Sharpe AND maxDD
// AND break-even — the pre-registered wiring criterion. Axis shape: slots
// 3→5→6→8 gave Sharpe 0.61→1.03→0.85→0.66 (peak at 5, case-against of
// weak 6th-8th trends confirmed). REVERSION CRITERIA (60 live sessions):
// realized daily Sharpe below the artifact's expectation band, or realized
// turnover > 3× the artifact's 10.4×/yr → pre-register the next round; do
// NOT silently retune. Revert = restore {3, 1/3, hourly} + repoint
// LIVE_SLEEVE_MANIFESTS/scorecard at 4b403501… (both locked by
// scripts/liveSleeveConfigs.test.ts).
// ══════════════════════════════════════════════
export const MOMENTUM_USDC_MAX_LONGS = 5;
export const MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT = 0.2;
export const MOMENTUM_USDC_MAX_GROSS_EXPOSURE_MULT = MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT * MOMENTUM_USDC_MAX_LONGS * GROSS_CAP_HEADROOM; // 1.15× (1.0× hasta 2026-10-07 — G gross-cap; 8 bloqueos LTC/AVAX en prod)
/** Daily TSM blend (mean of 63/126/252-day returns, MA200 trend filter) —
 *  same shape as MOMENTUM_STOCKS_DAILY_HORIZON, validated per artifact
 *  752767ae… above. Always-on for this sleeve (no 1h fallback: the hourly
 *  kernel is the refuted design). */
export const MOMENTUM_USDC_DAILY_HORIZON: MomentumStocksDailyHorizon = { lookbackDaysList: [63, 126, 252], maLengthDays: 200 };
/** Vol-scaled trail + hard stop on daily sessions — verbatim the k8 spec of
 *  the winning candidate (and of momentum_stocks' k8-s8 kernel). The
 *  BinanceMomentumAdapter derives the stop PRICE from the fill and persists
 *  it on the row; profile fixed 4% stays the FALLBACK for stop-less rows
 *  (rowStopPct doctrine — see AGENTS.md "Stop-loss"). */
export const MOMENTUM_USDC_DAILY_VOL_STOP = { kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 } as const;
/** Model identity for momentum_crypto_usdc's persisted RiskState: the daily
 *  kernel must not inherit the hourly model's drawdown peak (one-shot
 *  re-anchor on change — MomentumEngineConfig.modelVersion).
 *  DELIBERATELY NOT bumped for RW4a (2026-10-23, the drawdown exposure
 *  control): the kernel that built the live peak/drawdown is the one that
 *  keeps running, and the control's input IS that RiskGuard drawdown — the
 *  validated replay at the live 13.8% dd scales the book to λ≈0.87 and keeps
 *  the soft-DD pause bound; a re-anchor would blind the control (dd → 0) and
 *  release the pause, which is the refuted no-soft-DD candidate's behaviour
 *  (RW §13.6). Bump only when the kernel itself changes. */
export const MOMENTUM_USDC_MODEL_VERSION = "daily-s5-blend3-2026-09-26";
/** Portfolio exposure control (RW4a c2, 2026-10-23 — MomentumEngineConfig
 *  .exposureControl; executed by BinanceMomentumAdapter.scalePosition):
 *  λ = 1 down to a 10% drawdown of the RiskGuard's decayed peak, then the
 *  line from 1 at 10% to 0 at 40%, floored at 0.25 (0.67 at 20%; the floor is
 *  reached at 32.5% — RW §13.6 erratum: this is what ran, replicated and is
 *  wired); each held position keeps a fraction f and is
 *  resized ×(λ/f) only when |λ − f| > 0.10 and the order ≥ 100 USD; new
 *  entries are sized at λ; add-backs obey every entry gate and the gross cap.
 *  Artifact 8892c1e9… (experiments/momentum-crypto-usdc-daily-s5-rw4a-xc-dd-
 *  pure-v1.json): Sharpe 1.038 vs 1.028 for the control on 1,410 common
 *  days, DD 51.9% vs 52.6%, PSR 0.978, 104 resizes (69 cuts, 35 add-backs),
 *  combined-book DD 13.8% — every §13.4 criterion, by a hair. Locked against
 *  the manifest by scripts/liveSleeveConfigs.test.ts. */
export const MOMENTUM_USDC_EXPOSURE_CONTROL: ExposureControlConfig = { drawdown: { startPct: 0.1, endPct: 0.4 }, minScale: 0.25, band: 0.1, minOrderUsd: 100 };
/** SleeveGovernor evidence version: changing it restarts the evidence epoch.
 *  "v8.3-usdc-daily" until 2026-10-23; closes taken without the exposure
 *  control are not evidence against the xc-dd band. */
export const MOMENTUM_USDC_EVIDENCE_VERSION = "v8.6-usdc-xc-dd";
/** One-shot MODEL_CUTOVER. History: 2026-09-27 re-underwrote the hourly
 *  model's UNI/NEAR/BCH under the daily kernel. ACTIVE 2026-10-06 (owner:
 *  "alinéalo"): UNI/USDC only — that cutover's simultaneous re-rank bought
 *  UNI where the model (re-ranking from its own book) does not hold it. The
 *  10-08 daily decision (00:00:15 UTC) closes it and re-ranks it as not
 *  held. Expires on its own: engines built after
 *  MOMENTUM_USDC_CUTOVER_EXPIRES_AT never get it. */
export const MOMENTUM_USDC_CUTOVER_AT = Date.UTC(2026, 9, 6, 5);
export const MOMENTUM_USDC_CUTOVER_SYMBOLS: string[] | undefined = ["UNI/USDC"];
export const MOMENTUM_USDC_CUTOVER_EXPIRES_AT = Date.UTC(2026, 9, 9);
export function momentumUsdcCutoverFor(nowMs: number): number | undefined {
  return nowMs < MOMENTUM_USDC_CUTOVER_EXPIRES_AT ? MOMENTUM_USDC_CUTOVER_AT : undefined;
}

/**
 * OPT-IN idle-cash treasury sweep for the shared Alpaca account (S3 research
 * 2026-09-27). null = OFF, byte-identical current behavior — the OWNER flips
 * it (a new component on the shared account's money path is never
 * self-activated; locked by src/treasury/TreasurySweep.test.ts).
 *
 * What it does when set (see src/treasury/TreasurySweep.ts for the full
 * contract): once per ET day ≥ 10:30 (after both stock sleeves' ≥09:35
 * passes) it buys `symbol` (a T-bill ETF) with the account cash EXCEEDING
 * `cashBufferPct` of equity; once per day ≥ 15:50 it sells just enough to
 * restore the buffer if the day's sleeve entries drew cash negative on
 * intraday margin. No sleeve ledger is ever touched (capital stays fixed per
 * sleeve — owner rule); the ETF is excluded from orphan adoption, qty-drift
 * and native stops (src/treasury/treasurySymbols.ts) and from every sleeve
 * universe (disjunction test). Orders carry deterministic uc8-treasury-*
 * client_order_ids (idempotent per ET day, broker-enforced).
 *
 * Evidence for the size of the prize (scripts/idle-cash-yield.ts, DTB3
 * overlay on the pure chains): +112 bps/yr CAGR on momentum_stocks' chain,
 * +170 bps/yr on meanrev's, no maxDD increase; prod idle cash last 30 days
 * averaged $40.8k (min $29.3k) on ~$105k equity. At today's ~4.08% DTB3
 * that is ≈ $1.2–1.6k/yr of pure carry.
 *
 * How to activate (owner): replace null with
 *   `{ symbol: "BOXX", cashBufferPct: 0.10 }`
 * BOXX, not SGOV/BIL: Alpaca paper does not credit dividends and SGOV/BIL
 * pay their yield as monthly distributions (flat raw price → ~0 carry in
 * paper); BOXX accrues in NAV (see src/treasury/treasurySymbols.ts).
 * and deploy. Revert = null. Symbol must be in TREASURY_SYMBOLS.
 */
// ACTIVATED 2026-09-28 by the owner ("Sí, procede con 1 y 2"): BOXX, 10%
// buffer. First sweep the same ET day after the first daily stocks pass was
// verified (momentum_stocks cutover + 6 entries, native stops placed).
export const ALPACA_TREASURY_SWEEP: TreasurySweepConfig | null = { symbol: "BOXX", cashBufferPct: 0.10 };

// ══════════════════════════════════════════════════════════════
// Platform portfolios (F3a, 2026-10-04 — docs/platform/PLAN.md).
//
// Each sleeve's hand-written wiring, extracted VERBATIM into a pure
// exported plan function — the line-by-line review reference for the
// portfolio factory. src/portfolios/parity.test.ts deep-equals each
// function below against buildPortfolioPlan(builtinPortfolio(id), now),
// and main() consumes the FACTORY plans. The engine-config literals
// deliberately stay in THIS file: AGENTS.md's rg falsifiers and
// scripts/liveSleeveConfigs.test.ts lock src/index.ts's source text
// (slotHysteresis ×2, volTarget ×1, the meanrev volStop ×1, the
// sharpeGate literal on every momentum sleeve, …).
// ══════════════════════════════════════════════════════════════

/** momentum_crypto — 8 perps, 1h bars, 60min rebalance, 24/7. */
export function momentumCryptoPortfolioPlan(): MomentumPortfolioPlan {
  return {
    template: "momentum_tsm",
    portfolioId: "momentum_crypto",
    governorRegistration: { sleeve: "momentum_crypto", evidenceVersion: MOMENTUM_CRYPTO_EVIDENCE_VERSION },
    adapter: { kind: "binance_usdm", options: { breakoutShortSymbols: [...MOMENTUM_CRYPTO_UNIVERSE] } },
    loggerContext: "Momentum:crypto",
    engineConfig: {
      mode: "time-series",
      // Universe lives in riskProfiles.ts as an exported constant, mirrored
      // into config/symbols.ts (price stream/dashboard) and BrokerSync's
      // sleeve ownership set — riskProfiles.disjoint.test.ts locks all three.
      universe: MOMENTUM_CRYPTO_UNIVERSE,
      rebalanceMinutes: 60,
      heartbeatName: "momentum:crypto", // engine.start() registers it (60min ×2 grace)
      historyBars: 754, // 31d of 1h bars + warmup margin
      // notionalPctPerSlot=0.375 ("x1.5 ≈ half-Kelly") came from a 2026-07-12
      // exposure sweep on the OLD pre-nested backtest-momentum-wf; its headline
      // numbers (geo +148%/yr etc.) never passed the rigorous protocol and must
      // not be cited as evidence. The credible artifact is the nested-purged
      // walk-forward (data/backtests/aaed66e…, 648 trades): folds
      // +9.4/+554.3/−32.1%, stitched +386.4%, Sharpe 0.98, maxDD 49.2% — one
      // fold IS negative and DD fails the gates. Sizing kept unchanged pending
      // a validated re-run; sized on the sleeve ledger, broker leverage stays 2x.
      notionalPctPerSlot: MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT,
      // maxLongs made EXPLICIT (was an implicit DEFAULT_TSM_CONFIG inherit) so
      // this sleeve's gross-exposure cap is declared contiguously, not emergent
      // — see the MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT block above.
      tsm: { barMinutes: 60, maxLongs: MOMENTUM_CRYPTO_MAX_LONGS },
      // RW7 owner rule (§18.3–18.5, artifact 2deab5da): no regime/Sharpe
      // entry filters or stop cooldown; risk only sizes, never pauses.
      regime: { barMinutes: 60, enabled: false },
      scorer: { barMinutes: 60 },
      // RW6 owner rule: 5-day holds, checked at decisions; keep the RiskState key.
      timeStop: { maxHoldHours: 120 },
      allowSameTickReentry: true,
      // RW10 §21–21.1, artifact 4aca1803: System 1 shorts, independent of vt35 longs.
      breakoutShort: { symbols: [...MOMENTUM_CRYPTO_UNIVERSE], entryDays: 20, exitDays: 10, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 },
      // tsmTrail intentionally ABSENT on crypto — the 2026-07-12 sweep found it
      // amputates fat-tail trend rides. (That sweep's "+148→+178%/yr" claim for
      // enhanced TSM is pre-nested machinery, not evidence — see above.)
      // volTarget ("vt-35") wired 2026-09-23 — owner-delegated decision after a
      // 3-judge quorum (AUDITS.md 2026-09-20/23). Evidence: PURE 3/3-fold chain
      // (momentum-crypto-vt35-pure-v1, artifact 8b673e8a…, same dataHash/asOf
      // as the incumbent's pure chain a04c88d3…): 233.5% / Sharpe 0.99 /
      // maxDD 36.9% / outerPSR 0.976 / 1210 trades, passes 16/17 gates —
      // fails ONLY maxDisplacementShare (0.61), which the incumbent fails too
      // (0.60; a kernel property, orthogonal to sizing). Incumbent pure chain:
      // 386.4% / 0.98 / DD 49.2% / PSR 0.971, fails maxDD+stressDD+looDD.
      // DECLARED COST: ~150pp less stitched return over 4.2y for 12pp less DD
      // and ~60% fewer soft-DD blocks. Wired while the sleeve was paused at 0
      // positions (clean A/B). Breakers (0.10/0.20) untouched. PRE-REGISTERED
      // REVERSION: revert if, over the first 60 live days, realized sleeve DD
      // exceeds the prior 60 days' DD, or if the median volTargetScale sits at
      // a clamp (0.33 or 1.5) on >70% of ticks (scale degenerate → no-op or
      // lever-up). Verify what's wired: rg -n 'volTarget: \{' src/index.ts → 1.
      volTarget: { annualizedPct: 35, lookbackBars: 720, minScale: 0.33, maxScale: 1.5 },
      risk: { equitySemantics: EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN, mode: "sizeOnly" },
      // One-shot model-cutover re-anchor (2026-09-26, owner: "resuelve el
      // punto 2" — the sleeve had not opened a position since ~09-10). vt-35
      // was wired on 09-23 while its persisted RiskState still carried the
      // PREVIOUS fixed-size model's peak ($6,165): live soft-DD 13.5% → every
      // entry blocked. The validated vt-35 replay over the same dates
      // (experiments/momentum-crypto-2026w-control-pure-v1.json, artifact
      // a5101316…, window to 2026-09-26) is NOT paused: +32.3% since 07-18
      // (live +14.1%), DD 5.8% from its own recent peak, 30 trades in
      // September. The lockout was inherited from another model, not produced
      // by this one. The first boot with this key re-anchors the peak to live
      // equity once and clears the inherited SOFT pause (hard pauses survive);
      // the soft/hard-DD rule itself stays exactly as validated.
      modelVersion: MOMENTUM_CRYPTO_MODEL_VERSION,
      maxGrossExposureMult: MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT,
      // %ADV capacity check, OBSERVE-ONLY (2026-09-26): logs+counts entries
      // that would take >1% of 20-day ADV$; blocks nothing. Irrelevant at
      // today's size (megacap/major-perp universes vs ~$7k slots) — this is
      // the audit trail for flipping to "enforce" before real capital. Same
      // literal on every wired momentum sleeve. See MomentumEngineConfig.capacityGuard.
      capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
    },
    statePersistence: { path: "data/momentum-state-crypto.json", currentBase: 5_000, legacyBase: 10_000, equitySemantics: EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN },
    scheduler: { kind: "engine-start" },
  };
}

/** momentum_crypto_usdc — USDⓈ-M USDC-margined perps, disjoint 13-symbol
 *  universe (BASE/USDC), DAILY TSM blend (63/126/252-day returns / MA200,
 *  slotHysteresis, 5 slots × 0.20, vol stops k8 {8,20,5,30}), 2x leverage.
 *  Design provenance + reversion criteria: MOMENTUM_USDC_DAILY_HORIZON's
 *  block comment above (artifact 752767ae…, U1 rounds 3-5). One decision
 *  per UTC day: engine.start()'s scheduler aligns to the bar boundary
 *  (nextAlignedTickDelayMs with rebalanceMinutes 1440 = epoch midnight UTC)
 *  + 15s, on the venue's own CLOSED 1d klines (the adapter's
 *  candleTimeframe "1Day"; klinesToOHLCV drops the forming bar, and all 13
 *  USDC contracts carry ≥300 closed dailies — verified 2026-09-26). The
 *  sim's history proxy (USDT-perp mainnet bars, pre-2023 depth) is a
 *  declared environmental difference locked in liveSleeveConfigs.test.ts. */
export function momentumUsdcPortfolioPlan(): MomentumPortfolioPlan {
  return {
    template: "momentum_tsm",
    portfolioId: "momentum_crypto_usdc",
    governorRegistration: { sleeve: "momentum_crypto_usdc", evidenceVersion: MOMENTUM_USDC_EVIDENCE_VERSION },
    adapter: { kind: "binance_usdm", options: { accountId: "momentum_crypto_usdc", quoteAsset: "USDC", candleTimeframe: "1Day", breakoutShortSymbols: Object.keys(USDC_SYMBOL_MAP) } },
    loggerContext: "Momentum:usdc",
    engineConfig: {
      mode: "time-series",
      universe: Object.keys(USDC_SYMBOL_MAP),
      rebalanceMinutes: 1440, // one decision per UTC day at 00:00 + 15s
      heartbeatName: "momentum:crypto_usdc",
      // Replay's own history formula: max(lookback, MA) + 11 daily bars.
      historyBars: Math.max(dailyHorizonMaxLookback(MOMENTUM_USDC_DAILY_HORIZON), MOMENTUM_USDC_DAILY_HORIZON.maLengthDays) + 11,
      notionalPctPerSlot: MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT, // 5 slots × 0.20 = 1.0× gross
      // slotHysteresis: part of the validated daily kernel (752767ae…) —
      // unlike hourly crypto, where the axis was REFUTED (displacement
      // churn is a COST problem the daily cadence doesn't have).
      tsm: {
        barMinutes: 1440,
        maxLongs: MOMENTUM_USDC_MAX_LONGS,
        slotHysteresis: true,
        lookbackDaysList: [...MOMENTUM_USDC_DAILY_HORIZON.lookbackDaysList!],
        maLengthDays: MOMENTUM_USDC_DAILY_HORIZON.maLengthDays,
      },
      regime: { barMinutes: 1440 },
      scorer: { barMinutes: 1440 },
      // RW6: first daily decision at/after 120h; no same-pass re-entry.
      timeStop: { maxHoldHours: 120 },
      // Owner approved 2026-11-05, RW §19.9 / Q6 §6 (57430944): independent of λ.
      breakoutShort: { symbols: Object.keys(USDC_SYMBOL_MAP), entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 },
      tsmTrail: { ...MOMENTUM_USDC_DAILY_VOL_STOP },
      // Vol-scaled HARD stop: the engine passes stopLossPct on every open;
      // BinanceMomentumAdapter derives the stop PRICE from the real fill,
      // installs the broker-native STOP_MARKET there and persists it on
      // the row (rowStopPct: row first, profile 4% fallback).
      volStop: { ...MOMENTUM_USDC_DAILY_VOL_STOP },
      sharpeGate: { lookbackDays: 30, minSharpe: 0 },
      risk: { equitySemantics: EQUITY_SEMANTICS.BINANCE_USDC_MARGIN, mode: "sizeOnly" },
      maxGrossExposureMult: MOMENTUM_USDC_MAX_GROSS_EXPOSURE_MULT,
      // RW4a c2 (2026-10-23): the drawdown exposure control resizes the OPEN
      // book — see MOMENTUM_USDC_EXPOSURE_CONTROL. RW7 removes risk pauses
      // only; regime, Sharpe and cooldown stay (full nobrakes failed N).
      exposureControl: { ...MOMENTUM_USDC_EXPOSURE_CONTROL, drawdown: { ...MOMENTUM_USDC_EXPOSURE_CONTROL.drawdown! } },
      // %ADV capacity check, observe-only — see the momentum_crypto block.
      capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
      // New model → own risk state, and the hourly model's positions are
      // re-underwritten at the daily kernel's slot size (see constants).
      // NOT re-anchored for RW4a — see the constant's docstring.
      modelVersion: MOMENTUM_USDC_MODEL_VERSION,
      ...(momentumUsdcCutoverFor(Date.now()) !== undefined
        ? { reunderwriteBefore: momentumUsdcCutoverFor(Date.now()), ...(MOMENTUM_USDC_CUTOVER_SYMBOLS ? { reunderwriteSymbols: [...MOMENTUM_USDC_CUTOVER_SYMBOLS] } : {}) }
        : {}),
    },
    statePersistence: { path: "data/momentum-state-usdc.json", currentBase: 5_000, legacyBase: 5_000, equitySemantics: EQUITY_SEMANTICS.BINANCE_USDC_MARGIN },
    scheduler: { kind: "engine-start" },
  };
}

// ── factory consumption helpers (main() uses the FACTORY plans; the pure
// functions above are the parity reference) ─────────────────────────────
// F3b: PORTFOLIOS_SOURCE=code|db (default code). main() resolves the source
// once at boot; db mode swaps WHERE the definitions come from — nothing
// else. With untouched seeded rows the db source builds byte-identical
// engines (locked by src/portfolios/store.test.ts).
let dbPortfolioDefs: Map<string, PortfolioDefinition> | null = null;
/** RW2: sleeves whose incumbent engine is replaced by a LIVE portfolio engine this boot
 *  (src/portfolio-engine/live/cutover.ts). main() fills it BEFORE any incumbent is built, and only
 *  with sleeves whose portfolio engine was actually constructed. */
let portfolioCutoverSleeves: ReadonlySet<string> = new Set();
function portfolioDefinition(id: string): PortfolioDefinition {
  if (dbPortfolioDefs) {
    const def = dbPortfolioDefs.get(id);
    if (!def) throw new Error(`PORTFOLIOS_SOURCE=db: no platform_portfolios row for sleeve '${id}' (seed missing or row deleted) — refusing to guess a money-path config`);
    return def;
  }
  return builtinPortfolio(id);
}
/** code source: always true (env flags remain the only gates, unchanged).
 *  db source: the row's enabled flag (owner action via F3d), ANDed with the
 *  same env gates main() already applies. */
function portfolioEnabled(id: string): boolean {
  if (portfolioCutoverSleeves.has(id)) return false; // a live portfolio engine manages it: the incumbent runs NO entries or exits
  return dbPortfolioDefs ? dbPortfolioDefs.get(id)?.enabled === true : true;
}
function momentumPlanFor(id: string): MomentumPortfolioPlan {
  const plan = buildPortfolioPlan(portfolioDefinition(id), Date.now());
  if (plan.template !== "momentum_tsm") throw new Error(`portfolio '${id}': expected a momentum_tsm plan`);
  // Dashboard exposure chips (display only); MomentumEngine caps × current equity.
  registerGrossCap(id, plan.engineConfig.maxGrossExposureMult, "equity");
  return plan;
}
function persistenceFor(s: StatePersistenceSpec): MomentumStatePersistence {
  return fileStatePersistence(s.path, s.currentBase, s.legacyBase, s.equitySemantics);
}

async function main() {
  // P0 fix (2026-07-27): SIGINT/SIGTERM handlers are registered as the FIRST
  // action of main(), not after every subsystem is up. Previously a signal
  // received anywhere during startup (e.g. a stuck dashboard.start() bind,
  // see below) fell through to Node's default handling — no chance to stop
  // already-connected broker sockets, BrokerSync's 30s DB-writer loop, or send
  // the Telegram "offline" notice. Every resource below is assigned into
  // `handles` right after construction (instead of relying on `const` scoping)
  // so shutdown() can reach whatever startup managed to build, however far it
  // got before the signal arrived.
  let shuttingDown = false;
  const handles: {
    accountManager?: AccountManager;
    brokerSync?: BrokerSync;
    dashboard?: DashboardServer;
    telegram?: TelegramReporter;
    dailyReporter?: DailyReporter;
    governor?: SleeveGovernor;
    fundingMonitor?: FundingMonitor;
    corporateActions?: CorporateActionsMonitor;
    cryptoEngine?: MomentumEngine;
    usdcEngine?: MomentumEngine;
    treasuryInterval?: ReturnType<typeof setInterval>;
    stopPortfolioEngines?: () => void;
  } = {};

  const shutdown = async () => {
    log.warn("Shutting down...");
    heartbeats.stop(); // stop the checker first so teardown doesn't self-page
    handles.cryptoEngine?.stop();
    handles.usdcEngine?.stop();
    if (handles.treasuryInterval) clearInterval(handles.treasuryInterval);
    handles.stopPortfolioEngines?.();
    handles.fundingMonitor?.stop();
    handles.corporateActions?.stop();
    handles.governor?.stop();
    await handles.accountManager?.stop();
    handles.brokerSync?.stop();
    closeHistoricalStore();
    handles.dailyReporter?.stop();
    await handles.dashboard?.stop();
    handles.telegram?.stop();
    await handles.telegram?.send("🔴 Uncle Carl offline");
    log.info("Goodbye! 👋");
    process.exit(0);
  };
  const handleSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`${sig} received`);
    shutdown().catch((e: any) => {
      log.error(`shutdown failed: ${e?.message ?? e}`);
      process.exit(1);
    });
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  console.log(`
╔══════════════════════════════════════════════════╗
║  🤖 Uncle Carl Trading Bot v8                    ║
║  crypto: Momentum TSM, Binance perps 24/7        ║
║  stocks: portfolio engine, Alpaca RTH            ║
╚══════════════════════════════════════════════════╝
  `);

  // Runtime version identity (2026-07-27 zombie-process fix): unambiguous,
  // grep-able proof of which commit this process is running, logged before
  // anything else can fail. Also served on /healthz — see health.ts.
  log.info(`🔖 Running commit ${VERSION_INFO.commit}${VERSION_INFO.dirty ? " [DIRTY worktree]" : ""} — started ${new Date(VERSION_INFO.startedAt).toISOString()}`);

  // Minimum-credential gate (the enforcement AGENTS.md cites). Lives in
  // src/config (assertRequiredConfig) and is invoked HERE at bot startup —
  // never at config import, so tests/research scripts that import the config
  // don't need a populated .env. Throwing lands in main()'s fatal handler
  // (exit 1) BEFORE any subsystem starts: with a missing key this process
  // could neither open nor manage anything on that broker anyway, so
  // refusing to boot never violates the closes-keep-running invariant.
  // F4a: where do the runtime broker credentials come from? env (default,
  // byte-identical) or the broker-accounts registry. An unknown value
  // ABORTS here, before any subsystem. In registry mode the Alpaca/Binance
  // .env keys are not required (the registry supplies them) — COIN-M stays
  // env-configured and keeps its key requirement.
  const accountsSource: AccountsSource = resolveAccountsSource(loadInstanceConfig().accountsSource);
  assertRequiredConfig(process.env, undefined, accountsSource);

  log.info(`Mode: ${config.mode.toUpperCase()}`);
  if (accountsSource === "env") log.info(`Alpaca Paper: ${config.alpaca.paper}`); // registry mode logs its venue summary after resolution below
  if (!isTradingEnabled()) {
    // Maintenance kill-switch (src/config/index.ts): this host is explicitly
    // configured to not OPEN positions. Everything else — stop-loss loop,
    // broker syncs, reconciliation, closes/exits, dashboard — runs unchanged.
    log.warn("🚫 TRADING_ENABLED=false — maintenance kill-switch: new positions will NOT be opened (closes, stop-loss and syncs stay fully active)");
  }

  // 1. Database
  log.info("Initializing database...");
  initDatabase("./data/trading.db"); // initDatabase mkdirs data/
  initHistoricalStore("./data/historical.db");

  // F3b: platform portfolio registry. PORTFOLIOS_SOURCE=code (default) is
  // byte-identical to the built-in wiring; =db builds the engines from the
  // ENABLED platform_portfolios rows (table created here, seeded once and
  // idempotently from builtin.ts — INSERT OR IGNORE never overwrites an
  // owner-edited row). An unknown value aborts startup before any engine.
  const portfoliosSource = resolvePortfoliosSource(process.env.PORTFOLIOS_SOURCE);
  initPlatformPortfolios(getDB());
  if (portfoliosSource === "db") {
    const defs = loadPlatformPortfolioDefinitions(getDB());
    dbPortfolioDefs = new Map(defs.map((d) => [d.id, d]));
    // The rows just read ARE what this boot runs: their `pending_restart`
    // label (owner edit, cutover script, un-archive) is applied now.
    const applied = markPendingPortfoliosActive(getDB());
    log.info(`📁 Portfolio source: db (${defs.length} platform_portfolios definitions${applied.length > 0 ? `; applied pending edits: ${applied.join(", ")}` : ""})`);
  } else {
    log.info("📁 Portfolio source: code (built-in definitions)");
  }
  // BrokerSync ownership boundary (B-4): the live portfolio engines' symbols beyond the static
  // sleeve universes (RW8's SH) are theirs to adopt — registered BEFORE BrokerSync starts below.
  // The registry's live definitions AND the code's built-in stock definitions (the fallback
  // index.ts runs when the registry gives a stock sleeve no live engine, 8c): in the normal
  // case both name the same model, so the union adds nothing; in a fallback or code-source boot
  // it is the fallback engine's book that must not be filed under alpaca_main.
  {
    const owned = portfolioEngineOwnedSymbols([
      ...(dbPortfolioDefs ? [...dbPortfolioDefs.values()] : []),
      ...Object.values(STOCK_SLEEVE_BUILTIN_DEFINITION).map(id => builtinPortfolio(id)),
    ]);
    registerSleeveOwnedSymbols("alpaca", owned.alpaca);
    registerSleeveOwnedSymbols("binance", owned.binance);
    if (owned.alpaca.length + owned.binance.length > 0) log.info(`📁 Portfolio-engine symbols registered as sleeve-owned: alpaca [${owned.alpaca.join(", ")}] binance [${owned.binance.join(", ")}]`);
  }

  // 1b. F4a — runtime broker credentials. Registry mode resolves the two
  // venues (alpaca; binance = both USDⓈ-M pools of one account) from
  // platform_broker_accounts: explicit link (instance.json runtimeAccounts /
  // RUNTIME_ACCOUNT_*) or the single verified account of the provider.
  // Fail-closed: a live Alpaca account without the arming ceremony or a
  // live Binance account (mainnet deferred) does NOT link. An unlinked
  // venue boots WITHOUT an executor-with-credentials (F4b) — unless it has
  // open DB rows, which would be abandoned exposure: refuse to boot.
  // A linked account whose credentials can't be opened (missing/wrong master
  // key) throws here (clear message, exit 1); with nothing to open — a fresh
  // installation before its first account — no master key is needed.
  let alpacaVenueLinked = true;  // env mode: both venues come from .env, as today
  let binanceVenueLinked = true;
  let registryAlpacaCreds: AlpacaRuntimeCredentials | null = null;
  let registryBinanceCreds: BinanceRuntimeCredentials | null = null;
  const executorOptions: OrderExecutorOptions = {};
  if (accountsSource === "registry") {
    const resolution = resolveRegistryRuntimeAccounts();
    if (resolution.alpaca.linked) {
      registryAlpacaCreds = resolution.alpaca.credentials;
      const a = resolution.alpaca;
      log.info(`🔐 Accounts source: registry — alpaca ← '${a.account.id}' (${a.account.environment}, ${a.account.authType}${a.autoLinked ? ", auto-linked: only verified alpaca account" : ""})`);
      if (a.autoLinked) insertActivity(null, "system", `accounts registry: alpaca auto-linked to '${a.account.id}' (only verified alpaca account)`);
    } else {
      alpacaVenueLinked = false;
      log.warn(`🔐 Accounts source: registry — alpaca UNLINKED: ${resolution.alpaca.reason}`);
      insertActivity(null, "circuit", `accounts registry: alpaca venue UNLINKED — stock engines not built (${resolution.alpaca.reason})`);
    }
    if (resolution.binance.linked) {
      registryBinanceCreds = resolution.binance.credentials;
      const b = resolution.binance;
      log.info(`🔐 Accounts source: registry — binance ← '${b.account.id}' (${b.account.environment}${b.autoLinked ? ", auto-linked: only verified binance account" : ""})`);
      if (b.autoLinked) insertActivity(null, "system", `accounts registry: binance auto-linked to '${b.account.id}' (only verified binance_usdm account)`);
    } else {
      binanceVenueLinked = false;
      log.warn(`🔐 Accounts source: registry — binance UNLINKED: ${resolution.binance.reason}`);
      insertActivity(null, "circuit", `accounts registry: binance venue UNLINKED — crypto engines not built (${resolution.binance.reason})`);
    }
    // Unlinked venues get EXPLICIT empty credentials: the executors then
    // refuse to connect ("keys not configured") and NEVER fall back to any
    // keys still sitting in .env — unlinked must mean not trading.
    executorOptions.alpacaCredentials = registryAlpacaCreds ?? unlinkedAlpacaCredentials();
    executorOptions.binanceCredentials = registryBinanceCreds ?? unlinkedBinanceCredentials();
    // The dashboard must not let the owner remove what this process signs with.
    setRuntimeLinkedAccounts([
      resolution.alpaca.linked ? resolution.alpaca.account.id : null,
      resolution.binance.linked ? resolution.binance.account.id : null,
    ]);

    // Abandoned-exposure guard (same doctrine as the USDC/COIN-M blocks
    // below): an unlinked venue with OPEN DB rows means positions nobody
    // would manage — refusing to boot is safer than booting blind.
    if (!alpacaVenueLinked) {
      const open = getOpenTrades("momentum_stocks").length + getOpenTrades("meanrev_stocks").length;
      if (open > 0) throw new Error(`ACCOUNTS_SOURCE=registry: the alpaca venue is UNLINKED but ${open} open Alpaca DB rows exist — link an account (runtimeAccounts.alpaca / RUNTIME_ACCOUNT_ALPACA) or set ACCOUNTS_SOURCE=env. Refusing to boot with abandoned exposure.`);
    }
    if (!binanceVenueLinked) {
      const open = getOpenTrades("momentum_crypto").length + getOpenTrades("momentum_crypto_usdc").length;
      if (open > 0) throw new Error(`ACCOUNTS_SOURCE=registry: the binance venue is UNLINKED but ${open} open Binance DB rows exist — link an account (runtimeAccounts.binance / RUNTIME_ACCOUNT_BINANCE) or set ACCOUNTS_SOURCE=env. Refusing to boot with abandoned exposure.`);
    }
  }

  // 2. Account Manager (state bookkeeper: sync, hard SL, dashboard state).
  // Built + initialized FIRST so its executor's Alpaca/Binance clients are the
  // ONE connection per venue that BrokerSync reuses via the shim (STACK B merge).
  log.info("Initializing account manager...");
  const accountManager = new AccountManager(new OrderExecutor(executorOptions));
  handles.accountManager = accountManager;
  await accountManager.init();

  // 3. Broker Sync (keeps SQLite in sync with brokers every 30s). Consumes the
  // LIVE executor instances through buildBrokerSyncSources — no second broker
  // client. MUST come after accountManager.init() so executor.alpaca/.binance
  // are constructed and connected.
  log.info("Starting broker sync service...");
  const brokerSync = new BrokerSync(
    buildBrokerSyncSources(accountManager.executor.alpaca, accountManager.executor.binance),
  );
  handles.brokerSync = brokerSync;
  brokerSync.start();

  // 3b. Instance manifest + broker-account swap guard (src/ops/
  // instanceManifest.ts): materializes the EFFECTIVE config (value + origin
  // per money flag) and fingerprints the account behind each broker,
  // persisting the fingerprints in sync_state. A mismatch vs the stored
  // fingerprint means this process points at a DIFFERENT account than the
  // one this DB's ledger belongs to → page + audit row + persisted RiskEngine
  // HALT (new opens blocked; closes/stops/syncs unaffected), lifted only by
  // BROKER_ACCOUNT_ROTATION_ACK=<fingerprint>. First boot (no stored
  // fingerprint — prod today) records and never blocks. Runs AFTER
  // accountManager.init() so the Alpaca identity comes from the already-
  // connected executor (its getAccount()); deliberately non-fatal — an
  // unverifiable identity is logged, never a reason to refuse to manage
  // existing positions.
  log.info("Publishing instance manifest...");
  try {
    await publishInstanceManifest({
      getAlpacaAccountId: async () => {
        const acct = await accountManager.executor.alpaca.getAccount();
        return acct?.account_number ?? acct?.id ?? null;
      },
    });
  } catch (e: any) {
    log.error(`instance manifest publish failed (non-fatal): ${e?.message ?? e}`);
  }

  // 4b. Optional certified sleeve (momentum_crypto_usdc) — OFF by default
  // (MOMENTUM_USDC_ENABLED). The
  // executor runs its own read-only preflight BEFORE init(): refuses
  // anything but a testnet/demo host, one-way position mode, single-asset
  // margin mode, an existing balance row, and TRADING exchangeInfo filters.
  // A failure hard-fails ONLY that sleeve — never the rest of the bot — and
  // is surfaced on the activity timeline for the operator. Attached to
  // accountManager BEFORE accountManager.start() so the staggered +20s/+40s
  // sync offsets (src/account/AccountManager.ts) apply from the first tick.
  //
  // Activation safety (2026-07-19): the feature flag only gates whether the
  // ENGINE opens NEW positions — never whether existing DB exposure gets
  // reconciled/closed. If the flag is OFF but a prior run left open trades
  // for this sleeve, the executor is connected anyway in CLOSE-ONLY mode
  // (AccountManager.attach*Executor({live:false})): reconciliation keeps
  // running, the engine below stays unbuilt, and the sleeve's card shows
  // "close-only", never a fake "LIVE". If a connect is REQUIRED (known
  // exposure exists) and preflight/init fails, startup FAILS LOUDLY —
  // silently booting with abandoned, unmonitored exposure is worse than not
  // booting at all.
  let usdcExecutor: BinanceExecutor | null = null;
  let usdcLive = false; // only true when MOMENTUM_USDC_ENABLED=true (gates engine construction below)
  {
    const enabled = process.env.MOMENTUM_USDC_ENABLED === "true";
    usdcLive = enabled;
    const hasExposure = getOpenTrades("momentum_crypto_usdc").length > 0;
    if ((enabled || hasExposure) && !binanceVenueLinked) {
      // Registry mode, binance unlinked: hasExposure already aborted above,
      // so this is flag-on-with-no-exposure — the sleeve simply stays off.
      log.warn("momentum_crypto_usdc: binance venue UNLINKED (ACCOUNTS_SOURCE=registry) — sleeve stays OFF");
    } else if (enabled || hasExposure) {
      // The USDC pool signs with the SAME account as the USDT pool — in
      // registry mode that is the linked binance account's credentials.
      const candidate = new BinanceExecutor({
        quoteAsset: "USDC",
        ...(registryBinanceCreds ? { credentials: registryBinanceCreds } : {}),
      });
      const pf = await candidate.preflight();
      // Exposure + a transient venue failure: boot anyway with the executor
      // attached unconnected (venueBootActionOnConnectFailure docstring).
      const attachDegraded = (what: string) => {
        usdcExecutor = candidate;
        accountManager.attachUsdcExecutor(candidate, { live: enabled });
        const msg = `momentum_crypto_usdc: ${what} — Binance unreachable at boot with open positions: booting anyway; they keep their exchange stops and the executor reconnects in the background (30s→5min backoff)`;
        log.error(`🚫 ${msg}`);
        insertActivity(null, "circuit", msg);
      };
      if (!pf.ok) {
        const action = venueBootActionOnConnectFailure(hasExposure, pf.reason ?? "");
        if (action === "fail_boot") throw new Error(`momentum_crypto_usdc: open DB exposure exists but preflight FAILED (${pf.reason}) — refusing to boot with abandoned exposure`);
        if (action === "attach_degraded") attachDegraded(`preflight FAILED (${pf.reason})`);
        else {
          log.error(`🚫 momentum_crypto_usdc preflight FAILED — sleeve stays OFF: ${pf.reason}`);
          insertActivity(null, "circuit", `momentum_crypto_usdc preflight failed: ${pf.reason}`);
        }
      } else if (!(await candidate.init())) {
        if (venueBootActionOnConnectFailure(hasExposure, null) === "attach_degraded") attachDegraded("executor.init() failed after preflight passed");
        else {
          log.error("🚫 momentum_crypto_usdc init failed after preflight passed — sleeve stays OFF");
          insertActivity(null, "circuit", "momentum_crypto_usdc init failed after preflight passed");
        }
      } else {
        usdcExecutor = candidate;
        accountManager.attachUsdcExecutor(candidate, { live: enabled });
        if (enabled) log.info("✅ momentum_crypto_usdc preflight passed — executor connected");
        else {
          log.warn("⚠️ momentum_crypto_usdc: flag OFF but open DB exposure exists — CLOSE-ONLY mode (reconcile/close only, no new entries)");
          insertActivity(null, "circuit", "momentum_crypto_usdc: flag OFF with open exposure — running close-only");
        }
      }
    } else {
      log.info("momentum_crypto_usdc disabled (MOMENTUM_USDC_ENABLED=false, no exposure)");
    }
  }

  // 4c. COIN-M (DAPI) wallet — ACCOUNT truth only. The momentum_btc ENGINE
  // (BinanceCoinMMomentumAdapter, opt-in by MOMENTUM_COINM_ENABLED) was
  // retired by the owner on 2026-11-07 (audit C, FLAG-DEAD: switched off since
  // 2026-09-21, no return path by design): nothing in this process can OPEN a
  // COIN-M position any more, and the flag is no longer read. What stays is
  // the wallet: it holds BTC collateral, its equity is part of the owner's
  // total (binance_coinm_main series, dashboard/Telegram broker truth), and a
  // position left over from the engine's era would still be reconciled and
  // closed by AccountManager.syncBinanceCoinM. Mandate 2026-07-19: "DAPI truth
  // always exists independently of the trading flag."
  //   · open momentum_btc DB rows → CLOSE-ONLY (reconcile/close, never open);
  //   · none (prod today) → TRUTH-ONLY (read-only equity sync; see
  //     attachCoinmExecutor and syncBinanceCoinM's truth-only guard for why
  //     reconciliation must NOT run there: the account's own real DAPI
  //     position would look like an "orphan" and be emergency-closed).
  // F4b: COIN-M stays .env-configured (not in the accounts registry). A fresh
  // registry-mode installation has NO COIN-M keys — attaching the DAPI-truth
  // executor would only produce a spurious preflight ERROR on every boot.
  // With no exposure and no keys there is no truth to sync: skip quietly.
  // Same presence rule as assertRequiredConfig: .env.example's "your_*"
  // placeholders count as missing (a fresh install copies them verbatim).
  {
    const hasExposure = getOpenTrades("momentum_btc").length > 0;
    const coinmKeysPresent =
      (credentialPresent(process.env.BINANCE_COINM_API_KEY) || credentialPresent(process.env.BINANCE_FUTURES_API_KEY)) &&
      (credentialPresent(process.env.BINANCE_COINM_SECRET_KEY) || credentialPresent(process.env.BINANCE_FUTURES_SECRET_KEY));
    if (!hasExposure && !coinmKeysPresent) {
      log.info("momentum_btc/DAPI: no COIN-M keys configured — truth sync not started (no exposure)");
    } else {
    const candidate = new BinanceCoinMExecutor();
    const pf = await candidate.preflight();
    if (!pf.ok) {
      if (hasExposure) throw new Error(`momentum_btc: open DB exposure exists but preflight FAILED (${pf.reason}) — refusing to boot with abandoned exposure`);
      // Loud, not silent: DAPI truth stays unavailable and the consolidated
      // total fails closed once it's ever been applicable (portfolio/truth.ts
      // isMainSeriesApplicable) — never crashes the whole bot for a
      // read-only diagnostic wallet the operator can fix and restart for.
      log.error(`🚫 momentum_btc/DAPI preflight FAILED — binance_coinm_main truth unavailable: ${pf.reason}`);
      insertActivity(null, "circuit", `momentum_btc/DAPI preflight failed: ${pf.reason}`);
    } else if (!(await candidate.init({ skipStartupStopReconcile: coinmSkipStartupStopReconcile(hasExposure) }))) {
      if (hasExposure) throw new Error("momentum_btc: open DB exposure exists but executor.init() failed — refusing to boot with abandoned exposure");
      log.error("🚫 momentum_btc/DAPI init failed after preflight passed — binance_coinm_main truth unavailable");
      insertActivity(null, "circuit", "momentum_btc/DAPI init failed after preflight passed");
    } else {
      if (hasExposure) {
        accountManager.attachCoinmExecutor(candidate, { live: false });
        log.warn("⚠️ momentum_btc: open DB exposure exists but the COIN-M engine was retired (2026-11-07) — CLOSE-ONLY mode (reconcile/close only, no new entries)");
        insertActivity(null, "circuit", "momentum_btc: open exposure with no engine — running close-only");
      } else {
        accountManager.attachCoinmExecutor(candidate, { truthOnly: true });
        log.info("ℹ️ momentum_btc: engine retired (2026-11-07), no exposure — DAPI truth-only sync active (binance_coinm_main)");
      }
    }
    }
  }

  // 5. Dashboard + Prometheus
  log.info("Starting dashboard...");
  // Sessions survive restarts (platform_sessions, sha256(sid) only): before
  // 2026-10-11 every deploy logged every browser out, "stay signed in"
  // included. Fail-soft: without the store they just live in memory.
  try {
    const r = attachSessionPersistence(createSessionStore(getDB()));
    log.info(`🔐 Dashboard sessions: ${r.restored} restored from disk${r.expired ? `, ${r.expired} expired removed` : ""}`);
  } catch (e: any) {
    log.warn(`Dashboard session persistence unavailable (${e.message}) — sessions end with this process`);
  }
  const dashboard = new DashboardServer(accountManager);
  const botNowEngines: Array<() => import("./dashboard/botNow").BotNowRuntime> = [];
  dashboard.botNowRuntime = () => botNowEngines.map(read => read());
  handles.dashboard = dashboard;
  try {
    await dashboard.start();
  } catch (e: any) {
    // P0 fix: a bind failure (almost always EADDRINUSE) means another
    // instance already holds this port. Abort loudly instead of hanging —
    // main()'s top-level .catch() below exits with a non-zero code, and
    // systemd's StartLimitBurst=5 prevents a restart loop.
    log.error(`❌ Dashboard failed to bind port ${loadInstanceConfig().dashboard.port}: ${e?.message ?? e} — another instance is likely already running. Aborting startup.`);
    throw e;
  }

  // 6. Telegram — wire account data
  log.info("Initializing Telegram reporter...");
  const telegram = new TelegramReporter();
  handles.telegram = telegram;
  telegram.getAccountSummaries = () => accountManager.getAccountSummaries();
  telegram.getConsolidatedState = () => accountManager.getConsolidatedState();
  await telegram.init();
  // Symmetric to the "🔴 Uncle Carl offline" the shutdown path sends to the
  // USER chat: until 2026-09-11 the user saw every offline and never an
  // online (the startup banner is ops-only by the 2026-08-03 mandate). A
  // watchdog restart loop that day produced five reds and zero greens. This
  // is the user's own bot changing state, same audience as the red.
  await telegram.send("🟢 Uncle Carl online");

  // Memory diagnostics — log RSS vs heap every 30min.
  setInterval(() => {
    const m = process.memoryUsage();
    log.info(`🧠 mem rss=${(m.rss / 1e6).toFixed(0)} heap=${(m.heapUsed / 1e6).toFixed(0)} ext=${(m.external / 1e6).toFixed(0)} MB`);
  }, 30 * 60_000);

  // 7. Daily Reporter
  log.info("Starting daily reporter...");
  const dailyReporter = new DailyReporter();
  handles.dailyReporter = dailyReporter;
  dailyReporter.getAccountSummaries = () => accountManager.getAccountSummaries();
  dailyReporter.sendTelegramDigest = () => telegram.sendDaily();
  dailyReporter.start();

  // 8b. RW2 — the portfolio engine (docs/reports/RW-reescritura-rentable.md §4, src/portfolio-engine/README.md).
  // Registry definitions with template "portfolio" (PORTFOLIOS_SOURCE=db) put the engine on an
  // EXISTING sleeve: observer = computes and persists, sends nothing, whatever manages the sleeve
  // trades on; live = it manages the sleeve (on crypto it REPLACES the incumbent MomentumEngine:
  // portfolioEnabled() above is false for the sleeve), adopts its rows and takes them out of the
  // stop machinery. Engines are CONSTRUCTED here, before any incumbent: a definition that is
  // misconfigured or cannot be built does not run live, and pages (never two engines on one sleeve).
  //   crypto: the incumbent keeps the sleeve; a rollback hands the PORTFOLIO rows back to it below.
  //   stocks (8c): there is NO incumbent since 2026-11-07 — the fallback is the code's built-in
  //   definition of the same live model; failing that, the sleeve has no manager and this pages.
  const portfolioAlert = (context: string, message: string) => {
    log.error(`🚨 ${context}: ${message}`);
    insertActivity(null, "circuit", `${context}: ${message}`);
    eventBus.emit(EVENTS.ERROR_BURST, { context, message, count: 1, windowMs: 0, firstAt: Date.now(), lastAt: Date.now() });
  };
  // An UNLINKED venue (no account linked yet — a fresh install — already a warning and a circuit
  // activity in step 1b) makes every definition on it unrunnable: a known state, not a new incident,
  // so it is a warning here, not a page. A live sleeve that stops deciding is paged by guardian G2.
  const portfolioNotice = (context: string, message: string) => {
    log.warn(`⚠️ ${context}: ${message}`);
    insertActivity(null, "circuit", `${context}: ${message}`);
  };
  const peWiring_venueReady = {
    alpaca: alpacaVenueLinked ? null : "alpaca venue UNLINKED",
    binance_usdm: binanceVenueLinked ? null : "binance venue UNLINKED",
    binance_usdc: usdcExecutor && usdcLive ? null : "momentum_crypto_usdc executor not attached (MOMENTUM_USDC_ENABLED=true and a connected USDC pool required)",
  };
  const peSources = {
    alpacaExecutor: alpacaVenueLinked ? accountManager.executor.alpaca : null,
    binanceTransports: {
      binance_usdm: binanceVenueLinked ? accountManager.executor.binance.venueTransport : null,
      binance_usdc: usdcExecutor ? usdcExecutor.venueTransport : null,
    },
  };
  const peWiring = resolvePortfolioWiring({
    defs: dbPortfolioDefs ? [...dbPortfolioDefs.values()] : [],
    venueReady: peWiring_venueReady,
  });
  const peBuilt = buildPortfolioEngines(peWiring, peSources);
  const venueUnlinked = (definitionId: string): boolean => {
    const venue = (dbPortfolioDefs?.get(definitionId)?.params as { venue?: string } | undefined)?.venue;
    return venue != null && (peWiring_venueReady as Record<string, string | null>)[venue] != null;
  };
  for (const p of peBuilt.problems) {
    (venueUnlinked(p.definitionId) ? portfolioNotice : portfolioAlert)("PortfolioCutover", `definition '${p.definitionId}' (${p.sleeve ?? "?"}) ${p.severity === "live_refused" ? "NOT live" : "ignored"}: ${p.message}`);
  }

  // 8c. Stock sleeves run ONLY on the portfolio engine (owner, 2026-11-07, audit C: the TSM/Connors
  // incumbents and their Alpaca adapter were deleted). When the registry gives a stock sleeve no
  // live engine — no enabled definition (code source, deleted/disabled/archived row), a refused one
  // (bad hash, unknown version, overlap…) or one that could not be built — the sleeve falls back to
  // the code's BUILT-IN definition of the same current live model (src/portfolios/builtin.ts,
  // pe_<sleeve>, hash-locked to its manifest) and pages: the model that trades is never silently
  // another one, and the book is never left without a manager because of a registry problem. The
  // registry's own definitions for that sleeve (including observers of it) are not started in a
  // fallback boot — exactly one engine per sleeve. If even the built-in cannot run the sleeve has
  // NO MANAGER: with the alpaca venue UNLINKED (no account linked — reported at step 1b; a fresh
  // install, which also has no Alpaca rows: 1b refuses to boot with abandoned exposure) that is a
  // warning; a fallback refused with the venue linked pages on EVERY boot. Either way guardian G2
  // (decision liveness, scripts/guardian.ts) pages hourly a live sleeve that stops deciding; open
  // rows are reported by restoreIncumbentRows below, never adopted by a stop machinery that no
  // longer exists. Enforced: src/index.portfolioCutover.test.ts, src/portfolio-engine/live/cutover.test.ts,
  // src/portfolios/builtinPortfolioEngine.test.ts, scripts/public-export/fresh-install.sh (0 ERROR lines).
  const fallbackPlans: typeof peWiring.live = [];
  for (const [sleeve, builtinId] of Object.entries(STOCK_SLEEVE_BUILTIN_DEFINITION)) {
    if (peBuilt.live.has(sleeve)) continue;
    const why = peBuilt.problems.filter(p => p.sleeve === sleeve).map(p => `${p.definitionId}: ${p.message}`).join("; ")
      || (dbPortfolioDefs ? "no enabled live portfolio definition for the sleeve in platform_portfolios" : "PORTFOLIOS_SOURCE=code");
    if (!alpacaVenueLinked) {
      portfolioNotice("PortfolioCutover", `${sleeve}: NO MANAGER — alpaca venue UNLINKED, so neither the registry definition nor the built-in fallback can run (${why}); nobody decides for this sleeve until an Alpaca account is linked (a live sleeve that stops deciding is paged by guardian G2)`);
      continue;
    }
    const builtin = builtinPortfolio(builtinId);
    const fbVersion = (builtin.params as { strategyVersion?: string }).strategyVersion ?? builtinId;
    if (dbPortfolioDefs) portfolioAlert("PortfolioCutover", `${sleeve}: the registry gives no live portfolio engine (${why}) — falling back to the code's built-in definition '${builtinId}' (${fbVersion}); fix platform_portfolios (scripts/portfolio-engine-cutover.ts) so the registry and the code agree`);
    else log.info(`📁 ${sleeve}: PORTFOLIOS_SOURCE=code — built from the built-in portfolio-engine definition '${builtinId}' (${fbVersion})`);
    const fbWiring = resolvePortfolioWiring({ defs: fallbackDefinitions(dbPortfolioDefs ? [...dbPortfolioDefs.values()] : [], sleeve, builtin), venueReady: peWiring_venueReady });
    const fbBuilt = buildPortfolioEngines({ observers: [], live: fbWiring.live.filter(p => p.params.sleeve === sleeve), problems: fbWiring.problems.filter(p => p.sleeve === sleeve) }, peSources);
    const engine = fbBuilt.live.get(sleeve);
    if (!engine) {
      portfolioAlert("PortfolioCutover", `${sleeve}: NO MANAGER — the built-in fallback '${builtinId}' could not run either (${fbBuilt.problems.map(p => p.message).join("; ") || "unknown"}); nobody decides for this sleeve and its open rows carry no stop — guardian G2 will keep paging until the code or the venue is fixed`);
      continue;
    }
    peBuilt.live.set(sleeve, engine);
    fallbackPlans.push(...fbWiring.live.filter(p => p.params.sleeve === sleeve));
    // One engine per sleeve: the registry's observers of a sleeve in fallback are not started.
    const dropped = peBuilt.observers.filter(e => e.accountId === sleeve);
    if (dropped.length > 0) {
      peBuilt.observers = peBuilt.observers.filter(e => e.accountId !== sleeve);
      portfolioAlert("PortfolioCutover", `${sleeve}: ${dropped.length} observer definition(s) of the sleeve not started this boot (the built-in fallback is its only engine)`);
    }
  }
  portfolioCutoverSleeves = new Set(peBuilt.live.keys());
  accountManager.setPortfolioEngineSleeves(portfolioCutoverSleeves);
  // Resolve actual ownership BEFORE starting adoption / stop loops.
  log.info("Starting account manager...");
  await accountManager.start();
  const livePlans = [...peWiring.live, ...fallbackPlans];
  for (const plan of livePlans) {
    const id = plan.params.sleeve ?? plan.portfolioId;
    if (!peBuilt.live.has(id)) continue;
    botNowEngines.push(() => ({ id, engine: "portfolio", maxGrossX: "maxGross" in plan.params.strategy ? plan.params.strategy.maxGross : null,
      cadenceMinutes: 1440, strategy: plan.params.strategy, version: plan.params.strategyVersion }));
  }
  for (const sleeve of portfolioCutoverSleeves) {
    const fromFallback = fallbackPlans.some(p => p.params.sleeve === sleeve);
    log.warn(`🔀 ${sleeve}: LIVE on the portfolio engine${fromFallback ? " (built-in fallback definition)" : ""}${PORTFOLIO_SLEEVES[sleeve]?.incumbentStrategy ? " — the incumbent engine is not built (no entries, no exits)" : ""}`);
    insertActivity(sleeve, "system", `${sleeve} managed by the portfolio engine (live${fromFallback ? ", built-in fallback definition" : ""})`);
  }
  {
    // Only the crypto sleeves still have an incumbent MomentumEngine to fall back to; a stock sleeve
    // without a live portfolio engine has NO manager (paged above and by restoreIncumbentRows).
    const incumbentExpected: Record<string, boolean> = {
      momentum_crypto: binanceVenueLinked && portfolioEnabled("momentum_crypto"),
      momentum_crypto_usdc: !!usdcExecutor && usdcLive && portfolioEnabled("momentum_crypto_usdc"),
    };
    const managers: Record<string, SleeveManager> = {};
    for (const sleeve of Object.keys(PORTFOLIO_SLEEVES)) {
      managers[sleeve] = portfolioCutoverSleeves.has(sleeve) ? "portfolio_live" : incumbentExpected[sleeve] ? "incumbent" : "none";
    }
    await restoreIncumbentRows(managers, {
      alert: portfolioAlert,
      // Binance arms its native stop at open only; a handed-back row needs one.
      armStop: async (sleeve, row) => {
        const exec = sleeve === "momentum_crypto_usdc" ? usdcExecutor : sleeve === "momentum_crypto" ? accountManager.executor.binance : null;
        if (!exec) return true;
        const stopPct = (RISK_PROFILES as Record<string, { stopLossPct: number }>)[sleeve]?.stopLossPct ?? 4;
        return exec.placeStopMarketClose(row.symbol, "buy", stopPriceFromEntry("buy", row.entryPrice, stopPct), row.quantity, fapiClientOrderId(`handback:${row.id}`));
      },
    });
  }

  // 9. Momentum engines — the two Binance sleeves (the Alpaca momentum/meanrev
  // incumbents were retired 2026-11-07; the stock sleeves run on the portfolio
  // engine, 8b/8c above).
  // Per-sleeve logger contexts: the MomentumEngines used to share ONE
  // anonymous "[Momentum]" context, so a line like
  // "BLOCKED: soft drawdown 10.1% — paused 24h" could not be attributed
  // without reading all four risk-state files (2026-08-02, live incident of
  // exactly that). The context also shapes ERROR_BURST dedupe and the
  // Telegram page header — a burst now names the sleeve that produced it.
  const sleeveLogger = (context: string) => {
    const l = createLogger(context);
    return {
      info: (m: string) => l.info(m),
      warn: (m: string) => l.warn(m),
      error: (m: string) => l.error(m),
    };
  };

  // Sleeve governor — RECOMMENDS, never switches. Owner rules: a sleeve is
  // never parked in shadow, paused indefinitely or switched off (2026-08-08
  // "siempre live, no demo"; 2026-09-26 a failing strategy is REDESIGNED so
  // it keeps trading). Since 2026-11-07 there is no shadow mode in the code
  // at all (owner, audit C): the governor only keeps each sleeve's evidence
  // epoch and emits RECOMMEND_REDESIGN when a matured live sleeve sits below
  // its validated expectation band. Risk control that KEEPS a sleeve live is
  // RiskGuard's sizing (declared per sleeve in SLEEVE_POLICY). Live momentum
  // adapters are wrapped in SwitchingAdapter for the RiskEngine veto and the
  // TRADING_ENABLED backstop on every opening order.
  // The governor judges each sleeve against its validated expectation band
  // (owner, 2026-10-04): the same scorecard the digest and the "POR DEBAJO"
  // page use, read-only, once per daily pass.
  const governor = new SleeveGovernor({ bandReadings: governorBandReadings });
  handles.governor = governor;
  // RW2: a sleeve managed by the LIVE portfolio engine has no incumbent branch below to register it,
  // so it is registered here — the watchdog is never blind to a live book. Its evidence version is the
  // model version the engine stamps on its rows: the epoch restarts at the cutover (closes of the
  // retired model are not evidence against the new band), and the band it is judged against is the
  // version's own artifact (scorecard ← modelVersions).
  for (const sleeve of portfolioCutoverSleeves) {
    governor.register({ sleeve, evidenceVersion: currentModelVersionId(sleeve) ?? `portfolio:${sleeve}` });
  }

  // 9a. Crypto sleeve — 8 perps, 1h bars, 60min rebalance, 24/7.
  // F3b: in db mode a disabled/archived row (owner action) means the
  // engine is NOT built — AccountManager's 15s stop-loss loop and
  // BrokerSync keep managing any open rows for the account regardless.
  let cryptoEngine: MomentumEngine | null = null;
  if (!binanceVenueLinked) {
    // F4b: registry mode without a linked binance account — no executor
    // credentials exist, so no engine. The unlinked state was already
    // logged + surfaced on the activity timeline above.
    log.warn("momentum_crypto: binance venue UNLINKED (ACCOUNTS_SOURCE=registry) — engine NOT built");
  } else if (!portfolioEnabled("momentum_crypto")) {
    log.warn("momentum_crypto: platform_portfolios row disabled or cut over to the portfolio engine — engine NOT built (stop-loss loop and broker syncs keep running)");
  } else {
    governor.register({
      sleeve: "momentum_crypto",
      evidenceVersion: MOMENTUM_CRYPTO_EVIDENCE_VERSION,
    });
    const cryptoPlan = momentumPlanFor("momentum_crypto");
    if (cryptoPlan.adapter.kind !== "binance_usdm") throw new Error("momentum_crypto plan: expected a binance_usdm adapter");
    const cryptoAdapter = new SwitchingAdapter(
      "momentum_crypto",
      new BinanceMomentumAdapter(
        accountManager.executor.alpaca,
        accountManager.executor.binance,
        cryptoPlan.adapter.options,
      ),
    );
    cryptoEngine = new MomentumEngine(
      // Engine config + provenance: momentumCryptoPortfolioPlan() above —
      // the factory plan is parity-locked to it (src/portfolios/parity.test.ts).
      cryptoPlan.engineConfig,
      cryptoAdapter,
      sleeveLogger(cryptoPlan.loggerContext),
      persistenceFor(cryptoPlan.statePersistence),
    );
    cryptoEngine.setDecisionRecorder(createDecisionRecorder(), "momentum_crypto");
    botNowEngines.push(() => ({ id: "momentum_crypto", engine: "momentum", maxGrossX: cryptoPlan.engineConfig.maxGrossExposureMult ?? null,
      cadenceMinutes: cryptoPlan.engineConfig.rebalanceMinutes!, statePath: cryptoPlan.statePersistence.path, risk: cryptoEngine!.getRiskState() }));
    handles.cryptoEngine = cryptoEngine;
    await cryptoEngine.start();
    log.info("🚀 momentum_crypto engine started (60min rebalance, 24/7)");
  }

  // 9a-usdc. momentum_crypto_usdc — USDⓈ-M USDC-margined perps, disjoint
  // 13-symbol universe (BASE/USDC), DAILY TSM blend (63/126/252-day returns
  // / MA200, slotHysteresis, 5 slots × 0.20, vol stops k8 {8,20,5,30}), 2x
  // leverage. Wired only when the preflight above attached an executor.
  // Design provenance + reversion criteria: MOMENTUM_USDC_DAILY_HORIZON's
  // block comment above main() (artifact 752767ae…, U1 rounds 3-5). One
  // decision per UTC day: engine.start()'s scheduler aligns to the bar
  // boundary (nextAlignedTickDelayMs with rebalanceMinutes 1440 = epoch
  // midnight UTC) + 15s, on the venue's own CLOSED 1d klines (the adapter's
  // candleTimeframe "1Day"; klinesToOHLCV drops the forming bar, and all 13
  // USDC contracts carry ≥300 closed dailies — verified 2026-09-26). The
  // sim's history proxy (USDT-perp mainnet bars, pre-2023 depth) is a
  // declared environmental difference locked in liveSleeveConfigs.test.ts.
  let usdcEngine: MomentumEngine | null = null;
  if (usdcExecutor && usdcLive && portfolioEnabled("momentum_crypto_usdc")) {
    governor.register({
      sleeve: "momentum_crypto_usdc",
      evidenceVersion: MOMENTUM_USDC_EVIDENCE_VERSION,
    });
    const usdcPlan = momentumPlanFor("momentum_crypto_usdc");
    if (usdcPlan.adapter.kind !== "binance_usdm") throw new Error("momentum_crypto_usdc plan: expected a binance_usdm adapter");
    const usdcAdapter = new SwitchingAdapter(
      "momentum_crypto_usdc",
      new BinanceMomentumAdapter(
        accountManager.executor.alpaca,
        usdcExecutor,
        usdcPlan.adapter.options,
      ),
    );
    usdcEngine = new MomentumEngine(
      // Engine config + provenance: momentumUsdcPortfolioPlan() above —
      // the factory plan is parity-locked to it (src/portfolios/parity.test.ts).
      usdcPlan.engineConfig,
      usdcAdapter,
      sleeveLogger(usdcPlan.loggerContext),
      persistenceFor(usdcPlan.statePersistence),
    );
    usdcEngine.setDecisionRecorder(createDecisionRecorder(), "momentum_crypto_usdc");
    botNowEngines.push(() => ({ id: "momentum_crypto_usdc", engine: "momentum", maxGrossX: usdcPlan.engineConfig.maxGrossExposureMult ?? null,
      cadenceMinutes: usdcPlan.engineConfig.rebalanceMinutes!, statePath: usdcPlan.statePersistence.path, risk: usdcEngine!.getRiskState() }));
    handles.usdcEngine = usdcEngine;
    await usdcEngine.start();
    log.info("🚀 momentum_crypto_usdc engine started (daily rebalance 00:00 UTC, 24/7, max 5 positions)");
  }

  // 9c-pe. Portfolio engines start LAST among the sleeve engines. Last line of defence first: a sleeve
  // whose portfolio engine is live must not have an incumbent (impossible by construction — the
  // cutover set gates every incumbent above, and the stock sleeves have none); if it ever happens
  // the portfolio engine yields.
  {
    const incumbentBuilt = (sleeve: string): boolean => ({
      momentum_crypto: cryptoEngine !== null, momentum_crypto_usdc: usdcEngine !== null,
    } as Record<string, boolean>)[sleeve] ?? false;
    for (const sleeve of sleevesWithTwoManagers(peBuilt.live.keys(), incumbentBuilt)) {
      portfolioAlert("PortfolioCutover", `${sleeve}: TWO managers (incumbent built AND portfolio engine live) — the portfolio engine is NOT started; the incumbent manages the sleeve`);
      peBuilt.live.delete(sleeve);
    }
    const peEngines = [...peBuilt.live.values(), ...peBuilt.observers];
    if (peEngines.length > 0) {
      handles.stopPortfolioEngines = startPortfolioEngines(peEngines);
      log.info(`🧮 portfolio engines started: ${[...peBuilt.live.keys()].map(s => `${s} LIVE`).concat(peBuilt.observers.map(e => `${e.accountId} observer`)).join(", ")}`);
    }
  }

  // 9d. Treasury sweep — OPT-IN (ALPACA_TREASURY_SWEEP above, default null =
  // this whole block is dead code). One 60s driver; the two once-per-ET-day
  // windows live inside TreasurySweep.tick(). Buys are additionally gated on
  // the TRADING_ENABLED maintenance kill-switch (cover sells keep running —
  // closes > opens, always).
  if (ALPACA_TREASURY_SWEEP && !alpacaVenueLinked) {
    // F4b: no linked Alpaca account — a sweep would only log a broker error
    // every 60s against an executor that refused to connect.
    log.warn("Alpaca treasury sweep NOT started: alpaca venue UNLINKED (ACCOUNTS_SOURCE=registry)");
  } else if (ALPACA_TREASURY_SWEEP) {
    const treasury = new TreasurySweep(ALPACA_TREASURY_SWEEP, accountManager.executor.alpaca, isTradingEnabled);
    handles.treasuryInterval = setInterval(() => {
      treasury.tick().catch((e: any) => log.error(`treasury tick failed: ${e?.message ?? e}`));
    }, 60_000);
    log.info(`🏦 Alpaca treasury sweep ENABLED: ${ALPACA_TREASURY_SWEEP.symbol}, buffer ${(ALPACA_TREASURY_SWEEP.cashBufferPct * 100).toFixed(0)}% of equity (sweep ≥10:30 ET, cover ≥15:50 ET)`);
  } else {
    log.info("Alpaca treasury sweep disabled (ALPACA_TREASURY_SWEEP=null — owner opt-in)");
  }

  // Funding monitor — mainnet premiumIndex every 15min. Monitoring/dashboard
  // only: the P90 entry-filter overlay FAILED its backtest gate (skipping
  // high-funding entries costs the 2021-style momentum bursts); isCrashRisky
  // stays observational.
  const fundingMonitor = new FundingMonitor();
  handles.fundingMonitor = fundingMonitor;
  fundingMonitor.start();

  // Corporate-actions monitor — daily pre-open (≥08:00 ET, after Alpaca's
  // BOD job) advisory check for held Alpaca stock symbols. Upcoming events
  // page (informational, never an auto-close); past events invalidate the
  // rewritten adjusted-bar caches, apply split ratios to open rows (once,
  // DB-ledger-gated) and force the native-stop re-verification. Fail-open:
  // the per-status stop reconcile in AccountManager needs no feed at all.
  const corporateActions = new CorporateActionsMonitor({
    getHeldStockSymbols: () => accountManager.getHeldAlpacaStockSymbols(),
    onEvent: (ev, phase) => accountManager.applyCorporateAction(ev, phase),
    // F4a: registry mode uses the SAME credentials the executors sign with;
    // env mode (no auth key) keeps reading config.alpaca.* — identical.
    ...(registryAlpacaCreds
      ? { auth: { dataUrl: registryAlpacaCreds.dataUrl, headers: alpacaRuntimeAuthHeaders(registryAlpacaCreds) } }
      : {}),
  });
  handles.corporateActions = corporateActions;
  corporateActions.start();

  // Governor: evaluate at boot + every 24h.
  governor.start();

  // Surface engine risk states on the dashboard (circuits card / summaries).
  accountManager.setEngineStates(() => {
    const toCircuit = (s: Readonly<RiskState>) => ({
      paused: s.pausedUntil > Date.now(),
      reason: s.pauseReason || "",
      resumeAt: s.pausedUntil || 0,
    });
    const states: Record<string, ReturnType<typeof toCircuit>> = {};
    if (cryptoEngine) states.momentum_crypto = toCircuit(cryptoEngine.getRiskState());
    if (usdcEngine) states.momentum_crypto_usdc = toCircuit(usdcEngine.getRiskState());
    return states;
  });

  // Universal loop-liveness watchdog — every registered engine/index loop beats
  // on a successful iteration; a silent death pages Telegram (ERROR_BURST) and
  // surfaces on /healthz/full. Started last, after all loops are wired.
  heartbeats.start();

  // FIX (P1, tightened 2026-08-09): the banner used to claim "ALL SYSTEMS
  // OPERATIONAL" whenever ≥1 broker connected — a typo'd key on ONE broker
  // looked healthy. Both always-on brokers are required (startupBrokerHealth
  // above); a down one degrades the banner AND pages ops via ERROR_BURST
  // (TelegramReporter routes it to the operator chat, never the user chat).
  // The process deliberately stays ALIVE: the other broker's stop-loss loop,
  // syncs and closes must keep running.
  const health = startupBrokerHealth(
    accountManager.executor.alpaca.isConnected(),
    accountManager.executor.binance.isConnected(),
    // F4b: a deliberately-unlinked registry venue is not "down" — nothing
    // was built over it; paging ops for it would be a false page.
    { alpaca: alpacaVenueLinked, binance: binanceVenueLinked },
  );
  const requiredBrokers = (alpacaVenueLinked ? 1 : 0) + (binanceVenueLinked ? 1 : 0);
  const connectedBrokers = requiredBrokers - health.down.length;
  log.info("═══════════════════════════════════════");
  if (health.unlinked.length > 0) {
    log.warn(`🔗 Unlinked venue(s) — no engines built for: ${health.unlinked.join(", ")} (ACCOUNTS_SOURCE=registry; link accounts in the dashboard and restart)`);
  }
  if (health.operational) {
    log.info("✅ ALL SYSTEMS OPERATIONAL — v8 Momentum TSM");
  } else {
    const msg = `DEGRADED START — v8 Momentum TSM: required broker(s) DOWN: ${health.down.join(", ")} (${connectedBrokers}/${requiredBrokers} connected). Check credentials/host config; sleeves on a down broker can neither trade nor manage positions.`;
    log.error(`⚠️ ${msg}`);
    eventBus.emit(EVENTS.ERROR_BURST, {
      context: "Startup",
      message: msg,
      count: 1,
      windowMs: 0,
      firstAt: Date.now(),
      lastAt: Date.now(),
    });
  }
  log.info(`📊 Dashboard: ${publicBaseUrl() ?? `http://localhost:${loadInstanceConfig().dashboard.port}`}`);
  log.info(`📈 Stocks: ${getEnabledStocks().length} | Crypto: ${getEnabledCrypto().length}`);
  log.info(`🔗 Brokers: ${connectedBrokers}/${requiredBrokers} connected`);
  log.info(`📡 Broker Sync: every 30s · Rebalance: every 60min`);
  log.info(`📊 Daily Reports: ~00:01 ET (completed day)`);
  log.info("═══════════════════════════════════════");
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}
