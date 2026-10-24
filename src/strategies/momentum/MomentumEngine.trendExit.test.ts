import { describe, expect, test } from "bun:test";
import { MomentumEngine, completedDailyCloses, marketTrendBlocked, type MomentumEngineConfig } from "./MomentumEngine";
import { FakeBroker, MemoryPersistence, silentLogger } from "../../test-support/momentum";
import { TestClock } from "../../utils/clock";
import type { OHLCV } from "../../utils/types";
import { INITIAL_RISK_STATE } from "./RiskGuard";

const D = 86_400_000, H = D / 24, T = Date.parse("2024-01-01T00:00:00Z");
const bar = (close: number, timestamp: number): OHLCV => ({ timestamp, open: close, high: close, low: close, close, volume: 1 });
const signal = Array.from({ length: 48 }, (_, i) => bar(100 + i, T + i * H));
const cfg: Partial<MomentumEngineConfig> = {
  universe: ["AAA"], historyBars: 100, rebalanceMinutes: 60,
  tsm: { barMinutes: 60, lookbackDays: 1 / 24, maLengthDays: 2 / 24, entryThresholdPct: 0, maxLongs: 1 },
  regime: { enabled: false }, trendExit: { smaDays: 3, basis: "dailyClose" },
};
class DailyBroker extends FakeBroker {
  daily = [140, 99, 100];
  dailyCalls = 0;
  scaled = 0;
  async fetchDailyCloses() { this.dailyCalls++; return this.daily; }
  async scalePosition() { this.scaled++; return { ok: true }; }
}
function setup(overrides: Partial<MomentumEngineConfig> = {}, held = true) {
  const b = new DailyBroker();
  b.setCandles("AAA", signal);
  if (held) b.positions.push({ symbol: "AAA", side: "buy", quantity: 10, notional: 1470 });
  const clock = new TestClock(T + 3 * D);
  const e = new MomentumEngine({ ...cfg, ...overrides }, b, silentLogger, undefined, clock);
  return { b, e, clock };
}

