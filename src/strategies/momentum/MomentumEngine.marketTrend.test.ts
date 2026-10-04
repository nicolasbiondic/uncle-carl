// Market-trend entry gate (MomentumEngineConfig.marketTrend, 2026-09-24):
// blocks NEW entries while the gate symbol's last CLOSED UTC daily close is
// below its maDays SMA. Contracts pinned here:
//   1. marketTrendBlocked (pure): below-SMA blocks, above passes, short or
//      degenerate history returns null (gate must fail OPEN).
//   2. Entries-only: a blocked tick still executes exits (the RiskGuard/
//      RegimeFilter philosophy).
//   3. Fail-open: adapter without fetchDailyCloses, a throwing fetch, or an
//      insufficient series never blocks.
//   4. Default byte-identity: without cfg.marketTrend the adapter method is
//      never called.
import { describe, expect, test } from "bun:test";
import { MomentumEngine, marketTrendBlocked } from "./MomentumEngine";
import { ramp, FakeBroker, silentLogger } from "../../test-support/momentum";

class TrendBroker extends FakeBroker {
  dailyCloses: number[] | null = [];
  dailyCallCount = 0;
  throwOnDaily = false;
  async fetchDailyCloses(_symbol: string, days: number): Promise<number[]> {
    this.dailyCallCount++;
    if (this.throwOnDaily) throw new Error("klines down");
    return (this.dailyCloses ?? []).slice(-days);
  }
}

const BEAR = [100, 90, 80, 70, 60];   // last 60 < SMA5 80 → blocked
const BULL = [100, 110, 120, 130, 140]; // last 140 > SMA5 120 → open

describe("marketTrendBlocked (pure)", () => {
  test("blocks below SMA, passes above/at SMA", () => {
    expect(marketTrendBlocked(BEAR, 5)).toBe(true);
    expect(marketTrendBlocked(BULL, 5)).toBe(false);
    expect(marketTrendBlocked([100, 100, 100], 3)).toBe(false); // at SMA = not below
  });

  test("uses only the LAST maDays closes (older history is irrelevant)", () => {
    // Long bear prefix, but the last 3 days rallied above their own SMA3.
    expect(marketTrendBlocked([...Array(200).fill(500), 90, 100, 120], 3)).toBe(false);
  });

  test("fails open (null) on short or degenerate history", () => {
    expect(marketTrendBlocked([], 5)).toBeNull();
    expect(marketTrendBlocked([100, 90], 5)).toBeNull();          // < maDays
    expect(marketTrendBlocked([100, NaN, 80, 70, 60], 5)).toBeNull();
    expect(marketTrendBlocked([100, -5, 80, 70, 60], 5)).toBeNull();
    expect(marketTrendBlocked([100, 90, 80], 1)).toBeNull();      // maDays < 2
  });
});

describe("MomentumEngine market-trend gate", () => {
  const cfg = (universe: string[]) => ({
    universe,
    notionalPctPerSlot: 0.30,
    scorer: { topLongs: 2, minLongScore: 0.01 },
    marketTrend: { symbol: "BTC/USD", maDays: 5 },
  });

  test("bear market blocks NEW entries and stamps a 'market trend:' reason", async () => {
    const broker = new TrendBroker();
    broker.dailyCloses = BEAR;
    broker.setCandles("UP1", ramp(100, 130));
    const engine = new MomentumEngine(cfg(["UP1"]), broker, silentLogger);

    const report = await engine.tick();

    expect(report.tradeable).toBe(false);
    expect(report.blockedReason).toStartWith("market trend:");
    expect(broker.opened).toEqual([]);
    expect(broker.dailyCallCount).toBe(1);
  });

  test("bull market leaves entries untouched", async () => {
    const broker = new TrendBroker();
    broker.dailyCloses = BULL;
    broker.setCandles("UP1", ramp(100, 130));
    const engine = new MomentumEngine(cfg(["UP1"]), broker, silentLogger);

    const report = await engine.tick();

    expect(report.tradeable).toBe(true);
    expect(broker.opened.map(a => a.symbol)).toEqual(["UP1"]);
  });

  test("entries-only: a blocked tick still executes a signal exit", async () => {
    const broker = new TrendBroker();
    broker.dailyCloses = BULL;
    broker.setCandles("X", ramp(100, 130));
    const engine = new MomentumEngine(cfg(["X"]), broker, silentLogger);
    await engine.tick(); // opens X in the bull phase

    broker.dailyCloses = BEAR;          // market flips bear → gate blocks
    broker.setCandles("X", ramp(100, 80)); // held symbol turns loser
    const report = await engine.tick();

    expect(report.tradeable).toBe(false);
    expect(report.blockedReason).toStartWith("market trend:");
    expect(broker.closed.map(a => a.symbol)).toEqual(["X"]); // exit ran
    // opened still only contains the first tick's entry
    expect(broker.opened.map(a => a.symbol)).toEqual(["X"]);
  });

  test("fail-open: adapter without fetchDailyCloses / short series / throwing fetch", async () => {
    // (a) plain FakeBroker has no fetchDailyCloses at all
    const plain = new FakeBroker();
    plain.setCandles("UP1", ramp(100, 130));
    const e1 = new MomentumEngine(cfg(["UP1"]), plain, silentLogger);
    expect((await e1.tick()).tradeable).toBe(true);
    expect(plain.opened.length).toBe(1);

    // (b) fewer closed days than maDays
    const short = new TrendBroker();
    short.dailyCloses = [100, 60]; // would scream "bear" if it were enough data
    short.setCandles("UP1", ramp(100, 130));
    const e2 = new MomentumEngine(cfg(["UP1"]), short, silentLogger);
    expect((await e2.tick()).tradeable).toBe(true);
    expect(short.opened.length).toBe(1);

    // (c) fetch throws
    const broken = new TrendBroker();
    broken.throwOnDaily = true;
    broken.setCandles("UP1", ramp(100, 130));
    const e3 = new MomentumEngine(cfg(["UP1"]), broken, silentLogger);
    expect((await e3.tick()).tradeable).toBe(true);
    expect(broken.opened.length).toBe(1);
  });

  test("default byte-identity: without cfg.marketTrend the adapter method is never called", async () => {
    const broker = new TrendBroker();
    broker.dailyCloses = BEAR; // would block if the gate were on
    broker.setCandles("UP1", ramp(100, 130));
    const engine = new MomentumEngine({
      universe: ["UP1"],
      notionalPctPerSlot: 0.30,
      scorer: { topLongs: 2, minLongScore: 0.01 },
    }, broker, silentLogger);

    const report = await engine.tick();

    expect(report.tradeable).toBe(true);
    expect(broker.dailyCallCount).toBe(0);
    expect(broker.opened.length).toBe(1);
  });
});
