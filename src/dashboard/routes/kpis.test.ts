// ═══ P0 (2026-10-09): /api/kpis + /api/funnel route tests ═══

import express from "express";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { getDB, insertDecisionPass, saveEquitySnapshot, getETDayStart } from "../../db/database";
import { registerKpiRoutes, DESIGN_OPS_PER_DAY } from "./kpis";
import { makeTestDb } from "../../test-support/db";
import { resetInstanceConfigForTests } from "../../platform/instance";

function seedTrade(o: { id: string; account: string; entry: number; exit?: number | null; closeReason?: string | null }) {
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity,
       entry_time, status, exit_time, pnl, pnl_pct, profile_id, account_id, close_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.id, "SOL/USD", "crypto", "buy", "MOMENTUM", 100, 1,
    o.entry, o.exit ? "closed" : "open", o.exit ?? null, o.exit ? 1 : null, o.exit ? 1 : null,
    o.account, o.account, o.closeReason ?? null,
  );
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const app = express();
  registerKpiRoutes(app);
  const server = app.listen(0);
  try {
    await fn((server.address() as { port: number }).port);
  } finally {
    server.close();
  }
}

beforeEach(() => {
  makeTestDb();
  for (const k of ["KPI_TARGET_TRADES_PER_DAY", "KPI_TARGET_DAILY_RETURN_PCT", "KPI_RISK_BUDGET_DD_PCT"]) delete process.env[k];
  resetInstanceConfigForTests();
});

describe("GET /api/kpis", () => {
  test("volume counts executed ORDERS (entry+exit separately), targets null when unconfigured", async () => {
    const now = Date.now();
    const todayStart = getETDayStart(now);
    // One same-day round trip (2 orders) + one open entry (1 order) = 3.
    seedTrade({ id: "rt", account: "momentum_crypto", entry: todayStart + 1_000, exit: todayStart + 2_000, closeReason: "TRAIL_STOP" });
    seedTrade({ id: "op", account: "momentum_crypto", entry: todayStart + 3_000 });
    // Excluded: sync_* row and a shadow book round trip.
    seedTrade({ id: "sync_1_x", account: "momentum_crypto", entry: todayStart + 1_000, exit: todayStart + 2_000 });
    seedTrade({ id: "sh", account: "shadow_meanrev_wide", entry: todayStart + 1_000, exit: todayStart + 2_000 });

    await withServer(async (port) => {
      const k = await (await fetch(`http://127.0.0.1:${port}/api/kpis`)).json() as any;
      expect(k.volume.today).toBe(3);
      expect(k.volume.avg7d).toBeCloseTo(3 / 7, 6);
      expect(k.targets).toEqual({ tradesPerDay: null, dailyReturnPct: null, riskBudgetDdPct: null });
    });
  });

  test("env targets flow through; return and drawdown derive from the consolidated series", async () => {
    process.env.KPI_TARGET_TRADES_PER_DAY = "30";
    process.env.KPI_TARGET_DAILY_RETURN_PCT = "0.12";
    process.env.KPI_RISK_BUDGET_DD_PCT = "25";
    resetInstanceConfigForTests();

    const bucket = (ms: number) => Math.floor(ms / 300_000) * 300_000;
    const now = bucket(Date.now()) - 300_000;
    const tenDaysAgo = now - 10 * 86_400_000;
    // Both legs present at both buckets → consolidated 100k → 110k over 10d,
    // with a 120k peak in between (drawdown from peak).
    saveEquitySnapshot("alpaca_main", 90_000, 90_000, 0, tenDaysAgo);
    saveEquitySnapshot("binance_main", 10_000, 10_000, 0, tenDaysAgo);
    saveEquitySnapshot("alpaca_main", 110_000, 110_000, 0, now - 5 * 86_400_000);
    saveEquitySnapshot("binance_main", 10_000, 10_000, 0, now - 5 * 86_400_000);
    saveEquitySnapshot("alpaca_main", 100_000, 100_000, 0, now);
    saveEquitySnapshot("binance_main", 10_000, 10_000, 0, now);

    await withServer(async (port) => {
      const k = await (await fetch(`http://127.0.0.1:${port}/api/kpis`)).json() as any;
      expect(k.targets).toEqual({ tradesPerDay: 30, dailyReturnPct: 0.12, riskBudgetDdPct: 25 });
      // (110/100)^(1/10) − 1 ≈ 0.9576%/day over the ~10-day window.
      expect(k.ret.dailyAvgPct30d).toBeCloseTo((Math.pow(110_000 / 100_000, 1 / 10) - 1) * 100, 1);
      // Peak 120k → now 110k ⇒ ~8.33% drawdown.
      expect(k.risk.peakEquity).toBe(120_000);
      expect(k.risk.equity).toBe(110_000);
      expect(k.risk.drawdownPct).toBeCloseTo(((120_000 - 110_000) / 120_000) * 100, 4);
    });
  });
});

