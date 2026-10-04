import { afterEach, describe, expect, test, mock, setSystemTime } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ALPACA_WS_CONTENDED_DELAY_MS, CLIENT_ORDER_ID_MAX_LEN, stopLossClientOrderId, isWashTrade403, isKnownAlpacaPaperHost, alpacaPaperLiveMismatch , GET_BARS_TIMEOUT_MS, STOCK_BARS_MAX_PAGES, STOCK_BARS_FULL_REFETCH_INTERVAL_MS} from "./alpaca-executor";
import { AlpacaExecutor } from "./alpaca-executor";
import { config } from "../config";
import { fetchT as realFetchT, withTimeout as realWithTimeout } from "../utils/timeout";
import { fakeAlpacaExecutor as executor, bar, page, quote, rateLimited, fetchQueue } from "../test-support/alpaca";
import { symbolLocks } from "./symbolLock";

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
});

describe("AlpacaExecutor historical bars", () => {
  for (const [market, symbol] of [["stock", "AAPL"], ["crypto", "BTC/USD"]] as const) {
    test(`${market} continuation failure publishes neither partial bars nor a quote`, async () => {
      const exec = executor();
      fetchQueue(page(symbol, [bar(101)], "continue"), rateLimited);

      expect(await exec.getBars(symbol, "1Hour", 2)).toEqual([]);
      expect(exec.getCachedCandles(symbol, "1Hour")).toEqual([]);
      expect(exec.getCachedPrice(symbol)).toBe(0);
    });
  }

  test("keeps complete fallback isolated by timeframe", async () => {
    const exec = executor();
    const complete = [bar(90)];
    fetchQueue(
      page("AAPL", complete),
      page("AAPL", [bar(91)], "continue"),
      rateLimited,
      page("AAPL", [bar(92)], "continue"),
      rateLimited,
    );

    const hourly = await exec.getBars("AAPL", "1Hour", 2);
    expect(hourly.map(b => b.close)).toEqual([90]);
    expect(await exec.getBars("AAPL", "5Min", 2)).toEqual([]);
    expect(exec.getCachedCandles("AAPL", "1Hour")).toEqual(hourly);
    expect(await exec.getBars("AAPL", "1Hour", 2)).toEqual(hourly);
  });

  test("successful history never becomes an executable price", async () => {
    const exec = executor();
    fetchQueue(page("AAPL", [bar(90)]));

    expect(await exec.getBars("AAPL", "1Hour", 1)).toHaveLength(1);
    expect(exec.getCachedPrice("AAPL")).toBe(0);
  });

  test("stale cache (>30min) is NOT served to the decision path — empty instead (OPEN.md P1)", async () => {
    const exec = executor();
    fetchQueue(page("AAPL", [bar(90)]), rateLimited, rateLimited);
    expect(await exec.getBars("AAPL", "1Hour", 1)).toHaveLength(1);

    // Within the freshness window a failed refresh serves the last-known bars…
    setSystemTime(new Date(Date.now() + 29 * 60_000));
    expect((await exec.getBars("AAPL", "1Hour", 1)).map(b => b.close)).toEqual([90]);

    // …but past the bound the cache must NOT masquerade as data: gates block.
    setSystemTime(new Date(Date.now() + 2 * 60_000)); // total 31min
    expect(await exec.getBars("AAPL", "1Hour", 1)).toEqual([]);
    // Display fallback deliberately still shows the last thing we saw.
    expect(exec.getCachedCandles("AAPL", "1Hour").map(b => b.close)).toEqual([90]);
    setSystemTime();
  });
});

// 2026-08-07: historical stock bars moved IEX → SIP. Measured on HON (same
// daily bar): IEX n=2,903 trades / vol 134,898 / low 239.99 vs SIP n=52,412 /
// vol 2,838,213 / low 239.48 — IEX misses the session's real low by $0.51,
// a systematic optimistic bias for any stop-touch logic on IEX bars. Basic
// accounts get full SIP history when `end` is ≥15min in the past.
describe("AlpacaExecutor SIP historical stock bars (feed=sip, 15-min recency clamp)", () => {
  test("the request carries feed=sip and an end clamped ≥15min into the past", async () => {
    const exec = executor();
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return page("AAPL", [bar(90)]);
    }) as unknown as typeof fetch;

    await exec.getBars("AAPL", "1Hour", 1);

    expect(urls).toHaveLength(1);
    const params = new URL(urls[0]).searchParams;
    expect(params.get("feed")).toBe("sip"); // revert to iex → fails
    const end = Date.parse(params.get("end") ?? "");
    expect(Number.isFinite(end)).toBe(true);
    expect(end).toBeLessThanOrEqual(Date.now() - 15 * 60_000); // inside Basic's allowed SIP window
  });

  // Revert-falsifier: drop the 403→IEX degrade → getBars' generic catch
  // yields [] and the engine loses its bars entirely.
  test("a SIP recency 403 degrades to feed=iex (no end clamp) and still returns bars", async () => {
    const exec = executor();
    const urls: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      if (calls++ === 0) return { ok: false, status: 403, statusText: "Forbidden" } as Response;
      return page("AAPL", [bar(91)]);
    }) as unknown as typeof fetch;

    const bars = await exec.getBars("AAPL", "1Hour", 1);

    expect(bars.map(b => b.close)).toEqual([91]); // engine never left without bars
    expect(new URL(urls[0]).searchParams.get("feed")).toBe("sip");
    const fallback = new URL(urls[1]).searchParams;
    expect(fallback.get("feed")).toBe("iex");
    expect(fallback.get("end")).toBeNull(); // IEX has no recency restriction
  });

  test("a non-403 SIP failure does NOT silently degrade to IEX — gates block on [] instead", async () => {
    const exec = executor();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 500, statusText: "Internal Server Error" } as Response;
    }) as unknown as typeof fetch;

    expect(await exec.getBars("AAPL", "1Hour", 1)).toEqual([]);
    expect(calls).toBe(1); // only the recency 403 triggers the IEX retry
  });

  // TRAP (measured): multi-symbol requests cap `limit` on TOTAL points, not
  // per symbol (5 symbols × 1Hour returned 186 AAPL bars and nothing else).
  // The fetcher stays ONE symbol per request, paged via next_page_token —
  // this pins both properties.
  test("SIP pagination merges every page; requests stay single-symbol (total-points limit trap can't truncate)", async () => {
    const exec = executor();
    const urls: string[] = [];
    const pages = [
      page("AAPL", [bar(90, "2026-07-15T14:00:00Z")], "tok-2"),
      page("AAPL", [bar(91, "2026-07-15T15:00:00Z")]),
    ];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      const p = pages.shift();
      if (!p) throw new Error("unexpected fetch");
      return p;
    }) as unknown as typeof fetch;

    const bars = await exec.getBars("AAPL", "1Hour", 10);

    expect(bars.map(b => b.close)).toEqual([90, 91]); // both pages, in order
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.get("page_token")).toBe("tok-2");
    for (const u of urls) {
      expect(new URL(u).searchParams.get("symbols")).toBe("AAPL"); // never a comma-joined batch
      expect(new URL(u).searchParams.get("feed")).toBe("sip");
    }
  });
});

