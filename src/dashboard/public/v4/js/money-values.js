// Shared by Telegram and Positions: sum the existing since-entry marks, not
// the period's change. Unpriced rows are never silently counted as zero.
export function positionsTotals(positions) {
  let total = 0, counted = 0, unpriced = 0;
  for (const p of positions || []) {
    const v = p?.unrealizedPnl;
    if (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v))) {
      total += Number(v); counted++;
    } else unpriced++;
  }
  return { total, counted, unpriced };
}

// Round once, identically on every surface (including negative half dollars).
export function signedWholeMoney(value) {
  const v = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `${v < 0 ? "−" : "+"}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
}
