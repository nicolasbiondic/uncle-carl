// ── strategy-chart.js — the pure parts of a strategy's column on the Overview
// board (board.js): its figures (the server's display reader, read, never
// recomputed), its 30-day curve, its positions as bars sorted by dollars with
// one scale per strategy and a zero line placed by the data, and the words.
// Everything that builds words, order or geometry is a pure exported function.
import { t } from "../store.js";
import { money, moneyCompact, pnlWhole, pctSentence, pnlColor, quantity, unitPrice, etDate } from "../fmt.js";
import { esc } from "../ui.js";
import { symbolCell, symbolLabel, shortHint } from "../symbol-cell.js";
import { marketNotional, groupOutcome, outcomeWords, holdProgress, holdText } from "./positions.js";

/** A value is usable only if it is a real number (null / "" would coerce to 0). */
const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

export const CURVE_DAYS = 30;
export const MIN_SIDE = 15;     // % of the bar track a side keeps, however lopsided the block
export const MIN_BAR = 1.5;     // % of the track: a tiny result is still a sliver

// ── figures: the server's, read, never recomputed ───────────────────────────

/** The block's figures from GET /api/equity/history?account=<id>&days=30: the
 *  value now, the change over the window and its % are the reader's (the last
 *  row's `moneyWindow`, null when the reader has none); `values` is the series
 *  the curve draws, whose last − first is that same change. null without a
 *  window or without a series: no curve, no figure, nothing false. */
export function strategyFigures(history) {
  const rows = Array.isArray(history) ? history.filter((r) => isNum(r?.equity) && isNum(r?.snapshot_time)) : [];
  const w = Array.isArray(history) ? history.at(-1)?.moneyWindow : null;
  if (!w || !isNum(w.equity) || !isNum(w.pnl) || rows.length < 2) return null;
  return {
    value: Number(w.equity), pnl: Number(w.pnl), pct: isNum(w.pnlPct) ? Number(w.pnlPct) : null,
    values: rows.map((r) => Number(r.equity)), times: rows.map((r) => Number(r.snapshot_time)),
  };
}

/** "▲ +$1,204 (+2.5 %) in 30 days" / "▼ −$310 (−0.6 %) in 30 days"; "—" with no figure.
 *  The % only when the reader gives one. { glyph, text, color }. */
export function deltaWords(fig) {
  if (!fig) return { glyph: "", text: "—", color: "var(--muted)" };
  const up = fig.pnl >= 0;
  const amount = `${pnlWhole(fig.pnl)}${fig.pct != null ? ` (${pctSentence(fig.pct, true)})` : ""}`;
  return { glyph: up ? "▲" : "▼", text: `${amount} ${t(`in ${CURVE_DAYS} days`, `en ${CURVE_DAYS} días`)}`, color: pnlColor(fig.pnl) };
}

// ── the curve ───────────────────────────────────────────────────────────────

/** Geometry of the curve in a W×H box: the polyline and its area, the y of the
 *  starting value (the dashed line) and the last point (the dot, also as a % of
 *  the box). x is the position in the series (the server already spaces it by
 *  time, and a stock strategy has no nights or weekends). A flat series sits on
 *  the middle. Colour follows the 30-day change. Null under two points. */
export function curveGeometry(values, W = 300, H = 64, pad = 5) {
  const v = (values || []).filter(isNum).map(Number);
  if (v.length < 2) return null;
  const min = Math.min(...v), max = Math.max(...v), range = max - min, N = v.length;
  const X = (i) => (i / (N - 1)) * W;
  const Y = (x) => (range === 0 ? H / 2 : pad + (1 - (x - min) / range) * (H - 2 * pad));
  let line = `M ${X(0).toFixed(1)} ${Y(v[0]).toFixed(1)}`;
  for (let i = 1; i < N; i++) line += ` L ${X(i).toFixed(1)} ${Y(v[i]).toFixed(1)}`;
  const lastY = Y(v[N - 1]);
  return {
    line, area: `${line} L ${W} ${H} L 0 ${H} Z`, baseY: +Y(v[0]).toFixed(1),
    last: { x: W, y: +lastY.toFixed(1), xPct: 100, yPct: +((lastY / H) * 100).toFixed(1) },
    up: v[N - 1] >= v[0], min, max,
  };
}

