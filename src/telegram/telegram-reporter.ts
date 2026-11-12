// ══════════════════════════════════════════════
// Uncle Carl Telegram Bot v4
// Concise rewrite (2026-05-19); daily digest reformatted (2026-07-19)
//
// Design goals:
//   1. One line per real-time event. No multi-line headers for routine OPEN/CLOSE.
//   2. ONE scheduled report per day (~00:01 ET, the completed day; 23:59 ET
//      until 2026-11-07). Removed 9am + 18:00 reports — they overlapped the
//      daily report and never added information that `/status` or `/profits`
//      couldn't pull on demand.
//   3. Push minimal, pull rich. Commands stay detailed; passive stream stays quiet.
//   4. `/quiet on` mutes OPEN/CLOSE event lines but still lets PAUSE / ERROR_BURST
//      through. Resets to off on bot restart by design (so an operator can't
//      forget they muted it).
//   5. Daily digest: client-facing summary (Hoy/7D/Inicio + active-sleeve
//      weekly W/L + Binance/Alpaca/Patrimonio truth), no operator-only detail
//      (top symbol, reject breakdown) — those stay in the dashboard.
//
// Commands: /start /status /trades /profits /report /quiet /help — honored ONLY from the
// configured user chat (TELEGRAM_CHAT_ID) and ops chat; any other chat is ignored (one
// log line per chat per 10 min). Auto-detection of the chat id happens only while none
// is configured.
// Real-time events: ORDER_FILLED · POSITION_CLOSED · CIRCUIT_BREAKER · ERROR_BURST
// ══════════════════════════════════════════════

import { existsSync, statSync, unlinkSync } from "fs";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { eventBus, EVENTS } from "../utils/events";
import { getTradingStats, getRecentTrades, getDB, RECONCILE_CLOSE_SQL, getETWindowStart, getETDayBounds, getETDateKey,
  getEquityPnlDisplay, getEquityWindowDisplay, getRecognizedRealizedPnl, closedEpisodePct, insertActivity, getSyncState, setSyncState } from "../db/database";
import { ALL_PROFILE_IDS } from "../config/riskProfiles";
import {
  computeScorecard, openHistoricalReadonly,
  bandEpisodeTransitions,
  type Scorecard, type BandStatus, type BandEpisodeState,
} from "../portfolio/scorecard";
import {
  getPortfolioEquityNow,
  combineEquityPnlLegs, isMainSeriesApplicable, portfolioMainLegs, readDisplayMoneyWindow,
} from "../portfolio/truth";
import { getMarketStatus } from "../utils/marketHours";
import { fetchT } from "../utils/timeout";
import { TelegramOutbox, type SendOutcome } from "./outbox";
import type { PortfolioState } from "../utils/types";
import type { Database } from "bun:sqlite";
import { type BreakdownPosition, type PnlBreakdown } from "../portfolio/pnlBreakdown";
import { readMoneyWindow, readSleeveMoney, readOpenMoney, readBinanceMarginBreakdown, moneyReportDate } from "../portfolio/money";
import { computeKpiSnapshot } from "../portfolio/kpis";
// @ts-ignore shared bilingual presentation vocabulary.
import { closeReasonWord } from "../dashboard/public/v4/js/close-reasons.js";
// @ts-ignore shared whole-dollar formatter (the dashboard uses it verbatim).
import { signedWholeMoney as signMoney } from "../dashboard/public/v4/js/money-values.js";

const log = createLogger("Telegram");
const API = "https://api.telegram.org/bot";
// Touched by auto-deploy.sh right before a planned restart so the startup
// banner stays silent on code pushes (only unexpected restarts ping).
const DEPLOY_MARKER = "data/.deploy-restart";
// Durable retry queue for sendMessage failures during network cuts —
// data/ is gitignored; see src/telegram/outbox.ts for the full doctrine.
const OUTBOX_PATH = "data/telegram-outbox.json";
const OUTBOX_DRAIN_INTERVAL_MS = 30_000;
const CONNECT_RETRY_BASE_MS = 15_000;
const CONNECT_RETRY_CAP_MS = 10 * 60_000;
// A dated digest composed within this long after its ET day ended may still
// carry the live sections (positions, wallet, KPI, scorecard); later than
// that only the figures-only final digest is honest (A-12).
export const DIGEST_LIVE_GRACE_MS = 30 * 60_000;

// Short tag per profile — keep Telegram lines under 80 chars on mobile.
const SHORT: Record<string, string> = {
  momentum_stocks: "M-S",
  momentum_crypto: "M-C",
  momentum_crypto_usdc: "M-USDC",
  momentum_btc: "M-BTC",
  meanrev_stocks: "MR-S",
};

