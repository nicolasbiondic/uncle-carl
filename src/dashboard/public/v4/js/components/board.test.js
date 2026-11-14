// ── The Overview board (owner, 2026-11-14): a column per strategy ───────────
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  boardColumns, boardModel, renderBoard, pickRows, pickRowsScrolling, pickTight, countLine, hasLeverage, moreWords,
  MIN_EDGE, WANT_LINES, LEVERAGE_OVER,
} from "./board.js";
import { BOT_NOW_FIXTURE as FX, FIXTURE_NOW as NOW } from "./botnow.fixture.js";
import { store } from "../store.js";

const langBefore = store.state.lang;
beforeEach(() => { store.state.lang = "en"; });
afterAll(() => { store.state.lang = langBefore; });
const O = { now: NOW, tz: "America/New_York" };

const T0 = Date.UTC(2026, 9, 14, 12);
const history = (values) => values.map((equity, i) => {
  const row = { snapshot_time: T0 + i * 6 * 3600e3, equity, cash: 0, rebased: false };
  return i === values.length - 1 ? { ...row, moneyWindow: { pnl: equity - values[0], pnlPct: ((equity - values[0]) / values[0]) * 100, equity, endAt: row.snapshot_time, start: { at: T0, equity: values[0], rebased: false } } } : row;
});
const pos = (symbol, pnl, over = {}) => ({ symbol, side: "buy", market: "stock", quantity: 100, avgEntryPrice: 100, currentPrice: 100 + pnl / 100, unrealizedPnl: pnl, unrealizedPnlPct: pnl / 100, profileId: "momentum_stocks", openedAt: NOW, ...over });

describe("how many bar lines a column shows", () => {
  test("all of them when they fit", () => {
    expect(pickRows(11, 11)).toEqual({ top: 11, bottom: 0, hidden: 0 });
    expect(pickRows(5, 40)).toEqual({ top: 5, bottom: 0, hidden: 0 });
    expect(pickRows(0, 0)).toEqual({ top: 0, bottom: 0, hidden: 0 });
  });
  test("else the biggest gains and the biggest losses that fit beside ONE '… N more' line (a gain more when the room is odd)", () => {
    expect(pickRows(32, 12)).toEqual({ top: 6, bottom: 5, hidden: 21 }); // 11 lines + the more line
    expect(pickRows(32, 11)).toEqual({ top: 5, bottom: 5, hidden: 22 });
    expect(pickRows(11, 8)).toEqual({ top: 4, bottom: 3, hidden: 4 });
  });
  test(`never fewer than ${MIN_EDGE} + ${MIN_EDGE} when the strategy has that many, however little room`, () => {
    expect(pickRows(32, 0)).toEqual({ top: 2, bottom: 2, hidden: 28 });
    expect(pickRows(32, 3)).toEqual({ top: 2, bottom: 2, hidden: 28 });
    expect(pickRows(12, 1)).toEqual({ top: 2, bottom: 2, hidden: 8 });
  });
  test("a single hidden line is shown instead of a line that says '1 more'; four lines are always all shown", () => {
    expect(pickRows(5, 3)).toEqual({ top: 5, bottom: 0, hidden: 0 }); // 2 + 2 + "1 more" → show the 5th instead
    expect(pickRows(11, 10)).toEqual({ top: 5, bottom: 4, hidden: 2 });
    expect(pickRows(4, 0)).toEqual({ top: 4, bottom: 0, hidden: 0 });
  });
  test("a column too short for 2 + 2: as many lines as fit, one of them '… N more'; one line = that line alone; no room = nothing", () => {
    expect(pickTight(32, 4)).toEqual({ top: 2, bottom: 1, hidden: 29 });   // 3 bars + the more line = 4 lines
    expect(pickTight(32, 3)).toEqual({ top: 1, bottom: 1, hidden: 30 });
    expect(pickTight(32, 2)).toEqual({ top: 1, bottom: 0, hidden: 31 });
    expect(pickTight(32, 1)).toEqual({ top: 0, bottom: 0, hidden: 32 });   // only "… 32 more · see all"
    expect(pickTight(32, 0)).toEqual({ top: 0, bottom: 0, hidden: 32, none: true });
    expect(pickTight(4, 4)).toEqual({ top: 4, bottom: 0, hidden: 0 });     // all of them when they fit
    expect(pickTight(4, 3)).toEqual({ top: 1, bottom: 1, hidden: 2 });
    // never more lines than the room: bars + the more line ≤ capacity
    for (let total = 1; total <= 40; total++) for (let cap = 0; cap <= 12; cap++) {
      const p = pickTight(total, cap);
      const lines = p.none ? 0 : p.top + p.bottom + (p.hidden ? 1 : 0);
      expect(lines).toBeLessThanOrEqual(cap);
      expect(p.top + p.bottom + p.hidden).toBe(total);
    }
  });

  test("a page that scrolls (phone, narrow window): all up to 12, else 5 + 5", () => {
    expect(pickRowsScrolling(11)).toEqual({ top: 11, bottom: 0, hidden: 0 });
    expect(pickRowsScrolling(12)).toEqual({ top: 12, bottom: 0, hidden: 0 });
    expect(pickRowsScrolling(32)).toEqual({ top: 5, bottom: 5, hidden: 22 });
  });
  test("a phone: never more than 5 + 5, even when that hides a single line", () => {
    expect(pickRowsScrolling(10, true)).toEqual({ top: 10, bottom: 0, hidden: 0 });
    expect(pickRowsScrolling(11, true)).toEqual({ top: 5, bottom: 5, hidden: 1 });
    expect(pickRowsScrolling(32, true)).toEqual({ top: 5, bottom: 5, hidden: 22 });
    expect(pickRowsScrolling(4, true)).toEqual({ top: 4, bottom: 0, hidden: 0 });
  });
  test("the quiet last line, in both languages", () => {
    expect(moreWords(3)).toBe("… 3 more · see all");
    store.state.lang = "es";
    expect(moreWords(3)).toBe("… 3 más · ver todas");
    expect(WANT_LINES).toBeGreaterThanOrEqual(2 * MIN_EDGE);
  });
});

