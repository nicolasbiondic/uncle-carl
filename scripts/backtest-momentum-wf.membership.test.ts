// PIT membership mode of the daily-stocks replay (ReplayConfig.membership /
// liquidityRank — see their docstrings in backtest-momentum-wf.ts). Locked:
//   1. hash identity: absent fields keep the legacy hash; present fields
//      change it (and liquidityRank is a distinct candidate from all-members).
//   2. members become the replay universe and get ENTERED while members;
//      a position held across its index removal keeps riding its exit rules;
//   3. a tape that ENDS inside the fold closes with reason "DELISTED" at the
//      last available close;
//   4. liquidityRank topN screens entries by PIT median dollar volume.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashReplayConfig, runWithConfig, type ReplayConfig } from "./backtest-momentum-wf";
import { writeMembership } from "./import-sp500-membership";
import type { OHLCV } from "../src/utils/types";

const DAY = 86_400_000;
const TAPE_FROM = Date.parse("2022-01-03T05:00:00Z"); // a Monday
const WIN = { label: "pit", from: "2022-11-01", to: "2024-06-01" };

interface Spec { symbol: string; drift: number; volume: number; lastBarBefore?: string }

/** Deterministic rising tapes on weekdays; optional tape cutoff. */
function writePitDb(dbPath: string, specs: Spec[], tramos: Array<{ ticker: string; startDate: string; endDate: string | null }>): Map<string, OHLCV[]> {
  const db = new Database(dbPath);
  const out = new Map<string, OHLCV[]>();
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
      const bars: OHLCV[] = [];
      db.transaction(() => {
        for (let t = TAPE_FROM; t < toMs && t < cutoff; t += DAY) {
          const dow = new Date(t).getUTCDay();
          if (dow === 0 || dow === 6) continue;
          const open = close;
          close = close * (1 + spec.drift);
          const b: OHLCV = { timestamp: t, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close, volume: spec.volume };
          stmt.run(spec.symbol, "1d", "synthetic", b.timestamp, b.open, b.high, b.low, b.close, b.volume);
          bars.push(b);
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

const SPECS: Spec[] = [
  { symbol: "REF", drift: 0.0002, volume: 1000 },                                  // declared, too weak to enter
  { symbol: "MEMA", drift: 0.004, volume: 1_000_000 },                             // member all window, liquid
  { symbol: "MEMB", drift: 0.003, volume: 1_000 },                                 // removed 2023-06-01 while held
  { symbol: "DELX", drift: 0.0035, volume: 1_000, lastBarBefore: "2023-09-01" },   // tape ends inside the fold
];
const TRAMOS = [
  { ticker: "MEMA", startDate: "2010-01-04", endDate: null },
  { ticker: "MEMB", startDate: "2010-01-04", endDate: "2023-06-01" }, // end EXCLUSIVE
  { ticker: "DELX", startDate: "2010-01-04", endDate: null },
];

function pitCfg(dbPath: string): ReplayConfig {
  return {
    sleeve: "stocks",
    universe: ["REF"],
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
    leverage: 2,
    hardStopPct: 0.04,
    hardStop: { mode: "none" },
    cadenceMin: 1440,
    notionalPctPerSlot: 0.2,
    entryPct: 5,
    exitPct: -2,
    maxLongs: 3,
    maxShorts: 0,
    lookbackDays: 60,
    maLengthDays: 100,
    shortFunding: "credit",
    membership: { index: "sp500" },
    warmupDays: 240,
    dbPath,
  };
}

describe("hash identity — membership / liquidityRank", () => {
  const base = pitCfg("x");
  test("absent fields = legacy hash; present fields are distinct candidates", () => {
    const { membership, ...rest } = base;
    const legacy = rest as ReplayConfig;
    expect(hashReplayConfig({ ...legacy, membership: undefined, liquidityRank: undefined })).toBe(hashReplayConfig(legacy));
    const withMembership = hashReplayConfig(base);
    expect(withMembership).not.toBe(hashReplayConfig(legacy));
    expect(hashReplayConfig({ ...base, liquidityRank: { topN: 20, lookbackSessions: 60 } })).not.toBe(withMembership);
    expect(hashReplayConfig({ ...base, membership: { index: "sp500", exclude: ["AAPL"] } })).not.toBe(withMembership);
  });
});

describe("daily stocks replay — PIT membership mode", () => {
  test("members trade while members; removal keeps exit rules; delisting closes DELISTED at the last close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-pit-"));
    try {
      const dbPath = join(dir, "historical.db");
      const bars = writePitDb(dbPath, SPECS, TRAMOS);
      const r = await runWithConfig(pitCfg(dbPath), WIN);
      expect(r).not.toBeNull();

      const trades = r!.closedTrades;
      const bySym = (s: string) => trades.filter(t => t.symbol === s);
      // Members entered (the hook let them into the ranking).
      expect(bySym("MEMA").length).toBeGreaterThan(0);
      expect(bySym("MEMB").length).toBeGreaterThan(0);
      expect(bySym("DELX").length).toBeGreaterThan(0);
      // REF (declared, weak signal) never entered.
      expect(bySym("REF")).toEqual([]);

      // 2. NO MEMB entry on/after its removal date (end EXCLUSIVE)…
      const removalMs = Date.parse("2023-06-01T00:00:00Z");
      for (const t of bySym("MEMB")) expect(t.entryAt!).toBeLessThan(removalMs);
      // …but the position HELD at removal kept riding its exit rules: it
      // exits well after the removal (here: at the fold edge, still long).
      const held = bySym("MEMB").find(t => t.exitAt > removalMs);
      expect(held).toBeDefined();
      expect(held!.reason).toBe("fold_end");

      // 3. DELX's tape ends 2023-08-31: the held position closes DELISTED
      // at the last available close (0 slippage ⇒ exact).
      const delisted = trades.filter(t => t.reason === "DELISTED");
      expect(delisted.map(t => t.symbol)).toEqual(["DELX"]);
      const delxBars = bars.get("DELX")!;
      const lastClose = delxBars[delxBars.length - 1].close;
      expect(delisted[0].exitPrice).toBeCloseTo(lastClose, 8);
      expect(delisted[0].exitAt).toBeGreaterThan(delxBars[delxBars.length - 1].timestamp);
      expect(delisted[0].exitAt).toBeLessThan(Date.parse(WIN.to)); // inside the fold, not fold_end

      // tradesBySymbol covers the expanded universe.
      expect(Object.keys(r!.tradesBySymbol).sort()).toEqual(["DELX", "MEMA", "MEMB", "REF"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("liquidityRank topN=1 screens entries to the highest-dollar-volume member", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-pit-lr-"));
    try {
      const dbPath = join(dir, "historical.db");
      writePitDb(dbPath, SPECS, TRAMOS);
      const cfg = { ...pitCfg(dbPath), liquidityRank: { topN: 1, lookbackSessions: 20 } };
      const r = await runWithConfig(cfg, WIN);
      expect(r).not.toBeNull();
      const traded = new Set(r!.closedTrades.map(t => t.symbol));
      // MEMA is the only member inside topN=1 (1M dollar-volume vs 1k).
      expect(traded.has("MEMA")).toBe(true);
      expect(traded.has("MEMB")).toBe(false);
      expect(traded.has("DELX")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
