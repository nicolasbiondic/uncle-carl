import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SimBroker, dailyBarsFromBars, hashReplayConfig, runWithConfig } from "./backtest-momentum-wf";
import { candidateToReplayConfig, canonicalJson, generateFolds, manifestIdentity, runLoo, runWalkForward, stitchedMetrics, validateCandidate, validateManifest, type ExperimentManifest } from "./walk-forward";
import { MomentumEngine, turtleChannels, validateBreakoutShort, validateBreakoutLong, type BreakoutLongConfig, type BreakoutShortConfig, type MomentumBrokerAdapter, type MomentumEngineConfig } from "../src/strategies/momentum/MomentumEngine";
import { INITIAL_RISK_STATE } from "../src/strategies/momentum/RiskGuard";
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
  async fetchDailyBars(s: string, _days?: number) { this.dailyReads++; return this.dailyBySymbol.get(s) ?? this.bars; }
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
      ...(a.role ? { role: a.role, entryPrice: price, breakoutN: a.breakout?.n, stopLoss: price + (a.side === "buy" ? -1 : 1) * a.breakout!.n * a.breakout!.stopN } : {}) });
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

// Frozen config/base/stress identities from the saved artifacts, independent
// of ignored data/ so CI checks the same pins. Code hashes necessarily change.
describe("hold-grid: pinned crypto artifact identities", () => {
  test.each([
    ["b37681ff", "momentum-crypto-rw8-breakout8-pure-v1",
      "ab6a1aa1a897cf655776d6519d56b2fa18294c670e69247f2c98b130e391dab4",
      "1fa00b9dd2de287f2fc515cbcc39342382d334895f01521848d51af9a8dd285d",
      "264fa8dcfc826f2f9231d2463117aadf554d6790bbde9196750d2bf405f86164"],
    ["4aca1803", "momentum-crypto-rw10-turtle-s1-short-pure-v1",
      "79f125d4c82facfdc1ec5ac74f7353e1c8bfd07725f3dccf686fd83f62b2bfe3",
      "ad67b27c54510f986d501968c5f4b31bf107e1854c8e8fa1c8e0a524f0fe4068",
      "7ba875d81e019ffdf26e63b49ccb502c3b476eb1d847ac9e79c8eec7cea35730"],
    ["57430944", "momentum-crypto-usdc-daily-s5-rw8-sizeonly-bo13-pure-v1",
      "a20ee13a24a0ae25b775ac4e15548c95dd9f6ace9a9e977b370baae3cd2f2cd1",
      "aa98d958294219f7ab25b5d53a0e410e0155abd89514b614b43776fec26fe403",
      "85fd73274e13dbfbd54e6709e92c9f199fb37ddf5cc03fb9475b621b9e3a34af"],
    ["68181bd6", "momentum-crypto-usdc-daily-s5-rw7-sizeonly-pure-v1",
      "e13f970350cc15e3d85f655c3ad5c96fe721a78741220f01adc9e99c313e1971",
      "5b0ec4e0c9a8a8744866f1a48b0fa3fe0b4a23c82d1c89679bdd4767d4080498",
      "215e542665512805cb3d6f4c0fb97aed79716cc3612e44861995c870d8454c13"],
    ["2deab5da", "momentum-crypto-rw7-nobrakes-pure-v1",
      "4c4ebd26417c96e8357c6102b9e497ab29de52889ab9550d3e459aafd4668808",
      "09c918f75226636c9cc3fd09e896b82a6bc4a3b6f15f40fcb2ad5b984e0e34a9",
      "c6beeab39a2bb7e42b364282463ff394e4c17343f4d80690e6a38c8816dbd609"],
  ])("%s config and base/stress hashes are unchanged", (_artifact, file, configHash, baseHash, stressHash) => {
    const m = validateManifest(read(file));
    expect(createHash("sha256").update(canonicalJson(manifestIdentity(m))).digest("hex")).toBe(configHash);
    for (const [tier, hash] of [["base", baseHash], ["stress", stressHash]] as const) {
      const c = candidateToReplayConfig(m, m.candidates[0], tier);
      expect(hashReplayConfig(c)).toBe(hash);
      // Integer-grid ages k*C cross H and H-C/2 on the same tick when H=n*C.
      for (const hours of [c.timeStop?.maxHoldHours, c.breakoutShort?.maxHoldHours, c.breakoutLong?.maxHoldHours]) {
        if (hours !== undefined) expect(hours * 60 % c.cadenceMin).toBe(0);
      }
    }
  });
});

