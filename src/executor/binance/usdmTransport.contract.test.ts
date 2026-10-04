// ══════════════════════════════════════════════
// USDⓈ-M transport contract battery — the SAME tests against BOTH transports
// ══════════════════════════════════════════════
//
// A fake Binance FAPI server (Bun.serve) answers with REAL response shapes
// (ccxt's captured corpus where available — see __fixtures__/ccxt/NOTICE) and
// records every request it receives. Each scenario runs against the legacy
// transport AND the official-SDK transport and asserts:
//   - identical normalized outputs,
//   - the same relevant wire params (including a VALID HMAC signature),
//   - the same error taxonomy (venue rejection vs ambiguous vs pre-transmit
//     denial) for -2019 / -2011 / -1021 / -4120 / 429 / 418 / timeouts,
//   - no hidden retries, ever.
// ══════════════════════════════════════════════

import { describe, test, expect, afterEach } from "bun:test";
import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { createBinanceUsdmTransport, type BinanceUsdmTransport, type BinanceTransportKind } from "./usdmTransport";
import { VenueRateLimiter, VENUE_RATE_LIMITER_DEFAULTS } from "../rateLimiter";
import { fakeBinanceExecutor, defaultCatalog, makeSpec } from "../../test-support/binance";

const KINDS: BinanceTransportKind[] = ["legacy", "sdk"];
const API_KEY = "contract-test-key";
const API_SECRET = "contract-test-secret";

// ── Real captured payloads (ccxt corpus) ───────────────────────────────────

const FIXDIR = join(import.meta.dir, "../__fixtures__/ccxt");
const ccxtBinance = JSON.parse(readFileSync(join(FIXDIR, "response", "binance.json"), "utf8"));
const REAL_ACCOUNT = ccxtBinance.methods.fetchBalance.find((c: any) => c.description === "Linear swap balance").httpResponse;
const REAL_POSITION = ccxtBinance.methods.fetchPositions.find((c: any) => c.description === "Fetch linear positions without symbols").httpResponse[0];
const REAL_ALGO_ORDER = ccxtBinance.methods.createOrder.find((c: any) => c.description === "createOrder conditional linear swap").httpResponse;

// ── Fake FAPI server ───────────────────────────────────────────────────────

interface RecordedRequest {
  method: string;
  path: string;
  params: Record<string, string>; // query WITHOUT timestamp/signature
  apiKeyHeader: string | null;
  signatureValid: boolean | null; // null = unsigned endpoint (no signature sent)
}

type Handler = (req: RecordedRequest) => Response | Promise<Response>;

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// ONE server for the whole file, with a swappable handler. (Spawning a fresh
// Bun.serve per test makes the OS reuse ports, and the client side's
// keep-alive pool then revives dead sockets to the recycled port — observed
// as spurious "Unable to connect" failures.)
const recordedRequests: RecordedRequest[] = [];
let currentHandler: Handler = () => jsonResp({ code: -1, msg: "no handler installed" }, 400);
const fakeFapi = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    // Binance signs the query string exactly as transmitted, minus the
    // trailing signature param. Verify the HMAC the same way Binance does.
    const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
    let signatureValid: boolean | null = null;
    let unsigned = raw;
    const sigIdx = raw.indexOf("&signature=");
    if (sigIdx !== -1) {
      unsigned = raw.slice(0, sigIdx);
      const got = raw.slice(sigIdx + "&signature=".length);
      signatureValid = got === createHmac("sha256", API_SECRET).update(unsigned).digest("hex");
    }
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(unsigned)) {
      if (k !== "timestamp") params[k] = v;
    }
    const recorded: RecordedRequest = {
      method: req.method,
      path: url.pathname,
      params,
      apiKeyHeader: req.headers.get("x-mbx-apikey"),
      signatureValid,
    };
    recordedRequests.push(recorded);
    return currentHandler(recorded);
  },
});

function roomyLimiter(): VenueRateLimiter {
  return new VenueRateLimiter("binance_fapi", { ...VENUE_RATE_LIMITER_DEFAULTS.binance_fapi });
}

