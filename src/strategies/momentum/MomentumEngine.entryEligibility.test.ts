// MomentumEngineConfig.entryEligibility (PIT index-universe hook, research
// replays only — see its docstring). Locked here:
//   1. ABSENT hook (and an all-true hook) = byte-identical decisions to the
//      legacy path.
//   2. An ineligible symbol never takes a slot as a NEW entry; the slot
//      goes to the next-ranked ELIGIBLE candidate (the hook filters the
//      ranking candidate set, it doesn't just veto the open).
//   3. A HELD symbol that loses eligibility keeps its full exit logic: it
//      exits on its own signal, and it is never force-closed while its
//      stay signal is valid.
import { describe, expect, test } from "bun:test";
import { MomentumEngine } from "./MomentumEngine";
import { ramp, FakeBroker, silentLogger } from "../../test-support/momentum";

const baseCfg = (universe: string[], maxLongs: number, extra: Record<string, unknown> = {}) => ({
  universe,
  notionalPctPerSlot: 0.25,
  tsm: { maxLongs },
  scorer: { topLongs: universe.length, minLongScore: 0.001 },
  regime: { minSymbolsForCorrelation: 100 },
  ...extra,
});

function brokerWithGainers(universe: string[]): FakeBroker {
  const broker = new FakeBroker();
  universe.forEach((sym, i) => broker.setCandles(sym, ramp(100, 200 - 15 * i)));
  return broker;
}

describe("MomentumEngine entryEligibility", () => {
  test("absent hook and all-true hook open the exact same book", async () => {
    const universe = ["A", "B", "C"];
    const legacy = brokerWithGainers(universe);
    await new MomentumEngine(baseCfg(universe, 2), legacy, silentLogger).tick();

    const hooked = brokerWithGainers(universe);
    await new MomentumEngine(
      baseCfg(universe, 2, { entryEligibility: () => true }),
      hooked,
      silentLogger,
    ).tick();

    expect(hooked.opened).toEqual(legacy.opened);
    expect(hooked.closed).toEqual(legacy.closed);
    expect(legacy.opened.map(a => a.symbol).sort()).toEqual(["A", "B"]);
  });

  test("ineligible symbol never enters; its slot goes to the next eligible candidate", async () => {
    const universe = ["A", "B", "C"];
    const broker = brokerWithGainers(universe);
    const seen: Array<[string, number]> = [];
    const engine = new MomentumEngine(
      baseCfg(universe, 2, {
        entryEligibility: (sym: string, nowMs: number) => { seen.push([sym, nowMs]); return sym !== "A"; },
      }),
      broker,
      silentLogger,
    );
    await engine.tick();
    // A is the top-ranked gainer but ineligible: B and C fill the 2 slots.
    expect(broker.opened.map(a => a.symbol).sort()).toEqual(["B", "C"]);
    expect(seen.length).toBeGreaterThan(0);
    for (const [, nowMs] of seen) expect(Number.isFinite(nowMs)).toBe(true);
  });

  test("a held symbol that lost eligibility still exits on its own signal", async () => {
    const broker = new FakeBroker();
    broker.setCandles("HELD", ramp(100, 60)); // downtrend: stay signal invalid
    broker.setCandles("UP", ramp(100, 200));
    broker.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000 }];
    const engine = new MomentumEngine(
      baseCfg(["HELD", "UP"], 1, { entryEligibility: () => false }), // NOTHING is entry-eligible
      broker,
      silentLogger,
    );
    await engine.tick();
    // Exit executed despite ineligibility; no new entries anywhere.
    expect(broker.closed.map(a => a.symbol)).toEqual(["HELD"]);
    expect(broker.opened).toEqual([]);
  });

  test("a held symbol with a valid stay signal is NOT force-closed by ineligibility", async () => {
    const broker = new FakeBroker();
    broker.setCandles("HELD", ramp(100, 200)); // strong uptrend: stay valid
    broker.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 2_500 }];
    const engine = new MomentumEngine(
      baseCfg(["HELD"], 1, { entryEligibility: () => false }),
      broker,
      silentLogger,
    );
    await engine.tick();
    expect(broker.closed).toEqual([]);
    expect(broker.opened).toEqual([]);
    expect(broker.positions.map(p => p.symbol)).toEqual(["HELD"]);
  });
});
