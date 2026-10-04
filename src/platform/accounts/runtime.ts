// ═══ Runtime account resolution — registry → executor credentials (F4a) ═══
//
// ACCOUNTS_SOURCE decides where the executors' broker credentials come from:
//   "env" (default)  — the .env keys via `config`, byte-identical to today.
//   "registry"       — rows of platform_broker_accounts, credentials opened
//                      with the instance master key (SecretBox).
// An UNKNOWN value aborts startup (resolveAccountsSource throws — main()
// invokes it before any subsystem starts).
//
// Linking (registry mode), per venue:
//   1. an explicit link: instance.json `runtimeAccounts: { alpaca, binance }`
//      (env override RUNTIME_ACCOUNT_ALPACA / RUNTIME_ACCOUNT_BINANCE wins);
//   2. no link + exactly ONE verified account of that provider → auto-link
//      (logged by the caller — the resolution carries `autoLinked`);
//   3. otherwise the venue stays UNLINKED (reason carried for the logs/
//      dashboard); main() then builds NO executor/engines for it (F4b).
//
// Fail-closed rules (owner decisions, docs/platform/PLAN.md):
//   - an Alpaca account with environment "live" must pass the SAME arming
//     ceremony as today's env path (TRADING_MODE=live, LIVE_ACCOUNT_ID equal
//     to the account number, the hand-made marker file, an ops chat) or the
//     venue is NOT linked — engines are never built over an unarmed live
//     account;
//   - a Binance account with environment "live" is REFUSED outright: the
//     owner deferred mainnet;
//   - no master key, or credentials that don't open (wrong key) → the whole
//     startup fails with a clear message: silently booting without the
//     linked venue would strand its positions.

import fs from "fs";
import { LIVE_ARM_MARKER_PATH, type AccountsSource } from "../../config";
import type { AlpacaRuntimeCredentials, BinanceRuntimeCredentials } from "../../executor/credentials";
import { getSecretBox } from "../secretBox";
import { loadInstanceConfig } from "../instance";
import { BrokerAccountsRepository } from "./repository";
import type { BrokerAccountRecord, BrokerCredentials, BrokerProvider, SecretBox } from "./types";
import { alpacaApiBase } from "./providers/alpaca";
import { binanceUsdmBase } from "./providers/binanceUsdm";

export const ALPACA_DATA_URL = "https://data.alpaca.markets";

/** Validate the raw ACCOUNTS_SOURCE / instance.json value. Unset/empty =
 *  "env" (today's behavior). Anything else but env|registry THROWS — an
 *  operator typo must abort the boot, never silently fall back to .env. */
export function resolveAccountsSource(raw: string | null | undefined): AccountsSource {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "" || t === "env") return "env";
  if (t === "registry") return "registry";
  throw new Error(
    `ACCOUNTS_SOURCE "${raw}" is not valid — use "env" (.env credentials, the default) or "registry" (platform broker accounts). Refusing to guess where the money credentials come from.`,
  );
}

export type VenueResolution<C> =
  | { linked: true; credentials: C; account: BrokerAccountRecord; autoLinked: boolean }
  | { linked: false; reason: string };

export interface RegistryRuntimeAccounts {
  alpaca: VenueResolution<AlpacaRuntimeCredentials>;
  binance: VenueResolution<BinanceRuntimeCredentials>;
}

export interface ResolveRegistryDeps {
  repo?: BrokerAccountsRepository;
  box?: SecretBox;
  env?: Record<string, string | undefined>;
  /** Explicit links; defaults to loadInstanceConfig().runtimeAccounts. */
  links?: { alpaca: string | null; binance: string | null };
  /** Injectable for tests — defaults to reading LIVE_ARM_MARKER_PATH. */
  readLiveArmMarker?: () => string | null;
}

function defaultReadLiveArmMarker(): string | null {
  try {
    return fs.readFileSync(LIVE_ARM_MARKER_PATH, "utf8").trim();
  } catch {
    return null;
  }
}

function present(v: string | undefined): boolean {
  const t = (v ?? "").trim();
  return t !== "" && !/^your_/i.test(t);
}

