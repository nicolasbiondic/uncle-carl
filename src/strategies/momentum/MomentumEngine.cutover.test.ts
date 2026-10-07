// ── Model cutover (reunderwriteBefore, opt-in) ──────────────────────────────
// One-shot re-underwrite of legacy positions: entries predating the boundary
// are closed BEFORE the ranking (close_reason MODEL_CUTOVER) and re-bought at
// the CURRENT slot size only if they still rank — the 2026-09-25 incident
// class where META/AAPL, sized under the retired 2× regime by the old 5m
// kernel, filled the 1× gross cap and blocked the new kernel's entries.
import { describe, expect, test } from "bun:test";
import { MomentumEngine, MODEL_CUTOVER_CLOSE_REASON } from "./MomentumEngine";
import { ramp, FakeBroker, silentLogger } from "../../test-support/momentum";

const HOUR = 3_600_000;
const LEGACY_ENTRY = Date.now() - 30 * 24 * HOUR;
const BOUNDARY = Date.now() - HOUR;

describe("MomentumEngine model cutover (reunderwriteBefore)", () => {
  test("legacy position is closed with MODEL_CUTOVER and re-bought at the CURRENT slot size in the same tick", async () => {
    const broker = new FakeBroker();
    broker.setCandles("META", ramp(100, 130)); // signal still valid — it ranks
    broker.positions = [{ symbol: "META", side: "buy", quantity: 40, notional: 31_000, entryTime: LEGACY_ENTRY }];
    const engine = new MomentumEngine({
      universe: ["META"],
      notionalPctPerSlot: 0.25,
      tsm: { slotHysteresis: true }, // the privilege that otherwise holds legacy positions forever
      reunderwriteBefore: BOUNDARY,
    }, broker, silentLogger);

    const report = await engine.tick();

    expect(broker.closed).toEqual([{ symbol: "META", side: "buy", closeReason: MODEL_CUTOVER_CLOSE_REASON }]);
    expect(broker.opened.map(o => o.symbol)).toEqual(["META"]);
    // CURRENT slot size (25% of 10k equity), not the legacy $31k underwrite.
    expect(broker.opened[0].notionalUsd).toBeCloseTo(2_500, 0);
    expect(report.actions.filter(a => a.type === "close")).toHaveLength(1);
    expect(report.actions.filter(a => a.type === "open")).toHaveLength(1);
  });

  test("reunderwriteBefore absent (the wired-null default) changes nothing: the same legacy position just holds", async () => {
    const broker = new FakeBroker();
    broker.setCandles("META", ramp(100, 130));
    broker.positions = [{ symbol: "META", side: "buy", quantity: 40, notional: 31_000, entryTime: LEGACY_ENTRY }];
    const engine = new MomentumEngine({
      universe: ["META"],
      notionalPctPerSlot: 0.25,
      tsm: { slotHysteresis: true },
    }, broker, silentLogger);

    const report = await engine.tick();

    expect(broker.closed).toEqual([]);
    expect(broker.opened).toEqual([]);
    expect(report.unchanged).toContain("META");
  });

  test("positions entered AFTER the boundary — or with no entryTime at all — are never touched", async () => {
    const broker = new FakeBroker();
    broker.setCandles("NEWER", ramp(100, 130));
    broker.setCandles("NOTIME", ramp(100, 125));
    broker.positions = [
      { symbol: "NEWER", side: "buy", quantity: 10, notional: 2_500, entryTime: Date.now() - 60_000 },
      { symbol: "NOTIME", side: "buy", quantity: 10, notional: 2_500 }, // adapter gave no entryTime — never fabricate an age
    ];
    const engine = new MomentumEngine({
      universe: ["NEWER", "NOTIME"],
      notionalPctPerSlot: 0.25,
      tsm: { slotHysteresis: true },
      reunderwriteBefore: BOUNDARY,
    }, broker, silentLogger);

    const report = await engine.tick();

    expect(broker.closed).toEqual([]);
    expect(broker.opened).toEqual([]);
    expect(report.unchanged.sort()).toEqual(["NEWER", "NOTIME"]);
  });

  test("the re-buy respects the gross-exposure cap: legacy close lands, blocked re-entry stays out", async () => {
    const broker = new FakeBroker();
    broker.setCandles("META", ramp(100, 130));
    broker.positions = [{ symbol: "META", side: "buy", quantity: 40, notional: 31_000, entryTime: LEGACY_ENTRY }];
    const engine = new MomentumEngine({
      universe: ["META"],
      notionalPctPerSlot: 0.25,
      reunderwriteBefore: BOUNDARY,
      maxGrossExposureMult: 0.1, // cap $1k on $10k equity < $2.5k slot → open must be vetoed
    }, broker, silentLogger);

    await engine.tick();

    expect(broker.closed).toEqual([{ symbol: "META", side: "buy", closeReason: MODEL_CUTOVER_CLOSE_REASON }]);
    expect(broker.opened).toEqual([]);
  });

  test("reunderwriteSymbols limits the cutover to those symbols; the rest of the book keeps its stay-privilege (2026-10-06 GOOGL realign)", async () => {
    const broker = new FakeBroker();
    broker.setCandles("GOOGL", ramp(100, 108));
    broker.setCandles("META", ramp(100, 130));
    broker.positions = [
      { symbol: "GOOGL", side: "buy", quantity: 19, notional: 2_500, entryTime: LEGACY_ENTRY },
      { symbol: "META", side: "buy", quantity: 10, notional: 2_500, entryTime: LEGACY_ENTRY },
    ];
    const engine = new MomentumEngine({
      universe: ["GOOGL", "META"],
      notionalPctPerSlot: 0.25,
      tsm: { slotHysteresis: true },
      reunderwriteBefore: BOUNDARY,
      reunderwriteSymbols: ["GOOGL"],
    }, broker, silentLogger);

    const report = await engine.tick();

    expect(broker.closed).toEqual([{ symbol: "GOOGL", side: "buy", closeReason: MODEL_CUTOVER_CLOSE_REASON }]);
    expect(report.unchanged).toContain("META"); // same entry age, not listed → untouched
  });

  test("a failed cutover close leaves the position held; the next tick retries and completes", async () => {
    const broker = new FakeBroker();
    broker.setCandles("META", ramp(100, 130));
    broker.positions = [{ symbol: "META", side: "buy", quantity: 40, notional: 31_000, entryTime: LEGACY_ENTRY }];
    const realClose = broker.closePosition.bind(broker);
    broker.closePosition = async () => ({ ok: false, reason: "http_403" });
    const engine = new MomentumEngine({
      universe: ["META"],
      notionalPctPerSlot: 0.25,
      tsm: { slotHysteresis: true },
      reunderwriteBefore: BOUNDARY,
    }, broker, silentLogger);

    const first = await engine.tick();
    expect(broker.positions).toHaveLength(1); // still held — no phantom close
    expect(broker.opened).toEqual([]);        // still occupies its slot, no double-buy
    expect(first.unchanged).toContain("META");

    broker.closePosition = realClose;         // broker recovers
    await engine.tick();
    expect(broker.closed).toEqual([{ symbol: "META", side: "buy", closeReason: MODEL_CUTOVER_CLOSE_REASON }]);
    expect(broker.opened.map(o => o.symbol)).toEqual(["META"]);
    expect(broker.opened[0].notionalUsd).toBeCloseTo(2_500, 0);
  });
});
