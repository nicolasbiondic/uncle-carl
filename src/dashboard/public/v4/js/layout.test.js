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

  // Owner 2026-10-25: the two portfolios live in the KPI strip (one row), so
  // the broker-card row and the header balance pills are gone for good.
  test("no broker-card row and no header balance pills", () => {
    const main = readFileSync(join(import.meta.dir, "main.js"), "utf-8");
    for (const gone of ["#profiles", ".hdr-brokers", ".pcard", ".pill"]) expect(css).not.toContain(gone);
    expect(html).not.toContain("profiles");
    expect(main).not.toContain('id="profiles"');
  });
});

describe("one summary row", () => {
  test("the strip drops its sparklines first, then the win rate (js/fit.js adds the classes)", () => {
    const spark = css.indexOf(".kpis.fit-1 .pspark { display: none; }");
    const win = css.indexOf('.kpis.fit-2 [data-k="win"] { display: none; }');
    expect(spark).toBeGreaterThan(-1);
    expect(win).toBeGreaterThan(spark);
  });

  test("labels keep sentence case: no all-caps treatment on the KPI cells", () => {
    expect(css).toMatch(/\.kpi \.kl \{[^}]*\}/);
    expect(css.match(/\.kpi \.kl \{[^}]*\}/)?.[0]).not.toContain("uppercase");
  });
});

// ── The Overview is one board, a column per strategy (owner, 2026-11-14) ─────
describe("the Overview board", () => {
  const check = readFileSync(join(import.meta.dir, "../../../../../scripts/dashboard-layout-check.ts"), "utf-8");
  const main = readFileSync(join(import.meta.dir, "main.js"), "utf-8");

  test("locked desktops (≥ 1280 × 700): the board fills the viewport and its columns clip, nothing scrolls", () => {
    const m = css.match(/@media \(min-width: 1280px\) and \(min-height: 700px\) \{ \.bd-wrap \{ flex: 1 1 auto; min-height: 0;[^}]*\} \.bd \{ flex: 1 1 0; min-height: 0; \} \.bc \{ min-height: 0; overflow: hidden; \} \.bc-p-bars \{ flex: 1 1 0; min-height: 0; overflow: hidden; \}/);
    expect(m).not.toBeNull();
    expect(css).not.toMatch(/\.bc[^{]*\{[^}]*overflow(-y)?: (auto|scroll)/);
  });

  test("981–1279 wide: two columns a row, the page scrolls — the viewport lock is released for the Overview only, its own rule stays", () => {
    expect(css).toContain("@media (max-width: 1279px) { .bd { grid-template-columns: repeat(2, minmax(0, 1fr)); } }");
    // … and for a window ≥ 1280 wide but under 700 tall, where a locked column has no room left for its bars.
    expect(css).toMatch(/@media \(min-width: 981px\) and \(max-width: 1279px\), \(min-width: 1280px\) and \(max-height: 699\.98px\) \{ html\[data-page="resumen"\], html\[data-page="resumen"\] body \{ height: auto; overflow: visible; \}/);
    expect(css).toContain("@media (min-width: 981px) and (min-height: 540px) { html, body { height: 100dvh; overflow: hidden; }"); // the lock itself, unchanged
    expect(main).toContain("document.documentElement.dataset.page = page");
  });

  test("a phone: one column a row", () => {
    expect(css).toMatch(/@media \(max-width: 640px\) \{ \.bd \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });

  test("the board is fitted again when its room changes with no repaint (ResizeObserver), and the JS lock equals the CSS one", () => {
    const board = readFileSync(join(import.meta.dir, "components/board.js"), "utf-8");
    expect(board).toContain('export const LOCKED = "(min-width: 1280px) and (min-height: 700px)";');
    expect(board).toContain("new ResizeObserver(");
    expect(board).toMatch(/fitBoard\(host\.querySelector\("\.bd"\)\);\s+watchBoard\(host\.querySelector\("\.bd"\)\);/);
    expect(check).toContain("const locked = viewport.width >= 1280 && viewport.height >= 700;");
    expect(check).toContain("(36 px less room)"); // dashboard:check takes room away and requires a refit
    expect(css).toContain(".pc-more { display: block; flex: 0 0 auto;"); // a line that could shrink would hide an overflow
  });

  test("short of height the column gives up its last action, then the curve's labels (fit-1, fit-2)", () => {
    expect(css).toContain(".bd.fit-1 .bc-last { display: none; }");
    expect(css).toContain(".bd.fit-2 .pc-axis { display: none; }");
    expect(css).toContain(".pc-row[hidden] { display: none; }");
  });

  test("dashboard:check FAILS when anything inside the board scrolls or is clipped, or the page scrolls", () => {
    expect(check).toContain("function boardProblems(locked: boolean)");
    expect(check).toContain("content ${el.scrollHeight} > box ${el.clientHeight}");
    expect(check).toContain('is a scroller');
    expect(check).toContain('if (board.out.length) report[report.length - 1].failures.push(...board.out);');
    expect(check).toContain("capture(\"board\", desktop && !locked)"); // the page may scroll only on 981–1279
  });

  test("no tabs and no Chart | Table switch anywhere: the chart is the Overview, the table is Detail", () => {
    expect(main).not.toContain("data-posview");
    expect(main).toContain('page === "detalle"');
    expect(main).toContain('id="boardHost"');
  });
});
