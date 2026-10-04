import { describe, expect, test, afterEach } from "bun:test";
import { parseKline, fetchBars, toBinanceSymbol } from "./BinancePublicFetcher";

const NOW = 1_700_000_000_000;

// A raw Binance kline row: [openTime, open, high, low, close, volume, closeTime, ...]
function rawKline(openTime: number, closeTime: number, close = 100): any[] {
  return [openTime, "99", "101", "98", String(close), "10", closeTime, "0", 1, "0", "0", "0"];
}

describe("parseKline — never persist an incomplete candle", () => {
  test("closed candle (closeTime in the past) is parsed", () => {
    const bar = parseKline(rawKline(NOW - 120_000, NOW - 60_000), "BTC/USD", "1m", NOW);
    expect(bar).not.toBeNull();
    expect(bar!.timestamp).toBe(NOW - 120_000);
    expect(bar!.close).toBe(100);
    expect(bar!.source).toBe("binance_futures");
  });

  test("still-forming candle (closeTime >= now) is rejected", () => {
    const bar = parseKline(rawKline(NOW - 30_000, NOW + 30_000), "BTC/USD", "1m", NOW);
    expect(bar).toBeNull();
  });

  test("candle closing exactly now is rejected (boundary is exclusive)", () => {
    const bar = parseKline(rawKline(NOW - 60_000, NOW), "BTC/USD", "1m", NOW);
    expect(bar).toBeNull();
  });
});

describe("toBinanceSymbol", () => {
  test("maps internal USD pairs to Binance USDT symbols", () => {
    expect(toBinanceSymbol("BTC/USD")).toBe("BTCUSDT");
  });
  test("rejects symbols with no slash", () => {
    expect(toBinanceSymbol("BTCUSDT")).toBeNull();
  });
});

describe("fetchBars — end-to-end incomplete-kline filtering", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("drops the trailing in-progress candle a live API page would include", async () => {
    // fetchBars filters against the real Date.now() at call time, so the
    // still-forming row must close AFTER the moment the test runs.
    const now = Date.now();
    const page = [
      rawKline(now - 180_000, now - 120_000, 100), // closed
      rawKline(now - 120_000, now - 60_000, 101),  // closed
      rawKline(now - 60_000, now + 3_600_000, 999),   // still forming — must NOT be persisted
    ];
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => page,
      text: async () => "",
    })) as any;

    const bars = await fetchBars("BTC/USD", "1m", now - 180_000, now);
    expect(bars.length).toBe(2);
    expect(bars.every(b => b.close !== 999)).toBe(true);
  });
});
