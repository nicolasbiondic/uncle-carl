// ══════════════════════════════════════════════════════════════════════════
// instanceManifest — effective-config manifest + broker-account swap guard.
//
// Every protection here was verified by REVERTING it (break the code, watch
// the test fail, restore):
//   - fingerprint stability/distinctness → change the hash input/truncation.
//   - swap detected ⇒ opens blocked + page → drop the setTradingState call
//     or the emitPage call in runBrokerIdentityChecks.
//   - first boot never blocks → make first_boot fall through to "changed".
//   - ACK unblocks only the right fingerprint → accept any ACK value.
//   - no key/secret in manifest or messages → put raw material in the
//     fingerprint or the halt reason.
// ══════════════════════════════════════════════════════════════════════════

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb } from "../test-support/db";
import { captureBursts } from "../test-support/events";
import { getSyncState, setSyncState, getActivityLog } from "../db/database";
import { getDefaultRiskEngine, _resetDefaultRiskEngineForTests } from "../risk/RiskEngine";
import {
  fingerprintIdentity,
  resolveFlag,
  buildManifestBase,
  binanceIdentityObservations,
  publishInstanceManifest,
  getPublishedManifest,
  _resetPublishedManifestForTests,
  identitySyncKey,
  IDENTITY_HALT_REASON_PREFIX,
  MONEY_FLAGS,
  parseRotationAck,
  checkBrokerIdentity,
} from "./instanceManifest";

// Deliberately loud, unmistakable fake material — if ANY of these strings
// ever shows up in a manifest, page message, activity row or halt reason,
// the no-secrets tests below must fail.
const FAKE = {
  alpacaAccountId: "PA9TESTACCT77",
  alpacaKey: "SECRET_ALPACA_KEY_PKX999",
  alpacaSecret: "SECRET_ALPACA_SECRET_zzz888",
  fapiKey: "SECRET_BINANCE_FAPI_KEY_abc123",
  fapiSecret: "SECRET_BINANCE_FAPI_SECRET_def456",
  coinmKey: "SECRET_BINANCE_COINM_KEY_ghi789",
  policyJson: '{"momentum_stocks":{"type":"marketable_limit","offsetBps":5}}',
};

const openOrder = { sleeve: "momentum_stocks", symbol: "AAPL", side: "buy" as const, notionalUsd: 100 };

const SAVED_ENV_KEYS = ["RISK_ENGINE_STATE", "BROKER_ACCOUNT_ROTATION_ACK"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  makeTestDb();
  _resetDefaultRiskEngineForTests();
  _resetPublishedManifestForTests();
  savedEnv = {};
  for (const k of SAVED_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetDefaultRiskEngineForTests();
  _resetPublishedManifestForTests();
});

// ── Fingerprints ───────────────────────────────────────────────────────────

describe("fingerprintIdentity", () => {
  test("same material ⇒ same fingerprint; different material ⇒ different fingerprint", () => {
    const a1 = fingerprintIdentity("key", FAKE.fapiKey);
    const a2 = fingerprintIdentity("key", FAKE.fapiKey);
    const b = fingerprintIdentity("key", FAKE.coinmKey);
    expect(a1).toBe(a2!);
    expect(a1).not.toBe(b!);
    expect(a1).toMatch(/^key:[0-9a-f]{12}$/);
  });

  test("the fingerprint NEVER contains the material (truncated one-way hash only)", () => {
    for (const material of [FAKE.fapiKey, FAKE.alpacaAccountId, "short"]) {
      const fp = fingerprintIdentity("key", material)!;
      expect(fp).not.toContain(material);
      // and no prefix of the material beyond coincidence either — the hash
      // part must be pure hex of length 12, not derived-visible text.
      expect(fp.split(":")[1]).toHaveLength(12);
    }
  });

  test("empty/undefined material ⇒ null (skip the broker, never fingerprint '')", () => {
    expect(fingerprintIdentity("key", "")).toBeNull();
    expect(fingerprintIdentity("key", "   ")).toBeNull();
    expect(fingerprintIdentity("acct", undefined)).toBeNull();
    expect(fingerprintIdentity("acct", null)).toBeNull();
  });
});