describe("Turtle hold-grid jitter (both legs, durable anchors)", () => {
  for (const cadence of [60, 1440]) for (const side of ["buy", "sell"] as const) {
    test(`${side} unit closes at 120h minus 1ms with ${cadence}min cadence after restart`, async () => {
      const entryAt = T + 15_001, clock = new TestClock(entryAt), b = new Broker(), store = new MemoryPersistence();
      b.price = side === "buy" ? 111 : 89;
      if (cadence === 1440) b.bars.unshift({ ...b.bars[0], timestamp: T - 56 * D });
      const leg = { symbols: ["BTC/USD"], entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 };
      const c: Partial<MomentumEngineConfig> = { ...cfg, universe: ["BTC/USD"], rebalanceMinutes: cadence,
        tsm: { ...cfg.tsm, barMinutes: cadence }, risk: { ...risk, mode: "sizeOnly" },
        breakoutShort: side === "sell" ? leg : undefined, breakoutLong: side === "buy" ? leg : undefined };
      const first = new MomentumEngine(c, b, silentLogger, store, clock);
      await first.tick(); first.stop();
      expect(b.opens).toHaveLength(1);
      const saved = side === "buy" ? store.store!.breakoutLongBySymbol : store.store!.breakoutBySymbol;
      expect(saved!["BTC/USD"].entryAt).toBe(entryAt);
      // History failure cannot defer the time stop or replace a restored anchor.
      b.bars = [];
      clock.set(entryAt + 120 * H - cadence * 60_000 - 1);
      const restarted = new MomentumEngine(c, b, silentLogger, store, clock);
      await restarted.tick(); expect(b.closes).toEqual([]);
      clock.set(entryAt + 120 * H - 1); await restarted.tick();
      expect(b.closes).toEqual([{ symbol: "BTC/USD", side, closeReason: side === "buy" ? "BREAKOUT_LONG_TIME_STOP" : "BREAKOUT_SHORT_TIME_STOP" }]);
      expect(b.positions).toEqual([]); expect(b.opens).toHaveLength(1);
    });
  }
});

