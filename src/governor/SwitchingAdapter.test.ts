import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { getDB } from "../db/database";
import { SwitchingAdapter } from "./SwitchingAdapter";
import { makeTestDb } from "../test-support/db";
import { SleeveGovernor } from "./SleeveGovernor";
import { RiskEngine } from "../risk/RiskEngine";
import type { MomentumBrokerAdapter } from "../strategies/momentum/MomentumEngine";
import type { SleeveMode } from "./SleeveGovernor";
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
    getEquity: async () => { calls.push("equity"); return name === "real" ? 111 : 999; },
    getRealisedPnlSince: async () => { calls.push("pnl"); return name === "real" ? 11 : 99; },
    openPosition: async () => { calls.push("open"); return { ok: true, reason: name }; },
    closePosition: async () => { calls.push("close"); return { ok: true, reason: name }; },
    fetchCandles: async () => { calls.push("candles"); return []; },
  };
  return { adapter, calls };
}

let seq = 0;
function seedOpenLiveRow(account: string, symbol: string) {
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity, entry_time, status, account_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(`sw_${seq++}`, symbol, "stock", "buy", "TEST", 100, 1, Date.now(), "open", account, account);
}

function makeSwitching(mode: () => SleeveMode, liveAccount: string, riskEngine?: RiskEngine) {
  const real = fakeAdapter("real", [{ symbol: "AAPL", side: "buy", quantity: 1, notional: 100 }]);
  const shadow = fakeAdapter("shadow", [{ symbol: "MSFT", side: "buy", quantity: 2, notional: 200 }]);
  const sw = riskEngine
    ? new SwitchingAdapter("sleeve_x", { getMode: () => mode() }, real.adapter, shadow.adapter, liveAccount, riskEngine)
    : new SwitchingAdapter("sleeve_x", { getMode: () => mode() }, real.adapter, shadow.adapter, liveAccount);
  return { sw, real, shadow };
}

// Maintenance kill-switch backstop (TRADING_ENABLED=false, src/config/
// index.ts): even in mode=live, openPosition must never reach the real
// adapter on a host explicitly configured not to open new positions.
// closePosition is untouched by the switch — existing positions must always
// be manageable.
describe("SwitchingAdapter — TRADING_ENABLED=false backstop (defense in depth)", () => {
  // Restore to DELETED, not to a load-time snapshot: the preload guarantees
  // the var is unset when the suite starts, and a snapshot taken after some
  // other file polluted env would "restore" the pollution (the 2026-07-31
  // verify-deploy dotenv incident propagated exactly this way).
  afterEach(() => {
    delete process.env.TRADING_ENABLED;
  });

  test("mode=live, TRADING_ENABLED=false → openPosition never reaches the real adapter", async () => {
    process.env.TRADING_ENABLED = "false";
    const { sw, real, shadow } = makeSwitching(() => "live", "sw_acct_notrade_a");
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trading_disabled");
    expect(real.calls).not.toContain("open");
    expect(shadow.calls).not.toContain("open");
  });

  test("mode=live, TRADING_ENABLED=false → closePosition STILL reaches the real adapter (closes always work)", async () => {
    process.env.TRADING_ENABLED = "false";
    seedOpenLiveRow("sw_acct_notrade_b", "AAPL");
    const { sw, real } = makeSwitching(() => "live", "sw_acct_notrade_b");
    const res = await sw.closePosition({ symbol: "AAPL", side: "buy" });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("close");
  });

  test("mode=live, TRADING_ENABLED unset → openPosition reaches the real adapter (default preserved)", async () => {
    delete process.env.TRADING_ENABLED;
    const { sw, real } = makeSwitching(() => "live", "sw_acct_notrade_c");
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("open");
  });
});

describe("SwitchingAdapter — open routing by governor mode", () => {
  test("mode=live → real adapter opens", async () => {
    const { sw, real, shadow } = makeSwitching(() => "live", "sw_acct_a");
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("open");
    expect(shadow.calls).not.toContain("open");
  });

  test("mode=shadow → shadow adapter opens", async () => {
    const { sw, real, shadow } = makeSwitching(() => "shadow", "sw_acct_b");
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.reason).toBe("shadow");
    expect(shadow.calls).toContain("open");
    expect(real.calls).not.toContain("open");
  });
});

describe("SwitchingAdapter — close prefers the real broker when a live row exists", () => {
  test("open live DB row → real close even in shadow mode (never strand a broker position)", async () => {
    seedOpenLiveRow("sw_acct_c", "AAPL");
    const { sw, real, shadow } = makeSwitching(() => "shadow", "sw_acct_c");
    const res = await sw.closePosition({ symbol: "AAPL", side: "buy" });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("close");
    expect(shadow.calls).not.toContain("close");
  });

  test("no live row → shadow close", async () => {
    const { sw, real, shadow } = makeSwitching(() => "shadow", "sw_acct_d");
    const res = await sw.closePosition({ symbol: "AAPL", side: "buy" });
    expect(res.reason).toBe("shadow");
    expect(shadow.calls).toContain("close");
    expect(real.calls).not.toContain("close");
  });
});

