import { describe, expect, test } from "bun:test";
import { MomentumEngine, volTargetScale, trailPctFromVol, rollingSharpe, DEFAULT_ENGINE_CONFIG, TIME_STOP_CLOSE_REASON, TRAIL_STOP_CLOSE_REASON, MAX_RESTORED_TRAIL_MARK_AGE_MS, type MomentumPersistedState, type MomentumStatePersistence } from "./MomentumEngine";
import { INITIAL_RISK_STATE } from "./RiskGuard";
import type { OHLCV } from "../../utils/types";
import { heartbeats } from "../../ops/heartbeat";
import { eventBus, EVENTS } from "../../utils/events";
import { ramp, FakeBroker, silentLogger } from "../../test-support/momentum";
import { TestClock } from "../../utils/clock";

describe("MomentumEngine", () => {
  test("opens long positions for top-momentum symbols on first tick", async () => {
    const broker = new FakeBroker();
    broker.setCandles("UP1", ramp(100, 130));      // strong gainer
    broker.setCandles("UP2", ramp(100, 120));      // gainer
    broker.setCandles("FLAT", ramp(100, 100));
    broker.setCandles("DOWN", ramp(100, 80));      // loser
    const engine = new MomentumEngine({
      universe: ["UP1", "UP2", "FLAT", "DOWN"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
    }, broker, silentLogger);

    const report = await engine.tick();

    expect(report.tradeable).toBe(true);
    expect(report.actions.filter(a => a.type === "open").map(a => a.symbol).sort()).toEqual(["UP1", "UP2"]);
    expect(broker.opened.length).toBe(2);
    expect(broker.opened[0].notionalUsd).toBeCloseTo(3000, 0); // 30% of 10k
  });

  test("blocks rebalance when regime filter says non-tradeable", async () => {
    const broker = new FakeBroker();
    // Make EVERY symbol identical so correlation = 1.0 and regime trips.
    const base = ramp(100, 110);
    for (const sym of ["A", "B", "C", "D", "E"]) broker.setCandles(sym, base.map(c => ({ ...c })));
    const engine = new MomentumEngine({
      universe: ["A", "B", "C", "D", "E"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.001 },
      regime: { correlationCeiling: 0.85, minSymbolsForCorrelation: 4 },
    }, broker, silentLogger);

    const report = await engine.tick();
    expect(report.tradeable).toBe(false);
    expect(report.blockedReason).toContain("correlation");
    expect(broker.opened.length).toBe(0);
  });

  test("blocks rebalance when risk guard says paused", async () => {
    const broker = new FakeBroker();
    broker.equity = 7500;            // -25% from initial 10k
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine({
      universe: ["X"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 1, minLongScore: 0.001 },
    }, broker, silentLogger);

    // Seed peakEquity so the engine knows we drew down.
    // We do that by ticking once at higher equity, then dropping.
    broker.equity = 10_000;
    await engine.tick();
    broker.equity = 7_500;
    const report = await engine.tick();
    expect(report.tradeable).toBe(false);
    expect(report.blockedReason).toContain("drawdown");
  });

  test("holds positions with missing or insufficient candles and opens nothing", async () => {
    for (const heldCandles of [[], ramp(100, 130, 1)]) {
      const broker = new FakeBroker();
      broker.setCandles("HELD", heldCandles);
      broker.setCandles("NEW", ramp(100, 130));
      broker.positions = [{ symbol: "HELD", side: "buy", quantity: 1, notional: 3000 }];
      const engine = new MomentumEngine({ universe: ["HELD", "NEW"] }, broker, silentLogger);

      const report = await engine.tick();

      expect(broker.closed).toEqual([]);
      expect(broker.opened).toEqual([]);
      expect(report.actions).toEqual([]);
      expect(report.unchanged).toEqual(["HELD"]);
    }
  });

  test("undecidable held symbols block new opens but not decidable exits", async () => {
    const broker = new FakeBroker();
    broker.setCandles("HELD_MISSING", []);
    broker.setCandles("LOSER", ramp(100, 80));
    broker.setCandles("NEW", ramp(100, 130));
    broker.positions = [
      { symbol: "HELD_MISSING", side: "buy", quantity: 1, notional: 3000 },
      { symbol: "LOSER", side: "buy", quantity: 1, notional: 3000 },
    ];
    const engine = new MomentumEngine({ universe: ["HELD_MISSING", "LOSER", "NEW"] }, broker, silentLogger);

    const report = await engine.tick();

    expect(broker.closed.map(a => a.symbol)).toEqual(["LOSER"]);
    expect(broker.opened).toEqual([]);
    expect(report.unchanged).toEqual(["HELD_MISSING"]);
  });

  test("risk block still allows a normal momentum exit", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    broker.positions = [{ symbol: "X", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine({ universe: ["X"] }, broker, silentLogger);
    await engine.tick();

    broker.equity = 7_500;
    broker.setCandles("X", ramp(100, 80));
    const report = await engine.tick();

    expect(report.tradeable).toBe(false);
    expect(broker.closed.map(a => a.symbol)).toEqual(["X"]);
    expect(report.actions).toEqual([expect.objectContaining({ type: "close", symbol: "X" })]);
  });

  test("risk block prevents new opens and does not report them as executed", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 100));
    const engine = new MomentumEngine({ universe: ["X"] }, broker, silentLogger);
    await engine.tick();

    broker.equity = 7_500;
    broker.setCandles("X", ramp(100, 130));
    const report = await engine.tick();

    expect(report.tradeable).toBe(false);
    expect(broker.opened).toEqual([]);
    expect(report.actions).toEqual([]);
  });

  test("does not churn positions whose target side already matches current", async () => {
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", ramp(100, 130));
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine({
      universe: ["BTC/USD"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 1, minLongScore: 0.001 },
    }, broker, silentLogger);

    const report = await engine.tick();
    expect(broker.opened.length).toBe(0);
    expect(broker.closed.length).toBe(0);
    expect(report.unchanged).toEqual(["BTC/USD"]);
  });

  test("closes positions whose symbol fell out of the target portfolio", async () => {
    const broker = new FakeBroker();
    broker.setCandles("WINNER", ramp(100, 140));
    broker.setCandles("LOSER",  ramp(100, 90));
    broker.positions = [{ symbol: "LOSER", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine({
      universe: ["WINNER", "LOSER"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 1, minLongScore: 0.01 },
    }, broker, silentLogger);

    await engine.tick();
    expect(broker.closed.map(c => c.symbol)).toContain("LOSER");
    expect(broker.opened.map(o => o.symbol)).toContain("WINNER");
  });

  test("persists risk state via the injected persistence adapter", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const saved: any[] = [];
    const persistence = {
      load: () => null,
      save: (s: any) => { saved.push({ ...s }); },
    };
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 } },
      broker, silentLogger, persistence,
    );
    await engine.tick();
    expect(saved.length).toBeGreaterThan(0);
    expect(saved[saved.length - 1].risk.peakEquity).toBe(10_000);
  });

  test("recovers risk state from persistence on construction", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const previousState = {
      peakEquity: 12_000, dayStartEquity: 11_500, dayStartedAt: Date.now() - 1000,
      consecutiveLosses: 2, pausedUntil: 0, pauseReason: "", lastEvalAt: 0,
    };
    const persistence = { load: () => ({ v: 1 as const, risk: previousState }), save: () => {} };
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 } },
      broker, silentLogger, persistence,
    );
    expect(engine.getRiskState().peakEquity).toBe(12_000);
    expect(engine.getRiskState().consecutiveLosses).toBe(2);
  });

  test("close orders are issued before open orders (capital ordering)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("NEW",     ramp(100, 130));
    broker.setCandles("OLD_OUT", ramp(100, 80));
    broker.positions = [{ symbol: "OLD_OUT", side: "buy", quantity: 1, notional: 3000 }];

    const order: string[] = [];
    const tracking = new FakeBroker();
    tracking.setCandles("NEW",     broker.candleStore.get("NEW")!);
    tracking.setCandles("OLD_OUT", broker.candleStore.get("OLD_OUT")!);
    tracking.positions = [...broker.positions];
    tracking.openPosition = async (a) => { order.push(`open:${a.symbol}`); tracking.opened.push(a); return { ok: true }; };
    tracking.closePosition = async (a) => { order.push(`close:${a.symbol}`); tracking.closed.push(a); tracking.positions = tracking.positions.filter(p => p.symbol !== a.symbol); return { ok: true }; };

    const engine = new MomentumEngine(
      { universe: ["NEW", "OLD_OUT"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.01 } },
      tracking, silentLogger,
    );
    await engine.tick();
    void engine; // silence unused warning
    const closeIdx = order.findIndex(s => s.startsWith("close:"));
    const openIdx = order.findIndex(s => s.startsWith("open:"));
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThan(closeIdx);
  });

  test("volTarget scales open notional (wiring)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    // minScale = maxScale = 0.5 pins the scale regardless of realized vol.
    const engine = new MomentumEngine(
      {
        universe: ["X"], notionalPctPerSlot: 0.30,
        volTarget: { annualizedPct: 60, lookbackBars: 720, minScale: 0.5, maxScale: 0.5 },
        scorer: { topLongs: 1, minLongScore: 0.001 },
      },
      broker, silentLogger,
    );
    await engine.tick();
    expect(broker.opened.length).toBe(1);
    expect(broker.opened[0].notionalUsd).toBeCloseTo(10_000 * 0.30 * 0.5, 6);
  });
});

