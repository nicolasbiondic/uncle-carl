// ══════════════════════════════════════════════
// Equity chart (2026-10-02): replaced the hand-rolled SVG line+conditional-
// fill with a TradingView Lightweight Charts™ BaselineSeries. These tests
// cover the pure mapping/formatting functions equity.js exports — no DOM,
// the chart library itself is loaded lazily only inside loadEquity() (see
// lwchart.js), which bun:test never reaches.
// ══════════════════════════════════════════════
import { equityTickLabel, crosshairTimeLabel } from "./equity.js";
import { describe, expect, test } from "bun:test";
import {
  toSeriesPoints, windowChange, baselineAnchor, formatAxisTick, tooltipData,
  baselineSeriesOptions,
} from "./equity.js";

// ── Honesty principle (supersedes the old areaIsHonest/min<=max*0.5 toggle) ──
// A fill that reads "distance from the bottom of an auto-scaled axis" lies
// on a compressed range ($111,026–$114,376: a 0.5% dip looked like a plunge
// to zero). A BaselineSeries anchored at the WINDOW'S OWN FIRST VALUE is
// honest at ANY scale instead: above the anchor is green (gained since the
// window opened), below is red (lost since it opened) — that split never
// depends on where the axis floor sits, so there is no longer a "compressed
// vs. near-zero" branch to get wrong.
//
// Falsifiability: anchoring at `min(vals)` instead of `vals[0]` (the old
// axis-floor-flavored bug, reincarnated) makes "anchors at the window's
// first value, not its minimum" fail whenever the series dips below its
// opening value anywhere in the window — exactly the real consolidated
// curve shape this exists to render correctly.
describe("baseline honesty: anchored at the window's first value, not derived from its range", () => {
  test("a compressed high-value window ($111,026-$114,376) anchors at the window's FIRST value", () => {
    const vals = [111_026, 113_000, 114_376, 111_900];
    expect(baselineAnchor(vals)).toBe(111_026);
  });

  test("a window whose open is NOT its minimum still anchors at open (not min, not max)", () => {
    const vals = [200, 50, 260, 90]; // min=50, max=260, open=200
    expect(baselineAnchor(vals)).toBe(200);
  });

  test("baselineSeriesOptions anchors at the given value regardless of the data's scale — same shape whether the axis is near zero or compressed", () => {
    const colors = { up: "var(--up)", down: "var(--down)", upSoft: "var(--up-soft)", downSoft: "var(--down-soft)" };
    const nearZero = baselineSeriesOptions(colors, 50);
    const compressed = baselineSeriesOptions(colors, 111_026);
    expect(nearZero.baseValue).toEqual({ type: "price", price: 50 });
    expect(compressed.baseValue).toEqual({ type: "price", price: 111_026 });
    // Same color mapping either way — no "honest vs dishonest" branch left.
    for (const opts of [nearZero, compressed]) {
      expect(opts.topLineColor).toBe("var(--up)");
      expect(opts.bottomLineColor).toBe("var(--down)");
      expect(opts.topFillColor1).toBe("var(--up-soft)");
      expect(opts.bottomFillColor2).toBe("var(--down-soft)");
    }
  });

  test("empty series has no anchor (caller must guard, same as the <2-rows empty state)", () => {
    expect(baselineAnchor([])).toBeNull();
  });
});

describe("toSeriesPoints — payload -> lightweight-charts series data", () => {
  test("maps ms epoch + equity to {time (seconds), value}, preserving order", () => {
    const rows = [{ t: 1_700_000_000_000, v: 100 }, { t: 1_700_000_060_000, v: 101 }];
    expect(toSeriesPoints(rows)).toEqual([{ time: 1_700_000_000, value: 100 }, { time: 1_700_000_060, value: 101 }]);
  });

  test("a real reporting gap in the payload stays a gap — no fabricated points between distant rows", () => {
    const rows = [{ t: 0, v: 10 }, { t: 7 * 86_400_000, v: 12 }]; // a week apart, only 2 rows
    const pts = toSeriesPoints(rows);
    expect(pts.length).toBe(2); // not back-filled to one point per day
    expect(pts[1].time - pts[0].time).toBe(7 * 86_400);
  });

  test("dedupes two rows landing on the same second by keeping the later value", () => {
    const rows = [{ t: 1000, v: 1 }, { t: 1999, v: 2 }, { t: 2000, v: 3 }];
    expect(toSeriesPoints(rows)).toEqual([{ time: 1, value: 2 }, { time: 2, value: 3 }]);
  });

  test("drops non-finite rows instead of crashing or inventing a 0", () => {
    const rows = [{ t: 1000, v: 10 }, { t: NaN, v: 11 }, { t: 2000, v: NaN }, { t: 3000, v: 12 }];
    expect(toSeriesPoints(rows)).toEqual([{ time: 1, value: 10 }, { time: 3, value: 12 }]);
  });
});

