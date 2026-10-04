// ═══ Binance USDⓈ-M provider adapter — signed read-only verification ═══
//
// GET /fapi/v2/account (HMAC-SHA256 signed, X-MBX-APIKEY header) against
// demo-fapi.binance.com (demo) or fapi.binance.com (live) — the same host
// semantics the executor's config uses (demo-fapi is the sandbox successor
// of testnet.binancefuture.com, see src/config/index.ts). Self-contained on
// purpose: the executor/transport stack is the TRADING path and this branch
// must not touch it.

import crypto from "crypto";
import type { VerificationResult } from "../types";

export type BinanceUsdmEnv = "demo" | "live";

export function binanceUsdmBase(env: BinanceUsdmEnv): string {
  return env === "live" ? "https://fapi.binance.com" : "https://demo-fapi.binance.com";
}

/** Standard Binance request signing: hex HMAC-SHA256 of the query string. */
export function signBinanceQuery(query: string, apiSecret: string): string {
  return crypto.createHmac("sha256", apiSecret).update(query).digest("hex");
}

/** Spot/SAPI host for the best-effort key-restrictions probe (live only —
 *  demo keys don't exist on the spot SAPI domain). */
const BINANCE_SAPI_BASE = "https://api.binance.com";

export async function verifyBinanceUsdm(
  creds: { apiKey: string; apiSecret: string },
  env: BinanceUsdmEnv,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<VerificationResult> {
  try {
    const qs = `recvWindow=10000&timestamp=${now()}`;
    const sig = signBinanceQuery(qs, creds.apiSecret);
    const res = await fetchFn(`${binanceUsdmBase(env)}/fapi/v2/account?${qs}&signature=${sig}`, {
      headers: { "X-MBX-APIKEY": creds.apiKey, Accept: "application/json" },
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = json && typeof json.msg === "string"
        ? ` code ${json.code}: ${json.msg}` : "";
      return { ok: false, error: `Binance rejected the credentials (HTTP ${res.status}${detail})` };
    }
    if (!json || typeof json !== "object") {
      return { ok: false, error: "Binance /fapi/v2/account returned an unreadable body" };
    }
    if (json.canTrade !== true) {
      return { ok: false, error: "This API key cannot trade USDⓈ-M futures (canTrade=false) — enable futures on the key" };
    }
    const warnings: string[] = [];
    // Best-effort withdrawal-permission probe (live only: the restrictions
    // endpoint lives on the spot SAPI host, where demo keys don't exist).
    // Any failure is swallowed — this is a safety HINT, never a gate.
    if (env === "live") {
      try {
        const wq = `recvWindow=10000&timestamp=${now()}`;
        const wsig = signBinanceQuery(wq, creds.apiSecret);
        const wres = await fetchFn(`${BINANCE_SAPI_BASE}/sapi/v1/account/apiRestrictions?${wq}&signature=${wsig}`, {
          headers: { "X-MBX-APIKEY": creds.apiKey, Accept: "application/json" },
        });
        if (wres.ok) {
          const w: any = await wres.json().catch(() => null);
          if (w && w.enableWithdrawals === true) {
            warnings.push("This API key permits WITHDRAWALS — create a trade-only key instead");
          }
          if (w && w.ipRestrict === false) {
            warnings.push("This API key has no IP allowlist — consider restricting it to this server's IP");
          }
        }
      } catch { /* best-effort only */ }
    }
    // /fapi/v2/account carries no account number; nothing identifying-but-
    // non-secret to surface, so accountRef stays null for Binance.
    return { ok: true, accountRef: null, warnings };
  } catch (e: any) {
    return { ok: false, error: `Binance verification failed: ${e?.message ?? e}` };
  }
}
