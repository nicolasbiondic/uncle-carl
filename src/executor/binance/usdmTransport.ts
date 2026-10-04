// ══════════════════════════════════════════════
// Binance USDⓈ-M REST transport seam (2026-10-02)
// ══════════════════════════════════════════════
//
// One interface, two implementations, selected by BINANCE_TRANSPORT:
//
//  - "legacy" (default): the hand-rolled HMAC-signed fetch layer MOVED
//    VERBATIM out of BinanceExecutor (signedRequest / limitedFetch /
//    notePenaltyStatus). Behavior is byte-identical to the pre-seam executor.
//  - "sdk": the official @binance/derivatives-trading-usds-futures client
//    (MIT, generated from Binance's OpenAPI spec), pinned at 38.1.2.
//
// Both implementations keep the SAME hard contracts the executor's order
// taxonomy depends on (every one is pinned by usdmTransport.contract.test.ts,
// which runs the SAME battery against both transports over a fake FAPI
// server):
//
//  1. The shared venue rate limiter is acquired BEFORE anything is
//     transmitted; a denial throws an Error with `rateLimitDenied: true` —
//     callers may treat it as a PROVEN non-submission.
//  2. No hidden retries. The SDK's own retry machinery (retries default 3 on
//     GET/DELETE) is configured to 0 — retry policy belongs to the caller; a
//     transparently re-sent POST is a duplicate order. (The SDK never retried
//     POSTs anyway; 0 removes the class entirely.)
//  3. Venue errors are normalized to the legacy Error shape: `.code` carries
//     Binance's body error code (-2019, -2011, -1021, -4120, …), and
//     `.httpStatus` the HTTP status when one exists. A transport-level
//     failure (timeout, disconnect) carries NEITHER — the executor's
//     isVenueRejection() therefore classifies it as ambiguous and resolves by
//     idempotent-client-id QUERY, never a resend.
//  4. 429/418 feed the limiter's penalty window. The legacy path honors
//     Retry-After exactly; the SDK's error path does NOT expose response
//     headers (TooManyRequestsError/RateLimitBanError carry only code+msg),
//     so the SDK transport applies the limiter's configured default penalty
//     windows instead — documented divergence, strictly more conservative
//     than ignoring the 429.
//  5. Timeouts are bounded per request (fetchT's 10s default on both paths).
//
// The SDK transport maps (method, path, params) → a generated SDK call via
// an explicit allowlist. Two fail-closed rules protect order integrity:
//  - an unmapped route throws (never a silent fallback to raw HTTP);
//  - a param the route does not explicitly consume throws (the generated SDK
//    whitelists query params per endpoint — a silently DROPPED `stopPrice`
//    would turn a protective stop into a naked market order).
// Conditional orders on POST /fapi/v1/order are rejected pre-transmit with
// the venue's own documented -4120 ("use the Algo Order API"): this SDK/API
// generation only models MARKET/LIMIT there (NewOrderTypeEnum), exactly the
// contract the sandbox enforces server-side, and the executor already owns
// the -4120 → /fapi/v1/algoOrder fallback.
// ══════════════════════════════════════════════

import crypto from "crypto";
import https from "https";
import {
  DerivativesTradingUsdsFutures,
  BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError,
  RateLimitBanError, TooManyRequestsError, ServerError, ConnectorClientError,
  RequiredError,
} from "@binance/derivatives-trading-usds-futures";
import { fetchT } from "../../utils/timeout";
import { createLogger } from "../../utils/logger";
import { retryAfterMsFromHeaders, type RequestClass, type VenueRateLimiter } from "../rateLimiter";

// Same logger context the executor always used for these lines — the moved
// code must keep its error-burst shape and page stamps.
const log = createLogger("BinanceExecutor");

export type UsdmHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type BinanceTransportKind = "legacy" | "sdk";

