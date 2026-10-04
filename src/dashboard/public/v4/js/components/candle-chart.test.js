// ══════════════════════════════════════════════
// Candle modal (2026-10-02): replaced the hand-rolled SVG candlesticks with
// TradingView Lightweight Charts™. These tests cover the pure payload-to-
// chart mappings candle.js exports (bars -> candlestick data, open positions
// -> price lines, closed trades -> markers) — no DOM; the library itself is
// only reached from inside load()/openCandles(), never from these tests
// (see lwchart.js's lazy loadChartLib()).
// ══════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import { toCandleData, positionPriceLines, closedTradeMarkers } from "./candle.js";
import { tickLabel } from "../lwchart.js";

describe("toCandleData — /api/candles bars -> candlestick series data", () => {
  test("maps ms epoch OHLC to {time (seconds), open, high, low, close}", () => {
    const bars = [{ t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }];
    expect(toCandleData(bars)).toEqual([{ time: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5 }]);
  });

  test("a real gap between bars (market closed) is not back-filled", () => {
    const bars = [{ t: 0, o: 1, h: 1, l: 1, c: 1 }, { t: 3 * 86_400_000, o: 2, h: 2, l: 2, c: 2 }];
    const data = toCandleData(bars);
    expect(data.length).toBe(2);
    expect(data[1].time - data[0].time).toBe(3 * 86_400);
  });

  test("drops a bar with any non-finite OHLC field instead of plotting a broken candle", () => {
    const bars = [{ t: 1000, o: 1, h: 2, l: 0.5, c: 1.5 }, { t: 2000, o: NaN, h: 2, l: 1, c: 1.8 }, { t: 3000, o: 1, h: 2, l: 1, c: 1.9 }];
    const data = toCandleData(bars);
    expect(data.map((d) => d.time)).toEqual([1, 3]);
  });

  test("dedupes two bars on the same second, keeping the later one", () => {
    const bars = [{ t: 1000, o: 1, h: 1, l: 1, c: 1 }, { t: 1999, o: 2, h: 2, l: 2, c: 2 }];
    expect(toCandleData(bars)).toEqual([{ time: 1, open: 2, high: 2, low: 2, close: 2 }]);
  });
});

// A real-looking resolved theme (as getComputedStyle/readThemeColors would
// hand back) — NOT literal "var(--x)" strings. Canvas-rendered price
// lines/markers need actual color values (see closedTradeMarkers' big
// comment in candle.js): a literal "var(--up)" assigned to a canvas
// fillStyle is silently ignored by the browser, which is exactly the bug
// that rendered every marker black in manual verification (2026-10-02).
const THEME = { accent: "#4c9cff", up: "#2dd4a0", down: "#f16b6b" };

describe("positionPriceLines — open position entry/SL/TP overlays", () => {
  test("a position with entry + SL + TP produces three price lines, in RESOLVED theme colors (not CSS var() tokens)", () => {
    const lines = positionPriceLines([{ avgEntryPrice: 100, stopLoss: 90, takeProfit: 120 }], THEME);
    expect(lines.length).toBe(3);
    expect(lines.map((l) => l.price)).toEqual([100, 90, 120]);
    expect(lines[0].color).toBe(THEME.accent);
    expect(lines[1].color).toBe(THEME.down); // SL is a danger line
    expect(lines[2].color).toBe(THEME.up);   // TP is a reward line
    for (const l of lines) expect(l.color).not.toMatch(/^var\(/); // the actual bug, pinned
  });

  test("missing SL/TP omit those lines (no fabricated 0-price line)", () => {
    const lines = positionPriceLines([{ avgEntryPrice: 100 }], THEME);
    expect(lines.length).toBe(1);
    expect(lines[0].title).toBe("entry"); // default identity translator
  });

  test("translate() is used for the entry label (en/es)", () => {
    const lines = positionPriceLines([{ avgEntryPrice: 100 }], THEME, (en, es) => es);
    expect(lines[0].title).toBe("entrada");
  });

  test("no open positions -> no lines", () => {
    expect(positionPriceLines([], THEME)).toEqual([]);
  });
});

describe("closedTradeMarkers — closed trades -> entry/exit markers with P&L text", () => {
  const longWin = { side: "buy", entryTime: 1_000_000, exitTime: 2_000_000, pnl: 150.4 };
  const longLoss = { side: "buy", entryTime: 3_000_000, exitTime: 4_000_000, pnl: -75.2 };
  const shortWin = { side: "sell", entryTime: 5_000_000, exitTime: 6_000_000, pnl: 30 };

  test("one closed trade yields two markers: entry (no P&L text) and exit (P&L text)", () => {
    const markers = closedTradeMarkers([longWin], THEME);
    expect(markers.length).toBe(2);
    const [entry, exit] = markers;
    expect(entry.time).toBe(1000);
    expect(entry.text).toBe("");
    expect(entry.color).toBe(THEME.accent);
    expect(exit.time).toBe(2000);
    expect(exit.text).toBe("+$150");
  });

  test("a losing trade's exit marker is colored down (RESOLVED color, not a CSS var() token) and shows a negative sign", () => {
    const [, exit] = closedTradeMarkers([longLoss], THEME);
    expect(exit.color).toBe(THEME.down);
    expect(exit.color).not.toMatch(/^var\(/);
    expect(exit.text).toBe("−$75");
  });

  test("a winning trade's exit marker is colored up", () => {
    const [, exit] = closedTradeMarkers([longWin], THEME);
    expect(exit.color).toBe(THEME.up);
  });

  test("short trades flip entry/exit arrow direction vs long trades", () => {
    const [entry, exit] = closedTradeMarkers([shortWin], THEME);
    expect(entry.shape).toBe("arrowDown"); // short entry = selling into the position
    expect(exit.shape).toBe("arrowUp");    // short exit = buying back
  });

  test("markers are sorted ascending by time even when trades arrive newest-first (API order)", () => {
    const markers = closedTradeMarkers([longLoss, longWin], THEME); // loss is later in time
    const times = markers.map((m) => m.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("fromSec/toSec drop markers outside the visible bar range (old trade, narrow chart window)", () => {
    const markers = closedTradeMarkers([longWin, longLoss], THEME, { fromSec: 2900, toSec: 4100 });
    // longWin's entry (1000) falls outside [2900,4100]; its exit (2000) also does.
    expect(markers.every((m) => m.time >= 2900 && m.time <= 4100)).toBe(true);
    expect(markers.some((m) => m.time === 3000 || m.time === 4000)).toBe(true); // longLoss survives
    expect(markers.some((m) => m.time === 1000 || m.time === 2000)).toBe(false); // longWin dropped
  });

  test("no closed trades -> no markers", () => {
    expect(closedTradeMarkers([], THEME)).toEqual([]);
  });
});

describe("tickLabel — intraday axes keep their dates (was '04:00 AM' under every day)", () => {
  const fmtDate = () => "DATE", fmtTime = () => "TIME";
  test("year/month/day boundaries get a date; time ticks get a time", () => {
    expect([0, 1, 2].map((k) => tickLabel(0, k, fmtDate, fmtTime))).toEqual(["DATE", "DATE", "DATE"]);
    expect([3, 4].map((k) => tickLabel(0, k, fmtDate, fmtTime))).toEqual(["TIME", "TIME"]);
  });
  test("no tick type → time (library default contract)", () => {
    expect(tickLabel(0, undefined, fmtDate, fmtTime)).toBe("TIME");
  });
});
