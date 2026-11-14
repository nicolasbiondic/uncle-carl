import { store, t, sleeveLabel, portfolioName, portfolioLabel } from "../store.js";
import { money, moneyCompact, pnlWhole, quantity, pctWhole, pctSentence, pnlColor, dur } from "../fmt.js";
import { esc } from "../ui.js";
import { symbolCell } from "../symbol-cell.js";
import { renderTrades } from "./trades.js";
import { positionsTotals } from "../money-values.js";
export { positionsTotals } from "../money-values.js";

/** A value is "priced" only if it is a real number. null/undefined/"" coerce
 *  to 0 through Number(), so an unavailable price would render as $0.00 and
 *  read as a fact — the row would claim break-even where we simply do not
 *  know. Shared by the rows and by the totals so both tell the same story. */
function priced(v) {
  if (v === null || v === undefined || v === "") return false;
  return Number.isFinite(Number(v));
}

/** True for the binance_coinm sleeve (momentum_btc today) — the ONLY case
 *  where Position.quantity is a CONTRACT count, not units. `account` is the
 *  matching entry from dashboard.accounts (am.getAccountSummaries()), the
 *  one place `broker` is exposed per sleeve. */
export function isInverseContractSleeve(account) {
  return account?.broker === "binance_coinm";
}

/** Notional deployed at entry = |quantity| * entry price. Returns null
 *  (never a fabricated number) rather than a wrong one:
 *   - COIN-M: quantity is CONTRACTS (each a fixed $ notional via
 *     contractSize, e.g. $100) — quantity*price there is ~4x reality (see
 *     src/executor/binance-coinm-executor.ts positionUsd, the real formula;
 *     it needs contractSize, which this dashboard payload does not carry).
 *   - missing/non-numeric quantity or entry price — a partial row must not
 *     crash the table or silently render $0.
 *  Correct for every OTHER sleeve (stocks and spot-margined crypto), where
 *  quantity is already in real units. */
export function positionNotional(p, account) {
  if (isInverseContractSleeve(account)) return null;
  // null/undefined/"" all coerce to 0 through Number() (same trap `priced()`
  // above guards against) — reject them BEFORE the conversion, or a missing
  // quantity/price would silently render as a fabricated $0 notional.
  if (!priced(p?.quantity) || !priced(p?.avgEntryPrice)) return null;
  return Math.abs(Number(p.quantity)) * Number(p.avgEntryPrice);
}

/** Per-sleeve gross exposure: open notional ÷ the base the sleeve's engine
 *  checks its gross cap against — CURRENT equity for MomentumEngine and the
 *  live portfolio engine, allocation only for the incumbent MeanRevEngine;
 *  dashboard.accounts[].grossCapBase — and that ratio as a share of the
 *  sleeve's configured cap (accounts[].grossCapMult; both registered by
 *  the active engine plan's maxGrossExposureMult / maxGross). Until 2026-10-12 the
 *  ratio was taken over the initial allocation and painted red at ≥ 1×: the
 *  approved 1.5× sizing of momentum_stocks and a USDC sleeve whose equity
 *  grew from $5k to $7.4k both read as alarms at their designed size.
 *  Without a current equity the allocation is the base.
 *  `positions` must already carry `profileId` (see renderPositions) — a
 *  position with none is silently excluded (can't attribute exposure to an
 *  unknown sleeve). A sleeve with ANY unpriceable position (COIN-M) reports
 *  ratio=null rather than an understated ratio from a partial sum. */
