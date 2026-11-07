import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { SwitchingAdapter } from "./SwitchingAdapter";
import { makeTestDb } from "../test-support/db";
import { RiskEngine } from "../risk/RiskEngine";
import type { MomentumBrokerAdapter } from "../strategies/momentum/MomentumEngine";
import type { CurrentPosition } from "../strategies/momentum/Rebalancer";
import type { RiskEngineState } from "../risk/RiskEngine";

// In-memory fake persistence, mirroring RiskEngine.test.ts — keeps these
// integration tests independent of the shared default singleton / sync_state.
function fakeRiskPersistence() {
  let saved: RiskEngineState | null = null;
  return { load: () => saved, save: (s: RiskEngineState) => { saved = s; } };
}

beforeAll(() => {
  makeTestDb();
});

function fakeAdapter(name: string, positions: CurrentPosition[] = []) {
  const calls: string[] = [];
  const adapter: MomentumBrokerAdapter = {
    getOpenPositions: async () => { calls.push("positions"); return positions; },
    getEquity: async () => { calls.push("equity"); return 111; },
    getRealisedPnlSince: async () => { calls.push("pnl"); return 11; },
    openPosition: async () => { calls.push("open"); return { ok: true, reason: name }; },
    closePosition: async () => { calls.push("close"); return { ok: true, reason: name }; },
    fetchCandles: async () => { calls.push("candles"); return []; },
  };
  return { adapter, calls };
}

function makeSwitching(riskEngine?: RiskEngine) {
  const real = fakeAdapter("real", [{ symbol: "AAPL", side: "buy", quantity: 1, notional: 100 }]);
  const sw = riskEngine
    ? new SwitchingAdapter("sleeve_x", real.adapter, riskEngine)
    : new SwitchingAdapter("sleeve_x", real.adapter);
  return { sw, real };
}

test("strict overlay UTC history reaches the real data source; legacy calls retain two arguments", async () => {
  const { sw, real } = makeSwitching();
  const calls: unknown[][] = [];
  real.adapter.fetchDailyCloses = async (...args) => { calls.push(args); return [100]; };
  expect(await sw.fetchDailyCloses("BTC/USD", 611, { strictUtc: true })).toEqual([100]);
  expect(await sw.fetchDailyCloses("BTC/USD", 65)).toEqual([100]);
  expect(calls).toEqual([["BTC/USD", 611, { strictUtc: true }], ["BTC/USD", 65]]);
});

test("Turtle daily OHLC routes to real data; role/N and every exit label survive the wrapper", async () => {
  const { sw, real } = makeSwitching();
  const dataCalls: unknown[][] = [];
  real.adapter.fetchDailyBars = async (...args) => { dataCalls.push(args); return []; };
  await sw.fetchDailyBars("BTC/USD", 55); expect(dataCalls).toEqual([["BTC/USD", 55]]);
  const candleCalls: unknown[][] = [];
  real.adapter.fetchCandles = async (...args) => { candleCalls.push(args); return []; };
  await sw.fetchCandles("BTC/USD", 50, { strictVenue: true });
  expect(candleCalls).toEqual([["BTC/USD", 50, { strictVenue: true }]]);
  const opens: any[] = [], closes: any[] = [];
  real.adapter.openPosition = async a => { opens.push(a); return { ok: true }; };
  real.adapter.closePosition = async a => { closes.push(a); return { ok: true }; };
  const a = { symbol: "BTC/USD", side: "sell" as const, notionalUsd: 100, role: "breakout-short" as const, breakout: { n: 2, stopN: 2, quantity: 1 } };
  await sw.openPosition(a); expect(opens).toEqual([a]);
  const long = { ...a, side: "buy" as const, role: "breakout-long" as const };
  await sw.openPosition(long); expect(opens).toEqual([a, long]);
  for (const closeReason of ["BREAKOUT_SHORT_EXIT", "BREAKOUT_SHORT_STOP", "BREAKOUT_SHORT_PRIORITY", "BREAKOUT_SHORT_DRAWDOWN", "BREAKOUT_SHORT_TIME_STOP"]) await sw.closePosition({ symbol: "BTC/USD", side: "sell", closeReason });
  expect(closes.map(c => c.closeReason)).toEqual(["BREAKOUT_SHORT_EXIT", "BREAKOUT_SHORT_STOP", "BREAKOUT_SHORT_PRIORITY", "BREAKOUT_SHORT_DRAWDOWN", "BREAKOUT_SHORT_TIME_STOP"]);
  for (const closeReason of ["BREAKOUT_LONG_EXIT", "BREAKOUT_LONG_STOP", "BREAKOUT_LONG_PRIORITY", "BREAKOUT_LONG_DRAWDOWN", "BREAKOUT_LONG_TIME_STOP"]) await sw.closePosition({ symbol: "BTC/USD", side: "buy", closeReason });
  expect(closes.slice(5).map(c => c.closeReason)).toEqual(["BREAKOUT_LONG_EXIT", "BREAKOUT_LONG_STOP", "BREAKOUT_LONG_PRIORITY", "BREAKOUT_LONG_DRAWDOWN", "BREAKOUT_LONG_TIME_STOP"]);
});

