// ═══ F4a — runtime account resolution (registry → executor credentials) ═══
//
// Startup matrix locked here (the pure core main() consumes):
//   - ACCOUNTS_SOURCE validation: default env, registry, unknown ABORTS;
//   - explicit link / auto-link (exactly one verified) / 0 / >1 → unlinked;
//   - fail-closed: live Alpaca without the arming ceremony NOT linked,
//     live Binance REFUSED (mainnet deferred), wrong/missing master key
//     throws with a clear message.
// Everything runs against a REAL in-memory registry (repository + SecretBox),
// never mocks of our own modules.

import { describe, expect, test, beforeEach } from "bun:test";
import crypto from "crypto";
import { makeTestDb } from "../../test-support/db";
import { createSecretBox } from "../secretBox";
import { BrokerAccountsRepository } from "./repository";
import type { BrokerCredentials, BrokerEnvironment, BrokerProvider } from "./types";
import {
  resolveAccountsSource, resolveRegistryRuntimeAccounts, alpacaLiveCeremonyProblems, ALPACA_DATA_URL,
} from "./runtime";

const box = createSecretBox(Uint8Array.from(crypto.randomBytes(32)));
let repo: BrokerAccountsRepository;

function seedAccount(opts: {
  id: string;
  provider: BrokerProvider;
  environment: BrokerEnvironment;
  creds: BrokerCredentials;
  status?: "verified" | "error";
  accountRef?: string | null;
}): void {
  repo.insert({
    id: opts.id,
    provider: opts.provider,
    label: opts.id,
    environment: opts.environment,
    authType: opts.creds.kind === "oauth" ? "oauth" : "api_key",
    credentialsEnc: box.seal(JSON.stringify(opts.creds)),
    status: opts.status ?? "verified",
    accountRef: opts.accountRef ?? null,
    lastVerifiedAt: Date.now(),
    createdAt: Date.now(),
  });
}

const NO_LINKS = { alpaca: null, binance: null };
const ENV_PAPER = {}; // no live-arming vars — the paper default
const noMarker = () => null;

function resolve(over: Partial<Parameters<typeof resolveRegistryRuntimeAccounts>[0] & object> = {}) {
  return resolveRegistryRuntimeAccounts({
    repo, box, env: ENV_PAPER, links: NO_LINKS, readLiveArmMarker: noMarker,
    ...over,
  });
}

beforeEach(() => {
  makeTestDb();
  repo = new BrokerAccountsRepository();
});

describe("resolveAccountsSource", () => {
  test("unset/empty/'env' → env (today's default, byte-identical)", () => {
    expect(resolveAccountsSource(null)).toBe("env");
    expect(resolveAccountsSource(undefined)).toBe("env");
    expect(resolveAccountsSource("")).toBe("env");
    expect(resolveAccountsSource("env")).toBe("env");
    expect(resolveAccountsSource(" ENV ")).toBe("env");
  });
  test("'registry' → registry", () => {
    expect(resolveAccountsSource("registry")).toBe("registry");
    expect(resolveAccountsSource("Registry")).toBe("registry");
  });
  test("an unknown value ABORTS startup (throws), never guesses", () => {
    expect(() => resolveAccountsSource("registery")).toThrow(/not valid/);
    expect(() => resolveAccountsSource("db")).toThrow(/ACCOUNTS_SOURCE/);
  });
});

