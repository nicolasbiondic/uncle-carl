// ── Positions as charts (owner, 2026-11-14): a block per strategy ───────────
// Words, order, scale and geometry are pure functions; the figures are the
// server's (the last row's moneyWindow) and are only read here.
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  strategyFigures, deltaWords, curveGeometry, renderCurve, sortByResult, barScale, barGeometry, rowTitle, renderBarRow,
  blockSentence, footerSentence, footerParts, MIN_SIDE, MIN_BAR,
} from "./strategy-chart.js";
import { positionsTotals } from "../money-values.js";
import { store } from "../store.js";

const langBefore = store.state.lang;
beforeEach(() => { store.state.lang = "en"; });
afterAll(() => { store.state.lang = langBefore; });

const T0 = Date.UTC(2026, 9, 14, 12);
/** What GET /api/equity/history?account=<id>&days=30&points=120 answers: rows, the last with the reader's window. */
const history = (values, w = {}) => values.map((equity, i) => {
  const row = { snapshot_time: T0 + i * 6 * 3600e3, equity, cash: 0, rebased: false };
  return i === values.length - 1
    ? { ...row, moneyWindow: { pnl: equity - values[0], pnlPct: values[0] ? ((equity - values[0]) / values[0]) * 100 : null, equity, endAt: row.snapshot_time, start: { at: T0, equity: values[0], rebased: false }, ...w } }
    : row;
});
const pos = (symbol, pnl, over = {}) => ({ symbol, side: "buy", market: "stock", quantity: 10, avgEntryPrice: 100, currentPrice: 100 + pnl / 10, unrealizedPnl: pnl, unrealizedPnlPct: pnl / 10, profileId: "momentum_stocks", openedAt: Date.now(), ...over });

describe("figures: the server's, read, never recomputed", () => {
  test("value, change and % are the last row's moneyWindow; the series is the curve's", () => {
    const f = strategyFigures(history([48_699, 49_000, 49_903]));
    expect(f).toMatchObject({ value: 49_903, pnl: 1_204, values: [48_699, 49_000, 49_903] });
    expect(f.pct).toBeCloseTo((1_204 / 48_699) * 100, 8);
    expect(f.values.at(-1) - f.values[0]).toBe(f.pnl); // what the curve draws is the change the head says
  });
  test("no % when the reader gives none (a spliced start): the head says only the dollars", () => {
    const f = strategyFigures(history([100, 90], { pnlPct: null }));
    expect(f.pct).toBeNull();
    expect(deltaWords(f).text).toBe("−$10 in 30 days");
  });
  test("no window, no series, one point, junk: null — nothing false", () => {
    expect(strategyFigures(history([100, 110]).map(({ moneyWindow, ...r }) => r))).toBeNull();
    expect(strategyFigures(history([100, 110], { equity: null }))).toBeNull();
    for (const x of [[], null, undefined, "x", history([100])]) expect(strategyFigures(x)).toBeNull();
  });
  test("the head's words, with the glyph and the colour: ▲ +$1,204 (+2.5 %) in 30 days / ▼ −$310 (−0.6 %) in 30 days / —", () => {
    expect(deltaWords({ pnl: 1204, pct: 2.5 })).toEqual({ glyph: "▲", text: "+$1,204 (+2.5 %) in 30 days", color: "var(--up)" });
    expect(deltaWords({ pnl: -310, pct: -0.6 })).toEqual({ glyph: "▼", text: "−$310 (−0.6 %) in 30 days", color: "var(--down)" });
    expect(deltaWords({ pnl: 0, pct: 0 }).glyph).toBe("▲");
    expect(deltaWords(null)).toEqual({ glyph: "", text: "—", color: "var(--muted)" });
    store.state.lang = "es";
    expect(deltaWords({ pnl: -310, pct: -0.6 }).text).toBe("−$310 (−0.6 %) en 30 días");
  });
});

describe("curveGeometry", () => {
  test("a line over the series, the dashed line at the starting value, the dot at the last point, colour by the change", () => {
    const g = curveGeometry([100, 110, 90, 120], 300, 64, 5);
    expect(g.up).toBe(true);
    expect(g.line.startsWith("M 0.0 ")).toBe(true);
    expect(g.line.match(/L/g)).toHaveLength(3);
    expect(g.last).toMatchObject({ x: 300, xPct: 100 });
    expect(g.last.y).toBe(5); // the highest value sits at the top padding
    expect(g.baseY).toBeCloseTo(5 + (1 - 10 / 30) * 54, 1); // 100 on a 90..120 scale
    expect(g.area.endsWith("L 300 64 L 0 64 Z")).toBe(true);
    expect(curveGeometry([100, 90, 80]).up).toBe(false);
  });
  test("a flat series sits on the middle; fewer than two points draw nothing; junk is skipped", () => {
    expect(curveGeometry([50, 50, 50]).baseY).toBe(32);
    expect(curveGeometry([50])).toBeNull();
    expect(curveGeometry([])).toBeNull();
    expect(curveGeometry([1, NaN, 3, null, ""]).line.match(/L/g)).toHaveLength(1); // NaN, null and "" are dropped (never read as 0): 1 and 3 remain
    expect(curveGeometry([1, 2, 3]).line).not.toContain("NaN");
  });
});

