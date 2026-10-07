// ══════════════════════════════════════════════
// Dashboard Server (Express + WebSocket)  v6.0
// Refactored into route modules — see src/dashboard/routes/
// ══════════════════════════════════════════════

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import path from "path";
import zlib from "zlib";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { eventBus, EVENTS } from "../utils/events";
import { registerMetricsEndpoint } from "../metrics/PrometheusExporter";
import { AccountManager } from "../account/AccountManager";

import { getSession, getSessionBySid } from "./auth-store";
import { instanceAllowedOrigins, reloadInstanceConfig, loadInstanceConfig, publicBaseUrl } from "../platform/instance";
import { getSecretBox } from "../platform/secretBox";
import { apiLimiter, mutationLimiter } from "./middleware/rateLimiter";
import { registerAuthRoutes } from "./routes/auth";
import { registerOAuthRoutes } from "./routes/oauth";
import { registerSetupRoutes, announceSetupTokenIfNeeded, needsFirstRunSetup } from "./routes/setup";
import { registerDataRoutes } from "./routes/data";
import { registerStrategyRoutes } from "./routes/strategies";
import { registerProfileRoutes } from "./routes/profiles";
import { registerAnalyticsRoutes } from "./routes/analytics";
import { registerAdminRoutes } from "./routes/admin";
import { registerHealthRoutes } from "./routes/health";
import { registerCandlesRoutes } from "./routes/candles";
import { registerNewsRoutes } from "./routes/news";
import { registerPlatformRoutes } from "./routes/platform";
import { registerPlatformAccountsRoutes, PLATFORM_ACCOUNTS_PUBLIC_PATHS } from "./routes/accounts";
import { registerPlatformPortfoliosRoutes } from "./routes/portfolios";
import { loadPlatformPortfolioRows, resolvePortfoliosSource, insertPlatformPortfolio, updatePlatformPortfolio } from "../portfolios/store";
import { liveBandReadings } from "../portfolio/scorecard";
import { getLastConstructedSleeveGovernor } from "../governor/SleeveGovernor";
import { getDB } from "../db/database";

const log = createLogger("Dashboard");

