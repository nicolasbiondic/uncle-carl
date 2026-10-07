// Test preload (bunfig.toml [test].preload) — runs before every test file.
//
// The suite's fixtures assume the DEFAULT trading mode (opens allowed):
// hundreds of engine/adapter tests open fake positions. src/config/index.ts
// runs dotenv, so a host whose .env sets TRADING_ENABLED=false (the intended
// state for the no-trade dev clone) would otherwise flip every one of those
// tests red. Tests that exercise the no-trade gate set the variable
// explicitly (and restore it in finally) — everything else must see the
// default regardless of which host runs the suite.
// Order matters: src/config runs dotenv.config({ override: true }), which
// CLOBBERS anything this preload sets — deleting or blanking the var first
// loses (the host's .env repopulates it; =false on the retired dev clone
// flipped 30 engine tests red on 2026-07-31). So import config FIRST (its
// dotenv runs exactly once, module-cached) and delete AFTER: isTradingEnabled()
// is a per-call process.env read, so the deletion sticks for every test.
// Gate tests still set the variable explicitly and restore it.
// The Alpaca SDK ALSO runs its own vendored dotenv at import (non-override:
// it repopulates DELETED vars from .env). Without importing it here, the
// first test file that lazily pulled the SDK (src/account/coinmUsdcSleeves →
// AccountManager → alpaca-executor) resurrected TRADING_ENABLED=false
// mid-suite and poisoned every file after it. Import every import-time
// dotenv caller FIRST (module cache makes each run exactly once), then strip.
import { config } from "./config";
import "@alpacahq/alpaca-trade-api";
delete process.env.TRADING_ENABLED;

// Same class for the Binance REST transport (2026-10-02): prod's .env selects
// BINANCE_TRANSPORT=sdk and the executor reads config.binanceFutures.transport
// at construction, so the deploy gate (bun test ON prod) built SDK-transport
// executors under the tests that fake fetch for the code default — 11 red,
// two deploys blocked. Every unit test sees the code default ("legacy"); the
// contract battery (usdmTransport.contract.test.ts) builds BOTH transports
// explicitly, so the SDK path stays covered whatever the host's .env says.
(config.binanceFutures as { transport: string }).transport = "legacy"; // config is declared readonly; tests only
delete process.env.BINANCE_TRANSPORT;

// Same class for the platform's instance config (2026-10-04):
// src/platform/instance.ts lets these env vars beat instance.json AND the
// config.dashboard.port test seam, so a host .env with DASHBOARD_PORT (this
// dev checkout: 3799; prod: 3789) bound the real port in the "port already in
// use" test, and a future UC_MASTER_KEY/PUBLIC_URL on prod would flip the
// "no key"/"no public URL" tests — the deploy gate runs bun test with prod's
// .env. Tests that need one set it themselves and restore it.
for (const k of [
  "DASHBOARD_PORT", "DASHBOARD_HOST", "PUBLIC_URL", "UC_DATA_DIR", "UC_MASTER_KEY",
  "OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET", "OAUTH_GITHUB_ALLOWED_ID", "OAUTH_GITHUB_ALLOWED_LOGIN",
  "OAUTH_GOOGLE_CLIENT_ID", "OAUTH_GOOGLE_CLIENT_SECRET", "OAUTH_GOOGLE_ALLOWED_EMAIL",
  "ALPACA_OAUTH_CLIENT_ID", "ALPACA_OAUTH_CLIENT_SECRET",
  "PORTFOLIOS_SOURCE", // prod may flip it to "db"; tests pass the source explicitly
  "ACCOUNTS_SOURCE", "RUNTIME_ACCOUNT_ALPACA", "RUNTIME_ACCOUNT_BINANCE", // prod binds its accounts through these
  "DISPLAY_HISTORY_START", // prod hides the pre-v8 era from "All"; tests pass it explicitly
]) delete process.env[k];
