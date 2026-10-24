import { describe, expect, test } from "bun:test";
import { MomentumEngine, idleOverlayHistoryDays, idleOverlayTargets, type IdleOverlayConfig, type MomentumBrokerAdapter, type MomentumEngineConfig } from "./MomentumEngine";
import type { CurrentPosition } from "./Rebalancer";
import { MemoryPersistence, silentLogger } from "../../test-support/momentum";
import { TestClock } from "../../utils/clock";
import type { OHLCV } from "../../utils/types";

const D = 86_400_000, H = D / 24, T = Date.parse("2024-01-01T00:00:00Z");
const overlay: IdleOverlayConfig = { kind: "tsm", symbols: ["BTC/USD", "ETH/USD"], lookbackDays: 365, volTargetPerAsset: 0.4, ewmaCenterOfMassDays: 60, annualization: 365 };
const risk = { softDrawdownPct: 1, hardDrawdownPct: 1, dailyLossCapPct: 1, consecutiveLossLimit: 10000 };
function history(sign = 1, amplitude = 0.015) {
  let px = 100;
  return Array.from({ length: idleOverlayHistoryDays(overlay) }, (_, i) => {
    px *= 1 + sign * 0.002 + (i % 2 ? amplitude : -amplitude);
    return px;
  });
}
function hourly(up = false): OHLCV[] {
  return Array.from({ length: 50 }, (_, i) => {
    const px = up ? 100 + i : 100;
    return { timestamp: T - (50 - i) * H, open: px, high: px, low: px, close: px, volume: 1000 };
  });
}
class Broker implements MomentumBrokerAdapter {
  positions: CurrentPosition[] = [];
  opens: Parameters<MomentumBrokerAdapter["openPosition"]>[0][] = [];
  closes: Parameters<MomentumBrokerAdapter["closePosition"]>[0][] = [];
  events: string[] = [];
  daily = new Map([["BTC/USD", history()], ["ETH/USD", history(-1)]]);
  dailyReads = 0;
  normalSignal = false;
  failClose = false;
  equity = 10000;
  async getOpenPositions() { return this.positions.map(p => ({ ...p })); }
  async getEquity() { return this.equity; }
  async getRealisedPnlSince() { return 0; }
  async fetchCandles(symbol: string) { return hourly(this.normalSignal && symbol === "BTC/USD"); }
  async fetchDailyCloses(symbol: string, days: number) { this.dailyReads++; return (this.daily.get(symbol) ?? []).slice(-days); }
  async openPosition(a: Parameters<MomentumBrokerAdapter["openPosition"]>[0]) {
    // Fails at the instant of submission, not merely at end-of-tick.
    expect(this.positions.every(p => p.role === a.role)).toBe(true);
    this.events.push(`open:${a.role ?? "momentum"}`);
    this.opens.push(a);
    this.positions.push({ symbol: a.symbol, side: a.side, notional: a.notionalUsd, quantity: a.notionalUsd / 100, ...(a.role ? { role: a.role } : {}) });
    return { ok: true };
  }
  async closePosition(a: Parameters<MomentumBrokerAdapter["closePosition"]>[0]) {
    this.closes.push(a);
    if (this.failClose) return { ok: false, reason: "synthetic close failure" };
    this.events.push(`close:${a.closeReason}`);
    this.positions = this.positions.filter(p => p.symbol !== a.symbol || p.side !== a.side);
    return { ok: true };
  }
}
function cfg(extra: Partial<MomentumEngineConfig> = {}): Partial<MomentumEngineConfig> {
  return { universe: overlay.symbols, rebalanceMinutes: 60, historyBars: 50, notionalPctPerSlot: 0.25,
    tsm: { barMinutes: 60, lookbackDays: 1, maLengthDays: 1, maxLongs: 1, maxShorts: 0 },
    regime: { enabled: false }, risk, idleOverlay: overlay, ...extra };
}

