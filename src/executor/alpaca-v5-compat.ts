// ══════════════════════════════════════════════
// alpaca-v5-compat — v3-shaped adapter over @alpacahq/alpaca-trade-api v5
// ══════════════════════════════════════════════
//
// WHY THIS EXISTS (SDK 3.1.3 → 5.0.0, 2026-10-14): the v4 rewrite split the
// flat v3 client into `trading`/`marketData` namespaces, camelCased every
// model, and added retries/rate limiting/timeouts. AlpacaExecutor (and its
// ~90 test fakes) is written against the v3 surface: eleven flat methods
// returning the RAW API JSON (snake_case fields, numeric strings) plus the
// `trade_ws` stream accessor. This module keeps `executor.client` exactly
// v3-shaped — a thin mapping layer over the v5 client — so the executor's
// order/close/stop logic and every existing test fake stay byte-identical.
//
// FIDELITY CONTRACT (each one deliberate, see the per-method notes):
//  - Outputs are the generated models serialized BACK to wire JSON via the
//    SDK's own `*ToJSON` converters (e.g. `trading.OrderToJSON`), so field
//    names/value types match what v3's axios returned: snake_case keys,
//    money/qty as numeric strings, timestamps as ISO strings.
//  - `getSnapshot` reproduces v3's MAPPED entity (PascalCase: LatestTrade.
//    Price/Timestamp, LatestQuote.BidPrice/AskPrice/…) — v3 was the one v3
//    method that did NOT return raw JSON, and the executor + tests read that
//    shape.
//  - Errors are the v5 typed hierarchy passed through UNWRAPPED. They already
//    satisfy every error parse in the executor: `ApiError.status` and
//    `ApiError.response.status` (a fetch Response) carry the HTTP code for
//    `e?.response?.status || e?.status`, and `ApiError.message` is the API
//    body's `message` (wash-trade / "insufficient qty… held for orders" /
//    duplicate-client_order_id matching via `e?.response?.data?.message ??
//    e?.message` lands on `e.message`). Network/abort failures are
//    `FetchError` with NO status — the executor's "code === null ⇒ outcome
//    unknown, resolve by client_order_id query" taxonomy is preserved.
//  - `retry: false`: v3 never retried, and the executor owns resilience
//    (its own limiter classes, withTimeout, resolve-by-query for ambiguous
//    submits). The SDK only ever auto-retries idempotent verbs — POST
//    /v2/orders is never retried by the SDK even at defaults — but a GET
//    retried behind the executor's 10s withTimeout would just burn venue
//    quota the executor's limiter didn't account for. One attempt per call,
//    exactly like v3.
//  - `rateLimit: false`: the executor's per-venue limiter (rateLimiter.ts)
//    owns the account's 200 req/min budget with request-class priorities
//    (protect > trade > background). The SDK's own ~200/min queue underneath
//    it would add unaccounted latency to the 15s stop-loss loop.
//  - `timeoutMs: 15_000`: every executor SDK call already races
//    `withTimeout(…, 10_000)`, which stays the semantic timeout (identical
//    messages/classification). v3+axios had NO transport timeout, so the
//    loser socket used to leak until the OS gave up; 15s (strictly above the
//    executor's 10s so it can never win the race) just reclaims it.
//  - redirect stays at the v5 default `"error"`: Alpaca never redirects, and
//    following one off-host would forward the APCA-* secret headers.
//  - Custom base URL: the v5 facade derives the trading host from `paper`
//    and has no `baseUrl` option. When the configured baseUrl differs from
//    the facade's host, a `pre` middleware rewrites trading-API URLs to it
//    (the executor's alpacaPaperLiveMismatch guard refuses incoherent
//    combinations before any call, same as always). Market-data stays on the
//    default host — identical to v3, which never received dataBaseUrl from
//    us (raw data fetches in the executor use config.alpaca.dataUrl
//    directly and don't go through this client).
//  - `trade_ws`: a v3-shaped shim over `trading.stream()` (onConnect/
//    onDisconnect/onStateChange/onError/onOrderUpdate/subscribe/connect),
//    re-emitting updates with a raw snake_case `order` so AlpacaExecutor's
//    handler keeps reading `msg.order.filled_qty`. OAuth mode exposes NO
//    trade_ws (v5 WebSockets require key+secret); the executor already
//    handles that with its "trade_ws not available" warn + REST polling.
//
// Scripts (scripts/panic.ts) share this adapter for getAccount /
// getAccountConfigurations / updateAccountConfigurations.
//
// Shape fidelity + error passthrough are locked by
// src/executor/alpaca-v5-compat.test.ts (network-free, createMockAlpaca);
// live parity vs the real v3 client: scripts/verify-alpaca-sdk-parity.ts
// (read-only, output committed under docs/reports/).

