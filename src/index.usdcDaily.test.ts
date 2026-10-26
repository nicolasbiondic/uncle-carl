// momentum_crypto_usdc daily-kernel cutover wiring (2026-09-26): the daily
// model starts with its own risk state (modelVersion) and re-underwrites the
// hourly model's positions once, with a self-expiring window.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  MOMENTUM_USDC_MODEL_VERSION,
  MOMENTUM_USDC_EVIDENCE_VERSION,
  MOMENTUM_USDC_EXPOSURE_CONTROL,
  MOMENTUM_USDC_CUTOVER_AT,
  MOMENTUM_USDC_CUTOVER_EXPIRES_AT,
  MOMENTUM_USDC_CUTOVER_SYMBOLS,
  momentumUsdcCutoverFor,
  momentumUsdcPortfolioPlan,
} from "./index";
import { builtinPortfolio } from "./portfolios/builtin";
import { exposureResizeFactor, exposureScale } from "./strategies/momentum/MomentumEngine";
import { evaluateRisk, DEFAULT_RISK_CONFIG, type RiskState } from "./strategies/momentum/RiskGuard";

describe("momentum_crypto_usdc daily-kernel cutover", () => {
  test("RW6 adds the 120h cap in plan + builtin, retaining the daily RiskState key", () => {
    expect(momentumUsdcPortfolioPlan().engineConfig.timeStop).toEqual({ maxHoldHours: 120 });
    expect((builtinPortfolio("momentum_crypto_usdc").params as any).timeStop).toEqual({ maxHoldHours: 120 });
    expect(momentumUsdcPortfolioPlan().engineConfig.modelVersion).toBe("daily-s5-blend3-2026-09-26");
  });
  test("model identity is the daily kernel and is wired into the USDC engine", () => {
    expect(MOMENTUM_USDC_MODEL_VERSION).toBe("daily-s5-blend3-2026-09-26");
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect((src.match(/modelVersion: MOMENTUM_USDC_MODEL_VERSION,/g) ?? []).length).toBe(1);
    expect(src).toContain("reunderwriteBefore: momentumUsdcCutoverFor(Date.now())");
  });

  test("the one-shot cutover (owner realign 2026-10-06: UNI/USDC only) applies to the next daily pass and expires on its own", () => {
    expect(MOMENTUM_USDC_CUTOVER_AT).toBe(Date.UTC(2026, 9, 6, 5));
    expect(MOMENTUM_USDC_CUTOVER_SYMBOLS).toEqual(["UNI/USDC"]);
    expect(momentumUsdcCutoverFor(Date.UTC(2026, 9, 8, 0, 0, 15))).toBe(MOMENTUM_USDC_CUTOVER_AT);
    expect(momentumUsdcCutoverFor(MOMENTUM_USDC_CUTOVER_EXPIRES_AT)).toBeUndefined();
    expect(momentumUsdcCutoverFor(Date.UTC(2027, 0, 1))).toBeUndefined();
  });
});

