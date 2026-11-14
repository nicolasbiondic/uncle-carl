// ── board.js — the Overview: ONE board, one COLUMN per strategy (owner,
// 2026-11-14: "tengo que poder verlo en una sola vista… acostúmbrate a utilizar
// columnas en vez de solo filas"). Each column tells one strategy's whole story,
// top to bottom:
//   head    its name · its status word with its dot
//   figure  its value now (the big figure) · ▼ −$310 (−0.6 %) in 30 days
//   curve   its value over those 30 days, a dashed line at where it started
//   lines   11 positions open · $71,762 invested [with leverage] · −$623 since entry (−0.9 %)
//   bars    its positions from the largest gain to the largest loss, in dollars
//   bot     the market, when it decided and decides again, its last action, a note
// Nothing scrolls: the bars take the height the column has left (fitBoard) and,
// when they do not all fit, the biggest gains and losses that do plus one quiet
// line "… 3 more · see all" that opens the Detail page for that strategy.
// The value, the change and its % are the server's display reader (curves.js →
// strategy-chart.js strategyFigures); everything else is built by pure functions.
import { store, t, portfolioName, portfolioLabel } from "../store.js";
import { esc } from "../ui.js";
import { money, pnlColor } from "../fmt.js";
import { positionsTotals, outsideStrategies } from "../money-values.js";
import { positionGroups, positionNotional, isOverLimit } from "./positions.js";
import {
  strategyFigures, deltaWords, renderCurve, sortByResult, barScale, renderBarRow, resultWords, footerParts,
} from "./strategy-chart.js";
import { statusOf, chipItemsOf, noteOf, decisionSentence, regimeHtml, lastActionOf } from "./botnow.js";
import { viewChip } from "./viewchip.js";

export const MIN_EDGE = 2;          // never fewer than 2 gains + 2 losses when the strategy has that many
export const WANT_LINES = 6;        // before giving up other lines to make room: about this many bar lines
export const UNLOCKED_ALL = 12;     // phones / tablets (the page scrolls): all of them up to this many, else 5 + 5
export const LEVERAGE_OVER = 1.05;  // invested this far above the strategy's own value reads as "with leverage"

// ── what is in a column ─────────────────────────────────────────────────────

/** The strategies as columns, in the server's order (dashboard.accounts: they
 *  never swap places because one grew); each with its positions (positionGroups'
 *  group, or an empty one). Rows of no known strategy get a last column. A
 *  single-strategy view shows only that one. */
export function boardColumns(state) {
  const accounts = state.dashboard?.accounts || [];
  const viewId = state.view;
  const pos = (state.dashboard?.portfolio?.positions || []).map((p) => (p.profileId ? p : (viewId && viewId !== "consolidated" ? { ...p, profileId: viewId } : p)));
  const groups = new Map(positionGroups(pos, accounts).map((g) => [g.id, g]));
  const cols = accounts.map((a) => groups.get(a.id) || {
    id: a.id, account: a, rows: [], invested: 0, unknown: 0, pnl: positionsTotals([]), exposure: null, label: portfolioName(portfolioLabel(a)),
  });
  if (groups.has("")) cols.push(groups.get(""));
  return viewId && viewId !== "consolidated" ? cols.filter((g) => g.id === viewId) : cols;
}

/** "with leverage": what the strategy has invested is clearly more than its own value. */
export const hasLeverage = (invested, value) => invested != null && Number.isFinite(value) && value > 0 && invested > value * LEVERAGE_OVER;

const positionsWord = (n) => `${n} ${n === 1 ? t("position", "posición") : t("positions", "posiciones")}`;

/** "11 positions open · $71,762 invested" (ES "11 posiciones abiertas · $71,762
 *  invertidos"), "with leverage" / "con apalancamiento" after it when it applies.
 *  { text, leverage }. Nothing invested known (COIN-M): the count alone. */
export function countLine(count, invested, leverage) {
  const lead = t(`${positionsWord(count)} open`, `${positionsWord(count)} ${count === 1 ? "abierta" : "abiertas"}`);
  if (invested == null) return { text: lead, leverage: false };
  const inv = t(`${money(invested, 0)} invested`, `${money(invested, 0)} invertidos`);
  return { text: `${lead} · ${inv}${leverage ? ` ${t("with leverage", "con apalancamiento")}` : ""}`, leverage };
}

/** "… 3 more · see all" / "… 3 más · ver todas". */
export const moreWords = (n) => t(`… ${n} more · see all`, `… ${n} más · ver todas`);

