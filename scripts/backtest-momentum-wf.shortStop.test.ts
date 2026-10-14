// Short-only stop axis (line S-bis, V §12-sexies — ShortStopSpec in
// MomentumEngine.ts). GOLDEN RULE first: hashReplayConfig for any config
// that doesn't set `shortStop` must equal the hash from before the field
// existed (profitLock/replayFields pattern). Then the semantics S-bis
// depends on, each hand-verifiable:
//   • shortStopDistancePct: fixed = pct×100; volScaled = kSigma × σ of
//     DAILY log returns over COMPLETED UTC daily closes built from hourly
//     bars (no √-scaling of bar vol), clamped; fails open to maxPct.
//   • SimBroker.openPosition: a SELL resolves stopFrac from shortStop;
//     longs keep the hardStop/legacy path in the SAME run.
//   • checkStops: the short's stop sits ABOVE entry and fills on bar.high
//     (S3's verification: the volScaled hardStop is side-correct too).
//   • MomentumEngine: a SHORT open carries stopLossPct from shortStop (the
//     live-adapter plumbing §12-sexies requires); longs untouched.

import { describe, expect, test } from "bun:test";
import { hashReplayConfig, SimBroker, entryStopFraction, type ReplayConfig } from "./backtest-momentum-wf";
import { completedDailyCloses, shortStopDistancePct, MomentumEngine, type ShortStopSpec } from "../src/strategies/momentum/MomentumEngine";
import { FakeBroker, ramp, silentLogger } from "../src/test-support/momentum";
import type { OHLCV } from "../src/utils/types";

const bar = (timestamp: number, open: number, high = open, low = open, close = open): OHLCV =>
  ({ timestamp, open, high, low, close, volume: 1 });

const baseCfg: ReplayConfig = {
  sleeve: "crypto", universe: ["BTC/USD"], timeframe: "1h", source: "binance_futures",
  refSymbol: "BTC/USD", rthOnly: false, funding: false, barMinutes: 60, barMinutesEq: 60,
  slippageBps: 5, commissionBps: 4, initialEquity: 10_000, leverage: 2, hardStopPct: 0.04,
  cadenceMin: 60, notionalPctPerSlot: 0.25, entryPct: 5, exitPct: -2, maxLongs: 2, maxShorts: 2,
  shortFunding: "credit", warmupDays: 32, dbPath: "./data/historical.db",
};

describe("shortStop — hash identity (GOLDEN RULE)", () => {
  test("absent shortStop (omitted or explicit undefined) preserves the legacy hash", () => {
    const legacy = hashReplayConfig(baseCfg);
    expect(hashReplayConfig({ ...baseCfg, shortStop: undefined })).toBe(legacy);
  });
  test("shortStop present changes the hash; different specs differ", () => {
    const legacy = hashReplayConfig(baseCfg);
    const a = hashReplayConfig({ ...baseCfg, shortStop: { mode: "fixed", pct: 0.08 } });
    const b = hashReplayConfig({ ...baseCfg, shortStop: { mode: "volScaled", kSigma: 3, lookbackDays: 20, minPct: 6, maxPct: 20 } });
    expect(new Set([legacy, a, b]).size).toBe(3);
  });
});

/** 26 UTC days of hourly bars; day d's close = dayCloses[d] (constant within
 *  the day so the daily aggregation is unambiguous); last day COMPLETE. */
function hourlyWithDailyCloses(dayCloses: number[]): OHLCV[] {
  const out: OHLCV[] = [];
  const t0 = Date.UTC(2024, 0, 1);
  for (let d = 0; d < dayCloses.length; d++) {
    for (let h = 0; h < 24; h++) out.push(bar(t0 + d * 86_400_000 + h * 3_600_000, dayCloses[d]));
  }
  return out;
}