/** Minimal Response-shaped envelope for the UNSIGNED endpoints so every
 *  caller's existing per-endpoint `ok` handling stays byte-identical
 *  (getPrice ignores ok; bookTicker/depth return null on !ok; assetIndex
 *  returns 0; exchangeInfo throws). The legacy transport returns the fetch
 *  Response itself (it satisfies this structurally). */
export interface PublicRestResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

export interface BinanceUsdmTransport {
  readonly kind: BinanceTransportKind;
  /** Signed REST call. Returns the parsed JSON body. Throws:
   *   - `{ rateLimitDenied: true }` pre-transmit on a limiter denial;
   *   - `{ code, httpStatus }` on a venue rejection;
   *   - a bare Error on transport-level failures (ambiguous after transmit). */
  signedRequest(method: UsdmHttpMethod, path: string, params?: Record<string, string>, cls?: RequestClass): Promise<any>;
  /** Unsigned public REST call under the same limiter contract. */
  publicRequest(path: string, query?: Record<string, string>, cls?: RequestClass): Promise<PublicRestResponse>;
  /** GET /fapi/v1/time — the connect-time drift probe. Deliberately NOT
   *  limiter-gated (matches the legacy init() call it replaces). */
  serverTime(): Promise<PublicRestResponse>;
}

/** Live accessors into the owning executor — tests mutate exec.baseUrl /
 *  exec.apiKey after construction and the transport must see it. */
export interface UsdmTransportContext {
  baseUrl(): string;
  apiKey(): string;
  secretKey(): string;
  limiter(): VenueRateLimiter;
  /** Per-request timeout. Default undefined = fetchT's own 10s. */
  timeoutMs?: number;
}

function rateLimitDeniedError(reason: string | undefined): Error & { rateLimitDenied: boolean } {
  const denied = new Error(`rate_limited: ${reason}`) as Error & { rateLimitDenied: boolean };
  denied.rateLimitDenied = true;
  return denied;
}

async function acquireOrThrow(ctx: UsdmTransportContext, cls: RequestClass): Promise<void> {
  // Venue rate limiter: a denial here happens BEFORE anything is
  // transmitted — callers may safely treat it as a proven non-submission.
  const acq = await ctx.limiter().acquire(cls);
  if (!acq.ok) throw rateLimitDeniedError(acq.reason);
}

// ── Legacy transport: the executor's own code, moved verbatim ─────────────

class LegacyUsdmTransport implements BinanceUsdmTransport {
  readonly kind = "legacy" as const;
  constructor(private readonly ctx: UsdmTransportContext) {}

  private sign(queryString: string): string {
    return crypto.createHmac("sha256", this.ctx.secretKey()).update(queryString).digest("hex");
  }

  /** Record a 429/418 the venue just returned. Binance limits by IP weight;
   *  a 429 is a warning, an insistent client gets a 418 (temporary IP BAN)
   *  — the 418 is loud on purpose and freezes ALL traffic on this venue
   *  (both FAPI instances) until the ban passes. Retry-After is honored
   *  exactly when present. */
  private notePenaltyStatus(resp: Response | PublicRestResponse, path: string): void {
    if (resp.status !== 429 && resp.status !== 418) return;
    const retryAfterMs = retryAfterMsFromHeaders((resp as Response).headers);
    this.ctx.limiter().notePenalty(resp.status as 429 | 418, retryAfterMs);
    if (resp.status === 418) {
      log.error(`🚨🚨 Binance FAPI returned HTTP 418 (temporary IP BAN) on ${path} — ALL FAPI traffic frozen${retryAfterMs ? ` for ${retryAfterMs}ms (Retry-After)` : ""}; continuing to send would extend the ban`);
    } else {
      log.warn(`Binance FAPI returned HTTP 429 on ${path} — rate-limit penalty window opened${retryAfterMs ? ` (Retry-After ${retryAfterMs}ms)` : ""}`);
    }
  }