export function sleeveExposure(positions, accounts) {
  const accById = new Map((accounts || []).map((a) => [a.id, a]));
  const agg = new Map();
  for (const p of positions || []) {
    const id = p?.profileId;
    if (!id) continue;
    const bucket = agg.get(id) || { notional: 0, unknown: 0, count: 0 };
    const notional = marketNotional(p, accById.get(id));
    if (notional == null) bucket.unknown++; else bucket.notional += notional;
    bucket.count++;
    agg.set(id, bucket);
  }
  const rows = [];
  for (const [id, bucket] of agg) {
    const acc = accById.get(id);
    const allocation = acc && Number.isFinite(Number(acc.initialEquity)) ? Number(acc.initialEquity) : undefined;
    const equity = acc && priced(acc.equity) && Number(acc.equity) > 0 ? Number(acc.equity) : undefined;
    const baseKind = acc?.grossCapBase === "allocation" || equity === undefined ? "allocation" : "equity";
    const base = baseKind === "equity" ? equity : allocation;
    const ratio = base > 0 && bucket.unknown === 0 ? bucket.notional / base : null;
    const cap = acc && priced(acc.grossCapMult) && Number(acc.grossCapMult) > 0 ? Number(acc.grossCapMult) : null;
    const usage = ratio != null && cap != null ? ratio / cap : null;
    rows.push({ id, label: sleeveLabel(acc || { id }), notional: bucket.notional, allocation, equity, base, baseKind, ratio, cap, usage, count: bucket.count, unknown: bucket.unknown });
  }
  return rows.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
}

/** Market value — what the engines' gross-cap check sums (the broker's
 *  current notional) — falling back to the entry price while no current
 *  price is known. Shared by the group header and the Notional column. */
export function marketNotional(p, account) {
  if (isInverseContractSleeve(account) || !priced(p?.quantity)) return null;
  const px = priced(p?.currentPrice) && Number(p.currentPrice) > 0 ? Number(p.currentPrice)
    : priced(p?.avgEntryPrice) ? Number(p.avgEntryPrice) : null;
  return px == null ? null : Math.abs(Number(p.quantity)) * px;
}

/** The ONE rule for "past its limit", whole percent as the sentences show it,
 *  so rounding drift at the limit never turns red (at the limit is the design
 *  size of an always-invested book). Without a known limit: from 100 % of the
 *  capital. Shared by the table's title, exposureColor and the Bot card. */
export function isOverLimit(ratio, cap) {
  if (ratio == null || !Number.isFinite(Number(ratio))) return false;
  if (cap == null || !Number.isFinite(Number(cap)) || Number(cap) <= 0) return Number(ratio) >= 1;
  return Math.round(Number(ratio) * 100) > Math.round(Number(cap) * 100);
}

/** Colour of an exposure ratio: by its share of the sleeve's own cap when the
 *  cap is known (amber from 90%, red past the cap at the displayed 0.01×
 *  precision, not for sub-cent rounding/fill drift); without a cap, the old
 *  rule (red at ≥ 1× of the base). */
export function exposureColor(row) {
  if (row.ratio == null) return "var(--muted)";
  if (row.usage != null) {
    // At the cap is the design size of an always-invested book, not a warning: red only past it.
    return isOverLimit(row.ratio, row.cap ?? row.ratio / row.usage) ? "var(--down)" : "var(--text)";
  }
  return isOverLimit(row.ratio, null) ? "var(--down)" : "var(--text)";
}

// ── Groups: the table is one block per portfolio (owner, 2026-10-25) ───────
// Until then a row of exposure chips ("● MOM-CRY-USD 0.67× /1.15×") sat above
// the table and every row carried a sleeve badge; the owner could not read
// either. Each portfolio is a block with a header row, and since 2026-11-12
// ("que lo pueda entender un humano, no una máquina") the header is a sentence:
// "Mean Reversion Stocks · 32 positions · $50,592 · open +$537 · 21 up, 11 down
// ……… invested 93 % of its capital [bar]". The rows beneath read the same way:
// a name, a value, one diverging bar with its amount, the time left.

/** Groups with more than this many positions start collapsed (only when the
 *  table has more than one group — a lone group collapsed is an empty table). */
export const COLLAPSE_OVER = 12;

/** Whether a group renders collapsed: the reader's last click on its header
 *  (store.posGroups, persisted) wins; otherwise the default rule. Pure. */
