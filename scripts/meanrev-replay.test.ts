import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMeanRevReplay } from "./meanrev-replay";
import { hashReplayConfig, type ReplayConfig } from "./backtest-momentum-wf";
import { trailPctFromVol } from "../src/strategies/momentum/MomentumEngine";

// Every test here builds a historical DB and runs a full replay (16 tests,
// ~28 s for the file): the 5 s bun default failed one of them at 5.7 s under
// load (2026-10-02). Same 30 s budget the other replay suites use per test.
setDefaultTimeout(30_000);

/**
 * Deterministic fixture: small synthetic daily-bar universe where every
 * expected fill/pnl is computed BY HAND in the assertions. Params use a
 * short SMA (smaLong=5, smaExit=3) so the fixture stays readable — the
 * simulator math is identical for the production 200/5 params.
 *
 * Calendar: weekdays Jan/Feb 2024, bars stamped 05:00Z (midnight ET, like
 * alpaca_wide dailies). Window [2024-01-20, 2024-02-03): trading dates
 * Jan 22..Feb 2. Warmup Jan 1..19 (15 bars ≥ smaLong+1).
 *
 * Shared entry setup (every case): AAA closes ...90×12, 100, 98, 96 — on
 * the Jan 19 signal bar RSI(2)=0 (two straight down closes) < 5 and close
 * 96 > SMA5 (90+90+100+98+96)/5 = 94.8, so the sim buys at Jan 22's open
 * of 95: qty = floor(5000/95) = 52 whole shares.
 */

type Row = [date: string, open: number, high: number, low: number, close: number];

const WARMUP_DATES = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", "2024-01-15", "2024-01-16", "2024-01-17", "2024-01-18", "2024-01-19"];
const WINDOW_DATES = ["2024-01-22", "2024-01-23", "2024-01-24", "2024-01-25", "2024-01-26", "2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"];
const ALL_DATES = [...WARMUP_DATES, ...WINDOW_DATES];

const WARMUP_CLOSES = [90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 100, 98, 96];

function warmupRows(): Row[] {
  return WARMUP_DATES.map((d, i) => [d, WARMUP_CLOSES[i], WARMUP_CLOSES[i], WARMUP_CLOSES[i], WARMUP_CLOSES[i]] as Row);
}

function flatRows(dates: string[], px: number): Row[] {
  return dates.map(d => [d, px, px, px, px] as Row);
}