describe("RW10 Turtle long units (synthetic only, no historical trial)", () => {
  const long: BreakoutLongConfig = { symbols: ["BTC/USD", "ETH/USD"], entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 };
  const c: Partial<MomentumEngineConfig> = { ...cfg, breakoutShort: undefined, breakoutLong: long, risk: { ...risk, mode: "sizeOnly" } };
  test("candidate B is pre-registered 476 -> 477: exact live copy plus long leg and -bl55 label, no live activation", () => {
    const m = validateManifest(read("momentum-crypto-rw10-turtle-long-pure-v1"));
    const live = validateManifest(read("momentum-crypto-rw8-breakout8-pure-v1"));
    const { name: _n, description: _d, trialAccounting: _t, candidates: _c, ...rest } = m;
    const { name: _ln, description: _ld, trialAccounting: _lt, candidates: _lc, ...base } = live;
    expect(rest).toEqual(base); expect(m.candidates).toHaveLength(1);
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 476, complete: false });
    expect(m.description).toContain("PRE-REGISTERED (2026-11-02) BEFORE any run, RW §21 candidate B");
    expect(m.description).toContain("Criterion C"); expect(m.description).toContain("Trial 476 -> 477.");
    const { name, breakoutLong, ...candidate } = m.candidates[0];
    const { name: liveName, ...liveCandidate } = live.candidates[0];
    expect(name).toBe(`${liveName}-bl55`); expect(candidate).toEqual(liveCandidate);
    expect(breakoutLong).toEqual({ ...long, symbols: live.data.universe });
    expect(candidateToReplayConfig(m, m.candidates[0], "base").breakoutLong).toEqual(breakoutLong);
  });
  test("b37681ff config/candidate identities stay pinned; absent long key is identical and enabling it changes only its own identity", () => {
    const m = validateManifest(read("momentum-crypto-rw8-breakout8-pure-v1"));
    expect(createHash("sha256").update(canonicalJson(manifestIdentity(m))).digest("hex")).toBe("ab6a1aa1a897cf655776d6519d56b2fa18294c670e69247f2c98b130e391dab4");
    const off = candidateToReplayConfig(m, m.candidates[0], "base");
    expect(hashReplayConfig(off)).toBe("1fa00b9dd2de287f2fc515cbcc39342382d334895f01521848d51af9a8dd285d");
    expect(hashReplayConfig({ ...off, breakoutLong: undefined })).toBe(hashReplayConfig(off));
    expect(hashReplayConfig({ ...off, breakoutLong: long })).not.toBe(hashReplayConfig(off));
    for (const invalid of [null, [], {}, { ...long, symbols: [] }, { ...long, symbols: ["BTC/USD", "BTC/USD"] }, { ...long, symbol: "BTC/USD" }, { ...long, symbols: ["ETH/USDT"] }, { ...long, typo: 1 }, { ...long, entryDays: 1.5 }, { ...long, riskPerN: 0.02 }, { ...long, stopN: 0 }, { ...long, maxHoldHours: 0 }]) {
      expect(() => validateCandidate({ ...m.candidates[0], breakoutLong: invalid })).toThrow("breakoutLong");
    }
    const candidate = { ...m.candidates[0], breakoutLong: long };
    expect(() => validateCandidate({ ...candidate, breakoutShort: undefined, maxShorts: 1 })).toThrow("breakoutLong");
    for (const data of [{ ...m.data, funding: false }, { ...m.data, universe: ["BTC/USD"] }, { ...m.data, timeframe: "1d" }, { ...m.data, barMinutesEq: 1440 }]) {
      // Remove the short leg so these falsifiers exercise long validation itself.
      expect(() => validateManifest({ ...m, data, candidates: [{ ...candidate, breakoutShort: undefined }] })).toThrow("breakoutLong");
    }
    expect(() => validateManifest({ ...m, sleeve: "stocks", candidates: [{ ...candidate, breakoutShort: undefined }] })).toThrow("breakoutLong");
    expect(() => new MomentumEngine({ ...c, universe: ["BTC/USD"] }, new Broker(), silentLogger)).toThrow("breakoutLong");
  });
  test("LOO removes only the excluded long symbol and disables an empty long leg, without running any trial", async () => {
    const m = read("momentum-crypto-rw8-breakout8-pure-v1"), folds = generateFolds(m.window, Date.parse(m.asOf));
    for (const symbols of [["ETH/USD"], long.symbols]) {
      const candidate = { ...m.candidates[0], breakoutLong: { ...long, symbols } };
      let called = false;
      await expect(runLoo(m, new Map(folds.map(f => [f.path, candidate])), folds, undefined, async replay => {
        called = true;
        expect(replay.universe).not.toContain("ETH/USD");
        expect(replay.breakoutLong).toEqual(symbols.length === 1 ? undefined : { ...long, symbols: ["BTC/USD"] });
        return null;
      }, ["ETH/USD"])).rejects.toThrow("incomplete LOO replay");
      expect(called).toBe(true); expect(candidate.breakoutLong.symbols).toContain("ETH/USD");
    }
  });
  test("55-day HIGH / 20-day LOW, strict breach, one N-sized unit per coin, no pyramiding or TSM adoption", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    // Old extremes belong to the 55-day entry, NOT the 20-day exit.
    const bars = daily().map((x, i) => ({ ...x, high: i < 35 ? 150 : 110, low: i < 35 ? 50 : 90 }));
    const channel = turtleChannels(bars, long, T, undefined, false, "buy")!;
    expect(channel.high).toBe(150); expect(channel.low).toBe(90);
    const dailyDecision = [...bars.map(x => ({ ...x, timestamp: x.timestamp - D })), { ...bars.at(-1)!, high: 1000, low: 1 }];
    const prior = turtleChannels(dailyDecision, long, T, undefined, true, "buy")!;
    expect(prior.high).toBe(150); expect(prior.low).toBe(90);
    expect(prior.state).toEqual(turtleChannels(dailyDecision, long, T)!.state); // N still includes the completed decision day
    b.price = 110;
    const engine = new MomentumEngine(c, b, silentLogger, store, clock);
    await engine.tick(); expect(b.opens).toEqual([]);
    b.price = 111; clock.set(T + H); await engine.tick();
    expect(b.opens.map(a => a.symbol)).toEqual(long.symbols);
    expect(b.opens[0]).toMatchObject({ role: "breakout-long", side: "buy", notionalUsd: 555, breakout: { n: 20, stopN: 2, quantity: 5 } });
    expect(b.positions.every(p => p.stopLoss === 71 && p.quantity * p.breakoutN! === b.equity * 0.01)).toBe(true);
    clock.set(T + 2 * H); await engine.tick();
    expect(b.opens).toHaveLength(2); expect(b.closes).toEqual([]);
    expect(store.store!.breakoutLongBySymbol!["BTC/USD"]).toMatchObject({ entryAt: T + H, aboveEntry: true, daily: { n: 20 } });
    expect(store.store).not.toHaveProperty("breakoutBySymbol"); expect(b.strictReads).toEqual(Array(3).fill(long.symbols).flat());
  });
  test("momentum has priority: existing TSM excludes units; a new TSM signal closes the unit first, never adopts it", async () => {
    const b = new Broker(), clock = new TestClock(T), engine = new MomentumEngine(c, b, silentLogger, undefined, clock);
    b.price = 111; b.longSymbol = "ETH/USD";
    await engine.tick();
    expect(b.positions).toMatchObject([{ symbol: "ETH/USD", side: "buy" }, { symbol: "BTC/USD", role: "breakout-long" }]);
    b.longSymbol = "BTC/USD"; b.failCloseSymbol = "BTC/USD"; clock.set(T + H); await engine.tick();
    expect(b.opens.filter(a => a.symbol === "BTC/USD")).toHaveLength(1);
    expect(b.positions.find(p => p.symbol === "BTC/USD")!.role).toBe("breakout-long");
    b.failCloseSymbol = ""; clock.set(T + 2 * H); await engine.tick();
    expect(b.events.slice(-2)).toEqual(["close:BREAKOUT_LONG_PRIORITY", "open:momentum"]);
    expect(b.positions.find(p => p.symbol === "BTC/USD")).not.toHaveProperty("role");
    expect(b.opens.filter(a => a.symbol === "BTC/USD")).toHaveLength(2);
  });
  test.each(["breakout-short", "breakout-long"] as const)("a rejected %s close cannot create the opposite unit", async role => {
    const b = new Broker(), clock = new TestClock(T);
    b.price = role === "breakout-short" ? 111 : 89; b.failClose = true;
    b.positions = [{ symbol: "BTC/USD", side: role === "breakout-short" ? "sell" : "buy", role, quantity: 5, notional: 500, entryPrice: 100, stopLoss: role === "breakout-short" ? 140 : 60, breakoutN: 20 }];
    const both = { ...c, breakoutLong: { ...long, symbols: ["BTC/USD"] }, breakoutShort: { ...long, symbols: ["BTC/USD"] } };
    await new MomentumEngine(both, b, silentLogger, undefined, clock).tick();
    expect(b.positions).toHaveLength(1); expect(b.positions[0].role).toBe(role); expect(b.opens).toEqual([]);
  });
  test.each(["stop", "channel", "removed"] as const)("%s exits are local, run through entry gates, and survive missing daily data", async mode => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    b.price = 111; await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    b.prices.set("ETH/USD", mode === "stop" ? 71 : 89);
    if (mode === "stop") b.bars = [];
    const previous = process.env.TRADING_ENABLED;
    try {
      process.env.TRADING_ENABLED = "false"; clock.set(T + H);
      await new MomentumEngine({ ...c, ...(mode === "removed" ? { breakoutLong: undefined } : {}) }, b, silentLogger, store, clock).tick();
    } finally { if (previous === undefined) delete process.env.TRADING_ENABLED; else process.env.TRADING_ENABLED = previous; }
    expect(b.closes.map(a => a.closeReason)).toEqual(mode === "removed" ? ["BREAKOUT_LONG_EXIT", "BREAKOUT_LONG_EXIT"] : [mode === "stop" ? "BREAKOUT_LONG_STOP" : "BREAKOUT_LONG_EXIT"]);
    expect(b.positions.map(p => p.symbol)).toEqual(mode === "removed" ? [] : ["BTC/USD"]); expect(b.opens).toHaveLength(2);
  });
  test("120h per-symbol age/edge survives restart, failed closes and missing history; only a fresh crossing rearms", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    b.price = 111; b.prices.set("ETH/USD", 110);
    await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    b.prices.set("ETH/USD", 111); clock.set(T + H);
    await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    b.bars = []; b.failCloseSymbol = "BTC/USD"; clock.set(T + 120 * H);
    const restarted = new MomentumEngine(c, b, silentLogger, store, clock);
    await restarted.tick(); expect(b.positions).toHaveLength(2);
    expect(store.store!.breakoutLongBySymbol!["BTC/USD"].entryAt).toBe(T);
    expect(store.store!.breakoutLongBySymbol!["ETH/USD"].entryAt).toBe(T + H);
    b.failCloseSymbol = ""; clock.set(T + 121 * H); await restarted.tick();
    expect(b.positions).toEqual([]); expect(b.opens).toHaveLength(2);
    expect(b.closes.map(a => a.closeReason)).toEqual(Array(3).fill("BREAKOUT_LONG_TIME_STOP"));
    b.bars = daily().map(x => ({ ...x, timestamp: x.timestamp + 5 * D })); clock.set(T + 122 * H);
    const again = new MomentumEngine(c, b, silentLogger, store, clock);
    await again.tick(); expect(b.opens).toHaveLength(2);
    b.prices.set("ETH/USD", 110); clock.set(T + 123 * H); await again.tick();
    b.prices.set("ETH/USD", 111); clock.set(T + 124 * H); await again.tick();
    expect(b.opens.map(a => a.symbol)).toEqual(["BTC/USD", "ETH/USD", "ETH/USD"]);
  });
  test("units are not trailed, time-stopped or resized by TSM and count toward the shared gross cap", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence(); b.price = 111;
    const guarded = { ...c, breakoutLong: { ...long, symbols: ["BTC/USD"] }, maxGrossExposureMult: 0.12, notionalPctPerSlot: 0.1,
      timeStop: { maxHoldHours: 1 }, tsmTrail: { kSigma: 1, lookbackBars: 24, minPct: 1, maxPct: 2 },
      exposureControl: { minScale: 0.25, band: 0, minOrderUsd: 0, drawdown: { startPct: 0.01, endPct: 0.1 } } };
    await new MomentumEngine(guarded, b, silentLogger, store, clock).tick();
    const position = { ...b.positions[0] };
    b.longSymbol = "ETH/USD"; clock.set(T + 5 * H);
    await new MomentumEngine(guarded, b, silentLogger, store, clock).tick();
    expect(b.positions).toEqual([position]); expect(b.opens).toHaveLength(1);
    b.longSymbol = "BTC/USD"; clock.set(T + 6 * H);
    await new MomentumEngine(guarded, b, silentLogger, store, clock).tick();
    expect(b.positions).toHaveLength(1); expect(b.positions[0]).not.toHaveProperty("role");
  });
  test("missing data, maintenance, risk and gross caps forbid entries; default-off never fetches or persists long state", async () => {
    for (const kind of ["missing", "gap", "risk", "cap", "off", "maintenance"] as const) {
      const b = new Broker(), store = new MemoryPersistence(); b.price = 111;
      if (kind === "missing") b.bars = [];
      if (kind === "gap") b.bars.splice(10, 1);
      const previous = process.env.TRADING_ENABLED;
      try {
        if (kind === "maintenance") process.env.TRADING_ENABLED = "false";
        await new MomentumEngine({ ...c, ...(kind === "off" ? { breakoutLong: undefined } : {}), ...(kind === "cap" ? { maxGrossExposureMult: 0.01 } : {}), ...(kind === "risk" ? { risk: { ...risk, hardDrawdownPct: 0 } } : {}) }, b, silentLogger, store, new TestClock(T)).tick();
      } finally { if (previous === undefined) delete process.env.TRADING_ENABLED; else process.env.TRADING_ENABLED = previous; }
      expect(b.opens).toEqual([]);
      if (kind === "off") { expect(b.dailyReads).toBe(0); expect(store.store).not.toHaveProperty("breakoutLongBySymbol"); }
    }
  });
  test("live-like and simulator decisions/state agree after restart and priority; long funding, stops and counts are side-aware", async () => {
    const b = new Broker(), clock = new TestClock(T), ls = new MemoryPersistence(), ss = new MemoryPersistence(); b.price = 111;
    const sim = new SimBroker(10000, new Map(long.symbols.map(s => [s, hours().map(x => ({ ...x, open: 111, high: 300, low: 1, close: 111 }))])), 0, 0, H, { leverage: 2, maintRate: 0.005 });
    sim.breakoutDaily = new Map(long.symbols.map(s => [s, daily()])); sim.fetchCandles = s => b.fetchCandles(s);
    for (let i = 0; i < 3; i++) {
      clock.set(T + i * H); sim.now = clock.now(); b.equity = sim.equityNow();
      if (i === 2) b.longSymbol = "ETH/USD";
      sim.checkStops(new Map(long.symbols.map(s => [s, { timestamp: T, open: 111, high: 300, low: 1, close: 111, volume: 1000 }])));
      const liveActions = (await new MomentumEngine(c, b, silentLogger, ls, clock).tick()).actions;
      expect((await new MomentumEngine(c, sim, silentLogger, ss, clock).tick()).actions).toEqual(liveActions);
      expect(ss.store!.breakoutLongBySymbol).toEqual(ls.store!.breakoutLongBySymbol);
    }
    sim.accrueBreakoutActivity(T, T + D);
    expect(sim.breakoutLongStats).toMatchObject({ opens: 2, closes: 1, orders: 3, longDays: 1, exits: { BREAKOUT_LONG_PRIORITY: 1 } });
    expect(sim.positions.find(p => p.role === "breakout-long")).toMatchObject({ breakoutN: 20, breakoutStop: 71, stopFrac: null });
  });
  test("full SYNTHETIC replay: extra daily OHLC is hashed, funding charged, hourly-only stops and 120h exits counted; off result is byte-identical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "breakout-long-synthetic-")), path = join(dir, "synthetic.db");
    try {
      const db = new Database(path);
      db.exec("CREATE TABLE historical_bars(symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL); CREATE TABLE funding_rates(symbol TEXT, funding_time INTEGER, rate REAL)");
      const q = db.query("INSERT INTO historical_bars VALUES ('BTC/USD', '1h', 'binance_futures', ?, ?, ?, ?, ?, 1000)");
      db.transaction(() => {
        for (let t = T - 90 * D; t < T + 9 * D; t += H) { const p = t < T ? 100 : 111; q.run(t, p, t < T ? 110 : 300, t < T ? 90 : 1, p); }
        for (let t = T; t <= T + 9 * D; t += 8 * H) db.query("INSERT INTO funding_rates VALUES ('BTCUSDT', ?, 0.0001)").run(t);
      })();
      const m = read("momentum-crypto-rw8-breakout8-pure-v1"); m.data = { ...m.data, dbPath: path, universe: ["BTC/USD"] };
      m.window = { ...m.window, from: new Date(T).toISOString(), to: new Date(T + 8 * D).toISOString(), outerFoldCount: 1, innerFoldCount: 0, purgeYears: 0 }; m.asOf = m.window.to;
      m.candidates = [{ ...m.candidates[0], entryPct: 100000, volTarget: undefined, breakoutShort: undefined, breakoutLong: { ...long, symbols: ["BTC/USD"] } }];
      const replay = candidateToReplayConfig(m, m.candidates[0], "base"), win = { label: "synthetic-long", from: m.window.from, to: m.window.to };
      const r = await runWithConfig(replay, win);
      expect(r!.breakoutLongStats).toMatchObject({ opens: 1, closes: 1, orders: 2, exits: { BREAKOUT_LONG_TIME_STOP: 1 } });
      expect(r!.breakoutLongStats!.longDays).toBeCloseTo(5, 8);
      expect(r!.breakoutLongStats!.fundingPaid).toBeGreaterThan(0);
      expect(r!.breakoutLongStats!.fundingPaid).toBeCloseTo(r!.funding, 8);
      expect(r!.closedTrades[0].exitAt - r!.closedTrades[0].entryAt).toBe(120 * H + 1);
      expect(r!.orders).toBe(2); expect(r!.ordersPerDay).toBe(2 / 8);
      const off = await runWithConfig({ ...replay, breakoutLong: undefined }, win);
      const { breakoutLong: _long, ...without } = replay;
      expect(JSON.stringify(await runWithConfig(without, win))).toBe(JSON.stringify(off));
      expect(off).not.toHaveProperty("breakoutLongStats");
      const a = await runWalkForward(m, { dryRun: true, codeFiles: [] });
      db.query("UPDATE historical_bars SET high = high + 1 WHERE timestamp = ?").run(T - 65 * D);
      const b = await runWalkForward(m, { dryRun: true, codeFiles: [] });
      expect(a.summary.configHash).toBe(b.summary.configHash); expect(a.summary.dataHash).not.toBe(b.summary.dataHash);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("daily Turtle shorts (Q6, no historical trial)", () => {
  const dailyCfg: Partial<MomentumEngineConfig> = { ...cfg, universe: ["BTC/USD"], rebalanceMinutes: 1440,
    tsm: { ...cfg.tsm, barMinutes: 1440, entryThresholdPct: 100000 },
    breakoutShort: { symbols: ["BTC/USD"], entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 } };
  const tape = (): OHLCV[] => [
    ...daily().map(b => ({ ...b, timestamp: b.timestamp - D })),
    { timestamp: T - D, open: 100, high: 110, low: 80, close: 89, volume: 1000 },
    ...Array.from({ length: 8 }, (_, i) => ({ timestamp: T + i * D, open: 83, high: 300, low: 40, close: 85, volume: 1000 })),
  ];
  class DailyBroker extends Broker {
    reads: number[] = [];
    constructor(readonly tape: OHLCV[], readonly clock: TestClock) { super(); }
    async fetchDailyBars(_s: string, days = 56) {
      this.reads.push(days);
      return this.tape.filter(b => b.timestamp + D <= this.clock.now()).slice(-days);
    }
    async fetchCandles(_s: string, bars = 50) {
      return this.tape.filter(b => b.timestamp + D <= this.clock.now()).slice(-bars);
    }
  }
  test.each([10_000, 20_000])("USDC exposure control: λ affects momentum only, never Turtle entry units or held resizes; live/sim + restart (peak %s)", async peak => {
    const bars = tape(), clock = new TestClock(T), live = new DailyBroker(bars, clock);
    const sim = new SimBroker(10_000, new Map([["BTC/USD", bars]]), 0, 0, D, { leverage: 2, maintRate: 0.005 });
    sim.breakoutDaily = new Map([["BTC/USD", dailyBarsFromBars(bars, D)]]);
    const ls = new MemoryPersistence(), ss = new MemoryPersistence();
    for (const store of [ls, ss]) store.store = { v: 1, risk: { ...INITIAL_RISK_STATE,
      peakEquity: peak, dayStartEquity: 10_000, dayStartedAt: T, lastEvalAt: T } };
    const exposureControl = read("momentum-crypto-usdc-daily-s5-rw8-sizeonly-bo13-pure-v1").candidates[0].exposureControl;
    const c = { ...dailyCfg, risk: { ...risk, mode: "sizeOnly" as const }, exposureControl };
    let resizes = 0;
    Object.assign(live, { scalePosition: async () => { resizes++; return { ok: true }; } });
    for (let day = 0; day < 2; day++) {
      clock.set(T + day * D); sim.now = clock.now();
      live.price = bars.find(b => b.timestamp === clock.now())!.open;
      live.equity = sim.equityNow();
      // New engine instances on the second day restore the exact held unit.
      const lr = await new MomentumEngine(c, live, silentLogger, ls, clock).tick();
      const sr = await new MomentumEngine(c, sim, silentLogger, ss, clock).tick();
      expect(sr.actions).toEqual(lr.actions);
      expect(lr.exposureControl!.scale).toBe(peak === 20_000 ? 0.25 : 1);
      expect(sr.exposureControl!.scale).toBe(lr.exposureControl!.scale);
      expect(lr.exposureControl!.resizes).toBe(0); expect(sim.resizes).toEqual([]);
      expect(live.positions[0].quantity).toBeCloseTo(100 / 20.5, 12); // 1% equity / N, NOT ×λ
      expect(sim.positions[0].qty).toBeCloseTo(live.positions[0].quantity, 12);
      expect(ls.store!.exposureFracs ?? {}).toEqual({});
      expect(ss.store!.breakoutBySymbol).toEqual(ls.store!.breakoutBySymbol);
    }
    expect(resizes).toBe(0); expect(live.opens).toHaveLength(1);
  });
  test.each([
    { priorLow: 90, close: 89, enters: true },
    { priorLow: 90, close: 90, enters: false },
    { priorLow: 80, close: 89, enters: false },
  ])("55 days BEFORE D; strict breach, own-day low is not the entry threshold: %j", async ({ priorLow, close, enters }) => {
    const bars = tape(); bars[0].low = priorLow;
    Object.assign(bars[55], { close, low: close }); // close equals D's own low
    const clock = new TestClock(T), live = new DailyBroker(bars, clock);
    await new MomentumEngine(dailyCfg, live, silentLogger, undefined, clock).tick();
    expect(live.opens).toHaveLength(enters ? 1 : 0);
    expect(live.reads).toEqual([56]); // 55 prior days PLUS the decision day
    const c = turtleChannels(bars.slice(0, 56), knob, T, undefined, true)!;
    expect(c.low).toBe(priorLow);
    expect(c.state).toEqual(turtleChannels(bars.slice(0, 56), knob, T)!.state); // N through D, unchanged Wilder recurrence
    expect(turtleChannels(bars.slice(1, 56), knob, T, undefined, true)).toBeNull();
    if (enters) expect(live.opens[0].breakout!.quantity * c.state.n).toBeCloseTo(100, 12);
  });
  test.each(["channel", "stop", "cap"] as const)("daily live/sim parity: %s at closes, next daily open fill, restart and no intraday stop", async mode => {
    const bars = tape(), clock = new TestClock(T), live = new DailyBroker(bars, clock);
    if (mode === "channel") Object.assign(bars[56], { high: 200, close: 111 });
    if (mode === "stop") bars[56].close = 124; // fill 83 + 2 * N(20.5)
    const sim = new SimBroker(10000, new Map([["BTC/USD", bars]]), 0, 0, D, { leverage: 2, maintRate: 0.005 });
    sim.breakoutDaily = new Map([["BTC/USD", dailyBarsFromBars(bars, D)]]);
    const ls = new MemoryPersistence(), ss = new MemoryPersistence();
    let le = new MomentumEngine(dailyCfg, live, silentLogger, ls, clock), se = new MomentumEngine(dailyCfg, sim, silentLogger, ss, clock);
    const exitDay = mode === "cap" ? 5 : 1;
    for (let day = 0; day <= exitDay; day++) {
      clock.set(T + day * D); sim.now = clock.now();
      live.price = bars.find(b => b.timestamp === clock.now())!.open;
      live.equity = sim.equityNow();
      sim.checkStops(new Map([["BTC/USD", bars[55 + day]]])); // even high=300 cannot execute an intraday Turtle stop
      expect((await se.tick()).actions).toEqual((await le.tick()).actions);
      expect(ss.store!.breakoutBySymbol).toEqual(ls.store!.breakoutBySymbol);
      if (day === 0) {
        expect(sim.positions[0]).toMatchObject({ entryPrice: 83, breakoutN: 20.5, breakoutStop: 124 });
        expect(live.positions[0]).toMatchObject({ entryPrice: 83, breakoutN: 20.5, stopLoss: 124 });
        le = new MomentumEngine(dailyCfg, live, silentLogger, ls, clock);
        se = new MomentumEngine(dailyCfg, sim, silentLogger, ss, clock);
      }
      if (day < exitDay) expect(sim.positions).toHaveLength(1);
    }
    expect(live.closes.map(a => a.closeReason)).toEqual([mode === "channel" ? "BREAKOUT_SHORT_EXIT" : mode === "stop" ? "BREAKOUT_SHORT_STOP" : "BREAKOUT_SHORT_TIME_STOP"]);
    expect(sim.closed[0]).toMatchObject({ entryAt: T, entryPrice: 83, exitPrice: 83, exitAt: T + exitDay * D + 1 });
    expect(sim.positions).toHaveLength(0); expect(live.opens).toHaveLength(1);
  });
  test("pre-registered trial 472→473 validates without modification; mismatched/unsupported cadences stay rejected", () => {
    const m = validateManifest(read("momentum-crypto-usdc-daily-s5-rw8-sizeonly-bo13-pure-v1"));
    const base = read("momentum-crypto-usdc-daily-s5-rw7-sizeonly-pure-v1");
    const { breakoutShort, name: _n, ...candidate } = m.candidates[0], { name: _bn, ...control } = base.candidates[0];
    expect(candidate).toEqual(control);
    expect(breakoutShort).toEqual({ symbols: m.data.universe, entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 });
    expect(m.trialAccounting).toEqual({ priorUniqueTrials: 472, complete: false });
    expect(candidateToReplayConfig(m, m.candidates[0], "base").breakoutShort).toEqual(breakoutShort);
    for (const cadenceMin of [120, 240]) expect(() => validateCandidate({ ...m.candidates[0], cadenceMin })).toThrow("breakoutShort");
    expect(() => validateManifest({ ...m, data: { ...m.data, timeframe: "1h" } })).toThrow("breakoutShort");
    expect(() => validateManifest({ ...m, data: { ...m.data, barMinutesEq: 60 } })).toThrow("breakoutShort");
    expect(() => new MomentumEngine({ ...dailyCfg, tsm: { ...dailyCfg.tsm, barMinutes: 60 } }, new Broker(), silentLogger)).toThrow("breakoutShort");
    expect(() => new MomentumEngine({ ...dailyCfg, universe: ["BTC/USDC"], breakoutShort: { ...dailyCfg.breakoutShort!, symbols: ["BTC/USDC"] } }, new Broker(), silentLogger)).not.toThrow();
  });
  test("full daily synthetic replay loads prior channels, charges funding and holds exactly 120h despite intraday extremes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "breakout-daily-synthetic-")), path = join(dir, "synthetic.db");
    const db = new Database(path);
    try {
      db.exec("CREATE TABLE historical_bars(symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL); CREATE TABLE funding_rates(symbol TEXT, funding_time INTEGER, rate REAL)");
      const q = db.query("INSERT INTO historical_bars VALUES ('BTC/USD', '1d', 'binance_futures', ?, ?, ?, ?, ?, ?)");
      db.transaction(() => {
        for (const b of tape()) q.run(b.timestamp, b.open, b.high, b.low, b.close, b.volume);
        for (let t = T; t <= T + 8 * D; t += 8 * H) db.query("INSERT INTO funding_rates VALUES ('BTCUSDT', ?, -0.0001)").run(t);
      })();
      const m = read("momentum-crypto-usdc-daily-s5-rw8-sizeonly-bo13-pure-v1");
      m.data = { ...m.data, dbPath: path, universe: ["BTC/USD"] };
      m.window.warmupDays = 70;
      const c = candidateToReplayConfig(m, { ...m.candidates[0], entryPct: 100000, lookbackDaysList: undefined, lookbackDays: 1, maLengthDays: 1,
        breakoutShort: dailyCfg.breakoutShort }, "base");
      const win = { label: "daily-synthetic-only", from: new Date(T).toISOString(), to: new Date(T + 8 * D).toISOString() };
      const r = await runWithConfig(c, win);
      expect(r).not.toBeNull();
      expect(r!.breakoutShortStats).toMatchObject({ opens: 1, closes: 1, orders: 2, shortDays: 5, exits: { BREAKOUT_SHORT_TIME_STOP: 1 } });
      expect(r!.closedTrades[0].entryAt).toBe(T);
      expect(r!.closedTrades[0].entryPrice).toBeCloseTo(83 * (1 - c.slippageBps / 10000), 12);
      expect(r!.closedTrades[0].exitAt - r!.closedTrades[0].entryAt).toBe(120 * H + 1);
      expect(r!.breakoutShortStats!.fundingPaid).toBeGreaterThan(0);
      expect(r!.breakoutShortStats!.fundingPaid).toBeCloseTo(r!.funding, 12);
      expect(r!.fees).toBeGreaterThan(0);
      const off = await runWithConfig({ ...c, breakoutShort: undefined }, win);
      expect(off!.orders).toBe(0); expect(off!).not.toHaveProperty("breakoutShortStats");
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Turtle short: synthetic rules, gates and durable state", () => {
  test("catastropheN is a validated live-only knob on both sides; no 2N strategy-exit change", async () => {
    for (const catastropheN of [0, -1, NaN, Infinity, null, "3"]) {
      expect(() => validateBreakoutShort({ ...knob, catastropheN })).toThrow();
      expect(() => validateBreakoutLong({ ...knob, symbol: undefined, symbols: ["BTC/USD"], catastropheN })).toThrow();
    }
    const b = new Broker(), clock = new TestClock(T);
    const e = new MomentumEngine({ ...cfg, breakoutShort: { ...knob, catastropheN: 4 } }, b, silentLogger, undefined, clock);
    await e.tick();
    expect(b.opens[0].breakout).toMatchObject({ n: 20, stopN: 2, catastropheN: 4 });
    b.price = 129; clock.set(T + H); await e.tick(); // 2N, NOT 4N
    expect(b.closes).toMatchObject([{ closeReason: "BREAKOUT_SHORT_STOP" }]);
  });

  test.each(["breakout-short", "breakout-long"] as const)("external catastrophe close resets %s unit age after restart; sustained breach cannot re-open", async role => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    const leg = { symbols: ["BTC/USD"], entryDays: 55, exitDays: 20, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 };
    const c: Partial<MomentumEngineConfig> = { ...cfg, risk: { ...risk, mode: "sizeOnly" },
      breakoutShort: role === "breakout-short" ? leg : undefined, breakoutLong: role === "breakout-long" ? leg : undefined };
    b.price = role === "breakout-short" ? 89 : 111;
    await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    expect(b.opens).toHaveLength(1);
    b.positions = []; // native fill + reconciler removed the row
    clock.set(T + H);
    await new MomentumEngine(c, b, silentLogger, store, clock).tick();
    const state = role === "breakout-short" ? store.store!.breakoutBySymbol : store.store!.breakoutLongBySymbol;
    expect(state!["BTC/USD"].entryAt).toBeUndefined();
    expect(b.opens).toHaveLength(1);
  });
  test.each([
    { previousPrice: 89, price: 89, belowEntry: false, belowEntryDays: undefined, opens: 0 },
    { previousPrice: 90, price: 89, belowEntry: true, belowEntryDays: undefined, opens: 1 },
    { previousPrice: 89, price: 89, belowEntry: false, belowEntryDays: 55, opens: 0 },
    { previousPrice: 90, price: 89, belowEntry: true, belowEntryDays: 55, opens: 1 },
  ])("RW10 recomputes the entry edge under 20/10, not the persisted 55/20 boolean: %j", async ({ previousPrice, price, belowEntry, belowEntryDays, opens }) => {
    const b = new Broker(), clock = new TestClock(T + H), store = new MemoryPersistence();
    b.bars[0].low = 70; // outside the new 20-day channel
    b.bars[40].high = 150; // inside the old 20-day exit, outside the new 10-day exit
    const old = turtleChannels(b.bars, knob, clock.now())!;
    // A real RW8 envelope has no provenance for its belowEntry boolean.
    store.store = { v: 1, risk: { ...INITIAL_RISK_STATE }, breakoutBySymbol: {
      "BTC/USD": { daily: old.state, belowEntry, belowEntryDays },
    } };
    b.price = price;
    b.fetchCandles = async () => hours().slice(0, 50).map((bar, i) => ({ ...bar, close: i === 49 ? price : previousPrice }));
    const breakoutShort = { symbols: ["BTC/USD"], entryDays: 20, exitDays: 10, atrDays: 20, stopN: 2, riskPerN: 0.01, maxHoldHours: 120 };
    const current = turtleChannels(b.bars, breakoutShort, clock.now(), old.state)!;
    expect([old.low, old.high, current.low, current.high]).toEqual([70, 150, 90, 110]);
    await new MomentumEngine({ ...cfg, breakoutShort }, b, silentLogger, store, clock).tick();
    expect(b.opens).toHaveLength(opens);
    expect(store.store!.breakoutBySymbol!["BTC/USD"].daily).toEqual(old.state); // N is continued, not reseeded
    expect(store.store!.breakoutBySymbol!["BTC/USD"]).toMatchObject({ belowEntry: true, belowEntryDays: 20 });
    b.positions = []; // even a broker-side close must not rearm the sustained breach
    clock.set(T + 2 * H);
    await new MomentumEngine({ ...cfg, breakoutShort }, b, silentLogger, store, clock).tick();
    expect(b.opens).toHaveLength(opens); // the migrated sustained breach survives restart
  });
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
    for (const bad of [[], ["BTC/USD", "BTC/USD"], [""], [null], ["ETH/USDT"], "BTC/USD", null]) {
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
