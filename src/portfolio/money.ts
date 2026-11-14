// Owner-facing money contract. Consumers format these figures; they must not
// pick another anchor, turn unavailable into zero, or rename episode P&L cash.
import {
  getDB, getETWindowStart, getClosedEpisodeResult, getRecognizedRealizedPnl,
  getEquityWindowDisplay, getAssetBalances, getDisplayEquitySeries,
} from "../db/database";
import { AsyncLocalStorage } from "node:async_hooks";
import { ALL_PROFILE_IDS } from "../config/riskProfiles";
import { portfolioMainLegs, readDisplayMoneyWindow, getBrokerSnapshotNow } from "./truth";
import { computePnlBreakdown, computeRealizedAttribution, type BreakdownPosition, type RealizedAttribution } from "./pnlBreakdown";
import type { Database } from "bun:sqlite";
// @ts-ignore shared presentation reader, also used by the dashboard.
export { positionsTotals as readOpenMoney, outsideStrategies as readOutsideStrategies } from "../dashboard/public/v4/js/money-values.js";

export const MONEY_LABELS = {
  displayStart: "Desde el inicio",
  windowPnl: "Ganancia del período",
  realized: "Resultado de lo cerrado (desde la entrada)",
  closedEpisode: "Resultado de las operaciones cerradas",
  recognizedRealized: "Resultado de lo cerrado (incluye cierres parciales)",
  unrealized: "Sin cerrar (desde la entrada)",
} as const;

// DailyReporter's existing zero-argument callback is wired by index.ts. Keep
// the requested historical date across that callback without changing its
// signature or leaking a process-global clock into concurrent /status calls.
const reportDateContext = new AsyncLocalStorage<string>();
export const withMoneyReportDate = <T>(date: string, fn: () => T): T => reportDateContext.run(date, fn);
export const moneyReportDate = (): string | undefined => reportDateContext.getStore();

export function readMoneyWindow(opts: {
  days: number; now?: number; profiles?: string[]; accounts?: readonly string[];
  positions?: BreakdownPosition[]; hist?: Database | null; requireFresh?: boolean;
  closing?: RealizedAttribution;
}) {
  const now = opts.now ?? Date.now();
  const window = readDisplayMoneyWindow(opts.profiles ?? portfolioMainLegs(), opts.days, now, opts.requireFresh ?? true);
  const breakdown = computePnlBreakdown({ db: getDB(), hist: opts.hist ?? null, periodDays: opts.days,
    pnl: window?.pnl ?? null, openPositions: opts.positions ?? [], accountIds: opts.accounts ?? ALL_PROFILE_IDS,
    now, windowStart: opts.days === 0 ? window?.start.at : undefined, closing: opts.closing });
  return { window, breakdown, labels: MONEY_LABELS };
}

export function readSleeveMoney(id: string, now = Date.now(), hist: Database | null = null) {
  return {
    window: getEquityWindowDisplay(id, 0, now),
    closedEpisodeResult: getClosedEpisodeResult(id, 0, now),
    recognizedRealized: getRecognizedRealizedPnl(id),
    realizedToday: computeRealizedAttribution(getDB(), hist, getETWindowStart(1, now), now, [id]),
    realized7d: computeRealizedAttribution(getDB(), hist, getETWindowStart(7, now), now, [id]),
    labels: MONEY_LABELS,
  };
}

/** Only closes are cacheable. The position contribution must follow the
 * FRESH headline, never a P&L captured by the closes cache 30 seconds ago. */
export function tileMoney(pnl: number | null, closes: Pick<RealizedAttribution, "closedInWindow" | "closesCount" | "trimsCount" | "startPrices">) {
  const closedInWindow = closes.closedInWindow;
  return { ...closes, closedInWindow,
    positions: pnl == null || closedInWindow == null ? null : pnl - closedInWindow,
    rounded: pnl == null || closedInWindow == null ? null : {
      pnl: Math.round(pnl), closes: Math.round(closedInWindow),
      positions: Math.round(pnl) - Math.round(closedInWindow),
    } };
}

export interface BinanceMarginBreakdown {
  usdtFutures: number | null; usdcFutures: number | null;
  fapiBtcCollateral: number | null; coinmMargin: number | null;
}

/** Independent margin-pool equities, NOT wallet balance plus a residual
 * named USDT. Shared verbatim by broker cards and the Telegram digest. */
export function readBinanceMarginBreakdown(summaries: readonly { id: string; equity: number }[], now = Date.now()): BinanceMarginBreakdown {
  const byId = (id: string) => {
    const equity = summaries.find(s => s.id === id)?.equity;
    return typeof equity === "number" && Number.isFinite(equity) ? equity : null;
  };
  const btc = getAssetBalances("binance_testnet").find((a: any) => a.asset === "BTC");
  const at = btc ? Date.parse(String(btc.updated_at).replace(" ", "T") + "Z") : NaN;
  return {
    usdtFutures: byId("momentum_crypto"), usdcFutures: byId("momentum_crypto_usdc"),
    fapiBtcCollateral: btc && Number.isFinite(btc.usd_value) && at >= now - 600_000 ? btc.usd_value : null,
    coinmMargin: getBrokerSnapshotNow("coinm")?.equity ?? null,
  };
}

/** Observed drawdown, not a strategy pause threshold. Portfolio engines
 * have no incumbent RiskState file; measure their actual display history. */
export function readEquityDrawdown(profileId: string): number | null {
  const w = getEquityWindowDisplay(profileId, 0);
  if (!w) return null;
  let peak = 0;
  for (const r of getDisplayEquitySeries(profileId)) if (r.snapshot_time >= w.start.at && r.snapshot_time <= w.endAt) peak = Math.max(peak, r.equity);
  return peak > 0 ? Math.max(0, 1 - w.equity / peak) : null;
}
