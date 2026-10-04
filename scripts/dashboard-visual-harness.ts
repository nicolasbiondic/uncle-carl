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
    if (pathname === "/api/auth/me") return json({ username: "owner", csrfToken: "harness-csrf-token" });
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
