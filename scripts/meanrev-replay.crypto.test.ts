/**
 * Crypto-perps mode of the meanrev replay (scripts/meanrev-replay.ts,
 * source = "binance_futures" — see that file's header for the declared
 * biases). Three properties the W6 pre-registration demanded tests for:
 *
 *   1. CALENDAR 24/7 — every UTC day with a bar is a session: the replay
 *      produces ~one daily equity observation per CALENDAR day (weekends
 *      included), not ~5/7 like the equity calendar.
 *   2. FUNDING — settled funding_rate events are charged on the long book
 *      with SimBroker-compatible semantics: exclusive-left boundaries,
 *      per-position entryTime bound, notional at the last completed close,
 *      equity reduced by exactly the funding total, decisions untouched.
 *   3. NO-LOOKAHEAD — the execution bar can never leak into a decision:
 *      mutating the LAST bar of the window changes nothing decided before
 *      it (all earlier closed trades bit-identical) and nothing about the
 *      entries filled AT it except what the open legitimately prices.
 *
 * Deterministic synthetic tapes (scripts/lib/syntheticCandles.ts) — no
 * dependency on the gitignored data/historical.db.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runMeanRevReplay, SimMeanRevBroker } from "./meanrev-replay";
import { FundingBook, type ReplayConfig } from "./backtest-momentum-wf";
import { writeSyntheticDb, type SyntheticTapeSpec } from "./lib/syntheticCandles";
import { getETDateKey } from "../src/db/database";

const DAY = 86_400_000;
const H8 = 8 * 3_600_000;

const TAPE: SyntheticTapeSpec = {
  timeframe: "1d",
  source: "binance_futures",
  fromMs: Date.parse("2023-01-01T00:00:00Z"), // UTC midnight opens, like real perp 1d bars
  bars: 500,
};

const SPECS = [
  { symbol: "AAA/USD", seed: 2101, startPrice: 40_000, driftAnnual: 0.5, volAnnual: 0.55 },
  { symbol: "BBB/USD", seed: 2202, startPrice: 2_500, driftAnnual: 0.4, volAnnual: 0.65 },
  { symbol: "CCC/USD", seed: 2303, startPrice: 95, driftAnnual: 0.6, volAnnual: 0.6 },
];

const WIN = { label: "crypto-fp", from: "2023-06-01", to: "2024-04-01" };
const WIN_DAYS = (Date.parse(WIN.to) - Date.parse(WIN.from)) / DAY; // 305 UTC days

/** funding_rates fixture: constant `rate` every 8h over [fromMs, toMs]. */
function writeFundingRates(dbPath: string, perpSymbols: string[], fromMs: number, toMs: number, rate: number): void {
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS funding_rates (
      symbol TEXT, funding_time INTEGER, rate REAL,
      PRIMARY KEY(symbol, funding_time)
    )`);
    const stmt = db.prepare("INSERT OR REPLACE INTO funding_rates VALUES (?,?,?)");
    const insertAll = db.transaction(() => {
      for (const sym of perpSymbols) {
        for (let t = fromMs; t <= toMs; t += H8) stmt.run(sym, t, rate);
      }
    });
    insertAll();
  } finally {
    db.close();
  }
}

function cryptoConfig(dbPath: string, funding: boolean): ReplayConfig {
  return {
    sleeve: "meanrev",
    universe: SPECS.map(s => s.symbol),
    timeframe: "1d",
    source: "binance_futures",
    refSymbol: "AAA/USD", // traded + benchmark, like BTC/USD in the real manifest
    rthOnly: false,
    funding,
    barMinutes: 1440,
    barMinutesEq: 1440,
    slippageBps: 5,
    commissionBps: 4,
    initialEquity: 5000,
    leverage: 1,
    hardStopPct: 0.04,
    cadenceMin: 1440,
    notionalPctPerSlot: 0.25,
    entryPct: 0,
    exitPct: 0,
    maxLongs: 0,
    maxShorts: 0,
    shortFunding: "credit",
    meanrev: { entryRsi: 5, smaLong: 50, smaExit: 5, timeStopDays: 10, maxPositions: 2, slotPct: 0.25 },
    warmupDays: 90,
    dbPath,
  };
}

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meanrev-crypto-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("meanrev replay — crypto perps mode (binance_futures)", () => {
  test("24/7 calendar: one daily observation per UTC CALENDAR day, weekends included; fractional qty", () => withTmp(async dir => {
    const dbPath = join(dir, "historical.db");
    writeSyntheticDb(dbPath, TAPE, SPECS);

    const r = await runMeanRevReplay(cryptoConfig(dbPath, false), WIN);
    expect(r).not.toBeNull();

    // ~one equity observation per CALENDAR day: 305-day window ⇒ ≥ 300
    // daily returns (the equity calendar would cap this at ~210).
    expect(r!.dailyReturns.length).toBeGreaterThanOrEqual(WIN_DAYS - 3);
    // Saturdays AND Sundays are sessions.
    const dows = new Set(r!.dailyReturns.map(d => new Date(`${d.date}T00:00:00Z`).getUTCDay()));
    expect(dows.has(0)).toBe(true);
    expect(dows.has(6)).toBe(true);

    // Anti-vacuity + fractional sizing: a $1250 slot of a $40k coin is
    // sub-1-unit — whole-share flooring would have produced zero trades.
    expect(r!.trades).toBeGreaterThanOrEqual(3);
    expect(r!.closedTrades.some(t => t.qty !== undefined && !Number.isInteger(t.qty))).toBe(true);
  }), 60_000);

  test("funding: long book pays settled events; equity down by exactly the funding total; decisions untouched", () => withTmp(async dir => {
    const dbPath = join(dir, "historical.db");
    writeSyntheticDb(dbPath, TAPE, SPECS);
    writeFundingRates(
      dbPath,
      SPECS.map(s => s.symbol.replace("/USD", "USDT")),
      TAPE.fromMs - H8,
      Date.parse(WIN.to) + DAY,
      1e-4, // +0.01%/8h: longs pay
    );

    const rNo = await runMeanRevReplay(cryptoConfig(dbPath, false), WIN);
    const rF = await runMeanRevReplay(cryptoConfig(dbPath, true), WIN);
    expect(rNo).not.toBeNull();
    expect(rF).not.toBeNull();

    // Positive funding regime on a long-only book: a real, positive cost.
    expect(rF!.funding).toBeGreaterThan(0);
    // Same tape, same fills: funding must not alter any decision here (the
    // charge is ~bps of a slot — far from every RiskGuard threshold).
    const sig = (r: NonNullable<typeof rNo>) => r.closedTrades.map(t => `${t.symbol}|${t.entryAt}|${t.qty}`);
    expect(sig(rF!)).toEqual(sig(rNo!));
    // Equity identity: the ONLY economic difference is the funding paid.
    expect(rNo!.finalEquity - rF!.finalEquity).toBeCloseTo(rF!.funding, 6);
    // Per-symbol attribution sums to the total.
    const bySym = Object.values(rF!.tradesBySymbol).reduce((s, v) => s + v.funding, 0);
    expect(bySym).toBeCloseTo(rF!.funding, 6);
  }), 60_000);

  test("funding unit semantics: exclusive-left boundary, entryTime bound, last-completed-close mark", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meanrev-funding-unit-"));
    try {
      const dbPath = join(dir, "funding.db");
      const D0 = Date.parse("2023-03-01T00:00:00Z");
      const D1 = D0 + DAY;
      const D2 = D0 + 2 * DAY;
      writeFundingRates(dbPath, ["AAAUSDT"], D0 - H8, D2 + 2 * DAY, 1e-4);
      const db = new Database(dbPath, { readonly: true });
      const book = new FundingBook(db, ["AAA/USD"], D0, D2);

      const bars = [D0, D1, D2].map((ts, i) => ({
        timestamp: ts, open: 100 + 10 * i, high: 125, low: 95, close: 100 + 10 * i, date: getETDateKey(ts),
      }));
      const series = new Map([["AAA/USD", {
        bars,
        closes: bars.map(b => b.close),
        indexByDate: new Map(bars.map((b, i) => [b.date, i])),
      }]]);
      const cfg = { slippageBps: 0, commissionBps: 0, initialEquity: 5000 } as ReplayConfig;
      const broker = new SimMeanRevBroker(cfg, series as any, { mode: "none" }, book, true);
      broker.positions.push({
        symbol: "AAA/USD", qty: 2, entryPrice: 100, entryTime: D1, entryFee: 0, mark: 100, stopFrac: null, fundingCost: 0,
      } as any);
      broker.currentDate = bars[2].date; // replaying D2: last COMPLETED close = D1's 110

      // Events strictly AFTER max(D0, entryTime=D1), up to and including D2:
      // D1+8h, D1+16h, D2 ⇒ 3 × qty 2 × mark 110 × 1e-4 = 0.066.
      broker.applyFunding(D0, D2);
      expect(broker.fundingPaid).toBeCloseTo(0.066, 9);
      expect((broker.positions[0] as any).fundingCost).toBeCloseTo(0.066, 9);

      // Exclusive-left + entryTime bound: (D1, D1] is empty — the settlement
      // stamped exactly at the entry instant is never paid.
      const before = broker.fundingPaid;
      broker.applyFunding(D0, D1);
      expect(broker.fundingPaid).toBe(before);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-lookahead: mutating the LAST bar changes nothing decided before it, and same-day entries fill at the same open", () => withTmp(async dir => {
    const dbA = join(dir, "a.db");
    const dbB = join(dir, "b.db");
    writeSyntheticDb(dbA, TAPE, SPECS);
    writeSyntheticDb(dbB, TAPE, SPECS);

    // Mutate every symbol's LAST in-window bar in B: crash the close (and
    // low) 30% — if any decision could see the execution bar, entries/exits
    // decided on or before that day would diverge.
    const lastTs = Date.parse(WIN.to) - DAY;
    const db = new Database(dbB);
    db.run(`UPDATE historical_bars SET close = close * 0.7, low = MIN(low, close * 0.7) WHERE timestamp = ${lastTs}`);
    db.close();

    const rA = await runMeanRevReplay(cryptoConfig(dbA, false), WIN);
    const rB = await runMeanRevReplay(cryptoConfig(dbB, false), WIN);
    expect(rA).not.toBeNull();
    expect(rB).not.toBeNull();

    // Every trade fully closed BEFORE the mutated bar is bit-identical.
    const closedBefore = (r: NonNullable<typeof rA>) => r.closedTrades.filter(t => t.exitAt < lastTs);
    expect(closedBefore(rA!).length).toBeGreaterThanOrEqual(3); // anti-vacuity
    expect(closedBefore(rB!)).toEqual(closedBefore(rA!));

    // Entries decided ON the last day (signal = previous completed bars,
    // fill = last bar's UNCHANGED open) are the same set at the same price.
    const entriesAt = (r: NonNullable<typeof rA>) =>
      r.closedTrades.filter(t => t.entryAt === lastTs).map(t => `${t.symbol}|${t.entryPrice}|${t.qty}`).sort();
    expect(entriesAt(rB!)).toEqual(entriesAt(rA!));
  }), 60_000);
});
