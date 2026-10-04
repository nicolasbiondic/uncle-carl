// ══════════════════════════════════════════════
// Alpaca Executor — stocks + crypto, REST + WS
// Single broker for all trading
// ══════════════════════════════════════════════

import crypto from "crypto";
import { config } from "../config";
import type { AlpacaRuntimeCredentials } from "./credentials";
import { getAssetClass } from "../config/symbols";
import { createLogger } from "../utils/logger";
import { fetchT, withTimeout } from "../utils/timeout";
import { eventBus, EVENTS } from "../utils/events";
import { checkPrice, checkQuote, DEFAULT_PLAUSIBILITY, plausibilityMode, RejectionTally, type Verdict } from "../market/plausibility";
import type { Signal, Order, Position, OHLCV } from "../utils/types";
import {
  resolveExecutionPolicy, chaseLimit, type ChaseVenue, type UnknownOrderResult,
  type OrderOutcome, type EntryExecutionConfig, type ExitExecutionConfig,
} from "./executionPolicy";
import { estimateFromQuote } from "./bookDepth";
import { getVenueRateLimiter, retryAfterMsFromHeaders, type RequestClass } from "./rateLimiter";
import { symbolLocks } from "./symbolLock";

const log = createLogger("AlpacaExecutor");
const EXECUTABLE_QUOTE_TTL_MS = 30_000;
/** Staleness window for RISK-MONITORING reads (getRiskPrice), deliberately
 *  wider than EXECUTABLE_QUOTE_TTL_MS: sending an order needs a <30s price,
 *  but answering "is this position past its stop?" tolerates a few-minutes-old
 *  print on a liquid large-cap. 5 min stays firmly inside the current session
 *  (never prior-session data) while covering IEX's sparse tape — measured
 *  2026-07-27: UNH's last IEX trade was >30s old in 12/12 samples (max 134s),
 *  which left the stop-loss loop — Alpaca positions' ONLY protection — blind. */
export const RISK_PRICE_TTL_MS = 5 * 60_000;
/** Historical stock bars come from the SIP (consolidated) feed, which Basic
 *  accounts may query for free as long as `end` is ≥15min in the past
 *  (verified 2026-08-07 against our own account: feed=sip&end=now−30min →
 *  HTTP 200; real-time → 403 "subscription does not permit querying recent
 *  SIP data"; documented in Alpaca's FAQ). 16min = the 15min floor + 1min
 *  clock-skew margin. Applies to HISTORICAL/SIGNAL bars only — executable
 *  quotes stay on IEX (a ≥15min-lagged price can never be executable). */
export const SIP_HISTORY_LAG_MS = 16 * 60_000;

/** Wall-clock budget for one getBars call (all pages). See the comment at the
 *  call site: sized for SIP's denser series, not IEX's sparse ones. */
export const GET_BARS_TIMEOUT_MS = 45_000;

/** Page budget for stock bars. SIP returns a bar per interval where IEX only
 *  returned one per IEX print, so the same history spans several times more
 *  pages. Exceeding this throws rather than silently returning a truncated
 *  series — a partial price history is a wrong decision, not a smaller one. */
export const STOCK_BARS_MAX_PAGES = 40;
/** Incremental stock-bar refresh (2026-09-02): once a symbol+timeframe has a
 *  REST-fetched series in the candle cache, later getBars calls fetch only
 *  the TAIL (from the last cached bar's own open time, inclusive — so a
 *  boundary bar that was end-clamp-truncated when cached is always replaced,
 *  never trusted as complete) and merge. This is what turned the momentum
 *  tick from re-downloading ~2 years × 11 symbols of SIP 5-min history every
 *  hour (the chronic getBars-timeout / background-budget-exhausted cluster)
 *  into one small page per symbol. A FULL refetch still happens whenever the
 *  cache is missing/invalidated (corporate action — rewritten adjusted
 *  history must never be tail-merged), shorter than the ask, or older than
 *  this interval: the bounded backstop for a corporate-action event that
 *  never arrives, mirroring the 30-min fetchedAt bound's role. 6h ≈ one
 *  session, so the first in-hours tick of each day re-anchors on a fresh
 *  full series (splits/dividends land at the open of ex-date). */
export const STOCK_BARS_FULL_REFETCH_INTERVAL_MS = 6 * 60 * 60_000;
/** Hard cap on cached bars per (symbol, timeframe) — bounds tail-merge
 *  growth between full refetches; comfortably above the widest widening ask
 *  (~9.7k 5-min bars for momentum_stocks' 31 trading days). */
const MAX_CACHED_STOCK_BARS = 25_000;
/** Alpaca allows exactly ONE market-data WS per account. A 406 on connect
 *  means another session already holds the slot — not transient, so back
 *  off hard instead of hammering the connection limit every few seconds. */
export const ALPACA_WS_CONTENDED_DELAY_MS = 300_000;
/** Matches broker failures that indicate the CLOSE was rejected because of
 *  the symbol format itself (e.g. DOGEUSD vs DOGE/USD), never a timeout. */
const SYMBOL_FORMAT_ERROR_RE = /422|not found|invalid symbol|asset[ _-]?not[ _-]?found|unprocessable/i;

// ── client_order_id — order attribution + broker-side idempotency ─────────
// Every order this bot places is stamped `uc8-<sleeve>-<suffix>`. That makes
// two things possible: (1) any order on the account WITHOUT this prefix is
// provably not from this bot (manual/unknown), and (2) an entry meant to
// happen at most once (see dailyEntryClientOrderId) can derive the SAME id
// twice, so a duplicate submission is rejected by Alpaca itself — the only
// guard that survives our own DB persist failing, a restart, or a stale
// broker-position read (see handleDuplicateClientOrderId below).
//
// 128 is Alpaca's documented cap (docs.alpaca.markets/reference/postorder,
// POST /v2/orders body schema: `client_order_id` `maxLength: 128`).
export const CLIENT_ORDER_ID_MAX_LEN = 128;
/** Exported for AccountManager's orphan-stop sweep: a cancel decision must
 *  re-verify OUR ownership itself, never trust an upstream filter alone. */
export const CLIENT_ORDER_ID_PREFIX = "uc8";
// Bound each part BEFORE assembly so the trailing suffix — the part that
// actually makes an id unique or deterministic — is never what gets cut by
// the overall length cap, even for a pathologically long sleeve name.
const CLIENT_ID_PART_MAX = 32;
/** Alpaca rejects a resubmission of a client_order_id already on the books
 *  with HTTP 422 and a message naming the field — recognized here as
 *  SUCCESS-ALREADY-DONE, never as an order failure (see placeOrder). */
const DUPLICATE_CLIENT_ORDER_ID_RE = /client[_ -]?order[_ -]?id/i;

export function sanitizeClientIdPart(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, CLIENT_ID_PART_MAX);
  return cleaned || "x";
}

function assembleClientOrderId(accountId: string, suffix: string): string {
  const id = [CLIENT_ORDER_ID_PREFIX, sanitizeClientIdPart(accountId), suffix].join("-");
  return id.length > CLIENT_ORDER_ID_MAX_LEN ? id.slice(0, CLIENT_ORDER_ID_MAX_LEN) : id;
}

/** Default suffix for any order that isn't a deterministic daily entry — a
 *  fresh id every call, just enough entropy to never collide in practice. */
function uniqueClientOrderId(accountId: string): string {
  return assembleClientOrderId(accountId, `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`);
}

/** Deterministic per (sleeve, symbol, ET trading day): the SAME triple
 *  always produces the SAME id. Pass the caller's own `getETDayStart()`
 *  result (src/db/database.ts) as `etDayStartMs` — this module never
 *  computes its own day boundary. */
export function dailyEntryClientOrderId(accountId: string, symbol: string, etDayStartMs: number): string {
  const hash = crypto.createHash("sha256").update(`${accountId}|${symbol}|${etDayStartMs}`).digest("hex").slice(0, 16);
  return assembleClientOrderId(accountId, hash);
}

/** Deterministic per (sleeve, trade row): the broker-native GTC stop-loss
 *  guarding a DB row always derives the SAME id, so a retried install is
 *  rejected broker-side as a duplicate (idempotent) and the fill can later
 *  be attributed back to the exact row it protected. The `sl` marker keeps
 *  stops greppable inside the shared uc8- namespace. */
export function stopLossClientOrderId(accountId: string, tradeId: string): string {
  const hash = crypto.createHash("sha256").update(`sl|${accountId}|${tradeId}`).digest("hex").slice(0, 16);
  return assembleClientOrderId(accountId, `sl${hash}`);
}

/** Broker statuses after which an order can never fire again. Anything else
 *  (new/accepted/held/partially_filled/…) counts as WORKING protection.
 *  NOTE `replaced` is deliberately NOT here: a replaced order can't fire,
 *  but its `replaced_by` successor CAN — treating it as plain-terminal made
 *  a forward-split-adjusted stop invisible (the successor carries a
 *  broker-generated client_order_id outside the uc8- namespace). Exported
 *  for AccountManager's per-status stop reconciliation. */
export const TERMINAL_ORDER_STATUSES = new Set(["filled", "canceled", "expired", "rejected"]);

/** Alpaca user-protection wash-trade rejection (docs.alpaca.markets
 *  docs/user-protection): with an open stop sell, a market BUY of the same
 *  symbol is ALWAYS rejected with HTTP 403 — "our wash trade protection also
 *  applies to your paper trading account". The status code alone is
 *  indistinguishable from PDT/permission 403s; only the body text names it. */
const WASH_TRADE_403_RE = /wash[ _-]?trade/i;
export function isWashTrade403(code: number | null, bodyMessage: string): boolean {
  return code === 403 && WASH_TRADE_403_RE.test(bodyMessage);
}

/** Alpaca 403 body when the requested qty is (still) held for other orders —
 *  the cancel-a-stop-then-sell race: the stop's DELETE was ACCEPTED but the
 *  order sits `pending_cancel` and its shares remain held_for_orders, so the
 *  close bounces (MA 2026-09-25, CAT 2026-09-14). Transient by nature —
 *  closePositionUnderLock retries the close a bounded number of times. */
const HELD_QTY_403_RE = /insufficient qty|held for orders|held_for_orders/i;

// ── Paper/live coherence guard (2026-08-09) ────────────────────────────────
//
// `ALPACA_PAPER` and `ALPACA_BASE_URL` are independent env vars, both passed
// to the SDK. Nothing verified they agreed: ALPACA_PAPER=true with
// ALPACA_BASE_URL=https://api.alpaca.markets IS a live-money account wearing a
// paper label. Same philosophy as isNonProductionBinanceHost
// (binance-executor.ts): an ALLOWLIST of known paper hosts, and an unknown
// host is REFUSED when paper is claimed — never assumed safe.

/** Is this REST base a known Alpaca PAPER endpoint? Allowlist, not a
 *  denylist of live hosts — the failure mode of an unknown host must be
 *  "refuse", never "assume it is paper". */
export function isKnownAlpacaPaperHost(url: string): boolean {
  return (url || "").toLowerCase().includes("paper-api.alpaca.markets");
}

/**
 * Returns the reason the (paper, baseUrl) pair is incoherent, or null when
 * it is safe. Both directions refuse:
 * - paper=true + non-allowlisted host: the dangerous direction — the operator
 *   believes paper but the SDK would sign against an unknown (possibly live)
 *   API. Hard refusal.
 * - paper=false + paper host: not dangerous by itself, but the config lies
 *   about intent either way — refused too, so going live ever requires BOTH
 *   variables to say so explicitly (a single-variable slip can never flip the
 *   account, in either direction).
 */
export function alpacaPaperLiveMismatch(paper: boolean, baseUrl: string): string | null {
  if (paper && !isKnownAlpacaPaperHost(baseUrl)) {
    return `ALPACA_PAPER=true but ALPACA_BASE_URL "${baseUrl}" is not a known paper host — unknown hosts are never assumed safe`;
  }
  if (!paper && isKnownAlpacaPaperHost(baseUrl)) {
    return `ALPACA_PAPER=false but ALPACA_BASE_URL "${baseUrl}" is a paper host — paper/live intent is contradictory`;
  }
  return null;
}

/** Normalized view of one of THIS bot's open protective stop orders. */
export interface AlpacaStopOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  stopPrice: number;
  status: string;
}

type CachedQuote = { price: number; timestamp: number };

export interface AlpacaExecutorOptions {
  /** F4a credential injection (ACCOUNTS_SOURCE=registry). ABSENT = env mode:
   *  every credential/URL accessor below reads `config.alpaca.*` LIVE (not
   *  captured at construction), byte-identical to the pre-F4 behavior —
   *  including the test seams that mutate config at runtime. Present = the
   *  injected values are the ONLY source; .env is never consulted. */
  credentials?: AlpacaRuntimeCredentials;
}

export class AlpacaExecutor {
  private client: any;
  private connected = false;

  /** Injected runtime credentials, or null = env mode (config-backed). */
  private readonly creds: AlpacaRuntimeCredentials | null;

  // ── Per-instance credential accessors (the ONLY credential reads in this
  // file — no direct config.alpaca.* anywhere below; locked by
  // src/executor/executorCredentials.test.ts) ──────────────────────────────
  private get keyId(): string { return this.creds ? this.creds.keyId : config.alpaca.keyId; }
  private get secretKey(): string { return this.creds ? this.creds.secretKey : config.alpaca.secretKey; }
  private get oauthToken(): string | null { return this.creds ? this.creds.oauthToken : null; }
  private get paper(): boolean { return this.creds ? this.creds.paper : config.alpaca.paper; }
  private get baseUrl(): string { return this.creds ? this.creds.baseUrl : config.alpaca.baseUrl; }
  private get dataUrl(): string { return this.creds ? this.creds.dataUrl : config.alpaca.dataUrl; }
  /** Auth headers for raw REST calls (trading + data APIs share the scheme):
   *  Bearer for OAuth tokens, APCA key headers otherwise — in env mode the
   *  exact header pair every raw fetch here always sent. */
  private get authHeaders(): Record<string, string> {
    return this.oauthToken
      ? { Authorization: `Bearer ${this.oauthToken}` }
      : { "APCA-API-KEY-ID": this.keyId, "APCA-API-SECRET-KEY": this.secretKey };
  }

  /** Non-secret credential view for the admin config route. */
  credentialPublicView(): { keyId: string; paper: boolean; authType: "api_key" | "oauth" } {
    return { keyId: this.keyId, paper: this.paper, authType: this.oauthToken ? "oauth" : "api_key" };
  }

  // ── Broker-side kill switch (2026-08-09) ─────────────────────────────────
  //
  // Alpaca's `suspend_trade` account configuration (PATCH
  // /v2/account/configurations; SDK: updateAccountConfigurations — see
  // node_modules/@alpacahq/alpaca-trade-api/dist/resources/account.js) makes
  // the ACCOUNT "unable to submit new orders". Its read side is
  // `trade_suspended_by_user` on GET /v2/account. Unlike TRADING_ENABLED /
  // RiskEngine state / governor modes — which live inside ONE process's env
  // or DB and are invisible to a zombie process, a stale clone, or an old
  // code version — this flag lives at the broker, the one place every
  // process sharing the credentials must respect. Operated via
  // ./start.sh panic / resume-trading (scripts/panic.ts).
  //
  // Division of labor:
  //  - The BROKER is the authoritative enforcer: while suspended it rejects
  //    every new order submission from ANY process (per Alpaca's documented
  //    semantics that includes closes and new stops; already-working GTC
  //    orders stay on the books).
  //  - THIS bot-side flag gates ONLY placeOrder (the sole entry path for
  //    real-broker Alpaca opens) so closes, protective stops and
  //    reconciliation keep RUNNING and retrying — the bot converges instead
  //    of hammering entries into 403s, and resumes cleanly on un-suspend.
  //
  // Read-failure policy: FAIL-OPEN (absent/unreadable ⇒ keep last-known,
  // initially false). Rationale: the broker enforces the suspension
  // regardless of what this advisory flag says, so a failed read never
  // reopens the hole — while fail-closed would turn any startup network
  // blip into a silent trading halt across all Alpaca sleeves.
  private tradeSuspendedByBroker = false;

  /** Latest known `trade_suspended_by_user` (startup + every getAccount()
   *  read, i.e. AccountManager's 60s sync). Health surfacing hook. */
  isTradeSuspendedByBroker(): boolean { return this.tradeSuspendedByBroker; }

