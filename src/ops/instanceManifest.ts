// ══════════════════════════════════════════════════════════════════════════
// Instance manifest — effective config + broker-account fingerprints,
// materialized at startup.
//
// Born from three real incidents whose common root cause was that the
// EFFECTIVE configuration (defaults + .env + process.env, post-merge) never
// existed anywhere observable:
//   1. Two deployments shared broker credentials for months — nothing ever
//      printed "this process trades account X", so nobody saw two hosts
//      printing the same X.
//   2. A host env var leaked into a backtest (the 2026-08-02 TRADING_ENABLED
//      artifact) — the VALUE was visible in places, but its ORIGIN (shell
//      env, not .env, not default) never was.
//   3. A reused flag left BrokerSync inert — again the merged, effective
//      value was never published side by side with where it came from.
//
// Reference designs: Freqtrade's `show-config` (merged config, secrets
// redacted) and NautilusTrader's run identity `(seed, binary hash, config
// hash)`. This module is the same idea cut to this repo: ONE object with
// hostname/commit/port, every money-affecting flag's effective value AND
// origin, and a per-broker account fingerprint — logged at boot, served on
// /healthz/full (authenticated), persisted in sync_state.
//
// Account fingerprints and the swap guard:
//   - Alpaca reports an account id/number; Binance's /fapi/v2/account does
//     not, so its identity material is the API key. NEITHER is ever stored
//     or logged raw: everything is reduced to `kind:sha256(material)[0..12]`.
//     A leaked manifest therefore leaks 12 hex chars of a hash — useless for
//     auth, sufficient for "is this the same account as yesterday".
//   - A stored-vs-observed mismatch means THIS PROCESS IS POINTED AT A
//     DIFFERENT ACCOUNT than the one whose ledger lives in the DB. A silent
//     swap splices two accounts into one continuous equity series and
//     publishes fabricated profit (the 35-day incident class). Response:
//     page + audit row + persist RiskEngine HALTED — which blocks ONLY new
//     opens (SwitchingAdapter consults it before every open; closePosition
//     never does), so reconciliation, stops and closes keep running while a
//     human decides. Unblock = explicit BROKER_ACCOUNT_ROTATION_ACK=<fp>.
//   - FIRST boot (no stored fingerprint — prod's state today) is the start
//     of history, not a change: record and continue, never block.
//
// Pure core (resolveFlag / fingerprintIdentity / checkBrokerIdentity) + a
// thin shell (publishInstanceManifest) — same shape as RiskEngine.ts.
// ══════════════════════════════════════════════════════════════════════════

import { createHash } from "crypto";
import { hostname } from "os";
import { readFileSync } from "fs";
import dotenv from "dotenv";
import { createLogger } from "../utils/logger";
import { eventBus, EVENTS } from "../utils/events";
import { VERSION_INFO } from "../utils/version";
import { config } from "../config";
import { getSyncState, setSyncState, insertActivity } from "../db/database";
import { getDefaultRiskEngine } from "../risk/RiskEngine";

const log = createLogger("InstanceManifest");

// ── Flag resolution (value + ORIGIN) ───────────────────────────────────────

export type FlagSource = "default" | ".env" | "process.env";

export interface ManifestFlag {
  /** Effective value. For `presenceOnly` flags: "present" | "absent". */
  value: string;
  source: FlagSource;
}

interface FlagSpec {
  name: string;
  /** Effective value when the variable is unset (mirrors the reader's own default). */
  default: string;
  /** Report only set/unset, never the content (EXECUTION_POLICY_JSON). */
  presenceOnly?: boolean;
}

/**
 * Every flag that changes what the money does. Defaults mirror the actual
 * readers (isTradingEnabled, plausibilityMode, index.ts gates, config) —
 * they are documentation of the effective value, not a second decision point.
 */
export const MONEY_FLAGS: readonly FlagSpec[] = [
  { name: "TRADING_MODE", default: "paper" },
  { name: "TRADING_ENABLED", default: "true" },
  { name: "RISK_ENGINE_STATE", default: "unset" }, // unset ⇒ persisted state or ACTIVE (RiskEngine.effectiveState)
  { name: "PLAUSIBILITY_MODE", default: "observe" },
  { name: "MOMENTUM_USDC_ENABLED", default: "false" },
  { name: "MOMENTUM_COINM_ENABLED", default: "false" },
  { name: "MEANREV_ENABLED", default: "true" },
  { name: "EXECUTION_WS", default: "false" },
  { name: "ALPACA_PAPER", default: "true" },
  { name: "EXECUTION_POLICY_JSON", default: "absent", presenceOnly: true },
] as const;