describe("shortStopDistancePct — DAILY vol from hourly bars", () => {
  test("completedDailyCloses: one close per completed UTC day; in-progress day invisible", () => {
    const closes = [100, 101, 102, 103];
    const bars = hourlyWithDailyCloses(closes);
    expect(completedDailyCloses(bars, 3_600_000)).toEqual(closes); // last day's last bar closes AT midnight
    // Drop the final hour → the last day is in progress → excluded.
    expect(completedDailyCloses(bars.slice(0, -1), 3_600_000)).toEqual([100, 101, 102]);
  });

  test("fixed: distance = pct × 100 (fraction → percent-units)", () => {
    expect(shortStopDistancePct({ mode: "fixed", pct: 0.08 }, [], 3_600_000)).toBe(8);
    expect(shortStopDistancePct({ mode: "fixed", pct: 0.25 }, [], 3_600_000)).toBe(25);
  });

  test("volScaled: kSigma × σ(daily log returns) with NO √barsPerDay scaling, clamped", () => {
    // Alternating ±2% daily moves → σ of log returns is computable by hand.
    const dayCloses: number[] = [100];
    for (let i = 1; i <= 21; i++) dayCloses.push(dayCloses[i - 1] * (i % 2 ? 1.02 : 0.98));
    const bars = hourlyWithDailyCloses(dayCloses);
    const spec: ShortStopSpec = { mode: "volScaled", kSigma: 3, lookbackDays: 20, minPct: 6, maxPct: 20 };
    const got = shortStopDistancePct(spec, bars, 3_600_000);
    // Hand math over the LAST 20 daily closes' 20 log returns.
    const daily = dayCloses;
    const rets: number[] = [];
    for (let i = daily.length - 20; i < daily.length; i++) rets.push(Math.log(daily[i] / daily[i - 1]));
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
    expect(got).toBeCloseTo(Math.min(20, Math.max(6, 3 * sd * 100)), 10);
    // The same series' HOURLY vol is ~0 (flat within days): a √24-scaled
    // bar-vol implementation would floor at minPct — prove we didn't do that.
    expect(got).toBeGreaterThan(6);
  });

  test("volScaled fails open to maxPct on short history", () => {
    const spec: ShortStopSpec = { mode: "volScaled", kSigma: 3, lookbackDays: 20, minPct: 6, maxPct: 20 };
    expect(shortStopDistancePct(spec, hourlyWithDailyCloses([100, 101]), 3_600_000)).toBe(20);
    expect(shortStopDistancePct(spec, [], 3_600_000)).toBe(20);
  });
});

