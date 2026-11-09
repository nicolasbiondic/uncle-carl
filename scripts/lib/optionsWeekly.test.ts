import { describe, expect, test } from "bun:test";
import { decideRegime, type RegimeMemory } from "../../src/portfolio-engine/contingency";
import type { DailyBar, PriceView, RegimeOverlayConfig } from "../../src/portfolio-engine/types";
import { mulberry32 as scorecardMulberry32 } from "../../src/portfolio/scorecard";
import {
  bsDelta, bsPrice, buildWeeks, calendarDays, circularBlockBootstrap, eligibleExpiration, holm, impliedVol, isoWeekKey,
  maTrendRiskOff, maxDrawdown, mulberry32, normCdf, priceChain, selectByDelta, selectNearestStrike, sessionsBetween, simulateWeek,
  sizeContracts, usableQuote, type Expiry, type Quote, type Week, type WeekInputs,
} from "./optionsWeekly";

// ── NYSE sessions around the holidays the manifest's tests name ────────────────────────────────
const SESSIONS_2025_APRIL = ["2025-03-31", "2025-04-01", "2025-04-02", "2025-04-03", "2025-04-04", "2025-04-07", "2025-04-08", "2025-04-09", "2025-04-10", "2025-04-11",
  "2025-04-14", "2025-04-15", "2025-04-16", "2025-04-17", /* Good Friday 04-18 closed */ "2025-04-21", "2025-04-22", "2025-04-23", "2025-04-24", "2025-04-25", "2025-04-28"];
const SESSIONS_2025_JULY = ["2025-06-27", "2025-06-30", "2025-07-01", "2025-07-02", "2025-07-03", /* Fri 07-04 closed */ "2025-07-07", "2025-07-08", "2025-07-09", "2025-07-10", "2025-07-11", "2025-07-14"];
const SESSIONS_2024_THANKSGIVING = ["2024-11-22", "2024-11-25", "2024-11-26", "2024-11-27", /* Thu 11-28 closed */ "2024-11-29", "2024-12-02", "2024-12-03", "2024-12-04", "2024-12-05", "2024-12-06", "2024-12-09"];

