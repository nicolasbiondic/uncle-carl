// ── lwchart.js — shared TradingView Lightweight Charts™ plumbing for
// equity.js and candle.js (2026-10-02, replaces the hand-rolled SVG charts).
//
// LAZY LOAD: the actual library is only ever reached through loadChartLib(),
// called from inside a "mount" function that only runs once a real DOM
// container exists (loadEquity / openCandles). bun:test has no DOM, so it
// never calls those mount functions — importing equity.js/candle.js in a
// test costs nothing beyond this tiny wrapper module. Never a CDN: the CSP
// in src/dashboard/server.ts is `script-src 'self'`; the file is vendored at
// public/v4/vendor/lightweight-charts/ (Apache-2.0 — see LICENSE/NOTICE next
// to it, and vendor-lightweight-charts.test.ts for the pinned checksum).
let libPromise = null;
export function loadChartLib() {
  if (!libPromise) {
    // A failed load (network blip, deploy mid-request) must not be cached:
    // the next mount retries instead of the page staying chart-less until a
    // full reload.
    libPromise = import("../vendor/lightweight-charts/lightweight-charts.standalone.production.mjs")
      .catch((e) => { libPromise = null; throw e; });
  }
  return libPromise;
}

/** Pure: label for one time-scale tick. The library tells which boundary the
 *  tick sits on (tickMarkType: 0 Year, 1 Month, 2 DayOfMonth, 3 Time,
 *  4 TimeWithSeconds); day-or-coarser boundaries get a date, the rest a time.
 *  Formatting every tick as a time printed "04:00 AM" under each day of an
 *  intraday chart and lost the dates (2026-10-02). */
export function tickLabel(ms, tickMarkType, fmtDate, fmtTime) {
  return tickMarkType != null && tickMarkType <= 2 ? fmtDate(ms) : fmtTime(ms);
}

/** Pure: reads the design-system CSS custom properties a chart needs in
 *  order to re-theme itself (dark/terminal/light — tokens.css). `getProp`
 *  defaults to the real getComputedStyle on <html> but accepts any
 *  `(name) => string` so this is testable without a DOM. Called once at
 *  mount and again whenever the theme changes (the analytics card and the
 *  candle modal are both fully re-rendered on theme switch, which remounts
 *  the chart from scratch — see equity.js/candle.js). */
export function readThemeColors(getProp = (name) => getComputedStyle(document.documentElement).getPropertyValue(name)) {
  const v = (name) => String(getProp(name) || "").trim();
  return {
    text: v("--text"),
    muted: v("--muted"),
    border: v("--border"),
    up: v("--up"),
    down: v("--down"),
    upSoft: v("--up-soft"),
    downSoft: v("--down-soft"),
    accent: v("--accent"),
  };
}

/** Pure: chart-wide options shared by the equity and candle charts, derived
 *  from theme colors. `autoSize: true` makes the library own a ResizeObserver
 *  on the container — it keeps the canvas full-size on window resize/mobile
 *  rotation/sidebar toggle with no manual listener for us to leak. Background
 *  is transparent so the chart shows the card's own --card/--bg (themed by
 *  plain CSS, no re-paint needed on theme switch beyond remounting). */
export function baseChartOptions(colors, { rightPriceScaleVisible = true } = {}) {
  return {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: colors.text, fontFamily: "inherit", panes: { separatorColor: colors.border } },
    grid: { vertLines: { color: colors.border }, horzLines: { color: colors.border } },
    rightPriceScale: { borderColor: colors.border, visible: rightPriceScaleVisible },
    timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false },
    // attributionLogo defaults to true in the library — kept ON deliberately:
    // the Apache-2.0 license for Lightweight Charts requires naming
    // TradingView as the product creator, and the built-in logo link is the
    // library's own documented way to satisfy that (see vendor NOTICE).
  };
}

/** Disposes a lightweight-charts instance defensively (double-dispose-safe).
 *  Call this BEFORE creating a new chart in the same container and whenever
 *  the mounting DOM node is about to be discarded (tab switch, theme
 *  re-render, modal close) — the library's `chart.remove()` tears down its
 *  internal ResizeObserver/canvas/listeners; skipping it leaks one per
 *  remount since the detached container keeps no reference of its own. */
export function disposeChart(ref) {
  if (ref && ref.chart) {
    try { ref.chart.remove(); } catch {}
    ref.chart = null;
  }
}