  async signedRequest(method: UsdmHttpMethod, path: string, params: Record<string, string> = {}, cls: RequestClass = "trade"): Promise<any> {
    await acquireOrThrow(this.ctx, cls);
    params.timestamp = Date.now().toString();
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const signature = this.sign(qs);
    const url = `${this.ctx.baseUrl()}${path}?${qs}&signature=${signature}`;

    const resp = await fetchT(url, {
      method,
      headers: { "X-MBX-APIKEY": this.ctx.apiKey() },
    }, this.ctx.timeoutMs);
    this.notePenaltyStatus(resp, path);
    const data = await resp.json().catch(() => null) as any;
    if (!resp.ok) {
      const error = new Error(`Binance ${path} HTTP ${resp.status}: ${data?.msg ?? resp.statusText}`) as Error & { code?: number; httpStatus?: number };
      const code = Number(data?.code);
      if (Number.isFinite(code)) error.code = code;
      error.httpStatus = resp.status;
      throw error;
    }
    const bodyCode = Number(data?.code);
    if (Number.isFinite(bodyCode) && bodyCode !== 0 && bodyCode !== 200) {
      const error = new Error(`Binance ${path} ${data.code}: ${data.msg ?? "error"}`) as Error & { code?: number };
      error.code = bodyCode;
      throw error;
    }
    return data;
  }

  /** Same pre-transmit-denial contract for the UNSIGNED endpoints (price,
   *  bookTicker, depth, exchangeInfo, assetIndex): they count against the
   *  same per-IP weight cap as the signed ones. */
  async publicRequest(path: string, query: Record<string, string> = {}, cls: RequestClass = "trade"): Promise<PublicRestResponse> {
    await acquireOrThrow(this.ctx, cls);
    const qs = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const resp = await fetchT(`${this.ctx.baseUrl()}${path}${qs ? `?${qs}` : ""}`, {}, this.ctx.timeoutMs);
    this.notePenaltyStatus(resp, path);
    return resp;
  }

  async serverTime(): Promise<PublicRestResponse> {
    return fetchT(`${this.ctx.baseUrl()}/fapi/v1/time`, {}, this.ctx.timeoutMs);
  }
}

// ── SDK transport: the official client behind the same contract ───────────

type UsdsRestApi = InstanceType<typeof DerivativesTradingUsdsFutures>["restAPI"];

/** Explicit, fail-closed param consumption: a param the route does not read
 *  is an error, never a silent drop (the generated SDK whitelists params per
 *  endpoint — see module header). */
class ParamReader {
  private readonly used = new Set<string>();
  constructor(private readonly p: Record<string, string>) {}
  has(k: string): boolean { return this.p[k] !== undefined; }
  str(k: string): string | undefined { this.used.add(k); return this.p[k]; }
  reqStr(k: string): string {
    const v = this.str(k);
    if (v === undefined) throw new Error(`SdkTransport: required param "${k}" missing`);
    return v;
  }
  num(k: string): number | undefined {
    const v = this.str(k);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`SdkTransport: param "${k}"="${v}" is not numeric`);
    return n;
  }
  reqNum(k: string): number {
    const n = this.num(k);
    if (n === undefined) throw new Error(`SdkTransport: required param "${k}" missing`);
    return n;
  }
  /** Consume-and-drop, with the reason on record (e.g. cancelAlgoOrder keys
   *  by algoId alone in this API generation; symbol is redundant). */
  drop(k: string): void { this.used.add(k); }
  assertAllConsumed(label: string): void {
    const leftover = Object.keys(this.p).filter((k) => !this.used.has(k));
    if (leftover.length > 0) {
      throw new Error(`SdkTransport: refusing ${label} — param(s) [${leftover.join(", ")}] have no SDK mapping and would be silently dropped`);
    }
  }
}

