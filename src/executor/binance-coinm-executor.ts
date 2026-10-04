// ══════════════════════════════════════════════
// Binance COIN-M (Delivery) Futures Testnet — standalone execution core
// Signed DAPI REST · BTCUSD_PERP only · inverse-contract sizing/PnL
// ══════════════════════════════════════════════
//
// Deliberately isolated from src/executor/binance-executor.ts (USDT-M/FAPI,
// linear contracts). COIN-M is a DIFFERENT product family (inverse
// contracts, margin/settlement in BTC, DAPI base path) — sharing a class
// would smuggle FAPI assumptions (qty in base units, notional = qty*price)
// into inverse math where they're simply wrong. This module never talks to
// /fapi/* and never accepts a FAPI-style symbol.
//
// Scope: standalone core only — not wired into index.ts/AccountManager/risk
// profiles. No WS/listenKey (REST poll only, matching BinanceExecutor's
// fallback path); add a user-data stream when a live feed is needed.

import crypto from "crypto";
import { fetchT } from "../utils/timeout";
import { createLogger } from "../utils/logger";
import { floorToStep } from "./binance/instrumentSpec";
import { getVenueRateLimiter, retryAfterMsFromHeaders, type RequestClass } from "./rateLimiter";
import { symbolLocks, DEFAULT_SYMBOL_LOCK_TIMEOUT_MS } from "./symbolLock";

const log = createLogger("BinanceCoinMExecutor");

// The ONLY supported internal symbol → DAPI product. Explicit identity:
// never derive this from a FAPI map, never accept "BTC/USD" (that's the
// USDT-M linear symbol used by BinanceExecutor) or a raw "BTCUSD_PERP".
export const COINM_SYMBOL_MAP: Record<string, string> = {
  "BTC/COIN-M": "BTCUSD_PERP",
};

export function toCoinMProductSymbol(internalSymbol: string): string | null {
  return COINM_SYMBOL_MAP[internalSymbol] ?? null;
}

// ── Deterministic client order IDs ────────────────────────────────
// Same seed → same id, always. Lets a caller retry an ambiguous submit
// (timeout, transport error) by re-deriving the SAME id and querying it
// instead of blind-POSTing a second order. Binance clientOrderId cap is 36
// chars.
//
// Every id this executor generates carries the SAME namespace prefix — the
// only way ownership is ever proven when reconciling against the exchange
// after a restart (activeStops doesn't survive one). Without this, a
// startup/cancel reconcile that matches on "any reduceOnly STOP_MARKET"
// could touch a foreign/manual stop that happens to share the product.
export const COINM_CLIENT_ID_NAMESPACE = "uc-coinm-";
const CLIENT_ID_MAX_LEN = 36; // Binance clientOrderId/clientAlgoId cap

export function deterministicClientOrderId(seed: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, CLIENT_ID_MAX_LEN - COINM_CLIENT_ID_NAMESPACE.length);
  return `${COINM_CLIENT_ID_NAMESPACE}${hash}`;
}

/** True only for an id this executor itself could have generated. Never a
 *  generic "looks like an order id" heuristic — an exact namespace match. */
export function isOwnedClientId(id: string | number | undefined | null): boolean {
  return typeof id === "string" && id.startsWith(COINM_CLIENT_ID_NAMESPACE);
}

// ── Inverse-contract pure math (no quantity*price notional here) ──

/**
 * contracts = floor(notionalUsd / contractSize). A sub-one-contract notional
 * returns 0 (reject) for a live caller — flooring it UP to a full contract
 * would silently size a position up to 100x the intended risk. The ONLY
 * caller allowed to opt into that floor is the certification script's
 * explicit minimum-size probe (`allowMinimumFloor: true`), which deliberately
 * wants the smallest tradeable size regardless of its tiny test notional.
 */
export function computeContracts(notionalUsd: number, contractSize: number, opts: { allowMinimumFloor?: boolean } = {}): number {
  if (!(notionalUsd > 0) || !(contractSize > 0)) return 0;
  const raw = Math.floor(notionalUsd / contractSize);
  if (raw >= 1) return raw;
  return opts.allowMinimumFloor ? 1 : 0;
}

/** Position USD size for an inverse contract: contracts * contractSize (constant regardless of price). */
export function positionUsd(contracts: number, contractSize: number): number {
  return Math.abs(contracts) * contractSize;
}

/**
 * Inverse-contract PnL in BTC (BTCUSD_PERP: contract value fixed in USD,
 * settled in BTC).
 *   long:  contracts * contractSize * (1/entry - 1/exit)
 *   short: contracts * contractSize * (1/exit  - 1/entry)
 */
export function inversePnlBtc(side: "buy" | "sell", contracts: number, contractSize: number, entryPrice: number, exitPrice: number): number {
  if (!(entryPrice > 0) || !(exitPrice > 0) || !(contracts > 0) || !(contractSize > 0)) return 0;
  const notional = Math.abs(contracts) * contractSize;
  return side === "buy"
    ? notional * (1 / entryPrice - 1 / exitPrice)
    : notional * (1 / exitPrice - 1 / entryPrice);
}

/** USD PnL AT EXIT — the BTC-denominated result converted at the exit price. */
export function inversePnlUsdAtExit(side: "buy" | "sell", contracts: number, contractSize: number, entryPrice: number, exitPrice: number): number {
  return inversePnlBtc(side, contracts, contractSize, entryPrice, exitPrice) * exitPrice;
}

// ── Config ──────────────────────────────────────────────────────

export interface CoinMConfig {
  apiKey: string;
  secretKey: string;
  /** Demo/testnet DAPI base by default — never defaults to a live host. */
  restBase: string;
  recvWindow: number;
  timeoutMs: number;
  pollDelayMs: number;
  fillTimeoutMs: number;
  closeTimeoutMs: number;
  exchangeInfoTtlMs: number;
}

export const DEFAULT_COINM_CONFIG: CoinMConfig = {
  apiKey: process.env.BINANCE_COINM_API_KEY || process.env.BINANCE_FUTURES_API_KEY || "",
  secretKey: process.env.BINANCE_COINM_SECRET_KEY || process.env.BINANCE_FUTURES_SECRET_KEY || "",
  restBase: process.env.BINANCE_COINM_REST_BASE || "https://demo-dapi.binance.com",
  recvWindow: 5_000,
  timeoutMs: 10_000,
  pollDelayMs: 400,
  fillTimeoutMs: 6_000,
  closeTimeoutMs: 8_000,
  exchangeInfoTtlMs: 6 * 60 * 60_000, // 6h
};

export interface CoinMFilters {
  status: string;
  contractType: string;
  marginAsset: string;
  contractSize: number;
  tickSize: number;
  pricePrecision: number;
  lotStepSize: number;
  lotMinQty: number;
  lotMaxQty: number;
  marketLotStepSize: number;
  marketLotMinQty: number;
  marketLotMaxQty: number;
}

/**
 * An owned (namespace-matched) reduceOnly STOP_MARKET order/algo-order, as
 * actually found on the exchange. `side`/`quantity`/`triggerPrice` let a
 * caller (the restart invariant in BinanceCoinMMomentumAdapter) verify the
 * stop is CORRECT for the live position — not just present — instead of
 * blindly trusting "an owned stop exists" the way the old adopt-on-restart
 * path did.
 */
export interface OwnedStop {
  kind: "order" | "algo";
  id: string;
  side: string; // "BUY" | "SELL" as reported by the exchange; "" if unparseable
  quantity: number;
  triggerPrice: number;
}

export interface CoinMUserTradeSettlement {
  realizedPnlNative: number;
  commissionNative: number;
  commissionAsset: string;
  executedQty: number;
  averagePrice: number;
}

export interface CoinMPosition {
  symbol: string;
  positionAmt: number; // contracts, signed (+long/-short)
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number; // BTC
  leverage: number;
  updateTime: number;
}

export interface CoinMOrderResult {
  orderId: number | string;
  clientOrderId: string;
  status: string;
  avgPrice: number;
  executedQty: number;
}

/**
 * closePosition's result. realizedPnlNative/commissionNative/commissionAsset
 * come from /dapi/v1/userTrades for the EXACT close order (never a sweep
 * across orders — see fetchOrderSettlement), so accumulating these across
 * multiple partial-close stages (see BinanceCoinMMomentumAdapter +
 * accumulatePartialCloseLedger) can never double-count a fill. All three
 * default to 0/"" (never fabricated) when settlement genuinely couldn't be
 * read — callers fall back to their own price-delta PnL math in that case.
 */
export interface CoinMCloseResult {
  success: boolean;
  filledPrice: number;
  executedQty: number;
  realizedPnlNative: number;
  commissionNative: number;
  commissionAsset: string;
}

// Algo-order (conditional STOP_MARKET fallback) terminal statuses. Anything
// NOT in this set (NEW/WORKING/etc) is treated as "open" — deliberately an
// exclusion list rather than an inclusion list of "open" values, since the
// exact open-state vocabulary isn't guaranteed and a false negative here
// (treating a live stop as gone) is the dangerous direction of error.
const ALGO_TERMINAL_STATUSES = new Set(["CANCELLED", "CANCELED", "FINISHED", "EXPIRED", "REJECTED"]);

