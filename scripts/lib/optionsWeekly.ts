// Vega phase R (quorum Q9): the PURE weekly-options kernel. No I/O, no dates from the clock, no
// provider knowledge beyond a quote snapshot: meant to be shared with a future live engine exactly
// as src/portfolio-engine/* is shared by research and live. Every rule here is the frozen manifest
// experiments/options-vega-r-v1.json; a change here that alters a result is a new ledger trial.
//
// Sections: calendar · regime (maTrend, parity with decideRegime) · Black-Scholes · chain filters
// and contract selection · sizing · fills and the weekly simulation · daily marks · statistics
// (circular block bootstrap, Holm, PSR/MinTRL).

// ── calendar ─────────────────────────────────────────────────────────────────────────────────────

export type Session = string; // "YYYY-MM-DD"

export interface Week {
  isoWeek: string;
  sessions: Session[];
  /** Last session of the week (normally Friday): contracts are chosen and opened at its close. */
  entry: Session;
  /** The session before the entry (normally Thursday): the regime is read at its close. */
  signal: Session;
}

export interface Expiry {
  /** The listed expiration date (may be a Saturday in the pre-2015 monthlies). */
  expiration: string;
  /** Last session <= expiration: the contract's last trading day. */
  expirationSession: Session;
  /** The session before expirationSession: every leg is closed at its close. */
  exit: Session;
  /** sessions(entry, expiration] */
  sessionsToExpiration: number;
}

function ymd(s: string): Date { return new Date(`${s}T00:00:00Z`); }

/** ISO-8601 week key (Monday-based), e.g. "2025-W14". */
export function isoWeekKey(s: Session): string {
  const d = ymd(s);
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of the same ISO week
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function calendarDays(a: Session, b: Session): number {
  return Math.round((ymd(b).getTime() - ymd(a).getTime()) / 86_400_000);
}

/** NYSE weeks with at least 2 sessions; sessions must be sorted ascending and unique. */
export function buildWeeks(sessions: readonly Session[]): Week[] {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const k = isoWeekKey(s);
    const g = groups.get(k);
    if (g) g.push(s); else groups.set(k, [s]);
  }
  const out: Week[] = [];
  for (const [isoWeek, ss] of groups) {
    if (ss.length < 2) continue;
    out.push({ isoWeek, sessions: ss, entry: ss[ss.length - 1], signal: ss[ss.length - 2] });
  }
  return out;
}

