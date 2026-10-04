// ═══ Owner OAuth login (GitHub/Google) — offline flow tests ═══
// The provider round-trips are driven through the injectable fetch
// (setOAuthFetchForTests); no network. Each flow asserts the SECURITY
// properties: state double-binding (map + cookie), PKCE/nonce on Google,
// allowlist by numeric id / verified email, and that success mints the
// same kind of session a password login does.
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { DashboardServer } from "../server";
import { sessions, USERS } from "../auth-store";
import { resetInstanceConfigForTests } from "../../platform/instance";
import { pendingLogins, setOAuthFetchForTests } from "./oauth";
import { makeTestDb } from "../../test-support/db";

const fakeAm = {
  executor: {
    alpaca: { isConnected: () => false, lastMessageAt: 0 },
    binance: { isConnected: () => false, lastMessageAt: 0 },
  },
  accounts: new Map(),
  lastSyncAt: 0,
  getCircuits: () => ({}),
  getDashboardData: () => ({}),
} as any;

const ENV_KEYS = [
  "UC_DATA_DIR", "PUBLIC_URL", "DASHBOARD_COOKIE_SECURE",
  "OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET", "OAUTH_GITHUB_ALLOWED_ID", "OAUTH_GITHUB_ALLOWED_LOGIN",
  "OAUTH_GOOGLE_CLIENT_ID", "OAUTH_GOOGLE_CLIENT_SECRET", "OAUTH_GOOGLE_ALLOWED_EMAIL",
];
const savedEnv: Record<string, string | undefined> = {};

let server: any;
let base: string;

beforeAll(async () => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  makeTestDb();
  if (!USERS.some(u => u.username === "oauth-test-admin")) {
    USERS.push({ username: "oauth-test-admin", passwordHash: "x", role: "admin", displayName: "T" });
  }
  const dashboard = new DashboardServer(fakeAm);
  server = (dashboard as any).app.listen(0);
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  const i = USERS.findIndex(u => u.username === "oauth-test-admin");
  if (i >= 0) USERS.splice(i, 1);
  resetInstanceConfigForTests();
  setOAuthFetchForTests(null);
  server?.close();
});

beforeEach(() => {
  pendingLogins.clear();
  setOAuthFetchForTests(null);
  for (const k of ENV_KEYS) if (k.startsWith("OAUTH_") || k === "PUBLIC_URL") delete process.env[k];
  resetInstanceConfigForTests();
});

function configureGithub(allowedId = 42): void {
  process.env.OAUTH_GITHUB_CLIENT_ID = "gh-client";
  process.env.OAUTH_GITHUB_CLIENT_SECRET = "gh-secret";
  process.env.OAUTH_GITHUB_ALLOWED_ID = String(allowedId);
  resetInstanceConfigForTests();
}

function configureGoogle(allowedEmail = "owner@example.com"): void {
  process.env.OAUTH_GOOGLE_CLIENT_ID = "gg-client";
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = "gg-secret";
  process.env.OAUTH_GOOGLE_ALLOWED_EMAIL = allowedEmail;
  resetInstanceConfigForTests();
}

function cookieOf(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    if (c.startsWith(`${name}=`)) return c.split(";")[0].split("=").slice(1).join("=");
  }
  return null;
}

