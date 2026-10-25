// 2026-09-29 (owner: "Esos +4000 no los veo" — META closed +$4,767.74 on
// Telegram while the 7D P&L read −$1,877). The P&L KPIs now say what closed
// trades realized in the same window, and the breakdown modal shows why the
// two differ: most of what was realized had been earned before the window.
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { renderKpis, realizedSub } from "./kpis.js";
import { renderBreakdown } from "./pnl-breakdown.js";
import { renderTrades } from "./trades.js";

const originalState = { ...store.state };
afterEach(() => Object.assign(store.state, originalState));

const S7 = Date.UTC(2026, 8, 23, 4, 0);
const week = {
  periodDays: 7, windowStart: S7, pnl: -1877.72, pnlPct: -1.52,
  realized: 7963.43, count: 19, earnedBefore: 9323.8, closedInWindow: -1360.37,
  openChange: -181.65, openCount: 18, other: -335.7,
  closes: [
    { accountId: "momentum_crypto_usdc", symbol: "UNI/USDC", entryTime: Date.UTC(2026, 7, 29), exitTime: Date.UTC(2026, 8, 29), realized: 1649.46, earnedBefore: 2373.64, inWindow: -724.18 },
    { accountId: "momentum_stocks", symbol: "META", entryTime: Date.UTC(2026, 8, 4, 13, 48), exitTime: Date.UTC(2026, 8, 28, 13, 35), realized: 4767.74, earnedBefore: 5163.14, inWindow: -395.4 },
  ],
};

describe("realized line under the P&L KPIs", () => {
  test("shows the realized P&L and close count of the window; no breakdown text or link on the line", () => {
    Object.assign(store.state, { lang: "en" });
    const html = realizedSub(7963.43, 19);
    expect(html).toContain("realized");
    expect(html).toContain("+$7,963");
    expect(html).toContain("in 19 closes");
    expect(html).not.toMatch(/breakdown|data-act|<button|·/);
  });

  test("Spanish wording; no closes reads as such; a missing figure renders nothing", () => {
    Object.assign(store.state, { lang: "es" });
    expect(realizedSub(7963.43, 19)).toContain("cobrado");
    expect(realizedSub(7963.43, 19)).not.toContain("desglose");
    expect(realizedSub(0, 0)).toContain("sin cierres");
    expect(realizedSub(null, null)).toBe("");
  });

  // Owner 2026-10-25: the breakdown is a behaviour of the figure, not one more button.
  test("the P&L figure is the button that opens its window's breakdown", () => {
    Object.assign(store.state, {
      lang: "en", period: 1, view: "consolidated", dashboard: { portfolio: {} },
      profiles: [{ pnlAggregate: { equity: 122173, periodPnl: -51, periodPnlPct: -0.04, pnl7d: -1364, pnl7dPct: -1.1, periodRealized: 0, periodRealizedCount: 0, realized7d: -1364, realized7dCount: 6 } }],
    });
    const html = renderKpis();
    const buttons = [...html.matchAll(/<button type="button" class="kfig" data-act="pnl-why" data-days="(\d+)" title="([^"]+)">(.*?)<\/button>/g)];
    expect(buttons.map((m) => m[1])).toEqual(["1", "7"]);
    expect(buttons[0][2]).toBe("Click for breakdown");
    expect(buttons[0][3]).toContain("−$51");
    expect(buttons[1][3]).toContain("−$1,364");
    expect(html).not.toMatch(/breakdown<|>breakdown|class="lnk"/);
    expect(html).toContain("no closes");
    expect(html).toContain("in 6 closes");
    Object.assign(store.state, { lang: "es" });
    expect(renderKpis()).toContain('title="Clic para ver el desglose"');
  });

  test("a P&L without its realized line (old server) stays a plain, non-clickable figure", () => {
    Object.assign(store.state, {
      lang: "en", period: 1, view: "consolidated", dashboard: { portfolio: {} },
      profiles: [{ pnlAggregate: { equity: 1000, periodPnl: 5, periodPnlPct: 0.5, pnl7d: 7, pnl7dPct: 0.7 } }],
    });
    expect(renderKpis()).not.toContain("pnl-why");
  });

  test("both P&L KPIs carry their own window's figure", () => {
    Object.assign(store.state, {
      lang: "en", period: 0, view: "consolidated", dashboard: { portfolio: {} },
      profiles: [{ pnlAggregate: { equity: 122173, periodPnl: 9568.04, periodPnlPct: 8.7, pnl7d: -1877.72, pnl7dPct: -1.5, periodRealized: 9303.8, periodRealizedCount: 218, realized7d: 7963.43, realized7dCount: 19 } }],
    });
    const html = renderKpis();
    expect(html).toContain("+$9,304");
    expect(html).toContain('data-days="0"');
    expect(html).toContain("+$7,963");
    expect(html).toContain('data-days="7"');
  });
});

describe("renderBreakdown — the bridge from realized to the P&L", () => {
  test("lists realized, earned before the window, the in-window result, open positions, other and the P&L — in that order", () => {
    Object.assign(store.state, { lang: "es" });
    const html = renderBreakdown(week);
    const order = ["Cobrado en 19 cierres", "ganado antes del", "resultado de los cierres dentro del período", "posiciones abiertas, cambio en el período", "funding, comisiones, tesorería y otros", "= P&L 7D"]
      .map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("+$7,963.43");
    expect(html).toContain("−$9,323.80");
    expect(html).toContain("−$1,877.72");
    expect(html).toContain("ya estaba en el P&L antes del período");
  });

  test("the closes table is sorted by size and splits each close into before/within the window", () => {
    Object.assign(store.state, { lang: "en" });
    const html = renderBreakdown(week);
    expect(html.indexOf("META")).toBeLessThan(html.indexOf("UNI/USDC"));
    expect(html).toContain("+$5,163.14");
    expect(html).toContain("−$395.40");
    expect(html).toContain("and 17 more");
  });

  test("no price at the window start: says so instead of a wrong split", () => {
    Object.assign(store.state, { lang: "en" });
    const html = renderBreakdown({ ...week, earnedBefore: null, closedInWindow: null, other: null });
    expect(html).toContain("can't be separated");
    expect(html).not.toContain("earned before Sep");
  });

  test("all-time: no 'earned before' row; open positions are their unrealized P&L", () => {
    Object.assign(store.state, { lang: "en" });
    const html = renderBreakdown({ ...week, periodDays: 0, windowStart: 0, earnedBefore: 0, closedInWindow: 7963.43, pnl: 9568.04 });
    expect(html).not.toContain("earned before");
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
