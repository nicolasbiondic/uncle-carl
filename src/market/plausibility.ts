// ══════════════════════════════════════════════
// Price/quote plausibility — pure predicates
// ══════════════════════════════════════════════
//
// Why this exists (2026-07-27 near-incident): a WELL-FORMED but economically
// absurd IEX quote — UNH bid 392.64 / ask 420.00 (spread 6.5%) at 3s of age
// while the last trade printed 418.35 — turned a real −0.83% position into a
// fabricated −3.68% with the stop at −4%. 1302 green tests didn't see it:
// the suite tested MALFORMED data, never IMPLAUSIBLE data. These predicates
// reject well-formed garbage BEFORE it feeds a money decision.
//
// Fail-closed: missing or dubious data ⇒ reject. Never a price "just in case".
//
// Prior art: qlib backtest/exchange.py (check_stock_limit / _suspended /
// is_stock_tradable gated in check_order, plus a sanity guard on the
// threshold config itself) and freqtrade's SpreadFilter (spread = 1 −
// bid/ask, default 0.5%, `return False` on an invalid ticker — fail-closed).
// The thresholds below are OURS, measured on this bot's real universe — see
// each constant's comment for the measurement.
//
// This module is PURE and dependency-free on purpose: no config import, no
// logger, no broker types. Callers pass their own numbers and log the
// verdicts themselves (see RejectionTally for cooldown-aggregated counting).

export type Quote = {
  bid: number;
  ask: number;
  /** Last trade price when the caller has one. Optional because Alpaca's
   *  crypto latest-quotes endpoint carries no trade; when absent (or ≤0),
   *  the accepted price falls back to the mid — reachable only AFTER the
   *  spread bound passed, so it's the mid of a tight, fresh, uncrossed book. */
  last?: number;
  /** Broker EVENT timestamp (ms epoch) — never our receipt time. */
  ts: number;
};

export type Reject = { ok: false; reason: string; detail?: string };
export type Accept = { ok: true; price: number };
export type Verdict = Accept | Reject;

export type PlausibilityConfig = {
  /** Max relative spread (ask−bid)/mid before the quote is fiction. */
  maxSpreadRatio: number;
  /** Reject when price/ref or ref/price ≥ this ratio (order-of-magnitude guard). */
  maxRefRatio: number;
  /** Max quote age vs `now` (ms). */
  maxAgeMs: number;
  /** Tolerated future clock skew (ms). */
  maxClockSkewMs: number;
};

export const DEFAULT_PLAUSIBILITY: PlausibilityConfig = {
  // Measured 2026-07-29 (read-only IEX snapshot of all 43 universe symbols;
  // shape identical to the in-session 2026-07-27 audit measurement, AUDITS.md
  // round 9): the spread distribution is BIMODAL — every usable quote was
  // ≤0.08% (SPY 0.03, QQQ 0.04, IWM 0.08, SLV 0.06) and every garbage quote
  // ≥5.47% (33 symbols at 5.47–11%, plus 6 with ask=0). 2% sits in the empty
  // gap: 25× above the worst usable quote, 2.7× below the tightest garbage,
  // and rejects the UNH incident quote (6.7% over mid). NOTE: this predicate
  // runs only on the QUOTE (fill-telemetry) path, where rejecting 39/43
  // symbols is CORRECT (their IEX books are fabrications — AUDITS round 9
  // measured slippage_bps ≈ 336,920,000 off an AAPL bid of 0.01) and can
  // never block an order or a close by that path's existing contract.
  maxSpreadRatio: 0.02,
  // Measured on data/historical.db: max single 5-minute move across 1.26M
  // bars / 18 symbols = 34.7%; across the 43-stock trading universe (10y of
  // daily bars) the worst single day was 144% (HON) and the worst
  // 30-trading-day run was −52.7% (HON) / +72.7% (QCOM). A ×10 band
  // (−90%…+900%) keeps ≥5.7× margin over every real observation while
  // rejecting order-of-magnitude garbage (the AAPL midpoint 0.005 vs ~230,
  // AUDITS round 9). Deliberately NOT applied to Binance crypto: measured
  // DOGE/USD moved +1075% in 30 trading days — a ×10 band would reject a
  // real price there.
  maxRefRatio: 10,
  // Same freshness standard as the executor's EXECUTABLE_QUOTE_TTL_MS /
  // isFreshEventTime (30s / +5s skew) — kept as literals so this module
  // stays import-free; the executor's own TTL check remains authoritative.
  maxAgeMs: 30_000,
  maxClockSkewMs: 5_000,
};

