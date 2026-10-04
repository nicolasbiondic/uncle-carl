// ══════════════════════════════════════════════
// Prometheus Metrics Exporter
// ══════════════════════════════════════════════
// Exposes /metrics on the existing Express server (port 3789)
// Format: text/plain Prometheus scraping standard

import type { Application } from "express";
import { getTradingStats, getOpenTrades, getSlippageStats } from "../db/database";
import type { AccountManager } from "../account/AccountManager";
import { ALL_PROFILE_IDS, SLEEVE_POLICY, type RiskProfileId } from "../config/riskProfiles";
import { getAllSleeveTrackRecords } from "../portfolio/trackRecord";
import { getReviewProgress } from "../portfolio/reviewPoint";
import { rateLimiterMetricsAll } from "../executor/rateLimiter";
import { symbolLockMetrics } from "../executor/symbolLock";
import { createLogger } from "../utils/logger";
import { eventBus, EVENTS } from "../utils/events";

const log = createLogger("Prometheus");

// ── Counters & Gauges ───────────────────────
const tradeCounters: Map<string, number> = new Map(); // "profile:strategy:outcome" → count

eventBus.on(EVENTS.POSITION_CLOSED, (data: any) => {
  const profile = data.accountId || "medium";
  const strategy = data.strategy || "unknown";
  const outcome = (data.pnl ?? 0) > 0 ? "win" : "loss";
  const key = `${profile}:${strategy}:${outcome}`;
  tradeCounters.set(key, (tradeCounters.get(key) || 0) + 1);
});

