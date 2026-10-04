// ══════════════════════════════════════════════
// Portfolio truth — THE single source for "how much money is there".
//
// Every consumer that displays or aggregates equity (dashboard KPIs, Telegram
// digest//status//profits, broker cards) MUST go through this module. The
// recurring "portfolio sums are wrong" bug class (6 recurrences) was always
// one of: (a) two sources of truth for the same number, (b) mixed-semantics
// snapshot history poisoning anchors, (c) copied aggregation logic drifting,
// (d) stale-but-readable tables (the dead `accounts` equity/cash columns).
//
// Rules enforced here + by src/portfolio/no-stale-account-reads.test.ts:
//   • Broker totals   = LATEST alpaca_main / binance_main equity_snapshots.
//   • Sleeve equity   = LATEST sleeve snapshot (ledger for shared-wallet
//                       Alpaca sleeves, broker truth for momentum_crypto).
//   • Operational anchors stay in the CURRENT EQUITY_SEMANTICS era; dashboard
//     "Since start" uses the separate, explicitly rebased display history.
//   • NEVER the `accounts` table — its equity/cash are deprecated since v8.
// ══════════════════════════════════════════════

import { createLogger } from "../utils/logger";
import {
  getDB, getEquityAt, getTradingStats, getOpenTrades,
  insertActivity, readSemantics, getEquityDisplayStart, getEquityPnlDisplay,
} from "../db/database";
import {
  RISK_PROFILES, ALL_PROFILE_IDS, BROKER_MAIN_SERIES, LEDGER_SLEEVE_BROKERS,
  type RiskProfileId,
} from "../config/riskProfiles";

const log = createLogger("PortfolioTruth");

/** Broker-truth snapshot series per broker-truth key. `coinm` = the DAPI
 *  COIN-M ledger (binance_coinm_main) — a genuinely separate account from
 *  `binance` (FAPI/binance_main), see BROKER_MAIN_SERIES in riskProfiles.ts. */
export const MAIN_SERIES = { alpaca: "alpaca_main", binance: "binance_main", coinm: "binance_coinm_main" } as const;
export type BrokerKey = keyof typeof MAIN_SERIES;
/** Reverse lookup: *_main profile id -> its BrokerKey (undefined for a sleeve id). */
const BROKER_BY_MAIN_SERIES: Partial<Record<string, BrokerKey>> = Object.fromEntries(
  (Object.entries(MAIN_SERIES) as [BrokerKey, string][]).map(([broker, id]) => [id, broker]),
);
export const BROKER_SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
const brokerRefreshAt: Record<BrokerKey, number | null> = { alpaca: null, binance: null, coinm: null };

/** Live syncs invalidate persisted truth immediately when a broker read fails. */
export function setBrokerTruthAvailable(broker: BrokerKey, available: boolean): void {
  brokerRefreshAt[broker] = available ? Date.now() : null;
}

/** Whether a live refresh has succeeded recently enough to persist its cache. */
export function isBrokerTruthAvailable(broker: BrokerKey): boolean {
  const refreshedAt = brokerRefreshAt[broker];
  return typeof refreshedAt === "number" && refreshedAt >= Date.now() - BROKER_SNAPSHOT_MAX_AGE_MS;
}

/** Latest broker-truth snapshot for one broker (equity + free cash + time). */
export function getBrokerSnapshotNow(broker: BrokerKey): { equity: number; cash: number; at: number } | null {
  const refreshedAt = brokerRefreshAt[broker];
  if (refreshedAt === null || refreshedAt < Date.now() - BROKER_SNAPSHOT_MAX_AGE_MS) return null;
  const row = getDB().prepare(
    `SELECT equity, cash, snapshot_time AS at FROM equity_snapshots
     WHERE profile_id = ? AND semantics = ? AND synthetic = 0 ORDER BY snapshot_time DESC LIMIT 1`
  ).get(MAIN_SERIES[broker], readSemantics(MAIN_SERIES[broker])) as { equity: number; cash: number; at: number } | undefined;
  if (!row || row.at < Date.now() - BROKER_SNAPSHOT_MAX_AGE_MS) return null;
  return row;
}

