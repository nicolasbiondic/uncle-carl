import { store, t, sleeveLabel } from "../store.js";
import { money, moneyCompact, pnlWhole, quantity, pctSigned, pnlColor, dur, num } from "../fmt.js";
import { esc } from "../ui.js";
import { renderTrades } from "./trades.js";

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
 *  price is known. The Notional column stays at cost (positionNotional). */
function marketNotional(p, account) {
  if (isInverseContractSleeve(account) || !priced(p?.quantity)) return null;
  const px = priced(p?.currentPrice) && Number(p.currentPrice) > 0 ? Number(p.currentPrice)
    : priced(p?.avgEntryPrice) ? Number(p.avgEntryPrice) : null;
  return px == null ? null : Math.abs(Number(p.quantity)) * px;
}

/** Colour of an exposure ratio: by its share of the sleeve's own cap when the
 *  cap is known (amber from 90%, red past the cap at the displayed 0.01×
 *  precision, not for sub-cent rounding/fill drift); without a cap, the old
 *  rule (red at ≥ 1× of the base). */
export function exposureColor(row) {
  if (row.ratio == null) return "var(--muted)";
  if (row.usage != null) {
    const cap = row.cap ?? row.ratio / row.usage;
    // At the cap is the design size of an always-invested book, not a warning: red only past it.
    return Math.round(row.ratio * 100) > Math.round(cap * 100) ? "var(--down)" : "var(--text)";
  }
  return row.ratio >= 1 ? "var(--down)" : "var(--text)";
}

// ── Groups: the table is one block per portfolio (owner, 2026-10-25) ───────
// Until then a row of exposure chips ("● MOM-CRY-USD 0.67× /1.15×") sat above
// the table and every row carried a sleeve badge; the owner could not read
// either. Now each portfolio is a block with a header row — "Momentum Stocks
// $57,021 · −$1,234 ……… exposure [bar] 0.97× of 2.5×" (since 2026-10-26; the
// sentence "11 positions, $57,021 invested, 0.97× of its capital" became the
// title) — and the rows beneath carry nothing but their own numbers.

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
 *  carries its rows, the $ invested at cost (null while any row is
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
    const cost = positionNotional(p, g.account);
    if (cost == null) g.unknown++; else g.invested += cost;
  }
  const groups = [...byId.values()].map((g) => ({
    ...g,
    label: sleeveLabel(g.account || { id: g.id }) || t("Other", "Otros"),
    invested: g.unknown ? null : g.invested,
    pnl: positionsTotals(g.rows),
    exposure: exposure.get(g.id) || null,
  }));
  return groups.sort((a, b) => (b.invested ?? -1) - (a.invested ?? -1) || (a.id === "" ? 1 : 0) - (b.id === "" ? 1 : 0));
}

/** The exposure of a group header as "1.50× of 2.5×" (ratio over the
 *  engine's base, then the sleeve's cap) with the share of the cap for the
 *  bar; coloured only past the cap (exposureColor). Without a cap the
 *  ratio stands alone; null when the ratio is unknown (COIN-M). */
export function exposurePhrase(x) {
  if (!x || x.ratio == null) return null;
  const text = x.cap == null ? `${num(x.ratio, 2)}×` : `${num(x.ratio, 2)}× ${t("of", "de")} ${+x.cap.toFixed(3)}×`;
  const color = exposureColor(x);
  return { text, color: color === "var(--down)" ? color : null, usage: x.usage };
}

/** The header's exposure bar: used share of the cap over a track, filled in
 *  the phrase's colour (muted while far from the cap), clipped at the cap. */
export function renderExposureBar(xp) {
  if (!xp || xp.usage == null) return "";
  const width = Math.min(100, Math.max(0, xp.usage * 100));
  return `<span class="xbar" aria-hidden="true"><span class="xbar-fill" style="width:${+width.toFixed(1)}%;background:${xp.color || "var(--muted)"}"></span></span>`;
}

function groupTitle(g) {
  const x = g.exposure;
  const count = g.rows.length;
  const parts = [`${count} ${count === 1 ? t("position", "posición") : t("positions", "posiciones")}.`];
  if (x && x.ratio != null) {
    const baseLabel = x.baseKind === "equity" ? t("current equity", "patrimonio actual") : t("allocation", "asignación");
    parts.push(`${t("Holds", "Tiene")} ${money(x.notional, 0)} ${t("at market against", "a mercado sobre")} ${money(x.base, 0)} ${t("of", "de")} ${baseLabel} (${num(x.ratio, 2)}×).`);
    if (x.cap != null) parts.push(`${t("Cap", "Tope")} ${+x.cap.toFixed(3)}×.`);
    if (x.allocation) parts.push(`${t("Allocation", "Asignación")} ${money(x.allocation, 0)}.`);
  } else if (x) {
    parts.push(t("Notional unknown: COIN-M quantities are contracts, not units.", "Nocional desconocido: en COIN-M las cantidades son contratos, no unidades."));
  }
  parts.push(t("Click to show or hide its positions.", "Clic para mostrar u ocultar sus posiciones."));
  return parts.join(" ");
}

