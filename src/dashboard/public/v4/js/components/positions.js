import { store, t } from "../store.js";
import { money, moneyCompact, pnlWhole, quantity, pctSigned, pnlColor, dur, num, n, pct } from "../fmt.js";
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

/** How far (as a % of the current price) the stop is from here — the thing
 *  an operator scanning the table actually wants ("how much room before this
 *  gets stopped out"), not just the raw stop price. Long: stop sits BELOW
 *  price, so distance = (price − stop) / price. Short: stop sits ABOVE, so
 *  distance = (stop − price) / price. Returns null (never a fabricated %)
 *  when either input isn't a real price — same discipline as positionNotional. */
export function stopDistancePct(currentPrice, stopLoss, isLong) {
  if (!priced(currentPrice) || !priced(stopLoss) || Number(currentPrice) <= 0) return null;
  const price = Number(currentPrice), sl = Number(stopLoss);
  return isLong ? ((price - sl) / price) * 100 : ((sl - price) / price) * 100;
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
 *  checks its gross cap against — CURRENT equity for the momentum sleeves
 *  (MomentumEngine), the allocation for meanrev (MeanRevEngine baseUsd);
 *  dashboard.accounts[].grossCapBase — and that ratio as a share of the
 *  sleeve's configured cap (accounts[].grossCapMult; both registered by
 *  index.ts from each engine's maxGrossExposureMult). Until 2026-10-12 the
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
    rows.push({ id, label: acc?.label || id, notional: bucket.notional, allocation, equity, base, baseKind, ratio, cap, usage, count: bucket.count, unknown: bucket.unknown });
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
 *  cap is known (amber from 90%, red past the cap); without a cap, the old
 *  rule (red at ≥ 1× of the base). */
export function exposureColor(row) {
  if (row.ratio == null) return "var(--muted)";
  if (row.usage != null) return row.usage > 1 ? "var(--down)" : row.usage >= 0.9 ? "var(--warn)" : "var(--text)";
  return row.ratio >= 1 ? "var(--down)" : "var(--text)";
}

// ── Groups: the table is one block per portfolio (owner, 2026-10-25) ───────
// Until then a row of exposure chips ("● MOM-CRY-USD 0.67× /1.15×") sat above
// the table and every row carried a sleeve badge; the owner could not read
// either. Now each portfolio is a block with a header row in plain words —
// "Momentum Stocks  11 positions, $57,021 invested, 0.97× of its capital
// −$1,234" — and the rows beneath carry nothing but their own numbers.

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
    label: g.account?.label || g.id || t("Other", "Otros"),
    invested: g.unknown ? null : g.invested,
    pnl: positionsTotals(g.rows),
    exposure: exposure.get(g.id) || null,
  }));
  return groups.sort((a, b) => (b.invested ?? -1) - (a.invested ?? -1) || (a.id === "" ? 1 : 0) - (b.id === "" ? 1 : 0));
}

/** The exposure phrase of a group header: "0.97× of its capital", plus the
 *  cap only when it is close ("1.10× of its capital, cap 1.15×"), coloured
 *  only then (exposureColor). null when the ratio is unknown (COIN-M). */
export function exposurePhrase(x) {
  if (!x || x.ratio == null) return null;
  const near = x.usage != null ? x.usage >= 0.9 : x.ratio >= 1;
  const capLabel = x.cap == null ? "" : `, ${t("cap", "tope")} ${+x.cap.toFixed(3)}×`;
  return { text: `${num(x.ratio, 2)}× ${t("of its capital", "de su capital")}${near ? capLabel : ""}`, color: near ? exposureColor(x) : null };
}

