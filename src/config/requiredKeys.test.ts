import { describe, expect, test } from "bun:test";
import { missingRequiredKeys, assertRequiredConfig } from "./index";

// AUDIT HOLE 3 (2026-08-09): AGENTS.md claimed "minimum required keys are
// enforced at startup by src/config/index.ts" while every key silently fell
// back to "" — a typo'd key booted a broker-less zombie that logged
// "DEGRADED START" and kept running. These tests pin the enforcement that
// makes the claim true. Every test passes an EXPLICIT env object: the
// functions must never make tests depend on the real .env.

const FULL_ENV = {
  ALPACA_API_KEY: "PKREAL123",
  ALPACA_SECRET_KEY: "supersecret",
  BINANCE_FUTURES_API_KEY: "fapikey",
  BINANCE_FUTURES_SECRET_KEY: "fapisecret",
};

describe("missingRequiredKeys", () => {
  test("prod-shaped env (Alpaca + FAPI keys, optional sleeves off) → nothing missing", () => {
    expect(missingRequiredKeys(FULL_ENV)).toEqual([]);
  });

  test("empty env → all four always-required credentials reported at once", () => {
    expect(missingRequiredKeys({})).toEqual([
      "ALPACA_API_KEY",
      "ALPACA_SECRET_KEY",
      "BINANCE_FUTURES_API_KEY",
      "BINANCE_FUTURES_SECRET_KEY",
    ]);
  });

  test(".env.example 'your_*' placeholders and whitespace count as MISSING", () => {
    expect(missingRequiredKeys({
      ...FULL_ENV,
      ALPACA_API_KEY: "your_alpaca_key",
      BINANCE_FUTURES_SECRET_KEY: "   ",
    })).toEqual(["ALPACA_API_KEY", "BINANCE_FUTURES_SECRET_KEY"]);
  });

  test("legacy BINANCE_API_KEY/BINANCE_SECRET_KEY satisfy the FAPI requirement (matches BinanceExecutor's per-field fallback)", () => {
    expect(missingRequiredKeys({
      ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s",
      BINANCE_API_KEY: "legacyk", BINANCE_SECRET_KEY: "legacys",
    })).toEqual([]);
  });

  test("COIN-M keys are NOT required while MOMENTUM_COINM_ENABLED is off", () => {
    expect(missingRequiredKeys({ ...FULL_ENV, MOMENTUM_COINM_ENABLED: "false" })).toEqual([]);
    expect(missingRequiredKeys(FULL_ENV)).toEqual([]); // unset flag = off
  });

  test("MOMENTUM_COINM_ENABLED=true is satisfied by the FAPI keys (DEFAULT_COINM_CONFIG falls back to them)", () => {
    expect(missingRequiredKeys({ ...FULL_ENV, MOMENTUM_COINM_ENABLED: "true" })).toEqual([]);
  });

  test("MOMENTUM_COINM_ENABLED=true with NEITHER key pair reports the COIN-M pair", () => {
    expect(missingRequiredKeys({
      ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s",
      BINANCE_API_KEY: "legacyk", BINANCE_SECRET_KEY: "legacys", // legacy pair does NOT feed COIN-M
      MOMENTUM_COINM_ENABLED: "true",
    })).toEqual([
      "BINANCE_COINM_API_KEY (or BINANCE_FUTURES_API_KEY)",
      "BINANCE_COINM_SECRET_KEY (or BINANCE_FUTURES_SECRET_KEY)",
    ]);
  });

  test("MOMENTUM_USDC_ENABLED needs no extra keys beyond the always-required FAPI pair", () => {
    expect(missingRequiredKeys({ ...FULL_ENV, MOMENTUM_USDC_ENABLED: "true" })).toEqual([]);
  });
});

// F4a (ACCOUNTS_SOURCE=registry): the Alpaca/Binance FAPI runtime
// credentials come from the broker-accounts registry, so the .env pairs
// stop being required — a brand-new installation with an empty .env must
// boot (F4b). COIN-M is NOT in the registry and keeps its requirement.
describe("missingRequiredKeys — accountsSource=registry", () => {
  test("empty env → nothing missing (registry supplies the runtime credentials)", () => {
    expect(missingRequiredKeys({}, "registry")).toEqual([]);
  });

  test("COIN-M keys are still demanded when the COIN-M sleeve is enabled (env-configured venue)", () => {
    expect(missingRequiredKeys({ MOMENTUM_COINM_ENABLED: "true" }, "registry")).toEqual([
      "BINANCE_COINM_API_KEY (or BINANCE_FUTURES_API_KEY)",
      "BINANCE_COINM_SECRET_KEY (or BINANCE_FUTURES_SECRET_KEY)",
    ]);
    expect(missingRequiredKeys({ MOMENTUM_COINM_ENABLED: "true", BINANCE_COINM_API_KEY: "ck", BINANCE_COINM_SECRET_KEY: "cs" }, "registry")).toEqual([]);
  });

  test("assertRequiredConfig in registry mode: no key demands, and the env-based live ceremony does not run (the registry resolver enforces its own)", () => {
    let markerReadCount = 0;
    const spyMarker = () => { markerReadCount++; return null; };
    // ALPACA_PAPER=false in the env would trip the env ceremony — but in
    // registry mode the env pair is not what the executors sign with.
    expect(() => assertRequiredConfig({ ALPACA_PAPER: "false" }, spyMarker, "registry")).not.toThrow();
    expect(markerReadCount).toBe(0);
  });

  test("default accountsSource stays 'env' — the existing contract is untouched", () => {
    expect(missingRequiredKeys({})).toEqual([
      "ALPACA_API_KEY",
      "ALPACA_SECRET_KEY",
      "BINANCE_FUTURES_API_KEY",
      "BINANCE_FUTURES_SECRET_KEY",
    ]);
  });
});

