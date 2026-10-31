import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimBroker, dailyBarsFromBars, hashReplayConfig, runWithConfig } from "./backtest-momentum-wf";
import { candidateToReplayConfig, generateFolds, runLoo, runWalkForward, stitchedMetrics, validateCandidate, validateManifest, type ExperimentManifest } from "./walk-forward";
import { MomentumEngine, turtleChannels, type BreakoutShortConfig, type MomentumBrokerAdapter, type MomentumEngineConfig } from "../src/strategies/momentum/MomentumEngine";
import type { CurrentPosition } from "../src/strategies/momentum/Rebalancer";
import { MemoryPersistence, silentLogger } from "../src/test-support/momentum";
import { TestClock } from "../src/utils/clock";
import type { OHLCV } from "../src/utils/types";

const D = 86400000, H = D / 24, T = Date.parse("2024-01-01T00:00:00Z");
const knob: BreakoutShortConfig = { symbol: "BTC/USD", entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01 };
const risk = { softDrawdownPct: 1, hardDrawdownPct: 1, dailyLossCapPct: 1, consecutiveLossLimit: 100000 };
const cfg: Partial<MomentumEngineConfig> = { universe: ["BTC/USD", "ETH/USD"], rebalanceMinutes: 60, historyBars: 50,
  tsm: { barMinutes: 60, lookbackDays: 1, maLengthDays: 1, maxLongs: 2, maxShorts: 0 }, regime: { enabled: false }, risk, breakoutShort: knob };
const daily = (): OHLCV[] => Array.from({ length: 55 }, (_, i) => ({ timestamp: T - (55 - i) * D, open: 100, high: 110, low: 90, close: 100, volume: 1000 }));
function hours(from = T - 3 * D, to = T + 4 * D): OHLCV[] {
  return Array.from({ length: (to - from) / H }, (_, i) => ({ timestamp: from + i * H, open: 89, high: 89, low: 89, close: 89, volume: 1000 }));
}
class Broker implements MomentumBrokerAdapter {
  positions: CurrentPosition[] = [];
  opens: Parameters<MomentumBrokerAdapter["openPosition"]>[0][] = [];
  closes: Parameters<MomentumBrokerAdapter["closePosition"]>[0][] = [];
  events: string[] = [];
  bars = daily(); price = 89; longSymbol = ""; equity = 10000; failClose = false; dailyReads = 0;
  prices = new Map<string, number>();
  dailyBySymbol = new Map<string, OHLCV[]>();
  strictReads: string[] = [];
  failCloseSymbol = "";
  async getOpenPositions() { return this.positions.map(p => ({ ...p })); }
  async getEquity() { return this.equity; }
  async getRealisedPnlSince() { return 0; }
  async fetchDailyBars(s: string) { this.dailyReads++; return this.dailyBySymbol.get(s) ?? this.bars; }
  async fetchCandles(s: string, _bars?: number, opts?: { strictVenue?: boolean }) {
    if (opts?.strictVenue) this.strictReads.push(s);
    const price = this.prices.get(s) ?? this.price;
    return hours().slice(0, 50).map((b, i) => ({ ...b, close: s === this.longSymbol ? price * (0.5 + 0.5 * i / 49) : price }));
  }
  async openPosition(a: Parameters<MomentumBrokerAdapter["openPosition"]>[0]) {
    expect(this.positions.some(p => p.symbol === a.symbol && p.side !== a.side)).toBe(false);
    this.opens.push(a); this.events.push(`open:${a.role ?? "momentum"}`);
    const price = this.prices.get(a.symbol) ?? this.price;
    this.positions.push({ symbol: a.symbol, side: a.side, quantity: a.breakout?.quantity ?? a.notionalUsd / price, notional: a.notionalUsd,
      ...(a.role ? { role: a.role, entryPrice: price, breakoutN: a.breakout?.n, stopLoss: price + a.breakout!.n * a.breakout!.stopN } : {}) });
    return { ok: true };
  }
  async closePosition(a: Parameters<MomentumBrokerAdapter["closePosition"]>[0]) {
    this.closes.push(a);
    if (this.failClose || a.symbol === this.failCloseSymbol) return { ok: false, reason: "synthetic rejection" };
    this.events.push(`close:${a.closeReason}`);
    this.positions = this.positions.filter(p => p.symbol !== a.symbol || p.side !== a.side);
    return { ok: true };
  }
}
const read = (name: string): ExperimentManifest => JSON.parse(readFileSync(join(import.meta.dir, "../experiments", `${name}.json`), "utf8"));
const name = "momentum-crypto-rw5-btc-breakout55-pure-v1", liveName = "momentum-crypto-rw3-vt-35-corroff-pure-v1";