  /** Update the kill-switch flag from a GET /v2/account payload. A missing
   *  or non-boolean field changes nothing (fail-open — see policy above). */
  private noteTradeSuspended(account: any): void {
    const raw = account?.trade_suspended_by_user;
    if (typeof raw !== "boolean") return;
    if (raw !== this.tradeSuspendedByBroker) {
      if (raw) {
        log.error(`🛑 BROKER KILL SWITCH ACTIVE (trade_suspended_by_user=true): new opens are blocked bot-side; the broker rejects all new orders account-wide. Clear with ./start.sh resume-trading`);
      } else {
        log.info(`✅ Broker kill switch cleared (trade_suspended_by_user=false) — opens re-enabled`);
      }
    }
    this.tradeSuspendedByBroker = raw;
  }

  /** Shared PER-VENUE limiter (rateLimiter.ts): the SDK trading client and
   *  the raw market-data fetches below draw on the same account quota. */
  private limiter = getVenueRateLimiter("alpaca");

  /** Run an SDK call under the venue limiter. A denial happens BEFORE the
   *  call is transmitted (safe to treat as proven_failed); a 429/418 the SDK
   *  surfaces afterwards is recorded so the limiter opens its penalty
   *  window. Never retries anything itself. */
  private async limited<T>(cls: RequestClass, fn: () => Promise<T>): Promise<T> {
    const acq = await this.limiter.acquire(cls);
    if (!acq.ok) {
      const e = new Error(`rate_limited: ${acq.reason}`) as Error & { rateLimitDenied?: boolean };
      e.rateLimitDenied = true;
      throw e;
    }
    try {
      return await fn();
    } catch (e: any) {
      const code = e?.response?.status ?? e?.status ?? e?.statusCode ?? null;
      if (code === 429 || code === 418) this.limiter.notePenalty(code);
      throw e;
    }
  }

  /** Same contract for raw data-API fetches (which expose real headers, so
   *  a 429's Retry-After is honored exactly). */
  private async limitedFetch(cls: RequestClass, doFetch: () => Promise<Response>): Promise<Response> {
    const acq = await this.limiter.acquire(cls);
    if (!acq.ok) {
      const e = new Error(`rate_limited: ${acq.reason}`) as Error & { rateLimitDenied?: boolean };
      e.rateLimitDenied = true;
      throw e;
    }
    const resp = await doFetch();
    if (resp.status === 429 || resp.status === 418) {
      this.limiter.notePenalty(resp.status as 429 | 418, retryAfterMsFromHeaders(resp.headers));
    }
    return resp;
  }

  /** Candle cache — latest complete bars per symbol + timeframe */
  // fetchedAt rides along so a failed refresh can only serve LAST-KNOWN bars
  // for a bounded window (OPEN.md P1: the age-less cache served candles of any
  // staleness forever after an exception/empty response — a decision path).
  // fullFetchAt marks a REST-fetched STOCK series eligible for the
  // incremental tail refresh (see STOCK_BARS_FULL_REFETCH_INTERVAL_MS);
  // absent on crypto/WS-fed entries, which always refetch in full.
  private candleCache: Map<string, { bars: OHLCV[]; fetchedAt: number; fullFetchAt?: number }> = new Map();
  private static readonly CANDLE_CACHE_MAX_AGE_MS = 30 * 60_000;
  /** Executable prices from live bars or snapshots, never historical requests */
  private latestPrices: Map<string, CachedQuote> = new Map();

  /** Stock WS */
  private stockWs: WebSocket | null = null;
  /** Crypto WS */
  private cryptoWs: WebSocket | null = null;

  private stockSymbols: string[] = [];
  private cryptoSymbols: string[] = [];
  private stockSubscribed: string[] = [];
  private cryptoSubscribed: string[] = [];
  private wsWanted = false;
  private wsReconnectDelay: Record<string, number> = { stock: 2000, crypto: 2000 };
  private wsMaxDelay = 30000;
  private lastContendedLogAt: Record<string, number> = { stock: 0, crypto: 0 };

  /** Plausibility rejections (src/market/plausibility.ts) — cooldown-
   *  aggregated, one summary line per 5min window, never per evaluation. */
  private plausibilityTally = new RejectionTally();

  /** Guard so trade_updates WS handlers are registered on the SDK client at
   *  most ONCE per executor instance. init() is re-runnable (AccountManager's
   *  60s sync retries it after a REST outage — 2026-08-16) and the SDK's
   *  AlpacaStreamClient callbacks are plain event-emitter registrations:
   *  wiring them again on every reconnect would double every ORDER_UPDATE. */
  private tradeUpdatesWired = false;

  /** Status tracking */
  lastMessageAt = 0;
  connectionState: "disconnected" | "connecting" | "connected" | "reconnecting" = "disconnected";
  stockWsState: "disconnected" | "connecting" | "connected" | "reconnecting" = "disconnected";
  cryptoWsState: "disconnected" | "connecting" | "connected" | "reconnecting" = "disconnected";

  constructor(options: AlpacaExecutorOptions = {}) {
    this.creds = options.credentials ?? null;
    try {
      const Alpaca = require("@alpacahq/alpaca-trade-api");
      // The SDK natively supports Connect tokens via `oauth`
      // (docs.alpaca.markets/us/docs/using-oauth2-and-trading-api). In env
      // mode the accessors resolve to the exact config.alpaca.* values this
      // constructor always passed.
      this.client = new Alpaca(this.oauthToken
        ? {
          oauth: this.oauthToken,
          paper: this.paper,
          baseUrl: this.baseUrl,
        }
        : {
          keyId: this.keyId,
          secretKey: this.secretKey,
          paper: this.paper,
          baseUrl: this.baseUrl,
        });
    } catch {
      log.warn("@alpacahq/alpaca-trade-api not available");
    }
  }

  // ── Lifecycle ─────────────────────────────

  async init(): Promise<boolean> {
    // Paper/live coherence gate — BEFORE any network call. Refusing here
    // leaves this executor disconnected (loud DEGRADED banner + ops page in
    // index.ts) without killing the process: the OTHER broker must keep
    // managing its open positions. Note refusal never orphans real Alpaca
    // exposure either — our DB rows live on the paper account, and an
    // incoherent config points the SDK at a DIFFERENT account, where
    // "managing" would be the bug, not the feature.
    const mismatch = alpacaPaperLiveMismatch(this.paper, this.baseUrl);
    if (mismatch) {
      log.error(`🚫 SAFETY: ${mismatch} — refusing to connect Alpaca`);
      return false;
    }
    if (!this.oauthToken && (!this.keyId || this.keyId === "your_alpaca_key")) {
      log.warn("Alpaca API keys not configured");
      return false;
    }
    try {
      const account = await this.limited("trade", () => withTimeout<any>(this.client.getAccount(), 10_000, 'alpaca getAccount'));
      log.info(`✅ Alpaca connected. Account: ${account.id}, Equity: $${account.equity}, Cash: $${account.cash}`);
      // Broker-side kill switch, read at startup from the SAME response —
      // no extra call, so this can never add a new startup failure mode.
      this.noteTradeSuspended(account);
      this.connected = true;
      this.connectionState = "connected";
      // Wave 3d (2026-05-07): subscribe to trade_updates user-data WS
      // when EXECUTION_WS=true. The polling fallback in OrderExecutor
      // remains enabled so any disconnect or missed event still resolves
      // the order. WS only fires events earlier (<1s vs ≤30s).
      if (config.execution.useWs) {
        this.subscribeTradeUpdates();
      }
      return true;
    } catch (e: any) {
      log.error(`Failed to connect to Alpaca: ${e.message}`);
      return false;
    }
  }

  // ── REST: Account ─────────────────────────

  async getAccount() {
    if (!this.connected) return null;
    try {
      const account = await this.limited("trade", () => withTimeout<any>(this.client.getAccount(), 10_000, 'alpaca getAccount'));
      // Kill-switch runtime refresh piggybacked on the existing 60s account
      // sync (AccountManager.syncAlpacaAccount) — no new polling loop. A
      // thrown read lands in the catch below: flag keeps its last-known
      // value (fail-open policy, see the field's comment).
      this.noteTradeSuspended(account);
      return account;
    } catch (e: any) {
      log.error(`getAccount error: ${e.message}`);
      return null;
    }
  }

  /** Reg-T buying power of the ONE real Alpaca account — the only
   *  cross-sleeve truth about remaining capacity. The stock sleeves
   *  (momentum_stocks + meanrev_stocks) are DB-ledger divisions of this
   *  account: each sizes off its own wallet and cannot see the other's live
   *  exposure (nor manual/orphan shares), so pre-submit entry guards must
   *  ask the broker, not the ledger. `regt_buying_power` is the binding
   *  constraint for this bot (multi-day holds; `buying_power` can be the 4×
   *  intraday figure on PDT-flagged accounts, which over-permits overnight).
   *  Returns null when unknown (disconnected, read error, unparseable) —
   *  callers must FAIL OPEN and let the broker enforce: a transient
   *  getAccount blip must never freeze entries (same policy as the
   *  kill-switch flag above). */
  async getRegTBuyingPower(): Promise<number | null> {
    const account = await this.getAccount();
    if (!account) return null;
    const raw = (account as any).regt_buying_power ?? (account as any).buying_power;
    const bp = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
    // A parseable value is returned as-is, INCLUDING a negative one (margin
    // call): that's broker truth about capacity and must block entries, not
    // fall into the unknown→fail-open path.
    return Number.isFinite(bp) ? bp : null;
  }

  // ── Wave 3d (2026-05-07): trade_updates user-data WS ───────────────
  //
  // The Alpaca SDK auto-instantiates client.trade_ws as an
  // AlpacaStreamClient pointed at wss://api.alpaca.markets/stream
  // (paper or live). It emits 'trade_updates' messages with the order
  // payload on every order lifecycle event: new, fill, partial_fill,
  // canceled, expired, rejected, done_for_day.
  //
  // This subscription runs IN ADDITION to the existing 30s REST poll;
  // both code paths converge on EVENTS.ORDER_UPDATE so consumers don't
  // need to care which one delivered the event. WS just fires earlier
  // (<1s vs up to 30s).
  private subscribeTradeUpdates(): void {
    try {
      const ws: any = (this.client as any)?.trade_ws;
      if (!ws) {
        log.warn("trade_ws not available on Alpaca client (SDK changed?)");
        return;
      }
      if (this.tradeUpdatesWired) {
        // Reconnect path: handlers already registered — just nudge connect
        // (idempotent in the SDK; see the comment at the bottom).
        try { ws.connect?.(); } catch (e: any) { log.warn(`trade_ws reconnect nudge failed: ${e?.message ?? e}`); }
        return;
      }
      this.tradeUpdatesWired = true;
      ws.onConnect?.(() => {
        log.info("Alpaca trade_updates WS connected");
        try { ws.subscribe?.(["trade_updates"]); } catch (e: any) {
          log.warn(`subscribe trade_updates failed: ${e?.message ?? e}`);
        }
      });
      ws.onDisconnect?.(() => {
        log.warn("Alpaca trade_updates WS disconnected (polling fallback active)");
      });
      ws.onStateChange?.((state: any) => {
        log.debug(`Alpaca trade_ws state → ${state}`);
      });
      ws.onError?.((e: any) => {
        log.warn(`Alpaca trade_ws error: ${e?.message ?? e}`);
      });
      ws.onOrderUpdate?.((msg: any) => {
        try {
          const order = msg?.order ?? msg?.data?.order ?? {};
          const filledQty = parseFloat(order.filled_qty ?? "0");
          const avgPx = parseFloat(order.filled_avg_price ?? "0");
          eventBus.emit(EVENTS.ORDER_UPDATE, {
            broker: "alpaca",
            externalId: order.id ?? order.client_order_id ?? null,
            status: String(order.status ?? msg?.event ?? "unknown"),
            filledQty: isFinite(filledQty) ? filledQty : 0,
            avgPx: isFinite(avgPx) ? avgPx : 0,
            eventType: msg?.event ?? null,
            ts: Date.now(),
          });
        } catch (e: any) {
          log.warn(`onOrderUpdate handler failed: ${e?.message ?? e}`);
        }
      });
      // Connect (idempotent in the SDK; safe to call even if already connected)
      ws.connect?.();
    } catch (e: any) {
      log.warn(`subscribeTradeUpdates failed: ${e?.message ?? e}`);
    }
  }

  // ── REST: Historical bars ─────────────────

  private candleCacheKey(symbol: string, timeframe: string): string {
    return `${symbol}:${timeframe}`;
  }

  async getBars(symbol: string, timeframe = "5Min", limit = 200): Promise<OHLCV[]> {
    if (!this.connected) return [];

    const assetClass = getAssetClass(symbol);
    const cacheKey = this.candleCacheKey(symbol, timeframe);
    const controller = new AbortController();
    // 12s was calibrated against the IEX feed. Moving history to SIP
    // (2026-08-08) multiplied the payload: IEX only emits a bar when IEX
    // itself printed a trade, so its series are sparse, while SIP emits every
    // interval. On the first trading day afterwards 83 of these fired across
    // 8 of the 11 momentum symbols, the pagination budget ran out too, and the
    // 30-minute staleness bound then correctly returned empty — which means
    // the sleeve stopped being able to decide on fresh data. This is a
    // BACKGROUND fetch for signals, not an execution path: a longer budget
    // costs nothing but a slower tick, while a short one costs the decision.
    const timeout = setTimeout(
      () => controller.abort(new Error(`getBars timeout (${GET_BARS_TIMEOUT_MS / 1000}s)`)),
      GET_BARS_TIMEOUT_MS,
    );

    try {
      if (assetClass === "crypto") {
        const bars = await this.getCryptoBarsREST(symbol, timeframe, limit, controller.signal);
        controller.signal.throwIfAborted();
        if (bars.length > 0) {
          this.candleCache.set(cacheKey, { bars, fetchedAt: Date.now() });
          return bars;
        }
      } else {
        // Stock path owns its cache writes: it must distinguish a FULL
        // refetch (fullFetchAt reset) from an incremental tail merge.
        const bars = await this.getStockBars(symbol, timeframe, limit, controller.signal);
        if (bars.length > 0) return bars;
      }
    } catch (e: any) {
      log.warn(`getBars ${symbol} failed: ${e.message}`);
    } finally {
      clearTimeout(timeout);
    }
    // Bounded stale fallback: recent-enough cache bridges a transient API
    // blip; anything older returns [] so the engines' completeness gates
    // block fresh decisions instead of acting on hours-old candles.
    const entry = this.candleCache.get(cacheKey);
    if (!entry) return [];
    const age = Date.now() - entry.fetchedAt;
    // slice(-limit): the cached series may be LONGER than this ask (tail
    // merges accumulate; a wider earlier ask may have seeded it).
    if (age <= AlpacaExecutor.CANDLE_CACHE_MAX_AGE_MS) return entry.bars.slice(-limit);
    log.warn(`getBars ${symbol}: cache is ${Math.round(age / 60_000)}min old (max 30) — returning empty so gates block`);
    return [];
  }