function makeDb(dir: string, bars: Record<string, Row[]>): string {
  const dbPath = join(dir, "historical.db");
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE historical_bars (
      symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      PRIMARY KEY(symbol, timeframe, source, timestamp)
    )`);
    const stmt = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
    for (const [symbol, rows] of Object.entries(bars)) {
      for (const [date, open, high, low, close] of rows) {
        stmt.run(symbol, "1d", "alpaca_wide", Date.parse(`${date}T05:00:00Z`), open, high, low, close, 1000);
      }
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function cfgFor(dbPath: string, overrides: Partial<ReplayConfig> = {}, meanrevOverrides: Partial<NonNullable<ReplayConfig["meanrev"]>> = {}): ReplayConfig {
  return {
    sleeve: "meanrev",
    universe: ["AAA"],
    timeframe: "1d",
    source: "alpaca_wide",
    refSymbol: "REF",
    rthOnly: false,
    funding: false,
    barMinutes: 1440,
    barMinutesEq: 1440,
    slippageBps: 0,
    commissionBps: 0,
    initialEquity: 50_000,
    leverage: 1,
    hardStopPct: 0.04,
    cadenceMin: 1440,
    notionalPctPerSlot: 0.1,
    entryPct: 0,
    exitPct: 0,
    maxLongs: 0,
    maxShorts: 0,
    shortFunding: "credit",
    meanrev: { entryRsi: 5, smaLong: 5, smaExit: 3, timeStopDays: 10, maxPositions: 1, slotPct: 0.1, ...meanrevOverrides },
    warmupDays: 22,
    dbPath,
    ...overrides,
  };
}

const WIN = { label: "t", from: "2024-01-20", to: "2024-02-03" };

function refRows(): Row[] {
  // Flat 50 except the last window bar at 55 → refSymbol B&H = +10%.
  return [...flatRows(ALL_DATES.slice(0, -1), 50), ["2024-02-02", 55, 55, 55, 55] as Row];
}

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meanrev-replay-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("meanrev replay — deterministic hand-computed scenarios", () => {
  test("entry on RSI2<entryRsi above SMAlong, exit when yesterday's close > SMA(smaExit)", () => withTmp(async dir => {
    // Jan 22: open 95 (entry, qty 52). Jan 23: close 99.
    // Jan 24 morning: signal bar Jan 23 close 99 > SMA3(96,95,99)=96.67 →
    // SMA_EXIT at Jan 24 open 100. PnL = (100−95)×52 = +260.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 96, 99, 95, 99],
      ["2024-01-24", 100, 101, 100, 101],
      ["2024-01-25", 102, 102, 102, 102],
      ["2024-01-26", 103, 103, 103, 103],
      ["2024-01-29", 104, 104, 104, 104],
      ["2024-01-30", 105, 105, 105, 105],
      ["2024-01-31", 106, 106, 106, 106],
      ["2024-02-01", 107, 107, 107, 107],
      ["2024-02-02", 108, 108, 108, 108],
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });
    const cfg = cfgFor(dbPath);
    const r = await runMeanRevReplay(cfg, WIN);
    expect(r).not.toBeNull();
    expect(r!.trades).toBe(1);
    expect(r!.closedTrades[0].symbol).toBe("AAA");
    expect(r!.closedTrades[0].reason).toBe("SMA_EXIT");
    expect(r!.closedTrades[0].pnl).toBeCloseTo(260, 6);
    expect(r!.finalEquity).toBeCloseTo(50_260, 6);
    expect(r!.totalReturn).toBeCloseTo(260 / 50_000, 9);
    expect(r!.winRate).toBe(1);
    expect(r!.maxDrawdown).toBeCloseTo(0, 9);
    expect(r!.bench).toBeCloseTo(0.1, 9); // REF 50 → 55
    expect(r!.fees).toBe(0);
    expect(r!.ruined).toBe(false);
    expect(r!.hash).toBe(hashReplayConfig(cfg));

    // Determinism: identical second run.
    const r2 = await runMeanRevReplay(cfg, WIN);
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r));
  }));

  test("time stop fires after timeStopDays trading days when the SMA exit never triggers", () => withTmp(async dir => {
    // Flat 95 closes after entry: yesterday's close is never STRICTLY above
    // SMA3, so only the time stop (3 trading days) can exit — at Jan 25's
    // open of 94. PnL = (94−95)×52 = −52.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 95, 95, 95, 95],
      ["2024-01-24", 95, 95, 95, 95],
      ["2024-01-25", 94, 94, 93, 94],
      ["2024-01-26", 95, 95, 95, 95],
      ["2024-01-29", 96, 96, 96, 96],
      ["2024-01-30", 97, 97, 97, 97],
      ["2024-01-31", 98, 98, 98, 98],
      ["2024-02-01", 99, 99, 99, 99],
      ["2024-02-02", 100, 100, 100, 100],
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });
    const r = await runMeanRevReplay(cfgFor(dbPath, {}, { timeStopDays: 3 }), WIN);
    expect(r!.trades).toBe(1);
    expect(r!.closedTrades[0].reason).toBe("TIME_STOP");
    expect(r!.closedTrades[0].pnl).toBeCloseTo(-52, 6);
    expect(r!.finalEquity).toBeCloseTo(49_948, 6);
  }));

  test("hard stop fills at min(open, stop) on the bar that breaches entry×(1−hardStopPct)", () => withTmp(async dir => {
    // Entry 95 → stop 91.2. Jan 23 low 90 breaches; open 94 > stop, so the
    // fill honors the stop price: PnL = (91.2−95)×52 = −197.6.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 94, 94.5, 90, 92],
      ["2024-01-24", 93, 93, 93, 93],
      ["2024-01-25", 94, 94, 94, 94],
      ["2024-01-26", 95, 95, 95, 95],
      ["2024-01-29", 96, 96, 96, 96],
      ["2024-01-30", 97, 97, 97, 97],
      ["2024-01-31", 98, 98, 98, 98],
      ["2024-02-01", 99, 99, 99, 99],
      ["2024-02-02", 100, 100, 100, 100],
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });
    const r = await runMeanRevReplay(cfgFor(dbPath), WIN);
    expect(r!.trades).toBe(1);
    expect(r!.closedTrades[0].reason).toBe("STOP_LOSS");
    expect(r!.closedTrades[0].pnl).toBeCloseTo(-197.6, 6);
    expect(r!.finalEquity).toBeCloseTo(50_000 - 197.6, 6);
    expect(r!.maxDrawdown).toBeCloseTo(197.6 / 50_000, 9);
  }));

  test("costs apply per side: slippage moves the fill, commission is charged on both legs", () => withTmp(async dir => {
    // Same tape as the SMA-exit case, slippage 10bps + commission 5bps.
    // qty sizes on the RAW open (whole shares): floor(5000/95) = 52.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 96, 99, 95, 99],
      ["2024-01-24", 100, 101, 100, 101],
      ["2024-01-25", 102, 102, 102, 102],
      ["2024-01-26", 103, 103, 103, 103],
      ["2024-01-29", 104, 104, 104, 104],
      ["2024-01-30", 105, 105, 105, 105],
      ["2024-01-31", 106, 106, 106, 106],
      ["2024-02-01", 107, 107, 107, 107],
      ["2024-02-02", 108, 108, 108, 108],
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });
    const r = await runMeanRevReplay(cfgFor(dbPath, { slippageBps: 10, commissionBps: 5 }), WIN);
    const entryPx = 95 * 1.001;         // 95.095
    const exitPx = 100 * 0.999;         // 99.9
    const entryFee = 52 * entryPx * 0.0005;
    const exitFee = 52 * exitPx * 0.0005;
    const gross = (exitPx - entryPx) * 52;
    expect(r!.trades).toBe(1);
    expect(r!.closedTrades[0].pnl).toBeCloseTo(gross - entryFee - exitFee, 6);
    expect(r!.fees).toBeCloseTo(entryFee + exitFee, 6);
    expect(r!.finalEquity).toBeCloseTo(50_000 + gross - entryFee - exitFee, 6);
  }));

  test("a position still open at the window edge liquidates at the last close (fold_end)", () => withTmp(async dir => {
    // Flat 95 forever after entry, default 10-day time stop never reached
    // inside the 10-session window (max held = 9) → fold_end at close 95.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ...flatRows(WINDOW_DATES.slice(1), 95),
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });
    const r = await runMeanRevReplay(cfgFor(dbPath), WIN);
    expect(r!.trades).toBe(1);
    expect(r!.closedTrades[0].reason).toBe("fold_end");
    expect(r!.closedTrades[0].exitAt).toBe(Date.parse(WIN.to));
    expect(r!.closedTrades[0].pnl).toBeCloseTo(0, 6);
    expect(r!.finalEquity).toBeCloseTo(50_000, 6);
  }));

  test("fails closed on insufficient warmup", () => withTmp(async dir => {
    // Only 3 warmup bars < smaLong+1 = 6.
    const aaa: Row[] = [
      ...warmupRows().slice(-3),
      ...flatRows(WINDOW_DATES, 95),
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: [...flatRows(WARMUP_DATES.slice(-3), 50), ...flatRows(WINDOW_DATES, 50)] });
    // Shrink warmupDays so the first-bar coverage check targets the same
    // 3-bar span and the failure isolates to the warmup-count guard.
    expect(runMeanRevReplay(cfgFor(dbPath, { warmupDays: 5 }), WIN)).rejects.toThrow(/insufficient warmup/);
  }));

  test("fails closed on an internal coverage gap (delisting-class hole)", () => withTmp(async dir => {
    // AAA goes dark Jan 23 → Feb 2 (> 10 calendar days).
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-02-02", 95, 95, 95, 95],
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });
    expect(runMeanRevReplay(cfgFor(dbPath), WIN)).rejects.toThrow(/gap/);
  }));
});

describe("meanrev replay — hard stop axis (stop-sizing sweep)", () => {
  // Shared recovery tail: after the Jan 23 dip (whose depth varies per
  // test), Jan 24 closes at 99, so the Jan 25 SMA-exit check sees
  // yesterday's close 99 > SMA3 regardless of the dip depth (95+dip+99)/3
  // ≤ 96.67 for any dip ≤ 96 → exit fills at Jan 25's open of 100:
  // pnl = (100−95)×52 = +260 whenever the hard stop never fired. The
  // rising tail keeps RSI(2) high so no re-entry ever happens.
  const recoveryTail: Row[] = [
    ["2024-01-24", 95, 99, 95, 99],
    ["2024-01-25", 100, 101, 100, 101],
    ["2024-01-26", 102, 102, 102, 102],
    ["2024-01-29", 103, 103, 103, 103],
    ["2024-01-30", 104, 104, 104, 104],
    ["2024-01-31", 105, 105, 105, 105],
    ["2024-02-01", 106, 106, 106, 106],
    ["2024-02-02", 107, 107, 107, 107],
  ];

  test("price through the fixed 4% stop but NOT the (wider) vol-scaled stop: fixed stops out, volScaled rides to the SMA exit", () => withTmp(async dir => {
    // Jan 23 low 91 = −4.21% from entry 95: breaches the fixed stop at
    // 91.2, but NOT the vol-scaled stop — realized σ(daily) of the warmup
    // closes (11 flat bars then 90→100→98→96) is ≈2.99%, so kσ=2 ≈ 5.98%
    // → stop ≈ 89.3 < 91. Verified against the PRODUCTION formula below,
    // not just hand math.
    const volSpec = { mode: "volScaled" as const, kSigma: 2, lookbackBars: 14, minPct: 1, maxPct: 20 };
    const volPct = trailPctFromVol(WARMUP_CLOSES, volSpec, 1);
    expect(volPct).toBeGreaterThan(4.3); // discrimination is real: low 91 (−4.21%) cannot reach it
    expect(volPct).toBeLessThan(20);     // and it is the σ path, not the clamp

    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 94, 94.5, 91, 94],
      ...recoveryTail,
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });

    const fixed = await runMeanRevReplay(cfgFor(dbPath), WIN); // legacy default: fixed 4%
    expect(fixed!.trades).toBe(1);
    expect(fixed!.closedTrades[0].reason).toBe("STOP_LOSS");
    expect(fixed!.closedTrades[0].pnl).toBeCloseTo((91.2 - 95) * 52, 6); // fill at the stop, −197.6

    const vol = await runMeanRevReplay(cfgFor(dbPath, { hardStop: volSpec }), WIN);
    expect(vol!.trades).toBe(1);
    expect(vol!.closedTrades[0].reason).toBe("SMA_EXIT");
    expect(vol!.closedTrades[0].pnl).toBeCloseTo(260, 6);
    expect(vol!.finalEquity).toBeCloseTo(50_260, 6);
  }));

  test("viceversa — a tight vol-scaled stop (clamped 2%) stops out where fixed 4% holds", () => withTmp(async dir => {
    // Jan 23 low 92.5 = −2.63%: breaches the pinned 2% vol stop at 93.1
    // (min=max clamp, same pinning pattern as MomentumEngine.test.ts) but
    // not the fixed 4% stop at 91.2.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 94, 94.5, 92.5, 94],
      ...recoveryTail,
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });

    const vol = await runMeanRevReplay(cfgFor(dbPath, { hardStop: { mode: "volScaled", kSigma: 3, lookbackBars: 14, minPct: 2, maxPct: 2 } }), WIN);
    expect(vol!.trades).toBe(1);
    expect(vol!.closedTrades[0].reason).toBe("STOP_LOSS");
    expect(vol!.closedTrades[0].pnl).toBeCloseTo((93.1 - 95) * 52, 6); // −98.8

    const fixed = await runMeanRevReplay(cfgFor(dbPath), WIN);
    expect(fixed!.trades).toBe(1);
    expect(fixed!.closedTrades[0].reason).toBe("SMA_EXIT");
    expect(fixed!.closedTrades[0].pnl).toBeCloseTo(260, 6);
  }));

  test("mode none rides a −8.4% intraday excursion to the strategy's own exit; fixed 4% gap-fills at the open", () => withTmp(async dir => {
    // Jan 23 gaps to 90 (open below the 91.2 fixed stop) with low 87.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 90, 91, 87, 91],
      ["2024-01-24", 92, 96, 92, 96],
      ["2024-01-25", 97, 98, 97, 98],
      ["2024-01-26", 99, 99, 99, 99],
      ["2024-01-29", 100, 100, 100, 100],
      ["2024-01-30", 101, 101, 101, 101],
      ["2024-01-31", 102, 102, 102, 102],
      ["2024-02-01", 103, 103, 103, 103],
      ["2024-02-02", 104, 104, 104, 104],
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });

    const none = await runMeanRevReplay(cfgFor(dbPath, { hardStop: { mode: "none" } }), WIN);
    // Jan 25 signal: Jan 24 close 96 > SMA3 (95+91+96)/3 = 94 → exit at
    // Jan 25 open 97. No STOP_LOSS anywhere; drawdown shows the ride.
    expect(none!.trades).toBe(1);
    expect(none!.closedTrades[0].reason).toBe("SMA_EXIT");
    expect(none!.closedTrades[0].pnl).toBeCloseTo((97 - 95) * 52, 6); // +104
    expect(none!.finalEquity).toBeCloseTo(50_104, 6);
    expect(none!.maxDrawdown).toBeCloseTo(((95 - 91) * 52) / 50_000, 9); // Jan 23 close mark

    const fixed = await runMeanRevReplay(cfgFor(dbPath), WIN);
    expect(fixed!.trades).toBe(1);
    expect(fixed!.closedTrades[0].reason).toBe("STOP_LOSS");
    expect(fixed!.closedTrades[0].pnl).toBeCloseTo((90 - 95) * 52, 6); // gap through: fill at the open, −260
  }));

  test("candidate identity: absent hardStop preserves the legacy hash; every mode hashes distinctly", () => withTmp(async dir => {
    const cfg = cfgFor(join(dir, "unused.db"));
    const legacy = hashReplayConfig(cfg);
    expect(hashReplayConfig({ ...cfg, hardStop: undefined })).toBe(legacy); // canonicalJson drops undefined
    const variants: ReplayConfig[] = [
      { ...cfg, hardStop: { mode: "none" } },
      { ...cfg, hardStop: { mode: "fixed", pct: 0.04 } }, // explicit fixed ≠ absent — manifests use ABSENCE for the incumbent
      { ...cfg, hardStop: { mode: "volScaled", kSigma: 2, lookbackBars: 20, minPct: 2, maxPct: 10 } },
      { ...cfg, hardStop: { mode: "volScaled", kSigma: 3, lookbackBars: 20, minPct: 2, maxPct: 10 } },
    ];
    const hashes = new Set(variants.map(hashReplayConfig));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(legacy)).toBe(false);
  }));
});

describe("meanrev replay — live stop timing (gap-through fills at the open BEFORE the day's decisions, 2026-09-25)", () => {
  // Shared BBB tape: first entry signal lands EXACTLY on Jan 23's completed
  // bar (RSI2(−1,−1)=0 < 5; close 117 > SMA5 (90+120+119+118+117)/5=112.8)
  // → BBB is an entry candidate on Jan 24, the day AAA's stop resolves.
  // Jan 24 closes UP (120), so no BBB signal exists afterwards: with
  // maxPositions=1, BBB gets in on Jan 24 or NEVER — a crisp probe for
  // whether AAA's stop freed the slot before or after the day's decisions.
  // (BBB also signals on Jan 22 → the Jan 23 attempt is blocked by AAA's
  // slot; harmless either way.)
  const bbbRows = (): Row[] => [
    ...WARMUP_DATES.slice(0, 13).map(d => [d, 90, 90, 90, 90] as Row), // Jan 1..17 flat
    ["2024-01-18", 120, 120, 120, 120],
    ["2024-01-19", 119, 119, 119, 119],
    ["2024-01-22", 118, 118, 118, 118],
    ["2024-01-23", 117, 117.5, 116.5, 117],
    ["2024-01-24", 116, 121, 116, 120],
    ...flatRows(["2024-01-25", "2024-01-26", "2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"], 120),
  ];
  const cfg2 = (dbPath: string) => cfgFor(dbPath, { universe: ["AAA", "BBB"] });

  test("gap-through: the open crosses the stop → fill AT THE OPEN pre-pass, slot free and equity down for the same day's entries; ClosedTrade carries entryAt/entryPrice/exitPrice/qty", () => withTmp(async dir => {
    // AAA enters Jan 22 at open 95 (qty 52, fixed 4% stop → 91.2).
    // Jan 24: AAA opens 88 < 91.2 → the live GTC stop fires at the OPEN,
    // before the ~09:35 pass — the pass must see the slot free and enter BBB
    // at Jan 24's open 116 (qty floor(5000/116) = 43).
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 95, 95.5, 94, 95],
      ["2024-01-24", 88, 89, 87, 88],
      ...flatRows(["2024-01-25", "2024-01-26", "2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"], 88),
    ];
    const dbPath = makeDb(dir, { AAA: aaa, BBB: bbbRows(), REF: refRows() });

    const r = await runMeanRevReplay(cfg2(dbPath), WIN);
    const stop = r!.closedTrades.find(t => t.symbol === "AAA")!;
    expect(stop.reason).toBe("STOP_LOSS");
    expect(stop.pnl).toBeCloseTo((88 - 95) * 52, 6); // fill at the open, not at 91.2
    // Instrumentation (R1 audit): the sim adapter now fills the optional
    // ClosedTrade metadata the momentum SimBroker always had.
    expect(stop.entryAt).toBe(Date.parse("2024-01-22T05:00:00Z"));
    expect(stop.entryPrice).toBeCloseTo(95, 9);
    expect(stop.exitPrice).toBeCloseTo(88, 9);
    expect(stop.qty).toBe(52);
    expect(stop.exitAt).toBe(Date.parse("2024-01-24T05:00:00Z"));

    // THE fidelity assertion: BBB entered ON the gap day (old ordering
    // evaluated stops after runDaily → slot still occupied → BBB never
    // trades, since its only signal bar is Jan 23).
    const bbb = r!.closedTrades.find(t => t.symbol === "BBB")!;
    expect(bbb).toBeDefined();
    expect(bbb.entryAt).toBe(Date.parse("2024-01-24T05:00:00Z"));
    expect(bbb.entryPrice).toBeCloseTo(116, 9);
    expect(bbb.qty).toBe(43);
    // Jan 25 pass: Jan 24 close 120 > SMA3 (118+117+120)/3 → SMA_EXIT at
    // Jan 25 open 120.
    expect(bbb.reason).toBe("SMA_EXIT");
    expect(bbb.pnl).toBeCloseTo((120 - 116) * 43, 6);
    expect(r!.trades).toBe(2);
  }));

  test("intraday stop (open above the level): still evaluated AFTER the pass — the slot is NOT free for that day's entries; fill at the stop level", () => withTmp(async dir => {
    // Same setup, but Jan 24 AAA opens 92 (> 91.2) and only trades through
    // the stop intraday (low 88). At pass time (~09:35) AAA is still held:
    // BBB's only candidacy (Jan 23 signal) is blocked → BBB never trades.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 95, 95.5, 94, 95],
      ["2024-01-24", 92, 93, 88, 89],
      ...flatRows(["2024-01-25", "2024-01-26", "2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"], 89),
    ];
    const dbPath = makeDb(dir, { AAA: aaa, BBB: bbbRows(), REF: refRows() });

    const r = await runMeanRevReplay(cfg2(dbPath), WIN);
    expect(r!.trades).toBe(1);
    const stop = r!.closedTrades[0];
    expect(stop.symbol).toBe("AAA");
    expect(stop.reason).toBe("STOP_LOSS");
    expect(stop.exitPrice).toBeCloseTo(95 * 0.96, 9); // intraday fill at the level
    expect(stop.pnl).toBeCloseTo((95 * 0.96 - 95) * 52, 6);
    expect(r!.closedTrades.some(t => t.symbol === "BBB")).toBe(false);
  }));

  test("RiskGuard sees a pre-pass gap stop exactly once (no double count across the cursor)", () => withTmp(async dir => {
    // Loss-streak accounting: the gap stop's realized loss is read by the
    // SAME day's pass (anchor = yesterday) and must NOT be re-read by the
    // next day's pass (anchor = today == exitAt, `>=` would re-match it).
    // consecutiveLosses ends at 1, not 2 — via the engine's final RiskState.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 95, 95.5, 94, 95],
      ["2024-01-24", 88, 89, 87, 88],
      ...flatRows(["2024-01-25", "2024-01-26", "2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"], 88),
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });
    const r = await runMeanRevReplay(cfgFor(dbPath), WIN);
    expect(r!.trades).toBe(1);
    expect(r!.closedTrades[0].reason).toBe("STOP_LOSS");
    expect((r!.finalRiskState as any).consecutiveLosses).toBe(1);
  }));
});

describe("meanrev replay — RSI2 audit passthrough (rsiMethod/deterministicTieBreak, opt-in)", () => {
  test('rsiMethod: "wilder" reaches the real engine and can flip an entry that Cutler fires on', () => withTmp(async dir => {
    // Same tape as the baseline SMA-exit test above. Cutler RSI(2) looks
    // only at the LAST two closes (98→96, both down) → ties to exactly 0 <
    // 5, entry fires (see the first test in this file: trades=1). Wilder's
    // recursive smoothing (n=2, 0.5 decay/bar) carries the whole prior
    // warmup: 12 flat bars seed avgG=avgL=0, then Δ=+10 (90→100), Δ=-2,
    // Δ=-2 → avgG 0→5→2.5→1.25, avgL 0→0→1→1.5 → RSI=100·1.25/2.75≈45.45,
    // NOT < entryRsi(5) → no entry at all. This is the audited bug in
    // action: the SAME data signals under the mislabeled "Wilder" (Cutler)
    // math and does not under the real Wilder recursion.
    const aaa: Row[] = [
      ...warmupRows(),
      ["2024-01-22", 95, 96, 94.5, 95],
      ["2024-01-23", 96, 99, 95, 99],
      ["2024-01-24", 100, 101, 100, 101],
      ["2024-01-25", 102, 102, 102, 102],
      ["2024-01-26", 103, 103, 103, 103],
      ["2024-01-29", 104, 104, 104, 104],
      ["2024-01-30", 105, 105, 105, 105],
      ["2024-01-31", 106, 106, 106, 106],
      ["2024-02-01", 107, 107, 107, 107],
      ["2024-02-02", 108, 108, 108, 108],
    ];
    const dbPath = makeDb(dir, { AAA: aaa, REF: refRows() });

    const cutler = await runMeanRevReplay(cfgFor(dbPath), WIN); // rsiMethod absent = legacy Cutler, unchanged
    expect(cutler!.trades).toBe(1);

    const wilder = await runMeanRevReplay(cfgFor(dbPath, {}, { rsiMethod: "wilder" }), WIN);
    expect(wilder!.trades).toBe(0);
    expect(wilder!.finalEquity).toBeCloseTo(50_000, 6);
  }));

  test("candidate identity: absent rsiMethod/deterministicTieBreak preserve the legacy hash; setting either changes it", () => withTmp(async dir => {
    const cfg = cfgFor(join(dir, "unused.db"));
    const legacy = hashReplayConfig(cfg);
    // Explicit undefined (canonicalJson drops it, same convention the
    // hardStop test above uses) preserves the legacy hash.
    expect(hashReplayConfig({ ...cfg, meanrev: { ...cfg.meanrev!, rsiMethod: undefined } })).toBe(legacy);
    expect(hashReplayConfig({ ...cfg, meanrev: { ...cfg.meanrev!, deterministicTieBreak: undefined } })).toBe(legacy);

    const wilderHash = hashReplayConfig({ ...cfg, meanrev: { ...cfg.meanrev!, rsiMethod: "wilder" } });
    const tieBreakHash = hashReplayConfig({ ...cfg, meanrev: { ...cfg.meanrev!, deterministicTieBreak: true } });
    const cutlerExplicitHash = hashReplayConfig({ ...cfg, meanrev: { ...cfg.meanrev!, rsiMethod: "cutler" } });

    expect(wilderHash).not.toBe(legacy);
    expect(tieBreakHash).not.toBe(legacy);
    expect(cutlerExplicitHash).not.toBe(legacy); // explicit "cutler" ≠ absent — same convention as hardStop's explicit "fixed"
    expect(new Set([legacy, wilderHash, tieBreakHash, cutlerExplicitHash]).size).toBe(4);
  }));
});
