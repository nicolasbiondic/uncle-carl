// ══════════════════════════════════════════════════════════════
//  🤖 Uncle Carl Trading Bot v8 — Momentum TSM
//  Two sleeves, one validated engine:
//    momentum_crypto — 8 Binance perps, 60min TSM rebalance, 24/7, slot 37.5%
//    momentum_stocks — 11 Alpaca tickers, 60min TSM, market hours only, slot 50%
//  TSM: entry +5% / exit −2%, maxLongs 4, 4% hard SL
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
import { TelegramReporter } from "./telegram/telegram-reporter";
import { BrokerSync } from "./sync/BrokerSync";
import { buildBrokerSyncSources } from "./sync/brokerSyncSource";
import { DailyReporter } from "./reports/DailyReporter";
import { createLogger } from "./utils/logger";
import { isMarketOpen } from "./utils/marketHours";
import { VERSION_INFO } from "./utils/version";
import { MomentumEngine, nextAlignedTickDelayMs, EARLY_BOOT_TICK_MIN_LEAD_MS, type MomentumStatePersistence, type MomentumPersistedState, type TrailMark } from "./strategies/momentum/MomentumEngine";
import { EQUITY_SEMANTICS, rebaseRiskState, RISK_STATE_VERSION, type EquitySemantics, type RiskState } from "./strategies/momentum/RiskGuard";
import { BinanceMomentumAdapter } from "./strategies/momentum/BinanceMomentumAdapter";
import { BinanceCoinMMomentumAdapter, COINM_INTERNAL_SYMBOL } from "./strategies/momentum/BinanceCoinMMomentumAdapter";
import { AlpacaMomentumAdapter } from "./strategies/momentum/AlpacaMomentumAdapter";
import { DEFAULT_TSM_CONFIG } from "./strategies/momentum/TimeSeriesMomentum";
import { BinanceExecutor } from "./executor/binance-executor";
import { BinanceCoinMExecutor } from "./executor/binance-coinm-executor";
import { USDC_SYMBOL_MAP } from "./executor/binance/quoteAsset";
import { MeanRevEngine, MeanRevRetryController, DEFAULT_MEANREV_CONFIG, type MeanRevReport } from "./strategies/meanrev/MeanRevEngine";
import { MOMENTUM_STOCKS_UNIVERSE, MOMENTUM_CRYPTO_UNIVERSE, RISK_PROFILES } from "./config/riskProfiles";
import { getETDateKey, getETDayStart, insertActivity, getOpenTrades, getDB } from "./db/database";
import { liveBandReadings, type BandReading } from "./portfolio/scorecard";
import { eventBus, EVENTS } from "./utils/events";
import { SleeveGovernor } from "./governor/SleeveGovernor";
import { SwitchingAdapter } from "./governor/SwitchingAdapter";
import { ShadowAdapter } from "./governor/ShadowAdapter";
import { FundingMonitor } from "./market/fundingMonitor";
import { TreasurySweep, type TreasurySweepConfig } from "./treasury/TreasurySweep";
import { CorporateActionsMonitor } from "./market/corporateActions";
import { heartbeats } from "./ops/heartbeat";
import { publishInstanceManifest } from "./ops/instanceManifest";
import { buildPortfolioPlan } from "./portfolios/factory";
import { builtinPortfolio } from "./portfolios/builtin";
import { initPlatformPortfolios, loadPlatformPortfolioDefinitions, resolvePortfoliosSource } from "./portfolios/store";
import type { MomentumPortfolioPlan, MeanRevPortfolioPlan, StatePersistenceSpec, PortfolioDefinition } from "./portfolios/types";

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
        return { v: 1, risk, trailMarks, ...(entryMarks ? { entryMarks } : {}), ...(riskAnchorAt !== undefined ? { riskAnchorAt } : {}) };
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
        }));
        renameSync(tmp, path);
      } catch (e: any) {
        log.warn(`momentum state save failed (${path}): ${e?.message ?? e}`);
      }
    },
  };
}

/**
 * Truth-only mode (flag OFF + no open DB exposure) must never run the
 * mutating startup stop reconcile: that reconcile cancels any owned stop it
 * finds once the account reads flat, but a truth-only wallet's flatness is
 * exactly the state where that stop-cancel would fire — a diagnostic-only
 * attachment must sync balance/mark truth and nothing else. Live (flag on)
 * and close-only (flag off, real exposure) modes keep the default (mutating)
 * reconcile unchanged.
 */