describe("SimBroker — shortStop resolves the SELL stop; longs keep their path", () => {
  function brokerWith(spec: ShortStopSpec | undefined, candles: Map<string, OHLCV[]>, now: number): SimBroker {
    const b = new SimBroker(10_000, candles, 0, 0, 3_600_000, { leverage: 2, maintRate: 0.005 }, 0.04,
      undefined, false, undefined, 24, 0, 0, "credit", undefined, 0, spec);
    b.now = now;
    return b;
  }

  test("SELL with shortStop fixed 8%: stopFrac 0.08; BUY in the same run keeps legacy undefined (4% broker-level)", async () => {
    const candles = new Map([["BTC/USD", hourlyWithDailyCloses([100, 100, 100, 100])]]);
    const now = Date.UTC(2024, 0, 4); // execution bar (Jan 4 00:00) exists in the tape
    const b = brokerWith({ mode: "fixed", pct: 0.08 }, candles, now);
    await b.openPosition({ symbol: "BTC/USD", side: "sell", notionalUsd: 1_000 });
    await b.openPosition({ symbol: "BTC/USD", side: "buy", notionalUsd: 1_000 });
    const short = b.positions.find(p => p.side === "sell")!;
    const long = b.positions.find(p => p.side === "buy")!;
    expect(short.stopFrac).toBe(0.08);
    expect(long.stopFrac).toBeUndefined(); // legacy: broker-level hardStopPct applies
  });

  test("checkStops: the short's stop sits ABOVE entry and fills on bar.high (stop_loss)", () => {
    const b = brokerWith(undefined, new Map(), 0);
    b.positions.push({ symbol: "S", side: "sell", qty: 10, entryPrice: 100, entryAt: 0, entryMargin: 500, stopFrac: 0.08, peakPrice: 100, lockLevel: null });
    // +7.9%: no trigger.
    b.checkStops(new Map([["S", bar(1, 100, 107.9, 99, 107)]]));
    expect(b.positions).toHaveLength(1);
    // +8%: fills AT the level (108), reason stop_loss.
    b.checkStops(new Map([["S", bar(2, 100, 108.5, 99, 107)]]));
    expect(b.positions).toHaveLength(0);
    expect(b.closed[0]).toMatchObject({ symbol: "S", side: "sell", reason: "stop_loss", exitPrice: 108 });
  });

  test("S3 verification: volScaled hardStop (k8, 5-30%) resolves a SIDE-AGNOSTIC distance and the short's level is entry×(1+frac)", async () => {
    // 2%-daily-move tape (hourly): entryStopFraction (bar-vol × √barsPerDay)
    // is what S3's control uses; prove the SELL gets stopFrac > 0 from it
    // and the trigger sits ABOVE entry.
    const dayCloses: number[] = [100];
    for (let i = 1; i <= 25; i++) dayCloses.push(dayCloses[i - 1] * (i % 2 ? 1.02 : 0.98));
    const candles = new Map([["BTC/USD", hourlyWithDailyCloses(dayCloses)]]);
    const spec = { mode: "volScaled" as const, kSigma: 8, lookbackBars: 20, minPct: 5, maxPct: 30 };
    const b = new SimBroker(10_000, candles, 0, 0, 3_600_000, { leverage: 2, maintRate: 0.005 }, 0.04,
      undefined, false, spec, 24, 0, 0, "credit");
    b.now = Date.UTC(2024, 0, 26);
    await b.openPosition({ symbol: "BTC/USD", side: "sell", notionalUsd: 1_000 });
    const p = b.positions[0];
    expect(p.side).toBe("sell");
    expect(p.stopFrac).toBeGreaterThanOrEqual(0.05);
    expect(p.stopFrac).toBeLessThanOrEqual(0.30);
    const level = p.entryPrice * (1 + (p.stopFrac as number));
    b.checkStops(new Map([["BTC/USD", bar(b.now, p.entryPrice, level + 0.01, p.entryPrice * 0.9, p.entryPrice)]]));
    expect(b.positions).toHaveLength(0);
    expect(b.closed[0].reason).toBe("stop_loss");
    expect(b.closed[0].exitPrice).toBeCloseTo(level, 10);
  });
});

describe("MomentumEngine — a SHORT open carries stopLossPct from shortStop (live plumbing)", () => {
  test("short entry: stopLossPct = shortStopDistancePct; without shortStop the action has no stopLossPct", async () => {
    const mk = (withSpec: boolean) => {
      const broker = new FakeBroker();
      broker.setCandles("DOWN", ramp(100, 70)); // r ≈ −30% < −5%, px < MA → short
      const engine = new MomentumEngine(
        {
          mode: "time-series", universe: ["DOWN"], notionalPctPerSlot: 0.3,
          tsm: { maxLongs: 0, maxShorts: 1 },
          ...(withSpec ? { shortStop: { mode: "fixed" as const, pct: 0.12 } } : {}),
        },
        broker, silentLogger,
      );
      return { broker, engine };
    };
    const a = mk(true);
    await a.engine.tick();
    expect(a.broker.opened).toHaveLength(1);
    expect(a.broker.opened[0].side).toBe("sell");
    expect((a.broker.opened[0] as any).stopLossPct).toBe(12);
    const b = mk(false);
    await b.engine.tick();
    expect(b.broker.opened).toHaveLength(1);
    expect("stopLossPct" in b.broker.opened[0]).toBe(false);
  });
});