describe("volTargetScale", () => {
  // closes with alternating ±1% log returns → sample stdev per bar is known.
  function alternating(n: number): number[] {
    const closes = [100];
    for (let i = 0; i < n; i++) closes.push(closes[closes.length - 1] * Math.exp(i % 2 === 0 ? 0.01 : -0.01));
    return closes;
  }

  test("scales by target / realized vol", () => {
    const closes = alternating(20); // 20 rets, mean 0, stdev = sqrt(20*1e-4/19)
    const perBar = Math.sqrt((20 * 0.0001) / 19);
    const realized = perBar * Math.sqrt(8760); // 1h bars → 8760/yr
    const expected = 0.48 / realized;
    const s = volTargetScale(closes, { annualizedPct: 48, lookbackBars: 720, minScale: 0.1, maxScale: 2 }, 8760);
    expect(s).toBeCloseTo(expected, 6);
  });

  test("clamps to maxScale (low vol never levers up past cap)", () => {
    const s = volTargetScale(alternating(20), { annualizedPct: 500, lookbackBars: 720, minScale: 0.3, maxScale: 1.0 }, 8760);
    expect(s).toBe(1.0);
  });

  test("clamps to minScale (high vol floors, never zeroes)", () => {
    const s = volTargetScale(alternating(20), { annualizedPct: 1, lookbackBars: 720, minScale: 0.3, maxScale: 1.0 }, 8760);
    expect(s).toBe(0.3);
  });

  test("uses only the last lookbackBars closes", () => {
    // Wild early history followed by the calm alternating tail — with
    // lookbackBars = 20, only the tail matters.
    const wild = [100, 200, 50, 400, 25];
    const tail = alternating(20);
    const full = [...wild, ...tail.map(c => c * 1)];
    const sTailOnly = volTargetScale(tail, { annualizedPct: 48, lookbackBars: 20, minScale: 0.1, maxScale: 2 }, 8760);
    const sFull = volTargetScale(full, { annualizedPct: 48, lookbackBars: 20, minScale: 0.1, maxScale: 2 }, 8760);
    expect(sFull).toBeCloseTo(sTailOnly, 6);
  });

  test("fails open to 1 on insufficient history", () => {
    expect(volTargetScale([], { annualizedPct: 60, lookbackBars: 720, minScale: 0.3, maxScale: 1 }, 8760)).toBe(1);
    expect(volTargetScale([100], { annualizedPct: 60, lookbackBars: 720, minScale: 0.3, maxScale: 1 }, 8760)).toBe(1);
    expect(volTargetScale([100, 101], { annualizedPct: 60, lookbackBars: 720, minScale: 0.3, maxScale: 1 }, 8760)).toBe(1);
  });

  test("fails open to 1 on zero vol (constant price)", () => {
    const flat = Array(50).fill(100);
    expect(volTargetScale(flat, { annualizedPct: 60, lookbackBars: 720, minScale: 0.3, maxScale: 1 }, 8760)).toBe(1);
  });
});

describe("trailPctFromVol", () => {
  function alternating(n: number): number[] {
    const closes = [100];
    for (let i = 0; i < n; i++) closes.push(closes[closes.length - 1] * Math.exp(i % 2 === 0 ? 0.01 : -0.01));
    return closes;
  }

  test("distance = kSigma × realized daily vol (percent-units)", () => {
    const closes = alternating(24); // 24 rets of ±1% log — σ_bar = sqrt(24e-4/23)
    const perBar = Math.sqrt((24 * 0.0001) / 23);
    const daily = perBar * Math.sqrt(24); // 1h bars → 24/day
    const expected = 3 * daily * 100;
    const p = trailPctFromVol(closes, { kSigma: 3, lookbackBars: 24, minPct: 0.1, maxPct: 50 }, 24);
    expect(p).toBeCloseTo(expected, 6);
  });

  test("clamps to [minPct, maxPct]", () => {
    const closes = alternating(24);
    expect(trailPctFromVol(closes, { kSigma: 100, lookbackBars: 24, minPct: 2, maxPct: 8 }, 24)).toBe(8);
    expect(trailPctFromVol(closes, { kSigma: 0.001, lookbackBars: 24, minPct: 2, maxPct: 8 }, 24)).toBe(2);
  });

  test("fails open to maxPct on insufficient or degenerate history", () => {
    expect(trailPctFromVol([], { kSigma: 3, lookbackBars: 24, minPct: 2, maxPct: 8 }, 24)).toBe(8);
    expect(trailPctFromVol([100, 101], { kSigma: 3, lookbackBars: 24, minPct: 2, maxPct: 8 }, 24)).toBe(8);
    expect(trailPctFromVol(Array(50).fill(100), { kSigma: 3, lookbackBars: 24, minPct: 2, maxPct: 8 }, 24)).toBe(8);
  });

  test("uses only the last lookbackBars closes", () => {
    const wild = [100, 200, 50, 400, 25];
    const tail = alternating(24);
    const a = trailPctFromVol(tail, { kSigma: 3, lookbackBars: 24, minPct: 0.1, maxPct: 50 }, 24);
    const b = trailPctFromVol([...wild, ...tail], { kSigma: 3, lookbackBars: 24, minPct: 0.1, maxPct: 50 }, 24);
    expect(b).toBeCloseTo(a, 6);
  });
});

