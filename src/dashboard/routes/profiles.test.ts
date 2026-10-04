import express from "express";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveEquitySnapshot, upsertAssetBalance } from "../../db/database";
import { setBrokerTruthAvailable } from "../../portfolio/truth";
import { registerProfileRoutes, readPersistedRiskState, SLEEVE_STATE_FILES } from "./profiles";
import { makeTestDb, seedOpenTrade } from "../../test-support/db";
import { _resetLastConstructedSleeveGovernorForTests } from "../../governor/SleeveGovernor";

const am = {
  getBrokerUnrealizedPnl: () => 0,
  executor: {
    alpaca: { isConnected: () => false },
    binance: { isConnected: () => false },
  },
} as any;

async function getProfiles(days?: number) {
  const app = express();
  registerProfileRoutes(app, am);
  const server = app.listen(0);
  try {
    const address = server.address() as { port: number };
    const qs = days == null ? "" : `?days=${days}`;
    return await (await fetch(`http://127.0.0.1:${address.port}/api/v2/profiles${qs}`)).json() as any[];
  } finally {
    server.close();
  }
}

describe("GET /api/v2/profiles broker truth", () => {
  test("preserves missing snapshots and real zero values", async () => {
    makeTestDb();
    setBrokerTruthAvailable("alpaca", true);
    setBrokerTruthAvailable("binance", true);

    let [profile] = await getProfiles();
    expect(profile.brokerAccounts).toHaveLength(2);
    expect(profile.brokerAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ brokerId: "alpaca_paper", equity: null, availableCash: null }),
      expect.objectContaining({ brokerId: "binance_testnet", equity: null, availableCash: null }),
    ]));
    expect(profile.totalEquity).toBeNull();

    saveEquitySnapshot("alpaca_main", 0, 0, 0);
    saveEquitySnapshot("binance_main", 0, 0, 0);
    [profile] = await getProfiles();
    expect(profile.brokerAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ brokerId: "alpaca_paper", equity: 0, availableCash: 0 }),
      expect.objectContaining({ brokerId: "binance_testnet", equity: 0, availableCash: 0 }),
    ]));
    expect(profile.totalEquity).toBe(0);
  });
});

describe("GET /api/v2/profiles pct fields", () => {
  test("stats carries periodEquityPnlPct/equityPnl7dPct beside the pnl figures — server-computed, no frontend division needed", async () => {
    makeTestDb();
    setBrokerTruthAvailable("alpaca", true);
    setBrokerTruthAvailable("binance", true);

    const t0 = Date.now() - 3 * 86_400_000;
    saveEquitySnapshot("alpaca_main", 100_000, 100_000, 0, t0);
    saveEquitySnapshot("alpaca_main", 110_000, 110_000, 0, Date.now());

    // days=0 (all-time) anchors at the very first snapshot — deterministic,
    // no ET-day-boundary math needed for this wiring test.
    const [profile] = await getProfiles(0);
    const alpaca = profile.brokerAccounts.find((ba: any) => ba.brokerId === "alpaca_paper");
    expect(alpaca.stats.periodEquityPnl).toBeCloseTo(10_000, 5);
    expect(alpaca.stats.periodEquityPnlPct).toBeCloseTo(10, 5); // (110k-100k)/100k * 100
    // equityPnl7dPct sits alongside the fixed-7D pnl figure, independent of
    // the selected `days` window.
    expect(typeof alpaca.stats.equityPnl7d).toBe("number");
    expect(typeof alpaca.stats.equityPnl7dPct === "number" || alpaca.stats.equityPnl7dPct === null).toBe(true);
  });
});