/** Pick the registry row for a venue: explicit link first, else the single
 *  verified account of that provider. Returns a reason string on failure. */
function pickAccount(
  repo: BrokerAccountsRepository,
  provider: BrokerProvider,
  linkId: string | null,
): { account: BrokerAccountRecord; autoLinked: boolean } | { reason: string } {
  if (linkId) {
    const rec = repo.get(linkId);
    if (!rec) return { reason: `linked account '${linkId}' does not exist in the registry` };
    if (rec.provider !== provider) {
      return { reason: `linked account '${linkId}' is provider '${rec.provider}', expected '${provider}'` };
    }
    return { account: rec, autoLinked: false };
  }
  const verified = repo.list().filter((r) => r.provider === provider && r.status === "verified");
  if (verified.length === 1) return { account: verified[0], autoLinked: true };
  if (verified.length === 0) {
    return { reason: `no verified ${provider} account in the registry and no runtimeAccounts link — add one from the dashboard (Accounts) and restart` };
  }
  return {
    reason: `${verified.length} verified ${provider} accounts and no runtimeAccounts link — set instance.json runtimeAccounts.${provider === "alpaca" ? "alpaca" : "binance"} (or RUNTIME_ACCOUNT_${provider === "alpaca" ? "ALPACA" : "BINANCE"}) to the account id`,
  };
}

/** Open + parse a row's sealed credentials. Throws on a wrong/absent master
 *  key or a corrupt blob — that is an installation-level failure, never a
 *  silently-unlinked venue. */
function openCredentials(repo: BrokerAccountsRepository, box: () => SecretBox, rec: BrokerAccountRecord): BrokerCredentials {
  const enc = repo.getCredentialsEnc(rec.id);
  if (!enc) throw new Error(`broker account '${rec.id}': credentials_enc row missing`);
  const opener = box();
  let plain: string;
  try {
    plain = opener.open(enc);
  } catch (e: any) {
    throw new Error(`broker account '${rec.id}': cannot open stored credentials (wrong master key?) — ${e?.message ?? e}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new Error(`broker account '${rec.id}': stored credentials are not valid JSON`);
  }
  if (!parsed || (parsed.kind !== "api_key" && parsed.kind !== "oauth")) {
    throw new Error(`broker account '${rec.id}': stored credentials have an unknown kind`);
  }
  return parsed as BrokerCredentials;
}

/** The SAME live-arming ceremony assertRequiredConfig enforces for the env
 *  path, applied to a registry Alpaca account — plus the account-number
 *  equality (LIVE_ACCOUNT_ID must equal the row's verified accountRef). */
export function alpacaLiveCeremonyProblems(
  rec: BrokerAccountRecord,
  env: Record<string, string | undefined>,
  readLiveArmMarker: () => string | null,
): string[] {
  const problems: string[] = [];
  if (env.TRADING_MODE !== "live") {
    problems.push(`TRADING_MODE must be explicitly "live" (got "${env.TRADING_MODE ?? "unset"}")`);
  }
  const liveAccountId = (env.LIVE_ACCOUNT_ID ?? "").trim();
  if (!liveAccountId) {
    problems.push("LIVE_ACCOUNT_ID must be set to the expected broker account id");
  } else {
    if (!rec.accountRef) {
      problems.push(`registry account '${rec.id}' has no verified account number (accountRef) to match LIVE_ACCOUNT_ID against`);
    } else if (rec.accountRef !== liveAccountId) {
      problems.push(`LIVE_ACCOUNT_ID ("${liveAccountId}") does not match registry account '${rec.id}' accountRef ("${rec.accountRef}")`);
    }
    const marker = readLiveArmMarker();
    if (marker === null) {
      problems.push(`live-arm marker file ${LIVE_ARM_MARKER_PATH} is missing — create it by hand containing exactly LIVE_ACCOUNT_ID's value`);
    } else if (marker !== liveAccountId) {
      problems.push(`live-arm marker file ${LIVE_ARM_MARKER_PATH} content does not match LIVE_ACCOUNT_ID`);
    }
  }
  if (!present(env.TELEGRAM_OPS_CHAT_ID)) {
    problems.push("TELEGRAM_OPS_CHAT_ID must be set — live trading never starts without a human paging chat");
  }
  return problems;
}

