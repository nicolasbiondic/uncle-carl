// ── The "Bot" tab: compact cards and one line per pass (owner, 2026-10-25/26) ──
// The fixture is Saturday 2026-10-24 14:30 New York as the bot really stood;
// the viewer is pinned to New York so the clock words are deterministic.
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  renderBotNow, chipsOf, noteOf, timeLine, statusOf, eventSentence, groupEventsByDay,
  clusterPasses, passSummary, untilWord, whenPhrase, reasonWord, grossPhrase, sinceWord, portfolioName,
} from "./botnow.js";
import { BOT_NOW_FIXTURE as FX, FIXTURE_NOW as NOW } from "./botnow.fixture.js";
import { renderAnalyticsShell } from "./analytics.js";
import { api } from "../api.js";
import { store } from "../store.js";

const O = { now: NOW, tz: "America/New_York" };
const by = (id) => FX.portfolios.find((p) => p.id === id);
const langBefore = store.state.lang;
beforeEach(() => { store.state.lang = "en"; });
afterAll(() => { store.state.lang = langBefore; });

describe("one compact card per portfolio", () => {
  test("momentum stocks: chips with the facts, a time line with both ends, no sentence when nothing is blocked", () => {
    const p = by("momentum_stocks");
    expect(chipsOf(p)).toEqual(["Invested $51,767", "Leverage 1× of 2.5×", "S&P 500 +5% vs its 200-day average"]);
    expect(noteOf(p, O)).toBe("");
    const tl = timeLine(p, O);
    expect(tl).toContain("Last decision</span> yesterday 09:35 New York");
    expect(tl).toContain("Next decision</span> Monday 09:35 New York");
    expect(tl).toContain(">now<");
    expect(statusOf(p)).toEqual({ word: "Invested", color: "var(--up)" });
  });

  test("mean reversion: asset count and no leverage chip", () => {
    expect(chipsOf(by("meanrev_stocks"))).toEqual(["Invested $53,200", "32 stocks"]);
    expect(timeLine(by("meanrev_stocks"), O)).toContain("Next decision</span> Monday 09:35 New York");
  });

  test("momentum crypto, flat: the reason is the chip; the hourly check is relative", () => {
    const p = by("momentum_crypto");
    expect(chipsOf(p)).toEqual(["None of 8 coins is trending up"]);
    expect(noteOf(p, O)).toBe("");
    const tl = timeLine(p, O);
    expect(tl).toContain("Last decision</span> 1 min ago");
    expect(tl).toMatch(/Next decision<\/span> in \d+ min/);
    expect(tl).not.toContain("New York");
    expect(statusOf(p)).toEqual({ word: "Out of the market", color: "var(--muted)" });
  });

  test("USDC, trimmed by drawdown: size and peak chips, the one sentence, times on the viewer's clock", () => {
    const p = by("momentum_crypto_usdc");
    expect(chipsOf(p)).toEqual(["Invested $4,700", "79% of normal size", "16% below its peak"]);
    expect(noteOf(p, O)).toBe("No new buys until tomorrow 20:00."); // Sunday 00:00 UTC in the viewer's clock
    const tl = timeLine(p, O);
    expect(tl).toContain("Last decision</span> yesterday 20:00");
    expect(tl).toContain("Next decision</span> today 20:00");
    expect(statusOf(p)).toEqual({ word: "Invested, trading smaller", color: "var(--warn)" });
  });

  test("the same, in Spanish", () => {
    store.state.lang = "es";
    expect(chipsOf(by("momentum_stocks"))).toEqual(["Invertido $51,767", "Apalancamiento 1× de 2.5×", "S&P 500 +5% frente a su media de 200 días"]);
    expect(chipsOf(by("momentum_crypto"))).toEqual(["Ninguna de 8 criptomonedas está en tendencia alcista"]);
    expect(noteOf(by("momentum_crypto_usdc"), O)).toBe("Sin compras nuevas hasta mañana a las 20:00.");
    expect(timeLine(by("momentum_stocks"), O)).toContain("Próxima decisión</span> el lunes a las 09:35 Nueva York");
    expect(whenPhrase("2026-10-27T00:00:00Z", O)).toBe("el lunes a las 20:00");
    expect(statusOf(by("momentum_crypto"))).toEqual({ word: "Fuera del mercado", color: "var(--muted)" });
    expect(portfolioName("Momentum Crypto USDC")).toBe("Momentum Cripto USDC");
  });

  test("the other states: waiting for a first pass, paused, problem, cash because of the regime", () => {
    const base = { id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", engine: "portfolio", positions: 0, cadence: { kind: "daily", at: "09:35 ET" }, nextDecisionAt: "2026-10-26T13:35:00Z" };
    expect(statusOf({ ...base, state: "waiting_first_pass" }).color).toBe("var(--accent)");
    expect(noteOf({ ...base, state: "waiting_first_pass" }, O)).toBe("A new model version goes live at its next decision.");
    expect(timeLine({ ...base, state: "waiting_first_pass" }, O)).toContain('class="bn-tl-solo"'); // no last decision yet: only the next one
    const paused = { ...base, state: "paused", positions: 3, investedUsd: 1200, blocked: { reason: "hard_drawdown", until: "2026-10-27T13:35:00Z" } };
    expect(chipsOf(paused)).toEqual(["Drawdown limit", "Holds 3 stocks and ETFs ($1,200)"]);
    expect(noteOf(paused, O)).toBe("Trading paused until Tuesday 09:35 New York: it fell too far from its peak.");
    expect(statusOf({ ...base, state: "error" })).toEqual({ word: "Problem", color: "var(--down)" });
    expect(noteOf({ ...base, state: "error", blocked: { reason: "broker", detail: "Alpaca rejected the key" } }, O)).toBe("Alpaca rejected the key");
    const cash = { ...base, state: "flat", regime: { riskOn: false, ref: "SPY", distancePct: -2.3 } };
    expect(chipsOf(cash)).toEqual(["S&P 500 −2.3% vs its 200-day average"]);
    expect(chipsOf({ ...base, state: "flat" })).toEqual(["Holds no positions"]);
    expect(timeLine({ ...base, state: "paused" }, O)).toContain("Monday 09:35 New York");
    expect(timeLine({ id: "x" }, O)).toBe("");
  });

  test("each card is shorter than the old paragraph: at most three chips and one sentence", () => {
    for (const p of FX.portfolios) {
      expect(chipsOf(p).length).toBeLessThanOrEqual(3);
      expect(noteOf(p, O).split(/[.:;] /).length).toBeLessThanOrEqual(2);
    }
  });

  test("no jargon leaks into the cards", () => {
    const all = FX.portfolios.flatMap((p) => [...chipsOf(p), noteOf(p, O)]).join(" ") + renderBotNow(FX, O);
    for (const w of ["λ", "gross", "soft", "TSM", "exposureScale", "riskOn", "null", "undefined", "NaN", "MAX_HOLD"]) expect(all).not.toContain(w);
  });
});

describe("recent actions", () => {
  const names = Object.fromEntries(FX.portfolios.map((p) => [p.id, p]));
  const at = (iso) => Date.parse(iso);
  const close = (symbol, pnlUsd, over = {}) => ({ at: at("2026-10-22T13:36:10Z"), portfolioId: "momentum_stocks", kind: "close", symbol, qty: 1, usd: 100, pnlUsd, reason: "MAX_HOLD", detail: null, ...over });

  test("newest first, grouped by the viewer's day: Today / Yesterday / Thu 22 Oct", () => {
    const g = groupEventsByDay(FX.events, O);
    expect(g.map((x) => x.label)).toEqual(["Today", "Yesterday", "Thu 22 Oct"]);
    expect(g[0].items.map((e) => e.time)).toEqual(["12:02"]);          // 16:02Z = 12:02 New York
    expect(g[1].items.map((e) => e.kind)).toEqual(["resize", "rebalance"]); // 00:00 UTC = 20:00 New York the evening before; newest first
    expect(g[1].items.map((e) => e.time)).toEqual(["20:00", "09:41"]);
  });

  test("each event is a sentence with the reason in words", () => {
    const [cutover, resize, rebalance, sell] = FX.events;
    expect(eventSentence(sell, names)).toBe('Momentum Stocks sold NVDA, −$410 <span class="bn-why">— trailing stop</span>');
    expect(eventSentence(rebalance, names)).toBe('Mean Reversion Stocks rebalanced 37 positions ($48,200) <span class="bn-why">— daily rebalance</span>');
    expect(eventSentence({ ...rebalance, buys: 32, sells: 5 }, names)).toBe('Mean Reversion Stocks bought 32 and sold 5 ($48,200) <span class="bn-why">— daily rebalance</span>');
    expect(eventSentence({ kind: "resize", portfolioId: "momentum_crypto_usdc", symbol: "SOL/USDC", usd: -269, reason: "EXPOSURE_CONTROL", detail: "Resized SOL/USDC ×0.794: λ 0.794" }, names)).not.toContain("λ");
    expect(eventSentence({ kind: "resize", portfolioId: "momentum_crypto_usdc", symbol: "SOL/USDC", usd: -269 }, names)).toContain("trimmed");
    expect(eventSentence(resize, names)).toBe('Momentum Crypto USDC trimmed 4 positions ($1,250) <span class="bn-why">— drawdown control</span>');
    expect(eventSentence(cutover, names)).toContain("Momentum Stocks switched to a new model version");
    expect(eventSentence({ kind: "buy", portfolioId: "meanrev_stocks", qty: 32, usd: 48200 }, names)).toBe("Mean Reversion Stocks bought 32 stocks ($48,200)");
    expect(eventSentence({ kind: "stop", portfolioId: "momentum_crypto_usdc", symbol: "SOL/USDC", pnlUsd: -88.4, reason: "stop_loss" }, names)).toBe('Momentum Crypto USDC was stopped out of SOL/USDC, −$88 <span class="bn-why">— stop-loss</span>');
    expect(eventSentence({ kind: "error", portfolioId: null, detail: "<b>x</b>" }, names)).toBe('Problem in The bot <span class="muted">&lt;b&gt;x&lt;/b&gt;</span>');
  });

  test("a 5-day close reads \"closed X at the 5-day limit\", never \"sold … max hold\"", () => {
    const spy = close("SPY", -210);
    expect(eventSentence(spy, names)).toBe("Momentum Stocks closed SPY at the 5-day limit (−$210)");
    expect(eventSentence(spy, names, { rebought: true })).toBe("Momentum Stocks closed SPY at the 5-day limit (−$210) and re-bought it");
    expect(eventSentence(spy, names, { bare: true })).toBe("closed SPY at the 5-day limit (−$210)");
    // the momentum engines write TIME_STOP (kind "stop"); same words
    expect(eventSentence(close("BTC/USD", -90, { kind: "stop", reason: "TIME_STOP", portfolioId: "momentum_crypto" }), names)).toBe("Momentum Crypto closed BTC/USD at the 5-day limit (−$90)");
    for (const e of [spy, close("X", 1, { reason: "TIME_STOP" }), close("X", 1, { reason: "BREAKOUT_SHORT_TIME_STOP" })]) {
      const s = eventSentence(e, names);
      expect(s).not.toContain("sold");
      expect(s).not.toContain("max hold");
      expect(s).not.toContain("bn-why");
    }
    store.state.lang = "es";
    expect(eventSentence(spy, names, { rebought: true })).toBe("Momentum Stocks cerró SPY por el límite de 5 días (−$210) y lo volvió a comprar");
  });

  test("events of one portfolio less than a minute apart are one pass; other portfolios and kinds are not folded in", () => {
    const items = groupEventsByDay([
      { ...close("QQQ", -134), at: at("2026-10-22T13:35:42Z") },
      { at: at("2026-10-22T13:35:30Z"), portfolioId: "meanrev_stocks", kind: "buy", symbol: "ABC", usd: 50 },
      close("SPY", -210, { at: at("2026-10-22T13:35:40Z") }),
      { at: at("2026-10-22T13:35:00Z"), portfolioId: "momentum_stocks", kind: "rebalance", usd: 100, buys: 1, sells: 2, rebought: ["SPY"] },
      { at: at("2026-10-22T13:20:00Z"), portfolioId: "momentum_stocks", kind: "pause", reason: "SOFT_DRAWDOWN" },
      { at: at("2026-10-21T13:35:00Z"), portfolioId: "momentum_stocks", kind: "sell", symbol: "NVDA" },
    ], O)[0].items;
    const rows = clusterPasses(items);
    expect(rows.map((r) => [r.portfolioId, r.events.length])).toEqual([["momentum_stocks", 3], ["meanrev_stocks", 1], ["momentum_stocks", 1]]);
    expect(clusterPasses(null)).toEqual([]);
  });

  test("a pass reads as one line: closes at the limit, rebuys, new buys", () => {
    const events = [
      close("QQQ", -134, { at: at("2026-10-22T13:35:42Z") }), close("SPY", -210, { at: at("2026-10-22T13:35:40Z") }),
      { at: at("2026-10-22T13:35:00Z"), portfolioId: "momentum_stocks", kind: "rebalance", reason: "daily_rebalance", usd: 18000, buys: 3, sells: 2, rebought: ["SPY", "QQQ"], newBuyUsd: 6400 },
    ];
    const s = passSummary(events, names);
    expect(s.text).toBe("Momentum Stocks: closed 2 positions at the 5-day limit (−$344) and re-bought them, 1 new buy ($6,400)");
    expect(s.lines).toEqual([
      "closed QQQ at the 5-day limit (−$134) and re-bought it",
      "closed SPY at the 5-day limit (−$210) and re-bought it",
      'bought 3 and sold 2 ($18,000) <span class="bn-why">— daily rebalance</span>',
      "re-bought SPY, QQQ",
    ]);
    // only some of the closed names came back
    expect(passSummary([close("SPY", -210), close("QQQ", -134), { ...events[2], rebought: ["SPY"], buys: 2 }], names).text)
      .toContain("closed 2 positions at the 5-day limit (−$344) and re-bought 1 of them");
    // one close, the buy of the same symbol came from an order row, not a rebalance
    expect(passSummary([{ ...close("SPY", -210), portfolioId: "meanrev_stocks" }, { at: at("2026-10-22T13:36:00Z"), portfolioId: "meanrev_stocks", kind: "buy", symbol: "SPY", usd: 900 }], names).text)
      .toBe("Mean Reversion Stocks: closed SPY at the 5-day limit (−$210) and re-bought it");
    // the rebalance alone (its closes fell outside the list): still says what happened
    expect(passSummary([events[2]], names).text).toBe("Momentum Stocks: closed and re-bought 2 positions at the 5-day limit, 1 new buy ($6,400)");
    // no limit closes: plain wording; stops and trims have their own clause
    expect(passSummary([
      { at: at("2026-10-22T13:35:01Z"), portfolioId: "meanrev_stocks", kind: "buy", symbol: "AAA", usd: 100 },
      { at: at("2026-10-22T13:35:00Z"), portfolioId: "meanrev_stocks", kind: "stop", symbol: "BBB", pnlUsd: -40, reason: "stop_loss" },
    ], names).text).toBe("Mean Reversion Stocks: stopped out of BBB (−$40), bought AAA ($100)");
    store.state.lang = "es";
    expect(passSummary(events, names).text).toBe("Momentum Stocks: cerró 2 posiciones por el límite de 5 días (−$344) y las volvió a comprar, 1 compra nueva ($6,400)");
  });

  test("the tab shows a pass as one line with the per-symbol lines behind a disclosure", () => {
    const html = renderBotNow(FX, O);
    expect(html).toContain('<span class="bn-time">09:35</span><details class="bn-pass"><summary>Momentum Stocks: closed 2 positions at the 5-day limit (−$344) and re-bought them, 1 new buy ($6,400)</summary>');
    expect(html).toContain("<li>closed SPY at the 5-day limit (−$210) and re-bought it</li>");
    expect(html).not.toContain("sold SPY");
    expect(html.match(/<details/g)).toHaveLength(1);
  });

  test("reason codes map to words in one table; unknown codes read as words, never as codes", () => {
    expect(reasonWord("trailing_stop")).toBe("trailing stop");
    expect(reasonWord("slot_displaced")).toBe("a stronger pick took its slot");
    expect(reasonWord("something_new")).toBe("something new");
    expect(reasonWord(null)).toBe("");
    for (const code of ["MAX_HOLD", "TIME_STOP", "BREAKOUT_SHORT_TIME_STOP"]) expect(reasonWord(code)).toBe("5-day limit");
    store.state.lang = "es";
    expect(reasonWord("daily_rebalance")).toBe("rebalanceo diario");
    expect(reasonWord("MAX_HOLD")).toBe("límite de 5 días");
    expect(reasonWord("BREAKOUT_SHORT_TIME_STOP")).toBe("límite de 5 días");
  });
});

describe("time in words", () => {
  test("viewer's clock first, New York named when it differs — and alone when it is New York", () => {
    const mon = "2026-10-26T13:35:00Z";
    expect(whenPhrase(mon, { ...O, market: "America/New_York" })).toBe("Monday 09:35 New York");
    expect(whenPhrase(mon, { now: NOW, tz: "Europe/Madrid", market: "America/New_York" })).toBe("Monday 14:35 (09:35 New York)");
    expect(whenPhrase(mon, { now: NOW, tz: "Europe/Madrid" })).toBe("Monday 14:35");
    expect(whenPhrase("2026-10-24T20:00:00Z", O)).toBe("today 16:00");
    expect(whenPhrase("2026-11-10T14:00:00Z", O)).toBe("10 Nov 09:00");
    expect(whenPhrase("garbage", O)).toBe("");
  });

  test("relative words for recent things", () => {
    expect(sinceWord(NOW - 20e3, NOW)).toBe("just now");
    expect(sinceWord(NOW - 60e3, NOW)).toBe("1 min ago");
    expect(sinceWord(NOW - 3 * 3600e3, NOW)).toBe("3 h ago");
    expect(sinceWord(NOW - 2 * 86400e3, NOW)).toBe("2 days ago");
    expect(untilWord(NOW + 20e3, NOW)).toBe("in under a minute");
    expect(untilWord(NOW + 28 * 60e3, NOW)).toBe("in 28 min");
    expect(untilWord(NOW + 2 * 3600e3, NOW)).toBe("in 2 h");
  });

  test("gross exposure in words", () => {
    expect(grossPhrase(0.97)).toBe("about 1× its capital");
    expect(grossPhrase(1.5)).toBe("1.5× its capital");
    expect(grossPhrase(null)).toBe("");
  });
});

describe("the tab", () => {
  test("renders every portfolio block, the status dot and the actions header", () => {
    const html = renderBotNow(FX, O);
    expect(html.match(/class="bn-row"/g)).toHaveLength(4);
    expect(html).toContain('<span class="bn-name">Momentum Stocks</span>');
    expect(html).toContain('<span class="bn-dot" style="background:var(--up)"></span>Invested</span>');
    expect(html).toContain('<span class="bn-dot" style="background:var(--warn)"></span>Invested, trading smaller</span>');
    expect(html.match(/class="bn-tl"/g)).toHaveLength(4);   // each card carries its time line
    expect(html.match(/class="bn-chip"/g).length).toBeGreaterThanOrEqual(8);
    expect(html).toContain(">Recent actions<");
    expect(html).toContain('<div class="bn-day">Today</div>');
    expect(html).toContain('<span class="bn-time">12:02</span>');
  });

  test("escapes what the API sends", () => {
    const html = renderBotNow({ portfolios: [{ id: "x", label: "<img>", state: "error", blocked: { detail: "<script>" } }], events: [] }, O);
    expect(html).not.toContain("<img>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img&gt;");
  });

  test("empty and error states are one quiet line", () => {
    expect(renderBotNow(null, O)).toBe('<div class="empty">The bot has not reported yet.</div>');
    expect(renderBotNow({ portfolios: [], events: [] }, O)).toContain("No portfolios are running.");
    expect(renderBotNow({ portfolios: FX.portfolios, events: [] }, O)).toContain("No actions in the last few days.");
    expect(renderBotNow({ portfolios: FX.portfolios }, O)).toContain("No actions in the last few days.");
  });

  test("Bot is the first tab of the analytics card and api.botNow exists", () => {
    const saved = store.state.tab;
    store.state.tab = "bot";
    const html = renderAnalyticsShell();
    expect(html.indexOf('data-atab="bot"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-atab="bot"')).toBeLessThan(html.indexOf('data-atab="equity"'));
    expect(html).toContain('class="tab on" data-atab="bot">Bot<');
    store.state.tab = saved;
    expect(typeof api.botNow).toBe("function");
  });
});
