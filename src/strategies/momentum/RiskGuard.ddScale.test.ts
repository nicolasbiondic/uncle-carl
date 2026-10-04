// Continuous drawdown-scaled entry sizing (RiskGuardConfig.ddScale,
// 2026-09-25 — Grossman & Zhou 1993: exposure proportional to the cushion
// over the drawdown floor). Contracts pinned here:
//   1. ddEntryScale (pure): linear ramp 1 → minScale between startPct and
//      endPct, clamped; degenerate config fails open to 1.
//   2. Soft-drawdown pause IGNORED while ddScale is active (never arms).
//   3. Hard drawdown / daily cap / loss streak stay INTACT.
//   4. Scale 0 (minScale 0, dd >= endPct) refuses opens WITHOUT arming a
//      pause — a floor, not a lockout (no 24h re-arm loop).
//   5. Legacy (ddScale absent): behavior AND assessment shape byte-identical.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RISK_CONFIG,
  INITIAL_RISK_STATE,
  ddEntryScale,
  evaluateRisk,
  type RiskGuardConfig,
  type RiskState,
} from "./RiskGuard";

const NOW = Date.UTC(2026, 0, 10, 12); // mid-UTC-day, away from midnight edges

/** State pinned at a given peak with no decay surprises: lastEvalAt === now
 *  means evaluateRisk's decay factor is 0.5^0 = 1 (peak untouched).
 *  `dayStart` defaults to the peak; tests probing the dd axis pass the
 *  CURRENT equity instead so the (intact) 3% daily cap doesn't fire on top
 *  of the drawdown under test (an overnight drawdown, not an intraday one). */
function stateAtPeak(peak: number, dayStart: number = peak): RiskState {
  return { ...INITIAL_RISK_STATE, peakEquity: peak, dayStartEquity: dayStart, dayStartedAt: NOW, lastEvalAt: NOW };
}

function cfgWith(ddScale: RiskGuardConfig["ddScale"]): RiskGuardConfig {
  return { ...DEFAULT_RISK_CONFIG, ddScale };
}

describe("ddEntryScale (pure)", () => {
  const dd5to20 = { startPct: 0.05, endPct: 0.20, minScale: 0 };

  test("linear ramp between startPct and endPct", () => {
    expect(ddEntryScale(0.00, dd5to20)).toBe(1);
    expect(ddEntryScale(0.05, dd5to20)).toBe(1);            // at start → still full size
    expect(ddEntryScale(0.125, dd5to20)).toBeCloseTo(0.5, 12); // midpoint
    expect(ddEntryScale(0.20, dd5to20)).toBe(0);             // at end → floor
    expect(ddEntryScale(0.30, dd5to20)).toBe(0);             // beyond end → clamped
    // exact linearity at an interior point: 1 − (0.12−0.05)/0.15
    expect(ddEntryScale(0.12, dd5to20)).toBeCloseTo(1 - 0.07 / 0.15, 12);
  });

  test("floors at minScale, caps at 1", () => {
    const floored = { startPct: 0.05, endPct: 0.20, minScale: 0.25 };
    expect(ddEntryScale(0.10, floored)).toBeCloseTo(1 - 0.05 / 0.15, 12); // above floor
    expect(ddEntryScale(0.20, floored)).toBe(0.25);
    expect(ddEntryScale(0.50, floored)).toBe(0.25);
    expect(ddEntryScale(-0.10, floored)).toBe(1); // equity above peak → full size
  });

  test("minScale defaults to 0; degenerate config fails open to 1", () => {
    expect(ddEntryScale(0.25, { startPct: 0.05, endPct: 0.20 })).toBe(0);
    expect(ddEntryScale(0.25, { startPct: 0.20, endPct: 0.20 })).toBe(1); // span 0
    expect(ddEntryScale(0.25, { startPct: 0.30, endPct: 0.20 })).toBe(1); // inverted
    expect(ddEntryScale(NaN, { startPct: 0.05, endPct: 0.20 })).toBe(1);
  });
});