export function isGroupCollapsed(id, count, groupCount, stored) {
  const s = stored?.[id];
  if (s === "closed") return true;
  if (s === "open") return false;
  return groupCount > 1 && count > COLLAPSE_OVER;
}

/** Click on a group header: remember the opposite of what is shown now. */
export function togglePositionGroup(id, collapsedNow) {
  const posGroups = { ...(store.state.posGroups || {}), [id]: collapsedNow ? "open" : "closed" };
  store.set({ posGroups });
}

/** Pure: the portfolio groups of a book, biggest invested first. Each group
 *  carries its rows, the $ invested at market (null while any row is
 *  unpriceable — COIN-M), its unrealized total and its exposure row
 *  (sleeveExposure). Rows without a profileId land in one trailing group
 *  with no account (id ""). */
export function positionGroups(positions, accounts) {
  const accById = new Map((accounts || []).map((a) => [a.id, a]));
  const exposure = new Map(sleeveExposure(positions, accounts).map((r) => [r.id, r]));
  const byId = new Map();
  for (const p of positions || []) {
    const id = p?.profileId || "";
    if (!byId.has(id)) byId.set(id, { id, account: accById.get(id), rows: [], invested: 0, unknown: 0 });
    const g = byId.get(id);
    g.rows.push(p);
    const cost = marketNotional(p, g.account);
    if (cost == null) g.unknown++; else g.invested += cost;
  }
  const groups = [...byId.values()].map((g) => ({
    ...g,
    label: portfolioName(portfolioLabel(g.account || { id: g.id })) || t("Other", "Otros"),
    invested: g.unknown ? null : g.invested,
    pnl: positionsTotals(g.rows, { entryAmount: (p) => positionNotional(p, g.account) }),
    exposure: exposure.get(g.id) || null,
  }));
  return groups.sort((a, b) => (b.invested ?? -1) - (a.invested ?? -1) || (a.id === "" ? 1 : 0) - (b.id === "" ? 1 : 0));
}

/** Whole percent with the space the sentences use: 0.934 → "93 %". */
const wholePct = (ratio) => `${Math.round(+(ratio * 100).toFixed(6))} %`; // toFixed: 1.725 × 100 is 172.49999999999997

/** The exposure of a group header in words: "invested 93 % of its capital",
 *  plus " · limit 250 %" when the sleeve's cap is not 100 % — or when it is
 *  past it, so the red always has a word beside it. `body` is the same
 *  without the leading "invested" (the broker modal puts its own label in
 *  front); `usage` is the share of the cap for the bar, coloured only past
 *  the cap (exposureColor). Without a cap the percentage stands alone; null
 *  when the ratio is unknown (COIN-M). */
export function exposurePhrase(x) {
  if (!x || x.ratio == null) return null;
  const color = exposureColor(x) === "var(--down)" ? "var(--down)" : null;
  const showLimit = x.cap != null && (Math.round(x.cap * 100) !== 100 || color != null);
  const body = t(`${wholePct(x.ratio)} of its capital`, `el ${wholePct(x.ratio)} de su capital`)
    + (showLimit ? ` · ${t("limit", "límite")} ${wholePct(x.cap)}` : "");
  return { text: `${t("invested", "invertido")} ${body}`, body, color, usage: x.usage, ratio: x.ratio, cap: x.cap };
}

/** How many rows of a group are up / down / flat since entry (unpriced rows
 *  are in none: like the totals, never counted as break-even). */
export function groupOutcome(rows) {
  let up = 0, down = 0, flat = 0;
  for (const p of rows || []) {
    if (!priced(p?.unrealizedPnl)) continue;
    const v = Number(p.unrealizedPnl);
    if (v > 0) up++; else if (v < 0) down++; else flat++;
  }
  return { up, down, flat };
}