// Maintenance kill-switch backstop (TRADING_ENABLED=false, src/config/
// index.ts): openPosition must never reach the real adapter on a host
// explicitly configured not to open new positions. closePosition is
// untouched by the switch — existing positions must always be manageable.
describe("SwitchingAdapter — TRADING_ENABLED=false backstop (defense in depth)", () => {
  // Restore to DELETED, not to a load-time snapshot: the preload guarantees
  // the var is unset when the suite starts, and a snapshot taken after some
  // other file polluted env would "restore" the pollution (the 2026-07-31
  // verify-deploy dotenv incident propagated exactly this way).
  afterEach(() => {
    delete process.env.TRADING_ENABLED;
  });

  test("TRADING_ENABLED=false → openPosition never reaches the real adapter", async () => {
    process.env.TRADING_ENABLED = "false";
    const { sw, real } = makeSwitching();
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trading_disabled");
    expect(real.calls).not.toContain("open");
  });

  test("TRADING_ENABLED=false → closePosition STILL reaches the real adapter (closes always work)", async () => {
    process.env.TRADING_ENABLED = "false";
    const { sw, real } = makeSwitching();
    const res = await sw.closePosition({ symbol: "AAPL", side: "buy" });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("close");
  });

  test("TRADING_ENABLED unset → openPosition reaches the real adapter (default preserved)", async () => {
    delete process.env.TRADING_ENABLED;
    const { sw, real } = makeSwitching();
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("open");
  });
});

describe("SwitchingAdapter — every order and every read reaches the real broker (no shadow routing since 2026-11-07)", () => {
  test("open / close / positions / equity / realised pnl / candles all delegate to the real adapter", async () => {
    const { sw, real } = makeSwitching();
    expect((await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 })).reason).toBe("real");
    expect((await sw.closePosition({ symbol: "AAPL", side: "buy" })).reason).toBe("real");
    expect((await sw.getOpenPositions()).map(p => p.symbol)).toEqual(["AAPL"]);
    expect(await sw.getEquity()).toBe(111);
    expect(await sw.getRealisedPnlSince(0)).toBe(11);
    await sw.fetchCandles("AAPL", 100);
    expect(real.calls).toEqual(expect.arrayContaining(["open", "close", "positions", "equity", "pnl", "candles"]));
  });

  test("the wrapper takes no mode source and no shadow adapter (revert canary)", () => {
    expect(SwitchingAdapter.length).toBeLessThanOrEqual(3); // (sleeve, real, riskEngine?)
  });
});

// ── RiskEngine veto integration (block 8) ──────────────────────────────
describe("SwitchingAdapter — RiskEngine veto in openPosition", () => {
  test("default (no explicit riskEngine passed) → behaves exactly as before (byte-identical, no-op)", async () => {
    const { sw, real } = makeSwitching();
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("open");
  });

  test("HALTED riskEngine → openPosition denied BEFORE reaching the adapter", async () => {
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("HALTED", "test incident");
    const { sw, real } = makeSwitching(risk);
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("TRADING_STATE_HALTED");
    expect(real.calls).not.toContain("open");
  });

  test("REDUCING riskEngine → openPosition denied (an open always increases exposure)", async () => {
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("REDUCING", "test wind-down");
    const { sw, real } = makeSwitching(risk);
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("TRADING_STATE_REDUCING");
    expect(real.calls).not.toContain("open");
  });

  test("ACTIVE riskEngine with a notional cap → over-cap open denied, under-cap open allowed", async () => {
    const risk = new RiskEngine({ maxNotionalPerOrderUsd: 500 }, fakeRiskPersistence());
    const { sw: swOver, real: realOver } = makeSwitching(risk);
    const over = await swOver.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 501 });
    expect(over.ok).toBe(false);
    expect(over.reason).toBe("NOTIONAL_EXCEEDS_MAXIMUM");
    expect(realOver.calls).not.toContain("open");

    const { sw: swUnder, real: realUnder } = makeSwitching(risk);
    const under = await swUnder.openPosition({ symbol: "MSFT", side: "buy", notionalUsd: 500 });
    expect(under.ok).toBe(true);
    expect(realUnder.calls).toContain("open");
  });
});

describe("SwitchingAdapter — RiskEngine veto NEVER applies to closePosition, in any TradingState", () => {
  for (const state of ["ACTIVE", "HALTED", "REDUCING"] as const) {
    test(`state=${state} → closePosition still reaches the real adapter`, async () => {
      const risk = new RiskEngine({}, fakeRiskPersistence());
      if (state !== "ACTIVE") risk.setTradingState(state, `test ${state}`);
      const { sw, real } = makeSwitching(risk);
      const res = await sw.closePosition({ symbol: "AAPL", side: "buy" });
      expect(res.ok).toBe(true);
      expect(res.reason).toBe("real");
      expect(real.calls).toContain("close");
    });
  }
});
