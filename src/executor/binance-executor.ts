// ══════════════════════════════════════════════
// Binance Executor v5.4 — Futures Testnet
// HMAC-SHA256 signed REST · Perpetual contracts
// Leverage: 3x (low) / 5x (high)
// Market data still from Alpaca WS
// ══════════════════════════════════════════════

import crypto from "crypto";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { eventBus, EVENTS } from "../utils/events";
import type { Signal, Order } from "../utils/types";
import type { QuoteAsset } from "./binance/quoteAsset";
import { USDC_SYMBOL_MAP } from "./binance/quoteAsset";
import { InstrumentCatalog, floorToStep, decimalPlaces, type InstrumentSpec } from "./binance/instrumentSpec";
import { createBinanceUsdmTransport, type BinanceUsdmTransport } from "./binance/usdmTransport";
import type { BinanceRuntimeCredentials } from "./credentials";
import { dataIntegrityEnabled, isCrossedQuote, isImpossibleFutureTs, clockDriftMs, CLOCK_DRIFT_WARN_MS, clockDrift, positionPayloadIssues, warnThrottled } from "../market/dataIntegrity";
import {
  resolveExecutionPolicy, chaseLimit, MIN_ENTRY_FILL_FRACTION,
  type ChaseVenue, type UnknownOrderResult,
  type OrderOutcome, type EntryExecutionConfig,
} from "./executionPolicy";
import { estimateFromBook, type BookLevel, type DepthEstimate } from "./bookDepth";
import { getVenueRateLimiter, type RequestClass } from "./rateLimiter";
import { symbolLocks, DEFAULT_SYMBOL_LOCK_TIMEOUT_MS } from "./symbolLock";
import {
  checkStopAgainstMainnet, fetchMainnetMarkPrice, stopConfirmMode,
  type StopCloseConfirm,
} from "../market/mainnetStopConfirm";
export type { QuoteAsset } from "./binance/quoteAsset";

const log = createLogger("BinanceExecutor");

// Alpaca symbol → Binance Futures symbol
// Exported single source of truth (2026-07-07): BinanceFuturesBroker kept its
// OWN copy of this map, which silently stayed at the 9 pre-expansion symbols.
// The first ATOM/USD trade made BrokerSync see raw "ATOMUSDT" (unmapped),
// insert phantom rows, and credit binance_low ~$640 of margin it never paid.
// One map, imported everywhere — the divergence class dies here.
export const SYMBOL_MAP: Record<string, string> = {
  "BTC/USD":  "BTCUSDT",
  "ETH/USD":  "ETHUSDT",
  "SOL/USD":  "SOLUSDT",
  "ADA/USD":  "ADAUSDT",
  "AVAX/USD": "AVAXUSDT",
  "DOT/USD":  "DOTUSDT",
  "LINK/USD": "LINKUSDT",
  "XRP/USD":  "XRPUSDT",
  "DOGE/USD": "DOGEUSDT",
  // 2026-07 universe expansion — liquid majors for 24/7 daily coverage (verified
  // TRADING on Binance Futures testnet with the precisions below).
  "BNB/USD":  "BNBUSDT",
  "LTC/USD":  "LTCUSDT",
  "BCH/USD":  "BCHUSDT",
  "ATOM/USD": "ATOMUSDT",
  "NEAR/USD": "NEARUSDT",
  "UNI/USD":  "UNIUSDT",
  "TRX/USD":  "TRXUSDT",
};

// ── FAPI client-order-id namespace (P1, 2026-07-29) ──────────────────────
// Manual orders and legacy pre-namespace stops exist on the broker, so
// nothing there is attributable without a stamp. Same pattern as COIN-M's
// COINM_CLIENT_ID_NAMESPACE/isOwnedClientId (binance-coinm-executor.ts) and
// the Alpaca `uc8-` stamp. Until the 2026-07-30 single-system consolidation
// the namespace also embedded an INSTANCE_ID (two deployments shared this
// wallet); stops placed back then read `uc-fapi-<hostname>-…` and MUST keep
// being recognized as ours, which is why ownership below is a prefix test,
// never an exact-namespace match. Binance clientOrderId cap is 36 chars.
const FAPI_ID_PREFIX = "uc-fapi-";
const FAPI_CLIENT_ID_MAX_LEN = 36;

/** `uc-fapi-` — the exact prefix every conditional order this bot stamps on
 *  FAPI. */
export function fapiClientIdNamespace(): string {
  return FAPI_ID_PREFIX;
}

/** Deterministic namespaced id: same seed → same id (retry-safe), always
 *  within the 36-char cap. */
export function fapiClientOrderId(seed: string): string {
  const ns = fapiClientIdNamespace();
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, FAPI_CLIENT_ID_MAX_LEN - ns.length);
  return `${ns}${hash}`;
}

/** True for any id stamped by this codebase — executors and cert scripts all
 *  use a `uc-` prefix (uc-fapi-, uc-coinm-, uc-cert-usdc-), including the
 *  legacy instance-stamped `uc-fapi-<hostname>-…` format. With a single
 *  deployment, every `uc-*` order is ours and cancelable by us. */
export function isBotFapiClientId(id: string | number | undefined | null): boolean {
  return typeof id === "string" && id.startsWith("uc-");
}

// Qty/price precision used to be two hardcoded tables here (QTY_PRECISION,
// PRICE_PRECISION). Replaced (2026-07-19) by InstrumentCatalog, a cached
// read of the exchange's own /fapi/v1/exchangeInfo filters — precision
// drifts per symbol (e.g. AVAXUSDT's step moved to whole units on testnet)
// and a stale hardcoded table silently mis-rounds/rejects orders. Fallback
// when the catalog has no spec yet (first call, or exchangeInfo unreachable):
// 2 decimals, matching the old tables' default.
const FALLBACK_DECIMALS = 2;

// Binance error codes that mean "your qty/price violates an exchange
// filter" — worth a one-shot catalog refresh so the NEXT order is correctly
// floored. Never triggers a retry of the order that just got rejected
// (ambiguous POSTs are never auto-replayed).
const FILTER_REJECTION_CODES = new Set([-1013, -1111, -4003, -4014, -4131, -4164]);

export interface BinanceExecutorOptions {
  /** Settlement/margin asset for this instance. Default USDT (existing behavior). */
  quoteAsset?: QuoteAsset;
  /** Injectable for tests / explicit warm start — avoids any network call. */
  instrumentCatalog?: InstrumentCatalog;
  /** Injectable REST transport (contract tests / verify script). Default:
   *  built from config.binanceFutures.transport ("legacy" | "sdk"). */
  transport?: BinanceUsdmTransport;
  /** F4a credential injection (ACCOUNTS_SOURCE=registry). ABSENT = env mode:
   *  keys + REST base come from config exactly as before (captured at
   *  construction, as always — tests mutate the instance fields directly).
   *  Present = the injected values are the ONLY source; .env is never
   *  consulted. The init() sandbox-host allowlist applies regardless. */
  credentials?: BinanceRuntimeCredentials;
}

function reverseMap(m: Record<string, string>): Record<string, string> {
  const rev: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) rev[v] = k;
  return rev;
}

/**
 * Is this REST host a non-production (paper) Binance Futures endpoint?
 *
 * The guard used to test for the literal substring "testnet", which was
 * correct until Binance began migrating the sandbox to `demo-fapi.binance.com`
 * (and `demo-fstream` for the socket) — a host that is NOT production but does
 * NOT contain "testnet". A substring check would therefore have REFUSED to
 * enable the sleeve on the very endpoint the old one is being replaced by,
 * turning a safety rail into a migration blocker. 2026-08-09.
 *
 * Deliberately an allowlist of known sandbox hosts rather than a denylist of
 * production ones: the failure mode of an unknown host must be "refuse", never
 * "assume it is safe and trade real money".
 */
export function isNonProductionBinanceHost(url: string): boolean {
  const u = (url || "").toLowerCase();
  return u.includes("testnet") || u.includes("demo-fapi") || u.includes("demo-fstream") || u.includes("demo.binance");
}

/**
 * User-data WebSocket host for a given USDⓈ-M REST base.
 *
 * Fixes a latent bug (2026-10-02): startUserDataStream used to pick the WS
 * host with `baseUrl.includes("testnet")`, so the new demo host
 * (demo-fapi.binance.com — NOT production, does NOT contain "testnet") would
 * have connected the user-data stream to MAINNET's fstream.binance.com: a
 * sandbox listenKey on the production socket, i.e. no fills ever delivered
 * (or worse). Derivation now goes through the same sandbox allowlist as the
 * REST safety gate.
 *
 * Hosts, with sources:
 *  - prod    → wss://fstream.binance.com — the SDK's own constant
 *              DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL
 *              (@binance/common 38.x).
 *  - testnet → wss://stream.binancefuture.com — the host this executor has
 *              always used against testnet.binancefuture.com (kept verbatim;
 *              the SDK's TESTNET constant names the sibling
 *              fstream.binancefuture.com, both serve the testnet book).
 *  - demo    → wss://demo-fstream.binance.com — the demo sibling of
 *              demo-fapi. The SDK (38.1.2) ships no DEMO WS-streams constant
 *              for USDⓈ-M yet, so this was verified LIVE on 2026-10-02: a
 *              WebSocket to wss://demo-fstream.binance.com/ws/btcusdt@markPrice
 *              handshakes and streams markPriceUpdate events for the same
 *              book as stream.binancefuture.com. The host has also been in
 *              isNonProductionBinanceHost's allowlist since 2026-08-09
 *              (Binance's demo-migration announcement names demo-fstream as
 *              the socket sibling of demo-fapi).
 */
export function resolveUserDataWsHost(restBase: string): string {
  const u = (restBase || "").toLowerCase();
  if (!isNonProductionBinanceHost(u)) return "wss://fstream.binance.com"; // production
  if (u.includes("testnet")) return "wss://stream.binancefuture.com";
  return "wss://demo-fstream.binance.com"; // demo-fapi / demo-fstream / demo.binance
}

export class BinanceExecutor {
  private apiKey: string;
  private secretKey: string;
  private baseUrl: string;
  private connected = false;
  private leverageBySymbol: Map<string, number> = new Map();

  // Isolated USDⓈ-M settlement wallet this instance trades. Default USDT
  // (existing behavior, unchanged). A USDC instance gets its OWN symbol map
  // (disjoint internal-symbol keys, e.g. "BTC/USDC" -> "BTCUSDC") so every
  // lookup below (`this.symbolMap[x]`) is naturally an ownership check: a
  // symbol the instance doesn't own simply isn't in its map.
  private readonly quoteAsset: QuoteAsset;
  private readonly symbolMap: Record<string, string>;
  private readonly reverseSymbolMap: Record<string, string>;
  private readonly catalog: InstrumentCatalog;

  connectionState: "disconnected" | "connected" | "error" = "disconnected";
  private pollDelayMs = 500;
  private closePollTimeoutMs = 8_000;

  /** Shared PER-VENUE limiter (rateLimiter.ts). CRITICAL: both FAPI
   *  instances (USDT + USDC) sign against the SAME account and IP weight
   *  quota, so they MUST draw from the same bucket — never a per-instance
   *  limiter (fixed by test: getVenueRateLimiter("binance_fapi") identity). */
  private limiter = getVenueRateLimiter("binance_fapi");
  /** REST transport (usdmTransport.ts). Field declared after `limiter` —
   *  the constructor hands it live accessors into this instance. */
  private readonly transport: BinanceUsdmTransport;
  /** Symbol-lock acquisition bound; overridable only by tests (a shorter
   *  bound makes the timeout path testable without a 10s wait). */
  private lockTimeoutMs = DEFAULT_SYMBOL_LOCK_TIMEOUT_MS;

  // Audit fix (P2, 2026-05-07): /healthz/full reads this for the binance
  // last_price field. Previously never declared → always 0 → endpoint
  // always reported "none". Updated by every successful price fetch and
  // every user-data WS message.
  lastMessageAt = 0;

  // Wave 3d (2026-05-07): user-data WS state
  private listenKey: string | null = null;
  private userWs: WebSocket | null = null;
  private listenKeyKeepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(options: BinanceExecutorOptions = {}) {
    if (options.credentials) {
      // F4a: injected registry credentials — the only source for this instance.
      this.apiKey = options.credentials.apiKey;
      this.secretKey = options.credentials.apiSecret;
      this.baseUrl = options.credentials.restBase;
    } else {
      // Env mode (default): use Futures keys if available, fallback to spot
      this.apiKey = config.binanceFutures.apiKey || config.binance.apiKey;
      this.secretKey = config.binanceFutures.apiSecret || config.binance.apiSecret;
      this.baseUrl = config.binanceFutures.restBase || "https://demo-fapi.binance.com";
    }
    this.quoteAsset = options.quoteAsset ?? "USDT";
    this.symbolMap = this.quoteAsset === "USDC" ? USDC_SYMBOL_MAP : SYMBOL_MAP;
    this.reverseSymbolMap = reverseMap(this.symbolMap);
    this.catalog = options.instrumentCatalog ?? new InstrumentCatalog(() => this.fetchExchangeInfoRaw());
    // REST transport seam (2026-10-02): "legacy" (default) is this file's old
    // signed-fetch layer moved verbatim into usdmTransport.ts; "sdk" is the
    // official Binance connector. Live accessors, not captured values — tests
    // and re-config mutate baseUrl/keys on the instance. An unknown
    // BINANCE_TRANSPORT fails CLOSED here (throws at construction).
    this.transport = options.transport ?? createBinanceUsdmTransport(config.binanceFutures.transport, {
      baseUrl: () => this.baseUrl,
      apiKey: () => this.apiKey,
      secretKey: () => this.secretKey,
      limiter: () => this.limiter,
    });
  }

