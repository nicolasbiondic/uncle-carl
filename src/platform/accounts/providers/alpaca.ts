// ═══ Alpaca provider adapter — verification + OAuth (Connect) helpers ═══
//
// Facts verified against the official docs on 2026-10-04
// (https://docs.alpaca.markets/us/docs/using-oauth2-and-trading-api):
//
//  - Authorize URL:  GET https://app.alpaca.markets/oauth/authorize with
//    response_type=code, client_id, redirect_uri (must match a whitelisted
//    one), state (anti-CSRF), scope (space-delimited; READ-ONLY access is
//    the default when omitted) and env=live|paper (omitting env prompts the
//    user for both a live and a paper account).
//  - Token URL:      POST https://api.alpaca.markets/oauth/token — ALWAYS on
//    api.alpaca.markets, even for paper (the forum answer from Alpaca staff
//    confirms /oauth/token only exists there). Form-encoded body:
//    grant_type=authorization_code, code, client_id, client_secret,
//    redirect_uri. Response: { access_token, token_type: "bearer", scope }.
//  - The docs publish NO expires_in and NO refresh_token for Connect tokens
//    (one token can authorize a live and/or a paper account). Conservative
//    handling here: store the token, treat any later 401/403 on /v2/account
//    as a credential error surfaced to the owner (re-connect = re-run the
//    flow). No refresh machinery is invented.
//  - API usage:      Authorization: Bearer <token> against
//    paper-api.alpaca.markets (paper) or api.alpaca.markets (live) — same
//    /v2 endpoints as API-key auth (APCA-API-KEY-ID/APCA-API-SECRET-KEY).

import type { BrokerCredentials, VerificationResult } from "../types";

export const ALPACA_AUTHORIZE_URL = "https://app.alpaca.markets/oauth/authorize";
export const ALPACA_TOKEN_URL = "https://api.alpaca.markets/oauth/token";

/** Scopes requested by the Connect flow. The registry's own verification only
 *  needs the default read-only access, but the whole point of registering an
 *  account is for the portfolio engines to trade it later — asking for
 *  `trading data` now avoids forcing the owner through a second consent
 *  screen then. (account:write is NOT requested.) */
export const ALPACA_OAUTH_SCOPE = "trading data";

export type AlpacaEnv = "paper" | "live";

export function alpacaApiBase(env: AlpacaEnv): string {
  return env === "live" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets";
}

/** Bearer auth for OAuth tokens; APCA key headers for API keys. */
export function alpacaAuthHeaders(creds: BrokerCredentials): Record<string, string> {
  if (creds.kind === "oauth") return { Authorization: `Bearer ${creds.accessToken}` };
  return { "APCA-API-KEY-ID": creds.apiKey, "APCA-API-SECRET-KEY": creds.apiSecret };
}

export function alpacaAuthorizeUrl(opts: {
  clientId: string;
  state: string;
  env: AlpacaEnv;
  redirectUri: string;
  scope?: string;
}): string {
  const u = new URL(ALPACA_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.state);
  u.searchParams.set("scope", opts.scope ?? ALPACA_OAUTH_SCOPE);
  u.searchParams.set("env", opts.env);
  return u.toString();
}

/** Exchanges the authorization code for an access token. Throws on any
 *  failure; messages carry only HTTP status / token-endpoint error codes,
 *  never the client secret or the code. */
export async function exchangeAlpacaCode(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
}): Promise<{ accessToken: string; tokenType?: string; scope?: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  });
  const res = await fetchFn(ALPACA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const code = json && typeof json.error === "string" ? ` (${json.error})` : "";
    throw new Error(`Alpaca token exchange failed: HTTP ${res.status}${code}`);
  }
  if (!json || typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("Alpaca token exchange returned no access_token");
  }
  return {
    accessToken: json.access_token,
    tokenType: typeof json.token_type === "string" ? json.token_type : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

/** Read-only verification: GET /v2/account on the env-matching host.
 *  Never throws — network/HTTP failures come back as { ok: false }. */
export async function verifyAlpaca(
  creds: BrokerCredentials,
  env: AlpacaEnv,
  fetchFn: typeof fetch = fetch,
): Promise<VerificationResult> {
  try {
    const res = await fetchFn(`${alpacaApiBase(env)}/v2/account`, {
      headers: { ...alpacaAuthHeaders(creds), Accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `Alpaca rejected the credentials (HTTP ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, error: `Alpaca /v2/account failed (HTTP ${res.status})` };
    }
    const acct: any = await res.json().catch(() => null);
    if (!acct || typeof acct !== "object") {
      return { ok: false, error: "Alpaca /v2/account returned an unreadable body" };
    }
    const warnings: string[] = [];
    if (typeof acct.status === "string" && acct.status !== "ACTIVE") {
      warnings.push(`Alpaca account status is ${acct.status}`);
    }
    if (acct.trading_blocked === true) warnings.push("Alpaca account has trading_blocked=true");
    const accountRef =
      (typeof acct.account_number === "string" && acct.account_number) ||
      (typeof acct.id === "string" && acct.id) || null;
    return { ok: true, accountRef, warnings };
  } catch (e: any) {
    return { ok: false, error: `Alpaca verification failed: ${e?.message ?? e}` };
  }
}
