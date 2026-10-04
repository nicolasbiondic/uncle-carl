// ══════════════════════════════════════════════
// Daily Reporter — generates end-of-day reports at 23:59 ET
// Stores in SQLite, sends via Telegram if configured
// ══════════════════════════════════════════════

import { createLogger } from "../utils/logger";
import {
  saveDailyReport, getClosedTradesInETDayRange,
  getEquityAt, insertActivity,
  getETDateKey, getETDayBounds, hasDailyReport,
  markDailyReportTelegramSent,
} from "../db/database";
import { heartbeats } from "../ops/heartbeat";

const log = createLogger("DailyReporter");

/** Heartbeat name — registered in start(), beaten at the end of a full
 *  checkReportTime pass (src/ops/heartbeat.ts, surfaced on /healthz/full). */
export const DAILY_REPORTER_HEARTBEAT = "daily_reporter";

export class DailyReporter {
  private interval: ReturnType<typeof setInterval> | null = null;
  /**
   * Reentrancy guard (2026-07-29) — same class of fix as BrokerSync.syncing
   * and MomentumEngine.ticking: the 60s poll does NOT await the previous
   * checkReportTime, so a generation that takes >60s (slow DB scan, hung
   * Telegram fetch) would let the next poll re-enter, and both would see
   * hasDailyReport()=false → the Telegram digest sends TWICE. Released in
   * `finally`; a wedged pass keeps the guard held, stops the heartbeat
   * beats below, and pages as a stale loop instead of double-sending.
   */
  private ticking = false;
  /** Injected by index.ts */
  getAccountSummaries: (() => any[]) | null = null;
  /**
   * 2026-05-19: replaces the old `sendTelegram(msg)` injection. The reporter
   * no longer composes its own Telegram body — it calls back into the
   * TelegramReporter so the concise digest format lives in one place.
   */
  sendTelegramDigest: (() => Promise<boolean>) | null = null;

