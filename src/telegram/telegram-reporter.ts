// ══════════════════════════════════════════════
// Uncle Carl Telegram Bot v4
// Concise rewrite (2026-05-19); daily digest reformatted (2026-07-19)
//
// Design goals:
//   1. One line per real-time event. No multi-line headers for routine OPEN/CLOSE.
//   2. ONE scheduled report per day (23:59 ET). Removed 9am + 18:00 reports —
//      they overlapped the 23:59 daily report and never added information that
//      `/status` or `/profits` couldn't pull on demand.
//   3. Push minimal, pull rich. Commands stay detailed; passive stream stays quiet.
//   4. `/quiet on` mutes OPEN/CLOSE event lines but still lets PAUSE / ERROR_BURST
//      through. Resets to off on bot restart by design (so an operator can't
//      forget they muted it).
//   5. Daily digest: client-facing summary (Hoy/7D/Inicio + active-sleeve
//      weekly W/L + Binance/Alpaca/Patrimonio truth), no operator-only detail
//      (top symbol, reject breakdown) — those stay in the dashboard.
//
// Commands: /start /status /trades /profits /report /quiet /help
// Real-time events: ORDER_FILLED · POSITION_CLOSED · CIRCUIT_BREAKER · ERROR_BURST
// ══════════════════════════════════════════════

import { existsSync, statSync, unlinkSync } from "fs";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { eventBus, EVENTS } from "../utils/events";
import { getTradingStats, getRecentTrades, getDB, getAssetBalances, RECONCILE_CLOSE_SQL, getETDayStart, insertActivity, getSyncState, setSyncState } from "../db/database";
import {
  computeScorecard, openHistoricalReadonly, formatScorecardDigestLines,
  bandEpisodeTransitions, MODEL_START,
  type Scorecard, type BandStatus, type BandEpisodeState,
} from "../portfolio/scorecard";
import {
  getPortfolioEquityNow, getSleeveEquityNow, getSleevePct,
  combineEquityPnlLegs, isMainSeriesApplicable, BROKER_SNAPSHOT_MAX_AGE_MS,
} from "../portfolio/truth";
import { getMarketStatus } from "../utils/marketHours";
import { fetchT } from "../utils/timeout";
import { TelegramOutbox, type SendOutcome } from "./outbox";
import { ALL_PROFILE_IDS, RISK_PROFILES } from "../config/riskProfiles";
import type { PortfolioState } from "../utils/types";
import type { Database } from "bun:sqlite";
import { computeRealizedAttribution, windowStartFor } from "../portfolio/pnlBreakdown";

const log = createLogger("Telegram");
const API = "https://api.telegram.org/bot";
// Touched by auto-deploy.sh right before a planned restart so the startup
// banner stays silent on code pushes (only unexpected restarts ping).
const DEPLOY_MARKER = "data/.deploy-restart";
// Durable retry queue for sendMessage failures during network cuts —
// data/ is gitignored; see src/telegram/outbox.ts for the full doctrine.
const OUTBOX_PATH = "data/telegram-outbox.json";
const OUTBOX_DRAIN_INTERVAL_MS = 30_000;

// Short tag per profile — keep Telegram lines under 80 chars on mobile.
const SHORT: Record<string, string> = {
  momentum_stocks: "M-S",
  momentum_crypto: "M-C",
  meanrev_stocks: "MR-S",
};

// Single-event alerts (open/close/pause/resume) and the daily digest speak to
// the END CLIENT — full Spanish names, no trader codes. Dense operator
// commands (/status, /trades, /profits) keep the short tags.
const FULL_NAME: Record<string, string> = {
  momentum_stocks: "Momentum Stocks",
  momentum_crypto: "Momentum Cripto",
  meanrev_stocks: "Reversión Stocks",
  momentum_crypto_usdc: "Momentum Cripto USDC",
  momentum_btc: "Momentum BTC",
};
function profileName(id: string): string {
  return FULL_NAME[id] || SHORT[id] || id;
}

/** Engine heartbeat name → risk-profile id (CIRCUIT_BREAKER payloads carry
 *  the former; everything user-facing is keyed by the latter). */
const HEARTBEAT_PROFILE: Record<string, string> = {
  "momentum:stocks": "momentum_stocks",
  "momentum:crypto": "momentum_crypto",
  "momentum:crypto_usdc": "momentum_crypto_usdc",
  "momentum:btc": "momentum_btc",
  "meanrev:stocks": "meanrev_stocks",
};
export function circuitProfileId(id: unknown): string {
  const s = typeof id === "string" ? id : "";
  return HEARTBEAT_PROFILE[s] ?? s;
}

export class TelegramReporter {
  private token: string;
  private chatId: string;
  /** Operator chat for engineering alerts; "" = log-only (see sendOps). */
  private opsChatId: string;
  private enabled = false;
  private pollOffset = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Durable retry queue (2026-09-25 DNS-cut class); created in init() so
   *  unit tests that never init() touch no files. Tests may assign their own
   *  instance pointing at a tmp path. */
  private outbox: TelegramOutbox | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private drainingOutbox = false;

  /** In-memory mute state. Resets to false on restart — that's intentional. */
  private quiet = false;

  /** historical.db (readonly) for marking positions at the day's start —
   *  overridable so tests stay independent of the checkout's research DB. */
  openHist: () => Database | null = () => openHistoricalReadonly();

  /** Injected by index.ts after AccountManager is ready */
  getAccountSummaries: (() => any[]) | null = null;
  getConsolidatedState: (() => PortfolioState) | null = null;

  constructor() {
    this.token = config.telegram.botToken;
    this.chatId = config.telegram.chatId;
    this.opsChatId = config.telegram.opsChatId;
  }