/** Binance sends reduceOnly as a JSON boolean on some endpoints and a string
 *  on others (query-string round-trips) — accept either, never just one. */
function isReduceOnlyFlag(v: any): boolean {
  return v === true || String(v).toLowerCase() === "true";
}

/**
 * Is this REST host a non-production (demo/testnet) Binance COIN-M DAPI
 * endpoint? DAPI's own guard — deliberately NOT isNonProductionBinanceHost
 * (binance-executor.ts): that FAPI allowlist does not know `demo-dapi.
 * binance.com` and would refuse the very host this executor defaults to.
 * Shared by preflight() AND init() (2026-08-09) so a caller that skips
 * preflight — scripts, future wiring — still cannot connect this executor
 * to production dapi.binance.com.
 */
export function isNonProductionCoinmHost(url: string): boolean {
  return /testnet|demo/i.test(url || "");
}

export class BinanceCoinMExecutor {
  private cfg: CoinMConfig;
  private connected = false;
  private timeOffsetMs = 0;
  private filtersCache: Map<string, { filters: CoinMFilters; fetchedAt: number }> = new Map();
  // Tracks the ONE active native stop per product so cancel/query is exact
  // (never a blind "cancel everything" sweep).
  private activeStops: Map<string, { kind: "order" | "algo"; id: string }> = new Map();

  /** Shared PER-VENUE limiter (rateLimiter.ts). DAPI is a genuinely separate
   *  account/quota from FAPI, so it gets its own venue bucket — but every
   *  CoinM executor instance still shares this one. */
  private limiter = getVenueRateLimiter("binance_dapi");
  /** Symbol-lock acquisition bound; overridable only by tests. */
  private lockTimeoutMs = DEFAULT_SYMBOL_LOCK_TIMEOUT_MS;

  constructor(cfg: Partial<CoinMConfig> = {}) {
    this.cfg = { ...DEFAULT_COINM_CONFIG, ...cfg };
  }

  isConnected(): boolean { return this.connected; }
  getConfig(): CoinMConfig { return { ...this.cfg }; }
  toProductSymbol(internalSymbol: string): string | null { return toCoinMProductSymbol(internalSymbol); }

  // ── Startup preflight (read-only, never places an order) ───────

  /**
   * Certification gate for momentum_btc (2026-07-19): refuses to enable this
   * sleeve unless the DAPI host is testnet/demo, the account runs one-way
   * position mode, a BTC balance row exists, and BTCUSD_PERP's exchangeInfo
   * filters load. Called from src/index.ts BEFORE the sleeve is wired; a
   * failure hard-fails only this sleeve, never the rest of the bot.
   */
  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    if (!isNonProductionCoinmHost(this.cfg.restBase)) {
      return { ok: false, reason: `restBase "${this.cfg.restBase}" is not testnet/demo — refusing to enable COIN-M` };
    }
    if (!this.cfg.apiKey || !this.cfg.secretKey) return { ok: false, reason: "API keys not configured" };
    try {
      await this.syncTime();
      const dual = await this.signedRequest("GET", "/dapi/v1/positionSide/dual");
      if (dual?.dualSidePosition !== false) {
        return { ok: false, reason: `dualSidePosition must be false (one-way mode), got ${dual?.dualSidePosition}` };
      }
      await this.getFilters("BTC/COIN-M", { forceRefresh: true }); // TRADING + filters, throws otherwise
      await this.getBalanceBtc(); // throws if the BTC balance row is missing
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e.message };
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * `skipStartupStopReconcile` exists ONLY for certification: the default
   * reconcile is a MUTATION (it cancels any owned reduceOnly stop it finds
   * when the account reads flat — see reconcileStartupStops below), so a
   * cert script that wants to inspect real pre-existing broker state before
   * touching anything must be able to opt out of it. Every live/production
   * caller (the momentum adapter) uses the default and gets the exact same
   * behavior as before this option existed.
   */
  async init(opts: { skipStartupStopReconcile?: boolean } = {}): Promise<boolean> {
    // Safety gate (2026-08-09): same sandbox-host refusal preflight() makes,
    // enforced HERE too so init() alone can never connect to production DAPI
    // (index.ts always preflights first, but scripts/tests may not). Runs
    // before any network call; no override, mirroring the FAPI executor.
    if (!isNonProductionCoinmHost(this.cfg.restBase)) {
      log.error(`🚫 SAFETY: restBase "${this.cfg.restBase}" is not a testnet/demo DAPI host — refusing to connect COIN-M (unknown hosts are never assumed safe)`);
      return false;
    }
    if (!this.cfg.apiKey || !this.cfg.secretKey) {
      log.warn("BinanceCoinMExecutor: API keys not configured — disabled");
      return false;
    }
    try {
      await this.syncTime();
      await this.getFilters("BTC/COIN-M", { forceRefresh: true }); // validates TRADING/marginAsset/filters up front
      await this.getBalanceBtc(); // auth probe
      this.connected = true;
      const startup = await this.getPositions("BTC/COIN-M"); // startup position read
      if (!opts.skipStartupStopReconcile) {
        try {
          await this.reconcileStartupStops("BTC/COIN-M");
        } catch (e: any) {
          // An owned stop exists but the position read needed to decide
          // adopt-vs-cancel FAILED (transport/read error) — state is
          // UNKNOWN. Never guess: fail init closed rather than start the
          // sleeve blind to whether that stop is protecting a real position.
          log.error(`CoinM startup stop reconcile failed: ${e.message} — failing init (owned stop state unknown)`);
          this.connected = false;
          return false;
        }
      }
      log.info(startup.length > 0
        ? `CoinM startup: existing position ${startup[0].positionAmt} contracts @ ${startup[0].entryPrice}`
        : "CoinM startup: flat");
      return true;
    } catch (e: any) {
      log.error(`BinanceCoinMExecutor init failed: ${e.message}`);
      this.connected = false;
      return false;
    }
  }

  /**
   * Safe shutdown: stop reading/tracking state locally. Deliberately does
   * NOT cancel any native STOP_MARKET/algo stop — it must keep protecting a
   * live position while the process is down (checkAllStopLoss-equivalent
   * client loop is not part of this standalone core).
   */
  shutdown(): void {
    this.connected = false;
    this.filtersCache.clear();
  }

  private sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

  /** Record a 429/418 the venue just returned. A 418 is a temporary IP BAN
   *  — loud on purpose, and it freezes ALL DAPI traffic until it passes
   *  (sending during a ban fails anyway AND extends it). Retry-After is
   *  honored exactly when present. */
  private notePenaltyStatus(resp: Response, path: string): void {
    if (resp.status !== 429 && resp.status !== 418) return;
    const retryAfterMs = retryAfterMsFromHeaders(resp.headers);
    this.limiter.notePenalty(resp.status as 429 | 418, retryAfterMs);
    if (resp.status === 418) {
      log.error(`🚨🚨 Binance DAPI returned HTTP 418 (temporary IP BAN) on ${path} — ALL COIN-M traffic frozen${retryAfterMs ? ` for ${retryAfterMs}ms (Retry-After)` : ""}; continuing to send would extend the ban`);
    } else {
      log.warn(`Binance DAPI returned HTTP 429 on ${path} — rate-limit penalty window opened${retryAfterMs ? ` (Retry-After ${retryAfterMs}ms)` : ""}`);
    }
  }

  /** Pre-transmit limiter gate for the UNSIGNED endpoints (time,
   *  exchangeInfo, mark price) — they count against the same per-IP cap. */
  private async limitedFetch(cls: RequestClass, path: string, doFetch: () => Promise<Response>): Promise<Response> {
    const acq = await this.limiter.acquire(cls);
    if (!acq.ok) {
      const denied = new Error(`rate_limited: ${acq.reason}`) as Error & { rateLimitDenied?: boolean };
      denied.rateLimitDenied = true;
      throw denied;
    }
    const resp = await doFetch();
    this.notePenaltyStatus(resp, path);
    return resp;
  }

  private requireNumber(value: any, field: string): number {
    const n = typeof value === "number" ? value : parseFloat(value);
    if (!Number.isFinite(n)) throw new Error(`CoinM malformed numeric field: ${field}`);
    return n;
  }

  /** Same as requireNumber but ALSO rejects zero/negative — every filter
   *  bound this executor sizes/floors against (tick, lot, market-lot,
   *  min/max) must be a genuine positive bound, never a malformed 0. */
  private requirePositiveNumber(value: any, field: string): number {
    const n = this.requireNumber(value, field);
    if (!(n > 0)) throw new Error(`CoinM filter field must be positive: ${field}=${n}`);
    return n;
  }

  // ── Signing / bounded time offset ─────────────────────────────

  private sign(qs: string): string {
    return crypto.createHmac("sha256", this.cfg.secretKey).update(qs).digest("hex");
  }

