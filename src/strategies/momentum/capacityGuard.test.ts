// ── Capacity guard (%ADV, opt-in) — MomentumEngine + MeanRevEngine ─────────
// LEAN-style per-order capacity check (capacityGuard config): before each
// NEW entry, ADV$ = averageDailyDollarVolume over the last lookbackBars DAYS
// of the decision candles; an entry over maxAdvPct% of it warns+counts
// ("observe") or is vetoed like the gross-exposure cap ("enforce").
// Unusable volume history FAILS OPEN — missing data never manufactures a
// block. Absent config = byte-identical legacy behavior (the replay
// manifests never set it; scripts/regression-fingerprint.test.ts pins that).
import { describe, expect, test } from "bun:test";
import { MomentumEngine, averageDailyDollarVolume, type CapacityGuardConfig } from "./MomentumEngine";
import { MeanRevEngine, type MeanRevLogger } from "../meanrev/MeanRevEngine";
import { ramp, FakeBroker, silentLogger } from "../../test-support/momentum";
import { MEANREV_ANCHOR as ANCHOR, daily, flatThen, FakeAdapter } from "../../test-support/meanrev";
import { makeTestDb } from "../../test-support/db";
import { getSyncState } from "../../db/database";
import type { OHLCV } from "../../utils/types";

makeTestDb();

/** Logger capturing warns (both engines' guard telemetry is a WARN line). */
function warnCapture(): { log: MeanRevLogger; warns: string[] } {
  const warns: string[] = [];
  return { log: { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} }, warns };
}

const withVolume = (bars: OHLCV[], volume: number): OHLCV[] => bars.map(b => ({ ...b, volume }));

// ── averageDailyDollarVolume (pure helper) ──────────────────────────────────

describe("averageDailyDollarVolume", () => {
  const bar = (close: number, volume: number, i: number): OHLCV =>
    ({ open: close, high: close, low: close, close, volume, timestamp: i * 60_000 });

  test("daily bars (barsPerDay=1): mean of close×volume over the window", () => {
    const bars = [bar(10, 100, 0), bar(20, 100, 1), bar(30, 100, 2)];
    expect(averageDailyDollarVolume(bars, 2, 1)).toBeCloseTo((2000 + 3000) / 2, 10);
  });

  test("hourly bars (barsPerDay=24): each day is the SUM of its 24 bars' close×volume", () => {
    const bars: OHLCV[] = [];
    for (let i = 0; i < 48; i++) bars.push(bar(100, i < 24 ? 1 : 2, i)); // day1 $2400, day2 $4800
    expect(averageDailyDollarVolume(bars, 2, 24)).toBeCloseTo((2400 + 4800) / 2, 10);
  });

  test("fails open (null) on short history, non-finite volume, and an all-zero window", () => {
    expect(averageDailyDollarVolume([bar(10, 100, 0)], 2, 1)).toBeNull(); // 1 bar < 2 days
    expect(averageDailyDollarVolume([bar(10, 100, 0), bar(10, NaN, 1)], 2, 1)).toBeNull();
    expect(averageDailyDollarVolume([bar(10, 0, 0), bar(10, 0, 1)], 2, 1)).toBeNull(); // traded nothing
    expect(averageDailyDollarVolume([], 1, 1)).toBeNull();
  });
});

// ── MomentumEngine wiring ───────────────────────────────────────────────────
// FakeBroker equity 10k × 0.25/slot = $2,500 entries. ramp() bars carry
// volume=1 at ~$100-130 closes (ADV$ ≈ $36k on 288 5m bars/day), so a 1%
// budget (~$366) always trips; 100% (~$36k) never does.

const OBSERVE_1PCT: CapacityGuardConfig = { maxAdvPct: 1, lookbackBars: 20, mode: "observe" };