// ── Incremental stock bars (2026-09-02) ───────────────────────────────────
// The chronic prod failure this kills: every hourly momentum tick re-fetched
// ~2 years × 11 symbols of SIP 5-min history (≈66 paged background requests)
// and 4-6 symbols/day died on getBars timeouts or background-budget denials.
// A warmed cache now fetches only the tail since the last cached bar. The
// invariants that must SURVIVE: full refetch on invalidation (rewritten
// adjusted history is never tail-merged), full refetch past the 6h backstop,
// and the boundary bar (possibly end-clamp-truncated when cached) is always
// re-fetched, never trusted as complete.
describe("AlpacaExecutor incremental stock bars (tail refresh)", () => {
  const t1 = "2026-07-15T14:00:00Z", t2 = "2026-07-15T15:00:00Z", t3 = "2026-07-15T16:00:00Z";
  const iso = (t: string) => new Date(Date.parse(t)).toISOString();

  /** Strict FIFO of Responses that also records every request URL. */
  function captureFetch(pages: Response[], onCall?: (n: number) => void): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      onCall?.(urls.length);
      urls.push(String(url));
      const p = pages.shift();
      if (!p) throw new Error("unexpected fetch");
      return p;
    }) as unknown as typeof fetch;
    return urls;
  }

  test("a warmed cache fetches only from the last cached bar's open time and merges without duplicates or reordering", async () => {
    const exec = executor();
    const urls = captureFetch([
      page("AAPL", [bar(90, t1), bar(91, t2)]),
      // The boundary bar comes back with a DIFFERENT close (92): it may have
      // been truncated by the SIP end clamp when first cached, so the fresh
      // copy must replace it — a cached tip is never trusted as complete.
      page("AAPL", [bar(92, t2), bar(93, t3)]),
    ]);

    expect((await exec.getBars("AAPL", "1Hour", 2)).map(b => b.close)).toEqual([90, 91]);
    const bars = await exec.getBars("AAPL", "1Hour", 2);

    expect(bars.map(b => b.close)).toEqual([92, 93]);
    expect(urls).toHaveLength(2);
    const inc = new URL(urls[1]).searchParams;
    expect(inc.get("start")).toBe(iso(t2)); // the cached tip, not a weeks-wide window
    expect(inc.get("feed")).toBe("sip");
    expect(Date.parse(inc.get("end") ?? "")).toBeLessThanOrEqual(Date.now() - 15 * 60_000);
    // Merged series: old bar kept, boundary bar replaced (91 gone), new bar
    // appended — ascending, no duplicate timestamps.
    expect(exec.getCachedCandles("AAPL", "1Hour").map(b => b.close)).toEqual([90, 92, 93]);
  });

  test("a deeper ask than the cache holds does a FULL refetch (the tail can't supply older history)", async () => {
    const exec = executor();
    const urls = captureFetch([
      page("AAPL", [bar(90, t2)]),
      page("AAPL", [bar(80, t1), bar(81, t2)]),
    ]);

    expect((await exec.getBars("AAPL", "1Hour", 1)).map(b => b.close)).toEqual([90]);
    expect((await exec.getBars("AAPL", "1Hour", 2)).map(b => b.close)).toEqual([80, 81]);

    expect(new URL(urls[1]).searchParams.get("start")).not.toBe(iso(t2)); // computed window, not the tip
    expect(exec.getCachedCandles("AAPL", "1Hour").map(b => b.close)).toEqual([80, 81]); // replaced wholesale
  });

  test("invalidateCandleCache forces the next fetch to be FULL — re-adjusted history is never tail-merged", async () => {
    const exec = executor();
    const urls = captureFetch([
      page("AAPL", [bar(90, t1), bar(91, t2)]),
      page("AAPL", [bar(70, t1), bar(71, t2)]), // post-split re-adjusted series
    ]);
    await exec.getBars("AAPL", "1Hour", 2);

    exec.invalidateCandleCache("AAPL");

    expect((await exec.getBars("AAPL", "1Hour", 2)).map(b => b.close)).toEqual([70, 71]);
    expect(new URL(urls[1]).searchParams.get("start")).not.toBe(iso(t2));
    expect(exec.getCachedCandles("AAPL", "1Hour").map(b => b.close)).toEqual([70, 71]); // no pre-event bar survives
  });

  test("invalidation WHILE the tail is in flight → the merge is abandoned and the call falls through to a full refetch", async () => {
    const exec = executor();
    const urls = captureFetch(
      [
        page("AAPL", [bar(90, t1), bar(91, t2)]),
        page("AAPL", [bar(92, t2), bar(93, t3)]), // tail of the PRE-event series
        page("AAPL", [bar(70, t1), bar(71, t2)]), // full re-adjusted refetch
      ],
      n => { if (n === 1) exec.invalidateCandleCache("AAPL"); }, // corporate action lands mid-tail-fetch
    );
    await exec.getBars("AAPL", "1Hour", 2);

    expect((await exec.getBars("AAPL", "1Hour", 2)).map(b => b.close)).toEqual([70, 71]);
    expect(urls).toHaveLength(3);
    // Without the in-flight guard the pre-event [90, 92, 93] merge would be
    // resurrected into the cache for up to the 6h backstop.
    expect(exec.getCachedCandles("AAPL", "1Hour").map(b => b.close)).toEqual([70, 71]);
  });

  test("past the full-refetch backstop the series is refetched in full even though the cache is deep enough", async () => {
    const exec = executor();
    const urls = captureFetch([
      page("AAPL", [bar(90, t1), bar(91, t2)]),
      page("AAPL", [bar(85, t1), bar(86, t2)]),
    ]);
    await exec.getBars("AAPL", "1Hour", 2);

    setSystemTime(new Date(Date.now() + STOCK_BARS_FULL_REFETCH_INTERVAL_MS + 60_000));
    try {
      expect((await exec.getBars("AAPL", "1Hour", 2)).map(b => b.close)).toEqual([85, 86]);
      expect(new URL(urls[1]).searchParams.get("start")).not.toBe(iso(t2));
    } finally {
      setSystemTime();
    }
  });

  test("a failed tail fetch falls back to a FULL fetch in the same call — never a silent gap", async () => {
    const exec = executor();
    const urls = captureFetch([
      page("AAPL", [bar(90, t1), bar(91, t2)]),
      rateLimited, // the incremental attempt dies…
      page("AAPL", [bar(95, t1), bar(96, t2)]), // …and the full fetch answers
    ]);
    await exec.getBars("AAPL", "1Hour", 2);

    expect((await exec.getBars("AAPL", "1Hour", 2)).map(b => b.close)).toEqual([95, 96]);
    expect(urls).toHaveLength(3);
    expect(new URL(urls[2]).searchParams.get("start")).not.toBe(iso(t2));
  });

  test("a WS stream bar appended to a REST series disqualifies it from the tail refresh (never mix IEX stream into SIP history)", async () => {
    const exec = executor() as any;
    const urls = captureFetch([
      page("AAPL", [bar(90, t1)]),
      page("AAPL", [bar(95, t1), bar(96, t2)]),
    ]);
    await exec.getBars("AAPL", "1Min", 1);
    exec.handleBarMsg({ S: "AAPL", o: 99, h: 101, l: 98, c: 100, v: 10, t: new Date().toISOString() }, "stock");

    expect((await exec.getBars("AAPL", "1Min", 2)).map((b: any) => b.close)).toEqual([95, 96]);
    expect(new URL(urls[1]).searchParams.get("start")).not.toBe(iso(t1)); // full window, not the tip
  });

  test("an empty tail (venue answered, nothing newer) keeps the cached series and still counts as a fresh read", async () => {
    const exec = executor();
    captureFetch([
      page("AAPL", [bar(90, t1), bar(91, t2)]),
      page("AAPL", []),
    ]);
    await exec.getBars("AAPL", "1Hour", 2);

    expect((await exec.getBars("AAPL", "1Hour", 2)).map(b => b.close)).toEqual([90, 91]);
  });
});

describe("AlpacaExecutor executable quote cache", () => {
  test("expires cached quotes and refreshes them through the snapshot fallback", async () => {
    const exec = executor() as any;
    exec.handleTradeMsg({ S: "AAPL", p: 100, t: new Date().toISOString() }, "stock");
    expect(exec.getCachedPrice("AAPL")).toBe(100);

    const quote = exec.latestPrices.get("AAPL");
    expect(quote.timestamp).toBeGreaterThan(0);
    quote.timestamp = 0;

    let snapshotCalls = 0;
    exec.client = {
      getSnapshot: async () => {
        snapshotCalls++;
        return { LatestTrade: { Price: 105, Timestamp: new Date().toISOString() } };
      },
    };

    expect(exec.getCachedPrice("AAPL")).toBe(0);
    expect(await exec.getLatestPrice("AAPL")).toBe(105);
    expect(snapshotCalls).toBe(1);
    expect(exec.getCachedPrice("AAPL")).toBe(105);
  });

  test("rejects a stale prior-session bar even though it just arrived over the WS", () => {
    const exec = executor() as any;
    const staleTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h old
    exec.handleBarMsg({ S: "AAPL", o: 99, h: 101, l: 98, c: 100, v: 10, t: staleTs }, "stock");

    // Validated against the BROKER's event timestamp, not receipt time — a
    // stale bar must never become an "executable" quote just because we
    // happened to receive it a moment ago.
    expect(exec.getCachedPrice("AAPL")).toBe(0);
    expect(exec.latestPrices.has("AAPL")).toBe(false);
  });

  test("rejects a stale LatestTrade from the REST snapshot fallback", async () => {
    const exec = executor() as any;
    const staleTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    exec.client = {
      getSnapshot: async () => ({ LatestTrade: { Price: 105, Timestamp: staleTs } }),
    };

    expect(await exec.getLatestPrice("AAPL")).toBe(0);
    expect(exec.getCachedPrice("AAPL")).toBe(0);
  });

  test("never falls back to DailyBar.ClosePrice as an executable quote", async () => {
    const exec = executor() as any;
    exec.client = {
      // No LatestTrade at all — only a same-day DailyBar aggregate. Before
      // this fix, `snap.LatestTrade?.Price || snap.DailyBar?.ClosePrice`
      // would happily execute against a prior-session aggregate close.
      getSnapshot: async () => ({
        DailyBar: { ClosePrice: 999, Timestamp: new Date().toISOString() },
      }),
    };

    expect(await exec.getLatestPrice("AAPL")).toBe(0);
    expect(exec.getCachedPrice("AAPL")).toBe(0);
  });
});

