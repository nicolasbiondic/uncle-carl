// SwitchingAdapter.scalePosition (RW4a exposure control, 2026-10-23) —
// gating contract (every resize reaches the real adapter: the shadow book
// was removed 2026-11-07):
//   • a reduction (factor < 1) is veto-free like a close: HALTED risk state
//     and TRADING_ENABLED=false never block de-risking;
//   • an add-back (factor > 1) is gated like an open: RiskEngine HALTED /
//     REDUCING and the TRADING_ENABLED backstop both deny it;
//   • a real adapter without the method answers ok:false "unsupported",
//     never an emulated close+reopen.
import { describe, expect, test, beforeAll, afterEach } from "bun:test";
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

function make(_liveAccount: string, opts: { risk?: RiskEngine; realScale?: boolean } = {}) {
  const real = fakeAdapter("real", opts.realScale ?? true);
  const sw = new SwitchingAdapter("momentum_crypto_usdc", real.adapter, opts.risk ?? new RiskEngine({}, fakeRiskPersistence()));
  return { sw, real };
}

describe("SwitchingAdapter.scalePosition — delegation", () => {
  test("a resize reaches the real adapter verbatim", async () => {
    const { sw, real } = make("sws_acct_a");
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.8, reason: "r" });
    expect(res.reason).toBe("real");
    expect(real.calls).toEqual([{ symbol: "SOL/USDC", side: "buy", factor: 0.8, reason: "r" }]);
  });

  test("real adapter without scalePosition → ok:false unsupported, nothing emulated", async () => {
    const { sw } = make("sws_acct_c", { realScale: false });
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.8 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("unsupported");
  });
});

describe("SwitchingAdapter.scalePosition — a reduction is de-risking, an add-back is an entry", () => {
  test("HALTED + TRADING_ENABLED=false: factor < 1 still reaches the real adapter", async () => {
    process.env.TRADING_ENABLED = "false";
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("HALTED", "incident");
    const { sw, real } = make("sws_acct_d", { risk });
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.5 });
    expect(res.ok).toBe(true);
    expect(real.calls.length).toBe(1);
  });

  test("HALTED: factor > 1 denied before the adapter", async () => {
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("HALTED", "incident");
    const { sw, real } = make("sws_acct_e", { risk });
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
    expect(res).toEqual({ ok: false, reason: "TRADING_STATE_HALTED" });
    expect(real.calls.length).toBe(0);
  });

  test("REDUCING: factor > 1 denied (adds increase exposure), factor < 1 allowed", async () => {
    const risk = new RiskEngine({}, fakeRiskPersistence());
    risk.setTradingState("REDUCING", "wind-down");
    const { sw, real } = make("sws_acct_f", { risk });
    expect((await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.2 })).reason).toBe("TRADING_STATE_REDUCING");
    expect((await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 0.9 })).ok).toBe(true);
    expect(real.calls.length).toBe(1);
  });

  test("ACTIVE with a per-order notional cap: the add's notional = (factor − 1) × held mark notional → over-cap denied, under-cap allowed", async () => {
    const risk = new RiskEngine({ maxNotionalPerOrderUsd: 500 }, fakeRiskPersistence());
    const { sw, real } = make("sws_acct_cap", { risk });
    expect((await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 })).reason).toBe("NOTIONAL_EXCEEDS_MAXIMUM"); // +650
    expect((await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.3 })).ok).toBe(true);                             // +390
    expect(real.calls.length).toBe(1);
  });

  test("TRADING_ENABLED=false: factor > 1 denied with trading_disabled", async () => {
    process.env.TRADING_ENABLED = "false";
    const { sw, real } = make("sws_acct_g");
    const res = await sw.scalePosition({ symbol: "SOL/USDC", side: "buy", factor: 1.5 });
    expect(res).toEqual({ ok: false, reason: "trading_disabled" });
    expect(real.calls).toEqual([]);
  });
});