  /** Seam for tests: real impl below (fetchT-bounded, public endpoint). */
  private async getServerTimeRaw(): Promise<number> {
    const resp = await this.limitedFetch("trade", "/dapi/v1/time", () => fetchT(`${this.cfg.restBase}/dapi/v1/time`, {}, this.cfg.timeoutMs));
    if (!resp.ok) throw new Error(`dapi/v1/time HTTP ${resp.status}`);
    const data = await resp.json() as any;
    const serverTime = Number(data?.serverTime);
    if (!Number.isFinite(serverTime)) throw new Error("dapi/v1/time malformed response");
    return serverTime;
  }

  private async syncTime(): Promise<void> {
    this.timeOffsetMs = (await this.getServerTimeRaw()) - Date.now();
  }

  /**
   * Every signed request builds ONE query string and signs THAT, regardless
   * of HTTP method (GET/POST/DELETE) — params are never split between query
   * string and body. That removes the GET-vs-POST signature-mismatch class
   * of bugs where part of the payload silently signs one shape while the
   * transport sends another.
   */
  private async signedRequest(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string> = {}, cls: RequestClass = "trade"): Promise<any> {
    if (!this.cfg.apiKey || !this.cfg.secretKey) throw new Error("BinanceCoinMExecutor: missing API credentials");
    // Venue rate limiter: a denial happens BEFORE anything is transmitted —
    // callers may safely treat it as a proven non-submission.
    const acq = await this.limiter.acquire(cls);
    if (!acq.ok) {
      const denied = new Error(`rate_limited: ${acq.reason}`) as Error & { rateLimitDenied?: boolean };
      denied.rateLimitDenied = true;
      throw denied;
    }
    const full = { ...params, recvWindow: String(this.cfg.recvWindow), timestamp: String(Date.now() + this.timeOffsetMs) };
    const qs = Object.entries(full).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const signature = this.sign(qs);
    const url = `${this.cfg.restBase}${path}?${qs}&signature=${signature}`;
    const resp = await fetchT(url, { method, headers: { "X-MBX-APIKEY": this.cfg.apiKey } }, this.cfg.timeoutMs);
    this.notePenaltyStatus(resp, path);
    const data = await resp.json().catch(() => null) as any;
    if (!resp.ok) {
      const error = new Error(`CoinM ${path} HTTP ${resp.status}: ${data?.msg ?? resp.statusText}`) as Error & { code?: number; httpStatus?: number };
      const code = Number(data?.code);
      if (Number.isFinite(code)) error.code = code;
      error.httpStatus = resp.status;
      throw error;
    }
    const bodyCode = Number(data?.code);
    if (Number.isFinite(bodyCode) && bodyCode !== 0 && bodyCode !== 200) {
      const err = new Error(`CoinM ${path} ${data.code}: ${data.msg ?? "error"}`) as Error & { code?: number };
      err.code = bodyCode;
      throw err;
    }
    return data;
  }

  // ── ExchangeInfo catalog (injectable/cached) ──────────────────

  /** Seam for tests: public endpoint, no signature. */
  private async fetchExchangeInfoRaw(): Promise<any> {
    const resp = await this.limitedFetch("background", "/dapi/v1/exchangeInfo", () => fetchT(`${this.cfg.restBase}/dapi/v1/exchangeInfo`, {}, this.cfg.timeoutMs));
    if (!resp.ok) throw new Error(`dapi/v1/exchangeInfo HTTP ${resp.status}`);
    return resp.json();
  }

  /**
   * Validates the product is TRADING and extracts marginAsset/contractSize/
   * PRICE_FILTER/LOT_SIZE/MARKET_LOT_SIZE. Cached with a TTL; pass
   * forceRefresh to bypass (e.g. after a rejected order suggests staleness).
   */
  async getFilters(internalSymbol: string, opts: { forceRefresh?: boolean } = {}): Promise<CoinMFilters> {
    const product = this.toProductSymbol(internalSymbol);
    if (!product) throw new Error(`unsupported COIN-M symbol: ${internalSymbol}`);
    const cached = this.filtersCache.get(product);
    if (cached && !opts.forceRefresh && (Date.now() - cached.fetchedAt) < this.cfg.exchangeInfoTtlMs) {
      return cached.filters;
    }
    const info = await this.fetchExchangeInfoRaw();
    const symbols = Array.isArray(info?.symbols) ? info.symbols : [];
    const row = symbols.find((s: any) => s.symbol === product);
    if (!row) throw new Error(`CoinM exchangeInfo: ${product} not found`);
    // COIN-M calls this field `contractStatus`; older fixtures used the
    // USD-M-style `status`. Prefer the official DAPI field when present.
    const status = String(row.contractStatus ?? row.status ?? "");
    if (status !== "TRADING") throw new Error(`CoinM ${product} not TRADING (status=${status || "missing"})`);
    // Reject a quarterly/delivery contract sharing the product id space —
    // this executor's inverse-PnL math and settlement handling assume a
    // perpetual (no delivery date, no cross-contract roll behavior).
    const contractType = String(row.contractType || "");
    if (contractType !== "PERPETUAL") throw new Error(`CoinM ${product} not PERPETUAL (contractType=${contractType || "missing"})`);
    const contractSize = Number(row.contractSize);
    if (!(contractSize > 0)) throw new Error(`CoinM ${product} invalid contractSize`);
    // Exact match, not just "truthy" — a malformed/wrong settlement asset
    // (e.g. a future ETHUSD_PERP-shaped row reusing this code path) must
    // never silently pass as "has a marginAsset".
    const marginAsset = String(row.marginAsset || "");
    if (marginAsset !== "BTC") throw new Error(`CoinM ${product} marginAsset must be BTC, got "${marginAsset || "missing"}"`);
    const filtersArr = Array.isArray(row.filters) ? row.filters : [];
    const priceFilter = filtersArr.find((f: any) => f.filterType === "PRICE_FILTER");
    const lotSize = filtersArr.find((f: any) => f.filterType === "LOT_SIZE");
    const marketLot = filtersArr.find((f: any) => f.filterType === "MARKET_LOT_SIZE");
    if (!priceFilter || !lotSize || !marketLot) throw new Error(`CoinM ${product} exchangeInfo missing required filters`);
    const filters: CoinMFilters = {
      status,
      contractType,
      marginAsset,
      contractSize,
      tickSize: this.requirePositiveNumber(priceFilter.tickSize, "PRICE_FILTER.tickSize"),
      pricePrecision: Number.isFinite(Number(row.pricePrecision)) ? Number(row.pricePrecision) : 1,
      lotStepSize: this.requirePositiveNumber(lotSize.stepSize, "LOT_SIZE.stepSize"),
      lotMinQty: this.requirePositiveNumber(lotSize.minQty, "LOT_SIZE.minQty"),
      lotMaxQty: this.requirePositiveNumber(lotSize.maxQty, "LOT_SIZE.maxQty"),
      marketLotStepSize: this.requirePositiveNumber(marketLot.stepSize, "MARKET_LOT_SIZE.stepSize"),
      marketLotMinQty: this.requirePositiveNumber(marketLot.minQty, "MARKET_LOT_SIZE.minQty"),
      marketLotMaxQty: this.requirePositiveNumber(marketLot.maxQty, "MARKET_LOT_SIZE.maxQty"),
    };
    this.filtersCache.set(product, { filters, fetchedAt: Date.now() });
    return filters;
  }

  // ── Account reads ──────────────────────────────────────────────

  async getBalanceBtc(): Promise<{ walletBalance: number; crossUnPnl: number; marginBalance: number; availableBalance: number }> {
    const data = await this.signedRequest("GET", "/dapi/v1/balance");
    if (!Array.isArray(data)) throw new Error(`CoinM balance failed: ${(data as any)?.msg ?? "non-array response"}`);
    const row = data.find((a: any) => a.asset === "BTC");
    if (!row) throw new Error("CoinM balance: BTC asset not found");
    const walletBalance = this.requireNumber(row.balance, "balance");
    const crossUnPnl = this.requireNumber(row.crossUnPnl, "crossUnPnl");
    const availableBalance = this.requireNumber(row.availableBalance, "availableBalance");
    return { walletBalance, crossUnPnl, marginBalance: walletBalance + crossUnPnl, availableBalance };
  }

  /** Seam for tests: public endpoint, no signature. */
  private async fetchMarkPriceRaw(product: string): Promise<number> {
    // Class "protect": the mark price feeds stop math and ambiguous-close
    // exposure recovery — never let lower classes starve it.
    const resp = await this.limitedFetch("protect", "/dapi/v1/premiumIndex", () => fetchT(`${this.cfg.restBase}/dapi/v1/premiumIndex?symbol=${product}`, {}, this.cfg.timeoutMs));
    if (!resp.ok) return 0;
    const data = await resp.json() as any;
    const row = Array.isArray(data) ? data.find((item: any) => item?.symbol === product) : data;
    return Number(row?.markPrice) || 0;
  }

