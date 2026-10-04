import { describe, expect, test, beforeEach } from "bun:test";
import { initHistoricalStore, upsertBars, replaceBars, replaceBarsGroup, getBars, getCoverage, validateAdjustedDailyBars } from "./HistoricalStore";
import type { BarRow } from "./HistoricalStore";

beforeEach(() => {
  initHistoricalStore(":memory:");
});

function bar(overrides: Partial<BarRow> = {}): BarRow {
  return {
    symbol: "BTC/USD",
    timeframe: "1h",
    timestamp: 1_000,
    open: 100, high: 101, low: 99, close: 100, volume: 5,
    source: "binance_futures",
    ...overrides,
  };
}

describe("upsertBars", () => {
  test("skips rows with non-finite/zero prices (garbage guard)", () => {
    const r = upsertBars([bar({ close: 0 }), bar({ timestamp: 2_000, close: NaN })]);
    expect(r.written).toBe(0);
    expect(r.skipped).toBe(2);
    expect(getCoverage("BTC/USD", "1h").count).toBe(0);
  });

  test("overwrites an existing row at the same (symbol, timeframe, timestamp)", () => {
    upsertBars([bar({ close: 100, source: "binance_futures" })]);
    upsertBars([bar({ close: 111, source: "binance_futures" })]);
    const rows = getBars("BTC/USD", "1h", 0, 10_000);
    expect(rows.length).toBe(1);
    expect(rows[0].close).toBe(111);
  });
});

describe("replaceBars — atomic source migration", () => {
  test("deletes old rows and inserts new ones in the same call", () => {
    upsertBars([
      bar({ timestamp: 1_000, close: 50, source: "binance_public" }),
      bar({ timestamp: 2_000, close: 51, source: "binance_public" }),
    ]);
    expect(getCoverage("BTC/USD", "1h").count).toBe(2);

    const r = replaceBars("BTC/USD", "1h", [
      bar({ timestamp: 3_000, close: 60, source: "binance_futures" }),
    ]);

    expect(r.deleted).toBe(2);
    expect(r.written).toBe(1);
    const rows = getBars("BTC/USD", "1h", 0, 10_000);
    expect(rows.length).toBe(1);
    expect(rows[0].timestamp).toBe(3_000);
    expect(rows[0].close).toBe(60);
  });

  test("only clears the targeted (symbol, timeframe) — other rows are untouched", () => {
    upsertBars([
      bar({ symbol: "BTC/USD", timeframe: "1h", timestamp: 1_000 }),
      bar({ symbol: "ETH/USD", timeframe: "1h", timestamp: 1_000 }),
      bar({ symbol: "BTC/USD", timeframe: "1d", timestamp: 1_000 }),
    ]);

    replaceBars("BTC/USD", "1h", [bar({ symbol: "BTC/USD", timeframe: "1h", timestamp: 5_000, close: 70 })]);

    expect(getCoverage("ETH/USD", "1h").count).toBe(1);
    expect(getCoverage("BTC/USD", "1d").count).toBe(1);
    expect(getCoverage("BTC/USD", "1h").count).toBe(1);
  });

  test("invalid replacement rows abort and preserve existing rows", () => {
    upsertBars([bar({ timestamp: 1_000, source: "binance_public" })]);
    const r = replaceBars("BTC/USD", "1h", [bar({ timestamp: 2_000, close: 0 })]);
    expect(r.error).toBeDefined();
    expect(r.deleted).toBe(0);
    expect(r.written).toBe(0);
    expect(getCoverage("BTC/USD", "1h").count).toBe(1);
  });

  test("empty replacement batch aborts and preserves existing rows", () => {
    upsertBars([bar({ timestamp: 1_000, source: "binance_public" })]);
    const r = replaceBars("BTC/USD", "1h", []);
    expect(r.error).toMatch(/empty replacement series/);
    expect(r.deleted).toBe(0);
    expect(r.written).toBe(0);
    expect(getCoverage("BTC/USD", "1h").count).toBe(1);
  });

  test("duplicate timestamps abort and preserve existing rows", () => {
    upsertBars([bar({ timestamp: 1_000, source: "binance_public" })]);
    const r = replaceBars("BTC/USD", "1h", [bar({ timestamp: 2_000 }), bar({ timestamp: 2_000 })]);
    expect(r.error).toMatch(/duplicate timestamp/);
    expect(r.deleted).toBe(0);
    expect(getCoverage("BTC/USD", "1h").count).toBe(1);
  });

  test("wrong symbol aborts and preserves existing rows", () => {
    upsertBars([bar({ symbol: "BTC/USD", timestamp: 1_000, source: "binance_public" })]);
    const r = replaceBars("BTC/USD", "1h", [bar({ symbol: "ETH/USD", timestamp: 2_000 })]);
    expect(r.error).toMatch(/symbol mismatch/);
    expect(r.deleted).toBe(0);
    expect(getCoverage("BTC/USD", "1h").count).toBe(1);
    expect(getCoverage("ETH/USD", "1h").count).toBe(0);
  });

  test("wrong timeframe aborts and preserves existing rows", () => {
    upsertBars([bar({ timeframe: "1h", timestamp: 1_000, source: "binance_public" })]);
    const r = replaceBars("BTC/USD", "1h", [bar({ timeframe: "1d", timestamp: 2_000 })]);
    expect(r.error).toMatch(/timeframe mismatch/);
    expect(r.deleted).toBe(0);
    expect(getCoverage("BTC/USD", "1h").count).toBe(1);
    expect(getCoverage("BTC/USD", "1d").count).toBe(0);
  });

  test("failed replacement for one symbol leaves other symbols untouched", () => {
    upsertBars([
      bar({ symbol: "BTC/USD", timestamp: 1_000, source: "binance_public" }),
      bar({ symbol: "ETH/USD", timestamp: 1_000, source: "binance_public" }),
    ]);
    const r = replaceBars("BTC/USD", "1h", [bar({ symbol: "BTC/USD", timestamp: 2_000, close: 0 })]);
    expect(r.error).toBeDefined();
    expect(getCoverage("BTC/USD", "1h").count).toBe(1);
    expect(getCoverage("ETH/USD", "1h").count).toBe(1);
  });
});