export function coinmSkipStartupStopReconcile(enabled: boolean, hasExposure: boolean): boolean {
  return !enabled && !hasExposure;
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

// ══════════════════════════════════════════════════════════════
// Sleeve gross-exposure caps (2026-08-19 audit fix).
//
// A sleeve's max THEORETICAL gross exposure — how much notional it can hold
// at once, as a multiple of its own equity — is the product of
// notionalPctPerSlot (size of one slot) and maxLongs (how many slots).
// Before this block, momentum_stocks' two numbers lived in DIFFERENT files
// (notionalPctPerSlot inline below; maxLongs never set here, so it silently
// inherited DEFAULT_TSM_CONFIG.maxLongs from TimeSeriesMomentum.ts) and their
// product — 2.0× — was never written down anywhere. The other three momentum
// sleeves already declared both numbers together; momentum_stocks didn't.
//
// These constants are the SINGLE SOURCE fed into both the engine configs
// below (so this file is still the one place sizing is decided) AND into
// momentumExposureCaps.test.ts (imported from THIS module, not duplicated —
// see that test's docstring for why scripts/walk-forward.test.ts's own
// notionalPctPerSlot literal does NOT satisfy this: it locks the walk-forward
// harness's config semantics, never production's actual wiring).
//
// momentum_stocks was DELIBERATELY at 2.0× until 2026-09-23, 1.0× since — see the notionalPctPerSlot
// comment at its use below (2026-07-12 sweep, kept unchanged pending a
// validated re-run). This block does not change that; it makes it visible
// and gives it a runtime backstop (MomentumEngineConfig.maxGrossExposureMult)
// that blocks the NEXT open if live exposure would exceed it — a pure
// safety net: at today's config the backstop never binds, because
// notionalPctPerSlot × maxLongs already can't exceed it by construction.
// 4 → 8 slots (and 0.25 → 0.125 per slot, gross unchanged at 1.0×) on
// 2026-09-25 together with the wide daily stops below — director decision on
// the pure chain k8-s8 (experiments/momentum-stocks-daily-k8s8-pure-v1.json,
// artifact 5a5a9577…): +307.6% / Sharpe 1.14 / maxDD 21.2% / PSR 0.997 / all
// gates, vs the wired h126 kernel's own pure chain (77372b9c…) +306.3% / 1.07
// / 24.1%; LOO worst Sharpe 1.07 vs 0.92; lower DD in all 3 folds. Each axis
// alone was a trade-off (k8: SR 1.18 but DD 28.6%; s8: DD 17.4% but SR 1.00);
// the combination was declared post-hoc before running (+2 trials, k8-s6
// failed the DD criterion). Reversion criterion (pre-registered): back to
// 4 × 0.25 / {3,20,2,12} if realized sleeve maxDD over the next 60 trading
// days exceeds 20%.
export const MOMENTUM_STOCKS_MAX_LONGS = 8;
// 0.5 → 0.25 on 2026-09-23 (owner-delegated decision, quorum 3/3, AUDITS.md
// 2026-09-23): the 2.0× came from a discredited pre-protocol sweep; the
// pre-registered gross axis (momentum-stocks-sizing-v1, artifact 49757edd…)
// selects gross-1x in all 3 outer folds — 9.9%/0.40/DD 14.5%/0 Reg-T
// rejects vs 2×'s 7.6%/0.26/DD 25.8%/28 rejects. Caveat declared: that
// manifest ran WITHOUT slotHysteresis (pre-registration error), so it
// measures the gross axis on the pre-09-10 kernel. The sleeve still fails
// 4 gates (bench, PSR, displacement, break-even) at any gross.
export const MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT = 0.125; // 0.25 until 2026-09-25 (see MAX_LONGS above)
export const MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT = MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT * MOMENTUM_STOCKS_MAX_LONGS; // 1.0×

/**
 * OPT-IN daily-horizon mode for momentum_stocks (R2 research 2026-09-24,
 * momentum-stocks-horizon-v1 axis). null = the current 5m/hourly kernel,
 * byte-identical (this constant is the ONLY switch; the director decides).
 *
 * Setting e.g. `{ lookbackDays: 126, maLengthDays: 200 }` rewires the sleeve
 * to the simulator-validated daily kernel: Alpaca "1Day" bars (today's
 * partial bar stripped — AlpacaMomentumAdapterConfig.dropTodayDailyBar),
 * decision once per ET trading day ≥ 09:35 (the meanrev discipline: signal
 * on yesterday's COMPLETED daily bar, fill after today's open — this also
 * sidesteps the two live-parity bugs of the 5m kernel: the ~16min SIP cutoff
 * and the :35-vs-:00 tick phase, both irrelevant at daily granularity), TSM
 * horizon lookbackDays/maLengthDays, and DAILY vol windows for trail + hard
 * stop ({kSigma 3, lookbackBars 20 sessions, 2..12%} — the meanrev daily
 * parametrization; 78×5m bars don't exist on 1Day data).
 *
 * Evidence (pure OOS chains, 2017-06..2026-09, 11 symbols, 17/17 gates incl.
 * minOuterPsr 0.95 — blocked from formal approval ONLY by the permanent
 * pre-protocol trial-accounting incompleteness):
 *   h126-ma200 3987f38d…/77372b9c…: +306.3% / Sharpe 1.07 / DD 24.1% / PSR .997
 *   h252-ma200: +252.8% / 0.97 / DD 24.1% / PSR .992; SPY B&H +159.8% / 0.80.
 * Declared caveat: on the short 2024-01..2026-07 sub-window (476 obs,
 * certifiable Sharpe ≥ 1.20 — underpowered) the pure chains do NOT beat SPY
 * (h126 −9.9pp, h252 −3.9pp) though they dominate every 5m-kernel artifact.
 *
 * WIRED 2026-09-24 → h126-ma200 (director decision, owner-delegated: "no
 * pares hasta tener una mejora substancial del modelo"). Criterion declared
 * BEFORE reading the verdicts: beat the pure live 5m control (095903db…) on
 * Sharpe AND maxDD on the same folds, outer PSR ≥ 0.95 where the window has
 * power, no single-symbol/fold dependence. Met: 2024+ window 0.78/DD 14.7%
 * vs the control's 0.68/DD 15.0%; long window 17/17 gates; LOO worst (no
 * NVDA) Sharpe 0.92; inner selection 9/9 folds for the long horizons.
 * Survivorship caveat (declared): the equal-weight buy&hold of the SAME 11
 * survivors did +507%/Sharpe 1.15/DD 40% — the edge over the basket is the
 * drawdown cut, the edge over the 5m kernel is the axis (same universe).
 * Reversion criterion (pre-registered): revert to null if, after 60 trading
 * days live, realized sleeve maxDD exceeds 20% or the sleeve trails the
 * pure-chain h126 replay of the same live window by >10pp.
 */
export type MomentumStocksDailyHorizon =
  | { lookbackDays: number; lookbackDaysList?: undefined; maLengthDays: number }
  | { lookbackDaysList: number[]; lookbackDays?: undefined; maLengthDays: number };
// 2026-09-25: single 126-session lookback → blend of 63/126/252 (Hurst–Ooi–
// Pedersen 2017: the average of 3-, 6- and 12-month returns is more robust
// than any single horizon — and it removes the dependence on the h126 pick,
// which was itself chosen among h14/h126/h252). Pure chain on the live k8-s8
// kernel (experiments/momentum-stocks-daily-blend3-pure-v1.json, artifact
// cc2f5d69…): +351.8% / Sharpe 1.19 / DD 21.19% / PSR 0.998 / all gates vs
// k8-s8 h126 (5a5a9577…) +307.6% / 1.14 / 21.25%; foldPSR better in all 3
// folds, LOO worst 1.13 vs 1.07. Declared caveats: the DD gain is noise
// (0.06pp; fold 2 alone 17.4% vs 16.1%) and the inner selection preferred
// h126 in 5/9 folds. Reversion criterion: back to { lookbackDays: 126 } if the
// 60-session live check of the k8-s8 constants trips.
export const MOMENTUM_STOCKS_DAILY_HORIZON: MomentumStocksDailyHorizon | null = { lookbackDaysList: [63, 126, 252], maLengthDays: 200 };

/** Longest return horizon of the daily kernel (sizes the candle history). */
export function dailyHorizonMaxLookback(h: MomentumStocksDailyHorizon): number {
  return h.lookbackDaysList ? Math.max(...h.lookbackDaysList) : h.lookbackDays;
}

/** Daily vol windows (sessions) for trail/volStop under the daily-horizon
 *  mode. {3, 20, 2..12} (the meanrev daily parametrization) until 2026-09-25;
 *  since then {8, 20, 5..30} — the k8 leg of the k8-s8 pure chain (see
 *  MOMENTUM_STOCKS_MAX_LONGS). 3σ daily (~3–4.5% on megacaps/ETFs) was noise
 *  for a 126-session trend: turnover 15–23×/yr → 3–5×/yr. */
export const MOMENTUM_STOCKS_DAILY_VOL_STOP = { kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 } as const;

/**
 * True when the daily-horizon momentum_stocks pass is due: market open,
 * ≥ 09:35 ET (decide on yesterday's completed daily bar, fill after today's
 * open — the scheduleDailyStockRun discipline) and not yet run today
 * (`lastRunKey` = ET date key of the last completed pass). Pure — tested in
 * src/index.dailyHorizon.test.ts without booting main().
 */
export function momentumStocksDailyTickDue(nowMs: number, lastRunKey: string): boolean {
  if (!isMarketOpen(nowMs)) return false;
  if ((nowMs - getETDayStart(nowMs)) / 60_000 < 9 * 60 + 35) return false;
  return getETDateKey(nowMs) !== lastRunKey;
}

/**
 * OPT-IN one-shot cutover for momentum_stocks (epoch ms; null = OFF,
 * byte-identical current behavior — the director flips it after review).
 *
 * Why: the 2026-09-25 first daily pass held META (40 sh, ~$31k) and AAPL
 * (75 sh, ~$25k) — both sized under the pre-2026-09-23 2× regime (0.5/slot)
 * and selected by the retired 5m/14d kernel. Together they filled the 1×
 * gross cap ($54.7k), so the h126 kernel's valid SMH/MSFT signals were
 * "BLOCKED by gross exposure cap": the live book could not express the
 * validated 4 × 0.25 model. Legacy positions never re-underwrite on their
 * own (slotHysteresis holds them while their signal stays valid).
 *
 * How to activate: set this to the boundary instant (e.g.
 * `Date.UTC(2026, 8, 25)` — entries BEFORE it are legacy) and deploy. On the
 * next daily tick the engine closes every universe position with
 * entryTime < boundary through the normal close path (close_reason
 * MODEL_CUTOVER, whitelisted in all adapters incl. Shadow), then ranks with
 * those symbols as NOT held — they are re-bought at the CURRENT slot size
 * only if they rank and pass the entry thresholds and the gross cap.
 * One-shot by construction (re-bought entries postdate the boundary); a
 * failed close retries next tick. Revert to null after the pass lands —
 * leaving it set is harmless but noisy in intent.
 * See MomentumEngineConfig.reunderwriteBefore for the mechanism.
 */
// ACTIVATED 2026-09-25 (director): META/AAPL (entered 09-04/09-11 by the 5m
// kernel at 0.5/slot) are re-underwritten on the next daily pass (Mon 09-28)
// under 8 × 0.125. Set back to null once that pass has landed.
export const MOMENTUM_STOCKS_CUTOVER_AT: number | null = Date.UTC(2026, 8, 26);
/** The cutover is only wired into an engine built BEFORE this instant, so a
 *  forgotten constant cannot re-underwrite anything later (e.g. an adopted
 *  orphan carrying an old broker timestamp). Monday 09-28's pass is the only
 *  one it is meant for. */
export const MOMENTUM_STOCKS_CUTOVER_EXPIRES_AT = Date.UTC(2026, 9, 3);

/** reunderwriteBefore for a momentum_stocks engine built at `nowMs`:
 *  the boundary while the cutover window is open, otherwise undefined. */
export function momentumStocksCutoverFor(nowMs: number): number | undefined {
  if (MOMENTUM_STOCKS_CUTOVER_AT === null) return undefined;
  return nowMs < MOMENTUM_STOCKS_CUTOVER_EXPIRES_AT ? MOMENTUM_STOCKS_CUTOVER_AT : undefined;
}

/** Model identity for momentum_stocks' persisted RiskState (one-shot peak +
 *  loss-streak re-anchor on change — MomentumEngineConfig.modelVersion): the
 *  daily blend3 kernel's first pass (2026-09-28) must not inherit the 5m
 *  kernel's peak ($55.7k — a 2.8% drawdown it never produced) or its 2
 *  losing rebalances. Bump it only when the wired model itself changes. */
export const MOMENTUM_STOCKS_MODEL_VERSION = "daily-blend3-2026-09-28";

export const MOMENTUM_CRYPTO_MAX_LONGS = DEFAULT_TSM_CONFIG.maxLongs;
export const MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT = 0.375;
/** Model identity for momentum_crypto's persisted RiskState (one-shot peak
 *  re-anchor on change — MomentumEngineConfig.modelVersion). Bump it only
 *  when the wired model itself changes. */
export const MOMENTUM_CRYPTO_MODEL_VERSION = "vt35-2026-09-23";
export const MOMENTUM_CRYPTO_MAX_GROSS_EXPOSURE_MULT = MOMENTUM_CRYPTO_NOTIONAL_PCT_PER_SLOT * MOMENTUM_CRYPTO_MAX_LONGS; // 1.5×

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
export const MOMENTUM_USDC_MAX_GROSS_EXPOSURE_MULT = MOMENTUM_USDC_NOTIONAL_PCT_PER_SLOT * MOMENTUM_USDC_MAX_LONGS; // 1.0×
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
 *  re-anchor on change — MomentumEngineConfig.modelVersion). */