// ── Flag origin resolution ─────────────────────────────────────────────────

describe("resolveFlag — effective value AND origin", () => {
  const spec = { name: "TRADING_ENABLED", default: "true" };

  test("unset ⇒ default value, source 'default'", () => {
    expect(resolveFlag(spec, {}, {})).toEqual({ value: "true", source: "default" });
  });

  test("set via .env (dotenv override copies it into process.env) ⇒ source '.env'", () => {
    expect(resolveFlag(spec, { TRADING_ENABLED: "false" }, { TRADING_ENABLED: "false" }))
      .toEqual({ value: "false", source: ".env" });
  });

  test("set in the environment but NOT explained by the .env file ⇒ source 'process.env' — the leaked-env incident's missing signal", () => {
    // 2026-08-02 class: a shell/systemd/test-leaked variable. The .env file
    // doesn't have it (or has a DIFFERENT value) — origin must say so.
    expect(resolveFlag(spec, { TRADING_ENABLED: "false" }, {}))
      .toEqual({ value: "false", source: "process.env" });
    expect(resolveFlag(spec, { TRADING_ENABLED: "false" }, { TRADING_ENABLED: "true" }))
      .toEqual({ value: "false", source: "process.env" });
  });

  test("presenceOnly flags report present/absent, never their content", () => {
    const pspec = { name: "EXECUTION_POLICY_JSON", default: "absent", presenceOnly: true };
    const r = resolveFlag(pspec, { EXECUTION_POLICY_JSON: FAKE.policyJson }, {});
    expect(r.value).toBe("present");
    expect(JSON.stringify(r)).not.toContain("marketable_limit");
    expect(resolveFlag(pspec, {}, {})).toEqual({ value: "absent", source: "default" });
  });
});

describe("buildManifestBase", () => {
  test("covers every money flag and carries host/commit/port identity", () => {
    const m = buildManifestBase({ MEANREV_ENABLED: "false" }, {}, { hostname: "testhost", port: 3799 });
    expect(m.hostname).toBe("testhost");
    expect(m.dashboard_port).toBe(3799);
    expect(typeof m.commit).toBe("string");
    expect(m.commit.length).toBeGreaterThan(0);
    for (const spec of MONEY_FLAGS) expect(m.flags[spec.name]).toBeDefined();
    expect(m.flags.MEANREV_ENABLED).toEqual({ value: "false", source: "process.env" });
    expect(m.flags.TRADING_ENABLED).toEqual({ value: "true", source: "default" });
  });
});

// ── Pure decision table ────────────────────────────────────────────────────

describe("checkBrokerIdentity decision table", () => {
  const fp = fingerprintIdentity("key", FAKE.fapiKey)!;
  const other = fingerprintIdentity("key", FAKE.coinmKey)!;

  test("unobserved ⇒ unavailable (a dead broker is NOT an account swap)", () => {
    expect(checkBrokerIdentity("binance_fapi", null, fp, new Set()).status).toBe("unavailable");
  });
  test("no stored ⇒ first_boot", () => {
    expect(checkBrokerIdentity("binance_fapi", fp, null, new Set()).status).toBe("first_boot");
  });
  test("stored === observed ⇒ match", () => {
    expect(checkBrokerIdentity("binance_fapi", fp, fp, new Set()).status).toBe("match");
  });
  test("stored ≠ observed without ACK ⇒ changed; ACK for the OBSERVED fp ⇒ acknowledged; ACK for a different fp does nothing", () => {
    expect(checkBrokerIdentity("binance_fapi", fp, other, new Set()).status).toBe("changed");
    expect(checkBrokerIdentity("binance_fapi", fp, other, new Set([fp])).status).toBe("acknowledged");
    expect(checkBrokerIdentity("binance_fapi", fp, other, new Set([other])).status).toBe("changed");
  });
  test("parseRotationAck accepts comma/space separated fingerprints", () => {
    expect(parseRotationAck(`${fp}, ${other}`)).toEqual(new Set([fp, other]));
    expect(parseRotationAck(undefined).size).toBe(0);
  });
});

// ── First boot (prod's state TODAY) ────────────────────────────────────────

