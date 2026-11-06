// 2026-09-29 (owner: "Esos +4000 no los veo" — META closed +$4,767.74 on
// Telegram while the 7D P&L read −$1,877) and 2026-11-06 (owner: "+$367 ·
// realized −$912" on one tile). The P&L KPIs now say what the period's closes
// and trims made INSIDE the period and what the open positions did — the two
// add up to the headline — and the breakdown modal bridges from "realized
// since entry" to those two figures.
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { renderKpis, closesSub } from "./kpis.js";
import { renderBreakdown } from "./pnl-breakdown.js";
import { renderTrades } from "./trades.js";

const originalState = { ...store.state };
afterEach(() => Object.assign(store.state, originalState));

const T0 = Date.UTC(2026, 10, 6, 5);
// Prod 2026-11-06: 10 renewals + 8 resizes realized −$1,150 since entry, of
// which −$1,323 was earned on earlier days ⇒ closes +$173 today.
const today = {
  periodDays: 1, windowStart: T0, pnl: 367, pnlPct: 0.32, startPrices: "marks",
  realized: -1150.32, count: 10, closesCount: 10, trimsCount: 8, earnedBefore: -1323.4, closedInWindow: 173.08,
  openChange: 75.2, openCount: 51, holding: 118.72, positions: 193.92,
  closes: [
    { accountId: "momentum_stocks", symbol: "QQQ", kind: "close", entryTime: Date.UTC(2026, 10, 2, 14, 39), exitTime: Date.UTC(2026, 10, 6, 14, 38), quantity: 9.09, realized: -313.51, earnedBefore: -288.5, inWindow: -25.01 },
    { accountId: "momentum_stocks", symbol: "SMH", kind: "trim", entryTime: Date.UTC(2026, 10, 4, 14, 37), exitTime: Date.UTC(2026, 10, 6, 14, 38), quantity: 2.05, realized: -89.57, earnedBefore: -75.99, inWindow: -13.58 },
  ],
};
const breakdown = { closedInWindow: 173.08, positions: 193.92, closesCount: 10, trimsCount: 8, startPrices: "marks" };

describe("closes · positions line under the P&L KPIs", () => {
  test("both figures of the SAME window, whole dollars, no since-entry figure, no breakdown text or link on the line", () => {
    Object.assign(store.state, { lang: "en" });
    const html = closesSub(breakdown);
    expect(html).toContain("closes <b");
    expect(html).toContain("+$173");
    expect(html).toContain("positions <b");
    expect(html).toContain("+$194");
    expect(html).not.toContain("1,150");
    expect(html).not.toMatch(/breakdown|data-act|<button|realized|since entry/);
  });

  test("Spanish wording; no legs reads 'sin cierres'; a missing payload renders nothing", () => {
    Object.assign(store.state, { lang: "es" });
    expect(closesSub(breakdown)).toContain("cierres");
    expect(closesSub(breakdown)).toContain("posiciones");
    expect(closesSub(breakdown)).not.toContain("desglose");
    expect(closesSub({ closedInWindow: 0, positions: 0, closesCount: 0, trimsCount: 0 })).toBe("sin cierres");
    expect(closesSub(null)).toBe("");
  });

  test("a start price missing: only the counts, never a guessed dollar figure", () => {
    Object.assign(store.state, { lang: "en" });
    const html = closesSub({ ...breakdown, closedInWindow: null, positions: null });
    expect(html).toBe("10 closes, 8 trims");
    Object.assign(store.state, { lang: "es" });
    expect(closesSub({ ...breakdown, closedInWindow: null, positions: null, trimsCount: 1 })).toBe("10 cierres, 1 recorte");
  });

  // Owner 2026-10-25: the breakdown is a behaviour of the figure, not one more button.
  test("the P&L figure is the button that opens its window's breakdown; its title says both figures share the period", () => {
    Object.assign(store.state, {
      lang: "en", period: 1, view: "consolidated", dashboard: { portfolio: {} },
      profiles: [{ pnlAggregate: {
        equity: 122173, periodPnl: 367, periodPnlPct: 0.32, pnl7d: -1364, pnl7dPct: -1.1,
        periodBreakdown: breakdown,
        breakdown7d: { closedInWindow: -900.4, positions: -463.6, closesCount: 48, trimsCount: 30, startPrices: "bars" },
      } }],
    });
    const html = renderKpis();
    const buttons = [...html.matchAll(/<button type="button" class="kfig" data-act="pnl-why" data-days="(\d+)" title="([^"]+)">(.*?)<\/button>/g)];
    expect(buttons.map((m) => m[1])).toEqual(["1", "7"]);
    expect(buttons[0][2]).toBe("Both within this period — click for the breakdown");
    expect(buttons[0][3]).toContain("+$367");
    expect(buttons[1][3]).toContain("−$1,364");
    expect(html).not.toMatch(/breakdown<|>breakdown|class="lnk"/);
    expect(html).toContain("+$173");
    expect(html).toContain("+$194");
    expect(html).toContain("−$900");
    expect(html).toContain("−$464");
    // closes + positions is the headline, exactly, on both tiles
    expect(173 + 194).toBe(367);
    expect(-900 - 464).toBe(-1364);
    Object.assign(store.state, { lang: "es" });
    expect(renderKpis()).toContain('title="Ambos dentro de este período — clic para ver el desglose"');
  });

  test("a P&L without its bridge (old server) stays a plain, non-clickable figure", () => {
    Object.assign(store.state, {
      lang: "en", period: 1, view: "consolidated", dashboard: { portfolio: {} },
      profiles: [{ pnlAggregate: { equity: 1000, periodPnl: 5, periodPnlPct: 0.5, pnl7d: 7, pnl7dPct: 0.7 } }],
    });
    expect(renderKpis()).not.toContain("pnl-why");
  });

  test("both P&L KPIs carry their own window's figures", () => {
    Object.assign(store.state, {
      lang: "en", period: 0, view: "consolidated", dashboard: { portfolio: {} },
      profiles: [{ pnlAggregate: {
        equity: 122173, periodPnl: 9568.04, periodPnlPct: 8.7, pnl7d: -1877.72, pnl7dPct: -1.5,
        periodBreakdown: { closedInWindow: 9303.8, positions: 264.24, closesCount: 218, trimsCount: 9, startPrices: "marks" },
        breakdown7d: { closedInWindow: -1360.37, positions: -517.35, closesCount: 19, trimsCount: 0, startPrices: "marks" },
      } }],
    });
    const html = renderKpis();
    expect(html).toContain("+$9,304");
    expect(html).toContain('data-days="0"');
    expect(html).toContain("−$1,360");
    expect(html).toContain('data-days="7"');
  });
});

