// ══════════════════════════════════════════════
// .env.example EXECUTION_POLICY_JSON — doc-vs-validator check (2026-08-06)
// ══════════════════════════════════════════════
//
// EXECUTION_POLICY_JSON is opt-in and its whole shape lives in a single env
// var — a typo there is invisible until someone actually flips it on in
// prod, where an invalid entry is silently DROPPED (that sleeve falls back
// to market — see executionPolicy.ts validatePolicy()) rather than failing
// loudly. This test parses the EXACT commented example line out of
// .env.example and runs it through the real validator, so a bad example
// fails CI instead of silently doing nothing the day someone uncomments it.
//
// Deliberately does NOT import from src/executor/** for anything other than
// the read-only validatePolicy() function under test — this suite only
// reads .env.example and the validator, it does not modify either.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { validatePolicy } from "../src/executor/executionPolicy";
import { ALL_PROFILE_IDS } from "../src/config/riskProfiles";

const ENV_EXAMPLE_PATH = join(import.meta.dir, "../.env.example");
const ENV_EXAMPLE = readFileSync(ENV_EXAMPLE_PATH, "utf-8");

function extractExecutionPolicyJson(env: string): string {
  const m = env.match(/^#\s*EXECUTION_POLICY_JSON=(\{.*\})\s*$/m);
  if (!m) throw new Error(".env.example has no EXECUTION_POLICY_JSON example line to validate");
  return m[1]!;
}

describe(".env.example EXECUTION_POLICY_JSON example", () => {
  test("is present and is valid JSON", () => {
    const raw = extractExecutionPolicyJson(ENV_EXAMPLE);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("parses to an object keyed ONLY by momentum_crypto_usdc — every other sleeve stays on market", () => {
    const parsed = JSON.parse(extractExecutionPolicyJson(ENV_EXAMPLE));
    expect(Object.keys(parsed)).toEqual(["momentum_crypto_usdc"]);
    for (const id of ALL_PROFILE_IDS) {
      if (id === "momentum_crypto_usdc") continue;
      expect(parsed[id]).toBeUndefined();
    }
  });

  test("momentum_crypto_usdc's policy is ACCEPTED by validatePolicy() with both entry and exit active", () => {
    const parsed = JSON.parse(extractExecutionPolicyJson(ENV_EXAMPLE));
    const policy = validatePolicy(parsed.momentum_crypto_usdc);
    expect(policy).not.toBeNull();
    expect(policy?.entry?.style).toBe("limit_chase");
    expect(policy?.exit?.style).toBe("limit_then_market");
  });

  test("entry config matches the documented, justified values exactly", () => {
    const parsed = JSON.parse(extractExecutionPolicyJson(ENV_EXAMPLE));
    const policy = validatePolicy(parsed.momentum_crypto_usdc)!;
    expect(policy.entry).toEqual({
      style: "limit_chase",
      offsetBps: 3,
      refreshThresholdBps: 4,
      maxReprices: 3,
      maxDistanceBps: 15,
      timeoutMs: 60_000,
      pollIntervalMs: 3_000,
    });
  });

  test("exit config matches the documented, justified values exactly — and ALWAYS degrades to market (limit_then_market, not limit_chase)", () => {
    const parsed = JSON.parse(extractExecutionPolicyJson(ENV_EXAMPLE));
    const policy = validatePolicy(parsed.momentum_crypto_usdc)!;
    expect(policy.exit).toEqual({
      style: "limit_then_market",
      offsetBps: 2,
      refreshThresholdBps: 3,
      maxReprices: 2,
      maxDistanceBps: 12,
      timeoutMs: 20_000,
      pollIntervalMs: 2_000,
    });
  });

  test("exit's bounded limit phase is shorter than entry's — exits must not be delayed the way an optional entry can be", () => {
    const parsed = JSON.parse(extractExecutionPolicyJson(ENV_EXAMPLE));
    const policy = validatePolicy(parsed.momentum_crypto_usdc)!;
    expect(policy.exit!.timeoutMs).toBeLessThan(policy.entry!.timeoutMs);
  });
});