/** How many bar lines of `total` a column shows when it has room for `capacity`
 *  lines: all of them when they fit; else the biggest gains (`top`) and the
 *  biggest losses (`bottom`) that fit beside the "… N more" line, never fewer
 *  than MIN_EDGE of each; a single hidden line is shown instead of a line that
 *  says "1 more". Pure. */
export function pickRows(total, capacity, min = MIN_EDGE) {
  if (total <= capacity) return { top: total, bottom: 0, hidden: 0 };
  const slots = Math.max(capacity - 1, 2 * min);
  const top = Math.max(Math.ceil(slots / 2), min), bottom = Math.max(Math.floor(slots / 2), min);
  if (total - top - bottom <= 1) return { top: total, bottom: 0, hidden: 0 };
  return { top, bottom, hidden: total - top - bottom };
}

/** A column too short even for MIN_EDGE + MIN_EDGE lines (a laptop window with the browser's bars, the news
 *  bar taking its room): as many lines as fit, split between gains and losses, one of them the "… N more"
 *  line; with room for one line, that line alone; with none, nothing (`none`). Never an overflow. Pure. */
export function pickTight(total, capacity) {
  if (capacity <= 0) return { top: 0, bottom: 0, hidden: total, none: true };
  if (total <= capacity) return { top: total, bottom: 0, hidden: 0 };
  const slots = capacity - 1;
  const top = Math.ceil(slots / 2), bottom = Math.floor(slots / 2);
  return { top, bottom, hidden: total - top - bottom };
}

/** The lines a column's bars show out of `total` on a page that scrolls: a
 *  phone never more than 5 + 5 (a "… N more" line even for one), a narrow window
 *  (two columns) all up to UNLOCKED_ALL, else the 5 + 5 biggest. */
export function pickRowsScrolling(total, phone = false) {
  if (phone) return total <= 10 ? { top: total, bottom: 0, hidden: 0 } : { top: 5, bottom: 5, hidden: total - 10 };
  return total <= UNLOCKED_ALL ? { top: total, bottom: 0, hidden: 0 } : pickRows(total, 11);
}

// ── words and markup of the parts ───────────────────────────────────────────

function headPart(g, p) {
  const st = p ? statusOf(p) : null;
  return `<div class="bc-name" title="${esc(g.label)}">${esc(g.label)}</div>${st ? `<div class="bc-status" style="color:${st.color}"><span class="bn-dot" style="background:${st.color}"></span>${esc(st.word)}</div>` : ""}`;
}

function figPart(fig, loading) {
  if (!fig) return loading ? `<div class="bc-value"><span class="skel bc-skel-v"></span></div><div class="bc-delta"><span class="skel bc-skel-d"></span></div>` : `<div class="bc-value muted">—</div><div class="bc-delta muted">—</div>`;
  const d = deltaWords(fig);
  return `<div class="bc-value">${esc(money(fig.value, 0))}</div><div class="bc-delta" style="color:${d.color}"><span aria-hidden="true">${d.glyph}</span> ${esc(d.text)}</div>`;
}

function leverageTitle(g, fig, p) {
  const cap = g.account?.grossCapMult ?? p?.maxGrossX;
  const limit = cap != null && Number(cap) > 0 ? ` ${t(`Its limit is ${Math.round(Number(cap) * 100)} % of its value.`, `Su límite es el ${Math.round(Number(cap) * 100)} % de su valor.`)}` : "";
  return t(`It invests more than its own value: ${money(g.invested, 0)} against ${money(fig.value, 0)}, up to its limit.${limit}`, `Invierte más que su propio valor: ${money(g.invested, 0)} frente a ${money(fig.value, 0)}, hasta su límite.${limit}`);
}

function linesPart(g, fig, p, reasonText) {
  if (!g.rows.length) {
    return `<div class="bc-count">${esc(t("No positions open", "Sin posiciones abiertas"))}</div>${reasonText ? `<div class="bc-why">${esc(reasonText)}</div>` : ""}`;
  }
  const lev = hasLeverage(g.invested, fig?.value);
  const c = countLine(g.rows.length, g.invested, lev);
  const over = p && p.grossX != null && p.maxGrossX != null && isOverLimit(Number(p.grossX), Number(p.maxGrossX));
  const result = resultWords(g.pnl);
  return `<div class="bc-count"${lev ? ` title="${esc(leverageTitle(g, fig, p))}"` : ""}>${esc(c.text)}${over ? `<span class="bc-over"> — ${esc(t("above its limit", "por encima de su límite"))}</span>` : ""}</div>${result ? `<div class="bc-res" style="color:${pnlColor(g.pnl.total)}">${esc(result)}</div>` : ""}`;
}

