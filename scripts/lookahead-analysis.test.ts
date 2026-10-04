import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeLookahead,
  boostConfig,
  chooseCuts,
  comparePrefix,
  sameRun,
  warmupVariance,
  CUT_EPSILON_MS,
} from "./lookahead-analysis";
import type { ExperimentManifest, ReplayRunner } from "./walk-forward";
import type { ClosedTrade, ReplayConfig, ReplayResult } from "./backtest-momentum-wf";
import { INITIAL_RISK_STATE } from "../src/strategies/momentum/RiskGuard";
import { writeSyntheticDb, type SyntheticTapeSpec } from "./lib/syntheticCandles";

// ── stubs ─────────────────────────────────────────────────────────────

function makeResult(over: Partial<ReplayResult> = {}): ReplayResult {
  return {
    sleeve: "meanrev",
    window: { label: "t", from: "2024-01-01", to: "2024-06-01" },
    fromMs: Date.parse("2024-01-01"),
    toMs: Date.parse("2024-06-01"),
    config: { rthOnly: false } as ReplayResult["config"],
    finalEquity: 50_000,
    totalReturn: 0,
    maxDrawdown: 0,
    sharpe: 0,
    winRate: 0,
    trades: 0,
    tradesPerDay: 0,
    expectancy: 0,
    fees: 0,
    funding: 0,
    liquidations: 0,
    marginRejects: 0,
    ruined: false,
    bench: 0,
    dailyReturns: [],
    sessionReturns: [],
    tradesBySymbol: {},
    equityHistory: [],
    closedTrades: [],
    hash: "stub",
    finalRiskState: { ...INITIAL_RISK_STATE },
    ...over,
  };
}

const T0 = Date.parse("2024-02-01T00:00:00Z");
const day = 86_400_000;
const trade = (exitAt: number, pnl: number, reason = "SMA_EXIT", symbol = "AAA"): ClosedTrade =>
  ({ symbol, side: "buy", pnl, exitAt, reason });

// ── comparePrefix ─────────────────────────────────────────────────────

describe("comparePrefix", () => {
  const baseline = makeResult({
    closedTrades: [trade(T0 + 1 * day, 10), trade(T0 + 5 * day, -3, "STOP_LOSS"), trade(T0 + 20 * day, 7, "fold_end")],
    equityHistory: [{ t: T0, eq: 50_000 }, { t: T0 + 1 * day, eq: 50_010 }, { t: T0 + 5 * day, eq: 50_007 }],
  });

  test("identical prefix passes; fold_end and beyond-cut events are excluded", () => {
    const truncated = makeResult({
      closedTrades: [trade(T0 + 1 * day, 10), trade(T0 + 5 * day, -3, "STOP_LOSS"), trade(T0 + 6 * day, 0, "fold_end")],
      equityHistory: [{ t: T0, eq: 50_000 }, { t: T0 + 1 * day, eq: 50_010 }, { t: T0 + 5 * day, eq: 50_007 }, { t: T0 + 6 * day, eq: 50_007 }],
    });
    const cut = T0 + 6 * day;
    const c = comparePrefix(baseline, truncated, cut);
    expect(c.pass).toBe(true);
    expect(c.comparedTrades).toBe(2);
    expect(c.comparedEquityPoints).toBe(3);
  });

  test("a divergent pnl fails and is never edge-classified", () => {
    const truncated = makeResult({
      closedTrades: [trade(T0 + 1 * day, 10), trade(T0 + 5 * day, -3.5, "STOP_LOSS")],
      equityHistory: baseline.equityHistory,
    });
    const c = comparePrefix(baseline, truncated, T0 + 6 * day, 1e-9, 10 * day);
    expect(c.pass).toBe(false);
    expect(c.edgeOnly).toBe(false);
    expect(c.tradeMismatches.some(mm => mm.field === "pnl")).toBe(true);
  });

  test("an extra truncated trade (changed signal) fails", () => {
    const truncated = makeResult({
      closedTrades: [trade(T0 + 1 * day, 10), trade(T0 + 2 * day, 4, "SMA_EXIT", "BBB"), trade(T0 + 5 * day, -3, "STOP_LOSS")],
      equityHistory: baseline.equityHistory,
    });
    const c = comparePrefix(baseline, truncated, T0 + 6 * day);
    expect(c.pass).toBe(false);
  });

  test("missing-tail events inside the edge window are edgeOnly with tolerance, plain FAIL without", () => {
    const truncated = makeResult({
      closedTrades: [trade(T0 + 1 * day, 10)], // missing the STOP_LOSS at T0+5d
      equityHistory: [{ t: T0, eq: 50_000 }, { t: T0 + 1 * day, eq: 50_010 }], // missing the mark at T0+5d
    });
    const cut = T0 + 6 * day;
    const strict = comparePrefix(baseline, truncated, cut);
    expect(strict.pass).toBe(false);
    expect(strict.edgeOnly).toBe(false);
    const tolerant = comparePrefix(baseline, truncated, cut, 1e-9, 2 * day); // T0+5d ≥ cut − 2d
    expect(tolerant.pass).toBe(false);
    expect(tolerant.edgeOnly).toBe(true);
    const tooFar = comparePrefix(baseline, truncated, cut, 1e-9, 0.5 * day); // T0+5d < cut − 0.5d
    expect(tooFar.edgeOnly).toBe(false);
  });
});

