// ══════════════════════════════════════════════
// Pre-trade slippage estimation from REAL book depth (2026-08-03)
// ══════════════════════════════════════════════
//
// Hummingbot MarketDataProvider.get_price_for_quote_volume semantics: walk
// the actual order-book levels consuming YOUR notional, compute the simulated
// VWAP fill price, and compare it against the mid → that is the estimated
// impact, computable BEFORE sending anything.
//
// Venue reality check (do not paper over it):
//  - Binance Futures exposes real depth (`GET /fapi/v1/depth`) — the walk is
//    genuine there (BinanceExecutor.estimateDepthImpact).
//  - Alpaca (IEX feed) exposes ONLY a top-of-book quote, no depth ladder.
//    The honest proxy is the side touch: estPx = touch, impact = half-spread
//    vs mid, flagged depthLimited=true. We do NOT invent deeper levels; an
//    Alpaca estimate is a LOWER BOUND on true impact and is recorded as such
//    (fills.est_px) so the estimate-vs-realized comparison stays meaningful.
//
// The estimate is recorded next to the realized fill (fills.est_px; realized
// slippage remains filled_px vs expected_px) so the model's quality is
// measurable. Abort-on-estimate is OPT-IN via
// EntryExecutionConfig.maxEstImpactBps and DISABLED by default — losing an
// entry silently is not acceptable until the estimator is validated.

/** One price level: [price, baseQty]. */
export type BookLevel = [number, number];

export interface BookWalk {
  /** Simulated VWAP price for the requested notional. */
  vwapPx: number;
  /** Base qty the walk consumed. */
  qty: number;
  /** Notional actually matched (== requested unless exhausted). */
  matchedNotional: number;
  /** True when the visible book ran out before covering the notional — the
   *  returned VWAP is then a LOWER BOUND on the true impact. */
  exhausted: boolean;
}

/**
 * Walk `levels` (best-first: asks ascending for a buy, bids descending for a
 * sell) consuming `notional` (quote units). Returns null when the book is
 * empty/malformed — never a fabricated price.
 */
export function walkBook(levels: BookLevel[], notional: number): BookWalk | null {
  if (!(notional > 0) || !Array.isArray(levels) || levels.length === 0) return null;
  let remaining = notional;
  let costQty = 0;
  let costNotional = 0;
  for (const [px, qty] of levels) {
    if (!(px > 0) || !(qty > 0)) continue;
    const levelNotional = px * qty;
    const take = Math.min(remaining, levelNotional);
    costQty += take / px;
    costNotional += take;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (costQty <= 0) return null;
  return {
    vwapPx: costNotional / costQty,
    qty: costQty,
    matchedNotional: costNotional,
    exhausted: remaining > 0,
  };
}

export interface DepthEstimate {
  /** Estimated VWAP fill price for the notional. */
  estPx: number;
  /** Book mid at estimation time. */
  midPx: number;
  /** Signed adverse impact in bps vs mid (positive = worse than mid). */
  estImpactBps: number;
  /** True when the estimate could NOT see enough depth for the notional
   *  (thin/limited book) — treat estImpactBps as a lower bound. */
  depthLimited: boolean;
}

/** VWAP-vs-mid impact for a full depth ladder. `bids`/`asks` must be
 *  best-first. Null when either touch is missing — no estimate from a
 *  half-empty book. */
export function estimateFromBook(
  bids: BookLevel[], asks: BookLevel[], side: "buy" | "sell", notional: number,
): DepthEstimate | null {
  const bestBid = bids[0]?.[0] ?? 0;
  const bestAsk = asks[0]?.[0] ?? 0;
  if (!(bestBid > 0) || !(bestAsk > 0) || bestBid > bestAsk) return null;
  const midPx = (bestBid + bestAsk) / 2;
  const walk = walkBook(side === "buy" ? asks : bids, notional);
  if (!walk) return null;
  const estImpactBps = (side === "buy" ? walk.vwapPx - midPx : midPx - walk.vwapPx) / midPx * 10_000;
  return { estPx: walk.vwapPx, midPx, estImpactBps, depthLimited: walk.exhausted };
}

/** Top-of-book-only estimate (Alpaca/IEX: no depth ladder exists). estPx is
 *  the side touch; impact is the half-spread; depthLimited is ALWAYS true —
 *  documented lower bound, never invented depth. */
export function estimateFromQuote(bid: number, ask: number, side: "buy" | "sell"): DepthEstimate | null {
  if (!(bid > 0) || !(ask > 0) || bid > ask) return null;
  const midPx = (bid + ask) / 2;
  const estPx = side === "buy" ? ask : bid;
  const estImpactBps = (side === "buy" ? estPx - midPx : midPx - estPx) / midPx * 10_000;
  return { estPx, midPx, estImpactBps, depthLimited: true };
}
