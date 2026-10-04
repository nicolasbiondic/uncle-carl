import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  MeanRevEngine,
  MeanRevRetryController,
  isTerminalActionFailure,
  type MeanRevLogger,
} from "./MeanRevEngine";
import type { MomentumStatePersistence } from "../momentum/MomentumEngine";
import { INITIAL_RISK_STATE, EQUITY_SEMANTICS, type RiskState } from "../momentum/RiskGuard";
import { fileStatePersistence } from "../../index";
import { isTradingDay, getPreviousTradingDay } from "../../utils/marketHours";
import type { OHLCV } from "../../utils/types";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DAY, MEANREV_ANCHOR as ANCHOR, daily, flatThen, FakeAdapter } from "../../test-support/meanrev";
import { MemoryPersistence } from "../../test-support/momentum";
import { makeTestDb } from "../../test-support/db";
import { EVENTS } from "../../utils/events";
import { captureEvent } from "../../test-support/events";

const HOUR_MS = 60 * 60 * 1000;

const silent: MeanRevLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeEngine(
  adapter: FakeAdapter,
  universe: string[],
  extra: any = {},
  deps: { isTradingDay?: (dateKey: string) => boolean; now?: () => number } = {},
  state?: MomentumStatePersistence,
) {
  return new MeanRevEngine(
    { accountId: adapter.accountId, universe, baseUsd: 50_000, ...extra },
    adapter,
    silent,
    { isTradingDay: () => true, now: () => ANCHOR, ...deps },
    state,
  );
}

makeTestDb();

