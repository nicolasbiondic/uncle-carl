import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { getDB } from "../db/database";
import {
  RiskEngine,
  evaluateSubmitCore,
  INITIAL_RISK_ENGINE_STATE,
  dbSyncStatePersistence,
  getDefaultRiskEngine,
  _resetDefaultRiskEngineForTests,
  buildDefaultRiskEngineConfigFromEnv,
  type RiskEngineState,
  type RiskOrder,
} from "./RiskEngine";
import { makeTestDb } from "../test-support/db";

beforeAll(() => {
  makeTestDb();
});

beforeEach(() => {
  delete process.env.RISK_ENGINE_STATE;
  getDB().prepare(`DELETE FROM sync_state`).run();
  _resetDefaultRiskEngineForTests();
});

function order(overrides: Partial<RiskOrder> = {}): RiskOrder {
  return { sleeve: "momentum_stocks", symbol: "AAPL", side: "buy", notionalUsd: 1000, ...overrides };
}

const ACTIVE: RiskEngineState = { ...INITIAL_RISK_ENGINE_STATE };
const HALTED: RiskEngineState = { tradingState: "HALTED", reason: "incident", changedAt: 1 };
const REDUCING: RiskEngineState = { tradingState: "REDUCING", reason: "wind-down", changedAt: 1 };

// In-memory fake persistence for tests that don't need real sqlite round-trips.
function fakePersistence() {
  let saved: RiskEngineState | null = null;
  return {
    load: () => saved,
    save: (s: RiskEngineState) => { saved = s; },
  };
}

describe("evaluateSubmitCore — default no-op", () => {
  test("empty config + ACTIVE state + realistic order → allow", () => {
    const decision = evaluateSubmitCore(ACTIVE, order(), {}, {}, 0);
    expect(decision.allow).toBe(true);
  });
});