function makeTransport(kind: BinanceTransportKind, baseUrl: string, opts: { limiter?: VenueRateLimiter; timeoutMs?: number } = {}): { transport: BinanceUsdmTransport; limiter: VenueRateLimiter } {
  const limiter = opts.limiter ?? roomyLimiter();
  const transport = createBinanceUsdmTransport(kind, {
    baseUrl: () => baseUrl,
    apiKey: () => API_KEY,
    secretKey: () => API_SECRET,
    limiter: () => limiter,
    timeoutMs: opts.timeoutMs,
  });
  return { transport, limiter };
}

afterEach(() => {
  currentHandler = () => jsonResp({ code: -1, msg: "no handler installed" }, 400);
});

/** Install `handler` on the shared fake server and reset the request log.
 *  Returns the same {url, requests} surface the per-test server used to. */
function serve(handler: Handler): { url: string; requests: RecordedRequest[] } {
  currentHandler = handler;
  recordedRequests.length = 0;
  return { url: `http://127.0.0.1:${fakeFapi.port}`, requests: recordedRequests };
}

// ── The battery ────────────────────────────────────────────────────────────

describe("SDK connection reuse (prod 2026-10-02: 768 ms vs 246 ms per GET)", () => {
  test("every SDK client gets the SAME process-wide keep-alive https agent — the SDK would otherwise build a new pool per request", async () => {
    const { sdkRestConfiguration, SDK_HTTPS_AGENT } = await import("./usdmTransport");
    const ctx = { baseUrl: () => "https://demo-fapi.binance.com", apiKey: () => "k", secretKey: () => "s" };
    const a = sdkRestConfiguration(ctx), b = sdkRestConfiguration({ ...ctx, apiKey: () => "other" });
    expect(a.httpsAgent).toBe(SDK_HTTPS_AGENT);
    expect(b.httpsAgent).toBe(SDK_HTTPS_AGENT);
    expect((SDK_HTTPS_AGENT as any).keepAlive).toBe(true);
    expect(a.retries).toBe(0); // the no-hidden-retries rule rides the same config
  });
});

