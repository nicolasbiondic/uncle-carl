// ── candle.js — symbol modal: TradingView Lightweight Charts™ candlesticks
// (2026-10-02, replaced the hand-rolled SVG) + position/trade overlays +
// orderbook & tape for crypto. Opened by clicking any [data-sym] cell.
import { api } from "../api.js";
import { t } from "../store.js";
import { num, etTime, etDate, n, pnlColor, moneySigned, pctSigned } from "../fmt.js";
import { esc, icon } from "../ui.js";
import { trapFocus } from "../focus-trap.js";
import { loadChartLib, readThemeColors, baseChartOptions, disposeChart, tickLabel } from "../lwchart.js";

let root = null, sym = null, tf = "1h";
let release = null;
const TFS = ["15m", "1h", "4h", "1d"];

// Holds the live chart instance so a timeframe switch / symbol switch / modal
// close can dispose the previous one first — same pattern as equity.js's
// chartRef (see lwchart.js disposeChart).
const chartRef = { chart: null };
/** Exported so tests/other code can assert there's nothing left mounted;
 *  also called defensively at the top of load()/close(). */
export function destroyCandleChart() { disposeChart(chartRef); }

// lightweight-charts LineStyle enum values (avoids importing the library at
// module scope just for two integer constants — see loadChartLib's "lazy,
// browser-only" contract): Solid=0, Dotted=1, Dashed=2, LargeDashed=3,
// SparseDotted=4.
const LINE_DASHED = 2;
const LINE_DOTTED = 1;

export async function openCandles(symbol) {
  sym = symbol; close();
  root = document.createElement("div");
  root.className = "cm-backdrop";
  root.innerHTML = `<div class="cm" role="dialog" aria-modal="true" aria-label="${esc(symbol)}">
    <div class="cm-head">
      <b>${esc(symbol)}</b>
      <span class="seg">${TFS.map((x) => `<button class="${x === tf ? "on" : ""}" data-ctf="${x}">${x}</button>`).join("")}</span>
      <span style="flex:1"></span>
      <button class="icn" data-cclose aria-label="${t("Close", "Cerrar")}">${icon("x")}</button>
    </div>
    <div class="cm-body"><div class="cm-chart" id="cmChart"><div class="empty">…</div></div><div class="cm-side" id="cmSide"></div></div></div>`;
  document.body.appendChild(root);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-cclose]")) return close();
    const b = e.target.closest("[data-ctf]");
    if (b) { tf = b.dataset.ctf; root.querySelectorAll("[data-ctf]").forEach((x) => x.classList.toggle("on", x.dataset.ctf === tf)); safeLoad(); }
  });
  document.addEventListener("keydown", escClose);
  release = trapFocus(root);
  await safeLoad();
}
function escClose(e) { if (e.key === "Escape") close(); }
export function close() {
  destroyCandleChart();
  if (root) { root.remove(); root = null; document.removeEventListener("keydown", escClose); release?.(); release = null; }
}

/** Pure: /api/candles bars (ms epoch OHLC) -> lightweight-charts candlestick
 *  series data (seconds epoch). Same dedupe/drop-non-finite discipline as
 *  equity.js's toSeriesPoints — a real gap in the payload (market closed,
 *  no bar) stays a gap rather than getting fabricated. */