function barsPart(g, now) {
  if (!g.rows.length) return "";
  const scale = barScale(g.rows), sorted = sortByResult(g.rows);
  const rows = [...sorted.priced, ...sorted.unpriced].map((p) => renderBarRow(p, scale, g.account, now)).join("");
  return `<div class="bc-bars" data-total="${sorted.priced.length + sorted.unpriced.length}">${rows}<button type="button" class="pc-more bc-more" data-seeall="${esc(g.id)}" hidden></button></div>`;
}

function botPart(g, p, o, noReason) {
  if (!p) return "";
  const items = chipItemsOf(p, o);
  const out = [];
  const mkt = items.find((c) => c.kind === "regime");
  if (mkt) out.push(`<div class="bc-mkt">${regimeHtml(mkt)}</div>`);
  const trim = items.find((c) => c.kind === "trim");
  if (trim) out.push(`<div class="bc-trim" title="${esc(trim.title || "")}">${esc(trim.text)}</div>`);
  if (!noReason) for (const c of items.filter((c) => c.kind === "text")) out.push(`<div class="bc-why">${esc(c.text)}</div>`);
  const dec = decisionSentence(p, o);
  if (dec) out.push(`<div class="bc-dec">${esc(dec)}</div>`);
  const last = lastActionOf(p, o.events, o);
  if (last) out.push(`<div class="bc-last" title="${esc(last.title)}">${last.html}</div>`);
  const note = noteOf(p, o);
  if (note) out.push(`<div class="bc-note">${esc(note)}</div>`);
  return out.join("");
}

/** Below this the difference is rounding and timing, not a holding (Telegram's same floor). */
export const OUTSIDE_MIN = 50;

/** "Outside the strategies: $2,720 (Alpaca's initial cash and BTC collateral)":
 *  why the columns do not add up to the total equity above them. Built from the
 *  very figures on screen (the total of the summary strip, each column's value),
 *  so total = the strategies + this, to the dollar. "" while any of them is
 *  unknown, on a single-strategy view, or when the difference is below OUTSIDE_MIN.
 *  Same words as Telegram's digest line. Pure: { text, title } or null. */
export function outsideLine(total, values) {
  const out = outsideStrategies(total, values);
  if (out == null || out <= OUTSIDE_MIN) return null;
  const sum = Math.round(total) - out;
  return {
    text: t(`Outside the strategies: ${money(out, 0)} (Alpaca's initial cash and BTC collateral)`, `Fuera de las estrategias: ${money(out, 0)} (efectivo inicial de Alpaca y garantía en BTC)`),
    title: t(`Total equity ${money(Math.round(total), 0)} = the strategies ${money(sum, 0)} + ${money(out, 0)} outside them`, `Patrimonio ${money(Math.round(total), 0)} = las estrategias ${money(sum, 0)} + ${money(out, 0)} fuera de ellas`),
  };
}

/** The board as data: the ids (stable order), each column's parts as markup and
 *  the one summary line under the board. Pure given `state` (and `o.now`/`o.tz`). */
export function boardModel(state, o = {}) {
  if (!state.dashboard) return { ids: ["…", "…", "…", "…"], skeleton: true, cols: [], foot: "", out: "", chip: "" };
  const now = o.now ?? Date.now();
  const bot = state.botNow, portfolios = Array.isArray(bot?.portfolios) ? bot.portfolios : [];
  const oo = { ...o, now, events: bot?.events || [] };
  const cols = boardColumns(state).map((g) => {
    const p = portfolios.find((x) => x.id === g.id) || null;
    const tried = !!state.curvesTried?.[g.id];
    const fig = strategyFigures(state.curves?.[g.id]);
    const items = p ? chipItemsOf(p, oo) : [];
    const reason = !g.rows.length ? items.find((c) => c.kind === "text")?.text || "" : "";
    return {
      id: g.id,
      parts: {
        head: headPart(g, p),
        fig: figPart(fig, !tried && !fig),
        curve: fig ? renderCurve(fig) : (!tried ? `<div class="pc-plot"><div class="pc-curve"><span class="skel bc-skel-c"></span></div></div>` : ""),
        lines: linesPart(g, fig, p, reason),
        bars: barsPart(g, now),
        bot: botPart(g, p, oo, !!reason),
      },
    };
  });
  const rows = boardColumns(state).flatMap((g) => g.rows);
  const accById = new Map((state.dashboard.accounts || []).map((a) => [a.id, a]));
  const totals = positionsTotals(rows, { entryAmount: (p) => positionNotional(p, accById.get(p.profileId)) });
  const f = footerParts(rows, totals);
  const dot = ` <span class="muted">·</span> `;
  const foot = f ? `${esc(f.lead)}${f.result ? `${dot}<span style="color:${pnlColor(totals.total)};font-weight:600">${esc(f.result)}</span>` : ""}${f.words ? `${dot}${esc(f.words)}` : ""}${f.unpriced ? `${dot}${esc(f.unpriced)}` : ""}` : "";
  const whole = !state.view || state.view === "consolidated";
  const ol = whole ? outsideLine(state.profiles?.[0]?.pnlAggregate?.equity, boardColumns(state).filter((g) => g.id).map((g) => strategyFigures(state.curves?.[g.id])?.value)) : null;
  const out = ol ? `<span title="${esc(ol.title)}">${esc(ol.text)}</span>` : "";
  return { ids: cols.map((c) => c.id), skeleton: false, cols, foot, out, chip: viewChip(state) };
}