describe("SDK traffic runs on Bun's fetch, like the legacy transport (prod 2026-10-02: node-http reused stale sockets)", () => {
  test("an SDK request goes through globalThis.fetch", async () => {
    const srv = serve(() => jsonResp(REAL_ACCOUNT));
    const { transport } = makeTransport("sdk", srv.url);
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((input: any, init?: any) => { calls++; return real(input, init); }) as typeof fetch;
    try {
      const data = await transport.signedRequest("GET", "/fapi/v2/account", {}, "trade");
      expect(data).toEqual(REAL_ACCOUNT);
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toBe(1);
  });

  test("the adapter switch is scoped to the SDK client and fails closed on an unknown SDK shape", async () => {
    const { useBunFetchAdapter } = await import("./usdmTransport");
    const fake: any = { configuration: { baseOptions: { timeout: 1 } } };
    useBunFetchAdapter(fake);
    expect(fake.configuration.baseOptions.adapter).toBe("fetch");
    expect(typeof fake.configuration.baseOptions.env.fetch).toBe("function");
    expect(() => useBunFetchAdapter({})).toThrow(/shape changed/);
    const axios = (await import("axios")).default;
    expect(axios.defaults.adapter).not.toBe("fetch"); // process-wide default untouched (shared with the Alpaca SDK)
  });
});

describe("factory fails closed", () => {
  test("unknown BINANCE_TRANSPORT throws at construction, never a silent default", () => {
    expect(() => makeTransport("sdkk" as any, "http://127.0.0.1:1")).toThrow(/not a known transport/);
  });

  test("sdk transport refuses an empty baseUrl (the SDK would default to PRODUCTION)", async () => {
    const { transport } = makeTransport("sdk", "");
    await expect(transport.signedRequest("GET", "/fapi/v2/account")).rejects.toThrow(/PRODUCTION/);
  });
});

describe("signed GET: identical body, valid signature", () => {
  for (const kind of KINDS) {
    test(`[${kind}] GET /fapi/v2/account returns ccxt's real payload verbatim; request is signed and key-stamped`, async () => {
      const srv = serve(() => jsonResp(REAL_ACCOUNT));
      const { transport } = makeTransport(kind, srv.url);
      const data = await transport.signedRequest("GET", "/fapi/v2/account", {}, "trade");
      expect(data).toEqual(REAL_ACCOUNT);
      expect(srv.requests).toHaveLength(1);
      expect(srv.requests[0].signatureValid).toBe(true);
      expect(srv.requests[0].apiKeyHeader).toBe(API_KEY);
    });
  }
});

describe("integers beyond 2^53 (prod 2026-10-02: 19-digit income tranIds) decode identically", () => {
  // Raw JSON on purpose: JSON.stringify of a JS number can't carry the exact
  // 19-digit value; Binance sends it verbatim.
  const BODY = `[{"tranId":1581916192027936360,"incomeType":"FUNDING_FEE","symbol":"LINKUSDT","income":"-0.08559470","asset":"USDT","time":1790899200000}]`;
  const results: Record<string, any> = {};
  for (const kind of KINDS) {
    test(`[${kind}] /fapi/v1/income: a number, never a BigInt — JSON.stringify works on the payload`, async () => {
      const srv = serve(() => new Response(BODY, { status: 200, headers: { "content-type": "application/json" } }));
      const { transport } = makeTransport(kind, srv.url);
      const data = await transport.signedRequest("GET", "/fapi/v1/income", { limit: "1000" }, "trade");
      expect(typeof data[0].tranId).toBe("number");
      expect(() => JSON.stringify(data)).not.toThrow();
      results[kind] = data;
    });
  }
  test("both transports return the same value (legacy JSON.parse rounding)", () => {
    expect(results.sdk).toEqual(results.legacy);
  });
});

describe("POST /fapi/v1/order (MARKET): same relevant wire params", () => {
  const ORDER_PARAMS = { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "0.001", newClientOrderId: "uc-fapi-contract-test" };
  const seen: Record<string, RecordedRequest> = {};

  for (const kind of KINDS) {
    test(`[${kind}] transmits symbol/side/type/quantity/clientOrderId, signed`, async () => {
      const srv = serve(() => jsonResp({ orderId: 4059849136, symbol: "BTCUSDT", status: "NEW", clientOrderId: ORDER_PARAMS.newClientOrderId, avgPrice: "0", executedQty: "0", updateTime: 1 }));
      const { transport } = makeTransport(kind, srv.url);
      const data = await transport.signedRequest("POST", "/fapi/v1/order", { ...ORDER_PARAMS }, "trade");
      expect(data.orderId).toBe(4059849136);
      const req = srv.requests[0];
      seen[kind] = req;
      expect(req.method).toBe("POST");
      expect(req.signatureValid).toBe(true);
      expect(req.params.symbol).toBe("BTCUSDT");
      expect(req.params.side).toBe("BUY");
      expect(req.params.type).toBe("MARKET");
      expect(Number(req.params.quantity)).toBe(0.001);
      expect(req.params.newClientOrderId).toBe("uc-fapi-contract-test");
    });
  }

  test("both transports transmitted the same normalized params", () => {
    const norm = (r: RecordedRequest) => ({ ...r.params, quantity: Number(r.params.quantity) });
    expect(norm(seen.sdk)).toEqual(norm(seen.legacy));
  });
});

describe("venue error codes map identically (-2019 margin, -2011 unknown order, -1021 timestamp)", () => {
  const CASES: Array<{ code: number; msg: string; call: [any, string, Record<string, string>] }> = [
    { code: -2019, msg: "Margin is insufficient.", call: ["POST", "/fapi/v1/order", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "0.001" }] },
    { code: -2011, msg: "Unknown order sent.", call: ["DELETE", "/fapi/v1/order", { symbol: "BTCUSDT", orderId: "1" }] },
    { code: -1021, msg: "Timestamp for this request is outside of the recvWindow.", call: ["GET", "/fapi/v2/account", {}] },
  ];
  for (const kind of KINDS) {
    for (const c of CASES) {
      test(`[${kind}] HTTP 400 {code:${c.code}} → error.code=${c.code}, httpStatus=400 (proven venue rejection)`, async () => {
        const srv = serve(() => jsonResp({ code: c.code, msg: c.msg }, 400));
        const { transport } = makeTransport(kind, srv.url);
        try {
          await transport.signedRequest(c.call[0], c.call[1], { ...c.call[2] }, "trade");
          throw new Error("should have thrown");
        } catch (e: any) {
          expect(e.code).toBe(c.code);
          expect(e.httpStatus).toBe(400);
          expect(e.message).toContain(c.msg);
          expect(e.rateLimitDenied).toBeUndefined();
        }
      });
    }
  }

  for (const kind of KINDS) {
    test(`[${kind}] body-level error code on HTTP 200 still throws with .code (legacy executor contract)`, async () => {
      const srv = serve(() => jsonResp({ code: -4046, msg: "No need to change margin type." }, 200));
      const { transport } = makeTransport(kind, srv.url);
      try {
        await transport.signedRequest("POST", "/fapi/v1/leverage", { symbol: "BTCUSDT", leverage: "2" }, "trade");
        throw new Error("should have thrown");
      } catch (e: any) {
        expect(e.code).toBe(-4046);
      }
    });
  }
});