  start() {
    // Check every 60 seconds for report time
    this.interval = setInterval(() => {
      this.checkReportTime().catch((e: any) => log.error(`checkReportTime failed: ${e?.message ?? e}`));
    }, 60_000);
    // 60s cadence but grace ×10 (~10min to page): a legitimate pass can take
    // minutes (Telegram digest over a slow link) and must not false-page the
    // watchdog; a genuinely wedged generateReport (guard held forever, see
    // `ticking` above) stops beating and pages within ~10 minutes.
    heartbeats.register(DAILY_REPORTER_HEARTBEAT, 60_000, { graceMultiplier: 10 });
    log.info("Daily reporter started (23:59 ET — captures stocks + 24/7 crypto)");
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  /**
   * Audit fix (2026-07-21): the old latch was in-memory (`lastReportDate`),
   * set BEFORE the un-awaited, throwable `generateReport` call, and only
   * fired when a 60s poll landed on the EXACT 23:59 minute. A reboot or a
   * transient failure in that one minute dropped the day forever. The latch
   * is now the `daily_reports` DB row itself (written by generateReport on
   * success) — self-healing and idempotent:
   *   - catch-up: if yesterday (ET) has no report yet, generate it now,
   *     regardless of current time (bounded to just the previous day, no
   *     multi-week backfill).
   *   - same-day EOD: at/after 23:59 ET, generate today's report if missing.
   */
  private async checkReportTime() {
    if (this.ticking) return; // reentrancy guard — see field docstring
    this.ticking = true;
    try {
      // Audit fix (2026-07-25): this used to re-implement the ET clock with its
      // own inline Intl.DateTimeFormat (h/m parts) instead of the canonical
      // helpers in db/database.ts. Reusing getETDayBounds's exclusive day-end
      // gives the identical "h===23 && m>=59" window (the last minute before
      // midnight ET) without a second Intl formatter to keep in sync.
      const now = Date.now();
      const today = getETDateKey(now);
      const prev = getETDateKey(now - 86_400_000);

      if (!hasDailyReport(prev)) {
        await this.safeGenerate(prev);
      }

      // Audit fix (2026-05-06): generate at 23:59 ET instead of 17:00 ET so
      // the report captures crypto closes that happen after the US equity
      // close (16:00 ET) and through the end of the calendar day. The old
      // 17:00 ET cutoff caused crypto cierres en 17:00–23:59 ET to never
      // appear in any report.
      const [, todayEnd] = getETDayBounds(today);
      if (now >= todayEnd - 60_000 && !hasDailyReport(today)) {
        await this.safeGenerate(today);
      }
      heartbeats.beat(DAILY_REPORTER_HEARTBEAT); // end of a full pass only — a guard-blocked poll must NOT beat
    } finally {
      this.ticking = false;
    }
  }

  private async safeGenerate(dateKey: string) {
    try {
      await this.generateReport(dateKey);
    } catch (e: any) {
      log.error(`Daily report generation failed for ${dateKey}: ${e?.message ?? e}`);
    }
  }

  async generateReport(date?: string) {
    const reportDate = date || getETDateKey();
    log.info(`Generating daily report for ${reportDate}...`);

    try {
      const summaries = this.getAccountSummaries?.() || [];
      // Audit fix (2026-05-04): filter trades by epoch range of the ET
      // trading day instead of comparing UTC-derived date strings against
      // an ET-derived report date. The old logic missed late-evening trades
      // on every account.
      const [dayStart, dayEnd] = getETDayBounds(reportDate);

      for (const acc of summaries) {
        // Audit fix (2026-05-06): pull ALL closed trades for this profile
        // within the ET day range, not the top-100-by-entry-time slice from
        // getRecentTrades. The old slice could miss late closes if entry
        // times were older than 100 newer entries; even when it didn't,
        // using the slice was a hidden cap on correctness.
        const todayTrades = getClosedTradesInETDayRange(acc.id, dayStart, dayEnd);

        // Audit fix (P3, 2026-05-07): init at +/-Infinity so a day where
        // every trade is negative still records a real best (least bad) and
        // a day where every trade is positive records a real worst (least
        // good). Previously the trade with the smallest negative loss
        // wouldn't replace bestTrade because its pnl was below zero.
        let bestTrade: { symbol: string; pnl: number } = { symbol: "—", pnl: -Infinity };
        let worstTrade: { symbol: string; pnl: number } = { symbol: "—", pnl: Infinity };
        const stratCount: Record<string, number> = {};

        // Audit fix (2026-05-06): realizedPnl was previously stats.todayPnl,
        // which is computed against `getETDayStart(now)` — wrong if the
        // report is generated for a past date (backfill) and also wrong on
        // edge cases where stats and the trade scan disagreed. Sum directly
        // from the same `todayTrades` list used for counts so the numbers
        // are guaranteed consistent.
        let realizedPnl = 0;
        for (const t of todayTrades) {
          const pnl = t.pnl || 0;
          realizedPnl += pnl;
          if (pnl > bestTrade.pnl) bestTrade = { symbol: t.symbol, pnl };
          if (pnl < worstTrade.pnl) worstTrade = { symbol: t.symbol, pnl };
          stratCount[t.strategy] = (stratCount[t.strategy] || 0) + 1;
        }

        const mostActive = Object.entries(stratCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

        // Audit fix (2026-05-06): startingEquity used to be `acc.initialEquity`
        // (the profile's seed capital — e.g. $25k for alpaca_low). That meant
        // unrealizedPnl reflected ALL-TIME drift since profile creation, not
        // the day's move. Use the equity_snapshots table to anchor at the
        // actual ET-day boundaries. Fallback to initialEquity only on the
        // very first day when there are no prior snapshots.
        const startingEquity = getEquityAt(acc.id, dayStart - 1) ?? acc.initialEquity;
        const endingEquity = getEquityAt(acc.id, dayEnd - 1) ?? acc.equity;

        // unrealizedPnl was `equity - cash - todayPnl` which produced the
        // bizarre "exact opposite of realized" mirror seen in 2026-05-04..06
        // reports. The financially correct definition for a daily report is
        // "change in equity over the day, minus what was realized" = the
        // mark-to-market move on positions still open at report time.
        const unrealizedPnl = (endingEquity - startingEquity) - realizedPnl;

        const report = {
          profileId: acc.id,
          reportDate,
          startingEquity,
          endingEquity,
          realizedPnl,
          unrealizedPnl,
          totalTrades: todayTrades.length,
          winningTrades: todayTrades.filter(t => (t.pnl || 0) > 0).length,
          winRate: todayTrades.length > 0
            ? todayTrades.filter(t => (t.pnl || 0) > 0).length / todayTrades.length * 100
            : 0,
          // Convert sentinel ±Infinity back to 0 for storage / display
          // when no trade ever updated them (i.e. todayTrades was empty).
          bestTradeSymbol: bestTrade.symbol,
          bestTradePnl: isFinite(bestTrade.pnl) ? bestTrade.pnl : 0,
          worstTradeSymbol: worstTrade.symbol,
          worstTradePnl: isFinite(worstTrade.pnl) ? worstTrade.pnl : 0,
          mostActiveStrategy: mostActive,
        };

        saveDailyReport(report);
      }

      // Send Telegram summary.
      // 2026-05-19: the daily report row stays in DB for the dashboard and
      // any future export, but the Telegram body is now composed by the
      // TelegramReporter so /report and the scheduled 23:59 message agree
      // byte-for-byte. The old per-profile multi-line dump (≈20 lines) was
      // redundant with `/profits` and noisy in the chat history.
      if (this.sendTelegramDigest) {
        try {
          // B-ops-alerts.md #8: telegram_sent used to flip to 1 on a
          // callback that merely didn't throw — apiCall swallows fetch
          // errors internally, so a 4xx/5xx from Telegram (bad chat id,
          // rate limit exhausted, revoked token) looked identical to a
          // real delivery. sendDaily() now returns whether Telegram's
          // response actually carried `ok: true`; only THAT flips the flag.
          const ok = await this.sendTelegramDigest();
          if (ok) {
            // Phase 5E (2026-05-20): flip telegram_sent=1 on the
            // daily_reports rows we just wrote, so the dashboard can show
            // "last digest delivered ✓" and silent Telegram outages become
            // visible in the DB instead of being swallowed by the catch
            // below.
            const flagged = markDailyReportTelegramSent(reportDate);
            if (flagged > 0) {
              log.info(`Telegram digest delivered for ${reportDate} (${flagged} profile rows flagged)`);
            }
          } else {
            log.warn(`Telegram digest NOT confirmed for ${reportDate} (no ok:true from Telegram) — telegram_sent stays 0`);
          }
        } catch (err: any) {
          // sendTelegram() inside the reporter swallows fetch errors; if
          // composing the digest itself throws (e.g. accountSummaries hook
          // detached during shutdown) we still want the report row above
          // to be persisted, so we silence the error here.
          // Phase 5E: keep a breadcrumb so the silent-failure mode shows
          // up in logs at least. The DB row keeps telegram_sent=0.
          log.warn(`Telegram digest failed for ${reportDate}: ${err?.message ?? err}`);
        }
      }

      insertActivity(null, "system", `Daily report generated for ${reportDate}`);
      log.info(`Daily report saved for ${reportDate}`);
    } catch (e: any) {
      log.error(`Daily report failed: ${e.message}`);
    }
  }
}
