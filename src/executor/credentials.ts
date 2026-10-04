// ═══ Runtime broker credentials — injection shape for the executors ═══
//
// F4a (docs/platform/PLAN.md): with ACCOUNTS_SOURCE=registry the executors
// receive their credentials through these objects, resolved from the
// platform_broker_accounts registry (src/platform/accounts/runtime.ts).
// With ACCOUNTS_SOURCE=env (the default) NO credentials object is injected
// and every executor keeps reading `config` exactly as before — the
// per-instance accessors fall back to config LIVE (not captured), so the
// existing config-mutation test seams stay byte-identical.
//
// This module is deliberately dependency-free (types + pure helpers only):
// both the executors and the platform resolver import it, so it must never
// pull either side in.

/** Credentials + environment for one Alpaca executor instance.
 *  Exactly one of (keyId+secretKey) / oauthToken is populated; `paper`
 *  and the base URLs are derived from the registry account's environment
 *  (paper → paper-api, live → api — live only after the arming ceremony). */
export interface AlpacaRuntimeCredentials {
  keyId: string;
  secretKey: string;
  /** Alpaca Connect (OAuth) access token — Authorization: Bearer on raw
   *  fetches, `oauth` option on the @alpacahq SDK. */
  oauthToken: string | null;
  paper: boolean;
  baseUrl: string;
  dataUrl: string;
  /** Registry row id (platform_broker_accounts.id) for logs; null when the
   *  venue is deliberately unlinked. NEVER a secret. */
  accountId: string | null;
}

/** Credentials for one Binance USDⓈ-M executor instance. The REST base is
 *  derived from the registry account's environment (demo → demo-fapi;
 *  live is refused upstream — mainnet is deferred by the owner). */
export interface BinanceRuntimeCredentials {
  apiKey: string;
  apiSecret: string;
  restBase: string;
  /** Registry row id for logs; null when the venue is unlinked. */
  accountId: string | null;
}

/** An UNLINKED Alpaca venue (registry mode, no account linked): empty keys
 *  on the default paper hosts. AlpacaExecutor.init() then refuses with
 *  "Alpaca API keys not configured" — no network, no .env fallback (the
 *  presence of a credentials object overrides every config read). */
export function unlinkedAlpacaCredentials(): AlpacaRuntimeCredentials {
  return {
    keyId: "",
    secretKey: "",
    oauthToken: null,
    paper: true,
    baseUrl: "https://paper-api.alpaca.markets",
    dataUrl: "https://data.alpaca.markets",
    accountId: null,
  };
}

/** An UNLINKED Binance venue: empty keys on the demo host —
 *  BinanceExecutor.init() refuses with "keys not configured". */
export function unlinkedBinanceCredentials(): BinanceRuntimeCredentials {
  return {
    apiKey: "",
    apiSecret: "",
    restBase: "https://demo-fapi.binance.com",
    accountId: null,
  };
}

/** Auth headers for Alpaca's raw REST calls (trading + data APIs share the
 *  scheme): Bearer for OAuth tokens, APCA key headers for API keys. */
export function alpacaRuntimeAuthHeaders(creds: AlpacaRuntimeCredentials): Record<string, string> {
  if (creds.oauthToken) return { Authorization: `Bearer ${creds.oauthToken}` };
  return { "APCA-API-KEY-ID": creds.keyId, "APCA-API-SECRET-KEY": creds.secretKey };
}
