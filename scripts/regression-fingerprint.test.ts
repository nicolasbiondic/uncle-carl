/**
 * Fingerprint regression tests over the REAL replay engines (Jesse
 * `tests/test_real_strategy_regression.py` pattern).
 *
 * Deterministic synthetic candles (fixed seed, geometric random walk +
 * drift — scripts/lib/syntheticCandles.ts; NO dependency on the gitignored
 * data/historical.db) are fed through the two real simulators:
 *
 *   - momentum: runWithConfig → the REAL MomentumEngine (TSM ranking,
 *     RiskGuard, vol trail, SimBroker margin/fills)
 *   - meanrev:  runMeanRevReplay → the REAL MeanRevEngine (runDaily over a
 *     sim adapter, RiskGuard included) with production parameters
 *     (RSI2<5, SMA200)
 *
 * and the results are pinned to (a) key metrics rounded to 6 decimals and
 * (b) a sha256 over every closed trade (symbol|side|pnl|exitAt|reason).
 *
 * WHY: on 2026-08-02 an infrastructure leak (the host's TRADING_ENABLED=
 * false reaching the replay loop) produced a complete-looking artifact with
 * 42/42 ZERO-TRADE trials — caught by luck (AUDITS 2026-08-03). The
 * MIN_TRADES anti-vacuity guard below fails loudly on exactly that class,
 * and the momentum case re-creates the incident on purpose (sets
 * TRADING_ENABLED=false around the replay) to pin runWithConfig's
 * neutralization forever.
 *
 * ── ANCHORING ────────────────────────────────────────────────────────
 * EXPECTED_* below — DO NOT EDIT once captured — anchored 2026-08-03 on
 * the working tree at commit ddfb957 (plus that day's concurrent
 * protection-batch edits, none touching the replay engines), Bun 1.3.14 /
 * linux x64. A mismatch means an intended semantic change
 * (re-anchor deliberately, in its own commit, explaining WHY) or an
 * accidental regression (fix the code, never the anchor). To re-capture:
 *   PRINT_FINGERPRINTS=1 bun test scripts/regression-fingerprint.test.ts
 * Caveat (same one Jesse accepts by pinning Python/numpy): Math.exp/log/
 * cos are not bit-specified across JS ENGINE builds, so a Bun/JSC upgrade
 * may legitimately shift these values — that is a re-anchor event, and the
 * runtime is part of the anchor above.
 *
 * ── SLOW-TEST ESCAPE ─────────────────────────────────────────────────
 * bun test has no @pytest.mark.slow equivalent; the idiomatic escape here
 * is env-gated skipIf. For fast iteration:
 *   SKIP_SLOW_TESTS=1 bun test scripts/
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWithConfig, type ClosedTrade, type ReplayConfig, type ReplayResult } from "./backtest-momentum-wf";
import { runMeanRevReplay } from "./meanrev-replay";
import { writeSyntheticDb, type SyntheticTapeSpec } from "./lib/syntheticCandles";

const SKIP_SLOW = process.env.SKIP_SLOW_TESTS === "1";
const PRINT = process.env.PRINT_FINGERPRINTS === "1";

// ── fingerprint helpers ───────────────────────────────────────────────

const round6 = (x: number) => Number(x.toFixed(6));

export function tradesSha256(trades: ClosedTrade[]): string {
  const h = createHash("sha256");
  for (const t of trades) h.update(`${t.symbol}|${t.side}|${t.pnl.toFixed(6)}|${t.exitAt}|${t.reason}\n`);
  return h.digest("hex");
}

interface Fingerprint {
  trades: number;
  totalReturn: number;
  sharpe: number;
  maxDrawdown: number;
  winRate: number;
  expectancy: number;
  fees: number;
  finalEquity: number;
  tradesSha256: string;
}

function fingerprint(r: ReplayResult): Fingerprint {
  return {
    trades: r.trades,
    totalReturn: round6(r.totalReturn),
    sharpe: round6(r.sharpe),
    maxDrawdown: round6(r.maxDrawdown),
    winRate: round6(r.winRate),
    expectancy: round6(r.expectancy),
    fees: round6(r.fees),
    finalEquity: round6(r.finalEquity),
    tradesSha256: tradesSha256(r.closedTrades),
  };
}

// ── synthetic fixtures ────────────────────────────────────────────────

const MOMO_TAPE: SyntheticTapeSpec = {
  timeframe: "1h",
  source: "synthetic",
  fromMs: Date.parse("2024-01-01T00:00:00Z"),
  bars: 24 * 200, // 200 continuous days of hourly bars
};

const MOMO_SPECS = [
  { symbol: "SYNA", seed: 11, startPrice: 40_000, driftAnnual: 1.8, volAnnual: 0.7 },
  { symbol: "SYNB", seed: 22, startPrice: 2_500, driftAnnual: -0.8, volAnnual: 0.9 },
  { symbol: "SYNC", seed: 33, startPrice: 90, driftAnnual: 2.5, volAnnual: 1.1 },
  { symbol: "SYND", seed: 44, startPrice: 0.55, driftAnnual: 0.2, volAnnual: 0.8 },
  { symbol: "SYNE", seed: 55, startPrice: 130, driftAnnual: -1.5, volAnnual: 1.0 },
  { symbol: "SYNF", seed: 66, startPrice: 12, driftAnnual: 1.0, volAnnual: 0.6 },
];

const MEANREV_TAPE: SyntheticTapeSpec = {
  timeframe: "1d",
  source: "synthetic",
  fromMs: Date.parse("2022-01-01T05:00:00Z"),
  bars: 900, // 2022-01-01 → 2024-06-18, daily
};

const MEANREV_SPECS = [
  { symbol: "MRA", seed: 1001, startPrice: 150, driftAnnual: 0.18, volAnnual: 0.30 },
  { symbol: "MRB", seed: 1002, startPrice: 60, driftAnnual: 0.12, volAnnual: 0.35 },
  { symbol: "MRC", seed: 1003, startPrice: 220, driftAnnual: 0.22, volAnnual: 0.28 },
  { symbol: "MRD", seed: 1004, startPrice: 35, driftAnnual: 0.15, volAnnual: 0.40 },
  { symbol: "MRE", seed: 1005, startPrice: 480, driftAnnual: 0.10, volAnnual: 0.25 },
  { symbol: "MRF", seed: 1006, startPrice: 95, driftAnnual: 0.20, volAnnual: 0.32 },
  { symbol: "MRREF", seed: 1007, startPrice: 400, driftAnnual: 0.10, volAnnual: 0.18 },
];

function momoConfig(dbPath: string): ReplayConfig {
  return {
    sleeve: "crypto", // continuous 24/7 tape; funding disabled (no funding_rates fixture)
    universe: MOMO_SPECS.map(s => s.symbol),
    timeframe: "1h",
    source: "synthetic",
    refSymbol: "SYNA",
    rthOnly: false,
    funding: false,
    barMinutes: 60,
    barMinutesEq: 60,
    slippageBps: 5,
    commissionBps: 4,
    initialEquity: 10_000,
    leverage: 3,
    hardStopPct: 0.04,
    cadenceMin: 240,
    notionalPctPerSlot: 0.375,
    entryPct: 5,
    exitPct: -2,
    maxLongs: 4,
    maxShorts: 0,
    shortFunding: "credit",
    tsmTrail: { kSigma: 3, lookbackBars: 24, minPct: 2, maxPct: 8 },
    warmupDays: 45,
    dbPath,
  };
}

function meanrevConfig(dbPath: string): ReplayConfig {
  return {
    sleeve: "meanrev",
    universe: MEANREV_SPECS.map(s => s.symbol).filter(s => s !== "MRREF"),
    timeframe: "1d",
    source: "synthetic",
    refSymbol: "MRREF",
    rthOnly: false,
    funding: false,
    barMinutes: 1440,
    barMinutesEq: 1440,
    slippageBps: 2,
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
    // PRODUCTION parameters (DEFAULT_MEANREV_CONFIG): RSI2<5, SMA200/5,
    // 10d time stop, 5 slots × 10%.
    meanrev: { entryRsi: 5, smaLong: 200, smaExit: 5, timeStopDays: 10, maxPositions: 5, slotPct: 0.1 },
    warmupDays: 365,
    dbPath,
  };
}

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "regression-fp-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ── anchored expectations — DO NOT EDIT once captured (see header) ────

const MOMO_MIN_TRADES = 20;    // anti-vacuity floor, NOT the exact count
const MEANREV_MIN_TRADES = 30; // (exact counts live inside the fingerprints)

// RE-ANCHORED 2026-10-03 (deliberate): SimBroker.closePosition stamps engine
// closes at now + 1 ms instead of exactly `now`. At `now`, the next tick's
// getRealisedPnlSince(anchor = now) excluded them, so RiskGuard's loss
// streak only ever counted hard-stop losses and never reset — a pause after
// every 5 stops. Live counts every close (momentum_crypto parity divergence,
// 2026-10-02 19:00). Verified by diffing old-vs-new closedTrades on this
// exact tape before re-anchoring: the first 10 trades are identical apart
// from the +1 ms on engine exits; the paths part at the old replay's first
// loss-streak pause (2024-02-19 16:00). Blocked ticks: loss streak 54 → 42,
// soft drawdown 240 → 162, daily cap 36 → 38. Trades 99 → 99, finalEquity
// 12362.35728 → 16108.571559. Previous anchor (2026-08-03): totalReturn
// 0.236236, sharpe 1.378718, sha 155e567a….
const EXPECTED_MOMO: Fingerprint | null = {
  trades: 99,
  totalReturn: 0.610857,
  sharpe: 2.712022,
  maxDrawdown: 0.167349,
  winRate: 0.282828,
  expectancy: 61.702743,
  fees: 380.028926,
  finalEquity: 16108.571559,
  tradesSha256: "2006f024d3d5401793cc484c7d2df7a8a5ff8b5ce398d32a1ad269cba9d8f1fe",
};

// RE-ANCHORED 2026-08-03 (same day, deliberate — AUDITS "backtest-live
// parity" pass): runMeanRevReplay now executes the REAL MeanRevEngine over
// a sim adapter instead of a reimplemented Connors loop (the NautilusTrader
// single-kernel pattern runWithConfig already follows). The intended
// semantic change this anchors: the engine's RiskGuard portfolio breaker —
// live on meanrev_stocks since 2026-08-03, absent from the old duplicated
// loop — now runs in the replay. On this tape it fires exactly once
// ("5 consecutive losing rebalances — paused 24h" on 2023-09-23), blocking
// one MRB entry whose old-replay round trip earned +$104.16: 221→220
// trades, finalEquity 50444.785312→50340.629361 (Δ = that one trade). All
// other 219 trades are bit-identical to the previous anchor — verified by
// diffing old-vs-new closedTrades on this exact tape before re-anchoring.
const EXPECTED_MEANREV: Fingerprint | null = {
  trades: 220,
  totalReturn: 0.006813,
  sharpe: 0.064979,
  maxDrawdown: 0.065957,
  winRate: 0.640909,
  expectancy: 1.548315,
  fees: 0,
  finalEquity: 50340.629361,
  tradesSha256: "eb8e2548da1d95cbb25d8154b622a63739b7f062baaa6fd242155df394759681",
};

function assertFingerprint(name: string, actual: Fingerprint, expected: Fingerprint | null) {
  if (PRINT || !expected) {
    console.log(`\n[fingerprint:${name}] ${JSON.stringify(actual, null, 2)}`);
  }
  if (!expected) throw new Error(`${name}: no anchored fingerprint yet — capture it from the output above`);
  expect(actual).toEqual(expected);
}

// ── tests ─────────────────────────────────────────────────────────────

describe.skipIf(SKIP_SLOW)("regression fingerprints (SKIP_SLOW_TESTS=1 to skip)", () => {
  test("momentum: real MomentumEngine replay on the seeded tape reproduces its anchored fingerprint — even with the host kill-switch set", () => withTmp(async dir => {
    const dbPath = join(dir, "historical.db");
    writeSyntheticDb(dbPath, MOMO_TAPE, MOMO_SPECS);

    // Re-create the 2026-08-02 incident condition on purpose: the host
    // maintenance kill-switch must NOT leak into the replay loop
    // (runWithConfig neutralizes and restores it).
    const prev = process.env.TRADING_ENABLED;
    process.env.TRADING_ENABLED = "false";
    let r: ReplayResult | null;
    try {
      r = await runWithConfig(momoConfig(dbPath), { label: "fp", from: "2024-02-15", to: "2024-07-01" });
    } finally {
      if (prev === undefined) delete process.env.TRADING_ENABLED;
      else process.env.TRADING_ENABLED = prev;
    }
    expect(process.env.TRADING_ENABLED).toBeUndefined(); // restored to the test-setup state

    expect(r).not.toBeNull();
    // Anti-vacuity FIRST: a zero/near-zero-trade run must fail HERE, loudly,
    // not produce a plausible-looking all-zero fingerprint.
    expect(r!.trades).toBeGreaterThanOrEqual(MOMO_MIN_TRADES);
    expect(r!.ruined).toBe(false);
    assertFingerprint("momentum", fingerprint(r!), EXPECTED_MOMO);
  }), 120_000);

  test("meanrev: real Connors math (production RSI2<5/SMA200 params) reproduces its anchored fingerprint", () => withTmp(async dir => {
    const dbPath = join(dir, "historical.db");
    writeSyntheticDb(dbPath, MEANREV_TAPE, MEANREV_SPECS);

    const r = await runMeanRevReplay(meanrevConfig(dbPath), { label: "fp", from: "2023-01-01", to: "2024-06-01" });
    expect(r).not.toBeNull();
    expect(r!.trades).toBeGreaterThanOrEqual(MEANREV_MIN_TRADES); // anti-vacuity first
    expect(r!.ruined).toBe(false);
    assertFingerprint("meanrev", fingerprint(r!), EXPECTED_MEANREV);
  }), 120_000);
});
