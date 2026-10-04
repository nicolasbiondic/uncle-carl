// MeanRevEngineConfig.entryEligibility (PIT index-universe hook, research
// replays only — see its docstring). Locked here:
//   1. ABSENT hook (and an all-true hook) = byte-identical pass to legacy.
//   2. An ineligible symbol is never a NEW entry candidate.
//   3. An ineligible symbol is EXEMPT from the all-universe entry-freshness
//      gate (its stale/dead series must not block everyone's entries) —
//      while WITHOUT the hook the same stale series blocks the day
//      (incomplete_data), the pre-existing fail-closed behavior.
//   4. Exits never touched: a held ineligible symbol still SMA-exits.
import { describe, expect, test } from "bun:test";
import { MeanRevEngine, type MeanRevBrokerAdapter, type MeanRevPosition } from "./MeanRevEngine";
import type { OHLCV } from "../../utils/types";

const DAY = 86_400_000;
// Wednesday 2026-02-11, 10:00 ET — a normal trading day.
const NOW = Date.parse("2026-02-11T15:00:00Z");
const LAST_BAR = Date.parse("2026-02-10T05:00:00Z"); // yesterday's completed bar

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const deps = { isTradingDay: () => true, now: () => NOW, alreadyEnteredToday: () => false };

/** Daily closes ending at LAST_BAR (or an older bar for a stale series). */
function dailyBars(closes: number[], lastTs = LAST_BAR): OHLCV[] {
  return closes.map((c, i) => ({
    open: c, high: c, low: c, close: c, volume: 1,
    timestamp: lastTs - (closes.length - 1 - i) * DAY,
  }));
}

/** 14 rising closes then two dips: RSI(2)=0 < 5 and close > SMA(10). */
const ENTRY_SIGNAL = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 112, 111];
/** Rising into the last close: close > SMA(5) ⇒ SMA_EXIT for a held position. */
const EXIT_SIGNAL = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 101, 102, 103, 104, 110];

class FakeMeanRevBroker implements MeanRevBrokerAdapter {
  positions: MeanRevPosition[] = [];
  candleStore = new Map<string, OHLCV[]>();
  opened: string[] = [];
  closed: string[] = [];
  set(sym: string, bars: OHLCV[]) { this.candleStore.set(sym, bars); }
  async getOpenPositions() { return this.positions.map(p => ({ ...p })); }
  async fetchCandles(sym: string, bars: number) { return (this.candleStore.get(sym) ?? []).slice(-bars); }
  async openPosition(a: { symbol: string }) { this.opened.push(a.symbol); return { ok: true }; }
  async closePosition(a: { symbol: string }) {
    this.closed.push(a.symbol);
    this.positions = this.positions.filter(p => p.symbol !== a.symbol);
    return { ok: true };
  }
  async getEquity() { return 50_000; }
  async getRealisedPnlSince() { return 0; }
}

const cfg = (universe: string[], extra: Record<string, unknown> = {}) => ({
  universe,
  accountId: "test",
  baseUsd: 50_000,
  slotPct: 0.1,
  maxPositions: 2,
  entryRsi: 5,
  smaLong: 10,
  smaExit: 5,
  timeStopDays: 10,
  historyBars: 16,
  risk: {},
  ...extra,
});

describe("MeanRevEngine entryEligibility", () => {
  test("absent hook and all-true hook produce the same opens", async () => {
    const mk = () => {
      const b = new FakeMeanRevBroker();
      b.set("X", dailyBars(ENTRY_SIGNAL));
      b.set("Y", dailyBars(ENTRY_SIGNAL.map(c => c * 2)));
      return b;
    };
    const legacy = mk();
    await new MeanRevEngine(cfg(["X", "Y"]), legacy, silent, deps).runDaily();
    const hooked = mk();
    await new MeanRevEngine(cfg(["X", "Y"], { entryEligibility: () => true }), hooked, silent, deps).runDaily();
    expect(legacy.opened.sort()).toEqual(["X", "Y"]);
    expect(hooked.opened).toEqual(legacy.opened);
  });

  test("ineligible symbol is never a new entry; eligible ones still enter", async () => {
    const b = new FakeMeanRevBroker();
    b.set("X", dailyBars(ENTRY_SIGNAL));
    b.set("Y", dailyBars(ENTRY_SIGNAL.map(c => c * 2)));
    const seen: Array<[string, number]> = [];
    await new MeanRevEngine(
      cfg(["X", "Y"], { entryEligibility: (s: string, t: number) => { seen.push([s, t]); return s !== "X"; } }),
      b, silent, deps,
    ).runDaily();
    expect(b.opened).toEqual(["Y"]);
    for (const [, t] of seen) expect(t).toBe(NOW);
  });

  test("stale series: blocks the day WITHOUT the hook, exempt WITH it", async () => {
    const stale = () => {
      const b = new FakeMeanRevBroker();
      b.set("DEAD", dailyBars(ENTRY_SIGNAL, LAST_BAR - 10 * DAY)); // last bar 10 days old
      b.set("Y", dailyBars(ENTRY_SIGNAL.map(c => c * 2)));
      return b;
    };
    // Legacy fail-closed: one stale symbol blocks ALL entries for the day.
    const legacy = stale();
    const r1 = await new MeanRevEngine(cfg(["DEAD", "Y"]), legacy, silent, deps).runDaily();
    expect(r1.status).toBe("incomplete_data");
    expect(legacy.opened).toEqual([]);
    // Hook marks DEAD ineligible ⇒ exempt from the gate ⇒ Y enters.
    const hooked = stale();
    const r2 = await new MeanRevEngine(
      cfg(["DEAD", "Y"], { entryEligibility: (s: string) => s !== "DEAD" }),
      hooked, silent, deps,
    ).runDaily();
    expect(r2.status).toBe("ok");
    expect(hooked.opened).toEqual(["Y"]);
  });

  test("a held ineligible symbol still exits (SMA_EXIT)", async () => {
    const b = new FakeMeanRevBroker();
    b.set("HELD", dailyBars(EXIT_SIGNAL));
    b.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: NOW - 5 * DAY }];
    const report = await new MeanRevEngine(
      cfg(["HELD"], { entryEligibility: () => false }),
      b, silent, deps,
    ).runDaily();
    expect(b.closed).toEqual(["HELD"]);
    expect(report.closes[0]).toMatchObject({ symbol: "HELD", reason: "SMA_EXIT", ok: true });
    expect(b.opened).toEqual([]);
  });
});
