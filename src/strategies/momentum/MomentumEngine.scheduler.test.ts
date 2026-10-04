/**
 * Bar-close-aligned scheduler (nextAlignedTickDelayMs + MomentumEngine.start).
 *
 * What this pins:
 *   1. nextAlignedTickDelayMs is a pure function of (now, period, offset):
 *      boundary → offset; mid-period → remainder to next boundary + offset;
 *      inside [boundary, boundary+offset) → only the rest to boundary+offset.
 *   2. start() schedules its FIRST aligned tick at exactly boundary+offset
 *      (delay from the injected clock — no wall-clock read), and fires the
 *      extra 1s boot tick ONLY when the next boundary is >5min away.
 *
 * setTimeout is stubbed (captured, never executed) so no real timers run;
 * the engine's Clock is a TestClock, per the clock-seam discipline.
 */

import { describe, expect, test } from "bun:test";
import {
  ALIGNED_TICK_OFFSET_MS,
  EARLY_BOOT_TICK_MIN_LEAD_MS,
  MomentumEngine,
  alreadyDecidedThisBar,
  nextAlignedTickDelayMs,
} from "./MomentumEngine";
import { TestClock } from "../../utils/clock";
import { FakeBroker, silentLogger as silent } from "../../test-support/momentum";

const MIN = 60_000;
/** Exact hour boundary (and a 4h boundary: 12 % 4 === 0). */
const T_BOUNDARY = Date.UTC(2024, 5, 1, 12, 0, 0);

describe("nextAlignedTickDelayMs", () => {
  test("at an exact boundary → the offset itself", () => {
    expect(nextAlignedTickDelayMs(T_BOUNDARY, 60)).toBe(ALIGNED_TICK_OFFSET_MS);
    expect(nextAlignedTickDelayMs(T_BOUNDARY, 240)).toBe(ALIGNED_TICK_OFFSET_MS);
  });

  test("mid-period → remainder to the next boundary + offset", () => {
    expect(nextAlignedTickDelayMs(T_BOUNDARY + 7 * MIN, 60)).toBe(53 * MIN + ALIGNED_TICK_OFFSET_MS);
    expect(nextAlignedTickDelayMs(T_BOUNDARY + 30 * MIN, 60)).toBe(30 * MIN + ALIGNED_TICK_OFFSET_MS);
    expect(nextAlignedTickDelayMs(T_BOUNDARY + 90 * MIN, 240)).toBe(150 * MIN + ALIGNED_TICK_OFFSET_MS);
  });

  test("inside [boundary, boundary+offset) → only the rest until boundary+offset, never a full period", () => {
    expect(nextAlignedTickDelayMs(T_BOUNDARY + 5_000, 60)).toBe(ALIGNED_TICK_OFFSET_MS - 5_000);
    expect(nextAlignedTickDelayMs(T_BOUNDARY + ALIGNED_TICK_OFFSET_MS - 1, 60)).toBe(1);
  });

  test("exactly at boundary+offset → a full period until the next slot", () => {
    expect(nextAlignedTickDelayMs(T_BOUNDARY + ALIGNED_TICK_OFFSET_MS, 60)).toBe(60 * MIN);
  });

  test("custom offset is honored", () => {
    expect(nextAlignedTickDelayMs(T_BOUNDARY + 1_000, 60, 30_000)).toBe(29_000);
    expect(nextAlignedTickDelayMs(T_BOUNDARY + 40_000, 60, 30_000)).toBe(60 * MIN - 40_000 + 30_000);
  });
});

describe("MomentumEngine.start() aligned scheduling", () => {
  /** Run start() with setTimeout stubbed; return the captured delays in
   *  scheduling order. Nothing executes — no real timers, no ticks. */
  const capturedDelays = async (bootAtMs: number): Promise<number[]> => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (_fn: unknown, ms?: number) => {
      delays.push(ms ?? 0);
      return 0;
    };
    try {
      const engine = new MomentumEngine(
        { universe: [], rebalanceMinutes: 60 },
        new FakeBroker(),
        silent,
        undefined,
        new TestClock(bootAtMs),
      );
      await engine.start();
      engine.stop();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    return delays;
  };

  test("boot mid-bar (>5min to the boundary): 1s early boot tick, then the aligned tick at boundary+offset", async () => {
    const delays = await capturedDelays(T_BOUNDARY + 7 * MIN);
    expect(delays).toEqual([1_000, 53 * MIN + ALIGNED_TICK_OFFSET_MS]);
  });

  test("boot ≤5min before the boundary: NO extra early tick — the aligned tick IS the early tick", async () => {
    const bootAt = T_BOUNDARY + 57 * MIN; // 3min15s to the next slot < EARLY_BOOT_TICK_MIN_LEAD_MS
    expect(nextAlignedTickDelayMs(bootAt, 60)).toBeLessThanOrEqual(EARLY_BOOT_TICK_MIN_LEAD_MS);
    const delays = await capturedDelays(bootAt);
    expect(delays).toEqual([3 * MIN + ALIGNED_TICK_OFFSET_MS]);
  });
});

describe("alreadyDecidedThisBar — daily cadence decides once per closed bar across restarts", () => {
  const D = 86_400_000;
  const day = Date.UTC(2026, 8, 26); // 00:00 UTC
  test("sub-daily cadences never skip their boot tick", () => {
    expect(alreadyDecidedThisBar(day + 10 * 3_600_000, 60, day + 10 * 3_600_000 - 1_000)).toBe(false);
  });
  test("a tick after today's 00:00:15 boundary means today's bar is decided → skip", () => {
    expect(alreadyDecidedThisBar(day + 20 * 3_600_000, 1440, day + 15_000 + 2_000)).toBe(true);
  });
  test("last eval before today's boundary (bot was down at midnight) → catch up", () => {
    expect(alreadyDecidedThisBar(day + 20 * 3_600_000, 1440, day - 3_600_000)).toBe(false);
  });
  test("between 00:00:00 and 00:00:15 the current decision is still yesterday's", () => {
    expect(alreadyDecidedThisBar(day + 5_000, 1440, day - D + 15_000 + 1_000)).toBe(true);
    expect(alreadyDecidedThisBar(day + 5_000, 1440, day - D - 1_000)).toBe(false);
  });
  test("no persisted eval → never skip", () => {
    expect(alreadyDecidedThisBar(day + 20 * 3_600_000, 1440, undefined)).toBe(false);
    expect(alreadyDecidedThisBar(day + 20 * 3_600_000, 1440, 0)).toBe(false);
  });
});
