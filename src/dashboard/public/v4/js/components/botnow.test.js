// ── The "Bot" tab reads as sentences, not numbers (owner, 2026-10-25) ──────
// The fixture is Saturday 2026-10-24 14:30 New York as the bot really stood;
// the viewer is pinned to New York so the clock words are deterministic.
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  renderBotNow, describePortfolio, statusOf, eventSentence, groupEventsByDay,
  whenPhrase, reasonWord, grossPhrase, sinceWord, portfolioName,
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

describe("one block per portfolio, in plain sentences", () => {
  test("momentum stocks: what it holds, why it stays, when it decides next and what changes", () => {
    const s = describePortfolio(by("momentum_stocks"), O);
    expect(s).toEqual([
      "Invested in 11 stocks and ETFs ($51,767, about 1× its capital).",
      "The S&P 500 is 5% above its 200-day average, so it stays invested.",
      "Last decision yesterday: no orders.",
      "Next decision Monday 09:35 New York; it can use up to 2.5× leverage.",
    ]);
    expect(statusOf(by("momentum_stocks"))).toEqual({ word: "Invested", color: "var(--up)" });
  });

  test("mean reversion: last decision with its order count, next decision", () => {
    const s = describePortfolio(by("meanrev_stocks"), O);
    expect(s).toEqual([
      "Invested in 32 stocks ($53,200, about 1× its capital).",
      "Last decision yesterday: 37 orders, none rejected.",
      "Next decision Monday 09:35 New York.",
    ]);
  });

  test("momentum crypto, flat: why it holds nothing and how often it looks", () => {
    const s = describePortfolio(by("momentum_crypto"), O);
    expect(s).toEqual([
      "None of its 8 coins is trending up.",
      "It checks every hour (last check 1 min ago).",
    ]);
    expect(statusOf(by("momentum_crypto"))).toEqual({ word: "Out of the market", color: "var(--muted)" });
  });

  test("USDC, trimmed by drawdown: the smaller size, the reason, until when (viewer's clock, no market zone for crypto)", () => {
    const s = describePortfolio(by("momentum_crypto_usdc"), O);
    expect(s).toEqual([
      "Holding 4 coins at 79% of normal size ($4,700): it is 16% below its peak, so it trades smaller.",
      "Last decision yesterday: 4 orders, none rejected.",
      "No new buys until tomorrow 20:00.", // Sunday 00:00 UTC, in the viewer's clock
      "Next decision today 20:00.",
    ]);
    expect(statusOf(by("momentum_crypto_usdc"))).toEqual({ word: "Invested, trading smaller", color: "var(--warn)" });
  });

  test("the same, in Spanish", () => {
    store.state.lang = "es";
    expect(describePortfolio(by("momentum_stocks"), O)).toEqual([
      "Invertido en 11 acciones y ETFs ($51,767, aproximadamente 1× de su capital).",
      "El S&P 500 está un 5% por encima de su media de 200 días, así que sigue invertido.",
      "Última decisión ayer: sin órdenes.",
      "Próxima decisión el lunes a las 09:35 Nueva York; puede usar hasta 2.5× de apalancamiento.",
    ]);
    expect(describePortfolio(by("momentum_crypto"), O)).toEqual([
      "Ninguna de sus 8 criptomonedas está en tendencia alcista.",
      "Revisa cada hora (última revisión hace 1 min).",
    ]);
    expect(describePortfolio(by("momentum_crypto_usdc"), O)[2]).toBe("Sin compras nuevas hasta mañana a las 20:00.");
    expect(whenPhrase("2026-10-27T00:00:00Z", O)).toBe("el lunes a las 20:00");
    expect(statusOf(by("momentum_crypto"))).toEqual({ word: "Fuera del mercado", color: "var(--muted)" });
    expect(portfolioName("Momentum Crypto USDC")).toBe("Momentum Cripto USDC");
  });

  test("the other states: waiting for a first pass, paused, problem, cash because of the regime", () => {
    const base = { id: "momentum_stocks", label: "Momentum Stocks", broker: "alpaca", engine: "portfolio", positions: 0, cadence: { kind: "daily", at: "09:35 ET" }, nextDecisionAt: "2026-10-26T13:35:00Z" };
    expect(statusOf({ ...base, state: "waiting_first_pass" }).color).toBe("var(--accent)");
    expect(describePortfolio({ ...base, state: "waiting_first_pass", version: "v2" }, O)).toEqual([
      "A new model version goes live at its next decision.",
      "Next decision Monday 09:35 New York.",
    ]);
    expect(describePortfolio({ ...base, state: "paused", positions: 3, investedUsd: 1200, blocked: { reason: "hard_drawdown", until: "2026-10-27T13:35:00Z" } }, O)).toEqual([
      "Trading paused until Tuesday 09:35 New York: it fell too far from its peak.",
      "It still holds 3 stocks and ETFs ($1,200).",
    ]);
    expect(statusOf({ ...base, state: "error" })).toEqual({ word: "Problem", color: "var(--down)" });
    expect(describePortfolio({ ...base, state: "error", blocked: { reason: "broker", detail: "Alpaca rejected the key" } }, O)).toEqual(["Alpaca rejected the key"]);
    expect(describePortfolio({ ...base, state: "flat", regime: { riskOn: false, ref: "SPY", distancePct: -2.3 } }, O)[0])
      .toBe("The S&P 500 is 2.3% below its 200-day average, so it stays in cash.");
  });

  test("no jargon leaks into the sentences", () => {
    const all = FX.portfolios.flatMap((p) => describePortfolio(p, O)).join(" ") + renderBotNow(FX, O);
    for (const w of ["λ", "gross", "soft", "TSM", "exposureScale", "riskOn", "null", "undefined", "NaN"]) expect(all).not.toContain(w);
  });
});

describe("recent actions", () => {
  const names = Object.fromEntries(FX.portfolios.map((p) => [p.id, p]));

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

  test("reason codes map to words in one table; unknown codes read as words, never as codes", () => {
    expect(reasonWord("trailing_stop")).toBe("trailing stop");
    expect(reasonWord("slot_displaced")).toBe("a stronger pick took its slot");
    expect(reasonWord("something_new")).toBe("something new");
    expect(reasonWord(null)).toBe("");
    store.state.lang = "es";
    expect(reasonWord("daily_rebalance")).toBe("rebalanceo diario");
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