function buildMetrics(am: AccountManager): string {
  const lines: string[] = [];
  const add = (name: string, help: string, type: string, values: { labels: string; value: number }[]) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const v of values) {
      lines.push(`${name}{${v.labels}} ${v.value}`);
    }
  };

  // trading_trades_total
  {
    const vals: { labels: string; value: number }[] = [];
    for (const [key, count] of tradeCounters) {
      const [profile, strategy, outcome] = key.split(":");
      vals.push({ labels: `profile="${profile}",strategy="${strategy}",outcome="${outcome}"`, value: count });
    }
    add("trading_trades_total", "Total trades by profile/strategy/outcome", "counter", vals);
  }

  // Per-profile gauges
  for (const id of ALL_PROFILE_IDS) {
    const acc = am.getAccount(id);
    const stats = getTradingStats(id);
    const openCount = getOpenTrades(id).length;

    lines.push(`trading_open_positions{profile="${id}"} ${openCount}`);
    lines.push(`trading_equity{profile="${id}"} ${acc.equity.equity.toFixed(2)}`);
    lines.push(`trading_cash{profile="${id}"} ${acc.equity.cash.toFixed(2)}`);
    lines.push(`trading_daily_pnl{profile="${id}"} ${stats.todayPnl.toFixed(2)}`);
    lines.push(`trading_total_pnl{profile="${id}"} ${acc.equity.totalPnl.toFixed(2)}`);
    lines.push(`trading_win_rate{profile="${id}"} ${stats.winRate.toFixed(2)}`);

    const drawdown = acc.equity.initialEquity > 0
      ? ((acc.equity.initialEquity - acc.equity.equity) / acc.equity.initialEquity) * 100 : 0;
    lines.push(`trading_drawdown_pct{profile="${id}"} ${Math.max(0, drawdown).toFixed(2)}`);

    // Wave 1: slippage stats per profile (7-day window). trading_slippage_bps
    // is the TOTAL (decision expected_px → fill filled_px) — unchanged.
    const sl = getSlippageStats(id, 7 * 24 * 3600_000);
    lines.push(`trading_slippage_bps{profile="${id}",quantile="0.5"} ${sl.p50.toFixed(2)}`);
    lines.push(`trading_slippage_bps{profile="${id}",quantile="0.95"} ${sl.p95.toFixed(2)}`);
    lines.push(`trading_fill_count{profile="${id}",window="7d"} ${sl.count}`);
    lines.push(`trading_fill_latency_ms_mean{profile="${id}"} ${sl.meanLatencyMs.toFixed(0)}`);
    // Tanda 5 (2026-08-06): total's two legs, exposed separately so a sleeve
    // like meanrev (huge overnight drift, ~0 execution cost) doesn't get
    // mistaken for one with bad execution. drift = expected_px→submitted_px
    // (market move outside the bot's control); execution = submitted_px→
    // filled_px (the only leg order-routing quality can affect) — omitted
    // when no fill in the window has a usable submitted_px.
    if (sl.driftP50 !== null) {
      lines.push(`trading_slippage_drift_bps{profile="${id}",quantile="0.5"} ${sl.driftP50.toFixed(2)}`);
    }
    if (sl.driftP95 !== null) {
      lines.push(`trading_slippage_drift_bps{profile="${id}",quantile="0.95"} ${sl.driftP95.toFixed(2)}`);
    }
    lines.push(`trading_slippage_drift_fill_count{profile="${id}",window="7d"} ${sl.driftCount}`);
    if (sl.executionP50 !== null) {
      lines.push(`trading_slippage_execution_bps{profile="${id}",quantile="0.5"} ${sl.executionP50.toFixed(2)}`);
    }
    if (sl.executionP95 !== null) {
      lines.push(`trading_slippage_execution_bps{profile="${id}",quantile="0.95"} ${sl.executionP95.toFixed(2)}`);
    }
    lines.push(`trading_slippage_execution_fill_count{profile="${id}",window="7d"} ${sl.executionCount}`);
  }

  // Per-sleeve track record (Bailey & López de Prado MinTRL/PSR — see
  // src/portfolio/trackRecord.ts). Observed Sharpe is NEVER emitted without
  // its companions (n, required n, PSR, sufficiency flag) — a Sharpe alone
  // at small n is misinformation. Conditional emission: a metric whose value
  // is undefined (e.g. MinTRL infinite because SR̂ ≤ SR*) is OMITTED, never
  // faked as 0. Wrapped so a failure here can never take down /metrics.
  try {
    const recs = getAllSleeveTrackRecords();
    lines.push(`# HELP trading_track_record_observations Valid daily return observations accumulated per sleeve (one per completed ET day; era boundaries and snapshot holes excluded)`);
    lines.push(`# TYPE trading_track_record_observations gauge`);
    lines.push(`# HELP trading_track_record_obs_required MinTRL (Bailey-LdP) at 95% confidence for SR>0, in observations; omitted when the observed Sharpe is not above 0`);
    lines.push(`# TYPE trading_track_record_obs_required gauge`);
    lines.push(`# HELP trading_track_record_obs_missing Observations still missing to reach MinTRL; omitted when MinTRL is undefined`);
    lines.push(`# TYPE trading_track_record_obs_missing gauge`);
    lines.push(`# HELP trading_track_record_psr Probabilistic Sharpe Ratio PSR(0): probability the true Sharpe exceeds 0`);
    lines.push(`# TYPE trading_track_record_psr gauge`);
    lines.push(`# HELP trading_track_record_sharpe_annualized Observed Sharpe, annualized by the sleeve's grid (252 trading / 365 calendar obs per year) — read with obs/required/psr, never alone`);
    lines.push(`# TYPE trading_track_record_sharpe_annualized gauge`);
    lines.push(`# HELP trading_track_record_sufficient 1 when accumulated observations reach MinTRL at 95% for SR>0, else 0 (the honest state)`);
    lines.push(`# TYPE trading_track_record_sufficient gauge`);
    lines.push(`# HELP trading_track_record_series_fresh 1 when the sleeve's equity-snapshot pipeline wrote recently (distinguishes 'flat because shadow' from 'silent because broken')`);
    lines.push(`# TYPE trading_track_record_series_fresh gauge`);
    // Ex-ante review point (src/portfolio/reviewPoint.ts): target = MinTRL of
    // the DECLARED expected Sharpe (SLEEVE_POLICY, riskProfiles.ts), NOT the
    // observed one (trading_track_record_obs_required is the observed-Sharpe
    // diagnostic; it moves — the target doesn't). reached=1 means "time for a
    // human to review", never an automatic action. Emitted even with zero
    // observations — the goalpost exists before the data does.
    lines.push(`# HELP trading_review_point_obs_target Ex-ante review point in observations (MinTRL of the DECLARED expected Sharpe at 95% for SR>0 — stable, never derived from observed data)`);
    lines.push(`# TYPE trading_review_point_obs_target gauge`);
    lines.push(`# HELP trading_review_point_reached 1 when accumulated observations reach the declared review point — means 'enough data to decide', implies NO action`);
    lines.push(`# TYPE trading_review_point_reached gauge`);
    // Declared risk-retirement policy (riskProfiles.ts SLEEVE_POLICY),
    // enforced by RiskGuard as ENTRY PAUSES — the sleeve is never turned off.
    lines.push(`# HELP trading_risk_retirement_soft_dd_pct Declared soft drawdown limit (RiskGuard pauses new entries 24h; sleeve stays live)`);
    lines.push(`# TYPE trading_risk_retirement_soft_dd_pct gauge`);
    lines.push(`# HELP trading_risk_retirement_hard_dd_pct Declared hard drawdown limit (RiskGuard pauses new entries 7d + human review; sleeve stays live)`);
    lines.push(`# TYPE trading_risk_retirement_hard_dd_pct gauge`);
    lines.push(`# HELP trading_risk_retirement_daily_loss_cap_pct Declared daily loss cap (RiskGuard pauses new entries until next UTC day; sleeve stays live)`);
    lines.push(`# TYPE trading_risk_retirement_daily_loss_cap_pct gauge`);
    for (const r of recs) {
      const l = `profile="${r.profileId}"`;
      const tr = r.trackRecord;
      lines.push(`trading_track_record_observations{${l}} ${tr.n}`);
      if (tr.obsNeeded != null) lines.push(`trading_track_record_obs_required{${l}} ${tr.obsNeeded}`);
      if (tr.obsMissing != null) lines.push(`trading_track_record_obs_missing{${l}} ${tr.obsMissing}`);
      if (tr.psr != null) lines.push(`trading_track_record_psr{${l}} ${tr.psr.toFixed(4)}`);
      if (tr.sharpeAnnualized != null) lines.push(`trading_track_record_sharpe_annualized{${l}} ${tr.sharpeAnnualized.toFixed(4)}`);
      lines.push(`trading_track_record_sufficient{${l}} ${tr.status === "track_record_sufficient" ? 1 : 0}`);
      lines.push(`trading_track_record_series_fresh{${l}} ${r.series.seriesFresh ? 1 : 0}`);
      try {
        const rp = getReviewProgress(r.profileId as RiskProfileId, tr);
        lines.push(`trading_review_point_obs_target{${l}} ${rp.obsTarget}`);
        lines.push(`trading_review_point_reached{${l}} ${rp.reached ? 1 : 0}`);
      } catch { /* unknown profile id in recs — omit, never fake */ }
      const risk = SLEEVE_POLICY[r.profileId as RiskProfileId]?.risk;
      if (risk) {
        lines.push(`trading_risk_retirement_soft_dd_pct{${l}} ${risk.softDrawdownPct}`);
        lines.push(`trading_risk_retirement_hard_dd_pct{${l}} ${risk.hardDrawdownPct}`);
        lines.push(`trading_risk_retirement_daily_loss_cap_pct{${l}} ${risk.dailyLossCapPct}`);
      }
    }
  } catch (e: any) {
    log.warn(`track-record metrics unavailable: ${e?.message ?? e}`);
  }

  // Venue rate limiter (src/executor/rateLimiter.ts): waits/denials/429/418
  // per venue — the observable trace of a stampede or a broker penalty.
  for (const m of rateLimiterMetricsAll()) {
    const l = `venue="${m.venue}"`;
    lines.push(`trading_rate_limit_acquires_total{${l}} ${m.acquires}`);
    lines.push(`trading_rate_limit_waits_total{${l}} ${m.waits}`);
    lines.push(`trading_rate_limit_wait_ms_total{${l}} ${m.totalWaitMs}`);
    lines.push(`trading_rate_limit_denials_total{${l}} ${m.denials}`);
    lines.push(`trading_rate_limit_http_429_total{${l}} ${m.http429}`);
    lines.push(`trading_rate_limit_http_418_total{${l}} ${m.http418}`);
    lines.push(`trading_rate_limit_protect_bypasses_total{${l}} ${m.protectBypasses}`);
    lines.push(`trading_rate_limit_penalty_active{${l}} ${m.penaltyActive ? 1 : 0}`);
    lines.push(`trading_rate_limit_frozen{${l}} ${m.frozen ? 1 : 0}`);
    lines.push(`trading_rate_limit_tokens{${l}} ${m.tokens.toFixed(2)}`);
  }

  // Per-(venue,symbol) mutation lock (src/executor/symbolLock.ts): sustained
  // contentions/timeouts mean two writers keep fighting over one position.
  const sl = symbolLockMetrics();
  lines.push(`trading_symbol_lock_acquires_total ${sl.acquires}`);
  lines.push(`trading_symbol_lock_contentions_total ${sl.contentions}`);
  lines.push(`trading_symbol_lock_timeouts_total ${sl.timeouts}`);
  lines.push(`trading_symbol_lock_held ${sl.held}`);

  return lines.join("\n") + "\n";
}

export function registerMetricsEndpoint(app: Application, am: AccountManager) {
  app.get("/metrics", (_req, res) => {
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(buildMetrics(am));
  });
  log.info("Prometheus metrics endpoint registered at /metrics");
}