describe("calendar", () => {
  test("ISO weeks: Monday-based, year boundary", () => {
    expect(isoWeekKey("2025-04-04")).toBe("2025-W14");
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(isoWeekKey("2021-01-03")).toBe("2020-W53");
    expect(calendarDays("2025-04-04", "2025-04-11")).toBe(7);
  });

  test("weeks need 2 sessions; entry is the last session, signal the one before", () => {
    const weeks = buildWeeks(["2025-04-03", "2025-04-04", "2025-04-07", "2025-04-14"]);
    expect(weeks).toEqual([{ isoWeek: "2025-W14", sessions: ["2025-04-03", "2025-04-04"], entry: "2025-04-04", signal: "2025-04-03" }]);
  });

  test("Good Friday week: entry Thursday 04-17; the week before picks the Monday 04-21 expiry (5 sessions) and exits Thursday 04-17", () => {
    const weeks = buildWeeks(SESSIONS_2025_APRIL);
    const w15 = weeks.find(w => w.isoWeek === "2025-W15")!, w16 = weeks.find(w => w.isoWeek === "2025-W16")!;
    expect([w15.entry, w15.signal]).toEqual(["2025-04-11", "2025-04-10"]);
    expect([w16.entry, w16.signal]).toEqual(["2025-04-17", "2025-04-16"]);
    const listed = ["2025-04-14", "2025-04-15", "2025-04-16", "2025-04-17", "2025-04-21", "2025-04-22", "2025-04-23", "2025-04-24", "2025-04-25"];
    const ex = eligibleExpiration(SESSIONS_2025_APRIL, "2025-04-11", listed)!;
    expect(ex).toEqual({ expiration: "2025-04-21", expirationSession: "2025-04-21", exit: "2025-04-17", sessionsToExpiration: 5 });
    // the Thursday-entry week: the next Friday
    expect(eligibleExpiration(SESSIONS_2025_APRIL, "2025-04-17", listed)).toEqual({ expiration: "2025-04-25", expirationSession: "2025-04-25", exit: "2025-04-24", sessionsToExpiration: 5 });
  });

  test("a Friday holiday week (July 4th 2025): entry Thursday 07-03, next Friday eligible, exit 07-10", () => {
    const weeks = buildWeeks(SESSIONS_2025_JULY);
    const w = weeks.find(x => x.isoWeek === "2025-W27")!;
    expect([w.entry, w.signal]).toEqual(["2025-07-03", "2025-07-02"]);
    expect(eligibleExpiration(SESSIONS_2025_JULY, "2025-07-03", ["2025-07-07", "2025-07-09", "2025-07-11", "2025-07-18"]))
      .toEqual({ expiration: "2025-07-11", expirationSession: "2025-07-11", exit: "2025-07-10", sessionsToExpiration: 5 });
  });

  test("Thanksgiving 2024: entry 11-22 picks Monday 12-02 (5 sessions), exit the Friday half-day 11-29; entry 11-29 picks 12-06", () => {
    const listed = ["2024-11-25", "2024-11-26", "2024-11-27", "2024-11-29", "2024-12-02", "2024-12-04", "2024-12-06"];
    expect(eligibleExpiration(SESSIONS_2024_THANKSGIVING, "2024-11-22", listed)).toEqual({ expiration: "2024-12-02", expirationSession: "2024-12-02", exit: "2024-11-29", sessionsToExpiration: 5 });
    expect(eligibleExpiration(SESSIONS_2024_THANKSGIVING, "2024-11-29", listed)).toEqual({ expiration: "2024-12-06", expirationSession: "2024-12-06", exit: "2024-12-05", sessionsToExpiration: 5 });
  });

  test("pre-2015 Saturday-dated monthly: expiration session is the Friday, exit the Thursday; 1-session and 6-session expiries are not eligible", () => {
    const s = ["2013-03-08", "2013-03-11", "2013-03-12", "2013-03-13", "2013-03-14", "2013-03-15", "2013-03-18", "2013-03-22"];
    expect(eligibleExpiration(s, "2013-03-08", ["2013-03-16", "2013-03-22"])).toEqual({ expiration: "2013-03-16", expirationSession: "2013-03-15", exit: "2013-03-14", sessionsToExpiration: 5 });
    expect(eligibleExpiration(s, "2013-03-08", ["2013-03-11"])).toBeNull();
    expect(eligibleExpiration(s, "2013-03-08", ["2013-03-22"])).toBeNull();
  });

  test("no leg is ever held into the expiration session: exit precedes it and is at most 4 sessions after entry", () => {
    for (const [sessions, entry, listed] of [
      [SESSIONS_2025_APRIL, "2025-04-11", ["2025-04-17", "2025-04-21"]],
      [SESSIONS_2024_THANKSGIVING, "2024-11-22", ["2024-11-29", "2024-12-02"]],
      [SESSIONS_2025_JULY, "2025-07-03", ["2025-07-11"]],
    ] as const) {
      const ex = eligibleExpiration(sessions, entry, listed)!;
      expect(ex.exit < ex.expirationSession).toBe(true);
      expect(sessionsBetween(sessions, entry, ex.exit)).toBeLessThanOrEqual(4);
      expect(sessionsBetween(sessions, entry, ex.exit)).toBeGreaterThanOrEqual(1);
    }
  });
});

// ── regime parity ────────────────────────────────────────────────────────────────────────────────
describe("regime", () => {
  test("maTrendRiskOff reproduces decideRegime (maTrend 200/daily/band 1 %, any, confirmation 1, cold start risk-off) on a synthetic tape", () => {
    const rand = mulberry32(7);
    const closes: number[] = [100];
    for (let i = 1; i < 700; i++) closes.push(closes[i - 1] * Math.exp((rand() - 0.5) * 0.04 + (i < 300 ? 0.0008 : i < 450 ? -0.002 : 0.0005)));
    const date = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
    const bars: DailyBar[] = closes.map((close, i) => ({ date: date(i), open: close, high: close, low: close, close, volume: 1 }));
    const cfg: RegimeOverlayConfig = { signals: [{ kind: "maTrend", symbol: "SPY", period: 200, sampling: "daily", bandPct: 1 }], combine: "any", confirmationDecisions: 1, coreScale: 0 };
    let memory: RegimeMemory | undefined;
    const expected: boolean[] = [];
    for (let i = 0; i < closes.length; i++) {
      const view: PriceView = { asOf: date(i), barCount: () => i + 1, history: (_s, n) => bars.slice(0, i + 1).slice(-n) };
      memory = decideRegime(view, cfg, memory);
      expected.push(memory.riskOff);
    }
    const ours = maTrendRiskOff(closes);
    expect(ours).toEqual(expected);
    expect(new Set(ours).size).toBe(2); // the tape actually switches
    expect(ours.slice(0, 199).every(Boolean)).toBe(true); // cold start risk-off until 200 closes
  });
});

