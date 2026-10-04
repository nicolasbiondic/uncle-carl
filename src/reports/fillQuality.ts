// ══════════════════════════════════════════════
// Fill-quality report — empirical paper-vs-real haircut (2026-09-02)
// ══════════════════════════════════════════════
//
// Since 2026-08-03 every fill in `fills` carries FOUR independent price
// marks (src/db/database.ts): expected_px (decision), submitted_px (quote
// at send), filled_px (real), and est_px (bookDepth.ts's pre-trade impact
// estimate — nullable, only ~half of rows have it). Nobody reads est_px:
// it rides into the DB (src/executor/bookDepth.ts) purely as telemetry.
//
// This module answers, from that telemetry: (1) how much does realized
// slippage (decision → fill) actually cost, sliced by broker/market/side/
// trade-size, and (2) how far off is the pre-trade estimator (est_px vs
// filled_px) — the ONLY evidence that could justify flipping
// EntryExecutionConfig.maxEstImpactBps from its current default-off
// ("disabled until the estimator is validated", bookDepth.ts:22). A
// consistently small |est error| across enough fills is exactly the bar
// that flag is waiting on; a large or noisy one is a reason to leave it off.
//
// Pure functions only — no DB, no I/O. The CLI (scripts/fill-quality-
// report.ts) is the only caller that touches sqlite.
//
// Price-basis note (2026-09-10): before this date, Binance ENTRY fills
// (BinanceMomentumAdapter.openPosition) recorded expected_px as the MARK
// price (this.binance.getPrice()) — a funding-smoothed index nobody
// actually trades at — while filled_px is always a real TRADE price. That
// mark-vs-trade "slippage" (~0.8bps P50, measured) is NOT comparable to the
// backtest simulator's vs-bar-open figure (~5bps) and is NOT comparable to
// fills recorded on/after 2026-09-10, when entries switched to a
// quote-touch TRADE price (getExecutableQuote: ask for buy, bid for sell,
// falling back to mark only when no fresh quote exists). Also before this
// date, EXIT fills (both Binance and Alpaca) recorded expected_px ==
// submitted_px by construction (both read from the executor's own
// result.submittedPx), so exit slippage_bps was always ~0 and measured
// nothing — exits now capture a pre-close quote-touch as expected_px, a
// genuinely independent decision-price mark. There is no `basis` column on
// `fills` (src/db/database.ts is not owned by the adapters that write it) —
// a caller comparing slippage_bps across this boundary must filter on
// fill_time / order_id creation date themselves; this module exposes no
// filter of its own since it is pure (rows in, stats out).

export type FillSide = "buy" | "sell";

export interface FillRow {
  broker: string;
  market: string;
  side: string; // "buy" | "sell" — anything else is treated as "sell" (mirrors decomposeSlippage's `side === "buy"` check in src/db/database.ts)
  expectedPx: number;
  filledPx: number;
  filledQty: number;
  latencyMs: number;
  /** Pre-trade estimated fill price (bookDepth.ts). Null/undefined/<=0 rows
   *  are excluded from the estimator-error block only — they still count
   *  toward `n`, slippage and latency stats. */
  estPx?: number | null;
}

/**
 * Side-aware realized slippage in bps: decision price (expectedPx) vs the
 * actual fill. Same sign convention as `recordFill`/`decomposeSlippage` in
 * src/db/database.ts (kept in lockstep deliberately — two conventions for
 * the same number would be a landmine): for a BUY, paying MORE than
 * expected is a cost → positive. For a SELL, it's the mirror: getting LESS
 * than expected is a cost → positive. Zero/negative expectedPx returns 0
 * (never a fabricated slippage number from a bad reference price).
 */
export function slippageBps(side: string, expectedPx: number, filledPx: number): number {
  if (!(expectedPx > 0)) return 0;
  const signedDelta = side === "buy" ? filledPx - expectedPx : expectedPx - filledPx;
  return (signedDelta / expectedPx) * 10_000;
}

/**
 * Side-aware estimator error in bps: the pre-trade impact estimate
 * (est_px) vs the actual fill, using the identical sign convention as
 * `slippageBps` (just with est_px standing in as the reference price
 * instead of expected_px) — so "positive = cost more than the reference"
 * reads the same way in both numbers.
 *
 * Concretely that means: POSITIVE = the estimator was OPTIMISTIC (it
 * predicted a better price than what actually happened — i.e. it
 * UNDERSTATED the adverse impact). NEGATIVE = the estimator was
 * PESSIMISTIC (the actual fill beat the estimate).
 *
 * Zero/negative/absent estPx returns 0 — callers that want the "excluded
 * from the estimator block" semantics must filter on `estPx` themselves
 * (see `summarize` below), this function never fabricates one.
 */
export function estErrorBps(side: string, estPx: number, filledPx: number): number {
  if (!(estPx > 0)) return 0;
  const signedDelta = side === "buy" ? filledPx - estPx : estPx - filledPx;
  return (signedDelta / estPx) * 10_000;
}

/**
 * Nearest-rank percentile: sort ascending, index = floor(n·p), clamped to
 * the last element. No interpolation, no dependency — same style as
 * `getSlippageStats` in src/db/database.ts (`sorted[Math.floor(n*0.5)]`).
 * Empty input returns 0 (never NaN).
 */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

export interface SideStats {
  n: number;
  slippageBpsP50: number | null;
  slippageBpsP90: number | null;
}

export interface BucketStats {
  /** Human label, e.g. "<$1k", "$1k-$5k", "$5k-$25k", ">$25k". */
  bucket: string;
  n: number;
  slippageBpsP50: number;
  slippageBpsP90: number;
  estErrorAbsBpsP50: number | null;
  estErrorAbsBpsP90: number | null;
  estN: number;
  latencyMsP50: number;
  latencyMsP90: number;
}