/** First broker-truth equity observation (current semantics era only). */
export function getBrokerFirstEquity(broker: BrokerKey): number | null {
  return getEquityAt(MAIN_SERIES[broker], 0);
}

/**
 * Whether a *_main series should be REQUIRED (fail-closed when stale/missing)
 * in consolidated math. alpaca/binance always are (unconditional legs since
 * v8). `coinm` (binance_coinm_main) only becomes required once it has
 * recorded its first-ever snapshot — i.e. momentum_btc/DAPI has actually been
 * turned on at least once. Before that, a COIN-M sleeve that has NEVER
 * existed must not blank out the whole portfolio total; it contributes $0
 * and is silently excluded, exactly as if the feature didn't exist. Once it
 * has a first snapshot, staleness/loss of live truth thereafter correctly
 * fails the total closed (mandate: "DAPI main stale/missing => fail closed
 * total, not partial") instead of quietly reporting a partial number.
 *
 * Exported so dashboard routes (routes/profiles.ts, routes/strategies.ts)
 * apply the IDENTICAL applicability rule to derived per-broker figures
 * (card equity, period/7D P&L, the consolidated equity curve) instead of
 * re-deriving their own "has coinm ever synced" check.
 */
export function isMainSeriesApplicable(broker: BrokerKey): boolean {
  return broker !== "coinm" || getBrokerFirstEquity("coinm") != null;
}

/** DISPLAY-only first broker-truth observation — spans every configured-
 *  rebase era (unlike getBrokerFirstEquity, current-era-only). Dashboard/
 *  Telegram "Since Start" only; never the invariant checker. */
export function getBrokerFirstEquityDisplay(broker: BrokerKey): { equity: number; rebased: boolean } | null {
  return getEquityDisplayStart(MAIN_SERIES[broker]);
}

/** Portfolio equity right now = alpaca_main + binance_main + binance_coinm_main
 *  (each exactly once). Null total until every APPLICABLE leg has a fresh
 *  snapshot — see isMainSeriesApplicable for why a never-enabled COIN-M
 *  sleeve doesn't block the other two. */
export function getPortfolioEquityNow(): { total: number | null; alpaca: number | null; binance: number | null; coinm: number | null } {
  const alpaca = getBrokerSnapshotNow("alpaca")?.equity ?? null;
  const binance = getBrokerSnapshotNow("binance")?.equity ?? null;
  const coinmApplicable = isMainSeriesApplicable("coinm");
  const coinm = coinmApplicable ? (getBrokerSnapshotNow("coinm")?.equity ?? null) : null;
  const failed = alpaca == null || binance == null || (coinmApplicable && coinm == null);
  return { total: failed ? null : alpaca + binance + (coinm ?? 0), alpaca, binance, coinm };
}

/** Portfolio equity at the start of the current semantics era (since-start anchor). */
export function getPortfolioEquityStart(): { total: number | null; alpaca: number | null; binance: number | null; coinm: number | null } {
  const alpaca = getBrokerFirstEquity("alpaca");
  const binance = getBrokerFirstEquity("binance");
  const coinmApplicable = isMainSeriesApplicable("coinm");
  const coinm = coinmApplicable ? getBrokerFirstEquity("coinm") : null;
  const failed = alpaca == null || binance == null || (coinmApplicable && coinm == null);
  return { total: failed ? null : alpaca + binance + (coinm ?? 0), alpaca, binance, coinm };
}

/** DISPLAY-only portfolio "since start" — spans every configured-rebase era
 *  (unlike getPortfolioEquityStart, current-era-only). `rebased` is true if
 *  reaching any applicable broker's start point required a configured
 *  cross-era offset — callers should then suppress a synthetic-basis
 *  percentage (see getSinceStartPct). Dashboard performance only; never
 *  invariants. */
