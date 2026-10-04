import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { coinmSkipStartupStopReconcile, startupBrokerHealth } from "./index";

// Wiring test for the momentum_btc/DAPI truth-only initialization line in
// main(): `candidate.init({ skipStartupStopReconcile:
// coinmSkipStartupStopReconcile(enabled, hasExposure) })`. Truth-only
// (flag OFF + no open DB exposure) must skip the mutating startup stop
// reconcile — see BinanceCoinMExecutor's own tests
// ("skipStartupStopReconcile:true never cancels/adopts a pre-existing owned
// stop") for proof that this option value actually prevents stop mutation.
// This test only proves index.ts computes the RIGHT option for each mode.
describe("coinmSkipStartupStopReconcile — truth-only wiring", () => {
  test("flag OFF + no exposure (truth-only) -> skip the mutating reconcile", () => {
    expect(coinmSkipStartupStopReconcile(false, false)).toBe(true);
  });

  test("flag ON (live), regardless of exposure -> default (mutating) reconcile unchanged", () => {
    expect(coinmSkipStartupStopReconcile(true, false)).toBe(false);
    expect(coinmSkipStartupStopReconcile(true, true)).toBe(false);
  });

  test("flag OFF but real open DB exposure exists (close-only) -> default (mutating) reconcile unchanged", () => {
    expect(coinmSkipStartupStopReconcile(false, true)).toBe(false);
  });
});

// OPEN.md P2 "meanrev_stocks no tiene breaker de portfolio": the equity fed
// to meanrevEngine's RiskGuard MUST be the sleeve's own ledger, never the
// shared Alpaca account total (momentum_stocks + meanrev_stocks share one
// wallet — AGENTS.md "Shared Alpaca wallet"). Static source check on the
// wiring block itself — cheap, and it fails the moment someone swaps the
// semantics label without touching MeanRevEngine.ts's own equity contract.
describe("meanrev_stocks RiskGuard wiring — sleeve ledger, never the aggregate account", () => {
  test("meanrevEngine's risk config is EQUITY_SEMANTICS.SLEEVE_LEDGER", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const start = src.indexOf("const meanrevEngine = new MeanRevEngine(");
    const end = src.indexOf("meanrevInterval = scheduleDailyStockRun(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toMatch(/risk:\s*\{\s*equitySemantics:\s*EQUITY_SEMANTICS\.SLEEVE_LEDGER\s*\}/);
    // Same pattern momentum_stocks already uses for its own sleeve-scoped
    // adapter — proves this isn't a one-off label but the same contract.
    expect(block).not.toMatch(/BINANCE_TOTAL_MARGIN|BINANCE_USDC_MARGIN|BINANCE_COINM_MARGIN/);
  });
});

// AUDIT HOLE 3 companion (2026-08-09): the old banner claimed "ALL SYSTEMS
// OPERATIONAL" at 1/2 brokers connected, so a typo'd key on ONE broker looked
// like a healthy boot. Both always-on brokers are required; index.ts pages
// ops (ERROR_BURST) whenever `operational` is false.
describe("startupBrokerHealth — both always-on brokers are required", () => {
  test("both up -> operational", () => {
    expect(startupBrokerHealth(true, true)).toEqual({ operational: true, down: [], unlinked: [] });
  });
  test("ONE down is already degraded — 1/2 is not 'all systems'", () => {
    expect(startupBrokerHealth(true, false)).toEqual({ operational: false, down: ["binance"], unlinked: [] });
    expect(startupBrokerHealth(false, true)).toEqual({ operational: false, down: ["alpaca"], unlinked: [] });
  });
  test("both down -> degraded naming both", () => {
    expect(startupBrokerHealth(false, false)).toEqual({ operational: false, down: ["alpaca", "binance"], unlinked: [] });
  });
  // F4b: a deliberately-UNLINKED registry venue is not "down" — no engines
  // were built over it, so it must neither degrade the banner nor page ops
  // (false paging); it is reported separately as `unlinked`.
  test("an unlinked venue is reported, never counted as down", () => {
    expect(startupBrokerHealth(true, false, { alpaca: true, binance: false }))
      .toEqual({ operational: true, down: [], unlinked: ["binance"] });
    expect(startupBrokerHealth(false, false, { alpaca: false, binance: false }))
      .toEqual({ operational: true, down: [], unlinked: ["alpaca", "binance"] });
    // …but a LINKED venue that failed to connect still degrades.
    expect(startupBrokerHealth(false, true, { alpaca: true, binance: false }))
      .toEqual({ operational: false, down: ["alpaca"], unlinked: ["binance"] });
  });
});

// Static wiring check (same style as the meanrev block below): the
// minimum-credential gate AGENTS.md cites must actually be INVOKED by
// main(), before any subsystem starts — a function that exists but is never
// called is exactly the hole this closes.
describe("assertRequiredConfig is invoked at bot startup", () => {
  test("main() calls assertRequiredConfig() before initializing the database", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const mainStart = src.indexOf("async function main()");
    expect(mainStart).toBeGreaterThan(-1);
    const body = src.slice(mainStart);
    // Line-anchored so a commented-out call ("// assertRequiredConfig(…);")
    // does NOT satisfy this test. F4a passes (env, marker-default,
    // accountsSource) — the gate call itself must stay before initDatabase.
    const call = /^[ \t]*assertRequiredConfig\([^)]*\);/m.exec(body);
    expect(call).not.toBeNull();
    const dbInitAt = body.indexOf("initDatabase(");
    expect(dbInitAt).toBeGreaterThan(call!.index); // gate runs BEFORE any subsystem
  });
});