// ── pricing ──────────────────────────────────────────────────────────────────────────────────────
describe("Black-Scholes", () => {
  test("normal CDF matches math.erfc to 1e-13", () => {
    expect(normCdf(0)).toBe(0.5);
    expect(Math.abs(normCdf(1.96) - 0.9750021048517795)).toBeLessThan(1e-13);
    expect(Math.abs(normCdf(-1) - 0.15865525393145707)).toBeLessThan(1e-13);
    expect(Math.abs(normCdf(3) - 0.9986501019683699)).toBeLessThan(1e-13);
  });

  test("put-call parity with r = q = 0: C − P = S − K", () => {
    for (const [S, K, T, s] of [[600, 590, 7 / 365, 0.18], [450, 470, 8 / 365, 0.25], [100, 100, 30 / 365, 0.6]]) {
      expect(bsPrice(S, K, T, s, "call") - bsPrice(S, K, T, s, "put")).toBeCloseTo(S - K, 9);
      expect(bsDelta(S, K, T, s, "call") - bsDelta(S, K, T, s, "put")).toBeCloseTo(1, 12);
    }
  });

  test("matches the Python audit's arithmetic (scripts/options-mirror-to-sqlite.py) on pinned values", () => {
    expect(bsPrice(600, 590, 7 / 365, 0.18, "put")).toBeCloseTo(2.2129461709455427, 10);
    expect(impliedVol(600, 590, 7 / 365, 2.5, "put")!).toBeCloseTo(0.19082161128520964, 9);
    expect(bsPrice(450, 470, 8 / 365, 0.25, "call")).toBeCloseTo(1.0050310924123025, 10);
    expect(impliedVol(450, 470, 8 / 365, 0.35, "call")!).toBeCloseTo(0.19107140272855755, 9);
  });

  test("implied vol round-trips the price within 1e-6 and refuses mid < intrinsic or outside [0.005, 5]", () => {
    for (const [S, K, T, s, type] of [[600, 590, 7 / 365, 0.18, "put"], [600, 650, 5 / 365, 0.9, "call"], [100, 100, 1 / 365, 0.05, "put"]] as const) {
      const p = bsPrice(S, K, T, s, type);
      const iv = impliedVol(S, K, T, p, type)!;
      expect(Math.abs(bsPrice(S, K, T, iv, type) - p)).toBeLessThanOrEqual(1e-6);
    }
    expect(impliedVol(600, 610, 7 / 365, 9.99, "put")).toBeNull(); // below intrinsic 10
    expect(impliedVol(600, 600, 7 / 365, 500, "put")).toBeNull(); // above the sigma = 5 price
    expect(impliedVol(600, 610, 7 / 365, 10 - 1e-9, "put")).toBeNull(); // a hair below intrinsic
  });
});

// ── filters, selection, sizing ───────────────────────────────────────────────────────────────────
const q = (type: "call" | "put", strike: number, bid: number | null, ask: number | null): Quote => ({ type, strike, bid, ask });