// P1 2026-07-27: on the IEX feed, liquid symbols (measured: UNH) go minutes
// without printing a trade, so the <30s EXECUTABLE standard starved the SL
// loop of prices. getRiskPrice is the RISK-monitoring tier: executable price
// first, else the LAST TRADE inside a bounded 5-min window, still
// fail-closed, and NEVER cached as executable. TRADE ONLY — the quote
// midpoint was tried and removed the same day: IEX quotes on sparse symbols
// are wide non-NBBO fiction (see the regression test below).
// 2026-09-28: meanrev skipped ABBV (and CAT 09-16, MA 08-11) with "no price":
// the <30s executable standard on the IEX tape. getSizingPrice sizes a
// MARKET order's share count with getRiskPrice's trade tier — the execution
// path itself (getLatestPrice/getCachedPrice) must NOT loosen.
describe("AlpacaExecutor sizing price (getSizingPrice)", () => {
  test("2-min-old last trade → sizing price is the trade; executable path stays 0 and nothing is cached", async () => {
    const exec = executor() as any;
    exec.client = { getSnapshot: async () => ({ LatestTrade: { Price: 264.34, Timestamp: new Date(Date.now() - 120_000).toISOString() } }) };
    expect(await exec.getSizingPrice("ABBV")).toBe(264.34);
    expect(await exec.getLatestPrice("ABBV")).toBe(0);
    expect(exec.getCachedPrice("ABBV")).toBe(0);
  });

  test("a trade older than the 5-min window, or a future-stamped one, is refused", async () => {
    const exec = executor() as any;
    exec.client = { getSnapshot: async () => ({ LatestTrade: { Price: 264.34, Timestamp: new Date(Date.now() - 6 * 60_000).toISOString() } }) };
    expect(await exec.getSizingPrice("ABBV")).toBe(0);
    exec.client = { getSnapshot: async () => ({ LatestTrade: { Price: 264.34, Timestamp: new Date(Date.now() + 60_000).toISOString() } }) };
    expect(await exec.getSizingPrice("ABBV")).toBe(0);
  });

  test("a fresh executable price wins over the trade tier", async () => {
    const exec = executor() as any;
    exec.handleTradeMsg({ S: "ABBV", p: 265, t: new Date().toISOString() }, "stock");
    exec.client = { getSnapshot: async () => { throw new Error("must not be called"); } };
    expect(await exec.getSizingPrice("ABBV")).toBe(265);
  });
});

describe("AlpacaExecutor risk price (getRiskPrice)", () => {
  function snapClient(snap: any) {
    return { getSnapshot: async () => snap };
  }

  test("stale-for-execution trade (>30s, <5min) → risk price is the trade; the EXECUTION path stays 0", async () => {
    const exec = executor() as any;
    exec.client = snapClient({
      LatestTrade: { Price: 105, Timestamp: new Date(Date.now() - 120_000).toISOString() }, // 2min: dead for execution, alive for risk
    });

    expect(await exec.getRiskPrice("UNH")).toBe(105);
    // Reverting this fix by relaxing EXECUTABLE_QUOTE_TTL_MS instead would
    // make this assertion fail: the execution path must NOT loosen.
    expect(await exec.getLatestPrice("UNH")).toBe(0);
  });

  test("REGRESSION (real IEX data 2026-07-27): fresher wide quote must NEVER beat a valid trade", async () => {
    const exec = executor() as any;
    // Live UNH snapshot: trade 418.35 @46s; quote bid 392.64 / ask 420.00
    // @3s — a $27.36 (6.5%) spread, non-NBBO garbage that passes any
    // bid>0 && ask>=bid validation. The removed "freshest candidate wins"
    // rule returned the midpoint 406.32 and turned a real −0.83% position
    // into a fabricated −3.68%, nearly firing the −4% stop.
    exec.client = snapClient({
      LatestTrade: { Price: 418.35, Timestamp: new Date(Date.now() - 46_000).toISOString() },
      LatestQuote: { BidPrice: 392.64, AskPrice: 420.0, Timestamp: new Date(Date.now() - 3_000).toISOString() },
    });
    expect(await exec.getRiskPrice("UNH")).toBe(418.35); // never 406.32
  });

  test("trade outside the risk window → 0 (fail-closed intact, no prior-session price invented)", async () => {
    const exec = executor() as any;
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    exec.client = snapClient({
      LatestTrade: { Price: 105, Timestamp: tenMinAgo },
      LatestQuote: { BidPrice: 99, AskPrice: 101, Timestamp: tenMinAgo },
      DailyBar: { ClosePrice: 999, Timestamp: new Date().toISOString() }, // must never be used
    });
    expect(await exec.getRiskPrice("UNH")).toBe(0);
  });

  // Reconverted from the old "garbage quote validation" test: with the quote
  // path removed, the invariant is stronger — NO quote, however fresh or
  // well-formed, ever becomes a risk price when the trade is out of window.
  test("a fresh quote alone (trade out of window) never becomes a risk price", async () => {
    const exec = executor() as any;
    exec.client = snapClient({
      LatestTrade: { Price: 105, Timestamp: new Date(Date.now() - 10 * 60_000).toISOString() },
      LatestQuote: { BidPrice: 99, AskPrice: 101, Timestamp: new Date(Date.now() - 5_000).toISOString() }, // fresh AND well-formed
    });
    expect(await exec.getRiskPrice("UNH")).toBe(0);
  });

  test("a risk-tier price does NOT contaminate the executable price cache", async () => {
    const exec = executor() as any;
    exec.client = snapClient({
      LatestTrade: { Price: 105, Timestamp: new Date(Date.now() - 120_000).toISOString() },
    });

    expect(await exec.getRiskPrice("UNH")).toBe(105);
    expect(exec.getCachedPrice("UNH")).toBe(0);
    expect(await exec.getLatestPrice("UNH")).toBe(0);
  });
});