// Single-event alerts (open/close/pause/resume) and the daily digest speak to
// the END CLIENT — full Spanish names, no trader codes. Dense operator
// commands use the same names and money vocabulary.
const FULL_NAME: Record<string, string> = {
  momentum_stocks: "Momentum Acciones",
  momentum_crypto: "Momentum Cripto",
  meanrev_stocks: "Reversión Acciones",
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

/** sync_state key of a band episode: the model version when known (`<sleeve>@<name>`), else the sleeve. */
export function bandEpisodeKey(sleeve: string, modelVersion: string | null | undefined): string {
  return modelVersion && modelVersion.startsWith(`${sleeve}@`) ? modelVersion : sleeve;
}
/** Inverse of bandEpisodeKey: the sleeve a stored episode key belongs to. */
export function sleeveOfBandEpisodeKey(key: string): string {
  const i = key.indexOf("@");
  return i > 0 ? key.slice(0, i) : key;
}

/** Rolling episodes deliberately survive model cutovers. */
export function rollingBandEpisodeKey(sleeve: string): string { return `${sleeve}@rolling20`; }

/** One log line per unauthorized chat per this window (a flood of strangers must not flood the log). */
export const IGNORED_CHAT_LOG_COOLDOWN_MS = 10 * 60_000;

export class TelegramReporter {
  private token: string;
  private chatId: string;
  /** Operator chat for engineering alerts; "" = log-only (see sendOps). */
  private opsChatId: string;
  private enabled = false;
  private initStarted = false;
  private connectionPending = false;
  private stopped = false;
  private connectRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectRetryDelayMs = CONNECT_RETRY_BASE_MS;
  private plannedDeploy = false;
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
    if (this.initStarted || this.stopped) return;
    this.initStarted = true;
    if (!this.token || this.token === "your_telegram_bot_token" || this.token.length < 20) {
      log.warn("Telegram bot token not configured — notifications disabled");
      return;
    }

    // Decide at BOOT, not after getMe: a network cut can delay connection past
    // the marker's freshness window. Consume it once and remember the result.
    try {
      if (existsSync(DEPLOY_MARKER)) {
        this.plannedDeploy = Date.now() - statSync(DEPLOY_MARKER).mtime.getTime() < 180_000;
        unlinkSync(DEPLOY_MARKER);
      }
    } catch { /* marker unreadable → treat as unexpected, announce */ }

    // A configured token awaiting validation may queue messages immediately.
    // The durable drain keeps its existing per-entry caps, TTL and backoff.
    this.outbox = this.outbox ?? new TelegramOutbox(OUTBOX_PATH);
    this.connectionPending = true;
    if (!this.outboxTimer) this.outboxTimer = setInterval(() => { void this.drainOutbox(); }, OUTBOX_DRAIN_INTERVAL_MS);
    await this.connect();
  }

  private async connect(): Promise<void> {
    // No in-band 429 sleep here: all connection retries belong to the
    // background timer, so an outage never holds up the rest of boot.
    const result = await this.apiCallOnce("getMe");
    if (this.stopped) return; // stop may have run while the probe was in flight
    const me = result?.data;
    const status = result?.status;
    const code = me?.error_code;
    const retryable = !result || status === 429 || (status != null && status >= 500) ||
      code === 429 || (typeof code === "number" && code >= 500);
    if (retryable || me?.ok !== true || (status != null && status >= 400)) {
      const rejected = !retryable && ((status != null && status >= 400 && status < 500) ||
        (me?.ok === false && typeof code === "number" && code >= 400 && code < 500));
      if (rejected) {
        this.connectionPending = false;
        log.error(`Telegram init failed: Invalid bot token (getMe HTTP ${status}, error_code ${code ?? "unknown"})`);
        if (this.outboxTimer) { clearInterval(this.outboxTimer); this.outboxTimer = null; }
        return;
      }
      const reason = result ? `HTTP ${status}, error_code ${code ?? "unknown"}` : "network/parse failure";
      const delay = this.connectRetryDelayMs;
      log.warn(`Telegram getMe temporarily unavailable (${reason}) — retrying in ${delay}ms; notifications queued`);
      this.connectRetryDelayMs = Math.min(delay * 2, CONNECT_RETRY_CAP_MS);
      this.connectRetryTimer = setTimeout(() => {
        this.connectRetryTimer = null;
        return this.connect();
      }, delay);
      return;
    }
    log.info(`🤖 Telegram bot connected: @${me.result?.username}`);
    this.enabled = true;
    this.connectionPending = false;

    if (!this.chatId || this.chatId === "your_chat_id") {
      log.info("Chat ID not set — waiting for /start command...");
    }

    this.setupEventListeners();
    this.startPolling();

    if (this.plannedDeploy) {
      log.info("Telegram: planned deploy restart — startup banner suppressed");
    } else {
      // F-11 (2026-11-07): a Telegram connection is not evidence of a
      // successful broker sync. The banner says what is true at this instant
      // and where the verification is reported; it never claims "positions
      // and protections verified" before the first sync has run.
      await this.sendOps("🟢 <b>Uncle Carl</b> arrancado tras un reinicio inesperado · Telegram conectado. Posiciones y protecciones se verifican en el primer sync con los brókers (≈1 min); cualquier fallo se avisa aquí.");
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
    if (this.stopped || (!this.enabled && !this.connectionPending)) return false;
    const target = chatId || this.chatId;
    if (!target || target === "your_chat_id") return false;
    if (!this.enabled) {
      if (this.outbox?.enqueue(target, text)) {
        log.warn(`Telegram connection pending — queued for retry, ${this.outbox.size()} pending`);
      }
      return false; // queued is not a delivery acknowledgement
    }
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
    if (this.stopped || (!this.enabled && !this.connectionPending) || !this.outbox || this.drainingOutbox) return;
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

        // Auto-detect ONLY while no chat is configured (first install); afterwards the
        // configured chats are the only principals.
        if (!this.chatConfigured()) {
          this.chatId = chatId;
          log.info(`Chat ID auto-detected: ${chatId}`);
        }
        // F-3 (2026-11-07): the bot used to answer any chat that found it — a stranger could read
        // /status and /trades or `/quiet on` the owner's alerts. Commands are accepted from the
        // configured user/ops chats only; anything else is dropped with a rate-limited log line.
        if (!this.isAuthorizedChat(chatId)) {
          this.logIgnoredChat(chatId, text);
          continue;
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

  private chatConfigured(): boolean {
    return !!this.chatId && this.chatId !== "your_chat_id";
  }

  /** Commands are honored from the configured user chat and the ops chat only. */
  isAuthorizedChat(chatId: string): boolean {
    return this.chatConfigured() && (chatId === this.chatId || (!!this.opsChatId && chatId === this.opsChatId));
  }

  private ignoredChatLogAt = new Map<string, number>();
  private logIgnoredChat(chatId: string, text: string): void {
    const now = Date.now(); // clock-ok: log rate limit only
    const last = this.ignoredChatLogAt.get(chatId) ?? 0;
    if (now - last < IGNORED_CHAT_LOG_COOLDOWN_MS) return;
    this.ignoredChatLogAt.set(chatId, now);
    log.warn(`Telegram: ignoring command "${text.slice(0, 32)}" from unauthorized chat ${chatId} (configured: ${this.chatId}${this.opsChatId ? `, ops ${this.opsChatId}` : ""}) — further messages from it are not logged for ${IGNORED_CHAT_LOG_COOLDOWN_MS / 60_000} min`);
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
        `/status — patrimonio y posiciones actuales\n` +
        `/trades — últimas 10 operaciones\n` +
        `/profits — resultados por estrategia desde el inicio\n` +
        `/report — reporte diario ahora\n` +
        `/quiet on|off — silencia OPEN/CLOSE (PAUSE/ERROR siguen)\n\n` +
        `<i>Reporte automático: ~00:01 ET, con el día completo</i>`,
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
    const daily = this.dailyPnlBreakdown();
    const now = getPortfolioEquityNow();
    const lines = [`📊 Ahora · ${market.status === "open" ? "bolsa abierta" : "bolsa cerrada"}`,
      `Patrimonio ${now.total == null ? "—" : `$${fmtMoney(now.total)}`}`,
      fmtPeriodLeg("Hoy", daily.pnl), ...fmtClosesToday(daily.breakdown), this.openMoneyLine(accounts)];
    for (const a of accounts) {
      lines.push(`${profileName(a.id)} $${fmtMoney(a.equity)}${initialMoney(a)} · ${a.positions} abiertas`);
    }
    await this.send(lines.join("\n"), chatId);
  }

  private openMoneyLine(accounts: any[]): string {
    const positions = this.getConsolidatedState?.()?.positions;
    const open = readOpenMoney(positions);
    const count = positions?.length ?? accounts.reduce((s, a) => s + (a.positions || 0), 0);
    const value = open.unpriced || (!positions && count) ? "—" : signMoney(open.total);
    return `Siguen abiertas: ${count} ${pluralize(count, "posición", "posiciones")}, ${value} desde que se abrieron`;
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
    // A-2/A-6 (2026-11-07): the current view lists ACTIVE sleeves only, with
    // the recognized realized (closed episodes + partials of open rows, net)
    // instead of closed-only; a sleeve that no longer runs appears in a dated
    // history line, never as a current balance. The footer says what it sums.
    const accounts = this.getAccountSummaries?.() || [];
    const lines = ["<b>Resultados por estrategia</b>"];

    for (const acc of accounts) {
      const id = acc.id;
      const stats = getTradingStats(id);
      const money = readSleeveMoney(id);
      lines.push(
        `${profileName(id)} $${fmtMoney(acc.equity)}${initialMoney(acc)} · ` +
          `${stats.closedTrades} ${pluralize(stats.closedTrades, "operación cerrada", "operaciones cerradas")}, ${fmtNum(stats.winRate, 0)} % ganadoras · ` +
          `resultado de lo cerrado ${signMoney(money.recognizedRealized)}`
      );
    }

    const activeIds = new Set(accounts.map((a: any) => a.id as string));
    const history: string[] = [];
    for (const id of ALL_PROFILE_IDS) {
      if (activeIds.has(id)) continue;
      const stats = getTradingStats(id);
      const last = getEquityWindowDisplay(id, 0);
      if (stats.closedTrades === 0 && !last) continue;
      history.push(
        `${profileName(id)} ya no opera · resultado de lo cerrado ${signMoney(getRecognizedRealizedPnl(id))} · ${stats.closedTrades} ${pluralize(stats.closedTrades, "operación cerrada", "operaciones cerradas")}` +
          `${last ? ` · último saldo $${fmtMoney(last.equity)} al ${getETDateKey(last.endAt)}` : ""}`
      );
    }
    if (history.length) {
      lines.push("<b>Estrategias anteriores (sin saldo actual)</b>");
      lines.push(...history);
    }

    const all = getTradingStats();
    lines.push(
      `<b>Total de lo cerrado ${signMoney(getRecognizedRealizedPnl())} · ${all.closedTrades} ${pluralize(all.closedTrades, "operación cerrada", "operaciones cerradas")}, ${fmtNum(all.winRate, 0)} % ganadoras</b>`
    );
    lines.push(this.openMoneyLine(accounts));
    const inicio = readDisplayMoneyWindow(this.mainLegs(), 0);
    lines.push(`${fmtPeriodLeg("Ganancia desde el inicio", inicio)}`);
    lines.push(...fmtDisplayStart(inicio?.start));
    await this.send(lines.join("\n"), chatId);
  }

  private async cmdReport(chatId: string) {
    await this.sendDailyDigest(chatId);
  }

  // ══════════════════════════════════════════
  // Daily digest — invoked on demand (/report) or by DailyReporter after ET midnight.
  // Client-facing summary: Hoy/7D header, active-trade counts, active-sleeve
  // weekly W/L (best→worst), Binance/Alpaca broker truth, Patrimonio/Inicio.
  // Top-symbol and reject-breakdown are operator detail — dashboard
  // only, never the passive digest (2026-07-19 mandate).
  // ══════════════════════════════════════════

  /**
   * Compose the client-facing daily digest. Called both from /report (any
   * time) and from DailyReporter (~00:01 ET, for the completed day). Returns the HTML body.
   *
   * Every dollar/percent figure is sourced from src/portfolio/truth.ts
   * (combineEquityPnlLegs over the applicable *_main broker series —
   * alpaca_main + binance_main + binance_coinm_main once DAPI has ever
   * synced), the SAME contract the dashboard KPIs use. A leg that's stale or
   * missing renders "—" for that figure rather than a partial/fabricated
   * number (fail closed, never silently substitute a sleeve-ledger sum).
   */
  composeDailyDigest(reportDate = moneyReportDate()): string {
    // A-8/A-12 (2026-11-07): a dated digest (DailyReporter, after the ET day
    // has ended) reads every window AS OF the end of that day — the autumn
    // 25-hour day included — and is labelled with it. Minutes after midnight
    // the live sections (positions, wallet, KPI, scorecard) still describe
    // that day; a late catch-up gets the figures-only final digest instead
    // of today's live state credited to a past date.
    let asOf = Date.now();
    if (reportDate) {
      const [, end] = getETDayBounds(reportDate);
      if (end > Date.now()) throw new Error(`Cannot finalize incomplete ET day ${reportDate}`);
      if (Date.now() - end > DIGEST_LIVE_GRACE_MS) return this.composeFinalDigest(reportDate);
      asOf = end - 1;
    }
    const accounts = this.getAccountSummaries?.() || []; // ACTIVE sleeves only (AccountManager.getAccountSummaries)
    const dateLabel = new Date(asOf).toLocaleDateString("es-ES", {
      timeZone: "America/New_York",
      weekday: "long",
      day: "numeric",
      month: "short",
    });

    const db = getDB();
    // Rolling 7d window, re-anchored to ET midnight (a plain −6d offset from
    // dayStart drifts an hour across DST transitions).
    const weekStart = getETWindowStart(7, asOf);
    const RECONCILE = `AND ${RECONCILE_CLOSE_SQL}`; // shared with getTradingStats (db/database.ts) so dashboard + digest never drift

    // Every active strategy, best→worst by its existing 7-day equity reader.
    // Closed-operation counts describe outcomes, not the period's gain.
    const sleeveRows: string[] = [];
    const sleevePnls: Array<{ id: string; mtm: number | null; w: number; l: number }> = [];
    for (const a of accounts) {
      const wkQ = db
        .prepare(
          `SELECT SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) w,
                  SUM(CASE WHEN pnl<0 THEN 1 ELSE 0 END) l
           FROM trades
           WHERE status='closed' AND account_id=? AND exit_time >= ? AND exit_time <= ? ${RECONCILE}`
        )
        .get(a.id, weekStart, asOf) as { w: number; l: number } | undefined;
      const w = wkQ?.w ?? 0, l = wkQ?.l ?? 0;
      sleevePnls.push({ id: a.id, mtm: getEquityPnlDisplay(a.id, 7, asOf)?.pnl ?? null, w, l });
    }
    sleevePnls.sort((x, y) => (y.mtm ?? -Infinity) - (x.mtm ?? -Infinity) || x.id.localeCompare(y.id));
    for (const r of sleevePnls) {
      sleeveRows.push(`${profileName(r.id)} ${r.mtm == null ? "—" : signMoney(r.mtm)} · ${r.w} ${pluralize(r.w, "ganada", "ganadas")}, ${r.l} ${pluralize(r.l, "perdida", "perdidas")}`);
    }

    // Header truth: alpaca_main + binance_main (+ binance_coinm_main once
    // DAPI has ever synced) — same applicability rule the dashboard uses, so
    // a never-enabled COIN-M sleeve never blocks the other two legs.
    const mainLegs = this.mainLegs();
    const daily = this.dailyPnlBreakdown(mainLegs, asOf);
    const weekLeg = combineEquityPnlLegs(mainLegs, 7, asOf);
    const inicio = readDisplayMoneyWindow(mainLegs, 0, asOf); // all-time display delta — NOT the 7D window, NOT a sleeve sum
    // Balances: live for the live digest; AS OF the day end for a dated one,
    // so Patrimonio, Alpaca and Binance are the same instant as its P&L lines
    // (the margin components are a live reading only — omitted when dated).
    const portfolioNow = reportDate ? this.portfolioEquityAsOf(asOf) : getPortfolioEquityNow();
    const bin = reportDate
      ? { total: portfolioNow.binance == null ? null : portfolioNow.binance + (portfolioNow.coinm ?? 0), usdt: null, usdc: null, btc: null }
      : this.getBinanceDecomposition(portfolioNow);

    const lines: string[] = [];
    lines.push(`📊 <b>Uncle Carl</b> · ${dateLabel.replace(",", "").replace(/\./g, "")}`);
    lines.push(`${fmtPeriodLeg("Hoy", daily.pnl)} · ${fmtPeriodLeg("últimos 7 días", weekLeg)}`);
    lines.push(fmtPatrimonio(portfolioNow.total, inicio));
    lines.push(...fmtClosesToday(daily.breakdown));
    lines.push(this.openMoneyLine(accounts));

    // P0 (2026-10-09): owner KPIs vs goals — volume (executed orders),
    // 30-day return, drawdown vs budget. Fail-soft: a broken KPI read never
    // tumbles the digest (same discipline as the scorecard section below).
    for (const l of this.kpiDigestLines(asOf)) lines.push(l);

    if (sleeveRows.length > 0) {
      lines.push("");
      lines.push("<b>Ganancia de los últimos 7 días</b>");
      for (const r of sleeveRows) lines.push(r);
    }

    // One plain verdict and the 20-session return. Detailed percentile bands
    // stay in the operator scorecard. Unavailable data never breaks the digest.
    const scorecardLines = this.scorecardDigestLines();
    if (scorecardLines.length > 0) {
      lines.push("");
      lines.push("<b>Comparación con lo esperado</b>");
      for (const l of scorecardLines) lines.push(l);
    }

    lines.push("");
    lines.push(...fmtBrokerBalances(portfolioNow.alpaca, bin.total));
    if (portfolioNow.total != null && accounts.length > 0 && accounts.every(a => Number.isFinite(a.equity))) {
      const outside = portfolioNow.total - accounts.reduce((s, a) => s + a.equity, 0);
      if (outside > 50) lines.push(`Fuera de las estrategias: $${fmtMoney(outside)} (efectivo inicial de Alpaca y garantía en BTC)`);
    }

    return lines.join("\n");
  }

  /** Final historical digest for a late catch-up: every figure ends at the
   * requested ET day — never today's live wallet, KPI, positions or scorecard
   * credited to a past date (A-12). */
  private composeFinalDigest(date: string): string {
    const [, end] = getETDayBounds(date);
    if (end > Date.now()) throw new Error(`Cannot finalize incomplete ET day ${date}`);
    const now = end - 1;
    let hist: Database | null = null;
    try {
      hist = this.openHist();
      const daily = readMoneyWindow({ days: 1, now, hist, requireFresh: false });
      const week = readDisplayMoneyWindow(this.mainLegs(), 7, now, false);
      const start = readDisplayMoneyWindow(this.mainLegs(), 0, now, false);
      const lines = [`📊 <b>Uncle Carl</b> · ${digestDate(now)}`,
        `${fmtPeriodLeg("Hoy", daily.window)} · ${fmtPeriodLeg("últimos 7 días", week)}`,
        fmtPatrimonio(start?.equity ?? null, start),
        ...fmtClosesToday(daily.breakdown),
        "Posiciones al cierre: sin datos suficientes"];
      const balances = this.portfolioEquityAsOf(now);
      lines.push(...fmtBrokerBalances(balances.alpaca, balances.binance == null ? null : balances.binance + (balances.coinm ?? 0)));
      return lines.join("\n");
    } finally {
      try { hist?.close(); } catch {}
    }
  }

  /** The broker totals at an instant — the last reading of each applicable
   *  main series at or before `asOf`, the same rows the windows end on. */
  private portfolioEquityAsOf(asOf: number): ReturnType<typeof getPortfolioEquityNow> {
    const leg = (id: string) => readDisplayMoneyWindow([id], 1, asOf, false)?.equity ?? null;
    const coinmApplicable = isMainSeriesApplicable("coinm");
    const alpaca = leg("alpaca_main"), binance = leg("binance_main");
    const coinm = coinmApplicable ? leg("binance_coinm_main") : null;
    const failed = alpaca == null || binance == null || (coinmApplicable && coinm == null);
    return { total: failed ? null : alpaca + binance + (coinm ?? 0), alpaca, binance, coinm };
  }

  /**
   * P0 KPI lines for the digest (volume / return / drawdown vs the owner's
   * goals). Figures come from src/portfolio/kpis.ts — the SAME computation
   * GET /api/kpis serves, so Telegram and the dashboard can't disagree.
   * Targets unset (fresh install/fork) → the raw figures, no goal. Fail-soft:
   * [] on any throw.
   */
  private kpiDigestLines(now = Date.now()): string[] {
    try {
      const k = computeKpiSnapshot(now);
      const t = k.targets;
      const lines: string[] = [];
      const vol7 = fmtNum(k.volume.avg7d, 0);
      lines.push(t.tradesPerDay
        ? `Órdenes hoy ${k.volume.today} de ${t.tradesPerDay} · media de 7 días ${vol7}`
        : `Órdenes hoy ${k.volume.today} · media de 7 días ${vol7}`);
      if (k.ret.dailyAvgPct30d != null) {
        const r = k.ret.dailyAvgPct30d;
        lines.push(t.dailyReturnPct
          ? `Rentabilidad media de 30 días ${fmtPct2(r)} al día (meta ${fmtPct2(t.dailyReturnPct)})`
          : `Rentabilidad media de 30 días ${fmtPct2(r)} al día`);
      }
      if (k.risk.drawdownPct != null) {
        const dd = k.risk.drawdownPct;
        lines.push(t.riskBudgetDdPct
          ? `Caída desde el máximo ${fmtNum(dd, 1).replace(".", ",")} % (límite ${fmtNum(t.riskBudgetDdPct, 0)} %)`
          : `Caída desde el máximo ${fmtNum(dd, 1).replace(".", ",")} %`);
        const alert = riskAlertLine(dd, t.riskBudgetDdPct);
        if (alert) lines.push(alert);
      }
      return lines;
    } catch (e: any) {
      log.warn(`KPI digest lines unavailable: ${e?.message ?? e}`);
      return [];
    }
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

    const b = readBinanceMarginBreakdown(this.getAccountSummaries?.() ?? []);
    const btc = b.fapiBtcCollateral == null || (coinmApplicable && b.coinmMargin == null)
      ? null : b.fapiBtcCollateral + (b.coinmMargin ?? 0);
    return { total, usdt: b.usdtFutures, usdc: b.usdcFutures, btc };
  }

  private mainLegs(): string[] {
    return portfolioMainLegs();
  }

  /** Today's P&L (the change in the accounts' value — combineEquityPnlLegs)
   *  split the way the dashboard tile splits it (src/portfolio/pnlBreakdown.ts):
   *  what today's closes and trims made INSIDE today, and the rest
   *  ("positions" = pnl − closes), so the two add up to the headline. The
   *  since-entry figure rides along for the second line. A position that
   *  built its gain over weeks realizes all of it today, but only today's
   *  move is in the P&L (2026-09-28: META closed +$4,767.74 on a −$831 day;
   *  2026-11-06: ten 5-day renewals showed "+$367 · realized −$912"). /status
   *  and the digest share this. */
  private dailyPnlBreakdown(mainLegs = this.mainLegs(), now = Date.now()): { pnl: ReturnType<typeof combineEquityPnlLegs>; breakdown: PnlBreakdown } {
    let hist: Database | null = null;
    try {
      hist = this.openHist();
      const openPositions: BreakdownPosition[] = (this.getConsolidatedState?.()?.positions || []).map((p: any) => ({
        accountId: p.profileId, symbol: p.symbol, market: p.market, side: p.side, quantity: p.quantity,
        entryPrice: p.avgEntryPrice, entryTime: p.openedAt, currentPrice: p.currentPrice,
      }));
      const money = readMoneyWindow({ days: 1, now, profiles: mainLegs, hist, positions: openPositions,
        accounts: this.getAccountSummaries?.().map(a => a.id) });
      return { pnl: money.window, breakdown: money.breakdown };
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
    return sc ? sc.entities.filter(e => e.kind === "sleeve").map(e => {
      const b = e.rollingBand;
      const below = b?.status === "below" || e.band?.status === "below";
      const alarm = b?.status === "below" && b.liveCumReturnPct != null && b.cumReturnPct?.p1 != null && b.liveCumReturnPct < b.cumReturnPct.p1;
      const words = alarm ? "muy por debajo: alarma" : below ? "peor de lo normal: revisar"
        : b && ["within", "above"].includes(b.status) ? "dentro de lo esperado" : "aún sin datos suficientes";
      return `${profileName(e.id)} · ${words} · últimas 20 sesiones ${b?.liveCumReturnPct == null ? "—" : signPct(b.liveCumReturnPct)}`;
    }) : [];
  }

  /** sync_state key holding the JSON map sleeve → "below"|"ok". */
  static readonly BAND_STATE_KEY = "scorecard_band_state";

  /**
   * Ops alert ONCE per episode: pages when a sleeve's live cumulative return
   * since its model start OR over the last 20 completed grid sessions crosses
   * BELOW the p5 of its validated OOS band (independent episodes)
   * (the automatic "rinde peor que lo validado" signal — the measurable
   * spirit of the pre-registered 60-session reversion criteria quoted in
   * src/portfolio/scorecard.ts), and again when it comes back inside.
   * State persists in sync_state so restarts don't re-page.
   */
  private async checkScorecardBandEpisodes(): Promise<void> {
    const sc = this.computeScorecardNow();
    if (!sc) return;
    // Episode key = the MODEL VERSION the band judges (`<sleeve>@<name>`,
    // bandEpisodeKey), not the sleeve: a new model starts with no episode, so
    // a "below" left by the retired model never turns into a false "volvió
    // DENTRO" for its successor (RW2 cutover 2026-10-23). Keys of retired
    // versions stay in the stored map untouched.
    const current: Record<string, BandStatus> = {};
    for (const e of sc.entities) if (e.kind === "sleeve") {
      if (e.band) current[bandEpisodeKey(e.id, e.band.modelVersion)] = e.band.status;
      if (e.rollingBand) current[rollingBandEpisodeKey(e.id)] = e.rollingBand.status;
    }

    let prev: Partial<Record<string, BandEpisodeState>> = {};
    try { prev = JSON.parse(getSyncState(TelegramReporter.BAND_STATE_KEY) ?? "{}"); } catch {}
    const { transitions, next } = bandEpisodeTransitions(prev, current);

    for (const tr0 of transitions) {
      const tr = { ...tr0, sleeve: sleeveOfBandEpisodeKey(tr0.sleeve) };
      const e = sc.entities.find(x => x.id === tr.sleeve);
      const rolling = tr0.sleeve === rollingBandEpisodeKey(tr.sleeve);
      const b = rolling ? e?.rollingBand : e?.band;
      const windowLabel = rolling ? "últimas 20 sesiones" : `modelo desde ${b?.modelStart ?? "?"}`;
      const fmt = (x: number | null | undefined) => x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
      if (tr.kind === "entered_below") {
        await this.sendOps(
          `📉 <b>Scorecard</b> · ${profileName(tr.sleeve)} POR DEBAJO de la banda OOS validada\n` +
          `Retorno vivo ${fmt(b?.liveCumReturnPct)} en ${b?.horizonSessions ?? "?"} sesiones (${windowLabel}) ` +
          `vs banda p5/p50/p95 ${fmt(b?.cumReturnPct?.p5)} / ${fmt(b?.cumReturnPct?.p50)} / ${fmt(b?.cumReturnPct?.p95)}` +
          `${b?.selectionBias ? ` (ya ajustada por sesgo de selección del universo: −${b.selectionBias.sharpeHaircut.toFixed(2).replace(".", ",")} de Sharpe)` : ""}.\n` +
          `Señal automática de "rinde peor que lo validado" — revisar y rediseñar manteniendo la operativa. Aviso único por episodio.`
        );
      } else {
        await this.sendOps(
          `✅ <b>Scorecard</b> · ${profileName(tr.sleeve)} volvió DENTRO de la banda OOS validada ` +
          `(retorno vivo ${fmt(b?.liveCumReturnPct)} en ${b?.horizonSessions ?? "?"} sesiones; ${windowLabel}).`
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
      this.send(
        `🟢 ${o?.side === "sell" ? "Venta" : "Compra"} de <b>${escapeHtml(o?.symbol || "?")}</b> · ${profileName(pid)}`
      );
    });
    eventBus.on(EVENTS.POSITION_CLOSED, (trade: any) => {
      if (this.quiet) return;
      const pid = trade.accountId || trade.profileId || "?";
      if (String(pid).startsWith("shadow_")) return;
      this.send(fmtCloseAlert(trade));
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
    this.stopped = true;
    this.enabled = false;
    this.connectionPending = false;
    if (this.connectRetryTimer) { clearTimeout(this.connectRetryTimer); this.connectRetryTimer = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
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
  return Math.round(n).toLocaleString("en-US");
}

function initialMoney(account: any): string {
  return Number.isFinite(account.initialEquity) ? ` (empezó con $${fmtMoney(account.initialEquity)})` : "";
}

function digestDate(at: number): string {
  return new Date(at).toLocaleDateString("es-ES", { timeZone: "America/New_York", weekday: "long", day: "numeric", month: "short" }).replace(",", "").replace(/\./g, "");
}

function fmtPatrimonio(equity: number | null, start: ReturnType<typeof readDisplayMoneyWindow>): string {
  const since = start ? `${signMoney(start.pnl)} desde el ${new Date(start.start.date + "T12:00:00Z").toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "UTC" }).replace(/\./g, "")}` : "desde el inicio —";
  return `Patrimonio ${equity == null ? "—" : `$${fmtMoney(equity)}`} · ${since}`;
}

function fmtBrokerBalances(alpaca: number | null, binance: number | null): string[] {
  const parts = [alpaca == null ? "" : `Alpaca $${fmtMoney(alpaca)}`, binance == null ? "" : `Binance $${fmtMoney(binance)}`].filter(Boolean);
  return parts.length ? [parts.join(" · ")] : [];
}

function fmtNum(n: number, decimals = 2): string {
  if (typeof n !== "number" || isNaN(n)) return "0";
  return n.toFixed(decimals);
}

/** Early warning at 60% of the declared drawdown budget — 15% of the owner's
 *  25% (plan V §9); a condition of the line E quorum (2026-10-10). No budget
 *  configured → no alert. */
export const RISK_ALERT_SHARE_OF_BUDGET = 0.6;

export function riskAlertLine(drawdownPct: number | null, budgetPct: number | null): string | null {
  if (drawdownPct == null || !budgetPct) return null;
  const alertAt = budgetPct * RISK_ALERT_SHARE_OF_BUDGET;
  if (drawdownPct < alertAt) return null;
  return `⚠️ La caída desde el máximo es ${fmtNum(drawdownPct, 1).replace(".", ",")} % (límite ${fmtNum(budgetPct, 0)} %). Conviene revisar la exposición.`;
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
  return `${signMoney(p)} (${signPct(pct)} de lo invertido)`;
}

function signPct(n: number): string {
  if (typeof n !== "number" || isNaN(n)) return "0%";
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${Math.abs(n).toFixed(1).replace(".", ",")} %`;
}

/** Daily-average percentages retain two decimals so the small daily goal is
 * meaningful. Money and period returns use whole dollars and one decimal. */
function fmtPct2(pct: number | null): string {
  if (pct == null || isNaN(pct)) return "";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(2).replace(".", ",")} %`;
}

/** Since-entry result of reducing legs, never the gain of today's window.
 * Partials are named explicitly rather than hidden inside the close count. */
export function fmtClosesToday(b: Pick<PnlBreakdown, "realized" | "closesCount" | "trimsCount" | "closedInWindow" | "positions">): string[] {
  const partial = b.trimsCount ? ` y ${b.trimsCount} ${pluralize(b.trimsCount, "cierre parcial", "cierres parciales")}` : "";
  return [`Cerradas hoy: ${b.closesCount} ${pluralize(b.closesCount, "operación", "operaciones")}${partial}, ${signMoney(b.realized)} en total (desde que se abrieron)`];
}

/** The ONE display-start line (A-1): date of the anchor every "since start"
 *  figure is measured from, and why no percentage accompanies a rebased one. */
export function fmtDisplayStart(start: { date: string; rebased: boolean } | null | undefined): string[] {
  if (!start) return [];
  return [`Desde el ${start.date}`];
}

function fmtPeriodLeg(label: string, leg: { pnl: number; pnlPct: number | null } | null): string {
  if (!leg) return `${label} —`;
  const pctStr = leg.pnlPct == null ? "" : signPct(leg.pnlPct);
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

/** One closed operation: its since-entry result, side, reason and duration.
 * The deprecated second argument is ignored, never labelled "cobrado hoy". */
export function fmtCloseAlert(trade: any, _dayPnl?: number): string {
  const reason = trade?.closeReason || trade?.close_reason || "";
  const pid = trade?.accountId || trade?.profileId || "?";
  // Externally-reconciled closes (broker 404 / manual / sync) carry no real
  // fill, so trade.pnl is a placeholder 0. Rendering "+$0.00 (+0.0%)" told the
  // operator a flat trade happened when the position was actually closed off-bot
  // (unknown outcome). Surface the reconciliation honestly instead.
  if (RECONCILE_CLOSE_REASONS.has(reason)) {
    return (
      `♻️ <b>${escapeHtml(trade?.symbol || "?")}</b> cerrado directamente en el broker · ${profileName(pid)}` +
      ` · el resultado ya está reflejado en el patrimonio`
    );
  }
  const pnl = trade?.pnl ?? 0;
  const pnlPct = closedEpisodePct({ ...trade, status: "closed", pnl,
    pnl_pct: trade?.pnlPct ?? trade?.pnl_pct, entry_price: trade?.entryPrice ?? trade?.entry_price }) ?? 0;
  const emoji = pnl >= 0 ? "💰" : "📉";
  const entryT = trade?.entryTime || trade?.entry_time;
  const exitT = trade?.exitTime || trade?.exit_time;
  const elapsed = entryT && exitT ? exitT - entryT : null;
  const dur = elapsed == null ? "—" : elapsed >= 48 * 3600000 ? `${Math.floor(elapsed / 86400000)} días` : fmtDur(elapsed);
  const basis = trade?.episode_basis ?? trade?.episodeBasis;
  // A legacy partial-close row has no full cost to display. Do not substitute
  // the final remnant's cost beside the reader's full-episode percentage.
  const invested = Number.isFinite(basis) && basis > 0 ? basis
    : trade?.partial_closed_contracts > 0 || trade?.quote_asset === "BTC" ? NaN
    : (trade?.entryPrice ?? trade?.entry_price) * (trade?.quantity ?? NaN);
  const pair = fmtPnlPair(pnl, pnlPct).replace(" de lo invertido)", ` de lo invertido${Number.isFinite(invested) && invested > 0 ? `, $${fmtMoney(invested)}` : ""})`);
  const side = ["sell", "short"].includes(trade?.side) ? "corto" : ["buy", "long"].includes(trade?.side) ? "largo" : "";
  return (
    `${emoji} <b>${escapeHtml(trade?.symbol || "?")}</b> cerrada · ${pair}` +
    ` · ${profileName(pid)}${side ? ` · ${side}` : ""} · ${closeReasonWord(reason, "es")} · duró ${dur}`
  );
}