describe("chain filters and selection", () => {
  test("usable quote: ask > 0, bid >= 0, ask >= bid, spread <= max(0.25, 0.5 × mid)", () => {
    expect(usableQuote(q("put", 1, 1.0, 1.2))).toBe(true);
    expect(usableQuote(q("put", 1, 0, 0.05))).toBe(true);
    expect(usableQuote(q("put", 1, 0, 0))).toBe(false);
    expect(usableQuote(q("put", 1, 1.3, 1.2))).toBe(false);
    expect(usableQuote(q("put", 1, 0.10, 0.40))).toBe(false); // spread 0.30 > max(0.25, 0.125)
    expect(usableQuote(q("put", 1, 0.10, 0.35))).toBe(true); // spread 0.25 <= 0.25
    expect(usableQuote(q("put", 1, 2.0, 3.0))).toBe(true); // spread 1.0 <= 0.5 × 2.5
    expect(usableQuote(q("put", 1, 2.0, 3.5))).toBe(false);
    expect(usableQuote(q("put", 1, null, 1))).toBe(false);
  });

  test("O1 picks the strike nearest the close, tie → lower; a bid = 0 put cannot be sold", () => {
    const S = 600.5, T = 7 / 365;
    const chain = priceChain([q("put", 600, 3.0, 3.1), q("put", 601, 3.5, 3.6), q("put", 605, 0, 0.1)], S, T);
    expect(selectNearestStrike(chain, "put", S)!.strike).toBe(600);
    expect(selectNearestStrike(priceChain([q("put", 600, 0, 0.1), q("put", 601, 3.5, 3.6)], S, T), "put", S)!.strike).toBe(601);
    expect(selectNearestStrike([], "put", S)).toBeNull();
  });

  test("delta selection: nearest within 0.10, tie → farther from the money, strict strike filter for the long leg", () => {
    const S = 600, T = 7 / 365;
    const strikes = [570, 575, 580, 585, 590, 595, 600, 605, 610, 615, 620, 625, 630];
    const chain = priceChain(strikes.flatMap(K => (["put", "call"] as const).map(t => { const p = bsPrice(S, K, T, 0.2, t); return q(t, K, Math.max(0, p - 0.05), p + 0.05); })), S, T);
    const short = selectByDelta(chain, "put", -0.30, { sold: true })!;
    expect(Math.abs(short.delta + 0.30)).toBeLessThan(0.10);
    const long = selectByDelta(chain, "put", -0.10, { strikeFilter: k => k < short.strike })!;
    expect(long.strike).toBeLessThan(short.strike);
    expect(selectByDelta(chain, "put", 0.5)).toBeNull(); // no put has a positive delta
    expect(selectByDelta(chain, "call", 0.40)!.delta).toBeCloseTo(0.4, 0);
  });

  test("sizing: integer floor; O1 cash-secured; O2 by max loss; O3 by premium; fractional variant keeps the fraction", () => {
    const S = 600, T = 7 / 365;
    const [put] = priceChain([q("put", 600, 3.0, 3.1)], S, T);
    const leg = { type: "put" as const, strike: 600, side: "short" as const, entryQuote: put };
    expect(sizeContracts("O1-put-writer", [leg], 100_000, { feePerContractPerSide: 0.05, multiplier: 1 }, false)).toEqual({ n: 1, unit: 60_000 });
    expect(sizeContracts("O1-put-writer", [leg], 100_000, { feePerContractPerSide: 0.05, multiplier: 1 }, true).n).toBeCloseTo(100_000 / 60_000, 12);
    const [s, l] = priceChain([q("put", 590, 2.0, 2.1), q("put", 580, 0.8, 0.9)], S, T);
    const o2 = sizeContracts("O2-credit-spread", [{ type: "put", strike: 590, side: "short", entryQuote: s }, { type: "put", strike: 580, side: "long", entryQuote: l }], 100_000, { feePerContractPerSide: 0.05, multiplier: 1 }, false);
    // L = 100×10 − 100×(2.0 − 0.9) + 100×(0.1 + 0.1) + 0.2 = 910.2 → floor(2000 / 910.2) = 2
    expect(o2.unit).toBeCloseTo(910.2, 9);
    expect(o2.n).toBe(2);
    const [c] = priceChain([q("call", 600, 3.0, 3.1)], S, T);
    expect(sizeContracts("O3-convex-buyer", [{ type: "call", strike: 600, side: "long", entryQuote: c }], 100_000, { feePerContractPerSide: 0.05, multiplier: 1 }, false)).toEqual({ n: 6, unit: 310.1 });
  });
});

// ── weekly simulation ────────────────────────────────────────────────────────────────────────────
const HOLD = ["2025-03-07", "2025-03-10", "2025-03-11", "2025-03-12", "2025-03-13"];
const WEEK: Week = { isoWeek: "2025-W10", sessions: ["2025-03-03", "2025-03-04", "2025-03-05", "2025-03-06", "2025-03-07"], entry: "2025-03-07", signal: "2025-03-06" };
const EXPIRY: Expiry = { expiration: "2025-03-14", expirationSession: "2025-03-14", exit: "2025-03-13", sessionsToExpiration: 5 };

function inputs(candidate: WeekInputs["candidate"], riskOff: boolean, chains: Record<string, Quote[]>, S: Record<string, number>, equity = 100_000, extra: Partial<WeekInputs> = {}): WeekInputs {
  return { candidate, week: WEEK, expiry: EXPIRY, riskOff, equity,
    rawClose: (_u, s) => S[s], chain: (_u, s) => chains[s] ?? [], ...extra };
}

