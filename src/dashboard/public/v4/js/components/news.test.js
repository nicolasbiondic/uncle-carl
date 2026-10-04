// ── Market News: collapsible, closed by default (2026-09-24 audit fix) ─────
// The card used to always render open, eating ~20% of the viewport before
// first paint. Now: closed by default, toggle persists via store.js's
// PERSIST list, content hidden (not just visually collapsed) while closed.
import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../store.js";
import { renderNewsBar } from "./news.js";

const original = { ...store.state };
afterEach(() => Object.assign(store.state, original));

describe("renderNewsBar", () => {
  test("default state (newsOpen not explicitly set true): content is hidden, toggle reports aria-expanded=false", () => {
    Object.assign(store.state, { newsOpen: false });
    const html = renderNewsBar();
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/id="newsScroll"\s+hidden>/);
  });

  test("open: content is visible (no hidden attribute), aria-expanded=true", () => {
    Object.assign(store.state, { newsOpen: true });
    const html = renderNewsBar();
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toMatch(/id="newsScroll"\s+hidden>/);
  });

  test("the toggle is a real keyboard-focusable <button>, not a div/span", () => {
    Object.assign(store.state, { newsOpen: false });
    const html = renderNewsBar();
    expect(html).toMatch(/<button[^>]*data-act="news-toggle"/);
  });
});
