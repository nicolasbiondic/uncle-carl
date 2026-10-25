import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initPlatformPortfolios } from "../../portfolios/store";
import { getNews as getNewsWithContext, newsRelevanceContext, mergeNewsItems, resetNewsCacheForTests, NEWS_CACHE_TTL_MS, NEWS_MAX_AGE_MS, NEWS_PER_SOURCE, type NewsItem } from "./news";
import type { NewsRelevanceContext } from "../news/relevance";

// No shared/global DB or host settings in feed tests.
const getNews = (lang: "en" | "es", fetchFn: typeof fetch, now: () => number,
  context: () => NewsRelevanceContext = () => ({ heldSymbols: [] })) => getNewsWithContext(lang, fetchFn, now, context);

const RSS = (title: string, items: Array<[string, string, string]>) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>${title}</title>
${items.map(([t, l, d]) => `<item><title>${t}</title><link>${l}</link><pubDate>${d}</pubDate></item>`).join("\n")}
</channel></rss>`;

function fakeFetch(bodies: Record<string, string | Error>): typeof fetch {
  return (async (url: any) => {
    const body = bodies[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(body, { status: 200, headers: { "content-type": "application/rss+xml" } });
  }) as unknown as typeof fetch;
}

const COINTELEGRAPH = "https://cointelegraph.com/rss";
const COINDESK = "https://www.coindesk.com/arc/outboundfeeds/rss";
const BLOOMBERG = "https://feeds.bloomberg.com/markets/news.rss";
const BEINCRYPTO = "https://es.beincrypto.com/feed/";

const CT_XML = RSS("Cointelegraph", [["BTC news", "https://ct.example/a", "Mon, 06 Oct 2026 12:00:00 GMT"]]);
const CD_XML = RSS("CoinDesk", [["ETH news", "https://cd.example/b", "Mon, 06 Oct 2026 13:00:00 GMT"]]);
const BB_XML = RSS("Bloomberg", [["Fed cuts rates", "https://bb.example/c", "Mon, 06 Oct 2026 11:00:00 GMT"]]);
const BC_XML = RSS("BeInCrypto ES", [["Bitcoin sube tras decision de la Fed", "https://bc.example/d", "Mon, 06 Oct 2026 10:00:00 GMT"]]);

beforeEach(() => resetNewsCacheForTests());

test("context reads open holdings and active enabled portfolio universes, including contingency symbols", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE trades (symbol TEXT, status TEXT)");
    db.run("INSERT INTO trades VALUES ('BTC/COIN-M', 'open'), ('NVDA', 'closed')");
    initPlatformPortfolios(db);
    db.prepare("UPDATE platform_portfolios SET template = 'portfolio', status = 'active', enabled = 1, params_json = ? WHERE id = 'momentum_stocks'")
      .run(JSON.stringify({ runMode: "live", strategy: { kind: "volManaged", universe: ["TLT"], regimeOverlay: {
        signals: [{ kind: "maTrend", symbol: "SPY", sampling: "daily", period: 200 }], combine: "any",
        hedge: { symbol: "SH", fraction: 0.1 },
      } } }));
    const result = newsRelevanceContext(db, "db");
    expect(result.heldSymbols).toEqual(["BTC/COIN-M"]);
    expect(result.tradedSymbols).toContain("TLT");
    expect(result.tradedSymbols).toContain("SH");
    db.run("UPDATE platform_portfolios SET params_json = json_set(params_json, '$.runMode', 'observer') WHERE id = 'momentum_stocks'");
    expect(newsRelevanceContext(db, "db").tradedSymbols).not.toContain("TLT");
    db.run("UPDATE platform_portfolios SET params_json = json_set(params_json, '$.runMode', 'live') WHERE id = 'momentum_stocks'");
    // Disabled definitions and pending owner edits must not become live topics.
    db.run("UPDATE platform_portfolios SET enabled = 0 WHERE id = 'momentum_stocks'");
    expect(newsRelevanceContext(db, "db").tradedSymbols).not.toContain("TLT");
    db.run("UPDATE platform_portfolios SET enabled = 1, status = 'pending_restart' WHERE id = 'momentum_stocks'");
    expect(newsRelevanceContext(db, "db").tradedSymbols).not.toContain("TLT");
    expect(newsRelevanceContext(db, "code").tradedSymbols).toContain("NVDA");
  } finally { db.close(); }
});

describe("mergeNewsItems", () => {
  const item = (title: string, pubDate: number | null): NewsItem =>
    ({ title, link: null, source: "s", lang: "EN", pubDate });
  test("dedupes by 40-char title prefix and sorts newest first", () => {
    const merged = mergeNewsItems([
      [item("BTC same headline repeats across feeds today — one", 100)],
      [item("BTC same headline repeats across feeds today — two", 200), item("ETH unique", 300)],
    ]);
    // Dedupe after ranking: the newest copy survives.
    expect(merged.map((m) => m.pubDate)).toEqual([300, 200]);
  });
  test("caps relevant news at 12 items", () => {
    const many = Array.from({ length: 40 }, (_, i) => item(`BTC headline number ${i}`, i));
    expect(mergeNewsItems([many]).length).toBe(12);
  });
  test("held > traded > macro, then recency; tags identify the strongest match", () => {
    const merged = mergeNewsItems([[item("Fed cuts rates", 500), item("Bitcoin rises", 400),
      item("NVDA earnings beat estimates", 100), item("Apple raises guidance", 300)]], { heldSymbols: ["NVDA"] });
    expect(merged.map(i => i.tag)).toEqual(["NVDA", "BTC", "AAPL", "Fed"]);
  });
});

describe("getNews", () => {
  test("en: aggregates the three EN feeds, newest first, with source titles", async () => {
    const f = fakeFetch({ [COINTELEGRAPH]: CT_XML, [COINDESK]: CD_XML, [BLOOMBERG]: BB_XML });
    const r = await getNews("en", f, () => 1_000);
    expect(r.stale).toBe(false);
    expect(r.items.map((i) => i.title)).toEqual(["ETH news", "BTC news", "Fed cuts rates"]);
    expect(r.items[0].source).toBe("CoinDesk");
    expect(r.items.every((i) => i.lang === "EN")).toBe(true);
  });

  test("es: EN feeds plus the ES feed, lang-tagged", async () => {
    const f = fakeFetch({ [COINTELEGRAPH]: CT_XML, [COINDESK]: CD_XML, [BLOOMBERG]: BB_XML, [BEINCRYPTO]: BC_XML });
    const r = await getNews("es", f, () => 1_000);
    const es = r.items.find((i) => i.lang === "ES");
    expect(es?.title).toBe("Bitcoin sube tras decision de la Fed");
    expect(r.items.length).toBe(4);
  });

  test("partial failure: surviving feeds still render", async () => {
    const f = fakeFetch({ [COINTELEGRAPH]: new Error("boom"), [COINDESK]: CD_XML });
    const r = await getNews("en", f, () => 1_000);
    expect(r.items.map((i) => i.title)).toEqual(["ETH news"]);
  });

  test("cache: a second call within the TTL does not refetch", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response(CT_XML); }) as unknown as typeof fetch;
    let t = 1_000;
    await getNews("en", f, () => t);
    const before = calls;
    t += NEWS_CACHE_TTL_MS - 1;
    const r = await getNews("en", f, () => t);
    expect(calls).toBe(before);
    expect(r.items.length).toBeGreaterThan(0);
  });

  test("cache expiry refetches; total failure falls back to the stale cache", async () => {
    let t = 1_000;
    let fail = false;
    const f = (async () => {
      if (fail) throw new Error("all down");
      return new Response(CT_XML);
    }) as unknown as typeof fetch;
    const first = await getNews("en", f, () => t);
    expect(first.items.length).toBe(1);
    t += NEWS_CACHE_TTL_MS + 1;
    fail = true;
    const second = await getNews("en", f, () => t);
    expect(second.stale).toBe(true);
    expect(second.items).toEqual(first.items);
  });

  test("a prolific feed cannot crowd out the others: at most NEWS_PER_SOURCE.own items per source", async () => {
    const DAY = Date.parse("Mon, 06 Oct 2026 12:00:00 GMT");
    const many = Array.from({ length: 20 }, (_, i): [string, string, string] =>
      [`NVDA Bloomberg story ${i}`, `https://bb.example/${i}`, new Date(DAY + i * 60_000).toUTCString()]);
    const f = fakeFetch({ [BLOOMBERG]: RSS("Bloomberg", many), [COINDESK]: CD_XML });
    const r = await getNews("en", f, () => DAY + 3_600_000);
    expect(r.items.filter((i) => i.source === "Bloomberg").length).toBe(NEWS_PER_SOURCE.own);
    expect(r.items.some((i) => i.source === "CoinDesk")).toBe(true); // older than every Bloomberg story, still shown
  });

  test("es: Spanish sources get the room, English ones a taste", async () => {
    const DAY = Date.parse("Mon, 06 Oct 2026 12:00:00 GMT");
    const rows = (prefix: string): Array<[string, string, string]> =>
      Array.from({ length: 10 }, (_, i) => [`BTC ${prefix} ${i}`, `https://x.example/${prefix}/${i}`, new Date(DAY + i * 60_000).toUTCString()]);
    const f = fakeFetch({ [BLOOMBERG]: RSS("Bloomberg", rows("Bloomberg EN")), [BEINCRYPTO]: RSS("BeInCrypto", rows("Cripto ES")) });
    const r = await getNews("es", f, () => DAY + 3_600_000);
    expect(r.items.filter((i) => i.lang === "ES").length).toBe(NEWS_PER_SOURCE.own);
    expect(r.items.filter((i) => i.lang === "EN").length).toBe(NEWS_PER_SOURCE.other);
  });

  test("items older than NEWS_MAX_AGE_MS are dropped (a feed that stopped updating)", async () => {
    const NOW = Date.parse("Mon, 06 Oct 2026 12:00:00 GMT");
    const xml = RSS("CoinDesk", [
      ["Bitcoin fresh", "https://cd.example/f", new Date(NOW - 3_600_000).toUTCString()],
      ["Bitcoin stale", "https://cd.example/s", new Date(NOW - NEWS_MAX_AGE_MS - 3_600_000).toUTCString()],
    ]);
    const r = await getNews("en", fakeFetch({ [COINDESK]: xml }), () => NOW);
    expect(r.items.map((i) => i.title)).toEqual(["Bitcoin fresh"]);
  });

  test("filters before the source cap, ranks held names first and never pads", async () => {
    const DAY = Date.parse("2026-10-25T12:00:00Z");
    const rows: Array<[string, string, string]> = [
      ...Array.from({ length: 10 }, (_, i): [string, string, string] =>
        [`${i + 1} stocks to buy after the Fed decision`, `https://mw.example/${i}`, new Date(DAY).toUTCString()]),
      ["My father-in-law, 81, sold his $75,000 home", "https://mw.example/personal", new Date(DAY).toUTCString()],
      ["Fed holds rates", "https://mw.example/fed", new Date(DAY - 1000).toUTCString()],
      ["Nvidia raises guidance", "https://mw.example/nvda", new Date(DAY - 2000).toUTCString()],
    ];
    const f = fakeFetch({ [BLOOMBERG]: RSS("Bloomberg", rows) });
    const result = await getNews("en", f, () => DAY, () => ({ heldSymbols: ["NVDA"] }));
    expect(result.items.map(i => i.tag)).toEqual(["NVDA", "Fed"]);
    expect(result.items).toHaveLength(2);
    // All clients share the same filtered cached payload.
    expect((await getNews("en", f, () => DAY)).items).toEqual(result.items);
  });

  test("successful feeds containing only rejected stories return empty, not stale or padded news", async () => {
    const r = await getNews("en", fakeFetch({ [BLOOMBERG]: RSS("Bloomberg", [
      ["Should I buy Bitcoin for retirement?", "https://bb.example/advice", ""],
      ["Celebrity buys mansion", "https://bb.example/lifestyle", ""],
    ]) }), () => 1000);
    expect(r.items).toEqual([]);
    expect(r.stale).toBe(false);
  });

  test("total failure with no cache: empty list, no throw", async () => {
    const f = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const r = await getNews("en", f, () => 1_000);
    expect(r.items).toEqual([]);
    expect(r.stale).toBe(false);
  });
});
