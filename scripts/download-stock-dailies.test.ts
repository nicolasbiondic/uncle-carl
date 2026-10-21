import { describe, expect, test } from "bun:test";
import { mergeBarPages, refreshStockDailies, stockRefreshUniverse, RW_D1_ETFS } from "./download-stock-dailies";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMembership, SP500_SOURCE_COMMIT } from "./import-sp500-membership";

describe("mergeBarPages", () => {
  test("collects and orders bars from multiple pages for the same symbol", () => {
    const pages = [
      {
        AAPL: [
          { t: "2024-01-02T00:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1000 },
          { t: "2024-01-03T00:00:00Z", o: 101, h: 102, l: 100, c: 101, v: 1000 },
        ],
      },
      {
        AAPL: [
          { t: "2024-01-01T00:00:00Z", o: 99, h: 100, l: 98, c: 99, v: 1000 },
          { t: "2024-01-04T00:00:00Z", o: 102, h: 103, l: 101, c: 102, v: 1000 },
        ],
      },
    ];

    const out = mergeBarPages(pages);
    expect(Object.keys(out)).toEqual(["AAPL"]);
    expect(out.AAPL.map(b => b.timestamp)).toEqual([
      Date.parse("2024-01-01T00:00:00Z"),
      Date.parse("2024-01-02T00:00:00Z"),
      Date.parse("2024-01-03T00:00:00Z"),
      Date.parse("2024-01-04T00:00:00Z"),
    ]);
    expect(out.AAPL.map(b => b.close)).toEqual([99, 100, 101, 102]);
  });

  test("keeps all bars for validation and merges across symbols", () => {
    const pages = [
      {
        AAPL: [{ t: "2024-01-01T00:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1000 }],
        MSFT: [{ t: "2024-01-01T00:00:00Z", o: 200, h: 201, l: 199, c: 0, v: 1000 }],
      },
      {
        MSFT: [{ t: "2024-01-01T00:00:00Z", o: 200, h: 201, l: 199, c: 200, v: 1000 }],
      },
    ];

    const out = mergeBarPages(pages);
    expect(out.AAPL).toHaveLength(1);
    expect(out.MSFT).toHaveLength(2);
    expect(out.MSFT.map(b => b.close)).toEqual([0, 200]);
  });

  test("survives empty pages and missing symbols", () => {
    const out = mergeBarPages([{}, { AAPL: [] }, { TSLA: [{ t: "2024-01-01T00:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 1 }] }]);
    expect(out.AAPL ?? []).toHaveLength(0);
    expect(out.TSLA).toHaveLength(1);
  });
});

describe("RW daily stock refresh", () => {
  test("includes all 18 ETFs and bootstraps pinned current PIT members offline", () => {
    const db = new Database(":memory:");
    try {
      const symbols = stockRefreshUniverse(db, "2026-10-19");
      expect(RW_D1_ETFS).toHaveLength(18);
      for (const s of RW_D1_ETFS) expect(symbols).toContain(s);
      const members = db.query("SELECT ticker FROM index_membership WHERE end_date IS NULL").all() as Array<{ ticker: string }>;
      expect(members.length).toBeGreaterThan(490);
      for (const { ticker } of members) expect(symbols).toContain(ticker);
      expect(new Set(symbols).size).toBe(symbols.length);
      expect(db.query("SELECT DISTINCT source_commit c FROM index_membership").all()).toEqual([{ c: SP500_SOURCE_COMMIT }]);
    } finally { db.close(); }
  });

  test("keeps newer membership and uses inclusive start / exclusive end", () => {
    const db = new Database(":memory:");
    try {
      writeMembership(db, [
        { ticker: "NEW-PIT", startDate: "2026-10-19", endDate: null },
        { ticker: "OLD-PIT", startDate: "2020-01-01", endDate: "2026-10-19" },
        { ticker: "FUTURE-PIT", startDate: "2026-10-20", endDate: null },
      ], { indexId: "sp500", source: "newer-fixture", sourceCommit: "newer" });
      const symbols = stockRefreshUniverse(db, "2026-10-19");
      expect(symbols).toContain("NEW-PIT");
      expect(symbols).not.toContain("OLD-PIT");
      expect(symbols).not.toContain("FUTURE-PIT");
      expect(db.query("SELECT DISTINCT source_commit c FROM index_membership").all()).toEqual([{ c: "newer" }]);
    } finally { db.close(); }
  });

  const raw = (close = 100) => ({ t: "2026-10-16T04:00:00Z", o: close, h: close + 1, l: close - 1, c: close, v: 1000 });
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-refresh-"));
    return { dbPath: join(dir, "historical.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };
  const options = { key: "fake", secret: "fake", start: "2016-01-04", end: "2026-10-19T00:00:00Z" };

  test("batches 50 symbols, follows pagination and paces EVERY request", async () => {
    const f = fixture();
    const calls: URL[] = [], delays: number[] = [];
    const symbols = Array.from({ length: 51 }, (_, i) => `S${i}`);
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(String(input)); calls.push(url);
      const page = url.searchParams.get("page_token");
      const batch = url.searchParams.get("symbols")!.split(",");
      return Response.json({ bars: page ? {} : Object.fromEntries(batch.map(s => [s, [raw()]])), next_page_token: calls.length === 1 ? "page2" : null });
    }) as typeof fetch;
    try {
      expect(await refreshStockDailies({ ...options, dbPath: f.dbPath, symbols, fetchFn, sleep: async ms => { delays.push(ms); } })).toBe(51);
      expect(calls).toHaveLength(3);
      expect(calls.map(c => c.searchParams.get("symbols")!.split(",").length)).toEqual([50, 50, 1]);
      expect(calls[1].searchParams.get("page_token")).toBe("page2");
      for (const c of calls) {
        expect(c.origin + c.pathname).toBe("https://data.alpaca.markets/v2/stocks/bars");
        expect(c.searchParams.get("adjustment")).toBe("all");
        expect(c.searchParams.get("feed")).toBe("sip");
        expect(c.searchParams.get("start")).toBe(options.start);
        expect(c.searchParams.get("end")).toBe(options.end);
      }
      expect(delays).toEqual([400, 400, 400]);
    } finally { f.cleanup(); }
  });

  test("idempotent full-series upserts rebase historical corporate actions; invalid refresh preserves old rows", async () => {
    const f = fixture(); let close = 200, invalid = false;
    const fetchFn = (async () => Response.json({ bars: { HON: invalid ? [] : [raw(close)] } })) as typeof fetch;
    const opts = { ...options, dbPath: f.dbPath, symbols: ["HON"], fetchFn, sleep: async () => {} };
    try {
      await refreshStockDailies(opts);
      close = 100; // later split/spin-off revises the old bar, not just the tail
      await refreshStockDailies(opts);
      await refreshStockDailies(opts);
      invalid = true;
      await expect(refreshStockDailies(opts)).rejects.toThrow("FAIL-CLOSED");
      const db = new Database(f.dbPath, { readonly: true });
      try {
        expect(db.query("SELECT symbol, close, source FROM historical_bars").all()).toEqual([{ symbol: "HON", close: 100, source: "alpaca_wide" }]);
      } finally { db.close(); }
    } finally { f.cleanup(); }
  });

  test("first 429 aborts pagination AND all later batches, without retries or writes", async () => {
    const f = fixture(); let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return calls === 1 ? Response.json({ bars: { SPY: [raw()] }, next_page_token: "next" }) : new Response("rate limited", { status: 429 });
    }) as typeof fetch;
    try {
      await expect(refreshStockDailies({ ...options, dbPath: f.dbPath, symbols: ["SPY", ...Array.from({ length: 50 }, (_, i) => `S${i}`)], fetchFn, sleep: async () => {} })).rejects.toThrow("ALPACA_RATE_LIMIT_429");
      expect(calls).toBe(2);
      const db = new Database(f.dbPath, { readonly: true });
      try { expect(db.query("SELECT COUNT(*) n FROM historical_bars").get()).toEqual({ n: 0 }); }
      finally { db.close(); }
    } finally { f.cleanup(); }
  });

  test("PIT tapes retain real in-series jumps; optional legacy failures do not block required symbols", async () => {
    const f = fixture();
    const calls: URL[] = [];
    const seed = new Database(f.dbPath);
    writeMembership(seed, [{ ticker: "PIT-REAL", startDate: "2010-01-01", endDate: null }], { indexId: "sp500", source: "fixture", sourceCommit: "newer" });
    seed.close();
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(String(input)); calls.push(url);
      const symbols = url.searchParams.get("symbols")!.split(",");
      return Response.json({ bars: Object.fromEntries(symbols.map(s => [s, s === "AAPL" ? [] : s === "PIT-REAL" ? [
        { ...raw(100), t: "2026-10-14T04:00:00Z" },
        { ...raw(280), t: "2026-10-15T04:00:00Z" }, raw(280),
      ] : [raw()]])) });
    }) as typeof fetch;
    try {
      await refreshStockDailies({ ...options, dbPath: f.dbPath, fetchFn, sleep: async () => {} });
      const pitCalls = calls.filter(c => c.searchParams.get("symbols")!.split(",").includes("PIT-REAL"));
      expect(pitCalls).toHaveLength(1);
      expect(pitCalls[0].searchParams.get("asof")).toBe("2010-01-01");
      for (const c of calls.filter(c => !pitCalls.includes(c))) expect(c.searchParams.has("asof")).toBe(false);
      const db = new Database(f.dbPath, { readonly: true });
      try {
        expect(db.query("SELECT COUNT(*) n FROM historical_bars WHERE symbol='PIT-REAL'").get()).toEqual({ n: 3 });
      } finally { db.close(); }
    } finally { f.cleanup(); }
  });

  test("cron stocks-only delegates to SIP refresh once, never appends Yahoo stock bars", () => {
    const backfill = readFileSync(join(import.meta.dir, "backfill-historical.ts"), "utf8");
    const cron = readFileSync(join(import.meta.dir, "refresh-historical.sh"), "utf8");
    expect(backfill).toContain("const stockBarsWritten = skipStocks ? 0 : await refreshStockDailies()");
    expect(backfill).not.toContain('yahoo.fetchBars(sym, "1d"');
    expect(cron.match(/run scripts\/backfill-historical.ts --stocks-only/g)).toHaveLength(1);
    expect(cron).not.toContain('run scripts/download-stock-dailies.ts');
  });
});