export function renderCurve(fig) {
  const g = fig && curveGeometry(fig.values);
  if (!g) return "";
  const col = g.up ? "var(--up)" : "var(--down)";
  const first = fig.times[0], last = fig.times.at(-1);
  const title = `${etDate(first)}: ${money(fig.values[0], 0)} → ${etDate(last)}: ${money(fig.values.at(-1), 0)}`;
  return `<div class="pc-plot"><div class="pc-curve" title="${esc(title)}"><svg viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true">
      <path d="${g.area}" fill="${g.up ? "var(--up-soft)" : "var(--down-soft)"}"/>
      <line x1="0" x2="300" y1="${g.baseY}" y2="${g.baseY}" class="pc-base" vector-effect="non-scaling-stroke"/>
      <path d="${g.line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg><i class="pc-dot" aria-hidden="true" style="left:${g.last.xPct}%;top:${g.last.yPct}%;background:${col}"></i></div>
    <div class="pc-axis" aria-hidden="true"><span>${t(`${CURVE_DAYS} days ago`, `hace ${CURVE_DAYS} días`)}</span><span>${t("today", "hoy")}</span></div></div>`;
}

// ── the bars ────────────────────────────────────────────────────────────────

const priced = (p) => isNum(p?.unrealizedPnl);

/** The open positions from the largest gain (in dollars) to the largest loss,
 *  ties by ticker; rows with no result are kept apart, never counted as zero. */
export function sortByResult(rows) {
  const ok = (rows || []).filter(priced).slice().sort((a, b) => Number(b.unrealizedPnl) - Number(a.unrealizedPnl) || String(a.symbol).localeCompare(String(b.symbol)));
  return { priced: ok, unpriced: (rows || []).filter((p) => !priced(p)) };
}

/** One scale per strategy, in DOLLARS: the largest gain fills the gain side and
 *  the largest loss the loss side. The zero line sits where the data puts it
 *  (its distance from the left = largest loss ÷ (largest gain + largest loss)),
 *  each side keeping at least MIN_SIDE % so a block of mostly losers does not
 *  waste half the chart and a lone winner is still readable. */
export function barScale(rows) {
  let maxGain = 0, maxLoss = 0;
  for (const p of rows || []) {
    if (!priced(p)) continue;
    const v = Number(p.unrealizedPnl);
    if (v > 0) maxGain = Math.max(maxGain, v); else if (v < 0) maxLoss = Math.max(maxLoss, -v);
  }
  if (maxGain === 0 && maxLoss === 0) return { maxGain, maxLoss, zero: 50 };
  const gainShare = Math.min(100 - MIN_SIDE, Math.max(MIN_SIDE, (maxGain / (maxGain + maxLoss)) * 100));
  return { maxGain, maxLoss, zero: +(100 - gainShare).toFixed(2) };
}

/** Where a bar sits in the track, as % of its width: `left` and `width`. A gain
 *  starts at the zero line and grows right, a loss ends at it and grows left;
 *  a result of exactly zero has no bar. */
export function barGeometry(pnl, scale) {
  const v = Number(pnl);
  if (!isNum(pnl) || v === 0) return { left: scale.zero, width: 0 };
  if (v > 0) return { left: scale.zero, width: +Math.max(MIN_BAR, (v / scale.maxGain) * (100 - scale.zero)).toFixed(2) };
  const width = +Math.max(MIN_BAR, (-v / scale.maxLoss) * scale.zero).toFixed(2);
  return { left: +(scale.zero - width).toFixed(2), width };
}

const isLong = (p) => p.side === "buy" || p.side === "long";
const resultWord = (v) => (v > 0 ? t("gain", "ganancia") : v < 0 ? t("loss", "pérdida") : t("flat", "sin cambio"));
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** The row's hover card (the board paints it the moment the pointer is on the row: board.js): everything the
 *  row does not say. { name, sub, lines: [[label, value, tone]], note }: the plain name with its ticker (and, on
 *  a short, what a short is); the result since entry with its %, the position's value, the entry price, the
 *  price now, the quantity; then the time it has left. `tone` ("up" | "down" | "") colours the result, which
 *  always carries its sign. A row with no price says so instead of a result. */