describe("SwitchingAdapter — positions union and pass-throughs", () => {
  test("mode=live → live rows only", async () => {
    const { sw } = makeSwitching(() => "live", "sw_acct_e");
    const pos = await sw.getOpenPositions();
    expect(pos.map(p => p.symbol)).toEqual(["AAPL"]);
  });

  test("mode=shadow → live rows PLUS shadow rows (engine keeps managing residual real exits)", async () => {
    const { sw } = makeSwitching(() => "shadow", "sw_acct_f");
    const pos = await sw.getOpenPositions();
    expect(pos.map(p => p.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  test("equity / realised pnl / candles always delegate to the real adapter", async () => {
    const { sw, real, shadow } = makeSwitching(() => "shadow", "sw_acct_g");
    expect(await sw.getEquity()).toBe(111);
    expect(await sw.getRealisedPnlSince(0)).toBe(11);
    await sw.fetchCandles("AAPL", 100);
    expect(real.calls).toEqual(expect.arrayContaining(["equity", "pnl", "candles"]));
    expect(shadow.calls).not.toContain("equity");
    expect(shadow.calls).not.toContain("candles");
  });
});

// ── Regression: SwitchingAdapter used to pass an explicit "live" default to
// getMode(), which overrode a registered kind:"shadow" fallback whenever no
// sleeve_modes row existed. Uses the REAL SleeveGovernor (not the fake
// ModeSource above) so the fallback + persistence + migration logic is
// exercised end to end. 2026-08-08 (owner mandate "always live"): migrateOnce
// REFUSES the shadow direction — the tests below lock the neutralization at
// the order-routing level.
describe("SwitchingAdapter + real SleeveGovernor — shadow-migration regression", () => {
  test("no persisted row → registered shadow kind wins (not a hardcoded 'live' default)", async () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "regr_no_row", kind: "shadow" });
    const real = fakeAdapter("real");
    const shadow = fakeAdapter("shadow");
    const sw = new SwitchingAdapter("regr_no_row", gov, real.adapter, shadow.adapter, "regr_no_row");

    const res = await sw.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
    expect(res.reason).toBe("shadow");
    expect(shadow.calls).toContain("open");
    expect(real.calls).not.toContain("open");
  });

  test("a shadow migration against a persisted 'live' row is NEUTRALIZED — orders keep routing to the real broker", async () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    // A live sleeve with a persisted row, exactly like prod's five sleeves.
    getDB().prepare(
      `INSERT INTO sleeve_modes (sleeve, mode, updated_at, reason) VALUES ('regr_legacy', 'live', ?, 'human-promoted live sleeve')`
    ).run(Date.now());
    gov.register({ sleeve: "regr_legacy", kind: "shadow" });

    const real1 = fakeAdapter("real");
    const shadow1 = fakeAdapter("shadow");
    const swBefore = new SwitchingAdapter("regr_legacy", gov, real1.adapter, shadow1.adapter, "regr_legacy");
    const resBefore = await swBefore.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
    expect(resBefore.reason).toBe("real"); // persisted live row wins over the registered fallback

    // A deploy-time shadow migration (the index.ts 2026-07-16 pattern) fires,
    // e.g. because a restored DB lost its governor_migrations marker. Owner
    // mandate: it must NOT be able to shadow a live sleeve on its own.
    gov.migrateOnce("regr_legacy_migration", "regr_legacy", "shadow", "deploy-time shadow migration");
    const real2 = fakeAdapter("real");
    const shadow2 = fakeAdapter("shadow");
    const swAfter = new SwitchingAdapter("regr_legacy", gov, real2.adapter, shadow2.adapter, "regr_legacy");
    const resAfter = await swAfter.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
    // REVERT CANARY: pre-mandate migrateOnce would route this to "shadow".
    expect(resAfter.reason).toBe("real");
    expect(real2.calls).toContain("open");
    expect(shadow2.calls).not.toContain("open");
  });

  test("a neutralized migration is idempotent and never clobbers a later manual promotion", () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "regr_promote", kind: "shadow" });
    gov.migrateOnce("regr_promote_migration", "regr_promote", "shadow", "initial migration");
    // No persisted row was written — the registered shadow fallback still applies.
    expect(gov.getMode("regr_promote")).toBe("shadow");

    // A human promotes it to live via setMode (set-sleeve-mode.ts path).
    gov.setMode("regr_promote", "live", "manual promotion (human)");
    expect(gov.getMode("regr_promote")).toBe("live");

    // A restart re-runs migrateOnce with the SAME name — must be a no-op.
    gov.migrateOnce("regr_promote_migration", "regr_promote", "shadow", "initial migration");
    expect(gov.getMode("regr_promote")).toBe("live");
  });

  test("cache expiry / repeated reads reflect DB truth, not a stale hardcoded default", async () => {
    const gov = new SleeveGovernor({ cacheMs: 1 }); // effectively-instant expiry
    gov.register({ sleeve: "regr_cache", kind: "shadow" });
    const real = fakeAdapter("real");
    const shadow = fakeAdapter("shadow");
    const sw = new SwitchingAdapter("regr_cache", gov, real.adapter, shadow.adapter, "regr_cache");

    for (let i = 0; i < 3; i++) {
      const res = await sw.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 });
      expect(res.reason).toBe("shadow");
      await new Promise(r => setTimeout(r, 5)); // let the cache expire between reads
    }
  });

  test("an existing real broker position is still closed via the real adapter after demotion", async () => {
    const gov = new SleeveGovernor({ cacheMs: 0 });
    gov.register({ sleeve: "regr_real_pos", kind: "shadow" });
    seedOpenLiveRow("regr_real_pos", "BTC/USD");

    const real = fakeAdapter("real");
    const shadow = fakeAdapter("shadow");
    const sw = new SwitchingAdapter("regr_real_pos", gov, real.adapter, shadow.adapter, "regr_real_pos");

    const res = await sw.closePosition({ symbol: "BTC/USD", side: "buy" });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("close");
    expect(shadow.calls).not.toContain("close");
  });
});