function renderGroupHeader(g, collapsed, cols) {
  // Name · $ invested · P&L on the left; the exposure bar on the right. The
  // count and the long sentence ride in the title (the owner reads numbers).
  const bits = [];
  if (g.invested != null) bits.push(esc(money(g.invested, 0)));
  if (g.pnl.counted) bits.push(`<span class="pg-pnl" style="color:${pnlColor(g.pnl.total)}">${pnlWhole(g.pnl.total)}</span>`);
  const xp = exposurePhrase(g.exposure);
  const exp = xp
    ? `<span class="pg-exp"><span class="muted">${t("exposure", "exposición")}</span>${renderExposureBar(xp)}<span class="pg-x"${xp.color ? ` style="color:${xp.color}"` : ""}>${esc(xp.text)}</span></span>`
    : "";
  // One cell across the row. Its content is sized width:0/min-width:100%
  // (app.css .pgroup-btn) so the sentence never widens the symbol column
  // the way a label in the first cell would (see renderTotalsRow).
  return `<tr class="pgroup"><td colspan="${cols}"><button type="button" class="pgroup-btn" data-pgroup="${esc(g.id)}" aria-expanded="${!collapsed}" title="${esc(groupTitle(g))}">
      <span class="pg-chev" aria-hidden="true"></span><span class="pg-name">${esc(g.label)}</span><span class="pg-sum">${bits.join(' <span class="muted">·</span> ')}</span>${exp}
    </button></td></tr>`;
}

// ── Owner maximum hold (2026-10-26, RW §17): every operation closes at 5 days ─
// The portfolio engines (the stock sleeves) close after 5 NYSE sessions
// (maxHoldSessions, src/portfolio-engine/decide.ts maxHoldExpired: sessions
// strictly AFTER the entry date, closed at the pass of the 5th), the momentum
// engines (crypto) after 120 calendar hours (timeStop.maxHoldHours). The Time
// column shows that clock: five dots filling with the position's age and
// "closes in N days". Weekdays stand in for sessions (holidays ignored — the
// owner accepted "good enough"); a row past its limit is a pending close.

export const MAX_HOLD_SESSIONS = 5;
export const MAX_HOLD_HOURS = 120;
export const HOLD_DOTS = 5;

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
 *  age is unknown. `dots` (0..5) fill with the age; `remaining` is in the
 *  row's unit; `closing` once the limit is reached (the close is pending). */
export function holdProgress(p, account, nowMs = Date.now()) {
  const opened = priced(p?.openedAt) && Number(p.openedAt) > 0 ? Number(p.openedAt)
    : priced(p?.durationSeconds) ? nowMs - Number(p.durationSeconds) * 1000 : null;
  if (opened == null) return null;
  const heldMs = Math.max(0, nowMs - opened);
  if (isCryptoRow(p, account)) {
    const hours = heldMs / 36e5;
    return { unit: "hours", elapsed: hours, limit: MAX_HOLD_HOURS, remaining: Math.max(0, MAX_HOLD_HOURS - hours), dots: Math.min(HOLD_DOTS, Math.floor(hours / 24)), closing: hours >= MAX_HOLD_HOURS, heldMs };
  }
  const sessions = weekdaysSince(opened, nowMs);
  return { unit: "sessions", elapsed: sessions, limit: MAX_HOLD_SESSIONS, remaining: Math.max(0, MAX_HOLD_SESSIONS - sessions), dots: Math.min(HOLD_DOTS, sessions), closing: sessions >= MAX_HOLD_SESSIONS, heldMs };
}

/** "closes in 4 days" / "closes in 20 h" (crypto under a day) / "closing".
 *  Crypto days are rounded UP so dots + days always make 5. */
export function holdText(h) {
  if (!h) return "—";
  if (h.closing) return t("closing", "cerrando");
  if (h.unit === "hours" && h.remaining < 24) {
    const hrs = Math.max(1, Math.ceil(h.remaining));
    return t(`closes in ${hrs} h`, `cierra en ${hrs} h`);
  }
  const days = h.unit === "hours" ? Math.ceil(h.remaining / 24) : h.remaining;
  return days === 1 ? t("closes in 1 day", "cierra en 1 día") : t(`closes in ${days} days`, `cierra en ${days} días`);
}

