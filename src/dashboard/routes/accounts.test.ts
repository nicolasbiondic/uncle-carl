// ═══ Integration tests: /api/platform/accounts over a bare express ═══
//
// The router is mounted with FAKE deps: an in-memory SecretBox, a fake fetch
// that replays real Alpaca/Binance response shapes, and a controllable clock.
// No auth wall here on purpose — session/CSRF are server.ts middleware, and
// this suite exercises the router's own contract (verify-then-save, redacted
// listing, session-bound single-use OAuth state, delete).

import express from "express";
import { describe, expect, test } from "bun:test";
import { getDB } from "../../db/database";
import { makeTestDb } from "../../test-support/db";
import { registerPlatformAccountsRoutes, ALPACA_OAUTH_CALLBACK_PATH, ALPACA_OAUTH_COMPLETE_PATH, PLATFORM_ACCOUNTS_PUBLIC_PATHS, oauthBouncePage } from "./accounts";
import type { AccountsDeps, SecretBox } from "../../platform/accounts/types";

// ── fakes ────────────────────────────────────────────────────────────────

const GOOD_ALPACA_KEY = "test-alpaca-key-good";
const GOOD_ALPACA_SECRET = "alpaca-secret-topsecret-1234";
const GOOD_BINANCE_KEY = "binance-good-key-0001";
const GOOD_BINANCE_SECRET = "binance-secret-topsecret-1";
const GOOD_CODE = "authcode-123";
const OAUTH_TOKEN = "79500537-5796-4230-9661-7f7108877c60";

const fakeBox: SecretBox = {
  seal: (s) => "enc:" + Buffer.from(s, "utf-8").toString("base64"),
  open: (s) => {
    if (!s.startsWith("enc:")) throw new Error("not sealed");
    return Buffer.from(s.slice(4), "base64").toString("utf-8");
  },
};

interface FetchLogEntry { url: string; init?: RequestInit }

function makeHarness(over: {
  binanceCanTrade?: boolean;
  alpacaDown?: boolean;
  box?: () => SecretBox;
  publicBaseUrl?: () => string | null;
  alpacaOAuth?: AccountsDeps["alpacaOAuth"];
  stateTtlMs?: number;
} = {}) {
  makeTestDb();
  const fetchLog: FetchLogEntry[] = [];
  const state = { binanceCanTrade: over.binanceCanTrade ?? true, alpacaDown: over.alpacaDown ?? false };
  const json = (body: any, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fakeFetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push({ url, init });
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (url.startsWith("https://paper-api.alpaca.markets/v2/account") ||
        url.startsWith("https://api.alpaca.markets/v2/account")) {
      if (state.alpacaDown) return json({ message: "internal" }, 500);
      const keyOk = headers["APCA-API-KEY-ID"] === GOOD_ALPACA_KEY &&
                    headers["APCA-API-SECRET-KEY"] === GOOD_ALPACA_SECRET;
      const bearerOk = headers["Authorization"] === `Bearer ${OAUTH_TOKEN}`;
      if (!keyOk && !bearerOk) return json({ message: "access key verification failed" }, 401);
      return json({
        id: "4db36989-6565-4011-9126-39fe6b3d9bf6",
        account_number: "PA3TESTNUM", status: "ACTIVE", currency: "USD",
        trading_blocked: false, equity: "100000",
      });
    }
    if (url.startsWith("https://api.alpaca.markets/oauth/token")) {
      const body = String(init?.body ?? "");
      const p = new URLSearchParams(body);
      const ok = p.get("grant_type") === "authorization_code" && p.get("code") === GOOD_CODE &&
                 p.get("client_id") === "CID" && p.get("client_secret") === "CSEC";
      if (!ok) return json({ error: "invalid_grant" }, 401);
      return json({ access_token: OAUTH_TOKEN, token_type: "bearer", scope: "trading data" });
    }
    if (url.startsWith("https://demo-fapi.binance.com/fapi/v2/account") ||
        url.startsWith("https://fapi.binance.com/fapi/v2/account")) {
      if (headers["X-MBX-APIKEY"] !== GOOD_BINANCE_KEY) {
        return json({ code: -2014, msg: "API-key format invalid." }, 401);
      }
      if (!/[?&]signature=[0-9a-f]{64}/.test(url)) {
        return json({ code: -1022, msg: "Signature for this request is not valid." }, 400);
      }
      return json({
        canTrade: state.binanceCanTrade, canDeposit: true, canWithdraw: true,
        feeTier: 0, totalWalletBalance: "15000.00", assets: [], positions: [],
      });
    }
    if (url.startsWith("https://api.binance.com/sapi/")) {
      // live-only best-effort probe — demo tests never reach it
      return json({ ipRestrict: false, enableWithdrawals: true });
    }
    return json({ message: "not found" }, 404);
  }) as typeof fetch;

  const clock = { now: 1_760_000_000_000 };
  const deps: AccountsDeps = {
    box: over.box ?? (() => fakeBox),
    publicBaseUrl: over.publicBaseUrl ?? (() => "https://bot.example.com"),
    alpacaOAuth: over.alpacaOAuth ?? (() => ({ clientId: "CID", clientSecret: "CSEC" })),
    fetch: fakeFetch,
    now: () => clock.now,
  };

  const app = express();
  app.use(express.json());
  registerPlatformAccountsRoutes(app, deps, { stateTtlMs: over.stateTtlMs });
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  const call = (path: string, init?: RequestInit) =>
    fetch(base + path, { redirect: "manual", ...init });
  const post = (path: string, body: any, init?: RequestInit) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });

  return { server, base, call, post, fetchLog, state, clock };
}