describe("rollingSharpe", () => {
  // closes from explicit daily returns, 1 close per day (barsPerDay = 1)
  function fromDaily(rets: number[]): number[] {
    const closes = [100];
    for (const r of rets) closes.push(closes[closes.length - 1] * (1 + r));
    return closes;
  }

  test("computes annualized mean/sd of daily returns", () => {
    const rets = [0.01, -0.01, 0.02, 0.005, -0.005];
    const closes = fromDaily(rets);
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
    const s = rollingSharpe(closes, 5, 1);
    expect(s).not.toBeNull();
    expect(s!).toBeCloseTo((mean / sd) * Math.sqrt(365), 6);
  });

  test("samples every barsPerDay-th close", () => {
    // 3 closes per "day"; only the day-boundary closes should matter
    const daily = fromDaily([0.01, -0.02, 0.03, 0.01, -0.01]);
    const intraday: number[] = [];
    for (const c of daily) intraday.push(c * 0.99, c * 1.01, c); // noise, noise, day close
    const sDaily = rollingSharpe(daily, 5, 1);
    const sIntraday = rollingSharpe(intraday, 5, 3);
    expect(sIntraday).not.toBeNull();
    expect(sIntraday!).toBeCloseTo(sDaily!, 6);
  });

  test("returns null on insufficient history (gate fails open)", () => {
    expect(rollingSharpe([], 30, 1)).toBeNull();
    expect(rollingSharpe(fromDaily([0.01, 0.02]), 30, 1)).toBeNull();
    expect(rollingSharpe(fromDaily(Array(29).fill(0.01)), 30, 1)).toBeNull();
  });

  test("degenerate sd resolves by mean sign", () => {
    // ×2 / ×0.5 daily factors are exact in fp → returns identical → sd = 0
    expect(rollingSharpe(fromDaily(Array(30).fill(1.0)), 30, 1)).toBe(Infinity);
    expect(rollingSharpe(fromDaily(Array(30).fill(-0.5)), 30, 1)).toBe(-Infinity);
    expect(rollingSharpe(fromDaily(Array(30).fill(0)), 30, 1)).toBeNull();
  });
});

describe("MomentumEngine tsmTrail wiring", () => {
  // Ramp up to a peak; optionally append a pullback (12 x 5m bars) at `dropTo`.
  function rampCandles(dropTo?: number): OHLCV[] {
    const base = ramp(100, 130); // 35d of 5m bars ending at 130
    if (dropTo === undefined) return base;
    const lastTs = base[base.length - 1].timestamp;
    const out = [...base];
    for (let i = 1; i <= 12; i++) {
      out.push({ open: dropTo, high: dropTo, low: dropTo, close: dropTo, volume: 1, timestamp: lastTs + i * 5 * 60_000 });
    }
    return out;
  }

  // minPct = maxPct = 2 pins the trail at 2% regardless of realized vol.
  const trailCfg = { kSigma: 3, lookbackBars: 288, minPct: 2, maxPct: 2 };
  // The synthetic ramp has ~zero baseline vol, so ANY drop trips the regime
  // vol-spike gate — disable it to test the tradeable-path behavior.
  const noVolGate = { volSpikeMultiplier: 1e9 };

  test("closes a held position that retraces beyond the trail from its peak", async () => {
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", rampCandles());
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(
      { universe: ["BTC/USD"], notionalPctPerSlot: 0.30, tsmTrail: trailCfg, regime: noVolGate },
      broker, silentLogger,
    );

    // Tick 1: position sighted at the peak (130) — watermark starts there, TSM holds.
    const r1 = await engine.tick();
    expect(broker.closed.length).toBe(0);
    expect(r1.unchanged).toEqual(["BTC/USD"]);

    // Pullback to 126.1 (−3% from peak > 2% trail; 14d r still > exit, px > MA30).
    broker.setCandles("BTC/USD", rampCandles(126.1));
    const r2 = await engine.tick();
    expect(broker.closed.map(c => c.symbol)).toEqual(["BTC/USD"]);
    const trailClose = r2.actions.find(a => a.type === "close" && a.symbol === "BTC/USD");
    expect(trailClose?.reason).toContain("trail stop");
    // trail-stopped symbol sits out this tick — no same-tick re-open churn
    expect(broker.opened.length).toBe(0);
    expect(r2.decisions.find(d => d.symbol === "BTC/USD")?.action).toBe("flat");
  });

  test("same pullback with flag OFF does not close (default no-op)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", rampCandles());
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(
      { universe: ["BTC/USD"], notionalPctPerSlot: 0.30, regime: noVolGate },
      broker, silentLogger,
    );
    await engine.tick();
    broker.setCandles("BTC/USD", rampCandles(126.1));
    await engine.tick();
    expect(broker.closed.length).toBe(0); // TSM holds: r > exit threshold, px > MA
  });

  test("watermark extends over bar closes between ticks (not just tick closes)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", rampCandles());
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(
      { universe: ["BTC/USD"], notionalPctPerSlot: 0.30, tsmTrail: trailCfg, regime: noVolGate },
      broker, silentLogger,
    );
    await engine.tick(); // watermark = 130
    // Between ticks price spiked to 140 then fell to 137.9: only −1.5% from the
    // LAST TICK close (130→never seen 140 at a tick) but −1.5% vs 140 peak…
    // 137.9 < 140×0.98 = 137.2 is false → no exit; at 137.1 it fires.
    const base = rampCandles();
    const lastTs = base[base.length - 1].timestamp;
    const spike = [...base];
    spike.push({ open: 140, high: 140, low: 140, close: 140, volume: 1, timestamp: lastTs + 5 * 60_000 });
    spike.push({ open: 137.1, high: 137.1, low: 137.1, close: 137.1, volume: 1, timestamp: lastTs + 10 * 60_000 });
    broker.setCandles("BTC/USD", spike);
    const r = await engine.tick();
    // peak extended to 140 via the intermediate bar; 137.1 ≤ 140×0.98 = 137.2 → close
    expect(broker.closed.map(c => c.symbol)).toEqual(["BTC/USD"]);
    expect(r.actions[0]?.reason).toContain("trail stop");
  });

  test("watermark is dropped when the position disappears (closed elsewhere)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", rampCandles());
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(
      { universe: ["BTC/USD"], notionalPctPerSlot: 0.30, tsmTrail: trailCfg, regime: noVolGate },
      broker, silentLogger,
    );
    await engine.tick(); // watermark = 130
    broker.positions = []; // hard SL / manual close took it out
    broker.setCandles("BTC/USD", rampCandles(126.1));
    await engine.tick();
    expect(broker.closed.length).toBe(0); // nothing to trail-close, no stale mark firing
  });

  test("a trail close carries closeReason=TRAIL_STOP to the adapter; a signal-flip close carries none", async () => {
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", rampCandles());
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(
      { universe: ["BTC/USD"], notionalPctPerSlot: 0.30, tsmTrail: trailCfg, regime: noVolGate },
      broker, silentLogger,
    );
    await engine.tick(); // watermark = 130
    broker.setCandles("BTC/USD", rampCandles(126.1));
    await engine.tick(); // −3% from peak > 2% trail → trail close
    expect(broker.closed).toHaveLength(1);
    expect(broker.closed[0].closeReason).toBe(TRAIL_STOP_CLOSE_REASON);

    // Signal flip (no trail config): decision-driven close passes NO closeReason
    // — the adapter's default MOMENTUM_REBALANCE label applies.
    const flipBroker = new FakeBroker();
    flipBroker.setCandles("BTC/USD", ramp(100, 60)); // hard downtrend → exit signal
    flipBroker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const flipEngine = new MomentumEngine(
      { universe: ["BTC/USD"], notionalPctPerSlot: 0.30, regime: noVolGate },
      flipBroker, silentLogger,
    );
    await flipEngine.tick();
    expect(flipBroker.closed).toHaveLength(1);
    expect(flipBroker.closed[0].closeReason).toBeUndefined();
  });
});

