// ══════════════════════════════════════════════
// Clock seam — injectable time for decision paths
// ══════════════════════════════════════════════
//
// LEAN's `algorithm.SetDateTime` / NautilusTrader's clock-seam pattern: the
// strategy kernel NEVER reads the system clock directly — it reads an
// injected Clock, so backtest and live share the exact same code and a
// replay controls time by injection instead of monkeypatching `Date.now`
// (which is what scripts/backtest-momentum-wf.ts did before this seam:
// fragile because anything constructed before the patch, or any default
// parameter evaluated outside the patched window, silently read real time).
//
// Two implementations, nothing else:
//   - systemClock: real time. The default EVERYWHERE — production behavior
//     is byte-identical to the pre-seam code.
//   - TestClock: a manually-advanced clock for replays and tests.
//
// Deliberately NOT a global mutable singleton — a swappable global would
// reintroduce the monkeypatch problem (construction-order races, leaked
// patches across tests). Propagate by constructor/deps only.
//
// Seam compatibility: older seams take `now: () => number` (MeanRevEngine
// deps) or a plain `now: number` parameter (evaluateRisk). A Clock bridges
// as `() => clock.now()` / `clock.now()` — don't invent a third mechanism.
//
// Enforcement: src/utils/clock.enforcement.test.ts scans the decision-path
// directories (src/strategies/, src/risk/) and fails on any raw `Date.now`
// / bare `new Date()` not carrying a `// clock-ok:` marker.

export interface Clock {
  /** Current time in epoch milliseconds (the repo's universal time unit). */
  now(): number;
}

/** Real time. The production default everywhere a Clock is injected. */
export const systemClock: Clock = {
  now: () => Date.now(), // clock-ok: this IS the seam's real-time implementation
};

/**
 * Manually-controlled clock for replays and tests. Time only moves when the
 * driver moves it (`set`/`advance`) — two runs fed the same schedule are
 * bit-identical, and advancing time changes outcomes predictably.
 */
export class TestClock implements Clock {
  constructor(private t: number = 0) {}
  now(): number {
    return this.t;
  }
  /** Jump to an absolute epoch-ms time (replay loops: one set per bar). */
  set(t: number): void {
    this.t = t;
  }
  /** Advance relative to the current time. */
  advance(ms: number): void {
    this.t += ms;
  }
}
