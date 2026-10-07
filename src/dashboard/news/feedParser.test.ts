import { describe, expect, test } from "bun:test";
import { decodeXmlText, parseFeed } from "./feedParser";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title><![CDATA[Cointelegraph.com News]]></title>
    <link>https://cointelegraph.com</link>
    <description>Latest news</description>
    <item>
      <title><![CDATA[Bitcoin hits $100K &amp; beyond]]></title>
      <link>https://cointelegraph.com/news/bitcoin-100k</link>
      <pubDate>Mon, 06 Oct 2026 12:30:00 +0000</pubDate>
    </item>
    <item>
      <title>Ether &#8220;merges&#8221; again &lt;testnet&gt;</title>
      <link>https://cointelegraph.com/news/ether-merge</link>
      <pubDate>Mon, 06 Oct 2026 09:00:00 GMT</pubDate>
    </item>
    <item>
      <title>No link item</title>
      <pubDate>not a date</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Bloomberg Markets</title>
  <link href="https://www.bloomberg.com/markets"/>
  <updated>2026-10-06T10:00:00Z</updated>
  <entry>
    <title>Stocks rally on earnings</title>
    <link rel="alternate" href="https://www.bloomberg.com/news/stocks-rally"/>
    <link rel="enclosure" href="https://img.example.com/x.jpg"/>
    <published>2026-10-06T08:15:00Z</published>
  </entry>
  <entry>
    <title type="html">Bonds &amp; yields: what&#39;s next</title>
    <link href="https://www.bloomberg.com/news/bonds-yields"/>
    <updated>2026-10-05T22:40:00Z</updated>
  </entry>
</feed>`;

describe("decodeXmlText", () => {
  test("CDATA, named entities and numeric charrefs", () => {
    expect(decodeXmlText("<![CDATA[A & B]]>")).toBe("A & B");
    expect(decodeXmlText("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(`a & b <c> "d" 'e'`);
    expect(decodeXmlText("&#8220;hi&#8221; &#x2014;")).toBe("\u201chi\u201d \u2014");
  });
  test("double-escaped stays single-decoded", () => {
    expect(decodeXmlText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });
  test("out-of-range charrefs vanish instead of throwing", () => {
    expect(decodeXmlText("x&#1114112;y")).toBe("xy");
  });
});

describe("parseFeed — RSS 2.0", () => {
  const feed = parseFeed(RSS_FIXTURE);
  test("feed title decoded from CDATA", () => {
    expect(feed.title).toBe("Cointelegraph.com News");
  });
  test("items with CDATA + entity titles, links and dates", () => {
    expect(feed.items.length).toBe(3);
    expect(feed.items[0]).toEqual({
      title: "Bitcoin hits $100K & beyond",
      link: "https://cointelegraph.com/news/bitcoin-100k",
      pubDate: Date.parse("2026-10-06T12:30:00Z"),
    });
    expect(feed.items[1].title).toBe("Ether \u201cmerges\u201d again <testnet>");
    expect(feed.items[1].pubDate).toBe(Date.parse("2026-10-06T09:00:00Z"));
  });
  test("missing link → null; garbage date → null", () => {
    expect(feed.items[2].link).toBeNull();
    expect(feed.items[2].pubDate).toBeNull();
  });
});

describe("parseFeed — Atom", () => {
  const feed = parseFeed(ATOM_FIXTURE);
  test("feed title is the head title, not an entry's", () => {
    expect(feed.title).toBe("Bloomberg Markets");
  });
  test("entries prefer rel=alternate links and published dates", () => {
    expect(feed.items[0]).toEqual({
      title: "Stocks rally on earnings",
      link: "https://www.bloomberg.com/news/stocks-rally",
      pubDate: Date.parse("2026-10-06T08:15:00Z"),
    });
  });
  test("no-rel link accepted; updated used when published missing", () => {
    expect(feed.items[1].link).toBe("https://www.bloomberg.com/news/bonds-yields");
    expect(feed.items[1].pubDate).toBe(Date.parse("2026-10-05T22:40:00Z"));
  });
});

describe("parseFeed — hostile/degenerate input", () => {
  test("empty / non-XML input returns an empty feed, never throws", () => {
    expect(parseFeed("")).toEqual({ title: "", items: [] });
    expect(parseFeed("not xml at all")).toEqual({ title: "", items: [] });
    expect(parseFeed("<html><body>404</body></html>")).toEqual({ title: "", items: [] });
  });
  test("items without a title are dropped", () => {
    const xml = `<rss><channel><title>T</title><item><link>https://x.y/z</link></item></channel></rss>`;
    expect(parseFeed(xml).items).toEqual([]);
  });
  test("non-http links are nulled (javascript: etc.)", () => {
    const xml = `<rss><channel><title>T</title><item><title>x</title><link>javascript:alert(1)</link></item></channel></rss>`;
    expect(parseFeed(xml).items[0].link).toBeNull();
  });
});