describe("rate limiter: a denial is a proven non-submission (zero bytes on the wire)", () => {
  function denyingLimiter(): VenueRateLimiter {
    return new VenueRateLimiter("binance_fapi", {
      ratePerMinute: 600, burst: 0, protectDebt: 0, backgroundReserve: 0,
      maxWaitMs: { protect: 0, trade: 0, background: 0 },
      penalty429Ms: 20_000, penalty418Ms: 120_000,
    });
  }
  for (const kind of KINDS) {
    test(`[${kind}] signed + public requests both denied pre-transmit with rateLimitDenied=true`, async () => {
      const srv = serve(() => jsonResp({}));
      const { transport } = makeTransport(kind, srv.url, { limiter: denyingLimiter() });
      for (const run of [
        () => transport.signedRequest("POST", "/fapi/v1/order", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "1" }, "trade"),
        () => transport.publicRequest("/fapi/v1/premiumIndex", { symbol: "BTCUSDT" }, "trade"),
      ]) {
        try {
          await run();
          throw new Error("should have thrown");
        } catch (e: any) {
          expect(e.rateLimitDenied).toBe(true);
          expect(e.message).toContain("rate_limited");
        }
      }
      expect(srv.requests).toHaveLength(0); // NOTHING was ever transmitted
    });
  }
});

describe("429 opens the penalty window on BOTH transports", () => {
  for (const kind of KINDS) {
    test(`[${kind}] HTTP 429 → error.httpStatus=429 (ambiguous, NOT a venue rejection), limiter counted + penalty active`, async () => {
      const srv = serve(() => jsonResp({ code: -1003, msg: "Too many requests." }, 429, { "retry-after": "7" }));
      const { transport, limiter } = makeTransport(kind, srv.url);
      try {
        await transport.signedRequest("POST", "/fapi/v1/order", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "1" }, "trade");
        throw new Error("should have thrown");
      } catch (e: any) {
        expect(e.httpStatus).toBe(429); // the executor's isVenueRejection() excludes 429 → resolve by query, never resend
      }
      const m = limiter.metrics();
      expect(m.http429).toBe(1);
      expect(m.penaltyActive).toBe(true);
      expect(m.frozen).toBe(false);
      // Known divergence (documented in usdmTransport.ts): legacy honors the
      // Retry-After header exactly; the SDK's thrown 429 does not expose
      // headers, so the sdk transport applies the default penalty window.
    });
  }
});

