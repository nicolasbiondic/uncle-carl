import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimBroker, dailyClosesFromBars, hashReplayConfig, runWithConfig, type ReplayConfig } from "./backtest-momentum-wf";
import { candidateToReplayConfig, runWalkForward, validateCandidate, validateManifest, type ExperimentManifest } from "./walk-forward";
import { MomentumEngine, idleOverlayHistoryDays, type IdleOverlayConfig, type MomentumBrokerAdapter } from "../src/strategies/momentum/MomentumEngine";
import { FakeBroker, silentLogger } from "../src/test-support/momentum";
import { TestClock } from "../src/utils/clock";
import type { OHLCV } from "../src/utils/types";

const D = 86400000, H = D / 24, T = Date.parse("2024-01-01T00:00:00Z");
const read = (name: string): ExperimentManifest => JSON.parse(readFileSync(join(import.meta.dir, "../experiments", `${name}.json`), "utf8"));
const name = "momentum-crypto-rw5-idle-tsm12-pure-v1";
const liveName = "momentum-crypto-rw3-vt-35-corroff-pure-v1";
const overlay = read(name).candidates[0].idleOverlay!;
const risk = { softDrawdownPct: 1, hardDrawdownPct: 1, dailyLossCapPct: 1, consecutiveLossLimit: 100000 };
function series(sign: number, days = idleOverlayHistoryDays(overlay)) {
  let p = 100;
  return Array.from({ length: days }, (_, i) => {
    p *= 1 + sign * 0.002 + (i % 2 ? 0.015 : -0.015);
    return { dayEndMs: T - (days - 1 - i) * D, close: p };
  });
}
function prices(from = T - 2 * D, to = T + 35 * D): OHLCV[] {
  return Array.from({ length: (to - from) / H }, (_, i) => ({ timestamp: from + i * H, open: 100, high: 100, low: 100, close: 100, volume: 1000 }));
}

describe("idle overlay protocol and default-off identity", () => {
  test("ONE candidate, live config plus ONLY the knob, prior 454; absent hashes unchanged", () => {
    const m = validateManifest(read(name)), live = validateManifest(read(liveName));
    const { name: _n, description: _d, trialAccounting: _t, candidates: _c, ...rest } = m;
    const { name: _ln, description: _ld, trialAccounting: _lt, candidates: _lc, ...base } = live;
    expect(rest).toEqual(base);
    expect(m.candidates).toHaveLength(1);
    const { idleOverlay, ...candidate } = m.candidates[0];
    expect(candidate).toEqual(live.candidates[0]);
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 454, complete: false });
    expect(m.description).toContain("PRE-REGISTERED (2026-10-24) BEFORE any run");
    const cfg = candidateToReplayConfig(m, m.candidates[0], "base");
    const off = candidateToReplayConfig(live, live.candidates[0], "base");
    expect(cfg.idleOverlay).toEqual(idleOverlay);
    expect(hashReplayConfig({ ...cfg, idleOverlay: undefined })).toBe(hashReplayConfig(off));
    expect(hashReplayConfig(cfg)).not.toBe(hashReplayConfig(off));
    expect(hashReplayConfig({ ...cfg, idleOverlay: { ...overlay, volTargetPerAsset: 0.3 } })).not.toBe(hashReplayConfig(cfg));
  });

  test("strict shape, price/fraction units, supported perpetual universe and long-only primary book", () => {
    const m = read(name), c = m.candidates[0];
    for (const invalid of [null, [], {}, { ...overlay, typo: 1 }, { ...overlay, symbols: ["SOL/USD"] }, { ...overlay, symbols: ["BTC/USD", "BTC/USD"] }, { ...overlay, lookbackDays: 1.5 }, { ...overlay, volTargetPerAsset: 40 }, { ...overlay, ewmaCenterOfMassDays: 0 }, { ...overlay, annualization: 261 }]) {
      expect(() => validateCandidate({ ...c, idleOverlay: invalid })).toThrow("idleOverlay");
    }
    expect(() => validateCandidate({ ...c, maxShorts: 1 })).toThrow("idleOverlay");
    expect(() => validateCandidate({ name: "mr", cadenceMin: 1440, meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 }, idleOverlay: overlay })).toThrow("momentum-only");
    expect(() => validateManifest({ ...m, sleeve: "stocks" })).toThrow("idleOverlay");
    expect(() => validateManifest({ ...m, data: { ...m.data, funding: false } })).toThrow("idleOverlay");
  });
});