  private async fetchExchangeInfoRaw(): Promise<any> {
    const resp = await this.transport.publicRequest("/fapi/v1/exchangeInfo", {}, "background");
    if (!resp.ok) throw new Error(`exchangeInfo HTTP ${resp.status}`);
    return resp.json();
  }

  getQuoteAsset(): QuoteAsset { return this.quoteAsset; }

  /** Non-secret credential view for the admin config route (the apiKey is
   *  identifying, not the secret; the route masks it anyway). */
  credentialPublicView(): { apiKey: string; restBase: string } {
    return { apiKey: this.apiKey, restBase: this.baseUrl };
  }

  // ── Startup preflight (read-only, never places an order) ───────

  /**
   * Certification gate for a non-default instance (momentum_crypto_usdc,
   * 2026-07-19). Refuses to enable the sleeve unless: the REST base is
   * testnet, the account runs one-way position mode, single-asset margin
   * mode (multiAssetsMargin=false — the account setting this repo's
   * testnet wallet already assumes, see riskProfiles.ts), an asset row for
   * THIS instance's quoteAsset exists in /fapi/v2/account, and every symbol
   * this instance owns has TRADING exchangeInfo filters. Called from
   * src/index.ts BEFORE the sleeve is wired; a failure hard-fails only that
   * sleeve, never the rest of the bot or the default USDT instance.
   */
  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    if (!isNonProductionBinanceHost(this.baseUrl)) {
      return { ok: false, reason: `restBase "${this.baseUrl}" is not a paper/testnet host — refusing to enable` };
    }
    if (!this.apiKey || !this.secretKey) return { ok: false, reason: "API keys not configured" };
    try {
      const dual = await this.signedRequest("GET", "/fapi/v1/positionSide/dual");
      if (dual?.dualSidePosition !== false) {
        return { ok: false, reason: `dualSidePosition must be false (one-way mode), got ${dual?.dualSidePosition}` };
      }
      const multi = await this.signedRequest("GET", "/fapi/v1/multiAssetsMargin");
      if (multi?.multiAssetsMargin !== false) {
        return { ok: false, reason: `multiAssetsMargin must be false (single-asset mode), got ${multi?.multiAssetsMargin}` };
      }
      const acct = await this.signedRequest("GET", "/fapi/v2/account");
      const assets = Array.isArray(acct?.assets) ? acct.assets : [];
      const row = assets.find((a: any) => a?.asset === this.quoteAsset);
      if (!row) return { ok: false, reason: `no ${this.quoteAsset} asset row in assets[] — expected balance row missing` };
      const missing: string[] = [];
      for (const native of Object.values(this.symbolMap)) {
        const spec = await this.ensureOwnedSpec(native);
        if (!spec) missing.push(native);
      }
      if (missing.length > 0) return { ok: false, reason: `exchangeInfo missing TRADING filters for: ${missing.join(", ")}` };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e.message };
    }
  }

  async init(): Promise<boolean> {
    // ── Safety gate #1 (2026-08-09): sandbox-host allowlist, EVERY instance ──
    // preflight() already refused a production host for the opt-in USDC/COIN-M
    // candidates, but the DEFAULT (USDT) instance — the one OrderExecutor
    // builds for momentum_crypto, the sleeve that actually trades — only ever
    // ran init(). A BINANCE_FUTURES_REST_BASE of fapi.binance.com would have
    // traded REAL money at 2x leverage with nothing rejecting it. The gate
    // lives in init() (not in callers) so every construction path — bot,
    // scripts, certs — inherits it, and it runs BEFORE any network call.
    // Deliberately NO override: this codebase is sandbox-only, and refusing a
    // production host never orphans anything of ours — every open row in OUR
    // db belongs to a sandbox account, not to whatever fapi.binance.com holds.
    if (!isNonProductionBinanceHost(this.baseUrl)) {
      log.error(`🚫 SAFETY: restBase "${this.baseUrl}" is not a known paper/testnet Binance host — refusing to connect (unknown hosts are never assumed safe)`);
      this.connectionState = "error";
      return false;
    }
    if (!this.apiKey || this.apiKey === "") {
      log.warn("Binance Futures keys not configured — crypto execution disabled");
      return false;
    }

    try {
      // Test with server time — and measure clock drift while we're here
      // (2026-07-29): detection only, never adjusts. Healthy baseline is
      // ~50-120ms; past CLOCK_DRIFT_WARN_MS it's on its way to -1021
      // recvWindow rejections and worth a loud line.
      const t0 = Date.now();
      const resp = await this.transport.serverTime();
      if (!resp.ok) throw new Error(`${resp.status}`);
      const t1 = Date.now();
      try {
        const serverTime = Number((await resp.json() as any)?.serverTime);
        if (Number.isFinite(serverTime) && serverTime > 0) {
          const drift = clockDriftMs(serverTime, t0, t1);
          const line = `server clock drift ${drift}ms vs local (RTT ${t1 - t0}ms)`;
          if (Math.abs(drift) > CLOCK_DRIFT_WARN_MS) log.warn(`${line} — approaching recvWindow limits, check NTP`);
          else log.info(line);
        }
      } catch { /* drift measurement is best-effort; never blocks connect */ }

      // Test auth with futures account
      const acct = await this.signedRequest("GET", "/fapi/v2/account");
      if (acct.code) throw new Error(acct.msg);

      // ── Safety gate #2 (2026-08-09): account-mode invariants, EVERY
      // instance. One-way position mode and single-asset margin are hard
      // assumptions of this executor: every close is a reduceOnly order with
      // no positionSide (silently rejected in hedge mode — the stop-loss
      // loop would "close" and nothing would happen), and computeMarginBalance
      // assumes single-asset margin. Verify at connect instead of discovering
      // on the first exit. Two read-only signed GETs on the same host/auth
      // that /fapi/v2/account just used; a transport failure lands in the
      // catch below and FAILS CLOSED (unknown account mode ⇒ don't trade),
      // the same doctrine as CoinM's startup stop reconcile.
      const dual = await this.signedRequest("GET", "/fapi/v1/positionSide/dual");
      if (dual?.dualSidePosition !== false) {
        log.error(`🚫 SAFETY: dualSidePosition must be false (one-way mode), got ${JSON.stringify(dual?.dualSidePosition)} — refusing to connect; reduceOnly closes silently break in hedge mode`);
        this.connectionState = "error";
        return false;
      }
      const multi = await this.signedRequest("GET", "/fapi/v1/multiAssetsMargin");
      if (multi?.multiAssetsMargin !== false) {
        log.error(`🚫 SAFETY: multiAssetsMargin must be false (single-asset mode), got ${JSON.stringify(multi?.multiAssetsMargin)} — refusing to connect; margin math assumes single-asset mode`);
        this.connectionState = "error";
        return false;
      }

      // Margin-only read — no assetIndex fan-out (reviewer P1, 2026-07-18):
      // startup must never depend on the per-asset display valuation.
      const { marginEquity, marginCash, wallet } = this.computeMarginBalance(acct);

      this.connected = true;
      this.connectionState = "connected";
      log.info(`✅ Binance Futures Testnet connected (${this.quoteAsset}, transport ${this.transport.kind}). Margin balance: $${marginEquity.toFixed(2)}, wallet: $${wallet.toFixed(2)}, available: $${marginCash.toFixed(2)}, canTrade: ${acct.canTrade}`);

      // Set leverage for all our symbols
      await this.initLeverage();

      // Best-effort warm start for the instrument catalog (precision/min-qty/
      // min-notional filters). Never blocks connect — placeOrder falls back
      // to FALLBACK_DECIMALS and lazily re-fetches if this fails.
      try { await this.catalog.refresh(); } catch (e: any) {
        log.warn(`exchangeInfo warm start failed (will lazy-fetch per order): ${e.message}`);
      }

      // Wave 3d (2026-05-07): start user-data WS when EXECUTION_WS=true.
      // The REST poll loop in placeOrder/closePosition still runs as
      // fallback so this is purely additive.
      if (config.execution.useWs) {
        await this.startUserDataStream();
      }

      return true;
    } catch (e: any) {
      log.error(`Binance Futures connection failed: ${e.message}`);
      this.connectionState = "error";
      return false;
    }
  }

  // ── Wave 3d: user-data WS via listenKey ──────────────────────────
  //
  // Flow: POST /fapi/v1/listenKey → 60-min listenKey, then connect
  // wss://fstream.binancefuture.com/ws/<key>. Keepalive PUT every 25min.
  // Emits ORDER_UPDATE on every ORDER_TRADE_UPDATE event.
  private async startUserDataStream(): Promise<void> {
    try {
      // init() is re-runnable (AccountManager's 60s sync retries it after a
      // REST outage — 2026-08-16): tear down any previous WS/listenKey
      // keepalive FIRST so repeated init() can never stack a second socket
      // or leak a second 25-min interval. No-op on the first call.
      this.stopUserDataStream();
      const r = await this.signedRequest("POST", "/fapi/v1/listenKey", {});
      if (!r?.listenKey) {
        log.warn(`listenKey request returned no key: ${JSON.stringify(r).slice(0, 200)}`);
        return;
      }
      this.listenKey = r.listenKey as string;
      // Sandbox WS hosts differ from live — and "testnet"-substring sniffing
      // mis-routed the demo host to MAINNET's socket (see resolveUserDataWsHost).
      const wsHost = resolveUserDataWsHost(this.baseUrl);
      const url = `${wsHost}/ws/${this.listenKey}`;
      log.info(`Binance user-data WS connecting → ${wsHost}/ws/<key>`);

      this.userWs = new WebSocket(url);
      this.userWs.onopen = () => log.info("Binance user-data WS connected");
      this.userWs.onerror = (e: any) =>
        log.warn(`Binance user-data WS error: ${e?.message ?? e}`);
      this.userWs.onclose = () => {
        log.warn("Binance user-data WS closed (polling fallback active)");
        this.userWs = null;
      };
      this.userWs.onmessage = (ev: any) => {
        try {
          const msg = JSON.parse(ev.data);
          // Heartbeat for /healthz/full + /api/connections regardless of
          // event type (Binance also sends ACCOUNT_UPDATE / margin / etc).
          this.lastMessageAt = Date.now();
          if (msg?.e !== "ORDER_TRADE_UPDATE") return;
          const o = msg.o ?? {};
          eventBus.emit(EVENTS.ORDER_UPDATE, {
            broker: "binance",
            externalId: String(o.i ?? ""),       // orderId
            status: String(o.X ?? ""),            // executionType-derived order status
            filledQty: parseFloat(o.z ?? "0"),    // cumulative filled qty
            avgPx: parseFloat(o.ap ?? "0"),       // avg fill price
            eventType: o.x ?? null,               // execution type (NEW/TRADE/CANCELED)
            ts: Date.now(),
          });
        } catch (e: any) {
          log.warn(`user-data parse failed: ${e?.message ?? e}`);
        }
      };

      // Keep-alive every 25 minutes (Binance expires unused listenKey after 60).
      this.listenKeyKeepAlive = setInterval(async () => {
        try {
          await this.signedRequest("PUT", "/fapi/v1/listenKey", {});
        } catch (e: any) {
          log.warn(`listenKey keepalive failed: ${e?.message ?? e}`);
        }
      }, 25 * 60_000);
    } catch (e: any) {
      log.warn(`startUserDataStream failed: ${e?.message ?? e}`);
    }
  }

  // A sibling `signedRequestRaw` used to live here for the listenKey calls.
  // It never checked the HTTP status — a 400 body like {"code":-1021,
  // "msg":"Timestamp ... outside of the recvWindow"} parsed as a "response"
  // and the keepalive silently failed forever. Divergent-sibling guards are
  // this repo's #1 recurring bug class, so the sibling is deleted:
  // everything routes through signedRequest (which grew PUT support).

  /** Stop WS + listenKey keepalive on shutdown / reconnect. */
  stopUserDataStream(): void {
    if (this.listenKeyKeepAlive) {
      clearInterval(this.listenKeyKeepAlive);
      this.listenKeyKeepAlive = null;
    }
    // Detach onclose BEFORE closing: the handler does `this.userWs = null`
    // asynchronously, which would clobber a REPLACEMENT socket's reference
    // when startUserDataStream tears down the old stream on reconnect.
    if (this.userWs) {
      try { this.userWs.onclose = null; } catch {}
      try { this.userWs.close(); } catch {}
    }
    this.userWs = null;
    this.listenKey = null;
  }

  // ── Set leverage for all traded symbols ───

  private async initLeverage() {
    // Own symbols only — a USDC instance must never touch USDT leverage
    // settings (or vice versa).
    for (const [alpaca, binance] of Object.entries(this.symbolMap)) {
      await this.setLeverage(binance, this.getTargetLeverage(alpaca));
    }
  }

  private getTargetLeverage(_symbol: string, _accountId = "momentum_crypto"): number {
    // v8: single momentum sleeve — walk-forward validated at 2x.
    return 2;
  }

  async setLeverage(binanceSymbol: string, leverage: number): Promise<boolean> {
    try {
      const result = await this.signedRequest("POST", "/fapi/v1/leverage", {
        symbol: binanceSymbol,
        leverage: leverage.toString(),
      });
      if (result.code && result.code !== 0) {
        log.warn(`Leverage ${binanceSymbol} ${leverage}x: ${result.msg}`);
        return false;
      }
      this.leverageBySymbol.set(binanceSymbol, leverage);
      log.info(`⚡ ${binanceSymbol}: ${leverage}x leverage set`);
      return true;
    } catch (e: any) {
      log.warn(`Leverage set failed ${binanceSymbol}: ${e.message}`);
      return false;
    }
  }

  // ── Signed request helper ─────────────────
  //
  // The implementation (limiter acquisition, HMAC signing, penalty-header
  // handling, error normalization) moved VERBATIM to usdmTransport.ts's
  // LegacyUsdmTransport (2026-10-02) so the official-SDK transport can sit
  // behind the exact same contract. This method stays on the class — it is
  // the single seam every test fixture overrides (test-support/binance.ts).

  private async signedRequest(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params: Record<string, string> = {}, cls: RequestClass = "trade"): Promise<any> {
    return this.transport.signedRequest(method, path, params, cls);
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * Catalog lookup scoped to THIS instance's settlement asset. A spec whose
   * `marginAsset` doesn't match `this.quoteAsset` is a data-integrity
   * mismatch (e.g. a USDC symbol's exchangeInfo row somehow carrying a
   * USDT margin asset) — never usable for precision, so it's treated
   * identically to "no spec found" by every caller below.
   */
  private async ensureOwnedSpec(nativeSymbol: string): Promise<InstrumentSpec | undefined> {
    let spec: InstrumentSpec | undefined;
    try { spec = await this.catalog.ensure(nativeSymbol); } catch (e: any) {
      log.warn(`instrument catalog fetch failed for ${nativeSymbol}: ${e.message}`);
      return undefined;
    }
    if (spec && spec.marginAsset !== this.quoteAsset) {
      log.error(`instrument catalog spec for ${nativeSymbol} has marginAsset=${spec.marginAsset}, expected ${this.quoteAsset} for this executor — treating as unknown`);
      return undefined;
    }
    return spec;
  }

  /** LOT_SIZE/MARKET_LOT_SIZE-derived step + bounds for a native symbol.
   *  Fetches the catalog lazily (once) on first use; a failed fetch logs and
   *  falls back to FALLBACK_DECIMALS so it never blocks a CLOSE/read.
   *  `specFound` tells callers placing a NEW order whether that fallback was
   *  used — see the fail-closed gate in placeOrder(). */
  private async resolveQtyStep(nativeSymbol: string): Promise<{ step: number; minQty: number; maxQty: number; decimals: number; minNotional: number | null; specFound: boolean }> {
    const spec = await this.ensureOwnedSpec(nativeSymbol);
    const step = spec?.marketStepSize && spec.marketStepSize > 0 ? spec.marketStepSize : (spec?.stepSize ?? 0);
    const minQty = spec?.marketMinQty && spec.marketMinQty > 0 ? spec.marketMinQty : (spec?.minQty ?? 0);
    const maxQty = spec?.marketMaxQty && spec.marketMaxQty > 0 ? spec.marketMaxQty : (spec?.maxQty ?? 0);
    return {
      step, minQty, maxQty,
      decimals: step > 0 ? decimalPlaces(step.toString()) : FALLBACK_DECIMALS,
      minNotional: spec?.minNotional ?? null,
      specFound: spec !== undefined,
    };
  }

  /**
   * Minimum MARKET-order quantity for `internalSymbol` at `price` that
   * clears both MARKET_LOT_SIZE.minQty and MIN_NOTIONAL (1% safety buffer —
   * the exchange re-checks notional against its own mark price, which can
   * drift slightly from `price`). Read-only, strict cached exchangeInfo
   * (same lazy-fetch-once contract as resolveQtyStep — never places an
   * order). Replaces the old certification script's hardcoded "$20 / price"
   * guess, which silently under-shot BTCUSDC's real $100 MIN_NOTIONAL (a
   * step-floored $20 probe landed at minQty's ~$65, still below it).
   * `placeOrder` remains the final validator — this only picks a size worth
   * attempting. Fails closed (null) on an unowned symbol, invalid price, or
   * a missing/invalid exchangeInfo spec.
   */
  async minCertQty(internalSymbol: string, price: number): Promise<number | null> {
    if (!Number.isFinite(price) || !(price > 0)) return null;
    const nativeSymbol = this.symbolMap[internalSymbol];
    if (!nativeSymbol) return null;
    const { step, minQty, maxQty, minNotional, specFound } = await this.resolveQtyStep(nativeSymbol);
    if (!specFound || !(step > 0) || !(minQty > 0)) return null;

    const decimals = decimalPlaces(step.toString());
    // Round a target UP to the next whole step. A subtractive epsilon (the
    // old `- 1e-9` before Math.ceil) can round a genuine excess DOWN by a
    // full step when the true ratio lands just above an integer — rounding
    // to 12 significant digits first cancels float noise in EITHER
    // direction without ever under-providing the minimum.
    const stepsFor = (target: number) => Math.ceil(Number((target / step).toPrecision(12)));
    let qty = Number((stepsFor(minQty) * step).toFixed(decimals)); // minQty itself aligned up to step
    if (minNotional && minNotional > 0) {
      const NOTIONAL_SAFETY = 1.01;
      const notionalQty = Number((stepsFor((minNotional * NOTIONAL_SAFETY) / price) * step).toFixed(decimals));
      qty = Math.max(qty, notionalQty);
    }
    if (maxQty > 0 && qty > maxQty) return null; // never clamp to a size below the computed minimum
    return qty > 0 ? qty : null;
  }

  private floorQty(qty: number, step: number, decimals: number): number {
    return step > 0 ? floorToStep(qty, step) : Number(qty.toFixed(decimals));
  }

  /**
   * Used ONLY when a close has no exchange spec to floor against (catalog
   * unavailable). A close is risk-REDUCING: rounding it to the generic
   * FALLBACK_DECIMALS (2) can zero out a real position (BTCUSDT's true step
   * is 0.001 — 0.001.toFixed(2) is "0.00", which used to make the close
   * silently no-op). Preserve the broker-reported quantity's own precision
   * exactly; only strip float noise past Binance's universal 8-decimal qty
   * cap (never real digits of a realistic position size). If Binance's real
   * (unknown) step rejects this exact value, the order fails loudly instead
   * of being silently dropped to zero — failing open on precision only in
   * the direction that preserves safety.
   */
  private preserveExactQty(qty: number): { qty: number; decimals: number } {
    const decimals = Math.min(decimalPlaces(qty.toString()), 8);
    return { qty: Number(qty.toFixed(decimals)), decimals };
  }

  /** PRICE_FILTER tickSize for a native symbol (0 = no spec found, caller
   *  falls back to FALLBACK_DECIMALS). Same lazy/fallback contract as
   *  resolveQtyStep. */
  private async resolvePriceTick(nativeSymbol: string): Promise<number> {
    const spec = await this.ensureOwnedSpec(nativeSymbol);
    return spec?.tickSize && spec.tickSize > 0 ? spec.tickSize : 0;
  }

  private async cancelOrderAndConfirmTerminal(binanceSymbol: string, orderId: any): Promise<boolean> {
    if (!orderId) return false;
    // Class "protect": always a risk-reducing cleanup of a residual order,
    // reachable from the close path — must survive a 429 penalty window.
    try { await this.signedRequest("DELETE", "/fapi/v1/order", { symbol: binanceSymbol, orderId: String(orderId) }, "protect"); } catch {}
    try {
      const check = await this.signedRequest("GET", "/fapi/v1/order", { symbol: binanceSymbol, orderId: String(orderId) }, "protect");
      return ["CANCELED", "EXPIRED", "REJECTED", "FILLED"].includes(String(check.status));
    } catch { return false; }
  }

  // ── Order execution (Futures) ─────────────

  async placeOrder(signal: Signal, quantity: number, accountId = "binance_low", opts: { clientOrderId?: string } = {}): Promise<Order | UnknownOrderResult | null> {
    if (!this.connected) return null;
    // Per-(venue,symbol) mutation lock (symbolLock.ts): an open must never
    // interleave with a concurrent close/stop mutation on the same symbol.
    // A lock timeout is a pre-transmit denial — null (proven not submitted)
    // is truthful; the caller's normal retry cadence applies. The two FAPI
    // instances can't contend (internal symbols disjoint: BTC/USD vs BTC/USDC).
    return await symbolLocks.withLock("binance_fapi", signal.symbol, { timeoutMs: this.lockTimeoutMs, label: `placeOrder:${accountId}` },
      () => this.placeOrderUnderLock(signal, quantity, accountId, opts),
      () => {
        log.error(`placeOrder ${signal.symbol}: symbol mutation lock not acquired — NOT submitting (another mutation is in flight)`);
        return null;
      });
  }

  private async placeOrderUnderLock(signal: Signal, quantity: number, accountId: string, opts: { clientOrderId?: string } = {}): Promise<Order | UnknownOrderResult | null> {
    const binanceSymbol = this.symbolMap[signal.symbol];
    if (!binanceSymbol) {
      log.warn(`No Binance mapping for ${signal.symbol}`);
      return null;
    }

    const { step, minQty, maxQty, decimals, minNotional, specFound } = await this.resolveQtyStep(binanceSymbol);
    // Fail CLOSED for NEW order placement: guessing a 2-decimal fallback on a
    // symbol whose real LOT_SIZE step is unknown can either get the order
    // rejected or, worse, silently accepted at the wrong precision. A close
    // (resolveQtyStep's other caller) keeps the fallback — refusing to close
    // an existing position because exchangeInfo is briefly unreachable is a
    // worse outcome than a slightly-imprecise reduceOnly qty.
    if (!specFound) {
      log.error(`Futures order rejected: no exchange filter spec for ${binanceSymbol} (exchangeInfo unavailable) — refusing to open at a guessed precision`);
      return null;
    }
    let qty = this.floorQty(quantity, step, decimals);
    if (minQty > 0 && qty > 0 && qty < minQty) {
      log.warn(`Futures order rejected pre-flight: ${binanceSymbol} qty ${qty} below minQty ${minQty}`);
      return null;
    }
    if (maxQty > 0 && qty > maxQty) qty = maxQty;
    if (qty <= 0) return null;

    const orderId = `bnf_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const leverage = this.getTargetLeverage(signal.symbol, accountId);

    // Fresh executable touch before submitting. A missing quote only disables
    // the fill benchmark; telemetry must never block the order.
    const quote = await this.getExecutableQuote(signal.symbol, signal.side);
    const submittedAt = Date.now();
    const submittedPx = quote?.price ?? 0;
    if (!quote) {
      log.warn(`No fresh executable quote for ${signal.symbol}; fill telemetry skipped`);
    }

    if (minNotional && minNotional > 0) {
      const estPrice = submittedPx || signal.price;
      if (estPrice > 0 && qty * estPrice < minNotional) {
        log.warn(`Futures order rejected pre-flight: ${binanceSymbol} notional ${(qty * estPrice).toFixed(2)} < minNotional ${minNotional}`);
        return null;
      }
    }

    // Pre-trade impact estimate from REAL depth (bookDepth.ts). Telemetry
    // by default (rides to fills.est_px); only gates when a sleeve's policy
    // explicitly opts into maxEstImpactBps.
    // Gated on a fresh quote: without one the fill benchmark (recordFill) is
    // skipped anyway, so an estimate would never be recorded.
    const policy = resolveExecutionPolicy(accountId);
    const est = quote ? await this.estimateDepthImpact(signal.symbol, signal.side, qty * (submittedPx || signal.price)).catch(() => null) : null;
    if (policy?.entry?.maxEstImpactBps !== undefined && est && est.estImpactBps > policy.entry.maxEstImpactBps) {
      log.warn(`Entry ABORTED by estimated depth impact for ${binanceSymbol}: ~${est.estImpactBps.toFixed(1)}bps > policy max ${policy.entry.maxEstImpactBps}bps`);
      return null;
    }

    // Idempotent client id for THIS submission (P1 namespace) — the handle
    // that lets an ambiguous POST be resolved by QUERY instead of resend.
    const clientOrderId = opts.clientOrderId ?? fapiClientOrderId(`open:${binanceSymbol}:${orderId}`);

    let activeOpenOrderId: any = null;
    try {
      // Binance leverage is configured per symbol, so set it before the order when needed.
      const currentLeverage = this.leverageBySymbol.get(binanceSymbol);
      if (currentLeverage !== leverage) {
        const ok = await this.setLeverage(binanceSymbol, leverage);
        if (!ok) return null;
      }

      // OPT-IN limit-chase entries (executionPolicy.ts). No policy for this
      // sleeve (the default) → the MARKET path below runs UNCHANGED.
      if (policy?.entry?.style === "limit_chase") {
        return await this.placeChasedEntryFapi(signal, qty, binanceSymbol, policy.entry, {
          orderId, submittedAt, submittedPx, estPx: est?.estPx,
        });
      }

      let result: any;
      try {
        result = await this.signedRequest("POST", "/fapi/v1/order", {
          symbol: binanceSymbol,
          side: signal.side.toUpperCase(),
          type: "MARKET",
          quantity: qty.toString(),
          newClientOrderId: clientOrderId,
        });
      } catch (postError: any) {
        // Pre-transmit denial by OUR OWN limiter: nothing reached the broker
        // — a proven non-submission, never an "unknown" to chase by query.
        if (postError?.rateLimitDenied) {
          log.warn(`Futures open for ${binanceSymbol} NOT submitted: ${postError.message}`);
          return null;
        }
        // Outcome taxonomy: a venue-confirmed rejection (4xx / body error
        // code) is PROVEN and flows to the outer catch as before. Anything
        // ambiguous after transmit (timeout, disconnect, 5xx, parse failure)
        // — a 429/418 AFTER transmit included (see isVenueRejection) — is
        // UNKNOWN: NEVER resend; resolve by QUERYING the idempotent
        // client id, else leave it in flight for reconciliation.
        if (this.isVenueRejection(postError)) throw postError;
        log.warn(`Futures open POST for ${binanceSymbol} ended ambiguous (${postError.message}) — resolving by client id ${clientOrderId}, never resending`);
        const resolved = await this.resolveFapiOrderByClientId(binanceSymbol, clientOrderId);
        if (resolved === "not_found") {
          log.warn(`Futures open for ${binanceSymbol} proven ABSENT (-2013 by client id) — submit never landed`);
          return null;
        }
        if (!resolved) {
          log.error(`Futures open outcome UNKNOWN for ${binanceSymbol} — left in flight for reconciliation, NOT resent (client id ${clientOrderId})`);
          return { outcome: "unknown", reason: `submit ambiguous (${postError.message}); client id resolution exhausted`, clientOrderId };
        }
        log.warn(`Futures open for ${binanceSymbol} RESOLVED by client id query (status=${resolved.status}) — no resend needed`);
        result = resolved;
      }

      if (result.code) {
        log.error(`Futures order rejected: ${result.code} ${result.msg} (${binanceSymbol} qty=${qty})`);
        // Filter violation → refresh the catalog once so the NEXT order is
        // correctly floored. Never resubmit THIS order (ambiguous POST).
        if (FILTER_REJECTION_CODES.has(Number(result.code))) {
          this.catalog.refresh().catch((e: any) => log.warn(`instrument catalog refresh failed: ${e.message}`));
        }
        return null;
      }

      // Futures testnet: avgPrice may be 0 initially, poll for fill
      let avgPrice = parseFloat(result.avgPrice) || 0;
      let filledQty = parseFloat(result.executedQty) || 0;
      let orderStatus = String(result.status ?? "");
      const extOrderId = result.orderId;
      activeOpenOrderId = extOrderId;

      // Poll for fill (futures testnet returns NEW, fills async)
      if (avgPrice === 0 && extOrderId) {
        for (let i = 0; i < 5; i++) {
          await this.sleep(this.pollDelayMs);
          const check = await this.signedRequest("GET", "/fapi/v1/order", {
            symbol: binanceSymbol,
            orderId: extOrderId.toString(),
          });
          orderStatus = String(check.status ?? orderStatus);
          if (check.status === "FILLED") {
            avgPrice = parseFloat(check.avgPrice) || signal.price;
            filledQty = parseFloat(check.executedQty) || qty;
            break;
          }
        }
      }
      // A MARKET order can be PARTIALLY_FILLED on testnet. Do not accept its
      // executedQty until the residual is canceled and terminal; then trust
      // positionRisk for the final broker quantity.
      if (extOrderId && orderStatus !== "FILLED") {
        const terminal = await this.cancelOrderAndConfirmTerminal(binanceSymbol, extOrderId);
        if (!terminal) throw new Error(`open order ${extOrderId} residual was not confirmed terminal`);
        const observed = (await this.getPositions()).find(p => p.symbol === binanceSymbol && Math.abs(p.positionAmt) > 0);
        if (!observed || observed.entryPrice <= 0) {
          activeOpenOrderId = null;
          log.warn(`Futures open ${binanceSymbol}: residual canceled but broker is flat`);
          return null;
        }
        avgPrice = observed.entryPrice;
        filledQty = Math.abs(observed.positionAmt);
      }
      // 2026-07-09 (O5): the order didn't confirm FILLED in the poll window.
      // DON'T fabricate a fill at signal.price (a phantom position at a wrong
      // price). Verify against the ACTUAL position; use its real entry if it's
      // there, else return null so nothing is recorded — syncBinanceFutures
      // recovers a genuinely-filled orphan within 60s.
      if (avgPrice === 0) {
        try {
          const pos = (await this.getPositions()).find((p) => p.symbol === binanceSymbol && Math.abs(p.positionAmt) > 0);
          if (pos && pos.entryPrice > 0) { avgPrice = pos.entryPrice; filledQty = Math.abs(pos.positionAmt); }
        } catch { /* fall through to null */ }
        if (avgPrice === 0) {
          const terminal = await this.cancelOrderAndConfirmTerminal(binanceSymbol, extOrderId);
          const posAfterCancel = (await this.getPositions().catch(() => [])).find((p) => p.symbol === binanceSymbol && Math.abs(p.positionAmt) > 0);
          if (posAfterCancel && posAfterCancel.entryPrice > 0) {
            avgPrice = posAfterCancel.entryPrice;
            filledQty = Math.abs(posAfterCancel.positionAmt);
          } else if (terminal) {
            activeOpenOrderId = null;
            log.warn(`Futures open ${binanceSymbol}: not filled; order canceled/terminal and flat — returning null`);
            return null;
          } else {
            throw new Error(`open order ${extOrderId ?? "?"} not confirmed filled, canceled, or flat`);
          }
        }
      }
      if (filledQty === 0) filledQty = qty;
      activeOpenOrderId = null;

      // Get entry commission from userTrades
      let entryCommission = 0;
      if (extOrderId) {
        await this.sleep(Math.min(300, this.pollDelayMs));
        try {
          const trades = await this.signedRequest("GET", "/fapi/v1/userTrades", {
            symbol: binanceSymbol,
            orderId: extOrderId.toString(),
            limit: "20",
          });
          if (Array.isArray(trades)) {
            for (const t of trades) {
              entryCommission += parseFloat(t.commission || "0");
              // Also use the actual fill price from trades if available
              if (avgPrice === signal.price && parseFloat(t.price) > 0) {
                avgPrice = parseFloat(t.price);
              }
            }
          }
        } catch (e: any) {
          // userTrades is eventually consistent; a confirmed live position is
          // still a valid fill and must not become an unmanaged null result.
          log.warn(`Futures open ${binanceSymbol}: commission settlement delayed (${e.message})`);
        }
      }

      log.trade(`📤 Binance Futures ${signal.side.toUpperCase()} ${filledQty} ${binanceSymbol} @ $${avgPrice.toFixed(4)} [${leverage}x] comm=$${entryCommission.toFixed(4)}`);

      return {
        id: orderId,
        symbol: signal.symbol,
        market: "crypto",
        side: signal.side,
        type: "market",
        quantity: filledQty,
        price: signal.price,
        status: "filled",
        externalId: result.orderId?.toString(),
        filledPrice: avgPrice,
        filledAt: result.updateTime,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        signal,
        openCommission: entryCommission,
        submittedAt,
        submittedPx,
        estPx: est?.estPx,
      };
    } catch (e: any) {
      if (activeOpenOrderId) await this.cancelOrderAndConfirmTerminal(binanceSymbol, activeOpenOrderId);
      log.error(`Futures order failed for ${binanceSymbol}: ${e.message}`);
      return null;
    }
  }

  /** True when the venue itself DEMONSTRABLY rejected the request: an HTTP
   *  4xx, or a Binance body error code on an otherwise-OK response. A 5xx or
   *  transport-level failure is NOT a rejection — the command may have been
   *  processed (outcome unknown). */
  private isVenueRejection(e: any): boolean {
    const hs = e?.httpStatus;
    // 429/418 are RATE-LIMIT responses, not proof the venue rejected the
    // command — the request WAS transmitted and Binance may have processed
    // it before throttling the response. OrderOutcome taxonomy: ambiguous
    // after transmit → resolve by idempotent-client-id QUERY, never resend.
    if (hs === 429 || hs === 418) return false;
    if (hs !== undefined) return hs >= 400 && hs < 500;
    return Number.isFinite(e?.code); // body-level venue error on HTTP 200
  }

  /** Resolve an ambiguous POST by QUERY on its idempotent client id (never a
   *  resend). Returns the order payload, "not_found" (proven never landed),
   *  or null (still unknown after bounded retries). */
  private async resolveFapiOrderByClientId(binanceSymbol: string, clientOrderId: string): Promise<any | "not_found" | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const o = await this.signedRequest("GET", "/fapi/v1/order", { symbol: binanceSymbol, origClientOrderId: clientOrderId });
        if (o?.orderId) return o;
      } catch (qe: any) {
        if (qe?.code === -2013) return "not_found"; // "Order does not exist"
      }
      await this.sleep(this.pollDelayMs);
    }
    return null;
  }

  // ── OPT-IN limit-chase entry (executionPolicy.ts) ────────────────────
  //
  // Only reachable when resolveExecutionPolicy(accountId).entry is
  // configured — the default market path is unchanged (fixed by test).

  private async fapiChaseVenue(binanceSymbol: string, side: "buy" | "sell", seed: string): Promise<ChaseVenue> {
    const tick = await this.resolvePriceTick(binanceSymbol);
    const pxDecimals = tick > 0 ? decimalPlaces(tick.toString()) : FALLBACK_DECIMALS;
    const { step, minQty, decimals } = await this.resolveQtyStep(binanceSymbol);
    const internal = this.reverseSymbolMap[binanceSymbol];
    return {
      minQty: minQty > 0 ? minQty : undefined,
      refPrice: async () => (internal ? (await this.getExecutableQuote(internal, side))?.price ?? 0 : 0),
      // PRICE_FILTER: price must sit on the tick grid; round PASSIVELY
      // (buy down, sell up) so rounding never crosses further than intended.
      roundPrice: (px, s) => {
        if (!(tick > 0)) return Number(px.toFixed(pxDecimals));
        const steps = s === "buy" ? Math.floor(px / tick) : Math.ceil(px / tick);
        return Number((steps * tick).toFixed(pxDecimals));
      },
      place: async (px, qty, attempt) => {
        const q = this.floorQty(qty, step, decimals);
        if (!(q > 0)) return { ok: false, outcome: "proven_failed", reason: "chase qty floored to zero" };
        const cid = fapiClientOrderId(`${seed}:${attempt}`);
        try {
          const result = await this.signedRequest("POST", "/fapi/v1/order", {
            symbol: binanceSymbol, side: side.toUpperCase(), type: "LIMIT",
            timeInForce: "GTC", price: px.toFixed(pxDecimals), quantity: q.toString(),
            newClientOrderId: cid,
          });
          if (!result?.orderId) return { ok: false, outcome: "unknown", reason: "no orderId in response" };
          return { ok: true, ref: String(result.orderId) };
        } catch (e: any) {
          // Own-limiter denial = never transmitted = proven; a venue 429
          // after transmit stays ambiguous (isVenueRejection excludes it).
          if (e?.rateLimitDenied) return { ok: false, outcome: "proven_failed", reason: e.message };
          if (this.isVenueRejection(e)) return { ok: false, outcome: "proven_failed", reason: e.message };
          // Ambiguous transmit: resolve by the idempotent client id — never a blind resend.
          try {
            const check = await this.signedRequest("GET", "/fapi/v1/order", { symbol: binanceSymbol, origClientOrderId: cid });
            if (check?.orderId) return { ok: true, ref: String(check.orderId) };
          } catch (qe: any) {
            if (qe?.code === -2013) return { ok: false, outcome: "proven_failed", reason: "order does not exist (never landed)" };
          }
          return { ok: false, outcome: "unknown", reason: e?.message ?? "transport error" };
        }
      },
      fetch: async (ref) => {
        try {
          const o = await this.signedRequest("GET", "/fapi/v1/order", { symbol: binanceSymbol, orderId: ref });
          const filledQty = parseFloat(o?.executedQty ?? "0") || 0;
          const filledAvgPx = parseFloat(o?.avgPrice ?? "0") || 0;
          const status = String(o?.status ?? "");
          if (status === "FILLED") return { status: "filled", filledQty, filledAvgPx };
          if (["CANCELED", "EXPIRED", "REJECTED"].includes(status)) return { status: "terminal", filledQty, filledAvgPx };
          return { status: "working", filledQty, filledAvgPx };
        } catch { return null; }
      },
      cancel: async (ref) => {
        try { await this.signedRequest("DELETE", "/fapi/v1/order", { symbol: binanceSymbol, orderId: ref }); } catch {}
        try {
          const o = await this.signedRequest("GET", "/fapi/v1/order", { symbol: binanceSymbol, orderId: ref });
          const status = String(o?.status ?? "");
          return {
            confirmed: ["CANCELED", "EXPIRED", "REJECTED", "FILLED"].includes(status),
            filledQty: parseFloat(o?.executedQty ?? "0") || 0,
            filledAvgPx: parseFloat(o?.avgPrice ?? "0") || 0,
          };
        } catch { return { confirmed: false, filledQty: 0, filledAvgPx: 0 }; }
      },
    };
  }

  private async placeChasedEntryFapi(
    signal: Signal,
    qty: number,
    binanceSymbol: string,
    cfg: EntryExecutionConfig,
    ctx: { orderId: string; submittedAt: number; submittedPx: number; estPx?: number },
  ): Promise<Order | UnknownOrderResult | null> {
    const seed = `chase:${binanceSymbol}:${ctx.orderId}`;
    const venue = await this.fapiChaseVenue(binanceSymbol, signal.side, seed);
    const chase = await chaseLimit(venue, {
      side: signal.side, qty,
      offsetBps: cfg.offsetBps, refreshThresholdBps: cfg.refreshThresholdBps,
      maxReprices: cfg.maxReprices, maxDistanceBps: cfg.maxDistanceBps,
      timeoutMs: cfg.timeoutMs, pollIntervalMs: cfg.pollIntervalMs,
    });
    if (chase.outcome === "unknown") {
      log.error(`Chased entry outcome UNKNOWN for ${binanceSymbol} (${chase.reason}) — left to reconciliation, NOT resent`);
      return { outcome: "unknown", reason: chase.reason ?? "chase unresolved", clientOrderId: fapiClientOrderId(`${seed}:0`) };
    }
    if (chase.outcome === "proven_failed" || chase.filledQty <= 0) {
      log.warn(`Chased entry for ${binanceSymbol} did not fill: ${chase.reason}`);
      return null;
    }
    // Minimum-fill guard (see EntryExecutionConfig.minFillFraction): a sliver
    // is not a position. Below the threshold the dust is FLATTENED and the
    // entry reported as a plain rejection — never left on the book, because an
    // untracked broker position is the orphan class this repo keeps paying for.
    // If the flatten itself fails we deliberately fall through and return the
    // dust as a real order: a recorded small position beats an invisible one.
    const minFraction = cfg.minFillFraction ?? MIN_ENTRY_FILL_FRACTION;
    if (chase.filledQty < qty * minFraction) {
      const pct = ((chase.filledQty / qty) * 100).toFixed(1);
      log.warn(`Chased entry for ${binanceSymbol} filled only ${chase.filledQty}/${qty} (${pct}% < ${(minFraction * 100).toFixed(0)}% floor) — flattening the dust and rejecting the entry`);
      try {
        const flat = await this.closePosition(signal.symbol, chase.filledQty, signal.side, { skipOrderCleanup: true });
        if (flat.success) return null;
        log.error(`🚨 dust flatten for ${binanceSymbol} did NOT succeed (${flat.reason ?? "unknown"}) — recording the ${pct}% fill as a position so it stays tracked and stop-protected`);
      } catch (e: any) {
        log.error(`🚨 dust flatten for ${binanceSymbol} threw (${e?.message ?? e}) — recording the ${pct}% fill as a position so it stays tracked and stop-protected`);
      }
    }
    // Commission across every chase order (userTrades is eventually
    // consistent — best-effort, same as the market path's contract).
    let entryCommission = 0;
    for (const ref of chase.orderRefs) {
      try {
        const trades = await this.signedRequest("GET", "/fapi/v1/userTrades", { symbol: binanceSymbol, orderId: ref, limit: "20" });
        if (Array.isArray(trades)) for (const t of trades) entryCommission += parseFloat(t.commission || "0");
      } catch { /* best-effort */ }
    }
    log.trade(`📤 Chased LIMIT ${signal.side.toUpperCase()} ${chase.filledQty}/${qty} ${binanceSymbol} @ ~$${chase.filledAvgPx.toFixed(4)} (${chase.repricesUsed} reprices) comm=$${entryCommission.toFixed(4)}`);
    const now = Date.now();
    return {
      id: ctx.orderId,
      symbol: signal.symbol,
      market: "crypto",
      side: signal.side,
      type: "limit",
      quantity: chase.filledQty,
      price: signal.price,
      status: "filled",
      externalId: chase.orderRefs[chase.orderRefs.length - 1],
      filledPrice: chase.filledAvgPx,
      filledAt: now,
      createdAt: ctx.submittedAt,
      updatedAt: now,
      signal,
      openCommission: entryCommission,
      submittedAt: ctx.submittedAt,
      submittedPx: ctx.submittedPx,
      estPx: ctx.estPx,
    };
  }

  /**
   * v8: broker-native stop-loss for the momentum sleeve. Places a
   * STOP_MARKET closePosition=true order so the stop fires even if the bot
   * is down. Best-effort/fail-open: checkAllStopLoss (15s) is the backstop.
   */
  async placeStopMarketClose(alpacaSymbol: string, positionSide: "buy" | "sell", stopPrice: number, quantity?: number, clientOrderId?: string): Promise<boolean> {
    if (!this.connected) return false;
    // Serialized with any concurrent open/close on the same symbol: placing
    // a stop while a close is mid-flight is the cancel-vs-place race the
    // symbol lock exists for. Timeout = explicit false (nothing transmitted);
    // the ensure pass retries on its next cycle.
    return await symbolLocks.withLock("binance_fapi", alpacaSymbol, { timeoutMs: this.lockTimeoutMs, label: "placeStopMarketClose" },
      () => this.placeStopMarketCloseUnderLock(alpacaSymbol, positionSide, stopPrice, quantity, clientOrderId),
      () => {
        log.warn(`placeStopMarketClose ${alpacaSymbol}: symbol mutation lock not acquired — stop NOT placed (another mutation is in flight)`);
        return false;
      });
  }

  private async placeStopMarketCloseUnderLock(alpacaSymbol: string, positionSide: "buy" | "sell", stopPrice: number, quantity?: number, clientOrderId?: string): Promise<boolean> {
    const binanceSymbol = this.symbolMap[alpacaSymbol];
    if (!binanceSymbol || !(stopPrice > 0)) return false;
    const tick = await this.resolvePriceTick(binanceSymbol);
    // FAPI's PRICE_FILTER rejects any price that isn't an exact multiple of
    // tickSize (e.g. 0.25) — flooring to a DECIMAL PLACE count (old
    // behavior: stopPrice.toFixed(decimals)) still lets non-multiples like
    // "90.37" through when tickSize is 0.25. Floor to the tick itself, same
    // as qty flooring against LOT_SIZE step.
    const flooredPx = tick > 0 ? floorToStep(stopPrice, tick) : stopPrice;
    const pxDecimals = tick > 0 ? decimalPlaces(tick.toString()) : FALLBACK_DECIMALS;
    // Every stop is stamped (P1, 2026-07-29): an anonymous stop can never be
    // attributed later, which makes it indistinguishable from a manually
    // placed protection (see cancelAllOrders). A caller-provided id (cert
    // scripts, reconcile paths) is used verbatim — callers own their
    // namespace.
    if (!clientOrderId) {
      clientOrderId = fapiClientOrderId(`stop:${binanceSymbol}:${positionSide}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`);
    }
    try {
      const side = positionSide === "buy" ? "SELL" : "BUY"; // stop closes the position
      const stopPx = flooredPx.toFixed(pxDecimals);
      const params: Record<string, string> = {
        symbol: binanceSymbol,
        side,
        type: "STOP_MARKET",
        stopPrice: stopPx,
        workingType: "MARK_PRICE",
        reduceOnly: "true",
      };
      if (clientOrderId) params.newClientOrderId = clientOrderId;
      if (quantity && quantity > 0) {
        params.quantity = String(quantity);
      } else {
        params.closePosition = "true"; // fallback: whole-position stop
      }
      let result: any;
      try {
        result = await this.signedRequest("POST", "/fapi/v1/order", params, "protect");
      } catch (e: any) {
        if (e?.code !== -4120) throw e;
        // This API build rejects conditional orders on /fapi/v1/order
        // ("use the Algo Order API"). Verified working shape (2026-07-10):
        // POST /fapi/v1/algoOrder, algoType=CONDITIONAL, triggerPrice.
        const algoParams: Record<string, string> = {
          algoType: "CONDITIONAL",
          symbol: binanceSymbol,
          side,
          type: "STOP_MARKET",
          triggerPrice: stopPx,
          reduceOnly: "true",
          workingType: "MARK_PRICE",
        };
        if (clientOrderId) algoParams.clientAlgoId = clientOrderId;
        if (quantity && quantity > 0) algoParams.quantity = String(quantity);
        else algoParams.closePosition = "true";
        result = await this.signedRequest("POST", "/fapi/v1/algoOrder", algoParams, "protect");
      }
      if (result.code) {
        log.warn(`STOP_MARKET rejected for ${binanceSymbol}: ${result.code} ${result.msg}`);
        return false;
      }
      log.info(`🛡 STOP_MARKET set ${binanceSymbol} @ $${stopPx}`);
      return true;
    } catch (e: any) {
      log.warn(`STOP_MARKET failed for ${binanceSymbol}: ${e.message}`);
      return false;
    }
  }

  /** Cancel THIS bot's open (conditional) orders for a symbol — used to
   *  clear the native SL when a position of OURS closes. Fail-open.
   *
   *  NEVER a blind `DELETE /fapi/v1/allOpenOrders` sweep (P1, 2026-07-29):
   *  the old sweep canceled EVERY open order on the symbol — including
   *  manually-placed protective STOP_MARKETs the bot doesn't own — and was
   *  reachable every 15s via AccountManager's stop-loss loop. Targeted
   *  cancellation by exact orderId only, same hardening COIN-M already had
   *  (isOwnedClientId there).
   *
   *  Policy per open order (regular AND algo stores):
   *   - ours (isBotFapiClientId — any `uc-*` stamp, including the legacy
   *     instance-stamped `uc-fapi-<hostname>-…` format): always canceled;
   *   - anonymous (pre-namespace legacy, manual): reduceOnly STOP orders
   *     only, and only when `aggregateFlat: true` — the caller POSITIVELY
   *     confirmed the aggregate broker position is flat, so every remaining
   *     reduceOnly stop protects nothing and is purely a hazard to a FUTURE
   *     position, whoever placed it (this is also what retires pre-namespace
   *     legacy stops at position turnover). Never a possible entry order.
   *  A failed enumeration cancels NOTHING — unknown is never "no open
   *  orders"; it logs and leaves state for a later pass (same fail-open
   *  contract as before, but never destructive on unknown state). */
  async cancelAllOrders(alpacaSymbol: string, opts: { aggregateFlat?: boolean } = {}): Promise<void> {
    // Locked wrapper over the UNLOCKED core: closePosition (which already
    // holds this symbol's lock) calls the core directly — the lock is NOT
    // reentrant, by design (symbolLock.ts). External callers (adapters,
    // reconcilers) get the serialized wrapper. Timeout = skip; every caller
    // is a periodic cleanup pass that retries on its next cycle.
    await symbolLocks.withLock("binance_fapi", alpacaSymbol, { timeoutMs: this.lockTimeoutMs, label: "cancelAllOrders" },
      () => this.cancelAllOrdersCore(alpacaSymbol, opts),
      () => {
        log.warn(`cancelAllOrders ${alpacaSymbol}: symbol mutation lock not acquired — nothing canceled (another mutation is in flight)`);
      });
  }

  private async cancelAllOrdersCore(alpacaSymbol: string, opts: { aggregateFlat?: boolean } = {}): Promise<void> {
    if (!this.connected) return;
    const binanceSymbol = this.symbolMap[alpacaSymbol];
    if (!binanceSymbol) return;

    const isReduceOnlyStop = (type: unknown, reduceOnly: unknown) =>
      String(type ?? "").toUpperCase().includes("STOP") &&
      (reduceOnly === true || String(reduceOnly).toLowerCase() === "true");
    const shouldCancel = (clientId: unknown, type: unknown, reduceOnly: unknown): boolean => {
      if (isBotFapiClientId(clientId as any)) return true; // ours, by stamp
      if (!isReduceOnlyStop(type, reduceOnly)) return false; // never touch a possible entry order
      return opts.aggregateFlat === true;
    };

    try {
      const open = await this.signedRequest("GET", "/fapi/v1/openOrders", { symbol: binanceSymbol }, "protect");
      if (!Array.isArray(open)) throw new Error(open?.msg ?? "non-array response");
      for (const o of open) {
        if (!shouldCancel(o?.clientOrderId, o?.type, o?.reduceOnly)) continue;
        try {
          await this.signedRequest("DELETE", "/fapi/v1/order", { symbol: binanceSymbol, orderId: String(o.orderId) }, "protect");
        } catch (e: any) {
          log.warn(`cancel order ${o?.orderId} failed for ${binanceSymbol}: ${e.message}`);
        }
      }
    } catch (e: any) {
      log.warn(`cancelAllOrders (open orders) failed for ${binanceSymbol}: ${e.message}`);
    }

    // Also the ALGO store (the -4120 fallback path parks stops there). A
    // dangling reduceOnly stop can't open exposure, but it would close a
    // FUTURE position at a stale trigger — cleared under the same policy.
    try {
      const raw = await this.signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: binanceSymbol }, "protect");
      const open = Array.isArray(raw) ? raw : (Array.isArray(raw?.orders) ? raw.orders : null);
      if (open === null) throw new Error(raw?.msg ?? "non-array response");
      for (const o of open) {
        if (!o?.algoId) continue;
        if (!shouldCancel(o?.clientAlgoId, o?.orderType ?? o?.type, o?.reduceOnly)) continue;
        try {
          await this.signedRequest("DELETE", "/fapi/v1/algoOrder", { symbol: binanceSymbol, algoId: String(o.algoId) }, "protect");
        } catch (e: any) {
          log.warn(`cancel algo order ${o?.algoId} failed for ${binanceSymbol}: ${e.message}`);
        }
      }
    } catch (e: any) {
      log.warn(`cancel algo orders failed for ${binanceSymbol}: ${e.message}`);
    }
  }

  // ── Close position ────────────────────────

  async closePosition(symbol: string, quantity: number, side: "buy" | "sell", opts: { skipOrderCleanup?: boolean; stopConfirm?: StopCloseConfirm } = {}): Promise<{ success: boolean; filledPrice: number; commission: number; realizedPnl: number; exitTime?: number; orderId?: string; submittedAt?: number; submittedPx?: number; filledQty?: number; outcome?: OrderOutcome; estPx?: number; reason?: string }> {
    // Stop-triggered closes only (OPEN.md P1, the 2026-07-20 LINK ghost
    // stop): confirm the trigger against MAINNET before transmitting — same
    // observe/enforce plausibility pattern as src/market/plausibility.ts,
    // see mainnetStopConfirm.ts for the fail-open rationale. Runs BEFORE the
    // symbol lock and before ANY mutation (order cleanup included: a blocked
    // ghost stop must leave the broker-native stop untouched). A block is a
    // pre-transmit proven_failed — the 15s loop re-evaluates and retries.
    if (opts.stopConfirm) {
      const gate = await this.confirmStopCloseAgainstMainnet(symbol, side, opts.stopConfirm);
      if (!gate.proceed) {
        return { success: false, filledPrice: 0, commission: 0, realizedPnl: 0, reason: gate.reason, outcome: "proven_failed" as OrderOutcome };
      }
    }
    // Per-(venue,symbol) mutation lock: the 15s stop-loss loop and an engine
    // rebalance can both reach here for the SAME symbol; without the lock
    // both read the same broker qty and both transmit a reduceOnly close.
    // Serialized, the second caller's pre-check re-reads the broker AFTER
    // the first close and sees the truth (flat → proven "already flat"). A
    // lock timeout is an explicit pre-transmit failure; the loop retries.
    return await symbolLocks.withLock("binance_fapi", symbol, { timeoutMs: this.lockTimeoutMs, label: "closePosition" },
      () => this.closePositionUnderLock(symbol, quantity, side, opts),
      () => ({ success: false, filledPrice: 0, commission: 0, realizedPnl: 0, reason: "symbol lock timeout (another mutation in flight)", outcome: "proven_failed" as OrderOutcome }));
  }

  /** Injectable network seam for the mainnet confirmation (tests override;
   *  the module fn returns 0 on any failure — never throws). */
  private mainnetMarkPrice: (nativeSymbol: string) => Promise<number> = fetchMainnetMarkPrice;

  /** Counters for measuring the observe-mode would-block rate before
   *  flipping BINANCE_STOP_CONFIRM_MODE=enforce (read via getStopConfirmStats). */
  private stopConfirmStats = { checked: 0, confirmed: 0, unavailable: 0, wouldBlock: 0, blocked: 0 };
  getStopConfirmStats(): { checked: number; confirmed: number; unavailable: number; wouldBlock: number; blocked: number } {
    return { ...this.stopConfirmStats };
  }

  /** Mainnet confirmation for a stop-triggered close (see mainnetStopConfirm.ts
   *  header for the incident and the fail-open decision). One public
   *  premiumIndex call (weight 1) on the RARE stop-close path, taken from the
   *  shared venue limiter as class "protect" — a close-path read must never
   *  queue behind background traffic; a limiter denial is just another
   *  "unavailable" ⇒ fail-open. Mainnet 429s are NOT fed into the testnet
   *  venue's penalty window: separate host, and the failed read already
   *  fails open here. Every non-confirmed verdict logs a distinguishable
   *  token (STOP_CONFIRM_WOULD_BLOCK / STOP_CONFIRM_BLOCKED /
   *  STOP_CONFIRM_UNAVAILABLE) so the rate is measurable from logs alone. */
  private async confirmStopCloseAgainstMainnet(symbol: string, side: "buy" | "sell", sc: StopCloseConfirm): Promise<{ proceed: boolean; reason?: string }> {
    const nativeSymbol = this.symbolMap[symbol];
    if (!nativeSymbol) return { proceed: true }; // unmapped → closePosition's own fail path decides
    this.stopConfirmStats.checked++;
    let mainnetPrice = 0;
    try {
      const acq = await this.limiter.acquire("protect");
      if (acq.ok) mainnetPrice = await this.mainnetMarkPrice(nativeSymbol);
    } catch { /* unavailable → fail-open below */ }
    const trigger = Number.isFinite(sc.triggerPrice) && (sc.triggerPrice as number) > 0 ? ` trigger=${sc.triggerPrice}` : "";
    const verdict = checkStopAgainstMainnet({ side, entryPrice: sc.entryPrice, stopLossPct: sc.stopLossPct, mainnetPrice });
    if (verdict.kind === "confirmed") {
      this.stopConfirmStats.confirmed++;
      return { proceed: true };
    }
    if (verdict.kind === "unavailable") {
      this.stopConfirmStats.unavailable++;
      log.warn(`STOP_CONFIRM_UNAVAILABLE ${symbol}:${trigger} ${verdict.reason} — proceeding FAIL-OPEN (no evidence of disagreement; a mainnet outage must never leave a stop unexecuted)`);
      return { proceed: true };
    }
    // rejected: a VALID mainnet price says the stop is not breached there.
    if (stopConfirmMode() === "enforce") {
      this.stopConfirmStats.blocked++;
      log.error(`⛔ STOP_CONFIRM_BLOCKED ${symbol}:${trigger} ${verdict.detail} — stop close NOT transmitted (enforce); loop re-evaluates in 15s`);
      return { proceed: false, reason: `stop_confirm_rejected: ${verdict.detail}` };
    }
    this.stopConfirmStats.wouldBlock++;
    log.warn(`STOP_CONFIRM_WOULD_BLOCK ${symbol}:${trigger} ${verdict.detail} — observe mode, close proceeds unchanged`);
    return { proceed: true };
  }

  private async closePositionUnderLock(symbol: string, quantity: number, side: "buy" | "sell", opts: { skipOrderCleanup?: boolean } = {}): Promise<{ success: boolean; filledPrice: number; commission: number; realizedPnl: number; exitTime?: number; orderId?: string; submittedAt?: number; submittedPx?: number; filledQty?: number; outcome?: OrderOutcome; estPx?: number; reason?: string }> {
    // Outcome taxonomy on the failure paths: "proven_failed" only when the
    // failure is demonstrable (local validation, venue rejection, confirmed
    // flat/terminal); anything ambiguous after a close order was (possibly)
    // transmitted is "unknown" — the close may still fill. Callers must not
    // read unknown as "nothing happened"; retrying a close stays safe only
    // because the pre-check re-reads the broker position (flat → fail here).
    const fail = (reason?: string, outcome: OrderOutcome = "proven_failed") =>
      ({ success: false, filledPrice: 0, commission: 0, realizedPnl: 0, reason, outcome } as any);
    if (!this.connected) return fail("disconnected");

    const binanceSymbol = this.symbolMap[symbol];
    if (!binanceSymbol) return fail("no symbol mapping");

    // Futures: to close long -> SELL, to close short -> BUY
    const closeSide = side === "buy" ? "SELL" : "BUY";
    const closeSideLabel: "buy" | "sell" = side === "buy" ? "sell" : "buy";
    // No minQty/minNotional gate on a close — reduceOnly must never be
    // blocked by the entry filters; only the step/decimals are applied.
    // When no spec is available, do NOT floor to an arbitrary fallback
    // precision — that can zero out a real broker-reported qty (see
    // preserveExactQty). specFound=false is exclusive to closePosition;
    // placeOrder's entry path fails closed on the same condition.
    const { step, decimals: specDecimals, specFound } = await this.resolveQtyStep(binanceSymbol);
    const flooredSpec = specFound ? this.floorQty(quantity, step, specDecimals) : 0;
    // A close is risk-REDUCING: a legacy position smaller than the CURRENT
    // step (e.g. Binance widened LOT_SIZE after the position was opened)
    // must never silently floor to zero and no-op the close. Fall back to
    // the exact broker-reported quantity in that case too, same as the
    // no-spec path — never a blocked risk-reducing close.
    const { qty, decimals } = specFound && flooredSpec > 0
      ? { qty: flooredSpec, decimals: specDecimals }
      : this.preserveExactQty(quantity);
    if (qty <= 0) return fail("non-positive close qty");

    // Fresh executable touch before the close (bid for sells, ask for buys).
    // Failure is logged once and does not block the close.
    const quote = await this.getExecutableQuote(symbol, closeSideLabel, "protect");
    const submittedAt = Date.now();
    const submittedPx = quote?.price ?? 0;
    if (!quote) log.warn(`No fresh executable quote for ${symbol} close; fill telemetry skipped`);
    // Depth-VWAP estimate for est-vs-realized telemetry (best-effort; gated
    // on the quote — without one recordFill is skipped anyway).
    const est = quote ? await this.estimateDepthImpact(symbol, closeSideLabel, qty * (submittedPx || 0)).catch(() => null) : null;

    // A successful position read gives us a second confirmation path when the
    // testnet order endpoint lags. If it is unavailable, FILLED remains enough.
    let positionBefore: number | null = null;
    try {
      const before = (await this.getPositions()).find(p => p.symbol === binanceSymbol);
      positionBefore = Math.abs(before?.positionAmt ?? 0);
      if (positionBefore === 0) {
        // Aggregate positively confirmed flat — safe to clear anonymous
        // leftovers too (see cancelAllOrders policy). Core, not the locked
        // wrapper: this body already holds the symbol lock.
        if (!opts.skipOrderCleanup) await this.cancelAllOrdersCore(symbol, { aggregateFlat: true });
        return fail("position already flat"); // proven: confirmed flat broker read
      }
    } catch (e: any) {
      log.warn(`Futures close pre-check unavailable for ${binanceSymbol}: ${e.message}`);
    }

    let activeCloseOrderId: any = null;
    let transmitted = false;
    try {
      const result = await this.signedRequest("POST", "/fapi/v1/order", {
        symbol: binanceSymbol,
        side: closeSide,
        type: "MARKET",
        quantity: qty.toString(),
        reduceOnly: "true",
      }, "protect");
      transmitted = true;

      if (result.code) {
        log.error(`Futures close rejected: ${result.code} ${result.msg}`);
        return fail(`venue rejection ${result.code}`);
      }

      const extOrderId = result.orderId;
      activeCloseOrderId = extOrderId;
      let avgPrice = parseFloat(result.avgPrice) || 0;
      let filled = result.status === "FILLED";
      let reductionVerified = false;
      let positionAfter = positionBefore ?? null;
      const deadline = Date.now() + this.closePollTimeoutMs;

      while (Date.now() < deadline && !filled && !reductionVerified) {
        await this.sleep(this.pollDelayMs);
        if (extOrderId) {
          const check = await this.signedRequest("GET", "/fapi/v1/order", { symbol: binanceSymbol, orderId: extOrderId.toString() }, "protect");
          if (check.status === "FILLED") {
            filled = true;
            avgPrice = parseFloat(check.avgPrice) || avgPrice;
          }
        }
        if (positionBefore !== null) {
          try {
            const after = (await this.getPositions()).find(p => p.symbol === binanceSymbol);
            positionAfter = Math.abs(after?.positionAmt ?? 0);
            const tolerance = 10 ** -decimals / 2;
            reductionVerified = positionAfter < positionBefore
              && positionAfter <= Math.max(0, positionBefore - qty) + tolerance;
          } catch (e: any) {
            // FILLED is already confirmed via order status above; a broker-position
            // re-check failure here is secondary and must not undo that confirmation.
            // Let the loop exit and the post-loop settlement (with its own defensive
            // getPositions().catch) resolve positionAfter + native stop cleanup.
            if (filled) break;
            log.warn(`Futures close ${binanceSymbol}: position re-check failed mid-poll: ${e.message}`);
          }
        }
      }

      // A stale order-status read is acceptable only when the actual broker
      // position moved by the requested amount. A transport failure is not an
      // empty account and therefore cannot confirm anything.
      if (!filled && !reductionVerified) {
        log.warn(`Futures close ${binanceSymbol}: accepted but not confirmed FILLED or reduced`);
        const terminal = await this.cancelOrderAndConfirmTerminal(binanceSymbol, extOrderId);
        activeCloseOrderId = null;
        // Confirmed terminal = proven no-close; unconfirmed = the order may
        // still fill (unknown — resolved by the pre-check/reconciliation).
        return fail("accepted but not confirmed filled or reduced", terminal ? "proven_failed" : "unknown");
      }
      activeCloseOrderId = null;
      const positionTolerance = 10 ** -decimals / 2;
      // Only cancel the native stop when flatness is POSITIVELY confirmed.
      // positionAfter === null means "unknown" (broker read failed) — never
      // treat unknown as flat: a residual reduceOnly stop is inert, but
      // canceling it while the position is genuinely still open is not.
      if (!opts.skipOrderCleanup && positionAfter !== null && positionAfter <= positionTolerance) await this.cancelAllOrdersCore(symbol, { aggregateFlat: true });

      // Get realized PnL + commissions from userTrades for this order
      let commission = 0;
      let realizedPnl = 0;
      let settledQty = 0;
      let settledNotional = 0;
      let exitTime = 0;
      if (extOrderId) {
        const trades = await this.signedRequest("GET", "/fapi/v1/userTrades", {
          symbol: binanceSymbol,
          orderId: extOrderId.toString(),
          limit: "20",
        }, "protect");
        if (!Array.isArray(trades)) {
          log.warn(`Futures close ${binanceSymbol}: fill settlement unavailable (${trades?.msg ?? "non-array response"})`);
          // The close DID happen (filled/reduced confirmed above) but its
          // accounting is unreadable — unknown, never a proven no-close.
          return fail("fill settlement unavailable", "unknown");
        }
        for (const t of trades) {
          const fillQty = parseFloat(t.qty || "0");
          const fillPrice = parseFloat(t.price || "0");
          commission += parseFloat(t.commission || "0");
          realizedPnl += parseFloat(t.realizedPnl || "0");
          if (fillQty > 0 && fillPrice > 0) {
            settledQty += fillQty;
            settledNotional += fillQty * fillPrice;
            exitTime = Math.max(exitTime, parseInt(t.time || "0") || 0);
          }
        }
      }

      if (settledQty > 0) avgPrice = settledNotional / settledQty;
      const tolerance = positionTolerance;
      const expectedQty = Math.min(qty, positionBefore ?? qty);
      if (!(avgPrice > 0) || settledQty + tolerance < expectedQty) {
        log.warn(`Futures close ${binanceSymbol}: broker state changed but fill price/quantity is not settled`);
        return fail("fill settlement incomplete", "unknown");
      }

      if (filled && (positionAfter === null || positionAfter === positionBefore)) {
        try {
          const after = await this.getPositions();
          positionAfter = Math.abs(after.find(p => p.symbol === binanceSymbol)?.positionAmt ?? 0);
        } catch {
          positionAfter = null; // unknown — do NOT assume flat
        }
      }
      const brokerFlat = positionAfter !== null && positionAfter <= tolerance;
      if (!opts.skipOrderCleanup) {
        if (brokerFlat) {
          await this.cancelAllOrdersCore(symbol, { aggregateFlat: true });
        } else if (positionAfter !== null) {
          // OUR row's share is confirmed closed but the aggregate still
          // holds something (a manual/unknown position) — clear only our
          // stamped stops, never anonymous ones. This also covers the direct
          // AccountManager 15s stop-loss-loop caller, which never went
          // through the adapter's cleanup. positionAfter === null (unknown)
          // still cancels NOTHING — unknown is never flat.
          await this.cancelAllOrdersCore(symbol);
        }
      }
      log.trade(`📤 Binance Futures CLOSE ${closeSide} ${qty} ${binanceSymbol} @ $${avgPrice.toFixed(4)} | PnL=$${realizedPnl.toFixed(4)} comm=$${commission.toFixed(4)}`);
      return { success: true, filledPrice: avgPrice, commission, realizedPnl, exitTime: exitTime || undefined, orderId: extOrderId?.toString(), submittedAt, submittedPx, filledQty: settledQty > 0 ? settledQty : qty, outcome: "confirmed", estPx: est?.estPx };
    } catch (e: any) {
      let terminal = false;
      if (activeCloseOrderId) terminal = await this.cancelOrderAndConfirmTerminal(binanceSymbol, activeCloseOrderId);
      log.error(`Futures close failed for ${binanceSymbol}: ${e.message}`);
      // Proven only when the venue itself rejected the POST (nothing was
      // ever live), our own limiter denied it BEFORE transmit, or the
      // transmitted order is confirmed terminal; every other path here is
      // ambiguous — unknown, never an implicit rejection.
      const proven = terminal || (!transmitted && (this.isVenueRejection(e) || e?.rateLimitDenied === true));
      return fail(e.message, proven ? "proven_failed" : "unknown");
    }
  }

  // ── Account info ──────────────────────────

  /**
   * Margin-only read (reviewer P1, 2026-07-18): the OLD getBalance ALSO
   * awaited a per-asset assetIndex valuation (getAccountTotal below) on every
   * call, so a slow/rate-limited asset-index request blocked margin sync +
   * position reconciliation for every crypto trade. getBalance now NEVER
   * calls getUsdRate/assetIndex — it is a single fast /fapi/v2/account read,
   * cross-checked against its own root totals. Use getAccountTotal() for the
   * full USD-valued account total (binance_main).
   */
  async getBalance(): Promise<{ marginEquity: number; marginCash: number; wallet: number; unrealizedPnl: number }> {
    if (!this.connected) throw new Error("Binance is not connected");
    const data = await this.signedRequest("GET", "/fapi/v2/account");
    if (data?.code && data.code !== 0) throw new Error(`Binance account ${data.code}: ${data.msg ?? "error"}`);
    return this.computeMarginBalance(data);
  }

  /**
   * Full USD-valued account total (Binance UI's "Account total"), separate
   * from getBalance so its assetIndex fan-out never blocks margin sync. Signed
   * /fapi/v2/account (a second, independent read from getBalance — Binance
   * doesn't cache the response), cross-checked via the same margin helper,
   * then every non-zero asset in `assets[]` is priced via getUsdRate (stables
   * 1:1, else the asset index). Fails CLOSED to null — never a partial sum —
   * when `assets` isn't an array or any non-stable asset can't be priced.
   */
  async getAccountTotal(): Promise<{ equity: number; cash: number } | null> {
    if (!this.connected) throw new Error("Binance is not connected");
    const data = await this.signedRequest("GET", "/fapi/v2/account");
    if (data?.code && data.code !== 0) throw new Error(`Binance account ${data.code}: ${data.msg ?? "error"}`);
    const margin = this.computeMarginBalance(data); // validates + cross-checks root totals

    const assets = data?.assets;
    if (!Array.isArray(assets)) {
      log.error("Binance account total unavailable: assets[] missing/malformed");
      return null;
    }
    let eqSum = 0;
    let cashSum = 0;
    let complete = assets.length > 0 || (margin.wallet === 0 && margin.unrealizedPnl === 0 && margin.marginCash === 0);
    for (const a of assets) {
      const walletBalance = parseFloat(a?.walletBalance);
      const unrealizedProfit = parseFloat(a?.unrealizedProfit);
      const availableBalance = parseFloat(a?.availableBalance);
      if (![walletBalance, unrealizedProfit, availableBalance].every(Number.isFinite)) { complete = false; break; }
      if (walletBalance === 0 && availableBalance === 0 && unrealizedProfit === 0) continue;
      const rate = await this.getUsdRate(a.asset);
      if (!(rate > 0)) { complete = false; break; }
      eqSum += (walletBalance + unrealizedProfit) * rate;
      cashSum += availableBalance * rate;
    }
    if (!complete) {
      log.error("Binance account total unavailable: a non-stable asset could not be priced — no partial sum");
      return null;
    }
    // 2026-08-18 testnet outage: between 408 waves the backend served a
    // corrupt ledger whose assets[] entries were individually finite and
    // priceable yet summed to ≈ −$1.33e12 (root totals simultaneously read
    // as a fresh $5,000 account, so the cross-check above passed). A futures
    // account total can never be negative — Binance liquidates before a
    // wallet owes. Same fail-closed contract as an unpriceable asset: null,
    // never a poisoned number. (The DB writer has its own plausibility guard;
    // this kills the garbage at its source so binanceMainTruth never caches it.)
    if (eqSum < 0) {
      log.error(`Binance account total implausible: equity sums to ${eqSum.toFixed(2)} — corrupt broker ledger, no total reported`);
      return null;
    }
    return { equity: eqSum, cash: cashSum };
  }

  /**
   * Per-asset wallet breakdown from /fapi/v2/balance with USD valuation.
   * Ported from the deleted BinanceFuturesBroker for BrokerSync's shim.
   * Stablecoins value 1:1; other assets priced via getUsdRate's asset index
   * (Binance's canonical valuation, not a trading price). Fail-open at the
   * top level (returns [] on any error, including an unpriceable non-stable
   * asset — a partial breakdown with a fabricated $0 is worse than none).
   */
  async getAssetBreakdown(): Promise<Array<{ asset: string; balance: number; availableBalance: number; usdValue: number }>> {
    if (!this.connected) return [];
    try {
      const data = await this.signedRequest("GET", "/fapi/v2/balance");
      if (!Array.isArray(data)) return [];
      const result: Array<{ asset: string; balance: number; availableBalance: number; usdValue: number }> = [];
      for (const a of data) {
        const bal = this.requireNumber(a?.balance, `balance.${a?.asset}.balance`);
        const avail = this.requireNumber(a?.availableBalance, `balance.${a?.asset}.availableBalance`);
        if (bal === 0 && avail === 0) continue;
        const rate = await this.getUsdRate(a.asset);
        if (!(rate > 0)) throw new Error(`no USD rate for ${a.asset}`);
        result.push({ asset: a.asset, balance: bal, availableBalance: avail, usdValue: bal * rate });
      }
      return result;
    } catch (e: any) {
      log.warn(`getAssetBreakdown: ${e.message}`);
      return [];
    }
  }

  async getPositions(): Promise<{ symbol: string; positionAmt: number; entryPrice: number; unrealizedProfit: number; leverage: number; updateTime: number }[]> {
    if (!this.connected) throw new Error("Binance is not connected");
    // Class "protect": positionRisk is the stop-loss loop's position read and
    // every close's convergence check — the request class the limiter must
    // never let a background/entry stampede starve.
    const data = await this.signedRequest("GET", "/fapi/v2/positionRisk", {}, "protect");
    if (!Array.isArray(data)) {
      throw new Error(`Binance positionRisk failed: ${data?.msg ?? "non-array response"}`);
    }
    // Ownership scope: only symbols this instance's quote asset owns.
    // Without this, a USDC instance would list/return USDT positions (and
    // vice versa) — every other method already refuses to act on a symbol
    // outside this.symbolMap, so getPositions must not report them either.
    const ownNative = new Set(Object.values(this.symbolMap));
    // Canary (2026-07-29): an OPEN row with markPrice "0.00000000" or
    // entryPrice 0 is physically impossible. Today's readers survive only
    // because they filter positionAmt !== 0 first; a future reader would take
    // it as a real $0 price. WARN (throttled), never drop the row — hiding a
    // live position from the stop-loss loop blinds the only protection it has.
    if (dataIntegrityEnabled()) {
      for (const p of data) {
        if (!ownNative.has(p?.symbol) || parseFloat(p?.positionAmt) === 0) continue;
        const issues = positionPayloadIssues(p);
        if (issues.length > 0) {
          warnThrottled(`positionRisk_${p.symbol}`, `positionRisk ${p.symbol}: impossible payload — ${issues.join("; ")} (row kept; do not trust its prices)`);
        }
      }
    }
    return data
      .filter((p: any) => parseFloat(p.positionAmt) !== 0 && ownNative.has(p.symbol))
      .map((p: any) => ({
        symbol: p.symbol,
        positionAmt: parseFloat(p.positionAmt),
        entryPrice: parseFloat(p.entryPrice),
        unrealizedProfit: parseFloat(p.unRealizedProfit),
        leverage: parseInt(p.leverage),
        updateTime: parseInt(p.updateTime) || 0,
      }));
  }

  // OPEN.md P1 (2026-07-31): this feeds AccountManager.checkAllStopLoss,
  // whose client-side check must fire on the SAME series as the broker's
  // native STOP_MARKET orders (placed with workingType: MARK_PRICE) — mixing
  // last-trade here against mark-price there is the structural defect that
  // historically caused false stops in its cross-exchange variant (measured
  // divergence up to 0.174%). premiumIndex (mark price) replaces the old
  // ticker/price (last trade) endpoint; same symbol->number return shape so
  // every caller (stop-loss loop + BinanceMomentumAdapter sizing) is unaffected.
  async getPrice(binanceSymbol: string): Promise<number> {
    try {
      // Class "protect": this mark-price read feeds the 15s stop-loss loop —
      // the exact class of request a lower-priority stampede must never starve.
      const resp = await this.transport.publicRequest("/fapi/v1/premiumIndex", { symbol: binanceSymbol }, "protect");
      const data = await resp.json() as any;
      const row = Array.isArray(data) ? data.find((item: any) => item?.symbol === binanceSymbol) : data;
      const price = parseFloat(row?.markPrice) || 0;
      // Audit fix (P2, 2026-05-07): heartbeat the REST price feed so
      // /healthz/full reports a meaningful "last_price" timestamp.
      if (price > 0) this.lastMessageAt = Date.now();
      return price;
    } catch { return 0; }
  }

  /** True if a broker timestamp is recent enough to be an executable quote.
   *  Future-timestamp bound (same +5s it always had) now shares the single
   *  impossible-future definition in dataIntegrity. */
  private isFreshQuoteTs(ts: number): boolean {
    const now = Date.now();
    return ts > 0 && !isImpossibleFutureTs(ts, now) && now - ts <= 30_000;
  }

  /**
   * Fresh executable touch from Binance bookTicker: ask for buys, bid for sells.
   * Uses the broker's own `time` field and rejects stale data. Failure returns
   * null and logs once — telemetry must never block the order.
   */
  async getExecutableQuote(alpacaSymbol: string, side: "buy" | "sell", cls: RequestClass = "trade"): Promise<{ price: number; timestamp: number; bid?: number; ask?: number } | null> {
    if (!this.connected) return null;
    const binanceSymbol = this.symbolMap[alpacaSymbol];
    if (!binanceSymbol) return null;
    try {
      const resp = await this.transport.publicRequest("/fapi/v1/ticker/bookTicker", { symbol: binanceSymbol }, cls);
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      const ts = parseInt(data.time || "0") || 0;
      const bid = parseFloat(data.bidPrice);
      const ask = parseFloat(data.askPrice);
      if (dataIntegrityEnabled()) {
        // Feed-latency sample (local - exch); sustained negative min pages
        // via the monitor's own cooldown — never blocks the quote.
        if (ts > 0) clockDrift.observe("binance_bookTicker", ts);
        // bid > ask is well-formed but physically impossible; this path is
        // fill TELEMETRY only (a null merely skips the benchmark), so
        // discarding is strictly safer than benchmarking against garbage.
        if (isCrossedQuote(bid, ask)) {
          warnThrottled(`crossed_book_${binanceSymbol}`, `bookTicker ${binanceSymbol}: crossed book bid=${bid} > ask=${ask} — impossible quote discarded`);
          return null;
        }
      }
      const price = side === "buy" ? ask : bid;
      if (price > 0 && this.isFreshQuoteTs(ts)) {
        return { price, timestamp: ts, bid: bid > 0 ? bid : undefined, ask: ask > 0 ? ask : undefined };
      }
    } catch {}
    return null;
  }

  /**
   * Pre-trade impact estimate (Hummingbot get_price_for_quote_volume
   * semantics): simulated VWAP from the venue's REAL depth ladder
   * (`GET /fapi/v1/depth`) for `notionalUsd`, compared to the book mid.
   * Best-effort telemetry — null on any failure, and it gates NOTHING unless
   * a sleeve's policy explicitly sets maxEstImpactBps (executionPolicy.ts).
   */
  async estimateDepthImpact(alpacaSymbol: string, side: "buy" | "sell", notionalUsd: number): Promise<DepthEstimate | null> {
    if (!this.connected || !(notionalUsd > 0)) return null;
    const binanceSymbol = this.symbolMap[alpacaSymbol];
    if (!binanceSymbol) return null;
    try {
      const resp = await this.transport.publicRequest("/fapi/v1/depth", { symbol: binanceSymbol, limit: "100" }, "background");
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      const toLevels = (raw: any): BookLevel[] =>
        Array.isArray(raw) ? raw.map((l: any) => [parseFloat(l?.[0]), parseFloat(l?.[1])] as BookLevel) : [];
      return estimateFromBook(toLevels(data?.bids), toLevels(data?.asks), side, notionalUsd);
    } catch { return null; }
  }

  // ── Account balance ──────────────────────────

  private static readonly STABLE_ASSETS = new Set(["USDT", "USDC", "BUSD", "DAI", "TUSD", "FDUSD"]);

  private requireNumber(value: any, field: string): number {
    const n = typeof value === "number" ? value : parseFloat(value);
    if (!Number.isFinite(n)) throw new Error(`Binance account malformed numeric field: ${field}`);
    return n;
  }

  /**
   * 1:1 for stablecoins, else Binance's canonical asset index (the same
   * valuation the Binance UI's "Account total" uses), NOT a last-trade
   * ticker price. Returns 0 if unpriceable — callers fail closed.
   */
  private async getUsdRate(asset: string): Promise<number> {
    if (BinanceExecutor.STABLE_ASSETS.has(asset)) return 1;
    try {
      const resp = await this.transport.publicRequest("/fapi/v1/assetIndex", { symbol: `${asset}USD` }, "background");
      if (!resp.ok) return 0;
      const data = await resp.json() as any;
      const index = parseFloat(data?.index);
      return Number.isFinite(index) && index > 0 ? index : 0;
    } catch { return 0; }
  }

  /**
   * MARGIN fields (`marginEquity`/`marginCash`) select the ROW for THIS
   * instance's configured margin asset — never global/root totals blindly.
   * For USDT (default): Binance's ROOT totals (totalMarginBalance/
   * availableBalance) — what Binance itself uses for margin math. In
   * single-asset mode (multiAssetsMargin=false) these only reflect the ONE
   * margin asset (USDT); they are NOT the account total, confirmed by a real
   * /fapi/v2/account query where root totalMarginBalance≈4675 excluded a
   * USDC=5000 + BTC=0.01 deposit the Binance UI counts. For any other quote
   * asset (USDC): its OWN row in `assets[]`, which carries the same
   * marginBalance/walletBalance/unrealizedProfit/availableBalance shape.
   * NEVER touches assetIndex — the account TOTAL (getAccountTotal) owns
   * that fan-out.
   */
  private computeMarginBalance(acctData: any): { marginEquity: number; marginCash: number; wallet: number; unrealizedPnl: number } {
    if (this.quoteAsset === "USDT") {
      const wallet = this.requireNumber(acctData?.totalWalletBalance, "totalWalletBalance");
      const unrealizedPnl = this.requireNumber(acctData?.totalUnrealizedProfit, "totalUnrealizedProfit");
      const marginEquity = this.requireNumber(acctData?.totalMarginBalance, "totalMarginBalance");
      const marginCash = this.requireNumber(acctData?.availableBalance, "availableBalance");
      const expected = wallet + unrealizedPnl;
      if (Math.abs(marginEquity - expected) > 0.01) {
        throw new Error(
          `Binance account balance mismatch: totalMarginBalance=${marginEquity} != totalWalletBalance+totalUnrealizedProfit=${expected} (wallet=${wallet}, unrealizedPnl=${unrealizedPnl})`
        );
      }
      return { marginEquity, marginCash, wallet, unrealizedPnl };
    }

    const assets = acctData?.assets;
    const row = Array.isArray(assets) ? assets.find((a: any) => a?.asset === this.quoteAsset) : undefined;
    if (!row) throw new Error(`Binance account: no ${this.quoteAsset} asset row in assets[]`);
    const wallet = this.requireNumber(row.walletBalance, `assets.${this.quoteAsset}.walletBalance`);
    const unrealizedPnl = this.requireNumber(row.unrealizedProfit, `assets.${this.quoteAsset}.unrealizedProfit`);
    const marginEquity = this.requireNumber(row.marginBalance, `assets.${this.quoteAsset}.marginBalance`);
    const marginCash = this.requireNumber(row.availableBalance, `assets.${this.quoteAsset}.availableBalance`);
    const expected = wallet + unrealizedPnl;
    if (Math.abs(marginEquity - expected) > 0.01) {
      throw new Error(
        `Binance account balance mismatch: assets.${this.quoteAsset}.marginBalance=${marginEquity} != walletBalance+unrealizedProfit=${expected} (wallet=${wallet}, unrealizedPnl=${unrealizedPnl})`
      );
    }
    return { marginEquity, marginCash, wallet, unrealizedPnl };
  }

  // ── Recent trades for a symbol (realized PnL) ──

  async getRecentTrades(binanceSymbol: string, limit = 10, sinceMs?: number): Promise<{ realizedPnl: number; commission: number; price: number; qty: number; side: string; time: number }[]> {
    if (!this.connected) throw new Error("Binance is not connected");
    const params: Record<string, string> = { symbol: binanceSymbol, limit: limit.toString() };
    if (sinceMs !== undefined) {
      // Binance caps account-trade time ranges at seven days. A broker stop has
      // just filled, so this window contains it even when the position is old;
      // the exact entry timestamp is still applied as the attribution filter.
      params.startTime = Math.max(sinceMs, Date.now() - 7 * 24 * 60 * 60_000 + 1).toString();
    }
    // Class "protect": callers attribute a just-filled broker stop.
    const data = await this.signedRequest("GET", "/fapi/v1/userTrades", params, "protect");
    if (!Array.isArray(data)) {
      throw new Error(`Binance userTrades failed: ${data?.msg ?? "non-array response"}`);
    }
    return data
      .map((t: any) => ({
        realizedPnl: parseFloat(t.realizedPnl || "0"),
        commission: parseFloat(t.commission || "0"),
        price: parseFloat(t.price || "0"),
        qty: parseFloat(t.qty || "0"),
        side: t.side,
        time: parseInt(t.time) || 0,
      }))
      .filter(t => sinceMs === undefined || t.time >= sinceMs);
  }

  async hasFilledStopClose(binanceSymbol: string, closeSide: "BUY" | "SELL", qty: number, sinceMs: number): Promise<boolean> {
    if (!this.connected) throw new Error("Binance is not connected");
    const orders = await this.signedRequest("GET", "/fapi/v1/allOrders", { symbol: binanceSymbol, limit: "1000" }, "protect");
    if (!Array.isArray(orders)) throw new Error(`Binance allOrders failed: ${orders?.msg ?? "non-array response"}`);
    const { decimals } = await this.resolveQtyStep(binanceSymbol);
    const tolerance = 10 ** -decimals / 2;
    return orders.some((o: any) =>
      String(o.status) === "FILLED" &&
      String(o.type).includes("STOP") &&
      String(o.side).toUpperCase() === closeSide &&
      (parseFloat(o.executedQty || o.origQty || "0") + tolerance) >= qty &&
      (parseInt(o.updateTime || o.time || "0") || 0) >= sinceMs
    );
  }

  /** Read back both native conditional-order stores. Failure of either query
   * fails closed so callers never mistake a partial read for protection. */
  async getOpenProtectiveOrders(symbol?: string): Promise<Array<{
    symbol: string;
    side: string;
    type: string;
    quantity: number;
    triggerPrice: number;
    reduceOnly: boolean;
  }>> {
    if (!this.connected) throw new Error("Binance is not connected");
    const native = symbol ? (this.symbolMap[symbol] ?? symbol) : undefined;
    const params: Record<string, string> = native ? { symbol: native } : {};
    // Class "protect": this read decides whether a position is protected.
    const [regularRaw, algoRaw] = await Promise.all([
      this.signedRequest("GET", "/fapi/v1/openOrders", params, "protect"),
      this.signedRequest("GET", "/fapi/v1/openAlgoOrders", params, "protect"),
    ]);
    if (!Array.isArray(regularRaw)) throw new Error("Binance openOrders failed: non-array response");
    const algoOrders = Array.isArray(algoRaw) ? algoRaw : (Array.isArray(algoRaw?.orders) ? algoRaw.orders : null);
    if (!algoOrders) throw new Error("Binance openAlgoOrders failed: non-array response");

    // Binance's Algo Order readback for a market-type conditional stop can
    // report orderType "STOP" instead of "STOP_MARKET" (confirmed against
    // ccxt's real captured "createOrder conditional linear swap" response —
    // the exact fallback path placeStopMarketClose takes on a -4120
    // rejection). This module never places anything but market-close
    // protective stops, so any reduceOnly conditional stop we read back —
    // regardless of Binance's exact naming for it — IS one of ours; an
    // exact-string match against "STOP_MARKET" alone would make a genuine
    // protective stop invisible to reconciliation.
    const isProtectiveStopType = (t: string) => t === "STOP_MARKET" || t === "STOP";
    const normalize = (order: any, algo: boolean) => {
      const rawType = String(algo ? (order.orderType ?? order.type ?? order.actualOrderType) : order.type ?? "").toUpperCase();
      return {
        symbol: String(order.symbol ?? ""),
        side: String(order.side ?? "").toUpperCase(),
        // Canonicalize to "STOP_MARKET" — the semantic type of every stop
        // this module ever places — regardless of which synonym Binance's
        // readback used.
        type: isProtectiveStopType(rawType) ? "STOP_MARKET" : rawType,
        quantity: Number(order.totalQty ?? order.origQty ?? order.quantity ?? order.qty ?? 0),
        triggerPrice: Number(algo ? (order.triggerPrice ?? order.stopPrice) : order.stopPrice),
        reduceOnly: order.reduceOnly === true || String(order.reduceOnly).toLowerCase() === "true",
      };
    };
    return [
      ...regularRaw.filter((o: any) => isProtectiveStopType(String(o.type ?? "").toUpperCase()) && (o.reduceOnly === true || String(o.reduceOnly).toLowerCase() === "true")).map((o: any) => normalize(o, false)),
      ...algoOrders.filter((o: any) => isProtectiveStopType(String(o.orderType ?? o.type ?? o.actualOrderType ?? "").toUpperCase()) && (o.reduceOnly === true || String(o.reduceOnly).toLowerCase() === "true")).map((o: any) => normalize(o, true)),
    ];
  }

  /** Read back conditional-order history, including orders created by the
   * -4120 Algo Order fallback. */
  async getAlgoOrderHistory(binanceSymbol: string, sinceMs?: number): Promise<any[]> {
    if (!this.connected) throw new Error("Binance is not connected");
    const params: Record<string, string> = { symbol: binanceSymbol, limit: "1000" };
    if (sinceMs !== undefined) params.startTime = String(sinceMs);
    const raw = await this.signedRequest("GET", "/fapi/v1/allAlgoOrders", params);
    const orders = Array.isArray(raw) ? raw : (Array.isArray(raw?.orders) ? raw.orders : null);
    if (!orders) throw new Error(`Binance allAlgoOrders failed: ${raw?.msg ?? "non-array response"}`);
    return orders;
  }

  // ── Status ────────────────────────────────

  isConnected(): boolean { return this.connected; }
  getReverseSymbolMap(): Record<string, string> { return { ...this.reverseSymbolMap }; }

  /** Instance-scoped translation (respects this executor's quoteAsset — a
   *  USDC instance returns null for a USDT-style internal symbol and vice
   *  versa). Use these, not the USDT-only static helpers below, when the
   *  executor instance might be non-default. */
  toNativeSymbol(internalSymbol: string): string | null { return this.symbolMap[internalSymbol] ?? null; }
  toInternalSymbol(nativeSymbol: string): string | null { return this.reverseSymbolMap[nativeSymbol] ?? null; }

  static toBinanceSymbol(alpacaSymbol: string): string | null {
    return SYMBOL_MAP[alpacaSymbol] || null;
  }

  static toAlpacaSymbol(binanceSymbol: string): string | null {
    for (const [k, v] of Object.entries(SYMBOL_MAP)) {
      if (v === binanceSymbol) return k;
    }
    return null;
  }
}