describe("simulateWeek", () => {
  test("O2 put spread: integer contracts, the week's loss never exceeds 2 % of the entry equity even when the spread closes at full width plus both spreads", () => {
    const S = 600, T = 7 / 365;
    const entryChain = [q("put", 590, 2.0, 2.1), q("put", 580, 0.8, 0.9)];
    // a crash: at exit the spread is worth its full width; the short's ask and the long's bid are as bad as the entry spreads allow
    const exitChain = [q("put", 590, 40.0, 40.1), q("put", 580, 30.0, 30.1)];
    const chains: Record<string, Quote[]> = { "2025-03-07": entryChain, "2025-03-13": exitChain };
    for (const s of HOLD.slice(1, -1)) chains[s] = [q("put", 590, 20, 20.2), q("put", 580, 12, 12.2)];
    const prices = Object.fromEntries(HOLD.map(s => [s, s === HOLD[0] ? S : 550]));
    const r = simulateWeek(inputs("O2-credit-spread", false, chains, prices), HOLD);
    expect(r.status).toBe("traded");
    expect(r.legs.map(l => [l.side, l.strike])).toEqual([["short", 590], ["long", 580]]);
    expect(r.contracts).toBe(2);
    expect(Number.isInteger(r.contracts)).toBe(true);
    expect(r.pnl).toBeLessThan(0);
    expect(-r.pnl).toBeLessThanOrEqual(0.02 * r.equityEntry);
    expect(r.fees).toBeCloseTo(2 * 0.05 * 2 * 2, 10); // 2 legs × 2 sides × n = 2
    expect(r.orders).toBe(4);
    expect(r.dailyMid.map(d => d.session)).toEqual(HOLD);
    expect(r.dailyMid.at(-1)!.equity).toBe(r.equityExit);
    expect(r.exit).toBe("2025-03-13");
    void T;
  });

  test("O1: sells the ATM put at the bid, buys it back at the ask; n = 0 when equity cannot cover one contract → cash week", () => {
    const chains = { "2025-03-07": [q("put", 600, 3.0, 3.1)], "2025-03-13": [q("put", 600, 1.0, 1.1)] };
    const prices = Object.fromEntries(HOLD.map(s => [s, 600]));
    const r = simulateWeek(inputs("O1-put-writer", false, chains, prices, 100_000), HOLD);
    expect(r.contracts).toBe(1);
    expect(r.pnl).toBeCloseTo(100 * (3.0 - 1.1) - 2 * 0.05, 10);
    expect(r.intrinsicMarks).toBe(3); // no quotes on the three middle sessions → intrinsic marks, counted
    const cash = simulateWeek(inputs("O1-put-writer", false, chains, prices, 50_000), HOLD);
    expect(cash).toMatchObject({ status: "cash", reason: "zero contracts", contracts: 0, pnl: 0, equityExit: 50_000 });
  });

  test("missing quote at exit: short pays intrinsic + 0.05, long receives max(0, intrinsic − 0.05); counted", () => {
    const chains = { "2025-03-07": [q("call", 603, 4.0, 4.1)] }; // no exit quote at all
    const prices = Object.fromEntries(HOLD.map(s => [s, s === "2025-03-13" ? 612 : 600]));
    const r = simulateWeek(inputs("O3-convex-buyer", false, chains, prices), HOLD);
    expect(r.status).toBe("traded");
    expect(Math.abs(r.legs[0].delta - 0.40)).toBeLessThanOrEqual(0.10);
    expect(r.contracts).toBe(Math.floor(2000 / (410 + 0.1)));
    expect(r.missingQuoteAtExit).toBe(1);
    expect(r.legs[0].exitFill).toEqual({ price: 9 - 0.05, source: "intrinsic" });
    expect(r.pnl).toBeCloseTo(r.contracts * (100 * (8.95 - 4.1) - 0.1), 8);
    const shortSide = simulateWeek(inputs("O1-put-writer", false, { "2025-03-07": [q("put", 600, 3.0, 3.1)] }, Object.fromEntries(HOLD.map(s => [s, s === "2025-03-13" ? 590 : 600]))), HOLD);
    expect(shortSide.legs[0].exitFill).toEqual({ price: 10 + 0.05, source: "intrinsic" });
  });

  test("regime routes O2 and O3: bearish → call spread / SPY put; bullish → put spread / QQQ call; no leg within tolerance → cash with its reason", () => {
    const S = 600, T = 7 / 365;
    const strikes = Array.from({ length: 25 }, (_, i) => 540 + 5 * i);
    const chain = strikes.flatMap(K => (["put", "call"] as const).map(t => { const p = bsPrice(S, K, T, 0.2, t); return q(t, K, Math.max(0, p - 0.05), p + 0.05); }));
    const chains = Object.fromEntries(HOLD.map(s => [s, chain]));
    const prices = Object.fromEntries(HOLD.map(s => [s, S]));
    const bear = simulateWeek(inputs("O2-credit-spread", true, chains, prices), HOLD);
    expect(bear.legs.map(l => [l.type, l.side])).toEqual([["call", "short"], ["call", "long"]]);
    expect(bear.legs[1].strike).toBeGreaterThan(bear.legs[0].strike);
    const bull = simulateWeek(inputs("O2-credit-spread", false, chains, prices), HOLD);
    expect(bull.legs.map(l => [l.type, l.side])).toEqual([["put", "short"], ["put", "long"]]);
    expect(simulateWeek(inputs("O3-convex-buyer", true, chains, prices), HOLD)).toMatchObject({ underlying: "SPY", legs: [{ type: "put", side: "long" }] });
    expect(simulateWeek(inputs("O3-convex-buyer", false, chains, prices), HOLD)).toMatchObject({ underlying: "QQQ", legs: [{ type: "call", side: "long" }] });
    const sparse = Object.fromEntries(HOLD.map(s => [s, [q("put", 600, 3.0, 3.1)]]));
    expect(simulateWeek(inputs("O2-credit-spread", false, sparse, prices), HOLD)).toMatchObject({ status: "cash", reason: "no put within 0.10 of delta ±0.30" });
    expect(simulateWeek(inputs("O1-put-writer", false, {}, prices, 100_000, { expiry: null }), HOLD)).toMatchObject({ status: "cash", reason: "no eligible expiration" });
  });

  test("costs ×2 doubles the half-spread and the fee", () => {
    const chains = { "2025-03-07": [q("put", 600, 3.0, 3.2)], "2025-03-13": [q("put", 600, 1.0, 1.2)] };
    const prices = Object.fromEntries(HOLD.map(s => [s, 600]));
    const base = simulateWeek(inputs("O1-put-writer", false, chains, prices), HOLD);
    const twice = simulateWeek(inputs("O1-put-writer", false, chains, prices, 100_000, { costs: { feePerContractPerSide: 0.05, multiplier: 2 } }), HOLD);
    expect(base.pnl).toBeCloseTo(100 * (3.0 - 1.2) - 0.1, 10);
    expect(twice.pnl).toBeCloseTo(100 * (2.9 - 1.3) - 0.2, 10);
  });
});

