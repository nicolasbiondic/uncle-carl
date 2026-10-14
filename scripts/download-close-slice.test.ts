/**
 * Pure-helper tests for the §12-septies 15:45-slice downloader
 * (scripts/download-close-slice.ts) plus the adjustment-consistency spot
 * checks on real split days (gated on the research DBs being present —
 * they are machine-local and gitignored).
 *
 * Adjustment consistency (the pre-registered mandate): the 15:45 price must
 * sit on the SAME split/dividend basis as the daily closes it is compared
 * with. The downloader stores RAW prints and the kernels compute
 *   p1545_adj = adjClose × raw1545 / rawClose;
 * on a split day (NVDA 2024-06-10 10:1, AAPL 2020-08-31 4:1, TSLA
 * 2022-08-25 3:1) the raw1545/rawClose ratio must stay near 1 — a basis
 * mismatch (e.g. raw intraday vs adjusted daily) would show up as a ratio
 * near the split factor instead.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { adjusted1545, chunkSymbols, etWallTimeToUtcMs, pickBarAt, pickDailyBar, sliceStartMs } from "./download-close-slice";
import { researchDataPath } from "./lib/researchData";

describe("download-close-slice pure helpers", () => {
  test("etWallTimeToUtcMs is DST-safe (EST vs EDT) via America/New_York", () => {
    // 2024-01-15 is EST (UTC−5): 15:30 ET = 20:30Z.
    expect(etWallTimeToUtcMs("2024-01-15", 15 * 60 + 30)).toBe(Date.parse("2024-01-15T20:30:00Z"));
    // 2024-06-10 is EDT (UTC−4): 15:30 ET = 19:30Z.
    expect(etWallTimeToUtcMs("2024-06-10", 15 * 60 + 30)).toBe(Date.parse("2024-06-10T19:30:00Z"));
    // Spring-forward day itself (2024-03-10): 15:30 ET is already EDT.
    expect(etWallTimeToUtcMs("2024-03-10", 15 * 60 + 30)).toBe(Date.parse("2024-03-10T19:30:00Z"));
    // Fall-back day (2024-11-03): 15:30 ET is EST again.
    expect(etWallTimeToUtcMs("2024-11-03", 15 * 60 + 30)).toBe(Date.parse("2024-11-03T20:30:00Z"));
  });

  test("sliceStartMs: 15:30 ET on normal sessions, 12:30 ET on early closes", () => {
    // Normal session.
    expect(sliceStartMs("2024-06-10")).toBe(Date.parse("2024-06-10T19:30:00Z"));
    // Black Friday 2023-11-24 (13:00 close): slice starts 12:30 ET (EST).
    expect(sliceStartMs("2023-11-24")).toBe(Date.parse("2023-11-24T17:30:00Z"));
    // Christmas Eve 2024-12-24 (13:00 close, EST).
    expect(sliceStartMs("2024-12-24")).toBe(Date.parse("2024-12-24T17:30:00Z"));
    // July 3 2024 (13:00 close, EDT): 12:30 ET = 16:30Z.
    expect(sliceStartMs("2024-07-03")).toBe(Date.parse("2024-07-03T16:30:00Z"));
  });

  test("chunkSymbols keeps each URL-encoded symbols param under the byte cap", () => {
    const syms = Array.from({ length: 500 }, (_, i) => `SYM${String(i).padStart(3, "0")}`); // 6 chars each
    const chunks = chunkSymbols(syms, 100);
    expect(chunks.flat()).toEqual(syms); // order-preserving, lossless
    for (const chunk of chunks) {
      const encoded = chunk.join("%2C");
      expect(encoded.length).toBeLessThanOrEqual(100);
    }
    // A single symbol longer than the cap still travels (own chunk).
    expect(chunkSymbols(["A".repeat(200)], 100)).toEqual([["A".repeat(200)]]);
  });

  test("pickBarAt takes only the bar stamped exactly at the slice start", () => {
    const want = Date.parse("2024-06-10T19:30:00Z");
    const bars = {
      NVDA: [
        { t: "2024-06-10T19:15:00Z", c: 120 },
        { t: "2024-06-10T19:30:00Z", c: 121.5 },
      ],
      MSFT: [{ t: "2024-06-10T19:45:00Z", c: 400 }], // not the slice bar
      BAD: [{ t: "2024-06-10T19:30:00Z", c: 0 }],    // zero price rejected
    };
    const got = pickBarAt(bars, want);
    expect(got.get("NVDA")).toBe(121.5);
    expect(got.has("MSFT")).toBe(false);
    expect(got.has("BAD")).toBe(false);
  });

  test("pickDailyBar matches by ET session date", () => {
    const bars = { AAPL: [{ t: "2024-06-10T04:00:00Z", c: 193.12 }] };
    expect(pickDailyBar(bars, "2024-06-10").get("AAPL")).toBe(193.12);
    expect(pickDailyBar(bars, "2024-06-11").has("AAPL")).toBe(false);
  });

  test("adjusted1545 applies the §12-septies basis formula and rejects junk", () => {
    expect(adjusted1545(121.44, 121.9692, 121.79)).toBeCloseTo(121.44 * (121.9692 / 121.79), 12);
    expect(adjusted1545(0, 1, 1)).toBeNull();
    expect(adjusted1545(1, 0, 1)).toBeNull();
    expect(adjusted1545(1, 1, 0)).toBeNull();
  });
});

// ── split-day spot checks on the real research DBs (machine-local) ────────
const SLICE_DB = researchDataPath("hist-sp500-close.db");
const DAILY_DB = researchDataPath("hist-sp500.db");
const haveDbs = existsSync(SLICE_DB) && existsSync(DAILY_DB);

describe.skipIf(!haveDbs)("split-day adjustment consistency (research DBs)", () => {
  const CASES: Array<{ symbol: string; session: string }> = [
    { symbol: "NVDA", session: "2024-06-10" }, // first session after the 10:1 split
    { symbol: "AAPL", session: "2020-08-31" }, // first session after the 4:1 split
    { symbol: "TSLA", session: "2022-08-25" }, // first session after the 3:1 split
  ];

  test("raw1545/rawClose stays near 1 on split days (same-basis proof)", () => {
    const db = new Database(SLICE_DB, { readonly: true });
    try {
      for (const { symbol, session } of CASES) {
        const s = db.prepare(`SELECT raw_c1545 c FROM close_slices WHERE symbol = ? AND session = ?`).get(symbol, session) as { c: number } | null;
        const d = db.prepare(`SELECT raw_close c FROM raw_daily_closes WHERE symbol = ? AND session = ?`).get(symbol, session) as { c: number } | null;
        if (!s || !d) continue; // session not yet downloaded — the full-run coverage report declares gaps
        const ratio = s.c / d.c;
        expect(ratio).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.1);
      }
    } finally {
      db.close();
    }
  });

  test("p1545_adj lands within 10% of the session's adjusted close", () => {
    const sdb = new Database(SLICE_DB, { readonly: true });
    const hdb = new Database(DAILY_DB, { readonly: true });
    try {
      for (const { symbol, session } of CASES) {
        const s = sdb.prepare(`SELECT slice_start_ms ms, raw_c1545 c FROM close_slices WHERE symbol = ? AND session = ?`).get(symbol, session) as { ms: number; c: number } | null;
        const d = sdb.prepare(`SELECT raw_close c FROM raw_daily_closes WHERE symbol = ? AND session = ?`).get(symbol, session) as { c: number } | null;
        if (!s || !d) continue;
        // Session's adjusted close from the dailies DB (ET-midnight stamp).
        const adj = hdb.prepare(
          `SELECT close FROM historical_bars WHERE symbol = ? AND source = 'alpaca_wide' AND timeframe = '1d'
             AND timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC LIMIT 1`,
        ).get(symbol, Date.parse(`${session}T00:00:00Z`), Date.parse(`${session}T00:00:00Z`) + 86_400_000) as { close: number } | null;
        if (!adj) continue;
        const p1545 = adjusted1545(adj.close, s.c, d.c)!;
        expect(Math.abs(p1545 / adj.close - 1)).toBeLessThan(0.1);
        // And the slice bar starts exactly 30 minutes before the close.
        expect(s.ms).toBe(sliceStartMs(session));
      }
    } finally {
      sdb.close();
      hdb.close();
    }
  });
});