/** "21 up, 11 down" / "21 ganan, 11 pierden" — a zero is left out, 1 agrees. */
export function outcomeWords({ up, down, flat }) {
  const es = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (up) parts.push(t(`${up} up`, es(up, "gana", "ganan")));
  if (down) parts.push(t(`${down} down`, es(down, "pierde", "pierden")));
  if (flat) parts.push(t(`${flat} flat`, `${flat} sin cambio`));
  return parts.join(", ");
}

/** "open −$858 (−1 %)": the result with its weighted % when it is known. */
function openWords(pnl, fine) {
  return `${t("open", "sin cerrar")} ${pnlWhole(pnl.total)}${pnl.pct != null ? ` (${pctSentence(pnl.pct, fine)})` : ""}`;
}

function groupTitle(g, sentence) {
  const x = g.exposure;
  const parts = [`${sentence}.`];
  if (x && x.ratio != null) {
    const baseLabel = x.baseKind === "equity" ? t("current equity", "patrimonio actual") : t("allocation", "asignación");
    parts.push(`${t("Holds", "Tiene")} ${money(x.notional, 0)} ${t("at market against", "a mercado sobre")} ${money(x.base, 0)} ${t("of", "de")} ${baseLabel} (${wholePct(x.ratio)}).`);
    if (x.cap != null) parts.push(`${t("Limit", "Límite")} ${wholePct(x.cap)}.`);
    if (x.allocation) parts.push(`${t("Allocation", "Asignación")} ${money(x.allocation, 0)}.`);
  } else if (x) {
    parts.push(t("Notional unknown: COIN-M quantities are contracts, not units.", "Nocional desconocido: en COIN-M las cantidades son contratos, no unidades."));
  }
  parts.push(t("Click to show or hide its positions.", "Clic para mostrar u ocultar sus posiciones."));
  return parts.join(" ");
}

/** The header is ONE plain sentence, still one clickable row that folds the
 *  group: "Momentum Stocks · 11 positions · $71,762 · open −$623 (−0.9 %)".
 *  The exposure (how much of its capital is invested, its limit) and the
 *  market value against the base ride in the title. */
function renderGroupHeader(g, collapsed, cols) {
  const count = g.rows.length;
  const cnt = `${count} ${count === 1 ? t("position", "posición") : t("positions", "posiciones")}`;
  const valueText = g.invested != null ? money(g.invested, 0) : "";
  const xp = exposurePhrase(g.exposure);
  const open = g.pnl.counted ? openWords(g.pnl, false) : "";
  const sentence = [g.label, cnt, valueText, open, xp?.text].filter(Boolean).join(" · ");
  const pnl = g.pnl.counted
    ? ` <span class="muted">·</span> <span class="pg-pnl" style="color:${pnlColor(g.pnl.total)}">${esc(open)}</span>`
    : "";
  // One cell across the row. Its content is sized width:0/min-width:100%
  // (app.css .pgroup-btn) so the sentence never widens the symbol column
  // the way a label in the first cell would (see renderTotalsRow).
  return `<tr class="pgroup"><td colspan="${cols}"><button type="button" class="pgroup-btn" data-pgroup="${esc(g.id)}" aria-expanded="${!collapsed}" title="${esc(groupTitle(g, sentence))}">
      <span class="pg-chev" aria-hidden="true"></span><span class="pg-name">${esc(g.label)}</span><span class="pg-sum"><span class="muted">·</span> ${cnt}${valueText ? ` <span class="muted">·</span> ${esc(valueText)}` : ""}${pnl}</span>
    </button></td></tr>`;
}

// ── Owner maximum hold (2026-10-26, RW §17): every operation closes at 5 days ─
// The portfolio engines (the stock sleeves) close after 5 NYSE sessions
// (maxHoldSessions, src/portfolio-engine/decide.ts maxHoldExpired: sessions
// strictly AFTER the entry date, closed at the pass of the 5th), the momentum
// engines (crypto) after 120 calendar hours (timeStop.maxHoldHours). The Time
// column shows that clock: a bar of five segments filling with the days the
// position has been held, and "up to N days left". Weekdays stand in for sessions
// (holidays ignored — the owner accepted "good enough"); a row past its limit
// is a pending close.

