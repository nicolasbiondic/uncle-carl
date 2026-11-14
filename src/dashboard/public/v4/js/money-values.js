// Shared by Telegram and Positions: sum the existing since-entry marks, not
// the period's change. Unpriced rows are never silently counted as zero.
const usable = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

/** What a row had invested at entry: |quantity| × entry price, or null when
 *  either is missing (never a fabricated number). The same denominator each
 *  row's own % uses (AccountManager pnlOf). A caller that knows more than the
 *  row (COIN-M quantities are contracts, not units) passes its own. */
export function entryAmountOf(p) {
  if (!usable(p?.quantity) || !usable(p?.avgEntryPrice)) return null;
  return Math.abs(Number(p.quantity)) * Number(p.avgEntryPrice);
}

/** `pct` is the weighted result of the counted rows: Σ unrealizedPnl ÷
 *  Σ entry amount × 100, NOT an average of the rows' percentages. It is null
 *  whenever ANY counted row has no usable entry amount (a partial denominator
 *  would overstate the %), and never 0 for unknown. */
export function positionsTotals(positions, { entryAmount = entryAmountOf } = {}) {
  let total = 0, counted = 0, unpriced = 0, entry = 0, entryKnown = true;
  for (const p of positions || []) {
    const v = p?.unrealizedPnl;
    if (usable(v)) {
      total += Number(v); counted++;
      const amount = entryAmount(p);
      if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) entry += amount; else entryKnown = false;
    } else unpriced++;
  }
  return { total, counted, unpriced, pct: counted > 0 && entryKnown && entry > 0 ? (total / entry) * 100 : null };
}

// Round once, identically on every surface (including negative half dollars).
export function signedWholeMoney(value) {
  const v = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `${v < 0 ? "−" : "+"}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
}
