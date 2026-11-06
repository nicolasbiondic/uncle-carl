/**
 * Clock-injection determinism (src/utils/clock.ts seam).
 *
 * What these tests pin, beyond MomentumEngine.test.ts's behavior suite:
 *   1. The engine's time comes ONLY from the injected Clock — an identical
 *      scenario driven by two identical TestClocks is bit-identical, and
 *      every report timestamp equals the injected time exactly (impossible
 *      with a wall-clock read anywhere in the tick path).
 *   2. Advancing the clock changes outcomes PREDICTABLY: the 24h time stop
 *      fires at +25h and does not fire at +23h — time is a controlled
 *      input, not ambient state.
 *
 * This is the property the old `(Date as any).now` monkeypatch in
 * scripts/backtest-momentum-wf.ts only approximated (the constructor ran
 * before the patch); with injection it holds by construction.
 */

import { describe, expect, test } from "bun:test";
import { MomentumEngine, SLOT_DISPLACED_CLOSE_REASON, TIME_STOP_CLOSE_REASON, type RebalanceReport } from "./MomentumEngine";
import { TestClock } from "../../utils/clock";
import { rampTo, FakeBroker, MemoryPersistence, silentLogger as silent } from "../../test-support/momentum";

/** Fixed epoch anchor — nothing in this file reads the real clock. */
const T0 = Date.UTC(2024, 5, 1, 12, 0, 0);
const HOUR = 3_600_000;

function makeRig(clock: TestClock) {
  const broker = new FakeBroker();
  broker.candleStore.set("UP", rampTo(T0, 100, 130));
  broker.candleStore.set("DOWN", rampTo(T0, 100, 80));
  const engine = new MomentumEngine(
    {
      universe: ["UP", "DOWN"],
      rebalanceMinutes: 60,
      notionalPctPerSlot: 0.3,
      scorer: { topLongs: 1, minLongScore: 0.01 },
      timeStop: { maxHoldHours: 24 },
    },
    broker,
    silent,
    undefined,
    clock,
  );
  return { broker, engine };
}