export const MAX_HOLD_SESSIONS = 5;
export const MAX_HOLD_HOURS = 120;
export const HOLD_SEGMENTS = 5;

/** Crypto rows run on hours, stock rows on sessions. Position.market when the
 *  payload carries it; else the sleeve's broker (binance* = crypto). */
export function isCryptoRow(p, account) {
  if (p?.market === "crypto" || p?.market === "stock") return p.market === "crypto";
  return typeof account?.broker === "string" && account.broker.startsWith("binance");
}

/** Days since the epoch of a timestamp's ET calendar date. */
function etDayNumber(ms) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((x) => x.type === type)?.value);
  return Math.floor(Date.UTC(get("year"), get("month") - 1, get("day")) / 864e5);
}

/** Weekdays strictly after the entry's ET date, up to and including today's
 *  (the count maxHoldExpired makes, without the holiday calendar). */
export function weekdaysSince(openedMs, nowMs) {
  const from = etDayNumber(openedMs), to = etDayNumber(nowMs);
  let count = 0;
  for (let d = from + 1; d <= to; d++) {
    const dow = (d + 4) % 7; // day 0 (1970-01-01) was a Thursday; 0 = Sunday
    if (dow >= 1 && dow <= 5) count++;
  }
  return count;
}

/** Pure: where a position stands on the owner's 5-day clock, or null when its
 *  age is unknown. `days` (0..5) are the days already held — the segments
 *  filled; `remaining` is in the row's unit; `closing` once the limit is
 *  reached (the close is pending). */
export function holdProgress(p, account, nowMs = Date.now()) {
  const opened = priced(p?.openedAt) && Number(p.openedAt) > 0 ? Number(p.openedAt)
    : priced(p?.durationSeconds) ? nowMs - Number(p.durationSeconds) * 1000 : null;
  if (opened == null) return null;
  const heldMs = Math.max(0, nowMs - opened);
  if (isCryptoRow(p, account)) {
    const hours = heldMs / 36e5;
    return { unit: "hours", elapsed: hours, limit: MAX_HOLD_HOURS, remaining: Math.max(0, MAX_HOLD_HOURS - hours), days: Math.min(HOLD_SEGMENTS, Math.floor(hours / 24)), closing: hours >= MAX_HOLD_HOURS, heldMs };
  }
  const sessions = weekdaysSince(opened, nowMs);
  return { unit: "sessions", elapsed: sessions, limit: MAX_HOLD_SESSIONS, remaining: Math.max(0, MAX_HOLD_SESSIONS - sessions), days: Math.min(HOLD_SEGMENTS, sessions), closing: sessions >= MAX_HOLD_SESSIONS, heldMs };
}

/** "up to 4 days left" / "up to 20 h left" (crypto under a day) / "due to
 *  close". The 5-day rule is a ceiling, not an appointment: the portfolio
 *  engines also rotate their oldest lots earlier (maxHoldStagger), a stop can
 *  close a position sooner, and weekdays stand in for NYSE sessions — hence
 *  "up to". Crypto days are rounded UP so segments filled + days left always
 *  make 5. */
export function holdText(h) {
  if (!h) return "—";
  if (h.closing) return t("due to close", "toca cerrar");
  if (h.unit === "hours" && h.remaining < 24) {
    const hrs = Math.max(1, Math.ceil(h.remaining));
    return t(`up to ${hrs} h left`, `le quedan hasta ${hrs} h`);
  }
  const days = h.unit === "hours" ? Math.ceil(h.remaining / 24) : h.remaining;
  return days === 1 ? t("up to 1 day left", "le queda hasta 1 día") : t(`up to ${days} days left`, `le quedan hasta ${days} días`);
}

