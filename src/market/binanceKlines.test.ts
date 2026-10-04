import { describe, expect, test, afterEach } from "bun:test";
import { klinesToOHLCV, fetchBinanceKlines } from "./binanceKlines";

// Real Binance kline row shape: [openTime, open, high, low, close, volume, closeTime, ...]
const HOUR = 3_600_000;
const row = (t: number, c: number) => [t, `${c - 1}`, `${c + 1}`, `${c - 2}`, `${c}`, "123.45", t + 299_999, "0", 42, "0", "0", "0"];
const NOW = 1_700_001_000_000;

describe("klinesToOHLCV", () => {
  test("maps raw rows to OHLCV with numeric fields", () => {
    const out = klinesToOHLCV([row(1_700_000_000_000, 600)], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ timestamp: 1_700_000_000_000, open: 599, high: 601, low: 598, close: 600, volume: 123.45 });
  });

  test("drops the still-forming bar (closeTime in the future — no lookahead)", () => {
    const closed = row(NOW - 600_000, 600);   // closeTime = NOW - 300_001 → closed
    const partial = row(NOW - 100_000, 601);  // closeTime = NOW + 199_999 → forming
    expect(klinesToOHLCV([closed, partial], NOW)).toHaveLength(1);
  });

  test("drops malformed rows and non-arrays (fail-open)", () => {
    expect(klinesToOHLCV(null, NOW)).toEqual([]);
    expect(klinesToOHLCV({ code: -1121, msg: "Invalid symbol." }, NOW)).toEqual([]);
    expect(klinesToOHLCV([["bad"], row(1, 0), row(2, -5), row(1_700_000_300_000, 601)], NOW)).toHaveLength(1);
  });
});

describe("fetchBinanceKlines pagination (>1500 bars)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("pages backwards by endTime and returns `limit` merged, sorted, sliced bars", async () => {
    // Long-past base so every bar's closeTime is < Date.now() (none dropped as forming).
    const base = 1_600_000_000_000;
    // Simulate 1800 contiguous 1h bars available; server caps each page at 1500.
    const total = 1800;
    const all = Array.from({ length: total }, (_, i) => row(base + i * HOUR, 600 + (i % 5)));
    const calls: Array<number | undefined> = [];
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      const limit = Number(u.searchParams.get("limit"));
      const endTime = u.searchParams.get("endTime") ? Number(u.searchParams.get("endTime")) : undefined;
      calls.push(endTime);
      const upTo = endTime == null ? all.length : all.findIndex(r => Number(r[0]) > endTime);
      const hi = upTo < 0 ? all.length : upTo;
      const page = all.slice(Math.max(0, hi - limit), hi);
      return { ok: true, json: async () => page } as any;
    }) as any;

    const out = await fetchBinanceKlines("BTC/USD", "1Hour", 1700);
    expect(out.length).toBe(1700);                       // sliced to the request
    expect(out[0].timestamp).toBeLessThan(out[out.length - 1].timestamp); // ascending
    // strictly increasing + deduped
    for (let i = 1; i < out.length; i++) expect(out[i].timestamp).toBeGreaterThan(out[i - 1].timestamp);
    expect(calls.length).toBeGreaterThanOrEqual(2);      // actually paged
    expect(calls[0]).toBeUndefined();                    // first page = newest
  });

  test("single request when limit <= 1500 (no endTime paging)", async () => {
    const base = 1_600_000_000_000;
    let n = 0;
    globalThis.fetch = (async () => { n++; return { ok: true, json: async () => [row(base, 600)] } as any; }) as any;
    await fetchBinanceKlines("ETH/USD", "1Hour", 200);
    expect(n).toBe(1);
  });
});

// 2026-07-29: live-path integrity gate. The backtest validator throws on
// gapped/inverted candle series; the live path validated nothing. Inverted/
// duplicate bars are physically impossible from the exchange → [] (caller's
// fallback). A gap only warns: rejecting would fall back to SPARSER Alpaca
// data, which is strictly worse.
describe("fetchBinanceKlines data integrity", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const base = 1_600_000_000_000;

  test("out-of-order series is rejected to [] (physically impossible)", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => [row(base + HOUR, 601), row(base, 600)], // inverted
    })) as any;
    expect(await fetchBinanceKlines("BTC/USD", "1Hour", 200)).toEqual([]);
  });

  test("gapped series is KEPT (warn-only — the fallback is sparser than the gap)", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => [row(base, 600), row(base + HOUR, 601), row(base + 3 * HOUR, 602)], // one missing bar
    })) as any;
    expect(await fetchBinanceKlines("BTC/USD", "1Hour", 200)).toHaveLength(3);
  });
});

// 2026-07-19: product-correct native symbol identity. USDC symbols must
// resolve against USDC_SYMBOL_MAP (BTCUSDC), never the default USDT map —
// and never silently fall back to a USDT proxy for a USDC internal symbol.
describe("fetchBinanceKlines quoteAsset identity", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("USDC symbol resolves to the USDC native pair, not the USDT one", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => [row(1_600_000_000_000, 600)] } as any;
    }) as any;
    const out = await fetchBinanceKlines("BTC/USDC", "1Hour", 200, "USDC");
    expect(out).toHaveLength(1);
    expect(urls[0]).toContain("symbol=BTCUSDC");
    expect(urls[0]).not.toContain("symbol=BTCUSDT");
  });

  test("USDC symbol under the default (USDT) quoteAsset is unmapped -> [] (no proxy, no request)", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return { ok: true, json: async () => [] } as any; }) as any;
    const out = await fetchBinanceKlines("BTC/USDC", "1Hour", 200); // quoteAsset defaults to USDT
    expect(out).toEqual([]);
    expect(called).toBe(false); // never fell back to a USDT-mapped request for a USDC symbol
  });

  test("USDT symbol under quoteAsset=USDC is unmapped -> [] (no cross-product proxy)", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return { ok: true, json: async () => [] } as any; }) as any;
    const out = await fetchBinanceKlines("BTC/USD", "1Hour", 200, "USDC");
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});