/** Index of the last session <= date (binary search), -1 when none. */
export function lastSessionIndexAtOrBefore(sessions: readonly Session[], date: string): number {
  let lo = 0, hi = sessions.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * The frozen rule: the LAST listed expiration E with 2 <= sessions(entry, E] <= 5. Null = the week is
 * cash ("no eligible expiration"). The expiration session is the last session <= E (the mirror dates
 * pre-2015 monthlies on the Saturday after the third Friday); the exit is the session before it, so a
 * leg is never held into the contract's last trading day.
 */
export function eligibleExpiration(sessions: readonly Session[], entry: Session, listed: readonly string[]): Expiry | null {
  const i0 = sessions.indexOf(entry);
  if (i0 < 0) throw new Error(`entry ${entry} is not a session`);
  let best: Expiry | null = null;
  for (const e of listed) {
    const j = lastSessionIndexAtOrBefore(sessions, e);
    if (j <= i0) continue;
    const count = j - i0;
    if (count < 2 || count > 5) continue;
    if (!best || e > best.expiration) best = { expiration: e, expirationSession: sessions[j], exit: sessions[j - 1], sessionsToExpiration: count };
  }
  return best;
}

/** Sessions in (entry, expirationSession]; the live-engine guard "no leg past 4 sessions after entry" reads exit - entry. */
export function sessionsBetween(sessions: readonly Session[], a: Session, b: Session): number {
  return sessions.indexOf(b) - sessions.indexOf(a);
}

// ── regime: maTrend exactly as src/portfolio-engine/contingency.ts decideRegime ─────────────────

export interface MaTrendConfig { period: number; bandPct: number }
export const UNCLE_CARL_SWITCH: MaTrendConfig = { period: 200, bandPct: 1 };

/**
 * Risk-off state at the close of every session, evaluated chronologically on adjusted closes.
 * Cold start risk-off; with fewer than `period` closes the state is retained (not evidence);
 * hysteresis inside the band; one signal, combine "any", confirmation 1 (so a request switches at once).
 * Returns riskOff[i] for closes[i].
 */
export function maTrendRiskOff(closes: readonly number[], c: MaTrendConfig = UNCLE_CARL_SWITCH): boolean[] {
  const out: boolean[] = new Array(closes.length);
  let riskOff = true, signalOff = true;
  const band = c.bandPct / 100, epsilon = 8 * Number.EPSILON;
  for (let i = 0; i < closes.length; i++) {
    if (i >= c.period - 1) {
      // Same arithmetic as decideRegime: mean of the last `period` closes, recomputed exactly (no drift).
      let s = 0;
      for (let k = i - c.period + 1; k <= i; k++) s += closes[k];
      const sma = s / c.period;
      const distance = closes[i] / sma - 1;
      signalOff = distance < -band - epsilon ? true : distance > band + epsilon ? false : signalOff;
      riskOff = signalOff; // confirmationDecisions 1: pending reaches 1 on the first differing decision
    }
    out[i] = riskOff;
  }
  return out;
}

// ── Black-Scholes, r = 0, q = 0 ──────────────────────────────────────────────────────────────────

/**
 * Standard normal CDF, Hart's double-precision algorithm (West 2005, "Better approximations to
 * cumulative normal functions"), |error| ~ 1e-14: the Python audit uses math.erfc, both agree to 1e-13.
 */
export function normCdf(x: number): number {
  const ax = Math.abs(x);
  let c: number;
  if (ax > 37) c = 0;
  else {
    const e = Math.exp(-ax * ax / 2);
    if (ax < 7.07106781186547) {
      let b = 3.52624965998911e-02 * ax + 0.700383064443688;
      b = b * ax + 6.37396220353165; b = b * ax + 33.912866078383; b = b * ax + 112.079291497871;
      b = b * ax + 221.213596169931; b = b * ax + 220.206867912376;
      let d = 8.83883476483184e-02 * ax + 1.75566716318264;
      d = d * ax + 16.064177579207; d = d * ax + 86.7807322029461; d = d * ax + 296.564248779674;
      d = d * ax + 637.333633378831; d = d * ax + 793.826512519948; d = d * ax + 440.413735824752;
      c = e * b / d;
    } else {
      let b = ax + 0.65; b = ax + 4 / b; b = ax + 3 / b; b = ax + 2 / b; b = ax + 1 / b;
      c = e / (b * 2.506628274631);
    }
  }
  return x > 0 ? 1 - c : c;
}

export type OptionType = "call" | "put";

export function intrinsic(S: number, K: number, type: OptionType): number {
  return type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
}

export function bsPrice(S: number, K: number, T: number, sigma: number, type: OptionType): number {
  if (T <= 0 || sigma <= 0) return intrinsic(S, K, type);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / sq;
  const d2 = d1 - sq;
  return type === "call" ? S * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - S * normCdf(-d1);
}

export function bsDelta(S: number, K: number, T: number, sigma: number, type: OptionType): number {
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / sq;
  return type === "call" ? normCdf(d1) : normCdf(d1) - 1;
}

export const IV_BOUNDS = { lo: 0.005, hi: 5.0, tol: 1e-6, maxIter: 100 } as const;

/** Bisection on [0.005, 5.0], 1e-6 in price, <= 100 iterations. Null = no solution or mid < intrinsic: unusable. */
export function impliedVol(S: number, K: number, T: number, mid: number, type: OptionType): number | null {
  if (!(mid >= intrinsic(S, K, type)) || T <= 0) return null;
  let lo = IV_BOUNDS.lo, hi = IV_BOUNDS.hi;
  if (mid < bsPrice(S, K, T, lo, type) || mid > bsPrice(S, K, T, hi, type)) return null;
  for (let i = 0; i < IV_BOUNDS.maxIter; i++) {
    const m = 0.5 * (lo + hi);
    const p = bsPrice(S, K, T, m, type);
    if (Math.abs(p - mid) <= IV_BOUNDS.tol) return m;
    if (p < mid) lo = m; else hi = m;
  }
  return null;
}

// ── chain filters and selection ─────────────────────────────────────────────────────────────────

/**
 * A close-of-session quote of one contract. bid/ask null = no quote (e.g. no bar at the second
 * provider). `synthetic` marks the second provider's p(1 ± h) quotes: the spread-width filter guards
 * against bad mirror data and does not apply to them (their width IS the declared cost model).
 */
export interface Quote { type: OptionType; strike: number; bid: number | null; ask: number | null; synthetic?: boolean }

export function usableQuote(q: Quote): q is Quote & { bid: number; ask: number } {
  if (q.bid === null || q.ask === null || !Number.isFinite(q.bid) || !Number.isFinite(q.ask)) return false;
  if (!(q.ask > 0) || !(q.bid >= 0) || q.ask < q.bid) return false;
  if (q.synthetic) return true;
  const mid = (q.bid + q.ask) / 2;
  return q.ask - q.bid <= Math.max(0.25, 0.5 * mid);
}

export function soldLegOk(q: Quote): boolean { return usableQuote(q) && q.bid! > 0; }

export interface PricedQuote extends Quote { bid: number; ask: number; mid: number; iv: number; delta: number }

/** Usable quotes with the frozen IV/delta; contracts without an IV solution are dropped (unusable for selection). */
export function priceChain(quotes: readonly Quote[], S: number, T: number): PricedQuote[] {
  const out: PricedQuote[] = [];
  for (const q of quotes) {
    if (!usableQuote(q)) continue;
    const mid = (q.bid + q.ask) / 2;
    const iv = impliedVol(S, q.strike, T, mid, q.type);
    if (iv === null) continue;
    out.push({ ...q, bid: q.bid, ask: q.ask, mid, iv, delta: bsDelta(S, q.strike, T, iv, q.type) });
  }
  return out;
}

/** O1: the put with strike nearest the raw close; tie → the lower strike. Sold leg: bid > 0. */
export function selectNearestStrike(chain: readonly PricedQuote[], type: OptionType, S: number): PricedQuote | null {
  let best: PricedQuote | null = null;
  for (const q of chain) {
    if (q.type !== type || !soldLegOk(q)) continue;
    if (!best) { best = q; continue; }
    const d = Math.abs(q.strike - S), bd = Math.abs(best.strike - S);
    if (d < bd || (d === bd && q.strike < best.strike)) best = q;
  }
  return best;
}

/** Farther from the money: lower strike for puts, higher for calls. */
function fartherOtm(a: PricedQuote, b: PricedQuote): boolean {
  return a.type === "put" ? a.strike < b.strike : a.strike > b.strike;
}

export const DELTA_TOLERANCE = 0.10;

/**
 * Nearest delta to the target within the tolerance; tie → the strike farther from the money.
 * `sold` adds bid > 0; `strikeFilter` enforces O2's "strictly lower/higher strike" for the long leg.
 */
export function selectByDelta(chain: readonly PricedQuote[], type: OptionType, targetDelta: number, opts: { sold?: boolean; strikeFilter?: (k: number) => boolean } = {}): PricedQuote | null {
  let best: PricedQuote | null = null;
  for (const q of chain) {
    if (q.type !== type) continue;
    if (opts.sold && !(q.bid > 0)) continue;
    if (opts.strikeFilter && !opts.strikeFilter(q.strike)) continue;
    const d = Math.abs(q.delta - targetDelta);
    if (d > DELTA_TOLERANCE) continue;
    if (!best) { best = q; continue; }
    const bd = Math.abs(best.delta - targetDelta);
    if (d < bd || (d === bd && fartherOtm(q, best))) best = q;
  }
  return best;
}

// ── candidates, sizing, fills, weekly simulation ────────────────────────────────────────────────

export type CandidateName = "O1-put-writer" | "O2-credit-spread" | "O3-convex-buyer";

export interface Leg { type: OptionType; strike: number; side: "short" | "long"; entryQuote: PricedQuote }

export interface Costs { feePerContractPerSide: number; /** 1 = the manifest, 2 = the "costs ×2" diagnostic */ multiplier: number }
export const COSTS: Costs = { feePerContractPerSide: 0.05, multiplier: 1 };
export const WEEKLY_BUDGET = 0.02;
export const MISSING_QUOTE_PENALTY = 0.05;

/** Sell at the bid, buy at the ask; the multiplier widens the half-spread around the mid (×2 = "costes ×2"). */
export function sellPrice(q: { bid: number; ask: number }, m = 1): number { const mid = (q.bid + q.ask) / 2; return mid - m * (mid - q.bid); }
export function buyPrice(q: { bid: number; ask: number }, m = 1): number { const mid = (q.bid + q.ask) / 2; return mid + m * (q.ask - mid); }

export interface Selection { legs: Leg[]; /** cash per contract (positive = credit) at entry, before fees */ underlying: string }

export interface WeekInputs {
  candidate: CandidateName;
  week: Week;
  expiry: Expiry | null;
  /** Risk-off at the close of the signal session (or of the entry session in the diagnostic variant). */
  riskOff: boolean;
  /** Raw (unadjusted) closes by session for every underlying the candidate may trade. */
  rawClose: (underlying: string, session: Session) => number | undefined;
  /** Close-of-session quotes of the eligible expiration's chain at `session`; [] when nothing is listed. */
  chain: (underlying: string, session: Session, expiration: string) => readonly Quote[];
  equity: number;
  costs?: Costs;
  fractional?: boolean;
}

export interface LegFill { price: number; source: "quote" | "intrinsic" }

export interface WeekResult {
  candidate: CandidateName;
  entry: Session; signal: Session; exit: Session | null; expiration: string | null;
  underlying: string | null; riskOff: boolean;
  status: "traded" | "cash";
  reason: string | null;
  legs: Array<{ type: OptionType; strike: number; side: "short" | "long"; delta: number; iv: number; bid: number; ask: number; entryFill: number; exitFill: LegFill | null }>;
  contracts: number;
  /** Max loss per contract (O2) or premium per contract (O3) used by the sizing, in dollars. */
  sizingUnit: number | null;
  equityEntry: number; equityExit: number;
  pnl: number; fees: number; orders: number;
  /** Equity at the close of every session from entry to exit, marked at mid; and at liquidation prices. */
  dailyMid: Array<{ session: Session; equity: number }>;
  dailyLiquidation: Array<{ session: Session; equity: number }>;
  missingQuoteAtExit: number;
  /** Any leg marked at intrinsic on an intermediate session (no quote). */
  intrinsicMarks: number;
  /** Short call in the money on an ex-dividend date within the hold (O2 bearish): early-assignment exposure, not modeled. */
  shortCallItmOverExDividend?: boolean;
}

export function selectLegs(candidate: CandidateName, riskOff: boolean, S: number, chain: readonly PricedQuote[]): { legs: Leg[] } | { reason: string } {
  if (candidate === "O1-put-writer") {
    const q = selectNearestStrike(chain, "put", S);
    return q ? { legs: [{ type: "put", strike: q.strike, side: "short", entryQuote: q }] } : { reason: "no sellable ATM put" };
  }
  if (candidate === "O2-credit-spread") {
    const type: OptionType = riskOff ? "call" : "put";
    const short = selectByDelta(chain, type, riskOff ? 0.30 : -0.30, { sold: true });
    if (!short) return { reason: `no ${type} within 0.10 of delta ±0.30` };
    const long = selectByDelta(chain, type, riskOff ? 0.10 : -0.10, { strikeFilter: k => riskOff ? k > short.strike : k < short.strike });
    if (!long) return { reason: `no ${type} within 0.10 of delta ±0.10 beyond the short strike` };
    return { legs: [{ type, strike: short.strike, side: "short", entryQuote: short }, { type, strike: long.strike, side: "long", entryQuote: long }] };
  }
  const type: OptionType = riskOff ? "put" : "call";
  const q = selectByDelta(chain, type, riskOff ? -0.40 : 0.40);
  return q ? { legs: [{ type, strike: q.strike, side: "long", entryQuote: q }] } : { reason: `no ${type} within 0.10 of delta ±0.40` };
}

export function candidateUnderlying(candidate: CandidateName, riskOff: boolean): string {
  return candidate === "O3-convex-buyer" && !riskOff ? "QQQ" : "SPY";
}

/** Contracts (integer, floor) and the sizing unit per the frozen formulas. */
export function sizeContracts(candidate: CandidateName, legs: readonly Leg[], equity: number, costs: Costs, fractional: boolean): { n: number; unit: number } {
  const fee = costs.feePerContractPerSide * costs.multiplier;
  let n: number, unit: number;
  if (candidate === "O1-put-writer") {
    unit = 100 * legs[0].strike;
    n = equity / unit;
  } else if (candidate === "O2-credit-spread") {
    const s = legs[0].entryQuote, l = legs[1].entryQuote;
    const width = Math.abs(s.strike - l.strike);
    const credit = sellPrice(s, costs.multiplier) - buyPrice(l, costs.multiplier);
    unit = 100 * width - 100 * credit + 100 * ((s.ask - s.bid) + (l.ask - l.bid)) * costs.multiplier + 4 * fee;
    n = WEEKLY_BUDGET * equity / unit;
  } else {
    unit = 100 * buyPrice(legs[0].entryQuote, costs.multiplier) + 2 * fee;
    n = WEEKLY_BUDGET * equity / unit;
  }
  return { n: fractional ? n : Math.floor(n), unit };
}

function markLeg(q: Quote | undefined, S: number, K: number, type: OptionType, side: "short" | "long", mode: "mid" | "liquidation"): { value: number; source: "quote" | "intrinsic" } {
  if (q && q.bid !== null && q.ask !== null && q.ask >= q.bid && q.ask > 0) {
    if (mode === "mid") return { value: (q.bid + q.ask) / 2, source: "quote" };
    return { value: side === "short" ? q.ask : q.bid, source: "quote" };
  }
  return { value: intrinsic(S, K, type), source: "intrinsic" };
}

function cashWeek(inp: WeekInputs, reason: string, underlying: string | null, extra: Partial<WeekResult> = {}): WeekResult {
  const sessions = [inp.week.entry];
  return {
    candidate: inp.candidate, entry: inp.week.entry, signal: inp.week.signal, exit: inp.expiry?.exit ?? null, expiration: inp.expiry?.expiration ?? null,
    underlying, riskOff: inp.riskOff, status: "cash", reason, legs: [], contracts: 0, sizingUnit: null,
    equityEntry: inp.equity, equityExit: inp.equity, pnl: 0, fees: 0, orders: 0,
    dailyMid: sessions.map(s => ({ session: s, equity: inp.equity })), dailyLiquidation: sessions.map(s => ({ session: s, equity: inp.equity })),
    missingQuoteAtExit: 0, intrinsicMarks: 0, ...extra,
  };
}

/**
 * One week of one candidate. `holdSessions` are the sessions from entry to exit inclusive (the caller
 * knows the session list). Entry fills at the entry close (sell bid / buy ask), exit fills at the exit
 * close; a leg without a usable exit quote is valued at intrinsic worsened by 0.05 per share; fees per
 * contract per side on every fill, including the intrinsic valuation (a closing trade still happens).
 */
export function simulateWeek(inp: WeekInputs, holdSessions: readonly Session[]): WeekResult {
  const costs = inp.costs ?? COSTS;
  const m = costs.multiplier;
  const fee = costs.feePerContractPerSide * m;
  const underlying = candidateUnderlying(inp.candidate, inp.riskOff);
  if (!inp.expiry) return cashWeek(inp, "no eligible expiration", underlying);
  const S = inp.rawClose(underlying, inp.week.entry);
  if (S === undefined) return cashWeek(inp, "no underlying close at entry", underlying);
  const T = calendarDays(inp.week.entry, inp.expiry.expirationSession) / 365;
  const chain = priceChain(inp.chain(underlying, inp.week.entry, inp.expiry.expiration), S, T);
  if (chain.length === 0) return cashWeek(inp, "no usable quotes in the chain", underlying);
  const sel = selectLegs(inp.candidate, inp.riskOff, S, chain);
  if ("reason" in sel) return cashWeek(inp, sel.reason, underlying);
  const { n, unit } = sizeContracts(inp.candidate, sel.legs, inp.equity, costs, inp.fractional ?? false);
  if (!(n > 0)) return cashWeek(inp, "zero contracts", underlying, { sizingUnit: unit });

  // entry
  let cash = inp.equity, fees = 0;
  for (const leg of sel.legs) {
    const px = leg.side === "short" ? sellPrice(leg.entryQuote, m) : buyPrice(leg.entryQuote, m);
    cash += (leg.side === "short" ? 1 : -1) * n * 100 * px;
    fees += n * fee;
  }
  cash -= fees;
  const legs: WeekResult["legs"] = sel.legs.map(l => ({
    type: l.type, strike: l.strike, side: l.side, delta: l.entryQuote.delta, iv: l.entryQuote.iv, bid: l.entryQuote.bid, ask: l.entryQuote.ask,
    entryFill: l.side === "short" ? sellPrice(l.entryQuote, m) : buyPrice(l.entryQuote, m), exitFill: null,
  }));

  // daily marks entry..exit (exit uses the realized close-out)
  const dailyMid: WeekResult["dailyMid"] = [], dailyLiquidation: WeekResult["dailyLiquidation"] = [];
  let intrinsicMarks = 0;
  const exit = inp.expiry.exit;
  for (const s of holdSessions) {
    if (s === exit) break;
    const Sd = inp.rawClose(underlying, s);
    const quotes = inp.chain(underlying, s, inp.expiry.expiration);
    let mid = cash, liq = cash;
    for (const leg of sel.legs) {
      const q = quotes.find(x => x.type === leg.type && x.strike === leg.strike);
      const sign = leg.side === "short" ? -1 : 1;
      const a = markLeg(q, Sd ?? S, leg.strike, leg.type, leg.side, "mid");
      const b = markLeg(q, Sd ?? S, leg.strike, leg.type, leg.side, "liquidation");
      if (a.source === "intrinsic") intrinsicMarks++;
      mid += sign * n * 100 * a.value;
      liq += sign * n * 100 * b.value;
    }
    dailyMid.push({ session: s, equity: mid });
    dailyLiquidation.push({ session: s, equity: liq });
  }

  // exit
  const Sx = inp.rawClose(underlying, exit);
  const exitQuotes = inp.chain(underlying, exit, inp.expiry.expiration);
  let missing = 0;
  sel.legs.forEach((leg, i) => {
    const q = exitQuotes.find(x => x.type === leg.type && x.strike === leg.strike);
    let fill: LegFill;
    if (q && usableQuote(q)) {
      fill = { price: leg.side === "short" ? buyPrice(q, m) : sellPrice(q, m), source: "quote" };
    } else {
      if (Sx === undefined) throw new Error(`no raw close of ${underlying} at exit ${exit}`);
      const iv = intrinsic(Sx, leg.strike, leg.type);
      const pen = MISSING_QUOTE_PENALTY * m;
      fill = { price: leg.side === "short" ? iv + pen : Math.max(0, iv - pen), source: "intrinsic" };
      missing++;
    }
    cash += (leg.side === "short" ? -1 : 1) * n * 100 * fill.price;
    cash -= n * fee; fees += n * fee;
    legs[i].exitFill = fill;
  });
  dailyMid.push({ session: exit, equity: cash });
  dailyLiquidation.push({ session: exit, equity: cash });

  return {
    candidate: inp.candidate, entry: inp.week.entry, signal: inp.week.signal, exit, expiration: inp.expiry.expiration,
    underlying, riskOff: inp.riskOff, status: "traded", reason: null, legs, contracts: n, sizingUnit: unit,
    equityEntry: inp.equity, equityExit: cash, pnl: cash - inp.equity, fees, orders: 2 * sel.legs.length,
    dailyMid, dailyLiquidation, missingQuoteAtExit: missing, intrinsicMarks,
  };
}

// ── statistics ───────────────────────────────────────────────────────────────────────────────────

/** Deterministic PRNG, identical to src/portfolio/scorecard.ts mulberry32 (duplicated to keep the kernel import-free). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP = { blockLen: 4, resamples: 10_000, seed: 20261109 } as const;

export interface BootstrapResult { mean: number; p: number; ci90: [number, number]; n: number; resamples: number; blockLen: number; seed: number }

/**
 * Circular block bootstrap of the mean of x: blocks of `blockLen` consecutive values starting at a
 * uniform index, wrapping around, until n values are drawn. p = (1 + #{mean* <= 0}) / (1 + B).
 */
export function circularBlockBootstrap(x: readonly number[], o: { blockLen: number; resamples: number; seed: number } = BOOTSTRAP): BootstrapResult {
  const n = x.length;
  const mean = n ? x.reduce((a, b) => a + b, 0) / n : NaN;
  if (n === 0) return { mean, p: NaN, ci90: [NaN, NaN], n, ...o };
  const rand = mulberry32(o.seed);
  const means: number[] = new Array(o.resamples);
  let nonPositive = 0;
  for (let b = 0; b < o.resamples; b++) {
    let sum = 0, filled = 0;
    while (filled < n) {
      const start = Math.floor(rand() * n);
      for (let j = 0; j < o.blockLen && filled < n; j++, filled++) sum += x[(start + j) % n];
    }
    const mb = sum / n;
    means[b] = mb;
    if (mb <= 0) nonPositive++;
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))];
  return { mean, p: (1 + nonPositive) / (1 + o.resamples), ci90: [q(0.05), q(0.95)], n, ...o };
}