describe("own-coin daily trend exit", () => {
  test("closes HELD inventory despite a valid original stay signal, blocks entries, reenters only with BOTH signals", async () => {
    const { b, e, clock } = setup();
    const r = await e.tick();
    expect(r.actions).toMatchObject([{ type: "close", symbol: "AAA", closeReason: "TREND_EXIT" }]);
    expect(b.closed).toEqual([{ symbol: "AAA", side: "buy", closeReason: "TREND_EXIT" }]);
    clock.advance(H);
    expect((await e.tick()).actions).toEqual([]); // still below SMA, no immediate rebuy
    b.daily = [99, 100, 150];
    b.setCandles("AAA", [...signal].reverse().map((c, i) => ({ ...c, timestamp: T + i * H })));
    clock.advance(H);
    expect((await e.tick()).actions).toEqual([]); // daily recovered, original signal invalid
    b.setCandles("AAA", signal);
    clock.advance(H);
    expect((await e.tick()).actions).toMatchObject([{ type: "open", side: "buy" }]);
  });

  test("flat book cannot enter below SMA; equality is not below (explicit spec's strict inequality)", async () => {
    const { b, e } = setup({}, false);
    expect((await e.tick()).actions).toEqual([]);
    b.daily = [100, 100, 100];
    expect((await e.tick()).actions).toMatchObject([{ type: "open", side: "buy" }]);
    expect(marketTrendBlocked(Array(65).fill(100), 65)).toBe(false);
    expect(marketTrendBlocked([...Array(64).fill(100), 99], 65)).toBe(true);
  });

  test("restriction applies BEFORE slots: blocked high-ranked name cannot displace an eligible name", async () => {
    const { b, e } = setup({ universe: ["AAA", "BBB"] });
    b.setCandles("BBB", signal.map((c, i) => bar(100 + i / 2, c.timestamp)));
    b.fetchDailyCloses = async (symbol?: string) => symbol === "BBB" ? [99, 100, 150] : [140, 99, 100];
    const r = await e.tick();
    expect(r.actions).toMatchObject([{ type: "close", symbol: "AAA", closeReason: "TREND_EXIT" }, { type: "open", symbol: "BBB" }]);
  });

  test("trend exit works without TSM history and while regime blocks, before exposure resizes", async () => {
    const { b, e } = setup({
      tsm: { barMinutes: 60 }, // needs 30d; signal has only 2d
      regime: { enabled: true, volSpikeMultiplier: 1 },
      exposureControl: { drawdown: { startPct: 0, endPct: 0.2 }, minScale: 0.25, band: 0, minOrderUsd: 0 },
    });
    const r = await e.tick();
    expect(r.tradeable).toBe(false);
    expect(r.actions[0].closeReason).toBe("TREND_EXIT");
    expect(b.scaled).toBe(0);
  });

  test("failed trend close is retried, never resized or added back", async () => {
    const { b, e } = setup({ exposureControl: { drawdown: { startPct: 0, endPct: 0.2 }, minScale: 0.25, band: 0, minOrderUsd: 0 } });
    b.closePosition = async a => { b.closed.push(a); return { ok: false }; };
    expect((await e.tick()).actions).toEqual([]);
    expect((await e.tick()).actions).toEqual([]);
    expect(b.closed).toHaveLength(2);
    expect(b.closed.every(a => a.closeReason === "TREND_EXIT")).toBe(true);
    expect(b.scaled).toBe(0);
  });

  test("missing daily data: no fabricated exit, no new long, no add-back", async () => {
    const { b, e } = setup();
    b.daily = [];
    expect((await e.tick()).actions).toEqual([]); // original valid hold
    b.positions = [];
    expect((await e.tick()).actions).toEqual([]);
    b.fetchDailyCloses = async () => { throw new Error("synthetic outage"); };
    expect((await e.tick()).actions).toEqual([]);
    const state = new MemoryPersistence();
    state.store = { v: 1, risk: { ...INITIAL_RISK_STATE }, exposureFracs: { "AAA|buy": 0.5 } };
    b.positions = [{ symbol: "AAA", side: "buy", quantity: 5, notional: 735 }];
    const up = new MomentumEngine({ ...cfg, exposureControl: { drawdown: { startPct: 0, endPct: 0.2 }, minScale: 0.25, band: 0, minOrderUsd: 0 } }, b, silentLogger, state, new TestClock(T + 3 * D));
    expect((await up.tick()).exposureControl?.deferredUp).toBe(1);
    expect(b.scaled).toBe(0);
  });

  test("hourly forming UTC day never leaks into daily SMA", () => {
    const closed = [140, 99, 100].flatMap((p, day) => Array.from({ length: 24 }, (_, h) => bar(p, T + day * D + h * H)));
    const morning = [...closed, bar(10_000, T + 3 * D), bar(20_000, T + 3 * D + H)];
    expect(completedDailyCloses(morning, H)).toEqual([140, 99, 100]);
    expect(marketTrendBlocked(completedDailyCloses(morning, H), 3)).toBe(true);
    const fullDay = [...closed, ...Array.from({ length: 24 }, (_, h) => bar(150, T + 3 * D + h * H))];
    expect(completedDailyCloses(fullDay, H)).toEqual([140, 99, 100, 150]);
    expect(marketTrendBlocked(completedDailyCloses(fullDay, H), 3)).toBe(false);
  });

  test.each(["trail", "time"])("%s stop takes precedence over a simultaneous daily trend exit", async kind => {
    const { b, clock } = setup();
    const state = new MemoryPersistence();
    state.store = { v: 1, risk: { ...INITIAL_RISK_STATE },
      trailMarks: { "AAA|buy": { mark: 200, lastTs: T + 46 * H } },
      entryMarks: { "AAA|buy": T },
    };
    const e = new MomentumEngine({ ...cfg,
      ...(kind === "trail" ? { tsmTrail: { kSigma: 1, lookbackBars: 2, minPct: 2, maxPct: 2 } } : {}),
      timeStop: { maxHoldHours: 1 },
    }, b, silentLogger, state, clock);
    await e.tick();
    expect(b.closed).toEqual([{ symbol: "AAA", side: "buy", closeReason: kind === "trail" ? "TRAIL_STOP" : "TIME_STOP" }]);
    expect(b.opened).toEqual([]);
  });

  test("default OFF: no daily fetch and byte-identical reports/persistence", async () => {
    const a = setup({ trendExit: undefined });
    const b = setup({ trendExit: undefined });
    const pa = new MemoryPersistence(), pb = new MemoryPersistence();
    const { trendExit: _, ...legacy } = cfg;
    const ea = new MomentumEngine(legacy, a.b, silentLogger, pa, a.clock);
    const eb = new MomentumEngine({ ...legacy, trendExit: undefined }, b.b, silentLogger, pb, b.clock);
    expect(await ea.tick()).toEqual(await eb.tick());
    expect(pa.store).toEqual(pb.store);
    expect(a.b.dailyCalls + b.b.dailyCalls).toBe(0);
    expect(a.b.closed).toEqual([]);
  });
});
