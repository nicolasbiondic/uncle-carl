// ═══════════════════════════════════════════════════════════════════════
// Línea F (2026-10-10): PIT monthly perp membership on the momentum replay
// (ReplayConfig.perpsMembership — docs/reports/LF-cripto-tendencia-alts.md).
// Locks the opt-in axis: absent = byte-identical legacy (hash identity),
// present = line-A universe semantics on the REAL MomentumEngine:
//   - only current-month members with warmup + a fresh (≤24h) bar may ENTER;
//   - a held position whose tape goes silent 24h force-closes at its last
//     close with reason "DELISTED";
//   - funding fail-closed coverage is scoped to each symbol's bar span
//     (mid-window listings must not throw).
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashReplayConfig, runWithConfig, PERPS_STALE_CLOSE_MS, type ReplayConfig } from "./backtest-momentum-wf";
import { validateManifest, candidateToReplayConfig, type ExperimentManifest } from "./walk-forward";

setDefaultTimeout(120_000);

const H = 3_600_000;
const SRC = "binance_vision_um";
const PM = { topN: 2, volLookbackDays: 30, minDays: 5, freshDays: 3 };

/** Hourly ramp: +0.3%/bar from `startMs` to `endMs` (exclusive). TSM with
 *  lookbackDays 2 sees ≈ +15% over 48 bars (≫ entry +5%), price above MA3d. */
function insertRamp(db: Database, symbol: string, startMs: number, endMs: number, p0 = 100): void {
  const stmt = db.prepare("INSERT INTO historical_bars VALUES (?,?,?,?,?,?,?,?,?)");
  let px = p0;
  for (let t = startMs; t < endMs; t += H) {
    stmt.run(symbol, "1h", SRC, t, px, px * 1.001, px * 0.999, px, 1000);
    px *= 1.003;
  }
}
function insertFunding(db: Database, symbol: string, startMs: number, endMs: number): void {
  const stmt = db.prepare("INSERT INTO funding_rates VALUES (?,?,?)");
  for (let t = startMs; t <= endMs; t += 8 * H) stmt.run(symbol, t, 0.0001);
}
function insertVolume(db: Database, symbol: string, startMs: number, endMs: number, qv: number): void {
  const stmt = db.prepare("INSERT INTO quote_volume_1d VALUES (?,?,?)");
  for (let t = startMs; t < endMs; t += 86_400_000) stmt.run(symbol, t, qv);
}

const DEC25 = Date.parse("2023-12-25T00:00:00Z");
const DEC01 = Date.parse("2023-12-01T00:00:00Z");
const JAN20 = Date.parse("2024-01-20T00:00:00Z");
const FEB01 = Date.parse("2024-02-01T00:00:00Z");
const FEB20 = Date.parse("2024-02-20T00:00:00Z");
/** DDD's tape stops here (last bar 11:00, bar END 12:00). */
const DDD_LAST_END = Date.parse("2024-01-15T12:00:00Z");
const WIN = { label: "t", from: "2024-01-10T00:00:00Z", to: "2024-02-20T00:00:00Z" };

/** AAA: member Jan+Feb. BBB: LISTED mid-window (Jan 20), member Feb only.
 *  DDD: member Jan, tape dies Jan 15 while held. */
function makeDb(dir: string): string {
  const dbPath = join(dir, "perps.db");
  const db = new Database(dbPath);
  try {
    db.run(`CREATE TABLE historical_bars (
      symbol TEXT, timeframe TEXT, source TEXT, timestamp INTEGER,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      PRIMARY KEY(symbol, timeframe, source, timestamp)
    )`);
    db.run("CREATE TABLE funding_rates (symbol TEXT, funding_time INTEGER, rate REAL, PRIMARY KEY(symbol, funding_time))");
    db.run("CREATE TABLE quote_volume_1d (symbol TEXT, timestamp INTEGER, quote_volume REAL, PRIMARY KEY(symbol, timestamp))");
    insertRamp(db, "AAAUSDT", DEC25, FEB20);
    insertFunding(db, "AAAUSDT", DEC25, FEB20);
    insertVolume(db, "AAAUSDT", DEC01, FEB20, 9e9);
    insertRamp(db, "BBBUSDT", JAN20, FEB20);
    insertFunding(db, "BBBUSDT", JAN20, FEB20);
    insertVolume(db, "BBBUSDT", JAN20, FEB20, 8e9);
    insertRamp(db, "DDDUSDT", DEC25, DDD_LAST_END);
    insertFunding(db, "DDDUSDT", DEC25, DDD_LAST_END + 4 * H);
    insertVolume(db, "DDDUSDT", DEC01, DDD_LAST_END, 7e9);
  } finally {
    db.close();
  }
  return dbPath;
}

