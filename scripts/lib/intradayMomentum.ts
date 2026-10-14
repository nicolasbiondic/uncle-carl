/**
 * Pure simulation core for Line C (docs/reports/V-plan-volumen-rentabilidad.md
 * §12): intraday SPY/QQQ momentum of the last half hour (Gao, Han, Li & Zhou
 * 2018, "Market Intraday Momentum" — the return from the previous close to
 * 10:00 ET, and/or the return of the penultimate half hour, predicts the
 * 15:30–16:00 ET return).
 *
 * No I/O, no imports beyond types — same philosophy as scripts/lib/sequenceRisk.ts.
 * Consumed by scripts/intraday-wf.ts.
 */

export interface MinBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type IntradaySignal = "fhh" | "penultimate" | "agree" | "fhhThreshold";

export interface IntradayCandidate {
  name: string;
  /** "fhh": sign of the first-half-hour (09:30–10:00 ET) return vs prior close.
   *  "penultimate": sign of the penultimate half-hour (15:00–15:30 ET) return.
   *  "agree": trade only when fhh and penultimate signs AGREE (else flat).
   *  "fhhThreshold": like "fhh" but flat unless |fhh return| >= thresholdBps. */
  signal: IntradaySignal;
  thresholdBps?: number;
}

export interface DayOutcome {
  dateKey: string;
  direction: -1 | 0 | 1;
  fhhReturn: number | null;
  penultimateReturn: number | null;
  entryPx: number | null;
  exitPx: number | null;
  /** Gross (pre-cost) return of the trade, 0 when flat. */
  grossReturn: number;
}

// ET minute-of-day boundaries (minutes since midnight ET).
export const ET_OPEN_MIN = 570; // 09:30
export const FHH_END_MIN = 600; // 10:00 (end of the first half hour)
export const PENULTIMATE_START_MIN = 900; // 15:00
export const LAST_HALF_START_MIN = 930; // 15:30 (entry time)

function sign(x: number): -1 | 0 | 1 {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/**
 * Compute the day's trading decision from its RTH 1-minute bars (ascending,
 * already filtered to [09:30, sessionCloseMin) for this ET calendar date).
 *
 * Returns null when the day cannot produce a last-half-hour decision:
 *   - no bars, or any of the four marker prices is unavailable (sparse data)
 *   - early-close session (sessionCloseMin <= LAST_HALF_START_MIN): there IS
 *     no 15:30-16:00 window to trade (e.g. day after Thanksgiving, 13:00 close)
 *   - prevClose missing/non-positive
 *
 * `dayStartMs` is the ET midnight (epoch ms) that bar timestamps are measured
 * against (src/db/database.ts getETDayStart).
 */
export function computeDayOutcome(
  bars: MinBar[],
  dayStartMs: number,
  sessionCloseMin: number,
  prevClose: number,
  candidate: IntradayCandidate,
): Omit<DayOutcome, "dateKey"> | null {
  if (bars.length === 0) return null;
  if (sessionCloseMin <= LAST_HALF_START_MIN) return null; // early close: no last half hour

  let fhhClose: number | null = null;       // last close with min < FHH_END_MIN      (~10:00 mark)
  let preLastClose: number | null = null;   // last close with min < PENULTIMATE_START_MIN (~15:00 mark)
  let preFhhClose: number | null = null;    // last close with min < LAST_HALF_START_MIN   (~15:30 mark)
  let entryBar: MinBar | null = null;       // first bar with min >= LAST_HALF_START_MIN
  let lastBar: MinBar | null = null;        // last bar with min < sessionCloseMin

  for (const b of bars) {
    const min = Math.round((b.timestamp - dayStartMs) / 60_000);
    if (min < FHH_END_MIN) fhhClose = b.close;
    if (min < PENULTIMATE_START_MIN) preLastClose = b.close;
    if (min < LAST_HALF_START_MIN) preFhhClose = b.close;
    if (entryBar === null && min >= LAST_HALF_START_MIN && min < sessionCloseMin) entryBar = b;
    if (min < sessionCloseMin) lastBar = b;
  }

  if (fhhClose === null || preLastClose === null || preFhhClose === null || !entryBar || !lastBar) return null;
  if (!(prevClose > 0) || !(entryBar.open > 0) || !(lastBar.close > 0)) return null;

  const fhhReturn = fhhClose / prevClose - 1;
  const penultimateReturn = preFhhClose / preLastClose - 1;
  const entryPx = entryBar.open;
  const exitPx = lastBar.close;

  let direction: -1 | 0 | 1 = 0;
  if (candidate.signal === "fhh") {
    direction = sign(fhhReturn);
  } else if (candidate.signal === "penultimate") {
    direction = sign(penultimateReturn);
  } else if (candidate.signal === "agree") {
    const s1 = sign(fhhReturn), s2 = sign(penultimateReturn);
    direction = s1 !== 0 && s1 === s2 ? s1 : 0;
  } else if (candidate.signal === "fhhThreshold") {
    const thr = (candidate.thresholdBps ?? 0) / 10_000;
    direction = Math.abs(fhhReturn) >= thr ? sign(fhhReturn) : 0;
  }

  const grossReturn = direction === 0 ? 0 : direction * (exitPx / entryPx - 1);
  return { direction, fhhReturn, penultimateReturn, entryPx, exitPx, grossReturn };
}

/** Net-of-cost return for one day's outcome. `extraBpsPerSide` is ADDITIONAL
 *  slippage atop `costBpsPerSide` (break-even curve sweep). Flat days cost 0. */
export function netReturn(direction: -1 | 0 | 1, grossReturn: number, costBpsPerSide: number, extraBpsPerSide = 0): number {
  if (direction === 0) return 0;
  return grossReturn - (2 * (costBpsPerSide + extraBpsPerSide)) / 10_000;
}

/** Orders generated by a day's decision: 2 (entry+exit) when a trade fires, 0 when flat. */
export function ordersForDay(direction: -1 | 0 | 1): number {
  return direction === 0 ? 0 : 2;
}
