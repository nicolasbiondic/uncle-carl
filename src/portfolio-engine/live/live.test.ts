// Client order id format, persistence round trip, schedule windows,
// HistoricalPriceView point-in-time + freshness, registry factory hook.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { getDB } from "../../db/database";
import { makeTestDb } from "../../test-support/db";
import { isPortfolioClientOrderId, portfolioClientOrderId, PORTFOLIO_CLIENT_ID_MAX_LEN } from "./clientOrderId";
import { getPortfolioDecision, latestPortfolioMemory, savePortfolioDecision, updatePortfolioDecisionProgress, type PortfolioDecisionRecord } from "./persistence";
import { runWindow } from "./schedule";
import { HistoricalPriceView } from "./priceView";
import { buildPortfolioEngine, venueProfile } from "./factory";
import { buildPortfolioPlan } from "../../portfolios/factory";
import { portfolioUniverse } from "../../portfolios/validate";
import type { PortfolioDefinition, PortfolioEngineParams } from "../../portfolios/types";
import { FakeVenue, XASSET, makeHistDb, weekdaySessions } from "./testSupport";

beforeAll(() => { makeTestDb(); });
beforeEach(() => { getDB().exec("DELETE FROM portfolio_decisions;"); });

describe("portfolioClientOrderId", () => {
  test("deterministic per (sleeve, session, symbol); distinct across each; uc8-attributed; ≤ 36 chars", () => {
    const a = portfolioClientOrderId("momentum_stocks", "2026-10-20", "SPY");
    expect(a).toBe(portfolioClientOrderId("momentum_stocks", "2026-10-20", "SPY"));
    expect(a).not.toBe(portfolioClientOrderId("momentum_stocks", "2026-10-21", "SPY"));
    expect(a).not.toBe(portfolioClientOrderId("momentum_stocks", "2026-10-20", "TLT"));
    expect(a).not.toBe(portfolioClientOrderId("meanrev_stocks", "2026-10-20", "SPY"));
    expect(a.startsWith("uc8-momentum_sto-pf")).toBe(true);
    expect(a.length).toBeLessThanOrEqual(PORTFOLIO_CLIENT_ID_MAX_LEN);
    expect(isPortfolioClientOrderId(a)).toBe(true);
    expect(isPortfolioClientOrderId("uc8-momentum_stocks-" + "a".repeat(16))).toBe(false);
    // Binance charset: [.A-Z:/a-z0-9_-]
    expect(/^[.A-Za-z0-9:/_-]{1,36}$/.test(portfolioClientOrderId("momentum_crypto_usdc", "2026-10-20", "BTC/USDC"))).toBe(true);
  });
});

describe("portfolio_decisions round trip", () => {
  test("save → read back equal; progress patch; memory per version", () => {
    const rec: PortfolioDecisionRecord = {
      accountId: "s", strategyVersion: "v1", session: "2026-10-20", asOf: "2026-10-19", mode: "live", status: "decided",
      equity: 1234.5, book: [{ symbol: "SPY", qty: 1.5, avgEntryPrice: 480 }], weights: { SPY: 0.5 },
      stops: [{ symbol: "SPY", stopPrice: 460 }], memory: { portfolioCore: { version: 1, signals: { SPY: true }, stops: {} } },
      diagnostics: { scale: 0.8, nested: { a: [1, 2] } },
      orders: [{ intent: { symbol: "SPY", side: "buy", qty: 1, notional: 500, targetWeight: 0.5, currentWeight: 0, reduceOnly: false }, clientOrderId: "id", result: null, applied: false }],
      note: null, decidedAt: 1, updatedAt: 1,
    };
    savePortfolioDecision(rec);
    const back = getPortfolioDecision("s", "v1", "2026-10-20")!;
    expect({ ...back, id: undefined }).toEqual({ ...rec, id: undefined });
    updatePortfolioDecisionProgress({ accountId: "s", strategyVersion: "v1", session: "2026-10-20" }, { status: "submitted", memory: { x: 1 }, note: "done" }, 9);
    const after = getPortfolioDecision("s", "v1", "2026-10-20")!;
    expect(after).toMatchObject({ status: "submitted", memory: { x: 1 }, note: "done", updatedAt: 9 });
    expect(latestPortfolioMemory("s", "v1")).toEqual({ x: 1 });
    expect(latestPortfolioMemory("s", "v2")).toEqual({});
    // Same key → upsert (memory back to rec's), not a second row.
    savePortfolioDecision({ ...rec, equity: 1 });
    expect(getDB().prepare("SELECT COUNT(*) c FROM portfolio_decisions").get()).toEqual({ c: 1 });
    expect(latestPortfolioMemory("s", "v1")).toEqual(rec.memory);
    // skipped_stale rows do not feed memory.
    savePortfolioDecision({ ...rec, session: "2026-10-21", status: "skipped_stale", memory: { stale: true } });
    expect(latestPortfolioMemory("s", "v1")).toEqual(rec.memory);
  });
});