describe("MeanRevEngine", () => {
  test("entry fires when RSI2 < 5 and close > SMA200", async () => {
    const adapter = new FakeAdapter();
    // Uptrend well above SMA200, then two down days → RSI2 = 0, close > SMA200.
    adapter.setCandles("BUY", daily(flatThen(100, [150, 150, 148, 146])));
    const engine = makeEngine(adapter, ["BUY"]);

    const report = await engine.runDaily();

    expect(adapter.opened.map((o) => o.symbol)).toEqual(["BUY"]);
    expect(adapter.opened[0].notionalUsd).toBeCloseTo(6_000, 5); // 12% of 50k
    expect(report.opens[0]?.rsi).toBeLessThan(5);
    expect(report.status).toBe("ok");
  });

  test("no entry when close < SMA200 (even with RSI2 < 5)", async () => {
    const adapter = new FakeAdapter();
    // Two down days but price below the long average.
    adapter.setCandles("NO", daily(flatThen(100, [90, 88, 86])));
    const engine = makeEngine(adapter, ["NO"]);

    await engine.runDaily();

    expect(adapter.opened.length).toBe(0);
  });

  test("exit fires when yesterday's close > SMA5", async () => {
    const adapter = new FakeAdapter();
    // Rising tail → last close above SMA5.
    const candles = daily(flatThen(100, [100, 101, 102, 103, 104, 105]));
    adapter.setCandles("HELD", candles);
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: ANCHOR - 2 * DAY }];
    const engine = makeEngine(adapter, ["HELD"]);

    const report = await engine.runDaily();

    expect(adapter.closed.map((c) => c.symbol)).toEqual(["HELD"]);
    expect(report.closes[0]?.reason).toBe("SMA_EXIT");
    expect(report.status).toBe("ok");
  });

  test("a position entered TODAY is never exited by a same-day retry pass; the next daily pass evaluates it (QCOM 2026-09-25 class)", async () => {
    const adapter = new FakeAdapter();
    // One completed bar satisfies BOTH the entry (two down closes after a
    // jump → RSI2 = 0, close > SMA200) AND the exit (close 158 > SMA5 145.4).
    const candles = daily(flatThen(100, [150, 160, 159, 158]));
    adapter.setCandles("X", candles);
    const engine = makeEngine(adapter, ["X"]);

    // First pass of the day: opens X, closes nothing.
    await engine.runDaily();
    expect(adapter.opened.map((o) => o.symbol)).toEqual(["X"]);
    expect(adapter.closed.length).toBe(0);

    // Broker truth now shows the fill, entered TODAY.
    adapter.positions = [{ symbol: "X", side: "buy", quantity: 10, notional: 5_000, entryTime: ANCHOR }];

    // Same-day retry (scheduler re-runs an action_failure day minutes later)
    // sees the SAME completed bar — it must NOT sell what the first pass
    // just bought.
    const retry = await engine.runDaily();
    expect(adapter.closed.length).toBe(0);
    expect(retry.closes.length).toBe(0);

    // Next daily pass (new ET day, next completed bar): exit IS evaluated.
    adapter.setCandles("X", [...candles, { open: 160, high: 160, low: 160, close: 160, volume: 1, timestamp: ANCHOR }]);
    const engine2 = makeEngine(adapter, ["X"], {}, { now: () => ANCHOR + DAY });
    const nextDay = await engine2.runDaily();
    expect(adapter.closed.map((c) => c.symbol)).toEqual(["X"]);
    expect(nextDay.closes[0]?.reason).toBe("SMA_EXIT");
  });

  test("time-stop exit at 10 trading days (falling closes, no SMA exit)", async () => {
    const adapter = new FakeAdapter();
    // Steadily falling closes so close < SMA5 forever — only the time stop fires.
    const closes = flatThen(200, Array.from({ length: 20 }, (_, i) => 190 - i));
    const candles = daily(closes);
    // Entry on the bar 10 sessions back → 9 completed bars after the entry day
    // → held sessions = 10 → time stop fires this morning.
    const entryBar = candles[candles.length - 10];
    adapter.positions = [{ symbol: "OLD", side: "buy", quantity: 10, notional: 1_000, entryTime: entryBar.timestamp + 60_000 }];
    adapter.setCandles("OLD", candles);
    const engine = makeEngine(adapter, ["OLD"]);

    const report = await engine.runDaily();

    expect(adapter.closed.map((c) => c.symbol)).toEqual(["OLD"]);
    expect(report.closes[0]?.reason).toBe("TIME_STOP");

    // One day earlier it must NOT fire (held 9 sessions).
    const adapter2 = new FakeAdapter();
    adapter2.setCandles("OLD", candles);
    adapter2.positions = [{ symbol: "OLD", side: "buy", quantity: 10, notional: 1_000, entryTime: candles[candles.length - 9].timestamp + 60_000 }];
    const engine2 = makeEngine(adapter2, ["OLD"]);
    await engine2.runDaily();
    expect(adapter2.closed.length).toBe(0);
  });

  test("maxPositions respected — opens only up to 5 slots, ranked by lowest RSI", async () => {
    const adapter = new FakeAdapter();
    const universe: string[] = [];
    for (let i = 0; i < 7; i++) {
      const sym = `S${i}`;
      universe.push(sym);
      // All signal (two down days above SMA200); deeper drops → lower RSI for
      // higher i (bigger avgL with zero gains → RSI 0 for all; vary the drop
      // to give distinct rsi via a small up-move first).
      const up = 0.1;
      const drop = 1 + i;
      adapter.setCandles(sym, daily(flatThen(100, [150, 150 + up, 150 + up - drop])));
    }
    // Explicit 5 (production is 7 since 2026-09-24): 7 signalling
    // candidates must still yield exactly maxPositions opens.
    const engine = makeEngine(adapter, universe, { maxPositions: 5 });

    await engine.runDaily();

    expect(adapter.opened.length).toBe(5);
    // Lowest RSI = biggest drop = highest index symbols.
    expect(adapter.opened.map((o) => o.symbol).sort()).toEqual(["S2", "S3", "S4", "S5", "S6"]);
  });

  test("held symbols count against the slots and are not re-entered", async () => {
    const adapter = new FakeAdapter();
    // Falling tail: close < SMA5 (no exit), RSI2 = 0 and close > SMA200 (signals).
    const signalling = daily(flatThen(100, [150, 149, 148, 147, 146, 145]));
    adapter.setCandles("HELD", signalling);
    adapter.setCandles("OTHER", signalling);
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: ANCHOR - DAY }];
    const engine = makeEngine(adapter, ["HELD", "OTHER"], { maxPositions: 1 });

    await engine.runDaily();

    expect(adapter.closed.length).toBe(0); // no exit signal
    expect(adapter.opened.length).toBe(0); // slot taken by HELD; OTHER blocked
  });

  test("DB idempotency blocks a second pass when broker positions are stale", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("BUY", daily(flatThen(100, [150, 150, 148, 146])));
    const engine = makeEngine(adapter, ["BUY"], { maxPositions: 1 });

    await engine.runDaily();
    await engine.runDaily(); // getOpenPositions() is deliberately still stale/empty

    expect(adapter.opened.map((o) => o.symbol)).toEqual(["BUY"]);
  });

  test("today's partial bar is dropped before computing signals", async () => {
    const adapter = new FakeAdapter();
    // Completed bars end with two UP days → RSI2 = 100, no entry signal.
    const completed = daily(flatThen(100, [150, 151, 152]));
    // Append TODAY's partial bar with a huge intraday drop: if counted, RSI2
    // would be ≈0 with close still > SMA200 → a (wrong) entry signal.
    const partial: OHLCV = { open: 152, high: 152, low: 120, close: 121, volume: 1, timestamp: ANCHOR };
    adapter.setCandles("PB", [...completed, partial]);
    const engine = makeEngine(adapter, ["PB"]);

    const report = await engine.runDaily();

    expect(adapter.opened.length).toBe(0);
    expect(report.opens.length).toBe(0);
  });

  test("incomplete universe data returns incomplete_data status", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("READY", daily(flatThen(100, [150, 149, 148])));
    const engine = makeEngine(adapter, ["READY", "MISSING"]);

    const report = await engine.runDaily();
    expect(report.status).toBe("incomplete_data");
    expect(adapter.opened).toEqual([]);
    expect(adapter.closed).toEqual([]);
  });

  test("one missing candidate still lets a valid held-symbol exit fire, then returns incomplete_data", async () => {
    const adapter = new FakeAdapter();
    // MISSING has no candles at all (fetch returns []).
    // HELD has fresh, sufficient data with a clean SMA_EXIT signal.
    const rising = daily(flatThen(100, [100, 101, 102, 103, 104, 105]));
    adapter.setCandles("HELD", rising);
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: ANCHOR - 2 * DAY }];
    const engine = makeEngine(adapter, ["MISSING", "HELD"]);

    const report = await engine.runDaily();

    expect(report.status).toBe("incomplete_data");
    expect(adapter.closed.map((c) => c.symbol)).toEqual(["HELD"]);
    expect(adapter.opened).toEqual([]);
  });

  test("stale held symbol is held conservatively and the incomplete universe returns incomplete_data", async () => {
    const adapter = new FakeAdapter();
    const rising = daily(flatThen(100, [100, 101, 102, 103, 104, 105]));
    // STALE has the SAME length/shape (would satisfy SMA_EXIT if used) but its
    // last bar is 3 calendar days behind the expected previous-trading-day bar.
    const stale = rising.map((b) => ({ ...b, timestamp: b.timestamp - 3 * DAY }));
    adapter.setCandles("STALE", stale);
    adapter.setCandles("FRESH1", rising);
    adapter.setCandles("FRESH2", rising);
    adapter.positions = [{ symbol: "STALE", side: "buy", quantity: 10, notional: 1_000, entryTime: ANCHOR - 10 * DAY }];
    const engine = makeEngine(adapter, ["STALE", "FRESH1", "FRESH2"]);

    const report = await engine.runDaily();

    expect(report.status).toBe("incomplete_data");
    expect(adapter.closed).toEqual([]); // held conservatively, no exit on stale data
    expect(adapter.opened).toEqual([]); // entries blocked too (universe incomplete)
  });

  test("a failed close returns action_failure status", async () => {
    const adapter = new FakeAdapter();
    adapter.closePosition = async (a) => { adapter.closed.push(a); return { ok: false, reason: "broker_error" }; };
    const rising = daily(flatThen(100, [100, 101, 102, 103, 104, 105]));
    adapter.setCandles("HELD", rising);
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: ANCHOR - 2 * DAY }];
    const engine = makeEngine(adapter, ["HELD"]);

    const report = await engine.runDaily();
    expect(report.status).toBe("action_failure");
    expect(adapter.closed.map((c) => c.symbol)).toEqual(["HELD"]); // the attempt still happened
    expect(report.closes[0]?.terminal).toBe(false);
  });

  test("a failed open returns action_failure status", async () => {
    const adapter = new FakeAdapter();
    adapter.openPosition = async (a) => { adapter.opened.push(a); return { ok: false, reason: "insufficient_buying_power" }; };
    adapter.setCandles("BUY", daily(flatThen(100, [150, 150, 148, 146])));
    const engine = makeEngine(adapter, ["BUY"]);

    const report = await engine.runDaily();
    expect(report.status).toBe("terminal_action_failure");
    expect(report.terminalReason).toContain("insufficient_buying_power");
    expect(adapter.opened.map((o) => o.symbol)).toEqual(["BUY"]); // the attempt still happened
    expect(report.opens[0]?.terminal).toBe(true);
  });

  test("qty rejection is terminal and not retried", async () => {
    const adapter = new FakeAdapter();
    adapter.openPosition = async (a) => { adapter.opened.push(a); return { ok: false, reason: "qty_too_small" }; };
    adapter.setCandles("BUY", daily(flatThen(100, [150, 150, 148, 146])));
    const engine = makeEngine(adapter, ["BUY"]);

    const report = await engine.runDaily();
    expect(report.status).toBe("terminal_action_failure");
    expect(report.terminalReason).toContain("qty_too_small");
  });

  test("holiday/non-trading day skips cleanly without retry", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("READY", daily(flatThen(100, [150, 149, 148])));
    const engine = makeEngine(adapter, ["READY"], {}, { isTradingDay: () => false });

    const report = await engine.runDaily();

    expect(adapter.opened).toEqual([]);
    expect(adapter.closed).toEqual([]);
    expect(report.errors.length).toBe(0);
    expect(report.status).toBe("ok");
  });

  test("successful exit followed by incomplete entries retries without duplicate close", async () => {
    const adapter = new FakeAdapter();
    const rising = daily(flatThen(100, [100, 101, 102, 103, 104, 105]));
    adapter.setCandles("HELD", rising);
    adapter.setCandles("READY", daily(flatThen(100, [150, 149, 148])));
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: ANCHOR - 2 * DAY }];
    const engine = makeEngine(adapter, ["HELD", "MISSING"]);

    // First pass: exit HELD, then reject because MISSING blocks entries.
    const report1 = await engine.runDaily();
    expect(report1.status).toBe("incomplete_data");
    expect(adapter.closed.filter((c) => c.symbol === "HELD").length).toBe(1);
    expect(adapter.opened).toEqual([]);

    // Retry: broker truth says HELD is gone; data still incomplete.
    adapter.positions = [];
    const report2 = await engine.runDaily();
    expect(report2.status).toBe("incomplete_data");
    expect(adapter.closed.filter((c) => c.symbol === "HELD").length).toBe(1); // not closed again
    expect(adapter.opened).toEqual([]);
  });

  test("transient incomplete data succeeds on retry without duplicate open", async () => {
    const adapter = new FakeAdapter();
    // A does NOT signal (rising last two days → RSI2 = 100).
    adapter.setCandles("A", daily(flatThen(100, [150, 151, 152])));
    const engine = makeEngine(adapter, ["A", "B"]);

    // B missing → incomplete.
    const report1 = await engine.runDaily();
    expect(report1.status).toBe("incomplete_data");
    expect(adapter.opened).toEqual([]);

    // B becomes available → entry fires exactly once.
    adapter.setCandles("B", daily(flatThen(100, [150, 150, 148, 146])));
    const report2 = await engine.runDaily();
    expect(report2.status).toBe("ok");
    expect(adapter.opened.map((o) => o.symbol)).toEqual(["B"]);
    expect(adapter.opened.length).toBe(1);
  });

  test("skipEntries mode skips entries and still processes exits", async () => {
    const adapter = new FakeAdapter();
    const rising = daily(flatThen(100, [100, 101, 102, 103, 104, 105]));
    adapter.setCandles("HELD", rising);
    adapter.setCandles("BUY", daily(flatThen(100, [150, 150, 148, 146])));
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: ANCHOR - 2 * DAY }];
    const engine = makeEngine(adapter, ["HELD", "BUY"]);

    const report = await engine.runDaily({ skipEntries: true });
    expect(report.status).toBe("entries_skipped");
    expect(adapter.closed.map((c) => c.symbol)).toEqual(["HELD"]);
    expect(adapter.opened).toEqual([]);
  });

  test("skipEntries mode does not duplicate successful exit", async () => {
    const adapter = new FakeAdapter();
    const rising = daily(flatThen(100, [100, 101, 102, 103, 104, 105]));
    adapter.setCandles("HELD", rising);
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: ANCHOR - 2 * DAY }];
    const engine = makeEngine(adapter, ["HELD"]);

    const report1 = await engine.runDaily({ skipEntries: true });
    expect(report1.status).toBe("entries_skipped");
    expect(adapter.closed.filter((c) => c.symbol === "HELD").length).toBe(1);

    // Broker truth says HELD is gone; second skipEntries run still does not re-close.
    adapter.positions = [];
    const report2 = await engine.runDaily({ skipEntries: true });
    expect(report2.status).toBe("entries_skipped");
    expect(adapter.closed.filter((c) => c.symbol === "HELD").length).toBe(1);
  });

  test("persistent missing symbol capped by skipEntries returns entries_skipped", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("A", daily(flatThen(100, [150, 149, 148])));
    // B never has data.
    const engine = makeEngine(adapter, ["A", "B"]);

    const report = await engine.runDaily({ skipEntries: true });
    expect(report.status).toBe("entries_skipped");
    // A is a candidate but entries are skipped.
    expect(adapter.opened).toEqual([]);
  });
});