describe("GET /api/v2/profiles Binance margin decomposition (mandate 2026-07-19)", () => {
  test("production shape: all 4 sub-wallets active — marginBreakdown sourced independently, never derived by decomposing `equity`", async () => {
    makeTestDb();
    setBrokerTruthAvailable("alpaca", true);
    setBrokerTruthAvailable("binance", true);
    setBrokerTruthAvailable("coinm", true);
    saveEquitySnapshot("binance_main", 5_600, 5_600, 0); // FAPI total
    saveEquitySnapshot("binance_coinm_main", 1_200, 1_200, 0); // DAPI total
    upsertAssetBalance("binance_testnet", "USDT", 4_700, 4_700, 4_700);
    upsertAssetBalance("binance_testnet", "USDC", 900, 900, 900);
    upsertAssetBalance("binance_testnet", "BTC", 0.01, 0.01, 650);

    const amFull = {
      ...am,
      getAccountSummaries: () => [
        { id: "momentum_crypto", equity: 4_700 },
        { id: "momentum_crypto_usdc", equity: 900 },
        { id: "momentum_btc", equity: 1_200 },
      ],
    } as any;
    const app = express();
    registerProfileRoutes(app, amFull);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const [profile] = await (await fetch(`http://127.0.0.1:${port}/api/v2/profiles`)).json() as any[];
      const binance = profile.brokerAccounts.find((ba: any) => ba.brokerId === "binance_testnet");
      expect(binance.marginBreakdown).toEqual({
        usdtFutures: 4_700, usdcFutures: 900, fapiBtcCollateral: 650, coinmMargin: 1_200,
      });
      // Header total = FAPI main + DAPI main (5_600 + 1_200), independent of
      // the component sum — both should agree closely (same underlying
      // wallets), proving neither path double-counts the other.
      expect(binance.equity).toBe(6_800);
    } finally {
      server.close();
    }
  });

  test("USDC/COIN-M inactive: their components stay null, never a fabricated 0", async () => {
    makeTestDb();
    setBrokerTruthAvailable("alpaca", true);
    setBrokerTruthAvailable("binance", true);
    upsertAssetBalance("binance_testnet", "USDT", 5_000, 5_000, 5_000);
    const amPartial = { ...am, getAccountSummaries: () => [{ id: "momentum_crypto", equity: 5_000 }] } as any;
    const app = express();
    registerProfileRoutes(app, amPartial);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const [profile] = await (await fetch(`http://127.0.0.1:${port}/api/v2/profiles`)).json() as any[];
      const binance = profile.brokerAccounts.find((ba: any) => ba.brokerId === "binance_testnet");
      expect(binance.marginBreakdown.usdtFutures).toBe(5_000);
      expect(binance.marginBreakdown.usdcFutures).toBeNull();
      expect(binance.marginBreakdown.coinmMargin).toBeNull();
    } finally {
      server.close();
    }
  });
});

describe("readPersistedRiskState — RiskState file reader (dashboard-only, read-only)", () => {
  test("reads the v1 envelope shape ({ v:1, risk: {...} })", () => {
    const dir = mkdtempSync(join(tmpdir(), "risk-state-"));
    const file = join(dir, "momentum-state-crypto.json");
    writeFileSync(file, JSON.stringify({ v: 1, risk: { peakEquity: 6_000, dayStartEquity: 5_800, consecutiveLosses: 2, pausedUntil: 123, pauseReason: "soft drawdown" }, trailMarks: {} }));
    expect(readPersistedRiskState(file)).toEqual({
      peakEquity: 6_000, dayStartEquity: 5_800, consecutiveLosses: 2, pausedUntil: 123, pauseReason: "soft drawdown",
    });
  });

  test("reads the legacy flat shape (pre-envelope prod files)", () => {
    const dir = mkdtempSync(join(tmpdir(), "risk-state-"));
    const file = join(dir, "momentum-state-stocks.json");
    writeFileSync(file, JSON.stringify({ peakEquity: 50_000, dayStartEquity: 49_000, consecutiveLosses: 0, pausedUntil: 0, pauseReason: "" }));
    expect(readPersistedRiskState(file)).toEqual({
      peakEquity: 50_000, dayStartEquity: 49_000, consecutiveLosses: 0, pausedUntil: 0, pauseReason: "",
    });
  });

  test("missing/corrupt/malformed file returns null, never throws", () => {
    expect(readPersistedRiskState("/nonexistent/path.json")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "risk-state-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json");
    expect(readPersistedRiskState(file)).toBeNull();
  });
});