  async getMarkPrice(internalSymbol: string): Promise<number> {
    const product = this.toProductSymbol(internalSymbol);
    if (!product) return 0;
    try { return await this.fetchMarkPriceRaw(product); } catch { return 0; }
  }

  /**
   * Equity in USD = BTC marginBalance converted at the CURRENT mark price.
   * This is a currency conversion (balance × price), NOT a position notional
   * — inverse position sizing must never use quantity*price (see
   * computeContracts/positionUsd above).
   */
  async getEquityUsd(): Promise<number> {
    const [balance, markPrice] = await Promise.all([this.getBalanceBtc(), this.getMarkPrice("BTC/COIN-M")]);
    if (!(markPrice > 0)) throw new Error("CoinM equity: no BTC mark price");
    return balance.marginBalance * markPrice;
  }

  /**
   * Product-scoped position read. `data.filter(p => p.symbol === product)`
   * is a defensive ownership guard even though the `symbol` request param
   * already scopes Binance's response — a sibling COIN-M contract
   * (ETHUSD_PERP, a quarterly BTCUSD_2xxxxx) must never be mistaken for
   * ours.
   */
  async getPositions(internalSymbol?: string): Promise<CoinMPosition[]> {
    const params: Record<string, string> = {};
    let product: string | undefined;
    if (internalSymbol) {
      product = this.toProductSymbol(internalSymbol) ?? undefined;
      if (!product) return [];
      params.symbol = product;
    }
    // Class "protect": positionRisk is every close's convergence check and
    // the exposure-recovery read — must survive a 429 penalty window.
    const data = await this.signedRequest("GET", "/dapi/v1/positionRisk", params, "protect");
    if (!Array.isArray(data)) throw new Error(`CoinM positionRisk failed: ${(data as any)?.msg ?? "non-array response"}`);
    return data
      .filter((p: any) => (!product || p.symbol === product) && Number(p.positionAmt) !== 0)
      .map((p: any) => ({
        symbol: p.symbol,
        positionAmt: Number(p.positionAmt),
        entryPrice: Number(p.entryPrice),
        markPrice: Number(p.markPrice),
        unrealizedProfit: Number(p.unRealizedProfit ?? p.unrealizedProfit),
        leverage: Number(p.leverage),
        updateTime: Number(p.updateTime) || 0,
      }));
  }

  /** BTCUSD_PERP position only, or null if flat. Ownership-isolated by construction. */
  async getOwnedPosition(): Promise<CoinMPosition | null> {
    const list = await this.getPositions("BTC/COIN-M");
    return list[0] ?? null;
  }

  // ── Order placement (market, deterministic id, no blind retry) ─

  private async queryOrder(product: string, clientOrderId: string, cls: RequestClass = "trade"): Promise<any> {
    return this.signedRequest("GET", "/dapi/v1/order", { symbol: product, origClientOrderId: clientOrderId }, cls);
  }

