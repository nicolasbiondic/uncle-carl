// ── One-screen desktop layout (owner, 2026-10-12: "en la pestaña Overview
// tenemos que tener el 100% de alto siempre") ────────────────────────────
// The audit of the same morning raised the viewport lock's height floor to
// 960px; the owner's ~890px window then fell back to page scroll, the
// analytics card grew past an empty left column, and nothing failed. These
// pins keep the lock on every desktop window that can show a table row.
// Browser geometry + screenshots (47 synthetic positions, real scrollbars):
// TMPDIR=/dev/shm nice -n 5 bun run dashboard:check [--ci] [--sizes 1747x892]
// Output: reports/dashboard-layout/ (gitignored); --ci checks desktop Overview.
// Live read-only: --base <url> --login, UC_DASH_USER + UC_DASH_PASSWORD_FILE.
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

  // Owner 2026-10-25: the header balance pills repeat the broker cards, so
  // they show exactly when the cards are hidden — never anywhere else.
  test("the balance pills show only in the window that hides the broker cards", () => {
    expect(css).toMatch(/\.hdr-brokers \{ display: none;/);
    const hide = css.match(/(@media [^{]+) \{ #profiles \{ display: none; \}( \.hdr-brokers \{ display: flex; \})? \}/);
    expect(hide).not.toBeNull();
    expect(hide?.[2]).toBeTruthy(); // same @media block turns the pills on
    // the only rule that makes #profiles display:none is that block
    expect(css.match(/#profiles \{ display: none; \}/g)?.length).toBe(1);
    expect(css.match(/\.hdr-brokers \{ display: flex; \}/g)?.length).toBe(1);
  });
});
