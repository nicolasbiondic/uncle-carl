// momentum_crypto model-cutover re-anchor wiring (2026-09-26, owner: resolve
// the ~2-week entry lockout). The live RiskState carried the PREVIOUS
// fixed-size model's peak into vt-35; the validated vt-35 replay over the same
// dates is not paused. MOMENTUM_CRYPTO_MODEL_VERSION stamps the model so the
// first boot re-anchors the peak once — this locks that wiring and replays the
// exact persisted prod state shape through RiskGuard.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { MOMENTUM_CRYPTO_EVIDENCE_VERSION, MOMENTUM_CRYPTO_MODEL_VERSION, MOMENTUM_STOCKS_MODEL_VERSION, momentumCryptoPortfolioPlan } from "./index";
import { builtinPortfolio } from "./portfolios/builtin";
import { evaluateRisk, DEFAULT_RISK_CONFIG, type RiskState } from "./strategies/momentum/RiskGuard";

describe("momentum_crypto modelVersion wiring", () => {
  test("the vt-35 model identity is set and passed to the momentum_crypto engine", () => {
    // Bumped 2026-10-23 (RW3, correlation brake OFF); was "vt35-2026-09-23".
    expect(MOMENTUM_CRYPTO_MODEL_VERSION).toBe("vt35-corroff-2026-10-23");
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect((src.match(/modelVersion: MOMENTUM_CRYPTO_MODEL_VERSION,/g) ?? []).length).toBe(1);
  });

  test("RW7 keeps the 120h time barrier without re-anchoring the RiskState", () => {
    const plan = momentumCryptoPortfolioPlan();
    expect(plan.engineConfig.timeStop).toEqual({ maxHoldHours: 120 });
    expect(plan.engineConfig.modelVersion).toBe("vt35-corroff-2026-10-23");
    expect((builtinPortfolio("momentum_crypto").params as any).timeStop).toEqual(plan.engineConfig.timeStop);
  });

  test("RW7: no risk pauses, regime/Sharpe filters or stop cooldown in plan AND builtin; sizing and RiskState identity stay", () => {
    const plan = momentumCryptoPortfolioPlan();
    expect(plan.engineConfig.regime).toEqual({ barMinutes: 60, enabled: false });
    expect(plan.engineConfig.risk?.mode).toBe("sizeOnly");
    expect(plan.engineConfig.allowSameTickReentry).toBe(true);
    expect(plan.engineConfig.modelVersion).toBe(MOMENTUM_CRYPTO_MODEL_VERSION);
    expect(plan.governorRegistration.evidenceVersion).toBe(MOMENTUM_CRYPTO_EVIDENCE_VERSION);
    expect(MOMENTUM_CRYPTO_EVIDENCE_VERSION).toBe("v8.5-crypto-corroff");
    const row: any = builtinPortfolio("momentum_crypto").params;
    expect(row.regime).toEqual({ enabled: false });
    expect(row.risk).toEqual({ mode: "sizeOnly" });
    expect(row.allowSameTickReentry).toBe(true);
    expect(row.sharpeGate).toBeUndefined();
    expect(row.modelVersion).toBe(MOMENTUM_CRYPTO_MODEL_VERSION);
    expect(row.governor.evidenceVersion).toBe(MOMENTUM_CRYPTO_EVIDENCE_VERSION);
    // Sizing and vol target untouched.
    expect(plan.engineConfig.notionalPctPerSlot).toBe(0.375);
    expect(plan.engineConfig.sharpeGate).toBeUndefined();
    expect(plan.engineConfig.volTarget).toEqual({ annualizedPct: 35, lookbackBars: 720, minScale: 0.33, maxScale: 1.5 });
    // Governor: the old epoch's closes (brake ON) are not evidence against the brake-off band.
    expect(MOMENTUM_CRYPTO_EVIDENCE_VERSION).not.toBe("v8-crypto-no-hard-sl");
  });

  test("RW3 re-anchor: prod's persisted state (peak 5229.47, 3 inherited losses, expired 10-08 pause) starts the brake-off model like a fold start — peak = equity, streak 0", () => {
    const now = Date.UTC(2026, 9, 23, 9, 0, 15);
    // data/momentum-state-crypto.json on prod, 2026-10-23 (read-only), sleeve flat since the 10-08 stops.
    const prod: RiskState = {
      peakEquity: 5229.46610313522,
      dayStartEquity: 4891.0688615,
      dayStartedAt: Date.UTC(2026, 9, 22, 0, 0, 15),
      consecutiveLosses: 3,
      pausedUntil: Date.UTC(2026, 9, 8, 0, 0, 0),
      pauseReason: "daily loss cap 3.11% — paused until 2026-10-08T00:00:00.000Z",
      lastEvalAt: now - 3_600_000,
      stateVersion: 3,
      equityBase: 5000,
      equitySemantics: "binance_total_margin_equity",
      pendingSemanticReanchor: false,
      modelVersion: "vt35-2026-09-23",
      modelReanchorRev: 2,
    } as RiskState;
    // The persisted key differs from the wired one → the engine constructor arms the one-shot.
    expect(prod.modelVersion).not.toBe(MOMENTUM_CRYPTO_MODEL_VERSION);
    const equity = 4891.0688615;
    const keep = evaluateRisk({ ...prod }, equity, now, DEFAULT_RISK_CONFIG);
    expect(keep.state.peakEquity).toBeGreaterThan(5000); // without the re-anchor: a 6.5% drawdown the new model never produced
    expect(keep.state.consecutiveLosses).toBe(3);        // and 2 more losses from the 5-loss pause
    const after = evaluateRisk({ ...prod, pendingModelReanchor: true } as RiskState, equity, now, DEFAULT_RISK_CONFIG);
    expect(after.canOpen).toBe(true);
    expect(after.state.peakEquity).toBeCloseTo(equity, 6);
    expect(after.state.consecutiveLosses).toBe(0);
    expect(after.state.pendingModelReanchor).toBe(false);
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

describe("momentum_stocks modelVersion wiring (2026-09-28; bumped 2026-10-10 for line E k = 1.5)", () => {
  test("the daily blend3 kernel has its own model identity, passed once to the stocks engine", () => {
    expect(MOMENTUM_STOCKS_MODEL_VERSION).toBe("daily-blend3-k150-2026-10-12");
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