describe("the positions lines", () => {
  test("11 positions open · $71,762 invested — with leverage only when clearly more than its own value", () => {
    expect(countLine(11, 71_762, false)).toEqual({ text: "11 positions open · $71,762 invested", leverage: false });
    expect(countLine(11, 71_762, true).text).toBe("11 positions open · $71,762 invested with leverage");
    expect(countLine(1, 500, false).text).toBe("1 position open · $500 invested");
    expect(countLine(4, null, false).text).toBe("4 positions open"); // COIN-M: no invested amount
    store.state.lang = "es";
    expect(countLine(11, 71_762, true).text).toBe("11 posiciones abiertas · $71,762 invertidos con apalancamiento");
    expect(countLine(1, 500, false).text).toBe;
  });
  test(`leverage is invested more than ${Math.round((LEVERAGE_OVER - 1) * 100)} % above the strategy's value; never guessed`, () => {
    expect(hasLeverage(52_000, 50_000)).toBe(false);
    expect(hasLeverage(52_600, 50_000)).toBe(true);
    expect(hasLeverage(71_762, 49_400)).toBe(true);
    expect(hasLeverage(null, 50_000)).toBe(false);
    expect(hasLeverage(70_000, undefined)).toBe(false);
    expect(hasLeverage(70_000, 0)).toBe(false);
  });
});