export class DashboardServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private am: AccountManager;

  constructor(am: AccountManager) {
    this.am = am;
    this.app = express();
    this.server = http.createServer(this.app);
    // Iter 8 fix (2026-05-04): WebSocket upgrade requests previously bypassed
    // the auth wall entirely. Anyone with TCP reachability could subscribe to
    // every order/trade/portfolio event, plus mutate dashboard view via
    // `switch_view`. We now (a) validate the Origin header against the same
    // host the dashboard is bound to, and (b) require a valid session cookie.
    this.wss = new WebSocketServer({
      server: this.server,
      verifyClient: (info, cb) => this.verifyWsClient(info, cb),
    });
    this.setupRoutes();
    this.setupWebSocket();
    this.setupEventForwarding();
    // Platform phase: a brand-new installation (no env users, no
    // instance.json owner) prints a one-time claim token and serves /setup.
    announceSetupTokenIfNeeded();
  }

  /**
   * Iter 8 fix (2026-05-04): authenticate WebSocket upgrade requests.
   * - Origin must match DASHBOARD_ALLOWED_ORIGINS (CSV) or the request's Host
   *   header. Defaults: localhost + 127.0.0.1 + the Host header itself.
   * - sid cookie must resolve to an active session.
   */
  private verifyWsClient(info: { origin: string; req: any }, cb: (ok: boolean, code?: number, message?: string) => void) {
    try {
      const host = (info.req.headers.host || "").toString();
      const origin = (info.origin || "").toString();

      // Origin check (CSWSH defence). Empty origin = same-origin or non-browser
      // client; we only accept it when there's also a valid session cookie.
      // instanceAllowedOrigins() = origin of PUBLIC_URL (when set) +
      // DASHBOARD_ALLOWED_ORIGINS (CSV) — src/platform/instance.ts. With
      // neither configured it's empty and this is exactly the old check.
      const envAllow = instanceAllowedOrigins();
      const defaults = [
        `http://${host}`, `https://${host}`,
        `http://localhost:${config.dashboard.port}`,
        `http://127.0.0.1:${config.dashboard.port}`,
      ];
      const allowed = new Set([...envAllow, ...defaults]);
      if (origin && !allowed.has(origin)) {
        log.warn(`WS rejected: bad Origin "${origin}" (host=${host})`);
        return cb(false, 403, "forbidden origin");
      }

      // Session cookie check. Manual cookie parse — we're before Express here.
      const cookieHdr = (info.req.headers.cookie || "").toString();
      const cookies: Record<string, string> = {};
      cookieHdr.split(";").forEach((p: string) => {
        const [k, v] = p.trim().split("=");
        if (k && v) cookies[k] = v;
      });
      const sid = cookies.sid;
      const session = getSessionBySid(sid);
      if (!session) {
        return cb(false, 401, "unauthorized");
      }

      // Stash session on the request so the connection handler can use it.
      info.req.session = session;
      return cb(true);
    } catch (e: any) {
      log.warn(`WS verify error: ${e?.message ?? e}`);
      return cb(false, 500, "verify error");
    }
  }

  private setupRoutes() {
    // ── Cookie parser (no extra dependency) ──────────────────────────────
    this.app.use((req: any, _res, next) => {
      req.cookies = {};
      const c = req.headers.cookie;
      if (c) c.split(";").forEach((p: string) => {
        const [k, v] = p.trim().split("=");
        if (k && v) req.cookies[k] = v;
      });
      next();
    });

    this.app.use(express.json({ limit: "1mb" }));

    // ── Security headers ──────────────────────────────────────────────────
    this.app.use((_req: any, res: any, next: any) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Content-Security-Policy", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: https:",
        // News feeds are proxied by GET /api/news (routes/news.ts) — the old
        // direct api.rss2json.com client dependency is gone from the CSP.
        "connect-src 'self' ws: wss: https://api.binance.com https://api.alternative.me",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "));
      next();
    });

    // ── Gzip compression for large JSON responses ─────────────────────────
    this.app.use((req: any, res: any, next: any) => {
      const ae = req.headers["accept-encoding"] || "";
      if (!ae.includes("gzip")) return next();
      const origJson = res.json.bind(res);
      res.json = (body: any) => {
        const raw = JSON.stringify(body);
        if (raw.length < 1024) return origJson(body);
        zlib.gzip(Buffer.from(raw), (err, buf) => {
          if (err) return origJson(body);
          res.set("Content-Encoding", "gzip");
          res.set("Content-Type", "application/json");
          res.end(buf);
        });
      };
      next();
    });

    // ── Per-endpoint rate limiting ────────────────────────────────────────
    // General API reads: 300 req/min per IP
    this.app.use("/api", apiLimiter);
    // State-changing calls: 60 req/min per IP (applied to all methods except GET/HEAD)
    this.app.use("/api", (req: any, res: any, next: any) => {
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
      return mutationLimiter(req, res, next);
    });

    // ── Auth routes (public — before auth wall) ───────────────────────────
    registerAuthRoutes(this.app, this.am);
    registerOAuthRoutes(this.app);   // /auth/oauth/:provider/* — 404 unless configured
    registerSetupRoutes(this.app);   // /setup + /api/setup — only while no user exists

    // ── Auth wall — everything below requires a valid session ─────────────
    // Audit fix (2026-05-04): /metrics now requires either a valid session
    // OR a matching METRICS_TOKEN env (for Prometheus scrapers). /healthz is
    // still public but only returns minimal liveness data — full diagnostics
    // moved to /healthz/full behind the auth wall.
    this.app.use((req: any, res: any, next: any) => {
      if (req.path === "/login" || req.path.startsWith("/api/auth/")) return next();
      if (req.path === "/healthz")                                    return next();
      // Platform phase: OAuth handshake + first-run setup are pre-session
      // by nature. /setup and /api/setup additionally self-disable (404/410)
      // once any user exists — see routes/setup.ts.
      if (req.path.startsWith("/auth/oauth/"))                        return next();
      if (req.path === "/setup" || req.path === "/api/setup")         return next();
      // Alpaca OAuth callback: arrives cross-site WITHOUT the strict sid
      // cookie and only renders a same-site bounce (routes/accounts.ts).
      if (req.method === "GET" && PLATFORM_ACCOUNTS_PUBLIC_PATHS.includes(req.path)) return next();

      if (req.path === "/metrics") {
        const expected = process.env.METRICS_TOKEN;
        if (expected && expected.length > 0) {
          const provided = (req.headers["x-metrics-token"] as string | undefined)
            ?? (typeof req.query?.token === "string" ? req.query.token : undefined);
          if (provided === expected) return next();
        }
        // Fall through to session check (auth'd users can still hit /metrics).
      }

      const session = getSession(req);
      if (!session) {
        // Iter 6 fix (2026-05-04): /healthz/full is JSON-shaped — return 401
        // JSON instead of a 302 redirect so curl / Prometheus / the
        // /healthz/full handler's own 401 path are reachable.
        if (req.path.startsWith("/api/") || req.path === "/metrics" || req.path === "/healthz/full") {
          return res.status(401).json({ error: "Authentication required" });
        }
        // Fresh installation: the browser lands on the setup page, not a
        // login it can never pass (there are no credentials yet).
        return res.redirect(needsFirstRunSetup() ? "/setup" : "/login");
      }
      req.session = session;
      next();
    });

    // ── CSRF protection for state-changing API calls ──────────────────────
    this.app.use((req: any, res: any, next: any) => {
      // P3-5 fix: Express routing is case-insensitive by default, but this
      // gate's `startsWith` was case-sensitive — a POST to e.g. "/API/..."
      // would skip the CSRF check entirely (damage limited by SameSite=strict,
      // but it's still a gap the router doesn't share).
      if (!req.path.toLowerCase().startsWith("/api/")) return next();
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
      if (req.path === "/api/auth/login") return next();
      // First-run setup predates any session (no CSRF token exists yet);
      // it is instead guarded by the one-time log token + self-disabling.
      if (req.path === "/api/setup") return next();

      const session = req.session ?? getSession(req);
      if (!session) return res.status(401).json({ error: "Authentication required" });

      const token = req.headers["x-csrf-token"];
      if (typeof token !== "string" || token !== session.csrfToken) {
        return res.status(403).json({ error: "Invalid CSRF token" });
      }
      next();
    });

    // ── Static files ──────────────────────────────────────────────────────
    // Only public/v4 is served (legacy v1/v2/v3 dashboards deleted), mounted
    // under /v4 to match the asset paths in v4/index.html. index:false —
    // otherwise static serves index.html at "/v4" directly and bypasses the
    // auth wall ordering the explicit route below relies on.
    this.app.use("/v4", (req, res, next) => {
      if (req.path.endsWith(".test.js")) return res.sendStatus(404);
      next();
    });
    // no-cache ≠ no-store: the browser may keep a copy but must revalidate
    // (ETag → cheap 304). Without it, Express sends no Cache-Control at all
    // and browsers apply HEURISTIC caching — after a deploy, users kept
    // getting day-old css/js until the heuristic expired (seen live when the
    // 2026-07-30 header-padding fix didn't show up on a plain reload).
    this.app.use("/v4", express.static(path.join(__dirname, "public", "v4"), {
      index: false,
      setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
    }));

    // ── Prometheus metrics ────────────────────────────────────────────────
    registerMetricsEndpoint(this.app, this.am);

    // ── Route modules ─────────────────────────────────────────────────────
    registerDataRoutes(this.app, this.am);
    registerStrategyRoutes(this.app, this.am);
    registerProfileRoutes(this.app, this.am);
    registerAnalyticsRoutes(this.app, this.am);
    registerAdminRoutes(this.app, this.am);
    registerHealthRoutes(this.app, this.am);
    registerCandlesRoutes(this.app, this.am);
    // Server-side news aggregation (10-min cache, 8s per-feed timeout) — the
    // v4 news bar reads /api/news instead of hitting rss2json client-side.
    registerNewsRoutes(this.app);
    // Platform identity + sessions (Ajustes page): /api/platform/me,
    // /api/platform/sessions[…]. Behind the wall; CSRF covers the mutations.
    registerPlatformRoutes(this.app);
    // Broker-account registry (platform F2): the secret box needs the
    // installation's master key — without it the Accounts view says "run
    // bun run setup". Not read by the trading engines yet.
    registerPlatformAccountsRoutes(this.app, {
      box: getSecretBox,
      publicBaseUrl,
      alpacaOAuth: () => loadInstanceConfig().brokerOAuth.alpaca,
    });
    // Portfolio registry (platform F3). Create/edit exist only where they take
    // effect — PORTFOLIOS_SOURCE=db (applied on the next boot). Under code they
    // answer 501: a row created there would sit dormant and activate silently
    // on a later flip.
    const portfoliosSource = resolvePortfoliosSource(process.env.PORTFOLIOS_SOURCE);
    registerPlatformPortfoliosRoutes(this.app, {
      source: portfoliosSource,
      listPortfolios: () => loadPlatformPortfolioRows(getDB()),
      bandReadings: () => liveBandReadings(getDB()),
      effectiveMode: (id) => getLastConstructedSleeveGovernor()?.getMode(id) ?? null,
      ...(portfoliosSource === "db" ? {
        write: {
          accounts: () => this.am.runtimeAccounts(),
          accountEquity: (account: string) => this.am.brokerAccountEquity(account),
          insertPortfolio: (row) => insertPlatformPortfolio(getDB(), row),
          updatePortfolio: (row) => updatePlatformPortfolio(getDB(), row),
        },
      } : {}),
    });

    // ── Root — serve dashboard SPA ────────────────────────────────────────
    // v4 is the only dashboard (legacy v1/v2/v3 archives deleted). Auth-walled
    // (this runs after the auth wall). Static assets under public/v4/** are
    // served by express.static above.
    this.app.get(["/", "/v4"], (_req, res) => res.sendFile(path.join(__dirname, "public", "v4", "index.html")));
  }

  private setupWebSocket() {
    // Audit fix wave 5 (2026-05-04): handle WebSocketServer errors so a
    // protocol-level glitch can't bubble up to the process.
    this.wss.on("error", (e: any) => log.warn(`WSS error: ${e?.message ?? e}`));

    this.wss.on("connection", (ws, req: any) => {
      // verifyClient already authenticated this connection and stashed the
      // session on `req.session`. We keep a per-connection reference so
      // future per-user gating (e.g. role-based broadcast filters) can read it.
      const session = req?.session ?? null;
      (ws as any)._session = session;

      // Audit fix wave 5 (2026-05-04): without an `error` listener on the
      // per-connection ws, any error event (malformed frame, oversized
      // message, RSV1 violation, etc.) becomes an uncaught EventEmitter
      // throw and crashes the bot. A single packet from a misbehaving
      // client could DoS the trading process.
      ws.on("error", (e: any) => log.warn(`WS client error: ${e?.message ?? e}`));

      this.clients.add(ws);
      const userLabel = session ? `${session.username}/${session.role}` : "anon";
      log.info(`Dashboard WS connected (${this.clients.size} total, user=${userLabel})`);

      ws.send(JSON.stringify({ type: "init", data: this.am.getDashboardData() }));
      ws.on("close", () => this.clients.delete(ws));
      ws.on("message", (msg) => {
        try {
          const d = JSON.parse(msg.toString());
          if (d.type === "ping") return ws.send('{"type":"pong"}');
          if (d.type === "switch_view") {
            // Iter 8 fix (2026-05-04): require an admin session for view
            // mutations. Previously any unauthenticated client could flip
            // the dashboard view for everyone.
            // Wave 5 fix: re-validate the session against the live store —
            // long-lived ws connections shouldn't outlive logout/expiry.
            // Audit fix: store view preference on the WS connection's session
            // instead of calling am.setView() (which was global — one admin
            // changing view would affect all connected sessions simultaneously).
            const s = (ws as any)._session;
            const sid = s?.id;
            const fresh = sid ? getSessionBySid(sid) : null;
            if (!fresh || fresh.role !== "admin") {
              ws.send('{"type":"error","data":{"error":"forbidden"}}');
              return;
            }
            // Persist the view choice on the session so HTTP routes (like
            // /api/dashboard) see the same selection for this user.
            fresh.settings = fresh.settings ?? {};
            fresh.settings.viewId = d.id;
            ws.send(JSON.stringify({ type: "init", data: this.am.getDashboardData(d.id) }));
          }
        } catch {}
      });
    });
  }

  private setupEventForwarding() {
    const fwd = (type: string, ev: string) =>
      eventBus.on(ev, (data: any) => this.broadcast({ type, data }));
    fwd("order",              EVENTS.ORDER_FILLED);
    fwd("trade_closed",       EVENTS.POSITION_CLOSED);
    fwd("position_update",    EVENTS.POSITION_UPDATE);
  }

  private broadcast(message: any) {
    const msg = JSON.stringify(message);
    for (const c of this.clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      // P3-4 fix: verifyClient only authenticates at upgrade time; only
      // `switch_view` re-validated afterward. A client whose session logged
      // out or expired kept receiving every broadcast forever. Re-resolve the
      // stashed session's sid against the live store (same helper the
      // upgrade handler and switch_view use) before sending — one in-memory
      // Map lookup per client per broadcast.
      const sid = (c as any)._session?.id;
      if (!getSessionBySid(sid)) {
        try { (c as any).terminate?.(); } catch {}
        this.clients.delete(c);
        continue;
      }
      // Backpressure guard: the feed is high-rate (≈4 portfolio + N price frames
      // per 15s scan). A slow / backgrounded / dead client whose send queue backs
      // up would otherwise grow native memory without bound (the RSS leak). Skip
      // it while it's behind; terminate it if it's hopelessly stuck.
      const buffered = (c as any).bufferedAmount ?? 0;
      if (buffered > 5_000_000) { try { (c as any).terminate?.(); } catch {} continue; }
      if (buffered > 1_000_000) continue; // behind → drop this frame; it resyncs on the next full payload
      c.send(msg);
    }
  }

  async start() {
    // P0 fix: listen()'s success callback never fires on EADDRINUSE (or any
    // other bind error), and without an 'error' listener on the server the
    // event is silently dropped — this Promise hung FOREVER, leaving
    // everything already initialized in main() (DB, broker connections,
    // BrokerSync's 30s writer loop) running with no SL loop, no heartbeats,
    // and no shutdown handler. A bind failure means another instance already
    // holds the port: reject so the caller aborts startup instead of idling.
    // Platform phase: bind host/port come from the instance config
    // (env > instance.json > defaults — src/platform/instance.ts), re-read
    // here so a setup that ran after process start is honored. With the
    // default host ("0.0.0.0") we keep the EXACT pre-platform listen(port)
    // call: a bare listen binds the IPv6 any-address (dual-stack) where
    // "0.0.0.0" would be IPv4-only — byte-identical behavior for existing
    // installations, including prod.
    const { host, port, publicUrl } = reloadInstanceConfig().dashboard;
    return new Promise<void>((resolve, reject) => {
      const onError = (err: any) => {
        this.server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.removeListener("error", onError);
        const shown = publicUrl ?? `http://localhost:${port}`;
        log.info(`🌐 Dashboard running at ${shown}${host === "0.0.0.0" ? "" : ` (bound to ${host}:${port})`}`);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      if (host === "0.0.0.0") this.server.listen(port);
      else this.server.listen(port, host);
    });
  }

  async stop() {
    this.wss.close();
    this.server.close();
  }
}
