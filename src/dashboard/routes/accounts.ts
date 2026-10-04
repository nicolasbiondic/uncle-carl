// ═══ /api/platform/accounts — broker-account registry routes (2026-10-04) ═══
//
// Everything here runs BEHIND server.ts's auth wall and CSRF gate
// (mutations arrive with a session + x-csrf-token; the OAuth routes are GETs,
// protected by the session-bound, TTL'd, single-use `state` — the standard
// OAuth redirect pattern), except the callback in
// PLATFORM_ACCOUNTS_PUBLIC_PATHS, which only renders a same-site bounce.
//
// Secrets never leave: responses carry only redacted BrokerAccountRecord
// rows, and verification errors are scrubbed by the service.

import express from "express";
import {
  AccountsError, BrokerAccountsService,
} from "../../platform/accounts/service";
import { OAuthStateStore } from "../../platform/accounts/oauthState";
import {
  ALPACA_OAUTH_SCOPE, alpacaAuthorizeUrl, exchangeAlpacaCode,
} from "../../platform/accounts/providers/alpaca";
import type { AccountsDeps } from "../../platform/accounts/types";
import { createLogger } from "../../utils/logger";

const log = createLogger("PlatformAccounts");

export const ALPACA_OAUTH_START_PATH = "/api/platform/accounts/oauth/alpaca/start";
export const ALPACA_OAUTH_CALLBACK_PATH = "/api/platform/accounts/oauth/alpaca/callback";
export const ALPACA_OAUTH_COMPLETE_PATH = "/api/platform/accounts/oauth/alpaca/complete";

/** Paths server.ts must let through its auth wall (GET only). The session
 *  cookie is SameSite=strict, so the browser does NOT send it on Alpaca's
 *  cross-site redirect back to the callback: the callback only renders a
 *  same-site bounce to the COMPLETE path, which is a navigation started by
 *  our own page, carries the cookie and stays behind the wall. Nothing
 *  sensitive happens before the bounce. */
export const PLATFORM_ACCOUNTS_PUBLIC_PATHS: readonly string[] = [ALPACA_OAUTH_CALLBACK_PATH];

const htmlAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");

/** Pure: the same-site bounce page for the OAuth callback. Only `code`,
 *  `state` and `error` are carried over. No script: a meta refresh works
 *  under the dashboard's `script-src 'self'` CSP, plus a manual link. */
export function oauthBouncePage(query: Record<string, unknown>): { url: string; html: string } {
  const carried = new URLSearchParams();
  for (const k of ["code", "state", "error"]) {
    const v = query[k];
    if (typeof v === "string" && v) carried.set(k, v);
  }
  const url = `${ALPACA_OAUTH_COMPLETE_PATH}?${carried.toString()}`;
  const href = htmlAttr(url);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
    `<meta http-equiv="refresh" content="0;url=${href}"><title>Alpaca</title></head>` +
    `<body><p>Conectando la cuenta de Alpaca… / Connecting your Alpaca account… <a href="${href}">continuar / continue</a></p></body></html>`;
  return { url, html };
}

/** Where the browser lands after an OAuth round-trip; the v4 SPA reads the
 *  accounts_oauth=ok|error query params and opens the Accounts panel. */
const oauthRedirect = (res: express.Response, params: Record<string, string>) =>
  res.redirect("/?" + new URLSearchParams(params).toString());

function sendError(res: express.Response, e: unknown): void {
  if (e instanceof AccountsError) {
    res.status(e.httpStatus).json({ error: e.message, code: e.code });
    return;
  }
  log.error(`accounts route error: ${(e as any)?.message ?? e}`);
  res.status(500).json({ error: "internal error" });
}

/** Session id for state-binding. server.ts populates req.session/req.cookies;
 *  the raw-header fallback keeps the binding working on a bare express too. */
function sessionIdOf(req: express.Request): string {
  const r = req as any;
  if (r.session?.id) return String(r.session.id);
  if (r.cookies?.sid) return String(r.cookies.sid);
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(String(req.headers.cookie ?? ""));
  return m ? decodeURIComponent(m[1]) : "";
}