/**
 * Effective value + origin of one flag. Origin logic: src/config runs
 * dotenv with `override:true`, so a key present in .env lands in
 * process.env with the .env value. If the current process.env value equals
 * what the .env FILE says, the origin is ".env"; a set value the file does
 * NOT explain came from the outer environment (shell export, systemd
 * Environment=, a leaked test toggle) — exactly the origin the 2026-08-02
 * incident needed to see. Unset = the reader's default applies.
 */
export function resolveFlag(
  spec: FlagSpec,
  env: Record<string, string | undefined>,
  dotenvValues: Record<string, string>,
): ManifestFlag {
  const raw = env[spec.name];
  if (raw === undefined) return { value: spec.default, source: "default" };
  const source: FlagSource = dotenvValues[spec.name] === raw ? ".env" : "process.env";
  return { value: spec.presenceOnly ? "present" : raw, source };
}

/** Parsed .env FILE (not process.env). Fail-soft: unreadable/missing = {}. */
export function readDotenvFile(path = ".env"): Record<string, string> {
  try {
    return dotenv.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// ── Account fingerprints ───────────────────────────────────────────────────

/**
 * `kind:sha256(material)[0..12]` — stable for the same material, and by
 * construction the manifest/log/DB only ever see 12 hex chars of a one-way
 * hash, NEVER the material (an account id, or worse an API key). Returns
 * null for empty material so callers skip the broker instead of
 * fingerprinting "".
 */
export function fingerprintIdentity(kind: "acct" | "key", material: string | null | undefined): string | null {
  const m = (material ?? "").trim();
  if (m === "") return null;
  return `${kind}:${createHash("sha256").update(m).digest("hex").slice(0, 12)}`;
}

export const BROKER_IDS = ["alpaca", "binance_fapi", "binance_dapi"] as const;
export type BrokerId = (typeof BROKER_IDS)[number];

export const identitySyncKey = (broker: BrokerId): string => `broker_identity:${broker}`;

export const IDENTITY_HALT_REASON_PREFIX = "broker_identity_changed:";
const PAGE_CONTEXT = "InstanceManifest";

export type IdentityStatus = "first_boot" | "match" | "changed" | "acknowledged" | "unavailable";

export interface IdentityCheckResult {
  broker: BrokerId;
  /** Fingerprint observed this boot (null = couldn't observe). */
  observed: string | null;
  /** Fingerprint stored from a previous boot (null = none). */
  stored: string | null;
  status: IdentityStatus;
}

/** BROKER_ACCOUNT_ROTATION_ACK accepts one or several fingerprints (comma/space separated). */
export function parseRotationAck(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(s => s !== ""),
  );
}

/** Pure decision: what does this boot's observation mean for this broker? */
export function checkBrokerIdentity(
  broker: BrokerId,
  observed: string | null,
  stored: string | null,
  ack: Set<string>,
): IdentityCheckResult {
  // Couldn't observe (broker down, no keys configured): NOT a change — a
  // dead broker must never trip the swap guard, and stored stays untouched.
  if (observed === null) return { broker, observed, stored, status: "unavailable" };
  if (stored === null) return { broker, observed, stored, status: "first_boot" };
  if (stored === observed) return { broker, observed, stored, status: "match" };
  if (ack.has(observed)) return { broker, observed, stored, status: "acknowledged" };
  return { broker, observed, stored, status: "changed" };
}

// ── Side-effect application (injectable for tests, real defaults) ─────────

export interface IdentityDeps {
  getStored: (key: string) => string | null;
  setStored: (key: string, value: string) => void;
  insertActivity: (accountId: string | null, eventType: string, message: string) => void;
  emitPage: (message: string) => void;
  riskEngine: {
    getState(): { tradingState: string; reason: string };
    setTradingState(next: "ACTIVE" | "HALTED" | "REDUCING", reason: string): void;
  };
  /** BROKER_ACCOUNT_ROTATION_ACK raw value. */
  ack: string | undefined;
}

function defaultIdentityDeps(): IdentityDeps {
  return {
    getStored: getSyncState,
    setStored: setSyncState,
    insertActivity,
    emitPage: (message: string) => {
      const now = Date.now();
      eventBus.emit(EVENTS.ERROR_BURST, { context: PAGE_CONTEXT, message, count: 1, windowMs: 0, firstAt: now, lastAt: now });
    },
    riskEngine: getDefaultRiskEngine(),
    ack: process.env.BROKER_ACCOUNT_ROTATION_ACK,
  };
}

/**
 * Run the swap guard for every observed broker and apply the response:
 *
 *   first_boot    → store fingerprint, audit row, NO block (prod today has
 *                   no stored fingerprints — this boot is the start of
 *                   history, and blocking a healthy 5-sleeve live system on
 *                   deploy would be the bug).
 *   match         → nothing.
 *   changed       → LOUD: error log + activity row + ops page + persist
 *                   RiskEngine HALTED (blocks only NEW opens; closes,
 *                   stops, BrokerSync reconciliation keep running — the
 *                   poisoned-ledger risk is new entries booked against the
 *                   wrong account's history, not exits). Stored fingerprint
 *                   is NOT overwritten, so every restart re-detects until a
 *                   human acks. Reuses the EXISTING RiskEngine kill-switch
 *                   (persisted in sync_state, surfaced on /healthz/full)
 *                   instead of inventing a new one; TRADING_ENABLED was the
 *                   other candidate but is env-only — a process can't
 *                   persist it across the next restart, and the operator
 *                   couldn't distinguish "maintenance" from "wrong account".
 *   acknowledged  → operator set BROKER_ACCOUNT_ROTATION_ACK=<observed fp>:
 *                   adopt the new fingerprint, audit row + ops page (a
 *                   rotation is still a notable event), and lift OUR halt.
 *
 * The halt is lifted ONLY when (a) the persisted reason carries our prefix
 * (never clobbers an operator's manual HALTED) and (b) every broker with a
 * stored fingerprint was positively verified this run (match/acknowledged/
 * first_boot) — an unobservable broker keeps the halt in place.
 */
export function runBrokerIdentityChecks(
  observations: Record<BrokerId, string | null>,
  deps: IdentityDeps = defaultIdentityDeps(),
): IdentityCheckResult[] {
  const ack = parseRotationAck(deps.ack);
  const results: IdentityCheckResult[] = [];

  for (const broker of BROKER_IDS) {
    const observed = observations[broker] ?? null;
    let stored: string | null = null;
    try {
      stored = deps.getStored(identitySyncKey(broker));
    } catch (e: any) {
      log.warn(`stored fingerprint read failed for ${broker}: ${e?.message ?? e}`);
    }
    const r = checkBrokerIdentity(broker, observed, stored, ack);
    results.push(r);

    switch (r.status) {
      case "first_boot": {
        deps.setStored(identitySyncKey(broker), r.observed!);
        const msg = `broker identity recorded (first boot): ${broker} ${r.observed}`;
        log.info(`🪪 ${msg}`);
        deps.insertActivity(null, "system", msg);
        break;
      }
      case "acknowledged": {
        deps.setStored(identitySyncKey(broker), r.observed!);
        const msg = `broker account rotation ACKNOWLEDGED: ${broker} ${r.stored} → ${r.observed} (BROKER_ACCOUNT_ROTATION_ACK) — fingerprint adopted, remove the ACK var after this boot`;
        log.warn(`🪪 ${msg}`);
        deps.insertActivity(null, "circuit", msg);
        deps.emitPage(msg);
        break;
      }
      case "changed": {
        const msg =
          `${IDENTITY_HALT_REASON_PREFIX}${broker} observed=${r.observed} stored=${r.stored} — this process is pointed at a DIFFERENT ${broker} account ` +
          `than the one this DB's ledger belongs to. NEW OPENS BLOCKED (RiskEngine HALTED, persisted); closes/stops/reconciliation keep running. ` +
          `If the swap is intentional, set BROKER_ACCOUNT_ROTATION_ACK=${r.observed} and restart.`;
        log.error(`🚨 ${msg}`);
        deps.insertActivity(null, "circuit", msg);
        deps.emitPage(msg);
        deps.riskEngine.setTradingState("HALTED", msg);
        break;
      }
      case "unavailable": {
        if (r.stored !== null) log.warn(`🪪 broker identity UNVERIFIABLE this boot: ${broker} (stored ${r.stored}, nothing observed)`);
        break;
      }
      case "match":
        break;
    }
  }

  // Lift OUR halt once everything checks out again (see docstring).
  const anyChanged = results.some(r => r.status === "changed");
  const allStoredVerified = results.every(
    r => r.stored === null || r.status === "match" || r.status === "acknowledged" || r.status === "first_boot",
  );
  if (!anyChanged && allStoredVerified) {
    try {
      const st = deps.riskEngine.getState();
      if (st.tradingState === "HALTED" && st.reason.startsWith(IDENTITY_HALT_REASON_PREFIX)) {
        const msg = "broker identities verified/acknowledged — lifting the identity HALT (RiskEngine → ACTIVE)";
        log.warn(`🪪 ${msg}`);
        deps.insertActivity(null, "circuit", msg);
        deps.riskEngine.setTradingState("ACTIVE", msg);
      }
    } catch (e: any) {
      log.warn(`identity-halt lift check failed: ${e?.message ?? e}`);
    }
  }

  return results;
}

// ── Manifest assembly + publication ────────────────────────────────────────

export interface InstanceManifest {
  hostname: string;
  commit: string;
  dirty: boolean | null;
  started_at: string;
  dashboard_port: number;
  flags: Record<string, ManifestFlag>;
  broker_identities: Partial<Record<BrokerId, { fingerprint: string | null; status: IdentityStatus }>>;
}

/** Static (flags/host/commit) part of the manifest. Pure given env + .env contents. */
export function buildManifestBase(
  env: Record<string, string | undefined> = process.env,
  dotenvValues: Record<string, string> = readDotenvFile(),
  opts: { hostname?: string; port?: number } = {},
): InstanceManifest {
  const flags: Record<string, ManifestFlag> = {};
  for (const spec of MONEY_FLAGS) flags[spec.name] = resolveFlag(spec, env, dotenvValues);
  return {
    hostname: opts.hostname ?? hostname(),
    commit: VERSION_INFO.commit,
    dirty: VERSION_INFO.dirty,
    started_at: new Date(VERSION_INFO.startedAt).toISOString(),
    dashboard_port: opts.port ?? config.dashboard.port,
    flags,
    broker_identities: {},
  };
}

/**
 * Binance identity material — the API key each executor would use, with the
 * SAME fallback chains the executors implement (BinanceExecutor:
 * FUTURES→legacy; BinanceCoinMExecutor: COINM→FUTURES). Only ever hashed.
 */
export function binanceIdentityObservations(env: Record<string, string | undefined> = process.env): {
  binance_fapi: string | null;
  binance_dapi: string | null;
} {
  return {
    binance_fapi: fingerprintIdentity("key", env.BINANCE_FUTURES_API_KEY || env.BINANCE_API_KEY),
    binance_dapi: fingerprintIdentity("key", env.BINANCE_COINM_API_KEY || env.BINANCE_FUTURES_API_KEY),
  };
}

// Published once per process; /healthz/full serves this snapshot.
let published: InstanceManifest | null = null;

/** The manifest published at startup (null until publishInstanceManifest ran). */
export function getPublishedManifest(): InstanceManifest | null {
  return published;
}

/** Test-only. */
export function _resetPublishedManifestForTests(): void {
  published = null;
}

export interface PublishOptions {
  /** Alpaca account identity (account_number/id), read from the ALREADY
   *  CONNECTED executor — this module never builds a broker client. */
  getAlpacaAccountId?: () => Promise<string | null>;
  env?: Record<string, string | undefined>;
  dotenvValues?: Record<string, string>;
  identityDeps?: IdentityDeps;
  hostname?: string;
  port?: number;
}

/**
 * Build the manifest, run the account-swap guard, log the whole thing
 * (fingerprints only — never keys, never secrets), and keep it for
 * /healthz/full. Failures here must never abort startup: the caller wraps
 * this in try/catch, and every internal read is fail-soft.
 */
export async function publishInstanceManifest(opts: PublishOptions = {}): Promise<InstanceManifest> {
  const env = opts.env ?? process.env;
  const manifest = buildManifestBase(env, opts.dotenvValues ?? readDotenvFile(), { hostname: opts.hostname, port: opts.port });

  let alpacaId: string | null = null;
  if (opts.getAlpacaAccountId) {
    try {
      alpacaId = await opts.getAlpacaAccountId();
    } catch (e: any) {
      log.warn(`alpaca account identity read failed: ${e?.message ?? e}`);
    }
  }

  const binance = binanceIdentityObservations(env);
  const observations: Record<BrokerId, string | null> = {
    alpaca: fingerprintIdentity("acct", alpacaId),
    binance_fapi: binance.binance_fapi,
    binance_dapi: binance.binance_dapi,
  };

  const results = runBrokerIdentityChecks(observations, opts.identityDeps);
  for (const r of results) {
    manifest.broker_identities[r.broker] = { fingerprint: r.observed ?? r.stored, status: r.status };
  }

  published = manifest;
  log.info(`📋 Instance manifest: ${JSON.stringify(manifest)}`);
  return manifest;
}