describe("bars: order, scale, zero line", () => {
  const rows = [pos("B", -193), pos("A", 102), pos("C", 0), pos("D", 40), { symbol: "X", unrealizedPnl: null }, pos("E", -35)];
  test("sorted from the largest gain in dollars to the largest loss; unpriced kept apart, never zero", () => {
    const s = sortByResult(rows);
    expect(s.priced.map((p) => p.symbol)).toEqual(["A", "D", "C", "E", "B"]);
    expect(s.unpriced.map((p) => p.symbol)).toEqual(["X"]);
    expect(sortByResult([pos("Z", 5), pos("A", 5)]).priced.map((p) => p.symbol)).toEqual(["A", "Z"]); // ties by ticker
  });
  test("one scale per strategy, in dollars; the zero line is where the data puts it (largest loss ÷ the two)", () => {
    const sc = barScale(rows);
    expect(sc).toMatchObject({ maxGain: 102, maxLoss: 193 });
    expect(sc.zero).toBeCloseTo((193 / 295) * 100, 1);
    expect(barScale([pos("A", 100), pos("B", -100)]).zero).toBe(50);
  });
  test(`each side keeps at least ${MIN_SIDE} %: all losers put zero at ${100 - MIN_SIDE} %, all winners at ${MIN_SIDE} %, a lone tiny winner is readable; nothing at all is centred`, () => {
    expect(barScale([pos("A", -50), pos("B", -10)]).zero).toBe(100 - MIN_SIDE);
    expect(barScale([pos("A", 50), pos("B", 10)]).zero).toBe(MIN_SIDE);
    expect(barScale([pos("A", 1), pos("B", -1000)]).zero).toBe(100 - MIN_SIDE);
    expect(barScale([pos("A", 0)])).toMatchObject({ zero: 50, maxGain: 0, maxLoss: 0 });
    expect(barScale([])).toMatchObject({ zero: 50 });
  });
  test("the largest gain fills the gain side and the largest loss the loss side, in proportion; a tiny result is a sliver; zero has no bar", () => {
    const sc = barScale(rows);
    const gain = barGeometry(102, sc), loss = barGeometry(-193, sc), half = barGeometry(-96.5, sc);
    expect(gain.left).toBe(sc.zero);
    expect(gain.left + gain.width).toBeCloseTo(100, 1); // fills the right side
    expect(loss.left).toBeCloseTo(0, 1);               // fills the left side
    expect(loss.left + loss.width).toBeCloseTo(sc.zero, 1);
    expect(half.width).toBeCloseTo(loss.width / 2, 1);
    expect(barGeometry(0.01, sc).width).toBe(MIN_BAR);
    expect(barGeometry(0, sc).width).toBe(0);
    expect(barGeometry(null, sc).width).toBe(0);
  });
  test("the tooltip carries what the row does not: value, %, quantity, entry, now and the time left", () => {
    const title = rowTitle(pos("NVDA", 102, { quantity: 5, avgEntryPrice: 188, currentPrice: 203.5, unrealizedPnlPct: 8.2, openedAt: Date.now() }), { broker: "alpaca" });
    expect(title).toMatch(/^Value \$1,018 · \+8% · Qty 5 · Entry \$188 · Now \$204 · up to \d days left$/);
    expect(rowTitle({ symbol: "X", unrealizedPnl: null }, undefined)).toBe("Qty — · Entry — · Now —");
    store.state.lang = "es";
    expect(rowTitle(pos("NVDA", 102), undefined)).toContain("Valor ");
  });
});