describe("GET /api/funnel", () => {
  // The days=1 window is the ET day: passes stamped "1 h / 30 min ago" fell
  // into YESTERDAY whenever the suite ran between 00:00 and 01:00 ET, and the
  // prod deploy gate would have parked a deploy at that hour (2026-10-12
  // audit). Pin the clock to noon ET.
  afterEach(() => setSystemTime());

  test("aggregates decision passes per portfolio and pairs them with live orders/day and the design figures", async () => {
    setSystemTime(new Date("2026-10-12T16:00:00Z"));
    const now = Date.now();
    insertDecisionPass({
      accountId: "momentum_crypto", ts: now - 3_600_000, universe: 8, evaluated: 8,
      signalsLong: 2, signalsShort: 0, entries: 1, exits: 1,
      blocks: { risk_gate: 1 }, blockNote: "drawdown 7% > 5%", slotsUsed: 3, slotsTotal: 4,
    });
    insertDecisionPass({
      accountId: "momentum_crypto", ts: now - 1_800_000, universe: 8, evaluated: 8,
      signalsLong: 1, signalsShort: 0, entries: 0, exits: 0,
      blocks: { no_slot: 2 }, slotsUsed: 4, slotsTotal: 4,
    });
    const todayStart = getETDayStart(now);
    seedTrade({ id: "a", account: "momentum_crypto", entry: todayStart + 1_000, exit: todayStart + 2_000, closeReason: "TRAIL_STOP" });

    await withServer(async (port) => {
      const f = await (await fetch(`http://127.0.0.1:${port}/api/funnel?days=1`)).json() as any;
      expect(f.days).toBe(1);
      const crypto = f.accounts.find((a: any) => a.accountId === "momentum_crypto");
      expect(crypto.passes).toBe(2);
      expect(crypto.universe).toBe(8);
      expect(crypto.signalsLong).toBe(3);
      expect(crypto.entries).toBe(1);
      expect(crypto.exits).toBe(1);
      expect(crypto.blocks).toEqual({ risk_gate: 1, no_slot: 2 });
      expect(crypto.lastBlockNote).toBe("drawdown 7% > 5%");
      expect(crypto.slotsUsed).toBe(4);
      expect(crypto.liveOrders).toBe(2); // the round trip = 2 orders
      expect(crypto.designOpsPerDay).toBe(DESIGN_OPS_PER_DAY.momentum_crypto);
      expect(crypto.designOrdersPerDay).toBeCloseTo(DESIGN_OPS_PER_DAY.momentum_crypto * 2, 9);
      // Every designed portfolio appears even without telemetry yet.
      for (const id of Object.keys(DESIGN_OPS_PER_DAY)) {
        expect(f.accounts.some((a: any) => a.accountId === id)).toBe(true);
      }
      expect(f.totals.designOrdersPerDay).toBeCloseTo(
        Object.values(DESIGN_OPS_PER_DAY).reduce((s, v) => s + v * 2, 0), 9);
    });
  });

  test("exposes gate binding and sleeve exposure (latest, 5-pass mean, low flag); old rows stay null", async () => {
    setSystemTime(new Date("2026-10-12T16:00:00Z"));
    const now = Date.now();
    const base = { universe: 4, evaluated: 4, signalsLong: 0, signalsShort: 0, entries: 0, exits: 0, blocks: {} };
    // Legacy row (no new fields) for a sleeve that never measured anything.
    insertDecisionPass({ accountId: "momentum_crypto_usdc", ts: now - 600_000, ...base });
    // 7 measured passes: the first two are healthy, the last five deploy 40% of intent.
    for (let i = 0; i < 7; i++) {
      const healthy = i < 2;
      insertDecisionPass({
        accountId: "momentum_crypto", ts: now - (7 - i) * 60_000, ...base,
        signalsRawLong: 1, signalsAfterGates: healthy ? 1 : 0,
        gateBinding: healthy ? [] : ["regime"],
        exposureReal: healthy ? 0.5 : 0.2, exposureIntended: 0.5,
      });
    }
    await withServer(async (port) => {
      const f = await (await fetch(`http://127.0.0.1:${port}/api/funnel?days=1`)).json() as any;
      const c = f.accounts.find((a: any) => a.accountId === "momentum_crypto");
      expect(c.signalsRawLong).toBe(7);
      expect(c.signalsAfterGates).toBe(2);
      expect(c.gateBinding).toEqual({ regime: 5 });
      expect(c.gateBindingPasses).toBe(7);
      expect(c.exposure.latest.real).toBeCloseTo(0.2, 9);
      expect(c.exposure.latest.ratio).toBeCloseTo(0.4, 9);
      expect(c.exposure.mean5.passes).toBe(5); // the 2 healthy passes fall out of the window
      expect(c.exposure.mean5.ratio).toBeCloseTo(0.4, 9);
      expect(c.exposure.threshold).toBe(0.8);
      expect(c.exposure.low).toBe(true);
      const legacy = f.accounts.find((a: any) => a.accountId === "momentum_crypto_usdc");
      expect(legacy.passes).toBe(1);
      expect(legacy.signalsRawLong).toBeNull();
      expect(legacy.signalsAfterGates).toBeNull();
      expect(legacy.gateBinding).toEqual({});
      expect(legacy.gateBindingPasses).toBe(0);
      expect(legacy.exposure).toBeNull();
      // Existing fields keep their meaning for both.
      expect(c.signalsLong).toBe(0);
    });
  });

  test("days is clamped to 1..30 and defaults to 7", async () => {
    await withServer(async (port) => {
      const def = await (await fetch(`http://127.0.0.1:${port}/api/funnel`)).json() as any;
      expect(def.days).toBe(7);
      const clamped = await (await fetch(`http://127.0.0.1:${port}/api/funnel?days=400`)).json() as any;
      expect(clamped.days).toBe(30);
    });
  });
});
