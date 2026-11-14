// ═══ Profile management routes (v1 + v2) ═══

import express from "express";
import { readFileSync } from "fs";
import type { AccountManager } from "../../account/AccountManager";
import {
  getProfiles,
  getBrokerAccounts,
  getTradingStats, getAssetBalances, getEquityPnlDisplay, getDB, getETWindowStart,
  getClosedEpisodeResult, getRecognizedRealizedPnl,
} from "../../db/database";
import {
  getBrokerSnapshotNow, getPortfolioEquityNow,
  isMainSeriesApplicable, combineEquityPnlLegs, readDisplayMoneyWindow, portfolioMainLegs,
} from "../../portfolio/truth";
import { ALL_PROFILE_IDS, RISK_PROFILES, type RiskProfileId } from "../../config/riskProfiles";
import { toBoundedInt } from "../dashboard-utils";
import { cached } from "../cache";
import { computeRealizedAttribution, type BreakdownPosition, type RealizedAttribution } from "../../portfolio/pnlBreakdown";
import { readMoneyWindow, tileMoney, readBinanceMarginBreakdown, readEquityDrawdown, MONEY_LABELS } from "../../portfolio/money";
import { currentModelVersion } from "../../portfolio/modelVersions";
import { builtinPortfolio } from "../../portfolios/builtin";
import { openHistoricalReadonly } from "../../portfolio/scorecard";
import { DEFAULT_RISK_CONFIG, type RiskState } from "../../strategies/momentum/RiskGuard";

// ── Sleeve risk-state file reader (dashboard-only, READ-ONLY) ──────────────
// Each engine persists its own RiskState to one of these files (index.ts's
// fileStatePersistence — see MomentumEngine.persistState/MeanRevEngine
// persistState); this is just a read-only mirror for the dashboard so a
// "paused" sleeve shows WHY (cause + current DD vs soft/hard thresholds)
// instead of a bare chip. Never written here, never touches engine state.
export const SLEEVE_STATE_FILES: Partial<Record<RiskProfileId, string>> = {
  momentum_stocks: "data/momentum-state-stocks.json",
  momentum_crypto: "data/momentum-state-crypto.json",
  momentum_crypto_usdc: "data/momentum-state-usdc.json",
  momentum_btc: "data/momentum-state-btc.json",
  meanrev_stocks: "data/meanrev-state-stocks.json",
};

/** Reads a persisted RiskState from disk (envelope `{v:1,risk:...}` or the
 *  legacy flat shape — same two shapes fileStatePersistence up-converts).
 *  Returns null on anything missing/unreadable/malformed — never throws,
 *  never fabricates a value the file doesn't actually contain. */
export function readPersistedRiskState(filePath: string): Pick<RiskState, "peakEquity" | "dayStartEquity" | "consecutiveLosses" | "pausedUntil" | "pauseReason"> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    const risk = parsed && typeof parsed === "object" && parsed.risk ? parsed.risk : parsed;
    if (!risk || typeof risk.peakEquity !== "number") return null;
    return {
      peakEquity: risk.peakEquity,
      dayStartEquity: risk.dayStartEquity ?? 0,
      consecutiveLosses: risk.consecutiveLosses ?? 0,
      pausedUntil: risk.pausedUntil ?? 0,
      pauseReason: risk.pauseReason ?? "",
    };
  } catch { return null; }
}

/**
 * Combine per-sleeve getTradingStats results into one broker-card aggregate:
 * counts and P&L sum; win rates re-derive from summed wins / summed CLOSED
 * counts (a weighted average — never an average of percentages).
 */
function combineStats(list: ReturnType<typeof getTradingStats>[]) {
  const sum = (k: string) => list.reduce((s, x: any) => s + (x[k] ?? 0), 0);
  const closed = sum("closedTrades");
  const wins = sum("winningTrades");
  const todayClosed = sum("todayClosedTrades");
  const todayWins = sum("todayWins");
  const periodClosed = sum("periodClosedTrades");
  const periodWins = sum("periodWins");
  return {
    totalTrades: sum("totalTrades"),
    closedTrades: closed,
    openTrades: sum("openTrades"),
    winningTrades: wins,
    winRate: closed > 0 ? (wins / closed) * 100 : 0,
    totalPnl: sum("totalPnl"),
    todayTrades: sum("todayTrades"),
    todayClosedTrades: todayClosed,
    todayWinRate: todayClosed > 0 ? (todayWins / todayClosed) * 100 : -1,
    todayPnl: sum("todayPnl"),
    periodDays: list[0]?.periodDays ?? 1,
    periodPnl: sum("periodPnl"),
    periodTrades: sum("periodTrades"),
    periodClosedTrades: periodClosed,
    periodWinRate: periodClosed > 0 ? (periodWins / periodClosed) * 100 : -1,
  };
}