export function getPortfolioEquityStartDisplay(): { total: number | null; alpaca: number | null; binance: number | null; coinm: number | null; rebased: boolean } {
  const alpaca = getBrokerFirstEquityDisplay("alpaca");
  const binance = getBrokerFirstEquityDisplay("binance");
  const coinmApplicable = isMainSeriesApplicable("coinm");
  const coinm = coinmApplicable ? getBrokerFirstEquityDisplay("coinm") : null;
  const failed = alpaca == null || binance == null || (coinmApplicable && coinm == null);
  return {
    total: failed ? null : alpaca.equity + binance.equity + (coinm?.equity ?? 0),
    alpaca: alpaca?.equity ?? null,
    binance: binance?.equity ?? null,
    coinm: coinm?.equity ?? null,
    rebased: (alpaca?.rebased ?? false) || (binance?.rebased ?? false) || (coinm?.rebased ?? false),
  };
}

/** Latest persisted sleeve equity (ledger snapshot; broker truth for crypto). */
export function getSleeveEquityNow(id: RiskProfileId | string): number | null {
  return getEquityAt(id, Date.now());
}

/** DISPLAY-only per-sleeve starting-equity anchor — spans every configured-
 *  rebase era (only momentum_crypto has one configured; every other sleeve
 *  is identical to getSleeveEquityStart). Dashboard performance only. */
export function getSleeveEquityStartDisplay(id: RiskProfileId | string): { equity: number; rebased: boolean } | null {
  return getEquityDisplayStart(id);
}

/** Sleeve all-time % on the LEDGER basis: latest sleeve equity vs its configured allocation. */
export function getSleevePct(id: RiskProfileId): number | null {
  const initial = RISK_PROFILES[id]?.initialEquity;
  const eq = getSleeveEquityNow(id);
  if (eq == null || !initial) return null;
  return ((eq - initial) / initial) * 100;
}

/** Portfolio since-start % — DISPLAY-only, spans every configured-rebase era
 *  (unlike getPortfolioEquityStart's total, current-era-only) vs the latest
 *  *_main snapshots. Null when either broker's live truth is stale/missing,
 *  OR when reaching the start point required a configured rebase — the %
 *  would otherwise divide by a synthetically-shifted basis. */
export function getSinceStartPct(): number | null {
  const start = getPortfolioEquityStartDisplay();
  const now = getPortfolioEquityNow().total;
  if (start.total == null || now == null || start.total <= 0 || start.rebased) return null;
  return ((now - start.total) / start.total) * 100;
}

/** Mark-to-market day P&L over both fresh *_main series (ET-midnight anchored).
 *  Uses the DISPLAY equity P&L (getEquityPnlDisplay) so a same-day rebase
 *  boundary can't fabricate a jump, but keeps the same live-freshness gate as
 *  before: no reading a stale broker series just because its display history
 *  happens to look continuous. */
export function getTodayPnl(): number | null {
  if (!getBrokerSnapshotNow("alpaca") || !getBrokerSnapshotNow("binance")) return null;
  const a = getEquityPnlDisplay(MAIN_SERIES.alpaca, 1);
  const b = getEquityPnlDisplay(MAIN_SERIES.binance, 1);
  if (a == null || b == null) return null;
  const coinmApplicable = isMainSeriesApplicable("coinm");
  if (!coinmApplicable) return a.pnl + b.pnl;
  if (!getBrokerSnapshotNow("coinm")) return null;
  const c = getEquityPnlDisplay(MAIN_SERIES.coinm, 1);
  if (c == null) return null;
  return a.pnl + b.pnl + c.pnl;
}