describe("MomentumEngine clock injection", () => {
  for (const cadence of [60, 1440]) {
    for (const restart of [false, true]) {
      test(`120h time stop absorbs 1ms jitter at ${cadence}min cadence (restart=${restart})`, async () => {
        // NEAR/USDC live incident: Nov 3's pass was 1ms before its Oct 29 anchor.
        const entryAt = Date.parse("2026-10-29T00:00:15.001Z");
        const clock = new TestClock(entryAt), broker = new FakeBroker(), store = new MemoryPersistence();
        broker.setCandles("NEAR/USDC", rampTo(entryAt, 100, 130));
        const cfg = { universe: ["NEAR/USDC"], rebalanceMinutes: cadence,
          regime: { enabled: false }, risk: { mode: "sizeOnly" as const }, timeStop: { maxHoldHours: 120 } };
        let engine = new MomentumEngine(cfg, broker, silent, store, clock);
        await engine.tick(); engine.stop();
        expect(store.store?.entryMarks?.["NEAR/USDC|buy"]).toBe(entryAt);
        clock.set(entryAt + 120 * HOUR - cadence * 60_000 - 1);
        await engine.tick();
        expect(broker.closed).toEqual([]); // never a full decision period early
        if (restart) {
          engine.stop();
          engine = new MomentumEngine(cfg, broker, silent, store, clock);
        }
        clock.set(Date.parse("2026-11-03T00:00:15.000Z"));
        await engine.tick();
        expect(broker.closed).toEqual([{ symbol: "NEAR/USDC", side: "buy", closeReason: TIME_STOP_CLOSE_REASON }]);
        expect(broker.positions).toEqual([]);
      });
    }

    test(`off-phase restart anchor expires at the first eligible ${cadence}min grid tick`, async () => {
      const entryAt = Date.parse("2026-10-29T18:09:00Z");
      const clock = new TestClock(entryAt), broker = new FakeBroker(), store = new MemoryPersistence();
      broker.setCandles("UP", rampTo(entryAt, 100, 130));
      const cfg = { universe: ["UP"], rebalanceMinutes: cadence, regime: { enabled: false },
        risk: { mode: "sizeOnly" as const }, timeStop: { maxHoldHours: 120 } };
      const first = new MomentumEngine(cfg, broker, silent, store, clock);
      await first.tick(); first.stop();
      const cadenceMs = cadence * 60_000, threshold = 120 * HOUR - cadenceMs / 2;
      // Live grid = UTC boundary + 15s, even if the entry was off-phase.
      const due = Math.ceil((entryAt + threshold - 15_000) / cadenceMs) * cadenceMs + 15_000;
      clock.set(due - cadenceMs);
      const restarted = new MomentumEngine(cfg, broker, silent, store, clock);
      await restarted.tick();
      expect(broker.closed).toEqual([]);
      clock.set(due); await restarted.tick();
      expect(broker.closed[0]?.closeReason).toBe(TIME_STOP_CLOSE_REASON);
      expect(due - entryAt).toBeGreaterThanOrEqual(threshold);
      expect(due - entryAt).toBeLessThan(120 * HOUR + cadenceMs);
      if (cadence === 60) expect(due - entryAt).toBeLessThan(120 * HOUR);
    });

    test(`half-cadence expiry boundary is inclusive at ${cadence}min cadence`, async () => {
      const clock = new TestClock(T0), broker = new FakeBroker();
      broker.setCandles("UP", rampTo(T0, 100, 130));
      const engine = new MomentumEngine({ universe: ["UP"], rebalanceMinutes: cadence,
        regime: { enabled: false }, risk: { mode: "sizeOnly" }, timeStop: { maxHoldHours: 120 } }, broker, silent, undefined, clock);
      await engine.tick();
      const threshold = T0 + 120 * HOUR - cadence * 60_000 / 2;
      clock.set(threshold - 1); await engine.tick();
      expect(broker.closed).toEqual([]);
      clock.set(threshold); await engine.tick();
      expect(broker.closed[0]?.closeReason).toBe(TIME_STOP_CLOSE_REASON);
    });

    test(`120h exact-grid decisions remain unchanged at ${cadence}min cadence`, async () => {
      const clock = new TestClock(T0), broker = new FakeBroker();
      broker.setCandles("UP", rampTo(T0, 100, 130));
      const engine = new MomentumEngine({ universe: ["UP"], rebalanceMinutes: cadence,
        regime: { enabled: false }, risk: { mode: "sizeOnly" }, timeStop: { maxHoldHours: 120 } }, broker, silent, undefined, clock);
      for (let age = 0; age <= 120 * HOUR; age += cadence * 60_000) {
        clock.set(T0 + age); await engine.tick();
        expect(broker.closed.length).toBe(age >= 120 * HOUR ? 1 : 0);
      }
    });
  }

  test("identical scenario under two identical TestClocks is bit-identical, and every timestamp is the injected time", async () => {
    const run = async (): Promise<{ reports: RebalanceReport[]; closed: FakeBroker["closed"] }> => {
      const clock = new TestClock(T0);
      const { broker, engine } = makeRig(clock);
      const reports: RebalanceReport[] = [];
      reports.push(await engine.tick());   // opens UP at T0
      clock.advance(25 * HOUR);
      reports.push(await engine.tick());   // time stop fires at T0+25h
      return { reports, closed: broker.closed };
    };

    const a = await run();
    const b = await run();

    // Bit-identical across independent runs — the whole point of the seam.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // Timestamps are EXACTLY the injected times — a system-clock read
    // anywhere in the tick path could never produce these values.
    expect(a.reports[0].timestamp).toBe(T0);
    expect(a.reports[1].timestamp).toBe(T0 + 25 * HOUR);
  });

  test("advancing the clock changes the outcome predictably: the 24h time stop fires at +25h and not at +23h", async () => {
    const holdFor = async (hours: number) => {
      const clock = new TestClock(T0);
      const { broker, engine } = makeRig(clock);
      const first = await engine.tick();
      expect(first.actions.some(x => x.type === "open" && x.symbol === "UP")).toBe(true);
      clock.advance(hours * HOUR);
      await engine.tick();
      return broker;
    };

    const expired = await holdFor(25);
    expect(expired.closed).toEqual([{ symbol: "UP", side: "buy", closeReason: TIME_STOP_CLOSE_REASON }]);
    expect(expired.positions).toEqual([]); // and it stays closed this tick (protective-stop sit-out)

    const withinBarrier = await holdFor(23);
    expect(withinBarrier.closed).toEqual([]); // same code, same data — only the clock differed
    expect(withinBarrier.positions.map(p => p.symbol)).toEqual(["UP"]);
  });

  test("slot-displaced close reaches the broker with the SLOT_DISPLACED closeReason", async () => {
    // 4 held mild gainers (stay-valid: r > −2%, px > MA, but below the 5%
    // entry) + one strong entrant; maxLongs default 4 → the weakest held
    // (H1) is ranked out while its own signal is still valid.
    const clock = new TestClock(T0);
    const broker = new FakeBroker();
    const heldEnds = { H1: 103, H2: 103.5, H3: 104, H4: 104.5 } as const;
    for (const [sym, end] of Object.entries(heldEnds)) {
      broker.candleStore.set(sym, rampTo(T0, 100, end));
      broker.positions.push({ symbol: sym, side: "buy", quantity: 1, notional: 1_000 });
    }
    broker.candleStore.set("NEW", rampTo(T0, 100, 130));
    const engine = new MomentumEngine(
      { universe: ["H1", "H2", "H3", "H4", "NEW"], notionalPctPerSlot: 0.2 },
      broker,
      silent,
      undefined,
      clock,
    );
    await engine.tick();
    // Exits are entry-only gated, so the displaced close executes even if the
    // regime filter dislikes this synthetic tape.
    expect(broker.closed).toEqual([{ symbol: "H1", side: "buy", closeReason: SLOT_DISPLACED_CLOSE_REASON }]);
  });
});