describe("evaluateSubmitCore — TradingState effect on submit", () => {
  test("ACTIVE → normal order allowed", () => {
    expect(evaluateSubmitCore(ACTIVE, order(), {}, {}, 0).allow).toBe(true);
  });

  test("HALTED → denies a normal (exposure-increasing) submit", () => {
    const d = evaluateSubmitCore(HALTED, order(), {}, {}, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("TRADING_STATE_HALTED");
  });

  test("HALTED → denies even a genuine reduce-only submit (HALTED blocks ALL new submits; cancels are the only escape, and they don't go through this path)", () => {
    const ctx = { currentPositionSide: "buy" as const, currentPositionQty: 5 };
    const d = evaluateSubmitCore(HALTED, order({ side: "sell", quantity: 5, reduceOnly: true }), ctx, {}, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("TRADING_STATE_HALTED");
  });

  test("REDUCING → denies an exposure-increasing submit (flat → new position)", () => {
    const d = evaluateSubmitCore(REDUCING, order(), {}, {}, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("TRADING_STATE_REDUCING");
  });

  test("REDUCING → allows a genuine reduce-only submit (doesn't increase exposure)", () => {
    const ctx = { currentPositionSide: "buy" as const, currentPositionQty: 5 };
    const d = evaluateSubmitCore(REDUCING, order({ side: "sell", quantity: 5, reduceOnly: true }), ctx, {}, 0);
    expect(d.allow).toBe(true);
  });

  test("REDUCING → denies an opposite-side order whose quantity EXCEEDS the current holding (would flip past flat, net-increasing)", () => {
    const ctx = { currentPositionSide: "buy" as const, currentPositionQty: 5 };
    const d = evaluateSubmitCore(REDUCING, order({ side: "sell", quantity: 5.01 }), ctx, {}, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("TRADING_STATE_REDUCING");
  });
});

describe("evaluateSubmitCore — reduceOnly integrity check is independent of TradingState", () => {
  test("ACTIVE + reduceOnly=true but order actually increases exposure (flat) → denied", () => {
    const d = evaluateSubmitCore(ACTIVE, order({ reduceOnly: true }), {}, {}, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("REDUCE_ONLY_INCREASES_EXPOSURE");
  });

  test("ACTIVE + reduceOnly=true, same side as current holding (adds to it) → denied", () => {
    const ctx = { currentPositionSide: "buy" as const, currentPositionQty: 5 };
    const d = evaluateSubmitCore(ACTIVE, order({ side: "buy", quantity: 1, reduceOnly: true }), ctx, {}, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("REDUCE_ONLY_INCREASES_EXPOSURE");
  });

  test("ACTIVE + reduceOnly=true, opposite side, qty within holding → allowed", () => {
    const ctx = { currentPositionSide: "buy" as const, currentPositionQty: 5 };
    const d = evaluateSubmitCore(ACTIVE, order({ side: "sell", quantity: 3, reduceOnly: true }), ctx, {}, 0);
    expect(d.allow).toBe(true);
  });
});

describe("evaluateSubmitCore — cancel/query are structurally out of scope", () => {
  test("RiskEngine exposes only evaluateSubmit — no cancel/query method exists to accidentally wire the veto into", () => {
    const engine = new RiskEngine({}, fakePersistence());
    expect(typeof (engine as any).evaluateCancel).toBe("undefined");
    expect(typeof (engine as any).evaluateQuery).toBe("undefined");
    expect(typeof engine.evaluateSubmit).toBe("function");
  });
});

describe("evaluateSubmitCore — notional cap, at the boundary", () => {
  test("notional exactly at the cap → allowed", () => {
    const d = evaluateSubmitCore(ACTIVE, order({ notionalUsd: 10_000 }), {}, { maxNotionalPerOrderUsd: 10_000 }, 0);
    expect(d.allow).toBe(true);
  });

  test("notional one cent over the cap → denied", () => {
    const d = evaluateSubmitCore(ACTIVE, order({ notionalUsd: 10_000.01 }), {}, { maxNotionalPerOrderUsd: 10_000 }, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.code).toBe("NOTIONAL_EXCEEDS_MAXIMUM");
      expect(d.context.max_notional_usd).toBe(10_000);
    }
  });

  test("per-sleeve cap overrides the global cap", () => {
    const cfg = { maxNotionalPerOrderUsd: 10_000, maxNotionalPerOrderUsdBySleeve: { momentum_stocks: 500 } };
    const d = evaluateSubmitCore(ACTIVE, order({ notionalUsd: 501 }), {}, cfg, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.context.max_notional_usd).toBe(500);
  });
});

describe("evaluateSubmitCore — rate limit, at the boundary", () => {
  const cfg = { rateLimit: { maxSubmits: 3, windowMs: 60_000 } };

  test("prior submits below the limit → allowed", () => {
    expect(evaluateSubmitCore(ACTIVE, order(), {}, cfg, 2).allow).toBe(true);
  });

  test("prior submits AT the limit → denied", () => {
    const d = evaluateSubmitCore(ACTIVE, order(), {}, cfg, 3);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(d.context.max_submits).toBe(3);
    }
  });
});

describe("evaluateSubmitCore — quantity/price positivity and precision, at the boundary", () => {
  test("notional exactly 0 → denied", () => {
    const d = evaluateSubmitCore(ACTIVE, order({ notionalUsd: 0 }), {}, {}, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("NOTIONAL_NOT_POSITIVE");
  });

  test("notional just above 0 → allowed", () => {
    expect(evaluateSubmitCore(ACTIVE, order({ notionalUsd: 0.01 }), {}, {}, 0).allow).toBe(true);
  });

  test("negative quantity → denied", () => {
    const d = evaluateSubmitCore(ACTIVE, order({ quantity: -1 }), {}, {}, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("QUANTITY_NOT_POSITIVE");
  });

  test("zero price → denied", () => {
    const d = evaluateSubmitCore(ACTIVE, order({ price: 0 }), {}, {}, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("PRICE_NOT_POSITIVE");
  });

  test("quantity precision exactly at the limit → allowed", () => {
    const d = evaluateSubmitCore(ACTIVE, order({ quantity: 1.23 }), {}, { maxQuantityDecimals: 2 }, 0);
    expect(d.allow).toBe(true);
  });

  test("quantity precision one decimal past the limit → denied", () => {
    const d = evaluateSubmitCore(ACTIVE, order({ quantity: 1.234 }), {}, { maxQuantityDecimals: 2 }, 0);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("QUANTITY_PRECISION_EXCEEDED");
  });
});

describe("RiskEngine class — denial codes carry structured key=value context", () => {
  test("detail string matches the CODE: key=value, key2=value2 shape", () => {
    const engine = new RiskEngine({ maxNotionalPerOrderUsd: 100 }, fakePersistence());
    const d = engine.evaluateSubmit(order({ notionalUsd: 200 }));
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.detail).toBe("NOTIONAL_EXCEEDS_MAXIMUM: notional_usd=200, max_notional_usd=100, sleeve=momentum_stocks, symbol=AAPL");
      expect(d.context).toEqual({ notional_usd: 200, max_notional_usd: 100, sleeve: "momentum_stocks", symbol: "AAPL" });
    }
  });
});

describe("RiskEngine class — rate limiting is stateful across evaluateSubmit calls", () => {
  test("allowed submits consume the window budget; denied submits don't", () => {
    const engine = new RiskEngine({ rateLimit: { maxSubmits: 2, windowMs: 60_000 } }, fakePersistence());
    const now = 1_000_000;
    expect(engine.evaluateSubmit(order(), {}, now).allow).toBe(true);
    expect(engine.evaluateSubmit(order(), {}, now + 1).allow).toBe(true);
    const third = engine.evaluateSubmit(order(), {}, now + 2);
    expect(third.allow).toBe(false);
    // A denied submit doesn't consume budget — retrying at the same instant
    // still denies (still 2 in-window), it doesn't escalate further.
    const fourth = engine.evaluateSubmit(order(), {}, now + 3);
    expect(fourth.allow).toBe(false);
    // Once the window has fully rolled past, budget frees up again.
    const later = engine.evaluateSubmit(order(), {}, now + 60_001);
    expect(later.allow).toBe(true);
  });

  test("rate limit is per-sleeve — one sleeve's submits don't consume another's budget", () => {
    const engine = new RiskEngine({ rateLimit: { maxSubmits: 1, windowMs: 60_000 } }, fakePersistence());
    expect(engine.evaluateSubmit(order({ sleeve: "a" })).allow).toBe(true);
    expect(engine.evaluateSubmit(order({ sleeve: "b" })).allow).toBe(true);
    expect(engine.evaluateSubmit(order({ sleeve: "a" })).allow).toBe(false);
  });
});

describe("RiskEngine class — setTradingState + env override", () => {
  test("setTradingState changes the effective state immediately", () => {
    const engine = new RiskEngine({}, fakePersistence());
    expect(engine.getState().tradingState).toBe("ACTIVE");
    engine.setTradingState("HALTED", "manual test halt");
    expect(engine.getState().tradingState).toBe("HALTED");
    expect(engine.evaluateSubmit(order()).allow).toBe(false);
  });

  test("RISK_ENGINE_STATE env var overrides the persisted state, read fresh (no caching)", () => {
    const engine = new RiskEngine({}, fakePersistence());
    engine.setTradingState("ACTIVE", "baseline");
    process.env.RISK_ENGINE_STATE = "REDUCING";
    expect(engine.getState().tradingState).toBe("REDUCING");
    expect(engine.evaluateSubmit(order()).allow).toBe(false);
    delete process.env.RISK_ENGINE_STATE;
    expect(engine.getState().tradingState).toBe("ACTIVE");
  });
});

describe("RiskEngine class — TradingState persists across restarts (sync_state)", () => {
  test("a new RiskEngine instance backed by dbSyncStatePersistence sees the previous instance's setTradingState", () => {
    const first = new RiskEngine({}, dbSyncStatePersistence);
    first.setTradingState("REDUCING", "wind-down before retirement");
    // Simulate a restart: a brand new instance, same persistence, no shared memory.
    const second = new RiskEngine({}, dbSyncStatePersistence);
    expect(second.getState().tradingState).toBe("REDUCING");
    expect(second.getState().reason).toBe("wind-down before retirement");
  });

  test("clean first boot (no sync_state row yet) defaults to ACTIVE", () => {
    getDB().prepare(`DELETE FROM sync_state`).run();
    const engine = new RiskEngine({}, dbSyncStatePersistence);
    expect(engine.getState().tradingState).toBe("ACTIVE");
  });
});

describe("getDefaultRiskEngine — lazy singleton", () => {
  test("returns the same instance across calls", () => {
    const a = getDefaultRiskEngine();
    const b = getDefaultRiskEngine();
    expect(a).toBe(b);
  });

  test("default instance allows a realistic order (well under the default $25k cap)", () => {
    const engine = getDefaultRiskEngine();
    expect(engine.evaluateSubmit(order()).allow).toBe(true);
  });
});

// AUDIT B2 (2026-09-20): getDefaultRiskEngine() used to construct
// `new RiskEngine({})` — a declared no-op with NO absolute $ ceiling.
// Percentage-based sizing (MEANREV_BASE_USD × slot%, momentum equity ×
// weight × leverage) had nothing stopping an order-of-magnitude typo from
// submitting a six-figure order. These pin the default cap and its
// per-sleeve override, reading env explicitly (never the real process.env).
describe("buildDefaultRiskEngineConfigFromEnv — absolute $ cap (B2)", () => {
  test("no env override → default cap is exactly 25_000, no per-sleeve overrides", () => {
    const cfg = buildDefaultRiskEngineConfigFromEnv({});
    expect(cfg.maxNotionalPerOrderUsd).toBe(25_000);
    expect(cfg.maxNotionalPerOrderUsdBySleeve).toBeUndefined();
  });

  test("RISK_MAX_NOTIONAL_PER_ORDER_USD overrides the global default", () => {
    const cfg = buildDefaultRiskEngineConfigFromEnv({ RISK_MAX_NOTIONAL_PER_ORDER_USD: "5000" });
    expect(cfg.maxNotionalPerOrderUsd).toBe(5000);
  });

  test("a non-numeric/zero/negative override is ignored, falling back to the 25_000 default", () => {
    expect(buildDefaultRiskEngineConfigFromEnv({ RISK_MAX_NOTIONAL_PER_ORDER_USD: "not-a-number" }).maxNotionalPerOrderUsd).toBe(25_000);
    expect(buildDefaultRiskEngineConfigFromEnv({ RISK_MAX_NOTIONAL_PER_ORDER_USD: "0" }).maxNotionalPerOrderUsd).toBe(25_000);
    expect(buildDefaultRiskEngineConfigFromEnv({ RISK_MAX_NOTIONAL_PER_ORDER_USD: "-100" }).maxNotionalPerOrderUsd).toBe(25_000);
  });

  test("RISK_MAX_NOTIONAL_PER_ORDER_USD_<SLEEVE> sets a per-sleeve override (sleeve name uppercased)", () => {
    const cfg = buildDefaultRiskEngineConfigFromEnv({ RISK_MAX_NOTIONAL_PER_ORDER_USD_MEANREV_STOCKS: "10000" });
    expect(cfg.maxNotionalPerOrderUsdBySleeve).toEqual({ meanrev_stocks: 10_000 });
  });

  test("an order at the default cap ($25k) is allowed via evaluateSubmitCore; one dollar over is denied with NOTIONAL_EXCEEDS_MAXIMUM", () => {
    const cfg = buildDefaultRiskEngineConfigFromEnv({});
    const allowed = evaluateSubmitCore(ACTIVE, order({ notionalUsd: 24_000 }), {}, cfg, 0);
    expect(allowed.allow).toBe(true);
    const denied = evaluateSubmitCore(ACTIVE, order({ notionalUsd: 26_000 }), {}, cfg, 0);
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.code).toBe("NOTIONAL_EXCEEDS_MAXIMUM");
  });

  test("a per-sleeve override takes precedence over the global default for that sleeve only", () => {
    const cfg = buildDefaultRiskEngineConfigFromEnv({ RISK_MAX_NOTIONAL_PER_ORDER_USD_MEANREV_STOCKS: "10000" });
    const meanrevOver = evaluateSubmitCore(ACTIVE, order({ sleeve: "meanrev_stocks", notionalUsd: 15_000 }), {}, cfg, 0);
    expect(meanrevOver.allow).toBe(false);
    // Another sleeve (no override) still uses the 25_000 global default.
    const stocksUnderGlobal = evaluateSubmitCore(ACTIVE, order({ sleeve: "momentum_stocks", notionalUsd: 15_000 }), {}, cfg, 0);
    expect(stocksUnderGlobal.allow).toBe(true);
  });

  test("getDefaultRiskEngine() actually wires the env-derived cap end-to-end", () => {
    process.env.RISK_MAX_NOTIONAL_PER_ORDER_USD = "1000";
    try {
      const engine = getDefaultRiskEngine();
      expect(engine.evaluateSubmit(order({ notionalUsd: 900 })).allow).toBe(true);
      const d = engine.evaluateSubmit(order({ notionalUsd: 1_100 }));
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.code).toBe("NOTIONAL_EXCEEDS_MAXIMUM");
    } finally {
      delete process.env.RISK_MAX_NOTIONAL_PER_ORDER_USD;
    }
  });
});

// (h) Closes are never vetoed by RiskEngine — already pinned end-to-end at
// the SwitchingAdapter integration layer (out of this module's ownership):
// see "SwitchingAdapter — RiskEngine veto NEVER applies to closePosition, in
// any TradingState" in src/governor/SwitchingAdapter.test.ts. RiskEngine
// itself has no close/cancel method at all (see the class docstring) — the
// veto is structurally reachable only from evaluateSubmit, never from a
// close path.