describe("MomentumEngine trailMarks persistence (deploy-restart watermark survival)", () => {
  function rampCandles(dropTo?: number): OHLCV[] {
    const base = ramp(100, 130);
    if (dropTo === undefined) return base;
    const lastTs = base[base.length - 1].timestamp;
    const out = [...base];
    for (let i = 1; i <= 12; i++) {
      out.push({ open: dropTo, high: dropTo, low: dropTo, close: dropTo, volume: 1, timestamp: lastTs + i * 5 * 60_000 });
    }
    return out;
  }
  const trailCfg = { kSigma: 3, lookbackBars: 288, minPct: 2, maxPct: 2 };
  const noVolGate = { volSpikeMultiplier: 1e9 };
  const engineCfg = { universe: ["BTC/USD"], notionalPctPerSlot: 0.30, tsmTrail: trailCfg, regime: noVolGate };

  /** In-memory MomentumStatePersistence sharing one envelope across engines
   *  (JSON round-trip on save = same fidelity as the real file store). */
  function memoryPersistence(initial: MomentumPersistedState | null = null) {
    let stored: MomentumPersistedState | null = initial;
    const persistence: MomentumStatePersistence = {
      load: () => stored,
      save: (s) => { stored = JSON.parse(JSON.stringify(s)); },
    };
    return { persistence, get: () => stored };
  }

  test("THE bug-killer: watermark survives a restart — the trail fires from the REAL peak, not the current close", async () => {
    const store = memoryPersistence();
    const broker1 = new FakeBroker();
    broker1.setCandles("BTC/USD", rampCandles());
    broker1.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine1 = new MomentumEngine(engineCfg, broker1, silentLogger, store.persistence);
    await engine1.tick(); // watermark = 130, persisted by the in-tick persistState
    expect(store.get()?.trailMarks?.["BTC/USD|buy"]?.mark).toBeCloseTo(130, 6);

    // "Deploy": brand-new engine + broker objects, same persistence, position
    // still open on the broker, price pulled back to 126.1 (−3% from the 130
    // peak but only −0% from its own first-sighting close).
    const broker2 = new FakeBroker();
    broker2.setCandles("BTC/USD", rampCandles(126.1));
    broker2.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine2 = new MomentumEngine(engineCfg, broker2, silentLogger, store.persistence);
    const r = await engine2.tick();
    expect(broker2.closed.map(c => c.symbol)).toEqual(["BTC/USD"]); // fired from the restored 130 peak
    expect(broker2.closed[0].closeReason).toBe(TRAIL_STOP_CLOSE_REASON);
    expect(r.actions.find(a => a.type === "close")?.reason).toContain("peak 130");

    // Control (documents the pre-fix behavior): identical restart WITHOUT
    // persistence re-anchors at the current close and never fires.
    const broker3 = new FakeBroker();
    broker3.setCandles("BTC/USD", rampCandles(126.1));
    broker3.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine3 = new MomentumEngine(engineCfg, broker3, silentLogger);
    await engine3.tick();
    expect(broker3.closed.length).toBe(0);
  });

  test("a restored watermark older than 7 days is discarded (re-anchors at current close, no fire)", async () => {
    const staleTs = Date.now() - MAX_RESTORED_TRAIL_MARK_AGE_MS - 60_000;
    const store = memoryPersistence({
      v: 1,
      risk: { ...INITIAL_RISK_STATE },
      trailMarks: { "BTC/USD|buy": { mark: 130, lastTs: staleTs } },
    });
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", rampCandles(126.1)); // −3% off 130: WOULD fire if the stale mark were honored
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(engineCfg, broker, silentLogger, store.persistence);
    await engine.tick();
    expect(broker.closed.length).toBe(0); // discarded: watermark re-anchored at 126.1
  });

  test("a restored watermark for the OPPOSITE side is pruned before it can fire", async () => {
    const store = memoryPersistence({
      v: 1,
      risk: { ...INITIAL_RISK_STATE },
      // Trough mark from a SHORT that no longer exists; current position is a LONG.
      trailMarks: { "BTC/USD|sell": { mark: 100, lastTs: Date.now() - 60_000 } },
    });
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", rampCandles(126.1));
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(engineCfg, broker, silentLogger, store.persistence);
    await engine.tick();
    expect(broker.closed.length).toBe(0); // sell-mark pruned; buy watermark starts fresh at 126.1
    expect(store.get()?.trailMarks?.["BTC/USD|sell"]).toBeUndefined(); // prune persisted too
    expect(store.get()?.trailMarks?.["BTC/USD|buy"]?.mark).toBeCloseTo(126.1, 6);
  });

  test("malformed persisted marks are dropped, never a NaN stop", async () => {
    const store = memoryPersistence({
      v: 1,
      risk: { ...INITIAL_RISK_STATE },
      trailMarks: {
        "BTC/USD|buy": { mark: NaN, lastTs: Date.now() } as any,
      },
    });
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", rampCandles(126.1));
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(engineCfg, broker, silentLogger, store.persistence);
    await engine.tick();
    expect(broker.closed.length).toBe(0); // NaN mark ignored; fresh watermark at 126.1
  });

  test("stop() flushes marks raised on a tick whose persist was skipped (equity-invalid corner)", async () => {
    const store = memoryPersistence();
    const broker = new FakeBroker();
    broker.setCandles("BTC/USD", rampCandles());
    broker.positions = [{ symbol: "BTC/USD", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(engineCfg, broker, silentLogger, store.persistence);
    broker.getEquity = async () => { throw new Error("feed down"); }; // equity invalid → in-tick persists skipped
    await engine.tick(); // trail logic still ran best-effort: mark = 130 in memory only
    expect(store.get()).toBeNull();
    engine.stop(); // shutdown flush
    expect(store.get()?.trailMarks?.["BTC/USD|buy"]?.mark).toBeCloseTo(130, 6);
  });
});

describe("MomentumEngine sharpeGate wiring", () => {
  // Daily bars (tsm barMinutes = 1440): 25 days at −2%, then 10 at +3.5%.
  // 14d momentum = +30% (long signal, px > MA30) but last-30d daily Sharpe ≈ −1.2.
  function vShape(): OHLCV[] {
    const rets = [...Array(25).fill(-0.02), ...Array(10).fill(0.035)];
    const out: OHLCV[] = [];
    let px = 100;
    const baseTs = Date.now() - (rets.length + 1) * 86_400_000;
    out.push({ open: px, high: px, low: px, close: px, volume: 1, timestamp: baseTs });
    rets.forEach((r, i) => {
      px *= 1 + r;
      out.push({ open: px, high: px, low: px, close: px, volume: 1, timestamp: baseTs + (i + 1) * 86_400_000 });
    });
    return out;
  }
  const dailyTsm = { barMinutes: 1440 };

  test("blocks a NEW entry whose rolling Sharpe is below threshold", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", vShape());
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, tsm: dailyTsm, sharpeGate: { lookbackDays: 30, minSharpe: 0 } },
      broker, silentLogger,
    );
    const report = await engine.tick();
    expect(broker.opened.length).toBe(0);
    const d = report.decisions.find(d => d.symbol === "X");
    expect(d?.action).toBe("flat");
    expect(d?.reason).toContain("sharpe gate");
  });

  test("same fixture with flag OFF opens (default no-op)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", vShape());
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, tsm: dailyTsm },
      broker, silentLogger,
    );
    await engine.tick();
    expect(broker.opened.map(o => o.symbol)).toEqual(["X"]);
  });

  test("does NOT touch an already-held position (entries only)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", vShape());
    broker.positions = [{ symbol: "X", side: "buy", quantity: 1, notional: 3000 }];
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, tsm: dailyTsm, sharpeGate: { lookbackDays: 30, minSharpe: 0 } },
      broker, silentLogger,
    );
    const report = await engine.tick();
    expect(broker.closed.length).toBe(0);
    expect(report.unchanged).toEqual(["X"]);
  });

  test("fails open when history is too short for the lookback", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", vShape()); // 36 daily closes < 60d lookback
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, tsm: dailyTsm, sharpeGate: { lookbackDays: 60, minSharpe: 0 } },
      broker, silentLogger,
    );
    await engine.tick();
    expect(broker.opened.map(o => o.symbol)).toEqual(["X"]);
  });
});