describe("assertRequiredConfig", () => {
  test("throws naming EVERY missing var (main()'s fatal handler exits 1 on this)", () => {
    expect(() => assertRequiredConfig({ ALPACA_API_KEY: "k" })).toThrow(/STARTUP REFUSED/);
    try {
      assertRequiredConfig({});
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain("ALPACA_API_KEY");
      expect(e.message).toContain("ALPACA_SECRET_KEY");
      expect(e.message).toContain("BINANCE_FUTURES_API_KEY");
      expect(e.message).toContain("BINANCE_FUTURES_SECRET_KEY");
    }
  });

  test("does not throw on a complete env", () => {
    expect(() => assertRequiredConfig(FULL_ENV)).not.toThrow();
  });
});

// AUDIT B1 (2026-09-20): ALPACA_PAPER=false was a 2-variable .env flip with
// zero ceremony. These pin the live-arming gate. All cases pass an explicit
// `readLiveArmMarker` stub — never the real filesystem.
describe("assertRequiredConfig — LIVE-arming ceremony (B1)", () => {
  const noMarker = () => null;

  test("ALPACA_PAPER=true (today) → byte-identical: no new requirement, marker never read", () => {
    let markerReadCount = 0;
    const spyMarker = () => { markerReadCount++; return null; };
    expect(() => assertRequiredConfig(FULL_ENV, spyMarker)).not.toThrow();
    expect(markerReadCount).toBe(0);
  });

  test("ALPACA_PAPER=false without TRADING_MODE=live → aborts naming the missing ceremony", () => {
    const env = { ...FULL_ENV, ALPACA_PAPER: "false", ALPACA_BASE_URL: "https://api.alpaca.markets" };
    expect(() => assertRequiredConfig(env, noMarker)).toThrow(/STARTUP REFUSED.*LIVE/s);
    try {
      assertRequiredConfig(env, noMarker);
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain("TRADING_MODE");
    }
  });

  test("ALPACA_PAPER=false + TRADING_MODE=live but no live-arm marker → aborts", () => {
    const env = {
      ...FULL_ENV, ALPACA_PAPER: "false", ALPACA_BASE_URL: "https://api.alpaca.markets",
      TRADING_MODE: "live", LIVE_ACCOUNT_ID: "acct-123", TELEGRAM_OPS_CHAT_ID: "-100999",
    };
    try {
      assertRequiredConfig(env, noMarker);
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain("data/.live-armed");
      expect(e.message).toContain("missing");
    }
  });

  test("live-arm marker content mismatching LIVE_ACCOUNT_ID → aborts", () => {
    const env = {
      ...FULL_ENV, ALPACA_PAPER: "false", ALPACA_BASE_URL: "https://api.alpaca.markets",
      TRADING_MODE: "live", LIVE_ACCOUNT_ID: "acct-123", TELEGRAM_OPS_CHAT_ID: "-100999",
    };
    try {
      assertRequiredConfig(env, () => "acct-DIFFERENT");
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain("does not match LIVE_ACCOUNT_ID");
    }
  });

  test("missing TELEGRAM_OPS_CHAT_ID → aborts even with TRADING_MODE=live + matching marker", () => {
    const env = {
      ...FULL_ENV, ALPACA_PAPER: "false", ALPACA_BASE_URL: "https://api.alpaca.markets",
      TRADING_MODE: "live", LIVE_ACCOUNT_ID: "acct-123", TELEGRAM_OPS_CHAT_ID: "",
    };
    try {
      assertRequiredConfig(env, () => "acct-123");
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain("TELEGRAM_OPS_CHAT_ID");
    }
  });

  test("all three requirements satisfied → passes", () => {
    const env = {
      ...FULL_ENV, ALPACA_PAPER: "false", ALPACA_BASE_URL: "https://api.alpaca.markets",
      TRADING_MODE: "live", LIVE_ACCOUNT_ID: "acct-123", TELEGRAM_OPS_CHAT_ID: "-100999",
    };
    expect(() => assertRequiredConfig(env, () => "acct-123")).not.toThrow();
  });

  test("a non-paper host with ALPACA_PAPER unset/true-ish string mismatch also triggers the ceremony (host-based detection, not just the flag)", () => {
    const env = { ...FULL_ENV, ALPACA_BASE_URL: "https://api.alpaca.markets" }; // ALPACA_PAPER unset → defaults "true" flag, but host isn't paper
    expect(() => assertRequiredConfig(env, noMarker)).toThrow(/STARTUP REFUSED/);
  });
});
