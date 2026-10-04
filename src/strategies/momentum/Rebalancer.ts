// ══════════════════════════════════════════════
// Rebalancer (v7.0 — "Momentum Edge")
// ══════════════════════════════════════════════
//
// Pure rebalancing logic: given (a) the current open positions and (b) the
// target portfolio according to the momentum scorer, compute the minimum set
// of CLOSE and OPEN orders required to transition.
//
// We minimise turnover deliberately: if a symbol is in the new long set AND
// already held long, we keep it (no churn, no extra fees). Same-side hold-
// overs preserve the entry price — the scorer doesn't trigger a fresh entry
// just because the rank order shuffled around it.

import type { TSMDecision } from "./TimeSeriesMomentum";
import { SLOT_DISPLACED_CLOSE_REASON } from "./MomentumEngine";

export interface CurrentPosition {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  notional: number;
}

export interface RebalanceAction {
  type: "close" | "open";
  symbol: string;
  side: "buy" | "sell";
  notionalTarget?: number; // for open
  reason: string;
  /** Canonical telemetry label for closes (today only
   *  SLOT_DISPLACED_CLOSE_REASON — a held position ranked out of the top-N
   *  while its own signal was still valid). The engine forwards it to the
   *  adapter's closePosition; absent → default rebalance label. */
  closeReason?: string;
}

export interface RebalancePlan {
  actions: RebalanceAction[];
  /** Symbols held that survived the rebalance (no action needed). */
  unchanged: string[];
}

export interface RebalanceInput {
  /** TSMDecision extends MomentumDecision with only optional fields, so
   *  plain MomentumDecision[] callers still type-check unchanged. */
  decisions: TSMDecision[];
  currentPositions: CurrentPosition[];
  /** Notional capital to allocate per slot (USD). Caller decides this. */
  notionalPerSlot: number;
  /** Optional per-symbol notional override (vol-targeted sizing). Falls back to notionalPerSlot. */
  notionalBySymbol?: Map<string, number>;
}

/**
 * Returns the minimal set of actions to move from current portfolio to target.
 *
 *  - A current position whose symbol is no longer in the target set → close.
 *  - A current position whose symbol is in target but on the OPPOSITE side
 *    → close (caller can chain a fresh open if desired; we don't atomically
 *    reverse to keep the contract simple).
 *  - A target slot not currently held → open.
 *  - A current position matching target side → leave untouched.
 */
export function planRebalance(input: RebalanceInput): RebalancePlan {
  const actions: RebalanceAction[] = [];
  const unchanged: string[] = [];

  // Build a map of target symbol → desired side.
  const targets = new Map<string, "buy" | "sell">();
  // Held symbols the ranker marked as slot-displaced (still-valid signal,
  // ranked out of the top-N) — their close gets the canonical telemetry label.
  const displaced = new Set<string>();
  for (const d of input.decisions) {
    if (d.action === "long") targets.set(d.symbol, "buy");
    else if (d.action === "short") targets.set(d.symbol, "sell");
    // flat → not in map
    if (d.displaced === true) displaced.add(d.symbol);
  }

  // 1. Current positions: keep, close, or flip.
  const currentSymbols = new Set<string>();
  for (const pos of input.currentPositions) {
    currentSymbols.add(pos.symbol);
    const targetSide = targets.get(pos.symbol);
    if (!targetSide) {
      actions.push({
        type: "close",
        symbol: pos.symbol,
        side: pos.side,
        reason: displaced.has(pos.symbol)
          ? "held signal still valid — slot displaced by higher-ranked entrant"
          : "symbol no longer in target portfolio",
        // Key only present when displaced — non-displaced actions stay
        // byte-identical to the pre-field shape.
        ...(displaced.has(pos.symbol) ? { closeReason: SLOT_DISPLACED_CLOSE_REASON } : {}),
      });
    } else if (targetSide !== pos.side) {
      actions.push({
        type: "close",
        symbol: pos.symbol,
        side: pos.side,
        reason: `target side flipped from ${pos.side} to ${targetSide}`,
      });
      // Caller must follow up with the fresh open in the same cycle. Below.
    } else {
      unchanged.push(pos.symbol);
    }
  }

  // 2. Targets not currently held → open.
  //    Also, targets that we just flipped (closed above) need to be reopened on the new side.
  const flippedSymbols = new Set(actions.filter(a => {
    const target = targets.get(a.symbol);
    return target && target !== a.side;
  }).map(a => a.symbol));

  for (const [symbol, side] of targets) {
    const alreadyHeld = currentSymbols.has(symbol) && !flippedSymbols.has(symbol);
    if (alreadyHeld) continue;
    actions.push({
      type: "open",
      symbol,
      side,
      notionalTarget: input.notionalBySymbol?.get(symbol) ?? input.notionalPerSlot,
      reason: flippedSymbols.has(symbol) ? "side flip — reopen on new side" : "new target slot",
    });
  }

  return { actions, unchanged };
}