describe("first boot — no stored fingerprints (exactly prod's next deploy)", () => {
  test("records every identity, does NOT halt, does NOT page — opens stay allowed", async () => {
    const cap = captureBursts("InstanceManifest");
    try {
      const m = await publishInstanceManifest({
        env: { BINANCE_FUTURES_API_KEY: FAKE.fapiKey, BINANCE_COINM_API_KEY: FAKE.coinmKey },
        dotenvValues: {},
        getAlpacaAccountId: async () => FAKE.alpacaAccountId,
        hostname: "testhost",
      });
      expect(m.broker_identities.alpaca!.status).toBe("first_boot");
      expect(m.broker_identities.binance_fapi!.status).toBe("first_boot");
      expect(m.broker_identities.binance_dapi!.status).toBe("first_boot");
      // fingerprints persisted for the NEXT boot's comparison
      expect(getSyncState(identitySyncKey("alpaca"))).toBe(fingerprintIdentity("acct", FAKE.alpacaAccountId)!);
      expect(getSyncState(identitySyncKey("binance_fapi"))).toBe(fingerprintIdentity("key", FAKE.fapiKey)!);
      // the whole point: prod's first boot with this code must keep trading
      expect(getDefaultRiskEngine().getState().tradingState).toBe("ACTIVE");
      expect(getDefaultRiskEngine().evaluateSubmit(openOrder).allow).toBe(true);
      expect(cap.bursts.length).toBe(0);
      expect(getPublishedManifest()).toBe(m);
    } finally {
      cap.detach();
    }
  });

  test("unobservable brokers (no keys, alpaca down) are 'unavailable' — still no halt, nothing stored", async () => {
    const m = await publishInstanceManifest({ env: {}, dotenvValues: {}, hostname: "testhost" });
    expect(m.broker_identities.alpaca!.status).toBe("unavailable");
    expect(m.broker_identities.binance_fapi!.status).toBe("unavailable");
    expect(getSyncState(identitySyncKey("alpaca"))).toBeNull();
    expect(getDefaultRiskEngine().getState().tradingState).toBe("ACTIVE");
  });
});

// ── Account swap detection ─────────────────────────────────────────────────

describe("account swap — stored fingerprint differs from observed", () => {
  test("HALTS new opens (persisted), pages ops, writes an audit row, and does NOT adopt the new fingerprint", async () => {
    const oldFp = fingerprintIdentity("key", "the-old-rotated-away-key")!;
    setSyncState(identitySyncKey("binance_fapi"), oldFp);
    const cap = captureBursts("InstanceManifest");
    try {
      const m = await publishInstanceManifest({
        env: { BINANCE_FUTURES_API_KEY: FAKE.fapiKey },
        dotenvValues: {},
        hostname: "testhost",
      });
      expect(m.broker_identities.binance_fapi!.status).toBe("changed");

      // 1. blocks opens through the SAME RiskEngine SwitchingAdapter consults
      const st = getDefaultRiskEngine().getState();
      expect(st.tradingState).toBe("HALTED");
      expect(st.reason.startsWith(IDENTITY_HALT_REASON_PREFIX)).toBe(true);
      const decision = getDefaultRiskEngine().evaluateSubmit(openOrder);
      expect(decision.allow).toBe(false);
      if (!decision.allow) expect(decision.code).toBe("TRADING_STATE_HALTED");
      // persisted — survives a restart (fresh instance reads sync_state)
      expect(getSyncState("risk_engine:trading_state")!).toContain("HALTED");

      // 2. pages (ERROR_BURST → TelegramReporter ops chat) and audits
      expect(cap.bursts.length).toBeGreaterThanOrEqual(1);
      expect(cap.bursts.map(b => String(b.message)).join("\n")).toContain("binance_fapi");
      const circuits = getActivityLog(50, "circuit").map((r: any) => r.message).join("\n");
      expect(circuits).toContain("binance_fapi");

      // 3. stored fingerprint NOT overwritten — every restart re-detects
      expect(getSyncState(identitySyncKey("binance_fapi"))).toBe(oldFp);
    } finally {
      cap.detach();
    }
  });

  test("a wrong ACK fingerprint does NOT unblock", async () => {
    setSyncState(identitySyncKey("binance_fapi"), fingerprintIdentity("key", "old-key")!);
    process.env.BROKER_ACCOUNT_ROTATION_ACK = fingerprintIdentity("key", "some-unrelated-key")!;
    const cap = captureBursts("InstanceManifest");
    try {
      const m = await publishInstanceManifest({ env: { BINANCE_FUTURES_API_KEY: FAKE.fapiKey }, dotenvValues: {}, hostname: "testhost" });
      expect(m.broker_identities.binance_fapi!.status).toBe("changed");
      expect(getDefaultRiskEngine().getState().tradingState).toBe("HALTED");
    } finally {
      cap.detach();
    }
  });
});