function holdTitle(h) {
  if (!h) return t("Age unknown", "Antigüedad desconocida");
  const rule = h.unit === "hours" ? `${h.limit} h` : t(`${h.limit} sessions`, `${h.limit} sesiones`);
  return `${t("Held", "Abierta")} ${dur(h.heldMs)} · ${t("limit", "límite")} ${rule} · ${t("Your 5-day rule is the latest a position stays open; the bot can close it earlier (rotation, stop-loss).", "Tu regla de 5 días es lo máximo que una posición sigue abierta; el bot puede cerrarla antes (rotación, stop de pérdida).")}`;
}

function renderHold(h) {
  const segs = Array.from({ length: HOLD_SEGMENTS }, (_, i) => `<i${h && i < h.days ? ' class="on"' : ""}></i>`).join("");
  return `<span class="hold${h?.closing ? " closing" : ""}" title="${esc(holdTitle(h))}"><span class="hseg" aria-hidden="true">${segs}</span><span class="opt2 hold-txt${h?.closing ? "" : " muted"}">${esc(holdText(h))}</span></span>`;
}

// ── Row result: a bar that diverges from a zero line ────────────────────────
/** Fill of a row's result bar as a % of its HALF of the track: |pct| over the
 *  largest |pct| among the rows shown, floored so a tiny move is still a
 *  sliver. 0 for an unknown pct, a flat row or an all-flat table. */
export const PNL_BAR_FLOOR = 8;
export function pnlBarWidth(pct, maxAbsPct) {
  if (!priced(pct) || !(maxAbsPct > 0)) return 0;
  const a = Math.abs(Number(pct));
  if (a === 0) return 0;
  return Math.max(PNL_BAR_FLOOR, Math.min(100, (a / maxAbsPct) * 100));
}

/** Losses grow to the left of the zero line in the loss colour, gains to the
 *  right in the gain colour. Decoration only (aria-hidden): the sign, the
 *  amount and the word carry the meaning. */
function renderDivergingBar(p, maxAbsPct) {
  const width = +pnlBarWidth(p.unrealizedPnlPct, maxAbsPct).toFixed(1);
  const loss = Number(p.unrealizedPnl) < 0;
  const fill = width ? `<i style="width:${width}%;background:${pnlColor(p.unrealizedPnl)}"></i>` : "";
  return `<span class="dbar" aria-hidden="true"><span class="dbar-l">${loss ? fill : ""}</span><span class="dbar-r">${loss ? "" : fill}</span></span>`;
}

/** "gain" / "loss" / "flat" for a screen reader: colour is never the only signal. */
function resultWord(pnl) {
  const v = Number(pnl);
  return v > 0 ? t("gain", "ganancia") : v < 0 ? t("loss", "pérdida") : t("flat", "sin cambio");
}

function renderResult(p, maxAbsPct) {
  if (!priced(p.unrealizedPnl)) return `<span class="muted" title="${esc(t("No price available — not counted in the total", "Sin precio disponible — no cuenta en el total"))}">—</span>`;
  const color = pnlColor(p.unrealizedPnl);
  return `<span class="res">${renderDivergingBar(p, maxAbsPct)}<span class="res-amt" style="color:${color}"><span class="vh">${resultWord(p.unrealizedPnl)} </span>${pnlWhole(p.unrealizedPnl)}</span><span class="res-pct muted">${priced(p.unrealizedPnlPct) ? pctWhole(p.unrealizedPnlPct) : "—"}</span></span>`;
}