/** Price sanity without a book: positive, finite, and (when the caller has an
 *  anchor) within ×maxRefRatio of it. `ref` is a price the caller trusts —
 *  our own entry fill, or the last accepted price. A bad ref rejects
 *  (fail-closed): if the anchor is corrupt, no verdict is trustworthy. */
export function checkPrice(price: number, ref: number | undefined, cfg: PlausibilityConfig): Verdict {
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: "non_positive_price", detail: `price=${price}` };
  }
  if (ref !== undefined) {
    if (!Number.isFinite(ref) || ref <= 0) {
      return { ok: false, reason: "bad_reference", detail: `ref=${ref}` };
    }
    const ratio = price > ref ? price / ref : ref / price;
    if (ratio >= cfg.maxRefRatio) {
      return { ok: false, reason: "ref_deviation", detail: `price=${price} ref=${ref} ×${ratio.toFixed(1)} ≥ ×${cfg.maxRefRatio}` };
    }
  }
  return { ok: true, price };
}

/** Full order-book plausibility. Every predicate fail-closed, cheapest first. */
export function checkQuote(q: Quote, cfg: PlausibilityConfig, now: number, ref?: number): Verdict {
  if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask) || !Number.isFinite(q.ts)) {
    return { ok: false, reason: "malformed_quote", detail: `bid=${q.bid} ask=${q.ask} ts=${q.ts}` };
  }
  if (q.bid <= 0 || q.ask <= 0) {
    return { ok: false, reason: "non_positive_touch", detail: `bid=${q.bid} ask=${q.ask}` };
  }
  if (q.bid > q.ask) {
    return { ok: false, reason: "crossed_market", detail: `bid=${q.bid} > ask=${q.ask}` };
  }
  if (q.ts > now + cfg.maxClockSkewMs) {
    return { ok: false, reason: "future_timestamp", detail: `ts=${q.ts} now=${now}` };
  }
  if (now - q.ts > cfg.maxAgeMs) {
    return { ok: false, reason: "stale_quote", detail: `age=${now - q.ts}ms > ${cfg.maxAgeMs}ms` };
  }
  const mid = (q.bid + q.ask) / 2;
  const spread = (q.ask - q.bid) / mid;
  if (spread > cfg.maxSpreadRatio) {
    return { ok: false, reason: "wide_spread", detail: `${(spread * 100).toFixed(2)}% > ${(cfg.maxSpreadRatio * 100).toFixed(2)}%` };
  }
  const price = Number.isFinite(q.last) && (q.last as number) > 0 ? (q.last as number) : mid;
  return checkPrice(price, ref, cfg);
}

// ── observation/enforce switch ─────────────────────────────────────────────
// Default OBSERVE: the system is live and an over-eager threshold that
// rejects real prices leaves positions unmanaged — as severe a failure as
// letting garbage through. In observe mode every verdict is evaluated and
// counted but NOTHING is blocked; flip PLAUSIBILITY_MODE=enforce once the
// observed rejection counts on live data look right.
export type PlausibilityMode = "observe" | "enforce";

export function plausibilityMode(raw: string | undefined = process.env.PLAUSIBILITY_MODE): PlausibilityMode {
  return raw === "enforce" ? "enforce" : "observe";
}

/** Cooldown-aggregated rejection counter: one summary line per window, never
 *  a line per evaluation (this repo has a documented history of alert
 *  fatigue). Callers `add()` per rejection and log whatever `flush()`
 *  returns; between windows flush() is null and costs nothing. */
export class RejectionTally {
  private counts = new Map<string, number>();
  private total = 0;
  private lastFlushAt = 0;

  constructor(private cooldownMs = 5 * 60_000) {}

  add(reason: string): void {
    this.total++;
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }

  /** Aggregated summary once per cooldown window (resets counts), else null. */
  flush(now = Date.now()): string | null {
    if (this.total === 0 || now - this.lastFlushAt < this.cooldownMs) return null;
    const parts = [...this.counts.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}×${n}`);
    const msg = `${this.total} implausible price read(s): ${parts.join(", ")}`;
    this.counts.clear();
    this.total = 0;
    this.lastFlushAt = now;
    return msg;
  }
}