describe("AlpacaExecutor WS protocol errors", () => {
  test("surfaces a stock WS error frame instead of silently dropping it", () => {
    const exec = executor() as any;
    let captured: any = null;
    exec.handleWsErrorFrame = ((market: string, msg: any) => { captured = { market, msg }; }) as any;
    exec.handleStockWsMsg({ T: "error", code: 406, msg: "subscription limit exceeded" });
    expect(captured).toEqual({ market: "stock", msg: { T: "error", code: 406, msg: "subscription limit exceeded" } });
  });

  test("surfaces a crypto WS error frame instead of silently dropping it", () => {
    const exec = executor() as any;
    let captured: any = null;
    exec.handleWsErrorFrame = ((market: string, msg: any) => { captured = { market, msg }; }) as any;
    exec.handleCryptoWsMsg({ T: "error", code: 400, msg: "invalid syntax" });
    expect(captured).toEqual({ market: "crypto", msg: { T: "error", code: 400, msg: "invalid syntax" } });
  });

  test("406 (contended slot) sets the reconnect delay to the long contended value, not 2s", () => {
    const exec = executor() as any;
    exec.handleStockWsMsg({ T: "error", code: 406, msg: "connection limit exceeded" });
    expect(exec.wsReconnectDelay.stock).toBe(ALPACA_WS_CONTENDED_DELAY_MS);
  });

  test("a contended delay stays pinned after a later disconnect", () => {
    const exec = executor() as any;
    class StubWebSocket {
      static OPEN = 1;
      readyState = StubWebSocket.OPEN;
      onclose: (() => void) | null = null;
      constructor(_url: string) {}
    }
    globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
    exec.wsWanted = true;
    exec.stockSymbols = ["AAPL"];
    exec.connectStockWs();
    exec.handleStockWsMsg({ T: "error", code: 406, msg: "connection limit exceeded" });

    const scheduled: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((_callback: TimerHandler, delay?: number) => {
      scheduled.push(delay as number);
      return 0 as any;
    }) as typeof setTimeout;
    try {
      exec.stockWs.onclose();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(scheduled).toEqual([ALPACA_WS_CONTENDED_DELAY_MS]);
    expect(exec.wsReconnectDelay.stock).toBe(ALPACA_WS_CONTENDED_DELAY_MS);
  });

  test("a non-406 protocol error does not touch the contended delay", () => {
    const exec = executor() as any;
    exec.handleStockWsMsg({ T: "error", code: 400, msg: "auth failed" });
    expect(exec.wsReconnectDelay.stock).toBe(2000);
  });

  test("onopen alone does not reset the reconnect delay, but a subscription ack does", () => {
    const exec = executor() as any;
    class StubWebSocket {
      static OPEN = 1;
      readyState = StubWebSocket.OPEN;
      onopen: (() => void) | null = null;
      send = () => {};
      constructor(_url: string) {}
    }
    globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
    exec.wsWanted = true;
    exec.stockSymbols = ["AAPL"];
    exec.wsReconnectDelay.stock = ALPACA_WS_CONTENDED_DELAY_MS;
    exec.connectStockWs();

    // Drive the actual handler: the handshake alone must not reset the delay.
    exec.stockWs.onopen();
    expect(exec.wsReconnectDelay.stock).toBe(ALPACA_WS_CONTENDED_DELAY_MS);

    // A real subscription ack proves the socket is usable — only then reset.
    exec.handleStockWsMsg({ T: "subscription", bars: ["AAPL"] });
    expect(exec.wsReconnectDelay.stock).toBe(2000);
  });
});

describe("AlpacaExecutor SDK timeouts", () => {
  afterEach(() => {
    mock.module("../utils/timeout", () => ({ fetchT: realFetchT, withTimeout: realWithTimeout }));
  });

  const fastWithTimeout = <T>(p: Promise<T>, _timeoutMs: number, label: string) =>
    Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), 5)),
    ]);

  function armFastTimeout() {
    mock.module("../utils/timeout", () => ({ fetchT: realFetchT, withTimeout: fastWithTimeout }));
  }

  test("placeOrder timeout on a hanging createOrder is UNKNOWN (in flight), never a silent rejection", async () => {
    // Outcome taxonomy (2026-08-03): the SDK timeout fires AFTER the request
    // may have been transmitted — the old `null` here is exactly the
    // timeout-treated-as-rejection bug class. The order resolves by
    // client_order_id query; with the query also down, the result is an
    // explicit UNKNOWN, never null.
    armFastTimeout();
    const exec = executor() as any;
    exec.resolveRetryDelayMs = 1;
    exec.client = { createOrder: () => new Promise(() => {}) };
    const start = Date.now();
    const result = await exec.placeOrder({ symbol: "AAPL", side: "buy", market: "stock", price: 100 } as any, 1);
    expect(result?.outcome).toBe("unknown");
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("pollOrderUntilFilled times out a hanging getOrder", async () => {
    armFastTimeout();
    const exec = executor() as any;
    exec.client = {
      getOrder: () => new Promise(() => {}),
      cancelOrder: mock().mockResolvedValue({}),
    };
    const start = Date.now();
    const result = await exec.pollOrderUntilFilled("order-123", 10, 5, 0);
    // The final fetch also hung: the order was never CONFIRMED terminal, so
    // this is "timeout_unresolved" (unknown), not "timeout_cancelled"
    // (proven) — see cancelAndFetchFinal.
    expect(result.status).toBe("timeout_unresolved");
    expect(Date.now() - start).toBeLessThan(100);
  });

  test("closePosition times out a hanging closePosition SDK call", async () => {
    armFastTimeout();
    const exec = executor() as any;
    exec.client = { closePosition: () => new Promise(() => {}) };
    const start = Date.now();
    const result = await exec.closePosition("AAPL");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("timeout");
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe("AlpacaExecutor partial fills", () => {
  test("placeOrder reports partial status with actual filled qty", async () => {
    const exec = executor() as any;
    exec.client = {
      createOrder: mock().mockResolvedValue({
        id: "broker-123", status: "partially_filled", filled_qty: "3", filled_avg_price: "101", filled_at: new Date().toISOString(),
      }),
    };
    const order = await exec.placeOrder({ symbol: "AAPL", side: "buy", market: "stock", price: 100 } as any, 10);
    expect(order).not.toBeNull();
    expect(order!.status).toBe("partial");
    expect(order!.filledQty).toBe(3);
    expect(order!.filledPrice).toBe(101);
  });

  test("pollOrderUntilFilled cancels remainder and returns real filled qty on timeout", async () => {
    const exec = executor() as any;
    exec.client = {
      getOrder: mock()
        .mockResolvedValueOnce({ status: "partially_filled", filled_qty: "3", filled_avg_price: "101" })
        .mockResolvedValueOnce({ status: "partially_filled", filled_qty: "3", filled_avg_price: "101" })
        .mockResolvedValueOnce({ status: "partially_filled", filled_qty: "3", filled_avg_price: "101" })
        .mockResolvedValueOnce({ status: "canceled", filled_qty: "3", filled_avg_price: "101" }),
      cancelOrder: mock().mockResolvedValue({}),
    };
    const result = await exec.pollOrderUntilFilled("order-123", 12, 5, 0);
    expect(result).toEqual({ status: "filled", filledPrice: 101, filledQty: 3 });
    expect(exec.client.cancelOrder).toHaveBeenCalledWith("order-123");
  });
});

describe("AlpacaExecutor close retries", () => {
  test("does not retry after a poll timeout", async () => {
    const exec = executor() as any;
    let closeCalls = 0;
    exec.client = {
      closePosition: async () => {
        closeCalls++;
        return { id: "order-1" };
      },
    };
    exec.pollOrderUntilFilled = async () => ({ status: "timeout_cancelled" });

    const result = await exec.closePosition("BTC/USD");
    expect(result.success).toBe(false);
    expect(closeCalls).toBe(1);
  });

  test("retries an HTTP 422 with the alternate symbol format", async () => {
    const exec = executor() as any;
    let closeCalls = 0;
    exec.client = {
      closePosition: async () => {
        closeCalls++;
        throw Object.assign(new Error("unprocessable"), { response: { status: 422 } });
      },
    };

    const result = await exec.closePosition("BTC/USD");
    expect(result.success).toBe(false);
    expect(closeCalls).toBe(2);
  });
});

// ── qty-bounded close (co-tenancy P0, 2026-07-27) ──────────────────────────
// The Alpaca account is SHARED with the prod deployment: DELETE /v2/positions
// /{symbol} without qty liquidates the AGGREGATE (broker 22 = ours 11 + prod's
// 11). Reverting closePosition to the qty-less SDK call must fail these.
describe("AlpacaExecutor qty-bounded close (shared-account co-tenancy)", () => {
  test("broker 22 / ours 11 → the close request carries qty=11, never a whole-position DELETE", async () => {
    const exec = executor() as any;
    const sdkClose = mock(async () => ({ id: "sdk-close" }));
    exec.client = { getPosition: async () => ({ qty: "22" }), closePosition: sdkClose };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 400, filledQty: 11, filledAt: Date.now() });
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: "close-order-1" }) } as Response;
    }) as unknown as typeof fetch;

    const result = await exec.closePosition("UNH", undefined, 11);

    expect(result.success).toBe(true);
    expect(result.filledPrice).toBe(400);
    expect(sdkClose).not.toHaveBeenCalled(); // whole-position close = the P0
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/v2/positions/UNH?qty=11");
  });

  test("broker 5 / ours 11 → closes the 5 that exist (whole position IS ours), no over-ask", async () => {
    const exec = executor() as any;
    const sdkClose = mock(async () => ({ id: "sdk-close" }));
    const getPosition = mock(async () => ({ qty: "5" }));
    exec.client = { getPosition, closePosition: sdkClose };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 400, filledQty: 5, filledAt: Date.now() });
    globalThis.fetch = (async () => { throw new Error("unexpected fetch — must use the plain SDK close"); }) as unknown as typeof fetch;

    const result = await exec.closePosition("UNH", undefined, 11);

    expect(result.success).toBe(true);
    expect(result.filledQty).toBe(5);
    expect(sdkClose).toHaveBeenCalledTimes(1); // qty(11) covers broker(5) → plain close of what exists
    expect(getPosition).toHaveBeenCalledTimes(1); // the bounding read MUST happen (fails on revert)
  });

  test("broker flat (qty 0) → http_404, no close order is ever submitted", async () => {
    const exec = executor() as any;
    const sdkClose = mock(async () => ({ id: "sdk-close" }));
    exec.client = { getPosition: async () => ({ qty: "0" }), closePosition: sdkClose };
    globalThis.fetch = (async () => { throw new Error("unexpected fetch"); }) as unknown as typeof fetch;

    const result = await exec.closePosition("UNH", undefined, 11);

    expect(result.success).toBe(false);
    expect(result.reason).toBe("http_404"); // BROKER_GONE_404 flow preserved
    expect(sdkClose).not.toHaveBeenCalled();
  });

  test("getPosition throws 404 → http_404 (BROKER_GONE_404 reconcile flow preserved)", async () => {
    const exec = executor() as any;
    const sdkClose = mock(async () => ({ id: "sdk-close" }));
    exec.client = {
      getPosition: async () => { throw Object.assign(new Error("position does not exist"), { response: { status: 404 } }); },
      closePosition: sdkClose,
    };

    const result = await exec.closePosition("UNH", undefined, 11);

    expect(result.success).toBe(false);
    expect(result.reason).toBe("http_404");
    expect(sdkClose).not.toHaveBeenCalled();
  });

  test("non-positive qty → refused without touching the broker", async () => {
    const exec = executor() as any;
    const getPosition = mock(async () => ({ qty: "22" }));
    const sdkClose = mock(async () => ({ id: "sdk-close" }));
    exec.client = { getPosition, closePosition: sdkClose };

    const result = await exec.closePosition("UNH", undefined, 0);

    expect(result.success).toBe(false);
    expect(result.reason).toContain("non-positive close qty");
    expect(getPosition).not.toHaveBeenCalled();
    expect(sdkClose).not.toHaveBeenCalled();
  });

  test("qty-less call keeps whole-position semantics (emergency scripts only)", async () => {
    const exec = executor() as any;
    const getPosition = mock(async () => ({ qty: "22" }));
    exec.client = { getPosition, closePosition: async () => ({ id: "sdk-close" }) };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 400, filledQty: 22, filledAt: Date.now() });

    const result = await exec.closePosition("UNH");

    expect(result.success).toBe(true);
    expect(getPosition).not.toHaveBeenCalled(); // no bounding read on the explicit whole-book path
  });
});