import { Alpaca, trading, marketData, streaming } from "@alpacahq/alpaca-trade-api";
import type { AlpacaClientOptions } from "@alpacahq/alpaca-trade-api";

type Middleware = NonNullable<AlpacaClientOptions["middleware"]>[number];
type TradingStream = streaming.TradingStream;
type TradeUpdate = Parameters<Parameters<TradingStream["onTradeUpdate"]>[0]>[0];

export interface AlpacaV3CompatOptions {
  /** Key-pair auth (ignored when `oauth` is set). */
  keyId?: string;
  secretKey?: string;
  /** OAuth token auth — mirrors v3's `oauth` constructor option. */
  oauth?: string | null;
  paper: boolean;
  /** Trading REST base (v3's `baseUrl`); "" keeps the facade default. */
  baseUrl?: string;
}

/** The exact v3 client surface the executor + scripts/panic.ts consume. */
export interface AlpacaV3CompatClient {
  /** v3's `alpaca.configuration` view — the credential-identity contract
   *  (executorCredentials.test.ts) reads these exact fields. */
  readonly configuration: { keyId: string; secretKey: string; paper: boolean; baseUrl: string; oauth: string };
  getAccount(): Promise<any>;
  getAccountConfigurations(): Promise<any>;
  updateAccountConfigurations(cfg: Record<string, unknown>): Promise<any>;
  createOrder(params: Record<string, unknown>): Promise<any>;
  getOrder(orderId: string): Promise<any>;
  getOrderByClientId(clientOrderId: string): Promise<any>;
  getOrders(params?: Record<string, unknown>): Promise<any[]>;
  cancelOrder(orderId: string): Promise<void>;
  getPosition(symbol: string): Promise<any>;
  getPositions(): Promise<any[]>;
  closePosition(symbol: string): Promise<any>;
  getAccountActivities(params?: Record<string, unknown>): Promise<any[]>;
  getSnapshot(symbol: string): Promise<any>;
  /** v3-shaped trade_updates stream; undefined in OAuth mode (no WS auth). */
  readonly trade_ws: AlpacaV3TradeWs | undefined;
}

export interface AlpacaV3TradeWs {
  onConnect(fn: () => void): void;
  onDisconnect(fn: () => void): void;
  onStateChange(fn: (state: unknown) => void): void;
  onError(fn: (err: unknown) => void): void;
  onOrderUpdate(fn: (msg: any) => void): void;
  subscribe(channels: string[]): void;
  connect(): void;
  disconnect(): void;
}

// v3 entityv2 mappings (node_modules/alpaca-v3/dist/resources/datav2/
// entityv2.js at 3.1.3) — the executor reads LatestTrade.Price/Timestamp and
// LatestQuote.BidPrice/AskPrice/Timestamp; the full maps keep any other
// consumer of the snapshot shape working too.
const V3_TRADE_KEYS: Record<string, string> = {
  S: "Symbol", i: "ID", x: "Exchange", p: "Price", s: "Size",
  t: "Timestamp", c: "Conditions", z: "Tape",
};
const V3_QUOTE_KEYS: Record<string, string> = {
  S: "Symbol", bx: "BidExchange", bp: "BidPrice", bs: "BidSize",
  ax: "AskExchange", ap: "AskPrice", as: "AskSize",
  t: "Timestamp", c: "Conditions", z: "Tape",
};
const V3_BAR_KEYS: Record<string, string> = {
  S: "Symbol", o: "OpenPrice", h: "HighPrice", l: "LowPrice", c: "ClosePrice",
  v: "Volume", t: "Timestamp", vw: "VWAP", n: "TradeCount",
};

function aliasKeys(obj: unknown, map: Record<string, string>): Record<string, unknown> | undefined {
  if (obj == null || typeof obj !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[map[k] ?? k] = v;
  return out;
}

/** v3 accepted `activityTypes` as a string ("FILL" or "FILL,TRANS") or an
 *  array; v5's generated request wants an array. */
function toActivityTypesArray(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw).split(",").filter(Boolean);
}

