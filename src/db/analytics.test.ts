import { describe, expect, test, beforeAll } from "bun:test";
import {
  getDB, getETHourDow,
  getHourlyAnalytics, getSymbolAnalytics,
} from "./database";
import { makeTestDb } from "../test-support/db";

beforeAll(() => { makeTestDb(); });

let seq = 0;
function seedClosed(opts: { symbol: string; profile: string; account: string; exitTime: number; pnl: number }) {
  getDB().prepare(
    `INSERT INTO trades (id, symbol, market, side, strategy, entry_price, quantity,
       entry_time, status, exit_time, pnl, pnl_pct, profile_id, account_id, close_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `t_${seq++}`, opts.symbol, "stock", "buy", "COMBINED", 100, 1,
    opts.exitTime - 3_600_000, "closed", opts.exitTime, opts.pnl, opts.pnl, opts.profile, opts.account, null,
  );
}

describe("getETHourDow — ET wall-clock bucketing", () => {
  test("converts UTC→ET hour with DST awareness (EDT vs EST)", () => {
    // 12:00 UTC in June is 08:00 EDT (−4); in January it is 07:00 EST (−5).
    expect(getETHourDow(Date.UTC(2026, 5, 15, 12, 0, 0)).hour).toBe(8);
    expect(getETHourDow(Date.UTC(2026, 0, 15, 12, 0, 0)).hour).toBe(7);
  });
  test("dow is the ET calendar weekday (0=Sun..6=Sat)", () => {
    // 2026-01-01 12:00 UTC → still Jan 1 in ET → Thursday = 4.
    expect(getETHourDow(Date.UTC(2026, 0, 1, 12, 0, 0)).dow).toBe(4);
  });
});

describe("getHourlyAnalytics — ET buckets", () => {
  test("buckets a trade by its ET hour, not the server-UTC hour", () => {
    const exit = Date.UTC(2026, 5, 15, 12, 0, 0); // 08:00 EDT
    seedClosed({ symbol: "AAPL", profile: "et_prof", account: "alpaca_low", exitTime: exit, pnl: 9 });
    const hourly = getHourlyAnalytics("et_prof", 3650);
    expect(hourly).toHaveLength(24);
    expect(hourly.find(h => h.hour === 8)!.tradeCount).toBe(1); // ET hour
    expect(hourly.find(h => h.hour === 12)!.tradeCount).toBe(0); // NOT the UTC hour
  });
});

describe("analytics SQL injection is neutralized", () => {
  test("a malicious profileId is treated as a literal (matches nothing)", () => {
    seedClosed({ symbol: "MSFT", profile: "real_prof", account: "alpaca_high", exitTime: Date.now() - 60_000, pnl: 5 });
    // Pre-parameterization this string broke out of the quotes and returned every row.
    const evil = getSymbolAnalytics("' OR '1'='1", 3650);
    expect(evil).toHaveLength(0);
    // The legitimate profile still resolves correctly.
    expect(getSymbolAnalytics("real_prof", 3650).some(r => r.symbol === "MSFT")).toBe(true);
  });
});