  /**
   * Stock-bar fetch with the incremental tail refresh (2026-09-02 — see
   * STOCK_BARS_FULL_REFETCH_INTERVAL_MS). Eligibility for the cheap path:
   * a cached REST series (fullFetchAt set — WS-fed entries never qualify:
   * mixing the IEX live stream into a SIP history would be feed soup) that
   * is deep enough for this ask and full-fetched recently enough. The tail
   * request starts AT the last cached bar's open time (inclusive), so the
   * boundary bar — possibly truncated by the SIP end clamp when it was
   * cached — is always replaced by the venue's fresh copy, never served as
   * complete. Any incremental failure falls through to the FULL fetch
   * (which keeps the SIP→IEX 403 degrade), never to a silent gap.
   */
  private async getStockBars(symbol: string, timeframe: string, limit: number, signal: AbortSignal): Promise<OHLCV[]> {
    const cacheKey = this.candleCacheKey(symbol, timeframe);
    const entry = this.candleCache.get(cacheKey);
    const canIncrement = entry !== undefined && entry.fullFetchAt !== undefined
      && entry.bars.length > 0 && entry.bars.length >= limit
      && Date.now() - entry.fullFetchAt <= STOCK_BARS_FULL_REFETCH_INTERVAL_MS;
    if (canIncrement) {
      try {
        const cached = entry.bars;
        const lastTs = cached[cached.length - 1]!.timestamp;
        const tail = await this.fetchStockBarsPaged(symbol, timeframe, 10_000, signal, "sip",
          new Date(Date.now() - SIP_HISTORY_LAG_MS).toISOString(), new Date(lastTs).toISOString());
        signal.throwIfAborted();
        // invalidateCandleCache may have fired WHILE the tail was in flight
        // (corporate action → adjusted history rewritten): merging would
        // resurrect the pre-event bars. Only merge if our snapshot is still
        // the live entry; otherwise fall through to the full refetch.
        if (this.candleCache.get(cacheKey) === entry) {
          // Merge: cached strictly-older bars + the fresh tail (both
          // ascending, tail[0] ≥ lastTs) — no duplicates, no reordering. An
          // empty tail (venue answered, nothing newer) keeps the series
          // unchanged but still counts as a successful refresh.
          const merged = tail.length === 0
            ? cached
            : [...cached.filter(b => b.timestamp < tail[0]!.timestamp), ...tail];
          const bars = merged.length > MAX_CACHED_STOCK_BARS ? merged.slice(-MAX_CACHED_STOCK_BARS) : merged;
          this.candleCache.set(cacheKey, { bars, fetchedAt: Date.now(), fullFetchAt: entry.fullFetchAt });
          return bars.slice(-limit);
        }
      } catch (e: any) {
        signal.throwIfAborted(); // a timed-out tail must not burn a doomed full fetch
        log.warn(`getStockBars ${symbol}: incremental refresh failed (${e?.message ?? e}) — retrying as a full fetch`);
      }
    }
    const bars = await this.getStockBarsREST(symbol, timeframe, limit, signal);
    signal.throwIfAborted();
    if (bars.length > 0) {
      this.candleCache.set(cacheKey, { bars, fetchedAt: Date.now(), fullFetchAt: Date.now() });
    }
    return bars;
  }

  private async getStockBarsREST(symbol: string, timeframe: string, limit: number, signal: AbortSignal): Promise<OHLCV[]> {
    // feed=sip (2026-08-07): IEX sees a tiny slice of the consolidated tape —
    // measured on HON, same daily bar: IEX n=2,903 trades / volume 134,898 /
    // low 239.99 vs SIP n=52,412 / volume 2,838,213 / low 239.48. IEX MISSED
    // the session's real low by $0.51: a stop between those prices fires in
    // reality but looks "untouched" on IEX bars — a systematic optimistic
    // bias in every signal/backtest. Basic accounts get FULL SIP history for
    // free when `end` is ≥15min old (SIP_HISTORY_LAG_MS), so signals use SIP;
    // a recency 403 (clock skew / policy change — shouldn't happen with the
    // clamp) degrades to IEX rather than leaving the engine without bars.
    // The EXECUTABLE layer (WS, getLatestPrice/getRiskPrice snapshots) stays
    // on IEX — do NOT route it through this lagged feed.
    try {
      return await this.fetchStockBarsPaged(symbol, timeframe, limit, signal, "sip",
        new Date(Date.now() - SIP_HISTORY_LAG_MS).toISOString());
    } catch (e: any) {
      if (e?.status === 403) {
        log.warn(`getStockBarsREST ${symbol}: SIP rejected 403 (${e?.message ?? e}) — degrading to feed=iex`);
        return await this.fetchStockBarsPaged(symbol, timeframe, limit, signal, "iex", undefined);
      }
      throw e;
    }
  }

  private async fetchStockBarsPaged(
    symbol: string, timeframe: string, limit: number, signal: AbortSignal,
    feed: "sip" | "iex", endIso: string | undefined, startIsoOverride?: string,
  ): Promise<OHLCV[]> {
    // 2026-07-09 (O4): was the SDK's getBarsV2 async ITERATOR, which has no
    // AbortSignal — a slow Alpaca left the suspended generator + its socket
    // leaking until it eventually resolved (a memory-leak vector; the getBars
    // Promise.race only unblocked the caller, not the iterator). Rewritten as a
    // raw fetch against the same /v2/stocks/bars data API, using getBars'
    // shared AbortSignal across every page. Paged via next_page_token.
    // Size the window from the requested bar count (the momentum stocks
    // sleeve asks for ~2.4k 5-min bars ≈ 31 trading days). ×1.6 calendar
    // factor covers weekends/holidays; floor of 5 days covers small asks.
    const tfMin = timeframe === "1Min" ? 1 : timeframe === "15Min" ? 15 : timeframe === "1Hour" ? 60 : timeframe === "1Day" ? 390 : 5;
    const tradingDays = Math.ceil((limit * tfMin) / 390); // 390 = minutes per session
    const daysBack = Math.max(5, Math.ceil(tradingDays * 1.6) + 3);
    const start = new Date(); start.setDate(start.getDate() - daysBack);
    const result: OHLCV[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < STOCK_BARS_MAX_PAGES; page++) {
      // adjustment=all (docs.alpaca.markets/reference/stockbars: `all` =
      // split + dividend + spin-off), was "split": an unadjusted ex-dividend
      // open prints an artificial ~-yield% gap that Connors RSI(2) reads as
      // a maximal (false) oversold buy signal, and a spin-off distribution
      // fakes a loss the same way. `all` and not "split,spin-off" because
      // there is NO adjusted dimension we'd want to exclude for signal
      // continuity — these bars feed indicators only, never execution
      // (orders price off live quotes/snapshots). TRAP: adjusted history is
      // REWRITTEN retroactively when an event lands, so the candleCache must
      // be dropped per symbol on a detected corporate action — see
      // invalidateCandleCache below (wired from AccountManager's
      // corporate-actions handler); the 30-min fetchedAt bound caps the
      // stale window even if that signal never arrives.
      // TRAP (measured 2026-08-07): in MULTI-symbol requests `limit` caps the
      // TOTAL points across all symbols, not per symbol (a 5-symbol 1Hour ask
      // returned 186 AAPL bars and nothing else, next_page_token non-null).
      // This fetcher is deliberately ONE symbol per request, so limit=10000
      // is effectively per-symbol here — do not batch symbols into one call
      // without redesigning the pagination.
      const params = new URLSearchParams({ symbols: symbol, timeframe, limit: "10000", adjustment: "all", feed, start: startIsoOverride ?? start.toISOString() });
      if (endIso) params.set("end", endIso);
      if (pageToken) params.set("page_token", pageToken);
      const resp = await this.limitedFetch("background", () => fetch(`${this.dataUrl}/v2/stocks/bars?${params}`, {
        headers: this.authHeaders,
        signal,
      }));
      if (!resp.ok) {
        const err = new Error(`${resp.status} ${resp.statusText}`) as Error & { status?: number };
        err.status = resp.status; // getStockBarsREST degrades SIP→IEX on 403
        throw err;
      }
      const data = await resp.json() as any;
      signal.throwIfAborted();
      for (const b of (data.bars?.[symbol] || [])) {
        result.push({ open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, timestamp: new Date(b.t).getTime() });
      }
      pageToken = data.next_page_token || undefined;
      if (!pageToken) break;
    }
    if (pageToken) throw new Error("stock bars pagination incomplete");
    return result.slice(-limit);
  }

  private async getCryptoBarsREST(symbol: string, timeframe: string, limit: number, signal: AbortSignal): Promise<OHLCV[]> {
    // Alpaca crypto data API: /v1beta3/crypto/us/bars.
    // 2026-06-26 fix: Alpaca caps each response at ~3.2k bars (and rejects
    // limit>10000 with a 400). A single request therefore returned far fewer
    // bars than asked — the MomentumEngine needs ~8.6k 5m bars for its 30d MA
    // and silently got 0 (400 on limit=10080) → it could never trade. Page
    // through `next_page_token` until we have `limit` bars (or run out).
    const cryptoTfMin = timeframe === "1Min" ? 1 : timeframe === "15Min" ? 15 : timeframe === "1Hour" ? 60 : timeframe === "1Day" ? 1440 : 5;
    const hoursBack = Math.max(24, Math.ceil(limit * cryptoTfMin / 60)); // enough hours for requested bars
    const start = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const perReq = 10_000; // Alpaca hard max; fetch the full window, then trim
    const base = `${this.dataUrl}/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${perReq}&start=${start}`;
    const result: OHLCV[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 12; page++) {
      const url = pageToken ? `${base}&page_token=${encodeURIComponent(pageToken)}` : base;
      const resp = await this.limitedFetch("background", () => fetch(url, {
        headers: this.authHeaders,
        signal,
      }));
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const data = await resp.json() as any;
      signal.throwIfAborted();
      const bars = data.bars?.[symbol] || [];
      for (const b of bars) {
        result.push({ open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, timestamp: new Date(b.t).getTime() });
      }
      pageToken = data.next_page_token || undefined;
      if (!pageToken) break;
    }
    if (pageToken) throw new Error("crypto bars pagination incomplete");
    // Keep the most recent `limit` bars (pages arrive oldest→newest).
    return result.length > limit ? result.slice(-limit) : result;
  }

  // ── WebSocket: Real-time streams ──────────

  async startRealTimeStream(stocks: string[], crypto: string[]) {
    this.stockSymbols = stocks;
    this.cryptoSymbols = crypto;
    this.wsWanted = true;

    if (!this.connected) {
      log.warn("Alpaca not connected — no real-time streams");
      return;
    }

    this.maybeResubscribeStock();
    this.maybeResubscribeCrypto();
  }

  private maybeResubscribeStock() {
    if (this.stockSymbols.length === 0) return;
    if (this.stockWs?.readyState === WebSocket.OPEN && this.stockWsState === "connected") {
      this.sendStockSubscriptions();
    } else if (!this.stockWs) {
      this.connectStockWs();
    }
  }

  private maybeResubscribeCrypto() {
    if (this.cryptoSymbols.length === 0) return;
    if (this.cryptoWs?.readyState === WebSocket.OPEN && this.cryptoWsState === "connected") {
      this.sendCryptoSubscriptions();
    } else if (!this.cryptoWs) {
      this.connectCryptoWs();
    }
  }

  private sendStockSubscriptions() {
    if (!this.stockWs || this.stockWs.readyState !== WebSocket.OPEN) return;
    const removed = this.stockSubscribed.filter(s => !this.stockSymbols.includes(s));
    if (removed.length > 0) {
      this.stockWs.send(JSON.stringify({ action: "unsubscribe", bars: removed }));
      log.info(`Stock WS unsubscribed: ${removed.join(", ")}`);
    }
    this.stockWs.send(JSON.stringify({ action: "subscribe", bars: this.stockSymbols }));
    log.info(`Stock WS subscribed: ${this.stockSymbols.join(", ")}`);
    this.stockSubscribed = [...this.stockSymbols];
  }

  private sendCryptoSubscriptions() {
    if (!this.cryptoWs || this.cryptoWs.readyState !== WebSocket.OPEN) return;
    const removed = this.cryptoSubscribed.filter(s => !this.cryptoSymbols.includes(s));
    if (removed.length > 0) {
      this.cryptoWs.send(JSON.stringify({ action: "unsubscribe", bars: removed }));
      log.info(`Crypto WS unsubscribed: ${removed.join(", ")}`);
    }
    this.cryptoWs.send(JSON.stringify({ action: "subscribe", bars: this.cryptoSymbols }));
    log.info(`Crypto WS subscribed: ${this.cryptoSymbols.join(", ")}`);
    this.cryptoSubscribed = [...this.cryptoSymbols];
  }

  private connectStockWs() {
    if (!this.wsWanted || this.stockSymbols.length === 0 || this.stockWs) return;
    if (this.oauthToken) {
      // Alpaca's market-data WS documents key/secret auth only — an OAuth
      // account keeps REST polling (every price path has a REST fallback).
      log.warn("Alpaca market-data WS requires API-key credentials — OAuth account stays on REST polling (stocks)");
      return;
    }
    this.stockWsState = "connecting";
    this.emitBrokerStatus();

    try {
      this.stockWs = new WebSocket("wss://stream.data.alpaca.markets/v2/iex");

      this.stockWs.onopen = () => {
        // Do NOT reset the backoff here: the TCP/TLS/WS handshake succeeds
        // even when the account's single market-data WS slot is contended —
        // the 406 rejection arrives afterwards as an application frame. Reset
        // only happens once the subscription is actually ack'd (below).
        this.stockWs!.send(JSON.stringify({
          action: "auth",
          key: this.keyId,
          secret: this.secretKey,
        }));
      };

      this.stockWs.onmessage = (event: MessageEvent) => {
        this.lastMessageAt = Date.now();
        try {
          const messages = JSON.parse(event.data.toString());
          for (const msg of Array.isArray(messages) ? messages : [messages]) {
            this.handleStockWsMsg(msg);
          }
        } catch {}
      };

      this.stockWs.onclose = () => {
        this.stockWs = null;
        this.stockWsState = "reconnecting";
        this.emitBrokerStatus();
        if (this.wsWanted) {
          log.warn(`Stock WS disconnected — reconnecting in ${this.wsReconnectDelay.stock / 1000}s`);
          setTimeout(() => this.connectStockWs(), this.wsReconnectDelay.stock);
          if (this.wsReconnectDelay.stock !== ALPACA_WS_CONTENDED_DELAY_MS) {
            this.wsReconnectDelay.stock = Math.min(this.wsReconnectDelay.stock * 2, this.wsMaxDelay);
          }
        }
      };
      this.stockWs.onerror = () => {};
    } catch (e: any) {
      log.error(`Stock WS failed: ${e.message}`);
      setTimeout(() => this.connectStockWs(), this.wsReconnectDelay.stock);
    }
  }

  private handleStockWsMsg(msg: any) {
    if (!msg?.T) return;
    if (msg.T === "success" && msg.msg === "authenticated") {
      this.sendStockSubscriptions();
    } else if (msg.T === "subscription") {
      log.info(`Stock WS subscription ack: ${msg.bars?.join(", ") || "none"}`);
      this.stockWsState = "connected";
      // The socket is proven usable only once a real ack arrives.
      this.wsReconnectDelay.stock = 2000;
      this.emitBrokerStatus();
    } else if (msg.T === "error") {
      this.handleWsErrorFrame("stock", msg);
    } else if (msg.T === "t") {
      this.handleTradeMsg(msg, "stock");
    } else if (msg.T === "b") {
      this.handleBarMsg(msg, "stock");
    }
  }

  private connectCryptoWs() {
    if (!this.wsWanted || this.cryptoSymbols.length === 0 || this.cryptoWs) return;
    if (this.oauthToken) {
      // See connectStockWs — OAuth accounts stay on REST polling.
      log.warn("Alpaca market-data WS requires API-key credentials — OAuth account stays on REST polling (crypto)");
      return;
    }
    this.cryptoWsState = "connecting";
    this.emitBrokerStatus();

    try {
      this.cryptoWs = new WebSocket("wss://stream.data.alpaca.markets/v1beta3/crypto/us");

      this.cryptoWs.onopen = () => {
        // See connectStockWs: reset only on a real subscription ack.
        this.cryptoWs!.send(JSON.stringify({
          action: "auth",
          key: this.keyId,
          secret: this.secretKey,
        }));
      };

      this.cryptoWs.onmessage = (event: MessageEvent) => {
        this.lastMessageAt = Date.now();
        try {
          const messages = JSON.parse(event.data.toString());
          for (const msg of Array.isArray(messages) ? messages : [messages]) {
            this.handleCryptoWsMsg(msg);
          }
        } catch {}
      };

      this.cryptoWs.onclose = () => {
        this.cryptoWs = null;
        this.cryptoWsState = "reconnecting";
        this.emitBrokerStatus();
        if (this.wsWanted) {
          log.warn(`Crypto WS disconnected — reconnecting in ${this.wsReconnectDelay.crypto / 1000}s`);
          setTimeout(() => this.connectCryptoWs(), this.wsReconnectDelay.crypto);
          if (this.wsReconnectDelay.crypto !== ALPACA_WS_CONTENDED_DELAY_MS) {
            this.wsReconnectDelay.crypto = Math.min(this.wsReconnectDelay.crypto * 2, this.wsMaxDelay);
          }
        }
      };

      this.cryptoWs.onerror = () => {};
    } catch (e: any) {
      log.error(`Crypto WS failed: ${e.message}`);
      setTimeout(() => this.connectCryptoWs(), this.wsReconnectDelay.crypto);
    }
  }