describe("GET /api/v2/sleeves/risk", () => {
  function riskAm(overrides: any = {}) {
    return {
      ...am,
      getCircuits: () => ({}),
      getAccountSummaries: () => [],
      ...overrides,
    } as any;
  }
  async function getSleeveRisk(amInstance: any) {
    // Test isolation: getLastConstructedSleeveGovernor() is a module-level
    // singleton (src/governor/SleeveGovernor.ts) — whatever governor another
    // test file in this SAME bun test process last constructed (with
    // whatever sleeve/cache state it left) would otherwise leak in here when
    // the whole suite runs together (health.test.ts hits the exact same
    // issue and resets it too). null ⇒ the route falls back to "live", the
    // documented default when no governor is wired.
    _resetLastConstructedSleeveGovernorForTests();
    const app = express();
    registerProfileRoutes(app, amInstance);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      return await (await fetch(`http://127.0.0.1:${port}/api/v2/sleeves/risk`)).json() as any;
    } finally { server.close(); }
  }

  test("a paused sleeve reports mode=paused, the cause, resume ETA, and null DD when no state file exists", async () => {
    const db = makeTestDb();
    // One closed trade (−120) and one still-open one: realized must be the
    // closed-trade sum, never the summary's equity-based totalPnl (+999 below,
    // which already includes unrealized P&L).
    db.prepare(`INSERT INTO trades (id, symbol, market, side, strategy, entry_price, exit_price, quantity, pnl, entry_time, exit_time, status, account_id, close_reason)
                VALUES ('c1','SOL/USD','crypto','buy','MOMENTUM',100,88,10,-120,?,?,'closed','momentum_crypto','BROKER_STOP_LOSS')`).run(Date.now() - 7_200_000, Date.now() - 3_600_000);
    seedOpenTrade("o1", "momentum_crypto", { symbol: "ETH/USD", market: "crypto" });
    const resumeAt = Date.now() + 3_600_000;
    // Point the sleeve at a path that cannot exist: prod (and any checkout
    // that ever ran an engine) HAS data/momentum-state-crypto.json, and the
    // auto-deploy gate runs this suite there.
    const original = SLEEVE_STATE_FILES.momentum_crypto;
    SLEEVE_STATE_FILES.momentum_crypto = join(mkdtempSync(join(tmpdir(), "sleeve-risk-")), "absent.json");
    let res: any;
    try {
      res = await getSleeveRisk(riskAm({
        getCircuits: () => ({ momentum_crypto: { paused: true, reason: "soft drawdown 12.3% — paused 24h", resumeAt } }),
        getAccountSummaries: () => [{ id: "momentum_crypto", label: "Momentum Crypto", broker: "binance", equity: 4_500, totalPnl: 999 }],
      }));
    } finally { SLEEVE_STATE_FILES.momentum_crypto = original; }
    expect(res.sleeves).toHaveLength(1);
    const s = res.sleeves[0];
    expect(s.id).toBe("momentum_crypto");
    expect(s.mode).toBe("paused");
    expect(s.paused).toBe(true);
    expect(s.reason).toBe("soft drawdown 12.3% — paused 24h");
    expect(s.resumeAt).toBe(resumeAt);
    expect(s.realizedPnl).toBe(-120);
    // No state file for the sleeve — DD must be null, never fabricated.
    expect(s.drawdown.currentPct).toBeNull();
    expect(s.drawdown.softPct).toBeCloseTo(0.10, 6);
    expect(s.drawdown.hardPct).toBeCloseTo(0.20, 6);
  });

  test("a running sleeve with no circuit entry defaults to not-paused, mode=live", async () => {
    makeTestDb();
    const res = await getSleeveRisk(riskAm({
      getAccountSummaries: () => [{ id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", equity: 49_000, totalPnl: 900 }],
    }));
    const s = res.sleeves[0];
    expect(s.paused).toBe(false);
    expect(s.mode).toBe("live");
    expect(s.reason).toBeNull();
    expect(s.resumeAt).toBeNull();
  });
});

// 2026-09-29 (owner: "Esos +4000 no los veo"): the KPI P&L is the change in
// value; the realized P&L of the same window rides beside it, and the full
// attribution is one request away.
describe("realized beside the P&L + GET /api/v2/pnl-breakdown", () => {
  const amWithPositions = (positions: any[]) => ({ ...am, getConsolidatedState: () => ({ positions }) }) as any;

  async function get(path: string, amInstance: any) {
    const app = express();
    registerProfileRoutes(app, amInstance);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      return await (await fetch(`http://127.0.0.1:${port}${path}`)).json() as any;
    } finally {
      server.close();
    }
  }

  test("pnlAggregate carries the realized P&L and close count of the period and of 7D", async () => {
    makeTestDb();
    const { getDB, getETDayStart } = await import("../../db/database");
    const now = Date.now();
    // Inside today's ET day whatever the clock says (the suite may run just
    // after ET midnight).
    const exit = Math.max(getETDayStart(now) + 1_000, now - 60_000);
    seedOpenTrade("closed-today", "momentum_stocks", { symbol: "META", entryPrice: 600, quantity: 10, entryTime: exit - 500 });
    getDB().prepare(`UPDATE trades SET status='closed', exit_time=?, exit_price=610, pnl=100 WHERE id='closed-today'`).run(exit);
    const [profile] = await get("/api/v2/profiles?days=1", amWithPositions([]));
    expect(profile.pnlAggregate).toMatchObject({ periodRealized: 100, periodRealizedCount: 1, realized7d: 100, realized7dCount: 1 });
  });

  test("the breakdown adds up: realized − earned before + open change + other = the P&L", async () => {
    makeTestDb();
    const now = Date.now();
    // 7D window (starts ≥ 6 days back): everything below sits inside it at
    // any time of day, so no historical price is ever needed.
    seedOpenTrade("win", "meanrev_stocks", { symbol: "KO", entryPrice: 80, quantity: 50, entryTime: now - 3_600_000 });
    const { getDB } = await import("../../db/database");
    getDB().prepare(`UPDATE trades SET status='closed', exit_time=?, exit_price=81, pnl=50 WHERE id='win'`).run(now - 60_000);
    const b = await get("/api/v2/pnl-breakdown?days=7", amWithPositions([
      { profileId: "momentum_stocks", symbol: "SMH", market: "stock", side: "buy", quantity: 10, avgEntryPrice: 600, openedAt: now - 1_800_000, currentPrice: 603 },
    ]));
    expect(b.periodDays).toBe(7);
    expect(b.realized).toBe(50);
    expect(b.count).toBe(1);
    expect(b.earnedBefore).toBe(0);
    expect(b.openChange).toBeCloseTo(30, 6);
    if (b.pnl != null) expect(b.closedInWindow + b.openChange + b.other).toBeCloseTo(b.pnl, 6);
  });
});