describe("MomentumEngine heartbeat wiring", () => {
  test("beats its configured heartbeat name on a successful tick", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 }, heartbeatName: "test:momentum-hb" },
      broker, silentLogger,
    );
    // Absent before, present + fresh after ⇒ tick() beat it (beat auto-registers
    // an unseen name — this is the externally-driven path index.ts uses for
    // momentum:stocks). Silence the one auto-register warn line during the tick.
    expect(heartbeats.snapshot().some(s => s.name === "test:momentum-hb")).toBe(false);
    const origLog = console.log;
    console.log = () => {};
    try { await engine.tick(); } finally { console.log = origLog; }
    const snap = heartbeats.snapshot().find(s => s.name === "test:momentum-hb");
    expect(snap).toBeDefined();
    expect(snap!.stale).toBe(false);
  });
});

describe("MomentumEngine equity fail-closed", () => {
  test("getEquity throwing (disconnected broker) blocks opens and freezes RiskGuard state, but a legitimate close still executes", async () => {
    const broker = new FakeBroker();
    // LOSER falls out of the target portfolio (must still be closed); WINNER
    // would score as a brand-new long entry (must NOT be opened).
    broker.setCandles("LOSER", ramp(100, 80));
    broker.setCandles("WINNER", ramp(100, 130));
    broker.positions = [{ symbol: "LOSER", side: "buy", quantity: 1, notional: 3000 }];
    broker.getEquity = async () => { throw new Error("binance not connected"); };
    const saved: any[] = [];
    const persistence = { load: () => null, save: (s: any) => saved.push(s) };
    const engine = new MomentumEngine(
      {
        universe: ["LOSER", "WINNER"], notionalPctPerSlot: 0.30,
        scorer: { topLongs: 1, minLongScore: 0.01 },
        heartbeatName: "test:momentum-hb-equity-fail",
      },
      broker, silentLogger, persistence,
    );

    const report = await engine.tick();

    expect(report.tradeable).toBe(false);
    expect(broker.closed.map(c => c.symbol)).toEqual(["LOSER"]); // legitimate close still executes
    expect(broker.opened).toEqual([]);                            // opens blocked
    expect(saved).toEqual([]);                                    // no RiskGuard persistence
    expect(engine.getRiskState()).toEqual(INITIAL_RISK_STATE);    // no RiskGuard mutation
    // Not a successful rebalance: liveness heartbeat must not be beaten.
    expect(heartbeats.snapshot().find(s => s.name === "test:momentum-hb-equity-fail")).toBeUndefined();
  });

  test("non-finite/non-positive equity (NaN, 0, negative) fails closed the same way", async () => {
    for (const bad of [NaN, 0, -100]) {
      const broker = new FakeBroker();
      broker.setCandles("X", ramp(100, 130));
      broker.equity = bad;
      const saved: any[] = [];
      const persistence = { load: () => null, save: (s: any) => saved.push(s) };
      const engine = new MomentumEngine({ universe: ["X"] }, broker, silentLogger, persistence);

      const report = await engine.tick();

      expect(report.tradeable).toBe(false);
      expect(broker.opened).toEqual([]);
      expect(saved).toEqual([]);
      expect(engine.getRiskState()).toEqual(INITIAL_RISK_STATE);
    }
  });

  test("a healthy tick still opens and persists normally (no regression)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 } },
      broker, silentLogger,
    );
    const report = await engine.tick();
    expect(report.tradeable).toBe(true);
    expect(broker.opened.length).toBe(1);
  });
});