  private handleCryptoWsMsg(msg: any) {
    if (!msg?.T) return;
    if (msg.T === "success" && msg.msg === "authenticated") {
      this.sendCryptoSubscriptions();
    } else if (msg.T === "subscription") {
      log.info(`Crypto WS subscription ack: ${msg.bars?.join(", ") || "none"}`);
      this.cryptoWsState = "connected";
      this.wsReconnectDelay.crypto = 2000;
      this.emitBrokerStatus();
    } else if (msg.T === "error") {
      this.handleWsErrorFrame("crypto", msg);
    } else if (msg.T === "t") {
      this.handleTradeMsg(msg, "crypto");
    } else if (msg.T === "b") {
      this.handleBarMsg(msg, "crypto");
    }
  }

  /**
   * Alpaca's market-data WS sends `{T:"error", code, msg}` protocol frames on
   * auth failures, bad symbols, or the IEX feed's ~30-symbol subscription cap
   * — the socket often stays open with the subscription simply never
   * completing. Previously these frames matched none of the T-cases above and
   * were silently dropped, so a failed subscription looked identical to
   * "connected, quietly idle". log.error feeds the existing (context, shape)
   * burst detector (utils/logger.ts), which pages on-call after repeats.
   * ponytail: doesn't retry with a trimmed symbol list — that's a
   * cross-file decision (AccountManager owns the subscribed universe).
   *
   * code=406 ("connection limit exceeded") is a special case: it means
   * another session already holds the account's one market-data WS slot.
   * That's not a transient glitch worth retrying every few seconds — back
   * off to ALPACA_WS_CONTENDED_DELAY_MS and log at WARN (throttled to once
   * per window) instead of flooding ERROR/burst-detector every reconnect.
   */
  private handleWsErrorFrame(market: "stock" | "crypto", msg: any): void {
    if (msg.code === 406) {
      this.wsReconnectDelay[market] = ALPACA_WS_CONTENDED_DELAY_MS;
      const now = Date.now();
      if (now - this.lastContendedLogAt[market] >= ALPACA_WS_CONTENDED_DELAY_MS) {
        this.lastContendedLogAt[market] = now;
        log.warn(`Alpaca ${market} market-data WS slot held by another session (code=406) — REST snapshot fallback active; retrying in 5m`);
      }
      return;
    }
    log.error(`Alpaca ${market} WS protocol error: code=${msg.code} msg=${msg.msg}`);
  }

  private handleTradeMsg(trade: any, market: "stock" | "crypto") {
    const symbol = trade.S;
    if (!symbol || !trade.p) return;
    const price = Number(trade.p);
    if (!Number.isFinite(price) || price <= 0) return;
    const ts = trade.t ? new Date(trade.t).getTime() : NaN;
    if (!Number.isFinite(ts)) return;
    this.cacheExecutablePrice(symbol, price, ts);
    eventBus.emit(EVENTS.PRICE_UPDATE, { symbol, price, market });
  }

  private handleBarMsg(bar: any, market: "stock" | "crypto") {
    const symbol = bar.S;
    if (!symbol) return;

    const ohlcv: OHLCV = {
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      timestamp: new Date(bar.t).getTime(),
    };

    // ponytail: completed bars are CANDLE data, not executable quotes.
    // The latestPrices cache is fed by trade events (T="t") only.

    const cacheKey = this.candleCacheKey(symbol, "1Min");
    const entry = this.candleCache.get(cacheKey) ?? { bars: [], fetchedAt: 0 };
    entry.bars.push(ohlcv);
    // Keep max 300 stream candles per symbol to prevent memory leak
    while (entry.bars.length > 300) entry.bars.shift();
    entry.fetchedAt = Date.now(); // live stream = fresh by definition
    // An IEX-stream bar appended to a REST(SIP) series disqualifies it from
    // the incremental tail refresh — the next REST ask refetches in full.
    delete entry.fullFetchAt;
    this.candleCache.set(cacheKey, entry);

    eventBus.emit(EVENTS.PRICE_UPDATE, { symbol, price: ohlcv.close, market });
  }

  private emitBrokerStatus() {
    // Overall state: connected if at least one WS is up
    const anyWs = this.stockWsState === "connected" || this.cryptoWsState === "connected";
    this.connectionState = this.connected ? (anyWs ? "connected" : "connecting") : "disconnected";

    eventBus.emit("broker_status", {
      broker: "alpaca",
      state: this.connectionState,
      stockWs: this.stockWsState,
      cryptoWs: this.cryptoWsState,
      lastMessageAt: this.lastMessageAt,
    });
  }

  // ── Price access ──────────────────────────

  /** True if `eventTs` (the BROKER's own event timestamp) is recent enough to
   *  be an executable quote — rejects stale prior-session data (e.g. a WS
   *  reconnect replaying an old bar) and future-clock-skew timestamps. */
  private isFreshEventTime(eventTs: number): boolean {
    const now = Date.now();
    return eventTs <= now + 5_000 && now - eventTs <= EXECUTABLE_QUOTE_TTL_MS;
  }

  // ── Plausibility (src/market/plausibility.ts) ──
  // Default OBSERVE (count + aggregated log, block nothing);
  // PLAUSIBILITY_MODE=enforce makes rejections real. See the module header
  // for the UNH near-incident that motivates this.

  /** Deviation anchor: the last cached price within the RISK window — too
   *  stale to execute on, still valid as an order-of-magnitude sanity ref. */
  private getRefPrice(symbol: string): number | undefined {
    const cached = this.latestPrices.get(symbol);
    if (!cached || Date.now() - cached.timestamp > RISK_PRICE_TTL_MS) return undefined;
    return cached.price;
  }

  private noteImplausible(symbol: string, reason: string): void {
    this.plausibilityTally.add(`${symbol}:${reason}`);
    const msg = this.plausibilityTally.flush();
    if (msg) {
      const mode = plausibilityMode();
      log.warn(`[plausibility ${mode}] ${msg}${mode === "observe" ? " (observe: nothing blocked)" : ""}`);
    }
  }

  /** checkPrice against the cached ref, tallying rejections. */
  private priceVerdict(symbol: string, price: number): Verdict {
    const v = checkPrice(price, this.getRefPrice(symbol), DEFAULT_PLAUSIBILITY);
    if (!v.ok) this.noteImplausible(symbol, v.reason);
    return v;
  }

  /**
   * Cache the latest executable price, keyed on the BROKER's event
   * timestamp — not our receipt time. Using Date.now() here previously meant
   * a stale bar delivered late (reconnect replay, queued message behind a
   * stall) looked exactly as fresh as a live tick. Now: reject if the event
   * itself isn't fresh, and never regress a newer cached quote with an
   * out-of-order late arrival.
   */
  private cacheExecutablePrice(symbol: string, price: number, eventTs: number, verdict?: Verdict): void {
    if (!Number.isFinite(price) || price <= 0) return;
    if (!Number.isFinite(eventTs) || !this.isFreshEventTime(eventTs)) return;
    // Plausibility at the single cache-WRITE choke point (WS ticks and REST
    // fallbacks both land here), so every cache READER — order sizing via
    // getCachedPrice, SL tier-1 via getLatestPrice — is covered at once.
    // REST callers that already computed a verdict pass it to avoid a
    // double tally. ponytail: in enforce mode a bad price cached at startup
    // (no ref yet to judge it against) can reject good ticks until the ref
    // ages out of the 5-min window — self-healing, bounded blindness.
    const v = verdict ?? this.priceVerdict(symbol, price);
    if (!v.ok && plausibilityMode() === "enforce") return;
    const existing = this.latestPrices.get(symbol);
    if (existing && eventTs < existing.timestamp) return;
    this.latestPrices.set(symbol, { price, timestamp: eventTs });
  }

  private getFreshCachedPrice(symbol: string): number {
    const cached = this.latestPrices.get(symbol);
    if (!cached || Date.now() - cached.timestamp > EXECUTABLE_QUOTE_TTL_MS) return 0;
    return cached.price;
  }

  async getLatestPrice(symbol: string, cls: RequestClass = "trade"): Promise<number> {
    const cached = this.getFreshCachedPrice(symbol);
    if (cached > 0) return cached;

    // Fallback: REST snapshot
    if (!this.connected) return 0;

    const assetClass = getAssetClass(symbol);
    try {
      if (assetClass === "crypto") {
        const url = `${this.dataUrl}/v1beta3/crypto/us/latest/bars?symbols=${encodeURIComponent(symbol)}`;
        const resp = await this.limitedFetch(cls, () => fetchT(url, {
          headers: this.authHeaders,
        }));
        if (resp.ok) {
          const data = await resp.json() as any;
          const bar = data.bars?.[symbol];
          // The "latest bar" endpoint has its own event timestamp ("t") —
          // validate freshness the same as the WS cache; never trust an
          // unbounded-age bar as an executable quote.
          const ts = bar?.t ? new Date(bar.t).getTime() : NaN;
          if (bar?.c && Number.isFinite(ts) && this.isFreshEventTime(ts)) {
            const price = Number(bar.c);
            const v = this.priceVerdict(symbol, price);
            this.cacheExecutablePrice(symbol, price, ts, v);
            if (!v.ok && plausibilityMode() === "enforce") return 0;
            return price;
          }
        }
      } else {
        const snap = await this.limited(cls, () => withTimeout<any>(this.client.getSnapshot(symbol), 10_000, 'alpaca getSnapshot'));
        // LatestTrade only — DailyBar.ClosePrice is a prior-session aggregate
        // (can be yesterday's close for hours) and must never stand in for a
        // live executable quote. Validate LatestTrade's own Timestamp too: a
        // quiet/halted symbol can return a trade from long before "now".
        const trade = snap?.LatestTrade;
        const ts = trade?.Timestamp ? new Date(trade.Timestamp).getTime() : NaN;
        if (trade?.Price > 0 && Number.isFinite(ts) && this.isFreshEventTime(ts)) {
          const price = Number(trade.Price);
          const v = this.priceVerdict(symbol, price);
          this.cacheExecutablePrice(symbol, price, ts, v);
          if (!v.ok && plausibilityMode() === "enforce") return 0;
          return price;
        }
      }
    } catch {}
    return 0;
  }

  /**
   * Price for RISK MONITORING (stop-loss evaluation) — NEVER for placing
   * orders. Tiering:
   *  1. the executable price if one exists (getLatestPrice, <30s standard);
   *  2. else the LAST TRADE, within RISK_PRICE_TTL_MS (anti-clock-skew
   *     bounded). A trade is a transaction that actually happened.
   * Still fail-closed: returns 0 when nothing is inside the risk window.
   * Never DailyBar.ClosePrice (prior-session aggregate — see getLatestPrice).
   *
   * DO NOT reintroduce the quote midpoint here. IEX publishes wide, non-NBBO
   * quotes on symbols it barely trades: measured live 2026-07-27 on UNH,
   * bid 392.64 / ask 420.00 (spread $27.36, 6.5%) at 3s of age while the
   * last trade printed 418.35 — the "freshest candidate wins" rule picked
   * the midpoint 406.32 and put a healthy position (real −0.83%) at a
   * fabricated −3.68%, one wide quote away from the −4% stop. A fictional
   * quote must never trigger a real loss.
   *
   * The trade window alone SUFFICES, measured: 12 samples over 60s with the
   * market open, UNH's last-trade age maxed at 134s — comfortably inside the
   * 5-min risk window — while the 30s executable threshold rejected it 12/12.
   * The risk window over the TRADE solves the sparse-IEX-tape case that
   * motivated this tier, without ever touching the quote.
   *
   * The risk-tier value is deliberately NOT written to the executable price
   * cache (latestPrices): it does not meet the execution standard and must
   * not leak into the order path.
   */
  async getRiskPrice(symbol: string): Promise<number> {
    // Class "protect": this IS the stop-loss loop's price read — the exact
    // request the shadow-sleeve stampede starved in the documented incident.
    const executable = await this.getLatestPrice(symbol, "protect");
    if (executable > 0) return executable;
    // ponytail: stocks only — the SL loop routes only Alpaca stock positions
    // here (Binance sleeves use Binance marks); crypto keeps getLatestPrice's
    // own bar fallback above, so 0 here is behavior-identical to before.
    if (!this.connected || getAssetClass(symbol) === "crypto") return 0;
    return this.lastTradeInRiskWindow(symbol, "protect");
  }

  /**
   * Price for SIZING a whole-share MARKET order — the share count only; never
   * a limit price, never a fill benchmark, never cached as executable.
   * Tiering: the executable price (getLatestPrice, <30s) first, else the last
   * TRADE inside RISK_PRICE_TTL_MS — getRiskPrice's trade tier, same
   * plausibility check, never the quote midpoint. On the IEX feed a liquid
   * name can go minutes without printing: the <30s standard alone returned 0
   * and meanrev skipped entries the replay takes (ABBV 2026-09-28, CAT 09-16,
   * MA 08-11; V and MRK needed retries). A ≤5-min-old trade moves the share
   * count by at most that drift; the order itself fills at market.
   */
  async getSizingPrice(symbol: string): Promise<number> {
    const executable = await this.getLatestPrice(symbol, "trade");
    if (executable > 0) return executable;
    if (!this.connected || getAssetClass(symbol) === "crypto") return 0;
    return this.lastTradeInRiskWindow(symbol, "trade");
  }

  /** The snapshot's LatestTrade when it printed within RISK_PRICE_TTL_MS
   *  (anti-clock-skew bounded) and passes plausibility; 0 otherwise. Not
   *  written to the executable cache (see getRiskPrice's docstring). */
  private async lastTradeInRiskWindow(symbol: string, cls: RequestClass): Promise<number> {
    try {
      const snap = await this.limited(cls, () => withTimeout<any>(this.client.getSnapshot(symbol), 10_000, `alpaca getSnapshot ${cls === "protect" ? "risk" : "sizing"}`));
      const now = Date.now();
      const trade = snap?.LatestTrade;
      const tradeTs = trade?.Timestamp ? new Date(trade.Timestamp).getTime() : NaN;
      if (
        trade?.Price > 0 &&
        Number.isFinite(tradeTs) &&
        tradeTs <= now + 5_000 &&
        now - tradeTs <= RISK_PRICE_TTL_MS
      ) {
        // Plausibility (order-of-magnitude vs cached ref). Enforce mode
        // returns 0 — the same fail-closed contract every caller handles.
        const price = Number(trade.Price);
        const v = this.priceVerdict(symbol, price);
        if (!v.ok && plausibilityMode() === "enforce") return 0;
        return price;
      }
    } catch {}
    return 0;
  }

  /**
   * Fresh executable touch: ask for buys, bid for sells. Uses the broker's own
   * quote timestamp and rejects stale/non-executable data. Telemetry failure
   * returns null; callers must never use a stale price as a fill benchmark.
   */
  async getExecutableQuote(symbol: string, side: "buy" | "sell", cls: RequestClass = "trade"): Promise<{ price: number; timestamp: number; bid?: number; ask?: number } | null> {
    if (!this.connected) return null;
    const assetClass = getAssetClass(symbol);
    try {
      if (assetClass === "crypto") {
        const url = `${this.dataUrl}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(symbol)}`;
        const resp = await this.limitedFetch(cls, () => fetchT(url, {
          headers: this.authHeaders,
        }));
        if (resp.ok) {
          const data = await resp.json() as any;
          const q = data.quotes?.[symbol];
          const ts = q?.t ? new Date(q.t).getTime() : NaN;
          // Full-book plausibility (both touches, crossed, spread, age) —
          // the old side-touch-only check accepted e.g. a 0.01 bid as a
          // sell benchmark. No `last` on this endpoint: checkQuote falls
          // back to the spread-bounded mid internally; the returned price
          // stays the side touch, as before.
          const verdict = checkQuote({ bid: parseFloat(q?.bp), ask: parseFloat(q?.ap), ts }, DEFAULT_PLAUSIBILITY, Date.now(), this.getRefPrice(symbol));
          if (!verdict.ok) {
            this.noteImplausible(symbol, verdict.reason);
            if (plausibilityMode() === "enforce") return null;
          }
          const price = side === "buy" ? parseFloat(q?.ap) : parseFloat(q?.bp);
          if (price > 0 && Number.isFinite(ts) && this.isFreshEventTime(ts)) {
            const bid = parseFloat(q?.bp), ask = parseFloat(q?.ap);
            return { price, timestamp: ts, bid: bid > 0 ? bid : undefined, ask: ask > 0 ? ask : undefined };
          }
        }
      } else {
        const snap = await this.limited(cls, () => withTimeout<any>(this.client.getSnapshot(symbol), 10_000, 'alpaca getSnapshot quote'));
        const q = snap?.LatestQuote;
        const ts = q?.Timestamp ? new Date(q.Timestamp).getTime() : NaN;
        // Full-book plausibility with the snapshot's own last trade — this
        // is the check that catches the measured IEX garbage (39/43 universe
        // symbols; AAPL bid 0.01/ask 0; UNH 6.5%-spread near-incident).
        // Rejecting here only ever suppresses fill telemetry: both callers
        // (placeOrder, closePosition) proceed without a quote by contract.
        const lastTrade = snap?.LatestTrade;
        const last = lastTrade?.Price > 0 ? Number(lastTrade.Price) : undefined;
        const verdict = checkQuote({ bid: parseFloat(q?.BidPrice), ask: parseFloat(q?.AskPrice), last, ts }, DEFAULT_PLAUSIBILITY, Date.now(), this.getRefPrice(symbol));
        if (!verdict.ok) {
          this.noteImplausible(symbol, verdict.reason);
          if (plausibilityMode() === "enforce") return null;
        }
        const price = side === "buy" ? parseFloat(q?.AskPrice) : parseFloat(q?.BidPrice);
        if (price > 0 && Number.isFinite(ts) && this.isFreshEventTime(ts)) {
          const bid = parseFloat(q?.BidPrice), ask = parseFloat(q?.AskPrice);
          return { price, timestamp: ts, bid: bid > 0 ? bid : undefined, ask: ask > 0 ? ask : undefined };
        }
      }
    } catch {}
    return null;
  }

