// ═══ Minimal RSS 2.0 / Atom parser — zero dependencies ═══
//
// Purpose-built for the dashboard's news bar (src/dashboard/routes/news.ts):
// it extracts feed title + item {title, link, pubDate} and nothing else.
// Handles CDATA sections, the five XML entities plus numeric character
// references, RSS <item><link>text</link></item> and Atom
// <entry><link href="…" rel="alternate"/></entry>. It is NOT a general XML
// parser (no namespaces, no nesting model) — exactly enough for the real
// feeds the dashboard reads, locked by feedParser.test.ts fixtures.

export interface FeedItem {
  title: string;
  /** Absolute http(s) URL or null when the feed carries none. */
  link: string | null;
  /** Epoch ms, or null when the date is missing/unparseable. */
  pubDate: number | null;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

/** Decode CDATA wrappers, the named XML entities and numeric charrefs. */
export function decodeXmlText(raw: string): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // last — "&amp;lt;" must decode to "&lt;", not "<"
  return s.trim();
}

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
  try { return String.fromCodePoint(code); } catch { return ""; }
}

/** First <tag>…</tag> text content inside `block`, decoded; "" if absent. */
function tagText(block: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return m ? decodeXmlText(m[1]) : "";
}

/** Atom <link …/> href: prefer rel="alternate" (or no rel), fall back to any. */
function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)].map((m) => m[1]);
  let fallback: string | null = null;
  for (const attrs of links) {
    const href = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /href\s*=\s*'([^']*)'/i.exec(attrs)?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (!rel || rel === "alternate") return decodeXmlText(href);
    if (!fallback) fallback = decodeXmlText(href);
  }
  return fallback;
}

function httpUrlOrNull(s: string | null): string | null {
  return s && /^https?:\/\//i.test(s) ? s : null;
}

function parseDate(s: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Parse an RSS 2.0 or Atom document. Never throws: anything unrecognizable
 * returns {title:"", items:[]} — the route treats that as a failed feed.
 */
export function parseFeed(xml: string): ParsedFeed {
  if (typeof xml !== "string" || xml.length === 0) return { title: "", items: [] };

  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml) && !/<channel[\s>]/i.test(xml);
  const blockTag = isAtom ? "entry" : "item";
  const blocks = [...xml.matchAll(new RegExp(`<${blockTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${blockTag}>`, "gi"))].map((m) => m[1]);

  // Feed title = the first <title> OUTSIDE any item/entry block.
  const head = blocks.length ? xml.slice(0, xml.search(new RegExp(`<${blockTag}[\\s>]`, "i"))) : xml;
  const title = tagText(head, "title");

  const items: FeedItem[] = [];
  for (const block of blocks) {
    const itemTitle = tagText(block, "title");
    if (!itemTitle) continue;
    const link = isAtom
      ? httpUrlOrNull(atomLink(block))
      : httpUrlOrNull(tagText(block, "link") || atomLink(block));
    const dateText = isAtom
      ? (tagText(block, "published") || tagText(block, "updated"))
      : (tagText(block, "pubDate") || tagText(block, "dc:date"));
    items.push({ title: itemTitle, link, pubDate: parseDate(dateText) });
  }
  return { title, items };
}