/**
 * Combine several DISPLAY equity series (by profile id — e.g. two or three
 * of the *_main broker-truth series) into ONE dollar pnl + weighted pct for
 * `periodDays`. Used for both a single broker's own multi-wallet total (FAPI
 * + DAPI on the Binance card) and the portfolio-wide aggregate (all
 * applicable *_main legs, for the Top P&L / 7D P&L KPIs) — same contract
 * either way: fails CLOSED (null) the instant any named leg's own
 * getEquityPnlDisplay is unavailable (missing/stale/discontinuous), so a
 * partial sum is never mistaken for the whole. The combined % is a real
 * equity-weighted average (Σpnl / Σstart), never an average-of-percentages,
 * and is itself null when any leg's own pct was null (rebased) or the
 * combined start is non-positive — exactly the "every leg valid non-rebased
 * positive start" contract callers are documented against.
 *
 * Any leg that IS an applicable *_main broker series (per MAIN_SERIES /
 * isMainSeriesApplicable) must also have a currently-FRESH broker snapshot
 * (getBrokerSnapshotNow) — a stale/disconnected broker fails the whole
 * combine closed here too, instead of silently reading a merely-old stored
 * row via getEquityPnlDisplay while getPortfolioEquityNow (same staleness
 * gate) already reports the total as unavailable. Sleeve/non-main ids carry
 * no such gate — unchanged semantics.
 */
export function combineEquityPnlLegs(profileIds: string[], periodDays: number): { pnl: number; pnlPct: number | null } | null {
  for (const id of profileIds) {
    const broker = BROKER_BY_MAIN_SERIES[id];
    if (broker && isMainSeriesApplicable(broker) && !getBrokerSnapshotNow(broker)) return null;
  }
  const rows = profileIds.map(id => getEquityPnlDisplay(id, periodDays));
  if (rows.some(r => r == null)) return null;
  const legs = rows as { pnl: number; pnlPct: number | null; startEquity: number }[];
  const pnl = legs.reduce((s, r) => s + r.pnl, 0);
  const startSum = legs.reduce((s, r) => s + r.startEquity, 0);
  const invalid = legs.some(r => r.pnlPct == null) || startSum <= 0;
  return { pnl, pnlPct: invalid ? null : (pnl / startSum) * 100 };
}

// ══════════════════════════════════════════════
// Daily invariant checker — pages (via ERROR_BURST on repeat) when the books
// stop agreeing, instead of an operator noticing a wrong Telegram total weeks
// later. Called from AccountManager's snapshot loop, throttled to once/day.
// ══════════════════════════════════════════════

export interface InvariantCheck { name: string; ok: boolean; detail: string }
export interface InvariantReport { at: number; ok: boolean; checks: InvariantCheck[] }

let lastReport: InvariantReport | null = null;
/** Surfaced in /healthz/full. */
export function getLastInvariantReport(): InvariantReport | null { return lastReport; }

/**
 * @param unrealizedBySleeve live Σ unrealizedPnl per sleeve (from AccountManager
 *        state); tests pass explicit values. Missing sleeve ⇒ 0.
 */
