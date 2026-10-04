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
  test("shows the realized P&L and close count of the window, with the breakdown link for that window", () => {
    Object.assign(store.state, { lang: "en" });
    const html = realizedSub(7963.43, 19, 7);
    expect(html).toContain("realized");
    expect(html).toContain("+$7,963");
    expect(html).toContain("in 19 closes");
    expect(html).toContain('data-act="pnl-why"');
    expect(html).toContain('data-days="7"');
  });

  test("Spanish wording; no closes reads as such; a missing figure renders nothing", () => {
    Object.assign(store.state, { lang: "es" });
    expect(realizedSub(7963.43, 19, 7)).toContain("cobrado");
    expect(realizedSub(7963.43, 19, 7)).toContain("desglose");
    expect(realizedSub(0, 0, 1)).toContain("sin cierres");
    expect(realizedSub(null, null, 1)).toBe("");
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
  test("each close shows how long it was open", () => {
    Object.assign(store.state, { lang: "en" });
    const html = renderTrades([{ id: "m", status: "closed", symbol: "META", side: "buy", entryPrice: 607.52, exitPrice: 726.71, pnl: 4767.74, pnlPct: 19.6, entryTime: Date.UTC(2026, 8, 4, 13, 48), exitTime: Date.UTC(2026, 8, 28, 13, 35), strategy: "MOMENTUM", closeReason: "MODEL_CUTOVER" }]);
    expect(html).toContain("<th>Held</th>");
    expect(html).toContain("23d 23h");
  });
});