// ── statistics ───────────────────────────────────────────────────────────────────────────────────
describe("statistics", () => {
  test("mulberry32 is the scorecard's PRNG", () => {
    const a = mulberry32(20261109), b = scorecardMulberry32(20261109);
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
  });

  test("circular block bootstrap is deterministic for a seed and sensitive to it; p for an all-positive series is 1/(1+B)", () => {
    const x = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 0.02 + 0.002);
    const r1 = circularBlockBootstrap(x, { blockLen: 4, resamples: 2000, seed: 20261109 });
    const r2 = circularBlockBootstrap(x, { blockLen: 4, resamples: 2000, seed: 20261109 });
    const r3 = circularBlockBootstrap(x, { blockLen: 4, resamples: 2000, seed: 1 });
    expect(r1).toEqual(r2);
    expect(r1.p).not.toBe(r3.p);
    expect(r1.mean).toBeCloseTo(x.reduce((a, b) => a + b) / x.length, 12);
    expect(r1.ci90[0]).toBeLessThan(r1.mean);
    expect(r1.ci90[1]).toBeGreaterThan(r1.mean);
    const pos = circularBlockBootstrap(Array(40).fill(0.01), { blockLen: 4, resamples: 999, seed: 3 });
    expect(pos.p).toBe(1 / 1000);
    const neg = circularBlockBootstrap(Array(40).fill(-0.01), { blockLen: 4, resamples: 999, seed: 3 });
    expect(neg.p).toBe(1);
  });

  test("Holm step-down at 0.10 over three one-sided p-values", () => {
    expect(holm([0.02, 0.04, 0.2], 0.10)).toEqual([true, true, false]);
    expect(holm([0.04, 0.02, 0.09], 0.10)).toEqual([true, true, true]);
    expect(holm([0.035, 0.5, 0.5], 0.10)).toEqual([false, false, false]); // 0.035 > 0.10/3
    expect(holm([0.03, 0.06, 0.5], 0.10)).toEqual([true, false, false]); // 0.06 > 0.10/2 stops the sequence
  });

  test("max drawdown", () => {
    expect(maxDrawdown([100, 110, 99, 120, 90, 130])).toBeCloseTo(0.25, 12);
    expect(maxDrawdown([100, 101, 102])).toBe(0);
  });
});