const PARTS = ["head", "fig", "curve", "lines", "bars", "bot"];

/** The four parts at the top share their rows with the other columns (app.css,
 *  subgrid), so the figures, the curves and the first bar line up across the
 *  board; the bars and the bot's sentences share what is left of each column
 *  (`.bc-rest`): the sentences take what they need, the bars the rest. */
const TOP_PARTS = ["head", "fig", "curve", "lines"], REST_PARTS = ["bars", "bot"];

function columnHtml(c) {
  const part = (k) => `<div class="bc-p bc-p-${k}" data-part="${k}">${c.parts[k]}</div>`;
  return `<section class="bc" data-id="${esc(c.id)}">${TOP_PARTS.map(part).join("")}<div class="bc-rest">${REST_PARTS.map(part).join("")}</div></section>`;
}

/** The whole board's markup (first paint, or when the set of strategies changed). */
export function renderBoard(model) {
  if (model.skeleton) {
    return `<div class="bd" style="--n:4" data-ids="…" aria-busy="true">${model.ids.map(() => `<section class="bc bc-skel"><span class="skel bc-skel-h"></span><span class="skel bc-skel-v"></span><span class="skel bc-skel-c"></span></section>`).join("")}</div><div class="bd-foot"></div>`;
  }
  return `<div class="bd" style="--n:${model.cols.length || 1}" data-ids="${esc(model.ids.join(","))}">${model.cols.map(columnHtml).join("")}</div><div class="bd-foot"><span id="bdSum">${model.foot}</span><span id="bdChip">${model.chip}</span><span id="bdOut" class="bd-out">${model.out}</span></div>`;
}

// ── painting in place ───────────────────────────────────────────────────────

/** Paint the model into `host`: the whole board the first time (or when the
 *  strategies change), after that only the parts whose markup changed — a price
 *  tick repaints a column's bars, never its curve. Then fit the bars. */
export function paintBoard(host, model) {
  if (!host) return;
  const board = host.querySelector(".bd");
  if (!board || board.dataset.ids !== model.ids.join(",")) {
    host.innerHTML = renderBoard(model);
    for (const c of model.cols) for (const k of PARTS) {
      const el = host.querySelector(`.bc[data-id="${CSS.escape(c.id)}"] [data-part="${k}"]`);
      if (el) el.__h = c.parts[k];
    }
    const sum = host.querySelector("#bdSum"), chip = host.querySelector("#bdChip"), out = host.querySelector("#bdOut");
    if (sum) sum.__h = model.foot;
    if (chip) chip.__h = model.chip;
    if (out) out.__h = model.out;
  } else {
    for (const c of model.cols) {
      const col = board.querySelector(`.bc[data-id="${CSS.escape(c.id)}"]`);
      if (!col) continue;
      for (const k of PARTS) {
        const el = col.querySelector(`[data-part="${k}"]`);
        if (el && el.__h !== c.parts[k]) { el.innerHTML = c.parts[k]; el.__h = c.parts[k]; }
      }
    }
    const sum = host.querySelector("#bdSum");
    if (sum && sum.__h !== model.foot) { sum.innerHTML = model.foot; sum.__h = model.foot; }
    const chip = host.querySelector("#bdChip");
    if (chip && chip.__h !== model.chip) { chip.innerHTML = model.chip; chip.__h = model.chip; }
    const out = host.querySelector("#bdOut");
    if (out && out.__h !== model.out) { out.innerHTML = model.out; out.__h = model.out; }
  }
  fitBoard(host.querySelector(".bd"));
  watchBoard(host.querySelector(".bd"));
}