describe("418 (IP ban) freezes the venue on BOTH transports", () => {
  for (const kind of KINDS) {
    test(`[${kind}] HTTP 418 → frozen limiter, and the NEXT request is denied pre-transmit`, async () => {
      const srv = serve(() => jsonResp({ code: -1003, msg: "Way too many requests; IP banned." }, 418));
      const { transport, limiter } = makeTransport(kind, srv.url);
      try {
        await transport.signedRequest("GET", "/fapi/v2/account", {}, "trade");
        throw new Error("should have thrown");
      } catch (e: any) {
        expect(e.httpStatus).toBe(418);
      }
      expect(limiter.metrics().http418).toBe(1);
      expect(limiter.metrics().frozen).toBe(true);
      try {
        await transport.signedRequest("GET", "/fapi/v2/account", {}, "trade");
        throw new Error("should have thrown");
      } catch (e: any) {
        expect(e.rateLimitDenied).toBe(true); // frozen → denied BEFORE transmit
      }
      expect(srv.requests).toHaveLength(1); // only the original banned request
    });
  }
});

describe("timeout on a POST order: ambiguous (no code, no httpStatus), exactly ONE request, NO hidden retry", () => {
  for (const kind of KINDS) {
    test(`[${kind}]`, async () => {
      const srv = serve(async () => {
        await Bun.sleep(800);
        return jsonResp({ orderId: 1 });
      });
      const { transport } = makeTransport(kind, srv.url, { timeoutMs: 120 });
      const started = Date.now();
      try {
        await transport.signedRequest("POST", "/fapi/v1/order", { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "1" }, "trade");
        throw new Error("should have thrown");
      } catch (e: any) {
        expect(e.message).not.toBe("should have thrown");
        // Ambiguous after transmit: the executor must resolve by client-id
        // query, NEVER resend — so the error must carry neither a venue code
        // nor an HTTP status, and must not claim a pre-transmit denial.
        expect(e.code).toBeUndefined();
        expect(e.httpStatus).toBeUndefined();
        expect(e.rateLimitDenied).toBeUndefined();
      }
      expect(Date.now() - started).toBeLessThan(700); // actually timed out, not served
      await Bun.sleep(50);
      expect(srv.requests.filter(r => r.method === "POST")).toHaveLength(1); // transmitted once, never re-sent
    });
  }
});

describe("no hidden retries on 5xx either", () => {
  for (const kind of KINDS) {
    test(`[${kind}] a 503 GET is thrown after exactly ONE attempt`, async () => {
      const srv = serve(() => jsonResp({ msg: "Service unavailable." }, 503));
      const { transport } = makeTransport(kind, srv.url);
      await expect(transport.signedRequest("GET", "/fapi/v2/account", {}, "trade")).rejects.toThrow();
      await Bun.sleep(30);
      expect(srv.requests).toHaveLength(1);
    });
  }
});

describe("sdk transport fails closed on anything it cannot represent faithfully", () => {
  test("unmapped route throws loudly, nothing transmitted", async () => {
    const srv = serve(() => jsonResp({}));
    const { transport } = makeTransport("sdk", srv.url);
    await expect(transport.signedRequest("GET", "/fapi/v1/doesNotExist", {}, "trade")).rejects.toThrow(/no SDK route/);
    expect(srv.requests).toHaveLength(0);
  });

  test("a param with no SDK mapping throws instead of being silently dropped", async () => {
    const srv = serve(() => jsonResp([]));
    const { transport } = makeTransport("sdk", srv.url);
    await expect(
      transport.signedRequest("GET", "/fapi/v1/openOrders", { symbol: "BTCUSDT", mysteryParam: "x" }, "trade"),
    ).rejects.toThrow(/mysteryParam/);
    expect(srv.requests).toHaveLength(0);
  });

  test("conditional order on POST /fapi/v1/order → the documented -4120, PRE-transmit", async () => {
    const srv = serve(() => jsonResp({}));
    const { transport } = makeTransport("sdk", srv.url);
    try {
      await transport.signedRequest("POST", "/fapi/v1/order", {
        symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", stopPrice: "45000.0", workingType: "MARK_PRICE", reduceOnly: "true", closePosition: "true",
      }, "protect");
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.code).toBe(-4120); // the same rejection the venue itself answers → executor's algo fallback fires
      expect(e.httpStatus).toBe(400);
    }
    expect(srv.requests).toHaveLength(0); // never half-transmitted with stop params dropped
  });
});

