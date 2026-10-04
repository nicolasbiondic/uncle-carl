// ── equity.js — Equity tab: TradingView Lightweight Charts™ BaselineSeries
// (2026-10-02, replaced the hand-rolled SVG curve). See lwchart.js for the
// lazy-load/theme/dispose plumbing shared with candle.js.
import { store, t, periodLabel, isEs } from "../store.js";
import { api } from "../api.js";
import { money, moneySigned, pctSigned, pnlColor, etTime, etDate, n } from "../fmt.js";
import { byId, esc } from "../ui.js";
import { loadChartLib, readThemeColors, baseChartOptions, disposeChart } from "../lwchart.js";

const ET = "America/New_York";

let tip = null;
const tooltip = () => (tip || (tip = Object.assign(document.body.appendChild(document.createElement("div")), { className: "tip" })));

// Holds the live chart instance so a remount (tab switch / theme change /
// window change, all of which replace #anBody's innerHTML — see
// analytics.js loadTab()) can dispose the old one first. A bare module-level
// object (not a chart instance itself) so disposeChart's null-out is visible
// to every holder of `chartRef`.
const chartRef = { chart: null };

/** Tears down the mounted chart, if any. Exported so analytics.js can call
 *  it before rendering a non-equity tab (the DOM node the chart lives in is
 *  about to be discarded either way). Safe to call when nothing is mounted. */
export function destroyEquityChart() { disposeChart(chartRef); }

/** Honesty (2026-10-02, supersedes the old auto-scaled-axis + conditional
 *  area fill): a fill that reads "distance from zero" lies on a compressed
 *  axis (equity $111k–$114k: a 0.5% dip looks like a plunge to zero). A
 *  BaselineSeries anchored at the WINDOW'S OWN FIRST VALUE is honest at any
 *  scale instead — above the anchor renders green (gained since the window
 *  started), below renders red (lost since the window started), and that
 *  reading never depends on where zero is. This is a plain anchor lookup,
 *  deliberately independent of `min`/`max` — see the honesty tests in
 *  equity-chart.test.js ("the anchor never depends on the data's range").
 */
export function baselineAnchor(vals) {
  return Array.isArray(vals) && vals.length ? vals[0] : null;
}

/** Pure: maps /api/equity/history rows (ms epoch, value) to lightweight-
 *  charts series points (seconds epoch). Dedupes same-second collisions by
 *  keeping the LAST one (the payload is already time-ordered), and drops the
 *  rare non-finite row rather than fabricating a point — a real reporting
 *  gap in the payload stays a gap; we don't interpolate across it. */
export function toSeriesPoints(rows) {
  const out = [];
  for (const r of rows || []) {
    const time = Math.floor(n(r.t, NaN) / 1000);
    const value = n(r.v, NaN);
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
    if (out.length && out[out.length - 1].time === time) out[out.length - 1].value = value;
    else out.push({ time, value });
  }
  return out;
}

/** Pure: window header figures — $ change, % change (null when the window's
 *  first point is a synthetic rebase anchor, see database.ts `rebased`),
 *  and direction. */
export function windowChange(vals, rebasedStart) {
  const N = vals.length;
  if (N < 1) return { chg: 0, chgPct: null, up: true };
  const chg = vals[N - 1] - vals[0];
  const chgPct = rebasedStart || !(vals[0] > 0) ? null : (chg / vals[0]) * 100;
  return { chg, chgPct, up: chg >= 0 };
}

/** Axis-tick granularity by selected window (store.state.period: 1=Today,
 *  7/30=days, 0=All): hour → weekday+day → day+month → month. ET timezone
 *  throughout (fmt.js's etTime/etDate reason in ET too) — a UTC axis would
 *  mis-place the Fri 16:00 ET market close this exists to make legible. Also
 *  doubles as the chart's `timeScale.tickMarkFormatter` (wrapped to accept
 *  lightweight-charts' seconds-epoch `time`). */
export function formatAxisTick(ts, period, locale = "en-US") {
  const d = new Date(ts);
  if (period === 1) return d.toLocaleTimeString(locale, { timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false });
  if (period === 7) {
    const wd = d.toLocaleDateString(locale, { timeZone: ET, weekday: "short" });
    const day = d.toLocaleDateString(locale, { timeZone: ET, day: "numeric" });
    return `${wd} ${day}`;
  }
  if (period === 30) return d.toLocaleDateString(locale, { timeZone: ET, day: "numeric", month: "short" });
  return d.toLocaleDateString(locale, { timeZone: ET, month: "short" }); // period 0 = All
}

/** Pure: one time-scale tick label. The library says which boundary the tick
 *  sits on (0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds), so the
 *  label follows the tick, not the window: month (with the year on a year
 *  boundary), day ("vie 2" on 7D, "2 oct" otherwise) or time. Labeling every
 *  tick by the window printed "jue 1 · jue 1" for two ticks of the same day on
 *  7D, and only month names on All (2026-10-02, seen on prod). */
export function equityTickLabel(ts, tickMarkType, period, locale = "en-US") {
  const d = new Date(ts);
  if (tickMarkType === 0) return d.toLocaleDateString(locale, { timeZone: ET, month: "short", year: "numeric" });
  if (tickMarkType === 1) return d.toLocaleDateString(locale, { timeZone: ET, month: "short" });
  if (tickMarkType === 2) return period === 7 ? formatAxisTick(ts, 7, locale) : d.toLocaleDateString(locale, { timeZone: ET, day: "numeric", month: "short" });
  return formatAxisTick(ts, 1, locale);
}