  async init() {
    if (!this.token || this.token === "your_telegram_bot_token" || this.token.length < 20) {
      log.warn("Telegram bot token not configured — notifications disabled");
      return;
    }

    // Durable outbox BEFORE the getMe probe: if this very boot happens inside
    // the network cut (the 2026-09-25 class — a restart often accompanies the
    // incident), getMe fails and `enabled` stays false, but the drain timer
    // must still deliver whatever a previous process queued once the network
    // returns. Each entry carries its own backoff gate; drain is a no-op on
    // an empty queue.
    this.outbox = this.outbox ?? new TelegramOutbox(OUTBOX_PATH);
    if (!this.outboxTimer) this.outboxTimer = setInterval(() => { void this.drainOutbox(); }, OUTBOX_DRAIN_INTERVAL_MS);

    try {
      const me = await this.apiCall("getMe");
      if (!me?.ok) throw new Error("Invalid bot token");
      log.info(`🤖 Telegram bot connected: @${me.result.username}`);
      this.enabled = true;

      if (!this.chatId || this.chatId === "your_chat_id") {
        log.info("Chat ID not set — waiting for /start command...");
      }

      this.setupEventListeners();
      this.startPolling();

      // Announce ONLY on unexpected restarts (crash / host reboot) — the ones
      // worth a ping. Planned deploys drop a fresh marker (auto-deploy.sh) so we
      // stay quiet and don't spam the chat on every code push.
      let plannedDeploy = false;
      try {
        if (existsSync(DEPLOY_MARKER)) {
          plannedDeploy = Date.now() - statSync(DEPLOY_MARKER).mtime.getTime() < 180_000;
          unlinkSync(DEPLOY_MARKER);
        }
      } catch { /* marker unreadable → treat as unexpected, announce */ }
      if (plannedDeploy) {
        log.info("Telegram: planned deploy restart — startup banner suppressed");
      } else {
        // OPERATOR audience: a restart is plumbing, not a trading event. The
        // user's positions and protections are re-verified on boot either
        // way, so there is nothing for them to act on.
        await this.sendOps("🟢 <b>Uncle Carl</b> operativo de nuevo tras un reinicio inesperado. Posiciones y protecciones verificadas.");
      }
    } catch (e: any) {
      log.error(`Telegram init failed: ${e.message}`);
      this.enabled = false;
    }
  }

  // ══════════════════════════════════════════
  // HTTP
  // ══════════════════════════════════════════