// ══════════════════════════════════════════════
// RW4a (2026-10-23): the drawdown exposure control on momentum_crypto_usdc —
// every consumer in one place, and the re-anchor decision made explicit.
// ══════════════════════════════════════════════
describe("momentum_crypto_usdc RW4a — drawdown exposure control wired, RiskState NOT re-anchored", () => {
  test("plan + builtin row carry the knob and the new governor evidence epoch; the kernel keys are untouched", () => {
    const knob = { drawdown: { startPct: 0.1, endPct: 0.4 }, minScale: 0.25, band: 0.1, minOrderUsd: 100 };
    expect(MOMENTUM_USDC_EXPOSURE_CONTROL).toEqual(knob);
    const plan = momentumUsdcPortfolioPlan();
    expect(plan.engineConfig.exposureControl).toEqual(knob);
    expect(plan.engineConfig.exposureControl).not.toBe(MOMENTUM_USDC_EXPOSURE_CONTROL); // a copy: the engine never mutates the constant
    expect(plan.governorRegistration.evidenceVersion).toBe(MOMENTUM_USDC_EVIDENCE_VERSION);
    expect(MOMENTUM_USDC_EVIDENCE_VERSION).toBe("v8.6-usdc-xc-dd");
    expect(MOMENTUM_USDC_EVIDENCE_VERSION).not.toBe("v8.3-usdc-daily"); // closes without the control are not evidence against the xc-dd band
    const row: any = builtinPortfolio("momentum_crypto_usdc").params;
    expect(row.exposureControl).toEqual(knob);
    expect(row.governor.evidenceVersion).toBe(MOMENTUM_USDC_EVIDENCE_VERSION);
    expect(row.modelVersion).toBe(MOMENTUM_USDC_MODEL_VERSION);
    // Kernel untouched: 5 × 0.20, blend 63/126/252 / MA200, k8 stops, soft-DD pause ON (no risk.softDrawdownPct override).
    expect(plan.engineConfig.notionalPctPerSlot).toBe(0.2);
    expect(plan.engineConfig.tsm).toMatchObject({ maxLongs: 5, slotHysteresis: true, lookbackDaysList: [63, 126, 252], maLengthDays: 200 });
    expect(plan.engineConfig.volStop).toEqual({ kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 });
    expect((plan.engineConfig.risk as any)?.softDrawdownPct).toBeUndefined();
    expect(plan.engineConfig.volTarget).toBeUndefined();
  });

  test("the RiskState key is NOT bumped: the live 13.8% drawdown is the control's input — re-anchoring would blind it (dd → 0) and release the soft-DD pause", () => {
    expect(MOMENTUM_USDC_MODEL_VERSION).toBe("daily-s5-blend3-2026-09-26");
    // data/momentum-state-usdc.json on prod, 2026-10-23 07:44 UTC (read-only): 4 longs held at full size.
    const prod: RiskState = {
      peakEquity: 7343.610402271212,
      dayStartEquity: 6218.47226066,
      dayStartedAt: Date.UTC(2026, 9, 23, 0, 0, 15),
      consecutiveLosses: 2,
      pausedUntil: Date.UTC(2026, 9, 24, 0, 0, 15),
      pauseReason: "soft drawdown 15.3% — paused 24h",
      lastEvalAt: Date.UTC(2026, 9, 23, 0, 0, 15),
      stateVersion: 3,
      equityBase: 5000,
      equitySemantics: "binance_usdc_margin_equity",
      pendingSemanticReanchor: false,
      modelVersion: "daily-s5-blend3-2026-09-26",
      pendingModelReanchor: false,
      modelReanchorRev: 2,
    } as RiskState;
    expect(prod.modelVersion).toBe(MOMENTUM_USDC_MODEL_VERSION); // same key ⇒ the engine constructor arms NO one-shot
    const equity = 6332.34820872;
    const now = Date.UTC(2026, 9, 24, 0, 0, 15);
    const kept = evaluateRisk({ ...prod }, equity, now, DEFAULT_RISK_CONFIG);
    const dd = 1 - equity / kept.state.peakEquity;
    expect(dd).toBeGreaterThan(0.10); // the control bites and the soft-DD pause re-arms — what the replay does at this dd
    const lambda = exposureScale({ cfg: MOMENTUM_USDC_EXPOSURE_CONTROL, drawdown: dd, book: [], barsPerYear: 365 });
    expect(lambda.scale).toBeCloseTo(1 - (dd - 0.1) / 0.3, 9);
    expect(lambda.scale).toBeLessThan(0.9);
    // Held at fraction 1 with ~1.4-1.6k USD notionals → the first pass cuts every position ×λ (orders ≥ 100 USD).
    expect(exposureResizeFactor(1, lambda.scale, 1400, MOMENTUM_USDC_EXPOSURE_CONTROL)).toBeCloseTo(lambda.scale, 9);
    // What a re-anchor WOULD do: dd 0 → λ 1 (no cut) and the pause released — the refuted no-soft-DD behaviour.
    const reanchored = evaluateRisk({ ...prod, pendingModelReanchor: true } as RiskState, equity, now, DEFAULT_RISK_CONFIG);
    expect(reanchored.state.peakEquity).toBeCloseTo(equity, 6);
    expect(exposureScale({ cfg: MOMENTUM_USDC_EXPOSURE_CONTROL, drawdown: 0, book: [], barsPerYear: 365 }).scale).toBe(1);
    expect(reanchored.canOpen).toBe(true);
  });
});