/** v5 request fields typed as Date; v3 passed strings through. */
function toDateMaybe(raw: unknown): Date | undefined {
  if (raw == null) return undefined;
  return raw instanceof Date ? raw : new Date(String(raw));
}

class TradeWsShim implements AlpacaV3TradeWs {
  private stream: TradingStream | null = null;
  constructor(private readonly alpaca: Alpaca) {}
  private ensure(): TradingStream {
    if (!this.stream) this.stream = this.alpaca.trading.stream();
    return this.stream;
  }
  onConnect(fn: () => void): void { this.ensure().onConnect(fn); }
  onDisconnect(fn: () => void): void { this.ensure().onDisconnect(fn); }
  onStateChange(fn: (state: unknown) => void): void { this.ensure().onStateChange(fn as any); }
  onError(fn: (err: unknown) => void): void { this.ensure().onError(fn as any); }
  onOrderUpdate(fn: (msg: any) => void): void {
    // v5 parses the frame into a typed TradeUpdate whose `order` is a
    // camelCase model; re-serialize it to the raw snake_case order v3
    // delivered. mapTradeUpdate spreads the original frame, so the raw
    // snake_case siblings (execution_id, position_qty, …) are still present.
    this.ensure().onTradeUpdate((u: TradeUpdate) => {
      fn({ ...u, order: trading.OrderToJSON(u.order as any) });
    });
  }
  subscribe(channels: string[]): void {
    if (Array.isArray(channels) && channels.includes("trade_updates")) {
      this.ensure().subscribeTradeUpdates();
    }
  }
  // v5 connect() is a no-op while a socket exists — same idempotence the
  // executor's reconnect nudge relied on in v3.
  connect(): void { this.ensure().connect(); }
  disconnect(): void { this.stream?.disconnect(); }
}

/**
 * Build the v3-shaped client. `testClientOptions` is a test seam merged LAST
 * into the computed v5 options (inject `fetchApi: mockFetch(routes)` from
 * the SDK's network-free testing harness, so tests exercise the REAL client
 * configuration — retry:false, rateLimit:false, middleware — not a parallel
 * one); production callers pass options only.
 */