// ── RiskEngine veto integration (block 8) ──────────────────────────────
describe("SwitchingAdapter — RiskEngine veto in openPosition", () => {
  test("default (no explicit riskEngine passed) → behaves exactly as before (byte-identical, no-op)", async () => {
    const { sw, real } = makeSwitching(() => "live", "sw_acct_risk_default");
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.reason).toBe("real");
    expect(real.calls).toContain("open");
  });

  test("HALTED riskEngine → openPosition denied BEFORE reaching either adapter (real or shadow)", async () => {
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("HALTED", "test incident");
    const { sw, real, shadow } = makeSwitching(() => "live", "sw_acct_risk_halt", risk);
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("TRADING_STATE_HALTED");
    expect(real.calls).not.toContain("open");
    expect(shadow.calls).not.toContain("open");
  });

  test("HALTED riskEngine → applies even in mode=shadow (veto is upstream of mode routing)", async () => {
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("HALTED", "test incident");
    const { sw, shadow } = makeSwitching(() => "shadow", "sw_acct_risk_halt_shadow", risk);
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("TRADING_STATE_HALTED");
    expect(shadow.calls).not.toContain("open");
  });

  test("REDUCING riskEngine → openPosition denied (an open always increases exposure)", async () => {
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("REDUCING", "test wind-down");
    const { sw, real } = makeSwitching(() => "live", "sw_acct_risk_reducing", risk);
    const res = await sw.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("TRADING_STATE_REDUCING");
    expect(real.calls).not.toContain("open");
  });

  test("ACTIVE riskEngine with a notional cap → over-cap open denied, under-cap open allowed", async () => {
    const risk = new RiskEngine({ maxNotionalPerOrderUsd: 500 }, fakeRiskPersistence());
    const { sw: swOver, real: realOver } = makeSwitching(() => "live", "sw_acct_risk_cap_a", risk);
    const over = await swOver.openPosition({ symbol: "AAPL", side: "buy", notionalUsd: 501 });
    expect(over.ok).toBe(false);
    expect(over.reason).toBe("NOTIONAL_EXCEEDS_MAXIMUM");
    expect(realOver.calls).not.toContain("open");

    const { sw: swUnder, real: realUnder } = makeSwitching(() => "live", "sw_acct_risk_cap_b", risk);
    const under = await swUnder.openPosition({ symbol: "MSFT", side: "buy", notionalUsd: 500 });
    expect(under.ok).toBe(true);
    expect(realUnder.calls).toContain("open");
  });
});

describe("SwitchingAdapter — RiskEngine veto NEVER applies to closePosition, in any TradingState", () => {
  for (const state of ["ACTIVE", "HALTED", "REDUCING"] as const) {
    test(`state=${state} → closePosition still reaches the real adapter for an open live row`, async () => {
      const risk = new RiskEngine({}, fakeRiskPersistence());
      if (state !== "ACTIVE") risk.setTradingState(state, `test ${state}`);
      const acct = `sw_acct_risk_close_${state}`;
      seedOpenLiveRow(acct, "AAPL");
      const { sw, real } = makeSwitching(() => "live", acct, risk);
      const res = await sw.closePosition({ symbol: "AAPL", side: "buy" });
      expect(res.ok).toBe(true);
      expect(res.reason).toBe("real");
      expect(real.calls).toContain("close");
    });
  }
});