export function toCandleData(bars) {
  const out = [];
  for (const b of bars || []) {
    const time = Math.floor(n(b.t, NaN) / 1000);
    const open = n(b.o, NaN), high = n(b.h, NaN), low = n(b.l, NaN), close = n(b.c, NaN);
    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    const point = { time, open, high, low, close };
    if (out.length && out[out.length - 1].time === time) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

// Fallback colors matching tokens.css's dark theme — used only if a caller
// forgets to pass `colors`. Real mounts always pass readThemeColors()'s
// RESOLVED values (see the big comment on closedTradeMarkers below for why
// that matters: these feed <canvas>, which cannot resolve CSS variables).
const DEFAULT_COLORS = { accent: "#4c9cff", up: "#2dd4a0", down: "#f16b6b" };

/** Pure: open-position entry/SL/TP as lightweight-charts price-line options.
 *  `colors` must be RESOLVED colors (readThemeColors()'s output), not CSS
 *  variable references — see closedTradeMarkers' comment. `translate`
 *  defaults to identity-of-first-arg so tests don't need store.js; callers
 *  pass store's `t(en, es)`. */
export function positionPriceLines(positions, colors = DEFAULT_COLORS, translate = (en) => en) {
  const lines = [];
  for (const p of positions || []) {
    const entry = n(p.avgEntryPrice, NaN);
    if (Number.isFinite(entry)) lines.push({ price: entry, color: colors.accent, lineWidth: 1, lineStyle: LINE_DASHED, axisLabelVisible: true, title: translate("entry", "entrada") });
    if (p.stopLoss != null) { const v = n(p.stopLoss, NaN); if (Number.isFinite(v)) lines.push({ price: v, color: colors.down, lineWidth: 1, lineStyle: LINE_DOTTED, axisLabelVisible: true, title: "SL" }); }
    if (p.takeProfit != null) { const v = n(p.takeProfit, NaN); if (Number.isFinite(v)) lines.push({ price: v, color: colors.up, lineWidth: 1, lineStyle: LINE_DOTTED, axisLabelVisible: true, title: "TP" }); }
  }
  return lines;
}

/** Pure: closed trades -> lightweight-charts series markers, one for entry
 *  and one for exit, each labeled with the trade's P&L so a glance at the
 *  chart explains WHY a position was where it was (not just that it was).
 *
 *  `colors` MUST be resolved color values (readThemeColors()'s output —
 *  e.g. "#2dd4a0"), never the literal string "var(--up)": markers/price
 *  lines are drawn on the chart's <canvas>, and `CanvasRenderingContext2D`
 *  does not resolve CSS custom properties — assigning an unresolved
 *  "var(--x)" to a canvas fillStyle is a silent no-op (the browser ignores
 *  the invalid value and keeps whatever fillStyle was last set), which
 *  rendered every marker black in manual verification before this was
 *  caught (2026-10-02). HTML-rendered color (template strings passed to
 *  innerHTML, e.g. equity.js's tooltip) is a different context — real CSS
 *  variables work fine there — so that code intentionally still uses the
 *  "var(--x)" token strings.
 *
 *  `fromSec`/`toSec` (inclusive), when given, drop markers outside the
 *  visible bar range — a trade from 90 days ago shouldn't silently stretch a
 *  1h/last-200-bars chart's time axis back to it. Sorted ascending by time
 *  (createSeriesMarkers requires that). */
export function closedTradeMarkers(trades, colors = DEFAULT_COLORS, { fromSec, toSec } = {}) {
  const inRange = (sec) => Number.isFinite(sec) && (fromSec == null || sec >= fromSec) && (toSec == null || sec <= toSec);
  const markers = [];
  for (const tr of trades || []) {
    const isLong = tr.side === "buy" || tr.side === "long";
    const entrySec = Math.floor(n(tr.entryTime, NaN) / 1000);
    // Entry carries no P&L yet (it isn't realized) — the arrow direction +
    // accent color is the signal; only the exit marker's text shows P&L.
    if (inRange(entrySec)) {
      markers.push({ time: entrySec, position: isLong ? "belowBar" : "aboveBar", color: colors.accent, shape: isLong ? "arrowUp" : "arrowDown", text: "" });
    }
    const exitSec = Math.floor(n(tr.exitTime, NaN) / 1000);
    if (inRange(exitSec)) {
      const pnl = n(tr.pnl, 0);
      markers.push({ time: exitSec, position: isLong ? "aboveBar" : "belowBar", color: pnl >= 0 ? colors.up : colors.down, shape: isLong ? "arrowDown" : "arrowUp", text: moneySigned(pnl, 0) });
    }
  }
  return markers.sort((a, b) => a.time - b.time);
}

/** load() with a visible failure instead of an unhandled rejection (the
 *  chart library or /api/candles can fail; the modal must say so). */
async function safeLoad() {
  try {
    await load();
  } catch (e) {
    destroyCandleChart();
    const box = root?.querySelector("#cmChart");
    if (box) box.innerHTML = `<div class="empty">${t("Chart unavailable", "Gráfico no disponible")}: ${esc(e?.message ?? String(e))}</div>`;
  }
}

async function load() {
  destroyCandleChart();
  const chartBox = root?.querySelector("#cmChart");
  if (!chartBox) return;
  const d = await api.candles(sym, tf);
  if (!root || root.querySelector("#cmChart") !== chartBox) return; // modal closed/replaced while awaiting
  if (!d?.bars?.length) { chartBox.innerHTML = `<div class="empty">${t("No candle data", "Sin datos de velas")}</div>`; return; }
  const positions = d.openPositions || [], trades = d.closedTrades || [];
  chartBox.innerHTML = `<div class="lwchart" id="cdlChart" style="height:330px"></div>` + legend(positions);
  const chartEl = chartBox.querySelector("#cdlChart");
  if (!chartEl) return;

  const data = toCandleData(d.bars);
  const fromSec = data[0].time, toSec = data[data.length - 1].time;
  const lib = await loadChartLib();
  if (!root || root.querySelector("#cdlChart") !== chartEl || chartRef.chart) return; // closed/switched meanwhile

  const colors = readThemeColors();
  const base = baseChartOptions(colors);
  const lwChart = lib.createChart(chartEl, {
    ...base,
    crosshair: { mode: lib.CrosshairMode.Normal },
    timeScale: { ...base.timeScale, tickMarkFormatter: (time, tickMarkType) => tickLabel(time * 1000, tf === "1d" ? 2 : tickMarkType, etDate, etTime) },
    localization: { priceFormatter: (v) => num(v, v < 10 ? 4 : v < 1000 ? 2 : 0) },
  });
  chartRef.chart = lwChart;
  const series = lwChart.addSeries(lib.CandlestickSeries, {
    upColor: colors.up, downColor: colors.down,
    borderUpColor: colors.up, borderDownColor: colors.down,
    wickUpColor: colors.up, wickDownColor: colors.down,
  });
  series.setData(data);
  for (const line of positionPriceLines(positions, colors, t)) series.createPriceLine(line);
  const markers = closedTradeMarkers(trades, colors, { fromSec, toSec });
  if (markers.length) lib.createSeriesMarkers(series, markers);
  lwChart.timeScale().fitContent();

  if (sym.includes("/")) loadSide();
  else if (root) root.querySelector("#cmSide").innerHTML = "";
}

function legend(positions) {
  if (!positions.length) return "";
  return `<div class="chips" style="margin-top:var(--s2)">` + positions.map((p) => {
    const isL = p.side === "buy" || p.side === "long";
    return `<span class="mchip"><span class="l">${esc(p.profileId || "")} ${isL ? "LONG" : "SHORT"}</span><b style="color:${pnlColor(p.unrealizedPnl)}">${moneySigned(p.unrealizedPnl)} (${pctSigned(p.unrealizedPnlPct)})</b></span>`;
  }).join("") + `</div>`;
}

async function loadSide() {
  const side = root?.querySelector("#cmSide");
  if (!side) return;
  const [ob, tape] = await Promise.all([api.orderbook(sym), api.tape(sym)]);
  let html = "";
  if (ob?.bids?.length) {
    const maxQ = Math.max(...ob.bids.map((b) => n(b[1])), ...ob.asks.map((a) => n(a[1])), 0.0001);
    const row = (p, q, col) => `<div class="ob-row"><span class="ob-bar" style="width:${Math.min(100, n(q) / maxQ * 100)}%;background:${col === "var(--up)" ? "var(--up-soft)" : "var(--down-soft)"}"></span><span style="color:${col}">${num(n(p), n(p) < 10 ? 4 : 2)}</span><span>${num(n(q), 3)}</span></div>`;
    html += `<div class="card-note">${t("Order book", "Libro de órdenes")}</div><div class="ob">` +
      [...ob.asks].slice(0, 8).reverse().map((a) => row(a[0], a[1], "var(--down)")).join("") +
      `<div class="ob-mid"></div>` +
      ob.bids.slice(0, 8).map((b) => row(b[0], b[1], "var(--up)")).join("") + `</div>`;
  }
  if (Array.isArray(tape) && tape.length) {
    html += `<div class="card-note" style="margin-top:var(--s3)">${t("Tape", "Cinta")}</div><div class="tape">` +
      tape.slice(0, 16).map((x) => `<div class="ob-row"><span style="color:${x.m ? "var(--down)" : "var(--up)"}">${num(n(x.p), n(x.p) < 10 ? 4 : 2)}</span><span>${num(n(x.q), 3)}</span><span class="muted">${etTime(x.T).replace(/\s?[AP]M/, "")}</span></div>`).join("") + `</div>`;
  }
  side.innerHTML = html || `<div class="muted" style="font-size:var(--t-xs)">${t("No microstructure data", "Sin datos de microestructura")}</div>`;
}