function resolveAlpaca(
  repo: BrokerAccountsRepository,
  box: () => SecretBox,
  env: Record<string, string | undefined>,
  linkId: string | null,
  readLiveArmMarker: () => string | null,
): VenueResolution<AlpacaRuntimeCredentials> {
  const picked = pickAccount(repo, "alpaca", linkId);
  if ("reason" in picked) return { linked: false, reason: picked.reason };
  const rec = picked.account;

  if (rec.environment === "live") {
    const problems = alpacaLiveCeremonyProblems(rec, env, readLiveArmMarker);
    if (problems.length > 0) {
      return {
        linked: false,
        reason: `alpaca account '${rec.id}' is LIVE and the arming ceremony is incomplete — engines will NOT be built over it: ${problems.join("; ")}`,
      };
    }
  }

  const creds = openCredentials(repo, box, rec);
  const paper = rec.environment !== "live";
  const base: AlpacaRuntimeCredentials = {
    keyId: creds.kind === "api_key" ? creds.apiKey : "",
    secretKey: creds.kind === "api_key" ? creds.apiSecret : "",
    oauthToken: creds.kind === "oauth" ? creds.accessToken : null,
    paper,
    baseUrl: alpacaApiBase(paper ? "paper" : "live"),
    dataUrl: ALPACA_DATA_URL,
    accountId: rec.id,
  };
  return { linked: true, credentials: base, account: rec, autoLinked: picked.autoLinked };
}

function resolveBinance(
  repo: BrokerAccountsRepository,
  box: () => SecretBox,
  linkId: string | null,
): VenueResolution<BinanceRuntimeCredentials> {
  const picked = pickAccount(repo, "binance_usdm", linkId);
  if ("reason" in picked) return { linked: false, reason: picked.reason };
  const rec = picked.account;

  if (rec.environment === "live") {
    return {
      linked: false,
      reason: `binance account '${rec.id}' is LIVE (mainnet) — REFUSED: the owner deferred Binance mainnet; only demo accounts can run for now`,
    };
  }

  const creds = openCredentials(repo, box, rec);
  if (creds.kind !== "api_key") {
    return { linked: false, reason: `binance account '${rec.id}' has non-API-key credentials — unsupported` };
  }
  return {
    linked: true,
    credentials: {
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      restBase: binanceUsdmBase("demo"),
      accountId: rec.id,
    },
    account: rec,
    autoLinked: picked.autoLinked,
  };
}

/** Resolve BOTH runtime venues from the registry. Throws when a linked
 *  account's credentials can't be opened (missing/wrong master key, clear
 *  message). The key is only needed to OPEN credentials: a registry with
 *  nothing to open — a fresh installation before its first account, whose
 *  key is created by setup or the first-run page — resolves without one. An
 *  unlinked venue is NOT an error here — the caller decides (F4b: boot
 *  without that venue). */
export function resolveRegistryRuntimeAccounts(deps: ResolveRegistryDeps = {}): RegistryRuntimeAccounts {
  const repo = deps.repo ?? new BrokerAccountsRepository();
  let box: SecretBox | null = deps.box ?? null;
  const getBox = (): SecretBox => {
    if (box) return box;
    try {
      box = getSecretBox();
    } catch (e: any) {
      throw new Error(
        `ACCOUNTS_SOURCE=registry requires the instance master key to open stored broker credentials — ${e?.message ?? e}`,
      );
    }
    return box;
  };
  const env = deps.env ?? process.env;
  const links = deps.links ?? loadInstanceConfig().runtimeAccounts;
  const readMarker = deps.readLiveArmMarker ?? defaultReadLiveArmMarker;

  return {
    alpaca: resolveAlpaca(repo, getBox, env, links.alpaca, readMarker),
    binance: resolveBinance(repo, getBox, links.binance),
  };
}