// ── chooseCuts / boostConfig / sameRun ────────────────────────────────

describe("chooseCuts", () => {
  test("anchors 1min after sampled exits, skipping early-window, edge and liquidation exits", () => {
    const exits = [5, 30, 50, 70, 90].map(d => T0 + d * day);
    const baseline = makeResult({
      closedTrades: [
        trade(exits[0], 1),                 // < 20% span → skipped
        trade(exits[1], 1),
        trade(exits[2], 1, "liquidation"),  // skipped
        trade(exits[3], 1),
        trade(exits[4], 1, "fold_end"),     // skipped
      ],
    });
    const cuts = chooseCuts(baseline, { maxCuts: 8, fromMs: T0, toMs: T0 + 100 * day });
    expect(cuts).toEqual([exits[1] + CUT_EPSILON_MS, exits[3] + CUT_EPSILON_MS]);
  });

  test("samples evenly when there are more exits than maxCuts and always includes the latest", () => {
    const baseline = makeResult({
      closedTrades: Array.from({ length: 40 }, (_, i) => trade(T0 + (30 + i) * day, 1)),
    });
    const cuts = chooseCuts(baseline, { maxCuts: 4, fromMs: T0, toMs: T0 + 100 * day });
    expect(cuts.length).toBe(4);
    expect(cuts[0]).toBe(T0 + 30 * day + CUT_EPSILON_MS);
    expect(cuts[3]).toBe(T0 + 69 * day + CUT_EPSILON_MS);
  });

  test("returns [] when nothing fired", () => {
    expect(chooseCuts(makeResult(), { maxCuts: 4, fromMs: T0, toMs: T0 + 10 * day })).toEqual([]);
  });
});

describe("boostConfig", () => {
  const base: ReplayConfig = {
    sleeve: "meanrev", universe: ["A", "B", "C"], timeframe: "1d", source: "s", refSymbol: "R",
    rthOnly: false, funding: false, barMinutes: 1440, barMinutesEq: 1440, slippageBps: 2,
    commissionBps: 0, initialEquity: 50_000, leverage: 1, hardStopPct: 0.04, cadenceMin: 1440,
    notionalPctPerSlot: 0.25, entryPct: 0, exitPct: 0, maxLongs: 0, maxShorts: 0,
    shortFunding: "credit", meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 },
    warmupDays: 365, dbPath: "x",
  };

  test("meanrev: ×100 equity, maxPositions lifted to the universe, strategy params otherwise untouched", () => {
    const b = boostConfig(base);
    expect(b.initialEquity).toBe(5_000_000);
    expect(b.meanrev!.maxPositions).toBe(3);
    expect(b.meanrev!.entryRsi).toBe(5);
    expect(b.leverage).toBe(1); // no margin sim in the meanrev runner
  });

  test("momentum: ×100 equity and leverage ≥100 (no margin rejects), slot caps untouched", () => {
    const momo: ReplayConfig = { ...base, sleeve: "crypto", meanrev: undefined, maxLongs: 4, leverage: 3 };
    const b = boostConfig(momo);
    expect(b.initialEquity).toBe(5_000_000);
    expect(b.leverage).toBe(100);
    expect(b.maxLongs).toBe(4);
  });
});

