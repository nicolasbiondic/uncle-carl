// ═══ Platform broker-accounts registry — shared types (2026-10-04) ═══
//
// Self-hosted platform phase 1b: the owner registers broker credentials from
// the dashboard ("like an OAuth"). Credentials are sealed at rest with the
// installation's master key (SecretBox, built by src/platform/secretBox.ts —
// NOT this branch; injected via AccountsDeps), verified with read-only broker
// calls, and listed without secrets. The trading engines do NOT consume these
// accounts yet — prod keeps using the .env-configured executors.

/** Sealed-secret interface. The concrete implementation (master-key crypto)
 *  lives in src/platform/secretBox.ts (parallel branch); everything here only
 *  depends on this shape. */
export interface SecretBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

/** Everything the accounts stack needs from the host installation, injected
 *  by the composer (server.ts integration happens outside this branch). */
export interface AccountsDeps {
  /** Throws if the installation has no master key yet (bun run setup). */
  box: () => SecretBox;
  /** e.g. https://bot.example.com — used to build the OAuth redirect_uri. */
  publicBaseUrl: () => string | null;
  /** Alpaca Connect app credentials, or null when no OAuth app is configured. */
  alpacaOAuth: () => { clientId: string; clientSecret: string } | null;
  fetch?: typeof fetch;
  now?: () => number;
}

export type BrokerProvider = "alpaca" | "binance_usdm";
export type BrokerEnvironment = "paper" | "live" | "demo";
export type BrokerAuthType = "api_key" | "oauth";
/** 'verified' = last verification call succeeded; 'error' = it failed (the
 *  row is kept so the owner can see WHY and re-verify or delete). Rows are
 *  only ever INSERTED after a successful verification, so 'unverified' can
 *  only appear transiently (schema default) — never through the service.
 *  'revoked' (2026-10-06) = the owner revoked access: the stored credentials
 *  are DELETED, the row stays as a record; verification demands reconnecting
 *  and the runtime never auto-links it (runtime.ts filters 'verified'). */
export type BrokerAccountStatus = "verified" | "error" | "unverified" | "revoked";

/** What gets sealed into credentials_enc. NEVER returned by any API. */
export type BrokerCredentials =
  | { kind: "api_key"; apiKey: string; apiSecret: string }
  | { kind: "oauth"; accessToken: string; tokenType?: string; scope?: string };

/** Public (redacted) row — the only account shape routes/UI ever see. */
export interface BrokerAccountRecord {
  id: string;
  provider: BrokerProvider;
  label: string;
  environment: BrokerEnvironment;
  authType: BrokerAuthType;
  status: BrokerAccountStatus;
  /** Broker-side account number/id — identifying, not secret. */
  accountRef: string | null;
  lastVerifiedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Result of a read-only verification call against the broker. */
export interface VerificationResult {
  ok: boolean;
  accountRef?: string | null;
  /** Non-fatal findings (e.g. "API key permits withdrawals"). */
  warnings?: string[];
  error?: string;
}
