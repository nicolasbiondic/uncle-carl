// ══════════════════════════════════════════════
// SleeveOutputMonitor — output liveness ("does the sleeve PRODUCE?")
// ══════════════════════════════════════════════
//
// The incident under test: shadow_momentum_crypto ticked for weeks while
// EVERY open failed ("no price") — 77 consecutive failures, ZERO trades rows,
// and the only trace was log.warn lines. These tests exercise the REAL path
// (MomentumEngine → adapter → monitor) for the failure signal, not the
// monitor in isolation, and mirror BrokerSync.test.ts for restart survival.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { initDatabase, getDB } from "../db/database";
import {
  SleeveOutputMonitor, sleeveOutput, isPolicyPreventedReason,
  OPEN_FAIL_THRESHOLD, OPEN_FAIL_COOLDOWN_MS, SILENCE_WINDOW_MS, SILENCE_MIN_TICKS,
} from "./sleeveOutput";
import { MomentumEngine, type MomentumBrokerAdapter } from "../strategies/momentum/MomentumEngine";
import { ramp, silentLogger } from "../test-support/momentum";
import { captureBursts } from "../test-support/events";

beforeAll(() => {
  initDatabase(":memory:");
});

beforeEach(() => {
  // Persisted sleeve counters must not leak between tests (same :memory: db).
  getDB().prepare(`DELETE FROM sync_state`).run();
});

/** Broker whose opens ALWAYS fail with "no price" — the incident's shape.
 *  Strong gainers force the TSM to target longs, so every tick plans (and
 *  fails) real opens. */
function noPriceBroker(): MomentumBrokerAdapter {
  const store = new Map([["UP1", ramp(100, 130)], ["UP2", ramp(100, 120)], ["UP3", ramp(100, 115)]]);
  return {
    async getOpenPositions() { return []; },
    async getEquity() { return 10_000; },
    async getRealisedPnlSince() { return 0; },
    async openPosition() { return { ok: false, reason: "no price for SYM" }; },
    async closePosition() { return { ok: true }; },
    async fetchCandles(symbol: string) { return store.get(symbol) ?? ramp(100, 130); },
  };
}

function failingEngine(sleeve: string): MomentumEngine {
  return new MomentumEngine(
    {
      universe: ["UP1", "UP2", "UP3"],
      notionalPctPerSlot: 0.30,
      heartbeatName: sleeve,
      scorer: { topLongs: 3, minLongScore: 0.01 },
    },
    noPriceBroker(),
    silentLogger,
  );
}

// ── Signal 1: consecutive open failures (through the REAL engine path) ──────

describe("sleeveOutput — consecutive open failures page exactly once", () => {
  test("N failed opens via MomentumEngine → ONE alert naming sleeve and reason; more failures inside cooldown stay silent", async () => {
    const sleeve = "test:out-fails";
    const engine = failingEngine(sleeve);
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      // Each tick plans up to 3 opens, all failing. Two ticks ≥ 6 failures —
      // comfortably past OPEN_FAIL_THRESHOLD (5) — inside one cooldown window.
      for (let i = 0; i < 3; i++) {
        const report = await engine.tick();
        expect(report.tradeable).toBe(true); // the plan DID try to open
      }
      expect(bursts.length).toBe(1); // one page, not one per failure
      expect(bursts[0].message).toContain(sleeve);
      expect(bursts[0].message).toContain("no price");
      expect(bursts[0].count).toBeGreaterThanOrEqual(OPEN_FAIL_THRESHOLD);
    } finally { detach(); }
  });

  test("a successful open resets the counter (threshold-1 fails + success + threshold-1 fails ⇒ no page)", () => {
    const sleeve = "test:out-reset";
    const mon = new SleeveOutputMonitor();
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      for (let i = 0; i < OPEN_FAIL_THRESHOLD - 1; i++) mon.recordOpenFailure(sleeve, "no price");
      mon.recordOpenSuccess(sleeve);
      for (let i = 0; i < OPEN_FAIL_THRESHOLD - 1; i++) mon.recordOpenFailure(sleeve, "no price");
      expect(bursts.length).toBe(0);
      // ...and without the reset those same failures DO page:
      mon.recordOpenFailure(sleeve, "no price");
      expect(bursts.length).toBe(1);
    } finally { detach(); }
  });

  test("the counter SURVIVES a restart (new monitor instance, same db)", () => {
    const sleeve = "test:out-restart";
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      // process #1: threshold-1 failures, no page yet
      const p1 = new SleeveOutputMonitor();
      for (let i = 0; i < OPEN_FAIL_THRESHOLD - 1; i++) p1.recordOpenFailure(sleeve, "no price");
      expect(bursts.length).toBe(0);

      // "restart": a brand-new instance with zero in-memory state, same db.
      // ONE more failure must cross the threshold — impossible if the count
      // lived in memory (it would restart at 1).
      const p2 = new SleeveOutputMonitor();
      p2.recordOpenFailure(sleeve, "no price");
      expect(bursts.length).toBe(1);
      expect(bursts[0].count).toBe(OPEN_FAIL_THRESHOLD);
    } finally { detach(); }
  });

  test("cooldown: a second threshold-crossing inside the window pages once total; past the window it re-pages", () => {
    const sleeve = "test:out-cooldown";
    let now = 1_000_000;
    const mon = new SleeveOutputMonitor(() => now);
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      for (let i = 0; i < OPEN_FAIL_THRESHOLD * 2; i++) mon.recordOpenFailure(sleeve, "no price");
      expect(bursts.length).toBe(1); // 2× threshold, still one page
      now += OPEN_FAIL_COOLDOWN_MS + 1;
      mon.recordOpenFailure(sleeve, "no price"); // condition persists past cooldown
      expect(bursts.length).toBe(2);
    } finally { detach(); }
  });
});