describe("AlpacaExecutor WS trade events and rotation", () => {
  test("trade message (T=t) updates latestPrices; bar close does not", () => {
    const exec = executor() as any;
    const now = Date.now();
    exec.handleTradeMsg({ S: "AAPL", p: 150, t: new Date(now).toISOString() }, "stock");
    expect(exec.getCachedPrice("AAPL")).toBe(150);

    exec.handleBarMsg({ S: "AAPL", o: 140, h: 160, l: 130, c: 155, v: 100, t: new Date(now).toISOString() }, "stock");
    expect(exec.getCachedPrice("AAPL")).toBe(150);
    expect(exec.getCachedCandles("AAPL", "1Min")).toHaveLength(1);
  });

  test("rotation unsubscribes removed symbols before subscribing new ones", async () => {
    const exec = executor() as any;
    const sent: any[] = [];
    exec.stockWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => sent.push(JSON.parse(data)),
    };
    exec.stockWsState = "connected";
    exec.stockSymbols = ["AAPL", "MSFT"];
    exec.stockSubscribed = ["AAPL", "TSLA"];

    exec.sendStockSubscriptions();

    expect(sent).toEqual([
      { action: "unsubscribe", bars: ["TSLA"] },
      { action: "subscribe", bars: ["AAPL", "MSFT"] },
    ]);
    expect(exec.stockSubscribed).toEqual(["AAPL", "MSFT"]);
  });

  test("auth success subscribes current symbols and records subscription state", async () => {
    const exec = executor() as any;
    const sent: any[] = [];
    exec.stockWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => sent.push(JSON.parse(data)),
    };
    exec.stockSymbols = ["AAPL", "MSFT"];
    exec.stockSubscribed = [];

    exec.handleStockWsMsg({ T: "success", msg: "authenticated" });

    expect(sent).toEqual([{ action: "subscribe", bars: ["AAPL", "MSFT"] }]);
    expect(exec.stockSubscribed).toEqual(["AAPL", "MSFT"]);
  });
});

describe("AlpacaExecutor executable quote", () => {
  test("stock: ask for buys, bid for sells", async () => {
    const exec = executor() as any;
    exec.client = {
      getSnapshot: async () => ({
        LatestQuote: { AskPrice: 101, BidPrice: 99, Timestamp: new Date().toISOString() },
      }),
    };
    expect(await exec.getExecutableQuote("AAPL", "buy")).toEqual({ price: 101, timestamp: expect.any(Number), bid: 99, ask: 101 });
    expect(await exec.getExecutableQuote("AAPL", "sell")).toEqual({ price: 99, timestamp: expect.any(Number), bid: 99, ask: 101 });
  });

  test("crypto: ask for buys, bid for sells", async () => {
    const exec = executor();
    fetchQueue(quote("BTC/USD", 50100, 50095, new Date().toISOString()));
    expect(await exec.getExecutableQuote("BTC/USD", "buy")).toEqual({ price: 50100, timestamp: expect.any(Number), bid: 50095, ask: 50100 });
    fetchQueue(quote("BTC/USD", 50100, 50095, new Date().toISOString()));
    expect(await exec.getExecutableQuote("BTC/USD", "sell")).toEqual({ price: 50095, timestamp: expect.any(Number), bid: 50095, ask: 50100 });
  });

  test("rejects stale broker quote and returns null", async () => {
    const exec = executor() as any;
    const stale = new Date(Date.now() - 60_000).toISOString();
    exec.client = {
      getSnapshot: async () => ({
        LatestQuote: { AskPrice: 101, BidPrice: 99, Timestamp: stale },
      }),
    };
    expect(await exec.getExecutableQuote("AAPL", "buy")).toBeNull();
  });

  test("telemetry failure is fail-open and logs once", async () => {
    const exec = executor() as any;
    exec.client = { getSnapshot: async () => { throw new Error("snapshot down"); } };
    expect(await exec.getExecutableQuote("AAPL", "buy")).toBeNull();
  });
});

describe("AlpacaExecutor getPositions validation", () => {
  test("coerces missing display-derived fields without aborting the list", async () => {
    const exec = executor() as any;
    exec.client = {
      getPositions: async () => [
        { symbol: "AAPL", asset_class: "us_equity", qty: "5", avg_entry_price: "100", current_price: null, unrealized_pl: "", unrealized_plpc: null },
      ],
    };

    await expect(exec.getPositions()).resolves.toEqual([expect.objectContaining({
      symbol: "AAPL",
      quantity: 5,
      avgEntryPrice: 100,
      currentPrice: 0,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
    })]);
  });

  test("crypto symbol normalization slices the SUFFIX: USDCUSD → USDC/USD, never /USDCUSD (OPEN.md P2)", async () => {
    const exec = executor() as any;
    exec.client = {
      getPositions: async () => [
        { symbol: "DOGEUSD", asset_class: "crypto", qty: "10", avg_entry_price: "0.1", current_price: "0.11", unrealized_pl: "0.1", unrealized_plpc: "0.1" },
        { symbol: "USDCUSD", asset_class: "crypto", qty: "100", avg_entry_price: "1", current_price: "1", unrealized_pl: "0", unrealized_plpc: "0" },
      ],
    };
    const symbols = (await exec.getPositions()).map((p: any) => p.symbol);
    expect(symbols).toEqual(["DOGE/USD", "USDC/USD"]);
  });

  test("throws on an unparseable qty instead of fabricating side 'sell'", async () => {
    const exec = executor() as any;
    exec.client = {
      getPositions: async () => [
        { symbol: "AAPL", asset_class: "us_equity", qty: "NaN", avg_entry_price: "100", current_price: "101", unrealized_pl: "1", unrealized_plpc: "0.01" },
        { symbol: "MSFT", asset_class: "us_equity", qty: "5", avg_entry_price: "200", current_price: "205", unrealized_pl: "25", unrealized_plpc: "0.025" },
      ],
    };
    await expect(exec.getPositions()).rejects.toThrow("AAPL");
  });
});