describe("runWindow", () => {
  test("stocks: trading day ≥ 09:35 ET → today's session on the previous trading day's data", () => {
    expect(runWindow("stocks", Date.parse("2026-10-20T13:34:00Z"))).toBeNull();                    // 09:34 ET
    expect(runWindow("stocks", Date.parse("2026-10-20T13:35:00Z"))).toEqual({ session: "2026-10-20", asOf: "2026-10-19" });
    expect(runWindow("stocks", Date.parse("2026-10-19T15:00:00Z"))).toEqual({ session: "2026-10-19", asOf: "2026-10-16" }); // Monday ← Friday
    expect(runWindow("stocks", Date.parse("2026-10-24T15:00:00Z"))).toBeNull();                    // Saturday
    expect(runWindow("stocks", Date.parse("2026-11-26T15:00:00Z"))).toBeNull();                    // Thanksgiving
    expect(runWindow("stocks", Date.parse("2026-11-27T15:00:00Z"))).toEqual({ session: "2026-11-27", asOf: "2026-11-25" });
  });
  test("stocks: excludes the regular close, early closes and after-hours restarts (DST-safe)", () => {
    expect(runWindow("stocks", Date.parse("2026-10-28T19:59:59Z"))).not.toBeNull(); // 15:59 EDT
    expect(runWindow("stocks", Date.parse("2026-10-28T20:00:00Z"))).toBeNull();
    expect(runWindow("stocks", Date.parse("2026-10-28T22:22:00Z"))).toBeNull();
    expect(runWindow("stocks", Date.parse("2026-11-02T20:59:59Z"))).not.toBeNull(); // 15:59 EST
    expect(runWindow("stocks", Date.parse("2026-11-02T21:00:00Z"))).toBeNull();
    expect(runWindow("stocks", Date.parse("2026-11-27T17:59:59Z"))).not.toBeNull(); // 12:59 EST, Black Friday
    expect(runWindow("stocks", Date.parse("2026-11-27T18:00:00Z"))).toBeNull();
  });
  test("crypto: every UTC day ≥ 00:00:15", () => {
    expect(runWindow("crypto", Date.parse("2026-10-20T00:00:10Z"))).toBeNull();
    expect(runWindow("crypto", Date.parse("2026-10-20T00:00:15Z"))).toEqual({ session: "2026-10-20", asOf: "2026-10-19" });
    expect(runWindow("crypto", Date.parse("2026-10-24T12:00:00Z"))).toEqual({ session: "2026-10-24", asOf: "2026-10-23" });
  });
});