// ── Signal 2: productive silence (flat-by-choice must NOT page) ─────────────

describe("sleeveOutput — productive silence", () => {
  test("a sleeve that legitimately decides not to trade does NOT page inside the window", () => {
    const sleeve = "test:out-flat";
    let now = 1_000_000;
    const mon = new SleeveOutputMonitor(() => now);
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      // 13 days of daily ticks with zero output — inside the 14d window.
      for (let d = 0; d < 13; d++) { now += 86_400_000; mon.recordTick(sleeve); }
      expect(bursts.length).toBe(0);
    } finally { detach(); }
  });

  test("silence past the window pages ONCE (not per tick), and output re-arms it", () => {
    const sleeve = "test:out-silence";
    let now = 1_000_000;
    const mon = new SleeveOutputMonitor(() => now);
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      mon.recordOpenSuccess(sleeve); // anchor lastOutputAt
      for (let d = 0; d < 20; d++) { now += 86_400_000; mon.recordTick(sleeve); }
      expect(bursts.length).toBe(1); // days 15..20 are all past the window: still ONE page
      expect(bursts[0].message).toContain(sleeve);
      expect(bursts[0].count).toBeGreaterThanOrEqual(SILENCE_MIN_TICKS);

      // output re-arms: a close resets, a NEW full silence episode pages again
      mon.recordClose(sleeve);
      for (let d = 0; d < 20; d++) { now += 86_400_000; mon.recordTick(sleeve); }
      expect(bursts.length).toBe(2);
    } finally { detach(); }
  });

  test("elapsed time without ticks does not page (mostly-down bot is the heartbeat's class)", () => {
    const sleeve = "test:out-downtime";
    let now = 1_000_000;
    const mon = new SleeveOutputMonitor(() => now);
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      mon.recordOpenSuccess(sleeve);
      now += SILENCE_WINDOW_MS * 2; // 28 days pass with the bot down
      for (let i = 0; i < SILENCE_MIN_TICKS - 1; i++) mon.recordTick(sleeve);
      expect(bursts.length).toBe(0); // fewer than MIN_TICKS chances to act
    } finally { detach(); }
  });
});

// ── prevented_by_policy vs open_failure (B-ops-alerts.md #4/C-code-arch.md #4) ──
// A RiskEngine deny (NOTIONAL_EXCEEDS_MAXIMUM after the 2026-09-24 gross-cap
// change), the maintenance kill-switch, or an engine-local gross-exposure
// veto are sound risk management working AS INTENDED, not evidence the open
// PATH is broken — they must never share the "sleeve producing NOTHING"
// counter/threshold with a real broker/network failure.

describe("isPolicyPreventedReason — classification", () => {
  test("RiskEngine deny codes and the maintenance kill-switch are policy", () => {
    for (const r of [
      "NOTIONAL_EXCEEDS_MAXIMUM", "TRADING_STATE_HALTED", "TRADING_STATE_REDUCING",
      "RATE_LIMIT_EXCEEDED", "trading_disabled",
    ]) expect(isPolicyPreventedReason(r)).toBe(true);
  });

  test("an engine-local gross-exposure-cap message is policy (prefix match, full sentence varies)", () => {
    expect(isPolicyPreventedReason("gross exposure cap: live $12000 + new $5000 would exceed 1× equity ($15000 on $15000 equity)")).toBe(true);
  });

  test("a real broker/network failure is NOT policy", () => {
    for (const r of ["no price for SYM", "timeout", "insufficient_buying_power", undefined])
      expect(isPolicyPreventedReason(r)).toBe(false);
  });
});

