import { expect, test } from "bun:test";
import { sinceStart } from "./profiles.js";
import { sinceStartSub } from "./kpis.js";

const st = (brokers) => ({ profiles: [{ brokerAccounts: brokers }] });

test("since start sums both brokers' broker-truth equity against their first equity", () => {
  const r = sinceStart(st([
    { equity: 105479, firstEquity: 102208, startedAt: Date.UTC(2026, 6, 10) },
    { equity: 12629, firstEquity: 10972, startedAt: Date.UTC(2026, 6, 20) },
  ]));
  expect(r.pnl).toBeCloseTo(4928, 6);
  expect(r.pct).toBeCloseTo(4928 / 113180 * 100, 9);
  expect(r.startedAt).toBe(Date.UTC(2026, 6, 10));
});

test("no figure while a broker lacks its first anchor; the sub line stays empty", () => {
  expect(sinceStart(st([{ equity: 100, firstEquity: null }]))).toBeNull();
  expect(sinceStart({ profiles: [] })).toBeNull();
  expect(sinceStartSub(null)).toBe("");
});

test("the sub line reads signed whole dollars, the percent and 'since start'", () => {
  const html = sinceStartSub({ pnl: 4928.4, pct: 4.35, startedAt: null });
  expect(html).toContain("+$4,928");
  expect(html).toContain("+4.4%");
  expect(html).toContain("since start");
});
