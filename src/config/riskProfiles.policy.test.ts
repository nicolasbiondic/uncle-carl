// ══════════════════════════════════════════════
// SLEEVE_POLICY lock — the declared policy must not lie.
//
// (a) The risk-retirement numbers declared in riskProfiles.ts are a claim
//     about what RiskGuard actually enforces. All five sleeves run
//     DEFAULT_RISK_CONFIG unmodified, so declared === DEFAULT_RISK_CONFIG,
//     and index.ts must not silently start overriding thresholds (its
//     `risk:` blocks may only set equitySemantics / persisted-state keys).
//     If an engine ever gets sleeve-specific thresholds, this test fails
//     and forces the declaration to be updated WITH the wiring.
// (b) The review policy must be complete: a positive expected Sharpe, a
//     provenance string, a version and a declaration date — the four things
//     that make the ex-ante goalpost auditable.
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { ALL_PROFILE_IDS, SLEEVE_POLICY } from "./riskProfiles";
import { DEFAULT_RISK_CONFIG } from "../strategies/momentum/RiskGuard";

describe("SLEEVE_POLICY — declared risk retirement mirrors what RiskGuard enforces", () => {
  test("every sleeve's declared thresholds equal DEFAULT_RISK_CONFIG", () => {
    for (const id of ALL_PROFILE_IDS) {
      const risk = SLEEVE_POLICY[id].risk;
      expect(risk.dailyLossCapPct).toBe(DEFAULT_RISK_CONFIG.dailyLossCapPct);
      expect(risk.softDrawdownPct).toBe(DEFAULT_RISK_CONFIG.softDrawdownPct);
      expect(risk.hardDrawdownPct).toBe(DEFAULT_RISK_CONFIG.hardDrawdownPct);
      expect(risk.declaredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(risk.enforcedBy).toContain("RiskGuard");
    }
  });

  test("index.ts engine wiring does not override RiskGuard thresholds (only semantics/state keys)", () => {
    const src = readFileSync(`${import.meta.dir}/../index.ts`, "utf-8");
    // Any `risk: { ... }` block naming a threshold key would make the declared
    // policy a lie. equitySemantics/stateVersion/equityBase (persistence) are
    // the only sanctioned keys today.
    const thresholdKeys = /risk:\s*\{[^}]*(dailyLossCapPct|softDrawdownPct|hardDrawdownPct|consecutiveLossLimit|softPauseHours|hardPauseHours|peakHalfLifeDays)/;
    expect(thresholdKeys.test(src)).toBe(false);
  });
});

describe("SLEEVE_POLICY — review policy is complete and ex ante", () => {
  test("every sleeve declares a positive expected Sharpe with provenance, version and date", () => {
    for (const id of ALL_PROFILE_IDS) {
      const review = SLEEVE_POLICY[id].review;
      expect(review.expectedSharpeAnnualized).toBeGreaterThan(0);
      expect(review.provenance.length).toBeGreaterThan(10);
      expect(review.version).toMatch(/^v\d+/);
      expect(review.declaredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