// ── Executor-level: the full stop path lands the SAME algo order ───────────

function stopPathHandler(): Handler {
  return (req) => {
    if (req.method === "POST" && req.path === "/fapi/v1/order") {
      return jsonResp({ code: -4120, msg: "Order's type not supported on this endpoint. Please use the Algo Order API." }, 400);
    }
    if (req.method === "POST" && req.path === "/fapi/v1/algoOrder") {
      return jsonResp(REAL_ALGO_ORDER);
    }
    return jsonResp({ code: -1, msg: `unexpected ${req.method} ${req.path}` }, 400);
  };
}

describe("placeStopMarketClose through both transports: CONDITIONAL STOP_MARKET algo order, workingType MARK_PRICE, reduceOnly", () => {
  const algoReqs: Record<string, RecordedRequest> = {};
  for (const kind of KINDS) {
    test(`[${kind}] stop lands on /fapi/v1/algoOrder with the full protective param set`, async () => {
      const srv = serve(stopPathHandler());
      const { transport } = makeTransport(kind, srv.url);
      const exec = fakeBinanceExecutor({
        instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT")]),
        options: { transport },
      }) as any;
      delete exec.signedRequest; // use the REAL signedRequest → the injected transport

      const ok = await exec.placeStopMarketClose("BTC/USD", "buy", 45_000, 0.5);
      expect(ok).toBe(true);

      const algo = srv.requests.find(r => r.path === "/fapi/v1/algoOrder" && r.method === "POST")!;
      algoReqs[kind] = algo;
      expect(algo).toBeDefined();
      expect(algo.signatureValid).toBe(true);
      expect(algo.params.algoType).toBe("CONDITIONAL");
      expect(algo.params.symbol).toBe("BTCUSDT");
      expect(algo.params.side).toBe("SELL"); // closes the long
      expect(algo.params.type).toBe("STOP_MARKET");
      expect(Number(algo.params.triggerPrice)).toBe(45_000);
      expect(algo.params.workingType).toBe("MARK_PRICE");
      expect(algo.params.reduceOnly).toBe("true");
      expect(Number(algo.params.quantity)).toBe(0.5);
      expect(algo.params.clientAlgoId).toStartWith("uc-fapi-"); // deterministic namespace stamp

      // The structural difference between the transports, pinned: legacy
      // discovers -4120 ON THE WIRE (one rejected conditional POST); the sdk
      // transport knows the API generation up front and never transmits a
      // conditional order to /fapi/v1/order at all.
      const conditionalPosts = srv.requests.filter(r => r.method === "POST" && r.path === "/fapi/v1/order");
      expect(conditionalPosts).toHaveLength(kind === "legacy" ? 1 : 0);
    });
  }

  test("both transports transmitted the same normalized algo params", () => {
    const norm = (r: RecordedRequest) => {
      const { clientAlgoId, triggerPrice, quantity, ...rest } = r.params;
      return { ...rest, triggerPrice: Number(triggerPrice), quantity: Number(quantity), clientNs: clientAlgoId?.slice(0, 8) };
    };
    expect(norm(algoReqs.sdk)).toEqual(norm(algoReqs.legacy));
  });
});

// ── Executor-level: ambiguous POST resolved by client-id QUERY, never resent ─