describe("linking — explicit link and auto-link", () => {
  test("auto-link: exactly ONE verified account per provider links it", () => {
    seedAccount({ id: "alpaca-paper", provider: "alpaca", environment: "paper", creds: { kind: "api_key", apiKey: "PKX", apiSecret: "SX" } });
    seedAccount({ id: "binance-demo", provider: "binance_usdm", environment: "demo", creds: { kind: "api_key", apiKey: "BK", apiSecret: "BS" } });
    const r = resolve();
    expect(r.alpaca.linked && r.alpaca.autoLinked).toBe(true);
    expect(r.binance.linked && r.binance.autoLinked).toBe(true);
    if (!r.alpaca.linked || !r.binance.linked) throw new Error("unreachable");
    // Credentials come from the sealed blob; environment decides the hosts.
    expect(r.alpaca.credentials).toEqual({
      keyId: "PKX", secretKey: "SX", oauthToken: null, paper: true,
      baseUrl: "https://paper-api.alpaca.markets", dataUrl: ALPACA_DATA_URL,
      accountId: "alpaca-paper",
    });
    expect(r.binance.credentials).toEqual({
      apiKey: "BK", apiSecret: "BS", restBase: "https://demo-fapi.binance.com", accountId: "binance-demo",
    });
  });

  test("explicit link wins over auto-link and ignores status", () => {
    seedAccount({ id: "a1", provider: "alpaca", environment: "paper", creds: { kind: "api_key", apiKey: "K1", apiSecret: "S1" } });
    seedAccount({ id: "a2", provider: "alpaca", environment: "paper", creds: { kind: "api_key", apiKey: "K2", apiSecret: "S2" } });
    const r = resolve({ links: { alpaca: "a2", binance: null } });
    expect(r.alpaca.linked).toBe(true);
    if (!r.alpaca.linked) throw new Error("unreachable");
    expect(r.alpaca.autoLinked).toBe(false);
    expect(r.alpaca.credentials.keyId).toBe("K2");
  });

  test("0 verified accounts → venue UNLINKED with a guiding reason", () => {
    const r = resolve();
    expect(r.alpaca.linked).toBe(false);
    expect(r.binance.linked).toBe(false);
    if (r.alpaca.linked || r.binance.linked) throw new Error("unreachable");
    expect(r.alpaca.reason).toMatch(/no verified alpaca account/);
    expect(r.binance.reason).toMatch(/no verified binance_usdm account/);
  });

  test(">1 verified without a link → UNLINKED (never guesses between accounts)", () => {
    seedAccount({ id: "a1", provider: "alpaca", environment: "paper", creds: { kind: "api_key", apiKey: "K1", apiSecret: "S1" } });
    seedAccount({ id: "a2", provider: "alpaca", environment: "paper", creds: { kind: "api_key", apiKey: "K2", apiSecret: "S2" } });
    const r = resolve();
    expect(r.alpaca.linked).toBe(false);
    if (r.alpaca.linked) throw new Error("unreachable");
    expect(r.alpaca.reason).toMatch(/2 verified alpaca accounts/);
  });

  test("an unverified account never auto-links", () => {
    seedAccount({ id: "a1", provider: "alpaca", environment: "paper", status: "error", creds: { kind: "api_key", apiKey: "K1", apiSecret: "S1" } });
    const r = resolve();
    expect(r.alpaca.linked).toBe(false);
  });

  test("a REVOKED account never auto-links — only 'verified' is eligible", () => {
    seedAccount({ id: "a1", provider: "alpaca", environment: "paper", creds: { kind: "api_key", apiKey: "K1", apiSecret: "S1" } });
    repo.revoke("a1", Date.now());
    const r = resolve();
    expect(r.alpaca.linked).toBe(false);
    if (r.alpaca.linked) throw new Error("unreachable");
    expect(r.alpaca.reason).toMatch(/no verified alpaca account/);
  });

  test("an EXPLICIT link to a revoked account aborts resolution (fail closed) — its credentials were deleted, the bot never boots over it", () => {
    seedAccount({ id: "a1", provider: "alpaca", environment: "paper", creds: { kind: "api_key", apiKey: "K1", apiSecret: "S1" } });
    repo.revoke("a1", Date.now());
    expect(() => resolve({ links: { alpaca: "a1", binance: null } })).toThrow(/credentials_enc row missing/);
  });

  test("link to a missing id / wrong provider → UNLINKED with the id named", () => {
    seedAccount({ id: "bd", provider: "binance_usdm", environment: "demo", creds: { kind: "api_key", apiKey: "BK", apiSecret: "BS" } });
    const r = resolve({ links: { alpaca: "bd", binance: "ghost" } });
    expect(r.alpaca.linked).toBe(false);
    expect(r.binance.linked).toBe(false);
    if (r.alpaca.linked || r.binance.linked) throw new Error("unreachable");
    expect(r.alpaca.reason).toMatch(/provider 'binance_usdm'/);
    expect(r.binance.reason).toMatch(/'ghost' does not exist/);
  });

  test("OAuth Alpaca account → oauthToken populated, no key pair", () => {
    seedAccount({ id: "a-oauth", provider: "alpaca", environment: "paper", creds: { kind: "oauth", accessToken: "tok123" } });
    const r = resolve();
    expect(r.alpaca.linked).toBe(true);
    if (!r.alpaca.linked) throw new Error("unreachable");
    expect(r.alpaca.credentials.oauthToken).toBe("tok123");
    expect(r.alpaca.credentials.keyId).toBe("");
  });
});