  getCachedPrice(symbol: string): number {
    return this.getFreshCachedPrice(symbol);
  }

  /** Display-only consumer (dashboard candle modal fallback) — served at any
   *  age on purpose; the bounded-staleness rule above is for the DECISION
   *  path (getBars), not for showing a human the last thing we saw. */
  getCachedCandles(symbol: string, timeframe = "5Min"): OHLCV[] {
    return this.candleCache.get(this.candleCacheKey(symbol, timeframe))?.bars || [];
  }

  /** Drop every cached timeframe for `symbol`. Policy: called when a
   *  corporate action is detected for the symbol (splits/dividends/spin-offs
   *  REWRITE adjusted history retroactively — see the adjustment=all comment
   *  in getStockBarsREST), so the next getBars refetches the re-adjusted
   *  series instead of mixing pre/post-event bars from the fallback cache.
   *  Invalidation is deliberately unconditional on event type/phase: a
   *  spurious drop only costs one refetch. */
  invalidateCandleCache(symbol: string): void {
    let dropped = 0;
    for (const key of [...this.candleCache.keys()]) {
      if (key.startsWith(`${symbol}:`)) {
        this.candleCache.delete(key);
        dropped++;
      }
    }
    if (dropped > 0) {
      log.info(`🏛 candle cache invalidated for ${symbol} (${dropped} timeframe entries) — corporate action rewrote adjusted history`);
    }
  }

  // ── Orders ────────────────────────────────

  async placeOrder(
    signal: Signal,
    quantity: number,
    accountId = "unknown",
    opts: { entryDayKey?: number } = {},
  ): Promise<Order | UnknownOrderResult | null> {
    if (!this.connected) return null;
    // Broker-side kill switch: gate ONLY this method — placeOrder is the
    // sole path for real-broker Alpaca ENTRIES (adapters route exits through
    // closePosition and protection through placeStopLossOrder, both
    // deliberately ungated so they keep retrying while suspended). Nothing
    // was transmitted: null = proven_failed, the caller's normal cadence.
    if (this.tradeSuspendedByBroker) {
      log.warn(`🛑 OPEN blocked for ${signal.symbol}: Alpaca account is trade-suspended (broker kill switch) — not submitting; closes/stops/reconciliation unaffected`);
      return null;
    }
    // Per-(venue,symbol) mutation lock (symbolLock.ts): an open must never
    // interleave with a concurrent close/stop mutation on the same symbol.
    // A lock timeout is a pre-transmit denial — null (proven_failed) is
    // truthful and the caller's normal retry cadence applies.
    return await symbolLocks.withLock("alpaca", signal.symbol, { label: `placeOrder:${accountId}` },
      () => this.placeOrderUnderLock(signal, quantity, accountId, opts),
      () => {
        log.error(`placeOrder ${signal.symbol}: symbol mutation lock not acquired — NOT submitting (another mutation is in flight)`);
        return null;
      });
  }