export function registerPlatformAccountsRoutes(
  app: express.Application,
  deps: AccountsDeps,
  opts?: { stateTtlMs?: number },
): void {
  const service = new BrokerAccountsService(deps);
  const states = new OAuthStateStore(opts?.stateTtlMs, deps.now);
  const fetchFn = deps.fetch ?? fetch;
  const callbackUri = (): string | null => {
    const base = deps.publicBaseUrl();
    return base ? base.replace(/\/+$/, "") + ALPACA_OAUTH_CALLBACK_PATH : null;
  };

  // ── GET /api/platform/accounts — redacted list + capability flags ───────
  app.get("/api/platform/accounts", (_req, res) => {
    try {
      res.json({
        configured: service.isConfigured(),
        alpacaOAuth: !!deps.alpacaOAuth() && !!deps.publicBaseUrl(),
        accounts: service.list(),
      });
    } catch (e) { sendError(res, e); }
  });

  // ── POST /api/platform/accounts — add by API key (verify-then-save) ─────
  app.post("/api/platform/accounts", async (req, res) => {
    try {
      const { provider, environment, label, apiKey, apiSecret } = req.body ?? {};
      const result = await service.addApiKeyAccount({ provider, environment, label, apiKey, apiSecret });
      log.info(`broker account added: ${result.account.id} (${result.account.provider}/${result.account.environment})`);
      res.status(201).json(result);
    } catch (e) { sendError(res, e); }
  });

  // ── POST /api/platform/accounts/:id/verify — re-run read-only check ─────
  app.post("/api/platform/accounts/:id/verify", async (req, res) => {
    try {
      res.json(await service.verifyAccount(req.params.id));
    } catch (e) { sendError(res, e); }
  });

  // ── DELETE /api/platform/accounts/:id ────────────────────────────────────
  app.delete("/api/platform/accounts/:id", (req, res) => {
    try {
      if (!service.remove(req.params.id)) {
        return res.status(404).json({ error: `No account '${req.params.id}'`, code: "not_found" });
      }
      log.info(`broker account removed: ${req.params.id}`);
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  // ── GET …/oauth/alpaca/start?env=paper|live&label=… ──────────────────────
  // Browser navigation (not XHR): failures redirect back to the SPA with a
  // machine-readable reason instead of dead-ending on a JSON error page.
  app.get(ALPACA_OAUTH_START_PATH, (req, res) => {
    const fail = (reason: string) => oauthRedirect(res, { accounts_oauth: "error", reason });
    try {
      const oauth = deps.alpacaOAuth();
      if (!oauth) return fail("oauth_not_configured");
      if (!service.isConfigured()) return fail("not_configured");
      const redirectUri = callbackUri();
      if (!redirectUri) return fail("no_public_url");
      const env = req.query.env === "live" ? "live" : "paper";
      const rawLabel = typeof req.query.label === "string" ? req.query.label.trim() : "";
      const label = (rawLabel || `Alpaca ${env}`).slice(0, 64);
      const state = states.issue(sessionIdOf(req), env, label);
      res.redirect(alpacaAuthorizeUrl({
        clientId: oauth.clientId, state, env, redirectUri, scope: ALPACA_OAUTH_SCOPE,
      }));
    } catch (e) {
      log.error(`oauth start failed: ${(e as any)?.message ?? e}`);
      fail("internal");
    }
  });

  // ── GET …/oauth/alpaca/callback — the redirect_uri registered with Alpaca.
  // Outside the auth wall (PLATFORM_ACCOUNTS_PUBLIC_PATHS): renders the
  // same-site bounce and does nothing else — the state is consumed by the
  // COMPLETE route, with the session.
  app.get(ALPACA_OAUTH_CALLBACK_PATH, (req, res) => {
    const { html } = oauthBouncePage(req.query as Record<string, unknown>);
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.type("html").send(html);
  });

  // ── GET …/oauth/alpaca/complete?code&state ───────────────────────────────
  app.get(ALPACA_OAUTH_COMPLETE_PATH, async (req, res) => {
    const fail = (reason: string) => oauthRedirect(res, { accounts_oauth: "error", reason });
    try {
      if (typeof req.query.error === "string" && req.query.error) return fail("denied");
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const state = typeof req.query.state === "string" ? req.query.state : "";
      if (!code || !state) return fail("missing_params");

      // State must exist, be fresh, belong to THIS session, and is burned
      // on first use — everything else is treated as forgery.
      const pending = states.consume(state, sessionIdOf(req));
      if (!pending) return fail("bad_state");

      const oauth = deps.alpacaOAuth();
      if (!oauth) return fail("oauth_not_configured");
      const redirectUri = callbackUri();
      if (!redirectUri) return fail("no_public_url");

      let token;
      try {
        token = await exchangeAlpacaCode({
          code, redirectUri,
          clientId: oauth.clientId, clientSecret: oauth.clientSecret,
          fetchFn,
        });
      } catch (e) {
        log.warn(`alpaca code exchange failed: ${(e as any)?.message ?? e}`);
        return fail("exchange_failed");
      }

      const result = await service.addOAuthAccount({
        environment: pending.env, label: pending.label,
        accessToken: token.accessToken, tokenType: token.tokenType, scope: token.scope,
      });
      log.info(`broker account added via OAuth: ${result.account.id} (alpaca/${pending.env})`);
      oauthRedirect(res, { accounts_oauth: "ok", id: result.account.id });
    } catch (e) {
      if (e instanceof AccountsError) {
        log.warn(`oauth callback rejected: ${e.code}`);
        return fail(e.code);
      }
      log.error(`oauth callback failed: ${(e as any)?.message ?? e}`);
      fail("internal");
    }
  });
}