describe("fail-closed: live environments", () => {
  const liveAlpaca = () => seedAccount({
    id: "a-live", provider: "alpaca", environment: "live", accountRef: "ACCT123",
    creds: { kind: "api_key", apiKey: "LK", apiSecret: "LS" },
  });

  test("live Alpaca WITHOUT the arming ceremony is NOT linked (no engines over it)", () => {
    liveAlpaca();
    const r = resolve();
    expect(r.alpaca.linked).toBe(false);
    if (r.alpaca.linked) throw new Error("unreachable");
    expect(r.alpaca.reason).toMatch(/arming ceremony is incomplete/);
    expect(r.alpaca.reason).toMatch(/TRADING_MODE/);
  });

  test("live Alpaca with the FULL ceremony links with the live hosts", () => {
    liveAlpaca();
    const env = { TRADING_MODE: "live", LIVE_ACCOUNT_ID: "ACCT123", TELEGRAM_OPS_CHAT_ID: "-100123" };
    const r = resolve({ env, readLiveArmMarker: () => "ACCT123" });
    expect(r.alpaca.linked).toBe(true);
    if (!r.alpaca.linked) throw new Error("unreachable");
    expect(r.alpaca.credentials.paper).toBe(false);
    expect(r.alpaca.credentials.baseUrl).toBe("https://api.alpaca.markets");
  });

  test("ceremony enumerates every unmet requirement (marker, account match, ops chat)", () => {
    liveAlpaca();
    const rec = repo.get("a-live")!;
    const problems = alpacaLiveCeremonyProblems(rec, { TRADING_MODE: "live", LIVE_ACCOUNT_ID: "WRONG" }, () => "ACCT123");
    expect(problems.join(" | ")).toMatch(/does not match registry account/);
    expect(problems.join(" | ")).toMatch(/marker file .* does not match/);
    expect(problems.join(" | ")).toMatch(/TELEGRAM_OPS_CHAT_ID/);
  });

  test("live Binance is REFUSED outright (owner deferred mainnet)", () => {
    seedAccount({ id: "b-live", provider: "binance_usdm", environment: "live", creds: { kind: "api_key", apiKey: "BK", apiSecret: "BS" } });
    const r = resolve({ links: { alpaca: null, binance: "b-live" } });
    expect(r.binance.linked).toBe(false);
    if (r.binance.linked) throw new Error("unreachable");
    expect(r.binance.reason).toMatch(/REFUSED.*deferred/);
  });
});

describe("fail-closed: master key", () => {
  test("credentials sealed with a DIFFERENT key throw a clear installation-level error", () => {
    const otherBox = createSecretBox(Uint8Array.from(crypto.randomBytes(32)));
    repo.insert({
      id: "a1", provider: "alpaca", label: "a1", environment: "paper", authType: "api_key",
      credentialsEnc: otherBox.seal(JSON.stringify({ kind: "api_key", apiKey: "K", apiSecret: "S" })),
      status: "verified", accountRef: null, lastVerifiedAt: Date.now(), createdAt: Date.now(),
    });
    expect(() => resolve()).toThrow(/cannot open stored credentials/);
  });

  // Force getSecretBox()'s no-key path: no UC_MASTER_KEY, dataDir without master.key.
  function withoutMasterKey(fn: () => void): void {
    const savedKey = process.env.UC_MASTER_KEY;
    const savedDir = process.env.UC_DATA_DIR;
    delete process.env.UC_MASTER_KEY;
    process.env.UC_DATA_DIR = "/nonexistent-uc-test-dir";
    try {
      fn();
    } finally {
      if (savedKey === undefined) delete process.env.UC_MASTER_KEY; else process.env.UC_MASTER_KEY = savedKey;
      if (savedDir === undefined) delete process.env.UC_DATA_DIR; else process.env.UC_DATA_DIR = savedDir;
    }
  }

  test("no master key with an account to open → the registry resolution throws with setup guidance", () => {
    seedAccount({ id: "alpaca-paper", provider: "alpaca", environment: "paper", creds: { kind: "api_key", apiKey: "PKX", apiSecret: "SX" } });
    withoutMasterKey(() => {
      expect(() => resolveRegistryRuntimeAccounts({ repo, env: {}, links: NO_LINKS, readLiveArmMarker: noMarker }))
        .toThrow(/requires the instance master key/);
    });
  });

  test("no master key and nothing to open (fresh installation) → both venues UNLINKED, no throw", () => {
    // The key is created by `bun run setup` or the first-run page; a fresh
    // install (e.g. docker compose up) must boot to serve that page.
    withoutMasterKey(() => {
      const r = resolveRegistryRuntimeAccounts({ repo, env: {}, links: NO_LINKS, readLiveArmMarker: noMarker });
      expect(r.alpaca.linked).toBe(false);
      expect(r.binance.linked).toBe(false);
    });
  });
});