// ── Broker-native GTC stop-loss (OPEN.md P1: stocks naked outside market
// hours) — defense in depth mirroring Binance's placeStopMarketClose. The
// 15s SL loop remains primary; these orders cap the overnight/weekend gap.
describe("AlpacaExecutor broker-native GTC stop", () => {
  test("placeStopLossOrder submits type=stop, GTC, floored qty, protective 2dp trigger and the deterministic uc8 stop id", async () => {
    const exec = executor() as any;
    const calls: any[] = [];
    exec.client = { createOrder: async (p: any) => { calls.push(p); return { id: "stop-broker-1" }; } };

    const res = await exec.placeStopLossOrder({
      symbol: "AAPL", positionSide: "buy", quantity: 76.9, stopPrice: 96.123,
      accountId: "momentum_stocks", tradeId: "trade-1",
    });

    expect(res.ok).toBe(true);
    expect(res.orderId).toBe("stop-broker-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      symbol: "AAPL",
      qty: 76,                    // floored: Alpaca rejects fractional stops
      side: "sell",               // the stop CLOSES a long
      type: "stop",
      stop_price: 96.13,          // ceil to cent — rounding may only TIGHTEN a long's stop
      time_in_force: "gtc",       // DAY would die at the close — the gap is the point
      client_order_id: stopLossClientOrderId("momentum_stocks", "trade-1"),
    });
    expect(calls[0].client_order_id.startsWith("uc8-momentum_stocks-sl")).toBe(true);
  });

  test("short protection rounds the trigger DOWN (tighter for a buy-stop) and flips the side", async () => {
    const exec = executor() as any;
    const calls: any[] = [];
    exec.client = { createOrder: async (p: any) => { calls.push(p); return { id: "s" }; } };
    await exec.placeStopLossOrder({ symbol: "XLE", positionSide: "sell", quantity: 10, stopPrice: 104.129, accountId: "a", tradeId: "t" });
    expect(calls[0].side).toBe("buy");
    expect(calls[0].stop_price).toBe(104.12);
  });

  test("duplicate client_order_id with the prior stop still WORKING → success without re-creating (idempotent retry)", async () => {
    const exec = executor() as any;
    let creates = 0;
    exec.client = {
      createOrder: async () => {
        creates++;
        throw Object.assign(new Error("422"), { response: { status: 422, data: { message: "client_order_id must be unique" } } });
      },
      getOrderByClientId: async () => ({ id: "existing-stop", status: "new" }),
    };
    const res = await exec.placeStopLossOrder({ symbol: "AAPL", positionSide: "buy", quantity: 5, stopPrice: 96, accountId: "momentum_stocks", tradeId: "trade-1" });
    expect(res).toEqual({ ok: true, orderId: "existing-stop", clientOrderId: stopLossClientOrderId("momentum_stocks", "trade-1") });
    expect(creates).toBe(1); // never re-created
  });

  test("duplicate client_order_id but the prior stop is TERMINAL (burned id) → exactly one salted re-place, still uc8-attributed", async () => {
    const exec = executor() as any;
    const ids: string[] = [];
    let first = true;
    exec.client = {
      createOrder: async (p: any) => {
        ids.push(p.client_order_id);
        if (first) {
          first = false;
          throw Object.assign(new Error("422"), { response: { status: 422, data: { message: "client_order_id must be unique" } } });
        }
        return { id: "salted-stop" };
      },
      getOrderByClientId: async () => ({ id: "old-stop", status: "canceled" }),
    };
    const res = await exec.placeStopLossOrder({ symbol: "AAPL", positionSide: "buy", quantity: 5, stopPrice: 96, accountId: "momentum_stocks", tradeId: "trade-1" });
    expect(res.ok).toBe(true);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[1].startsWith("uc8-momentum_stocks-sl")).toBe(true);
  });

  test("non-positive qty and invalid stop price are refused without touching the broker", async () => {
    const exec = executor() as any;
    const createOrder = mock(async () => ({ id: "x" }));
    exec.client = { createOrder };
    expect((await exec.placeStopLossOrder({ symbol: "AAPL", positionSide: "buy", quantity: 0.4, stopPrice: 96, accountId: "a", tradeId: "t" })).ok).toBe(false);
    expect((await exec.placeStopLossOrder({ symbol: "AAPL", positionSide: "buy", quantity: 5, stopPrice: 0, accountId: "a", tradeId: "t" })).ok).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
  });

  test("getOpenStopOrders returns only OUR stop orders — uc8- prefix AND type stop*; foreign/entry orders are invisible", async () => {
    const exec = executor() as any;
    exec.client = {
      getOrders: async () => [
        { id: "o1", client_order_id: "uc8-momentum_stocks-slabc", symbol: "AAPL", side: "sell", type: "stop", qty: "76", stop_price: "96.00", status: "new" },
        { id: "o2", client_order_id: "manually-placed-by-a-human", symbol: "AAPL", side: "sell", type: "stop", qty: "10", stop_price: "90.00", status: "new" }, // foreign stop
        { id: "o3", client_order_id: "uc8-momentum_stocks-entry1", symbol: "AAPL", side: "buy", type: "market", qty: "76", status: "new" }, // our ENTRY, not a stop
      ],
    };
    const stops = await exec.getOpenStopOrders("AAPL");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toEqual({ id: "o1", clientOrderId: "uc8-momentum_stocks-slabc", symbol: "AAPL", side: "sell", qty: 76, stopPrice: 96, status: "new" });
  });

  test("getOpenStopOrders THROWS on a malformed read — unknown is never 'no stops'", async () => {
    const exec = executor() as any;
    exec.client = { getOrders: async () => ({ msg: "unexpected shape" }) };
    await expect(exec.getOpenStopOrders()).rejects.toThrow("malformed");
  });

  test("closePosition cancels OUR stop by EXACT id before closing — the foreign stop survives and no cancel-all is ever issued", async () => {
    const exec = executor() as any;
    const cancelOrder = mock(async () => ({}));
    const cancelAllOrders = mock(async () => ({}));
    exec.client = {
      getOrders: async () => [
        { id: "our-stop-id", client_order_id: "uc8-momentum_stocks-slabc", symbol: "UNH", side: "sell", type: "stop", qty: "11", stop_price: "384.00", status: "new" },
        { id: "foreign-stop-id", client_order_id: "manually-placed-by-a-human", symbol: "UNH", side: "sell", type: "stop", qty: "5", stop_price: "300.00", status: "new" },
      ],
      cancelOrder,
      cancelAllOrders, // must NEVER be called (blind-sweep incident class, AUDITS)
      getPosition: async () => ({ qty: "11" }),
      closePosition: async () => ({ id: "close-1" }),
    };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 400, filledQty: 11, filledAt: Date.now() });

    const result = await exec.closePosition("UNH", "buy", 11);

    expect(result.success).toBe(true);
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith("our-stop-id"); // exact id, ours only
    expect(cancelAllOrders).not.toHaveBeenCalled();
  });

  // ── Under-lock re-validation (OPEN.md P1, 2026-08-11 ABBV orphan) ──────
  // Every caller decides "this row needs a stop" OUTSIDE the symbol lock; a
  // concurrent closePosition holds that lock while it cancels stops and
  // sells. The decision must therefore be re-validated UNDER the lock,
  // immediately before transmit — otherwise the queued placement installs a
  // sell stop with no position behind it (naked short if it fires, plus a
  // wash-trade 403 veto on every future buy of the symbol).

  test("RACE: row closes while placeStopLossOrder WAITS on the symbol lock → stillNeeded is re-read under the lock and nothing is transmitted", async () => {
    const exec = executor() as any;
    const createOrder = mock(async () => ({ id: "would-be-orphan" }));
    exec.client = { createOrder, getPosition: async () => ({ qty: "20" }) };
    let rowOpen = true;

    // The close path holds the per-(venue,symbol) lock first…
    const release = await symbolLocks.acquire("alpaca", "ABBV", { label: "closePosition:test" });
    let placing: Promise<any>;
    try {
      // …the ensure pass, having ALREADY decided from a pre-close snapshot,
      // queues behind it…
      placing = exec.placeStopLossOrder({
        symbol: "ABBV", positionSide: "buy", quantity: 20, stopPrice: 230.11,
        accountId: "meanrev_stocks", tradeId: "t-abbv",
        stillNeeded: () => rowOpen,
      });
      // …and while it waits, the close cancels our stops, sells, closes the row.
      rowOpen = false;
    } finally {
      release!();
    }

    const res = await placing;
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
    // Revert-falsifier: drop the stillNeeded consultation in
    // placeStopLossOrderUnderLock → the orphan stop IS created here.
    expect(createOrder).not.toHaveBeenCalled();
  });

  test("broker DEFINITIVELY flat under the lock (getPosition 404) → stop not placed even without a stillNeeded callback", async () => {
    const exec = executor() as any;
    const createOrder = mock(async () => ({ id: "would-be-orphan" }));
    exec.client = {
      createOrder,
      getPosition: async () => { throw Object.assign(new Error("position does not exist"), { response: { status: 404 } }); },
    };
    const res = await exec.placeStopLossOrder({ symbol: "MRK", positionSide: "buy", quantity: 10, stopPrice: 96, accountId: "meanrev_stocks", tradeId: "t-mrk" });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
    expect(createOrder).not.toHaveBeenCalled();
  });

  test("broker reports qty 0 (flat, no 404 shape) → same abort: a resting stop with no position is the orphan class", async () => {
    const exec = executor() as any;
    const createOrder = mock(async () => ({ id: "would-be-orphan" }));
    exec.client = { createOrder, getPosition: async () => ({ qty: "0" }) };
    const res = await exec.placeStopLossOrder({ symbol: "PEP", positionSide: "buy", quantity: 10, stopPrice: 96, accountId: "meanrev_stocks", tradeId: "t-pep" });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
    expect(createOrder).not.toHaveBeenCalled();
  });

  test("an UNVERIFIABLE position read (transport error, not 404) still places — unknown ≠ flat, a live position must not lose its stop to a flaky read", async () => {
    const exec = executor() as any;
    const calls: any[] = [];
    exec.client = {
      createOrder: async (p: any) => { calls.push(p); return { id: "stop-ok" }; },
      getPosition: async () => { throw new Error("ETIMEDOUT"); },
    };
    const res = await exec.placeStopLossOrder({ symbol: "KO", positionSide: "buy", quantity: 10, stopPrice: 96, accountId: "meanrev_stocks", tradeId: "t-ko" });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("healthy path: broker still holds the position and stillNeeded is true → the stop is placed exactly as before", async () => {
    const exec = executor() as any;
    const calls: any[] = [];
    exec.client = {
      createOrder: async (p: any) => { calls.push(p); return { id: "stop-ok" }; },
      getPosition: async () => ({ qty: "10" }),
    };
    const res = await exec.placeStopLossOrder({ symbol: "JNJ", positionSide: "buy", quantity: 10, stopPrice: 96, accountId: "meanrev_stocks", tradeId: "t-jnj", stillNeeded: () => true });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("stop");
  });

  test("stop enumeration failure never blocks the close (fail-open cleanup, close path intact)", async () => {
    const exec = executor() as any;
    exec.client = {
      getOrders: async () => { throw new Error("orders endpoint down"); },
      getPosition: async () => ({ qty: "11" }),
      closePosition: async () => ({ id: "close-1" }),
    };
    exec.pollOrderUntilFilled = async () => ({ status: "filled", filledPrice: 400, filledQty: 11, filledAt: Date.now() });
    const result = await exec.closePosition("UNH", "buy", 11);
    expect(result.success).toBe(true);
  });
});