describe("Turtle short: synthetic rules, gates and durable state", () => {
  test("RW8 list: eight independent units/N/stops, no pyramiding, strict venue; same-symbol priority only", async () => {
    const symbols = read("momentum-crypto-rw8-breakout8-pure-v1").data.universe;
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    for (const [i, s] of symbols.entries()) {
      const scale = i + 1;
      b.prices.set(s, 89 * scale);
      b.dailyBySymbol.set(s, daily().map(x => ({ ...x, open: 100 * scale, high: 110 * scale, low: 90 * scale, close: 100 * scale })));
    }
    const c = { ...cfg, universe: symbols, breakoutShort: { symbols, entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 }, risk: { ...risk, mode: "sizeOnly" as const } };
    await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    expect(b.opens.map(a => a.symbol)).toEqual(symbols);
    expect(b.strictReads).toEqual(symbols);
    for (const [i, s] of symbols.entries()) {
      expect(b.positions[i]).toMatchObject({ symbol: s, breakoutN: 20 * (i + 1), stopLoss: 129 * (i + 1) });
      expect(b.positions[i].quantity * b.positions[i].breakoutN!).toBeCloseTo(b.equity * 0.01, 12);
      expect(store.store!.breakoutBySymbol![s]).toMatchObject({ entryAt: T, belowEntry: true, daily: { n: 20 * (i + 1) } });
    }
    expect(store.store).not.toHaveProperty("turtleDaily");
    const restarted = new MomentumEngine(c, b, silentLogger, store, clock);
    clock.set(T + H); await restarted.tick(); expect(b.opens).toHaveLength(8);
    b.longSymbol = "ETH/USD"; b.failCloseSymbol = "ETH/USD";
    clock.set(T + 2 * H); await restarted.tick();
    expect(b.opens).toHaveLength(8); expect(b.positions).toHaveLength(8);
    b.failCloseSymbol = ""; clock.set(T + 3 * H); await restarted.tick();
    expect(b.closes.every(a => a.symbol === "ETH/USD" && a.closeReason === "BREAKOUT_SHORT_PRIORITY")).toBe(true);
    expect(b.positions.filter(p => p.role === "breakout-short")).toHaveLength(7);
    expect(b.positions.find(p => p.symbol === "ETH/USD")!.side).toBe("buy");
    expect(store.store!.breakoutBySymbol!["BTC/USD"].entryAt).toBe(T);
    expect(store.store!.breakoutBySymbol!["ETH/USD"]).not.toHaveProperty("entryAt");
  });
  test("RW8 per-symbol 120h age/edge survives restart; failed/missing-data close does not reset siblings", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence(), symbols = ["BTC/USD", "ETH/USD"];
    const c = { ...cfg, risk: { ...risk, mode: "sizeOnly" as const }, breakoutShort: { symbols, entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 } };
    b.prices.set("ETH/USD", 90); await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    b.prices.set("ETH/USD", 89); clock.set(T + H);
    await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    b.bars = []; b.failCloseSymbol = "BTC/USD"; clock.set(T + 120 * H);
    const restarted = new MomentumEngine(c, b, silentLogger, store, clock);
    await restarted.tick();
    expect(b.positions).toHaveLength(2);
    expect(store.store!.breakoutBySymbol!["BTC/USD"].entryAt).toBe(T);
    expect(store.store!.breakoutBySymbol!["ETH/USD"].entryAt).toBe(T + H);
    b.failCloseSymbol = ""; clock.set(T + 121 * H); await restarted.tick();
    expect(b.positions).toHaveLength(0); expect(b.opens).toHaveLength(2);
    expect(b.closes.map(a => a.closeReason)).toEqual(Array(3).fill("BREAKOUT_SHORT_TIME_STOP"));
    b.bars = daily().map(x => ({ ...x, timestamp: x.timestamp + 5 * D })); clock.set(T + 122 * H);
    const again = new MomentumEngine(c, b, silentLogger, store, clock);
    await again.tick(); expect(b.opens).toHaveLength(2);
    b.prices.set("ETH/USD", 90); clock.set(T + 123 * H); await again.tick();
    b.prices.set("ETH/USD", 89); clock.set(T + 124 * H); await again.tick();
    expect(b.opens.map(a => a.symbol)).toEqual(["BTC/USD", "ETH/USD", "ETH/USD"]);
  });
  test("RW7 sizeOnly never drawdown-liquidates/vetoes the independent short leg, even past inherited hard DD", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    const c = { ...cfg, risk: { ...risk, mode: "sizeOnly" as const, hardDrawdownPct: 0.2, peakHalfLifeDays: 0 }, breakoutShort: { symbols: ["BTC/USD", "ETH/USD"], entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 } };
    b.prices.set("ETH/USD", 90); await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    b.equity = 6000; b.prices.set("ETH/USD", 89); clock.set(T + H);
    await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    expect(b.closes).toEqual([]); expect(b.positions.map(p => p.symbol)).toEqual(["BTC/USD", "ETH/USD"]);
    expect(store.store!.risk.peakEquity).toBe(10000);
  });
  test("RW8 exits are local: a 2N stop still runs without daily data and never closes another unit", async () => {
    const b = new Broker(), clock = new TestClock(T), symbols = ["BTC/USD", "ETH/USD"];
    const c = { ...cfg, breakoutShort: { symbols, entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 } };
    const e = new MomentumEngine(c, b, silentLogger, undefined, clock);
    await e.tick(); b.bars = []; b.prices.set("ETH/USD", 129); clock.set(T + H); await e.tick();
    expect(b.closes).toEqual([{ symbol: "ETH/USD", side: "sell", closeReason: "BREAKOUT_SHORT_STOP" }]);
    expect(b.positions.map(p => p.symbol)).toEqual(["BTC/USD"]); expect(b.opens).toHaveLength(2);
  });
  test("55 previous completed lows, strict breach, one unit (1N = 1%, 2N = 2%), no pyramiding", async () => {
    const b = new Broker(), clock = new TestClock(T), e = new MomentumEngine(cfg, b, silentLogger, undefined, clock);
    b.price = 90; await e.tick(); expect(b.opens).toEqual([]);
    b.price = 89; clock.set(T + H); await e.tick();
    expect(b.opens).toMatchObject([{ side: "sell", role: "breakout-short", notionalUsd: 445, breakout: { n: 20, stopN: 2, quantity: 5 } }]);
    expect(b.positions[0].stopLoss).toBe(129);
    expect(b.positions[0].quantity * 20).toBe(b.equity * 0.01);
    clock.set(T + 2 * H); await e.tick(); expect(b.opens).toHaveLength(1);
  });
  test("Wilder N uses true range including gaps, SMA20 seed and alpha 1/20; continuation never reseeds", () => {
    const bars = daily().map((b, i) => ({ ...b, high: 110 + i, low: 105 + i, close: 108 + i }));
    let n = bars.slice(1, 21).reduce((s, b, i) => s + Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)), 0) / 20;
    for (let i = 21; i < 55; i++) n = (19 * n + Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close))) / 20;
    const first = turtleChannels(bars, knob, T)!;
    expect(first.state.n).toBeCloseTo(n, 12);
    const next = { ...bars.at(-1)!, timestamp: T, high: 180, low: 170, close: 175 };
    expect(turtleChannels([...bars.slice(1), next], knob, T + D, first.state)!.state.n).toBeCloseTo((19 * n + Math.max(10, 180 - bars.at(-1)!.close)) / 20, 12);
    expect(turtleChannels([...bars, next], knob, T)).toBeNull(); // forming day
    expect(turtleChannels(bars.slice(1), knob, T)).toBeNull();
    expect(turtleChannels(bars.filter((_, i) => i !== 10), knob, T)).toBeNull();
  });
  test.each(["stop", "channel", "drawdown"] as const)("hourly %s exit runs despite entry gates, never reopens in the same tick", async mode => {
    const b = new Broker(), clock = new TestClock(T);
    if (mode === "channel") b.bars = daily().map((b, i) => ({ ...b, high: i < 35 ? 300 : 110 }));
    const e = new MomentumEngine({ ...cfg, risk: { ...risk, hardDrawdownPct: 0.2, peakHalfLifeDays: 0 } }, b, silentLogger, undefined, clock);
    await e.tick(); expect(b.positions).toHaveLength(1);
    b.price = mode === "stop" ? b.positions[0].stopLoss! : mode === "channel" ? 111 : 89;
    if (mode === "drawdown") b.equity = 7000;
    const prev = process.env.TRADING_ENABLED;
    try {
      process.env.TRADING_ENABLED = "false"; clock.set(T + H); await e.tick();
    } finally { if (prev === undefined) delete process.env.TRADING_ENABLED; else process.env.TRADING_ENABLED = prev; }
    expect(b.positions).toEqual([]);
    expect(b.closes[0].closeReason).toBe(mode === "stop" ? "BREAKOUT_SHORT_STOP" : mode === "channel" ? "BREAKOUT_SHORT_EXIT" : "BREAKOUT_SHORT_DRAWDOWN");
    expect(b.opens).toHaveLength(1);
  });
  test("BTC priority closes first, close failure vetoes BTC entry; other longs coexist and occupy only momentum slots", async () => {
    const b = new Broker(), clock = new TestClock(T), e = new MomentumEngine(cfg, b, silentLogger, undefined, clock);
    b.longSymbol = "ETH/USD"; await e.tick();
    expect(b.positions.map(p => p.symbol)).toEqual(["ETH/USD", "BTC/USD"]);
    b.longSymbol = "BTC/USD"; b.failClose = true; clock.set(T + H); await e.tick();
    expect(b.positions.some(p => p.symbol === "BTC/USD" && p.side === "buy")).toBe(false);
    b.failClose = false; clock.set(T + 2 * H); await e.tick();
    expect(b.events.slice(-2)).toEqual(["close:BREAKOUT_SHORT_PRIORITY", "open:momentum"]);
    expect(b.positions).toHaveLength(1); expect(b.positions[0].side).toBe("buy");
    clock.set(T + 3 * H); await e.tick(); expect(b.positions).toHaveLength(1);
  });
  test("restart preserves the open unit N/entry/stop and daily recurrence, not rescaled by trails/time/exposureControl", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    const c = { ...cfg, timeStop: { maxHoldHours: 1 }, tsmTrail: { kSigma: 1, lookbackBars: 24, minPct: 1, maxPct: 2 }, exposureControl: { minScale: 0.25, band: 0, minOrderUsd: 0, drawdown: { startPct: 0.01, endPct: 0.1 } } };
    await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    const position = { ...b.positions[0] }, n = store.store!.turtleDaily!.n;
    const restarted = new MomentumEngine(c, b, silentLogger, store, clock);
    clock.set(T + 5 * H); await restarted.tick();
    expect(b.positions).toEqual([position]); expect(b.opens).toHaveLength(1); expect(store.store!.turtleDaily!.n).toBe(n);
    b.bars = []; b.price = position.stopLoss!; clock.set(T + 6 * H); await restarted.tick();
    expect(b.closes[0].closeReason).toBe("BREAKOUT_SHORT_STOP"); // stop survives missing daily data
  });
  test("held unit counts toward gross cap for other longs, but BTC replacement frees its notional first", async () => {
    const b = new Broker(), clock = new TestClock(T), e = new MomentumEngine({ ...cfg, notionalPctPerSlot: 0.1, maxGrossExposureMult: 0.12 }, b, silentLogger, undefined, clock);
    await e.tick(); b.longSymbol = "ETH/USD"; clock.set(T + H); await e.tick();
    expect(b.positions).toHaveLength(1); expect(b.positions[0].role).toBe("breakout-short"); // 445 + 1000 > 1200
    b.longSymbol = "BTC/USD"; clock.set(T + 2 * H); await e.tick();
    expect(b.positions).toHaveLength(1); expect(b.positions[0].side).toBe("buy");
  });
  test("optional 120h cap survives restart, retries rejection without daily data, requires a NEW channel crossing", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    const c = { ...cfg, timeStop: { maxHoldHours: 120 }, breakoutShort: { ...knob, maxHoldHours: 120 } };
    await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    expect(store.store!.breakoutEntryAt).toBe(T);
    clock.set(T + 119 * H); b.bars = []; // expiry cannot depend on daily data
    const e = new MomentumEngine(c, b, silentLogger, store, clock);
    await e.tick(); expect(b.closes).toHaveLength(0);
    clock.set(T + 120 * H); b.failClose = true; await e.tick();
    expect(b.closes.at(-1)!.closeReason).toBe("BREAKOUT_SHORT_TIME_STOP");
    expect(b.positions).toHaveLength(1);
    b.failClose = false; clock.set(T + 121 * H); await e.tick();
    expect(b.positions).toHaveLength(0); expect(b.opens).toHaveLength(1);
    expect(store.store).not.toHaveProperty("breakoutEntryAt");
    // Restart while price is STILL below the same 55-day low: no reopening.
    clock.set(T + 122 * H); b.bars = daily().map(x => ({ ...x, timestamp: x.timestamp + 5 * D }));
    const restarted = new MomentumEngine(c, b, silentLogger, store, clock);
    await restarted.tick(); expect(b.opens).toHaveLength(1);
    b.price = 90; clock.set(T + 123 * H); await restarted.tick(); // rearm on/above low
    b.price = 89; clock.set(T + 124 * H); await restarted.tick();
    expect(b.opens).toHaveLength(2); expect(store.store!.breakoutEntryAt).toBe(T + 124 * H);
  });
  test("missing daily history, maintenance, risk and gross caps cannot create a unit; absent knob never fetches daily data", async () => {
    for (const kind of ["missing", "risk", "cap", "off"] as const) {
      const b = new Broker(); if (kind === "missing") b.bars = [];
      const store = new MemoryPersistence();
      await new MomentumEngine({ ...cfg, ...(kind === "off" ? { breakoutShort: undefined } : {}), ...(kind === "cap" ? { maxGrossExposureMult: 0.01 } : {}), ...(kind === "risk" ? { risk: { ...risk, hardDrawdownPct: 0 } } : {}) }, b, silentLogger, store, new TestClock(T)).tick();
      expect(b.opens).toEqual([]);
      if (kind === "off") { expect(b.dailyReads).toBe(0); expect(store.store).not.toHaveProperty("turtleDaily"); }
    }
  });
});