export interface GroupSummary {
  broker: string;
  market: string;
  n: number;
  slippageBpsP50: number;
  slippageBpsP90: number;
  /** |estErrorBps| stats — magnitude only, since the report cares about
   *  "how far off" the estimator is, not which direction. null when no row
   *  in the group has a usable est_px. */
  estErrorAbsBpsP50: number | null;
  estErrorAbsBpsP90: number | null;
  estN: number;
  latencyMsP50: number;
  latencyMsP90: number;
  buy: SideStats;
  sell: SideStats;
  /**
   * True when `buy`/`sell` above can be read as "entry"/"exit" — this
   * bot's stock sleeves (momentum_stocks, meanrev_stocks) are long-only
   * (buy opens, sell closes; enforced structurally — no short path exists
   * for Alpaca in this codebase), so for market === "stock" the mapping is
   * exact. Crypto sleeves CAN short (TimeSeriesMomentum.shortEntryThresholdPct
   * → BinanceMomentumAdapter opens with side "sell"), so a crypto `sell`
   * may be an entry, not an exit — `buy`/`sell` are still shown, just not
   * relabeled. A hint for the CLI's column headers, not a data filter.
   */
  sideIsEntryExit: boolean;
  buckets: BucketStats[];
}

export interface SummarizeOptions {
  /**
   * Ascending USD-notional bucket boundaries. Default [1000, 5000, 25000]
   * → "<$1k", "$1k-$5k", "$5k-$25k", ">$25k". Notional = |filledQty ×
   * filledPx|.
   */
  notionalBucketsUsd?: number[];
}

const DEFAULT_BUCKETS_USD = [1_000, 5_000, 25_000];

function formatUsd(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `$${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `$${n}`;
}

function bucketLabels(boundaries: number[]): string[] {
  const labels: string[] = [];
  for (let i = 0; i <= boundaries.length; i++) {
    if (i === 0) labels.push(`<${formatUsd(boundaries[0])}`);
    else if (i === boundaries.length) labels.push(`>${formatUsd(boundaries[i - 1])}`);
    else labels.push(`${formatUsd(boundaries[i - 1])}-${formatUsd(boundaries[i])}`);
  }
  return labels;
}

/** Index into `boundaries.length + 1` buckets for a given notional. */
function bucketIndex(notional: number, boundaries: number[]): number {
  for (let i = 0; i < boundaries.length; i++) {
    if (notional < boundaries[i]) return i;
  }
  return boundaries.length;
}

function estErrorAbsFor(rows: FillRow[]): number[] {
  const out: number[] = [];
  for (const r of rows) {
    if (r.estPx != null && r.estPx > 0) out.push(Math.abs(estErrorBps(r.side, r.estPx, r.filledPx)));
  }
  return out;
}

/** Shared core stats block (n, slippage percentiles, est-error percentiles,
 *  latency percentiles) reused for both a full group and its buckets. */
function coreStats(rows: FillRow[]): Omit<BucketStats, "bucket"> {
  const slips = rows.map(r => slippageBps(r.side, r.expectedPx, r.filledPx));
  const estAbsErrs = estErrorAbsFor(rows);
  const lat = rows.map(r => r.latencyMs);
  return {
    n: rows.length,
    slippageBpsP50: percentile(slips, 0.5),
    slippageBpsP90: percentile(slips, 0.9),
    estErrorAbsBpsP50: estAbsErrs.length ? percentile(estAbsErrs, 0.5) : null,
    estErrorAbsBpsP90: estAbsErrs.length ? percentile(estAbsErrs, 0.9) : null,
    estN: estAbsErrs.length,
    latencyMsP50: percentile(lat, 0.5),
    latencyMsP90: percentile(lat, 0.9),
  };
}

function sideStats(rows: FillRow[]): SideStats {
  if (rows.length === 0) return { n: 0, slippageBpsP50: null, slippageBpsP90: null };
  const slips = rows.map(r => slippageBps(r.side, r.expectedPx, r.filledPx));
  return { n: rows.length, slippageBpsP50: percentile(slips, 0.5), slippageBpsP90: percentile(slips, 0.9) };
}

/**
 * Groups `rows` by (broker, market) and, within each group, by notional
 * bucket. Groups with zero rows never appear (nothing to compute — an
 * empty broker/market pair isn't a "0" row, it's absent). Deterministic
 * output order (broker, then market, both lexical) so callers/tests never
 * depend on Map iteration order.
 */
export function summarize(rows: FillRow[], opts: SummarizeOptions = {}): GroupSummary[] {
  const boundaries = opts.notionalBucketsUsd ?? DEFAULT_BUCKETS_USD;
  const labels = bucketLabels(boundaries);

  const groups = new Map<string, FillRow[]>();
  for (const r of rows) {
    const key = `${r.broker}\u0000${r.market}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const out: GroupSummary[] = [];
  for (const [key, groupRows] of groups) {
    const [broker, market] = key.split("\u0000");
    const buy = groupRows.filter(r => r.side === "buy");
    const sell = groupRows.filter(r => r.side === "sell");

    const buckets: BucketStats[] = labels.map((label, i) => {
      const bucketRows = groupRows.filter(
        r => bucketIndex(Math.abs(r.filledQty * r.filledPx), boundaries) === i
      );
      return { bucket: label, ...coreStats(bucketRows) };
    });

    out.push({
      broker,
      market,
      ...coreStats(groupRows),
      buy: sideStats(buy),
      sell: sideStats(sell),
      sideIsEntryExit: market === "stock",
      buckets,
    });
  }

  out.sort((a, b) => (a.broker === b.broker ? a.market.localeCompare(b.market) : a.broker.localeCompare(b.broker)));
  return out;
}