describe("renderBreakdown — the bridge from realized to the tile's two figures", () => {
  test("lists realized since entry, counted before, = closes, open positions, holding and other, = positions, = the P&L — in that order, with the tile figures", () => {
    Object.assign(store.state, { lang: "es" });
    const html = renderBreakdown(today);
    const order = ["Cobrado desde la entrada en 10 cierres y 8 recortes", "ya contado antes del", "= cierres", "posiciones abiertas, cambio de precio en el período", "costes de mantener y otros", "= posiciones", "= P&L de hoy"]
      .map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("−$1,150.32");
    expect(html).toContain("+$1,323.40"); // minus a negative "counted before"
    expect(html).toContain("+$173.08");
    expect(html).toContain("+$193.92");
    expect(html).toContain("+$367.00");
    expect(html).toContain("colateral BTC");
    expect(html).not.toContain("ya estaba");
    expect(html).not.toContain("aproximado"); // marks were used
  });

  test("the legs table is sorted by size, marks trims and splits each leg into before/within the window", () => {
    Object.assign(store.state, { lang: "en" });
    const html = renderBreakdown(today);
    expect(html.indexOf("QQQ")).toBeLessThan(html.indexOf("SMH"));
    expect(html).toContain("SMH <span class=\"muted\">trim</span>");
    expect(html).toContain("−$288.50");
    expect(html).toContain("−$25.01");
    expect(html).toContain("and 16 more"); // 18 legs, 2 shown
  });

  test("start prices from bars: a muted 'approximate' note", () => {
    Object.assign(store.state, { lang: "en" });
    expect(renderBreakdown({ ...today, startPrices: "bars" })).toContain("Start prices from closing bars — approximate.");
    expect(renderBreakdown({ ...today, periodDays: 0, windowStart: 0, startPrices: "bars" })).not.toContain("approximate");
  });

  test("no price at the window start: says so instead of a wrong split", () => {
    Object.assign(store.state, { lang: "en" });
    const html = renderBreakdown({ ...today, earnedBefore: null, closedInWindow: null, holding: null, positions: null });
    expect(html).toContain("can't be separated");
    expect(html).not.toContain("counted before Nov");
  });

  test("all-time: no 'counted before' row; open positions are their unrealized P&L", () => {
    Object.assign(store.state, { lang: "en" });
    const html = renderBreakdown({ ...today, periodDays: 0, windowStart: 0, earnedBefore: 0, closedInWindow: -1150.32, pnl: 9568.04 });
    expect(html).not.toContain("counted before");
    expect(html).toContain("open positions, not yet realized");
    expect(html).toContain("since the start");
  });

  test("a failed fetch renders a message, not a crash", () => {
    Object.assign(store.state, { lang: "en" });
    expect(renderBreakdown(null)).toContain("unavailable");
  });
});

describe("Trades tab — holding time", () => {
  test("compact prices and P&L preserve small crypto prices and percent decimals", () => {
    Object.assign(store.state, { lang: "en" });
    const html = renderTrades([
      { status: "closed", symbol: "SPY", side: "buy", entryPrice: 540.24, exitPrice: 525.49, pnl: -1794.42, pnlPct: -0.3 },
      { status: "closed", symbol: "DOGE/USD", side: "buy", entryPrice: 0.0777, exitPrice: 8.99, pnl: 85.04, pnlPct: 0.3 },
    ]);
    for (const value of ["$540<", "$525<", "−$1,794 ", "$0.0777<", "$8.99<", "+$85 ", "−0.3%"])
      expect(html).toContain(value);
    expect(html).not.toContain("$1,794.42");
  });

  test("each close shows how long it was open", () => {
    Object.assign(store.state, { lang: "en" });
    const html = renderTrades([{ id: "m", status: "closed", symbol: "META", side: "buy", entryPrice: 607.52, exitPrice: 726.71, pnl: 4767.74, pnlPct: 19.6, entryTime: Date.UTC(2026, 8, 4, 13, 48), exitTime: Date.UTC(2026, 8, 28, 13, 35), strategy: "MOMENTUM", closeReason: "MODEL_CUTOVER" }]);
    expect(html).toContain("<th>Held</th>");
    expect(html).toContain(">23d<"); // one unit only (owner, 2026-10-25)
  });
});