function cfgFor(dbPath: string, overrides: Partial<ReplayConfig> = {}): ReplayConfig {
  return {
    sleeve: "crypto",
    universe: ["AAAUSDT", "BBBUSDT", "DDDUSDT"],
    timeframe: "1h",
    source: SRC,
    refSymbol: "AAAUSDT",
    rthOnly: false,
    funding: true,
    barMinutes: 60,
    barMinutesEq: 60,
    slippageBps: 5,
    commissionBps: 4,
    initialEquity: 5000,
    leverage: 2,
    hardStopPct: 0.04,
    cadenceMin: 60,
    notionalPctPerSlot: 0.2,
    entryPct: 5,
    exitPct: -2,
    maxLongs: 3,
    maxShorts: 0,
    // Short horizon keeps the fixture small: minWarmupBars = (3+1)*24+10.
    lookbackDays: 2,
    maLengthDays: 3,
    regime: { enabled: false },
    shortFunding: "credit",
    warmupDays: 10,
    dbPath,
    ...overrides,
  };
}
function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "perps-membership-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("momentum replay — PIT monthly perp membership (línea F axis)", () => {
  test("config identity: absent perpsMembership preserves the legacy hash; setting it changes it", () => withTmp(async dir => {
    const cfg = cfgFor(join(dir, "unused.db"));
    const legacy = hashReplayConfig(cfg);
    expect(hashReplayConfig({ ...cfg, perpsMembership: undefined })).toBe(legacy); // canonicalJson drops undefined
    expect(hashReplayConfig({ ...cfg, perpsMembership: PM })).not.toBe(legacy);
  }));

  test("membership gates ENTRIES by month, warmup and freshness; stale 24h tape force-closes as DELISTED; mid-window listing doesn't trip funding fail-closed", () => withTmp(async dir => {
    const dbPath = makeDb(dir);
    const r = await runWithConfig(cfgFor(dbPath, { perpsMembership: PM }), WIN);
    expect(r).not.toBeNull();

    const all = [...r!.closedTrades];
    const bySym = (s: string) => all.filter(t => t.symbol === s);

    // AAA: member from Jan 1 with full warmup — trades from the window start.
    expect(bySym("AAAUSDT").length).toBeGreaterThan(0);

    // BBB: listed Jan 20, member only from Feb 1 — NO entry before Feb 1
    // (neither the listing date nor the warmup bound lets it in earlier),
    // and it DOES trade once member (ramp keeps signalling).
    const bbb = bySym("BBBUSDT");
    expect(bbb.length).toBeGreaterThan(0); // funding fail-closed would have thrown before any trade
    for (const t of bbb) expect(t.entryAt).toBeGreaterThanOrEqual(FEB01);

    // DDD: held when its tape dies Jan 15 — force-closed at last close +24h
    // with the line-A reason; never re-enters (freshness gate).
    const ddd = bySym("DDDUSDT");
    expect(ddd.length).toBeGreaterThan(0);
    const last = ddd[ddd.length - 1];
    expect(last.reason).toBe("DELISTED");
    expect(last.exitAt).toBeGreaterThanOrEqual(DDD_LAST_END + PERPS_STALE_CLOSE_MS);
    expect(last.exitAt).toBeLessThanOrEqual(DDD_LAST_END + PERPS_STALE_CLOSE_MS + H);
    for (const t of ddd) expect(t.entryAt).toBeLessThan(DDD_LAST_END);
  }));

  test("validateManifest: accepts data.perpsMembership on crypto+funding; rejects wrong sleeves/shapes; candidateToReplayConfig forwards it", () => {
    const base = {
      name: "t", sleeve: "crypto", description: "", trialAccounting: { priorUniqueTrials: 0, complete: false },
      // refSymbol benchmark-only in this mode (BTC is excluded from the
      // tradable universe by the disjoint-pool rule) — must NOT be declared.
      data: { dbPath: "x.db", source: SRC, timeframe: "1h", universe: ["AAAUSDT"], refSymbol: "BTCUSDT", rthOnly: false, funding: true, barMinutes: 60, barMinutesEq: 60, perpsMembership: PM },
      asOf: "2024-02-20T00:00:00Z", window: { from: "2024-01-01", to: "2024-02-20", outerFoldCount: 3, innerFoldCount: 2, purgeYears: 0, warmupDays: 10 },
      costs: { base: { slippageBps: 5, commissionBps: 4 }, stress: { slippageBps: 10, commissionBps: 8 } },
      ledger: { initialEquity: 5000, leverage: 2, hardStopPct: 0.04 },
      candidates: [{ name: "c", cadenceMin: 60, entryPct: 5, exitPct: -2, maxLongs: 4, maxShorts: 0 }],
      acceptance: { minSharpe: 0, maxDrawdown: 1, minTotalReturn: -1, maxConcentration: 1, minTrades: 0, stressMinSharpe: -1, stressMaxDrawdown: 1, stressMinTotalReturn: -1, looMinSharpe: -1, looMaxDrawdown: 1, looMinTotalReturn: -1 },
    } as unknown as ExperimentManifest;
    expect(() => validateManifest(structuredClone(base))).not.toThrow();
    const rc = candidateToReplayConfig(base, base.candidates[0], "base");
    expect(rc.perpsMembership).toEqual(PM);

    const noFunding = structuredClone(base); (noFunding.data as any).funding = false;
    expect(() => validateManifest(noFunding)).toThrow(/funding/);
    const badShape = structuredClone(base); (badShape.data as any).perpsMembership = { topN: 30 };
    expect(() => validateManifest(badShape)).toThrow(/perpsMembership/);
    const stocks = structuredClone(base); (stocks as any).sleeve = "stocks"; (stocks.data as any).funding = false;
    expect(() => validateManifest(stocks)).toThrow(/crypto/);
  });
});