  /** Single HTTP attempt; null on any network/parse failure (never throws). */
  private async apiCallOnce(method: string, body?: any): Promise<{ status: number; data: any } | null> {
    try {
      const resp = await fetchT(`${API}${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }, 15_000);
      return { status: resp.status, data: await resp.json() };
    } catch (e: any) {
      log.error(`API ${method}: ${e.message}`);
      return null;
    }
  }

  /**
   * Returns the parsed response body (same contract every existing caller
   * already relies on: `data?.ok`, `data.result`, …) or null on a network/
   * parse failure. B-ops-alerts.md #8: this used to return the body WITHOUT
   * ever checking `ok`, so `send()` (below) had no way to know whether
   * Telegram actually accepted the message — a 4xx/5xx with a JSON body
   * looked identical to success. A 429 (Too Many Requests) carries
   * `parameters.retry_after` (seconds) per the Bot API; honored once,
   * capped at 10s so a misbehaving/huge value can't hang a caller in the
   * middle of an incident page.
   */
  private async apiCall(method: string, body?: any): Promise<any> {
    let result = await this.apiCallOnce(method, body);
    if (result && result.status === 429) {
      const retryAfterSec = Number(result.data?.parameters?.retry_after) || 0;
      const waitMs = Math.min(Math.max(retryAfterSec, 0), 10) * 1000;
      if (waitMs > 0) {
        log.warn(`API ${method}: 429 rate-limited — retrying once after ${waitMs}ms (Telegram asked for ${retryAfterSec}s)`);
        await new Promise((r) => setTimeout(r, waitMs));
        result = await this.apiCallOnce(method, body);
      }
    }
    const data = result?.data ?? null;
    // Non-enumerable HTTP status rider so send() can classify a failure as
    // retryable (429 exhausted / 5xx) vs permanent (other 4xx) WITHOUT
    // changing this method's return contract (every caller keeps reading the
    // parsed body; JSON.stringify never sees the rider). null return keeps
    // meaning "network/parse failure" — retryable by definition.
    if (result && data && typeof data === "object") {
      try { Object.defineProperty(data, "__httpStatus", { value: result.status, enumerable: false, configurable: true }); } catch { /* frozen body — classification falls back to permanent */ }
    }
    return data;
  }

  /**
   * OPERATOR-audience message (2026-08-03 user mandate: "Telegram is for the
   * end user, not the developer"). Goes to TELEGRAM_OPS_CHAT_ID only; when
   * that is unset — the default — the message is LOGGED and never sent, so
   * engineering noise can never reach the user chat. Deliberately not a
   * fallback to this.chatId: a fallback would silently reintroduce exactly
   * the noise this split exists to remove.
   */
  async sendOps(text: string): Promise<boolean> {
    if (!this.opsChatId) {
      // WARN, not info (2026-08-22): on 2026-08-19 the sleeve-output watchdog
      // correctly detected "5 consecutive open failures — producing NOTHING"
      // three hours into a 15-hour margin outage, paged… and the page landed
      // HERE, at log.info, invisible to any ERROR/WARN review. The no-fallback
      // mandate stands (engineering noise must never reach the user chat) —
      // but a dropped PAGE must at least be loud in the logs it falls back to.
      log.warn(`ops alert DROPPED (TELEGRAM_OPS_CHAT_ID unset — set it in .env to receive technical pages): ${text.replace(/<[^>]+>/g, "").replace(/\n/g, " · ").slice(0, 200)}`);
      return false;
    }
    return this.send(text, this.opsChatId);
  }

  /** Returns whether Telegram's `sendMessage` actually confirmed delivery
   *  (`data.ok === true`) — B-ops-alerts.md #8: a callback that merely
   *  didn't throw is NOT an acknowledgement (DailyReporter's telegram_sent
   *  used to be set on exactly that weaker guarantee). Every existing
   *  caller already fires this with `await this.send(...)` and ignores the
   *  return value, so this is additive, not a behavior change for them. */
  async send(text: string, chatId?: string): Promise<boolean> {
    if (!this.enabled) return false;
    const target = chatId || this.chatId;
    if (!target || target === "your_chat_id") return false;
    const outcome = await this.attemptSend(text, target);
    if (outcome === "retryable" && this.outbox) {
      // Network cut / 5xx / exhausted 429 (the 2026-09-25 lost-pages class):
      // queue for the durable drain loop. The queued entry keeps the RESOLVED
      // chat id, so the user/ops separation survives the retry. Return stays
      // false — delivery is NOT confirmed yet (DailyReporter's telegram_sent
      // honesty), the drained copy will say "(retrasado, original HH:MM UTC)".
      if (this.outbox.enqueue(target, text)) {
        log.warn(`sendMessage failed (retryable) — queued for retry, ${this.outbox.size()} pending`);
      }
    }
    return outcome === "sent";
  }

  /** One classified sendMessage attempt (through apiCall → its single 429
   *  retry). Used by send() (which enqueues retryables) and by the outbox
   *  drain (which must NOT re-enqueue — it already owns the entry). */
  private async attemptSend(text: string, target: string): Promise<SendOutcome> {
    const data = await this.apiCall("sendMessage", {
      chat_id: target,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    if (data?.ok === true) return "sent";
    if (data == null) return "retryable"; // network/parse failure (apiCallOnce null)
    const status = (data as any).__httpStatus;
    if (status === 429 || (typeof status === "number" && status >= 500)) return "retryable";
    // Any other 4xx (bad chat id, malformed entity…) — retrying can't fix it.
    return "permanent";
  }

  /** Reentrancy-guarded drain pass (the interval must never stack passes
   *  behind a slow 15s fetch timeout). Public-ish for tests via `as any`. */
  private async drainOutbox(): Promise<void> {
    if (!this.outbox || this.drainingOutbox) return;
    this.drainingOutbox = true;
    try {
      await this.outbox.drain((chatId, text) => this.attemptSend(text, chatId));
    } catch (e: any) {
      log.warn(`outbox drain failed: ${e?.message ?? e}`);
    } finally {
      this.drainingOutbox = false;
    }
  }

  // ══════════════════════════════════════════
  // Long-poll commands
  // ══════════════════════════════════════════

  private startPolling() {
    this.pollTimer = setInterval(() => this.poll(), 10_000);
  }

  private async poll() {
    if (!this.enabled || this.polling) return;
    this.polling = true;
    try {
      const data = await this.apiCall("getUpdates", {
        offset: this.pollOffset,
        timeout: 5,
        limit: 10,
        allowed_updates: ["message"],
      });
      if (!data?.ok || !data.result?.length) return;

      for (const update of data.result) {
        this.pollOffset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = msg.chat.id.toString();
        const raw = msg.text.trim();
        const text = raw.toLowerCase();

        if (!this.chatId || this.chatId === "your_chat_id") {
          this.chatId = chatId;
          log.info(`Chat ID auto-detected: ${chatId}`);
        }

        if (text === "/start") await this.cmdStart(chatId, msg.from?.first_name || "trader");
        else if (text === "/status") await this.cmdStatus(chatId);
        else if (text === "/trades") await this.cmdTrades(chatId);
        else if (text === "/profits") await this.cmdProfits(chatId);
        else if (text === "/help") await this.cmdHelp(chatId);
        else if (text === "/report") await this.cmdReport(chatId);
        else if (text.startsWith("/quiet")) await this.cmdQuiet(chatId, raw);
      }
    } catch (e: any) {
      log.debug(`Poll error: ${e.message}`);
    } finally {
      this.polling = false;
    }
  }

  // ══════════════════════════════════════════
  // Commands
  // ══════════════════════════════════════════

  private async cmdStart(chatId: string, name: string) {
    await this.send(
      `👋 Hola ${name}. Uncle Carl activo · /help para comandos`,
      chatId
    );
  }

  private async cmdHelp(chatId: string) {
    await this.send(
      `<b>Comandos</b>\n` +
        `/status — equity actual de cada cuenta\n` +
        `/trades — últimos 10 trades\n` +
        `/profits — PnL detallado all-time\n` +
        `/report — reporte diario ahora\n` +
        `/quiet on|off — silencia OPEN/CLOSE (PAUSE/ERROR siguen)\n\n` +
        `<i>Reporte automático: 23:59 ET</i>`,
      chatId
    );
  }

  /**
   * Quiet mode toggles passive event noise. The two real-time alerts that
   * matter operationally — circuit breakers and error bursts — always come
   * through, regardless of quiet state.
   */
  private async cmdQuiet(chatId: string, raw: string) {
    const arg = raw.split(/\s+/)[1]?.toLowerCase();
    if (arg === "on") {
      this.quiet = true;
      await this.send("🔇 quiet · OPEN/CLOSE silenciados (PAUSE/ERROR siguen)", chatId);
    } else if (arg === "off") {
      this.quiet = false;
      await this.send("🔔 quiet off · alertas activas", chatId);
    } else {
      await this.send(`quiet=${this.quiet ? "on" : "off"} · uso: /quiet on|off`, chatId);
    }
  }

  private async cmdStatus(chatId: string) {
    const accounts = this.getAccountSummaries?.() || [];
    const market = getMarketStatus();
    const mEmoji = market.status === "open" ? "🟢" : market.status === "pre_market" ? "🟡" : "🔴";

    const lines: string[] = [];
    lines.push(`📊 <b>STATUS</b> · stocks ${mEmoji} · ${market.untilStr}`);

    let totalPos = 0;
    const daily = this.dailyPnlBreakdown();
    for (const a of accounts) {
      const stats = getTradingStats(a.id);
      const pct = a.totalPnlPct ?? getSleevePct(a.id) ?? 0; // ledger-based, same as digest + dashboard cards
      const pause = a.paused ? " ⏸" : "";
      lines.push(
        `${shortTag(a.id)} $${fmtMoney(a.equity)} ${signPct(pct)}` +
          ` · cobrado hoy ${signMoney(stats.todayPnl)} · ${stats.todayClosedTrades} cierres · ${a.positions}pos${pause}`
      );
      totalPos += a.positions;
    }

    // Total = broker truth (portfolio/truth, latest *_main snapshots), same
    // source as the digest header + dashboard KPI. Never substitute sleeve
    // ledgers for an incomplete broker total.
    const now = getPortfolioEquityNow();
    const totalEq = now.total == null ? "—" : `$${fmtMoney(now.total)}`;
    lines.push(
      `<b>Total ${totalEq} · ${fmtPeriodLeg("P&L hoy", daily.pnl)} · cobrado hoy ${signMoney(daily.realized)} · ${totalPos}pos</b>`
    );
    await this.send(lines.join("\n"), chatId);
  }

  private async cmdTrades(chatId: string) {
    const trades = getRecentTrades(10);
    if (!trades.length) {
      await this.send("📭 Sin trades recientes", chatId);
      return;
    }
    const lines = ["<b>Últimos 10 trades</b>"];
    for (const t of trades) {
      const pnl = t.pnl ?? 0;
      const e = pnl >= 0 ? "💚" : "❤️";
      const side = (t.side || "?").toUpperCase().slice(0, 1);
      const pid = (t as any).profileId || (t as any).accountId || "?";
      lines.push(
        `${e} ${side} <b>${t.symbol}</b> ${fmtPnlPair(pnl, t.pnlPct || 0)} · ${shortTag(pid)}`
      );
    }
    await this.send(lines.join("\n"), chatId);
  }

  private async cmdProfits(chatId: string) {
    const accounts = this.getAccountSummaries?.() || [];
    const lines = ["<b>PnL all-time por cuenta</b>"];

    for (const id of ALL_PROFILE_IDS) {
      const profile = RISK_PROFILES[id];
      const stats = getTradingStats(id);
      const acc = accounts.find((a: any) => a.id === id);
      // Live tracker first; portfolio/truth (latest sleeve snapshot) when the
      // summaries hook isn't attached; allocation-based last resort on day 1.
      const currentEq = acc?.equity ?? getSleeveEquityNow(id) ?? profile.initialEquity + stats.totalPnl;
      const pct = acc?.totalPnlPct ?? getSleevePct(id) ??
        (profile.initialEquity > 0 ? ((currentEq - profile.initialEquity) / profile.initialEquity) * 100 : 0);

      lines.push(
        `${shortTag(id)} $${fmtMoney(currentEq)} ${signPct(pct)} · ` +
          `${stats.totalTrades}tr WR${fmtNum(stats.winRate, 0)}% · ` +
          `hoy ${signMoney(stats.todayPnl)}`
      );
    }

    const all = getTradingStats();
    lines.push(
      `<b>Consolidado ${signMoney(all.totalPnl)} · ${all.totalTrades}tr WR${fmtNum(all.winRate, 0)}%</b>`
    );
    await this.send(lines.join("\n"), chatId);
  }

  private async cmdReport(chatId: string) {
    await this.sendDailyDigest(chatId);
  }

  // ══════════════════════════════════════════
  // Daily digest — invoked on demand (/report) or by DailyReporter at 23:59 ET.
  // Client-facing summary: Hoy/7D header, active-trade counts, active-sleeve
  // weekly W/L (best→worst), Binance/Alpaca broker truth, Patrimonio/Inicio.
  // Top-symbol and reject-breakdown are operator detail — dashboard
  // only, never the passive digest (2026-07-19 mandate).
  // ══════════════════════════════════════════

  /**
   * Compose the client-facing daily digest. Called both from /report (any
   * time) and from DailyReporter (23:59 ET). Returns the HTML body.
   *
   * Every dollar/percent figure is sourced from src/portfolio/truth.ts
   * (combineEquityPnlLegs over the applicable *_main broker series —
   * alpaca_main + binance_main + binance_coinm_main once DAPI has ever
   * synced), the SAME contract the dashboard KPIs use. A leg that's stale or
   * missing renders "—" for that figure rather than a partial/fabricated
   * number (fail closed, never silently substitute a sleeve-ledger sum).
   */
  composeDailyDigest(): string {
    const accounts = this.getAccountSummaries?.() || []; // ACTIVE sleeves only (AccountManager.getAccountSummaries)
    const now = new Date();
    const dateLabel = now.toLocaleDateString("es-ES", {
      timeZone: "America/New_York",
      day: "numeric",
      month: "short",
    });

    const db = getDB();
    const dayStart = getETDayStart(Date.now());
    // Rolling 7d window, re-anchored to ET midnight (a plain −6d offset from
    // dayStart drifts an hour across DST transitions).
    const weekStart = getETDayStart(Date.now() - 6 * 86_400_000);
    const RECONCILE = `AND ${RECONCILE_CLOSE_SQL}`; // shared with getTradingStats (db/database.ts) so dashboard + digest never drift
    const activeIds = accounts.map((a: any) => a.id as string);

    const countClosedTrades = (sinceMs: number): number => {
      if (activeIds.length === 0) return 0;
      const placeholders = activeIds.map(() => "?").join(",");
      const row = db
        .prepare(
          `SELECT COUNT(*) n FROM trades
           WHERE status='closed' AND exit_time >= ? AND account_id IN (${placeholders}) ${RECONCILE}`
        )
        .get(sinceMs, ...activeIds) as { n: number } | undefined;
      return row?.n ?? 0;
    };
    const dayTrades = countClosedTrades(dayStart);
    const weekTrades = countClosedTrades(weekStart);
    const totalPos = accounts.reduce((s: number, a: any) => s + (a.positions || 0), 0);

    // Rendimiento 7D: active sleeves with ≥1 closed trade in the window,
    // best→worst by 7D pnl. No day/equity/all-time clutter — that's /status
    // and /profits' job; this is the weekly scoreboard only.
    const sleeveRows: string[] = [];
    const sleevePnls: Array<{ id: string; pnl: number; w: number; l: number; paused: boolean }> = [];
    for (const a of accounts) {
      const wkQ = db
        .prepare(
          `SELECT COALESCE(SUM(pnl),0) pnl,
                  SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) w,
                  SUM(CASE WHEN pnl<0 THEN 1 ELSE 0 END) l
           FROM trades
           WHERE status='closed' AND account_id=? AND exit_time >= ? ${RECONCILE}`
        )
        .get(a.id, weekStart) as { pnl: number; w: number; l: number } | undefined;
      const w = wkQ?.w ?? 0, l = wkQ?.l ?? 0;
      if (w + l < 1) continue; // "≥1 weekly close" — silent sleeves don't clutter the scoreboard
      sleevePnls.push({ id: a.id, pnl: +(wkQ?.pnl ?? 0), w, l, paused: !!a.paused });
    }
    sleevePnls.sort((x, y) => y.pnl - x.pnl);
    for (const r of sleevePnls) {
      sleeveRows.push(`${profileName(r.id)} realizado ${signMoney(r.pnl)} · ${r.w}W/${r.l}L${r.paused ? " ⏸" : ""}`);
    }

    // Header truth: alpaca_main + binance_main (+ binance_coinm_main once
    // DAPI has ever synced) — same applicability rule the dashboard uses, so
    // a never-enabled COIN-M sleeve never blocks the other two legs.
    const mainLegs = this.mainLegs();
    const daily = this.dailyPnlBreakdown(mainLegs);
    const weekLeg = combineEquityPnlLegs(mainLegs, 7);
    const inicioLeg = combineEquityPnlLegs(mainLegs, 0); // all-time display delta — NOT the 7D window, NOT a sleeve sum
    const portfolioNow = getPortfolioEquityNow();
    const bin = this.getBinanceDecomposition(portfolioNow);

    const lines: string[] = [];
    lines.push(`📊 <b>Uncle Carl</b> · ${dateLabel} · cierre ET`);
    lines.push(`${fmtPeriodLeg("P&L hoy", daily.pnl)} · ${fmtPeriodLeg("P&L 7D", weekLeg)}`);
    lines.push(fmtRealizedToday(daily));
    lines.push(
      `${dayTrades} ${pluralize(dayTrades, "trade", "trades")} hoy · ${weekTrades} en 7D · ` +
        `${totalPos} ${pluralize(totalPos, "posición abierta", "posiciones abiertas")}`
    );

    if (sleeveRows.length > 0) {
      lines.push("");
      lines.push("<b>Rendimiento 7D realizado</b>");
      for (const r of sleeveRows) lines.push(r);
    }

    // Scorecard vs backtest validado (W5): una línea por sleeve vivo, ventana
    // desde el inicio del modelo vigente + chip de banda OOS. Fail-soft: un
    // scorecard roto (historical.db ausente, artefacto movido) NUNCA tumba el
    // digest — simplemente no aparece la sección.
    const scorecardLines = this.scorecardDigestLines();
    if (scorecardLines.length > 0) {
      lines.push("");
      lines.push("<b>Scorecard vs backtest validado</b>");
      for (const l of scorecardLines) lines.push(l);
    }

    lines.push("");
    if (bin.total != null) {
      const parts = bin.usdt != null && bin.usdc != null && bin.btc != null
        ? ` · USDT $${fmtMoneyGrouped(bin.usdt)} · USDC $${fmtMoneyGrouped(bin.usdc)} · BTC $${fmtMoneyGrouped(bin.btc)}`
        : ""; // stale/missing/nonfinite asset rows → total only, never invented parts
      lines.push(`Binance $${fmtMoneyGrouped(bin.total)}${parts}`);
    }
    if (portfolioNow.alpaca != null) lines.push(`Alpaca $${fmtMoneyGrouped(portfolioNow.alpaca)}`);
    lines.push(
      `${portfolioNow.total == null ? "Patrimonio —" : `Patrimonio $${fmtMoneyGrouped(portfolioNow.total)}`} · ` +
      `${fmtPeriodLeg("P&L desde el inicio", inicioLeg)}`
    );

    return lines.join("\n");
  }

  /**
   * Binance $ decomposition (mandate 2026-07-19): total = FAPI main +
   * DAPI main (exactly the same legs as `portfolioNow`, never re-derived).
   * USDC = FAPI USDC asset row usd_value; BTC = FAPI BTC asset row usd_value
   * + DAPI main equity; USDT = total − USDC − BTC (so it absorbs USDT
   * futures unrealized PnL, matching "reconcile exactly" — the three parts
   * always sum back to `total` by construction). Asset rows come from
   * broker_asset_balances (synced by BrokerSync off the FAPI/"binance_testnet"
   * source); missing, stale (older than BROKER_SNAPSHOT_MAX_AGE_MS), or
   * non-finite rows omit the decomposition — total still renders alone.
   */
  private getBinanceDecomposition(
    portfolioNow: ReturnType<typeof getPortfolioEquityNow>
  ): { total: number | null; usdt: number | null; usdc: number | null; btc: number | null } {
    const coinmApplicable = isMainSeriesApplicable("coinm");
    if (portfolioNow.binance == null || (coinmApplicable && portfolioNow.coinm == null)) {
      return { total: null, usdt: null, usdc: null, btc: null };
    }
    const coinmEq = coinmApplicable ? portfolioNow.coinm! : 0;
    const total = portfolioNow.binance + coinmEq;

    const assets = getAssetBalances("binance_testnet");
    const freshCutoff = Date.now() - BROKER_SNAPSHOT_MAX_AGE_MS;
    const fresh = assets.length > 0 && assets.every((a: any) => {
      const at = Date.parse(String(a.updated_at).replace(" ", "T") + "Z");
      return Number.isFinite(at) && at >= freshCutoff;
    });
    if (!fresh) return { total, usdt: null, usdc: null, btc: null };

    const usdcRow = assets.find((a: any) => a.asset === "USDC");
    const btcRow = assets.find((a: any) => a.asset === "BTC");
    const usdc = usdcRow ? usdcRow.usd_value : 0; // filtered out of assets when balance=0 → genuinely zero, not stale
    const btcFapi = btcRow ? btcRow.usd_value : 0;
    if (!Number.isFinite(usdc) || !Number.isFinite(btcFapi)) {
      return { total, usdt: null, usdc: null, btc: null };
    }
    const btc = btcFapi + coinmEq;
    const usdt = total - usdc - btc;
    return { total, usdt, usdc, btc };
  }

  private mainLegs(): string[] {
    return ["alpaca_main", "binance_main", ...(isMainSeriesApplicable("coinm") ? ["binance_coinm_main"] : [])];
  }

  /** Today's P&L (the change in the accounts' value — combineEquityPnlLegs)
   *  and what closed trades realized today, with the part of it earned
   *  BEFORE today: a position that built its gain over weeks realizes all of
   *  it today, but only today's move is in the P&L (2026-09-28: META closed
   *  +$4,767.74 on a −$831 day). The old line labeled the whole equity delta
   *  "no realizado", so "realizado + no realizado" double-counted every
   *  close. /status and the digest share this. */
  private dailyPnlBreakdown(mainLegs = this.mainLegs()): {
    pnl: ReturnType<typeof combineEquityPnlLegs>;
    realized: number;
    realizedCount: number;
    earnedBefore: number | null;
  } {
    let hist: Database | null = null;
    try {
      hist = this.openHist();
      const ra = computeRealizedAttribution(getDB(), hist, windowStartFor(1));
      return { pnl: combineEquityPnlLegs(mainLegs, 1), realized: ra.realized, realizedCount: ra.count, earnedBefore: ra.earnedBefore };
    } finally {
      try { hist?.close(); } catch {}
    }
  }

  private async sendDailyDigest(chatId?: string): Promise<boolean> {
    return this.send(this.composeDailyDigest(), chatId);
  }

  /**
   * Public hook for DailyReporter — sends the same digest as /report.
   * The DailyReporter previously generated its own multi-line report from
   * the `daily_reports` table; we centralize the format here so the
   * scheduled message and the on-demand /report agree byte-for-byte.
   * Returns delivery confirmation (B-ops-alerts.md #8) — DailyReporter only
   * flips telegram_sent=1 when this is true, not merely on a non-throwing
   * callback.
   */
  async sendDaily(): Promise<boolean> {
    // Band-episode ops check rides the daily cadence (once/day, same clock as
    // the digest) but pages the OPS chat, once per episode — see below.
    try { await this.checkScorecardBandEpisodes(); } catch (e: any) {
      log.warn(`scorecard band-episode check failed: ${e?.message ?? e}`);
    }
    return this.sendDailyDigest();
  }

  // ══════════════════════════════════════════
  // Scorecard (W5) — digest lines + band-episode ops alerts
  // ══════════════════════════════════════════

  /** Full scorecard against the live DB + historical.db (readonly, fail-soft). */
  private computeScorecardNow(): Scorecard | null {
    let hist = null;
    try {
      hist = openHistoricalReadonly();
      return computeScorecard({ db: getDB(), hist });
    } catch (e: any) {
      log.warn(`scorecard unavailable: ${e?.message ?? e}`);
      return null;
    } finally {
      try { hist?.close(); } catch {}
    }
  }

  private scorecardDigestLines(): string[] {
    const sc = this.computeScorecardNow();
    return sc ? formatScorecardDigestLines(sc) : [];
  }

  /** sync_state key holding the JSON map sleeve → "below"|"ok". */
  static readonly BAND_STATE_KEY = "scorecard_band_state";

  /**
   * Ops alert ONCE per episode: pages when a sleeve's live cumulative return
   * since its model start crosses BELOW the p5 of the validated OOS band
   * (the automatic "rinde peor que lo validado" signal — the measurable
   * spirit of the pre-registered 60-session reversion criteria quoted in
   * src/portfolio/scorecard.ts), and again when it comes back inside.
   * State persists in sync_state so restarts don't re-page.
   */
  private async checkScorecardBandEpisodes(): Promise<void> {
    const sc = this.computeScorecardNow();
    if (!sc) return;
    const current: Record<string, BandStatus> = {};
    for (const e of sc.entities) if (e.kind === "sleeve" && e.band) current[e.id] = e.band.status;

    let prev: Partial<Record<string, BandEpisodeState>> = {};
    try { prev = JSON.parse(getSyncState(TelegramReporter.BAND_STATE_KEY) ?? "{}"); } catch {}
    const { transitions, next } = bandEpisodeTransitions(prev, current);

    for (const tr of transitions) {
      const e = sc.entities.find(x => x.id === tr.sleeve);
      const b = e?.band;
      const fmt = (x: number | null | undefined) => x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
      if (tr.kind === "entered_below") {
        await this.sendOps(
          `📉 <b>Scorecard</b> · ${profileName(tr.sleeve)} POR DEBAJO de la banda OOS validada\n` +
          `Retorno vivo ${fmt(b?.liveCumReturnPct)} en ${b?.horizonSessions ?? "?"} sesiones (modelo desde ${MODEL_START[tr.sleeve] ?? "?"}) ` +
          `vs banda p5/p50/p95 ${fmt(b?.cumReturnPct?.p5)} / ${fmt(b?.cumReturnPct?.p50)} / ${fmt(b?.cumReturnPct?.p95)}` +
          `${b?.selectionBias ? ` (ya ajustada por sesgo de selección del universo: −${b.selectionBias.sharpeHaircut.toFixed(2).replace(".", ",")} de Sharpe)` : ""}.\n` +
          `Señal automática de "rinde peor que lo validado" — revisar el criterio de reversión pre-registrado (60 sesiones) ` +
          `en src/index.ts / MeanRevEngine.ts. Aviso único por episodio.`
        );
      } else {
        await this.sendOps(
          `✅ <b>Scorecard</b> · ${profileName(tr.sleeve)} volvió DENTRO de la banda OOS validada ` +
          `(retorno vivo ${fmt(b?.liveCumReturnPct)} en ${b?.horizonSessions ?? "?"} sesiones).`
        );
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      setSyncState(TelegramReporter.BAND_STATE_KEY, JSON.stringify(next));
    }
  }

  // ══════════════════════════════════════════
  // Real-time event lines
  // ══════════════════════════════════════════

  private setupEventListeners() {
    // 2026-07-09 notification curation ("many notifications, none useful"):
    // OPENS no longer page — they're visible in the dashboard and the daily
    // digest; an open carries no actionable information by itself.
    // CLOSES page only when |pnl| ≥ $5 OR it's an external/reconciled close
    // (unusual → worth knowing). The −$2 crypto micro-closes were the noise.
    // Everything actionable still pages: breakers, resumes, error bursts,
    // engine stalls, daily digest, unexpected restarts.
    // 2026-07-11 (user mandate): notify EVERY buy and sell. The $5 micro-close
    // filter is gone; only zero-capital shadow_ books stay silent.
    eventBus.on(EVENTS.ORDER_FILLED, (o: any) => {
      if (this.quiet) return;
      const pid = String(o?.accountId ?? "?");
      if (pid.startsWith("shadow_")) return;
      const px = o?.filledPrice ?? o?.price ?? 0;
      this.send(
        `🟢 <b>${(o?.side ?? "?").toUpperCase()}</b> ${o?.quantity} ${o?.symbol} @ $${Number(px).toFixed(4)}\n` +
        `📁 ${pid}`
      );
    });
    eventBus.on(EVENTS.POSITION_CLOSED, (trade: any) => {
      if (this.quiet) return;
      const pid = trade.accountId || trade.profileId || "?";
      if (String(pid).startsWith("shadow_")) return;
      let dayPnl = NaN;
      try { dayPnl = getTradingStats(pid).todayPnl; } catch {}
      this.send(fmtCloseAlert(trade, dayPnl));
    });

    // Circuit breaker — always fires regardless of quiet mode. Now actionable:
    // what tripped, the impact (equity + that open positions stay protected),
    // when it resumes (ET + countdown), and how to override. pause_resolved
    // (B-ops-alerts.md #1 — MomentumEngine/MeanRevEngine's RiskGuard
    // transition) gets its own short recovery message, and SleeveGovernor's
    // recommend_redesign its own shape too: it is NOT a pause (the sleeve
    // keeps trading) and must never read like one.
    eventBus.on(EVENTS.CIRCUIT_BREAKER, (raw: any) => {
      // The engines identify themselves by heartbeat name ("momentum:crypto");
      // the account summaries, names and activity log are keyed by profile id.
      const data = { ...raw, profileId: circuitProfileId(raw?.profileId) };
      const acc = (this.getAccountSummaries?.() || []).find((a: any) => a.id === data.profileId);
      if (data?.action === "pause_resolved") this.send(fmtPauseResolvedAlert(data, acc));
      else if (data?.action === "recommend_redesign") this.send(fmtRedesignRecommendation(data, acc));
      else this.send(fmtCircuitBreakerAlert(data, acc));
      // Also on the dashboard's Activity tab — a pause used to leave no
      // trace anywhere a human looks (B-ops-alerts.md #1).
      try {
        insertActivity(data.profileId ?? null, "circuit", `${data.action ?? "circuit"}: ${data.reason ?? ""}`.trim());
      } catch (e: any) {
        log.warn(`circuit activity row not written: ${e?.message ?? e}`);
      }
    });

    // Error burst (logger emits when ≥10 same-shape errors fire within 60s).
    // OPERATOR audience: "BrokerSync threw 10 times" is a maintenance task,
    // not something the user can act on — and the message itself already
    // said "trading continues normally", which is the definition of noise
    // for them. Anything that genuinely stops trading reaches the user
    // through CIRCUIT_BREAKER instead.
    eventBus.on(EVENTS.ERROR_BURST, (data: any) => {
      this.sendOps(fmtErrorBurstAlert(data));
    });
  }

  // ══════════════════════════════════════════
  // Cleanup
  // ══════════════════════════════════════════

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.outboxTimer) { clearInterval(this.outboxTimer); this.outboxTimer = null; }
  }
}

// ══════════════════════════════════════════
// Formatting helpers
// ══════════════════════════════════════════

function shortTag(id: string): string {
  return SHORT[id] || id.slice(0, 4);
}

function fmtMoney(n: number): string {
  if (typeof n !== "number" || isNaN(n)) return "0";
  // < $10k drop the thousand separator (5-char numbers are fine), else use comma.
  if (Math.abs(n) >= 10_000) {
    return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  return n.toFixed(0);
}

/** Always thousand-grouped whole-dollar figure — for the digest's broker-truth
 *  lines (Binance/USDT/USDC/BTC/Alpaca/Patrimonio) where a 4-digit amount
 *  ($4,731) still reads as currency. Distinct from fmtMoney (used by every
 *  other command), which drops the separator under $10k to save width on a
 *  dense /status line — that tradeoff doesn't apply to the once-a-day digest. */
function fmtMoneyGrouped(n: number): string {
  if (typeof n !== "number" || isNaN(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

function fmtNum(n: number, decimals = 2): string {
  if (typeof n !== "number" || isNaN(n)) return "0";
  return n.toFixed(decimals);
}

function signNum(n: number, decimals = 2): string {
  if (typeof n !== "number" || isNaN(n)) return "0";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(decimals);
}

function signMoney(n: number): string {
  if (typeof n !== "number" || isNaN(n)) return "$0";
  const sign = n >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/**
 * Render a "−$34.40 (−1.1%)" dollar+percent pair with ONE invariant: the
 * percent's sign always follows the dollar's. The realized dollar pnl is the
 * source of truth; if an upstream payload ever sources pnl and pnlPct from
 * different computations (e.g. a broker realizedPnl loss paired with a
 * price-quote gain) and they disagree in sign, we align the percent so a
 * self-contradictory line like "−$34.40 (+1.1%)" can never be displayed.
 * Centralized so every render site (close alert, /trades, …) is guarded.
 */
export function fmtPnlPair(pnl: number, pnlPct: number): string {
  const p = typeof pnl === "number" && !isNaN(pnl) ? pnl : 0;
  let pct = typeof pnlPct === "number" && !isNaN(pnlPct) ? pnlPct : 0;
  if ((p < 0 && pct > 0) || (p > 0 && pct < 0)) pct = -pct;
  return `${signMoney(p)} (${signNum(pct, 1)}%)`;
}

function signPct(n: number): string {
  if (typeof n !== "number" || isNaN(n)) return "0%";
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

/** 2-decimal percent for the digest header. Zero is a VALID reading (shows
 *  "0.00%", no sign) — distinct from null (rebased/unavailable → omitted by
 *  the caller). Only used where the spec calls for 2 decimals (Hoy/7D/Inicio);
 *  every other pct display in this file stays at 1 decimal (signPct). */
function fmtPct2(pct: number | null): string {
  if (pct == null || isNaN(pct)) return "";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

/** "Hoy +$123.21 (+0.11%)" — dollar always shown when the leg exists; percent
 *  parens omitted when pnlPct is null (rebased basis); the whole leg renders
 *  "Hoy —" when combineEquityPnlLegs itself failed closed (stale/missing
 *  truth) — never a partial number substituted in its place. */
/** "Cobrado hoy +$5,482.90 en 2 cierres · +$5,742.44 ya estaba ganado antes
 *  de hoy" — what closed trades realized, and how much of it was already in
 *  the P&L before today (so the P&L line above doesn't look wrong). */
function fmtRealizedToday(d: { realized: number; realizedCount: number; earnedBefore: number | null }): string {
  if (d.realizedCount === 0) return "Sin cierres hoy";
  const base = `Cobrado hoy ${signMoney(d.realized)} en ${d.realizedCount} ${pluralize(d.realizedCount, "cierre", "cierres")}`;
  return d.earnedBefore != null && Math.abs(d.earnedBefore) >= 1
    ? `${base} · ${signMoney(d.earnedBefore)} ya estaba ganado antes de hoy`
    : base;
}

function fmtPeriodLeg(label: string, leg: { pnl: number; pnlPct: number | null } | null): string {
  if (!leg) return `${label} —`;
  const pctStr = fmtPct2(leg.pnlPct);
  return `${label} ${signMoney(leg.pnl)}${pctStr ? ` (${pctStr})` : ""}`;
}

/** English trade-count nouns stay invariant except plural "s"; Spanish
 *  "posición abierta"/"posiciones abiertas" need the full word swap. */
function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  // Days past 48h: a 24-day hold read "575h47m".
  if (h >= 48) return h % 24 > 0 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
  return m % 60 > 0 ? `${h}h${m % 60}m` : `${h}h`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
}
const HTML_ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// ══════════════════════════════════════════════
// Alert formatters (pure → unit-testable). Reformulated 2026-06-22 to be
// specific + actionable instead of generic: every alert says WHAT happened,
// the IMPACT (numbers), and WHAT TO DO / what it means.
// ══════════════════════════════════════════════

/** Map a raw breaker reason to a short Spanish type label. */
function breakerType(reason: string): string {
  const r = (reason || "").toLowerCase();
  if (r.includes("daily drawdown")) return "drawdown diario";
  if (r.includes("weekly drawdown")) return "drawdown semanal";
  if (r.includes("consecutive stop")) return "racha de stops";
  if (r.includes("profit factor")) return "sangrado sostenido";
  if (r.includes("margin")) return "uso de margen";
  if (r.includes("manual")) return "pausa manual";
  return "límite de riesgo";
}

/** "20:30 ET (~3h 10m)" or "la próxima sesión" when there's no fixed resume. */
function untilHuman(resumeAt: number): string {
  if (!resumeAt || resumeAt <= Date.now()) return "la próxima sesión";
  const ms = resumeAt - Date.now();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  const etTime = new Date(resumeAt).toLocaleTimeString("en-GB", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const rel = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
  return `${etTime} ET (~${rel})`;
}

/** 🚨 Circuit-breaker pause — what tripped, impact, when it lifts, what to do. */
export function fmtCircuitBreakerAlert(data: any, acc?: any): string {
  const pid = data?.profileId || "?";
  const lines = [`🚨 <b>${profileName(pid)} en pausa preventiva</b> · ${breakerType(String(data?.reason || ""))}`];
  if (data?.reason) lines.push(escapeHtml(String(data.reason)));
  if (acc) {
    const pos = acc.positions ?? acc.openPositions ?? 0;
    const posTxt = pos > 0
      ? `${pos} posición${pos > 1 ? "es" : ""} abierta${pos > 1 ? "s" : ""} siguen protegidas (protección/objetivo/tiempo máx)`
      : "sin posiciones abiertas";
    lines.push(`Equity $${fmtMoney(acc.equity)} · ${posTxt}`);
  }
  lines.push(`Sin nuevas entradas hasta ${untilHuman(data?.resumeAt)}. No requiere acción — reanuda solo (o desde el panel si querés forzarlo).`);
  return lines.join("\n");
}

/** ✅ Pause RESOLVED — the counterpart to fmtCircuitBreakerAlert's
 *  pause_started (B-ops-alerts.md #1): what the pause HAD been (so the
 *  message is self-contained even if the started alert scrolled away), and
 *  that new entries are enabled again. Positions were never left
 *  unmanaged, so there is nothing to "resume" for exits — only entries. */
/** 📉 SleeveGovernor recommend_redesign — the sleeve's rolling 90-day P&L
 *  is negative. Owner rule (2026-09-26): a failing strategy is redesigned so
 *  it keeps trading; nothing proposes switching it off, pausing it or moving
 *  it to shadow — so this message must not either. */
export function fmtRedesignRecommendation(data: any, acc?: any): string {
  const pid = data?.profileId || "?";
  const lines = [`📉 <b>${profileName(pid)}: rendimiento negativo sostenido</b>`];
  if (data?.reason) lines.push(escapeHtml(String(data.reason)));
  if (acc) lines.push(`Equity $${fmtMoney(acc.equity)}`);
  lines.push("Sigue operando. Recomendación: rediseñar la estrategia (experimento pre-registrado en experiments/).");
  return lines.join("\n");
}

export function fmtPauseResolvedAlert(data: any, acc?: any): string {
  const pid = data?.profileId || "?";
  const lines = [`✅ <b>${profileName(pid)} reanuda entradas</b>`];
  if (data?.reason) lines.push(`Pausa levantada: ${escapeHtml(String(data.reason))}`);
  if (acc) lines.push(`Equity $${fmtMoney(acc.equity)}`);
  return lines.join("\n");
}

/** Contexts where "trading continues normally" is FALSE or misleading: these
 *  name an incident that can reduce a live position's protection (no
 *  confirmed native stop, a close broker-rejected with the position still
 *  live) or the very loop THAT protection depends on going stale/silent. The
 *  blanket reassurance below used to fire for these too (audit
 *  B-ops-alerts.md #8) — a heartbeat:sl_loop page saying "trading is fine"
 *  is self-contradictory: that IS the stop-loss loop. Prefix match — the
 *  heartbeat context carries the loop name after the colon. */
const NO_TRADING_REASSURANCE_CONTEXT_PREFIXES = [
  "heartbeat:sl_loop",
  "AccountManager.nativeStopMissing",
  "AccountManager.closeRejected",
];

/** ⚙️ Error burst — count + shape, reassurance first (UNLESS the context is
 *  one where trading is NOT continuing normally — see the prefix list
 *  above). The end client can't run shell commands; the technical shape
 *  stays in <code> for the operator. The module context (e.g. BrokerSync)
 *  names WHERE the burst fired. */
export function fmtErrorBurstAlert(data: any): string {
  const windowMs = Number(data?.windowMs) || 0;
  const msg = String(data?.message || "").slice(0, 140);
  const n = Number(data?.count ?? 0);
  // n===1 isn't "identical" to anything — it's a lone observation, not a rate.
  const evt = n === 1 ? "1 evento" : `${n} eventos idénticos`;
  // windowMs<=0 means "first observation this process has ever made" (e.g. a
  // fresh restart), not a genuine 0-second rate — `|| 60_000` used to fabricate
  // "en 60s" for that case. Omit the clause instead of inventing a window.
  const windowClause = windowMs > 0 ? ` en ${Math.round(windowMs / 1000)}s` : "";
  const context = String(data?.context || "");
  const tradingNormal = !NO_TRADING_REASSURANCE_CONTEXT_PREFIXES.some(p => context.startsWith(p));
  const closingLine = tradingNormal
    ? "El trading sigue operando con normalidad; quedó registrado para revisión."
    : "La protección de esta posición puede estar reducida — verificar manualmente en el panel.";
  return (
    `⚙️ <b>Incidencia técnica</b> · <code>${escapeHtml(context)}</code>\n` +
    `${evt}${windowClause} — <code>${escapeHtml(msg)}</code>\n` +
    `${closingLine}`
  );
}

/** Closes that did NOT execute a real fill — the bot has no confirmed P&L for
 *  them, so the alert must not claim a "+$0.00" trade happened. */
const RECONCILE_CLOSE_REASONS = new Set([
  "BROKER_GONE_404", "MANUAL_CLOSE_UNRECONCILED", "BACKFILLED_SYNC", "SYNC_DETECTED",
]);

/** 💰/📉 Position closed — pnl, reason (clear word), hold time, profile day P&L. */
export function fmtCloseAlert(trade: any, dayPnl?: number): string {
  const reason = trade?.closeReason || trade?.close_reason || "";
  const pid = trade?.accountId || trade?.profileId || "?";
  // Externally-reconciled closes (broker 404 / manual / sync) carry no real
  // fill, so trade.pnl is a placeholder 0. Rendering "+$0.00 (+0.0%)" told the
  // operator a flat trade happened when the position was actually closed off-bot
  // (unknown outcome). Surface the reconciliation honestly instead.
  if (RECONCILE_CLOSE_REASONS.has(reason)) {
    return (
      `♻️ <b>${escapeHtml(trade?.symbol || "?")}</b> cerrado directamente en el broker · ${profileName(pid)}` +
      ` · el resultado ya está reflejado en el equity`
    );
  }
  const pnl = trade?.pnl ?? 0;
  const pnlPct = trade?.pnlPct ?? trade?.pnl_pct ?? 0;
  const emoji = pnl >= 0 ? "💰" : "📉";
  const entryT = trade?.entryTime || trade?.entry_time;
  const exitT = trade?.exitTime || trade?.exit_time;
  const dur = entryT && exitT ? fmtDur(exitT - entryT) : "—";
  const reasonTxt = REASON_WORD[reason] || (reason ? String(reason).toLowerCase() : "");
  // The sleeve's realized total for today — NOT the day's P&L (a close whose
  // gain was earned over weeks can realize +$4,767 on a losing day). Was
  // "día +$X", which read as the day's P&L.
  const day = typeof dayPnl === "number" && !isNaN(dayPnl) ? ` · cobrado hoy ${signMoney(dayPnl)}` : "";
  return (
    `${emoji} <b>${escapeHtml(trade?.symbol || "?")}</b> cerrado ${fmtPnlPair(pnl, pnlPct)}` +
    ` · ${profileName(pid)}${reasonTxt ? ` · ${reasonTxt}` : ""} · abierta ${dur}${day}`
  );
}

/** Close reasons → clear Spanish words for the CLOSE alert (was terse codes). */
const REASON_WORD: Record<string, string> = {
  TRAILING_SL: "trailing stop",
  STOP_LOSS: "stop-loss",
  TAKE_PROFIT: "objetivo",
  MAX_HOLD: "tiempo máx",
  REVERSE_SIGNAL: "señal inversa",
  MANUAL_CLOSE: "cierre manual",
  MANUAL_CLOSE_UNRECONCILED: "cierre manual",
  BROKER_GONE_404: "cerrado en broker",
  BACKFILLED_SYNC: "sync",
  SYNC_DETECTED: "sync",
  // Engine close labels (ENGINE_CLOSE_REASONS / MeanRevEngine) — were
  // rendered as lowercase codes ("model_cutover").
  BROKER_STOP_LOSS: "stop-loss",
  TRAIL_STOP: "trailing stop",
  TIME_STOP: "tiempo máx",
  SLOT_DISPLACED: "reemplazada por una señal mejor",
  MODEL_CUTOVER: "cambio de modelo",
  MOMENTUM_REBALANCE: "rebalanceo",
  MEANREV_EXIT: "salida de reversión",
};