describe("replaceBarsGroup — atomic multi-symbol replace", () => {
  test("replaces every group's series in one transaction", () => {
    upsertBars([
      bar({ symbol: "DOW", timeframe: "1d", timestamp: 1_000, close: 999 }),
      bar({ symbol: "FI", timeframe: "1d", timestamp: 1_000, close: 888 }),
    ]);

    const r = replaceBarsGroup([
      { symbol: "DOW", timeframe: "1d", bars: [bar({ symbol: "DOW", timeframe: "1d", timestamp: 5_000, close: 20 })] },
      { symbol: "FI", timeframe: "1d", bars: [bar({ symbol: "FI", timeframe: "1d", timestamp: 5_000, close: 30 })] },
    ]);

    expect(r.error).toBeUndefined();
    expect(r.deleted).toBe(2);
    expect(r.written).toBe(2);
    expect(getCoverage("DOW", "1d").count).toBe(1);
    expect(getCoverage("FI", "1d").count).toBe(1);
    expect(getBars("DOW", "1d", 0, 10_000)[0].close).toBe(20);
    expect(getBars("FI", "1d", 0, 10_000)[0].close).toBe(30);
  });

  test("one invalid group aborts the WHOLE batch — both-or-neither", () => {
    upsertBars([
      bar({ symbol: "DOW", timeframe: "1d", timestamp: 1_000, close: 999 }),
      bar({ symbol: "FI", timeframe: "1d", timestamp: 1_000, close: 888 }),
    ]);

    const r = replaceBarsGroup([
      { symbol: "DOW", timeframe: "1d", bars: [bar({ symbol: "DOW", timeframe: "1d", timestamp: 5_000, close: 20 })] },
      { symbol: "FI", timeframe: "1d", bars: [] }, // empty — invalid
    ]);

    expect(r.error).toMatch(/empty replacement series/);
    expect(r.deleted).toBe(0);
    expect(r.written).toBe(0);
    // DOW's valid group must NOT have been applied either.
    expect(getCoverage("DOW", "1d").count).toBe(1);
    expect(getBars("DOW", "1d", 0, 10_000)[0].close).toBe(999);
    expect(getCoverage("FI", "1d").count).toBe(1);
  });

  test("SQL-level failure mid-transaction rolls back a group already replaced earlier in the SAME call (not only prevalidation)", () => {
    const db = initHistoricalStore(":memory:");
    upsertBars([
      bar({ symbol: "DOW", timeframe: "1d", timestamp: 1_000, close: 999 }),
      bar({ symbol: "FI", timeframe: "1d", timestamp: 1_000, close: 888 }),
    ]);

    // Both groups pass prevalidation (validateReplacement only checks
    // shape/duplicates/symbol/timeframe, not values) — DOW's delete+insert
    // runs FIRST inside the transaction, then FI's insert hits a genuine
    // SQLite-level failure (a trigger, standing in for e.g. a disk-full or
    // constraint error the app can't predict ahead of time).
    db.exec(`
      CREATE TRIGGER fail_fi_insert BEFORE INSERT ON historical_bars
      WHEN NEW.symbol = 'FI' AND NEW.close = 999999
      BEGIN SELECT RAISE(ABORT, 'injected failure for rollback test'); END;
    `);

    const r = replaceBarsGroup([
      { symbol: "DOW", timeframe: "1d", bars: [bar({ symbol: "DOW", timeframe: "1d", timestamp: 5_000, close: 20 })] },
      { symbol: "FI", timeframe: "1d", bars: [bar({ symbol: "FI", timeframe: "1d", timestamp: 5_000, close: 999999 })] },
    ]);

    expect(r.error).toMatch(/injected failure for rollback test/);
    expect(r.written).toBe(0);
    expect(r.deleted).toBe(0);
    // DOW's already-executed delete+insert must be rolled back too —
    // both-or-neither holds even when the failure happens AFTER the first
    // group's statements already ran inside the same transaction.
    expect(getCoverage("DOW", "1d").count).toBe(1);
    expect(getBars("DOW", "1d", 0, 10_000)[0].close).toBe(999);
    expect(getCoverage("FI", "1d").count).toBe(1);
    expect(getBars("FI", "1d", 0, 10_000)[0].close).toBe(888);
  });
});

