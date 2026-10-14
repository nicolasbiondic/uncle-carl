import { describe, expect, test } from "bun:test";
import { RISK_ALERT_SHARE_OF_BUDGET, riskAlertLine } from "./telegram-reporter";

describe("daily digest early drawdown alert (plan V §9, line E quorum condition)", () => {
  test("fires at 60% of the budget: 15% of the owner's 25%", () => {
    expect(RISK_ALERT_SHARE_OF_BUDGET).toBe(0.6);
    expect(riskAlertLine(14.9, 25)).toBeNull();
    const line = riskAlertLine(15, 25);
    expect(line).not.toBeNull();
    expect(line!).toContain("15.0%");
    expect(line!).toContain("presupuesto de 25%");
    expect(riskAlertLine(22.4, 25)!).toContain("22.4%");
  });

  test("no budget configured (fresh install) or no drawdown reading → no alert", () => {
    expect(riskAlertLine(40, null)).toBeNull();
    expect(riskAlertLine(null, 25)).toBeNull();
  });
});