describe("MeanRevEngine — RiskGuard portfolio breaker (OPEN.md P2)", () => {
  // (a) Paused ⇒ 0 new entries, but exits (SMA_EXIT/TIME_STOP) still run —
  // the invariant this repo repeats everywhere: existing positions are
  // NEVER left unmanaged by RiskGuard.
  test("paused RiskGuard state blocks new entries but SMA_EXIT still executes", async () => {
    const adapter = new FakeAdapter();
    const rising = daily(flatThen(100, [100, 101, 102, 103, 104, 105])); // SMA_EXIT signal
    adapter.setCandles("HELD", rising);
    adapter.setCandles("BUY", daily(flatThen(100, [150, 150, 148, 146]))); // valid entry signal
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: ANCHOR - 2 * DAY }];

    const pausedState: RiskState = {
      ...INITIAL_RISK_STATE,
      peakEquity: 50_000,
      dayStartEquity: 50_000,
      dayStartedAt: ANCHOR - DAY,
      pausedUntil: ANCHOR + 999 * DAY,
      pauseReason: "soft drawdown 12.0% — paused 24h",
    };
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: pausedState, trailMarks: {} };
    const engine = makeEngine(adapter, ["HELD", "BUY"], {}, {}, persistence);

    const report = await engine.runDaily();

    expect(adapter.closed.map((c) => c.symbol)).toEqual(["HELD"]); // exit still ran
    expect(adapter.opened).toEqual([]);                            // no new entries
    expect(report.blockedReason).toContain("soft drawdown");
  });

  // (a, TIME_STOP variant) Same invariant for the other exit path.
  test("paused RiskGuard state blocks new entries but TIME_STOP still executes", async () => {
    const adapter = new FakeAdapter();
    const closes = flatThen(200, Array.from({ length: 20 }, (_, i) => 190 - i));
    const candles = daily(closes);
    const entryBar = candles[candles.length - 10]; // held 10 sessions → time stop fires
    adapter.setCandles("OLD", candles);
    adapter.positions = [{ symbol: "OLD", side: "buy", quantity: 10, notional: 1_000, entryTime: entryBar.timestamp + 60_000 }];

    const pausedState: RiskState = {
      ...INITIAL_RISK_STATE,
      peakEquity: 50_000, dayStartEquity: 50_000, dayStartedAt: ANCHOR - DAY,
      pausedUntil: ANCHOR + 999 * DAY, pauseReason: "hard drawdown 25.0% — paused 168h, human review required",
    };
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: pausedState, trailMarks: {} };
    const engine = makeEngine(adapter, ["OLD"], {}, {}, persistence);

    const report = await engine.runDaily();

    expect(adapter.closed.map((c) => c.symbol)).toEqual(["OLD"]);
    expect(report.blockedReason).toContain("hard drawdown");
  });

  // (b) Drawdown (the meaningful breaker at this cadence — see the wiring
  // comment in index.ts on why dailyLossCapPct is near-inert for a
  // once-per-day evaluateRisk call) trips on synthetic equity and the
  // reason surfaces on the report, exactly like MomentumEngine's
  // "new entries BLOCKED: <reason>".
  test("hard drawdown trips on synthetic equity and the reason appears on the report", async () => {
    const adapter = new FakeAdapter();
    adapter.equity = 50_000;
    const engine = makeEngine(adapter, []); // empty universe: isolates the risk gate

    const report1 = await engine.runDaily();
    expect(report1.blockedReason).toBeUndefined();
    expect(engine.getRiskState().peakEquity).toBe(50_000);

    adapter.equity = 39_000; // -22%, past hardDrawdownPct (-20%)
    const report2 = await engine.runDaily();

    expect(report2.blockedReason).toContain("hard drawdown");
    expect(adapter.opened).toEqual([]);
  });

  // (c) Round-trip persistence of meanrev's risk state through the SAME
  // envelope fileStatePersistence writes for the momentum sleeves — including
  // a first-boot read of a file that doesn't exist yet.
  test("risk state round-trips through fileStatePersistence, including a clean first boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meanrev-risk-state-"));
    const path = join(dir, "meanrev-state-stocks.json");
    try {
      // First boot: no file yet.
      expect(existsSync(path)).toBe(false);
      const persistence1 = fileStatePersistence(path, 50_000, 50_000, EQUITY_SEMANTICS.SLEEVE_LEDGER);
      expect(persistence1.load()).toBeNull();

      const adapter = new FakeAdapter();
      adapter.equity = 77_000;
      const engine1 = makeEngine(adapter, [], {}, {}, persistence1);
      expect(engine1.getRiskState().peakEquity).toBe(0); // nothing loaded yet

      await engine1.runDaily();
      expect(existsSync(path)).toBe(true);

      // Fresh process/engine reading the SAME file back.
      const persistence2 = fileStatePersistence(path, 50_000, 50_000, EQUITY_SEMANTICS.SLEEVE_LEDGER);
      const engine2 = makeEngine(new FakeAdapter(), [], {}, {}, persistence2);
      expect(engine2.getRiskState().peakEquity).toBe(77_000);
      expect(engine2.getRiskState().equitySemantics).toBe(EQUITY_SEMANTICS.SLEEVE_LEDGER);
    } finally {
      try { require("fs").rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  // (d) The equity feeding RiskGuard must be the SLEEVE's own ledger
  // (broker.getEquity() — meanrevAdapter/AlpacaMomentumAdapter scopes it to
  // accountId="meanrev_stocks"), never the aggregate shared-wallet account.
  // The engine has exactly ONE equity source (this.broker.getEquity()); if a
  // future change fed RiskGuard from anywhere else (e.g. an account-total
  // read, or a hardcoded RISK_PROFILES constant), peakEquity below would stop
  // matching this adapter's deliberately odd, non-round return value.
  test("RiskGuard is fed the sleeve's own equity, not a shared/aggregate value", async () => {
    const adapter = new FakeAdapter();
    adapter.equity = 12_345; // sleeve-scoped, not RISK_PROFILES.meanrev_stocks.initialEquity (50k)
    const engine = makeEngine(adapter, []);

    await engine.runDaily();

    expect(engine.getRiskState().peakEquity).toBe(12_345);
  });
});

