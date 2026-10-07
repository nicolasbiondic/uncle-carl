// ═══ Broker-accounts service — add / verify / list / remove ═══
//
// Rules this module enforces:
//  - Secrets are sealed (SecretBox) before they touch SQLite and are NEVER
//    returned by any method — only redacted BrokerAccountRecord rows leave.
//  - An account is only INSERTED after its credentials passed a read-only
//    verification call against the broker; a failed verification saves
//    nothing.
//  - Error messages that might embed a secret (defensive — the providers
//    only emit status codes) are scrubbed before being stored or thrown.

import type {
  AccountsDeps, BrokerAccountRecord, BrokerCredentials, BrokerEnvironment,
  BrokerProvider, SecretBox, VerificationResult,
} from "./types";
import { BrokerAccountsRepository } from "./repository";
import { verifyAlpaca, type AlpacaEnv } from "./providers/alpaca";
import { verifyBinanceUsdm, type BinanceUsdmEnv } from "./providers/binanceUsdm";

export class AccountsError extends Error {
  constructor(
    public code: "not_configured" | "validation" | "verification_failed" | "not_found" | "conflict",
    message: string,
    public httpStatus: number,
  ) {
    super(message);
    this.name = "AccountsError";
  }
}

const ENVS_BY_PROVIDER: Record<BrokerProvider, BrokerEnvironment[]> = {
  alpaca: ["paper", "live"],
  binance_usdm: ["demo", "live"],
};

/** Defensive scrub: replace any literal secret occurrence in a message. */
export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out;
}

