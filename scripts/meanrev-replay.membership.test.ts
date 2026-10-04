// PIT membership mode of the meanrev replay (runMeanRevReplay +
// ReplayConfig.membership — docstrings in backtest-momentum-wf.ts). Locked:
//   1. members ENTER only while members (a post-removal RSI2 dip never
//      re-enters);
//   2. a position held across its removal keeps its own exit rules (here:
//      the TIME_STOP fires after the removal date);
//   3. a tape that ENDS inside the fold closes "DELISTED" at the last
//      available close;
//   4. a dead member tape does NOT block the day's entries for everyone
//      (the engine's all-universe freshness gate exempts ineligible
//      symbols): another member still enters AFTER the delisting.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMeanRevReplay } from "./meanrev-replay";
import { writeMembership } from "./import-sp500-membership";
import type { ReplayConfig } from "./backtest-momentum-wf";

const DAY = 86_400_000;
const TAPE_FROM = Date.parse("2022-10-03T05:00:00Z"); // a Monday
const WIN = { label: "pit-mr", from: "2023-01-02", to: "2023-06-01" };

/** Per-date close-to-close return overrides (default +0.3%/day). */
interface MrSpec { symbol: string; drift: number; overrides?: Record<string, number>; lastBarBefore?: string }

function writeMrDb(dbPath: string, specs: MrSpec[], tramos: Array<{ ticker: string; startDate: string; endDate: string | null }>): Map<string, Array<{ date: string; close: number; timestamp: number }>> {
  const db = new Database(dbPath);
  const out = new Map<string, Array<{ date: string; close: number; timestamp: number }>>();
  try {
    db.run(`CREATE TABLE IF NOT EXISTS historical_bars (
      symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      PRIMARY KEY(symbol, timeframe, source, timestamp)
    )`);
    const stmt = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
    const toMs = Date.parse(WIN.to) + 10 * DAY;
    for (const spec of specs) {
      const cutoff = spec.lastBarBefore ? Date.parse(spec.lastBarBefore) : Infinity;
      let close = 100;
      const bars: Array<{ date: string; close: number; timestamp: number }> = [];
      db.transaction(() => {
        for (let t = TAPE_FROM; t < toMs && t < cutoff; t += DAY) {
          const dow = new Date(t).getUTCDay();
          if (dow === 0 || dow === 6) continue;
          const date = new Date(t).toISOString().slice(0, 10);
          const open = close;
          close = close * (1 + (spec.overrides?.[date] ?? spec.drift));
          stmt.run(spec.symbol, "1d", "synthetic", t, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close, 1000);
          bars.push({ date, close, timestamp: t });
        }
      })();
      out.set(spec.symbol, bars);
    }
    writeMembership(db, tramos.map(t => ({ ticker: t.ticker, startDate: t.startDate, endDate: t.endDate })), {
      indexId: "sp500", source: "fixture", sourceCommit: "test",
    });
  } finally {
    db.close();
  }
  return out;
}

/** Two −0.2% days (RSI2 = 0 in an uptrend, close still above SMA10). */
const dip = (d1: string, d2: string) => ({ [d1]: -0.002, [d2]: -0.002 });
/** Post-entry decline (close < SMA3 ⇒ no SMA_EXIT until the time stop). */
const decline = (dates: string[]) => Object.fromEntries(dates.map(d => [d, -0.002]));