describe("sameRun", () => {
  test("bit-identical runs match; any drift in trades or equity does not", () => {
    const a = makeResult({ closedTrades: [trade(T0, 1)], equityHistory: [{ t: T0, eq: 1 }] });
    const b = makeResult({ closedTrades: [trade(T0, 1)], equityHistory: [{ t: T0, eq: 1 }] });
    expect(sameRun(a, b)).toBe(true);
    expect(sameRun(a, makeResult({ closedTrades: [trade(T0, 1.0000001)], equityHistory: [{ t: T0, eq: 1 }] }))).toBe(false);
    expect(sameRun(a, makeResult({ closedTrades: [trade(T0, 1)], equityHistory: [{ t: T0, eq: 2 }] }))).toBe(false);
  });
});

// ── warmupVariance (recursive-analysis core) ──────────────────────────

describe("warmupVariance", () => {
  const closes = new Map([["A", Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 7) * 5 + i * 0.05)]]);

  test("a windowed indicator converges to exactly 0 once warmup ≥ window", () => {
    const sma20 = (cs: number[]) => cs.slice(-20).reduce((s, x) => s + x, 0) / 20;
    const rows = warmupVariance(closes, [10, 20, 50], "sma20", sma20);
    expect(rows[1].meanAbsDevPct).toBe(0);
    expect(rows[2].meanAbsDevPct).toBe(0);
  });

  test("a recursive indicator (EMA) shows warm-up-dependent deviation that shrinks with more history", () => {
    const ema = (cs: number[]) => {
      const k = 2 / (50 + 1);
      let e = cs[0];
      for (const c of cs) e = c * k + e * (1 - k);
      return e;
    };
    const rows = warmupVariance(closes, [10, 50, 300], "ema50", ema);
    expect(rows[0].meanAbsDevPct).toBeGreaterThan(0);
    expect(rows[2].meanAbsDevPct).toBeLessThan(rows[0].meanAbsDevPct);
  });
});

// ── integration: the REAL meanrev runner on synthetic data ────────────

const TAPE: SyntheticTapeSpec = {
  timeframe: "1d",
  source: "synthetic",
  fromMs: Date.parse("2023-06-01T05:00:00Z"),
  bars: 560,
};

function makeManifest(dbPath: string): ExperimentManifest {
  return {
    name: "lookahead-integration",
    sleeve: "meanrev",
    trialAccounting: { priorUniqueTrials: 0, complete: false },
    data: {
      dbPath,
      source: "synthetic",
      timeframe: "1d",
      universe: ["MRA", "MRB", "MRC", "MRD"],
      refSymbol: "MRREF",
      rthOnly: false,
      funding: false,
      barMinutes: 1440,
      barMinutesEq: 1440,
    },
    asOf: "2024-12-01",
    window: { from: "2023-11-01", to: "2024-11-01", outerFoldCount: 1, innerFoldCount: 1, purgeYears: 0, warmupDays: 150 },
    costs: { base: { slippageBps: 2, commissionBps: 0 }, stress: { slippageBps: 5, commissionBps: 2 } },
    ledger: { initialEquity: 50_000, leverage: 1, hardStopPct: 0.04 },
    candidates: [{
      name: "incumbent",
      cadenceMin: 1440,
      meanrev: { entryRsi: 15, smaLong: 20, smaExit: 5, timeStopDays: 5, maxPositions: 2, slotPct: 0.1 },
    }],
    acceptance: {},
  };
}

