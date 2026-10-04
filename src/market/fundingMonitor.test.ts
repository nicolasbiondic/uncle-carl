import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  FundingMonitor,
  FUNDING_PERIODS_PER_YEAR,
  ensureFundingTable,
  percentile,
  syncFundingHistory,
  type FetchFn,
} from "./fundingMonitor";

const H8 = 8 * 3_600_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Seed n settled rates for symbol ending at `endMs`, one per 8h. */
function seedHistory(db: Database, symbol: string, rates: number[], endMs = Date.now()): void {
  ensureFundingTable(db);
  const ins = db.prepare(`INSERT OR REPLACE INTO funding_rates (symbol, funding_time, rate) VALUES (?, ?, ?)`);
  rates.forEach((r, i) => ins.run(symbol, endMs - (rates.length - 1 - i) * H8, r));
}

describe("percentile", () => {
  test("nearest-rank on sorted array", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(arr, 0.9)).toBe(90);
    expect(percentile(arr, 0)).toBe(1);
    expect(percentile(arr, 1)).toBe(100);
    expect(percentile([5], 0.9)).toBe(5);
    expect(Number.isNaN(percentile([], 0.9))).toBe(true);
  });
});

describe("syncFundingHistory", () => {
  test("paginates by startTime and upserts idempotently", async () => {
    const db = new Database(":memory:");
    // Page 1: exactly 1000 rows → continue; page 2: 2 rows → stop.
    const t0 = Date.parse("2020-01-01");
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ fundingTime: t0 + i * H8, fundingRate: "0.0001" }));
    const page2 = [
      { fundingTime: t0 + 1000 * H8, fundingRate: "0.0002" },
      { fundingTime: t0 + 1001 * H8, fundingRate: "-0.0003" },
    ];
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      urls.push(url);
      return jsonResponse(urls.length === 1 ? page1 : page2);
    };

    const counts = await syncFundingHistory(db, { symbols: ["BTCUSDT"], fetchFn, pageDelayMs: 0 });
    expect(counts.BTCUSDT).toBe(1002);
    expect(urls).toHaveLength(2);
    // Page 2 resumes from last fundingTime + 1.
    expect(urls[1]).toContain(`startTime=${t0 + 999 * H8 + 1}`);

    const n = db.prepare(`SELECT COUNT(*) n FROM funding_rates`).get() as { n: number };
    expect(n.n).toBe(1002);

    // Re-run: resumes from MAX(funding_time)+1, no new rows, no duplicates.
    const urls2: string[] = [];
    const fetchEmpty: FetchFn = async (url) => { urls2.push(url); return jsonResponse([]); };
    const counts2 = await syncFundingHistory(db, { symbols: ["BTCUSDT"], fetchFn: fetchEmpty, pageDelayMs: 0 });
    expect(counts2.BTCUSDT).toBe(0);
    expect(urls2[0]).toContain(`startTime=${t0 + 1001 * H8 + 1}`);
    const n2 = db.prepare(`SELECT COUNT(*) n FROM funding_rates`).get() as { n: number };
    expect(n2.n).toBe(1002);
  });

  test("HTTP error throws (caller decides fail-open)", async () => {
    const db = new Database(":memory:");
    const fetchFn: FetchFn = async () => jsonResponse({}, 500);
    await expect(syncFundingHistory(db, { symbols: ["BTCUSDT"], fetchFn, pageDelayMs: 0 })).rejects.toThrow("HTTP 500");
  });
});

describe("FundingMonitor", () => {
  function monitorWith(liveRate: number, histRates: number[], symbol = "BTCUSDT") {
    const db = new Database(":memory:");
    seedHistory(db, symbol, histRates);
    const fetchFn: FetchFn = async () =>
      jsonResponse([{ symbol, lastFundingRate: String(liveRate), markPrice: "50000" }]);
    return new FundingMonitor({ db, symbols: [symbol], fetchFn });
  }

  test("getFunding: rate, annualized, percentile vs trailing 90d", async () => {
    // 99 rates at 0.0001, live rate 0.0005 → above all of them.
    const m = monitorWith(0.0005, Array(99).fill(0.0001));
    expect(m.getFunding("BTCUSDT")).toBeNull(); // before first poll
    await m.pollOnce();
    const f = m.getFunding("BTCUSDT")!;
    expect(f.rate).toBeCloseTo(0.0005, 10);
    expect(f.annualized).toBeCloseTo(0.0005 * FUNDING_PERIODS_PER_YEAR, 10);
    expect(f.pctileVs90d).toBe(100);
  });

  test("isCrashRisky: true above P90, false below", async () => {
    // 1..100 bps/100 → P90 = 0.0090.
    const hist = Array.from({ length: 100 }, (_, i) => (i + 1) / 10_000);
    const hot = monitorWith(0.0095, hist);
    await hot.pollOnce();
    expect(hot.isCrashRisky("BTCUSDT")).toBe(true);
    expect(hot.getFunding("BTCUSDT")!.pctileVs90d).toBeGreaterThan(90);

    const cool = monitorWith(0.0050, hist);
    await cool.pollOnce();
    expect(cool.isCrashRisky("BTCUSDT")).toBe(false);
  });

  test("fail-open: fewer than 30 samples → never crash-risky, pctile neutral when empty", async () => {
    const m = monitorWith(0.01, Array(10).fill(0.0001));
    await m.pollOnce();
    expect(m.isCrashRisky("BTCUSDT")).toBe(false);

    const empty = monitorWith(0.01, []);
    await empty.pollOnce();
    expect(empty.isCrashRisky("BTCUSDT")).toBe(false);
    expect(empty.getFunding("BTCUSDT")!.pctileVs90d).toBe(50);
  });

  test("fail-open: failed poll keeps stale rates, never throws", async () => {
    const db = new Database(":memory:");
    seedHistory(db, "BTCUSDT", Array(50).fill(0.0001));
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls++;
      if (calls === 1) return jsonResponse([{ symbol: "BTCUSDT", lastFundingRate: "0.0002" }]);
      throw new Error("network down");
    };
    const m = new FundingMonitor({ db, symbols: ["BTCUSDT"], fetchFn });
    await m.pollOnce();
    expect(m.getFunding("BTCUSDT")!.rate).toBeCloseTo(0.0002, 10);
    await m.pollOnce(); // fails
    expect(m.getFunding("BTCUSDT")!.rate).toBeCloseTo(0.0002, 10); // stale kept
  });

  test("percentile window ignores rates older than 90d", async () => {
    const db = new Database(":memory:");
    // 50 ancient high rates (outside window) + 50 recent low ones.
    seedHistory(db, "BTCUSDT", Array(50).fill(0.01), Date.now() - 91 * 86_400_000);
    seedHistory(db, "BTCUSDT", Array(50).fill(0.0001), Date.now());
    const fetchFn: FetchFn = async () => jsonResponse([{ symbol: "BTCUSDT", lastFundingRate: "0.0002" }]);
    const m = new FundingMonitor({ db, symbols: ["BTCUSDT"], fetchFn });
    await m.pollOnce();
    // vs the RECENT window (all 0.0001), 0.0002 is above P90.
    expect(m.isCrashRisky("BTCUSDT")).toBe(true);
  });
});
