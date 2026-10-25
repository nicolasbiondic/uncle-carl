// ═══ GET /api/news — server-side RSS/Atom aggregation (2026-10-06) ═══
//
// Replaces the frontend's api.rss2json.com dependency (third-party quota,
// no timeout, re-fetched every 30s render). The server reads the same feeds
// directly, with:
//   - 8s timeout per feed (AbortSignal) — one slow feed never hangs the bar;
//   - 10-minute in-memory cache per language — at most ~4 upstream fetches
//     per 10min regardless of how many times the SPA asks;
//   - stale-cache fallback: if EVERY feed fails, the previous (expired)
//     payload is served rather than an empty bar.
// Registered behind server.ts's auth wall like every other data route.

import type express from "express";
import { parseFeed } from "../news/feedParser";
import { rankNewsItems, type NewsRelevanceContext } from "../news/relevance";
import { getDB } from "../../db/database";
import { builtinPortfolios } from "../../portfolios/builtin";
import { loadPlatformPortfolioRows } from "../../portfolios/store";
import { portfolioUniverse } from "../../portfolios/validate";
import type { PortfolioEngineParams } from "../../portfolios/types";
import { createLogger } from "../../utils/logger";

const log = createLogger("Dashboard");

/** `name` is the short label shown on the card (feed titles run long:
 *  "CoinDesk: Bitcoin, Ethereum, XRP, Crypto News and Price Data"). */
export interface NewsFeedDef { url: string; lang: "EN" | "ES"; name: string; }

/** What the bot trades — US stocks/ETFs and crypto — in both languages
 *  (2026-10-07: three of the four original feeds were crypto-only). Each one
 *  checked on 2026-10-07: answers, parses, publishes within hours. Left out:
 *  Investing.com (pubDates hours in the future), El Economista (403), Cinco
 *  Días (404), Cointelegraph ES (410), MarketWatch MarketPulse (stale). */