describe("MeanRevEngine — pause transition events (B-ops-alerts.md #1)", () => {
  test("a fresh soft-drawdown breach fires ONE pause_started; continuation passes while still paused fire nothing more", async () => {
    const adapter = new FakeAdapter();
    const engine = makeEngine(adapter, [], { heartbeatName: "test:mr-pause-events" });
    const { events, detach } = captureEvent(EVENTS.CIRCUIT_BREAKER);
    try {
      adapter.equity = 50_000;
      await engine.runDaily(); // seeds peakEquity, no breach
      expect(events).toHaveLength(0);

      adapter.equity = 44_000; // -12%, past softDrawdownPct (-10%)
      await engine.runDaily(); // fresh breach → pause_started
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sleeve: "test:mr-pause-events", profileId: "test:mr-pause-events", action: "pause_started" });
      expect(events[0].reason).toContain("soft drawdown");
      expect(events[0].resumeAt).toBeGreaterThan(ANCHOR);

      // Same-day retry idiom (index.ts's scheduleDailyStockRun): several
      // more passes while the pause window is still active must NOT re-fire.
      await engine.runDaily();
      await engine.runDaily();
      expect(events).toHaveLength(1);
    } finally { detach(); }
  });

  test("recovery once the pause window lapses fires ONE pause_resolved, never per pass", async () => {
    const adapter = new FakeAdapter();
    let now = ANCHOR;
    const engine = makeEngine(adapter, [], { heartbeatName: "test:mr-pause-resolve" }, { now: () => now });
    const { events, detach } = captureEvent(EVENTS.CIRCUIT_BREAKER);
    try {
      adapter.equity = 50_000;
      await engine.runDaily(); // seed peak
      adapter.equity = 44_000; // -12% → soft drawdown, 24h pause
      await engine.runDaily();
      expect(events.map(e => e.action)).toEqual(["pause_started"]);

      now += 25 * HOUR_MS; // past the 24h soft-pause window
      adapter.equity = 50_000; // recovered — no new breach this pass
      await engine.runDaily();
      expect(events.map(e => e.action)).toEqual(["pause_started", "pause_resolved"]);
      expect(events[1].reason).toContain("soft drawdown"); // names what it recovered FROM

      await engine.runDaily(); // a further healthy pass must not re-fire
      expect(events).toHaveLength(2);
    } finally { detach(); }
  });

  test("hard drawdown ALSO pages ops via a separate ERROR_BURST (RiskGuard.hardDrawdown context)", async () => {
    const adapter = new FakeAdapter();
    const engine = makeEngine(adapter, [], { heartbeatName: "test:mr-pause-harddd" });
    const { events: breakers, detach: detachCb } = captureEvent(EVENTS.CIRCUIT_BREAKER);
    const { events: bursts, detach: detachBurst } = captureEvent(EVENTS.ERROR_BURST);
    try {
      adapter.equity = 50_000;
      await engine.runDaily();
      adapter.equity = 37_500; // -25%, past hardDrawdownPct (-20%)
      await engine.runDaily();

      expect(breakers).toHaveLength(1);
      expect(breakers[0].action).toBe("pause_started");
      expect(breakers[0].reason).toContain("hard drawdown");
      const hardDdBursts = bursts.filter((b: any) => b.context === "RiskGuard.hardDrawdown");
      expect(hardDdBursts).toHaveLength(1);
      expect(hardDdBursts[0].message).toContain("test:mr-pause-harddd");
    } finally { detachCb(); detachBurst(); }
  });

  test("a restart mid-pause (persisted state already shows an active pause) does not re-fire pause_started on the first post-restart pass", async () => {
    const adapter = new FakeAdapter();
    adapter.equity = 44_000; // still within the drawdown band
    const pausedState: RiskState = {
      ...INITIAL_RISK_STATE,
      peakEquity: 50_000,
      dayStartEquity: 50_000,
      dayStartedAt: ANCHOR,
      pausedUntil: ANCHOR + 12 * HOUR_MS, // 12h still to go
      pauseReason: "soft drawdown 12.0% — paused 24h",
      lastEvalAt: ANCHOR,
    };
    const persistence = new MemoryPersistence();
    persistence.store = { v: 1, risk: pausedState, trailMarks: {} };
    const engine = makeEngine(adapter, [], { heartbeatName: "test:mr-pause-restart" }, {}, persistence);
    const { events, detach } = captureEvent(EVENTS.CIRCUIT_BREAKER);
    try {
      await engine.runDaily(); // continuation of an ALREADY-persisted pause — must be silent
      expect(events).toHaveLength(0);
    } finally { detach(); }
  });
});