  private async placeOrderUnderLock(
    signal: Signal,
    quantity: number,
    accountId: string,
    opts: { entryDayKey?: number },
  ): Promise<Order | UnknownOrderResult | null> {
    const orderId = `alp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    // TASK 2 idempotency: a caller (e.g. AlpacaMomentumAdapter for the daily
    // meanrev entry) passes entryDayKey to get the SAME id for the SAME
    // (accountId, symbol, ET day) every time; anyone else gets a unique id
    // (TASK 1's attribution default).
    const clientOrderId = opts.entryDayKey !== undefined
      ? dailyEntryClientOrderId(accountId, signal.symbol, opts.entryDayKey)
      : uniqueClientOrderId(accountId);

    // Wash-trade defense (see isWashTrade403): with one of OUR GTC sell
    // stops still open on this symbol, Alpaca rejects a market BUY with 403
    // — always, paper included. A stop can outlive its row (closed
    // externally, BROKER_GONE_404 reconcile, decommissioned clone), so an
    // orphan silently vetoes every future entry. Clear our own stops first —
    // exact ids, uc8-owned only, the same primitive closePosition uses,
    // NEVER a blanket cancel (see cancelOwnStopOrders). Equities only (our
    // stops are equities-only) and BUY only (this bot's Alpaca entries are
    // long-only; the sell path already cancels via closePosition). If the
    // row this stop protected is somehow still live, the ensure pass
    // re-arms its protection within one 60s sync of the fill.
    if (signal.market === "stock" && signal.side === "buy") {
      await this.cancelOwnStopOrders(signal.symbol);
    }

    // Capture fresh executable touch before submitting. A missing quote only
    // disables this fill benchmark; it must never block the order.
    const quote = await this.getExecutableQuote(signal.symbol, signal.side);
    const submittedAt = Date.now();
    const submittedPx = quote?.price ?? 0;
    if (!quote) {
      log.warn(`No fresh executable quote for ${signal.symbol}; fill telemetry skipped`);
    }

    // Pre-trade impact estimate (bookDepth.ts). Alpaca/IEX has NO depth
    // ladder — the honest proxy is the L1 touch vs mid (always depthLimited,
    // a lower bound on true impact). Telemetry-first: rides to fills.est_px;
    // it only ever GATES when a sleeve's policy explicitly sets
    // maxEstImpactBps (default: absent = never abort).
    const est = quote?.bid && quote?.ask ? estimateFromQuote(quote.bid, quote.ask, signal.side) : null;
    const policy = resolveExecutionPolicy(accountId);
    if (policy?.entry?.maxEstImpactBps !== undefined && est && est.estImpactBps > policy.entry.maxEstImpactBps) {
      log.warn(`Entry ABORTED by estimated impact for ${signal.symbol}: ~${est.estImpactBps.toFixed(1)}bps > policy max ${policy.entry.maxEstImpactBps}bps`);
      return null;
    }

    const toOrder = (brokerOrder: any): Order => {
      const filledQty = parseFloat(brokerOrder.filled_qty ?? "0");
      const filledAvgPrice = parseFloat(brokerOrder.filled_avg_price ?? "0");
      const isFilled = brokerOrder.status === "filled";
      const isPartial = brokerOrder.status === "partially_filled";
      return {
        id: orderId,
        symbol: signal.symbol,
        market: signal.market,
        side: signal.side,
        type: "market",
        quantity,
        price: signal.price,
        status: isFilled ? "filled" : isPartial ? "partial" : "pending",
        externalId: brokerOrder.id,
        filledPrice: filledAvgPrice > 0 ? filledAvgPrice : undefined,
        filledQty: filledQty > 0 ? filledQty : undefined,
        filledAt: brokerOrder.filled_at ? new Date(brokerOrder.filled_at).getTime() : undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        signal,
        submittedAt,
        submittedPx,
        estPx: est?.estPx,
      };
    };

    // OPT-IN limit-chase entries (executionPolicy.ts). No policy for this
    // sleeve (the default) → the market path below runs UNCHANGED.
    if (policy?.entry?.style === "limit_chase" && signal.market === "stock") {
      return await this.placeChasedEntry(signal, quantity, accountId, clientOrderId, policy.entry, {
        orderId, submittedAt, submittedPx, estPx: est?.estPx,
      });
    }

    try {
      const orderParams: any = {
        symbol: signal.symbol,
        side: signal.side,
        type: "market",
        time_in_force: signal.market === "crypto" ? "gtc" : "day",
        client_order_id: clientOrderId,
      };

      // Alpaca crypto: $10 minimum order value
      if (signal.market === "crypto") {
        const notionalValue = quantity * signal.price;
        if (notionalValue < 10) {
          // Use notional order with $10 minimum
          orderParams.notional = Math.max(10, Math.ceil(notionalValue)).toFixed(2);
        } else {
          orderParams.qty = quantity;
        }
      } else {
        orderParams.qty = Math.max(1, Math.round(quantity)); // stocks: whole shares
      }

      const order = await this.limited("trade", () => withTimeout<any>(this.client.createOrder(orderParams), 10_000, 'alpaca createOrder'));

      log.trade(`📤 Order submitted: ${signal.side.toUpperCase()} ${quantity} ${signal.symbol} — Alpaca ID: ${order.id} (client_order_id ${clientOrderId})`);

      return toOrder(order);
    } catch (e: any) {
      if (e?.rateLimitDenied) {
        // Pre-transmit denial by OUR OWN limiter: nothing reached the
        // broker — a proven non-submission, never an "unknown" to chase.
        log.warn(`Order for ${signal.symbol} NOT submitted: ${e.message}`);
        return null;
      }
      // v6.1: surface HTTP status on open failures too — caller uses 403 as a
      // PDT signal to pause the profile until next session.
      const code = e?.response?.status || e?.status || null;
      const bodyMessage = String(e?.response?.data?.message ?? e?.message ?? "");

      if (code === 422 && DUPLICATE_CLIENT_ORDER_ID_RE.test(bodyMessage)) {
        // SUCCESS-ALREADY-DONE, not a failure: Alpaca itself rejected this
        // as a duplicate of a REAL order that already exists on the books
        // (that's the whole point of the deterministic id). Query the real
        // order by client_order_id instead of retrying or reporting an
        // error — the caller then proceeds exactly as it would have on the
        // original successful submission.
        log.warn(`Order for ${signal.symbol} already submitted (duplicate client_order_id ${clientOrderId}) — querying broker for the real order instead of retrying`);
        try {
          const existing = await this.limited("trade", () => withTimeout<any>(this.client.getOrderByClientId(clientOrderId), 10_000, 'alpaca getOrderByClientId'));
          return toOrder(existing);
        } catch (queryError: any) {
          log.error(`Duplicate client_order_id ${clientOrderId} for ${signal.symbol}, but the existing order could not be queried: ${queryError?.message ?? queryError} — needs manual reconcile`);
          return null;
        }
      }

      if (isWashTrade403(code, bodyMessage)) {
        // Unambiguous classification — NOT a PDT block, NOT a generic
        // permission 403: an opposite-side order (almost certainly an
        // orphaned uc8 stop the pre-buy sweep above couldn't enumerate) is
        // still open on this symbol. The next attempt retries the sweep.
        log.error(`Order REJECTED by Alpaca WASH-TRADE protection for ${signal.symbol}: an opposite-side order (likely an orphaned uc8 GTC stop) is still open — not PDT, not a permission 403 (${bodyMessage})`);
        return null;
      }

      // Outcome taxonomy (NautilusTrader-style): a venue-confirmed 4xx is a
      // PROVEN failure (null, as always). But a transport failure/timeout (no
      // HTTP status) or a 5xx AFTER transmitting leaves the order's fate
      // UNKNOWN — it may be live on the books. NEVER resend: resolve by
      // QUERY on the idempotent client_order_id; if that too is exhausted,
      // report "unknown" so callers leave it to reconciliation. A 429 is
      // included deliberately (OrderOutcome taxonomy): the request WAS
      // transmitted and a rate-limited rejection is not proof the venue
      // didn't process it — resolve by query, never resend.
      if (code === null || code >= 500 || code === 429) {
        log.warn(`Order submit for ${signal.symbol} ended ambiguous (${e.message}) — resolving by client_order_id ${clientOrderId}, never resending`);
        return await this.resolveInFlightOrder(signal.symbol, clientOrderId, toOrder, e.message);
      }
      const detail = `http_${code} ${e.message}`;
      log.error(`Order failed for ${signal.symbol}: ${detail}`);
      return null;
    }
  }

  /** Retry-in-ms between in-flight resolution queries (test-tunable). */
  private resolveRetryDelayMs = 1_000;

  /** Resolve an ambiguous submission by QUERYING the idempotent
   *  client_order_id (never by resending). 404 = proven the order never
   *  reached the books (null). Queries exhausted = UNKNOWN. */
  private async resolveInFlightOrder(
    symbol: string,
    clientOrderId: string,
    toOrder: (brokerOrder: any) => Order,
    cause: string,
  ): Promise<Order | UnknownOrderResult | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const existing = await this.limited("trade", () => withTimeout<any>(this.client.getOrderByClientId(clientOrderId), 10_000, "alpaca getOrderByClientId resolve"));
        if (existing?.id) {
          log.warn(`In-flight order for ${symbol} RESOLVED by client_order_id query (status=${existing.status}) — no resend needed`);
          return toOrder(existing);
        }
      } catch (qe: any) {
        const qcode = qe?.response?.status || qe?.status || null;
        if (qcode === 404) {
          log.warn(`In-flight order for ${symbol} proven ABSENT from the books (404 by client_order_id) — submit never landed`);
          return null; // proven_failed: safe for the caller to treat as rejection
        }
      }
      await new Promise(r => setTimeout(r, this.resolveRetryDelayMs));
    }
    log.error(`Order outcome UNKNOWN for ${symbol} (submit: ${cause}; resolution queries exhausted) — left in flight for reconciliation, NOT resent`);
    return { outcome: "unknown", reason: `submit ambiguous (${cause}); client_order_id resolution exhausted`, clientOrderId };
  }

  // ── OPT-IN limit-chase entry (executionPolicy.ts) ────────────────────
  //
  // Only reachable when resolveExecutionPolicy(accountId).entry is
  // configured — with no policy the market path above is byte-identical to
  // the pre-policy behavior (fixed by test). Alpaca note: extended-hours
  // sessions only accept LIMIT orders, so this path is also the only one
  // that could ever trade there; the default market path remains RTH-only.

  private stockChaseVenue(posSymbol: string, side: "buy" | "sell", accountId: string, firstClientOrderId: string, cls: RequestClass = "trade"): ChaseVenue {
    return {
      minQty: 1,
      refPrice: async () => (await this.getExecutableQuote(posSymbol, side, cls))?.price ?? 0,
      // Sub-penny rule (2 decimals), rounded PASSIVELY: a buy limit rounds
      // down, a sell limit rounds up — rounding can only make the order more
      // conservative, never cross further than intended.
      roundPrice: (px, s) => s === "buy" ? Math.floor(px * 100) / 100 : Math.ceil(px * 100) / 100,
      place: async (px, qty, attempt) => {
        // First placement keeps the caller's (possibly deterministic)
        // client_order_id; replacements get fresh unique ids, same sleeve
        // attribution.
        const cid = attempt === 0 ? firstClientOrderId : uniqueClientOrderId(accountId);
        try {
          const o = await this.limited(cls, () => withTimeout<any>(this.client.createOrder({
            symbol: posSymbol, qty: Math.max(1, Math.floor(qty)), side,
            type: "limit", limit_price: px, time_in_force: "day", client_order_id: cid,
          }), 10_000, "alpaca createOrder limit"));
          if (!o?.id) return { ok: false, outcome: "unknown", reason: "createOrder returned no order id" };
          return { ok: true, ref: String(o.id) };
        } catch (e: any) {
          if (e?.rateLimitDenied) return { ok: false, outcome: "proven_failed", reason: e.message };
          const code = e?.response?.status || e?.status || null;
          // 429 ≠ proven rejection: the order was transmitted (see taxonomy).
          if (code !== null && code < 500 && code !== 429) return { ok: false, outcome: "proven_failed", reason: `http_${code} ${e.message}` };
          return { ok: false, outcome: "unknown", reason: e?.message ?? "transport error" };
        }
      },
      fetch: async (ref) => {
        try {
          const o = await this.limited(cls, () => withTimeout<any>(this.client.getOrder(ref), 10_000, "alpaca getOrder chase"));
          const filledQty = parseFloat(o?.filled_qty ?? "0") || 0;
          const filledAvgPx = parseFloat(o?.filled_avg_price ?? "0") || 0;
          const status = String(o?.status ?? "");
          if (status === "filled") return { status: "filled", filledQty, filledAvgPx };
          if (TERMINAL_ORDER_STATUSES.has(status) || status === "replaced") return { status: "terminal", filledQty, filledAvgPx };
          return { status: "working", filledQty, filledAvgPx };
        } catch { return null; }
      },
      cancel: async (ref) => {
        await this.cancelOrderById(ref);
        await new Promise(r => setTimeout(r, 250)); // brief settle before final read
        try {
          const o = await this.limited(cls, () => withTimeout<any>(this.client.getOrder(ref), 10_000, "alpaca getOrder settle"));
          const status = String(o?.status ?? "");
          return {
            confirmed: TERMINAL_ORDER_STATUSES.has(status) || status === "replaced",
            filledQty: parseFloat(o?.filled_qty ?? "0") || 0,
            filledAvgPx: parseFloat(o?.filled_avg_price ?? "0") || 0,
          };
        } catch {
          return { confirmed: false, filledQty: 0, filledAvgPx: 0 };
        }
      },
    };
  }

  private async placeChasedEntry(
    signal: Signal,
    quantity: number,
    accountId: string,
    firstClientOrderId: string,
    cfg: EntryExecutionConfig,
    ctx: { orderId: string; submittedAt: number; submittedPx: number; estPx?: number },
  ): Promise<Order | UnknownOrderResult | null> {
    const qty = Math.max(1, Math.round(quantity));
    const venue = this.stockChaseVenue(signal.symbol, signal.side, accountId, firstClientOrderId);
    const chase = await chaseLimit(venue, {
      side: signal.side, qty,
      offsetBps: cfg.offsetBps, refreshThresholdBps: cfg.refreshThresholdBps,
      maxReprices: cfg.maxReprices, maxDistanceBps: cfg.maxDistanceBps,
      timeoutMs: cfg.timeoutMs, pollIntervalMs: cfg.pollIntervalMs,
    });
    if (chase.outcome === "unknown") {
      log.error(`Chased entry outcome UNKNOWN for ${signal.symbol} (${chase.reason}) — left to reconciliation, NOT resent`);
      return { outcome: "unknown", reason: chase.reason ?? "chase unresolved", clientOrderId: firstClientOrderId };
    }
    if (chase.outcome === "proven_failed" || chase.filledQty <= 0) {
      log.warn(`Chased entry for ${signal.symbol} did not fill: ${chase.reason}`);
      return null;
    }
    // Partial fills: the remainder was CANCELED by the chaser — report the
    // real filled qty so the caller records exactly what we own.
    log.trade(`📤 Chased LIMIT entry ${signal.side.toUpperCase()} ${chase.filledQty}/${qty} ${signal.symbol} @ ~$${chase.filledAvgPx.toFixed(4)} (${chase.repricesUsed} reprices)`);
    const now = Date.now();
    return {
      id: ctx.orderId,
      symbol: signal.symbol,
      market: signal.market,
      side: signal.side,
      type: "limit",
      quantity: chase.filledQty,
      price: signal.price,
      status: "filled",
      externalId: chase.orderRefs[chase.orderRefs.length - 1],
      filledPrice: chase.filledAvgPx,
      filledQty: chase.filledQty,
      filledAt: now,
      createdAt: ctx.submittedAt,
      updatedAt: now,
      signal,
      submittedAt: ctx.submittedAt,
      submittedPx: ctx.submittedPx,
      estPx: ctx.estPx,
    };
  }

  // ── Broker-native GTC stop-loss (defense in depth for stocks) ─────────
  //
  // Mirrors BinanceExecutor.placeStopMarketClose: the 15s checkAllStopLoss
  // loop stays the PRIMARY protection (it reacts faster in-session and covers
  // what the broker won't), but a `stop` order with time_in_force=gtc lives
  // on the broker's book across nights/weekends/restarts, capping an
  // overnight gap at the next open — the ~70% of calendar time the 15s loop
  // cannot close a stock position at all (OPEN.md P1).

  /**
   * Place a GTC stop (market-on-trigger) that closes `quantity` of an
   * existing position. Equities only: qty is floored to whole shares (Alpaca
   * rejects fractional stop orders) and the trigger obeys the sub-penny rule
   * (2 decimals), rounded PROTECTIVELY — toward entry — so rounding can only
   * make the stop marginally tighter, never allow more loss than intended.
   *
   * `quantity` MUST be the caller's own DB-row qty (bounded upstream to
   * min(row, broker)): the Alpaca wallet is SHARED across sleeves and the
   * broker aggregate may include shares that are not this row's — a stop
   * must never be able to close more than the row it protects.
   *
   * Idempotency: the deterministic per-(sleeve, trade) client_order_id means
   * a retried install is rejected broker-side as a duplicate; if the prior
   * order is still working, that IS the protection (success). If it went
   * terminal (e.g. a close canceled it and the close then failed), the id is
   * burned — re-place ONCE under a fresh salted id, still uc8-attributed.
   *
   * RACE GUARD (OPEN.md P1, 2026-08-11 ABBV orphan): every caller decides
   * "this row needs a stop" from a snapshot taken OUTSIDE this symbol lock.
   * A concurrent closePosition holds the lock, cancels our stops and sells;
   * when this method finally acquires the lock, the decision may be stale —
   * placing then leaves a resting sell stop with NO position behind it (a
   * naked short if it fires, and Alpaca's wash-trade protection 403s every
   * new buy of the symbol while it rests). So, UNDER the lock and before
   * submitting: (a) re-run the caller's `stillNeeded` check (DB row still
   * open); (b) re-read the broker position — a definitive flat (404/qty≤0)
   * aborts with `skipped: true`. An UNVERIFIABLE broker read proceeds
   * (unknown ≠ flat): the pass-level read that produced the decision
   * succeeded moments ago, and refusing to place on a flaky read would leave
   * a LIVE position without its GTC stop; the orphan-stop sweep in
   * AccountManager is the backstop for the rare wrong call.
   */
  async placeStopLossOrder(params: {
    symbol: string;
    positionSide: "buy" | "sell";
    quantity: number;
    stopPrice: number;
    accountId: string;
    tradeId: string;
    /** Re-evaluated UNDER the symbol lock immediately before submit; return
     *  false (or throw) to abort the placement (`ok:false, skipped:true`). */
    stillNeeded?: () => boolean | Promise<boolean>;
  }): Promise<{ ok: boolean; orderId?: string; clientOrderId?: string; reason?: string; skipped?: boolean }> {
    if (!this.connected) return { ok: false, reason: "disconnected" };
    // Serialized with any concurrent open/close on the same symbol: placing
    // a stop while a close is mid-flight is exactly the cancel-vs-place race
    // the symbol lock exists for. Timeout = explicit failure; the ensure
    // pass retries on its next 60s cycle.
    return await symbolLocks.withLock("alpaca", params.symbol, { label: `placeStopLoss:${params.accountId}` },
      () => this.placeStopLossOrderUnderLock(params),
      () => ({ ok: false, reason: "symbol lock timeout (another mutation in flight)" }));
  }

  private async placeStopLossOrderUnderLock(params: {
    symbol: string;
    positionSide: "buy" | "sell";
    quantity: number;
    stopPrice: number;
    accountId: string;
    tradeId: string;
    stillNeeded?: () => boolean | Promise<boolean>;
  }): Promise<{ ok: boolean; orderId?: string; clientOrderId?: string; reason?: string; skipped?: boolean }> {
    const qty = Math.floor(params.quantity);
    if (!(Number.isFinite(qty) && qty >= 1)) return { ok: false, reason: `non-positive stop qty (${params.quantity})` };
    if (!(Number.isFinite(params.stopPrice) && params.stopPrice > 0)) return { ok: false, reason: `invalid stop price (${params.stopPrice})` };

    // Check-then-act race guard (see the public method's doc): the DECISION
    // was taken outside the symbol lock — re-validate it here, under the
    // lock, before anything is transmitted.
    // (a) Caller-side re-check (DB row still open). A throw counts as "not
    //     needed": if we cannot confirm the row exists, placing risks the
    //     orphan class this guard exists for; the next pass retries.
    if (params.stillNeeded) {
      let needed = false;
      let checkErr: string | null = null;
      try {
        needed = await params.stillNeeded();
      } catch (e: any) {
        checkErr = String(e?.message ?? e);
      }
      if (!needed) {
        return { ok: false, skipped: true, reason: checkErr ? `stillNeeded re-check failed under the symbol lock (${checkErr})` : "row no longer needs a stop (closed while waiting for the symbol lock)" };
      }
    }
    // (b) Broker position re-check. Definitive flat → abort; unverifiable
    //     read → proceed (unknown ≠ flat — never leave a live position naked
    //     over a flaky read; the orphan sweep is the backstop).
    try {
      const pos = await this.limited("protect", () => withTimeout<any>(this.client.getPosition(params.symbol.replace("/", "")), 10_000, "alpaca getPosition preStop"));
      const brokerQty = Math.abs(parseFloat(pos?.qty));
      if (Number.isFinite(brokerQty) && brokerQty <= 0) {
        return { ok: false, skipped: true, reason: "broker position is flat — a resting stop would be an orphan (naked short if fired)" };
      }
    } catch (e: any) {
      const code = e?.response?.status || e?.status || null;
      if (code === 404) {
        return { ok: false, skipped: true, reason: "broker position gone (404) — a resting stop would be an orphan (naked short if fired)" };
      }
      log.warn(`pre-stop position re-check unavailable for ${params.symbol} (${e?.message ?? e}) — proceeding to place (unknown ≠ flat)`);
    }

    const side = params.positionSide === "buy" ? "sell" : "buy"; // stop CLOSES the position
    const stopPrice = side === "sell"
      ? Math.ceil(params.stopPrice * 100) / 100   // long protection: round UP (tighter)
      : Math.floor(params.stopPrice * 100) / 100; // short protection: round DOWN (tighter)

    const submit = (clientOrderId: string) => this.limited("protect", () => withTimeout<any>(this.client.createOrder({
      symbol: params.symbol,
      qty,
      side,
      type: "stop",
      stop_price: stopPrice,
      time_in_force: "gtc", // DAY would die at the close — the whole point is surviving the overnight gap
      client_order_id: clientOrderId,
    }), 10_000, "alpaca createOrder stop"));

    const clientOrderId = stopLossClientOrderId(params.accountId, params.tradeId);
    try {
      const order = await submit(clientOrderId);
      log.info(`🛡 GTC stop set ${params.symbol}: ${side} ${qty} @ trigger $${stopPrice.toFixed(2)} (client_order_id ${clientOrderId})`);
      return { ok: true, orderId: order?.id, clientOrderId };
    } catch (e: any) {
      const code = e?.response?.status || e?.status || null;
      const bodyMessage = String(e?.response?.data?.message ?? e?.message ?? "");
      if (code === 422 && DUPLICATE_CLIENT_ORDER_ID_RE.test(bodyMessage)) {
        try {
          const existing = await this.limited("protect", () => withTimeout<any>(this.client.getOrderByClientId(clientOrderId), 10_000, "alpaca getOrderByClientId stop"));
          if (existing && !TERMINAL_ORDER_STATUSES.has(String(existing.status))) {
            // Still working — the retry found the real protection already live.
            return { ok: true, orderId: existing.id, clientOrderId };
          }
        } catch (queryError: any) {
          return { ok: false, reason: `duplicate stop client_order_id ${clientOrderId}, and the existing order could not be queried: ${queryError?.message ?? queryError}` };
        }
        // Burned id (prior stop is terminal): one salted re-place, same attribution.
        const salted = assembleClientOrderId(params.accountId, `sl${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`);
        try {
          const order = await submit(salted);
          log.info(`🛡 GTC stop set ${params.symbol}: ${side} ${qty} @ trigger $${stopPrice.toFixed(2)} (salted client_order_id ${salted}; deterministic id was terminal)`);
          return { ok: true, orderId: order?.id, clientOrderId: salted };
        } catch (retryError: any) {
          return { ok: false, reason: `salted stop re-place failed: ${retryError?.message ?? retryError}` };
        }
      }
      const detail = code ? `http_${code} ${e.message}` : e.message;
      log.warn(`GTC stop failed for ${params.symbol}: ${detail}`);
      return { ok: false, reason: detail };
    }
  }

  /** THIS bot's open protective stop orders (client_order_id `uc8-…`, type
   *  `stop*`), optionally scoped to one symbol. THROWS on a failed/malformed
   *  read — unknown must never be coerced to "no stops" (a caller could then
   *  double-place or, worse, treat an unprotected position as protected). */
  async getOpenStopOrders(symbol?: string): Promise<AlpacaStopOrder[]> {
    if (!this.connected) throw new Error("Alpaca is not connected");
    const raw = await this.limited("protect", () => withTimeout<any>(this.client.getOrders({ status: "open", limit: 500, nested: false }), 10_000, "alpaca getOrders open"));
    if (!Array.isArray(raw)) throw new Error("alpaca getOrders malformed response: expected an array");
    const out: AlpacaStopOrder[] = [];
    for (const o of raw) {
      const type = String(o?.type ?? o?.order_type ?? "").toLowerCase();
      if (!type.startsWith("stop")) continue;
      const clientOrderId = String(o?.client_order_id ?? "");
      if (!clientOrderId.startsWith(`${CLIENT_ORDER_ID_PREFIX}-`)) continue; // ours only — a foreign/manual stop is never ours to touch
      if (symbol && o?.symbol !== symbol) continue;
      out.push({
        id: String(o?.id ?? ""),
        clientOrderId,
        symbol: String(o?.symbol ?? ""),
        side: String(o?.side ?? "").toLowerCase() === "sell" ? "sell" : "buy",
        qty: parseFloat(o?.qty ?? "0") || 0,
        stopPrice: parseFloat(o?.stop_price ?? "0") || 0,
        status: String(o?.status ?? ""),
      });
    }
    return out;
  }

  /** Targeted cancel by EXACT order id — NEVER a blanket order sweep (a blind
   *  qty-less DELETE canceled protective stops the bot didn't own in a
   *  documented incident; see AUDITS.md). Already-gone/terminal (404/422)
   *  counts as success: the order can no longer fire. */
  async cancelOrderById(orderId: string): Promise<boolean> {
    if (!this.connected || !orderId) return false;
    try {
      await this.limited("protect", () => withTimeout<any>(this.client.cancelOrder(orderId), 10_000, "alpaca cancelOrder"));
      return true;
    } catch (e: any) {
      const code = e?.response?.status || e?.status || null;
      if (code === 404 || code === 422) return true; // gone or already terminal — nothing left to fire
      log.warn(`cancel order ${orderId} failed: ${e?.message ?? e}`);
      return false;
    }
  }

  /** Normalized broker state of an order looked up by client_order_id —
   *  used to attribute a fired native stop back to its DB row, and (via
   *  `replacedBy`) to detect a corporate-action adjustment: OrderStatus
   *  `replaced` = "replaced by another order, or was updated due to a market
   *  event such as corporate action" (docs), with replaced_by pointing at
   *  the successor. null on any failure (callers treat unknown as "no
   *  attribution", never as filled). */
  async getOrderStateByClientId(clientOrderId: string): Promise<{ status: string; filledQty: number; filledAvgPrice: number; filledAt?: number; replacedBy: string | null } | null> {
    if (!this.connected) return null;
    try {
      const o = await this.limited("trade", () => withTimeout<any>(this.client.getOrderByClientId(clientOrderId), 10_000, "alpaca getOrderByClientId"));
      if (!o) return null;
      return {
        status: String(o.status ?? "unknown"),
        filledQty: parseFloat(o.filled_qty ?? "0") || 0,
        filledAvgPrice: parseFloat(o.filled_avg_price ?? "0") || 0,
        filledAt: o.filled_at ? new Date(o.filled_at).getTime() : undefined,
        replacedBy: o.replaced_by ? String(o.replaced_by) : null,
      };
    } catch {
      return null;
    }
  }

  /** Normalized order lookup by BROKER order id — the shape needed to walk a
   *  `replaced_by` chain (forward split: the successor stop carries a
   *  broker-generated client_order_id, so the by-client-id lookup above and
   *  the uc8 enumeration both can't see it). null on any failure — callers
   *  treat unknown as "not adoptable", never as protection. */
  async getOrderById(orderId: string): Promise<{ id: string; clientOrderId: string; symbol: string; status: string; type: string; side: "buy" | "sell"; qty: number; stopPrice: number; replacedBy: string | null; filledQty: number; filledAvgPrice: number; filledAt?: number } | null> {
    if (!this.connected || !orderId) return null;
    try {
      const o = await this.limited("trade", () => withTimeout<any>(this.client.getOrder(orderId), 10_000, "alpaca getOrder byId"));
      if (!o) return null;
      return {
        id: String(o.id ?? orderId),
        clientOrderId: String(o.client_order_id ?? ""),
        symbol: String(o.symbol ?? ""),
        status: String(o.status ?? "unknown"),
        type: String(o.type ?? o.order_type ?? "").toLowerCase(),
        side: String(o.side ?? "").toLowerCase() === "sell" ? "sell" : "buy",
        qty: parseFloat(o.qty ?? "0") || 0,
        stopPrice: parseFloat(o.stop_price ?? "0") || 0,
        replacedBy: o.replaced_by ? String(o.replaced_by) : null,
        filledQty: parseFloat(o.filled_qty ?? "0") || 0,
        filledAvgPrice: parseFloat(o.filled_avg_price ?? "0") || 0,
        filledAt: o.filled_at ? new Date(o.filled_at).getTime() : undefined,
      };
    } catch {
      return null;
    }
  }

  /** Cancel OUR open stop orders on `posSymbol` before a close: the working
   *  stop holds the shares (Alpaca rejects a close whose qty is held for
   *  orders), and a leftover GTC stop firing after the close would produce an
   *  untracked sell. Enumerate-then-cancel by exact id, uc8-owned only. A
   *  failed enumeration cancels NOTHING and the close proceeds — the ensure
   *  pass re-reconciles stops on the next 60s cycle. */
  private async cancelOwnStopOrders(posSymbol: string): Promise<void> {
    let stops: AlpacaStopOrder[];
    try {
      stops = await this.getOpenStopOrders(posSymbol);
    } catch (e: any) {
      log.warn(`stop-order enumeration failed for ${posSymbol} (${e?.message ?? e}) — close proceeds, stop cleanup deferred to the reconcile pass`);
      return;
    }
    for (const s of stops) {
      if (await this.cancelOrderById(s.id)) {
        log.info(`🛡 canceled own stop ${s.id} (${s.clientOrderId}) on ${posSymbol} before close`);
        await this.awaitStopCancelSettled(s.id, posSymbol);
      }
    }
  }

  /** Settle window for a just-canceled stop, its poll cadence, and the
   *  held-qty 403 retry budget. Instance fields, not consts, so tests can
   *  shrink them without monkeypatching timers.
   *  30 s because at the open a GTC stop's cancel stays `pending_cancel` far
   *  longer than mid-session: MRK 2026-09-30 and XLE + GOOGL 2026-10-02, all
   *  at 09:35 ET, were still pending at the old 5 s window, every close
   *  bounced 403 twice, and the cancels completed 7–23 s after the request.
   *  GOOGL's exit was lost for the day (momentum_stocks decides once per
   *  session). The poll returns as soon as the order is terminal, so a fast
   *  cancel costs nothing extra; past the first 5 s it polls every 2 s to
   *  stay well inside Alpaca's 200 req/min. */
  private stopCancelSettleTimeoutMs = 30_000;
  private stopCancelSettlePollMs = 500;
  private stopCancelSettleFastPhaseMs = 5_000;
  private stopCancelSettleSlowPollMs = 2_000;
  private heldQtyRetryDelayMs = 2_000;
  private heldQtyMaxRetries = 3;
  /** Clock and sleep of the settle loop, injectable for timing tests. */
  private settleNow = (): number => Date.now();
  private settleSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  /** A cancel ACCEPTED by Alpaca is not a cancel COMPLETED: the stop sits
   *  `pending_cancel` for a moment and its shares stay held_for_orders, so a
   *  close submitted immediately bounces with 403 "insufficient qty
   *  available" (MA 2026-09-25 13:36:10 — the 403 left the position ~60s
   *  without a native stop until the ensure pass re-placed it; CAT
   *  2026-09-14 — 403 + 4×422 re-placing the stop). Poll the order by exact
   *  id until a terminal status or the settle window. If the stop FILLED while the cancel
   *  was pending, the position was closed BY THE STOP: return and let the
   *  caller's close path re-read the broker — flat resolves to http_404 and
   *  the existing reconcile (BROKER_STOP_LOSS attribution) takes over; no
   *  fill is ever invented here. An unreadable order fails open (the close
   *  proceeds; the held-qty 403 retry covers the residual race). */
  private async awaitStopCancelSettled(orderId: string, posSymbol: string): Promise<void> {
    const start = this.settleNow();
    const deadline = start + this.stopCancelSettleTimeoutMs;
    for (;;) {
      const o = await this.getOrderById(orderId);
      if (!o) return; // unknown — never block the close on a flaky read
      const status = String(o.status).toLowerCase();
      if (status === "filled") {
        log.warn(`stop ${orderId} on ${posSymbol} FILLED while its cancel was pending — position closed by the stop; the close path re-reads the broker and reconciles (404/flat)`);
        return;
      }
      // `replaced` counts as settled here: the order itself can no longer
      // hold shares (its successor is a different order — see the
      // TERMINAL_ORDER_STATUSES docstring for why it's not in the set).
      if (TERMINAL_ORDER_STATUSES.has(status) || status === "replaced") return;
      const now = this.settleNow();
      if (now >= deadline) {
        log.warn(`stop ${orderId} on ${posSymbol} still '${status}' ${this.stopCancelSettleTimeoutMs}ms after cancel — close may bounce 403 (shares held_for_orders); the held-qty retries cover it`);
        return;
      }
      await this.settleSleep(now - start < this.stopCancelSettleFastPhaseMs ? this.stopCancelSettlePollMs : this.stopCancelSettleSlowPollMs);
    }
  }

  // ── Order polling ─────────────────────────

  /** A cancelled/expired/rejected order can still have filled_qty>0 with
   *  filled_avg_price coming back null (real broker-side glitch, not just a
   *  theoretical one — AUDITS.md's "Closed broker money-path ambiguity").
   *  Never let that filled quantity vanish silently: try the order's own
   *  fill activities first (real execution price), then fall back to the
   *  last known executable market price for the symbol/side, flagging the
   *  result as estimated. Returns null only if neither source produces a
   *  usable price — the caller still reports the real filledQty either way. */
  private async resolvePartialFillPrice(order: any, externalId: string, cls: RequestClass): Promise<{ price: number; estimated: boolean } | null> {
    try {
      if (typeof this.client.getAccountActivities === "function") {
        const activities = await this.limited(cls, () => withTimeout<any>(
          this.client.getAccountActivities({ activityTypes: "FILL" }), 10_000, "alpaca getAccountActivities",
        ));
        if (Array.isArray(activities)) {
          let qtySum = 0;
          let notionalSum = 0;
          for (const a of activities) {
            if (a?.order_id !== externalId) continue;
            const qty = parseFloat(a.qty ?? "0");
            const price = parseFloat(a.price ?? "0");
            if (qty > 0 && price > 0) { qtySum += qty; notionalSum += qty * price; }
          }
          if (qtySum > 0) return { price: notionalSum / qtySum, estimated: false };
        }
      }
    } catch (e: any) {
      log.warn(`Fill-activity lookup for order ${externalId} failed: ${e.message}`);
    }

    try {
      const symbol = order?.symbol;
      if (symbol) {
        const side = order.side === "sell" ? "sell" : "buy";
        const quote = await this.getExecutableQuote(symbol, side, cls);
        if (quote && quote.price > 0) return { price: quote.price, estimated: true };
      }
    } catch (e: any) {
      log.warn(`Last-price fallback for order ${externalId} failed: ${e.message}`);
    }

    return null;
  }

  async pollOrderUntilFilled(externalId: string, timeoutMs = 30000, pollIntervalMs = 2000, settleMs = 1000, cls: RequestClass = "trade"): Promise<{ status: string; filledPrice?: number; filledQty?: number; filledAt?: number; priceEstimated?: boolean }> {
    if (!this.connected) return { status: "error" };

    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const order = await this.limited(cls, () => withTimeout<any>(this.client.getOrder(externalId), 10_000, 'alpaca getOrder'));
        const filledQty = parseFloat(order.filled_qty ?? "0");
        const filledAvgPrice = parseFloat(order.filled_avg_price ?? "0");
        const filledAt = order.filled_at ? new Date(order.filled_at).getTime() : undefined;

        if (order.status === "filled") {
          return {
            status: "filled",
            filledPrice: filledAvgPrice,
            filledQty,
            filledAt,
          };
        }

        if (["canceled", "expired", "rejected"].includes(order.status)) {
          // Something may have filled before the order became terminal.
          if (filledQty > 0 && filledAvgPrice > 0) {
            return { status: "filled", filledPrice: filledAvgPrice, filledQty, filledAt };
          }
          if (filledQty > 0) {
            // filled_avg_price came back null/0 on a genuinely partial fill
            // — do not report this as a plain cancellation and drop it.
            const resolved = await this.resolvePartialFillPrice(order, externalId, cls);
            if (resolved) {
              log.warn(`Order ${externalId} ${order.status} with filled_qty=${filledQty} but filled_avg_price missing — using ${resolved.estimated ? "an estimated" : "fill-activity"} price ${resolved.price}`);
              return { status: "filled", filledPrice: resolved.price, filledQty, filledAt, priceEstimated: resolved.estimated };
            }
            log.warn(`Order ${externalId} ${order.status} with filled_qty=${filledQty} but no price could be resolved — reporting the fill with an unknown price`);
            return { status: "filled", filledQty, filledAt, priceEstimated: true };
          }
          return { status: order.status };
        }

        // partially_filled or new: keep polling so the remainder can fill.
      } catch (e: any) {
        log.warn(`Poll order error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    // Timeout — cancel remainder and fetch the real filled amount.
    return this.cancelAndFetchFinal(externalId, settleMs, cls);
  }

  /** Cancel an order and return whatever actually filled (if anything). */
  private async cancelAndFetchFinal(externalId: string, settleMs = 1000, cls: RequestClass = "trade"): Promise<{ status: string; filledPrice?: number; filledQty?: number; filledAt?: number; priceEstimated?: boolean }> {
    try {
      await this.limited(cls, () => withTimeout<any>(this.client.cancelOrder(externalId), 10_000, 'alpaca cancelOrder'));
      log.warn(`Order ${externalId} timed out — remainder cancelled`);
    } catch (e: any) {
      log.warn(`Cancel order ${externalId} failed: ${e.message}`);
      // The order may already be terminal; continue to fetch final state.
    }

    // Brief settle, then read the broker's final accounting.
    if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));