export function rowTip(p, account, now = Date.now()) {
  const label = symbolLabel(p.symbol), short = !isLong(p);
  const sub = [label ? p.symbol : "", short ? `${t("short", "corto")}: ${lowerFirst(shortHint())}` : ""].filter(Boolean).join(" · ");
  const lines = [];
  if (priced(p)) {
    const v = Number(p.unrealizedPnl);
    lines.push([t("Since entry", "Sin cerrar"), `${pnlWhole(v)}${isNum(p.unrealizedPnlPct) ? ` (${pctSentence(p.unrealizedPnlPct)})` : ""}`, v > 0 ? "up" : v < 0 ? "down" : ""]);
  }
  const value = marketNotional(p, account);
  if (value != null) lines.push([t("Value", "Valor"), moneyCompact(value), ""]);
  lines.push([t("Entry price", "Precio de entrada"), unitPrice(p.avgEntryPrice), ""]);
  lines.push([t("Price now", "Precio ahora"), unitPrice(p.currentPrice), ""]);
  // a short's quantity arrives negative from some brokers: the card already says "short", the amount is the amount
  lines.push([t("Quantity", "Cantidad"), quantity(isNum(p.quantity) ? Math.abs(Number(p.quantity)) : p.quantity), ""]);
  const h = holdProgress(p, account, now);
  const note = [h ? holdText(h) : "", priced(p) ? "" : t("No price available: not counted in the total", "Sin precio disponible: no cuenta en el total")].filter(Boolean).join(" · ");
  return { name: label || p.symbol, sub, lines, note };
}

/** One position as a line of the board: the ticker (it opens the candle chart) with its plain name and a
 *  short's tag, the bar in dollars on the strategy's one scale, the result. The detail rides in `data-tip`
 *  (rowTip, as JSON) for the board's hover card; the row has no browser tooltip of its own. */
export function renderBarRow(p, scale, account, now) {
  const tip = esc(JSON.stringify(rowTip(p, account, now)));
  const sym = symbolCell(p.symbol, { short: !isLong(p), hints: false });
  if (!priced(p)) {
    return `<div class="pc-row" data-tip="${tip}"><span class="pc-sym">${sym}</span><span class="pc-track" aria-hidden="true"></span><span class="pc-amt muted">—</span></div>`;
  }
  const v = Number(p.unrealizedPnl), g = barGeometry(v, scale);
  const bar = g.width ? `<i class="pc-bar" style="left:${g.left}%;width:${g.width}%;background:${pnlColor(v)}"></i>` : "";
  return `<div class="pc-row" data-tip="${tip}"><span class="pc-sym">${sym}</span><span class="pc-track" aria-hidden="true"><i class="pc-zero" style="left:${scale.zero}%"></i>${bar}</span><span class="pc-amt" style="color:${pnlColor(v)}"><span class="vh">${resultWord(v)} </span>${pnlWhole(v)}</span></div>`;
}

// ── words ───────────────────────────────────────────────────────────────────

const positionsWord = (n) => `${n} ${n === 1 ? t("position", "posición") : t("positions", "posiciones")}`;

/** The result part of a sentence: "−$623 since entry (−0.9 %)" / "sin cerrar −$623 (−0.9 %)". */
export function resultWords(pnl) {
  if (!pnl?.counted) return "";
  const amount = `${pnlWhole(pnl.total)}${pnl.pct != null ? ` (${pctSentence(pnl.pct, true)})` : ""}`;
  return t(`${pnlWhole(pnl.total)} since entry${pnl.pct != null ? ` (${pctSentence(pnl.pct, true)})` : ""}`, `sin cerrar ${amount}`);
}

/** "11 positions open · −$623 since entry (−0.9 %)" — { lead, result }, the
 *  result part is coloured by the caller. */
export function blockSentence(rows, pnl) {
  if (!rows.length) return { lead: t("No positions open", "Sin posiciones abiertas"), result: "" };
  return { lead: t(`${positionsWord(rows.length)} open`, `${positionsWord(rows.length)} ${rows.length === 1 ? "abierta" : "abiertas"}`), result: resultWords(pnl) };
}

/** The card's one line, in its parts: "53 positions open" · "+$148 since entry
 *  (+0.1 %)" · "30 up, 23 down" · "2 unpriced". */
export function footerParts(rows, pnl) {
  if (!rows.length) return null;
  return {
    lead: blockSentence(rows, pnl).lead, result: resultWords(pnl), words: outcomeWords(groupOutcome(rows)),
    unpriced: pnl?.unpriced > 0 ? `${pnl.unpriced} ${t("unpriced", "sin precio")}` : "",
  };
}

/** The same as one plain sentence: "53 positions open · +$148 since entry (+0.1 %) · 30 up, 23 down". */
export function footerSentence(rows, pnl) {
  const f = footerParts(rows, pnl);
  return f ? [f.lead, f.result, f.words, f.unpriced].filter(Boolean).join(" · ") : "";
}