export function renderPositions(state, trades) {
  // No answer yet is not "no positions": say it could not load.
  if (!state.dashboard) {
    return `<div class="empty"><div class="big">${t("Could not load the positions", "No se pudieron cargar las posiciones")}</div>
      ${t("It will retry in a moment.", "Se reintentará en unos instantes.")}</div>`;
  }
  const rawPos = state.dashboard?.portfolio?.positions || [];
  if (!rawPos.length) {
    // No open positions → surface recently closed trades so the tab is never a
    // dead end (the bot is idle by design when signals are below minScore). The
    // note is a compact left-aligned caption, not a centered hero, so it reads
    // as the header of the table beneath it.
    return `<div style="padding:var(--s2) var(--s3);font-size:var(--t-sm);color:var(--text-2);border-bottom:1px solid var(--border)">${t("No open positions", "Sin posiciones abiertas")} <span style="color:var(--muted)">· ${t("recently closed", "cerrados recientemente")}</span></div>
      ${renderTrades(trades)}`;
  }
  const accounts = state.dashboard?.accounts || [];
  const accById = new Map(accounts.map((a) => [a.id, a]));
  // The consolidated view mixes every sleeve's rows and stamps profileId per
  // row server-side (AccountManager.getConsolidatedState — the only place
  // that's ambiguous). A single-sleeve view has no per-row profileId because
  // every row already belongs to state.view.
  const viewId = state.view;
  const pos = rawPos.map((p) => (p.profileId ? p : (viewId && viewId !== "consolidated" ? { ...p, profileId: viewId } : p)));
  // No strategy currently sets a take-profit (SL-only design) — the column
  // read as always "—" ("dead weight"). Only render it when at least one
  // OPEN row actually carries one, so it reappears on its own if that ever
  // changes instead of needing another UI change.
  const anyTp = pos.some((p) => priced(p.takeProfit) && Number(p.takeProfit) > 0);
  // No side column (2026-11-12): long is the normal case and says nothing; a
  // short carries a small word tag beside its name (symbolCell).
  const isLong = (p) => p.side === "buy" || p.side === "long";
  // Position, Value, Open, Time left (2026-11-12: Entry and Now left the
  // table for the symbol's tooltip and the candle modal; 2026-10-26: QTY and SL
  // went before — the stop is one click away via the symbol).
  const cols = 4 + (anyTp ? 1 : 0);
  const now = Date.now();
  const row = (p, maxAbsPct) => {
    const acc = accById.get(p.profileId);
    const notional = marketNotional(p, acc);
    const symTitle = [
      `${t("Qty", "Cant.")} ${quantity(p.quantity)}`,
      `${t("Entry", "Entrada")} ${priced(p.avgEntryPrice) ? moneyCompact(p.avgEntryPrice) : "—"}`,
      `${t("Now", "Ahora")} ${priced(p.currentPrice) ? moneyCompact(p.currentPrice) : "—"}`,
    ].join(" · ");
    return `<tr class="pos">
      <td>${symbolCell(p.symbol, { title: symTitle, short: !isLong(p) })}</td>
      <td>${notional != null
        ? esc(moneyCompact(notional))
        : `<span class="muted" title="${esc(t("COIN-M quantity is a contract count, not units — notional needs the contract size, not carried in this payload", "En COIN-M la cantidad son contratos, no unidades — el nocional necesita el tamaño de contrato, que este dato no trae"))}">—</span>`}</td>
      <td class="c-res">${renderResult(p, maxAbsPct)}</td>
      <td class="c-time">${renderHold(holdProgress(p, acc, now))}</td>
      ${anyTp ? `<td class="opt1">${p.takeProfit ? esc(moneyCompact(p.takeProfit)) : "—"}</td>` : ""}
    </tr>`;
  };
  const groups = positionGroups(pos, accounts);
  const open = groups.map((g) => ({ g, collapsed: isGroupCollapsed(g.id, g.rows.length, groups.length, state.posGroups) }));
  // The bar scale is the largest |P&L %| among the rows ON SCREEN (folded
  // groups do not shrink the visible bars).
  const maxAbsPct = open.filter((o) => !o.collapsed).flatMap((o) => o.g.rows)
    .reduce((m, p) => (priced(p.unrealizedPnlPct) ? Math.max(m, Math.abs(Number(p.unrealizedPnlPct))) : m), 0);
  const body = open.map(({ g, collapsed }) => renderGroupHeader(g, collapsed, cols) + (collapsed ? "" : g.rows.map((p) => row(p, maxAbsPct)).join(""))).join("");
  return `<div class="scroll"><table class="postbl">
    <thead><tr><th title="${esc(t("Quantity, entry price and current price in each symbol's tooltip", "Cantidad, precio de entrada y precio actual en el tooltip de cada símbolo"))}">${t("Position", "Posición")}</th>
      <th title="${esc(t("Current market value", "Valor actual a mercado"))}">${t("Value", "Valor")}</th>
      <th class="th-res" title="${esc(t("Open, since entry: the gain or loss so far, in dollars and as a percentage of the invested amount. The bar grows left for a loss and right for a gain.", "Sin cerrar, desde la entrada: la ganancia o pérdida hasta ahora, en dólares y como porcentaje de lo invertido. La barra crece a la izquierda si pierde y a la derecha si gana."))}">${t("Open (since entry)", "Sin cerrar")}</th>
      <th class="th-time" title="${esc(t("Your 5-day rule: no position stays open longer — 5 market sessions for stocks, 120 h for crypto — though the bot may close it earlier. The segments fill with the days already held.", "Tu regla de 5 días: ninguna posición sigue abierta más tiempo — 5 sesiones de mercado en acciones, 120 h en cripto — aunque el bot puede cerrarla antes. Los segmentos se llenan con los días que lleva abierta."))}">${t("Time left", "Tiempo")}</th>
      ${anyTp ? `<th class="opt1" title="${esc(t("Price at which the position closes with a gain", "Precio al que la posición se cierra con ganancia"))}">${t("Target", "Objetivo")}</th>` : ""}</tr></thead>
    <tbody>${body}</tbody>
    ${renderTotalsRow(pos, anyTp, accById)}</table></div>`;
}