function withSyntheticWorld<T>(fn: (m: ExperimentManifest) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lookahead-int-"));
  const dbPath = join(dir, "historical.db");
  writeSyntheticDb(dbPath, TAPE, [
    { symbol: "MRA", seed: 101, startPrice: 80, driftAnnual: 0.15, volAnnual: 0.35 },
    { symbol: "MRB", seed: 202, startPrice: 120, driftAnnual: 0.10, volAnnual: 0.30 },
    { symbol: "MRC", seed: 303, startPrice: 45, driftAnnual: 0.20, volAnnual: 0.40 },
    { symbol: "MRD", seed: 404, startPrice: 200, driftAnnual: 0.05, volAnnual: 0.25 },
    { symbol: "MRREF", seed: 505, startPrice: 400, driftAnnual: 0.08, volAnnual: 0.15 },
  ]);
  return fn(makeManifest(dbPath)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("analyzeLookahead — integration", () => {
  test("the real meanrev runner has no truncation divergence: PASS with real trades and cuts", () => withSyntheticWorld(async m => {
    const report = await analyzeLookahead(m, {
      from: "2023-11-01",
      to: "2024-11-01",
      maxCuts: 3,
      log: () => {},
    });
    expect(report.deterministic).toBe(true);
    expect(report.baselineTrades).toBeGreaterThan(5); // anti-vacuous: the verdict must rest on real signals
    expect(report.cuts.length).toBeGreaterThanOrEqual(2);
    for (const c of report.cuts) {
      expect(c.comparison.comparedTrades).toBeGreaterThan(0);
      expect(c.comparison.comparedEquityPoints).toBeGreaterThan(0);
    }
    expect(report.verdict).toBe("PASS");
  }), 30_000);

  test("a deliberately look-ahead-biased runner is caught: FAIL with divergence details", () => withSyntheticWorld(async m => {
    // Bias: the decision executed at day i's open consults close[i+2] — one
    // bar PAST the execution bar's successor, i.e. real future leakage of
    // the kind truncation can expose. When the peek is unavailable
    // (truncated data), the signal silently flips to "no trade" — exactly
    // how .mean()-without-rolling / shift(-n) bugs behave near the data edge.
    const biasedRunner: ReplayRunner = async (cfg, win) => {
      const db = new Database(cfg.dbPath, { readonly: true });
      try {
        const rows = db.prepare(
          `SELECT timestamp, open, close FROM historical_bars
           WHERE symbol = 'MRA' AND timeframe = ? AND source = ? AND timestamp < ?
           ORDER BY timestamp ASC`,
        ).all(cfg.timeframe, cfg.source, Date.parse(win.to)) as Array<{ timestamp: number; open: number; close: number }>;
        const fromMs = Date.parse(win.from);
        const closedTrades: ClosedTrade[] = [];
        const equityHistory: Array<{ t: number; eq: number }> = [];
        let equity = cfg.initialEquity;
        for (let i = 0; i + 1 < rows.length; i++) {
          if (rows[i].timestamp < fromMs) continue;
          const peek = rows[i + 2]; // ← the bias
          if (peek && peek.close > rows[i].close * 1.001) {
            const pnl = (rows[i + 1].open - rows[i].open) * 10;
            equity += pnl;
            closedTrades.push({ symbol: "MRA", side: "buy", pnl, exitAt: rows[i + 1].timestamp, reason: "BIASED_FLIP" });
          }
          equityHistory.push({ t: rows[i].timestamp, eq: equity });
        }
        return makeResult({
          window: { label: win.label, from: win.from, to: win.to },
          fromMs,
          toMs: Date.parse(win.to),
          config: cfg,
          finalEquity: equity,
          trades: closedTrades.length,
          closedTrades,
          equityHistory,
        });
      } finally {
        db.close();
      }
    };

    const report = await analyzeLookahead(m, {
      from: "2023-11-01",
      to: "2024-11-01",
      maxCuts: 3,
      runner: biasedRunner,
      log: () => {},
    });
    expect(report.deterministic).toBe(true); // bias ≠ nondeterminism: both baselines agree
    expect(report.baselineTrades).toBeGreaterThan(10);
    expect(report.verdict).toBe("FAIL");
    const failing = report.cuts.filter(c => !c.comparison.pass && !c.comparison.edgeOnly);
    expect(failing.length).toBeGreaterThan(0);
    const mm = failing.flatMap(c => [...c.comparison.tradeMismatches, ...c.comparison.equityMismatches]);
    expect(mm.length).toBeGreaterThan(0);
  }), 30_000);
});