/** The tile subline's figures for one window: closes + positions == the
 *  headline exactly (positions = pnl − closedInWindow). null figures when a
 *  needed start price is missing — the tile then shows only the counts. */
export interface TileBreakdown {
  closedInWindow: number | null;
  positions: number | null;
  closesCount: number;
  trimsCount: number;
  startPrices: "marks" | "bars";
  realized: number;
  rounded: { pnl: number; closes: number; positions: number } | null;
}

/** One attribution per window, shared by the tiles (/api/v2/profiles) and the
 *  modal (/api/v2/pnl-breakdown). G-1 (2026-11-07): only the CLOSES are cached
 *  (30s — the bridge walks the portfolio journals); the headline and the open
 *  book are read fresh on every request, so "positions" = headline − closes
 *  can never carry a P&L the cache captured 30 seconds ago. */
function breakdownFor(am: AccountManager, periodDays: number, now = Date.now()) {
  const start = periodDays === 0
    ? readDisplayMoneyWindow(portfolioMainLegs(), 0, now)?.start.at ?? 0
    : getETWindowStart(periodDays, now);
  // Only closes are cached; every request reads its headline and open book.
  const closing: RealizedAttribution = cached(`money_closes_${periodDays}_${start}`, 30_000, () => {
    const hist = openHistoricalReadonly();
    try { return computeRealizedAttribution(getDB(), hist, start, now); }
    finally { hist?.close(); }
  });
  const openPositions: BreakdownPosition[] = (am.getConsolidatedState?.()?.positions || []).map((p: any) => ({
    accountId: p.profileId, symbol: p.symbol, market: p.market, side: p.side, quantity: p.quantity,
    entryPrice: p.avgEntryPrice, entryTime: p.openedAt, currentPrice: p.currentPrice,
  }));
  const hist = openHistoricalReadonly();
  try {
    const { window, breakdown: b } = readMoneyWindow({ days: periodDays, now, hist, positions: openPositions, closing });
    // The modal lists the largest legs; the counts keep the full totals.
    const closes = [...b.closes].sort((x, y) => Math.abs(y.realized ?? 0) - Math.abs(x.realized ?? 0)).slice(0, 20);
    return { ...b, closes, pnlPct: window?.pnlPct ?? null, displayStart: window?.start ?? null,
      rounded: tileMoney(b.pnl, b).rounded, labels: MONEY_LABELS, generatedAt: now };
  } finally {
    try { hist?.close(); } catch {}
  }
}

function tileBreakdown(am: AccountManager, periodDays: number, now: number, pnl: number | null): TileBreakdown | null {
  try {
    const b = breakdownFor(am, periodDays, now);
    return { ...tileMoney(pnl, { closedInWindow: b.closedInWindow, closesCount: b.closesCount, trimsCount: b.trimsCount, startPrices: b.startPrices }), realized: b.realized };
  } catch { return null; }
}