describe("words", () => {
  const rows = [pos("A", 102), pos("B", -193)];
  test("the block sentence: 11 positions open · −$623 since entry (−0.9 %) / ES", () => {
    const totals = { counted: 11, total: -623, pct: -0.9, unpriced: 0 };
    const eleven = Array.from({ length: 11 }, (_, i) => pos(`P${i}`, 1));
    expect(blockSentence(eleven, totals)).toEqual({ lead: "11 positions open", result: "−$623 since entry (−0.9 %)" });
    expect(blockSentence([pos("A", 1)], { counted: 1, total: 1, pct: null }).lead).toBe("1 position open");
    expect(blockSentence([pos("A", 1)], { counted: 1, total: 1, pct: null }).result).toBe("+$1 since entry"); // no % when the reader has none
    expect(blockSentence([], totals).lead).toBe("No positions open");
    store.state.lang = "es";
    expect(blockSentence([pos("A", 1)], { counted: 1, total: 1, pct: null }).lead).toBe("1 posición abierta");
    store.state.lang = "en";
    store.state.lang = "es";
    expect(blockSentence(eleven, totals)).toEqual({ lead: "11 posiciones abiertas", result: "sin cerrar −$623 (−0.9 %)" });
    expect(blockSentence([], totals).lead).toBe("Sin posiciones abiertas");
  });
  test("the footer sentence: 53 positions open · +$148 since entry (+0.1 %) · 30 up, 23 down / ES", () => {
    const book = [...Array.from({ length: 30 }, (_, i) => pos(`U${i}`, 10)), ...Array.from({ length: 23 }, (_, i) => pos(`D${i}`, -7))];
    const totals = positionsTotals(book);
    expect(footerSentence(book, totals)).toBe("53 positions open · +$139 since entry (+0.3 %) · 30 up, 23 down".replace("+$139", `${totals.total >= 0 ? "+" : "−"}$${Math.abs(Math.round(totals.total))}`));
    expect(footerSentence(book, { total: 148, counted: 53, pct: 0.1, unpriced: 0 })).toBe("53 positions open · +$148 since entry (+0.1 %) · 30 up, 23 down");
    expect(footerSentence(book, { total: 148, counted: 53, pct: 0.1, unpriced: 2 })).toBe("53 positions open · +$148 since entry (+0.1 %) · 30 up, 23 down · 2 unpriced");
    store.state.lang = "es";
    expect(footerSentence(book, { total: 148, counted: 53, pct: 0.1, unpriced: 0 })).toBe("53 posiciones abiertas · sin cerrar +$148 (+0.1 %) · 30 ganan, 23 pierden");
    expect(footerParts([], null)).toBeNull();
    expect(footerSentence([], null)).toBe("");
  });
});

describe("markup: the curve and a bar row", () => {
  test("the curve: a line, the dashed start line, a dot, two tiny labels; the colour follows the change; nothing without a series", () => {
    const up = renderCurve(strategyFigures(history([48_699, 48_900, 49_903])));
    expect(up).toContain('<div class="pc-axis" aria-hidden="true"><span>30 days ago</span><span>today</span></div>');
    expect(up).toContain('class="pc-base"');
    expect(up).toContain('stroke="var(--up)"');
    expect(up).toContain('class="pc-dot" aria-hidden="true" style="left:100%;');
    expect(up).toMatch(/title="Oct 14: \$48,699 → Oct 1[45]: \$49,903"/);
    expect(renderCurve(strategyFigures(history([25_410, 24_820])))).toContain('stroke="var(--down)"');
    expect(renderCurve(null)).toBe("");
    store.state.lang = "es";
    expect(renderCurve(strategyFigures(history([1, 2])))).toContain("<span>hace 30 días</span><span>hoy</span>");
  });

  test("a bar row: the ticker clickable with its plain name and a short's tag; the zero line and bar are decoration; the amount carries it; the rest in the title", () => {
    const sc = barScale([pos("NVDA", 1318), pos("USD", -891)]);
    const row = renderBarRow(pos("NVDA", 1318, { quantity: 5, avgEntryPrice: 188 }), sc, { broker: "alpaca" }, Date.now());
    expect(row).toContain('<span class="symname" title="Nvidia">Nvidia</span>');
    expect(row).toContain('role="button" tabindex="0"');
    expect(row).toContain('aria-hidden="true"><i class="pc-zero"');
    expect(row).toContain('<span class="pc-amt" style="color:var(--up)"><span class="vh">gain </span>+$1,318</span>');
    expect(row).toMatch(/^<div class="pc-row" title="Value \$[\d,]+ · /);
    expect(renderBarRow(pos("QQQ", -5, { side: "sell" }), sc, undefined, Date.now())).toContain('<span class="shorttag"');
    const none = renderBarRow({ symbol: "X", unrealizedPnl: null }, sc, undefined, Date.now());
    expect(none).toContain('<span class="pc-amt muted">—</span>'); // unpriced: a dash, never $0
    expect(none).not.toContain("pc-bar");
  });
});
