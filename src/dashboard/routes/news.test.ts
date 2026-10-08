import { beforeEach, describe, expect, test } from "bun:test";
import { getNews, mergeNewsItems, resetNewsCacheForTests, NEWS_CACHE_TTL_MS, NEWS_MAX_AGE_MS, NEWS_PER_SOURCE, type NewsItem } from "./news";

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
const BB_XML = RSS("Bloomberg", [["Stocks news", "https://bb.example/c", "Mon, 06 Oct 2026 11:00:00 GMT"]]);
const BC_XML = RSS("BeInCrypto ES", [["Noticia cripto", "https://bc.example/d", "Mon, 06 Oct 2026 10:00:00 GMT"]]);

beforeEach(() => resetNewsCacheForTests());

describe("mergeNewsItems", () => {
  const item = (title: string, pubDate: number | null): NewsItem =>
    ({ title, link: null, source: "s", lang: "EN", pubDate });
  test("dedupes by 40-char title prefix and sorts newest first", () => {
    const merged = mergeNewsItems([
      [item("same headline that repeats across feeds — one", 100)],
      [item("same headline that repeats across feeds — two", 200), item("unique", 300)],
    ]);
    // Both long titles share the first 40 chars → only the first survives.
    expect(merged.map((m) => m.pubDate)).toEqual([300, 100]);
  });
  test("caps at 30 items", () => {
    const many = Array.from({ length: 40 }, (_, i) => item(`headline number ${i}`, i));
    expect(mergeNewsItems([many]).length).toBe(30);
  });
});

describe("getNews", () => {
  test("en: aggregates the three EN feeds, newest first, with source titles", async () => {
    const f = fakeFetch({ [COINTELEGRAPH]: CT_XML, [COINDESK]: CD_XML, [BLOOMBERG]: BB_XML });
    const r = await getNews("en", f, () => 1_000);
    expect(r.stale).toBe(false);
    expect(r.items.map((i) => i.title)).toEqual(["ETH news", "BTC news", "Stocks news"]);
    expect(r.items[0].source).toBe("CoinDesk");
    expect(r.items.every((i) => i.lang === "EN")).toBe(true);
  });

  test("es: EN feeds plus the ES feed, lang-tagged", async () => {
    const f = fakeFetch({ [COINTELEGRAPH]: CT_XML, [COINDESK]: CD_XML, [BLOOMBERG]: BB_XML, [BEINCRYPTO]: BC_XML });
    const r = await getNews("es", f, () => 1_000);
    const es = r.items.find((i) => i.lang === "ES");
    expect(es?.title).toBe("Noticia cripto");
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
      [`Bloomberg story ${i}`, `https://bb.example/${i}`, new Date(DAY + i * 60_000).toUTCString()]);
    const f = fakeFetch({ [BLOOMBERG]: RSS("Bloomberg", many), [COINDESK]: CD_XML });
    const r = await getNews("en", f, () => DAY + 3_600_000);
    expect(r.items.filter((i) => i.source === "Bloomberg").length).toBe(NEWS_PER_SOURCE.own);
    expect(r.items.some((i) => i.source === "CoinDesk")).toBe(true); // older than every Bloomberg story, still shown
  });

  test("es: Spanish sources get the room, English ones a taste", async () => {
    const DAY = Date.parse("Mon, 06 Oct 2026 12:00:00 GMT");
    const rows = (prefix: string): Array<[string, string, string]> =>
      Array.from({ length: 10 }, (_, i) => [`${prefix} ${i}`, `https://x.example/${prefix}/${i}`, new Date(DAY + i * 60_000).toUTCString()]);
    const f = fakeFetch({ [BLOOMBERG]: RSS("Bloomberg", rows("Bloomberg EN")), [BEINCRYPTO]: RSS("BeInCrypto", rows("Cripto ES")) });
    const r = await getNews("es", f, () => DAY + 3_600_000);
    expect(r.items.filter((i) => i.lang === "ES").length).toBe(NEWS_PER_SOURCE.own);
    expect(r.items.filter((i) => i.lang === "EN").length).toBe(NEWS_PER_SOURCE.other);
  });

  test("items older than NEWS_MAX_AGE_MS are dropped (a feed that stopped updating)", async () => {
    const NOW = Date.parse("Mon, 06 Oct 2026 12:00:00 GMT");
    const xml = RSS("CoinDesk", [
      ["fresh", "https://cd.example/f", new Date(NOW - 3_600_000).toUTCString()],
      ["stale", "https://cd.example/s", new Date(NOW - NEWS_MAX_AGE_MS - 3_600_000).toUTCString()],
    ]);
    const r = await getNews("en", fakeFetch({ [COINDESK]: xml }), () => NOW);
    expect(r.items.map((i) => i.title)).toEqual(["fresh"]);
  });

  test("total failure with no cache: empty list, no throw", async () => {
    const f = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const r = await getNews("en", f, () => 1_000);
    expect(r.items).toEqual([]);
    expect(r.stale).toBe(false);
  });
});
