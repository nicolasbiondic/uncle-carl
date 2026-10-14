// ── One-screen desktop layout (owner, 2026-10-12: "en la pestaña Overview
// tenemos que tener el 100% de alto siempre") ────────────────────────────
// The audit of the same morning raised the viewport lock's height floor to
// 960px; the owner's ~890px window then fell back to page scroll, the
// analytics card grew past an empty left column, and nothing failed. These
// pins keep the lock on every desktop window that can show a table row.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const css = readFileSync(join(import.meta.dir, "../css/app.css"), "utf-8").replace(/\s+/g, " ");
const html = readFileSync(join(import.meta.dir, "../index.html"), "utf-8");

describe("viewport lock", () => {
  const m = css.match(/@media \(min-width: (\d+)px\) and \(min-height: (\d+)px\) \{ html, body \{ height: 100dvh; overflow: hidden; \}/);

  test("exists and applies to every desktop width", () => {
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeLessThanOrEqual(981);
  });

  test("its height floor stays at or below 600px (a 1366×768 laptop leaves ~650px)", () => {
    expect(Number(m?.[2])).toBeLessThanOrEqual(600);
  });
});

describe("header", () => {
  test("the nav sits inside the header's first row (no row of its own)", () => {
    const start = html.indexOf('<div class="topbar">');
    const topbar = html.slice(start, html.indexOf("</div>", start));
    expect(topbar).toContain('id="nav"');
    expect(css).toContain(".nav { order: 2; flex: 1 1 auto; min-width: 0; }");
  });
});