async function startFlow(provider: string): Promise<{ location: URL; state: string }> {
  const res = await fetch(`${base}/auth/oauth/${provider}/start`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  expect(cookieOf(res, "oauth_state")).toBe(state);
  return { location, state };
}

const jsonRes = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("disabled unless configured (the additive default)", () => {
  test("start and callback 404 with no provider configured; login page shows no buttons", async () => {
    for (const p of ["github", "google", "bogus"]) {
      expect((await fetch(`${base}/auth/oauth/${p}/start`, { redirect: "manual" })).status).toBe(404);
      expect((await fetch(`${base}/auth/oauth/${p}/callback?code=x&state=y`, { redirect: "manual" })).status).toBe(404);
    }
    const login = await (await fetch(`${base}/login`)).text();
    expect(login).not.toContain("Continue with GitHub");
    expect(login).not.toContain("Continue with Google");
  });

  test("login page shows exactly the configured provider's button", async () => {
    configureGithub();
    const login = await (await fetch(`${base}/login`)).text();
    expect(login).toContain("Continue with GitHub");
    expect(login).not.toContain("Continue with Google");
  });
});

describe("GitHub flow", () => {
  test("start redirects to github authorize with state + client_id, no PKCE pretense", async () => {
    configureGithub();
    const { location, state } = await startFlow("github");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("gh-client");
    expect(location.searchParams.get("allow_signup")).toBe("false");
    expect(pendingLogins.get(state)?.provider).toBe("github");
  });

  test("full callback: allowed numeric id mints an admin session identical to password login", async () => {
    configureGithub(42);
    const { state } = await startFlow("github");
    const calls: string[] = [];
    setOAuthFetchForTests(async (url, init) => {
      calls.push(url);
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        const body = JSON.parse(String(init?.body));
        expect(body.client_id).toBe("gh-client");
        expect(body.client_secret).toBe("gh-secret");
        expect(body.code).toBe("the-code");
        return jsonRes({ access_token: "tok" });
      }
      if (url === "https://api.github.com/user") {
        expect((init?.headers as any).Authorization).toBe("Bearer tok");
        return jsonRes({ id: 42, login: "nico", name: "Nico" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const res = await fetch(`${base}/auth/oauth/github/callback?code=the-code&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: `oauth_state=${state}` },
    });
    expect(res.status).toBe(200); // same-origin meta-refresh page (SameSite=Strict sid survives)
    expect(await res.text()).toContain('url=/');
    const sid = cookieOf(res, "sid");
    expect(sid).toBeTruthy();
    const session = sessions.get(sid!);
    expect(session).toMatchObject({ role: "admin" });
    expect(session!.csrfToken.length).toBeGreaterThan(20);
    expect(calls).toHaveLength(2);
    expect(pendingLogins.has(state)).toBe(false); // one-shot
    sessions.delete(sid!);
  });

  test("wrong numeric id is rejected even with a valid GitHub account (allowlist, not auth)", async () => {
    configureGithub(42);
    const { state } = await startFlow("github");
    setOAuthFetchForTests(async (url) =>
      url.includes("access_token") ? jsonRes({ access_token: "tok" }) : jsonRes({ id: 43, login: "intruder" }));
    const res = await fetch(`${base}/auth/oauth/github/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: "manual", headers: { cookie: `oauth_state=${state}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=oauth");
    expect(cookieOf(res, "sid")).toBeFalsy();
  });

  test("state without the browser cookie is rejected (login CSRF)", async () => {
    configureGithub();
    const { state } = await startFlow("github");
    setOAuthFetchForTests(async () => { throw new Error("must not be called"); });
    const res = await fetch(`${base}/auth/oauth/github/callback?code=c&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=oauth");
  });

  test("unknown/replayed state is rejected", async () => {
    configureGithub();
    setOAuthFetchForTests(async () => { throw new Error("must not be called"); });
    const res = await fetch(`${base}/auth/oauth/github/callback?code=c&state=forged`, {
      redirect: "manual", headers: { cookie: "oauth_state=forged" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=oauth");
  });
});

function googleIdToken(claims: Record<string, unknown>): string {
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.${Buffer.from("sig").toString("base64url")}`;
}

describe("Google flow (OIDC + PKCE + nonce)", () => {
  async function googleCallback(state: string, tokenBody: any, expectVerifier?: string): Promise<Response> {
    setOAuthFetchForTests(async (url, init) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      const params = new URLSearchParams(String(init?.body));
      if (expectVerifier) expect(params.get("code_verifier")).toBe(expectVerifier);
      expect(params.get("grant_type")).toBe("authorization_code");
      return jsonRes(tokenBody);
    });
    return await fetch(`${base}/auth/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: "manual", headers: { cookie: `oauth_state=${state}` },
    });
  }

  test("start carries PKCE S256 challenge + nonce; callback verifies id_token claims and email allowlist", async () => {
    configureGoogle("owner@example.com");
    const { location, state } = await startFlow("google");
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toContain("openid");

    const pending = pendingLogins.get(state)!;
    expect(pending.codeVerifier!.length).toBeGreaterThan(40);
    // The challenge in the URL must be S256(verifier)
    const crypto = await import("crypto");
    const expectedChallenge = crypto.createHash("sha256").update(pending.codeVerifier!).digest().toString("base64url");
    expect(location.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(location.searchParams.get("nonce")).toBe(pending.nonce!);

    const idToken = googleIdToken({
      iss: "https://accounts.google.com", aud: "gg-client",
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: pending.nonce, email: "Owner@Example.com", email_verified: true, name: "Owner",
    });
    const res = await googleCallback(state, { id_token: idToken }, pending.codeVerifier);
    expect(res.status).toBe(200);
    const sid = cookieOf(res, "sid");
    expect(sid).toBeTruthy();
    expect(sessions.get(sid!)).toMatchObject({ role: "admin" });
    sessions.delete(sid!);
  });

  const rejectionCases: Array<[string, (nonce: string) => Record<string, unknown>]> = [
    ["unverified email", (nonce) => ({ iss: "https://accounts.google.com", aud: "gg-client", exp: Math.floor(Date.now() / 1000) + 600, nonce, email: "owner@example.com", email_verified: false })],
    ["wrong email", (nonce) => ({ iss: "https://accounts.google.com", aud: "gg-client", exp: Math.floor(Date.now() / 1000) + 600, nonce, email: "intruder@example.com", email_verified: true })],
    ["wrong nonce", () => ({ iss: "https://accounts.google.com", aud: "gg-client", exp: Math.floor(Date.now() / 1000) + 600, nonce: "forged", email: "owner@example.com", email_verified: true })],
    ["wrong aud", (nonce) => ({ iss: "https://accounts.google.com", aud: "other-client", exp: Math.floor(Date.now() / 1000) + 600, nonce, email: "owner@example.com", email_verified: true })],
    ["expired", (nonce) => ({ iss: "https://accounts.google.com", aud: "gg-client", exp: Math.floor(Date.now() / 1000) - 10, nonce, email: "owner@example.com", email_verified: true })],
    ["bad iss", (nonce) => ({ iss: "https://evil.example.com", aud: "gg-client", exp: Math.floor(Date.now() / 1000) + 600, nonce, email: "owner@example.com", email_verified: true })],
  ];

  for (const [label, claims] of rejectionCases) {
    test(`rejects id_token with ${label}`, async () => {
      configureGoogle("owner@example.com");
      const { state } = await startFlow("google");
      const pending = pendingLogins.get(state)!;
      const res = await googleCallback(state, { id_token: googleIdToken(claims(pending.nonce!)) });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?error=oauth");
      expect(cookieOf(res, "sid")).toBeFalsy();
    });
  }
});