export const MOMENTUM_USDC_MODEL_VERSION = "daily-s5-blend3-2026-09-26";
/** One-shot MODEL_CUTOVER for the hourly model's positions (UNI, NEAR, BCH
 *  on 2026-09-26 — ~0.9× of equity at the hourly slot size, which would fill
 *  the daily kernel's 1.0× cap and block its entries). Entries before this
 *  instant are closed at the first daily decision (00:00:15 UTC 09-27) and
 *  re-bought at 5 × 0.20 only if the daily kernel ranks them. Expires on its
 *  own: engines built after MOMENTUM_USDC_CUTOVER_EXPIRES_AT never get it. */
export const MOMENTUM_USDC_CUTOVER_AT = Date.UTC(2026, 8, 27);
export const MOMENTUM_USDC_CUTOVER_EXPIRES_AT = Date.UTC(2026, 9, 4);
export function momentumUsdcCutoverFor(nowMs: number): number | undefined {
  return nowMs < MOMENTUM_USDC_CUTOVER_EXPIRES_AT ? MOMENTUM_USDC_CUTOVER_AT : undefined;
}

export const MOMENTUM_BTC_MAX_LONGS = 1;
export const MOMENTUM_BTC_NOTIONAL_PCT_PER_SLOT = 1;
export const MOMENTUM_BTC_MAX_GROSS_EXPOSURE_MULT = MOMENTUM_BTC_NOTIONAL_PCT_PER_SLOT * MOMENTUM_BTC_MAX_LONGS; // 1.0×

// meanrev_stocks doesn't override slotPct/maxPositions below — it inherits
// MeanRevEngine's own DEFAULT_MEANREV_CONFIG, which is ALREADY the single
// source (no cross-file emergence to fix). Re-derived here only so the
// account-level exposure sum (see AccountManager) and the test lock have one
// place to read every sleeve's cap from.
export const MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT =
  DEFAULT_MEANREV_CONFIG.slotPct * DEFAULT_MEANREV_CONFIG.maxPositions; // 0.7× since 2026-09-24 (was 0.5×)

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
    governorRegistration: { sleeve: "momentum_crypto", kind: "live", promotionEligible: false, evidenceVersion: "v8-crypto-no-hard-sl" },
    adapter: { kind: "binance_usdm", options: {} },
    shadow: { strategy: "MOMENTUM", closeReason: "MOMENTUM_REBALANCE", timeframe: "1Hour", market: "crypto" },
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
      regime: { barMinutes: 60 },
      scorer: { barMinutes: 60 },
      // tsmTrail intentionally ABSENT on crypto — the 2026-07-12 sweep found it
      // amputates fat-tail trend rides. (That sweep's "+148→+178%/yr" claim for
      // enhanced TSM is pre-nested machinery, not evidence — see above.)
      sharpeGate: { lookbackDays: 30, minSharpe: 0 },
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
      risk: { equitySemantics: EQUITY_SEMANTICS.BINANCE_TOTAL_MARGIN },
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
      // literal on all four wired sleeves; momentum_btc deliberately skipped
      // (flag-off/truth-only). See MomentumEngineConfig.capacityGuard.
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
    governorRegistration: { sleeve: "momentum_crypto_usdc", kind: "live", evidenceVersion: "v8.3-usdc-daily" },
    adapter: { kind: "binance_usdm", options: { accountId: "momentum_crypto_usdc", quoteAsset: "USDC", candleTimeframe: "1Day" } },
    shadow: { strategy: "MOMENTUM", closeReason: "MOMENTUM_REBALANCE", timeframe: "1Day", market: "crypto" },
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
      tsmTrail: { ...MOMENTUM_USDC_DAILY_VOL_STOP },
      // Vol-scaled HARD stop: the engine passes stopLossPct on every open;
      // BinanceMomentumAdapter derives the stop PRICE from the real fill,
      // installs the broker-native STOP_MARKET there and persists it on
      // the row (rowStopPct: row first, profile 4% fallback).
      volStop: { ...MOMENTUM_USDC_DAILY_VOL_STOP },
      sharpeGate: { lookbackDays: 30, minSharpe: 0 },
      risk: { equitySemantics: EQUITY_SEMANTICS.BINANCE_USDC_MARGIN },
      maxGrossExposureMult: MOMENTUM_USDC_MAX_GROSS_EXPOSURE_MULT,
      // %ADV capacity check, observe-only — see the momentum_crypto block.
      capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
      // New model → own risk state, and the hourly model's positions are
      // re-underwritten at the daily kernel's slot size (see constants).
      modelVersion: MOMENTUM_USDC_MODEL_VERSION,
      ...(momentumUsdcCutoverFor(Date.now()) !== undefined ? { reunderwriteBefore: momentumUsdcCutoverFor(Date.now()) } : {}),
    },
    statePersistence: { path: "data/momentum-state-usdc.json", currentBase: 5_000, legacyBase: 5_000, equitySemantics: EQUITY_SEMANTICS.BINANCE_USDC_MARGIN },
    scheduler: { kind: "engine-start" },
  };
}

/** momentum_btc — COIN-M BTCUSD_PERP, single-symbol universe (only one
 *  slot exists — maxLongs=1 is redundant but explicit), 2x leverage. */
export function momentumBtcPortfolioPlan(): MomentumPortfolioPlan {
  return {
    template: "momentum_tsm",
    portfolioId: "momentum_btc",
    governorRegistration: { sleeve: "momentum_btc", kind: "live", evidenceVersion: "v8.2-coinm-launch" },
    adapter: { kind: "binance_coinm", options: { accountId: "momentum_btc" } },
    shadow: { strategy: "MOMENTUM", closeReason: "MOMENTUM_REBALANCE", timeframe: "1Hour", market: "crypto" },
    loggerContext: "Momentum:coinm",
    engineConfig: {
      mode: "time-series",
      universe: [COINM_INTERNAL_SYMBOL],
      rebalanceMinutes: 60,
      heartbeatName: "momentum:btc",
      historyBars: 754,
      notionalPctPerSlot: MOMENTUM_BTC_NOTIONAL_PCT_PER_SLOT, // single symbol IS the one slot
      tsm: { barMinutes: 60, maxLongs: MOMENTUM_BTC_MAX_LONGS },
      regime: { barMinutes: 60 },
      scorer: { barMinutes: 60 },
      sharpeGate: { lookbackDays: 30, minSharpe: 0 },
      risk: { equitySemantics: EQUITY_SEMANTICS.BINANCE_COINM_MARGIN },
      maxGrossExposureMult: MOMENTUM_BTC_MAX_GROSS_EXPOSURE_MULT,
    },
    statePersistence: { path: "data/momentum-state-btc.json", currentBase: 1_000, legacyBase: 1_000, equitySemantics: EQUITY_SEMANTICS.BINANCE_COINM_MARGIN },
    scheduler: { kind: "engine-start" },
  };
}