describe("MomentumEngine capacityGuard", () => {
  test("observe: an over-budget entry WARNS and proceeds; telemetry lands in sleeveOutput", async () => {
    const broker = new FakeBroker();
    broker.setCandles("SYNA", ramp(100, 130));
    const { log, warns } = warnCapture();
    const engine = new MomentumEngine({
      universe: ["SYNA"], notionalPctPerSlot: 0.25,
      heartbeatName: "test:capacity_momo_observe",
      capacityGuard: OBSERVE_1PCT,
    }, broker, log);

    await engine.tick();

    expect(broker.opened.map(o => o.symbol)).toEqual(["SYNA"]); // NOT blocked
    expect(warns.some(w => w.includes("capacity guard") && w.includes("observe mode"))).toBe(true);
    const state = JSON.parse(getSyncState("sleeve_output:test:capacity_momo_observe")!);
    expect(state.capacityObservations).toBe(1);
    expect(state.lastCapacityReason).toContain("capacity guard");
    expect(state.preventedByPolicy ?? 0).toBe(0); // nothing was prevented — counters never conflate
  });

  test("enforce: the same entry is BLOCKED as a policy veto (never a broken-open-path failure)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("SYNA", ramp(100, 130));
    const engine = new MomentumEngine({
      universe: ["SYNA"], notionalPctPerSlot: 0.25,
      heartbeatName: "test:capacity_momo_enforce",
      capacityGuard: { ...OBSERVE_1PCT, mode: "enforce" },
    }, broker, silentLogger);

    await engine.tick();

    expect(broker.opened).toEqual([]);
    const state = JSON.parse(getSyncState("sleeve_output:test:capacity_momo_enforce")!);
    expect(state.preventedByPolicy).toBe(1);
    expect(state.lastPolicyReason).toContain("capacity guard");
    expect(state.fails ?? 0).toBe(0); // a sound veto must never trip the "sleeve producing NOTHING" pager
  });

  test("within budget: no warn, no telemetry, entry proceeds", async () => {
    const broker = new FakeBroker();
    broker.setCandles("SYNA", ramp(100, 130));
    const { log, warns } = warnCapture();
    const engine = new MomentumEngine({
      universe: ["SYNA"], notionalPctPerSlot: 0.25,
      capacityGuard: { maxAdvPct: 100, lookbackBars: 20, mode: "enforce" },
    }, broker, log);

    await engine.tick();

    expect(broker.opened.map(o => o.symbol)).toEqual(["SYNA"]);
    expect(warns.filter(w => w.includes("capacity guard"))).toEqual([]);
  });

  test("missing volume data FAILS OPEN with a log — even in enforce mode", async () => {
    const broker = new FakeBroker();
    broker.setCandles("SYNA", withVolume(ramp(100, 130), 0)); // tape without volume
    const { log, warns } = warnCapture();
    const engine = new MomentumEngine({
      universe: ["SYNA"], notionalPctPerSlot: 0.25,
      capacityGuard: { ...OBSERVE_1PCT, mode: "enforce" },
    }, broker, log);

    await engine.tick();

    expect(broker.opened.map(o => o.symbol)).toEqual(["SYNA"]); // never blocks on missing data
    expect(warns.some(w => w.includes("ADV$ not computable"))).toBe(true);
  });

  test("absent config = byte-identical: same open, zero capacity lines", async () => {
    const broker = new FakeBroker();
    broker.setCandles("SYNA", ramp(100, 130));
    const { log, warns } = warnCapture();
    const engine = new MomentumEngine({ universe: ["SYNA"], notionalPctPerSlot: 0.25 }, broker, log);

    await engine.tick();

    expect(broker.opened.map(o => o.symbol)).toEqual(["SYNA"]);
    expect(warns.filter(w => w.includes("capacity"))).toEqual([]);
  });
});

// ── MeanRevEngine wiring ────────────────────────────────────────────────────
// baseUsd 50k × slotPct 0.10 = $5,000 entries. daily() bars carry volume=1
// (ADV$ ≈ $140), so a 1% budget always trips; volume 1e6 (ADV$ ≈ $140M)
// never does.

const silent: MeanRevLogger = silentLogger;
const SIGNAL = flatThen(100, [150, 150.1, 138]); // RSI2<5 and close>SMA200 — a real candidate

function meanrevEngine(adapter: FakeAdapter, log: MeanRevLogger, extra: any = {}) {
  return new MeanRevEngine(
    { accountId: adapter.accountId, universe: ["CAND"], baseUsd: 50_000, ...extra },
    adapter,
    log,
    { isTradingDay: () => true, now: () => ANCHOR },
  );
}

describe("MeanRevEngine capacityGuard", () => {
  test("observe: warns and still opens", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("CAND", daily(SIGNAL));
    const { log, warns } = warnCapture();
    const report = await meanrevEngine(adapter, log, { capacityGuard: OBSERVE_1PCT }).runDaily();

    expect(adapter.opened.map(o => o.symbol)).toEqual(["CAND"]);
    expect(report.status).toBe("ok");
    expect(warns.some(w => w.includes("capacity guard") && w.includes("observe mode"))).toBe(true);
  });

  test("enforce: blocks the entry as a policy veto (gross-exposure-cap semantics)", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("CAND", daily(SIGNAL));
    const report = await meanrevEngine(adapter, silent, {
      capacityGuard: { ...OBSERVE_1PCT, mode: "enforce" },
    }).runDaily();

    expect(adapter.opened).toEqual([]);
    const blocked = report.opens.find(o => o.symbol === "CAND");
    expect(blocked?.ok).toBe(false);
    expect(blocked?.detail).toContain("capacity guard");
    expect(blocked?.terminal ?? false).toBe(false); // a veto is not a terminal broker failure
  });

  test("within budget (liquid tape): opens with no capacity lines", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("CAND", withVolume(daily(SIGNAL), 1_000_000));
    const { log, warns } = warnCapture();
    await meanrevEngine(adapter, log, { capacityGuard: { ...OBSERVE_1PCT, mode: "enforce" } }).runDaily();

    expect(adapter.opened.map(o => o.symbol)).toEqual(["CAND"]);
    expect(warns.filter(w => w.includes("capacity guard"))).toEqual([]);
  });

  test("short volume history FAILS OPEN with a log — the entry is never blocked on missing data", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("CAND", daily(SIGNAL));
    const { log, warns } = warnCapture();
    await meanrevEngine(adapter, log, {
      capacityGuard: { maxAdvPct: 1, lookbackBars: 5_000, mode: "enforce" }, // window ≫ history
    }).runDaily();

    expect(adapter.opened.map(o => o.symbol)).toEqual(["CAND"]);
    expect(warns.some(w => w.includes("ADV$ not computable"))).toBe(true);
  });
});
