// Runtime backstop test for MeanRevEngineConfig.maxGrossExposureMult (see its
// docstring, mirrors MomentumEngine.maxGrossExposureMult). meanrev_stocks
// doesn't have the SAME "invisible emergent multiplication" bug momentum_
// stocks had (slotPct and maxPositions already live in one config object,
// DEFAULT_MEANREV_CONFIG) — this is defense-in-depth for a slotPct-only bump
// that would raise exposure without anyone touching maxPositions.
import { describe, expect, test } from "bun:test";
import { MeanRevEngine, type MeanRevLogger } from "./MeanRevEngine";
import { DAY, MEANREV_ANCHOR as ANCHOR, daily, flatThen, FakeAdapter } from "../../test-support/meanrev";
import { makeTestDb } from "../../test-support/db";
import { MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT } from "../../index";

const silent: MeanRevLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeEngine(adapter: FakeAdapter, universe: string[], extra: any = {}) {
  return new MeanRevEngine(
    { accountId: adapter.accountId, universe, baseUsd: 50_000, ...extra },
    adapter,
    silent,
    { isTradingDay: () => true, now: () => ANCHOR },
  );
}

makeTestDb();

describe("MeanRevEngine gross-exposure guard", () => {
  test("a position closed earlier in the same pass no longer counts against the cap (2026-10-05 KO class)", async () => {
    const adapter = new FakeAdapter();
    const universe: string[] = [];
    // 7 held × $6,000 = $42,000 = the whole 0.84× cap. EXIT0 fires SMA_EXIT
    // (rising tail); HELD1..6 stay (flat: close = SMA5, far from the time stop).
    adapter.setCandles("EXIT0", daily(flatThen(100, [100, 101, 102, 103, 104, 105])));
    adapter.positions.push({ symbol: "EXIT0", side: "buy", quantity: 60, notional: 6_000, entryTime: ANCHOR - 2 * DAY });
    universe.push("EXIT0");
    for (let i = 1; i <= 6; i++) {
      const sym = `HELD${i}`;
      adapter.setCandles(sym, daily(flatThen(100, [100, 100, 100])));
      adapter.positions.push({ symbol: sym, side: "buy", quantity: 60, notional: 6_000, entryTime: ANCHOR - 2 * DAY });
      universe.push(sym);
    }
    adapter.setCandles("NEW", daily(flatThen(100, [150, 150.1, 150.1 - 12])));
    universe.push("NEW");
    const engine = makeEngine(adapter, universe, { maxGrossExposureMult: MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT });

    const report = await engine.runDaily();

    expect(adapter.closed.map((c) => c.symbol)).toEqual(["EXIT0"]);
    // 6 still held ($36,000) + NEW ($6,000) = $42,000 — fits exactly; counting
    // the sold EXIT0 too ($48,000) blocked it before the fix.
    expect(adapter.opened.map((o) => o.symbol)).toEqual(["NEW"]);
    expect(report.status).toBe("ok");
  });

  test("today's real cap (0.84x = 7 slots x 0.12) opens all 7 signalling candidates, none blocked", async () => {
    const adapter = new FakeAdapter();
    const universe: string[] = [];
    for (let i = 0; i < 7; i++) {
      const sym = `S${i}`;
      universe.push(sym);
      // Drops well past the RSI2<5 threshold for every symbol (see the
      // "maxPositions respected" test in MeanRevEngine.test.ts — a small
      // drop like `1+i` does NOT reliably signal for low i; these do).
      adapter.setCandles(sym, daily(flatThen(100, [150, 150.1, 150.1 - (10 + i)])));
    }
    const engine = makeEngine(adapter, universe, { maxGrossExposureMult: MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT });

    await engine.runDaily();

    // 7 x (50,000 x 0.12) = 42,000 = exactly 0.84x of baseUsd — the cap.
    expect(adapter.opened.length).toBe(7);
  });

  test("blocks the next escalation: bumping slotPct to 0.15 (unchanged maxPositions/cap)", async () => {
    const adapter = new FakeAdapter();
    const universe: string[] = [];
    for (let i = 0; i < 7; i++) {
      const sym = `S${i}`;
      universe.push(sym);
      adapter.setCandles(sym, daily(flatThen(100, [150, 150.1, 150.1 - (10 + i)])));
    }
    const engine = makeEngine(adapter, universe, {
      slotPct: 0.15, // ESCALATED from production's 0.12 — nobody touched maxPositions or the cap
      maxGrossExposureMult: MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT, // still 0.966x (unchanged; 0.84 x GROSS_CAP_HEADROOM since 2026-10-07)
    });

    await engine.runDaily();

    // Each slot now wants $7,500 (0.15 x 50k). Cap is $48,300 (0.966x since
    // 2026-10-07 — G diagnostic): 6 slots ($45k) fit, a 7th ($52.5k) does not.
    expect(adapter.opened.length).toBe(6);
    const totalNotional = adapter.opened.reduce((s, o) => s + o.notionalUsd, 0);
    expect(totalNotional).toBeLessThanOrEqual(50_000 * MEANREV_STOCKS_MAX_GROSS_EXPOSURE_MULT);
  });

  test("never force-closes an already-held position — the guard only blocks NEW opens", async () => {
    const adapter = new FakeAdapter();
    // HELD already carries most of the cap's headroom.
    const flatCandles = daily(flatThen(100, [100, 99, 98, 97, 96, 95])); // no SMA5 exit
    adapter.setCandles("HELD", flatCandles);
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 1, notional: 24_000, entryTime: ANCHOR - DAY }];
    adapter.setCandles("NEW", daily(flatThen(100, [150, 150.1, 145])));
    const engine = makeEngine(adapter, ["HELD", "NEW"], { maxGrossExposureMult: 0.5 }); // cap = $25,000

    await engine.runDaily();

    expect(adapter.closed).toEqual([]); // HELD never force-closed
    expect(adapter.opened).toEqual([]); // NEW blocked: 24,000 + 5,000 > 25,000
  });
});