describe("sleeveOutput — recordPreventedByPolicy never trips the open-failure page", () => {
  test("far past OPEN_FAIL_THRESHOLD policy vetoes never page — only recordOpenFailure does", () => {
    const sleeve = "test:out-policy-veto";
    const mon = new SleeveOutputMonitor();
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      for (let i = 0; i < OPEN_FAIL_THRESHOLD * 5; i++) mon.recordPreventedByPolicy(sleeve, "NOTIONAL_EXCEEDS_MAXIMUM");
      expect(bursts.length).toBe(0);
    } finally { detach(); }
  });

  test("policy vetoes don't reset or advance an in-progress REAL failure streak — mixing the two doesn't accidentally suppress or trigger the page", () => {
    const sleeve = "test:out-policy-mixed";
    const mon = new SleeveOutputMonitor();
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      for (let i = 0; i < OPEN_FAIL_THRESHOLD - 1; i++) mon.recordOpenFailure(sleeve, "no price");
      for (let i = 0; i < 10; i++) mon.recordPreventedByPolicy(sleeve, "TRADING_STATE_HALTED");
      expect(bursts.length).toBe(0); // the real streak is still one shy — untouched by the vetoes
      mon.recordOpenFailure(sleeve, "no price"); // the real threshold-crossing failure
      expect(bursts.length).toBe(1);
    } finally { detach(); }
  });

  test("a MomentumEngine tick whose every open is vetoed by RiskEngine (NOTIONAL_EXCEEDS_MAXIMUM) never pages 'producing NOTHING'", async () => {
    const sleeve = "test:out-riskengine-veto";
    const store = new Map([["UP1", ramp(100, 130)], ["UP2", ramp(100, 120)], ["UP3", ramp(100, 115)]]);
    const broker: MomentumBrokerAdapter = {
      async getOpenPositions() { return []; },
      async getEquity() { return 10_000; },
      async getRealisedPnlSince() { return 0; },
      async openPosition() { return { ok: false, reason: "NOTIONAL_EXCEEDS_MAXIMUM" }; }, // SwitchingAdapter's veto.code, verbatim
      async closePosition() { return { ok: true }; },
      async fetchCandles(symbol: string) { return store.get(symbol) ?? ramp(100, 130); },
    };
    const engine = new MomentumEngine(
      { universe: ["UP1", "UP2", "UP3"], notionalPctPerSlot: 0.30, heartbeatName: sleeve, scorer: { topLongs: 3, minLongScore: 0.01 } },
      broker, silentLogger,
    );
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      for (let i = 0; i < 6; i++) { // well past OPEN_FAIL_THRESHOLD's failure count if miscounted as open_failure
        const report = await engine.tick();
        expect(report.tradeable).toBe(true); // the plan DID try to open every time
      }
      expect(bursts.length).toBe(0);
    } finally { detach(); }
  });
});

// ── Wiring sanity: a successful engine open feeds the monitor ───────────────

describe("sleeveOutput — engine wiring records successes too", () => {
  test("a MomentumEngine tick that opens successfully resets a pre-seeded failure streak", async () => {
    const sleeve = "test:out-wired-success";
    // Pre-seed threshold-1 failures via the singleton (the instance the engine uses).
    for (let i = 0; i < OPEN_FAIL_THRESHOLD - 1; i++) sleeveOutput.recordOpenFailure(sleeve, "no price");

    const broker = noPriceBroker();
    broker.openPosition = async () => ({ ok: true }); // opens now succeed
    const engine = new MomentumEngine(
      { universe: ["UP1"], notionalPctPerSlot: 0.30, heartbeatName: sleeve, scorer: { topLongs: 1, minLongScore: 0.01 } },
      broker, silentLogger,
    );
    const { bursts, detach } = captureBursts(`sleeve_output:${sleeve}`);
    try {
      const report = await engine.tick();
      expect(report.actions.some(a => a.type === "open")).toBe(true);
      // streak was reset by the successful open → threshold-1 MORE failures stay silent
      for (let i = 0; i < OPEN_FAIL_THRESHOLD - 1; i++) sleeveOutput.recordOpenFailure(sleeve, "no price");
      expect(bursts.length).toBe(0);
    } finally { detach(); }
  });
});