function groupTitle(g) {
  const x = g.exposure;
  const parts = [];
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
  const count = g.rows.length;
  const bits = [`${count} ${count === 1 ? t("position", "posición") : t("positions", "posiciones")}`];
  if (g.invested != null) bits.push(`${money(g.invested, 0)} ${t("invested", "invertidos")}`);
  const xp = exposurePhrase(g.exposure);
  if (xp) bits.push(xp.color ? `<span style="color:${xp.color}">${esc(xp.text)}</span>` : esc(xp.text));
  const pnl = g.pnl.counted
    ? `<span class="pg-pnl" style="color:${pnlColor(g.pnl.total)}">${pnlWhole(g.pnl.total)}</span>`
    : "";
  // One cell across the row. Its content is sized width:0/min-width:100%
  // (app.css .pgroup-btn) so the sentence never widens the symbol column
  // the way a label in the first cell would (see renderTotalsRow).
  return `<tr class="pgroup"><td colspan="${cols}"><button type="button" class="pgroup-btn" data-pgroup="${esc(g.id)}" aria-expanded="${!collapsed}" title="${esc(groupTitle(g))}">
      <span class="pg-chev" aria-hidden="true"></span><span class="pg-name">${esc(g.label)}</span><span class="pg-sum">${bits.join(", ")}</span>${pnl}
    </button></td></tr>`;
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
  // Same rule for the stop column (2026-10-25): the portfolio-engine rows of
  // momentum_stocks carry no stop of their own, so "—" filled the column.
  const anySl = pos.some((p) => priced(p.stopLoss) && Number(p.stopLoss) > 0);
  // Same rule for the side column (2026-10-12): every live strategy is long
  // only, so "L" on every row was dead width that pushed the SL cell onto two
  // lines. It reappears on its own when a short position exists.
  const isLong = (p) => p.side === "buy" || p.side === "long";
  const anyShort = pos.some((p) => !isLong(p));
  const cols = 7 + (anyShort ? 1 : 0) + (anySl ? 1 : 0) + (anyTp ? 1 : 0);
  const row = (p) => {
    const isL = isLong(p);
    const now = Date.now();
    const held = p.durationSeconds != null ? p.durationSeconds * 1000 : (now - n(p.openedAt, now));
    const acc = accById.get(p.profileId);
    const notional = positionNotional(p, acc);
    const slDist = stopDistancePct(p.currentPrice, p.stopLoss, isL);
    return `<tr class="pos">
      <td><span class="symlink" data-sym="${esc(p.symbol)}" role="button" tabindex="0">${esc(p.symbol)}</span></td>
      ${anyShort ? `<td><span class="badge ${isL ? "l" : "s"}">${isL ? "L" : "S"}</span></td>` : ""}
      <td class="opt3" title="${esc(String(p.quantity ?? ""))}">${quantity(p.quantity)}</td>
      <td class="opt3">${moneyCompact(p.avgEntryPrice)}</td>
      <td>${notional != null
        ? moneyCompact(notional)
        : `<span class="muted" title="${esc(t("COIN-M quantity is a contract count, not units — notional needs the contract size, not carried in this payload", "En COIN-M la cantidad son contratos, no unidades — el nocional necesita el tamaño de contrato, que este dato no trae"))}">—</span>`}</td>
      <td class="opt3">${priced(p.currentPrice) ? moneyCompact(p.currentPrice) : "—"}</td>
      <td>${priced(p.unrealizedPnl)
        ? `<span style="color:${pnlColor(p.unrealizedPnl)}">${pnlWhole(p.unrealizedPnl)} <span class="muted">${pctSigned(p.unrealizedPnlPct)}</span></span>`
        : `<span class="muted" title="${esc(t("No price available — not counted in the total", "Sin precio disponible — no cuenta en el total"))}">—</span>`}</td>
      <td class="opt2">${dur(held)}</td>
      ${anySl ? `<td class="opt1">${p.stopLoss ? `${moneyCompact(p.stopLoss)}${slDist != null ? ` <span class="muted">${pct(slDist, 1)}</span>` : ""}` : "—"}</td>` : ""}
      ${anyTp ? `<td class="opt1">${p.takeProfit ? moneyCompact(p.takeProfit) : "—"}</td>` : ""}
    </tr>`;
  };
  const groups = positionGroups(pos, accounts);
  const body = groups.map((g) => {
    const collapsed = isGroupCollapsed(g.id, g.rows.length, groups.length, state.posGroups);
    return renderGroupHeader(g, collapsed, cols) + (collapsed ? "" : g.rows.map(row).join(""));
  }).join("");
  return `<div class="scroll"><table class="postbl">
    <thead><tr><th>${t("Sym", "Sím")}</th>${anyShort ? "<th>S</th>" : ""}<th class="opt3">${t("Qty", "Cant.")}</th><th class="opt3">${t("Entry", "Entrada")}</th>
      <th title="${esc(t("Quantity \u00d7 entry price — the $ actually deployed. \u2014 for COIN-M (contracts, not units)", "Cantidad \u00d7 precio de entrada — el $ realmente invertido. \u2014 en COIN-M (contratos, no unidades)"))}">${t("Notional", "Nocional")}</th>
      <th class="opt3">${t("Now", "Ahora")}</th><th>P&L</th><th class="opt2">${t("Time", "Tiempo")}</th>
      ${anySl ? `<th class="opt1" title="${esc(t("Stop price · distance from the current price to the stop", "Precio de stop · distancia desde el precio actual al stop"))}">SL</th>` : ""}
      ${anyTp ? `<th class="opt1">TP</th>` : ""}</tr></thead>
    <tbody>${body}</tbody>
    ${renderTotalsRow(pos, anyTp, anyShort, anySl)}</table></div>`;
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

function renderTotalsRow(positions, anyTp, anyShort = true, anySl = true) {
  const { total, counted, unpriced } = positionsTotals(positions);
  if (!counted) return "";
  const note = unpriced > 0
    ? ` <span class="muted">· ${unpriced} ${t("unpriced", "sin precio")}</span>`
    : "";
  // One cell per column (not a colspan over the Qty/Entry/Now columns): on
  // narrow screens those columns are display:none, and a colspan="6" then
  // spilled past the visible columns and pushed the total off-screen.
  // Short label (the long form rides in the title): with the side column
  // hidden it sits in the symbol column alone, and "Total unrealized · 21
  // positions" forced that column to ~200px — the table then needed a
  // sideways scroll (2026-10-12).
  const what = `${counted} ${counted === 1 ? t("position", "posición") : t("positions", "posiciones")}`;
  return `<tfoot><tr class="totals">
    <td colspan="${anyShort ? 2 : 1}" title="${esc(t("Total unrealized P&L", "P&L no realizado total"))} · ${esc(what)}">${t("Unrealized", "No realizado")} <span class="muted">· ${counted}${note}</span></td>
    <td class="opt3"></td><td class="opt3"></td><td></td><td class="opt3"></td>
    <td style="color:${pnlColor(total)}">${pnlWhole(total)}</td>
    <td class="opt2"></td>${anySl ? `<td class="opt1"></td>` : ""}${anyTp ? `<td class="opt1"></td>` : ""}
  </tr></tfoot>`;
}
