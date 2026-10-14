import { t } from "../store.js";
import { money, moneySigned, pctSigned, pnlColor, dur, num, n, pct } from "../fmt.js";
import { esc } from "../ui.js";
import { renderTrades } from "./trades.js";
import { dotColor } from "./profiles.js";

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

/** "momentum_crypto_usdc" -> "MOM-CRY-USD". A generic transform (no
 *  hardcoded id table — sleeves come and go, see profiles.js), so it stays
 *  correct for whatever sleeves dashboard.accounts currently lists, and it's
 *  what actually disambiguates a LINK/USD (momentum_crypto) row from a
 *  LINK/USDC (momentum_crypto_usdc) row at a glance. */
export function sleeveBadgeCode(profileId) {
  if (!profileId) return "";
  return String(profileId).split("_").filter(Boolean).map((w) => w.slice(0, 3).toUpperCase()).join("-");
}

function qtyFmt(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  return Number.isInteger(x) ? String(x) : num(x, 4);
}

function sleeveBadge(profileId, account) {
  if (!profileId) return "";
  const label = account?.label || profileId;
  // .sb-t: the code text hides on mid-width desktops (app.css), leaving the
  // colour dot — the exposure chips above double as its legend.
  return ` <span class="sbadge" title="${esc(label)}"><span class="d" style="background:${dotColor(profileId)}"></span><span class="sb-t">${esc(sleeveBadgeCode(profileId))}</span></span>`;
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

function renderExposure(positions, accounts) {
  const rows = sleeveExposure(positions, accounts);
  if (!rows.length) return "";
  const chips = rows.map((r) => {
    // r.unknown > 0 means r.notional is a PARTIAL sum (some rows unpriceable,
    // e.g. COIN-M) — printing it as if it were the sleeve's whole notional
    // would read as "exactly $X deployed" when part of it is simply unknown.
    const notionalLabel = r.unknown > 0 ? "—" : money(r.notional, 0);
    const value = r.ratio == null ? "—" : `${num(r.ratio, 2)}×`;
    // Up to 3 decimals, trailing zeros dropped: the caps are 1.725× / 0.966× /
    // 1.15× (and arrive with float noise, 1.7249999999999999).
    const capLabel = r.cap == null ? "" : `${+r.cap.toFixed(3)}×`;
    const baseLabel = r.baseKind === "equity" ? t("equity", "patrimonio") : t("allocation", "asignación");
    const tip = r.ratio == null
      ? t("Notional unavailable for this sleeve (COIN-M contracts, not units)", "Nocional no disponible para este sleeve (contratos COIN-M, no unidades)")
      : `${r.label}: ${notionalLabel} ${t("deployed on", "invertidos sobre")} ${money(r.base, 0)} ${baseLabel} (${value})`
        + (r.cap != null ? ` · ${t("cap", "tope")} ${capLabel}` : "")
        + (r.allocation ? ` · ${t("allocation", "asignación")} ${money(r.allocation, 0)}` : "");
    return `<div class="mchip xchip" title="${esc(tip)}">
      <span class="d" style="background:${dotColor(r.id)}"></span><span class="l">${esc(sleeveBadgeCode(r.id))}</span><b style="color:${exposureColor(r)}">${value}</b>${r.cap != null ? `<span class="xcap">/ ${capLabel}</span>` : ""}
    </div>`;
  }).join("");
  return `<div class="chips xchips">${chips}</div>`;
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
  const rows = pos.map((p) => {
    const isL = isLong(p);
    const now = Date.now();
    const held = p.durationSeconds != null ? p.durationSeconds * 1000 : (now - n(p.openedAt, now));
    const acc = accById.get(p.profileId);
    const notional = positionNotional(p, acc);
    const slDist = stopDistancePct(p.currentPrice, p.stopLoss, isL);
    return `<tr>
      <td><span class="symlink" data-sym="${esc(p.symbol)}" role="button" tabindex="0">${esc(p.symbol)}</span>${sleeveBadge(p.profileId, acc)}</td>
      ${anyShort ? `<td><span class="badge ${isL ? "l" : "s"}">${isL ? "L" : "S"}</span></td>` : ""}
      <td class="opt3">${qtyFmt(p.quantity)}</td>
      <td class="opt3">${money(p.avgEntryPrice)}</td>
      <td>${notional != null
        ? money(notional, 0)
        : `<span class="muted" title="${esc(t("COIN-M quantity is a contract count, not units — notional needs the contract size, not carried in this payload", "En COIN-M la cantidad son contratos, no unidades — el nocional necesita el tamaño de contrato, que este dato no trae"))}">—</span>`}</td>
      <td class="opt3">${priced(p.currentPrice) ? money(p.currentPrice) : "—"}</td>
      <td>${priced(p.unrealizedPnl)
        ? `<span style="color:${pnlColor(p.unrealizedPnl)}">${moneySigned(p.unrealizedPnl)} <span class="muted">${pctSigned(p.unrealizedPnlPct)}</span></span>`
        : `<span class="muted" title="${esc(t("No price available — not counted in the total", "Sin precio disponible — no cuenta en el total"))}">—</span>`}</td>
      <td class="opt2">${dur(held)}</td>
      <td class="opt1">${p.stopLoss ? `${money(p.stopLoss)}${slDist != null ? ` <span class="muted">${pct(slDist, 1)}</span>` : ""}` : "—"}</td>
      ${anyTp ? `<td class="opt1">${p.takeProfit ? money(p.takeProfit) : "—"}</td>` : ""}
    </tr>`;
  }).join("");
  return `${renderExposure(pos, accounts)}<div class="scroll"><table class="postbl">
    <thead><tr><th>${t("Sym", "Sím")}</th>${anyShort ? "<th>S</th>" : ""}<th class="opt3">${t("Qty", "Cant.")}</th><th class="opt3">${t("Entry", "Entrada")}</th>
      <th title="${esc(t("Quantity \u00d7 entry price — the $ actually deployed. \u2014 for COIN-M (contracts, not units)", "Cantidad \u00d7 precio de entrada — el $ realmente invertido. \u2014 en COIN-M (contratos, no unidades)"))}">${t("Notional", "Nocional")}</th>
      <th class="opt3">${t("Now", "Ahora")}</th><th>P&L</th><th class="opt2">${t("Time", "Tiempo")}</th>
      <th class="opt1" title="${esc(t("Stop price · distance from the current price to the stop", "Precio de stop · distancia desde el precio actual al stop"))}">SL</th>
      ${anyTp ? `<th class="opt1">TP</th>` : ""}</tr></thead>
    <tbody>${rows}</tbody>
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
    <td style="color:${pnlColor(total)}">${moneySigned(total)}</td>
    <td class="opt2"></td><td class="opt1"></td>${anyTp ? `<td class="opt1"></td>` : ""}
  </tr></tfoot>`;
}