describe("AlpacaExecutor client_order_id — attribution + idempotency", () => {
  function createOrderCapture() {
    const calls: any[] = [];
    return {
      calls,
      createOrder: mock().mockImplementation(async (params: any) => {
        calls.push(params);
        return { id: `broker-${calls.length}`, status: "filled", filled_qty: "1", filled_avg_price: "100" };
      }),
    };
  }

  test("every order carries a client_order_id starting with the uc8-<sleeve>- attribution prefix", async () => {
    const exec = executor() as any;
    const capture = createOrderCapture();
    exec.client = capture;

    await exec.placeOrder({ symbol: "AAPL", side: "buy", market: "stock", price: 100 } as any, 1, "momentum_stocks");

    expect(capture.calls[0].client_order_id.startsWith("uc8-momentum_stocks-")).toBe(true);
  });

  test("same (sleeve, symbol, ET day) produces a byte-identical client_order_id; a different symbol/day/sleeve differs", async () => {
    const exec = executor() as any;
    const capture = createOrderCapture();
    exec.client = capture;
    const signal = { symbol: "AAPL", side: "buy", market: "stock", price: 100 } as any;
    const dayKey = 1_700_000_000_000;

    await exec.placeOrder(signal, 1, "meanrev_stocks", { entryDayKey: dayKey });
    await exec.placeOrder(signal, 1, "meanrev_stocks", { entryDayKey: dayKey });
    await exec.placeOrder({ ...signal, symbol: "MSFT" }, 1, "meanrev_stocks", { entryDayKey: dayKey });
    await exec.placeOrder(signal, 1, "meanrev_stocks", { entryDayKey: dayKey + 86_400_000 });
    await exec.placeOrder(signal, 1, "momentum_stocks", { entryDayKey: dayKey });

    const ids = capture.calls.map(c => c.client_order_id);
    expect(ids[0]).toBe(ids[1]); // same (sleeve, symbol, day) → byte-identical
    expect(ids[2]).not.toBe(ids[0]); // different symbol
    expect(ids[3]).not.toBe(ids[0]); // different day
    expect(ids[4]).not.toBe(ids[0]); // different sleeve
  });

  test("the generated id never exceeds Alpaca's client_order_id cap, including with a long sleeve name", async () => {
    const exec = executor() as any;
    const capture = createOrderCapture();
    exec.client = capture;

    await exec.placeOrder(
      { symbol: "AAPL", side: "buy", market: "stock", price: 100 } as any,
      1,
      "a-very-long-sleeve-account-identifier-name-that-keeps-going-too",
    );

    expect(capture.calls[0].client_order_id.length).toBeLessThanOrEqual(CLIENT_ORDER_ID_MAX_LEN);
  });

  test("a duplicate-client-order-id rejection is surfaced as already-done, not a failure — no retry", async () => {
    const exec = executor() as any;
    let createCalls = 0;
    const getOrderByClientId = mock().mockResolvedValue({
      id: "already-placed-broker-id", status: "filled", filled_qty: "5", filled_avg_price: "101",
      filled_at: new Date().toISOString(),
    });
    exec.client = {
      createOrder: async () => {
        createCalls++;
        throw Object.assign(new Error("Request failed with status code 422"), {
          response: { status: 422, data: { code: 40010001, message: "client_order_id must be unique" } },
        });
      },
      getOrderByClientId,
    };

    const order = await exec.placeOrder(
      { symbol: "AAPL", side: "buy", market: "stock", price: 100 } as any,
      5,
      "meanrev_stocks",
      { entryDayKey: 1000 },
    );

    expect(order).not.toBeNull();
    expect(order!.status).toBe("filled");
    expect(order!.filledQty).toBe(5);
    expect(order!.externalId).toBe("already-placed-broker-id");
    expect(createCalls).toBe(1); // never retried the create
    expect(getOrderByClientId).toHaveBeenCalledTimes(1);
  });
});

// ── Corporate actions + wash-trade hardening (2026-08-03) ──────────────────
// Doc facts (docs.alpaca.markets, verified 2026-08-03): reverse splits
// CANCEL working GTC orders; forward splits REPLACE them (adjusted price/qty
// under a broker-generated client_order_id, chained via replaced_by); a
// market BUY against one of our open sell stops is ALWAYS rejected 403 by
// wash-trade protection (paper included); adjusted bar history is rewritten
// retroactively when an event lands.
describe("AlpacaExecutor adjusted bars (adjustment=all) + cache invalidation", () => {
  test("stock bars request carries adjustment=all — an unadjusted dividend gap is a FALSE Connors RSI(2) buy signal", async () => {
    const exec = executor();
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return page("AAPL", [bar(90)]);
    }) as unknown as typeof fetch;

    await exec.getBars("AAPL", "1Hour", 1);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("adjustment=all");
    expect(urls[0]).not.toContain("adjustment=split");
  });

  test("invalidateCandleCache drops EVERY timeframe for the symbol (adjusted history was rewritten); other symbols keep theirs", async () => {
    const exec = executor();
    fetchQueue(
      page("AAPL", [bar(90)]),
      page("AAPL", [bar(91)]),
      page("MSFT", [bar(200)]),
      rateLimited, // post-invalidation refetch fails → must yield [], not the stale pre-event bars
    );
    await exec.getBars("AAPL", "1Hour", 1);
    await exec.getBars("AAPL", "5Min", 1);
    await exec.getBars("MSFT", "1Hour", 1);

    exec.invalidateCandleCache("AAPL");

    // Without invalidation the fresh (<30min) fallback cache would happily
    // serve the pre-split/pre-dividend bars here.
    expect(await exec.getBars("AAPL", "1Hour", 1)).toEqual([]);
    expect(exec.getCachedCandles("AAPL", "5Min")).toEqual([]);
    expect(exec.getCachedCandles("MSFT", "1Hour").map(b => b.close)).toEqual([200]);
  });
});

describe("AlpacaExecutor wash-trade defense (user-protection 403)", () => {
  test("equity BUY cancels OUR live stop by EXACT id BEFORE createOrder; the foreign stop survives", async () => {
    const exec = executor() as any;
    const sequence: string[] = [];
    exec.client = {
      getOrders: async () => {
        sequence.push("enumerate");
        return [
          { id: "our-stop", client_order_id: "uc8-meanrev_stocks-slabc", symbol: "KO", side: "sell", type: "stop", qty: "20", stop_price: "55.00", status: "new" },
          { id: "foreign-stop", client_order_id: "manually-placed-by-a-human", symbol: "KO", side: "sell", type: "stop", qty: "5", stop_price: "50.00", status: "new" },
        ];
      },
      cancelOrder: async (id: string) => { sequence.push(`cancel:${id}`); return {}; },
      createOrder: async () => { sequence.push("create"); return { id: "b1", status: "filled", filled_qty: "20", filled_avg_price: "60" }; },
    };

    const order = await exec.placeOrder({ symbol: "KO", side: "buy", market: "stock", price: 60 } as any, 20, "meanrev_stocks");

    expect(order).not.toBeNull();
    // Ours canceled (exact id), foreign untouched, and strictly BEFORE the buy.
    expect(sequence).toEqual(["enumerate", "cancel:our-stop", "create"]);
  });

  test("equity SELL and crypto BUY never touch the order book (no needless sweep)", async () => {
    const exec = executor() as any;
    const getOrders = mock(async () => []);
    exec.client = {
      getOrders,
      createOrder: async () => ({ id: "b1", status: "filled", filled_qty: "1", filled_avg_price: "60" }),
    };

    await exec.placeOrder({ symbol: "KO", side: "sell", market: "stock", price: 60 } as any, 1, "meanrev_stocks");
    await exec.placeOrder({ symbol: "BTC/USD", side: "buy", market: "crypto", price: 50000 } as any, 1, "momentum_crypto");

    expect(getOrders).not.toHaveBeenCalled();
  });

  test("a wash-trade 403 on the BUY is classified — returns null and is NEVER mistaken for a duplicate client_order_id", async () => {
    const exec = executor() as any;
    const getOrderByClientId = mock(async () => ({ id: "x" }));
    exec.client = {
      getOrders: async () => [],
      createOrder: async () => {
        throw Object.assign(new Error("Request failed with status code 403"), {
          response: { status: 403, data: { message: "potential wash trade detected. use complex orders" } },
        });
      },
      getOrderByClientId,
    };

    const order = await exec.placeOrder({ symbol: "KO", side: "buy", market: "stock", price: 60 } as any, 20, "meanrev_stocks");

    expect(order).toBeNull();
    expect(getOrderByClientId).not.toHaveBeenCalled();
  });

  test("closePosition: wash-trade 403 → http_403_wash_trade; PDT/permission 403 keeps the exact http_403 string AccountManager matches on", async () => {
    const exec = executor() as any;
    exec.client = {
      getPosition: async () => ({ qty: "11" }),
      closePosition: async () => {
        throw Object.assign(new Error("403"), { response: { status: 403, data: { message: "potential wash trade detected" } } });
      },
    };
    expect((await exec.closePosition("KO", "buy", 11)).reason).toBe("http_403_wash_trade");

    exec.client = {
      getPosition: async () => ({ qty: "11" }),
      closePosition: async () => {
        throw Object.assign(new Error("forbidden"), { response: { status: 403, data: { message: "account is not authorized to trade" } } });
      },
    };
    expect((await exec.closePosition("KO", "buy", 11)).reason).toBe("http_403");
  });

  test("isWashTrade403 matches only a 403 whose body names a wash trade", () => {
    expect(isWashTrade403(403, "potential wash trade detected. use complex orders")).toBe(true);
    expect(isWashTrade403(403, "opposite side market order would cause a WASH TRADE")).toBe(true);
    expect(isWashTrade403(403, "account is not authorized to trade")).toBe(false); // permission
    expect(isWashTrade403(403, "trade denied due to pattern day trading protection")).toBe(false); // PDT
    expect(isWashTrade403(422, "potential wash trade detected")).toBe(false); // wrong code
  });
});

