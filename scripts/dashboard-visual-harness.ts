#!/usr/bin/env bun
// ── dashboard-visual-harness.ts ──────────────────────────────────────────
// Local-only server for visually verifying the lightweight-charts dashboard
// (equity tab, candle modal) against REAL prod payloads, without touching
// the real DB/broker/dashboard server. Serves src/dashboard/public/v4
// statically (mirroring server.ts's `/v4` static mount + `/`/`/v4` index.html
// fallback) and answers every /api/* route the frontend calls with fixture
// JSON captured from prod (lwc-fixtures/) — endpoints without a fixture get
// an empty-but-shaped stub instead of a 404 (api.js's `soft()` wrapper
// expects JSON or silently swallows the error either way, but a shaped stub
// renders a correct empty state instead of masking a real wiring bug).
//
// Not used by the real app; not wired into package.json's `start`/`dev`.
// Usage: `bun run scripts/dashboard-visual-harness.ts` then open
// http://localhost:4173 (override with PORT=, fixtures dir with
// LWC_FIXTURES_DIR=).
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const PUBLIC_DIR = join(ROOT, "src/dashboard/public/v4");
const FIXTURES_DIR = process.env.LWC_FIXTURES_DIR || join(ROOT, "lwc-fixtures");
const PORT = Number(process.env.PORT || 4173);
// Portfolios panel (F3c/F3d) toggle: PORTFOLIOS_WRITABLE=false simulates a
// PORTFOLIOS_SOURCE=code deploy (no write deps — POST/PATCH answer 501, the
// create/edit UI stays hidden), mirroring src/dashboard/routes/portfolios.ts.
const PORTFOLIOS_WRITABLE = process.env.PORTFOLIOS_WRITABLE !== "false";

function fx(name: string) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