describe("idle overlay: synthetic signal and monthly sizing", () => {
  test("365-day price sign, EWMA centered variance, inverse-vol sizing and gross/coin caps", () => {
    const h = new Map([["BTC/USD", history()], ["ETH/USD", history(-1)]]);
    const targets = idleOverlayTargets(h, overlay, 10000);
    expect(targets.map(p => p.side)).toEqual(["buy", "sell"]);
    expect(targets.every(p => p.notionalUsd <= 10000)).toBe(true);
    expect(targets.reduce((s, p) => s + p.notionalUsd, 0)).toBeCloseTo(15000, 8);
    // Independently compute normalized EWMA population variance (simple,
    // not log returns; mean subtraction matters for persistent trends).
    const closes = history(1, 0.08), returns = closes.slice(1).map((p, i) => p / closes[i] - 1);
    const weights = returns.map((_, i) => (1 - 60 / 61) * (60 / 61) ** (returns.length - 1 - i));
    const sw = weights.reduce((a, b) => a + b, 0);
    const mean = returns.reduce((s, r, i) => s + r * weights[i], 0) / sw;
    const variance = returns.reduce((s, r, i) => s + weights[i] * (r - mean) ** 2, 0) / sw;
    const [target] = idleOverlayTargets(new Map([["BTC/USD", closes]]), { ...overlay, symbols: ["BTC/USD"] }, 10000);
    expect(target.notionalUsd).toBeCloseTo(10000 * 0.4 / Math.sqrt(variance * 365), 8);
    expect(idleOverlayTargets(new Map([["BTC/USD", Array(611).fill(100)]]), overlay, 10000)).toEqual([]);
    expect(idleOverlayTargets(new Map([["BTC/USD", history().slice(1)]]), overlay, 10000)).toEqual([]);
    expect(idleOverlayTargets(h, overlay, NaN)).toEqual([]);
  });

  test("monthly only, held without stops/trails/time barriers/resizes, renewed next UTC month", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    const e = new MomentumEngine(cfg({ tsmTrail: { kSigma: 1, lookbackBars: 24, minPct: 1, maxPct: 2 }, timeStop: { maxHoldHours: 1 }, exposureControl: { drawdown: { startPct: 0.01, endPct: 0.1 }, minScale: 0.25, band: 0, minOrderUsd: 0 } }), b, silentLogger, store, clock);
    expect((await e.tick()).actions).toHaveLength(2);
    expect(b.opens.every(a => a.role === "idle-overlay" && a.stopLossPct === undefined)).toBe(true);
    b.daily.set("BTC/USD", history(-1));
    clock.set(T + 15 * D);
    expect((await e.tick()).actions).toEqual([]);
    expect(b.dailyReads).toBe(2);
    clock.set(Date.parse("2024-02-01T00:00:00Z"));
    expect((await e.tick()).actions.map(a => a.type)).toEqual(["close", "close", "open", "open"]);
    expect(b.positions.every(p => p.side === "sell")).toBe(true);
    expect(store.store?.idleOverlayMonth).toBe("2024-02");
  });

  test("hourly momentum remains ranked; all overlay closes precede the first normal entry; no intramonth return", async () => {
    const b = new Broker(), clock = new TestClock(T);
    const e = new MomentumEngine(cfg(), b, silentLogger, undefined, clock);
    await e.tick();
    b.normalSignal = true; clock.set(T + H);
    const r = await e.tick();
    expect(r.decisions.find(d => d.symbol === "BTC/USD")?.action).toBe("long");
    expect(b.events.slice(2)).toEqual(["close:IDLE_OVERLAY_EXIT", "close:IDLE_OVERLAY_EXIT", "open:momentum"]);
    expect(r.actions.map(a => a.type)).toEqual(["close", "close", "open"]);
    expect(b.positions).toHaveLength(1);
    expect(b.positions[0].role).toBeUndefined();
    b.normalSignal = false; clock.set(T + 2 * H); await e.tick();
    clock.set(T + 3 * H); await e.tick();
    expect(b.positions).toEqual([]);
    expect(b.dailyReads).toBe(2);
  });

  test("failed overlay close blocks momentum (even a different symbol), then retries; no overlap on recovery", async () => {
    const b = new Broker(), clock = new TestClock(T);
    const e = new MomentumEngine(cfg(), b, silentLogger, undefined, clock);
    await e.tick();
    b.failClose = true; b.normalSignal = true; clock.set(T + H);
    await e.tick();
    expect(b.opens).toHaveLength(2);
    expect(b.positions.every(p => p.role === "idle-overlay")).toBe(true);
    b.failClose = false; clock.set(T + 2 * H); await e.tick();
    expect(b.positions).toHaveLength(1);
    expect(b.positions[0].role).toBeUndefined();
  });

  test("month consumption survives restart; trade roles preserve ownership", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    await new MomentumEngine(cfg(), b, silentLogger, store, clock).tick();
    const before = [...b.opens];
    clock.set(T + H);
    const restarted = new MomentumEngine(cfg(), b, silentLogger, store, clock);
    await restarted.tick();
    expect(b.opens).toEqual(before);
    expect(b.closes).toEqual([]);
    expect(b.dailyReads).toBe(2);
    b.positions = []; // e.g. external liquidation: no replacement this month
    clock.set(T + 2 * H); await restarted.tick();
    expect(b.opens).toEqual(before);
  });

  test("failed renewal persists liquidation intent across restart, without a delayed monthly entry", async () => {
    const b = new Broker(), clock = new TestClock(T), store = new MemoryPersistence();
    const e = new MomentumEngine(cfg(), b, silentLogger, store, clock);
    await e.tick();
    b.failClose = true; clock.set(Date.parse("2024-02-01T00:00:00Z"));
    await e.tick();
    expect(store.store).toMatchObject({ idleOverlayMonth: "2024-02", idleOverlayExitPending: true });
    b.failClose = false; clock.set(Date.parse("2024-02-02T00:00:00Z"));
    await new MomentumEngine(cfg(), b, silentLogger, store, clock).tick();
    expect(b.positions).toEqual([]);
    expect(b.opens).toHaveLength(2);
    expect(b.dailyReads).toBe(2);
    expect(store.store).not.toHaveProperty("idleOverlayExitPending");
  });

  test("busy month, first install midmonth, missing data and risk gates never create new overlay risk", async () => {
    for (const mode of ["busy", "midmonth", "missing", "risk"] as const) {
      const b = new Broker(), clock = new TestClock(mode === "midmonth" ? T + 2 * D : T);
      if (mode === "busy") { b.normalSignal = true; b.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 100 }]; }
      if (mode === "missing") b.daily.clear();
      const e = new MomentumEngine(cfg(mode === "risk" ? { risk: { ...risk, hardDrawdownPct: 0 } } : {}), b, silentLogger, undefined, clock);
      await e.tick();
      expect(b.opens).toEqual([]);
      clock.set(T + 3 * D); b.daily = new Broker().daily; b.normalSignal = false;
      await e.tick();
      expect(b.opens).toEqual([]);
    }
  });

  test("hard drawdown liquidates idle inventory; soft/daily entry gates cannot disable its exit", async () => {
    const b = new Broker(), clock = new TestClock(T);
    const e = new MomentumEngine(cfg({ risk: { ...risk, hardDrawdownPct: 0.2, peakHalfLifeDays: 0 } }), b, silentLogger, undefined, clock);
    await e.tick();
    b.equity = 7000; clock.set(T + H);
    expect((await e.tick()).actions.map(a => a.closeReason)).toEqual(["IDLE_OVERLAY_EXIT", "IDLE_OVERLAY_EXIT"]);
    expect(b.positions).toEqual([]);
  });

  test("maintenance blocks the overlay, but the primary hourly regime gate does not redefine its independent signal", async () => {
    const previous = process.env.TRADING_ENABLED;
    try {
      process.env.TRADING_ENABLED = "false";
      const b = new Broker();
      await new MomentumEngine(cfg(), b, silentLogger, undefined, new TestClock(T)).tick();
      expect(b.opens).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TRADING_ENABLED; else process.env.TRADING_ENABLED = previous;
    }
    const b = new Broker();
    const report = await new MomentumEngine(cfg({ regime: { enabled: true, volSpikeMultiplier: 0.5 } }), b, silentLogger, undefined, new TestClock(T)).tick();
    expect(report.tradeable).toBe(false); // normal hourly book's verdict
    expect(b.opens).toHaveLength(2);
  });

  test("absent knob makes no daily request, no overlay order, no persisted month; invalid configs fail early", async () => {
    const b = new Broker(), store = new MemoryPersistence();
    await new MomentumEngine(cfg({ idleOverlay: undefined }), b, silentLogger, store, new TestClock(T)).tick();
    expect(b.opens).toEqual([]); expect(b.dailyReads).toBe(0);
    expect(store.store).not.toHaveProperty("idleOverlayMonth");
    expect(() => new MomentumEngine(cfg({ idleOverlay: { ...overlay, volTargetPerAsset: 40 } }), b, silentLogger)).toThrow("idleOverlay");
    expect(() => new MomentumEngine(cfg({ tsm: { maxShorts: 1 } }), b, silentLogger)).toThrow("long-only");
  });
});
