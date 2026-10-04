// momentum_crypto model-cutover re-anchor wiring (2026-09-26, owner: resolve
// the ~2-week entry lockout). The live RiskState carried the PREVIOUS
// fixed-size model's peak into vt-35; the validated vt-35 replay over the same
// dates is not paused. MOMENTUM_CRYPTO_MODEL_VERSION stamps the model so the
// first boot re-anchors the peak once — this locks that wiring and replays the
// exact persisted prod state shape through RiskGuard.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { MOMENTUM_CRYPTO_MODEL_VERSION, MOMENTUM_STOCKS_MODEL_VERSION } from "./index";
import { evaluateRisk, DEFAULT_RISK_CONFIG, type RiskState } from "./strategies/momentum/RiskGuard";

describe("momentum_crypto modelVersion wiring", () => {
  test("the vt-35 model identity is set and passed to the momentum_crypto engine", () => {
    expect(MOMENTUM_CRYPTO_MODEL_VERSION).toBe("vt35-2026-09-23");
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect((src.match(/modelVersion: MOMENTUM_CRYPTO_MODEL_VERSION,/g) ?? []).length).toBe(1);
  });

  test("the persisted prod state (inherited soft-DD pause at 13.5%) resumes entries once re-anchored; a hard pause would survive", () => {
    const now = Date.UTC(2026, 8, 26, 21, 0, 0);
    // data/momentum-state-crypto.json on prod, 2026-09-26 (pre-cutover).
    const prod: RiskState = {
      peakEquity: 6161.637090572999,
      dayStartEquity: 5333.23166678,
      dayStartedAt: Date.UTC(2026, 8, 25, 0, 0, 15),
      consecutiveLosses: 4,
      pausedUntil: Date.UTC(2026, 8, 27, 1, 0, 15),
      pauseReason: "soft drawdown 13.5% — paused 24h",
      lastEvalAt: now - 3_600_000,
      stateVersion: 3,
      equityBase: 5000,
      equitySemantics: "binance_total_margin_equity",
      pendingSemanticReanchor: false,
    } as RiskState;

    // Without the re-anchor the inherited pause keeps blocking.
    const before = evaluateRisk({ ...prod }, 5333.23, now, DEFAULT_RISK_CONFIG);
    expect(before.canOpen).toBe(false);

    // With it (what the engine arms on first boot under the new key).
    const after = evaluateRisk({ ...prod, pendingModelReanchor: true } as RiskState, 5333.23, now, DEFAULT_RISK_CONFIG);
    expect(after.canOpen).toBe(true);
    expect(after.state.peakEquity).toBeCloseTo(5333.23, 2);
    expect(after.state.pendingModelReanchor).toBe(false);
    // Revision 2 (2026-09-28): the 4 inherited losing rebalances die with the
    // old model — revision 1 kept them and one stop re-paused the sleeve.
    expect(after.state.consecutiveLosses).toBe(0);

    // A HARD drawdown pause is never cleared by a model cutover.
    const hard = evaluateRisk(
      { ...prod, pauseReason: "hard drawdown 21.0% — paused 168h, human review required", pausedUntil: now + 5 * 86_400_000, pendingModelReanchor: true } as RiskState,
      5333.23, now, DEFAULT_RISK_CONFIG,
    );
    expect(hard.canOpen).toBe(false);
  });
});

describe("momentum_stocks modelVersion wiring (2026-09-28)", () => {
  test("the daily blend3 kernel has its own model identity, passed once to the stocks engine", () => {
    expect(MOMENTUM_STOCKS_MODEL_VERSION).toBe("daily-blend3-2026-09-28");
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect((src.match(/modelVersion: MOMENTUM_STOCKS_MODEL_VERSION,/g) ?? []).length).toBe(1);
  });

  test("the persisted prod state (5m kernel's peak + 2 losing rebalances) starts the daily kernel clean", () => {
    const now = Date.UTC(2026, 8, 28, 13, 36, 0);
    // data/momentum-state-stocks.json on prod, 2026-09-28 (last pass 09-25).
    const prod: RiskState = {
      peakEquity: 55707.93946170168,
      dayStartEquity: 54690.038478999995,
      dayStartedAt: Date.UTC(2026, 8, 25, 13, 35, 9),
      consecutiveLosses: 2,
      pausedUntil: 1786726870204,
      pauseReason: "soft drawdown 15.6% — paused 24h",
      lastEvalAt: Date.UTC(2026, 8, 25, 13, 35, 9),
      stateVersion: 3,
      equitySemantics: "sleeve_ledger_equity",
      pendingSemanticReanchor: false,
      equityBase: 50000,
    } as RiskState;
    const after = evaluateRisk({ ...prod, pendingModelReanchor: true } as RiskState, 54136.79, now, DEFAULT_RISK_CONFIG);
    expect(after.canOpen).toBe(true);
    expect(after.state.peakEquity).toBeCloseTo(54136.79, 2);
    expect(after.state.consecutiveLosses).toBe(0);
  });
});