function holdTitle(h) {
  if (!h) return t("Age unknown", "Antigüedad desconocida");
  const rule = h.unit === "hours" ? `${h.limit} h` : t(`${h.limit} sessions`, `${h.limit} sesiones`);
  return `${t("Held", "Abierta")} ${dur(h.heldMs)} · ${t("limit", "límite")} ${rule} · ${t("every operation closes at 5 days (owner rule, 2026-10-26)", "toda operación cierra a los 5 días (regla del dueño, 2026-10-26)")}`;
}

function renderHold(h) {
  const dots = Array.from({ length: HOLD_DOTS }, (_, i) => `<i${h && i < h.dots ? ' class="on"' : ""}></i>`).join("");
  return `<span class="hold" title="${esc(holdTitle(h))}"><span class="hdots" aria-hidden="true">${dots}</span><span class="opt2 hold-txt${h?.closing ? "" : " muted"}">${esc(holdText(h))}</span></span>`;
}

// ── Row P&L bar ─────────────────────────────────────────────────────────────
/** Fill of a row's P&L bar as a % of its track: |pct| over the largest |pct|
 *  among the rows shown, floored so a tiny move is still a sliver. 0 for an
 *  unknown pct, a flat row or an all-flat table. */
export const PNL_BAR_FLOOR = 8;
export function pnlBarWidth(pct, maxAbsPct) {
  if (!priced(pct) || !(maxAbsPct > 0)) return 0;
  const a = Math.abs(Number(pct));
  if (a === 0) return 0;
  return Math.max(PNL_BAR_FLOOR, Math.min(100, (a / maxAbsPct) * 100));
}

function renderPnlBar(p, maxAbsPct) {
  const width = pnlBarWidth(p.unrealizedPnlPct, maxAbsPct);
  return `<span class="pnlbar" aria-hidden="true"><span class="pnlbar-fill" style="width:${+width.toFixed(1)}%;background:${pnlColor(p.unrealizedPnl)}"></span></span>`;
}