describe("placeOrder with a timed-out POST (sdk transport): adopted by idempotent client-id query — exactly one POST", () => {
  test("the unknown-outcome taxonomy survives the SDK transport", async () => {
    let posts = 0;
    const srv = serve(async (req) => {
      if (req.method === "POST" && req.path === "/fapi/v1/order") {
        posts++;
        await Bun.sleep(600); // outlives the transport timeout → ambiguous
        return jsonResp({ orderId: 77 });
      }
      if (req.method === "GET" && req.path === "/fapi/v1/order" && req.params.origClientOrderId) {
        return jsonResp({ orderId: 77, status: "FILLED", avgPrice: "50000", executedQty: "0.001", clientOrderId: req.params.origClientOrderId, updateTime: 1 });
      }
      if (req.method === "GET" && req.path === "/fapi/v1/userTrades") return jsonResp([]);
      return jsonResp({ code: -1, msg: `unexpected ${req.method} ${req.path}` }, 400);
    });
    const { transport } = makeTransport("sdk", srv.url, { timeoutMs: 120 });
    const exec = fakeBinanceExecutor({
      instrumentCatalog: defaultCatalog([makeSpec("BTCUSDT")]),
      options: { transport },
    }) as any;
    delete exec.signedRequest;
    exec.pollDelayMs = 1;
    exec.leverageBySymbol.set("BTCUSDT", 2); // reach the order POST directly

    const result = await exec.placeOrder({ symbol: "BTC/USD", side: "buy", price: 50_000 }, 0.001, "momentum_crypto");
    expect(posts).toBe(1); // NEVER a second POST — resolved by query
    expect(result?.externalId).toBe("77");
    expect(result?.status).toBe("filled");
    expect(result?.filledPrice).toBe(50_000);
  });
});

// ── Normalized executor reads are identical across transports ──────────────

function readsHandler(): Handler {
  return (req) => {
    if (req.path === "/fapi/v2/account") return jsonResp(REAL_ACCOUNT);
    if (req.path === "/fapi/v2/positionRisk") return jsonResp([REAL_POSITION]);
    if (req.path === "/fapi/v1/openOrders") return jsonResp([]);
    if (req.path === "/fapi/v1/openAlgoOrders") return jsonResp([{ ...REAL_ALGO_ORDER, reduceOnly: true, side: "SELL" }]);
    if (req.path === "/fapi/v1/premiumIndex") return jsonResp({ symbol: req.params.symbol, markPrice: "50100.5", lastFundingRate: "0.0001" });
    if (req.path === "/fapi/v1/time") return jsonResp({ serverTime: Date.now() });
    if (req.path === "/fapi/v1/exchangeInfo") {
      return jsonResp({
        symbols: [{
          symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", marginAsset: "USDT",
          filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.10", minPrice: "556.80", maxPrice: "4529764" },
            { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
            { filterType: "MARKET_LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "120" },
            { filterType: "MIN_NOTIONAL", notional: "100" },
          ],
        }],
      });
    }
    return jsonResp({ code: -1, msg: `unexpected ${req.method} ${req.path}` }, 400);
  };
}

describe("normalized executor outputs are identical across transports (real captured payloads)", () => {
  const out: Record<string, any> = {};
  for (const kind of KINDS) {
    test(`[${kind}] getBalance / getPositions / getOpenProtectiveOrders / getPrice / exchangeInfo catalog`, async () => {
      const srv = serve(readsHandler());
      const { transport } = makeTransport(kind, srv.url);
      const exec = fakeBinanceExecutor({ options: { transport } }) as any;
      delete exec.signedRequest;
      // REAL lazy catalog through the transport (not the seeded test one).
      const { InstrumentCatalog } = await import("./instrumentSpec");
      exec.catalog = new InstrumentCatalog(() => exec.fetchExchangeInfoRaw());

      const balance = await exec.getBalance();
      const positions = await exec.getPositions();
      const protective = await exec.getOpenProtectiveOrders("BTC/USD");
      const price = await exec.getPrice("BTCUSDT");
      const spec = await exec.catalog.ensure("BTCUSDT");
      out[kind] = { balance, positions, protective, price, spec };

      expect(balance.marginEquity).toBeCloseTo(31.022612);
      expect(positions[0].symbol).toBe("BTCUSDT");
      expect(protective[0].type).toBe("STOP_MARKET"); // canonicalized from the real "STOP" readback
      expect(price).toBe(50100.5);
      expect(spec?.minNotional).toBe(100);
    });
  }

  test("deep-equal across transports", () => {
    expect(out.sdk).toEqual(out.legacy);
  });
});
