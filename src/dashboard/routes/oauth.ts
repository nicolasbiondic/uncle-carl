// ═══ Owner OAuth login — /auth/oauth/:provider/{start,callback} ═══
//
// GitHub and Google sign-in for the SINGLE owner of a self-hosted instance.
// Disabled (404) unless the provider is configured (instance.json `oauth`
// block or OAUTH_* env — src/platform/instance.ts). The allowlist is the
// IDENTITY, never just "any account at the provider":
//   - GitHub: numeric account id (logins can be renamed/recycled);
//   - Google: verified email (email_verified === true) via OIDC id_token.
//
// Implementation choice — hand-rolled `fetch`, no OAuth library: exactly two
// fixed authorization-code flows, no refresh tokens, no dynamic providers.
// A dependency (even a small one like `arctic`) would add supply-chain
// surface and a bun.lock change that prod deploys with --frozen-lockfile —
// not worth it for ~100 lines of protocol code that tests can drive fully
// offline via the injectable fetch below.
//
// Security notes:
//   - `state` is double-bound: it must exist in the in-memory pending map
//     (one-shot, 10-min TTL) AND match the browser's oauth_state cookie —
//     login-CSRF needs both the victim's cookie jar and our server state.
//   - Google uses PKCE (S256) + OIDC nonce. The id_token arrives on the
//     direct TLS token-endpoint response, so per OIDC Core §3.1.3.7 the
//     TLS server validation MAY stand in for signature checking; we verify
//     iss / aud / exp / nonce / email_verified / email instead of pulling
//     JWKS. GitHub's OAuth-app flow has no PKCE support; state + the
//     client secret on the code exchange cover it.
//   - On success the session is IDENTICAL to a password login (same store,
//     same cookie flags, same CSRF token mechanics). Role: admin (owner).
//   - Failures redirect to /login?error=oauth; details go to the log only.

import express from "express";
import crypto from "crypto";
import { sessions, SESSION_TTL } from "../auth-store";
import type { Session } from "../auth-store";
import {
  loadInstanceConfig, publicBaseUrl, cookieSecure,
} from "../../platform/instance";
import type { GithubOAuthConfig, GoogleOAuthConfig } from "../../platform/instance";
import { rateLimiter } from "../middleware/rateLimiter";
import { getClientIp } from "../dashboard-utils";
import { createLogger } from "../../utils/logger";

const log = createLogger("Dashboard");

// ── Injectable fetch (tests drive the whole flow offline) ─────────────────

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
export function setOAuthFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

// ── Pending logins (state → flow data; one-shot, TTL'd, capped) ───────────

interface PendingLogin {
  provider: "github" | "google";
  createdAt: number;
  redirectUri: string;
  nonce?: string;        // google
  codeVerifier?: string; // google (PKCE)
}

const PENDING_TTL_MS = 10 * 60_000;
const PENDING_MAX = 100;
export const pendingLogins = new Map<string, PendingLogin>(); // exported for tests

function sweepPending(): void {
  const now = Date.now();
  for (const [k, v] of pendingLogins) {
    if (now - v.createdAt > PENDING_TTL_MS) pendingLogins.delete(k);
  }
  // Cap: drop oldest first (Map preserves insertion order).
  while (pendingLogins.size > PENDING_MAX) {
    const oldest = pendingLogins.keys().next().value;
    if (oldest === undefined) break;
    pendingLogins.delete(oldest);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function redirectUriFor(req: express.Request, provider: string): string {
  const base = publicBaseUrl() ?? `http://${req.headers.host}`;
  return `${base}/auth/oauth/${provider}/callback`;
}

function failLogin(res: express.Response, reason: string): void {
  log.warn(`OAuth login rejected: ${reason}`);
  res.redirect("/login?error=oauth");
}

/** Create the SAME session a successful password login creates. */
function createOwnerSession(req: express.Request, res: express.Response, username: string, displayName: string): void {
  const sid = crypto.randomBytes(32).toString("hex");
  const session: Session = {
    id: sid,
    username,
    role: "admin",
    displayName,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    csrfToken: crypto.randomBytes(24).toString("hex"),
    rememberMe: false,
    settings: { viewId: "consolidated" },
    // Device metadata for the Ajustes → Sessions list (routes/platform.ts).
    userAgent: String(req.headers["user-agent"] ?? ""),
    ip: getClientIp(req),
  };
  sessions.set(sid, session);
  res.cookie("sid", sid, {
    httpOnly: true,
    maxAge: SESSION_TTL,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
  });
  // The callback navigation ORIGINATES at the provider (cross-site), so a
  // 302 straight to "/" would not carry the SameSite=Strict sid cookie in
  // some browsers. Serve a same-origin meta-refresh instead — the follow-up
  // navigation to "/" is then same-site and the cookie flows. No script
  // needed (CSP-independent).
  res.type("html").send(
    `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/">` +
    `<title>Signed in</title></head><body style="background:#060a13;color:#c8d4e8;` +
    `font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh">` +
    `Signed in — <a href="/" style="color:#5ba8ff;margin-left:6px">continue</a></body></html>`,
  );
}

// ── Provider flows ─────────────────────────────────────────────────────────

async function exchangeGithub(
  cfg: GithubOAuthConfig, code: string, redirectUri: string,
): Promise<{ id: number; login: string; name: string | null }> {
  const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) throw new Error(`github token endpoint HTTP ${tokenRes.status}`);
  const tokenBody: any = await tokenRes.json();
  const accessToken = tokenBody?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new Error(`github token exchange failed (${tokenBody?.error ?? "no access_token"})`);
  }

  const userRes = await fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "uncle-carl-dashboard",
    },
  });
  if (!userRes.ok) throw new Error(`github /user HTTP ${userRes.status}`);
  const user: any = await userRes.json();
  if (!Number.isSafeInteger(user?.id)) throw new Error("github /user returned no numeric id");
  return { id: user.id, login: String(user.login ?? ""), name: user.name ?? null };
}

