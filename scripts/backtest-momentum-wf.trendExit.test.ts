import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimBroker, dailyClosesFromBars, hashReplayConfig, runWithConfig, type ReplayConfig } from "./backtest-momentum-wf";
import { candidateToReplayConfig, validateCandidate, validateManifest, type CandidateConfig } from "./walk-forward";
import { MomentumEngine, completedDailyCloses, type MomentumEngineConfig } from "../src/strategies/momentum/MomentumEngine";
import { FakeBroker, silentLogger } from "../src/test-support/momentum";
import { TestClock } from "../src/utils/clock";
import type { OHLCV } from "../src/utils/types";

const D = 86_400_000, H = D / 24, T = Date.parse("2024-01-01T00:00:00Z");
const TREND = { smaDays: 3, basis: "dailyClose" as const };
const risk = { softDrawdownPct: 1, hardDrawdownPct: 1, dailyLossCapPct: 1, consecutiveLossLimit: 10000 };
const candidate: CandidateConfig = { name: "synthetic", cadenceMin: 60, entryPct: 0, exitPct: -2, maxLongs: 1, maxShorts: 0 };
function tape(barMs: number): OHLCV[] {
  const prices = [140, 99, 100, 150, 151, 152, 153, 154];
  return prices.flatMap((p, day) => Array.from({ length: D / barMs }, (_, i) => {
    const c = p - 1 + (i + 1) / (D / barMs);
    return { timestamp: T + day * D + i * barMs, open: c, high: c, low: c, close: c, volume: 1000 };
  }));
}
function config(dbPath: string, barMs: number): ReplayConfig {
  return {
    sleeve: "crypto", universe: ["AAA"], timeframe: barMs === D ? "1d" : "1h", source: "binance_futures",
    refSymbol: "AAA", rthOnly: false, funding: false, barMinutes: barMs / 60000, barMinutesEq: barMs / 60000,
    slippageBps: 0, commissionBps: 0, initialEquity: 10000, leverage: 2, hardStopPct: 1,
    cadenceMin: barMs / 60000, notionalPctPerSlot: 0.1, entryPct: 0, exitPct: -2, maxLongs: 1, maxShorts: 0,
    shortFunding: "credit", lookbackDays: barMs / D, maLengthDays: 2 * barMs / D,
    regime: { enabled: false }, risk, warmupDays: barMs === D ? 20 : 2, dbPath,
  };
}

describe("trendExit protocol validation and identity", () => {
  test.each([
    ["momentum-crypto-rw5-trendexit65-pure-v1", "momentum-crypto-rw3-vt-35-corroff-pure-v1", 446],
    ["momentum-crypto-usdc-daily-s5-rw5-trendexit65-pure-v1", "momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1", 447],
  ] as const)("%s copies the LIVE manifest with ONLY trendExit added", (name, liveName, prior) => {
    const read = (n: string) => validateManifest(JSON.parse(readFileSync(join(import.meta.dir, "../experiments", `${n}.json`), "utf8")));
    const m = read(name), live = read(liveName);
    const { name: _n, description: _d, trialAccounting: _t, candidates: _c, ...rest } = m;
    const { name: _ln, description: _ld, trialAccounting: _lt, candidates: _lc, ...liveRest } = live;
    expect(rest).toEqual(liveRest);
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
    expect(m.candidates).toHaveLength(1);
    const { name: _cn, trendExit, ...c } = m.candidates[0];
    const { name: _lcn, ...lc } = live.candidates[0];
    expect(c).toEqual(lc);
    expect(trendExit).toEqual({ smaDays: 65, basis: "dailyClose" });
    const cfg = candidateToReplayConfig(m, m.candidates[0], "base");
    expect(cfg.trendExit).toEqual(trendExit);
    const { trendExit: _knob, ...off } = cfg;
    expect(hashReplayConfig(off)).toBe(hashReplayConfig(candidateToReplayConfig(live, live.candidates[0], "base")));
  });

  test("strict shape, momentum only; absent stays the legacy hash", () => {
    expect(() => validateCandidate({ ...candidate, trendExit: TREND })).not.toThrow();
    for (const bad of [null, [], "on", {}, { ...TREND, smaDays: 1 }, { ...TREND, smaDays: 2.5 }, { ...TREND, basis: "hourly" }, { ...TREND, typo: 1 }]) {
      expect(() => validateCandidate({ ...candidate, trendExit: bad })).toThrow("trendExit");
    }
    expect(() => validateCandidate({ name: "mr", cadenceMin: 1440, meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 }, trendExit: TREND })).toThrow("momentum-only");
    const cfg = config("synthetic.db", H);
    expect(hashReplayConfig({ ...cfg, trendExit: undefined })).toBe(hashReplayConfig(cfg));
    expect(hashReplayConfig({ ...cfg, trendExit: TREND })).not.toBe(hashReplayConfig(cfg));
    expect(hashReplayConfig({ ...cfg, trendExit: { ...TREND, smaDays: 65 } })).not.toBe(hashReplayConfig({ ...cfg, trendExit: TREND }));
  });
});

