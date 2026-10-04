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
import { rampTo, FakeBroker, silentLogger as silent } from "../../test-support/momentum";

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