export function registerProfileRoutes(app: express.Application, am: AccountManager): void {
  // ── GET /api/v2/profiles ────────────────────────────────────────────────
  app.get("/api/v2/profiles", async (req, res) => {
    try {
      // Dashboard time filter: ?days=1 (today) | 7 | 30 | 0 (all-time) …
      const periodDays = toBoundedInt(req.query.days, 1, 0, 365);
      const now = Date.now();
      const profiles = getProfiles();
      const result   = [];
      const db = require("../../db/database").getDB();

      // Portfolio-wide aggregate (mandate 2026-07-19): Total Equity / Top
      // P&L / fixed 7D P&L all read from THIS one canonical figure, combining
      // every APPLICABLE *_main leg (alpaca_main + binance_main +
      // binance_coinm_main once DAPI has ever synced) — never a per-broker
      // frontend recombination. Computed once (account-wide, not per dashboard
      // profile row) and attached identically to every `result` entry; this
      // bot only ever runs the single "default" profile in practice.
      const aggLegs = portfolioMainLegs();
      const aggPeriod = readDisplayMoneyWindow(aggLegs, periodDays, now);
      const aggPnl7d  = readDisplayMoneyWindow(aggLegs, 7, now);
      const sinceStart = periodDays === 0 ? aggPeriod : readDisplayMoneyWindow(aggLegs, 0, now);
      // Realized (closed-trade) P&L over the SAME windows (since entry — the
      // older sub-line; kept for older readers) and the same-window bridge the
      // tiles show now: closes + positions == the headline (2026-11-06; the
      // since-entry figure read as a contradiction next to the equity delta).
      // Full attribution: /api/v2/pnl-breakdown.
      const periodBreakdown = tileBreakdown(am, periodDays, now, aggPeriod?.pnl ?? null);
      const breakdown7d = periodDays === 7 ? periodBreakdown : tileBreakdown(am, 7, now, aggPnl7d?.pnl ?? null);
      const pnlAggregate = {
        equity: getPortfolioEquityNow().total,
        displayStart: sinceStart?.start ?? null,
        sinceStart,
        labels: MONEY_LABELS,
        periodPnl: aggPeriod?.pnl ?? null,
        // The All tile IS the since-start figure: same percentage as its sub-line.
        periodPnlPct: aggPeriod?.pnlPct ?? (periodDays === 0 ? aggPeriod?.pnlPctOnStart ?? null : null),
        pnl7d: aggPnl7d?.pnl ?? null,
        pnl7dPct: aggPnl7d?.pnlPct ?? null,
        periodRealized: periodBreakdown?.realized ?? null,
        periodRealizedCount: periodBreakdown ? periodBreakdown.closesCount + periodBreakdown.trimsCount : null,
        realized7d: breakdown7d?.realized ?? null,
        realized7dCount: breakdown7d ? breakdown7d.closesCount + breakdown7d.trimsCount : null,
        closedEpisodeResult: getClosedEpisodeResult(),
        periodBreakdown,
        breakdown7d,
      };

      for (const p of profiles) {
        const accounts   = getBrokerAccounts(p.id);
        let totalEquity  = 0, totalPnl = 0, openPositions = 0;
        const seenBrokers = new Set<string>();
        const brokerAccountsData: any[] = [];

        for (const ba of accounts) {
          if (seenBrokers.has(ba.broker_id)) continue;
          seenBrokers.add(ba.broker_id);

          const isBinance  = ba.broker_id.includes("binance");
          const brokerBase = isBinance ? "binance" as const : "alpaca" as const;
          // Broker truth = latest *_main snapshot via portfolio/truth — the
          // `accounts` table equity/cash are DEPRECATED (nothing writes them
          // since v8; they served frozen Jul 9 values).
          const brokerSnap = getBrokerSnapshotNow(brokerBase);
          // Header/KPI Binance total = FAPI main + DAPI main (mandate
          // 2026-07-19), each *_main freshness-gated independently —
          // momentum_btc/COIN-M never having been enabled at all (never
          // applicable — see isMainSeriesApplicable) degrades gracefully to
          // just the FAPI figure. But once DAPI IS applicable (has ever
          // synced), a currently stale/disconnected read fails the WHOLE
          // card closed instead of silently reporting the FAPI-only partial
          // as if it were the full Binance total (2026-07-19 reviewer fix).
          const coinmApplicable = isMainSeriesApplicable("coinm");
          const coinmSnap  = isBinance ? getBrokerSnapshotNow("coinm") : null;
          const coinmFailedClosed = isBinance && coinmApplicable && coinmSnap == null;
          const equity     = brokerSnap == null || coinmFailedClosed ? null : brokerSnap.equity + (coinmSnap?.equity ?? 0);
          const cash       = brokerSnap == null || coinmFailedClosed ? null : brokerSnap.cash + (coinmSnap?.cash ?? 0);
          // Current sleeves per broker. Keep this registry-driven: new
          // certified Binance wallets must appear without another dashboard
          // hardcode, while shadow/legacy/sync rows stay excluded.
          const sleeveIds = ALL_PROFILE_IDS.filter((id) => {
            const broker = RISK_PROFILES[id].broker;
            return isBinance ? broker.startsWith("binance") : broker === "alpaca";
          });
          const openCount  = db.prepare(
            `SELECT COUNT(*) as c FROM trades WHERE status = 'open' AND account_id IN (${sleeveIds.map(() => "?").join(",")})`
          ).get(...sleeveIds) as any;
          const assets     = isBinance ? getAssetBalances(ba.broker_id) : [];
          // Binance margin decomposition (mandate 2026-07-19): four
          // INDEPENDENTLY-sourced components, never derived by decomposing
          // `equity` after the fact ("do not start from total then add
          // assets"). Each null when its sleeve/asset row is unavailable —
          // the frontend sums only the present ones and labels exactly what
          // it included. Sourced from am.getAccountSummaries() (live
          // sub-wallet broker-truth reads, one per Binance product) + the
          // FAPI account's own per-asset breakdown (broker_asset_balances,
          // refreshed by BrokerSync from the SAME default USDT executor).
          const marginBreakdown = isBinance ? readBinanceMarginBreakdown(am.getAccountSummaries?.() ?? [], now) : null;
          const sleeveStats = sleeveIds.map(id => getTradingStats(id, periodDays));
          const stats      = combineStats(sleeveStats);
          const stratConfig = ba.strategy_config ? JSON.parse(ba.strategy_config) : {};
          const perAccountStats: Record<string, any> = {};
          sleeveIds.forEach((id, i) => {
            // periodEquityPnl = equity-based P&L (open+closed) for the window;
            // the frontend prefers it over the closed-only periodPnl. Pct
            // fields ride along so the frontend never has to divide itself
            // (null when the display anchor was rebased — see getEquityPnlDisplay).
            const periodEq = getEquityPnlDisplay(id, periodDays);
            const eq7d     = getEquityPnlDisplay(id, 7);
            perAccountStats[id] = {
              ...sleeveStats[i],
              periodEquityPnl: periodEq?.pnl ?? null,
              periodEquityPnlPct: periodEq?.pnlPct ?? null,
              equityPnl7d: eq7d?.pnl ?? null,
              equityPnl7dPct: eq7d?.pnlPct ?? null,
            };
          });

          // R3 fix (2026-05-10): use the broker-truth _main snapshot as the
          // first equity anchor so the broker cards' "Total P&L %" uses the
          // same baseline as the consolidated KPI ("Since Start") — via
          // portfolio/truth. No sleeve/account fallback: broker truth may be
          // unavailable before the first _main snapshot.
          //
          // 2026-07-21 fix: `equity` above (line ~108) is binance_main +
          // coinm (when coinmApplicable), but firstEquity was binance_main
          // ONLY — the frontend's all-time % = equity − firstEquity, so the
          // entire current COIN-M balance was showing up as Binance profit.
          // Sum the SAME legs here so the anchor matches what's displayed.
          const mainLegs = isBinance && coinmApplicable ? ["binance_main", "binance_coinm_main"] : [`${brokerBase}_main`];
          const brokerStart = readDisplayMoneyWindow(mainLegs, 0, now, false)?.start ?? null;
          const brokerSinceStart = readDisplayMoneyWindow(mainLegs, 0, now);
          const firstEquity = brokerStart?.equity ?? null;
          const startedAt = brokerStart?.at ?? Infinity;

          // Authoritative full-broker equity delta for the selected window and
          // the fixed 7D window — sourced from `${brokerBase}_main` broker-
          // truth snapshots, pnl + pnl% together (no frontend division). For
          // Binance, DAPI's own movement is folded in once it's applicable
          // (mandate 2026-07-19: "add DAPI movement to P&L") via the same
          // fail-closed combine as the equity figure above — never a partial
          // FAPI-only P&L once COIN-M has ever synced.
          const periodEq = combineEquityPnlLegs(mainLegs, periodDays, now);
          const eq7d      = combineEquityPnlLegs(mainLegs, 7, now);

          brokerAccountsData.push({
            id: ba.id,
            displayName: ba.display_name,
            brokerId: ba.broker_id,
            equity,
            availableCash: cash,
            // Wave 6: real unrealized PnL from live bot positions (not the
            // equity−cash proxy, which is market value for broker-truth rows).
            unrealizedPnl: am.getBrokerUnrealizedPnl(brokerBase),
            openPositions: openCount?.c || 0,
            startedAt: startedAt < Infinity ? startedAt : null,
            daysRunning: startedAt < Infinity ? Math.max(1, Math.floor((Date.now() - startedAt) / 86400000)) : 0,
            // Was accounts.initial_equity (set once at first sync insert = the
            // first observed broker equity) — same anchor, live source now.
            initialEquity: firstEquity,
            firstEquity,
            displayStart: brokerStart,
            sinceStart: brokerSinceStart,
            labels: MONEY_LABELS,
            status: am.executor[ba.broker_id.includes("binance") ? "binance" : "alpaca"]?.isConnected?.() ? "connected" : "disconnected",
            marginBreakdown,
            assets: assets.map((a: any) => ({
              asset: a.asset, balance: a.balance, usdValue: a.usd_value,
              pctOfTotal: equity != null && equity > 0 ? (a.usd_value / equity * 100) : 0,
            })),
            strategies: stratConfig.strategies || [],
            perAccountStats,
            stats: {
              totalTrades: stats.totalTrades, closedTrades: stats.closedTrades,
              openTrades: stats.openTrades, todayTrades: stats.todayTrades,
              winRate: stats.winRate, todayPnl: stats.todayPnl, totalPnl: stats.totalPnl,
              // Dashboard time filter (periodDays=1 ⇒ same as today*).
              periodDays: stats.periodDays, periodPnl: stats.periodPnl,
              periodTrades: stats.periodTrades, periodWinRate: stats.periodWinRate,
              // Equity-based P&L (open+closed) over the window, from broker-truth
              // *_main snapshots. The KPI/cards prefer this over closed periodPnl.
              periodEquityPnl: periodEq?.pnl ?? null,
              periodEquityPnlPct: periodEq?.pnlPct ?? null,
              // Fixed 7-day window for the always-visible "7D P&L" KPI,
              // independent of the selected period. Same source as above.
              equityPnl7d: eq7d?.pnl ?? null,
              equityPnl7dPct: eq7d?.pnlPct ?? null,
            },
          });

          totalEquity   += equity ?? 0;
          totalPnl      += stats.totalPnl;
          openPositions += openCount?.c || 0;
        }

        const botStart     = db.prepare("SELECT MIN(snapshot_time) as t FROM equity_snapshots WHERE synthetic = 0").get() as any;
        const botStartedAt = botStart?.t || Date.now();
        const botDaysRunning = Math.max(1, Math.floor((Date.now() - botStartedAt) / 86400000));

        result.push({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          totalEquity: brokerAccountsData.every(ba => ba.equity != null) ? totalEquity : null,
          startedAt: botStartedAt,
          daysRunning: botDaysRunning,
          dailyPnl: brokerAccountsData.reduce((s: number, ba: any) => s + ba.stats.todayPnl, 0),
          totalPnl,
          winRate: (() => {
            // Weight by CLOSED trades — totalTrades counts open rows, which
            // have no outcome yet and would dilute the rate.
            const totals = brokerAccountsData.reduce(
              (a: any, ba: any) => ({ t: a.t + ba.stats.closedTrades, w: a.w + ba.stats.closedTrades * ba.stats.winRate / 100 }),
              { t: 0, w: 0 }
            );
            return totals.t > 0 ? (totals.w / totals.t * 100) : 0;
          })(),
          openPositions,
          brokerAccounts: brokerAccountsData,
          pnlAggregate,
        });
      }

      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/v2/pnl-breakdown?days=N (2026-09-29) ───────────────────────
  // Why the period P&L differs from what was realized in it: every reducing
  // leg in the window since entry, the part of it earned BEFORE the window,
  // the open positions' in-window move and the holding residual
  // (src/portfolio/pnlBreakdown.ts). `pnl` is the same combineEquityPnlLegs
  // figure the KPI shows. On demand (the modal behind the KPI figure), the
  // same cached computation the tiles' sublines read.
  app.get("/api/v2/pnl-breakdown", (req, res) => {
    try {
      const periodDays = toBoundedInt(req.query.days, 7, 0, 365);
      res.json(breakdownFor(am, periodDays));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/v2/sleeves/risk (2026-09-24) ───────────────────────────────
  // Per-sleeve WHY-paused detail for the broker modal: state (live/paused),
  // cause, current DD vs the soft/hard thresholds RiskGuard actually
  // enforces (DEFAULT_RISK_CONFIG — the same constants evaluateRisk uses),
  // resume ETA, and realized vs unrealized P&L. Gross/cap utilization is
  // already derivable client-side from dashboard.accounts + open positions
  // (positions.js sleeveExposure) — not duplicated here.
  app.get("/api/v2/sleeves/risk", (_req, res) => {
    try {
      const circuits = am.getCircuits();
      const summaries = am.getAccountSummaries();
      const result = summaries.map((s: any) => {
        const id = s.id as RiskProfileId;
        const circuit = circuits[id] ?? { paused: false, reason: "", resumeAt: 0 };
        // G-2 (2026-11-07): what the modal shows is a MEASURE, never a pause
        // threshold. A portfolio-engine sleeve has no incumbent RiskState
        // file (the October files are fossils): its drawdown is read from
        // its own equity history; a risk.mode=sizeOnly sleeve has no
        // soft/hard/daily caps (nothing pauses), so those are null.
        const portfolioEngine = currentModelVersion(id)?.engine === "portfolio";
        let params: any = {};
        try {
          params = builtinPortfolio(id).params ?? {};
          if (process.env.PORTFOLIOS_SOURCE === "db" && getDB().query("SELECT 1 FROM sqlite_master WHERE name='platform_portfolios'").get()) {
            const row = getDB().query("SELECT params_json FROM platform_portfolios WHERE id=?").get(id) as { params_json: string } | null;
            if (row) params = JSON.parse(row.params_json) ?? {};
          }
        } catch { params = {}; }
        const sizeOnly = params?.risk?.mode === "sizeOnly";
        const file = SLEEVE_STATE_FILES[id];
        const persisted = !portfolioEngine && file ? readPersistedRiskState(file) : null;
        const currentEquity = s.equity;
        const ddPct = portfolioEngine ? readEquityDrawdown(id) : persisted && persisted.peakEquity > 0 && Number.isFinite(currentEquity)
          ? Math.max(0, (persisted.peakEquity - currentEquity) / persisted.peakEquity) : null;
        const dailyLossPct = persisted && persisted.dayStartEquity > 0 && Number.isFinite(currentEquity)
          ? (persisted.dayStartEquity - currentEquity) / persisted.dayStartEquity : null;
        const mode: "live" | "paused" = circuit.paused ? "paused" : "live";
        return {
          id,
          label: s.label,
          broker: s.broker,
          mode,
          paused: circuit.paused,
          reason: circuit.reason || null,
          resumeAt: circuit.resumeAt || null,
          // API: percentages are fractions (0.1 = 10%). A measure is not a
          // pause threshold: PE/sizeOnly have null soft/hard/daily caps.
          riskMode: portfolioEngine ? "portfolio" : sizeOnly ? "sizeOnly" : "pause",
          drawdown: { currentPct: ddPct, softPct: portfolioEngine || sizeOnly ? null : DEFAULT_RISK_CONFIG.softDrawdownPct,
            hardPct: portfolioEngine || sizeOnly ? null : DEFAULT_RISK_CONFIG.hardDrawdownPct },
          dailyLoss: { currentPct: dailyLossPct, capPct: portfolioEngine || sizeOnly ? null : DEFAULT_RISK_CONFIG.dailyLossCapPct },
          consecutiveLosses: persisted?.consecutiveLosses ?? null,
          lossLimit: portfolioEngine || sizeOnly ? null : DEFAULT_RISK_CONFIG.consecutiveLossLimit,
          equity: currentEquity,
          // Closed-trade P&L (reconcile rows excluded) — NOT the summary's
          // totalPnl, which is equity − initial equity and so already
          // includes the open positions' unrealized P&L (prod 2026-09-25:
          // momentum_stocks showed "Realized +$5.5k" while its closed trades
          // summed −$1.45k).
          // A-2 (2026-11-07): "Realized" = closed episodes + the partial legs
          // of rows still open (sleeveRealizedPnl, the ledger the engine
          // sizes with). Closed-only read "+$200" while the ledger's net
          // realized was −$23 (prod 2026-11-07).
          realizedPnl: getRecognizedRealizedPnl(id),
          realizedLabel: MONEY_LABELS.recognizedRealized,
          closedEpisodeResult: getClosedEpisodeResult(id),
          labels: MONEY_LABELS,
        };
      });
      res.json({ sleeves: result, generatedAt: Date.now() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

}