describe("windowChange — header $ / % figures", () => {
  test("positive change", () => {
    expect(windowChange([100, 110], false)).toEqual({ chg: 10, chgPct: 10, up: true });
  });
  test("negative change", () => {
    const { chg, chgPct, up } = windowChange([100, 95], false);
    expect(chg).toBe(-5); expect(chgPct).toBe(-5); expect(up).toBe(false);
  });
  test("rebased window start suppresses % (synthetic sleeve-boundary anchor, not a real $ basis)", () => {
    expect(windowChange([100, 110], true).chgPct).toBeNull();
  });
  test("zero/invalid start avoids a divide-by-zero NaN%", () => {
    expect(windowChange([0, 10], false).chgPct).toBeNull();
  });
});

describe("tooltipData — crosshair hover content", () => {
  const ts = Date.parse("2026-07-28T14:00:00Z"); // 10:00 ET
  test("Today window: ET clock time, % vs the window's open", () => {
    const d = tooltipData(110, 100, ts, 1, false);
    expect(d.v).toBe(110);
    expect(d.pct).toBeCloseTo(10, 6);
    expect(d.timeLabel).toBe(etTimeFor(ts));
  });
  test("non-Today window: ET date, not clock time", () => {
    const d = tooltipData(110, 100, ts, 7, false);
    expect(d.timeLabel).toBe(etDateFor(ts));
  });
  test("rebased window: % suppressed (null), $ value still shown", () => {
    expect(tooltipData(110, 100, ts, 1, true).pct).toBeNull();
  });
});

// Small local re-implementations matching fmt.js's etTime/etDate exactly,
// just to assert against without importing the DOM-adjacent fmt module's
// full surface here (fmt.js has its own direct test coverage already).
function etTimeFor(ms) { return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }); }
function etDateFor(ms) { return new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }); }

// ══════════════════════════════════════════════
// Time axis (2026-08-15, carried over): the equity chart had NO temporal
// reference at all — a flat weekend segment (Alpaca freezes at the Friday
// 16:00 ET close) read as "the bot stopped trading". formatAxisTick is now
// also lightweight-charts' `timeScale.tickMarkFormatter` (wrapped to accept
// its seconds-epoch `time`), so this stays load-bearing.
// ══════════════════════════════════════════════
describe("formatAxisTick", () => {
  const ts = Date.parse("2026-07-28T14:00:00Z"); // 2026-07-28 10:00 ET (a Tuesday)
  test("Today (period 1) → 24h hour:minute", () => {
    expect(formatAxisTick(ts, 1, "en-US")).toBe("10:00");
  });
  test("7D (period 7) → weekday + day number", () => {
    expect(formatAxisTick(ts, 7, "en-US")).toBe("Tue 28");
    expect(formatAxisTick(ts, 7, "es-ES")).toBe("mar 28");
  });
  test("30D (period 30) → day + short month", () => {
    expect(formatAxisTick(ts, 30, "en-US")).toBe("Jul 28");
    expect(formatAxisTick(ts, 30, "es-ES")).toBe("28 jul");
  });
  test("All (period 0) → short month only", () => {
    expect(formatAxisTick(ts, 0, "en-US")).toBe("Jul");
    expect(formatAxisTick(ts, 0, "es-ES")).toBe("jul");
  });
});

describe("equityTickLabel — the label follows the tick type, not the window (prod 2026-10-02: 'jue 1 · jue 1' on 7D)", () => {
  // Thu 2026-10-01 18:00 UTC = 14:00 ET.
  const ts = Date.UTC(2026, 9, 1, 18, 0);
  test("day ticks: weekday+day on 7D, day+month elsewhere; time ticks: HH:MM on every window", () => {
    expect(equityTickLabel(ts, 2, 7, "en-US")).toBe("Thu 1");
    expect(equityTickLabel(ts, 2, 30, "en-US")).toBe("Oct 1");
    expect(equityTickLabel(ts, 3, 7, "en-US")).toBe("14:00");
    expect(equityTickLabel(ts, 3, 0, "en-US")).toBe("14:00");
  });
  test("month and year boundaries", () => {
    expect(equityTickLabel(ts, 1, 0, "en-US")).toBe("Oct");
    expect(equityTickLabel(ts, 0, 0, "en-US")).toBe("Oct 2026");
  });
  test("two ticks of the same day no longer share a label on 7D", () => {
    const morning = Date.UTC(2026, 9, 1, 14, 0), dayStart = Date.UTC(2026, 9, 1, 4, 0);
    expect(equityTickLabel(dayStart, 2, 7, "es-ES")).not.toBe(equityTickLabel(morning, 3, 7, "es-ES"));
  });
  test("crosshair label carries the date and the time except on Today", () => {
    expect(crosshairTimeLabel(ts, 7, "en-US")).toBe("Oct 1 14:00");
    expect(crosshairTimeLabel(ts, 1, "en-US")).toBe("14:00");
  });
});
