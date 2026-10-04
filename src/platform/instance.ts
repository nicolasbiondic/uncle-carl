// ═══ Instance configuration (self-hosted platform) ═══
//
// A single installation ("instance") is configured by, in order of
// precedence:  env vars  >  <dataDir>/instance.json  >  defaults.
// The defaults are EXACTLY today's production behavior — an installation
// with no instance.json and none of the new env vars behaves byte-identical
// to prod (locked by src/platform/instance.test.ts "no instance.json").
//
// instance.json is written by `bun run setup` (scripts/setup.ts) or by the
// first-run web setup page, with mode 0600. Shape (all fields optional):
//
//   {
//     "dashboard": { "host": "0.0.0.0", "port": 3789, "publicUrl": "https://…" },
//     "owner":     { "username": "…", "passwordHash": "…", "displayName": "…" },
//     "oauth": {
//       "github": { "clientId": "…", "clientSecret": "…", "allowedId": 123, "allowedLogin": "…" },
//       "google": { "clientId": "…", "clientSecret": "…", "allowedEmail": "…" }
//     },
//     "brokerOAuth": {
//       "alpaca": { "clientId": "…", "clientSecret": "…" }
//     }
//   }
//
// brokerOAuth holds the owner's OWN broker OAuth app (Alpaca Connect: each
// installation registers its app; its client secret never ships in the
// repo). Absent = broker accounts are added with API keys only.
//
// This module is the ONLY reader of instance.json. Other platform modules
// (broker accounts, secretBox, dashboard) program against the exported API.

import fs from "fs";
import path from "path";
import { config } from "../config";

// ── Types ──────────────────────────────────────────────────────────────────

export interface InstanceOwner {
  username: string;
  passwordHash: string;
  displayName: string;
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Numeric GitHub account id — the stable identity (logins can be renamed). */
  allowedId: number;
  /** Informational only (shown in logs/docs); NEVER used for the allowlist check. */
  allowedLogin?: string;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Email allowed to sign in; must arrive with email_verified=true. */
  allowedEmail: string;
}

export interface BrokerOAuthAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface InstanceConfig {
  dataDir: string;
  dashboard: { host: string; port: number; publicUrl: string | null };
  owner: InstanceOwner | null;
  oauth: { github: GithubOAuthConfig | null; google: GoogleOAuthConfig | null };
  brokerOAuth: { alpaca: BrokerOAuthAppConfig | null };
  /** Where the runtime broker credentials come from (F4a): raw string from
   *  ACCOUNTS_SOURCE env > instance.json `accountsSource`; null = unset
   *  (defaults to "env"). Deliberately NOT validated here — this loader is
   *  tolerant by contract; main() validates via resolveAccountsSource
   *  (src/platform/accounts/runtime.ts) and ABORTS on an unknown value. */
  accountsSource: string | null;
  /** Registry links for the runtime venues (F4a): RUNTIME_ACCOUNT_ALPACA /
   *  RUNTIME_ACCOUNT_BINANCE env > instance.json `runtimeAccounts.{alpaca,
   *  binance}`. `binance` covers BOTH USDⓈ-M pools (USDT + USDC) of the
   *  same account; COIN-M stays .env-configured. */
  runtimeAccounts: { alpaca: string | null; binance: string | null };
}

// ── dataDir ────────────────────────────────────────────────────────────────

/** UC_DATA_DIR env, or ./data (the repo's existing data directory). */
export function instanceDataDir(): string {
  const d = (process.env.UC_DATA_DIR ?? "").trim();
  return d !== "" ? d : "data";
}

export function instanceFilePath(dataDir: string = instanceDataDir()): string {
  return path.join(dataDir, "instance.json");
}

// ── instance.json parsing (tolerant: a broken file never crashes the bot;
//    it logs to stderr and falls back to defaults, same as no file) ─────────

function readInstanceFile(dataDir: string): any {
  const p = instanceFilePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return {}; // no file = defaults (today's behavior)
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e: any) {
    // Deliberately console.error, not the repo logger: this module is also
    // imported by scripts/setup.ts before any logger config exists.
    console.error(`[instance] ${p} is not valid JSON (${e?.message ?? e}) — ignoring it`);
    return {};
  }
}

function str(v: any): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function parseOwner(raw: any): InstanceOwner | null {
  const username = str(raw?.username)?.toLowerCase() ?? null;
  const passwordHash = str(raw?.passwordHash);
  if (!username || !passwordHash) return null;
  return { username, passwordHash, displayName: str(raw?.displayName) ?? "Owner" };
}

function parseGithub(raw: any): GithubOAuthConfig | null {
  const clientId = str(raw?.clientId);
  const clientSecret = str(raw?.clientSecret);
  const allowedId = Number(raw?.allowedId);
  if (!clientId || !clientSecret || !Number.isSafeInteger(allowedId) || allowedId <= 0) return null;
  return { clientId, clientSecret, allowedId, allowedLogin: str(raw?.allowedLogin) ?? undefined };
}

function parseGoogle(raw: any): GoogleOAuthConfig | null {
  const clientId = str(raw?.clientId);
  const clientSecret = str(raw?.clientSecret);
  const allowedEmail = str(raw?.allowedEmail)?.toLowerCase() ?? null;
  if (!clientId || !clientSecret || !allowedEmail) return null;
  return { clientId, clientSecret, allowedEmail };
}

