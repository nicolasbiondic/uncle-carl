// SwitchingAdapter.scalePosition (RW4a exposure control, 2026-10-23) —
// routing + gating contract:
//   • a LIVE row for the symbol → the real adapter (whatever the mode);
//     no row → the shadow book;
//   • a reduction (factor < 1) is veto-free like a close: HALTED risk state
//     and TRADING_ENABLED=false never block de-risking;
//   • an add-back (factor > 1) is gated like an open: RiskEngine HALTED /
//     REDUCING and the TRADING_ENABLED backstop both deny it;
//   • a target adapter without the method answers ok:false "unsupported",
//     never an emulated close+reopen.
import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { getDB } from "../db/database";
import { SwitchingAdapter } from "./SwitchingAdapter";
import { makeTestDb } from "../test-support/db";
import { RiskEngine, type RiskEngineState } from "../risk/RiskEngine";
import type { MomentumBrokerAdapter } from "../strategies/momentum/MomentumEngine";

beforeAll(() => { makeTestDb(); });
afterEach(() => { delete process.env.TRADING_ENABLED; });

function fakeRiskPersistence() {
  let saved: RiskEngineState | null = null;
  return { load: () => saved, save: (s: RiskEngineState) => { saved = s; } };
}

function fakeAdapter(name: string, withScale = true) {
  const calls: any[] = [];
  const adapter: MomentumBrokerAdapter = {
    getOpenPositions: async () => [{ symbol: "SOL/USDC", side: "buy", quantity: 10, notional: 1300 }],
    getEquity: async () => 100,
    getRealisedPnlSince: async () => 0,
    openPosition: async () => ({ ok: true, reason: name }),
    closePosition: async () => ({ ok: true, reason: name }),
    fetchCandles: async () => [],
    ...(withScale ? { scalePosition: async (a: any) => { calls.push(a); return { ok: true, reason: name }; } } : {}),
  };
  return { adapter, calls };
}

let seq = 0;
function seedLiveRow(account: string, symbol: string) {
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity, entry_time, status, account_id, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(`sws_${seq++}`, symbol, "crypto", "buy", "MOMENTUM", 100, 1, Date.now(), "open", account, account);
}

function make(liveAccount: string, opts: { mode?: "live" | "shadow"; risk?: RiskEngine; realScale?: boolean } = {}) {
  const real = fakeAdapter("real", opts.realScale ?? true);
  const shadow = fakeAdapter("shadow");
  const sw = new SwitchingAdapter("momentum_crypto_usdc", { getMode: () => opts.mode ?? "live" }, real.adapter, shadow.adapter, liveAccount,
    opts.risk ?? new RiskEngine({}, fakeRiskPersistence()));
  return { sw, real, shadow };
}

describe("SwitchingAdapter.scalePosition — routing", () => {
  test("live row → real adapter, even in shadow mode (a demoted engine keeps resizing the real position it holds)", async () => {
    seedLiveRow("sws_acct_a", "SOL/USDC");
    const { sw, real, shadow } = make("sws_acct_a", { mode: "shadow" });
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.8, reason: "r" });
    expect(res.reason).toBe("real");
    expect(real.calls).toEqual([{ symbol: "SOL/USDC", side: "buy", factor: 0.8, reason: "r" }]);
    expect(shadow.calls).toEqual([]);
  });

  test("no live row → shadow book", async () => {
    const { sw, real, shadow } = make("sws_acct_b", { mode: "shadow" });
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.8 });
    expect(res.reason).toBe("shadow");
    expect(shadow.calls.length).toBe(1);
    expect(real.calls).toEqual([]);
  });

  test("real adapter without scalePosition → ok:false unsupported, nothing emulated", async () => {
    seedLiveRow("sws_acct_c", "SOL/USDC");
    const { sw, shadow } = make("sws_acct_c", { realScale: false });
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.8 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("unsupported");
    expect(shadow.calls).toEqual([]);
  });
});

describe("SwitchingAdapter.scalePosition — a reduction is de-risking, an add-back is an entry", () => {
  test("HALTED + TRADING_ENABLED=false: factor < 1 still reaches the real adapter", async () => {
    process.env.TRADING_ENABLED = "false";
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("HALTED", "incident");
    seedLiveRow("sws_acct_d", "SOL/USDC");
    const { sw, real } = make("sws_acct_d", { risk });
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.5 });
    expect(res.ok).toBe(true);
    expect(real.calls.length).toBe(1);
  });

  test("HALTED: factor > 1 denied before either adapter", async () => {
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("HALTED", "incident");
    seedLiveRow("sws_acct_e", "SOL/USDC");
    const { sw, real, shadow } = make("sws_acct_e", { risk });
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
    expect(res).toEqual({ ok: false, reason: "TRADING_STATE_HALTED" });
    expect(real.calls.length + shadow.calls.length).toBe(0);
  });

  test("REDUCING: factor > 1 denied (adds increase exposure), factor < 1 allowed", async () => {
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("REDUCING", "wind-down");
    seedLiveRow("sws_acct_f", "SOL/USDC");
    const { sw, real } = make("sws_acct_f", { risk });
    expect((await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.2 })).reason).toBe("TRADING_STATE_REDUCING");
    expect((await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.9 })).ok).toBe(true);
    expect(real.calls.length).toBe(1);
  });

  test("ACTIVE with a per-order notional cap: the add's notional = (factor − 1) × held mark notional → over-cap denied, under-cap allowed", async () => {
    const risk = new RiskEngine({ maxNotionalPerOrderUsd: 500 }, fakeRiskPersistence());
    seedLiveRow("sws_acct_cap", "SOL/USDC");
    const { sw, real } = make("sws_acct_cap", { risk });
    expect((await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 })).reason).toBe("NOTIONAL_EXCEEDS_MAXIMUM"); // +650
    expect((await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.3 })).ok).toBe(true);                             // +390
    expect(real.calls.length).toBe(1);
  });

  test("TRADING_ENABLED=false: factor > 1 denied with trading_disabled", async () => {
    process.env.TRADING_ENABLED = "false";
    seedLiveRow("sws_acct_g", "SOL/USDC");
    const { sw, real } = make("sws_acct_g");
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
    expect(res).toEqual({ ok: false, reason: "trading_disabled" });
    expect(real.calls).toEqual([]);
  });
});