    try {
      const order = await this.limited(cls, () => withTimeout<any>(this.client.getOrder(externalId), 10_000, 'alpaca getOrder'));
      const filledQty = parseFloat(order.filled_qty ?? "0");
      const filledAvgPrice = parseFloat(order.filled_avg_price ?? "0");
      const filledAt = order.filled_at ? new Date(order.filled_at).getTime() : undefined;
      if (filledQty > 0 && filledAvgPrice > 0) {
        return { status: "filled", filledPrice: filledAvgPrice, filledQty, filledAt };
      }
      if (filledQty > 0) {
        // Same broker-side glitch as pollOrderUntilFilled's cancel path —
        // filled_avg_price null must not discard a real filled quantity.
        const resolved = await this.resolvePartialFillPrice(order, externalId, cls);
        if (resolved) {
          log.warn(`Order ${externalId} timed-out cancel with filled_qty=${filledQty} but filled_avg_price missing — using ${resolved.estimated ? "an estimated" : "fill-activity"} price ${resolved.price}`);
          return { status: "filled", filledPrice: resolved.price, filledQty, filledAt, priceEstimated: resolved.estimated };
        }
        log.warn(`Order ${externalId} timed-out cancel with filled_qty=${filledQty} but no price could be resolved — reporting the fill with an unknown price`);
        return { status: "filled", filledQty, filledAt, priceEstimated: true };
      }
      // Outcome taxonomy: "timeout_cancelled" is a PROVEN no-fill only when
      // the broker confirms the order can never fire again. A still-working
      // order after a failed cancel is UNKNOWN — reporting it as cancelled
      // historically let callers treat a live order as dead.
      if (TERMINAL_ORDER_STATUSES.has(String(order.status))) {
        return { status: "timeout_cancelled" };
      }
      return { status: "timeout_unresolved" };
    } catch (e: any) {
      log.warn(`Final fetch for ${externalId} failed: ${e.message}`);
      return { status: "timeout_unresolved" };
    }
  }

  // ── Positions (for reconciliation) ────────

  async getPositions(): Promise<Position[]> {
    if (!this.connected) throw new Error("Alpaca is not connected");
    try {
      const positions = await this.limited("trade", () => withTimeout<any>(this.client.getPositions(), 10_000, 'alpaca getPositions'));
      const result: Position[] = [];
      for (const p of positions) {
        // Normalize crypto symbols: DOGEUSD → DOGE/USD
        let sym = p.symbol;
        if (p.asset_class === "crypto" && !sym.includes("/") && sym.endsWith("USD")) {
          // slice, not replace("USD","/USD"): replace hits the FIRST "USD",
          // so the real pairs USDCUSD/USDTUSD/USDGUSD became "/USDCUSD"
          // garbage (OPEN.md P2, closed 2026-07-31). Suffix-slice is exact:
          // DOGEUSD → DOGE/USD, USDCUSD → USDC/USD.
          sym = sym.slice(0, -3) + "/USD";
        }
        const qty = parseFloat(p.qty);
        const avgEntryPrice = parseFloat(p.avg_entry_price);
        // qty and avg_entry_price determine broker position identity and basis, so
        // malformed values must fail closed; the other fields are display-only
        // market data and may legitimately be empty for quiet or halted symbols.
        const derivedNumber = (field: string, raw: unknown, multiplier = 1): number => {
          const value = parseFloat(raw as string) * multiplier;
          if (Number.isFinite(value)) return value;
          log.warn(`Alpaca getPositions ${sym} non-finite ${field}; using 0`);
          return 0;
        };
        const currentPrice = derivedNumber("current_price", p.current_price);
        const unrealizedPnl = derivedNumber("unrealized_pl", p.unrealized_pl);
        const unrealizedPnlPct = derivedNumber("unrealized_plpc", p.unrealized_plpc, 100);
        const criticalFields: [string, number, unknown][] = [
          ["qty", qty, p.qty],
          ["avg_entry_price", avgEntryPrice, p.avg_entry_price],
        ];
        const malformed = criticalFields.find(([, value]) => !Number.isFinite(value));
        if (malformed) {
          throw new Error(`Alpaca getPositions malformed ${sym} ${malformed[0]}: ${malformed[2]}`);
        }
        // Preserve the old map() behavior for a broker row with qty === 0:
        // it is flat, but remains represented with quantity 0 in the result.
        result.push({
          symbol: sym,
          market: p.asset_class === "crypto" ? "crypto" as const : "stock" as const,
          side: qty > 0 ? "buy" as const : "sell" as const,
          quantity: Math.abs(qty),
          avgEntryPrice,
          currentPrice,
          unrealizedPnl,
          unrealizedPnlPct,
          openedAt: Date.now(),
        });
      }
      return result;
    } catch (e: any) {
      log.error(`getPositions failed: ${e.message}`);
      throw e;
    }
  }

  /**
   * v6.1 audit fix: `closePosition` now reports real success.
   *
   * Before: both the status-403 path and the poll-timeout path returned
   * `success: true, filledPrice: 0`. That caused AccountManager to mark
   * the trade as CLOSED in the DB with price = entry, pnl = 0, which
   * both lied to the UI and let BrokerSync later "re-discover" the
   * still-open position and reopen it as a duplicate "BROKER_SYNC" trade.
   *
   * Now: success is only true when the broker reports a filled close
   * and we have a non-zero fill price. The caller must NOT delete the
   * DB trade on success:false — the trailing stop / max-hold loop will
   * try again on the next tick.
   *
   * CO-TENANCY (2026-07-27): `DELETE /v2/positions/{symbol}` without qty
   * liquidates the AGGREGATE broker position — and this account is shared
   * with the prod deployment (see AGENTS.md "Project Location": AAPL broker
   * 152 = ours 76 + prod's 76). Callers that own a DB row MUST pass `qty`
   * (their row's quantity); the close is then bounded to
   * min(qty, |brokerQty|), mirroring BinanceMomentumAdapter.closePosition.
   * Omitting `qty` keeps the whole-position semantics — reserved for the
   * emergency scripts that explicitly mean "the whole broker book".
   */
  async closePosition(symbol: string, side?: "buy" | "sell", qty?: number, opts: { accountId?: string } = {}): Promise<{ success: boolean; filledPrice: number; reason?: string; orderId?: string; submittedAt?: number; submittedPx?: number; filledAt?: number; filledQty?: number; outcome?: OrderOutcome; estPx?: number }> {
    // Failure outcome taxonomy: a venue-confirmed 4xx / local validation is
    // PROVEN; anything ambiguous after a close order was (possibly)
    // transmitted is UNKNOWN — callers must not treat unknown as "nothing
    // happened" (the retry path is safe here ONLY because tryClose re-reads
    // the broker qty and a filled close resolves to http_404 → reconcile).
    const failureOutcome = (reason?: string): OrderOutcome => {
      if (!reason) return "unknown";
      // Pre-transmit denials by our own limiter/lock: PROVEN non-submission.
      if (reason.startsWith("rate_limited") || reason.startsWith("symbol lock")) return "proven_failed";
      // 429 AFTER transmit is NOT proof of rejection — unknown (taxonomy).
      if (/^http_429/.test(reason)) return "unknown";
      if (/^http_4\d\d/.test(reason)) return "proven_failed";
      if (reason === "disconnected" || reason.startsWith("non-positive close qty") || reason.startsWith("broker qty unparseable")) return "proven_failed";
      if (/poll status=(canceled|rejected|expired|timeout_cancelled)/.test(reason)) return "proven_failed";
      return "unknown";
    };
    const fail = (reason?: string) => ({ success: false, filledPrice: 0, reason, outcome: failureOutcome(reason) });
    if (!this.connected) return fail("disconnected");
    if (qty !== undefined && !(Number.isFinite(qty) && qty > 0)) return fail(`non-positive close qty (${qty})`);

    // Per-(venue,symbol) mutation lock: the 15s stop-loss loop and an engine
    // rebalance can both reach here for the SAME symbol; without the lock
    // both read the same broker qty and both sell — an accidental short.
    // Serialized, the second caller re-reads the broker AFTER the first
    // close and sees the truth (flat → http_404 → reconcile). A lock
    // timeout is an explicit pre-transmit failure; the loop retries in 15s.
    return await symbolLocks.withLock("alpaca", symbol, { label: `closePosition:${opts.accountId ?? "?"}` },
      () => this.closePositionUnderLock(symbol, side, qty, opts, fail),
      () => fail("symbol lock timeout (another mutation in flight)"));
  }

  private async closePositionUnderLock(
    symbol: string,
    side: "buy" | "sell" | undefined,
    qty: number | undefined,
    opts: { accountId?: string },
    fail: (reason?: string) => { success: boolean; filledPrice: number; reason?: string; outcome: OrderOutcome },
  ): Promise<{ success: boolean; filledPrice: number; reason?: string; orderId?: string; submittedAt?: number; submittedPx?: number; filledAt?: number; filledQty?: number; outcome?: OrderOutcome; estPx?: number }> {

    // Fresh executable touch before the close (bid for sells, ask for buys).
    // Failure is logged once and does not block the close.
    const closeSide = side ? (side === "buy" ? "sell" : "buy") : undefined;
    const quote = closeSide ? await this.getExecutableQuote(symbol, closeSide, "protect") : null;
    const submittedAt = Date.now();
    const submittedPx = quote?.price ?? 0;
    if (closeSide && !quote) {
      log.warn(`No fresh executable quote for ${symbol} close; fill telemetry skipped`);
    }
    // L1 estimate for est-vs-realized telemetry (Alpaca has no depth ladder
    // — documented lower bound, see bookDepth.ts).
    const estPx = closeSide && quote?.bid && quote?.ask
      ? estimateFromQuote(quote.bid, quote.ask, closeSide)?.estPx
      : undefined;

    // Clear OUR protective GTC stop(s) on this symbol first (targeted, by
    // exact id, uc8-owned only — see cancelOwnStopOrders; NEVER a blanket
    // cancel-all). Ordering: if the native stop already FIRED, the cancel
    // finds nothing and the close below returns http_404, which the caller
    // reconciles (BROKER_STOP_LOSS attribution in AccountManager).
    await this.cancelOwnStopOrders(symbol.replace("/", ""));

    // OPT-IN exit policy (executionPolicy.ts): a bounded limit phase whose
    // remainder ALWAYS degrades to the unchanged market path below —
    // guaranteed. Stocks only, and only when the calling sleeve configured
    // an exit policy; the default (no policy / no accountId) skips this
    // block entirely.
    const exitPolicy = opts.accountId ? resolveExecutionPolicy(opts.accountId)?.exit : undefined;
    let remainingQty = qty;
    let limitPhaseQty = 0;
    let limitPhaseNotional = 0;
    let limitPhaseOrderId: string | undefined;
    if (exitPolicy?.style === "limit_then_market" && closeSide && qty !== undefined && getAssetClass(symbol) !== "crypto") {
      const phase = await this.chaseLimitCloseStock(symbol, closeSide, qty, opts.accountId!, exitPolicy);
      limitPhaseQty = phase.filledQty;
      limitPhaseNotional = phase.filledQty * phase.filledAvgPx;
      limitPhaseOrderId = phase.orderId;
      if (limitPhaseQty >= qty) {
        log.trade(`Closed position (limit chase): ${symbol} @ $${phase.filledAvgPx.toFixed(4)}`);
        return { success: true, filledPrice: phase.filledAvgPx, orderId: phase.orderId, submittedAt, submittedPx, filledAt: Date.now(), filledQty: limitPhaseQty, outcome: "confirmed", estPx };
      }
      remainingQty = qty - limitPhaseQty; // remainder goes MARKET, always
    }

    let closeOrderId: string | undefined;
    let filledAt: number | undefined;
    let filledQty: number | undefined;

    const tryClose = async (posSymbol: string): Promise<{ status: string; filledPrice: number; reason?: string; filledAt?: number; filledQty?: number; heldQtyRetryable?: boolean }> => {
      try {
        let closeOrder: any;
        if (remainingQty !== undefined) {
          // Read the broker's aggregate first and bound the close to what we
          // own: min(our qty, broker qty). If the broker holds MORE than our
          // claim, the excess is not ours (manual/unknown) — leave it alone.
          // If it holds LESS OR EQUAL, everything there is (at most) ours —
          // plain whole-position close, using the broker's own qty exactly.
          const pos = await this.limited("protect", () => withTimeout<any>(this.client.getPosition(posSymbol), 10_000, 'alpaca getPosition'));
          const brokerQty = Math.abs(parseFloat(pos?.qty));
          if (!Number.isFinite(brokerQty)) return { status: "error", filledPrice: 0, reason: `broker qty unparseable (${pos?.qty})` };
          if (brokerQty <= 0) return { status: "error", filledPrice: 0, reason: "http_404" }; // flat = position gone
          if (remainingQty >= brokerQty) {
            closeOrder = await this.limited("protect", () => withTimeout<any>(this.client.closePosition(posSymbol), 10_000, 'alpaca closePosition'));
          } else {
            // Partial close: the SDK's closePosition() can't carry qty, so
            // hit the REST endpoint directly (same DELETE, plus ?qty=).
            // qty < brokerQty strictly, so we can never over-sell.
            const qtyStr = remainingQty.toFixed(9).replace(/\.?0+$/, "");
            const resp = await this.limitedFetch("protect", () => fetchT(`${this.baseUrl}/v2/positions/${encodeURIComponent(posSymbol)}?qty=${qtyStr}`, {
              method: "DELETE",
              headers: this.authHeaders,
            }, 10_000));
            if (!resp.ok) {
              let body = "";
              try { body = await resp.text(); } catch {}
              if (resp.status === 403 && HELD_QTY_403_RE.test(body)) {
                // Same reason string ("http_403") the callers already match
                // on; the flag only drives the one local retry below.
                return { status: "error", filledPrice: 0, reason: "http_403", heldQtyRetryable: true };
              }
              return { status: "error", filledPrice: 0, reason: `http_${resp.status}` };
            }
            closeOrder = await resp.json();
          }
        } else {
          closeOrder = await this.limited("protect", () => withTimeout<any>(this.client.closePosition(posSymbol), 10_000, 'alpaca closePosition'));
        }
        const orderId = closeOrder?.id;
        closeOrderId = orderId;
        if (!orderId) return { status: "no_order_id", filledPrice: 0, reason: "broker returned no order id" };
        const result = await this.pollOrderUntilFilled(orderId, 15000, 2000, 1000, "protect");
        if (result.status === "filled" && result.filledPrice && result.filledPrice > 0) {
          filledAt = result.filledAt;
          filledQty = result.filledQty;
          return { status: "filled", filledPrice: result.filledPrice, filledAt, filledQty };
        }
        return { status: result.status, filledPrice: 0, reason: `poll status=${result.status}` };
      } catch (e: any) {
        // Preserve HTTP status code where available — the caller uses 403 to
        // pause PDT-blocked accounts and 404 to reconcile missing positions.
        const code = e?.response?.status || e?.status || null;
        const msg = e?.message || "unknown error";
        // A wash-trade 403 (see isWashTrade403) is a DIFFERENT animal from
        // the PDT/gone-position 403: an opposite-side order is still open.
        // The distinct reason string keeps AccountManager's exact-match
        // "http_403" handling (PDT pause / gone-position reconcile) from
        // eating it — the deferred-close retry path re-runs the stop sweep.
        const bodyMessage = String(e?.response?.data?.message ?? e?.message ?? "");
        if (isWashTrade403(code, bodyMessage)) {
          log.error(`Close REJECTED by Alpaca WASH-TRADE protection for ${posSymbol}: an opposite-side order is still open (${bodyMessage})`);
          return { status: "error", filledPrice: 0, reason: "http_403_wash_trade" };
        }
        // Held-for-orders 403 (HELD_QTY_403_RE): shares still pledged to the
        // just-canceled (pending_cancel) stop. Same "http_403" reason string
        // the callers match on; the flag drives one local retry below.
        if (code === 403 && HELD_QTY_403_RE.test(bodyMessage)) {
          return { status: "error", filledPrice: 0, reason: "http_403", heldQtyRetryable: true };
        }
        const reason = code ? `http_${code}` : msg;
        return { status: "error", filledPrice: 0, reason };
      }
    };

    // Combine the (opt-in) limit phase's fills with the market phase's into
    // one weighted result. With no exit policy (the default) limitPhaseQty
    // is 0 and this passes the market result through untouched.
    const combined = (mktPrice: number, mktQty: number | undefined, mktFilledAt: number | undefined) => {
      const marketQty = mktQty ?? remainingQty ?? 0;
      if (limitPhaseQty <= 0) {
        return { success: true, filledPrice: mktPrice, orderId: closeOrderId, submittedAt, submittedPx, filledAt: mktFilledAt, filledQty: mktQty, outcome: "confirmed" as const, estPx };
      }
      const totalQty = marketQty + limitPhaseQty;
      const avg = totalQty > 0 ? (marketQty * mktPrice + limitPhaseNotional) / totalQty : mktPrice;
      return { success: true, filledPrice: avg, orderId: closeOrderId ?? limitPhaseOrderId, submittedAt, submittedPx, filledAt: mktFilledAt, filledQty: totalQty, outcome: "confirmed" as const, estPx };
    };

    // Try canonical Alpaca symbol first (e.g. DOGEUSD), then original format.
    let first = await tryClose(symbol.replace("/", ""));
    // Held-for-orders 403: the just-canceled stop hadn't fully released the
    // shares (cancel accepted ≠ cancel completed). A bounded number of
    // retries — each safe because tryClose re-reads the broker position
    // first: a stop that FILLED in the meantime resolves to flat → http_404
    // → the caller's reconcile, never a second sell. The 403 itself is a
    // proven pre-execution rejection, so resubmitting cannot double-close.
    for (let retry = 1; first.heldQtyRetryable && retry <= this.heldQtyMaxRetries; retry++) {
      log.warn(`close ${symbol} bounced 403 (qty held for orders) — retry ${retry}/${this.heldQtyMaxRetries} in ${this.heldQtyRetryDelayMs}ms`);
      await new Promise(r => setTimeout(r, this.heldQtyRetryDelayMs));
      first = await tryClose(symbol.replace("/", ""));
    }
    if (first.status === "filled") {
      log.trade(`Closed position: ${symbol} @ $${first.filledPrice.toFixed(4)}`);
      return combined(first.filledPrice, filledQty, filledAt);
    }

    // Only retry with the alternate symbol format when the failure actually
    // LOOKS like a symbol-format problem (422 / not-found / invalid-symbol).
    // A poll timeout or transport error must NEVER trigger a second
    // client.closePosition() call — if the first order fills after our
    // cancel-race lost, retrying sells again and flips a long into an
    // unmanaged, unrecorded short.
    if (SYMBOL_FORMAT_ERROR_RE.test(first.reason ?? "")) {
      const second = await tryClose(symbol);
      if (second.status === "filled") {
        log.trade(`Closed position: ${symbol} @ $${second.filledPrice.toFixed(4)}`);
        return combined(second.filledPrice, second.filledQty, second.filledAt);
      }
    }

    log.error(`Failed to close ${symbol}: ${first.reason}${limitPhaseQty > 0 ? ` (NOTE: limit phase already closed ${limitPhaseQty} — DB row pending reconciliation)` : ""}`);
    return fail(first.reason);
  }

  /** Bounded limit phase for an exit (OPT-IN via exit policy). Never throws;
   *  any failure just returns zero fills and the caller's market path takes
   *  over — the degrade-to-market guarantee lives in the CALLER's structure,
   *  not here. */
  private async chaseLimitCloseStock(
    symbol: string,
    closeSide: "buy" | "sell",
    qty: number,
    accountId: string,
    cfg: ExitExecutionConfig,
  ): Promise<{ filledQty: number; filledAvgPx: number; orderId?: string }> {
    const none = { filledQty: 0, filledAvgPx: 0 };
    const posSymbol = symbol.replace("/", "");
    try {
      // Bound to what the broker actually holds — a limit close for more
      // than the held qty is rejected outright (shares held for orders).
      const pos = await this.limited("protect", () => withTimeout<any>(this.client.getPosition(posSymbol), 10_000, "alpaca getPosition limit close"));
      const brokerQty = Math.abs(parseFloat(pos?.qty));
      if (!Number.isFinite(brokerQty) || brokerQty <= 0) return none;
      const limitQty = Math.floor(Math.min(qty, brokerQty));
      if (limitQty < 1) return none;
      // Class "protect": this venue's orders/polls belong to a CLOSE.
      const venue = this.stockChaseVenue(posSymbol, closeSide, accountId, uniqueClientOrderId(accountId), "protect");
      const chase = await chaseLimit(venue, {
        side: closeSide, qty: limitQty,
        offsetBps: cfg.offsetBps, refreshThresholdBps: cfg.refreshThresholdBps,
        maxReprices: cfg.maxReprices, maxDistanceBps: cfg.maxDistanceBps,
        timeoutMs: cfg.timeoutMs, pollIntervalMs: cfg.pollIntervalMs,
      });
      if (chase.outcome === "unknown" && chase.danglingRef) {
        // One extra cancel so a still-live limit order can't hold the shares
        // hostage against the market fallback. If this too fails, the market
        // close may bounce; the caller's retry loop handles it — being stuck
        // polite is the one forbidden state.
        try { await this.cancelOrderById(chase.danglingRef); } catch {}
      }
      return { filledQty: chase.filledQty, filledAvgPx: chase.filledAvgPx, orderId: chase.orderRefs[chase.orderRefs.length - 1] };
    } catch (e: any) {
      log.warn(`limit close phase failed for ${symbol} (${e?.message ?? e}) — degrading to market`);
      return none;
    }
  }

  // ── Cleanup ───────────────────────────────

  cleanup() {
    this.wsWanted = false;
    try { this.stockWs?.close(); } catch {}
    try { this.cryptoWs?.close(); } catch {}
    this.stockWs = null;
    this.cryptoWs = null;
  }

  isConnected(): boolean { return this.connected; }
  isDataConnected(): boolean {
    return this.stockWsState === "connected" || this.cryptoWsState === "connected" || this.connected;
  }
}
