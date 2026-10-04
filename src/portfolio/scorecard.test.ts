// ══════════════════════════════════════════════
// Scorecard tests — synthetic series with hand-computed metrics, a
// DETERMINISTIC bootstrap, band classification, missing-artifact fallback,
// and the "readers never write" guarantee (the whole scorecard runs against
// a READONLY connection). NO dependency on data/backtests artifacts — the
// band tests build their own fixture artifact in a temp dir.
// ══════════════════════════════════════════════

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// require("fs") dodges bun-types' fs shim, which omits rmSync (same
// workaround as src/utils/version.test.ts).
const rmSync = (p: string, o: any) => { try { require("fs").rmSync(p, o); } catch {} };
import {
  SCORECARD_ENTITIES, MODEL_START, type ScorecardEntityDef,
  readDailyMarks, readTrades, marksToDailyReturns, maxDrawdown, olsAlphaBeta,
  percentile, mulberry32, blockBootstrapBand, classifyBand,
  loadOosDailyReturns, clearArtifactCache, computeExpectationBand,
  computeWindowMetrics, computeScorecard, bandEpisodeTransitions,
  formatScorecardDigestLines, type DailyMark, type ScorecardWindowMetrics,
  SELECTION_BIAS_HAIRCUT, selectionBiasDrift, expectationBandReadings,
} from "./scorecard";

// ── Fixture DB (standalone minimal schema — never the app's global handle) ──