const goodAlpacaBody = {
  provider: "alpaca", environment: "paper", label: "My Alpaca Paper",
  apiKey: GOOD_ALPACA_KEY, apiSecret: GOOD_ALPACA_SECRET,
};

// ── API-key flow ─────────────────────────────────────────────────────────

describe("POST /api/platform/accounts (API keys)", () => {
  test("valid Alpaca paper keys: verifies against paper-api, saves sealed, returns redacted row", async () => {
    const h = makeHarness();
    try {
      const res = await h.post("/api/platform/accounts", goodAlpacaBody);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.account).toMatchObject({
        id: "my-alpaca-paper", provider: "alpaca", environment: "paper",
        authType: "api_key", status: "verified", accountRef: "PA3TESTNUM",
        lastVerifiedAt: h.clock.now, lastError: null,
      });
      // The response NEVER carries the secret, in any field.
      expect(JSON.stringify(body)).not.toContain(GOOD_ALPACA_SECRET);
      expect(JSON.stringify(body)).not.toContain(GOOD_ALPACA_KEY);
      // Verification hit the env-matching host.
      expect(h.fetchLog.some(c => c.url.startsWith("https://paper-api.alpaca.markets/v2/account"))).toBe(true);
      // At rest: sealed, not plaintext.
      const row = getDB().prepare(`SELECT credentials_enc FROM platform_broker_accounts WHERE id = 'my-alpaca-paper'`).get() as any;
      expect(row.credentials_enc.startsWith("enc:")).toBe(true);
      expect(row.credentials_enc).not.toContain(GOOD_ALPACA_SECRET);
      expect(JSON.parse(fakeBox.open(row.credentials_enc))).toEqual({
        kind: "api_key", apiKey: GOOD_ALPACA_KEY, apiSecret: GOOD_ALPACA_SECRET,
      });
    } finally { h.server.close(); }
  });

  test("bad Alpaca keys: 422, NOTHING saved", async () => {
    const h = makeHarness();
    try {
      const res = await h.post("/api/platform/accounts", { ...goodAlpacaBody, apiKey: "PKWRONG000000" });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe("verification_failed");
      expect(body.error).toContain("401");
      const list = await (await h.call("/api/platform/accounts")).json();
      expect(list.accounts).toEqual([]);
    } finally { h.server.close(); }
  });

  test("valid Binance demo keys: signed GET on demo-fapi, canTrade honored", async () => {
    const h = makeHarness();
    try {
      const res = await h.post("/api/platform/accounts", {
        provider: "binance_usdm", environment: "demo", label: "Binance demo",
        apiKey: GOOD_BINANCE_KEY, apiSecret: GOOD_BINANCE_SECRET,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.account).toMatchObject({
        provider: "binance_usdm", environment: "demo", status: "verified", accountRef: null,
      });
      const acctCall = h.fetchLog.find(c => c.url.includes("/fapi/v2/account"));
      expect(acctCall!.url.startsWith("https://demo-fapi.binance.com/")).toBe(true);
      expect(acctCall!.url).toMatch(/[?&]signature=[0-9a-f]{64}/);
      expect((acctCall!.init!.headers as any)["X-MBX-APIKEY"]).toBe(GOOD_BINANCE_KEY);
      // demo env must NOT touch the live SAPI restrictions endpoint
      expect(h.fetchLog.some(c => c.url.includes("api.binance.com/sapi"))).toBe(false);
    } finally { h.server.close(); }
  });

  test("Binance key with canTrade=false is rejected and not saved", async () => {
    const h = makeHarness({ binanceCanTrade: false });
    try {
      const res = await h.post("/api/platform/accounts", {
        provider: "binance_usdm", environment: "demo", label: "no trade",
        apiKey: GOOD_BINANCE_KEY, apiSecret: GOOD_BINANCE_SECRET,
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toContain("canTrade");
      const list = await (await h.call("/api/platform/accounts")).json();
      expect(list.accounts).toEqual([]);
    } finally { h.server.close(); }
  });

  test("binance_usdm rejects environment 'paper'; alpaca rejects 'demo'", async () => {
    const h = makeHarness();
    try {
      const r1 = await h.post("/api/platform/accounts", {
        provider: "binance_usdm", environment: "paper", label: "x",
        apiKey: GOOD_BINANCE_KEY, apiSecret: GOOD_BINANCE_SECRET,
      });
      expect(r1.status).toBe(400);
      const r2 = await h.post("/api/platform/accounts", { ...goodAlpacaBody, environment: "demo" });
      expect(r2.status).toBe(400);
    } finally { h.server.close(); }
  });

  test("no master key: 503 not_configured, and GET reports configured:false", async () => {
    const h = makeHarness({ box: () => { throw new Error("no instance key"); } });
    try {
      const res = await h.post("/api/platform/accounts", goodAlpacaBody);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("not_configured");
      const list = await (await h.call("/api/platform/accounts")).json();
      expect(list.configured).toBe(false);
      expect(list.accounts).toEqual([]);
    } finally { h.server.close(); }
  });
});

// ── listing ──────────────────────────────────────────────────────────────

describe("GET /api/platform/accounts", () => {
  test("lists redacted rows with capability flags; no secret anywhere in the payload", async () => {
    const h = makeHarness();
    try {
      await h.post("/api/platform/accounts", goodAlpacaBody);
      h.clock.now += 1_000; // creation order must be reflected in the listing
      await h.post("/api/platform/accounts", {
        provider: "binance_usdm", environment: "demo", label: "Binance demo",
        apiKey: GOOD_BINANCE_KEY, apiSecret: GOOD_BINANCE_SECRET,
      });
      const res = await h.call("/api/platform/accounts");
      const body = await res.json();
      expect(body.configured).toBe(true);
      expect(body.alpacaOAuth).toBe(true);
      expect(body.accounts.map((a: any) => a.id)).toEqual(["my-alpaca-paper", "binance-demo"]);
      const raw = JSON.stringify(body);
      for (const secret of [GOOD_ALPACA_KEY, GOOD_ALPACA_SECRET, GOOD_BINANCE_KEY, GOOD_BINANCE_SECRET]) {
        expect(raw).not.toContain(secret);
      }
      expect(raw).not.toContain("credentials");
    } finally { h.server.close(); }
  });

  test("duplicate labels get distinct slug ids", async () => {
    const h = makeHarness();
    try {
      await h.post("/api/platform/accounts", goodAlpacaBody);
      await h.post("/api/platform/accounts", goodAlpacaBody);
      const body = await (await h.call("/api/platform/accounts")).json();
      expect(body.accounts.map((a: any) => a.id)).toEqual(["my-alpaca-paper", "my-alpaca-paper-2"]);
    } finally { h.server.close(); }
  });
});

// ── OAuth flow ───────────────────────────────────────────────────────────

const SID = "sid=sess-abc123";

async function startOAuth(h: ReturnType<typeof makeHarness>, qs = "env=paper&label=Mi%20Alpaca") {
  const res = await h.call(`/api/platform/accounts/oauth/alpaca/start?${qs}`, { headers: { cookie: SID } });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

describe("Alpaca OAuth flow", () => {
  test("start: 302 to app.alpaca.markets with the documented params and our callback redirect_uri", async () => {
    const h = makeHarness();
    try {
      const loc = await startOAuth(h);
      expect(loc.origin + loc.pathname).toBe("https://app.alpaca.markets/oauth/authorize");
      expect(loc.searchParams.get("response_type")).toBe("code");
      expect(loc.searchParams.get("client_id")).toBe("CID");
      expect(loc.searchParams.get("redirect_uri")).toBe("https://bot.example.com" + ALPACA_OAUTH_CALLBACK_PATH);
      expect(loc.searchParams.get("env")).toBe("paper");
      expect(loc.searchParams.get("scope")).toBe("trading data");
      expect(loc.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
    } finally { h.server.close(); }
  });

  test("start without an OAuth app or public URL: error redirect, no crash", async () => {
    const h1 = makeHarness({ alpacaOAuth: () => null });
    try {
      const res = await h1.call("/api/platform/accounts/oauth/alpaca/start?env=paper");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("reason=oauth_not_configured");
    } finally { h1.server.close(); }
    const h2 = makeHarness({ publicBaseUrl: () => null });
    try {
      const res = await h2.call("/api/platform/accounts/oauth/alpaca/start?env=paper");
      expect(res.headers.get("location")).toContain("reason=no_public_url");
    } finally { h2.server.close(); }
  });

  test("complete with a forged/unknown state is rejected and saves nothing", async () => {
    const h = makeHarness();
    try {
      await startOAuth(h);
      const res = await h.call(`${ALPACA_OAUTH_COMPLETE_PATH}?code=${GOOD_CODE}&state=forged`, { headers: { cookie: SID } });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("accounts_oauth=error");
      expect(res.headers.get("location")).toContain("reason=bad_state");
      const list = await (await h.call("/api/platform/accounts")).json();
      expect(list.accounts).toEqual([]);
    } finally { h.server.close(); }
  });

  test("complete on a DIFFERENT session than start is rejected (state is session-bound)", async () => {
    const h = makeHarness();
    try {
      const loc = await startOAuth(h);
      const state = loc.searchParams.get("state")!;
      const res = await h.call(`${ALPACA_OAUTH_COMPLETE_PATH}?code=${GOOD_CODE}&state=${state}`, { headers: { cookie: "sid=other-session" } });
      expect(res.headers.get("location")).toContain("reason=bad_state");
    } finally { h.server.close(); }
  });

  test("expired state is rejected (TTL)", async () => {
    const h = makeHarness({ stateTtlMs: 60_000 });
    try {
      const loc = await startOAuth(h);
      const state = loc.searchParams.get("state")!;
      h.clock.now += 61_000;
      const res = await h.call(`${ALPACA_OAUTH_COMPLETE_PATH}?code=${GOOD_CODE}&state=${state}`, { headers: { cookie: SID } });
      expect(res.headers.get("location")).toContain("reason=bad_state");
    } finally { h.server.close(); }
  });

  test("happy path: code exchanged (form-encoded, documented token URL), token verified via Bearer, account saved, state single-use", async () => {
    const h = makeHarness();
    try {
      const loc = await startOAuth(h);
      const state = loc.searchParams.get("state")!;
      const res = await h.call(`${ALPACA_OAUTH_COMPLETE_PATH}?code=${GOOD_CODE}&state=${state}`, { headers: { cookie: SID } });
      expect(res.status).toBe(302);
      const back = new URL("http://x" + res.headers.get("location"));
      expect(back.searchParams.get("accounts_oauth")).toBe("ok");
      expect(back.searchParams.get("id")).toBe("mi-alpaca");

      // Token exchange went to THE token host (api., not paper-api.) with the documented params.
      const tok = h.fetchLog.find(c => c.url === "https://api.alpaca.markets/oauth/token")!;
      const p = new URLSearchParams(String(tok.init!.body));
      expect(p.get("grant_type")).toBe("authorization_code");
      expect(p.get("redirect_uri")).toBe("https://bot.example.com" + ALPACA_OAUTH_CALLBACK_PATH);
      // Verification used the Bearer token against the paper host.
      const verify = h.fetchLog.find(c => c.url.startsWith("https://paper-api.alpaca.markets/v2/account"))!;
      expect((verify.init!.headers as any)["Authorization"]).toBe(`Bearer ${OAUTH_TOKEN}`);

      const list = await (await h.call("/api/platform/accounts")).json();
      expect(list.accounts).toHaveLength(1);
      expect(list.accounts[0]).toMatchObject({
        id: "mi-alpaca", provider: "alpaca", environment: "paper",
        authType: "oauth", status: "verified", accountRef: "PA3TESTNUM",
      });
      expect(JSON.stringify(list)).not.toContain(OAUTH_TOKEN);
      // sealed at rest
      const row = getDB().prepare(`SELECT credentials_enc FROM platform_broker_accounts WHERE id = 'mi-alpaca'`).get() as any;
      expect(JSON.parse(fakeBox.open(row.credentials_enc)).accessToken).toBe(OAUTH_TOKEN);

      // replaying the same state is rejected (single-use)
      const replay = await h.call(`${ALPACA_OAUTH_COMPLETE_PATH}?code=${GOOD_CODE}&state=${state}`, { headers: { cookie: SID } });
      expect(replay.headers.get("location")).toContain("reason=bad_state");
    } finally { h.server.close(); }
  });

  test("callback (the registered redirect_uri) works WITHOUT the SameSite=strict session cookie: same-site bounce to complete, state untouched", async () => {
    const h = makeHarness();
    try {
      const loc = await startOAuth(h);
      const state = loc.searchParams.get("state")!;
      // Alpaca's cross-site redirect: the browser does not send the strict sid cookie.
      const bounce = await h.call(`${ALPACA_OAUTH_CALLBACK_PATH}?code=${GOOD_CODE}&state=${state}&junk=<x>`);
      expect(bounce.status).toBe(200);
      expect(bounce.headers.get("content-type")).toContain("text/html");
      expect(bounce.headers.get("cache-control")).toBe("no-store");
      expect(bounce.headers.get("referrer-policy")).toBe("no-referrer");
      const html = await bounce.text();
      const { url } = oauthBouncePage({ code: GOOD_CODE, state });
      expect(html).toContain(`content="0;url=${url.replace(/&/g, "&amp;")}"`);
      expect(html).not.toContain("junk");
      expect(h.fetchLog.some(c => c.url.includes("/oauth/token"))).toBe(false); // nothing exchanged before the bounce
      // The browser follows the bounce from our own page: same-site, cookie included.
      const done = await h.call(url, { headers: { cookie: SID } });
      expect(new URL("http://x" + done.headers.get("location")).searchParams.get("accounts_oauth")).toBe("ok");
    } finally { h.server.close(); }
  });

  test("only the bounce callback is public; start and complete stay behind the auth wall", () => {
    expect(PLATFORM_ACCOUNTS_PUBLIC_PATHS).toEqual([ALPACA_OAUTH_CALLBACK_PATH]);
    expect(oauthBouncePage({ code: 'a"b', state: "<s>" }).html).not.toMatch(/[<"]s>|a"b/);
  });

  test("user denied at Alpaca: error param short-circuits to a 'denied' redirect", async () => {
    const h = makeHarness();
    try {
      const res = await h.call(`${ALPACA_OAUTH_COMPLETE_PATH}?error=access_denied&state=whatever`, { headers: { cookie: SID } });
      expect(res.headers.get("location")).toContain("reason=denied");
    } finally { h.server.close(); }
  });
});

// ── verify + delete ──────────────────────────────────────────────────────

describe("verify and delete", () => {
  test("POST /:id/verify refreshes last_verified_at; a later broker failure flips status to error with a redacted lastError", async () => {
    const h = makeHarness();
    try {
      await h.post("/api/platform/accounts", goodAlpacaBody);
      h.clock.now += 5_000;
      const ok = await (await h.post("/api/platform/accounts/my-alpaca-paper/verify", {})).json();
      expect(ok.ok).toBe(true);
      expect(ok.account.lastVerifiedAt).toBe(h.clock.now);

      h.state.alpacaDown = true;
      h.clock.now += 5_000;
      const bad = await (await h.post("/api/platform/accounts/my-alpaca-paper/verify", {})).json();
      expect(bad.ok).toBe(false);
      expect(bad.account.status).toBe("error");
      expect(bad.account.lastError).toContain("500");
      expect(JSON.stringify(bad)).not.toContain(GOOD_ALPACA_SECRET);
      // the row survives (owner decides; a flaky broker must not delete accounts)
      const list = await (await h.call("/api/platform/accounts")).json();
      expect(list.accounts).toHaveLength(1);
    } finally { h.server.close(); }
  });

  test("verify on an unknown id → 404", async () => {
    const h = makeHarness();
    try {
      expect((await h.post("/api/platform/accounts/nope/verify", {})).status).toBe(404);
    } finally { h.server.close(); }
  });

  test("DELETE refuses (409) an account the bot depends on — resolved at boot or the configured link — and the list marks it", async () => {
    const { setRuntimeLinkedAccounts, resetRuntimeLinksForTests } = await import("../../platform/accounts/runtimeLinks");
    const { resetInstanceConfigForTests } = await import("../../platform/instance");
    const h = makeHarness();
    try {
      await h.post("/api/platform/accounts", goodAlpacaBody);
      setRuntimeLinkedAccounts(["my-alpaca-paper", null]);
      const listed = await (await h.call("/api/platform/accounts")).json();
      expect(listed.accounts[0].runtimeLinked).toBe(true);
      const res = await h.call("/api/platform/accounts/my-alpaca-paper", { method: "DELETE" });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("runtime_linked");
      expect((await (await h.call("/api/platform/accounts")).json()).accounts).toHaveLength(1);

      resetRuntimeLinksForTests();
      process.env.RUNTIME_ACCOUNT_ALPACA = "my-alpaca-paper"; // the next boot would look for it
      resetInstanceConfigForTests(); // the instance config is read once and cached
      try {
        expect((await h.call("/api/platform/accounts/my-alpaca-paper", { method: "DELETE" })).status).toBe(409);
      } finally {
        delete process.env.RUNTIME_ACCOUNT_ALPACA;
        resetInstanceConfigForTests();
      }
      const freed = await h.call("/api/platform/accounts/my-alpaca-paper", { method: "DELETE" });
      expect((await freed.json()).ok).toBe(true);
    } finally {
      resetRuntimeLinksForTests();
      h.server.close();
    }
  });

  test("POST /:id/revoke deletes the stored credentials, keeps a 'revoked' record; verify then demands reconnecting (409); DELETE still works", async () => {
    const h = makeHarness();
    try {
      await h.post("/api/platform/accounts", goodAlpacaBody);
      const r = await h.post("/api/platform/accounts/my-alpaca-paper/revoke", {});
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(body.account.status).toBe("revoked");
      expect(JSON.stringify(body)).not.toContain(GOOD_ALPACA_SECRET);

      // credentials are GONE from the row
      const { BrokerAccountsRepository } = await import("../../platform/accounts/repository");
      expect(new BrokerAccountsRepository().getCredentialsEnc("my-alpaca-paper")).toBe("");

      // verify demands a reconnect
      const v = await h.post("/api/platform/accounts/my-alpaca-paper/verify", {});
      expect(v.status).toBe(409);
      expect((await v.json()).error).toMatch(/[Rr]econnect/);

      // idempotent revoke
      expect((await h.post("/api/platform/accounts/my-alpaca-paper/revoke", {})).status).toBe(200);

      // removing the record afterwards still works
      expect((await h.call("/api/platform/accounts/my-alpaca-paper", { method: "DELETE" })).status).toBe(200);
    } finally { h.server.close(); }
  });

  test("revoke refuses (409 runtime_linked) an account the bot signs with; unknown id → 404", async () => {
    const { setRuntimeLinkedAccounts, resetRuntimeLinksForTests } = await import("../../platform/accounts/runtimeLinks");
    const h = makeHarness();
    try {
      await h.post("/api/platform/accounts", goodAlpacaBody);
      setRuntimeLinkedAccounts(["my-alpaca-paper"]);
      const res = await h.post("/api/platform/accounts/my-alpaca-paper/revoke", {});
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("runtime_linked");
      // still verified, credentials intact
      const list = await (await h.call("/api/platform/accounts")).json();
      expect(list.accounts[0].status).toBe("verified");

      resetRuntimeLinksForTests();
      expect((await h.post("/api/platform/accounts/nope/revoke", {})).status).toBe(404);
    } finally {
      resetRuntimeLinksForTests();
      h.server.close();
    }
  });

  test("DELETE removes the row; a second DELETE is a 404", async () => {
    const h = makeHarness();
    try {
      await h.post("/api/platform/accounts", goodAlpacaBody);
      const res = await h.call("/api/platform/accounts/my-alpaca-paper", { method: "DELETE" });
      expect((await res.json()).ok).toBe(true);
      const list = await (await h.call("/api/platform/accounts")).json();
      expect(list.accounts).toEqual([]);
      expect((await h.call("/api/platform/accounts/my-alpaca-paper", { method: "DELETE" })).status).toBe(404);
    } finally { h.server.close(); }
  });
});