  private async queryAlgoOrder(product: string, clientAlgoId: string): Promise<any> {
    const raw = await this.signedRequest("GET", "/dapi/v1/openAlgoOrders", { symbol: product });
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.orders) ? raw.orders : []);
    const found = list.find((o: any) => String(o.clientAlgoId) === clientAlgoId);
    if (!found) throw new Error(`algo order ${clientAlgoId} not found`);
    return found;
  }

  /**
   * Executes `submit`. ANY failure — timeout, network drop, malformed
   * response, or a Binance error code (including -4015 duplicate
   * clientOrderId) — is treated as AMBIGUOUS: we cannot know whether Binance
   * processed the request before the error surfaced. Reconciles by
   * re-querying the SAME deterministic order/algo id instead of ever
   * re-submitting (which would double real exposure). If the reconcile query
   * ALSO fails (genuinely never reached Binance), the ORIGINAL submit error
   * propagates — never blindly replayed.
   */
  private async submitOrReconcile<T>(submit: () => Promise<T>, query: () => Promise<T>): Promise<T> {
    try {
      return await submit();
    } catch (e: any) {
      try {
        return await query();
      } catch {
        throw e;
      }
    }
  }

  /**
   * Places (or, on an ambiguous prior submit, RE-QUERIES) a MARKET order and
   * polls to a terminal FILLED state. `intentId` seeds the deterministic
   * clientOrderId: if the broker reports -4015 (duplicate clientOrderId —
   * we already sent this exact intent), we query the existing order by that
   * id instead of POSTing again. Never fabricates a fill: returns null if
   * FILLED can't be confirmed within fillTimeoutMs.
   */
  async placeMarketOrder(opts: { internalSymbol: string; side: "buy" | "sell"; contracts: number; intentId: string }): Promise<CoinMOrderResult | null> {
    // Per-(venue,symbol) mutation lock (symbolLock.ts): an open must never
    // interleave with a concurrent close/stop mutation on the same product.
    // A lock timeout is a pre-transmit denial — null ("no fill, broker
    // unchanged") is truthful; the caller's normal retry cadence applies.
    return await symbolLocks.withLock("binance_dapi", opts.internalSymbol, { timeoutMs: this.lockTimeoutMs, label: `placeMarketOrder:${opts.intentId}` },
      () => this.placeMarketOrderUnderLock(opts),
      () => {
        log.error(`placeMarketOrder ${opts.internalSymbol}: symbol mutation lock not acquired — NOT submitting (another mutation is in flight)`);
        return null;
      });
  }

  private async placeMarketOrderUnderLock(opts: { internalSymbol: string; side: "buy" | "sell"; contracts: number; intentId: string }): Promise<CoinMOrderResult | null> {
    if (!this.connected) throw new Error("BinanceCoinMExecutor is not connected");
    const product = this.toProductSymbol(opts.internalSymbol);
    if (!product) throw new Error(`unsupported COIN-M symbol: ${opts.internalSymbol}`);
    if (!Number.isInteger(opts.contracts) || opts.contracts < 1) throw new Error("contracts must be a positive integer");

    const filters = await this.getFilters(opts.internalSymbol);
    const lotViolation = this.marketLotViolation(filters, opts.contracts);
    if (lotViolation) throw new Error(`CoinM market order rejected: ${lotViolation}`);

    const clientOrderId = deterministicClientOrderId(`open:${opts.intentId}`);
    const side = opts.side === "buy" ? "BUY" : "SELL";

    // Snapshot the EXACT pre-submit position. If the submit AND the
    // deterministic-id requery below BOTH fail, this is the only broker
    // truth that can distinguish "nothing happened" from "Binance filled it
    // but we lost every response" — a transport failure can lie about an
    // order's fate, never about the position.
    let beforeAmt = 0;
    let beforeReadFailed = false;
    try {
      beforeAmt = await this.readPositionAmt(opts.internalSymbol, product);
    } catch (e: any) {
      // This is unknown, not flat. Keep the order path usable, but do not use
      // an invented baseline to claim exposure recovery if submit is ambiguous.
      beforeReadFailed = true;
      log.warn(`CoinM open pre-position read unavailable for ${product}: ${e.message}`);
    }

    let initial: any;
    try {
      initial = await this.submitOrReconcile(
        () => this.signedRequest("POST", "/dapi/v1/order", {
          symbol: product, side, type: "MARKET", quantity: String(opts.contracts), newClientOrderId: clientOrderId,
        }),
        () => this.queryOrder(product, clientOrderId),
      );
    } catch (submitError: any) {
      if (!beforeReadFailed) {
        const recovered = await this.recoverExposureFromPositionDelta(opts.internalSymbol, product, beforeAmt, `open ${product} ${clientOrderId} (submit AND reconcile query both failed)`);
        if (recovered) return recovered;
      }
      throw submitError; // position genuinely unchanged — nothing was silently dropped
    }
    return this.pollUntilTerminal(product, clientOrderId, initial, opts.internalSymbol, beforeAmt);
  }

  /** Signed position amount for ONE product. A successful empty response is
   *  flat; a failed positionRisk read remains unknown and propagates. */
  private async readPositionAmt(internalSymbol: string, product: string): Promise<number> {
    const list = await this.getPositions(internalSymbol);
    return list.find(p => p.symbol === product)?.positionAmt ?? 0;
  }

  private marketLotViolation(filters: CoinMFilters, contracts: number): string | null {
    if (contracts < filters.marketLotMinQty) return `contracts ${contracts} below MARKET_LOT_SIZE minQty ${filters.marketLotMinQty}`;
    if (contracts > filters.marketLotMaxQty) return `contracts ${contracts} above MARKET_LOT_SIZE maxQty ${filters.marketLotMaxQty}`;
    if (filters.marketLotStepSize > 0) {
      const steps = contracts / filters.marketLotStepSize;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return `contracts ${contracts} not a multiple of MARKET_LOT_SIZE stepSize ${filters.marketLotStepSize}`;
    }
    return null;
  }

  /**
   * Last-resort exposure recovery when the order API couldn't tell us what
   * happened (ambiguous submit, or a poll/cancel cycle that never reached a
   * confirmed terminal state). The position read is independent broker
   * truth a transport failure can't lie about: any nonzero delta from
   * `beforeAmt` is REAL exposure that must never be silently dropped.
   * Recovers a price from the position's own entryPrice, falling back to
   * the public mark price — never fabricated. Returns null only when the
   * position genuinely didn't move (nothing to recover).
   */
  private async recoverExposureFromPositionDelta(internalSymbol: string, product: string, beforeAmt: number, context: string): Promise<CoinMOrderResult | null> {
    const afterList = await this.getPositions(internalSymbol);
    const afterPos = afterList?.find(p => p.symbol === product);
    const afterAmt = afterPos?.positionAmt ?? 0;
    const delta = Math.abs(Math.abs(afterAmt) - Math.abs(beforeAmt));
    if (!(delta > 0)) return null;

    let price = afterPos?.entryPrice && afterPos.entryPrice > 0 ? afterPos.entryPrice : 0;
    if (!(price > 0)) price = await this.getMarkPrice(internalSymbol);
    if (!(price > 0)) {
      log.error(`🚨🚨 CoinM ${context}: broker position moved by ${delta} contracts (before=${beforeAmt} after=${afterAmt}) but NO price is recoverable (entryPrice and markPrice both unavailable) — ORPHAN, MANUAL RECONCILE REQUIRED`);
      return { orderId: "unknown", clientOrderId: "unknown", status: "ORPHAN_UNRECOVERABLE_PRICE", avgPrice: 0, executedQty: delta };
    }
    log.error(`🚨 CoinM ${context}: AMBIGUOUS result but broker position moved by ${delta} contracts (before=${beforeAmt} after=${afterAmt}) — recovering ACTUAL exposure @ ${price}, never silently dropping it`);
    return { orderId: "unknown", clientOrderId: "unknown", status: "ORPHAN_RECOVERED", avgPrice: price, executedQty: delta };
  }

  private async pollUntilTerminal(product: string, clientOrderId: string, initial: any, internalSymbol: string, beforeAmt: number): Promise<CoinMOrderResult | null> {
    let status = String(initial?.status ?? "");
    let avgPrice = Number(initial?.avgPrice) || 0;
    let executedQty = Number(initial?.executedQty) || 0;
    let orderId = initial?.orderId;
    const deadline = Date.now() + this.cfg.fillTimeoutMs;

    while (status !== "FILLED" && Date.now() < deadline) {
      await this.sleep(this.cfg.pollDelayMs);
      const check = await this.queryOrder(product, clientOrderId).catch(() => null);
      if (check) {
        status = String(check.status ?? status);
        avgPrice = Number(check.avgPrice) || avgPrice;
        executedQty = Number(check.executedQty) || executedQty;
        orderId = check.orderId ?? orderId;
      }
    }
    if (status === "FILLED") return { orderId, clientOrderId, status, avgPrice, executedQty };

    // Timed out without FILLED. The order may still be NEW/PARTIALLY_FILLED
    // on the broker — cancel the EXACT residual (never a sweep) and verify a
    // terminal state before deciding what happened. A blind "return null"
    // here would leave a possibly-live, possibly-partially-filled order
    // dangling: the caller would think nothing opened while the broker holds
    // real, unprotected, unrecorded exposure.
    await this.signedRequest("DELETE", "/dapi/v1/order", { symbol: product, origClientOrderId: clientOrderId }).catch(() => {});
    const final = await this.queryOrder(product, clientOrderId).catch(() => null);
    if (final) {
      status = String(final.status ?? status);
      avgPrice = Number(final.avgPrice) || avgPrice;
      executedQty = Number(final.executedQty) || executedQty;
      orderId = final.orderId ?? orderId;
    }
    const terminal = ["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(status);
    if (!terminal) {
      log.error(`CoinM open ${product} ${clientOrderId}: cancel did not reach a terminal state (status=${status}) — checking broker position before giving up`);
      const recovered = await this.recoverExposureFromPositionDelta(internalSymbol, product, beforeAmt, `open ${product} ${clientOrderId} (untracked terminal state)`);
      if (recovered) return recovered;
      log.error(`CoinM open ${product} ${clientOrderId}: broker state unknown but position unchanged — reporting no fill`);
      return null;
    }
    // Recover the ACTUAL filled amount. Never fabricate a price: only report
    // a fill when both qty and price are positive (a clean cancel with 0
    // executedQty correctly returns null — nothing to install a stop for).
    if (executedQty > 0 && avgPrice > 0) {
      log.warn(`CoinM open ${product} ${clientOrderId}: timed out but partially filled ${executedQty} @ ${avgPrice} before cancel — reporting actual fill`);
      return { orderId, clientOrderId, status, avgPrice, executedQty };
    }
    // The order query itself settled to a terminal state with no reported
    // fill — cross-check the broker's ACTUAL position before trusting that
    // (an order-status query can be stale/wrong; the position cannot).
    return this.recoverExposureFromPositionDelta(internalSymbol, product, beforeAmt, `open ${product} ${clientOrderId} (terminal but unreported fill)`);
  }

  // ── Native STOP_MARKET (current DAPI algoOrder path) ───────────

  /**
   * Places a reduceOnly STOP_MARKET. Primary attempt is /dapi/v1/order; on
   * -4120 (this API build rejects conditional orders there — the same
   * behavior BinanceExecutor hit and fixed on FAPI, verified 2026-07-10) it
   * falls back to the CURRENT Algo Order API: POST /dapi/v1/algoOrder,
   * algoType=CONDITIONAL, triggerPrice. Tracks exactly one active stop per
   * product so cancelActiveStop is a targeted DELETE, never a sweep. The
   * trigger is FLOORED to PRICE_FILTER.tickSize (not just decimal-formatted)
   * — a tick like 0.25 rejects a price that merely has few decimals but
   * isn't an exact multiple of it.
   */
  async placeStopMarketClose(internalSymbol: string, positionSide: "buy" | "sell", stopPrice: number, contracts: number, intentId: string): Promise<{ ok: boolean; kind?: "order" | "algo"; id?: string }> {
    // Locked wrapper over the UNLOCKED core (ensureLiveStop, already holding
    // the lock, calls the core directly — the lock is NOT reentrant, by
    // design). Timeout = explicit {ok:false}; the ensure pass retries.
    return await symbolLocks.withLock("binance_dapi", internalSymbol, { timeoutMs: this.lockTimeoutMs, label: `placeStopMarketClose:${intentId}` },
      () => this.placeStopMarketCloseCore(internalSymbol, positionSide, stopPrice, contracts, intentId),
      () => {
        log.warn(`placeStopMarketClose ${internalSymbol}: symbol mutation lock not acquired — stop NOT placed (another mutation is in flight)`);
        return { ok: false };
      });
  }

  private async placeStopMarketCloseCore(internalSymbol: string, positionSide: "buy" | "sell", stopPrice: number, contracts: number, intentId: string): Promise<{ ok: boolean; kind?: "order" | "algo"; id?: string }> {
    const product = this.toProductSymbol(internalSymbol);
    if (!product || !(stopPrice > 0) || !Number.isInteger(contracts) || contracts < 1) return { ok: false };
    const filters = await this.getFilters(internalSymbol);
    const stopPx = floorToStep(stopPrice, filters.tickSize).toFixed(filters.pricePrecision);
    const side = positionSide === "buy" ? "SELL" : "BUY"; // stop closes the position
    const clientOrderId = deterministicClientOrderId(`stop:${intentId}`);

    try {
      await this.submitOrReconcile(
        () => this.signedRequest("POST", "/dapi/v1/order", {
          symbol: product, side, type: "STOP_MARKET", stopPrice: stopPx, quantity: String(contracts),
          workingType: "MARK_PRICE", reduceOnly: "true", newClientOrderId: clientOrderId,
        }, "protect"),
        () => this.queryOrder(product, clientOrderId, "protect"),
      );
      this.activeStops.set(product, { kind: "order", id: clientOrderId });
      return { ok: true, kind: "order", id: clientOrderId };
    } catch (e: any) {
      if (e?.code !== -4120) {
        log.warn(`STOP_MARKET rejected for ${product}: ${e.message}`);
        return { ok: false };
      }
      try {
        const result = await this.submitOrReconcile(
          () => this.signedRequest("POST", "/dapi/v1/algoOrder", {
            algoType: "CONDITIONAL", symbol: product, side, type: "STOP_MARKET",
            triggerPrice: stopPx, quantity: String(contracts), reduceOnly: "true",
            workingType: "MARK_PRICE", clientAlgoId: clientOrderId,
          }, "protect"),
          () => this.queryAlgoOrder(product, clientOrderId),
        );
        const algoId = String(result?.algoId ?? clientOrderId);
        this.activeStops.set(product, { kind: "algo", id: algoId });
        return { ok: true, kind: "algo", id: algoId };
      } catch (e2: any) {
        log.warn(`STOP_MARKET algoOrder fallback failed for ${product}: ${e2.message}`);
        return { ok: false };
      }
    }
  }

  private async cancelOrderById(product: string, stop: { kind: "order" | "algo"; id: string }): Promise<boolean> {
    try {
      if (stop.kind === "order") {
        await this.signedRequest("DELETE", "/dapi/v1/order", { symbol: product, origClientOrderId: stop.id }, "protect");
      } else {
        await this.signedRequest("DELETE", "/dapi/v1/algoOrder", { symbol: product, algoId: stop.id }, "protect");
      }
      return true;
    } catch (e: any) {
      log.warn(`cancel stop failed for ${product} (${stop.kind} ${stop.id}): ${e.message}`);
      return false;
    }
  }

  /**
   * Queries DAPI directly for open reduceOnly STOP_MARKET orders/algo-orders
   * on `product` that carry THIS executor's clientOrderId/clientAlgoId
   * namespace — every "owned" stop this executor could have placed,
   * regardless of whether the in-memory activeStops map still knows about it
   * (it resets on every process restart). Never a generic order sweep: only
   * STOP_MARKET + reduceOnly + namespace-matched rows for THIS exact product
   * qualify. The namespace check is what keeps a foreign/manual reduceOnly
   * stop (same product, same type, placed by a human or another bot) from
   * ever being adopted or canceled by this reconcile.
   *
   * Either endpoint FAILING (transport error) or returning a MALFORMED
   * payload (not an array, and for openAlgoOrders not `{orders: [...]}`
   * either) THROWS — never silently degrades to a partial/empty list. Owned
   * stop state is either fully known or unknown; unknown must never be
   * coerced into "no stops found", because every caller (reconcile, cert
   * verification) treats an empty list as "clean" and would wrongly cancel
   * a real protecting stop or approve an unprotected position.
   */
  private async queryOwnedStops(product: string): Promise<Array<OwnedStop>> {
    const found: Array<OwnedStop> = [];
    // Class "protect": this read decides whether a position is protected.
    const orders = await this.signedRequest("GET", "/dapi/v1/openOrders", { symbol: product }, "protect");
    if (!Array.isArray(orders)) throw new Error(`CoinM openOrders malformed response for ${product}: expected an array`);
    for (const o of orders) {
      if (String(o.symbol) === product && String(o.type).includes("STOP") && isReduceOnlyFlag(o.reduceOnly) && isOwnedClientId(o.clientOrderId)) {
        found.push({
          kind: "order", id: String(o.clientOrderId),
          side: String(o.side ?? "").toUpperCase(),
          quantity: Number(o.origQty) || 0,
          triggerPrice: Number(o.stopPrice) || 0,
        });
      }
    }
    // Real DAPI algo-order shape: order type is `orderType` (not `type`),
    // open/pending state is `algoStatus` (not a generic `status`), and
    // `reduceOnly` can arrive as a boolean. Never match on the wrong
    // field names here — a silent no-match means an owned stop looks
    // invisible to reconcile/cancel.
    const raw = await this.signedRequest("GET", "/dapi/v1/openAlgoOrders", { symbol: product }, "protect");
    const algos = Array.isArray(raw) ? raw : (Array.isArray(raw?.orders) ? raw.orders : null);
    if (algos === null) throw new Error(`CoinM openAlgoOrders malformed response for ${product}: expected an array or {orders: [...]}`);
    for (const o of algos) {
      const orderType = String(o.orderType ?? o.type ?? "");
      const algoStatus = String(o.algoStatus ?? o.status ?? "").toUpperCase();
      const isOpen = !ALGO_TERMINAL_STATUSES.has(algoStatus);
      if (String(o.symbol) === product && orderType.includes("STOP") && isOpen && isReduceOnlyFlag(o.reduceOnly) && isOwnedClientId(o.clientAlgoId)) {
        found.push({
          kind: "algo", id: String(o.algoId),
          side: String(o.side ?? "").toUpperCase(),
          quantity: Number(o.totalQty ?? o.origQty) || 0,
          triggerPrice: Number(o.triggerPrice) || 0,
        });
      }
    }
    return found;
  }

  /**
   * Read-only, public: lists every reduceOnly STOP_MARKET order/algo-order
   * this executor could own for `internalSymbol`, regardless of in-memory
   * tracking. Never mutates anything (no cancel/adopt) — the safe precheck
   * seam for certification, which needs to see REAL broker state before
   * init()'s own (optionally-skipped) mutating reconcile could have already
   * altered it.
   */
  async listOwnedStops(internalSymbol: string): Promise<Array<OwnedStop>> {
    const product = this.toProductSymbol(internalSymbol);
    if (!product) return [];
    return this.queryOwnedStops(product);
  }

  /** Verify/repair the broker-native protection for a live position. Foreign
   * orders are intentionally invisible to this method and are never touched. */
  async ensureLiveStop(internalSymbol: string, position: CoinMPosition, stopLoss: number): Promise<boolean> {
    // Holds the symbol lock across its whole verify→cancel→replace sequence
    // (calling the UNLOCKED cores) so a concurrent close can never interleave
    // between the cancel and the re-install. Timeout = false (unprotected —
    // the caller fails closed, exactly as on genuinely missing protection).
    return await symbolLocks.withLock("binance_dapi", internalSymbol, { timeoutMs: this.lockTimeoutMs, label: "ensureLiveStop" },
      () => this.ensureLiveStopUnderLock(internalSymbol, position, stopLoss),
      () => {
        log.warn(`ensureLiveStop ${internalSymbol}: symbol mutation lock not acquired — reporting unprotected (another mutation is in flight)`);
        return false;
      });
  }

  private async ensureLiveStopUnderLock(internalSymbol: string, position: CoinMPosition, stopLoss: number): Promise<boolean> {
    if (!(stopLoss > 0) || position.positionAmt === 0) return false;
    const filters = await this.getFilters(internalSymbol).catch(() => null);
    if (!filters) return false;
    const expectedSide = position.positionAmt > 0 ? "SELL" : "BUY";
    const expectedQty = Math.abs(position.positionAmt);
    const expectedTrigger = floorToStep(stopLoss, filters.tickSize);
    const matches = (s: OwnedStop) => s.side === expectedSide &&
      Math.abs(s.quantity - expectedQty) <= 1e-6 &&
      Math.abs(s.triggerPrice - expectedTrigger) <= Math.max(filters.tickSize / 2, 1e-9);
    let owned: OwnedStop[];
    try {
      owned = await this.listOwnedStops(internalSymbol);
    } catch (e: any) {
      // Unknown state must never fall through to "no stop found -> repair":
      // that would blindly cancel+replace a stop that might already be
      // correctly protecting the position. Report unprotected — the caller
      // (AccountManager) fails closed on that, exactly as it should on
      // genuinely missing protection.
      log.warn(`ensureLiveStop: owned-stop query failed for ${internalSymbol}, state unknown: ${e.message}`);
      return false;
    }
    if (owned.some(matches)) return true;
    // Cores, not the locked wrappers: this body already holds the lock.
    await this.cancelActiveStopCore(internalSymbol);
    const placed = await this.placeStopMarketCloseCore(internalSymbol, position.positionAmt > 0 ? "buy" : "sell", stopLoss, expectedQty, `reconcile:${Date.now()}`);
    if (!placed.ok) return false;
    let verified: OwnedStop[];
    try {
      verified = await this.listOwnedStops(internalSymbol);
    } catch (e: any) {
      log.warn(`ensureLiveStop: post-install owned-stop query failed for ${internalSymbol}, state unknown: ${e.message}`);
      return false;
    }
    return verified.some(matches);
  }

  /**
   * Exact, product-scoped cancel of the tracked native stop. Never a blind
   * sweep. If nothing is tracked in memory (e.g. after a process restart —
   * activeStops doesn't survive one) this does NOT assume "untracked" means
   * "doesn't exist": it queries the exchange directly and cancels whatever
   * owned reduceOnly BTCUSD_PERP stop it actually finds there.
   */
  async cancelActiveStop(internalSymbol: string): Promise<boolean> {
    // Locked wrapper over the UNLOCKED core (see placeStopMarketClose).
    // Timeout = false — "not cleared", never "nothing was there".
    return await symbolLocks.withLock("binance_dapi", internalSymbol, { timeoutMs: this.lockTimeoutMs, label: "cancelActiveStop" },
      () => this.cancelActiveStopCore(internalSymbol),
      () => {
        log.warn(`cancelActiveStop ${internalSymbol}: symbol mutation lock not acquired — stop NOT cleared (another mutation is in flight)`);
        return false;
      });
  }

  private async cancelActiveStopCore(internalSymbol: string): Promise<boolean> {
    const product = this.toProductSymbol(internalSymbol);
    if (!product) return false;
    let active = this.activeStops.get(product);
    if (!active) {
      let owned: OwnedStop[];
      try {
        owned = await this.queryOwnedStops(product);
      } catch (e: any) {
        // Unknown state is never "genuinely nothing to cancel" — reporting
        // true here would let a caller believe protection was cleared when
        // it might still be sitting on the exchange, unverified.
        log.warn(`cancelActiveStop: owned-stop query failed for ${product}, state unknown: ${e.message}`);
        return false;
      }
      if (owned.length === 0) return true; // genuinely nothing to cancel
      active = owned[0];
      for (const dup of owned.slice(1)) await this.cancelOrderById(product, dup);
    }
    const ok = await this.cancelOrderById(product, active);
    if (ok) this.activeStops.delete(product);
    return ok;
  }

  hasTrackedStop(internalSymbol: string): boolean {
    const product = this.toProductSymbol(internalSymbol);
    return !!product && this.activeStops.has(product);
  }

  /**
   * Startup/reconcile: query the exchange for owned reduceOnly BTCUSD_PERP
   * stops that the in-memory activeStops map doesn't know about (a fresh
   * process always starts with an empty map). If a position is currently
   * live, ADOPT the found stop (re-track it) rather than canceling it — a
   * restart must never strip protection off a live position. If the account
   * is flat, every such stop is an orphan (nothing left for it to reduce,
   * but it would wrongly sit armed against a FUTURE position) and gets
   * canceled. Duplicates beyond the first are always canceled either way —
   * exactly one native stop should ever protect this product.
   */
  private async reconcileStartupStops(internalSymbol: string): Promise<void> {
    const product = this.toProductSymbol(internalSymbol);
    if (!product) return;
    // A queryOwnedStops failure (transport error or malformed payload) must
    // propagate — never coerce to "no owned stops" here. That used to be
    // silently absorbed inside queryOwnedStops itself; letting it throw now
    // makes this genuinely fail closed (init() below catches and refuses to
    // start), matching the intent already documented below.
    const owned = await this.queryOwnedStops(product);
    if (owned.length === 0) return;
    // Owned stop(s) exist — whether to ADOPT (live position) or CANCEL
    // (flat, orphaned) depends entirely on this read. A transport/read
    // failure here must NEVER be coerced to "flat": that would wrongly
    // cancel a stop that could be protecting a real position. Let it
    // propagate — the caller (init) fails closed instead of guessing.
    const position = await this.getOwnedPosition();
    if (position && position.positionAmt !== 0) {
      this.activeStops.set(product, owned[0]);
      for (const dup of owned.slice(1)) await this.cancelOrderById(product, dup);
    } else {
      for (const o of owned) await this.cancelOrderById(product, o);
      this.activeStops.delete(product);
    }
  }

  // ── Close position (reduceOnly market, convergence-verified) ──

  /**
   * Closes `contracts` of the position via a reduceOnly MARKET order.
   * "Converged" means EITHER the close order itself reports FILLED, OR a
   * broker position re-read shows the position reduced — a genuine
   * independent confirmation, not an assumption. Never fabricates a fill
   * price: if avgPrice never settles, returns success:false.
   */
  async closePosition(internalSymbol: string, contracts: number, side: "buy" | "sell", intentId: string): Promise<CoinMCloseResult> {
    // Per-(venue,symbol) mutation lock: two concurrent closes for the same
    // product would both pass the pre-check against the SAME broker qty and
    // both transmit — serialized, the second pre-check sees the truth. A
    // lock timeout is an explicit pre-transmit failure (success:false, no
    // fill fabricated); the caller retries on its own cadence.
    return await symbolLocks.withLock("binance_dapi", internalSymbol, { timeoutMs: this.lockTimeoutMs, label: `closePosition:${intentId}` },
      () => this.closePositionUnderLock(internalSymbol, contracts, side, intentId),
      () => {
        log.warn(`closePosition ${internalSymbol}: symbol mutation lock not acquired — close NOT submitted (another mutation is in flight)`);
        return { success: false, filledPrice: 0, executedQty: 0, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" };
      });
  }

  private async closePositionUnderLock(internalSymbol: string, contracts: number, side: "buy" | "sell", intentId: string): Promise<CoinMCloseResult> {
    const fail: CoinMCloseResult = { success: false, filledPrice: 0, executedQty: 0, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" };
    if (!this.connected) return fail;
    const product = this.toProductSymbol(internalSymbol);
    if (!product || !Number.isInteger(contracts) || contracts < 1) return fail;

    let before: number | null = null;
    try {
      const pos = (await this.getPositions(internalSymbol)).find(p => p.symbol === product);
      before = Math.abs(pos?.positionAmt ?? 0);
      if (before === 0) return fail;
    } catch (e: any) {
      log.error(`CoinM close pre-check unavailable for ${product}: ${e.message} — state unknown, refusing close`);
      return fail;
    }

    const filters = await this.getFilters(internalSymbol).catch((e: any) => {
      log.warn(`CoinM close: filters unavailable for ${product}, skipping lot validation: ${e.message}`);
      return null;
    });
    if (filters) {
      const lotViolation = this.marketLotViolation(filters, contracts);
      if (lotViolation) { log.error(`CoinM close rejected for ${product}: ${lotViolation}`); return fail; }
    }

    const closeSide = side === "buy" ? "SELL" : "BUY";
    const clientOrderId = deterministicClientOrderId(`close:${intentId}`);
    let initial: any;
    try {
      initial = await this.submitOrReconcile(
        () => this.signedRequest("POST", "/dapi/v1/order", {
          symbol: product, side: closeSide, type: "MARKET", quantity: String(contracts),
          reduceOnly: "true", newClientOrderId: clientOrderId,
        }, "protect"),
        () => this.queryOrder(product, clientOrderId, "protect"),
      );
    } catch (e: any) {
      // AMBIGUOUS: the POST AND the deterministic-id requery BOTH failed —
      // same discipline as placeMarketOrder's submitOrReconcile (see
      // recoverExposureFromPositionDelta above). A transport failure can lie
      // about an order's fate, never about the position: re-read the EXACT
      // broker position before ever reporting failure. Blind-replaying the
      // close here would risk a caller re-issuing it for size that's
      // already gone; blindly failing would leave a real reduction
      // unreported. Only fall back to `fail` when the position genuinely
      // didn't move.
      if (before !== null) {
        const recovered = await this.recoverCloseFromPositionDelta(internalSymbol, product, before, `close ${product} ${clientOrderId} (submit AND reconcile query both failed)`);
        if (recovered.success) return recovered;
      }
      log.error(`CoinM close rejected for ${product}: ${e.message}`);
      return fail;
    }

    let status = String(initial?.status ?? "");
    let avgPrice = Number(initial?.avgPrice) || 0;
    let executedQty = Number(initial?.executedQty) || 0;
    let orderId: any = initial?.orderId;
    let converged = status === "FILLED";
    const deadline = Date.now() + this.cfg.closeTimeoutMs;

    while (!converged && Date.now() < deadline) {
      await this.sleep(this.cfg.pollDelayMs);
      const check = await this.queryOrder(product, clientOrderId, "protect").catch(() => null);
      if (check) {
        status = String(check.status ?? status);
        avgPrice = Number(check.avgPrice) || avgPrice;
        executedQty = Number(check.executedQty) || executedQty;
        orderId = check.orderId ?? orderId;
      }
      if (status === "FILLED") { converged = true; break; }
      if (before !== null) {
        try {
          const after = (await this.getPositions(internalSymbol)).find(p => p.symbol === product);
          const afterAmt = Math.abs(after?.positionAmt ?? 0);
          if (afterAmt < before) { converged = true; break; } // independent position-based confirmation
        } catch (e: any) {
          log.warn(`CoinM close position verification unavailable for ${product}: ${e.message}`);
        }
      }
    }
    if (!converged) {
      // Cancel the exact residual close order (never a sweep) and verify a
      // terminal state before deciding what actually happened — the same
      // reconciliation discipline as the open path. A reduceOnly MARKET
      // order can still be PARTIALLY_FILLED at the deadline; report the
      // ACTUAL reduction instead of a blanket failure so the caller never
      // re-issues a duplicate close for size that's already gone.
      await this.signedRequest("DELETE", "/dapi/v1/order", { symbol: product, origClientOrderId: clientOrderId }, "protect").catch(() => {});
      const final = await this.queryOrder(product, clientOrderId, "protect").catch(() => null);
      if (final) {
        status = String(final.status ?? status);
        avgPrice = Number(final.avgPrice) || avgPrice;
        executedQty = Number(final.executedQty) || executedQty;
        orderId = final.orderId ?? orderId;
      }
      const terminal = ["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(status);
      if (!terminal || !(avgPrice > 0)) {
        log.warn(`CoinM close ${product}: not confirmed FILLED or reduced within ${this.cfg.closeTimeoutMs}ms`);
        return fail;
      }
      // EXACT post-position reconciliation — never trust the order's own
      // executedQty as "the full reduction" on its own. Any partial fill
      // must report ONLY what the broker's position actually lost.
      const actualClosedQty = await this.measureClosedQty(internalSymbol, product, before, executedQty);
      if (!(actualClosedQty > 0)) {
        log.warn(`CoinM close ${product}: not confirmed FILLED or reduced within ${this.cfg.closeTimeoutMs}ms`);
        return fail;
      }
      log.warn(`CoinM close ${product}: timed out but partially reduced ${actualClosedQty} @ ${avgPrice} before cancel — reporting actual reduction`);
      const settlement = await this.fetchOrderSettlement(product, orderId);
       return { success: true, filledPrice: avgPrice,
         executedQty: settlement.executedQty > 0 ? settlement.executedQty : actualClosedQty,
         realizedPnlNative: settlement.realizedPnlNative, commissionNative: settlement.commissionNative,
         commissionAsset: settlement.commissionAsset };
    }
    if (!(avgPrice > 0)) {
      const final = await this.queryOrder(product, clientOrderId, "protect").catch(() => null);
      avgPrice = Number(final?.avgPrice) || 0;
      executedQty = Number(final?.executedQty) || executedQty;
      orderId = final?.orderId ?? orderId;
    }
    if (!(avgPrice > 0)) {
      log.warn(`CoinM close ${product}: converged but no settled fill price`);
      return fail;
    }
    // NEVER `executedQty || contracts` — a FILLED status with a missing/zero
    // executedQty field must never silently fall back to the REQUESTED
    // amount. Cross-check the broker's own position delta (broker = truth).
    // A failed position read is unknown, so measureClosedQty fails closed
    // instead of treating executedQty as proof of the reduction.
    const actualClosedQty = await this.measureClosedQty(internalSymbol, product, before, executedQty);
    if (!(actualClosedQty > 0)) {
      log.warn(`CoinM close ${product}: order reports FILLED but no actual position reduction confirmed`);
      return fail;
    }
    const settlement = await this.fetchOrderSettlement(product, orderId);
    return { success: true, filledPrice: avgPrice,
      executedQty: settlement.executedQty > 0 ? settlement.executedQty : actualClosedQty,
      realizedPnlNative: settlement.realizedPnlNative, commissionNative: settlement.commissionNative,
      commissionAsset: settlement.commissionAsset };
  }

  /**
   * Broker-settled realizedPnl/commission (native asset, e.g. BTC) for ONE
   * close order, scoped by orderId — every fill /dapi/v1/userTrades returns
   * for that orderId is summed exactly once (never a symbol-wide sweep that
   * could pick up an unrelated order's fills). Returns zeros/"" (never
   * fabricated) when orderId is unknown or the query itself fails — callers
   * fall back to their own price-delta PnL math in that case.
   */
  private async fetchOrderSettlement(product: string, orderId: any): Promise<CoinMUserTradeSettlement> {
    const empty = { realizedPnlNative: 0, commissionNative: 0, commissionAsset: "", executedQty: 0, averagePrice: 0 };
    if (orderId === undefined || orderId === null || orderId === "unknown") return empty;
    try {
      const trades = await this.signedRequest("GET", "/dapi/v1/userTrades", { symbol: product, orderId: String(orderId), limit: "50" }, "protect");
      if (!Array.isArray(trades)) return empty;
      let realizedPnlNative = 0, commissionNative = 0, commissionAsset = "", executedQty = 0, notional = 0;
      for (const t of trades) {
        realizedPnlNative += parseFloat(t.realizedPnl || "0");
        commissionNative += parseFloat(t.commission || "0");
        const qty = Number(t.qty ?? t.quantity);
        const price = Number(t.price);
        if (qty > 0) { executedQty += qty; if (price > 0) notional += qty * price; }
        if (!commissionAsset && t.commissionAsset) commissionAsset = String(t.commissionAsset);
      }
      return { realizedPnlNative, commissionNative, commissionAsset, executedQty, averagePrice: executedQty > 0 ? notional / executedQty : 0 };
    } catch (e: any) {
      log.warn(`CoinM userTrades settlement unavailable for ${product} order ${orderId}: ${e.message}`);
      return empty;
    }
  }

  /** Cumulative close fills from DAPI userTrades, used only for abnormal
   * reconciliation when an order id was lost. The side filter excludes the
   * original entry fills (and their commissions). */
  async getCloseSettlementSince(internalSymbol: string, side: "buy" | "sell", since: number): Promise<CoinMUserTradeSettlement> {
    const empty = { realizedPnlNative: 0, commissionNative: 0, commissionAsset: "", executedQty: 0, averagePrice: 0 };
    const product = this.toProductSymbol(internalSymbol);
    if (!product) return empty;
    try {
      const now = Date.now();
      const startTime = Math.max(since, now - 7 * 24 * 60 * 60_000);
      const rows = await this.signedRequest("GET", "/dapi/v1/userTrades", {
        symbol: product,
        startTime: String(Math.max(0, startTime)),
        endTime: String(now),
        limit: "1000",
      });
      if (!Array.isArray(rows)) return empty;
      const closeSide = side === "buy" ? "SELL" : "BUY";
      let qty = 0, notional = 0, realized = 0, commission = 0, asset = "";
      for (const row of rows) {
        if (String(row.side ?? "").toUpperCase() !== closeSide) continue;
        const q = Number(row.qty ?? row.quantity);
        const px = Number(row.price);
        if (!(q > 0) || !(px > 0)) continue;
        qty += q; notional += q * px;
        realized += Number(row.realizedPnl || 0);
        commission += Number(row.commission || 0);
        if (!asset && row.commissionAsset) asset = String(row.commissionAsset);
      }
      return { realizedPnlNative: realized, commissionNative: commission, commissionAsset: asset, executedQty: qty, averagePrice: qty > 0 ? notional / qty : 0 };
    } catch (e: any) {
      log.warn(`CoinM close settlement reconciliation unavailable for ${product}: ${e.message}`);
      return empty;
    }
  }

  /**
   * Determines the EXACT quantity actually closed. Never trusts a positive
   * `executedQty` ALONE when the position is readable: it ALWAYS attempts
   * an exact position-delta reconciliation and takes whichever source
   * reports the LARGER reduction. Both directions of error are real —
   * a stale/lagging position feed must never make this UNDER-report a real
   * close (the original concern with cross-checking), and an order response
   * that under-counts its own fill must never UNDER-report either (the
   * `executedQty || contracts` bug this function replaced, which guessed
   * the REQUESTED amount on a missing/zero field). Never fabricates a
   * quantity: returns 0 (never `contracts`) when neither source has
   * anything to report.
   */
  private async measureClosedQty(internalSymbol: string, product: string, before: number | null, orderExecutedQty: number): Promise<number> {
    let delta = 0;
    if (before !== null) {
      try {
        const after = (await this.getPositions(internalSymbol)).find(p => p.symbol === product);
        const afterAmt = Math.abs(after?.positionAmt ?? 0);
        delta = Math.max(0, before - afterAmt);
      } catch (e: any) {
        throw new Error(`CoinM close position verification failed for ${product}: ${e.message}`);
      }
    }
    return Math.max(orderExecutedQty > 0 ? orderExecutedQty : 0, delta);
  }

  /**
   * Last-resort exposure recovery for closePosition when the POST AND the
   * deterministic-id requery BOTH failed (see submitOrReconcile). Mirrors
   * recoverExposureFromPositionDelta's discipline for the open path: the
   * position read is independent broker truth a transport failure can't
   * lie about. Recovers a fill price from the position's own entryPrice,
   * falling back to the public mark price — never fabricated. Returns
   * success:false when the position genuinely didn't move (nothing to
   * recover) or when no price is recoverable at all.
   */
  private async recoverCloseFromPositionDelta(internalSymbol: string, product: string, before: number, context: string): Promise<CoinMCloseResult> {
    const fail: CoinMCloseResult = { success: false, filledPrice: 0, executedQty: 0, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" };
    const afterList = await this.getPositions(internalSymbol);
    const afterPos = afterList?.find(p => p.symbol === product);
    const afterAmt = Math.abs(afterPos?.positionAmt ?? 0);
    const reduced = Math.max(0, before - afterAmt);
    if (!(reduced > 0)) return fail;

    let price = afterPos?.entryPrice && afterPos.entryPrice > 0 ? afterPos.entryPrice : 0;
    if (!(price > 0)) price = await this.getMarkPrice(internalSymbol);
    if (!(price > 0)) {
      log.error(`🚨🚨 CoinM ${context}: broker position reduced by ${reduced} contracts (before=${before} after=${afterAmt}) but NO price is recoverable (entryPrice and markPrice both unavailable) — ORPHAN, MANUAL RECONCILE REQUIRED`);
      return fail;
    }
    // No confirmed orderId exists on this ambiguous-recovery path (both the
    // submit AND the reconcile query failed) — settlement is genuinely
    // unavailable here, never fabricated as 0-but-real.
    log.error(`🚨 CoinM ${context}: AMBIGUOUS result but broker position reduced by ${reduced} contracts (before=${before} after=${afterAmt}) — recovering ACTUAL reduction @ ${price}, never blind-replaying the close`);
    return { success: true, filledPrice: price, executedQty: reduced, realizedPnlNative: 0, commissionNative: 0, commissionAsset: "" };
  }
}