describe("HistoricalPriceView", () => {
  test("never returns a bar after asOf; history oldest→newest; freshness classifies stale/missing", () => {
    const sessions = weekdaySessions("2026-10-20", 10);
    const db = makeHistDb({ SPY: { sessions }, TLT: { sessions: sessions.slice(0, 8) } });
    const v = new HistoricalPriceView({ db, asOf: "2026-10-19", symbols: ["SPY", "TLT", "GLD"] });
    const h = v.history("SPY", 3);
    expect(h.map(b => b.date)).toEqual(["2026-10-15", "2026-10-16", "2026-10-19"]);
    expect(v.barCount("SPY")).toBe(9);
    expect(v.history("SPY", 100)).toHaveLength(9);
    expect(v.history("GLD", 5)).toEqual([]);
    expect(v.lastClose("SPY")).toBe(100 + 8);
    expect(v.freshness(["SPY", "TLT", "GLD"])).toEqual({ asOf: "2026-10-19", fresh: ["SPY"], stale: ["TLT"], missing: ["GLD"] });
  });
  test("Binance 00:00Z stamps and a symbol map", () => {
    const db = makeHistDb({ "BTC/USD": { sessions: ["2026-10-18", "2026-10-19"] } }, 0);
    const v = new HistoricalPriceView({ db, asOf: "2026-10-19", symbols: ["BTC"], dataSymbol: s => `${s}/USD` });
    expect(v.history("BTC", 5).map(b => b.date)).toEqual(["2026-10-18", "2026-10-19"]);
  });
});

describe("registry hook: template 'portfolio'", () => {
  const params: PortfolioEngineParams = {
    engine: "portfolio", strategy: XASSET, venue: "alpaca", runMode: "observer", strategyVersion: "d1-v1",
    heartbeatName: "portfolio:d1", loggerContext: "Portfolio:d1", minOrderNotional: 5, rebalanceBand: 0,
  };
  const def: PortfolioDefinition = { id: "xasset_trend", name: "D1", template: "portfolio", account: "alpaca_main", capital: 50_000, mode: "live", enabled: false, params };

  test("buildPortfolioPlan returns the engine plan with a daily heartbeat", () => {
    const plan = buildPortfolioPlan(def, Date.now());
    expect(plan).toEqual({
      template: "portfolio", portfolioId: "xasset_trend", account: "alpaca_main", capital: 50_000, params,
      heartbeat: { name: "portfolio:d1", intervalMs: 86_400_000, graceMultiplier: 5 },
    });
    expect(() => buildPortfolioPlan({ ...def, params: { ...params, engine: "x" } as any }, Date.now())).toThrow(/params.engine/);
  });

  test("portfolioUniverse reads the design's universe (factorCore declares none)", () => {
    expect(portfolioUniverse("portfolio", params)).toEqual(["SPY", "TLT", "GLD"]);
    expect(portfolioUniverse("portfolio", { ...params, strategy: { kind: "factorCore" } as any })).toEqual([]);
  });

  test("buildPortfolioEngine wires the plan, refuses a venue mismatch and factorCore without membership", () => {
    const plan = buildPortfolioPlan(def, Date.now());
    if (plan.template !== "portfolio") throw new Error("expected portfolio plan");
    const registered: any[] = [];
    const hb = { register: (...a: any[]) => registered.push(a), beat: () => {} };
    const db = makeHistDb({});
    const e = buildPortfolioEngine(plan, { venue: new FakeVenue("alpaca"), historicalDb: db, heartbeats: hb });
    expect(e.accountId).toBe("xasset_trend");
    expect(e.mode).toBe("observer");
    e.start(); e.stop();
    expect(registered).toEqual([["portfolio:d1", 86_400_000, { graceMultiplier: 5 }]]);
    expect(() => buildPortfolioEngine(plan, { venue: new FakeVenue("binance_usdm"), historicalDb: db })).toThrow(/venue/);
    const core = { ...plan, params: { ...params, strategy: { kind: "factorCore" } as any } };
    expect(() => buildPortfolioEngine(core, { venue: new FakeVenue("alpaca"), historicalDb: db })).toThrow(/MembershipView/);
    expect(venueProfile("binance_usdc")).toEqual({ market: "crypto", rowMarket: "crypto", quoteAsset: "USDC" });
  });
});
