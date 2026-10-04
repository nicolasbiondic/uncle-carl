import dotenv from "dotenv";
import fs from "fs";
dotenv.config({ override: true });

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env var: ${key}`);
  return val;
}

export const config = {
  mode: env("TRADING_MODE", "paper") as "paper" | "live",

  alpaca: {
    keyId: env("ALPACA_API_KEY", ""),
    secretKey: env("ALPACA_SECRET_KEY", ""),
    paper: env("ALPACA_PAPER", "true") === "true",
    baseUrl: env("ALPACA_BASE_URL", "https://paper-api.alpaca.markets"),
    dataUrl: env("ALPACA_DATA_URL", "https://data.alpaca.markets"),
  },

  // config.binance — legacy spot-market config. No execution uses these keys;
  // they exist only as a fallback for operators who set BINANCE_API_KEY instead
  // of BINANCE_FUTURES_API_KEY. All execution and broker logic reads
  // config.binanceFutures first, falling back to these only if unset.
  binance: {
    apiKey: env("BINANCE_API_KEY", ""),
    apiSecret: env("BINANCE_SECRET_KEY", ""),
  },

  binanceFutures: {
    apiKey: env("BINANCE_FUTURES_API_KEY", ""),
    apiSecret: env("BINANCE_FUTURES_SECRET_KEY", ""),
    // Default host is Binance's futures DEMO environment (2026-10-02):
    // demo-fapi.binance.com and testnet.binancefuture.com are the SAME
    // backend (same book, same account with the same keys — verified by the
    // director against the live account), but Binance is migrating the
    // sandbox to demo-fapi (CCXT already refuses the old host). The SDK's
    // own constant agrees: DERIVATIVES_TRADING_USDS_FUTURES_REST_API_DEMO_URL.
    restBase: env("BINANCE_FUTURES_REST_BASE", "https://demo-fapi.binance.com"),
    // REST transport for the USDⓈ-M executor (src/executor/binance/
    // usdmTransport.ts): "legacy" = the hand-rolled signed-fetch layer,
    // "sdk" = the official @binance/derivatives-trading-usds-futures client.
    // Default stays "legacy" until the director verifies "sdk" in prod with
    // scripts/verify-binance-transport.ts. Any other value fails closed at
    // executor construction (createBinanceUsdmTransport throws).
    transport: env("BINANCE_TRANSPORT", "legacy"),
  },

  telegram: {
    botToken: env("TELEGRAM_BOT_TOKEN", ""),
    /** END-USER chat. Only things that concern the money: fills, closes,
     *  trading paused/resumed, the daily digest, command replies. */
    chatId: env("TELEGRAM_CHAT_ID", ""),
    /** OPTIONAL operator chat. Engineering noise (error bursts, unexpected
     *  restarts, watchdog and deploy events) goes HERE and never to the
     *  user chat. Unset (the default) = those alerts are logged only —
     *  a deliberate tradeoff: the user asked for a clean chat, so silence
     *  is preferred over leaking dev noise into it. */
    opsChatId: env("TELEGRAM_OPS_CHAT_ID", ""),
  },

  dashboard: {
    port: parseInt(env("DASHBOARD_PORT", "3789")),
  },

  // EXECUTION_WS=true subscribes to broker order-update WebSocket streams
  // (Alpaca trade_updates, Binance Futures userDataStream). REST polling
  // fallback stays active either way — WS just delivers fills faster.
  execution: {
    useWs: env("EXECUTION_WS", "false") === "true",
  },
} as const;

// ── Minimum required credentials (enforced at BOT startup) ─────────────────
//
// This is the enforcement AGENTS.md cites ("Minimum required keys enforced at
// startup by src/config/index.ts"). It is deliberately a FUNCTION invoked from
// src/index.ts main(), never a side effect of importing this module: 1900+
// tests and every research script import `config` and must keep working
// without a populated .env. The bot itself, however, must refuse to start as
// a broker-less zombie — with a missing key it could neither open NOR manage
// anything on that broker anyway, so aborting before any loop starts never
// violates the "closes keep running" invariant.
//
// Values that are empty, whitespace, or the .env.example "your_*" placeholders
// count as missing. This is a STATIC presence check — a present-but-wrong key
// still fails at broker connect (loud DEGRADED banner + ops page in index.ts).

export function credentialPresent(v: string | undefined): boolean {
  const t = (v ?? "").trim();
  return t !== "" && !/^your_/i.test(t);
}

// ── Accounts source (F4a, docs/platform/PLAN.md) ───────────────────────────
//
// Where the RUNTIME broker credentials come from:
//  - "env" (default): the .env keys above, byte-identical to today;
//  - "registry": the platform_broker_accounts registry (sealed credentials
//    opened with the instance master key — src/platform/accounts/runtime.ts).
// The canonical type lives HERE (not in src/platform) because this module
// must stay import-cycle-free: platform/instance.ts imports `config`.

export type AccountsSource = "env" | "registry";

/**
 * Which required credential env vars are missing/placeholder?
 * - Alpaca keys: always required (momentum_stocks/meanrev always on, and
 *   Alpaca is the market-data source for the crypto sleeves too).
 * - Binance FAPI keys: always required (momentum_crypto is always wired);
 *   the legacy BINANCE_API_KEY/BINANCE_SECRET_KEY pair remains an accepted
 *   per-field fallback, exactly mirroring BinanceExecutor's constructor.
 * - COIN-M keys: only when MOMENTUM_COINM_ENABLED=true, and the FAPI keys
 *   satisfy them (DEFAULT_COINM_CONFIG falls back to those).
 * - MOMENTUM_USDC_ENABLED needs no extra keys (same FAPI pair).
 * Takes the env as a parameter so tests never depend on the real .env.
 *
 * accountsSource="registry" (F4a): the Alpaca + Binance FAPI runtime
 * credentials come from the broker-accounts registry, so the .env pairs are
 * NOT required. COIN-M stays env-configured (the registry has no COIN-M
 * provider yet) — its keys are still demanded when the sleeve is enabled.
 */
export function missingRequiredKeys(
  env: Record<string, string | undefined> = process.env,
  accountsSource: AccountsSource = "env",
): string[] {
  const missing: string[] = [];
  if (accountsSource !== "registry") {
    if (!credentialPresent(env.ALPACA_API_KEY)) missing.push("ALPACA_API_KEY");
    if (!credentialPresent(env.ALPACA_SECRET_KEY)) missing.push("ALPACA_SECRET_KEY");
    if (!credentialPresent(env.BINANCE_FUTURES_API_KEY) && !credentialPresent(env.BINANCE_API_KEY)) {
      missing.push("BINANCE_FUTURES_API_KEY");
    }
    if (!credentialPresent(env.BINANCE_FUTURES_SECRET_KEY) && !credentialPresent(env.BINANCE_SECRET_KEY)) {
      missing.push("BINANCE_FUTURES_SECRET_KEY");
    }
  }
  if (env.MOMENTUM_COINM_ENABLED === "true") {
    if (!credentialPresent(env.BINANCE_COINM_API_KEY) && !credentialPresent(env.BINANCE_FUTURES_API_KEY)) {
      missing.push("BINANCE_COINM_API_KEY (or BINANCE_FUTURES_API_KEY)");
    }
    if (!credentialPresent(env.BINANCE_COINM_SECRET_KEY) && !credentialPresent(env.BINANCE_FUTURES_SECRET_KEY)) {
      missing.push("BINANCE_COINM_SECRET_KEY (or BINANCE_FUTURES_SECRET_KEY)");
    }
  }
  return missing;
}

// ── LIVE-arming ceremony (2026-09-20 audit, "B1") ───────────────────────────
//
// Flipping ALPACA_PAPER=false (or pointing ALPACA_BASE_URL at a non-paper
// host) used to be a 2-variable .env edit with zero ceremony — a mis-pasted
// .env put real money at whatever leverage the sleeve profiles happen to
// carry. When the target is NOT a known paper endpoint, assertRequiredConfig
// now additionally demands: (a) TRADING_MODE=live set EXPLICITLY (no
// accidental default), (b) a hand-created marker file (LIVE_ARM_MARKER_PATH)
// whose content is EXACTLY the operator-set LIVE_ACCOUNT_ID — a deliberate
// physical act, not a config toggle — and (c) a non-empty
// TELEGRAM_OPS_CHAT_ID, so real money never trades without a human able to
// be paged. With ALPACA_PAPER=true (today's only real target) none of this
// runs — byte-identical behavior, no filesystem access at all.
//
// TODO(wire in executor/index.ts, outside this module's ownership): once
// connected to the broker, verify the ACTUAL account.id returned by Alpaca
// matches LIVE_ACCOUNT_ID and refuse to trade (or HALT via RiskEngine) on a
// mismatch — this function only gates process startup, it never talks to
// the broker.

/** Path to the live-arm marker file. Its content must equal LIVE_ACCOUNT_ID
 *  exactly — a hand-created file, not something the bot writes for itself. */
export const LIVE_ARM_MARKER_PATH = "data/.live-armed";

/**
 * Minimal REPLICA of isKnownAlpacaPaperHost (src/executor/alpaca-executor.ts)
 * — duplicated here, not imported, because alpaca-executor.ts imports
 * `config` from THIS module and importing back would cycle. Keep both
 * allowlists in sync by hand if either changes.
 */
function isKnownAlpacaPaperHostLocal(url: string): boolean {
  return (url || "").toLowerCase().includes("paper-api.alpaca.markets");
}

/** Is the configured Alpaca target NOT a known paper endpoint (i.e. does it
 *  require the live-arming ceremony below)? */
function isAlpacaLiveTarget(env: Record<string, string | undefined>): boolean {
  const paperFlag = (env.ALPACA_PAPER ?? "true") === "true";
  const baseUrl = env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
  return !paperFlag || !isKnownAlpacaPaperHostLocal(baseUrl);
}

/** Default marker reader: real filesystem read of LIVE_ARM_MARKER_PATH,
 *  trimmed; null when missing/unreadable. Injectable so tests never touch
 *  the real filesystem. */
function defaultReadLiveArmMarker(): string | null {
  try {
    return fs.readFileSync(LIVE_ARM_MARKER_PATH, "utf8").trim();
  } catch {
    return null;
  }
}

/** Hard startup gate — throws (listing every missing var / unmet live-arm
 *  requirement) so main()'s fatal handler exits non-zero instead of booting
 *  a bot with zero brokers, or worse, a live bot with none of the ceremony
 *  real money demands. `readLiveArmMarker` is injectable for tests. */
export function assertRequiredConfig(
  env: Record<string, string | undefined> = process.env,
  readLiveArmMarker: () => string | null = defaultReadLiveArmMarker,
  accountsSource: AccountsSource = "env",
): void {
  const missing = missingRequiredKeys(env, accountsSource);
  if (missing.length > 0) {
    throw new Error(
      `STARTUP REFUSED — missing or placeholder credentials: ${missing.join(", ")}. ` +
      `Fill them in .env (see .env.example). Refusing to start a broker-less bot.`,
    );
  }

  // Registry mode: the env ALPACA_PAPER/ALPACA_BASE_URL pair is NOT what the
  // executors will sign against (the registry account's environment decides),
  // so the env-based live-target ceremony below does not apply. The SAME
  // ceremony — TRADING_MODE=live, LIVE_ACCOUNT_ID matching the account
  // number, the hand-made marker file, an ops chat — is enforced per registry
  // account in src/platform/accounts/runtime.ts before a live Alpaca account
  // is ever linked (fail-closed: unmet ceremony = venue not linked).
  if (accountsSource !== "registry" && isAlpacaLiveTarget(env)) {
    const problems: string[] = [];
    if (env.TRADING_MODE !== "live") {
      problems.push(`TRADING_MODE must be explicitly "live" (got "${env.TRADING_MODE ?? "unset"}")`);
    }
    const liveAccountId = (env.LIVE_ACCOUNT_ID ?? "").trim();
    if (!liveAccountId) {
      problems.push("LIVE_ACCOUNT_ID must be set to the expected broker account id");
    } else {
      const marker = readLiveArmMarker();
      if (marker === null) {
        problems.push(
          `live-arm marker file ${LIVE_ARM_MARKER_PATH} is missing — create it by hand containing exactly LIVE_ACCOUNT_ID's value to deliberately arm live trading`,
        );
      } else if (marker !== liveAccountId) {
        problems.push(
          `live-arm marker file ${LIVE_ARM_MARKER_PATH} content ("${marker}") does not match LIVE_ACCOUNT_ID ("${liveAccountId}")`,
        );
      }
    }
    if (!credentialPresent(env.TELEGRAM_OPS_CHAT_ID)) {
      problems.push("TELEGRAM_OPS_CHAT_ID must be set — live trading never starts without a human paging chat");
    }
    if (problems.length > 0) {
      throw new Error(
        `STARTUP REFUSED — LIVE trading ceremony incomplete (ALPACA_PAPER=false or a non-paper ALPACA_BASE_URL): ${problems.join("; ")}.`,
      );
    }
  }
}

/**
 * Maintenance kill-switch: a host set to TRADING_ENABLED=false runs
 * everything — dashboard, broker syncs, stop-loss loop, reconciliation,
 * CLOSES of existing positions — but never OPENS a new position (engine
 * entry gates + SwitchingAdapter backstop).
 *
 * SAFETY: the default is TRUE (trade), and only the literal string "false"
 * disables opens (same convention as MEANREV_ENABLED). Prod auto-deploys
 * master within ~2min and does NOT have this variable set — a "safe-looking"
 * default of false would silently stop production from trading on the next
 * push.
 *
 * Deliberately a per-call process.env read (not frozen into `config` at
 * import): tests toggle it, and it keeps exactly one source of truth.
 */
export function isTradingEnabled(): boolean {
  return process.env.TRADING_ENABLED !== "false";
}

export type Config = typeof config;