describe("MeanRevEngine — risk anchor advances independent of pass outcome (C-code-arch.md #4)", () => {
  // Regression for the retry double-counting bug: index.ts's
  // scheduleDailyStockRun re-invokes runDaily() same-day, minutes apart,
  // whenever a pass returns "incomplete_data"/"action_failure". Before the
  // fix, the risk-read anchor only advanced at the BOTTOM of a fully
  // successful pass, so every one of those retries re-read realised P&L
  // "since" the SAME stale anchor and re-recorded the SAME already-closed
  // loss into RiskGuard's consecutive-loss streak. Fixed: the anchor now
  // advances the moment the read is incorporated, before exits/entries run,
  // regardless of whether the rest of the pass later fails.
  test("N retried (action_failure) passes the same day record the loss exactly once", async () => {
    const adapter = new FakeAdapter();
    const rising = daily(flatThen(100, [100, 101, 102, 103, 104, 105])); // SMA_EXIT signal, high RSI (no entry)
    adapter.setCandles("HELD", rising);
    adapter.positions = []; // no holdings yet for the anchor-setting pass

    // A single trade closed at lossClosedAt with -100 realised P&L. Any
    // "since" read whose anchor predates it sees -100; any read whose anchor
    // is AT or AFTER it sees 0 (no new realised P&L in that later interval).
    const T0 = ANCHOR;
    const lossClosedAt = T0 + 1_000;
    (adapter as any).getRealisedPnlSince = async (epochMs: number) => (epochMs < lossClosedAt ? -100 : 0);
    // Every close attempt fails (transient broker error) — this is what
    // pushes every one of these passes to status "action_failure".
    (adapter as any).closePosition = async (a: { symbol: string; side: "buy" | "sell" }) => {
      adapter.closed.push(a);
      return { ok: false, reason: "transient close error" };
    };

    let nowMs = T0;
    const engine = makeEngine(adapter, ["HELD"], {}, { now: () => nowMs });

    // Pass 1 (t=T0): no positions yet, nothing to exit/enter — succeeds
    // cleanly and anchors the risk-read clock at T0 (lastRiskReadAt has
    // never been >0 before this, so it reads nothing this pass).
    const report1 = await engine.runDaily();
    expect(report1.status).toBe("ok");
    expect(engine.getRiskState().consecutiveLosses).toBe(0);

    // Now the position exists and every close attempt fails — simulates
    // index.ts retrying the SAME trading day's pass 3 times after the first
    // action_failure (scheduleDailyStockRun's maxDataRetries default is 3).
    adapter.positions = [{ symbol: "HELD", side: "buy", quantity: 10, notional: 1_000, entryTime: T0 - DAY }];

    nowMs = T0 + 2_000; // > lossClosedAt
    const report2 = await engine.runDaily();
    expect(report2.status).toBe("action_failure");

    nowMs = T0 + 4_000;
    const report3 = await engine.runDaily();
    expect(report3.status).toBe("action_failure");

    nowMs = T0 + 6_000;
    const report4 = await engine.runDaily();
    expect(report4.status).toBe("action_failure");

    // Exactly ONE consecutive loss recorded — the single trade that closed
    // at lossClosedAt — not one per retry (which would be 3).
    expect(engine.getRiskState().consecutiveLosses).toBe(1);
  });

  test("a restart between two daily passes records the day in between (the anchor is persisted, 2026-10-03)", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("HELD", daily(flatThen(100, [100, 101, 102, 103, 104, 105]))); // fresh data, no entry signal
    const T0 = ANCHOR;
    const lossClosedAt = T0 + 1_000;
    (adapter as any).getRealisedPnlSince = async (epochMs: number) => (epochMs < lossClosedAt ? -100 : 0);
    const persistence = new MemoryPersistence();

    let nowMs = T0;
    const before = makeEngine(adapter, ["HELD"], {}, { now: () => nowMs }, persistence);
    expect((await before.runDaily()).status).toBe("ok"); // anchors at T0, records nothing
    expect(persistence.store?.riskAnchorAt).toBe(T0);

    nowMs = T0 + 2_000; // the losing trade closed while the process was down
    const after = makeEngine(adapter, ["HELD"], {}, { now: () => nowMs }, persistence);
    await after.runDaily();
    expect(after.getRiskState().consecutiveLosses).toBe(1); // was 0: the restart dropped the day
    expect(persistence.store?.riskAnchorAt).toBe(T0 + 2_000);
  });
});