export function renderPositions(state, trades) {
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
  // Same rule for the side column (2026-10-12): every live strategy is long
  // only, so "L" on every row was dead width that pushed the SL cell onto two
  // lines. It reappears on its own when a short position exists.
  const isLong = (p) => p.side === "buy" || p.side === "long";
  const anyShort = pos.some((p) => !isLong(p));
  // Sym, Notional, Entry, Now, P&L, Time (2026-10-26: the QTY column moved
  // into the symbol's title and the SL column went away — the owner reads
  // size, P&L and the 5-day clock; the stop is one click away via the symbol).
  const cols = 6 + (anyShort ? 1 : 0) + (anyTp ? 1 : 0);
  const now = Date.now();
  const row = (p, maxAbsPct) => {
    const isL = isLong(p);
    const acc = accById.get(p.profileId);
    const notional = positionNotional(p, acc);
    const symTitle = [
      `${t("Qty", "Cant.")} ${quantity(p.quantity)}`,
      `${t("Entry", "Entrada")} ${priced(p.avgEntryPrice) ? moneyCompact(p.avgEntryPrice) : "—"}`,
      `${t("Now", "Ahora")} ${priced(p.currentPrice) ? moneyCompact(p.currentPrice) : "—"}`,
    ].join(" · ");
    return `<tr class="pos">
      <td><span class="symlink" data-sym="${esc(p.symbol)}" role="button" tabindex="0" title="${esc(symTitle)}">${esc(p.symbol)}</span></td>
      ${anyShort ? `<td><span class="badge ${isL ? "l" : "s"}">${isL ? "L" : "S"}</span></td>` : ""}
      <td>${notional != null
        ? moneyCompact(notional)
        : `<span class="muted" title="${esc(t("COIN-M quantity is a contract count, not units — notional needs the contract size, not carried in this payload", "En COIN-M la cantidad son contratos, no unidades — el nocional necesita el tamaño de contrato, que este dato no trae"))}">—</span>`}</td>
      <td class="opt3">${priced(p.avgEntryPrice) ? moneyCompact(p.avgEntryPrice) : "—"}</td>
      <td class="opt3">${priced(p.currentPrice) ? moneyCompact(p.currentPrice) : "—"}</td>
      <td>${priced(p.unrealizedPnl)
        ? `${renderPnlBar(p, maxAbsPct)}<span style="color:${pnlColor(p.unrealizedPnl)}">${pnlWhole(p.unrealizedPnl)} <span class="muted">${pctSigned(p.unrealizedPnlPct)}</span></span>`
        : `<span class="muted" title="${esc(t("No price available — not counted in the total", "Sin precio disponible — no cuenta en el total"))}">—</span>`}</td>
      <td>${renderHold(holdProgress(p, acc, now))}</td>
      ${anyTp ? `<td class="opt1">${p.takeProfit ? moneyCompact(p.takeProfit) : "—"}</td>` : ""}
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
    <thead><tr><th title="${esc(t("Quantity, entry and current price in each symbol's tooltip", "Cantidad, entrada y precio actual en el tooltip de cada símbolo"))}">${t("Sym", "Sím")}</th>${anyShort ? "<th>S</th>" : ""}
      <th title="${esc(t("Quantity \u00d7 entry price — the $ actually deployed. \u2014 for COIN-M (contracts, not units)", "Cantidad \u00d7 precio de entrada — el $ realmente invertido. \u2014 en COIN-M (contratos, no unidades)"))}">${t("Notional", "Nocional")}</th>
      <th class="opt3">${t("Entry", "Entrada")}</th><th class="opt3">${t("Now", "Ahora")}</th>
      <th title="${esc(t("Unrealized P&L; the bar is the % move against the largest on screen", "P&L no realizado; la barra es el % frente al mayor en pantalla"))}">P&L</th>
      <th title="${esc(t("Owner rule: every operation closes at 5 days — 5 NYSE sessions for stocks, 120 h for crypto. The dots fill with the position's age.", "Regla del dueño: toda operación cierra a los 5 días — 5 sesiones NYSE en acciones, 120 h en cripto. Los puntos se llenan con la antigüedad."))}">${t("Time", "Tiempo")}</th>
      ${anyTp ? `<th class="opt1">TP</th>` : ""}</tr></thead>
    <tbody>${body}</tbody>
    ${renderTotalsRow(pos, anyTp, anyShort)}</table></div>`;
}

/** Sum of unrealized P&L across the open positions shown above.
 *
 *  Deliberately NOT a percentage: the rows' percentages are each relative to
 *  their own entry notional, and averaging them would be meaningless while
 *  looking authoritative. A total % would need the summed cost basis, which
 *  this payload does not carry — so we show the dollar total, which is exact,
 *  and the position count, rather than inventing a denominator.
 *
 *  Positions whose unrealizedPnl is not a finite number are EXCLUDED and
 *  reported, never coerced to 0: outside market hours (or on a thin tape) a
 *  price can legitimately be unavailable, and silently counting those as
 *  break-even would understate a loss. */
export function positionsTotals(positions) {
  let total = 0;
  let counted = 0;
  let unpriced = 0;
  for (const p of positions) {
    // `priced` rejects null/undefined/"" BEFORE Number(): all three coerce to
    // 0, which is finite, so a missing price would sail through as
    // break-even — the exact fabricated zero this function exists to avoid.
    // (Caught by the test on first write; naive Number()+isFinite was wrong.)
    if (priced(p?.unrealizedPnl)) { total += Number(p.unrealizedPnl); counted++; }
    else { unpriced++; }
  }
  return { total, counted, unpriced };
}

function renderTotalsRow(positions, anyTp, anyShort = true) {
  const { total, counted, unpriced } = positionsTotals(positions);
  if (!counted) return "";
  const note = unpriced > 0
    ? ` <span class="muted">· ${unpriced} ${t("unpriced", "sin precio")}</span>`
    : "";
  // One cell per column (not a colspan over the Entry/Now columns): on
  // narrow screens those columns are display:none, and a colspan="6" then
  // spilled past the visible columns and pushed the total off-screen.
  // Short label (the long form rides in the title): with the side column
  // hidden it sits in the symbol column alone, and "Total unrealized · 21
  // positions" forced that column to ~200px — the table then needed a
  // sideways scroll (2026-10-12).
  const what = `${counted} ${counted === 1 ? t("position", "posición") : t("positions", "posiciones")}`;
  return `<tfoot><tr class="totals">
    <td colspan="${anyShort ? 2 : 1}" title="${esc(t("Total unrealized P&L", "P&L no realizado total"))} · ${esc(what)}">${t("Unrealized", "No realizado")} <span class="muted">· ${counted}${note}</span></td>
    <td></td><td class="opt3"></td><td class="opt3"></td>
    <td style="color:${pnlColor(total)}">${pnlWhole(total)}</td>
    <td></td>${anyTp ? `<td class="opt1"></td>` : ""}
  </tr></tfoot>`;
}