/** momentum_stocks — 5Min bars with trading-day bar math (78 bars/session
 *  ⇒ barMinutesEq = 1440/78 so "lookbackDays" = trading days), or the
 *  DAILY-HORIZON kernel when MOMENTUM_STOCKS_DAILY_HORIZON is set (daily
 *  bars ⇒ barMinutesEq 1440, history sized max(lookback, MA) + 11 — the
 *  replay's own formula, one decision per ET trading day ≥ 09:35). */
export function momentumStocksPortfolioPlan(): MomentumPortfolioPlan {
  const dailyHorizon = MOMENTUM_STOCKS_DAILY_HORIZON;
  const barMinutesEq = dailyHorizon ? 1440 : (24 * 60) / 78; // ≈ 18.4615 on 5m
  const stocksHistoryBars = dailyHorizon
    ? Math.max(dailyHorizonMaxLookback(dailyHorizon), dailyHorizon.maLengthDays) + 11
    : Math.ceil((31 * 24 * 60) / barMinutesEq) + 10; // ≈ 2428 on 5m
  return {
    template: "momentum_tsm",
    portfolioId: "momentum_stocks",
    governorRegistration: { sleeve: "momentum_stocks", kind: "live", evidenceVersion: "v8-stocks" },
    // Daily-horizon mode reads "1Day" bars with today's partial session
    // stripped (dropTodayDailyBar — MomentumEngine has no MeanRevEngine-style
    // strip of its own); default mode is the pre-existing 5Min adapter.
    adapter: { kind: "alpaca", options: dailyHorizon ? { timeframe: "1Day", dropTodayDailyBar: true } : {} },
    shadow: { strategy: "MOMENTUM", closeReason: "MOMENTUM_REBALANCE", timeframe: dailyHorizon ? "1Day" : "5Min", market: "stock" },
    loggerContext: "Momentum:stocks",
    engineConfig: {
      mode: "time-series",
      // Universe (incl. +SMH 2026-07-25) lives in riskProfiles.ts as an exported
      // constant so riskProfiles.disjoint.test.ts can enforce no MEANREV overlap.
      universe: MOMENTUM_STOCKS_UNIVERSE,
      // informational — index.ts drives the tick in BOTH modes (hourly
      // aligned loop, or the once-daily ≥09:35 scheduler under
      // MOMENTUM_STOCKS_DAILY_HORIZON); engine.start() is never called,
      // so this literal is never consumed (docs.test.ts counts it).
      rebalanceMinutes: 60,
      heartbeatName: "momentum:stocks", // start() NOT called — index.ts registers it; tick() beats it
      historyBars: stocksHistoryBars,
      // notionalPctPerSlot was 0.5 ("x2") until 2026-09-23 — see the
      // MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT constant for the 1.0× decision.
      // The 0.5 came from a 2026-07-12 exposure sweep on
      // the OLD pre-nested backtest-momentum-wf. The rigorous nested-purged
      // walk-forward for THIS sleeve and config (data/backtests/5d8602ee… /
      // 92d5cd72…, 243 trades) CONTRADICTS that sweep: OOS folds
      // −22.8/+41.2/−1.2%, stitched ≈+7.6% over ~2.5y (≈+2.9%/yr), Sharpe 0.26,
      // maxDD 25.8% — one window IS negative, and at 2× gross the sizing drew 28
      // Reg-T margin rejections in replay. Current sizing is NOT backed by the
      // rigorous protocol; kept unchanged pending a validated re-run.
      //
      // notionalPctPerSlot × maxLongs = 1.0× gross since 2026-09-23 (2.0× before; see the
      // MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT block above main() for the
      // audit history: this product used to be invisible, maxLongs having
      // never been declared here — it silently inherited
      // DEFAULT_TSM_CONFIG.maxLongs from a different file entirely). Now
      // explicit and backstopped by maxGrossExposureMult below.
      notionalPctPerSlot: MOMENTUM_STOCKS_NOTIONAL_PCT_PER_SLOT,
      // slotHysteresis: OWNER OVERRIDE 2026-09-10 (stocks ONLY — the same axis
      // was REFUTED on crypto the same day, ledger
      // authoritativeArtifactCryptoDisplacement). Evidence: artifact 205de58f
      // (experiments/momentum-stocks-displacement-v1.json): no-displacement
      // won the inner selection in all 3 outer folds (median Sharpe 2.54 vs
      // 1.31) and stitched +35.4% / Sharpe 0.70 / 120 trades vs the
      // incumbent's +7.6% / 0.26 / 244 on the same window — the first stocks
      // artifact to beat SPY B&H on return (+4.2pp). NOT protocol-approved:
      // minOuterPsr 0.825 < 0.95, and the excess lives in fold 1 (fold 0 was
      // WORSE than the incumbent, −28.0 vs −22.8). certifiableSharpeAtPsr95 on
      // this window is 1.20; nothing on stocks clears it. Mechanics: a held
      // position with a still-valid signal is no longer closed because a
      // marginally higher-ranked entrant took its slot (the GLD/QQQ ping-pong
      // the 2026-09-06 model audit traced); it exits only on its own signal,
      // trail, time or hard stop. Revert = delete this one key.
      tsm: {
        barMinutes: barMinutesEq,
        maxLongs: MOMENTUM_STOCKS_MAX_LONGS,
        slotHysteresis: true,
        // Daily-horizon TSM lookback/MA (opt-in — see the constant's
        // docstring for artifacts); absent = engine defaults 14/30.
        ...(dailyHorizon
          ? (dailyHorizon.lookbackDaysList
            ? { lookbackDaysList: dailyHorizon.lookbackDaysList, maLengthDays: dailyHorizon.maLengthDays }
            : { lookbackDays: dailyHorizon.lookbackDays, maLengthDays: dailyHorizon.maLengthDays })
          : {}),
      },
      regime: { barMinutes: barMinutesEq },
      scorer: { barMinutes: barMinutesEq },
      // tsmTrail params also come from that same discredited 2026-07-12 sweep
      // (its "+28.7→+32.9%/yr" claim); no nested-protocol evidence backs them.
      tsmTrail: dailyHorizon ? { ...MOMENTUM_STOCKS_DAILY_VOL_STOP } : { kSigma: 3, lookbackBars: 78, minPct: 2, maxPct: 8 },
      // Vol-scaled HARD stop — owner override 2026-08-28 (see
      // MomentumEngine.volStop docstring for evidence + provenance). Spec is
      // VERBATIM the vol-k3 candidate of locked artifact ff70c47e
      // (experiments/momentum-stop-sizing-v1.json): the fixed profile 4% was
      // that sweep's WORST setting (+7.55%/0.257 vs +30.12%/0.618) and
      // bought no drawdown. Fixed 4% remains the FALLBACK for rows without a
      // persisted stop (pre-override rows, degenerate history).
      // Daily-horizon mode swaps both vol windows to daily sessions
      // (the k8 {8, 20, 5..30} spec; 78 five-minute bars don't exist on
      // 1Day data).
      volStop: dailyHorizon ? { ...MOMENTUM_STOCKS_DAILY_VOL_STOP } : { kSigma: 3, lookbackBars: 78, minPct: 2, maxPct: 8 },
      sharpeGate: { lookbackDays: 30, minSharpe: 0 },
      risk: { equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER },
      modelVersion: MOMENTUM_STOCKS_MODEL_VERSION,
      maxGrossExposureMult: MOMENTUM_STOCKS_MAX_GROSS_EXPOSURE_MULT,
      // %ADV capacity check, observe-only — see the momentum_crypto block.
      capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
      // One-shot legacy-position re-underwrite (null = absent = OFF) — see
      // MOMENTUM_STOCKS_CUTOVER_AT's docstring above main().
      ...(momentumStocksCutoverFor(Date.now()) !== undefined ? { reunderwriteBefore: momentumStocksCutoverFor(Date.now()) } : {}),
    },
    statePersistence: { path: "data/momentum-state-stocks.json", currentBase: 50_000, legacyBase: 100_000, equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER },
    // index.ts owns this loop (engine.start() not called) so main() registers
    // the heartbeat; stocksEngine.tick() beats it on a successful in-hours
    // rebalance. Daily-horizon mode registers at the daily cadence with the
    // meanrev grace (MeanRevEngine's own convention for a once-a-day loop).
    heartbeat: dailyHorizon
      ? { name: "momentum:stocks", intervalMs: 86_400_000, graceMultiplier: 5 }
      : { name: "momentum:stocks", intervalMs: 60 * 60_000 },
    scheduler: dailyHorizon
      ? { kind: "index-stocks-daily", markerPath: "data/daily-run-momentum-stocks.txt" }
      : { kind: "index-stocks-hourly" },
  };
}