// ── Pause transition events (B-ops-alerts.md #1) ────────────────────────────
// 372 blocked crypto ticks over 16 days paged nobody: RiskGuard's evaluateRisk
// runs every tick, but nothing distinguished "just paused" from "still
// paused" until now. EVENTS.CIRCUIT_BREAKER must fire exactly on the
// TRANSITION, never per tick.
import { captureEvent } from "../../test-support/events";

describe("MomentumEngine — pause transition events (B-ops-alerts.md #1)", () => {
  test("a fresh soft-drawdown breach fires ONE pause_started; continuing ticks while still paused fire nothing more", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 }, heartbeatName: "test:pause-events" },
      broker, silentLogger,
    );
    const { events, detach } = captureEvent(EVENTS.CIRCUIT_BREAKER);
    try {
      broker.equity = 10_000;
      await engine.tick(); // seeds peakEquity, no breach — no event
      expect(events).toHaveLength(0);

      broker.equity = 8_900; // -11%, past softDrawdownPct (-10%)
      await engine.tick(); // fresh breach → pause_started
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sleeve: "test:pause-events", profileId: "test:pause-events", action: "pause_started" });
      expect(events[0].reason).toContain("soft drawdown");
      expect(events[0].resumeAt).toBeGreaterThan(Date.now());

      // Still within the pause window — a CONTINUATION tick must NOT re-fire.
      await engine.tick();
      await engine.tick();
      expect(events).toHaveLength(1);
    } finally { detach(); }
  });

  test("recovery (equity back above the drawdown threshold once the pause window lapses) fires ONE pause_resolved, never per tick", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const clock = new TestClock(Date.parse("2026-07-20T10:00:00Z"));
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 }, heartbeatName: "test:pause-resolve" },
      broker, silentLogger, undefined, clock,
    );
    const { events, detach } = captureEvent(EVENTS.CIRCUIT_BREAKER);
    try {
      broker.equity = 10_000;
      await engine.tick(); // seed peak
      broker.equity = 8_900; // -11% → soft drawdown, 24h pause
      await engine.tick();
      expect(events.map(e => e.action)).toEqual(["pause_started"]);

      clock.advance(25 * 60 * 60_000); // past the 24h soft-pause window
      broker.equity = 10_000; // recovered — no new breach this tick
      await engine.tick();
      expect(events.map(e => e.action)).toEqual(["pause_started", "pause_resolved"]);
      expect(events[1].reason).toContain("soft drawdown"); // names what it recovered FROM

      // A further healthy tick must not re-fire the resolution.
      await engine.tick();
      expect(events).toHaveLength(2);
    } finally { detach(); }
  });

  test("hard drawdown ALSO pages ops via a separate ERROR_BURST (RiskGuard.hardDrawdown context)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 }, heartbeatName: "test:pause-harddd" },
      broker, silentLogger,
    );
    const { events: breakers, detach: detachCb } = captureEvent(EVENTS.CIRCUIT_BREAKER);
    const { events: bursts, detach: detachBurst } = captureEvent(EVENTS.ERROR_BURST);
    try {
      broker.equity = 10_000;
      await engine.tick();
      broker.equity = 7_500; // -25%, past hardDrawdownPct (-20%)
      await engine.tick();

      expect(breakers).toHaveLength(1);
      expect(breakers[0].action).toBe("pause_started");
      expect(breakers[0].reason).toContain("hard drawdown");
      // The ops-only page rides a SEPARATE event — never inline in the
      // user-facing CIRCUIT_BREAKER handler (see alerts.test.ts's
      // "no sendOps" guard on that listener).
      const hardDdBursts = bursts.filter((b: any) => b.context === "RiskGuard.hardDrawdown");
      expect(hardDdBursts).toHaveLength(1);
      expect(hardDdBursts[0].message).toContain("test:pause-harddd");
    } finally { detachCb(); detachBurst(); }
  });

  test("a restart mid-pause (loaded state already has pausedUntil > now) does NOT re-fire pause_started on the first post-restart tick", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    broker.equity = 8_900; // still within the drawdown band
    const now = Date.now();
    const persisted: MomentumPersistedState = {
      v: 1,
      risk: {
        ...INITIAL_RISK_STATE,
        peakEquity: 10_000,
        dayStartEquity: 10_000,
        dayStartedAt: now,
        pausedUntil: now + 12 * 3_600_000, // 12h still to go
        pauseReason: "soft drawdown 11.0% — paused 24h",
        lastEvalAt: now,
      },
    };
    const persistence = { load: () => persisted, save: () => {} };
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 }, heartbeatName: "test:pause-restart" },
      broker, silentLogger, persistence,
    );
    const { events, detach } = captureEvent(EVENTS.CIRCUIT_BREAKER);
    try {
      await engine.tick(); // continuation of an ALREADY-persisted pause — must be silent
      expect(events).toHaveLength(0);
    } finally { detach(); }
  });
});

describe("MomentumEngine tick() reentrancy guard", () => {
  test("a concurrent tick() call is skipped instead of double-executing the rebalance", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 } },
      broker, silentLogger,
    );

    // Fire two ticks back-to-back without awaiting the first — tick() runs
    // synchronously up to its first await, so the guard is already armed
    // before the second call's own guard check runs.
    const p1 = engine.tick();
    const r2 = await engine.tick();

    expect(r2.tradeable).toBe(false);
    expect(r2.blockedReason).toContain("already in progress");
    expect(r2.actions).toEqual([]);
    expect(r2.decisions).toEqual([]);

    const r1 = await p1;
    expect(r1.tradeable).toBe(true);
    expect(broker.opened.length).toBe(1); // only the first tick actually opened
  });

  test("a later tick() (after the first resolves) is NOT blocked (guard releases)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 } },
      broker, silentLogger,
    );
    const r1 = await engine.tick();
    const r2 = await engine.tick();
    expect(r1.tradeable).toBe(true);
    expect(r2.tradeable).toBe(true);
  });
});

