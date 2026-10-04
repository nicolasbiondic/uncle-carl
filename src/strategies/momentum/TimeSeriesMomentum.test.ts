import { describe, expect, test } from "bun:test";
import { TimeSeriesMomentum } from "./TimeSeriesMomentum";
import { planRebalance } from "./Rebalancer";
import { SLOT_DISPLACED_CLOSE_REASON } from "./MomentumEngine";
import type { OHLCV } from "../../utils/types";
import { ramp } from "../../test-support/momentum";

describe("TimeSeriesMomentum", () => {
  test("longs a symbol with r > entry threshold AND price above MA", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("UP", ramp(100, 130));
    const decisions = new TimeSeriesMomentum({ entryThresholdPct: 5, lookbackDays: 14 }).rank(m);
    expect(decisions.find(d => d.symbol === "UP")?.action).toBe("long");
  });

  test("flats a symbol with r below entry threshold", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("WEAK", ramp(100, 102));
    const decisions = new TimeSeriesMomentum({ entryThresholdPct: 5, lookbackDays: 14 }).rank(m);
    expect(decisions.find(d => d.symbol === "WEAK")?.action).toBe("flat");
  });

  test("flats a symbol below its MA even if return is positive", () => {
    // Build a ramp UP for first half, then sharp drop in second half.
    // Final close is below MA but lookback return (vs 14d ago) might still be +.
    const totalBars = Math.floor(35 * 24 * 60 / 5);
    const out: OHLCV[] = [];
    const baseTs = Date.now() - totalBars * 5 * 60_000;
    for (let i = 0; i < totalBars; i++) {
      let p: number;
      if (i < totalBars * 0.5) p = 100 + (i / totalBars) * 200; // climbs to 200
      else p = 200 - ((i - totalBars * 0.5) / totalBars) * 180; // crashes
      out.push({ open: p, high: p, low: p, close: p, volume: 1, timestamp: baseTs + i * 5 * 60_000 });
    }
    const m = new Map<string, OHLCV[]>();
    m.set("CRASHED", out);
    const decisions = new TimeSeriesMomentum({ entryThresholdPct: 1, lookbackDays: 14 }).rank(m);
    expect(decisions.find(d => d.symbol === "CRASHED")?.action).toBe("flat");
  });

  test("hysteresis: held position stays long if r still above exit threshold", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("HELD", ramp(100, 103)); // +3% — below entry 5% but above exit -2%
    const tsm = new TimeSeriesMomentum({ entryThresholdPct: 5, exitThresholdPct: -2, lookbackDays: 14 });
    // Without held set: flat (3% < 5% entry)
    expect(tsm.rank(m).find(d => d.symbol === "HELD")?.action).toBe("flat");
    // With held set: stays long (3% > -2% exit)
    expect(tsm.rank(m, new Set(["HELD"])).find(d => d.symbol === "HELD")?.action).toBe("long");
  });

  test("maxLongs caps the number of long positions", () => {
    const m = new Map<string, OHLCV[]>();
    for (let i = 0; i < 10; i++) m.set(`SYM${i}`, ramp(100, 130 + i)); // all uptrending
    const decisions = new TimeSeriesMomentum({ maxLongs: 3, entryThresholdPct: 5 }).rank(m);
    const longs = decisions.filter(d => d.action === "long");
    expect(longs.length).toBe(3);
  });

  test("maxShorts=0 (default) never emits short — downtrend is flat", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("DOWN", ramp(100, 70));
    const decisions = new TimeSeriesMomentum().rank(m);
    expect(decisions.find(d => d.symbol === "DOWN")?.action).toBe("flat");
  });

  test("shorts a symbol with r below short entry threshold AND price below MA", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("DOWN", ramp(100, 70));
    const decisions = new TimeSeriesMomentum({ maxShorts: 4 }).rank(m);
    expect(decisions.find(d => d.symbol === "DOWN")?.action).toBe("short");
  });

  test("mild downtrend below short entry threshold stays flat", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("MILD", ramp(100, 98.5)); // 14d r ≈ -0.6% — above -5%
    const decisions = new TimeSeriesMomentum({ maxShorts: 4 }).rank(m);
    expect(decisions.find(d => d.symbol === "MILD")?.action).toBe("flat");
  });

  test("short hysteresis: held short stays while r below short exit threshold", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("HELD", ramp(100, 97)); // -3% — above short entry -5%, below short exit +2%
    const tsm = new TimeSeriesMomentum({ maxShorts: 4, shortEntryThresholdPct: -5, shortExitThresholdPct: 2 });
    expect(tsm.rank(m).find(d => d.symbol === "HELD")?.action).toBe("flat");
    expect(tsm.rank(m, undefined, new Set(["HELD"])).find(d => d.symbol === "HELD")?.action).toBe("short");
  });

  test("maxShorts caps the number of short positions, worst |r| picked first", () => {
    const m = new Map<string, OHLCV[]>();
    for (let i = 0; i < 6; i++) m.set(`S${i}`, ramp(100, 80 - i * 2)); // all downtrending, S5 worst
    const decisions = new TimeSeriesMomentum({ maxShorts: 2 }).rank(m);
    const shorts = decisions.filter(d => d.action === "short").map(d => d.symbol).sort();
    expect(shorts).toEqual(["S4", "S5"]);
  });

  test("longs and shorts coexist in a mixed universe", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("UP", ramp(100, 130));
    m.set("DOWN", ramp(100, 70));
    const decisions = new TimeSeriesMomentum({ maxShorts: 4 }).rank(m);
    expect(decisions.find(d => d.symbol === "UP")?.action).toBe("long");
    expect(decisions.find(d => d.symbol === "DOWN")?.action).toBe("short");
  });

  // ── slot displacement telemetry + opt-in slotHysteresis ──
  // Shared fixture: 4 held mild gainers (r ≈ +1.2%..+1.9% — stay-valid,
  // below the 5% entry) and one strong entrant (r ≈ +10%). Defaults:
  // entry 5 / exit −2 / maxLongs 4.
  function displacementFixture() {
    const m = new Map<string, OHLCV[]>();
    m.set("H1", ramp(100, 103));
    m.set("H2", ramp(100, 103.5));
    m.set("H3", ramp(100, 104));
    m.set("H4", ramp(100, 104.5));
    m.set("NEW", ramp(100, 130));
    return { m, held: new Set(["H1", "H2", "H3", "H4"]) };
  }

  test("legacy (default): entrant displaces the weakest still-valid held → flat + displaced:true, plan close carries SLOT_DISPLACED", () => {
    const { m, held } = displacementFixture();
    const decisions = new TimeSeriesMomentum().rank(m, held);
    const by = new Map(decisions.map(d => [d.symbol, d]));
    expect(by.get("NEW")?.action).toBe("long");
    expect(by.get("H4")?.action).toBe("long");
    expect(by.get("H3")?.action).toBe("long");
    expect(by.get("H2")?.action).toBe("long");
    // H1: held, stay signal still valid (r > −2%, px > MA), but ranked out.
    expect(by.get("H1")?.action).toBe("flat");
    expect(by.get("H1")?.displaced).toBe(true);
    // Survivors never carry the field at all.
    for (const s of ["NEW", "H2", "H3", "H4"]) expect("displaced" in by.get(s)!).toBe(false);

    const plan = planRebalance({
      decisions,
      currentPositions: [...held].map(symbol => ({ symbol, side: "buy" as const, quantity: 1, notional: 1000 })),
      notionalPerSlot: 1000,
    });
    const closes = plan.actions.filter(a => a.type === "close");
    expect(closes.map(c => c.symbol)).toEqual(["H1"]);
    expect(closes[0].closeReason).toBe(SLOT_DISPLACED_CLOSE_REASON);
  });

  test("a genuine signal exit (r < exit threshold) is NOT marked displaced and its close carries no closeReason", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("LOSER", ramp(100, 90)); // r ≈ −4.3% < −2% → own exit signal
    m.set("NEW", ramp(100, 130));
    const decisions = new TimeSeriesMomentum().rank(m, new Set(["LOSER"]));
    const loser = decisions.find(d => d.symbol === "LOSER")!;
    expect(loser.action).toBe("flat");
    expect("displaced" in loser).toBe(false);

    const plan = planRebalance({
      decisions,
      currentPositions: [{ symbol: "LOSER", side: "buy", quantity: 1, notional: 1000 }],
      notionalPerSlot: 1000,
    });
    const close = plan.actions.find(a => a.type === "close" && a.symbol === "LOSER")!;
    expect("closeReason" in close).toBe(false);
  });

  test("slotHysteresis=true: all still-valid held keep their slots, the entrant waits, nothing displaced", () => {
    const { m, held } = displacementFixture();
    const decisions = new TimeSeriesMomentum({ slotHysteresis: true }).rank(m, held);
    const by = new Map(decisions.map(d => [d.symbol, d]));
    for (const s of held) expect(by.get(s)?.action).toBe("long");
    expect(by.get("NEW")?.action).toBe("flat");
    expect(decisions.some(d => d.displaced)).toBe(false);
  });

  test("slotHysteresis=true with 5 still-valid held and maxLongs=4: the 4 highest-r held are kept", () => {
    const m = new Map<string, OHLCV[]>();
    for (let i = 1; i <= 5; i++) m.set(`H${i}`, ramp(100, 102.5 + i * 0.5)); // H5 strongest, H1 weakest
    const held = new Set(["H1", "H2", "H3", "H4", "H5"]);
    const decisions = new TimeSeriesMomentum({ slotHysteresis: true }).rank(m, held);
    const by = new Map(decisions.map(d => [d.symbol, d]));
    for (const s of ["H2", "H3", "H4", "H5"]) expect(by.get(s)?.action).toBe("long");
    expect(by.get("H1")?.action).toBe("flat");
    expect(by.get("H1")?.displaced).toBe(true); // still-valid held with no slot
  });

  test("slotHysteresis=false is byte-identical to the flag being absent (legacy path)", () => {
    const { m, held } = displacementFixture();
    const explicit = new TimeSeriesMomentum({ slotHysteresis: false }).rank(m, held);
    const legacy = new TimeSeriesMomentum().rank(m, held);
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(legacy));
    // Pin the legacy assignment on this fixed fixture so a future edit to the
    // legacy loop can't silently drift: entrant + 3 strongest held long,
    // weakest still-valid held displaced.
    const actions = new Map(explicit.map(d => [d.symbol, d.action]));
    expect(actions).toEqual(new Map([
      ["NEW", "long"], ["H4", "long"], ["H3", "long"], ["H2", "long"], ["H1", "flat"],
    ]));
  });

  test("symbols with insufficient history are dropped", () => {
    const m = new Map<string, OHLCV[]>();
    m.set("OK",      ramp(100, 130, 35));
    m.set("TOO_NEW", ramp(100, 130, 5));
    const decisions = new TimeSeriesMomentum().rank(m);
    expect(decisions.length).toBe(1);
    expect(decisions[0].symbol).toBe("OK");
  });
});
