// ═══════════════════════════════════════════════════════════════════════
// Reg-T financing on the meanrev replay (línea E, 2026-10-09 —
// docs/reports/LE-exposicion.md). SimMeanRevBroker.accrueMarginInterest
// mirrors the momentum SimBroker's documented semantics: debit = marked
// gross book − equity (decision-time marks), charged annualRate/365 per
// CALENDAR day via UTC-midnight crossings (Fri→Mon = 3 days), accrued at
// the pre-pass point so RiskGuard's equity read includes it. Absent
// costs.<tier>.marginInterest = strict no-op, byte-identical legacy.
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMeanRevReplay } from "./meanrev-replay";
import { hashReplayConfig, type ReplayConfig } from "./backtest-momentum-wf";
import { validateManifest, type ExperimentManifest } from "./walk-forward";

setDefaultTimeout(30_000);

// Fixture conventions copied from scripts/meanrev-replay.test.ts (same
// calendar; same hand-computed entry: RSI2=0 < 5 on the Jan 19 signal bar,
// close 96 > SMA5 94.8 → buy at Jan 22's open 95).
type Row = [date: string, open: number, high: number, low: number, close: number];
const WARMUP_DATES = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", "2024-01-15", "2024-01-16", "2024-01-17", "2024-01-18", "2024-01-19"];
const WINDOW_DATES = ["2024-01-22", "2024-01-23", "2024-01-24", "2024-01-25", "2024-01-26", "2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"];
const WARMUP_CLOSES = [90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 100, 98, 96];
const WIN = { label: "t", from: "2024-01-20", to: "2024-02-03" };

function warmupRows(): Row[] {
  return WARMUP_DATES.map((d, i) => [d, WARMUP_CLOSES[i], WARMUP_CLOSES[i], WARMUP_CLOSES[i], WARMUP_CLOSES[i]] as Row);
}
/** Entry Jan 22 at open 95, then a FLAT 95 tape: close 95 is never > SMA3
 *  (all 95s), RSI2 ties don't re-signal while held, the 4% stop (91.2) never
 *  prints, timeStop 10 trading days lands past the window — the position
 *  rides to fold_end, accruing financing over 9 passes = 11 calendar days
 *  (Jan 26 Fri → Jan 29 Mon crosses 3 UTC midnights). */
function flatHoldTape(): Row[] {
  return [...warmupRows(), ...WINDOW_DATES.map(d => [d, 95, 95.5, 94.8, 95] as Row)];
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
function cfgFor(dbPath: string, overrides: Partial<ReplayConfig> = {}): ReplayConfig {
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
    // slotPct 1.2 → the single $60k slot BORROWS ~$10k against the $50k base
    // (that is the point: financing only bites when gross > equity).
    meanrev: { entryRsi: 5, smaLong: 5, smaExit: 3, timeStopDays: 10, maxPositions: 1, slotPct: 1.2 },
    warmupDays: 22,
    dbPath,
    ...overrides,
  };
}
function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meanrev-margin-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const REF: Row[] = [...WARMUP_DATES, ...WINDOW_DATES].map(d => [d, 50, 50, 50, 50] as Row);

describe("meanrev replay — Reg-T margin interest (costs.marginInterest passthrough)", () => {
  test("charges debit × rate/365 per UTC calendar day (Fri→Mon = 3), compounding into the debit; absent = strict no-op", () => withTmp(async dir => {
    const dbPath = makeDb(dir, { AAA: flatHoldTape(), REF });
    const rate = 0.065;

    const legacy = await runMeanRevReplay(cfgFor(dbPath), WIN);
    expect(legacy!.marginInterest ?? 0).toBe(0);

    const financed = await runMeanRevReplay(cfgFor(dbPath, { marginInterest: { annualRate: rate } }), WIN);

    // Hand computation. qty = floor(60,000 / 95) = 631 shares at entry 95;
    // flat marks → unrealized 0, so equity = 50,000 − accrued and debit =
    // 631×95 − equity = 9,945 + accrued (the charges themselves are
    // financed). Pre-pass accrual on each window date after entry; calendar
    // day gaps Jan 23..Feb 2: [1,1,1,1,3,1,1,1,1] (the 3 is Fri 26 → Mon 29).
    const qty = Math.floor(60_000 / 95);
    expect(qty).toBe(631);
    const gross = qty * 95;
    let accrued = 0;
    for (const days of [1, 1, 1, 1, 3, 1, 1, 1, 1]) {
      const debit = gross - (50_000 - accrued);
      accrued += debit * (rate / 365) * days;
    }
    expect(financed!.marginInterest).toBeCloseTo(accrued, 8);
    // fold_end liquidation at the flat 95 → gross P&L 0; the ONLY difference
    // from the legacy run is the financing drain.
    expect(financed!.finalEquity).toBeCloseTo(legacy!.finalEquity - accrued, 8);
    expect(financed!.finalEquity).toBeCloseTo(50_000 - accrued, 8);
  }));

  test("config identity: absent marginInterest preserves the legacy hash; setting it changes it", () => withTmp(async dir => {
    const cfg = cfgFor(join(dir, "unused.db"));
    const legacy = hashReplayConfig(cfg);
    expect(hashReplayConfig({ ...cfg, marginInterest: undefined })).toBe(legacy); // canonicalJson drops undefined
    expect(hashReplayConfig({ ...cfg, marginInterest: { annualRate: 0.065 } })).not.toBe(legacy);
  }));

  test("validateManifest accepts costs.marginInterest on meanrev manifests (the runner models financing since 2026-10-09)", () => {
    const m = {
      name: "t", sleeve: "meanrev", description: "", trialAccounting: { priorUniqueTrials: 0, complete: false },
      data: { dbPath: "x.db", source: "alpaca_wide", timeframe: "1d", universe: ["AAA"], refSymbol: "REF", rthOnly: false, funding: false, barMinutes: 1440, barMinutesEq: 1440 },
      asOf: "2024-02-03", window: { from: "2024-01-01", to: "2024-02-03", outerFoldCount: 3, innerFoldCount: 2, purgeYears: 0, warmupDays: 22 },
      costs: {
        base: { slippageBps: 0, commissionBps: 0, marginInterest: { annualRate: 0.065 } },
        stress: { slippageBps: 5, commissionBps: 2, marginInterest: { annualRate: 0.065 } },
      },
      ledger: { initialEquity: 50_000, leverage: 1, hardStopPct: 0.04 },
      candidates: [{ name: "c", cadenceMin: 1440, meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 7, slotPct: 0.12 } }],
      acceptance: { minSharpe: 0, maxDrawdown: 1, minTotalReturn: -1, maxConcentration: 1, minTrades: 0, stressMinSharpe: -1, stressMaxDrawdown: 1, stressMinTotalReturn: -1, looMinSharpe: -1, looMaxDrawdown: 1, looMinTotalReturn: -1 },
    } as unknown as ExperimentManifest;
    expect(() => validateManifest(m)).not.toThrow();
    // Bounds still enforced (7.5 percent-units would be a 750%/yr typo).
    (m as any).costs.base.marginInterest = { annualRate: 6.5 };
    expect(() => validateManifest(m)).toThrow(/fraction/);
  });
});