/** Holm step-down at family level alpha (one-sided p-values). Returns reject[] aligned with ps. */
export function holm(ps: readonly number[], alpha: number): boolean[] {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const reject = ps.map(() => false);
  const m = ps.length;
  for (let k = 0; k < m; k++) {
    const [p, i] = order[k];
    if (p <= alpha / (m - k)) reject[i] = true; else break;
  }
  return reject;
}

export function maxDrawdown(equity: readonly number[]): number {
  let peak = -Infinity, dd = 0;
  for (const e of equity) { if (e > peak) peak = e; else dd = Math.max(dd, 1 - e / peak); }
  return dd;
}

/** Probabilistic Sharpe ratio of a series against SR* = 0 and the minimum track record length at 95 %. */
export function psrAndMinTrl(x: readonly number[]): { sr: number; psr: number; minTrl: number | null; skew: number; kurt: number } {
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const m2 = x.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(m2 * n / (n - 1));
  const skew = x.reduce((a, b) => a + (b - mean) ** 3, 0) / n / m2 ** 1.5;
  const kurt = x.reduce((a, b) => a + (b - mean) ** 4, 0) / n / m2 ** 2;
  const sr = mean / sd;
  const denom = Math.sqrt(1 - skew * sr + (kurt - 1) / 4 * sr * sr);
  const psr = normCdf(sr * Math.sqrt(n - 1) / denom);
  const z = 1.6448536269514722;
  const minTrl = sr > 0 ? 1 + (1 - skew * sr + (kurt - 1) / 4 * sr * sr) * (z / sr) ** 2 : null;
  return { sr, psr, minTrl, skew, kurt };
}
