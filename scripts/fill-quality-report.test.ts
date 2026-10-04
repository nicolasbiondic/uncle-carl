import { describe, expect, test } from "bun:test";
import { resolveWindow, PRICE_BASIS_BOUNDARY_MS } from "./fill-quality-report";

// OPEN.md P3 (closed 2026-09-25): the CLI only had the relative --since-days,
// so any window ≥ ~11d silently mixed the pre/post 2026-09-10 expected_px
// price bases (MARK vs executable touch — fillQuality.ts "Price-basis note").
// resolveWindow is the pure core of the new --from/--until absolute cuts.
describe("fill-quality-report — resolveWindow (--from/--until absolute cuts)", () => {
  const NOW = Date.parse("2026-09-25T12:00:00Z");

  test("default: since-days only, unbounded above", () => {
    const w = resolveWindow({ sinceDays: 30 }, NOW);
    expect(w.fromMs).toBe(NOW - 30 * 86_400_000);
    expect(w.untilMs).toBe(Infinity);
    expect(w.crossesPriceBasisBoundary).toBe(true); // 30d back from 09-25 straddles 09-10
  });

  test("--from raises the lower bound (intersection with since-days)", () => {
    const w = resolveWindow({ sinceDays: 30, from: "2026-09-10" }, NOW);
    expect(w.fromMs).toBe(Date.parse("2026-09-10"));
    expect(w.crossesPriceBasisBoundary).toBe(false); // post-boundary only
  });

  test("--from EARLIER than since-days does not widen the window (intersection, not union)", () => {
    const w = resolveWindow({ sinceDays: 5, from: "2026-01-01" }, NOW);
    expect(w.fromMs).toBe(NOW - 5 * 86_400_000);
  });

  test("--until caps the upper bound exclusively and isolates the pre-boundary side", () => {
    const w = resolveWindow({ sinceDays: 365, until: "2026-09-10T00:00:00Z" }, NOW);
    expect(w.untilMs).toBe(PRICE_BASIS_BOUNDARY_MS);
    // fromMs < boundary but untilMs === boundary → NOT crossing (exclusive).
    expect(w.crossesPriceBasisBoundary).toBe(false);
  });

  test("a window strictly inside one side never flags the boundary", () => {
    const w = resolveWindow({ sinceDays: 3650, from: "2026-09-11", until: "2026-09-20" }, NOW);
    expect(w.crossesPriceBasisBoundary).toBe(false);
  });

  test("unparseable ISO throws with the flag named", () => {
    expect(() => resolveWindow({ sinceDays: 30, from: "not-a-date" }, NOW)).toThrow("--from");
    expect(() => resolveWindow({ sinceDays: 30, until: "2026-99-99" }, NOW)).toThrow("--until");
  });

  test("an empty effective window throws instead of printing a silently-empty report", () => {
    expect(() => resolveWindow({ sinceDays: 30, from: "2026-09-20", until: "2026-09-10" }, NOW)).toThrow("empty window");
    // since-days pushing from past until is the same class:
    expect(() => resolveWindow({ sinceDays: 1, until: "2026-09-01" }, NOW)).toThrow("empty window");
  });

  test("non-numeric since-days throws", () => {
    expect(() => resolveWindow({ sinceDays: NaN }, NOW)).toThrow("--since-days");
  });
});