function venueRejectionError(path: string, httpStatus: number, code: number | undefined, msg: string | undefined): Error & { code?: number; httpStatus?: number } {
  const error = new Error(`Binance ${path} HTTP ${httpStatus}: ${msg ?? "error"}`) as Error & { code?: number; httpStatus?: number };
  if (code !== undefined && Number.isFinite(code)) error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

interface SdkEnvelope { status: number; data: () => Promise<unknown> }
/** TWO-PHASE route: phase 1 (synchronous) consumes/validates params and may
 *  throw — NOTHING has been transmitted yet; phase 2 (the returned thunk)
 *  performs the actual SDK call. The split exists so assertAllConsumed and
 *  the -4120 conditional-order guard provably run PRE-transmit. */
type SdkRoute = (p: ParamReader) => (api: UsdsRestApi) => Promise<SdkEnvelope>;

// Every signed REST call the USDⓈ-M executor (and its read-only tooling)
// makes today, mapped to its generated-SDK equivalent. Full inventory in
// reports/B-binance-sdk.md.
const SIGNED_ROUTES: Record<string, SdkRoute> = {
  "GET /fapi/v2/account": () => (api) => api.accountInformationV2(),
  "GET /fapi/v2/balance": () => (api) => api.futuresAccountBalanceV2(),
  "GET /fapi/v2/positionRisk": (p) => {
    const req = { symbol: p.str("symbol") };
    return (api) => api.positionInformationV2(req);
  },
  "GET /fapi/v1/positionSide/dual": () => (api) => api.getCurrentPositionMode(),
  "GET /fapi/v1/multiAssetsMargin": () => (api) => api.getCurrentMultiAssetsMode(),
  "POST /fapi/v1/leverage": (p) => {
    const req = { symbol: p.reqStr("symbol"), leverage: p.reqNum("leverage") };
    return (api) => api.changeInitialLeverage(req);
  },
  "POST /fapi/v1/order": (p) => {
    const type = p.str("type");
    if ((type !== "MARKET" && type !== "LIMIT") || p.has("stopPrice") || p.has("closePosition") || p.has("workingType")) {
      // This API generation only accepts conditional orders on the Algo
      // Order API — the same contract the venue enforces with -4120. Throw
      // the documented venue rejection PRE-TRANSMIT so the executor's
      // existing fallback takes the /fapi/v1/algoOrder path; mapping the
      // params "best effort" would silently drop stopPrice and turn a
      // protective stop into a naked MARKET order.
      throw venueRejectionError("/fapi/v1/order", 400, -4120, "Order's type not supported on this endpoint — use the Algo Order API (SDK transport pre-transmit)");
    }
    const req = {
      symbol: p.reqStr("symbol"),
      side: p.reqStr("side") as any,
      type: type as any,
      quantity: p.num("quantity"),
      price: p.num("price"),
      timeInForce: p.str("timeInForce") as any,
      reduceOnly: p.str("reduceOnly") as any,
      newClientOrderId: p.str("newClientOrderId"),
    };
    return (api) => api.newOrder(req);
  },
  "GET /fapi/v1/order": (p) => {
    const req = { symbol: p.reqStr("symbol"), orderId: p.num("orderId"), origClientOrderId: p.str("origClientOrderId") };
    return (api) => api.queryOrder(req);
  },
  "DELETE /fapi/v1/order": (p) => {
    const req = { symbol: p.reqStr("symbol"), orderId: p.num("orderId"), origClientOrderId: p.str("origClientOrderId") };
    return (api) => api.cancelOrder(req);
  },
  "GET /fapi/v1/openOrders": (p) => {
    const req = { symbol: p.str("symbol") };
    return (api) => api.currentAllOpenOrders(req);
  },
  "GET /fapi/v1/allOrders": (p) => {
    const req = { symbol: p.str("symbol"), orderId: p.num("orderId"), startTime: p.num("startTime"), endTime: p.num("endTime"), limit: p.num("limit") };
    return (api) => api.allOrders(req);
  },
  "GET /fapi/v1/userTrades": (p) => {
    const req = { symbol: p.reqStr("symbol"), orderId: p.num("orderId"), startTime: p.num("startTime"), endTime: p.num("endTime"), limit: p.num("limit") };
    return (api) => api.accountTradeList(req);
  },
  "POST /fapi/v1/algoOrder": (p) => {
    const req = {
      algoType: p.reqStr("algoType") as any,
      symbol: p.reqStr("symbol"),
      side: p.reqStr("side") as any,
      type: p.reqStr("type") as any,
      triggerPrice: p.num("triggerPrice"),
      workingType: p.str("workingType") as any,
      reduceOnly: p.str("reduceOnly") as any,
      closePosition: p.str("closePosition") as any,
      quantity: p.num("quantity"),
      clientAlgoId: p.str("clientAlgoId"),
    };
    return (api) => api.newAlgoOrder(req);
  },
  "DELETE /fapi/v1/algoOrder": (p) => {
    // This API generation cancels an algo order by algoId/clientAlgoId alone
    // (CancelAlgoOrderRequest has no symbol field); the legacy transport also
    // sent the redundant symbol — consumed and dropped here, on record.
    p.drop("symbol");
    const req = { algoId: p.num("algoId"), clientAlgoId: p.str("clientAlgoId") };
    return (api) => api.cancelAlgoOrder(req);
  },
  "GET /fapi/v1/openAlgoOrders": (p) => {
    const req = { symbol: p.str("symbol") };
    return (api) => api.currentAllAlgoOpenOrders(req);
  },
  "GET /fapi/v1/allAlgoOrders": (p) => {
    const req = { symbol: p.reqStr("symbol"), startTime: p.num("startTime"), endTime: p.num("endTime"), limit: p.num("limit") };
    return (api) => api.queryAllAlgoOrders(req);
  },
  "GET /fapi/v1/income": (p) => {
    const req = {
      symbol: p.str("symbol"), incomeType: p.str("incomeType") as any,
      startTime: p.num("startTime"), endTime: p.num("endTime"), limit: p.num("limit"),
    };
    return (api) => api.getIncomeHistory(req);
  },
  "POST /fapi/v1/listenKey": () => (api) => api.startUserDataStream(),
  "PUT /fapi/v1/listenKey": () => (api) => api.keepaliveUserDataStream(),
};

const PUBLIC_ROUTES: Record<string, SdkRoute> = {
  "/fapi/v1/exchangeInfo": () => (api) => api.exchangeInformation(),
  "/fapi/v1/premiumIndex": (p) => {
    const req = { symbol: p.str("symbol") };
    return (api) => api.markPrice(req);
  },
  "/fapi/v1/ticker/bookTicker": (p) => {
    const req = { symbol: p.str("symbol") };
    return (api) => api.symbolOrderBookTicker(req);
  },
  "/fapi/v1/depth": (p) => {
    const req = { symbol: p.reqStr("symbol"), limit: p.num("limit") };
    return (api) => api.orderBook(req);
  },
  "/fapi/v1/klines": (p) => {
    const req = {
      symbol: p.reqStr("symbol"), interval: p.reqStr("interval") as any,
      startTime: p.num("startTime"), endTime: p.num("endTime"), limit: p.num("limit"),
    };
    return (api) => api.klineCandlestickData(req);
  },
  "/fapi/v1/assetIndex": (p) => {
    // This SDK generation's assetIndex() takes no symbol param (weight 10
    // full-list read vs the legacy symbol-scoped weight 1 — documented);
    // emulate the symbol-scoped response shape client-side.
    const symbol = p.str("symbol");
    return async (api) => {
      const resp = await api.assetIndex();
      return {
        status: resp.status,
        data: async () => {
          const all = await resp.data();
          if (symbol === undefined || !Array.isArray(all)) return all;
          return (all as any[]).find((row) => row?.symbol === symbol) ?? null;
        },
      };
    };
  },
};

/** The SDK parses JSON with json-with-bigint: integers beyond 2^53 come back
 *  as BigInt (seen on prod 2026-10-02: 19-digit FUNDING_FEE tranIds from
 *  /fapi/v1/income). A BigInt anywhere in a payload makes JSON.stringify —
 *  which the executor uses in its logs — throw, and it never equals a number.
 *  The seam's contract is equivalence with the legacy transport, whose
 *  JSON.parse turns those integers into (rounded) numbers; do exactly that.
 *  No field the executor reads exceeds 2^53 (order/algo/trade ids are
 *  10–14 digits; verified identical across transports on prod). */
export function toLegacyJson(value: any): any {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(toLegacyJson);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toLegacyJson(v);
    return out;
  }
  return value;
}