describe("evaluateRisk with ddScale", () => {
  const dd = cfgWith({ startPct: 0.05, endPct: 0.20, minScale: 0 });

  test("soft drawdown is IGNORED: dd 12% keeps canOpen true with a scaled factor, no pause armed", () => {
    // Control: legacy config pauses at 12% dd.
    const legacy = evaluateRisk(stateAtPeak(10_000), 8_800, NOW, DEFAULT_RISK_CONFIG);
    expect(legacy.canOpen).toBe(false);
    expect(legacy.breach).toBe("soft_drawdown");
    expect(legacy.state.pausedUntil).toBeGreaterThan(NOW);

    // ddScale: same dd trades on, scaled 1 − (0.12−0.05)/0.15 ≈ 0.533.
    const scaled = evaluateRisk(stateAtPeak(10_000, 8_800), 8_800, NOW, dd);
    expect(scaled.canOpen).toBe(true);
    expect(scaled.breach).toBeNull();
    expect(scaled.state.pausedUntil).toBe(0);
    expect(scaled.entryScale).toBeCloseTo(1 - 0.07 / 0.15, 12);
  });

  test("hard drawdown stays INTACT: dd 22% pauses 168h exactly like legacy", () => {
    const res = evaluateRisk(stateAtPeak(10_000), 7_800, NOW, dd);
    expect(res.canOpen).toBe(false);
    expect(res.breach).toBe("hard_drawdown");
    expect(res.state.pausedUntil).toBe(NOW + 168 * 3_600_000);
    expect(res.entryScale).toBeUndefined(); // hard breach precedes the scale computation
  });

  test("daily loss cap stays INTACT and takes priority over a (0,1) scale", () => {
    // dd 12% (scaled regime) AND intraday loss 12% >= 3% cap.
    const st = { ...stateAtPeak(10_000), dayStartEquity: 10_000 };
    const res = evaluateRisk(st, 8_800, NOW, dd);
    expect(res.canOpen).toBe(false);
    expect(res.breach).toBe("daily_cap");
  });

  test("loss streak stays INTACT under ddScale", () => {
    const st = { ...stateAtPeak(10_000), consecutiveLosses: 5, dayStartEquity: 9_900 };
    const res = evaluateRisk(st, 9_800, NOW, dd); // dd 2% → scale 1, streak fires
    expect(res.canOpen).toBe(false);
    expect(res.breach).toBe("loss_streak");
  });

  test("scale 0 refuses opens WITHOUT arming a pause (floor, not lockout)", () => {
    // dd 19% is >= a tighter endPct 0.15 but below the 20% hard breaker.
    const tight = cfgWith({ startPct: 0.05, endPct: 0.15, minScale: 0 });
    const res = evaluateRisk(stateAtPeak(10_000, 8_100), 8_100, NOW, tight);
    expect(res.canOpen).toBe(false);
    expect(res.breach).toBeNull();
    expect(res.entryScale).toBe(0);
    expect(res.reason).toStartWith("dd scale:");
    expect(res.state.pausedUntil).toBe(0); // nothing armed — next tick re-evaluates
    expect(res.state.pauseReason).toBe("");

    // With a nonzero floor the same dd keeps trading at the floor.
    const floored = cfgWith({ startPct: 0.05, endPct: 0.15, minScale: 0.1 });
    const res2 = evaluateRisk(stateAtPeak(10_000, 8_100), 8_100, NOW, floored);
    expect(res2.canOpen).toBe(true);
    expect(res2.entryScale).toBe(0.1);
  });

  test("no drawdown → entryScale exactly 1 (still reported, sizing unchanged)", () => {
    const res = evaluateRisk(stateAtPeak(10_000), 10_000, NOW, dd);
    expect(res.canOpen).toBe(true);
    expect(res.entryScale).toBe(1);
  });

  test("legacy intact: without ddScale the assessment carries NO entryScale key and behavior is unchanged", () => {
    const open = evaluateRisk(stateAtPeak(10_000), 9_800, NOW, DEFAULT_RISK_CONFIG);
    expect(open.canOpen).toBe(true);
    expect("entryScale" in open).toBe(false); // shape, not just value

    // dd 12% under legacy = soft pause (re-assert the control from above so
    // this test stands alone as the byte-identity witness).
    const soft = evaluateRisk(stateAtPeak(10_000), 8_800, NOW, DEFAULT_RISK_CONFIG);
    expect(soft.breach).toBe("soft_drawdown");
    expect("entryScale" in soft).toBe(false);
  });
});