// ── refit when the room changes without a repaint ───────────────────────────
// The bars are fitted to the height their column has left. That height also
// changes when nothing here repaints: the news bar under the board arrives a
// moment later, the header reflows, a font swaps, a sentence above wraps. The
// first version refitted only on its own repaints and on a window resize, so a
// late change left a column showing one line more than it had room for
// (CI, 2026-11-14: ".bc-bars content 171 > box 169" on a run whose only changes
// were unrelated). Now every bars box is observed: when its height is no longer
// the one the last fit was made for, the board is fitted again. fitBoard is a
// pure function of the layout around the bars, so a refit that changes nothing
// ends the cycle.
const fittedHeight = new WeakMap();
let boardObserver = null, refitQueued = false;

export function watchBoard(board) {
  if (!board || typeof ResizeObserver === "undefined") return;
  boardObserver?.disconnect();
  boardObserver = new ResizeObserver(() => {
    if (refitQueued || !board.isConnected) return;
    const stale = [...board.querySelectorAll(".bc-bars")].some((b) => fittedHeight.get(b) !== b.clientHeight);
    if (!stale) return;
    refitQueued = true;
    requestAnimationFrame(() => { refitQueued = false; if (board.isConnected) fitBoard(board); });
  });
  boardObserver.observe(board);
  for (const b of board.querySelectorAll(".bc-bars")) boardObserver.observe(b);
}

// ── fitting the bars to the column's height (the way js/fit.js fits tables) ──
// Locked layout (≥ 1280 wide, ≥ 700 tall): the board fills the viewport, each
// column's bars box gets what is left, and we show as many lines as fit. Short
// of height, give up in this order: the last-action line (fit-1), the curve's
// two labels (fit-2), then bars down to 2 + 2. A page that scrolls shows all up
// to 12, else 5 + 5.
export const BOARD_STEPS = ["fit-1", "fit-2"];
export const LOCKED = "(min-width: 1280px) and (min-height: 700px)";
export const PHONE = "(max-width: 640px)";

/** Show the first `top` and last `bottom` bar lines of a column, hide the rest, say how many. */
function applyPick(bars, pick, total) {
  const rows = [...bars.querySelectorAll(".pc-row")], more = bars.querySelector(".bc-more");
  rows.forEach((r, i) => { r.hidden = pick.hidden > 0 && i >= pick.top && i < total - pick.bottom; });
  if (more) { more.hidden = pick.hidden === 0 || !!pick.none; if (pick.hidden) more.textContent = moreWords(pick.hidden); }
}

/** Re-fit one board; returns how many give-up steps it needed. */
export function fitBoard(board, locked = matchMedia(LOCKED).matches, phone = matchMedia(PHONE).matches) {
  if (!board) return 0;
  board.classList.remove(...BOARD_STEPS);
  const boxes = [...board.querySelectorAll(".bc-bars")];
  const settle = () => {
    let short = false;
    for (const bars of boxes) {
      const total = Number(bars.dataset.total) || 0;
      applyPick(bars, { top: total, bottom: 0, hidden: 0 }, total); // measure with everything shown
      const first = bars.querySelector(".pc-row");
      const pitch = first ? first.getBoundingClientRect().height : 0;
      const capacity = locked && pitch > 0 ? Math.floor(bars.clientHeight / pitch) : Infinity;
      let pick = locked ? pickRows(total, capacity) : pickRowsScrolling(total, phone);
      applyPick(bars, pick, total);
      // The box is never left overflowing. pickRows keeps at least MIN_EDGE + MIN_EDGE lines, and the count
      // above assumes every line is one pitch tall; when the box cannot hold that (a very short window, a
      // fractional height), show what does fit (pickTight), down to nothing.
      if (locked && bars.scrollHeight > bars.clientHeight + 1) {
        for (let cap = Math.min(capacity, pick.top + pick.bottom + (pick.hidden ? 1 : 0)) - 1; cap >= 0; cap--) {
          pick = pickTight(total, cap);
          applyPick(bars, pick, total);
          if (bars.scrollHeight <= bars.clientHeight + 1) break;
        }
      }
      if (locked && pick.top + pick.bottom + (pick.hidden ? 1 : 0) < Math.min(total, WANT_LINES)) short = true;
    }
    return short;
  };
  let steps = 0;
  while (settle() && steps < BOARD_STEPS.length) board.classList.add(BOARD_STEPS[steps++]);
  for (const bars of boxes) fittedHeight.set(bars, bars.clientHeight); // what this fit was made for (watchBoard)
  return steps;
}