describe("breakout protocol and live/sim parity (synthetic only)", () => {
  test("RW8 manifests change ONLY their declared design from live RW7; immutable inputs and reserved trials", () => {
    const live = validateManifest(read("momentum-crypto-rw7-nobrakes-pure-v1"));
    for (const [file, prior] of [["momentum-crypto-rw8-symtsm-pure-v1", 469], ["momentum-crypto-rw8-breakout8-pure-v1", 470]] as const) {
      const m = validateManifest(read(file));
      const { name: _n, description: _d, trialAccounting: _t, candidates: _c, ...rest } = m;
      const { name: _ln, description: _ld, trialAccounting: _lt, candidates: _lc, ...base } = live;
      expect(rest).toEqual(base); expect(m.candidates).toHaveLength(1);
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
      expect(m.description).toContain("DRY-RUN ONLY, NOT EXECUTED");
      const { breakoutShort, shortEntryPct, shortExitPct, shortStop, maxShorts, ...candidate } = m.candidates[0];
      const { maxShorts: _ms, ...baseCandidate } = live.candidates[0];
      expect(candidate).toEqual(baseCandidate);
      if (prior === 469) {
        expect({ maxShorts, shortEntryPct, shortExitPct, shortStop }).toEqual({ maxShorts: 4, shortEntryPct: -5, shortExitPct: 2, shortStop: { mode: "fixed", pct: 0.04 } });
        expect(breakoutShort).toBeUndefined();
      } else {
        expect(maxShorts).toBe(0);
        expect(breakoutShort).toEqual({ symbols: m.data.universe, entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 });
      }
      const replay = candidateToReplayConfig(m, m.candidates[0], "base");
      expect(replay).toMatchObject({ risk: { mode: "sizeOnly" }, timeStop: { maxHoldHours: 120 }, allowSameTickReentry: true });
      expect(replay.breakoutShort).toEqual(breakoutShort);
      expect(hashReplayConfig(replay)).not.toBe(hashReplayConfig(candidateToReplayConfig(live, live.candidates[0], "base")));
    }
  });
  test("RW8 list validation rejects empty/duplicate/mixed selectors, unknown symbols and malformed state inputs", () => {
    const m = read("momentum-crypto-rw8-breakout8-pure-v1"), c = m.candidates[0], b = c.breakoutShort!;
    for (const bad of [[], ["BTC/USD", "BTC/USD"], [""], [null], ["ETH/USDC"], "BTC/USD", null]) {
      expect(() => validateCandidate({ ...c, breakoutShort: { ...b, symbols: bad } })).toThrow("breakoutShort");
    }
    expect(() => validateCandidate({ ...c, breakoutShort: { ...b, symbol: "BTC/USD" } })).toThrow("breakoutShort");
    expect(() => validateManifest({ ...m, data: { ...m.data, universe: ["BTC/USD"] } })).toThrow("breakoutShort");
    expect(() => new MomentumEngine({ ...cfg, breakoutShort: b }, new Broker(), silentLogger)).toThrow("breakoutShort");
  });
  test("RW8 LOO removes only the excluded coin from breakout history/signals, or disables an empty leg", async () => {
    const m = read("momentum-crypto-rw8-breakout8-pure-v1"), folds = generateFolds(m.window, Date.parse(m.asOf));
    for (const onlyExcluded of [false, true]) {
      const candidate = { ...m.candidates[0], breakoutShort: onlyExcluded ? { symbols: ["ETH/USD"], entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 } : m.candidates[0].breakoutShort };
      let called = false;
      await expect(runLoo(m, new Map(folds.map(f => [f.path, candidate])), folds, undefined, async cfg => {
        called = true;
        expect(cfg.universe).not.toContain("ETH/USD");
        expect(cfg.breakoutShort).toEqual(onlyExcluded ? undefined : { ...candidate.breakoutShort, symbols: m.data.universe.filter(s => s !== "ETH/USD") });
        return null; // stop at config seam, never execute historical trials
      }, ["ETH/USD"])).rejects.toThrow("incomplete LOO replay");
      expect(called).toBe(true);
      expect(m.candidates[0].breakoutShort!.symbols).toContain("ETH/USD");
    }
  });
  test("RW8 list uses the same live-like/sim decisions for two units, stops and symbol-local priority", async () => {
    const symbols = ["BTC/USD", "ETH/USD"], c = { ...cfg, breakoutShort: { symbols, entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 } };
    const live = new Broker(), clock = new TestClock(T), sim = new SimBroker(10000, new Map(symbols.map(s => [s, hours()])), 0, 0, H, { leverage: 2, maintRate: 0.005 });
    sim.breakoutDaily = new Map(symbols.map(s => [s, daily()])); sim.fetchCandles = s => live.fetchCandles(s);
    const le = new MomentumEngine(c, live, silentLogger, undefined, clock), se = new MomentumEngine(c, sim, silentLogger, undefined, clock);
    for (const t of [T, T + H, T + 2 * H]) {
      sim.now = t; clock.set(t); live.equity = sim.equityNow(); if (t === T + 2 * H) live.longSymbol = "ETH/USD";
      expect((await se.tick()).actions).toEqual((await le.tick()).actions);
    }
    expect(sim.breakoutShortStats).toMatchObject({ opens: 2, closes: 1, exits: { BREAKOUT_SHORT_PRIORITY: 1 } });
    expect((await sim.getOpenPositions()).filter(p => p.role === "breakout-short").map(p => p.symbol)).toEqual(["BTC/USD"]);
  });
  test("execution counter includes resizes and exits, excludes seeds and rejected orders", async () => {
    const sim = new SimBroker(10000, new Map([["BTC/USD", hours()]]), 0, 0, H, { leverage: 2, maintRate: 0.005 });
    sim.now = T;
    expect((await sim.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 0 })).ok).toBe(false);
    expect(sim.orders).toBe(0);
    expect((await sim.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1000 })).ok).toBe(true);
    expect((await sim.scalePosition({ symbol: "BTC/USD", side: "buy", factor: 0.5 })).ok).toBe(true);
    expect((await sim.scalePosition({ symbol: "BTC/USD", side: "buy", factor: 2 })).ok).toBe(true);
    expect((await sim.scalePosition({ symbol: "BTC/USD", side: "buy", factor: 1e9 })).ok).toBe(false);
    expect((await sim.closePosition({ symbol: "BTC/USD", side: "buy" })).ok).toBe(true);
    expect((await sim.closePosition({ symbol: "BTC/USD", side: "buy" })).ok).toBe(false);
    expect(sim.orders).toBe(4); expect(sim.closed).toHaveLength(1);
    sim.seedPositions([{ symbol: "BTC/USD", side: "buy", qty: 1, entryPrice: 89, entryAt: T - D }]);
    expect(sim.orders).toBe(4);
    expect((await sim.closePosition({ symbol: "BTC/USD", side: "buy" })).ok).toBe(true);
    expect(sim.orders).toBe(5);
  });
  test("RW6 manifests are only the declared knobs, prior trials 459..461, and absent cap preserves RW5 identity", () => {
    const cases = [
      ["momentum-crypto-rw6-maxhold5-pure-v1", liveName, 459],
      ["momentum-crypto-rw6-maxhold5-breakout55-pure-v1", liveName, 460],
      ["momentum-crypto-usdc-daily-s5-rw6-maxhold5-pure-v1", "momentum-crypto-usdc-daily-s5-rw4a-xc-dd-pure-v1", 461],
    ] as const;
    for (const [file, baseFile, prior] of cases) {
      const m = validateManifest(read(file)), base = validateManifest(read(baseFile));
      const { name: _n, description: _d, trialAccounting: _t, candidates: _c, ...rest } = m;
      const { name: _bn, description: _bd, trialAccounting: _bt, candidates: _bc, ...baseRest } = base;
      expect(rest).toEqual(baseRest); expect(m.candidates).toHaveLength(1);
      const { timeStop, breakoutShort, ...candidate } = m.candidates[0];
      expect(candidate).toEqual(base.candidates[0]); expect(timeStop).toEqual({ maxHoldHours: 120 });
      expect(breakoutShort).toEqual(prior === 460 ? { ...knob, maxHoldHours: 120 } : undefined);
      expect(m.trialAccounting).toEqual({ priorUniqueTrials: prior, complete: false });
      expect(m.description).toContain("DRY-RUN ONLY");
    }
    const m = read(name), off = candidateToReplayConfig(m, m.candidates[0], "base");
    expect(hashReplayConfig({ ...off, breakoutShort: { ...knob, maxHoldHours: undefined } })).toBe(hashReplayConfig(off));
    expect(hashReplayConfig({ ...off, breakoutShort: { ...knob, maxHoldHours: 120 } })).not.toBe(hashReplayConfig(off));
    for (const maxHoldHours of [0, -1, NaN, Infinity, null, "120"]) expect(() => validateCandidate({ ...m.candidates[0], breakoutShort: { ...knob, maxHoldHours } })).toThrow("breakoutShort");
  });
  test("one candidate, live plus ONLY knob, prior 455, default-off hashes; invalid shapes/venues rejected", () => {
    const m = validateManifest(read(name)), live = validateManifest(read(liveName));
    const { name: _n, description: _d, trialAccounting: _t, candidates: _c, ...rest } = m;
    const { name: _ln, description: _ld, trialAccounting: _lt, candidates: _lc, ...base } = live;
    expect(rest).toEqual(base); expect(m.candidates).toHaveLength(1);
    const { breakoutShort, ...candidate } = m.candidates[0]; expect(candidate).toEqual(live.candidates[0]); expect(breakoutShort).toEqual(knob);
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 455, complete: false }); expect(m.description).toContain("PRE-REGISTERED (2026-10-24) BEFORE any run");
    const on = candidateToReplayConfig(m, m.candidates[0], "base"), off = candidateToReplayConfig(live, live.candidates[0], "base");
    expect(hashReplayConfig({ ...on, breakoutShort: undefined })).toBe(hashReplayConfig(off)); expect(hashReplayConfig(on)).not.toBe(hashReplayConfig(off));
    for (const invalid of [null, [], {}, { ...knob, typo: 1 }, { ...knob, symbol: "ETH/USD" }, { ...knob, entryDays: 1.5 }, { ...knob, riskPerN: 1 }, { ...knob, stopN: 0 }]) expect(() => validateCandidate({ ...m.candidates[0], breakoutShort: invalid })).toThrow("breakoutShort");
    expect(() => validateCandidate({ ...m.candidates[0], maxShorts: 1 })).toThrow("breakoutShort");
    expect(() => validateManifest({ ...m, sleeve: "stocks" })).toThrow("breakoutShort");
    expect(() => validateManifest({ ...m, data: { ...m.data, funding: false } })).toThrow("breakoutShort");
  });
  test("daily OHLC aggregation rejects missing hours; forming days cannot leak highs/lows/TR into channels or N", async () => {
    const bars = hours(T - 3 * D, T);
    expect(dailyBarsFromBars(bars, H)).toHaveLength(3);
    expect(dailyBarsFromBars(bars.filter((_, i) => i !== 24), H)).toHaveLength(2);
    const sim = new SimBroker(10000, new Map(), 0, 0, H, { leverage: 2, maintRate: 0.005 });
    sim.breakoutDaily = new Map([["BTC/USD", [...daily(), { ...daily()[0], timestamp: T, high: 1e20, low: 1 }]]]);
    sim.now = T; const a = await sim.fetchDailyBars("BTC/USD", 55);
    sim.now = T + 23 * H; expect(await sim.fetchDailyBars("BTC/USD", 55)).toEqual(a);
    expect(turtleChannels(a, knob, sim.now)!.state.n).toBe(20);
    sim.now = T + D; expect((await sim.fetchDailyBars("BTC/USD", 55)).at(-1)!.high).toBe(1e20);
  });
  test("same engine produces identical live-like/sim orders and exits, including BTC-long priority", async () => {
    const live = new Broker(), clock = new TestClock(T), sim = new SimBroker(10000, new Map(cfg.universe!.map(s => [s, hours()])), 0, 0, H, { leverage: 2, maintRate: 0.005 });
    sim.breakoutDaily = new Map([["BTC/USD", daily()]]); sim.fetchCandles = s => live.fetchCandles(s);
    const le = new MomentumEngine(cfg, live, silentLogger, undefined, clock), se = new MomentumEngine(cfg, sim, silentLogger, undefined, clock);
    for (const t of [T, T + H, T + 2 * H]) {
      sim.now = t; clock.set(t); live.equity = sim.equityNow(); if (t === T + 2 * H) live.longSymbol = "BTC/USD";
      expect((await se.tick()).actions).toEqual((await le.tick()).actions);
    }
    expect(sim.breakoutShortStats).toMatchObject({ opens: 1, closes: 1, orders: 2, exits: { BREAKOUT_SHORT_PRIORITY: 1 } });
  });
  test("full synthetic replay: extra OHLC history is hashed, funding charged, hourly-only stops, activity/orders/exits counted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "breakout-synthetic-")), path = join(dir, "synthetic.db");
    try {
      const db = new Database(path);
      db.exec("CREATE TABLE historical_bars(symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL); CREATE TABLE funding_rates(symbol TEXT, funding_time INTEGER, rate REAL)");
      const q = db.query("INSERT INTO historical_bars VALUES ('BTC/USD', '1h', 'binance_futures', ?, ?, ?, ?, ?, 1000)");
      db.transaction(() => {
        for (let t = T - 90 * D; t < T + 9 * D; t += H) { const p = t < T ? 100 : 79; q.run(t, p, t < T ? 110 : 200, t < T ? 80 : 70, p); }
        for (let t = T; t <= T + 9 * D; t += 8 * H) db.query("INSERT INTO funding_rates VALUES ('BTCUSDT', ?, -0.0001)").run(t);
        db.exec("INSERT INTO historical_bars SELECT 'ETH/USD', timeframe, source, timestamp, open*2, high*2, low*2, close*2, volume FROM historical_bars WHERE symbol='BTC/USD'; INSERT INTO funding_rates SELECT 'ETHUSDT', funding_time, rate FROM funding_rates WHERE symbol='BTCUSDT'");
      })();
      const m = read(name); m.data = { ...m.data, dbPath: path, universe: ["BTC/USD"] };
      m.window = { ...m.window, from: new Date(T).toISOString(), to: new Date(T + 3 * D).toISOString(), outerFoldCount: 1, innerFoldCount: 0, purgeYears: 0 }; m.asOf = m.window.to;
      m.candidates = [{ ...m.candidates[0], entryPct: 100000, sharpeGate: undefined, volTarget: undefined, risk, regime: "off" }];
      const c = candidateToReplayConfig(m, m.candidates[0], "base"), win = { label: "synthetic", from: m.window.from, to: m.window.to };
      const r = await runWithConfig(c, win);
      expect(r).not.toBeNull(); expect(r!.breakoutShortStats).toMatchObject({ opens: 1, closes: 1, orders: 2, exits: { fold_end: 1 } });
      expect(r!.breakoutShortStats!.shortDays).toBeCloseTo(3 - 1 / 24, 8); expect(r!.breakoutShortStats!.fundingPaid).toBeGreaterThan(0);
      expect(r!.breakoutShortStats!.fundingPaid).toBeCloseTo(r!.funding, 8);
      expect(r!.orders).toBe(2); expect(r!.ordersPerDay).toBeCloseTo(2 / 3, 12);
      expect(stitchedMetrics(r!.equityHistory, [r!], 365)).toMatchObject({ orders: 2, ordersPerDay: 2 / 3 });
      const { orders: _orders, ...oldResult } = r!;
      expect(stitchedMetrics(r!.equityHistory, [oldResult], 365)).not.toHaveProperty("ordersPerDay");
      const off = await runWithConfig({ ...c, breakoutShort: undefined }, win); expect(off!).not.toHaveProperty("breakoutShortStats");
      const capped = await runWithConfig({ ...c, timeStop: { maxHoldHours: 120 }, breakoutShort: { ...knob, maxHoldHours: 120 } }, { ...win, to: new Date(T + 8 * D).toISOString() });
      expect(capped!.breakoutShortStats).toMatchObject({ opens: 1, closes: 1, orders: 2, exits: { BREAKOUT_SHORT_TIME_STOP: 1 } });
      expect(capped!.closedTrades[0].exitAt - capped!.closedTrades[0].entryAt).toBe(120 * H + 1); // fill stamp is decision+1ms
      expect(capped!.ordersPerDay).toBe(2 / 8);
      const multi = await runWithConfig({ ...c, universe: ["BTC/USD", "ETH/USD"], breakoutShort: { symbols: ["BTC/USD", "ETH/USD"], entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 } }, { ...win, to: new Date(T + 8 * D).toISOString() });
      expect(multi!.breakoutShortStats).toMatchObject({ opens: 2, closes: 2, orders: 4, exits: { BREAKOUT_SHORT_TIME_STOP: 2 } });
      expect(multi!.closedTrades.map(t => t.symbol).sort()).toEqual(["BTC/USD", "ETH/USD"]);
      expect(multi!.closedTrades.every(t => t.exitAt - t.entryAt === 120 * H + 1)).toBe(true);
      expect(multi!.funding).toBeGreaterThan(capped!.funding);
      const a = await runWalkForward(m, { dryRun: true, codeFiles: [] });
      db.query("UPDATE historical_bars SET high = high + 1 WHERE timestamp = ?").run(T - 65 * D);
      const b = await runWalkForward(m, { dryRun: true, codeFiles: [] });
      expect(a.summary.configHash).toBe(b.summary.configHash); expect(a.summary.dataHash).not.toBe(b.summary.dataHash);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
