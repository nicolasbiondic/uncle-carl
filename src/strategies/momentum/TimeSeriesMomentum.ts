// ══════════════════════════════════════════════
// Time-Series Momentum (v7.0 alternative engine)
// ══════════════════════════════════════════════
//
// Academic basis: Moskowitz, Ooi, Pedersen (2012) "Time Series Momentum"
// — one of the most robust anomalies across asset classes.
//
// Mechanism (simpler than cross-sectional):
//   For each symbol independently:
//     compute lookback return r over a window.
//     if r > +entryThreshold AND price > moving average → LONG
//     if r < -exitThreshold OR price < moving average  → CLOSE / FLAT
//
// Why this is the right pivot when cross-sectional fails:
//   - Doesn't require relative dispersion in the universe.
//   - Goes flat when EVERYTHING is bad, doesn't force "least bad" trades.
//   - Captures persistent trends in individual assets.
//   - Each symbol is independent — no rebalance churn.
//
// Used by MomentumEngine when mode = "time-series".

import type { OHLCV } from "../../utils/types";
import type { MomentumDecision } from "./MomentumScorer";

export interface TSMConfig {
  barMinutes: number;
  /** Lookback window in days for the trend return. Default 14d. */
  lookbackDays: number;
  /** Moving average length in days. Default 30d. Used as trend filter. */
  maLengthDays: number;
  /** Return threshold to ENTER a long. Default 5%. */
  entryThresholdPct: number;
  /** Return threshold to EXIT (negative). Default -2%. Hysteresis: easier to exit than enter. */
  exitThresholdPct: number;
  /** Maximum number of simultaneous longs. Default 4 — concentrates on the best trends. */
  maxLongs: number;
  /** Maximum number of simultaneous shorts. Default 0 = long/flat only (v7 behavior). */
  maxShorts: number;
  /** Return threshold to ENTER a short (negative). Default -5%. */
  shortEntryThresholdPct: number;
  /** Return threshold to EXIT a short (positive). Default +2%. Hysteresis mirror of exitThresholdPct. */
  shortExitThresholdPct: number;
  /**
   * OPT-IN (default false = legacy behavior, byte-identical): when true,
   * long-slot assignment runs in two passes — (a) every held long whose
   * stay signal is still valid keeps its slot (highest r first when
   * maxLongs binds), (b) only the REMAINING slots are filled with fresh
   * entries by r desc. A held long then only exits on its OWN signal,
   * never because a higher-ranked entrant displaced it out of the top-N.
   */
  slotHysteresis?: boolean;
  /**
   * OPT-IN multi-horizon signal (absent = legacy single-horizon path,
   * byte-identical): when set (non-empty), the trend return r is the MEAN
   * of the lookback returns over each horizon in the list (bar-math days,
   * the same unit as lookbackDays), and the entry/exit thresholds apply to
   * that blended r. The MA trend filter is unchanged. `lookbackDays` is
   * ignored for the signal when this is set (the walk-forward validator
   * forbids configuring both). A symbol needs enough history for the
   * LONGEST horizon or it is skipped entirely (no partial blends — a
   * 2-of-3 average is a different signal than the declared one).
   * Academic basis: Hurst, Ooi, Pedersen (2017) — averaging 1/3/12-month
   * horizons is more robust than any single lookback.
   */
  lookbackDaysList?: number[];
}

/**
 * TimeSeriesMomentum.rank() decision: MomentumDecision plus `displaced` —
 * telemetry marking a held long whose stay signal was still valid but that
 * lost its top-N slot to a higher-ranked entrant (legacy slot assignment).
 * The Rebalancer maps it onto closeReason=SLOT_DISPLACED_CLOSE_REASON so
 * trades.close_reason can distinguish a slot displacement from a genuine
 * signal exit (both used to record MOMENTUM_REBALANCE, indistinguishably).
 */
export interface TSMDecision extends MomentumDecision {
  displaced?: boolean;
}

export const DEFAULT_TSM_CONFIG: TSMConfig = {
  barMinutes: 5,
  lookbackDays: 14,
  maLengthDays: 30,
  entryThresholdPct: 5,
  exitThresholdPct: -2,
  maxLongs: 4,
  maxShorts: 0,
  shortEntryThresholdPct: -5,
  shortExitThresholdPct: 2,
};

export class TimeSeriesMomentum {
  private cfg: TSMConfig;
  constructor(cfg: Partial<TSMConfig> = {}) {
    this.cfg = { ...DEFAULT_TSM_CONFIG, ...cfg };
  }