export const NEWS_FEEDS: Record<"en" | "es", NewsFeedDef[]> = {
  en: [
    { url: "https://feeds.bloomberg.com/markets/news.rss", lang: "EN", name: "Bloomberg" },
    { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", lang: "EN", name: "MarketWatch" },
    { url: "https://seekingalpha.com/market_currents.xml", lang: "EN", name: "Seeking Alpha" },
    { url: "https://cointelegraph.com/rss", lang: "EN", name: "Cointelegraph" },
    { url: "https://www.coindesk.com/arc/outboundfeeds/rss", lang: "EN", name: "CoinDesk" },
  ],
  // Spanish readers get these PLUS a taste of the EN feeds (NEWS_PER_SOURCE).
  es: [
    { url: "https://e00-expansion.uecdn.es/rss/mercados.xml", lang: "ES", name: "Expansión" },
    { url: "https://www.bloomberglinea.com/arc/outboundfeeds/rss/?outputType=xml", lang: "ES", name: "Bloomberg Línea" },
    { url: "https://es.beincrypto.com/feed/", lang: "ES", name: "BeInCrypto" },
    { url: "https://www.criptonoticias.com/feed/", lang: "ES", name: "CriptoNoticias" },
  ],
};

/** Items kept per source: the reader's language gets the room, the other one
 *  a taste — and no prolific feed crowds out the rest (2026-10-07: newest-
 *  first-then-cap left only Bloomberg and Cointelegraph on screen). */
export const NEWS_PER_SOURCE = { own: 6, other: 2 } as const;
/** A feed that stopped updating must not fill the bar with old news. */
export const NEWS_MAX_AGE_MS = 72 * 3_600_000;

export interface NewsItem {
  title: string;
  link: string | null;
  source: string;
  lang: "EN" | "ES";
  /** Epoch ms or null. */
  pubDate: number | null;
  /** Matched held/traded asset or market-moving topic; never feed language. */
  tag?: string;
}

export const NEWS_CACHE_TTL_MS = 10 * 60_000;
export const NEWS_FEED_TIMEOUT_MS = 8_000;
const MAX_ITEMS = 12;

interface CacheEntry { at: number; items: NewsItem[]; }
const cache = new Map<string, CacheEntry>(); // key: "en" | "es"

export function resetNewsCacheForTests(): void { cache.clear(); }

/** DB is a read-only source here; no broker calls or client-specific filtering. */
export function newsRelevanceContext(db = getDB(), source = process.env.PORTFOLIOS_SOURCE): NewsRelevanceContext {
  const definitions = source === "db" && db
    ? loadPlatformPortfolioRows(db).filter(d => d.status === "active")
    : builtinPortfolios();
  return {
    heldSymbols: db ? (db.prepare("SELECT DISTINCT symbol FROM trades WHERE status = 'open'").all() as Array<{ symbol: string }>).map(t => t.symbol) : [],
    tradedSymbols: definitions
      .filter(d => d.enabled && (d.template !== "portfolio" || (d.params as PortfolioEngineParams).runMode === "live"))
      .flatMap(d => portfolioUniverse(d.template, d.params)),
  };
}

/** Filter/rank BEFORE dedupe and cap, so irrelevant items never consume slots. */
export function mergeNewsItems(lists: NewsItem[][], context: NewsRelevanceContext = { heldSymbols: [] }): NewsItem[] {
  const all = rankNewsItems(lists.flat(), context);
  const seen = new Set<string>();
  return all
    .filter((n) => {
      const k = (n.title || "").slice(0, 40);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_ITEMS);
}

async function fetchFeed(def: NewsFeedDef, fetchFn: typeof fetch): Promise<NewsItem[]> {
  const res = await fetchFn(def.url, {
    signal: AbortSignal.timeout(NEWS_FEED_TIMEOUT_MS),
    headers: { "User-Agent": "uncle-carl-dashboard (+self-hosted news bar)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
  } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = parseFeed(await res.text());
  if (!parsed.items.length) throw new Error("no items parsed");
  return parsed.items.map((i) => ({
    title: i.title, link: i.link, pubDate: i.pubDate,
    source: def.name || parsed.title || new URL(def.url).hostname,
    lang: def.lang,
  }));
}

/** Core logic, DI'd for tests. Returns {items, cachedAt, stale}. */
export async function getNews(
  lang: "en" | "es",
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
  relevanceContext: () => NewsRelevanceContext = newsRelevanceContext,
): Promise<{ items: NewsItem[]; cachedAt: number; stale: boolean }> {
  const hit = cache.get(lang);
  if (hit && now() - hit.at < NEWS_CACHE_TTL_MS) {
    return { items: hit.items, cachedAt: hit.at, stale: false };
  }

  const feeds = lang === "es" ? [...NEWS_FEEDS.en, ...NEWS_FEEDS.es] : NEWS_FEEDS.en;
  const settled = await Promise.allSettled(feeds.map((f) => fetchFeed(f, fetchFn)));
  const own = lang === "es" ? "ES" : "EN";
  const context = relevanceContext();
  const ok: NewsItem[][] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      const fresh = rankNewsItems(r.value
        .filter((n) => n.pubDate == null || now() - n.pubDate <= NEWS_MAX_AGE_MS), context);
      ok.push(fresh.slice(0, feeds[i].lang === own ? NEWS_PER_SOURCE.own : NEWS_PER_SOURCE.other));
    } else {
      log.warn(`news feed failed: ${feeds[i].url} — ${(r.reason as any)?.message ?? r.reason}`);
    }
  }

  if (ok.length === 0) {
    // Every feed failed: serve the stale cache if we have one.
    if (hit) return { items: hit.items, cachedAt: hit.at, stale: true };
    return { items: [], cachedAt: now(), stale: false };
  }

  const items = mergeNewsItems(ok, context);
  const entry = { at: now(), items };
  cache.set(lang, entry);
  return { items, cachedAt: entry.at, stale: false };
}

export function registerNewsRoutes(
  app: express.Application,
  deps?: { fetch?: typeof fetch; now?: () => number },
): void {
  app.get("/api/news", async (req, res) => {
    const lang = req.query.lang === "es" ? "es" : "en";
    try {
      res.json(await getNews(lang, deps?.fetch ?? fetch, deps?.now ?? Date.now));
    } catch (e: any) {
      log.error(`/api/news failed: ${e?.message ?? e}`);
      res.status(500).json({ items: [], cachedAt: 0, stale: false });
    }
  });
}