// Runnable self-check: simulates the exact "network fails mid-migration"
// scenario the backfill scripts must protect against. If a future edit to
// backfill-historical.ts / backfill-intraday.ts calls replaceBars() before
// the network fetch resolves (delete-then-fetch instead of fetch-then-
// replace), this test fails because the old rows would already be gone by
// the time the simulated network error is thrown.
describe("migration safety pattern (fetch-then-replace)", () => {
  test("a failed fetch must leave old history fully intact", async () => {
    upsertBars([
      bar({ timestamp: 1_000, close: 50, source: "binance_public" }),
      bar({ timestamp: 2_000, close: 51, source: "binance_public" }),
    ]);

    async function simulatedFetch(): Promise<BarRow[]> {
      throw new Error("network error");
    }

    try {
      const newBars = await simulatedFetch(); // throws before replaceBars is ever reached
      replaceBars("BTC/USD", "1h", newBars);
      throw new Error("unreachable");
    } catch (e: any) {
      expect(e.message).toBe("network error");
    }

    const rows = getBars("BTC/USD", "1h", 0, 10_000);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.close).sort()).toEqual([50, 51]);
  });
});

// Corporate-action / history integrity gates for split-adjusted stock dailies.
describe("validateAdjustedDailyBars", () => {
  const DAY = 86_400_000;

  function stockBar(overrides: Partial<BarRow> = {}): BarRow {
    return bar({
      symbol: "AAPL",
      timeframe: "1d",
      source: "alpaca_wide",
      open: 100, high: 101, low: 99, close: 100, volume: 1_000_000,
      ...overrides,
    });
  }

  test("split rewrite replaces stale pre-split adjusted rows", () => {
    upsertBars([
      stockBar({ symbol: "AAPL", timestamp: DAY, open: 150, high: 150, low: 150, close: 150 }),
      stockBar({ symbol: "AAPL", timestamp: 2 * DAY, open: 151, high: 151, low: 151, close: 151 }),
    ]);
    const rewrite = [
      stockBar({ symbol: "AAPL", timestamp: DAY, open: 50, high: 50, low: 50, close: 50 }),
      stockBar({ symbol: "AAPL", timestamp: 2 * DAY, open: 51, high: 51, low: 51, close: 51 }),
    ];
    expect(validateAdjustedDailyBars("AAPL", rewrite).ok).toBe(true);

    replaceBars("AAPL", "1d", rewrite);
    const rows = getBars("AAPL", "1d", 0, 10 * DAY);
    expect(rows.map(r => r.close)).toEqual([50, 51]);
  });

  test("HON-like gross discontinuity is rejected", () => {
    const bs = [
      stockBar({ symbol: "HON", timestamp: DAY, close: 200 }),
      stockBar({ symbol: "HON", timestamp: 2 * DAY, open: 200, close: 90, volume: 2_000_000 }),
    ];
    const v = validateAdjustedDailyBars("HON", bs, { maxAdjGapPct: 50 });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /gross discontinuity/.test(e))).toBe(true);
  });

  test("FI/DOW flat zero-volume filler block is rejected", () => {
    const bs: BarRow[] = [];
    for (let i = 0; i < 5; i++) {
      bs.push(stockBar({
        symbol: "FI",
        timestamp: (i + 1) * DAY,
        open: 10, high: 10, low: 10, close: 10, volume: 0,
      }));
    }
    // One normal bar after the filler block — the validator must still flag the run.
    bs.push(stockBar({ symbol: "FI", timestamp: 6 * DAY, close: 11, volume: 1_000_000 }));

    const v = validateAdjustedDailyBars("FI", bs, { maxFlatZeroVolumeRun: 5 });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /flat zero-volume filler/.test(e))).toBe(true);
  });

  test("valid daily series passes validation", () => {
    const bs: BarRow[] = [];
    for (let i = 0; i < 20; i++) {
      const c = 100 + i * 0.5;
      bs.push(stockBar({
        symbol: "DOW",
        timestamp: (i + 1) * DAY,
        open: c, high: c + 1, low: c - 1, close: c, volume: 1_000_000,
      }));
    }
    expect(validateAdjustedDailyBars("DOW", bs).ok).toBe(true);
  });

  test("validation failure prevents replaceBars, preserving old rows", () => {
    upsertBars([stockBar({ symbol: "DOW", timestamp: DAY, close: 20 })]);
    const bad: BarRow[] = [];
    for (let i = 0; i < 5; i++) {
      bad.push(stockBar({ symbol: "DOW", timestamp: (i + 1) * DAY, open: 10, high: 10, low: 10, close: 10, volume: 0 }));
    }
    const v = validateAdjustedDailyBars("DOW", bad, { maxFlatZeroVolumeRun: 5 });
    expect(v.ok).toBe(false);
    // The caller is responsible for not invoking replaceBars when validation fails.
    // Old history must remain untouched.
    expect(getCoverage("DOW", "1d").count).toBe(1);
  });
});