/** Pure: the crosshair's time label — the full ET date plus the time (the
 *  axis ticks are deliberately coarse; the crosshair is where precision goes). */
export function crosshairTimeLabel(ts, period, locale = "en-US") {
  return period === 1 ? formatAxisTick(ts, 1, locale) : `${formatAxisTick(ts, 30, locale)} ${formatAxisTick(ts, 1, locale)}`;
}

/** Pure: the crosshair tooltip's content for one hovered point — value, %
 *  vs the window anchor (null when rebased, same rule as windowChange), and
 *  an ET time label (hour:minute for Today, date otherwise — the same split
 *  fmt.js's rest of the dashboard uses). */
export function tooltipData(v, anchor, ts, period, rebasedStart) {
  const pct = rebasedStart || !(anchor > 0) ? null : (v / anchor - 1) * 100;
  const timeLabel = period === 1 ? etTime(ts) : etDate(ts);
  return { v, pct, timeLabel };
}

/** Pure: BaselineSeries options for one anchor value + theme colors. Shape
 *  (not the color literals) is what matters for honesty — it never reads
 *  `min`/`max`, so it can't degrade back into the old scale-dependent fill. */
export function baselineSeriesOptions(colors, anchor) {
  return {
    baseValue: { type: "price", price: anchor },
    topLineColor: colors.up,
    topFillColor1: colors.upSoft,
    topFillColor2: "transparent",
    bottomLineColor: colors.down,
    bottomFillColor1: "transparent",
    bottomFillColor2: colors.downSoft,
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: true,
  };
}

export async function loadEquity(containerId) {
  destroyEquityChart();
  if (tip) tip.style.opacity = "0";
  const el = byId(containerId);
  if (!el) return;
  const s = store.state;
  const rows = (await api.equityHistory({ account: s.view, days: s.period === 0 ? undefined : s.period, range: s.period === 0 ? "all" : undefined }))
    .filter((r) => Number.isFinite(r.equity) && r.equity > 0)
    .map((r) => ({ v: r.equity, t: r.snapshot_time, rebased: !!r.rebased }));
  if (rows.length < 2) { el.innerHTML = `<div class="empty">${t("Not enough equity data yet", "Aún no hay suficientes datos")}</div>`; return; }

  const vals = rows.map((r) => r.v);
  const rebasedStart = rows[0].rebased;
  const { chg, chgPct, up } = windowChange(vals, rebasedStart);
  const col = up ? "var(--up)" : "var(--down)";
  const pctHtml = chgPct == null ? "" : ` (${pctSigned(chgPct)})`;

  el.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:var(--s3);margin-bottom:var(--s2)">
      <span style="font-size:var(--t-lg);font-weight:800">${money(vals[vals.length - 1], 0)}</span>
      <span style="color:${col}">${moneySigned(chg)}${pctHtml} · ${periodLabel(s.period)}</span></div>
    <div class="lwchart" id="eqChart" style="height:280px;margin-bottom:var(--s3)"></div>`;

  const chartEl = byId("eqChart");
  if (!chartEl) return;
  const points = toSeriesPoints(rows);
  const anchor = baselineAnchor(vals);
  const locale = isEs() ? "es-ES" : "en-US";
  const period = s.period;

  const lib = await loadChartLib();
  // The container/innerHTML above may already have been replaced by a later
  // call (fast tab/period switching) by the time the dynamic import resolves
  // — re-check before touching the DOM or mounting a second chart on a
  // discarded node.
  if (!byId(containerId) || byId("eqChart") !== chartEl || chartRef.chart) return;

  const colors = readThemeColors();
  const chart = lib.createChart(chartEl, {
    ...baseChartOptions(colors),
    localization: {
      locale,
      priceFormatter: (v) => money(v, 0),
      timeFormatter: (time) => crosshairTimeLabel(time * 1000, period, locale),
    },
    timeScale: { ...baseChartOptions(colors).timeScale, tickMarkFormatter: (time, tickMarkType) => equityTickLabel(time * 1000, tickMarkType, period, locale) },
    crosshair: { mode: lib.CrosshairMode.Normal },
  });
  chartRef.chart = chart;
  const series = chart.addSeries(lib.BaselineSeries, baselineSeriesOptions(colors, anchor));
  series.setData(points);
  chart.timeScale().fitContent();

  const tp = tooltip();
  chart.subscribeCrosshairMove((param) => {
    if (!param.time || !param.point || param.point.x < 0) { tp.style.opacity = "0"; return; }
    const d = param.seriesData.get(series);
    const v = d && typeof d.value === "number" ? d.value : (d && d.close);
    if (!Number.isFinite(v)) { tp.style.opacity = "0"; return; }
    const { pct, timeLabel } = tooltipData(v, anchor, param.time * 1000, period, rebasedStart);
    const pctHtml2 = pct == null ? "" : ` <span style="color:${pnlColor(pct)}">${pctSigned(pct, 2)}</span>`;
    tp.innerHTML = `<b>${money(v, 0)}</b>${pctHtml2}<br><span class="tt">${esc(timeLabel)}</span>`;
    tp.style.opacity = "1";
    const rect = chartEl.getBoundingClientRect();
    const tw = tp.offsetWidth, th = tp.offsetHeight;
    const clientX = rect.left + param.point.x, clientY = rect.top + param.point.y;
    tp.style.left = Math.max(6, Math.min(window.innerWidth - tw - 6, clientX - tw / 2)) + "px";
    let ty = clientY + 16; if (ty + th > window.innerHeight - 6) ty = clientY - th - 12;
    tp.style.top = ty + "px";
  });
  chartEl.addEventListener("pointerleave", () => { tp.style.opacity = "0"; });
}