describe("MeanRevRetryController", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "meanrev-retry-"));
    statePath = join(tmpDir, "retry.json");
  });

  afterEach(() => {
    // bun-types' fs shim omits rmSync typings; require dodges the type error.
    try { require("fs").rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("restart preserves attempt cap", () => {
    const today = "2026-07-17";
    const c1 = new MeanRevRetryController(statePath, { maxDataRetries: 2 });
    c1.recordAttempt(today, 1_000);
    c1.recordAttempt(today, 2_000);

    const c2 = new MeanRevRetryController(statePath, { maxDataRetries: 2 });
    expect(c2.getAttempt(today)?.count).toBe(2);
    expect(c2.shouldRun(today, 3_000)).toEqual({ run: true, skipEntries: true });
  });

  test("success clears attempts and marker", () => {
    const today = "2026-07-17";
    const c = new MeanRevRetryController(statePath, { maxDataRetries: 2 });
    c.recordAttempt(today, 1_000);
    c.markSuccess(today);
    expect(c.getLastSuccessDate()).toBe(today);
    expect(c.getAttempt(today)).toBeUndefined();
    expect(c.shouldRun(today, 2_000)).toEqual({ run: false, skipEntries: false, reason: "success" });
  });

  test("terminal blocks further runs", () => {
    const today = "2026-07-17";
    const c = new MeanRevRetryController(statePath, { maxDataRetries: 2 });
    c.recordAttempt(today, 1_000);
    c.markTerminal(today, "insufficient_buying_power", 2_000);
    expect(c.shouldRun(today, 3_000)).toEqual({ run: false, skipEntries: false, reason: "terminal" });
    expect(c.getAttempt(today)?.terminalReason).toContain("insufficient_buying_power");
  });

  test("backoff grows deterministically", () => {
    const today = "2026-07-17";
    const c = new MeanRevRetryController(statePath, { maxDataRetries: 3, baseBackoffMs: 5_000, backoffMultiplier: 2 });
    c.recordAttempt(today, 0);
    expect(c.shouldRun(today, 1_000)).toEqual({ run: false, skipEntries: false, reason: "backoff", waitMs: 4_000 });
    expect(c.shouldRun(today, 5_000)).toEqual({ run: true, skipEntries: false });

    c.recordAttempt(today, 5_000);
    expect(c.shouldRun(today, 6_000)).toEqual({ run: false, skipEntries: false, reason: "backoff", waitMs: 9_000 });
    expect(c.shouldRun(today, 15_000)).toEqual({ run: true, skipEntries: false });
  });

  test("maxDataRetries switches to skipEntries", () => {
    const today = "2026-07-17";
    const c = new MeanRevRetryController(statePath, { maxDataRetries: 2 });
    c.recordAttempt(today, 0);
    c.recordAttempt(today, 1);
    expect(c.shouldRun(today, 2)).toEqual({ run: true, skipEntries: true });
  });

  test("state file is atomic tmp+rename", () => {
    const today = "2026-07-17";
    const c = new MeanRevRetryController(statePath, { maxDataRetries: 2 });
    c.recordAttempt(today, 1_000);
    expect(existsSync(statePath)).toBe(true);
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.attempts[today].count).toBe(1);
  });
});

