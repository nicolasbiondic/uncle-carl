// ═══ P0 (2026-10-09): KPI targets — env > instance.json > null ═══

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadInstanceConfig, resetInstanceConfigForTests } from "./instance";

const ENV_KEYS = ["UC_DATA_DIR", "KPI_TARGET_TRADES_PER_DAY", "KPI_TARGET_DAILY_RETURN_PCT", "KPI_RISK_BUDGET_DD_PCT"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  resetInstanceConfigForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetInstanceConfigForTests();
});

function withInstanceFile(content: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), "uc-kpi-"));
  writeFileSync(join(dir, "instance.json"), JSON.stringify(content));
  process.env.UC_DATA_DIR = dir;
}

describe("instance kpiTargets", () => {
  test("unset everywhere → every target null (fresh installs/forks show raw figures)", () => {
    expect(loadInstanceConfig().kpiTargets).toEqual({ tradesPerDay: null, dailyReturnPct: null, riskBudgetDdPct: null });
  });

  test("instance.json kpiTargets are read", () => {
    withInstanceFile({ kpiTargets: { tradesPerDay: 30, dailyReturnPct: 0.12, riskBudgetDdPct: 25 } });
    expect(loadInstanceConfig().kpiTargets).toEqual({ tradesPerDay: 30, dailyReturnPct: 0.12, riskBudgetDdPct: 25 });
  });

  test("env beats instance.json, per field", () => {
    withInstanceFile({ kpiTargets: { tradesPerDay: 10, dailyReturnPct: 0.05, riskBudgetDdPct: 15 } });
    process.env.KPI_TARGET_TRADES_PER_DAY = "30";
    process.env.KPI_RISK_BUDGET_DD_PCT = "25";
    const t = loadInstanceConfig().kpiTargets;
    expect(t.tradesPerDay).toBe(30);        // env
    expect(t.dailyReturnPct).toBe(0.05);    // file (env unset for this field)
    expect(t.riskBudgetDdPct).toBe(25);     // env
  });

  test("garbage/non-positive values are tolerated as null, never a crash", () => {
    withInstanceFile({ kpiTargets: { tradesPerDay: "banana", dailyReturnPct: -1, riskBudgetDdPct: 0 } });
    process.env.KPI_TARGET_TRADES_PER_DAY = "not-a-number";
    expect(loadInstanceConfig().kpiTargets).toEqual({ tradesPerDay: null, dailyReturnPct: null, riskBudgetDdPct: null });
  });
});