/** The totals row: the sum of the open positions' since-entry result shown
 *  above, its weighted % (positionsTotals: Σ result ÷ Σ entry amount, NOT an
 *  average of the rows' percentages; absent when any row's entry amount is
 *  unknown, never a partial denominator) and how many are up and down. One
 *  decimal on the %, whole dollars on the money.
 *
 *  Positions whose unrealizedPnl is not a finite number are EXCLUDED and
 *  reported, never coerced to 0: outside market hours (or on a thin tape) a
 *  price can legitimately be unavailable, and silently counting those as
 *  break-even would understate a loss. */
function renderTotalsRow(positions, anyTp, accById) {
  const { total, counted, unpriced, pct } = positionsTotals(positions, {
    entryAmount: (p) => positionNotional(p, accById.get(p.profileId)),
  });
  if (!counted) return "";
  const note = unpriced > 0
    ? ` <span class="muted">· ${unpriced} ${t("unpriced", "sin precio")}</span>`
    : "";
  // One cell across the row, sized like the group headers (width:0 /
  // min-width:100%, app.css .pgroup-btn): a long label in the first cell once
  // forced that column to ~200px and the table needed a sideways scroll
  // (2026-10-12).
  const what = `${counted} ${counted === 1 ? t("position", "posición") : t("positions", "posiciones")}`;
  const result = `${pnlWhole(total)}${pct != null ? ` (${pctSentence(pct, true)})` : ""}`;
  const words = outcomeWords(groupOutcome(positions));
  return `<tfoot><tr class="totals">
    <td colspan="${4 + (anyTp ? 1 : 0)}"><div class="pgroup-btn pg-foot"><span class="pg-foot-l">${t("Open, since entry", "Sin cerrar (desde la entrada)")} <span class="pg-pnl" style="color:${pnlColor(total)}">${esc(result)}</span> <span class="muted">· ${esc(what)}${note}${words ? ` · ${esc(words)}` : ""}</span></span></div></td>
  </tr></tfoot>`;
}
