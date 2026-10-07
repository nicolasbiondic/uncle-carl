// ═══════════════════════════════════════════════════════════════════════
// Gross-exposure cap passthrough on the meanrev replay (G batch,
// 2026-10-05 — docs/reports/G-gross-cap.md).
//
// Live meanrev_stocks runs MeanRevEngineConfig.maxGrossExposureMult = 0.84
// (src/index.ts) but the authoritative chains never carried the key: the
// meanrev runner silently lacked the passthrough and walk-forward.ts
// FORBADE it on meanrev candidates ("config that changes nothing"). These
// tests lock the minimal scripts-only passthrough added for the gross-cap
// fidelity diagnostic: ReplayConfig.maxGrossExposureMult now reaches the
// real MeanRevEngine (cap = baseUsd × mult, the live semantics), absence
// stays byte-identical legacy (hash and behavior).
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMeanRevReplay } from "./meanrev-replay";
import { hashReplayConfig, type ReplayConfig } from "./backtest-momentum-wf";
import { validateCandidate, candidateToReplayConfig, type CandidateConfig, type ExperimentManifest } from "./walk-forward";

setDefaultTimeout(30_000);

// Fixture conventions copied from scripts/meanrev-replay.test.ts (same
// calendar, same hand-computed entry: RSI2=0 < 5 on the Jan 19 signal bar,
// close 96 > SMA5 94.8 → buy at Jan 22's open 95).
type Row = [date: string, open: number, high: number, low: number, close: number];
const WARMUP_DATES = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", "2024-01-15", "2024-01-16", "2024-01-17", "2024-01-18", "2024-01-19"];
const WINDOW_DATES = ["2024-01-22", "2024-01-23", "2024-01-24", "2024-01-25", "2024-01-26", "2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"];
const ALL_DATES = [...WARMUP_DATES, ...WINDOW_DATES];
const WARMUP_CLOSES = [90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 100, 98, 96];
const WIN = { label: "t", from: "2024-01-20", to: "2024-02-03" };

function warmupRows(): Row[] {
  return WARMUP_DATES.map((d, i) => [d, WARMUP_CLOSES[i], WARMUP_CLOSES[i], WARMUP_CLOSES[i], WARMUP_CLOSES[i]] as Row);
}
function flatRows(dates: string[], px: number): Row[] {
  return dates.map(d => [d, px, px, px, px] as Row);
}
function refRows(): Row[] {
  return [...flatRows(ALL_DATES.slice(0, -1), 50), ["2024-02-02", 55, 55, 55, 55] as Row];
}
/** The baseline entry tape: enters Jan 22 at 95, SMA-exits Jan 24 at 100. */
function entryTape(): Row[] {
  return [
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
    universe: ["AAA", "BBB"],
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
    meanrev: { entryRsi: 5, smaLong: 5, smaExit: 3, timeStopDays: 10, maxPositions: 2, slotPct: 0.1 },
    warmupDays: 22,
    dbPath,
    ...overrides,
  };
}
function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meanrev-grosscap-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("meanrev replay — gross-exposure cap passthrough (live backstop semantics)", () => {
  test("cap reaches the real engine: the second same-day entry is BLOCKED at baseUsd × mult, absent cap admits both", () => withTmp(async dir => {
    // AAA and BBB carry IDENTICAL tapes → both signal on Jan 19's bar (RSI
    // tie at 0; stable sort keeps universe order AAA, BBB). Slot = 50 000 ×
    // 0.1 = $5 000 each. Cap 0.15 × 50 000 = $7 500: AAA enters (0 + 5 000
    // ≤ 7 500), BBB is vetoed by the ENGINE's own gross-cap branch (5 000 +
    // 5 000 > 7 500 — the engine books slot notional, not floored shares).
    const dbPath = makeDb(dir, { AAA: entryTape(), BBB: entryTape(), REF: refRows() });

    const uncapped = await runMeanRevReplay(cfgFor(dbPath), WIN);
    expect(uncapped!.trades).toBe(2); // both SMA-exit on Jan 24

    const capped = await runMeanRevReplay(cfgFor(dbPath, { maxGrossExposureMult: 0.15 }), WIN);
    expect(capped!.trades).toBe(1);
    expect(capped!.closedTrades[0].symbol).toBe("AAA");
    // Blocked entry is a policy veto, not a sim failure: the chain completes.
    expect(capped!.ruined).toBe(false);

    // A cap that the book never reaches changes nothing (live claim
    // "backstop never binds at validated sizing" — here 2×0.1 = 0.2 < 0.84).
    const slack = await runMeanRevReplay(cfgFor(dbPath, { maxGrossExposureMult: 0.84 }), WIN);
    expect(slack!.trades).toBe(2);
    expect(slack!.finalEquity).toBeCloseTo(uncapped!.finalEquity, 6);
  }));

  test("candidate identity: absent maxGrossExposureMult preserves the legacy hash; setting it changes it", () => withTmp(async dir => {
    const cfg = cfgFor(join(dir, "unused.db"));
    const legacy = hashReplayConfig(cfg);
    expect(hashReplayConfig({ ...cfg, maxGrossExposureMult: undefined })).toBe(legacy); // canonicalJson drops undefined
    expect(hashReplayConfig({ ...cfg, maxGrossExposureMult: 0.84 })).not.toBe(legacy);
  }));

  test("walk-forward accepts maxGrossExposureMult on meanrev candidates and forwards it; other momentum-only keys stay forbidden", () => {
    const candidate: CandidateConfig = {
      name: "slot12-cap084",
      cadenceMin: 1440,
      maxGrossExposureMult: 0.84,
      meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 7, slotPct: 0.12 },
    };
    expect(() => validateCandidate(candidate)).not.toThrow();
    // Still rejected: a momentum-only key that the meanrev runner ignores.
    expect(() => validateCandidate({ ...candidate, slotHysteresis: true } as CandidateConfig)).toThrow(/momentum-only/);

    const m = {
      name: "t", sleeve: "meanrev", description: "", trialAccounting: { priorUniqueTrials: 0, complete: false },
      data: { dbPath: "x.db", source: "alpaca_wide", timeframe: "1d", universe: ["AAA"], refSymbol: "REF", rthOnly: false, funding: false, barMinutes: 1440, barMinutesEq: 1440 },
      asOf: "2024-02-03", window: { from: "2024-01-01", to: "2024-02-03", outerFoldCount: 1, innerFoldCount: 1, purgeYears: 0, warmupDays: 22 },
      costs: { base: { slippageBps: 0, commissionBps: 0 }, stress: { slippageBps: 5, commissionBps: 2 } },
      ledger: { initialEquity: 50_000, leverage: 1, hardStopPct: 0.04 },
      candidates: [candidate],
      acceptance: { minSharpe: 0, maxDrawdown: 1, minTotalReturn: -1, maxConcentration: 1, minTrades: 0, stressMinSharpe: -1, stressMaxDrawdown: 1, stressMinTotalReturn: -1, looMinSharpe: -1, looMaxDrawdown: 1, looMinTotalReturn: -1 },
    } as unknown as ExperimentManifest;
    const rc = candidateToReplayConfig(m, candidate, "base");
    expect(rc.maxGrossExposureMult).toBe(0.84);
  });
});