/** label → slug id charset [a-z0-9-]; falls back to the provider name. */
export function slugify(label: string, fallback: string): string {
  const slug = label.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

export interface AddAccountResult {
  account: BrokerAccountRecord;
  warnings: string[];
}

export class BrokerAccountsService {
  private repo: BrokerAccountsRepository;
  private fetchFn: typeof fetch;
  private now: () => number;

  constructor(private deps: AccountsDeps, repo?: BrokerAccountsRepository) {
    this.repo = repo ?? new BrokerAccountsRepository();
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** True once the installation has a master key (bun run setup done). */
  isConfigured(): boolean {
    try { this.deps.box(); return true; } catch { return false; }
  }

  list(): BrokerAccountRecord[] {
    return this.repo.list();
  }

  async addApiKeyAccount(input: {
    provider: unknown; environment: unknown; label: unknown;
    apiKey: unknown; apiSecret: unknown;
  }): Promise<AddAccountResult> {
    const provider = this.parseProvider(input.provider);
    const environment = this.parseEnvironment(provider, input.environment);
    const label = this.parseLabel(input.label, `${provider} ${environment}`);
    const apiKey = this.parseSecretField(input.apiKey, "apiKey");
    const apiSecret = this.parseSecretField(input.apiSecret, "apiSecret");
    const box = this.requireBox();

    const creds: BrokerCredentials = { kind: "api_key", apiKey, apiSecret };
    const result = await this.verifyWithProvider(provider, environment, creds);
    if (!result.ok) {
      throw new AccountsError(
        "verification_failed",
        redactSecrets(result.error ?? "verification failed", [apiKey, apiSecret]),
        422,
      );
    }
    return this.save(provider, environment, label, "api_key", creds, box, result);
  }

  /** Alpaca OAuth result → verified account (called by the OAuth callback). */
  async addOAuthAccount(input: {
    environment: "paper" | "live"; label: string;
    accessToken: string; tokenType?: string; scope?: string;
  }): Promise<AddAccountResult> {
    const label = this.parseLabel(input.label, `alpaca ${input.environment}`);
    const box = this.requireBox();
    const creds: BrokerCredentials = {
      kind: "oauth",
      accessToken: input.accessToken,
      tokenType: input.tokenType,
      scope: input.scope,
    };
    const result = await this.verifyWithProvider("alpaca", input.environment, creds);
    if (!result.ok) {
      throw new AccountsError(
        "verification_failed",
        redactSecrets(result.error ?? "verification failed", [input.accessToken]),
        422,
      );
    }
    return this.save("alpaca", input.environment, label, "oauth", creds, box, result);
  }

  /** Re-runs the read-only verification with the stored (sealed) credentials
   *  and persists the outcome on the row. */
  async verifyAccount(id: string): Promise<AddAccountResult & { ok: boolean }> {
    const existing = this.repo.get(id);
    if (!existing) throw new AccountsError("not_found", `No account '${id}'`, 404);
    if (existing.status === "revoked") {
      throw new AccountsError(
        "conflict",
        `Account '${id}' was revoked — its stored credentials were deleted. Reconnect it (add the account again) to use it`,
        409,
      );
    }
    const box = this.requireBox();
    const sealed = this.repo.getCredentialsEnc(id);
    if (!sealed) throw new AccountsError("not_found", `No credentials for '${id}'`, 404);
    const creds = JSON.parse(box.open(sealed)) as BrokerCredentials;

    const result = await this.verifyWithProvider(existing.provider, existing.environment, creds);
    const secrets = creds.kind === "api_key" ? [creds.apiKey, creds.apiSecret] : [creds.accessToken];
    const at = this.now();
    if (result.ok) {
      this.repo.updateVerification(id, {
        status: "verified",
        accountRef: result.accountRef ?? undefined,
        lastVerifiedAt: at,
        lastError: null,
        updatedAt: at,
      });
    } else {
      this.repo.updateVerification(id, {
        status: "error",
        lastError: redactSecrets(result.error ?? "verification failed", secrets),
        updatedAt: at,
      });
    }
    return { ok: result.ok, account: this.repo.get(id)!, warnings: result.warnings ?? [] };
  }

  remove(id: string): boolean {
    return this.repo.remove(id);
  }

  /** Revoke: delete the stored credentials, keep the row as a 'revoked'
   *  record. Idempotent — revoking a revoked account is a no-op success.
   *  (Alpaca documents no server-side OAuth token revocation endpoint for
   *  Connect apps, so the UI also tells the owner to revoke app access on
   *  the broker's side.) */
  revoke(id: string): BrokerAccountRecord {
    const existing = this.repo.get(id);
    if (!existing) throw new AccountsError("not_found", `No account '${id}'`, 404);
    if (existing.status !== "revoked") this.repo.revoke(id, this.now());
    return this.repo.get(id)!;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private requireBox(): SecretBox {
    try {
      return this.deps.box();
    } catch {
      throw new AccountsError(
        "not_configured",
        "Installation has no master key — run `bun run setup` first",
        503,
      );
    }
  }

  private parseProvider(v: unknown): BrokerProvider {
    if (v === "alpaca" || v === "binance_usdm") return v;
    throw new AccountsError("validation", "provider must be 'alpaca' or 'binance_usdm'", 400);
  }

  private parseEnvironment(provider: BrokerProvider, v: unknown): BrokerEnvironment {
    const allowed = ENVS_BY_PROVIDER[provider];
    if (typeof v === "string" && (allowed as string[]).includes(v)) return v as BrokerEnvironment;
    throw new AccountsError(
      "validation",
      `environment for ${provider} must be one of: ${allowed.join(", ")}`,
      400,
    );
  }

  private parseLabel(v: unknown, fallback: string): string {
    const label = typeof v === "string" ? v.trim() : "";
    if (label.length > 64) throw new AccountsError("validation", "label too long (max 64)", 400);
    return label || fallback;
  }

  private parseSecretField(v: unknown, field: string): string {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new AccountsError("validation", `${field} is required`, 400);
    }
    return v.trim();
  }

  private async verifyWithProvider(
    provider: BrokerProvider,
    environment: BrokerEnvironment,
    creds: BrokerCredentials,
  ): Promise<VerificationResult> {
    if (provider === "alpaca") {
      return verifyAlpaca(creds, environment as AlpacaEnv, this.fetchFn);
    }
    if (creds.kind !== "api_key") {
      return { ok: false, error: "Binance accounts require API keys" };
    }
    return verifyBinanceUsdm(creds, environment as BinanceUsdmEnv, this.fetchFn, this.now);
  }

  private save(
    provider: BrokerProvider,
    environment: BrokerEnvironment,
    label: string,
    authType: "api_key" | "oauth",
    creds: BrokerCredentials,
    box: SecretBox,
    result: VerificationResult,
  ): AddAccountResult {
    const base = slugify(label, `${provider}-${environment}`);
    let id = base;
    for (let n = 2; this.repo.has(id); n++) id = `${base}-${n}`;
    const at = this.now();
    this.repo.insert({
      id,
      provider,
      label,
      environment,
      authType,
      credentialsEnc: box.seal(JSON.stringify(creds)),
      status: "verified",
      accountRef: result.accountRef ?? null,
      lastVerifiedAt: at,
      createdAt: at,
    });
    return { account: this.repo.get(id)!, warnings: result.warnings ?? [] };
  }
}