// symbol+timeframe -> captured /api/candles/:symbol fixture file.
const CANDLE_FIXTURES: Record<string, string> = {
  "SMH:1d": "candles-SMH-1d.json",
  "META:1h": "candles-META-1h.json",
  "LINK/USD:1h": "candles-LINKUSD-1h.json",
  "UNI/USDC:1d": "candles-UNIUSDC-1d.json",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // ── auth ────────────────────────────────────────────────────────────
    if (pathname === "/api/auth/me") return json({ username: "owner", displayName: "Owner", role: "admin", csrfToken: "harness-csrf-token" });
    if (pathname === "/api/auth/logout") return json({ ok: true });

    // ── real fixtures ───────────────────────────────────────────────────
    if (pathname === "/api/dashboard") return json(fx("dashboard.json"));
    if (pathname === "/api/trades") return json(fx("trades.json"));
    if (pathname === "/api/v2/profiles") return json(fx("profiles-7d.json"));

    if (pathname === "/api/equity/history") {
      const account = url.searchParams.get("account") || "consolidated";
      const range = url.searchParams.get("range");
      // Only consolidated 30d/all and momentum_crypto_usdc 30d were
      // captured — every window button (Today/7D/30D/All) on consolidated
      // maps to one of the two consolidated fixtures (7D/30D render the
      // 30d fixture's data; real prod would trim it server-side, the
      // harness doesn't need to for a visual check). Any other account
      // gets the USDC fixture regardless of range — good enough to render
      // a real curve, not an exact per-account replica.
      if (account === "consolidated") return json(fx(range === "all" ? "equity-consolidated-all.json" : "equity-consolidated-30d.json"));
      return json(fx("equity-usdc-30d.json"));
    }

    // ── portfolios panel (src/dashboard/routes/portfolios.ts) ──────────────
    if (pathname === "/api/platform/portfolios/meta") {
      const meta = fx("portfolios-meta.json");
      return json({ ...meta, writable: PORTFOLIOS_WRITABLE, accounts: PORTFOLIOS_WRITABLE ? meta.accounts : [] });
    }
    if (pathname === "/api/platform/portfolios" && req.method === "GET") return json(fx("portfolios-get.json"));
    if (pathname === "/api/platform/portfolios" && req.method === "POST") {
      if (!PORTFOLIOS_WRITABLE) return json({ error: "portfolio writes are not wired on this deploy" }, 501);
      const body = await req.json().catch(() => ({}) as any);
      if (body?.id === "trigger_error") return json(fx("portfolios-create-error.json"), 400);
      return json(fx("portfolios-create-success.json"), 201);
    }
    if (pathname.startsWith("/api/platform/portfolios/") && req.method === "PATCH") {
      if (!PORTFOLIOS_WRITABLE) return json({ error: "portfolio writes are not wired on this deploy" }, 501);
      const id = decodeURIComponent(pathname.slice("/api/platform/portfolios/".length));
      if (id === "trigger_error") return json(fx("portfolios-create-error.json"), 400);
      return json(fx("portfolios-patch-success.json"));
    }

    if (pathname.startsWith("/api/candles/")) {
      const symbol = decodeURIComponent(pathname.slice("/api/candles/".length));
      const tf = url.searchParams.get("tf") || "1h";
      const file = CANDLE_FIXTURES[`${symbol}:${tf}`];
      return json(file ? fx(file) : { symbol, tf, bars: [], openPositions: [], closedTrades: [] });
    }

    // ── platform identity + sessions (src/dashboard/routes/platform.ts) ─
    if (pathname === "/api/platform/me") {
      return json({
        username: "owner", displayName: "Owner", role: "admin",
        accountId: "acct_3f9c2a1b7d42", instanceId: "7b1f2d34-5a6c-4e89-9d01-23456789abcd",
        loginMethods: { password: true, github: true, google: false },
        accountsSource: "registry", portfoliosSource: "db",
        commit: "e8e672b", publicUrl: "https://bot.example.com",
      });
    }
    if (pathname === "/api/platform/sessions" && req.method === "GET") {
      return json({ sessions: [
        { handle: "a1b2c3d4e5f60718", createdAt: Date.now() - 3 * 864e5, lastActivity: Date.now() - 60_000, device: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0", ip: "203.0.113.10", current: true, rememberMe: false },
        { handle: "ffeeddccbbaa9988", createdAt: Date.now() - 12 * 864e5, lastActivity: Date.now() - 2 * 864e5, device: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", ip: "198.51.100.7", current: false, rememberMe: true },
      ] });
    }
    if (pathname.startsWith("/api/platform/sessions/") && req.method === "DELETE") return json({ ok: true });
    if (pathname === "/api/platform/sessions/revoke-others") return json({ ok: true, revoked: 1 });

    // ── broker-accounts registry (src/dashboard/routes/accounts.ts) ─────
    if (pathname === "/api/platform/accounts" && req.method === "GET") {
      return json({ configured: true, alpacaOAuth: true, accounts: [
        { id: "alpaca-paper", provider: "alpaca", label: "Alpaca paper", environment: "paper", authType: "oauth", status: "verified", accountRef: "PA3XXXX9", lastVerifiedAt: Date.now() - 3600e3, lastError: null, createdAt: Date.now() - 30 * 864e5, updatedAt: Date.now(), runtimeLinked: true },
        { id: "binance-demo", provider: "binance_usdm", label: "Binance demo", environment: "demo", authType: "api_key", status: "verified", accountRef: "548712", lastVerifiedAt: Date.now() - 7200e3, lastError: null, createdAt: Date.now() - 20 * 864e5, updatedAt: Date.now(), runtimeLinked: false },
        { id: "alpaca-live-old", provider: "alpaca", label: "Alpaca live (old)", environment: "live", authType: "api_key", status: "revoked", accountRef: "PA7YYYY1", lastVerifiedAt: Date.now() - 10 * 864e5, lastError: null, createdAt: Date.now() - 60 * 864e5, updatedAt: Date.now(), runtimeLinked: false },
        { id: "binance-live", provider: "binance_usdm", label: "Binance live", environment: "live", authType: "api_key", status: "error", accountRef: null, lastVerifiedAt: null, lastError: "HTTP 401 invalid key", createdAt: Date.now() - 2 * 864e5, updatedAt: Date.now(), runtimeLinked: false },
      ] });
    }
    if (pathname.startsWith("/api/platform/accounts/") && req.method === "POST") return json({ ok: true, account: {} });
    if (pathname.startsWith("/api/platform/accounts/") && req.method === "DELETE") return json({ ok: true });

    // ── news bar (src/dashboard/routes/news.ts) — synthetic items ───────
    if (pathname === "/api/news") {
      const lang = url.searchParams.get("lang") === "es" ? "ES" : "EN";
      const mk = (i: number, source: string, l: string) => ({
        title: `${source} headline ${i}: markets move on macro data and crypto flows`,
        link: "https://example.com/news/" + i,
        source, lang: l, pubDate: Date.now() - i * 3_600_000,
      });
      const items = [
        mk(1, "Cointelegraph", "EN"), mk(2, "CoinDesk", "EN"), mk(3, "Bloomberg", "EN"),
        mk(4, "Cointelegraph", "EN"), mk(5, "CoinDesk", "EN"),
        ...(lang === "ES" ? [mk(6, "BeInCrypto ES", "ES"), mk(7, "BeInCrypto ES", "ES")] : []),
      ];
      return json({ items, cachedAt: Date.now(), stale: false });
    }

    // ── performance tab (scorecard + P&L attribution) — synthetic ───────
    if (pathname === "/api/v2/scorecard") {
      const sleeve = (id: string, label: string, ret: number, band: string) => ({
        kind: "sleeve", id, label, benchmarkSymbol: "SPY", modelStart: "2026-09-24",
        band: { status: band, artifactDir: "x", horizonSessions: 60, cumReturnPct: { p5: -4.1, p50: 3.2, p95: 11.8 } },
        windows: [{ window: "model", totalReturnPct: ret, alphaAnnPct: ret * 2.1, sharpe: 0.8, maxDrawdownPct: 6.4, benchmark: { totalReturnPct: 2.4 } }],
      });
      return json({
        entities: [sleeve("momentum_stocks", "Momentum Stocks", 5.4, "within"), sleeve("meanrev_stocks", "MeanRev Stocks", 1.9, "above"), sleeve("momentum_crypto", "Momentum Crypto", -7.2, "below")],
        costs: { sleeves: [{ sleeve: "momentum_stocks", measured: { totalPerSideBps: 3.4, n: 120 }, assumed: { totalPerSideBps: 10 }, breakEven: { marginBps: 42 }, verdict: "ok" }] },
      });
    }
    if (pathname === "/api/analytics/pnl-attribution") {
      return json({
        buckets: [
          { bucket: "algo", trades: 212, winRate: 0.52, totalPnl: 4120.5, profitFactor: 1.4 },
          { bucket: "reconcile", trades: 8, winRate: 0.5, totalPnl: -36.2, profitFactor: 0.9 },
          { bucket: "sync", trades: 14, winRate: 0.43, totalPnl: -210.8, profitFactor: 0.6 },
        ],
        netPnl: 3873.5, windowDays: 365,
      });
    }
    if (pathname === "/api/analytics/symbols") {
      return json(["SMH", "META", "NVDA", "LINK/USD", "UNI/USDC"].map((symbol, i) => ({ symbol, tradeCount: 30 - i * 4, winRate: 0.55 - i * 0.03, totalPnl: 900 - i * 350 })));
    }
    if (pathname === "/api/analytics/hourly") {
      return json(Array.from({ length: 24 }, (_, hour) => ({ hour, avgPnl: Math.sin(hour / 3) * 14, tradeCount: 4 + (hour % 5) })));
    }

    // ── empty-but-shaped stubs for everything else the frontend calls ───
    if (pathname === "/api/orderbook") return json({ bids: [], asks: [] });
    if (pathname === "/api/tape") return json([]);
    if (pathname === "/api/connections") return json({});
    if (pathname === "/api/activity") return json([]);
    if (pathname === "/api/symbols") return json({});
    if (pathname.startsWith("/api/analytics/") || pathname.startsWith("/api/v2/") || pathname.startsWith("/api/config/")) {
      return json([]);
    }
    if (pathname.startsWith("/api/")) return json(null, 200);

    // ── static files (mirrors server.ts: /v4/** static, "/" and "/v4" -> index.html) ──
    let filePath = pathname;
    if (filePath === "/" || filePath === "/v4") filePath = "/index.html";
    else if (filePath.startsWith("/v4/")) filePath = filePath.slice("/v4".length);
    const full = join(PUBLIC_DIR, filePath);
    if (!full.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
    if (existsSync(full) && !full.endsWith("/")) return new Response(Bun.file(full));
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Visual harness on http://localhost:${server.port} (fixtures: ${FIXTURES_DIR})`);