describe("MomentumEngine getRealisedPnlSince fail-closed", () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  test("failed read: anchor frozen + opens blocked + closes still run + heartbeat withheld; recovery records the FULL interval; then the anchor advances again", async () => {
    const broker = new FakeBroker();
    broker.setCandles("A", ramp(100, 130));
    broker.setCandles("B", ramp(100, 100));
    // Instrumented realised-pnl source: records every `since` argument so we
    // can observe the private lastRebalanceAt anchor from the outside.
    const pnlCalls: number[] = [];
    let failRead = false;
    let realisedValue = 0;
    broker.getRealisedPnlSince = async (t: number) => {
      pnlCalls.push(t);
      if (failRead) throw new Error("db unavailable");
      return realisedValue;
    };
    const engine = new MomentumEngine(
      {
        universe: ["A", "B"], notionalPctPerSlot: 0.30,
        scorer: { topLongs: 2, minLongScore: 0.01 },
        heartbeatName: "test:momentum-hb-realised-fail",
      },
      broker, silentLogger,
    );

    // Tick 1 (healthy): opens A, arms the anchor at T0. No read yet (anchor was 0).
    const origLog = console.log;
    console.log = () => {}; // silence heartbeat auto-register warn
    try { await engine.tick(); } finally { console.log = origLog; }
    expect(pnlCalls).toEqual([]);
    expect(broker.opened.map(o => o.symbol)).toEqual(["A"]);
    const beatAfterTick1 = heartbeats.snapshot().find(s => s.name === "test:momentum-hb-realised-fail")!.lastBeatMs;

    await sleep(5); // ensure distinct Date.now() between ticks
    // Tick 2: the read FAILS during a losing interval. A falls out of the
    // target (its close MUST run); B turns into a would-be fresh entry (its
    // open must NOT run).
    failRead = true;
    broker.setCandles("A", ramp(100, 80));
    broker.setCandles("B", ramp(100, 130));
    const r2 = await engine.tick();
    expect(pnlCalls.length).toBe(1);
    const t0 = pnlCalls[0]; // the anchor at failure time
    expect(r2.tradeable).toBe(false);
    expect(r2.blockedReason).toContain("loss-streak breaker frozen");
    expect(broker.closed.map(c => c.symbol)).toEqual(["A"]);   // exits still run
    expect(broker.opened.map(o => o.symbol)).toEqual(["A"]);   // B was NOT opened
    expect(engine.getRiskState().consecutiveLosses).toBe(0);   // frozen, no fabricated 0 recorded
    // Not a successful rebalance: the liveness heartbeat must not be beaten
    // (lastBeatMs unchanged), so a persistent failure surfaces as a stale-loop page.
    expect(heartbeats.snapshot().find(s => s.name === "test:momentum-hb-realised-fail")!.lastBeatMs).toBe(beatAfterTick1);

    await sleep(5);
    // Tick 3: the read recovers, reporting the interval's loss. The anchor
    // must NOT have advanced during the failure — the query re-reads from T0,
    // so the failed interval's PnL reaches the streak counter exactly once.
    failRead = false;
    realisedValue = -500;
    await engine.tick();
    expect(pnlCalls.length).toBe(2);
    expect(pnlCalls[1]).toBe(t0);                              // ← anchor frozen through the failure
    expect(engine.getRiskState().consecutiveLosses).toBe(1);   // the lost interval IS counted
    expect(heartbeats.snapshot().find(s => s.name === "test:momentum-hb-realised-fail")!.lastBeatMs).toBeGreaterThan(beatAfterTick1);

    await sleep(5);
    // Tick 4 (healthy): the anchor advanced after the successful tick 3 — no
    // over-freeze, and the recovered interval is never re-read (no double count).
    await engine.tick();
    expect(pnlCalls.length).toBe(3);
    expect(pnlCalls[2]).toBeGreaterThan(t0);
  });

  // A non-finite RETURN is the same failure class as a throw and must take the
  // same path: NaN makes every RiskGuard comparison false (streak frozen while
  // the anchor advances — the interval's PnL lost forever) and Infinity can
  // RESET a real loss streak. Removing the Number.isFinite guard makes these
  // fail on tradeable/blockedReason, the phantom open of B, the beaten
  // heartbeat, the advanced anchor, and the missing ERROR_BURST page.
  for (const bad of [NaN, Infinity]) {
    test(`a non-finite realised return (${bad}) is treated exactly like a failed read: opens blocked, anchor + heartbeat frozen, ERROR_BURST paged, streak counted on recovery`, async () => {
      const broker = new FakeBroker();
      broker.setCandles("A", ramp(100, 130));
      broker.setCandles("B", ramp(100, 100));
      const pnlCalls: number[] = [];
      let realisedValue: number = 0;
      broker.getRealisedPnlSince = async (t: number) => { pnlCalls.push(t); return realisedValue; };
      const hbName = `test:momentum-hb-nonfinite-${bad}`;
      const engine = new MomentumEngine(
        {
          universe: ["A", "B"], notionalPctPerSlot: 0.30,
          scorer: { topLongs: 2, minLongScore: 0.01 },
          heartbeatName: hbName,
        },
        broker, silentLogger,
      );

      // Tick 1 (healthy): opens A, arms the anchor. No read yet (anchor was 0).
      const origLog = console.log;
      console.log = () => {}; // silence heartbeat auto-register warn
      try { await engine.tick(); } finally { console.log = origLog; }
      expect(broker.opened.map(o => o.symbol)).toEqual(["A"]);
      const beatAfterTick1 = heartbeats.snapshot().find(s => s.name === hbName)!.lastBeatMs;

      await sleep(5);
      // Tick 2: the read returns a NON-FINITE value during a losing interval.
      // A falls out of the target (its close MUST run); B becomes a would-be
      // fresh entry (its open must NOT run).
      realisedValue = bad;
      broker.setCandles("A", ramp(100, 80));
      broker.setCandles("B", ramp(100, 130));
      const events: any[] = [];
      const handler = (p: any) => events.push(p);
      eventBus.on(EVENTS.ERROR_BURST, handler);
      let r2;
      try { r2 = await engine.tick(); } finally { eventBus.removeListener(EVENTS.ERROR_BURST, handler); }
      expect(pnlCalls.length).toBe(1);
      const t0 = pnlCalls[0];
      expect(r2.tradeable).toBe(false);
      expect(r2.blockedReason).toContain("loss-streak breaker frozen");
      expect(r2.realisedPnlSinceLastRebalance).toBe(0);          // NaN/Infinity never leaks into the report
      expect(broker.closed.map(c => c.symbol)).toEqual(["A"]);   // exits still run
      expect(broker.opened.map(o => o.symbol)).toEqual(["A"]);   // B was NOT opened
      expect(engine.getRiskState().consecutiveLosses).toBe(0);   // frozen, nothing fabricated
      expect(events.some(e => e.context === "MomentumEngine" && String(e.message).includes("non-finite"))).toBe(true);
      // Not a successful rebalance: heartbeat withheld → stale-loop page.
      expect(heartbeats.snapshot().find(s => s.name === hbName)!.lastBeatMs).toBe(beatAfterTick1);

      await sleep(5);
      // Tick 3: recovery re-reads from the FROZEN anchor, so the bad tick's
      // interval loss reaches the streak counter exactly once.
      realisedValue = -500;
      await engine.tick();
      expect(pnlCalls.length).toBe(2);
      expect(pnlCalls[1]).toBe(t0);                              // anchor frozen through the bad read
      expect(engine.getRiskState().consecutiveLosses).toBe(1);   // the lost interval IS counted
      expect(heartbeats.snapshot().find(s => s.name === hbName)!.lastBeatMs).toBeGreaterThan(beatAfterTick1);
    });
  }

  test("a failed realised read pages ERROR_BURST directly (rebalance cadence can never reach the logger's 10-in-60s burst threshold)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine(
      { universe: ["X"], notionalPctPerSlot: 0.30, scorer: { topLongs: 1, minLongScore: 0.001 } },
      broker, silentLogger,
    );
    await engine.tick(); // arm the anchor
    broker.getRealisedPnlSince = async () => { throw new Error("db unavailable"); };

    const events: any[] = [];
    const handler = (p: any) => events.push(p);
    eventBus.on(EVENTS.ERROR_BURST, handler);
    try { await engine.tick(); } finally { eventBus.removeListener(EVENTS.ERROR_BURST, handler); }

    expect(events.some(e => e.context === "MomentumEngine" && String(e.message).includes("getRealisedPnlSince"))).toBe(true);
  });
});

