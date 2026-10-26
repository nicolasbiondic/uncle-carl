// ── Market news: always shown (owner, 2026-10-26) ──────────────────────────
// The collapse toggle ("MARKET NEWS ▾") and its persisted newsShown state are
// gone: the row is always there, under a plain sentence-case label.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { store } from "../store.js";
import { loadNews, renderNewsBar } from "./news.js";
import * as news from "./news.js";

const original = { ...store.state };
afterEach(() => Object.assign(store.state, original));

describe("renderNewsBar", () => {
  test("always shown: no toggle, no hidden attribute, no persisted collapse state", () => {
    const html = renderNewsBar();
    expect(html).not.toContain("<button");
    expect(html).not.toContain("news-toggle");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toMatch(/\shidden[\s>]/);
    expect(html).toContain('id="newsScroll"');
    expect("newsShown" in original).toBe(false);
    expect("toggleNews" in news).toBe(false);
  });

  test("the label is plain sentence-case text, in both languages", () => {
    store.state.lang = "en";
    expect(renderNewsBar()).toContain("<span>Market news</span>");
    store.state.lang = "es";
    expect(renderNewsBar()).toContain("<span>Noticias del mercado</span>");
  });
});

test("quiet bilingual empty state and escaped plain-text relevance tag replace language chip", async () => {
  const documentBefore = globalThis.document, windowBefore = globalThis.window;
  const el = { innerHTML: "" };
  const clock = spyOn(Date, "now");
  let now = 1_000_000;
  clock.mockImplementation(() => now);
  let items = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => ({
    ok: true, json: async () => ({ items }),
  }));
  globalThis.document = { getElementById: () => el };
  globalThis.window = { matchMedia: () => ({ matches: true }) }; // no timers/browser
  try {
    Object.assign(store.state, { lang: "en" });
    await loadNews();
    expect(el.innerHTML).toContain("No market-moving news");
    expect(el.innerHTML).toContain('class="muted news-empty"');
    store.state.lang = "es";
    await loadNews();
    expect(el.innerHTML).toContain("Sin noticias relevantes");
    store.state.lang = "en";
    now += 10 * 60_000 + 1;
    items = [{ title: "Nvidia earnings", source: "MarketWatch", lang: "EN", tag: "NVDA<script>", link: "https://example.com/news" }];
    await loadNews();
    expect(el.innerHTML).toContain('<span class="n-tag">NVDA&lt;script&gt;</span>');
    expect(el.innerHTML).not.toContain("n-lang");
    expect(el.innerHTML).not.toContain(">EN<");
  } finally {
    fetchMock.mockRestore(); clock.mockRestore();
    if (documentBefore === undefined) delete globalThis.document; else globalThis.document = documentBefore;
    if (windowBefore === undefined) delete globalThis.window; else globalThis.window = windowBefore;
  }
});
