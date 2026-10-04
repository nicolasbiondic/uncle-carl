export interface PerformanceSummaryInput {
  totalEquity: number;
  realizedPnl: number;
  /** First observed equity from equity_snapshots — the true starting baseline. */
  startingEquity?: number;
  /** True when `startingEquity` came from a DISPLAY history anchor that
   *  required a rebase (or crossed an unclassified/discontinuous boundary)
   *  to reach (see db/database.ts TRANSITION_POLICY). The $ pnl stays
   *  accurate for a real rebase (the offset cancels a real methodology
   *  jump), but the % would divide by a synthetically-shifted base —
   *  suppressed instead of shown. */
  rebased?: boolean;
}

export interface PerformanceSummary {
  equityPnl: number;
  equityPnlPct: number | null;
}

export function buildPerformanceSummary(input: PerformanceSummaryInput): PerformanceSummary {
  // "Since start" = total equity change relative to the very first snapshot.
  // Includes both realized (closed trades) and unrealized (open positions) P&L
  // so the KPI matches the equity curve and broker card equity.
  // Falls back to realized-only if no starting equity anchor is available.
  const base = input.startingEquity ?? (input.totalEquity > 0 ? input.totalEquity : 1);
  const pnl  = input.startingEquity != null
    ? input.totalEquity - input.startingEquity  // full equity delta (realized + unrealized)
    : input.realizedPnl;                         // fallback: closed-trade SQL only

  return {
    equityPnl: pnl,
    equityPnlPct: input.rebased ? null : (base > 0 ? (pnl / base) * 100 : 0),
  };
}