describe("AlpacaExecutor replaced_by order lookups (corporate-action chain)", () => {
  test("getOrderStateByClientId surfaces replaced_by (status `replaced` = adjusted by a market event, per docs)", async () => {
    const exec = executor() as any;
    exec.client = {
      getOrderByClientId: async () => ({ status: "replaced", replaced_by: "adj-1", filled_qty: "0", filled_avg_price: "0" }),
    };
    expect(await exec.getOrderStateByClientId("uc8-x-sl123")).toEqual({
      status: "replaced", filledQty: 0, filledAvgPrice: 0, filledAt: undefined, replacedBy: "adj-1",
    });
  });

  test("getOrderById normalizes the successor's identity/protection fields; unqueryable → null (unknown is never protection)", async () => {
    const exec = executor() as any;
    exec.client = {
      getOrder: async (id: string) => ({
        id, client_order_id: "broker-generated-not-uc8", symbol: "AAPL", status: "new", type: "stop",
        side: "sell", qty: "152", stop_price: "48.00", replaced_by: null, filled_qty: "0", filled_avg_price: "0",
      }),
    };
    expect(await exec.getOrderById("adj-1")).toMatchObject({
      id: "adj-1", clientOrderId: "broker-generated-not-uc8", symbol: "AAPL",
      status: "new", type: "stop", side: "sell", qty: 152, stopPrice: 48, replacedBy: null,
    });

    exec.client = { getOrder: async () => { throw new Error("api down"); } };
    expect(await exec.getOrderById("adj-1")).toBeNull();
  });
});

// ── Paper/live coherence guard (2026-08-09) ───────────────────────────────
// AUDIT HOLE 2: ALPACA_PAPER and ALPACA_BASE_URL were independent variables
// both handed to the SDK — ALPACA_PAPER=true with a live base URL WAS a live
// account. Same philosophy as isNonProductionBinanceHost: allowlist of known
// paper hosts; an unknown host is refused, never assumed safe.
describe("isKnownAlpacaPaperHost", () => {
  test("accepts the known paper host (case-insensitive)", () => {
    expect(isKnownAlpacaPaperHost("https://paper-api.alpaca.markets")).toBe(true);
    expect(isKnownAlpacaPaperHost("HTTPS://PAPER-API.ALPACA.MARKETS")).toBe(true);
  });
  test("live and unknown/empty hosts are NOT paper — fail closed", () => {
    expect(isKnownAlpacaPaperHost("https://api.alpaca.markets")).toBe(false);
    expect(isKnownAlpacaPaperHost("https://example.com")).toBe(false);
    expect(isKnownAlpacaPaperHost("")).toBe(false);
    expect(isKnownAlpacaPaperHost(undefined as any)).toBe(false);
  });
});

describe("alpacaPaperLiveMismatch", () => {
  test("coherent paper config (prod's actual shape) passes", () => {
    expect(alpacaPaperLiveMismatch(true, "https://paper-api.alpaca.markets")).toBeNull();
  });
  test("paper=true with a LIVE base URL is refused — the dangerous direction", () => {
    expect(alpacaPaperLiveMismatch(true, "https://api.alpaca.markets")).toMatch(/not a known paper host/);
  });
  test("paper=true with an UNKNOWN host is refused, never assumed safe", () => {
    expect(alpacaPaperLiveMismatch(true, "https://alpaca.example.com")).toMatch(/not a known paper host/);
  });
  test("paper=false with a paper host is refused too — intent must be coherent BOTH ways", () => {
    expect(alpacaPaperLiveMismatch(false, "https://paper-api.alpaca.markets")).toMatch(/contradictory/);
  });
  test("explicit live (paper=false + live URL) is coherent — going live requires BOTH variables", () => {
    expect(alpacaPaperLiveMismatch(false, "https://api.alpaca.markets")).toBeNull();
  });
});

describe("init() refuses an incoherent paper/live config before any network call", () => {
  test("ALPACA_PAPER=true + live base URL → init false, SDK never queried", async () => {
    const origUrl = config.alpaca.baseUrl;
    const origPaper = config.alpaca.paper;
    (config.alpaca as any).baseUrl = "https://api.alpaca.markets";
    (config.alpaca as any).paper = true;
    try {
      const exec = new AlpacaExecutor() as any;
      let network = 0;
      exec.client = { getAccount: async () => { network++; return {}; } };
      expect(await exec.init()).toBe(false);
      expect(network).toBe(0);
    } finally {
      (config.alpaca as any).baseUrl = origUrl;
      (config.alpaca as any).paper = origPaper;
    }
  });
});

// ── SIP budget regression (2026-08-10) ────────────────────────────────────
// Moving history from IEX to SIP multiplied the payload — IEX emits a bar
// only when IEX itself printed, SIP emits every interval. On the first
// trading day after that deploy, 83 timeouts fired across 8 of the 11
// momentum symbols, the 8-page budget ran out, and the 30-minute staleness
// bound then correctly returned empty. Correct behaviour, wrong budgets:
// the sleeve simply stopped being able to decide on fresh data.
describe("stock bars budgets are sized for SIP, not for IEX", () => {
  test("the page budget covers a realistic SIP history, not IEX's sparse one", () => {
    // A year of hourly RTH bars is ~1,630; two years of the daily-plus-hourly
    // mix the engines ask for runs past 8 pages once every interval carries a
    // bar. The exact figure matters less than the direction: this must not
    // silently regress back to a number tuned for a sparse feed.
    expect(STOCK_BARS_MAX_PAGES).toBeGreaterThanOrEqual(24);
  });

  test("the timeout is a background budget, generous enough to finish", () => {
    // 12s was the IEX-era value and is what tripped. This is a signals fetch,
    // not an execution path: a slow tick is cheap, a missing decision is not.
    expect(GET_BARS_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  test("pagination that cannot finish THROWS — never a truncated series", () => {
    // The failure mode we must keep: a partial price history is a wrong
    // decision, not a smaller one. getBars turns the throw into the bounded
    // stale-cache path, which is the safe outcome.
    const src = readFileSync(join(import.meta.dir, "alpaca-executor.ts"), "utf8");
    expect(src).toContain('throw new Error("stock bars pagination incomplete")');
  });
});

// ── Shared-account Reg-T buying power read (2026-08-20) ────────────────────
// Feeds AlpacaMomentumAdapter's pre-submit entry guard: the stock sleeves are
// DB-ledger divisions of one real account, and this is the only cross-sleeve
// truth about remaining capacity. null = unknown (callers FAIL OPEN — the
// broker stays the enforcer); a parseable value is returned as-is, including
// a negative one (margin call), which must block rather than read as unknown.
describe("getRegTBuyingPower — broker truth for the shared-account guard", () => {
  test("parses regt_buying_power (Alpaca sends strings)", async () => {
    const exec = executor() as any;
    exec.client = { getAccount: async () => ({ regt_buying_power: "187000.5", buying_power: "374001.0" }) };
    expect(await exec.getRegTBuyingPower()).toBe(187000.5);
  });

  test("falls back to buying_power only when regt_buying_power is absent", async () => {
    const exec = executor() as any;
    exec.client = { getAccount: async () => ({ buying_power: "50000" }) };
    expect(await exec.getRegTBuyingPower()).toBe(50000);
  });

  test("negative value is returned as-is (margin call must BLOCK, not fail open)", async () => {
    const exec = executor() as any;
    exec.client = { getAccount: async () => ({ regt_buying_power: "-1250.75" }) };
    expect(await exec.getRegTBuyingPower()).toBe(-1250.75);
  });

  test("unparseable/absent fields → null (unknown), never NaN or a fabricated 0", async () => {
    const exec = executor() as any;
    exec.client = { getAccount: async () => ({ regt_buying_power: "not-a-number" }) };
    expect(await exec.getRegTBuyingPower()).toBeNull();
    exec.client = { getAccount: async () => ({}) };
    expect(await exec.getRegTBuyingPower()).toBeNull();
  });

  test("disconnected / getAccount failure → null (unknown)", async () => {
    const exec = executor() as any;
    exec.connected = false;
    expect(await exec.getRegTBuyingPower()).toBeNull();
    exec.connected = true;
    exec.client = { getAccount: async () => { throw new Error("boom"); } };
    expect(await exec.getRegTBuyingPower()).toBeNull();
  });
});