describe("live/sim trend decision parity (synthetic only)", () => {
  test("coexisting daily gates use the deepest same-symbol history", async () => {
    const b = new SimBroker(10000, new Map(), 0, 0, H, { leverage: 2, maintRate: 0.005 });
    b.now = T + 100 * D;
    const series = (n: number) => ({ dayEndMs: Array.from({ length: n }, (_, i) => T + (101 - n + i) * D), closes: Array(n).fill(100) });
    b.marketTrendDaily = { symbol: "AAA", ...series(10) };
    b.trendExitDaily = new Map([["AAA", series(65)]]);
    expect(await b.fetchDailyCloses("AAA", 65)).toHaveLength(65);
    b.shortRegimeDaily = { symbol: "AAA", ...series(90) };
    expect(await b.fetchDailyCloses("AAA", 90)).toHaveLength(90);
  });
  test.each([H, D])("same inventory exit, entry block and recovery on %d ms bars", async barMs => {
    const bars = tape(barMs);
    const sim = new SimBroker(10000, new Map([["AAA", bars]]), 0, 0, barMs, { leverage: 2, maintRate: 0.005 }, 1);
    sim.trendExitDaily = new Map([["AAA", dailyClosesFromBars(bars)]]);
    sim.seedPositions([{ symbol: "AAA", side: "buy", qty: 10, entryPrice: 100, entryAt: T + 2 * D }]);
    const live = new FakeBroker();
    live.positions = [{ symbol: "AAA", side: "buy", quantity: 10, notional: 1000 }];
    const clock = new TestClock(T + 3 * D);
    // Live seam returns ONLY completed UTC daily closes, independently from
    // SimBroker's full-tape daily registry + binary search at its clock.
    const dailyLive = Object.assign(live, { fetchDailyCloses: async () => completedDailyCloses(bars.filter(b => b.timestamp + barMs <= clock.now()), barMs).slice(-3) });
    const cfg: Partial<MomentumEngineConfig> = {
      universe: ["AAA"], historyBars: 100, rebalanceMinutes: barMs / 60000, notionalPctPerSlot: 0.1,
      tsm: { barMinutes: barMs / 60000, lookbackDays: barMs / D, maLengthDays: 2 * barMs / D, entryThresholdPct: 0, maxLongs: 1 },
      regime: { enabled: false }, risk, trendExit: TREND,
    };
    const le = new MomentumEngine(cfg, dailyLive, silentLogger, undefined, clock);
    const se = new MomentumEngine(cfg, sim, silentLogger, undefined, clock);
    const decisionTimes = [T + 3 * D, T + 3 * D + (barMs === H ? 12 * H : 0), T + 4 * D];
    for (const [i, t] of decisionTimes.entries()) {
      if (i === 1 && barMs === D) continue;
      clock.set(t); sim.now = t;
      live.setCandles("AAA", bars.filter(b => b.timestamp + barMs <= t));
      const lr = await le.tick(), sr = await se.tick();
      expect(sr.decisions).toEqual(lr.decisions);
      const actions = (r: typeof lr) => r.actions.map(a => ({ type: a.type, side: a.side, symbol: a.symbol, closeReason: a.closeReason }));
      expect(actions(sr)).toEqual(actions(lr));
      if (i === 0) expect(sr.actions[0].closeReason).toBe("TREND_EXIT");
      if (i === 1) expect(sr.actions).toEqual([]); // forming day recovered: daily rule still blocks
      if (i === 2) expect(sr.actions[0].type).toBe("open");
    }
    expect(sim.trendExitOrders).toEqual({ exits: 1, reentries: 1, orders: 2 });
    expect(sim.closed[0].engineCloseReason).toBe("TREND_EXIT");
  });

  test.each([H, D])("full replay wires daily history and counts extra orders on %d ms bars", async barMs => {
    const dir = mkdtempSync(join(tmpdir(), "trendexit-synthetic-"));
    const path = join(dir, "synthetic.db");
    try {
      const db = new Database(path);
      db.exec("CREATE TABLE historical_bars (symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL)");
      const cfg = config(path, barMs);
      const q = db.query("INSERT INTO historical_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const history = barMs === D
        ? Array.from({ length: 20 }, (_, i) => ({ timestamp: T - (20 - i) * D, open: 140, high: 140, low: 140, close: 140, volume: 1000 }))
        : [];
      db.transaction(() => { for (const b of [...history, ...tape(barMs)]) q.run("AAA", cfg.timeframe, cfg.source, b.timestamp, b.open, b.high, b.low, b.close, b.volume); })();
      db.close();
      const win = { label: "synthetic", from: new Date(T + 3 * D).toISOString(), to: new Date(T + 7 * D).toISOString() };
      const seeds = [{ symbol: "AAA", side: "buy" as const, qty: 10, entryPrice: 100, entryAt: T + 2 * D }];
      const off = await runWithConfig(cfg, win, undefined, seeds);
      const on = await runWithConfig({ ...cfg, trendExit: TREND }, win, undefined, seeds);
      expect(off).not.toBeNull(); expect(on).not.toBeNull();
      expect(off!).not.toHaveProperty("trendExitStats");
      expect(off!.closedTrades.some(t => t.engineCloseReason === "TREND_EXIT")).toBe(false);
      expect(on!.trendExitStats).toEqual({ exits: 1, reentries: 1, orders: 2 });
      expect(on!.closedTrades.filter(t => t.engineCloseReason === "TREND_EXIT")).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