// ── Acknowledged rotation ──────────────────────────────────────────────────

describe("BROKER_ACCOUNT_ROTATION_ACK — explicit human acknowledgement", () => {
  test("the CORRECT fingerprint adopts the new identity and lifts the identity halt", async () => {
    const oldFp = fingerprintIdentity("key", "old-key")!;
    const newFp = fingerprintIdentity("key", FAKE.fapiKey)!;
    setSyncState(identitySyncKey("binance_fapi"), oldFp);
    // previous boot detected the swap and halted:
    getDefaultRiskEngine().setTradingState("HALTED", `${IDENTITY_HALT_REASON_PREFIX}binance_fapi observed=${newFp} stored=${oldFp}`);
    process.env.BROKER_ACCOUNT_ROTATION_ACK = newFp;

    const cap = captureBursts("InstanceManifest");
    try {
      const m = await publishInstanceManifest({ env: { BINANCE_FUTURES_API_KEY: FAKE.fapiKey }, dotenvValues: {}, hostname: "testhost" });
      expect(m.broker_identities.binance_fapi!.status).toBe("acknowledged");
      expect(getSyncState(identitySyncKey("binance_fapi"))).toBe(newFp); // adopted
      expect(getDefaultRiskEngine().getState().tradingState).toBe("ACTIVE"); // unblocked
      expect(getDefaultRiskEngine().evaluateSubmit(openOrder).allow).toBe(true);
      // a rotation is still a notable, audited event
      expect(cap.bursts.length).toBeGreaterThanOrEqual(1);
    } finally {
      cap.detach();
    }
  });

  test("lifting NEVER clobbers an operator's manual HALT (only identity-prefixed reasons)", async () => {
    const fp = fingerprintIdentity("key", FAKE.fapiKey)!;
    setSyncState(identitySyncKey("binance_fapi"), fp); // identity matches
    getDefaultRiskEngine().setTradingState("HALTED", "manual maintenance — operator decision");
    await publishInstanceManifest({ env: { BINANCE_FUTURES_API_KEY: FAKE.fapiKey }, dotenvValues: {}, hostname: "testhost" });
    const st = getDefaultRiskEngine().getState();
    expect(st.tradingState).toBe("HALTED");
    expect(st.reason).toContain("manual maintenance");
  });

  test("an identity halt is NOT lifted while a broker with a stored fingerprint is unverifiable", async () => {
    // alpaca swapped last boot (halt persisted); this boot alpaca is down
    // and only binance is observable — the halt must stay.
    setSyncState(identitySyncKey("alpaca"), fingerprintIdentity("acct", "old-account")!);
    setSyncState(identitySyncKey("binance_fapi"), fingerprintIdentity("key", FAKE.fapiKey)!);
    getDefaultRiskEngine().setTradingState("HALTED", `${IDENTITY_HALT_REASON_PREFIX}alpaca observed=x stored=y`);
    const m = await publishInstanceManifest({ env: { BINANCE_FUTURES_API_KEY: FAKE.fapiKey }, dotenvValues: {}, hostname: "testhost" });
    expect(m.broker_identities.alpaca!.status).toBe("unavailable");
    expect(m.broker_identities.binance_fapi!.status).toBe("match");
    expect(getDefaultRiskEngine().getState().tradingState).toBe("HALTED");
  });

  test("a clean boot after acknowledgement is a plain match with no side effects", async () => {
    const fp = fingerprintIdentity("key", FAKE.fapiKey)!;
    setSyncState(identitySyncKey("binance_fapi"), fp);
    const cap = captureBursts("InstanceManifest");
    try {
      const m = await publishInstanceManifest({ env: { BINANCE_FUTURES_API_KEY: FAKE.fapiKey }, dotenvValues: {}, hostname: "testhost" });
      expect(m.broker_identities.binance_fapi!.status).toBe("match");
      expect(getDefaultRiskEngine().getState().tradingState).toBe("ACTIVE");
      expect(cap.bursts.length).toBe(0);
    } finally {
      cap.detach();
    }
  });
});