/** ONE keep-alive agent for every SDK client in the process. @binance/common
 *  builds `new https.Agent({ keepAlive: true })` INSIDE its per-request
 *  function unless the configuration carries an httpsAgent — a fresh pool per
 *  request, so every call paid a new TLS handshake: measured on prod
 *  2026-10-02, median 768 ms per signed GET vs 246 ms on the legacy transport
 *  (Bun's fetch reuses its connections), the same ~800 ms the FIRST request
 *  costs on both. With this shared agent the SDK measured 252 ms, at parity.
 *  The client now runs on Bun's fetch (useBunFetchAdapter), which ignores the
 *  agent; it stays configured so the SDK never allocates one per request. */
export const SDK_HTTPS_AGENT = new https.Agent({ keepAlive: true });

/** Bun's fetch, resolved at call time (a stable function identity for axios's
 *  per-env adapter cache; tests can observe traffic by wrapping globalThis.fetch). */
const BUN_FETCH = (input: any, init?: any) => globalThis.fetch(input, init);

/** Route ONE SDK client's HTTP through Bun's fetch — the network stack the
 *  legacy transport uses. With axios's default node-http adapter under Bun the
 *  SDK failed ~1 in 3 account syncs on prod (2026-10-02 20:34–21:02, 8×
 *  "Network error or request timeout", zero all day on legacy): a keep-alive
 *  socket the venue closes at its ~60 s idle limit gets reused by the 60 s
 *  sync loop, and node-http has no stale-socket retry where Bun's fetch does.
 *  Scoped to this client's configuration (the SDK spreads `baseOptions` into
 *  every request): the process-wide axios default is shared with
 *  @alpacahq/alpaca-trade-api and must stay untouched. Fails closed if the
 *  pinned SDK's internals ever change shape. */