/** meanrev_stocks — daily RSI2 mean-reversion, one pass per ET trading day
 *  shortly after the open (≥ 09:35, signals on yesterday's completed daily
 *  bar). Strategy knobs come from DEFAULT_MEANREV_CONFIG (already the
 *  single source); these are only index.ts's overrides.
 *
 *  Single source of truth: RISK_PROFILES.meanrev_stocks.initialEquity
 *  (itself env-driven via MEANREV_BASE_USD) instead of re-reading the
 *  env var here — was two knobs for the same capital number.
 *
 *  risk: SLEEVE_LEDGER — momentum_stocks and meanrev_stocks share one
 *  Alpaca wallet (see AGENTS.md "Shared Alpaca wallet"); the equity fed
 *  to RiskGuard must be THIS sleeve's own ledger (meanrevAdapter →
 *  AlpacaMomentumAdapter.getEquity(), accountId="meanrev_stocks"), never
 *  the aggregate account — otherwise one sleeve's drawdown would pause
 *  the other. DEFAULT_RISK_CONFIG kept unchanged: peakHalfLifeDays=30
 *  (anti-lockout) applies exactly as documented regardless of cadence;
 *  dailyLossCapPct=3% is structurally near-inert here (evaluateRisk
 *  runs once/day, so dayStartEquity is captured at the same instant as
 *  the comparison — it can only fire across same-day retries), which is
 *  fine because the meaningful breakers for a once-daily pass are the
 *  soft/hard peak-to-trough drawdown and the 5-losing-day streak, both
 *  unchanged from momentum's defaults. */
export function meanrevStocksPortfolioPlan(): MeanRevPortfolioPlan {
  return {
    template: "meanrev_connors",
    portfolioId: "meanrev_stocks",
    governorRegistration: { sleeve: "meanrev_stocks", kind: "live", evidenceVersion: "v8-meanrev" },
    adapter: { kind: "alpaca", options: { accountId: "meanrev_stocks", timeframe: "1Day", strategy: "MEANREV", closeReason: "MEANREV_EXIT" } },
    shadow: { strategy: "MEANREV", closeReason: "MEANREV_EXIT", timeframe: "1Day", market: "stock" },
    loggerContext: "MeanRev:stocks",
    engineConfig: {
      accountId: "meanrev_stocks",
      baseUsd: RISK_PROFILES.meanrev_stocks.initialEquity,
      heartbeatName: "meanrev:stocks",
      risk: { equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER },
      maxGrossExposureMult: MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT,
      // Vol-scaled HARD stop — owner override 2026-08-28 (see
      // MeanRevEngine.volStop docstring). Spec is VERBATIM the vol-k3
      // candidate of locked artifact 9dcd9781
      // (experiments/meanrev-stop-sizing-v2.json, daily bars): 0.725
      // Sharpe vs the fixed 4%'s 0.561, at ~+3.5pp maxDD — tradeoff the
      // owner accepted. Fixed 4% remains the fallback.
      volStop: { kSigma: 3, lookbackBars: 20, minPct: 2, maxPct: 12 },
      // %ADV capacity check, observe-only — see the momentum_crypto block.
      capacityGuard: { maxAdvPct: 1, lookbackBars: 20, mode: "observe" },
    },
    statePersistence: {
      path: "data/meanrev-state-stocks.json",
      currentBase: RISK_PROFILES.meanrev_stocks.initialEquity,
      legacyBase: RISK_PROFILES.meanrev_stocks.initialEquity,
      equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER,
    },
    scheduler: { kind: "index-meanrev-daily", label: "meanrev" },
  };
}