function decodeJwtPayload(jwt: string): any {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("id_token is not a JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

async function exchangeGoogle(
  cfg: GoogleOAuthConfig, code: string, redirectUri: string, codeVerifier: string, nonce: string,
): Promise<{ email: string; name: string | null }> {
  const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`google token endpoint HTTP ${tokenRes.status}`);
  const tokenBody: any = await tokenRes.json();
  if (typeof tokenBody?.id_token !== "string") throw new Error("google token exchange returned no id_token");

  const claims = decodeJwtPayload(tokenBody.id_token);
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new Error(`google id_token bad iss "${claims.iss}"`);
  }
  if (claims.aud !== cfg.clientId) throw new Error("google id_token aud mismatch");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
    throw new Error("google id_token expired");
  }
  if (claims.nonce !== nonce) throw new Error("google id_token nonce mismatch");
  if (claims.email_verified !== true) throw new Error("google email not verified");
  if (typeof claims.email !== "string" || claims.email === "") throw new Error("google id_token has no email");
  return { email: claims.email.toLowerCase(), name: typeof claims.name === "string" ? claims.name : null };
}

// ── Routes ─────────────────────────────────────────────────────────────────

const oauthLimiter = rateLimiter(30, 60_000, (req) => `oauth|${req.socket.remoteAddress ?? "?"}`);

export function registerOAuthRoutes(app: express.Application): void {
  app.get("/auth/oauth/:provider/start", oauthLimiter, (req, res) => {
    sweepPending();
    const provider = String(req.params.provider);
    const oauth = loadInstanceConfig().oauth;
    const state = b64url(crypto.randomBytes(24));
    const redirectUri = redirectUriFor(req, provider);

    let authorizeUrl: URL;
    if (provider === "github" && oauth.github) {
      authorizeUrl = new URL("https://github.com/login/oauth/authorize");
      authorizeUrl.search = new URLSearchParams({
        client_id: oauth.github.clientId,
        redirect_uri: redirectUri,
        state,
        allow_signup: "false",
        // no scope: the public profile (id/login) is all we need
      }).toString();
      pendingLogins.set(state, { provider, createdAt: Date.now(), redirectUri });
    } else if (provider === "google" && oauth.google) {
      const nonce = b64url(crypto.randomBytes(24));
      const codeVerifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
      authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorizeUrl.search = new URLSearchParams({
        client_id: oauth.google.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      pendingLogins.set(state, { provider, createdAt: Date.now(), redirectUri, nonce, codeVerifier });
    } else {
      return res.status(404).json({ error: "OAuth provider not configured" });
    }

    // Double-binding cookie: Lax (not Strict) because the provider's
    // redirect back to /callback is a cross-site top-level GET and MUST
    // carry this cookie for the check to pass.
    res.cookie("oauth_state", state, {
      httpOnly: true,
      maxAge: PENDING_TTL_MS,
      sameSite: "lax",
      secure: cookieSecure(),
      path: "/auth/oauth/",
    });
    res.redirect(authorizeUrl.toString());
  });

  app.get("/auth/oauth/:provider/callback", oauthLimiter, async (req, res) => {
    const provider = String(req.params.provider);
    const oauth = loadInstanceConfig().oauth;
    const cfg = provider === "github" ? oauth.github : provider === "google" ? oauth.google : null;
    if (!cfg) return res.status(404).json({ error: "OAuth provider not configured" });

    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const cookieState = (req as any).cookies?.oauth_state;
    res.clearCookie("oauth_state", { path: "/auth/oauth/" });

    const pending = state !== "" ? pendingLogins.get(state) : undefined;
    if (pending) pendingLogins.delete(state); // one-shot, even on failure
    if (!pending || pending.provider !== provider) return failLogin(res, `${provider}: unknown/expired state`);
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) return failLogin(res, `${provider}: state expired`);
    if (!cookieState || cookieState !== state) return failLogin(res, `${provider}: state/cookie mismatch (possible login CSRF)`);
    if (code === "") return failLogin(res, `${provider}: provider returned no code (${req.query.error ?? "denied"})`);

    try {
      const ownerUsername = loadInstanceConfig().owner?.username;
      if (provider === "github") {
        const gh = cfg as GithubOAuthConfig;
        const user = await exchangeGithub(gh, code, pending.redirectUri);
        if (user.id !== gh.allowedId) {
          return failLogin(res, `github: account id ${user.id} ("${user.login}") is not the allowed owner (${gh.allowedId})`);
        }
        log.info(`🔑 Login (github): ${user.login} (#${user.id})`);
        return createOwnerSession(req, res, ownerUsername ?? `github:${user.login.toLowerCase()}`, user.name || user.login || "Owner");
      } else {
        const gg = cfg as GoogleOAuthConfig;
        const user = await exchangeGoogle(gg, code, pending.redirectUri, pending.codeVerifier!, pending.nonce!);
        if (user.email !== gg.allowedEmail) {
          return failLogin(res, `google: ${user.email} is not the allowed owner email`);
        }
        log.info(`🔑 Login (google): ${user.email}`);
        return createOwnerSession(req, res, ownerUsername ?? user.email, user.name || user.email);
      }
    } catch (e: any) {
      return failLogin(res, `${provider}: ${e?.message ?? e}`);
    }
  });
}
