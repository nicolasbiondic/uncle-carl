import { expect, test } from "bun:test";
import { sinceStart } from "./profiles.js";
import { sinceStartSub } from "./kpis.js";

// A-1 (2026-11-07): "since start" is the server's ONE display-start window
// (pnlAggregate.sinceStart — the same object the All tile and Telegram use),
// never a frontend sum of broker cards against another anchor.
const st = (sinceStartWindow) => ({ profiles: [{ pnlAggregate: { sinceStart: sinceStartWindow } }] });

test("since start reads the server's display-start window verbatim (date, equity, rebased flag)", () => {
  const start = { at: Date.UTC(2026, 6, 10), date: "2026-07-10", equity: 113180, rebased: false };
  const r = sinceStart(st({ pnl: 4928, pnlPct: 4928 / 113180 * 100, equity: 118108, endAt: Date.UTC(2026, 10, 7), start }));
  expect(r.pnl).toBe(4928);
  expect(r.pct).toBeCloseTo(4928 / 113180 * 100, 9);
  expect(r.startedAt).toBe(Date.UTC(2026, 6, 10));
  expect(r.displayStart).toEqual(start);
});

test("a rebased start keeps the server's null percent — the frontend never invents one", () => {
  const r = sinceStart(st({ pnl: 10, pnlPct: null, equity: 100, endAt: 1, start: { at: 1, date: "2026-01-01", equity: 90, rebased: true } }));
  expect(r.pnl).toBe(10);
  expect(r.pct).toBeNull();
  expect(sinceStartSub(r)).not.toContain("%");
});

test("no figure while the server has no display-start window; the sub line stays empty", () => {
  expect(sinceStart(st(null))).toBeNull();
  expect(sinceStart({ profiles: [{ brokerAccounts: [{ equity: 100, firstEquity: 90 }] }] })).toBeNull();
  expect(sinceStart({ profiles: [] })).toBeNull();
  expect(sinceStartSub(null)).toBe("");
});

test("the sub line reads signed whole dollars, the percent and 'since start'", () => {
  const html = sinceStartSub({ pnl: 4928.4, pct: 4.35, startedAt: null });
  expect(html).toContain("+$4,928");
  expect(html).toContain("+4.4%");
  expect(html).toContain("since start");
});