describe("MomentumEngine timeStop (time barrier — third barrier, OFF by default)", () => {
  /** In-memory persistence — same JSON round-trip fidelity as the file store. */
  function memoryPersistence(initial: MomentumPersistedState | null = null) {
    let stored: MomentumPersistedState | null = initial;
    const persistence: MomentumStatePersistence = {
      load: () => stored,
      save: (s) => { stored = JSON.parse(JSON.stringify(s)); },
    };
    return { persistence, get: () => stored };
  }

  const HOUR = 3_600_000;

  function withClock<T>(fn: (advanceTo: (t: number) => void) => Promise<T>): Promise<T> {
    const realNow = Date.now;
    const t0 = realNow();
    (Date as any).now = () => t0;
    return fn((t: number) => { (Date as any).now = () => t; })
      .finally(() => { (Date as any).now = realNow; });
  }

  test("DEFAULT is OFF: DEFAULT_ENGINE_CONFIG carries no timeStop and an engine without it never time-closes a held position", async () => {
    expect(DEFAULT_ENGINE_CONFIG.timeStop).toBeUndefined();
    await withClock(async advanceTo => {
      const t0 = Date.now();
      const broker = new FakeBroker();
      broker.setCandles("UP1", ramp(100, 130));
      broker.positions = [{ symbol: "UP1", side: "buy", quantity: 1, notional: 3000 }];
      const engine = new MomentumEngine(
        { universe: ["UP1"], scorer: { topLongs: 1, minLongScore: 0.001 } },
        broker, silentLogger,
      );
      await engine.tick();
      advanceTo(t0 + 10_000 * HOUR); // >1 year held — still no barrier
      await engine.tick();
      expect(broker.closed.filter(c => c.closeReason === TIME_STOP_CLOSE_REASON)).toEqual([]);
      expect(broker.positions.map(p => p.symbol)).toEqual(["UP1"]);
    });
  });

  test("fires after maxHoldHours with the canonical TIME_STOP closeReason, and the symbol sits out the same tick", async () => {
    await withClock(async advanceTo => {
      const t0 = Date.now();
      const broker = new FakeBroker();
      broker.setCandles("UP1", ramp(100, 130)); // signal stays long the whole time
      broker.positions = [{ symbol: "UP1", side: "buy", quantity: 1, notional: 3000 }];
      const engine = new MomentumEngine(
        { universe: ["UP1"], scorer: { topLongs: 1, minLongScore: 0.001 }, timeStop: { maxHoldHours: 48 } },
        broker, silentLogger,
      );

      // First sighting anchors the clock at t0 — must NOT fire, even though
      // the true (unknown) entry may be older: conservative restart.
      await engine.tick();
      expect(broker.closed).toEqual([]);

      advanceTo(t0 + 47 * HOUR); // inside the horizon
      await engine.tick();
      expect(broker.closed).toEqual([]);

      advanceTo(t0 + 49 * HOUR); // horizon expired
      const report = await engine.tick();
      const timeCloses = broker.closed.filter(c => c.closeReason === TIME_STOP_CLOSE_REASON);
      expect(timeCloses.map(c => c.symbol)).toEqual(["UP1"]);
      expect(report.actions.some(a => a.type === "close" && a.symbol === "UP1" && a.reason?.includes("time stop"))).toBe(true);
      // Sit-out: the still-long signal must not re-open it on the same tick
      // (that would reset the barrier's clock for free fee churn).
      expect(broker.opened).toEqual([]);
      const d = report.decisions.find(x => x.symbol === "UP1");
      expect(d?.action).toBe("flat");
    });
  });

  test("entry anchor persists across a restart: engine B fires from engine A's REAL entry time — with a no-persistence control that re-anchors", async () => {
    await withClock(async advanceTo => {
      const t0 = Date.now();
      const store = memoryPersistence();
      const brokerA = new FakeBroker();
      brokerA.setCandles("UP1", ramp(100, 130));
      const engineA = new MomentumEngine(
        { universe: ["UP1"], notionalPctPerSlot: 0.3, scorer: { topLongs: 1, minLongScore: 0.001 }, timeStop: { maxHoldHours: 48 } },
        brokerA, silentLogger, store.persistence,
      );
      await engineA.tick();                 // engine A OPENS UP1 → anchor = t0
      expect(brokerA.opened.map(o => o.symbol)).toEqual(["UP1"]);
      engineA.stop();                       // shutdown flush persists the anchor
      expect(store.get()?.entryMarks?.["UP1|buy"]).toBe(t0);

      advanceTo(t0 + 49 * HOUR);            // "restart" 49h later
      const brokerB = new FakeBroker();
      brokerB.setCandles("UP1", ramp(100, 130));
      brokerB.positions = [...brokerA.positions];
      const engineB = new MomentumEngine(
        { universe: ["UP1"], notionalPctPerSlot: 0.3, scorer: { topLongs: 1, minLongScore: 0.001 }, timeStop: { maxHoldHours: 48 } },
        brokerB, silentLogger, store.persistence,
      );
      await engineB.tick();
      expect(brokerB.closed.filter(c => c.closeReason === TIME_STOP_CLOSE_REASON).map(c => c.symbol)).toEqual(["UP1"]);

      // CONTROL — no persistence: the restarted engine re-anchors at first
      // sighting (pre-fix behavior) and holds instead of firing.
      const brokerC = new FakeBroker();
      brokerC.setCandles("UP1", ramp(100, 130));
      brokerC.positions = [{ symbol: "UP1", side: "buy", quantity: 1, notional: 3000 }];
      const engineC = new MomentumEngine(
        { universe: ["UP1"], scorer: { topLongs: 1, minLongScore: 0.001 }, timeStop: { maxHoldHours: 48 } },
        brokerC, silentLogger,
      );
      await engineC.tick();
      expect(brokerC.closed).toEqual([]);
    });
  });

  test("entry anchors are recorded on opens even with the barrier OFF, so a later activation measures real holds", async () => {
    await withClock(async () => {
      const t0 = Date.now();
      const store = memoryPersistence();
      const broker = new FakeBroker();
      broker.setCandles("UP1", ramp(100, 130));
      const engine = new MomentumEngine(
        { universe: ["UP1"], notionalPctPerSlot: 0.3, scorer: { topLongs: 1, minLongScore: 0.001 } }, // NO timeStop
        broker, silentLogger, store.persistence,
      );
      await engine.tick();
      engine.stop();
      expect(store.get()?.entryMarks?.["UP1|buy"]).toBe(t0);
    });
  });
});