export function reconcilePortfolioInvariants(
  unrealizedBySleeve: Partial<Record<RiskProfileId, number>> = {},
): InvariantReport {
  const checks: InvariantCheck[] = [];

  // (1) Per *_main series: Σ sleeve equities whose wallet maps to THIS series
  // (via BROKER_MAIN_SERIES — the accounting key, not the executor-routing
  // `broker` field) ≈ that series' broker equity + known legacy gap. The
  // broker wallets carry pre-v8 P&L history the sleeve ledgers deliberately
  // don't; that constant offset = first observed broker total − Σ allocations
  // for that same series' sleeves. One check PER series (not one combined
  // sum) is exact bucket ownership: alpaca_main only ever sees
  // momentum_stocks/meanrev_stocks, binance_main only ever sees
  // momentum_crypto/momentum_crypto_usdc (both real sub-wallets of the SAME
  // FAPI account, per BROKER_MAIN_SERIES), binance_coinm_main only ever sees
  // momentum_btc — nothing is summed twice, and a never-enabled series is
  // skipped entirely (getBrokerSnapshotNow returns null with no snapshots).
  for (const bk of ["alpaca", "binance", "coinm"] as const) {
    const series = MAIN_SERIES[bk];
    // Only sleeves that have EVER recorded a snapshot for this series enter
    // the allocation/legacy-gap math — a registered-but-never-active sleeve
    // (e.g. momentum_crypto_usdc before its first enable) must not inflate
    // `allocs` with a seed that was never really drawn from this wallet.
    const sleeves = ALL_PROFILE_IDS.filter(
      id => BROKER_MAIN_SERIES[RISK_PROFILES[id].broker] === series && getSleeveEquityNow(id) != null,
    );
    const now = getBrokerSnapshotNow(bk)?.equity ?? null;
    if (now == null) continue; // stale/missing (or never enabled) — nothing to check
    if (sleeves.length === 0) continue; // series exists but no sleeve has ever synced into it yet
    const sleeveSum = sleeves.reduce((s, id) => s + (getSleeveEquityNow(id) ?? 0), 0);
    const firstMain = getBrokerFirstEquity(bk);
    const allocs = sleeves.reduce((s, id) => s + RISK_PROFILES[id].initialEquity, 0);
    const legacyGap = firstMain != null && firstMain > 0 ? firstMain - allocs : 0;
    const tol = Math.max(1000, now * 0.02);
    const drift = now - sleeveSum - legacyGap;
    checks.push({
      name: `sleeves_vs_${series}`,
      ok: Math.abs(drift) <= tol,
      detail: `${series} $${now.toFixed(0)} vs sleeves [${sleeves.join(",")}] $${sleeveSum.toFixed(0)} + legacy gap $${legacyGap.toFixed(0)} → drift $${drift.toFixed(0)} (tol $${tol.toFixed(0)})`,
    });
  }

  // (2) Each LEDGER sleeve (equity is a COMPUTED reconstruction, currently
  // only the two Alpaca sleeves — see LEDGER_SLEEVE_BROKERS) ≈ allocation +
  // Σ closed-trade pnl + live unrealized. Every binance* sleeve reads its
  // OWN margin-pool balance straight from the broker every 60s, so it
  // carries perp FUNDING trades.pnl never records — reconstructing it would
  // ALWAYS drift by accumulated funding (benign), and check (1) above already
  // validates its *_main wallet. So this check is scoped to genuine ledgers.
  for (const id of ALL_PROFILE_IDS) {
    if (!LEDGER_SLEEVE_BROKERS.has(RISK_PROFILES[id].broker)) continue; // broker-truth sleeve, funding-exempt (see above)
    const eq = getSleeveEquityNow(id);
    if (eq == null) continue; // no snapshots yet (fresh DB) — nothing to check
    const expected = RISK_PROFILES[id].initialEquity
      + getTradingStats(id).totalPnl
      + (unrealizedBySleeve[id] ?? 0);
    // ponytail: base tol $50 per spec + 1% of open notional — the snapshot lags
    // live prices by ≤60s, so pure price movement on open positions must not
    // page. Attribution bugs (double-counted wallets) are 100× this.
    const openNotional = getOpenTrades(id).reduce((s: number, t: any) => s + (t.entryPrice ?? 0) * (t.quantity ?? 0), 0);
    const tol = 50 + 0.01 * openNotional;
    const drift = eq - expected;
    checks.push({
      name: `ledger_${id}`,
      ok: Math.abs(drift) <= tol,
      detail: `snapshot $${eq.toFixed(2)} vs initial+realized+unrealized $${expected.toFixed(2)} → drift $${drift.toFixed(2)} (tol $${tol.toFixed(0)})`,
    });
  }

  // (3) accounts-table equity readers = 0 — enforced at CI time by
  // src/portfolio/no-stale-account-reads.test.ts, not at runtime.

  const report: InvariantReport = { at: Date.now(), ok: checks.every(c => c.ok), checks };
  lastReport = report;

  for (const c of checks.filter(c => !c.ok)) {
    log.error(`Portfolio invariant VIOLATION [${c.name}]: ${c.detail}`);
    try { insertActivity(null, "system", `⚖️ Invariant violation [${c.name}]: ${c.detail}`); } catch {}
  }
  if (report.ok) log.info(`Portfolio invariants OK (${checks.length} checks)`);
  return report;
}