export function createAlpacaV3Compat(opts: AlpacaV3CompatOptions, testClientOptions?: Partial<AlpacaClientOptions>): AlpacaV3CompatClient {
  const oauthMode = !!opts.oauth;
  const defaultHost = opts.paper ? trading.TRADING_PAPER_HOST : trading.TRADING_LIVE_HOST;
  const baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
  const mw: Middleware[] = [];
  if (baseUrl && baseUrl !== defaultHost) {
    mw.push({
      pre: async (ctx: { url: string; init: RequestInit }) => {
        if (ctx.url.startsWith(defaultHost)) {
          return { url: baseUrl + ctx.url.slice(defaultHost.length), init: ctx.init };
        }
      },
    });
  }
  const clientOptions: AlpacaClientOptions = {
    ...(oauthMode
      ? { accessToken: opts.oauth! }
      : { keyId: opts.keyId, secret: opts.secretKey }),
    paper: opts.paper,
    retry: false,       // v3 parity: one attempt per call; the executor owns resilience
    rateLimit: false,   // the executor's venue limiter owns the account quota
    timeoutMs: 15_000,  // socket backstop only — above the executor's 10s withTimeout
    ...(mw.length > 0 ? { middleware: mw } : {}),
  };
  // v3 built its client even without credentials (each call then failed at
  // the API); v5 throws at construction, which left the executor with no
  // client at all. With incomplete credentials the SDK is built on first use
  // instead, so that call rejects with the SDK's own credential error.
  const hasCredentials = oauthMode || (!!opts.keyId && !!opts.secretKey);
  let sdk: Alpaca | undefined = hasCredentials ? new Alpaca({ ...clientOptions, ...testClientOptions }) : undefined;
  const alpaca = (): Alpaca => (sdk ??= new Alpaca({ ...clientOptions, ...testClientOptions }));
  let tradeWs: TradeWsShim | undefined;

  return {
    configuration: {
      keyId: oauthMode ? "" : opts.keyId ?? "",
      secretKey: oauthMode ? "" : opts.secretKey ?? "",
      paper: opts.paper,
      baseUrl,
      oauth: opts.oauth ?? "",
    },

    async getAccount() {
      return trading.AccountToJSON(await alpaca().trading.account.getAccount());
    },

    async getAccountConfigurations() {
      return trading.AccountConfigurationsToJSON(
        await alpaca().trading.accountConfigurations.getAccountConfig());
    },

    async updateAccountConfigurations(cfg: Record<string, unknown>) {
      return trading.AccountConfigurationsToJSON(
        await alpaca().trading.accountConfigurations.patchAccountConfig({
          accountConfigurations: trading.AccountConfigurationsFromJSON(cfg),
        }));
    },

    // The executor's snake_case order params ARE the wire body;
    // CreateOrderRequestFromJSON lifts them into the generated model and the
    // SDK serializes back to the identical body (numbers stay numbers).
    async createOrder(params: Record<string, unknown>) {
      return trading.OrderToJSON(await alpaca().trading.orders.postOrder({
        createOrderRequest: trading.CreateOrderRequestFromJSON(params),
      }));
    },

    async getOrder(orderId: string) {
      return trading.OrderToJSON(
        await alpaca().trading.orders.getOrderByOrderID({ orderId }));
    },

    async getOrderByClientId(clientOrderId: string) {
      return trading.OrderToJSON(
        await alpaca().trading.orders.getOrderByClientOrderId({ clientOrderId }));
    },

    async getOrders(params: Record<string, unknown> = {}) {
      const orders = await alpaca().trading.orders.getAllOrders({
        status: params.status as any,
        until: params.until as any,
        after: params.after as any,
        limit: params.limit as any,
        direction: params.direction as any,
        nested: params.nested as any,
        symbols: params.symbols as any,
      });
      return orders.map((o) => trading.OrderToJSON(o));
    },

    async cancelOrder(orderId: string) {
      await alpaca().trading.orders.deleteOrderByOrderID({ orderId });
    },

    async getPosition(symbol: string) {
      return trading.PositionToJSON(
        await alpaca().trading.positions.getOpenPosition({ symbolOrAssetId: symbol }));
    },

    async getPositions() {
      const positions = await alpaca().trading.positions.getAllOpenPositions();
      return positions.map((p) => trading.PositionToJSON(p));
    },

    // v3 parity: NO qty — the plain whole-position DELETE /v2/positions/
    // {symbol}, which returns the close ORDER. The executor's
    // min(ours, broker) bounding and the partial ?qty= close are ABOVE this
    // layer (closePositionUnderLock hits the REST endpoint directly for
    // partials), exactly as with v3 — AGENTS.md "Alpaca close semantics".
    async closePosition(symbol: string) {
      return trading.OrderToJSON(
        await alpaca().trading.positions.deleteOpenPosition({ symbolOrAssetId: symbol }));
    },

    async getAccountActivities(params: Record<string, unknown> = {}) {
      const activities = await alpaca().trading.accountActivities.getAccountActivities({
        activityTypes: toActivityTypesArray(params.activityTypes) as any,
        until: toDateMaybe(params.until),
        after: toDateMaybe(params.after),
        date: toDateMaybe(params.date),
        direction: params.direction as any,
        pageSize: params.pageSize as any,
        pageToken: params.pageToken as any,
      });
      return activities.map((a) => trading.GetAccountActivities200ResponseInnerToJSON(a));
    },

    // v3's one MAPPED response: raw wire snapshot → PascalCase entity.
    async getSnapshot(symbol: string) {
      const snap = marketData.StockSnapshotsRespSingleToJSON(
        await alpaca().marketData.stocks.stockSnapshotSingle({ symbol })) ?? {};
      return {
        symbol,
        LatestTrade: aliasKeys(snap.latestTrade, V3_TRADE_KEYS),
        LatestQuote: aliasKeys(snap.latestQuote, V3_QUOTE_KEYS),
        MinuteBar: aliasKeys(snap.minuteBar, V3_BAR_KEYS),
        DailyBar: aliasKeys(snap.dailyBar, V3_BAR_KEYS),
        PrevDailyBar: aliasKeys(snap.prevDailyBar, V3_BAR_KEYS),
      };
    },

    get trade_ws(): AlpacaV3TradeWs | undefined {
      if (oauthMode) return undefined; // v5 WS auth requires key+secret; executor warns + polls
      if (!hasCredentials) return undefined; // nothing to authenticate with; same fallback
      if (!tradeWs) tradeWs = new TradeWsShim(alpaca());
      return tradeWs;
    },
  };
}
