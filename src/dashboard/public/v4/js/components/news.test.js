// ── Market News: collapsible, open by default (owner, 2026-10-07) ──────────
// Closed by default from 2026-09-24, and while closed a CSS rule
// (.news-scroll's display:flex) overrode the hidden attribute: the card showed
// its "…" placeholder and never fetched. Now open by default under a new key
// (newsShown), [hidden] always wins in app.css, and collapsing persists.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { store } from "../store.js";
import { renderNewsBar } from "./news.js";

const original = { ...store.state };
afterEach(() => Object.assign(store.state, original));

describe("renderNewsBar", () => {
  test("default state: shown", () => {
    expect(original.newsShown).toBe(true);
  });

  test("collapsed: content is hidden, toggle reports aria-expanded=false", () => {
    Object.assign(store.state, { newsShown: false });
    const html = renderNewsBar();
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/id="newsScroll"\s+hidden>/);
  });

  test("the hidden attribute always wins over component display rules (app.css)", () => {
    const css = readFileSync(join(import.meta.dir, "../../css/app.css"), "utf-8").replace(/\s+/g, "");
    expect(css).toContain("[hidden]{display:none!important;}");
  });

  test("open: content is visible (no hidden attribute), aria-expanded=true", () => {
    Object.assign(store.state, { newsShown: true });
    const html = renderNewsBar();
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toMatch(/id="newsScroll"\s+hidden>/);
  });

  test("the toggle is a real keyboard-focusable <button>, not a div/span", () => {
    Object.assign(store.state, { newsShown: false });
    const html = renderNewsBar();
    expect(html).toMatch(/<button[^>]*data-act="news-toggle"/);
  });
});