export function useBunFetchAdapter(restAPI: any): void {
  const cfg = restAPI?.configuration;
  if (!cfg || typeof cfg.baseOptions !== "object" || cfg.baseOptions === null) {
    throw new Error("SdkTransport: SDK configuration shape changed (no restAPI.configuration.baseOptions) — refusing to run on an unverified HTTP stack");
  }
  cfg.baseOptions.adapter = "fetch";
  cfg.baseOptions.env = { ...(cfg.baseOptions.env ?? {}), fetch: BUN_FETCH };
}

/** Pure: the SDK REST configuration for one transport context. */
export function sdkRestConfiguration(ctx: Pick<UsdmTransportContext, "baseUrl" | "apiKey" | "secretKey" | "timeoutMs">) {
  return {
    apiKey: ctx.apiKey(),
    apiSecret: ctx.secretKey(),
    basePath: ctx.baseUrl(),
    // No hidden retries, EVER: our retry policy lives in the callers
    // and a library-retried POST can duplicate an order. (Contract
    // test: "sdk transport never retries".)
    retries: 0,
    // Same bound fetchT gives the legacy path.
    timeout: ctx.timeoutMs ?? 10_000,
    keepAlive: true,
    httpsAgent: SDK_HTTPS_AGENT,
  };
}

class SdkUsdmTransport implements BinanceUsdmTransport {
  readonly kind = "sdk" as const;
  private client: DerivativesTradingUsdsFutures | null = null;
  private clientKey = "";

  constructor(private readonly ctx: UsdmTransportContext) {}