describe("the columns", () => {
  const accounts = [
    { id: "meanrev_stocks", label: "MeanRev Stocks", broker: "alpaca", grossCapMult: 1 },
    { id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", grossCapMult: 2.5 },
    { id: "momentum_crypto", label: "Momentum Crypto", broker: "binance" },
    { id: "momentum_crypto_usdc", label: "Momentum Crypto USDC", broker: "binance_usdc", grossCapMult: 1.15 },
  ];
  const mom = [pos("NVDA", 1318), pos("MSFT", -296), pos("SSO", 665), pos("USD", -891)];
  const mr = Array.from({ length: 14 }, (_, i) => pos(`MR${i}`, 50 - i * 9, { profileId: "meanrev_stocks", quantity: 1 }));
  const state = (over = {}) => ({
    view: "consolidated", dashboard: { accounts, portfolio: { positions: [...mr, ...mom] } }, botNow: FX,
    curves: { momentum_stocks: history([48_699, 48_900, 49_903]), meanrev_stocks: history([25_410, 24_820]), momentum_crypto: history([9_880, 9_310]) },
    curvesTried: { momentum_stocks: true, meanrev_stocks: true, momentum_crypto: true, momentum_crypto_usdc: true }, ...over,
  });

  test("one column per strategy in the SERVER's order (never sorted by size, so columns do not swap places); empty ones included", () => {
    expect(boardColumns(state()).map((g) => g.id)).toEqual(["meanrev_stocks", "momentum_stocks", "momentum_crypto", "momentum_crypto_usdc"]);
    // the big strategy having shrunk or grown changes nothing
    const flipped = state({ dashboard: { accounts, portfolio: { positions: [...mom] } } });
    expect(boardColumns(flipped).map((g) => g.id)).toEqual(["meanrev_stocks", "momentum_stocks", "momentum_crypto", "momentum_crypto_usdc"]);
    expect(boardColumns(state({ view: "momentum_stocks" })).map((g) => g.id)).toEqual(["momentum_stocks"]);
  });

  test("rows of no known strategy get a last column", () => {
    const s = state({ dashboard: { accounts, portfolio: { positions: [...mom, { ...pos("ZZ", 1), profileId: undefined }] } } });
    expect(boardColumns(s).map((g) => g.id).at(-1)).toBe("");
  });

  test("a column tells the whole story: head, figure, curve, lines, bars, bot", () => {
    const m = boardModel(state(), O);
    const col = m.cols.find((c) => c.id === "momentum_stocks").parts;
    expect(col.head).toContain('<div class="bc-name" title="Momentum Stocks">Momentum Stocks</div>');
    expect(col.head).toContain('<span class="bn-dot" style="background:var(--up)"></span>Invested</div>'); // the existing status word
    expect(col.fig).toBe('<div class="bc-value">$49,903</div><div class="bc-delta" style="color:var(--up)"><span aria-hidden="true">▲</span> +$1,204 (+2.5 %) in 30 days</div>');
    expect(col.curve).toContain('<div class="pc-axis" aria-hidden="true"><span>30 days ago</span><span>today</span></div>');
    // 4 positions, $40,796 at market against a value of $49,903: no leverage; +$796 since entry on $40,000 entered
    expect(col.lines).toBe('<div class="bc-count">4 positions open · $40,796 invested</div><div class="bc-res" style="color:var(--up)">+$796 since entry (+2.0 %)</div>');
    expect(col.lines).not.toContain("leverage");
    expect(col.lines).not.toMatch(/capital|gauge|limit \d/);
    expect(col.bars).toContain('data-total="4"');
    expect(col.bars.match(/class="pc-row"/g)).toHaveLength(4);
    expect(col.bars).toContain('<button type="button" class="pc-more bc-more" data-seeall="momentum_stocks" hidden></button>');
    expect(col.bars.indexOf("NVDA")).toBeLessThan(col.bars.indexOf("SSO")); // largest gain first…
    expect(col.bars.indexOf("MSFT")).toBeLessThan(col.bars.indexOf("USD")); // …largest loss last
    expect(col.bot).toContain('<div class="bc-mkt"><span class="bn-rg up">');
    expect(col.bot).toContain('<div class="bc-dec">Decided yesterday 09:35 New York · decides again Monday 09:35 New York</div>');
    expect(col.bot).not.toContain("bn-chip");
  });

  test("'with leverage' when it invests clearly more than its own value, its explanation in the title; the result part in its colour", () => {
    const rich = state({ curves: { momentum_stocks: history([20_000, 20_500]) } }); // value $20,500 against ~$40,000 invested
    const lines = boardModel(rich, O).cols.find((c) => c.id === "momentum_stocks").parts.lines;
    expect(lines).toMatch(/class="bc-count" title="It invests more than its own value: \$[\d,]+ against \$20,500, up to its limit\. Its limit is 250 % of its value\."/);
    expect(lines).toMatch(/invested with leverage<\/div>/);
    store.state.lang = "es";
    const es = boardModel(rich, O).cols.find((c) => c.id === "momentum_stocks").parts.lines;
    expect(es).toContain("invertidos con apalancamiento");
    expect(es).toContain("Su límite es el 250 % de su valor.");
    expect(es).toContain("sin cerrar +$796 (+2.0 %)");
  });

  test("a strategy with no positions says so, and why when the Bot data knows; no bars", () => {
    const col = boardModel(state(), O).cols.find((c) => c.id === "momentum_crypto").parts;
    expect(col.lines).toBe('<div class="bc-count">No positions open</div><div class="bc-why">None of 8 coins is trending up</div>');
    expect(col.bars).toBe("");
    expect(col.bot).not.toContain("None of 8 coins"); // said once
    store.state.lang = "es";
    expect(boardModel(state(), O).cols.find((c) => c.id === "momentum_crypto").parts.lines).toContain("Sin posiciones abiertas");
  });

  test("a strategy with no series: no curve and no delta, '—' in their place — never a $0 and nothing made up", () => {
    const col = boardModel(state(), O).cols.find((c) => c.id === "momentum_crypto_usdc").parts;
    expect(col.fig).toBe('<div class="bc-value muted">—</div><div class="bc-delta muted">—</div>');
    expect(col.curve).toBe("");
    expect(col.fig).not.toContain("$0");
  });

  test("loading: skeletons until the first answer, never $0; the whole board is skeleton columns before the dashboard", () => {
    const loading = boardModel(state({ curves: {}, curvesTried: {} }), O).cols.find((c) => c.id === "momentum_stocks").parts;
    expect(loading.fig).toContain("skel");
    expect(loading.curve).toContain("skel");
    expect(loading.fig).not.toContain("$");
    const none = boardModel({ view: "consolidated", dashboard: null, curves: {}, curvesTried: {} }, O);
    expect(none.skeleton).toBe(true);
    const html = renderBoard(none);
    expect(html.match(/class="bc bc-skel"/g)).toHaveLength(4);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("$");
  });

  test("past its limit (the bot's own ratio): the words say so in the down colour", () => {
    const over = { ...FX, portfolios: FX.portfolios.map((p) => (p.id === "momentum_stocks" ? { ...p, grossX: 2.6, maxGrossX: 2.5 } : p)) };
    expect(boardModel(state({ botNow: over }), O).cols.find((c) => c.id === "momentum_stocks").parts.lines).toContain('<span class="bc-over"> — above its limit</span>');
    expect(boardModel(state({ botNow: FX }), O).cols.find((c) => c.id === "momentum_stocks").parts.lines).not.toContain("above its limit");
  });

  test("the last action rides at the bottom of the column with the full text in the title; none in the feed, no line", () => {
    const ev = [{ at: NOW - 40 * 60e3, portfolioId: "momentum_stocks", kind: "buy", symbol: "NVDA", usd: 600 }];
    const bot = boardModel(state({ botNow: { ...FX, events: ev } }), O).cols.find((c) => c.id === "momentum_stocks").parts.bot;
    expect(bot).toContain('<div class="bc-last" title="Last action 40 min ago: bought NVDA ($600)">Last action 40 min ago: bought NVDA ($600)</div>');
    expect(boardModel(state({ botNow: { ...FX, events: [] } }), O).cols.find((c) => c.id === "momentum_stocks").parts.bot).not.toContain("bc-last");
    expect(boardModel(state({ botNow: null }), O).cols.find((c) => c.id === "momentum_stocks").parts.bot).toBe(""); // no bot data: nothing invented
  });

  test("a blocked / trimmed strategy says so in its own sentence", () => {
    const bot = boardModel(state(), O).cols.find((c) => c.id === "momentum_crypto_usdc").parts.bot;
    expect(bot).toContain('<div class="bc-trim" title="79 % of normal size">Trading smaller: it is 16 % below its peak</div>');
    expect(bot).toContain('<div class="bc-note">No new buys until tomorrow 20:00.</div>');
  });

  test("ONE summary line under the board: the whole account's positions, since entry with its %, up and down", () => {
    const m = boardModel(state(), O);
    expect(m.foot.replace(/<[^>]+>/g, "")).toMatch(/^18 positions open · [+−]\$[\d,]+ since entry \([+−][\d.]+ %\) · \d+ up, \d+ down$/);
    store.state.lang = "es";
    expect(boardModel(state(), O).foot.replace(/<[^>]+>/g, "")).toMatch(/^18 posiciones abiertas · sin cerrar [+−]\$[\d,]+ \([+−][\d.]+ %\) · \d+ ganan, \d+ pierden$/);
  });

  test("the line that explains why the columns do not add up to the total: only when every column has its value, on the whole-account view", () => {
    const all = { ...state().curves, momentum_crypto_usdc: history([15_600, 13_000]) };
    const profiles = [{ pnlAggregate: { equity: 100_000 } }];
    // 100,000 − (49,903 + 24,820 + 9,310 + 13,000) = 2,967
    const m = boardModel(state({ curves: all, profiles }), O);
    expect(m.out).toBe('<span title="Total equity $100,000 = the strategies $97,033 + $2,967 outside them">Outside the strategies: $2,967 (Alpaca&#39;s initial cash and BTC collateral)</span>');
    expect(renderBoard(m)).toContain('<span id="bdOut" class="bd-out"><span title=');
    // one strategy without a value: no figure over a partial sum
    expect(boardModel(state({ profiles }), O).out).toBe("");
    // no total yet, or a single-strategy view: nothing
    expect(boardModel(state({ curves: all }), O).out).toBe("");
    expect(boardModel(state({ curves: all, profiles, view: "momentum_stocks" }), O).out).toBe("");
  });

  test("the board's markup: a column per strategy, the number of columns for the grid, no scroller, nothing in English left in Spanish", () => {
    const html = renderBoard(boardModel(state(), O));
    expect(html).toContain('<div class="bd" style="--n:4" data-ids="meanrev_stocks,momentum_stocks,momentum_crypto,momentum_crypto_usdc">');
    expect(html.match(/<section class="bc" data-id=/g)).toHaveLength(4);
    expect(html).toContain('<div class="bd-foot"><span id="bdSum">');
    expect(html).not.toMatch(/overflow|scroll/);
    store.state.lang = "es";
    const es = renderBoard(boardModel(state(), O));
    expect(es).toContain("en 30 días");
    expect(es).toContain("hace 30 días");
    expect(es).not.toMatch(/positions open|since entry|in 30 days|Decided|Last action/);
  });
});