  /**
   * Decide per-symbol action. `currentlyHeld` (longs) / `currentlyShort` are
   * required so we can apply asymmetric entry/exit thresholds correctly.
   */
  rank(candlesBySymbol: Map<string, OHLCV[]>, currentlyHeld?: Set<string>, currentlyShort?: Set<string>): TSMDecision[] {
    const lookbackBars = Math.floor(this.cfg.lookbackDays * 24 * 60 / this.cfg.barMinutes);
    // Multi-horizon (opt-in): bar counts per horizon, longest first for the
    // history requirement. Absent/empty leaves every line below on the exact
    // legacy path (lookbackBarsList === undefined).
    const lookbackBarsList = this.cfg.lookbackDaysList && this.cfg.lookbackDaysList.length > 0
      ? this.cfg.lookbackDaysList.map(d => Math.floor(d * 24 * 60 / this.cfg.barMinutes))
      : undefined;
    const maBars = Math.floor(this.cfg.maLengthDays * 24 * 60 / this.cfg.barMinutes);
    const minBars = Math.max(lookbackBarsList ? Math.max(...lookbackBarsList) : lookbackBars, maBars) + 1;

    interface Candidate {
      symbol: string;
      r: number;        // lookback return
      px: number;       // current price
      ma: number;       // moving avg over maLengthDays
      held: boolean;      // currently held long
      heldShort: boolean; // currently held short
    }
    const cands: Candidate[] = [];

    for (const [symbol, candles] of candlesBySymbol) {
      if (candles.length < minBars) continue;
      const closes = candles.map(c => c.close);
      const px = closes[closes.length - 1];
      let r: number;
      if (lookbackBarsList) {
        // Blended signal: mean of the lookback returns over EVERY horizon.
        // Any unusable reference close skips the symbol — a partial blend
        // would be a different (undeclared) signal.
        if (!px) continue;
        let sum = 0;
        let usable = true;
        for (const lb of lookbackBarsList) {
          const refN = closes[closes.length - 1 - lb];
          if (!refN || refN <= 0) { usable = false; break; }
          sum += (px - refN) / refN;
        }
        if (!usable) continue;
        r = sum / lookbackBarsList.length;
      } else {
        // Legacy single-horizon path — byte-identical (pinned by
        // scripts/regression-fingerprint.test.ts).
        const ref = closes[closes.length - 1 - lookbackBars];
        if (!px || !ref || ref <= 0) continue;
        r = (px - ref) / ref;
      }
      let ma = 0;
      for (let i = closes.length - maBars; i < closes.length; i++) ma += closes[i];
      ma /= maBars;
      cands.push({ symbol, r, px, ma, held: currentlyHeld?.has(symbol) ?? false, heldShort: currentlyShort?.has(symbol) ?? false });
    }

    if (cands.length === 0) return [];

    // Sort by lookback return (highest first) so when maxLongs binds we pick
    // the best trends. Longs are selected top-down; shorts bottom-up — i.e.
    // |r| descending within each side. Deterministic, no side overlap by
    // construction (long needs px>MA, short needs px<MA).
    cands.sort((a, b) => b.r - a.r);

    const longs = new Set<string>();
    const longStayOk = (c: Candidate) => c.held && c.r >= this.cfg.exitThresholdPct / 100 && c.px > c.ma;
    if (this.cfg.slotHysteresis) {
      // Opt-in two-pass assignment (see TSMConfig.slotHysteresis): held longs
      // with a valid stay signal keep their slots first (r desc when maxLongs
      // binds), then fresh entries fill only the remaining slots.
      for (const c of cands) {
        if (longs.size >= this.cfg.maxLongs) break;
        if (longStayOk(c)) longs.add(c.symbol);
      }
      for (const c of cands) {
        if (longs.size >= this.cfg.maxLongs) break;
        if (longs.has(c.symbol)) continue;
        if (c.r >= this.cfg.entryThresholdPct / 100 && c.px > c.ma) longs.add(c.symbol);
      }
    } else {
      // Legacy path — MUST stay byte-identical (same loop, same order, same
      // tie handling): pinned by scripts/regression-fingerprint.test.ts.
      for (const c of cands) {
        if (longs.size >= this.cfg.maxLongs) break;
        const aboveMa = c.px > c.ma;
        const enterOk = c.r >= this.cfg.entryThresholdPct / 100 && aboveMa;
        const stayOk  = c.held && c.r >= this.cfg.exitThresholdPct / 100 && aboveMa;
        if (enterOk || stayOk) longs.add(c.symbol);
      }
    }
    // Telemetry (both paths): a held long whose stay signal is still valid
    // but that got no slot was DISPLACED by ranking, not exited by signal.
    const displaced = new Set<string>();
    for (const c of cands) {
      if (longStayOk(c) && !longs.has(c.symbol)) displaced.add(c.symbol);
    }

    const shorts = new Set<string>();
    for (let i = cands.length - 1; i >= 0 && shorts.size < this.cfg.maxShorts; i--) {
      const c = cands[i];
      if (longs.has(c.symbol)) continue; // longs take slot priority
      const belowMa = c.px < c.ma;
      const enterOk = c.r <= this.cfg.shortEntryThresholdPct / 100 && belowMa;
      const stayOk  = c.heldShort && c.r <= this.cfg.shortExitThresholdPct / 100 && belowMa;
      if (enterOk || stayOk) shorts.add(c.symbol);
    }

    return cands.map((c, idx) => ({
      symbol: c.symbol,
      action: longs.has(c.symbol) ? "long" as const : shorts.has(c.symbol) ? "short" as const : "flat" as const,
      score: c.r,
      rank: cands.length - 1 - idx, // highest r => highest rank
      reason: longs.has(c.symbol)
        ? `tsm long: r=${(c.r * 100).toFixed(2)}% above ${(this.cfg.entryThresholdPct).toFixed(1)}%, price above MA`
        : shorts.has(c.symbol)
        ? `tsm short: r=${(c.r * 100).toFixed(2)}% below ${(this.cfg.shortEntryThresholdPct).toFixed(1)}%, price below MA`
        : `tsm flat: r=${(c.r * 100).toFixed(2)}%, ${c.px > c.ma ? "above MA" : "below MA"}`,
      // Optional field, only present when true — a decision object without
      // displacement is byte-identical to the pre-field output.
      ...(displaced.has(c.symbol) ? { displaced: true } : {}),
    }));
  }

  getConfig(): Readonly<TSMConfig> {
    return this.cfg;
  }
}