function makeDb(path = ":memory:"): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE equity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, equity REAL,
      cash REAL, open_positions INTEGER, snapshot_time INTEGER,
      semantics INTEGER, synthetic INTEGER DEFAULT 0);
    CREATE TABLE trades (
      id TEXT PRIMARY KEY, account_id TEXT, entry_price REAL, quantity REAL,
      entry_time INTEGER, exit_time INTEGER, status TEXT, pnl REAL);
  `);
  return db;
}

function snap(db: Database, profile: string, equity: number, time: number, semantics = 5, synthetic = 0): void {
  db.prepare(`INSERT INTO equity_snapshots (profile_id, equity, cash, open_positions, snapshot_time, semantics, synthetic) VALUES (?,?,0,0,?,?,?)`)
    .run(profile, equity, time, semantics, synthetic);
}

/** ms of `key`T21:00Z — 16/17h ET (after the stock close, same ET date) and
 *  21:00 UTC (same UTC date): one timestamp valid on BOTH grids. */
function dayMs(key: string): number {
  return Date.parse(`${key}T21:00:00Z`);
}

const STOCKS: ScorecardEntityDef = SCORECARD_ENTITIES.find(e => e.id === "momentum_stocks")!;
const CRYPTO: ScorecardEntityDef = SCORECARD_ENTITIES.find(e => e.id === "momentum_crypto")!;

// Mon..Fri sequences around the v8 window (all past dates vs `NOW`).
const NOW = Date.parse("2026-09-20T12:00:00Z");

// ── Daily marks reader ──────────────────────────────────────────────────

describe("readDailyMarks", () => {
  test("last snapshot per day wins; semantics≠5, synthetic and current day excluded; weekends dropped on the trading grid", () => {
    const db = makeDb();
    // Fri 2026-09-11: two snapshots — last one (105) must win.
    snap(db, "momentum_stocks", 100, Date.parse("2026-09-11T15:00:00Z"));
    snap(db, "momentum_stocks", 105, Date.parse("2026-09-11T20:30:00Z"));
    // Sat 2026-09-12: weekend — dropped on the trading grid.
    snap(db, "momentum_stocks", 999, dayMs("2026-09-12"));
    // Mon 2026-09-14: kept. Wrong-era + synthetic rows same day: excluded.
    snap(db, "momentum_stocks", 110, dayMs("2026-09-14"));
    snap(db, "momentum_stocks", 500, dayMs("2026-09-14") + 60_000, 2);      // semantics 2
    snap(db, "momentum_stocks", 501, dayMs("2026-09-14") + 120_000, 5, 1);  // synthetic
    // "today" (NOW's ET date 2026-09-20 is a Sunday; use Fri 18th as today for this check)
    const now = Date.parse("2026-09-18T15:00:00Z");
    snap(db, "momentum_stocks", 111, Date.parse("2026-09-18T14:00:00Z"));    // current day — excluded
    const marks = readDailyMarks(db, "momentum_stocks", "trading_days", now);
    expect(marks.map(m => [m.dateKey, m.equity])).toEqual([["2026-09-11", 105], ["2026-09-14", 110]]);
  });

  test("calendar grid keys by UTC date and keeps weekends", () => {
    const db = makeDb();
    snap(db, "momentum_crypto", 100, dayMs("2026-09-12")); // Saturday — kept
    snap(db, "momentum_crypto", 101, dayMs("2026-09-13"));
    const marks = readDailyMarks(db, "momentum_crypto", "calendar_days", NOW);
    expect(marks.map(m => m.dateKey)).toEqual(["2026-09-12", "2026-09-13"]);
  });
});

describe("marksToDailyReturns", () => {
  test("adjacent grid days only — a multi-day delta is not a daily return", () => {
    const marks: DailyMark[] = [
      { dateKey: "2026-09-10", equity: 100, snapshotTime: dayMs("2026-09-10") }, // Thu
      { dateKey: "2026-09-11", equity: 102, snapshotTime: dayMs("2026-09-11") }, // Fri: +2%
      { dateKey: "2026-09-15", equity: 110, snapshotTime: dayMs("2026-09-15") }, // Tue: Mon missing → gap, dropped
      { dateKey: "2026-09-16", equity: 99,  snapshotTime: dayMs("2026-09-16") }, // Wed: 99/110−1
    ];
    const rets = marksToDailyReturns(marks, "trading_days");
    expect(rets.map(r => r.dateKey)).toEqual(["2026-09-11", "2026-09-16"]);
    expect(rets[0].ret).toBeCloseTo(0.02, 12);
    expect(rets[1].ret).toBeCloseTo(99 / 110 - 1, 12);
  });

  test("Fri→Mon is adjacent on the trading grid", () => {
    const marks: DailyMark[] = [
      { dateKey: "2026-09-11", equity: 100, snapshotTime: 1 },
      { dateKey: "2026-09-14", equity: 101, snapshotTime: 2 },
    ];
    expect(marksToDailyReturns(marks, "trading_days").length).toBe(1);
    expect(marksToDailyReturns(marks, "calendar_days").length).toBe(0); // 12th/13th missing
  });
});

// ── Pure math with known values ─────────────────────────────────────────

describe("pure math", () => {
  test("maxDrawdown of a known path", () => {
    expect(maxDrawdown([100, 120, 90, 110, 80])).toBeCloseTo(1 - 80 / 120, 12);
    expect(maxDrawdown([100, 110, 120])).toBe(0);
    expect(maxDrawdown([100])).toBeNull();
  });

  test("olsAlphaBeta recovers an exact linear relation", () => {
    const rb = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.005) + i * 0.0001);
    const rs = rb.map(r => 0.0002 + 2 * r); // alpha=2bp/day, beta=2 exactly
    const ols = olsAlphaBeta(rs, rb)!;
    expect(ols.beta).toBeCloseTo(2, 10);
    expect(ols.alphaDaily).toBeCloseTo(0.0002, 10);
    expect(olsAlphaBeta(rs.slice(0, 5), rb.slice(0, 5))).toBeNull(); // <10 obs
  });

  test("percentile interpolates linearly", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
    expect(percentile([10, 20], 0.05)).toBeCloseTo(10.5, 12);
  });
});

// ── Window metrics on a synthetic series ─────────────────────────────────

describe("computeWindowMetrics", () => {
  // Crypto calendar grid: 2026-09-01..2026-09-12, base 100, daily returns
  // alternating +1% / −1% (hand-computable moments; 11 obs ⇒ OLS eligible).
  const rets = Array.from({ length: 11 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  const marks: DailyMark[] = (() => {
    const out: DailyMark[] = [{ dateKey: "2026-09-01", equity: 100, snapshotTime: dayMs("2026-09-01") }];
    rets.forEach((r, i) => {
      const k = `2026-09-${String(i + 2).padStart(2, "0")}`;
      out.push({ dateKey: k, equity: out[i].equity * (1 + r), snapshotTime: dayMs(k) });
    });
    return out;
  })();
  const now = Date.parse("2026-09-15T12:00:00Z");

  test("TW return, vol, Sharpe, Sortino, maxDD match hand calculations", () => {
    const w = computeWindowMetrics(CRYPTO, "30d", marks, [], null, now);
    const expectTotal = (marks[marks.length - 1].equity / 100 - 1) * 100;
    expect(w.nObs).toBe(11);
    expect(w.totalReturnPct!).toBeCloseTo(expectTotal, 10);
    expect(w.cagrPct).toBeNull(); // span 9 days < 60
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
    expect(w.volAnnPct!).toBeCloseTo(sd * Math.sqrt(365) * 100, 8);
    expect(w.sharpe!).toBeCloseTo((mean / sd) * Math.sqrt(365), 8);
    const downside = Math.sqrt(rets.reduce((s, x) => s + Math.min(x, 0) ** 2, 0) / rets.length);
    expect(w.sortino!).toBeCloseTo((mean / downside) * Math.sqrt(365), 8);
    // Global peak is the FIRST +1% mark (each ±1% cycle loses 0.01%); the
    // trough after it is the last −1% mark (index length−2, series ends +1%).
    const peak = marks[1].equity, trough = marks[marks.length - 2].equity;
    expect(w.maxDrawdownPct!).toBeCloseTo((1 - trough / peak) * 100, 10);
    expect(w.benchmark.totalReturnPct).toBeNull(); // no hist handed in
  });

  test("benchmark on the SAME dates + OLS + IR/TE", () => {
    // Benchmark = exactly half the sleeve's return each day ⇒ beta 2, alpha 0.
    const bench = new Map<string, number>();
    for (const r of marksToDailyReturns(marks, "calendar_days")) bench.set(r.dateKey, r.ret / 2);
    bench.set("2026-08-31", 0.99); // outside dates must be ignored
    const w = computeWindowMetrics(CRYPTO, "30d", marks, [], bench, now);
    expect(w.benchmark.nPaired).toBe(11);
    const benchTotal = [...bench.entries()].filter(([k]) => k >= "2026-09-02").reduce((e, [, r]) => e * (1 + r), 1);
    expect(w.benchmark.totalReturnPct!).toBeCloseTo((benchTotal - 1) * 100, 8);
    expect(w.beta!).toBeCloseTo(2, 6);
    expect(w.alphaAnnPct!).toBeCloseTo(0, 6);
    expect(w.trackingErrorAnnPct).not.toBeNull();
    expect(w.informationRatio).not.toBeNull();
  });

  test("utilization + realized/unrealized from trades", () => {
    const trades = [
      // Open the whole window: 50 notional on ~100 equity ≈ 50% util.
      { entry_price: 10, quantity: 5, entry_time: dayMs("2026-08-30"), exit_time: null, status: "open", pnl: null },
      // Closed inside the window: realized +7.
      { entry_price: 10, quantity: 2, entry_time: dayMs("2026-09-02"), exit_time: dayMs("2026-09-03") - 60_000, status: "closed", pnl: 7 },
      // Closed BEFORE the window: must not count.
      { entry_price: 10, quantity: 2, entry_time: dayMs("2026-08-01"), exit_time: dayMs("2026-08-02"), status: "closed", pnl: 99 },
    ];
    const w = computeWindowMetrics(CRYPTO, "30d", marks, trades as any, null, now);
    expect(w.realizedPnl!).toBeCloseTo(7, 10);
    const last = marks[marks.length - 1];
    expect(w.unrealizedPnl!).toBeCloseTo(last.equity - 100 - 7, 10);
    expect(w.capitalUtilizationPct!).toBeGreaterThan(40);
    expect(w.capitalUtilizationPct!).toBeLessThan(60);
  });

  test("model window anchors at MODEL_START with the prior close as base", () => {
    // Marks around momentum_crypto's model start (calendar grid, UTC days).
    const day = (offset: number) =>
      new Date(Date.parse(MODEL_START.momentum_crypto + "T12:00:00Z") + offset * 86_400_000).toISOString().slice(0, 10);
    const m: DailyMark[] = [-2, -1, 0, 1].map((o, i) => ({
      dateKey: day(o), equity: 100 + i, snapshotTime: dayMs(day(o)),
    }));
    const w = computeWindowMetrics(CRYPTO, "model", m, [], null, Date.parse(day(2) + "T12:00:00Z"));
    expect(w.fromDate).toBe(day(-1)); // last close BEFORE the model
    expect(w.toDate).toBe(day(1));
    expect(w.nObs).toBe(2);
    // The first session under the model compounds FROM the prior close
    // (101): total = 103/101 − 1.
    expect(w.totalReturnPct!).toBeCloseTo((103 / 101 - 1) * 100, 10);
  });

  test("empty window → all-null metrics, never a throw", () => {
    const w = computeWindowMetrics(STOCKS, "30d", [], [], null, now);
    expect(w.nObs).toBe(0);
    expect(w.totalReturnPct).toBeNull();
    expect(w.trackRecordStatus).toBe("no_data");
  });
});

// ── Bootstrap band ────────────────────────────────────────────────────────

describe("blockBootstrapBand", () => {
  const oos = Array.from({ length: 300 }, (_, i) => Math.sin(i * 0.7) * 0.02);

  test("deterministic under a fixed seed; sensitive to the seed", () => {
    const a = blockBootstrapBand(oos, 20, { seed: 42 })!;
    const b = blockBootstrapBand(oos, 20, { seed: 42 })!;
    const c = blockBootstrapBand(oos, 20, { seed: 43 })!;
    expect(a.cumReturn).toEqual(b.cumReturn);
    expect(a.maxDD).toEqual(b.maxDD);
    expect(a.cumReturn.p50).not.toBe(c.cumReturn.p50);
    expect(a.nPaths).toBe(2000);
    expect(a.blockLen).toBe(10);
  });

  test("percentiles are ordered and maxDD non-negative", () => {
    const b = blockBootstrapBand(oos, 40, {})!;
    expect(b.cumReturn.p5).toBeLessThanOrEqual(b.cumReturn.p50);
    expect(b.cumReturn.p50).toBeLessThanOrEqual(b.cumReturn.p95);
    expect(b.maxDD.p5).toBeGreaterThanOrEqual(0);
    expect(b.maxDD.p5).toBeLessThanOrEqual(b.maxDD.p95);
  });

  test("refuses degenerate inputs", () => {
    expect(blockBootstrapBand([], 10, {})).toBeNull();
    expect(blockBootstrapBand(oos.slice(0, 15), 10, {})).toBeNull(); // < 2 blocks of history
    expect(blockBootstrapBand(oos, 0, {})).toBeNull();
  });

  test("classifyBand thresholds", () => {
    const band = blockBootstrapBand(Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.01 : -0.008)), 20, {})!;
    expect(classifyBand(band.cumReturn.p5 - 0.5, band)).toBe("below");
    expect(classifyBand(band.cumReturn.p95 + 0.5, band)).toBe("above");
    expect(classifyBand(band.cumReturn.p50, band)).toBe("within");
  });

  test("mulberry32 stream is reproducible", () => {
    const a = mulberry32(7), b = mulberry32(7);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
});

// ── Artifact loading + expectation band (fixtures, never data/backtests) ──

function writeArtifactFixture(returns: { date: string; ret: number }[], opts: { extraTier?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "scorecard-artifact-"));
  writeFileSync(join(dir, "manifest-resolved.json"), JSON.stringify({ costs: { base: { slippageBps: 2, commissionBps: 0 } } }));
  const half = Math.ceil(returns.length / 2);
  const runs = [
    { foldPath: "0/test", costTier: "base", candidateName: "cand", result: { config: { slippageBps: 2, commissionBps: 0 }, dailyReturns: returns.slice(0, half) } },
    { foldPath: "1/test", costTier: "base", candidateName: "cand", result: { config: { slippageBps: 2, commissionBps: 0 }, dailyReturns: returns.slice(half) } },
    // Inner fold + break-even replay: must be filtered out.
    { foldPath: "0/inner", costTier: "base", candidateName: "cand", result: { config: { slippageBps: 2, commissionBps: 0 }, dailyReturns: [{ date: "1999-01-01", ret: 9 }] } },
    ...(opts.extraTier !== false ? [{ foldPath: "0/test", costTier: "base", candidateName: "cand", result: { config: { slippageBps: 30, commissionBps: 0 }, dailyReturns: [{ date: "1999-01-02", ret: -9 }] } }] : []),
  ];
  writeFileSync(join(dir, "runs.jsonl"), runs.map(r => JSON.stringify(r)).join("\n"));
  return dir;
}

describe("loadOosDailyReturns", () => {
  test("keeps only outer test folds at the manifest's base costs", () => {
    const dir = writeArtifactFixture([
      { date: "2020-01-01", ret: 0.01 }, { date: "2020-01-02", ret: -0.02 },
      { date: "2020-01-03", ret: 0.03 }, { date: "2020-01-04", ret: 0.04 },
    ]);
    try {
      clearArtifactCache();
      const rets = loadOosDailyReturns({ dir, shiftDays: 0, manifest: "fixture" })!;
      expect(rets).toEqual([0.01, -0.02, 0.03, 0.04]); // 9 and −9 filtered out
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("missing artifact → null, never a throw", () => {
    clearArtifactCache();
    expect(loadOosDailyReturns({ dir: "/nonexistent/path/xyz", shiftDays: 0, manifest: "gone" })).toBeNull();
  });
});

describe("computeExpectationBand", () => {
  const win = (nObs: number, totalPct: number | null): ScorecardWindowMetrics => ({
    window: "model", fromDate: "2026-09-01", toDate: "2026-09-15", nObs,
    totalReturnPct: totalPct, cagrPct: null, volAnnPct: null, sharpe: null, sortino: null,
    maxDrawdownPct: 2, benchmark: { symbol: "SPY", totalReturnPct: null, nPaired: 0 },
    alphaAnnPct: null, beta: null, informationRatio: null, trackingErrorAnnPct: null,
    psr: null, trackRecordStatus: "insufficient_observations",
    capitalUtilizationPct: null, realizedPnl: null, unrealizedPnl: null,
  });

  test("h<5 → insufficient_data without touching disk", () => {
    const band = computeExpectationBand("momentum_stocks", win(3, 1.0),
      { momentum_stocks: { dir: "/nonexistent", shiftDays: 0, manifest: "x" } });
    expect(band.status).toBe("insufficient_data");
  });

  test("missing artifact (h≥5) → unavailable", () => {
    clearArtifactCache();
    const band = computeExpectationBand("momentum_stocks", win(20, 1.0),
      { momentum_stocks: { dir: "/nonexistent", shiftDays: 0, manifest: "x" } });
    expect(band.status).toBe("unavailable");
    expect(band.reason).toContain("no disponible");
  });

  test("no artifact mapping at all (momentum_crypto_usdc) → unavailable", () => {
    const band = computeExpectationBand("momentum_crypto_usdc", win(60, 10), {});
    expect(band.status).toBe("unavailable");
  });

  test("live far below/inside the band classifies below/within deterministically", () => {
    // Strictly positive OOS returns ⇒ p5 of any 20-session path > 0.
    const dir = writeArtifactFixture(
      Array.from({ length: 120 }, (_, i) => ({ date: `2020-0${(i % 9) + 1}-0${(i % 8) + 1}x${i}`, ret: 0.004 + (i % 5) * 0.001 })),
      { extraTier: false },
    );
    try {
      clearArtifactCache();
      const arts = { momentum_stocks: { dir, shiftDays: 0, manifest: "fixture" } };
      const below = computeExpectationBand("momentum_stocks", win(20, -5), arts);
      expect(below.status).toBe("below");
      expect(below.cumReturnPct!.p5).toBeGreaterThan(0);
      const above = computeExpectationBand("momentum_stocks", win(20, 50), arts);
      expect(above.status).toBe("above");
      const p50 = below.cumReturnPct!.p50;
      clearArtifactCache();
      const within = computeExpectationBand("momentum_stocks", win(20, p50), arts);
      expect(within.status).toBe("within");
      expect(within.cumReturnPct).toEqual(below.cumReturnPct); // fixed seed ⇒ identical band
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── Selection-bias haircut (S&P 500 PIT research, 2026-10-02) ────────────

describe("selection-bias haircut", () => {
  const sharpeOf = (xs: number[], perYear: number) => {
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    return { sharpe: (m / sd) * Math.sqrt(perYear), sd };
  };
  // Alternating up/down days: mean 0.2%, sd ≈ 1% — a realistic daily scale.
  const oos = Array.from({ length: 120 }, (_, i) => (i % 2 ? 0.012 : -0.008) + (i % 7) * 0.0002);

  test("the drift lowers the annualized Sharpe by exactly the haircut and leaves volatility unchanged", () => {
    const drift = selectionBiasDrift(oos, 0.185, 252);
    const before = sharpeOf(oos, 252), after = sharpeOf(oos.map(r => r - drift), 252);
    expect(before.sharpe - after.sharpe).toBeCloseTo(0.185, 10);
    expect(after.sd).toBeCloseTo(before.sd, 12);
  });

  test("no haircut, a non-positive haircut or a too-short series → zero drift", () => {
    expect(selectionBiasDrift(oos, 0, 252)).toBe(0);
    expect(selectionBiasDrift(oos, -0.2, 252)).toBe(0);
    expect(selectionBiasDrift([0.01], 0.2, 252)).toBe(0);
  });

  test("{} haircuts = the unadjusted band; a haircut lowers it, and a live return between the two p5s turns from below to within", () => {
    const dir = writeArtifactFixture(oos.map((ret, i) => ({ date: `2020-0${(i % 9) + 1}-0${(i % 8) + 1}x${i}`, ret })), { extraTier: false });
    const win = (totalPct: number): ScorecardWindowMetrics => ({
      window: "model", fromDate: "2026-09-01", toDate: "2026-11-01", nObs: 40,
      totalReturnPct: totalPct, cagrPct: null, volAnnPct: null, sharpe: null, sortino: null,
      maxDrawdownPct: 2, benchmark: { symbol: "SPY", totalReturnPct: null, nPaired: 0 },
      alphaAnnPct: null, beta: null, informationRatio: null, trackingErrorAnnPct: null,
      psr: null, trackRecordStatus: "insufficient_observations",
      capitalUtilizationPct: null, realizedPnl: null, unrealizedPnl: null,
    });
    try {
      clearArtifactCache();
      const arts = { momentum_stocks: { dir, shiftDays: 0, manifest: "fixture" } };
      const raw = computeExpectationBand("momentum_stocks", win(0), arts, {}, {});
      const legacy = blockBootstrapBand(loadOosDailyReturns(arts.momentum_stocks)!, 40, {})!;
      expect(raw.cumReturnPct!.p5).toBe(legacy.cumReturn.p5 * 100);
      expect(raw.selectionBias).toBeNull();
      const memoBefore = [...loadOosDailyReturns(arts.momentum_stocks)!];

      const haircut = { momentum_stocks: { sharpe: 1.5, evidence: "fixture" } };
      const adj = computeExpectationBand("momentum_stocks", win(0), arts, {}, haircut);
      expect(adj.selectionBias!.dailyDrift).toBeCloseTo(selectionBiasDrift(oos, 1.5, 252), 15);
      expect(adj.cumReturnPct!.p5).toBeLessThan(raw.cumReturnPct!.p5);
      expect(adj.cumReturnPct!.p50).toBeLessThan(raw.cumReturnPct!.p50);
      expect(adj.maxDDPct!.p50).toBeGreaterThanOrEqual(raw.maxDDPct!.p50);
      // The loader's memo still holds the artifact's own returns.
      expect(loadOosDailyReturns(arts.momentum_stocks)).toEqual(memoBefore);

      const between = (adj.cumReturnPct!.p5 + raw.cumReturnPct!.p5) / 2;
      expect(computeExpectationBand("momentum_stocks", win(between), arts, {}, {}).status).toBe("below");
      expect(computeExpectationBand("momentum_stocks", win(between), arts, {}, haircut).status).toBe("within");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the wired haircuts are the ledger's measured Sharpe gaps, stock sleeves only", () => {
    const ledger = JSON.parse(readFileSync(join(import.meta.dir, "../../experiments/historical-hypothesis-ledger-v1.json"), "utf8"));
    const c = ledger.authoritativeArtifactSp500Pit.sp500Pit;
    const round3 = (x: number) => Math.round(x * 1000) / 1000;
    expect(Object.keys(SELECTION_BIAS_HAIRCUT).sort()).toEqual(["meanrev_stocks", "momentum_stocks"]);
    expect(SELECTION_BIAS_HAIRCUT.momentum_stocks.sharpe).toBe(round3(c.momentumControl.sharpe - c.m1Top20dv.sharpe));
    expect(SELECTION_BIAS_HAIRCUT.meanrev_stocks.sharpe).toBe(round3(c.meanrevControl.sharpe - c.m3Meanrev.sharpe));
  });
});

describe("expectationBandReadings — what the SleeveGovernor reads", () => {
  test("one reading per sleeve band; accounts and band-less entities are skipped", () => {
    const band = (status: any, p5: number | null) => ({
      status, reason: null, artifactDir: "x", manifest: "m", modelStart: "2026-09-23", horizonSessions: 10,
      liveCumReturnPct: -8.48, liveMaxDrawdownPct: 8.48,
      cumReturnPct: p5 == null ? null : { p5, p50: 0, p95: 20 }, maxDDPct: null, bootstrap: null, selectionBias: null,
    });
    const sc: any = {
      generatedAt: 0, benchmarksAvailable: true, notes: [],
      entities: [
        { id: "momentum_crypto", kind: "sleeve", band: band("below", -7.21) },
        { id: "momentum_crypto_usdc", kind: "sleeve", band: band("insufficient_data", null) },
        { id: "binance_main", kind: "account", band: null },
        { id: "orphan", kind: "sleeve", band: null },
      ],
    };
    expect(expectationBandReadings(sc)).toEqual({
      momentum_crypto: { status: "below", liveCumReturnPct: -8.48, p5Pct: -7.21, horizonSessions: 10, modelStart: "2026-09-23", reason: null },
      momentum_crypto_usdc: { status: "insufficient_data", liveCumReturnPct: -8.48, p5Pct: null, horizonSessions: 10, modelStart: "2026-09-23", reason: null },
    });
  });
});

// ── Band episodes (once per episode) ─────────────────────────────────────

describe("bandEpisodeTransitions", () => {
  test("alerts once on entry, once on recovery; insufficient/unavailable never change state", () => {
    let state: Partial<Record<string, "below" | "ok">> = {};
    let r = bandEpisodeTransitions(state, { a: "below", b: "within" });
    expect(r.transitions).toEqual([{ sleeve: "a", kind: "entered_below" }]);
    state = r.next;
    r = bandEpisodeTransitions(state, { a: "below", b: "within" }); // still below → silent
    expect(r.transitions).toEqual([]);
    r = bandEpisodeTransitions(state, { a: "insufficient_data", b: "unavailable" }); // no evaluation ≠ recovery
    expect(r.transitions).toEqual([]);
    expect(r.next.a).toBe("below");
    r = bandEpisodeTransitions(state, { a: "within", b: "within" });
    expect(r.transitions).toEqual([{ sleeve: "a", kind: "recovered" }]);
    expect(r.next.a).toBe("ok");
  });
});

// ── Full scorecard against a READONLY connection (readers never write) ────

describe("computeScorecard readonly", () => {
  test("whole scorecard runs on a readonly DB handle and yields all six entities", () => {
    const dir = mkdtempSync(join(tmpdir(), "scorecard-db-"));
    const path = join(dir, "t.db");
    try {
      const rw = makeDb(path);
      // A few marks for two entities; trades for one.
      for (const [i, k] of ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"].entries()) {
        snap(rw, "momentum_stocks", 100 + i, dayMs(k));
        snap(rw, "alpaca_main", 200 + i, dayMs(k));
      }
      rw.prepare(`INSERT INTO trades (id, account_id, entry_price, quantity, entry_time, exit_time, status, pnl) VALUES ('t1','momentum_stocks',10,5,?,NULL,'open',NULL)`)
        .run(dayMs("2026-09-07"));
      rw.close();

      const ro = new Database(path, { readonly: true });
      const sc = computeScorecard({ db: ro, hist: null, now: Date.parse("2026-09-15T12:00:00Z"), artifacts: {} });
      ro.close();

      expect(sc.entities.length).toBe(6);
      const ms = sc.entities.find(e => e.id === "momentum_stocks")!;
      expect(ms.windows.map(w => w.window)).toEqual(["model", "30d", "90d", "v8"]);
      const w30 = ms.windows.find(w => w.window === "30d")!;
      expect(w30.nObs).toBe(4);
      expect(w30.totalReturnPct!).toBeCloseTo(4, 8);
      expect(w30.capitalUtilizationPct).not.toBeNull();
      expect(ms.band).not.toBeNull();
      expect(ms.band!.status).toBe("unavailable"); // artifacts: {} — no mapping, no disk
      const acct = sc.entities.find(e => e.id === "alpaca_main")!;
      expect(acct.windows.map(w => w.window)).toEqual(["30d", "90d", "v8"]); // no model window
      expect(acct.band).toBeNull();
      expect(sc.benchmarksAvailable).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── Telegram digest lines ─────────────────────────────────────────────────

describe("formatScorecardDigestLines", () => {
  test("one line per sleeve in the spec's format", () => {
    const sc = computeScorecard({ db: makeDb(), hist: null, now: NOW, artifacts: {} });
    const lines = formatScorecardDigestLines(sc);
    expect(lines.length).toBe(4); // 4 sleeves, no account lines
    for (const l of lines) expect(l).toContain("banda:");
  });

  test("formats return vs benchmark with the excess in parentheses", () => {
    const db = makeDb();
    // momentum_crypto marks straddling MODEL_START (2026-09-27: first full
    // UTC day after the vt-35 re-anchor of 09-26 19:00), +2% then −1%.
    snap(db, "momentum_crypto", 100, dayMs("2026-09-26"));
    snap(db, "momentum_crypto", 102, dayMs("2026-09-27"));
    snap(db, "momentum_crypto", 100.5, dayMs("2026-09-28"));
    const sc = computeScorecard({ db, hist: null, now: Date.parse("2026-09-29T12:00:00Z"), artifacts: {} });
    const line = formatScorecardDigestLines(sc).find(l => l.startsWith("MOM-CRY"))!;
    expect(line).toContain("MOM-CRY +0,5%"); // 100.5 / 100 (cierre 09-26) − 1
    expect(line).toContain("banda:");
    expect(MODEL_START.momentum_crypto).toBe("2026-09-27");
  });
});

// ── readTrades guard ──────────────────────────────────────────────────────

describe("readTrades", () => {
  test("empty account list → no query, empty result", () => {
    expect(readTrades(makeDb(), [])).toEqual([]);
  });
});