describe("isTerminalActionFailure", () => {
  test("buying-power and qty rejections are terminal", () => {
    expect(isTerminalActionFailure("insufficient_buying_power")).toBe(true);
    expect(isTerminalActionFailure("qty_too_small")).toBe(true);
    expect(isTerminalActionFailure("computed qty < 1 share")).toBe(true);
    expect(isTerminalActionFailure("insufficient fill (0)")).toBe(true);
  });

  test("transient broker errors are not terminal", () => {
    expect(isTerminalActionFailure("alpaca not connected")).toBe(false);
    expect(isTerminalActionFailure("broker_error")).toBe(false);
    expect(isTerminalActionFailure("no price for SYM")).toBe(false);
    expect(isTerminalActionFailure(undefined)).toBe(false);
  });
});

describe("marketHours trading-day helpers", () => {
  test("weekends and observed holidays are not trading days", () => {
    expect(isTradingDay("2026-07-17")).toBe(true);   // Fri
    expect(isTradingDay("2026-07-18")).toBe(false);  // Sat
    expect(isTradingDay("2026-07-19")).toBe(false);  // Sun
    expect(isTradingDay("2026-01-01")).toBe(false);  // New Year's Day (Thu)
    expect(isTradingDay("2026-07-03")).toBe(false);  // Independence Day observed (Sat→Fri)
    expect(isTradingDay("2026-07-04")).toBe(false);  // Independence Day (Sat)
    expect(isTradingDay("2026-11-26")).toBe(false);  // Thanksgiving
  });

  test("previous trading day skips weekends and holidays", () => {
    expect(getPreviousTradingDay("2026-07-17")).toBe("2026-07-16"); // Fri <- Thu
    expect(getPreviousTradingDay("2026-07-20")).toBe("2026-07-17"); // Mon <- Fri
    expect(getPreviousTradingDay("2026-07-06")).toBe("2026-07-02"); // post-July4-observed <- Thu
  });
});