const SPECS: MrSpec[] = [
  { symbol: "ETF1", drift: 0.001 },  // declared: rising, never RSI2<5
  { symbol: "REF", drift: 0.001 },   // benchmark only
  {
    symbol: "MEMA", drift: 0.003,
    overrides: { ...dip("2023-01-12", "2023-01-13"), ...dip("2023-05-09", "2023-05-10") },
  },
  {
    symbol: "MEMR", drift: 0.003,    // removed 2023-03-01 while held
    overrides: {
      ...dip("2023-02-23", "2023-02-24"),
      ...decline(["2023-02-27", "2023-02-28", "2023-03-01", "2023-03-02", "2023-03-03", "2023-03-06"]),
      ...dip("2023-04-13", "2023-04-14"), // post-removal dip: must NOT re-enter
    },
  },
  {
    symbol: "DELX", drift: 0.003,    // tape ends 2023-04-24 while held
    overrides: { ...dip("2023-04-18", "2023-04-19"), ...decline(["2023-04-20", "2023-04-21", "2023-04-24"]) },
    lastBarBefore: "2023-04-25",
  },
];
const TRAMOS = [
  { ticker: "MEMA", startDate: "2010-01-04", endDate: null },
  { ticker: "MEMR", startDate: "2010-01-04", endDate: "2023-03-01" }, // end EXCLUSIVE
  { ticker: "DELX", startDate: "2010-01-04", endDate: null },
];

function mrCfg(dbPath: string): ReplayConfig {
  return {
    sleeve: "meanrev",
    universe: ["ETF1"],
    timeframe: "1d",
    source: "synthetic",
    refSymbol: "REF",
    rthOnly: false,
    funding: false,
    barMinutes: 1440,
    barMinutesEq: 1440,
    slippageBps: 0,
    commissionBps: 0,
    initialEquity: 50_000,
    leverage: 1,
    hardStopPct: 0.04,
    hardStop: { mode: "none" },
    cadenceMin: 1440,
    notionalPctPerSlot: 0,
    entryPct: 0,
    exitPct: 0,
    maxLongs: 0,
    maxShorts: 0,
    shortFunding: "credit",
    membership: { index: "sp500" },
    meanrev: { entryRsi: 5, smaLong: 10, smaExit: 3, timeStopDays: 5, maxPositions: 5, slotPct: 0.05 },
    warmupDays: 60,
    dbPath,
  };
}

describe("meanrev replay — PIT membership mode", () => {
  test("entries only while member; removal keeps exits; delisting closes DELISTED; dead tapes don't block entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-pit-"));
    try {
      const dbPath = join(dir, "historical.db");
      const bars = writeMrDb(dbPath, SPECS, TRAMOS);
      const r = await runMeanRevReplay(mrCfg(dbPath), WIN);
      expect(r).not.toBeNull();
      const trades = r!.closedTrades;
      const bySym = (s: string) => trades.filter(t => t.symbol === s);

      // Declared ETF (rising, no dips) never trades; members do.
      expect(bySym("ETF1")).toEqual([]);
      expect(bySym("MEMA").length).toBeGreaterThanOrEqual(2);

      // 1+2. MEMR: entered before its removal only; the held position's own
      // TIME_STOP fires AFTER the removal date (exit rules untouched).
      const removalMs = Date.parse("2023-03-01T00:00:00Z");
      const memr = bySym("MEMR");
      expect(memr.length).toBe(1); // the 2023-04 dip (post-removal) never re-enters
      expect(memr[0].entryAt!).toBeLessThan(removalMs);
      expect(memr[0].reason).toBe("TIME_STOP");
      expect(memr[0].exitAt).toBeGreaterThan(removalMs);

      // 3. DELX: tape ends 2023-04-24 while held → DELISTED at the last close.
      const delx = bySym("DELX");
      expect(delx.map(t => t.reason)).toEqual(["DELISTED"]);
      const delxBars = bars.get("DELX")!;
      expect(delx[0].exitPrice).toBeCloseTo(delxBars[delxBars.length - 1].close, 8);
      expect(delx[0].exitAt).toBeGreaterThan(delxBars[delxBars.length - 1].timestamp);

      // 4. Freshness-gate exemption: MEMA still ENTERS after DELX's tape
      // died (2023-05 dip) — a dead member tape doesn't freeze the sleeve.
      const lateEntry = bySym("MEMA").find(t => t.entryAt! > Date.parse("2023-05-01T00:00:00Z"));
      expect(lateEntry).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