function parseBrokerOAuthApp(raw: any): BrokerOAuthAppConfig | null {
  const clientId = str(raw?.clientId);
  const clientSecret = str(raw?.clientSecret);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// ── Env overrides (precedence: env > instance.json > defaults) ─────────────

function envStr(key: string): string | null {
  return str(process.env[key]);
}

function envPort(): number | null {
  const raw = envStr("DASHBOARD_PORT");
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
}

function envGithub(): GithubOAuthConfig | null {
  return parseGithub({
    clientId: envStr("OAUTH_GITHUB_CLIENT_ID"),
    clientSecret: envStr("OAUTH_GITHUB_CLIENT_SECRET"),
    allowedId: envStr("OAUTH_GITHUB_ALLOWED_ID"),
    allowedLogin: envStr("OAUTH_GITHUB_ALLOWED_LOGIN"),
  });
}

function envGoogle(): GoogleOAuthConfig | null {
  return parseGoogle({
    clientId: envStr("OAUTH_GOOGLE_CLIENT_ID"),
    clientSecret: envStr("OAUTH_GOOGLE_CLIENT_SECRET"),
    allowedEmail: envStr("OAUTH_GOOGLE_ALLOWED_EMAIL"),
  });
}

// ── Public API (cached) ────────────────────────────────────────────────────

let cached: InstanceConfig | null = null;

export function loadInstanceConfig(): InstanceConfig {
  if (cached) return cached;
  const dataDir = instanceDataDir();
  const file = readInstanceFile(dataDir);
  const fd = file?.dashboard ?? {};

  cached = {
    dataDir,
    dashboard: {
      // Defaults are today's prod behavior: all interfaces, and the port
      // config.dashboard.port already resolves (DASHBOARD_PORT env → 3789).
      // envPort() re-reads the env so env always beats instance.json even
      // when both are set; the config fallback keeps the existing
      // config-mutation test seam (server.test.ts port-bind test) working.
      host: envStr("DASHBOARD_HOST") ?? str(fd.host) ?? "0.0.0.0",
      port: envPort()
        ?? (Number.isSafeInteger(fd.port) && fd.port > 0 && fd.port < 65536 ? fd.port : config.dashboard.port),
      publicUrl: normalizePublicUrl(envStr("PUBLIC_URL") ?? str(fd.publicUrl)),
    },
    // The owner configured by `bun run setup` / the first-run web page.
    // Env users (DASHBOARD_ADMIN_*/DASHBOARD_VIEWER_*) remain the dashboard
    // auth-store's domain (loadUsersFromEnv) and coexist with this one.
    owner: parseOwner(file?.owner),
    oauth: {
      github: envGithub() ?? parseGithub(file?.oauth?.github),
      google: envGoogle() ?? parseGoogle(file?.oauth?.google),
    },
    brokerOAuth: {
      alpaca: parseBrokerOAuthApp({ clientId: envStr("ALPACA_OAUTH_CLIENT_ID"), clientSecret: envStr("ALPACA_OAUTH_CLIENT_SECRET") })
        ?? parseBrokerOAuthApp(file?.brokerOAuth?.alpaca),
    },
    accountsSource: envStr("ACCOUNTS_SOURCE") ?? str(file?.accountsSource),
    runtimeAccounts: {
      alpaca: envStr("RUNTIME_ACCOUNT_ALPACA") ?? str(file?.runtimeAccounts?.alpaca),
      binance: envStr("RUNTIME_ACCOUNT_BINANCE") ?? str(file?.runtimeAccounts?.binance),
    },
  };
  return cached;
}

export function resetInstanceConfigForTests(): void {
  cached = null;
}

/** Drop the cache and re-read (used by server start and after setup writes
 *  instance.json — a long-lived process must not act on a stale view). */
export function reloadInstanceConfig(): InstanceConfig {
  cached = null;
  return loadInstanceConfig();
}

/**
 * Normalize a public URL: must parse as http(s), returns origin+pathname
 * without a trailing slash (e.g. "https://bot.example.com"). Anything else
 * (garbage, ftp:, empty) → null, logged once via loadInstanceConfig.
 */
export function normalizePublicUrl(raw: string | null): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    console.error(`[instance] PUBLIC_URL "${raw}" is not a valid URL — ignoring it`);
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    console.error(`[instance] PUBLIC_URL "${raw}" must be http(s) — ignoring it`);
    return null;
  }
  if (u.username || u.password) {
    console.error(`[instance] PUBLIC_URL must not embed credentials — ignoring it`);
    return null;
  }
  u.search = "";
  u.hash = "";
  const base = u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, ""));
  return base;
}

/** Normalized public base URL (no trailing slash), or null when unset. */
export function publicBaseUrl(): string | null {
  return loadInstanceConfig().dashboard.publicUrl;
}

/**
 * Origins allowed for the dashboard (WS upgrade / CSWSH defence):
 * the ORIGIN of PUBLIC_URL (when set) + every entry of
 * DASHBOARD_ALLOWED_ORIGINS (CSV, unchanged semantics). Deduped, ordered
 * publicUrl first. server.ts merges these with its existing host-based
 * defaults — so with neither configured the behavior is exactly today's.
 */
export function instanceAllowedOrigins(): string[] {
  const out: string[] = [];
  const pub = publicBaseUrl();
  if (pub) out.push(new URL(pub).origin);
  for (const o of (process.env.DASHBOARD_ALLOWED_ORIGINS || "").split(",")) {
    const t = o.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** True when session cookies must be marked Secure: explicit
 *  DASHBOARD_COOKIE_SECURE wins ("true"/"false"); otherwise inferred from
 *  PUBLIC_URL being https (behind a TLS tunnel/proxy with TRUST_PROXY). */
export function cookieSecure(): boolean {
  const explicit = (process.env.DASHBOARD_COOKIE_SECURE ?? "").trim();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return (publicBaseUrl() ?? "").startsWith("https://");
}