describe("Bounded MeanRev daily retries — spec verification", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "meanrev-bounded-retry-"));
  });

  afterEach(() => {
    try { require("fs").rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // Spec: Transient incomplete data retries with exponential backoff until capped.
  test("transient data recovers on retry (backoff enforced)", () => {
    const today = "2026-07-17";
    const retryPath = join(tmpDir, "retry.json");
    const baseMs = 5_000;

    const retry = new MeanRevRetryController(retryPath, { baseBackoffMs: baseMs });
    retry.recordAttempt(today, 0);
    expect(retry.shouldRun(today, 1_000).run).toBe(false); // in backoff
    expect(retry.shouldRun(today, baseMs + 1).run).toBe(true); // after backoff
  });

  // Spec: Persistent incomplete data capped at maxDataRetries, then skipEntries mode.
  test("persistent incomplete data switches to skipEntries after maxDataRetries", () => {
    const today = "2026-07-17";
    const retryPath = join(tmpDir, "retry.json");

    const retry = new MeanRevRetryController(retryPath, { maxDataRetries: 2 });
    retry.recordAttempt(today, 0);
    retry.recordAttempt(today, 5_000);
    retry.recordAttempt(today, 10_000);

    const decision = retry.shouldRun(today, 10_001);
    expect(decision.skipEntries).toBe(true); // entries marked incomplete, exits still run
  });

  // Spec: Terminal failures (buying power, qty, suspended) do not retry.
  test("terminal rejection blocks further runs — pages once", () => {
    const today = "2026-07-17";
    const retryPath = join(tmpDir, "retry.json");

    const retry = new MeanRevRetryController(retryPath);
    retry.recordAttempt(today, 0);
    retry.markTerminal(today, "insufficient_buying_power", 1_000);

    const decision = retry.shouldRun(today, 2_000);
    expect(decision.run).toBe(false);
    expect(decision.reason).toBe("terminal");
  });

  // Spec: Restart persists retry state across process boundary.
  test("restart persists state: attempts, backoff windows, terminal flags", () => {
    const today = "2026-07-17";
    const retryPath = join(tmpDir, "retry.json");

    // Session 1: record 2 attempts, mark terminal
    const retry1 = new MeanRevRetryController(retryPath);
    retry1.recordAttempt(today, 0);
    retry1.recordAttempt(today, 5_000);
    retry1.markTerminal(today, "qty_too_small", 10_000);

    // Session 2 (restart): state is persisted
    const retry2 = new MeanRevRetryController(retryPath);
    expect(retry2.getAttempt(today)?.count).toBe(2);
    expect(retry2.getAttempt(today)?.terminal).toBe(true);
    expect(retry2.getAttempt(today)?.terminalReason).toBe("qty_too_small");
    expect(retry2.shouldRun(today, 10_001).run).toBe(false);
  });

  // Spec: Holidays are no-ops (isTradingDay = false → returns ok with no actions).
  test("non-trading day is a no-op (returns ok, no opens/closes)", async () => {
    const adapter = new FakeAdapter();
    adapter.setCandles("ANY", daily(flatThen(100, [150, 149, 148])));
    const engine = makeEngine(adapter, ["ANY"], {}, { isTradingDay: () => false, now: () => ANCHOR });

    const report = await engine.runDaily();
    expect(report.status).toBe("ok");
    expect(report.errors).toHaveLength(0);
    expect(adapter.opened).toHaveLength(0);
    expect(adapter.closed).toHaveLength(0);
  });
});