  /** (Re)build the SDK client lazily so post-construction mutations of
   *  baseUrl/keys (tests, re-config) are respected. */
  private api(): UsdsRestApi {
    // Fail CLOSED on an empty base: the SDK's constructor substitutes the
    // PRODUCTION host (fapi.binance.com) for a missing basePath — an empty
    // config must never silently become real-money traffic. (init()'s
    // sandbox allowlist is the second rail; this one fires even for raw
    // transport users like the verify script.)
    if (!this.ctx.baseUrl()) {
      throw new Error("SdkTransport: empty baseUrl — refusing (the SDK would default to PRODUCTION fapi.binance.com)");
    }
    const key = `${this.ctx.baseUrl()}\u0000${this.ctx.apiKey()}\u0000${this.ctx.secretKey()}`;
    if (!this.client || this.clientKey !== key) {
      const client = new DerivativesTradingUsdsFutures({ configurationRestAPI: sdkRestConfiguration(this.ctx) });
      useBunFetchAdapter(client.restAPI);
      this.client = client;
      this.clientKey = key;
    }
    return this.client.restAPI;
  }

  /** Normalize SDK error classes to the legacy error contract (see module
   *  header). Returns the error to throw. */
  private mapSdkError(e: unknown, path: string): Error {
    if ((e as any)?.rateLimitDenied) return e as Error; // our own pre-transmit denial
    if (e instanceof TooManyRequestsError) {
      // The SDK's thrown 429 does NOT expose response headers, so Retry-After
      // is unavailable here — the limiter's configured default 429 penalty
      // window applies instead (legacy honors Retry-After exactly).
      this.ctx.limiter().notePenalty(429, undefined);
      log.warn(`Binance FAPI returned HTTP 429 on ${path} — rate-limit penalty window opened (SDK transport: Retry-After not exposed, default window)`);
      return venueRejectionError(path, 429, e.code, e.message);
    }
    if (e instanceof RateLimitBanError) {
      this.ctx.limiter().notePenalty(418, undefined);
      log.error(`🚨🚨 Binance FAPI returned HTTP 418 (temporary IP BAN) on ${path} — ALL FAPI traffic frozen; continuing to send would extend the ban (SDK transport: Retry-After not exposed, default window)`);
      return venueRejectionError(path, 418, e.code, e.message);
    }
    if (e instanceof RequiredError) {
      // SDK-side param validation: thrown BEFORE anything is transmitted, so
      // a venue-rejection shape (proven failure) is the truthful mapping.
      return venueRejectionError(path, 400, undefined, `pre-transmit validation: ${e.message}`);
    }
    if (e instanceof BadRequestError) return venueRejectionError(path, 400, e.code, e.message);
    if (e instanceof UnauthorizedError) return venueRejectionError(path, 401, e.code, e.message);
    if (e instanceof ForbiddenError) return venueRejectionError(path, 403, e.code, e.message);
    if (e instanceof NotFoundError) return venueRejectionError(path, 404, e.code, e.message);
    if (e instanceof ServerError) {
      // 5xx: transmitted, outcome unknown. Carry the status (isVenueRejection
      // treats >=500 as NOT a rejection, same as legacy).
      return venueRejectionError(path, e.statusCode ?? 500, undefined, e.message);
    }
    if (e instanceof ConnectorClientError) {
      // Non-5xx unknown status with a Binance body code — venue-level.
      const error = new Error(`Binance ${path}: ${e.message}`) as Error & { code?: number };
      if (Number.isFinite(e.code)) error.code = e.code;
      return error;
    }
    // NetworkError / timeout / anything else: ambiguous transport failure —
    // no code, no httpStatus → the executor's unknown-outcome taxonomy owns it.
    return e instanceof Error ? e : new Error(String(e));
  }

  private route(table: Record<string, SdkRoute>, label: string): SdkRoute {
    const route = table[label];
    if (!route) {
      // Fail CLOSED: an unmapped call must never silently fall back to raw
      // HTTP or a "nearest" SDK method.
      throw new Error(`SdkTransport: no SDK route mapped for ${label} — refusing (fail-closed allowlist)`);
    }
    return route;
  }