describe("idle overlay causal live/sim path (synthetic only)", () => {
  test("forming day cannot change the signal or volatility; simultaneous daily knobs use the deepest history", async () => {
    const b = new SimBroker(10000, new Map(), 0, 0, H, { leverage: 2, maintRate: 0.005 });
    const s = series(-1);
    b.idleOverlayDaily = new Map([["BTC/USD", { dayEndMs: [...s.map(p => p.dayEndMs), T + D], closes: [...s.map(p => p.close), 1e20] }]]);
    b.trendExitDaily = new Map([["BTC/USD", { dayEndMs: [T], closes: [s.at(-1)!.close] }]]);
    b.now = T;
    const atBoundary = await b.fetchDailyCloses("BTC/USD", 611);
    b.now = T + 23 * H;
    expect(await b.fetchDailyCloses("BTC/USD", 611)).toEqual(atBoundary);
    expect(atBoundary).toHaveLength(611);
    expect(atBoundary.at(-1)).toBe(s.at(-1)!.close);
    b.now = T + D;
    expect((await b.fetchDailyCloses("BTC/USD", 611)).at(-1)).toBe(1e20);
  });

  test("strict UTC history rejects stale/gapped days and partial intraday aggregates instead of compressing the 365-day clock", async () => {
    const bars = prices(T - 3 * D, T);
    const complete = dailyClosesFromBars(bars, H);
    expect(complete.closes).toHaveLength(3);
    const gapped = dailyClosesFromBars(bars.filter(b => b.timestamp !== T - D - H), H);
    expect(gapped.closes).toHaveLength(2);
    const b = new SimBroker(10000, new Map(), 0, 0, H, { leverage: 2, maintRate: 0.005 });
    b.now = T;
    b.idleOverlayDaily = new Map([["BTC/USD", complete]]);
    expect(await b.fetchDailyCloses("BTC/USD", 3, { strictUtc: true })).toHaveLength(3);
    b.idleOverlayDaily.set("BTC/USD", gapped);
    expect(await b.fetchDailyCloses("BTC/USD", 2, { strictUtc: true })).toEqual([]);
    expect(await b.fetchDailyCloses("BTC/USD", 2)).toHaveLength(2); // legacy contracts unchanged
  });

  test("shared engine gives the same live-like/sim decisions, monthly baskets, exits and priority", async () => {
    const clock = new TestClock(T), tape = prices();
    const sim = new SimBroker(10000, new Map(overlay.symbols.map(s => [s, tape])), 0, 0, H, { leverage: 2, maintRate: 0.005 });
    let signal = false;
    const ranking = (s: string) => prices().slice(0, 50).map((b, i) => ({ ...b, close: signal && s === "BTC/USD" ? 100 + i : 100 }));
    sim.fetchCandles = async s => ranking(s);
    const histories = new Map(overlay.symbols.map((symbol, i) => {
      const s = series(i ? -1 : 1);
      return [symbol, { dayEndMs: s.map(p => p.dayEndMs), closes: s.map(p => p.close) }] as const;
    }));
    sim.idleOverlayDaily = histories;
    const live = new class extends FakeBroker {
      async fetchCandles(s: string) { return ranking(s); }
      async fetchDailyCloses(s: string, days: number) {
        const d = histories.get(s)!;
        return d.closes.filter((_, i) => d.dayEndMs[i] <= clock.now()).slice(-days);
      }
      async openPosition(a: Parameters<MomentumBrokerAdapter["openPosition"]>[0]) {
        const res = await super.openPosition(a);
        if (a.role) Object.assign(this.positions.at(-1)!, { role: a.role });
        return res;
      }
    }();
    const cfg = { universe: overlay.symbols, rebalanceMinutes: 60, historyBars: 50,
      tsm: { barMinutes: 60, lookbackDays: 1, maLengthDays: 1, maxLongs: 1, maxShorts: 0 },
      regime: { enabled: false }, risk, idleOverlay: overlay };
    const le = new MomentumEngine(cfg, live, silentLogger, undefined, clock), se = new MomentumEngine(cfg, sim, silentLogger, undefined, clock);
    for (const t of [T, T + H, T + 2 * H, T + 3 * H]) {
      if (t === T + 2 * H) signal = true;
      sim.now = t; clock.set(t); live.equity = sim.equityNow();
      const lr = await le.tick(), sr = await se.tick();
      expect(sr.decisions).toEqual(lr.decisions);
      expect(sr.actions).toEqual(lr.actions);
      if (t === T) sim.accrueIdleOverlayActivity(T, T + D);
      expect((await sim.getOpenPositions()).map(p => ({ symbol: p.symbol, side: p.side, role: p.role }))).toEqual((await live.getOpenPositions()).map(p => ({ symbol: p.symbol, side: p.side, role: (p as any).role })));
    }
    expect(sim.idleOverlayStats).toMatchObject({ opens: 2, closes: 2, orders: 4 });
    expect(sim.idleOverlayStats).toMatchObject({ activeDays: 1, longDays: 1, shortDays: 1 });
    expect(sim.closed.every(t => t.engineCloseReason === "IDLE_OVERLAY_EXIT")).toBe(true);
  });

  test("full synthetic replay loads extra daily history, skips protective stops, pays funding and counts time/orders; extra history changes DATA identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idle-synthetic-")), path = join(dir, "synthetic.db");
    try {
      const db = new Database(path);
      db.exec("CREATE TABLE historical_bars(symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL); CREATE TABLE funding_rates(symbol TEXT, funding_time INTEGER, rate REAL)");
      const q = db.query("INSERT INTO historical_bars VALUES (?, '1h', 'binance_futures', ?, ?, ?, ?, ?, 1000)");
      db.transaction(() => {
        for (const symbol of overlay.symbols) {
          let px = 100;
          for (let day = -630; day < 4; day++) {
            px *= 1 - 0.002 + (day % 2 ? 0.015 : -0.015);
            for (let hour = 0; hour < 24; hour++) q.run(symbol, T + day * D + hour * H, px, px * 2, px / 2, px);
          }
          for (let t = T; t <= T + 3 * D; t += 8 * H) db.query("INSERT INTO funding_rates VALUES (?, ?, ?)").run(symbol.replace("/USD", "USDT"), t, -0.0001);
        }
      })();
      const m = read(name);
      m.data = { ...m.data, dbPath: path, universe: overlay.symbols };
      m.window = { ...m.window, from: new Date(T).toISOString(), to: new Date(T + 3 * D).toISOString(), outerFoldCount: 1, innerFoldCount: 0, purgeYears: 0 };
      m.asOf = new Date(T + 3 * D).toISOString();
      m.candidates = [{ ...m.candidates[0], entryPct: 100000, sharpeGate: undefined, volTarget: undefined, risk, regime: "off" }];
      const cfg = candidateToReplayConfig(m, m.candidates[0], "base");
      const win = { label: "synthetic", from: m.window.from, to: m.window.to };
      const r = await runWithConfig(cfg, win);
      expect(r).not.toBeNull();
      expect(r!.idleOverlayStats).toMatchObject({ opens: 2, closes: 2, orders: 4, longDays: 0 });
      expect(r!.idleOverlayStats!.activeDays).toBeCloseTo(3, 8);
      expect(r!.idleOverlayStats!.shortDays).toBeCloseTo(3, 8);
      expect(r!.idleOverlayStats!.fundingPaid).toBeGreaterThan(0); // negative funding makes shorts pay
      expect(r!.idleOverlayStats!.fundingPaid).toBeCloseTo(r!.funding, 8);
      expect(r!.closedTrades.every(t => t.reason === "fold_end")).toBe(true); // +/-50% intrabar never fires a stop
      const off = await runWithConfig({ ...cfg, idleOverlay: undefined }, win);
      expect(off!).not.toHaveProperty("idleOverlayStats");
      const a = await runWalkForward(m, { dryRun: true, codeFiles: [] });
      db.query("UPDATE historical_bars SET close = close * 1.001 WHERE timestamp = ?").run(T - 600 * D);
      const b = await runWalkForward(m, { dryRun: true, codeFiles: [] });
      expect(a.summary.configHash).toBe(b.summary.configHash);
      expect(a.summary.dataHash).not.toBe(b.summary.dataHash);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