// ── factory consumption helpers (main() uses the FACTORY plans; the pure
// functions above are the parity reference) ─────────────────────────────
// F3b: PORTFOLIOS_SOURCE=code|db (default code). main() resolves the source
// once at boot; db mode swaps WHERE the definitions come from — nothing
// else. With untouched seeded rows the db source builds byte-identical
// engines (locked by src/portfolios/store.test.ts).
let dbPortfolioDefs: Map<string, PortfolioDefinition> | null = null;
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
  return dbPortfolioDefs ? dbPortfolioDefs.get(id)?.enabled === true : true;
}
function momentumPlanFor(id: string): MomentumPortfolioPlan {
  const plan = buildPortfolioPlan(portfolioDefinition(id), Date.now());
  if (plan.template !== "momentum_tsm") throw new Error(`portfolio '${id}': expected a momentum_tsm plan`);
  return plan;
}
function meanrevPlanFor(id: string): MeanRevPortfolioPlan {
  const plan = buildPortfolioPlan(portfolioDefinition(id), Date.now());
  if (plan.template !== "meanrev_connors") throw new Error(`portfolio '${id}': expected a meanrev_connors plan`);
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
    coinmEngine?: MomentumEngine;
    stocksTickTimer?: ReturnType<typeof setTimeout>;
    stocksDailyInterval?: ReturnType<typeof setInterval>;
    meanrevInterval?: ReturnType<typeof setInterval>;
    treasuryInterval?: ReturnType<typeof setInterval>;
  } = {};

  const shutdown = async () => {
    log.warn("Shutting down...");
    heartbeats.stop(); // stop the checker first so teardown doesn't self-page
    handles.cryptoEngine?.stop();
    handles.usdcEngine?.stop();
    handles.coinmEngine?.stop();
    if (handles.stocksTickTimer) clearTimeout(handles.stocksTickTimer);
    if (handles.stocksDailyInterval) clearInterval(handles.stocksDailyInterval);
    if (handles.meanrevInterval) clearInterval(handles.meanrevInterval);
    if (handles.treasuryInterval) clearInterval(handles.treasuryInterval);
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
║  Momentum TSM — two sleeves, one engine          ║
║  crypto: Binance perps 24/7 · stocks: Alpaca RTH ║
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
    log.info(`📁 Portfolio source: db (${defs.length} platform_portfolios definitions)`);
  } else {
    log.info("📁 Portfolio source: code (built-in definitions)");
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

  // 4b. Optional certified sleeves (momentum_crypto_usdc / momentum_btc) —
  // OFF by default (MOMENTUM_USDC_ENABLED / MOMENTUM_COINM_ENABLED). Each
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
      if (!pf.ok) {
        if (hasExposure) throw new Error(`momentum_crypto_usdc: open DB exposure exists but preflight FAILED (${pf.reason}) — refusing to boot with abandoned exposure`);
        log.error(`🚫 momentum_crypto_usdc preflight FAILED — sleeve stays OFF: ${pf.reason}`);
        insertActivity(null, "circuit", `momentum_crypto_usdc preflight failed: ${pf.reason}`);
      } else if (!(await candidate.init())) {
        if (hasExposure) throw new Error("momentum_crypto_usdc: open DB exposure exists but executor.init() failed — refusing to boot with abandoned exposure");
        log.error("🚫 momentum_crypto_usdc init failed after preflight passed — sleeve stays OFF");
        insertActivity(null, "circuit", "momentum_crypto_usdc init failed after preflight passed");
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

  let coinmExecutor: BinanceCoinMExecutor | null = null;
  let coinmLive = false; // only true when MOMENTUM_COINM_ENABLED=true (gates engine construction below)
  {
    const enabled = process.env.MOMENTUM_COINM_ENABLED === "true";
    coinmLive = enabled;
    const hasExposure = getOpenTrades("momentum_btc").length > 0;
    // DAPI truth (binance_coinm_main) is attached UNCONDITIONALLY — mandate
    // 2026-07-19: "DAPI truth always exists independently of the trading
    // flag." The account already carries a real DAPI balance regardless of
    // whether momentum_btc has ever traded, and the consolidated total must
    // reflect it rather than silently omitting a funded ledger. The flag
    // (`enabled`) and `hasExposure` only decide WHICH of the three sleeve
    // modes AccountManager runs: live (opens new positions), close-only
    // (flag off but real DB exposure needs reconciling), or truth-only
    // (flag off, no exposure — read-only equity sync; see attachCoinmExecutor
    // and syncBinanceCoinM's truth-only guard for why reconciliation must
    // NOT run in that case: it would treat the account's own real DAPI
    // position as an unowned "orphan" and emergency-close it).
    // F4b: COIN-M stays .env-configured (not in the accounts registry). A
    // fresh registry-mode installation has NO COIN-M keys — attaching the
    // DAPI-truth executor would only produce a spurious preflight ERROR on
    // every boot. With the flag off, no exposure and no keys there is no
    // truth to sync: skip quietly. Prod (keys present in .env) and any
    // env-mode install are untouched: keys present → unchanged path.
    // Same presence rule as assertRequiredConfig: .env.example's "your_*"
    // placeholders count as missing (a fresh install copies them verbatim).
    const coinmKeysPresent =
      (credentialPresent(process.env.BINANCE_COINM_API_KEY) || credentialPresent(process.env.BINANCE_FUTURES_API_KEY)) &&
      (credentialPresent(process.env.BINANCE_COINM_SECRET_KEY) || credentialPresent(process.env.BINANCE_FUTURES_SECRET_KEY));
    if (!enabled && !hasExposure && !coinmKeysPresent) {
      log.info("momentum_btc/DAPI: no COIN-M keys configured — truth sync not started (flag off, no exposure)");
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
    } else if (!(await candidate.init({ skipStartupStopReconcile: coinmSkipStartupStopReconcile(enabled, hasExposure) }))) {
      if (hasExposure) throw new Error("momentum_btc: open DB exposure exists but executor.init() failed — refusing to boot with abandoned exposure");
      log.error("🚫 momentum_btc/DAPI init failed after preflight passed — binance_coinm_main truth unavailable");
      insertActivity(null, "circuit", "momentum_btc/DAPI init failed after preflight passed");
    } else {
      coinmExecutor = candidate;
      if (enabled) {
        accountManager.attachCoinmExecutor(candidate, { live: true });
        log.info("✅ momentum_btc preflight passed — executor connected");
      } else if (hasExposure) {
        accountManager.attachCoinmExecutor(candidate, { live: false });
        log.warn("⚠️ momentum_btc: flag OFF but open DB exposure exists — CLOSE-ONLY mode (reconcile/close only, no new entries)");
        insertActivity(null, "circuit", "momentum_btc: flag OFF with open exposure — running close-only");
      } else {
        accountManager.attachCoinmExecutor(candidate, { truthOnly: true });
        log.info("ℹ️ momentum_btc disabled (MOMENTUM_COINM_ENABLED=false, no exposure) — DAPI truth-only sync active (binance_coinm_main)");
      }
    }
    }
  }

  // 5. Dashboard + Prometheus
  log.info("Starting dashboard...");
  const dashboard = new DashboardServer(accountManager);
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

  // 8. Account manager loops (sync / hard SL / snapshots)
  log.info("Starting account manager...");
  await accountManager.start();

  // 9. Momentum engines — ALWAYS ON (the only signal engine in v8).
  const momentumLog = createLogger("Momentum");
  // Per-sleeve logger contexts: four MomentumEngines + two MeanRevEngines
  // used to share ONE anonymous "[Momentum]" context, so a line like
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

  // Sleeve governor — RECOMMENDS, never switches. Owner mandate 2026-08-08
  // ("siempre live, no demo"): neither demotion nor promotion is automatic,
  // because shadow books are not live-equivalent (no hard-SL simulation), so a
  // sleeve parked there neither earns nor produces usable evidence — the worst
  // of both. A bleeding sleeve emits RECOMMEND_REDESIGN and a profitable shadow
  // one emits RECOMMEND_PROMOTE; a human decides with scripts/set-sleeve-mode.ts.
  // Risk control that KEEPS a sleeve live is RiskGuard's drawdown pauses
  // (declared per sleeve in SLEEVE_POLICY). Live sleeve adapters are wrapped in SwitchingAdapter so
  // a demoted sleeve keeps managing residual real positions while opening only
  // simulated ones.
  // The governor judges each sleeve against its validated expectation band
  // (owner, 2026-10-04): the same scorecard the digest and the "POR DEBAJO"
  // page use, read-only, once per daily pass.
  const governor = new SleeveGovernor({ bandReadings: governorBandReadings });
  handles.governor = governor;
  const shadowFor = (sleeve: string, opts: { strategy: string; closeReason: string; timeframe: string; market: "stock" | "crypto" }) =>
    new ShadowAdapter(accountManager.executor.alpaca, {
      accountId: `shadow_${sleeve}`,
      baseUsd: 50_000,
      ...opts,
    });

  /** Once-per-ET-trading-day scheduler (≥ 09:35 ET, market open). Used by
   *  the meanrev sleeve.
   *
   *  Retry control:
   *  - Persisted per-date attempts in data/daily-run-<label>-retry.json.
   *  - Incomplete universe data retries up to maxDataRetries with exponential
   *    backoff, then entries are skipped for the day (exits still run once).
   *  - Terminal action failures (buying-power/qty/suspended symbol) mark the
   *    day failed/manual-review and stop resubmitting.
   *  - Holidays remain no-ops; successful days are idempotent. */
  const scheduleDailyStockRun = (
    label: string,
    run: (opts: { skipEntries: boolean }) => Promise<MeanRevReport>,
    opts?: { maxDataRetries?: number },
  ): ReturnType<typeof setInterval> => {
    const markerPath = `data/daily-run-${label}.txt`;
    const retry = new MeanRevRetryController(`data/daily-run-${label}-retry.json`, {
      maxDataRetries: opts?.maxDataRetries ?? 3,
    });
    let lastRunKey = existsSync(markerPath) ? readFileSync(markerPath, "utf-8").trim() : "";
    let running = false;
    let terminalLogged = false;

    const tick = async () => {
      if (running) return;
      if (!isMarketOpen()) return;
      const minutesSinceETMidnight = (Date.now() - getETDayStart()) / 60_000;
      if (minutesSinceETMidnight < 9 * 60 + 35) return; // ≥ 09:35 ET
      const todayKey = getETDateKey();
      if (lastRunKey === todayKey) return; // once per ET trading day

      const decision = retry.shouldRun(todayKey, Date.now());
      if (!decision.run) return;

      running = true;
      try {
        retry.recordAttempt(todayKey, Date.now());
        const report = await run({ skipEntries: decision.skipEntries });
        for (const err of report.errors) momentumLog.warn(`${label}: ${err}`);

        if (report.status === "terminal_action_failure") {
          retry.markTerminal(todayKey, report.terminalReason ?? "unknown", Date.now());
          if (!terminalLogged) {
            const msg = `${label} daily run TERMINAL FAILURE: ${report.terminalReason ?? "unknown"} — manual review required`;
            momentumLog.error(msg);
            insertActivity(null, "circuit", msg);
            eventBus.emit(EVENTS.ERROR_BURST, {
              context: "MeanRevRetry",
              message: msg,
              count: 1,
              windowMs: 0,
              firstAt: Date.now(),
              lastAt: Date.now(),
            });
            terminalLogged = true;
          }
          return;
        }

        if (report.status === "incomplete_data" || report.status === "action_failure") {
          if (decision.skipEntries) {
            // Exhausted retries; mark the day failed so we don't resubmit all day.
            const reason = report.errors[0] ?? report.terminalReason ?? `${report.status} after retries`;
            retry.markTerminal(todayKey, reason, Date.now());
            const msg = `${label} daily run FAILED after retries: ${reason} — manual review required`;
            momentumLog.error(msg);
            insertActivity(null, "circuit", msg);
            eventBus.emit(EVENTS.ERROR_BURST, {
              context: "MeanRevRetry",
              message: msg,
              count: 1,
              windowMs: 0,
              firstAt: Date.now(),
              lastAt: Date.now(),
            });
          } else {
            momentumLog.warn(`${label} daily run ${report.status}: ${report.errors[0] ?? report.terminalReason ?? ""} — will retry`);
          }
          return;
        }

        // ok or entries_skipped
        if (report.status === "entries_skipped") {
          const msg = `${label}: entries skipped for ${todayKey} after data retries; exits processed`;
          momentumLog.warn(msg);
          insertActivity(null, "system", msg);
        }
        const tmp = `${markerPath}.tmp`;
        writeFileSync(tmp, todayKey);
        renameSync(tmp, markerPath);
        lastRunKey = todayKey;
        retry.markSuccess(todayKey);
      } catch (e: any) {
        momentumLog.error(`${label} daily run failed: ${e?.message ?? e}`);
      } finally {
        running = false;
      }
    };
    setTimeout(() => { tick().catch(() => {}); }, 30_000); // boot run if conditions hold
    return setInterval(() => { tick().catch(() => {}); }, 5 * 60_000);
  };

  // 9a. Crypto sleeve — 8 perps, 1h bars, 60min rebalance, 24/7.
  // Recent deployed-config windows are negative (2025 and 2026 YTD), so this
  // registers shadow by default. ONE-TIME migration: earlier deploys ran
  // this sleeve live and may have persisted a 'live' sleeve_modes row, which
  // would silently override the registered shadow default below (a
  // persisted row always wins over a registered fallback). Force shadow
  // exactly once via migrateOnce — never again, so a later legitimate manual
  // promotion back to live survives restarts instead of being reset every
  // boot. That later promotion happened: the owner overrode this sleeve to
  // live on 2026-08-08 via scripts/set-sleeve-mode.ts, which is exactly the
  // "legitimate manual promotion" this migrateOnce guard was written to
  // protect. Since 2026-10-04 the REGISTERED default below is "live" too
  // (owner rule: a sleeve is never parked in shadow; with the old "shadow"
  // default, a DB without its sleeve_modes row — restore, fresh install,
  // fork — would have started it in shadow with nobody deciding it). The
  // effective mode still lives in the sleeve_modes table (/healthz/full →
  // sleeveModes); the migrateOnce below is refused by the governor anyway.
  // Promotion recommendations are explicitly INELIGIBLE until the shadow
  // simulator gains hard-SL parity and this evidenceVersion is bumped.
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
    log.warn("momentum_crypto: platform_portfolios row disabled — engine NOT built (stop-loss loop and broker syncs keep running)");
  } else {
    governor.migrateOnce(
      "2026-07-16_momentum_crypto_shadow_default",
      "momentum_crypto",
      "shadow",
      "one-time migration: route new momentum_crypto targets to shadow (recent windows negative)",
    );
    governor.register({
      sleeve: "momentum_crypto",
      kind: "live",
      promotionEligible: false,
      evidenceVersion: "v8-crypto-no-hard-sl",
    });
    const cryptoPlan = momentumPlanFor("momentum_crypto");
    if (cryptoPlan.adapter.kind !== "binance_usdm") throw new Error("momentum_crypto plan: expected a binance_usdm adapter");
    const cryptoAdapter = new SwitchingAdapter(
      "momentum_crypto",
      governor,
      new BinanceMomentumAdapter(
        accountManager.executor.alpaca,
        accountManager.executor.binance,
        cryptoPlan.adapter.options,
      ),
      shadowFor("momentum_crypto", cryptoPlan.shadow),
      "momentum_crypto",
    );
    cryptoEngine = new MomentumEngine(
      // Engine config + provenance: momentumCryptoPortfolioPlan() above —
      // the factory plan is parity-locked to it (src/portfolios/parity.test.ts).
      cryptoPlan.engineConfig,
      cryptoAdapter,
      sleeveLogger(cryptoPlan.loggerContext),
      persistenceFor(cryptoPlan.statePersistence),
    );
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
      kind: "live",
      evidenceVersion: "v8.3-usdc-daily",
    });
    const usdcPlan = momentumPlanFor("momentum_crypto_usdc");
    if (usdcPlan.adapter.kind !== "binance_usdm") throw new Error("momentum_crypto_usdc plan: expected a binance_usdm adapter");
    const usdcAdapter = new SwitchingAdapter(
      "momentum_crypto_usdc",
      governor,
      new BinanceMomentumAdapter(
        accountManager.executor.alpaca,
        usdcExecutor,
        usdcPlan.adapter.options,
      ),
      shadowFor("momentum_crypto_usdc", usdcPlan.shadow),
      "momentum_crypto_usdc",
    );
    usdcEngine = new MomentumEngine(
      // Engine config + provenance: momentumUsdcPortfolioPlan() above —
      // the factory plan is parity-locked to it (src/portfolios/parity.test.ts).
      usdcPlan.engineConfig,
      usdcAdapter,
      sleeveLogger(usdcPlan.loggerContext),
      persistenceFor(usdcPlan.statePersistence),
    );
    handles.usdcEngine = usdcEngine;
    await usdcEngine.start();
    log.info("🚀 momentum_crypto_usdc engine started (daily rebalance 00:00 UTC, 24/7, max 5 positions)");
  }

  // 9a-btc. momentum_btc — COIN-M BTCUSD_PERP, single-symbol universe (only
  // one slot exists — maxLongs=1 is redundant but explicit), 2x leverage.
  // Wired only when the preflight above attached an executor.
  let coinmEngine: MomentumEngine | null = null;
  if (coinmExecutor && coinmLive && portfolioEnabled("momentum_btc")) {
    governor.register({
      sleeve: "momentum_btc",
      kind: "live",
      evidenceVersion: "v8.2-coinm-launch",
    });
    const coinmPlan = momentumPlanFor("momentum_btc");
    if (coinmPlan.adapter.kind !== "binance_coinm") throw new Error("momentum_btc plan: expected a binance_coinm adapter");
    const coinmAdapter = new SwitchingAdapter(
      "momentum_btc",
      governor,
      new BinanceCoinMMomentumAdapter(coinmExecutor, coinmPlan.adapter.options),
      shadowFor("momentum_btc", coinmPlan.shadow),
      "momentum_btc",
    );
    coinmEngine = new MomentumEngine(
      // Engine config: momentumBtcPortfolioPlan() above (parity-locked).
      coinmPlan.engineConfig,
      coinmAdapter,
      sleeveLogger(coinmPlan.loggerContext),
      persistenceFor(coinmPlan.statePersistence),
    );
    handles.coinmEngine = coinmEngine;
    await coinmEngine.start();
    log.info("🚀 momentum_btc engine started (60min rebalance, 24/7, single position)");
  }

  // 9b. Stocks sleeve — factory plan; config + provenance in
  // momentumStocksPortfolioPlan() above (parity-locked by
  // src/portfolios/parity.test.ts). NOT engine.start(): index.ts owns the
  // tick and ONLY fires it while the market is open — planRebalance on
  // stale/empty candles would close every position.
  let stocksEngine: MomentumEngine | null = null;
  if (!alpacaVenueLinked) {
    // F4b: registry mode without a linked alpaca account — no engine (see
    // the registry block above; logged + activity row there).
    log.warn("momentum_stocks: alpaca venue UNLINKED (ACCOUNTS_SOURCE=registry) — engine NOT built");
  } else if (!portfolioEnabled("momentum_stocks")) {
    // F3b: db mode, row disabled (owner action) — engine not built; the
    // 15s stop-loss loop, broker-native stops and syncs keep managing any
    // open rows for the shared Alpaca account.
    log.warn("momentum_stocks: platform_portfolios row disabled — engine NOT built (stop-loss loop, native stops and broker syncs keep running)");
  } else {
    const dailyHorizon = MOMENTUM_STOCKS_DAILY_HORIZON;
    const stocksPlan = momentumPlanFor("momentum_stocks");
    if (stocksPlan.adapter.kind !== "alpaca") throw new Error("momentum_stocks plan: expected an alpaca adapter");
    governor.register({
      sleeve: "momentum_stocks",
      kind: "live",
      evidenceVersion: "v8-stocks",
    });
    const stocksAdapter = new SwitchingAdapter(
      "momentum_stocks",
      governor,
      new AlpacaMomentumAdapter(accountManager.executor.alpaca, stocksPlan.adapter.options),
      shadowFor("momentum_stocks", stocksPlan.shadow),
      "momentum_stocks",
    );
    const stocks = new MomentumEngine(
      stocksPlan.engineConfig,
      stocksAdapter,
      sleeveLogger(stocksPlan.loggerContext),
      persistenceFor(stocksPlan.statePersistence),
    );
    stocksEngine = stocks;
    // index.ts owns this loop (engine.start() not called) so it registers the
    // name; stocksEngine.tick() beats it on a successful in-hours rebalance.
    // Daily-horizon mode registers at the daily cadence with the meanrev grace
    // (MeanRevEngine's own registration convention for a once-a-day loop).
    if (stocksPlan.heartbeat) {
      heartbeats.register(
        stocksPlan.heartbeat.name,
        stocksPlan.heartbeat.intervalMs,
        stocksPlan.heartbeat.graceMultiplier !== undefined ? { graceMultiplier: stocksPlan.heartbeat.graceMultiplier } : undefined,
      );
    }
    if (stocksPlan.scheduler.kind === "index-stocks-daily") {
      // ── Daily-horizon scheduler (opt-in) ─────────────────────────────
      // One pass per ET trading day at ≥ 09:35 (momentumStocksDailyTickDue —
      // the scheduleDailyStockRun discipline: decide on yesterday's COMPLETED
      // daily bar, fill after today's open). Marker file = once-a-day
      // idempotency across restarts; a throwing tick leaves the marker
      // unwritten, so the 60s interval retries until the pass completes —
      // and a persistently broken pass surfaces as a stale heartbeat page
      // (tick() only beats on a successful rebalance).
      const dailyMarkerPath = stocksPlan.scheduler.markerPath;
      let lastDailyKey = existsSync(dailyMarkerPath) ? readFileSync(dailyMarkerPath, "utf-8").trim() : "";
      let dailyRunning = false;
      // A failing pass retries every 60s — one ERROR log a minute never reaches
      // the logger's 10/60s burst threshold, and the 24h×5 heartbeat grace
      // would take days to notice. Page ops once per ET day after
      // DAILY_FAIL_PAGE_AFTER consecutive failed attempts (~10 min).
      const DAILY_FAIL_PAGE_AFTER = 10;
      let dailyFailStreak = 0;
      let dailyFailPagedKey = "";
      handles.stocksDailyInterval = setInterval(async () => {
        if (!momentumStocksDailyTickDue(Date.now(), lastDailyKey)) { heartbeats.beat("momentum:stocks"); return; }
        if (dailyRunning) return;
        dailyRunning = true;
        const todayKey = getETDateKey();
        try {
          await stocks.tick();
          const tmp = `${dailyMarkerPath}.tmp`;
          writeFileSync(tmp, todayKey);
          renameSync(tmp, dailyMarkerPath);
          lastDailyKey = todayKey;
          dailyFailStreak = 0;
        } catch (e: any) {
          dailyFailStreak++;
          momentumLog.error(`stocks daily tick failed (${dailyFailStreak}×): ${e?.message ?? e} — will retry`);
          if (dailyFailStreak >= DAILY_FAIL_PAGE_AFTER && dailyFailPagedKey !== todayKey) {
            dailyFailPagedKey = todayKey;
            eventBus.emit(EVENTS.ERROR_BURST, {
              context: "Momentum:stocks",
              message: `momentum_stocks daily pass failing ${dailyFailStreak}× in a row today (${e?.message ?? e}) — no decision taken yet; open positions keep their stops`,
              count: dailyFailStreak,
              windowMs: dailyFailStreak * 60_000,
              firstAt: Date.now() - dailyFailStreak * 60_000,
              lastAt: Date.now(),
            });
          }
        } finally {
          dailyRunning = false;
        }
      }, 60_000);
    } else {
    const stocksTick = () => {
      // Market closed: the loop is alive and correctly sitting out — beat so the
      // ×2 grace doesn't false-page overnight/weekends. In-hours, tick() beats on
      // success, so a throwing/wedged rebalance still goes stale and pages.
      if (!isMarketOpen()) { heartbeats.beat("momentum:stocks"); return; } // CRITICAL: never tick when the market is closed
      stocks.tick().catch((e: any) => momentumLog.error(`stocks tick failed: ${e?.message ?? e}`));
    };
    // Bar-close-aligned hourly scheduler (nextAlignedTickDelayMs, shared with
    // MomentumEngine.start()): ticks fire at each :00 boundary + 15s so the
    // decision reads the JUST-CLOSED hourly bar — the exact instant the
    // backtest decides on — instead of a boot-random phase re-randomized on
    // every deploy. Recursive setTimeout (not setInterval) re-anchors the
    // delay to the boundary each cycle; handles.stocksTickTimer is refreshed
    // every hop so shutdown always clears the CURRENT pending timeout.
    const scheduleStocksTick = () => {
      handles.stocksTickTimer = setTimeout(() => {
        stocksTick();
        scheduleStocksTick();
      }, nextAlignedTickDelayMs(Date.now(), 60));
    };
    scheduleStocksTick();
    // Early boot tick (30s, as before — positions need management after a
    // restart) only when the next aligned tick is far away (>5min); if a
    // boundary is imminent, the aligned tick IS the early tick.
    if (nextAlignedTickDelayMs(Date.now(), 60) > EARLY_BOOT_TICK_MIN_LEAD_MS) {
      setTimeout(stocksTick, 30_000); // first tick shortly after boot (if market open)
    }
    }
    // Past-split applied to DB rows/positions/native stops (AccountManager) →
    // rescale the trail watermarks too, or a pre-split peak (e.g. $1,200 across
    // a 10:1 split) fires a spurious TRAIL_STOP on the first ~$120 tick.
    // momentum_stocks is the only sleeve with tsmTrail (crypto perps don't
    // split); scaleMarksForSplit is a silent no-op for unmarked symbols.
    eventBus.on(EVENTS.CORPORATE_ACTION_APPLIED, ({ symbol, ratio }: { symbol: string; ratio: number }) => {
      stocks.scaleMarksForSplit(symbol, ratio);
    });
    log.info(dailyHorizon
      ? `🚀 momentum_stocks engine wired (DAILY-HORIZON mode: 1Day bars, h${dailyHorizon.lookbackDaysList ? dailyHorizon.lookbackDaysList.join('+') : dailyHorizon.lookbackDays}/ma${dailyHorizon.maLengthDays}, one pass per ET trading day ≥ 09:35)`
      : "🚀 momentum_stocks engine wired (60min tick, bar-close aligned, market hours only)");
  }

  // 9c. MeanRev stocks sleeve — daily RSI2 mean-reversion, one pass per ET
  // trading day shortly after the open (≥ 09:35, signals on yesterday's
  // completed daily bar). Kill switch: MEANREV_ENABLED=false.
  let meanrevInterval: ReturnType<typeof setInterval> | null = null;
  if (!alpacaVenueLinked) {
    log.warn("meanrev_stocks: alpaca venue UNLINKED (ACCOUNTS_SOURCE=registry) — engine NOT built");
  } else if (process.env.MEANREV_ENABLED !== "false" && portfolioEnabled("meanrev_stocks")) {
    governor.register({
      sleeve: "meanrev_stocks",
      kind: "live",
      evidenceVersion: "v8-meanrev",
    });
    const meanrevPlan = meanrevPlanFor("meanrev_stocks");
    const meanrevAdapter = new SwitchingAdapter(
      "meanrev_stocks",
      governor,
      new AlpacaMomentumAdapter(accountManager.executor.alpaca, meanrevPlan.adapter.options),
      shadowFor("meanrev_stocks", meanrevPlan.shadow),
      "meanrev_stocks",
    );
    const meanrevEngine = new MeanRevEngine(
      // Factory plan — engine config + provenance in
      // meanrevStocksPortfolioPlan() above (parity-locked by
      // src/portfolios/parity.test.ts). risk is re-asserted inline with the
      // IDENTICAL value the plan carries (a no-op spread) because
      // src/index.test.ts enforces the SLEEVE_LEDGER semantics on this
      // construction site itself: the two stock sleeves share one Alpaca
      // wallet, and one sleeve's drawdown must never pause the other.
      { ...meanrevPlan.engineConfig, risk: { equitySemantics: EQUITY_SEMANTICS.SLEEVE_LEDGER } },
      meanrevAdapter,
      sleeveLogger(meanrevPlan.loggerContext),
      undefined,
      persistenceFor(meanrevPlan.statePersistence),
    );
    const meanrevLabel = meanrevPlan.scheduler.kind === "index-meanrev-daily" ? meanrevPlan.scheduler.label : "meanrev";
    meanrevInterval = scheduleDailyStockRun(meanrevLabel, async ({ skipEntries }) => {
      const report = await meanrevEngine.runDaily({ skipEntries });
      for (const err of report.errors) momentumLog.warn(`meanrev: ${err}`);
      return report;
    });
    handles.meanrevInterval = meanrevInterval;
    log.info("🚀 meanrev_stocks engine wired (daily pass ≥ 09:35 ET)");
  } else {
    log.info("meanrev_stocks disabled (MEANREV_ENABLED=false or platform_portfolios row disabled)");
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
    if (stocksEngine) states.momentum_stocks = toCircuit(stocksEngine.getRiskState());
    if (usdcEngine) states.momentum_crypto_usdc = toCircuit(usdcEngine.getRiskState());
    if (coinmEngine) states.momentum_btc = toCircuit(coinmEngine.getRiskState());
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
  log.info(`📊 Daily Reports: 23:59 ET`);
  log.info("═══════════════════════════════════════");
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}