// ── No secrets, ever ───────────────────────────────────────────────────────

describe("secret redaction — no key, secret, or raw account id anywhere observable", () => {
  test("manifest JSON, page messages, audit rows and the halt reason are all clean", async () => {
    // force the LOUDEST path (a detected swap) with every credential set —
    // if raw material can leak anywhere, it's here.
    setSyncState(identitySyncKey("binance_fapi"), fingerprintIdentity("key", "old-key")!);
    const cap = captureBursts("InstanceManifest");
    try {
      const m = await publishInstanceManifest({
        env: {
          ALPACA_API_KEY: FAKE.alpacaKey,
          ALPACA_SECRET_KEY: FAKE.alpacaSecret,
          BINANCE_FUTURES_API_KEY: FAKE.fapiKey,
          BINANCE_FUTURES_SECRET_KEY: FAKE.fapiSecret,
          BINANCE_COINM_API_KEY: FAKE.coinmKey,
          EXECUTION_POLICY_JSON: FAKE.policyJson,
          TRADING_ENABLED: "false",
        },
        dotenvValues: {},
        getAlpacaAccountId: async () => FAKE.alpacaAccountId,
        hostname: "testhost",
      });

      const observable = [
        JSON.stringify(m), // exactly what index.ts logs and /healthz/full serves
        cap.bursts.map(b => String(b.message)).join("\n"),
        getActivityLog(100).map((r: any) => r.message).join("\n"),
        getDefaultRiskEngine().getState().reason,
        getSyncState("risk_engine:trading_state") ?? "",
        ...(["alpaca", "binance_fapi", "binance_dapi"] as const).map(b => getSyncState(identitySyncKey(b)) ?? ""),
      ].join("\n═\n");

      for (const material of Object.values(FAKE)) {
        expect(observable.includes(material)).toBe(false); // a FAKE.* value leaked if this fires
      }
      // and EXECUTION_POLICY_JSON is presence-only
      expect(m.flags.EXECUTION_POLICY_JSON.value).toBe("present");
      // while the fingerprints themselves ARE there (the manifest is useful)
      expect(JSON.stringify(m)).toContain(fingerprintIdentity("key", FAKE.fapiKey)!);
      expect(JSON.stringify(m)).toContain(fingerprintIdentity("acct", FAKE.alpacaAccountId)!);
    } finally {
      cap.detach();
    }
  });
});

// ── Binance observation fallback chains (must mirror the executors) ───────

describe("binanceIdentityObservations — same fallback chains as the executors", () => {
  test("fapi: FUTURES key first, legacy BINANCE_API_KEY fallback; dapi: COINM first, FUTURES fallback", () => {
    const legacy = binanceIdentityObservations({ BINANCE_API_KEY: "legacy-key" });
    expect(legacy.binance_fapi).toBe(fingerprintIdentity("key", "legacy-key")!);
    expect(legacy.binance_dapi).toBeNull(); // COIN-M executor has NO legacy fallback

    const both = binanceIdentityObservations({ BINANCE_FUTURES_API_KEY: FAKE.fapiKey, BINANCE_COINM_API_KEY: FAKE.coinmKey });
    expect(both.binance_fapi).toBe(fingerprintIdentity("key", FAKE.fapiKey)!);
    expect(both.binance_dapi).toBe(fingerprintIdentity("key", FAKE.coinmKey)!);

    const shared = binanceIdentityObservations({ BINANCE_FUTURES_API_KEY: FAKE.fapiKey });
    expect(shared.binance_dapi).toBe(fingerprintIdentity("key", FAKE.fapiKey)!);
  });
});