  async signedRequest(method: UsdmHttpMethod, path: string, params: Record<string, string> = {}, cls: RequestClass = "trade"): Promise<any> {
    const label = `${method} ${path}`;
    const route = this.route(SIGNED_ROUTES, label); // before the limiter: a config bug must not consume budget
    await acquireOrThrow(this.ctx, cls);
    const reader = new ParamReader(params);
    let data: any;
    try {
      // Phase 1 (pre-transmit): map + validate params. Throws — provably
      // before any bytes leave — on unmapped params or a conditional order.
      const call = route(reader);
      reader.assertAllConsumed(label);
      // Phase 2: transmit.
      const resp = await call(this.api());
      data = toLegacyJson(await resp.data());
    } catch (e) {
      throw this.mapSdkError(e, path);
    }
    // Body-level venue error on HTTP 200 — same check as the legacy path.
    const bodyCode = Number(data?.code);
    if (Number.isFinite(bodyCode) && bodyCode !== 0 && bodyCode !== 200) {
      const error = new Error(`Binance ${path} ${data.code}: ${data.msg ?? "error"}`) as Error & { code?: number };
      error.code = bodyCode;
      throw error;
    }
    return data;
  }

  private async publicEnvelope(path: string, query: Record<string, string>): Promise<PublicRestResponse> {
    const route = this.route(PUBLIC_ROUTES, path);
    const reader = new ParamReader(query);
    try {
      const call = route(reader); // phase 1: pre-transmit param validation
      reader.assertAllConsumed(path);
      const resp = await call(this.api()); // phase 2: transmit
      return { ok: resp.status < 400, status: resp.status, json: async () => toLegacyJson(await resp.data()) };
    } catch (e) {
      const mapped = this.mapSdkError(e, path) as Error & { code?: number; httpStatus?: number };
      if (mapped.httpStatus !== undefined) {
        // Legacy returns the HTTP-error Response itself; emulate it so the
        // executor's per-endpoint !ok handling behaves identically.
        const { code, message, httpStatus } = mapped;
        return { ok: false, status: httpStatus, json: async () => ({ code, msg: message }) };
      }
      throw mapped; // network-level: legacy fetchT throws here too
    }
  }

  async publicRequest(path: string, query: Record<string, string> = {}, cls: RequestClass = "trade"): Promise<PublicRestResponse> {
    this.route(PUBLIC_ROUTES, path); // fail-closed before spending budget
    await acquireOrThrow(this.ctx, cls);
    return this.publicEnvelope(path, query);
  }

  async serverTime(): Promise<PublicRestResponse> {
    try {
      const resp = await this.api().checkServerTime();
      return { ok: resp.status < 400, status: resp.status, json: async () => toLegacyJson(await resp.data()) };
    } catch (e) {
      const mapped = this.mapSdkError(e, "/fapi/v1/time") as Error & { code?: number; httpStatus?: number };
      if (mapped.httpStatus !== undefined) {
        const { code, message, httpStatus } = mapped;
        return { ok: false, status: httpStatus, json: async () => ({ code, msg: message }) };
      }
      throw mapped;
    }
  }
}

/** Build the transport for `kind`. Unknown values FAIL CLOSED (loud throw at
 *  executor construction) — a typo in BINANCE_TRANSPORT must never silently
 *  trade over a transport the operator didn't choose. */
export function createBinanceUsdmTransport(kind: string, ctx: UsdmTransportContext): BinanceUsdmTransport {
  if (kind === "legacy") return new LegacyUsdmTransport(ctx);
  if (kind === "sdk") return new SdkUsdmTransport(ctx);
  throw new Error(`BINANCE_TRANSPORT="${kind}" is not a known transport (expected "legacy" or "sdk") — refusing to construct the Binance executor`);
}
